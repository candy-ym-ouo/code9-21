/**
 * 窗口计算的口径与纯判定（唯一事实源）—— 见文档 12.4。
 *
 * 本文件**不碰数据库/网络/配置**：给定点位、拍摄条件、日期与逐小时预报，
 * 就能确定性地产出单日判定（verdict + 可复算 reasons + 天文/天气中间值）。
 * server 的 windowEngine 只负责取数、落库与重放编排。
 *
 * 这里的每一步都是既有 windowEngine.computeDay 的原样迁移；
 * 调任何阈值/采样/边界条件都会改变历史判定，禁止擅动。
 */

import {
  angularDistance,
  bandToRange,
  elevationInRange,
  sampleWindow,
  solarPosition,
  sunEvents,
  resolveAnchor,
} from './astro.js';
import { formatLocal, parseLocalDateKey } from './time.js';
import {
  aggregateEpisode,
  isNightByElevation,
  applyWeatherProfile,
  type HourlyWeatherSample,
  type WeatherEpisode,
} from './weather.js';
import type { TimingDto, WindowReasonDto } from './types.js';
import type { WindowVerdict } from './enums.js';

/** 点位几何与时区（DB 行的纯数据投影，避免判定函数依赖 server 类型） */
export interface WindowSite {
  lat: number;
  lng: number;
  tz: string;
}

/** 采样点之间超过该间隔即视为窗口断裂（分钟） */
export const CONTIGUOUS_GAP_MIN = 6;
/** 少于该时长（分钟）的可用窗口降为 marginal */
export const MIN_WINDOW_DURATION_MIN = 5;
/** 单日采样点上限（步长据此反推，控制计算量） */
export const MAX_SAMPLES_PER_DAY = 300;
/** 理论可满足性检查的采样步长（分钟） */
export const THEORETICAL_SAMPLE_STEP_MIN = 5;

export interface DayWindowResult {
  date: string;
  startAt: Date;
  endAt: Date;
  anchorAt: Date;
  sunElevation: number | null;
  sunAzimuth: number | null;
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  episode: WeatherEpisode;
}

export interface WindowSamplePoint {
  at: Date;
  elevationDeg: number;
  azimuthDeg: number;
}

/** 找出满足条件的最长连续时间段（间隔 > CONTIGUOUS_GAP_MIN 即断裂） */
export function longestContiguousRun(
  samples: { at: Date; ok: boolean }[],
): { start: Date; end: Date } | null {
  let best: { start: Date; end: Date } | null = null;
  let runStart: Date | null = null;
  let prevAt: Date | null = null;

  const consider = (candidate: { start: Date; end: Date }) => {
    if (
      !best ||
      candidate.end.getTime() - candidate.start.getTime() > best.end.getTime() - best.start.getTime()
    ) {
      best = candidate;
    }
  };

  for (const s of samples) {
    if (s.ok) {
      if (!runStart) runStart = s.at;
      else if (prevAt && (s.at.getTime() - prevAt.getTime()) / 60000 > CONTIGUOUS_GAP_MIN) {
        consider({ start: runStart, end: prevAt });
        runStart = s.at;
      }
      prevAt = s.at;
    } else if (runStart && prevAt) {
      consider({ start: runStart, end: prevAt });
      runStart = null;
      prevAt = null;
    }
  }
  if (runStart && prevAt) consider({ start: runStart, end: prevAt });
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

/** 季节窗口是否覆盖某月（fromMonth > toMonth 表示跨年，如 11–2 月） */
export function monthInSeason(month: number, season: { fromMonth: number; toMonth: number }): boolean {
  const { fromMonth, toMonth } = season;
  return fromMonth <= toMonth
    ? month >= fromMonth && month <= toMonth
    : month >= fromMonth || month <= toMonth;
}

type TheoreticalTiming = Pick<
  TimingDto,
  | 'timeAnchor'
  | 'anchorOffsetMin'
  | 'elevationRange'
  | 'azimuthRange'
  | 'azimuthTolerance'
  | 'seasonWindow'
  | 'windowToleranceMin'
>;

/**
 * 单日"理论可成立"（只看天文与季节，不含天气），见 12.5。
 * 与 decideDayWindow 共用同一套天文口径（锚点自带仰角、方位角命中、季节）。
 */
export function theoreticalOkForDay(
  lat: number,
  lng: number,
  tz: string,
  date: string,
  timing: TheoreticalTiming,
): boolean {
  return astronomyFeasibleForDay({ lat, lng, tz }, timing as TimingDto, date);
}

/** 一年中"该条件理论可成立"的天数（只看天文与季节，不含天气），见 12.5。 */
export function theoreticalDaysInYear(
  lat: number,
  lng: number,
  tz: string,
  timing: TheoreticalTiming,
  year: number,
): { date: string; ok: boolean }[] {
  const out: { date: string; ok: boolean }[] = [];
  const start = new Date(Date.UTC(year, 0, 1));
  for (let i = 0; i < 366; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getUTCFullYear() !== year) break;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
    out.push({ date: key, ok: theoreticalOkForDay(lat, lng, tz, key, timing) });
  }
  return out;
}

/**
 * 仅做天文/季节可行性（不含天气、不产出理由）。
 * 这是 computeDay 与年度理论日历的**共同口径**：
 * 锚点自带仰角区间（黄金/蓝调/夜间）优先生效；方位角按连续命中口径。
 */
