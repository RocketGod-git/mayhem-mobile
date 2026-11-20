/**
 * Fleet coding layers: P25 Phase 1 (TIA-102) control channel and DMR (ETSI TS 102 361) bursts. Decoders and the
 * matching encoders (the encoders build synthetic signals and pin each layer down in tests). No DOM.
 *
 * P25 trellis, interleave and bit assignment are the ones derived from our own recordings; the BCH Network ID,
 * BPTC(196,96) and Golay(20,8) come from the shared ham decoders.
 */
import { nidWord } from '../ham/p25.js';
import { bptc, hamming, H15113, H1393 } from '../ham/dmr.js';
import { golay208, golayParity, popcount } from '../ham/mbe.js';

export { bptc, golay208 };

// ------------------------------------------------------------------------------------------------ CRC-CCITT
const CRC_T = new Uint16Array(256);
for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; CRC_T[i] = c; }
/** x^16+x^12+x^5+1, init 0, MSB first, output complemented, over the first n bytes. */
export function crcCcitt(b: ArrayLike<number>, n: number): number {
  let crc = 0;
  for (let i = 0; i < n; i++) crc = ((crc << 8) & 0xffff) ^ CRC_T[((crc >> 8) ^ b[i]) & 0xff];
  return ~crc & 0xffff;
}
/** A 12-byte block whose last two bytes are the CRC of the first ten, XORed with the data-type mask. */
export function crc12Ok(b: ArrayLike<number>, mask = 0): boolean {
  return ((b[10] << 8) | b[11]) === (crcCcitt(b, 10) ^ mask);
}
/** DMR CRC masks by data type (TS 102 361-1 B.3.12). */
export const DMR_CRC_MASK: Record<number, number> = { 0: 0x6969, 3: 0xa5a5, 4: 0xaaaa, 5: 0xaaaa, 6: 0xcccc };

// ------------------------------------------------------------------------------------------------ P25 NID
const nidCache = new Map<number, { hi: number; lo: number }>();
function nidCw(nac: number, duid: number): { hi: number; lo: number } {
  const k = (nac << 4) | duid;
  let w = nidCache.get(k);
  if (!w) { w = nidWord(nac, duid); if (nidCache.size > 4096) nidCache.clear(); nidCache.set(k, w); }
  return w;
}
/** The 64 NID bits for a network access code and data unit ID, as 32 dibits. */
export function nidEncode(nac: number, duid: number): Uint8Array {
  const w = nidCw(nac, duid), out = new Uint8Array(32);
  for (let i = 0; i < 16; i++) out[i] = (w.hi >>> (30 - 2 * i)) & 3;
  for (let i = 0; i < 16; i++) out[16 + i] = (w.lo >>> (30 - 2 * i)) & 3;
  return out;
}
const bits32 = (x: number) => popcount(x >>> 0);
/**
 * BCH(63,16) plus overall parity: nearest code word among the received NAC, the NACs already heard and every
 * single-bit change of the received one, over all 16 DUIDs. Returns null past 11 bit errors.
 */
export function nidDecode(d: ArrayLike<number>, known: Iterable<number> = []): { nac: number; duid: number; errs: number } | null {
  let hi = 0, lo = 0;
  for (let i = 0; i < 16; i++) hi = ((hi << 2) | d[i]) >>> 0;
  for (let i = 0; i < 16; i++) lo = ((lo << 2) | d[16 + i]) >>> 0;
  const rx = hi >>> 20, cands = new Set<number>([rx, ...known]);
  for (let b = 0; b < 12; b++) cands.add(rx ^ (1 << b));
  let best = 99, bn = -1, bd = -1;
  for (const nac of cands) for (let duid = 0; duid < 16; duid++) {
    const w = nidCw(nac, duid), e = bits32(hi ^ w.hi) + bits32(lo ^ w.lo);
    if (e < best) { best = e; bn = nac; bd = duid; }
  }
  return best <= 11 ? { nac: bn, duid: bd, errs: best } : null;
}

// ------------------------------------------------------------------------------------------------ P25 trellis
/** Output (two dibits, first in the high bits) by [state = previous input dibit][input dibit]. */
export const TRELLIS: number[][] = [
  [0b0010, 0b1100, 0b0001, 0b1111],
  [0b1110, 0b0000, 0b1101, 0b0011],
  [0b1001, 0b0111, 0b1010, 0b0100],
  [0b0101, 0b1011, 0b0110, 0b1000],
];
/** Pair-symbol k of the trellis output is sent at this pair position. */
export const TSBK_SLOT = Array.from({ length: 49 }, (_, k) => [0, 13, 25, 37][k % 4] + (k >> 2));

