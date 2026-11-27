// Простий сервер без залежностей:
//   POST /api/train-route  — маршрут за розкладом з основного бекенду (масив зупинок)
//   POST /api/route        — маршрут за списком назв (для тестового редактора)
//   GET  /api/stations     — назви станцій для автопідказки
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoute } from './lib/router.js';
import { getGraph } from './lib/network.js';
import { listStationNames } from './lib/stations.js';
import { buildTrainRoute } from './lib/train.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json; charset=utf-8', '.css': 'text/css' };

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Тіло запиту — не JSON'), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/train-route') {
      const body = await readJson(req);
      const stops = Array.isArray(body) ? body : body.stops;
      const t0 = Date.now();
      const route = await buildTrainRoute(stops, { detail: url.searchParams.get('detail') === 'full' ? 'full' : 'simplified' });
      console.log(`[server] маршрут поїзда за ${Date.now() - t0} мс, ${route.totalKm} км, зауважень: ${route.issues.length}`);
      return send(res, 200, route);
    }
    if (req.method === 'POST' && url.pathname === '/api/route') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { stations } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(stations) || stations.length < 2) return send(res, 400, { error: 'Потрібно мінімум 2 станції' });
      const t0 = Date.now();
      const route = await buildRoute(stations);
      console.log(`[server] маршрут за ${((Date.now() - t0) / 1000).toFixed(1)} с, ${route.totalKm.toFixed(1)} км`);
      return send(res, 200, route);
    }
    if (req.method === 'GET' && url.pathname === '/api/stations') {
      return send(res, 200, await listStationNames());
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'public/index.html'
        : url.pathname === '/stations.json' ? 'stations.json'
        : url.pathname.startsWith('/samples/') ? path.normalize(url.pathname).replace(/^([/\\])+/, '')
        : path.join('public', path.normalize(url.pathname).replace(/^([/\\])+/, ''));
      const full = path.join(ROOT, file);
      if (!full.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
      const data = await fs.readFile(full);
      return send(res, 200, data, TYPES[path.extname(full)] || 'application/octet-stream');
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status || (e.code === 'ENOENT' ? 404 : e.station ? 422 : 500), { error: e.message, station: e.station, hints: e.hints });
  }
});

server.requestTimeout = 0;
server.listen(PORT, () => {
  console.log(`Відкрийте http://localhost:${PORT}`);
  // граф будується у фоні одразу при старті, щоб перший маршрут не чекав
  getGraph().catch(e => console.error('[network] помилка завантаження:', e.message));
});
