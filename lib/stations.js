// Пошук станцій України в OSM за назвою.
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

async function loadIndex() {
  if (index) return index;
  const data = await loadData();
  index = [];
  for (const el of data.stations) {
    const t = el.tags || {};
    if (SKIP_STATION.test(t.station || '')) continue;
    const { lat, lon } = el;
    const names = new Set();
    for (const k of NAME_TAGS) {
      if (t[k]) t[k].split(';').forEach(n => names.add(normalize(n)));
    }
    if (!names.size) continue;
    index.push({
      id: el.id,
      name: t['name:uk'] || t.name,
      lat, lon,
      isStation: t.railway === 'station' || t.public_transport === 'station',
      isMajor: t.station === 'major',
      primary: normalize(t['name:uk'] || t.name || ''),
      names: [...names],
    });
  }
  console.log(`[stations] в індексі ${index.length} станцій/зупинок`);
  return index;
}

/**
 * input: рядок або {name, lat?, lon?}
 * near: попередня знайдена станція (для вибору серед однойменних)
 */
export async function resolveStation(input, near) {
  const q = typeof input === 'string' ? { name: input } : input;
  if (q.lat != null && q.lon != null) {
    return { input: q.name, name: q.name, lat: +q.lat, lon: +q.lon, id: null, match: 'coords' };
  }
  const idx = await loadIndex();
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
  return {
    input: q.name,
    name: best.s.name,
    lat: best.s.lat,
    lon: best.s.lon,
    id: best.s.id,
    match: best.score < 1 ? 'exact' : best.score < 1.5 ? 'alias' : 'fuzzy',
  };
}

/** Унікальні назви станцій для автопідказки в інтерфейсі. */
export async function listStationNames() {
  const idx = await loadIndex();
  const names = new Set(idx.filter(s => s.name).map(s => s.name));
  return [...names].sort((a, b) => a.localeCompare(b, 'uk'));
}
