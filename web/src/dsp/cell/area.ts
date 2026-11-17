/**
 * WEA alert areas and geo-fencing triggers, formats derived from our own recordings (the defining document,
 * ATIS-0700041, is outside the specs this app is built from).
 * Area (warningAreaCoordinatesSegment-r15, segments joined in segment-number order): a 16-bit header of unsettled
 * meaning, then points of 44 bits, 22-bit latitude (v * 180 / 2^22 - 90) then 22-bit longitude (v * 360 / 2^22 - 180);
 * the ring closes on its first point.
 * Trigger (CMAS 4400, 8-bit data): a 2-byte header, then (message identifier, serial number) pairs of 16 bits each.
 */
export type LatLon = [number, number];
export interface WarningArea { header: string; points: LatLon[]; closed: boolean; bounds: [number, number, number, number]; areaKm2: number; derived: true }
export interface GeoTrigger { header: string; pairs: { id: number; serial: number }[]; derived: true }

const bitsOf = (hex: string) => Array.from(hex.toLowerCase(), c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');

export function parseWarningArea(hex: string): WarningArea | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length < 4 + 22) return null;
  const b = bitsOf(hex), body = b.slice(16), n = Math.floor(body.length / 44);
  if (n < 3) return null;
  const points: LatLon[] = [];
  for (let i = 0; i < n; i++) {
    const lat = parseInt(body.slice(44 * i, 44 * i + 22), 2) * 180 / 2 ** 22 - 90, lon = parseInt(body.slice(44 * i + 22, 44 * i + 44), 2) * 360 / 2 ** 22 - 180;
    points.push([lat, lon]);
  }
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  const [f, l] = [points[0], points[n - 1]], closed = f[0] === l[0] && f[1] === l[1];
  return { header: hex.slice(0, 4).toUpperCase(), points, closed, bounds: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)], areaKm2: ringAreaKm2(points), derived: true };
}

export function parseGeoTrigger(hex: string): GeoTrigger | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 12 || (hex.length - 4) % 8) return null;
  const pairs: GeoTrigger['pairs'] = [];
  for (let i = 4; i < hex.length; i += 8) pairs.push({ id: parseInt(hex.slice(i, i + 4), 16), serial: parseInt(hex.slice(i + 4, i + 8), 16) });
  return { header: hex.slice(0, 4).toUpperCase(), pairs, derived: true };
}

const R = 6_371_008.8;
/** Local equirectangular projection around a reference latitude, in meters. */
function project(p: LatLon, lat0: number, lon0: number): [number, number] {
  const k = Math.PI / 180;
  return [(p[1] - lon0) * k * R * Math.cos(lat0 * k), (p[0] - lat0) * k * R];
}
export function ringAreaKm2(pts: LatLon[]): number {
  if (pts.length < 3) return 0;
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length, lon0 = pts[0][1], xy = pts.map(p => project(p, lat0, lon0));
  let s = 0;
  for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2 / 1e6;
}
export function insideRing(p: LatLon, pts: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i], [yj, xj] = pts[j];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Shortest distance in meters from p to the ring's edge. */
export function distanceToEdgeM(p: LatLon, pts: LatLon[]): number {
  const xy = pts.map(q => project(q, p[0], p[1]));
  let best = Infinity;
  for (let i = 0; i < xy.length; i++) {
    const [ax, ay] = xy[i], [bx, by] = xy[(i + 1) % xy.length], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
/** Where the receiver stands relative to an alert area. */
export function areaRelation(p: LatLon, a: WarningArea): { inside: boolean; edgeM: number } {
  return { inside: insideRing(p, a.points), edgeM: distanceToEdgeM(p, a.points) };
}
