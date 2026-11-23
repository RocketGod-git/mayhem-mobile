/**
 * M17, from the M17 Protocol Specification, Part I Air Interface (version 2.1.1): 4FSK at 4800 symbols/s, dibit
 * 01 → +3, 00 → +1, 10 → -1, 11 → -3, 40 ms frames of an 8-symbol sync burst and 184 payload symbols.
 *
 *   · syncs: LSF 55F7, stream FF5D, packet 75FF (BERT DF55). An inverted receiver sees the LSF sync as the stream
 *     sync and the other way around, so a frame is tried both ways and the one whose checks pass names the polarity;
 *   · every payload bit is XORed with the 46-byte randomizer (Appendix B) and the 368 bits are permuted by the
 *     quadratic polynomial (45x + 92x²) mod 368 (Appendix F, its own inverse);
 *   · LSF: DST, SRC (48-bit base-40 addresses, Appendix A), TYPE (16 bits: packet/stream, data type, encryption
 *     type and subtype, CAN, signed stream), META (14 bytes) and a CRC (x^16+x^14+x^12+x^11+x^8+x^5+x^4+x^2+1, 5935,
 *     register FFFF, not reflected), 4 flush bits, the K = 5 code (G1 = 1 + D³ + D⁴, G2 = 1 + D + D² + D⁴), P1;
 *   · stream frames: the LICH (a 40-bit sixth of the LSF, a 3-bit counter, 5 reserved bits, as four Golay (24,12)
 *     words) then the frame number (top bit: the last frame) and 16 bytes of payload, coded and punctured by P2.
 *     Six LICH pieces rebuild the LSF for a receiver that missed it;
 *   · packet frames: 25 bytes and a byte of EOF flag and frame or byte count, coded and punctured by P3; the packet
 *     ends with the same CRC, its first byte names the protocol (05 SMS text, 02 APRS);
 *   · META: text (a control byte and 13 characters a block, up to four blocks), GNSS position, or the extended
 *     callsign data a repeater adds (the originator, and the reflector the traffic came from).
 * Voice (Codec 2) comes out through [onVoice], one call per Codec 2 frame. No DOM.
 */
import { golay24Decode } from './fec.js';
import { parsePositionLine, type Position } from './gps.js';

export const M17_SYNC_LSF = 0x55f7, M17_SYNC_STREAM = 0xff5d, M17_SYNC_PACKET = 0x75ff;
/** A 16-bit sync word as its 8 symbols. */
export function syncSymbols(w: number): Float64Array {
  const lv = [1, 3, -1, -3], o = new Float64Array(8);
  for (let i = 0; i < 8; i++) o[i] = lv[(w >> (14 - 2 * i)) & 3];
  return o;
}
const S_LSF = syncSymbols(M17_SYNC_LSF), S_PKT = syncSymbols(M17_SYNC_PACKET);

/** Appendix B: the randomizer, 46 bytes, the first payload bit against bit 7 of the first byte. */
export const M17_RANDOMIZER = [
  0xd6, 0xb5, 0xe2, 0x30, 0x82, 0xff, 0x84, 0x62, 0xba, 0x4e, 0x96, 0x90, 0xd8, 0x98, 0xdd, 0x5d, 0x0c, 0xc8, 0x52, 0x43, 0x91, 0x1d, 0xf8,
  0x6e, 0x68, 0x2f, 0x35, 0xda, 0x14, 0xea, 0xcd, 0x76, 0x19, 0x8d, 0xd5, 0x80, 0xd1, 0x33, 0x87, 0x13, 0x57, 0x18, 0x2d, 0x29, 0x78, 0xc3,
];
const RAND_BIT = Uint8Array.from({ length: 368 }, (_, i) => (M17_RANDOMIZER[i >> 3] >> (7 - (i & 7))) & 1);
/** Appendix F: the interleaver, input bit i to output bit (45i + 92i²) mod 368. */
export const m17Interleave = (i: number) => (45 * i + 92 * i * i) % 368;
const QPP = Int32Array.from({ length: 368 }, (_, i) => m17Interleave(i));
/** Appendix E: P1 (a leading 1 and 1011 fifteen times), P2 (eleven of twelve), P3 (seven of eight). */
export const M17_P1 = [1, ...Array.from({ length: 15 }, () => [1, 0, 1, 1]).flat()];
export const M17_P2 = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
export const M17_P3 = [1, 1, 1, 1, 1, 1, 1, 0];
const G = [0b11001, 0b10111];

