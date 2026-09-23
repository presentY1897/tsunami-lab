// 앱이 실제로 내려받는 양을 잰다. 전송 바이트(압축 후)를 출처별로 합산한다.
// 사용: node dev/measure-network.mjs <port> <preset> <quality>
import { launchBrowser } from './launch.mjs';
const [port = '4183', preset = 'tohoku2011', quality = 'medium'] = process.argv.slice(2);
const b = await launchBrowser();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
const urls = new Map(); const rows = [];
cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
cdp.on('Network.loadingFinished', (e) => rows.push({ url: urls.get(e.requestId) ?? '', bytes: e.encodedDataLength, phase }));
let phase = 'setup';
const cat = (u) => u.includes('elevation-tiles-prod') ? '지형 타일 (AWS)' : u.includes('openfreemap') ? '벡터 지도 (OpenFreeMap)' : /fonts\.(googleapis|gstatic)/.test(u) ? '웹폰트' : u.includes(`localhost:${port}`) ? '앱 코드' : '기타';
await p.goto(`http://localhost:${port}/?preset=${preset}&quality=${quality}`);
await p.waitForTimeout(9000);
phase = 'sim';
await p.evaluate(() => window.__tsunami.start());
await p.waitForFunction(() => window.__tsunami.mode === 'sim', null, { timeout: 300000 });
await p.waitForTimeout(1500);
const sum = {};
for (const r of rows) { const k = `${r.phase} | ${cat(r.url)}`; sum[k] ??= { n: 0, bytes: 0 }; sum[k].n++; sum[k].bytes += r.bytes; }
let total = 0;
console.log(`== ${preset} / ${quality} (모바일 뷰포트 390x844)`);
for (const [k, v] of Object.entries(sum).sort()) { total += v.bytes; console.log(`${k.padEnd(40)} ${String(v.n).padStart(4)}건 ${(v.bytes / 1024).toFixed(0).padStart(7)} KB`); }
console.log(`${'합계'.padEnd(40)} ${String(rows.length).padStart(4)}건 ${(total / 1024).toFixed(0).padStart(7)} KB`);
const grids = await p.evaluate(() => window.__tsunami.sim.grids.map((g) => `z${g.z} ${g.nx}x${g.ny}`));
console.log('격자:', grids.join(', '));
await b.close();
