/**
 * 窗口判定纯管线 —— 见文档 12.4。
 *
 * 这是窗口计算与序列化的**边界**：本文件不碰数据库、网络、时钟与环境变量，
 * 输入（机位口径 + 条件口径 + 日期 + 逐小时预报 + provider 名）完全决定输出，
 * 因此：
 *   - 今天算未来窗口与日后重放历史窗口走的是同一段代码（历史窗口必须可重放）；
 *   - 纯函数的数值口径与 2026-10 重构前的 computeDay 完全一致（既有判定不变）。
 *
 * 涉及三套口径，全部来自 shared：
 *   - 时间口径：time.ts（本地日期键 / 时区换算 / 分钟）
 *   - 方位口径：geometry.ts（环形角距 angleDiff、区间命中 azimuthWithinRange）
 *   - 气象口径：weather.ts（summarizeEpisode / phenomenonHolds）
 */

import { resolveAnchor, sampleWindow, solarPosition, sunEvents, bandToRange, elevationInRange } from './astro.js';
import {
  addMinutes,
  formatLocal,
  localDayRangeUtc,
  minutesBetween,
  parseLocalDateKey,
} from './time.js';
import { azimuthWithinRange } from './geometry.js';
import type { TimingDto, WindowReasonDto } from './types.js';
import type { WeatherPhenomenon, WindowVerdict } from './enums.js';
import {
  NIGHT_ELEVATION_DEG,
  phenomenonHolds,
  summarizeEpisode,
  type EpisodeWeather,
  type HourlyForecast,
} from './weather.js';

/** 判定管线所需的机位口径（与数据库行解耦，便于回放/前端复用） */
export interface WindowSpotInput {
  lat: number;
  lng: number;
  tz: string;
}

/** 一次单日判定的完整可重放输入；序列化为 JSON 存入 repro_window.input_snapshot。 */
export interface WindowDayInput {
  schema: 'flil/window-input';
  schemaVersion: 1;
  /** 判定算法版本：取值变化意味着口径变更，旧快照仍按旧口径重放 */
  engineVersion: string;
  date: string;
  spot: { lat: number; lng: number; tz: string };
  timing: TimingDto;
  /** 当次判定实际使用的逐小时预报切片；空数组 = 降级（未含天气） */
  forecast: HourlyForecast[];
  /** 当次预报的提供方（fixture / open-meteo / off），回放时原样注入 */
  weatherProvider: string;
}

export interface DayWindowResult {
  date: string;
  startAt: Date;
  endAt: Date;
  anchorAt: Date;
  sunElevation: number | null;
  sunAzimuth: number | null;
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  episode: EpisodeWeather | null;
}

/** 判定算法版本号；纯函数重构（口径未变）仍记为 v1，历史窗口重放结果不变。 */
export const WINDOW_ENGINE_VERSION = '2026-10-v1';

const CONTIGUOUS_GAP_MIN = 6;

/** 找出满足条件的最长连续时间段 */
function longestRun(
  samples: { at: Date; ok: boolean }[],
): { start: Date; end: Date } | null {
  let best: { start: Date; end: Date } | null = null;
  let runStart: Date | null = null;
  let prevAt: Date | null = null;

  for (const s of samples) {
    if (s.ok) {
      if (!runStart) runStart = s.at;
      else if (prevAt && (s.at.getTime() - prevAt.getTime()) / 60000 > CONTIGUOUS_GAP_MIN) {
        const candidate = { start: runStart, end: prevAt };
        if (!best || candidate.end.getTime() - candidate.start.getTime() > best.end.getTime() - best.start.getTime()) {
          best = candidate;
        }
        runStart = s.at;
      }
      prevAt = s.at;
    } else if (runStart && prevAt) {
      const candidate = { start: runStart, end: prevAt };
      if (!best || candidate.end.getTime() - candidate.start.getTime() > best.end.getTime() - best.start.getTime()) {
        best = candidate;
      }
      runStart = null;
      prevAt = null;
    }
  }
  if (runStart && prevAt) {
    const candidate = { start: runStart, end: prevAt };
    if (!best || candidate.end.getTime() - candidate.start.getTime() > best.end.getTime() - best.start.getTime()) {
      best = candidate;
    }
  }
  return best;
}

function fmtDeg(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '未知' : `${v.toFixed(digits)}°`;
}

function describeAnchor(timing: TimingDto): string {
  switch (timing.timeAnchor) {
    case 'sunrise_plus':
      return `日出后 ${timing.anchorOffsetMin} 分`;
    case 'sunset_minus':
      return `日落前 ${Math.abs(timing.anchorOffsetMin)} 分`;
    case 'fixed_clock':
      return `固定钟点 ${String(Math.floor(timing.anchorOffsetMin / 60)).padStart(2, '0')}:${String(
        Math.round(timing.anchorOffsetMin % 60),
      ).padStart(2, '0')}`;
    default:
      return timing.timeAnchor;
  }
}

