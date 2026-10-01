/**
 * 序列化纯边界 —— 行 → DTO 的映射集中在此（不读库、不做权限判断）。
 *
 * 服务层负责"这个人能看到什么"（精确坐标/模糊化），本文件只负责
 * "一个数据库行长成什么 DTO"，保证列表、详情、重放等所有出口字段口径一致。
 */

import type { ReproWindowDto, WindowReasonDto } from './types.js';
import type { WindowVerdict } from './enums.js';

/** repro_window 表行（只列映射需要的列） */
export interface ReproWindowRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  date: string;
  start_at: string;
  end_at: string;
  anchor_at: string;
  sun_elevation: number | null;
  sun_azimuth: number | null;
  verdict: string;
  reasons: string | WindowReasonDto[];
  forecast_snapshot: string | null;
  weather_degraded: number | boolean;
  stale: number | boolean;
  computed_at: string | null;
  input_snapshot?: string | null;
}

/** 宽松 JSON 解析：历史数据可能存了字符串，也可能经 better-sqlite3 插件直接是对象/数组。 */
function parseJsonArray(value: unknown): WindowReasonDto[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value as WindowReasonDto[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as WindowReasonDto[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** repro_window 行 → ReproWindowDto（所有窗口出口的唯一映射）。 */
export function reproWindowRowToDto(r: ReproWindowRow): ReproWindowDto {
  return {
    id: r.id,
    inspirationId: r.inspiration_id,
    date: r.date,
    startAt: r.start_at,
    endAt: r.end_at,
    anchorAt: r.anchor_at,
    sunElevation: r.sun_elevation ?? null,
    sunAzimuth: r.sun_azimuth ?? null,
    verdict: r.verdict as WindowVerdict,
    reasons: parseJsonArray(r.reasons),
    weatherDegraded: r.weather_degraded === 1 || r.weather_degraded === true,
    stale: r.stale === 1 || r.stale === true,
    computedAt: r.computed_at ?? null,
  };
}
