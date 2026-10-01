import * as THREE from 'three';
import { childRectInParent, type GridSpec } from '../geo/grid';
import { cosLatAtPy, equatorMetersPerPixel, worldSize } from '../../app/src/geo/mercator';
import { GRAVITY } from '../../app/src/physics/constants';
import { COPY_FRAG, GpuCompute } from './compute';
import { CONTINUITY_FRAG, MOMENTUM_FRAG, RECORD_FRAG, RENDER_ETA_FRAG } from './shaders';

export interface LevelInput {
  grid: GridSpec;
  bed: Float32Array;
  eta0: Float32Array;
  wet0: Uint8Array;
  /** 초기 바다의 최대 수심(m). 시간 간격을 정한다. */
  maxDepth: number;
  /** 검증용 균일 격자 크기(m). 주면 Mercator 축척을 무시한다. */
  uniformCell?: number;
}

export interface GainSpec {
  /** 발생원 경위도를 전역 픽셀로 바꾸는 함수에 쓸 좌표. */
  lon: number;
  lat: number;
  refRadius: number;
}

export interface SolverOptions {
  manningSea: number;
  manningLand: number;
  /** CFL 안전율. */
  cfl: number;
  /** 가장 거친 격자의 스펀지층 두께(셀). */
  spongeWidth: number;
  /** 중첩 격자의 완화 구간 두께(셀). */
  relaxWidth: number;
  dryEps: number[];
  maxFroude: number;
  /** 파가 닿기 전에는 자식 격자를 돌리지 않는다. false면 처음부터 모두 돌린다. */
  lazyActivation: boolean;
  arrivalThreshold: number;
  gain?: GainSpec;
}

export const DEFAULT_SOLVER_OPTIONS: SolverOptions = {
  manningSea: 0.025,
  manningLand: 0.035,
  cfl: 0.55,
  spongeWidth: 24,
  relaxWidth: 20,
  dryEps: [0.05, 0.02, 0.01, 0.01],
  maxFroude: 2.5,
  lazyActivation: true,
  arrivalThreshold: 0.02,
};

const ACTIVATE_ETA = 0.004; // 부모 격자에서 이만큼 수위가 움직이면 자식을 깨운다(m)
const ACTIVATE_MARGIN = 6; // 자식 영역 둘레에 더 살피는 부모 셀 수
const ACTIVATE_EVERY = 8;

export class GpuLevel {
  readonly nx: number;
  readonly ny: number;
  dt = 0;
  /** 부모 한 스텝당 이 단계의 스텝 수. */
  ratio = 1;
  t = 0;
  steps = 0;
  active = true;
  pendingActivate = false;
  readonly staticTex: THREE.DataTexture;
  readonly initTex: THREE.DataTexture;
  cur: THREE.WebGLRenderTarget;
  prev: THREE.WebGLRenderTarget;
  readonly temp: THREE.WebGLRenderTarget;
  recCur: THREE.WebGLRenderTarget;
  recPrev: THREE.WebGLRenderTarget;
  readonly renderEta: THREE.WebGLRenderTarget;
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly momentum: THREE.RawShaderMaterial;
  readonly continuity: THREE.RawShaderMaterial;
  readonly record: THREE.RawShaderMaterial;
  readonly renderPass: THREE.RawShaderMaterial;
  readonly minCell: number;

  constructor(
    gc: GpuCompute,
    readonly index: number,
    readonly input: LevelInput,
    readonly parent: GpuLevel | null,
    opt: SolverOptions,
  ) {
    const { grid, bed, eta0, wet0 } = input;
    this.nx = grid.nx;
    this.ny = grid.ny;
    const n = this.nx * this.ny;
    const st = new Float32Array(n * 4);
    const init = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      st[k * 4] = bed[k];
      st[k * 4 + 1] = wet0[k] ? opt.manningSea : opt.manningLand;
      st[k * 4 + 2] = eta0[k];
      st[k * 4 + 3] = wet0[k];
      init[k * 4] = Math.max(eta0[k], bed[k]);
    }
    this.staticTex = gc.dataTexture(st, this.nx, this.ny);
    this.initTex = gc.dataTexture(init, this.nx, this.ny);
    this.cur = gc.target(this.nx, this.ny);
    this.prev = gc.target(this.nx, this.ny);
    this.temp = gc.target(this.nx, this.ny);
    this.recCur = gc.target(this.nx, this.ny);
    this.recPrev = gc.target(this.nx, this.ny);
    this.renderEta = gc.target(this.nx, this.ny);

    const eq = equatorMetersPerPixel(grid.z);
    let minCell = input.uniformCell ?? Infinity;
    if (!input.uniformCell) {
      minCell = Math.min(eq * cosLatAtPy(grid.py0, grid.z), eq * cosLatAtPy(grid.py0 + grid.ny, grid.z));
    }
    this.minCell = minCell;

