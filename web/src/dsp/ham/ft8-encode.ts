/**
 * FT8 encoder: standard message ("CQ K1ABC FN42", "K1ABC W9XYZ -10", "... RR73") or free text → 77-bit payload →
 * CRC-14 → LDPC(174,91) → 79 tones (S7 D29 S7 D29 S7), and a GFSK-shaped audio / baseband synthesiser. Used to
 * exercise the decoder with known signals and, behind the safety prompt, to transmit.
 */
import { FT8_COSTAS, FT8_GRAY, LDPC_GENERATOR } from './ft8-tables.js';

const NTOKENS = 2063592, MAX22 = 4194304, MAXGRID4 = 32400;

function nchar(ch: string, table: 'ANS' | 'AN' | 'N' | 'LS' | 'FULL'): number {
  let n = 0;
  if (table !== 'AN' && table !== 'N') { if (ch === ' ') return 0; n += 1; }
  if (table !== 'LS') { if (ch >= '0' && ch <= '9') return n + (ch.charCodeAt(0) - 48); n += 10; }
  if (table !== 'N') { if (ch >= 'A' && ch <= 'Z') return n + (ch.charCodeAt(0) - 65); n += 26; }
  if (table === 'FULL') { const i = '+-./?'.indexOf(ch); return i >= 0 ? n + i : -1; }
  return -1;
}

function packBasecall(call: string): number {
  if (call.length <= 2) return -1;
  let c6 = '      ';
  if (call.startsWith('3DA0') && call.length > 4 && call.length <= 7) c6 = ('3D0' + call.slice(4)).padEnd(6);
  else if (call.startsWith('3X') && /[A-Z]/.test(call[2]) && call.length <= 7) c6 = ('Q' + call.slice(2)).padEnd(6);
  else if (/[0-9]/.test(call[2]) && call.length <= 6) c6 = call.padEnd(6);
  else if (/[0-9]/.test(call[1]) && call.length <= 5) c6 = (' ' + call).padEnd(6);
  const i = [nchar(c6[0], 'ANS'), nchar(c6[1], 'AN'), nchar(c6[2], 'N'), nchar(c6[3], 'LS'), nchar(c6[4], 'LS'), nchar(c6[5], 'LS')];
  if (i.some(v => v < 0)) return -1;
  return ((((i[0] * 36 + i[1]) * 10 + i[2]) * 27 + i[3]) * 27 + i[4]) * 27 + i[5];
}
function hash22(call: string): number {
  let n58 = 0n;
  for (let i = 0; i < 11; i++) { const c = call[i] ?? ' '; let j: number; if (c === ' ') j = 0; else if (c >= '0' && c <= '9') j = 1 + (c.charCodeAt(0) - 48); else if (c >= 'A' && c <= 'Z') j = 11 + (c.charCodeAt(0) - 65); else if (c === '/') j = 37; else return -1; n58 = n58 * 38n + BigInt(j); }
  return Number(((47055833459n * n58) >> 42n) & 0x3FFFFFn);
}
/** Returns [n28, ip] or null. */
function pack28(call: string): [number, number] | null {
  if (call === 'DE') return [0, 0]; if (call === 'QRZ') return [1, 0]; if (call === 'CQ') return [2, 0];
  if (call.startsWith('CQ ') && call.length < 8) {
    const arg = call.slice(3);
    if (/^\d{3}$/.test(arg)) return [3 + Number(arg), 0];
    if (/^[A-Z]{1,4}$/.test(arg)) { let m = 0; for (const ch of arg) m = 27 * m + (ch.charCodeAt(0) - 64); return [3 + 1000 + m, 0]; }
    return null;
  }
  let ip = 0, base = call;
  if (call.endsWith('/P') || call.endsWith('/R')) { ip = 1; base = call.slice(0, -2); }
  const n = packBasecall(base);
  if (n >= 0) return [NTOKENS + MAX22 + n, ip];
  if (call.length >= 3 && call.length <= 11) { const h = hash22(call); if (h < 0) return null; return [NTOKENS + h, 0]; }
  return null;
}
function packGrid(extra: string): number {
  if (!extra) return MAXGRID4 + 1;
  if (extra === 'RRR') return MAXGRID4 + 2; if (extra === 'RR73') return MAXGRID4 + 3; if (extra === '73') return MAXGRID4 + 4;
  if (/^[A-R]{2}[0-9]{2}$/.test(extra)) return (((extra.charCodeAt(0) - 65) * 18 + (extra.charCodeAt(1) - 65)) * 10 + Number(extra[2])) * 10 + Number(extra[3]);
  const m = /^(R?)([+-]?\d{1,2})$/.exec(extra);
  if (m) return (MAXGRID4 + 35 + Number(m[2])) | (m[1] ? 0x8000 : 0);
  return MAXGRID4 + 1;
}

