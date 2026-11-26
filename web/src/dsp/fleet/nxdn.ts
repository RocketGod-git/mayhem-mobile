/**
 * NXDN, receive only (NXDN TS 1-A Common Air Interface v1.3, TS 1-E Common Air Interface Type-D v1.1). No DOM.
 *
 *  - 4-level FSK, dibit 01 = +3, 00 = +1, 10 = -1, 11 = -3 (1-A 4.5.3, Figure 4.5-7); NXDN48 at 2400 and NXDN96 at 4800
 *    symbols a second, the frame 384 bits either way (4.4). One frame sync word for every channel: CDF59,
 *    -3 +1 -3 +3 -3 -3 +3 +3 -1 +3 (4.4.4, Table 4.4-2; 1-E 4.4.5).
 *  - Scrambling (4.6): every symbol after the FSW, up to the post field, has its sign inverted where the 9-bit generator
 *    X^9 + X^4 + 1 puts out a 1; register S8..S0 = 0 1 1 1 0 0 1 0 0 at the start of each frame, output S0, S0 fed back to
 *    S8 and added into S3 (Figure 4.6-1; Figure 4.6-2: S0 to S181, the LICH to the end of the frame).
 *  - LICH (4.5.3, 5.2): 7 bits and an even parity bit over the 4 most significant, one bit a symbol (0 = +3, 1 = -3).
 *    RF channel type (bits 6-5): 00 RCCH, 01 RTCH, 10 RDCH (conventional), 11 RTCH_C, or RTCH2 on Type-D (1-E 5.2.1).
 *    Then the functional channel (bits 4-3), the option (bits 2-1) and the direction (bit 0, 1 outbound) (Table 5.2-1).
 *  - Outbound RCCH (4.4.1): FSW 20, LICH 16, CAC 300, E 24, Post 24. CAC (4.5.1.1): SR 8, layer 3 144, null 3, CRC 16,
 *    tail 4; the K = 5 rate 1/2 code G1 = 1 + D^3 + D^4, G2 = 1 + D + D^2 + D^4, punctured by 1111111 / 1011101 to 300
 *    bits; a 25 by 12 interleaver written by rows and read by columns (4.5.4).
 *  - RTCH and RDCH voice (4.4.2): FSW 20, LICH 16, SACCH 60, then four 72-bit VCHs, or a 144-bit FACCH1 in place of
 *    either pair (the steal flags of Table 5.2-1). 9600 bps EFR carries two 144-bit VCHs instead (Figure 4.6-2).
 *  - SACCH (4.5.2.1): SR 8 and 18 layer 3 bits, a 6-bit CRC (X^6 + X^5 + X^2 + X + 1), 4 tail bits, punctured by
 *    111111 / 110110 to 60 bits, a 5 by 12 interleaver. A layer 3 message rides in four of them, the superframe, each
 *    SR's structure field saying which quarter it is (6.3.3, Table 6.3-2).
 *  - FACCH1 (4.5.2.2): 80 bits, a 12-bit CRC (X^12 + X^11 + X^3 + X^2 + X + 1), 4 tail bits, punctured by 11 / 01 to 144,
 *    a 9 by 16 interleaver. Every CRC starts from a register of ones (4.5.5, Figure 4.5-13).
 *  - Type-D (1-E): the same frame, but the 60 bits after the LICH are the SCCH: 25 bits and a 7-bit CRC (X^7 + X^3 + 1),
 *    coded like the SACCH (4.5.1.1). Its structure field names one of four messages, INFO1 to INFO4 (6.3, 6.5).
 *  - VCH: the AMBE+2 vocoder's own frame, 72 bits at EHR (49 voice bits) or 144 at EFR (88), sent in order (7.1).
 *  - Layer 3 (6.2 to 6.5): octet 0 is two flags and the 6-bit message type. A CAC carries one message (single format) or
 *    two of 9 octets each (dual), as its SR's structure bit 0 says (Table 6.3-1).
 */
import { SymbolRx } from './rx.js';
import { NxdnDataReader, nxdnUdch } from './nxdndata.js';
import type { UnitData } from './unitdata.js';

const FSW = [-3, 1, -3, 3, -3, -3, 3, 3, -1, 3];
/** Symbols in a frame after the FSW (the LICH to the end of the post field or of the last VCH), and in a whole frame. */
const BODY = 182, FRAME = 192;
/** The scrambler's output for the symbols after the FSW of a frame (4.6). */
export function nxdnScrambler(n: number): Uint8Array {
  let s = [0, 1, 1, 1, 0, 0, 1, 0, 0].reverse();   // s[i] = Si
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const o = s[0]; out[k] = o;
    const next = new Array(9); for (let i = 0; i < 8; i++) next[i] = s[i + 1]; next[8] = o; next[3] = s[4] ^ o;
    s = next;
  }
  return out;
}
const SCR = nxdnScrambler(BODY);
/** A CRC of 4.5.5 (Figure 4.5-13) over the first [n] bits: register preset to ones, [poly] without its top term. */
export function nxdnCrc(bits: ArrayLike<number>, n: number, width: number, poly: number): number {
  const mask = (1 << width) - 1; let r = mask;
  for (let i = 0; i < n; i++) { const fb = ((r >> (width - 1)) & 1) ^ bits[i]; r = (r << 1) & mask; if (fb) r ^= poly; }
  return r;
}
/** The 16-bit CRC of the CAC (X^16 + X^12 + X^5 + 1). */
export const nxdnCrc16 = (bits: ArrayLike<number>, n: number) => nxdnCrc(bits, n, 16, 0x1021);
/** X^6 + X^5 + X^2 + X + 1 (SACCH), X^12 + X^11 + X^3 + X^2 + X + 1 (FACCH1), X^7 + X^3 + 1 (Type-D SCCH). */
export const nxdnCrc6 = (bits: ArrayLike<number>, n: number) => nxdnCrc(bits, n, 6, 0x27);
export const nxdnCrc12 = (bits: ArrayLike<number>, n: number) => nxdnCrc(bits, n, 12, 0x80f);
export const nxdnCrc7 = (bits: ArrayLike<number>, n: number) => nxdnCrc(bits, n, 7, 0x09);
const field = (b: ArrayLike<number>, at: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 2 + b[at + k]; return v; };

