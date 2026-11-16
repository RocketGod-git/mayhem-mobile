/**
 * VDL Mode 2 receiver (VHF Digital Link, 136 MHz): our own, from the public standard's structure (ETSI EN 301 841-1:
 * D8PSK at 10 500 symbols a second, 3 bits a symbol, raised cosine α 0.6; a training sequence of ramp-up, a 16-symbol
 * unique word, a reserved symbol, a 17-bit transmission length and a 5-bit header FEC; frames are AVLC, the HDLC of
 * aviation). The details the ETSI text leaves to ICAO were worked out on our own recordings of 136.975 and 136.10 MHz
 * (2026-11-14), where every burst passes its AVLC frame check with these:
 * - the unique word is 000 010 011 110 000 001 101 110 001 100 011 111 101 111 100 010, which fixes the Gray mapping of
 *   the eight phase steps (0, 1, 3, 2, 6, 7, 5, 4 π/4 for 000 ... 111);
 * - everything from the reserved symbol on is scrambled by x^15 + x + 1 from state 0x098D (output: the oldest stage);
 * - the frame bits after the header are bytes (first bit = least significant) in Reed-Solomon blocks of up to 249
 *   data bytes, the data bytes of all blocks interleaved column by column, the parity after;
 * - AVLC: flags 7E, zero-bit stuffing, CRC-16 X.25; each address is 4 octets of 7 bits (first sent = most
 *   significant): a flag bit, a 3-bit type (1 = aircraft, its 24-bit ICAO address) and the 24-bit address.
 *
 * All of that matches ICAO Annex 10 Volume III, Part I, 6.4.3 (read 2026-11-16): the unique word; the scrambler's
 * start 1101 0010 1011 001 (our state above is the same generator written the other way round); the length (data bits
 * after the header FEC, least significant bit first); the column interleaver; and the two codes it adds, both used
 * here: the (25, 20) header FEC (one wrong header bit is put right) and Reed-Solomon (255, 249) over GF(256) with
 * x^8 + x^7 + x^2 + x + 1, generator roots α^120 … α^125, blocks shorter than 249 octets filled with zeros that are not
 * sent, and only 2 (3 to 30 octets) or 4 (31 to 67) of the 6 check octets sent, the rest erasures. Up to 3 bad octets
 * a block are put right (an erasure counts half). On our recordings every full block's six syndromes are zero.
 *
 * Every VDL2 channel inside the span is decoded at once, each by its own receiver. ACARS carried in AVLC (FF FF 01,
 * then the ACARS block) comes out as the ACARS app's message lines with VDL2 in front, so the same cards read it.
 */
import { type Emit, type IqProcessor } from './core.js';
import { ChannelDecimator, ComplexFirDecimator, lowpassTaps } from './ham/filters.js';
import { fft } from '../fft.js';

/** VDL Mode 2 channels: 136.975 (the common signaling channel) first, then the other US and European ones and 136.10
 *  (busy at our home station). */
export const VDL2_CHANNELS = [136_975_000, 136_650_000, 136_700_000, 136_725_000, 136_775_000, 136_800_000, 136_825_000,
  136_875_000, 136_900_000, 136_925_000, 136_950_000, 136_100_000];
const MAX_CHANNELS = 12;
export const VDL2_SYMBOL_RATE = 10_500;
/** The unique word as phase steps (π/4 each). */
const UW = [0, 3, 2, 4, 0, 1, 6, 4, 1, 7, 2, 5, 6, 5, 7, 3];
/** A phase step (π/4 units) → its three bits, in the order sent. */
const TRI = [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]];
const SCRAMBLER_SEED = 0x098D;
const DEL = 0x7F, STX = 0x02, ETX = 0x03, ETB = 0x17;

/** One decoded AVLC frame (for tests and tools). */
export interface Vdl2Frame {
  hz: number; ms: number; snrDb: number;
  src: number; srcType: number; dst: number; dstType: number;
  ctrl: number; info: number[];
}

