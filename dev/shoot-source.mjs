// 발생원 미리보기와 시작 효과(D-042)를 찍는다. 지진 상자+해저 변형, 소행성 원+잔잔한 수면, 궤적, 섬광, 진앙 고리. 사용: GPU=1 node dev/shoot-source.mjs <port>
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5192';
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('  CONSOLE:', m.text().slice(0, 200)); });
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
// 지진: 도호쿠 자리. 상자와 해저 변형 미리보기
await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(146, 37, a.camera.altFit * 0.45); a.tap(142.85, 38.3); a.camera.jumpTo(143.5, 38.3, a.camera.altFit * 0.12); });
await page.waitForTimeout(1500);
console.log('  지진 미리보기:', JSON.stringify(await page.evaluate(() => window.__app.previewInfo)));
await page.evaluate(() => window.__app.setCollapsed(true)); // 패널이 발생원을 가리지 않게 접는다
await page.waitForTimeout(400);
await page.screenshot({ path: 'dev/shots/source-quake-preview.png' });
await page.evaluate(() => window.__app.setWaveScale('boost'));
await page.waitForTimeout(600);
await page.screenshot({ path: 'dev/shots/source-quake-preview-boost.png' });
await page.evaluate(() => window.__app.setWaveScale('coastReal'));
// 시작: 진앙 고리
await page.evaluate(() => { void window.__app.startSim(); });
await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
await page.waitForTimeout(350);
await page.screenshot({ path: 'dev/shots/source-quake-pulse.png' });
await page.evaluate(() => window.__app.setCollapsed(false)); // 접힌 패널을 펼쳐야 버튼이 보인다
await page.locator('#moreInfo').evaluate((d) => { d.open = true; });
await page.locator('#reset').click();
await page.waitForTimeout(500);
// 소행성 3 km, 동해. 원과 공동 미리보기
await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(134, 39.5, a.camera.altFit * 0.12); a.tap(134, 39.5); a.setImpact({ diameter: 3000, velocity: 20, density: 3000 }); });
await page.evaluate(() => window.__app.setCollapsed(true));
await page.waitForTimeout(1200);
console.log('  소행성 미리보기:', JSON.stringify(await page.evaluate(() => window.__app.previewInfo)));
await page.screenshot({ path: 'dev/shots/source-impact-preview.png' });
// 시작: 궤적 → 섬광
await page.evaluate(() => { void window.__app.startSim(); });
await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'dev/shots/source-impact-streak.png' });
await page.waitForFunction(() => window.__app.solver.t > 0, null, { timeout: 20000 });
await page.waitForTimeout(150);
await page.screenshot({ path: 'dev/shots/source-impact-flash.png' });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'dev/shots/source-impact-after.png' });
console.log('done');
await browser.close();
