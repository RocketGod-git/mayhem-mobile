/**
 * FLEX pager decoder — port of Mayhem's proc_flex.cpp (multimon-ng lineage): 1600/3200/6400 bps, 2- and 4-level
 * FSK, sync + FIW + block-interleaved BCH(32,21) phases, BIW / address / vector parsing for alphanumeric, numeric
 * (standard, special, numbered), short-message, tone, hex and instruction pages. Rides on the NFM discriminator.
 *
 * Message layout follows ARIB STD-43A, the published FLEX standard (section numbers below are its): pages split
 * across frames are joined by message number, each page's checksum K is checked, and a page sent more than once is
 * combined word by word. Words the check cannot fix are tried again with the bits the receiver was least sure of.
 */
import { popcount32, type Emit, type IqProcessor } from './core.js';

const DC_OFFSET_FILTER = 0.010, PHASE_LOCKED_RATE = 0.045, PHASE_UNLOCKED_RATE = 0.050, LOCK_LEN = 24, IDLE_THRESHOLD = 0, DEMOD_TIMEOUT = 100;
const FLEX_SYNC_MARKER = 0xA6C6AAAA, SLICE_THRESHOLD = 0.667;
const FLEX_BCD = '0123456789.U -][';
const MASK64 = (1n << 64n) - 1n;
const LOCK_MASK = (1n << BigInt(2 * LOCK_LEN)) - 1n;
const LOCK_PATTERN = 0x6666666666666666n;
const TYPE_NAMES = ['SEC', 'INS', 'TONE', 'NUM', 'SNUM', 'ALN', 'HEX', 'NNUM', 'SHORT', 'BIW'];
const ADDR_NAMES = ['', 'long', 'temp', 'oper', 'net', 'info', 'rsvd', 'unk'];
/** A bit decided closer to its line than this (of a clean symbol's distance) may be wrong: an erasure. */
const WEAK = 0.45;
/** How long a split page waits for its next piece, and a page is kept for a repeat: 128 frames, 4 minutes. */
const HOLD_S = 240;
/** [fix] for a word soft decoding brought back: as uncertain as a two-bit fix. */
const SOFT = 3;
/** A character slot of a lost word. */
const LOST = -2;
/** The end of a page whose last fragment never came; where a fragment is missing inside a page. */
const CUT = ' …', GAP = '<…>';
/** The three bit groups of a 21-bit word (0-7, 8-15, 16-20) that FLEX's message checksums add up. */
const groups = (d: number) => (d & 0xFF) + ((d >>> 8) & 0xFF) + ((d >>> 16) & 0x1F);
/** An address word that opens a long (two-word) address: LA1 or LA2 (LA3 and LA4 only ever come second). */
const isLong = (aw: number) => (aw >= 1 && aw <= 0x8000) || (aw >= 0x1F7FFF && aw <= 0x1FFFFE);
/** A long address's capcode from its two words (ARIB STD-43A Table 3.8.2.2-1), or -1. */
function longCapcode(aw1: number, aw2: number): number {
  if (aw1 >= 1 && aw1 <= 0x8000 && aw2 >= 0x1F7FFF && aw2 <= 0x1FFFFE) return aw1 + (0x1FFFFF - aw2) * 32768 + 2068480;
  if (aw1 >= 1 && aw1 <= 0x8000 && aw2 >= 0x1E0001 && aw2 <= 0x1F0000) return aw1 + (aw2 - 1933312) * 32768 + 2068480;
  if (aw1 >= 0x1F7FFF && aw1 <= 0x1FFFFE && aw2 >= 0x1E0001 && aw2 <= 0x1F0000) return (aw1 - 2064383) + (aw2 - 1867776) * 32768 + 2068479;
  return -1;
}
/** Characters to text: ETX and NUL are fill (dropped at the end, '?' between); a lost word's slots are '?'. Spaces at
 *  the end are kept: a fragment may end in one. */
function render(chars: number[]): string {
  let end = chars.length - 1;
  while (end >= 0 && (chars[end] === 0x03 || chars[end] === 0x00)) end--;
  let s = '';
  for (let k = 0; k <= end; k++) { const c = chars[k]; s += c >= 0x20 || c === 0x0A || c === 0x0D ? String.fromCharCode(c) : '?'; }
  return s;
}
interface Stream { head: string; page: Record<string, unknown>; cap: number; text: string; errors: number; words: number; lostWords: number; expectF: number; at: number }
/** Page kinds by FLEX type (8 is the short message vector's tone or numeric). */
const KIND: Record<number, string> = { 0: 'SECURE', 1: 'INSTR', 2: 'TONE', 3: 'NUM', 4: 'NUM', 5: 'ALPHA', 6: 'BIN', 7: 'NUM', 8: 'TONE' };
interface SeenPage { cap: number; type: number; n: number; words: number[]; gone: boolean[]; at: number; line: string }

/*
 * BCH(31,21) plus an even parity bit, as received MSB first: bits 31..11 carry the 21 data bits, 10..1 the check
 * bits, bit 0 parity over all 32. Up to two bit errors are corrected; a parity miss on top of a two-bit fix means
 * three errors, which is refused rather than risking a miscorrected word.
 */