    this.uniforms = {
      uState: { value: null },
      uStatic: { value: this.staticTex },
      uSize: { value: new THREE.Vector2(this.nx, this.ny) },
      uDt: { value: 0 },
      uDryEps: { value: opt.dryEps[Math.min(index, opt.dryEps.length - 1)] },
      uMaxFroude: { value: opt.maxFroude },
      uPy0: { value: grid.py0 },
      uWorld: { value: worldSize(grid.z) },
      uEqCell: { value: eq },
      uUniformCell: { value: input.uniformCell ?? 0 },
      uBoundaryMode: { value: parent ? 2 : input.uniformCell ? 0 : 1 },
      uBandWidth: { value: parent ? opt.relaxWidth : opt.spongeWidth },
      uParentPrev: { value: null },
      uParentCur: { value: null },
      uParentStatic: { value: parent ? parent.staticTex : null },
      uParentSize: { value: new THREE.Vector2(parent?.nx ?? 1, parent?.ny ?? 1) },
      uParentFrac: { value: 0 },
      uParentDryEps: { value: parent ? (parent.uniforms.uDryEps.value as number) : 0 },
      uParentOffset: { value: new THREE.Vector2() },
      uParentScale: { value: 1 },
      uGainRef: { value: 0 },
      uGainSrc: { value: new THREE.Vector2() },
      uGainSrcCell: { value: 1 },
      uFoamDecay: { value: 1 },
      uRecord: { value: null },
      uTime: { value: 0 },
      uArrivalThreshold: { value: opt.arrivalThreshold },
    };
    if (parent) {
      const [i0, j0] = childRectInParent(parent.input.grid, grid);
      (this.uniforms.uParentOffset.value as THREE.Vector2).set(i0, j0);
      this.uniforms.uParentScale.value = 2 ** (parent.input.grid.z - grid.z);
    }
    // 단계마다 유니폼 값이 달라서(보정 사용 여부 등) 셰이더별로 유니폼 사본을 둔다
    this.momentum = gc.material(MOMENTUM_FRAG, this.uniforms);
    this.continuity = gc.material(CONTINUITY_FRAG, this.uniforms);
    this.record = gc.material(RECORD_FRAG, this.uniforms);
    this.renderPass = gc.material(RENDER_ETA_FRAG, this.uniforms);
  }

  /** 원거리 감쇠 보정의 발생원 위치를 이 격자의 셀 좌표로 넣는다. */
  setGain(gain: GainSpec | undefined, srcPx: number, srcPy: number): void {
    if (!gain) return;
    const g = this.input.grid;
    const s = 2 ** g.z;
    (this.uniforms.uGainSrc.value as THREE.Vector2).set(srcPx * s - g.px0, srcPy * s - g.py0);
    this.uniforms.uGainSrcCell.value = equatorMetersPerPixel(g.z) * cosLatAtPy(srcPy * s, g.z);
  }

  dispose(): void {
    for (const t of [this.cur, this.prev, this.temp, this.recCur, this.recPrev, this.renderEta]) t.dispose();
    this.staticTex.dispose();
    this.initTex.dispose();
    for (const m of [this.momentum, this.continuity, this.record, this.renderPass]) m.dispose();
  }
}

export interface SolverStats {
  t: number;
  steps: number[];
  active: boolean[];
}

export class GpuSolver {
  readonly gc: GpuCompute;
  readonly levels: GpuLevel[] = [];
  readonly opt: SolverOptions;
  private readonly copy: THREE.RawShaderMaterial;
  private readonly copyU = { uSrc: { value: null as THREE.Texture | null } };
  private readonly clearRec: THREE.DataTexture[] = [];
  private gen: Generator<number, void, void>;
  /** 단계별 기록 주기(스텝). */
  recordEvery = [1, 2, 4, 4];
  private readonly gainRef: number;

  constructor(renderer: THREE.WebGLRenderer, inputs: LevelInput[], options: Partial<SolverOptions> = {}) {
    this.opt = { ...DEFAULT_SOLVER_OPTIONS, ...options };
    this.gc = new GpuCompute(renderer);
    this.copy = this.gc.material(COPY_FRAG, this.copyU);
    this.gainRef = this.opt.gain?.refRadius ?? 0;

    let srcPx = 0, srcPy = 0;
    if (this.opt.gain) {
      // 줌 0 기준 전역 픽셀(한 변 256)로 두고 단계마다 2^z를 곱한다
      srcPx = ((this.opt.gain.lon + 180) / 360) * 256;
      const lat = (this.opt.gain.lat * Math.PI) / 180;
      srcPy = ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * 256;
    }
    inputs.forEach((input, i) => {
      const level = new GpuLevel(this.gc, i, input, i > 0 ? this.levels[i - 1] : null, this.opt);
      level.setGain(this.opt.gain, srcPx, srcPy);
      this.levels.push(level);
      const rec = new Float32Array(level.nx * level.ny * 4);
      for (let k = 0; k < level.nx * level.ny; k++) {
        rec[k * 4] = -1e5;
        rec[k * 4 + 1] = -1;
      }
      this.clearRec.push(this.gc.dataTexture(rec, level.nx, level.ny));
    });
    this.computeTimeSteps();
    this.gen = this.run();
    this.reset();
  }

