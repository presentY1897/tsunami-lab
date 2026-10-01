import { latToPy, lonToPx } from '../geo/mercator';
import { decodeBlock, splitFile } from './codec';
import { CHUNK_COLS, CHUNK_SIZE, CHUNK_ZOOM, chunkExists, chunkFile } from './layout';

/** gzip을 푸는 함수. 브라우저는 DecompressionStream, 테스트는 Node의 zlib을 넣는다. */
export type Gunzip = (bytes: Uint8Array) => Promise<Uint8Array>;

export const browserGunzip: Gunzip = async (bytes) => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export async function decodeChunk(file: Uint8Array, gunzip: Gunzip): Promise<Float32Array> {
  const { header, payload } = splitFile(file);
  return decodeBlock(await gunzip(payload), 0, header.blocks[0]);
}

/** 경위도 상자가 걸치는 조각의 좌표. 경도는 순환한다. 자료가 없는 고위도 행은 뺀다. */
export function chunksForBox(west: number, south: number, east: number, north: number): [number, number][] {
  const x0 = Math.floor(lonToPx(west, CHUNK_ZOOM) / CHUNK_SIZE);
  let x1 = Math.floor(lonToPx(east, CHUNK_ZOOM) / CHUNK_SIZE);
  if (east < west) x1 += CHUNK_COLS; // 날짜변경선을 넘는 상자
  const y0 = Math.floor(latToPy(north, CHUNK_ZOOM) / CHUNK_SIZE);
  const y1 = Math.floor(latToPy(south, CHUNK_ZOOM) / CHUNK_SIZE);
  const out: [number, number][] = [];
  for (let y = y0; y <= y1; y++) {
    if (!chunkExists(y)) continue;
    for (let x = x0; x <= Math.min(x1, x0 + CHUNK_COLS - 1); x++) out.push([((x % CHUNK_COLS) + CHUNK_COLS) % CHUNK_COLS, y]);
  }
  return out;
}

/** 조각 목록에서 경위도에 가까운 순으로 n개를 고른다. 거리는 조각 가운데까지의 Mercator 거리이고 경도는 순환한다. */
export function nearestChunks(list: [number, number][], lon: number, lat: number, n: number): [number, number][] {
  const world = CHUNK_SIZE * CHUNK_COLS, px = lonToPx(lon, CHUNK_ZOOM), py = latToPy(lat, CHUNK_ZOOM);
  const dist = ([x, y]: [number, number]): number => {
    let dx = Math.abs((x + 0.5) * CHUNK_SIZE - px);
    dx = Math.min(dx, world - dx);
    return Math.hypot(dx, (y + 0.5) * CHUNK_SIZE - py);
  };
  return list.map((c) => ({ c, d: dist(c) })).sort((a, b) => a.d - b.d).slice(0, n).map((e) => e.c);
}

/**
 * 10 km 조각 저장소. 필요한 조각만 받아서 디코딩해 두고, 많이 쌓이면 오래 안 쓴 것부터 버린다.
 * 조각 하나는 디코딩하면 256 KB다. 기본 상한 32개면 약 8 MB다.
 */
export class ChunkStore {
  private readonly ready = new Map<string, Float32Array>();
  private readonly pending = new Map<string, Promise<Float32Array | null>>();
  /** 지금까지 받은 전송 바이트. 예산 확인용이다. */
  bytesLoaded = 0;
  onLoad: ((x: number, y: number) => void) | null = null;

  constructor(private readonly baseUrl: string, private readonly gunzip: Gunzip = browserGunzip, private readonly capacity = 32) {}

  /** 이미 받아 둔 조각이면 바로 돌려준다. 없으면 null이고 받기를 시작하지도 않는다. */
  peek(x: number, y: number): Float32Array | null {
    const key = `${x}_${y}`;
    const c = this.ready.get(key);
    if (!c) return null;
    // 최근에 쓴 것을 맨 뒤로 보낸다
    this.ready.delete(key);
    this.ready.set(key, c);
    return c;
  }

  /** 조각을 받는다. 자료가 없는 행이거나 받지 못하면 null이다. */
  load(x: number, y: number): Promise<Float32Array | null> {
    if (!chunkExists(y)) return Promise.resolve(null);
    const key = `${x}_${y}`;
    const have = this.peek(x, y);
    if (have) return Promise.resolve(have);
    let p = this.pending.get(key);
    if (!p) {
      p = this.fetchChunk(x, y, key).finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  private async fetchChunk(x: number, y: number, key: string): Promise<Float32Array | null> {
    try {
      const res = await fetch(this.baseUrl + chunkFile(x, y));
      if (!res.ok) return null;
      const file = new Uint8Array(await res.arrayBuffer());
      this.bytesLoaded += file.length;
      const data = await decodeChunk(file, this.gunzip);
      this.ready.set(key, data);
      while (this.ready.size > this.capacity) this.ready.delete(this.ready.keys().next().value as string);
      this.onLoad?.(x, y);
      return data;
    } catch {
      return null;
    }
  }

  get loadedCount(): number {
    return this.ready.size;
  }
}
