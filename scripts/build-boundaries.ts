// 실제 해안선과 국경을 선 자료로 만든다. 배포 전에 한 번 돌리고 결과 파일은 저장소에 넣는다.
//   node scripts/build-boundaries.ts
// 원자료: Natural Earth(world-atlas 패키지, 퍼블릭 도메인). 110m은 늘 받고(첫 화면), 50m은 확대할 때 받는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mesh } from 'topojson-client';
import type { GeometryObject, Topology } from 'topojson-specification';
import { decodeLines, encodeLines, joinLinesFile, splitLinesFile, type LinesHeader } from '../app/src/data/lines-codec.ts';

const require = createRequire(import.meta.url);
const LIMITS: Record<string, number> = { '110m': 60 * 1024, '50m': 300 * 1024 };

for (const res of ['110m', '50m']) {
  const land = require(`world-atlas/land-${res}.json`) as Topology;
  const countries = require(`world-atlas/countries-${res}.json`) as Topology;
  const coast = mesh(land, land.objects.land as GeometryObject);
  const borders = mesh(countries, countries.objects.countries as GeometryObject, (a, b) => a !== b);
  const toLines = (m: { coordinates: number[][][] }): [number, number][][] => m.coordinates.map((l) => l.map(([x, y]) => [x, y] as [number, number]));
  const { header, body } = encodeLines([{ name: 'coast', lines: toLines(coast) }, { name: 'border', lines: toLines(borders) }]);
  const full: LinesHeader = { ...header, source: `Natural Earth ${res} (world-atlas)` };
  const file = joinLinesFile(full, gzipSync(body, { level: 9 }));
  // 되읽기 검증
  const back = splitLinesFile(file);
  const lines = decodeLines(back.header, new Uint8Array(gunzipSync(back.payload)));
  const c0 = coast.coordinates[0][0], d0 = lines.get('coast')![0].coords;
  if (Math.abs(c0[0] - d0[0]) > 1e-3 || Math.abs(c0[1] - d0[1]) > 1e-3) throw new Error('되읽기 불일치');
  const out = new URL(`../app/public/data/boundaries-${res}.bin`, import.meta.url);
  mkdirSync(new URL('.', out), { recursive: true });
  writeFileSync(out, file);
  const pts = full.kinds.map((k) => `${k.name} ${k.lines}선 ${k.points}점`).join(', ');
  console.log(`${res}: ${pts}. 파일 ${(file.length / 1024).toFixed(1)} KB (상한 ${LIMITS[res] / 1024} KB)`);
  if (file.length > LIMITS[res]) { console.error('예산 초과'); process.exit(1); }
}
