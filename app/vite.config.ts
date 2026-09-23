import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 실제 앱. 빌드 결과물은 정적 파일뿐이다. 저장소 루트의 src/는 프로토타입 2이고, 검증된 모듈만 가져다 쓴다.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  server: { port: 5190, fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
