// 면의 색. 실제 지도 이미지는 쓰지 않고, 높이와 깊이를 색으로 나타낸다.
export type RGB = [number, number, number];

const WATER_STOPS: [number, RGB][] = [
  [0, [0.56, 0.81, 0.86]], [200, [0.31, 0.63, 0.79]], [1500, [0.17, 0.43, 0.67]], [4000, [0.08, 0.25, 0.48]], [7500, [0.04, 0.12, 0.30]],
];
const LAND_STOPS: [number, RGB][] = [
  [0, [0.55, 0.70, 0.45]], [300, [0.69, 0.74, 0.48]], [1000, [0.79, 0.69, 0.47]], [2200, [0.63, 0.51, 0.41]], [3800, [0.66, 0.59, 0.52]], [5200, [0.76, 0.73, 0.70]], [6500, [0.95, 0.95, 0.96]],
];
// 물이 빠지면 드러나는 바닥. 얕은 곳은 모래, 깊은 곳은 어두운 펄
const SEABED_STOPS: [number, RGB][] = [[0, [0.80, 0.76, 0.60]], [15, [0.62, 0.60, 0.50]], [60, [0.38, 0.42, 0.42]]];
const SNOW: RGB = [0.94, 0.96, 0.98];

function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const t = (v - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** 만년설 고도(m). 적도에서 6,000 m, 위도 70도 위로는 0 m. */
const snowLine = (lat: number): number => 6000 * Math.max(0, 1 - (Math.abs(lat) / 70) ** 2);

export function landColor(elev: number, lat: number): RGB {
  const c = ramp(LAND_STOPS, elev);
  // 눈은 만년설 고도를 넘는 만큼 서서히 덮는다. 극지방의 육지는 높이와 상관없이 얼음으로 본다.
  const t = Math.max(Math.min(1, (elev - snowLine(lat)) / 1200), smooth(62, 72, Math.abs(lat)));
  return t > 0 ? [c[0] + (SNOW[0] - c[0]) * t, c[1] + (SNOW[1] - c[1]) * t, c[2] + (SNOW[2] - c[2]) * t] : c;
}
export const waterColor = (depth: number): RGB => ramp(WATER_STOPS, depth);
export const seabedColor = (depth: number): RGB => ramp(SEABED_STOPS, depth);
