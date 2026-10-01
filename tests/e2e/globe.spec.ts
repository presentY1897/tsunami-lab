import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'ko'));
});

const APP = 'http://localhost:5191/';
/** docs/DATA-BUDGET.md 1절: 첫 화면 상한. */
const FIRST_SCREEN_LIMIT = 650 * 1024;

interface AppProbe {
  ready: boolean;
  mesh: { faces: number; minEdgeKm: number } | null;
  camera: { jumpTo(lon: number, lat: number, alt?: number): void; altMin: number; altFit: number; tiltOffset: number; heading: number; tilt: number; adjusted: boolean; project(lon: number, lat: number): [number, number] | null; resetView(): void };
  solver: { t: number; steps: number; levels: { active: boolean; steps: number; grid: { nx: number; ny: number; bed: Float32Array; wet0: Uint8Array } }[]; readCell(i: number, j: number): [number, number, number]; readRecord(level: number): Float32Array } | null;
  specs: { role: string; zoom: number }[];
  judge: { any: boolean; cityImpacts(cities: unknown[], n: number): { name: string; runup: number }[] } | null;
  setCoast(lon: number, lat: number): void;
  runUntil(t: number): void;
  setImpact(q: { diameter?: number }): void;
  source: { kind: string } | null;
  lines: { visible: boolean; has(name: string): boolean };
  linesBytes: number;
  cities: { visible: boolean; cities: unknown[] };
  citiesBytes: number;
  grid: { cellOf(lon: number, lat: number): [number, number] } | null;
  tap(lon: number, lat: number): void;
  chunks: { bytesLoaded: number; loadedCount: number };
  waveScaleMode: 'real' | 'coastReal' | 'boost';
  setCollapsed(c: boolean): void;
  seekTo(t: number): void;
  running: boolean;
}
declare const window: Window & { __app: AppProbe };

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

