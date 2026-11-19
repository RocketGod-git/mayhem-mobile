/**
 * JS8 frame coding: 72 payload bits + 3 transmission-flag bits + CRC-12 = 87 information bits, the (174,87) LDPC
 * code (87 parity bits sent first), 58 data tones of 3 bits each in natural binary order (MSB first), and three
 * 7-tone Costas blocks at symbols 0, 36 and 72.
 *
 * The CRC is the augmented CRC-12 with polynomial 0xC06 over the 75 bits followed by 13 zero bits, then XORed with
 * 42. Checked against the three TX.FRAME tone vectors in the JS8Call API documentation.
 */
import { ALPHABET72, LDPC_NM } from './tables.js';

export const N = 174, K = 87, M = 87;
/** Transmission flags (bits 72-74): first and last frame of a transmission; 4 is reserved. */
export const FLAG_FIRST = 1, FLAG_LAST = 2, FLAG_RESERVED = 4;

// ---- parity-check structure ----------------------------------------------------------------------------------
const NM_ROWS: number[][] = [];
for (let m = 0; m < M; m++) { const r: number[] = []; for (let j = 0; j < 7; j++) { const v = LDPC_NM[m * 7 + j]; if (v) r.push(v - 1); } NM_ROWS.push(r); }
/** For each codeword bit, the checks it is in. */
const MN_COLS: number[][] = Array.from({ length: N }, () => []);
for (let m = 0; m < M; m++) for (const n of NM_ROWS[m]) MN_COLS[n].push(m);

/** Parity bits from information bits: P = Hp^-1 Hu, built once by Gaussian elimination over GF(2). */
const PARITY_ROWS: Uint8Array[] = (() => {
  // augmented [Hp | Hu], rows = checks
  const a = NM_ROWS.map(r => { const row = new Uint8Array(N); for (const n of r) row[n] ^= 1; return row; });
  for (let c = 0; c < K; c++) {
    let p = c; while (p < M && !a[p][c]) p++;
    if (p === M) throw new Error('JS8 LDPC: parity block is singular');
    if (p !== c) { const t = a[p]; a[p] = a[c]; a[c] = t; }
    for (let r = 0; r < M; r++) if (r !== c && a[r][c]) { const rr = a[r], rc = a[c]; for (let j = c; j < N; j++) rr[j] ^= rc[j]; }
  }
  // now row c reads p_c + sum(Hu' u) = 0
  return a.map(row => row.slice(K));
})();

/** 87 information bits → 174-bit codeword (parity first). */
export function ldpcEncode(info: Uint8Array): Uint8Array {
  const cw = new Uint8Array(N);
  for (let i = 0; i < K; i++) cw[K + i] = info[i];
  for (let r = 0; r < M; r++) { const row = PARITY_ROWS[r]; let s = 0; for (let i = 0; i < K; i++) s ^= row[i] & info[i]; cw[r] = s; }
  return cw;
}

/** Failed parity checks of a hard codeword. */
export function syndrome(cw: Uint8Array): number {
  let e = 0;
  for (const r of NM_ROWS) { let x = 0; for (const n of r) x ^= cw[n]; e += x; }
  return e;
}

// flat edge tables for the decoder
const ROW_START = new Int32Array(M + 1), ROW_VAR: number[] = [];
for (let m = 0; m < M; m++) { ROW_START[m] = ROW_VAR.length; ROW_VAR.push(...NM_ROWS[m]); }
ROW_START[M] = ROW_VAR.length;
const NE = ROW_VAR.length, EDGE_VAR = Int32Array.from(ROW_VAR);
const COL_START = new Int32Array(N + 1), COL_EDGE = new Int32Array(NE);
{ let k = 0; for (let n = 0; n < N; n++) { COL_START[n] = k; for (let e = 0; e < NE; e++) if (EDGE_VAR[e] === n) COL_EDGE[k++] = e; } COL_START[N] = k; }
const c2v = new Float32Array(NE), v2c = new Float32Array(NE), th = new Float32Array(NE);
/**
 * Sum-product belief propagation. `llr` > 0 means a 1. Returns the codeword with 0 failed checks, or null. Gives
 * up early when the failed-check count stops falling.
 */
