// 큰 소행성에서 경험식 침수가 어디까지 가는지 넓은 화면으로 본다. 사용: node dev/probe-flood-extent.mjs <port> [시간] [지름 m]
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5192', hours = Number(process.argv[3] ?? 3), diameter = Number(process.argv[4] ?? 10000);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
await page.addInitScript((d) => { window.__diam = d; }, diameter);
await page.goto(`http://localhost:${port}/?turbo=10`);
await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(134, 39, a.camera.altFit * 0.35); a.tap(134, 39.5); a.setImpact({ diameter: window.__diam, velocity: 20, density: 3000 }); });
await page.waitForTimeout(800);
await page.evaluate(() => { window.__app.startSim(); window.__app.runUntil(0); });
await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
await page.evaluate(() => window.__app.setCollapsed(true));
for (const h of [1, hours]) {
  await page.evaluate((hh) => window.__app.runUntil(hh * 3600), h);
  await page.waitForFunction((hh) => window.__app.solver.t >= hh * 3600 - 30, h, { timeout: 1800000, polling: 300 });
  await page.evaluate(() => { const c = window.__app.camera; c.resetView(); c.jumpTo(128.5, 39.5, c.altMin * (1400 / c.minViewKm)); });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `dev/shots/flood-extent-${diameter}m-${h}h.png` });
  const st = await page.evaluate(() => { const a = window.__app; return { faces: a.mesh.faces, minEdgeKm: +a.mesh.minEdgeKm.toFixed(1), maxLimitKm: Math.round(a.judge.maxLimitKm()), big: a.judge.bigSources().items.length, cellDeg: +a.judge.bigSources().cellDeg.toFixed(2) }; });
  console.log(`  ${h}시간:`, JSON.stringify(st));
}
const impacts = await page.evaluate(() => window.__app.judge.cityImpacts(window.__app.cities.cities, 6).map((c) => `${c.name} ${Math.round(c.runup)} m(한계 ${Math.round(c.inland / 1000)} km)`));
console.log('판정 도시:', JSON.stringify(impacts));
await browser.close();
