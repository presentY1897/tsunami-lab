import { TILE_SIZE } from './mercator';

/** 타일 하나의 표고(m)를 돌려주는 공급자. 브라우저 구현과 테스트용 합성 구현을 바꿔 끼울 수 있다. */
export interface TileProvider {
  /** 256×256 표고 배열. 행 0이 북쪽. */
  getTile(z: number, x: number, y: number): Promise<Float32Array>;
  /** 수심이 실제로 들어 있는 최대 줌. 이보다 높은 줌의 바다는 0 m로 평평하다. */
  readonly maxBathyZoom: number;
  /** 제공되는 최대 줌. */
  readonly maxZoom: number;
  readonly attribution: string;
}

export interface TerrariumOptions {
  /** {z}/{x}/{y} 자리표시자를 가진 URL 템플릿. */
  urlTemplate?: string;
  maxBathyZoom?: number;
  maxZoom?: number;
  concurrency?: number;
}

export const DEFAULT_TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * AWS Terrain Tiles(Terrarium 인코딩)를 브라우저에서 직접 받아 디코딩한다. 키도 서버도 필요 없다.
 * 표고 = R*256 + G + B/256 - 32768.
 * 실측 결과 z10 이하에만 ETOPO1 수심이 섞여 있고 z11 이상은 바다가 0 m다. 그래서 maxBathyZoom = 10.
 */
export class TerrariumTileProvider implements TileProvider {
  readonly maxBathyZoom: number;
  readonly maxZoom: number;
  readonly attribution = '지형: Mapzen/AWS Terrain Tiles (SRTM, GMTED, ETOPO1 외)';
  private readonly url: string;
  private readonly cache = new Map<string, Promise<Float32Array>>();
  private readonly concurrency: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(opts: TerrariumOptions = {}) {
    this.url = opts.urlTemplate ?? DEFAULT_TERRARIUM_URL;
    this.maxBathyZoom = opts.maxBathyZoom ?? 10;
    this.maxZoom = opts.maxZoom ?? 13;
    this.concurrency = opts.concurrency ?? 12;
  }

  getTile(z: number, x: number, y: number): Promise<Float32Array> {
    const n = 2 ** z;
    const xx = ((x % n) + n) % n; // 날짜변경선을 넘는 영역은 x를 감아서 받는다
    const key = `${z}/${xx}/${y}`;
    let p = this.cache.get(key);
    if (!p) {
      p = y < 0 || y >= n ? Promise.resolve(new Float32Array(TILE_SIZE * TILE_SIZE)) : this.load(z, xx, y);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((res) => this.queue.push(res));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }

  private async load(z: number, x: number, y: number): Promise<Float32Array> {
    await this.acquire();
    try {
      const url = this.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (!res.ok) throw new Error(`타일 ${z}/${x}/${y} 응답 ${res.status}`);
          return await decodeTerrarium(await res.blob());
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    } finally {
      this.release();
    }
  }
}

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;

async function decodeTerrarium(blob: Blob): Promise<Float32Array> {
  // 색 공간 변환과 알파 선곱을 꺼야 픽셀 값이 그대로 보존된다.
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
        : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(bmp, 0, 0, TILE_SIZE, TILE_SIZE);
  bmp.close();
  const d = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let k = 0, o = 0; k < out.length; k++, o += 4) {
    out[k] = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
  }
  return out;
}