const G1 = 0b11001, G2 = 0b10111;   // bit j = D^j
/** The two code bits (G1 then G2) for each 5-bit encoder register (bit 0 the newest input). */
const ENC = (() => { const t = new Uint8Array(32); for (let reg = 0; reg < 32; reg++) { let a = 0, b = 0; for (let k = 0; k < 5; k++) { if (G1 & (1 << k)) a ^= (reg >> k) & 1; if (G2 & (1 << k)) b ^= (reg >> k) & 1; } t[reg] = (a << 1) | b; } return t; })();
/**
 * Decodes one coded channel: [soft] is what was received in transmit order, each value positive for a 0 and negative
 * for a 1 (its size the confidence). Undone in turn: the interleaver ([rows] by [cols], written by rows and read by
 * columns), the puncturing ([keep] per period of code bits, 0 where a bit was not sent) and the code (Viterbi, 16 states,
 * [n] bits ending in the zero state).
 */
export function nxdnDecodeChannel(soft: ArrayLike<number>, rows: number, cols: number, keep: readonly number[], n: number): Uint8Array {
  const y = new Float32Array(rows * cols);
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) y[r * cols + c] = soft[c * rows + r];
  const m = new Float32Array(2 * n); let j = 0;
  for (let i = 0; i < 2 * n; i++) m[i] = keep[i % keep.length] ? y[j++] : 0;
  const S = 16, INF = 1e9; let pm = new Float64Array(S).fill(INF); pm[0] = 0;
  const prev = new Uint8Array(n * S), bit = new Uint8Array(n * S);
  for (let k = 0; k < n; k++) {
    const np = new Float64Array(S).fill(INF), a = m[2 * k], b = m[2 * k + 1];
    for (let st = 0; st < S; st++) {
      if (pm[st] >= INF) continue;
      for (let u = 0; u < 2; u++) {
        const reg = (st << 1) | u, o = ENC[reg], ns = reg & 15;
        const c = pm[st] - ((o & 2) ? -a : a) - ((o & 1) ? -b : b);
        if (c < np[ns]) { np[ns] = c; prev[k * S + ns] = st; bit[k * S + ns] = u; }
      }
    }
    pm = np;
  }
  const d = new Uint8Array(n); let st = 0;
  for (let k = n - 1; k >= 0; k--) { d[k] = bit[k * S + st]; st = prev[k * S + st]; }
  return d;
}
const CAC_KEEP = [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1], SACCH_KEEP = [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0], FACCH1_KEEP = [1, 0, 1, 1];
const hardSoft = (rx: ArrayLike<number>) => Float32Array.from({ length: rx.length }, (_, i) => rx[i] ? -1 : 1);
/** CAC: 300 received bits, or soft values (after descrambling), to the 152 bits of SR and layer 3; null when the CRC fails. */
export function nxdnCac(rx: ArrayLike<number>, soft = false): Uint8Array | null {
  const d = nxdnDecodeChannel(soft ? rx : hardSoft(rx), 25, 12, CAC_KEEP, 175);
  return nxdnCrc16(d, 155) === field(d, 155, 16) ? d.slice(0, 152) : null;
}
/**
 * SACCH, or the Type-D SCCH coded the same way: 60 bits to the 36 decoded. [sacch] is the 26 bits of SR and layer 3
 * when the 6-bit CRC holds, [scch] the 25 bits of a Type-D SCCH when its 7-bit CRC holds.
 */
export function nxdnSacch(rx: ArrayLike<number>, soft = false): { sacch: Uint8Array | null; scch: Uint8Array | null } {
  const d = nxdnDecodeChannel(soft ? rx : hardSoft(rx), 5, 12, SACCH_KEEP, 36);
  return { sacch: nxdnCrc6(d, 26) === field(d, 26, 6) ? d.slice(0, 26) : null, scch: nxdnCrc7(d, 25) === field(d, 25, 7) ? d.slice(0, 25) : null };
}
/** FACCH1: 144 bits to the 80 of layer 3, or null when the CRC fails. */
export function nxdnFacch1(rx: ArrayLike<number>, soft = false): Uint8Array | null {
  const d = nxdnDecodeChannel(soft ? rx : hardSoft(rx), 9, 16, FACCH1_KEEP, 96);
  return nxdnCrc12(d, 80) === field(d, 80, 12) ? d.slice(0, 80) : null;
}

