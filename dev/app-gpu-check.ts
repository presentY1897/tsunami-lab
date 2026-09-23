// 실제 앱(app/)의 GPU 계산부가 CPU 기준 구현과 같은 답을 내는지, 순환 경계가 맞는지 확인한다. Playwright 테스트가 이 페이지를 연다.
import { NestedSolver } from '../app/src/sim/nested';
import { SweSolver, type GridInput } from '../app/src/sim/solver';
import { createState, stepSwe, uniformGrid } from '../src/physics/swe-cpu';

const gl = document.createElement('canvas').getContext('webgl2')!;
const base = { zoom: 2, px0: 0, py0: 0, world: 1024, eqCell: 1 };

function againstCpu() {
  const nx = 96, ny = 64, cell = 50;
  const bed = new Float32Array(nx * ny), eta0 = new Float32Array(nx * ny), wet0 = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    // 오른쪽으로 갈수록 얕아지는 해변 + 가운데 섬
    bed[k] = -20 + Math.max(0, i - 50) * 0.7 + 25 * Math.exp(-((i - 35) ** 2 + (j - 30) ** 2) / 30);
    wet0[k] = bed[k] < 0 ? 1 : 0;
    eta0[k] = wet0[k] ? 2.5 * Math.exp(-((i - 15) ** 2 + (j - 32) ** 2) / 60) : bed[k];
  }
  const grid: GridInput = { ...base, nx, ny, bed, eta0, wet0, uniformCell: cell, wrapX: false, sponge: false };
  const solver = new SweSolver(gl, grid, { manningSea: 0.025, manningLand: 0.025, dryEps: 0.01 });
  const g = uniformGrid(nx, ny, cell, bed, 0.025);
  const s = createState(g, eta0);
  const steps = 400;
  for (let n = 0; n < steps; n++) stepSwe(g, s, solver.dt, { dryEps: 0.01, maxFroude: 2.5 });
  solver.step(steps);
  const out = solver.readState();
  let maxDiff = 0, floodedLand = 0, maxEta = 0;
  for (let k = 0; k < nx * ny; k++) {
    maxDiff = Math.max(maxDiff, Math.abs(out[k * 4] - s.eta[k]), Math.abs(out[k * 4 + 1] - s.u[k]), Math.abs(out[k * 4 + 2] - s.v[k]));
    if (!wet0[k] && s.eta[k] - bed[k] > 0.02) floodedLand++;
    if (wet0[k]) maxEta = Math.max(maxEta, Math.abs(s.eta[k]));
  }
  const rec = solver.readRecord();
  let arrived = 0;
  for (let k = 0; k < nx * ny; k++) if (rec[k * 4 + 1] >= 0) arrived++;
  solver.dispose();
  return { steps: solver.steps, dt: solver.dt, maxDiff, floodedLand, maxEta, arrived };
}

function periodic() {
  // 평평한 바다. 혹을 격자의 이음매(0번 열)에 둔 것과 한가운데에 둔 것은, 가로로 절반 밀면 같은 결과여야 한다.
  const nx = 128, ny = 48, cell = 2000;
  const run = (center: number, wrapX: boolean): Float32Array => {
    const bed = new Float32Array(nx * ny).fill(-3000), eta0 = new Float32Array(nx * ny), wet0 = new Uint8Array(nx * ny).fill(1);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let d = Math.abs(i - center);
      d = Math.min(d, nx - d);
      eta0[j * nx + i] = Math.exp(-(d * d + (j - 24) ** 2) / 18);
    }
    const solver = new SweSolver(gl, { ...base, nx, ny, bed, eta0, wet0, uniformCell: cell, wrapX, sponge: false });
    solver.step(150);
    const out = solver.readState();
    solver.dispose();
    return out;
  };
  const seam = run(0, true), middle = run(nx / 2, true), walled = run(0, false);
  let maxDiff = 0, maxEta = 0, crossed = 0, walledDiff = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = seam[(j * nx + i) * 4], b = middle[(j * nx + ((i + nx / 2) % nx)) * 4];
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
    maxEta = Math.max(maxEta, Math.abs(a));
    walledDiff = Math.max(walledDiff, Math.abs(walled[(j * nx + i) * 4] - a));
  }
  // 이음매 양쪽으로 파가 퍼졌는지: 왼쪽 끝과 오른쪽 끝 모두에 파가 있어야 한다
  for (let i = 0; i < 40; i++) if (Math.abs(seam[(24 * nx + i) * 4]) > 0.01 && Math.abs(seam[(24 * nx + nx - 1 - i) * 4]) > 0.01) crossed++;
  return { maxDiff, maxEta, crossed, walledDiff };
}

function nested() {
  // 수심 4000 m의 평평한 바다. 부모(줌 6) 안에 자식(줌 9)을 두고, 혹이 퍼져 자식 영역을 지나가게 한다.
  const mk = (zoom: number, px0: number, py0: number, n: number, cell: number, hump: (i: number, j: number) => number): GridInput => {
    const bed = new Float32Array(n * n).fill(-4000), eta0 = new Float32Array(n * n), wet0 = new Uint8Array(n * n).fill(1);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) eta0[j * n + i] = hump(i, j);
    return { nx: n, ny: n, bed, eta0, wet0, zoom, px0, py0, world: 256 * 2 ** zoom, eqCell: 1, uniformCell: cell, wrapX: false, sponge: false };
  };
  const cellM = (40075016.686 / (256 * 64)) * 0.78;
  const parentIn = mk(6, 14000, 6200, 256, cellM, (i, j) => Math.exp(-((i - 90) ** 2 + (j - 128) ** 2) / (2 * 8 * 8)));
  const childIn = mk(9, (14000 + 150) * 8, (6200 + 110) * 8, 256, cellM / 8, () => 0);
  const solver = new NestedSolver(gl, [{ grid: parentIn, parent: -1 }, { grid: childIn, parent: 0 }]);
  const c = Math.sqrt(9.81 * 4000);
  // 혹의 중심에서 자식 중심(부모 셀 166, 126)까지 약 76 부모 셀
  const tEnd = (76 * cellM) / c;
  let guard = 0;
  while (solver.levels[0].t < tEnd && guard++ < 100000) solver.step(1);
  const ps = solver.levels[0].readState(), cs = solver.levels[1].readState();
  let maxChild = 0, finite = true, maxAbsDiff = 0, maxParentInRect = 0;
  for (let j = 24; j < 232; j += 8) for (let i = 24; i < 232; i += 8) {
    const ce = cs[(j * 256 + i) * 4];
    if (!Number.isFinite(ce)) finite = false;
    maxChild = Math.max(maxChild, Math.abs(ce));
    const pe = ps[((110 + Math.floor(j / 8)) * 256 + 150 + Math.floor(i / 8)) * 4];
    maxParentInRect = Math.max(maxParentInRect, Math.abs(pe));
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(ce - pe));
  }
  const res = { t: solver.levels[0].t, tEnd, ratio: solver.ratios[1], childSteps: solver.levels[1].steps, childActive: solver.levels[1].active, finite, maxChild, maxParentInRect, maxAbsDiff };
  solver.dispose();
  return res;
}

declare global { interface Window { __check?: unknown } }
try {
  const result = { cpu: againstCpu(), periodic: periodic(), nested: nested() };
  document.getElementById('out')!.textContent = JSON.stringify(result, null, 2);
  window.__check = result;
} catch (e) {
  window.__check = { error: String(e) };
  document.getElementById('out')!.textContent = String(e);
}
