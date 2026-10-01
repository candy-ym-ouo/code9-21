export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LightArrowGeometry {
  from: Point;
  to: Point;
  bearingDeg?: number;
  elevationHint?: 'low' | 'mid' | 'high';
}

export interface LeadingLineGeometry {
  points: Point[];
}

export interface RectGeometry {
  rect: Rect;
}

export type AnnotationGeometry =
  | LightArrowGeometry
  | LeadingLineGeometry
  | RectGeometry
  | { points: Point[] };

const EPS = 1e-6;

export function isNormalized(v: number): boolean {
  return Number.isFinite(v) && v >= -EPS && v <= 1 + EPS;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** 校验归一化坐标几何（[0,1] 之外一律拒绝，见文档 9.3 / 11.5） */
export function validateGeometry(kind: string, geometry: unknown): { ok: true } | { ok: false; error: string } {
  if (!geometry || typeof geometry !== 'object') return { ok: false, error: 'geometry 必须是对象' };
  const g = geometry as Record<string, unknown>;

  const checkPoint = (p: unknown, label: string) => {
    if (!p || typeof p !== 'object') return `${label} 缺失`;
    const { x, y } = p as Point;
    if (!isNormalized(x) || !isNormalized(y)) return `${label} 坐标越界（需在 0..1）`;
    return null;
  };

  if (kind === 'light_arrow') {
    for (const key of ['from', 'to'] as const) {
      const err = checkPoint(g[key], key);
      if (err) return { ok: false, error: err };
    }
    const arrow = g as unknown as LightArrowGeometry;
    if (arrow.from.x === arrow.to.x && arrow.from.y === arrow.to.y) {
      return { ok: false, error: '光位箭头起止点不可重合' };
    }
    if (arrow.bearingDeg !== undefined && (arrow.bearingDeg < 0 || arrow.bearingDeg > 360)) {
      return { ok: false, error: 'bearingDeg 需在 0..360' };
    }
    return { ok: true };
  }

  if (kind === 'leading_line') {
    const pts = g.points;
    if (!Array.isArray(pts) || pts.length < 2) return { ok: false, error: '引导线至少需要 2 个点' };
    for (let i = 0; i < pts.length; i += 1) {
      const err = checkPoint(pts[i], `points[${i}]`);
      if (err) return { ok: false, error: err };
    }
    return { ok: true };
  }

  if (kind === 'frame' || kind === 'negative_space') {
    const rect = g.rect as Rect | undefined;
    if (!rect) return { ok: false, error: 'rect 缺失' };
    if (!isNormalized(rect.x) || !isNormalized(rect.y)) return { ok: false, error: 'rect 原点越界' };
    if (!(rect.w > 0) || !(rect.h > 0)) return { ok: false, error: 'rect 宽高必须大于 0' };
    if (rect.x + rect.w > 1 + EPS || rect.y + rect.h > 1 + EPS) return { ok: false, error: 'rect 超出画面' };
    return { ok: true };
  }

  if (kind === 'rule_of_thirds') {
    const pts = g.points;
    if (!Array.isArray(pts) || pts.length === 0) return { ok: false, error: '三分线交点至少需要 1 个点' };
    for (let i = 0; i < pts.length; i += 1) {
      const err = checkPoint(pts[i], `points[${i}]`);
      if (err) return { ok: false, error: err };
    }
    return { ok: true };
  }

  return { ok: false, error: `未知标注类型：${kind}` };
}

/** 由画面上的光位箭头推算光位角：0°=正对面光源(顺光)，90°=光从右来，180°=逆光 */
export function bearingFromArrow(from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 期望太阳方位角 = 拍摄朝向 + 光位角（见文档 9.3 的业务规则） */
export function expectedAzimuth(cameraBearing: number, lightBearing: number): number {
  return (((cameraBearing + lightBearing) % 360) + 360) % 360;
}

/**
 * 光位与朝向角度原语。
 * 角度差的唯一实现是 time.ts 的 angularDistance（正北 0°、顺时针、绕 360°），
 * 这里保留 angleDiff/angleWithin 旧名做再导出，历史调用不必改名。
 */
export { angularDistance as angleDiff } from './time.js';
import { angularDistance } from './time.js';

export function angleWithin(value: number, center: number, tolerance: number): boolean {
  return angularDistance(value, center) <= tolerance;
}
