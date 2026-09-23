import { BIG_LIMIT_M } from '../sim/judge';
import { hashUnit } from '../terrain/noise';
import type { Terrain } from '../terrain/terrain';
import { icosphere } from './icosphere';
import type { Vec3 } from './mat4';
import { landColor, seabedColor, waterColor, type RGB } from './palette';

/**
 * 보이는 부분만 잘게 나눈 지구 메시.
 *
 * 나누는 규칙은 면이 아니라 **변**에 건다. 변 하나를 나눌지는 그 변의 양 끝점과 카메라만으로 정해진다.
 * 변을 공유하는 두 면이 늘 같은 답을 얻으므로, 나눈 정도가 다른 면 사이에도 틈이 생기지 않는다.
 * 나눌 기준은 화면에서의 길이다. 변이 targetPx보다 길게 보이면 나눈다. 그래서 어느 거리에서 봐도 면의 크기가 비슷하다.
 *
 * 지형과 물은 별개의 층이다.
 *  - 지형 층: 육지와 바닥. 꼭짓점 높이는 Terrain에서 온다.
 *  - 물 층: 바닥이 수면보다 낮은 면 위에 수면을 따로 그린다. 지금은 높이 0 m이고, 나중에 파도 계산의 수위가 들어온다.
 * 두 층이 만나는 선은 깊이 검사가 정한다. 해안선이 삼각형 변을 따라 계단지지 않고, 물이 차오르거나 빠지는 것도 같은 방식으로 표현된다.
 *
 * 꼭짓점 좌표는 보는 지점을 원점으로 한 상대 좌표(float32)로 담는다. 지구 반지름 기준 절대 좌표는 float32로 0.8 m 단위밖에 안 된다.
 */

export const STRIDE = 44; // 상대 좌표 f32×3, 높이 f32, 음영용 높이 f32, 경험식 최대 물 높이 f32, 침수 전선 도달 시각 f32, 해안 칸 경도·위도(rad) f32×2, 물 높이 비율 f32, 색 RGBA8
/** 물이 닿지 않는 꼭짓점의 물 높이는 지반보다 이만큼 아래로 둔다(m). 이웃 꼭짓점과 보간할 때 물 면이 땅 속으로 들어가는 기울기가 된다. */
export const DRY_BELOW_M = 30;
/** 경험식 침수 판정을 꼭짓점에 넣는 가장 큰 변(km). 이보다 큰 면에서는 침수 띠(수 km)가 한 면 안에 묻힌다. */
export const JUDGE_MAX_EDGE_KM = 3;
const EARTH_RADIUS_KM_J = 6371;
const DEG_J = Math.PI / 180;
/** 색의 알파로 층을 구분한다. 0 = 지형, 200 = 육지 위의 물(침수), 255 = 바다. */
const ALPHA_FLOOD = 200;
const FLOOD_COLOR: RGB = [0.24, 0.40, 0.50];
const EARTH_RADIUS_KM = 6371;
/** 물에 이보다 깊이 잠긴 바닥 면은 그리지 않는다(m). 물이 불투명해서 보이지 않는다. */
const HIDDEN_SEABED_DEPTH = 40;
const DEG = Math.PI / 180;

export interface ViewParams {
  eye: Vec3;
  /** 카메라의 기저(단위 벡터). forward는 보는 방향이다. */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** 시야각의 절반(라디안). 가로와 세로. */
  halfFovX: number;
  halfFovY: number;
  /** 거리 1(지구 반지름)에서 1 라디안이 화면에서 차지하는 px. */
  pxPerRad: number;
  width: number;
  height: number;
  /** 상대 좌표의 원점. 보는 지점의 단위 벡터. */
  origin: Vec3;
  targetPx: number;
  /** 가장 작은 변의 길이(km). */
  minEdgeKm: number;
  maxFaces: number;
  /**
   * 화면에서의 크기와 상관없이, 이보다 긴 변은 나눈다(km). 파도를 그릴 때 쓴다.
   * 파도의 모양은 계산 격자에서 오므로, 수면의 삼각형이 파장보다 커서는 파도가 보이지 않는다. 없으면 Infinity.
   */
  extraSplitKm?: number;
  /** 이 경위도 상자 안에서는 더 짧은 변까지 나눈다. 세밀 계산 격자가 있는 곳이다. 날짜변경선을 넘으면 west > east다. */
  extraSplitFine?: { west: number; east: number; south: number; north: number; km: number };
  /** 이 경위도 상자 안에서는 육지 면 위에도 물 면을 만든다. 해안 격자가 있는 곳이다. 계산된 수위가 지반보다 높은 곳만 보인다. */
  floodBox?: { west: number; east: number; south: number; north: number };
  /** 경험식 침수 판정(D-031). 해안 근처 육지 꼭짓점마다 물 높이를 넣는다. */
  judge?: {
    runupNear(lon: number, lat: number): { runup: number; arrival: number; lon: number; lat: number };
    inlandLimit(runup: number): number;
    frontDelay(runup: number, d: number, limit: number): number;
    maxLimitKm(): number;
    bigSources(): { cellDeg: number; items: { lon: number; lat: number; runup: number; arrival: number; limit: number }[] };
  };
}

