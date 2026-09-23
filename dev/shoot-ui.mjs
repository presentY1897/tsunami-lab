// 새 패널 구성(D-043)을 찍는다. 발생원 패널, 시작 직후(접힘, 시각 0), 펼친 계산 패널, 자세히. 폰과 데스크톱. 사용: GPU=1 node dev/shoot-ui.mjs <port>
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5192';
const browser = await launchBrowser();
for (const v of [{ name: 'phone', opts: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } }, { name: 'desktop', opts: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }]) {
  const ctx = await browser.newContext(v.opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
  await page.goto(`http://localhost:${port}/?lon=142.85&lat=38.3&kind=quake&mw=9&strike=193`);
  await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `dev/shots/ui-${v.name}-source.png` });
  await page.evaluate(() => { void window.__app.startSim(); });
  await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `dev/shots/ui-${v.name}-started.png` });
  await page.locator('#playMini').click(); // 접힌 머리에서 재생
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.__app.setCollapsed(false));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `dev/shots/ui-${v.name}-sim.png` });
  await page.locator('#moreInfo').evaluate((d) => { d.open = true; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `dev/shots/ui-${v.name}-details.png` });
  console.log(`  ${v.name}: url=${page.url().split('?')[1]} clock=${await page.locator('#clock').textContent()} state=${await page.locator('#simstate').textContent()}`);
  await ctx.close();
}
await browser.close();
