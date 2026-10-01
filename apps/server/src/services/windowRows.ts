/**
 * 窗口/timing 相关的纯行类型与 DTO 投影（叶子模块：不依赖 DB 实例与其他服务）。
 *
 * 抽出来是为了切断 windowEngine ↔ serialization ↔ windowReplay 之间的类型环：
 * 判定纯函数在 @flil/shared，落库编排在 windowEngine，行→DTO 在 serialization，
 * 大家都只依赖这里的行类型。
 */

import type { TimingDto } from '@flil/shared';
import { parseJson } from '../db.js';

export interface TimingRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  time_anchor: TimingDto['timeAnchor'];
  anchor_offset_min: number;
  elevation_range: string;
  azimuth_range: string | null;
  azimuth_tolerance: number;
  window_tolerance_min: number;
  weather_profile: string;
  season_window: string | null;
  repeat_rule: string | null;
  notes: string | null;
}

/** 机位的几何投影（判定函数只需要这四个字段） */
export interface SpotGeom {
  id: string;
  lat: number;
  lng: number;
  camera_bearing: number;
  tz: string;
}

export function timingRowToDto(row: TimingRow): TimingDto {
  return {
    timeAnchor: row.time_anchor,
    anchorOffsetMin: row.anchor_offset_min,
    elevationRange: parseJson<number[]>(row.elevation_range, [-90, 90]),
    azimuthRange: row.azimuth_range ? parseJson<number[] | null>(row.azimuth_range, null) : null,
    azimuthTolerance: row.azimuth_tolerance,
    windowToleranceMin: row.window_tolerance_min,
    weatherProfile: parseJson(row.weather_profile, {}),
    seasonWindow: row.season_window
      ? parseJson<{ fromMonth: number; toMonth: number } | null>(row.season_window, null)
      : null,
    notes: row.notes,
  };
}
