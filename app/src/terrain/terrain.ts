import { latToPy, lonToPx } from '../geo/mercator';
import type { EarthGrid } from '../data/earth';
import { CHUNK_COLS, CHUNK_SIZE, CHUNK_ZOOM, chunkExists } from '../data/layout';
import { perlin3 } from './noise';

/**
 * 지구 위 한 점의 표고를 주는 단 하나의 함수. 그리는 메시와 파도 계산이 모두 여기서 지형을 가져간다(결정 D-018).
 *
 *   표고 = 받은 자료를 매끄럽게 보간한 값 + 생성한 세부
 *
 * 받은 자료: 39 km 전 지구 격자(늘 있음)와 10 km 조각(받은 곳만). 큰 면을 그릴 때는 거친 자료를 평균해서 쓴다.
 * 생성한 세부: 10 km보다 작은 기복. 규칙은 다음과 같다.
 *   1. 육지의 기복: 주변 고도차가 큰 산지는 거칠게, 평야는 평평하게.
 *   2. 해안선의 굴곡: 해안선을 가로로 최대 1.5 km 안에서만 흔든다.
 *   3. 바다 밑에는 아무것도 넣지 않는다. 가짜 요철은 파도를 가짜로 흩뜨린다.
 *   4. 같은 자리는 언제나 같은 값이다.
 */

const EARTH_RADIUS_KM = 6371;
const CIRCUMFERENCE_KM = 40075.0167;
const Z4_SIZE = CHUNK_SIZE * CHUNK_COLS;
const DEG = Math.PI / 180;

/** 세부를 만드는 가장 긴 파장(km). 자료 간격보다 조금 짧게 잡는다. */
const DETAIL_MAX_WAVELENGTH_KM = 8;
/** 옥타브마다 진폭이 줄어드는 비율. 2^-0.8, 실제 지형의 거칠기와 비슷하다. */
const DETAIL_GAIN = 0.574;
/** 육지 세부의 진폭 = 주변 고도차 × 이 값. */
const RELIEF_TO_AMPLITUDE = 0.4;
/** 해안선을 흔드는 최대 가로 거리(km). */
export const COAST_SHIFT_KM = 1.5;
/** 해안선 흔들기가 미치는 범위(km). 해안에서 이보다 먼 바다는 받은 자료 그대로다. */
export const COAST_BAND_KM = 3;

export interface ChunkSource {
  peek(x: number, y: number): Float32Array | null;
}

interface ChunkEntry {
  elev: Float32Array;
  /** 셀 주변 3×3의 고도차(m). 세부의 진폭을 정한다. */
  relief: Float32Array;
}

const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function reliefOf(elev: Float32Array): Float32Array {
  const n = CHUNK_SIZE, out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let lo = Infinity, hi = -Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = Math.max(0, Math.min(n - 1, j + dj));
        for (let di = -1; di <= 1; di++) {
          const v = elev[jj * n + Math.max(0, Math.min(n - 1, i + di))];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      // 바다 쪽 깊이는 육지의 거칠기와 무관하다. 해수면 위의 고도차만 본다.
      out[j * n + i] = Math.max(hi, 0) - Math.max(lo, 0);
    }
  }
  return out;
}

export class Terrain {
  /** 현재 해수면의 원래 표고 기준 높이(m). 계산은 이 해수면을 0으로 쓴다. */
  seaLevel = 0;
  /** 39 km 격자와 그것을 2배씩 평균해 줄인 격자들. 큰 면을 그릴 때 점 하나만 찍어 보는 오류를 막는다. */
  private readonly mips: { size: number; data: Float32Array }[] = [];
  private readonly cache = new Map<number, ChunkEntry | null>();
  // 마지막으로 계산한 점의 중간값. 객체를 만들지 않으려고 필드에 둔다.
  private slope = 0;
  private relief = 0;

  constructor(private readonly earth: EarthGrid, private readonly chunks: ChunkSource) {
    let size = earth.size, data = earth.elev;
    this.mips.push({ size, data });
    while (size > 64) {
      const half = size / 2, next = new Float32Array(half * half);
      for (let j = 0; j < half; j++) for (let i = 0; i < half; i++) {
        next[j * half + i] = (data[2 * j * size + 2 * i] + data[2 * j * size + 2 * i + 1] + data[(2 * j + 1) * size + 2 * i] + data[(2 * j + 1) * size + 2 * i + 1]) / 4;
      }
      size = half;
      data = next;
      this.mips.push({ size, data });
    }
  }

  /** 새 조각이 도착했을 수 있을 때 부른다. 없다고 기억해 둔 조각을 다시 찾아보게 한다. */
  refresh(): void {
    for (const [k, v] of this.cache) if (v === null) this.cache.delete(k);
    if (this.cache.size > 48) this.cache.clear();
  }

