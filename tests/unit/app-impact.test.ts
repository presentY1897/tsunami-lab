import { describe, expect, it } from 'vitest';
import { buildImpactModel } from '../../app/src/sim/impact';
import { buildSourceModel } from '../../app/src/sim/source';
import { gainRefRadius } from '../../app/src/sim/global';
import type { ImpactParams } from '../../src/physics/impact';

const p: ImpactParams = { kind: 'impact', lon: 134, lat: 39.5, diameter: 500, velocity: 20, density: 3000, angle: 45 };
const ref = gainRefRadius(39.5); // 약 181 km

describe('소행성 충돌 발생원', () => {
  it('500 m 암석 소행성은 지름 약 10 km의 공동을 파고, 기준 거리의 목표 파고가 Ward & Asphaug 식과 같다', () => {
    const m = buildImpactModel(p, 3000, ref)!;
    expect(m.craterDiameter / 1000).toBeGreaterThan(9.5);
    expect(m.craterDiameter / 1000).toBeLessThan(11.5);
    expect(m.cavityDepth).toBeLessThanOrEqual(3000);
    expect(m.energyMt).toBeGreaterThan(1000);
    const Arw = Math.min(m.craterDiameter / 14.1, 3000);
    expect(m.targetAmp).toBeCloseTo((Arw * 0.75 * m.craterDiameter) / ref, 6);
  });

  it('셀 크기마다 공동을 따로 만든다: 거친 격자일수록 넓고 낮되 순부피는 0이고, 보정 배율은 유한하다', () => {
    const m = buildImpactModel(p, 3000, ref)!;
    const fine = m.cavityFor(7700), coarse = m.cavityFor(30000);
    expect(coarse.sigma).toBeGreaterThan(fine.sigma * 3);
    expect(fine.amplitude).toBeGreaterThan(0);
    expect(coarse.amplitude).toBeGreaterThan(0);
    expect(fine.amplitude).toBeLessThan(5000);
    for (const c of [fine, coarse]) {
      let sum = 0, abs = 0;
      const step = c.sigma / 111195 / 6;
      for (let lat = p.lat - 8 * step * 6; lat <= p.lat + 8 * step * 6; lat += step) {
        for (let dlon = -8 * step * 6; dlon <= 8 * step * 6; dlon += step) {
          const e = c.eta0(p.lon + dlon / Math.cos((p.lat * Math.PI) / 180), lat);
          sum += e; abs += Math.abs(e);
        }
      }
      expect(Math.abs(sum) / abs).toBeLessThan(0.03);
      expect(c.eta0(p.lon, p.lat)).toBeLessThan(0); // 가운데는 파인다
    }
    expect(m.cavityFor(7700)).toBe(fine); // 같은 셀 크기는 한 번만 계산한다
  });

  it('육지나 아주 얕은 곳에 떨어지면 쓰나미가 없다', () => {
    expect(buildImpactModel(p, 0, ref)).toBeNull();
    expect(buildSourceModel(p, 0.5, ref)).toBeNull();
  });

  it('발생원 모형: 소행성은 지반을 움직이지 않고 지진은 움직인다', () => {
    const im = buildSourceModel(p, 3000, ref)!;
    expect(im.fieldFor(7700).movesBed).toBe(false);
    expect(im.gainRef).toBe(ref);
    expect(im.refAmp).toBeGreaterThan(1);
    const q = buildSourceModel({ kind: 'quake', lon: 142.85, lat: 38.3, Mw: 9, strike: 193, dip: 14, rake: 90, topKm: 5, slipModel: 'tapered' }, 0, 0)!;
    expect(q.fieldFor(7700).movesBed).toBe(true);
    expect(q.gainRef).toBe(0);
  });
});
