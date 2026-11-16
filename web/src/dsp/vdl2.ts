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
 *   data bytes, the data bytes of all blocks interleaved column by column, the parity after (not used yet: a frame
 *   with a bit error fails its frame check and is counted, not shown);
 * - AVLC: flags 7E, zero-bit stuffing, CRC-16 X.25; each address is 4 octets of 7 bits (first sent = most
 *   significant): a flag bit, a 3-bit type (1 = aircraft, its 24-bit ICAO address) and the 24-bit address.
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

/** The frames of one transmission's bits (after the unique word): descrambled, header, de-interleaved, HDLC. */
export function vdl2Transmission(raw: ArrayLike<number>, n: number): { frames: number[][]; bad: number; len: number } | null {
  if (n < 25 + 8 * 13) return null;
  const bits = new Uint8Array(n);
  let st = SCRAMBLER_SEED;
  for (let i = 0; i < n; i++) {
    const out = (st >> 14) & 1, fb = (st ^ (st >> 14)) & 1;
    st = ((st << 1) | fb) & 0x7FFF;
    bits[i] = raw[i] ^ out;
  }
  if (bits[0] || bits[1] || bits[2]) return null;   // the reserved symbol is 000
  let len = 0;
  for (let i = 0; i < 17; i++) len |= bits[3 + i] << i;
  const nby = (len + 7) >> 3;
  if (len < 8 * 13 || 25 + 8 * nby > n) return null;
  const have = Math.floor((n - 25) / 8);
  const by = new Array<number>(have);
  for (let q = 0; q < have; q++) { let v = 0; for (let i = 0; i < 8; i++) v |= bits[25 + 8 * q + i] << i; by[q] = v; }
  const sizes: number[] = [];
  for (let left = nby; left > 0; left -= 249) sizes.push(Math.min(249, left));
  const blocks = sizes.map(k => new Array<number>(k));
  let pos = 0;
  for (let i = 0; i < 249; i++) for (let j = 0; j < sizes.length; j++) if (i < sizes[j]) blocks[j][i] = by[pos++];
  const data = blocks.flat();
  const fb = new Uint8Array(len);
  for (let i = 0; i < len; i++) fb[i] = (data[i >> 3] >> (i & 7)) & 1;
  const r = hdlcFrames(fb, len);
  return { ...r, len };
}

/** Every VDL2 channel in the span at once. */
export class Vdl2Decoder implements IqProcessor {
  centerHz = 0;
  now: () => number = () => Date.now();
  /** Every AVLC frame that passed its check (tests and tools). */
  onFrame: ((f: Vdl2Frame) => void) | null = null;
  /** Transmissions found (unique word heard) and frames that failed their check. */
  bursts = 0; badFrames = 0;
  private key = '';
  private rx: Vdl2Channel[] = [];
  constructor(private readonly emit: Emit) {}
  reset(_rate: number): void { this.key = ''; this.rx = []; this.bursts = 0; this.badFrames = 0; }
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
    this.badFrames += r.bad;
    if (r.bad && !r.frames.length) this.emit({ type: 'log', line: `VDL2 ${(hz / 1e6).toFixed(3)}: a ${r.len}-bit transmission failed its frame check` });
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
