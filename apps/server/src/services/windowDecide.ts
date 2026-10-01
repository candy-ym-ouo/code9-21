/**
 * 窗口判定的 server 侧适配层（无 DB、无 config）。
 *
 * 真正的判定口径全部在 @flil/shared/window（decideDayWindow 纯函数），
 * 这里只做 server 行类型到共享入参（WindowSite）的投影与旧接口再导出。
 * 旧代码 import 的 computeDay / DayResult 名称保持不变，判定行为一字不改。
 */

import {
  decideDayWindow,
  type DayWindowResult,
  type HourlyWeatherSample,
  type TimingDto,
  type WindowSite,
} from '@flil/shared';

export interface SpotGeomInput {
  lat: number;
  lng: number;
  tz: string;
}

/** 旧名兼容：内部类型已移至 @flil/shared 的 DayWindowResult */
export type DayResult = DayWindowResult;

/**
 * 判定单日窗口（旧接口签名不变）：逐小时预报传 [] 即天气降级。
 * 与历史行为一致：此入口不记录天气提供方（episode.provider = null）；
 * 在线落库链路走 computeDayForProvider，会注入 config.weatherProvider（仅元数据，不影响判定）。
 */
export function computeDay(
  spot: SpotGeomInput,
  timing: TimingDto,
  dateKey: string,
  forecast: HourlyWeatherSample[],
): DayWindowResult {
  return decideDayWindow({ lat: spot.lat, lng: spot.lng, tz: spot.tz }, timing, dateKey, forecast, null);
}

/** 带数据来源标记的单日判定；provider 只写入 episode，不参与任何比较。 */
export function computeDayForProvider(
  spot: SpotGeomInput,
  timing: TimingDto,
  dateKey: string,
  forecast: HourlyWeatherSample[],
  provider: string | null,
): DayWindowResult {
  const site: WindowSite = { lat: spot.lat, lng: spot.lng, tz: spot.tz };
  return decideDayWindow(site, timing, dateKey, forecast, provider);
}
