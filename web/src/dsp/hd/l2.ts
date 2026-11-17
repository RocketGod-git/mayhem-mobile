/**
 * NRSC-5 Layer 2 and the transports above it:
 *  - the L2 PDU and its PCI codeword (SY_IDD_1014s, Tables 5-6 and 5-7);
 *  - audio transport PDUs, their locators, header expansions and PSD field (SY_IDD_1017s 5.2);
 *  - the fixed data bearer: streams, CCC and sync channel (SY_IDD_1019s 7.5, Figure 7-2);
 *  - HDLC framing with the RFC 1662 FCS-16 (SY_IDD_1019s 6.2, SY_IDD_1085s 5.1), AAS packets (Table 6-1);
 *  - ID3 v2.3 PSD tags (SY_IDD_1028s).
 * Settled on recordings: the descrambled L1 bits are reversed inside each 8-bit group to give the L2 bit numbering
 * (L2 bytes are formed least significant bit first from the L1 stream); block boundary markers (7D 3A E2 42) appear in
 * fixed streams even without FEC and are removed before HDLC un-escaping.
 */

/** Table 5-6: the eight L2 PCI codewords. */
export const PCI_CW = [0x38D8D3, 0xCE3634, 0xE3634C, 0x8D8D33, 0x3634CE, 0x8D338D, 0xD8D338, 0x634CE3];
export const PCI_CONTENT = ['audio', 'audio + opportunistic data', 'audio + fixed data', 'audio + fixed + opportunistic data', 'fixed data only', 'reserved', 'reserved', 'reserved'];
const BBM = [0x7D, 0x3A, 0xE2, 0x42];

/** Table 5-7: where the PCI bits are spread through an L2 PDU of L bits. */
export function headerSpread(L: number): { start: number; offset: number; len: number } {
  const m = L % 8, len = m === 0 ? 24 : m === 7 ? 23 : 22;
  if (L < 72_000) return { start: 120, offset: 8 * Math.floor(Math.ceil((L - 120) / 8) / len) - 1, len };
  return { start: 8 * Math.ceil((L - 30_000) / 8), offset: len === 24 ? 1247 : len === 23 ? 1303 : 1359, len };
}

/** Reverse the bit order inside every whole 8-bit group. */
export function l1ToL2(bits: Uint8Array): Uint8Array {
  const out = bits.slice(), n = bits.length - bits.length % 8;
  for (let i = 0; i < n; i += 8) for (let j = 0; j < 8; j++) out[i + j] = bits[i + 7 - j];
  return out;
}

export interface L2Pdu { pci: number; pciErrors: number; bytes: Uint8Array }
/** Descrambled P1 transfer frame bits to the PCI and payload bytes (packed most significant bit first). */
export function pduFromFrame(l1: Uint8Array): L2Pdu {
  const b = l1ToL2(l1), L = b.length, { start, offset, len } = headerSpread(L);
  let h = 0;
  const skip = new Set<number>();
  for (let i = 0; i < len; i++) { const p = start + i * (offset + 1); skip.add(p); h = (h << 1) | b[p]; }
  let pci = 0, err = 99;
  for (let k = 0; k < 8; k++) { let x = (h ^ (PCI_CW[k] >>> (24 - len))) >>> 0, d = 0; while (x) { d += x & 1; x >>>= 1; } if (d < err) { err = d; pci = k; } }
  const bytes = new Uint8Array(Math.floor((L - len) / 8));
  let o = 0, acc = 0, nb = 0;
  for (let i = 0; i < L && o < bytes.length; i++) {
    if (skip.has(i)) continue;
    acc = (acc << 1) | b[i];
    if (++nb === 8) { bytes[o++] = acc; acc = 0; nb = 0; }
  }
  return { pci, pciErrors: err, bytes };
}

/** The inverse of pduFromFrame (round-trip checks and the synthetic transmitter). */
export function frameFromPdu(bytes: Uint8Array, L: number, pci: number): Uint8Array {
  const { start, offset, len } = headerSpread(L);
  const b = new Uint8Array(L), pos = new Set<number>(), cw = PCI_CW[pci] >>> (24 - len);
  for (let i = 0; i < len; i++) { const p = start + i * (offset + 1); pos.add(p); b[p] = (cw >> (len - 1 - i)) & 1; }
  let q = 0;
  for (let i = 0; i < L; i++) { if (pos.has(i)) continue; const by = q >> 3; b[i] = by < bytes.length ? (bytes[by] >> (7 - (q & 7))) & 1 : 0; q++; }
  return l1ToL2(b);
}

