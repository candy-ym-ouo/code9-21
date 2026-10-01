/**
 * 历史窗口重放（文档 12.7：每条判定都必须可复算）。
 *
 * repro_window 落库时冻结了：日期、窗口起止、锚点、中点太阳仰角/方位角、
 * verdict、reasons 以及当时的天气汇总 forecast_snapshot（EpisodeWeather）。
 * 重放分两部分：
 *
 *  1. 天文重算：用同一 timing + 同一日期重新解析锚点/采样，应得到同一窗口；
 *  2. 天气重算：预报逐小时数据早已过期，但**当时的汇总（snapshot）仍在库中**，
 *     用它再过一遍同一套天气画像口径，应得到同一 verdict/reasons。
 *
 * 纯函数编排，不落库、不改任何数据；重放结果与存储不一致时给出 diff，
 * 用来验证"口径迁移没有改变既有判定"。
 */

import {
  applyWeatherProfile,
  isNightByElevation,
  resolveAnchor,
  sunEvents,
  bandToRange,
  sampleWindow,
  solarPosition,
  elevationInRange,
  angularDistance,
  type TimingDto,
  type WeatherEpisode,
  type WindowReasonDto,
  type WindowVerdict,
} from '@flil/shared';
import { getDb, parseJson } from '../db.js';
import type { SpotGeom } from './windowRows.js';

export interface WindowRowSnapshot {
  id: string;
  inspiration_id: string;
  date: string;
  start_at: string;
  end_at: string;
  anchor_at: string;
  sun_elevation: number | null;
  sun_azimuth: number | null;
  verdict: WindowVerdict;
  reasons: string;
  forecast_snapshot: string | null;
  weather_degraded: number;
  stale: number;
  computed_at: string;
}

export interface ReplayDiff {
  field: string;
  stored: unknown;
  replayed: unknown;
}

export interface ReplayResult {
  windowId: string;
  date: string;
  /** 用当前口径重算出的判定 */
  verdict: WindowVerdict;
  /** 落库时冻结的判定 */
  storedVerdict: WindowVerdict;
  reasons: WindowReasonDto[];
  episode: WeatherEpisode;
  /** 与落库时完全一致（verdict + 每条天气 reason 的 code/level/text） */
  matches: boolean;
  /** 不一致明细；空数组表示可字节复现 */
  diffs: ReplayDiff[];
}

const EPS_MS = 60_000; // 窗口边界 1 分钟以内视为一致（采样步长口径）

/**
 * 基于存储快照重放单日天气项。
 * snapshot 为 null（老数据/无天气）时按降级口径重放：最高 marginal 且带 WEATHER_DEGRADED。
 * midSunElevationDeg 取存储窗口的中点太阳仰角（夜间现象 neon_reflection 判定需要）。
 */
export function replayWeatherFromSnapshot(
  timing: TimingDto,
  midSunElevationDeg: number | null,
  snapshot: WeatherEpisode | null,
): Pick<ReplayResult, 'verdict' | 'reasons' | 'episode'> {
  const reasons: WindowReasonDto[] = [];
  // 历史窗口的天文部分已经成立，重放只验证天气段，初始 verdict 固定为 good，
  // 与 decideDayWindow 中"进入天气项前"的起点一致（窗口过短的 warn 留在存储 reasons 里单独比对）。
  const episode: WeatherEpisode =
    snapshot && snapshot.degraded === false
      ? { ...snapshot, provider: snapshot.provider ?? null }
      : {
          degraded: true,
          provider: snapshot?.provider ?? null,
          avgCloudCoverPct: null,
          maxPrecipProbPct: null,
          precipMmWindow: null,
          precipMmPrev6h: null,
          minVisibilityKm: null,
          maxWindSpeedMs: null,
          avgTempC: null,
          humidityPct: null,
          snowfallCm: null,
        };
  const state = applyWeatherProfile(
    timing.weatherProfile,
    episode,
    isNightByElevation(midSunElevationDeg ?? -90),
    { verdict: 'good', reasons },
  );
  return { verdict: state.verdict, reasons, episode };
}

/** 天文重算：返回当日解析出的锚点/窗口与中点太阳位置（与存储值比对用） */
export function replayAstronomy(spot: SpotGeom, timing: TimingDto, dateKey: string) {
  const events = sunEvents(spot.lat, spot.lng, spot.tz, dateKey);
  const resolved = resolveAnchor(events, timing);
  if (!resolved) return { resolvable: false as const, events };
  const [start, end] = bandToRange(resolved, timing);
  const mid = new Date((start.getTime() + end.getTime()) / 2);
  const midPos = solarPosition(mid, spot.lat, spot.lng);
  const samples = sampleWindow(
    spot.lat,
    spot.lng,
    start,
    end,
    Math.max(1, Math.ceil(Math.max(1, (end.getTime() - start.getTime()) / 60000) / 300)),
  );
  const effectiveElevation = resolved.elevationRange ?? timing.elevationRange;
  const center = timing.azimuthRange
    ? (timing.azimuthRange[0] + timing.azimuthRange[1]) / 2
    : null;
  return {
    resolvable: true as const,
    anchorAt: resolved.anchorAt,
    bandStart: start,
    bandEnd: end,
    midPos,
    hasElevHit:
      samples.filter((s) => elevationInRange(s.elevationDeg, effectiveElevation)).length >= 2,
    hasAzHit:
      center === null
        ? null
        : samples.some(
            (s) =>
              elevationInRange(s.elevationDeg, effectiveElevation) &&
              angularDistance(s.azimuthDeg, center) <= timing.azimuthTolerance,
          ),
  };
}

