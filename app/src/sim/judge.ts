import { latToPy, lonToPx, pxToLon, pyToLat } from '../geo/mercator';
import type { GridInput } from './solver';

/**
 * 경험식 침수 판정(결정 D-031). 큰 격자(전 지구 39 km, 발생원 8 km)의 기록에서 해안 칸의 최대 파고를 읽어
 * 처오름 높이를 구하고, 해안에서 내륙으로 가며 물 높이가 줄어드는 거리를 낸다. 2차원 세밀 계산 없이 전 세계 해안을 한 번에 판정한다.
 *
 *   처오름 R = 앞바다 최대 파고 A × min(5, (수심 / 1 m)^(1/4))      Green 법칙으로 수심 1 m까지 증폭
 *   침수 한계 거리 X = 0.06 × R^(4/3) / n²                            Hills & Mader (1997), n은 Manning 조도계수
 *   해안에서 d 떨어진 곳의 물 높이 L = R × (1 − d / X)                직선 감소
 *
 * 정확도는 자릿수 수준이다. 만이나 항구에 파가 몰리는 효과는 없다. 그 자리를 더 자세히 보려면 해안 격자(D-024)를 쓴다.
 */

export const MANNING_N = 0.025;
/** 이보다 낮은 처오름은 없는 것으로 본다(m). */
const RUNUP_MIN_M = 0.2;

/** 기록의 G·B·A 채널에 찍는 도달 문턱값(m). 계산 옵션 arrivalThresholds의 기본값도 이것을 쓴다. */
export const ARRIVAL_THRESHOLDS = [0.02, 0.3, 1.5] as const;
/** 최대 파고의 이 비율 아래인 가장 높은 문턱값의 도달 시각을 쓴다. */
export const ARRIVAL_FRACTION = 0.3;
/** 칸 k의 도달 시각(s). 최대 파고에 맞는 문턱값의 시각이고, 없으면 -1. */
export function pickArrival(record: Float32Array, k: number, maxEta: number): number {
  let out = -1;
  for (let i = 0; i < 3; i++) {
    if (ARRIVAL_THRESHOLDS[i] > ARRIVAL_FRACTION * maxEta && i > 0) break;
    const t = record[k * 4 + 1 + i];
    if (t >= 0) out = t;
  }
  return out;
}

/** 상한은 두지 않는다(D-035). 소행성은 처오름 수백 m, 거리 수백 km가 나올 수 있고 그게 식의 답이다. */
export const inlandLimit = (runup: number): number => (0.06 * Math.max(0, runup) ** (4 / 3)) / (MANNING_N * MANNING_N);
/**
 * 앞바다 최대 파고 A(수심 h의 칸)에서 처오름. Green 법칙 (h / 1 m)^(1/4)(최대 5배)로 커지되, 파고가 수심에 이르는 곳에서 멈춘다(부서짐, D-038).
 * 부서지는 수심 h_b = (A h^(1/4))^(4/5)이고 거기까지의 배율은 (h / A)^(1/5)다. 그 뒤로는 속도가 높이로 바뀌는 만큼 1.5배만 더 오른다.
 * 파고가 수심보다 크면 배율 1.5다. 지진(파고 ≪ 수심)은 Green 법칙과 거의 같고, 소행성의 수백 m 파는 더 커지지 않는다.
 */
export const shoalFactor = (maxEta: number, depth: number): number => {
  const h = Math.max(depth, 1);
  const green = Math.min(5, h ** 0.25);
  const breaking = 1.5 * Math.max(1, (h / Math.max(maxEta, 1e-6)) ** 0.2);
  return Math.min(green, breaking);
};
export const runupFromOffshore = (maxEta: number, depth: number): number => maxEta * shoalFactor(maxEta, depth);
/**
 * 파의 주기를 함께 보는 침수 한계 거리(m, D-039). Hills & Mader 거리와, 파가 밀어 넣는 동안 전선이 갈 수 있는 거리 FRONT_K √(gR) T 중 작은 쪽.
 * Hills & Mader 식은 수십 m 처오름에서 맞춘 것이라 수백 m에서는 수백~수천 km가 나온다. 주기를 모르면(Infinity) Hills & Mader만 쓴다.
 */