const BCH_GEN = 0x769;   // x^10 + x^9 + x^8 + x^6 + x^5 + x^3 + 1
function bchRem(v31: number): number {
  let r = v31 >>> 0;
  for (let bit = 30; bit >= 10; bit--) if ((r >>> bit) & 1) r = (r ^ (BCH_GEN << (bit - 10))) >>> 0;
  return r & 0x3FF;
}
const BCH_FIX = (() => {
  const t = new Int32Array(1024).fill(-1);
  t[0] = 0;
  for (let i = 1; i <= 31; i++) t[bchRem((1 << i) >>> 1)] = 1 << i;
  for (let i = 1; i <= 31; i++) for (let j = i + 1; j <= 31; j++) {
    const e = (1 << i) | (1 << j), s = bchRem(e >>> 1);
    if (t[s] === -1) t[s] = e;
  }
  return t;
})();
/** The corrected word, or null when it holds more errors than the code can fix. */
export function bchCorrect(w: number): number | null {
  const e = BCH_FIX[bchRem(w >>> 1)];
  if (e === -1) return null;
  const c = (w ^ e) | 0;
  if ((popcount32(c) & 1) === 0) return c;
  return popcount32(e) >= 2 ? null : (c ^ 1) | 0;   // the parity bit itself was the error
}
/** A full codeword (check bits + parity) for 21 data bits: the encoder side, for tests. */
export function bchEncode(data21: number): number {
  const m = ((data21 & 0x1FFFFF) << 10) >>> 0;
  const w = ((m | bchRem(m)) << 1) | 0;
  return (w | (popcount32(w) & 1)) | 0;
}
/** Words whose four-bit nibbles (plus the top bit) sum to 0xF: the FIW and vector checksum. */
const checksumOk = (d: number) => (((d & 0xF) + ((d >>> 4) & 0xF) + ((d >>> 8) & 0xF) + ((d >>> 12) & 0xF) + ((d >>> 16) & 0xF) + ((d >>> 20) & 1)) & 0xF) === 0xF;

const enum St { SYNC1, FIW, SYNC2, DATA }
const enum PT { SECURE, SHORT_INSTRUCTION, TONE, STANDARD_NUMERIC, SPECIAL_NUMERIC, ALPHANUMERIC, BINARY, NUMBERED_NUMERIC }

function bitReverse32(x: number): number {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0F0F0F0F) | ((x & 0x0F0F0F0F) << 4);
  x = ((x >>> 8) & 0x00FF00FF) | ((x & 0x00FF00FF) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}
const hex = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

export class FlexDecoder implements IqProcessor {
  readonly wantsFm = true;
  private fmRate = 0;
  // demodulator
  private sampleFreq = 24000; private sampleLast = 0; private locked = 0; private phase = 0;
  private envelopeSum = 0; private envelopeCount = 0; private lockBuf = 0n; private readonly symcount = [0, 0, 0, 0];
  private timeout = 0; private nonconsec = 0; private baud = 1600;
  private envelope = 0; private zero = 0;
  /** The current symbol's mean level, for how sure its bits are. */
  private symSum = 0; private symN = 0;
  // state
  private st = St.SYNC1; private sync2Count = 0; private dataCount = 0; private fiwCount = 0;
  private sync2Shift = 0; private sync2CPos = -1; private sync2CinvPos = -1;
  private syncBaud = 0; private syncLevels = 0; private polarity = 0; private syncBuf = 0n;
  private fiwRaw = 0; private cycleNo = 0; private frameNo = 0;
  private readonly ph = [new Uint32Array(88), new Uint32Array(88), new Uint32Array(88), new Uint32Array(88)];
  private readonly idle = [0, 0, 0, 0];
  /** How sure each received bit is, 0 (on the decision line) to 1 (a clean symbol): word × 32, MSB-first index. */
  private readonly sure = [new Float32Array(88 * 32), new Float32Array(88 * 32), new Float32Array(88 * 32), new Float32Array(88 * 32)];
  private readonly got = [new Uint8Array(88), new Uint8Array(88), new Uint8Array(88), new Uint8Array(88)];
  /** The current phase's words: how many bits the check fixed (0-2), [SOFT] if soft decoding brought it back. */
  private fix = new Uint8Array(88);
  /** Seconds of signal heard: the clock a split page's hold and a repeat's window run on. */
  private heardS = 0;
  /** Words the plain check could not fix that soft decoding brought back (for tests and the log). */
  recovered = 0;
  /** Pages arriving in fragments, by capcode, type and message number N (Section 3.10.1.3). */
  private readonly streams = new Map<string, Stream>();
  /** Whole pages heard lately, word by word, so another transmission can fill words a copy lost. */
  private seen: SeenPage[] = [];
  private phaseToggle = 0; private dataBitCounter = 0;
  // decode
  private capcode = 0; private phaseNo = 'A'; private addrType = 0; private isPriority = 0;
  private frames = 0; private lastStat = 0;

  constructor(private readonly emit: Emit) {}
  reset(): void { this.fmRate = 0; this.locked = 0; this.st = St.SYNC1; }
  onIq(): void {}

  onFm(samples: Float32Array, n: number, rate: number): void {
    this.heardS += n / rate;
    if (rate !== this.fmRate) { this.fmRate = rate; this.sampleFreq = rate; this.locked = 0; this.st = St.SYNC1; this.zero = 0; this.phase = 0; }
    for (let i = 0; i < n; i++) this.demodulate(samples[i]);
    const now = performance.now();
    if (now - this.lastStat > 5000 && this.frames) { this.lastStat = now; this.emit({ type: 'log', line: `FLEX: ${this.frames} frames decoded, locked=${this.locked}` }); }
  }

