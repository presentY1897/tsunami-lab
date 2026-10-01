import { DEG } from '../geo/mercator';
import { GRAVITY } from './constants';

export interface ImpactParams {
  kind: 'impact';
  lon: number;
  lat: number;
  /** 소행성 지름(m). */
  diameter: number;
  /** 충돌 속도(km/s). */
  velocity: number;
  /** 밀도(kg/m³). */
  density: number;
  /** 입사각(도, 수평 기준). */
  angle: number;
}

/** 수중 과도 크레이터 지름. Collins, Melosh & Marcus (2005), 표적 밀도 1000 kg/m³. */
export function transientCraterDiameter(p: ImpactParams): number {
  const v = p.velocity * 1000;
  return (
    1.365 *
    (p.density / 1000) ** (1 / 3) *
    p.diameter ** 0.78 *
    v ** 0.44 *
    GRAVITY ** -0.22 *
    Math.sin(p.angle * DEG) ** (1 / 3)
  );
}