/** The M17 CRC (section 2.6) over [n] bytes; over the data and its two CRC bytes it is zero. */
export function m17Crc(b: ArrayLike<number>, n: number): number {
  let crc = 0xffff;
  for (let i = 0; i < n; i++) {
    crc ^= (b[i] & 255) << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x5935) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const B40 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.';
/** Six bytes (big endian) → the address as text: '@ALL' for broadcast, '' for zero, '#' and hex above the base-40 range. */
export function m17Address(b: ArrayLike<number>, from = 0): string {
  let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + (b[from + i] & 255);
  if (v === 0xffffffffffff) return '@ALL';
  if (v >= 0xee6b28000000) return '#' + v.toString(16).toUpperCase();
  let s = '';
  while (v > 0) { s += B40[v % 40]; v = Math.floor(v / 40); }
  return s.replace(/\s+$/, '');
}
/** Text → the 48-bit address (the first character in the lowest digit), at most nine characters. */
export function m17Encode(call: string): number {
  let v = 0; const s = call.toUpperCase().slice(0, 9);
  for (let i = s.length - 1; i >= 0; i--) { const k = B40.indexOf(s[i]); v = v * 40 + (k > 0 ? k : 0); }
  return v;
}

// ------------------------------------------------------------------------------------------------ decoding blocks
/** Soft bits of one payload symbol, positive for a 1: the first is the sign (negative symbols), the second outer. */
function softBits(s: number, out: Float64Array, at: number): void {
  const c = s > 4 ? 4 : s < -4 ? -4 : s;
  out[at] = -c; out[at + 1] = (c < 0 ? -c : c) - 2;
}
/** 184 symbols (polarity applied) → 368 soft Type 2/3 bits, de-randomized and de-interleaved. */
export function frameSoft(sym: ArrayLike<number>, inv: number): Float64Array {
  const raw = new Float64Array(368), out = new Float64Array(368);
  for (let i = 0; i < 184; i++) softBits(sym[i] * inv, raw, 2 * i);
  for (let i = 0; i < 368; i++) { const v = RAND_BIT[i] ? -raw[i] : raw[i]; out[i] = v; }
  const de = new Float64Array(368);
  for (let i = 0; i < 368; i++) de[i] = out[QPP[i]];
  return de;
}
/** Puncture pattern [p] over [n] Type 2 bits: received soft bits back in place, zeros (no opinion) where cut. */
function depuncture(rx: ArrayLike<number>, from: number, count: number, p: number[], n: number): Float64Array {
  const o = new Float64Array(n); let k = from;
  for (let i = 0; i < n && k < from + count; i++) if (p[i % p.length]) o[i] = rx[k++];
  return o;
}
const par = (x: number) => { x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1; return x & 1; };
/**
 * Soft Viterbi for the K = 5 code: pairs of soft bits (positive = 1, zero = punctured) → the input bits, ending in
 * state 0. [errs] counts received bits (not punctured) whose sign disagrees with the chosen path.
 */
export function m17Viterbi(soft: ArrayLike<number>): { bits: Uint8Array; errs: number } {
  const S = 16, n = soft.length >> 1;
  let pm = new Float64Array(S).fill(-1e30); pm[0] = 0;
  let nx = new Float64Array(S);
  const from = new Uint8Array(n * S), prev = new Uint8Array(n * S);
  const o0 = new Uint8Array(32), o1 = new Uint8Array(32);
  for (let s = 0; s < S; s++) for (let b = 0; b < 2; b++) { const r = ((s << 1) | b) & 31; o0[s * 2 + b] = par(r & G[0]); o1[s * 2 + b] = par(r & G[1]); }
  for (let i = 0; i < n; i++) {
    nx.fill(-1e30);
    const c0 = soft[2 * i], c1 = soft[2 * i + 1];
    for (let s = 0; s < S; s++) {
      const base = pm[s]; if (base <= -1e29) continue;
      for (let b = 0; b < 2; b++) {
        const ns = ((s << 1) | b) & 15;
        const d = base + (o0[s * 2 + b] ? c0 : -c0) + (o1[s * 2 + b] ? c1 : -c1);
        if (d > nx[ns]) { nx[ns] = d; from[i * S + ns] = b; prev[i * S + ns] = s; }
      }
    }
    const t = pm; pm = nx; nx = t;
  }
  const bits = new Uint8Array(n);
  let s = 0;
  for (let i = n - 1; i >= 0; i--) { bits[i] = from[i * S + s]; s = prev[i * S + s]; }
  let errs = 0, r = 0;
  for (let i = 0; i < n; i++) {
    r = ((r << 1) | bits[i]) & 31;
    const c0 = soft[2 * i], c1 = soft[2 * i + 1];
    if ((c0 > 0 && !par(r & G[0])) || (c0 < 0 && par(r & G[0]))) errs++;
    if ((c1 > 0 && !par(r & G[1])) || (c1 < 0 && par(r & G[1]))) errs++;
  }
  return { bits, errs };
}
const bytesOf = (bits: ArrayLike<number>, from: number, n: number) => {
  const o = new Uint8Array(n); for (let i = 0; i < n * 8; i++) if (bits[from + i]) o[i >> 3] |= 0x80 >> (i & 7); return o;
};

/** 368 soft bits → the 30 LSF bytes and the bit errors the code corrected, or null when the CRC fails. */
export function decodeLsf(soft: ArrayLike<number>): { lsf: Uint8Array; errs: number } | null {
  const { bits, errs } = m17Viterbi(depuncture(soft, 0, 368, M17_P1, 488));
  const b = bytesOf(bits, 0, 30);
  if (m17Crc(b, 30) !== 0 || b.every(v => v === 0)) return null;
  return { lsf: b, errs };
}
/** The LICH: four Golay words → its 6 bytes and the errors corrected, or null. */
export function decodeLich(soft: ArrayLike<number>): { lich: Uint8Array; errs: number } | null {
  const o = new Uint8Array(6); let errs = 0;
  for (let g = 0; g < 4; g++) {
    let w = 0; for (let i = 0; i < 24; i++) w = (w << 1) | (soft[24 * g + i] > 0 ? 1 : 0);
    const r = golay24Decode(w); if (!r) return null;
    errs += r.errs;
    const x = r.data;
    if (g % 2 === 0) { o[3 * (g >> 1)] = x >> 4; o[3 * (g >> 1) + 1] = (x & 15) << 4; }
    else { o[3 * (g >> 1) + 1] |= x >> 8; o[3 * (g >> 1) + 2] = x & 255; }
  }
  return { lich: o, errs };
}
/** A stream frame's contents: the frame number and 16 payload bytes, and the errors corrected. */
export function decodeStream(soft: ArrayLike<number>): { fn: number; payload: Uint8Array; errs: number } {
  const { bits, errs } = m17Viterbi(depuncture(soft, 96, 272, M17_P2, 296));
  const b = bytesOf(bits, 0, 18);
  return { fn: (b[0] << 8) | b[1], payload: b.slice(2), errs };
}
/** A packet frame: 25 bytes, the EOF flag and the frame number (EOF 0) or byte count (EOF 1). */
export function decodePacket(soft: ArrayLike<number>): { data: Uint8Array; eof: boolean; count: number; errs: number } {
  const { bits, errs } = m17Viterbi(depuncture(soft, 0, 368, M17_P3, 420));
  const b = bytesOf(bits, 0, 26);
  return { data: b.slice(0, 25), eof: (b[25] & 0x80) !== 0, count: (b[25] >> 2) & 31, errs };
}

// ------------------------------------------------------------------------------------------------ LSF contents
export interface M17Lsf {
  dst: string; src: string; type: number;
  stream: boolean; dataType: number; encType: number; encSub: number; can: number; signed: boolean;
  meta: Uint8Array;
}
export function parseLsf(b: ArrayLike<number>): M17Lsf {
  const type = ((b[12] & 255) << 8) | (b[13] & 255);
  return {
    dst: m17Address(b, 0), src: m17Address(b, 6), type,
    stream: (type & 1) === 1, dataType: (type >> 1) & 3, encType: (type >> 3) & 3, encSub: (type >> 5) & 3, can: (type >> 7) & 15, signed: ((type >> 11) & 1) === 1,
    meta: Uint8Array.from({ length: 14 }, (_, i) => b[14 + i] & 255),
  };
}
/** GNSS META (META type 01): the position when its validity bit says so, and the rest as numbers. */
export function parseGnss(m: ArrayLike<number>): { pos: Position | null; source: number; station: number; radiusM: number; bearing: number; speedKmh: number } {
  const valid = (m[1] >> 4) & 15;
  const s24 = (i: number) => { const v = ((m[i] & 255) << 16) | ((m[i + 1] & 255) << 8) | (m[i + 2] & 255); return v & 0x800000 ? v - 0x1000000 : v; };
  let pos: Position | null = null;
  if (valid & 8) {
    const lat = s24(3) * 90 / 8388607, lon = s24(6) * 180 / 8388607;
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      pos = { lat, lon, source: 'm17-gnss' };
      if (valid & 4) pos.alt = (((m[9] & 255) << 8) | (m[10] & 255)) * 0.5 - 500;
    }
  }
  return {
    pos, source: (m[0] >> 4) & 15, station: m[0] & 15,
    radiusM: valid & 1 ? 1 << ((m[1] >> 1) & 7) : -1,
    bearing: valid & 2 ? (((m[1] & 1) << 8) | (m[2] & 255)) : -1,
    speedKmh: valid & 2 ? ((((m[11] & 255) << 4) | ((m[12] & 255) >> 4)) * 0.5) : -1,
  };
}
/** "M17-M17 C" → the reflector and its module; anything else gives none. */
export function reflectorOf(s: string): { name: string; module: string } | null {
  const m = /^([A-Z0-9][A-Z0-9-]{2,7}) +([A-Z])$/.exec(s);
  return m ? { name: m[1], module: m[2] } : null;
}

