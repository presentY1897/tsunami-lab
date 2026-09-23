// 전 지구 계산을 실제 사건과 비교한다. 2011 도호쿠 지진을 일으키고 도달 시각을 읽는다.
// 사용: node dev/validate-global.mjs <port> [시간]
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5191', hours = Number(process.argv[3] ?? 10.5);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  console error:', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
await page.goto(`http://localhost:${port}/?turbo=10`);
await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(150, 35, a.camera.altFit); a.tap(142.85, 38.3); a.setQuake({ Mw: 9.0, strike: 193 }); a.setCoast(140.97, 38.17); });
await page.waitForTimeout(800);
await page.screenshot({ path: 'dev/shots/sim-0-place.png' });
const t0 = Date.now();
await page.evaluate(() => { window.__app.startSim(); window.__app.runUntil(0); });
await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
const info = await page.evaluate(() => { const s = window.__app.solver; return { dt: +s.dt.toFixed(1), ratios: s.ratios, roles: window.__app.specs.map((x) => `${x.role}:z${x.zoom}`), cells: s.cells, gpuMB: Math.round(s.gpuBytes / 1e6), chunkKB: Math.round(window.__app.chunks.bytesLoaded / 1024) }; });
console.log('격자:', JSON.stringify(info));
const marks = [0.5, 1.2, 2, 5, hours].filter((h, i, a) => h <= hours && a.indexOf(h) === i);
for (const h of marks) {
  await page.evaluate((hh) => window.__app.runUntil(hh * 3600), h);
  await page.waitForFunction((hh) => window.__app.solver.t >= hh * 3600 - 30, h, { timeout: 1800000, polling: 300 });
  // 자바스크립트는 GPU보다 앞서 나간다. 읽기를 한 번 해서 GPU가 따라오게 한 뒤에 화면을 찍는다.
  await page.evaluate(() => window.__app.solver.readCell(0, 0));
  // 자바스크립트는 GPU보다 앞서 나간다. 읽기를 한 번 해서 GPU가 따라오게 한 뒤에 화면을 찍는다.
  await page.evaluate(() => window.__app.solver.readCell(0, 0));
  if (h === 0.5) await page.evaluate(() => window.__app.camera.jumpTo(146, 36, window.__app.camera.altFit * 0.35));
  if (h === 1.2) await page.evaluate(() => { const c = window.__app.camera; c.jumpTo(140.95, 38.1, c.altMin * (45 / c.minViewKm)); });
  if (h === 2) await page.evaluate(() => window.__app.camera.jumpTo(160, 32, window.__app.camera.altFit * 0.7));
  if (h === 5) await page.evaluate(() => window.__app.camera.jumpTo(180, 30, window.__app.camera.altFit));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `dev/shots/sim-${h}h.png`, timeout: 180000 });
  const m = await page.evaluate(() => ({ steps: window.__app.solver.steps, faces: window.__app.mesh.faces, edgeKm: Math.round(window.__app.mesh.minEdgeKm), buildMs: Math.round(window.__app.mesh.buildMs), edgePx: +window.__app.edgePx.toFixed(1) }));
  console.log(`  ${h}시간 도달, 벽시계 ${((Date.now() - t0) / 1000).toFixed(0)} s,`, JSON.stringify(m), '활성:', JSON.stringify(await page.evaluate(() => window.__app.solver.levels.map((l) => l.active))), '스텝당 비용:', await page.evaluate(() => Math.round(window.__app.solver.costPerStep / 1e3)) + 'k');
}
// 도달 시각: 기록 텍스처의 G 채널. 해안 셀은 거친 격자에서 육지일 수 있으니 주변 바다 셀 중 가장 이른 값을 본다.
// 실제 도달 시각은 검조 기록의 대략값이다. 기억에 의존한 값이라 출처를 확인해서 고쳐야 한다(docs/PLAN.md).
const places = [['하와이 힐로', -155.0, 19.8, 7.6], ['미드웨이', -177.4, 28.2, 4.7], ['미국 크레센트시티', -124.3, 41.7, 9.8]];
const res = await page.evaluate((list) => {
  const a = window.__app, s = a.solver, g = a.grid, rec = s.readRecord(), nx = g.input.nx, ny = g.input.ny;
  return list.map(([name, lon, lat, real]) => {
    const [ci, cj] = g.cellOf(lon, lat);
    let best = Infinity, maxEta = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = ((ci + di) % nx + nx) % nx, j = Math.max(0, Math.min(ny - 1, cj + dj)), k = j * nx + i;
      if (!g.input.wet0[k]) continue;
      const t = rec[k * 4 + 1];
      if (t >= 0 && t < best) best = t;
      maxEta = Math.max(maxEta, rec[k * 4]);
    }
    return { name, model: Number.isFinite(best) ? +(best / 3600).toFixed(2) : null, real, maxEta: +maxEta.toFixed(2) };
  });
}, places);
console.log('도달 시각(시간). model = 계산, real = 실제 기록의 대략값');
for (const r of res) console.log(`  ${r.name}: 계산 ${r.model}, 실제 약 ${r.real}, 근처 최대 수위 ${r.maxEta} m`);
// 세밀 격자: 센다이 앞바다(수심 100~200 m)의 최대 수위. 실측 검조 기록은 약 6~9 m(GPS 파랑계 약 6.7 m, 해안 검조소 8 m 이상)
const fineRes = await page.evaluate(() => {
  const a = window.__app, s = a.solver, lv = s.levels[1], g = lv.grid, rec = s.readRecord(1);
  const spec = { px0: g.px0, py0: g.py0, z: g.zoom };
  const cell = (lon, lat) => { const n = 256 * 2 ** spec.z; const i = Math.floor(((lon + 180) / 360) * n) - spec.px0; const j = Math.floor(((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2) * n) - spec.py0; return [i, j]; };
  const probe = (name, lon, lat) => {
    const [ci, cj] = cell(lon, lat);
    if (ci < 1 || cj < 1 || ci >= g.nx - 1 || cj >= g.ny - 1) return { name, outside: true };
    let best = 0, arr = Infinity;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const k = (cj + dj) * g.nx + ci + di; if (!g.wet0[k]) continue; best = Math.max(best, rec[k * 4]); const t = rec[k * 4 + 1]; if (t >= 0) arr = Math.min(arr, t); }
    return { name, maxEta: +best.toFixed(2), arrivalMin: Number.isFinite(arr) ? Math.round(arr / 60) : null, depth: Math.round(-g.bed[cj * g.nx + ci]) };
  };
  return [probe('센다이 앞바다', 141.15, 38.2), probe('미야코 앞바다', 142.05, 39.65), probe('사카이미나토 앞바다(동해 쪽)', 133.2, 35.7), probe('하코다테 앞바다', 140.8, 41.7), probe('강릉 앞바다', 129.0, 37.8)];
});
console.log('세밀 격자 최대 수위(m). 실제: 센다이 앞바다 약 6~9 m, 한국 동해안 수 cm');
for (const r of fineRes) console.log(r.outside ? `  ${r.name}: 세밀 격자 밖` : `  ${r.name}: ${r.maxEta} m, 첫 도달 ${r.arrivalMin}분, 수심 ${r.depth} m`);
// 해안 격자(480 m): 침수 통계. 실제 2011 센다이 평야는 해안에서 약 5 km까지 잠겼고 침수 면적은 약 100 km²(나토리·와타리 포함)다.
const coastRes = await page.evaluate(() => {
  const a = window.__app, s = a.solver, i = a.specs.findIndex((x) => x.role === 'coast');
  if (i < 0) return null;
  const lv = s.levels[i], g = lv.grid, rec = s.readRecord(i);
  const cell = (40075016.686 / g.world) * Math.cos((38.17 * Math.PI) / 180);
  let flooded = 0, runup = 0, maxDepth = 0, firstArr = Infinity;
  for (let k = 0; k < g.nx * g.ny; k++) {
    if (g.wet0[k] || rec[k * 4] < -1e4) continue;
    const d = rec[k * 4] - g.bed[k];
    if (d > 0.05) { flooded++; runup = Math.max(runup, g.bed[k]); maxDepth = Math.max(maxDepth, d); const t = rec[k * 4 + 1]; if (t >= 0) firstArr = Math.min(firstArr, t); }
  }
  return { cellM: Math.round(cell), areaKm2: +(flooded * cell * cell / 1e6).toFixed(1), runup: +runup.toFixed(1), maxDepth: +maxDepth.toFixed(1), firstArrMin: Number.isFinite(firstArr) ? Math.round(firstArr / 60) : null, active: lv.active, steps: lv.steps };
});
// 경험식 판정(D-031): 도시별 처오름. 실측 처오름: 미야코 최대 약 38 m(일반 구간 10~20), 센다이 평야 10~12, 이시노마키 8~10, 이와키 약 8, 하코다테 약 3, 미야자키 1~2 m
const impacts = await page.evaluate(() => window.__app.judge.cityImpacts(window.__app.cities.cities, 12).map((c) => `${c.name} ${c.runup.toFixed(1)} m(${Math.round(c.inland / 100) / 10} km, ${c.arrival >= 0 ? Math.round(c.arrival / 60) + '분' : '-'})`));
console.log('경험식 판정, 처오름 큰 도시:', impacts.join(', '));
console.log('해안 격자 침수(센다이 평야 123 km 상자). 실제: 침수 약 100 km², 내륙 5 km, 육지 첫 침수 약 60분');
console.log(' ', JSON.stringify(coastRes));
await browser.close();