export interface Subdivision {
  x: number[]; y: number[]; z: number[];
  /** 잎 면의 꼭짓점 번호. 3개씩. */
  leaves: number[];
}

export interface AdaptiveMesh {
  data: ArrayBuffer;
  terrainVertices: number;
  waterVertices: number;
  faces: number;
  minEdgeKm: number;
  origin: Vec3;
  buildMs: number;
}

const BASE = icosphere(2);

/** 구를 나눈다. 면이 maxFaces를 넘으면 null. */
export function subdivide(v: ViewParams): Subdivision | null {
  const x: number[] = Array.from(BASE.positions.filter((_, i) => i % 3 === 0));
  const y: number[] = Array.from(BASE.positions.filter((_, i) => i % 3 === 1));
  const z: number[] = Array.from(BASE.positions.filter((_, i) => i % 3 === 2));
  const edges = new Map<number, number>();
  const leaves: number[] = [];
  const [ex, ey, ez] = v.eye;
  const elen = Math.hypot(ex, ey, ez);
  const minEdge = v.minEdgeKm / EARTH_RADIUS_KM;
  const extraSplit = (v.extraSplitKm ?? Infinity) / EARTH_RADIUS_KM;
  const fine = v.extraSplitFine;
  const fineSplit = fine ? fine.km / EARTH_RADIUS_KM : Infinity;
  const inFine = (mx: number, my: number, mz: number): boolean => {
    if (!fine) return false;
    const lat = Math.asin(Math.max(-1, Math.min(1, my))) / DEG;
    if (lat < fine.south || lat > fine.north) return false;
    const lon = Math.atan2(mx, mz) / DEG;
    return fine.west <= fine.east ? lon >= fine.west && lon <= fine.east : lon >= fine.west || lon <= fine.east;
  };
  let overflow = false;

  /** 변 a-b를 나눠야 하면 가운데 꼭짓점 번호를, 아니면 -1을 준다. */
  const split = (a: number, b: number): number => {
    const key = a < b ? a * 67108864 + b : b * 67108864 + a;
    const cached = edges.get(key);
    if (cached !== undefined) return cached;
    let result = -1;
    const len = Math.hypot(x[a] - x[b], y[a] - y[b], z[a] - z[b]);
    // 나눈 뒤의 변이 하한보다 짧아지면 나누지 않는다
    if (len / 2 >= minEdge) {
      let mx = x[a] + x[b], my = y[a] + y[b], mz = z[a] + z[b];
      const l = Math.hypot(mx, my, mz);
      mx /= l; my /= l; mz /= l;
      // 지평선 너머인가. 변이 길면 가운데가 가려져도 끝이 보일 수 있으니 길이만큼 여유를 둔다.
      const overHorizon = mx * ex + my * ey + mz * ez < 1 - len * elen - 0.01 * elen;
      if (!overHorizon) {
        // 비스듬히 보이는 땅은 화면에서 납작하게 눌린다. 눌린 만큼 덜 나눠야 화면에서의 면 크기가 고르다.
        const toEye = Math.hypot(mx - ex, my - ey, mz - ez);
        const facing = Math.max(0.08, ((ex - mx) * mx + (ey - my) * my + (ez - mz) * mz) / toEye);
        const px = ((len * v.pxPerRad) / toEye) * Math.sqrt(facing);
        // 파도용 추가 분할도 눌린 정도를 반영한다. 지평선 근처는 어차피 파도가 잘 안 보인다. 1.5 px 아래로는 나누지 않는다.
        const seen = len * Math.sqrt(facing);
        const forWave = px > 1.5 && (seen > extraSplit || (seen > fineSplit && inFine(mx, my, mz)));
        if (px > v.targetPx || forWave) {
          // 화면에 걸칠 수 있는가. 눈에서 본 각도로 따진다. 투영 좌표로 따지면 시야 밖의 큰 면에서 값이 발산해,
          // 보는 지점을 품은 큰 면이 "화면 밖"으로 잘못 판정된다.
          // 가로와 세로를 따로 본다. 폰처럼 세로로 긴 화면을 원뿔 하나로 어림하면 화면의 몇 배나 되는 영역을 나누게 된다.
          const dx = mx - ex, dy = my - ey, dz = mz - ez, dist = Math.hypot(dx, dy, dz);
          const cx = dx * v.right[0] + dy * v.right[1] + dz * v.right[2];
          const cy = dx * v.up[0] + dy * v.up[1] + dz * v.up[2];
          const cz = dx * v.forward[0] + dy * v.forward[1] + dz * v.forward[2];
          const reach = len / dist; // 변의 절반이 아니라 전체 길이만큼 여유를 둔다. 변에 닿은 면의 안쪽까지 덮어야 한다.
          if (Math.atan2(Math.abs(cx), cz) < v.halfFovX * 1.15 + reach && Math.atan2(Math.abs(cy), cz) < v.halfFovY * 1.15 + reach) {
            result = x.length;
            x.push(mx); y.push(my); z.push(mz);
          }
        }
      }
    }
    edges.set(key, result);
    return result;
  };

  const visit = (a: number, b: number, c: number): void => {
    if (overflow) return;
    const ab = split(a, b), bc = split(b, c), ca = split(c, a);
    const n = (ab >= 0 ? 1 : 0) + (bc >= 0 ? 1 : 0) + (ca >= 0 ? 1 : 0);
    if (n === 0) {
      leaves.push(a, b, c);
      if (leaves.length / 3 > v.maxFaces) overflow = true;
    } else if (n === 3) {
      visit(a, ab, ca); visit(ab, b, bc); visit(ca, bc, c); visit(ab, bc, ca);
    } else if (n === 2) {
      // 나뉘지 않은 변의 맞은편 모서리를 잘라 낸다
      if (ca < 0) { visit(ab, b, bc); visit(a, ab, bc); visit(a, bc, c); }
      else if (ab < 0) { visit(bc, c, ca); visit(b, bc, ca); visit(b, ca, a); }
      else { visit(ca, a, ab); visit(c, ca, ab); visit(c, ab, b); }
    } else if (ab >= 0) { visit(a, ab, c); visit(ab, b, c); }
    else if (bc >= 0) { visit(b, bc, a); visit(bc, c, a); }
    else { visit(c, ca, b); visit(ca, a, b); }
  };
  for (let f = 0; f < BASE.indices.length; f += 3) visit(BASE.indices[f], BASE.indices[f + 1], BASE.indices[f + 2]);
  return overflow ? null : { x, y, z, leaves };
}

