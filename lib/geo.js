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
