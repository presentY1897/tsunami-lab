// 전 지구 표고 자료의 인코딩과 디코딩. 빌드 스크립트(Node)와 앱(브라우저)이 같이 쓴다.
// 다른 모듈을 import하지 않는다. Node가 타입만 걷어 내고 바로 실행할 수 있어야 하기 때문이다.
//
// 파일 구조: "TLE1" + 헤더 길이(u32 LE) + 헤더(JSON) + gzip(블록들).
// 블록 하나 = 양자화한 정수 격자의 평면 예측 잔차를 zigzag로 바꾼 뒤 하위 바이트 평면, 상위 바이트 평면 순으로 둔 것.
// 양자화는 asinh 압신이다. 0 m 근처는 step0 간격, 깊어질수록 상대 간격 step0/s로 수렴한다.
// 파속은 수심의 제곱근에 비례하므로 상대 오차 1.25%면 파속 오차는 0.6% 이하다.

export const MAGIC = 'TLE1';

export interface BlockSpec {
  name: 'main' | 'north' | 'south';
  /** 원본 격자에서의 시작 행과 행 수. */
  row0: number;
  rows: number;
  /** 저장한 열 수. 원본 열 수 / xstep. */
  cols: number;
  /** 가로 축소 배율. 극지 행은 Mercator에서 과하게 늘어나 있어 4배 줄여 담는다. */
  xstep: number;
  step0: number;
  s: number;
}

export interface EarthHeader {
  version: 1;
  /** Web Mercator 줌. 격자 한 변은 256 * 2^zoom. */
  zoom: number;
  size: number;
  blocks: BlockSpec[];
  source: string;
}

export const compand = (z: number, step0: number, s: number): number =>
  Math.round(Math.sign(z) * (s / step0) * Math.asinh(Math.abs(z) / s));

export const expand = (q: number, step0: number, s: number): number =>
  Math.sign(q) * s * Math.sinh(Math.abs(q) / (s / step0));

/** 값 z에서의 양자화 간격(m). 복원 오차는 이 값의 절반 이하다. */
export const stepAt = (z: number, step0: number, s: number): number => step0 * Math.sqrt(1 + (z / s) ** 2);

export const blockBytes = (b: BlockSpec): number => b.rows * b.cols * 2;

export function encodeBlock(values: Float32Array, b: BlockSpec): Uint8Array {
  const { rows, cols } = b;
  const q = new Int32Array(rows * cols);
  for (let k = 0; k < q.length; k++) q[k] = compand(values[k], b.step0, b.s);
  const out = new Uint8Array(rows * cols * 2);
  const n = rows * cols;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const left = i > 0 ? q[k - 1] : 0;
      const up = j > 0 ? q[k - cols] : 0;
      const upLeft = i > 0 && j > 0 ? q[k - cols - 1] : 0;
      const d = q[k] - (left + up - upLeft);
      const zz = d >= 0 ? d * 2 : -d * 2 - 1;
      if (zz > 0xffff) throw new Error(`잔차가 16비트를 넘는다: ${d}`);
      out[k] = zz & 0xff;
      out[n + k] = zz >> 8;
    }
  }
  return out;
}

export function decodeBlock(bytes: Uint8Array, offset: number, b: BlockSpec): Float32Array {
  const { rows, cols } = b;
  const n = rows * cols;
  const q = new Int32Array(n);
  const out = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const zz = bytes[offset + k] | (bytes[offset + n + k] << 8);
      const d = zz & 1 ? -((zz + 1) >> 1) : zz >> 1;
      const left = i > 0 ? q[k - 1] : 0;
      const up = j > 0 ? q[k - cols] : 0;
      const upLeft = i > 0 && j > 0 ? q[k - cols - 1] : 0;
      q[k] = d + left + up - upLeft;
      out[k] = expand(q[k], b.step0, b.s);
    }
  }
  return out;
}

/** 헤더와 gzip 본문을 나눈다. */
export function splitFile(file: Uint8Array): { header: EarthHeader; payload: Uint8Array } {
  const magic = String.fromCharCode(file[0], file[1], file[2], file[3]);
  if (magic !== MAGIC) throw new Error('표고 자료 파일이 아니다');
  const len = file[4] | (file[5] << 8) | (file[6] << 16) | (file[7] << 24);
  const header = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + len))) as EarthHeader;
  return { header, payload: file.subarray(8 + len) };
}

export function joinFile(header: EarthHeader, gzipPayload: Uint8Array): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + h.length + gzipPayload.length);
  out.set([MAGIC.charCodeAt(0), MAGIC.charCodeAt(1), MAGIC.charCodeAt(2), MAGIC.charCodeAt(3)], 0);
  out[4] = h.length & 0xff; out[5] = (h.length >> 8) & 0xff; out[6] = (h.length >> 16) & 0xff; out[7] = (h.length >> 24) & 0xff;
  out.set(h, 8);
  out.set(gzipPayload, 8 + h.length);
  return out;
}

/** 압축을 푼 본문에서 size×size 전체 격자를 만든다. 줄여 담은 블록은 가로로 선형 보간해 늘린다(경도 방향은 순환). */
export function assembleGrid(header: EarthHeader, raw: Uint8Array): Float32Array {
  const size = header.size;
  const grid = new Float32Array(size * size);
  let offset = 0;
  for (const b of header.blocks) {
    const vals = decodeBlock(raw, offset, b);
    offset += blockBytes(b);
    for (let j = 0; j < b.rows; j++) {
      const dst = (b.row0 + j) * size;
      if (b.xstep === 1) {
        grid.set(vals.subarray(j * b.cols, (j + 1) * b.cols), dst);
        continue;
      }
      for (let i = 0; i < size; i++) {
        // 저장된 셀 c의 중심은 원본 좌표 (c + 0.5) * xstep - 0.5
        const u = (i + 0.5) / b.xstep - 0.5;
        const c0 = Math.floor(u), t = u - c0;
        const a = vals[j * b.cols + ((c0 % b.cols) + b.cols) % b.cols];
        const c = vals[j * b.cols + (((c0 + 1) % b.cols) + b.cols) % b.cols];
        grid[dst + i] = a * (1 - t) + c * t;
      }
    }
  }
  return grid;
}