/** 12 bytes → 98 transmitted dibits (rate 1/2 trellis, flush input 0, interleaved). */
export function tsbkEncode(bytes: ArrayLike<number>): Uint8Array {
  const pairs = new Uint8Array(49);
  let st = 0;
  for (let k = 0; k < 49; k++) {
    const inp = k < 48 ? (bytes[k >> 2] >> (6 - 2 * (k & 3))) & 3 : 0;
    pairs[TSBK_SLOT[k]] = TRELLIS[st][inp]; st = inp;
  }
  const out = new Uint8Array(98);
  for (let j = 0; j < 49; j++) { out[2 * j] = pairs[j] >> 2; out[2 * j + 1] = pairs[j] & 3; }
  return out;
}
/** Hard-decision Viterbi over the 98 dibits: the 12 bytes and the path metric (bit errors corrected). */
export function tsbkDecode(d: ArrayLike<number>): { bytes: Uint8Array; metric: number } {
  const sym = new Uint8Array(49);
  for (let k = 0; k < 49; k++) { const j = TSBK_SLOT[k]; sym[k] = ((d[2 * j] & 3) << 2) | (d[2 * j + 1] & 3); }
  let pm = [0, 1e9, 1e9, 1e9];
  const back = new Uint8Array(49 * 4);
  for (let k = 0; k < 49; k++) {
    const np = [1e9, 1e9, 1e9, 1e9];
    for (let s = 0; s < 4; s++) {
      if (pm[s] >= 1e9) continue;
      for (let i = 0; i < 4; i++) {
        if (k === 48 && i !== 0) continue;
        const m = pm[s] + popcount(TRELLIS[s][i] ^ sym[k]);
        if (m < np[i]) { np[i] = m; back[k * 4 + i] = s; }
      }
    }
    pm = np;
  }
  const inputs = new Uint8Array(49);
  let s = 0;
  for (let k = 48; k >= 0; k--) { inputs[k] = s; s = back[k * 4 + s]; }
  const bytes = new Uint8Array(12);
  for (let k = 0; k < 48; k++) bytes[k >> 2] |= inputs[k] << (6 - 2 * (k & 3));
  return { bytes, metric: pm[0] };
}

