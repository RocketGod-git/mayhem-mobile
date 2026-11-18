/**
 * P25 Phase 2 two-slot TDMA, outbound voice channel (TIA-102.BBAB physical layer, TIA-102.BBAC MAC layer). No DOM.
 *
 *  - H-DQPSK at 6000 symbols a second, demodulated by the phase step across one symbol (+3pi/4 is dibit 01, +pi/4 00,
 *    -pi/4 10, -3pi/4 11), symbol timing picked again every 360 symbols.
 *  - Timeslots of 180 symbols (30 ms), twelve to a 360 ms superframe. A 20-symbol ISCH straddles each slot boundary;
 *    the S-ISCH is the sync 0x575D57F7FF (BBAC 5.1). Slots 10 and 11 carry the SACCH; the outbound logical channel 0
 *    has slots 0, 2, 4, 6, 8 and 11, channel 1 slots 1, 3, 5, 7, 9 and 10 (BBAC 3.2).
 *  - The DUID, four unscrambled dibits at symbols 10, 47, 132 and 169 of a slot: a (8,4,4) code (BBAC 5.4, Table 5-3)
 *    naming the burst 4V, 2V, FACCH or SACCH, scrambled or not.
 *  - Scrambling (BBAC 7.2.5): a 44-bit LFSR, G(x) = x^44 + x^40 + x^35 + x^29 + x^24 + x^10 + 1, seeded with
 *    WACN * 2^24 + System ID * 2^12 + Color Code (the NAC), restarted every superframe at the start of slot 0; bit n of
 *    the superframe (360 a slot, ISCH and DUID positions included) is XORed with sequence bit n.
 *  - Voice (BBAC Annex E): 4V bursts carry four 72-bit AMBE+2 half-rate frames at symbols 11, 48, 96 and 133, with
 *    ESS-B at 84; 2V bursts two frames at 11 and 48, with ESS-A at 84 and 133.
 *  - ESS (BBAC 5.6.2): ALGID, key ID and MI, a (44,16,29) Reed-Solomon code over GF(64): the 16 information hexbits
 *    in the ESS-B of four 4V bursts, the 28 parity hexbits in the 2V's ESS-A.
 *  - MAC PDUs (BBAC 5.6, 8): the FACCH burst carries an S-OEMI (156 bits at symbols 11, 48 and 100 around a sync), the
 *    SACCH an I-OEMI (180 bits at symbols 11 and 48), each ending in a CRC-12 (g(x) = x^12 + x^11 + x^7 + x^4 + x^2 +
 *    x + 1, remainder inverted).
 * The superframe position is found from the SACCH pair (slots 10 and 11 right after an S-ISCH pair), and the seed by
 * which candidate (the systems heard on the control channels) makes the voice frames' first Golay word pass.
 */
import { rsDecode } from '../ham/p25.js';

