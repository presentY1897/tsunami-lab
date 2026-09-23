import { buildQuakeField, type QuakeField, type QuakeParams } from '../../../src/physics/quake';
import type { SourceModel } from './source';
import { pxToLon, pyToLat } from '../../../src/geo/mercator';
import type { ChunkStore } from '../data/chunks';
import { planGlobal, planSource, type LevelSpec } from './plan';
import type { EarthGrid } from '../data/earth';
import type { Terrain } from '../terrain/terrain';
import type { GridInput } from './solver';

/**
 * 전 지구 계산 격자. 첫 화면에서 받은 39 km 자료를 그대로 쓴다. 경도 방향으로 이어지고, 남북 끝에서는 파도를 흡수한다.
 * 범위는 북극권과 남극권 사이(약 ±66도)다. 더 올라가면 Mercator 셀이 작아져 시간 간격이 줄고 계산량이 는다.
 * ±72도일 때 간격 22.5초, ±66도일 때 28초다. 극지의 쓰나미는 다루지 않는다.
 * 셀이 거칠어서 파도가 바다를 건너는 추이만 본다. 규모 8.5 아래의 지진은 단층이 몇 셀에 그쳐 실제보다 약하게 나온다.
 */
export const GLOBAL_ROW0 = 260;
export const GLOBAL_ROWS = 504;
/** 거친 격자에서 해안의 낮은 땅이 통째로 잠기는 것을 막는다. 침수는 이 격자에서 다루지 않는다. */
const LAND_FLOOR_M = 30;
/** 아주 얕은 바다 셀의 최소 수심(m). */
const MIN_DEPTH_M = 10;

export interface GlobalGrid {
  input: GridInput;
  zoom: number;
  lonOf(i: number): number;
  latOf(j: number): number;
  cellOf(lon: number, lat: number): [number, number];
}

export interface SourceSummary {
  lengthKm: number;
  widthKm: number;
  meanSlip: number;
  peakSlip: number;
  maxUp: number;
  maxDown: number;
  /** 단층 지표 투영의 네 꼭짓점. 앞의 두 점이 해구 쪽 변이다. */
  outline: [number, number][];
}

export function faultOutline(p: QuakeParams): QuakeField {
  return buildQuakeField(p);
}

/** 해저 경사를 읽어 단층 방향을 추정한다. 섭입대에서는 단층이 육지 쪽으로 기울므로, 지형이 높아지는 쪽을 경사 방향으로 본다. */
export function autoStrike(terrain: Terrain, lon: number, lat: number): number {
  const kLat = 1 / 111.195, kLon = kLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  let gx = 0, gy = 0;
  for (const d of [60, 120, 240]) {
    const w = 60 / d;
    const e = Math.min(terrain.base(lon + d * kLon, lat, 60), 500), wv = Math.min(terrain.base(lon - d * kLon, lat, 60), 500);
    const n = Math.min(terrain.base(lon, lat + d * kLat, 60), 500), s = Math.min(terrain.base(lon, lat - d * kLat, 60), 500);
    gx += w * (e - wv);
    gy += w * (n - s);
  }
  const dipDir = (Math.atan2(gx, gy) * 180) / Math.PI;
  return (((dipDir - 90) % 360) + 360) % 360;
}

