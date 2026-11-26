// Простий сервер без залежностей: статичні файли + POST /api/route
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoute } from './lib/router.js';
import { getGraph } from './lib/network.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json; charset=utf-8', '.css': 'text/css' };

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/route') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { stations } = JSON.parse(body);
      if (!Array.isArray(stations) || stations.length < 2) return send(res, 400, { error: 'Потрібно мінімум 2 станції' });
      const t0 = Date.now();
      const route = await buildRoute(stations);
      console.log(`[server] маршрут за ${((Date.now() - t0) / 1000).toFixed(1)} с, ${route.totalKm.toFixed(1)} км`);
      return send(res, 200, route);
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'public/index.html'
        : url.pathname === '/stations.json' ? 'stations.json'
        : path.join('public', path.normalize(url.pathname).replace(/^([/\\])+/, ''));
      const full = path.join(ROOT, file);
      if (!full.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
      const data = await fs.readFile(full);
      return send(res, 200, data, TYPES[path.extname(full)] || 'application/octet-stream');
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, e.code === 'ENOENT' ? 404 : 500, { error: e.message });
  }
});

server.requestTimeout = 0;
server.listen(PORT, () => {
  console.log(`Відкрийте http://localhost:${PORT}`);
  // граф будується у фоні одразу при старті, щоб перший маршрут не чекав
  getGraph().catch(e => console.error('[network] помилка завантаження:', e.message));
});