export function crcX25(b: number[], n = b.length): number {
  let c = 0xFFFF;
  for (let i = 0; i < n; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  return c;
}

/** HDLC: frames between flags, zero bits after five ones dropped, bytes first bit least significant. Only frames
 *  whose CRC-16 X.25 checks are returned (without the FCS). `bad` counts the others. */
export function hdlcFrames(bits: ArrayLike<number>, n = bits.length): { frames: number[][]; bad: number } {
  const frames: number[][] = [];
  let bad = 0, sh = 0, have = false, ones = 0;
  let cur: number[] = [], byte = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const b = bits[i];
    sh = ((sh << 1) | b) & 0xFF;
    if (sh === 0x7E) {
      // the flag's own seven bits went into cur already: drop them
      if (have) {
        const total = cur.length * 8 + nb - 7;
        if (total >= 8 * 12 && total % 8 === 0) {
          const by = cur.slice(0, total / 8);
          if (crcX25(by) === 0xF0B8) frames.push(by.slice(0, -2)); else bad++;
        }
      }
      have = true; cur = []; byte = 0; nb = 0; ones = 0;
      continue;
    }
    if (!have) continue;
    if (b) { ones++; if (ones > 6) { have = false; continue; } }
    else { if (ones === 5) { ones = 0; continue; } ones = 0; }
    byte |= b << nb; nb++;
    if (nb === 8) { cur.push(byte); byte = 0; nb = 0; if (cur.length > 2100) have = false; }
  }
  return { frames, bad };
}

/** An address field: 4 octets, 7 bits each after the extension bit, first sent = most significant. */
export function avlcAddress(b: number[], at: number): { type: number; addr: number; flag: number } {
  let v = 0;
  for (let k = 0; k < 4; k++) {
    const x = b[at + k] >> 1;
    let r = 0; for (let i = 0; i < 7; i++) r |= ((x >> i) & 1) << (6 - i);
    v = v * 128 + r;
  }
  return { flag: Math.floor(v / 0x8000000) & 1, type: Math.floor(v / 0x1000000) & 7, addr: v % 0x1000000 };
}

const TYPE_NAMES = ['type 0', 'aircraft', 'type 2', 'type 3', 'ground station', 'ground station', 'type 6', 'all stations'];
const h6 = (v: number) => v.toString(16).toUpperCase().padStart(6, '0');

/** The (25, 20) header FEC's parity matrix (Annex 10 Vol III 6.4.3.1.1.5), over the reserved symbol and the length. */
const HEADER_H = ['00000000111111111111', '00111111000011111111', '11000111001100001111', '11011011010100110011', '01101001111001010101']
  .map(r => [...r].map(Number));

/** Puts right one wrong bit in the 25 header bits (reserved symbol, length, parity) in place; false when more are wrong. */
export function vdl2HeaderFix(h: Uint8Array): boolean {
  let syn = 0;
  for (let r = 0; r < 5; r++) {
    let p = h[20 + r];
    for (let c = 0; c < 20; c++) p ^= HEADER_H[r][c] & h[c];
    syn |= p << (4 - r);
  }
  if (syn === 0) return true;
  for (let c = 0; c < 20; c++) {
    let col = 0; for (let r = 0; r < 5; r++) col |= HEADER_H[r][c] << (4 - r);
    if (col === syn) { h[c] ^= 1; return true; }
  }
  for (let r = 0; r < 5; r++) if (syn === 1 << (4 - r)) { h[20 + r] ^= 1; return true; }
  return false;
}

// GF(256) with x^8 + x^7 + x^2 + x + 1, α = x
const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x187; } for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]; }
const gmul = (a: number, b: number) => a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
const gdiv = (a: number, b: number) => a ? GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]] : 0;
const gpow = (e: number) => GF_EXP[((e % 255) + 255) % 255];
/** Polynomials here are coefficient arrays, lowest degree first. */
const pmul = (a: number[], b: number[]) => { const o = new Array<number>(a.length + b.length - 1).fill(0); for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) o[i + j] ^= gmul(a[i], b[j]); return o; };
const peval = (p: number[], x: number) => { let v = 0; for (let i = p.length - 1; i >= 0; i--) v = gmul(v, x) ^ p[i]; return v; };

