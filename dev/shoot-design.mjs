// 같은 계산 상태에서 색상/선 표현을 바꿔 비교한다.
// GPU=1 node dev/shoot-design.mjs [port]
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5190';
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, locale: 'ko-KR', deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/?design=1&lon=142.85&lat=38.3&kind=quake&mw=9&strike=193&turbo=12`);
  await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.__app.startSim());
  await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
  await page.evaluate(() => window.__app.seekTo(72 * 60));
  await page.waitForFunction(() => !window.__app.running && window.__app.solver.t > 4200, null, { timeout: 300000 });
  for (const [scene, lon, lat, km] of [['regional', 141, 37.5, 2500], ['coast', 141, 38.3, 45]]) {
    await page.evaluate(([lo, la, width]) => {
      const a = window.__app, c = a.camera;
      a.setCollapsed(true);
      c.resetView();
      c.jumpTo(lo, la, c.altMin * width / c.minViewKm);
    }, [lon, lat, km]);
    await page.waitForTimeout(3500);
    const before = await page.evaluate(() => window.__app.solver.t);
    for (const style of ['color', 'wireframe']) {
      await page.evaluate(s => window.__app.setDesignStyle(s), style);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `dev/shots/design-${scene}-${style}.png` });
    }
    const after = await page.evaluate(() => window.__app.solver.t);
    if (before !== after) throw new Error('Comparison time changed');
    console.log(JSON.stringify({ scene, seconds: before, errors }));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { const a = window.__app, c = a.camera; c.jumpTo(141, 37.5, c.altMin * 2500 / c.minViewKm); a.setDesignStyle('wireframe'); });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'dev/shots/design-phone-wireframe.png' });
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser.close(); }
