import { describe, expect, it } from 'vitest';
import { FloodJudge, FRONT_K, frontDelay, inlandLimit, inlandLimitBounded, pickArrival, runupFromOffshore } from '../../app/src/sim/judge';
import type { GridInput } from '../../app/src/sim/solver';
import { DRY_BELOW_M, floodLevels, JUDGE_MAX_EDGE_KM } from '../../app/src/globe/adaptive';
import { lonLatToDir } from '../../app/src/globe/icosphere';

/** 줌 6, 왼쪽 절반 바다(수심 100 m), 오른쪽 절반 육지(2 m)인 32×32 격자. 경도 0도, 위도 0도 근처. */
function grid(): GridInput {
  const nx = 32, ny = 32, world = 256 * 64;
  const px0 = world / 2 - 16, py0 = world / 2 - 16;
  const bed = new Float32Array(nx * ny), eta0 = new Float32Array(nx * ny), wet0 = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (i < 16) { bed[k] = -100; wet0[k] = 1; } else { bed[k] = 2; eta0[k] = 2; }
  }
  return { nx, ny, bed, eta0, wet0, zoom: 6, px0, py0, world, eqCell: 40075016.686 / world, wrapX: false, sponge: false };
}

describe('경험식 침수 판정', () => {
  it('처오름은 Green 법칙으로, 침수 한계 거리는 Hills & Mader 식으로 구한다', () => {
    expect(runupFromOffshore(2, 100)).toBeCloseTo(2 * 100 ** 0.25, 6);
    expect(runupFromOffshore(2, 10000)).toBeCloseTo(10, 6); // 증폭 상한 5
    expect(inlandLimit(6.32)).toBeGreaterThan(1000);
    expect(inlandLimit(6.32)).toBeLessThan(1300);
    // 상한은 없다(D-035). 처오름 300 m면 거리 약 190 km, 앞바다 100 m는 처오름 500 m
    expect(inlandLimit(300)).toBeGreaterThan(180000);
    expect(inlandLimit(300)).toBeLessThan(200000);
    // 주기로 묶은 한계(D-039): 10 km 소행성(주기 약 30분)의 처오름 491 m는 63 km, 도호쿠(주기 약 52분)의 12.4 m는 Hills & Mader 그대로
    expect(inlandLimitBounded(491, 1824)).toBeCloseTo(FRONT_K * Math.sqrt(9.81 * 491) * 1824, 3);
    expect(inlandLimitBounded(491, 1824)).toBeLessThan(70000);
    expect(inlandLimitBounded(12.4, 3150)).toBeCloseTo(inlandLimit(12.4), 6);
    expect(inlandLimitBounded(12.4, Infinity)).toBe(inlandLimit(12.4));
    expect(runupFromOffshore(100, 10000)).toBeCloseTo(100 * 1.5 * 100 ** 0.2, 4); // 부서짐: Green 5배 대신 3.8배
    // 파고가 수심보다 크면 더 커지지 않고 1.5배만 오른다(D-038)
    expect(runupFromOffshore(650, 50)).toBeCloseTo(975, 6);
    expect(runupFromOffshore(6.2, 26)).toBeCloseTo(6.2 * 1.5 * (26 / 6.2) ** 0.2, 4); // 센다이: 12.4 m
  });

  it('근처 처오름은 가까운 고리부터 찾는다. 두 칸 밖의 더 큰 파는 넘어오지 않는다', () => {
    // 15번 열이 해안. 18번 열 16번 행에 한 칸짜리 호수를 둔다(사방이 육지라 해안 칸이다). 호수의 파고를 해안의 다섯 배로 준다.
    const g = grid();
    const lake = 16 * g.nx + 18;
    g.wet0[lake] = 1; g.bed[lake] = -100; g.eta0[lake] = 0;
    const judge = new FloodJudge([g]);
    const rec = new Float32Array(g.nx * g.ny * 4).fill(-1e5);
    for (let k = 0; k < g.nx * g.ny; k++) { rec[k * 4] = g.wet0[k] ? (k === lake ? 10 : 2) : -1e5; rec[k * 4 + 1] = g.wet0[k] ? 600 : -1; }
    judge.update(0, rec);
    const lonOf = (col: number) => ((g.px0 + col + 0.5) / g.world) * 360 - 180;
    const latOf = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (g.py0 + row + 0.5)) / g.world))) * 180) / Math.PI;
    // 16번 열: 한 칸 옆이 해안(처오름 6.3). 두 칸 옆 호수(23.8)는 보지 않는다
    expect(judge.runupNear(lonOf(16), latOf(16)).runup).toBeCloseTo(2 * 100 ** 0.25, 4);
    // 17번 열: 한 칸 옆에 호수가 있어 호수 값이다(파고 10 m는 수심 100 m에서 부서짐 배율 2.38)
    expect(judge.runupNear(lonOf(17), latOf(16)).runup).toBeCloseTo(10 * 1.5 * 10 ** 0.2, 4);
    // 19번 열: 한 칸 옆 호수
    expect(judge.runupNear(lonOf(19), latOf(16)).runup).toBeCloseTo(10 * 1.5 * 10 ** 0.2, 4);
    // 21번 열: 두 칸 안에 아무것도 없다
    expect(judge.runupNear(lonOf(21), latOf(16)).runup).toBe(0);
  });

  it('도달 시각은 최대 파고에 맞는 문턱값의 것을 고른다', () => {
    const rec = Float32Array.from([5, 100, 1200, 3300]); // 최대 5 m, 0.02 m는 100 s, 0.3 m는 1200 s, 1.5 m는 3300 s
    expect(pickArrival(rec, 0, 5)).toBe(3300); // 1.5 ≤ 0.3 × 5
    expect(pickArrival(rec, 0, 2)).toBe(1200); // 0.3 ≤ 0.6 < 1.5
    expect(pickArrival(rec, 0, 0.5)).toBe(100); // 작은 파는 첫 도달
    expect(pickArrival(Float32Array.from([5, 100, -1, -1]), 0, 5)).toBe(100); // 높은 문턱을 아직 못 넘었으면 있는 것 중 가장 높은 것
    expect(pickArrival(Float32Array.from([0.01, -1, -1, -1]), 0, 0.01)).toBe(-1);
  });

  it('침수 한계가 수백 km면 검색 칸을 그만큼 키우고 해안점을 솎아, 먼 내륙 꼭짓점도 물 높이를 받는다', () => {
    // 경도 0도 선이 해안. 동쪽 육지 2 m. 꼭짓점을 동서로 20 km 간격으로 400 km까지 둔다.
    const kmPerDeg = 111.195;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], hs: number[] = [];
    const cols = 22;
    for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) {
      const lon = (c - 1) * 20 / kmPerDeg, lat = r * 20 / kmPerDeg;
      const d = lonLatToDir(lon, lat);
      xs.push(d[0]); ys.push(d[1]); zs.push(d[2]);
      hs.push(c < 1 ? -50 : 2);
    }
    const leaves: number[] = [];
    for (let c = 0; c + 1 < cols; c++) { const a = c, b = c + 1, d2 = cols + c, e = cols + c + 1; leaves.push(a, b, d2, b, e, d2); }
    const R = 300, X = inlandLimit(R); // 약 190 km
    // 한계가 11 km를 넘는 출발점은 메시 해안점이 아니라 격자 해안 칸에서 온다(D-038). 해안 칸 하나를 경도 0, 위도 0에 둔다
    const judge = { runupNear: () => ({ runup: R, arrival: 0, lon: 0, lat: 0 }), inlandLimit, frontDelay, maxLimitKm: () => X / 1000, bigSources: () => ({ cellDeg: 2, items: [{ lon: 0, lat: 0, runup: R, arrival: 0, limit: X }] }) };
    const { level } = floodLevels(xs, ys, zs, Float32Array.from(hs), leaves, 0.5, judge)!; // 가장 작은 변은 판정 문턱(3 km) 아래로 둔다
    expect(level[1]).toBeCloseTo(R, 0); // 해안점
    expect(level[1 + 5]).toBeCloseTo(R * (1 - 100000 / X), 0); // 100 km 안쪽. 0.1도 칸이었다면 못 찾았을 거리
    expect(level[1 + Math.ceil(X / 20000) + 1]).toBe(2 - DRY_BELOW_M); // 한계 밖
  });

  it('연결 검사: 물 높이보다 높은 능선 뒤의 낮은 골짜기에는 물이 가지 않는다', () => {
    // 경도 0도 선이 해안. 동쪽 육지 2 m. 500 m 간격. 8번 열(2 km)에 50 m 능선을 두 줄 모두에 둔다. 처오름 20 m면 한계 약 5.2 km라 능선 뒤(2.5 km)도 식으로는 10 m가 잠긴다
    const kmPerDeg = 111.195;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], hs: number[] = [];
    const cols = 24;
    for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) {
      const lon = (c - 4) * 0.5 / kmPerDeg, lat = r * 0.5 / kmPerDeg;
      const d = lonLatToDir(lon, lat);
      xs.push(d[0]); ys.push(d[1]); zs.push(d[2]);
      hs.push(c < 4 ? -50 : c === 8 ? 50 : 2);
    }
    const leaves: number[] = [];
    for (let c = 0; c + 1 < cols; c++) { const a = c, b = c + 1, d2 = cols + c, e = cols + c + 1; leaves.push(a, b, d2, b, e, d2); }
    const X = inlandLimit(20);
    const judge = { runupNear: () => ({ runup: 20, arrival: 0, lon: 0, lat: 0 }), inlandLimit, frontDelay, maxLimitKm: () => X / 1000, bigSources: () => ({ cellDeg: 0.1, items: [] }) };
    const { level, frac } = floodLevels(xs, ys, zs, Float32Array.from(hs), leaves, 0.5, judge)!;
    expect(level[6]).toBeCloseTo(20 * (1 - 1000 / X), 1); // 능선 앞 1 km: 잠긴다
    expect(level[8]).toBeCloseTo(20 * (1 - 2000 / X), 1); // 능선: 물 높이 12 m가 지반 50 m 아래라 마른다(값은 그대로 둔다)
    expect(level[9]).toBe(2 - DRY_BELOW_M); // 능선 뒤 골짜기: 식으로는 10 m지만 닿을 길이 없어 마른다
    expect(frac[9]).toBe(0);
    expect(level[cols + 9]).toBe(2 - DRY_BELOW_M); // 둘째 줄도 같다
  });

  it('침수 전선은 해안에서 출발해 물 높이가 낮아질수록 느려지고, 한계 거리까지 유한한 시간에 닿는다', () => {
    const R = 10, X = inlandLimit(R);
    expect(frontDelay(R, 0)).toBe(0);
    // 해안 바로 안쪽의 속도는 FRONT_K √(gR) ≈ 초속 5 m
    expect(100 / frontDelay(R, 100)).toBeCloseTo(FRONT_K * Math.sqrt(9.81 * R), 0);
    expect(frontDelay(R, 500)).toBeLessThan(frontDelay(R, 1000));
    expect(frontDelay(R, X)).toBeCloseTo((2 * X) / (FRONT_K * Math.sqrt(9.81 * R)), 6); // 약 14분
    expect(frontDelay(R, X * 2)).toBe(frontDelay(R, X)); // 한계 밖은 한계와 같다
    expect(frontDelay(0, 100)).toBe(0);
    // 한계를 따로 주면 그 한계로 계산한다
    expect(frontDelay(R, X / 2, X / 2)).toBeCloseTo((2 * (X / 2)) / (FRONT_K * Math.sqrt(9.81 * R)), 6);
  });

  it('해안 칸을 찾고, 기록으로 처오름을 갱신하며, 근처 지점과 도시의 영향을 낸다', () => {
    const g = grid();
    const judge = new FloodJudge([g]);
    expect(judge.coastCellCount[0]).toBe(32); // 15번 열 전체
    const rec = new Float32Array(g.nx * g.ny * 4).fill(-1e5);
    for (let k = 0; k < g.nx * g.ny; k++) { rec[k * 4] = g.wet0[k] ? 2 : -1e5; rec[k * 4 + 1] = g.wet0[k] ? 600 : -1; }
    expect(judge.any).toBe(false);
    judge.update(0, rec, 900);
    expect(judge.any).toBe(true);
    expect(judge.lastChangeT).toBe(900); // 처오름이 커졌다
    judge.update(0, rec, 1800);
    expect(judge.lastChangeT).toBe(900); // 같은 기록이면 바뀐 게 없다
    // 해안 바로 옆 육지 지점: 처오름 6.3 m, 도달 10분
    const coastLon = ((g.px0 + 16.5) / g.world) * 360 - 180;
    const r = judge.runupNear(coastLon, 0);
    expect(r.runup).toBeCloseTo(2 * 100 ** 0.25, 4);
    expect(r.arrival).toBe(600);
    // 값을 준 해안 칸(15번 열)의 중심
    expect(r.lon).toBeCloseTo(((g.px0 + 15.5) / g.world) * 360 - 180, 6);
    expect(Math.abs(r.lat)).toBeLessThan(0.02); // 줌 6 칸 하나의 절반
    // 최대 파고 2 m: 0.3 m 문턱(B)의 시각을 쓴다. 1.5 m 문턱(A)은 2 m의 30 %를 넘어 쓰지 않는다.
    for (let k = 0; k < g.nx * g.ny; k++) { rec[k * 4 + 2] = g.wet0[k] ? 1800 : -1; rec[k * 4 + 3] = g.wet0[k] ? 3000 : -1; }
    judge.update(0, rec);
    expect(judge.runupNear(coastLon, 0).arrival).toBe(1800);
    // 격자 밖은 0
    expect(judge.runupNear(coastLon + 5, 0).runup).toBe(0);
    const impacts = judge.cityImpacts([{ name: '해안도시', lon: coastLon, lat: 0, popK: 500 }, { name: '내륙도시', lon: coastLon + 5, lat: 0, popK: 900 }], 8);
    expect(impacts.map((c) => c.name)).toEqual(['해안도시']);
    expect(impacts[0].inland).toBeGreaterThan(1000);
    // 주기가 짧으면 침수 거리가 그만큼 묶인다
    const short = new FloodJudge([g], 100);
    short.update(0, rec);
    expect(short.cityImpacts([{ name: '해안도시', lon: coastLon, lat: 0, popK: 500 }], 8)[0].inland).toBeCloseTo(FRONT_K * Math.sqrt(9.81 * 2 * 100 ** 0.25) * 100, 3);
  });

  it('꼭짓점의 물 높이는 해안점에서 멀어질수록 줄고 전선 도달은 늦어지며, 한계 거리 밖은 없다', () => {
    // 경도 0도 선이 해안. 서쪽 바다, 동쪽 육지 2 m. 꼭짓점을 동서로 500 m 간격으로 둔다.
    const kmPerDeg = 111.195;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], hs: number[] = [];
    const cols = 40;
    for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) {
      const lon = (c - 4) * 0.5 / kmPerDeg, lat = r * 0.5 / kmPerDeg;
      const d = lonLatToDir(lon, lat);
      xs.push(d[0]); ys.push(d[1]); zs.push(d[2]);
      hs.push(c < 4 ? -50 : 2);
    }
    const leaves: number[] = [];
    for (let c = 0; c + 1 < cols; c++) { const a = c, b = c + 1, d2 = cols + c, e = cols + c + 1; leaves.push(a, b, d2, b, e, d2); }
    const judge = { runupNear: () => ({ runup: 10, arrival: 600, lon: -0.01, lat: 0.005 }), inlandLimit: (r: number) => inlandLimit(r), frontDelay, maxLimitKm: () => inlandLimit(10) / 1000, bigSources: () => ({ cellDeg: 0.1, items: [] }) };
    const { level: out, front, coastLon, coastLat, frac } = floodLevels(xs, ys, zs, Float32Array.from(hs), leaves, 0.5, judge)!; // 가장 작은 변 0.5 km
    expect(out).not.toBeNull();
    const X = inlandLimit(10); // 약 2.1 km
    expect(out[4]).toBeCloseTo(10, 2); // 해안점
    expect(out[6]).toBeCloseTo(10 * (1 - 1000 / X), 1); // 1 km 안쪽
    expect(out[3]).toBe(hs[3] - DRY_BELOW_M); // 바다 꼭짓점: 지반 아래
    expect(out[4 + Math.ceil(X / 500) + 2]).toBe(2 - DRY_BELOW_M); // 한계 밖: 지반 아래
    // 전선 도달 시각: 해안점은 도달 시각 그대로, 안쪽은 전선이 가는 시간만큼 늦다
    expect(front[4]).toBeCloseTo(600, 0);
    expect(front[6]).toBeCloseTo(600 + frontDelay(10, 1000), -1);
    expect(front[6]).toBeGreaterThan(front[5]);
    // 그리기용: 값을 준 해안 칸의 중심(rad)과 그 칸 수위에 곱할 비율. 한계 밖은 비율 0
    expect(coastLon[6]).toBeCloseTo(-0.01 * Math.PI / 180, 8);
    expect(coastLat[6]).toBeCloseTo(0.005 * Math.PI / 180, 8);
    expect(frac[4]).toBeCloseTo(1, 2);
    expect(frac[6]).toBeCloseTo(1 - 1000 / X, 2);
    expect(frac[4 + Math.ceil(X / 500) + 2]).toBe(0);
    // 큰 면에서는 판정하지 않는다
    expect(floodLevels(xs, ys, zs, Float32Array.from(hs), leaves, JUDGE_MAX_EDGE_KM + 1, judge)).toBeNull();
  });
});
