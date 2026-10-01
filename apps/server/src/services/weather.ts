import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { distanceKm } from '@flil/shared';
import {
  climateAt,
  type ClimateStat,
  type EpisodeWeather,
  type HourlyForecast,
} from '@flil/shared';

// 气象的数值口径（类型/聚合/现象判定/阈值）全部来自 @flil/shared，
// 保证「未来窗口计算」与「历史窗口回放」走同一套纯函数。
export type { HourlyForecast, EpisodeWeather, ClimateStat };
export { climateAt };

// ---------------------------------------------------------------- providers

async function fetchOpenMeteo(lat: number, lng: number, days: number): Promise<HourlyForecast[]> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lng.toFixed(4));
  url.searchParams.set(
    'hourly',
    'cloud_cover,precipitation_probability,precipitation,visibility,wind_speed_10m,temperature_2m,relative_humidity_2m,snowfall',
  );
  url.searchParams.set('forecast_days', String(Math.min(16, Math.max(2, days + 1))));
  url.searchParams.set('timezone', 'UTC');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`天气接口返回 ${res.status}`);
    const body = (await res.json()) as {
      hourly: Record<string, (number | null)[] | string[]>;
    };
    const h = body.hourly;
    const times = h.time as string[];
    const pick = (key: string, i: number) => {
      const arr = h[key] as (number | null)[] | undefined;
      return arr?.[i] ?? null;
    };
    return times.map((t, i) => ({
      time: new Date(`${t}:00Z`).toISOString(),
      cloudCoverPct: pick('cloud_cover', i),
      precipProbPct: pick('precipitation_probability', i),
      precipMm: pick('precipitation', i),
      visibilityKm: pick('visibility', i) === null ? null : (pick('visibility', i) as number) / 1000,
      windSpeedMs: pick('wind_speed_10m', i),
      tempC: pick('temperature_2m', i),
      humidityPct: pick('relative_humidity_2m', i),
      snowfallCm: pick('snowfall', i),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fixture 天气源：**只用于自动化测试**，按 (日期, 坐标) 做确定性伪随机，
 * 保证测试不依赖外网，且同一天气场景可复现。
 */
function fetchFixture(lat: number, lng: number, days: number): HourlyForecast[] {
  const out: HourlyForecast[] = [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const seed = Math.abs(Math.round(lat * 100) * 7919 + Math.round(lng * 100) * 104729);
  for (let d = 0; d < days + 1; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const t = new Date(start.getTime() + (d * 24 + h) * 3600000);
      // 每 3 天一轮天气：晴 → 薄云 → 阴雨
      const cycle = (d + Math.floor(seed / 1000)) % 3;
      const wave = Math.sin(((h - 6) / 24) * Math.PI * 2);
      out.push({
        time: t.toISOString(),
        cloudCoverPct: cycle === 0 ? 15 + 5 * wave : cycle === 1 ? 45 + 10 * wave : 88,
        precipProbPct: cycle === 2 && h >= 12 ? 70 : cycle === 1 ? 20 : 5,
        precipMm: cycle === 2 && h >= 12 ? 1.4 : 0,
        visibilityKm: cycle === 2 ? 6 : 20,
        windSpeedMs: 2.5 + Math.abs(wave) * 2,
        tempC: 18 + 6 * wave,
        humidityPct: cycle === 2 ? 88 : cycle === 1 ? 65 : 45,
        snowfallCm: 0,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ 对外接口

function cacheKey(lat: number, lng: number, days: number): string {
  return `${config.weatherProvider}:${lat.toFixed(2)}:${lng.toFixed(2)}:${days}`;
}

function readCache(key: string): HourlyForecast[] | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT payload, fetched_at FROM weather_cache WHERE cache_key = ?').get(key) as
      | { payload: string; fetched_at: string }
      | undefined;
    if (!row) return null;
    const ageMin = (Date.now() - new Date(row.fetched_at).getTime()) / 60000;
    if (ageMin > config.weatherCacheTtlMin) return null;
    return parseJson<HourlyForecast[]>(row.payload, []);
  } catch {
    return null;
  }
}

function writeCache(key: string, forecast: HourlyForecast[]): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO weather_cache (id, cache_key, payload, fetched_at) VALUES (?,?,?,?)
         ON CONFLICT (cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(newId(), key, toJson(forecast), nowIso());
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

export async function getForecast(lat: number, lng: number, days: number): Promise<HourlyForecast[]> {
  if (config.weatherProvider === 'off') return [];
  const key = cacheKey(lat, lng, days);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const forecast =
      config.weatherProvider === 'fixture'
        ? fetchFixture(lat, lng, days)
        : await fetchOpenMeteo(lat, lng, days);
    if (forecast.length) writeCache(key, forecast);
    return forecast;
  } catch (err) {
    logger.warn('天气源不可用，进入降级模式', { error: String(err), provider: config.weatherProvider });
    return [];
  }
}

// ------------------------------------------------------- 气候基线（文档 12.5）

/**
 * 用 Open-Meteo 历史接口（过去 5 年同期）统计气候基线。
 * 这是**尽力而为**的能力：失败或未启用时返回空数组，年度日历退化为"仅理论天数"。
 */
export async function climateStats(lat: number, lng: number, month: number): Promise<ClimateStat[]> {
  if (!config.climateBaselineEnabled || config.weatherProvider === 'off') return [];
  const key = `climate:${lat.toFixed(1)}:${lng.toFixed(1)}:${month}`;
  try {
    const db = getDb();
    const row = db.prepare('SELECT payload, fetched_at FROM climate_cache WHERE cache_key = ?').get(key) as
      | { payload: string; fetched_at: string }
      | undefined;
    if (row) {
      const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / 86400000;
      if (ageDays < 30) return parseJson<ClimateStat[]>(row.payload, []);
    }
  } catch {
    /* 继续走网络请求 */
  }

  const year = new Date().getUTCFullYear();
  const startDate = `${year - 5}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year - 1}-${String(month).padStart(2, '0')}-28`;
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', lat.toFixed(3));
  url.searchParams.set('longitude', lng.toFixed(3));
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('hourly', 'cloud_cover,precipitation');
  url.searchParams.set('timezone', 'UTC');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`archive 返回 ${res.status}`);
    const body = (await res.json()) as { hourly: { time: string[]; cloud_cover: number[]; precipitation: number[] } };
    const acc = new Map<string, { cloud: number; precipHours: number; n: number }>();
    body.hourly.time.forEach((t, i) => {
      const h = new Date(`${t}:00Z`).getUTCHours();
      const k = String(h);
      const e = acc.get(k) ?? { cloud: 0, precipHours: 0, n: 0 };
      e.cloud += body.hourly.cloud_cover[i] ?? 0;
      if ((body.hourly.precipitation[i] ?? 0) > 0.1) e.precipHours += 1;
      e.n += 1;
      acc.set(k, e);
    });
    const stats: ClimateStat[] = [...acc.entries()].map(([h, e]) => ({
      month,
      hour: Number(h),
      meanCloudCoverPct: e.n ? e.cloud / e.n : 0,
      precipHourRatio: e.n ? e.precipHours / e.n : 0,
      samples: e.n,
    }));
    try {
      getDb()
        .prepare(
          `INSERT INTO climate_cache (id, cache_key, payload, fetched_at) VALUES (?,?,?,?)
           ON CONFLICT (cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
        )
        .run(newId(), key, toJson(stats), nowIso());
    } catch {
      /* 忽略缓存写入失败 */
    }
    return stats;
  } catch (err) {
    logger.warn('气候基线获取失败（年度日历将退化为仅理论天数）', { error: String(err) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export { distanceKm };
