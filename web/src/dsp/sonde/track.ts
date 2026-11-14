/**
 * Every sonde heard: its latest frame, its track, the flight phase (on the ground, climbing, burst, falling, landed)
 * and where it will come down. The landing prediction is a simple balloon model: the sonde keeps its climb rate to a
 * burst altitude (30 km unless it is already past that), then falls under a parachute whose speed grows with the
 * thinning air; on the way it drifts with the wind it measured itself on the way up, layer by layer.
 * The TypeScript twin of core/sonde/SondeTrack.kt and SondeTrack.swift.
 */
import type { SondeFrame } from './types.js';

export type SondePhase = 'ground' | 'ascent' | 'descent' | 'landed' | '';
export interface SondeField { name: string; value: string }
export interface SondePrediction { lat: number; lon: number; inS: number; burstAlt: number; path: [number, number][] }
export interface SondeRow {
  serial: string; type: string; model?: string; hz: number; level: number; firstMs: number; lastMs: number; frames: number;
  frame?: number; lat?: number; lon?: number; alt?: number; vH?: number; heading?: number; climb?: number;
  tempC?: number; rh?: number; hPa?: number; battV?: number; sats?: number; killS?: number; timeS?: number; date?: string;
  maxAlt?: number; phase: SondePhase; burst?: { lat: number; lon: number; alt: number; ms: number };
  track: [number, number, number][]; predict?: SondePrediction; fields: SondeField[]; fixed: number;
}

const SCALE_H = 7238;                  // m, density scale height
const DEFAULT_BURST = 30_000, DEFAULT_ASCENT = 5, DEFAULT_DESCENT = 5;
const LAYER = 500;

interface Point { ms: number; lat: number; lon: number; alt: number }