/** Pack a standard message into 10 payload bytes (77 bits). Returns null if the text is not a standard message. */
export function packStandard(text: string): Uint8Array | null {
  const t = text.trim().toUpperCase().replace(/\s+/g, ' ');
  const parts = t.split(' ');
  let callTo: string, callDe: string, extra: string;
  if (parts[0] === 'CQ' && parts.length >= 3 && (/^\d{3}$/.test(parts[1]) || /^[A-Z]{1,4}$/.test(parts[1])) && parts.length <= 4 && !/^[A-R]{2}\d{2}$/.test(parts[1]) && parts.length === (parts[1] === 'DX' ? 4 : 4)) { callTo = `CQ ${parts[1]}`; callDe = parts[2]; extra = parts[3] ?? ''; }
  else { if (parts.length < 2 || parts.length > 3) return null; callTo = parts[0]; callDe = parts[1]; extra = parts[2] ?? ''; }
  const a = pack28(callTo), b = pack28(callDe);
  if (!a || !b) return null;
  let i3 = 1;
  if (callTo.endsWith('/P') || callDe.endsWith('/P')) i3 = 2;
  const g = packGrid(extra);
  const igrid4 = g & 0x7FFF, ir = g >> 15;
  const n29a = (a[0] * 2 + a[1]) >>> 0, n29b = (b[0] * 2 + b[1]) >>> 0;
  const p = new Uint8Array(10);
  p[0] = n29a >>> 21; p[1] = (n29a >>> 13) & 0xFF; p[2] = (n29a >>> 5) & 0xFF; p[3] = ((n29a << 3) & 0xFF) | (n29b >>> 26);
  p[4] = (n29b >>> 18) & 0xFF; p[5] = (n29b >>> 10) & 0xFF; p[6] = (n29b >>> 2) & 0xFF; p[7] = ((n29b << 6) & 0xFF) | (ir << 5) | (igrid4 >>> 10);
  p[8] = (igrid4 >>> 2) & 0xFF; p[9] = ((igrid4 << 6) & 0xFF) | (i3 << 3);
  return p;
}

/** Pack up to 13 characters of free text (A-Z 0-9 +-./? and space). */
export function packFree(text: string): Uint8Array {
  const t = text.toUpperCase().slice(0, 13).padStart(13, ' ');
  let n = 0n;
  for (const ch of t) { const v = nchar(ch, 'FULL'); n = n * 42n + BigInt(v < 0 ? 0 : v); }
  const p = new Uint8Array(10);
  // 71 bits into bits 0..70 (MSB first), i3 = 0, n3 = 0 → shift left by 1 within the 77-bit field
  n <<= 1n;
  for (let i = 8; i >= 0; i--) { p[i] = Number(n & 0xFFn); n >>= 8n; }
  return p;
}

function crc14(msg: Uint8Array, numBits: number): number {
  let rem = 0, idx = 0;
  for (let b = 0; b < numBits; b++) { if (b % 8 === 0) rem ^= msg[idx++] << 6; rem = rem & 0x2000 ? ((rem << 1) ^ 0x2757) : (rem << 1); }
  return rem & 0x3FFF;
}

/** 77-bit payload → 79 tone indices. */
export function ft8Tones(payload: Uint8Array): Uint8Array {
  const a91 = new Uint8Array(12); a91.set(payload.subarray(0, 10)); a91[9] &= 0xF8; a91[10] = 0;
  const crc = crc14(a91, 82);
  a91[9] |= crc >> 11; a91[10] = (crc >> 3) & 0xFF; a91[11] = (crc << 5) & 0xFF;
  // LDPC: 174 bits = 91 message bits + 83 parity bits
  const cw = new Uint8Array(22); for (let j = 0; j < 12; j++) cw[j] = a91[j];
  let colMask = 0x80 >> (91 % 8), colIdx = 11;
  for (let i = 0; i < 83; i++) {
    let nsum = 0;
    for (let j = 0; j < 12; j++) { let bits = a91[j] & LDPC_GENERATOR[i * 12 + j]; bits ^= bits >> 4; bits ^= bits >> 2; bits ^= bits >> 1; nsum ^= bits & 1; }
    if (nsum) cw[colIdx] |= colMask;
    colMask >>= 1; if (colMask === 0) { colMask = 0x80; colIdx++; }
  }
  const tones = new Uint8Array(79);
  for (let k = 0; k < 7; k++) { tones[k] = FT8_COSTAS[k]; tones[36 + k] = FT8_COSTAS[k]; tones[72 + k] = FT8_COSTAS[k]; }
  let bit = 0;
  for (let k = 0; k < 58; k++) {
    const sym = k + (k < 29 ? 7 : 14);
    let v = 0; for (let b = 0; b < 3; b++, bit++) v = (v << 1) | ((cw[bit >> 3] >> (7 - (bit & 7))) & 1);
    tones[sym] = FT8_GRAY[v];
  }
  return tones;
}

/** Real audio at `rate` Hz: 79 symbols of 0.16 s, tone 0 at baseHz, 6.25 Hz spacing, Gaussian-smoothed frequency. */
export function ft8Audio(tones: Uint8Array, baseHz: number, rate: number, amplitude = 0.5): Float32Array {
  const symLen = Math.round(rate * 0.16), n = symLen * 79, out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(78, Math.floor(i / symLen)), frac = (i % symLen) / symLen;
    // smooth the frequency across symbol boundaries (a light GFSK-like ramp over 20% of the symbol)
    let tone = tones[s];
    if (frac < 0.1 && s > 0) tone = tones[s - 1] + (tones[s] - tones[s - 1]) * (0.5 + frac * 5);
    else if (frac > 0.9 && s < 78) tone = tones[s] + (tones[s + 1] - tones[s]) * ((frac - 0.9) * 5);
    ph += 2 * Math.PI * (baseHz + tone * 6.25) / rate; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
    out[i] = amplitude * Math.sin(ph);
  }
  return out;
}