/**
 * Reed-Solomon (255, 249) errors-and-erasures decoding of one block in place: `cw` is the 255 octets in sending order
 * (the first one the highest power), `erased` the positions (indexes into cw) whose octets were not sent. Roots
 * α^120 … α^125. Returns how many octets were put right, or -1 when the block cannot be (then it is left as it was).
 */
export function rsDecode(cw: number[], erased: number[]): number {
  const N = 255, T2 = 6, FCR = 120;
  const syn = new Array<number>(T2);
  let any = false;
  for (let j = 0; j < T2; j++) { let s = 0; const a = gpow(FCR + j); for (let i = 0; i < N; i++) s = gmul(s, a) ^ cw[i]; syn[j] = s; if (s) any = true; }
  if (!any) return 0;
  const e = erased.length;
  if (e > T2) return -1;
  // the erasure locator Γ(x) = Π (1 - X x), X = α^degree
  let gam = [1];
  for (const i of erased) gam = pmul(gam, [1, gpow(N - 1 - i)]);
  // Forney syndromes: S(x)Γ(x) mod x^6, the first e of them spent on the erasures
  const fs = pmul(syn, gam).slice(0, T2);
  // Berlekamp-Massey over the rest for the error locator Λ(x)
  let lam = [1], prev = [1], L = 0, m = 1, b = 1;
  for (let r = e; r < T2; r++) {
    let d = fs[r];
    for (let i = 1; i <= L; i++) d ^= gmul(lam[i] ?? 0, fs[r - i]);
    if (d === 0) { m++; continue; }
    const coef = gdiv(d, b), t = lam.slice(), sh = new Array<number>(m).fill(0).concat(prev.map(x => gmul(x, coef)));
    const nl = new Array<number>(Math.max(lam.length, sh.length)).fill(0);
    for (let i = 0; i < nl.length; i++) nl[i] = (lam[i] ?? 0) ^ (sh[i] ?? 0);
    lam = nl;
    if (2 * L <= r - e) { L = r - e + 1 - L; prev = t; b = d; m = 1; } else m++;
  }
  while (lam.length > 1 && lam[lam.length - 1] === 0) lam.pop();
  if (2 * (lam.length - 1) + e > T2) return -1;
  const psi = pmul(lam, gam);
  // its roots: the positions
  const pos: number[] = [];
  for (let i = 0; i < N; i++) if (peval(psi, gpow(-(N - 1 - i))) === 0) pos.push(i);
  if (pos.length !== psi.length - 1) return -1;
  // Forney: the values, Ω(x) = S(x)Ψ(x) mod x^6, e = X^(1-FCR) Ω(X⁻¹) / Ψ'(X⁻¹)
  const om = pmul(syn, psi).slice(0, T2);
  const dpsi = psi.map((c, i) => (i & 1 ? c : 0)).slice(1);
  const fix = cw.slice();
  for (const i of pos) {
    const X = gpow(N - 1 - i), xi = gdiv(1, X);
    const den = peval(dpsi, xi);
    if (!den) return -1;
    fix[i] ^= gmul(gmul(gpow((N - 1 - i) * (1 - FCR)), peval(om, xi)), gdiv(1, den));
  }
  for (let j = 0; j < T2; j++) { let s = 0; const a = gpow(FCR + j); for (let i = 0; i < N; i++) s = gmul(s, a) ^ fix[i]; if (s) return -1; }
  for (let i = 0; i < N; i++) cw[i] = fix[i];
  return pos.filter(i => !erased.includes(i)).length;
}

/** The frames of one transmission's bits (after the unique word): descrambled, header (put right if one bit is
 *  wrong), de-interleaved, Reed-Solomon put right, HDLC. `fixed` counts the octets Reed-Solomon put right. */
