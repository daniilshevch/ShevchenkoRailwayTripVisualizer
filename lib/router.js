// Побудова маршруту поїзда по коліях OSM.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { haversine, turnAngle } from './geo.js';
import { resolveStation } from './stations.js';
import { getGraph, nearbyNodes, loadData } from './network.js';

// Максимальний кут повороту на стрілці. Поїзд не може з'їхати з однієї гілки на іншу "назад".
const MAX_TURN_DEG = 110;
// Штраф за зміну напрямку руху на станції (еквівалент у метрах): розворот лише якщо він економить більше
const REVERSAL_COST_M = 20000;
// Радіус, у якому шукаємо точки колії біля станції
const SNAP_RADIUS_M = 2500;
const SNAP_MAX_CANDIDATES = 60;
// Версія алгоритму: змініть, щоб скинути кеш готових маршрутів
const ALGO_VERSION = 6;

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache', 'routes');

function snapCandidates(g, st) {
  let c = nearbyNodes(g, st.lat, st.lon, SNAP_RADIUS_M);
  if (!c.length) c = nearbyNodes(g, st.lat, st.lon, 20000).slice(0, 1);
  return c.slice(0, SNAP_MAX_CANDIDATES);
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Дейкстра по напрямлених ребрах (стан = ребро), щоб заборонити
 * нереальні для поїзда різкі розвороти на стрілках.
 * dist/parent — розріджені Map, бо граф на всю Україну, а обходимо його малу частину.
 */
function shortestPath(g, starts, targets) {
  const dist = new Map();
  const parent = new Map();
  const tOff = new Map(targets.map(t => [t.i, t.d * 2]));
  const heap = new Heap();

  for (const s of starts) {
    for (const e of g.out[s.i]) {
      const c = s.d * 2 + g.eC[e];
      if (c < (dist.get(e) ?? Infinity)) { dist.set(e, c); parent.set(e, -1); heap.push(c, e); }
    }
  }

  let best = Infinity, bestEdge = -1;
  while (heap.size) {
    const [c, e] = heap.pop();
    if (c > dist.get(e)) continue;
    if (c >= best) break;
    const u = g.eFrom[e], v = g.eTo[e];
    if (tOff.has(v) && c + tOff.get(v) < best) { best = c + tOff.get(v); bestEdge = e; }
    const pu = g.pts[u], pv = g.pts[v];
    for (const f of g.out[v]) {
      const w = g.eTo[f];
      if (w === u) continue;
      let extra = 0;
      if (turnAngle(pu, pv, g.pts[w]) > MAX_TURN_DEG) {
        // Різкий поворот = зміна напрямку руху. Можлива лише на станції, і це дорого.
        if (g.revStation[v] < 0) continue;
        extra = REVERSAL_COST_M;
      }
      const nc = c + g.eC[f] + extra;
      if (nc < (dist.get(f) ?? Infinity)) { dist.set(f, nc); parent.set(f, e); heap.push(nc, f); }
    }
  }
  if (bestEdge < 0) return null;

  const edges = [];
  for (let e = bestEdge; e >= 0; e = parent.get(e)) edges.push(e);
  edges.reverse();
  const coords = [g.pts[g.eFrom[edges[0]]]];
  let len = 0;
  for (const e of edges) { coords.push(g.pts[g.eTo[e]]); len += g.eW[e]; }

  const reversals = [];
  for (let k = 1; k < edges.length; k++) {
    const u = g.eFrom[edges[k - 1]], v = g.eTo[edges[k - 1]], w = g.eTo[edges[k]];
    if (turnAngle(g.pts[u], g.pts[v], g.pts[w]) > MAX_TURN_DEG) {
      reversals.push({ station: g.stationNames[g.revStation[v]], lat: g.pts[v][0], lon: g.pts[v][1] });
    }
  }
  return { coords, lengthM: len, reversals, snapStartM: starts[0]?.d, snapEndM: targets[0]?.d };
}

export async function cacheKey(kind, payload) {
  const { importedAt } = await loadData();
  return crypto.createHash('sha1')
    .update(JSON.stringify({ k: kind, v: ALGO_VERSION, d: importedAt, p: payload })).digest('hex').slice(0, 16);
}

export async function readCache(key) {
  try { return JSON.parse(await fs.readFile(path.join(ROUTES_DIR, key + '.json'), 'utf8')); }
  catch { return null; }
}
export async function writeCache(key, value) {
  await fs.mkdir(ROUTES_DIR, { recursive: true });
  await fs.writeFile(path.join(ROUTES_DIR, key + '.json'), JSON.stringify(value));
}

/**
 * Ділянки маршруту між сусідніми знайденими станціями.
 * Ділянка: { from, to, ok, distanceKm, coords: [[lat, lon]...], reversals, snapM: [старт, кінець] }
 */
export async function routeSegments(stations, log = () => {}) {
  const g = await getGraph();
  const t0 = Date.now();
  const segments = [];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i];
    const res = shortestPath(g, snapCandidates(g, a), snapCandidates(g, b));
    if (!res) {
      log(`${a.name} → ${b.name}: шлях по коліях не знайдено, малюю пряму`);
      segments.push({ from: a.name, to: b.name, ok: false, distanceKm: haversine(a.lat, a.lon, b.lat, b.lon) / 1000, coords: [[a.lat, a.lon], [b.lat, b.lon]], reversals: [] });
      continue;
    }
    for (const [m, st] of [[res.snapStartM, a], [res.snapEndM, b]]) {
      if (m > 1500) log(`${st.name}: найближча колія за ${Math.round(m)} м — перевірте координати станції`);
    }
    segments.push({ from: a.name, to: b.name, ok: true, distanceKm: res.lengthM / 1000, coords: res.coords, reversals: res.reversals, snapM: [res.snapStartM, res.snapEndM] });
  }
  console.log(`[route] пошук шляху: ${Date.now() - t0} мс`);
  return segments;
}

/** Головна функція: список станцій -> маршрут. */
export async function buildRoute(stationInputs) {
  const key = await cacheKey('route', stationInputs);
  const cached = await readCache(key);
  if (cached) {
    console.log('[route] готовий маршрут з кешу');
    return { ...cached, fromCache: true };
  }

  const warnings = [];
  const log = m => { console.log('[route] ' + m); warnings.push(m); };

  const stations = [];
  for (const inp of stationInputs) {
    const st = await resolveStation(inp, stations.at(-1));
    if (st.match === 'fuzzy') log(`"${st.input}" → знайдено як "${st.name}" (нечіткий збіг)`);
    stations.push(st);
  }

  const segments = await routeSegments(stations, log);

  const route = {
    stations,
    segments,
    totalKm: segments.reduce((s, x) => s + x.distanceKm, 0),
    warnings,
  };
  await writeCache(key, route);
  return route;
}

export function toGeoJSON(route) {
  return {
    type: 'FeatureCollection',
    features: [
      ...route.segments.map(s => ({
        type: 'Feature',
        properties: { from: s.from, to: s.to, distanceKm: +s.distanceKm.toFixed(2), onRails: s.ok },
        geometry: { type: 'LineString', coordinates: s.coords.map(([la, lo]) => [lo, la]) },
      })),
      ...route.stations.map((s, i) => ({
        type: 'Feature',
        properties: { order: i + 1, name: s.name, input: s.input, osm: s.id },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    ],
  };
}
