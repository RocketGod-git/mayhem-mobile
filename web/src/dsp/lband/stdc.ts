/**
 * Inmarsat-C NCS TDM: the common channel every Inmarsat-C ship terminal listens to, 1200 symbols a second BPSK, one
 * 10 368-symbol frame every 8.64 s (64 rows of 2 UW symbols and 160 coded ones: 639 data bytes and the flush byte;
 * see frame.ts). A frame holds packets back to back, each with its descriptor and a two-byte Fletcher check:
 * - a descriptor under 0x80 is short, its low four bits the length less one (0x7D, the bulletin board, is 14 bytes);
 * - 0x80 to 0xBF is medium, the next byte the length less two; 0xC0 and up is long, a 16-bit length less three.
 * The bulletin board opens every frame with the frame number (0 to 9999, 8.64 s apart from midnight UTC).
 *
 * EGC (SafetyNET and FleetNET broadcasts) comes in 0xB1 (a message's first packet) and 0xB2 (the rest) packets:
 * service code, priority, message and packet numbers, the address the service calls for, then IA5 text. Text in any
 * other presentation is binary or encrypted: it is flagged, never shown.
 *
 * Twins: core/sat/Stdc.kt and core/sat/Stdc.swift.
 */
import { FrameSync, uwBits, type FrameLayout } from './frame.js';

export const STDC_LAYOUT: FrameLayout = { uw: uwBits(0xFD07091B, 0x2D7798A8), uwPerRow: 2, cols: 160 };
export const STDC_SYMBOL_RATE = 1200;
export const STDC_DATA_BYTES = 639;

/** The NCS common channels, by ocean region. */
export const NCS_CHANNELS: [string, number][] = [
  ['AMER', 1_537_700_000], ['AOR-E', 1_541_450_000], ['IOR', 1_537_100_000], ['POR', 1_541_450_000],
];

export const PRIORITY_NAMES = ['ROUTINE', 'SAFETY', 'URGENCY', 'DISTRESS'];

type AddrKind = 'none' | 'rect' | 'circle' | 'navarea' | 'coastal' | 'enid';
const SERVICES: [number, string, AddrKind][] = [
  [0x00, 'General call', 'none'],
  [0x02, 'Group call (FleetNET)', 'enid'],
  [0x04, 'NAV / MET / piracy warning, rectangular area', 'rect'],
  [0x11, 'Inmarsat system message', 'none'],
  [0x13, 'NAV / MET / piracy warning, circular area', 'circle'],
  [0x14, 'Shore-to-ship distress alert, circular area', 'circle'],
  [0x23, 'EGC system message', 'none'],
  [0x24, 'Coastal warning', 'coastal'],
  [0x31, 'NAVAREA / METAREA warning or MET forecast', 'navarea'],
  [0x33, 'Download group identity', 'enid'],
  [0x34, 'SAR coordination, rectangular area', 'rect'],
  [0x44, 'SAR coordination, circular area', 'circle'],
  [0x72, 'Chart correction service', 'navarea'],
];
export function serviceName(code: number): string { for (const s of SERVICES) if (s[0] === code) return s[1]; return `service ${code.toString(16).toUpperCase().padStart(2, '0')}`; }
function addrKind(code: number): AddrKind { for (const s of SERVICES) if (s[0] === code) return s[2]; return 'none'; }
const NAVTEX_SUBJECTS: Record<string, string> = { A: 'navigational warning', B: 'meteorological warning', C: 'ice report', D: 'search and rescue, piracy', E: 'meteorological forecast', F: 'pilot service', G: 'AIS', H: 'LORAN', J: 'GNSS', K: 'other navaid', L: 'navigational warning', Z: 'no messages' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];

const s8 = (v: number) => (v & 0x80 ? v - 256 : v);
const s16 = (v: number) => (v & 0x8000 ? v - 65536 : v);
const latText = (d: number) => `${Math.abs(d)}°${d < 0 ? 'S' : 'N'}`;
const lonText = (d: number) => `${Math.abs(d)}°${d < 0 ? 'W' : 'E'}`;