export const inlandLimitBounded = (runup: number, periodS: number): number => Math.min(inlandLimit(runup), FRONT_K * Math.sqrt(G * Math.max(runup, 0)) * periodS);
/** 침수 한계가 이보다 긴 출발점은 메시 꼭짓점 대신 격자 해안 칸에서 뽑는다(m, D-038). 보는 각도에 따라 판정이 바뀌지 않게 한다. */
export const BIG_LIMIT_M = 11000;
const DEG = Math.PI / 180;

/** 육지 위 침수 전선의 속도 계수(D-034). 전선 속도 = FRONT_K × √(g × 그 자리의 물 높이). 도호쿠 센다이 평야의 전선(초속 3~8 m)에 맞췄다. */
export const FRONT_K = 0.5;
const G = 9.81;
/**
 * 침수 전선이 해안에서 d(m) 안쪽까지 가는 데 걸리는 시간(s). 물 높이 L(d) = R(1 − d/X)이고 속도가 FRONT_K √(g L)이므로
 * 적분하면 t(d) = 2X / (FRONT_K √(gR)) × (1 − √(1 − d/X))다. 한계 거리 X까지 가는 시간도 유한하다.
 */
export const frontDelay = (runup: number, d: number, limit = inlandLimit(runup)): number => {
  if (runup <= 0 || limit <= 0) return 0;
  const X = limit;
  const s = Math.max(0, 1 - Math.min(d, X) / X);
  return ((2 * X) / (FRONT_K * Math.sqrt(G * runup))) * (1 - Math.sqrt(s));
};

interface Level {
  grid: GridInput;
  /** 해안 칸(육지와 맞닿은 바다 칸)의 번호. */
  coastCells: Int32Array;
  /** 칸별 처오름(m). 해안 칸이 아니거나 아직 없으면 0. */
  runup: Float32Array;
  /** 칸별 도달 시각(s). 최대 파고에 맞는 문턱값의 도달 시각이다. 없으면 -1. */
  arrival: Float32Array;
}

export interface NearRunup {
  runup: number;
  arrival: number;
  /** 값을 준 해안 칸의 중심 경위도(도). 없으면 0. */
  lon: number;
  lat: number;
}
const NO_RUNUP: NearRunup = { runup: 0, arrival: -1, lon: 0, lat: 0 };

/** 격자 해안 칸에서 뽑은 침수 출발점. 경위도는 칸 중심(도), limit은 침수 한계 거리(m). */
export interface BigSource {
  lon: number;
  lat: number;
  runup: number;
  arrival: number;
  limit: number;
}

export interface CityImpact {
  name: string;
  lon: number;
  lat: number;
  popK: number;
  runup: number;
  arrival: number;
  inland: number;
}

export class FloodJudge {
  private readonly levels: Level[] = [];
  /** 처오름이 있는 칸이 하나라도 있는가. */
  any = false;
  version = 0;
  /** 해안 칸의 처오름이 마지막으로 커진 계산 시각(s). 한동안 안 바뀌면 파가 새로 하는 일이 없다는 뜻이다(D-040). */
  lastChangeT = 0;
  private cacheVersion = -1;
  private maxLimitCache = 0;
  private bigCache: { cellDeg: number; items: BigSource[] } = { cellDeg: 0.1, items: [] };

