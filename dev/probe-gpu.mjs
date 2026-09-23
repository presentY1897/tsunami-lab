// 헤드리스/헤디드 Chromium이 어떤 렌더러(GPU 또는 소프트웨어)를 잡는지 여러 플래그로 확인한다. 사용: node dev/probe-gpu.mjs
import { chromium } from 'playwright';
const configs = [
  { name: '기본(현재)', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  { name: 'angle=gl + 차단목록 무시', headless: true, args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] },
  { name: 'gl=egl + 차단목록 무시', headless: true, args: ['--use-gl=egl', '--ignore-gpu-blocklist'] },
  { name: 'angle=vulkan + 차단목록 무시', headless: true, args: ['--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] },
  { name: '헤디드(WSLg) + 차단목록 무시', headless: false, args: ['--ignore-gpu-blocklist'] },
  { name: '헤디드(WSLg) angle=gl', headless: false, args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] },
];
const html = `<canvas id=c></canvas><script>
const gl = document.getElementById('c').getContext('webgl2');
const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
document.title = gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'no webgl2';
</script>`;
for (const c of configs) {
  let out;
  try {
    const browser = await chromium.launch({ headless: c.headless, args: c.args, timeout: 30000 });
    const page = await browser.newPage();
    await page.goto('data:text/html,' + encodeURIComponent(html));
    await page.waitForTimeout(500);
    out = await page.title();
    await browser.close();
  } catch (e) { out = '실패: ' + String(e.message).split('\n')[0].slice(0, 80); }
  console.log(`  ${c.name}: ${out}`);
}
