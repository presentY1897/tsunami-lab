import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeChunk, type Gunzip } from '../../app/src/data/chunks';
import { assembleGrid, splitFile } from '../../app/src/data/codec';
import { makeEarthGrid } from '../../app/src/data/earth';
import { GLOBAL_FILE, chunkFile } from '../../app/src/data/layout';
import { lonLatToDir } from '../../app/src/globe/icosphere';
import { perlin3 } from '../../app/src/terrain/noise';
import { COAST_BAND_KM, Terrain } from '../../app/src/terrain/terrain';

const gunzip: Gunzip = async (b) => new Uint8Array(gunzipSync(b));
const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../app/public/${rel}`, import.meta.url)));

let terrain: Terrain;
let coarseOnly: Terrain;
const at = (t: Terrain, lon: number, lat: number, scaleKm: number): number => t.elevation(...lonLatToDir(lon, lat), scaleKm);

beforeAll(async () => {
  const g = splitFile(read(GLOBAL_FILE));
  const earth = makeEarthGrid(g.header.zoom, g.header.size, assembleGrid(g.header, new Uint8Array(gunzipSync(g.payload))));
  // 한반도, 동해, 일본을 덮는 조각 넷
  const loaded = new Map<string, Float32Array>();
  for (const [x, y] of [[13, 5], [14, 5], [13, 6], [14, 6]]) loaded.set(`${x}_${y}`, await decodeChunk(read(chunkFile(x, y)), gunzip));
  terrain = new Terrain(earth, { peek: (x, y) => loaded.get(`${x}_${y}`) ?? null });
  coarseOnly = new Terrain(earth, { peek: () => null });
});

describe('잡음', () => {
  it('같은 자리는 언제나 같은 값이고 범위가 -1..1 안팎이다', () => {
    let lo = 0, hi = 0;
    for (let k = 0; k < 4000; k++) {
      const v = perlin3(k * 0.137, k * 0.071 - 3, k * 0.213 + 11);
      expect(v).toBe(perlin3(k * 0.137, k * 0.071 - 3, k * 0.213 + 11));
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    expect(lo).toBeLessThan(-0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(Math.max(-lo, hi)).toBeLessThan(1.3);
  });
});

describe('지형 함수 (결정 D-018의 규칙)', () => {
  it('알려진 곳의 표고가 맞다', () => {
    expect(at(terrain, 131.0, 37.4, 1)).toBeLessThan(-1000); // 동해 울릉분지
    expect(at(terrain, 144.0, 38.0, 1)).toBeLessThan(-6000); // 일본 해구
    expect(at(terrain, 128.2, 37.9, 1)).toBeGreaterThan(300); // 태백산맥
    expect(at(terrain, 127.0, 37.2, 1)).toBeGreaterThan(0); // 수도권 내륙
  });

  it('규칙 3: 해안에서 먼 바다는 받은 자료 그대로다', () => {
    let checked = 0;
    for (let lat = 35; lat <= 41; lat += 0.173) {
      for (let lon = 129.5; lon <= 138; lon += 0.211) {
        const b = terrain.base(lon, lat, 0.2);
        if (b > -300) continue;
        // 경위도를 단위 벡터로 바꿨다 되돌리는 반올림(10⁻¹¹ m)만 허용한다
        expect(Math.abs(at(terrain, lon, lat, 0.2) - b)).toBeLessThan(1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('규칙 2: 생성한 세부가 육지와 바다를 뒤집는 곳은 해안선 바로 옆뿐이다', () => {
    let flips = 0, total = 0;
    for (let lat = 34; lat <= 39; lat += 0.0213) {
      for (let lon = 126; lon <= 130; lon += 0.0271) {
        const b = terrain.base(lon, lat, 0.2);
        const e = at(terrain, lon, lat, 0.2);
        total++;
        if (b < 0 !== e < 0) {
          flips++;
          // 뒤집힌 곳의 원래 표고는 작아야 한다. 경사 100 m/km의 가파른 해안이라도 300 m 남짓이다.
          expect(Math.abs(b)).toBeLessThan(100 * COAST_BAND_KM + 1);
        }
      }
    }
    expect(flips).toBeGreaterThan(0); // 해안선이 실제로 흔들렸다
    expect(flips / total).toBeLessThan(0.03);
  });

  it('규칙 1: 평야는 평평하게, 산지는 거칠게 만든다', () => {
    const roughness = (lon0: number, lat0: number): number => {
      let sum = 0, n = 0;
      for (let j = 0; j < 30; j++) for (let i = 0; i < 30; i++) {
        const lon = lon0 + i * 0.004, lat = lat0 + j * 0.004;
        sum += Math.abs(at(terrain, lon, lat, 0.1) - terrain.base(lon, lat, 0.1));
        n++;
      }
      return sum / n;
    };
    const plain = roughness(126.85, 35.75); // 호남평야
    const mountain = roughness(128.3, 37.7); // 태백산맥
    expect(mountain).toBeGreaterThan(20);
    expect(plain).toBeLessThan(mountain / 4);
  });

  it('세부는 10 km 셀의 평균을 거의 바꾸지 않는다', () => {
    let sumDiff = 0, sumAbs = 0;
    for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) {
      const lon = 128.0 + i * 0.01, lat = 37.3 + j * 0.01;
      const d = at(terrain, lon, lat, 0.1) - terrain.base(lon, lat, 0.1);
      sumDiff += d; sumAbs += Math.abs(d);
    }
    expect(Math.abs(sumDiff)).toBeLessThan(sumAbs * 0.2);
  });

  it('면이 크면 세부를 빼고, 아주 크면 평균한 자료를 본다', () => {
    // 면이 4 km 이상이면 생성한 세부가 없다
    expect(Math.abs(at(terrain, 128.3, 37.7, 5) - terrain.base(128.3, 37.7, 5))).toBeLessThan(1e-6);
    // 제주도는 폭 70 km다. 400 km짜리 면의 눈에는 바다다.
    expect(at(terrain, 126.55, 33.38, 1)).toBeGreaterThan(0);
    expect(at(coarseOnly, 126.55, 33.38, 400)).toBeLessThan(0);
  });

  it('조각을 아직 못 받은 곳은 39 km 자료로 그린다', () => {
    const e = at(coarseOnly, 131.0, 37.4, 1);
    expect(e).toBeLessThan(-500);
    expect(Number.isFinite(at(coarseOnly, 0, 89.9, 1))).toBe(true);
    expect(Number.isFinite(at(terrain, 179.99, -84, 50))).toBe(true);
  });
});

describe('해수면 상승', () => {
  it('기존 세부 지형을 유지하며 렌더링과 계산의 기준 수위를 함께 옮긴다', () => {
    const points = [[129, 36], [135, 38], [142, 38]];
    const before = points.map(([lon, lat]) => [terrain.base(lon, lat, 1), at(terrain, lon, lat, 1)]);
    try {
      terrain.seaLevel = 300;
      points.forEach(([lon, lat], i) => {
        expect(terrain.base(lon, lat, 1)).toBeCloseTo(before[i][0] - 300, 8);
        expect(at(terrain, lon, lat, 1)).toBeCloseTo(before[i][1] - 300, 8);
      });
    } finally { terrain.seaLevel = 0; }
  });
});
