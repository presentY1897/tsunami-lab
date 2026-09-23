import { expect, test } from '@playwright/test';

type Probe = {
  ready: boolean;
  source: { Mw: number; dimensions: { lengthKm: number; widthKm: number } };
  solver: { t: number; levels: { readState(): Float32Array }[] } | null;
  running: boolean;
  startSim(): Promise<void>;
  seekTo(t: number): void;
};

test('가상 지진 규모 10.5를 계산하고 공유 주소에서 복원한다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:5191/?lon=142.85&lat=38.3&kind=quake&mw=9.5&strike=193&turbo=6');
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  const mw = page.locator('#mw');
  await expect(mw).toHaveAttribute('max', '10.5');
  await expect(page.locator('#faultinfo')).not.toContainText('가상 실험');
  const dimensions = await page.evaluate(() => (window as unknown as { __app: Probe }).__app.source.dimensions);
  await mw.fill('10.5');
  expect(await page.evaluate(() => (window as unknown as { __app: Probe }).__app.source.dimensions)).toEqual(dimensions);
  await expect(page.locator('#mwv')).toHaveText('M10.5');
  await expect(page.locator('#faultinfo')).toContainText('가상 실험');
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.startSim());
  await expect(page).toHaveURL(/mw=10\.5/);
  await expect(page.locator('#readout')).toContainText('가상 실험');
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.seekTo(3600));
  await page.waitForFunction(() => {
    const a = (window as unknown as { __app: Probe }).__app;
    return !a.running && (a.solver?.t ?? 0) > 3500;
  }, null, { timeout: 180000 });
  const result = await page.evaluate(() => {
    const a = (window as unknown as { __app: Probe }).__app;
    return a.solver!.levels.map(l => {
      const state = l.readState();
      return { finite: state.every(Number.isFinite), moving: state.some((v, k) => k % 4 === 1 && Math.abs(v) > 0.001) };
    });
  });
  expect(result.every(l => l.finite && l.moving)).toBe(true);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await expect(mw).toHaveValue('10.5');
  expect(await page.evaluate(() => (window as unknown as { __app: Probe }).__app.source.dimensions)).toEqual(dimensions);
  expect(await page.evaluate(() => (window as unknown as { __app: Probe }).__app.source.Mw)).toBe(10.5);
  await expect(page.locator('#faultinfo')).toContainText('가상 실험');
  expect(errors).toEqual([]);
});
