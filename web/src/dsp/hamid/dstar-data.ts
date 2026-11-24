/**
 * D-STAR data beyond the slow data (JARL "Digitalization Technology Standard for Amateur Radio"):
 *
 *   · DV Fast Data (chapter 7): during fast data the voice frames carry data too. Ten blocks a 420 ms superframe; the
 *     first (the one with the sync) reads data frames 2 and 3 then voice frames 2, 3 and 1 and holds 28 bytes, the
 *     others read data frames 2n and 2n+1 then voice frames 2n and 2n+1 and hold 20. The first byte is the
 *     mini-header (8x: x bytes, 9x: 16 + x bytes), the fourth a guard byte, and each voice frame is 4 data bytes, a
 *     0x02 byte (for older radios' vocoders) and 4 more; the voice frames are scrambled like the data frames, the
 *     scrambler restarted at each frame (7.4). What the radios put in that byte stream (Icom's picture and file
 *     transfers) is not in the standard: a JPEG is found in it by its own start and end markers.
 *   · Code squelch (6.5): mini-header C2 and two bytes, right after the sync. The standard does not say how the two
 *     bytes hold the two-digit code and its check value; they are shown as sent, and the first read as BCD.
 *   · DD mode (3.2, 4.1.1, Ap1.2): 128 kbps GMSK packets: the bit sync, the frame sync, the radio header coded as in
 *     DV (660 bits), then a 2-byte length, an Ethernet frame (destination and source MAC, type, data) and a CRC-32
 *     (ISO 3309). One scrambler runs from the header's first bit to the CRC's last. The byte order of the length and
 *     the CRC is not stated: little-endian, the order the bits are sent (LSB first), is taken.
 * No DOM.
 */
import { decodeHeaderBits, type DStarHeader } from './dstar.js';
import { packLsb } from './fec.js';
import { DiscSymbols } from './symbols.js';

/** One period of the scrambler, x^7 + x^4 + 1 from all ones (the same sequence as dstarPn). */
const PN127 = (() => { const o = new Uint8Array(127); let s = 0x7f; for (let i = 0; i < 127; i++) { const fb = ((s >> 6) ^ (s >> 3)) & 1; o[i] = fb; s = ((s << 1) | fb) & 0x7f; } return o; })();

/** The valid bytes of a fast data block: data frames [a] and [b] (3 bytes each, descrambled), then its voice frames
 *  (72 bits each, as received), in block order. Null when the mini-header is not a fast data one. */
export function fastDataBlock(a: ArrayLike<number>, b: ArrayLike<number>, voices: ArrayLike<number>[]): Uint8Array | null {
  const mh = a[0] & 255, hi = mh >> 4;
  if (hi !== 8 && hi !== 9) return null;
  const n = (mh & 15) + (hi === 9 ? 16 : 0);
  const out: number[] = [a[1], a[2], b[1], b[2]];
  for (const v of voices) {
    const bits = new Uint8Array(72); for (let i = 0; i < 72; i++) bits[i] = (v[i] ^ PN127[i % 127]) & 1;
    const by = packLsb(bits, 0, 9);
    out.push(by[0], by[1], by[2], by[3], by[5], by[6], by[7], by[8]);
  }
  return Uint8Array.from(out.slice(0, Math.min(n, out.length)));
}

export interface DStarImage { mime: string; bytes: Uint8Array; complete: boolean }
/** The fast data byte stream of a call, and the JPEG found in it. */
export class FastDataStream {
  private buf = new Uint8Array(4096); n = 0;
  reset(): void { this.n = 0; }
  push(b: ArrayLike<number>): void {
    if (this.n + b.length > this.buf.length) {
      if (this.buf.length >= 1 << 20) return;
      const g = new Uint8Array(this.buf.length * 2); g.set(this.buf.subarray(0, this.n)); this.buf = g;
    }
    for (let i = 0; i < b.length; i++) this.buf[this.n++] = b[i];
  }
  /** The bytes so far. */
  bytes(): Uint8Array { return this.buf.subarray(0, this.n); }
  /** The first JPEG (FF D8 FF to FF D9), complete or as far as it has come. */
  image(): DStarImage | null {
    const b = this.buf;
    for (let i = 0; i + 2 < this.n; i++) {
      if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
      for (let j = i + 2; j + 1 < this.n; j++) if (b[j] === 0xff && b[j + 1] === 0xd9) return { mime: 'image/jpeg', bytes: b.slice(i, j + 2), complete: true };
      return { mime: 'image/jpeg', bytes: b.slice(i, this.n), complete: false };
    }
    return null;
  }
}

