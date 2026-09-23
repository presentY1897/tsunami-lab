import { latToPy, lonToPx, pxToLon, pyToLat } from '../../../src/geo/mercator';
import { CHUNK_SIZE, CHUNK_ZOOM, chunkExists } from '../data/layout';

/**
 * 계산 격자 단계의 계획. 모두 Web Mercator 픽셀에 정렬한 정사각형이다.
 *  - global: 전 지구 39 km 격자
 *  - source: 발생원 주변, 받은 자료 해상도(약 8 km)
 *  - bridge, coast: 고른 해안 주변. 해상도 비가 8을 넘지 않게 중간 단계를 두고 480 m까지 내려간다
 */
export type LevelRole = 'global' | 'source' | 'bridge' | 'coast';

export interface LevelSpec {
  role: LevelRole;
  zoom: number;
  px0: number;
  py0: number;
  nx: number;
  ny: number;
  /** 부모 단계의 번호. global은 -1. */
  parent: number;
  /** 경위도 범위. 날짜변경선을 넘으면 west > east다. */
  west: number;
  east: number;
  south: number;
  north: number;
  /** 필요한 10 km 조각. */
  chunks: [number, number][];
}

export const GLOBAL_ZOOM = 2;
/** 부모 격자의 가장자리에서 띄우는 부모 셀 수. 스펀지층이나 완화 구간과 겹치지 않게 한다. */
export const PARENT_MARGIN = 28;
/** 해안 격자의 줌. 8이면 적도에서 610 m, 위도 38도에서 480 m. */
export const COAST_ZOOM = 8;
export const COAST_SIZE = 256;
/** 인접 단계의 줌 차이 상한. 해상도 비 8. */
const MAX_ZOOM_STEP = 3;

const worldOf = (z: number): number => 256 * 2 ** z;

function chunksOf(z: number, px0: number, py0: number, n: number): [number, number][] {
  const f = 2 ** (z - CHUNK_ZOOM) * CHUNK_SIZE, cols = worldOf(z) / f;
  const out: [number, number][] = [];
  for (let cy = Math.floor(py0 / f); cy <= Math.floor((py0 + n - 1) / f); cy++) {
    if (!chunkExists(cy)) continue;
    for (let cx = Math.floor(px0 / f); cx <= Math.floor((px0 + n - 1) / f); cx++) out.push([cx % cols, cy]);
  }
  return out;
}

function finish(role: LevelRole, zoom: number, px0: number, py0: number, n: number, parent: number): LevelSpec {
  const world = worldOf(zoom);
  return {
    role, zoom, px0, py0, nx: n, ny: n, parent,
    west: pxToLon(px0, zoom), east: pxToLon((px0 + n) % world, zoom), north: pyToLat(py0, zoom), south: pyToLat(py0 + n, zoom),
    chunks: chunksOf(zoom, px0, py0, n),
  };
}

/**
 * lon, lat을 가운데 둔 n×n 격자를 zoom에 놓는다. 부모 셀 경계에 맞추고 부모 안쪽에 여유를 두고 들어가게 한다.
 * 부모가 순환 격자(전 지구)면 경도 방향에는 제한이 없다.
 */
function placeInside(role: LevelRole, zoom: number, n: number, lon: number, lat: number, parent: LevelSpec, parentIndex: number, parentWrap: boolean): LevelSpec {
  const s = 2 ** (zoom - parent.zoom), world = worldOf(zoom);
  const minRow = (parent.py0 + PARENT_MARGIN) * s, maxRow = (parent.py0 + parent.ny - PARENT_MARGIN) * s - n;
  let py0 = Math.round((latToPy(lat, zoom) - n / 2) / s) * s;
  py0 = Math.max(minRow, Math.min(maxRow, py0));
  let px0 = Math.round((lonToPx(lon, zoom) - n / 2) / s) * s;
  if (!parentWrap) {
    const minCol = (parent.px0 + PARENT_MARGIN) * s, maxCol = (parent.px0 + parent.nx - PARENT_MARGIN) * s - n;
    // 부모가 날짜변경선을 넘을 수 있으므로 부모 원점 기준의 상대 좌표로 맞춘다
    let rel = px0 - parent.px0 * s;
    rel = ((rel % world) + world) % world;
    if (rel > world / 2) rel -= world;
    rel = Math.max(minCol - parent.px0 * s, Math.min(maxCol - parent.px0 * s, rel));
    px0 = parent.px0 * s + rel;
  }
  px0 = ((px0 % world) + world) % world;
  return finish(role, zoom, px0, py0, n, parentIndex);
}

/** 경위도 상자가 부모 안쪽(여유 포함)에 들어가는지. */
function contains(parent: LevelSpec, zoom: number, px0: number, py0: number, n: number): boolean {
  const s = 2 ** (zoom - parent.zoom), world = worldOf(zoom);
  if (py0 < (parent.py0 + PARENT_MARGIN) * s || py0 + n > (parent.py0 + parent.ny - PARENT_MARGIN) * s) return false;
  if (parent.role === 'global') return true;
  let rel = ((px0 - parent.px0 * s) % world + world) % world;
  if (rel > world / 2) rel -= world;
  return rel >= PARENT_MARGIN * s && rel + n <= (parent.nx - PARENT_MARGIN) * s;
}

export function planGlobal(row0: number, rows: number): LevelSpec {
  const world = worldOf(GLOBAL_ZOOM);
  return { role: 'global', zoom: GLOBAL_ZOOM, px0: 0, py0: row0, nx: world, ny: rows, parent: -1, west: -180, east: 180, north: pyToLat(row0, GLOBAL_ZOOM), south: pyToLat(row0 + rows, GLOBAL_ZOOM), chunks: [] };
}

export function planSource(global: LevelSpec, lon: number, lat: number, zoom: number, n: number): LevelSpec {
  return placeInside('source', zoom, n, lon, lat, global, 0, true);
}

/**
 * 고른 해안까지의 격자 사슬. 해안 격자가 들어갈 수 있는 가장 세밀한 기존 단계를 부모로 잡고,
 * 줌 차이가 3을 넘지 않게 중간 단계(bridge)를 끼운 뒤 해안 격자(coast)를 놓는다. 새로 더할 단계들을 돌려준다.
 */
export function planCoastChain(existing: LevelSpec[], lon: number, lat: number): LevelSpec[] {
  const n = COAST_SIZE;
  // 해안 격자의 대략적 위치로 부모 후보를 고른다
  const cx = Math.round(lonToPx(lon, COAST_ZOOM) - n / 2), cy = Math.round(latToPy(lat, COAST_ZOOM) - n / 2);
  let parentIndex = 0;
  for (let i = existing.length - 1; i >= 1; i--) {
    if (existing[i].role !== 'source' && existing[i].role !== 'global') continue;
    if (contains(existing[i], COAST_ZOOM, cx, cy, n)) { parentIndex = i; break; }
  }
  const out: LevelSpec[] = [];
  let parent = existing[parentIndex], pIdx = parentIndex;
  const baseZoom = parent.zoom, diff = COAST_ZOOM - baseZoom;
  const steps = Math.ceil(diff / MAX_ZOOM_STEP);
  for (let k = 1; k <= steps; k++) {
    const zoom = baseZoom + Math.round((diff * k) / steps);
    const role: LevelRole = k === steps ? 'coast' : 'bridge';
    const spec = placeInside(role, zoom, n, lon, lat, parent, pIdx, parent.role === 'global');
    out.push(spec);
    parent = spec;
    pIdx = existing.length + out.length - 1;
  }
  return out;
}
