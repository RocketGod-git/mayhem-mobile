/**
 * DMR (ETSI TS 102 361) receiver fed with the NFM discriminator: 4FSK at 4800 symbols/s (the transmitter's
 * raised-cosine pulses are Nyquist, so the receiver band-limits and samples at the symbol centers), sync-word
 * correlation for symbol timing and eye levels, then per 30 ms time slot:
 *   · CACH (which slot), slot type via Golay (20,8): color code + data type
 *   · BPTC(196,96) for voice LC headers / terminators (RS(12,9) checked) and CSBKs (CRC-CCITT checked)
 *   · EMB via QR(16,7) plus the embedded LC spread over voice bursts B–E (Hamming 16,11,4, column parity,
 *     5-bit checksum) — talkgroup, source ID and talker alias mid-call
 *   · the three AMBE+2 voice frames per burst, de-interleaved and handed to the vocoder
 * Both time slots are followed; the audio follows one of them. The same correlator recognizes P25, D-STAR,
 * NXDN and Fusion (YSF) sync words so the DIGITAL tab can name a digital voice signal we do not decode (yet).
 */
import { AmbeDecoder, golay208, popcount, c0Clean } from './mbe.js';
import { RealFir, lowpassTaps } from './filters.js';
import { P25Decoder } from './p25.js';
import { ImbeDecoder } from './imbe.js';

const RATE = 48_000, SPS = 10, SLOT = 144, RING = 4096, MASK = RING - 1;

// AMBE frame de-interleave (which row / bit of the 4 code words each of the 36 dibits feeds)
const rW = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2];
const rX = [23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4];
const rY = [0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3];
const rZ = [5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4, 14, 3, 13, 2, 12, 1, 11, 0];

