import type * as THREE from 'three';
import { buildLevelDem, type LevelDem } from '../geo/dem';
import { planLevels, QUALITIES } from '../geo/domain';
import { cellSizeAtRow, latToCell, lonToCell, type GridSpec } from '../geo/grid';
import type { TileProvider } from '../geo/tiles';
import { GpuSolver, type LevelInput } from '../gpu/solver';
import { prepareSource, rasterizeSource, sourceExtent, type PreparedSource } from '../physics/source';
import type { Scenario } from './scenario';

export interface InundationStats {
  /** 침수된 육지 면적(km²). */
  areaKm2: number;
  /** 육지에서의 최대 침수심(m). */
  maxDepth: number;
  /** 물이 닿은 가장 높은 지반 표고(m). 처오름 높이. */
  maxRunup: number;
  /** 해안선에서 가장 멀리 들어간 거리(m). */
  maxInland: number;
  /** 육지에 물이 처음 닿은 시각(s). 없으면 -1. */
  firstLandArrival: number;
  /** 관측 영역 바다의 최대 수위(m). */
  maxSeaLevel: number;
  maxSpeed: number;
}

export interface GaugeSample {
  t: number;
  eta: number;
}

export type ProgressFn = (stage: string, fraction: number) => void;

export class Simulation {
  readonly gauge: GaugeSample[] = [];
  stats: InundationStats = { areaKm2: 0, maxDepth: 0, maxRunup: 0, maxInland: 0, firstLandArrival: -1, maxSeaLevel: 0, maxSpeed: 0 };
  private statsBusy = false;
  private gaugeBusy = false;
  private readonly gaugeCell: [number, number];
  readonly gaugeLonLat: [number, number];

  constructor(
    readonly scenario: Scenario,
    readonly grids: GridSpec[],
    readonly dems: LevelDem[],
    readonly source: PreparedSource,
    readonly solver: GpuSolver,
    /** 초기 수면의 최대 융기와 침강(m). */
    readonly initialUp: number,
    readonly initialDown: number,
  ) {
    const fine = dems[dems.length - 1];
    this.gaugeCell = pickGaugeCell(fine, scenario.target.lon, scenario.target.lat);
    const g = fine.grid;
    const s = 2 ** g.z;
    const px = g.px0 + this.gaugeCell[0] + 0.5, py = g.py0 + this.gaugeCell[1] + 0.5;
    this.gaugeLonLat = [(px / (256 * s)) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / (256 * s)))) * 180) / Math.PI];
  }

  get finest(): number {
    return this.dems.length - 1;
  }

  /** 관측 지점의 수위를 기록한다. 가장 세밀한 격자가 깨어 있을 때만 의미가 있다. */
  sampleGauge(): void {
    const lv = this.solver.levels[this.finest];
    if (this.gaugeBusy || !lv.active) return;
    this.gaugeBusy = true;
    const buf = new Float32Array(4);
    const t = lv.t;
    this.solver.gc.renderer
      .readRenderTargetPixelsAsync(lv.cur, this.gaugeCell[0], this.gaugeCell[1], 1, 1, buf)
      .then(() => {
        const last = this.gauge[this.gauge.length - 1];
        if (!last || t > last.t) this.gauge.push({ t, eta: buf[0] });
      })
      .catch(() => undefined)
      .finally(() => { this.gaugeBusy = false; });
  }

  /** 가장 세밀한 격자의 기록을 읽어 침수 통계를 낸다. 16 MB 안팎을 읽으므로 1~2초에 한 번만 부른다. */
  async updateStats(): Promise<void> {
    if (this.statsBusy) return;
    this.statsBusy = true;
    try {
      const i = this.finest;
      const dem = this.dems[i];
      const rec = await this.solver.readRecord(i);
      const bed = this.solver.levels[i].input.bed;
      const { nx, ny } = dem.grid;
      const s: InundationStats = { areaKm2: 0, maxDepth: 0, maxRunup: 0, maxInland: 0, firstLandArrival: -1, maxSeaLevel: 0, maxSpeed: 0 };
      for (let j = 0; j < ny; j++) {
        const cell = cellSizeAtRow(dem.grid, j);
        const area = (cell * cell) / 1e6;
        for (let ii = 0; ii < nx; ii++) {
          const k = j * nx + ii;
          const level = rec[k * 4];
          if (level < -1e4) continue;
          if (dem.wet0[k]) {
            if (level > s.maxSeaLevel) s.maxSeaLevel = level;
            continue;
          }
          const d = level - bed[k];
          if (d < 0.05) continue;
          s.areaKm2 += area;
          if (d > s.maxDepth) s.maxDepth = d;
          if (bed[k] > s.maxRunup) s.maxRunup = bed[k];
          if (dem.shoreDist[k] > s.maxInland) s.maxInland = dem.shoreDist[k];
          const arr = rec[k * 4 + 1];
          if (arr >= 0 && (s.firstLandArrival < 0 || arr < s.firstLandArrival)) s.firstLandArrival = arr;
          if (rec[k * 4 + 2] > s.maxSpeed) s.maxSpeed = rec[k * 4 + 2];
        }
      }
      this.stats = s;
    } finally {
      this.statsBusy = false;
    }
  }

  dispose(): void {
    this.solver.dispose();
  }
}