export interface M17Id {
  dst: string; src: string; can: number;
  /** 'voice', 'voice+data', 'data' (stream mode) or 'packet'; '' until an LSF is known. */
  kind: string;
  /** Codec 2 rate of the voice: 3200, 1600, or 0. */
  codec: number;
  encryption: string; signed: boolean;
  /** Where the LSF came from: 'lsf' (the link setup frame) or 'lich' (six LICH pieces, joined late). */
  lsfFrom: string;
  /** META: the text message, the GNSS position, the extended callsign data (originator, reflector and module). */
  text: string; position: Position | null; gnssStation: number; originator: string; reflector: string; module: string;
  /** The last packet: its protocol byte, and its text (SMS, or the APRS line). */
  packetProto: number; packetText: string;
  lsfs: number; frames: number; packets: number; fn: number; ended: boolean; inverted: boolean;
  /** Codec 2 frames sent to [onVoice]. */
  voiceFrames: number;
}
const freshId = (): M17Id => ({ dst: '', src: '', can: -1, kind: '', codec: 0, encryption: '', signed: false, lsfFrom: '', text: '', position: null, gnssStation: -1, originator: '', reflector: '', module: '', packetProto: -1, packetText: '', lsfs: 0, frames: 0, packets: 0, fn: -1, ended: false, inverted: false, voiceFrames: 0 });

