/**
 * 时区工具：不依赖任何三方库，用 Intl 做 UTC ↔ 指定 IANA 时区的换算。
 * 全部按机位所在时区计算（见文档 7.4 运行时边界）。
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 相对 UTC 的分钟偏移（东为正） */
  offsetMinutes: number;
}

export function utcToZonedParts(date: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') % 24;
  const minute = get('minute');
  const second = get('second');
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((asUTC - date.getTime()) / 60000);
  return { year, month, day, hour, minute, second, offsetMinutes };
}

export function tzOffsetMinutes(date: Date, tz: string): number {
  return utcToZonedParts(date, tz).offsetMinutes;
}

/** 把"某时区的墙上时间"转成 UTC 时刻（两遍法，兼容夏令时） */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let ts = guess - offset * 60000;
  offset = tzOffsetMinutes(new Date(ts), tz);
  ts = guess - offset * 60000;
  return new Date(ts);
}

export function localDateKey(date: Date, tz: string): string {
  const p = utcToZonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function parseLocalDateKey(key: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`日期格式应为 YYYY-MM-DD：${key}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function addDaysToKey(key: string, days: number): string {
  const { year, month, day } = parseLocalDateKey(key);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** 某时区某一天的起止 UTC 时刻 [start, end) */
export function localDayRangeUtc(key: string, tz: string): { start: Date; end: Date } {
  const { year, month, day } = parseLocalDateKey(key);
  return {
    start: zonedTimeToUtc(tz, year, month, day, 0, 0),
    end: zonedTimeToUtc(tz, year, month, day + 1, 0, 0),
  };
}

export function formatLocal(date: Date, tz: string, withDate = false): string {
  const p = utcToZonedParts(date, tz);
  const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  if (!withDate) return hm;
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${hm}`;
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60000;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000);
}

/**
 * 两个方位角之间的最短夹角（度，0..180）。
 * 方位角唯一口径：正北为 0、顺时针增加；所有光位/朝向比较都必须走这里。
 */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360); // 0..360
  return d > 180 ? 360 - d : d;
}

export function parseQuietHours(spec: string): { startMin: number; endMin: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return { startMin: 22 * 60, endMin: 7 * 60 };
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

export function inQuietHours(date: Date, tz: string, spec: string): boolean {
  const { startMin, endMin } = parseQuietHours(spec);
  const p = utcToZonedParts(date, tz);
  const now = p.hour * 60 + p.minute;
  if (startMin <= endMin) return now >= startMin && now < endMin;
  return now >= startMin || now < endMin;
}
