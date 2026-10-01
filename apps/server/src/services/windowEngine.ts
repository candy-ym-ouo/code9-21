import {
  addDaysToKey,
  localDateKey,
  reproWindowRowToDto,
  evaluateDayWindow,
  evaluateDayWindowInput,
  buildWindowDayInput,
  sliceForecastForDay,
  type ReproWindowDto,
  type ReproWindowRow,
  type TimingDto,
  type WindowDayInput,
  type HourlyForecast,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { config } from '../config.js';
import { emitEvent } from './events.js';
import { getForecast } from './weather.js';

export interface TimingRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  time_anchor: TimingDto['timeAnchor'];
  anchor_offset_min: number;
  elevation_range: string;
  azimuth_range: string | null;
  azimuth_tolerance: number;
  window_tolerance_min: number;
  weather_profile: string;
  season_window: string | null;
  repeat_rule: string | null;
  notes: string | null;
}

export interface SpotGeom {
  id: string;
  lat: number;
  lng: number;
  camera_bearing: number;
  tz: string;
}

export function timingRowToDto(row: TimingRow): TimingDto {
  return {
    timeAnchor: row.time_anchor,
    anchorOffsetMin: row.anchor_offset_min,
    elevationRange: parseJson<number[]>(row.elevation_range, [-90, 90]),
    azimuthRange: row.azimuth_range ? parseJson<number[] | null>(row.azimuth_range, null) : null,
    azimuthTolerance: row.azimuth_tolerance,
    windowToleranceMin: row.window_tolerance_min,
    weatherProfile: parseJson(row.weather_profile, {}),
    seasonWindow: row.season_window
      ? parseJson<{ fromMonth: number; toMonth: number } | null>(row.season_window, null)
      : null,
    notes: row.notes,
  };
}

export function loadTiming(inspirationId: string): TimingRow | null {
  return (
    (getDb().prepare('SELECT * FROM timing WHERE inspiration_id = ?').get(inspirationId) as TimingRow | undefined) ??
    null
  );
}

export function loadSpotGeom(spotId: string): SpotGeom | null {
  const row = getDb()
    .prepare('SELECT id, lat, lng, camera_bearing, tz FROM spot WHERE id = ?')
    .get(spotId) as SpotGeom | undefined;
  return row ?? null;
}

/**
 * 单日判定（旧接口，保持原签名/返回结构不变）。
 * 实现已下沉到 @flil/shared 的纯管线 evaluateDayWindow —— 未来窗口与历史窗口重放同源。
 */
export function computeDay(
  spot: SpotGeom,
  timing: TimingDto,
  dateKey: string,
  forecast: HourlyForecast[],
) {
  return evaluateDayWindow(
    { lat: spot.lat, lng: spot.lng, tz: spot.tz },
    timing,
    dateKey,
    forecast,
    config.weatherProvider,
  );
}

export interface ComputeOptions {
  days?: number;
  now?: Date;
}

/**
 * 计算并落库某条灵感卡的未来窗口。
 * 幂等：同一 (inspiration, date) 只保留一条窗口；被计划引用的窗口原地更新，避免打断闭环。
 *
 * 每条窗口同时写入 input_snapshot（机位 + 条件 + 当次预报切片 + provider + 算法版本），
 * 供日后用 replayWindowRow 无损重放（历史窗口必须可重放）。
 */
