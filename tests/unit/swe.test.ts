import { describe, expect, it } from 'vitest';
import { createState, stableDt, stepSwe, totalVolume, uniformGrid } from '../../app/src/physics/swe-cpu';

const G = 9.81;

describe('천수방정식 기준 구현', () => {
  it('정지한 호수는 복잡한 지형과 마른 땅이 있어도 정지 상태를 유지한다', () => {
    const nx = 40, ny = 30;
    const bed = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      bed[j * nx + i] = -50 + 70 * Math.exp(-((i - 20) ** 2 + (j - 15) ** 2) / 40) + 3 * Math.sin(i * 0.7) * Math.cos(j * 0.5);
    }
    const g = uniformGrid(nx, ny, 100, bed);
    const s = createState(g);
    const dt = stableDt(g, 60);
    for (let n = 0; n < 200; n++) stepSwe(g, s, dt);
    let maxU = 0, maxE = 0;
    for (let k = 0; k < nx * ny; k++) {
      maxU = Math.max(maxU, Math.abs(s.u[k]), Math.abs(s.v[k]));
      if (bed[k] < 0) maxE = Math.max(maxE, Math.abs(s.eta[k]));
    }
    expect(maxU).toBeLessThan(1e-9);
    expect(maxE).toBeLessThan(1e-9);
  });

  it('작은 파는 sqrt(g h) 속도로 전파하고 진폭이 유지된다', () => {
    const nx = 800, ny = 3, h = 4000, cell = 2000;
    const bed = new Float32Array(nx * ny).fill(-h);
    const g = uniformGrid(nx, ny, cell, bed, 0);
    const eta0 = new Float32Array(nx * ny);
    const c = Math.sqrt(G * h);
    const x0 = 200, sig = 15;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) eta0[j * nx + i] = Math.exp(-((i - x0) ** 2) / (2 * sig * sig));
    const s = createState(g, eta0);
    // 오른쪽으로만 가는 파: u = eta * sqrt(g/h). u는 동쪽 면(i + 1/2)에 있다.
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      s.u[j * nx + i] = Math.sqrt(G / h) * Math.exp(-((i + 0.5 - x0) ** 2) / (2 * sig * sig));
    }
    const dt = stableDt(g, h);
    const T = (400 * cell) / c;
    const steps = Math.round(T / dt);
    for (let n = 0; n < steps; n++) stepSwe(g, s, dt);
    let peak = 0, peakI = 0;
    for (let i = 0; i < nx; i++) if (s.eta[nx + i] > peak) { peak = s.eta[nx + i]; peakI = i; }
    const expected = x0 + (steps * dt * c) / cell;
    expect(Math.abs(peakI - expected)).toBeLessThan(3);
    // 800 km를 가는 동안 진폭 손실이 5% 미만이어야 한다. 1차 풍상 유한체적법은 여기서 크게 깎인다.
    expect(peak).toBeGreaterThan(0.95);
    expect(peak).toBeLessThan(1.03);
  });

  it('젖음과 마름이 일어나도 물의 부피가 보존된다', () => {
    const nx = 120, ny = 3, cell = 10;
    const bed = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) bed[j * nx + i] = -5 + Math.max(0, i - 60) * 0.2;
    const g = uniformGrid(nx, ny, cell, bed, 0.02);
    const eta0 = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) eta0[j * nx + i] = 2 * Math.exp(-((i - 20) ** 2) / 50);
    const s = createState(g, eta0);
    const v0 = totalVolume(g, s);
    const dt = stableDt(g, 8, 0.5);
    let wettedLand = false;
    for (let n = 0; n < 1500; n++) {
      stepSwe(g, s, dt);
      if (s.eta[nx + 90] - bed[nx + 90] > 0.02) wettedLand = true;
    }
    expect(wettedLand).toBe(true);
    expect(Math.abs(totalVolume(g, s) - v0) / v0).toBeLessThan(1e-4);
  });

  it('고립파의 경사면 처오름이 Synolakis (1987) 해석해와 15% 안에서 맞는다', () => {
    // NTHMP 벤치마크 1: 경사 1:19.85, H/d = 0.0185 (쇄파 없음)
    const d = 100, H = 0.0185 * d, cot = 19.85;
    const dx = d * 0.05;
    const xMin = -8 * d;
    const gamma = Math.sqrt((3 * H) / (4 * d));
    const X0 = d * cot;
    const X1 = X0 + (Math.acosh(Math.sqrt(20)) / gamma) * d;
    const nx = Math.ceil((X1 + 25 * d - xMin) / dx), ny = 3;
    const bed = new Float32Array(nx * ny);
    const eta0 = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = xMin + (i + 0.5) * dx;
      bed[j * nx + i] = x < X0 ? -x / cot : -d;
      eta0[j * nx + i] = H / Math.cosh((gamma * (x - X1)) / d) ** 2;
    }
    const g = uniformGrid(nx, ny, dx, bed, 0);
    const s = createState(g, eta0);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = xMin + (i + 1) * dx;
      s.u[j * nx + i] = (-Math.sqrt(G / d) * H) / Math.cosh((gamma * (x - X1)) / d) ** 2;
    }
    const dt = stableDt(g, d, 0.5);
    const tEnd = 80 * Math.sqrt(d / G);
    let runup = 0;
    while (s.t < tEnd) {
      stepSwe(g, s, dt);
      for (let i = 0; i < nx; i++) {
        const k = nx + i;
        if (bed[k] > 0 && s.eta[k] - bed[k] > 0.002 * d * 0.05 && bed[k] > runup) runup = bed[k];
      }
    }
    const analytic = 2.831 * Math.sqrt(cot) * (H / d) ** 1.25 * d;
    expect(runup / analytic).toBeGreaterThan(0.85);
    expect(runup / analytic).toBeLessThan(1.15);
  });
});
