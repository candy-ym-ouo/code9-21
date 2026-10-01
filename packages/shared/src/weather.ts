/**
 * 气象口径（全项目唯一）—— 见文档 12.4。
 *
 * 这里只放**纯函数与常量**：逐小时预报类型、窗口天气聚合（summarizeEpisode）、
 * 特殊现象判定（phenomenonHolds）。不读网络、不读库、不读环境变量，
 * 因此可以在前后端、测试与历史窗口回放中复用同一套数值口径。
 *
 * provider 名称由调用方注入（回放历史窗口时必须使用当年记录的 provider）。
 */

// ------------------------------------------------------------------ 常量口径

/** 夜天文昏影终：太阳仰角低于此值视为「夜间」（与 astro.NIGHT_DEG 同源） */
export const NIGHT_ELEVATION_DEG = -12;

/** 现象/硬性项判定使用的阈值（集中一处，避免各处魔数漂移） */
export const WEATHER_THRESHOLDS = {
  clearCloudPctMax: 20,
  thinCloudPctMin: 20,
  thinCloudPctMax: 60,
  overcastCloudPctMin: 80,
  rainMm: 0.2,
  wetGroundPrecipProbMax: 20,
  fogVisibilityKmMax: 1,
  fogHumidityMin: 92,
  strongWindMsMin: 8,
  /** 退化窗口只允许回退到最近 3 小时内的整点样本 */
  nearestSampleMaxGapHours: 3,
} as const;

// -------------------------------------------------------------------- 数据类型

export interface HourlyForecast {
  time: string; // ISO（UTC）
  cloudCoverPct: number | null;
  precipProbPct: number | null;
  precipMm: number | null;
  visibilityKm: number | null;
  windSpeedMs: number | null;
  tempC: number | null;
  humidityPct: number | null;
  snowfallCm: number | null;
}

export interface EpisodeWeather {
  degraded: boolean;
  provider: string;
  avgCloudCoverPct: number | null;
  maxPrecipProbPct: number | null;
  precipMmWindow: number | null;
  precipMmPrev6h: number | null;
  minVisibilityKm: number | null;
  maxWindSpeedMs: number | null;
  avgTempC: number | null;
  humidityPct: number | null;
  snowfallCm: number | null;
}

/** 退化（无任何预报数据）时的统一结果；provider 由调用方给定，保证回放口径一致。 */
export function degradedEpisode(provider: string): EpisodeWeather {
  return {
    degraded: true,
    provider,
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
}

// -------------------------------------------------------------------- 取样本

export function nearestSample(forecast: HourlyForecast[], at: Date): HourlyForecast | null {
  if (!forecast.length) return null;
  let best = forecast[0];
  let bestDiff = Math.abs(new Date(best.time).getTime() - at.getTime());
  for (const f of forecast) {
    const diff = Math.abs(new Date(f.time).getTime() - at.getTime());
    if (diff < bestDiff) {
      best = f;
      bestDiff = diff;
    }
  }
  return bestDiff <= WEATHER_THRESHOLDS.nearestSampleMaxGapHours * 3600000 ? best : null;
}

export function sliceForecast(forecast: HourlyForecast[], from: Date, to: Date): HourlyForecast[] {
  return forecast.filter((f) => {
    const t = new Date(f.time).getTime();
    return t >= from.getTime() && t <= to.getTime();
  });
}

/**
 * 取窗口内的预报样本。
 *
 * 关键点（实测踩到的坑）：很多窗口只有 20 分钟，可能**完全落在两个整点之间**
 * （例如 16:36–16:59）。若此时只按"窗口内整点"取值，会得到空数组，
 * 于是云量/降水概率/能见度全部判为"无数据"并被静默跳过——
 * 结果是一个雨天窗口被判成 good。因此这里退化为取**相邻两个整点**，
 * 且对"是否会下雨"这类硬性项取更保守的一侧（见 summarizeEpisode 的 max 聚合）。
 */
export function windowSamples(forecast: HourlyForecast[], start: Date, end: Date): HourlyForecast[] {
  const inside = sliceForecast(forecast, start, end);
  if (inside.length) return inside;

  const before = [...forecast].reverse().find((f) => new Date(f.time).getTime() <= start.getTime());
  const after = forecast.find((f) => new Date(f.time).getTime() >= end.getTime());
  const out = [before, after].filter((f): f is HourlyForecast => Boolean(f));
  if (out.length) return out;

  const fallback = nearestSample(forecast, start);
  return fallback ? [fallback] : [];
}

// ---------------------------------------------------------------------- 聚合

/** 汇总窗口 [start, end] 的天气，并带上窗口前 6 小时的降水（判定湿地面/雨后需要） */
export function summarizeEpisode(
  forecast: HourlyForecast[],
  start: Date,
  end: Date,
  provider = 'unknown',
): EpisodeWeather {
  if (forecast.length === 0) return degradedEpisode(provider);

  const inWindow = windowSamples(forecast, start, end);
  const point = inWindow[0] ?? nearestSample(forecast, start);
  const prev = sliceForecast(forecast, new Date(start.getTime() - 6 * 3600000), start);
  const nums = (arr: HourlyForecast[], key: keyof HourlyForecast) =>
    arr.map((f) => f[key]).filter((v): v is number => typeof v === 'number');
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const sum = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) : null);

  const cloud = nums(inWindow, 'cloudCoverPct');
  const precipProb = nums(inWindow, 'precipProbPct');
  const vis = nums(inWindow, 'visibilityKm');
  const wind = nums(inWindow, 'windSpeedMs');
  const temp = nums(inWindow, 'tempC');
  const snow = nums(inWindow, 'snowfallCm');

  return {
    degraded: false,
    provider,
    avgCloudCoverPct: avg(cloud),
    maxPrecipProbPct: precipProb.length ? Math.max(...precipProb) : null,
    precipMmWindow: sum(nums(inWindow, 'precipMm')),
    precipMmPrev6h: sum(nums(prev, 'precipMm')),
    minVisibilityKm: vis.length ? Math.min(...vis) : null,
    maxWindSpeedMs: wind.length ? Math.max(...wind) : null,
    avgTempC: avg(temp),
    humidityPct: point?.humidityPct ?? null,
    snowfallCm: snow.length ? Math.max(...snow) : null,
  };
}

