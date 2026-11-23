/**
 * D-STAR digital voice (JARL "Digitalization Technology Standard for Amateur Radio", the radio header, data frames
 * and D-PRS): GMSK at 4800 bits/s, each byte sent LSB first, a positive deviation for a 1.
 *
 *   · radio header: 64-bit 1010 preamble, frame sync 111011001010000, then 660 bits: flags (3), RPT2 (8),
 *     RPT1 (8), UR (8), MY (8), MY suffix (4) and P_FCS (2, CRC-16 0x8408 reflected, register all ones,
 *     complemented, low byte first), convolutionally coded (K = 3, G1 = 1 + D + D², G2 = 1 + D², two zero tail
 *     bits), interleaved by the 24-row matrix of Ap. 2.2 (written down the columns, sent across the rows) and
 *     scrambled with x^7 + x^4 + 1 from all ones;
 *   · then 20 ms frames of 72 voice bits and 24 data bits; every 21st data frame is the sync
 *     101010101011010001101000, the others are scrambled by the same sequence restarted (70 4F 93);
 *   · data frames pair up into 6-byte blocks whose first byte (the mini-header) says what they carry: 4n message
 *     part n (5 characters of a 20-character message), 3n n bytes of simple data (GPS NMEA sentences or D-PRS, the
 *     APRS-format position with its "$$CRCxxxx," prefix), 5n n bytes of the radio header sent again;
 *   · the end of a transmission: 1010 then 000100110101111;
 *   · code squelch (Cx) and DV Fast Data (8x, 9x), which also takes the voice frames (dstar-data.ts).
 * Either polarity. Each 72-bit voice frame goes out with its time ([onVoiceFrame]); the AMBE in it is not decoded.
 * No DOM.
 */
import { DSTAR_K, DSTAR_G, viterbi, crc16Lsb, packLsb, asciiField } from './fec.js';
import { LineBuffer, parsePositionLine, type Position } from './gps.js';
import { fastDataBlock, FastDataStream, csqlOf, type DStarCsql, type DStarImage } from './dstar-data.js';
import type { HamVoiceFrame } from './voice.js';

export const DSTAR_FS = '111011001010000';
export const DSTAR_DSYNC = '101010101011010001101000';
export const DSTAR_END = '000100110101111';
const bitsOf = (s: string) => Uint8Array.from([...s].map(c => c === '1' ? 1 : 0));
const FS = bitsOf(DSTAR_FS), DSYNC = bitsOf(DSTAR_DSYNC), END = bitsOf(DSTAR_END);

/** The scrambler sequence (x^7 + x^4 + 1, all ones to start), as many bits as asked. */
export function dstarPn(n: number): Uint8Array {
  const out = new Uint8Array(n); let s = 0x7f;
  for (let i = 0; i < n; i++) { const fb = ((s >> 6) ^ (s >> 3)) & 1; out[i] = fb; s = ((s << 1) | fb) & 0x7f; }
  return out;
}
const PN = dstarPn(660);

/** Interleave: the coded bit sent k-th. The matrix has 24 rows; rows 0..11 hold 28 columns, rows 12..23 hold 27. */
export const DSTAR_INTERLEAVE = (() => {
  const t = new Int32Array(660); let k = 0;
  for (let r = 0; r < 24; r++) for (let c = 0; c < (r < 12 ? 28 : 27); c++) t[k++] = 24 * c + r;
  return t;
})();

export interface DStarHeader { flag1: number; flag2: number; flag3: number; rpt2: string; rpt1: string; ur: string; my: string; suffix: string; crcOk: boolean }

/** The 41 header bytes as sent (after the code and before the scrambler). */
export function parseHeaderBytes(b: ArrayLike<number>): DStarHeader {
  const crc = crc16Lsb(b, 39), got = (b[39] & 255) | ((b[40] & 255) << 8);
  return {
    flag1: b[0] & 255, flag2: b[1] & 255, flag3: b[2] & 255,
    rpt2: asciiField(b, 3, 8), rpt1: asciiField(b, 11, 8), ur: asciiField(b, 19, 8), my: asciiField(b, 27, 8), suffix: asciiField(b, 35, 4),
    crcOk: crc === got,
  };
}

/** 660 received header bits (in the order sent) → the header, or null when its check fails. */
export function decodeHeaderBits(rx: ArrayLike<number>): DStarHeader | null {
  const coded = new Uint8Array(660);
  for (let k = 0; k < 660; k++) coded[DSTAR_INTERLEAVE[k]] = (rx[k] ^ PN[k]) & 1;
  const { bits } = viterbi(coded, DSTAR_K, DSTAR_G);
  const h = parseHeaderBytes(packLsb(bits, 0, 41));
  return h.crcOk ? h : null;
}

/** A repeater field ("W6ABC  B") split into its callsign and module letter. */
export function repeaterOf(f: string): { call: string; module: string } {
  const padded = (f + '        ').slice(0, 8);
  return { call: padded.slice(0, 7).trim(), module: padded[7].trim() };
}

