import 'maplibre-gl/dist/maplibre-gl.css';
import { Map as MapLibreMap, Marker, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { GridSpec, LonLatBox } from '../geo/grid';
import { gridBounds } from '../geo/grid';
import { DEFAULT_TERRARIUM_URL } from '../geo/tiles';

setWorkerUrl(workerUrl);

/** 키 없이 쓸 수 있는 벡터 지도. 다른 스타일로 바꾸려면 이 값만 고치면 된다. */
export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
export const BASEMAP_ATTRIBUTION = '지도: © OpenStreetMap 기여자, OpenFreeMap';

export type PickMode = 'source' | 'target';

export interface PickerEvents {
  onSourceMoved(lon: number, lat: number): void;
  onTargetMoved(lon: number, lat: number): void;
}

type Ring = [number, number][];
const EMPTY = { type: 'FeatureCollection', features: [] } as FeatureCollection;

const polygon = (ring: Ring, props: Record<string, unknown> = {}): Feature => ({
  type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
});
const line = (pts: Ring, props: Record<string, unknown> = {}): Feature => ({
  type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts },
});
const boxRing = (b: LonLatBox): Ring => [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]];

/** 발생원과 관측 해안을 고르는 2차원 지도. */
export class Picker {
  readonly map: MapLibreMap;
  private readonly sourceMarker: Marker;
  private readonly targetMarker: Marker;
  mode: PickMode = 'source';
  private ready: Promise<void>;

