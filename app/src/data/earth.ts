import { latToPy, lonToPx } from '../../../src/geo/mercator';
import { browserGunzip } from './chunks';
import { assembleGrid, splitFile } from './codec';

/** 전 지구 표고 격자. Web Mercator 정사각형이고 행 0이 북쪽이다. 육지는 양수, 해저는 음수(m). */
export interface EarthGrid {
  zoom: number;
  size: number;
  elev: Float32Array;
  /** 경위도의 표고(m). 쌍선형 보간. 경도는 순환하고 위도는 격자 끝(약 ±85도)에서 멈춘다. */
  elevAt(lon: number, lat: number): number;
}

export function makeEarthGrid(zoom: number, size: number, elev: Float32Array): EarthGrid {
  return {
    zoom,
    size,
    elev,
    elevAt(lon, lat) {
      const u = lonToPx(lon, zoom) - 0.5;
      const v = Math.max(0, Math.min(size - 1, latToPy(lat, zoom) - 0.5));
      const i0 = Math.floor(u), j0 = Math.min(size - 2, Math.floor(v));
      const tx = u - i0, ty = v - j0;
      const a = ((i0 % size) + size) % size, b = (a + 1) % size;
      const r0 = j0 * size, r1 = r0 + size;
      return (elev[r0 + a] * (1 - tx) + elev[r0 + b] * tx) * (1 - ty) + (elev[r1 + a] * (1 - tx) + elev[r1 + b] * tx) * ty;
    },
  };
}

export async function loadEarth(url: string): Promise<EarthGrid> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`지구 자료를 받지 못했습니다 (${res.status})`);
  const { header, payload } = splitFile(new Uint8Array(await res.arrayBuffer()));
  // 파일 안에서 이미 gzip으로 묶여 있다. 호스팅이 .bin을 압축해 주지 않아도 전송량이 같도록 하기 위해서다.
  return makeEarthGrid(header.zoom, header.size, assembleGrid(header, await browserGunzip(payload)));
}
