import { describe, expect, it } from 'vitest';
import {
  angularDistance,
  bandToRange,
  elevationAt,
  resolveAnchor,
  solarPosition,
  sunEvents,
  theoreticalOkForDay,
  utcToZonedParts,
  zonedTimeToUtc,
  type TimingDto,
} from '@flil/shared';

const SHANGHAI = { lat: 31.23, lng: 121.47, tz: 'Asia/Shanghai' };

function baseTiming(patch: Partial<TimingDto> = {}): TimingDto {
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

describe('太阳位置算法', () => {
  it('正午方位角接近正南（北半球中纬度）', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const pos = solarPosition(events.solarNoon, SHANGHAI.lat, SHANGHAI.lng);
    expect(angularDistance(pos.azimuthDeg, 180)).toBeLessThan(0.5);
  });

  it('上海 2026-10-11 的日出日落时刻与真实值一致（±4 分钟）', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const sunrise = utcToZonedParts(events.sunrise!, SHANGHAI.tz);
    const sunset = utcToZonedParts(events.sunset!, SHANGHAI.tz);
    const minutes = (h: number, m: number, tH: number, tM: number) => Math.abs(h * 60 + m - (tH * 60 + tM));
    expect(minutes(sunrise.hour, sunrise.minute, 5, 53)).toBeLessThanOrEqual(4);
    expect(minutes(sunset.hour, sunset.minute, 17, 27)).toBeLessThanOrEqual(4);
  });

  it('黄金时刻（昏）的仰角区间落在 -4° ~ +6°', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const start = elevationAt(events.goldenPm!.start, SHANGHAI.lat, SHANGHAI.lng);
    const end = elevationAt(events.goldenPm!.end, SHANGHAI.lat, SHANGHAI.lng);
    expect(start).toBeGreaterThan(5.5);
    expect(start).toBeLessThan(6.5);
    expect(end).toBeLessThan(-3.5);
    expect(end).toBeGreaterThan(-4.5);
  });

  it('太阳仰角在一天内先升后降（单调性正确）', () => {
    const day = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-06-21');
    const morning = elevationAt(new Date(day.solarNoon.getTime() - 3 * 3600000), SHANGHAI.lat, SHANGHAI.lng);
    const noon = day.maxElevationDeg;
    const evening = elevationAt(new Date(day.solarNoon.getTime() + 3 * 3600000), SHANGHAI.lat, SHANGHAI.lng);
    expect(noon).toBeGreaterThan(morning);
    expect(noon).toBeGreaterThan(evening);
  });
});

describe('极端纬度（极昼 / 极夜）', () => {
  it('斯瓦尔巴 6 月为极昼，无日出日落锚点', () => {
    const events = sunEvents(78.22, 15.65, 'Europe/Oslo', '2026-06-21');
    expect(events.polar).toBe('midnight_sun');
    expect(events.sunrise).toBeNull();
  });

  it('斯瓦尔巴 12 月为极夜，锚点返回 null 而不是错误时间', () => {
    const events = sunEvents(78.22, 15.65, 'Europe/Oslo', '2026-12-21');
    expect(events.polar).toBe('polar_night');
    expect(resolveAnchor(events, baseTiming({ timeAnchor: 'golden_pm' }))).toBeNull();
    expect(resolveAnchor(events, baseTiming({ timeAnchor: 'sunset_minus' }))).toBeNull();
  });
});

describe('时间锚解析', () => {
  it('日落前 40 分钟 = 日落时刻 − 40 分钟', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'sunset_minus', anchorOffsetMin: 40 }))!;
    expect(events.sunset!.getTime() - resolved.anchorAt.getTime()).toBe(40 * 60000);
  });

  it('黄金时刻锚点自带仰角区间', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'golden_pm' }))!;
    expect(resolved.elevationRange).toEqual([-4, 6]);
    expect(resolved.band).not.toBeNull();
  });

  it('固定钟点按机位时区解释', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'fixed_clock', anchorOffsetMin: 10 * 60 }))!;
    const parts = utcToZonedParts(resolved.anchorAt, SHANGHAI.tz);
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(0);
  });

  it('带偏移的锚点用 ±windowToleranceMin 生成窗口', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'sunset', windowToleranceMin: 15 }))!;
    const [start, end] = bandToRange(resolved, baseTiming({ timeAnchor: 'sunset', windowToleranceMin: 15 }));
    expect(start.getTime() - resolved.anchorAt.getTime()).toBe(-15 * 60000);
    expect(end.getTime() - resolved.anchorAt.getTime()).toBe(15 * 60000);
  });

  it('时区换算：同一时刻在不同时区得到不同墙上时间', () => {
    const instant = zonedTimeToUtc('Asia/Shanghai', 2026, 10, 11, 17, 30);
    expect(utcToZonedParts(instant, 'Asia/Shanghai').hour).toBe(17);
    expect(utcToZonedParts(instant, 'UTC').hour).toBe(9);
  });
});

describe('年度理论可成立天数', () => {
  it('季节窗口外的日期直接判定为不可成立', () => {
    const timing = baseTiming({ seasonWindow: { fromMonth: 9, toMonth: 3 } });
    expect(theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-07-01', timing)).toBe(false);
    expect(theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-11-01', timing)).toBe(true);
  });

  it('极严的仰角区间会显著减少可成立天数（说明可满足性检查有意义）', () => {
    // 用普通锚点（不带锚点自带仰角），timing.elevationRange 才是判定口径
    const loose = baseTiming({ timeAnchor: 'sunset_minus', elevationRange: [-4, 10] });
    const strict = baseTiming({ timeAnchor: 'sunset_minus', elevationRange: [-4.02, -3.98] });
    const count = (t: TimingDto) =>
      Array.from({ length: 60 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 8, 1 + i));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
          d.getUTCDate(),
        ).padStart(2, '0')}`;
        return theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, key, t);
      }).filter(Boolean).length;
    expect(count(loose)).toBeGreaterThan(count(strict));
  });

  it('理论判定与窗口判定共用仰角口径：黄金时刻锚点的自带仰角优先生效', () => {
    // golden_pm 自带 [-4,6]：即使 timing 把仰角放宽到 [-90,90]，可成立天数也不变；
    // 这是与 decideDayWindow 统一后的口径（旧实现曾在此忽略锚点自带区间，
    // 导致理论日历与单日判定对同一张卡给出不同结论）。
    const defaultRange = baseTiming({ timeAnchor: 'golden_pm' });
    const widened = baseTiming({ timeAnchor: 'golden_pm', elevationRange: [-90, 90] });
    const count = (t: TimingDto) =>
      Array.from({ length: 60 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 8, 1 + i));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
          d.getUTCDate(),
        ).padStart(2, '0')}`;
        return theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, key, t);
      }).filter(Boolean).length;
    expect(count(widened)).toBe(count(defaultRange));
    expect(count(defaultRange)).toBeGreaterThan(0);
  });
});
