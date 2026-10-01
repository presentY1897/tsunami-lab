import { initI18n, LocalizedError, t, th, text, html, attribute, formatNumber, formatClock, onLocaleChange, getLocale, escapeHtml } from './i18n';
import './style.css';
import { ChunkStore, chunksForBox, nearestChunks } from './data/chunks';
import { loadEarth, type EarthGrid } from './data/earth';
import { GLOBAL_FILE } from './data/layout';
import { decodeLines, splitLinesFile } from './data/lines-codec';
import { LineLayer } from './globe/lines';
import { CityLayer } from './globe/cities';
import { browserGunzip } from './data/chunks';
import { buildAdaptiveMesh, type AdaptiveMesh } from './globe/adaptive';
import { GlobeCamera } from './globe/camera';
import { GlobeRenderer } from './globe/renderer';
import { transientCraterDiameter, type ImpactParams } from './physics/impact';
import { latToPy, lonToPx, pxToLon, pyToLat } from './geo/mercator';
import { faultFromMagnitude, type QuakeParams } from './physics/quake';
import { lonLatToDir } from './globe/icosphere';
import { calibrateImpactGrid } from './sim/calibrate';
import { buildSourceModel, type SourceParams } from './sim/source';
import { autoStrike, buildGlobalGrid, buildLevelGrid, faultOutline, gainRefRadius, GLOBAL_ROW0, GLOBAL_ROWS, loadChunksFor, planSourceGrid, type GlobalGrid } from './sim/global';
import { NestedSolver, type LevelInput } from './sim/nested';
import type { GridInput, SolverOptions } from './sim/solver';
type SolverOptionsLite = Pick<SolverOptions, 'gainRef' | 'gainRelaxRef' | 'gainSrc'>;
import { planCoastChain, planGlobal, type LevelSpec } from './sim/plan';
import { FloodJudge, frontDelay } from './sim/judge';
import { Terrain } from './terrain/terrain';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 면 한 변이 화면에서 이 정도 크기(CSS px)로 보이게 나눈다. 기기가 느리면 이 값을 키워 면의 수를 줄인다. */
const BASE_EDGE_PX = 9;
const MAX_EDGE_PX = 24;
/** 가장 작은 삼각형의 변(km). 결정: 100 m. 실제로 어디까지 내려가는지는 기기 성능이 정한다. */
const MIN_EDGE_KM = 0.1;
const MAX_FACES = 70000;
/** 가장 작은 삼각형이 이보다 작아지면 10 km 조각을 받는다(km). 그보다 큰 면은 39 km 자료로 충분하다. */
const CHUNK_EDGE_KM = 30;
/** 메시를 다시 만드는 최소 간격(ms). 움직이는 동안 매 프레임 만들지 않는다. */
const REBUILD_INTERVAL_MS = 110;
/** 파도가 있을 때 수면 삼각형의 최대 변(km). 계산 격자 셀(39 km)의 두 배. 파장(약 300 km)에 삼각형 네 개 이상이 들어간다. */
const WAVE_EDGE_KM = 78;
/** 세밀 격자 안에서 수면 삼각형의 최대 변은 셀의 이 배수다. */
const FINE_EDGE_CELLS = 4;
/** 해안 격자가 깨어난 뒤 이만큼 지나면 잠든다(s). 침수는 첫 몇 시간에 일어난다. 계산량을 묶는다. */
const COAST_ACTIVE_S = 3 * 3600;
/** 받은 자료보다 잘게 그리고 있는지. 이때는 화면에 생성된 지형임을 밝힌다(결정 D-018 규칙 6). */
const DATA_RESOLUTION_KM = 10;

/** 발생원 미리보기 격자(D-042). 한 변의 셀 수와, 그리기가 요구하는 가장자리 여유. */
const PREVIEW_N = 96;
const PREVIEW_MARGIN = 10;
/** 시작 효과의 길이(ms). 지진 고리, 소행성 궤적, 충돌 섬광. */
const PULSE_MS = 1200;
const STREAK_MS = 1300;
const FLASH_MS = 700;
/** 계산의 상한(s). 파가 잦아들면 그 전에 멈춘다(D-040). 태평양을 두 번 건너는 시간이다. */
const SIM_MAX_S = 72 * 3600;
/** 잦아듦 판단: 전 지구와 발생원 격자의 젖은 셀에서 |수위|가 모두 이 아래면 멈춘다(m). 기록 문턱(0.02 m)보다 조금 높다. */
const QUIET_ETA_M = 0.1;
const QUIET_CHECK_MS = 10000;
/** 이 시각 전에는 잦아듦을 보지 않는다(s). 파가 아직 퍼지는 중이다. */
const QUIET_MIN_T_S = 3600;
/** 해안 칸의 처오름이 이 시간 동안 하나도 커지지 않으면 파가 새로 하는 일이 없다고 보고 멈춘다(s). */
const STALE_S = 6 * 3600;
/** 섭입대 지진의 전형적인 값. 화면에서는 규모와 방향만 고른다. */
const QUAKE_DEFAULTS = { dip: 14, rake: 90, topKm: 5, slipModel: 'tapered' } as const;
/** 소행성 지름 슬라이더(0..1)와 지름(m)의 변환. 로그 눈금이고 50 m에서 10 km까지다(D-035). */
const diamFromT = (t: number): number => Math.round(10 ** (1.699 + t * (4 - 1.699)) / 10) * 10;
const tFromDiam = (d: number): number => (Math.log10(d) - 1.699) / (4 - 1.699);
const fmtDiam = (d: number): string => (d >= 1000 ? `${formatNumber(d / 1000, 1)} km` : `${formatNumber(d)} m`);
/** 침수 통계를 다시 읽는 간격(ms). 해안 격자 기록 1 MB를 동기식으로 읽으므로 자주 하지 않는다. */
const STATS_INTERVAL_MS = 1500;
/** 경험식 판정(D-031)을 위해 발생원 격자(1 MB)와 전 지구 격자(8 MB)의 기록을 읽는 간격(ms). 계산이 멈추면 간격과 무관하게 바로 읽는다. */
const JUDGE_SOURCE_INTERVAL_MS = 2000;
const JUDGE_GLOBAL_INTERVAL_MS = 8000;
/** 실제 경계선(해안선, 국경). 110m은 첫 화면에서, 50m은 이보다 가까이 볼 때 받는다(km). */
const FINE_LINES_VIEW_KM = 2500;
const LINE_STYLE = {
  coast: { color: [1, 1, 1, 0.85] as [number, number, number, number], widthPx: 1.1, followTerrain: false },
  border: { color: [1, 0.96, 0.85, 0.45] as [number, number, number, number], widthPx: 0.8, followTerrain: true },
};
/** 보는 거리별로 선을 솎아내는 단계. [허용 오차(도), 화면 폭 최소, 최대(km)]. 점 간격이 픽셀보다 촘촘하면 띠가 겹쳐 뭉개진다. */
const LINE_LODS: Record<'110m' | '50m', [number, number, number][]> = {
  '110m': [[0.35, 7000, Infinity], [0.12, 2500, 7000], [0, 0, 2500]],
  '50m': [[0.03, 700, 2500], [0, 0, 700]],
};

const fmtInt = (v: number): string => formatNumber(v);
const fmtClock = formatClock;
const fmtLen = (km: number): string => (km >= 10 ? `${fmtInt(km)} km` : km >= 1 ? `${formatNumber(km, 1)} km` : `${formatNumber(Math.round(km * 100) * 10)} m`);
const fmtLonLat = (lon: number, lat: number): string =>
  `${formatNumber(Math.abs(lat), 3)}°${lat >= 0 ? 'N' : 'S'} ${formatNumber(Math.abs(lon), 3)}°${lon >= 0 ? 'E' : 'W'}`;

