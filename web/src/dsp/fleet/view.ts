/**
 * What Dispatch's views say about a call, worked out without the DOM: the encryption algorithm by name, the
 * security line, distance and bearing from the listener, the order of the on-air stack (emergencies pinned on top,
 * then the call being heard), and what the now-playing bar names. The page only lays these out.
 */
import type { CallRow, CallPos } from './calls.js';

/** P25 algorithm IDs (TIA-102.BAAC), the publicly documented ones. */
export const P25_ALGS: Record<number, string> = {
  0x80: 'CLEAR', 0x81: 'DES-OFB', 0x82: '2-KEY TRIPLE DES', 0x83: '3-KEY TRIPLE DES', 0x84: 'AES-256', 0x85: 'AES-128',
  0x9f: 'DES-XL', 0xa0: 'DVI-XL', 0xa1: 'DVP-XL', 0xaa: 'ADP (RC4)',
};
const hx = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, '0');
/** NXDN cipher types (TS 1-A Table 6.5-24). */
const NXDN_CIPHER_NAMES = ['CLEAR', 'SCRAMBLE', 'DES', 'AES'];
export const algName = (id: number) => id < 0 ? '' : P25_ALGS[id] ?? `ALGID 0x${hx(id, 2)}`;

/** The call's security in words: 'CLEAR', 'ENCRYPTED' with the algorithm and key when heard, or '' when unknown. */
export function secText(c: Pick<CallRow, 'encrypted' | 'sec' | 'algId' | 'keyId' | 'pi' | 'proto'>): string {
  if (c.encrypted) {
    const parts = ['ENCRYPTED'];
    // DMR algorithm IDs have no public table: shown by number
    if (c.proto === 'DMR') { if (c.pi && c.algId >= 0) parts.push(`ALGID 0x${hx(c.algId, 2)}`, `KEY ${c.keyId}`); else if (c.pi) parts.push('PRIVACY HEADER'); }
    // NXDN: the cipher type of the VCALL (TS 1-A 6.5.27) and its 6-bit key ID
    else if (c.proto === 'NXDN') { if (c.algId > 0) parts.push(NXDN_CIPHER_NAMES[c.algId] ?? `CIPHER ${c.algId}`); if (c.keyId > 0) parts.push(`KEY ${c.keyId}`); }
    else {
      if (c.algId >= 0 && c.algId !== 0x80) parts.push(algName(c.algId));
      if (c.keyId > 0) parts.push(`KEY 0x${hx(c.keyId, 4)}`);
    }
    return parts.join(' · ');
  }
  return c.sec === 'clear' ? 'CLEAR' : '';
}
/** Where the security came from, for the detail line. */
export const SEC_FROM: Record<string, string> = {
  grant: 'grant service options', LDU1: 'voice link control', LDU2: 'encryption sync', HDU: 'call header', LC: 'voice link control',
  EMB: 'voice burst privacy bit', PI: 'privacy header', assumed: 'nothing on the air marked it encrypted',
  VCALL: 'voice call message', SCCH: 'Type-D signaling channel', MAC: 'Phase 2 push to talk', ESS: 'Phase 2 encryption sync', history: 'earlier calls of this talkgroup were encrypted, and no push to talk said otherwise',
  analog: 'analog FM voice heard on the channel',
};

const R_MI = 3958.8;
/** Great-circle distance in miles and the initial bearing in degrees, from [a] to [b]. */
export function distBearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { mi: number; deg: number; dir: string } {
  const r = Math.PI / 180, p1 = a.lat * r, p2 = b.lat * r, dp = (b.lat - a.lat) * r, dl = (b.lon - a.lon) * r;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const mi = 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return { mi, deg, dir: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8] };
}
/** '2.4 mi NE' (or feet under a tenth of a mile). */
export function distText(d: { mi: number; dir: string }): string {
  return d.mi < 0.1 ? `${Math.round(d.mi * 5280)} ft ${d.dir}` : `${d.mi < 10 ? d.mi.toFixed(1) : Math.round(d.mi)} mi ${d.dir}`;
}
/** The position line of a call: distance and bearing from the listener when known, then the coordinates. */
export function posText(p: CallPos, me: { lat: number; lon: number } | null): string {
  const at = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  return me ? `${distText(distBearing(me, p))} · ${at}` : at;
}