/** 면마다 밝기를 조금씩 달리한다. 위치로 정하므로 메시를 다시 만들어도 같은 면은 같은 밝기다. */
function jitter(c: RGB, cx: number, cy: number, cz: number): RGB {
  const j = 1 + (hashUnit(Math.round(cx * 4194304), Math.round(cy * 4194304), Math.round(cz * 4194304)) - 0.5) * 0.06;
  return [Math.min(1, c[0] * j), Math.min(1, c[1] * j), Math.min(1, c[2] * j)];
}

export function buildAdaptiveMesh(terrain: Terrain, view: ViewParams): AdaptiveMesh | null {
  const t0 = performance.now();
  const sub = subdivide(view);
  if (!sub) return null;
  const { x, y, z, leaves } = sub;
  const nF = leaves.length / 3;

  // 꼭짓점이 볼 자료의 세밀함은 그 꼭짓점에 닿은 면 중 가장 큰 것에 맞춘다. 꼭짓점마다 값이 하나라서 면 사이에 틈이 없다.
  const scale = new Float32Array(x.length);
  let minEdge = Infinity;
  for (let f = 0; f < leaves.length; f += 3) {
    const a = leaves[f], b = leaves[f + 1], c = leaves[f + 2];
    const e = Math.max(Math.hypot(x[a] - x[b], y[a] - y[b], z[a] - z[b]), Math.hypot(x[b] - x[c], y[b] - y[c], z[b] - z[c]), Math.hypot(x[c] - x[a], y[c] - y[a], z[c] - z[a])) * EARTH_RADIUS_KM;
    if (e < minEdge) minEdge = e;
    if (e > scale[a]) scale[a] = e;
    if (e > scale[b]) scale[b] = e;
    if (e > scale[c]) scale[c] = e;
  }
  const h = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) h[i] = scale[i] > 0 ? terrain.elevation(x[i], y[i], z[i], scale[i]) : 0;

  const data = new ArrayBuffer(nF * 2 * 3 * STRIDE);
  const f32 = new Float32Array(data), u8 = new Uint8Array(data);
  const [ox, oy, oz] = view.origin;
  let nv = 0;
  const flood = floodLevels(x, y, z, h, leaves, minEdge, view.judge);
  const put = (i: number, height: number, shade: number, c: RGB, alpha: number): void => {
    const o = nv * STRIDE, q = o / 4;
    f32[q] = x[i] - ox; f32[q + 1] = y[i] - oy; f32[q + 2] = z[i] - oz;
    f32[q + 3] = height; f32[q + 4] = shade;
    f32[q + 5] = flood ? flood.level[i] : h[i] - DRY_BELOW_M; f32[q + 6] = flood ? flood.front[i] : 0;
    f32[q + 7] = flood ? flood.coastLon[i] : 0; f32[q + 8] = flood ? flood.coastLat[i] : 0; f32[q + 9] = flood ? flood.frac[i] : 0;
    u8[o + 40] = Math.round(c[0] * 255); u8[o + 41] = Math.round(c[1] * 255); u8[o + 42] = Math.round(c[2] * 255); u8[o + 43] = alpha;
    nv++;
  };

  // 지형 층
  for (let f = 0; f < leaves.length; f += 3) {
    const a = leaves[f], b = leaves[f + 1], c = leaves[f + 2];
    if (Math.max(h[a], h[b], h[c]) < -HIDDEN_SEABED_DEPTH) continue;
    const mean = (h[a] + h[b] + h[c]) / 3;
    const cx = (x[a] + x[b] + x[c]) / 3, cy = (y[a] + y[b] + y[c]) / 3, cz = (z[a] + z[b] + z[c]) / 3;
    const col = jitter(mean >= 0 ? landColor(mean, Math.asin(Math.max(-1, Math.min(1, cy))) / DEG) : seabedColor(-mean), cx, cy, cz);
    put(a, h[a], h[a], col, 0); put(b, h[b], h[b], col, 0); put(c, h[c], h[c], col, 0);
  }
  const terrainVertices = nv;

  // 물 층. 수면은 평평하지만, 바닥의 기복을 음영용 높이에 넣어 해구와 해령이 면의 밝기로 드러나게 한다.
  // 침수 상자 안의 육지 면과 경험식 판정이 물을 넣은 육지 면에도 물 면을 둔다(D-034). 높이는 셰이더가 계산된 수위나 판정 수위로 정하고, 물이 없으면 지형 아래로 숨긴다.
  const fb = view.floodBox;
  const inFlood = (cx: number, cy: number, cz: number): boolean => {
    if (!fb) return false;
    const lat = Math.asin(Math.max(-1, Math.min(1, cy))) / DEG;
    if (lat < fb.south || lat > fb.north) return false;
    const lon = Math.atan2(cx, cz) / DEG;
    return fb.west <= fb.east ? lon >= fb.west && lon <= fb.east : lon >= fb.west || lon <= fb.east;
  };
  for (let f = 0; f < leaves.length; f += 3) {
    const a = leaves[f], b = leaves[f + 1], c = leaves[f + 2];
    if (Math.min(h[a], h[b], h[c]) >= 0) {
      const judged = flood !== null && (flood.level[a] > h[a] || flood.level[b] > h[b] || flood.level[c] > h[c]);
      if (!judged && !inFlood((x[a] + x[b] + x[c]) / 3, (y[a] + y[b] + y[c]) / 3, (z[a] + z[b] + z[c]) / 3)) continue;
      put(a, h[a], h[a], FLOOD_COLOR, ALPHA_FLOOD); put(b, h[b], h[b], FLOOD_COLOR, ALPHA_FLOOD); put(c, h[c], h[c], FLOOD_COLOR, ALPHA_FLOOD);
      continue;
    }
    const da = Math.min(h[a], 0), db = Math.min(h[b], 0), dc = Math.min(h[c], 0);
    const col = jitter(waterColor(-(da + db + dc) / 3), (x[a] + x[b] + x[c]) / 3 + 1, (y[a] + y[b] + y[c]) / 3, (z[a] + z[b] + z[c]) / 3);
    put(a, 0, da, col, 255); put(b, 0, db, col, 255); put(c, 0, dc, col, 255);
  }

  return {
    data: data.slice(0, nv * STRIDE),
    terrainVertices,
    waterVertices: nv - terrainVertices,
    faces: nF,
    minEdgeKm: minEdge,
    origin: view.origin,
    buildMs: performance.now() - t0,
  };
}

