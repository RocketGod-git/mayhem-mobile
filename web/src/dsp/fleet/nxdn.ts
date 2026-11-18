/**
 * NXDN trunked control channel (NXDN TS 1-A, Common Air Interface v1.3), outbound, receive only. No DOM.
 *
 *  - 4-level FSK, dibit 01 = +3, 00 = +1, 10 = -1, 11 = -3 (4.5.3, Figure 4.5-7); NXDN48 at 2400 and NXDN96 at 4800
 *    symbols a second, the frame 384 bits either way (4.4).
 *  - The outbound RCCH frame (4.4.1, Figure 4.4-1): FSW 20 bits, LICH 16, CAC 300, E 24, Post 24. The frame sync word
 *    is CDF59: -3 +1 -3 +3 -3 -3 +3 +3 -1 +3 (4.4.4, Table 4.4-2).
 *  - Scrambling (4.6): every symbol but the FSW, guard, preamble and post field has its sign inverted where the
 *    9-bit generator X^9 + X^4 + 1 puts out a 1; register S8..S0 = 0 1 1 1 0 0 1 0 0 at the start of each frame,
 *    output S0, S0 fed back to S8 and added into S3 (Figure 4.6-1).
 *  - LICH (4.5.3, 5.2): 7 bits and an even parity bit over the 4 most significant, one bit a symbol (0 = +3, 1 = -3);
 *    RF channel type 00 RCCH, functional channel 00 CAC, direction 1 outbound.
 *  - CAC (4.5.1.1, 4.5.4): SR 8 bits, layer 3 144 bits, 3 null bits, a 16-bit CRC (X^16 + X^12 + X^5 + 1, register
 *    preset to ones, 4.5.5), 4 tail bits; the K = 5 rate 1/2 code G1 = 1 + D^3 + D^4, G2 = 1 + D + D^2 + D^4, punctured by
 *    1111111 / 1011101 to 300 bits; a 25 by 12 interleaver written by rows and read by columns.
 *  - SITE_INFO (6.4.3.1, Figure 6.4-53, message type 01 1000): the Location ID (6.5.2: category, system code, site
 *    code) in octets 1 to 3, the version number in octet 14, then the adjacent site allocation (4 bits) and the first
 *    and second control channels (10 bits each).
 */
import { SymbolRx } from './rx.js';