export interface DStarId {
  header: DStarHeader | null; headerFrom: '' | 'header' | 'slow data';
  message: string; position: Position | null; positionText: string; dprsCrcOk: boolean;
  inverted: boolean; active: boolean; frames: number; headers: number;
  /** The code squelch block, fast data bytes received this call, and the picture found in them. */
  csql: DStarCsql | null; fastBytes: number; image: DStarImage | null;
}

const matches = (hist: Uint8Array, hp: number, pat: Uint8Array, end: number, inv: number): number => {
  // errors between the pattern and the history bits ending [end] bits before the newest
  let e = 0; const n = pat.length, H = hist.length;
  for (let i = 0; i < n; i++) if (((hist[(hp - end - n + i + 2 * H) % H] ^ inv) & 1) !== pat[i]) e++;
  return e;
};
const alternating = (hist: Uint8Array, hp: number, end: number, n: number, inv: number): boolean => {
  let e0 = 0, e1 = 0; const H = hist.length;
  for (let i = 0; i < n; i++) { const b = (hist[(hp - end - n + i + 2 * H) % H] ^ inv) & 1; if (b !== (i & 1)) e0++; if (b !== ((i + 1) & 1)) e1++; }
  return Math.min(e0, e1) <= 1;
};

export class DStarReceiver {
  onHeader: (h: DStarHeader, from: 'header' | 'slow data') => void = () => undefined;
  onEnd: () => void = () => undefined;
  /** Each voice frame (not those carrying fast data), stream 'dstar'. */
  onVoiceFrame: (f: HamVoiceFrame) => void = () => undefined;
  /** The voice frames of this superframe by data frame index (0: the one before the sync), and those not yet out. */
  private readonly vbuf: (Uint8Array | null)[] = new Array(21).fill(null); private readonly vAt = new Float64Array(21);
  private pend: number[] = [];
  private readonly fast = new FastDataStream();
  private readonly hist = new Uint8Array(128); private hp = 0;
  private inv = 0; private hdrInv = 0;
  private hdr: Uint8Array | null = null; private hdrN = 0;
  /** Bits since the last data sync; -1 while not framed. */
  private cnt = -1; private missed = 0;
  private half: Uint8Array | null = null;
  private msg: string[] = ['', '', '', '']; private msgSeen = 0;
  private slowHdr: number[] = [];
  private readonly lines = new LineBuffer();
  bits = 0;
  readonly id: DStarId = { header: null, headerFrom: '', message: '', position: null, positionText: '', dprsCrcOk: false, inverted: false, active: false, frames: 0, headers: 0, csql: null, fastBytes: 0, image: null };

  reset(): void {
    this.hist.fill(0); this.hp = 0; this.inv = 0; this.hdrInv = 0; this.hdr = null; this.hdrN = 0; this.cnt = -1; this.missed = 0; this.half = null;
    this.msg = ['', '', '', '']; this.msgSeen = 0; this.slowHdr = []; this.lines.reset(); this.bits = 0;
    this.vbuf.fill(null); this.pend = []; this.fast.reset();
    Object.assign(this.id, { header: null, headerFrom: '', message: '', position: null, positionText: '', dprsCrcOk: false, inverted: false, active: false, frames: 0, headers: 0, csql: null, fastBytes: 0, image: null });
  }

  /** A soft symbol from the 4800/s symbol stream: its sign is the bit. */
  pushSymbol(s: number): void { this.pushBit(s > 0 ? 1 : 0); }

  pushBit(raw: number): void {
    this.bits++;
    this.hist[this.hp] = raw & 1; this.hp = (this.hp + 1) % this.hist.length;
    if (this.hdr) {
      const b = (raw ^ this.hdrInv) & 1;                                        // inside a radio header
      this.hdr[this.hdrN++] = b;
      if (this.hdrN === 660) {
        const h = decodeHeaderBits(this.hdr); this.hdr = null;
        if (h) { this.inv = this.hdrInv; this.id.inverted = this.inv === 1; this.cnt = -1; this.newCall(); this.id.header = h; this.id.headerFrom = 'header'; this.id.headers++; this.id.active = true; this.onHeader(h, 'header'); }
      }
      return;
    }
    // the end of a transmission (the end pattern is the frame sync inverted, so it is looked for first)
    if (this.id.active && matches(this.hist, this.hp, END, 0, this.inv) === 0 && alternating(this.hist, this.hp, 15, 16, this.inv)) {
      this.flushVoice(); this.id.active = false; this.cnt = -1; this.onEnd(); return;
    }
    // a radio header: frame sync right after the preamble, in either polarity; the polarity holds once it decodes
    for (const inv of [this.inv, this.inv ^ 1]) {
      if (matches(this.hist, this.hp, FS, 0, inv) <= 1 && alternating(this.hist, this.hp, 15, 16, inv)) {
        this.hdrInv = inv; this.hdr = new Uint8Array(660); this.hdrN = 0; return;
      }
    }
    if (this.cnt >= 0) {
      this.cnt++;
      if (this.cnt % 96 === 0) {
        const k = this.cnt / 96;
        if (k < 21) { this.keepVoice(k); this.dataFrame(k); }
        else {
          // where the next sync belongs: take it even when a bit or two is wrong, and keep the grid through a lost one
          if (matches(this.hist, this.hp, DSYNC, 0, this.inv) <= 4) this.missed = 0; else if (++this.missed > 2) { this.flushVoice(); this.cnt = -1; this.id.active = false; return; }
          this.superframe(); this.keepVoice(0);
        }
      }
      return;
    }
    // not framed: look for the data sync (late entry), either polarity
    for (const inv of [0, 1]) {
      if (matches(this.hist, this.hp, DSYNC, 0, inv) === 0) { this.inv = inv; this.id.inverted = inv === 1; this.id.active = true; this.missed = 0; this.superframe(); this.keepVoice(0); return; }
    }
  }