  private computeTimeSteps(): void {
    this.levels.forEach((lv, i) => {
      // 발생원이 수위를 크게 올릴 수 있으므로 수심에 여유를 둔다
      let maxEta = 0;
      for (let k = 0; k < lv.input.eta0.length; k += 7) {
        if (lv.input.wet0[k] && lv.input.eta0[k] > maxEta) maxEta = lv.input.eta0[k];
      }
      const depth = Math.max(lv.input.maxDepth + maxEta, 10);
      const dtCfl = (this.opt.cfl * lv.minCell) / Math.sqrt(2 * GRAVITY * depth);
      if (i === 0) {
        lv.dt = dtCfl;
        lv.ratio = 1;
      } else {
        const p = this.levels[i - 1];
        lv.ratio = Math.max(1, Math.ceil(p.dt / dtCfl));
        lv.dt = p.dt / lv.ratio;
      }
      lv.uniforms.uDt.value = lv.dt;
      lv.uniforms.uFoamDecay.value = Math.exp(-lv.dt / 25);
    });
  }

  reset(): void {
    this.levels.forEach((lv, i) => {
      this.copyU.uSrc.value = lv.initTex;
      this.gc.run(this.copy, lv.cur);
      this.gc.run(this.copy, lv.prev);
      this.copyU.uSrc.value = this.clearRec[i];
      this.gc.run(this.copy, lv.recCur);
      this.gc.run(this.copy, lv.recPrev);
      lv.t = 0;
      lv.steps = 0;
      lv.pendingActivate = false;
      lv.active = i === 0 || !this.opt.lazyActivation || this.sourceTouches(lv);
    });
    this.gen = this.run();
  }

  /** 초기 수위가 이 단계 안에서 이미 움직였으면 처음부터 돌려야 한다. */
  private sourceTouches(lv: GpuLevel): boolean {
    const { eta0, wet0 } = lv.input;
    for (let k = 0; k < eta0.length; k += 3) {
      if (wet0[k] && Math.abs(eta0[k]) > ACTIVATE_ETA) return true;
    }
    return false;
  }

  /**
   * 현재 시각. 깨어 있는 가장 세밀한 단계의 시각을 쓴다.
   * 거친 격자는 한 스텝이 수 초라서, 그 시각을 쓰면 재생 속도를 스텝 단위로밖에 제어할 수 없다.
   */
  get time(): number {
    for (let i = this.levels.length - 1; i > 0; i--) if (this.levels[i].active) return this.levels[i].t;
    return this.levels[0].t;
  }

  get stats(): SolverStats {
    return { t: this.time, steps: this.levels.map((l) => l.steps), active: this.levels.map((l) => l.active) };
  }

  private stepLevel(lv: GpuLevel, parentFrac: number): void {
    const u = lv.uniforms;
    u.uState.value = lv.cur.texture;
    this.gc.run(lv.momentum, lv.temp);
    u.uState.value = lv.temp.texture;
    if (lv.parent) {
      u.uParentPrev.value = lv.parent.prev.texture;
      u.uParentCur.value = lv.parent.cur.texture;
      u.uParentFrac.value = parentFrac;
      // 보정은 가장 거친 격자의 값을 넘겨받을 때만 적용한다
      u.uGainRef.value = lv.index === 1 ? this.gainRef : 0;
    }
    this.gc.run(lv.continuity, lv.prev);
    const tmp = lv.prev;
    lv.prev = lv.cur;
    lv.cur = tmp;
    lv.t += lv.dt;
    lv.steps++;
    const every = this.recordEvery[Math.min(lv.index, this.recordEvery.length - 1)];
    if (lv.steps % every === 0) this.updateRecord(lv);
  }

  private updateRecord(lv: GpuLevel): void {
    const u = lv.uniforms;
    u.uState.value = lv.cur.texture;
    u.uRecord.value = lv.recCur.texture;
    u.uTime.value = lv.t;
    u.uGainRef.value = lv.index === 0 ? this.gainRef : 0;
    this.gc.run(lv.record, lv.recPrev);
    const tmp = lv.recPrev;
    lv.recPrev = lv.recCur;
    lv.recCur = tmp;
  }

