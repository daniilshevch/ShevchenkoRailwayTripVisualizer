// Режим «Поїзд (JSON з бекенду)»: розклад у форматі основного бекенду -> /api/train-route.
// Використовує спільні змінні та функції з index.html: map, routeLayer, look, segColor, esc, $, setStatus,
// mode, trainRoute, trainInput, MODE_KEY, TRAIN_KEY, scheduleBuild, fitOnNextDraw.

function setMode(m) {
  mode = m;
  localStorage.setItem(MODE_KEY, m);
  document.body.classList.toggle('train', m === 'train');
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  routeLayer.clearLayers();
  $('total').textContent = '';
  $('warnings').innerHTML = '';
  setStatus('');
  if (m === 'train') {
    if (trainRoute) { drawTrain(trainRoute, true); renderTrainTable(trainRoute); }
    else setStatus('Вставте JSON розкладу або натисніть «Приклад»');
  } else {
    fitOnNextDraw = true;
    scheduleBuild();
  }
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

$('trainJson').value = localStorage.getItem(TRAIN_KEY) || '';
$('trainJson').addEventListener('input', () => localStorage.setItem(TRAIN_KEY, $('trainJson').value));

$('trainSample').onclick = async () => {
  const data = await (await fetch('/samples/train-odesa-yasinia.json')).json();
  $('trainJson').value = JSON.stringify(data, null, 2);
  localStorage.setItem(TRAIN_KEY, $('trainJson').value);
  buildTrain();
};
$('trainBuild').onclick = () => buildTrain();

async function buildTrain() {
  let stops;
  try {
    const parsed = JSON.parse($('trainJson').value);
    stops = Array.isArray(parsed) ? parsed : parsed.stops;
    if (!Array.isArray(stops)) throw new Error('очікується масив зупинок');
  } catch (e) {
    setStatus('Некоректний JSON: ' + e.message, true);
    return;
  }
  setStatus('Будую маршрут…');
  try {
    const t0 = performance.now();
    const res = await fetch('/api/train-route', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stops),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (mode !== 'train') return;
    trainRoute = data;
    trainInput = stops;
    drawTrain(data, true);
    renderTrainTable(data);
    setStatus(`Готово за ${Math.round(performance.now() - t0)} мс${data.fromCache ? ' (з кешу)' : ''}`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

const ukName = s => s.titleUk || s.title;
const fmtTime = t => t ? t.slice(11, 16) : '—';
const toLatLng = coords => coords.map(([lo, la]) => [la, lo]);
const matchLabel = m => m === 'code' ? 'за кодом' : m === 'override' ? 'ручне виправлення' : 'за назвою';

function drawTrain(r, fit = false) {
  routeLayer.clearLayers();
  const all = L.latLngBounds([]), trip = L.latLngBounds([]);
  if (look.outline) {
    r.segments.forEach(s => L.polyline(toLatLng(s.geometry.coordinates), {
      color: '#fff', weight: look.weight + 5, opacity: s.isPartOfTrip ? 0.95 : 0.5, interactive: false,
    }).addTo(routeLayer));
  }
  r.segments.forEach((s, i) => {
    const a = r.stops[s.fromIndex], b = r.stops[s.toIndex];
    const ok = s.status === 'ok';
    const line = L.polyline(toLatLng(s.geometry.coordinates), {
      color: segColor(i, ok),
      weight: s.isPartOfTrip ? look.weight : Math.max(2, look.weight - 2),
      opacity: s.isPartOfTrip ? 0.95 : 0.45,
      dashArray: !ok ? '8 8' : s.isPartOfTrip ? null : '10 8',
    }).bindTooltip(`${esc(ukName(a))} → ${esc(ukName(b))}: ${s.distanceKm} км` +
      (s.officialKm != null ? ` (за розкладом ${s.officialKm} км)` : '') +
      (s.isPartOfTrip ? '' : '<br><i>поза поїздкою</i>'), { sticky: true });
    line.on('click', () => highlightRow(s.toIndex));
    routeLayer.addLayer(line);
    all.extend(line.getBounds());
    if (s.isPartOfTrip) trip.extend(line.getBounds());
    s.reversals.forEach(rv => L.marker([rv.lat, rv.lon], {
      icon: L.divIcon({ className: 'rev-icon', html: '⇄', iconSize: [22, 22] }),
    }).bindTooltip(`Зміна напрямку руху: ${esc(rv.station)}`, { direction: 'top', offset: [0, -10] }).addTo(routeLayer));
  });

  r.stops.forEach((s, i) => {
    if (s.lat == null) return;
    const inp = (trainInput && trainInput[i]) || {};
    const end = r.trip && (i === r.trip.fromIndex || i === r.trip.toIndex);
    const byCode = s.match === 'code' || s.match === 'override';
    L.circleMarker([s.lat, s.lon], {
      radius: end ? 9 : s.isPartOfTrip ? 6 : 4,
      color: s.isPartOfTrip ? '#111' : '#888', weight: 2,
      fillColor: byCode ? '#fff' : '#ffe08a', fillOpacity: 1,
    })
      .bindTooltip(esc(ukName(s)), { permanent: s.isPartOfTrip, direction: 'right', offset: [7, 0], className: s.isPartOfTrip ? '' : 'off-label' })
      .bindPopup(`<b>${esc(ukName(s))}</b> · ${s.stationId}<br>` +
        (ukName(s) !== s.title ? `У розкладі: ${esc(s.title)}<br>` : '') +
        (s.osm ? `OSM: <a target="_blank" href="https://www.openstreetmap.org/${s.osm.id}">${esc(s.osm.name)}</a> (${matchLabel(s.match)})<br>` : '') +
        `Прибуття ${fmtTime(inp.arrival_time)}, відправлення ${fmtTime(inp.departure_time)}<br>` +
        `Км: ${s.kmFromStart ?? '—'} по OSM, ${s.officialKm ?? '—'} за розкладом`)
      .on('click', () => highlightRow(i))
      .addTo(routeLayer);
  });
  if (fit) map.fitBounds(trip.isValid() ? trip : all, { padding: [30, 30] });

  const tripKm = r.segments.filter(s => s.isPartOfTrip).reduce((x, s) => x + s.distanceKm, 0);
  const tripOff = r.trip ? r.stops[r.trip.toIndex].officialKm - r.stops[r.trip.fromIndex].officialKm : null;
  $('total').innerHTML = `Поїздка: ${tripKm.toFixed(1)} км${tripOff != null ? ` <span class="muted">(за розкладом ${tripOff})</span>` : ''}` +
    `<div class="muted">Увесь маршрут: ${r.totalKm} км (за розкладом ${r.officialTotalKm ?? '—'})</div>`;

  const order = { error: 0, warning: 1, info: 2 };
  $('warnings').innerHTML = [...r.issues].sort((a, b) => order[a.severity] - order[b.severity])
    .map(i => `<div class="issue ${i.severity}">${esc(i.message)}</div>`).join('');
}

function renderTrainTable(r) {
  const segByStop = {};
  r.segments.forEach((s, k) => { segByStop[s.toIndex] = { s, k }; });
  const flagged = new Set(r.issues.filter(i => i.code === 'DISTANCE_MISMATCH').map(i => i.segmentIndex));

  const rows = r.stops.map((s, i) => {
    const d = segByStop[i];
    const badge = s.match === 'not_found' ? '<span class="badge err">не знайдено</span>'
      : s.match === 'code' || s.match === 'override' ? ''
      : '<span class="badge" title="Коду немає в OSM, знайдено за назвою">за назвою</span>';
    const orig = ukName(s) !== s.title ? `<small>${esc(s.title)}</small>` : '';
    const dev = d && d.s.deviationKm != null
      ? `<span class="${flagged.has(d.k) ? 'bad' : ''}">${d.s.deviationKm > 0 ? '+' : ''}${d.s.deviationKm}</span>` : '';
    return `<tr data-i="${i}" class="${s.isPartOfTrip ? '' : 'off'}"><td>${i + 1}</td>` +
      `<td class="name">${esc(ukName(s))}${badge}${orig}</td>` +
      `<td>${s.officialKm ?? '—'}</td><td>${s.kmFromStart ?? '—'}</td><td>${dev}</td></tr>`;
  });

  $('trainTable').innerHTML = '<table class="tt"><thead><tr><th>#</th><th>Станція</th>' +
    '<th title="Кілометраж за розкладом">Розклад</th><th title="Кілометраж по коліях OSM">OSM</th>' +
    '<th title="Різниця на ділянці, км">Δ</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';

  $('trainTable').querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => {
    const s = r.stops[+tr.dataset.i];
    if (s.lat != null) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 11));
    highlightRow(+tr.dataset.i);
  });
}

function highlightRow(i) {
  $('trainTable').querySelectorAll('tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.i === String(i)));
  const row = $('trainTable').querySelector(`tr[data-i="${i}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

setMode(mode);
