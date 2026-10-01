import { SweSolver, type GridInput, type SolverOptions } from './solver';

/** 부모 격자에서 이만큼 수위가 움직이면 자식을 깨운다(m). */
const ACTIVATE_ETA = 0.004;
/** 자식 영역 둘레에 더 살피는 부모 셀 수. 점검 주기 동안 파가 움직이는 거리보다 넓다. */
const ACTIVATE_MARGIN = 6;
const ACTIVATE_EVERY = 8;

export interface LevelInput {
  grid: GridInput;
  /** 부모 단계의 번호. 0번(가장 거친 격자)은 -1. */
  parent: number;
  /** 깨어난 뒤 이 시간(s)이 지나면 다시 잠든다. 해안 격자의 비용을 묶는다. 없으면 계속 돈다. */
  maxActiveS?: number;
  /** 이 단계만의 설정. 공통 설정 위에 덮어쓴다. */
  options?: Partial<SolverOptions>;
}

/**
 * 중첩 격자. 0번이 가장 거친 격자이고 나머지는 각자의 부모 안에 놓인다(나무 구조).
 * 부모 한 스텝마다 자식은 여러 스텝을 돈다. 자식은 가장자리에서 부모 값으로 완화되고, 파가 닿기 전에는 돌지 않는다(단방향 중첩, 결정 D-006).
 */
export class NestedSolver {
  readonly levels: SweSolver[] = [];
  readonly parents: number[] = [];
  readonly children: number[][] = [];
  /** 부모 한 스텝당 자식 스텝 수. */
  readonly ratios: number[] = [];
  private readonly rects: [number, number, number, number][] = [];
  private readonly maxActive: number[] = [];
  private readonly activeSince: number[] = [];
  /** 한 번 잠든 격자는 다시 깨우지 않는다. */
  readonly spent: boolean[] = [];

  constructor(gl: WebGL2RenderingContext, inputs: LevelInput[], options: Partial<SolverOptions> = {}) {
    inputs.forEach((entry, i) => {
      const { grid: input, parent: pi } = entry;
      this.children.push([]);
      this.parents.push(pi);
      this.maxActive.push(entry.maxActiveS ?? Infinity);
      this.activeSince.push(0);
      this.spent.push(false);
      const opts = { ...options, ...entry.options };
      if (pi < 0) {
        this.levels.push(new SweSolver(gl, input, opts));
        this.ratios.push(1);
        this.rects.push([0, 0, 0, 0]);
        return;
      }
      const parent = this.levels[pi], pg = parent.grid;
      const s = 2 ** (pg.zoom - input.zoom);
      const i0 = input.px0 * s - pg.px0, j0 = input.py0 * s - pg.py0;
      const child = new SweSolver(gl, input, opts, { solver: parent, offset: [i0, j0], scale: s });
      const ratio = Math.max(1, Math.ceil(parent.dt / child.dtCfl));
      child.dt = parent.dt / ratio;
      child.active = this.sourceTouches(input);
      this.levels.push(child);
      this.ratios.push(ratio);
      this.rects.push([i0, j0, i0 + input.nx * s, j0 + input.ny * s]);
      this.children[pi].push(i);
    });
  }

  /** 초기 수위가 이 격자 안에서 이미 움직였으면 처음부터 돌려야 한다. */
  private sourceTouches(input: GridInput): boolean {
    for (let k = 0; k < input.eta0.length; k += 3) if (input.wet0[k] && Math.abs(input.eta0[k]) > ACTIVATE_ETA) return true;
    return false;
  }

  /** 현재 시각. 가장 거친 격자의 시각이다. 이 격자는 늘 돌고, 깨어 있는 자식은 부모 한 스텝이 끝날 때마다 같은 시각에 와 있다. */
  get t(): number {
    return this.levels[0].t;
  }
  get dt(): number {
    return this.levels[0].dt;
  }
  get steps(): number {
    return this.levels[0].steps;
  }
  get cells(): number {
    return this.levels.reduce((a, l) => a + l.cells, 0);
  }
  get gpuBytes(): number {
    return this.levels.reduce((a, l) => a + l.gpuBytes, 0);
  }
  /** 부모 한 스텝의 비용(셀·스텝). 깨어 있는 격자만 센다. */
  get costPerStep(): number {
    const mult = (i: number): number => (this.parents[i] < 0 ? 1 : this.ratios[i] * mult(this.parents[i]));
    return this.levels.reduce((a, l, i) => a + (l.active ? l.cells * mult(i) : 0), 0);
  }

  reset(): void {
    this.levels.forEach((l, i) => {
      l.reset();
      this.spent[i] = false;
      if (i > 0) l.active = this.sourceTouches(l.grid);
      this.activeSince[i] = 0;
    });
  }