test('폰 크기 화면에서 지구가 뜨고, 첫 화면 전송량이 예산 안에 든다', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  let bytes = 0;
  const external: string[] = [];
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
  cdp.on('Network.requestWillBeSent', (e) => { if (!e.request.url.startsWith(APP)) external.push(e.request.url); });

  await page.goto(`${APP}?turbo=6`);
  await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60_000 });
  await page.waitForTimeout(500);

  expect(bytes).toBeGreaterThan(100 * 1024);
  expect(bytes).toBeLessThan(FIRST_SCREEN_LIMIT);
  // 기본 화면은 우리 빌드 결과물만 받는다. 외부 서비스에 의존하지 않는다.
  expect(external).toEqual([]);

  // 지구가 실제로 그려졌는지: 화면 가운데가 단색 배경이 아니어야 한다
  const shot = await page.screenshot({ clip: { x: 175, y: 402, width: 40, height: 40 } });
  expect(shot.length).toBeGreaterThan(400);
  // 실제 경계선(110m)은 첫 화면에서 받아 그린다. 50m은 아직이다.
  await page.waitForFunction(() => window.__app.lines.has('coast') && window.__app.lines.has('border'), null, { timeout: 30_000 });
  const linesBytes = await page.evaluate(() => window.__app.linesBytes);
  expect(linesBytes).toBeGreaterThan(10 * 1024);
  expect(linesBytes).toBeLessThan(60 * 1024);
  await page.locator('#linesToggle').click();
  expect(await page.evaluate(() => window.__app.lines.visible)).toBe(false);
  await page.locator('#linesToggle').click();
  // 주요 도시: 자료를 받아 점을 찍고, 화면 안의 큰 도시에 이름표가 붙는다
  await page.waitForFunction(() => window.__app.cities.cities.length > 1000, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__app.citiesBytes)).toBeLessThan(80 * 1024);
  await page.waitForTimeout(400);
  const labels = await page.locator('.citylabel:not([hidden])').allTextContents();
  expect(labels.length).toBeGreaterThan(3);
  expect(labels).toContain('도쿄');
  await page.locator('#citiesToggle').click();
  await page.waitForTimeout(300);
  expect(await page.locator('.citylabel:not([hidden])').count()).toBe(0);
  await page.locator('#citiesToggle').click();
  const far = await page.evaluate(() => ({ faces: window.__app.mesh!.faces, edge: window.__app.mesh!.minEdgeKm, chunkBytes: window.__app.chunks.bytesLoaded }));
  expect(far.faces).toBeGreaterThan(2000);
  expect(far.faces).toBeLessThan(70000);
  expect(far.edge).toBeGreaterThan(100); // 지구 전체를 볼 때는 큰 면이다
  expect(far.chunkBytes).toBe(0); // 10 km 조각은 첫 화면에서 받지 않는다

  // 끝까지 확대하면 100 m급 면까지 내려가고, 그 지역의 10 km 조각만 받는다
  await page.evaluate(() => window.__app.camera.jumpTo(129.0, 37.7, window.__app.camera.altMin));
  await page.waitForFunction(() => window.__app.chunks.loadedCount > 0 && window.__app.mesh!.minEdgeKm < 0.3, null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const near = await page.evaluate(() => ({ faces: window.__app.mesh!.faces, edge: window.__app.mesh!.minEdgeKm, chunkBytes: window.__app.chunks.bytesLoaded }));
  // 가까이 보면 50m 경계선을 더 받는다
  await page.waitForFunction(() => window.__app.linesBytes > 100 * 1024, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__app.linesBytes)).toBeLessThan(300 * 1024);
  expect(near.edge).toBeGreaterThanOrEqual(0.1);
  expect(near.faces).toBeLessThan(70000);
  expect(near.chunkBytes).toBeLessThan(320 * 1024); // docs/DATA-BUDGET.md 2절
  expect(bytes).toBeLessThan(1024 * 1024); // 한 세션 상한
  expect(external).toEqual([]);
  // 받은 자료보다 잘게 그릴 때는 생성된 지형임을 밝힌다
  await page.waitForFunction(() => !document.getElementById('generated')!.hidden, null, { timeout: 10_000 }); // 안내문은 '자세히' 안에 있어 hidden 속성으로 본다(D-043)

  await page.evaluate(() => window.__app.tap(129.3, 37.7));
  await expect(page.locator('#readout')).toContainText('수심');
  await page.evaluate(() => window.__app.tap(128.6, 37.7));
  await expect(page.locator('#readout')).toContainText('해발');

  // 바다를 누르면 발생원을 놓을 수 있고, 일으키면 전 지구 계산이 돈다
  await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(150, 34, a.camera.altFit); a.tap(127.5, 40.8); });
  await expect(page.locator('#quakePanel')).toBeHidden(); // 육지에서는 일으킬 수 없다
  await page.evaluate(() => window.__app.tap(142.85, 38.3));
  await expect(page.locator('#quakePanel')).toBeVisible();
  // 침수를 볼 해안으로 센다이 평야를 고른다
  await page.evaluate(() => window.__app.setCoast(140.97, 38.17));
  await expect(page.locator('#coastinfo')).toContainText('38.170');
  const chunkBytesBeforeSim = await page.evaluate(() => window.__app.chunks.bytesLoaded);
  await expect(page.locator('#faultinfo')).toContainText('614 × 189 km');
  // 해저 경사를 읽어 단층 방향을 해구를 따라 잡는다(실제 193도)
  const strike = Number(await page.locator('#strike').inputValue());
  expect(strike).toBeGreaterThan(160);
  expect(strike).toBeLessThan(225);
  await page.locator('#go').click();
  // 시작하면 시각 0에서 멈춘 채 패널이 접힌다(D-043). 검사는 펼쳐서 본다
  await expect(page.locator('#simPanel')).toBeAttached({ timeout: 30_000 });
  await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__app.running)).toBe(false);
  await expect(page.locator('#simstate')).toHaveText('재생을 누르면 시작합니다');
  await page.evaluate(() => window.__app.setCollapsed(false));
  await expect(page.locator('#simPanel')).toBeVisible();
  await page.locator('#speedMax').click();
  // 파도 높이 그리기: 기본은 '해안은 실제'. 고르면 렌더러 모드와 눌림 상태가 바뀌고 새로고침 뒤에도 남도록 저장된다.
  await expect(page.locator('[data-wavescale="coastReal"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-wavescale="real"]').click();
  await expect(page.locator('[data-wavescale="real"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-wavescale="coastReal"]')).not.toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => ({ mode: window.__app.waveScaleMode, saved: localStorage.getItem('waveScale') }))).toEqual({ mode: 'real', saved: 'real' });
  await page.locator('[data-wavescale="coastReal"]').click();
  // 1시간에서 멈춘다. 실제 GPU(D-041)에서는 계산이 1초에 5시간씩 가서, 자유로 두면 검사 사이에 해안 격자가 잠들어(3시간) 값이 달라진다
  await page.evaluate(() => window.__app.runUntil(3600));
  await page.waitForFunction(() => (window.__app.solver?.t ?? 0) >= 3600 - 60, null, { timeout: 120_000, polling: 200 });
  // 1시간 뒤: 발생원에서 600 km 떨어진 먼 바다에는 파가 지나갔고(최대 수위 기록), 지구 반대편은 아직 잔잔하다
  const wave = await page.evaluate(() => {
    const a = window.__app, near = a.grid!.cellOf(149.5, 38.3), far = a.grid!.cellOf(-30, 0), nx = a.solver!.levels[0].grid.nx;
    const rec = a.solver!.readRecord(0);
    return { near: rec[(near[1] * nx + near[0]) * 4], far: a.solver!.readCell(far[0], far[1])[0] };
  });
  expect(wave.near).toBeGreaterThan(0.05);
  expect(Math.abs(wave.far)).toBeLessThan(1e-6);
  // 경험식 판정: 해안을 고르지 않은 곳도 앞바다 파고로 처오름을 내어 도시 목록에 든다
  await page.waitForFunction(() => window.__app.judge?.any === true, null, { timeout: 60_000 });
  // 판정은 벽시계 2초마다 갱신되므로, 도시 목록이 채워질 때까지 기다린다(실제 GPU에서는 계산이 판정보다 훨씬 빠르다)
  await page.waitForFunction(() => (window.__app.judge?.cityImpacts((window.__app.cities as unknown as { cities: unknown[] }).cities, 8).length ?? 0) > 2, null, { timeout: 60_000, polling: 500 });
  const impacts = await page.evaluate(() => window.__app.judge!.cityImpacts((window.__app.cities as unknown as { cities: unknown[] }).cities, 8));
  expect(impacts.length).toBeGreaterThan(2);
  expect(impacts[0].runup).toBeGreaterThan(2);
  expect(impacts.map((c) => c.name).join(' ')).toMatch(/센다이|이시노마키|미야코|가마이시|이와키/);
  await page.evaluate(() => (window.__app as unknown as { updateStats(): void }).updateStats());
  await expect(page.locator('#stats')).toContainText('영향받는 도시');

  // 격자 단계: 전 지구, 발생원 주변, 해안까지의 중간, 해안(480 m). 발생원 격자는 처음부터, 해안 쪽은 파가 닿으면 깬다.
  const nested = await page.evaluate(() => ({ roles: window.__app.specs.map((s) => s.role), zooms: window.__app.specs.map((s) => s.zoom), levels: window.__app.solver!.levels.map((l) => ({ active: l.active, steps: l.steps })), chunkBytes: window.__app.chunks.bytesLoaded }));
  expect(nested.roles).toEqual(['global', 'source', 'bridge', 'coast']);
  expect(nested.zooms).toEqual([2, 4, 6, 8]);
  expect(nested.levels[1].active).toBe(true);
  expect(nested.levels[1].steps).toBeGreaterThan(nested.levels[0].steps);
  expect(nested.levels[3].active).toBe(true); // 센다이는 발생원에서 165 km라 1시간 안에 파가 닿는다
  // 해안 격자에서 물이 육지로 올라왔다: 처음에 마른 셀 중 최대 수위가 지반보다 높은 셀이 있다
  const flood = await page.evaluate(() => {
    const lv = window.__app.solver!.levels[3], g = lv.grid, rec = window.__app.solver!.readRecord(3);
    let flooded = 0, runup = 0;
    for (let k = 0; k < g.nx * g.ny; k++) {
      if (g.wet0[k] || rec[k * 4] < -1e4) continue;
      const d = rec[k * 4] - g.bed[k];
      if (d > 0.05) { flooded++; runup = Math.max(runup, g.bed[k]); }
    }
    return { flooded, runup };
  });
  expect(flood.flooded).toBeGreaterThan(50);
  expect(flood.runup).toBeGreaterThan(1);
  // 침수 통계가 화면에 나오고, 최대 침수 범위 색칠을 끄고 켤 수 있다
  await page.evaluate(() => (window.__app as unknown as { updateStats(): void }).updateStats());
  await expect(page.locator('#stats')).toContainText('침수 면적');
  await expect(page.locator('#stats')).toContainText('km²');
  await expect(page.locator('#floodToggle')).toBeVisible();
  await page.locator('#floodToggle').click();
  expect(await page.locator('#floodToggle').getAttribute('aria-pressed')).toBe('false');
  await page.locator('#floodToggle').click();

  // 소행성 충돌: 동해 한가운데 500 m. 처음으로 돌아가 발생원을 다시 놓는다.
  await page.locator('#moreInfo').evaluate((d) => { (d as HTMLDetailsElement).open = true; });
  await page.locator('#reset').click();
  await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(134, 39.5, a.camera.altFit); a.tap(134, 39.5); a.setImpact({ diameter: 500 }); });
  await expect(page.locator('#impactFields')).toBeVisible();
  await expect(page.locator('#faultinfo')).toContainText('충돌 에너지');
  await page.locator('#go').click();
  await expect(page.locator('#simPanel')).toBeAttached({ timeout: 60_000 });
  await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 60_000 });
  await page.evaluate(() => window.__app.setCollapsed(false));
  await expect(page.locator('#simPanel')).toBeVisible();
  await expect(page.locator('#readout')).toContainText('소행성 충돌');
  await page.locator('#speedMax').click();
  await page.evaluate(() => window.__app.runUntil(1500));
  await page.waitForFunction(() => (window.__app.solver?.t ?? 0) >= 1500 - 60, null, { timeout: 120_000, polling: 200 });
  // 25분 뒤: 발생원에서 약 150 km 떨어진 동해에 파가 와 있고, 발생원 격자와 전 지구 격자 모두 움직였다
  const impactWave = await page.evaluate(() => {
    const a = window.__app, near = a.grid!.cellOf(135.7, 39.5), far = a.grid!.cellOf(-150, 0), nx = a.solver!.levels[0].grid.nx;
    const rec = a.solver!.readRecord(0);
    return { near: rec[(near[1] * nx + near[0]) * 4], far: a.solver!.readCell(far[0], far[1])[0], srcSteps: a.solver!.levels[1].steps };
  });
  expect(impactWave.near).toBeGreaterThan(0.05);
  expect(Math.abs(impactWave.far)).toBeLessThan(1e-6);
  expect(impactWave.srcSteps).toBeGreaterThan(0);
  // 시나리오 하나가 받는 조각은 320 KB 아래, 세션 전체(확대 한 번, 시나리오 하나, 50m 경계선 포함)는 1.25 MB 아래 (docs/DATA-BUDGET.md 2절)
  expect(nested.chunkBytes - chunkBytesBeforeSim).toBeLessThan(320 * 1024);
  expect(bytes).toBeLessThan(1.25 * 1024 * 1024);
  await expect(page.locator('#clock')).toHaveText(/2[45]분/); // 25분에서 멈췄다
  // 시간 슬라이더(D-043): 뒤로 옮기면 처음부터 다시 계산해 그 시각에서 멈추고, 앞으로 옮기면 거기까지 간다
  await page.evaluate(() => window.__app.seekTo(600));
  await page.waitForFunction(() => window.__app.solver!.t >= 570 && window.__app.solver!.t < 660 && !window.__app.running, null, { timeout: 60_000, polling: 200 });
  await expect(page.locator('#clock')).toHaveText(/1[01]분/);
  await page.evaluate(() => window.__app.seekTo(1200));
  await page.waitForFunction(() => window.__app.solver!.t >= 1170 && !window.__app.running, null, { timeout: 60_000, polling: 200 });
  await expect(page.locator('#clock')).toHaveText(/2[01]분/);
  // 주소에 시나리오가 적힌다
  expect(page.url()).toMatch(/kind=impact/);
  expect(page.url()).toMatch(/diam=500/);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
