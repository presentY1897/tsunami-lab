// 경계선(해안선, 국경) 자료의 인코딩과 디코딩. 빌드 스크립트(Node)와 앱(브라우저)이 같이 쓴다. 다른 모듈을 import하지 않는다.
//
// 파일 구조: "BND1" + 헤더 길이(u32 LE) + 헤더(JSON) + gzip(본문).
// 본문: 선마다 [점 수(varint)] 뒤에 점들의 경위도 차분(zigzag varint, 1/1000도 단위). 첫 점은 0에서의 차분이다.
// 종류(해안선, 국경)마다 선 수를 헤더에 적는다.

export const LINES_MAGIC = 'BND1';
/** 좌표 양자화 단위(도). 1/1000도 = 약 110 m. 50m 자료의 정밀도(약 1 km)보다 잘다. */
export const QUANT = 1000;

export interface LinesHeader {
  version: 1;
  kinds: { name: string; lines: number; points: number }[];
  source: string;
}

export interface Polyline {
  /** [lon, lat] 쌍이 이어진 배열. */
  coords: Float32Array;
}

function pushVarint(out: number[], v: number): void {
  let u = v >>> 0;
  while (u >= 0x80) { out.push((u & 0x7f) | 0x80); u >>>= 7; }
  out.push(u);
}
const zigzag = (v: number): number => (v << 1) ^ (v >> 31);
const unzigzag = (u: number): number => (u >>> 1) ^ -(u & 1);

/** 종류별 선 목록을 본문 바이트로 만든다. 경위도는 [lon, lat] 쌍의 배열이다. */
export function encodeLines(kinds: { name: string; lines: [number, number][][] }[]): { header: Omit<LinesHeader, 'source'>; body: Uint8Array } {
  const out: number[] = [];
  const hk: LinesHeader['kinds'] = [];
  for (const k of kinds) {
    let points = 0;
    for (const line of k.lines) {
      pushVarint(out, line.length);
      let px = 0, py = 0;
      for (const [lon, lat] of line) {
        const qx = Math.round(lon * QUANT), qy = Math.round(lat * QUANT);
        pushVarint(out, zigzag(qx - px));
        pushVarint(out, zigzag(qy - py));
        px = qx; py = qy;
      }
      points += line.length;
    }
    hk.push({ name: k.name, lines: k.lines.length, points });
  }
  return { header: { version: 1, kinds: hk }, body: Uint8Array.from(out) };
}

export function decodeLines(header: LinesHeader, body: Uint8Array): Map<string, Polyline[]> {
  let pos = 0;
  const readVarint = (): number => {
    let v = 0, shift = 0, b: number;
    do { b = body[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return v >>> 0;
  };
  const out = new Map<string, Polyline[]>();
  for (const k of header.kinds) {
    const list: Polyline[] = [];
    for (let l = 0; l < k.lines; l++) {
      const n = readVarint();
      const coords = new Float32Array(n * 2);
      let px = 0, py = 0;
      for (let i = 0; i < n; i++) {
        px += unzigzag(readVarint());
        py += unzigzag(readVarint());
        coords[i * 2] = px / QUANT;
        coords[i * 2 + 1] = py / QUANT;
      }
      list.push({ coords });
    }
    out.set(k.name, list);
  }
  return out;
}

export function joinLinesFile(header: LinesHeader, gzipBody: Uint8Array): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + h.length + gzipBody.length);
  for (let i = 0; i < 4; i++) out[i] = LINES_MAGIC.charCodeAt(i);
  out[4] = h.length & 0xff; out[5] = (h.length >> 8) & 0xff; out[6] = (h.length >> 16) & 0xff; out[7] = (h.length >> 24) & 0xff;
  out.set(h, 8);
  out.set(gzipBody, 8 + h.length);
  return out;
}

export function splitLinesFile(file: Uint8Array): { header: LinesHeader; payload: Uint8Array } {
  if (String.fromCharCode(file[0], file[1], file[2], file[3]) !== LINES_MAGIC) throw new Error('경계선 자료 파일이 아니다');
  const len = file[4] | (file[5] << 8) | (file[6] << 16) | (file[7] << 24);
  return { header: JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + len))) as LinesHeader, payload: file.subarray(8 + len) };
}
