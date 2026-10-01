// GPU 셰이더가 CPU 기준 구현과 같은 답을 내는지 브라우저에서 확인한다. Playwright 테스트가 이 페이지를 연다.
import * as THREE from 'three';
import { GpuSolver, type LevelInput } from '../src/gpu/solver';
import { createState, stepSwe, uniformGrid } from '../app/src/physics/swe-cpu';
import type { GridSpec } from '../src/geo/grid';
import { floodFillSea } from '../src/geo/dem';

declare global {
  interface Window { __gpuCheck?: Promise<unknown> }
}

const renderer = new THREE.WebGLRenderer({ antialias: false });

async function singleLevel() {
  const nx = 96, ny = 64, cell = 50;
  const bed = new Float32Array(nx * ny);
  const eta0 = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    // 오른쪽으로 갈수록 얕아지는 해변 + 가운데 섬
    bed[k] = -20 + Math.max(0, i - 50) * 0.7 + 25 * Math.exp(-((i - 35) ** 2 + (j - 30) ** 2) / 30);
    eta0[k] = 2.5 * Math.exp(-((i - 15) ** 2 + (j - 32) ** 2) / 60);
  }
  const wet0 = floodFillSea(nx, ny, (k) => bed[k] < 0, (k) => bed[k] < -5);
  const grid: GridSpec = { z: 10, px0: 0, py0: 0, nx, ny };
  for (let k = 0; k < eta0.length; k++) eta0[k] = wet0[k] ? eta0[k] : bed[k];
  const input: LevelInput = { grid, bed, eta0, wet0, maxDepth: 20, uniformCell: cell };
  const solver = new GpuSolver(renderer, [input], { manningSea: 0.025, manningLand: 0.025, dryEps: [0.01], lazyActivation: false });
  const dt = solver.levels[0].dt;

  const g = uniformGrid(nx, ny, cell, bed, 0.025);
  const s = createState(g, eta0);
  const steps = 400;
  for (let n = 0; n < steps; n++) stepSwe(g, s, dt, { dryEps: 0.01, maxFroude: 2.5 });
  solver.advance(Infinity, dt * (steps - 0.5));
  const out = await solver.readState(0);
  let maxDiff = 0, sumSq = 0, maxEta = 0, floodedLand = 0;
  for (let k = 0; k < nx * ny; k++) {
    const d = Math.abs(out[k * 4] - s.eta[k]);
    maxDiff = Math.max(maxDiff, d, Math.abs(out[k * 4 + 1] - s.u[k]), Math.abs(out[k * 4 + 2] - s.v[k]));
    sumSq += d * d;
    if (wet0[k]) maxEta = Math.max(maxEta, Math.abs(s.eta[k]));
    if (!wet0[k] && s.eta[k] - bed[k] > 0.02) floodedLand++;
  }
  const res = { steps: solver.levels[0].steps, dt, maxDiff, rms: Math.sqrt(sumSq / (nx * ny)), maxEta, floodedLand };
  solver.dispose();
  return res;
}

async function nested() {
  // 수심 4000 m의 평평한 바다. 부모(z6) 안에 자식(z9)을 두고, 혹이 퍼져 자식 영역을 지나가게 한다.
  const parent: GridSpec = { z: 6, px0: 14000, py0: 6200, nx: 256, ny: 256 };
  const child: GridSpec = { z: 9, px0: (14000 + 150) * 8, py0: (6200 + 110) * 8, nx: 256, ny: 256 };
  const mk = (g: GridSpec, hump: (i: number, j: number) => number): LevelInput => {
    const n = g.nx * g.ny;
    const bed = new Float32Array(n).fill(-4000);
    const eta0 = new Float32Array(n);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) eta0[j * g.nx + i] = hump(i, j);
    return { grid: g, bed, eta0, wet0: new Uint8Array(n).fill(1), maxDepth: 4000 };
  };
  const pIn = mk(parent, (i, j) => 1.0 * Math.exp(-((i - 90) ** 2 + (j - 128) ** 2) / (2 * 8 * 8)));
  const cIn = mk(child, () => 0);
  const solver = new GpuSolver(renderer, [pIn, cIn], { lazyActivation: true });
  const c = Math.sqrt(9.81 * 4000);
  // 혹의 중심에서 자식 중심(부모 셀 166, 126)까지 약 76 부모 셀
  const cellM = (40075016.686 / (256 * 64)) * 0.78;
  const tEnd = (76 * cellM) / c;
  let guard = 0;
  while (solver.time < tEnd && guard++ < 200000) {
    solver.advance(2, tEnd);
    await new Promise((r) => setTimeout(r, 0)); // 비동기 읽기 결과가 돌아올 틈을 준다
  }
  const ps = await solver.readState(0);
  const cs = await solver.readState(1);
  let maxChild = 0, finite = true, maxAbsDiff = 0, maxParentInRect = 0;
  for (let j = 24; j < 232; j += 8) for (let i = 24; i < 232; i += 8) {
    const ce = cs[(j * 256 + i) * 4];
    if (!Number.isFinite(ce)) finite = false;
    maxChild = Math.max(maxChild, Math.abs(ce));
    const pi = 150 + Math.floor(i / 8), pj = 110 + Math.floor(j / 8);
    const pe = ps[(pj * 256 + pi) * 4];
    maxParentInRect = Math.max(maxParentInRect, Math.abs(pe));
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(ce - pe));
  }
  const res = {
    t: solver.time, tEnd, ratio: solver.levels[1].ratio, childSteps: solver.levels[1].steps, childActive: solver.levels[1].active,
    finite, maxChild, maxParentInRect, maxAbsDiff,
  };
  solver.dispose();
  return res;
}

window.__gpuCheck = (async () => {
  const result = { single: await singleLevel(), nested: await nested() };
  document.getElementById('out')!.textContent = JSON.stringify(result, null, 2);
  return result;
})();
