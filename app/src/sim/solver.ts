import { GpuGrid, type Target, type UniformValue } from './gl';
import { ARRIVAL_THRESHOLDS } from './judge';
import { CONTINUITY_FRAG, MOMENTUM_FRAG, RECORD_FRAG } from './shaders';

const GRAVITY = 9.81;

export interface GridInput {
  nx: number;
  ny: number;
  /** 지반 표고(m). 바다는 음수. */
  bed: Float32Array;
  /** 초기 수위(m). 마른 셀은 지반 표고와 같게 둔다. */
  eta0: Float32Array;
  /** 처음부터 바다인 셀은 1. */
  wet0: Uint8Array;
  /** Mercator 격자: 줌, 전역 픽셀 좌표에서 이 격자의 첫 열과 첫 행, 세계의 한 변(px), 적도에서의 셀 크기(m). */
  zoom: number;
  px0: number;
  py0: number;
  world: number;
  eqCell: number;
  /** 검증용 균일 격자 크기(m). 주면 Mercator 축척을 무시한다. */
  uniformCell?: number;
  /** 경도 방향으로 이어지는 격자인지. */
  wrapX: boolean;
  /** 가장자리에서 파도를 흡수할지. 아니면 닫힌 벽이다. */
  sponge: boolean;
}

export interface SolverOptions {
  manningSea: number;
  manningLand: number;
  cfl: number;
  dryEps: number;
  maxFroude: number;
  spongeWidth: number;
  /** 도달 시각을 찍는 문턱값 셋(m). 초기 수위에서 이만큼 벗어난 첫 시각을 기록의 G, B, A에 둔다. */
  arrivalThresholds: [number, number, number];
  /** 몇 스텝마다 최대 수위와 도달 시각을 기록할지. */
  recordEvery: number;
  /** 중첩 격자에서 부모 값으로 완화하는 가장자리의 두께(셀). */
  relaxWidth: number;
  /** 소행성 원거리 감쇠 보정. 기록에 쓰는 기준 거리(m), 부모 값을 받을 때 쓰는 기준 거리(m), 발생원 단위 벡터. 0이면 없음. */
  gainRef: number;
  gainRelaxRef: number;
  gainSrc: [number, number, number];
}

/** 자식 격자가 부모 격자에 붙는 방식. */
export interface ParentLink {
  solver: SweSolver;
  /** 자식 원점의 부모 셀 좌표. */
  offset: [number, number];
  /** 자식 셀 하나가 부모 셀 몇 개인지. 1보다 작다. */
  scale: number;
}

export const DEFAULT_OPTIONS: SolverOptions = {
  manningSea: 0.025, manningLand: 0.035, cfl: 0.55, dryEps: 0.05, maxFroude: 2.5, spongeWidth: 16, arrivalThresholds: [...ARRIVAL_THRESHOLDS], recordEvery: 2, relaxWidth: 20, gainRef: 0, gainRelaxRef: 0, gainSrc: [0, 0, 1],
};

/** 격자 하나에서 비선형 천수방정식을 푼다. 운동량을 먼저 갱신하고, 새 유속으로 연속방정식을 푼다. */
export class SweSolver {
  /** 안정 조건이 허용하는 시간 간격. */
  readonly dtCfl: number;
  private _dt: number;
  t = 0;
  steps = 0;
  /** 중첩 격자에서, 파도가 아직 안 닿은 자식은 돌리지 않는다. */
  active = true;
  readonly opt: SolverOptions;
  private readonly gpu: GpuGrid;
  private readonly staticTex: WebGLTexture;
  private readonly init: Float32Array;
  private readonly clearRecord: Float32Array;
  private cur: Target;
  private next: Target;
  private readonly temp: Target;
  private recCur: Target;
  private recNext: Target;
  private readonly common: Record<string, UniformValue>;
  private readonly dummy: WebGLTexture;

  constructor(gl: WebGL2RenderingContext, readonly grid: GridInput, options: Partial<SolverOptions> = {}, readonly parent: ParentLink | null = null) {
    this.opt = { ...DEFAULT_OPTIONS, ...options };
    this.gpu = new GpuGrid(gl);
    this.gpu.warm([MOMENTUM_FRAG, CONTINUITY_FRAG, RECORD_FRAG]);
    this.dummy = this.gpu.texture(1, 1, new Float32Array(4));
    const { nx, ny, bed, eta0, wet0 } = grid;
    const n = nx * ny;
    const st = new Float32Array(n * 4);
    this.init = new Float32Array(n * 4);
    this.clearRecord = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      st[k * 4] = bed[k];
      st[k * 4 + 1] = wet0[k] ? this.opt.manningSea : this.opt.manningLand;
      st[k * 4 + 2] = eta0[k];
      st[k * 4 + 3] = wet0[k];
      this.init[k * 4] = Math.max(eta0[k], bed[k]);
      this.clearRecord[k * 4] = -1e5;
      this.clearRecord[k * 4 + 1] = -1;
      this.clearRecord[k * 4 + 2] = -1;
      this.clearRecord[k * 4 + 3] = -1;
    }
    this.staticTex = this.gpu.texture(nx, ny, st);
    this.cur = this.gpu.target(nx, ny, this.init);
    this.next = this.gpu.target(nx, ny, this.init);
    this.temp = this.gpu.target(nx, ny);
    this.recCur = this.gpu.target(nx, ny, this.clearRecord);
    this.recNext = this.gpu.target(nx, ny);