  constructor(container: HTMLElement, private readonly events: PickerEvents) {
    this.map = new MapLibreMap({
      container,
      style: BASEMAP_STYLE,
      center: [138, 38],
      zoom: 4.2,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.touchZoomRotate.disableRotation();

    this.sourceMarker = new Marker({ color: '#E8341C', draggable: true }).setLngLat([0, 0]).addTo(this.map);
    this.targetMarker = new Marker({ color: '#1F6FEB', draggable: true }).setLngLat([0, 0]).addTo(this.map);
    this.sourceMarker.on('dragend', () => {
      const p = this.sourceMarker.getLngLat();
      this.events.onSourceMoved(p.lng, p.lat);
    });
    this.targetMarker.on('dragend', () => {
      const p = this.targetMarker.getLngLat();
      this.events.onTargetMoved(p.lng, p.lat);
    });
    this.map.on('click', (e) => {
      if (this.mode === 'source') this.events.onSourceMoved(e.lngLat.lng, e.lngLat.lat);
      else this.events.onTargetMoved(e.lngLat.lng, e.lngLat.lat);
    });

    this.ready = new Promise((resolve) => {
      this.map.on('load', () => {
        this.addLayers();
        resolve();
      });
    });
  }

  private addLayers(): void {
    const map = this.map;
    // 해저 지형 음영. 해구와 해령이 보여야 단층을 어디에 놓을지 판단할 수 있다.
    map.addSource('relief', {
      type: 'raster-dem',
      tiles: [DEFAULT_TERRARIUM_URL],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 10,
    });
    // 수심에 색을 입힌다. 해저 경사는 완만해서 음영만으로는 해구가 잘 보이지 않는다.
    const layers = map.getStyle().layers ?? [];
    const waterIdx = layers.findIndex((l) => l.id === 'water');
    const aboveWater = waterIdx >= 0 ? layers[waterIdx + 1]?.id : layers.find((l) => l.type === 'symbol')?.id;
    map.addLayer(
      {
        id: 'bathy-color',
        type: 'color-relief',
        source: 'relief',
        paint: {
          'color-relief-opacity': 0.9,
          'color-relief-color': [
            'interpolate', ['linear'], ['elevation'],
            -9000, '#08162e', -6000, '#0d2a52', -4000, '#174a7c', -2000, '#2f74ab', -200, '#7fb5dc', -1, '#b9dcf2',
            0, 'rgba(185,220,242,0)', 9000, 'rgba(255,255,255,0)',
          ],
        },
      },
      aboveWater,
    );
    map.addLayer(
      {
        id: 'relief-shade',
        type: 'hillshade',
        source: 'relief',
        paint: { 'hillshade-exaggeration': 0.8, 'hillshade-shadow-color': '#06203a', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#06203a' },
      },
      aboveWater,
    );
    for (const id of ['domain', 'fault', 'target']) map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'domain-line', type: 'line', source: 'domain', paint: { 'line-color': '#11263A', 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } });
    map.addLayer({ id: 'fault-fill', type: 'fill', source: 'fault', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#E8341C', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'fault-line', type: 'line', source: 'fault', paint: { 'line-color': '#E8341C', 'line-width': ['case', ['==', ['get', 'role'], 'trench'], 4, 1.6] } });
    map.addLayer({ id: 'target-fill', type: 'fill', source: 'target', paint: { 'fill-color': '#1F6FEB', 'fill-opacity': 0.14 } });
    map.addLayer({ id: 'target-line', type: 'line', source: 'target', paint: { 'line-color': '#1F6FEB', 'line-width': 2 } });
  }

  private async setData(id: string, features: Feature[]): Promise<void> {
    await this.ready;
    (this.map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  setSourcePosition(lon: number, lat: number): void {
    this.sourceMarker.setLngLat([normLon(lon), lat]);
  }

  setTargetPosition(lon: number, lat: number): void {
    this.targetMarker.setLngLat([normLon(lon), lat]);
  }

  /** 단층의 지표 투영. 앞의 두 점이 윗변(해구 쪽)이다. 소행성이면 공동의 원. */
  setSourceShape(outline: Ring | null, circle?: { lon: number; lat: number; radiusM: number }): void {
    const feats: Feature[] = [];
    if (outline) {
      feats.push(polygon(outline, { role: 'outline' }));
      feats.push(line([outline[0], outline[1]], { role: 'trench' }));
    }
    if (circle) {
      const ring: Ring = [];
      for (let a = 0; a < 360; a += 6) {
        const dx = (circle.radiusM * Math.sin((a * Math.PI) / 180)) / (111195 * Math.cos((circle.lat * Math.PI) / 180));
        const dy = (circle.radiusM * Math.cos((a * Math.PI) / 180)) / 111195;
        ring.push([circle.lon + dx, circle.lat + dy]);
      }
      feats.push(polygon(ring, { role: 'outline' }));
    }
    void this.setData('fault', feats);
  }

  /** 계획된 격자 단계의 범위. 첫 단계는 점선, 마지막 단계는 관측 영역으로 그린다. */
  setGrids(grids: GridSpec[]): void {
    if (grids.length === 0) return;
    void this.setData('domain', grids.slice(0, -1).map((g) => polygon(boxRing(gridBounds(g)))));
    void this.setData('target', [polygon(boxRing(gridBounds(grids[grids.length - 1])))]);
  }

  async fitTo(box: LonLatBox): Promise<void> {
    await this.ready;
    this.map.fitBounds([[normLon(box.west), box.south], [normLon(box.east), box.north]], { padding: 60, duration: 600 });
  }

  resize(): void {
    this.map.resize();
  }
}

const normLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * 벡터 지도를 관측 영역 크기에 딱 맞게 한 장 그려서 캔버스로 돌려준다. 3차원 지형에 입혀 도로와 지명을 보여준다.
 * 계산 격자가 Web Mercator에 정렬되어 있어서 회전이나 재투영 없이 그대로 겹친다.
 */
export async function renderDrape(grid: GridSpec, maxSize = 2048): Promise<HTMLCanvasElement> {
  const b = gridBounds(grid);
  const scale = maxSize / Math.max(grid.nx, grid.ny);
  const w = Math.round(grid.nx * scale), h = Math.round(grid.ny * scale);
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px;visibility:hidden;pointer-events:none`;
  document.body.appendChild(holder);
  const map = new MapLibreMap({
    container: holder,
    style: BASEMAP_STYLE as string | StyleSpecification,
    interactive: false,
    attributionControl: false,
    pixelRatio: 1,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    bounds: [[normLon(b.west), b.south], [normLon(b.east), b.north]],
    fitBoundsOptions: { padding: 0 },
    fadeDuration: 0,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('지도 입히기 시간 초과')), 25000);
      map.once('idle', () => { clearTimeout(timer); resolve(); });
      map.on('error', (e) => console.warn('지도 입히기 오류', e.error?.message ?? e));
    });
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(map.getCanvas(), 0, 0, w, h);
    return out;
  } finally {
    map.remove();
    holder.remove();
  }
}