/** 重放一条已落库窗口，并与存储判定逐项比对 */
export function replayWindow(
  spot: SpotGeom,
  timing: TimingDto,
  row: WindowRowSnapshot,
): ReplayResult {
  const snapshot = row.forecast_snapshot
    ? parseJson<WeatherEpisode | null>(row.forecast_snapshot, null)
    : null;

  const weather = replayWeatherFromSnapshot(timing, row.sun_elevation, snapshot);
  const diffs: ReplayDiff[] = [];

  // 天文锚点比对（仅在能解析时；极昼极夜的 bad 窗口本来就没有窗口段）
  const astro = replayAstronomy(spot, timing, row.date);
  if (astro.resolvable) {
    if (Math.abs(astro.anchorAt.getTime() - new Date(row.anchor_at).getTime()) > EPS_MS) {
      diffs.push({ field: 'anchorAt', stored: row.anchor_at, replayed: astro.anchorAt.toISOString() });
    }
  }

  // 天气段 reasons 比对：取存储 reasons 中"天气相关 code"的子集
  const weatherCodes = new Set([
    'WEATHER_DEGRADED',
    'PRECIP',
    'PRECIP_FAIL',
    'PRECIP_MARGINAL',
    'WIND',
    'WIND_FAIL',
    'WIND_MARGINAL',
    'VISIBILITY',
    'VISIBILITY_FAIL',
    'VISIBILITY_MARGINAL',
    'CLOUD_OK',
    'CLOUD_FAIL',
    'CLOUD_MARGINAL',
    'TEMP_OK',
    'TEMP_FAIL',
    'TEMP_MARGINAL',
    'PHENOMENON_OK',
    'PHENOMENON_FAIL',
    'PHENOMENON_MARGINAL',
  ]);
  const storedWeatherReasons = parseJson<WindowReasonDto[]>(row.reasons, []).filter((r) =>
    weatherCodes.has(r.code),
  );
  const replayedWeatherReasons = weather.reasons;
  if (storedWeatherReasons.length !== replayedWeatherReasons.length) {
    diffs.push({
      field: 'weatherReasons.length',
      stored: storedWeatherReasons.length,
      replayed: replayedWeatherReasons.length,
    });
  } else {
    for (let i = 0; i < storedWeatherReasons.length; i += 1) {
      const a = storedWeatherReasons[i];
      const b = replayedWeatherReasons[i];
      if (!b || a.code !== b.code || a.level !== b.level || a.text !== b.text) {
        diffs.push({ field: `weatherReasons[${i}]`, stored: a, replayed: b });
      }
    }
  }

  // verdict 比对：历史窗口的最终 verdict 由"天文段降级（窗口过短）"+ 天气段共同决定。
  // 天气段重放的初始 verdict 用存储 reasons 反推天文段输出（WINDOW_TOO_SHORT → marginal）。
  const allStoredReasons = parseJson<WindowReasonDto[]>(row.reasons, []);
  const astroVerdict: WindowVerdict = allStoredReasons.some((r) => r.code === 'WINDOW_TOO_SHORT')
    ? 'marginal'
    : 'good';
  let replayedVerdict: WindowVerdict = astroVerdict;
  if (weather.verdict === 'bad') replayedVerdict = 'bad';
  else if (weather.verdict === 'marginal' && replayedVerdict === 'good') replayedVerdict = 'marginal';
  if (replayedVerdict !== row.verdict) {
    diffs.push({ field: 'verdict', stored: row.verdict, replayed: replayedVerdict });
  }

  return {
    windowId: row.id,
    date: row.date,
    verdict: replayedVerdict,
    storedVerdict: row.verdict,
    reasons: allStoredReasons,
    episode: weather.episode,
    matches: diffs.length === 0,
    diffs,
  };
}

/** 读取一条灵感卡的全部历史窗口行（含快照） */
export function loadWindowRows(inspirationId: string): WindowRowSnapshot[] {
  return getDb()
    .prepare('SELECT * FROM repro_window WHERE inspiration_id = ? ORDER BY date ASC, start_at ASC')
    .all(inspirationId) as WindowRowSnapshot[];
}
