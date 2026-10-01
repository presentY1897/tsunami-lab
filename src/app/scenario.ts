import type { QualityName } from '../geo/domain';
import type { ImpactParams } from '../../app/src/physics/impact';
import type { QuakeParams } from '../../app/src/physics/quake';
import type { SourceParams } from '../physics/source';

export interface Scenario {
  source: SourceParams;
  /** 침수를 자세히 볼 관측 해안의 중심. */
  target: { lon: number; lat: number; name?: string };
  quality: QualityName;
  /** 육지의 Manning 조도계수. */
  manningLand: number;
  /** 계산할 시간(s). */
  duration: number;
}

export interface Preset {
  id: string;
  label: string;
  note: string;
  source: SourceParams;
  target: { lon: number; lat: number; name: string };
  duration: number;
  /** 관측 해안을 바라보는 카메라 방위(도). 바다에서 육지 쪽을 보게 잡는다. */
  bearing: number;
}

const quake = (p: Omit<QuakeParams, 'kind' | 'rake' | 'slipModel'> & Partial<QuakeParams>): QuakeParams => ({
  kind: 'quake', rake: 90, slipModel: 'tapered', ...p,
});
const impact = (p: Omit<ImpactParams, 'kind' | 'angle'> & Partial<ImpactParams>): ImpactParams => ({
  kind: 'impact', angle: 45, ...p,
});

export const PRESETS: Preset[] = [
  {
    id: 'tohoku2011',
    label: '2011 도호쿠 M9.0',
    note: '일본 해구 거대 지진. 센다이 평야가 내륙 5 km까지 잠겼다.',
    source: quake({ lon: 142.85, lat: 38.3, Mw: 9.0, strike: 193, dip: 14, topKm: 5 }),
    target: { lon: 140.97, lat: 38.17, name: '센다이 평야 (나토리)' },
    duration: 3 * 3600,
    bearing: 285,
  },
  {
    id: 'akita1983',
    label: '1983 동해 중부 M7.7',
    note: '아키타 앞바다 지진. 동해를 건너 한국 동해안 임원항에도 피해를 냈다.',
    source: quake({ lon: 139.0, lat: 40.4, Mw: 7.7, strike: 10, dip: 30, topKm: 2 }),
    target: { lon: 140.0, lat: 40.2, name: '아키타 노시로' },
    duration: 2 * 3600,
    bearing: 90,
  },
  {
    id: 'nankai',
    label: '난카이 가상 M8.7',
    note: '난카이 해곡에서 예상되는 거대 지진의 가상 시나리오.',
    source: quake({ lon: 135.5, lat: 33.0, Mw: 8.7, strike: 250, dip: 10, topKm: 5 }),
    target: { lon: 133.56, lat: 33.5, name: '고치' },
    duration: 3 * 3600,
    bearing: 0,
  },
  {
    id: 'eastsea-impact',
    label: '동해 소행성 500 m',
    note: '동해 한가운데에 지름 500 m 암석 소행성이 떨어지는 가상 시나리오.',
    source: impact({ lon: 134.0, lat: 39.5, diameter: 500, velocity: 20, density: 3000 }),
    target: { lon: 128.93, lat: 37.77, name: '강릉' },
    duration: 3 * 3600,
    bearing: 250,
  },
  {
    id: 'sumatra2004',
    label: '2004 수마트라 M9.1',
    note: '인도양 쓰나미. 반다아체가 가장 큰 피해를 입었다.',
    source: quake({ lon: 94.6, lat: 4.2, Mw: 9.1, strike: 329, dip: 8, topKm: 5 }),
    target: { lon: 95.3, lat: 5.55, name: '반다아체' },
    duration: 3 * 3600,
    bearing: 135,
  },
];

export const DEFAULT_SCENARIO: Scenario = {
  source: PRESETS[0].source,
  target: PRESETS[0].target,
  quality: 'medium',
  manningLand: 0.035,
  duration: PRESETS[0].duration,
};

export const MANNING_CHOICES: { value: number; label: string }[] = [
  { value: 0.02, label: '논밭과 평야' },
  { value: 0.035, label: '평야와 마을이 섞인 해안' },
  { value: 0.05, label: '주거지' },
  { value: 0.08, label: '밀집 도시' },
];