// ---------------------------------------------------------------------------------------------------------- layer 3
export interface NxdnSite { category: number; system: number; site: number; cc1: number; cc2: number; version: number; adjacent: number; locationId: number; service?: number }
export const NXDN_CATEGORY = ['GLOBAL', 'LOCAL', 'REGIONAL', 'RESERVED'];
/** A Location ID (6.5.2): category (00 global, 10 regional, 01 local), system code and site code. */
export function nxdnLocation(loc: number): { category: number; system: number; site: number } | null {
  const category = loc >>> 22, sysBits = category === 0 ? 10 : category === 2 ? 14 : category === 1 ? 17 : 0;
  if (!sysBits) return null;
  const siteBits = 22 - sysBits;
  return { category, system: (loc >>> siteBits) & ((1 << sysBits) - 1), site: loc & ((1 << siteBits) - 1) };
}
/** SITE_INFO (6.4.3.1, Figure 6.4-53) from the layer 3 bits (after SR): Location ID (6.5.2) and the control channels. */
export function nxdnSiteInfo(l3: ArrayLike<number>): NxdnSite | null {
  if (field(l3, 2, 6) !== 0x18) return null;
  const loc = field(l3, 8, 24), id = nxdnLocation(loc); if (!id) return null;
  return { ...id, cc1: field(l3, 8 * 15 + 4, 10), cc2: field(l3, 8 * 16 + 6, 10), version: field(l3, 8 * 14, 8), adjacent: field(l3, 8 * 15, 4), locationId: loc, service: field(l3, 8 * 7, 16) };
}
/** Call types (6.5.12). */
export const NXDN_CALL_TYPES = ['BROADCAST', 'CONFERENCE', 'UNSPECIFIED', 'RESERVED', 'INDIVIDUAL', 'RESERVED', 'INTERCONNECT', 'SPEED DIAL'];
/** Cipher types (6.5.27). */
export const NXDN_CIPHERS = ['CLEAR', 'SCRAMBLE', 'DES', 'AES'];
/** Message names, on an outbound control channel and on a traffic channel (6.4, Tables 6.4-1 to 6.4-10). */
const CC_NAMES: Record<number, string> = {
  0x01: 'VCALL_RESP', 0x02: 'VCALL_REC_REQ', 0x03: 'VCALL_CONN_RESP', 0x04: 'VCALL_ASSGN', 0x05: 'VCALL_ASSGN_DUP', 0x09: 'DCALL_RESP',
  0x0a: 'DCALL_REC_REQ', 0x0d: 'DCALL_ASSGN_DUP', 0x0e: 'DCALL_ASSGN', 0x10: 'IDLE', 0x11: 'DISC', 0x18: 'SITE_INFO', 0x19: 'SRV_INFO',
  0x1a: 'CCH_INFO', 0x1b: 'ADJ_SITE_INFO', 0x1c: 'FAIL_STAT_INFO', 0x20: 'REG_RESP', 0x22: 'REG_C_RESP', 0x23: 'REG_COMM', 0x24: 'GRP_REG_RESP',
  0x28: 'AUTH_INQ_REQ', 0x30: 'STAT_INQ_REQ', 0x31: 'STAT_INQ_RESP', 0x32: 'STAT_REQ', 0x33: 'STAT_RESP', 0x34: 'REM_CON_REQ', 0x35: 'REM_CON_RESP',
  0x38: 'SDCALL_REQ', 0x39: 'SDCALL_RESP',
};
const TC_NAMES: Record<number, string> = {
  0x01: 'VCALL', 0x02: 'VCALL_REC_REQ', 0x03: 'VCALL_IV', 0x04: 'VCALL_ASSGN', 0x05: 'VCALL_ASSGN_DUP', 0x07: 'TX_REL_EX', 0x08: 'TX_REL',
  0x09: 'DCALL_HDR', 0x0b: 'DCALL_UDT', 0x0c: 'DCALL_ACK', 0x0f: 'HEAD_DLY', 0x10: 'IDLE', 0x11: 'DISC', 0x19: 'SRV_INFO', 0x1a: 'CCH_INFO', 0x1b: 'ADJ_SITE_INFO',
  0x1c: 'FAIL_STAT_INFO', 0x28: 'AUTH_INQ_REQ', 0x30: 'STAT_INQ_REQ', 0x31: 'STAT_INQ_RESP', 0x32: 'STAT_REQ', 0x33: 'STAT_RESP', 0x34: 'REM_CON_REQ',
  0x35: 'REM_CON_RESP', 0x38: 'SDCALL_REQ', 0x39: 'SDCALL_RESP', 0x3a: 'SDCALL_IV', 0x3f: 'PROP_FORM',
};
export interface NxdnAdj { category: number; system: number; site: number; num: number; ch: number }
export interface NxdnMsg {
  type: number; name: string; hex: string;
  /** Call control (VCALL, VCALL_ASSGN, TX_REL, DISC, ...): call type, group or unit, IDs, emergency, voice call option. */
  callType?: number; group?: boolean; src?: number; dst?: number; emergency?: boolean; voiceOpt?: number;
  /** VCALL: cipher type (0 clear, 1 scramble, 2 DES, 3 AES) and key ID. */
  cipher?: number; keyId?: number;
  /** A channel number (VCALL_ASSGN, DCALL_ASSGN) and the call timer in seconds (0 unspecified). */
  ch?: number; timer?: number;
  site?: NxdnSite; adj?: NxdnAdj[];
  /** CCH_INFO: the Location ID, the flags (8 current, 4 new, 2 added, 1 deleted) and the two channels. */
  cch?: { site: number; system: number; category: number; flags: number; ch1: number; ch2: number };
  /** Mobility management (REG_RESP, GRP_REG_RESP, REG_COMM): the unit, its group and the cause. */
  unit?: number; gid?: number; cause?: number;
  /** SRV_INFO service flags (6.5.33). */
  service?: number;
  /** STAT_REQ and STAT_RESP: the status (nxdndata.ts). */
  status?: number;
  /** Type-D IDs carry a 5-bit home repeater or prefix ahead of an 11-bit ID (1-E 6.6.6, 6.6.7). */
  typeD?: boolean;
}
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));
const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
/** Call Timer (6.5.32): 15 s steps to 180 s, then 30 s steps to 600 s. */
const callTimer = (v: number) => v === 0 ? 0 : v <= 12 ? 15 * v : v <= 0x1a ? 180 + 30 * (v - 12) : -1;
const CALLISH_TC = [0x01, 0x02, 0x04, 0x05, 0x07, 0x08, 0x09, 0x11, 0x32, 0x33, 0x38], CALLISH_CC = [0x01, 0x02, 0x03, 0x04, 0x05, 0x0d, 0x0e, 0x11];
/**
 * One layer 3 message from its octets. [on] says where it came from: a control channel ('cc') or a traffic channel
 * ('tc'), whose message types overlap. [typeD]: a Type-D FACCH1, whose IDs carry a prefix.
 */
