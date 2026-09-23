import { describe, expect, it } from 'vitest';
import { makeEarthGrid } from '../../app/src/data/earth';
import { buildAdaptiveMesh, STRIDE, subdivide, type ViewParams } from '../../app/src/globe/adaptive';
import { lonLatToDir } from '../../app/src/globe/icosphere';
import { basis, type Vec3 } from '../../app/src/globe/mat4';
import { Terrain } from '../../app/src/terrain/terrain';

const FOV = (35 * Math.PI) / 180;

/** (lon, lat)를 alt(지구 반지름 단위) 위에서 똑바로 내려다보는 시점. */
function viewOver(lon: number, lat: number, alt: number, over: Partial<ViewParams> = {}): ViewParams {
  const t = lonLatToDir(lon, lat);
  const eye: Vec3 = [t[0] * (1 + alt), t[1] * (1 + alt), t[2] * (1 + alt)];
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const north: Vec3 = [-Math.sin(la) * Math.sin(lo), Math.cos(la), -Math.sin(la) * Math.cos(lo)];
  const width = 390, height = 844;
  const b = basis(eye, t, north);
  return {
    eye, right: b.right, up: b.up, forward: b.forward, halfFovY: FOV / 2, halfFovX: Math.atan(Math.tan(FOV / 2) * (width / height)), pxPerRad: height / (2 * Math.tan(FOV / 2)),
    width, height, origin: t, targetPx: 9, minEdgeKm: 0.1, maxFaces: 200000, ...over,
  };
}

describe('보이는 부분만 나누는 메시', () => {
  it('나눈 정도가 다른 면 사이에도 틈이 없다: 모든 변을 정확히 두 면이 공유한다', () => {
    for (const v of [viewOver(135, 28, 7), viewOver(129, 37.5, 0.05), viewOver(141, 38.2, 0.002)]) {
      const sub = subdivide(v)!;
      const count = new Map<number, number>();
      for (let f = 0; f < sub.leaves.length; f += 3) {
        for (let k = 0; k < 3; k++) {
          const a = sub.leaves[f + k], b = sub.leaves[f + ((k + 1) % 3)];
          const key = a < b ? a * 67108864 + b : b * 67108864 + a;
          count.set(key, (count.get(key) ?? 0) + 1);
        }
      }
      let bad = 0;
      for (const n of count.values()) if (n !== 2) bad++;
      expect(bad).toBe(0);
      // 오일러 지표: 닫힌 구면이면 V - E + F = 2
      const used = new Set(sub.leaves);
      expect(used.size - count.size + sub.leaves.length / 3).toBe(2);
    }
  });

  it('모든 면이 바깥을 향한다', () => {
    const sub = subdivide(viewOver(129, 37.5, 0.02))!;
    const { x, y, z, leaves } = sub;
    for (let f = 0; f < leaves.length; f += 3) {
      const a = leaves[f], b = leaves[f + 1], c = leaves[f + 2];
      const ux = x[b] - x[a], uy = y[b] - y[a], uz = z[b] - z[a], vx = x[c] - x[a], vy = y[c] - y[a], vz = z[c] - z[a];
      expect((uy * vz - uz * vy) * x[a] + (uz * vx - ux * vz) * y[a] + (ux * vy - uy * vx) * z[a]).toBeGreaterThan(0);
    }
  });

  it('가까이 갈수록 잘게 나뉘지만 면의 수는 비슷하고, 100 m 아래로는 내려가지 않는다', () => {
    const edgeKm = (sub: NonNullable<ReturnType<typeof subdivide>>): number => {
      let m = Infinity;
      for (let f = 0; f < sub.leaves.length; f += 3) {
        const a = sub.leaves[f], b = sub.leaves[f + 1];
        m = Math.min(m, Math.hypot(sub.x[a] - sub.x[b], sub.y[a] - sub.y[b], sub.z[a] - sub.z[b]) * 6371);
      }
      return m;
    };
    const far = subdivide(viewOver(135, 28, 7))!, mid = subdivide(viewOver(129, 37.5, 0.05))!, near = subdivide(viewOver(129, 37.5, 0.0015))!;
    expect(edgeKm(far)).toBeGreaterThan(100);
    expect(edgeKm(mid)).toBeLessThan(10);
    expect(edgeKm(near)).toBeGreaterThanOrEqual(0.1);
    expect(edgeKm(near)).toBeLessThan(0.22);
    for (const s of [far, mid, near]) {
      expect(s.leaves.length / 3).toBeGreaterThan(2000);
      expect(s.leaves.length / 3).toBeLessThan(25000);
    }
    // 아주 더 가까이 가도 더 나누지 않는다
    expect(edgeKm(subdivide(viewOver(129, 37.5, 0.0002))!)).toBeGreaterThanOrEqual(0.1);
  });

  it('면이 상한을 넘으면 포기하고 null을 준다(부르는 쪽이 면을 키워 다시 만든다)', () => {
    expect(subdivide(viewOver(129, 37.5, 0.05, { maxFaces: 500 }))).toBeNull();
  });

  it('지형 층과 물 층을 따로 만든다: 물은 수면 높이에, 육지에는 물이 없다', () => {
    // 동반구는 해발 1,000 m 육지, 서반구는 수심 3,000 m 바다인 가상의 지구
    const size = 256, elev = new Float32Array(size * size); // 줌 0의 격자는 한 변이 256이다
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) elev[j * size + i] = i >= size / 2 ? 1000 : -3000;
    const terrain = new Terrain(makeEarthGrid(0, size, elev), { peek: () => null });
    const land = buildAdaptiveMesh(terrain, viewOver(90, 0, 0.5))!, sea = buildAdaptiveMesh(terrain, viewOver(-90, 0, 0.5))!;
    expect(land.data.byteLength).toBe((land.terrainVertices + land.waterVertices) * STRIDE);
    // 육지 위에서 보면 화면 안은 지형 층뿐이고, 바다 위에서 보면 깊은 바닥은 그리지 않아 물 층이 대부분이다
    expect(land.terrainVertices).toBeGreaterThan(land.waterVertices * 5);
    expect(sea.waterVertices).toBeGreaterThan(sea.terrainVertices * 5);
    const f32 = new Float32Array(sea.data), u8 = new Uint8Array(sea.data);
    for (let v = 0; v < sea.terrainVertices + sea.waterVertices; v++) {
      const isWater = u8[v * STRIDE + 43] === 255;
      expect(isWater).toBe(v >= sea.terrainVertices);
      if (isWater) {
        expect(f32[v * (STRIDE / 4) + 3]).toBe(0); // 수면 높이
        expect(f32[v * (STRIDE / 4) + 4]).toBeLessThanOrEqual(0); // 음영용 높이에는 바닥 깊이
      }
    }
    // 상대 좌표는 보는 지점 근처에서 0에 가깝다. float32로도 정밀도가 남는다.
    let nearest = Infinity;
    for (let v = 0; v < sea.waterVertices; v++) { const q = (sea.terrainVertices + v) * (STRIDE / 4); nearest = Math.min(nearest, Math.hypot(f32[q], f32[q + 1], f32[q + 2])); }
    expect(nearest).toBeLessThan(0.02);
  });
});
