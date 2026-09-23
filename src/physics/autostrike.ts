import { fetchMosaic } from '../geo/dem';
import { DEG, latToPy, lonToPx } from '../geo/mercator';
import type { TileProvider } from '../geo/tiles';

/**
 * 지점 주변 해저 경사를 읽어 단층 주향을 추정한다. 섭입대에서는 단층이 육지 쪽으로 기울므로
 * 지형이 높아지는 방향을 경사 방향으로 본다. 주향 = 경사 방향 - 90도.
 */
export async function autoStrike(provider: TileProvider, lon: number, lat: number): Promise<number> {
  const z = 6, half = 32;
  const cx = Math.round(lonToPx(lon, z)), cy = Math.round(latToPy(lat, z));
  const n = half * 2 + 1;
  const e = await fetchMosaic(provider, z, cx - half, cy - half, n, n);
  const at = (i: number, j: number): number => Math.min(e[(half + j) * n + (half + i)], 500);
  let gx = 0, gy = 0;
  for (let s = 1; s <= half; s++) {
    const w = 1 / s;
    gx += w * (at(s, 0) - at(-s, 0));
    gy += w * (at(0, -s) - at(0, s)); // 북쪽이 양수
  }
  const dipDir = Math.atan2(gx, gy) / DEG;
  return (((dipDir - 90) % 360) + 360) % 360;
}