export function nxdnParse(o: Uint8Array, on: 'cc' | 'tc', typeD = false): NxdnMsg {
  const type = o[0] & 0x3f, name = (on === 'cc' ? CC_NAMES : TC_NAMES)[type] ?? `TYPE ${type.toString(16).toUpperCase().padStart(2, '0')}`;
  const m: NxdnMsg = { type, name, hex: hexOf(o) };
  const u16 = (i: number) => (o[i] << 8) | o[i + 1], loc = (i: number) => (o[i] << 16) | (o[i + 1] << 8) | o[i + 2];
  // CC Option (6.5.11), Call Type (6.5.12), Voice Call Option (6.5.13), Source and Destination (Figure 6.4-1)
  if ((on === 'tc' ? CALLISH_TC : CALLISH_CC).includes(type)) {
    m.emergency = (o[1] & 0x80) !== 0; m.callType = o[2] >> 5; m.group = m.callType < 2; m.voiceOpt = o[2] & 0x1f; m.src = u16(3); m.dst = u16(5);
    if (typeD) m.typeD = true;
  }
  if (on === 'tc' && (type === 0x01 || type === 0x09 || type === 0x38)) { m.cipher = o[7] >> 6; m.keyId = o[7] & 0x3f; }
  if (on === 'tc' && (type === 0x32 || type === 0x33)) m.status = o[7];
  // the assignments: Call Timer (6 bits) then the Channel (10 bits) in octets 7 and 8 (Figure 6.4-31)
  if (!typeD && (type === 0x04 || type === 0x05 || (on === 'cc' && (type === 0x0d || type === 0x0e)))) { m.timer = callTimer(o[7] >> 2); m.ch = ((o[7] & 3) << 8) | o[8]; }
  if (type === 0x18 && on === 'cc') {
    const id = nxdnLocation(loc(1));
    if (id) m.site = { ...id, locationId: loc(1), service: u16(7), version: o[14], adjacent: o[15] >> 4, cc1: ((o[15] & 0xf) << 6) | (o[16] >> 2), cc2: ((o[16] & 3) << 8) | o[17] };
  }
  if (type === 0x19) m.service = u16(4);
  // CCH_INFO (Figure 6.4-55): Location ID, Curr New Add Del, Control Channel 1 and 2
  if (type === 0x1a) { const id = nxdnLocation(loc(1)); if (id) m.cch = { ...id, flags: o[4] >> 4, ch1: ((o[4] & 3) << 8) | o[5], ch2: ((o[6] & 3) << 8) | o[7] }; }
  // ADJ_SITE_INFO (Figure 6.4-56): five octets a site, Location ID, Adjacent Site Option (6 bits) and its channel
  if (type === 0x1b) {
    m.adj = [];
    for (let i = 1; i + 4 < o.length; i += 5) {
      const l = loc(i), id = nxdnLocation(l), ch = ((o[i + 3] & 3) << 8) | o[i + 4];
      if (l && id && ch) m.adj.push({ ...id, num: (o[i + 3] >> 2) & 0xf, ch });
    }
  }
  // REG_RESP and REG_C_RESP (Figure 6.4-45): the Location ID in octets 1 to 3, the unit, its group, the cause
  if (on === 'cc' && (type === 0x20 || type === 0x22)) { m.unit = u16(4); m.gid = u16(6); m.cause = o[8]; }
  if (on === 'cc' && type === 0x23) m.unit = u16(4);
  if (on === 'cc' && type === 0x24) { m.unit = u16(2); m.gid = u16(4); m.cause = o[6]; }
  return m;
}
/** An ID as shown: Type-D's prefix and ID (1-E 6.6.6), else the 16-bit value. */
export const nxdnId = (v: number, typeD = false) => typeD ? `${v >> 11}-${v & 0x7ff}` : `${v}`;
/** One message in words, for the log. */
export function nxdnLine(m: NxdnMsg): string {
  const id = (v: number) => nxdnId(v, m.typeD);
  const parts = [m.name];
  if (m.site) parts.push(`${NXDN_CATEGORY[m.site.category]} SYSTEM ${m.site.system}`, `SITE ${m.site.site}`, `control channel ${m.site.cc1}${m.site.cc2 ? ` and ${m.site.cc2}` : ''}`, `${m.site.adjacent} adjacent sites`, `version ${m.site.version}`);
  if (m.src !== undefined && m.dst !== undefined) parts.push(`${m.callType !== undefined ? NXDN_CALL_TYPES[m.callType] : ''} ${m.group ? 'TG' : 'UNIT'} ${id(m.dst)} ← ${id(m.src)}`.trim());
  if (m.ch) parts.push(`channel ${m.ch}`);
  if (m.timer) parts.push(`timer ${m.timer} s`);
  if (m.voiceOpt !== undefined && (m.type === 0x01 || m.type === 0x04 || m.type === 0x05)) parts.push(['4800 EHR', '', '9600 EHR', '9600 EFR'][m.voiceOpt & 7] || `mode ${m.voiceOpt & 7}`);
  if (m.cipher !== undefined) parts.push(m.cipher ? `${NXDN_CIPHERS[m.cipher]} · KEY ${m.keyId}` : 'CLEAR');
  if (m.emergency) parts.push('EMERGENCY');
  if (m.status !== undefined) parts.push(`STATUS ${m.status}`);
  if (m.cch) parts.push(`${NXDN_CATEGORY[m.cch.category]} SYSTEM ${m.cch.system} · SITE ${m.cch.site}`, `${({ 8: 'current', 4: 'new', 2: 'added', 1: 'deleted' } as Record<number, string>)[m.cch.flags] ?? ''} channel ${m.cch.ch1}${m.cch.ch2 && m.cch.flags === 8 ? ` and ${m.cch.ch2}` : ''}`.trim());
  if (m.adj) for (const a of m.adj) parts.push(`site ${a.site} of ${NXDN_CATEGORY[a.category]} ${a.system} on channel ${a.ch}`);
  if (m.unit !== undefined) parts.push(`UNIT ${m.unit}${m.gid && m.gid !== 0xffff ? ` · TG ${m.gid}` : ''}${m.cause !== undefined ? ` · ${m.cause === 1 ? 'accepted' : `cause ${m.cause.toString(16).toUpperCase().padStart(2, '0')}`}` : ''}`);
  if (m.service !== undefined && !m.site) parts.push(`services ${m.service.toString(16).toUpperCase().padStart(4, '0')}`);
  return parts.join(' · ');
}
const bytesOf = (bits: ArrayLike<number>, at: number, n: number) => Uint8Array.from({ length: n }, (_, i) => field(bits, at + 8 * i, 8));
/** The messages of a CAC (SR first): one in the single format, two of 9 octets in the dual (Table 6.3-1, Figure 6.2-2). */
export function nxdnCacMessages(cac: ArrayLike<number>): NxdnMsg[] {
  const dual = (field(cac, 0, 8) & 0x40) !== 0;
  if (!dual) return [nxdnParse(bytesOf(cac, 8, 18), 'cc')];
  return [nxdnParse(bytesOf(cac, 8, 9), 'cc'), nxdnParse(bytesOf(cac, 80, 9), 'cc')];
}

