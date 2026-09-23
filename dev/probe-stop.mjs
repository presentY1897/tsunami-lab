// 파가 잦아들어 계산이 멈추는 시각을 잰다. 도호쿠(규모 9.0) 또는 동해 소행성. 사용: node dev/probe-stop.mjs <port> [quake|impact] [지름 m]
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5192', kind = process.argv[3] ?? 'quake', diameter = Number(process.argv[4] ?? 500);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
await page.addInitScript((d) => { window.__diam = d; }, diameter);
await page.goto(`http://localhost:${port}/?turbo=10`);
await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
if (kind === 'quake') await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(150, 34, a.camera.altFit * 0.6); a.tap(142.85, 38.3); });
else await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(134, 39, a.camera.altFit * 0.35); a.tap(134, 39.5); a.setImpact({ diameter: window.__diam, velocity: 20, density: 3000 }); });
await page.waitForTimeout(800);
await page.evaluate(() => { void window.__app.startSim(); });
await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
await page.evaluate(() => window.__app.runUntil(1e9));
const t0 = Date.now();
let last = 0;
while (true) {
  let st;
  try { st = await page.evaluate(() => ({ t: window.__app.solver.t, finished: window.__app.finished, max: window.__app.solver.maxAbsEta(), lastChange: window.__app.judge ? window.__app.judge.lastChangeT : -1 })); } catch { break; }
  if (st.t - last >= 6 * 3600 || st.finished) { console.log(`  ${(st.t / 3600).toFixed(1)}시간: 가장 큰 |수위| ${st.max.toFixed(3)} m, 해안 마지막 변화 ${(st.lastChange / 3600).toFixed(1)}시간, 벽시계 ${((Date.now() - t0) / 1000).toFixed(0)} s${st.finished ? `, 멈춤(${st.finished})` : ''}`); last = st.t; }
  if (st.finished || Date.now() - t0 > 555000) break;
  await page.waitForTimeout(process.env.GPU === '1' ? 300 : 2000);
}
await browser.close();
