/**
 * 气象口径（唯一事实源）—— 窗口判定中所有与天气相关的阈值、聚合与画像评估都在这里。
 *
 * 本文件是**纯函数**模块：不碰数据库、不碰网络、不读配置。
 * provider 名称由调用方（server 的 weather 服务）注入；历史窗口重放时没有 provider，
 * 传 null 即可，判定结果与 provider 无关。
 *
 * 阈值与理由文本为既有判定口径的原样迁移，**不得在此处调参**，否则会改变历史判定。
 */

import { NIGHT_DEG } from './astro.js';
import type { TimingDto, WeatherProfile, WindowReasonDto } from './types.js';
import { WeatherPhenomenon, type WindowVerdict } from './enums.js';

/** 逐小时预报样本（Open-Meteo 口径：时间为 ISO/UTC，能见度已换算为 km） */
export interface HourlyWeatherSample {
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

/** 一次窗口内的天气汇总（既存 forecast_snapshot 就是这个形状，字段只能加不能改语义） */
export interface WeatherEpisode {
  degraded: boolean;
  /** 数据来源；历史重放/离线聚合时为 null */
  provider: string | null;
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

// --------------------------------------------------------------- 口径常量

/** 云量现象阈值（%） */
export const CLOUD_CLEAR_MAX_PCT = 20;
export const CLOUD_THIN_MIN_PCT = 20;
export const CLOUD_THIN_MAX_PCT = 60;
export const CLOUD_OVERCAST_MIN_PCT = 80;
/** 降水量阈值（mm）：超过即认为"有雨" */
export const PRECIP_MM_EPS = 0.2;
/** 雾：能见度 ≤ 1km 且湿度 ≥ 92% */
export const FOG_VISIBILITY_KM_MAX = 1;
export const FOG_HUMIDITY_MIN_PCT = 92;
/** 大风阈值（m/s） */
export const STRONG_WIND_MS_MIN = 8;
/** 湿地面：窗口前有雨，且当下降水概率 ≤ 20% */
export const WET_GROUND_PRECIP_PROB_MAX_PCT = 20;

/** 天气画像缺省的硬性项（超限即 bad；其余项超限只降到 marginal） */
export const DEFAULT_HARD_REQUIREMENTS = ['precipProbPctMax'];

/** 夜间的唯一口径：太阳仰角 < NIGHT_DEG（-12°），与 astro 的夜间事件同源 */
export function isNightByElevation(sunElevationDeg: number): boolean {
  return sunElevationDeg < NIGHT_DEG;
}

/** 构造一个"天气源不可用"的降级汇总（所有字段统一走这里，避免各处手写不一致） */
export function degradedEpisode(provider: string | null): WeatherEpisode {
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

function isDegraded(forecast: HourlyWeatherSample[]): boolean {
  return forecast.length === 0;
}

// --------------------------------------------------------------- 取数口径

function nearestSample(forecast: HourlyWeatherSample[], at: Date): HourlyWeatherSample | null {
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
  return bestDiff <= 3 * 3600000 ? best : null;
}

function sliceForecast(forecast: HourlyWeatherSample[], from: Date, to: Date): HourlyWeatherSample[] {
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
 * 再由 aggregateEpisode 的 max 聚合取更保守的一侧。
 */
export function windowWeatherSamples(
  forecast: HourlyWeatherSample[],
  start: Date,
  end: Date,
): HourlyWeatherSample[] {
  const inside = sliceForecast(forecast, start, end);
  if (inside.length) return inside;

  const before = [...forecast].reverse().find((f) => new Date(f.time).getTime() <= start.getTime());
  const after = forecast.find((f) => new Date(f.time).getTime() >= end.getTime());
  const out = [before, after].filter((f): f is HourlyWeatherSample => Boolean(f));
  if (out.length) return out;

  const fallback = nearestSample(forecast, start);
  return fallback ? [fallback] : [];
}

/**
 * 汇总窗口 [start, end] 的天气（纯函数），并带上窗口前 6 小时的降水
 * （判定湿地面/雨后需要）。forecast 为空 → 降级汇总。
 */
export function aggregateEpisode(
  forecast: HourlyWeatherSample[],
  start: Date,
  end: Date,
  provider: string | null,
): WeatherEpisode {
  if (isDegraded(forecast)) return degradedEpisode(provider);

  const inWindow = windowWeatherSamples(forecast, start, end);
  const point = inWindow[0] ?? nearestSample(forecast, start);
  const prevRaw = sliceForecast(forecast, new Date(start.getTime() - 6 * 3600000), start);
  const prev = prevRaw.length ? prevRaw : [];
  const nums = (arr: HourlyWeatherSample[], key: keyof HourlyWeatherSample) =>
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

// --------------------------------------------------------------- 现象口径

/** 特殊现象判定（文档 12.4 第 3 步），阈值全部取自本文件顶部常量 */
export function phenomenonHolds(
  phenomenon: WeatherPhenomenon,
  episode: WeatherEpisode,
  isNight: boolean,
): boolean {
  switch (phenomenon) {
    case 'any':
      return true;
    case 'clear':
      return (episode.avgCloudCoverPct ?? 0) <= CLOUD_CLEAR_MAX_PCT;
    case 'thin_cloud':
      return (
        episode.avgCloudCoverPct !== null &&
        episode.avgCloudCoverPct > CLOUD_THIN_MIN_PCT &&
        episode.avgCloudCoverPct <= CLOUD_THIN_MAX_PCT
      );
    case 'overcast':
      return (episode.avgCloudCoverPct ?? 0) > CLOUD_OVERCAST_MIN_PCT;
    case 'after_rain':
      return (
        (episode.precipMmPrev6h ?? 0) > PRECIP_MM_EPS || (episode.precipMmWindow ?? 0) > PRECIP_MM_EPS
      );
    case 'wet_ground':
      return (
        (episode.precipMmPrev6h ?? 0) > PRECIP_MM_EPS &&
        (episode.maxPrecipProbPct ?? 100) <= WET_GROUND_PRECIP_PROB_MAX_PCT
      );
    case 'fog':
      return (
        (episode.minVisibilityKm ?? 99) <= FOG_VISIBILITY_KM_MAX &&
        (episode.humidityPct ?? 0) >= FOG_HUMIDITY_MIN_PCT
      );
    case 'snow':
      return (episode.snowfallCm ?? 0) > 0;
    case 'neon_reflection':
      return isNight && (episode.precipMmPrev6h ?? 0) > PRECIP_MM_EPS;
    case 'strong_wind':
      return (episode.maxWindSpeedMs ?? 0) >= STRONG_WIND_MS_MIN;
    default:
      return false;
  }
}

// --------------------------------------------------------------- 画像评估

export interface WeatherVerdictState {
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
}

/**
 * 按天气画像评估一个已汇总好的 episode，**就地追加**理由并按口径升降 verdict：
 * - 降级（无天气）：追加 WEATHER_DEGRADED，good → marginal；
 * - 硬性项不满足：bad；软性项不满足：good → marginal；
 * - 数据缺失的字段静默跳过（沿用既有判定）。
 *
 * 入参 verdict 是天文项之后的初始判定；返回同一对象以便链式调用。
 */
export function applyWeatherProfile(
  profile: WeatherProfile,
  episode: WeatherEpisode,
  isNight: boolean,
  state: WeatherVerdictState,
): WeatherVerdictState {
  if (episode.degraded) {
    state.reasons.push({
      code: 'WEATHER_DEGRADED',
      level: 'warn',
      text: '天气源不可用：本次判定未包含天气，最高只能到「勉强」',
    });
    if (state.verdict === 'good') state.verdict = 'marginal';
    return state;
  }

  const hard = new Set(profile.hardRequirements ?? DEFAULT_HARD_REQUIREMENTS);

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
      state.reasons.push({ code, level: 'ok', text });
      return;
    }
    const isHard = hard.has(key);
    state.reasons.push({
      code: `${code}_${isHard ? 'FAIL' : 'MARGINAL'}`,
      level: isHard ? 'bad' : 'warn',
      text,
    });
    if (isHard) state.verdict = 'bad';
    else if (state.verdict === 'good') state.verdict = 'marginal';
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
    state.reasons.push({
      code: ok ? 'CLOUD_OK' : isHard ? 'CLOUD_FAIL' : 'CLOUD_MARGINAL',
      level: ok ? 'ok' : isHard ? 'bad' : 'warn',
      text: `云量 ${cloud.toFixed(0)}%（目标 ${min}%–${max}%）`,
    });
    if (!ok) {
      if (isHard) state.verdict = 'bad';
      else if (state.verdict === 'good') state.verdict = 'marginal';
    }
  }

  if (profile.tempC && episode.avgTempC !== null) {
    const ok = episode.avgTempC >= profile.tempC.min && episode.avgTempC <= profile.tempC.max;
    const isHard = hard.has('tempC');
    state.reasons.push({
      code: ok ? 'TEMP_OK' : isHard ? 'TEMP_FAIL' : 'TEMP_MARGINAL',
      level: ok ? 'ok' : isHard ? 'bad' : 'warn',
      text: `气温 ${episode.avgTempC.toFixed(0)}℃（目标 ${profile.tempC.min}–${profile.tempC.max}℃）`,
    });
    if (!ok) {
      if (isHard) state.verdict = 'bad';
      else if (state.verdict === 'good') state.verdict = 'marginal';
    }
  }

  for (const phenomenon of (profile.phenomena ?? []) as WeatherPhenomenon[]) {
    if (phenomenon === 'any') continue;
    const hit = phenomenonHolds(phenomenon, episode, isNight);
    const isHard = hard.has(`phenomenon:${phenomenon}`);
    state.reasons.push({
      code: hit ? 'PHENOMENON_OK' : isHard ? 'PHENOMENON_FAIL' : 'PHENOMENON_MARGINAL',
      level: hit ? 'ok' : isHard ? 'bad' : 'warn',
      text: `特殊现象「${phenomenon}」${hit ? '满足' : '不满足'}`,
    });
    if (!hit) {
      if (isHard) state.verdict = 'bad';
      else if (state.verdict === 'good') state.verdict = 'marginal';
    }
  }

  return state;
}

/** 便捷重载：给定 timing/episode/中点仰角，直接得到天气项评估后的判定与理由 */
export function evaluateWeather(
  timing: Pick<TimingDto, 'weatherProfile'>,
  episode: WeatherEpisode,
  midSunElevationDeg: number,
  initialVerdict: WindowVerdict = 'good',
): WeatherVerdictState {
  return applyWeatherProfile(
    timing.weatherProfile,
    episode,
    isNightByElevation(midSunElevationDeg),
    { verdict: initialVerdict, reasons: [] },
  );
}
