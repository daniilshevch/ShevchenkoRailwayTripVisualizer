// Залізнична мережа України: дані з data/ua-rail.json + граф у пам'яті.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine } from './geo.js';

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ua-rail.json');

let dataPromise = null;

/** Вміст data/ua-rail.json (створюється import-osm.js). */
export function loadData() {
  if (!dataPromise) {
    dataPromise = fs.readFile(DATA_FILE, 'utf8').then(JSON.parse).catch(e => {
      dataPromise = null;
      if (e.code === 'ENOENT') throw new Error('Немає data/ua-rail.json — спершу запустіть: node import-osm.js');
      throw e;
    });
  }
  return dataPromise;
}

const CELL = 0.02; // ~2 км, для просторового індексу
// Штраф для службових колій (тупики, станційні з'єднання, під'їзні):
// маршрут іде ними лише там, де без них немає зв'язку між лініями.
const SERVICE_PENALTY = 3;
// Тупик колії ближче за стільки метрів до іншої колії вважаємо розривом у даних і зшиваємо
const GAP_REPAIR_M = 3;
// Радіус від точки станції, в якому поїзд може змінити напрямок руху
const REVERSAL_RADIUS_M = 1500;

/** Граф: вершини = вузли OSM, ребра = напрямлені відрізки колії. */
function buildGraph(data) {
  const idOf = new Map();
  const pts = [], out = [];
  for (const [id, lat, lon] of data.nodes) { idOf.set(id, pts.length); pts.push([lat, lon]); out.push([]); }
  // eW — реальна довжина (для кілометражу), eC — вартість для пошуку шляху
  const eFrom = [], eTo = [], eW = [], eC = [];
  data.ways.forEach((refs, wi) => {
    const k = data.wayClass?.[wi] ? SERVICE_PENALTY : 1;
    const nds = refs.map(r => idOf.get(r)).filter(i => i !== undefined);
    for (let j = 1; j < nds.length; j++) {
      const u = nds[j - 1], v = nds[j];
      if (u === v) continue;
      const w = haversine(pts[u][0], pts[u][1], pts[v][0], pts[v][1]);
      out[u].push(eFrom.length); eFrom.push(u); eTo.push(v); eW.push(w); eC.push(w * k);
      out[v].push(eFrom.length); eFrom.push(v); eTo.push(u); eW.push(w); eC.push(w * k);
    }
  });

  const grid = new Map();
  pts.forEach(([la, lo], i) => {
    const key = `${Math.floor(la / CELL)}:${Math.floor(lo / CELL)}`;
    let c = grid.get(key);
    if (!c) grid.set(key, c = []);
    c.push(i);
  });

  // Ремонт розривів у даних OSM: тупикова точка колії, що лежить майже в тій самій
  // точці, що й інша колія, але не з'єднана з нею (дубльований вузол — типова помилка
  // на мостах і стиках правок). Зшиваємо такі місця ребром.
  let repaired = 0;
  for (let i = 0; i < pts.length; i++) {
    if (out[i].length !== 1) continue;
    const [la, lo] = pts[i];
    const ci = Math.floor(la / CELL), cj = Math.floor(lo / CELL);
    for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) {
      for (const j of grid.get(`${a}:${b}`) || []) {
        if (j === i || out[i].some(e => eTo[e] === j)) continue;
        const w = haversine(la, lo, pts[j][0], pts[j][1]);
        if (w > GAP_REPAIR_M) continue;
        out[i].push(eFrom.length); eFrom.push(i); eTo.push(j); eW.push(w); eC.push(w);
        out[j].push(eFrom.length); eFrom.push(j); eTo.push(i); eW.push(w); eC.push(w);
        repaired++;
      }
    }
  }

  return {
    pts, out, grid, ways: data.ways.length, repaired,
    eFrom: Int32Array.from(eFrom), eTo: Int32Array.from(eTo),
    eW: Float64Array.from(eW), eC: Float64Array.from(eC),
  };
}

/** Вузли графа в радіусі radiusM від точки (через сітковий індекс). */
export function nearbyNodes(g, lat, lon, radiusM) {
  const r = Math.ceil(radiusM / 111000 / CELL / Math.cos(lat * Math.PI / 180)) + 1;
  const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
  const res = [];
  for (let a = ci - r; a <= ci + r; a++)
    for (let b = cj - r; b <= cj + r; b++)
      for (const i of g.grid.get(`${a}:${b}`) || []) {
        const d = haversine(lat, lon, g.pts[i][0], g.pts[i][1]);
        if (d <= radiusM) res.push({ i, d });
      }
  return res.sort((x, y) => x.d - y.d);
}

/**
 * Вузли, де поїзд може змінити напрямок руху: колії в межах станції (не зупинного пункту).
 * g.revStation[i] = індекс станції в data.stations або -1.
 */
function markReversalNodes(g, stations) {
  g.revStation = new Int32Array(g.pts.length).fill(-1);
  g.stationNames = stations.map(s => s.tags['name:uk'] || s.tags.name || '');
  stations.forEach((s, si) => {
    if (s.tags.railway !== 'station' && s.tags.public_transport !== 'station') return;
    for (const { i } of nearbyNodes(g, s.lat, s.lon, REVERSAL_RADIUS_M)) {
      if (g.revStation[i] < 0) g.revStation[i] = si;
    }
  });
}

let graphPromise = null;

/** Граф будується один раз на процес. */
export function getGraph() {
  if (!graphPromise) {
    graphPromise = (async () => {
      const data = await loadData();
      const t0 = Date.now();
      const g = buildGraph(data);
      markReversalNodes(g, data.stations);
      console.log(`[network] граф: ${g.pts.length} вузлів, ${g.eFrom.length / 2} відрізків, ${g.ways} ways, зшито розривів: ${g.repaired} (${Date.now() - t0} мс)`);
      return g;
    })().catch(e => { graphPromise = null; throw e; });
  }
  return graphPromise;
}