async function start(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('globe');
  const renderer = new GlobeRenderer(canvas);
  const camera = new GlobeCamera(canvas);
  const earth: EarthGrid = await loadEarth(import.meta.env.BASE_URL + GLOBAL_FILE);
  const chunks = new ChunkStore(import.meta.env.BASE_URL);
  const terrain = new Terrain(earth, chunks);

  // 실제 경계선. 지형은 면으로 둔 채, 실제 해안선과 국경을 선으로 겹친다. 만들어 낸 해안이 실제와 어긋난 곳이 그대로 보인다.
  const lines = new LineLayer(renderer.gl);
  let linesBytes = 0, fineLinesRequested = false;
  const loadLines = async (res: '110m' | '50m'): Promise<void> => {
    // 자료를 못 받아도 앱은 돈다. 경계선만 빠진다.
    const r = await fetch(`${import.meta.env.BASE_URL}data/boundaries-${res}.bin`).catch(() => null);
    if (!r || !r.ok) return;
    const file = new Uint8Array(await r.arrayBuffer());
    linesBytes += file.length;
    const { header, payload } = splitLinesFile(file);
    const decoded = decodeLines(header, await browserGunzip(payload));
    for (const [name, list] of decoded) {
      const st = LINE_STYLE[name as keyof typeof LINE_STYLE];
      if (!st) continue;
      for (const [tol, minKm, maxKm] of LINE_LODS[res]) lines.setLines(name, list, earth, st, tol, minKm, maxKm);
    }
    drawDirty = true;
  };
  void loadLines('110m');

  // 주요 도시. 점과 이름. 인구 30만 이상이거나 수도, 또는 해안의 10만 이상.
  const cities = new CityLayer(renderer.gl, $('labels'));
  let citiesBytes = 0;
  const loadCities = async (): Promise<void> => {
    const r = await fetch(`${import.meta.env.BASE_URL}data/cities.bin`).catch(() => null);
    if (!r || !r.ok) return;
    const file = new Uint8Array(await r.arrayBuffer());
    citiesBytes = file.length;
    const json = JSON.parse(new TextDecoder().decode(await browserGunzip(file))) as { cities: [string, number, number, number, number, string?][] };
    cities.setCities(json.cities.map(([name, lon, lat, popK, rank, nameEn]) => ({ name, lon, lat, popK, rank, nameEn })), earth);
    cities.setLocale(getLocale());
    drawDirty = true;
  };
  void loadCities();
  $('citiesToggle').addEventListener('click', () => {
    cities.visible = !cities.visible;
    $('citiesToggle').setAttribute('aria-pressed', String(cities.visible));
    drawDirty = true;
  });
  // 파도 높이 그리기 방식(D-032). 브라우저에 기억한다.
  const setWaveScale = (mode: 'real' | 'coastReal' | 'boost'): void => {
    renderer.waveScaleMode = mode;
    document.querySelectorAll<HTMLButtonElement>('[data-wavescale]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wavescale === mode)));
    try { localStorage.setItem('waveScale', mode); } catch { /* 무시 */ }
    drawDirty = true;
  };
  document.querySelectorAll<HTMLButtonElement>('[data-wavescale]').forEach((b) => b.addEventListener('click', () => setWaveScale(b.dataset.wavescale as 'real' | 'coastReal' | 'boost')));
  $('floodToggle').addEventListener('click', () => {
    renderer.floodOn = !renderer.floodOn;
    $('floodToggle').setAttribute('aria-pressed', String(renderer.floodOn));
    drawDirty = true;
  });
  $('viewReset').addEventListener('click', () => camera.resetView());

  // 패널 접기와 끌어 옮기기. 손잡이 줄을 끌면 옮겨지고, 접으면 시계와 상태 한 줄만 남는다. 위치는 브라우저에 기억한다.
  const sheet = $('sheet'), sheetHead = $('sheetHead');
  let sheetPos: [number, number] | null = null;
  const placeSheet = (): void => {
    if (!sheetPos) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.bottom = ''; sheet.style.transform = ''; return; }
    const r = sheet.getBoundingClientRect();
    const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, sheetPos[0])), y = Math.max(4, Math.min(window.innerHeight - 48, sheetPos[1]));
    sheet.style.left = `${x}px`; sheet.style.top = `${y}px`; sheet.style.bottom = 'auto'; sheet.style.transform = 'none';
  };
  try {
    const saved = localStorage.getItem('sheetPos');
    if (saved) { const v = JSON.parse(saved) as [number, number]; if (Array.isArray(v) && v.length === 2) sheetPos = v; }
    if (localStorage.getItem('sheetCollapsed') === '1') { sheet.classList.add('collapsed'); text('sheetToggle', () => t('panel.expand')); $('sheetToggle').setAttribute('aria-expanded', 'false'); }
  } catch { /* 저장소가 막혀 있어도 동작한다 */ }
  placeSheet();
  window.addEventListener('resize', placeSheet);
  let sheetDrag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
  sheetHead.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = sheet.getBoundingClientRect();
    sheetDrag = { x: e.clientX, y: e.clientY, ox: r.left, oy: r.top, moved: false };
    sheetHead.setPointerCapture(e.pointerId);
  });
  sheetHead.addEventListener('pointermove', (e) => {
    if (!sheetDrag) return;
    const dx = e.clientX - sheetDrag.x, dy = e.clientY - sheetDrag.y;
    if (!sheetDrag.moved && Math.hypot(dx, dy) < 4) return;
    sheetDrag.moved = true;
    sheetPos = [sheetDrag.ox + dx, sheetDrag.oy + dy];
    placeSheet();
  });
  const endSheetDrag = (): void => {
    if (!sheetDrag) return;
    if (sheetDrag.moved) { try { localStorage.setItem('sheetPos', JSON.stringify(sheetPos)); } catch { /* 무시 */ } }
    sheetDrag = null;
  };
  sheetHead.addEventListener('pointerup', endSheetDrag);
  sheetHead.addEventListener('pointercancel', endSheetDrag);
  const setCollapsed = (collapsed: boolean): void => {
    sheet.classList.toggle('collapsed', collapsed);
    text('sheetToggle', () => t(collapsed ? 'panel.expand' : 'panel.collapse'));
    $('sheetToggle').setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('sheetCollapsed', collapsed ? '1' : '0'); } catch { /* 무시 */ }
    placeSheet();
  };
  $('sheetToggle').addEventListener('click', () => setCollapsed(!sheet.classList.contains('collapsed')));
  sheetHead.addEventListener('dblclick', () => { sheetPos = null; placeSheet(); try { localStorage.removeItem('sheetPos'); } catch { /* 무시 */ } });
  $('linesToggle').addEventListener('click', () => {
    lines.visible = !lines.visible;
    $('linesToggle').setAttribute('aria-pressed', String(lines.visible));
    drawDirty = true;
  });

  let edgePx = BASE_EDGE_PX;
  let mesh: AdaptiveMesh | null = null;
  let meshDirty = true;
  let drawDirty = true;
  const designQuery = new URLSearchParams(location.search);
  const designButton = document.createElement('button');
  designButton.type = 'button';
  designButton.className = 'toggle';
  const setDesignStyle = (style: 'color' | 'wireframe'): void => {
    renderer.designStyle = style;
    text(designButton, () => t(style === 'wireframe' ? 'view.wire' : 'view.color'));
    designButton.setAttribute('aria-pressed', String(style === 'wireframe'));
    attribute(designButton, 'title', () => t(style === 'wireframe' ? 'view.toColor' : 'view.toWire'));
    drawDirty = true;
  };
  setDesignStyle(designQuery.get('style') === 'wireframe' ? 'wireframe' : 'color');
  document.querySelector('.view-options')!.prepend(designButton);
  designButton.addEventListener('click', () => {
    setDesignStyle(renderer.designStyle === 'color' ? 'wireframe' : 'color');
  });
  let lastBuild = 0;
  let picked: [number, number] | null = null;
  let builds = 0, buildMsTotal = 0;

  /** 깨어 있는 가장 세밀한 격자의 상자와, 그 안에서 쓸 최대 변. */
  const fineBox = (): { west: number; east: number; south: number; north: number; km: number } | undefined => {
    if (!solver) return undefined;
    for (let i = specs.length - 1; i >= 1; i--) {
      if (!solver.levels[i].active) continue;
      const sp = specs[i];
      const cellKm = (40075 / (256 * 2 ** sp.zoom)) * Math.cos((((sp.south + sp.north) / 2) * Math.PI) / 180);
      return { west: sp.west, east: sp.east, south: sp.south, north: sp.north, km: (FINE_EDGE_CELLS * cellKm * edgePx) / BASE_EDGE_PX };
    }
    return undefined;
  };

  const rebuild = (now: number): void => {
    meshDirty = false;
    lastBuild = now;
    for (let attempt = 0; attempt < 6; attempt++) {
      const m = buildAdaptiveMesh(terrain, {
        eye: camera.eye, right: camera.basis.right, up: camera.basis.up, forward: camera.basis.forward,
        halfFovX: camera.halfFovX, halfFovY: camera.halfFovY, pxPerRad: camera.pxPerRad, width: camera.width, height: camera.height,
        origin: camera.target, targetPx: edgePx, minEdgeKm: MIN_EDGE_KM, maxFaces: MAX_FACES,
        // 파도가 있는 동안은 수면을 파장보다 잘게 나눈다. 기기가 느려 면을 키운 만큼 이것도 같이 키운다.
        extraSplitKm: solver || preview ? (WAVE_EDGE_KM * edgePx) / BASE_EDGE_PX : Infinity,
        extraSplitFine: fineBox(),
        floodBox: solver ? specs.find((sp) => sp.role === 'coast') : undefined,
        judge: judgeView(),
      });
      if (!m) {
        // 면이 너무 많다. 크게 나눠 다시 만든다. 끝내 못 만들면 다음 차례에 다시 시도한다.
        edgePx = Math.min(MAX_EDGE_PX, edgePx * 1.25);
        meshDirty = true;
        continue;
      }
      meshDirty = false;
      mesh = m;
      renderer.setMesh(m);
      builds++;
      buildMsTotal += m.buildMs;
      // 기기 성능에 맞춘다. 만드는 데 오래 걸리면 면을 키우고, 여유가 있으면 기준 크기로 되돌린다.
      if (m.buildMs > 55) edgePx = Math.min(MAX_EDGE_PX, edgePx * 1.12);
      else if (m.buildMs < 22 && edgePx > BASE_EDGE_PX) edgePx = Math.max(BASE_EDGE_PX, edgePx * 0.94);
      break;
    }
    drawDirty = true;
  };

  /** 보는 곳의 10 km 조각을 받는다. 도착하면 지형이 세밀해지므로 메시를 다시 만든다. */
  const requestChunks = (): void => {
    if (!mesh || mesh.minEdgeKm > CHUNK_EDGE_KM) return;
    // 비스듬히 볼 때는 지평선 쪽으로 더 멀리 보인다
    const half = Math.min(25, ((camera.viewWidthKm * (1 + 2 * Math.sin(camera.tilt))) / 111) * 0.6 + 0.5);
    const halfLon = Math.min(60, half / Math.max(0.25, Math.cos((camera.lat * Math.PI) / 180)));
    const norm = (l: number): number => ((((l + 180) % 360) + 360) % 360) - 180;
    const list = chunksForBox(norm(camera.lon - halfLon), Math.max(-84, camera.lat - half), norm(camera.lon + halfLon), Math.min(84, camera.lat + half));
    // 한 화면에 여섯 개까지만 받는다(받는 양을 묶는다). 넓게 볼 때 화면 가운데가 빠지지 않도록 가까운 것부터 고른다
    for (const [x, y] of nearestChunks(list, camera.lon, camera.lat, 6)) if (!chunks.peek(x, y)) void chunks.load(x, y);
  };
  chunks.onLoad = () => { terrain.refresh(); meshDirty = true; };

  const resize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.resize(w, h, Math.min(window.devicePixelRatio || 1, 2.5));
    // 가장 가까이 갔을 때 가장 작은 삼각형이 기준 크기로 보이게 한다
    camera.minViewKm = MIN_EDGE_KM * (Math.min(w, h) / BASE_EDGE_PX);
    camera.resize(w, h);
    meshDirty = true;
  };
  window.addEventListener('resize', resize);
  resize();

  // ---------- 발생원과 계산 ----------
  /** 발생원의 위치. 바다를 누르면 정해진다. */
  let srcPos: [number, number] | null = null;
  /** 발생원 자리의 지형 높이(m, 바다는 음수). 소행성 공동은 수심이 제한한다. */
  let srcDepth = -4000;
  let kind: 'quake' | 'impact' = 'quake';
  const initialFault = faultFromMagnitude(9, QUAKE_DEFAULTS.dip, QUAKE_DEFAULTS.topKm);
  const quakeP = { Mw: 9.0, strike: 0, dimensions: { lengthKm: initialFault.L / 1000, widthKm: initialFault.W / 1000 } };
  const impactP = { diameter: 500, velocity: 20, density: 3000 };
  const currentSource = (): SourceParams | null => {
    if (!srcPos) return null;
    const [lon, lat] = srcPos;
    return kind === 'quake' ? { kind: 'quake', lon, lat, ...quakeP, ...QUAKE_DEFAULTS } : { kind: 'impact', lon, lat, ...impactP, angle: 45 };
  };
  let outline: [number, number][] | null = null;
  /** 발생원 미리보기의 텍스처(D-042). 계산이 시작되면 지운다. */
  let preview: WebGLTexture[] | null = null;
  let previewTimer = 0;
  /** 시작 효과의 시각(performance.now 기준). 0이면 없음. */
  let pulseUntil = 0, streakStart = 0, flashUntil = 0, startAt = 0;
  let solver: NestedSolver | null = null;
  let globalGrid: GlobalGrid | null = null;
  /** 계산 격자 단계들. 0번은 전 지구. */
  let specs: LevelSpec[] = [];
  let starting = false;
  /** 침수를 볼 해안. */
  let coast: [number, number] | null = null;
  let pickMode: 'source' | 'coast' = 'source';
  /** 경험식 침수 판정. 계산이 도는 동안 큰 격자의 기록으로 갱신한다. */
  let judge: FloodJudge | null = null;
  let lastJudgeSource = 0, lastJudgeGlobal = 0, judgeVersionDrawn = 0;
  /** 판정과 통계가 마지막으로 반영한 계산 시각(s). 계산이 멈췄을 때 이 값이 현재 시각과 다르면 뒤처진 것이다. */
  let judgedSourceT = 0, judgedGlobalT = 0, statsT = 0;
  const judgeView = () => (judge && judge.any ? { runupNear: (lon: number, lat: number) => judge!.runupNear(lon, lat), inlandLimit: (r: number) => judge!.limitOf(r), frontDelay, maxLimitKm: () => judge!.maxLimitKm(), bigSources: () => judge!.bigSources() } : undefined);
  let running = false;
  let impactLanded = false;
  /** 계산이 끝난 이유. 잦아듦, 상한, 아직 아님. */
  let finished: '' | 'quiet' | 'stale' | 'max' = '';
  let lastQuiet = 0;
  let speed = 120; // 1초에 흐르는 시간(s). 기본 2분이라 초반이 보인다(D-043)
  /** 시간 슬라이더로 옮기는 중인가. 목표 시각에 닿으면 멈춘다. */
  let seeking = false;
  let speedBeforeSeek = 120;
  let tlDragging = false;
  let timelineMax = 0;
  /** 판정을 다시 만들 때 필요한 것. 시간을 되감으면 기록이 지워지므로 판정도 새로 만든다. */
  let judgeGrids: GridInput[] | null = null;
  let judgePeriod = Infinity;
  let simClock = 0;
  let stepBudget = 4;
  let stopAt = Infinity; // 자동 검사용: 이 시각에서 멈춘다

  const showSource = (): void => {
    const src = currentSource();
    if (!src) return;
    $('kindQuake').setAttribute('aria-pressed', String(kind === 'quake'));
    $('kindImpact').setAttribute('aria-pressed', String(kind === 'impact'));
    $('quakeFields').hidden = kind !== 'quake';
    $('impactFields').hidden = kind !== 'impact';
    if (src.kind === 'quake') {
      const f = faultOutline(src);
      outline = f.outline;
      text('mwv', () => `M${formatNumber(src.Mw, 1)}`);
      text('strikev', () => `${fmtInt(src.strike)}°`);
      $<HTMLInputElement>('mw').value = String(src.Mw);
      $<HTMLInputElement>('strike').value = String(Math.round(src.strike));
      text('faultinfo', () => t('quake.fault', {
        length: fmtInt(f.fault.L / 1000), width: fmtInt(f.fault.W / 1000), slip: formatNumber(f.fault.meanSlip, 1),
        note: src.Mw > 9.5 ? t('quake.virtualNote') : '',
      }));
    } else {
      $<HTMLInputElement>('diam').value = String(tFromDiam(src.diameter));
      text('diamv', () => fmtDiam(src.diameter));
      $<HTMLInputElement>('vel').value = String(src.velocity);
      text('velv', () => `${fmtInt(src.velocity)} km/s`);
      $<HTMLSelectElement>('rho').value = String(src.density);
      const mass = (Math.PI / 6) * src.diameter ** 3 * src.density, mt = (0.5 * mass * (src.velocity * 1000) ** 2) / 4.184e15;
      // 크레이터와 기준 거리 파고(Ward & Asphaug 1/r). 충돌 지점 수심이 공동 깊이를 제한한다. 재질과 속도를 바꿀 때 무엇이 달라지는지 바로 읽힌다.
      const depth = Math.max(1, -srcDepth);
      const Dtc = transientCraterDiameter(src), Arw = Math.min(Dtc / 14.1, depth), rKm = Math.max(200, Math.ceil(Dtc / 1000 / 100) * 100);
      const ampRef = (Arw * 0.75 * Dtc) / (rKm * 1000);
      const huge = Dtc / 14.1 > depth * 2;
      // 물속 크레이터의 원. 지진의 단층 상자와 같은 자리의 표현이다(D-042)
      const rLat = Dtc / 2 / 111195, rLon = rLat / Math.max(0.2, Math.cos((src.lat * Math.PI) / 180));
      outline = Array.from({ length: 48 }, (_, k) => { const a = (2 * Math.PI * k) / 48; return [src.lon + rLon * Math.sin(a), src.lat + rLat * Math.cos(a)] as [number, number]; });
      text('faultinfo', () => t('impact.fault', {
        energy: mt >= 1000 ? `${fmtInt(mt / 1000)} Gt` : `${fmtInt(mt)} Mt`,
        crater: `${Dtc >= 10000 ? fmtInt(Dtc / 1000) : formatNumber(Dtc / 1000, 1)} km`,
        distance: fmtInt(rKm), amplitude: ampRef >= 100 ? fmtInt(ampRef) : formatNumber(ampRef, 1), note: huge ? t('impact.huge') : '',
      }));
    }
    schedulePreview();
    drawDirty = true;
  };

  /** 미리보기를 지운다. 계산 중이 아니면 파도 그리기도 끈다. */
  const clearPreview = (): void => {
    clearTimeout(previewTimer);
    if (preview) { for (const t of preview) renderer.deleteTexture(t); preview = null; }
    if (!solver) { renderer.wave = null; drawDirty = true; }
  };
  /**
   * 발생원 미리보기(D-042). 지진의 초기 수면 변위를 작은 격자에 담아
   * 파도 그리기 경로로 넘긴다. 운석은 충돌 전 수면을 잔잔하게 두고 위치·크레이터 원만 표시한다. 솟는 곳은 따뜻한 색, 가라앉는 곳은 찬 색으로 보인다. 지진의 Okada 계산은 96² 격자에 약 0.2초라 슬라이더가 멈춘 뒤에 한다.
   */
  const buildPreview = (): void => {
    clearPreview();
    const src = currentSource();
    if (!src || solver || src.kind === 'impact') return;
    const model = buildSourceModel(src, Math.max(1, -srcDepth), 0);
    if (!model) return;
    const cosLat = Math.max(0.2, Math.cos((src.lat * Math.PI) / 180));
    const inner = PREVIEW_N - 2 * PREVIEW_MARGIN;
    const reachM = model.fieldFor(8000).reachKm * 1000;
    const zoom = Math.max(2, Math.min(12, Math.round(Math.log2((40075016.686 * cosLat) / (256 * Math.max(1000, (2 * reachM) / inner))))));
    const world = 256 * 2 ** zoom, cellM = (40075016.686 * cosLat) / world;
    const field = model.fieldFor(cellM);
    const px0 = Math.round(lonToPx(src.lon, zoom) - PREVIEW_N / 2), py0 = Math.round(latToPy(src.lat, zoom) - PREVIEW_N / 2);
    const state = new Float32Array(PREVIEW_N * PREVIEW_N * 4), bed = new Float32Array(PREVIEW_N * PREVIEW_N * 4);
    let maxAbs = 0;
    for (let j = 0; j < PREVIEW_N; j++) for (let i = 0; i < PREVIEW_N; i++) {
      const lon = pxToLon(px0 + i + 0.5, zoom), lat = pyToLat(py0 + j + 0.5, zoom), k = (j * PREVIEW_N + i) * 4;
      const e = terrain.base(lon, lat, Math.max(8, cellM / 1000));
      bed[k] = e;
      if (e >= 0) { state[k] = e; continue; } // 육지는 마른 셀
      const uz = field.uz(lon, lat);
      state[k] = uz;
      if (Math.abs(uz) > maxAbs) maxAbs = Math.abs(uz);
    }
    // 그리기는 0단계를 전 지구 격자로 여긴다. 수위 0인 1×1 격자를 두어 미리보기 밖이 잔잔하게 한다
    preview = [
      renderer.makeTexture(1, 1, new Float32Array([0, 0, 0, 0])), renderer.makeTexture(1, 1, new Float32Array([-4000, 0, 0, 0])),
      renderer.makeTexture(PREVIEW_N, PREVIEW_N, state), renderer.makeTexture(PREVIEW_N, PREVIEW_N, bed),
    ];
    renderer.wave = {
      levels: [
        { state: preview[0], bed: preview[1], size: [1, 1], px0: 0, py0: 0, world: 1, gainRef: 0 },
        { state: preview[2], bed: preview[3], size: [PREVIEW_N, PREVIEW_N], px0, py0, world, gainRef: 0 },
      ],
      refAmp: Math.max(0.5, maxAbs),
      srcDir: lonLatToDir(src.lon, src.lat),
    };
    meshDirty = true;
    drawDirty = true;
  };
  const schedulePreview = (): void => {
    clearTimeout(previewTimer);
    if (kind === 'impact') { clearPreview(); return; }
    previewTimer = window.setTimeout(buildPreview, 200);
  };

  /** 시간을 되감을 때. 계산과 기록이 처음으로 돌아가므로 판정도 새로 만든다. */
  const resetJudge = (): void => {
    if (!judgeGrids) return;
    judge = new FloodJudge(judgeGrids, judgePeriod);
    lastJudgeSource = lastJudgeGlobal = 0;
    judgedSourceT = judgedGlobalT = statsT = 0;
    judgeVersionDrawn = 0;
    meshDirty = true;
  };
  /** 시각 0에서 재생을 시작한다. 시작 효과(D-042)와 함께 흐른다. */
  const beginRun = (): void => {
    const q = currentSource();
    if (!q) return;
    if (q.kind === 'impact') { impactLanded = false; streakStart = performance.now(); startAt = streakStart + STREAK_MS; }
    else { running = true; pulseUntil = performance.now() + PULSE_MS; }
  };
  /** 시간 슬라이더로 옮긴다(D-043). 앞이면 그 시각까지 최대 속도로, 뒤면 처음부터 다시 계산해 그 시각에서 멈춘다. */
  const seekTo = (t: number): void => {
    if (!solver) return;
    if (t < solver.t) { solver.reset(); simClock = 0; resetJudge(); $('stats').innerHTML = ''; }
    finished = '';
    impactLanded = t > 0;
    startAt = 0; streakStart = 0; flashUntil = 0;
    if (!seeking) speedBeforeSeek = speed;
    seeking = true; stopAt = t; speed = Infinity; running = true;
    drawDirty = true;
  };
  /** 화면의 재생 상태를 맞춘다. 재생 단추, 시계, 상태 글, 시간 슬라이더. */
  const syncSimUi = (): void => {
    if (!solver) return;
    const time = solver.t;
    $('clock').textContent = fmtClock(time);
    const state = seeking ? t('sim.seeking', { time: fmtClock(stopAt) }) : finished === 'quiet' ? t('sim.quiet') : finished === 'stale' ? t('sim.stale') : finished === 'max' ? t('sim.max') : running || startAt ? t('sim.running') : time < solver.dt ? t('sim.ready') : t('action.pause');
    $('simstate').textContent = state;
    $('sheetMini').textContent = `${fmtClock(time)} · ${state}`;
    $('play').textContent = finished ? '↻' : running || startAt ? '❚❚' : '▶';
    $('playMini').textContent = $('play').textContent;
    $('playMini').hidden = false;
    $('play').setAttribute('aria-label', finished ? t('action.restart') : running || startAt ? t('action.pauseLabel') : t('action.play'));
    $('playMini').setAttribute('aria-label', $('play').getAttribute('aria-label')!);
    // 슬라이더의 끝은 6시간 단위로 늘고, 끝나면 멈춘 시각이다
    const end = finished ? Math.ceil(time / 60) * 60 : Math.max(6 * 3600, Math.ceil((time + 1) / (6 * 3600)) * 6 * 3600);
    if (end !== timelineMax) { timelineMax = end; const tl = $<HTMLInputElement>('timeline'); tl.max = String(end); }
    $('timelineEnd').textContent = fmtClock(end);
    if (!tlDragging) $<HTMLInputElement>('timeline').value = String(Math.round(time));
  };
  let urlTimer = 0;
  /** 시나리오를 주소에 적는다. 위치, 종류, 값, 고른 해안. 그 주소를 열면 같은 발생원이 놓인다(D-043). */
  const writeUrl = (): void => {
    clearTimeout(urlTimer);
    const src = currentSource();
    const u = new URL(location.href);
    u.searchParams.set('lang', getLocale());
    if (terrain.seaLevel) u.searchParams.set('sea', String(terrain.seaLevel));
    else u.searchParams.delete('sea');
    for (const k of ['lon', 'lat', 'kind', 'mw', 'strike', 'fl', 'fw', 'diam', 'vel', 'rho', 'coast']) u.searchParams.delete(k);
    if (src) {
      u.searchParams.set('lon', src.lon.toFixed(3)); u.searchParams.set('lat', src.lat.toFixed(3)); u.searchParams.set('kind', src.kind);
      if (src.kind === 'quake') { u.searchParams.set('mw', src.Mw.toFixed(1)); u.searchParams.set('strike', String(Math.round(src.strike)));
        if (src.dimensions) { u.searchParams.set('fl', String(src.dimensions.lengthKm)); u.searchParams.set('fw', String(src.dimensions.widthKm)); }
      }
      else { u.searchParams.set('diam', String(src.diameter)); u.searchParams.set('vel', String(src.velocity)); u.searchParams.set('rho', String(src.density)); }
      if (coast) u.searchParams.set('coast', `${coast[0].toFixed(3)},${coast[1].toFixed(3)}`);
    }
    // Safari는 30초에 100번 넘게 부르면 예외를 던진다. 주소를 못 적어도 앱은 돈다
    try { history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash); } catch { /* 무시 */ }
  };
  /** 슬라이더처럼 연달아 바뀌는 값은 멈춘 뒤에 한 번만 주소에 적는다. */
  const scheduleUrl = (): void => { clearTimeout(urlTimer); urlTimer = window.setTimeout(writeUrl, 250); };
  const readUrl = (): void => {
    const q = new URLSearchParams(location.search);
    setSeaLevel(Number(q.get('sea')), false);
    const lon = Number(q.get('lon')), lat = Number(q.get('lat'));
    if (!q.has('lon') || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
    kind = q.get('kind') === 'impact' ? 'impact' : 'quake';
    if (q.has('mw')) {
      const control = $<HTMLInputElement>('mw');
      quakeP.Mw = Math.max(Number(control.min), Math.min(Number(control.max), Number(q.get('mw')) || 9));
    }
    // 크기가 없는 기존 링크는 당시 경험식 크기로 복원한 뒤 고정한다.
    const legacyFault = faultFromMagnitude(quakeP.Mw, QUAKE_DEFAULTS.dip, QUAKE_DEFAULTS.topKm);
    const fl = Number(q.get('fl')), fw = Number(q.get('fw'));
    quakeP.dimensions = Number.isFinite(fl) && Number.isFinite(fw) && fl > 0 && fl <= 10000 && fw > 0 && fw <= 1000
      ? { lengthKm: fl, widthKm: fw }
      : { lengthKm: legacyFault.L / 1000, widthKm: legacyFault.W / 1000 };
    if (q.has('diam')) impactP.diameter = Math.max(50, Math.min(10000, Number(q.get('diam')) || 500));
    if (q.has('vel')) impactP.velocity = Math.max(11, Math.min(40, Number(q.get('vel')) || 20));
    if (q.has('rho')) impactP.density = [1000, 3000, 7800].includes(Number(q.get('rho'))) ? Number(q.get('rho')) : 3000;
    const c = q.get('coast')?.split(',').map(Number);
    if (c && c.length === 2 && c.every(Number.isFinite)) coast = [c[0], c[1]];
    camera.jumpTo(lon, lat, camera.altMin * (1500 / camera.minViewKm));
    placeSource(lon, lat, q.has('strike') ? Number(q.get('strike')) : null);
    showCoast();
  };

  const stopSim = (): void => {
    impactLanded = false;
    startAt = 0; streakStart = 0; flashUntil = 0;
    solver?.dispose();
    solver = null;
    finished = '';
    $('playMini').hidden = true;
    globalGrid = null;
    specs = [];
    judge = null;
    renderer.wave = null;
    running = false;
    $('simPanel').hidden = true;
    meshDirty = true;
    drawDirty = true;
  };

  const startSim = async (): Promise<void> => {
    const q = currentSource();
    if (!q || starting) return;
    starting = true;
    // 준비하는 동안 발생원을 바꾸면 계산과 화면·주소가 어긋난다. 발생원 패널과 수위 조절을 잠근다
    $('quakePanel').inert = true;
    $<HTMLInputElement>('seaLevel').disabled = true;
    $<HTMLInputElement>('seaLevelValue').disabled = true;
    $<HTMLButtonElement>('seaLevelReset').disabled = true;
    try {
      stopSim();
      // 격자 단계: 전 지구, 발생원 주변, 그리고 해안을 골랐으면 그 해안까지의 사슬
      const plan: LevelSpec[] = [planGlobal(GLOBAL_ROW0, GLOBAL_ROWS), planSourceGrid(q)];
      if (coast) plan.push(...planCoastChain(plan, coast[0], coast[1]));
      // 필요한 10 km 조각을 먼저 받는다. 발생원 주변 4개, 해안 쪽 최대 8개.
      const received = await loadChunksFor(chunks, plan.slice(1));
      terrain.refresh();
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      // 소행성은 충돌 지점의 수심이 공동 크기를 정한다. 원거리 보정의 기준 거리는 모든 단계가 같이 쓴다.
      const depth = -terrain.base(q.lon, q.lat, 8);
      const model = buildSourceModel(q, depth, q.kind === 'impact' ? gainRefRadius(q.lat) : 0);
      if (!model) {
        html('readout', () => th('impact.shallow', { depth: fmtInt(Math.max(0, depth)) }));
        return;
      }
      const srcDir = lonLatToDir(q.lon, q.lat);
      const gainOf = (sp: LevelSpec): Partial<SolverOptionsLite> => {
        if (!model.gainRef) return {};
        const uncorrected = sp.role === 'global' || sp.role === 'source';
        const parentUncorrected = sp.parent >= 0 && (plan[sp.parent].role === 'global' || plan[sp.parent].role === 'source');
        return { gainRef: uncorrected ? model.gainRef : 0, gainRelaxRef: parentUncorrected && !uncorrected ? model.gainRef : 0, gainSrc: srcDir };
      };
      const built = buildGlobalGrid(earth, model, terrain.seaLevel);
      const inputs: LevelInput[] = [{ grid: built.grid.input, parent: -1, options: gainOf(plan[0]) }];
      let maxUp = built.source.maxUp;
      for (const sp of plan.slice(1)) {
        const lv = buildLevelGrid(terrain, sp, model);
        maxUp = Math.max(maxUp, lv.maxUp);
        inputs.push({ grid: lv.input, parent: sp.parent, maxActiveS: sp.role === 'coast' || sp.role === 'bridge' ? COAST_ACTIVE_S : undefined, options: gainOf(sp) });
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      }
      // 소행성: 보정 안 된 두 격자(전 지구, 발생원)의 공동 진폭을 실제 격자에서 재서 맞춘다
      let calNote = (): string => '';
      if (model.impact) {
        const cal = [0, 1].map((idx) => calibrateImpactGrid(renderer.gl, inputs[idx].grid, model.impact!));
        calNote = () => t('impact.calibration', { source: formatNumber(cal[1].gain, 1), global: formatNumber(cal[0].gain, 1) });
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      }
      solver = new NestedSolver(renderer.gl, inputs);
      clearPreview();
      globalGrid = built.grid;
      specs = plan;
      // 경험식 판정은 발생원 격자를 먼저, 그 밖은 전 지구 격자로 본다
      // 파의 주기: 지진은 단층 너비의 두 배, 소행성은 공동 지름의 두 배를 발생원 수심의 파속으로 나눈 것. 침수 한계 거리를 묶는다(D-039).
      const cSrc = Math.sqrt(9.81 * Math.max(depth, 50));
      let periodS: number;
      if (model.impact) periodS = (2 * model.impact.craterDiameter) / Math.sqrt(9.81 * Math.max(model.impact.waterDepth, 50));
      else {
        const o = (model.outline ?? []).map(([lo, la]) => lonLatToDir(lo, la));
        const dist = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 6371000;
        const W = o.length === 4 ? Math.min(dist(o[0], o[1]), dist(o[1], o[2])) : 100000;
        periodS = (2 * W) / cSrc;
      }
      judge = new FloodJudge([inputs[1].grid, inputs[0].grid], periodS);
      lastJudgeSource = lastJudgeGlobal = 0;
      judgedSourceT = judgedGlobalT = statsT = 0;
      judgeVersionDrawn = 0;
      renderer.wave = {
        levels: solver.levels.map((lv, i) => ({
          state: lv.stateTexture, bed: lv.bedTexture, size: [lv.grid.nx, lv.grid.ny], px0: lv.grid.px0, py0: lv.grid.py0, world: lv.grid.world,
          gainRef: plan[i].role === 'global' || plan[i].role === 'source' ? model.gainRef : 0,
        })),
        refAmp: q.kind === 'impact' ? model.refAmp : Math.max(0.5, maxUp, -built.source.maxDown),
        srcDir,
      };
      const ci = plan.findIndex((sp) => sp.role === 'coast');
      if (ci >= 0) {
        const lv = solver.levels[ci];
        renderer.wave.flood = { record: lv.recordTexture, bed: lv.bedTexture, size: [lv.grid.nx, lv.grid.ny], px0: lv.grid.px0, py0: lv.grid.py0, world: lv.grid.world };
      }
      $('floodToggle').hidden = false;
      lastStats = 0;
      $('stats').hidden = false;
      $('stats').innerHTML = '';
      simClock = 0;
      judgeGrids = [inputs[1].grid, inputs[0].grid];
      judgePeriod = periodS;
      // 시각 0에서 멈춘 채 시작한다(D-043). 재생을 누르면 시작 효과(D-042)와 함께 흐른다. 초반이 보이도록 발생원을 화면에 잡고 패널은 접는다
      running = false;
      seeking = false;
      timelineMax = 0;
      $('quakePanel').hidden = true;
      $('simPanel').hidden = false;
      const src = plan[1], srcCell = Math.round((40075 / (256 * 2 ** src.zoom)) * Math.cos((q.lat * Math.PI) / 180));
      const hasCoast = coast !== null;
      html('readout', () => q.kind === 'quake'
        ? th('quake.summary', { magnitude: formatNumber(q.Mw, 1), virtual: q.Mw > 9.5 ? t('quake.virtual') : '', location: fmtLonLat(q.lon, q.lat), uplift: formatNumber(maxUp, 1) })
        : th('impact.summary', { diameter: fmtDiam(q.diameter), location: fmtLonLat(q.lon, q.lat), depth: fmtInt(depth), crater: fmtInt(model.impact!.craterDiameter / 1000) }));
      text('simDetail', () => t('sim.gridDetail', {
        detail: q.kind === 'quake' ? '' : t('impact.detail', { depth: fmtInt(model.impact!.cavityDepth), distance: fmtInt(model.gainRef / 1000), amplitude: fmtInt(model.impact!.targetAmp), calibration: calNote() }),
        extent: fmtInt(src.nx * srcCell), cell: fmtInt(srcCell), coast: t(hasCoast ? 'sim.coastDetail' : 'sim.noCoastDetail'), download: received ? t('sim.download', { size: fmtInt(received / 1024) }) : '',
      }).trim());
      $('simDetail').hidden = false;
      camera.jumpTo(q.lon, q.lat, camera.altMin * (1500 / camera.minViewKm));
      setCollapsed(true);
      writeUrl();
      meshDirty = true;
      drawDirty = true;
    } catch (error) {
      console.error(error);
      text('readout', () => t(error instanceof LocalizedError ? error.key : 'error.sim'));
    } finally {
      starting = false;
      $('quakePanel').inert = false;
      $<HTMLInputElement>('seaLevel').disabled = false;
      $<HTMLInputElement>('seaLevelValue').disabled = false;
      $<HTMLButtonElement>('seaLevelReset').disabled = false;
    }
  };

  const showCoast = (): void => {
    text('coastinfo', () => coast ? t('coast.selected', { location: fmtLonLat(coast[0], coast[1]) }) : t('coast.none'));
    text('pickCoast', () => t(pickMode === 'coast' ? 'coast.tap' : coast ? 'coast.reselect' : 'coast.select'));
  };
  $('pickCoast').addEventListener('click', () => { pickMode = pickMode === 'coast' ? 'source' : 'coast'; showCoast(); });

  const setSeaLevel = (value: number, updateUrl = true): void => {
    if (starting) return;
    const level = Number.isFinite(value) ? Math.max(0, Math.min(1000, Math.round(value))) : 0;
    if (level !== terrain.seaLevel) {
      stopSim();
      clearPreview();
      $('simDetail').hidden = true;
      terrain.seaLevel = level;
      renderer.seaLevel = level;
      if (srcPos) placeSource(srcPos[0], srcPos[1], quakeP.strike);
      meshDirty = true;
      drawDirty = true;
    }
    $<HTMLInputElement>('seaLevel').value = String(level);
    $<HTMLInputElement>('seaLevelValue').value = String(level);
    if (updateUrl) scheduleUrl();
  };
  $('seaLevel').addEventListener('input', (e) => setSeaLevel(+(e.target as HTMLInputElement).value));
  const seaValue = $<HTMLInputElement>('seaLevelValue');
  const applySeaValue = (): void => setSeaLevel(seaValue.value.trim() === '' || !Number.isFinite(seaValue.valueAsNumber) ? terrain.seaLevel : seaValue.valueAsNumber);
  seaValue.addEventListener('change', applySeaValue);
  seaValue.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { applySeaValue(); seaValue.blur(); }
    if (event.key === 'Escape') { seaValue.value = String(terrain.seaLevel); seaValue.blur(); }
  });
  $('seaLevelReset').addEventListener('click', () => setSeaLevel(0));

  $('mw').addEventListener('input', (e) => { quakeP.Mw = +(e.target as HTMLInputElement).value; showSource(); });
  $('strike').addEventListener('input', (e) => { quakeP.strike = +(e.target as HTMLInputElement).value; showSource(); });
  $('diam').addEventListener('input', (e) => { impactP.diameter = diamFromT(+(e.target as HTMLInputElement).value); showSource(); });
  $('vel').addEventListener('input', (e) => { impactP.velocity = +(e.target as HTMLInputElement).value; showSource(); });
  $('rho').addEventListener('change', (e) => { impactP.density = +(e.target as HTMLSelectElement).value; showSource(); });
  $('kindQuake').addEventListener('click', () => { kind = 'quake'; showSource(); });
  $('kindImpact').addEventListener('click', () => { kind = 'impact'; showSource(); });
  $('go').addEventListener('click', () => {
    const b = $<HTMLButtonElement>('go');
    text(b, () => t('sim.preparing'));
    b.disabled = true;
    void startSim().finally(() => { text(b, () => t('sim.start')); b.disabled = false; });
  });
  $('play').addEventListener('click', () => {
    if (!solver) return;
    if (seeking) { seeking = false; running = false; stopAt = Infinity; speed = speedBeforeSeek; }
    else if (finished) { solver.reset(); simClock = 0; resetJudge(); finished = ''; $('stats').innerHTML = ''; beginRun(); }
    else if (startAt) { startAt = 0; streakStart = 0; }
    else if (running) running = false;
    else if (solver.t < solver.dt) beginRun();
    else running = true;
    drawDirty = true;
  });
  $('editSource').addEventListener('click', () => {
    stopSim();
    $('simPanel').hidden = true;
    $('simDetail').hidden = true;
    if (srcPos) { picked = srcPos; placeSource(srcPos[0], srcPos[1], quakeP.strike); }
    setCollapsed(false);
    drawDirty = true;
  });
  $('playMini').addEventListener('click', () => $('play').click());
  $('rerun').addEventListener('click', () => { void startSim(); });
  $('share').addEventListener('click', () => {
    writeUrl();
    const b = $('share');
    const done = (ok: boolean): void => { text(b, () => t(ok ? 'share.success' : 'share.failure')); setTimeout(() => { text(b, () => t('share.copy')); }, 1500); };
    navigator.clipboard?.writeText(location.href).then(() => done(true), () => done(false)) ?? done(false);
  });
  const tl = $<HTMLInputElement>('timeline');
  tl.addEventListener('pointerdown', () => { tlDragging = true; });
  tl.addEventListener('input', () => { tlDragging = true; $('clock').textContent = fmtClock(Number(tl.value)); });
  tl.addEventListener('change', () => { tlDragging = false; seekTo(Number(tl.value)); });
  $('reset').addEventListener('click', () => { if (starting) return; stopSim(); clearPreview(); srcPos = null; outline = null; picked = null; coast = null; pickMode = 'source'; $('simPanel').hidden = true; $('simDetail').hidden = true; writeUrl(); setCollapsed(false); showCoast(); text('readout', () => t('intro.reset')); });
  showCoast();
  const speedRange = $<HTMLInputElement>('speedRange');
  const speedValue = $<HTMLInputElement>('speedValue');
  let finiteSpeed = 120;
  const setSpeed = (value: number): void => {
    const next = value === Infinity ? Infinity : Math.max(1, Math.min(3600, Math.round(Number.isFinite(value) ? value : finiteSpeed)));
    if (Number.isFinite(next)) finiteSpeed = next;
    // Seeking temporarily runs at full speed; edits apply when it reaches the target.
    if (seeking) speedBeforeSeek = next;
    else speed = next;
    speedRange.value = String(finiteSpeed);
    speedValue.value = String(finiteSpeed);
    $('speedMax').setAttribute('aria-pressed', String(next === Infinity));
    speedValue.disabled = next === Infinity;
    $('speedNumeric').hidden = next === Infinity;
    $('speedMaxValue').hidden = next !== Infinity;
    drawDirty = true;
  };
  speedRange.addEventListener('input', () => setSpeed(speedRange.valueAsNumber));
  const applySpeed = (): void => setSpeed(Number.isFinite(speedValue.valueAsNumber) ? speedValue.valueAsNumber : finiteSpeed);
  speedValue.addEventListener('change', applySpeed);
  speedValue.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { applySpeed(); speedValue.blur(); }
    if (event.key === 'Escape') { speedValue.value = String(finiteSpeed); speedValue.blur(); }
  });
  $('speedMax').addEventListener('click', () => setSpeed((seeking ? speedBeforeSeek : speed) === Infinity ? finiteSpeed : Infinity));


  camera.onChange = () => { meshDirty = true; drawDirty = true; };
  camera.onTap = (lon, lat) => {
    if (solver || starting) return; // 계산 중이거나 준비 중에는 발생원을 옮기지 않는다
    if (pickMode === 'coast') {
      coast = [lon, lat];
      pickMode = 'source';
      showCoast();
      drawDirty = true;
      return;
    }
    placeSource(lon, lat, null);
  };
  /** 발생원을 놓는다. 바다면 발생원 패널을 열고 미리보기를 만든다. strike가 null이면 해구 방향을 자동으로 잡는다. */
  function placeSource(lon: number, lat: number, strike: number | null): void {
    picked = [lon, lat];
    const scale = mesh ? Math.max(MIN_EDGE_KM, mesh.minEdgeKm) : 40;
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    const e = terrain.elevation(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo), scale);
    const sea = e < -50;
    html('readout', () => th('location.summary', { label: t(e < 0 ? 'location.depth' : 'location.elevation'), height: fmtInt(Math.abs(e)), location: fmtLonLat(lon, lat), note: sea ? '' : t('location.invalid') }));
    $('quakePanel').hidden = !sea;
    if (sea) {
      srcPos = [lon, lat];
      srcDepth = e;
      quakeP.strike = strike === null || !Number.isFinite(strike) ? Math.round(autoStrike(terrain, lon, lat)) : Math.round(strike);
      showSource();
    } else { srcPos = null; outline = null; clearPreview(); }
    drawDirty = true;
  }

  const marker = $('marker'), coastMarker = $('coastMarker'), note = $('generated');
  const pulse = $('pulse'), streak = $('streak'), flash = $('flash');
  let lastStats = 0;
  /** 해안 격자의 기록을 읽어 침수 통계를 낸다. 처음에 마른 셀 중 최대 수위가 지반보다 높은 셀이 잠긴 셀이다. */
  const updateStats = (): void => {
    if (!solver) return;
    const parts: string[] = [];
    // 경험식 판정으로 영향받는 도시. 처오름이 큰 순.
    if (judge && judge.any) {
      const list = judge.cityImpacts(cities.cities, 8);
      if (list.length) {
        parts.push(t('stats.cities'));
        for (const c of list) parts.push(`<div>${escapeHtml(c.name)}<b>${formatNumber(c.runup, 1)} m · ${c.arrival >= 0 ? fmtClock(c.arrival) : '—'}</b></div>`);
        if (list.length % 2) parts.push('<div></div>');
      }
    } else parts.push(t('stats.waiting'));
    // 해안 격자가 있으면 직접 계산한 침수 통계
    const i = specs.findIndex((sp) => sp.role === 'coast');
    if (i >= 0) {
      const lv = solver.levels[i];
      if (!lv.active && lv.steps === 0 && !solver.spent[i]) parts.push(t('stats.coastWaiting'));
      else {
        const g = lv.grid, rec = solver.readRecord(i);
        const lat = (specs[i].south + specs[i].north) / 2, cell = (40075016.686 / g.world) * Math.cos((lat * Math.PI) / 180);
        let flooded = 0, runup = 0, maxDepth = 0, firstArr = Infinity;
        for (let k = 0; k < g.nx * g.ny; k++) {
          if (g.wet0[k] || rec[k * 4] < -1e4) continue;
          const d = rec[k * 4] - g.bed[k];
          if (d <= 0.05) continue;
          flooded++;
          if (g.bed[k] > runup) runup = g.bed[k];
          if (d > maxDepth) maxDepth = d;
          const t = rec[k * 4 + 1];
          if (t >= 0 && t < firstArr) firstArr = t;
        }
        const area = (flooded * cell * cell) / 1e6;
        parts.push(`<div class="wide"><b>${t('stats.coast')}</b> ${t('stats.grid')}${lv.active ? '' : t('stats.done')}</div>
          <div>${t('stats.area')}<b>${area >= 10 ? fmtInt(area) : formatNumber(area, 1)} km²</b></div><div>${t('stats.runup')}<b>${formatNumber(runup, 1)} m</b></div>
          <div>${t('stats.depth')}<b>${formatNumber(maxDepth, 1)} m</b></div><div>${t('stats.arrival')}<b>${Number.isFinite(firstArr) ? t('stats.after', { time: fmtClock(firstArr) }) : t('stats.notYet')}</b></div>`);
      }
    }
    $('stats').innerHTML = parts.join('');
  };
  /**
   * 경험식 판정과 통계를 현재 계산 시각에 맞춘다. 기록을 동기식으로 읽으므로 계산이 흐르는 동안은 벽시계 간격을 지킨다.
   * settled면(멈춤, 시간 슬라이더의 목표 도착, 종료) 간격을 기다리지 않는다. 전에는 흐르는 동안에만 갱신해서,
   * 빠른 기기에서 시간을 옮기면 도시 목록과 침수 판정이 옮기기 전 값으로 남았다.
   */
  const refreshResults = (now: number, settled: boolean): void => {
    if (!solver) return;
    const time = solver.t;
    if (judge) {
      if (time !== judgedSourceT && (settled || now - lastJudgeSource > JUDGE_SOURCE_INTERVAL_MS)) { lastJudgeSource = now; judgedSourceT = time; judge.update(0, solver.readRecord(1), time); }
      if (time !== judgedGlobalT && (settled || now - lastJudgeGlobal > JUDGE_GLOBAL_INTERVAL_MS)) { lastJudgeGlobal = now; judgedGlobalT = time; judge.update(1, solver.readRecord(0), time); }
      // 판정이 바뀌면 꼭짓점의 물 높이를 다시 넣어야 하므로 메시를 다시 만든다
      if (judge.any && judge.version !== judgeVersionDrawn && mesh && mesh.minEdgeKm <= Math.max(3, judge.maxLimitKm())) { judgeVersionDrawn = judge.version; meshDirty = true; }
    }
    if (time !== statsT && (settled || now - lastStats > STATS_INTERVAL_MS)) { lastStats = now; statsT = time; updateStats(); }
  };
  const shape = document.getElementById('faultShape') as unknown as SVGPolygonElement, trench = document.getElementById('faultTrench') as unknown as SVGLineElement;
  const turbo = Number(new URLSearchParams(location.search).get('turbo') ?? 0);
  let last = performance.now();
  // 폰에서 앱을 오래 떠나 있으면 브라우저가 그래픽 컨텍스트를 거둬 간다. 계산 상태가 텍스처에 있어 이어 갈 수 없으므로
  // 그리기를 멈추고 다시 불러오게 한다. 시나리오는 주소에 있어 같은 발생원으로 돌아온다.
  let contextLost = false;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    running = false;
    const el = $('fatal');
    el.hidden = false;
    text(el, () => t('error.context'));
    el.addEventListener('click', () => location.reload(), { once: true });
  });
  const frame = (now: number): void => {
    if (contextLost) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (camera.tick(dt)) { meshDirty = true; drawDirty = true; }
    // 시작 효과가 도는 동안은 매 프레임 그린다. 소행성은 궤적이 닿으면 계산을 시작한다
    if (pulseUntil || streakStart || flashUntil) drawDirty = true;
    if (startAt && now >= startAt) { impactLanded = true; startAt = 0; streakStart = 0; flashUntil = now + FLASH_MS; running = true; }
    if (solver && running) {
      // 프레임이 밀리면 한 번에 도는 스텝을 줄이고, 여유가 있으면 늘린다
      if (dt > 0.04) stepBudget = Math.max(1, stepBudget * 0.8);
      else if (dt < 0.025) stepBudget = Math.min(96, stepBudget * 1.15);
      if (turbo > 0) stepBudget = turbo; // 자동 검사용: 프레임률을 무시하고 정해진 양을 돈다
      simClock = Math.min(SIM_MAX_S, stopAt, Number.isFinite(speed) ? simClock + speed * dt : SIM_MAX_S);
      const want = Math.floor((simClock - solver.t) / solver.dt);
      const n = Math.max(0, Math.min(Math.floor(stepBudget), want));
      if (n > 0) {
        solver.step(n);
        // 계산이 텍스처 두 장을 번갈아 쓰므로 그리기가 읽을 텍스처를 매번 다시 잡는다
        const w = renderer.wave!;
        solver.levels.forEach((lv, i) => { w.levels[i].state = lv.stateTexture; });
        if (w.flood) { const ci = specs.findIndex((sp) => sp.role === 'coast'); w.flood.record = solver.levels[ci].recordTexture; }
        drawDirty = true;
      }
      // 계산이 재생 속도를 못 따라가면 시계를 계산 쪽에 맞춘다
      if (Number.isFinite(speed)) simClock = Math.min(simClock, solver.t + speed * 0.5);
      // 시간 슬라이더의 목표 시각에 닿으면 그 자리에서 멈춘다
      if (seeking && solver.t >= stopAt - solver.dt) { seeking = false; running = false; stopAt = Infinity; speed = speedBeforeSeek; simClock = solver.t; drawDirty = true; }
      // 파가 잦아들면 멈춘다. 그래도 계속 출렁이면 상한에서 멈춘다.
      if (solver.t >= SIM_MAX_S - solver.dt) { finished = 'max'; running = false; }
      else if (solver.t > QUIET_MIN_T_S && now - lastQuiet > QUIET_CHECK_MS) {
        lastQuiet = now;
        if (solver.maxAbsEta() < QUIET_ETA_M) finished = 'quiet';
        else if (judge && solver.t - judge.lastChangeT > STALE_S) finished = 'stale';
        if (finished) { running = false; drawDirty = true; }
      }
    }
    // 계산이 흐르는 동안은 간격을 두고, 멈췄거나 목표 시각에 닿았으면 바로 판정과 통계를 맞춘다
    if (solver) refreshResults(now, !running || solver.t >= Math.min(stopAt, SIM_MAX_S) - solver.dt);
    // 새 메시가 얼마나 잘게 나뉘었는지 보고 조각을 요청한다. 순서를 바꾸면 확대 직후에 이전 메시를 기준으로 판단하게 된다.
    if (meshDirty && now - lastBuild >= REBUILD_INTERVAL_MS) { rebuild(now); requestChunks(); }
    if (drawDirty && mesh) {
      drawDirty = false;
      // 가까이 갈수록 과장을 줄인다. 멀리서는 기복이 보여야 하고, 가까이서는 산이 과하게 솟지 않아야 한다.
      const zoomFactor = Math.max(0, Math.min(1, Math.log(camera.viewWidthKm / 8) / Math.log(8000 / 8)));
      renderer.exaggeration = 2 + 38 * zoomFactor * zoomFactor;
      renderer.wavesVisible = kind !== 'impact' || impactLanded || (solver !== null && solver.t > 0);
      renderer.simTime = solver ? solver.t : -1;
      renderer.render(camera);
      lines.render(camera, renderer.exaggeration / 6371000, Math.min(window.devicePixelRatio || 1, 2.5));
      cities.render(camera, renderer.exaggeration / 6371000, Math.min(window.devicePixelRatio || 1, 2.5));
      if (!fineLinesRequested && camera.viewWidthKm < FINE_LINES_VIEW_KM) { fineLinesRequested = true; void loadLines('50m'); }
      text('meshinfo', () => t('mesh.info', { faces: fmtInt(mesh!.faces), edge: fmtLen(mesh!.minEdgeKm) }));
      $('viewReset').hidden = !camera.adjusted;
      note.hidden = mesh.minEdgeKm >= DATA_RESOLUTION_KM;
      const p = picked && !solver ? camera.project(picked[0], picked[1]) : null;
      marker.hidden = !p;
      if (p) marker.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
      const cp = coast ? camera.project(coast[0], coast[1]) : null;
      coastMarker.hidden = !cp;
      if (cp) coastMarker.style.transform = `translate(${cp[0].toFixed(1)}px, ${cp[1].toFixed(1)}px)`;
      // 단층의 지표 투영(네 점) 또는 소행성 크레이터의 원(48점). 모든 점이 보일 때만 그린다.
      const pts = outline ? outline.map(([lo, la]) => camera.project(lo, la)) : [];
      const visible = pts.length >= 4 && pts.every((q) => q !== null);
      shape.style.display = visible ? '' : 'none';
      trench.style.display = visible && pts.length === 4 ? '' : 'none';
      shape.classList.toggle('crater', pts.length !== 4);
      if (visible) {
        const q = pts as [number, number][];
        shape.setAttribute('points', q.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
        if (q.length === 4) {
          trench.setAttribute('x1', q[0][0].toFixed(1)); trench.setAttribute('y1', q[0][1].toFixed(1));
          trench.setAttribute('x2', q[1][0].toFixed(1)); trench.setAttribute('y2', q[1][1].toFixed(1));
        }
      }
      // 시작 효과(D-042)
      const fx = srcPos ? camera.project(srcPos[0], srcPos[1]) : null;
      if (fx && pulseUntil && now < pulseUntil) {
        const p = 1 - (pulseUntil - now) / PULSE_MS;
        pulse.hidden = false; pulse.style.transform = `translate(${fx[0].toFixed(1)}px, ${fx[1].toFixed(1)}px) scale(${(1 + p * 14).toFixed(2)})`; pulse.style.opacity = String(1 - p);
      } else { pulse.hidden = true; if (now >= pulseUntil) pulseUntil = 0; }
      if (fx && streakStart) {
        const p = Math.min(1, (now - streakStart) / STREAK_MS), back = (1 - p) * 360;
        // 화면 왼쪽 위에서 45도로 떨어진다. 막대의 밝은 끝이 머리다
        const hx = fx[0] - back, hy = fx[1] - back, tail = 160 / Math.SQRT2;
        streak.hidden = false; streak.style.transform = `translate(${(hx - tail).toFixed(1)}px, ${(hy - tail).toFixed(1)}px) rotate(45deg)`; streak.style.opacity = String(Math.min(1, p * 4));
      } else streak.hidden = true;
      if (fx && flashUntil && now < flashUntil) {
        const p = 1 - (flashUntil - now) / FLASH_MS;
        flash.hidden = false; flash.style.transform = `translate(${fx[0].toFixed(1)}px, ${fx[1].toFixed(1)}px) scale(${(0.4 + p * 5).toFixed(2)})`; flash.style.opacity = String(1 - p * p);
      } else { flash.hidden = true; if (now >= flashUntil) flashUntil = 0; }
      if (solver) {
        syncSimUi();
      } else $('sheetMini').textContent = srcPos ? t('source.placed') : '';
    }
    requestAnimationFrame(frame);
  };
  // 파도 높이 방식은 그리기 상태(drawDirty)가 준비된 뒤에 정한다
  try {
    const saved = localStorage.getItem('waveScale');
    setWaveScale(saved === 'real' || saved === 'boost' ? saved : 'coastReal');
  } catch { setWaveScale('coastReal'); }
  readUrl();
  onLocaleChange(() => {
    cities.setLocale(getLocale());
    if (solver) { syncSimUi(); updateStats(); }
    drawDirty = true;
    placeSheet();
  });
  requestAnimationFrame(frame);

  // 자동 검사와 디버깅용 창구
  (window as unknown as { __app: unknown }).__app = {
    ready: true,
    camera,
    earth,
    chunks,
    terrain,
    get mesh() { return mesh; },
    get edgePx() { return edgePx; },
    get gpuBytes() { return renderer.gpuBytes; },
    get waveScaleMode() { return renderer.waveScaleMode; },
    get avgBuildMs() { return builds ? buildMsTotal / builds : 0; },
    lines,
    get linesBytes() { return linesBytes; },
    cities,
    get citiesBytes() { return citiesBytes; },
    tap: (lon: number, lat: number) => camera.onTap?.(lon, lat),
    get solver() { return solver; },
    get grid() { return globalGrid; },
    get specs() { return specs; },
    get judge() { return judge; },
    setWaveScale,
    setDesignStyle,
    setCoast: (lon: number, lat: number) => { coast = [lon, lat]; showCoast(); },
    setQuake: (q: Partial<Pick<QuakeParams, 'Mw' | 'strike'>>) => { Object.assign(quakeP, q); kind = 'quake'; showSource(); },
    setImpact: (q: Partial<Pick<ImpactParams, 'diameter' | 'velocity' | 'density'>>) => { Object.assign(impactP, q); kind = 'impact'; showSource(); },
    get source() { return currentSource(); },
    updateStats,
    startSim,
    setSpeed,
    get speed() { return seeking ? speedBeforeSeek : speed; },
    runUntil: (t: number) => { stopAt = t; speed = Infinity; running = true; startAt = 0; streakStart = 0; },
    seekTo,
    setCollapsed,
    get running() { return running; },
    get wavesVisible() { return renderer.wavesVisible; },
    get finished() { return finished; },
    get previewInfo() { return preview ? { textures: preview.length, levels: renderer.wave?.levels.length ?? 0, refAmp: renderer.wave?.refAmp ?? 0 } : null; },
  };
}

initI18n();
start().catch((e: unknown) => {
  console.error(e);
  const el = $('fatal');
  el.hidden = false;
  text(el, () => t(e instanceof LocalizedError ? e.key : 'error.start'));
});