/** Emergencies stay pinned on top this long after they end. */
export const EMERGENCY_PIN_MS = 60_000;
/**
 * The on-air stack: emergencies first (and for a minute after they end), then the call being heard, then the rest in
 * the order the receiver ranks them. Calls outside the lock go last.
 */
export function onAirOrder(calls: CallRow[], playing: string, now: number): CallRow[] {
  const shown = calls.filter(c => c.kind === 'call' && (c.onAir || (c.emergency && now - c.endMs < EMERGENCY_PIN_MS)));
  const rank = (c: CallRow) => c.outside ? 4 : c.emergency ? 0 : c.key === playing ? 1 : c.onAir ? 2 : 3;
  return shown.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || (a.c.emergency && b.c.emergency ? b.c.startMs - a.c.startMs : a.i - b.i)).map(x => x.c);
}
/**
 * A card with nothing to hear or name: no talkgroup read and no audio, not the call being heard and not an emergency.
 * These fold into one line under the stack, like the encrypted calls, so they never push a call with audio out.
 */
export const unnamedQuiet = (c: Pick<CallRow, 'tg' | 'audioMs' | 'key' | 'emergency' | 'encrypted'>, playing: string) =>
  !c.encrypted && !c.tg && c.audioMs <= 0 && c.key !== playing && !c.emergency;
/** What the now-playing bar names, or null when nothing is heard. */
export function nowPlaying(calls: CallRow[], playing: string): CallRow | null {
  return playing ? calls.find(c => c.key === playing && c.onAir) ?? null : null;
}
/** The talkgroup or unit a call is to, as the cards name it. */
export const callWho = (c: Pick<CallRow, 'tg' | 'group'>) => c.tg ? `${c.group ? 'TG' : 'UNIT'} ${c.tg}` : 'UNKNOWN TALKGROUP';