export function buildGlobalGrid(earth: EarthGrid, source: SourceModel): { grid: GlobalGrid; source: SourceSummary } {
  const quake = source.params;
  const nx = earth.size, ny = GLOBAL_ROWS, z = earth.zoom;
  const bed = new Float32Array(nx * ny), eta0 = new Float32Array(nx * ny), wet0 = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const e = earth.elev[(GLOBAL_ROW0 + j) * nx + i], k = j * nx + i;
      if (e < 0) { wet0[k] = 1; bed[k] = Math.min(e, -MIN_DEPTH_M); } else bed[k] = Math.max(e, LAND_FLOOR_M);
    }
  }
  const lonOf = (i: number): number => pxToLon(i + 0.5, z);
  const latOf = (j: number): number => pyToLat(GLOBAL_ROW0 + j + 0.5, z);

  // 초기 변위를 수위로 넣는다. 셀이 단층 폭에 비해 크므로 셀 안을 2×2로 나눠 평균한다. 가운데 한 점만 보면 좁은 융기대를 놓친다.
  const cellM = (40075016.686 / nx) * Math.cos((quake.lat * Math.PI) / 180);
  const field = source.fieldFor(cellM);
  const reachDeg = field.reachKm / 111.195;
  const j0 = Math.max(0, Math.floor(earthRow(quake.lat + reachDeg, z) - GLOBAL_ROW0)), j1 = Math.min(ny - 1, Math.ceil(earthRow(quake.lat - reachDeg, z) - GLOBAL_ROW0));
  const spanI = Math.ceil((reachDeg / Math.max(0.2, Math.cos((quake.lat * Math.PI) / 180)) / 360) * nx) + 1;
  const ic = Math.round(((quake.lon + 180) / 360) * nx - 0.5);
  let maxUp = 0, maxDown = 0;
  for (let j = j0; j <= j1; j++) {
    for (let di = -spanI; di <= spanI; di++) {
      const i = (((ic + di) % nx) + nx) % nx, k = j * nx + i;
      if (!wet0[k]) continue;
      let sum = 0;
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
        sum += field.uz(pxToLon(ic + di + 0.25 + 0.5 * a, z), pyToLat(GLOBAL_ROW0 + j + 0.25 + 0.5 * b, z));
      }
      const u = sum / 4;
      eta0[k] = u;
      if (u > maxUp) maxUp = u;
      if (u < maxDown) maxDown = u;
    }
  }
  for (let k = 0; k < eta0.length; k++) if (!wet0[k]) eta0[k] = bed[k];

  const world = 256 * 2 ** z;
  const grid: GlobalGrid = {
    zoom: z,
    input: { nx, ny, bed, eta0, wet0, zoom: z, px0: 0, py0: GLOBAL_ROW0, world, eqCell: 40075016.686 / world, wrapX: true, sponge: true },
    lonOf, latOf,
    cellOf: (lon, lat) => [(((Math.floor(((lon + 180) / 360) * nx) % nx) + nx) % nx), Math.max(0, Math.min(ny - 1, Math.floor(earthRow(lat, z) - GLOBAL_ROW0)))],
  };
  const f = quake.kind === 'quake' ? buildQuakeField(quake).fault : null;
  return { grid, source: { lengthKm: f ? f.L / 1000 : 0, widthKm: f ? f.W / 1000 : 0, meanSlip: f?.meanSlip ?? 0, peakSlip: f?.peakSlip ?? 0, maxUp, maxDown, outline: source.outline ?? [] } };
}

function earthRow(lat: number, z: number): number {
  const c = Math.max(-85, Math.min(85, lat));
  return ((1 - Math.asinh(Math.tan((c * Math.PI) / 180)) / Math.PI) / 2) * 256 * 2 ** z;
}

// ---------- 발생원 주변과 해안의 세밀 격자 ----------
/**
 * 발생원 격자의 줌. 4는 받은 자료(10 km 조각)의 해상도 그대로다. 적도에서 9.8 km, 위도 38도에서 7.7 km.
 * 전 지구 격자(줌 2)와의 해상도 비는 4이고 부모 한 스텝에 서너 번 돈다. 줌 5(4 km)로 하면 여섯 번 돌고 셀도 네 배라 계산량이 여덟 배다(D-023).
 */
export const SOURCE_ZOOM = 4;
export const SOURCE_SIZE = 256;
/** 발생원·중간 격자의 육지 최소 표고(m). 침수는 여기서 다루지 않는다. */
const LEVEL_LAND_FLOOR_M = 5;
/** 해안 격자의 육지 최소 표고(m). 물이 올라갈 수 있어야 하므로 낮게 둔다. */
const COAST_LAND_FLOOR_M = 0.2;
const LEVEL_MIN_DEPTH_M = 2;

export function planSourceGrid(src: { lon: number; lat: number }): LevelSpec {
  return planSource(planGlobal(GLOBAL_ROW0, GLOBAL_ROWS), src.lon, src.lat, SOURCE_ZOOM, SOURCE_SIZE);
}

/** 소행성 원거리 보정의 기준 거리(m). 전 지구 격자 셀의 여섯 배. 모든 단계가 같은 값을 쓴다. */
export function gainRefRadius(lat: number): number {
  return 6 * (40075016.686 / 1024) * Math.cos((lat * Math.PI) / 180);
}

/**
 * 한 단계의 지반과 초기 수위를 만든다.
 * 발생원·중간 격자의 지반은 지형 함수의 보간값(생성한 세부 없음)이고, 해안 격자는 셀 크기에 맞는 생성 세부까지 넣은 값이다.
 * 그리는 지형과 같은 함수에서 나온다(결정 D-018 규칙 4). 필요한 10 km 조각이 먼저 받아져 있어야 한다. 없으면 39 km 자료로 만든다.
 */
