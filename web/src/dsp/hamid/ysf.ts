/**
 * Yaesu System Fusion (C4FM) identity, from Yaesu's "Amateur Radio Digital Specifications" (rev. 1.01): 4FSK at
 * 4800 symbols/s (dibit 00 → +1, 01 → +3, 10 → -1, 11 → -3), 100 ms frames of 480 symbols:
 *
 *   · FS: the 40-bit sync D471C9634D;
 *   · FICH, 200 bits: 32 information bits (FI, CS, CM, BN, BT, FN, FT, MR, VoIP, DT, SQL, SC) and a CRC-16
 *     (x^16+x^12+x^5+1, register cleared, complemented), cut into four 12-bit pieces each Golay (24,12,8) coded,
 *     four zero tail bits, convolutionally coded (K = 5, G1 = 1 + D³ + D⁴, G2 = 1 + D + D² + D⁴, G1 first) and
 *     interleaved as dibits, 20 rows of 5 written across and sent down the columns;
 *   · 720 payload bits whose layout the FICH gives. Callsign data travels in units: 20 bytes (headers, terminators,
 *     V/D mode 1 and data full rate) or 10 bytes (V/D mode 2), whitened by PN (9,5) restarted for every unit
 *     (x^9 + x^5 + 1 from 111001001), a CRC-16 as the FICH's, four tail bits, the same convolutional code and a dibit
 *     interleave of 20 rows by 9 or 5.
 *
 * Headers and terminators carry CSD1 (destination, source) and CSD2 (downlink, uplink: the repeater's own callsign
 * on its output); V/D mode 1 rolls CSD1, CSD2, CSD3 (the four 5-byte remarks: the repeater's and the Internet
 * node's IDs and the radio ID) and data; V/D mode 2 rolls the same 10 bytes at a time. SC, the squelch code, is the
 * DG-ID. Text in the data units is searched for positions (NMEA, APRS). The voice goes out frame by frame
 * ([onVoiceFrame]): V/D mode 1 five 72-bit AMBE+2 frames in the VCHs, V/D mode 2 five 49-bit frames out of each VCH
 * and VeCH (voice.ts), Voice FR five 144-bit full rate frames (two in the sub header after the header). No DOM.
 */
import { YSF_K, YSF_G, viterbi, golay24Decode, crc16Msb, packMsb, asciiField } from './fec.js';
import { parsePositionLine, type Position } from './gps.js';
import { ysfVd2Voice, type HamVoiceFrame } from './voice.js';
import { wiresxReply, type WiresX } from './wiresx.js';

/** Sync symbols of D471C9634D. */
export const YSF_SYNC = (() => {
  const lv = [1, 3, -1, -3], out: number[] = [];
  for (const ch of 'D471C9634D') { const v = parseInt(ch, 16); out.push(lv[v >> 2], lv[v & 3]); }
  return Float64Array.from(out);
})();
const SYNC_E = YSF_SYNC.reduce((a, x) => a + x * x, 0);

/** The whitening sequence: PN (9,5), x^9 + x^5 + 1, S08..S00 = 111001001, output S00 (93 D7 51 ...). */
export function ysfWhitening(nBits: number): Uint8Array {
  const out = new Uint8Array(nBits); let s = 0x1c9;
  for (let i = 0; i < nBits; i++) { out[i] = s & 1; const fb = (s ^ (s >> 4)) & 1; s = (s >> 1) | (fb << 8); }
  return out;
}
const WHITE = ysfWhitening(160);

export interface YsfFich { fi: number; cs: number; cm: number; bn: number; bt: number; fn: number; ft: number; mr: number; voip: number; dt: number; sql: number; sc: number }
export function parseFich(w: number): YsfFich {
  return { fi: (w >>> 30) & 3, cs: (w >>> 28) & 3, cm: (w >>> 26) & 3, bn: (w >>> 24) & 3, bt: (w >>> 22) & 3, fn: (w >>> 19) & 7, ft: (w >>> 16) & 7, mr: (w >>> 11) & 7, voip: (w >>> 10) & 1, dt: (w >>> 8) & 3, sql: (w >>> 7) & 1, sc: w & 0x7f };
}