export function vdl2Transmission(raw: ArrayLike<number>, n: number): { frames: number[][]; bad: number; len: number; fixed: number } | null {
  if (n < 25 + 8 * 13) return null;
  const bits = new Uint8Array(n);
  let st = SCRAMBLER_SEED;
  for (let i = 0; i < n; i++) {
    const out = (st >> 14) & 1, fb = (st ^ (st >> 14)) & 1;
    st = ((st << 1) | fb) & 0x7FFF;
    bits[i] = raw[i] ^ out;
  }
  if (!vdl2HeaderFix(bits)) return null;
  if (bits[0] || bits[1] || bits[2]) return null;   // the reserved symbol is 000
  let len = 0;
  for (let i = 0; i < 17; i++) len |= bits[3 + i] << i;
  const nby = (len + 7) >> 3;
  if (len < 8 * 13) return null;
  const sizes: number[] = [];
  for (let left = nby; left > 0; left -= 249) sizes.push(Math.min(249, left));
  const npar: number[] = sizes.map(k => k <= 2 ? 0 : k <= 30 ? 2 : k <= 67 ? 4 : 6);
  // the data must all be there; check octets the burst ended before are erasures like the ones never sent
  const avail = Math.min(nby + npar.reduce((a, x) => a + x, 0), Math.floor((n - 25) / 8));
  if (avail < nby) return null;
  const by = new Array<number>(avail);
  for (let q = 0; q < avail; q++) { let v = 0; for (let i = 0; i < 8; i++) v |= bits[25 + 8 * q + i] << i; by[q] = v; }
  // the table: one row of 255 per block, read out column by column, octets never sent skipped
  const rows = sizes.map(() => new Array<number>(255).fill(0));
  const lost = sizes.map(() => [] as number[]);
  let pos = 0;
  for (let i = 0; i < 255; i++) for (let j = 0; j < sizes.length; j++) if (i < sizes[j] || (i >= 249 && i < 249 + npar[j])) { if (pos < avail) rows[j][i] = by[pos]; else lost[j].push(i); pos++; }
  let fixed = 0;
  for (let j = 0; j < sizes.length; j++) {
    if (!npar[j]) continue;
    const erased: number[] = [...lost[j]]; for (let i = 249 + npar[j]; i < 255; i++) erased.push(i);
    const keep = rows[j].slice();
    const r = rsDecode(rows[j], erased);
    // the fill is zeros that were never sent: a "correction" there means the block was past putting right
    if (r > 0 && rows[j].some((v, i) => i >= sizes[j] && i < 249 && v !== 0)) rows[j] = keep;
    else if (r > 0) fixed += r;
  }
  const data = rows.flatMap((r, j) => r.slice(0, sizes[j]));
  const fb = new Uint8Array(len);
  for (let i = 0; i < len; i++) fb[i] = (data[i >> 3] >> (i & 7)) & 1;
  const r = hdlcFrames(fb, len);
  return { ...r, len, fixed };
}

/** Every VDL2 channel in the span at once. */
export class Vdl2Decoder implements IqProcessor {
  centerHz = 0;
  now: () => number = () => Date.now();
  /** Every AVLC frame that passed its check (tests and tools). */
  onFrame: ((f: Vdl2Frame) => void) | null = null;
  /** Transmissions found (unique word heard), frames that failed their check, octets Reed-Solomon put right. */
  bursts = 0; badFrames = 0; fixedOctets = 0;
  private key = '';
  private rx: Vdl2Channel[] = [];
  constructor(private readonly emit: Emit) {}
  reset(_rate: number): void { this.key = ''; this.rx = []; this.bursts = 0; this.badFrames = 0; this.fixedOctets = 0; }
  channels(): number[] { return this.rx.map(r => r.hz); }
  onIq(iq: Int8Array, rate: number): void {
    const key = `${this.centerHz}|${rate}`;
    if (key !== this.key) {
      this.key = key;
      const reach = rate / 2 - 30_000;
      const want = VDL2_CHANNELS.filter(hz => Math.abs(hz - this.centerHz) < reach && Math.abs(hz - this.centerHz) > 15_000).slice(0, MAX_CHANNELS);
      this.rx = want.map(hz => new Vdl2Channel(hz, hz - this.centerHz, rate, this));
      this.emit({ type: 'log', line: `VDL2: decoding ${this.rx.map(r => (r.hz / 1e6).toFixed(3)).join(', ')} MHz` });
    }
    for (const r of this.rx) r.onIq(iq);
  }