const FSW = [-3, 1, -3, 3, -3, -3, 3, 3, -1, 3];
/** The scrambler's output for the symbols after the FSW of a frame (4.6). */
export function nxdnScrambler(n: number): Uint8Array {
  let s = [0, 1, 1, 1, 0, 0, 1, 0, 0].reverse();   // s[i] = Si
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const o = s[0]; out[k] = o;
    const next = new Array(9); for (let i = 0; i < 8; i++) next[i] = s[i + 1]; next[8] = o; next[3] = s[4] ^ o;
    s = next;
  }
  return out;
}
/** The 16-bit CRC of 4.5.5 over the first [n] bits (register preset to ones). */
export function nxdnCrc16(bits: ArrayLike<number>, n: number): number {
  let r = 0xffff;
  for (let i = 0; i < n; i++) { const fb = ((r >> 15) & 1) ^ bits[i]; r = (r << 1) & 0xffff; if (fb) r ^= 0x1021; }
  return r;
}
const G1 = 0b11001, G2 = 0b10111;   // bit j = D^j
/** CAC: 300 received bits (after descrambling) to the 152 bits of SR and layer 3, or null when the CRC fails. */
export function nxdnCac(rx: ArrayLike<number>): Uint8Array | null {
  // de-interleave: transmitted in column order of a 25 x 12 array written by rows
  const y = new Uint8Array(300);
  for (let c = 0; c < 12; c++) for (let r = 0; r < 25; r++) y[r * 12 + c] = rx[c * 25 + r];
  // de-puncture: of every 14 code bits X, X4 and X12 were not sent (positions 3 and 11 counting from 0)
  const m = new Float32Array(350); let j = 0;
  for (let i = 0; i < 350; i++) { const p = i % 14; if (p === 3 || p === 11) { m[i] = 0; continue; } m[i] = y[j++] ? -1 : 1; }
  // Viterbi, 16 states, 175 bits ending in the zero state
  const S = 16, INF = 1e9; let pm = new Float64Array(S).fill(INF); pm[0] = 0;
  const prev = new Uint8Array(175 * S), bit = new Uint8Array(175 * S);
  const enc = (st: number, b: number, g: number) => { const reg = (st << 1) | b; let v = 0; for (let k = 0; k < 5; k++) if (g & (1 << k)) v ^= (reg >> k) & 1; return v; };
  for (let k = 0; k < 175; k++) {
    const np = new Float64Array(S).fill(INF);
    for (let st = 0; st < S; st++) {
      if (pm[st] >= INF) continue;
      for (let b = 0; b < 2; b++) {
        const c = pm[st] - (enc(st, b, G1) ? -1 : 1) * m[2 * k] - (enc(st, b, G2) ? -1 : 1) * m[2 * k + 1], ns = ((st << 1) | b) & 15;
        if (c < np[ns]) { np[ns] = c; prev[k * S + ns] = st; bit[k * S + ns] = b; }
      }
    }
    pm = np;
  }
  const d = new Uint8Array(175); let st = 0;
  for (let k = 174; k >= 0; k--) { d[k] = bit[k * S + st]; st = prev[k * S + st]; }
  let crc = 0; for (let i = 155; i < 171; i++) crc = (crc << 1) | d[i];
  return nxdnCrc16(d, 155) === crc ? d.slice(0, 152) : null;
}
export interface NxdnSite { category: number; system: number; site: number; cc1: number; cc2: number; version: number; adjacent: number; locationId: number }
/** SITE_INFO (6.4.3.1) from the layer 3 bits (after SR): Location ID (6.5.2) and the control channels. */
export function nxdnSiteInfo(l3: ArrayLike<number>): NxdnSite | null {
  let i = 0; const f = (n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 2 + l3[i++]; return v; };
  f(2); if (f(6) !== 0x18) return null;
  const loc = f(24), category = loc >> 22;
  const sysBits = category === 0 ? 10 : category === 2 ? 14 : category === 1 ? 17 : 0;
  if (!sysBits) return null;
  const siteBits = 22 - sysBits, system = (loc >> siteBits) & ((1 << sysBits) - 1), site = loc & ((1 << siteBits) - 1);
  i = 8 * 14; const version = f(8), adjacent = f(4), cc1 = f(10), cc2 = f(10);
  return { category, system, site, cc1, cc2, version, adjacent, locationId: loc };
}
export const NXDN_CATEGORY = ['GLOBAL', 'LOCAL', 'REGIONAL', 'RESERVED'];

/** One baud rate's receiver: symbols in (from [SymbolRx]), frames found by their FSW, CAC read. */
export class NxdnFramer {
  onSite: (s: NxdnSite) => void = () => undefined;
  onFrame: (lich: number, ok: boolean) => void = () => undefined;
  readonly stats = { fsw: 0, lichOk: 0, cacOk: 0, cacBad: 0 };
  /** The last frame's worth of symbols, and the frames waiting for their body (every FSW match gets its own look). */
  private readonly hist = new Float32Array(256); private hp = 0;
  private pending: number[] = [];
  push(s: number): void {
    this.hist[this.hp & 255] = s; this.hp++;
    if (this.hp >= 10) {
      let c = 0, a = 0; for (let k = 0; k < 10; k++) { const x = this.hist[(this.hp - 10 + k) & 255]; c += x * FSW[k]; a += Math.abs(x); }
      if (a > 15 && c / (3 * a) > 0.85) { this.stats.fsw++; this.pending.push(this.hp + 158); }
    }
    while (this.pending.length && this.pending[0] <= this.hp) {
      const end = this.pending.shift()!, sym: number[] = [];
      for (let i = end - 158; i < end; i++) sym.push(this.hist[i & 255]);
      this.frame(sym);
    }
  }
  private frame(sym: number[]): void {
    const scr = nxdnScrambler(sym.length);
    const v = sym.map((x, k) => scr[k] ? -x : x);
    // LICH: one bit a symbol
    let lich = 0; for (let k = 0; k < 8; k++) lich = (lich << 1) | (v[k] < 0 ? 1 : 0);
    const par = ((lich >> 7) ^ (lich >> 6) ^ (lich >> 5) ^ (lich >> 4)) & 1;
    if (par !== (lich & 1)) { this.onFrame(lich >> 1, false); return; }
    this.stats.lichOk++;
    const info = lich >> 1, rf = info >> 5, fn = (info >> 3) & 3, dir = info & 1;
    this.onFrame(info, true);
    if (rf !== 0 || fn !== 0 || dir !== 1) return;
    const bits = new Uint8Array(300);
    for (let k = 0; k < 150; k++) { const x = v[8 + k], d = x > 2 ? 1 : x > 0 ? 0 : x > -2 ? 2 : 3; bits[2 * k] = d >> 1; bits[2 * k + 1] = d & 1; }
    const cac = nxdnCac(bits);
    if (!cac) { this.stats.cacBad++; return; }
    this.stats.cacOk++;
    const site = nxdnSiteInfo(cac.subarray(8));
    if (site) this.onSite(site);
  }
}
/**
 * A receiver at one baud rate on complex baseband: a low-pass a little wider than the signal (outer deviation plus
 * half the symbol rate, with room for a frequency offset), then the symbol recovery and the framer.
 */