/** The area an EGC address names, as text. */
export function areaText(service: number, a: number[]): string {
  switch (addrKind(service)) {
    case 'rect': return a.length >= 5 ? `${latText(s8(a[0]))} ${lonText(s16((a[1] << 8) | a[2]))}, ${a[3]}° north by ${a[4]}° east` : '';
    case 'circle': return a.length >= 5 ? `${latText(s8(a[0]))} ${lonText(s16((a[1] << 8) | a[2]))}, radius ${(a[3] << 8) | a[4]} nm` : '';
    case 'navarea': return a.length >= 1 ? `NAVAREA ${ROMAN[a[0]] ?? a[0]}` : '';
    case 'coastal': {
      if (a.length < 3) return '';
      const st = String.fromCharCode(a[1] & 0x7F), sub = String.fromCharCode(a[2] & 0x7F);
      return `NAVAREA ${ROMAN[a[0]] ?? a[0]}, station ${st}, ${NAVTEX_SUBJECTS[sub] ?? `subject ${sub}`}`;
    }
    case 'enid': return a.length >= 2 ? `ENID ${(a[0] << 8) | a[1]}` : '';
    default: return a.length ? a.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ') : '';
  }
}

/** Fletcher (mod 255) over a packet with its two check bytes last: true when it checks. */
export function fletcherOk(b: ArrayLike<number>, at: number, n: number): boolean {
  let c0 = 0, c1 = 0;
  for (let i = 0; i < n; i++) { c0 = (c0 + b[at + i]) % 255; c1 = (c1 + c0) % 255; }
  return c0 === 0 && c1 === 0;
}
/** The two check bytes that make a packet check (the last two of `b`, which are overwritten). */
export function fletcherSet(b: number[]): number[] {
  const n = b.length;
  b[n - 2] = 0; b[n - 1] = 0;
  let c0 = 0, c1 = 0;
  for (let i = 0; i < n; i++) { c0 = (c0 + b[i]) % 255; c1 = (c1 + c0) % 255; }
  let x = ((c0 - c1) % 255 + 255) % 255, y = ((c1 - 2 * c0) % 255 + 510) % 255;
  if (x === 0) x = 255; if (y === 0) y = 255;
  b[n - 2] = x; b[n - 1] = y;
  return b;
}

/** A packet's whole length from its descriptor (0 when it cannot be one). */
export function packetLength(f: ArrayLike<number>, pos: number, end: number): number {
  const b = f[pos];
  if (b < 0x80) return (b & 0x0F) + 1;
  if (b < 0xC0) return pos + 1 < end ? f[pos + 1] + 2 : 0;
  return pos + 2 < end ? ((f[pos + 1] << 8) | f[pos + 2]) + 3 : 0;
}

