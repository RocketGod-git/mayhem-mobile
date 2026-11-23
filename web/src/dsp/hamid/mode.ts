/**
 * What an FM channel carries, from its discriminator: analog voice, or one of the digital voice modes heard on ham
 * repeaters, named by their sync words in the symbol streams (4800/s and 2400/s):
 *
 *   · DMR: the base-station and mobile voice and data syncs (24 symbols, ETSI TS 102 361-1);
 *   · P25 Phase 1: the 24-symbol frame sync, either polarity;
 *   · Fusion: D471C9634D (20 symbols);
 *   · D-STAR: the radio header's frame sync after its 1010 preamble, or the 24-bit data sync every 420 ms;
 *   · NXDN: its frame sync at 2400 symbols/s (NXDN48).
 *
 * The sync tables are the HAM decoder's (ham/dmr.ts). A mode is named once its syncs repeat on its frame grid; a
 * channel that has named none for 0.6 s is analog. No DOM.
 */
import { SYNCS } from '../ham/dmr.js';
import { DiscSymbols } from './symbols.js';
import { YSF_SYNC } from './ysf.js';
import { DSTAR_FS, DSTAR_DSYNC } from './dstar.js';

export type HamMode = '' | 'analog' | 'DMR' | 'D-STAR' | 'YSF' | 'P25' | 'NXDN' | 'P25P2' | 'dPMR';
export const MODES: HamMode[] = ['DMR', 'D-STAR', 'YSF', 'P25', 'NXDN'];

const signs = (s: string) => Int8Array.from([...s].map(c => c === '1' ? 1 : -1));
const DMR = SYNCS.filter(s => s.proto === 'DMR').map(s => s.s);
const P25 = SYNCS.filter(s => s.proto === 'P25').map(s => s.s);
const NXDN = SYNCS.filter(s => s.proto === 'NXDN').map(s => s.s);
const DS_FS = signs('1010101010101010' + DSTAR_FS), DS_SYNC = signs(DSTAR_DSYNC);
const YSF_E = YSF_SYNC.reduce((a, x) => a + x * x, 0);
/** Sync words a mode needs before it is named, and how long (s) a count lasts. */
const NEED: Record<string, number> = { DMR: 3, 'D-STAR': 2, YSF: 2, P25: 2, NXDN: 3 };
/**
 * Each mode's frame grid in 4800/s symbols: DMR bursts every 144 (30 ms), Fusion frames every 480, P25 voice frames
 * every 864, NXDN frames every 384 (80 ms), D-STAR's data sync every 2016 bits. Syncs found by chance in noise fall
 * anywhere; a mode is named only when two of its syncs sit on its grid.
 */
const PERIOD: Record<string, number> = { DMR: 144, 'D-STAR': 2016, YSF: 480, P25: 864, NXDN: 384 };
const HOLD_S = 2;

/** Normalized correlation of the last [n] values of a ring against a sign pattern. */
function corrSigns(ring: Float64Array, p: number, pat: Int8Array): { c: number; mag: number } {
  const R = ring.length, n = pat.length;
  let c = 0, a = 0;
  for (let k = 0; k < n; k++) { const x = ring[(p - n + k + R) % R]; c += x * pat[k]; a += x < 0 ? -x : x; }
  return { c: a > 0 ? c / a : 0, mag: a / n };
}

export interface ModeResult { mode: HamMode; hits: Record<string, number>; seconds: number }

export class ModeDetector {
  /** Every 4800/s symbol, for decoders that share this detector's symbol stream. */
  onSymbol48: (s: number) => void = () => undefined;
  private readonly s48: DiscSymbols; private readonly s24: DiscSymbols;
  private readonly r48 = new Float64Array(40); private p48 = 0;
  private readonly r24 = new Float64Array(24); private p24 = 0;
  private readonly hits = new Map<string, number[]>();
  private t48 = 0; private lastHit48 = new Map<string, number>(); private t24 = 0; private lastHit24 = -1e9;
  private samples = 0;
  private sticky: HamMode = '';

