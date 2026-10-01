// Okada (1985) 직사각형 단층에 의한 지표 연직 변위. 반무한 탄성체, 푸아송 고체(λ = μ).
// 좌표: x는 주향 방향, y는 경사를 거슬러 올라가는 수평 방향, 원점은 단층 아래쪽 모서리의 지표 투영.
// d는 단층 아래쪽 변의 깊이, L은 주향 길이, W는 경사 방향 폭. 길이 단위는 서로 같기만 하면 된다.

const ALPHA_MU = 0.5; // μ / (λ + μ)

interface Trig { sd: number; cd: number }

function chinnery(f: (xi: number, eta: number) => number, x: number, p: number, L: number, W: number): number {
  return f(x, p) - f(x, p - W) - f(x - L, p) + f(x - L, p - W);
}

function dipSlipKernel(xi: number, eta: number, q: number, t: Trig): number {
  const { sd, cd } = t;
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  const X = Math.sqrt(xi * xi + q * q);
  const dTilde = eta * sd - q * cd;
  let I5 = 0;
  if (Math.abs(xi) > 1e-9) {
    I5 = ALPHA_MU * (2 / cd) * Math.atan((eta * (X + q * cd) + X * (R + X) * sd) / (xi * (R + X) * cd));
  }
  const Rxi = R + xi;
  const term1 = Math.abs(Rxi) < 1e-9 ? 0 : (dTilde * q) / (R * Rxi);
  const term2 = Math.abs(q) < 1e-12 ? 0 : sd * Math.atan((xi * eta) / (q * R));
  return term1 + term2 - I5 * sd * cd;
}

function strikeSlipKernel(xi: number, eta: number, q: number, t: Trig): number {
  const { sd, cd } = t;
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  const dTilde = eta * sd - q * cd;
  const Reta = R + eta;
  // R + eta = 0 특이점: Okada의 규칙대로 1/(R+eta) 항은 0으로, ln(R+eta)는 -ln(R-eta)로 바꾼다.
  if (Math.abs(Reta) < 1e-9) {
    const I4s = ALPHA_MU * (1 / cd) * (Math.log(R + dTilde) + sd * Math.log(R - eta));
    return I4s * sd;
  }
  const I4 = ALPHA_MU * (1 / cd) * (Math.log(R + dTilde) - sd * Math.log(Reta));
  return (dTilde * q) / (R * Reta) + (q * sd) / Reta + I4 * sd;
}

/**
 * 연직 변위 uz. dipRad는 경사각(라디안), slipStrike는 주향이동 성분(좌수향 +), slipDip은 경사이동 성분(역단층 +).
 */
export function okadaUz(
  x: number,
  y: number,
  L: number,
  W: number,
  d: number,
  dipRad: number,
  slipStrike: number,
  slipDip: number,
): number {
  // cos(dip) = 0 특이점을 피한다. 수직 단층은 89.9도로 본다.
  const dip = Math.min(dipRad, (89.9 * Math.PI) / 180);
  const t: Trig = { sd: Math.sin(dip), cd: Math.cos(dip) };
  const p = y * t.cd + d * t.sd;
  let q = y * t.sd - d * t.cd;
  if (Math.abs(q) < 1e-6) q = 1e-6;
  let uz = 0;
  if (slipDip !== 0) {
    uz += (-slipDip / (2 * Math.PI)) * chinnery((xi, eta) => dipSlipKernel(xi, eta, q, t), x, p, L, W);
  }
  if (slipStrike !== 0) {
    uz += (-slipStrike / (2 * Math.PI)) * chinnery((xi, eta) => strikeSlipKernel(xi, eta, q, t), x, p, L, W);
  }
  return uz;
}

/**
 * 주향으로 이어 붙은 소단층 한 줄의 연직 변위. 깊이·폭·경사가 같고 미끄러짐만 다른 소단층들이다.
 * okadaUz를 소단층마다 부르면 이웃한 소단층이 맞닿은 모서리를 두 번씩 계산한다. 여기서는 모서리마다 한 번만 계산해
 * 미끄러짐의 차이를 곱한다. 식은 같고 계산량은 절반이다.
 * x0은 줄이 시작하는 모서리 기준의 주향 좌표, edges는 그 모서리에서 각 경계까지의 거리(소단층 수 + 1개),
 * slips는 소단층별 미끄러짐, cosRake와 sinRake는 주향이동과 경사이동의 비율이다. 나머지는 okadaUz와 같다.
 */
export function okadaUzRow(
  x0: number,
  edges: ArrayLike<number>,
  slips: ArrayLike<number>,
  y: number,
  W: number,
  d: number,
  dipRad: number,
  cosRake: number,
  sinRake: number,
): number {
  const dip = Math.min(dipRad, (89.9 * Math.PI) / 180);
  const t: Trig = { sd: Math.sin(dip), cd: Math.cos(dip) };
  const p = y * t.cd + d * t.sd;
  let q = y * t.sd - d * t.cd;
  if (Math.abs(q) < 1e-6) q = 1e-6;
  const n = slips.length;
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    // 경계 k의 왼쪽 소단층은 빼고 오른쪽 소단층은 더한다
    const c = (k < n ? slips[k] : 0) - (k > 0 ? slips[k - 1] : 0);
    if (c === 0) continue;
    const xi = x0 - edges[k];
    let g = 0;
    if (sinRake !== 0) g += sinRake * (dipSlipKernel(xi, p, q, t) - dipSlipKernel(xi, p - W, q, t));
    if (cosRake !== 0) g += cosRake * (strikeSlipKernel(xi, p, q, t) - strikeSlipKernel(xi, p - W, q, t));
    sum += c * g;
  }
  return -sum / (2 * Math.PI);
}
