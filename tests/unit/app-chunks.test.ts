import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { chunksForBox, decodeChunk, type Gunzip } from '../../app/src/data/chunks';
import { assembleGrid, splitFile } from '../../app/src/data/codec';
import { CHUNK_SIZE, GLOBAL_FILE, chunkFile } from '../../app/src/data/layout';

const gunzip: Gunzip = async (b) => new Uint8Array(gunzipSync(b));
const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../app/public/${rel}`, import.meta.url)));

describe('10 km 조각', () => {
  it('경위도 상자가 걸치는 조각을 고른다', () => {
    // 동해와 일본: 경도 125~146, 위도 30~46 은 조각 열 13~14, 행 5~6 에 걸친다
    expect(chunksForBox(125, 30, 146, 46)).toEqual([[13, 5], [14, 5], [13, 6], [14, 6]]);
    // 날짜변경선을 넘는 상자는 열이 순환한다
    expect(chunksForBox(170, 2, -170, 10)).toEqual([[15, 7], [0, 7]]);
    // 자료가 없는 고위도는 비어 있다
    expect(chunksForBox(0, 80, 10, 84)).toEqual([]);
  });

  it('이웃한 조각은 경계에서 매끄럽게 이어지고, 전 지구 자료와 같은 지형을 가리킨다', async () => {
    const a = read(chunkFile(13, 6)), b = read(chunkFile(14, 6));
    const left = await decodeChunk(a, gunzip), right = await decodeChunk(b, gunzip);
    expect(left.length).toBe(CHUNK_SIZE * CHUNK_SIZE);
    // 경계를 가로지르는 차이가 조각 안쪽의 이웃 차이와 같은 크기여야 한다
    let seam = 0, inner = 0;
    for (let j = 0; j < CHUNK_SIZE; j++) {
      seam += Math.abs(right[j * CHUNK_SIZE] - left[j * CHUNK_SIZE + CHUNK_SIZE - 1]);
      inner += Math.abs(left[j * CHUNK_SIZE + CHUNK_SIZE - 1] - left[j * CHUNK_SIZE + CHUNK_SIZE - 2]);
    }
    expect(seam).toBeLessThan(inner * 2 + 1);

    // 조각 (14, 6)의 4×4 평균이 39 km 전 지구 자료의 같은 자리와 육지·바다 판정에서 대체로 일치한다
    const g = splitFile(read(GLOBAL_FILE));
    const grid = assembleGrid(g.header, new Uint8Array(gunzipSync(g.payload)));
    let agree = 0, total = 0;
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
      let sum = 0;
      for (let dj = 0; dj < 4; dj++) for (let di = 0; di < 4; di++) sum += right[(j * 4 + dj) * CHUNK_SIZE + i * 4 + di];
      const coarse = grid[(6 * 64 + j) * g.header.size + 14 * 64 + i];
      if (Math.abs(coarse) < 50) continue; // 해안 근처는 평균 방식 차이로 갈릴 수 있다
      total++;
      if (sum / 16 < 0 === coarse < 0) agree++;
    }
    expect(agree / total).toBeGreaterThan(0.97);
  });

  it('자료 파일이 빠짐없이 있다', () => {
    for (let y = 3; y <= 12; y++) for (let x = 0; x < 16; x++) expect(existsSync(new URL(`../../app/public/${chunkFile(x, y)}`, import.meta.url))).toBe(true);
  });
});
