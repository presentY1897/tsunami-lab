import { DEG } from '../geo/mercator';
import { GRAVITY, KM_PER_DEG } from './constants';

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

export interface ImpactCavity {
  /** 수중 과도 크레이터 지름(m). Collins 외 (2005). */
  craterDiameter: number;
  /** 공동 깊이(m). 수심으로 상한을 둔다. */
  cavityDepth: number;
  /** 충돌 지점 수심(m). */
  waterDepth: number;
  /** 격자에 넣는 공동의 Gaussian 폭(m). 실제 공동 반지름과 격자 해상도 중 큰 값. */
  sigma: number;
  /** 원거리 감쇠 보정의 기준 반지름(m). */
  refRadius: number;
  /** 1차원 방사형 사전 보정으로 구한 초기 진폭 배율. */
  gainC: number;
  /** 보정 목표: 60 km 지점의 Ward & Asphaug 파고(m). */
  targetAt60km: number;
  energyMt: number;
}

export const CAL_RADIUS = 60000;

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

/** 부피가 보존되는 공동 + 림 형상. 중심에서 -2*A0, 순부피 0. r2 = r² / (2σ²). */
const cavityShape = (r2: number): number => -2 * (1 - r2) * Math.exp(-r2);

/**
 * 1차원 방사형 선형 천수방정식으로 60 km 고리의 최대 파고를 미리 구한다.
 * 천수방정식은 1/√r로 줄지만 실제 충돌파는 분산 때문에 1/r에 가깝게 준다(Ward & Asphaug).
 * 그 차이를 √(r_ref / r) 보정으로 메우고, 60 km 지점 값이 Ward & Asphaug 식과 맞도록 초기 진폭을 조정한다.
 */
function radialCalibration(depth: number, sigma: number, A0: number, dr: number, refRadius: number): number {
  const rMax = CAL_RADIUS * 1.6;
  const n = Math.ceil(rMax / dr) + 2;
  const eta = new Float64Array(n); // 셀 중심 r = (i + 0.5) dr
  const q = new Float64Array(n + 1); // 셀 경계 r = i dr 에서의 방사 유속 h*u
  const maxEta = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) * dr;
    eta[i] = A0 * cavityShape((r * r) / (2 * sigma * sigma));
  }
  const c = Math.sqrt(GRAVITY * depth);
  const dt = (0.5 * dr) / c;
  const tEnd = (CAL_RADIUS / c) * 1.6 + 240;
  for (let t = 0; t < tEnd; t += dt) {
    for (let i = 1; i < n; i++) q[i] -= (dt * GRAVITY * depth * (eta[i] - eta[i - 1])) / dr;
    q[0] = 0;
    q[n] = q[n - 1];
    for (let i = 0; i < n; i++) {
      const r = (i + 0.5) * dr;
      eta[i] -= (dt * ((i + 1) * dr * q[i + 1] - i * dr * q[i])) / (r * dr);
      if (eta[i] > maxEta[i]) maxEta[i] = eta[i];
    }
  }
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) * dr;
    if (r < CAL_RADIUS * 0.9 || r > CAL_RADIUS * 1.1) continue;
    sum += maxEta[i] * Math.min(1, Math.sqrt(refRadius / r));
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

export function buildImpactCavity(p: ImpactParams, waterDepth: number, coarseCellM: number): ImpactCavity | null {
  if (waterDepth <= 1) return null; // 육지나 아주 얕은 곳에 떨어지면 쓰나미를 만들지 않는다
  const Dtc = transientCraterDiameter(p);
  const Rc = Dtc / 2;
  const dc = Math.min(Dtc / 2.83, waterDepth);
  const volume = (Math.PI * Rc * Rc * dc) / 2;
  const sigma = Math.max(Rc, 1.6 * coarseCellM);
  const A0 = volume / (2 * Math.PI * sigma * sigma);
  const refRadius = Math.max(0.75 * Dtc, sigma);
  // Ward & Asphaug: 공동 가장자리 파고가 거리에 반비례해 준다
  const Arw = Math.min(Dtc / 14.1, waterDepth);
  const targetAt60km = (Arw * 0.75 * Dtc) / CAL_RADIUS;
  const modeled = radialCalibration(waterDepth, sigma, A0, Math.max(500, coarseCellM * 0.5), refRadius);
  const gainC = modeled > 0 ? targetAt60km / modeled : 1;
  const mass = (Math.PI / 6) * p.diameter ** 3 * p.density;
  const energyMt = (0.5 * mass * (p.velocity * 1000) ** 2) / 4.184e15;
  return { craterDiameter: Dtc, cavityDepth: dc, waterDepth, sigma, refRadius, gainC, targetAt60km, energyMt };
}

export interface ImpactField {
  cavity: ImpactCavity;
  reachKm: number;
  /** 초기 수면 변위(m). 보정 배율이 이미 곱해져 있다. */
  eta0(lon: number, lat: number): number;
}

export function buildImpactField(p: ImpactParams, cavity: ImpactCavity): ImpactField {
  const kx = KM_PER_DEG * 1000 * Math.cos(p.lat * DEG), ky = KM_PER_DEG * 1000;
  const Rc = cavity.craterDiameter / 2;
  const volume = (Math.PI * Rc * Rc * cavity.cavityDepth) / 2;
  const A0 = (volume / (2 * Math.PI * cavity.sigma * cavity.sigma)) * cavity.gainC;
  const reach = cavity.sigma * 4.5;
  return {
    cavity,
    reachKm: reach / 1000,
    eta0(lon, lat) {
      const E = (lon - p.lon) * kx, N = (lat - p.lat) * ky;
      const rr = E * E + N * N;
      if (rr > reach * reach) return 0;
      return A0 * cavityShape(rr / (2 * cavity.sigma * cavity.sigma));
    },
  };
}
