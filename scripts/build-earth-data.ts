// 전 지구 표고 자료를 만든다. 배포 전에 한 번 돌리는 빌드 작업이고, 결과 파일은 저장소에 넣는다.
//   node scripts/build-earth-data.ts
// 원자료: AWS Terrain Tiles(Terrarium) z2, 16장. ETOPO1 기반이라 육지와 해저가 함께 들어 있다.
// 결과 1: app/public/data/earth-z2.bin (약 39 km/px, 전 지구 한 장). 상한은 docs/DATA-BUDGET.md 1절의 450 KB.
// 결과 2: app/public/data/z4/{x}_{y}.bin (약 10 km/px, 256 px 조각 160개). 상한은 4절의 5.2 MB.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { assembleGrid, decodeBlock, encodeBlock, joinFile, splitFile, stepAt, type BlockSpec, type EarthHeader } from '../app/src/data/codec.ts';
import { CHUNK_COLS, CHUNK_ROW_MAX, CHUNK_ROW_MIN, CHUNK_SIZE, CHUNK_ZOOM, chunkFile } from '../app/src/data/layout.ts';

const ZOOM = 2;
const SIZE = 256 * 2 ** ZOOM;
const LIMIT_BYTES = 450 * 1024;
const OUT = new URL('../app/public/data/earth-z2.bin', import.meta.url);
const CACHE = new URL('./.cache/', import.meta.url);
const TILE_URL = (z: number, x: number, y: number): string => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

async function tile(z: number, x: number, y: number): Promise<Float32Array> {
  mkdirSync(CACHE, { recursive: true });
  const path = new URL(`${z}_${x}_${y}.png`, CACHE);
  if (!existsSync(path)) {
    const res = await fetch(TILE_URL(z, x, y));
    if (!res.ok) throw new Error(`타일 ${z}/${x}/${y} 응답 ${res.status}`);
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
  }
  const png = PNG.sync.read(readFileSync(path));
  const out = new Float32Array(256 * 256);
  for (let k = 0, o = 0; k < out.length; k++, o += 4) out[k] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
  return out;
}

const n = 2 ** ZOOM;
const grid = new Float32Array(SIZE * SIZE);
for (let ty = 0; ty < n; ty++) {
  for (let tx = 0; tx < n; tx++) {
    const t = await tile(ZOOM, tx, ty);
    for (let j = 0; j < 256; j++) grid.set(t.subarray(j * 256, (j + 1) * 256), (ty * 256 + j) * SIZE + tx * 256);
  }
}

// 본판은 위도 약 ±72.4도(행 208~816). 나중에 계산에 그대로 쓰므로 0.25 m, 1.25% 정밀도로 담는다.
// 극지 행은 지구를 그릴 때만 쓴다. Mercator에서 가로로 크게 늘어나 있으므로 4배 줄이고 1 m 간격으로 담는다.
const CAP = 208;
const blocks: BlockSpec[] = [
  { name: 'main', row0: CAP, rows: SIZE - 2 * CAP, cols: SIZE, xstep: 1, step0: 0.25, s: 20 },
  { name: 'north', row0: 0, rows: CAP, cols: SIZE / 4, xstep: 4, step0: 1, s: 20 },
  { name: 'south', row0: SIZE - CAP, rows: CAP, cols: SIZE / 4, xstep: 4, step0: 1, s: 20 },
];

function extract(b: BlockSpec): Float32Array {
  const out = new Float32Array(b.rows * b.cols);
  for (let j = 0; j < b.rows; j++) {
    for (let i = 0; i < b.cols; i++) {
      let sum = 0;
      for (let d = 0; d < b.xstep; d++) sum += grid[(b.row0 + j) * SIZE + i * b.xstep + d];
      out[j * b.cols + i] = sum / b.xstep;
    }
  }
  return out;
}

const parts = blocks.map((b) => encodeBlock(extract(b), b));
const raw = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
let off = 0;
for (const p of parts) { raw.set(p, off); off += p.length; }
const header: EarthHeader = { version: 1, zoom: ZOOM, size: SIZE, blocks, source: 'Mapzen/AWS Terrain Tiles z2 (ETOPO1, GMTED2010 외)' };
const file = joinFile(header, gzipSync(raw, { level: 9 }));