const ENC = ['', 'scrambler', 'AES', 'other'];
const KIND = ['', 'data', 'voice', 'voice+data'];
const MAX_ERRS = 28;

/** Pending frame: where its payload starts and the (kind, polarity) its sync allows. */
interface Pending { at: number; tries: [number, number][] }

export class M17Receiver {
  /** A Codec 2 frame of the stream: its bytes (8) and rate (3200 or 1600). */
  onVoice: (frame: Uint8Array, rate: number) => void = () => undefined;
  readonly id: M17Id = freshId();
  private readonly ring = new Float64Array(512); private t = 0;
  private pend: Pending[] = [];
  private lastFrame = -1e9; private inv = 0;
  private lsf: M17Lsf | null = null;
  private lich = new Uint8Array(30); private lichMask = 0;
  private textBlk: string[] = ['', '', '', '']; private textCtl = 0;
  private pkt: number[] = []; private pktNext = 0;

  reset(): void {
    this.ring.fill(0); this.t = 0; this.pend = []; this.lastFrame = -1e9; this.inv = 0; this.lsf = null;
    this.lich.fill(0); this.lichMask = 0; this.textBlk = ['', '', '', '']; this.textCtl = 0; this.pkt = []; this.pktNext = 0;
    Object.assign(this.id, freshId());
  }