  private demodulate(sample: number): void {
    if (this.buildSymbol(sample) !== 1) return;
    this.nonconsec = 0;
    let decmax = 0, modal = 0;
    for (let j = 0; j < 4; j++) if (this.symcount[j] > decmax) { modal = j; decmax = this.symcount[j]; }
    this.symcount[0] = this.symcount[1] = this.symcount[2] = this.symcount[3] = 0;
    const level = this.symN ? this.symSum / this.symN : 0;
    this.symSum = 0; this.symN = 0;
    if (this.locked) this.flexSym(modal, level);
    else {
      this.lockBuf = ((this.lockBuf << 2n) | BigInt(modal ^ 1)) & MASK64;
      const pat = this.lockBuf ^ LOCK_PATTERN;
      if ((pat & LOCK_MASK) === 0n || ((~pat) & LOCK_MASK) === 0n) { this.locked = 1; this.lockBuf = 0n; }
    }
    if (++this.timeout > DEMOD_TIMEOUT) this.locked = 0;
  }

  private buildSymbol(sampleIn: number): number {
    const phaseMax = 100 * this.sampleFreq;
    const phaseRate = 100 * this.baud;
    const pct = 100 * this.phase / phaseMax;
    let sample = sampleIn;
    if (this.st === St.SYNC1) { const k = this.sampleFreq * DC_OFFSET_FILTER; this.zero = (this.zero * k + sample) / (k + 1); }
    sample -= this.zero;
    if (this.locked) {
      if (this.st === St.SYNC1) { this.envelopeSum += Math.abs(sample); this.envelopeCount++; this.envelope = this.envelopeSum / this.envelopeCount; }
    } else {
      this.envelope = 0; this.envelopeSum = 0; this.envelopeCount = 0; this.baud = 1600; this.timeout = 0; this.nonconsec = 0; this.st = St.SYNC1;
    }
    if (pct > 10 && pct < 90) {
      this.symSum += sample; this.symN++;
      if (sample > 0) { if (sample > this.envelope * SLICE_THRESHOLD) this.symcount[3]++; else this.symcount[2]++; }
      else { if (sample < -this.envelope * SLICE_THRESHOLD) this.symcount[0]++; else this.symcount[1]++; }
    }
    if ((this.sampleLast < 0 && sample >= 0) || (this.sampleLast >= 0 && sample < 0)) {
      const err = pct < 50 ? this.phase : this.phase - phaseMax;
      this.phase -= err * (this.locked ? PHASE_LOCKED_RATE : PHASE_UNLOCKED_RATE);
      if (pct > 10 && pct < 90) { if (++this.nonconsec > 20 && this.locked) this.locked = 0; } else this.nonconsec = 0;
      this.timeout = 0;
    }
    this.sampleLast = sample;
    this.phase += phaseRate;
    if (this.phase > phaseMax) { this.phase -= phaseMax; return 1; }
    return 0;
  }

  private syncCheck(buf: bigint): number {
    const marker = Number((buf >> 16n) & 0xFFFFFFFFn);
    const codehigh = Number((buf >> 48n) & 0xFFFFn);
    const codelow = (~Number(buf & 0xFFFFn)) & 0xFFFF;
    return popcount32((marker ^ FLEX_SYNC_MARKER) >>> 0) < 4 && popcount32(codelow ^ codehigh) < 4 ? codehigh : 0;
  }
  private flexSync(sym: number): number {
    this.syncBuf = ((this.syncBuf << 1n) | BigInt(sym < 2 ? 1 : 0)) & MASK64;
    let r = this.syncCheck(this.syncBuf);
    if (r) { this.polarity = 0; return r; }
    r = this.syncCheck((~this.syncBuf) & MASK64);
    if (r) this.polarity = 1;
    return r;
  }
  private decodeMode(code: number): void {
    const modes: [number, number, number][] = [[0x870C, 1600, 2], [0xB068, 1600, 4], [0x7B18, 3200, 2], [0xDEA0, 3200, 4], [0x4C7C, 3200, 4]];
    for (const [s, b, l] of modes) if (popcount32(s ^ code) < 4) { this.syncBaud = b; this.syncLevels = l; return; }
    this.syncBaud = 1600; this.syncLevels = 2;
  }
  private decodeFiw(): boolean {
    const c = bchCorrect(bitReverse32(this.fiwRaw) | 0);
    if (c === null) return false;
    const f = bitReverse32(c >>> 0);
    if (checksumOk(f & 0x1FFFFF)) this.emit({ type: 'sync', protocol: 'FLEX', rate: String(this.syncBaud * (this.syncLevels === 4 ? 2 : 1)) });
    this.cycleNo = (f >>> 4) & 0xF; this.frameNo = (f >>> 8) & 0x7F;
    let cs = (f & 0xF) + ((f >>> 4) & 0xF) + ((f >>> 8) & 0xF) + ((f >>> 12) & 0xF) + ((f >>> 16) & 0xF) + ((f >>> 20) & 1);
    return (cs & 0xF) === 0xF;
  }