  private newCall(): void {
    this.msg = ['', '', '', '']; this.msgSeen = 0; this.slowHdr = []; this.lines.reset(); this.fast.reset(); this.pend = [];
    Object.assign(this.id, { message: '', position: null, positionText: '', dprsCrcOk: false, frames: 0, csql: null, fastBytes: 0, image: null });
  }
  private superframe(): void { this.flushVoice(); this.cnt = 0; this.half = null; this.slowHdr = []; this.vbuf.fill(null); }

  /** The voice frame that ends 24 bits before the newest bit: the one before data frame [k]. */
  private keepVoice(k: number): void {
    const v = new Uint8Array(72), H = this.hist.length;
    for (let i = 0; i < 72; i++) v[i] = (this.hist[(this.hp - 96 + i + H) % H] ^ this.inv) & 1;
    this.vbuf[k] = v; this.vAt[k] = this.bits - 96; this.pend.push(k);
  }
  private flushVoice(): void {
    for (const k of this.pend) { const v = this.vbuf[k]; if (v) this.onVoiceFrame({ stream: 'dstar', codec: 'ambe-dstar', bits: v, atSym: this.vAt[k], errs: 0 }); }
    this.pend = [];
  }

  /** Data frame [k] (1..20) has just ended: its 24 bits are the newest. */
  private dataFrame(k: number): void {
    this.id.frames++;
    const bits = new Uint8Array(24), H = this.hist.length;
    for (let i = 0; i < 24; i++) bits[i] = ((this.hist[(this.hp - 24 + i + H) % H] ^ this.inv) & 1) ^ PN[i];
    const by = packLsb(bits, 0, 3);
    if (k % 2 === 1) { this.half = by; return; }
    if (!this.half) { this.flushVoice(); return; }
    const blk = [this.half[0], this.half[1], this.half[2], by[0], by[1], by[2]];
    const a = this.half; this.half = null;
    // fast data: block 1 reads voice frames 2, 3 and 1, the others the two of their own data frames
    const idx = k === 2 ? [1, 2, 0] : [k - 1, k], vs = idx.map(i => this.vbuf[i]);
    const fd = vs.every(v => v) ? fastDataBlock(a, by, vs as Uint8Array[]) : null;
    if (fd) {
      this.pend = this.pend.filter(i => !idx.includes(i));
      this.fast.push(fd); this.id.fastBytes += fd.length; this.id.image = this.fast.image();
    } else this.block(blk);
    this.flushVoice();
  }

  private block(b: number[]): void {
    const type = b[0] >> 4, n = b[0] & 15;
    if (type === 4 && n < 4) {
      let s = ''; for (let i = 1; i < 6; i++) s += b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : ' ';
      this.msg[n] = s; this.msgSeen |= 1 << n;
      if (this.msgSeen === 15) this.id.message = this.msg.join('').trim();
    } else if (type === 3 && n >= 1) {
      let s = ''; for (let i = 1; i <= Math.min(5, n); i++) s += String.fromCharCode(b[i]);
      for (const line of this.lines.push(s)) this.line(line);
    } else if (type === 12 && n === 2) {
      this.id.csql = csqlOf(b[1], b[2]);
    } else if (type === 5 && n >= 1) {
      for (let i = 1; i <= Math.min(5, n); i++) this.slowHdr.push(b[i]);
      if (this.slowHdr.length >= 41) {
        const h = parseHeaderBytes(this.slowHdr.slice(this.slowHdr.length - 41));
        this.slowHdr = [];
        if (h.crcOk) {
          const changed = !this.id.header || this.id.header.my !== h.my || this.id.header.rpt1 !== h.rpt1;
          if (changed) { this.id.header = h; this.id.headerFrom = 'slow data'; this.id.headers++; this.onHeader(h, 'slow data'); }
        }
      }
    }
  }

  private line(line: string): void {
    const p = parsePositionLine(line);
    if (!p) return;
    if (line.startsWith('$$CRC')) {
      const c = line.indexOf(','), want = parseInt(line.slice(5, 9), 16), body = line.slice(c + 1) + '\r';
      const bytes = Array.from(body, ch => ch.charCodeAt(0) & 255);
      const ok = crc16Lsb(bytes, bytes.length) === want;
      if (!ok) return;
      this.id.dprsCrcOk = true; p.source = 'd-prs';
    }
    this.id.position = p; this.id.positionText = line;
  }
}
