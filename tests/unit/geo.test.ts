import { describe, expect, it } from 'vitest';
import { cosLatAtPy, latToPy, lonToPx, pxToLon, pyToLat, DEG } from '../../src/geo/mercator';
import { floodFillSea, shoreDistance } from '../../src/geo/dem';
import { childRectInParent, type GridSpec } from '../../src/geo/grid';

describe('mercator', () => {
  it('경위도와 픽셀 좌표가 왕복 변환된다', () => {
    for (const [lon, lat] of [[141.2, 38.3], [-72.5, -35.1], [0, 0], [179.9, 60]]) {
      const z = 9;
      expect(pxToLon(lonToPx(lon, z), z)).toBeCloseTo(lon, 9);
      expect(pyToLat(latToPy(lat, z), z)).toBeCloseTo(lat, 9);
    }
  });
  it('행의 cos(위도)가 해석값과 같다', () => {
    const z = 7;
    expect(cosLatAtPy(latToPy(38, z), z)).toBeCloseTo(Math.cos(38 * DEG), 10);
  });
});

describe('격자 중첩', () => {
  it('자식 사각형을 부모 셀 좌표로 옮긴다', () => {
    const parent: GridSpec = { z: 6, px0: 100, py0: 40, nx: 512, ny: 512 };
    const child: GridSpec = { z: 9, px0: 1600, py0: 800, nx: 256, ny: 512 };
    expect(childRectInParent(parent, child)).toEqual([100, 60, 132, 124]);
  });
});

describe('바다 판정', () => {
  it('외해와 이어지지 않은 저지대는 바다가 아니다', () => {
    // 5x5: 왼쪽 두 열은 깊은 바다, 가운데 열은 둑, 오른쪽에 해수면 아래 분지
    const nx = 5, ny = 5;
    const bed = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      bed.set([-100, -20, 5, -2, -2], j * nx);
    }
    const wet = floodFillSea(nx, ny, (k) => bed[k] < 0, (k) => bed[k] < -50);
    expect(Array.from(wet.subarray(0, 5))).toEqual([1, 1, 0, 0, 0]);
    const d = shoreDistance({ z: 0, px0: 0, py0: 120, nx, ny }, wet);
    expect(d[0]).toBe(0);
    expect(d[2]).toBeGreaterThan(0);
    expect(d[4]).toBeGreaterThan(d[2]);
  });
});
