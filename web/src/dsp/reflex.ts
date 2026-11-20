/**
 * ReFLEX outbound (two-way paging, base to pager), the FLEX-family frame as it is on the air at 940.8625 MHz in the
 * 2026-11-20 roof recording. Our own code, from public facts about the FLEX family (frames of 1.875 s, 128 frames a
 * cycle, a frame information word coded BCH(31,21) plus parity, 8-word blocks interleaved bit by bit) and from what
 * the recording shows:
 *
 * - Sync 1 is sent 2-level at 1600 bps: 12.5 ms full-deviation tones, dotting, then an 80-bit sync word
 *   (0x163B5939, 0x0000, 0xE9C4A6C6, bits as sent with the higher tone a 1). FLEX's own sync carries 0xAAAA in the
 *   middle and other A codes, so a FLEX decoder never locks on it.
 * - The frame information word follows: BCH good on every frame heard, with FLEX's nibble checksum, and its cycle and
 *   frame numbers count one frame every 1.875 s.
 * - The data runs 4-level at 3200 baud (6400 bps), outer about the sync's deviation (2.4 kHz) and inner a third of it
 *   (0.8 kHz), the levels public descriptions give ReFLEX. After 80 symbols (25 ms, as FLEX's sync 2) come blocks of
 *   512 symbols; as in FLEX at this speed, the even symbols feed phases A and B, the odd ones C and D, 8 words each,
 *   bit-interleaved. The low bit of each symbol (levels numbered 0 to 3 from the lower tone), phases B and D, passes
 *   BCH(32,21) on about 97% of words. The high bit (phases A and C) does not follow that code at any alignment or
 *   mapping tried, so it is counted and not decoded.
 *
 * What it reports: the cycle and frame of each frame, how many blocks it ran, the checked words of its first block
 * (phase B then phase D) in hex, and the pass rates. No address or text is read from it: the words that check do not
 * carry FLEX's block information word, address and vector structure at any alignment, and nothing here claims they do.
 */
import { popcount32, type Emit } from './core.js';
import { bchCorrect } from './flex.js';

const BAUD = 1600;
/** The sync word as three pieces, first-sent bit at the top: 16 + 32 + 32 = 80 bits. */
const SYNC_HI = 0x163B, SYNC_MID = 0x59390000, SYNC_LO = 0xE9C4A6C6;
/** Bit errors the sync word may carry and still be taken. */
const SYNC_ERRS = 6;
/** The data's symbol rate: 4-level at 3200 baud, 6400 bps. */
const DATA_BAUD = 3200;
/** Data symbols between the end of the frame information word and the first block: 25 ms, as FLEX's sync 2. */
const SYNC2_SYMS = 80;
/** A block: 160 ms, 512 symbols, 8 words in each of four phases. */
const BLOCK_SYMS = 512;
/** A block counts as sent when this many of its 16 coded words (phases B and D) pass (noise passes about a quarter of
 *  words, so 10 of 16 by chance is about one in 600). A frame ends at the second block in a row that falls
 *  short, or at [MAX_BLOCKS]; a single short block between good ones is counted as received with errors. */
const BLOCK_MIN_OK = 10;
const MAX_BLOCKS = 16;

const enum St { SEARCH, FIW, SYNC2, DATA }

/** Reverses 32 bits: the frame information word's first-sent bit becomes bit 0, FLEX's field order. */
function rev32(x: number): number {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0F0F0F0F) | ((x & 0x0F0F0F0F) << 4);
  x = ((x >>> 8) & 0x00FF00FF) | ((x & 0x00FF00FF) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}
const nibbleSum = (d: number) => ((d & 0xF) + ((d >>> 4) & 0xF) + ((d >>> 8) & 0xF) + ((d >>> 12) & 0xF) + ((d >>> 16) & 0xF) + ((d >>> 20) & 1)) & 0xF;
const hex6 = (v: number) => v.toString(16).toUpperCase().padStart(6, '0');

/** [words]: the first block's phase B then phase D words, as data in hex ('------' for one that failed its check);
 *  [okB] of [total]: coded words (phases B and D) that checked; [okA]: phase A and C words that did. */
