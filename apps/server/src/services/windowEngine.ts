/**
 * 窗口计算的 server 边界：取数（预报）、落库（repro_window）、事件通知与汇总查询。
 *
 * 本文件**不再承载判定口径**——所有纯判定在 @flil/shared/window，
 * server 侧无 DB 的适配在 ./windowDecide.js，历史重放在 ./windowReplay.js。
 * 旧接口（computeDay / loadTiming / loadSpotGeom / timingRowToDto / listWindows /
 * windowSummary / addMinutes / formatLocal）全部保留再导出，历史调用无需改动。
 */

import {
  addDaysToKey,
  addMinutes,
  formatLocal,
  localDateKey,
  type DayWindowResult,
  type ReproWindowDto,
} from '@flil/shared';
import { getDb, newId, nowIso, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { config } from '../config.js';
import { emitEvent } from './events.js';
import { getForecast } from './weather.js';
import { computeDayForProvider } from './windowDecide.js';
import { toWindowDto } from './serialization.js';
import {
  timingRowToDto,
  type SpotGeom,
  type TimingRow,
} from './windowRows.js';

// 旧接口再导出（判定相关的纯函数已迁至共享包；行类型统一在 windowRows）
export { computeDay, type DayResult } from './windowDecide.js';
export { timingRowToDto, type SpotGeom, type TimingRow } from './windowRows.js';

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

// ---- 以下落库/查询编排 ----

export interface ComputeOptions {
  days?: number;
  now?: Date;
}

/**
 * 计算并落库某条灵感卡的未来窗口。
 * 幂等：同一 (inspiration, date) 只保留一条窗口；被计划引用的窗口原地更新，避免打断闭环。
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

  // 纯判定：provider 仅作为元数据写入 episode（降级时共享纯函数也会记录当时配置名）
  const results: DayWindowResult[] = [];
  for (let i = 0; i < days; i += 1) {
    const key = addDaysToKey(todayKey, i);
    results.push(computeDayForProvider(spot, timing, key, forecast, config.weatherProvider));
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
      const prior = previousByDate.get(r.date);
      let id: string;
      if (prior && plannedWindowIds.has(prior.id)) {
        // 已被出行计划引用 → 原地更新，保住闭环链路
        id = prior.id;
        db.prepare(
          `UPDATE repro_window SET start_at=?, end_at=?, anchor_at=?, sun_elevation=?, sun_azimuth=?,
             verdict=?, reasons=?, forecast_snapshot=?, weather_degraded=?, stale=0, computed_at=?
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
          id,
        );
      } else {
        if (prior) {
          db.prepare('DELETE FROM repro_window WHERE inspiration_id = ? AND date = ?').run(inspirationId, r.date);
        }
        id = newId();
        db.prepare(
          `INSERT INTO repro_window (id, library_id, inspiration_id, date, start_at, end_at, anchor_at,
             sun_elevation, sun_azimuth, verdict, reasons, forecast_snapshot, weather_degraded, stale, computed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
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
        id,
        inspirationId,
        date: r.date,
        startAt: r.startAt.toISOString(),
        endAt: r.endAt.toISOString(),
        anchorAt: r.anchorAt.toISOString(),
        sunElevation: r.sunElevation,
        sunAzimuth: r.sunAzimuth,
        verdict: r.verdict,
        reasons: r.reasons,
        weatherDegraded: r.episode?.degraded ?? true,
        stale: false,
        computedAt: ts,
      });
    }
  });
  persist();

  return dtos;
}

/** 历史窗口列表：行→DTO 映射统一走序列化层的唯一出口 */
export function listWindows(inspirationId: string): ReproWindowDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM repro_window WHERE inspiration_id = ? ORDER BY date ASC, start_at ASC')
    .all(inspirationId) as Record<string, unknown>[];
  return rows.map(toWindowDto);
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

export { addMinutes, formatLocal };