export const P2_BAUD = 6000;
/** The S-ISCH sync as symbol levels (dibit 01 is +3, 11 is -3). */
export const P2_SYNC = (() => {
  const LV: Record<string, number> = { '01': 3, '00': 1, '10': -1, '11': -3 }, out: number[] = [];
  const bits = [...'575D57F7FF'].flatMap(h => { const v = parseInt(h, 16); return [(v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1]; });
  for (let i = 0; i < bits.length; i += 2) out.push(LV[`${bits[i]}${bits[i + 1]}`]);
  return Int8Array.from(out);
})();
const BLK = 360, SLOT = 180, SF_BITS = 4320;

/** DUID information values (BBAC Table 5-3). */
export const DUID = { V4: 0b0000, V2: 0b0110, SACCH_S: 0b0011, FACCH_S: 0b1001, SACCH: 0b1100, FACCH: 0b1111 } as const;
const DUID_ROWS = [0b1101, 0b1011, 0b1110, 0b0111];
export const duidEncode = (i: number) => { let p = 0; for (let b = 0; b < 4; b++) if (i & (8 >> b)) p ^= DUID_ROWS[b]; return (i << 4) | p; };
/** The DUID from its eight received bits: the nearest code word, and how far it was. */
export function duidDecode(w: number): { v: number; dist: number } {
  let v = 0, dist = 9;
  for (let i = 0; i < 16; i++) { let x = duidEncode(i) ^ w, n = 0; while (x) { n += x & 1; x >>= 1; } if (n < dist) { dist = n; v = i; } }
  return { v, dist };
}
/** The 4320-bit scrambling sequence of a superframe (BBAC 7.2.5, external LFSR, output from bit 43 of the seed). */
export function p2Sequence(wacn: number, sysId: number, nac: number): Uint8Array {
  let seed = wacn * 2 ** 24 + sysId * 2 ** 12 + nac;
  if (seed === 0) seed = 2 ** 44 - 1;
  const a = new Uint8Array(SF_BITS + 44);
  for (let i = 0; i < 44; i++) a[i] = Math.floor(seed / 2 ** (43 - i)) & 1;
  for (let m = 44; m < a.length; m++) a[m] = a[m - 4] ^ a[m - 9] ^ a[m - 15] ^ a[m - 20] ^ a[m - 34] ^ a[m - 44];
  return a;
}
/** CRC-12 of a MAC PDU (BBAC 8.4.5): the remainder of M(x) x^12 by g12, inverted. */
export function p2Crc12(bits: ArrayLike<number>, n = bits.length): number {
  let r = 0;
  for (let i = 0; i < n; i++) { const fb = ((r >> 11) & 1) ^ bits[i]; r = (r << 1) & 0xfff; if (fb) r ^= 0x897; }
  return r ^ 0xfff;
}

// the half-rate frame's first Golay (23,12) word, read through the AMBE+2 frame order, checks the descrambling
const GOLAY_GEN = 0xc75;
function golay23Syn(w: number): number { let r = w; for (let b = 22; b >= 11; b--) if (r & (1 << b)) r ^= GOLAY_GEN << (b - 11); return r & 0x7ff; }
/** Positions in a 72-bit frame (as sent) of the 23 bits of the first Golay word, highest first. */
const C0_POS: number[] = (() => {
  // the AMBE+2 72-bit frame order (the DMR receiver's de-interleave, ham/dmr.ts), first code word only
  const rW = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2];
  const rX = [23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4];
  const rY = [0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3];
  const rZ = [5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4, 14, 3, 13, 2, 12, 1, 11, 0];
  const at: number[] = new Array(24).fill(-1);
  for (let i = 0; i < 36; i++) { if (rW[i] === 0) at[rX[i]] = 2 * i; if (rY[i] === 0) at[rZ[i]] = 2 * i + 1; }
  return Array.from({ length: 23 }, (_, k) => at[23 - k]);
})();
export const c0Clean = (f: ArrayLike<number>) => { let w = 0; for (const p of C0_POS) w = (w << 1) | f[p]; return golay23Syn(w) === 0; };

export interface P2Seed { wacn: number; sysId: number; nac: number; sys: string }
export interface P2Ess { algId: number; keyId: number; mi: string }
export interface P2Mac { lch: number; slot: number; bytes: Uint8Array; opcode: number; offset: number; facch: boolean }
export const MAC_OPS: Record<number, string> = { 1: 'MAC_PTT', 2: 'MAC_END_PTT', 3: 'MAC_IDLE', 4: 'MAC_ACTIVE', 6: 'MAC_HANGTIME' };