export interface DStarCsql { raw: string; code: number }
/** A code squelch block's two bytes. */
export function csqlOf(b1: number, b2: number): DStarCsql {
  const hex = (v: number) => (v & 255).toString(16).toUpperCase().padStart(2, '0');
  const bcd = (b1 >> 4) <= 9 && (b1 & 15) <= 9 ? (b1 >> 4) * 10 + (b1 & 15) : -1;
  return { raw: hex(b1) + hex(b2), code: bcd };
}

// ------------------------------------------------------------------------------------------------ DD mode
/** CRC-32 of ISO 3309 (as Ethernet): reflected 0xEDB88320, register all ones, complemented. */
export function crc32(b: ArrayLike<number>, from = 0, to = b.length): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) { c ^= b[i] & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
  return (~c) >>> 0;
}
const mac = (b: ArrayLike<number>, at: number) => Array.from({ length: 6 }, (_, i) => (b[at + i] & 255).toString(16).padStart(2, '0')).join(':');

export interface DdFrame { dst: string; src: string; type: number; length: number; crcOk: boolean }
export interface DdId { header: DStarHeader | null; frames: DdFrame[]; packets: number; inverted: boolean }

const FS = Uint8Array.from('111011001010000', c => c === '1' ? 1 : 0);

/** DD mode packets from a discriminator at [fs] (at least 256 kS/s), or from bits ([pushBit]). */
export class DStarDdReceiver {
  onFrame: (f: DdFrame, h: DStarHeader) => void = () => undefined;
  readonly id: DdId = { header: null, frames: [], packets: 0, inverted: false };
  private readonly sym: DiscSymbols | null;
  private readonly hist = new Uint8Array(32); private hp = 0;
  private hdr: Uint8Array | null = null; private hdrN = 0; private inv = 0;
  private hdrNow: DStarHeader | null = null;
  private data: number[] | null = null; private cur = 0; private nb = 0; private pn = 0; private need = 0;
  constructor(fs = 0) {
    this.sym = fs > 0 ? new DiscSymbols(fs, 128000, false) : null;
    if (this.sym) this.sym.onSymbol = s => this.pushBit(s > 0 ? 1 : 0);
  }
  reset(): void {
    this.sym?.reset(); this.hist.fill(0); this.hp = 0; this.hdr = null; this.hdrN = 0; this.inv = 0; this.hdrNow = null; this.data = null;
    Object.assign(this.id, { header: null, frames: [], packets: 0, inverted: false });
  }
  push(disc: ArrayLike<number>, n: number): void { this.sym?.push(disc, n); }

