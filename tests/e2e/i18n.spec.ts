import { expect, test } from '@playwright/test';
type Probe = {
  ready: boolean;
  solver: { t: number; steps: number } | null;
  running: boolean;
  source: { Mw: number; dimensions: { lengthKm: number; widthKm: number } };
  cities: { cities: { name: string }[] };
  startSim(): Promise<void>;
  setCollapsed(c: boolean): void;
  seekTo(t: number): void;
};

test.use({ locale: 'en-US', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const APP = 'http://localhost:5191/';

test('switches all UI and cities without resetting the simulation; saves and shares language', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${APP}?lon=142.85&lat=38.3&kind=quake&mw=9&strike=193&turbo=6`);
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('Tsunami Lab');
  await expect(page.locator('#globe')).toHaveAttribute('aria-label', /Drag to rotate/);
  await expect(page.locator('#faultinfo')).toContainText('Fixed fault size');
  await page.waitForFunction(() => (window as unknown as { __app: Probe }).__app.cities.cities.some(c => c.name === 'Tokyo'));
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.startSim());
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.seekTo(600));
  await page.waitForFunction(() => {
    const a = (window as unknown as { __app: Probe }).__app;
    return a.solver !== null && a.solver.t > 550 && !a.running;
  });
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.setCollapsed(false));
  await expect(page.locator('#clock')).toContainText('min');
  const solver = await page.evaluateHandle(() => (window as unknown as { __app: Probe }).__app.solver);
  const time = await page.evaluate(() => (window as unknown as { __app: Probe }).__app.solver!.t);
  await page.locator('#language').selectOption('ko');
  await expect(page.locator('#readout')).toContainText('해저 지진');
  await expect(page.locator('#clock')).toContainText('분');
  await expect(page.locator('#play')).toHaveAttribute('aria-label', '재생');
  expect(await page.evaluate(s => s === (window as unknown as { __app: Probe }).__app.solver, solver)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __app: Probe }).__app.solver!.t)).toBe(time);
  await page.locator('#language').selectOption('en');
  await expect(page.locator('#readout')).toContainText('earthquake');
  await expect(page.locator('#timelineEnd')).toHaveText('6 h 0 min');
  await page.locator('#moreInfo').evaluate(el => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator('#simDetail')).toContainText('Source region');
  const ui = await page.locator('#sheet').innerText();
  expect(ui).not.toMatch(/[가-힣]|\{\w+\}/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'dev/shots/i18n-phone-en.png' });
  await page.locator('#share').click();
  await expect(page).toHaveURL(/lang=en/);
  const url = page.url();
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await expect(page.locator('#faultinfo')).toContainText('Fixed fault size');
  const saved = new URL(url); saved.searchParams.delete('lang');
  await page.locator('#language').selectOption('ko');
  await page.goto(saved.toString());
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(errors).toEqual([]);
});

test('English asteroid settings, preparation and reset contain translated text', async ({ page }) => {
  await page.goto(`${APP}?lang=en&lon=134&lat=39.5&kind=impact&diam=500`);
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await expect(page.locator('#faultinfo')).toContainText('Impact energy');
  await expect(page.locator('#rho option:checked')).toHaveText('Rock (3,000 kg/m³)');
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.startSim());
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.setCollapsed(false));
  await expect(page.locator('#readout')).toContainText('Asteroid impact');
  await expect(page.locator('#simstate')).toHaveText('Press play to start');
  await page.locator('#moreInfo').evaluate(el => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator('#simDetail')).toContainText('Cavity depth');
  await page.locator('#reset').click();
  await expect(page.locator('#readout')).toContainText('Tap the ocean');
  await page.locator('#language').selectOption('ko');
  await expect(page.locator('#readout')).toContainText('바다를 누르면');
});

test('language switching works when local storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await page.goto(`${APP}?lang=en`);
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await page.locator('#language').selectOption('ko');
  await expect(page).toHaveTitle('쓰나미 랩');
  await expect(page).toHaveURL(/lang=ko/);
});
