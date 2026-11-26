/**
 * Inmarsat Aero P-channel (ground to aircraft, ARINC 741): A-BPSK at 600 or 1200 symbols a second, framed as in
 * frame.ts with one UW symbol a row. A frame carries 4 (600) or 8 (1200) signal units of 12 bytes, each ten bytes
 * and a CRC-16 (CCITT, from 0xFFFF, sent high byte first). Signal units:
 * - 0x01 fill;
 * - 0x0A the GES's channel broadcast (its GES ID);
 * - 0x71 the first unit of a user data message: AES ID (the aircraft's 24-bit ICAO address), GES ID, reference
 *   number, how many units follow, then its first 3 data bytes;
 * - 0xC0 + n the units that follow (n from 1): the reference number and 8 data bytes each.
 * The data is an ACARS block (mode, registration, ack, label, block ID, STX, text, ETX), which comes out as the ACARS
 * app's message line with SAT in front, so Flight Msgs reads it as a satellite message.
 *
 * Twins: core/sat/Aero.kt and core/sat/Aero.swift.
 */
import { FrameSync, uwBits, type FrameLayout } from './frame.js';

const UW = uwBits(0xD59BB49C, 0x5E51841E);
export const aeroLayout = (rate: 600 | 1200): FrameLayout => ({ uw: UW, uwPerRow: 1, cols: rate === 600 ? 13 : 25 });
export const aeroUnits = (rate: 600 | 1200) => (rate === 600 ? 4 : 8);
export const SU_BYTES = 12;

export function crc16Ccitt(b: ArrayLike<number>, at: number, n: number): number {
  let c = 0xFFFF;
  for (let i = 0; i < n; i++) {
    c ^= b[at + i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c;
}
/** Transmitter side (tests, tools): ten bytes to a signal unit with its CRC. */
export function signalUnit(b: number[]): number[] {
  const u = b.slice(0, 10); while (u.length < 10) u.push(0);
  const c = crc16Ccitt(u, 0, 10);
  return [...u, c >> 8, c & 0xFF];
}
const oddParity = (c: number) => { let n = 0; for (let i = 0; i < 7; i++) n += (c >> i) & 1; return n % 2 === 0 ? c | 0x80 : c; };
/** An ACARS uplink block's signal units: the first, then the rest. */
export function acarsUnits(aes: number, ges: number, ref: number, reg: string, label: string, blk: string, text: string): number[][] {
  const body = [..."2", ...reg.padStart(7, '.'), '\x15', ...label, blk, '\x02', ...text, '\x03'].map(c => oddParity(c.charCodeAt(0)));
  const n = Math.ceil(Math.max(0, body.length - 3) / 8);
  const out = [signalUnit([0x71, aes >> 16, (aes >> 8) & 0xFF, aes & 0xFF, ges, ref, n, ...body.slice(0, 3)])];
  for (let k = 1; k <= n; k++) out.push(signalUnit([0xC0 | k, ref, ...body.slice(3 + 8 * (k - 1), 3 + 8 * k)]));
  return out;
}

const STX = 0x02, ETX = 0x03, ETB = 0x17, DEL = 0x7F;
/** An AES ID (ICAO address) as six hex digits. */
export const aesHex = (v: number) => v.toString(16).toUpperCase().padStart(6, '0');

/** An ACARS block as the ACARS app's line (SAT in front); null when it is not one. */
export function acarsLine(mhz: string, raw: number[]): string | null {
  const B = raw.map(x => x & 0x7F), n = B.length;
  if (n < 12 || B[0] < 0x20) return null;
  const ch = (i: number) => String.fromCharCode(B[i]);
  const mode = ch(0);
  let reg = ''; for (let i = 1; i <= 7; i++) reg += ch(i); reg = reg.replace(/^[. ]+|[. ]+$/g, '');
  const ack = B[8] === 0x15 ? 'NAK' : ch(8);
  const label = ch(9) + (B[10] === DEL ? 'd' : ch(10));
  const blk = ch(11);
  let p = 12, text = '';
  if (B[p] === STX) p++;
  while (p < n) { const c = B[p++]; if (c === ETX || c === ETB) break; text += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : (c === 0x0a || c === 0x0d) ? ' ' : '·'; }
  const head = `SAT ${mhz} ↑ ${reg}  ${label}  blk ${blk}  ack ${ack}${mode !== '2' ? `  mode ${mode}` : ''}`;
  const body = text.trim();
  return body ? `${head}\n${body}` : head;
}

export interface AeroStats { frames: number; units: number; badUnits: number; messages: number; ges: number; score: number; ber: number }

/** Aero P-channel: soft symbols in, signal units and ACARS lines out. */
export class AeroDecoder {
  /** The channel, for the lines. */
  hz = 0;
  /** An ACARS line, and the aircraft's ICAO address it was sent to. */
  onAcars: ((line: string, aes: number) => void) | null = null;
  readonly stats: AeroStats = { frames: 0, units: 0, badUnits: 0, messages: 0, ges: -1, score: 0, ber: 0 };
  readonly rate: 600 | 1200;
  private readonly sync: FrameSync;
  private readonly open = new Map<number, { aes: number; want: number; parts: Map<number, number[]> }>();

  constructor(rate: 600 | 1200) {
    this.rate = rate;
    this.sync = new FrameSync(aeroLayout(rate), (d, s, b) => this.frame(d, s, b));
  }
  push(soft: number): void { this.sync.push(soft); }
  reset(): void { this.sync.reset(); this.open.clear(); }

  frame(d: Uint8Array, score: number, ber: number): void {
    const st = this.stats;
    st.frames++; st.score = score; st.ber = ber;
    for (let u = 0; u < aeroUnits(this.rate); u++) {
      const at = u * SU_BYTES;
      if (crc16Ccitt(d, at, 10) !== ((d[at + 10] << 8) | d[at + 11])) { st.badUnits++; continue; }
      st.units++;
      this.unit(Array.from(d.subarray(at, at + 10)));
    }
  }

  private unit(b: number[]): void {
    const t = b[0];
    if (t === 0x0A) { this.stats.ges = b[1]; return; }
    if (t === 0x71) {
      const aes = (b[1] << 16) | (b[2] << 8) | b[3], ref = b[5], want = b[6];
      this.stats.ges = b[4];
      this.open.set(ref, { aes, want, parts: new Map([[0, b.slice(7, 10)]]) });
      if (this.open.size > 32) this.open.delete(this.open.keys().next().value as number);
      this.check(ref);
      return;
    }
    if ((t & 0xC0) === 0xC0) {
      const m = this.open.get(b[1]);
      if (m) { m.parts.set(t & 0x3F, b.slice(2, 10)); this.check(b[1]); }
    }
  }

  private check(ref: number): void {
    const m = this.open.get(ref);
    if (!m || m.parts.size < m.want + 1) return;
    this.open.delete(ref);
    const data: number[] = [];
    for (let k = 0; k <= m.want; k++) { const p = m.parts.get(k); if (!p) return; data.push(...p); }
    const line = acarsLine((this.hz / 1e6).toFixed(3), data);
    if (!line) return;
    this.stats.messages++;
    this.onAcars?.(line, m.aes);
  }
}