  /** A burst's symbols are in: frames out. */
  transmission(hz: number, steps: number[], snrDb: number): void {
    let at = -1, best = 3;
    for (let i = 0; i + 16 <= steps.length && i < 120; i++) {
      let e = 0;
      for (let k = 0; k < 16 && e < best; k++) if (steps[i + k] !== UW[k]) e++;
      if (e < best) { best = e; at = i; if (e === 0) break; }
    }
    if (at < 0) return;
    this.bursts++;
    const body = steps.slice(at + 16), bits = new Uint8Array(body.length * 3);
    for (let i = 0; i < body.length; i++) { const t = TRI[body[i]]; bits[3 * i] = t[0]; bits[3 * i + 1] = t[1]; bits[3 * i + 2] = t[2]; }
    const r = vdl2Transmission(bits, bits.length);
    if (!r) return;
    this.badFrames += r.bad; this.fixedOctets += r.fixed;
    if (r.bad && !r.frames.length) this.emit({ type: 'log', line: `VDL2 ${(hz / 1e6).toFixed(3)}: a ${r.len}-bit transmission failed its frame check` });
    if (r.fixed) this.emit({ type: 'log', line: `VDL2 ${(hz / 1e6).toFixed(3)}: Reed-Solomon put right ${r.fixed} octet${r.fixed === 1 ? '' : 's'}` });
    for (const fr of r.frames) this.frame(hz, fr, snrDb);
  }

  private frame(hz: number, b: number[], snrDb: number): void {
    if (b.length < 9) return;
    const dst = avlcAddress(b, 0), src = avlcAddress(b, 4), ctrl = b[8], info = b.slice(9);
    const f: Vdl2Frame = { hz, ms: this.now(), snrDb, src: src.addr, srcType: src.type, dst: dst.addr, dstType: dst.type, ctrl, info };
    this.onFrame?.(f);
    const mhz = (hz / 1e6).toFixed(3);
    const down = src.type === 1;
    const who = `${TYPE_NAMES[src.type]} ${h6(src.addr)} → ${TYPE_NAMES[dst.type]} ${h6(dst.addr)}`;
    const kind = (ctrl & 1) === 0 ? 'I' : (ctrl & 3) === 1 ? 'S' : (ctrl & 0xEF) === 0xAF ? 'XID' : (ctrl & 0xEF) === 0x03 ? 'UI' : `U ${ctrl.toString(16).toUpperCase().padStart(2, '0')}`;
    const acars = info.length >= 16 && info[0] === 0xFF && info[1] === 0xFF && info[2] === 0x01 ? this.acars(mhz, down, info.slice(3)) : null;
    if (acars) {
      this.emit({ type: 'packet', line: acars });
      this.emit({ type: 'log', line: `VDL2 ${mhz}: ${who} · ${kind} · ACARS · +${snrDb} dB` });
      return;
    }
    const text = info.map(x => (x & 0x7F) >= 0x20 && (x & 0x7F) < 0x7F ? String.fromCharCode(x & 0x7F) : '·').join('');
    const words = (text.match(/[A-Z0-9]{4,}/g) ?? []).join(' ');
    this.emit({ type: 'log', line: `VDL2 ${mhz} ${down ? '↓' : '↑'} ${who} · ${kind} · ${info.length} bytes${words ? ` · ${words}` : ''} · +${snrDb} dB` });
  }

