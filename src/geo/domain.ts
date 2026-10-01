import type { GridSpec, LonLatBox } from './grid';
import { latToPy, lonToPx } from '../../app/src/geo/mercator';

export type QualityName = 'tiny' | 'low' | 'medium' | 'high';

export interface Quality {
  /** 가장 세밀한 격자의 줌. 12면 위도 38도에서 셀이 약 30 m. */
  fineZoom: number;
  fineSize: number;
  midSize: number;
  /** 가장 거친 격자의 한 변 최대 셀 수. */
  coarseMax: number;
}

export const QUALITIES: Record<QualityName, Quality> = {
  // tiny는 GPU가 약한 기기와 자동 테스트용이다
  tiny: { fineZoom: 11, fineSize: 256, midSize: 256, coarseMax: 448 },
  low: { fineZoom: 11, fineSize: 512, midSize: 512, coarseMax: 768 },
  medium: { fineZoom: 12, fineSize: 768, midSize: 768, coarseMax: 1024 },
  high: { fineZoom: 12, fineSize: 1024, midSize: 1024, coarseMax: 1280 },
};

/** 부모 경계에서 자식까지 최소한 띄워야 하는 부모 셀 수. 스펀지층과 완화 구간이 겹치지 않게 한다. */
const PARENT_MARGIN = 28;
const MAX_LAT = 78;

export interface PlanInput {
  /** 발생원이 차지하는 범위(단층 투영이나 충돌 공동). */
  sourceBox: LonLatBox;
  target: { lon: number; lat: number };
  quality: Quality;
}

const roundUp = (v: number, m: number): number => Math.ceil(v / m) * m;

/**
 * 계산 격자 단계를 정한다. 0번이 발생원과 관측 해안을 모두 덮는 거친 격자이고, 마지막이 관측 해안의 세밀 격자다.
 * 인접한 단계의 줌 차이는 3 이하(해상도 비 8 이하)로 유지한다.
 * 자식 격자는 부모 셀 경계에 정렬한다.
 */
export function planLevels(input: PlanInput): GridSpec[] {
  const { quality: q } = input;
  let { lon: tLon } = input.target;
  const tLat = input.target.lat;
  const src = { ...input.sourceBox };
  // 날짜변경선을 넘는 경우 관측 해안 쪽 경도를 발생원과 같은 쪽으로 편다
  const srcMid = (src.west + src.east) / 2;
  if (tLon - srcMid > 180) tLon -= 360;
  else if (srcMid - tLon > 180) tLon += 360;

  let west = Math.min(src.west, tLon - 0.6), east = Math.max(src.east, tLon + 0.6);
  let south = Math.min(src.south, tLat - 0.6), north = Math.max(src.north, tLat + 0.6);
  const mx = Math.max(3, (east - west) * 0.2), my = Math.max(3, (north - south) * 0.2);
  west -= mx; east += mx;
  south = Math.max(-MAX_LAT, south - my);
  north = Math.min(MAX_LAT, north + my);

  let z0 = 7;
  for (; z0 > 2; z0--) {
    const w = lonToPx(east, z0) - lonToPx(west, z0);
    const h = latToPy(south, z0) - latToPy(north, z0);
    if (w <= q.coarseMax && h <= q.coarseMax) break;
  }
  const zf = Math.max(q.fineZoom, z0 + 1);
  const nMid = Math.max(0, Math.ceil((zf - z0) / 3) - 1);
  const zooms: number[] = [z0];
  for (let k = 1; k <= nMid; k++) zooms.push(Math.round(z0 + ((zf - z0) * k) / (nMid + 1)));
  zooms.push(zf);

  const levels: GridSpec[] = [];
  const px0 = Math.floor(lonToPx(west, z0));
  const py0 = Math.floor(latToPy(north, z0));
  levels.push({
    z: z0,
    px0,
    py0,
    nx: roundUp(Math.ceil(lonToPx(east, z0)) - px0, 8),
    ny: roundUp(Math.ceil(latToPy(south, z0)) - py0, 8),
  });

  // 발생원 쪽 방향. 중간 격자를 바다 쪽으로 치우치게 해서 육지에 셀을 낭비하지 않는다.
  const sLat = (src.south + src.north) / 2;
  const dirX = srcMid - tLon, dirY = -(sLat - tLat);
  const dirLen = Math.hypot(dirX, dirY) || 1;

  for (let li = 1; li < zooms.length; li++) {
    const z = zooms[li];
    const parent = levels[li - 1];
    const f = 2 ** (z - parent.z);
    const isFinest = li === zooms.length - 1;
    const size = roundUp(isFinest ? q.fineSize : q.midSize, f);
    let cx = lonToPx(tLon, z), cy = latToPy(tLat, z);
    if (!isFinest) {
      cx += (dirX / dirLen) * size * 0.25;
      cy += (dirY / dirLen) * size * 0.25;
    }
    // 부모 안쪽에 여유를 두고 들어가도록 조정하고 부모 셀 경계에 맞춘다
    const pMinX = (parent.px0 + PARENT_MARGIN) * f, pMaxX = (parent.px0 + parent.nx - PARENT_MARGIN) * f;
    const pMinY = (parent.py0 + PARENT_MARGIN) * f, pMaxY = (parent.py0 + parent.ny - PARENT_MARGIN) * f;
    const nx = Math.min(size, Math.floor((pMaxX - pMinX) / f) * f);
    const ny = Math.min(size, Math.floor((pMaxY - pMinY) / f) * f);
    let x0 = Math.round((cx - nx / 2) / f) * f;
    let y0 = Math.round((cy - ny / 2) / f) * f;
    x0 = Math.max(pMinX, Math.min(pMaxX - nx, x0));
    y0 = Math.max(pMinY, Math.min(pMaxY - ny, y0));
    levels.push({ z, px0: x0, py0: y0, nx, ny });
  }
  return levels;
}