export interface ReflexFrame { cycle: number; frame: number; fiw: number; blocks: number; words: string[]; okB: number; okA: number; total: number }

export class ReflexDecoder {
  private rate = 0; private sps = 0;
  // symbol clock
  private ph = 0; private acc = 0; private nAcc = 0; private prevS = 0;
  // the FM's offset (the carrier's frequency error), followed while searching, held through a frame
  private dc = 0;
  // sync search
  private hi = 0; private mid = 0; private lo = 0;
  private readonly vals = new Float32Array(80); private vW = 0;
  private st = St.SEARCH; private n = 0; private word = 0;
  private inv = false; private dev = 2400;
  private cycle = 0; private frame = 0; private fiw = 0;
  /** The data symbols of the block being read, as the clock sampled them ([0]) and a quarter, half and three
   *  quarters of a symbol later ([1]-[3]): a block whose timing slipped (a sample drop, a slow clock) is read at
   *  the timing its words check best at. */
  private readonly alt = [0, 1, 2, 3].map(() => new Float32Array(BLOCK_SYMS));
  private readonly altAcc = [0, 0, 0, 0]; private readonly altN = [0, 0, 0, 0]; private readonly altK = [0, 0, 0, 0];
  private mag = 0; private blocks = 0; private first: string[] = [];
  private okB = 0; private okA = 0; private tot = 0;
  /** A short block held back until the next one shows whether the frame went on. */
  private short: { okB: number; okA: number; words: string[] } | null = null;
  /** Running counts for the tests and the log: frames, frame words that checked, data words checked per phase. */
  readonly stats = { syncs: 0, frames: 0, fiwBad: 0, wordsB: 0, okB: 0, wordsA: 0, okA: 0 };

  constructor(private readonly emit: Emit) {}
  reset(): void { this.rate = 0; this.st = St.SEARCH; }

  /** FM discriminator samples in radians per sample. */
  onFm(xs: Float32Array, n: number, rate: number): void {
    if (rate !== this.rate) { this.rate = rate; this.sps = rate / BAUD; this.ph = 0; this.st = St.SEARCH; this.dc = 0; }
    const toHz = rate / (2 * Math.PI), a = 1 / (0.2 * rate);
    for (let i = 0; i < n; i++) {
      const v = xs[i] * toHz;
      if (this.st === St.SEARCH) this.dc += (v - this.dc) * a;
      const s = v - this.dc, sps = this.sps;   // the symbol length changes inside a frame
      // a crossing belongs at a symbol edge: pull the clock toward it
      if ((s > 0) !== (this.prevS > 0)) { let e = this.ph; if (e > sps / 2) e -= sps; this.ph -= e * 0.1; }
      this.prevS = s;
      if (this.ph > sps * 0.25 && this.ph < sps * 0.75) { this.acc += s; this.nAcc++; }
      this.ph += 1;
      if (this.st === St.DATA) this.later(s, sps);
      if (this.ph >= sps) { this.ph -= sps; const m = this.nAcc ? this.acc / this.nAcc : 0; this.acc = 0; this.nAcc = 0; this.symbol(m); }
    }
  }

  /** The other three timings of a data symbol: each its own mid-symbol window, [o] quarters of a symbol late. */
  private later(s: number, sps: number): void {
    for (let o = 1; o < 4; o++) {
      let p = this.ph - o * sps / 4; if (p < 0) p += sps;
      if (p > sps * 0.25 && p < sps * 0.75) { this.altAcc[o] += s; this.altN[o]++; }
      else if (this.altN[o] && p >= sps * 0.75 && this.altK[o] < BLOCK_SYMS) {
        this.alt[o][this.altK[o]++] = this.altAcc[o] / this.altN[o]; this.altAcc[o] = 0; this.altN[o] = 0;
      }
    }
  }

