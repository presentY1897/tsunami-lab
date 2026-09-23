// 소행성 충돌 발생원. 프로토타입 2의 물리(Collins 외 2005 크레이터, Ward & Asphaug 1/r 감쇠)를 중첩 격자에 맞게 옮겼다.
//
// 격자마다 공동을 따로 만든다. 공동 반지름이 셀보다 작으면 셀 크기로 넓히고 부피를 보존한다. 그러면 진폭이 크게 줄므로,
// 1차원 방사형 선형 모형으로 같은 공동을 미리 돌려 보고 기준 거리에서의 파고가 Ward & Asphaug 값과 맞도록 진폭을 조정한다.
// 기준 거리는 모든 단계에 같게 잡는다(전 지구 격자 셀의 여섯 배). 그래야 단계 사이 경계에서 파고가 어긋나지 않는다.
// 천수방정식은 1/√r로 줄지만 실제 충돌파는 분산 때문에 1/r에 가깝다. 그 차이는 기준 거리 밖에서 √(r₀/r) 배율로 메운다.
import { transientCraterDiameter, type ImpactParams } from '../../../src/physics/impact';

const GRAVITY = 9.81;

export interface ImpactModel {
  params: ImpactParams;
  /** 수중 과도 크레이터 지름(m). */
  craterDiameter: number;
  cavityDepth: number;
  waterDepth: number;
  energyMt: number;
  /** 보정 기준 거리(m). 이 거리에서의 파고를 Ward & Asphaug 값에 맞춘다. 이 밖에서는 √(기준/r) 배율을 곱한다. */
  refRadius: number;
  /** 기준 거리에서의 목표 파고(m). */
  targetAmp: number;
  /** 격자 셀 크기(m)에 맞는 공동을 만든다. 같은 셀 크기는 한 번만 계산한다. */
  cavityFor(cellM: number): CavityField;
}

export interface CavityField {
  sigma: number;
  amplitude: number;
  reachKm: number;
  /** 초기 수위(m). 보정 배율이 곱해져 있다. */
  eta0(lon: number, lat: number): number;
}

/** 부피가 보존되는 공동 + 림 형상. 중심에서 -2*A, 순부피 0. r2 = r² / (2σ²). */
const cavityShape = (r2: number): number => -2 * (1 - r2) * Math.exp(-r2);

/** 1차원 방사형 선형 천수방정식으로 기준 거리 고리의 최대 파고를 구한다. */
function radialPeak(depth: number, sigma: number, A0: number, dr: number, refRadius: number): number {
  const rMax = refRadius * 1.6;
  const n = Math.ceil(rMax / dr) + 2;
  const eta = new Float64Array(n), q = new Float64Array(n + 1), maxEta = new Float64Array(n);
  for (let i = 0; i < n; i++) { const r = (i + 0.5) * dr; eta[i] = A0 * cavityShape((r * r) / (2 * sigma * sigma)); }
  const c = Math.sqrt(GRAVITY * depth), dt = (0.5 * dr) / c, tEnd = (refRadius / c) * 1.6 + 240;
  for (let t = 0; t < tEnd; t += dt) {
    for (let i = 1; i < n; i++) q[i] -= (dt * GRAVITY * depth * (eta[i] - eta[i - 1])) / dr;
    q[0] = 0; q[n] = q[n - 1];
    for (let i = 0; i < n; i++) {
      const r = (i + 0.5) * dr;
      eta[i] -= (dt * ((i + 1) * dr * q[i + 1] - i * dr * q[i])) / (r * dr);
      if (eta[i] > maxEta[i]) maxEta[i] = eta[i];
    }
  }
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) { const r = (i + 0.5) * dr; if (r >= refRadius * 0.9 && r <= refRadius * 1.1) { sum += maxEta[i]; cnt++; } }
  return cnt > 0 ? sum / cnt : 0;
}

/** 충돌 지점의 수심(m)과 보정 기준 거리(m)로 모형을 만든다. 육지나 아주 얕은 곳이면 null. */
export function buildImpactModel(p: ImpactParams, waterDepth: number, refRadius: number): ImpactModel | null {
  if (waterDepth <= 1) return null;
  const Dtc = transientCraterDiameter(p), Rc = Dtc / 2;
  const dc = Math.min(Dtc / 2.83, waterDepth);
  const volume = (Math.PI * Rc * Rc * dc) / 2;
  // Ward & Asphaug: 공동 가장자리 파고가 거리에 반비례해 준다
  const Arw = Math.min(Dtc / 14.1, waterDepth);
  const targetAmp = (Arw * 0.75 * Dtc) / refRadius;
  const mass = (Math.PI / 6) * p.diameter ** 3 * p.density;
  const energyMt = (0.5 * mass * (p.velocity * 1000) ** 2) / 4.184e15;
  const cache = new Map<number, CavityField>();
  const kx = 111195 * Math.cos((p.lat * Math.PI) / 180), ky = 111195;
  return {
    params: p, craterDiameter: Dtc, cavityDepth: dc, waterDepth, energyMt, refRadius, targetAmp,
    cavityFor(cellM) {
      const key = Math.round(cellM);
      let f = cache.get(key);
      if (f) return f;
      const sigma = Math.max(Rc, 1.6 * cellM);
      const A0 = volume / (2 * Math.PI * sigma * sigma);
      const modeled = radialPeak(waterDepth, sigma, A0, Math.max(250, Math.min(cellM * 0.5, refRadius / 40)), refRadius);
      const amplitude = A0 * (modeled > 0 ? targetAmp / modeled : 1);
      const reach = sigma * 4.5;
      f = {
        sigma, amplitude, reachKm: reach / 1000,
        eta0(lon, lat) {
          let dLon = lon - p.lon;
          dLon = ((dLon + 540) % 360) - 180;
          const E = dLon * kx, N = (lat - p.lat) * ky, rr = E * E + N * N;
          return rr > reach * reach ? 0 : amplitude * cavityShape(rr / (2 * sigma * sigma));
        },
      };
      cache.set(key, f);
      return f;
    },
  };
}
