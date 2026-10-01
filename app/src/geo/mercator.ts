// Web Mercator 픽셀 좌표계. 시뮬레이션 격자를 이 좌표계에 직접 둔다.
// Mercator는 등각 투영이라 한 셀의 동서·남북 실제 길이가 같고, 위도에 따라 cos(lat)만큼 줄어든다.
// 그래서 DEM 타일 픽셀과 격자 셀이 1:1로 대응하고, 구면 천수방정식은 축척 계수 하나로 정확히 표현된다.

export const EARTH_CIRCUMFERENCE = 40075016.686; // m, WGS84 적도 둘레
export const EARTH_RADIUS = EARTH_CIRCUMFERENCE / (2 * Math.PI);
export const TILE_SIZE = 256;
export const DEG = Math.PI / 180;
export const MAX_MERCATOR_LAT = 85.0511;

export const worldSize = (z: number): number => TILE_SIZE * 2 ** z;

export const lonToPx = (lon: number, z: number): number => ((lon + 180) / 360) * worldSize(z);

export function latToPy(lat: number, z: number): number {
  const c = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return ((1 - Math.asinh(Math.tan(c * DEG)) / Math.PI) / 2) * worldSize(z);
}

export const pxToLon = (px: number, z: number): number => (px / worldSize(z)) * 360 - 180;

export function pyToLat(py: number, z: number): number {
  const psi = Math.PI * (1 - (2 * py) / worldSize(z));
  return Math.atan(Math.sinh(psi)) / DEG;
}

/** 픽셀 행 py에서의 cos(위도). cos(lat) = 1 / cosh(psi). */
export function cosLatAtPy(py: number, z: number): number {
  const psi = Math.PI * (1 - (2 * py) / worldSize(z));
  return 1 / Math.cosh(psi);
}

/** 적도 기준 한 픽셀의 길이(m). 실제 길이는 여기에 cos(lat)를 곱한다. */
export const equatorMetersPerPixel = (z: number): number => EARTH_CIRCUMFERENCE / worldSize(z);

/** 두 지점 사이의 대권 거리(m). */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 시작점에서 방위각(az, 북쪽 기준 시계방향 도)으로 dist(m)만큼 이동한 지점. 국지 평면 근사. */
export function offsetLonLat(lon: number, lat: number, eastM: number, northM: number): [number, number] {
  const kLat = (EARTH_RADIUS * DEG);
  const kLon = kLat * Math.cos(lat * DEG);
  return [lon + eastM / kLon, lat + northM / kLat];
}
