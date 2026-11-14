/**
 * Decoders for Vaisala RS92, Lockheed Martin LMS6-403 / LMSX, LMS6-1680 (Mk2a), MRZ, and the symbol clock they share.
 * The TypeScript twin of core/sonde/SondeBankB.kt and SondeBankB.swift.
 *
 * The symbol clock runs a one-symbol matched filter (a running sum) on the discriminator and takes its timing from the
 * filtered signal's zero crossings with a small loop gain, so noise crossings inside a symbol barely move it. Its DC
 * (the carrier's offset in the channel) follows the signal between frames and holds still inside one. This keeps the
 * slicer working down to the FM threshold, where a slicer on the raw discriminator would already be jittering.
 */
import type { ChannelDecoder } from './bank.js';
import { Lms6Decoder, LmsxDecoder, LMS6_BAUD, LMS6_BLOCK, LMS6_HEADER, LMS6_SYMS, LMSX_BAUD, LMSX_SYMS } from './lms6.js';
import { Mk2aCollector, MK2A_BAUD } from './mk2a.js';
import { MrzDecoder, MRZ_BAUD, MRZ_HEADER, MRZ_SYMS } from './mrz.js';
import { Rs92Decoder, RS92_BAUD, RS92_HEADER, RS92_SYMS } from './rs92.js';
import type { SondeFrame, SondeSink } from './types.js';

/** Soft channel symbols (positive = mark) out of discriminator samples. */
export class SymbolClock {
  private readonly inc: number;
  private readonly ring: Float32Array;
  private rp = 0; private sum = 0; private sinceFix = 0;
  private phase = 0; private lastPos = false;
  private dc = 0;
  private readonly dcRate: number;
  /** The clock phase at which the filtered signal crosses zero between unlike symbols. */
  private readonly target: number;
  /** Hold the DC (inside a frame). */
  hold = false;
  /** Discriminator samples seen. */
  samples = 0;
  constructor(baud: number, rate: number, private readonly onSymbol: (s: number) => void, private readonly gain = 0.05) {
    this.inc = baud / rate;
    const len = Math.max(2, Math.round(rate / baud));
    this.ring = new Float32Array(len);
    this.dcRate = Math.min(0.05, baud / rate / 32);
    // measured on clean signals for 5 to 42 samples a symbol: the crossing sits half a symbol after the decision
    this.target = 0.5;
  }
  push(x: number): void {
    this.samples++;
    if (!this.hold) this.dc += (x - this.dc) * this.dcRate;
    const v = x - this.dc;
    const r = this.ring;
    this.sum += v - r[this.rp]; r[this.rp] = v;
    if (++this.rp === r.length) this.rp = 0;
    // a running sum drifts with rounding: rebuild it now and then
    if (++this.sinceFix >= 8192) { this.sinceFix = 0; let s = 0; for (let i = 0; i < r.length; i++) s += r[i]; this.sum = s; }
    const pos = this.sum > 0;
    if (pos !== this.lastPos) {
      let err = this.phase - this.target;
      if (err > 0.5) err -= 1; else if (err < -0.5) err += 1;
      this.phase -= err * this.gain;
    }
    this.lastPos = pos;
    this.phase += this.inc;
    if (this.phase < 1) return;
    this.phase -= 1;
    this.onSymbol(this.sum);
  }
}

