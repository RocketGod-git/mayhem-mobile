/**
 * DMR full link control (ETSI TS 102 361-1 and -2): the 72-bit LC carried in the voice LC header and terminator
 * bursts, its Reed-Solomon (12,9) check over GF(256) with the per-burst masks, and the voice burst payload split into
 * its three 72-bit vocoder frames. No DOM.
 */

// ------------------------------------------------------------------------------------------------ GF(256)
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a: number, b: number) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
/** g(x) = (x + α)(x + α²)(x + α³), highest power first. */
const GEN = (() => { let g = [1]; for (let r = 1; r <= 3; r++) { const n = new Array(g.length + 1).fill(0); for (let i = 0; i < g.length; i++) { n[i] ^= g[i]; n[i + 1] ^= mul(g[i], EXP[r]); } g = n; } return g; })();

/** RS(12,9) parity of nine data bytes (the first byte is the highest power). */
export function rs129Parity(d: ArrayLike<number>): [number, number, number] {
  const r = [0, 0, 0];
  for (let i = 0; i < 9; i++) {
    const fb = (d[i] & 255) ^ r[0];
    r[0] = r[1] ^ mul(fb, GEN[1]); r[1] = r[2] ^ mul(fb, GEN[2]); r[2] = mul(fb, GEN[3]);
  }
  return [r[0], r[1], r[2]];
}
/** CRC masks of the RS parity by data type: voice LC header, terminator with LC. */
export const RS_MASK: Record<number, number> = { 1: 0x969696, 2: 0x999999 };
export function rs129Ok(b: ArrayLike<number>, dt: number): boolean {
  const m = RS_MASK[dt]; if (m === undefined) return false;
  const p = rs129Parity(b);
  return (b[9] ^ (m >> 16)) === p[0] && (b[10] ^ ((m >> 8) & 255)) === p[1] && (b[11] ^ (m & 255)) === p[2];
}

// ------------------------------------------------------------------------------------------------ LC
export interface DmrLc { flco: number; fid: number; group: boolean; dst: number; src: number; emergency: boolean; privacy: boolean; priority: number; ok: boolean }
/** Full LC from the 12 bytes of a voice LC header (dt 1) or terminator (dt 2). FLCO 0 is a group call, 3 unit to unit. */
export function parseLc(b: ArrayLike<number>, dt: number): DmrLc | null {
  const flco = b[0] & 0x3f;
  if (flco !== 0 && flco !== 3) return null;
  const so = b[2];
  return {
    flco, fid: b[1], group: flco === 0, dst: (b[3] << 16) | (b[4] << 8) | b[5], src: (b[6] << 16) | (b[7] << 8) | b[8],
    emergency: (so & 0x80) !== 0, privacy: (so & 0x40) !== 0, priority: so & 3, ok: rs129Ok(b, dt),
  };
}
/** The 12 bytes of a voice LC burst (for the synthetic signals in the tests). */
export function lcBytes(lc: { group: boolean; dst: number; src: number; emergency?: boolean; privacy?: boolean; fid?: number }, dt: number): Uint8Array {
  const b = new Uint8Array(12);
  b[0] = lc.group ? 0 : 3; b[1] = lc.fid ?? 0; b[2] = (lc.emergency ? 0x80 : 0) | (lc.privacy ? 0x40 : 0);
  b[3] = (lc.dst >> 16) & 255; b[4] = (lc.dst >> 8) & 255; b[5] = lc.dst & 255; b[6] = (lc.src >> 16) & 255; b[7] = (lc.src >> 8) & 255; b[8] = lc.src & 255;
  const p = rs129Parity(b), m = RS_MASK[dt];
  b[9] = p[0] ^ (m >> 16); b[10] = p[1] ^ ((m >> 8) & 255); b[11] = p[2] ^ (m & 255);
  return b;
}

// ------------------------------------------------------------------------------------------------ voice payload
/**
 * The three 72-bit vocoder frames of a 144-dibit voice burst: the 216 payload bits are the 108 before and the 108
 * after the 48-bit center field, in order, cut 72 / 72 / 72. The bits inside each frame stay as sent.
 */
export function voiceFrames(d: ArrayLike<number>): [Uint8Array, Uint8Array, Uint8Array] {
  const bits = new Uint8Array(216);
  let p = 0;
  for (let i = 12; i < 66; i++) { bits[p++] = d[i] >> 1; bits[p++] = d[i] & 1; }
  for (let i = 90; i < 144; i++) { bits[p++] = d[i] >> 1; bits[p++] = d[i] & 1; }
  return [bits.slice(0, 72), bits.slice(72, 144), bits.slice(144, 216)];
}
