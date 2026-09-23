import { expect, test } from '@playwright/test';

type Probe = {
  ready: boolean;
  previewInfo: unknown;
  wavesVisible: boolean;
  solver: { t: number } | null;
  running: boolean;
  setDesignStyle(style: 'color' | 'wireframe'): void;
  startSim(): Promise<void>;
  seekTo(t: number): void;
};

test('운석 수면은 설정·대기·낙하 중 잔잔하고 충돌 뒤에만 변형된다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:5191/?kind=impact&lon=134&lat=39.5&diam=10000');
  await page.waitForFunction(() => (window as unknown as { __app?: Probe }).__app?.ready);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __app: Probe }).__app.wavesVisible)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __app: Probe }).__app.previewInfo)).toBeNull();
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.startSim());
  // 같은 초기 상태를 두 표현 방식에서 확인한다.
  for (const style of ['color', 'wireframe'] as const) {
    await page.evaluate(s => (window as unknown as { __app: Probe }).__app.setDesignStyle(s), style);
    await expect.poll(() => page.evaluate(() => {
      const a = (window as unknown as { __app: Probe }).__app;
      return { t: a.solver?.t, visible: a.wavesVisible, running: a.running };
    })).toEqual({ t: 0, visible: false, running: false });
  }
  await page.locator('#playMini').click();
  await expect(page.locator('#streak')).toBeVisible();
  expect(await page.evaluate(() => {
    const a = (window as unknown as { __app: Probe }).__app;
    return { t: a.solver?.t, visible: a.wavesVisible };
  })).toEqual({ t: 0, visible: false });
  await page.waitForFunction(() => {
    const a = (window as unknown as { __app: Probe }).__app;
    return a.wavesVisible && (a.solver?.t ?? 0) > 0;
  }, null, { timeout: 30000 });
  await page.evaluate(() => (window as unknown as { __app: Probe }).__app.seekTo(0));
  await expect.poll(() => page.evaluate(() => {
    const a = (window as unknown as { __app: Probe }).__app;
    return { t: a.solver?.t, visible: a.wavesVisible, running: a.running };
  })).toEqual({ t: 0, visible: false, running: false });
  expect(errors).toEqual([]);
});
