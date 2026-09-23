/** 정이십면체를 level번 나눈 구. 꼭짓점은 단위 벡터, 면은 바깥에서 볼 때 반시계 방향이다. */
export interface Icosphere {
  level: number;
  /** 꼭짓점 단위 벡터 (x, y, z). y가 북극이다. */
  positions: Float32Array;
  indices: Uint32Array;
}

/** 정이십면체 한 변이 구 중심에서 차지하는 각(라디안). level n의 변은 이 값 / 2^n 이다. */
export const ICOSAHEDRON_EDGE_ANGLE = Math.atan(2);

export const faceCount = (level: number): number => 20 * 4 ** level;

export function icosphere(level: number): Icosphere {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  const vCount = 10 * 4 ** level + 2;
  const pos = new Float32Array(vCount * 3);
  let nv = 0;
  const push = (x: number, y: number, z: number): number => {
    const l = Math.hypot(x, y, z);
    pos[nv * 3] = x / l; pos[nv * 3 + 1] = y / l; pos[nv * 3 + 2] = z / l;
    return nv++;
  };
  for (const [x, y, z] of base) push(x, y, z);

  for (let s = 0; s < level; s++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 1048576 + b : b * 1048576 + a;
      let m = cache.get(key);
      if (m === undefined) {
        m = push(pos[a * 3] + pos[b * 3], pos[a * 3 + 1] + pos[b * 3 + 1], pos[a * 3 + 2] + pos[b * 3 + 2]);
        cache.set(key, m);
      }
      return m;
    };
    const next: number[] = new Array(faces.length * 4);
    for (let f = 0, o = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next[o++] = a; next[o++] = ab; next[o++] = ca;
      next[o++] = b; next[o++] = bc; next[o++] = ab;
      next[o++] = c; next[o++] = ca; next[o++] = bc;
      next[o++] = ab; next[o++] = bc; next[o++] = ca;
    }
    faces = next;
  }
  return { level, positions: pos, indices: Uint32Array.from(faces) };
}

const RAD = 180 / Math.PI;
/** 단위 벡터를 경위도로. x = cos(lat) sin(lon), y = sin(lat), z = cos(lat) cos(lon). */
export const dirToLonLat = (x: number, y: number, z: number): [number, number] => [Math.atan2(x, z) * RAD, Math.asin(Math.max(-1, Math.min(1, y))) * RAD];

export function lonLatToDir(lon: number, lat: number): [number, number, number] {
  const la = lat / RAD, lo = lon / RAD, c = Math.cos(la);
  return [c * Math.sin(lo), Math.sin(la), c * Math.cos(lo)];
}