  private readData(sym: number, sa: number, sb: number): boolean {
    const bitA = sym > 1 ? 1 : 0;
    const bitB = this.syncLevels === 4 && (sym === 1 || sym === 2) ? 1 : 0;
    if (this.syncBaud === 1600) this.phaseToggle = 0;
    const idx = ((this.dataBitCounter >>> 5) & 0xFFF8) | (this.dataBitCounter & 7);
    if (idx >= 88) return false;
    const [A, B, C, D] = this.ph;
    if (this.phaseToggle === 0) {
      A[idx] = (A[idx] >>> 1) | (bitA ? 0x80000000 : 0);
      B[idx] = (B[idx] >>> 1) | (bitB ? 0x80000000 : 0);
      this.note(0, idx, sa); this.note(1, idx, sb);
      this.phaseToggle = 1;
      if ((this.dataBitCounter & 0xFF) === 0xFF) {
        if (A[idx] === 0 || A[idx] === 0xFFFFFFFF) this.idle[0]++;
        if (B[idx] === 0 || B[idx] === 0xFFFFFFFF) this.idle[1]++;
      }
    } else {
      C[idx] = (C[idx] >>> 1) | (bitA ? 0x80000000 : 0);
      D[idx] = (D[idx] >>> 1) | (bitB ? 0x80000000 : 0);
      this.note(2, idx, sa); this.note(3, idx, sb);
      this.phaseToggle = 0;
      if ((this.dataBitCounter & 0xFF) === 0xFF) {
        if (C[idx] === 0 || C[idx] === 0xFFFFFFFF) this.idle[2]++;
        if (D[idx] === 0 || D[idx] === 0xFFFFFFFF) this.idle[3]++;
      }
    }
    if (this.syncBaud === 1600 || this.phaseToggle === 0) this.dataBitCounter++;
    const t = IDLE_THRESHOLD, id = this.idle;
    if (this.syncBaud === 1600) return this.syncLevels === 2 ? id[0] > t : (id[0] > t && id[1] > t);
    return this.syncLevels === 2 ? (id[0] > t && id[2] > t) : (id[0] > t && id[1] > t && id[2] > t && id[3] > t);
  }

  /** Bits come in first-sent at the top once the word is reversed for the check: the k-th is bit 31 - k. */
  private note(phase: number, idx: number, conf: number): void {
    const k = this.got[phase][idx]++;
    if (k < 32) this.sure[phase][idx * 32 + 31 - k] = conf;
  }