export class NxdnRx {
  readonly framer = new NxdnFramer();
  readonly rx: SymbolRx;
  private readonly h: Float32Array; private readonly bi: Float32Array; private readonly bq: Float32Array; private p = 0;
  private oi = new Float32Array(0); private oq = new Float32Array(0);
  /** The first tenth of a second is held to measure the carrier offset (the scrambled levels average out). */
  private hold: { i: number[]; q: number[] } | null = { i: [], q: [] };
  constructor(readonly fs: number, readonly baud: 2400 | 4800) {
    this.rx = new SymbolRx(fs, baud, 0.5); this.rx.onSymbol = s => this.framer.push(s);
    const fc = (baud === 2400 ? 1050 : 2400) + baud / 2 + 800, n = 2 * Math.round(2 * fs / baud) + 1, m = (n - 1) / 2;
    this.h = new Float32Array(n); let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = i - m, x = 2 * fc / fs, sinc = t === 0 ? x : Math.sin(Math.PI * x * t) / (Math.PI * t);
      this.h[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1))); sum += this.h[i];
    }
    for (let i = 0; i < n; i++) this.h[i] /= sum;
    this.bi = new Float32Array(2 * n); this.bq = new Float32Array(2 * n);
  }
  push(zi: Float32Array, zq: Float32Array, m: number): void {
    if (this.oi.length < m) { this.oi = new Float32Array(m); this.oq = new Float32Array(m); }
    const h = this.h, n = h.length, bi = this.bi, bq = this.bq;
    for (let k = 0; k < m; k++) {
      bi[this.p] = bi[this.p + n] = zi[k]; bq[this.p] = bq[this.p + n] = zq[k];
      if (++this.p >= n) this.p = 0;
      let x = 0, y = 0; for (let j = 0; j < n; j++) { x += h[j] * bi[this.p + j]; y += h[j] * bq[this.p + j]; }
      this.oi[k] = x; this.oq[k] = y;
    }
    if (!this.hold) { this.rx.push(this.oi, this.oq, m); return; }
    const hd = this.hold; for (let k = 0; k < m; k++) { hd.i.push(this.oi[k]); hd.q.push(this.oq[k]); }
    if (hd.i.length < this.fs / 10) return;
    let re = 0, im = 0;
    for (let k = 1; k < hd.i.length; k++) { re += hd.i[k] * hd.i[k - 1] + hd.q[k] * hd.q[k - 1]; im += hd.q[k] * hd.i[k - 1] - hd.i[k] * hd.q[k - 1]; }
    this.rx.setOffset(Math.atan2(im, re) * this.fs / (2 * Math.PI));
    this.hold = null;
    this.rx.push(Float32Array.from(hd.i), Float32Array.from(hd.q), hd.i.length);
  }
}
