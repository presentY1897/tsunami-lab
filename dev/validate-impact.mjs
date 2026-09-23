// 소행성 충돌을 실제 자료 대신 Ward & Asphaug 식과 비교한다. 동해 한가운데 암석 소행성(기본 500 m), 강릉 해안.
// 사용: node dev/validate-impact.mjs <port> [시간] [지름 m]
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5191', hours = Number(process.argv[3] ?? 2), diameter = Number(process.argv[4] ?? 500);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
await page.addInitScript((d) => { window.__diam = d; }, diameter);
await page.goto(`http://localhost:${port}/?turbo=10`);
await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(134, 39, a.camera.altFit * 0.35); a.tap(134, 39.5); a.setImpact({ diameter: window.__diam, velocity: 20, density: 3000 }); a.setCoast(128.93, 37.77); });
await page.waitForTimeout(800);
await page.evaluate(() => { window.__app.startSim(); window.__app.runUntil(0); });
await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
const info = await page.evaluate(() => { const s = window.__app.solver; return { roles: window.__app.specs.map((x) => `${x.role}:z${x.zoom}`), ratios: s.ratios, readout: document.getElementById('readout').textContent }; });
console.log(JSON.stringify(info));
const t0 = Date.now();
for (const h of [0.25, 0.75, hours]) {
  await page.evaluate((hh) => window.__app.runUntil(hh * 3600), h);
  await page.waitForFunction((hh) => window.__app.solver.t >= hh * 3600 - 30, h, { timeout: 1800000, polling: 300 });
  await page.evaluate(() => window.__app.solver.readCell(0, 0));
  if (h === 0.75) await page.evaluate(() => { const c = window.__app.camera; c.jumpTo(129.1, 37.75, c.altMin * (60 / c.minViewKm)); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `dev/shots/impact-${diameter}m-${h}h.png`, timeout: 180000 });
  console.log(`  ${h}시간 도달, 벽시계 ${((Date.now() - t0) / 1000).toFixed(0)} s, 활성: ${JSON.stringify(await page.evaluate(() => window.__app.solver.levels.map((l) => l.active)))}`);
}
// 발생원 격자(8 km)의 기록: 발생원에서 거리별 최대 수위(보정 포함)를 Ward & Asphaug 1/r 값과 비교한다
const res = await page.evaluate(() => {
  const a = window.__app, s = a.solver, lv = s.levels[1], g = lv.grid, rec = s.readRecord(1);
  const src = a.source, kx = 111195 * Math.cos((src.lat * Math.PI) / 180);
  const world = g.world;
  const out = [];
  for (const rKm of [60, 120, 180, 300, 500, 800]) {
    let sum = 0, n = 0;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      if (!g.wet0[k] || g.bed[k] > -500) continue;
      const lon = ((g.px0 + i + 0.5) / world) * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (g.py0 + j + 0.5)) / world))) * 180) / Math.PI;
      const r = Math.hypot((lon - src.lon) * kx, (lat - src.lat) * 111195) / 1000;
      if (Math.abs(r - rKm) < 12) { sum += rec[k * 4]; n++; }
    }
    out.push({ rKm, model: n ? +(sum / n).toFixed(2) : null, n });
  }
  return out;
});
const wa = await page.evaluate(() => { const r = document.getElementById('readout').textContent; return r; });
console.log('거리별 평균 최대 수위(m), 발생원 격자. 목표: 기준 거리(약 181 km)에서 Ward & Asphaug 값, 그 밖은 1/r');
for (const r of res) console.log(`  ${r.rKm} km: ${r.model} m (셀 ${r.n}개)`);
const coastRes = await page.evaluate(() => {
  const a = window.__app, s = a.solver, i = a.specs.findIndex((x) => x.role === 'coast');
  if (i < 0) return null;
  const lv = s.levels[i], g = lv.grid, rec = s.readRecord(i);
  const cell = (40075016.686 / g.world) * Math.cos((37.77 * Math.PI) / 180);
  let flooded = 0, runup = 0, first = Infinity;
  for (let k = 0; k < g.nx * g.ny; k++) {
    if (g.wet0[k] || rec[k * 4] < -1e4) continue;
    const d = rec[k * 4] - g.bed[k];
    if (d > 0.05) { flooded++; runup = Math.max(runup, g.bed[k]); const t = rec[k * 4 + 1]; if (t >= 0) first = Math.min(first, t); }
  }
  return { areaKm2: +(flooded * cell * cell / 1e6).toFixed(1), runup: +runup.toFixed(1), firstMin: Number.isFinite(first) ? Math.round(first / 60) : null, active: lv.active };
});
console.log('강릉 해안 격자 침수:', JSON.stringify(coastRes));
const impacts = await page.evaluate(() => window.__app.judge ? window.__app.judge.cityImpacts(window.__app.cities.cities, 8).map((c) => `${c.name} ${c.runup >= 100 ? Math.round(c.runup) : c.runup.toFixed(1)} m(${Math.round(c.inland / 1000)} km, ${c.arrival >= 0 ? Math.round(c.arrival / 60) + '분' : '-'})`) : null);
console.log('판정 도시:', JSON.stringify(impacts));
await browser.close();
