import { cosLatAtPy, equatorMetersPerPixel, lonToPx, latToPy, pxToLon, pyToLat } from './mercator';

/**
 * 한 단계(level)의 계산 격자. 줌 z의 전역 픽셀 좌표에서 (px0, py0)를 왼쪽 위 모서리로 하는 nx×ny 셀.
 * 셀 (i, j)의 중심은 전역 픽셀 (px0 + i + 0.5, py0 + j + 0.5)이다. 행 0이 북쪽이다.
 */
export interface GridSpec {
  z: number;
  px0: number;
  py0: number;
  nx: number;
  ny: number;
}

export interface LonLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export const cellLon = (g: GridSpec, i: number): number => pxToLon(g.px0 + i + 0.5, g.z);
export const cellLat = (g: GridSpec, j: number): number => pyToLat(g.py0 + j + 0.5, g.z);

/** 경위도를 셀 좌표(실수)로 바꾼다. 셀 중심이 정수 + 0.5가 아니라 정수가 되도록 0.5를 뺀다. */
export const lonToCell = (g: GridSpec, lon: number): number => lonToPx(lon, g.z) - g.px0 - 0.5;
export const latToCell = (g: GridSpec, lat: number): number => latToPy(lat, g.z) - g.py0 - 0.5;

/** 행 j에서 한 셀의 실제 변 길이(m). */
export const cellSizeAtRow = (g: GridSpec, j: number): number =>
  equatorMetersPerPixel(g.z) * cosLatAtPy(g.py0 + j + 0.5, g.z);

export function gridBounds(g: GridSpec): LonLatBox {
  return {
    west: pxToLon(g.px0, g.z),
    east: pxToLon(g.px0 + g.nx, g.z),
    north: pyToLat(g.py0, g.z),
    south: pyToLat(g.py0 + g.ny, g.z),
  };
}

/** 자식 격자의 사각형을 부모 격자의 셀 좌표로 나타낸다. [i0, j0, i1, j1], 끝은 배타. */
export function childRectInParent(parent: GridSpec, child: GridSpec): [number, number, number, number] {
  const s = 2 ** (parent.z - child.z);
  return [
    child.px0 * s - parent.px0,
    child.py0 * s - parent.py0,
    (child.px0 + child.nx) * s - parent.px0,
    (child.py0 + child.ny) * s - parent.py0,
  ];
}
