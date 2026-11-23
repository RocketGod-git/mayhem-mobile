/**
 * Who is on a dPMR channel (ETSI TS 102 490 V1.3.1, the dPMR common air interface), from the 2400/s symbols (outer
 * levels near ±3; dibit 01 is +3, 00 +1, 10 -1, 11 -3, Table 12.1). Written from the standard:
 *
 *   · Frame syncs (6.1): FS1 57FF5F75D577 opens a header, FS2 5FF77D payload frames 1 and 3 of a superframe, FS3 7DDFF5
 *     an end frame, FS4 FD55F5DF7FDD a packet data header. Found in either polarity.
 *   · Header (4.2.2, 9.5): preamble, FS1, HI0 (120 bits), the color code (24), HI1 (the same 120 bits again). HI is 72
 *     bits: header type 4, called ID 24, own ID 24, communications mode 3, format 4, reserved 2, call information 11;
 *     a CRC-8 (X^8 + X^2 + X + 1, 7.2), ten (12,8) shortened Hamming words (7.3), the 12 x 10 interleaver (7.5), the
 *     scrambler (7.4).
 *   · Payload frame (4.2.2, 9.1): 80 ms, 384 bits: FS2 (frames 1 and 3) or the color code (2 and 4), the CCH (72 bits),
 *     four 72-bit TCH blocks. The CCH is 41 bits: frame number 2, 12 bits of an ID (frame 1 the called ID's upper half,
 *     2 its lower, 3 the own ID's upper, 4 its lower), mode 3, format 4, reserved 2, slow data 18; a CRC-7 (X^7 + X^3 +
 *     1), six Hamming words, the 12 x 6 interleaver, the scrambler.
 *   · End frame (9.6): FS3 and 17 bits (end type, ARQ, wait, status, reserved), a CRC-7, three Hamming words sent twice
 *     and scrambled.
 *   · Color code (6.1.5): 12 bits, each sent as a dibit (0 as 01, 1 as 11). Table 6.1's codes are a 6-bit value and 6
 *     check bits, an affine function of the value; the value (0 to 63) is the color code shown.
 *   · Slow data (5.9.1): in a voice + slow data call (mode 001), each frame's 18 bits are two bytes, each after its
 *     continuation flag. Text there is read for NMEA and APRS positions.
 *   · Addresses (Annex A): 24 bits, shown as the seven characters the B2 mapping gives (a '*' in the last four marks a
 *     talkgroup). Initial mode (ISF) radios use an 8-bit common ID with the other 16 bits all ones (8.1.1).
 *   · Voice: the four TCH blocks of each frame are AMBE+2 half-rate frames, through the AMBE+2 decoder.
 * No DOM.
 */
import { AmbeStream } from './voice.js';
import { LineBuffer, parsePositionLine, type Position } from './gps.js';

const levels = (hex: string) => { const o: number[] = []; for (const c of hex) { const v = parseInt(c, 16); for (const d of [v >> 2, v & 3]) o.push(d === 1 ? 3 : d === 0 ? 1 : d === 2 ? -1 : -3); } return Float32Array.from(o); };
export const DPMR_FS1 = levels('57FF5F75D577'), DPMR_FS2 = levels('5FF77D'), DPMR_FS3 = levels('7DDFF5'), DPMR_FS4 = levels('FD55F5DF7FDD');

/** The 6 check bits of a color code value (Table 6.1, an affine map: 22 XOR one word per value bit). */
export function dpmrCcCheck(v: number): number {
  const B = [48, 17, 35, 54, 28, 56];   // value bits 0 .. 5
  let r = 22; for (let k = 0; k < 6; k++) if (v & (1 << k)) r ^= B[k];
  return r;
}
/** A color code value as its 12 symbol levels (0 as +3, 1 as -3). */
export function dpmrCcLevels(v: number): Float32Array {
  const c = (v << 6) | dpmrCcCheck(v), o = new Float32Array(12);
  for (let i = 0; i < 12; i++) o[i] = (c >> (11 - i)) & 1 ? -3 : 3;
  return o;
}
const CC_LV = Array.from({ length: 64 }, (_, v) => dpmrCcLevels(v));
/** Table 6.1's group A codes (Initial Services and Facilities), by value. */
const GROUP_A = new Set([5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11, 20]);