export class P2Rx {
  /** A sync, and whether it is the second of a pair (180 symbols after the one before). */
  onSync: (paired: boolean) => void = () => undefined;
  /** One AMBE+2 frame (72 bits, descrambled, as sent) of a logical channel. */
  onVoice: (lch: number, frame: Uint8Array) => void = () => undefined;
  /** A MAC PDU that passed its CRC. */
  onMac: (m: P2Mac) => void = () => undefined;
  /** The encryption sync of a logical channel's voice superframe, once its Reed-Solomon code passed. */
  onEss: (lch: number, e: P2Ess) => void = () => undefined;
  /** The seed was found among the candidates. */
  onSeed: (s: P2Seed) => void = () => undefined;
  syncs = 0; pairs = 0; symbols = 0;
  /** Bursts by type, voice frames passed on, MAC PDUs passing / failing their CRC. */
  readonly stats = { bursts: 0, v4: 0, v2: 0, facch: 0, sacch: 0, frames: 0, c0clean: 0, macOk: 0, macBad: 0, essOk: 0 };
  seeds: P2Seed[] = [];
  seed: P2Seed | null = null;
  private seq: Uint8Array | null = null;
  private readonly T: number;
  private re = new Float32Array(0); private im = new Float32Array(0); private n = 0;
  private readonly ring = new Float32Array(20); private rp = 0; private t = 0; private lastSync = -1e9;
  /** Symbols kept for the bursts, by absolute symbol number. */
  private hist = new Int8Array(8192); private histBase = 0;
  /** Slot starts (absolute symbol numbers) waiting for their 180 symbols; the superframe's slot 0 when known. */
  private pendingSlots: number[] = []; private sf0 = -1; private lastPair = -1e9; private prevSacch = -1;
  private readonly seedVotes = new Map<number, number>();
  /** Per logical channel: ESS-B pieces of the last four 4V bursts. */
  private readonly essB: number[][][] = [[], []];
  constructor(readonly fs: number) { this.T = fs / P2_BAUD; }

