import { defineConfig } from 'vitest/config';

// 단위 테스트(vitest)와 dev/의 검증 페이지를 띄우는 개발 서버의 설정이다. 앱의 빌드 설정은 app/vite.config.ts에 있다.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