/** The scrambler of 7.4: X^9 + X^5 + 1, S9..S1 preset to ones, output S1, S1 + S5 fed to S9. */
export function dpmrScrambler(n: number): Uint8Array {
  const s = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1];   // s[1..9]
  const o = new Uint8Array(n);
  for (let k = 0; k < n; k++) { const out = s[1], fb = s[1] ^ s[5]; o[k] = out; for (let i = 1; i < 9; i++) s[i] = s[i + 1]; s[9] = fb; }
  return o;
}
const SCR = dpmrScrambler(120);
/** (12,8) shortened Hamming (Table 7.1): the parity each data bit X7 .. X0 adds. */
const HAM = [0b1110, 0b0111, 0b1010, 0b0101, 0b1011, 0b1100, 0b0110, 0b0011];
export const dpmrHamming = (d: number) => { let p = 0; for (let i = 0; i < 8; i++) if (d & (0x80 >> i)) p ^= HAM[i]; return (d << 4) | p; };
/** A received 12-bit word to its byte, one error corrected; -1 when it cannot be. */
export function dpmrHammingDecode(w: number): number {
  const d = (w >> 4) & 0xff, syn = (dpmrHamming(d) ^ w) & 15;
  if (syn === 0) return d;
  for (let i = 0; i < 8; i++) if (syn === HAM[i]) return d ^ (0x80 >> i);
  if (syn === 1 || syn === 2 || syn === 4 || syn === 8) return d;
  return -1;
}
/** A CRC (7.2) over bits, high term first, register cleared: [poly] without its top term. */
export function dpmrCrc(bits: ArrayLike<number>, n: number, width: number, poly: number): number {
  const mask = (1 << width) - 1; let r = 0;
  for (let i = 0; i < n; i++) { const fb = ((r >> (width - 1)) & 1) ^ bits[i]; r = (r << 1) & mask; if (fb) r ^= poly; }
  return r;
}
export const dpmrCrc7 = (b: ArrayLike<number>, n: number) => dpmrCrc(b, n, 7, 0x09);
export const dpmrCrc8 = (b: ArrayLike<number>, n: number) => dpmrCrc(b, n, 8, 0x07);
const field = (b: ArrayLike<number>, at: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 2 + b[at + k]; return v; };

/**
 * One coded field as received (bits in order sent): descrambled, de-interleaved ([cols] columns of 12, written by
 * columns and read by rows at the transmitter), the Hamming words decoded. The data bits, or null if a word fails.
 */
export function dpmrField(rx: ArrayLike<number>, cols: number): Uint8Array | null {
  const n = 12 * cols, coded = new Uint8Array(n);
  for (let r = 0; r < 12; r++) for (let c = 0; c < cols; c++) coded[c * 12 + r] = rx[r * cols + c] ^ SCR[r * cols + c];
  const out = new Uint8Array(8 * cols);
  for (let w = 0; w < cols; w++) {
    const d = dpmrHammingDecode(field(coded, 12 * w, 12)); if (d < 0) return null;
    for (let i = 0; i < 8; i++) out[8 * w + i] = (d >> (7 - i)) & 1;
  }
  return out;
}

/** Annex A, B2 reversed: a 24-bit address as its seven characters ('*' for 10 in the last four); '' when it is none. */
export function dpmrDial(id: number): string {
  let r = id; const k: number[] = [];
  for (const m of [1464100, 146410, 14641, 1331, 121, 11, 1]) { k.push(Math.floor(r / m)); r %= m; }
  if (k[0] > 9 || k[1] > 9 || k[2] > 9 || k.slice(3).some(x => x > 10)) return '';
  return k.map((x, i) => i >= 3 && x === 10 ? '*' : String(x)).join('');
}

export interface DpmrId {
  /** The color code value (0 to 63, -1 unknown) and its group in Table 6.1 ('A' ISF, 'B' CSF, '' other). */
  cc: number; ccGroup: string;
  called: number; own: number;
  /** Annex A's seven characters for each, or the ISF common ID ("COMMON 12"). */
  calledText: string; ownText: string; group: boolean;
  /** Header type (5.11), communications mode (5.7) and format (5.8) of the last header or frame. */
  headerType: number; commMode: number; format: number;
  activity: string; calls: number; voiceFrames: number; headers: number; frames: number;
  slowData: string; position: Position | null;
  inverted: boolean; lastSym: number;
}
const blank = (): DpmrId => ({ cc: -1, ccGroup: '', called: -1, own: -1, calledText: '', ownText: '', group: false, headerType: -1, commMode: -1, format: -1, activity: '', calls: 0, voiceFrames: 0, headers: 0, frames: 0, slowData: '', position: null, inverted: false, lastSym: -1 });
const idText = (v: number) => (v >>> 16) <= 0xff && (v & 0xffff) === 0xffff ? `COMMON ${v >>> 16}` : dpmrDial(v) || String(v);