/** Dibits (sent order) of an interleaved, convolutionally coded block with [cols] columns of 20 rows → coded bits. */
function deinterleave(d: ArrayLike<number>, cols: number): Uint8Array {
  const n = d.length, bits = new Uint8Array(2 * n);
  for (let i = 0; i < n; i++) { const v = d[(i % cols) * 20 + Math.floor(i / cols)]; bits[2 * i] = (v >> 1) & 1; bits[2 * i + 1] = v & 1; }
  return bits;
}

/** 100 FICH dibits → the 32 information bits, or null when Golay or the CRC fails. */
export function decodeFich(d: ArrayLike<number>): number | null {
  const { bits } = viterbi(deinterleave(d, 5), YSF_K, YSF_G);
  const out = new Uint8Array(6);
  for (let g = 0; g < 4; g++) {
    let w = 0; for (let i = 0; i < 24; i++) w = (w << 1) | bits[24 * g + i];
    const r = golay24Decode(w); if (!r) return null;
    const x = r.data;                                     // 12 bits: g even → byte + high nibble, g odd → low nibble + byte
    if (g % 2 === 0) { out[3 * (g >> 1)] = x >> 4; out[3 * (g >> 1) + 1] = (x & 15) << 4; }
    else { out[3 * (g >> 1) + 1] |= x >> 8; out[3 * (g >> 1) + 2] = x & 255; }
  }
  if (crc16Msb(out, 4) !== ((out[4] << 8) | out[5])) return null;
  return ((out[0] << 24) | (out[1] << 16) | (out[2] << 8) | out[3]) >>> 0;
}

/** One data unit (180 dibits → 20 bytes, or 100 → 10), de-whitened, or null when the CRC fails. */
export function decodeUnit(d: ArrayLike<number>): Uint8Array | null {
  const nBytes = d.length === 180 ? 20 : 10, cols = d.length === 180 ? 9 : 5;
  const { bits } = viterbi(deinterleave(d, cols), YSF_K, YSF_G);
  const b = packMsb(bits, 0, nBytes + 2);
  if (crc16Msb(b, nBytes) !== ((b[nBytes] << 8) | b[nBytes + 1])) return null;
  const out = b.slice(0, nBytes);
  for (let i = 0; i < nBytes * 8; i++) if (WHITE[i]) out[i >> 3] ^= 0x80 >> (i & 7);
  return out;
}

export interface YsfId {
  dest: string; src: string; down: string; up: string; rem: [string, string, string, string];
  dgid: number; sqlOn: boolean; dt: number; callMode: number; route: number; voip: boolean;
  position: Position | null; positionText: string;
  frames: number; units: number; inverted: boolean; active: boolean;
  /** A WIRES-X reply the node sent (its name, the room it is connected to). */
  wires: WiresX | null;
}
const slice4 = (s: number) => s > 2 ? 1 : s > 0 ? 0 : s > -2 ? 2 : 3;

export class YsfReceiver {
  onFich: (f: YsfFich) => void = () => undefined;
  /** Each vocoder frame of a communication frame, stream 'ysf'. */
  onVoiceFrame: (f: HamVoiceFrame) => void = () => undefined;
  private frameAt = 0;
  private readonly ring = new Float64Array(20); private rp = 0;
  private sym: Float64Array | null = null; private sn = 0; private inv = 1;
  private t = 0; private lastSync = -1e9;
  private dtBytes: (Uint8Array | null)[] = [];
  syncs = 0;
  readonly id: YsfId = { dest: '', src: '', down: '', up: '', rem: ['', '', '', ''], dgid: -1, sqlOn: false, dt: -1, callMode: -1, route: -1, voip: false, position: null, positionText: '', frames: 0, units: 0, inverted: false, active: false, wires: null };

