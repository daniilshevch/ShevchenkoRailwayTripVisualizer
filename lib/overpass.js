// Мінімальний клієнт Overpass API з дисковим кешем.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];


export async function overpass(query, { label = 'query' } = {}) {
  const hash = crypto.createHash('sha1').update(query).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, `${hash}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    console.log(`[overpass] ${label}: з кешу`);
    return cached;
  } catch { /* немає в кеші */ }

  let lastErr;
  for (let round = 0; round < 4; round++) {
  if (round) {
    const wait = 20 * round;
    console.log(`[overpass] ${label}: сервери перевантажені, повтор через ${wait} с`);
    await new Promise(r => setTimeout(r, wait * 1000));
  }
  for (const url of ENDPOINTS) {
    try {
      console.log(`[overpass] ${label}: запит до ${new URL(url).host} ...`);
      const t0 = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'RailwayMapTest/0.1',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`[overpass] ${label}: ${json.elements?.length ?? 0} елементів за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(file, JSON.stringify(json));
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`[overpass] ${label}: ${new URL(url).host} не відповів (${e.message})`);
    }
  }
  }
  throw new Error(`Overpass недоступний: ${lastErr?.message}`);
}