  pushBit(raw: number): void {
    this.hist[this.hp] = raw & 1; this.hp = (this.hp + 1) & 31;
    if (this.hdr) {
      this.hdr[this.hdrN++] = (raw ^ this.inv) & 1;
      if (this.hdrN === 660) {
        const h = decodeHeaderBits(this.hdr); this.hdr = null;
        if (h) { this.hdrNow = h; this.data = []; this.cur = 0; this.nb = 0; this.pn = 660; this.need = 2; this.id.inverted = this.inv === 1; }
      }
      return;
    }
    if (this.data) { this.dataBit((raw ^ this.inv ^ PN127[this.pn++ % 127]) & 1); return; }
    for (const inv of [0, 1]) if (this.syncAt(inv)) { this.inv = inv; this.hdr = new Uint8Array(660); this.hdrN = 0; return; }
  }
  /** The frame sync with at most one error, right after at least 16 bits of 1010. */
  private syncAt(inv: number): boolean {
    let e = 0;
    for (let i = 0; i < 15; i++) if (((this.hist[(this.hp - 15 + i + 32) & 31] ^ inv) & 1) !== FS[i]) e++;
    if (e > 1) return false;
    let a = 0, b = 0;
    for (let i = 0; i < 16; i++) { const v = (this.hist[(this.hp - 31 + i + 32) & 31] ^ inv) & 1; if (v !== (i & 1)) a++; if (v !== ((i + 1) & 1)) b++; }
    return Math.min(a, b) <= 1;
  }
  private dataBit(bit: number): void {
    this.cur |= bit << (this.nb & 7);
    if ((++this.nb & 7) !== 0) return;
    const d = this.data!; d.push(this.cur); this.cur = 0;
    if (d.length === 2) {
      const len = d[0] | (d[1] << 8);
      if (len < 14 || len > 1600) { this.data = null; return; }
      this.need = 2 + len + 4;
    }
    if (d.length === this.need) { this.data = null; this.packet(d); }
  }
  private packet(d: number[]): void {
    const len = d.length - 6, at = 2;
    const got = (d[at + len] | (d[at + len + 1] << 8) | (d[at + len + 2] << 16) | (d[at + len + 3] << 24)) >>> 0;
    const crcOk = crc32(d, at, at + len) === got || crc32(d, 0, at + len) === got;
    const f: DdFrame = { dst: mac(d, at), src: mac(d, at + 6), type: (d[at + 12] << 8) | d[at + 13], length: len, crcOk };
    this.id.packets++; this.id.header = this.hdrNow;
    this.id.frames.push(f); if (this.id.frames.length > 32) this.id.frames.shift();
    this.onFrame(f, this.hdrNow!);
  }
}

// ------------------------------------------------------------------------------------------------ Icom records
/**
 * Icom's own records in the simple data and fast data streams (not in the JARL standard; the layout is from the
 * D-StarBeacon project's notes, see the credits): "$$Msg,FROM,TO," then six digits and the text of a message, and
 * "$$Pic,FROM,TO," then four characters (the picture's quality and size) and one block of the picture. The picture
 * blocks' coding is not public, so the pictures are counted, not drawn.
 */
export interface IcomMessage { from: string; to: string; text: string }
export interface IcomPicture { from: string; to: string; code: string; blocks: number }

/** The records in a byte or character sequence: the last message, and the picture blocks counted. */
export function icomRecords(b: ArrayLike<number>, from = 0): { msg: IcomMessage | null; pic: IcomPicture | null } {
  let msg: IcomMessage | null = null, pic: IcomPicture | null = null;
  const at = (i: number, s: string) => { for (let k = 0; k < s.length; k++) if ((b[i + k] & 255) !== s.charCodeAt(k)) return false; return true; };
  const field = (i: number): [string, number] => { let s = ''; while (i < b.length && b[i] !== 0x2c && s.length < 12) s += String.fromCharCode(b[i++] & 255); return [s.trim(), i + 1]; };
  for (let i = from; i + 6 < b.length; i++) {
    const isMsg = at(i, '$$Msg,'), isPic = !isMsg && at(i, '$$Pic,');
    if (!isMsg && !isPic) continue;
    const [f, j] = field(i + 6), [t, k] = field(j);
    if (!/^[A-Z0-9/ -]{3,10}$/.test(f) || k > b.length) continue;
    if (isMsg) {
      let text = '', p = k + 6;
      while (p < b.length && b[p] >= 0x20 && b[p] < 0x7f) text += String.fromCharCode(b[p++]);
      if (k + 6 <= b.length) msg = { from: f, to: t, text: text.trim() };
    } else {
      let code = ''; for (let p = k; p < k + 4 && p < b.length; p++) code += String.fromCharCode(b[p] & 255);
      const was = pic as IcomPicture | null;
      pic = was && was.from === f && was.to === t ? { from: f, to: t, code, blocks: was.blocks + 1 } : { from: f, to: t, code, blocks: 1 };
    }
    i = k - 1;
  }
  return { msg, pic };
}