  reset(): void {
    this.ring.fill(0); this.rp = 0; this.sym = null; this.sn = 0; this.inv = 1; this.t = 0; this.lastSync = -1e9; this.dtBytes = []; this.syncs = 0;
    Object.assign(this.id, { dest: '', src: '', down: '', up: '', rem: ['', '', '', ''], dgid: -1, sqlOn: false, dt: -1, callMode: -1, route: -1, voip: false, position: null, positionText: '', frames: 0, units: 0, inverted: false, active: false, wires: null });
  }

  /** One soft symbol (outer levels near ±3). */
  pushSymbol(s: number): void {
    this.t++;
    if (this.sym) {
      this.sym[this.sn++] = s * this.inv;
      if (this.sn === 460) { const f = this.sym; this.sym = null; this.frame(f); }
      return;
    }
    this.ring[this.rp] = s; this.rp = (this.rp + 1) % 20;
    let c = 0, e = 0;
    for (let k = 0; k < 20; k++) { const x = this.ring[(this.rp + k) % 20]; c += x * YSF_SYNC[k]; e += x * x; }
    if (e <= 0) return;
    const corr = c / Math.sqrt(e * SYNC_E);
    // a sync where the last frame says the next one belongs needs less to be believed
    const expected = Math.abs(this.t - this.lastSync - 480) <= 1;
    const thr = expected ? 0.6 : 0.9;
    if (corr >= thr || corr <= -thr) {
      this.inv = corr > 0 ? 1 : -1; this.id.inverted = this.inv < 0;
      this.syncs++; this.lastSync = this.t; this.frameAt = this.t; this.sym = new Float64Array(460); this.sn = 0;
    }
  }

  private frame(f: Float64Array): void {
    const d = new Uint8Array(460); for (let i = 0; i < 460; i++) d[i] = slice4(f[i]);
    const w = decodeFich(d.subarray(0, 100));
    if (w === null) return;
    const fi = parseFich(w);
    this.id.frames++; this.id.active = fi.fi !== 2;
    this.id.dgid = fi.sc; this.id.sqlOn = fi.sql === 0; this.id.dt = fi.dt; this.id.callMode = fi.cm; this.id.route = fi.mr; this.id.voip = fi.voip === 1;
    this.onFich(fi);
    const p = d.subarray(100);
    const blocks = (first: number) => { const o = new Uint8Array(180); for (let j = 0; j < 5; j++) o.set(p.subarray((2 * j + first) * 36, (2 * j + first) * 36 + 36), 36 * j); return o; };
    if (fi.fi === 0) this.newCall();
    if (fi.fi === 1) this.voice(fi, p);
    if (fi.fi === 0 || fi.fi === 2) {                       // header / terminator: CSD1 in DCH-1, CSD2 in DCH-2
      this.csd(1, decodeUnit(blocks(0))); this.csd(2, decodeUnit(blocks(1)));
    } else if (fi.fi === 1) {
      if (fi.dt === 0) {                                   // V/D mode 1: one 20-byte unit, rolling with FN
        const u = decodeUnit(blocks(0));
        if (fi.fn <= 2) this.csd(fi.fn + 1, u); else this.data(fi.fn - 3, u);
      } else if (fi.dt === 2) {                            // V/D mode 2: 40-bit DCH pieces, one 10-byte unit
        const o = new Uint8Array(100); for (let j = 0; j < 5; j++) o.set(p.subarray(72 * j, 72 * j + 20), 20 * j);
        this.half(fi.fn, decodeUnit(o));
      } else if (fi.dt === 1) {                            // data full rate: two 20-byte units a frame
        const a = decodeUnit(blocks(0)), b = decodeUnit(blocks(1));
        if (fi.fn === 0) { this.csd(1, a); this.csd(2, b); } else if (fi.fn === 1) { this.csd(3, a); this.data(0, b); } else { this.data(2 * fi.fn - 3, a); this.data(2 * fi.fn - 2, b); }
      } else if (fi.dt === 3 && fi.fn === 0) {             // voice full rate: the sub header after the header carries CSD3
        this.csd(3, decodeUnit(p.subarray(0, 180)));
      }
    }
  }

