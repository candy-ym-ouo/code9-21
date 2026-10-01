import { describe, expect, it } from 'vitest';
import {
  aggregateEpisode,
  applyWeatherProfile,
  angularDistance,
  angleDiff,
  angleWithin,
  decideDayWindow,
  expectedAzimuth,
  isNightByElevation,
  longestContiguousRun,
  monthInSeason,
  phenomenonHolds,
  theoreticalOkForDay,
  type HourlyWeatherSample,
  type TimingDto,
  type WeatherEpisode,
  type WeatherProfile,
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

function forecast(overrides: Partial<HourlyWeatherSample> = {}): HourlyWeatherSample[] {
  const out: HourlyWeatherSample[] = [];
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

describe('统一方位角口径', () => {
  it('angularDistance 与 geometry 的 angleDiff 是同一实现', () => {
    expect(angularDistance(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(20);
    expect(angularDistance(180, 0)).toBe(180);
    expect(angleDiff(90, 95)).toBe(5);
  });

  it('angleWithin 绕 360° 比较', () => {
    expect(angleWithin(5, 355, 12)).toBe(true);
    expect(angleWithin(91, 0, 90)).toBe(false);
    expect(angleWithin(89, 0, 90)).toBe(true);
  });

  it('expectedAzimuth 是光位口径的唯一入口（绕 360°）', () => {
    expect(expectedAzimuth(350, 20)).toBe(10);
    expect(expectedAzimuth(0, 0)).toBe(0);
  });
});

describe('统一天象/季节口径', () => {
  it('夜间判定以 NIGHT_DEG(-12°) 为界', () => {
    expect(isNightByElevation(-12.1)).toBe(true);
    expect(isNightByElevation(-12)).toBe(false);
    expect(isNightByElevation(30)).toBe(false);
  });

  it('monthInSeason 处理跨年季节窗口', () => {
    expect(monthInSeason(7, { fromMonth: 6, toMonth: 8 })).toBe(true);
    expect(monthInSeason(9, { fromMonth: 6, toMonth: 8 })).toBe(false);
    expect(monthInSeason(1, { fromMonth: 11, toMonth: 2 })).toBe(true);
    expect(monthInSeason(12, { fromMonth: 11, toMonth: 2 })).toBe(true);
    expect(monthInSeason(6, { fromMonth: 11, toMonth: 2 })).toBe(false);
  });
});

describe('纯气象口径', () => {
  function ep(partial: Partial<WeatherEpisode> = {}): WeatherEpisode {
    return {
      degraded: false,
      provider: 'fixture',
      avgCloudCoverPct: 30,
      maxPrecipProbPct: 5,
      precipMmWindow: 0,
      precipMmPrev6h: 0,
      minVisibilityKm: 20,
      maxWindSpeedMs: 3,
      avgTempC: 20,
      humidityPct: 55,
      snowfallCm: 0,
      ...partial,
    };
  }

  it('现象阈值集中且与历史口径一致', () => {
    expect(phenomenonHolds('clear', ep({ avgCloudCoverPct: 20 }), false)).toBe(true);
    expect(phenomenonHolds('clear', ep({ avgCloudCoverPct: 21 }), false)).toBe(false);
    expect(phenomenonHolds('thin_cloud', ep({ avgCloudCoverPct: 60 }), false)).toBe(true);
    expect(phenomenonHolds('overcast', ep({ avgCloudCoverPct: 81 }), false)).toBe(true);
    expect(phenomenonHolds('after_rain', ep({ precipMmPrev6h: 0.3 }), false)).toBe(true);
    expect(phenomenonHolds('fog', ep({ minVisibilityKm: 0.8, humidityPct: 95 }), false)).toBe(true);
    expect(phenomenonHolds('fog', ep({ minVisibilityKm: 0.8, humidityPct: 80 }), false)).toBe(false);
    expect(phenomenonHolds('snow', ep({ snowfallCm: 0.1 }), false)).toBe(true);
    expect(phenomenonHolds('strong_wind', ep({ maxWindSpeedMs: 8 }), false)).toBe(true);
    // neon_reflection 必须是夜间
    expect(phenomenonHolds('neon_reflection', ep({ precipMmPrev6h: 1 }), false)).toBe(false);
    expect(phenomenonHolds('neon_reflection', ep({ precipMmPrev6h: 1 }), true)).toBe(true);
    expect(phenomenonHolds('any', ep(), false)).toBe(true);
  });

  it('短窗口落在两个整点之间：聚合取相邻整点，硬性项不漏判', () => {
    // 16:36–16:59 之间没有整点样本
    const cloudy = forecast({ precipProbPct: 90 });
    const episode = aggregateEpisode(
      cloudy,
      new Date('2026-10-11T08:36:00Z'),
      new Date('2026-10-11T08:59:00Z'),
      'fixture',
    );
    expect(episode.maxPrecipProbPct).toBe(90);
    const state = applyWeatherProfile(
      { precipProbPctMax: 20 },
      episode,
      false,
      { verdict: 'good', reasons: [] },
    );
    expect(state.verdict).toBe('bad');
  });

  it('降级 episode 画像评估：good 降 marginal 且理由标注', () => {
    const episode: WeatherEpisode = {
      degraded: true,
      provider: 'off',
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
    const state = applyWeatherProfile({}, episode, false, { verdict: 'good', reasons: [] });
    expect(state.verdict).toBe('marginal');
    expect(state.reasons[0].code).toBe('WEATHER_DEGRADED');
  });

  it('硬/软项升降级口径：软性不判死，硬性直接 bad', () => {
    const profile: WeatherProfile = {
      cloudCoverPct: { min: 0, max: 20 },
      windSpeedMax: 5,
      hardRequirements: ['windSpeedMax'],
    };
    const softOnly = applyWeatherProfile(
      { cloudCoverPct: { min: 0, max: 20 } },
      ep({ avgCloudCoverPct: 80 }),
      false,
      { verdict: 'good', reasons: [] },
    );
    expect(softOnly.verdict).toBe('marginal');
    const hard = applyWeatherProfile(profile, ep({ maxWindSpeedMs: 9 }), false, {
      verdict: 'good',
      reasons: [],
    });
    expect(hard.verdict).toBe('bad');
    expect(hard.reasons.some((r) => r.code === 'WIND_FAIL')).toBe(true);
  });
});

describe('共享纯判定 decideDayWindow', () => {
  it('与旧 computeDay 同参同果：条件宽松判 good', () => {
    const r = decideDayWindow(SPOT, timing(), DATE, forecast(), 'fixture');
    expect(r.verdict).toBe('good');
    expect(r.episode.provider).toBe('fixture');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_RESOLVED')).toBe(true);
  });

  it('无预报 → 降级 marginal', () => {
    const r = decideDayWindow(SPOT, timing(), DATE, [], null);
    expect(r.verdict).toBe('marginal');
    expect(r.episode.degraded).toBe(true);
    expect(r.reasons.some((x) => x.code === 'WEATHER_DEGRADED')).toBe(true);
  });

  it('季节外直接 bad，且 episode 仍为降级形状（旧返回契约）', () => {
    const r = decideDayWindow(
      SPOT,
      timing({ seasonWindow: { fromMonth: 6, toMonth: 8 } }),
      DATE,
      forecast(),
      'fixture',
    );
    expect(r.verdict).toBe('bad');
    expect(r.reasons[0].code).toBe('OUT_OF_SEASON');
    expect(r.episode.degraded).toBe(true);
  });

  it('理论口径与单日判定共用同一天文交集（同一 timing 结论一致）', () => {
    const t = timing({ azimuthRange: [255, 275], azimuthTolerance: 20 });
    // 单日判定 good（天气也好），理论口径必然 true
    const day = decideDayWindow(SPOT, t, DATE, forecast(), 'fixture');
    expect(day.verdict).toBe('good');
    expect(theoreticalOkForDay(SPOT.lat, SPOT.lng, SPOT.tz, DATE, t)).toBe(true);

    const impossible = timing({ azimuthRange: [30, 50] });
    expect(theoreticalOkForDay(SPOT.lat, SPOT.lng, SPOT.tz, DATE, impossible)).toBe(false);
  });
});

describe('最长连续段口径', () => {
  const d = (m: number) => new Date(Date.UTC(2026, 9, 11, 0, m));
  it('取最长连续段，间隔 > 6 分钟视为断裂', () => {
    const run = longestContiguousRun([
      { at: d(0), ok: true },
      { at: d(5), ok: true },
      { at: d(10), ok: false },
      { at: d(20), ok: true },
      { at: d(24), ok: true },
      { at: d(28), ok: true },
    ]);
    expect(run?.start).toEqual(d(20));
    expect(run?.end).toEqual(d(28));
  });
  it('全不满足返回 null', () => {
    expect(longestContiguousRun([{ at: d(0), ok: false }])).toBeNull();
  });
});