/** 관측 중심에서 가장 가까운, 수심 3 m 이상인 바다 셀. 검조소 역할을 한다. */
function pickGaugeCell(dem: LevelDem, lon: number, lat: number): [number, number] {
  const g = dem.grid;
  const ci = Math.round(lonToCell(g, lon)), cj = Math.round(latToCell(g, lat));
  let best: [number, number] = [Math.max(0, Math.min(g.nx - 1, ci)), Math.max(0, Math.min(g.ny - 1, cj))];
  let bd = Infinity;
  for (let j = 0; j < g.ny; j += 2) {
    for (let i = 0; i < g.nx; i += 2) {
      const k = j * g.nx + i;
      if (!dem.wet0[k] || dem.bed[k] > -3) continue;
      const d = (i - ci) ** 2 + (j - cj) ** 2;
      if (d < bd) { bd = d; best = [i, j]; }
    }
  }
  return best;
}

export async function buildSimulation(
  renderer: THREE.WebGLRenderer,
  scenario: Scenario,
  provider: TileProvider,
  progress: ProgressFn = () => undefined,
): Promise<Simulation> {
  progress('격자를 계획하는 중', 0);
  const grids = planLevels({ sourceBox: sourceExtent(scenario.source), target: scenario.target, quality: QUALITIES[scenario.quality] });

  // 단계마다 타일 수가 다르므로 전체 타일 수로 진행률을 낸다
  const done = new Array<number>(grids.length).fill(0);
  const total = new Array<number>(grids.length).fill(1);
  const report = (): void => {
    const d = done.reduce((a, b) => a + b, 0), t = total.reduce((a, b) => a + b, 0);
    progress('지형 타일을 받는 중', 0.05 + 0.7 * (d / t));
  };
  const dems = await Promise.all(
    grids.map((g, i) => buildLevelDem(provider, g, (d, t) => { done[i] = d; total[i] = t; report(); })),
  );

  progress('발생원을 계산하는 중', 0.8);
  await nextFrame();
  const source = prepareSource(scenario.source, dems[0]);
  const inputs: LevelInput[] = [];
  let up = 0, down = 0;
  for (const dem of dems) {
    const r = rasterizeSource(source, dem);
    up = Math.max(up, r.maxUp);
    down = Math.min(down, r.maxDown);
    inputs.push({ grid: dem.grid, bed: r.bed, eta0: r.eta0, wet0: dem.wet0, maxDepth: dem.maxDepth });
    await nextFrame();
  }

  progress('GPU에 올리는 중', 0.92);
  await nextFrame();
  const gain = source.impact
    ? { lon: scenario.source.lon, lat: scenario.source.lat, refRadius: source.impact.cavity.refRadius }
    : undefined;
  const solver = new GpuSolver(renderer, inputs, { manningLand: scenario.manningLand, gain });
  progress('준비 완료', 1);
  return new Simulation(scenario, grids, dems, source, solver, up, down);
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
