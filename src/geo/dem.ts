import type { GridSpec } from './grid';
import { cellSizeAtRow } from './grid';
import { TILE_SIZE } from '../../app/src/geo/mercator';
import type { TileProvider } from './tiles';

export interface LevelDem {
  grid: GridSpec;
  /** 셀별 지반 표고(m). 바다는 음수. */
  bed: Float32Array;
  /** 처음부터 바다인 셀(외해와 이어진 0 m 미만 셀)은 1. */
  wet0: Uint8Array;
  /** 처음 해안선에서 육지 쪽으로의 거리(m). 바다 셀은 0. */
  shoreDist: Float32Array;
  maxDepth: number;
  wetFraction: number;
}

/** 전역 픽셀 창 [px0, px0+nx) × [py0, py0+ny)의 표고 모자이크. */
export async function fetchMosaic(
  provider: TileProvider,
  z: number,
  px0: number,
  py0: number,
  nx: number,
  ny: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array> {
  const tx0 = Math.floor(px0 / TILE_SIZE);
  const ty0 = Math.floor(py0 / TILE_SIZE);
  const tx1 = Math.floor((px0 + nx - 1) / TILE_SIZE);
  const ty1 = Math.floor((py0 + ny - 1) / TILE_SIZE);
  const out = new Float32Array(nx * ny);
  const jobs: Promise<void>[] = [];
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  let done = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        provider.getTile(z, tx, ty).then((tile) => {
          // 이 타일과 창이 겹치는 부분만 복사한다
          const gx0 = Math.max(px0, tx * TILE_SIZE);
          const gx1 = Math.min(px0 + nx, (tx + 1) * TILE_SIZE);
          const gy0 = Math.max(py0, ty * TILE_SIZE);
          const gy1 = Math.min(py0 + ny, (ty + 1) * TILE_SIZE);
          for (let gy = gy0; gy < gy1; gy++) {
            const src = (gy - ty * TILE_SIZE) * TILE_SIZE + (gx0 - tx * TILE_SIZE);
            const dst = (gy - py0) * nx + (gx0 - px0);
            out.set(tile.subarray(src, src + (gx1 - gx0)), dst);
          }
          onProgress?.(++done, total);
        }),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}

/**
 * 한 단계의 지반 표고를 만든다.
 * 줌이 수심 한계(maxBathyZoom) 이하이면 타일을 그대로 쓴다.
 * 그보다 높으면 육지는 해당 줌(SRTM 30 m 상세)에서, 수심은 maxBathyZoom 타일을 쌍선형 보간해서 합성한다.
 */
export async function buildLevelDem(
  provider: TileProvider,
  grid: GridSpec,
  onProgress?: (done: number, total: number) => void,
): Promise<LevelDem> {
  const { z, px0, py0, nx, ny } = grid;
  const land = await fetchMosaic(provider, z, px0, py0, nx, ny, onProgress);
  let bed: Float32Array;
  let wet0: Uint8Array;

  if (z <= provider.maxBathyZoom) {
    bed = land;
    wet0 = floodFillSea(nx, ny, (k) => bed[k] < 0, (k) => bed[k] < -seedDepth(z));
    // 바다로 판정된 셀은 최소 수심을 보장한다. 0에 가까운 수심은 수치적으로 의미가 없다.
    for (let k = 0; k < bed.length; k++) if (wet0[k] && bed[k] > -MIN_SEA_DEPTH) bed[k] = -MIN_SEA_DEPTH;
  } else {
    const f = 2 ** (z - provider.maxBathyZoom);
    const bz = provider.maxBathyZoom;
    const bx0 = Math.floor(px0 / f) - 1;
    const by0 = Math.floor(py0 / f) - 1;
    const bnx = Math.ceil((px0 + nx) / f) - bx0 + 2;
    const bny = Math.ceil((py0 + ny) / f) - by0 + 2;
    const bathy = await fetchMosaic(provider, bz, bx0, by0, bnx, bny);
    const sample = (i: number, j: number): number => {
      // 세밀 격자 셀 중심을 수심 격자의 셀 좌표로 옮겨 쌍선형 보간한다
      const u = (px0 + i + 0.5) / f - 0.5 - bx0;
      const v = (py0 + j + 0.5) / f - 0.5 - by0;
      const i0 = Math.max(0, Math.min(bnx - 2, Math.floor(u)));
      const j0 = Math.max(0, Math.min(bny - 2, Math.floor(v)));
      const tx = Math.max(0, Math.min(1, u - i0));
      const ty = Math.max(0, Math.min(1, v - j0));
      const a = bathy[j0 * bnx + i0], b = bathy[j0 * bnx + i0 + 1];
      const c = bathy[(j0 + 1) * bnx + i0], d = bathy[(j0 + 1) * bnx + i0 + 1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };
    const bsmp = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) bsmp[j * nx + i] = sample(i, j);
    // 고줌 타일의 바다는 SRTM 수역 마스크로 정확히 0 m다. 0 근처 셀만 바다 후보로 본다.
    // 저지대 육지의 SRTM 잡음(-2..2 m 정수)이 바다로 잘못 이어지는 것을 줄이기 위해서다.
    // 한편 해안선을 따라 -60 m, -300 m 같은 가짜 구덩이(SRTM 결함)가 있다. 실측으로 확인했다.
    // 이런 구덩이도 바다 후보에 넣어, 바다와 이어지면 주변 수심을 가진 바다가 되게 한다.
    const isCandidate = (k: number): boolean => Math.abs(land[k]) <= 0.5 || land[k] <= PIT_LEVEL;
    wet0 = floodFillSea(nx, ny, isCandidate, (k) => isCandidate(k) && bsmp[k] < -2);
    bed = land;
    for (let k = 0; k < bed.length; k++) {
      if (wet0[k]) bed[k] = Math.min(bsmp[k], -MIN_SEA_DEPTH);
      // 바다와 이어지지 않은 구덩이는 메운다. 그대로 두면 물을 삼키는 깊은 구멍이 된다.
      // 대가로, 해수면보다 3 m 넘게 낮은 실제 저지대(간척지 등)도 0 m로 평평해진다.
      else if (bed[k] <= PIT_LEVEL) bed[k] = MIN_DRY_LAND;
      // 바다가 아닌데 0 m 아래인 셀은 대부분 SRTM 잡음이다. 그대로 두면 계산을 시작하자마자 옆 바다의 물이 흘러든다.
      else if (bed[k] < MIN_DRY_LAND) bed[k] = MIN_DRY_LAND;
    }
  }

  let maxDepth = 0;
  let wetCount = 0;
  for (let k = 0; k < bed.length; k++) {
    if (wet0[k]) {
      wetCount++;
      if (-bed[k] > maxDepth) maxDepth = -bed[k];
    }
  }
  const shoreDist = shoreDistance(grid, wet0);
  return { grid, bed, wet0, shoreDist, maxDepth, wetFraction: wetCount / bed.length };
}

export const MIN_SEA_DEPTH = 1.0;
/** 고줌 타일에서 이보다 낮은 육지 값은 자료 결함(구덩이)으로 본다. */
const PIT_LEVEL = -3;
/** 세밀 격자에서 바다가 아닌 셀의 최소 표고(m). */
const MIN_DRY_LAND = 0.2;

/** 씨앗으로 삼을 "확실한 바다"의 수심. 거친 격자일수록 크게 잡아 내륙 저지대가 씨앗이 되지 않게 한다. */
const seedDepth = (z: number): number => (z <= 7 ? 50 : z <= 9 ? 10 : 3);

/** 씨앗 셀에서 시작해 후보 셀을 4방향으로 채운다. 외해와 이어진 셀만 바다가 된다. */
export function floodFillSea(
  nx: number,
  ny: number,
  candidate: (k: number) => boolean,
  seed: (k: number) => boolean,
): Uint8Array {
  const wet = new Uint8Array(nx * ny);
  const stack = new Int32Array(nx * ny);
  let sp = 0;
  for (let k = 0; k < wet.length; k++) {
    if (seed(k)) {
      wet[k] = 1;
      stack[sp++] = k;
    }
  }
  while (sp > 0) {
    const k = stack[--sp];
    const i = k % nx;
    const j = (k - i) / nx;
    if (i > 0 && !wet[k - 1] && candidate(k - 1)) { wet[k - 1] = 1; stack[sp++] = k - 1; }
    if (i < nx - 1 && !wet[k + 1] && candidate(k + 1)) { wet[k + 1] = 1; stack[sp++] = k + 1; }
    if (j > 0 && !wet[k - nx] && candidate(k - nx)) { wet[k - nx] = 1; stack[sp++] = k - nx; }
    if (j < ny - 1 && !wet[k + nx] && candidate(k + nx)) { wet[k + nx] = 1; stack[sp++] = k + nx; }
  }
  return wet;
}

/** 두 번 훑는 chamfer 거리 변환. 바다 셀에서 육지 쪽으로의 거리(m). */
export function shoreDistance(grid: GridSpec, wet0: Uint8Array): Float32Array {
  const { nx, ny } = grid;
  const d = new Float32Array(nx * ny);
  const BIG = 1e9;
  for (let k = 0; k < d.length; k++) d[k] = wet0[k] ? 0 : BIG;
  const D1 = 1, D2 = Math.SQRT2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = d[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + D1);
      if (j > 0) {
        v = Math.min(v, d[k - nx] + D1);
        if (i > 0) v = Math.min(v, d[k - nx - 1] + D2);
        if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + D2);
      }
      d[k] = v;
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let v = d[k];
      if (v === 0) continue;
      if (i < nx - 1) v = Math.min(v, d[k + 1] + D1);
      if (j < ny - 1) {
        v = Math.min(v, d[k + nx] + D1);
        if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + D2);
        if (i > 0) v = Math.min(v, d[k + nx - 1] + D2);
      }
      d[k] = v;
    }
  }
  for (let j = 0; j < ny; j++) {
    const s = cellSizeAtRow(grid, j);
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      d[k] = d[k] >= BIG ? -1 : d[k] * s;
    }
  }
  return d;
}