/** Type-D SCCH outbound messages (1-E 6.5.3), INFO1 to INFO4, from their 25 bits. */
export interface NxdnScch {
  info: 1 | 2 | 3 | 4; area: number;
  /** INFO4 and INFO2 (Figure 6.5-4): the repeater the destination is on (31 ends a transmission), the destination
   *  (prefix and ID) and whether it is a group. Special IDs (Figures 6.5-5 to 6.5-8): idle, halt, free repeaters, site. */
  kind?: 'busy' | 'idle' | 'halt' | 'free' | 'site'; goTo?: number; dst?: number; group?: boolean;
  rep1?: number; rep2?: number; siteType?: number; siteCode?: number;
  /** INFO3 (Figure 6.5-9): the source (prefix and ID). INFO1 (Figure 6.5-10): call option, cipher type and key ID. */
  src?: number; callOpt?: number; cipher?: number; keyId?: number;
}
export function nxdnScch(b: ArrayLike<number>): NxdnScch {
  const info = (4 - field(b, 0, 2)) as 1 | 2 | 3 | 4, area = b[2], x = field(b, 3, 5), y = field(b, 8, 5), id = field(b, 13, 11);
  const s: NxdnScch = { info, area };
  if (info === 4 || info === 2) {
    if (id === 2046) Object.assign(s, { kind: 'idle', rep1: x, rep2: y });
    else if (id === 2045) Object.assign(s, { kind: 'halt', rep1: x, rep2: y });
    else if (id === 2044) Object.assign(s, { kind: 'free', rep1: x, rep2: y });
    else if (id === 2041) Object.assign(s, { kind: 'site', siteType: x >> 3, siteCode: ((x & 7) << 5) | y });
    else Object.assign(s, { kind: 'busy', goTo: x, dst: (y << 11) | id, group: b[24] === 0 });
  } else if (info === 3) { s.rep1 = x; s.src = (y << 11) | id; }
  else { s.rep1 = x; s.rep2 = y; s.callOpt = field(b, 13, 3); s.cipher = field(b, 16, 2); s.keyId = field(b, 18, 6); }
  return s;
}