export function astronomyFeasibleForDay(
  site: WindowSite,
  timing: TimingDto,
  dateKey: string,
): boolean {
  if (timing.seasonWindow) {
    const { month } = parseLocalDateKey(dateKey);
    if (!monthInSeason(month, timing.seasonWindow)) return false;
  }
  const events = sunEvents(site.lat, site.lng, site.tz, dateKey);
  const resolved = resolveAnchor(events, timing);
  if (!resolved) return false;
  const effectiveElevation = resolved.elevationRange ?? timing.elevationRange;
  const [start, end] = bandToRange(resolved, timing);
  const samples = sampleWindow(site.lat, site.lng, start, end, THEORETICAL_SAMPLE_STEP_MIN);
  const usable = samples.filter((s) => elevationInRange(s.elevationDeg, effectiveElevation));
  if (usable.length < 2) return false;
  if (!timing.azimuthRange) return true;
  return markAstronomySamples(usable, effectiveElevation, timing).filter((s) => s.ok).length >= 2;
}

/** 给采样点打上"仰角（+方位角）是否命中"标记，computeDay 的唯一口径 */
export function markAstronomySamples(
  samples: WindowSamplePoint[],
  effectiveElevation: number[],
  timing: Pick<TimingDto, 'azimuthRange' | 'azimuthTolerance'>,
): { at: Date; ok: boolean }[] {
  if (!timing.azimuthRange) {
    return samples.map((s) => ({ ...s, ok: elevationInRange(s.elevationDeg, effectiveElevation) }));
  }
  const [azLo, azHi] = timing.azimuthRange;
  const center = (azLo + azHi) / 2;
  const tol = timing.azimuthTolerance;
  return samples.map((s) => ({
    ...s,
    ok:
      elevationInRange(s.elevationDeg, effectiveElevation) &&
      angularDistance(s.azimuthDeg, center) <= tol,
  }));
}

/**
 * 判定单日窗口（文档 12.4 的算法，逐项产出 reasons）。
 *
 * @param forecast 该点位的逐小时预报（UTC）；传 [] 表示天气源不可用 → 降级判定
 * @param provider 天气提供方标识，仅写入 episode.provider，不参与判定
 */
export function decideDayWindow(
  site: WindowSite,
  timing: TimingDto,
  dateKey: string,
  forecast: HourlyWeatherSample[],
  provider: string | null,
): DayWindowResult {
  const reasons: WindowReasonDto[] = [];
  const tz = site.tz;
  const events = sunEvents(site.lat, site.lng, tz, dateKey);
  events.notes.forEach((n) => reasons.push({ code: 'SUN_EVENT_NOTE', level: 'info', text: n }));

  // ---- 季节窗口 ----
  if (timing.seasonWindow) {
    const { month } = parseLocalDateKey(dateKey);
    if (!monthInSeason(month, timing.seasonWindow)) {
      const { fromMonth, toMonth } = timing.seasonWindow;
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
        episode: aggregateEpisode([], events.solarNoon, events.solarNoon, provider),
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
      episode: aggregateEpisode([], events.solarNoon, events.solarNoon, provider),
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

  const spanMin = Math.max(1, (bandEnd.getTime() - bandStart.getTime()) / 60000);
  const stepMin = Math.max(1, Math.ceil(spanMin / MAX_SAMPLES_PER_DAY)); // 最多 300 个采样点
  const samples = sampleWindow(site.lat, site.lng, bandStart, bandEnd, stepMin);

  const elevOk = samples.filter((s) => elevationInRange(s.elevationDeg, effectiveElevation));
  if (elevOk.length < 2) {
    const p = solarPosition(resolved.anchorAt, site.lat, site.lng);
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
      episode: aggregateEpisode(forecast, bandStart, bandEnd, provider),
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
  let candidateSamples = markAstronomySamples(samples, effectiveElevation, timing);
  if (timing.azimuthRange) {
    const [azLo, azHi] = timing.azimuthRange;
    const tol = timing.azimuthTolerance;
    const azOk = samples.filter(
      (s) =>
        elevationInRange(s.elevationDeg, effectiveElevation) &&
        angularDistance(s.azimuthDeg, (azLo + azHi) / 2) <= tol,
    );
    if (azOk.length < 2) {
      const p = solarPosition(resolved.anchorAt, site.lat, site.lng);
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
        episode: aggregateEpisode(forecast, bandStart, bandEnd, provider),
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

  const run = longestContiguousRun(candidateSamples);
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
      episode: aggregateEpisode(forecast, bandStart, bandEnd, provider),
    };
  }

  const durationMin = (run.end.getTime() - run.start.getTime()) / 60000 + stepMin;
  let verdict: WindowVerdict = 'good';
  if (durationMin < MIN_WINDOW_DURATION_MIN) {
    verdict = 'marginal';
    reasons.push({
      code: 'WINDOW_TOO_SHORT',
      level: 'warn',
      text: `可用窗口仅约 ${durationMin.toFixed(0)} 分钟（少于 ${MIN_WINDOW_DURATION_MIN} 分钟）`,
    });
  }
  reasons.push({
    code: 'WINDOW_RANGE',
    level: 'ok',
    text: `窗口 ${formatLocal(run.start, tz)}–${formatLocal(run.end, tz)}（约 ${durationMin.toFixed(0)} 分钟）`,
  });

  const mid = new Date((run.start.getTime() + run.end.getTime()) / 2);
  const midPos = solarPosition(mid, site.lat, site.lng);

  // ---- 3) 天气项（applyWeatherProfile 会就地追加 reasons，并返回可能被降级的 verdict）----
  const episode = aggregateEpisode(forecast, run.start, run.end, provider);
  const weatherState = applyWeatherProfile(
    timing.weatherProfile,
    episode,
    isNightByElevation(midPos.elevationDeg),
    { verdict, reasons },
  );
  verdict = weatherState.verdict;

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
