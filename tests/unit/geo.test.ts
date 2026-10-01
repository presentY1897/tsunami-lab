import { describe, expect, it } from 'vitest';
import { cosLatAtPy, latToPy, lonToPx, pxToLon, pyToLat, DEG } from '../../app/src/geo/mercator';

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
