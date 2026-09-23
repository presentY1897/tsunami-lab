// 주요 도시 자료를 만든다. 배포 전에 한 번 돌리고 결과 파일은 저장소에 넣는다.
//   node scripts/build-cities.ts
// 원자료: Natural Earth 10m populated places(퍼블릭 도메인). scripts/.cache 에 받아 둔 GeoJSON을 읽는다.
// 고르는 기준: 인구 30만 이상이거나 수도, 또는 인구 10만 이상이면서 해안(50m 해안선에서 30 km 안)인 곳.
// 결과: app/public/data/cities.bin (gzip한 JSON). 상한 80 KB.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeLines, splitLinesFile } from '../app/src/data/lines-codec.ts';

const SRC = new URL('./.cache/ne_10m_populated_places.geojson', import.meta.url);
const URL_SRC = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places.geojson';
if (!existsSync(SRC)) {
  mkdirSync(new URL('./.cache/', import.meta.url), { recursive: true });
  const res = await fetch(URL_SRC);
  if (!res.ok) throw new Error(`원자료를 받지 못했다 (${res.status})`);
  writeFileSync(SRC, new Uint8Array(await res.arrayBuffer()));
}
interface Feature { properties: Record<string, unknown>; geometry: { coordinates: [number, number] } }
const features = (JSON.parse(readFileSync(SRC, 'utf8')) as { features: Feature[] }).features;

// 50m 해안선 점들. 해안 도시 판정에 쓴다.
const bnd = splitLinesFile(new Uint8Array(readFileSync(new URL('../app/public/data/boundaries-50m.bin', import.meta.url))));
const coast = decodeLines(bnd.header, new Uint8Array(gunzipSync(bnd.payload))).get('coast')!;
// 경위도 1도 칸으로 색인해서 가까운 점만 본다
const buckets = new Map<string, number[][]>();
for (const l of coast) for (let i = 0; i < l.coords.length; i += 2) {
  const key = `${Math.floor(l.coords[i])}:${Math.floor(l.coords[i + 1])}`;
  (buckets.get(key) ?? buckets.set(key, []).get(key)!).push([l.coords[i], l.coords[i + 1]]);
}
const coastalWithinKm = (lon: number, lat: number, km: number): boolean => {
  const kx = 111.195 * Math.cos((lat * Math.PI) / 180), ky = 111.195;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const [x, y] of buckets.get(`${Math.floor(lon) + dx}:${Math.floor(lat) + dy}`) ?? []) {
      if (Math.hypot((x - lon) * kx, (y - lat) * ky) <= km) return true;
    }
  }
  return false;
};

/** 행정 접미사를 뗀 표시용 이름. "부산광역시" → "부산", "도쿄도" → "도쿄". 두 글자 아래로 짧아지면 그대로 둔다. */
function displayName(ko: string, en: string): string {
  const name = (ko || en).trim();
  for (const suf of ['특별자치시', '특별자치도', '광역시', '특별시', '직할시', '시', '도', '부', '현', '군', '구']) {
    if (name.endsWith(suf) && name.length - suf.length >= 2) return name.slice(0, -suf.length);
  }
  return name;
}

const cities: [string, number, number, number, number, string][] = [];
for (const f of features) {
  const p = f.properties;
  const pop = Number(p.POP_MAX ?? 0), capital = Number(p.ADM0CAP ?? 0) === 1;
  const [lon, lat] = f.geometry.coordinates;
  const keep = pop >= 300000 || capital || (pop >= 100000 && coastalWithinKm(lon, lat, 30));
  if (!keep) continue;
  const rank = Number(p.SCALERANK ?? 10);
  cities.push([displayName(String(p.NAME_KO ?? ''), String(p.NAME ?? '')), +lon.toFixed(3), +lat.toFixed(3), Math.round(pop / 1000), capital ? 1 : rank, String(p.NAME_EN || p.NAME || '').trim()]);
}
cities.sort((a, b) => b[3] - a[3]);
const json = JSON.stringify({ version: 2, source: 'Natural Earth 10m populated places', fields: ['name', 'lon', 'lat', 'popK', 'rank', 'nameEn'], cities });
const file = gzipSync(Buffer.from(json), { level: 9 });
const out = new URL('../app/public/data/cities.bin', import.meta.url);
writeFileSync(out, file);
const LIMIT = 80 * 1024;
console.log(`도시 ${cities.length}곳. JSON ${(json.length / 1024).toFixed(0)} KB, 파일 ${(file.length / 1024).toFixed(1)} KB (상한 ${LIMIT / 1024} KB)`);
console.log('예:', cities.slice(0, 5).map((c) => c[0]).join(', '), '…', cities.filter((c) => c[0] === '강릉' || c[0] === '센다이').map((c) => `${c[0]} ${c[3]}천`).join(', '));
if (file.length > LIMIT) { console.error('예산 초과'); process.exit(1); }
