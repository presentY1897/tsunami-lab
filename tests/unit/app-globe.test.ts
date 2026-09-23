import { describe, expect, it } from 'vitest';
import { assembleGrid, blockBytes, compand, encodeBlock, expand, stepAt, type BlockSpec, type EarthHeader } from '../../app/src/data/codec';
import { dirToLonLat, faceCount, icosphere, lonLatToDir } from '../../app/src/globe/icosphere';

describe('표고 코덱', () => {
  it('압신 양자화의 복원 오차가 간격의 절반을 넘지 않는다', () => {
    for (const z of [-10994, -4000.3, -50.2, -0.4, 0, 0.3, 12.7, 850, 8848]) {
      const back = expand(compand(z, 0.25, 20), 0.25, 20);
      expect(Math.abs(back - z)).toBeLessThanOrEqual((stepAt(z, 0.25, 20) / 2) * 1.01);
    }
  });

  it('블록을 되읽으면 원래 격자가 나오고, 줄여 담은 극지 블록은 가로로 늘어난다', () => {
    const size = 16;
    const blocks: BlockSpec[] = [
      { name: 'main', row0: 4, rows: 8, cols: 16, xstep: 1, step0: 0.25, s: 20 },
      { name: 'north', row0: 0, rows: 4, cols: 4, xstep: 4, step0: 1, s: 20 },
      { name: 'south', row0: 12, rows: 4, cols: 4, xstep: 4, step0: 1, s: 20 },
    ];
    const header: EarthHeader = { version: 1, zoom: 0, size, blocks, source: 'test' };
    const mainVals = new Float32Array(8 * 16).map((_, k) => Math.sin(k * 0.37) * 3000 - 1500);
    const capVals = new Float32Array(16).map((_, k) => 100 * k);
    const raw = new Uint8Array(blocks.reduce((a, b) => a + blockBytes(b), 0));
    raw.set(encodeBlock(mainVals, blocks[0]), 0);
    raw.set(encodeBlock(capVals, blocks[1]), blockBytes(blocks[0]));
    raw.set(encodeBlock(capVals, blocks[2]), blockBytes(blocks[0]) + blockBytes(blocks[1]));
    const grid = assembleGrid(header, raw);
    for (let k = 0; k < mainVals.length; k++) {
      expect(Math.abs(grid[4 * size + k] - mainVals[k])).toBeLessThanOrEqual((stepAt(mainVals[k], 0.25, 20) / 2) * 1.01);
    }
    // 저장된 셀 1의 중심은 원본 5.5번 열이다. 5번과 6번 열의 평균이 그 값(100 m)이어야 한다. 극지 블록의 양자화 오차는 수 m다.
    expect(Math.abs((grid[5] + grid[6]) / 2 - 100)).toBeLessThan(8);
    // 경도는 순환한다. 0번 열 쪽은 반대편 끝(셀 3, 300 m)과 이어져 보간된다.
    expect(grid[0]).toBeGreaterThan(100);
  });
});

describe('정이십면체 구', () => {
  it('면의 수가 맞고 모든 면이 바깥을 향한다', () => {
    const ico = icosphere(3);
    expect(ico.indices.length / 3).toBe(faceCount(3));
    expect(ico.positions.length / 3).toBe(10 * 4 ** 3 + 2);
    const P = ico.positions, I = ico.indices;
    for (let f = 0; f < I.length; f += 3) {
      const a = I[f] * 3, b = I[f + 1] * 3, c = I[f + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      expect(nx * (P[a] + P[b] + P[c]) + ny * (P[a + 1] + P[b + 1] + P[c + 1]) + nz * (P[a + 2] + P[b + 2] + P[c + 2])).toBeGreaterThan(0);
    }
  });

  it('경위도와 단위 벡터가 왕복 변환된다', () => {
    for (const [lon, lat] of [[127, 37.5], [-150, -20], [0, 0], [179.5, 80]]) {
      const [lo, la] = dirToLonLat(...lonLatToDir(lon, lat));
      expect(lo).toBeCloseTo(lon, 6);
      expect(la).toBeCloseTo(lat, 6);
    }
  });
});