// ------------------------------------------------------------------------------------------------ P25 frame
export const P25_SYNC = '5575F5FF77FF';
/** Frame positions (counted from the first sync symbol) that carry a status symbol. */
export const isStatusPos = (pos: number) => pos % 36 === 35;
/** Sign pattern (+1 / -1 per symbol) of a 48-bit sync word in hex: dibit 01 is +3, 11 is -3. */
export function syncSigns(hex: string): Int8Array {
  const out: number[] = [];
  for (const ch of hex) { const v = parseInt(ch, 16); out.push((v & 8) ? -1 : 1, (v & 2) ? -1 : 1); }
  return Int8Array.from(out);
}
/** One trunking signaling frame: sync, NID, the TSBKs (last-block flag set on the last), status symbols interleaved. */
export function p25TsduSymbols(nac: number, tsbks: ArrayLike<number>[], status = 1): Uint8Array {
  const info: number[] = [];
  for (const s of syncSigns(P25_SYNC)) info.push(s > 0 ? 1 : 3);
  for (const d of nidEncode(nac, 7)) info.push(d);
  for (const t of tsbks) for (const d of tsbkEncode(t)) info.push(d);
  const out: number[] = [];
  let k = 0;
  while (k < info.length) { if (isStatusPos(out.length)) out.push(status); else out.push(info[k++]); }
  while (out.length % 36 !== 0 && !isStatusPos(out.length)) out.push(0);
  if (isStatusPos(out.length)) out.push(status);
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------------------------------------ DMR burst
export const DMR_SYNC = { bsData: 'DFF57D75DF5D', bsVoice: '755FD7DF75F7', msData: 'D5D7F77FD757', msVoice: '7F7D5DD57DFD' };
/** Golay(20,8): 8 data bits → 20 bits (11 parity bits of the (23,12) code, then the overall parity). */
export function golay208Encode(data: number): number {
  const p = golayParity(data & 0xff, 8), w = ((data & 0xff) << 11) | p;
  return ((w << 1) | (popcount(w) & 1)) >>> 0;
}
/** Golay(20,8) decode: data byte and corrections, or -1. */
export function golay208Decode(w20: number): { data: number; errs: number } | null {
  const c = golay208(w20 >>> 1);
  return c < 0 ? null : { data: c & 0xff, errs: c >> 8 };
}
/** BPTC(196,96) encode: 12 bytes → 196 interleaved bits. */
export function bptcEncode(bytes: ArrayLike<number>): Uint8Array {
  const m = new Uint8Array(196);
  const bit = (i: number) => (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  let p = 0;
  for (let a = 4; a <= 11; a++) m[a] = bit(p++);
  for (let r = 1; r < 9; r++) for (let a = r * 15 + 1; a <= r * 15 + 11; a++) m[a] = bit(p++);
  for (let r = 0; r < 9; r++) {
    const off = r * 15 + 1;
    for (let q = 0; q < 4; q++) { let c = 0; for (let i = 0; i < 11; i++) if (H15113[q] & (1 << i)) c ^= m[off + i]; m[off + 11 + q] = c; }
  }
  for (let c = 0; c < 15; c++) {
    const col = new Uint8Array(13);
    for (let a = 0; a < 9; a++) col[a] = m[c + 1 + a * 15];
    for (let q = 0; q < 4; q++) { let v = 0; for (let i = 0; i < 9; i++) if (H1393[q] & (1 << i)) v ^= col[i]; m[c + 1 + (9 + q) * 15] = v; }
  }
  const raw = new Uint8Array(196);
  for (let a = 0; a < 196; a++) raw[(a * 181) % 196] = m[a];
  return raw;
}
/** CACH TACT: access type, slot (TC), LCSS, Hamming(7,4) parity; bit positions inside the 24-bit CACH. */
const TACT_POS = [0, 4, 8, 12, 14, 18, 22];
export function tactEncode(at: number, tc: number, lcss: number): number[] {
  const d = [at & 1, tc & 1, (lcss >> 1) & 1, lcss & 1];
  return [...d, d[0] ^ d[1] ^ d[2], d[1] ^ d[2] ^ d[3], d[0] ^ d[1] ^ d[3]];
}
export function cachSlot(cach24: ArrayLike<number>): number { return cach24[TACT_POS[1]] & 1; }
/** A whole 144-symbol base-station data burst (dibits): CACH, payload, slot type, sync, slot type, payload. */
export function dmrDataBurst(slot: number, cc: number, dt: number, bytes: ArrayLike<number>, busy = 1): Uint8Array {
  const cach = new Uint8Array(24), t = tactEncode(busy, slot, 0);
  TACT_POS.forEach((p, i) => { cach[p] = t[i]; });
  const st = golay208Encode((cc << 4) | dt), payload = bptcEncode(bytes);
  const bits = new Uint8Array(288);
  bits.set(cach, 0);
  bits.set(payload.subarray(0, 98), 24);
  for (let i = 0; i < 10; i++) bits[122 + i] = (st >>> (19 - i)) & 1;
  const sync = syncSigns(DMR_SYNC.bsData);
  for (let i = 0; i < 24; i++) { const v = sync[i] > 0 ? 1 : 3; bits[132 + 2 * i] = v >> 1; bits[133 + 2 * i] = v & 1; }
  for (let i = 0; i < 10; i++) bits[180 + i] = (st >>> (9 - i)) & 1;
  bits.set(payload.subarray(98), 190);
  const out = new Uint8Array(144);
  for (let i = 0; i < 144; i++) out[i] = (bits[2 * i] << 1) | bits[2 * i + 1];
  return out;
}
/** [ms]: a mobile station sent it (an MS sync): no CACH, so no slot or busy bit is read from it (slot 0, busy 0). */
export interface DmrBurst { slot: number; cc: number; dt: number; stErrs: number; bytes: Uint8Array; busy: number; ms?: boolean }
/** Reads a 144-dibit base-station data burst: slot from the CACH, slot type through Golay, payload through BPTC. */
export function dmrReadBurst(d: ArrayLike<number>): DmrBurst | null {
  let st = 0;
  for (let i = 61; i <= 65; i++) st = (st << 2) | d[i];
  for (let i = 90; i <= 94; i++) st = (st << 2) | d[i];
  const g = golay208Decode(st >>> 0);
  if (!g) return null;
  const cach = new Uint8Array(24);
  for (let i = 0; i < 12; i++) { cach[2 * i] = d[i] >> 1; cach[2 * i + 1] = d[i] & 1; }
  const raw = new Uint8Array(196);
  let p = 0;
  for (let i = 12; i <= 60; i++) { raw[p++] = d[i] >> 1; raw[p++] = d[i] & 1; }
  for (let i = 95; i <= 143; i++) { raw[p++] = d[i] >> 1; raw[p++] = d[i] & 1; }
  return { slot: cachSlot(cach), cc: g.data >> 4, dt: g.data & 15, stErrs: g.errs, bytes: bptc(raw), busy: cach[0] };
}
/** Hamming(15,11) of one BPTC row, for the layer tests. */
export const bptcRowCheck = (row: Uint8Array) => hamming(row, 0, 11, H15113);

// ------------------------------------------------------------------------------------------------ helpers
export const hex = (b: ArrayLike<number>, from = 0, to = b.length) => { let s = ''; for (let i = from; i < to; i++) s += (b[i] & 255).toString(16).padStart(2, '0'); return s; };
export const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));
