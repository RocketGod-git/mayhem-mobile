/**
 * Sub-audible squelch decoders fed with the NFM discriminator output.
 *  - CTCSS: the 50 EIA tones, a Goertzel bank on 0.5 s blocks at 4 kHz (2 Hz bins resolve the 2.3 Hz spacing at
 *    the bottom of the table); a tone is reported when it beats the runner-up by 6 dB.
 *  - DCS: 134.4 bit/s Golay(23,12) words; the stream is cyclic so any 23-bit window is a codeword — the fixed
 *    "100" field in bits 9..11 picks the alignment, the 9 low bits are the octal code. Both polarities are tried
 *    (inverted DCS shows up as the complementary bitstream).
 */
import { Goertzel } from './filters.js';

export const CTCSS_TONES = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8,
  123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8,
  196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];

/** The standard DCS code set (octal). */
export const DCS_CODES = [23, 25, 26, 31, 32, 36, 43, 47, 51, 53, 54, 65, 71, 72, 73, 74, 114, 115, 116, 122, 125, 131, 132, 134, 143, 145, 152,
  155, 156, 162, 165, 172, 174, 205, 212, 223, 225, 226, 243, 244, 245, 246, 251, 252, 255, 261, 263, 265, 266, 271, 274, 306, 311, 315, 325,
  331, 332, 343, 346, 351, 356, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 446, 452, 454, 455, 462, 464, 465, 466, 503, 506, 516, 523,
  526, 532, 546, 565, 606, 612, 624, 627, 631, 632, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754];
const DCS_SET = new Set(DCS_CODES.map(c => parseInt(String(c), 8)));

const SUB_RATE = 4000;

export class SubAudioDecoder {
  tone = 0;          // detected CTCSS tone in Hz, 0 = none
  toneDb = 0;        // margin over the runner-up
  dcs = 0;           // detected DCS code (octal number as in the table), 0 = none
  dcsInverted = false;
  private readonly bank: Goertzel[];
  private readonly power = new Float32Array(CTCSS_TONES.length);
  private acc = 0; private accN = 0; private decim: number;
  private lp = 0;
  private dc = 0;
  private toneMiss = 0;
  // DCS bit sync
  private bitPhase = 0; private readonly bitLen = SUB_RATE / 134.4;
  private lastSign = false;
  private word = 0; private wordBits = 0;
  private lastCode = 0; private codeRun = 0; private dcsMiss = 0;
  constructor(inRate: number) {
    this.decim = Math.max(1, Math.round(inRate / SUB_RATE));
    this.bank = CTCSS_TONES.map(f => new Goertzel(f, SUB_RATE, SUB_RATE / 2));
  }
  reset(rate: number): void {
    this.decim = Math.max(1, Math.round(rate / SUB_RATE));
    this.tone = 0; this.dcs = 0; this.acc = 0; this.accN = 0; this.lp = 0; this.dc = 0; this.word = 0; this.wordBits = 0; this.codeRun = 0; this.lastCode = 0;
  }
  /** Feed discriminator samples (any scale). */
  push(fm: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      this.acc += fm[i];
      if (++this.accN >= this.decim) {
        const x = this.acc / this.accN; this.acc = 0; this.accN = 0;
        this.sub(x);
      }
    }
  }
  private sub(x: number): void {
    // 300 Hz-ish one-pole low-pass keeps voice out of the tone detectors
    this.lp += 0.35 * (x - this.lp);
    const s = this.lp;
    // CTCSS bank
    let done = false;
    for (let k = 0; k < this.bank.length; k++) { const p = this.bank[k].push(s); if (p >= 0) { this.power[k] = p; done = true; } }
    if (done) {
      let best = 0, second = 0, bi = -1;
      for (let k = 0; k < this.power.length; k++) { const p = this.power[k]; if (p > best) { second = best; best = p; bi = k; } else if (p > second) second = p; }
      const margin = 10 * Math.log10((best + 1e-12) / (second + 1e-12));
      if (bi >= 0 && margin > 6) { this.tone = CTCSS_TONES[bi]; this.toneDb = margin; this.toneMiss = 0; }
      else if (++this.toneMiss >= 2) { this.tone = 0; this.toneDb = 0; }
    }
    // DCS: slow DC tracker, slicer, 134.4 baud clock pulled by zero crossings
    this.dc += 0.002 * (s - this.dc);
    const sign = s - this.dc > 0;
    if (sign !== this.lastSign) { this.bitPhase = this.bitPhase < this.bitLen / 2 ? this.bitPhase * 0.7 : this.bitPhase + (this.bitLen - this.bitPhase) * 0.3; this.lastSign = sign; }
    this.bitPhase += 1;
    if (this.bitPhase >= this.bitLen) {
      this.bitPhase -= this.bitLen;
      this.bit(sign ? 1 : 0);
    }
  }
  private bit(b: number): void {
    this.word = ((this.word << 1) | b) & 0x7FFFFF; if (this.wordBits < 23) { this.wordBits++; return; }
    const code = SubAudioDecoder.decodeWord(this.word);
    const found = code ?? SubAudioDecoder.decodeWord(~this.word & 0x7FFFFF);
    if (found) {
      const inv = code === null;
      if (found === this.lastCode) { if (++this.codeRun >= 3) { this.dcs = found; this.dcsInverted = inv; this.dcsMiss = 0; } }
      else { this.lastCode = found; this.codeRun = 1; }
    } else if (++this.dcsMiss > 23 * 4) { this.dcs = 0; this.lastCode = 0; this.codeRun = 0; this.dcsMiss = 0; }
  }
  /** Try the 23 rotations of a window; return the octal code when one has the 100 marker, a zero Golay syndrome
   *  and is in the standard set. */
  static decodeWord(w: number): number | null {
    for (let r = 0; r < 23; r++) {
      const x = ((w >>> r) | (w << (23 - r))) & 0x7FFFFF;
      if (((x >>> 9) & 7) !== 4) continue;
      if (golaySyndrome(x) !== 0) continue;
      const code = x & 0x1FF;
      if (DCS_SET.has(code)) return parseInt(code.toString(8), 10);
    }
    return null;
  }
}

/** Golay(23,12) syndrome via polynomial division by x^11+x^10+x^6+x^5+x^4+x^2+1 (0xC75). Codewords give 0. */
function golaySyndrome(x: number): number {
  let v = x;
  for (let i = 22; i >= 11; i--) if (v & (1 << i)) v ^= 0xC75 << (i - 11);
  return v & 0x7FF;
}
