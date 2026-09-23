import { describe, expect, it } from 'vitest';
import { planLevels, QUALITIES } from '../../src/geo/domain';
import { childRectInParent, gridBounds } from '../../src/geo/grid';
import { sourceExtent } from '../../src/physics/source';

describe('격자 계획', () => {
  const tohoku = { kind: 'quake', lon: 142.85, lat: 38.3, Mw: 9.0, strike: 193, dip: 14, rake: 90, topKm: 5, slipModel: 'tapered' } as const;
  for (const name of ['low', 'medium', 'high'] as const) {
    it(`${name}: 자식이 부모 안에 여유를 두고 정렬된다`, () => {
      const levels = planLevels({ sourceBox: sourceExtent(tohoku), target: { lon: 140.95, lat: 38.14 }, quality: QUALITIES[name] });
      expect(levels.length).toBeGreaterThanOrEqual(2);
      const b = gridBounds(levels[0]);
      expect(b.west).toBeLessThan(138);
      expect(b.east).toBeGreaterThan(146);
      for (let i = 1; i < levels.length; i++) {
        const p = levels[i - 1], c = levels[i];
        expect(c.z - p.z).toBeLessThanOrEqual(3);
        const [i0, j0, i1, j1] = childRectInParent(p, c);
        for (const v of [i0, j0, i1, j1]) expect(Number.isInteger(v)).toBe(true);
        expect(i0).toBeGreaterThanOrEqual(28);
        expect(j0).toBeGreaterThanOrEqual(28);
        expect(i1).toBeLessThanOrEqual(p.nx - 28);
        expect(j1).toBeLessThanOrEqual(p.ny - 28);
      }
      const fine = gridBounds(levels[levels.length - 1]);
      expect(fine.west).toBeLessThan(140.95);
      expect(fine.east).toBeGreaterThan(140.95);
      expect(fine.south).toBeLessThan(38.14);
      expect(fine.north).toBeGreaterThan(38.14);
    });
  }
  it('태평양을 건너는 경우에도 단계 사이 줌 차이가 3 이하다', () => {
    const chile = { kind: 'quake', lon: -73.5, lat: -38, Mw: 9.5, strike: 10, dip: 15, rake: 90, topKm: 5, slipModel: 'tapered' } as const;
    const levels = planLevels({ sourceBox: sourceExtent(chile), target: { lon: 141.0, lat: 38.2 }, quality: QUALITIES.medium });
    for (let i = 1; i < levels.length; i++) expect(levels[i].z - levels[i - 1].z).toBeLessThanOrEqual(3);
    expect(levels[0].nx).toBeLessThanOrEqual(1032);
  });
});