export async function computeWindowsForInspiration(
  inspirationId: string,
  opts: ComputeOptions = {},
): Promise<ReproWindowDto[]> {
  const db = getDb();
  const inspiration = db
    .prepare('SELECT id, library_id, spot_id FROM inspiration WHERE id = ?')
    .get(inspirationId) as { id: string; library_id: string; spot_id: string | null } | undefined;
  if (!inspiration) throw errors.notFound('灵感卡');

  const timingRow = loadTiming(inspirationId);
  if (!timingRow) throw errors.timingIncomplete('该卡片还没有设置拍摄条件');
  const timing = timingRowToDto(timingRow);

  if (!inspiration.spot_id) {
    return [];
  }
  const spot = loadSpotGeom(inspiration.spot_id);
  if (!spot) return [];

  const days = opts.days ?? config.windowForecastDays;
  const now = opts.now ?? new Date();
  const todayKey = localDateKey(now, spot.tz);
  const forecast = await getForecast(spot.lat, spot.lng, days);

  const results = [] as ReturnType<typeof computeDay>[];
  for (let i = 0; i < days; i += 1) {
    const key = addDaysToKey(todayKey, i);
    results.push(computeDay(spot, timing, key, forecast));
  }

  const previous = db
    .prepare('SELECT id, date, verdict, start_at FROM repro_window WHERE inspiration_id = ?')
    .all(inspirationId) as { id: string; date: string; verdict: string; start_at: string }[];
  const previousByDate = new Map(previous.map((p) => [p.date, p]));
  const plannedWindowIds = new Set(
    (
      db
        .prepare('SELECT window_id FROM shoot_plan WHERE inspiration_id = ? AND window_id IS NOT NULL')
        .all(inspirationId) as { window_id: string }[]
    ).map((r) => r.window_id),
  );

  const ts = nowIso();
  const dtos: ReproWindowDto[] = [];

  const persist = db.transaction(() => {
    for (const r of results) {
      // 当次判定的可重放输入：只存当日实际用到的预报切片（空数组 = 降级也原样保留）
      const dayForecast = sliceForecastForDay(forecast, spot.tz, r.date);
      const snapshot = buildWindowDayInput(
        { lat: spot.lat, lng: spot.lng, tz: spot.tz },
        timing,
        r.date,
        dayForecast,
        config.weatherProvider,
      );

      const prior = previousByDate.get(r.date);
      let id: string;
      if (prior && plannedWindowIds.has(prior.id)) {
        // 已被出行计划引用 → 原地更新，保住闭环链路
        id = prior.id;
        db.prepare(
          `UPDATE repro_window SET start_at=?, end_at=?, anchor_at=?, sun_elevation=?, sun_azimuth=?,
             verdict=?, reasons=?, forecast_snapshot=?, weather_degraded=?, stale=0, computed_at=?, input_snapshot=?
           WHERE id=?`,
        ).run(
          r.startAt.toISOString(),
          r.endAt.toISOString(),
          r.anchorAt.toISOString(),
          r.sunElevation,
          r.sunAzimuth,
          r.verdict,
          toJson(r.reasons),
          r.episode ? toJson(r.episode) : null,
          r.episode?.degraded ? 1 : 0,
          ts,
          toJson(snapshot),
          id,
        );
      } else {
        if (prior) {
          db.prepare('DELETE FROM repro_window WHERE inspiration_id = ? AND date = ?').run(inspirationId, r.date);
        }
        id = newId();
        db.prepare(
          `INSERT INTO repro_window (id, library_id, inspiration_id, date, start_at, end_at, anchor_at,
             sun_elevation, sun_azimuth, verdict, reasons, forecast_snapshot, weather_degraded, stale, computed_at,
             input_snapshot)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
        ).run(
          id,
          inspiration.library_id,
          inspirationId,
          r.date,
          r.startAt.toISOString(),
          r.endAt.toISOString(),
          r.anchorAt.toISOString(),
          r.sunElevation,
          r.sunAzimuth,
          r.verdict,
          toJson(r.reasons),
          r.episode ? toJson(r.episode) : null,
          r.episode?.degraded ? 1 : 0,
          ts,
          toJson(snapshot),
        );
      }

      if (prior && prior.verdict !== r.verdict) {
        emitEvent({
          type: 'window_changed',
          libraryId: inspiration.library_id,
          payload: { inspirationId, date: r.date, from: prior.verdict, to: r.verdict },
        });
      }

      dtos.push({
        ...reproWindowRowToDto({
          ...({
            id,
            library_id: inspiration.library_id,
            inspiration_id: inspirationId,
            date: r.date,
            start_at: r.startAt.toISOString(),
            end_at: r.endAt.toISOString(),
            anchor_at: r.anchorAt.toISOString(),
            sun_elevation: r.sunElevation,
            sun_azimuth: r.sunAzimuth,
            verdict: r.verdict,
            reasons: r.reasons,
            forecast_snapshot: null,
            weather_degraded: r.episode?.degraded ? 1 : 0,
            stale: 0,
            computed_at: ts,
            input_snapshot: toJson(snapshot),
          } satisfies ReproWindowRow),
        }),
        // 历史口径：重算接口对"天文项提前判 bad、未走到天气项"（episode=null）的窗口
        // 一直返回 weatherDegraded=true；list/落库路径按列值为 false。两者差异保留，不改既有行为。
        weatherDegraded: r.episode?.degraded ?? true,
      });
    }
  });
  persist();

  return dtos;
}

export function listWindows(inspirationId: string): ReproWindowDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM repro_window WHERE inspiration_id = ? ORDER BY date ASC, start_at ASC')
    .all(inspirationId) as ReproWindowRow[];
  return rows.map(reproWindowRowToDto);
}

function getWindowRow(windowId: string): ReproWindowRow | null {
  return (
    (getDb().prepare('SELECT * FROM repro_window WHERE id = ?').get(windowId) as ReproWindowRow | undefined) ?? null
  );
}

/**
 * 用落库时的输入快照重放单条历史窗口（不覆盖原行，只返回重放结果）。
 * 返回 replayable=false 表示该窗口产生于快照机制之前（旧数据），无法重放，但原 verdict/reasons 仍可读。
 */
export function replayWindowRow(windowId: string): {
  replayable: boolean;
  stored: ReproWindowDto;
  replayed: ReproWindowDto | null;
  engineVersion: string | null;
  identical: boolean | null;
} {
  const row = getWindowRow(windowId);
  if (!row) throw errors.notFound('窗口');
  const stored = reproWindowRowToDto(row);

  const snapshot = row.input_snapshot ? parseJson<WindowDayInput | null>(row.input_snapshot, null) : null;
  if (!snapshot || snapshot.schema !== 'flil/window-input') {
    return { replayable: false, stored, replayed: null, engineVersion: null, identical: null };
  }

  const r = evaluateDayWindowInput(snapshot);
  const replayed: ReproWindowDto = {
    ...stored,
    startAt: r.startAt.toISOString(),
    endAt: r.endAt.toISOString(),
    anchorAt: r.anchorAt.toISOString(),
    sunElevation: r.sunElevation,
    sunAzimuth: r.sunAzimuth,
    verdict: r.verdict,
    reasons: r.reasons,
    weatherDegraded: r.episode?.degraded ?? stored.weatherDegraded,
    stale: stored.stale,
    computedAt: stored.computedAt,
  };

  // 判定口径一致性：verdict 与逐项理由必须与落库时完全一致
  const identical =
    replayed.verdict === stored.verdict &&
    JSON.stringify(replayed.reasons) === JSON.stringify(stored.reasons) &&
    replayed.startAt === stored.startAt &&
    replayed.endAt === stored.endAt &&
    replayed.anchorAt === stored.anchorAt;

  return { replayable: true, stored, replayed, engineVersion: snapshot.engineVersion, identical };
}

/** 重放一张卡的全部窗口；旧窗口（无快照）以 replayable=false 原样返回，不报错。 */
export function replayWindowsForInspiration(inspirationId: string) {
  const rows = getDb()
    .prepare('SELECT id FROM repro_window WHERE inspiration_id = ? ORDER BY date ASC')
    .all(inspirationId) as { id: string }[];
  return rows.map((r) => replayWindowRow(r.id));
}

export function windowSummary(
  inspirationId: string,
  now = new Date(),
): { nextGoodAt: string | null; goodIn30d: number } {
  const db = getDb();
  const nowIsoStr = now.toISOString();
  const next = db
    .prepare(
      `SELECT start_at FROM repro_window WHERE inspiration_id = ? AND verdict = 'good' AND start_at >= ?
       ORDER BY start_at ASC LIMIT 1`,
    )
    .get(inspirationId, nowIsoStr) as { start_at: string } | undefined;
  const until = new Date(now.getTime() + 30 * 86400000).toISOString();
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id = ? AND verdict = 'good'
       AND start_at >= ? AND start_at <= ?`,
    )
    .get(inspirationId, nowIsoStr, until) as { n: number };
  return { nextGoodAt: next?.start_at ?? null, goodIn30d: count.n };
}
