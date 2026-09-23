import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeLines, encodeLines, joinLinesFile, QUANT, splitLinesFile } from '../../app/src/data/lines-codec';

describe('경계선 자료', () => {
  it('선 목록이 1/1000도 안에서 되읽힌다', () => {
    const lines: [number, number][][] = [
      [[126.9, 37.5], [127.1, 37.6], [-179.99, 0.001], [179.99, -0.001]],
      [[0, 0]],
    ];
    const { header, body } = encodeLines([{ name: 'coast', lines }, { name: 'border', lines: [] }]);
    const back = decodeLines({ ...header, source: 'test' }, body);
    const coast = back.get('coast')!;
    expect(coast.length).toBe(2);
    expect(back.get('border')!.length).toBe(0);
    lines[0].forEach(([lon, lat], i) => {
      expect(Math.abs(coast[0].coords[i * 2] - lon)).toBeLessThanOrEqual(0.5 / QUANT + 1e-6);
      expect(Math.abs(coast[0].coords[i * 2 + 1] - lat)).toBeLessThanOrEqual(0.5 / QUANT + 1e-6);
    });
  });

  it('배포 파일이 있고 한반도 해안이 들어 있다', () => {
    const file = new Uint8Array(readFileSync(new URL('../../app/public/data/boundaries-110m.bin', import.meta.url)));
    const { header, payload } = splitLinesFile(file);
    const lines = decodeLines(header, new Uint8Array(gunzipSync(payload)));
    expect(header.kinds.map((k) => k.name)).toEqual(['coast', 'border']);
    let nearBusan = 0;
    for (const l of lines.get('coast')!) for (let i = 0; i < l.coords.length; i += 2) if (Math.abs(l.coords[i] - 129.0) < 0.3 && Math.abs(l.coords[i + 1] - 35.1) < 0.3) nearBusan++;
    expect(nearBusan).toBeGreaterThan(0);
    expect(file.length).toBeLessThan(60 * 1024);
    // 되읽기 검증에 쓴 헤더가 파일 크기와 맞는다
    expect(joinLinesFile(header, payload).length).toBe(file.length);
  });
});

import { simplify } from '../../app/src/globe/lines';

describe('선 단순화', () => {
  it('양 끝점을 지키고, 오차 안의 점을 솎아내며, 오차 밖의 굴곡은 남긴다', () => {
    // 거의 직선인 해안 100점 + 가운데 큰 굴곡 하나
    const pts: number[] = [];
    for (let i = 0; i <= 100; i++) pts.push(130 + i * 0.01, 35 + i * 0.002 + (i === 50 ? 0.5 : 0) + Math.sin(i) * 0.0005);
    const src = Float32Array.from(pts);
    const out = simplify(src, 0.02);
    expect(out.length / 2).toBeLessThan(12);
    expect(out.length / 2).toBeGreaterThanOrEqual(3);
    expect([out[0], out[1]]).toEqual([src[0], src[1]]);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([src[src.length - 2], src[src.length - 1]]);
    let hasBend = false;
    for (let i = 0; i < out.length; i += 2) if (Math.abs(out[i] - 130.5) < 1e-6) hasBend = true;
    expect(hasBend).toBe(true);
    expect(simplify(src, 0)).toBe(src);
  });
});