    // 안정 조건: 셀마다 (셀 크기 / 파속)을 구해 가장 빡빡한 값에 맞춘다. 고위도의 작은 셀과 저위도의 깊은 해구를 따로 최악으로 잡지 않는다.
    let worst = Infinity;
    for (let j = 0; j < ny; j++) {
      const s = grid.uniformCell ?? grid.eqCell / Math.cosh(Math.PI * (1 - (2 * (grid.py0 + j + 0.5)) / grid.world));
      let deepest = 10;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (wet0[k]) deepest = Math.max(deepest, Math.max(eta0[k], 0) - bed[k]);
      }
      worst = Math.min(worst, s / Math.sqrt(2 * GRAVITY * deepest));
    }
    this.dtCfl = this.opt.cfl * worst;
    this._dt = this.dtCfl;

    const pl = parent;
    this.common = {
      uStatic: this.staticTex, uSize: [nx, ny], uDt: this._dt, uDryEps: this.opt.dryEps, uMaxFroude: this.opt.maxFroude,
      uWrapX: grid.wrapX ? 1 : 0, uPy0: grid.py0, uPx0: grid.px0, uWorld: grid.world, uEqCell: grid.eqCell, uUniformCell: grid.uniformCell ?? 0,
      uGainRef: this.opt.gainRef, uGainRelaxRef: this.opt.gainRelaxRef, uGainSrc: this.opt.gainSrc,
      uBoundaryMode: pl ? 2 : grid.sponge ? 1 : 0, uBandWidth: pl ? this.opt.relaxWidth : this.opt.spongeWidth, uArrivalThresholds: this.opt.arrivalThresholds,
      uParentPrev: this.dummy, uParentCur: this.dummy, uParentStatic: pl ? pl.solver.bedTexture : this.dummy,
      uParentSize: pl ? [pl.solver.grid.nx, pl.solver.grid.ny] : [1, 1], uParentWrapX: pl?.solver.grid.wrapX ? 1 : 0, uParentFrac: 0,
      uParentDryEps: pl ? pl.solver.opt.dryEps : 0, uParentOffset: pl ? pl.offset : [0, 0], uParentScale: pl ? pl.scale : 1,
    };
  }

  get dt(): number {
    return this._dt;
  }
  /** 중첩 격자에서 부모의 시간 간격을 정수로 나눈 값으로 맞춘다. */
  set dt(v: number) {
    this._dt = v;
    this.common.uDt = v;
  }

  /** 현재 상태 텍스처. R = 수위. 그리기에서 바로 읽는다. */
  get stateTexture(): WebGLTexture {
    return this.cur.tex;
  }
  /** 직전 스텝의 상태. 자식 격자가 시간 보간에 쓴다. */
  get prevTexture(): WebGLTexture {
    return this.next.tex;
  }
  get bedTexture(): WebGLTexture {
    return this.staticTex;
  }
  get recordTexture(): WebGLTexture {
    return this.recCur.tex;
  }
  get cells(): number {
    return this.grid.nx * this.grid.ny;
  }
  /** GPU 메모리(바이트). RGBA32F 텍스처 여섯 장이다. */
  get gpuBytes(): number {
    return this.cells * 16 * 6;
  }

  reset(): void {
    this.gpu.upload(this.cur, this.init);
    this.gpu.upload(this.next, this.init);
    this.gpu.upload(this.recCur, this.clearRecord);
    this.t = 0;
    this.steps = 0;
  }

  /**
   * n 스텝 진행한다. 자식 격자는 부모의 직전 상태와 현재 상태 사이를 시간 보간하며,
   * frac0에서 시작해 스텝마다 dFrac씩 나아간다(부모 한 스텝을 ratio개로 나눈 경우 dFrac = 1/ratio).
   */
  step(n: number, frac0 = 1, dFrac = 0): void {
    const g = this.gpu;
    g.begin();
    const pl = this.parent;
    for (let s = 0; s < n; s++) {
      const frac = Math.min(1, frac0 + dFrac * s);
      g.run(MOMENTUM_FRAG, this.temp, { ...this.common, uState: this.cur.tex });
      g.run(CONTINUITY_FRAG, this.next, {
        ...this.common, uState: this.temp.tex, uParentFrac: frac,
        uParentPrev: pl ? pl.solver.prevTexture : this.dummy, uParentCur: pl ? pl.solver.stateTexture : this.dummy,
      });
      [this.cur, this.next] = [this.next, this.cur];
      this.t += this.dt;
      this.steps++;
      if (this.steps % this.opt.recordEvery === 0) {
        g.run(RECORD_FRAG, this.recNext, { ...this.common, uState: this.cur.tex, uRecord: this.recCur.tex, uTime: this.t });
        [this.recCur, this.recNext] = [this.recNext, this.recCur];
      }
    }
    g.end();
  }

  readState(): Float32Array {
    return this.gpu.read(this.cur);
  }
  /** 상태의 일부를 읽는다. 자식 격자를 깨울지 판단할 때 쓴다. */
  readStateRect(x: number, y: number, w: number, h: number): Float32Array {
    return this.gpu.read(this.cur, x, y, w, h);
  }
  readRecord(): Float32Array {
    return this.gpu.read(this.recCur);
  }
  /** 셀 하나의 [수위, u, v]. 검조소처럼 쓴다. */
  readCell(i: number, j: number): [number, number, number] {
    const v = this.gpu.read(this.cur, i, j, 1, 1);
    return [v[0], v[1], v[2]];
  }

  dispose(): void {
    this.gpu.dispose([this.cur, this.next, this.temp, this.recCur, this.recNext], [this.staticTex, this.dummy]);
  }
}