  /** 한 스텝을 돌 때마다 그 비용(백만 셀·스텝)을 내놓는 제너레이터. 프레임 예산에 맞춰 끊어 돌리기 위해서다. */
  private *run(): Generator<number, void, void> {
    for (;;) yield* this.advanceLevel(0, 1);
  }

  private *advanceLevel(i: number, parentFrac: number): Generator<number, void, void> {
    const lv = this.levels[i];
    if (lv.pendingActivate) {
      lv.pendingActivate = false;
      lv.active = true;
      lv.t = lv.parent ? lv.parent.t - lv.parent.dt : 0;
    }
    this.stepLevel(lv, parentFrac);
    yield (lv.nx * lv.ny) / 1e6;
    const child = this.levels[i + 1];
    if (!child) return;
    if (child.active || child.pendingActivate) {
      for (let k = 1; k <= child.ratio; k++) yield* this.advanceLevel(i + 1, k / child.ratio);
    } else if (lv.steps % ACTIVATE_EVERY === 0) {
      this.checkActivation(lv, child);
    }
  }

  /**
   * 부모 격자에서 자식이 차지하는 영역(여유 폭 포함)을 읽어 파가 닿았는지 본다.
   * 동기식으로 읽는다. 비동기로 하면 계산이 빠를 때 결과가 돌아오기 전에 파가 자식 안으로 들어가 버린다.
   * 점검 주기(8스텝) 동안 파는 최대 3.2셀 움직이므로 여유 폭 6셀이면 경계에 닿기 전에 반드시 깨어난다.
   * 읽는 양은 수백 KB이고 자식이 잠든 동안에만 하므로 부담이 없다.
   */
  private checkActivation(parent: GpuLevel, child: GpuLevel): void {
    const [ci0, cj0, ci1, cj1] = childRectInParent(parent.input.grid, child.input.grid);
    const i0 = Math.max(0, ci0 - ACTIVATE_MARGIN), j0 = Math.max(0, cj0 - ACTIVATE_MARGIN);
    const i1 = Math.min(parent.nx, ci1 + ACTIVATE_MARGIN), j1 = Math.min(parent.ny, cj1 + ACTIVATE_MARGIN);
    const w = i1 - i0, h = j1 - j0;
    const buf = new Float32Array(w * h * 4);
    this.gc.renderer.readRenderTargetPixels(parent.cur, i0, j0, w, h, buf);
    const eta0 = parent.input.eta0, wet0 = parent.input.wet0, pnx = parent.nx;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const pk = (j0 + j) * pnx + (i0 + i);
        if (wet0[pk] && Math.abs(buf[(j * w + i) * 4] - eta0[pk]) > ACTIVATE_ETA) {
          child.pendingActivate = true;
          return;
        }
      }
    }
  }

  /**
   * 예산(백만 셀·스텝)만큼, 또는 가장 거친 격자의 시각이 untilTime에 닿을 때까지 돌린다.
   * 돌린 비용을 돌려준다.
   */
  advance(budget: number, untilTime = Infinity): number {
    let used = 0;
    while (used < budget && this.time < untilTime) {
      const r = this.gen.next();
      if (r.done) break;
      used += r.value;
    }
    return used;
  }

  /** 렌더링용 수면 텍스처를 갱신한다. 프레임마다 한 번 부른다. */
  prepareRender(): void {
    // 잠든 단계도 갱신한다. 부모는 자식 영역을 그리지 않으므로 자식의 정지 수면이 필요하다.
    for (const lv of this.levels) {
      const u = lv.uniforms;
      u.uState.value = lv.cur.texture;
      u.uGainRef.value = lv.index === 0 ? this.gainRef : 0;
      this.gc.run(lv.renderPass, lv.renderEta);
    }
  }

  /** 상태를 CPU로 읽는다. 검증과 통계에 쓴다. */
  async readState(i: number): Promise<Float32Array> {
    const lv = this.levels[i];
    const buf = new Float32Array(lv.nx * lv.ny * 4);
    await this.gc.renderer.readRenderTargetPixelsAsync(lv.cur, 0, 0, lv.nx, lv.ny, buf);
    return buf;
  }

  async readRecord(i: number): Promise<Float32Array> {
    const lv = this.levels[i];
    const buf = new Float32Array(lv.nx * lv.ny * 4);
    await this.gc.renderer.readRenderTargetPixelsAsync(lv.recCur, 0, 0, lv.nx, lv.ny, buf);
    return buf;
  }

  dispose(): void {
    for (const lv of this.levels) lv.dispose();
    for (const t of this.clearRec) t.dispose();
    this.copy.dispose();
  }
}