/**
 * 꼭짓점별 경험식 침수(D-031, D-034, D-037). level은 최대 물 높이(m, 해발), front는 침수 전선이 닿는 시각(s),
 * coastLon·coastLat은 값을 준 해안 칸의 중심(rad), frac은 그 칸의 수위에 곱할 비율 1 − d/X. 물이 안 닿는 꼭짓점은 지반 아래 높이, 시각 0, 비율 0.
 */
export interface FloodVertices {
  level: Float32Array;
  front: Float32Array;
  coastLon: Float32Array;
  coastLat: Float32Array;
  frac: Float32Array;
}

/**
 * 경험식 침수 판정을 꼭짓점에 넣는다(D-031, D-034, D-037, D-038).
 * 출발점은 둘이다. 침수 한계가 짧은(11 km 아래) 출발점은 육지와 바다가 만나는 면의 육지 꼭짓점(해안점)이고, 처오름과 도달 시각은 큰 격자에서 읽는다.
 * 한계가 긴 출발점은 격자의 해안 칸에서 판정이 미리 솎아 둔 것이라 보는 각도와 무관하다. 육지 꼭짓점의 물 높이는 둘레 출발점들 중 가장 높은 R × (1 − d / X)이고,
 * 전선 도달 시각은 그 출발점의 도달 시각에 d까지 가는 시간을 더한 것이다. 마지막으로 해안점에서 물 높이가 지반보다 높은 이웃으로만 번져 가며 닿지 못한 곳은 마른 것으로 한다.
 * 가장 작은 변이 3 km와 가장 긴 침수 한계보다 모두 크거나 판정이 없으면 null.
 */
