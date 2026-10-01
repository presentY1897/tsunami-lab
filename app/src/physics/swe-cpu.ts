// 비선형 천수방정식의 CPU 기준 구현. 앱의 GPU 셰이더(../sim/shaders.ts)와 프로토타입의 셰이더(src/gpu/shaders.ts)가 같은 식을 구현하며, 이 파일이 검증의 기준이다.
// 앱 번들에는 들어가지 않는다. 단위 테스트와 dev/의 GPU 검증 페이지가 쓴다.
//
// 기법: Stelling & Duinmeijer (2003) 계열의 엇갈린 격자(Arakawa C) 기법.
//  - eta는 셀 중심, u는 셀의 동쪽 면, v는 셀의 남쪽 면에 둔다. 행 0이 북쪽, v는 남쪽(+j)이 양수.
//  - 면의 수심은 풍상측 수위에서 두 셀 중 높은 지반을 뺀 값. 이렇게 하면 수심이 음수가 되지 않고
//    젖음/마름을 특별한 분기 없이 다룰 수 있다.
//  - 시간 적분은 forward-backward: 운동량을 먼저 갱신하고 새 유속으로 연속방정식을 푼다.
//    선형 항에 대해 수치 감쇠가 없어서 먼 거리 전파에서 파고가 깎이지 않는다.
//  - 마른 셀의 eta는 지반 표고와 같게 둔다(수심 0).
//  - Mercator 격자이므로 행마다 셀 크기 s_j가 다르다. 발산은 (1/s²) d(s F)/dj 꼴이 된다.

import { GRAVITY } from './constants';

export interface SweGrid {
  nx: number;
  ny: number;
  /** 지반 표고(m). */
  bed: Float32Array;
  /** Manning 조도계수. */
  manning: Float32Array;
  /** 행 j의 셀 크기(m). */
  rowSize: Float64Array;
  /** 행 j와 j+1 사이 면의 셀 크기(m). 길이 ny. */
  faceSize: Float64Array;
}

export interface SweState {
  eta: Float32Array;
  u: Float32Array;
  v: Float32Array;
  t: number;
}

export interface SweOptions {
  /** 이 수심 이하의 면은 말랐다고 본다(m). */
  dryEps: number;
  /** Froude 수 상한. 얇은 흐름에서 비물리적으로 큰 유속을 막는다. */
  maxFroude: number;
}

export const DEFAULT_SWE_OPTIONS: SweOptions = { dryEps: 0.01, maxFroude: 2.5 };
/** 마찰 항의 분모가 발산하지 않도록 하는 최소 수심(m). */
export const FRICTION_MIN_DEPTH = 0.02;

export function uniformGrid(nx: number, ny: number, cell: number, bed: Float32Array, n = 0.025): SweGrid {
  return {
    nx,
    ny,
    bed,
    manning: new Float32Array(nx * ny).fill(n),
    rowSize: new Float64Array(ny).fill(cell),
    faceSize: new Float64Array(ny).fill(cell),
  };
}

export function createState(g: SweGrid, eta0?: Float32Array): SweState {
  const n = g.nx * g.ny;
  const eta = new Float32Array(n);
  for (let k = 0; k < n; k++) eta[k] = Math.max(eta0 ? eta0[k] : 0, g.bed[k]);
  return { eta, u: new Float32Array(n), v: new Float32Array(n), t: 0 };
}

/** 안정 조건을 만족하는 시간 간격. 2차원 엇갈린 격자의 CFL 한계는 s / (c √2). */
export function stableDt(g: SweGrid, maxDepth: number, safety = 0.6): number {
  let sMin = Infinity;
  for (let j = 0; j < g.ny; j++) sMin = Math.min(sMin, g.rowSize[j]);
  return (safety * sMin) / Math.sqrt(2 * GRAVITY * Math.max(maxDepth, 1));
}

/** 풍상측 수위로 구한 면 수심. 음수면 0. */
function faceDepth(vel: number, etaA: number, etaB: number, zA: number, zB: number): number {
  const zf = zA > zB ? zA : zB;
  const e = vel > 0 ? etaA : vel < 0 ? etaB : etaA > etaB ? etaA : etaB;
  const h = e - zf;
  return h > 0 ? h : 0;
}