  /**
   * A word the BCH check gave up on, decoded again with what the receiver knew about each bit. The least sure bits
   * (up to five, each under [WEAK]) are treated as erasures: every way of flipping them is tried, and a flip that
   * lands within BCH reach of a codeword is kept if the errors outside those bits stay inside what the code can
   * still guarantee with that many erasures (2 errors + erasures < 6, the distance of BCH(31,21) with parity).
   * Inside that bound the answer is unique, so this recovers words lost in a fade without inventing any from noise,
   * which the plain check cannot tell apart. The cheapest answer (least total sureness flipped) wins.
   */
  private recover(raw: number, conf: Float32Array, base: number): number | null {
    const weak: number[] = [];
    for (let b = 0; b < 32; b++) if (conf[base + b] < WEAK) weak.push(b);
    weak.sort((x, y) => conf[base + x] - conf[base + y]);
    weak.length = Math.min(weak.length, 5);
    if (!weak.length) return null;
    let best: number | null = null, bestCost = Infinity;
    for (let m = 1; m < (1 << weak.length); m++) {
      let flip = 0, cost = 0;
      for (let j = 0; j < weak.length; j++) if ((m >>> j) & 1) { flip |= 1 << weak[j]; cost += conf[base + weak[j]]; }
      const c = bchCorrect((raw ^ flip) | 0);
      if (c === null) continue;
      let outside = c ^ raw ^ flip;
      for (const b of weak) outside &= ~(1 << b);
      const extra = popcount32(outside);
      if (2 * extra + weak.length >= 6) continue;
      for (let b = 0; b < 32; b++) if ((outside >>> b) & 1) cost += conf[base + b];
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return best;
  }

  private flexSym(sym: number, level = 0): void {
    const rect = this.polarity ? 3 - sym : sym;
    switch (this.st) {
      case St.SYNC1: {
        const code = this.flexSync(sym);
        if (code) { this.decodeMode(code); this.st = St.FIW; } else this.st = St.SYNC1;
        this.fiwCount = 0; this.fiwRaw = 0;
        break;
      }
      case St.FIW: {
        this.fiwCount++;
        if (this.fiwCount >= 16) this.fiwRaw = ((this.fiwRaw >>> 1) | (rect > 1 ? 0x80000000 : 0)) >>> 0;
        if (this.fiwCount === 48) {
          if (this.decodeFiw()) { this.sync2Count = 0; this.sync2Shift = 0; this.sync2CPos = -1; this.sync2CinvPos = -1; this.baud = this.syncBaud; this.st = St.SYNC2; }
          else this.st = St.SYNC1;
        }
        break;
      }
      case St.SYNC2: {
        const bitA = rect > 1 ? 1 : 0;
        this.sync2Shift = ((this.sync2Shift << 1) | bitA) & 0xFFFF;
        this.sync2Count++;
        if (this.sync2Count >= 16) {
          if (popcount32(this.sync2Shift ^ 0xED84) <= 2 && this.sync2CPos < 0) this.sync2CPos = this.sync2Count;
          if (popcount32(this.sync2Shift ^ 0x127B) <= 2 && this.sync2CinvPos < 0) this.sync2CinvPos = this.sync2Count;
        }
        const nominal = Math.floor(this.syncBaud * 25 / 1000);
        let end = nominal;
        if (this.sync2CinvPos > 0) { const diff = this.sync2CinvPos - nominal; if (diff >= -1 && diff <= 1) end = this.sync2CinvPos; }
        if (this.sync2Count === end) {
          for (const p of this.ph) p.fill(0);
          for (const g of this.got) g.fill(0);
          this.idle.fill(0); this.phaseToggle = 0; this.dataBitCounter = 0; this.dataCount = 0;
          this.sync2Shift = 0; this.sync2CPos = -1; this.sync2CinvPos = -1;
          this.st = St.DATA;
        }
        if (this.sync2Count > nominal + 1) { this.sync2Shift = 0; this.sync2CPos = -1; this.sync2CinvPos = -1; this.st = St.SYNC1; }
        break;
      }
      case St.DATA: {
        // how far each bit's decision sat from its line, in units of a clean symbol's distance
        const env = Math.max(this.envelope, 1e-9), a = Math.abs(level);
        let sa: number, sb: number;
        if (this.syncLevels === 4) { const unit = env / 3; sa = Math.min(1, a / unit); sb = Math.min(1, Math.abs(a - env * SLICE_THRESHOLD) / unit); }
        else { sa = Math.min(1, a / env); sb = 1; }
        const idle = this.readData(rect, sa, sb);
        if (++this.dataCount === Math.floor(this.syncBaud * 1760 / 1000) || idle) {
          this.decodeData();
          this.baud = 1600; this.st = St.SYNC1; this.dataCount = 0;
        }
        break;
      }
    }
  }

  private decodeData(): void {
    this.frames++;
    if (this.syncBaud === 1600) { this.decodePhase(0); if (this.syncLevels === 4) this.decodePhase(1); }
    else if (this.syncLevels === 2) { this.decodePhase(0); this.decodePhase(2); }
    else for (let p = 0; p < 4; p++) this.decodePhase(p);
    // A split page whose remaining fragments never came within the hold time: what arrived, marked as unfinished.
    for (const [key, s] of this.streams) if (this.heardS - s.at > HOLD_S) { this.streams.delete(key); this.finish(s, CUT, false); }
    this.seen = this.seen.filter(e => this.heardS - e.at <= HOLD_S);
  }

  /** The line's start: rate, cycle and frame, capcode and its flags, the page type. */
  private head(type: number): string {
    const bitrate = this.syncBaud * (this.syncLevels === 4 ? 2 : 1);
    const cap = String(this.capcode).padStart(10, '0');
    const at = ADDR_NAMES[this.addrType] ? ` ${ADDR_NAMES[this.addrType]}` : '';
    const pri = this.isPriority ? ' PRI' : '';
    return `FLEX ${bitrate}/${this.syncLevels}L C${this.cycleNo}F${String(this.frameNo).padStart(3, '0')} CAP ${cap}${at}${pri} ${TYPE_NAMES[type]}`;
  }
  private static line(head: string, text: string, errors: number): string { return `${head}${errors ? ' PARTIAL' : ''}${text ? ': ' + text : ''}`; }
  /** The page as the hunter's feed takes it. */
  private pageOf(type: number, text: string, errors: number) {
    return { protocol: 'FLEX', rate: String(this.syncBaud * (this.syncLevels === 4 ? 2 : 1)), cap: this.capcode, kind: KIND[type] ?? 'DATA', text, errors, where: `C${this.cycleNo}F${String(this.frameNo).padStart(3, '0')} ${this.phaseNo}` };
  }
  /** [errors]: message words lost (or 1 when the page could not be confirmed whole). A page with nothing readable is
   *  noise: logged, and sent only to the hunter, which counts it. */
  private packet(type: number, message: string, errors = 0, replaces?: string): string | undefined {
    if (errors > 0 && !message.trim()) {
      this.emit({ type: 'log', line: `FLEX CAP ${this.capcode}: unreadable page, ${errors} word${errors === 1 ? '' : 's'} lost` });
      this.emit({ type: 'pagerNoise', page: this.pageOf(type, '', errors) });
      return undefined;
    }
    const line = FlexDecoder.line(this.head(type), message, errors), page = this.pageOf(type, message, errors);
    this.emit(replaces ? { type: 'packet', line, replaces, page } : { type: 'packet', line, page });
    return line;
  }

  private decodePhase(pi: number): void {
    const p = this.ph[pi];
    const phaseNo = this.phaseNo = 'ABCD'[pi];
    let allIdle = true;
    for (let i = 0; i < 88; i++) if (p[i] !== 0xFFFFFFFF && p[i] !== 0) { allIdle = false; break; }
    if (allIdle) return;
    const bad = new Uint8Array(88), fix = new Uint8Array(88), conf = this.sure[pi];
    for (let i = 0; i < 88; i++) {
      const raw = bitReverse32(p[i]) | 0;
      let c = bchCorrect(raw);
      if (c !== null) fix[i] = popcount32(raw ^ c);
      else {
        // past what the check fixes on its own: try again with the bits it was least sure of
        c = this.recover(raw, conf, i * 32);
        if (c !== null) { fix[i] = SOFT; this.recovered++; } else bad[i] = 1;
      }
      p[i] = c === null ? 0 : bitReverse32(c >>> 0) & 0x001FFFFF;
    }
    this.fix = fix;
    if (bad[0]) return;
    const biw = p[0];
    if (biw === 0 || biw === 0x001FFFFF || !checksumOk(biw)) return;
    const voffset = (biw >>> 10) & 0x3f;
    const aoffset = ((biw >>> 8) & 3) + 1;
    const prioCount = (biw >>> 4) & 0xF;
    if (voffset <= aoffset || voffset >= 88) return;
    for (let bw = 1; bw < aoffset && bw < 88; bw++) {
      if (bad[bw]) continue;
      const w = p[bw], bt = (w >>> 4) & 7;
      if (bt === 1) this.emit({ type: 'log', line: `FLEX system date ${((w >>> 7) & 0x1F) + 1994}-${String((w >>> 17) & 0xF).padStart(2, '0')}-${String((w >>> 12) & 0x1F).padStart(2, '0')} (phase ${phaseNo})` });
      else if (bt === 2) this.emit({ type: 'log', line: `FLEX system time ${String((w >>> 7) & 0x1F).padStart(2, '0')}:${String((w >>> 12) & 0x3F).padStart(2, '0')} (phase ${phaseNo})` });
    }
    // Vectors pair with addresses in order; an address with no vector (past the last valid one) is tone only.
    let validVecs = 0;
    for (let k = 0; k < voffset - aoffset; k++) { const wi = voffset + k; if (wi < 88 && !bad[wi] && checksumOk(p[wi])) validVecs = k + 1; }
    let vec = 0;
    for (let i = aoffset; i < voffset;) {
      const aw = p[i];
      // a long address takes two address words and two vector words, whether or not this one can be read
      const long = isLong(aw);
      const j = voffset + vec;
      vec += long ? 2 : 1;
      const next = i + (long ? 2 : 1);
      const at = i; i = next;
      if (bad[at] || aw === 0 || aw === 0x001FFFFF) continue;
      this.isPriority = at - aoffset < prioCount ? 1 : 0;
      this.parseCapcode(aw);
      if (long) {
        if (at + 1 >= voffset || bad[at + 1]) continue;
        const cap = longCapcode(aw, p[at + 1]);
        if (cap <= 0) continue;
        this.capcode = cap;
      }
      if (this.capcode <= 0 || this.capcode > 4297068542) continue;
      if (j - voffset >= validVecs || j >= 88) { if (!long && this.capcode !== 1) this.packet(2, ''); continue; }
      if (bad[j] || (long && (j + 1 >= 88 || bad[j + 1]))) continue;
      this.page(p, bad, j, long);
    }
  }

  private page(p: Uint32Array, bad: Uint8Array, j: number, long: boolean): void {
    const viw = p[j];
    const type = (viw >>> 4) & 7;
    const b = (viw >>> 7) & 0x7F;
    if (type === PT.ALPHANUMERIC || type === PT.SECURE || type === PT.BINARY) {
      // Section 3.9: n counts the message's words, its header included. A short address's header is the first
      // message word; a long address carries it in its second vector word instead.
      let len = (viw >>> 14) & 0x7F;
      let hdr: number, mw = b;
      if (long) hdr = j + 1; else { hdr = b; mw = b + 1; }
      if (len >= 1) len--;
      if (b === 0 || hdr >= 88 || mw > 88) return;
      if (mw + len > 88) len = 88 - mw;
      const secureData = type === PT.SECURE && !bad[hdr] && ((p[hdr] >>> 19) & 3) !== 0;
      if (type === PT.BINARY || secureData) this.binary(p, bad, hdr, mw, len, type);
      else this.alpha(p, bad, hdr, mw, len, type);
    } else if (type === PT.STANDARD_NUMERIC || type === PT.SPECIAL_NUMERIC || type === PT.NUMBERED_NUMERIC) {
      const r = this.numeric(p, bad, j, type === PT.NUMBERED_NUMERIC, long);
      if (r) this.packet(type === PT.SPECIAL_NUMERIC ? 4 : type === PT.NUMBERED_NUMERIC ? 7 : 3, r.text, r.errors);
    } else if (type === PT.TONE) {
      const t = (viw >>> 7) & 3, d = (viw >>> 9) & 0xFFF;
      // the short message vector (3.9.6), as the Android app shows it: a tone, a few digits, or the tone's source
      if (t === 0 && d === 0xCCC && (!long || j + 1 >= 88 || (p[j + 1] & 0xFFFFF) === 0xCCCCC)) this.packet(2, '');
      else if (t === 0) {
        let digits = FLEX_BCD[d & 0xF] + FLEX_BCD[(d >>> 4) & 0xF] + FLEX_BCD[(d >>> 8) & 0xF];
        if (long && j + 1 < 88 && !bad[j + 1]) { const vy = p[j + 1]; for (let s = 0; s < 20; s += 4) digits += FLEX_BCD[(vy >>> s) & 0xF]; }
        this.packet(3, digits.trim());
      } else if (t === 1) this.packet(8, `SRC ${d & 7}`);
      else if (t === 2) this.packet(8, `SRC ${d & 7} N=${(d >>> 3) & 0x3F} R=${(d >>> 9) & 1}`);
      else this.packet(8, `RESERVED ${hex(d, 3)}`);
    } else if (type === PT.SHORT_INSTRUCTION) {
      const d = (viw >>> 7) & 0x3FFF, it = d & 7;
      this.packet(1, it === 0 ? `i=temp|slot=${(d >>> 10) & 0xF}|target=${(d >>> 3) & 0x7F}` : it === 1 ? `i=event|flags=${hex((d >>> 3) & 0x7FF, 3)}` : `i=rsvd|type=${it}|raw=${hex(d, 4)}`);
    }
  }

  /**
   * An alphanumeric (or secure text) page, per Section 3.10.1.3. Its header word: K, a 10-bit checksum (bits 0-9);
   * C, more fragments follow (10); F, the fragment number (11-12, 3 for the first); N, the message number (13-18);
   * R and M, retrieval and mail-drop flags (19, 20). Characters are 7-bit, three to a word, except the first word of
   * a first fragment, whose low seven bits are the signature S.
   */
  private alpha(p: Uint32Array, bad: Uint8Array, hdr: number, mw: number, len: number, type: number): void {
    const known = !bad[hdr], h = known ? p[hdr] : 0;
    const more = (h >>> 10) & 1, frag = known ? (h >>> 11) & 3 : 3, n = (h >>> 13) & 0x3F, first = frag === 3;
    const cap = this.capcode;
    const words = Array.from({ length: len }, (_, k) => p[mw + k]);
    const gone = Array.from({ length: len }, (_, k) => bad[mw + k] === 1);
    const fixed = Array.from({ length: len }, (_, k) => this.fix[mw + k]);
    // K: the ones' complement of the sum of the header (K zeroed) and the message words. When it does not come out,
    // or cannot be worked out because a word was lost, the words the check fixed at its limit (two bits, or brought
    // back by soft decoding) are the likely culprits: noise "corrected" into a wrong word. They count as lost unless
    // another copy confirms them. A word fixed by one bit or none is kept: being wrong would take five or more errors.
    const kOk = () => {
      if (!known || gone.some(g => g)) return false;
      let s = groups(h & ~0x3FF);
      for (const d of words) s += groups(d);
      return ((~s) & 0x3FF) === (h & 0x3FF);
    };
    if (!kOk()) {
      const anyGone = gone.some(g => g);
      const near = gone.map((_, k) => (k > 0 && gone[k - 1]) || (k + 1 < len && gone[k + 1]));
      for (let k = 0; k < len; k++) if (!gone[k] && fixed[k] >= 2 && (!anyGone || near[k])) gone[k] = true;
    }
    // Another transmission of the same whole page (Section 3.4.2): same capcode, type, message number and length, and
    // every word both copies read agrees. Words one copy lost are taken from the other; a copy adding nothing is a
    // repeat, not a new page.
    let replaces: string | undefined, seenAt: SeenPage | undefined;
    if (known && first && more === 0 && len > 0) {
      const s = this.seen.find(e => e.cap === cap && e.type === type && e.n === n && e.words.length === len && !e.words.some((v, k) => !e.gone[k] && !gone[k] && v !== words[k]));
      if (!s) { seenAt = { cap, type, n, words: words.slice(), gone: gone.slice(), at: this.heardS, line: '' }; this.seen.unshift(seenAt); if (this.seen.length > 32) this.seen.length = 32; }
      else {
        const adds = s.gone.some((g, k) => g && !gone[k]);
        for (let k = 0; k < len; k++) if (gone[k] && !s.gone[k]) { words[k] = s.words[k]; gone[k] = false; }
        for (let k = 0; k < len; k++) if (s.gone[k] && !gone[k]) { s.words[k] = words[k]; s.gone[k] = false; }
        s.at = this.heardS;
        if (!adds) return;   // nothing new: already on the feed
        replaces = s.line; seenAt = s;
      }
    }
    const chars: number[] = [];
    let lostWords = 0;
    for (let k = 0; k < len; k++) {
      const d = words[k], sigWord = k === 0 && first;   // the first word of a first fragment opens with S
      if (gone[k]) { for (let r = sigWord ? 2 : 3; r > 0; r--) chars.push(LOST); lostWords++; continue; }
      for (const s of sigWord ? [7, 14] : [0, 7, 14]) chars.push((d >>> s) & 0x7F);
    }
    const text = render(chars);
    if (!known || (first && more === 0)) {
      // the whole page in one piece; with its header lost, its fragment and number are unknown, so it is partial
      const errors = known ? lostWords : Math.max(1, lostWords);
      const line = this.packet(type === PT.SECURE ? 0 : 5, lostWords * 2 > len ? '' : text.trimEnd(), errors, replaces);
      if (seenAt && line) seenAt.line = line;
      return;
    }
    const key = `${cap}/${type}/${n}`;
    if (first) {
      // the first of several: a new stream (an unfinished one with this number is sent as it stands)
      const old = this.streams.get(key); if (old) { this.streams.delete(key); this.finish(old, CUT, false); }
      this.streams.set(key, { head: this.head(type === PT.SECURE ? 0 : 5), page: this.pageOf(type === PT.SECURE ? 0 : 5, '', 0), cap, text, errors: lostWords, words: len, lostWords, expectF: 0, at: this.heardS });
      return;
    }
    // a continuation: F runs 0, 1, 2, 0 ... after the first; a break in it is a fragment that never arrived
    let s = this.streams.get(key);
    if (!s) { s = { head: this.head(type === PT.SECURE ? 0 : 5), page: this.pageOf(type === PT.SECURE ? 0 : 5, '', 0), cap, text: GAP, errors: 1, words: 0, lostWords: 0, expectF: frag, at: this.heardS }; this.streams.set(key, s); }
    if (frag !== s.expectF) { s.text += GAP; s.errors++; }
    s.text += text; s.errors += lostWords; s.words += len; s.lostWords += lostWords;
    s.expectF = (frag + 1) % 3;
    if (more === 0) { this.streams.delete(key); this.finish(s, '', true); }
  }

  /** Send a fragmented page: whole when its last piece came, unfinished (marked [CUT]) when the hold ran out. */
  private finish(s: Stream, tail: string, complete: boolean): void {
    const errors = s.errors + (complete ? 0 : 1);
    const text = s.lostWords * 2 > s.words ? '' : s.text.trimEnd() + tail;
    const page = { ...s.page, text, errors };
    if (errors > 0 && !text.trim()) { this.emit({ type: 'log', line: `FLEX CAP ${s.cap}: unreadable page, ${errors} word${errors === 1 ? '' : 's'} lost` }); this.emit({ type: 'pagerNoise', page }); return; }
    this.emit({ type: 'packet', line: FlexDecoder.line(s.head, text, errors), page });
  }

  /** Binary pages (Section 3.10.1.2) as hex, the second header word left out of a first fragment. */
  private binary(p: Uint32Array, bad: Uint8Array, hdr: number, mw: number, len: number, type: number): void {
    if (len <= 0) return;
    const from = type === PT.BINARY && !bad[hdr] && ((p[hdr] >>> 13) & 3) === 3 ? 1 : 0;
    const parts: string[] = [];
    let lost = 0;
    for (let k = from; k < len; k++) { if (bad[mw + k]) lost++; parts.push(bad[mw + k] ? '??????' : hex(p[mw + k] & 0x1FFFFF, 6)); }
    // a binary page that is mostly lost words is noise
    this.packet(type === PT.SECURE ? 0 : 6, !parts.length || lost * 2 > parts.length ? '' : parts.join(' '), lost);
  }

  private parseCapcode(aw1: number): void {
    this.addrType = 0;
    if (isLong(aw1)) this.addrType = 1;
    else if (aw1 >= 0x1F7800 && aw1 <= 0x1F780F) this.addrType = 2;
    else if (aw1 >= 0x1F7810 && aw1 <= 0x1F781F) this.addrType = 3;
    else if (aw1 >= 0x1F6800 && aw1 <= 0x1F77FF) this.addrType = 4;
    else if (aw1 >= 0x1F2800 && aw1 <= 0x1F67FF) this.addrType = 5;
    else if ((aw1 >= 0x1F0001 && aw1 <= 0x1F27FF) || (aw1 >= 0x1F7820 && aw1 <= 0x1F7FFE)) this.addrType = 6;
    else if (aw1 >= 0x8001 && aw1 <= 0x1E0000) this.addrType = 0;
    else this.addrType = 7;
    this.capcode = aw1 - 0x8000;
  }

  /**
   * Numeric pages (Section 3.10.1.1): BCD digits, low bit first, after 2 checksum bits (10 bits for numbered numeric:
   * checksum, N, R, S). The first message word is the second vector word for a long address. K is six bits: K3-K0 in
   * the vector (bits 17-20) and K5K4 in the first word (bits 0-1), over every message word.
   */
  private numeric(p: Uint32Array, bad: Uint8Array, j: number, numbered: boolean, long: boolean): { text: string; errors: number } | null {
    const viw = p[j], w1 = (viw >>> 7) & 0x7F, n = (viw >>> 14) & 7;
    if (w1 >= 88 || (long && j + 1 >= 88)) return null;
    const body0 = long ? j + 1 : w1;
    const list = [body0];
    const start = long ? w1 : w1 + 1, end = Math.min(long ? w1 + n - 1 : w1 + n, 87);
    for (let k = start; k <= end; k++) list.push(k);
    let msg = '', digit = 0, left = 4 + (numbered ? 10 : 2), lost = 0, sum = 0;
    list.forEach((k, idx) => {
      if (k < 0 || k >= 88 || bad[k]) { msg += '?????'; digit = 0; left = 4; lost++; return; }
      let d = p[k];
      sum += groups(idx === 0 ? d & ~3 : d);
      for (let b = 0; b < 21; b++) { digit = (digit >>> 1) | ((d & 1) << 3); d >>>= 1; if (--left === 0) { msg += FLEX_BCD[digit]; left = 4; } }
    });
    let errors = lost;
    if (!lost) {
      const s = sum & 0xFF, k6 = (~((s & 0x3F) + (s >>> 6))) & 0x3F;
      const rx = ((p[body0] & 3) << 4) | ((viw >>> 17) & 0xF);
      // as for text, a failed K condemns only a word fixed at the code's limit
      if (k6 !== rx && list.some(k => this.fix[k] >= 2)) errors = 1;
    }
    return { text: msg.replace(/ +$/, ''), errors };
  }
}