export interface AudioPdu {
  off: number; end: number; codecMode: number; streamId: number; pduSeq: number; blend: number; latency: number;
  nop: number; la: number; locators: number[]; hdrExp: number[]; program: number; progType: number | null; access: number; psd: Uint8Array;
}
/** One audio transport PDU at byte `off` (1017s Figure 5-2, Table 5-1), or null. */
export function parseAudioPdu(by: Uint8Array, off: number): AudioPdu | null {
  if (off + 14 > by.length) return null;
  const h = by.subarray(off + 8, off + 14);                 // the eight RS parity bytes come first
  const codecMode = h[0] & 15, streamId = (h[0] >> 4) & 3, pduSeq = ((h[0] >> 6) & 3) | ((h[1] & 1) << 2);
  const blend = (h[1] >> 1) & 3, latency = ((h[2] >> 6) & 3) | ((h[3] & 1) << 2);
  const nop = (h[4] >> 1) & 0x3F; let hef = h[4] >> 7; const la = h[5];
  if (codecMode === 15 || nop === 0) return null;
  const lc16 = codecMode === 0 || (streamId === 1 && codecMode >= 1 && codecMode <= 3);
  let p = off + 14;
  const locators: number[] = [];
  if (lc16) {
    if (p + 2 * nop > by.length) return null;
    for (let i = 0; i < nop; i++) locators.push(by[p + 2 * i] | (by[p + 2 * i + 1] << 8));
    p += 2 * nop;
  } else {
    const nbytes = Math.ceil(nop * 12 / 8);
    if (p + nbytes + 1 > by.length) return null;
    for (let i = 0; i < nop; i++) {
      const j = (i >> 1) * 3;
      locators.push(i % 2 === 0 ? by[p + j] | ((by[p + j + 1] >> 4) << 8) : (by[p + j + 1] & 15) | (by[p + j + 2] << 4));
    }
    p += nbytes;
  }
  const hdrExp: number[] = [];
  while (hef && p < by.length) { hdrExp.push(by[p]); hef = by[p] >> 7; p++; }
  let program = 0, progType: number | null = null, access = 0;
  for (let i = 0; i < hdrExp.length; i++) {                  // 1017s 5.2.1.6
    const x = hdrExp[i], hid = (x >> 4) & 7;
    if (hid === 1) { program = (x >> 1) & 7; if (x & 1) i += 2; }
    else if (hid === 2 && i + 1 < hdrExp.length) { progType = ((x & 1) << 7) | (hdrExp[i + 1] & 0x7F); access = (x >> 3) & 1; i += 1; }
    else if (hid === 3) i += x & 8 ? 4 : 3;
    else if (hid === 4) i += x & 8 ? 3 : 1;
  }
  const psdEnd = off + la;
  const psd = psdEnd >= p ? by.slice(p, Math.min(by.length, psdEnd + 1)) : new Uint8Array(0);
  const end = locators.length ? off + locators[locators.length - 1] : -1;
  return { off, end, codecMode, streamId, pduSeq, blend, latency, nop, la, locators, hdrExp, program, progType, access, psd };
}

/** Consecutive audio PDUs from the start of the L2 PDU (MPS, then the SPS), stopping before `limit`. */
export function parseAudioRegion(by: Uint8Array, limit: number): { pdus: AudioPdu[]; end: number } {
  const pdus: AudioPdu[] = [];
  let off = 0;
  while (off < limit - 14) {
    const d = parseAudioPdu(by, off);
    if (!d || d.end < 0 || d.end >= limit || d.end <= off) break;
    pdus.push(d); off = d.end + 1;
  }
  return { pdus, end: off };
}

/** RFC 1662 FCS-16 (1019s 6.2.4). A frame with its FCS appended leaves 0xF0B8. */
export function fcs16(data: ArrayLike<number>, from = 0, to = data.length, init = 0xFFFF): number {
  let f = init;
  for (let i = from; i < to; i++) { f ^= data[i]; for (let k = 0; k < 8; k++) f = f & 1 ? (f >>> 1) ^ 0x8408 : f >>> 1; }
  return f;
}