// ---------------------------------------------------------------------------------------------------------- framer
/** What one traffic or conventional channel frame carried. */
export interface NxdnTraffic {
  /** LICH fields: RF channel type, functional channel, option, direction. */
  rf: number; fn: number; opt: number; dir: number;
  /** The SACCH's radio access number (-1 when it did not come through), and whether this is a Type-D frame (an SCCH). */
  ran: number; typeD: boolean;
  /** The two halves of the VCH area (144 bits each, as sent), null where a FACCH1 took the half or none was sent. */
  halves: (Uint8Array | null)[];
  /** Messages read this frame: a SACCH superframe completed, a FACCH1 that passed its CRC. */
  msgs: NxdnMsg[];
  /** A Type-D SCCH message. */
  scch: NxdnScch | null;
  /** What a unit sent, once whole (nxdndata.ts): a data call's position or text, a status, a talker alias. */
  data: UnitData[];
}
/** One baud rate's receiver: symbols in (from [SymbolRx]), frames found by their FSW, every kind of channel read. */
export class NxdnFramer {
  onSite: (s: NxdnSite) => void = () => undefined;
  onFrame: (lich: number, ok: boolean) => void = () => undefined;
  /** An outbound control channel frame: its SR and messages. */
  onCac: (sr: number, msgs: NxdnMsg[]) => void = () => undefined;
  /** A traffic or conventional channel frame. */
  onTraffic: (t: NxdnTraffic) => void = () => undefined;
  readonly stats = { fsw: 0, lichOk: 0, cacOk: 0, cacBad: 0, sacchOk: 0, facchOk: 0, scchOk: 0, udchOk: 0, voice: 0 };
  private readonly data = new NxdnDataReader();
  /** The last frame's worth of symbols, and the frames waiting for their body (every FSW match gets its own look). */
  private readonly hist = new Float32Array(256); private hp = 0;
  private pending: number[] = [];
  /** The SACCH superframe being put together (four quarters of 18 bits), and its RAN. */
  private sf: (Uint8Array | null)[] = [null, null, null, null]; private sfRan = -1;
  /** Where the last frame read ended, and the last one that passed a check (a frame's voice counts on that grid). */
  private lastFrame = -1e9; private lastGood = -1e9;
  /**
   * Locked: a check of 12 bits or more passed (a CAC, a FACCH1), or a SACCH superframe came whole (its four quarters in
   * order), or a Type-D SCCH went through INFO1 to INFO4 in order on one grid. Until then no voice and no SACCH or SCCH
   * field is handed on. A receiver at the wrong symbol rate finds a frame sync now and then, a 6-bit CRC passes one time
   * in 64, and a transmitter repeating one frame that happens to pass a short check passes it every frame: the order of
   * the structure fields is what a repeated frame cannot fake.
   */
  locked = false; private scchNext = 0; private siteRun = 0;
  /** Frame syncs on the 192-symbol grid of the one before (an NXDN signal, whether or not anything on it decodes). */
  gridSyncs = 0; private readonly recent: number[] = []; private readonly onGridAt: number[] = [];
  /** Steady: 15 or more of the last 25 frames (2 s at NXDN48) brought their sync on the grid. A tone or noise does not. */
  get steady(): boolean { return this.onGridAt.length >= 15; }
  push(s: number): void {
    this.hist[this.hp & 255] = s; this.hp++;
    if (this.hp >= 10) {
      let c = 0, a = 0; for (let k = 0; k < 10; k++) { const x = this.hist[(this.hp - 10 + k) & 255]; c += x * FSW[k]; a += Math.abs(x); }
      if (a > 15 && c / (3 * a) > 0.85) {
        this.stats.fsw++; this.pending.push(this.hp + BODY);
        // on the grid of a sync of the last four frames (a chance match inside a frame does not break it)
        if (this.recent.some(p => { const g = this.hp - p; return g >= FRAME - 2 && g <= 4 * FRAME + 2 && Math.abs(g - FRAME * Math.round(g / FRAME)) <= 2; })) { this.gridSyncs++; this.onGridAt.push(this.hp); }
        while (this.onGridAt.length && this.hp - this.onGridAt[0] > 25 * FRAME) this.onGridAt.shift();
        this.recent.push(this.hp); if (this.recent.length > 12) this.recent.shift();
      }
    }
    while (this.pending.length && this.pending[0] <= this.hp) {
      const end = this.pending.shift()!;
      if (end - this.lastFrame < BODY) continue;
      const sym = new Float32Array(BODY);
      for (let i = 0; i < BODY; i++) { const x = this.hist[(end - BODY + i) & 255]; sym[i] = SCR[i] ? -x : x; }
      if (this.frame(sym, end)) this.lastFrame = end;
    }
  }
  /** Soft bits (positive for 0) of symbols [from, from + n). */
  private soft(v: Float32Array, from: number, n: number): Float32Array {
    const out = new Float32Array(2 * n);
    for (let k = 0; k < n; k++) {
      const x = v[from + k];
      out[2 * k] = Math.max(-1, Math.min(1, x / 2));
      out[2 * k + 1] = Math.max(-1, Math.min(1, (2 - Math.abs(x)) / 1.5));
    }
    return out;
  }
  private hard(v: Float32Array, from: number, n: number): Uint8Array {
    const out = new Uint8Array(2 * n);
    for (let k = 0; k < n; k++) { const x = v[from + k]; out[2 * k] = x < 0 ? 1 : 0; out[2 * k + 1] = Math.abs(x) > 2 ? 1 : 0; }
    return out;
  }
  private frame(v: Float32Array, end: number): boolean {
    // LICH: one bit a symbol
    let lich = 0; for (let k = 0; k < 8; k++) lich = (lich << 1) | (v[k] < 0 ? 1 : 0);
    const par = ((lich >> 7) ^ (lich >> 6) ^ (lich >> 5) ^ (lich >> 4)) & 1;
    if (par !== (lich & 1)) { this.onFrame(lich >> 1, false); return false; }
    this.stats.lichOk++;
    const info = lich >> 1, rf = info >> 5, fn = (info >> 3) & 3, opt = (info >> 1) & 3, dir = info & 1;
    this.onFrame(info, true);
    if (rf === 0) {
      if (fn !== 0 || dir !== 1) return false;
      const cac = nxdnCac(this.soft(v, 8, 150), true);
      if (!cac) { this.stats.cacBad++; return false; }
      this.stats.cacOk++; this.lastGood = end; this.locked = true;
      const msgs = nxdnCacMessages(cac);
      for (const m of msgs) if (m.site) this.onSite(m.site);
      this.onCac(field(cac, 0, 8), msgs);
      return true;
    }
    // a data frame (functional channel 01): the UDCH, or a FACCH2 (option 11), alone after the LICH
    if ((rf === 1 || rf === 2) && fn === 1) {
      const u = nxdnUdch(this.soft(v, 8, 174), true);
      if (!u) return false;
      this.stats.udchOk++; this.lastGood = end; this.locked = true;
      const o = bytesOf(u, 8, 22), m = nxdnParse(o, 'tc');
      const t: NxdnTraffic = { rf, fn, opt, dir, ran: -1, typeD: false, halves: [null, null], msgs: m.type === 0x0b ? [] : [m], scch: null, data: this.data.push(o) };
      this.onTraffic(t);
      return true;
    }
    // a traffic channel: the SACCH (or a Type-D SCCH), then the VCHs or FACCH1s
    const t: NxdnTraffic = { rf, fn, opt, dir, ran: -1, typeD: false, halves: [null, null], msgs: [], scch: null, data: [] };
    const sc = nxdnSacch(this.soft(v, 8, 30), true);
    let good = false;
    if (rf === 3 && sc.scch) {
      t.typeD = true; t.scch = nxdnScch(sc.scch); this.stats.scchOk++; good = true;
      // INFO1, INFO2, INFO3, INFO4 in turn, a frame apart (TS 1-E 6.3)
      const nearby = end - this.lastGood <= FRAME + 2 && end - this.lastGood >= FRAME - 2;
      this.scchNext = t.scch.info === 1 ? 2 : t.scch.info === this.scchNext && nearby ? this.scchNext + 1 : 0;
      // an idle repeater sends its site ID (INFO4, ID 2041) frame after frame: three in a row on one grid will do
      this.siteRun = t.scch.kind === 'site' && (nearby || this.siteRun === 0) ? this.siteRun + 1 : t.scch.kind === 'site' ? 1 : 0;
      if (this.scchNext === 5 || this.siteRun >= 3) this.locked = true;
    }
    else if (sc.sacch) {
      this.stats.sacchOk++; good = true;
      const sr = field(sc.sacch, 0, 8), q = 3 - (sr >> 6); t.ran = sr & 0x3f;
      // a superframe SACCH (functional channel 10 or 11): four quarters, the head first (Table 6.3-2)
      if (fn === 2 || fn === 3) {
        if (q === 0 || this.sfRan !== t.ran) { this.sf = [null, null, null, null]; this.sfRan = t.ran; }
        this.sf[q] = sc.sacch.slice(8, 26);
        if (q === 3 && this.sf.every(Boolean)) {
          const bits = new Uint8Array(72); this.sf.forEach((p, i) => bits.set(p!, 18 * i));
          t.msgs.push(nxdnParse(bytesOf(bits, 0, 9), 'tc'));
          this.sf = [null, null, null, null]; this.locked = true;
        }
      }
    }
    // the VCH area and its steal flags (1-A and 1-E Table 5.2-1); the UDCH and FACCH2 of a data frame are not read
    const voiceFn = t.typeD ? fn === 2 : fn === 2 || fn === 0, facchOnly = t.typeD && fn === 0;
    const grid = end - this.lastGood, onGrid = grid > 0 && grid <= 4 * FRAME + 4 && Math.abs(grid - FRAME * Math.round(grid / FRAME)) <= 2;
    if (voiceFn || facchOnly) {
      for (let h = 0; h < 2; h++) {
        const from = 38 + 72 * h, stolen = facchOnly ? h === 0 || opt === 0 : opt === 0 || (h === 0 ? opt === 1 : opt === 2);
        if (stolen) {
          const f = nxdnFacch1(this.soft(v, from, 72), true);
          if (f) { this.stats.facchOk++; good = true; this.locked = true; t.msgs.push(nxdnParse(bytesOf(f, 0, 10), 'tc', t.typeD)); }
        } else if (!facchOnly) t.halves[h] = this.hard(v, from, 72);
      }
    }
    // voice in a frame where nothing passed a check counts only on the grid of the frames that did
    if (!good && !onGrid) return false;
    if (good) this.lastGood = end;
    if (!this.locked) { t.halves = [null, null]; t.ran = -1; t.scch = null; }
    else for (const m of t.msgs) t.data.push(...this.data.push(fromHex(m.hex)));
    this.stats.voice += t.halves.filter(Boolean).length;
    this.onTraffic(t);
    return true;
  }
}
/**
 * A receiver at one baud rate on complex baseband: a low-pass a little wider than the signal (outer deviation plus
 * half the symbol rate, with room for a frequency offset), then the symbol recovery and the framer.
 */
