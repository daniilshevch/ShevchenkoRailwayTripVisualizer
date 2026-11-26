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

/** Граф: вершини = вузли OSM, ребра = напрямлені відрізки колії. */
function buildGraph(data) {
  const idOf = new Map();
  const pts = [], out = [];
  for (const [id, lat, lon] of data.nodes) { idOf.set(id, pts.length); pts.push([lat, lon]); out.push([]); }
  const eFrom = [], eTo = [], eW = [];
  for (const refs of data.ways) {
    const nds = refs.map(r => idOf.get(r)).filter(i => i !== undefined);
    for (let k = 1; k < nds.length; k++) {
      const u = nds[k - 1], v = nds[k];
      if (u === v) continue;
      const w = haversine(pts[u][0], pts[u][1], pts[v][0], pts[v][1]);
      out[u].push(eFrom.length); eFrom.push(u); eTo.push(v); eW.push(w);
      out[v].push(eFrom.length); eFrom.push(v); eTo.push(u); eW.push(w);
    }
  }

  const grid = new Map();
  pts.forEach(([la, lo], i) => {
    const key = `${Math.floor(la / CELL)}:${Math.floor(lo / CELL)}`;
    let c = grid.get(key);
    if (!c) grid.set(key, c = []);
    c.push(i);
  });

  return {
    pts, out, grid, ways: data.ways.length,
    eFrom: Int32Array.from(eFrom), eTo: Int32Array.from(eTo), eW: Float64Array.from(eW),
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

let graphPromise = null;

/** Граф будується один раз на процес. */
export function getGraph() {
  if (!graphPromise) {
    graphPromise = (async () => {
      const data = await loadData();
      const t0 = Date.now();
      const g = buildGraph(data);
      console.log(`[network] граф: ${g.pts.length} вузлів, ${g.eFrom.length / 2} відрізків, ${g.ways} ways (${Date.now() - t0} мс)`);
      return g;
    })().catch(e => { graphPromise = null; throw e; });
  }
  return graphPromise;
}
