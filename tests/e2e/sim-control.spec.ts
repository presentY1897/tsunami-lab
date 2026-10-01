import { expect, test } from '@playwright/test';

// 재생 제어의 회귀 검사(D-045와 2026-10-01 코드 검토에서 고친 것들).
const APP = 'http://localhost:5191/';

type City = { name: string; runup: number };
type Probe = {
  ready: boolean;
  running: boolean;
  camera: { jumpTo(lon: number, lat: number, alt?: number): void; altFit: number };
  cities: { cities: unknown[] };
  solver: { t: number; readRecord(level: number): Float32Array } | null;
  judge: { any: boolean; update(level: number, record: Float32Array, t: number): void; cityImpacts(cities: unknown[], n: number): City[] } | null;
  specs: { west: number; east: number }[];
  source: { lon: number; lat: number } | null;
  tap(lon: number, lat: number): void;
  setImpact(q: { diameter: number }): void;
  startSim(): Promise<void>;
  seekTo(t: number): void;
};

test.beforeEach(async ({ page }) => {
  // 계산 셰이더 프로그램이 몇 개 만들어지는지 센다
  await page.addInitScript(() => {
    const P = WebGL2RenderingContext.prototype, create = P.createProgram;
    (window as unknown as { __programs: number }).__programs = 0;
    P.createProgram = function (this: WebGL2RenderingContext) { (window as unknown as { __programs: number }).__programs++; return create.call(this); };
  });
});

test('시간을 옮기면 판정과 통계가 그 시각의 값이고, 준비 중의 탭은 무시되며, 다시 일으켜도 셰이더가 쌓이지 않는다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${APP}?lang=ko&turbo=10`);
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await page.evaluate(() => { const a = (window as unknown as { __app: Probe }).__app; a.camera.jumpTo(150, 34, a.camera.altFit * 0.6); a.tap(142.85, 38.3); });
  await expect(page.locator('#quakePanel')).toBeVisible();

  // 준비하는 동안 다른 바다를 눌러도 발생원이 옮겨지지 않는다. 계산 격자와 주소가 같은 발생원을 가리킨다
  const started = await page.evaluate(async () => {
    const a = (window as unknown as { __app: Probe }).__app, p = a.startSim();
    a.tap(160, 20);
    await p;
    return { source: a.source, grid: [a.specs[1].west, a.specs[1].east], url: location.search };
  });
  expect(started.source).toMatchObject({ lon: 142.85, lat: 38.3 });
  expect(started.grid[0]).toBeLessThan(142.85);
  expect(started.grid[1]).toBeGreaterThan(142.85);
  expect(started.url).toContain('lon=142.850');
  const programsAfterFirst = await page.evaluate(() => (window as unknown as { __programs: number }).__programs);

  // 시간 슬라이더로 1시간까지 옮긴다. 멈춘 뒤에는 기다리지 않아도 판정이 그 시각의 기록과 같고, 통계에 도시가 나온다
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.seekTo(3600));
  await page.waitForFunction(() => { const a = (window as unknown as { __app: Probe }).__app; return !a.running && a.solver!.t > 3600 - 120; }, null, { timeout: 240_000, polling: 100 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))));
  const judged = await page.evaluate(() => {
    const a = (window as unknown as { __app: Probe }).__app, list = (): string[] => a.judge!.cityImpacts(a.cities.cities, 8).map((c) => `${c.name} ${c.runup.toFixed(2)}`);
    const shown = list();
    a.judge!.update(0, a.solver!.readRecord(1), a.solver!.t);
    a.judge!.update(1, a.solver!.readRecord(0), a.solver!.t);
    return { any: a.judge!.any, shown, fresh: list(), stats: document.getElementById('stats')!.textContent ?? '' };
  });
  expect(judged.any).toBe(true);
  expect(judged.shown.length).toBeGreaterThan(2);
  expect(judged.shown).toEqual(judged.fresh);
  expect(judged.stats).toContain('영향받는 도시');

  // 다시 일으키고 소행성으로 바꿔 일으켜도 계산 셰이더는 처음 만든 것을 계속 쓴다
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.startSim());
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.seekTo(600));
  await page.waitForFunction(() => { const a = (window as unknown as { __app: Probe }).__app; return !a.running && a.solver!.t > 600 - 120; }, null, { timeout: 120_000, polling: 100 });
  await page.locator('#sheetToggle').click();
  await page.locator('#editSource').click();
  await page.evaluate(async () => { const a = (window as unknown as { __app: Probe }).__app; a.setImpact({ diameter: 500 }); await a.startSim(); });
  expect(await page.evaluate(() => (window as unknown as { __app: Probe }).__app.solver !== null)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __programs: number }).__programs)).toBe(programsAfterFirst);
  expect(errors).toEqual([]);
});

test('그래픽 컨텍스트를 잃으면 안내를 띄우고, 누르면 다시 불러온다', async ({ page }) => {
  await page.goto(`${APP}?lang=ko&lon=142.85&lat=38.3&kind=quake&mw=9&strike=193`);
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await expect(page.locator('#fatal')).toBeHidden();
  await page.evaluate(() => (document.getElementById('globe') as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext());
  await expect(page.locator('#fatal')).toBeVisible();
  await expect(page.locator('#fatal')).toContainText('다시 불러옵니다');
  await page.locator('#fatal').click();
  // 다시 불러오면 주소의 발생원이 그대로 놓인다
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready && (window as unknown as { __app: Probe }).__app.source !== null);
  await expect(page.locator('#fatal')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __app: Probe }).__app.source)).toMatchObject({ lon: 142.85, lat: 38.3 });
});
