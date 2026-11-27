// Маршрут поїзда за розкладом з основного бекенду (.NET).
//
// Вхід — масив зупинок у форматі бекенду:
//   { station_id, station_title, is_part_of_trip, distance_from_full_route_starting_station, ... }
// Станція шукається за station_id (код UIC) і лише якщо його немає в OSM — за station_title.
import { simplify, haversine } from './geo.js';
import { resolveStation, loadOverrides } from './stations.js';
import { routeSegments, cacheKey, readCache, writeCache } from './router.js';
import { loadData } from './network.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Українські назви станцій: { "<station_id>": "Назва" }. Мають пріоритет над назвами з OSM.
// Файл читається на кожен запит і входить у ключ кешу — правки діють одразу.
const NAMES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'station-names-uk.json');
async function loadNamesUk() {
  try { return JSON.parse(await fs.readFile(NAMES_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`Помилка в ${NAMES_FILE}: ${e.message}`); }
}

// Точність спрощення лінії, м: на карті не видно, а точок у 5–10 разів менше
const SIMPLIFY_M = 10;
// Розбіжність з офіційним кілометражем, після якої ділянку позначаємо як підозрілу
const MISMATCH_MIN_KM = 3;
const MISMATCH_RATIO = 0.05;

const round = (x, d = 1) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;

/** Поля зупинки, від яких залежить геометрія (час прибуття не впливає на маршрут). */
const routeRelevant = stops => stops.map(s => [s.station_id, s.station_title, s.distance_from_full_route_starting_station, !!s.is_part_of_trip]);

export async function buildTrainRoute(stops, { detail = 'simplified' } = {}) {
  if (!Array.isArray(stops) || stops.length < 2) throw Object.assign(new Error('Потрібно мінімум 2 зупинки'), { status: 400 });

  // ручні виправлення входять у ключ: змінили data/station-overrides.json — маршрути перебудуються
  const namesUk = await loadNamesUk();
  const key = await cacheKey('train:' + detail, [routeRelevant(stops), await loadOverrides(), namesUk]);
  const cached = await readCache(key);
  if (cached) return { ...cached, fromCache: true };

  const issues = [];
  const issue = (severity, code, message, extra = {}) => issues.push({ severity, code, message, ...extra });

  // 1. Станції: за кодом, а якщо коду немає в OSM — за назвою
  const resolved = [];
  const notFound = new Map(); // індекс -> підказки
  let prev = null;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    try {
      const st = await resolveStation({ code: s.station_id, name: s.station_title }, prev);
      resolved.push(st);
      prev = st;
    } catch (e) {
      resolved.push(null);
      notFound.set(i, e.hints);
    }
  }

  // 1a. Перевірка кодів кілометражем: пряма відстань до сусідньої зупинки не може бути
  // помітно більшою за відстань по коліях з розкладу. Якщо станція, знайдена за кодом,
  // "не влазить" ні до одного сусіда — код у розкладі або в OSM помилковий
  // (напр. Бугаз 2208446 у розкладі, а в OSM цей код має з.п. «44 км» під Миколаєвом).
  const rejected = new Map(); // індекс -> станція OSM, яку дав код
  for (let i = 0; i < stops.length; i++) {
    const st = resolved[i];
    if (!st || st.match !== 'code') continue;
    const checks = neighbours(i).map(j => fits(st, resolved[j], i, j)).filter(x => x !== null);
    if (!checks.length || checks.some(Boolean)) continue;
    let alt = null;
    try { alt = await resolveStation({ name: stops[i].station_title }, resolved[i - 1] || null); } catch { /* назва не знайдена */ }
    const altChecks = alt ? neighbours(i).map(j => fits(alt, resolved[j], i, j)).filter(x => x !== null) : [];
    if (alt && altChecks.some(Boolean)) {
      rejected.set(i, st);
      resolved[i] = { ...alt, match: 'name_after_code_mismatch' };
    } else {
      issue('warning', 'LOCATION_SUSPICIOUS',
        `«${stops[i].station_title}» (${stops[i].station_id}): станція з цим кодом в OSM («${st.name}») надто далеко від сусідніх зупинок, а за назвою кращої не знайдено. Перевірте код або додайте виправлення`,
        { stopIndex: i });
    }
  }

  function neighbours(i) {
    const out = [];
    for (let j = i - 1; j >= 0; j--) if (resolved[j]) { out.push(j); break; }
    for (let j = i + 1; j < stops.length; j++) if (resolved[j]) { out.push(j); break; }
    return out;
  }
  /** true — відстань правдоподібна, false — ні, null — нема з чим порівняти. */
  function fits(a, b, i, j) {
    const oi = stops[i].distance_from_full_route_starting_station, oj = stops[j].distance_from_full_route_starting_station;
    if (!b || oi == null || oj == null) return null;
    const straightKm = haversine(a.lat, a.lon, b.lat, b.lon) / 1000;
    return straightKm <= Math.abs(oi - oj) * 1.2 + 5;
  }

  // Назва українською: файл перекладів -> назва з OSM (name:uk) -> назва з розкладу
  const uk = stops.map((s, i) => namesUk[String(s.station_id)] || resolved[i]?.name || s.station_title);

  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], st = resolved[i];
    if (!st) {
      issue('error', 'STATION_NOT_FOUND', `«${uk[i]}» (${s.station_id}) не знайдено: ні код, ні назва. Додайте її в data/station-overrides.json`, { stopIndex: i, hints: notFound.get(i) });
    } else if (rejected.has(i)) {
      issue('warning', 'CODE_MISMATCH',
        `«${uk[i]}»: код ${s.station_id} в OSM належить «${rejected.get(i).name}», що не відповідає кілометражу розкладу. Використано «${st.name}», знайдену за назвою. Перевірте код станції`,
        { stopIndex: i, osmByCode: rejected.get(i).id });
    } else if (st.match === 'fuzzy') {
      issue('warning', 'FUZZY_MATCH', `«${s.station_title}» знайдено як «${st.name}» (нечіткий збіг назви) — перевірте`, { stopIndex: i });
    } else if (!['code', 'override', 'coords'].includes(st.match)) {
      issue('info', 'MATCHED_BY_NAME', `«${uk[i]}» (${s.station_id}): коду немає в OSM, знайдено за назвою «${s.station_title}»`, { stopIndex: i });
    }
  }

  // 2. Ділянки між знайденими станціями (незнайдені пропускаємо)
  const idx = resolved.map((r, i) => r ? i : -1).filter(i => i >= 0);
  const found = idx.map(i => resolved[i]);
  const raw = await routeSegments(found, () => {});

  const official = i => stops[i].distance_from_full_route_starting_station;
  const stopsOut = stops.map((s, i) => ({
    index: i,
    stationId: s.station_id,
    title: s.station_title,
    titleUk: uk[i],
    osm: resolved[i]?.id ? { id: resolved[i].id, name: resolved[i].name } : null,
    lat: resolved[i] ? round(resolved[i].lat, 6) : null,
    lon: resolved[i] ? round(resolved[i].lon, 6) : null,
    match: resolved[i]?.match ?? 'not_found',
    kmFromStart: null,
    officialKm: official(i) ?? null,
    isPartOfTrip: !!s.is_part_of_trip,
  }));
  if (stopsOut[idx[0]]) stopsOut[idx[0]].kmFromStart = 0;

  let km = 0;
  const segments = raw.map((seg, k) => {
    const from = idx[k], to = idx[k + 1];
    km += seg.distanceKm;
    stopsOut[to].kmFromStart = round(km);
    const offKm = official(to) != null && official(from) != null ? official(to) - official(from) : null;
    const deviation = offKm != null ? seg.distanceKm - offKm : null;
    const out = {
      fromIndex: from,
      toIndex: to,
      status: seg.ok ? 'ok' : 'no_rail_path',
      distanceKm: round(seg.distanceKm),
      officialKm: offKm,
      deviationKm: round(deviation),
      isPartOfTrip: stopsOut[from].isPartOfTrip && stopsOut[to].isPartOfTrip,
      reversals: (seg.reversals || []).map(r => ({ station: r.station, lat: round(r.lat, 6), lon: round(r.lon, 6) })),
      geometry: {
        type: 'LineString',
        coordinates: (detail === 'full' ? seg.coords : simplify(seg.coords, SIMPLIFY_M)).map(([la, lo]) => [round(lo, 6), round(la, 6)]),
      },
    };
    const label = `${uk[from]} → ${uk[to]}`;
    if (!seg.ok) issue('error', 'NO_RAIL_PATH', `${label}: шлях по коліях не знайдено, намальовано пряму`, { segmentIndex: k });
    else if (deviation != null && Math.abs(deviation) > Math.max(MISMATCH_MIN_KM, offKm * MISMATCH_RATIO)) {
      issue('warning', 'DISTANCE_MISMATCH',
        `${label}: ${round(seg.distanceKm)} км по OSM проти ${offKm} км за розкладом (${deviation > 0 ? '+' : ''}${round(deviation)} км) — можливо, маршрут іде не тією лінією`,
        { segmentIndex: k });
    }
    for (const r of out.reversals) issue('info', 'REVERSAL', `${label}: зміна напрямку руху на станції ${r.station}`, { segmentIndex: k });
    return out;
  });

  const { importedAt } = await loadData();
  const tripIdx = stopsOut.filter(s => s.isPartOfTrip).map(s => s.index);
  const result = {
    routeKey: key,
    dataVersion: importedAt,
    totalKm: round(km),
    officialTotalKm: official(stops.length - 1) != null && official(0) != null ? official(stops.length - 1) - official(0) : null,
    trip: tripIdx.length ? { fromIndex: tripIdx[0], toIndex: tripIdx.at(-1) } : null,
    stops: stopsOut,
    segments,
    issues,
  };
  await writeCache(key, result);
  return result;
}