  private symbol(v: number): void {
    switch (this.st) {
      case St.SEARCH: {
        const b = v > 0 ? 1 : 0;
        this.hi = ((this.hi << 1) | (this.mid >>> 31)) & 0xFFFF;
        this.mid = ((this.mid << 1) | (this.lo >>> 31)) >>> 0;
        this.lo = ((this.lo << 1) | b) >>> 0;
        this.vals[this.vW] = v; this.vW = (this.vW + 1) % 80;
        const e = popcount32(this.hi ^ SYNC_HI) + popcount32(this.mid ^ SYNC_MID) + popcount32(this.lo ^ SYNC_LO);
        if (e <= SYNC_ERRS || 80 - e <= SYNC_ERRS) { this.inv = e > SYNC_ERRS; this.locked(); }
        break;
      }
      case St.FIW: {
        this.word = ((this.word << 1) | (this.bit2(v))) >>> 0;
        if (++this.n === 32) this.readFiw();
        break;
      }
      case St.SYNC2: {
        if (++this.n === SYNC2_SYMS) { this.n = 0; this.st = St.DATA; }
        break;
      }
      case St.DATA: {
        const s = this.inv ? -v : v;
        this.alt[0][this.n++] = v;
        this.mag += Math.abs(s);
        if (this.n === BLOCK_SYMS) { this.n = 0; const m = this.mag / BLOCK_SYMS; this.mag = 0; this.block(m); this.altK.fill(0); }
        break;
      }
    }
  }
  private bit2(v: number): number { return (v > 0) !== this.inv ? 1 : 0; }


  /**
   * The sync word is in. Its 80 symbols are known, so a straight-line fit of what was heard to what was sent gives
   * the deviation and what is left of the offset, which is then held for the frame (the 4-level slicer needs both).
   */
  private locked(): void {
    let sv = 0, ss = 0, ssv = 0;
    for (let k = 0; k < 80; k++) {
      const v = this.vals[(this.vW + k) % 80], bit = 79 - k;
      const one = bit >= 64 ? (SYNC_HI >>> (bit - 64)) & 1 : bit >= 32 ? (SYNC_MID >>> (bit - 32)) & 1 : (SYNC_LO >>> bit) & 1;
      const sgn = (one === 1) !== this.inv ? 1 : -1;
      sv += v; ss += sgn; ssv += sgn * v;
    }
    const den = 80 - ss * ss / 80;
    const dev = den > 0 ? (ssv - ss * sv / 80) / den : 0, off = (sv - dev * ss) / 80;
    this.dev = Math.max(300, dev); this.dc += off;
    this.st = St.FIW; this.n = 0; this.word = 0; this.hi = this.mid = this.lo = 0;
    this.stats.syncs++;
  }

  private readFiw(): void {
    const c = bchCorrect(this.word | 0);
    const f = c === null ? -1 : rev32(c >>> 0) & 0x1FFFFF;
    if (f < 0 || nibbleSum(f) !== 0xF) { this.stats.fiwBad++; this.st = St.SEARCH; return; }
    this.fiw = f; this.cycle = (f >>> 4) & 0xF; this.frame = (f >>> 8) & 0x7F;
    this.blocks = 0; this.first = []; this.okA = 0; this.okB = 0; this.tot = 0; this.short = null;
    this.stats.frames++;
    this.emit({ type: 'sync', protocol: 'ReFLEX', rate: '6400' });
    this.st = St.SYNC2; this.n = 0; this.mag = 0; this.altK.fill(0); this.altN.fill(0); this.altAcc.fill(0);
    // the data runs at twice the sync's speed: the clock goes on from where it is, in the shorter symbol
    this.sps = this.rate / DATA_BAUD; if (this.ph >= this.sps) this.ph -= this.sps;
  }

