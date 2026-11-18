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
export const algName = (id: number) => id < 0 ? '' : P25_ALGS[id] ?? `ALGID 0x${hx(id, 2)}`;

/** The call's security in words: 'CLEAR', 'ENCRYPTED' with the algorithm and key when heard, or '' when unknown. */
export function secText(c: Pick<CallRow, 'encrypted' | 'sec' | 'algId' | 'keyId' | 'pi' | 'proto'>): string {
  if (c.encrypted) {
    const parts = ['ENCRYPTED'];
    // DMR algorithm IDs have no public table: shown by number
    if (c.proto === 'DMR') { if (c.pi && c.algId >= 0) parts.push(`ALGID 0x${hx(c.algId, 2)}`, `KEY ${c.keyId}`); else if (c.pi) parts.push('PRIVACY HEADER'); }
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
  MAC: 'Phase 2 push to talk', ESS: 'Phase 2 encryption sync', history: 'earlier calls of this talkgroup were encrypted, and no push to talk said otherwise',
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
/** What the now-playing bar names, or null when nothing is heard. */
export function nowPlaying(calls: CallRow[], playing: string): CallRow | null {
  return playing ? calls.find(c => c.key === playing && c.onAir) ?? null : null;
}
/** The talkgroup or unit a call is to, as the cards name it. */
export const callWho = (c: Pick<CallRow, 'tg' | 'group'>) => c.tg ? `${c.group ? 'TG' : 'UNIT'} ${c.tg}` : 'UNKNOWN TALKGROUP';
