import './app/style.css';
import * as THREE from 'three';
import { fmtInt, fmtKm, fmtLonLat, fmtM, fmtT } from './app/format';
import { DEFAULT_SCENARIO, MANNING_CHOICES, PRESETS, type Preset, type Scenario } from './app/scenario';
import { buildSimulation, type Simulation } from './app/simulation';
import { planLevels, QUALITIES, type QualityName } from './geo/domain';
import { cellSizeAtRow, gridBounds, type GridSpec } from './geo/grid';
import { DEG, haversine } from './geo/mercator';
import { TerrariumTileProvider } from './geo/tiles';
import { BASEMAP_ATTRIBUTION, Picker, renderDrape } from './picker/picker';
import { autoStrike } from './physics/autostrike';
import { transientCraterDiameter, type ImpactParams } from './physics/impact';
import { buildQuakeField, type QuakeParams } from './physics/quake';
import { sourceExtent } from './physics/source';
import type { OverlayMode } from './render/terrain';
import { SceneView } from './render/view';

type Mode = 'setup' | 'loading' | 'sim';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const provider = new TerrariumTileProvider();
const app = $('app');
const scenario: Scenario = structuredClone(DEFAULT_SCENARIO);
// 발생원 종류를 바꿔도 다른 쪽 설정이 남도록 따로 보관한다
let quakeParams: QuakeParams = structuredClone(PRESETS[0].source as QuakeParams);
let impactParams: ImpactParams = structuredClone(PRESETS[3].source as ImpactParams);
let activePreset: Preset | null = PRESETS[0];
let cameraBearing: number | null = PRESETS[0].bearing;

let mode: Mode = 'setup';
let sim: Simulation | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let view: SceneView | null = null;
let running = false;
let done = false;
let overlay: OverlayMode = 'none';
let simClock = 0;
let budget = 3;
let fineWasActive = false;
let autoFlown = false;
let drapeTex: THREE.CanvasTexture | null = null;
let plannedGrids: GridSpec[] = [];
const params = new URLSearchParams(location.search);
const turboBudget = Number(params.get('turbo') ?? 0);

function setMode(m: Mode): void {
  mode = m;
  app.dataset.mode = m;
  if (m === 'setup') requestAnimationFrame(() => picker.resize());
}

