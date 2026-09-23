import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assembleGrid, splitFile } from '../../app/src/data/codec';
import { makeEarthGrid } from '../../app/src/data/earth';
import { GLOBAL_FILE } from '../../app/src/data/layout';
import { autoStrike, buildGlobalGrid } from '../../app/src/sim/global';
import { Terrain } from '../../app/src/terrain/terrain';
import type { QuakeParams } from '../../src/physics/quake';
import { buildSourceModel } from '../../app/src/sim/source';

const file = splitFile(new Uint8Array(readFileSync(new URL(`../../app/public/${GLOBAL_FILE}`, import.meta.url))));
const earth = makeEarthGrid(file.header.zoom, file.header.size, assembleGrid(file.header, new Uint8Array(gunzipSync(file.payload))));
const tohoku: QuakeParams = { kind: 'quake', lon: 142.85, lat: 38.3, Mw: 9.0, strike: 193, dip: 14, rake: 90, topKm: 5, slipModel: 'tapered' };

describe('전 지구 계산 격자와 지진 발생원', () => {
  it('격자가 경도 전체와 북극권 사이를 덮고, 바다와 육지가 갈린다', () => {
    const { grid } = buildGlobalGrid(earth, buildSourceModel(tohoku, 0, 0)!);
    const { nx, ny, wet0, bed } = grid.input;
    expect([nx, ny]).toEqual([1024, 504]);
    expect(grid.latOf(0)).toBeGreaterThan(65.5);
    expect(grid.latOf(ny - 1)).toBeLessThan(-65.5);
    let wet = 0;
    for (let k = 0; k < wet0.length; k++) { wet += wet0[k]; expect(wet0[k] ? bed[k] <= -10 : bed[k] >= 30).toBe(true); }
    expect(wet / wet0.length).toBeGreaterThan(0.6);
    // 알려진 곳
    const at = (lon: number, lat: number): number => { const [i, j] = grid.cellOf(lon, lat); return bed[j * nx + i]; };
    expect(at(144.5, 38)).toBeLessThan(-5000); // 일본 해구
    expect(at(-155.5, 19.6)).toBeGreaterThan(0); // 하와이섬
    expect(at(-150, 30)).toBeLessThan(-4000); // 북태평양
  });

  it('규모 9.0의 해저 변위가 39 km 격자에서도 살아 있다', () => {
    const { grid, source } = buildGlobalGrid(earth, buildSourceModel(tohoku, 0, 0)!);
    expect(source.lengthKm).toBeCloseTo(614, 0);
    expect(source.widthKm).toBeCloseTo(189, 0);
    // 세밀한 격자에서는 최대 융기가 약 5 m다. 39 km 셀 평균으로도 절반 넘게 남아야 한다.
    expect(source.maxUp).toBeGreaterThan(2.5);
    expect(source.maxUp).toBeLessThan(6);
    expect(source.maxDown).toBeLessThan(-0.3);
    // 융기는 해구 쪽(동쪽), 침강은 육지 쪽(서쪽)
    const { nx, eta0, wet0 } = grid.input;
    const at = (lon: number, lat: number): number => { const [i, j] = grid.cellOf(lon, lat); return wet0[j * nx + i] ? eta0[j * nx + i] : NaN; };
    expect(at(143.8, 38.3)).toBeGreaterThan(1);
    expect(at(141.8, 38.3)).toBeLessThan(0);
    // 멀리 떨어진 바다는 잔잔하다
    expect(at(-150, 30)).toBe(0);
  });

  it('날짜변경선에 걸친 발생원도 양쪽에 나뉘어 들어간다', () => {
    const { grid } = buildGlobalGrid(earth, buildSourceModel({ ...tohoku, lon: 179.5, lat: -20, strike: 0 }, 0, 0)!);
    const { nx, eta0, wet0 } = grid.input;
    let east = 0, west = 0;
    for (let j = 0; j < grid.input.ny; j++) {
      for (let i = 0; i < 20; i++) if (wet0[j * nx + i] && Math.abs(eta0[j * nx + i]) > 0.1) west++;
      for (let i = nx - 20; i < nx; i++) if (wet0[j * nx + i] && Math.abs(eta0[j * nx + i]) > 0.1) east++;
    }
    expect(east).toBeGreaterThan(5);
    expect(west).toBeGreaterThan(5);
  });

  it('일본 해구에서는 단층 방향을 해구를 따라 잡는다', () => {
    const terrain = new Terrain(earth, { peek: () => null });
    const s = autoStrike(terrain, 143.5, 38.3);
    // 실제 도호쿠 지진의 주향은 193도다
    expect(s).toBeGreaterThan(160);
    expect(s).toBeLessThan(225);
  });
});
