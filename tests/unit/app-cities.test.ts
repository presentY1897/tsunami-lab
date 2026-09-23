import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { minPopKFor } from '../../app/src/globe/cities';

describe('주요 도시 자료', () => {
  const file = readFileSync(new URL('../../app/public/data/cities.bin', import.meta.url));
  const json = JSON.parse(gunzipSync(file).toString()) as { cities: [string, number, number, number, number, string][] };
  it('배포 파일이 상한 안이고 한글 이름으로 한국과 일본의 해안 도시가 들어 있다', () => {
    expect(file.length).toBeLessThan(80 * 1024);
    expect(json.cities.length).toBeGreaterThan(1500);
    const names = new Map(json.cities.map((c) => [c[0], c]));
    for (const n of ['부산', '센다이', '강릉', '도쿄', '서울']) expect(names.has(n)).toBe(true);
    expect(names.get('도쿄')![5]).toBe('Tokyo');
    expect(names.get('센다이')![5]).toBe('Sendai');
    expect(json.cities.every(c => typeof c[5] === 'string' && c[5].length > 0)).toBe(true);
    expect(names.get('부산')![3]).toBeGreaterThan(3000); // 천 명 단위
    expect(Math.abs(names.get('센다이')![1] - 140.87)).toBeLessThan(0.05);
    // 인구 내림차순이라 이름표를 앞에서부터 고를 수 있다
    for (let i = 1; i < json.cities.length; i++) expect(json.cities[i][3]).toBeLessThanOrEqual(json.cities[i - 1][3]);
  });
  it('넓게 볼수록 큰 도시만 남긴다', () => {
    expect(minPopKFor(12000)).toBeGreaterThan(minPopKFor(2000));
    expect(minPopKFor(2000)).toBeGreaterThan(minPopKFor(300));
    expect(minPopKFor(50)).toBe(0);
  });
});