const H = 1024;
export class DpmrIdentity {
  onAudio: (pcm: Float32Array) => void = () => undefined;
  id: DpmrId = blank();
  private readonly hist = new Float32Array(H); private t = 0;
  /** Work waiting for its symbols: what, where it starts, the polarity times the level correction, frames carried by the grid. */
  private jobs: { kind: 'hdr' | 'frame' | 'end'; at: number; sign: number; fly: number }[] = [];
  private lastFrame = -1e9;
  private readonly voice = new AmbeStream();
  private readonly ids = [-1, -1, -1, -1]; private readonly idAt = [-1e9, -1e9, -1e9, -1e9];
  private readonly lines = new LineBuffer();
  /** Checks passed: headers and frames whose CRC held. */
  checked = 0;

  reset(): void { this.id = blank(); this.hist.fill(0); this.t = 0; this.jobs = []; this.lastFrame = -1e9; this.voice.reset(); this.ids.fill(-1); this.idAt.fill(-1e9); this.lines.reset(); this.checked = 0; }

  private at(i: number): number { return this.hist[i & (H - 1)]; }
  /** Correlation of the last symbols with a sync (all outer levels), and the gain that brings them to ±3. */
  private corr(pat: Float32Array): { c: number; g: number } {
    let c = 0, a = 0; const n = pat.length;
    for (let k = 0; k < n; k++) { const x = this.at(this.t - n + k); c += x * pat[k]; a += Math.abs(x); }
    return a > n * 0.5 ? { c: c / (3 * a), g: 3 * n / a } : { c: 0, g: 1 };
  }
  private bits(from: number, nsym: number, sign: number): Uint8Array {
    const o = new Uint8Array(2 * nsym);
    for (let k = 0; k < nsym; k++) { const x = sign * this.at(from + k); o[2 * k] = x < 0 ? 1 : 0; o[2 * k + 1] = Math.abs(x) > 2 ? 1 : 0; }
    return o;
  }
  private queue(kind: 'hdr' | 'frame' | 'end', at: number, sign: number, fly = 0): void {
    if (kind === 'frame' && this.jobs.some(j => j.kind === 'frame' && Math.abs(j.at - at) <= 2)) return;
    if (kind === 'frame' && Math.abs(at - this.lastFrame) <= 2) return;
    this.jobs.push({ kind, at, sign, fly });
  }

  pushSymbol(s: number): void {
    this.hist[this.t & (H - 1)] = s; this.t++;
    // a sync found sets the polarity and the level (the symbol recovery's own estimate is slow at a transmission's start)
    const f1 = this.corr(DPMR_FS1), f2 = this.corr(DPMR_FS2), f3 = this.corr(DPMR_FS3);
    if (Math.abs(f1.c) > 0.9) this.queue('hdr', this.t, Math.sign(f1.c) * f1.g);
    else if (Math.abs(f2.c) > 0.92) this.queue('frame', this.t - 12, Math.sign(f2.c) * f2.g);
    else if (Math.abs(f3.c) > 0.92) this.queue('end', this.t, Math.sign(f3.c) * f3.g);
    const due = this.jobs.filter(j => this.t >= j.at + (j.kind === 'hdr' ? 132 : j.kind === 'end' ? 36 : 192));
    if (!due.length) return;
    this.jobs = this.jobs.filter(j => !due.includes(j));
    for (const j of due.sort((a, b) => a.at - b.at)) {
      if (j.kind === 'hdr') this.header(j.at, j.sign);
      else if (j.kind === 'end') this.end(j.at, j.sign);
      else this.frame(j.at, j.sign, j.fly);
    }
  }

  /** The color code at [from]: the nearest of the 64, if near enough. */
  private cc(from: number, sign: number): number {
    let best = -1, bc = 0;
    for (let v = 0; v < 64; v++) { let c = 0, a = 0; for (let k = 0; k < 12; k++) { const x = Math.sign(sign) * this.at(from + k); c += x * CC_LV[v][k]; a += Math.abs(x); } const r = a > 0 ? c / (3 * a) : 0; if (r > bc) { bc = r; best = v; } }
    return bc > 0.8 ? best : -1;
  }
  private setCc(v: number): void { if (v < 0) return; this.id.cc = v; this.id.ccGroup = GROUP_A.has(v) ? 'A' : v >= 48 ? 'B' : ''; }

  private header(at: number, sign: number): void {
    let hi: Uint8Array | null = null;
    for (const from of [at, at + 72]) {
      const d = dpmrField(this.bits(from, 60, sign), 10);
      if (d && dpmrCrc8(d, 72) === field(d, 72, 8)) { hi = d; break; }
    }
    if (!hi) return;
    const id = this.id; this.checked++; id.inverted = sign < 0; id.headers++; id.lastSym = this.t;
    this.setCc(this.cc(at + 60, sign));
    id.headerType = field(hi, 0, 4); id.called = field(hi, 4, 24); id.own = field(hi, 28, 24); id.commMode = field(hi, 52, 3); id.format = field(hi, 55, 4);
    id.calledText = idText(id.called); id.ownText = idText(id.own); id.group = id.calledText.includes('*') || id.calledText.startsWith('COMMON');
    // a communication start header, an ACK header reply or a system delivery header is followed by superframes (5.11)
    if (id.headerType === 0 || id.headerType === 5 || id.headerType === 6) { this.start(); this.queue('frame', at + 132, sign, -1); }
  }
  private start(): void { this.id.activity = 'voice'; this.id.calls++; this.voice.reset(); this.lines.reset(); this.id.slowData = ''; this.ids.fill(-1); }

