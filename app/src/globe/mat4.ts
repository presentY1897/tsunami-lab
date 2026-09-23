// 필요한 만큼만 둔 4×4 행렬 연산. 열 우선(column-major) Float32Array(16).
export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
}

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** 카메라 기저. forward는 눈에서 목표를 향한다. */
export interface Basis { right: Vec3; up: Vec3; forward: Vec3 }

export function basis(eye: Vec3, target: Vec3, worldUp: Vec3): Basis {
  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, worldUp));
  return { right, up: cross(right, forward), forward };
}

export function viewMatrix(eye: Vec3, b: Basis): Mat4 {
  const { right: r, up: u, forward: f } = b;
  const m = new Float32Array(16);
  m[0] = r[0]; m[4] = r[1]; m[8] = r[2]; m[12] = -dot(r, eye);
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2]; m[13] = -dot(u, eye);
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2]; m[14] = dot(f, eye);
  m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return m;
}

/** 점을 클립 공간으로. [x, y, z, w]. */
export function transformPoint(m: Mat4, p: Vec3): [number, number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
  ];
}
