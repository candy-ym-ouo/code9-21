/**
 * 天文计算（自研，无三方依赖）—— 见文档第 12 章。
 *
 * 提供：太阳位置（仰角/方位角）、日出日落、黄金/蓝调时刻、夜间、时间锚解析、
 * 以及窗口内的逐点采样。所有角度单位为「度」，方位角以正北为 0、顺时针增加。
 */

import {
  addMinutes,
  localDayRangeUtc,
  minutesBetween,
  parseLocalDateKey,
  zonedTimeToUtc,
  utcToZonedParts,
} from './time.js';
import { angleDiff, angleWithin } from './geometry.js';
import type { TimingDto } from './types.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 太阳上缘触地平线（含大气折射与太阳半径） */
export const HORIZON_DEG = -0.833;
export const GOLDEN_UPPER_DEG = 6;
export const GOLDEN_LOWER_DEG = -4;
export const BLUE_LOWER_DEG = -6;
export const NIGHT_DEG = -12;

export interface SolarPosition {
  elevationDeg: number;
  azimuthDeg: number;
  declinationDeg: number;
  hourAngleDeg: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** NOAA 简化太阳位置算法，精度足够支撑本项目的窗口判定（误差 < 0.02°）。 */
export function solarPosition(date: Date, lat: number, lng: number): SolarPosition {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;

  const meanLon = (280.46 + 0.9856474 * n) % 360;
  const meanAnom = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon));
  const declination = Math.asin(clamp(Math.sin(obliquity) * Math.sin(eclLon), -1, 1));

  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const lst = gmst + lng;
  const hourAngle = ((((lst - rightAscension * RAD) % 360) + 540) % 360) - 180;

  const phi = lat * DEG;
  const sinAlt =
    Math.sin(phi) * Math.sin(declination) +
    Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle * DEG);
  const elevation = Math.asin(clamp(sinAlt, -1, 1));
  const az = Math.atan2(
    Math.sin(hourAngle * DEG),
    Math.cos(hourAngle * DEG) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi),
  );
  const azimuth = (((az * RAD + 180) % 360) + 360) % 360;

  return {
    elevationDeg: elevation * RAD,
    azimuthDeg: azimuth,
    declinationDeg: declination * RAD,
    hourAngleDeg: hourAngle,
  };
}

export function elevationAt(date: Date, lat: number, lng: number): number {
  return solarPosition(date, lat, lng).elevationDeg;
}

export function azimuthAt(date: Date, lat: number, lng: number): number {
  return solarPosition(date, lat, lng).azimuthDeg;
}

/** 太阳过中天（正午）的 UTC 时刻；用小时角迭代收敛。 */
export function solarNoonUtc(lat: number, lng: number, reference: Date): Date {
  let t = reference.getTime() + (12 - lng / 15) * 3600000;
  for (let i = 0; i < 5; i += 1) {
    const { hourAngleDeg } = solarPosition(new Date(t), lat, lng);
    t -= (hourAngleDeg / 15) * 3600000;
    if (Math.abs(hourAngleDeg) < 0.0005) break;
  }
  return new Date(t);
}

export interface Crossing {
  time: Date;
  /** true = 由下向上穿过阈值（上升） */
  rising: boolean;
}

/** 在 [from, to) 区间内找太阳仰角穿过 threshold 的时刻（先粗扫再二分）。 */
export function findElevationCrossings(
  lat: number,
  lng: number,
  from: Date,
  to: Date,
  thresholdDeg: number,
  stepMin = 4,
): Crossing[] {
  const out: Crossing[] = [];
  const step = stepMin * 60000;
  let prevT = from.getTime();
  let prevF = elevationAt(new Date(prevT), lat, lng) - thresholdDeg;

  for (let t = prevT + step; t <= to.getTime(); t += step) {
    const f = elevationAt(new Date(t), lat, lng) - thresholdDeg;
    if ((prevF < 0 && f >= 0) || (prevF > 0 && f <= 0)) {
      let lo = prevT;
      let hi = t;
      let fLo = prevF;
      for (let i = 0; i < 26; i += 1) {
        const mid = (lo + hi) / 2;
        const fMid = elevationAt(new Date(mid), lat, lng) - thresholdDeg;
        if ((fMid < 0 && fLo < 0) || (fMid > 0 && fLo > 0)) {
          lo = mid;
          fLo = fMid;
        } else {
          hi = mid;
        }
      }
      out.push({ time: new Date((lo + hi) / 2), rising: prevF < 0 });
    }
    prevT = t;
    prevF = f;
  }
  return out;
}

