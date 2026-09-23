// 검증용 브라우저를 띄운다. GPU=1이면 WSLg 창(헤디드)에 Mesa d3d12 드라이버를 강제해 실제 GPU를 쓴다(D-041).
// 헤드리스는 어떤 플래그를 줘도 SwiftShader로 떨어진다(2026-09-23 확인, dev/probe-gpu.mjs).
import { chromium } from 'playwright';
export const GPU = process.env.GPU === '1';
export const GPU_ENV = { MESA_LOADER_DRIVER_OVERRIDE: 'd3d12', GALLIUM_DRIVER: 'd3d12', MESA_D3D12_DEFAULT_ADAPTER_NAME: 'NVIDIA' };
export function launchBrowser(extra = {}) {
  if (GPU) return chromium.launch({ headless: false, args: ['--ignore-gpu-blocklist', '--window-position=0,0'], env: { ...process.env, ...GPU_ENV }, ...extra });
  return chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...extra });
}