function toast(msg: string, ms = 4000): void {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  window.setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- 설정 화면 ----------

const picker = new Picker($('pickerMap'), {
  onSourceMoved(lon, lat) {
    activePreset = null;
    cameraBearing = null;
    scenario.source.lon = lon;
    scenario.source.lat = lat;
    if (scenario.source.kind === 'quake') {
      const src = scenario.source;
      autoStrike(provider, lon, lat)
        .then((s) => {
          if (scenario.source === src && src.lon === lon && src.lat === lat) {
            src.strike = Math.round(s);
            syncControls();
            refreshSetup();
          }
        })
        .catch(() => undefined);
    }
    refreshSetup();
  },
  onTargetMoved(lon, lat) {
    activePreset = null;
    cameraBearing = null;
    scenario.target = { lon, lat };
    refreshSetup();
  },
});

const diamFromT = (t: number): number => Math.round(10 ** (1.699 + t * (3.477 - 1.699)) / 10) * 10; // 50 m .. 3 km
const tFromDiam = (d: number): number => (Math.log10(d) - 1.699) / (3.477 - 1.699);

function syncControls(): void {
  const s = scenario.source;
  const isQuake = s.kind === 'quake';
  $('tQuake').setAttribute('aria-pressed', String(isQuake));
  $('tImpact').setAttribute('aria-pressed', String(!isQuake));
  $('quakeCtl').hidden = !isQuake;
  $('impactCtl').hidden = isQuake;
  if (s.kind === 'quake') {
    $<HTMLInputElement>('mw').value = String(s.Mw);
    $('mwv').textContent = `M${s.Mw.toFixed(1)}`;
    $<HTMLInputElement>('strike').value = String(s.strike);
    $('strikev').textContent = `${Math.round(s.strike)}°`;
    $<HTMLInputElement>('dip').value = String(s.dip);
    $('dipv').textContent = `${s.dip}°`;
    $<HTMLInputElement>('top').value = String(s.topKm);
    $('topv').textContent = `${s.topKm} km`;
    $<HTMLSelectElement>('slip').value = s.slipModel;
  } else {
    $<HTMLInputElement>('diam').value = String(tFromDiam(s.diameter));
    $('diamv').textContent = s.diameter >= 1000 ? `${(s.diameter / 1000).toFixed(1)} km` : `${s.diameter} m`;
    $<HTMLInputElement>('vel').value = String(s.velocity);
    $('velv').textContent = `${s.velocity} km/s`;
    $<HTMLSelectElement>('rho').value = String(s.density);
  }
  $<HTMLSelectElement>('quality').value = scenario.quality;
  $<HTMLSelectElement>('man').value = String(scenario.manningLand);
  $<HTMLInputElement>('dur').value = String(scenario.duration / 3600);
  $('durv').textContent = fmtT(scenario.duration);
  document.querySelectorAll<HTMLButtonElement>('#presets button').forEach((b) => {
    b.setAttribute('aria-pressed', String(activePreset?.id === b.dataset.id));
  });
  $('presetNote').textContent = activePreset?.note ?? '';
}

function refreshSetup(): void {
  const s = scenario.source;
  picker.setSourcePosition(s.lon, s.lat);
  picker.setTargetPosition(scenario.target.lon, scenario.target.lat);
  const el = $('summary');
  if (s.kind === 'quake') {
    const q = buildQuakeField(s);
    picker.setSourceShape(q.outline);
    el.innerHTML = `<div>단층 크기<b>${Math.round(q.fault.L / 1000)} × ${Math.round(q.fault.W / 1000)} km</b></div>
      <div>평균 미끄러짐<b>${q.fault.meanSlip.toFixed(1)} m</b></div>
      <div>최대 미끄러짐<b>${q.fault.peakSlip.toFixed(1)} m</b></div>
      <div>위치<b>${fmtLonLat(s.lon, s.lat)}</b></div>`;
  } else {
    const Dtc = transientCraterDiameter(s);
    picker.setSourceShape(null, { lon: s.lon, lat: s.lat, radiusM: Dtc / 2 });
    const mass = (Math.PI / 6) * s.diameter ** 3 * s.density;
    const mt = (0.5 * mass * (s.velocity * 1000) ** 2) / 4.184e15;
    el.innerHTML = `<div>물에 파이는 크레이터<b>${fmtKm(Dtc)}</b></div>
      <div>충돌 에너지<b>${mt >= 1000 ? `${fmtInt(mt / 1000)} Gt` : `${fmtInt(mt)} Mt`}</b></div>
      <div class="wide">위치 ${fmtLonLat(s.lon, s.lat)}. 육지에 떨어지면 쓰나미는 생기지 않습니다.</div>`;
  }

  plannedGrids = planLevels({ sourceBox: sourceExtent(s), target: scenario.target, quality: QUALITIES[scenario.quality] });
  picker.setGrids(plannedGrids);
  const fine = plannedGrids[plannedGrids.length - 1];
  const coarse = plannedGrids[0];
  const fineCell = cellSizeAtRow(fine, fine.ny >> 1), coarseCell = cellSizeAtRow(coarse, coarse.ny >> 1);
  const dist = haversine(s.lon, s.lat, scenario.target.lon, scenario.target.lat);
  $('targetInfo').innerHTML = `<div>관측 중심<b>${scenario.target.name ?? fmtLonLat(scenario.target.lon, scenario.target.lat)}</b></div>
    <div>발생원까지<b>${fmtKm(dist)}</b></div>
    <div>세밀 격자<b>${Math.round(fineCell)} m, ${Math.round((fine.nx * fineCell) / 1000)} km 영역</b></div>
    <div>바다 격자<b>${(coarseCell / 1000).toFixed(1)} km, ${plannedGrids.length}단계</b></div>`;
  const cells = plannedGrids.reduce((a, g) => a + g.nx * g.ny, 0);
  $('qualityNote').textContent = `격자 ${plannedGrids.map((g) => `${g.nx}×${g.ny}`).join(', ')}. 셀 ${(cells / 1e6).toFixed(1)}백만 개, GPU 메모리 약 ${Math.round((cells * 4 * 4 * 7) / 1e6)} MB.`;
  $('startNote').textContent = coarseCell > 6000 ? '발생원이 멀어 바다 격자가 거칩니다. 파장이 짧은 파(소행성, 작은 지진)는 과하게 뭉개질 수 있습니다.' : '';
  writeHash();
}

function applyPreset(p: Preset): void {
  activePreset = p;
  cameraBearing = p.bearing;
  scenario.source = structuredClone(p.source);
  if (p.source.kind === 'quake') quakeParams = scenario.source as QuakeParams;
  else impactParams = scenario.source as ImpactParams;
  scenario.target = { ...p.target };
  scenario.duration = p.duration;
  syncControls();
  refreshSetup();
  const ext = sourceExtent(scenario.source);
  void picker.fitTo({
    west: Math.min(ext.west, p.target.lon) - 1, east: Math.max(ext.east, p.target.lon) + 1,
    south: Math.min(ext.south, p.target.lat) - 1, north: Math.max(ext.north, p.target.lat) + 1,
  });
}

function bindSetup(): void {
  $('presets').innerHTML = PRESETS.map((p) => `<button type="button" data-id="${p.id}">${p.label}</button>`).join('');
  $('presets').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    const p = PRESETS.find((x) => x.id === b?.dataset.id);
    if (p) applyPreset(p);
  });
  $('man').innerHTML = MANNING_CHOICES.map((m) => `<option value="${m.value}">${m.label}</option>`).join('');

  const setKind = (kind: 'quake' | 'impact'): void => {
    if (scenario.source.kind === kind) return;
    const { lon, lat } = scenario.source;
    activePreset = null;
    scenario.source = kind === 'quake' ? { ...quakeParams, lon, lat } : { ...impactParams, lon, lat };
    if (kind === 'quake') quakeParams = scenario.source as QuakeParams;
    else impactParams = scenario.source as ImpactParams;
    syncControls();
    refreshSetup();
  };
  $('tQuake').onclick = () => setKind('quake');
  $('tImpact').onclick = () => setKind('impact');

  const onQuake = (id: string, apply: (s: QuakeParams, v: string) => void): void => {
    $(id).addEventListener('input', (e) => {
      if (scenario.source.kind !== 'quake') return;
      apply(scenario.source, (e.target as HTMLInputElement).value);
      activePreset = null;
      syncControls();
      refreshSetup();
    });
  };
  onQuake('mw', (s, v) => { s.Mw = +v; });
  onQuake('strike', (s, v) => { s.strike = +v; });
  onQuake('dip', (s, v) => { s.dip = +v; });
  onQuake('top', (s, v) => { s.topKm = +v; });
  onQuake('slip', (s, v) => { s.slipModel = v as QuakeParams['slipModel']; });
  const onImpact = (id: string, apply: (s: ImpactParams, v: string) => void): void => {
    $(id).addEventListener('input', (e) => {
      if (scenario.source.kind !== 'impact') return;
      apply(scenario.source, (e.target as HTMLInputElement).value);
      activePreset = null;
      syncControls();
      refreshSetup();
    });
  };
  onImpact('diam', (s, v) => { s.diameter = diamFromT(+v); });
  onImpact('vel', (s, v) => { s.velocity = +v; });
  onImpact('rho', (s, v) => { s.density = +v; });

  $('quality').addEventListener('change', (e) => { scenario.quality = (e.target as HTMLSelectElement).value as QualityName; refreshSetup(); });
  $('man').addEventListener('change', (e) => { scenario.manningLand = +(e.target as HTMLSelectElement).value; writeHash(); });
  $('dur').addEventListener('input', (e) => { scenario.duration = +(e.target as HTMLInputElement).value * 3600; syncControls(); writeHash(); });

  document.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => {
    b.onclick = () => {
      picker.mode = b.dataset.pick as 'source' | 'target';
      document.querySelectorAll('[data-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  });
  $('start').onclick = () => void startSimulation();
}

// ---------- 시뮬레이션 화면 ----------

function ensureRenderer(): { renderer: THREE.WebGLRenderer; view: SceneView } {
  if (!renderer) {
    const canvas = $<HTMLCanvasElement>('view3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 색은 셰이더에서 sRGB 값으로 직접 다룬다
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    view = new SceneView(renderer, { maxSegments: scenario.quality === 'low' ? 512 : 1024 });
    const stage = $('stage');
    const onResize = (): void => {
      const r = stage.getBoundingClientRect();
      renderer!.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
      view!.resize(r.width, r.height);
    };
    new ResizeObserver(onResize).observe(stage);
    onResize();
  }
  return { renderer, view: view! };
}

async function startSimulation(): Promise<void> {
  if (mode === 'loading') return;
  setMode('loading');
  const bar = $('loadingBar'), title = $('loadingTitle');
  try {
    const rv = ensureRenderer();
    sim?.dispose();
    sim = null;
    rv.view.clear();
    const built = await buildSimulation(rv.renderer, structuredClone(scenario), provider, (stage, f) => {
      title.textContent = stage;
      bar.style.width = `${Math.round(f * 100)}%`;
    });
    sim = built;
    if (built.source.noTsunami) {
      built.dispose();
      sim = null;
      setMode('setup');
      toast('충돌 지점이 육지이거나 너무 얕습니다. 바다를 골라 주세요.');
      return;
    }
    // 먼 바다에서 파고를 과장하고 색을 입힐 때의 기준 진폭. 지진은 해저 변위가 곧 파고 규모다.
    // 소행성은 공동 깊이가 수백 m 이상이라 기준으로 쓸 수 없다. 원거리 파고(60 km 지점의 1/4)를 쓴다.
    const amp = built.source.impact
      ? Math.max(1, built.source.impact.cavity.targetAt60km * 0.25)
      : Math.max(built.initialUp, -built.initialDown);
    rv.view.setSolver(built.solver, scenario.target.lat, amp);
    const s = scenario.source;
    if (built.source.quake) {
      rv.view.addOutline(built.source.quake.outline, 0xffffff);
      rv.view.addOutline([built.source.quake.outline[0], built.source.quake.outline[1]], 0xff5533, false);
    } else if (built.source.impact) {
      const r = built.source.impact.cavity.craterDiameter / 2;
      const ring: [number, number][] = [];
      for (let a = 0; a < 360; a += 5) ring.push([s.lon + (r * Math.sin(a * DEG)) / (111195 * Math.cos(s.lat * DEG)), s.lat + (r * Math.cos(a * DEG)) / 111195]);
      rv.view.addOutline(ring, 0xff5533);
    }
    rv.view.addLevelOutline(built.grids[built.grids.length - 1], 0x66aaff);
    rv.view.viewOcean(0);
    drapeTex?.dispose();
    drapeTex = null;
    $<HTMLInputElement>('drape').checked = false;
    resetRun();
    setMode('sim');
    renderSimPanel(true);
    running = true;
    updateRunButton();
  } catch (e) {
    console.error(e);
    setMode('setup');
    toast(`시작하지 못했습니다. ${e instanceof Error ? e.message : String(e)}`, 7000);
  }
}

function resetRun(): void {
  if (!sim) return;
  sim.solver.reset();
  sim.gauge.length = 0;
  sim.stats = { areaKm2: 0, maxDepth: 0, maxRunup: 0, maxInland: 0, firstLandArrival: -1, maxSeaLevel: 0, maxSpeed: 0 };
  simClock = 0;
  done = false;
  fineWasActive = sim.solver.levels[sim.finest].active;
  autoFlown = false;
  setOverlay('none');
}

function coastBearing(): number {
  if (cameraBearing !== null) return cameraBearing;
  // 발생원에서 관측 해안을 향하는 방위. 파도 뒤에서 해안을 바라보게 된다.
  const s = scenario.source, t = scenario.target;
  const dLon = (t.lon - s.lon) * Math.cos(t.lat * DEG), dLat = t.lat - s.lat;
  return ((Math.atan2(dLon, dLat) / DEG) + 360) % 360;
}

function flyToCoast(duration = 2.2): void {
  if (!sim || !view) return;
  const fine = sim.grids[sim.grids.length - 1];
  const b = gridBounds(fine);
  const widthKm = haversine(b.west, scenario.target.lat, b.east, scenario.target.lat) / 1000;
  view.flyTo(scenario.target.lon, scenario.target.lat, widthKm * 0.8, 38, coastBearing(), duration);
}

function setOverlay(o: OverlayMode): void {
  overlay = o;
  view?.setOverlay(o);
  document.querySelectorAll<HTMLButtonElement>('[data-overlay]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.overlay === o)));
  renderLegend();
}

function renderLegend(): void {
  const L = $('legend');
  if (overlay === 'maxDepth') {
    const rows: [string, string][] = [['0.5 m 미만', '#FAE673'], ['0.5–2 m', '#FA9E33'], ['2–5 m', '#E63D29'], ['5–10 m', '#AD2EC7'], ['10 m 이상', '#540F7A']];
    L.innerHTML = `<div>육지 최대 침수심</div><div class="grid">${rows.map(([t, c]) => `<div class="row"><i class="dot" style="background:${c}"></i>${t}</div>`).join('')}</div>`;
  } else if (overlay === 'arrival') {
    L.innerHTML = `<div>육지에 물이 처음 닿은 시각</div><div class="bar" style="background:linear-gradient(90deg,#FFED8C,#ED8038,#8C3373,#241C4D)"></div><div class="ends"><span>0</span><span>${fmtT(scenario.duration / 2)}</span><span>${fmtT(scenario.duration)}</span></div>`;
  } else if (overlay === 'speed') {
    L.innerHTML = `<div>육지 최대 유속</div><div class="bar" style="background:linear-gradient(90deg,#BFE6FA,#4DA6F2,#F2BF33,#D92626)"></div><div class="ends"><span>0</span><span>5 m/s</span><span>10 m/s</span></div>`;
  } else {
    L.innerHTML = '';
  }
}

function updateRunButton(): void {
  $('run').textContent = done ? '다시 계산' : running ? '일시정지' : '계속';
}

function speedCap(): number {
  const v = $<HTMLSelectElement>('speed').value;
  if (v === 'max') return Infinity;
  if (v === 'auto') return sim && sim.solver.levels[sim.finest].active ? 60 : Infinity;
  return +v;
}

function renderSimPanel(full: boolean): void {
  if (!sim) return;
  const s = scenario.source;
  if (full) {
    const where = scenario.target.name ?? fmtLonLat(scenario.target.lon, scenario.target.lat);
    const what = s.kind === 'quake'
      ? `규모 ${s.Mw.toFixed(1)} 해저 지진 (해저 융기 최대 ${fmtM(sim.initialUp)}, 침강 ${fmtM(-sim.initialDown)})`
      : `지름 ${s.diameter >= 1000 ? `${(s.diameter / 1000).toFixed(1)} km` : `${s.diameter} m`} 소행성 충돌 (공동 깊이 ${fmtM(-sim.initialDown)})`;
    $('simTitle').textContent = `${what}. 관측 해안: ${where}.`;
    $('gaugeNote').textContent = `관측 중심에서 가장 가까운 바다(${fmtLonLat(sim.gaugeLonLat[0], sim.gaugeLonLat[1])})의 수위입니다. 세밀 격자가 깨어난 뒤부터 기록합니다.`;
    view!.shared.uArrivalSpan.value = scenario.duration;
  }
  const st = sim.stats;
  $('stats').innerHTML = `<div>침수 면적<b>${st.areaKm2 >= 10 ? st.areaKm2.toFixed(0) : st.areaKm2.toFixed(2)} km²</b></div>
    <div>최대 침수심<b>${fmtM(st.maxDepth)}</b></div>
    <div>처오름 높이<b>${fmtM(st.maxRunup)}</b></div>
    <div>최대 내륙 침투<b>${st.maxInland > 0 ? fmtKm(st.maxInland) : '0 m'}</b></div>
    <div>육지 첫 침수<b>${st.firstLandArrival >= 0 ? `${fmtT(st.firstLandArrival)} 뒤` : '아직 없음'}</b></div>
    <div>앞바다 최대 수위<b>${fmtM(st.maxSeaLevel)}</b></div>`;
  $('levels').innerHTML = sim.solver.levels.map((lv, i) => {
    const g = lv.input.grid;
    const cell = cellSizeAtRow(g, g.ny >> 1);
    const name = i === 0 ? '바다 전체' : i === sim!.finest ? '관측 해안' : '중간';
    return `<li class="${lv.active ? 'on' : 'off'}"><span>${name} ${cell >= 1000 ? `${(cell / 1000).toFixed(1)} km` : `${Math.round(cell)} m`} · ${g.nx}×${g.ny}</span><span>${lv.active ? `${fmtInt(lv.steps)} 스텝` : '대기 중'}</span></li>`;
  }).join('');
}

function drawGauge(): void {
  const cv = $<HTMLCanvasElement>('gauge');
  const ctx = cv.getContext('2d')!;
  const W = cv.width, H = cv.height;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim(), muted = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim();
  ctx.clearRect(0, 0, W, H);
  const padL = 64, padR = 14, padT = 16, padB = 34;
  const data = sim?.gauge ?? [];
  let lo = -1, hi = 1;
  for (const d of data) { lo = Math.min(lo, d.eta); hi = Math.max(hi, d.eta); }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const T = scenario.duration;
  const X = (t: number): number => padL + ((W - padL - padR) * t) / T;
  const Y = (v: number): number => padT + ((H - padT - padB) * (hi - v)) / (hi - lo);
  ctx.font = '22px IBM Plex Sans KR, sans-serif';
  ctx.fillStyle = muted;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [lo + (hi - lo) * 0.08, 0, hi - (hi - lo) * 0.08]) {
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
    ctx.fillText(`${v.toFixed(Math.abs(v) >= 10 ? 0 : 1)} m`, padL - 8, Y(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const hours = T / 3600;
  for (let h = 0; h <= hours; h += hours > 4 ? 2 : 1) ctx.fillText(`${h}시간`, X(h * 3600), H - padB + 8);
  if (data.length > 1) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    data.forEach((d, i) => (i ? ctx.lineTo(X(d.t), Y(d.eta)) : ctx.moveTo(X(d.t), Y(d.eta))));
    ctx.stroke();
  }
}

function bindSim(): void {
  $('run').onclick = () => {
    if (!sim) return;
    if (done) { resetRun(); view?.viewOcean(1.2); running = true; }
    else running = !running;
    updateRunButton();
  };
  $('restart').onclick = () => { resetRun(); view?.viewOcean(1.2); running = true; updateRunButton(); renderSimPanel(false); };
  $('back').onclick = () => { running = false; setMode('setup'); };
  $('viewOcean').onclick = () => view?.viewOcean();
  $('viewCoast').onclick = () => flyToCoast(1.6);
  document.querySelectorAll<HTMLButtonElement>('[data-overlay]').forEach((b) => { b.onclick = () => setOverlay(b.dataset.overlay as OverlayMode); });
  $('exag').addEventListener('input', (e) => { if (view) view.exagUser = +(e.target as HTMLInputElement).value; $('exagv').textContent = `${(+(e.target as HTMLInputElement).value).toFixed(1)}배`; });
  $('boost').addEventListener('input', (e) => { if (view) view.boostUser = +(e.target as HTMLInputElement).value; $('boostv').textContent = `${(+(e.target as HTMLInputElement).value).toFixed(1)}배`; });
  $('exagv').textContent = '1.0배';
  $('boostv').textContent = '1.0배';
  $('tint').addEventListener('change', (e) => { if (view) view.tintOn = (e.target as HTMLInputElement).checked; });
  $('drape').addEventListener('change', (e) => void toggleDrape((e.target as HTMLInputElement).checked));
  $('share').onclick = () => {
    writeHash();
    void navigator.clipboard?.writeText(location.href).then(() => toast('이 시나리오의 링크를 복사했습니다.'), () => toast('링크를 복사하지 못했습니다. 주소창의 주소를 복사하세요.'));
  };
}

async function toggleDrape(on: boolean): Promise<void> {
  if (!sim || !view) return;
  const idx = sim.finest;
  if (!on) { view.setDrape(idx, null); return; }
  try {
    if (!drapeTex) {
      toast('관측 해안의 지도를 그리는 중입니다.', 2500);
      const canvas = await renderDrape(sim.grids[idx]);
      drapeTex = new THREE.CanvasTexture(canvas);
      drapeTex.colorSpace = THREE.NoColorSpace;
      drapeTex.anisotropy = 8;
    }
    view.setDrape(idx, drapeTex);
  } catch (e) {
    $<HTMLInputElement>('drape').checked = false;
    toast(`지도를 입히지 못했습니다. ${e instanceof Error ? e.message : ''}`);
  }
}

// ---------- 주소로 시나리오 공유 ----------

function writeHash(): void {
  const payload = { s: scenario.source, t: scenario.target, q: scenario.quality, n: scenario.manningLand, d: scenario.duration, b: cameraBearing };
  history.replaceState(null, '', `#${encodeURIComponent(JSON.stringify(payload))}`);
}

function readHash(): boolean {
  if (location.hash.length < 3) return false;
  try {
    const p = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (!p?.s?.kind || typeof p.t?.lon !== 'number') return false;
    scenario.source = p.s;
    scenario.target = p.t;
    if (p.q in QUALITIES) scenario.quality = p.q;
    if (typeof p.n === 'number') scenario.manningLand = p.n;
    if (typeof p.d === 'number') scenario.duration = p.d;
    cameraBearing = typeof p.b === 'number' ? p.b : null;
    if (p.s.kind === 'quake') quakeParams = scenario.source as QuakeParams;
    else impactParams = scenario.source as ImpactParams;
    activePreset = PRESETS.find((x) => JSON.stringify(x.source) === JSON.stringify(p.s) && x.target.lon === p.t.lon) ?? null;
    return true;
  } catch {
    return false;
  }
}

// ---------- 프레임 루프 ----------

let last = performance.now();
let lastPanel = 0, lastStats = 0, lastGauge = 0;

function frame(now: number): void {
  const dtWall = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (mode === 'sim' && sim && view) {
    const solver = sim.solver;
    if (running && !done) {
      // 프레임 시간이 길어지면 계산량을 줄이고, 여유가 있으면 늘린다
      if (dtWall > 0.045) budget *= 0.8;
      else if (dtWall < 0.03) budget *= 1.1;
      budget = Math.max(0.3, Math.min(600, budget));
      if (turboBudget > 0) budget = turboBudget; // 자동 테스트용: 프레임률을 무시하고 정해진 양을 돌린다
      const cap = speedCap();
      simClock = Math.min(simClock + cap * dtWall, solver.time + Math.max(cap * 0.25, 30), scenario.duration);
      if (!Number.isFinite(simClock)) simClock = scenario.duration;
      solver.advance(budget, simClock);
      if (solver.time >= scenario.duration) {
        done = true;
        running = false;
        updateRunButton();
        void sim.updateStats().then(() => renderSimPanel(false));
        setOverlay('maxDepth');
        if ($<HTMLInputElement>('autocam').checked) flyToCoast();
      }
      const fineActive = solver.levels[sim.finest].active;
      // 먼 발생원: 세밀 격자가 깨어나는 순간. 가까운 발생원: 관측 지점 수위가 움직이기 시작하는 순간.
      const g = sim.gauge;
      const moved = g.length > 1 && Math.abs(g[g.length - 1].eta - g[0].eta) > 0.25;
      if (!autoFlown && fineActive && (!fineWasActive || moved)) {
        autoFlown = true;
        if ($<HTMLInputElement>('autocam').checked) flyToCoast();
      }
      fineWasActive = fineActive;
      if (now - lastGauge > 120) { sim.sampleGauge(); lastGauge = now; }
      if (fineActive && now - lastStats > 1500) { void sim.updateStats(); lastStats = now; }
    }
    solver.prepareRender();
    view.render(dtWall, solver.time);
    if (now - lastPanel > 300) {
      lastPanel = now;
      $('clock').textContent = fmtT(solver.time);
      const fineActive = solver.levels[sim.finest].active;
      $('state').textContent = done ? '계산 완료' : !running ? '일시정지' : fineActive ? '관측 해안을 세밀하게 계산하는 중' : '파도가 바다를 건너는 중';
      $('prog').style.width = `${Math.min(100, (solver.time / scenario.duration) * 100)}%`;
      renderSimPanel(false);
      drawGauge();
    }
  }
  requestAnimationFrame(frame);
}

// ---------- 시작 ----------

bindSetup();
bindSim();
$('foot').textContent = `${provider.attribution}. ${BASEMAP_ATTRIBUTION}.`;
const fromHash = readHash();
syncControls();
refreshSetup();
if (!fromHash) applyPreset(PRESETS[0]);
else {
  const ext = sourceExtent(scenario.source);
  void picker.fitTo({
    west: Math.min(ext.west, scenario.target.lon) - 1, east: Math.max(ext.east, scenario.target.lon) + 1,
    south: Math.min(ext.south, scenario.target.lat) - 1, north: Math.max(ext.north, scenario.target.lat) + 1,
  });
}
requestAnimationFrame(frame);

const presetParam = PRESETS.find((p) => p.id === params.get('preset'));
if (presetParam) applyPreset(presetParam);
const qParam = params.get('quality');
if (qParam && qParam in QUALITIES) { scenario.quality = qParam as QualityName; syncControls(); refreshSetup(); }
if (params.get('autorun') === '1') void startSimulation();

// 자동 테스트와 디버깅용 창구
declare global {
  interface Window { __tsunami?: unknown }
}
window.__tsunami = {
  get mode() { return mode; },
  get sim() { return sim; },
  get view() { return view; },
  get running() { return running; },
  get done() { return done; },
  scenario,
  setOverlay,
  flyToCoast,
  start: startSimulation,
};
