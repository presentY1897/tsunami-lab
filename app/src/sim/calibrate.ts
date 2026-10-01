import { pxToLon, pyToLat } from '../geo/mercator';
import type { ImpactModel } from './impact';
import { SweSolver, type GridInput } from './solver';

const GRAVITY = 9.81;

/**
 * 소행성 공동의 진폭을 실제 계산 격자에서 보정한다.
 * 1차원 방사형 모형으로 미리 구한 보정은 2차원 격자의 수치 감쇠와 실제 해저 지형 때문에 2~3배 어긋났다(동해 실측).
 * 그래서 격자 하나를 따로 만들어 파가 기준 거리에 닿을 때까지만 돌리고, 기준 거리 고리의 최대 수위를 재서 목표에 맞춘다.
 * 비용은 전 지구 격자 50스텝 안팎, 발생원 격자 200스텝 안팎이다.
 * 초기 수위 배열을 제자리에서 배율만큼 키워 돌려준다. 배율은 0.1~30으로 묶는다.
 */
function measureRing(gl: WebGL2RenderingContext, input: GridInput, model: ImpactModel): number {
  const probe = new SweSolver(gl, { ...input, sponge: true }, { recordEvery: 1 });
  const c = Math.sqrt(GRAVITY * model.waterDepth);
  const tCal = (model.refRadius * 1.3) / c + 120;
  probe.step(Math.max(1, Math.ceil(tCal / probe.dt)));
  const rec = probe.readRecord();
  probe.dispose();

  const { nx, ny, px0, py0, world, wet0, bed } = input;
  const zoom = Math.log2(world / 256);
  const p = model.params;
  const kx = 111195 * Math.cos((p.lat * Math.PI) / 180), ky = 111195;
  let sum = 0, n = 0;
  for (let j = 0; j < ny; j++) {
    const dN = (pyToLat(py0 + j + 0.5, zoom) - p.lat) * ky;
    if (Math.abs(dN) > model.refRadius * 1.15) continue;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!wet0[k] || bed[k] > -500) continue; // 깊은 바다에서만 잰다. 얕은 곳은 천수 효과로 값이 달라진다.
      let dLon = pxToLon(((px0 + i) % world) + 0.5, zoom) - p.lon;
      dLon = ((dLon + 540) % 360) - 180;
      const r = Math.hypot(dLon * kx, dN);
      if (Math.abs(r - model.refRadius) > model.refRadius * 0.1) continue;
      const v = rec[k * 4];
      if (v > -1e4) { sum += v; n++; }
    }
  }
  return n > 0 ? sum / n : 0;
}

function scaleEta(input: GridInput, gain: number): void {
  for (let k = 0; k < input.eta0.length; k++) if (input.wet0[k]) input.eta0[k] = Math.max(input.eta0[k] * gain, input.bed[k]);
}

/**
 * 공동이 커지면 파도가 비선형이 되어 진폭이 배율에 비례해 늘지 않는다. 그래서 재고 맞추기를 두 번 한다.
 * 초기 수위 배열을 제자리에서 키워 놓고 전체 배율을 돌려준다. 배율은 0.1~30으로 묶는다.
 */
export function calibrateImpactGrid(gl: WebGL2RenderingContext, input: GridInput, model: ImpactModel): { gain: number; measured: number } {
  let total = 1, measured = 0;
  for (let pass = 0; pass < 2; pass++) {
    measured = measureRing(gl, input, model);
    if (measured <= 1e-3) break;
    const g = Math.max(0.1, Math.min(30 / total, model.targetAmp / measured));
    if (Math.abs(g - 1) < 0.03) break;
    scaleEta(input, g);
    total *= g;
  }
  return { gain: total, measured };
}