export class NxdnRx {
  readonly framer = new NxdnFramer();
  readonly rx: SymbolRx;
  private readonly h: Float32Array; private readonly bi: Float32Array; private readonly bq: Float32Array; private p = 0;
  private oi = new Float32Array(0); private oq = new Float32Array(0);
  /** The first tenth of a second is held to measure the carrier offset (the scrambled levels average out). */
  private hold: { i: number[]; q: number[] } | null = { i: [], q: [] };
  /** The symbols also go here (dPMR shares the NXDN48 receiver: 2400 symbols a second, the same deviation). */
  tap: ((s: number) => void) | null = null;
  constructor(readonly fs: number, readonly baud: 2400 | 4800) {
    this.rx = new SymbolRx(fs, baud, 0.5); this.rx.onSymbol = s => { this.framer.push(s); this.tap?.(s); };
    const fc = (baud === 2400 ? 1050 : 2400) + baud / 2 + 800, n = 2 * Math.round(2 * fs / baud) + 1, m = (n - 1) / 2;
    this.h = new Float32Array(n); let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = i - m, x = 2 * fc / fs, sinc = t === 0 ? x : Math.sin(Math.PI * x * t) / (Math.PI * t);
      this.h[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1))); sum += this.h[i];
    }
    for (let i = 0; i < n; i++) this.h[i] /= sum;
    this.bi = new Float32Array(2 * n); this.bq = new Float32Array(2 * n);
  }
  push(zi: Float32Array, zq: Float32Array, m: number): void {
    if (this.oi.length < m) { this.oi = new Float32Array(m); this.oq = new Float32Array(m); }
    const h = this.h, n = h.length, bi = this.bi, bq = this.bq;
    for (let k = 0; k < m; k++) {
      bi[this.p] = bi[this.p + n] = zi[k]; bq[this.p] = bq[this.p + n] = zq[k];
      if (++this.p >= n) this.p = 0;
      let x = 0, y = 0; for (let j = 0; j < n; j++) { x += h[j] * bi[this.p + j]; y += h[j] * bq[this.p + j]; }
      this.oi[k] = x; this.oq[k] = y;
    }
    if (!this.hold) { this.rx.push(this.oi, this.oq, m); return; }
    const hd = this.hold; for (let k = 0; k < m; k++) { hd.i.push(this.oi[k]); hd.q.push(this.oq[k]); }
    if (hd.i.length < this.fs / 10) return;
    let re = 0, im = 0;
    for (let k = 1; k < hd.i.length; k++) { re += hd.i[k] * hd.i[k - 1] + hd.q[k] * hd.q[k - 1]; im += hd.q[k] * hd.i[k - 1] - hd.i[k] * hd.q[k - 1]; }
    this.rx.setOffset(Math.atan2(im, re) * this.fs / (2 * Math.PI));
    this.hold = null;
    this.rx.push(Float32Array.from(hd.i), Float32Array.from(hd.q), hd.i.length);
  }
  /** The end of a recording: the samples still waiting for a whole timing block. */
  flush(): void { this.rx.flush(); }
}

