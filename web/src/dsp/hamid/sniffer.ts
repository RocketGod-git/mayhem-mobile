/**
 * The cheap first look Repeaters takes at every open channel, so a plain analog channel costs about what it did before
 * the identity layer: symbols at 4800/s from the discriminator summed over one symbol (LightSymbols), and the 2400/s ones as each pair of them (both pairings watched),
 * each sync word held as its signs (and, for the syncs sent on the outer levels only, those too) in a 32-bit register,
 * matched by XOR and a bit count. A mode wakes the channel's full decoders once its sync came twice a whole number of
 * frames apart (framing.ts), three times for the syncs matched on their signs alone (Fusion, D-STAR's data sync,
 * NXDN), or once for the long syncs no other signal carries by chance (the D-STAR header's frame
 * sync after its preamble, the dPMR header's FS1). P25 Phase 2 has no sync here: its decoders start only when another
 * mode wakes the channel. No DOM.
 */
import { SYNCS } from '../ham/dmr.js';
import { YSF_SYNC } from './ysf.js';
import { DSTAR_FS, DSTAR_DSYNC } from './dstar.js';
import { syncSymbols, M17_SYNC_LSF, M17_SYNC_STREAM, M17_SYNC_PACKET } from './m17.js';
import { DPMR_FS1, DPMR_FS2 } from './dpmr.js';
import { onGrid } from './framing.js';

interface Pat { mode: string; sign: number; mask: number; outer: boolean; n: number; tol: number; both: boolean; single: boolean; need: number }

/** Grid of each mode's syncs in 4800/s symbols (the 2400/s streams count two each). */
const PERIOD: Record<string, number> = { DMR: 144, 'D-STAR': 2016, YSF: 480, P25: 72, NXDN: 192, M17: 192, dPMR: 384 };

/**
 * Symbols for sync matching only, as cheap as they come: the discriminator summed over one symbol, sampled at the
 * nearest sample to the symbol time, the timing picked once a block of 240 symbols (of four), the center and level
 * followed from the block's mean and mean deviation (outer levels near ±3 for 4FSK). No sorting, no interpolation.
 */
export class LightSymbols {
  onSymbol: (s: number) => void = () => undefined;
  private readonly sps: number; private readonly L: number; private readonly ring: Float64Array; private rp = 0; private acc = 0;
  private buf: Float64Array; private n = 0; private base = 0; private tNext = 0; private center = 0; private level = 0;
  constructor(readonly fs: number, readonly baud: number) {
    this.sps = fs / baud; this.L = Math.max(1, Math.round(this.sps)); this.ring = new Float64Array(this.L);
    this.buf = new Float64Array(Math.ceil(this.sps * 244) + 8);
  }
  reset(): void { this.ring.fill(0); this.rp = 0; this.acc = 0; this.n = 0; this.base = 0; this.tNext = 0; this.center = 0; this.level = 0; }
  push(x: ArrayLike<number>, count: number): void {
    const L = this.L, need = Math.ceil(this.sps * 242) + 2;
    for (let k = 0; k < count; k++) {
      const v = x[k]; this.acc += v - this.ring[this.rp]; this.ring[this.rp] = v; if (++this.rp >= L) this.rp = 0;
      this.buf[this.n++] = this.acc;
      if (this.n >= need) this.block();
    }
  }
  private block(): void {
    const T = this.sps, nsym = 240, b = this.buf;
    let best = 0, bestE = -1;
    for (let p = 0; p < 4; p++) {
      const off = p * T / 4; let e = 0;
      for (let k = 0; k < nsym; k++) { const y = b[Math.round(off + k * T)] - this.center; e += y * y; }
      if (e > bestE) { bestE = e; best = off; }
    }
    const t0 = this.tNext - this.base; let k0 = Math.ceil((t0 - T / 2 - best) / T); if (k0 < 0) k0 = 0;
    let t = best + k0 * T, sum = 0, cnt = 0;
    const len = nsym * T;
    for (let u = t; u < len; u += T) { sum += b[Math.round(u)]; cnt++; }
    const c = cnt ? sum / cnt : 0; let dev = 0;
    for (let u = t; u < len; u += T) dev += Math.abs(b[Math.round(u)] - c);
    dev = cnt ? dev / cnt : 0;
    if (dev > 1e-9) { this.center = this.level > 0 ? this.center + 0.5 * (c - this.center) : c; this.level = this.level > 0 ? this.level + 0.5 * (dev - this.level) : dev; }
    // a 4FSK symbol's mean distance from the center is two (levels ±1 and ±3)
    const sc = this.level > 0 ? 2 / this.level : 1;
    for (; t < len; t += T) this.onSymbol((b[Math.round(t)] - this.center) * sc);
    this.tNext = this.base + t;
    const used = Math.floor(len);
    b.copyWithin(0, used, this.n); this.n -= used; this.base += used;
  }
}