class Sonde {
  row: SondeRow;
  private pts: Point[] = [];
  private winds = new Map<number, { n: number; e: number; k: number }>();
  private climbAvg = 0; private climbInit = false;
  private ascended = false; private minAlt = Infinity;
  private landedSince = 0;
  constructor(f: SondeFrame, hz: number, now: number) {
    this.row = { serial: f.serial, type: f.type, hz, level: 0, firstMs: now, lastMs: now, frames: 0, phase: '', track: [], fields: [], fixed: 0 };
  }
  add(f: SondeFrame, hz: number, level: number, now: number, events: string[]): void {
    const r = this.row;
    r.type = f.type; if (f.model) r.model = f.model;
    r.hz = hz; r.level = level; r.lastMs = now; r.frames++;
    r.fixed += f.fixed ?? 0;
    for (const k of ['frame', 'tempC', 'rh', 'hPa', 'battV', 'sats', 'killS', 'timeS', 'date'] as const) if (f[k] !== undefined) (r as unknown as Record<string, unknown>)[k] = f[k];
    if (f.extra) {
      const m = new Map(r.fields.map(x => [x.name, x.value]));
      for (const [k, v] of Object.entries(f.extra)) m.set(k, v);
      if (f.txKHz) m.set('REPORTED FREQUENCY', `${(f.txKHz / 1000).toFixed(2)} MHz`);
      if (f.tHumC !== undefined) m.set('HUMIDITY SENSOR', `${f.tHumC.toFixed(1)} °C`);
      r.fields = [...m].map(([name, value]) => ({ name, value }));
    }
    if (f.lat === undefined || f.lon === undefined || f.alt === undefined || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return;
    if (Math.abs(f.lat) < 1e-6 && Math.abs(f.lon) < 1e-6) return;
    const prev = this.pts[this.pts.length - 1];
    r.lat = f.lat; r.lon = f.lon; r.alt = f.alt;
    r.vH = f.vH; r.heading = f.heading;
    let climb = f.climb;
    if (climb === undefined && prev && now > prev.ms) climb = (f.alt - prev.alt) / ((now - prev.ms) / 1000);
    if (climb !== undefined && Number.isFinite(climb)) {
      r.climb = climb;
      this.climbAvg = this.climbInit ? this.climbAvg + (climb - this.climbAvg) * 0.15 : climb; this.climbInit = true;
    }
    let vH = f.vH, hd = f.heading;
    if ((vH === undefined || hd === undefined) && prev && now - prev.ms > 500) {
      const dn = (f.lat - prev.lat) * 111_320, de = (f.lon - prev.lon) * 111_320 * Math.cos(f.lat * Math.PI / 180), dt = (now - prev.ms) / 1000;
      vH = Math.hypot(dn, de) / dt; hd = (Math.atan2(de, dn) * 180 / Math.PI + 360) % 360;
      r.vH = vH; r.heading = hd;
    }
    if (vH !== undefined && hd !== undefined) {
      const L = Math.floor(f.alt / LAYER), w = this.winds.get(L) ?? { n: 0, e: 0, k: 0 };
      w.n += vH * Math.cos(hd * Math.PI / 180); w.e += vH * Math.sin(hd * Math.PI / 180); w.k++;
      this.winds.set(L, w);
    }
    this.minAlt = Math.min(this.minAlt, f.alt);
    if (r.maxAlt === undefined || f.alt > r.maxAlt) r.maxAlt = f.alt;
    // phase
    const was = r.phase;
    if (this.climbAvg > 1.5) { r.phase = 'ascent'; this.ascended = true; this.landedSince = 0; }
    else if (this.climbAvg < -2 && (this.ascended || (r.maxAlt ?? 0) - f.alt > 150)) {
      r.phase = 'descent';
      if (!r.burst && r.maxAlt !== undefined && r.maxAlt - f.alt > 100) {
        const top = this.pts.reduce((a, p) => (p.alt > a.alt ? p : a), this.pts[0] ?? { ms: now, lat: f.lat, lon: f.lon, alt: f.alt });
        r.burst = { lat: top.lat, lon: top.lon, alt: top.alt, ms: top.ms };
        events.push(`${r.serial} burst at ${Math.round(top.alt)} m`);
      }
    } else if (Math.abs(this.climbAvg) < 0.7 && (vH ?? 0) < 3) {
      if (r.phase === 'descent' || r.phase === 'landed') {
        if (!this.landedSince) this.landedSince = now;
        if (now - this.landedSince > 20_000) r.phase = 'landed';
      } else if (!this.ascended) r.phase = 'ground';
    }
    if (r.phase === 'landed' && was !== 'landed') events.push(`${r.serial} landed at ${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`);
    if (r.phase === 'ascent' && was === 'ground') events.push(`${r.serial} launched`);
    // the track: a point every 2 s or 25 m of height, at most 1500 (thinned evenly beyond that)
    if (!prev || now - prev.ms >= 2000 || Math.abs(f.alt - prev.alt) > 25) {
      this.pts.push({ ms: now, lat: f.lat, lon: f.lon, alt: f.alt });
      if (this.pts.length > 1500) this.pts = this.pts.filter((_, i) => i % 2 === 0 || i === this.pts.length - 1);
    }
    r.track = this.pts.map(p => [p.lat, p.lon, Math.round(p.alt)]);
    r.predict = this.predict(f.lat, f.lon, f.alt);
  }

  /** The wind in a layer, from the nearest layer measured. */
  private wind(alt: number): [number, number] {
    if (!this.winds.size) return [0, 0];
    const L = Math.floor(alt / LAYER);
    let best: { n: number; e: number; k: number } | undefined, bd = Infinity;
    for (const [k, w] of this.winds) { const d = Math.abs(k - L); if (d < bd) { bd = d; best = w; } }
    return best ? [best.n / best.k, best.e / best.k] : [0, 0];
  }

  private predict(lat: number, lon: number, alt: number): SondePrediction | undefined {
    const r = this.row;
    if (r.phase === 'landed' || r.phase === 'ground' || r.phase === '') return undefined;
    const ground = this.minAlt < 4000 && this.ascended ? Math.max(0, Math.min(this.minAlt, 3000)) : 0;
    const path: [number, number][] = [[lat, lon]];
    let la = lat, lo = lon, h = alt, t = 0;
    const step = (dh: number, rate: number) => {
      const dt = Math.abs(dh) / Math.max(rate, 0.5), [wn, we] = this.wind(h);
      la += wn * dt / 111_320; lo += we * dt / (111_320 * Math.max(0.05, Math.cos(la * Math.PI / 180)));
      h += dh; t += dt;
    };
    let burstAlt = r.burst?.alt ?? Math.max(DEFAULT_BURST, alt + 1500);
    if (r.phase === 'ascent') {
      const asc = this.climbAvg > 1 ? this.climbAvg : DEFAULT_ASCENT;
      burstAlt = Math.max(burstAlt, alt);
      while (h < burstAlt) { step(Math.min(100, burstAlt - h), asc); if (path.length < 600) path.push([la, lo]); }
    }
    // the parachute falls at v0 at sea level, faster as the air thins: v = v0 * exp(h / 2H)
    let v0 = DEFAULT_DESCENT;
    if (r.phase === 'descent' && this.climbAvg < -1 && alt < 25_000) v0 = Math.max(2, Math.min(15, -this.climbAvg * Math.exp(-alt / (2 * SCALE_H))));
    let guard = 0;
    while (h > ground && guard++ < 2000) { step(-Math.min(100, h - ground), v0 * Math.exp(h / (2 * SCALE_H))); if (guard % 3 === 0) path.push([la, lo]); }
    path.push([la, lo]);
    return { lat: la, lon: lo, inS: Math.round(t), burstAlt: Math.round(burstAlt), path };
  }
}

export class SondeTracker {
  private readonly sondes = new Map<string, Sonde>();
  readonly events: string[] = [];
  add(f: SondeFrame, hz: number, level: number, now: number): SondeRow {
    // the card shows the type beside the serial: drop a family prefix ("DFM-23038743" → "23038743")
    if (f.serial.startsWith(f.type + '-') && f.serial.length > f.type.length + 1) f = { ...f, serial: f.serial.slice(f.type.length + 1) };
    const key = `${f.type}:${f.serial}`;
    let s = this.sondes.get(key);
    if (!s) { s = new Sonde(f, hz, now); this.sondes.set(key, s); }
    s.add(f, hz, level, now, this.events);
    return s.row;
  }
  rows(_now: number): SondeRow[] { return [...this.sondes.values()].map(s => s.row).sort((a, b) => b.lastMs - a.lastMs); }
  clear(): void { this.sondes.clear(); }
}