export const ModeDecoderTune = { patience: 8 };
export function ldpcDecode(llr: Float32Array, maxIters = 30): Uint8Array | null {
  const hard = new Uint8Array(N);
  for (let n = 0; n < N; n++) for (let k = COL_START[n]; k < COL_START[n + 1]; k++) v2c[COL_EDGE[k]] = llr[n];
  let best = M, since = 0;
  for (let it = 0; it < maxIters; it++) {
    for (let e = 0; e < NE; e++) th[e] = Math.tanh(-v2c[e] / 2);
    for (let m = 0; m < M; m++) {
      const a = ROW_START[m], b = ROW_START[m + 1];
      for (let i = a; i < b; i++) { let p = 1; for (let j = a; j < b; j++) if (j !== i) p *= th[j]; c2v[i] = -2 * Math.atanh(Math.max(-0.999999, Math.min(0.999999, p))); }
    }
    for (let n = 0; n < N; n++) {
      let s = llr[n]; const a = COL_START[n], b = COL_START[n + 1];
      for (let k = a; k < b; k++) s += c2v[COL_EDGE[k]];
      hard[n] = s > 0 ? 1 : 0;
      for (let k = a; k < b; k++) { const e = COL_EDGE[k]; v2c[e] = s - c2v[e]; }
    }
    const err = syndrome(hard);
    if (err === 0) return hard;
    if (err < best) { best = err; since = 0; } else if (++since >= ModeDecoderTune.patience) break;
  }
  return null;
}

// ---- CRC-12 ---------------------------------------------------------------------------------------------------
export function crc12(bits: ArrayLike<number>, count: number): number {
  let r = 0;
  const step = (x: number) => { const top = (r >> 11) & 1; r = ((r << 1) | x) & 0xFFF; if (top) r ^= 0xC06; };
  for (let i = 0; i < count; i++) step(bits[i] & 1);
  for (let i = 0; i < 13; i++) step(0);
  return r ^ 42;
}

// ---- frames -----------------------------------------------------------------------------------------------------
/** A frame's 12-character field (72 bits) plus its 3 flag bits. */
export interface Frame { payload: Uint8Array; flags: number; }

export function payloadToText(p: Uint8Array): string { let s = ''; for (let i = 0; i < 12; i++) { let v = 0; for (let b = 0; b < 6; b++) v = (v << 1) | p[i * 6 + b]; s += ALPHABET72[v]; } return s; }
export function textToPayload(t: string): Uint8Array | null {
  if (t.length !== 12) return null;
  const p = new Uint8Array(72);
  for (let i = 0; i < 12; i++) { const v = ALPHABET72.indexOf(t[i]); if (v < 0) return null; for (let b = 0; b < 6; b++) p[i * 6 + b] = (v >> (5 - b)) & 1; }
  return p;
}

/** 72 payload bits + flags → 87 information bits with the CRC. */
export function infoBits(f: Frame): Uint8Array {
  const info = new Uint8Array(K);
  info.set(f.payload.subarray(0, 72));
  for (let b = 0; b < 3; b++) info[72 + b] = (f.flags >> (2 - b)) & 1;
  const c = crc12(info, 75);
  for (let b = 0; b < 12; b++) info[75 + b] = (c >> (11 - b)) & 1;
  return info;
}
/** 87 information bits → frame, or null when the CRC fails. */
export function checkInfo(info: Uint8Array): Frame | null {
  let c = 0; for (let b = 0; b < 12; b++) c = (c << 1) | info[75 + b];
  if (crc12(info, 75) !== c) return null;
  return { payload: info.slice(0, 72), flags: (info[72] << 2) | (info[73] << 1) | info[74] };
}

/** Data-tone position of the k-th of the 58 data symbols. */
export const dataSym = (k: number): number => k < 29 ? 7 + k : 14 + k;

/** A frame → 79 tones with the mode's Costas blocks. */
export function frameTones(f: Frame, costas: readonly (readonly number[])[]): Uint8Array {
  const cw = ldpcEncode(infoBits(f));
  const t = new Uint8Array(79);
  for (let b = 0; b < 3; b++) for (let k = 0; k < 7; k++) t[36 * b + k] = costas[b][k];
  for (let k = 0; k < 58; k++) t[dataSym(k)] = (cw[3 * k] << 2) | (cw[3 * k + 1] << 1) | cw[3 * k + 2];
  return t;
}
/** 79 hard tones → frame (LDPC hard check, no correction), for known tone vectors. */
export function tonesFrame(t: ArrayLike<number>): Frame | null {
  const cw = new Uint8Array(N);
  for (let k = 0; k < 58; k++) { const v = t[dataSym(k)]; cw[3 * k] = (v >> 2) & 1; cw[3 * k + 1] = (v >> 1) & 1; cw[3 * k + 2] = v & 1; }
  if (syndrome(cw) !== 0) return null;
  return checkInfo(cw.subarray(K));
}

