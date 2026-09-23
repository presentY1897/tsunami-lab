// 발생원 격자의 해안 칸에서 최대 수위, 초기 수위, 세 문턱값의 도달 시각(분)을 읽는다. 도달 문턱값을 고를 때 쓴다. 사용: node dev/probe-arrival.mjs <port>
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5192';
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(150, 34, a.camera.altFit * 0.6); a.tap(142.85, 38.3); });
await page.waitForTimeout(1000);
await page.evaluate(() => { void window.__app.startSim(); });
await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
await page.evaluate(() => window.__app.runUntil(2 * 3600));
await page.waitForFunction(() => (window.__app.solver?.t ?? 0) >= 2 * 3600 - 30, null, { timeout: 600000, polling: 300 });
const out = await page.evaluate(() => {
  const a = window.__app, lv = a.solver.levels[1], g = lv.grid, rec = a.solver.readRecord(1);
  const spots = { 센다이: [141.05, 38.25], 이와키: [141.0, 37.0], 하치노헤: [141.6, 40.5], 미토: [140.65, 36.35], 이시노마키: [141.4, 38.4] };
  const res = {};
  for (const [name, [lon, lat]] of Object.entries(spots)) {
    const px = ((lon + 180) / 360) * g.world, py = ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * g.world;
    const ci = Math.floor(px) - g.px0, cj = Math.floor(py) - g.py0;
    const rows = [];
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const k = j * g.nx + i; if (!g.wet0[k]) continue;
      const nb = [k - 1, k + 1, k - g.nx, k + g.nx].some((q) => q >= 0 && q < g.nx * g.ny && !g.wet0[q]);
      if (!nb) continue;
      rows.push({ di, dj, depth: Math.round(-g.bed[k]), eta0: +g.eta0[k].toFixed(2), max: +rec[k * 4].toFixed(2), t002: Math.round(rec[k * 4 + 1] / 60), t03: Math.round(rec[k * 4 + 2] / 60), t15: Math.round(rec[k * 4 + 3] / 60) });
    }
    res[name] = rows;
  }
  return res;
});
for (const [name, rows] of Object.entries(out)) { console.log(name); for (const r of rows) console.log('  ', JSON.stringify(r)); }
await browser.close();