  private frame(at: number, sign0: number, fly: number): void {
    // the level again from this frame's FS2 or color code (12 outer symbols): a call carried on the grid follows the
    // symbol recovery's level as it settles
    let a = 0; for (let k = 0; k < 12; k++) a += Math.abs(this.at(at + k));
    const sign = a > 0 ? Math.sign(sign0) * 36 / a : sign0;
    const d = dpmrField(this.bits(at + 12, 36, sign), 6);
    const ok = !!d && dpmrCrc7(d, 41) === field(d, 41, 7);
    const id = this.id;
    if (!ok) {
      // the grid carries a call through a frame lost, up to a superframe
      if (id.activity === 'voice' && fly < 4) this.queue('frame', at + 192, sign, Math.max(0, fly) + 1);
      return;
    }
    // a frame counts once it is chained: the header named it, the grid of a call carried it, or a good frame came a frame before it (a 12-symbol sync
    // and a 7-bit CRC passing on noise now and then do not make a call)
    const chained = fly !== 0 || Math.abs(at - this.lastFrame - 192) <= 2;
    this.lastFrame = at;
    if (!chained) { this.queue('frame', at + 192, sign); return; }
    this.checked++; id.inverted = sign < 0; id.frames++; id.lastSym = this.t;
    const fn = field(d!, 0, 2), part = field(d!, 2, 12), mode = field(d!, 14, 3);
    id.commMode = mode; id.format = field(d!, 17, 4);
    if (fn === 1 || fn === 3) this.setCc(this.cc(at, sign));
    if (id.activity !== 'voice') this.start();
    this.ids[fn] = part; this.idAt[fn] = at;
    // the halves of an ID come in frames next to each other
    if (fn === 1 && this.ids[0] >= 0 && Math.abs(at - this.idAt[0] - 192) <= 2) { id.called = (this.ids[0] << 12) | part; id.calledText = idText(id.called); id.group = id.calledText.includes('*') || id.calledText.startsWith('COMMON'); }
    if (fn === 3 && this.ids[2] >= 0 && Math.abs(at - this.idAt[2] - 192) <= 2) { id.own = (this.ids[2] << 12) | part; id.ownText = idText(id.own); }
    // slow data (5.9.1): two bytes, each after its continuation flag
    if (mode === 1) {
      let txt = '';
      for (const o of [24, 33]) { const b = field(d!, o, 8); if (b >= 32 && b < 127) txt += String.fromCharCode(b); else if (b === 13 || b === 10) txt += '\n'; }
      if (txt) {
        id.slowData = (id.slowData + txt).slice(-64);
        for (const line of this.lines.push(txt)) { const p = parsePositionLine(line); if (p) { p.source = 'dpmr-sld'; id.position = p; } }
      }
    }
    // voice in modes 000, 001, and 101 until the slow data says data has started (DP 11)
    const dp = field(d!, 28, 2);
    if (mode === 0 || mode === 1 || (mode === 5 && dp !== 3)) {
      const tch = this.bits(at + 48, 144, sign);
      for (let k = 0; k < 4; k++) { id.voiceFrames++; this.onAudio(this.voice.decode(tch.subarray(72 * k, 72 * k + 72))); }
    }
    this.queue('frame', at + 192, sign);
  }

  /** An end frame is read only inside a call: its 12-symbol sync and 7-bit CRC alone pass on noise now and then. */
  private end(at: number, sign: number): void {
    if (this.id.activity !== 'voice') return;
    const b = this.bits(at, 36, sign);
    const sc = dpmrScrambler(72);
    for (const half of [0, 36]) {
      const w = new Uint8Array(24);
      let good = true;
      for (let k = 0; k < 3; k++) {
        let v = 0; for (let i = 0; i < 12; i++) v = v * 2 + (b[half + 12 * k + i] ^ sc[half + 12 * k + i]);
        const x = dpmrHammingDecode(v); if (x < 0) { good = false; break; }
        for (let i = 0; i < 8; i++) w[8 * k + i] = (x >> (7 - i)) & 1;
      }
      if (good && dpmrCrc7(w, 17) === field(w, 17, 7)) {
        this.checked++; this.id.activity = ''; this.id.lastSym = this.t;
        this.jobs = this.jobs.filter(j => j.kind !== 'frame');
        return;
      }
    }
  }
}
