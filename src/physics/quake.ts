import { DEG } from '../geo/mercator';
import { KM_PER_DEG, RIGIDITY, SEISMOGENIC_DEPTH } from './constants';
import { okadaUzRow } from './okada';

export type SlipModel = 'uniform' | 'tapered';

export interface FaultDimensions { lengthKm: number; widthKm: number }

export interface QuakeParams {
  kind: 'quake';
  /** 단층 지표 투영의 중심. */
  lon: number;
  lat: number;
  Mw: number;
  /** 지정하면 단층 크기를 유지하고 규모에 맞춰 미끄러짐만 바꾼다. 없으면 경험식 크기. */
  dimensions?: FaultDimensions;
  /** 주향(북쪽 기준 시계방향, 도). 경사 방향은 주향 + 90도. */
  strike: number;
  /** 경사각(도). */
  dip: number;
  /** 미끄러짐 방향(도). 90 = 순수 역단층. */
  rake: number;
  /** 단층 윗면 깊이(km). */
  topKm: number;
  slipModel: SlipModel;
}

export interface FaultGeometry {
  /** 길이와 폭(m). */
  L: number;
  W: number;
  /** 평균 미끄러짐(m). */
  meanSlip: number;
  peakSlip: number;
  M0: number;
  dipRad: number;
  topM: number;
}

/** Strasser 외 (2010) 섭입대 경계면 스케일링. 크기를 지정하지 않은 경우 폭은 지진발생층 깊이와 길이로 상한을 둔다. */
export function faultFromMagnitude(Mw: number, dipDeg: number, topKm: number, dimensions?: FaultDimensions): FaultGeometry {
  const L = dimensions ? dimensions.lengthKm * 1000 : 10 ** (-2.477 + 0.585 * Mw) * 1000;
  let W = 10 ** (-0.882 + 0.351 * Mw) * 1000;
  const dipRad = dipDeg * DEG;
  const topM = topKm * 1000;
  W = Math.min(W, Math.max(5000, (SEISMOGENIC_DEPTH - topM) / Math.sin(dipRad)), L);
  if (dimensions) {
    W = dimensions.widthKm * 1000;
    if (!Number.isFinite(L) || !Number.isFinite(W) || L <= 0 || W <= 0) throw new Error('단층 길이와 폭은 양의 유한값이어야 합니다.');
  }
  const M0 = 10 ** (1.5 * Mw + 9.1);
  const meanSlip = M0 / (RIGIDITY * L * W);
  return { L, W, meanSlip, peakSlip: meanSlip, M0, dipRad, topM };
}

export interface SubFault {
  /** 단층 기준 좌표(km). a는 주향 방향 시작점, c는 윗변에서 경사 방향으로 내려간 거리의 시작점. */
  a0: number;
  c0: number;
  len: number;
  wid: number;
  slip: number;
}

/**
 * 단층을 소단층으로 나누고 미끄러짐을 배분한다.
 * tapered는 주향 양끝에서 코사인으로 줄고, 경사 방향으로는 얕은 쪽(해구 쪽) 1/3 지점에서 최대가 된다.
 * 평균 미끄러짐이 보존되도록 정규화하므로 모멘트는 바뀌지 않는다.
 * 균일 슬립은 슬립이 몰린 실제 지진의 근거리 파고를 과소평가하기 때문에 tapered를 기본으로 쓴다.
 */
export function subdivideFault(f: FaultGeometry, model: SlipModel): SubFault[] {
  const Lk = f.L / 1000, Wk = f.W / 1000;
  if (model === 'uniform') return [{ a0: 0, c0: 0, len: Lk, wid: Wk, slip: f.meanSlip }];
  const ns = Math.max(3, Math.min(24, Math.round(Lk / 30)));
  const nd = Math.max(3, Math.min(8, Math.round(Wk / 25)));
  const subs: SubFault[] = [];
  let sum = 0;
  for (let jd = 0; jd < nd; jd++) {
    const v = (jd + 0.5) / nd; // 0 = 윗변(얕은 쪽)
    // 얕은 쪽 1/3에서 최대인 비대칭 분포
    const wd = v < 1 / 3 ? 0.35 + 0.65 * Math.sin((v * 3 * Math.PI) / 2) ** 2 : Math.cos(((v - 1 / 3) / (2 / 3)) * (Math.PI / 2)) ** 2 * 0.95 + 0.05;
    for (let is = 0; is < ns; is++) {
      const u = (is + 0.5) / ns;
      const ws = u < 0.25 ? Math.sin((u / 0.25) * (Math.PI / 2)) ** 2 : u > 0.75 ? Math.sin(((1 - u) / 0.25) * (Math.PI / 2)) ** 2 : 1;
      const w = Math.max(0.02, wd * ws);
      sum += w;
      subs.push({ a0: (is * Lk) / ns, c0: (jd * Wk) / nd, len: Lk / ns, wid: Wk / nd, slip: w });
    }
  }
  const scale = (f.meanSlip * subs.length) / sum;
  let peak = 0;
  for (const s of subs) {
    s.slip *= scale;
    if (s.slip > peak) peak = s.slip;
  }
  f.peakSlip = peak;
  return subs;
}

