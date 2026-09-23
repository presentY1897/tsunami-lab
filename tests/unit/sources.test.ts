import { describe, expect, it } from 'vitest';
import { okadaUz } from '../../src/physics/okada';
import { buildQuakeField, faultFromMagnitude, subdivideFault, type QuakeParams } from '../../src/physics/quake';
import { buildImpactCavity, buildImpactField, transientCraterDiameter, type ImpactParams } from '../../src/physics/impact';

const DEG = Math.PI / 180;

describe('Okada (1985)', () => {
  // 논문의 점검표 Case 2: x=2, y=3, d=4, dip=70도, L=3, W=2, U=1
  it('주향이동 성분의 uz가 점검표 값과 같다', () => {
    expect(okadaUz(2, 3, 3, 2, 4, 70 * DEG, 1, 0)).toBeCloseTo(-2.747e-3, 5);
  });
  it('경사이동 성분의 uz가 점검표 값과 같다', () => {
    expect(okadaUz(2, 3, 3, 2, 4, 70 * DEG, 0, 1)).toBeCloseTo(-3.564e-2, 4);
  });
});

describe('지진 단층', () => {
  const tohoku: QuakeParams = {
    kind: 'quake', lon: 142.85, lat: 38.3, Mw: 9.0, strike: 193, dip: 14, rake: 90, topKm: 5, slipModel: 'uniform',
  };
  it('M9.0의 단층 크기와 평균 미끄러짐이 프로토타입 검증값과 맞는다', () => {
    const f = faultFromMagnitude(9.0, 14, 5);
    expect(f.L / 1000).toBeCloseTo(614, 0);
    expect(f.W / 1000).toBeCloseTo(189, 0);
    expect(f.meanSlip).toBeGreaterThan(8.3);
    expect(f.meanSlip).toBeLessThan(8.9);
  });
  it('크기를 고정하면 규모가 바뀌어도 윤곽은 같고 모멘트·미끄러짐·변위가 함께 증가한다', () => {
    const base = faultFromMagnitude(9, 14, 5);
    const dimensions = { lengthKm: base.L / 1000, widthKm: base.W / 1000 };
    const small = buildQuakeField({ ...tohoku, dimensions, slipModel: 'tapered' });
    const big = buildQuakeField({ ...tohoku, Mw: 10.5, dimensions, slipModel: 'tapered' });
    expect(big.outline).toEqual(small.outline);
    expect(big.reachKm).toBe(small.reachKm);
    const ratio = 10 ** (1.5 * (10.5 - 9));
    expect(big.fault.meanSlip / small.fault.meanSlip).toBeCloseTo(ratio, 8);
    expect(big.fault.M0 / small.fault.M0).toBeCloseTo(ratio, 8);
    expect(big.uz(143.8, 38.3) / small.uz(143.8, 38.3)).toBeCloseTo(ratio, 8);
    const mean = big.subfaults.reduce((sum, f) => sum + f.slip, 0) / big.subfaults.length;
    expect(mean).toBeCloseTo(big.fault.meanSlip, 6);
  });
  it('균일 슬립의 최대 융기가 3.5~5 m 범위다', () => {
    const q = buildQuakeField(tohoku);
    let maxU = -Infinity, minU = Infinity;
    for (let lat = 34; lat <= 42; lat += 0.05) {
      for (let lon = 139; lon <= 146; lon += 0.05) {
        const u = q.uz(lon, lat);
        if (u > maxU) maxU = u;
        if (u < minU) minU = u;
      }
    }
    expect(maxU).toBeGreaterThan(3.5);
    expect(maxU).toBeLessThan(5);
    expect(minU).toBeLessThan(-0.5);
  });
  it('불균일 슬립은 모멘트를 보존하고 최대 미끄러짐이 평균의 1.6배 이상이다', () => {
    const f = faultFromMagnitude(9.0, 14, 5);
    const subs = subdivideFault(f, 'tapered');
    const mean = subs.reduce((a, s) => a + s.slip, 0) / subs.length;
    expect(mean).toBeCloseTo(f.meanSlip, 6);
    expect(f.peakSlip / f.meanSlip).toBeGreaterThan(1.6);
  });
  it('융기는 해구 쪽(단층 윗변 쪽)에서 일어난다', () => {
    const q = buildQuakeField({ ...tohoku, slipModel: 'tapered' });
    // 주향 193도면 경사 방향은 283도(서북서). 해구는 동쪽이다.
    expect(q.uz(143.8, 38.3)).toBeGreaterThan(1);
    expect(q.uz(141.6, 38.3)).toBeLessThan(0);
  });
});

describe('소행성 충돌', () => {
  const p: ImpactParams = { kind: 'impact', lon: 134, lat: 39.5, diameter: 500, velocity: 20, density: 3000, angle: 45 };
  it('500 m 암석 소행성의 수중 크레이터 지름은 약 10.5 km다', () => {
    expect(transientCraterDiameter(p) / 1000).toBeGreaterThan(9.5);
    expect(transientCraterDiameter(p) / 1000).toBeLessThan(11.5);
  });
  it('공동은 순부피가 0에 가깝고 보정 배율이 유한하다', () => {
    const cav = buildImpactCavity(p, 3000, 2000)!;
    expect(cav.gainC).toBeGreaterThan(0.05);
    expect(cav.gainC).toBeLessThan(20);
    const f = buildImpactField(p, cav);
    let sum = 0, absSum = 0;
    const step = 0.005;
    for (let lat = 38.5; lat <= 40.5; lat += step) {
      for (let lon = 133; lon <= 135; lon += step) {
        const e = f.eta0(lon, lat);
        sum += e;
        absSum += Math.abs(e);
      }
    }
    expect(Math.abs(sum) / absSum).toBeLessThan(0.02);
    expect(f.eta0(134, 39.5)).toBeLessThan(-100);
  });
  it('육지에 떨어지면 쓰나미가 없다', () => {
    expect(buildImpactCavity(p, 0, 2000)).toBeNull();
  });
});