  /** 가장 거친 격자 기준으로 n 스텝 진행한다. */
  step(n: number): void {
    for (let s = 0; s < n; s++) this.advance(0, 1);
  }

  private advance(i: number, frac: number): void {
    const lv = this.levels[i];
    lv.step(1, frac, 0);
    for (const c of this.children[i]) {
      const child = this.levels[c];
      if (!child.active) {
        if (this.spent[c] || lv.steps % ACTIVATE_EVERY !== 0 || !this.waveReached(c)) continue;
        child.active = true;
        child.t = lv.t - lv.dt;
        this.activeSince[c] = child.t;
      }
      const ratio = this.ratios[c];
      // 자식 스텝마다 부모의 직전 상태와 현재 상태 사이를 k/ratio로 보간한다
      for (let k = 1; k <= ratio; k++) {
        // 자식이 이 스텝 안에서 잠들면 남은 스텝은 돌지 않는다
        if (!child.active) break;
        this.advance(c, k / ratio);
      }
    }
    // 자식은 부모의 값을 받아 돌므로, 깨어 있는 자식이 있으면 시간이 다 돼도 잠들지 않는다.
    // 전에는 중간 격자가 먼저 잠들어 해안 격자가 깨어 있는 채로 멈췄다(D-045).
    if (i > 0 && lv.t - this.activeSince[i] > this.maxActive[i] && !this.children[i].some((c) => this.levels[c].active)) this.sleep(i);
  }

  /** 격자를 재운다. 아직 깨어나지 못한 자손은 부모 없이 돌 수 없으므로 같이 끝낸다. */
  private sleep(i: number): void {
    this.levels[i].active = false;
    this.spent[i] = true;
    for (const c of this.children[i]) this.sleep(c);
  }

  /** 부모 격자에서 자식이 차지하는 영역(여유 포함)을 읽어 파가 닿았는지 본다. 동기식으로 읽는다(결정 D-007). */
  private waveReached(i: number): boolean {
    const parent = this.levels[this.parents[i]], [ci0, cj0, ci1, cj1] = this.rects[i];
    const pg = parent.grid;
    const i0 = pg.wrapX ? ci0 - ACTIVATE_MARGIN : Math.max(0, ci0 - ACTIVATE_MARGIN);
    const j0 = Math.max(0, cj0 - ACTIVATE_MARGIN);
    const i1 = pg.wrapX ? ci1 + ACTIVATE_MARGIN : Math.min(pg.nx, ci1 + ACTIVATE_MARGIN);
    const j1 = Math.min(pg.ny, cj1 + ACTIVATE_MARGIN);
    const h = j1 - j0;
    // 순환 격자에서 이음매에 걸치면 두 조각으로 읽는다
    const spans: [number, number][] = [];
    if (i0 < 0) { spans.push([((i0 % pg.nx) + pg.nx) % pg.nx, pg.nx]); spans.push([0, i1]); }
    else if (i1 > pg.nx) { spans.push([i0, pg.nx]); spans.push([0, i1 - pg.nx]); }
    else spans.push([i0, i1]);
    for (const [x0, x1] of spans) {
      const w = x1 - x0;
      if (w <= 0) continue;
      const buf = parent.readStateRect(x0, j0, w, h);
      for (let j = 0; j < h; j++) for (let i2 = 0; i2 < w; i2++) {
        const pk = (j0 + j) * pg.nx + x0 + i2;
        if (pg.wet0[pk] && Math.abs(buf[(j * w + i2) * 4] - pg.eta0[pk]) > ACTIVATE_ETA) return true;
      }
    }
    return false;
  }

  /** 가장 거친 격자의 셀 하나. 검조소처럼 쓴다. */
  readCell(i: number, j: number): [number, number, number] {
    return this.levels[0].readCell(i, j);
  }
  /**
   * 전 지구와 발생원 격자에서 젖은 셀의 가장 큰 |수위|(m). 파가 잦아들었는지 볼 때 쓴다(D-040).
   * 상태 텍스처를 통째로 읽으므로(전 지구 약 10 MB) 자주 부르지 않는다.
   */
  maxAbsEta(): number {
    let m = 0;
    for (const lv of this.levels.slice(0, 2)) {
      if (!lv.active) continue;
      const st = lv.readState(), { bed, wet0 } = lv.grid;
      for (let k = 0; k < bed.length; k++) {
        // 처음부터 바다였던 셀만 본다. 육지 위 웅덩이에 갇힌 물은 파가 아니다
        if (!wet0[k]) continue;
        const e = st[k * 4];
        if (e - bed[k] > 0.05) { const a = Math.abs(e); if (a > m) m = a; }
      }
    }
    return m;
  }
  readRecord(level = 0): Float32Array {
    return this.levels[level].readRecord();
  }

  dispose(): void {
    for (const l of this.levels) l.dispose();
  }
}