  private chunk(x: number, y: number): ChunkEntry | null {
    const key = y * CHUNK_COLS + x;
    let e = this.cache.get(key);
    if (e === undefined) {
      const elev = chunkExists(y) ? this.chunks.peek(x, y) : null;
      e = elev ? { elev, relief: reliefOf(elev) } : null;
      this.cache.set(key, e);
    }
    return e;
  }

  private mipSample(level: number, lon: number, lat: number): number {
    const { size, data } = this.mips[level];
    const z = this.earth.zoom;
    const s = 1 / 2 ** level;
    const u = lonToPx(lon, z) * s - 0.5;
    const v = Math.max(0, Math.min(size - 1, latToPy(lat, z) * s - 0.5));
    const i0 = Math.floor(u), j0 = Math.min(size - 2, Math.floor(v));
    const tx = u - i0, ty = v - j0;
    const a = ((i0 % size) + size) % size, b = (a + 1) % size;
    const r0 = j0 * size, r1 = r0 + size;
    return (data[r0 + a] * (1 - tx) + data[r0 + b] * tx) * (1 - ty) + (data[r1 + a] * (1 - tx) + data[r1 + b] * tx) * ty;
  }

  /** 39 km 자료. 면이 클수록 더 많이 평균한 격자를 본다. */
  private coarse(lon: number, lat: number, scaleKm: number): number {
    const cellKm = (CIRCUMFERENCE_KM / this.earth.size) * Math.max(0.2, Math.cos(lat * DEG));
    const l = Math.max(0, Math.min(this.mips.length - 1, Math.log2(scaleKm / cellKm) - 1));
    const l0 = Math.floor(l), t = l - l0;
    const a = this.mipSample(l0, lon, lat);
    return t > 0.001 && l0 + 1 < this.mips.length ? a * (1 - t) + this.mipSample(l0 + 1, lon, lat) * t : a;
  }

  private tap(i: number, j: number, field: 'elev' | 'relief'): number {
    const ii = ((i % Z4_SIZE) + Z4_SIZE) % Z4_SIZE;
    const e = this.chunk(Math.floor(ii / CHUNK_SIZE), Math.floor(j / CHUNK_SIZE));
    return e ? e[field][(j % CHUNK_SIZE) * CHUNK_SIZE + (ii % CHUNK_SIZE)] : NaN;
  }