/** 判定单日窗口（文档 12.4 的算法，逐项产出 reasons）。纯函数。 */
export function evaluateDayWindow(
  spot: WindowSpotInput,
  timing: TimingDto,
  dateKey: string,
  forecast: HourlyForecast[],
  weatherProvider = 'unknown',
): DayWindowResult {
  const reasons: WindowReasonDto[] = [];
  const tz = spot.tz;
  const events = sunEvents(spot.lat, spot.lng, tz, dateKey);
  events.notes.forEach((n) => reasons.push({ code: 'SUN_EVENT_NOTE', level: 'info', text: n }));

  // ---- 季节窗口 ----
  if (timing.seasonWindow) {
    const { month } = parseLocalDateKey(dateKey);
    const { fromMonth, toMonth } = timing.seasonWindow;
    const inSeason =
      fromMonth <= toMonth ? month >= fromMonth && month <= toMonth : month >= fromMonth || month <= toMonth;
    if (!inSeason) {
      reasons.push({
        code: 'OUT_OF_SEASON',
        level: 'bad',
        text: `${month} 月不在设定季节窗口（${fromMonth}–${toMonth} 月）内`,
      });
      return {
        date: dateKey,
        startAt: events.solarNoon,
        endAt: events.solarNoon,
        anchorAt: events.solarNoon,
        sunElevation: null,
        sunAzimuth: null,
        verdict: 'bad',
        reasons,
        episode: null,
      };
    }
  }

  // ---- 1) 天文项：解析锚点 ----
  const resolved = resolveAnchor(events, timing);
  if (!resolved) {
    reasons.push({
      code: 'ANCHOR_UNRESOLVABLE',
      level: 'bad',
      text: `该日无法解析时间锚点（可能是极昼/极夜或偏移越界）`,
    });
    return {
      date: dateKey,
      startAt: events.solarNoon,
      endAt: events.solarNoon,
      anchorAt: events.solarNoon,
      sunElevation: null,
      sunAzimuth: null,
      verdict: 'bad',
      reasons,
      episode: null,
    };
  }

  resolved.notes.forEach((n) => reasons.push({ code: 'ANCHOR_NOTE', level: 'info', text: n }));
  reasons.push({
    code: 'ANCHOR_RESOLVED',
    level: 'ok',
    text: `${describeAnchor(timing)} → ${formatLocal(resolved.anchorAt, tz)}`,
  });

  const [bandStart, bandEnd] = bandToRange(resolved, timing);
  const effectiveElevation = resolved.elevationRange ?? timing.elevationRange;
  if (resolved.elevationRange) {
    reasons.push({
      code: 'ELEVATION_TARGET',
      level: 'info',
      text: `该锚点自带仰角区间 ${resolved.elevationRange[0]}°–${resolved.elevationRange[1]}°`,
    });
  }

  const spanMin = Math.max(1, minutesBetween(bandStart, bandEnd));
  const stepMin = Math.max(1, Math.ceil(spanMin / 300)); // 最多 300 个采样点
  const samples = sampleWindow(spot.lat, spot.lng, bandStart, bandEnd, stepMin);

  const elevOk = samples.filter((s) => elevationInRange(s.elevationDeg, effectiveElevation));
  if (elevOk.length < 2) {
    const p = solarPosition(resolved.anchorAt, spot.lat, spot.lng);
    reasons.push({
      code: 'ELEVATION_MISS',
      level: 'bad',
      text: `窗口内太阳仰角始终不在 ${effectiveElevation[0]}°–${effectiveElevation[1]}°（锚点处实测 ${fmtDeg(
        p.elevationDeg,
      )}）`,
    });
    return {
      date: dateKey,
      startAt: bandStart,
      endAt: bandEnd,
      anchorAt: resolved.anchorAt,
      sunElevation: p.elevationDeg,
      sunAzimuth: p.azimuthDeg,
      verdict: 'bad',
      reasons,
      episode: null,
    };
  }
  reasons.push({
    code: 'ELEVATION_OK',
    level: 'ok',
    text: `窗口内仰角 ${fmtDeg(Math.min(...elevOk.map((s) => s.elevationDeg)))}–${fmtDeg(
      Math.max(...elevOk.map((s) => s.elevationDeg)),
    )}（目标 ${effectiveElevation[0]}°–${effectiveElevation[1]}°）`,
  });

  // ---- 2) 方位角约束（光位）----
  let candidateSamples = samples.map((s) => ({ ...s, ok: elevationInRange(s.elevationDeg, effectiveElevation) }));
  if (timing.azimuthRange) {
    const [azLo, azHi] = timing.azimuthRange;
    const tol = timing.azimuthTolerance;
    candidateSamples = samples.map((s) => ({
      ...s,
      ok:
        elevationInRange(s.elevationDeg, effectiveElevation) &&
        azimuthWithinRange(s.azimuthDeg, timing.azimuthRange as number[], tol),
    }));
    const azOk = candidateSamples.filter((s) => s.ok);
    if (azOk.length < 2) {
      const p = solarPosition(resolved.anchorAt, spot.lat, spot.lng);
      reasons.push({
        code: 'AZIMUTH_MISS',
        level: 'bad',
        text: `太阳方位角始终不在 ${azLo.toFixed(0)}°±${tol}°（锚点处实测 ${fmtDeg(p.azimuthDeg)}）`,
      });
      return {
        date: dateKey,
        startAt: bandStart,
        endAt: bandEnd,
        anchorAt: resolved.anchorAt,
        sunElevation: p.elevationDeg,
        sunAzimuth: p.azimuthDeg,
        verdict: 'bad',
        reasons,
        episode: null,
      };
    }
    reasons.push({
      code: 'AZIMUTH_OK',
      level: 'ok',
      text: `方位角命中 ${azLo.toFixed(0)}°±${tol}°（窗口内实测 ${fmtDeg(
        Math.min(...azOk.map((s) => s.azimuthDeg)),
      )}–${fmtDeg(Math.max(...azOk.map((s) => s.azimuthDeg)))}）`,
    });
  }

  const run = longestRun(candidateSamples);
  if (!run) {
    reasons.push({ code: 'WINDOW_EMPTY', level: 'bad', text: '没有满足全部天文约束的时刻' });
    return {
      date: dateKey,
      startAt: bandStart,
      endAt: bandEnd,
      anchorAt: resolved.anchorAt,
      sunElevation: null,
      sunAzimuth: null,
      verdict: 'bad',
      reasons,
      episode: null,
    };
  }

  const durationMin = minutesBetween(run.start, run.end) + stepMin;
  let verdict: WindowVerdict = 'good';
  if (durationMin < 5) {
    verdict = 'marginal';
    reasons.push({
      code: 'WINDOW_TOO_SHORT',
      level: 'warn',
      text: `可用窗口仅约 ${durationMin.toFixed(0)} 分钟（少于 5 分钟）`,
    });
  }
  reasons.push({
    code: 'WINDOW_RANGE',
    level: 'ok',
    text: `窗口 ${formatLocal(run.start, tz)}–${formatLocal(run.end, tz)}（约 ${durationMin.toFixed(0)} 分钟）`,
  });

  const mid = new Date((run.start.getTime() + run.end.getTime()) / 2);
  const midPos = solarPosition(mid, spot.lat, spot.lng);

  // ---- 3) 天气项 ----
  const episode = summarizeEpisode(forecast, run.start, run.end, weatherProvider);
  if (episode.degraded) {
    reasons.push({
      code: 'WEATHER_DEGRADED',
      level: 'warn',
      text: '天气源不可用：本次判定未包含天气，最高只能到「勉强」',
    });
    if (verdict === 'good') verdict = 'marginal';
  } else {
    const profile = timing.weatherProfile;
    const hard = new Set(profile.hardRequirements ?? ['precipProbPctMax']);
    const isNight = midPos.elevationDeg < NIGHT_ELEVATION_DEG;

    const check = (
      code: string,
      key: string,
      actual: number | null,
      limit: number,
      compare: 'max' | 'min',
      text: string,
    ): void => {
      if (actual === null) return;
      const violated = compare === 'max' ? actual > limit : actual < limit;
      if (!violated) {
        reasons.push({ code, level: 'ok', text });
        return;
      }
      const isHard = hard.has(key);
      reasons.push({
        code: `${code}_${isHard ? 'FAIL' : 'MARGINAL'}`,
        level: isHard ? 'bad' : 'warn',
        text,
      });
      if (isHard) verdict = 'bad';
      else if (verdict === 'good') verdict = 'marginal';
    };

    if (profile.precipProbPctMax !== undefined) {
      check(
        'PRECIP',
        'precipProbPctMax',
        episode.maxPrecipProbPct,
        profile.precipProbPctMax,
        'max',
        `降水概率 ${episode.maxPrecipProbPct?.toFixed(0) ?? '?'}%（上限 ${profile.precipProbPctMax}%）`,
      );
    }
    if (profile.windSpeedMax !== undefined) {
      check(
        'WIND',
        'windSpeedMax',
        episode.maxWindSpeedMs,
        profile.windSpeedMax,
        'max',
        `风速 ${episode.maxWindSpeedMs?.toFixed(1) ?? '?'} m/s（上限 ${profile.windSpeedMax}）`,
      );
    }
    if (profile.visibilityKmMin !== undefined) {
      check(
        'VISIBILITY',
        'visibilityKmMin',
        episode.minVisibilityKm,
        profile.visibilityKmMin,
        'min',
        `能见度 ${episode.minVisibilityKm?.toFixed(1) ?? '?'} km（下限 ${profile.visibilityKmMin}）`,
      );
    }

    if (profile.cloudCoverPct && episode.avgCloudCoverPct !== null) {
      const { min, max } = profile.cloudCoverPct;
      const cloud = episode.avgCloudCoverPct;
      const ok = cloud >= min && cloud <= max;
      const isHard = hard.has('cloudCoverPct');
      reasons.push({
        code: ok ? 'CLOUD_OK' : isHard ? 'CLOUD_FAIL' : 'CLOUD_MARGINAL',
        level: ok ? 'ok' : isHard ? 'bad' : 'warn',
        text: `云量 ${cloud.toFixed(0)}%（目标 ${min}%–${max}%）`,
      });
      if (!ok) {
        if (isHard) verdict = 'bad';
        else if (verdict === 'good') verdict = 'marginal';
      }
    }

    if (profile.tempC && episode.avgTempC !== null) {
      const ok = episode.avgTempC >= profile.tempC.min && episode.avgTempC <= profile.tempC.max;
      const isHard = hard.has('tempC');
      reasons.push({
        code: ok ? 'TEMP_OK' : isHard ? 'TEMP_FAIL' : 'TEMP_MARGINAL',
        level: ok ? 'ok' : isHard ? 'bad' : 'warn',
        text: `气温 ${episode.avgTempC.toFixed(0)}℃（目标 ${profile.tempC.min}–${profile.tempC.max}℃）`,
      });
      if (!ok) {
        if (isHard) verdict = 'bad';
        else if (verdict === 'good') verdict = 'marginal';
      }
    }

    for (const phenomenon of (profile.phenomena ?? []) as WeatherPhenomenon[]) {
      if (phenomenon === 'any') continue;
      const hit = phenomenonHolds(phenomenon, episode, isNight);
      const isHard = hard.has(`phenomenon:${phenomenon}`);
      reasons.push({
        code: hit ? 'PHENOMENON_OK' : isHard ? 'PHENOMENON_FAIL' : 'PHENOMENON_MARGINAL',
        level: hit ? 'ok' : isHard ? 'bad' : 'warn',
        text: `特殊现象「${phenomenon}」${hit ? '满足' : '不满足'}`,
      });
      if (!hit) {
        if (isHard) verdict = 'bad';
        else if (verdict === 'good') verdict = 'marginal';
      }
    }
  }

  return {
    date: dateKey,
    startAt: run.start,
    endAt: run.end,
    anchorAt: resolved.anchorAt,
    sunElevation: midPos.elevationDeg,
    sunAzimuth: midPos.azimuthDeg,
    verdict,
    reasons,
    episode,
  };
}