  /** An ACARS block (mode, registration, ack, label, block ID, then STX and text) as an ACARS message line. */
  private acars(mhz: string, down: boolean, raw: number[]): string | null {
    const B = raw.map(x => x & 0x7F), n = B.length;
    if (n < 13) return null;
    const ch = (i: number) => String.fromCharCode(B[i]);
    const mode = ch(0);
    let reg = ''; for (let i = 1; i <= 7; i++) reg += ch(i); reg = reg.replace(/^[. ]+|[. ]+$/g, '');
    const ack = B[8] === 0x15 ? 'NAK' : ch(8);
    const label = ch(9) + (B[10] === DEL ? 'd' : ch(10));
    const blk = ch(11);
    let p = 12, msn = '', flight = '';
    if (B[p] === STX) {
      p++;
      if (down && n - p >= 11) { for (let i = 0; i < 4; i++) msn += ch(p + i); for (let i = 4; i < 10; i++) flight += ch(p + i); flight = flight.trim(); p += 10; }
    }
    let text = '';
    while (p < n) { const c = B[p++]; if (c === ETX || c === ETB) break; text += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : (c === 0x0a || c === 0x0d) ? ' ' : '·'; }
    const head = `VDL2 ${mhz} ${down ? '↓' : '↑'} ${reg}  ${label}  blk ${blk}  ack ${ack}${msn ? `  #${msn} ${flight}` : ''}${mode !== '2' ? `  mode ${mode}` : ''}`;
    const body = text.trim();
    return body ? `${head}\n${body}` : head;
  }
}

/** One VDL2 channel: oscillator, CIC + FIR down to about 105 kHz, a ±10 kHz channel filter, bursts out of the
 *  power, then D8PSK: the carrier from the 8th power, the symbol clock, the phase steps. */
class Vdl2Channel {
  private cr = 1; private ci = 0; private readonly dr: number; private readonly di: number;
  private readonly chan: ChannelDecimator; private readonly lp: ComplexFirDecimator;
  readonly fs: number;
  private floor = 0; private on = false; private quiet = 0; private seen = 0;
  private buf = new Float32Array(2 * 8192); private n = 0; private peak = 0;
  private mixed = new Float32Array(0); private flt = new Float32Array(0);

  constructor(readonly hz: number, readonly offsetHz: number, rate: number, private readonly dec: Vdl2Decoder) {
    const w = -2 * Math.PI * offsetHz / rate; this.dr = Math.cos(w); this.di = Math.sin(w);
    this.chan = new ChannelDecimator(Math.max(1, Math.floor(rate / 105_000)));
    this.fs = rate / this.chan.total;
    this.lp = new ComplexFirDecimator(lowpassTaps(10_000 / this.fs, 41), 1);
  }

  onIq(iq: Int8Array): void {
    const n = iq.length >> 1;
    if (this.mixed.length < 2 * n) this.mixed = new Float32Array(2 * n);
    let r = this.cr, s = this.ci;
    const m = this.mixed, dr = this.dr, di = this.di;
    for (let k = 0; k < n; k++) {
      const xi = iq[2 * k], xq = iq[2 * k + 1];
      m[2 * k] = xi * r - xq * s; m[2 * k + 1] = xi * s + xq * r;
      const t = r * dr - s * di; s = r * di + s * dr; r = t;
      if ((k & 1023) === 0) { const g = 1 / Math.sqrt(r * r + s * s); r *= g; s *= g; }
    }
    this.cr = r; this.ci = s;
    const out = this.chan.process(m, n);
    if (this.flt.length < 2 * (out.n + 2)) this.flt = new Float32Array(2 * (out.n + 2));
    const c = this.lp.process(out.out, out.n, this.flt);
    const z = this.flt, fs = this.fs;
    for (let k = 0; k < c; k++) {
      const p = z[2 * k] * z[2 * k] + z[2 * k + 1] * z[2 * k + 1];
      this.seen++;
      // the floor: a slow average of the quiet samples (bursts do not pull it up)
      if (this.floor === 0) this.floor = p + 1e-3;
      if (!this.on) {
        if (p < this.floor * 4 || this.seen < fs * 0.05) this.floor += (p - this.floor) * 0.0005;
        if (this.seen > fs * 0.05 && p > this.floor * 20) { this.on = true; this.n = 0; this.quiet = 0; this.peak = 0; }
      }
      if (this.on) {
        if (2 * this.n + 2 > this.buf.length) {
          if (this.buf.length >= 2 * fs * 0.7) { this.on = false; continue; }
          const nb = new Float32Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb;
        }
        this.buf[2 * this.n] = z[2 * k]; this.buf[2 * this.n + 1] = z[2 * k + 1]; this.n++;
        if (p > this.peak) this.peak = p;
        if (p < this.floor * 6) this.quiet++; else this.quiet = 0;
        if (this.quiet > fs * 0.0015) { this.on = false; this.burst(this.n - this.quiet); }
      }
    }
  }

