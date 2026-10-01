import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Switch,
  Typography,
  message,
} from 'antd';
import { expectedAzimuth, type TimingDto, type TimeAnchor } from '@flil/shared';
import { useMeta, usePreviewTiming, useSaveTiming } from '../api/hooks.js';

interface Props {
  inspirationId: string;
  initial: TimingDto | null;
  /** 机位朝向，用于把光位角换算成期望太阳方位角 */
  cameraBearing: number | null;
  /** 最近一次标注得到的光位角（如果用户画了光位箭头） */
  lightBearingHint?: number | null;
  onSaved?: () => void;
}

const DEFAULT_TIMING: TimingDto = {
  timeAnchor: 'sunset_minus',
  anchorOffsetMin: 40,
  elevationRange: [-4, 10],
  azimuthRange: null,
  azimuthTolerance: 15,
  windowToleranceMin: 12,
  weatherProfile: { precipProbPctMax: 20, cloudCoverPct: { min: 20, max: 60 }, hardRequirements: ['precipProbPctMax'] },
  seasonWindow: null,
  notes: null,
};

export function TimingEditor({ inspirationId, initial, cameraBearing, lightBearingHint, onSaved }: Props) {
  const { data: meta } = useMeta();
  const [timing, setTiming] = useState<TimingDto>(initial ?? DEFAULT_TIMING);
  const [useAzimuth, setUseAzimuth] = useState(Boolean(initial?.azimuthRange));
  const preview = usePreviewTiming();
  const save = useSaveTiming();

  useEffect(() => {
    if (initial) {
      setTiming(initial);
      setUseAzimuth(Boolean(initial.azimuthRange));
    }
  }, [initial]);

  const expectedAz = useMemo(() => {
    if (cameraBearing === null || lightBearingHint === null || lightBearingHint === undefined) return null;
    // 方位角口径统一走 @flil/shared（expectedAzimuth：绕 360° 归一）
    return Math.round(expectedAzimuth(cameraBearing, lightBearingHint));
  }, [cameraBearing, lightBearingHint]);

  function patchTiming(patch: Partial<TimingDto>) {
    setTiming((t) => ({ ...t, ...patch }));
  }

  function patchWeather(patch: Record<string, unknown>) {
    setTiming((t) => ({ ...t, weatherProfile: { ...t.weatherProfile, ...patch } }));
  }

  function applyPreset(key: string) {
    const preset = meta?.weatherPresets.find((p) => p.key === key);
    if (preset) patchTiming({ weatherProfile: preset.profile as TimingDto['weatherProfile'] });
  }

  async function runPreview() {
    try {
      const res = await preview.mutateAsync({
        id: inspirationId,
        timing: useAzimuth ? timing : { ...timing, azimuthRange: null },
      });
      message.success('已按今天的数据试算');
      return res;
    } catch (err) {
      message.error((err as Error).message);
      return null;
    }
  }

  async function onSave() {
    try {
      const payload: TimingDto = useAzimuth
        ? timing
        : { ...timing, azimuthRange: null };
      const res = await save.mutateAsync({ id: inspirationId, timing: payload });
      const good = res.windows.filter((w) => w.verdict === 'good').length;
      message.success(`已保存，并重算了 7 天窗口（其中 ${good} 天可拍）`);
      onSaved?.();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  const p = preview.data;

  return (
    <Row gutter={16}>
      <Col xs={24} lg={14}>
        <Card size="small" title="① 时间锚（用太阳事件定义，而不是钟点）" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select
              style={{ width: '100%' }}
              value={timing.timeAnchor}
              onChange={(v: TimeAnchor) => patchTiming({ timeAnchor: v })}
              options={(meta?.timeAnchors ?? []).map((a) => ({ value: a.key, label: a.label }))}
            />
            {timing.timeAnchor === 'sunset_minus' ||
            timing.timeAnchor === 'sunrise_plus' ||
            timing.timeAnchor === 'fixed_clock' ? (
              <Space>
                <Typography.Text type="secondary">
                  {timing.timeAnchor === 'fixed_clock' ? '钟点（分钟数）' : '偏移（分钟）'}
                </Typography.Text>
                <InputNumber
                  min={timing.timeAnchor === 'fixed_clock' ? 0 : 0}
                  max={timing.timeAnchor === 'fixed_clock' ? 1439 : 240}
                  value={timing.anchorOffsetMin}
                  onChange={(v) => patchTiming({ anchorOffsetMin: Number(v ?? 0) })}
                />
              </Space>
            ) : null}
            <Space>
              <Typography.Text type="secondary">窗口容差 ±（分钟）</Typography.Text>
              <InputNumber
                min={1}
                max={180}
                value={timing.windowToleranceMin}
                onChange={(v) => patchTiming({ windowToleranceMin: Number(v ?? 12) })}
              />
            </Space>
            <Space>
              <Typography.Text type="secondary">季节窗口</Typography.Text>
              <Select
                style={{ width: 220 }}
                value={timing.seasonWindow ? 'custom' : 'none'}
                onChange={(v) =>
                  patchTiming({ seasonWindow: v === 'none' ? null : { fromMonth: 9, toMonth: 3 } })
                }
                options={[
                  { value: 'none', label: '全年' },
                  { value: 'custom', label: '9 月 – 次年 3 月' },
                ]}
              />
            </Space>
          </Space>
        </Card>

        <Card size="small" title="② 光位（可复现的关键）" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Switch checked={useAzimuth} onChange={setUseAzimuth} />
              <Typography.Text>约束太阳方位角</Typography.Text>
            </Space>
            {useAzimuth ? (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  期望方位角 = 拍摄朝向（{cameraBearing ?? '未设置'}°）+ 光位角。
                  {expectedAz !== null
                    ? ` 根据你画的光位箭头 ${Math.round(lightBearingHint!)}°，系统建议 ${expectedAz}°±${timing.azimuthTolerance}°。`
                    : ' 还没有光位标注时，可以手动填方位角。'}
                </Typography.Text>
                <Space>
                  <Typography.Text type="secondary">方位角中心</Typography.Text>
                  <InputNumber
                    min={0}
                    max={360}
                    value={timing.azimuthRange?.[0] ?? 265}
                    onChange={(v) => {
                      const center = Number(v ?? 265);
                      patchTiming({ azimuthRange: [center, center] });
                    }}
                  />
                  <Typography.Text type="secondary">容差 ±{timing.azimuthTolerance}°</Typography.Text>
                  <Slider
                    style={{ width: 140 }}
                    min={5}
                    max={45}
                    value={timing.azimuthTolerance}
                    onChange={(v) => patchTiming({ azimuthTolerance: v })}
                  />
                </Space>
              </>
            ) : (
              <Typography.Text type="secondary">不约束光位：任何太阳方位角都算命中。</Typography.Text>
            )}
          </Space>
        </Card>

        <Card size="small" title="③ 天气画像" style={{ marginBottom: 12 }}>
          <Space wrap style={{ marginBottom: 10 }}>
            {(meta?.weatherPresets ?? []).map((preset) => (
              <Button key={preset.key} size="small" onClick={() => applyPreset(preset.key)} title={preset.description}>
                {preset.name}
              </Button>
            ))}
          </Space>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Typography.Text type="secondary">云量区间 %</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.cloudCoverPct?.min ?? 0}
                onChange={(v) =>
                  patchWeather({ cloudCoverPct: { min: Number(v ?? 0), max: timing.weatherProfile.cloudCoverPct?.max ?? 100 } })
                }
              />
              <Typography.Text>–</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.cloudCoverPct?.max ?? 100}
                onChange={(v) =>
                  patchWeather({ cloudCoverPct: { min: timing.weatherProfile.cloudCoverPct?.min ?? 0, max: Number(v ?? 100) } })
                }
              />
            </Space>
            <Space>
              <Typography.Text type="secondary">降水概率上限 %</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.precipProbPctMax ?? 20}
                onChange={(v) => patchWeather({ precipProbPctMax: Number(v ?? 20) })}
              />
              <Typography.Text type="secondary">（默认按硬性项处理：超出即判"不可拍"）</Typography.Text>
            </Space>
            <Space>
              <Typography.Text type="secondary">能见度下限 km</Typography.Text>
              <InputNumber
                min={0}
                max={50}
                value={timing.weatherProfile.visibilityKmMin ?? 8}
                onChange={(v) => patchWeather({ visibilityKmMin: Number(v ?? 8) })}
              />
              <Typography.Text type="secondary">风速上限 m/s</Typography.Text>
              <InputNumber
                min={0}
                max={40}
                value={timing.weatherProfile.windSpeedMax ?? 8}
                onChange={(v) => patchWeather({ windSpeedMax: Number(v ?? 8) })}
              />
            </Space>
          </Space>
        </Card>

        <Space>
          <Button type="primary" loading={save.isPending} onClick={onSave}>
            保存并重算窗口
          </Button>
          <Button loading={preview.isPending} onClick={runPreview}>
            用今天的数据试算
          </Button>
        </Space>
      </Col>

      <Col xs={24} lg={10}>
        <Card size="small" title="今天的锚点长什么样" style={{ marginBottom: 12 }}>
          {p ? (
            <>
              <Descriptions column={1} size="small">
                <Descriptions.Item label="锚点时刻">{p.anchorLocal ?? '该日无解'}</Descriptions.Item>
                <Descriptions.Item label="日出 / 日落">
                  {p.sunEvents.sunrise ?? '—'} / {p.sunEvents.sunset ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label="黄金时刻（昏）">{p.sunEvents.goldenPm ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="蓝调时刻（昏）">{p.sunEvents.bluePm ?? '—'}</Descriptions.Item>
              </Descriptions>
              {p.notes.length ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {p.notes.join('；')}
                </Typography.Text>
              ) : null}
            </>
          ) : (
            <Typography.Text type="secondary">点"用今天的数据试算"，看看这个锚点对应今天几点。</Typography.Text>
          )}
        </Card>

        <Card size="small" title="可满足性检查（避免设出永远不成立的严条件）">
          {p ? (
            <>
              <Space size="large">
                <Statistic title={`未来 ${p.satisfiability.total} 天可能成立`} value={p.satisfiability.satisfied} />
                <Statistic title="比例" value={(p.satisfiability.ratio * 100).toFixed(0)} suffix="%" />
              </Space>
              <Divider style={{ margin: '12px 0' }} />
              {p.satisfiability.advice ? (
                <Alert
                  type={p.satisfiability.satisfied === 0 ? 'warning' : 'info'}
                  showIcon
                  message={p.satisfiability.advice}
                />
              ) : (
                <Alert type="success" showIcon message="条件可满足性正常，未来 7 天有可拍机会。" />
              )}
            </>
          ) : (
            <Typography.Text type="secondary">先试算一次，再看建议。</Typography.Text>
          )}
        </Card>
      </Col>
    </Row>
  );
}