export interface SunEvents {
  date: string;
  tz: string;
  solarNoon: Date;
  maxElevationDeg: number;
  sunrise: Date | null;
  sunset: Date | null;
  goldenAm: { start: Date; end: Date } | null;
  goldenPm: { start: Date; end: Date } | null;
  blueAm: { start: Date; end: Date } | null;
  bluePm: { start: Date; end: Date } | null;
  nightStart: Date | null;
  nightEnd: Date | null;
  polar: 'none' | 'midnight_sun' | 'polar_night';
  notes: string[];
}

function pickCrossing(
  list: Crossing[],
  opts: { rising?: boolean; after?: Date; before?: Date } = {},
): Crossing | null {
  const filtered = list.filter((c) => {
    if (opts.rising !== undefined && c.rising !== opts.rising) return false;
    if (opts.after && c.time.getTime() < opts.after.getTime()) return false;
    if (opts.before && c.time.getTime() > opts.before.getTime()) return false;
    return true;
  });
  return filtered[0] ?? null;
}

/**
 * 计算某地某「本地日期」的全部太阳事件。
 * 扫描范围向两侧各外扩 3 小时，避免凌晨/深夜事件被日界切断。
 */
export function sunEvents(lat: number, lng: number, tz: string, localDate: string): SunEvents {
  const { year, month, day } = parseLocalDateKey(localDate);
  const dayRange = localDayRangeUtc(localDate, tz);
  const scanFrom = addMinutes(dayRange.start, -180);
  const scanTo = addMinutes(dayRange.end, 180);
  const notes: string[] = [];

  const noonRef = zonedTimeToUtc(tz, year, month, day, 12, 0);
  const solarNoon = solarNoonUtc(lat, lng, noonRef);
  const maxElevationDeg = elevationAt(solarNoon, lat, lng);

  const cHorizon = findElevationCrossings(lat, lng, scanFrom, scanTo, HORIZON_DEG);
  const cGoldenUp = findElevationCrossings(lat, lng, scanFrom, scanTo, GOLDEN_UPPER_DEG);
  const cGoldenLow = findElevationCrossings(lat, lng, scanFrom, scanTo, GOLDEN_LOWER_DEG);
  const cBlueLow = findElevationCrossings(lat, lng, scanFrom, scanTo, BLUE_LOWER_DEG);
  const cNight = findElevationCrossings(lat, lng, scanFrom, scanTo, NIGHT_DEG);

  const sunriseC = pickCrossing(cHorizon, { rising: true });
  const sunsetC = [...cHorizon].reverse().find((c) => !c.rising) ?? null;

  const polar: SunEvents['polar'] =
    maxElevationDeg < HORIZON_DEG ? 'polar_night' : sunriseC && sunsetC ? 'none' : 'midnight_sun';

  if (polar === 'midnight_sun') notes.push('该日太阳未落（极昼），无日出/日落锚点');
  if (polar === 'polar_night') notes.push('该日太阳未升（极夜），无日出/日落锚点');

  const goldenAmStart = sunriseC
    ? findElevationCrossings(lat, lng, addMinutes(sunriseC.time, -120), addMinutes(sunriseC.time, 240), GOLDEN_LOWER_DEG).find((c) => c.rising)
    : pickCrossing(cGoldenLow, { rising: true });
  const goldenAmEnd = sunriseC
    ? findElevationCrossings(lat, lng, addMinutes(sunriseC.time, -120), addMinutes(sunriseC.time, 300), GOLDEN_UPPER_DEG).find((c) => c.rising)
    : pickCrossing(cGoldenUp, { rising: true });

  const goldenPmStart = sunsetC
    ? [...findElevationCrossings(lat, lng, addMinutes(sunsetC.time, -300), addMinutes(sunsetC.time, 120), GOLDEN_UPPER_DEG)].reverse().find((c) => !c.rising)
    : null;
  const goldenPmEnd = sunsetC
    ? [...findElevationCrossings(lat, lng, addMinutes(sunsetC.time, -240), addMinutes(sunsetC.time, 120), GOLDEN_LOWER_DEG)].reverse().find((c) => !c.rising)
    : null;

  const blueAmStart = sunriseC
    ? findElevationCrossings(lat, lng, addMinutes(sunriseC.time, -180), addMinutes(sunriseC.time, 180), BLUE_LOWER_DEG).find((c) => c.rising)
    : null;
  const bluePmEnd = sunsetC
    ? [...findElevationCrossings(lat, lng, addMinutes(sunsetC.time, -180), addMinutes(sunsetC.time, 180), BLUE_LOWER_DEG)].reverse().find((c) => !c.rising)
    : null;

  const nightStart = sunsetC
    ? [...cNight].reverse().find((c) => !c.rising && c.time.getTime() >= sunsetC.time.getTime() - 3600000) ?? null
    : null;
  const nightEnd = sunriseC
    ? cNight.find((c) => c.rising && c.time.getTime() >= sunriseC.time.getTime() - 3600000) ?? null
    : null;

  const band = (a: Crossing | null | undefined, b: Crossing | null | undefined) =>
    a && b && b.time.getTime() > a.time.getTime() ? { start: a.time, end: b.time } : null;

  return {
    date: localDate,
    tz,
    solarNoon,
    maxElevationDeg,
    sunrise: sunriseC?.time ?? null,
    sunset: sunsetC?.time ?? null,
    goldenAm: band(goldenAmStart, goldenAmEnd),
    goldenPm: band(goldenPmStart, goldenPmEnd),
    blueAm: band(blueAmStart, goldenAmStart),
    bluePm: band(goldenPmEnd, bluePmEnd),
    nightStart: nightStart?.time ?? null,
    nightEnd: nightEnd?.time ?? null,
    polar,
    notes,
  };
}

