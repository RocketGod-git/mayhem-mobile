/**
 * Ham Map's FT8 and JS8 layers: every decode that carries a Maidenhead grid becomes a station at the center of its
 * square. The decoders feed this one store wherever they run (the Ham Radio DIGI tab, the JS8 app), so the map shows
 * what was heard while it was closed. Stations age out and are capped the way the APRS receiver keeps its own.
 */
import { gridToLatLon } from './callsign.js';
import { bandOf } from './bands.js';

export type SpotMode = 'FT8' | 'JS8';
export type HamLayer = 'aprs' | 'ft8' | 'js8';
export type HamLayers = Record<HamLayer, boolean>;

export interface HamSpot {
  /** "ft8:K1ABC": one entry per mode and callsign, so each layer can be switched on its own. */
  id: string; mode: SpotMode; call: string;
  /** "EM23" or "FN42ab". */
  grid: string; lat: number; lon: number;
  snr: number; dial: number; offset: number;
  firstMs: number; lastMs: number; heard: number;
  /** The decode that last carried the grid. */
  text: string;
}
export interface SpotLine { ms: number; mode: SpotMode; call: string; text: string; line: string }

/** The APRS receiver forgets a station an hour after its last packet; the grid layers do the same. */
export const SPOT_MAX_AGE_MS = 60 * 60_000;
export const SPOT_CAP = 300;
export const SPOT_LOG_CAP = 300;

/**
 * A 4 or 6 character Maidenhead locator. RR73 has the shape of a square in the Arctic Ocean but is the FT8 sign-off,
 * so it never counts as a grid; RRR and 73 do not have the shape.
 */
export function isGrid(s: string): boolean {
  const g = s.trim().toUpperCase();
  return /^[A-R]{2}\d{2}([A-X]{2})?$/.test(g) && g !== 'RR73';
}
/** "fn42AB" to "FN42ab", the way logs write a locator. */
export function normGrid(s: string): string {
  const g = s.trim();
  return g.slice(0, 4).toUpperCase() + g.slice(4, 6).toLowerCase();
}
/** A callsign as decoders print it: letters and a digit, maybe with a /P or a DX prefix. Hashed "<...>" is unknown. */
export function cleanCall(s: string): string {
  const c = s.trim().toUpperCase().replace(/^<|>$/g, '');
  return /^(?=.*\d)(?=.*[A-Z])[A-Z0-9/]{3,12}$/.test(c) && !c.startsWith('/') && !c.endsWith('/') ? c : '';
}

/**
 * The sender and grid of an FT8 standard message: "CQ K1ABC FN42", "CQ DX K1ABC FN42", "CQ POTA K1ABC FN42",
 * "W9XYZ K1ABC FN42" and "W9XYZ K1ABC R FN42". Reports (-10, R-12), RRR, RR73, 73 and free text carry no grid.
 */
export function ft8Spot(text: string): { call: string; grid: string } | null {
  const t = text.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (t.length < 3) return null;
  let call: string, rest: string[];
  if (t[0] === 'CQ' || t[0] === 'QRZ') {
    // a directed CQ names a region, an activity or a 3-digit number before the call
    if (t.length >= 4 && /^([A-Z]{1,4}|\d{3})$/.test(t[1])) { call = t[2]; rest = t.slice(3); }
    else { call = t[1]; rest = t.slice(2); }
  } else { call = t[1]; rest = t.slice(2); }
  if (rest.length === 2 && rest[0] === 'R') rest = rest.slice(1);
  if (rest.length !== 1 || !isGrid(rest[0])) return null;
  const c = cleanCall(call);
  return c ? { call: c, grid: normGrid(rest[0]) } : null;
}

/** What a JS8 message says about its sender: kind, the sender and the parsed grid (from the message layer). */
export interface Js8Said { kind: string; from: string; body?: string; grid?: string }
/**
 * The sender's grid from a JS8 message: the one in a heartbeat or a CQ, or the word after GRID anywhere
 * ("@APRSIS GRID EM73TU", "KN4CRD GRID FN42"). A grid-shaped word inside directed text is not taken.
 */
export function js8Spot(m: Js8Said): { call: string; grid: string } | null {
  const call = cleanCall(m.from ?? '');
  if (!call) return null;
  let g = '';
  if ((m.kind === 'heartbeat' || m.kind === 'cq') && m.grid) g = m.grid;
  if (!g) { const x = /(?:^|\s)GRID\s+([A-R]{2}\d{2}(?:[A-X]{2})?)/i.exec(m.body ?? ''); if (x) g = x[1]; }
  g = g.slice(0, 6);
  return g && isGrid(g) ? { call, grid: normGrid(g) } : null;
}

/** The square's corners: [south, west, north, east]. 2° by 1° for a 4-character grid, 5' by 2.5' for 6. */
export function gridBox(grid: string): [number, number, number, number] | null {
  const c = isGrid(grid) ? gridToLatLon(grid) : null; if (!c) return null;
  const w = grid.length >= 6 ? 2 / 24 : 2, h = grid.length >= 6 ? 1 / 24 : 1;
  return [c.lat - h / 2, c.lon - w / 2, c.lat + h / 2, c.lon + w / 2];
}
/** The outline as a closed ring of [lat, lon]. */
export function gridRing(grid: string): [number, number][] {
  const b = gridBox(grid); if (!b) return [];
  const [s, w, n, e] = b;
  return [[s, w], [n, w], [n, e], [s, e], [s, w]];
}
/** "20 m" for a dial in the band, else the frequency in MHz. */
export function bandLabel(hz: number): string {
  const b = bandOf(hz);
  return b && b.id.endsWith('m') ? b.name : hz > 0 ? `${(hz / 1e6).toFixed(3)} MHz` : '';
}
export const freqText = (s: HamSpot): string => s.dial > 0 ? `${((s.dial + s.offset) / 1e6).toFixed(4)} MHz` : `${Math.round(s.offset)} Hz`;

