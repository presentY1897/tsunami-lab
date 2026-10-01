import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 480_000, // 앱 검사는 시나리오 둘을 끝까지 돌려 3분을 넘긴다
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5183',
    locale: 'ko-KR', // Existing scenarios assert Korean copy; i18n tests override this.
    viewport: { width: 1440, height: 900 },
    // 누를 수 없는 요소를 기다리다 검사 전체 시간(8분)을 다 쓰지 않게 한다
    actionTimeout: 30_000,
    // GPU=1이면 WSLg 창(헤디드)에 Mesa d3d12 드라이버를 강제해 실제 GPU를 쓴다(D-041, 약 50배 빠르다). 아니면 헤드리스 SwiftShader.
    ...(process.env.GPU === '1'
      ? { headless: false, launchOptions: { args: ['--ignore-gpu-blocklist'], env: { ...process.env, MESA_LOADER_DRIVER_OVERRIDE: 'd3d12', GALLIUM_DRIVER: 'd3d12', MESA_D3D12_DEFAULT_ADAPTER_NAME: 'NVIDIA' } } }
      : { launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } }),
  },
  webServer: [
    // 프로토타입 2
    { command: 'npx vite --port 5183 --strictPort', url: 'http://localhost:5183', reuseExistingServer: true, timeout: 60_000 },
    // 실제 앱(app/). 전송량을 재야 하므로 빌드한 결과물을 띄운다.
    { command: 'npx vite build --config app/vite.config.ts && npx vite preview --config app/vite.config.ts --port 5191 --strictPort', url: 'http://localhost:5191', reuseExistingServer: true, timeout: 120_000 },
  ],
});
