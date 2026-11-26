// Імпорт залізничної мережі та станцій з OSM-екстракту Geofabrik.
//
//   curl -L -o data/ukraine-latest.osm.pbf https://download.geofabrik.de/europe/ukraine-latest.osm.pbf
//   node import-osm.js [data/ukraine-latest.osm.pbf]
//
// Результат: data/ua-rail.json — лише колії та станції (кілька десятків МБ замість ~850).
// Щоб оновити дані — скачайте свіжий .pbf і запустіть імпорт знову.
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import osmPbfParser from 'osm-pbf-parser';

const INPUT = process.argv[2] || 'data/ukraine-latest.osm.pbf';
const OUTPUT = 'data/ua-rail.json';

// Ті самі правила, що й раніше: головні та станційні колії, без service=* (депо, тупики, під'їзні)
const isRail = t => t.railway === 'rail' && !t.service && !/^(industrial|military|test|tourism)$/.test(t.usage || '');
const isStation = t =>
  (/^(station|halt)$/.test(t.railway) || (t.public_transport === 'station' && t.train === 'yes')) &&
  !/^(subway|light_rail|monorail|funicular|tram)$/.test(t.station || '');
const STATION_TAGS = ['name', 'name:uk', 'name:ru', 'name:en', 'official_name', 'alt_name', 'old_name', 'railway', 'station', 'public_transport', 'railway:ref', 'esr:user', 'uic_ref'];
const pickTags = t => Object.fromEntries(STATION_TAGS.filter(k => t[k]).map(k => [k, t[k]]));

/** Прохід по файлу; onItem повертає true, щоб зупинити читання достроково. */
async function scan(label, onItem) {
  const t0 = Date.now();
  const size = fs.statSync(INPUT).size;
  const input = fs.createReadStream(INPUT, { highWaterMark: 1 << 20 });
  let lastPct = -1, stopped = false;
  input.on('data', () => {
    const pct = Math.floor(input.bytesRead / size * 100);
    if (pct % 10 === 0 && pct !== lastPct) { lastPct = pct; console.log(`  ${label}: ${pct}%`); }
  });
  try {
    await pipeline(input, osmPbfParser(), new Writable({
      objectMode: true,
      write(items, _, next) {
        if (!stopped) for (const it of items) if (onItem(it)) { stopped = true; break; }
        if (stopped) return next(new Error('STOP'));
        next();
      },
    }));
  } catch (e) {
    if (e.message !== 'STOP') throw e;
  }
  console.log(`  ${label}: готово за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
}

if (!fs.existsSync(INPUT)) {
  console.error(`Немає файлу ${INPUT}. Скачайте: https://download.geofabrik.de/europe/ukraine-latest.osm.pbf`);
  process.exit(1);
}

// Прохід 1: колії, станції-вузли, станції-полігони; які вузли потрібні
console.log('Прохід 1/2: шукаю колії та станції');
const ways = [];
const stations = [];
const stationWays = [];
const need = new Set();
await scan('прохід 1', it => {
  const t = it.tags || {};
  if (it.type === 'node') {
    if ((t.railway || t.public_transport) && isStation(t))
      stations.push({ id: `node/${it.id}`, lat: it.lat, lon: it.lon, tags: pickTags(t) });
  } else if (it.type === 'way') {
    if (isRail(t)) {
      ways.push({ id: it.id, refs: it.refs });
      for (const r of it.refs) need.add(r);
    } else if ((t.railway || t.public_transport) && isStation(t)) {
      stationWays.push({ id: it.id, refs: it.refs, tags: pickTags(t) });
      for (const r of it.refs) need.add(r);
    }
  } else {
    return true; // далі тільки relations — вони не потрібні
  }
});
console.log(`  колій (ways): ${ways.length}, станцій-вузлів: ${stations.length}, станцій-полігонів: ${stationWays.length}, потрібних вузлів: ${need.size}`);

// Прохід 2: координати потрібних вузлів (у .pbf вузли йдуть першими — зупиняємось на першому way)
console.log('Прохід 2/2: збираю координати');
const coord = new Map();
await scan('прохід 2', it => {
  if (it.type !== 'node') return true;
  if (need.has(it.id)) coord.set(it.id, [+it.lat.toFixed(7), +it.lon.toFixed(7)]);
});

for (const w of stationWays) {
  const pts = w.refs.map(r => coord.get(r)).filter(Boolean);
  if (!pts.length) continue;
  stations.push({
    id: `way/${w.id}`,
    lat: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    lon: pts.reduce((s, p) => s + p[1], 0) / pts.length,
    tags: w.tags,
  });
}

// Компактний формат: вузли як масиви [id, lat, lon], колії як списки id вузлів
const railNodes = new Set();
for (const w of ways) for (const r of w.refs) railNodes.add(r);
const out = {
  source: INPUT,
  sourceDate: fs.statSync(INPUT).mtime.toISOString(),
  importedAt: new Date().toISOString(),
  nodes: [...railNodes].filter(id => coord.has(id)).map(id => [id, ...coord.get(id)]),
  ways: ways.map(w => w.refs),
  stations,
};
fs.writeFileSync(OUTPUT, JSON.stringify(out));
console.log(`Збережено ${OUTPUT}: ${out.nodes.length} вузлів, ${out.ways.length} колій, ${out.stations.length} станцій, ${(fs.statSync(OUTPUT).size / 1e6).toFixed(1)} МБ`);
