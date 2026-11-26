/** What each AAS port carries: sizes, a sample, entropy, TPEG frames (ISO/TS 18234-2) and images found inside. */
import { entropy, printable, scanEmbedded, type Embedded } from './lot.js';

const SAMPLE = 16_384, CARVE = 1 << 20;

export interface TpegStats {
  frames: number; crcBad: number; frameTypes: Record<string, number>;
  /** Service ids (SID-A.B.C, and as text when printable) with their encryption indicator (0: in the clear). */
  services: { sid: string; text: string; encId: number; frames: number }[];
  lastHex: string;
}
export interface PortInfo {
  port: number; dtpf: number[]; minLen: number; maxLen: number; firstHex: string; lastHex: string;
  /** Over the last bytes sent: bits per byte (near 8 is compressed or encrypted) and the share that is text. */
  entropy: number; printable: number;
  /** What the bytes look like: 'LOT objects', 'TPEG stream', 'images', 'text', 'random (encrypted or compressed)', 'binary'. */
  content: string; packets: number; lotHeaders: number; tpeg: TpegStats | null; images: number;
}
/** Something found where it was not announced: an image inside a stream or a file, text inside an image, a PSD picture. */
export interface Finding { where: string; port: number; type: string; offset: number; length: number; width?: number; height?: number; complete: boolean; note: string; ms: number }

interface PortState extends PortInfo {
  sample: number[]; tbuf: number[]; carve: Uint8Array; carveLen: number; carveBase: number; cands: number[]; seen: Set<number>; uniq: Set<string>; lastSeq: number;
  tsvc: Map<string, { sid: string; text: string; encId: number; frames: number }>;
}

export class PortInventory {
  /** A whole image cut out of a stream. */
  onCarved: (port: number, e: Embedded, bytes: Uint8Array) => void = () => {};
  readonly findings: Finding[] = [];
  private readonly ports = new Map<number, PortState>();

  /** One packet's payload; `aas` is the directory's transport for the port (3 LOT, 0 stream, 1 packet, -1 not listed). */
  add(port: number, dtpf: number, seq: number, p: Uint8Array, aas = -1): void {
    let s = this.ports.get(port);
    if (!s) {
      s = { port, dtpf: [], minLen: Infinity, maxLen: 0, firstHex: hex(p.subarray(0, 32)), lastHex: '', entropy: 0, printable: 0, content: '', packets: 0, lotHeaders: 0, tpeg: null, images: 0,
        sample: [], tbuf: [], carve: new Uint8Array(0), carveLen: 0, carveBase: 0, cands: [], seen: new Set(), uniq: new Set(), lastSeq: -1, tsvc: new Map() };
      this.ports.set(port, s);
    }
    s.packets++;
    if (!s.dtpf.includes(dtpf)) s.dtpf.push(dtpf);
    s.minLen = Math.min(s.minLen, p.length); s.maxLen = Math.max(s.maxLen, p.length); s.lastHex = hex(p.subarray(0, 32));
    for (let i = 0; i < p.length; i++) s.sample.push(p[i]);
    if (s.sample.length > SAMPLE) s.sample.splice(0, s.sample.length - SAMPLE);
    if (p.length >= 8 && p[0] >= 8 && p[0] <= p.length && ((p[4] | p[5] | p[6] | p[7]) === 0 ? p[8] === 1 && p[9] === 0 && p[10] === 0 && p[11] === 0 : p[0] === 8)) s.lotHeaders++;
    const gap = s.lastSeq >= 0 && ((seq - s.lastSeq) & 0xFFFF) !== 1;
    s.lastSeq = seq;
    if (gap) { s.tbuf = []; s.cands = []; }
    for (let i = 0; i < p.length; i++) s.tbuf.push(p[i]);
    this.tpeg(s);
    // LOT ports are looked into file by file, once each is whole
    const lot = aas === 3 || (aas < 0 && s.lotHeaders >= 2 && s.lotHeaders >= 0.8 * s.packets);
    if (!lot) this.carve(s, p, gap);
  }

  /** TPEG transport frames in a port's byte stream. */
  private tpeg(s: PortState): void {
    const b = s.tbuf;
    let i = 0;
    for (;;) {
      while (i + 1 < b.length && !(b[i] === 0xFF && b[i + 1] === 0x0F)) i++;
      if (i + 18 > b.length) break;
      const len = (b[i + 2] << 8) | b[i + 3], crc = (b[i + 4] << 8) | b[i + 5];
      if ((ccitt([b[i], b[i + 1], b[i + 2], b[i + 3], ...b.slice(i + 6, i + 18)]) ^ 0xFFFF) !== crc) { if (s.tpeg) s.tpeg.crcBad++; i++; continue; }
      if (i + 7 + len > b.length) break;
      const t = s.tpeg ??= { frames: 0, crcBad: 0, frameTypes: {}, services: [], lastHex: '' };
      const ft = b[i + 6];
      t.frames++; t.frameTypes[String(ft)] = (t.frameTypes[String(ft)] ?? 0) + 1; t.lastHex = hex(b.slice(i, i + 32));
      if (ft === 1) {
        const sid = `${b[i + 7]}.${b[i + 8]}.${b[i + 9]}`, txt = [b[i + 7], b[i + 8], b[i + 9]].every(c => c >= 32 && c < 127) ? String.fromCharCode(b[i + 7], b[i + 8], b[i + 9]) : '';
        const key = `${ft}/${sid}`, e = s.tsvc.get(key);
        if (e) e.frames++; else s.tsvc.set(key, { sid, text: txt, encId: b[i + 10], frames: 1 });
        t.services = [...s.tsvc.values()];
      }
      i += 7 + len;
    }
    b.splice(0, Math.max(0, Math.min(i, b.length - 1)));
    if (b.length > 65_536) b.splice(0, b.length - 65_536);
  }

