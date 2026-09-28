import { expect, test } from '@playwright/test';

test('수위 변경, 계산 초기화, 공유 주소 복원', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:5191/?lon=142.85&lat=38.3&sea=100&lang=ko');
  await page.waitForFunction(() => (window as any).__app?.ready);
  await expect(page.locator('#seaLevel')).toHaveValue('100');
  const bed = await page.evaluate(() => (window as any).__app.terrain.base(142.85, 38.3, 40));
  await page.locator('#seaLevel').fill('300');
  expect(await page.evaluate(() => (window as any).__app.terrain.base(142.85, 38.3, 40))).toBeCloseTo(bed - 200);
  await expect(page).toHaveURL(/sea=300/);
  await page.reload();
  await page.waitForFunction(() => (window as any).__app?.ready);
  await expect(page.locator('#seaLevel')).toHaveValue('300');
  await page.evaluate(() => (window as any).__app.startSim());
  expect(await page.evaluate(() => {
    const a = (window as any).__app;
    const k = 100 * a.earth.size + 500;
    const e = a.earth.elev[(260 + 100) * a.earth.size + 500] - 300;
    return a.grid.input.bed[k] === Math.fround(e < 0 ? Math.min(e, -10) : Math.max(e, 30));
  })).toBe(true);
  await page.locator('#sheetToggle').click();
  await page.locator('#seaLevelReset').click();
  await expect(page.locator('#seaLevel')).toHaveValue('0');
  expect(await page.evaluate(() => (window as any).__app.solver)).toBeNull();
  await expect(page.locator('#simPanel')).toBeHidden();
  expect(errors).toEqual([]);
});