// ---------------------------------------------------------------------------------------------------------- channels
/**
 * Channel number to frequency. TS 1-A gives the channel 10 bits (6.5.31) and no plan: each system sets its own. So the
 * plan is learned from what is heard: pairs of channel number and carrier (a control channel's own number from its
 * SITE_INFO, a grant matched to the voice that follows it). A channel heard is used as heard; channels heard that fit
 * one step and base give the rest; with one heard, the channel spacing of the bandwidth (6.25 kHz for NXDN48, 12.5 kHz
 * for NXDN96) is a guess, used only where a carrier is live.
 */
export class NxdnPlan {
  /** Votes per channel for the carrier it is (Hz, to 125 Hz). */
  readonly votes = new Map<number, Map<number, number>>();
  /** The carrier each channel was heard on (two votes and two thirds of them). */
  readonly heard = new Map<number, number>();
  spacing = 6250;
  /** A pair heard: true when it settled (or moved) the channel's carrier. */
  vote(ch: number, hz: number, weight = 1): boolean {
    if (ch <= 0) return false;
    const k = Math.round(hz / 125) * 125, v = this.votes.get(ch) ?? new Map<number, number>();
    v.set(k, (v.get(k) ?? 0) + weight); this.votes.set(ch, v);
    let best = 0, n = 0, all = 0; for (const [f, m] of v) { all += m; if (m > n) { n = m; best = f; } }
    if (n >= 2 && n * 3 >= all * 2 && this.heard.get(ch) !== best) {
      for (const [c, f] of this.heard) if (f === best && c !== ch) this.heard.delete(c);
      this.heard.set(ch, best); return true;
    }
    return false;
  }
  /** The linear plan the channels heard agree on: step (Hz a channel) and the frequency of channel 0. */
  get linear(): { step: number; base: number } | null {
    const p = [...this.heard].sort((a, b) => a[0] - b[0]);
    if (p.length < 2) return null;
    const [c0, f0] = p[0], [c1, f1] = p[p.length - 1], step = (f1 - f0) / (c1 - c0);
    if (!(Math.abs(step) >= 1000 && Math.abs(step) <= 100_000)) return null;
    const base = f0 - c0 * step;
    return p.every(([c, f]) => Math.abs(base + c * step - f) < 300) ? { step, base } : null;
  }
  /** Where a channel is: 'heard' on the air, from the 'plan' the channels heard give, or a 'guess' from one. */
  resolve(ch: number): { hz: number; how: 'heard' | 'plan' | 'guess' } | null {
    if (ch <= 0) return null;
    const h = this.heard.get(ch); if (h) return { hz: h, how: 'heard' };
    const l = this.linear; if (l) return { hz: Math.round(l.base + ch * l.step), how: 'plan' };
    if (this.heard.size === 1) { const [c, f] = [...this.heard][0]; return { hz: f + (ch - c) * this.spacing, how: 'guess' }; }
    return null;
  }
}