export interface QuakeField {
  fault: FaultGeometry;
  subfaults: SubFault[];
  /** 지표 투영의 네 꼭짓점 [lon, lat]. 윗변(해구 쪽) 두 점이 먼저 온다. */
  outline: [number, number][];
  /** 영향 반경(km). 이 밖은 변위를 0으로 본다. */
  reachKm: number;
  uz(lon: number, lat: number): number;
}

export function buildQuakeField(p: QuakeParams): QuakeField {
  const fault = faultFromMagnitude(p.Mw, p.dip, p.topKm, p.dimensions);
  const subfaults = subdivideFault(fault, p.slipModel);
  const th = p.strike * DEG;
  const sx = Math.sin(th), sy = Math.cos(th); // 주향 단위벡터 (동, 북)
  const dx = Math.sin(th + Math.PI / 2), dy = Math.cos(th + Math.PI / 2); // 경사 방향
  const Lk = fault.L / 1000, Wk = fault.W / 1000;
  const cd = Math.cos(fault.dipRad), sd = Math.sin(fault.dipRad);
  const Wh = Wk * cd; // 폭의 수평 투영
  const topKm = p.topKm;
  const kx = KM_PER_DEG * Math.cos(p.lat * DEG), ky = KM_PER_DEG;
  const rake = p.rake * DEG;
  // 순수 역단층(90도)의 cos은 6e-17이 나온다. 0으로 두지 않으면 값에 보태지지도 않는 주향이동 항을 통째로 계산한다.
  const snap = (v: number): number => (Math.abs(v) < 1e-12 ? 0 : v);
  const cr = snap(Math.cos(rake)), sr = snap(Math.sin(rake));
  const reachKm = (Lk + Wh) / 2 + Math.max(150, Wk);

  // 깊이가 같은 소단층을 한 줄로 묶는다. 한 줄 안에서는 주향 방향 경계만 다르다.
  const rows: { botC: number; wid: number; edges: number[]; slips: number[] }[] = [];
  for (const s of subfaults) {
    let row = rows[rows.length - 1];
    if (!row || row.botC !== s.c0 + s.wid) rows.push(row = { botC: s.c0 + s.wid, wid: s.wid, edges: [s.a0], slips: [] });
    row.slips.push(s.slip);
    row.edges.push(s.a0 + s.len);
  }

  const uz = (lon: number, lat: number): number => {
    const E = (lon - p.lon) * kx, N = (lat - p.lat) * ky;
    if (Math.abs(E) > reachKm || Math.abs(N) > reachKm) return 0;
    const along = E * sx + N * sy + Lk / 2; // 단층 시작 모서리 기준 주향 좌표
    const down = E * dx + N * dy + Wh / 2; // 윗변 기준 경사 방향 수평 거리
    let sum = 0;
    for (const r of rows) {
      // 소단층 아래쪽 변이 Okada 좌표의 y = 0
      // slip은 m, 길이는 km이지만 uz는 slip에 선형이고 길이 비율에만 의존하므로 단위가 섞여도 된다
      sum += okadaUzRow(along, r.edges, r.slips, r.botC * cd - down, r.wid, topKm + r.botC * sd, fault.dipRad, cr, sr);
    }
    return sum;
  };

  const corner = (a: number, c: number): [number, number] => {
    const E = (a - Lk / 2) * sx + (c - Wh / 2) * dx;
    const N = (a - Lk / 2) * sy + (c - Wh / 2) * dy;
    return [p.lon + E / kx, p.lat + N / ky];
  };
  const outline: [number, number][] = [corner(0, 0), corner(Lk, 0), corner(Lk, Wh), corner(0, Wh)];
  return { fault, subfaults, outline, reachKm, uz };
}