// 검증: 앱과 같은 경로로 되읽어 원자료와 비교한다
const back = splitFile(file);
const decoded = assembleGrid(back.header, gunzipSync(back.payload));
let worst = 0, signFlips = 0;
const main = blocks[0];
for (let j = main.row0; j < main.row0 + main.rows; j++) {
  for (let i = 0; i < SIZE; i++) {
    const k = j * SIZE + i;
    const ratio = Math.abs(decoded[k] - grid[k]) / (stepAt(grid[k], main.step0, main.s) / 2);
    if (ratio > worst) worst = ratio;
    if (grid[k] < -0.125 !== decoded[k] < -0.125 && Math.abs(grid[k]) > 0.25) signFlips++;
  }
}
console.log(`본판 ${main.cols}×${main.rows}, 극지 ${blocks[1].cols}×${blocks[1].rows} 두 장`);
// 간격은 값에 따라 커지므로 구간 끝에서는 중심에서 잰 간격보다 최대 step0/s의 절반(0.6%)만큼 넓다
const TOLERANCE = 1.01;
console.log(`복원 오차 / 허용 오차 최댓값 = ${worst.toFixed(3)} (${TOLERANCE} 이하여야 한다), 육지·바다 뒤바뀜 ${signFlips}셀`);
console.log(`압축 전 ${(raw.length / 1024).toFixed(0)} KB, 파일 ${(file.length / 1024).toFixed(1)} KB (상한 ${LIMIT_BYTES / 1024} KB)`);
if (worst > TOLERANCE || signFlips > 0) { console.error('검증 실패'); process.exit(1); }
if (file.length > LIMIT_BYTES) { console.error('예산 초과'); process.exit(1); }
mkdirSync(new URL('.', OUT), { recursive: true });
writeFileSync(OUT, file);
console.log(`저장: ${OUT.pathname}`);

// ---------- 10 km 조각 ----------
// AWS의 z4 타일 한 장이 그대로 조각 하나다. 같은 코덱으로 다시 인코딩하면 크기가 1/3쯤 된다.
const CHUNK_LIMIT_BYTES = 5.2 * 1024 * 1024;
const chunkSpec: BlockSpec = { name: 'main', row0: 0, rows: CHUNK_SIZE, cols: CHUNK_SIZE, xstep: 1, step0: 0.25, s: 20 };
const jobs: [number, number][] = [];
for (let y = CHUNK_ROW_MIN; y <= CHUNK_ROW_MAX; y++) for (let x = 0; x < CHUNK_COLS; x++) jobs.push([x, y]);
let chunkTotal = 0, chunkWorst = 0, chunkMax = 0;
const worker = async (): Promise<void> => {
  for (;;) {
    const job = jobs.pop();
    if (!job) return;
    const [x, y] = job;
    const src = await tile(CHUNK_ZOOM, x, y);
    const encoded = encodeBlock(src, chunkSpec);
    const h: EarthHeader = { version: 1, zoom: CHUNK_ZOOM, size: CHUNK_SIZE, blocks: [chunkSpec], source: `terrarium ${CHUNK_ZOOM}/${x}/${y}` };
    const f = joinFile(h, gzipSync(encoded, { level: 9 }));
    const dec = decodeBlock(gunzipSync(splitFile(f).payload), 0, chunkSpec);
    for (let k = 0; k < dec.length; k++) {
      const r = Math.abs(dec[k] - src[k]) / (stepAt(src[k], chunkSpec.step0, chunkSpec.s) / 2);
      if (r > chunkWorst) chunkWorst = r;
    }
    const out = new URL(`../app/public/${chunkFile(x, y)}`, import.meta.url);
    mkdirSync(new URL('.', out), { recursive: true });
    writeFileSync(out, f);
    chunkTotal += f.length;
    if (f.length > chunkMax) chunkMax = f.length;
  }
};
const count = jobs.length;
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`10 km 조각 ${count}개: 합계 ${(chunkTotal / 1024 / 1024).toFixed(2)} MB (상한 ${(CHUNK_LIMIT_BYTES / 1024 / 1024).toFixed(1)} MB), 평균 ${(chunkTotal / count / 1024).toFixed(1)} KB, 최대 ${(chunkMax / 1024).toFixed(1)} KB`);
console.log(`복원 오차 / 허용 오차 최댓값 = ${chunkWorst.toFixed(3)}`);
if (chunkWorst > TOLERANCE) { console.error('조각 검증 실패'); process.exit(1); }
if (chunkTotal > CHUNK_LIMIT_BYTES) { console.error('조각 예산 초과'); process.exit(1); }
