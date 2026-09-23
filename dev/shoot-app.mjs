// 실제 앱(app/)의 첫 화면을 헤드리스 브라우저로 띄워 화면을 찍고 전송량을 잰다.
// 사용: node dev/shoot-app.mjs <port>
import { launchBrowser } from './launch.mjs';
const port = process.argv[2] ?? '5190';
const browser = await launchBrowser();
const views = [
  { name: 'phone', opts: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  { name: 'desktop', opts: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
];
for (const v of views) {
  const ctx = await browser.newContext(v.opts);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const urls = new Map(); const rows = [];
  cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
  cdp.on('Network.loadingFinished', (e) => rows.push({ url: urls.get(e.requestId) ?? '', bytes: e.encodedDataLength }));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  console error:', m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
  console.log(`== ${v.name}: 준비까지 ${Date.now() - t0} ms`);
  let total = 0;
  for (const r of rows) { total += r.bytes; console.log(`   ${(r.bytes / 1024).toFixed(1).padStart(7)} KB  ${r.url.replace(/^https?:\/\/[^/]+/, '')}`); }
  console.log(`   합계 ${(total / 1024).toFixed(1)} KB`);
  // [이름, 경도, 위도, 보이는 폭(km) 또는 null(지구 전체), 누를 지점]
  const shots = [
    ['globe', 135, 28, null, null],
    ['eastasia', 133, 37, 2500, null],
    ['korea-east', 129.2, 37.6, 300, null],
    ['gangneung', 128.95, 37.78, 40, [128.95, 37.80]],
    ['sendai-min', 141.0, 38.2, 0, null],
    ['alps', 137.7, 36.3, 60, null],
    ['tilted', 128.95, 37.78, 40, null],
  ];
  for (const [name, lon, lat, viewKm, tap] of shots) {
    await page.evaluate(([lo, la, km, nm]) => {
      const c = window.__app.camera;
      // 보이는 폭은 거리에 비례한다
      const alt = km === null ? c.altFit : km === 0 ? c.altMin : c.altMin * (km / c.minViewKm);
      c.resetView();
      c.jumpTo(lo, la, alt);
      if (nm === 'tilted') { c.tiltOffset = 20 * Math.PI / 180; c.heading = -60 * Math.PI / 180; c.jumpTo(lo, la, alt); }
    }, [lon, lat, viewKm, name]);
    // 조각과 50m 경계선이 도착하고 메시가 다시 만들어질 때까지 기다린다
    await page.waitForTimeout(3500);
    if (tap) await page.evaluate(([lo, la]) => window.__app.tap(lo, la), tap);
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => { const a = window.__app, m = a.mesh; return { faces: m.faces, minEdgeKm: +m.minEdgeKm.toFixed(3), buildMs: +m.buildMs.toFixed(1), edgePx: +a.edgePx.toFixed(1), viewKm: Math.round(a.camera.viewWidthKm), tiltDeg: Math.round(a.camera.tilt * 57.3), chunks: a.chunks.loadedCount, chunkKB: Math.round(a.chunks.bytesLoaded / 1024), gpuMB: +(a.gpuBytes / 1e6).toFixed(1) }; });
    console.log(`   ${name}:`, JSON.stringify(st));
    await page.screenshot({ path: `dev/shots/app-${v.name}-${name}.png` });
  }
  // 발생원을 놓고 파도를 일으킨 화면
  await page.evaluate(() => { const a = window.__app; a.camera.jumpTo(150, 34, a.camera.altFit * 0.6); a.tap(142.85, 38.3); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `dev/shots/app-${v.name}-place.png` });
  await page.evaluate(() => { void window.__app.startSim(); });
  await page.waitForFunction(() => window.__app.solver !== null, null, { timeout: 120000 });
  // 경험식 침수 전선(D-034): 센다이 해안에 물이 밀려드는 모습을 큰 파의 앞머리가 닿는 약 50분 뒤 56분과 72분에 본다. 패널은 접어 둔다
  await page.evaluate(() => window.__app.setCollapsed(true));
  for (const min of [56, 72]) {
    await page.evaluate((m) => window.__app.runUntil(m * 60), min);
    await page.waitForFunction((m) => (window.__app.solver?.t ?? 0) >= m * 60 - 30, min, { timeout: 300000, polling: 300 });
    await page.evaluate(() => { const c = window.__app.camera; c.resetView(); c.jumpTo(141.0, 38.3, c.altMin * (45 / c.minViewKm)); });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `dev/shots/app-${v.name}-runup-${min}m.png` });
  }
  await page.evaluate(() => window.__app.setCollapsed(false));
  await page.evaluate(() => window.__app.runUntil(2.5 * 3600));
  await page.waitForFunction(() => (window.__app.solver?.t ?? 0) >= 2.5 * 3600 - 30, null, { timeout: 600000, polling: 300 });
  await page.evaluate(() => window.__app.solver.readCell(0, 0));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `dev/shots/app-${v.name}-wave.png` });
  // 파도 높이 그리기 세 방식을 같은 화면에서 비교한다. 90 km(해안 가까이)와 600 km(먼 바다)의 두 폭. 패널은 접어 둔다
  await page.evaluate(() => window.__app.setCollapsed(true));
  for (const km of [90, 600]) {
    await page.evaluate((w) => { const c = window.__app.camera; c.resetView(); c.jumpTo(141.6, 38.6, c.altMin * (w / c.minViewKm)); }, km);
    for (const mode of ['real', 'coastReal', 'boost']) {
      await page.evaluate((m) => window.__app.setWaveScale(m), mode);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `dev/shots/app-${v.name}-wavescale-${km}km-${mode}.png` });
    }
  }
  await page.evaluate(() => window.__app.setWaveScale('coastReal'));
  await page.evaluate(() => window.__app.setCollapsed(false));
  // 해안을 고르지 않았으므로 침수는 경험식 판정이다. 판정이 들어온 뒤 산리쿠·센다이 해안을 가까이 본다.
  await page.waitForFunction(() => window.__app.judge?.any === true, null, { timeout: 60000 });
  await page.evaluate(() => { const c = window.__app.camera; c.resetView(); c.jumpTo(141.0, 38.35, c.altMin * (70 / c.minViewKm)); });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `dev/shots/app-${v.name}-judge.png` });
  // 패널을 접고 옮긴 모습
  await page.evaluate(() => window.__app.setCollapsed(true));
  await page.evaluate(() => { const h = document.getElementById('sheetHead'); const r = h.getBoundingClientRect(); const ev = (t, x, y) => h.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true })); ev('pointerdown', r.left + 40, r.top + 10); ev('pointermove', r.left + 40 - 300, r.top + 10 - 400); ev('pointerup', r.left + 40 - 300, r.top + 10 - 400); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `dev/shots/app-${v.name}-collapsed.png` });
  await page.evaluate(() => window.__app.setCollapsed(false));
  console.log('   판정 도시:', JSON.stringify(await page.evaluate(() => window.__app.judge.cityImpacts(window.__app.cities.cities, 6).map((c) => `${c.name} ${c.runup.toFixed(1)}m`))));
  await ctx.close();
}
await browser.close();
