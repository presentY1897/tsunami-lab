import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeChunk, type Gunzip } from '../../app/src/data/chunks';
import { assembleGrid, splitFile } from '../../app/src/data/codec';
import { makeEarthGrid, type EarthGrid } from '../../app/src/data/earth';
import { GLOBAL_FILE, chunkFile } from '../../app/src/data/layout';
import { buildGlobalGrid, buildLevelGrid, GLOBAL_ROW0, GLOBAL_ROWS, planSourceGrid, SOURCE_SIZE } from '../../app/src/sim/global';
import { COAST_SIZE, COAST_ZOOM, PARENT_MARGIN, planCoastChain, planGlobal, type LevelSpec } from '../../app/src/sim/plan';
import { Terrain } from '../../app/src/terrain/terrain';
import { latToPy, lonToPx } from '../../src/geo/mercator';
import type { QuakeParams } from '../../src/physics/quake';
import { buildSourceModel } from '../../app/src/sim/source';

const gunzip: Gunzip = async (b) => new Uint8Array(gunzipSync(b));
const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../app/public/${rel}`, import.meta.url)));
const tohoku: QuakeParams = { kind: 'quake', lon: 142.85, lat: 38.3, Mw: 9.0, strike: 193, dip: 14, rake: 90, topKm: 5, slipModel: 'tapered' };

let earth: EarthGrid;
const loaded = new Map<string, Float32Array>();
const chunkSource = { peek: (x: number, y: number) => loaded.get(`${x}_${y}`) ?? null };

beforeAll(async () => {
  const g = splitFile(read(GLOBAL_FILE));
  earth = makeEarthGrid(g.header.zoom, g.header.size, assembleGrid(g.header, new Uint8Array(gunzipSync(g.payload))));
  const specs = [planSourceGrid(tohoku), ...planCoastChain([planGlobal(GLOBAL_ROW0, GLOBAL_ROWS), planSourceGrid(tohoku)], 140.97, 38.17)];
  for (const sp of specs) for (const [x, y] of sp.chunks) if (!loaded.has(`${x}_${y}`)) loaded.set(`${x}_${y}`, await decodeChunk(read(chunkFile(x, y)), gunzip));
});

/** 자식 사각형이 부모 안쪽에 여유를 두고 들어가고 부모 셀 경계에 맞는지. */
function expectNested(parent: LevelSpec, child: LevelSpec): void {
  const s = 2 ** (child.zoom - parent.zoom), world = 256 * 2 ** child.zoom;
  expect(child.px0 % s).toBe(0);
  expect(child.py0 % s).toBe(0);
  expect(child.py0).toBeGreaterThanOrEqual((parent.py0 + PARENT_MARGIN) * s);
  expect(child.py0 + child.ny).toBeLessThanOrEqual((parent.py0 + parent.ny - PARENT_MARGIN) * s);
  if (parent.role !== 'global') {
    let rel = ((child.px0 - parent.px0 * s) % world + world) % world;
    if (rel > world / 2) rel -= world;
    expect(rel).toBeGreaterThanOrEqual(PARENT_MARGIN * s);
    expect(rel + child.nx).toBeLessThanOrEqual((parent.nx - PARENT_MARGIN) * s);
  }
}

describe('해안 격자 사슬', () => {
  const global = planGlobal(GLOBAL_ROW0, GLOBAL_ROWS);
  it('발생원 격자 안의 해안은 발생원 격자에 붙고, 줌 차이 3 이하로 480 m까지 내려간다', () => {
    const source = planSourceGrid(tohoku);
    const chain = planCoastChain([global, source], 140.97, 38.17); // 센다이 평야
    expect(chain.map((c) => c.role)).toEqual(['bridge', 'coast']);
    expect(chain[0].parent).toBe(1);
    expect(chain[1].parent).toBe(2);
    expect(chain[1].zoom).toBe(COAST_ZOOM);
    expect(chain[1].nx).toBe(COAST_SIZE);
    expectNested(source, chain[0]);
    expectNested(chain[0], chain[1]);
    for (const c of chain) {
      expect(c.zoom - [global, source, ...chain][c.parent].zoom).toBeLessThanOrEqual(3);
      expect(c.chunks.length).toBeLessThanOrEqual(4);
      expect(c.west).toBeLessThan(140.97); expect(c.east).toBeGreaterThan(140.97);
      expect(c.south).toBeLessThan(38.17); expect(c.north).toBeGreaterThan(38.17);
    }
  });
  it('발생원에서 먼 해안은 전 지구 격자에 바로 붙는다', () => {
    const source = planSourceGrid(tohoku);
    const chain = planCoastChain([global, source], -155.1, 19.7); // 하와이 힐로
    expect(chain[0].parent).toBe(0);
    expect(chain.map((c) => c.zoom)).toEqual([5, 8]);
    expectNested(global, chain[0]);
    expectNested(chain[0], chain[1]);
  });
});

describe('발생원 주변 세밀 격자', () => {
  it('부모 셀 경계에 맞춰 부모 안쪽에 놓이고, 발생원을 품으며, 조각 4개면 된다', () => {
    const s = planSourceGrid(tohoku);
    expectNested(planGlobal(GLOBAL_ROW0, GLOBAL_ROWS), s);
    expect(s.west).toBeLessThan(tohoku.lon);
    expect(s.east).toBeGreaterThan(tohoku.lon);
    expect(s.south).toBeLessThan(tohoku.lat);
    expect(s.north).toBeGreaterThan(tohoku.lat);
    expect(s.chunks.length).toBeLessThanOrEqual(4);
    // 발생원이 격자 가운데 근처에 있다
    expect(Math.abs(lonToPx(tohoku.lon, s.zoom) - s.px0 - SOURCE_SIZE / 2)).toBeLessThan(8);
    expect(Math.abs(latToPy(tohoku.lat, s.zoom) - s.py0 - SOURCE_SIZE / 2)).toBeLessThan(8);
  });

  it('날짜변경선에 걸친 발생원은 경도 범위가 감기고 조각도 양쪽에서 온다', () => {
    const s = planSourceGrid({ ...tohoku, lon: 179.7, lat: -20 });
    expect(s.west).toBeGreaterThan(s.east);
    const xs = s.chunks.map(([x]) => x);
    expect(xs).toContain(15);
    expect(xs).toContain(0);
  });

  it('지반은 지형 함수의 보간값이고, 해저 변위가 전 지구 격자보다 크게 살아 있다', () => {
    const spec = planSourceGrid(tohoku);
    const terrain = new Terrain(earth, chunkSource);
    const fine = buildLevelGrid(terrain, spec, buildSourceModel(tohoku, 0, 0)!);
    const { nx, ny, bed, wet0, eta0 } = fine.input;
    expect([nx, ny]).toEqual([SOURCE_SIZE, SOURCE_SIZE]);
    const cell = (lon: number, lat: number): number => (Math.floor(latToPy(lat, spec.zoom)) - spec.py0) * nx + (Math.floor(lonToPx(lon, spec.zoom)) - spec.px0);
    expect(bed[cell(144.0, 38.0)]).toBeLessThan(-6000); // 일본 해구
    expect(wet0[cell(144.0, 38.0)]).toBe(1);
    expect(bed[cell(140.0, 38.5)]).toBeGreaterThanOrEqual(5); // 일본 본토
    expect(wet0[cell(140.0, 38.5)]).toBe(0);
    expect(bed[cell(135.0, 41.0)]).toBeLessThan(-2000); // 동해 일본분지
    // 세밀 격자(8 km)에서는 융기가 3.5 m 넘게 남는다. 39 km 격자에서는 2.5 m 안팎이다.
    const coarse = buildGlobalGrid(earth, buildSourceModel(tohoku, 0, 0)!).source.maxUp;
    expect(fine.maxUp).toBeGreaterThan(3.5);
    expect(fine.maxUp).toBeGreaterThan(coarse);
    expect(eta0[cell(143.8, 38.3)]).toBeGreaterThan(1);
    expect(eta0[cell(141.8, 38.3)]).toBeLessThan(0);
    // 마른 셀의 수위는 지반과 같고, 발생원에서 먼 바다는 잔잔하다
    expect(eta0[cell(140.0, 38.5)]).toBe(bed[cell(140.0, 38.5)]);
    expect(eta0[cell(135.0, 39.5)]).toBe(0);
  });

  it('해안 격자는 물이 올라갈 수 있게 육지를 낮게 두고, 생성한 세부가 들어 있다', () => {
    const terrain = new Terrain(earth, chunkSource);
    const source = planSourceGrid(tohoku);
    const chain = planCoastChain([planGlobal(GLOBAL_ROW0, GLOBAL_ROWS), source], 140.97, 38.17);
    const coast = buildLevelGrid(terrain, chain[1], buildSourceModel(tohoku, 0, 0)!).input;
    const { nx, ny, bed, wet0 } = coast;
    // 지진의 변위를 더하기 전의 지반: 바다는 2 m보다 깊고 육지는 0.2 m보다 높다
    const coastDefault = buildLevelGrid(terrain, chain[1], buildSourceModel({ ...tohoku, lon: 100, lat: 0 }, 0, 0)!).input; // 먼 곳의 지진: 변위 없음
    let land = 0, low = 0, sea = 0;
    for (let k = 0; k < nx * ny; k++) {
      if (wet0[k]) { sea++; expect(coastDefault.bed[k]).toBeLessThanOrEqual(-2); }
      else { land++; expect(coastDefault.bed[k]).toBeGreaterThanOrEqual(0.2); if (coastDefault.bed[k] < 5) low++; }
    }
    expect(sea / (nx * ny)).toBeGreaterThan(0.2);
    expect(land / (nx * ny)).toBeGreaterThan(0.2);
    expect(low).toBeGreaterThan(100); // 센다이 평야의 낮은 땅
    // 같은 자리의 보간값과 다르다: 생성한 세부가 들어갔다
    const bridge = buildLevelGrid(terrain, chain[0], buildSourceModel(tohoku, 0, 0)!).input;
    let diff = 0;
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
      const k = (j * 4 + 2) * nx + i * 4 + 2;
      if (wet0[k]) continue;
      const [ci, cj] = [Math.floor((chain[1].px0 + i * 4 + 2) / 4) - chain[0].px0, Math.floor((chain[1].py0 + j * 4 + 2) / 4) - chain[0].py0];
      const bb = bridge.bed[cj * bridge.nx + ci];
      if (bb >= 5 && Math.abs(bed[k] - bb) > 1) diff++;
    }
    expect(diff).toBeGreaterThan(20);
    // 센다이 해안은 단층의 침강 쪽이다. 바다는 수위가 내려가고 육지는 지반이 가라앉은 채 시작한다.
    let seaDown = 0, landDown = 0;
    for (let k = 0; k < nx * ny; k++) {
      if (wet0[k] && coast.eta0[k] < -0.1) seaDown++;
      if (!wet0[k] && coast.bed[k] < coastDefault.bed[k] - 0.1) landDown++;
    }
    expect(seaDown).toBeGreaterThan(100);
    expect(landDown).toBeGreaterThan(100);
  });
});