/** Transmitter side (tests, tools): a medium packet of `type` around `body`, check bytes added. */
export function mediumPacket(type: number, body: number[]): number[] { return fletcherSet([type, body.length + 2, ...body, 0, 0]); }
/** The bulletin board for frame `frameNo`. */
export function bulletinBoard(frameNo: number): number[] { return fletcherSet([0x7D, 0x01, frameNo >> 8, frameNo & 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); }
/** An EGC message's packets (text in pieces of up to `chunk` bytes). */
export function egcPackets(service: number, priority: number, seq: number, address: number[], text: string, chunk = 120, presentation = 0): number[][] {
  const t = [...text].map(c => c.charCodeAt(0) & 0x7F), out: number[][] = [];
  for (let p = 0, k = 0; k === 0 || p < t.length; k++) {
    const part = t.slice(p, p + chunk); p += chunk;
    const last = p >= t.length ? 0x80 : 0;
    if (k === 0) out.push(mediumPacket(0xB1, [service, (priority << 6) | presentation, seq >> 8, seq & 0xFF, k | last, address.length, ...address, ...part]));
    else out.push(mediumPacket(0xB2, [seq >> 8, seq & 0xFF, service, k | last, ...part]));
  }
  return out;
}
/** Packets into one frame's data bytes (zeros after them). */
export function frameData(packets: number[][]): Uint8Array {
  const d = new Uint8Array(STDC_DATA_BYTES);
  let p = 0;
  for (const k of packets) { d.set(k, p); p += k.length; }
  return d;
}

/** One EGC broadcast, as far as it has come in. */
export interface EgcMessage {
  key: string; service: number; serviceName: string; priority: number; priorityName: string; area: string; seq: number;
  text: string; parts: number; complete: boolean; encrypted: boolean; firstMs: number; lastMs: number; repeats: number; frame: number;
}

export interface StdcStats { frames: number; packets: number; badPackets: number; egc: number; other: number; frameNo: number; score: number; ber: number }

/** STD-C NCS TDM: soft symbols in, frames, packets and EGC messages out. */
export class StdcDecoder {
  now: () => number = () => Date.now();
  onMessage: ((m: EgcMessage) => void) | null = null;
  readonly stats: StdcStats = { frames: 0, packets: 0, badPackets: 0, egc: 0, other: 0, frameNo: -1, score: 0, ber: 0 };
  private readonly sync = new FrameSync(STDC_LAYOUT, (d, s, b) => this.frame(d, s, b));
  private readonly msgs = new Map<string, EgcMessage & { pieces: Map<number, string>; lastPart: number }>();

  push(soft: number): void { this.sync.push(soft); }
  reset(): void { this.sync.reset(); }
  clear(): void { this.msgs.clear(); }

  /** Newest first. */
  messages(): EgcMessage[] {
    return [...this.msgs.values()].sort((a, b) => b.lastMs - a.lastMs).map(({ pieces: _p, lastPart: _l, ...m }) => m);
  }

  /** One frame's data bytes (tests and tools can call this directly). */
  frame(d: Uint8Array, score: number, ber: number): void {
    const st = this.stats;
    st.frames++; st.score = score; st.ber = ber;
    let pos = 0;
    while (pos < d.length) {
      if (d[pos] === 0) break;
      const len = packetLength(d, pos, d.length);
      if (len < 3 || pos + len > d.length) { st.badPackets++; break; }
      if (!fletcherOk(d, pos, len)) { st.badPackets++; pos += len; continue; }
      st.packets++;
      const p = Array.from(d.subarray(pos, pos + len));
      if (p[0] === 0x7D) st.frameNo = (p[2] << 8) | p[3];
      else if (p[0] === 0xB1 || p[0] === 0xB2) { st.egc++; this.egc(p); }
      else st.other++;
      pos += len;
    }
  }

  private egc(p: number[]): void {
    const end = p.length - 2;
    let service: number, seq: number, part: number, text: number[], first: { priority: number; presentation: number; address: number[] } | null = null;
    if (p[0] === 0xB1) {
      if (end < 8) return;
      service = p[2]; seq = (p[4] << 8) | p[5]; part = p[6];
      const al = p[7];
      if (8 + al > end) return;
      first = { priority: p[3] >> 6, presentation: p[3] & 0x3F, address: p.slice(8, 8 + al) };
      text = p.slice(8 + al, end);
    } else {
      if (end < 6) return;
      seq = (p[2] << 8) | p[3]; service = p[4]; part = p[5];
      text = p.slice(6, end);
    }
    const key = `${service}:${seq}`, now = this.now();
    let m = this.msgs.get(key);
    if (!m) {
      m = { key, service, serviceName: serviceName(service), priority: 0, priorityName: PRIORITY_NAMES[0], area: '', seq, text: '', parts: 0, complete: false, encrypted: false,
        firstMs: now, lastMs: now, repeats: 0, frame: this.stats.frameNo, pieces: new Map(), lastPart: -1 };
      this.msgs.set(key, m);
      if (this.msgs.size > 200) { const old = [...this.msgs.values()].sort((a, b) => a.lastMs - b.lastMs)[0]; this.msgs.delete(old.key); }
    }
    m.lastMs = now;
    if (first) {
      m.priority = first.priority; m.priorityName = PRIORITY_NAMES[first.priority];
      m.area = areaText(service, first.address);
      m.encrypted = first.presentation !== 0;
    }
    const k = part & 0x7F;
    // a broadcast is sent again a few minutes later: a part already held is a repeat
    if (m.pieces.has(k)) { if (k === 0) m.repeats++; }
    else m.pieces.set(k, text.map(c => { const x = c & 0x7F; return x === 0x0A || x === 0x0D || (x >= 0x20 && x < 0x7F) ? String.fromCharCode(x) : ''; }).join(''));
    if (part & 0x80) m.lastPart = k;
    m.parts = m.pieces.size;
    m.complete = m.lastPart >= 0 && m.pieces.size === m.lastPart + 1;
    m.text = m.encrypted ? '' : [...m.pieces.keys()].sort((a, b) => a - b).map(i => m!.pieces.get(i)).join('').replace(/\r\n?/g, '\n').trim();
    const { pieces: _p, lastPart: _l, ...out } = m;
    this.onMessage?.(out);
  }
}
