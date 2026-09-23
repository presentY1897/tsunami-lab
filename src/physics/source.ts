import type { LevelDem } from '../geo/dem';
import { cellLat, cellLon, cellSizeAtRow, type LonLatBox } from '../geo/grid';
import { DEG } from '../geo/mercator';
import { KM_PER_DEG } from './constants';
import { buildImpactCavity, buildImpactField, type ImpactField, type ImpactParams } from './impact';
import { buildQuakeField, type QuakeField, type QuakeParams } from './quake';

export type SourceParams = QuakeParams | ImpactParams;

export interface PreparedSource {
  params: SourceParams;
  quake?: QuakeField;
  impact?: ImpactField;
  /** 충돌 지점이 육지라 쓰나미가 없는 경우. */
  noTsunami: boolean;
}

/** 격자 계획에 쓸 발생원의 대략적 범위. DEM을 받기 전에 필요하므로 지형 없이 계산한다. */
export function sourceExtent(p: SourceParams): LonLatBox {
  if (p.kind === 'quake') {
    const q = buildQuakeField(p);
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const [lon, lat] of q.outline) {
      west = Math.min(west, lon); east = Math.max(east, lon);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
    return { west, east, south, north };
  }
  const r = 1.0;
  return { west: p.lon - r / Math.cos(p.lat * DEG), east: p.lon + r / Math.cos(p.lat * DEG), south: p.lat - r, north: p.lat + r };
}

export function prepareSource(p: SourceParams, coarse: LevelDem): PreparedSource {
  if (p.kind === 'quake') return { params: p, quake: buildQuakeField(p), noTsunami: false };
  const g = coarse.grid;
  // 충돌 지점의 수심과 거친 격자의 셀 크기로 공동을 정한다
  let best = -1, bd = Infinity;
  for (let j = 0; j < g.ny; j++) {
    const dLat = cellLat(g, j) - p.lat;
    if (Math.abs(dLat) > 0.2) continue;
    for (let i = 0; i < g.nx; i++) {
      const dLon = cellLon(g, i) - p.lon;
      const dd = dLat * dLat + dLon * dLon;
      if (dd < bd) { bd = dd; best = j * g.nx + i; }
    }
  }
  const depth = best >= 0 && coarse.wet0[best] ? -coarse.bed[best] : 0;
  const j0 = best >= 0 ? Math.floor(best / g.nx) : 0;
  const cavity = buildImpactCavity(p, depth, cellSizeAtRow(g, j0));
  if (!cavity) return { params: p, noTsunami: true };
  return { params: p, impact: buildImpactField(p, cavity), noTsunami: false };
}

export interface RasterizedSource {
  /** 지각 변동을 반영한 지반 표고. */
  bed: Float32Array;
  /** 초기 수위. 마른 셀은 지반 표고와 같다. */
  eta0: Float32Array;
  maxUp: number;
  maxDown: number;
}

/**
 * 발생원을 한 단계의 격자에 올린다. 변위장은 수 km 규모로 매끄러우므로 약 1 km 간격의 성긴 격자점에서만
 * 계산하고 쌍선형 보간한다. 세밀 격자에서 Okada 식을 셀마다 푸는 비용을 피하기 위해서다.
 * 지진은 해저와 육지를 함께 들어올리거나 가라앉힌다. 그래서 지반 표고도 같이 바꾼다(해안 침강이 침수를 키운다).
 */
export function rasterizeSource(src: PreparedSource, dem: LevelDem): RasterizedSource {
  const g = dem.grid;
  const { nx, ny } = g;
  const bed = new Float32Array(dem.bed);
  const eta0 = new Float32Array(nx * ny);
  const field = src.quake ? (lon: number, lat: number) => src.quake!.uz(lon, lat)
    : src.impact ? (lon: number, lat: number) => src.impact!.eta0(lon, lat) : null;
  let maxUp = 0, maxDown = 0;

  if (field) {
    const p = src.params;
    const reachKm = src.quake ? src.quake.reachKm : src.impact!.reachKm;
    const cell = cellSizeAtRow(g, ny >> 1);
    const smooth = src.quake ? 1000 : Math.max(250, src.impact!.cavity.sigma / 8);
    const step = Math.max(1, Math.min(16, Math.round(smooth / cell)));
    const lx = Math.ceil((nx - 1) / step) + 1, ly = Math.ceil((ny - 1) / step) + 1;
    const lat = new Float32Array(lx * ly);
    const lonOf = new Float64Array(lx), latOf = new Float64Array(ly);
    for (let a = 0; a < lx; a++) lonOf[a] = cellLon(g, Math.min(a * step, nx - 1 + step));
    for (let b = 0; b < ly; b++) latOf[b] = cellLat(g, Math.min(b * step, ny - 1 + step));
    const kx = KM_PER_DEG * Math.cos(p.lat * DEG);
    let any = false;
    for (let b = 0; b < ly; b++) {
      if (Math.abs(latOf[b] - p.lat) * KM_PER_DEG > reachKm) continue;
      for (let a = 0; a < lx; a++) {
        if (Math.abs(lonOf[a] - p.lon) * kx > reachKm) continue;
        const v = field(lonOf[a], latOf[b]);
        if (v !== 0) { lat[b * lx + a] = v; any = true; }
      }
    }
    if (any) {
      for (let j = 0; j < ny; j++) {
        const b0 = Math.min(ly - 2, Math.floor(j / step)), ty = j / step - b0;
        for (let i = 0; i < nx; i++) {
          const a0 = Math.min(lx - 2, Math.floor(i / step)), tx = i / step - a0;
          const o = b0 * lx + a0;
          const v = (lat[o] * (1 - tx) + lat[o + 1] * tx) * (1 - ty) + (lat[o + lx] * (1 - tx) + lat[o + lx + 1] * tx) * ty;
          eta0[j * nx + i] = v;
        }
      }
    }
  }

  // 물기둥은 수심보다 짧은 파장의 해저 변위를 수면에 전달하지 못한다(Kajiura 효과).
  // 셀이 1 km보다 큰 격자에서는 격자 크기의 요철이 수치 잔물결을 만들기도 하므로 가볍게 평활화한다.
  if (field && cellSizeAtRow(g, ny >> 1) > 1000) smoothField(eta0, nx, ny, 2);

  const isQuake = !!src.quake;
  for (let k = 0; k < eta0.length; k++) {
    const d = eta0[k];
    if (isQuake) bed[k] += d; // 지반도 같이 움직인다
    if (dem.wet0[k]) {
      const e = Math.max(d, bed[k]); // 공동이 해저보다 깊을 수는 없다
      eta0[k] = e;
      if (e > maxUp) maxUp = e;
      if (e < maxDown) maxDown = e;
    } else {
      eta0[k] = bed[k];
    }
  }
  return { bed, eta0, maxUp, maxDown };
}

/** 3×3 가중 평활화(1-2-1). 변위장 전체에 적용한다. */
function smoothField(a: Float32Array, nx: number, ny: number, passes: number): void {
  const tmp = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    tmp.set(a);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        a[k] =
          (4 * tmp[k] + 2 * (tmp[k - 1] + tmp[k + 1] + tmp[k - nx] + tmp[k + nx]) +
            tmp[k - nx - 1] + tmp[k - nx + 1] + tmp[k + nx - 1] + tmp[k + nx + 1]) / 16;
      }
    }
  }
}