/** HDLC frame a payload: flag, escaped body with its FCS, flag. */
export function hdlcWrap(body: ArrayLike<number>): Uint8Array {
  const f = fcs16(body) ^ 0xFFFF, all = [...Array.from(body), f & 255, f >> 8], out = [0x7E];
  for (const x of all) { if (x === 0x7E || x === 0x7D) out.push(0x7D, x ^ 0x20); else out.push(x); }
  out.push(0x7E);
  return Uint8Array.from(out);
}

export interface CccSub { parity: number; interleave: number; length: number }
export interface Ccc { mpl: number; subs: CccSub[]; raw: string }
/** A complete CCC message (1019s Table 7-3) in a region: 7E MPL (mode, length) x n FCS. */
export function parseCcc(region: Uint8Array): Ccc | null {
  for (let st = 0; st < region.length; st++) {
    if (region[st] !== 0x7E) continue;
    let j = st + 1; while (j < region.length && region[j] === 0x7E) j++;
    for (let n = 1; n <= 4; n++) {
      const raw: number[] = []; let esc = false;
      for (let k = j; k < region.length && raw.length < 1 + 4 * n + 2; k++) {
        const x = region[k];
        if (esc) { raw.push(x ^ 0x20); esc = false; } else if (x === 0x7D) esc = true; else raw.push(x);
      }
      if (raw.length < 1 + 4 * n + 2) break;
      const fcs = raw[1 + 4 * n] | (raw[2 + 4 * n] << 8);
      if ((fcs16(raw, 0, 1 + 4 * n) ^ 0xFFFF) === fcs) {
        const subs: CccSub[] = [];
        for (let s = 0; s < n; s++) subs.push({ parity: raw[1 + 4 * s], interleave: raw[2 + 4 * s], length: raw[3 + 4 * s] | (raw[4 + 4 * s] << 8) });
        return { mpl: raw[0], subs, raw: raw.slice(0, 1 + 4 * n).map(x => x.toString(16).padStart(2, '0')).join('') };
      }
    }
  }
  return null;
}

/** Keeps the fixed bearer's configuration across PDUs and cuts each PDU's fixed sub-channel segments. */
export class FixedTracker {
  ccc: Ccc | null = null;
  private width = -1;
  split(by: Uint8Array, audioEnd: number): { segs: Uint8Array[]; start: number } {
    const sync = by[by.length - 1];
    let width = -1;
    if ((sync >> 4) === (sync & 15)) { const n = sync & 15; width = n === 0 ? 1 : 2 * n; }
    const msg = parseCcc(by.subarray(Math.max(0, by.length - 32), by.length - 1));
    if (msg) this.ccc = msg;
    if (!this.ccc) return { segs: [], start: by.length };
    const total = this.ccc.subs.reduce((a, s) => a + s.length, 0);
    if (width < 0) width = this.width >= 0 ? this.width : by.length - 1 - total - audioEnd;
    this.width = width;
    const start = by.length - 1 - width - total;
    if (start < 0) return { segs: [], start: by.length };
    const segs: Uint8Array[] = [];
    let p = start;
    for (const s of this.ccc.subs) { segs.push(by.slice(p, p + s.length)); p += s.length; }
    return { segs, start };
  }
  /** Where the fixed bearer starts in a PDU of `len` bytes, once known. */
  fixedStart(len: number): number {
    if (!this.ccc || this.width < 0) return len;
    return len - 1 - this.width - this.ccc.subs.reduce((a, s) => a + s.length, 0);
  }
}