export function stepSwe(g: SweGrid, s: SweState, dt: number, opt: SweOptions = DEFAULT_SWE_OPTIONS): void {
  const { nx, ny, bed, manning, rowSize, faceSize } = g;
  const { eta, u, v } = s;
  const n = nx * ny;
  const un = new Float32Array(n);
  const vn = new Float32Array(n);
  const at = (a: Float32Array, i: number, j: number): number => {
    const ii = i < 0 ? 0 : i >= nx ? nx - 1 : i;
    const jj = j < 0 ? 0 : j >= ny ? ny - 1 : j;
    return a[jj * nx + ii];
  };

  // 1. 운동량
  for (let j = 0; j < ny; j++) {
    const sj = rowSize[j];
    const sf = faceSize[j];
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      // 동쪽 면의 u
      if (i < nx - 1) {
        const uc = u[k];
        const hf = faceDepth(uc, eta[k], eta[k + 1], bed[k], bed[k + 1]);
        if (hf > opt.dryEps) {
          const vbar = 0.25 * (at(v, i, j) + at(v, i + 1, j) + at(v, i, j - 1) + at(v, i + 1, j - 1));
          const dudx = uc > 0 ? uc - at(u, i - 1, j) : at(u, i + 1, j) - uc;
          const dudy = vbar > 0 ? uc - at(u, i, j - 1) : at(u, i, j + 1) - uc;
          let un1 = uc - (dt * (uc * dudx + vbar * dudy)) / sj - (dt * GRAVITY * (eta[k + 1] - eta[k])) / sj;
          const nm = 0.5 * (manning[k] + manning[k + 1]);
          const hfr = hf > FRICTION_MIN_DEPTH ? hf : FRICTION_MIN_DEPTH;
          un1 /= 1 + (dt * GRAVITY * nm * nm * Math.sqrt(uc * uc + vbar * vbar)) / Math.pow(hfr, 4 / 3);
          const cap = opt.maxFroude * Math.sqrt(GRAVITY * hf);
          un[k] = un1 > cap ? cap : un1 < -cap ? -cap : un1;
        }
      }
      // 남쪽 면의 v
      if (j < ny - 1) {
        const vc = v[k];
        const hf = faceDepth(vc, eta[k], eta[k + nx], bed[k], bed[k + nx]);
        if (hf > opt.dryEps) {
          const ubar = 0.25 * (at(u, i, j) + at(u, i - 1, j) + at(u, i, j + 1) + at(u, i - 1, j + 1));
          const dvdx = ubar > 0 ? vc - at(v, i - 1, j) : at(v, i + 1, j) - vc;
          const dvdy = vc > 0 ? vc - at(v, i, j - 1) : at(v, i, j + 1) - vc;
          let vn1 = vc - (dt * (ubar * dvdx + vc * dvdy)) / sf - (dt * GRAVITY * (eta[k + nx] - eta[k])) / sf;
          const nm = 0.5 * (manning[k] + manning[k + nx]);
          const hfr = hf > FRICTION_MIN_DEPTH ? hf : FRICTION_MIN_DEPTH;
          vn1 /= 1 + (dt * GRAVITY * nm * nm * Math.sqrt(vc * vc + ubar * ubar)) / Math.pow(hfr, 4 / 3);
          const cap = opt.maxFroude * Math.sqrt(GRAVITY * hf);
          vn[k] = vn1 > cap ? cap : vn1 < -cap ? -cap : vn1;
        }
      }
    }
  }

  // 2. 연속방정식. 새 유속과 풍상측 면 수심으로 유량을 만든다.
  const en = new Float32Array(n);
  for (let j = 0; j < ny; j++) {
    const sj = rowSize[j];
    const sfS = faceSize[j];
    const sfN = j > 0 ? faceSize[j - 1] : faceSize[0];
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let fe = 0, fw = 0, fs = 0, fn = 0;
      if (i < nx - 1) fe = un[k] * faceDepth(un[k], eta[k], eta[k + 1], bed[k], bed[k + 1]);
      if (i > 0) fw = un[k - 1] * faceDepth(un[k - 1], eta[k - 1], eta[k], bed[k - 1], bed[k]);
      if (j < ny - 1) fs = vn[k] * faceDepth(vn[k], eta[k], eta[k + nx], bed[k], bed[k + nx]) * sfS;
      if (j > 0) fn = vn[k - nx] * faceDepth(vn[k - nx], eta[k - nx], eta[k], bed[k - nx], bed[k]) * sfN;
      const e = eta[k] - dt * ((fe - fw) / sj + (fs - fn) / (sj * sj));
      en[k] = e > bed[k] ? e : bed[k];
    }
  }
  s.eta = en;
  s.u = un;
  s.v = vn;
  s.t += dt;
}

/** 전체 물의 부피(m³). 질량 보존 검증에 쓴다. */
export function totalVolume(g: SweGrid, s: SweState): number {
  let vol = 0;
  for (let j = 0; j < g.ny; j++) {
    const a = g.rowSize[j] * g.rowSize[j];
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      vol += (s.eta[k] - g.bed[k]) * a;
    }
  }
  return vol;
}
