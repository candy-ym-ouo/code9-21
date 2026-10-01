import { describe, expect, it } from 'vitest';
import {
  WINDOW_ENGINE_VERSION,
  angularDistance,
  angleDiff,
  azimuthWithinRange,
  buildWindowDayInput,
  evaluateDayWindow,
  evaluateDayWindowInput,
  expectedAzimuth,
  lightBearingFromAzimuth,
  phenomenonHolds,
  sliceForecastForDay,
  summarizeEpisode,
  type HourlyForecast,
  type TimingDto,
} from '@flil/shared';

const SPOT = { lat: 31.2471, lng: 121.4462, tz: 'Asia/Shanghai' };
const DATE = '2026-10-11';

function timing(patch: Partial<TimingDto> = {}): TimingDto {
  return {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: {},
    seasonWindow: null,
    notes: null,
    ...patch,
  };
}

function forecast(overrides: Partial<HourlyForecast> = {}): HourlyForecast[] {
  const out: HourlyForecast[] = [];
  const start = new Date('2026-10-11T00:00:00Z');
  for (let i = 0; i < 48; i += 1) {
    out.push({
      time: new Date(start.getTime() + i * 3600000).toISOString(),
      cloudCoverPct: 30,
      precipProbPct: 5,
      precipMm: 0,
      visibilityKm: 20,
      windSpeedMs: 3,
      tempC: 20,
      humidityPct: 55,
      snowfallCm: 0,
      ...overrides,
    });
  }
  return out;
}

describe('方位口径统一', () => {
  it('angularDistance 与 angleDiff 是同一实现（旧名保留但数值一致）', () => {
    for (const [a, b] of [
      [0, 359],
      [2, 358],
      [270, 90],
      [123.4, 234.5],
    ]) {
      expect(angularDistance(a, b)).toBe(angleDiff(a, b));
    }
    expect(angularDistance(2, 358)).toBe(4);
  });

  it('azimuthWithinRange 与历史「中心±容差」判定数值一致（含中心在 0° 附近）', () => {
    // [350, 10] 的算术中心 = 180 → 358 不命中（保持历史口径，不做跨 0° 展开）
    expect(azimuthWithinRange(180, [350, 10], 5)).toBe(true);
    expect(azimuthWithinRange(358, [350, 10], 5)).toBe(false);
    // 常规区间
    expect(azimuthWithinRange(265, [255, 275], 20)).toBe(true);
    expect(azimuthWithinRange(40, [255, 275], 20)).toBe(false);
  });

  it('lightBearingFromAzimuth 是 expectedAzimuth 的逆运算（跨 0° 也成立）', () => {
    for (const [camera, sun] of [
      [265, 85],
      [350, 20],
      [10, 350],
      [0, 0],
    ]) {
      const light = lightBearingFromAzimuth(camera, sun);
      expect(expectedAzimuth(camera, light)).toBeCloseTo(sun, 9);
    }
    expect(lightBearingFromAzimuth(265, 85)).toBe(180);
  });
});

describe('纯判定管线 evaluateDayWindow', () => {
  it('宽松条件 → good', () => {
    const r = evaluateDayWindow(SPOT, timing(), DATE, forecast(), 'fixture');
    expect(r.verdict).toBe('good');
  });

  it('硬性降水超限 → bad', () => {
    const r = evaluateDayWindow(
      SPOT,
      timing({ weatherProfile: { precipProbPctMax: 20, hardRequirements: ['precipProbPctMax'] } }),
      DATE,
      forecast({ precipProbPct: 80 }),
      'fixture',
    );
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'PRECIP_FAIL')).toBe(true);
  });

  it('provider 注入：降级时 episode.provider 记录当次来源', () => {
    const r = evaluateDayWindow(SPOT, timing(), DATE, [], 'off');
    expect(r.episode?.degraded).toBe(true);
    expect(r.episode?.provider).toBe('off');
    expect(r.verdict).toBe('marginal');
  });
});