  /**
   * 세밀한 단계를 앞에 둔다. 판정은 앞에서부터 찾아 그 안이면 그 값을 쓴다.
   * periodS는 파의 주기(s). 침수 한계 거리를 주기 동안 전선이 갈 수 있는 거리로 묶는다(D-039). 모르면 Infinity.
   */
  constructor(grids: GridInput[], readonly periodS = Infinity) {
    for (const grid of grids) {
      const { nx, ny, wet0 } = grid;
      const cells: number[] = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!wet0[k]) continue;
        const w = grid.wrapX ? wet0[j * nx + ((i - 1 + nx) % nx)] : i > 0 ? wet0[k - 1] : 1;
        const e = grid.wrapX ? wet0[j * nx + ((i + 1) % nx)] : i < nx - 1 ? wet0[k + 1] : 1;
        const n = j > 0 ? wet0[k - nx] : 1, s = j < ny - 1 ? wet0[k + nx] : 1;
        if (!w || !e || !n || !s) cells.push(k);
      }
      this.levels.push({ grid, coastCells: Int32Array.from(cells), runup: new Float32Array(nx * ny), arrival: new Float32Array(nx * ny).fill(-1) });
    }
  }

  /** 처오름 R의 침수 한계 거리(m). 주기로 묶은 값이다. */
  limitOf(runup: number): number {
    return inlandLimitBounded(runup, this.periodS);
  }

  get coastCellCount(): number[] {
    return this.levels.map((l) => l.coastCells.length);
  }

  /**
   * 단계의 기록(R = 최대 수위, G·B·A = 문턱값 ARRIVAL_THRESHOLDS를 넘은 첫 시각)으로 처오름을 갱신한다.
   * 도달 시각은 최대 파고의 ARRIVAL_FRACTION 아래인 가장 높은 문턱값의 시각이다. 초기 변형이 움직여 찍힌 이른 시각을 피하고, 큰 파의 앞머리가 닿는 때에 가깝다.
   */
  update(level: number, record: Float32Array, t = 0): void {
    const lv = this.levels[level];
    const { bed } = lv.grid;
    let changed = false;
    for (const k of lv.coastCells) {
      const maxEta = record[k * 4];
      const r = maxEta > -1e4 && maxEta > 0 ? runupFromOffshore(maxEta, -bed[k]) : 0;
      const next = r >= RUNUP_MIN_M ? r : 0;
      // 5 %와 5 cm를 넘게 커진 것만 변화로 친다. 닫힌 바다에서 오래 출렁이는 파가 1 %씩 갱신하는 것은 새 일이 아니다
      if (next > lv.runup[k] * 1.05 + 0.05) changed = true;
      lv.runup[k] = next;
      lv.arrival[k] = pickArrival(record, k, maxEta);
      if (lv.runup[k] > 0) this.any = true;
    }
    if (changed) this.lastChangeT = t;
    this.version++;
  }

  private cellOf(lv: Level, lon: number, lat: number): [number, number] | null {
    const g = lv.grid;
    let i = Math.floor(lonToPx(lon, g.zoom)) - g.px0, j = Math.floor(latToPy(lat, g.zoom)) - g.py0;
    if (g.wrapX) i = ((i % g.nx) + g.nx) % g.nx;
    else if (i < 0 || i >= g.nx) return null;
    if (j < 0 || j >= g.ny) return null;
    return [i, j];
  }

  /**
   * 경위도 근처의 처오름(m)과 도달 시각(s). 그 자리를 덮는 가장 세밀한 단계에서 그 칸, 둘레 한 칸, 두 칸 순으로 보고,
   * 처오름이 있는 첫 고리에서 가장 큰 값을 고른다(D-036). 전에는 ±2칸 전체의 최대였는데, 그러면 옆 칸의 큰 파가 넘어와
   * 해안선에서 바다 수면과 어긋났다. 없으면 처오름 0.
   */
  runupNear(lon: number, lat: number): NearRunup {
    for (const lv of this.levels) {
      const c = this.cellOf(lv, lon, lat);
      if (!c) continue;
      const g = lv.grid, [ci, cj] = c;
      for (let ring = 0; ring <= 2; ring++) {
        let best = 0, arrival = -1, bi = 0, bj = 0;
        for (let dj = -ring; dj <= ring; dj++) {
          const j = cj + dj;
          if (j < 0 || j >= g.ny) continue;
          for (let di = -ring; di <= ring; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
            let i = ci + di;
            if (g.wrapX) i = ((i % g.nx) + g.nx) % g.nx;
            else if (i < 0 || i >= g.nx) continue;
            const k = j * g.nx + i;
            if (lv.runup[k] > best) { best = lv.runup[k]; arrival = lv.arrival[k]; bi = i; bj = j; }
          }
        }
        // 값을 준 해안 칸의 중심. 그리기는 이 자리의 현재 수위를 읽어 육지 물 높이로 쓴다(D-037)
        if (best > 0) return { runup: best, arrival, lon: pxToLon(g.px0 + bi + 0.5, g.zoom), lat: pyToLat(g.py0 + bj + 0.5, g.zoom) };
      }
      return NO_RUNUP;
    }
    return NO_RUNUP;
  }

  /** 판정 결과 중 버전마다 한 번만 계산하는 것. 가장 긴 침수 한계와, 한계가 긴 출발점의 목록. */
  private refresh(): void {
    if (this.cacheVersion === this.version) return;
    this.cacheVersion = this.version;
    let maxLimit = 0;
    const raw: BigSource[] = [];
    this.levels.forEach((lv, li) => {
      const g = lv.grid;
      for (const k of lv.coastCells) {
        const r = lv.runup[k];
        if (r <= 0) continue;
        const X = this.limitOf(r);
        if (X > maxLimit) maxLimit = X;
        if (X <= BIG_LIMIT_M) continue;
        const i = k % g.nx, j = (k - i) / g.nx;
        const lon = pxToLon(g.px0 + i + 0.5, g.zoom), lat = pyToLat(g.py0 + j + 0.5, g.zoom);
        // 더 세밀한 단계가 덮는 자리는 그 단계의 칸을 쓴다
        let covered = false;
        for (let f = 0; f < li && !covered; f++) covered = this.cellOf(this.levels[f], lon, lat) !== null;
        if (covered) continue;
        raw.push({ lon, lat, runup: r, arrival: lv.arrival[k], limit: X });
      }
    });
    this.maxLimitCache = maxLimit / 1000;
    // 검색 칸 크기는 가장 긴 한계 거리(도). 칸의 1/4 간격으로 솎되 같은 자리에서는 처오름이 큰 칸을 남긴다. 격자 칸에서 뽑으므로 보는 각도와 무관하다.
    let cellDeg = 0.1;
    for (const b of raw) cellDeg = Math.max(cellDeg, b.limit / 111195 / Math.max(0.2, Math.cos(b.lat * DEG)));
    const subInv = 4 / cellDeg, reps = new Map<string, BigSource>();
    for (const b of raw) {
      const key = `${Math.floor(b.lon * subInv)}:${Math.floor(b.lat * subInv)}`;
      const prev = reps.get(key);
      if (!prev || b.runup > prev.runup) reps.set(key, b);
    }
    this.bigCache = { cellDeg, items: [...reps.values()] };
  }

  /** 해안 칸 중 가장 긴 침수 한계 거리(km). 메시의 가장 작은 변이 이보다 크면 판정을 그릴 뜻이 없다. */
  maxLimitKm(): number {
    this.refresh();
    return this.maxLimitCache;
  }

  /** 침수 한계가 BIG_LIMIT_M보다 긴 출발점(격자 해안 칸, 솎은 것)과 그 검색 칸 크기(도). */
  bigSources(): { cellDeg: number; items: BigSource[] } {
    this.refresh();
    return this.bigCache;
  }

  /** 처오름이 큰 순으로 도시 영향을 낸다. 해안(가장 세밀한 단계의 해안 칸에서 ±2칸) 도시만 든다. */
  cityImpacts(cities: { name: string; lon: number; lat: number; popK: number }[], limit: number): CityImpact[] {
    const out: CityImpact[] = [];
    for (const c of cities) {
      const r = this.runupNear(c.lon, c.lat);
      if (r.runup <= 0) continue;
      out.push({ name: c.name, lon: c.lon, lat: c.lat, popK: c.popK, runup: r.runup, arrival: r.arrival, inland: this.limitOf(r.runup) });
    }
    out.sort((a, b) => b.runup - a.runup);
    return out.slice(0, limit);
  }

  /** 해안 칸의 처오름 목록(경위도, 처오름). 검증에 쓴다. */
  coastRunups(level: number): { lon: number; lat: number; runup: number }[] {
    const lv = this.levels[level], g = lv.grid, out = [];
    for (const k of lv.coastCells) {
      if (lv.runup[k] <= 0) continue;
      const i = k % g.nx, j = (k - i) / g.nx;
      out.push({ lon: pxToLon(g.px0 + i + 0.5, g.zoom), lat: pyToLat(g.py0 + j + 0.5, g.zoom), runup: lv.runup[k] });
    }
    return out;
  }
}