  /**
   * 10 km 자료를 매끄럽게 보간한다(Catmull-Rom). 기울기와 주변 고도차도 같이 구해 둔다.
   * 보간값이 가운데 네 점의 범위를 벗어나지 않게 막는다. 가파른 해안에서 없던 섬이나 호수가 생기지 않게 하기 위해서다.
   * 조각이 아직 없으면 NaN.
   */
  private fine(lon: number, lat: number): number {
    const u = lonToPx(lon, CHUNK_ZOOM) - 0.5, v = latToPy(lat, CHUNK_ZOOM) - 0.5;
    const i0 = Math.floor(u), j0 = Math.floor(v);
    if (j0 - 1 < 0 || j0 + 2 >= Z4_SIZE) return NaN;
    const tx = u - i0, ty = v - j0;
    const p = new Array<number>(16);
    const cx = Math.floor(i0 / CHUNK_SIZE), cy = Math.floor(j0 / CHUNK_SIZE);
    const li = i0 - cx * CHUNK_SIZE, lj = j0 - cy * CHUNK_SIZE;
    if (i0 >= 0 && i0 < Z4_SIZE && li >= 1 && li < CHUNK_SIZE - 2 && lj >= 1 && lj < CHUNK_SIZE - 2) {
      // 빠른 길: 열여섯 점이 모두 한 조각 안에 있다
      const e = this.chunk(cx, cy);
      if (!e) return NaN;
      for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) p[b * 4 + a] = e.elev[(lj + b - 1) * CHUNK_SIZE + li + a - 1];
      const r = e.relief, o = lj * CHUNK_SIZE + li;
      this.relief = (r[o] * (1 - tx) + r[o + 1] * tx) * (1 - ty) + (r[o + CHUNK_SIZE] * (1 - tx) + r[o + CHUNK_SIZE + 1] * tx) * ty;
    } else {
      for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
        const t = this.tap(i0 + a - 1, j0 + b - 1, 'elev');
        if (Number.isNaN(t)) return NaN;
        p[b * 4 + a] = t;
      }
      this.relief = (this.tap(i0, j0, 'relief') * (1 - tx) + this.tap(i0 + 1, j0, 'relief') * tx) * (1 - ty)
        + (this.tap(i0, j0 + 1, 'relief') * (1 - tx) + this.tap(i0 + 1, j0 + 1, 'relief') * tx) * ty;
    }
    const w = (t: number): [number, number, number, number] => [
      ((-t + 2) * t - 1) * t * 0.5, ((3 * t - 5) * t * t + 2) * 0.5, ((-3 * t + 4) * t + 1) * t * 0.5, (t - 1) * t * t * 0.5,
    ];
    const wx = w(tx), wy = w(ty);
    let sum = 0;
    for (let b = 0; b < 4; b++) sum += wy[b] * (p[b * 4] * wx[0] + p[b * 4 + 1] * wx[1] + p[b * 4 + 2] * wx[2] + p[b * 4 + 3] * wx[3]);
    const a = p[5], bb = p[6], c = p[9], d = p[10];
    const lo = Math.min(a, bb, c, d), hi = Math.max(a, bb, c, d);
    const cellKm = (CIRCUMFERENCE_KM / Z4_SIZE) * Math.max(0.2, Math.cos(lat * DEG));
    const gx = ((bb - a) * (1 - ty) + (d - c) * ty) / cellKm, gy = ((c - a) * (1 - tx) + (d - bb) * tx) / cellKm;
    this.slope = Math.hypot(gx, gy);
    return Math.max(lo, Math.min(hi, sum));
  }

  /** 받은 자료만으로 구한 표고(m). 생성한 세부는 들어 있지 않다. */
  base(lon: number, lat: number, scaleKm: number): number {
    return this.rawBase(lon, lat, scaleKm) - this.seaLevel;
  }

  private rawBase(lon: number, lat: number, scaleKm: number): number {
    this.slope = 0;
    this.relief = 0;
    if (scaleKm >= 40) return this.coarse(lon, lat, scaleKm);
    const f = this.fine(lon, lat);
    if (Number.isNaN(f)) {
      this.slope = 0;
      this.relief = 0;
      return this.coarse(lon, lat, scaleKm);
    }
    const t = smoothstep(15, 40, scaleKm);
    return t > 0 ? f * (1 - t) + this.coarse(lon, lat, scaleKm) * t : f;
  }

  /** 여러 파장의 잡음을 겹친 값. 면 크기(scaleKm)의 두 배보다 짧은 파장은 뺀다. 그리지도 못할 세부를 넣으면 잡티가 된다. */
  private fbm(x: number, y: number, z: number, scaleKm: number, firstKm: number, octaves: number): number {
    let sum = 0, amp = 1, lambda = firstKm;
    for (let o = 0; o < octaves; o++) {
      const w = Math.max(0, Math.min(1, lambda / (2 * scaleKm) - 1));
      if (w <= 0) break;
      const f = EARTH_RADIUS_KM / lambda;
      sum += amp * w * perlin3(x * f + 17.3 * o, y * f - 5.1 * o, z * f + 9.7 * o);
      amp *= DETAIL_GAIN;
      lambda /= 2;
    }
    return sum;
  }

  /**
   * 표고(m). (x, y, z)는 지구 중심에서 본 단위 벡터, scaleKm은 이 점 주변에 그리는 면의 크기다.
   * 바다는 음수. 해안에서 COAST_BAND_KM보다 먼 바다는 base()와 정확히 같다.
   */
  elevation(x: number, y: number, z: number, scaleKm: number): number {
    return this.rawElevation(x, y, z, scaleKm) - this.seaLevel;
  }

  private rawElevation(x: number, y: number, z: number, scaleKm: number): number {
    const lon = Math.atan2(x, z) / DEG, lat = Math.asin(Math.max(-1, Math.min(1, y))) / DEG;
    const b = this.rawBase(lon, lat, scaleKm);
    if (scaleKm >= DETAIL_MAX_WAVELENGTH_KM / 2 || this.slope === 0 && this.relief === 0) return b;
    const slope = this.slope, relief = this.relief;
    let e = b;
    if (b > 0 && relief > 0.5) {
      const d = RELIEF_TO_AMPLITUDE * relief * smoothstep(0, 40, b) * this.fbm(x, y, z, scaleKm, DETAIL_MAX_WAVELENGTH_KM, 7);
      // 육지 세부가 땅을 바다로 만들지는 못한다. 해안선은 아래의 해안선 흔들기만 옮긴다.
      e = Math.max(b + d, Math.min(b, 1));
    }
    const band = slope * COAST_BAND_KM + 1;
    if (Math.abs(b) < band) {
      const n = this.fbm(x + 3.1, y + 1.7, z - 2.3, scaleKm, 6, 3) / 1.5;
      e += slope * COAST_SHIFT_KM * n * (1 - smoothstep(0.6, 1, Math.abs(b) / band));
    }
    return e;
  }
}