/** 特殊现象判定（文档 12.4 第 3 步）。纯函数：阈值全部取自 WEATHER_THRESHOLDS。 */
export function phenomenonHolds(
  phenomenon: string,
  episode: EpisodeWeather,
  isNight: boolean,
): boolean {
  const T = WEATHER_THRESHOLDS;
  switch (phenomenon) {
    case 'any':
      return true;
    case 'clear':
      return (episode.avgCloudCoverPct ?? 0) <= T.clearCloudPctMax;
    case 'thin_cloud':
      return (
        episode.avgCloudCoverPct !== null &&
        episode.avgCloudCoverPct > T.thinCloudPctMin &&
        episode.avgCloudCoverPct <= T.thinCloudPctMax
      );
    case 'overcast':
      return (episode.avgCloudCoverPct ?? 0) > T.overcastCloudPctMin;
    case 'after_rain':
      return (episode.precipMmPrev6h ?? 0) > T.rainMm || (episode.precipMmWindow ?? 0) > T.rainMm;
    case 'wet_ground':
      return (
        (episode.precipMmPrev6h ?? 0) > T.rainMm &&
        (episode.maxPrecipProbPct ?? 100) <= T.wetGroundPrecipProbMax
      );
    case 'fog':
      return (
        (episode.minVisibilityKm ?? 99) <= T.fogVisibilityKmMax &&
        (episode.humidityPct ?? 0) >= T.fogHumidityMin
      );
    case 'snow':
      return (episode.snowfallCm ?? 0) > 0;
    case 'neon_reflection':
      return isNight && (episode.precipMmPrev6h ?? 0) > T.rainMm;
    case 'strong_wind':
      return (episode.maxWindSpeedMs ?? 0) >= T.strongWindMsMin;
    default:
      return false;
  }
}

// ------------------------------------------------------- 气候基线（文档 12.5）

export interface ClimateStat {
  month: number;
  hour: number;
  meanCloudCoverPct: number;
  precipHourRatio: number;
  samples: number;
}

export function climateAt(stats: ClimateStat[], hour: number): ClimateStat | null {
  if (!stats.length) return null;
  return stats.reduce((best, s) =>
    Math.abs(s.hour - hour) < Math.abs(best.hour - hour) ? s : best,
  );
}