function popcount(x: number): number { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
function pat(mode: string, v: ArrayLike<number>, opt: { outer?: boolean; tol?: number; both?: boolean; single?: boolean; need?: number } = {}): Pat {
  let sign = 0; for (let i = 0; i < v.length; i++) sign = ((sign << 1) | (v[i] > 0 ? 1 : 0)) >>> 0;
  const n = v.length, mask = n >= 32 ? 0xffffffff : ((1 << n) - 1) >>> 0;
  // hits on the grid that wake: two for the outer-level syncs, three for those matched on signs alone (and M17's short one)
  return { mode, sign, mask, outer: !!opt.outer, n, tol: opt.tol ?? 1, both: !!opt.both, single: !!opt.single, need: opt.need ?? (opt.outer ? 2 : 3) };
}
const signs = (s: string) => Array.from(s, c => c === '1' ? 1 : -1);

/** A pattern list arranged for speed: outer-level groups by length, exact sign patterns in maps, the rest tried one by one. */
interface Matcher { outer: { mask: number; need: number; pats: Pat[] }[]; exact: { mask: number; map: Map<number, Pat> }[]; loose: Pat[] }
function matcher(list: Pat[]): Matcher {
  const m: Matcher = { outer: [], exact: [], loose: [] };
  for (const p of list) {
    if (p.outer) {
      let g = m.outer.find(x => x.mask === p.mask);
      if (!g) { g = { mask: p.mask, need: p.n - (p.n >= 16 ? 2 : 0), pats: [] }; m.outer.push(g); }
      g.pats.push(p);
    } else if (p.tol === 0) {
      let g = m.exact.find(x => x.mask === p.mask);
      if (!g) { g = { mask: p.mask, map: new Map() }; m.exact.push(g); }
      g.map.set(p.sign, p); if (p.both) g.map.set((~p.sign & p.mask) >>> 0, p);
    } else m.loose.push(p);
  }
  return m;
}

const P48 = matcher([
  ...SYNCS.filter(s => s.proto === 'DMR').map(s => pat('DMR', s.s, { outer: true })),
  pat('P25', SYNCS.find(s => s.proto === 'P25')!.s, { outer: true, both: true }),
  pat('YSF', YSF_SYNC, { both: true }),
  pat('D-STAR', signs('1010101010101010' + DSTAR_FS), { both: true, single: true }),
  pat('D-STAR', signs(DSTAR_DSYNC), { both: true }),
  ...[M17_SYNC_LSF, M17_SYNC_STREAM, M17_SYNC_PACKET].map(w => pat('M17', syncSymbols(w), { outer: true, tol: 0, both: true, need: 3 })),
  ...SYNCS.filter(s => s.proto === 'NXDN' && !s.src).map(s => pat('NXDN', s.s, { both: true, tol: 0 })),
]);
const P24 = matcher([
  ...SYNCS.filter(s => s.proto === 'NXDN' && !s.src).map(s => pat('NXDN', s.s, { both: true, tol: 0 })),
  pat('dPMR', DPMR_FS1, { outer: true, both: true, single: true }),
  pat('dPMR', DPMR_FS2, { outer: true, both: true }),
]);

export class SyncSniffer {
  private readonly s48: LightSymbols;
  private sg48 = 0; private ou48 = 0; private t48 = 0; private prev = 0;
  /** The two 2400/s pairings: signs, outer flags. */
  private readonly sg24 = [0, 0]; private readonly ou24 = [0, 0];
  private readonly last = new Map<string, number>(); private readonly run = new Map<string, number>();
  /** The mode that woke the channel, '' until one has. */
  woke = '';
  constructor(readonly fs: number) {
    this.s48 = new LightSymbols(fs, 4800);
    this.s48.onSymbol = s => {
      const t = ++this.t48;
      this.sg48 = ((this.sg48 << 1) | (s > 0 ? 1 : 0)) >>> 0; this.ou48 = ((this.ou48 << 1) | (s > 2 || s < -2 ? 1 : 0)) >>> 0;
      this.look(P48, this.sg48, this.ou48, t);
      // a 2400/s symbol is two of these summed (half the level each): the pairing ending on odd and on even ones
      const k = t & 1, v = (s + this.prev) / 2; this.prev = s;
      this.sg24[k] = ((this.sg24[k] << 1) | (v > 0 ? 1 : 0)) >>> 0; this.ou24[k] = ((this.ou24[k] << 1) | (v > 2 || v < -2 ? 1 : 0)) >>> 0;
      this.look(P24, this.sg24[k], this.ou24[k], t);
    };
  }
  reset(): void { this.s48.reset(); this.sg48 = this.ou48 = this.t48 = this.prev = 0; this.sg24[0] = this.sg24[1] = this.ou24[0] = this.ou24[1] = 0; this.last.clear(); this.run.clear(); this.woke = ''; }
  push(disc: ArrayLike<number>, n: number): void { this.s48.push(disc, n); }
  private look(m: Matcher, sg: number, ou: number, t: number): void {
    // syncs sent on the outer levels: a group is tried only when nearly all its symbols were outer (most symbols stop here)
    const O = m.outer, E = m.exact, L = m.loose;
    for (let i = 0; i < O.length; i++) {
      const g = O[i];
      if (popcount((ou & g.mask) >>> 0) < g.need) continue;
      for (let j = 0; j < g.pats.length; j++) this.tryPat(g.pats[j], sg, t);
    }
    // exact sign matches: one lookup per mask
    for (let i = 0; i < E.length; i++) { const p = E[i].map.get((sg & E[i].mask) >>> 0); if (p) this.hit(p, t); }
    for (let i = 0; i < L.length; i++) this.tryPat(L[i], sg, t);
  }
  /** No bits wrong, or one when the pattern allows it ((x & (x - 1)) === 0), either polarity when it may be inverted. */
  private tryPat(p: Pat, sg: number, t: number): void {
    const x = ((sg ^ p.sign) & p.mask) >>> 0;
    if (x === 0 || (p.tol > 0 && (x & (x - 1)) === 0)) { this.hit(p, t); return; }
    if (!p.both) return;
    const y = ((~sg ^ p.sign) & p.mask) >>> 0;
    if (y === 0 || (p.tol > 0 && (y & (y - 1)) === 0)) this.hit(p, t);
  }
  private hit(p: Pat, t: number): void {
    const key = p.mode, prev = this.last.get(key);
    if (prev !== undefined && t - prev < 8) return;
    this.last.set(key, t);
    const r = prev !== undefined && onGrid(t - prev, PERIOD[key]) ? (this.run.get(key) ?? 1) + 1 : 1;
    this.run.set(key, r);
    if (!this.woke && (p.single || r >= p.need)) this.woke = key;
  }
}
