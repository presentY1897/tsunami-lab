// 위치로 정해지는 3차원 기울기 잡음(Perlin). 난수를 쓰지 않으므로 같은 자리는 언제나 같은 값이다.
// 구면 위의 점을 3차원 좌표로 넣기 때문에 경도의 이음매나 극지방의 찌그러짐이 없다.

function hash3(ix: number, iy: number, iz: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// 정육면체의 모서리 12개 방향
const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const GZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

function corner(ix: number, iy: number, iz: number, dx: number, dy: number, dz: number): number {
  const g = hash3(ix, iy, iz) % 12;
  return GX[g] * dx + GY[g] * dy + GZ[g] * dz;
}

/** 대략 -1..1 범위의 매끄러운 잡음. */
export function perlin3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const x00 = corner(ix, iy, iz, fx, fy, fz) * (1 - u) + corner(ix + 1, iy, iz, fx - 1, fy, fz) * u;
  const x10 = corner(ix, iy + 1, iz, fx, fy - 1, fz) * (1 - u) + corner(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz) * u;
  const x01 = corner(ix, iy, iz + 1, fx, fy, fz - 1) * (1 - u) + corner(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1) * u;
  const x11 = corner(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1) * (1 - u) + corner(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1) * u;
  return ((x00 * (1 - v) + x10 * v) * (1 - w) + (x01 * (1 - v) + x11 * v) * w) * 1.1;
}

/** 위치로 정해지는 0..1 값. 면마다 밝기를 조금씩 달리할 때 쓴다. */
export const hashUnit = (ix: number, iy: number, iz: number): number => hash3(ix, iy, iz) / 4294967296;
