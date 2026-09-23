// 개발용: 앱을 헤드리스 브라우저로 띄워 시나리오를 돌리고 스크린샷을 남긴다.
// 사용: node dev/shoot.mjs [preset] [quality] [simMinutes,...]
import { chromium } from 'playwright';

const preset = process.argv[2] ?? 'tohoku2011';
const quality = process.argv[3] ?? 'low';
const marks = (process.argv[4] ?? '5,40,70').split(',').map(Number);
const port = process.env.PORT ?? '5183';
const gpu = process.env.SOFT ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'];

const browser = await chromium.launch({ args: [...gpu, '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { const t = m.text(); if (!t.startsWith('[vite]') && !t.includes('GPU stall')) console.log('  console:', t.slice(0, 2500)); });
page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));
await page.goto(`http://localhost:${port}/?preset=${preset}&quality=${quality}&turbo=${process.env.TURBO ?? 6}`);
await page.waitForTimeout(4000);
await page.screenshot({ path: `dev/shots/${preset}-setup.png` });
const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a', floatRT: !!gl?.getExtension('EXT_color_buffer_float') };
});
console.log('WebGL:', JSON.stringify(info));

const t0 = Date.now();
await page.evaluate(() => window.__tsunami.start());
await page.waitForFunction(() => window.__tsunami.mode === 'sim', null, { timeout: 120000 });
console.log(`built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.evaluate(() => { document.getElementById('speed').value = 'max'; });

for (const m of marks) {
  const w0 = Date.now();
  await page.waitForFunction((mm) => window.__tsunami.sim.solver.time >= mm * 60 || window.__tsunami.done, m, { timeout: 600000, polling: 250 });
  if (process.env.COAST) await page.evaluate(() => window.__tsunami.flyToCoast(0));
  await page.waitForTimeout(2600);
  const st = await page.evaluate(() => {
    const s = window.__tsunami.sim;
    return { t: Math.round(s.solver.time), active: s.solver.levels.map((l) => l.active), steps: s.solver.levels.map((l) => l.steps), stats: s.stats, gauge: s.gauge.length };
  });
  console.log(`t=${m}min wall=${((Date.now() - w0) / 1000).toFixed(1)}s`, JSON.stringify(st));
  await page.screenshot({ path: `dev/shots/${preset}-${String(m).padStart(3, '0')}.png` });
}
// 마지막 시점에서 표시 방식별로 한 장씩
await page.evaluate(() => { document.getElementById('run').click(); });
for (const ov of ['maxDepth', 'arrival']) {
  await page.evaluate((o) => window.__tsunami.setOverlay(o), ov);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `dev/shots/${preset}-overlay-${ov}.png` });
}
await page.evaluate(() => window.__tsunami.setOverlay('none'));
if (process.env.DRAPE) {
  await page.evaluate(() => document.getElementById('drape').click());
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `dev/shots/${preset}-drape.png` });
}
await browser.close();