  setSeeds(s: P2Seed[]): void {
    this.seeds = s;
    if (this.seed && !s.some(x => x.wacn === this.seed!.wacn && x.sysId === this.seed!.sysId && x.nac === this.seed!.nac)) { this.seed = null; this.seq = null; }
  }
  push(zi: ArrayLike<number>, zq: ArrayLike<number>, m: number): void {
    if (this.n + m > this.re.length) { const r = new Float32Array(Math.max(2 * this.re.length, this.n + m + 1024)), q = new Float32Array(r.length); r.set(this.re.subarray(0, this.n)); q.set(this.im.subarray(0, this.n)); this.re = r; this.im = q; }
    for (let k = 0; k < m; k++) { this.re[this.n] = zi[k]; this.im[this.n++] = zq[k]; }
    const need = Math.ceil((BLK + 2) * this.T) + 2;
    while (this.n >= need) this.block();
  }
  private dphi(t: number): number {
    const T = this.T, i = Math.floor(t), f = t - i, j = Math.floor(t - T), g = t - T - j;
    const a = this.re[i] * (1 - f) + this.re[i + 1] * f, b = this.im[i] * (1 - f) + this.im[i + 1] * f;
    const c = this.re[j] * (1 - g) + this.re[j + 1] * g, d = this.im[j] * (1 - g) + this.im[j + 1] * g;
    return Math.atan2(b * c - a * d, a * c + b * d);
  }
  private block(): void {
    const T = this.T, t0 = T + 1;
    let best = 0, bm = -1e9;
    for (let p = 0; p < 8; p++) { let s = 0; for (let k = 0; k < BLK; k += 3) s -= Math.cos(4 * this.dphi(t0 + p * T / 8 + k * T)); if (s > bm) { bm = s; best = p; } }
    let cr = 0, ci = 0;
    for (let k = 0; k < BLK; k++) { const v = this.dphi(t0 + best * T / 8 + k * T); cr += Math.cos(4 * v); ci += Math.sin(4 * v); }
    const off = Math.atan2(ci, cr) - Math.PI, corr = Math.atan2(Math.sin(off), Math.cos(off)) / 4;
    for (let k = 0; k < BLK; k++) { let v = this.dphi(t0 + best * T / 8 + k * T) - corr; v = Math.atan2(Math.sin(v), Math.cos(v)); this.symbol(v * 4 / Math.PI); }
    const used = Math.floor(BLK * T);
    this.re.copyWithin(0, used, this.n); this.im.copyWithin(0, used, this.n); this.n -= used;
  }
  /** The dibit of absolute symbol [s] (01 for +3, 00 +1, 10 -1, 11 -3). */
  private dib(s: number): number { return this.hist[s - this.histBase] & 3; }
  private symbol(s: number): void {
    const t = this.t;
    if (t - this.histBase >= this.hist.length) { const keep = 2048, h = new Int8Array(this.hist.length); h.set(this.hist.subarray(this.hist.length - keep)); this.hist = h; this.histBase = t - keep; }
    this.hist[t - this.histBase] = s > 2 ? 1 : s > 0 ? 0 : s > -2 ? 2 : 3;
    this.ring[this.rp] = s; this.rp = (this.rp + 1) % 20; this.t++; this.symbols++;
    let c = 0, a = 0;
    for (let k = 0; k < 20; k++) { const x = this.ring[(this.rp + k) % 20]; c += x * P2_SYNC[k]; a += (x < 0 ? -x : x) * 3; }
    if (a > 0 && c / a > 0.9 && this.t - this.lastSync > 10) {
      const paired = Math.abs(this.t - this.lastSync - SLOT) <= 2;
      this.syncs++; if (paired) this.pairs++;
      if (paired) this.pair(this.lastSync - 20);
      this.lastSync = this.t; this.onSync(paired);
    }
    while (this.pendingSlots.length && this.t >= this.pendingSlots[0] + SLOT + 1) this.slot(this.pendingSlots.shift()!);
  }
  /** An S-ISCH pair starting at [p]: the four slots after it are framed (the next pair comes 720 symbols on). */
  private pair(p: number): void {
    if (p - this.lastPair < 700) return;
    this.lastPair = p;
    for (let k = 0; k < 4; k++) { const st = p + 10 + SLOT * k; if (!this.pendingSlots.includes(st)) this.pendingSlots.push(st); }
    this.pendingSlots.sort((a, b) => a - b);
  }
  private duidAt(st: number): { v: number; dist: number } {
    const d = [10, 47, 132, 169].map(o => this.dib(st + o));
    return duidDecode((d[0] << 6) | (d[1] << 4) | (d[2] << 2) | d[3]);
  }
  private bits(st: number, from: number, n: number, scr: boolean, slot: number, K = this.seq): Uint8Array {
    const out = new Uint8Array(2 * n);
    for (let q = 0; q < n; q++) {
      const v = this.dib(st + from + q), bi = slot * 360 + 2 * (from + q);
      out[2 * q] = (v >> 1) ^ (scr && K ? K[bi] : 0); out[2 * q + 1] = (v & 1) ^ (scr && K ? K[bi + 1] : 0);
    }
    return out;
  }
  private slot(st: number): void {
    if (st < this.histBase) return;
    const d = this.duidAt(st);
    if (d.dist > 1) return;
    this.stats.bursts++;
    // the SACCH pair (slots 10 and 11) right after an S-ISCH pair sets the superframe: slot 0 begins two slots on
    const sacch = d.v === DUID.SACCH_S || d.v === DUID.SACCH;
    if (sacch && this.prevSacch >= 0 && Math.abs(st - this.prevSacch - SLOT) <= 1 && Math.abs(this.prevSacch - this.lastPair - 10) <= 1) this.sf0 = st + SLOT;
    this.prevSacch = sacch ? st : -1;
    if (this.sf0 < 0) return;
    const slot = ((Math.round((st - this.sf0) / SLOT) % 12) + 12) % 12, lch = [0, 2, 4, 6, 8, 11].includes(slot) ? 0 : 1;
    if (d.v === DUID.V4 || d.v === DUID.V2) this.voice(st, slot, lch, d.v === DUID.V4);
    else if (d.v === DUID.FACCH_S || d.v === DUID.FACCH || d.v === DUID.SACCH_S || d.v === DUID.SACCH) this.mac(st, slot, lch, d.v === DUID.FACCH_S || d.v === DUID.FACCH, d.v === DUID.FACCH_S || d.v === DUID.SACCH_S);
  }
  private voice(st: number, slot: number, lch: number, four: boolean): void {
    if (four) this.stats.v4++; else this.stats.v2++;
    const at = four ? [11, 48, 96, 133] : [11, 48];
    if (!this.seq) { this.findSeed(st, slot, at); if (!this.seq) return; }
    for (const f of at) {
      const fr = this.bits(st, f, 36, true, slot);
      this.stats.frames++; if (c0Clean(fr)) this.stats.c0clean++;
      this.onVoice(lch, fr);
    }
    // ESS-B (4 hexbits) in each 4V; the 2V's ESS-A closes the code word
    const ess = this.essB[lch];
    if (four) { ess.push(hexbits(this.bits(st, 84, 12, true, slot))); if (ess.length > 4) ess.shift(); }
    else {
      if (ess.length === 4) {
        const a = [...this.bits(st, 84, 48, true, slot), ...this.bits(st, 133, 36, true, slot)];
        const cw = Uint8Array.from([...ess.flat(), ...hexbits(a)]);
        const fixed = rsDecode(cw, 28);
        if (fixed >= 0 && fixed <= 10) {
          const bit = (i: number) => (cw[(i / 6) | 0] >> (5 - i % 6)) & 1, f = (a0: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(a0 + i); return v; };
          let mi = ''; for (let i = 0; i < 9; i++) mi += f(24 + 8 * i, 8).toString(16).padStart(2, '0');
          this.stats.essOk++;
          this.onEss(lch, { algId: f(0, 8), keyId: f(8, 16), mi });
        }
      }
      ess.length = 0;
    }
  }
  private mac(st: number, slot: number, lch: number, facch: boolean, scr: boolean): void {
    if (facch) this.stats.facch++; else this.stats.sacch++;
    if (scr && !this.seq) return;
    const info = facch ? [...this.bits(st, 11, 36, scr, slot), ...this.bits(st, 48, 31, scr, slot), ...this.bits(st, 100, 11, scr, slot)]
      : [...this.bits(st, 11, 36, scr, slot), ...this.bits(st, 48, 54, scr, slot)];
    const n = info.length - 12; let crc = 0; for (let i = n; i < info.length; i++) crc = crc * 2 + info[i];
    if (p2Crc12(info, n) !== crc) { this.stats.macBad++; return; }
    this.stats.macOk++;
    const bytes = new Uint8Array(n >> 3); for (let i = 0; i < bytes.length; i++) { let v = 0; for (let k = 0; k < 8; k++) v = v * 2 + info[8 * i + k]; bytes[i] = v; }
    this.onMac({ lch, slot, bytes, opcode: bytes[0] >> 5, offset: (bytes[0] >> 2) & 7, facch });
  }
  /** The seed: the candidate whose sequence leaves most voice frames with a clean first Golay word, twice running. */
  private findSeed(st: number, slot: number, at: number[]): void {
    for (const [i, s] of this.seeds.entries()) {
      const K = p2Sequence(s.wacn, s.sysId, s.nac);
      let clean = 0;
      for (const f of at) if (c0Clean(this.bits(st, f, 36, true, slot, K))) clean++;
      if (2 * clean >= at.length) {
        const v = (this.seedVotes.get(i) ?? 0) + 1; this.seedVotes.set(i, v);
        if (v >= 2) { this.seed = s; this.seq = K; this.seedVotes.clear(); this.onSeed(s); return; }
      }
    }
  }
}
const hexbits = (b: ArrayLike<number>) => { const o: number[] = []; for (let i = 0; i + 6 <= b.length; i += 6) { let v = 0; for (let k = 0; k < 6; k++) v = v * 2 + b[i + k]; o.push(v); } return o; };