export function buildLevelGrid(terrain: Terrain, spec: LevelSpec, source: SourceModel): { input: GridInput; maxUp: number } {
  const quake = source.params;
  const { zoom: z, px0, py0, nx, ny } = spec;
  const world = 256 * 2 ** z, eqCell = 40075016.686 / world;
  const coast = spec.role === 'coast';
  const floor = coast ? COAST_LAND_FLOOR_M : LEVEL_LAND_FLOOR_M;
  const bed = new Float32Array(nx * ny), eta0 = new Float32Array(nx * ny), wet0 = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = pyToLat(py0 + j + 0.5, z);
    const cellKm = (eqCell / 1000) * Math.cos((lat * Math.PI) / 180);
    const la = (lat * Math.PI) / 180, cl = Math.cos(la), sl = Math.sin(la);
    for (let i = 0; i < nx; i++) {
      const lon = pxToLon(((px0 + i) % world) + 0.5, z);
      let e: number;
      if (coast) {
        const lo = (lon * Math.PI) / 180;
        e = terrain.elevation(cl * Math.sin(lo), sl, cl * Math.cos(lo), cellKm);
      } else e = terrain.base(lon, lat, cellKm);
      const k = j * nx + i;
      if (e < 0) { wet0[k] = 1; bed[k] = Math.min(e, -LEVEL_MIN_DEPTH_M); } else bed[k] = Math.max(e, floor);
    }
  }
  // 초기 변위. 변위장은 수 km 규모로 매끄러우므로 성긴 격자점에서만 계산하고 쌍선형 보간한다.
  const cellKmMid = (eqCell / 1000) * Math.cos((pyToLat(py0 + ny / 2, z) * Math.PI) / 180);
  const field = source.fieldFor(cellKmMid * 1000);
  // 소행성 공동은 셀 몇 개 크기라 셀마다 계산한다
  const step = field.movesBed ? Math.max(1, Math.min(16, Math.round(5 / cellKmMid))) : 1;
  const lx = Math.ceil((nx - 1) / step) + 1, ly = Math.ceil((ny - 1) / step) + 1;
  const lat = new Float32Array(lx * ly);
  const reachDeg = field.reachKm / 111.195, kx = Math.max(0.2, Math.cos((quake.lat * Math.PI) / 180));
  let any = false;
  for (let b = 0; b < ly; b++) {
    const la = pyToLat(py0 + Math.min(b * step, ny - 1) + 0.5, z);
    if (Math.abs(la - quake.lat) > reachDeg) continue;
    for (let a = 0; a < lx; a++) {
      const lo = pxToLon(((px0 + Math.min(a * step, nx - 1)) % world) + 0.5, z);
      let dLon = lo - quake.lon;
      dLon = ((dLon + 540) % 360) - 180;
      if (Math.abs(dLon) * kx > reachDeg) continue;
      const v = field.uz(quake.lon + dLon, la);
      if (v !== 0) { lat[b * lx + a] = v; any = true; }
    }
  }
  // 지진은 해저와 육지를 함께 움직인다. 지반에도 변위를 더한다. 해안이 가라앉으면 침수가 커진다(결정 D-009).
  let maxUp = 0;
  for (let j = 0; j < ny; j++) {
    const b0 = Math.min(ly - 2, Math.floor(j / step)), ty = j / step - b0;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = 0;
      if (any) {
        const a0 = Math.min(lx - 2, Math.floor(i / step)), tx = i / step - a0, o = b0 * lx + a0;
        v = (lat[o] * (1 - tx) + lat[o + 1] * tx) * (1 - ty) + (lat[o + lx] * (1 - tx) + lat[o + lx + 1] * tx) * ty;
      }
      if (field.movesBed) bed[k] += v;
      if (!wet0[k]) { eta0[k] = bed[k]; continue; }
      eta0[k] = Math.max(v, bed[k]);
      if (v > maxUp) maxUp = v;
    }
  }
  return { input: { nx, ny, bed, eta0, wet0, zoom: z, px0, py0, world, eqCell, wrapX: false, sponge: false }, maxUp };
}

/** 여러 단계에 필요한 조각을 받는다. 못 받은 조각은 39 km 자료로 대신한다. 받은 양(바이트)을 돌려준다. */
export async function loadChunksFor(chunks: ChunkStore, specs: LevelSpec[]): Promise<number> {
  const before = chunks.bytesLoaded;
  const keys = new Set<string>();
  const list: [number, number][] = [];
  for (const s of specs) for (const c of s.chunks) { const k = `${c[0]}_${c[1]}`; if (!keys.has(k)) { keys.add(k); list.push(c); } }
  await Promise.all(list.map(([x, y]) => chunks.load(x, y)));
  return chunks.bytesLoaded - before;
}
