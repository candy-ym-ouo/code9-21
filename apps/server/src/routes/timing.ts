import { Router } from 'express';
import { z } from 'zod';
import {
  addDaysToKey,
  distanceBand,
  distanceKm,
  formatLocal,
  localDateKey,
  resolveAnchor,
  sunEvents,
  theoreticalOkForDay,
  theoreticalDaysInYear,
  timingSchema,
  type TimingDto,
} from '@flil/shared';
import { getDb, newId, nowIso, toJson } from '../db.js';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf, libraryTz } from '../http/context.js';
import { errors } from '../http/errors.js';
import { requireInspiration, syncStatus, touch } from '../services/inspirations.js';
import {
  computeWindowsForInspiration,
  listWindows,
  loadSpotGeom,
  loadTiming,
  replayWindowRow,
  replayWindowsForInspiration,
  timingRowToDto,
  windowSummary,
} from '../services/windowEngine.js';
import { climateAt, climateStats, getForecast } from '../services/weather.js';
import { toInspirationDto } from '../services/serialization.js';

export const timingRouter = Router();
timingRouter.use(authenticate());

function upsertTiming(libraryId: string, inspirationId: string, input: TimingDto): void {
  const db = getDb();
  const ts = nowIso();
  const existing = loadTiming(inspirationId);
  const values = [
    input.timeAnchor,
    input.anchorOffsetMin,
    toJson(input.elevationRange),
    input.azimuthRange ? toJson(input.azimuthRange) : null,
    input.azimuthTolerance,
    input.windowToleranceMin,
    toJson(input.weatherProfile),
    input.seasonWindow ? toJson(input.seasonWindow) : null,
    input.notes,
  ];
  if (existing) {
    db.prepare(
      `UPDATE timing SET time_anchor = ?, anchor_offset_min = ?, elevation_range = ?, azimuth_range = ?,
         azimuth_tolerance = ?, window_tolerance_min = ?, weather_profile = ?, season_window = ?, notes = ?,
         updated_at = ? WHERE id = ?`,
    ).run(...(values as never[]), ts, existing.id);
  } else {
    db.prepare(
      `INSERT INTO timing (id, library_id, inspiration_id, time_anchor, anchor_offset_min, elevation_range,
         azimuth_range, azimuth_tolerance, window_tolerance_min, weather_profile, season_window, notes,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(newId(), libraryId, inspirationId, ...(values as never[]), ts, ts);
  }
}

timingRouter.get(
  '/inspirations/:id/timing',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const timing = loadTiming(row.id);
    ok(res, { item: timing ? timingRowToDto(timing) : null });
  }),
);

timingRouter.put(
  '/inspirations/:id/timing',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const input = timingSchema.parse(req.body) as TimingDto;
    upsertTiming(ctx.libraryId, row.id, input);
    syncStatus(row.id);

    let windows: unknown[] = [];
    if (row.spot_id) {
      windows = await computeWindowsForInspiration(row.id, { days: 7 });
    }
    ok(res, { item: timingRowToDto(loadTiming(row.id)!), windows });
  }),
);

/** 锚点解析预览：告诉用户"你说的这个锚点，今天对应几点、仰角多少" */
timingRouter.post(
  '/inspirations/:id/timing/preview',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const input = timingSchema.parse(req.body) as TimingDto;
    if (!row.spot_id) throw errors.badRequest('该卡片还没有机位，先把机位定下来');
    const spot = loadSpotGeom(row.spot_id);
    if (!spot) throw errors.badRequest('机位不存在');

    const today = localDateKey(new Date(), spot.tz);
    const events = sunEvents(spot.lat, spot.lng, spot.tz, today);
    const resolved = resolveAnchor(events, input);

    const sat = await satisfactionRate(spot.lat, spot.lng, spot.tz, input, 30);
    ok(res, {
      date: today,
      anchorAt: resolved ? resolved.anchorAt.toISOString() : null,
      anchorLocal: resolved ? formatLocal(resolved.anchorAt, spot.tz) : null,
      elevationRange: resolved?.elevationRange ?? input.elevationRange,
      polarity: events.polar,
      notes: [...events.notes, ...(resolved?.notes ?? [])],
      sunEvents: {
        sunrise: events.sunrise ? formatLocal(events.sunrise, spot.tz) : null,
        sunset: events.sunset ? formatLocal(events.sunset, spot.tz) : null,
        solarNoon: formatLocal(events.solarNoon, spot.tz),
        goldenAm: events.goldenAm
          ? `${formatLocal(events.goldenAm.start, spot.tz)}–${formatLocal(events.goldenAm.end, spot.tz)}`
          : null,
        goldenPm: events.goldenPm
          ? `${formatLocal(events.goldenPm.start, spot.tz)}–${formatLocal(events.goldenPm.end, spot.tz)}`
          : null,
        bluePm: events.bluePm
          ? `${formatLocal(events.bluePm.start, spot.tz)}–${formatLocal(events.bluePm.end, spot.tz)}`
          : null,
      },
      satisfiability: sat,
    });
  }),
);

/** 可满足性检查：近 N 天过去无法满足时给出放宽建议（文档 10.2③ / 20 风险表） */
async function satisfactionRate(
  lat: number,
  lng: number,
  tz: string,
  timing: TimingDto,
  days: number,
): Promise<{ total: number; satisfied: number; ratio: number; advice: string | null }> {
  const forecast = await getForecast(lat, lng, Math.min(16, days));
  const today = localDateKey(new Date(), tz);
  const results: { date: string; ok: boolean }[] = [];
  for (let i = 0; i < days; i += 1) {
    const key = addDaysToKey(today, i);
    results.push({ date: key, ok: theoreticalOkForDay(lat, lng, tz, key, timing) });
  }
  const satisfied = results.filter((r) => r.ok).length;
  const ratio = results.length ? satisfied / results.length : 0;
  let advice: string | null = null;
  if (results.length && satisfied === 0) {
    advice = `未来 ${days} 天该条件在理论上都无法成立，建议放宽仰角区间、方位角容差或季节窗口。`;
  } else if (results.length && ratio < 0.1) {
    advice = `未来 ${days} 天仅 ${satisfied} 天可能成立，条件偏严；如果长期没有窗口，可以适当放宽。`;
  }
  if (forecast.length === 0) advice = `${advice ?? ''}（当前天气源不可用，以上仅按天文条件估算）`.trim();
  return { total: results.length, satisfied, ratio: Number(ratio.toFixed(3)), advice };
}

timingRouter.get(
  '/inspirations/:id/windows',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const days = Math.min(16, Math.max(1, Number(req.query.days ?? 7)));
    if (String(req.query.refresh ?? 'false') === 'true') {
      try {
        await computeWindowsForInspiration(row.id, { days });
      } catch (err) {
        if (!(err instanceof Error && err.message.includes('条件'))) throw err;
      }
    }
    ok(res, { items: listWindows(row.id), summary: windowSummary(row.id) });
  }),
);

timingRouter.post(
  '/inspirations/:id/windows/recompute',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const days = Math.min(16, Math.max(1, Number(req.body?.days ?? 7)));
    const items = await computeWindowsForInspiration(row.id, { days });
    ok(res, { items });
  }),
);

/**
 * 重放一张卡的全部历史窗口：用每条窗口落库时的输入快照（条件 + 机位 + 当次预报切片）
 * 重新跑同一套纯判定，返回落库值、重放值及两者是否逐项一致。
 * 快照机制之前产生的旧窗口以 replayable=false 返回（原判定仍保留可读），不报错。
 */
timingRouter.post(
  '/inspirations/:id/windows/replay',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const items = replayWindowsForInspiration(row.id);
    ok(res, {
      items,
      replayable: items.filter((i) => i.replayable).length,
      total: items.length,
      identical: items.every((i) => !i.replayable || i.identical),
    });
  }),
);

/** 重放单条历史窗口（按窗口 id）；旧窗口（无快照）返回 replayable=false 而非报错。 */
timingRouter.post(
  '/windows/:windowId/replay',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const windowId = String(req.params.windowId);
    const row = getDb()
      .prepare('SELECT inspiration_id, library_id FROM repro_window WHERE id = ?')
      .get(windowId) as { inspiration_id: string; library_id: string } | undefined;
    if (!row || row.library_id !== ctx.libraryId) throw errors.notFound('窗口');
    // 仍校验卡片归属，行为与其它 /inspirations/:id 路由一致
    requireInspiration(row.inspiration_id, ctx.libraryId);
    ok(res, replayWindowRow(windowId));
  }),
);

/** 年度日历：理论天数 + 气候基线 + 实际命中率（文档 12.5） */
timingRouter.get(
  '/inspirations/:id/calendar',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const timing = loadTiming(row.id);
    if (!timing) throw errors.timingIncomplete();
    if (!row.spot_id) throw errors.badRequest('该卡片还没有机位');
    const spot = loadSpotGeom(row.spot_id);
    if (!spot) throw errors.badRequest('机位不存在');

    const year = Number(req.query.year ?? new Date().getUTCFullYear());
    const dto = timingRowToDto(timing);
    const days = theoreticalDaysInYear(spot.lat, spot.lng, spot.tz, dto, year);

    const weekly = new Map<number, { week: number; theoretical: number; climateRatio: number | null }>();
    const months = new Map<number, number>();
    for (const d of days) {
      const date = new Date(`${d.date}T00:00:00Z`);
      const week = Math.floor(
        (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / (7 * 86400000),
      );
      const entry = weekly.get(week) ?? { week, theoretical: 0, climateRatio: null };
      if (d.ok) entry.theoretical += 1;
      weekly.set(week, entry);
      const month = date.getUTCMonth() + 1;
      months.set(month, (months.get(month) ?? 0) + (d.ok ? 1 : 0));
    }

    // 气候基线（尽力而为，失败即为 null，界面显示"数据不足"）
    const month = new Date().getUTCMonth() + 1;
    const stats = await climateStats(spot.lat, spot.lng, month).catch(() => []);
    const climate = climateAt(stats, 17);

    ok(res, {
      year,
      theoreticalOkDays: days.filter((d) => d.ok).length,
      theoreticalDays: days,
      weekly: [...weekly.values()].sort((a, b) => a.week - b.week),
      monthlyTheoretical: [...months.entries()].map(([m, n]) => ({ month: m, days: n })),
      climate: climate
        ? {
            month,
            meanCloudCoverPct: Number(climate.meanCloudCoverPct.toFixed(1)),
            precipHourRatio: Number(climate.precipHourRatio.toFixed(3)),
            samples: climate.samples,
          }
        : null,
      actual: {
        hitRate: (requireInspiration(row.id, ctx.libraryId) as unknown as { hit_rate: number }).hit_rate,
        message: climate ? null : '气候基线数据不足（可开启 ENABLE_CLIMATE_BASELINE 或检查外网）',
      },
      timing: dto,
    });
  }),
);

/** "现在这一刻能去哪"：按当前位置 + 实时天气 + 距离排序 */
timingRouter.get(
  '/windows/today',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const db = getDb();
    const lat = req.query.lat ? Number(req.query.lat) : null;
    const lng = req.query.lng ? Number(req.query.lng) : null;
    const home = db
      .prepare('SELECT home_lat, home_lng FROM "user" WHERE id = ?')
      .get(String(req.auth?.id ?? '')) as { home_lat: number | null; home_lng: number | null } | undefined;
    const origin =
      lat !== null && lng !== null
        ? { lat, lng }
        : home?.home_lat != null && home?.home_lng != null
          ? { lat: home.home_lat, lng: home.home_lng }
          : null;

    const rows = db
      .prepare(
        `SELECT w.*, i.title, i.id AS inspiration_id, s.lat AS spot_lat, s.lng AS spot_lng
         FROM repro_window w
         JOIN inspiration i ON i.id = w.inspiration_id AND i.deleted_at IS NULL
         JOIN spot s ON s.id = i.spot_id
         WHERE w.library_id = ? AND w.verdict IN ('good','marginal') AND w.end_at >= ?
         ORDER BY w.start_at ASC LIMIT 100`,
      )
      .all(ctx.libraryId, new Date().toISOString()) as Record<string, unknown>[];

    const items = rows.map((r) => {
      const distance = origin
        ? distanceKm(origin, { lat: r.spot_lat as number, lng: r.spot_lng as number })
        : null;
      return {
        windowId: r.id,
        inspirationId: r.inspiration_id,
        title: r.title,
        startAt: r.start_at,
        endAt: r.end_at,
        verdict: r.verdict,
        distanceBand: distance === null ? null : distanceBand(distance),
        distanceKm: ctx.role === 'owner' && distance !== null ? Number(distance.toFixed(2)) : null,
      };
    });
    items.sort((a, b) => {
      if (a.verdict !== b.verdict) return a.verdict === 'good' ? -1 : 1;
      return (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9);
    });
    ok(res, { items, origin });
  }),
);

/** 全库未来窗口重算（供任务与手动触发使用） */
timingRouter.post(
  '/windows/scan',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const days = Math.min(16, Math.max(1, Number(req.body?.days ?? 7)));
    const rows = getDb()
      .prepare(
        `SELECT i.id FROM inspiration i JOIN timing t ON t.inspiration_id = i.id
         WHERE i.library_id = ? AND i.spot_id IS NOT NULL AND i.deleted_at IS NULL
           AND i.status NOT IN ('archived','dropped')`,
      )
      .all(ctx.libraryId) as { id: string }[];
    let computed = 0;
    for (const row of rows) {
      await computeWindowsForInspiration(row.id, { days });
      computed += 1;
    }
    ok(res, { cards: computed, days });
  }),
);

timingRouter.get(
  '/spots/:id/windows',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT i.id FROM inspiration i WHERE i.spot_id = ? AND i.library_id = ? AND i.deleted_at IS NULL`,
      )
      .all(req.params.id, ctx.libraryId) as { id: string }[];
    const items = [];
    for (const row of rows) items.push(...listWindows(row.id));
    ok(res, { items: items.sort((a, b) => (a.startAt < b.startAt ? -1 : 1)) });
  }),
);
