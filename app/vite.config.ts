import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { seoPlugin } from './seo.ts';

// 실제 앱. 빌드 결과물은 정적 파일뿐이다. 앱은 이 폴더 밖의 코드를 가져다 쓰지 않는다(D-046). 저장소 루트의 src/는 프로토타입 2다.
export default defineConfig(({ mode }) => ({
  plugins: [seoPlugin(loadEnv(mode, process.cwd(), 'SITE_URL').SITE_URL)],
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  server: { port: 5190 },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
}));