/** A byte stream cut into HDLC frames: flags, block boundary markers, escapes, FCS. */
export class HdlcStream {
  private buf: number[] = [];
  bbm = 0; good = 0; bad = 0;
  constructor(private readonly stripBbm: boolean) {}
  clear(): void { this.buf = []; }
  feed(data: ArrayLike<number>): { ok: boolean; frame: Uint8Array }[] {
    for (let i = 0; i < data.length; i++) this.buf.push(data[i]);
    const out: { ok: boolean; frame: Uint8Array }[] = [];
    for (;;) {
      const i = this.buf.indexOf(0x7E);
      if (i < 0) { if (this.buf.length > 70_000) this.buf.splice(0, this.buf.length - 70_000); break; }
      const j = this.buf.indexOf(0x7E, i + 1);
      if (j < 0) { if (i > 0) this.buf.splice(0, i); break; }
      let fr = this.buf.slice(i + 1, j);
      this.buf.splice(0, j);
      if (!fr.length) continue;
      if (this.stripBbm) {
        const kept: number[] = [];
        for (let k = 0; k < fr.length; k++) {
          if (fr[k] === BBM[0] && fr[k + 1] === BBM[1] && fr[k + 2] === BBM[2] && fr[k + 3] === BBM[3]) { this.bbm++; k += 3; continue; }
          kept.push(fr[k]);
        }
        if (!kept.length) continue;
        fr = kept;
      }
      const u: number[] = []; let esc = false;
      for (const x of fr) { if (esc) { u.push(x ^ 0x20); esc = false; } else if (x === 0x7D) esc = true; else u.push(x); }
      const ok = u.length >= 3 && fcs16(u) === 0xF0B8;
      if (ok) this.good++; else this.bad++;
      out.push({ ok, frame: Uint8Array.from(u) });
    }
    return out;
  }
}

export interface Packet { dtpf: number; port: number; seq: number; payload: Uint8Array }
/** An un-escaped HDLC frame (with its FCS) as an AAS or PSD packet (1019s Table 6-1, 1085s Table 5-2). */
export function parsePacket(u: Uint8Array): Packet | null {
  if (u.length < 3) return null;
  const dtpf = u[0];
  let body = u.subarray(1, u.length - 2);
  if (dtpf === 0x26 && body.length >= 2) body = body.subarray(2 + body[0]);
  if (body.length < 4) return null;
  return { dtpf, port: body[0] | (body[1] << 8), seq: body[2] | (body[3] << 8), payload: body.slice(4) };
}

export interface Id3Frame { id: string; text?: string; desc?: string; lang?: string; bytes: Uint8Array }
const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };
function utf16(b: Uint8Array): string {
  let le = true, i = 0;
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) { le = false; i = 2; } else if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) i = 2;
  let s = '';
  for (; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  return s;
}
const decodeText = (enc: number, b: Uint8Array) => (enc === 1 || enc === 2 ? utf16(b) : enc === 3 ? new TextDecoder().decode(b) : latin1(b)).replace(/\0+$/, '');
/** ID3 v2.3 tag frames (the PSD subset of 1028s); null when it is not a tag. */
export function parseId3(p: Uint8Array): Id3Frame[] | null {
  if (p.length < 10 || p[0] !== 0x49 || p[1] !== 0x44 || p[2] !== 0x33) return null;
  const size = (p[6] << 21) | (p[7] << 14) | (p[8] << 7) | p[9], end = Math.min(p.length, 10 + size);
  const out: Id3Frame[] = [];
  let q = 10;
  while (q + 10 <= end) {
    if (p[q] === 0) break;
    const id = latin1(p.subarray(q, q + 4)), fsz = ((p[q + 4] << 24) | (p[q + 5] << 16) | (p[q + 6] << 8) | p[q + 7]) >>> 0;
    const body = p.slice(q + 10, Math.min(end, q + 10 + fsz));
    q += 10 + fsz;
    const f: Id3Frame = { id, bytes: body };
    if (id[0] === 'T' && body.length) f.text = decodeText(body[0], body.subarray(1));
    else if (id === 'COMM' && body.length >= 4) {
      f.lang = latin1(body.subarray(1, 4));
      const rest = body.subarray(4), z = rest.indexOf(0);
      f.desc = decodeText(body[0], z >= 0 ? rest.subarray(0, z) : rest);
      f.text = z >= 0 ? decodeText(body[0], rest.subarray(z + 1)) : '';
    }
    out.push(f);
  }
  return out;
}
/** Build an ID3 v2.3 tag of text frames (tests and the demo). */
export function buildId3(frames: [string, Uint8Array | string][]): Uint8Array {
  const parts: number[] = [];
  for (const [id, v] of frames) {
    const body = typeof v === 'string' ? [0, ...Array.from(v, c => c.charCodeAt(0) & 255)] : Array.from(v);
    parts.push(...Array.from(id, c => c.charCodeAt(0)), (body.length >>> 24) & 255, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, 0, 0, ...body);
  }
  const n = parts.length;
  return Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127, ...parts]);
}