export interface AnchorResolution {
  anchorAt: Date;
  /** 锚点自带的仰角区间；无则为 null */
  elevationRange: [number, number] | null;
  /** 锚点自带的时间范围（黄金/蓝调/夜间）；无则为 null */
  band: { start: Date; end: Date } | null;
  notes: string[];
}

/**
 * 把时间锚解析成绝对时刻（见文档 12.2）。
 * 返回 null 表示该日期/纬度下锚点无解（极昼极夜、日出前偏移越界等）。
 */
export function resolveAnchor(
  events: SunEvents,
  timing: Pick<TimingDto, 'timeAnchor' | 'anchorOffsetMin'>,
): AnchorResolution | null {
  const notes: string[] = [];
  const { timeAnchor, anchorOffsetMin } = timing;

  const needSun = (base: Date | null): Date | null => {
    if (!base) notes.push('该日无日出/日落事件，锚点无解');
    return base;
  };

  switch (timeAnchor) {
    case 'sunrise': {
      const base = needSun(events.sunrise);
      return base ? { anchorAt: base, elevationRange: null, band: null, notes } : null;
    }
    case 'sunset': {
      const base = needSun(events.sunset);
      return base ? { anchorAt: base, elevationRange: null, band: null, notes } : null;
    }
    case 'sunrise_plus': {
      const base = needSun(events.sunrise);
      return base
        ? { anchorAt: addMinutes(base, anchorOffsetMin), elevationRange: null, band: null, notes }
        : null;
    }
    case 'sunset_minus': {
      const base = needSun(events.sunset);
      return base
        ? { anchorAt: addMinutes(base, -Math.abs(anchorOffsetMin)), elevationRange: null, band: null, notes }
        : null;
    }
    case 'golden_am': {
      if (!events.goldenAm) {
        notes.push('该日无黄金时刻（晨）');
        return null;
      }
      return {
        anchorAt: events.goldenAm.start,
        elevationRange: [GOLDEN_LOWER_DEG, GOLDEN_UPPER_DEG],
        band: events.goldenAm,
        notes,
      };
    }
    case 'golden_pm': {
      if (!events.goldenPm) {
        notes.push('该日无黄金时刻（昏）');
        return null;
      }
      return {
        anchorAt: events.goldenPm.end,
        elevationRange: [GOLDEN_LOWER_DEG, GOLDEN_UPPER_DEG],
        band: events.goldenPm,
        notes,
      };
    }
    case 'blue_am': {
      if (!events.blueAm) {
        notes.push('该日无蓝调时刻（晨）');
        return null;
      }
      return {
        anchorAt: events.blueAm.start,
        elevationRange: [BLUE_LOWER_DEG, GOLDEN_LOWER_DEG],
        band: events.blueAm,
        notes,
      };
    }
    case 'blue_pm': {
      if (!events.bluePm) {
        notes.push('该日无蓝调时刻（昏）');
        return null;
      }
      return {
        anchorAt: events.bluePm.end,
        elevationRange: [BLUE_LOWER_DEG, GOLDEN_LOWER_DEG],
        band: events.bluePm,
        notes,
      };
    }
    case 'solar_noon': {
      return { anchorAt: events.solarNoon, elevationRange: null, band: null, notes };
    }
    case 'night': {
      if (!events.nightStart) {
        notes.push('该日无夜间时段（极昼）');
        return null;
      }
      const end = events.nightEnd ?? addMinutes(events.nightStart, 240);
      const capped = end.getTime() - events.nightStart.getTime() > 240 * 60000;
      if (capped) notes.push('夜间窗口过长，已截取前 240 分钟');
      return {
        anchorAt: events.nightStart,
        elevationRange: [-90, NIGHT_DEG],
        band: { start: events.nightStart, end: capped ? addMinutes(events.nightStart, 240) : end },
        notes,
      };
    }
    case 'fixed_clock': {
      const p = utcToZonedParts(events.solarNoon, events.tz);
      const hour = Math.floor(anchorOffsetMin / 60);
      const minute = Math.round(anchorOffsetMin % 60);
      const at = zonedTimeToUtc(events.tz, p.year, p.month, p.day, hour, minute);
      return { anchorAt: at, elevationRange: null, band: null, notes };
    }
    default:
      return null;
  }
}