  /**
   * One block of 512 symbols. Each symbol carries two bits; the even symbols' go to phases A (high bit) and B (low
   * bit), the odd symbols' to C and D, each phase 8 words bit-interleaved as FLEX does. Phases B and D carry
   * BCH(32,21) words; A and C do not follow that code, so they are only counted. [mag] is the mean distance of the
   * symbols from the center: four levels a third of the deviation apart average two thirds of it, and a block well
   * under that is the carrier gone (silence decodes as all-zero words, which a check passes).
   */
  private block(mag: number): void {
    // silence decodes as all-zero words, and noise swings well past the outer level
    if (mag < this.dev * 0.35 || mag > this.dev * 1.3) { this.end(); return; }
    let best: number[][] | null = null, bestOk = -1;
    for (let o = 0; o < 4; o++) {
      if (o && this.altK[o] < BLOCK_SYMS - 1) continue;
      const w = this.phases(this.alt[o], o ? this.altK[o] : BLOCK_SYMS);
      let ok = 0; for (const p of [1, 3]) for (const x of w[p]) if (bchCorrect(x | 0) !== null) ok++;
      if (ok > bestOk) { bestOk = ok; best = w; }
      if (ok === 16) break;
    }
    const w = best!;
    let okB = 0, okA = 0; const words: string[] = [];
    for (const p of [1, 3]) for (let j = 0; j < 8; j++) {
      const b = bchCorrect(w[p][j] | 0);
      if (b !== null) { okB++; words.push(hex6(rev32(b >>> 0) & 0x1FFFFF)); } else words.push('------');
    }
    for (const p of [0, 2]) for (let j = 0; j < 8; j++) if (bchCorrect(w[p][j] | 0) !== null) okA++;
    if (okB < BLOCK_MIN_OK) {
      if (this.short || !this.blocks) { this.end(); return; }
      this.short = { okB, okA, words };
      return;
    }
    if (this.short) { this.count(this.short.okB, this.short.okA, this.short.words); this.short = null; }
    this.count(okB, okA, words);
    if (this.blocks >= MAX_BLOCKS) this.end();
  }

  /** A block's symbols ([k] of them; a missing last one reads as the center) sliced and dealt into the four phases. */
  private phases(v: Float32Array, k: number): number[][] {
    const t = this.dev * 2 / 3, sl = (x: number) => { const s = this.inv ? -x : x; return s > t ? 3 : s > 0 ? 2 : s > -t ? 1 : 0; };
    const w = [0, 1, 2, 3].map(() => new Array<number>(8).fill(0));
    for (let c = 0; c < BLOCK_SYMS / 2; c++) {
      const e = sl(2 * c < k ? v[2 * c] : 0), o = sl(2 * c + 1 < k ? v[2 * c + 1] : 0), j = c & 7;
      w[0][j] = ((w[0][j] << 1) | (e >> 1)) >>> 0; w[1][j] = ((w[1][j] << 1) | (e & 1)) >>> 0;
      w[2][j] = ((w[2][j] << 1) | (o >> 1)) >>> 0; w[3][j] = ((w[3][j] << 1) | (o & 1)) >>> 0;
    }
    return w;
  }

  private count(okB: number, okA: number, words: string[]): void {
    this.stats.wordsB += 16; this.stats.okB += okB; this.stats.wordsA += 16; this.stats.okA += okA;
    this.okB += okB; this.okA += okA; this.tot += 16;
    if (this.blocks++ === 0) this.first = words;
  }

  private end(): void {
    this.st = St.SEARCH; this.n = 0; this.short = null; this.sps = this.rate / BAUD;
    if (!this.blocks) return;
    const fr: ReflexFrame = { cycle: this.cycle, frame: this.frame, fiw: this.fiw, blocks: this.blocks, words: this.first, okB: this.okB, okA: this.okA, total: this.tot };
    this.emit({ type: 'reflex', frame: fr, line: ReflexDecoder.line(fr) });
  }

  static where(f: ReflexFrame): string { return `C${f.cycle}F${String(f.frame).padStart(3, '0')}`; }
  /** The frame as the feed shows it: where, how long, and the checked words of its first block. */
  static text(f: ReflexFrame): string {
    return `${f.blocks} block${f.blocks === 1 ? '' : 's'}, ${f.okB} of ${f.total} words check · ${f.words.join(' ')}`;
  }
  static line(f: ReflexFrame): string { return `ReFLEX 6400/4L ${ReflexDecoder.where(f)} ${ReflexDecoder.text(f)}`; }
}