/** A MAC PDU's messages (BBAC 8.3): each starts with B1 B2 and a 6-bit MCO; lengths from BBAC Table 8-2. */
export interface P2Msg { b: number; mco: number; bytes: Uint8Array; name: string }
const LEN: Record<string, number> = {
  '0:1': 7, '0:33': 14, '0:2': 8, '0:34': 15, '0:5': 16, '0:37': 15, '0:48': 5, '0:49': 7,
  '1:2': 9, '1:59': 11, '1:58': 9, '1:60': 9, '1:61': 9, '1:52': 9, '1:51': 9,
  '3:3': 8, '3:59': 13, '3:58': 11, '3:60': 11,
};
const NAMES: Record<string, string> = {
  '0:1': 'GROUP VOICE CHANNEL USER', '0:33': 'GROUP VOICE CHANNEL USER (EXTENDED)', '0:2': 'UNIT TO UNIT VOICE CHANNEL USER', '0:34': 'UNIT TO UNIT VOICE CHANNEL USER (EXTENDED)',
  '0:5': 'GROUP VOICE CHANNEL GRANT UPDATE MULTIPLE', '0:37': 'GROUP VOICE CHANNEL GRANT UPDATE MULTIPLE (EXPLICIT)', '0:48': 'POWER CONTROL SIGNAL QUALITY', '0:49': 'MAC RELEASE',
  '1:2': 'GROUP VOICE CHANNEL GRANT UPDATE', '1:59': 'NETWORK STATUS BROADCAST', '1:58': 'RFSS STATUS BROADCAST', '1:60': 'ADJACENT STATUS BROADCAST', '1:61': 'IDENTIFIER UPDATE',
  '1:52': 'IDENTIFIER UPDATE VHF/UHF', '1:51': 'IDENTIFIER UPDATE TDMA', '3:3': 'GROUP VOICE CHANNEL GRANT UPDATE (EXPLICIT)',
};
export function p2Messages(pdu: Uint8Array): P2Msg[] {
  const out: P2Msg[] = [];
  let i = 1;
  while (i < pdu.length) {
    const b = pdu[i] >> 6, mco = pdu[i] & 0x3f, key = `${b}:${mco}`;
    if (b === 0 && mco === 0) break;   // null information: the rest is fill
    const len = LEN[key] ?? (b === 2 && i + 1 < pdu.length ? pdu[i + 1] & 0x3f : 0);
    if (!len || i + len > pdu.length) break;
    out.push({ b, mco, bytes: pdu.subarray(i, i + len), name: NAMES[key] ?? (b === 2 ? 'MANUFACTURER' : `MCO ${b}:${mco.toString(16).toUpperCase().padStart(2, '0')}`) });
    i += len;
  }
  return out;
}
/** MAC_PTT and MAC_END_PTT fields (BBAC 8.2.1, 8.2.2; octet positions derived from our recording). */
export function p2Ptt(pdu: Uint8Array): { mi: string; algId: number; keyId: number; src: number; group: number } {
  let mi = ''; for (let i = 1; i <= 9; i++) mi += pdu[i].toString(16).padStart(2, '0');
  return { mi, algId: pdu[10], keyId: (pdu[11] << 8) | pdu[12], src: (pdu[13] << 16) | (pdu[14] << 8) | pdu[15], group: (pdu[16] << 8) | pdu[17] };
}
export function p2EndPtt(pdu: Uint8Array): { nac: number; src: number; group: number } {
  return { nac: ((pdu[1] << 8) | pdu[2]) & 0xfff, src: (pdu[13] << 16) | (pdu[14] << 8) | pdu[15], group: (pdu[16] << 8) | pdu[17] };
}