/** 构造单日可重放输入快照（供落库；回放时把同一对象交回 evaluateDayWindowInput）。 */
export function buildWindowDayInput(
  spot: WindowSpotInput,
  timing: TimingDto,
  dateKey: string,
  forecast: HourlyForecast[],
  weatherProvider: string,
): WindowDayInput {
  return {
    schema: 'flil/window-input',
    schemaVersion: 1,
    engineVersion: WINDOW_ENGINE_VERSION,
    date: dateKey,
    spot: { lat: spot.lat, lng: spot.lng, tz: spot.tz },
    timing,
    forecast,
    weatherProvider,
  };
}

/** 按历史输入快照重放单日判定（旧接口/历史窗口可重放的入口）。 */
export function evaluateDayWindowInput(input: WindowDayInput): DayWindowResult {
  return evaluateDayWindow(input.spot, input.timing, input.date, input.forecast, input.weatherProvider);
}

/**
 * 从一次完整预报里切出单日判定真正需要的部分，用于落库快照。
 *
 * 采样窗口永远落在该本地日期（向两侧各外扩 3 小时扫描太阳事件）之内，
 * 天气聚合还会回看窗口开始前 6 小时，因此保留 [当地0点−9h, 次日0点+3h] 的整点样本
 * 即可在日后无损重放（降级为空数组的场景也原样保留为空）。
 */
export function sliceForecastForDay(
  forecast: HourlyForecast[],
  tz: string,
  dateKey: string,
): HourlyForecast[] {
  if (forecast.length === 0) return [];
  const day = localDayRangeUtc(dateKey, tz);
  const from = addMinutes(day.start, -9 * 60);
  const to = addMinutes(day.end, 3 * 60);
  return forecast.filter((f) => {
    const t = new Date(f.time).getTime();
    return t >= from.getTime() && t <= to.getTime();
  });
}