  private burst(n: number): void {
    const fs = this.fs, sps = fs / VDL2_SYMBOL_RATE;
    if (n < sps * 40) return;
    const x = this.buf;
    // the carrier: the 8th power's line, over up to 16384 samples. The plain power, not the phase alone: on the phase
    // alone the lines a symbol rate either side (from the pulse shape) can win, 1.3 kHz off on our recordings.
    let N = 1; while (N < Math.min(n, 16384)) N <<= 1;
    const re = new Float32Array(N), im = new Float32Array(N), m = Math.min(n, N);
    let pw = 0; for (let k = 0; k < m; k++) pw += x[2 * k] * x[2 * k] + x[2 * k + 1] * x[2 * k + 1];
    const g = 1 / Math.sqrt(pw / m + 1e-20);
    for (let k = 0; k < m; k++) {
      let a = x[2 * k] * g, b = x[2 * k + 1] * g;
      for (let q = 0; q < 3; q++) { const t = a * a - b * b; b = 2 * a * b; a = t; }
      re[k] = a; im[k] = b;
    }
    fft(re, im);
    let bi = 0, bv = -1;
    for (let k = 0; k < N; k++) { const v = re[k] * re[k] + im[k] * im[k]; if (v > bv) { bv = v; bi = k; } }
    const f8 = (bi < N / 2 ? bi : bi - N) * fs / N;
    const w = -2 * Math.PI * (f8 / 8) / fs;
    const y = new Float32Array(2 * n);
    for (let k = 0; k < n; k++) { const c = Math.cos(w * k), s = Math.sin(w * k); y[2 * k] = x[2 * k] * c - x[2 * k + 1] * s; y[2 * k + 1] = x[2 * k] * s + x[2 * k + 1] * c; }
    // the symbol clock: the phase (of 16) where the steps sit closest to whole multiples of π/4
    const at = (t: number): [number, number] => { const i = Math.floor(t), f = t - i; if (i + 1 >= n) return [y[2 * i], y[2 * i + 1]]; return [y[2 * i] * (1 - f) + y[2 * i + 2] * f, y[2 * i + 1] * (1 - f) + y[2 * i + 3] * f]; };
    const count = Math.floor((n - 2) / sps) - 1;
    let bestPh = 0, bestE = Infinity;
    for (let p = 0; p < 16; p++) {
      const ph = sps * p / 16;
      let e = 0, [pr, pi] = at(ph);
      for (let k = 1; k < count; k++) {
        const [cr, ci] = at(ph + k * sps);
        const q = Math.atan2(ci * pr - cr * pi, cr * pr + ci * pi) / (Math.PI / 4);
        e += Math.abs(q - Math.round(q)); pr = cr; pi = ci;
      }
      if (e < bestE) { bestE = e; bestPh = ph; }
    }
    const steps: number[] = [];
    let [pr, pi] = at(bestPh);
    for (let k = 1; k < count; k++) {
      const [cr, ci] = at(bestPh + k * sps);
      const q = Math.round(Math.atan2(ci * pr - cr * pi, cr * pr + ci * pi) / (Math.PI / 4));
      steps.push(((q % 8) + 8) % 8); pr = cr; pi = ci;
    }
    const snr = Math.round(10 * Math.log10(this.peak / this.floor));
    this.dec.transmission(this.hz, steps, snr);
  }
}