// ------------------------------------------------------------------------------------------- sync words
interface Sync { proto: string; kind: 'voice' | 'data' | ''; src: string; s: Int8Array; sp: number; thr: number }
/** Symbol signs from a hex sync word (each dibit: MSB set → −). */
function fromHex(hex: string): Int8Array {
  const out: number[] = [];
  for (const ch of hex) { const v = parseInt(ch, 16); out.push((v & 8) ? -1 : 1, (v & 2) ? -1 : 1); }
  return Int8Array.from(out);
}
const fromSigns = (s: string) => Int8Array.from([...s].map(c => c === '1' ? 1 : -1));
const inv = (a: Int8Array) => a.map(v => -v);
const SYNCS: Sync[] = [
  { proto: 'DMR', kind: 'voice', src: 'BS', s: fromHex('755FD7DF75F7'), sp: 10, thr: 0.82 },
  { proto: 'DMR', kind: 'data', src: 'BS', s: fromHex('DFF57D75DF5D'), sp: 10, thr: 0.82 },
  { proto: 'DMR', kind: 'voice', src: 'MS', s: fromHex('7F7D5DD57DFD'), sp: 10, thr: 0.82 },
  { proto: 'DMR', kind: 'data', src: 'MS', s: fromHex('D5D7F77FD757'), sp: 10, thr: 0.82 },
  { proto: 'DMR', kind: 'voice', src: 'DM1', s: fromHex('5D577F7757FF'), sp: 10, thr: 0.82 },
  { proto: 'DMR', kind: 'data', src: 'DM1', s: fromHex('F7FDD5DDFD55'), sp: 10, thr: 0.82 },
  { proto: 'DMR', kind: 'voice', src: 'DM2', s: fromHex('7DFFD5F55D5F'), sp: 10, thr: 0.82 },
  { proto: 'DMR', kind: 'data', src: 'DM2', s: fromHex('D7557F5FF7F5'), sp: 10, thr: 0.82 },
  { proto: 'P25', kind: '', src: '', s: fromHex('5575F5FF77FF'), sp: 10, thr: 0.86 },
  { proto: 'P25', kind: '', src: 'inv', s: inv(fromHex('5575F5FF77FF')), sp: 10, thr: 0.86 },
  { proto: 'D-STAR', kind: '', src: '', s: fromSigns('313131313133131113313111'), sp: 10, thr: 0.95 },
  { proto: 'D-STAR', kind: '', src: 'inv', s: inv(fromSigns('313131313133131113313111')), sp: 10, thr: 0.95 },
  { proto: 'YSF', kind: '', src: '', s: fromHex('D471C9634D'), sp: 10, thr: 0.95 },
  { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131111333'), sp: 20, thr: 0.95 },
  { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131113133'), sp: 20, thr: 0.95 },
  { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131111313'), sp: 20, thr: 0.95 },
  { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131113113'), sp: 20, thr: 0.95 },
  { proto: 'NXDN', kind: '', src: 'inv', s: inv(fromSigns('313133113131111333')), sp: 20, thr: 0.95 },
  { proto: 'NXDN', kind: '', src: 'inv', s: inv(fromSigns('313133113131113133')), sp: 20, thr: 0.95 },
];
const DMR_SYNCS = SYNCS.filter(s => s.proto === 'DMR');

// ------------------------------------------------------------------------------------------- block codes
/** Hamming single-error correction: `eq` lists, per parity bit, the data bits (as a mask) it covers. Returns 0 ok, 1 corrected, −1 uncorrectable. */
function hamming(bits: Uint8Array, off: number, k: number, eq: number[]): number {
  let syn = 0;
  for (let p = 0; p < eq.length; p++) {
    let c = 0; const m = eq[p];
    for (let i = 0; i < k; i++) if (m & (1 << i)) c ^= bits[off + i];
    syn |= (c ^ bits[off + k + p]) << p;
  }
  if (syn === 0) return 0;
  for (let i = 0; i < k; i++) {
    let col = 0;
    for (let p = 0; p < eq.length; p++) if (eq[p] & (1 << i)) col |= 1 << p;
    if (col === syn) { bits[off + i] ^= 1; return 1; }
  }
  for (let p = 0; p < eq.length; p++) if (syn === (1 << p)) { bits[off + k + p] ^= 1; return 1; }
  return -1;
}
const mask = (...idx: number[]) => idx.reduce((m, i) => m | (1 << i), 0);
const H15113 = [mask(0, 1, 2, 3, 5, 7, 8), mask(1, 2, 3, 4, 6, 8, 9), mask(2, 3, 4, 5, 7, 9, 10), mask(0, 1, 2, 4, 6, 7, 10)];
const H16114 = [...H15113, mask(0, 2, 5, 6, 8, 9, 10)];
const H1393 = [mask(0, 1, 3, 5, 6), mask(0, 1, 2, 4, 6, 7), mask(0, 1, 2, 3, 5, 7, 8), mask(0, 2, 4, 5, 8)];

/** BPTC(196,96): 196 received bits → 12 bytes (errors corrected where the row/column Hamming codes allow). */
function bptc(raw: Uint8Array): Uint8Array {
  const de = new Uint8Array(196), col = new Uint8Array(13);
  for (let a = 0; a < 196; a++) de[a] = raw[(a * 181) % 196];
  for (let pass = 0; pass < 5; pass++) {
    let fixing = false;
    for (let c = 0; c < 15; c++) {
      for (let a = 0; a < 13; a++) col[a] = de[c + 1 + a * 15];
      if (hamming(col, 0, 9, H1393) === 1) { fixing = true; for (let a = 0; a < 13; a++) de[c + 1 + a * 15] = col[a]; }
    }
    for (let r = 0; r < 9; r++) if (hamming(de, r * 15 + 1, 11, H15113) === 1) fixing = true;
    if (!fixing) break;
  }
  const out = new Uint8Array(12);
  let pos = 0;
  const take = (a: number) => { if (de[a]) out[pos >> 3] |= 0x80 >> (pos & 7); pos++; };
  for (let a = 4; a <= 11; a++) take(a);
  for (let r = 1; r < 9; r++) for (let a = r * 15 + 1; a <= r * 15 + 11; a++) take(a);
  return out;
}

// Reed-Solomon (12,9) over GF(256), generator 0x11d, used as a check only
const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]; }
const gmul = (a: number, b: number) => a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
const RS_POLY = [64, 56, 14, 1];
function rs129ok(b: Uint8Array): boolean {
  const par = [0, 0, 0, 0];
  for (let i = 0; i < 9; i++) {
    const d = b[i] ^ par[2];
    par[2] = par[1] ^ gmul(RS_POLY[2], d); par[1] = par[0] ^ gmul(RS_POLY[1], d); par[0] = gmul(RS_POLY[0], d);
  }
  return b[9] === par[2] && b[10] === par[1] && b[11] === par[0];
}
// CRC-CCITT (poly 0x1021, init 0, final complement), stored big-endian in the last two bytes
const CRC_T = new Uint16Array(256);
for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; CRC_T[i] = c; }
function crcOk(b: Uint8Array, n: number): boolean {
  let crc = 0;
  for (let i = 0; i < n - 2; i++) crc = ((crc << 8) & 0xffff) ^ CRC_T[((crc >> 8) ^ b[i]) & 0xff];
  crc = ~crc & 0xffff;
  return (crc >> 8) === b[n - 2] && (crc & 0xff) === b[n - 1];
}
// QR (16,7,6) for the EMB: 15-bit word (7 data + 8 parity, the final parity bit dropped), generator 0x139
function qrSyn(x: number): number { for (let i = 14; i >= 8; i--) if (x & (1 << i)) x ^= 0x139 << (i - 8); return x & 0xff; }
const QR_FIX = new Int16Array(256).fill(-1);
QR_FIX[0] = 0;
for (let i = 0; i < 15; i++) { QR_FIX[qrSyn(1 << i)] = 1 << i; for (let j = i + 1; j < 15; j++) QR_FIX[qrSyn((1 << i) | (1 << j))] = (1 << i) | (1 << j); }
/** Returns data | corrections << 8, or −1. */
function qr167(word15: number): number { const e = QR_FIX[qrSyn(word15)]; return e < 0 ? -1 : ((word15 ^ e) >> 8) | (popcount(e) << 8); }

// ------------------------------------------------------------------------------------------- link control
export interface Lc { flco: number; fid: number; opts: number; dst: number; src: number }
function parseLc(b: Uint8Array): Lc { return { flco: b[0] & 0x3f, fid: b[1], opts: b[2], dst: b[3] << 16 | b[4] << 8 | b[5], src: b[6] << 16 | b[7] << 8 | b[8] }; }

/** Collects the four 32-bit embedded-LC fragments of a voice superframe and validates the 128-bit block. */
class EmbeddedLc {
  private readonly raw = new Uint8Array(128);
  private state = 0;
  reset(): void { this.state = 0; }
  add(frag: Uint8Array, lcss: number): Uint8Array | null {
    if (lcss === 1) { this.raw.set(frag, 0); this.state = 1; return null; }
    if (lcss === 3 && this.state === 1) { this.raw.set(frag, 32); this.state = 2; return null; }
    if (lcss === 3 && this.state === 2) { this.raw.set(frag, 64); this.state = 3; return null; }
    if (lcss === 2 && this.state === 3) { this.raw.set(frag, 96); this.state = 0; return this.decode(); }
    if (lcss !== 0) this.state = 0;
    return null;
  }
  private decode(): Uint8Array | null {
    const data = new Uint8Array(128);
    for (let a = 0, b = 0; a < 128; a++) { data[b] = this.raw[a]; b += 16; if (b > 127) b -= 127; }
    for (let a = 0; a < 112; a += 16) if (hamming(data, a, 11, H16114) < 0) return null;
    for (let a = 0; a < 16; a++) { let p = 0; for (let r = 0; r < 8; r++) p ^= data[a + 16 * r]; if (p) return null; }
    const bytes = new Uint8Array(9);
    let pos = 0;
    const take = (a: number) => { if (data[a]) bytes[pos >> 3] |= 0x80 >> (pos & 7); pos++; };
    for (let a = 0; a < 11; a++) take(a);
    for (let a = 16; a < 27; a++) take(a);
    for (let a = 32; a < 42; a++) take(a);
    for (let a = 48; a < 58; a++) take(a);
    for (let a = 64; a < 74; a++) take(a);
    for (let a = 80; a < 90; a++) take(a);
    for (let a = 96; a < 106; a++) take(a);
    const crc = data[42] << 4 | data[58] << 3 | data[74] << 2 | data[90] << 1 | data[106];
    let sum = 0; for (let i = 0; i < 9; i++) sum += bytes[i];
    return sum % 31 === crc ? bytes : null;
  }
}

const FIDS: Record<number, string> = { 0: '', 16: 'MOTOROLA', 104: 'HYTERA', 6: 'TRIDENT', 8: 'SELEX', 51: 'SIMOCO', 60: 'RADIODATA', 88: 'TAIT' };
const CSBKO: Record<number, string> = { 0x04: 'UNIT-TO-UNIT REQUEST', 0x05: 'UNIT-TO-UNIT ANSWER', 0x07: 'CHANNEL TIMING', 0x1c: 'AHOY', 0x1f: 'CALL ALERT', 0x20: 'CALL ALERT ACK', 0x21: 'ACK', 0x24: 'RADIO CHECK', 0x26: 'NACK', 0x27: 'EMERGENCY', 0x28: 'BROADCAST', 0x2a: 'MAINTENANCE', 0x2e: 'CLEAR', 0x30: 'PRIVATE VOICE GRANT', 0x31: 'TALKGROUP VOICE GRANT', 0x38: 'BS OUTBOUND ACTIVATION', 0x3d: 'PREAMBLE' };
const DATA_TYPES = ['PI HEADER', 'VOICE HEADER', 'END OF CALL', 'CSBK', 'MBC HEADER', 'MBC', 'DATA HEADER', 'RATE ½ DATA', 'RATE ¾ DATA', 'IDLE', 'RATE 1 DATA'];

// ------------------------------------------------------------------------------------------- time slot
export interface SlotStatus { voice: boolean; tg: number; src: number; group: boolean; alias: string; cc: number; last: string; since: number; errs: number }
class TimeSlot {
  voice = false; seq = -1;
  tg = 0; src = 0; group = true; alias = ''; cc = -1;
  last = ''; since = 0;
  errs = 0; frames = 0;
  lastLog = ''; lastLogAt = -1e9;
  readonly ambe = new AmbeDecoder();
  readonly emb = new EmbeddedLc();
  private aliasParts: string[] = ['', '', '', ''];
  private aliasFmt = 1;
  setLc(lc: Lc): boolean {
    if (lc.flco >= 4 && lc.flco <= 7) { this.talkerAlias(lc); return false; }
    if (lc.flco === 8) return false;                       // GPS info, not shown
    const changed = lc.dst !== this.tg || lc.src !== this.src;
    this.tg = lc.dst; this.src = lc.src; this.group = lc.flco === 0;
    return changed;
  }
  status(): SlotStatus { return { voice: this.voice, tg: this.tg, src: this.src, group: this.group, alias: this.alias, cc: this.cc, last: this.last, since: this.since, errs: this.frames ? this.errs / this.frames : 0 }; }
  endCall(): void { this.voice = false; this.seq = -1; this.emb.reset(); this.ambe.reset(); }
  /** Talker alias (FLCO 4 header + 5..7 blocks): 7-bit, ISO-8, UTF-8 or UTF-16BE text. */
  private talkerAlias(lc: Lc): void {
    const b = [lc.opts, lc.dst >> 16 & 255, lc.dst >> 8 & 255, lc.dst & 255, lc.src >> 16 & 255, lc.src >> 8 & 255, lc.src & 255];
    const idx = lc.flco - 4;
    let text = '';
    if (idx === 0) { this.aliasFmt = b[0] >> 6; this.aliasParts = ['', '', '', '']; }
    const fmt = this.aliasFmt;
    if (fmt === 0) {                                       // 7-bit packed
      const bits: number[] = []; for (const v of b) for (let i = 7; i >= 0; i--) bits.push((v >> i) & 1);
      for (let p = idx === 0 ? 7 : 0; p + 7 <= bits.length; p += 7) { let c = 0; for (let i = 0; i < 7; i++) c = c << 1 | bits[p + i]; if (c >= 32) text += String.fromCharCode(c); }
    } else if (fmt === 3) {                                // UTF-16BE
      for (let i = idx === 0 ? 1 : 0; i + 1 < b.length; i += 2) { const c = b[i] << 8 | b[i + 1]; if (c >= 32) text += String.fromCharCode(c); }
    } else {                                               // ISO-8 / UTF-8
      const bytes = b.slice(idx === 0 ? 1 : 0).filter(v => v !== 0);
      try { text = fmt === 2 ? new TextDecoder('utf-8').decode(Uint8Array.from(bytes)) : String.fromCharCode(...bytes); } catch { text = ''; }
    }
    this.aliasParts[idx] = text.replace(/[\x00-\x1f]/g, '');
    this.alias = this.aliasParts.join('').trim();
  }
}

export interface DmrStatus {
  locked: boolean; proto: string; source: string; cc: number; level: number; syncs: number;
  slots: [SlotStatus, SlotStatus]; audioSlot: number; dv: string; dvCount: number; inverted: boolean;
  /** Checked payloads (RS / CRC / embedded LC) or a settled color code have been seen: this is DMR, not a look-alike. */
  strong: boolean;
}

export class DmrDecoder {
  onAudio: (pcm48k: Float32Array) => void = () => {};
  onLog: (line: string) => void = () => {};
  /** 0 = follow whichever slot last started talking, 1 / 2 = fixed. */
  slotSel = 0;
  readonly minHalf = 6500;
  onFm(samples: Float32Array, n: number, rate: number): void { if (rate === RATE) this.push(samples, n); }
  private readonly lp = new RealFir(lowpassTaps(4200 / RATE, 95));   // 4FSK at 4800 baud reaches ~2.9 kHz; leave room rather than clip the shoulders
  private tmp = new Float32Array(0);
  private readonly ring = new Float32Array(RING);
  private n = 0;                                            // samples seen
  private locked = false;
  private symNext = 0;                                      // sample time of the next symbol decision
  private center = 0; private lvl = 0.25;                   // eye center and the ±3 level (rad/sample)
  private readonly sorted = new Float32Array(SLOT);
  /** Receiver polarity: an inverted discriminator swaps voice and data sync words and every dibit's MSB. Decided from what decodes. */
  private inverted = false;
  private polOk = 0; private polBad = 0; private confirmed = false;
  private validCount = 0;
  private sps = SPS;                                         // tracked symbol period (samples); recordings are not always at 48 000
  private lastFireT = -1e9;
  private readonly ccVotes = new Float32Array(16);
  private readonly soft = new Float32Array(SLOT);
  private readonly dib = new Uint8Array(SLOT);
  private pos = 0;
  private frame = 0;                                        // which time slot the current 144 dibits belong to
  private parity = 0;                                       // free-running 30 ms burst parity
  /** Burst parity a lone MS-sourced stream sits on; -1 = both slots live. */
  private simplexPhase = -1;
  /** MS sync seen on both parities: two radios sharing a repeater's uplink slots, so the slots are real. */
  private msDual = false;
  private msOther = 0;                                      // MS syncs seen on the idle parity in a row
  /** P25 shares this receiver's symbol recovery; it only frames differently once a sync lands. */
  readonly p25 = new P25Decoder();
  /** P25's vocoder. Different bits, same speech model as DMR's, so the same synthesis. */
  private readonly imbe = new ImbeDecoder();
  /** Follow P25 as well as DMR (the DIGITAL tab turns this on for P25 or AUTO). */
  p25On = false;
  private mode: 'dmr' | 'p25' = 'dmr';
  /** Sample of the last DMR burst that actually framed, for arbitrating against P25 on the same receiver. */
  private dmrFrameN = -1e9;
  private lastSyncN = -1e9;
  private syncCount = 0;
  private source = '';
  cc = -1;
  readonly ts: [TimeSlot, TimeSlot] = [new TimeSlot(), new TimeSlot()];
  private audioSlot = 0;
  // sync candidate tracking
  private candCorr = 0; private candN = 0; private candSync: Sync | null = null;
  private readonly v24 = new Float32Array(24); private readonly v18 = new Float32Array(18); private readonly v18a = new Float32Array(18); private readonly v18b = new Float32Array(18);
  // identification of other digital voice modes
  private dvName = ''; private dvAt = -1e9; private dvCount = 0;
  // audio upsampling 8 k → 48 k
  private readonly up = new RealFir(lowpassTaps(3400 / RATE, 47));
  private readonly upIn = new Float32Array(960); private readonly upOut = new Float32Array(960);
  private readonly fr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
  private readonly raw196 = new Uint8Array(196);
  private readonly frag = new Uint8Array(32);
  private lastIdleLog = 0; private lastLine = ''; private lastLineAt = -1e9; private lockLine = '';

  constructor() {
    // P25 voice frames go through their own vocoder into the same audio path DMR uses.
    this.p25.onVoice = bits => { const pcm = this.imbe.decodeVoice(bits); if (this.mode === 'p25') this.emitAudio(pcm); };
  }

  reset(): void {
    this.imbe.reset();
    this.lp.reset(); this.up.reset(); this.ring.fill(0); this.n = 0; this.locked = false; this.pos = 0; this.frame = 0; this.parity = 0;
    this.lastSyncN = -1e9; this.syncCount = 0; this.cc = -1; this.source = ''; this.candSync = null; this.candCorr = 0; this.simplexPhase = -1; this.msDual = false; this.msOther = 0; this.mode = 'dmr'; this.dmrFrameN = -1e9; this.p25.reset();
    for (const t of this.ts) { t.endCall(); t.tg = 0; t.src = 0; t.alias = ''; t.last = ''; t.cc = -1; t.errs = 0; t.frames = 0; }
    this.polOk = this.polBad = 0; this.confirmed = false; this.sps = SPS; this.ccVotes.fill(0); this.validCount = 0;
    this.dvName = ''; this.dvAt = -1e9; this.dvCount = 0;
  }

  /** Samples seen, so a caller can age the P25 status. */
  get samples(): number { return this.n; }

  status(): DmrStatus {
    const now = this.n;
    const dv = now - this.dvAt < 2 * RATE && this.dvCount >= 3 ? this.dvName : '';
    let bestVotes = 0; for (let i = 0; i < 16; i++) if (this.ccVotes[i] > bestVotes) bestVotes = this.ccVotes[i];
    return { locked: this.locked && this.confirmed, proto: this.locked ? 'DMR' : '', source: this.source, cc: this.cc, level: this.lvl, syncs: this.syncCount, slots: [this.ts[0].status(), this.ts[1].status()], audioSlot: this.audioSlot + 1, dv, dvCount: this.dvCount, inverted: this.inverted, strong: this.locked && this.confirmed && (this.validCount >= 2 || bestVotes >= 4) };
  }

  /** Discriminator samples (radians per sample) at 48 kHz. */
  push(disc: Float32Array, n: number): void {
    if (this.tmp.length < n) this.tmp = new Float32Array(n);
    const y = this.tmp, ring = this.ring;
    this.lp.process(disc, n, y);
    for (let i = 0; i < n; i++) {
      const t = this.n;
      ring[t & MASK] = y[i];
      let search = !this.locked;
      if (this.locked) { const r = ((t - this.symNext) % SPS + SPS) % SPS; search = r < 1.5 || r > 8.5; }
      if (search) this.checkSync(t);
      if (this.candSync && t - this.candN >= 6) { const s = this.candSync, cn = this.candN; this.candSync = null; this.candCorr = 0; this.fire(s, cn); }
      if (this.locked) {
        while (this.symNext + 1 <= t) {
          const x = this.interp(this.symNext);
          this.symNext += this.sps;
          if (this.mode === 'p25') { this.p25.push(this.slice(x), this.n); continue; }
          this.soft[this.pos] = x; this.dib[this.pos] = this.slice(x);
          if (++this.pos >= SLOT) { this.pos = 0; this.processSlot(); }
        }
        // A free-running P25 framer can decode for a long time without the sync correlator firing, so its own
        // frames count as the receiver being alive.
        const alive = this.mode === 'p25' ? Math.max(this.lastSyncN, this.p25.lastFrame) : this.lastSyncN;
        if (t - alive > 2 * RATE) { this.locked = false; for (const ts of this.ts) ts.endCall(); if (this.confirmed) this.log(this.mode === 'p25' ? 'P25 lost' : 'DMR lost'); this.confirmed = false; if (this.mode === 'p25') this.p25.idle(); this.mode = 'dmr'; this.polOk = this.polBad = 0; this.simplexPhase = -1; this.msDual = false; this.msOther = 0; this.ccVotes.fill(0); }
      }
      this.n++;
    }
  }

  private interp(t: number): number {
    const i = Math.floor(t), f = t - i;
    return this.ring[i & MASK] * (1 - f) + this.ring[(i + 1) & MASK] * f;
  }
  private slice(x: number): number {
    const d = this.inverted ? this.center - x : x - this.center, thr = this.lvl * 2 / 3;
    return d > thr ? 1 : d > 0 ? 0 : d > -thr ? 2 : 3;
  }
  /** A sync word's meaning under the current polarity (inverted → voice and data swap). */
  private kindOf(s: Sync): 'voice' | 'data' { return this.inverted ? (s.kind === 'voice' ? 'data' : 'voice') : (s.kind as 'voice' | 'data'); }
  /** Bookkeeping for the polarity decision: after a run of failed slot types / EMBs, try the other polarity. */
  private polarity(ok: boolean): void {
    if (ok) { this.polOk++; if (this.polOk >= 3 && !this.confirmed) { this.confirmed = true; this.log(`${this.lockLine}${this.inverted ? ' · inverted' : ''}`); } if (this.polOk > 12) { this.polOk = 12; this.polBad = 0; } return; }
    this.polBad++;
    if (this.polBad >= 4 && this.polOk < 3) {
      this.inverted = !this.inverted; this.polBad = 0; this.polOk = 0;
      for (const ts of this.ts) ts.endCall();
    } else if (this.polBad >= 24) { this.polOk = 0; this.polBad = 0; this.confirmed = false; }
  }
  /** Color-code voting: a decode that disagrees with the color code seen so far needs to be clean to be believed. */
  private ccVote(cc: number, errs: number): boolean {
    const v = this.ccVotes;
    let best = 0; for (let i = 1; i < 16; i++) if (v[i] > v[best]) best = i;
    // Every burst of a DMR system carries the same color code, so once one is settled a burst claiming a
    // different one is noise whose Golay happened to land on a code word. Rejecting those keeps a phantom
    // caller out of the other time slot (which the audio would then follow, breaking up the real call).
    if (v[best] >= 3 && cc !== best) return false;
    if (errs <= 1 || v[best] < 3) { for (let i = 0; i < 16; i++) v[i] *= 0.95; v[cc] += 1; return true; }
    return false;
  }

  private checkSync(t: number): void {
    const ring = this.ring, v24 = this.v24, v18 = this.v18, v18a = this.v18a, v18b = this.v18b;
    let a24 = 0, a20 = 0, min24 = Infinity;
    for (let k = 0; k < 24; k++) { const x = ring[(t - (23 - k) * 10) & MASK]; v24[k] = x; const a = x < 0 ? -x : x; a24 += a; if (k >= 4) a20 += a; if (a < min24) min24 = a; }
    if (a24 < 1e-4) return;
    const strong = min24 > 0.3 * (a24 / 24);              // every sync symbol is ±3: no weak symbols allowed
    const nxdn = !this.locked;
    let a18 = 0, a18a = 0, a18b = 0, min18 = Infinity;
    if (nxdn) for (let k = 0; k < 18; k++) {                  // 2400 symbols/s: the symbol must hold ±5 samples around its center
      const i = t - (17 - k) * 20, x = ring[i & MASK], xa = ring[(i - 5) & MASK], xb = ring[(i + 5) & MASK];
      v18[k] = x; v18a[k] = xa; v18b[k] = xb;
      const ax = x < 0 ? -x : x, aa = xa < 0 ? -xa : xa, ab = xb < 0 ? -xb : xb;
      a18 += ax; a18a += aa; a18b += ab;
      if (ax < min18) min18 = ax; if (aa < min18) min18 = aa; if (ab < min18) min18 = ab;
    }
    const strong18 = nxdn && min18 > 0.3 * (a18 / 18);
    let min20 = Infinity; for (let k = 4; k < 24; k++) { const a = v24[k] < 0 ? -v24[k] : v24[k]; if (a < min20) min20 = a; }
    const strong20 = min20 > 0.15 * (a20 / 20);
    for (const s of SYNCS) {
      if (!this.wants(s)) continue;
      let c = 0, a: number;
      if (s.sp === 20) {
        if (!strong18) continue;
        let ca = 0, cb = 0;
        for (let k = 0; k < 18; k++) { c += v18[k] * s.s[k]; ca += v18a[k] * s.s[k]; cb += v18b[k] * s.s[k]; }
        if (ca / a18a < s.thr || cb / a18b < s.thr) continue;
        a = a18;
      }
      else if (s.s.length === 20) { for (let k = 0; k < 20; k++) c += v24[k + 4] * s.s[k]; a = a20; }
      else { for (let k = 0; k < 24; k++) c += v24[k] * s.s[k]; a = a24; }
      const corr = c / a;
      if (corr < s.thr) continue;
      if (s.proto === 'YSF' ? !strong20 : s.sp !== 20 && !strong) continue;
      if (corr > this.candCorr) { this.candCorr = corr; this.candN = t; this.candSync = s; }
    }
  }

  /**
   * Which protocols may compete for the receiver right now. This has to be decided when the candidate is picked
   * rather than when it fires: only the best correlation in a six-sample window survives, so a chance match on
   * one protocol's sync word silently swallowed the other's real one, and a whole frame with it.
   */
  private wants(s: Sync): boolean {
    if (!this.locked) return true;
    if (this.mode === 'p25' && this.n - this.p25.lastFrame < RATE / 2) return s.proto === 'P25';
    if (this.mode === 'dmr' && this.n - this.dmrFrameN < RATE / 2) return s.proto === 'DMR';
    return true;
  }

  /** A sync word ended at sample n0: refine the timing, then lock (DMR) or count an identification (others). */
  private fire(s: Sync, n0: number): void {
    const wantP25 = s.proto === 'P25' && this.p25On;
    if (s.proto !== 'DMR' && !wantP25) {
      if (this.locked) return;
      if (this.dvName !== s.proto || this.n - this.dvAt > 2 * RATE) this.dvCount = 0;
      this.dvName = s.proto; this.dvAt = this.n; this.dvCount++;
      if (this.dvCount === 3) this.log(`${s.proto} sync detected (identification only)`);
      return;
    }
    // Both protocols are 4FSK at 4800 baud and each one's traffic throws the other's sync word now and then,
    // so the receiver goes to whichever is actually producing frames rather than to whichever locked first.
    if (wantP25 && this.mode === 'dmr' && this.locked && this.n - this.dmrFrameN < RATE / 2) return;
    if (s.proto === 'DMR' && this.mode === 'p25' && this.n - this.p25.lastFrame < RATE / 2) return;
    // Matched-filter output, NOT the normalized correlation: dividing by the signal's own magnitude flattens the
    // very peak this is trying to locate, and the parabolic fit below then lands about a tenth of a symbol early.
    // Sampling that far off center costs the outer symbols most, because they swing furthest between symbols.
    const corrAt = (t: number) => { let c = 0; for (let k = 0; k < 24; k++) c += this.interp(t - (23 - k) * 10) * s.s[k]; return c; };
    const cm = corrAt(n0 - 1), c0 = corrAt(n0), cp = corrAt(n0 + 1);
    const den = cm - 2 * c0 + cp;
    let delta = den < 0 ? 0.5 * (cm - cp) / den : 0;
    if (delta > 0.5) delta = 0.5; else if (delta < -0.5) delta = -0.5;
    const t0 = n0 + delta;
    if (this.locked && t0 - this.lastFireT < RATE) {        // symbol clock: the sync should end on a symbol instant
      const prev = this.symNext - this.sps, e = t0 - prev, err = e - Math.round(e / this.sps) * this.sps;
      const symbols = (t0 - this.lastFireT) / this.sps;
      if (Math.abs(err) < 3 && symbols >= 100) this.sps += 0.2 * err / symbols;
      if (this.sps > SPS * 1.01) this.sps = SPS * 1.01; else if (this.sps < SPS * 0.99) this.sps = SPS * 0.99;
    }
    this.lastFireT = t0;
    let sp = 0, sn = 0, np = 0, nn = 0;
    for (let k = 0; k < 24; k++) { const x = this.interp(t0 - (23 - k) * 10); if (s.s[k] > 0) { sp += x; np++; } else { sn += x; nn++; } }
    const mp = sp / np, mn = sn / nn, center = (mp + mn) / 2, lvl = (mp - mn) / 2;
    if (lvl < 0.01) return;
    if (!this.locked) { this.center = center; this.lvl = lvl; this.lockLine = `${s.proto} sync (${s.src || 'P25'}) · deviation ${(lvl * RATE / (2 * Math.PI)).toFixed(0)} Hz`; }
    else { this.center += 0.5 * (center - this.center); this.lvl += 0.5 * (lvl - this.lvl); }
    if (wantP25) {
      // P25 is one continuous stream: no slots, no polarity question, just frames that start here
      if (this.mode !== 'p25') { this.mode = 'p25'; this.p25.idle(); this.imbe.reset(); this.confirmed = true; this.log(this.lockLine); }
      this.inverted = s.src === 'inv';
      this.symNext = t0 + this.sps; this.locked = true; this.lastSyncN = t0; this.syncCount++; this.source = 'P25';
      this.p25.sync(this.n);
      return;
    }
    if (this.mode !== 'dmr') { this.mode = 'dmr'; this.p25.idle(); this.confirmed = false; this.polOk = this.polBad = 0; }
    for (let k = 0; k < 90; k++) { const x = this.interp(t0 - (89 - k) * this.sps); this.soft[k] = x; this.dib[k] = this.slice(x); }
    this.symNext = t0 + this.sps; this.pos = 90; this.locked = true; this.lastSyncN = t0; this.syncCount++; this.source = s.src;
  }

  /** Soft match of the slot's center 48 bits against the DMR sync words. */
  private matchCenter(thr: number): Sync | null {
    const soft = this.soft;
    let a = 0; for (let k = 0; k < 24; k++) { const x = soft[66 + k] - this.center; a += x < 0 ? -x : x; }
    if (a < 24 * 0.4 * this.lvl) return null;                 // sync symbols are all ±3: a weak center is not a sync
    let best: Sync | null = null, bestC = thr;
    for (const s of DMR_SYNCS) { let c = 0; for (let k = 0; k < 24; k++) c += (soft[66 + k] - this.center) * s.s[k]; c /= a; if (c > bestC) { bestC = c; best = s; } }
    return best;
  }

  private processSlot(): void {
    const dib = this.dib;
    // The parity free-runs at the 30 ms burst rate; the slot index is derived from it, so forcing a slot never
    // disturbs the alternation a repeater's two time slots rely on.
    this.parity ^= 1;
    // A simplex (MS-sourced) transmission is one stream, not two: it uses one parity and the other half is dead
    // air. Route the whole call to slot 1 and skip the empty half, or noise there reads as a second caller.
    this.frame = this.simplexPhase >= 0 ? 0 : this.parity;
    let ts = this.ts[this.frame];
    const sync = this.matchCenter(ts.voice && ts.seq >= 5 ? 0.6 : 0.72);
    if (sync) {
      this.lastSyncN = this.n; this.syncCount++; this.source = sync.src; this.dmrFrameN = this.n;
      if (sync.src === 'MS') {
        // One radio — simplex, or a single uplink to a repeater — is one stream on one parity, and the other half
        // is dead air. Two radios sharing the two uplink slots put MS sync on both parities: then the slots are
        // real and both must be followed.
        if (this.msDual) this.frame = this.parity;
        else if (this.simplexPhase < 0) { this.simplexPhase = this.parity; this.frame = 0; }
        else if (this.parity === this.simplexPhase) { this.frame = 0; this.msOther = 0; }
        else if (++this.msOther >= 6) { this.msDual = true; this.simplexPhase = -1; this.frame = this.parity; }
        else return;                                          // a lone sync in the idle half is noise
        ts = this.ts[this.frame];
      }
      else if (sync.src === 'BS') { this.simplexPhase = -1; this.frame = (dib[2] >> 1) & 1; this.parity = this.frame; ts = this.ts[this.frame]; }
      else if (sync.src === 'DM1') { this.simplexPhase = -1; this.frame = this.parity = 0; ts = this.ts[0]; }
      else if (sync.src === 'DM2') { this.simplexPhase = -1; this.frame = this.parity = 1; ts = this.ts[1]; }
    } else if (this.simplexPhase >= 0 && this.parity !== this.simplexPhase) return;   // the idle half: nothing to read
    // eye tracking: the strongest and weakest quarter of the slot's symbols are the +3s and −3s, so their means
    // give the ±3 level and (their midpoint) the center, which drifts with tuning error
    if (!sync) {                                              // no sync word this slot (voice bursts B–F): follow the eye from the data
      const sorted = this.sorted; sorted.set(this.soft); sorted.sort();
      let lo = 0, hi = 0; for (let k = 0; k < 36; k++) { lo += sorted[k]; hi += sorted[SLOT - 1 - k]; } lo /= 36; hi /= 36;
      if (hi - lo > 0.02) { this.center += 0.1 * ((hi + lo) / 2 - this.center); this.lvl += 0.1 * ((hi - lo) / 2 - this.lvl); }
    }
    const kind = sync ? this.kindOf(sync) : '';
    if (kind === 'data') this.dataBurst(ts);
    else if (kind === 'voice') {
      ts.seq = 0; ts.emb.reset();
      if (this.confirmed) {
        // A voice sync on its own is not proof of a call: 24 noise symbols correlate with one often enough over a
        // long transmission, and the resulting phantom used to steal the audio from the slot really talking.
        // Wait for this slot's color code (from the slot type, or the embedded signaling one burst later) to
        // match the system's. A real call has it from its voice header, so nothing is lost.
        if (!ts.voice && this.cc >= 0 && ts.cc === this.cc) {
          ts.since = this.n; ts.ambe.reset();
          if (this.slotSel === 0) this.audioSlot = this.frame;
          ts.voice = true;
          this.logLine(ts, 'VOICE');
        }
        if (ts.voice) this.voiceBurst(ts); else this.voiceEvidence(ts);
      } else this.voiceEvidence(ts);
    } else if (ts.seq >= 0 && ts.seq < 5) {                  // inside a voice superframe (bursts B–F carry EMB + embedded LC)
      ts.seq++;
      this.embedded(ts);
      if (ts.voice && this.confirmed) this.voiceBurst(ts); else this.voiceEvidence(ts);
    } else if (ts.voice) { ts.endCall(); this.logLine(ts, 'voice stopped'); }
    else ts.seq = -1;
  }

  /** Polarity evidence from a voice burst's first AMBE frame without synthesising anything. */
  private voiceEvidence(ts: TimeSlot): void {
    const dib = this.dib, fr = this.fr;
    for (const row of fr) row.fill(0);
    for (let i = 0; i < 36; i++) { const d = dib[12 + i]; fr[rW[i]][rX[i]] = d >> 1; fr[rY[i]][rZ[i]] = d & 1; }
    this.polarity(c0Clean(fr[0]));
    if (!this.confirmed) ts.voice = false;
  }

  private dataBurst(ts: TimeSlot): void {
    const dib = this.dib;
    let st = 0;
    for (let i = 61; i <= 65; i++) st = st << 2 | dib[i];
    for (let i = 90; i <= 94; i++) st = st << 2 | dib[i];
    const code = golay208(st >>> 1);
    const dt = code < 0 ? -1 : code & 15, errs = code < 0 ? 9 : code >> 8, cc = code < 0 ? -1 : (code >> 4) & 15;
    const clean = dt >= 0 && dt <= 10 && errs <= 1 && (st >>> 1) !== 0;   // the all-zero word is a code word too (a dead carrier)
    this.polarity(clean);
    if (dt < 0 || dt > 10 || (st >>> 1) === 0 || !this.confirmed || !this.ccVote(cc, errs)) return;
    this.cc = cc; ts.cc = cc;
    const wasVoice = ts.voice && this.confirmed;
    ts.endCall();
    const raw = this.raw196;
    let p = 0;
    for (let i = 12; i <= 60; i++) { raw[p++] = dib[i] >> 1; raw[p++] = dib[i] & 1; }
    for (let i = 95; i <= 143; i++) { raw[p++] = dib[i] >> 1; raw[p++] = dib[i] & 1; }
    const name = DATA_TYPES[dt] ?? `DATA TYPE ${dt}`;
    if (dt === 1 || dt === 2) {
      const b = bptc(raw);
      const m = dt === 1 ? 0x96 : 0x99;
      b[9] ^= m; b[10] ^= m; b[11] ^= m;
      if (rs129ok(b)) { this.validCount++; const lc = parseLc(b); ts.setLc(lc); this.logLine(ts, dt === 1 ? 'VOICE HEADER' : 'END OF CALL'); }
      else this.logLine(ts, `${name} (bad RS)`);
    } else if (dt === 3 || dt === 4) {
      const b = bptc(raw);
      const m = dt === 3 ? 0xa5 : 0xaa;
      b[10] ^= m; b[11] ^= m;
      if (crcOk(b, 12)) {
        this.validCount++;
        const op = b[0] & 0x3f, fid = b[1];
        const dst = b[4] << 16 | b[5] << 8 | b[6], src = b[7] << 16 | b[8] << 8 | b[9];
        const vendor = FIDS[fid] ?? `FID ${fid}`;
        if (fid !== 0) this.logLine(ts, `${vendor} CSBK 0x${op.toString(16).padStart(2, '0')} · ${Array.from(b.subarray(2, 10), v => v.toString(16).padStart(2, '0')).join(' ')}`);
        else {
          const opName = CSBKO[op] ?? `CSBK 0x${op.toString(16)}`;
          const detail = op === 0x38 ? `BS ${dst} ← ${src}` : op === 0x26 ? `→ ${dst} from ${src}` : `${(b[2] & 0x40) && op === 0x3d ? 'TG' : 'ID'} ${dst} ← ${src}`;
          this.logLine(ts, `${opName} · ${detail}`);
        }
      } else this.logLine(ts, `${name} (bad CRC)`);
    } else if (dt === 9) {
      if (this.n - this.lastIdleLog > 5 * RATE) { this.lastIdleLog = this.n; this.logLine(ts, 'IDLE'); }
      ts.last = 'IDLE';
    } else this.logLine(ts, name);
    if (wasVoice && dt !== 2) this.logLine(ts, 'voice stopped');
  }

  private embedded(ts: TimeSlot): void {
    const dib = this.dib;
    let emb = 0;
    for (let i = 66; i <= 69; i++) emb = emb << 2 | dib[i];
    for (let i = 86; i <= 89; i++) emb = emb << 2 | dib[i];
    const code = qr167(emb >>> 1);
    const errs = code < 0 ? 9 : code >> 8, cc = code < 0 ? -1 : (code >> 3) & 15, lcss = code & 3;
    this.polarity(errs === 0);
    if (code < 0 || !this.confirmed || !this.ccVote(cc, errs)) return;
    this.cc = cc; ts.cc = cc;
    const frag = this.frag;
    for (let i = 0; i < 16; i++) { frag[2 * i] = dib[70 + i] >> 1; frag[2 * i + 1] = dib[70 + i] & 1; }
    const lc = ts.emb.add(frag, lcss);
    if (lc) { this.validCount++; const parsed = parseLc(lc); if (ts.setLc(parsed)) this.logLine(ts, 'VOICE'); else if (parsed.flco >= 4 && parsed.flco <= 7 && ts.alias) this.logLine(ts, `alias ${ts.alias}`); }
  }

  private voiceBurst(ts: TimeSlot): void {
    const dib = this.dib, fr = this.fr;
    const play = this.confirmed && this.frame === (this.slotSel === 0 ? this.audioSlot : this.slotSel - 1);
    const decodeOne = (fill: (i: number) => number) => {
      for (const row of fr) row.fill(0);
      for (let i = 0; i < 36; i++) { const d = fill(i); fr[rW[i]][rX[i]] = d >> 1; fr[rY[i]][rZ[i]] = d & 1; }
      const pcm = ts.ambe.decode(fr);
      ts.frames++; ts.errs += Math.min(1, ts.ambe.errs / 8);
      if (play) this.emitAudio(pcm);
    };
    decodeOne(i => dib[12 + i]);
    decodeOne(i => i < 18 ? dib[48 + i] : dib[90 + i - 18]);
    decodeOne(i => dib[108 + i]);
  }

  private emitAudio(pcm8k: Float32Array): void {
    const inp = this.upIn, out = this.upOut;
    inp.fill(0);
    for (let i = 0; i < 160; i++) inp[i * 6] = pcm8k[i] * 6;
    this.up.process(inp, 960, out);
    this.onAudio(out.slice());
  }

  private logLine(ts: TimeSlot, what: string): void {
    const slot = this.frame + 1;
    const who = ts.tg || ts.src ? ` · ${ts.group ? 'TG' : 'ID'} ${ts.tg} ← ${ts.src}${ts.alias ? ` "${ts.alias}"` : ''}` : '';
    ts.last = what;
    const line = `S${slot} CC${ts.cc >= 0 ? ts.cc : '?'} ${what}${who}`;
    if (line === ts.lastLog && this.n - ts.lastLogAt < 3 * RATE) return;      // the same thing every burst: say it once
    ts.lastLog = line; ts.lastLogAt = this.n;
    this.log(line);
  }
  private log(line: string): void {
    if (line === this.lastLine && this.n - this.lastLineAt < 3 * RATE) return;
    this.lastLine = line; this.lastLineAt = this.n;
    this.onLog(line);
  }
}
