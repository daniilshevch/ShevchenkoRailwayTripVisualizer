// Використання: node cli.js stations.json [out.geojson]
import fs from 'node:fs/promises';
import { buildRoute, toGeoJSON } from './lib/router.js';

const [, , input = 'stations.json', output = 'route.geojson'] = process.argv;
const raw = JSON.parse(await fs.readFile(input, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.stations;

const route = await buildRoute(list);
for (const s of route.segments) {
  console.log(`${s.ok ? '✓' : '✗'} ${s.from} → ${s.to}: ${s.distanceKm.toFixed(1)} км`);
}
console.log(`Разом: ${route.totalKm.toFixed(1)} км`);
await fs.writeFile(output, JSON.stringify(toGeoJSON(route), null, 1));
console.log(`Збережено в ${output}`);
