import { defineConfig } from 'vitest/config';

// 정적 파일만 배포한다. 서버 연산은 없다. base를 상대 경로로 두어 어떤 정적 호스팅 경로에서도 동작하게 한다.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
