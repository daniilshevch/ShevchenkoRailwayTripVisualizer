const R = 6371008.8;
const rad = d => d * Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Кут повороту (градуси) у вершині b при русі a -> b -> c. 0 = прямо, 180 = розворот. */
export function turnAngle(a, b, c) {
  const k = Math.cos(rad(b[0]));
  const x1 = (b[1] - a[1]) * k, y1 = b[0] - a[0];
  const x2 = (c[1] - b[1]) * k, y2 = c[0] - b[0];
  const l = Math.hypot(x1, y1) * Math.hypot(x2, y2);
  if (l === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (x1 * x2 + y1 * y2) / l));
  return Math.acos(cos) * 180 / Math.PI;
}

/**
 * Спрощення лінії (Дуглас–Пекер): прибирає точки, що відхиляються від прямої
 * менше ніж на toleranceM метрів. points: [[lat, lon], ...]
 */
export function simplify(points, toleranceM) {
  if (points.length < 3 || toleranceM <= 0) return points;
  const k = Math.cos(rad(points[0][0])) * 111320;
  const xy = points.map(([la, lo]) => [lo * k, la * 110540]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
