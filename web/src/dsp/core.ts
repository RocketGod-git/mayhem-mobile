/** Shared processor plumbing — the TypeScript twin of core/IqProcessor.kt. */

export type Emit = (msg: Record<string, unknown>, transfer?: Transferable[]) => void;

/** A Mayhem-style baseband processor. Runs on the DSP worker; publishes results through [Emit]. */
export interface IqProcessor {
  readonly wantsFm?: boolean;
  reset(rate: number): void;
  /** Signed int8 interleaved I,Q. */
  onIq(iq: Int8Array, rate: number): void;
  /** NFM discriminator samples (radians/sample) at the intermediate rate. Only when wantsFm. */
  onFm?(samples: Float32Array, n: number, rate: number): void;
}

export function popcount32(x: number): number {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Integrate-and-dump symbol clock pulled toward the input's zero crossings. push() returns 0/1 or -1. */
/**
 * Audio conditioning for the FM-discriminator decoders: a one-pole DC block (the carrier offset) and a 4th-order
 * Butterworth low-pass (two biquads) that takes out the discriminator's rising high-frequency noise before the
 * tone detectors see it — on a weak packet that noise is 10–20 dB above the tones.
 */
export class DiscFilter {
  private dcX = 0; private dcY = 0;
  private readonly bq: { b0: number; b1: number; b2: number; a1: number; a2: number; z1: number; z2: number }[] = [];
  constructor(cutoffHz: number, rate: number, dcHz = 40) {
    this.dcA = Math.exp(-2 * Math.PI * dcHz / rate);
    // Butterworth 4th order = two 2nd-order sections with Q = 0.5412 and 1.3066
    for (const q of [0.5412, 1.3066]) {
      const w0 = 2 * Math.PI * Math.min(0.45 * rate, cutoffHz) / rate, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0), a0 = 1 + alpha;
      this.bq.push({ b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 });
    }
  }
  private readonly dcA: number;
  push(x: number): number {
    const y = x - this.dcX + this.dcA * this.dcY; this.dcX = x; this.dcY = y;
    let v = y;
    for (const s of this.bq) { const o = s.b0 * v + s.z1; s.z1 = s.b1 * v - s.a1 * o + s.z2; s.z2 = s.b2 * v - s.a2 * o; v = o; }
    return v;
  }
}

export class BitSync {
  private readonly inc: number;
  private phase = 0;
  private acc = 0;
  private lastPos = false;
  private first = true;
  constructor(baud: number, rate: number) { this.inc = baud / rate; }
  push(x: number): number {
    const pos = x > 0;
    if (!this.first && pos !== this.lastPos) {
      const err = this.phase < 0.5 ? this.phase : this.phase - 1;
      this.phase -= err * 0.25;
    }
    this.first = false;
    this.lastPos = pos;
    this.acc += x;
    this.phase += this.inc;
    if (this.phase >= 1) {
      this.phase -= 1;
      const bit = this.acc > 0 ? 1 : 0;
      this.acc = 0;
      return bit;
    }
    return -1;
  }
  reset(): void { this.phase = 0; this.acc = 0; this.first = true; }
}

/** Big-endian bit reader over bytes whose bits are stored LSB-first (HDLC transmission order). */
export class BitReader {
  constructor(private readonly b: Uint8Array) {}
  get bitCount(): number { return this.b.length * 8; }
  read(start: number, len: number): number {
    let v = 0;
    for (let i = 0; i < len; i++) {
      const k = start + i;
      const bit = k < this.bitCount ? (this.b[k >> 3] >> (k & 7)) & 1 : 0;
      v = (v * 2) + bit;   // multiply, not shift: fields can be 30 bits
    }
    return v;
  }
  readSigned(start: number, len: number): number {
    const v = this.read(start, len);
    return v >= 2 ** (len - 1) ? v - 2 ** len : v;
  }
}

/** HDLC / AX.25 deframer: NRZI, bit-unstuffing, 0x7E flags, bytes assembled LSB-first. */
export class HdlcFramer {
  private lastBit = 0;
  private ones = 0;
  private cur = 0;
  private bitIdx = 0;
  private readonly buf: Uint8Array;
  private size = 0;
  private inFrame = false;
  constructor(private readonly maxBytes: number, private readonly onFrame: (f: Uint8Array) => void) { this.buf = new Uint8Array(maxBytes); }
  reset(): void { this.lastBit = 0; this.abort(); }
  pushRaw(bit: number): void {
    const dec = bit === this.lastBit ? 1 : 0;
    this.lastBit = bit;
    this.pushDecoded(dec);
  }
  pushDecoded(bit: number): void {
    if (bit === 1) { if (this.ones < 8) this.ones++; }
    else {
      if (this.ones > 6) { this.abort(); return; }
      if (this.ones === 6) {
        if (this.inFrame && this.size >= 3) this.onFrame(this.buf.slice(0, this.size));
        this.inFrame = true; this.size = 0; this.cur = 0; this.bitIdx = 0; this.ones = 0;
        return;
      }
      if (this.ones === 5) { this.ones = 0; return; }
      this.ones = 0;
    }
    if (!this.inFrame) return;
    this.cur = (this.cur >> 1) | (bit << 7);
    if (++this.bitIdx >= 8) {
      this.bitIdx = 0;
      if (this.size >= this.maxBytes) { this.abort(); return; }
      this.buf[this.size++] = this.cur;
      this.cur = 0;
    }
  }
  private abort(): void { this.inFrame = false; this.size = 0; this.cur = 0; this.bitIdx = 0; this.ones = 0; }
  /** CRC-16-CCITT (reflected, init 0xFFFF) over data+FCS leaves 0xF0B8. */
  static fcsOk(f: Uint8Array): boolean {
    let crc = 0xFFFF;
    for (const x of f) {
      crc ^= x;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
    return crc === 0xF0B8;
  }
}

export function fmt(n: number, digits: number): string { return n.toFixed(digits); }
export function pad(s: string | number, w: number): string { return String(s).padStart(w, ' '); }
export function padEnd(s: string | number, w: number): string { return String(s).padEnd(w, ' '); }