  /** Image starts in the stream; each is cut out once it ends, or noted as cut short when the stream breaks first. */
  private carve(s: PortState, p: Uint8Array, gap: boolean): void {
    if (gap) { s.carveBase += s.carveLen; s.carveLen = 0; }
    if (s.carve.length < s.carveLen + p.length) { const n = new Uint8Array(Math.max(4096, (s.carveLen + p.length) * 2)); n.set(s.carve.subarray(0, s.carveLen)); s.carve = n; }
    const from = Math.max(0, s.carveLen - 32);
    s.carve.set(p, s.carveLen); s.carveLen += p.length;
    const buf = s.carve.subarray(0, s.carveLen);
    for (const e of scanEmbedded(buf, from, 8)) { const abs = s.carveBase + e.offset; if (!s.seen.has(abs) && !s.cands.includes(abs)) s.cands.push(abs); }
    s.cands = s.cands.filter(abs => {
      const off = abs - s.carveBase; if (off < 0) return false;
      const e = scanEmbedded(buf, off, 1)[0];
      if (!e || e.offset !== off) return false;
      if (!e.complete) return s.carveLen - off < CARVE;
      s.seen.add(abs);
      // carousels repeat the same images; keep each once
      const key = `${e.length}:${fnv(buf.subarray(off, off + e.length))}`;
      if (s.uniq.has(key)) return false;
      s.uniq.add(key); s.images++;
      this.note({ where: `port ${hex4(s.port)} stream`, port: s.port, type: e.type, offset: abs, length: e.length, width: e.width, height: e.height, complete: true, note: 'an image inside the byte stream, cut out whole', ms: Date.now() });
      this.onCarved(s.port, e, buf.slice(off, off + e.length));
      return false;
    });
    if (s.carveLen > CARVE * 2) { const keep = s.cands.length ? Math.min(...s.cands) - s.carveBase : s.carveLen - 64; const k = Math.max(0, Math.min(keep, s.carveLen - 64)); s.carve.copyWithin(0, k, s.carveLen); s.carveLen -= k; s.carveBase += k; }
  }

  note(f: Finding): void {
    if (this.findings.some(x => x.where === f.where && x.offset === f.offset && x.type === f.type)) return;
    this.findings.unshift(f); if (this.findings.length > 200) this.findings.length = 200;
  }

  info(lotPorts: Set<number>): PortInfo[] {
    return [...this.ports.values()].map(s => {
      const smp = Uint8Array.from(s.sample), h = entropy(smp), pr = printable(smp);
      const content = lotPorts.has(s.port) || (s.lotHeaders >= 0.8 * s.packets && s.lotHeaders >= 2 && !s.tpeg?.frames) ? 'LOT objects' : s.tpeg && s.tpeg.frames ? 'TPEG stream' : s.images ? 'images' : pr > 0.95 ? 'text' : h > 7.5 ? 'random (encrypted or compressed)' : 'binary';
      return { port: s.port, dtpf: s.dtpf, minLen: s.minLen === Infinity ? 0 : s.minLen, maxLen: s.maxLen, firstHex: s.firstHex, lastHex: s.lastHex, entropy: +h.toFixed(2), printable: +pr.toFixed(2), content, packets: s.packets, lotHeaders: s.lotHeaders, tpeg: s.tpeg ? { ...s.tpeg, services: [...s.tpeg.services] } : null, images: s.images };
    }).sort((a, b) => a.port - b.port);
  }
  /** A sample of a port's last bytes (for a hex view). */
  sample(port: number, n = 256): string { const s = this.ports.get(port); return s ? hex(s.sample.slice(-n)) : ''; }
}

const fnv = (b: Uint8Array) => { let h = 2166136261; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); } return h >>> 0; };
export const hex = (b: ArrayLike<number>) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const hex4 = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
/** CRC-CCITT, x^16 + x^12 + x^5 + 1, from 0xFFFF, high bit first. */
export function ccitt(b: ArrayLike<number>): number {
  let c = 0xFFFF;
  for (let i = 0; i < b.length; i++) { c ^= b[i] << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; }
  return c;
}