  constructor(readonly fs: number) {
    this.s48 = new DiscSymbols(fs, 4800); this.s24 = new DiscSymbols(fs, 2400, false);
    this.s48.onSymbol = s => this.sym48(s); this.s24.onSymbol = s => this.sym24(s);
  }
  reset(): void { this.s48.reset(); this.s24.reset(); this.r48.fill(0); this.r24.fill(0); this.p48 = this.p24 = 0; this.hits.clear(); this.lastHit48.clear(); this.t48 = this.t24 = 0; this.lastHit24 = -1e9; this.samples = 0; this.sticky = ''; }

  push(disc: ArrayLike<number>, n: number): void { this.samples += n; this.s48.push(disc, n); this.s24.push(disc, n); }

  /** Counts a sync word of [mode] at symbol time [t] (4800/s), once per word. */
  hit(mode: string, t: number): void {
    const last = this.lastHit48.get(mode) ?? -1e9;
    if (t - last < 8) return;
    this.lastHit48.set(mode, t);
    let a = this.hits.get(mode); if (!a) { a = []; this.hits.set(mode, a); }
    a.push(t);
  }

  private sym48(s: number): void {
    this.onSymbol48(s);
    const t = ++this.t48;
    this.r48[this.p48] = s; this.p48 = (this.p48 + 1) % 40;
    const r = this.r48, p = this.p48;
    for (const pat of DMR) { const m = corrSigns(r, p, pat); if (m.c > 0.85 && m.mag > 1.8) { this.hit('DMR', t); break; } }
    for (const pat of P25) { const m = corrSigns(r, p, pat); if (m.c > 0.86 && m.mag > 1.8) { this.hit('P25', t); break; } }
    let c = 0, e = 0;
    for (let k = 0; k < 20; k++) { const x = r[(p - 20 + k + 40) % 40]; c += x * YSF_SYNC[k]; e += x * x; }
    if (e > 0 && Math.abs(c / Math.sqrt(e * YSF_E)) > 0.9) this.hit('YSF', t);
    for (const pat of [DS_FS, DS_SYNC]) {
      let err = 0, errInv = 0; const n = pat.length;
      for (let k = 0; k < n; k++) { const b = r[(p - n + k + 40) % 40] > 0 ? 1 : -1; if (b !== pat[k]) err++; else errInv++; }
      if (err <= 1 || errInv <= 1) { this.hit('D-STAR', t); break; }
    }
  }
  private sym24(s: number): void {
    const t = ++this.t24;
    this.r24[this.p24] = s; this.p24 = (this.p24 + 1) % 24;
    if (t - this.lastHit24 < 8) return;
    for (const pat of NXDN) {
      const m = corrSigns(this.r24, this.p24, pat);
      if (m.c > 0.92 && m.mag > 1.8) { this.lastHit24 = t; this.hit('NXDN', 2 * t + 8); return; }
    }
  }

  result(): ModeResult {
    const now = this.t48, out: Record<string, number> = {};
    let best: HamMode = '', bestN = 0;
    for (const m of MODES) {
      const a = (this.hits.get(m) ?? []).filter(t => now - t <= HOLD_S * 4800);
      this.hits.set(m, a);
      out[m] = a.length;
      const P = PERIOD[m];
      let onGrid = false;
      for (let i = 1; i < a.length && !onGrid; i++) for (let j = 0; j < i; j++) { const r = (a[i] - a[j]) % P; if (r <= 3 || r >= P - 3) { onGrid = true; break; } }
      if (onGrid && a.length >= NEED[m] && a.length / NEED[m] > bestN) { bestN = a.length / NEED[m]; best = m; }
    }
    const seconds = this.samples / this.fs;
    if (best) this.sticky = best;
    else if (seconds >= 0.6) this.sticky = 'analog';
    return { mode: this.sticky, hits: out, seconds };
  }
}
