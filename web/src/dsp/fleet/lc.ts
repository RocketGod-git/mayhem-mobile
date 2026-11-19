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
  // FLCO 0 group, 3 unit; under Motorola's feature set (FID 0x10) Capacity Plus sends its group voice LC as FLCO 0x20
  if (flco !== 0 && flco !== 3 && !(b[1] === 0x10 && flco === 0x20)) return null;
  const so = b[2];
  return {
    flco, fid: b[1], group: flco !== 3, dst: (b[3] << 16) | (b[4] << 8) | b[5], src: (b[6] << 16) | (b[7] << 8) | b[8],
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

// ------------------------------------------------------------------------------------------------ embedded signaling
/**
 * The two generators a (16,7) code shortened from the length-17 quadratic residue code can have: (x + 1) times one of
 * the two degree-8 factors of x^17 + 1 over GF(2). The EMB is accepted as a code word of either.
 */
export const QR167_GENS = [0x34b, 0x279];
/** The nine check bits of seven EMB data bits under generator [g] (systematic, data first). */
export function qr167Parity(data7: number, g: number): number {
  let r = (data7 & 0x7f) << 9;
  for (let b = 15; b >= 9; b--) if (r & (1 << b)) r ^= g << (b - 9);
  return r & 0x1ff;
}
/**
 * The EMB of a voice burst B to F (ETSI TS 102 361-1): 8 bits before and 8 after the 32-bit embedded signaling in
 * the burst's 48-bit center: color code (4), privacy indicator (1), LC start/stop (2), then 9 check bits.
 */
export function readEmb(d: ArrayLike<number>): { cc: number; pi: boolean; lcss: number; ok: boolean } {
  let w = 0;
  for (let i = 66; i < 70; i++) w = (w << 2) | (d[i] & 3);
  for (let i = 86; i < 90; i++) w = (w << 2) | (d[i] & 3);
  const data = w >> 9, par = w & 0x1ff;
  return { cc: data >> 3, pi: ((data >> 2) & 1) === 1, lcss: data & 3, ok: QR167_GENS.some(g => qr167Parity(data, g) === par) || embParity(data) === par };
}
/**
 * The EMB check bits as our recordings carry them: the (x + 1)(x^8 + x^5 + x^4 + x^3 + 1) code's, with 0x138 added
 * when the LC start/stop field is 1 or 2 (first or last fragment). Derived from the Capacity Plus capture of
 * 2026-11-19, where every first and last fragment carries exactly that difference and the others none.
 */
export const embParity = (data7: number) => qr167Parity(data7, QR167_GENS[0]) ^ ((data7 & 3) === 1 || (data7 & 3) === 2 ? 0x138 : 0);
/** The 32 embedded signaling bits of a voice burst B to E (the center field between the two EMB halves). */
export function embBits(d: ArrayLike<number>): number[] { const b: number[] = []; for (let i = 70; i < 86; i++) b.push((d[i] >> 1) & 1, d[i] & 1); return b; }

/**
 * Embedded LC (ETSI TS 102 361-1 Annex B, variable-length BPTC): an LC sent in four 32-bit fragments over voice bursts
 * B to E (LC start/stop 1, 3, 3, 2). The 128 bits are a 16 by 8 matrix sent column by column; rows 0 to 6 carry the
 * data (11 bits in rows 0 and 1, 10 bits and one checksum bit in rows 2 to 6) and their Hamming check bits, and row 7
 * makes every column even. The 72 LC bits come out with a 5-bit checksum: the octet sum, plus 8 as our recordings
 * carry it, modulo 31.
 */
export class EmbLcAssembler {
  private frags: number[][] = [];
  /** One fragment; the 9 LC octets when a whole LC has come in and checked. */
  push(lcss: number, bits: number[]): Uint8Array | null {
    if (lcss === 1) this.frags = [bits];
    else if (lcss === 3) { if (this.frags.length >= 1 && this.frags.length <= 2) this.frags.push(bits); else this.frags = []; }
    else if (lcss === 2) {
      if (this.frags.length !== 3) { this.frags = []; return null; }
      const all = [...this.frags.flat(), ...bits]; this.frags = [];
      return embLcDecode(all);
    } else this.frags = [];
    return null;
  }
  reset(): void { this.frags = []; }
}
export function embLcDecode(all: number[]): Uint8Array | null {
  const M: number[][] = Array.from({ length: 8 }, () => new Array(16).fill(0));
  let i = 0; for (let c = 0; c < 16; c++) for (let r = 0; r < 8; r++) M[r][c] = all[i++];
  for (let c = 0; c < 16; c++) { let p = 0; for (let r = 0; r < 8; r++) p ^= M[r][c]; if (p) return null; }
  const bits: number[] = []; let cs = 0;
  for (let r = 0; r < 7; r++) { const n = r < 2 ? 11 : 10; for (let c = 0; c < n; c++) bits.push(M[r][c]); if (r >= 2) cs = cs * 2 + M[r][10]; }
  const out = new Uint8Array(9);
  for (let k = 0; k < 9; k++) { let v = 0; for (let j = 0; j < 8; j++) v = v * 2 + bits[8 * k + j]; out[k] = v; }
  const sum = out.reduce((a, x) => a + x, 0);
  return (sum + 8) % 31 === cs || sum % 31 === cs ? out : null;
}
/**
 * What an embedded LC says. A group (FLCO 0) or unit (3) voice LC as in the header, and under Motorola's feature set
 * (FID 0x10) FLCO 0x20, the group voice LC Capacity Plus sends, laid out the same: service options (bit 6 privacy,
 * bit 7 emergency), destination and source. Talker alias header and blocks: FLCO 4 to 7, or 0x14 to 0x17 under FID 0x10.
 */
export type EmbLc = { kind: 'voice'; lc: DmrLc } | { kind: 'alias'; part: number; bytes: Uint8Array } | null;
export function parseEmbLc(b: Uint8Array): EmbLc {
  const flco = b[0] & 0x3f, fid = b[1], so = b[2];
  const voice = (group: boolean): EmbLc => ({ kind: 'voice', lc: { flco, fid, group, dst: (b[3] << 16) | (b[4] << 8) | b[5], src: (b[6] << 16) | (b[7] << 8) | b[8], emergency: (so & 0x80) !== 0, privacy: (so & 0x40) !== 0, priority: so & 3, ok: true } });
  if (flco === 0 || (fid === 0x10 && flco === 0x20)) return voice(true);
  if (flco === 3) return voice(false);
  if ((fid === 0 && flco >= 4 && flco <= 7) || (fid === 0x10 && flco >= 0x14 && flco <= 0x17)) return { kind: 'alias', part: flco & 3, bytes: b.slice(2) };
  return null;
}
/**
 * Talker alias (ETSI TS 102 361-2, the alias header and up to three blocks): the header's first octet is the format
 * (2 bits: 7-bit, ISO 8-bit, UTF-8, UTF-16) and the length in characters (5 bits), then one bit and six octets of
 * text; each block carries seven octets. The name is complete once its length has come in.
 */
export class TalkerAlias {
  private fmt = -1; private len = 0; private data: (Uint8Array | null)[] = [null, null, null, null];
  /** A part (0 header, 1 to 3 blocks): the name so far, or '' while it is not known. */
  push(part: number, bytes: Uint8Array): string {
    if (part === 0) { this.fmt = bytes[0] >> 6; this.len = (bytes[0] >> 1) & 31; this.data = [bytes, null, null, null]; }
    else this.data[part] = bytes;
    return this.text();
  }
  text(): string {
    const h = this.data[0]; if (!h || this.fmt < 0) return '';
    const bits: number[] = [];
    for (let k = 0; k < 4; k++) { const d = this.data[k]; if (!d) break; const from = k === 0 ? 0 : 0; for (let i = from; i < d.length; i++) for (let j = 7; j >= 0; j--) bits.push((d[i] >> j) & 1); }
    // the header's first octet holds the format and length and the first data bit
    const s = bits.slice(7);
    let out = '';
    if (this.fmt === 0) { for (let i = 0; i + 7 <= s.length && out.length < this.len; i += 7) { let v = 0; for (let j = 0; j < 7; j++) v = v * 2 + s[i + j]; out += String.fromCharCode(v); } }
    else {
      // 8-bit and 16-bit text starts on the octet after the header's first: its last bit is padding
      const by: number[] = []; for (let i = 1; i + 8 <= s.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = v * 2 + s[i + j]; by.push(v); }
      if (this.fmt === 3) { for (let i = 0; i + 1 < by.length && out.length < this.len; i += 2) out += String.fromCharCode((by[i] << 8) | by[i + 1]); }
      else if (this.fmt === 2) { try { out = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(by)).slice(0, this.len); } catch { out = ''; } }
      else for (let i = 0; i < by.length && out.length < this.len; i++) out += String.fromCharCode(by[i]);
    }
    out = out.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return out.length >= Math.min(this.len, 1) && (out.length >= this.len || this.complete()) ? out : '';
  }
  private complete(): boolean { const need = this.fmt === 0 ? Math.ceil((this.len * 7 - 48) / 56) : Math.ceil((this.len * (this.fmt === 3 ? 16 : 8) - 48) / 56); for (let k = 1; k <= Math.max(0, need); k++) if (!this.data[k]) return false; return true; }
  reset(): void { this.fmt = -1; this.len = 0; this.data = [null, null, null, null]; }
}
/** A voice burst's center field carrying an EMB (for the synthetic signals in the tests). */
export function embDibits(cc: number, pi: boolean, lcss: number, g = QR167_GENS[0]): number[] {
  const data = ((cc & 15) << 3) | (pi ? 4 : 0) | (lcss & 3), w = (data << 9) | qr167Parity(data, g), out: number[] = [];
  for (let i = 7; i >= 0; i--) out.push((w >> (2 * i)) & 3);
  return out;
}
