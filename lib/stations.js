// Пошук станцій в OSM: за кодом (UIC/ЄСР), ручними виправленнями або за назвою.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from './network.js';
import { haversine } from './geo.js';

const NAME_TAGS = ['name', 'name:uk', 'official_name', 'alt_name', 'old_name', 'name:ru', 'name:en'];
const SKIP_STATION = /^(subway|light_rail|monorail|funicular|tram)$/;

const MAIN_SUFFIX = /^(головн|пасажирськ|центральн)/;

const ROMAN = { i: '1', 'і': '1', ii: '2', 'іі': '2', iii: '3', 'ііі': '3', iv: '4', 'іv': '4' };

export function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[ʼ’'`"«»]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[-–—_.,()/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !['станція', 'ст', 'зп', 'зупинний', 'пункт', 'платформа', 'пл'].includes(t))
    .map(t => ROMAN[t] ?? t)
    .join(' ');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

let index = null;
let byCode = null; // код UIC/ЄСР -> [станції]

const OVERRIDES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'station-overrides.json');

/**
 * Ручні виправлення: data/station-overrides.json
 *   { "2218300": { "osm": "node/123" } }                   — прив'язати код до конкретного об'єкта OSM
 *   { "2218300": { "lat": 49.55, "lon": 25.59, "name": "Тернопіль" } } — задати координати
 * Файл читається при кожному запиті, тож правки діють без перезапуску.
 */
export async function loadOverrides() {
  try { return JSON.parse(await fs.readFile(OVERRIDES_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`Помилка в ${OVERRIDES_FILE}: ${e.message}`); }
}

async function loadIndex() {
  if (index) return index;
  const data = await loadData();
  index = [];
  byCode = new Map();
  for (const el of data.stations) {
    const t = el.tags || {};
    if (SKIP_STATION.test(t.station || '')) continue;
    const { lat, lon } = el;
    const names = new Set();
    for (const k of NAME_TAGS) {
      if (t[k]) t[k].split(';').forEach(n => names.add(normalize(n)));
    }
    if (!names.size) continue;
    const entry = {
      id: el.id,
      name: t['name:uk'] || t.name,
      lat, lon,
      isStation: t.railway === 'station' || t.public_transport === 'station',
      isMajor: t.station === 'major',
      primary: normalize(t['name:uk'] || t.name || ''),
      names: [...names],
    };
    index.push(entry);
    for (const k of ['uic_ref', 'esr:user', 'railway:ref']) {
      for (const code of String(t[k] || '').split(';').map(c => c.trim()).filter(Boolean)) {
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(entry);
      }
    }
  }
  console.log(`[stations] в індексі ${index.length} станцій/зупинок`);
  return index;
}

const pick = (entry, q, match) => ({
  input: q.name, code: q.code ?? null, name: entry.name, lat: entry.lat, lon: entry.lon, id: entry.id, match,
});

/**
 * input: рядок або {name, code?, lat?, lon?}
 *   code — код станції (UIC, напр. 2208001, або ЄСР); якщо є в OSM, назва не потрібна
 * near: попередня знайдена станція (для вибору серед однойменних)
 */
export async function resolveStation(input, near) {
  const q = typeof input === 'string' ? { name: input } : { ...input };
  if (q.lat != null && q.lon != null) {
    return { input: q.name, code: q.code ?? null, name: q.name, lat: +q.lat, lon: +q.lon, id: null, match: 'coords' };
  }
  const idx = await loadIndex();

  if (q.code != null) {
    const code = String(q.code);
    const ov = (await loadOverrides())[code];
    if (ov) {
      if (ov.lat != null && ov.lon != null) {
        return { input: q.name, code, name: ov.name || q.name, lat: +ov.lat, lon: +ov.lon, id: ov.osm || null, match: 'override' };
      }
      const e = ov.osm && idx.find(s => s.id === ov.osm);
      if (e) return pick(e, q, 'override');
    }
    const hits = byCode.get(code);
    if (hits?.length) {
      // кілька об'єктів з одним кодом (вузол + полігон станції) — беремо станцію, ближчу до попередньої
      const best = [...hits].sort((a, b) => (b.isStation - a.isStation) ||
        (near ? haversine(near.lat, near.lon, a.lat, a.lon) - haversine(near.lat, near.lon, b.lat, b.lon) : 0))[0];
      return pick(best, q, 'code');
    }
  }
  if (!q.name) {
    const err = new Error(`Станцію з кодом ${q.code} не знайдено в OSM, а назви немає`);
    err.station = String(q.code);
    throw err;
  }
  const nq = normalize(q.name);

  const scored = [];
  for (const s of idx) {
    let score = null;
    if (s.primary === nq) score = 0;
    else if (s.names.includes(nq)) score = 1;
    else if (s.names.some(n => n.startsWith(nq + ' ') || nq.startsWith(n + ' '))) {
      // "Львів" -> "Львів-Головний": головні вокзали вище за інші станції міста
      const rest = s.primary.startsWith(nq + ' ') ? s.primary.slice(nq.length + 1) : '';
      score = MAIN_SUFFIX.test(rest) ? 1.2 : 2;
    }
    else if (nq.length >= 5) {
      const d = Math.min(...s.names.map(n => levenshtein(n, nq)));
      if (d <= 2) score = 2 + d;
    }
    if (score == null) continue;
    if (!s.isStation) score += 0.5;
    if (s.isMajor) score -= 0.1;
    const dist = near ? haversine(near.lat, near.lon, s.lat, s.lon) : 0;
    scored.push({ s, score, dist });
  }

  if (!scored.length) {
    const hints = idx
      .map(s => ({ s, d: levenshtein(s.primary, nq) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map(x => x.s.name);
    const err = new Error(`Станцію "${q.name}" не знайдено в OSM. Схожі: ${hints.join(', ')}`);
    err.station = q.name;
    err.hints = hints;
    throw err;
  }

  scored.sort((a, b) => a.score - b.score || a.dist - b.dist);
  const best = scored[0];
  return pick(best.s, q, best.score < 1 ? 'exact' : best.score < 1.5 ? 'alias' : 'fuzzy');
}

/** Унікальні назви станцій для автопідказки в інтерфейсі. */
export async function listStationNames() {
  const idx = await loadIndex();
  const names = new Set(idx.filter(s => s.name).map(s => s.name));
  return [...names].sort((a, b) => a.localeCompare(b, 'uk'));
}