  /** One soft symbol (outer levels near ±3). */
  pushSymbol(s: number): void {
    this.ring[this.t & 511] = s; this.t++;
    const t = this.t;
    // a sync burst ends here: the payload starts at t
    let c = 0, e = 0, cp = 0;
    for (let k = 0; k < 8; k++) { const x = this.ring[(t - 8 + k) & 511]; c += x * S_LSF[k]; cp += x * S_PKT[k]; e += x * x; }
    if (e > 0) {
      const n = Math.sqrt(e * 72), cl = c / n, cpk = cp / n, mag = Math.sqrt(e / 8);
      const expected = Math.abs(t - this.lastFrame - 192) <= 1;
      const thr = expected ? 0.5 : 0.88;
      if (mag > 1.5 || expected) {
        const tries: [number, number][] = [];
        // kind 0 LSF, 1 stream, 2 packet; the locked polarity first
        if (cl >= thr) tries.push([0, 1], [1, -1]);
        if (cl <= -thr) tries.push([1, 1], [0, -1]);
        if (cpk >= thr) tries.push([2, 1]);
        if (cpk <= -thr) tries.push([2, -1]);
        if (tries.length) {
          if (this.inv) tries.sort((a, b) => (a[1] === this.inv ? 0 : 1) - (b[1] === this.inv ? 0 : 1));
          this.pend.push({ at: t, tries });
        }
      }
    }
    while (this.pend.length && t - this.pend[0].at >= 184) {
      const p = this.pend.shift()!;
      if (p.at - this.lastFrame < 190) continue;                    // inside a frame already read
      this.frame(p);
    }
  }

  private frame(p: Pending): void {
    const sym = new Float64Array(184);
    for (let i = 0; i < 184; i++) sym[i] = this.ring[(p.at + i) & 511];
    for (const [kind, inv] of p.tries) {
      const soft = frameSoft(sym, inv);
      if (kind === 0) {
        const r = decodeLsf(soft);
        if (!r) continue;
        this.locked(p.at, inv); this.gotLsf(r.lsf, 'lsf'); return;
      }
      if (kind === 1) {
        const l = decodeLich(soft); if (!l) continue;
        const cnt = l.lich[5] >> 5; if (cnt > 5) continue;
        const st = decodeStream(soft); if (st.errs > MAX_ERRS) continue;
        this.locked(p.at, inv); this.stream(l.lich, cnt, st.fn, st.payload); return;
      }
      const pk = decodePacket(soft);
      if (pk.errs > MAX_ERRS || (pk.eof && (pk.count < 1 || pk.count > 25))) continue;
      this.locked(p.at, inv); this.packet(pk.data, pk.eof, pk.count); return;
    }
  }
  private locked(at: number, inv: number): void { this.lastFrame = at; this.inv = inv; this.id.inverted = inv < 0; }