function pop32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * A header search in both FM polarities on the symbol clock (up to 64 symbols, two 32-bit words); after a match it
 * collects `frameSyms` soft symbols (sign-corrected to the header's polarity) and hands them over with the sample
 * count at the header.
 */
export class SoftFramer implements ChannelDecoder {
  private readonly clock: SymbolClock;
  private hi = 0; private lo = 0; private shN = 0;
  private readonly hHi: number; private readonly hLo: number; private readonly mHi: number; private readonly mLo: number;
  private readonly hdrLen: number;
  private collecting = 0; private inv = false; private at = 0;
  private readonly buf: Float32Array;
  private n = 0;
  constructor(readonly name: string, baud: number, rate: number, header: string, frameSyms: number, private readonly maxErr: number,
    private readonly onFrame: (soft: Float32Array, atSample: number) => void) {
    this.clock = new SymbolClock(baud, rate, s => this.symbol(s));
    this.hdrLen = header.length;
    let hh = 0, hl = 0;
    for (let i = 0; i < header.length; i++) {
      const b = header.charCodeAt(i) === 49 ? 1 : 0;
      hh = ((hh << 1) | (hl >>> 31)) >>> 0; hl = ((hl << 1) | b) >>> 0;
    }
    const n = header.length;
    this.mLo = n >= 32 ? 0xffffffff : ((1 << n) >>> 0) - 1;
    this.mHi = n >= 64 ? 0xffffffff : n > 32 ? ((1 << (n - 32)) >>> 0) - 1 : 0;
    this.hHi = (hh & this.mHi) >>> 0; this.hLo = (hl & this.mLo) >>> 0;
    this.buf = new Float32Array(frameSyms);
  }
  push(x: number): void { this.clock.push(x); }
  private symbol(s: number): void {
    if (this.collecting > 0) {
      this.buf[this.n++] = this.inv ? -s : s;
      if (--this.collecting === 0) { this.clock.hold = false; this.onFrame(this.buf, this.at); }
      return;
    }
    this.hi = (((this.hi << 1) | (this.lo >>> 31)) & this.mHi) >>> 0;
    this.lo = (((this.lo << 1) | (s > 0 ? 1 : 0)) & this.mLo) >>> 0;
    if (++this.shN < this.hdrLen) return;
    const e = pop32((this.hi ^ this.hHi) >>> 0) + pop32((this.lo ^ this.hLo) >>> 0);
    const ei = this.hdrLen - e;
    if (e <= this.maxErr || ei <= this.maxErr) {
      this.inv = ei < e;
      this.collecting = this.buf.length; this.n = 0; this.shN = 0;
      this.at = this.clock.samples;
      this.clock.hold = true;
    }
  }
}

/** LMS6-1680: the symbol clock into the variable-length subframe collector. */
class Mk2aChannel implements ChannelDecoder {
  readonly name = 'LMS6-1680';
  private readonly clock: SymbolClock;
  private readonly coll: Mk2aCollector;
  constructor(rate: number, sink: SondeSink) {
    this.coll = new Mk2aCollector(sink);
    this.clock = new SymbolClock(MK2A_BAUD, rate, s => { this.coll.symbol(s); this.clock.hold = this.coll.collecting; });
  }
  push(x: number): void { this.clock.push(x); }
}

function emit(sink: SondeSink, f: SondeFrame | null): void { if (f && f.serial) sink(f); }

export function makeBankB(rate: number, sink: SondeSink): ChannelDecoder[] {
  const rs92 = new Rs92Decoder(), mrz = new MrzDecoder(), lms6 = new Lms6Decoder(), lmsx = new LmsxDecoder();
  // LMS6-403 blocks follow each other without a gap: a frame may straddle two of them
  const period = LMS6_BLOCK * 16 / LMS6_BAUD * rate;
  let lastBlock = -1e12;
  return [
    new SoftFramer('RS92', RS92_BAUD, rate, RS92_HEADER, RS92_SYMS, 3, s => emit(sink, rs92.decode(s))),
    new SoftFramer('LMS6', LMS6_BAUD, rate, LMS6_HEADER, LMS6_SYMS, 8, (s, at) => {
      const contiguous = Math.abs(at - lastBlock - period) < 0.05 * period;
      lastBlock = at;
      for (const f of lms6.decode(s, contiguous)) emit(sink, f);
    }),
    new SoftFramer('LMSX', LMSX_BAUD, rate, LMS6_HEADER, LMSX_SYMS, 8, s => emit(sink, lmsx.decode(s))),
    new Mk2aChannel(rate, sink),
    new SoftFramer('MRZ', MRZ_BAUD, rate, MRZ_HEADER, MRZ_SYMS, 2, s => emit(sink, mrz.decode(s))),
  ];
}