  /** The vocoder frames of a communication frame's payload ([p], 360 dibits). */
  private voice(fi: YsfFich, p: Uint8Array): void {
    const bitsOf = (off: number, n: number) => { const b = new Uint8Array(2 * n); for (let i = 0; i < n; i++) { b[2 * i] = p[off + i] >> 1; b[2 * i + 1] = p[off + i] & 1; } return b; };
    const at = (off: number) => this.frameAt + 101 + off;
    if (fi.dt === 0) for (let j = 0; j < 5; j++) { const off = (2 * j + 1) * 36; this.onVoiceFrame({ stream: 'ysf', codec: 'ambe2', bits: bitsOf(off, 36), atSym: at(off), errs: 0 }); }
    else if (fi.dt === 2) for (let j = 0; j < 5; j++) { const off = 72 * j + 20, v = ysfVd2Voice(p.subarray(off, off + 52)); this.onVoiceFrame({ stream: 'ysf', codec: 'ambe2-49', bits: v.bits, atSym: at(off), errs: v.errs }); }
    else if (fi.dt === 3) for (const off of fi.fn === 0 && fi.ft === 1 ? [216, 288] : [0, 72, 144, 216, 288]) this.onVoiceFrame({ stream: 'ysf', codec: 'imbe', bits: bitsOf(off, 72), atSym: at(off), errs: 0 });
  }

  private newCall(): void {
    this.dtBytes = [];
    Object.assign(this.id, { dest: '', src: '', down: '', up: '', rem: ['', '', '', ''], position: null, positionText: '' });
  }
  private csd(n: number, u: Uint8Array | null): void {
    if (!u) return;
    this.id.units++;
    if (n === 1) { this.id.dest = asciiField(u, 0, 10); this.id.src = asciiField(u, 10, 10); }
    else if (n === 2) { this.id.down = asciiField(u, 0, 10); this.id.up = asciiField(u, 10, 10); }
    else for (let k = 0; k < 4; k++) this.id.rem[k] = asciiField(u, 5 * k, 5);
  }
  /** A V/D mode 2 unit by frame number: destination, source, downlink, uplink, remarks 1+2, remarks 3+4, data 1, data 2. */
  private half(fn: number, u: Uint8Array | null): void {
    if (!u) return;
    this.id.units++;
    const s = asciiField(u, 0, 10);
    if (fn === 0) this.id.dest = s; else if (fn === 1) this.id.src = s; else if (fn === 2) this.id.down = s; else if (fn === 3) this.id.up = s;
    else if (fn === 4) { this.id.rem[0] = asciiField(u, 0, 5); this.id.rem[1] = asciiField(u, 5, 5); }
    else if (fn === 5) { this.id.rem[2] = asciiField(u, 0, 5); this.id.rem[3] = asciiField(u, 5, 5); }
    else this.data(fn - 6, u);
  }
  /** Data unit [k] of the roll. The units read in order (as far as they have come in) are searched for a position line. */
  private data(k: number, u: Uint8Array | null): void {
    if (!u || k < 0 || k > 15) return;
    this.id.units++;
    this.dtBytes[k] = u;
    let s = '';
    const raw: number[] = [];
    for (let i = 0; i < this.dtBytes.length; i++) { const b = this.dtBytes[i]; if (!b) break; for (const v of b) { raw.push(v); if (v !== 0) s += String.fromCharCode(v); } }
    const w = wiresxReply(raw); if (w) this.id.wires = w;
    for (const line of s.split(/[\r\n]+/)) {
      const pos = parsePositionLine(line);
      if (pos) { this.id.position = pos; this.id.positionText = line.trim(); }
    }
  }
}