export interface WindowSample {
  at: Date;
  elevationDeg: number;
  azimuthDeg: number;
}

/** 对时间区间做等距采样，供方位角约束求交与理由输出使用。 */
export function sampleWindow(
  lat: number,
  lng: number,
  start: Date,
  end: Date,
  stepMin = 2,
): WindowSample[] {
  const out: WindowSample[] = [];
  const step = stepMin * 60000;
  for (let t = start.getTime(); t <= end.getTime(); t += step) {
    const d = new Date(t);
    const p = solarPosition(d, lat, lng);
    out.push({ at: d, elevationDeg: p.elevationDeg, azimuthDeg: p.azimuthDeg });
  }
  const last = new Date(end.getTime());
  if (out.length === 0 || out[out.length - 1].at.getTime() !== last.getTime()) {
    const p = solarPosition(last, lat, lng);
    out.push({ at: last, elevationDeg: p.elevationDeg, azimuthDeg: p.azimuthDeg });
  }
  return out;
}

/** 一年中"该条件理论可成立"的天数（只看天文与季节，不含天气），见 12.5。 */
export function theoreticalDaysInYear(
  lat: number,
  lng: number,
  tz: string,
  timing: Pick<
    TimingDto,
    | 'timeAnchor'
    | 'anchorOffsetMin'
    | 'elevationRange'
    | 'azimuthRange'
    | 'azimuthTolerance'
    | 'seasonWindow'
    | 'windowToleranceMin'
  >,
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

export function theoreticalOkForDay(
  lat: number,
  lng: number,
  tz: string,
  date: string,
  timing: Pick<
    TimingDto,
    | 'timeAnchor'
    | 'anchorOffsetMin'
    | 'elevationRange'
    | 'azimuthRange'
    | 'azimuthTolerance'
    | 'seasonWindow'
    | 'windowToleranceMin'
  >,
): boolean {
  if (timing.seasonWindow) {
    const { month } = parseLocalDateKey(date);
    const { fromMonth, toMonth } = timing.seasonWindow;
    const inSeason =
      fromMonth <= toMonth ? month >= fromMonth && month <= toMonth : month >= fromMonth || month <= toMonth;
    if (!inSeason) return false;
  }
  const events = sunEvents(lat, lng, tz, date);
  const resolved = resolveAnchor(events, timing);
  if (!resolved) return false;
  const [start, end] = bandToRange(resolved, timing);
  const samples = sampleWindow(lat, lng, start, end, 5);
  const usable = samples.filter((s) => elevationInRange(s.elevationDeg, timing.elevationRange));
  if (usable.length < 2) return false;
  if (!timing.azimuthRange) return true;
  const [azLo, azHi] = timing.azimuthRange;
  const center = (azLo + azHi) / 2;
  return usable.some((s) => angularDistance(s.azimuthDeg, center) <= timing.azimuthTolerance + 0.001);
}

export function elevationInRange(elevationDeg: number, range: number[]): boolean {
  if (!Array.isArray(range) || range.length !== 2) return true;
  return elevationDeg >= range[0] - 0.05 && elevationDeg <= range[1] + 0.05;
}

/**
 * 环形角距 —— 旧接口名，保留以兼容历史调用与回放；
 * 新代码请直接使用 geometry.ts 的 angleDiff / angleWithin（全项目唯二方位口径）。
 */
export const angularDistance = angleDiff;

/** 把锚点解析结果变成用于判定的 [start, end] 区间 */
export function bandToRange(
  resolved: AnchorResolution,
  timing: Pick<TimingDto, 'windowToleranceMin'>,
): [Date, Date] {
  if (resolved.band) return [resolved.band.start, resolved.band.end];
  const tol = Math.max(1, timing.windowToleranceMin ?? 12);
  return [addMinutes(resolved.anchorAt, -tol), addMinutes(resolved.anchorAt, tol)];
}