describe('气象口径（阈值集中，纯函数）', () => {
  it('phenomenonHolds 的各现象边界与文档一致', () => {
    const ep = (p: Partial<Parameters<typeof summarizeEpisode>[0] extends never ? never : Record<string, unknown>>) =>
      ({
        degraded: false,
        provider: 'fixture',
        avgCloudCoverPct: null,
        maxPrecipProbPct: null,
        precipMmWindow: null,
        precipMmPrev6h: null,
        minVisibilityKm: null,
        maxWindSpeedMs: null,
        avgTempC: null,
        humidityPct: null,
        snowfallCm: null,
        ...p,
      }) as unknown as ReturnType<typeof summarizeEpisode>;

    expect(phenomenonHolds('clear', ep({ avgCloudCoverPct: 20 }), false)).toBe(true);
    expect(phenomenonHolds('clear', ep({ avgCloudCoverPct: 21 }), false)).toBe(false);
    expect(phenomenonHolds('overcast', ep({ avgCloudCoverPct: 81 }), false)).toBe(true);
    expect(phenomenonHolds('fog', ep({ minVisibilityKm: 0.8, humidityPct: 95 }), false)).toBe(true);
    expect(phenomenonHolds('fog', ep({ minVisibilityKm: 0.8, humidityPct: 90 }), false)).toBe(false);
    expect(phenomenonHolds('strong_wind', ep({ maxWindSpeedMs: 8 }), false)).toBe(true);
    expect(phenomenonHolds('snow', ep({ snowfallCm: 0.1 }), false)).toBe(true);
    expect(phenomenonHolds('neon_reflection', ep({ precipMmPrev6h: 0.3 }), true)).toBe(true);
    expect(phenomenonHolds('neon_reflection', ep({ precipMmPrev6h: 0.3 }), false)).toBe(false);
    expect(phenomenonHolds('any', ep({}), false)).toBe(true);
  });
});

describe('历史窗口可重放（输入快照往返一致）', () => {
  it('buildWindowDayInput → evaluateDayWindowInput 得到逐项一致的判定', () => {
    const fc = forecast({ windSpeedMs: 9 });
    const first = evaluateDayWindow(SPOT, timing(), DATE, fc, 'fixture');
    const snapshot = buildWindowDayInput(SPOT, timing(), DATE, sliceForecastForDay(fc, SPOT.tz, DATE), 'fixture');
    expect(snapshot.engineVersion).toBe(WINDOW_ENGINE_VERSION);
    const replayed = evaluateDayWindowInput(snapshot);

    expect(replayed.verdict).toBe(first.verdict);
    expect(JSON.stringify(replayed.reasons)).toBe(JSON.stringify(first.reasons));
    expect(replayed.startAt.getTime()).toBe(first.startAt.getTime());
    expect(replayed.endAt.getTime()).toBe(first.endAt.getTime());
    expect(replayed.anchorAt.getTime()).toBe(first.anchorAt.getTime());
    expect(replayed.sunElevation).toBe(first.sunElevation);
    expect(replayed.sunAzimuth).toBe(first.sunAzimuth);
  });

  it('切片后的预报仍覆盖判定所需（含窗口前 6h 回看），重放 verdict 不变', () => {
    const fc = forecast();
    const full = evaluateDayWindow(SPOT, timing(), DATE, fc, 'fixture');
    const sliced = evaluateDayWindowInput(
      buildWindowDayInput(SPOT, timing(), DATE, sliceForecastForDay(fc, SPOT.tz, DATE), 'fixture'),
    );
    expect(sliced.verdict).toBe(full.verdict);
    expect(JSON.stringify(sliced.reasons)).toBe(JSON.stringify(full.reasons));
    // 切片显著小于全量（48h），但保留了当地日界前后所需样本
    expect(sliceForecastForDay(fc, SPOT.tz, DATE).length).toBeLessThan(fc.length);
  });

  it('降级窗口（空预报）的快照重放仍是 marginal 且带 WEATHER_DEGRADED', () => {
    const snapshot = buildWindowDayInput(SPOT, timing(), DATE, [], 'off');
    const r = evaluateDayWindowInput(snapshot);
    expect(r.verdict).toBe('marginal');
    expect(r.reasons.some((x) => x.code === 'WEATHER_DEGRADED')).toBe(true);
  });
});