// ------------------------------------------------------------------------------------------------ detail cards
/** What a unit's track says: reports placed, time span, distance covered, the latest speed and course, moving or not. */
export interface TrackStats { fixes: number; spanMs: number; mi: number; mph: number | null; course: number | null; dir: string; moving: boolean; lastMs: number }
/** Speed and course come from the last two fixes (at least 20 s apart); a unit doing under 3 mph is stopped. */
export function trackStats(trail: [number, number, number][]): TrackStats {
  const n = trail.length;
  const out: TrackStats = { fixes: n, spanMs: n > 1 ? trail[n - 1][2] - trail[0][2] : 0, mi: 0, mph: null, course: null, dir: '', moving: false, lastMs: n ? trail[n - 1][2] : 0 };
  for (let i = 1; i < n; i++) out.mi += distBearing({ lat: trail[i - 1][0], lon: trail[i - 1][1] }, { lat: trail[i][0], lon: trail[i][1] }).mi;
  for (let i = n - 1; i > 0; i--) {
    const a = trail[i - 1], b = trail[n - 1], dt = (b[2] - a[2]) / 3_600_000;
    if (dt * 3600 < 20) continue;
    const d = distBearing({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    out.mph = d.mi / dt; out.moving = out.mph >= 3;
    if (out.moving) { out.course = Math.round(d.deg); out.dir = d.dir; }
    break;
  }
  return out;
}
/** Counts of [times] in [n] equal buckets over the [spanMs] up to [now] (oldest first). */
export function activityBuckets(times: number[], now: number, spanMs: number, n: number): number[] {
  const b = new Array(n).fill(0), w = spanMs / n;
  for (const t of times) { const i = Math.floor((t - (now - spanMs)) / w); if (i >= 0 && i < n) b[i]++; }
  return b;
}
/** A bar sparkline as SVG (theme colors from CSS: currentColor). */
export function sparkSvg(b: number[], w = 240, h = 34): string {
  const max = Math.max(1, ...b), bw = w / b.length;
  return `<svg class="fl-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${b.map((v, i) => v ? `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(h - 2 - (h - 4) * v / max).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${((h - 4) * v / max + 2).toFixed(1)}" rx="1"/>` : `<rect class="z" x="${(i * bw + 0.5).toFixed(1)}" y="${h - 2}" width="${Math.max(1, bw - 1).toFixed(1)}" height="2"/>`).join('')}</svg>`;
}
/**
 * A small map of positions as SVG: an equirectangular fit with a margin, the track as a line (older faint, newest
 * bright), [others] as dim dots (the rest of the system), [me] as a ring, and a scale bar. No tiles, so it draws at once.
 */
export function trackSvg(trail: [number, number, number][], opts: { others?: [number, number][]; me?: { lat: number; lon: number } | null; w?: number; h?: number; /** [others] are the subject (a system's units), drawn bright. */ bright?: boolean } = {}): string {
  const w = opts.w ?? 320, h = opts.h ?? 180, pts = [...trail.map(t => [t[0], t[1]] as [number, number]), ...(opts.others ?? [])];
  if (opts.me) pts.push([opts.me.lat, opts.me.lon]);
  if (!pts.length) return '';
  let la0 = Math.min(...pts.map(p => p[0])), la1 = Math.max(...pts.map(p => p[0])), lo0 = Math.min(...pts.map(p => p[1])), lo1 = Math.max(...pts.map(p => p[1]));
  const k = Math.cos((la0 + la1) / 2 * Math.PI / 180);
  // at least 600 m across, so one fix is not a single pixel blown up
  const minDeg = 0.0055;
  if (la1 - la0 < minDeg) { const c = (la0 + la1) / 2; la0 = c - minDeg / 2; la1 = c + minDeg / 2; }
  if ((lo1 - lo0) * k < minDeg) { const c = (lo0 + lo1) / 2; lo0 = c - minDeg / k / 2; lo1 = c + minDeg / k / 2; }
  const pad = 14, sx = (w - 2 * pad) / ((lo1 - lo0) * k), sy = (h - 2 * pad) / (la1 - la0), s = Math.min(sx, sy);
  const cx = (lo0 + lo1) / 2, cy = (la0 + la1) / 2;
  const X = (lon: number) => (w / 2 + (lon - cx) * k * s).toFixed(1), Y = (lat: number) => (h / 2 - (lat - cy) * s).toFixed(1);
  // scale bar: a round distance near a quarter of the width
  const kmPerPx = 111.32 / s, want = kmPerPx * w / 4, steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200], km = steps.find(v => v >= want) ?? want, px = km / kmPerPx;
  const mi = km * 0.621371, lab = mi < 0.25 ? `${Math.round(mi * 5280)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  const n = trail.length;
  const line = n > 1 ? `<polyline class="tr" points="${trail.map(t => `${X(t[1])},${Y(t[0])}`).join(' ')}"/>` : '';
  const dots = trail.map((t, i) => `<circle class="${i === n - 1 ? 'now' : 'old'}" cx="${X(t[1])}" cy="${Y(t[0])}" r="${i === n - 1 ? 5 : 2.4}" style="opacity:${i === n - 1 ? 1 : (0.25 + 0.6 * i / Math.max(1, n - 1)).toFixed(2)}"/>`).join('');
  const others = (opts.others ?? []).map(p => `<circle class="${opts.bright ? 'unit' : 'oth'}" cx="${X(p[1])}" cy="${Y(p[0])}" r="${opts.bright ? 3.5 : 2}"/>`).join('');
  const me = opts.me ? `<circle class="me" cx="${X(opts.me.lon)}" cy="${Y(opts.me.lat)}" r="5"/>` : '';
  return `<svg class="fl-track" viewBox="0 0 ${w} ${h}" aria-hidden="true"><rect class="bg" width="${w}" height="${h}" rx="8"/>${others}${line}${dots}${me}`
    + `<g class="sb"><line x1="${pad}" y1="${h - 9}" x2="${(pad + px).toFixed(1)}" y2="${h - 9}"/><text x="${pad}" y="${h - 13}">${lab}</text></g><text class="n" x="${w - pad}" y="${pad + 4}" text-anchor="end">N ↑</text></svg>`;
}
/** Encrypted share of a set of calls: [encrypted, total]. */
export const encShare = (calls: Pick<CallRow, 'encrypted' | 'kind'>[]) => { const v = calls.filter(c => c.kind === 'call'); return [v.filter(c => c.encrypted).length, v.length] as [number, number]; };
/** How long ago, short: 'now', '42 s', '7 min', '3 h', '2 d'. */
export const agoShort = (ms: number) => ms < 5_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} h` : `${Math.floor(ms / 86_400_000)} d`;