export function floodLevels(
  x: number[], y: number[], z: number[], h: Float32Array, leaves: number[], minEdge: number,
  judge: ViewParams['judge'],
): FloodVertices | null {
  if (!judge || minEdge > Math.max(JUDGE_MAX_EDGE_KM, judge.maxLimitKm())) return null;
  const n = x.length;
  const isCoast = new Uint8Array(n);
  for (let f = 0; f < leaves.length; f += 3) {
    const a = leaves[f], b = leaves[f + 1], c = leaves[f + 2];
    const la = h[a] >= 0, lb = h[b] >= 0, lc = h[c] >= 0;
    if (la === lb && lb === lc) continue;
    if (la) isCoast[a] = 1;
    if (lb) isCoast[b] = 1;
    if (lc) isCoast[c] = 1;
  }
  const bigLimitR = BIG_LIMIT_M / 1000 / EARTH_RADIUS_KM_J;
  // 출발점 목록. 위치(단위 벡터), 처오름, 도달 시각, 한계(반지름 단위), 값을 준 해안 칸의 중심(rad)
  const sx: number[] = [], sy: number[] = [], sz: number[] = [], sRunup: number[] = [], sArr: number[] = [], sLimit: number[] = [], sLon: number[] = [], sLat: number[] = [];
  const smallBuckets = new Map<string, number[]>(), bigBuckets = new Map<string, number[]>();
  const SMALL_INV = 10; // 0.1도 칸
  // 짧은 출발점: 메시 해안점
  for (let i = 0; i < n; i++) {
    if (!isCoast[i]) continue;
    const lon = Math.atan2(x[i], z[i]) / DEG_J, lat = Math.asin(Math.max(-1, Math.min(1, y[i]))) / DEG_J;
    const r = judge.runupNear(lon, lat);
    if (r.runup <= 0) continue;
    const limit = judge.inlandLimit(r.runup) / 1000 / EARTH_RADIUS_KM_J;
    if (limit > bigLimitR) continue; // 긴 것은 격자에서 온다
    const k = sx.length;
    sx.push(x[i]); sy.push(y[i]); sz.push(z[i]); sRunup.push(r.runup); sArr.push(Math.max(0, r.arrival)); sLimit.push(limit); sLon.push(r.lon * DEG_J); sLat.push(r.lat * DEG_J);
    const key = `${Math.floor(lon * SMALL_INV)}:${Math.floor(lat * SMALL_INV)}`;
    (smallBuckets.get(key) ?? smallBuckets.set(key, []).get(key)!).push(k);
  }
  // 긴 출발점: 격자 해안 칸(판정이 솎아 둔 것)
  const big = judge.bigSources();
  const bigInv = 1 / big.cellDeg;
  for (const b of big.items) {
    const lon = b.lon * DEG_J, lat = b.lat * DEG_J, cl = Math.cos(lat);
    const k = sx.length;
    sx.push(cl * Math.sin(lon)); sy.push(Math.sin(lat)); sz.push(cl * Math.cos(lon));
    sRunup.push(b.runup); sArr.push(Math.max(0, b.arrival)); sLimit.push(b.limit / 1000 / EARTH_RADIUS_KM_J); sLon.push(lon); sLat.push(lat);
    const key = `${Math.floor(b.lon * bigInv)}:${Math.floor(b.lat * bigInv)}`;
    (bigBuckets.get(key) ?? bigBuckets.set(key, []).get(key)!).push(k);
  }
  if (sx.length === 0) return null;

  const level = new Float32Array(n), front = new Float32Array(n), coastLon = new Float32Array(n), coastLat = new Float32Array(n), frac = new Float32Array(n);
  let best = -Infinity, bestC = -1, bestFrac = 0, bestFront = 0;
  const consider = (i: number, list: number[] | undefined): void => {
    if (!list) return;
    for (const c of list) {
      const d = Math.hypot(x[i] - sx[c], y[i] - sy[c], z[i] - sz[c]);
      if (d >= sLimit[c]) continue;
      const f = 1 - d / sLimit[c], lv = sRunup[c] * f;
      if (lv > best) { best = lv; bestC = c; bestFrac = f; bestFront = sArr[c] + judge.frontDelay(sRunup[c], d * EARTH_RADIUS_KM_J * 1000, sLimit[c] * EARTH_RADIUS_KM_J * 1000); }
    }
  };
  for (let i = 0; i < n; i++) {
    level[i] = h[i] - DRY_BELOW_M;
    if (h[i] < 0) continue;
    const lon = Math.atan2(x[i], z[i]) / DEG_J, lat = Math.asin(Math.max(-1, Math.min(1, y[i]))) / DEG_J;
    best = -Infinity; bestC = -1; bestFrac = 0; bestFront = 0;
    if (smallBuckets.size > 0) {
      const bx = Math.floor(lon * SMALL_INV), by = Math.floor(lat * SMALL_INV);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) consider(i, smallBuckets.get(`${bx + dx}:${by + dy}`));
    }
    if (bigBuckets.size > 0) {
      const bx = Math.floor(lon * bigInv), by = Math.floor(lat * bigInv);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) consider(i, bigBuckets.get(`${bx + dx}:${by + dy}`));
    }
    if (bestC >= 0) { level[i] = best; front[i] = bestFront; coastLon[i] = sLon[bestC]; coastLat[i] = sLat[bestC]; frac[i] = bestFrac; }
  }

  // 연결 검사(D-038): 해안점에서 출발해 물 높이가 지반보다 높은 이웃으로만 번져 간다. 능선이 물 높이보다 높으면 그 뒤는 마른다.
  const deg = new Int32Array(n + 1);
  for (let f = 0; f < leaves.length; f++) deg[leaves[f] + 1] += 2;
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(deg[n]), fill = Int32Array.from(deg.subarray(0, n));
  for (let f = 0; f < leaves.length; f += 3) {
    const a = leaves[f], b = leaves[f + 1], c = leaves[f + 2];
    adj[fill[a]++] = b; adj[fill[a]++] = c; adj[fill[b]++] = a; adj[fill[b]++] = c; adj[fill[c]++] = a; adj[fill[c]++] = b;
  }
  const reached = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (isCoast[i] && level[i] > h[i]) { reached[i] = 1; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++];
    for (let e = deg[i]; e < deg[i + 1]; e++) {
      const j = adj[e];
      if (reached[j] || h[j] < 0 || level[j] <= h[j]) continue;
      reached[j] = 1; queue[qt++] = j;
    }
  }
  for (let i = 0; i < n; i++) if (h[i] >= 0 && level[i] > h[i] && !reached[i]) { level[i] = h[i] - DRY_BELOW_M; front[i] = 0; frac[i] = 0; }
  return { level, front, coastLon, coastLat, frac };
}