  private gotLsf(b: Uint8Array, from: string): void {
    const l = parseLsf(b);
    const same = this.lsf && this.lsf.src === l.src && this.lsf.dst === l.dst && this.lsf.type === l.type;
    if (from === 'lsf' || !same) this.newCall();
    this.lsf = l;
    const id = this.id;
    id.lsfs += from === 'lsf' ? 1 : 0; id.lsfFrom = from;
    id.dst = l.dst; id.src = l.src; id.can = l.can; id.signed = l.signed;
    id.kind = l.stream ? KIND[l.dataType] : 'packet';
    id.codec = l.stream && l.encType === 0 ? (l.dataType === 2 ? 3200 : l.dataType === 3 ? 1600 : 0) : 0;
    id.encryption = l.stream ? ENC[l.encType] : '';
    id.ended = false;
    if (!l.stream || l.encType === 0) this.meta(l.encSub, l.meta);
    // the destination may itself name a reflector module ("M17-M17 C")
    if (!id.reflector) { const r = reflectorOf(l.dst); if (r) { id.reflector = r.name; id.module = r.module; } }
  }
  private meta(kind: number, m: Uint8Array): void {
    const id = this.id;
    if (kind === 0) {
      const ctl = m[0]; if (ctl === 0) return;
      let blk = -1; for (let i = 0; i < 4; i++) if (ctl & (1 << i)) { blk = i; break; }
      if (blk < 0) return;
      let s = ''; for (let i = 1; i < 14; i++) { const c = m[i]; s += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 0 ? '' : '?'; }
      this.textBlk[blk] = s; this.textCtl |= ctl;
      const need = this.textCtl >> 4;
      let t = ''; for (let i = 0; i < 4; i++) if (need & (1 << i) || this.textBlk[i]) t += this.textBlk[i];
      id.text = t.replace(/\s+$/, '');
    } else if (kind === 1) {
      const g = parseGnss(m);
      if (g.pos) id.position = g.pos;
      id.gnssStation = g.station;
    } else if (kind === 2) {
      id.originator = m17Address(m, 0);
      const r2 = m17Address(m, 6);
      const r = reflectorOf(r2);
      if (r) { id.reflector = r.name; id.module = r.module; } else if (r2) { id.reflector = r2; id.module = ''; }
    }
  }
  private newCall(): void {
    const id = this.id;
    Object.assign(id, { text: '', position: null, gnssStation: -1, originator: '', reflector: '', module: '', fn: -1, ended: false });
    this.textBlk = ['', '', '', '']; this.textCtl = 0; this.pkt = []; this.pktNext = 0;
  }

  private stream(lich: Uint8Array, cnt: number, fn: number, payload: Uint8Array): void {
    const id = this.id;
    id.frames++;
    // the LICH piece; a full set whose CRC checks is the LSF of a call joined late, or META that changed
    for (let i = 0; i < 5; i++) this.lich[5 * cnt + i] = lich[i];
    this.lichMask |= 1 << cnt;
    if (cnt === 5 && this.lichMask === 63 && m17Crc(this.lich, 30) === 0) {
      const l = parseLsf(this.lich);
      if (!this.lsf || l.src !== this.lsf.src || l.dst !== this.lsf.dst || l.type !== this.lsf.type) this.gotLsf(this.lich.slice(), 'lich');
      else if (l.encType === 0) { this.lsf = l; this.meta(l.encSub, l.meta); }
    }
    if (cnt === 5) this.lichMask = 0;
    id.fn = fn & 0x7fff; id.ended = (fn & 0x8000) !== 0;
    const l = this.lsf;
    if (l && l.stream && l.encType === 0 && (fn & 0x7fff) < 0x7ffb) {
      if (l.dataType === 2) { this.onVoice(payload.slice(0, 8), 3200); this.onVoice(payload.slice(8, 16), 3200); id.voiceFrames += 2; }
      else if (l.dataType === 3) { this.onVoice(payload.slice(0, 8), 1600); id.voiceFrames++; }
    }
  }

  private packet(data: Uint8Array, eof: boolean, count: number): void {
    const id = this.id;
    id.frames++;
    if (!eof) {
      if (count !== this.pktNext) { this.pkt = []; this.pktNext = 0; if (count !== 0) return; }
      for (const v of data) this.pkt.push(v);
      this.pktNext++;
      return;
    }
    for (let i = 0; i < count; i++) this.pkt.push(data[i]);
    const b = this.pkt; this.pkt = []; this.pktNext = 0;
    if (b.length < 3 || m17Crc(b, b.length) !== 0) return;
    id.packets++;
    id.packetProto = b[0];
    let s = ''; for (let i = 1; i < b.length - 2; i++) { const c = b[i]; if (c === 0) break; s += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 10 || c === 13 ? '\n' : '?'; }
    id.packetText = s;
    if (b[0] === 0x02 || b[0] === 0x05) for (const line of s.split('\n')) { const p = parsePositionLine(line); if (p) id.position = p; }
  }
}