export class HamSpots {
  private readonly spots = new Map<string, HamSpot>();
  /** Newest first. */
  readonly log: SpotLine[] = [];
  private readonly subs = new Set<() => void>();
  constructor(readonly maxAgeMs = SPOT_MAX_AGE_MS, readonly cap = SPOT_CAP) { }

  add(mode: SpotMode, call: string, grid: string, at: { snr: number; dial: number; offset: number; ms: number; text: string }): HamSpot | null {
    const c = cleanCall(call); if (!c || !isGrid(grid)) return null;
    const g = normGrid(grid), p = gridToLatLon(g); if (!p) return null;
    const id = `${mode.toLowerCase()}:${c}`, old = this.spots.get(id);
    const s: HamSpot = { id, mode, call: c, grid: g, lat: p.lat, lon: p.lon, snr: at.snr, dial: at.dial, offset: at.offset,
      firstMs: old ? Math.min(old.firstMs, at.ms) : at.ms, lastMs: old ? Math.max(old.lastMs, at.ms) : at.ms, heard: (old?.heard ?? 0) + 1, text: at.text };
    // a newer grid wins; an older decode arriving late only counts
    if (old && at.ms < old.lastMs) { s.grid = old.grid; s.lat = old.lat; s.lon = old.lon; s.snr = old.snr; s.dial = old.dial; s.offset = old.offset; s.text = old.text; }
    this.spots.delete(id); this.spots.set(id, s);
    const band = bandLabel(at.dial);
    this.log.unshift({ ms: at.ms, mode, call: c, text: at.text, line: `${mode} ${c} ${g} · ${[band, `${at.snr > 0 ? '+' : ''}${at.snr} dB`].filter(Boolean).join(' · ')} · ${at.text}` });
    if (this.log.length > SPOT_LOG_CAP) this.log.length = SPOT_LOG_CAP;
    this.trim(at.ms);
    this.changed();
    return s;
  }
  /** One FT8 slot's decode at [dial] (the USB dial, Hz); [hz] is its audio offset. */
  ft8(d: { snr: number; hz: number; text: string }, dial: number, ms: number): HamSpot | null {
    const x = ft8Spot(d.text); return x ? this.add('FT8', x.call, x.grid, { snr: d.snr, dial, offset: d.hz, ms, text: d.text }) : null;
  }
  /** A JS8 message as the message layer assembled it. */
  js8(m: Js8Said, at: { snr: number; hz: number; ms: number; text: string }, dial: number): HamSpot | null {
    const x = js8Spot(m); return x ? this.add('JS8', x.call, x.grid, { snr: at.snr, dial, offset: at.hz, ms: at.ms, text: at.text }) : null;
  }
  /** Newest first, without the aged ones. */
  list(now = Date.now()): HamSpot[] { this.trim(now); return [...this.spots.values()].sort((a, b) => b.lastMs - a.lastMs); }
  logLines(now = Date.now()): SpotLine[] { return this.log.filter(l => now - l.ms <= this.maxAgeMs); }
  get(id: string): HamSpot | undefined { return this.spots.get(id); }
  get size(): number { return this.spots.size; }
  clear(): void { this.spots.clear(); this.log.length = 0; this.changed(); }
  subscribe(f: () => void): () => void { this.subs.add(f); return () => { this.subs.delete(f); }; }
  private trim(now: number): void {
    for (const [k, s] of this.spots) if (now - s.lastMs > this.maxAgeMs) this.spots.delete(k);
    if (this.spots.size > this.cap) [...this.spots.values()].sort((a, b) => a.lastMs - b.lastMs).slice(0, this.spots.size - this.cap).forEach(s => this.spots.delete(s.id));
  }
  private changed(): void { for (const f of this.subs) try { f(); } catch { /* a closed view */ } }
}
/** The one store every decoder writes and Ham Map reads. */
export const hamSpots = new HamSpots();

// ---- layer chips, remembered ------------------------------------------------------------------------------------------
export const LAYERS_KEY = 'mayhem.hammap.layers';
export const DEFAULT_LAYERS: HamLayers = { aprs: true, ft8: true, js8: true };
interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }
const store = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
export function loadLayers(s: Store | null = store()): HamLayers {
  try { const j = JSON.parse(s?.getItem(LAYERS_KEY) ?? 'null'); if (j && typeof j === 'object') return { aprs: j.aprs !== false, ft8: j.ft8 !== false, js8: j.js8 !== false }; } catch { /* old or private */ }
  return { ...DEFAULT_LAYERS };
}
export function saveLayers(l: HamLayers, s: Store | null = store()): void { try { s?.setItem(LAYERS_KEY, JSON.stringify(l)); } catch { /* private window */ } }
export const spotLayer = (m: SpotMode): HamLayer => m === 'FT8' ? 'ft8' : 'js8';
export function visibleSpots(spots: HamSpot[], l: HamLayers): HamSpot[] { return spots.filter(s => l[spotLayer(s.mode)]); }
