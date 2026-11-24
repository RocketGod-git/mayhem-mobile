/**
 * Shared coding blocks for the D-STAR and Fusion decoders: a hard-decision Viterbi decoder for the rate 1/2
 * convolutional codes both use (D-STAR K = 3, G1 = 1 + D + D², G2 = 1 + D²; Fusion K = 5, G1 = 1 + D³ + D⁴,
 * G2 = 1 + D + D² + D⁴, outputs G1 then G2), the extended Golay (24,12,8) of the Fusion FICH from the generator
 * matrix in Yaesu's specification (appendix A), the CRCs, and bit packing. No DOM.
 */

const parity = (x: number) => { x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1; return x & 1; };

/** Generator masks: bit k is the coefficient of D^k (bit 0 the newest input). */
export const DSTAR_K = 3, DSTAR_G = [0b111, 0b101];
export const YSF_K = 5, YSF_G = [0b11001, 0b10111];

/** Rate 1/2 convolutional encoder (register cleared first; the caller appends the tail bits). */
export function convEncode(bits: ArrayLike<number>, K: number, g: number[]): Uint8Array {
  const out = new Uint8Array(bits.length * 2), m = (1 << K) - 1;
  let r = 0;
  for (let i = 0; i < bits.length; i++) { r = ((r << 1) | (bits[i] & 1)) & m; out[2 * i] = parity(r & g[0]); out[2 * i + 1] = parity(r & g[1]); }
  return out;
}

/** Hard-decision Viterbi: pairs of coded bits → the input bits, ending in state 0 (tail bits included in the output). */
export function viterbi(coded: ArrayLike<number>, K: number, g: number[]): { bits: Uint8Array; errs: number } {
  const S = 1 << (K - 1), n = coded.length >> 1, m = (1 << K) - 1;
  let pm = new Int32Array(S).fill(1 << 20); pm[0] = 0;
  let nx = new Int32Array(S);
  const from = new Uint8Array(n * S);                    // the input bit of the survivor into each state
  const prev = new Int32Array(n * S);
  // expected outputs for every (state, input)
  const o0 = new Uint8Array(S * 2), o1 = new Uint8Array(S * 2);
  for (let s = 0; s < S; s++) for (let b = 0; b < 2; b++) { const r = ((s << 1) | b) & m; o0[s * 2 + b] = parity(r & g[0]); o1[s * 2 + b] = parity(r & g[1]); }
  for (let i = 0; i < n; i++) {
    nx.fill(1 << 30);
    const c0 = coded[2 * i] & 1, c1 = coded[2 * i + 1] & 1;
    for (let s = 0; s < S; s++) {
      const base = pm[s]; if (base >= 1 << 29) continue;
      for (let b = 0; b < 2; b++) {
        const ns = ((s << 1) | b) & (S - 1);
        const d = base + (o0[s * 2 + b] ^ c0) + (o1[s * 2 + b] ^ c1);
        if (d < nx[ns]) { nx[ns] = d; from[i * S + ns] = b; prev[i * S + ns] = s; }
      }
    }
    const t = pm; pm = nx; nx = t;
  }
  const bits = new Uint8Array(n);
  let s = 0;
  for (let i = n - 1; i >= 0; i--) { bits[i] = from[i * S + s]; s = prev[i * S + s]; }
  return { bits, errs: pm[0] };
}

// ------------------------------------------------------------------------------------------------ Golay (24,12,8)
/** Parity rows of the generator matrix, one per data bit d11..d0 (p11 is the parity word's top bit). */
const G24 = [0xc75, 0x63b, 0xf68, 0x7b4, 0x3da, 0xd99, 0x6cd, 0x367, 0xdc6, 0xa97, 0x93e, 0x8eb];
export function golay24Parity(d12: number): number {
  let p = 0; for (let j = 0; j < 12; j++) if (d12 & (1 << (11 - j))) p ^= G24[j];
  return p;
}
export const golay24Encode = (d12: number) => ((d12 & 0xfff) << 12) | golay24Parity(d12 & 0xfff);
const G24_FIX = (() => {
  const t = new Int32Array(4096).fill(-1);
  const syn = (e: number) => golay24Parity(e >>> 12) ^ (e & 0xfff);
  t[0] = 0;
  for (let a = 0; a < 24; a++) {
    t[syn(1 << a)] = 1 << a;
    for (let b = a + 1; b < 24; b++) {
      t[syn((1 << a) | (1 << b))] = (1 << a) | (1 << b);
      for (let c = b + 1; c < 24; c++) t[syn((1 << a) | (1 << b) | (1 << c))] = (1 << a) | (1 << b) | (1 << c);
    }
  }
  return t;
})();
/** 24-bit word → { data, errs }, or null past three errors. */
export function golay24Decode(w: number): { data: number; errs: number } | null {
  const e = G24_FIX[golay24Parity((w >>> 12) & 0xfff) ^ (w & 0xfff)];
  if (e < 0) return null;
  let c = 0, x = e; while (x) { x &= x - 1; c++; }
  return { data: ((w ^ e) >>> 12) & 0xfff, errs: c };
}

// ------------------------------------------------------------------------------------------------ CRCs
/** CRC-16 x^16+x^12+x^5+1 MSB first, register cleared, complemented at the end (Fusion FICH and DCH). */
export function crc16Msb(bytes: ArrayLike<number>, n: number): number {
  let crc = 0;
  for (let i = 0; i < n; i++) {
    crc ^= (bytes[i] & 255) << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return ~crc & 0xffff;
}
/** CRC-16 with the reflected polynomial 0x8408, register all ones, complemented (D-STAR header P_FCS and D-PRS). */
export function crc16Lsb(bytes: ArrayLike<number>, n: number): number {
  let crc = 0xffff;
  for (let i = 0; i < n; i++) {
    crc ^= bytes[i] & 255;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

// ------------------------------------------------------------------------------------------------ bits
/** Bits (first sent first) → bytes, each byte's first bit its MSB. */
export function packMsb(bits: ArrayLike<number>, from: number, nBytes: number): Uint8Array {
  const out = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes * 8; i++) if (bits[from + i] & 1) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}
/** Bits → bytes, each byte's first bit its LSB (D-STAR sends every byte LSB first). */
export function packLsb(bits: ArrayLike<number>, from: number, nBytes: number): Uint8Array {
  const out = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes * 8; i++) if (bits[from + i] & 1) out[i >> 3] |= 1 << (i & 7);
  return out;
}
/** Printable ASCII of a fixed-width field, trailing spaces dropped. */
export function asciiField(b: ArrayLike<number>, from: number, len: number): string {
  let s = '';
  for (let i = from; i < from + len; i++) { const c = b[i] & 255; s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
  return s.replace(/\s+$/, '');
}
