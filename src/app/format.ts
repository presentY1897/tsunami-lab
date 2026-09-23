export const fmtM = (v: number): string =>
  v >= 10 ? `${Math.round(v)} m` : v >= 1 ? `${v.toFixed(1)} m` : v >= 0.01 ? `${v.toFixed(2)} m` : '0 m';

export const fmtKm = (m: number): string =>
  m >= 10000 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;

export function fmtT(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}

export const fmtInt = (v: number): string => Math.round(v).toLocaleString('ko-KR');

export const fmtLonLat = (lon: number, lat: number): string => {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(l).toFixed(2)}°${l >= 0 ? 'E' : 'W'}`;
};
