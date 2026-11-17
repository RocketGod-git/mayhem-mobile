/**
 * Station Information Service on the PIDS channel (SY_IDD_1020s rev K, section 4): one 80-bit PDU per block, one or
 * two messages each. Fields are read from the PDU in its L2 bit order (the per-byte reversal of the L1 bits).
 * The CRC-12 at bits 68..79 does not verify against the text of 4.11 on our recordings, so every field is kept by
 * vote over repeated PDUs and shown as voted.
 */

const CHARS5 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ?-*$';
export const SIS_PAYLOAD = [32, 22, 58, 32, 27, 58, 27, 22, 58, 58, 27];

export type SisMsg =
  | { kind: 'id'; country: string; facility: number }
  | { kind: 'short'; name: string }
  | { kind: 'long'; last: number; frame: number; chars: string; seq: number }
  | { kind: 'loc'; high: boolean; deg: number; alt: number }
  | { kind: 'smsg'; frame: number; seq: number; priority?: number; encoding?: number; length?: number; bytes: number[] }
  | { kind: 'svc'; adv: boolean; audio: boolean; access: number; program: number; progType: number; dataType: number; mime12: number }
  | { kind: 'param'; index: number; value: number }
  | { kind: 'usn'; frame: number; encoding?: number; append?: number; bytes: number[] }
  | { kind: 'slogan'; frame: number; encoding?: number; length?: number; bytes: number[] }
  | { kind: 'alert'; bits: string }
  | { kind: 'other'; id: number };

export interface SisPdu { llds: boolean; msgs: SisMsg[]; timeLocked: number; advAlfn: number; crc: number }

const u = (b: ArrayLike<number>, a: number, n: number) => { let v = 0; for (let i = a; i < a + n; i++) v = v * 2 + (b[i] & 1); return v; };
const s = (v: number, n: number) => v >= 2 ** (n - 1) ? v - 2 ** n : v;
const bytesAt = (b: ArrayLike<number>, a: number, n: number) => Array.from({ length: n }, (_, i) => u(b, a + 8 * i, 8));

export function parseSisMsg(id: number, b: ArrayLike<number>): SisMsg {
  switch (id) {
    case 0: { const cc = u(b, 0, 10); return { kind: 'id', country: (cc >> 5) < 26 && (cc & 31) < 26 ? CHARS5[cc >> 5] + CHARS5[cc & 31] : `#${cc}`, facility: u(b, 13, 19) }; }
    case 1: {
      let name = '';
      for (let i = 0; i < 4; i++) { const c = u(b, 5 * i, 5); name += c < 31 ? CHARS5[c] : '#'; }
      return { kind: 'short', name: name.trim() + (u(b, 20, 2) === 1 ? '-FM' : '') };
    }
    case 2: return { kind: 'long', last: u(b, 0, 3), frame: u(b, 3, 3), chars: Array.from({ length: 7 }, (_, i) => String.fromCharCode(u(b, 6 + 7 * i, 7))).join(''), seq: u(b, 55, 3) };
    case 4: return { kind: 'loc', high: u(b, 0, 1) === 1, deg: s(u(b, 1, 22), 22) / 8192, alt: u(b, 23, 4) };
    case 5: {
      const frame = u(b, 0, 5), seq = u(b, 5, 2);
      if (frame === 0) return { kind: 'smsg', frame, seq, priority: u(b, 7, 1), encoding: u(b, 8, 3), length: u(b, 11, 8), bytes: bytesAt(b, 26, 4) };
      return { kind: 'smsg', frame, seq, bytes: bytesAt(b, 10, 6) };
    }
    case 6: case 10: {
      const cat = u(b, 0, 2);
      if (cat === 0) return { kind: 'svc', adv: id === 10, audio: true, access: u(b, 2, 1), program: u(b, 3, 6), progType: u(b, 9, 8), dataType: -1, mime12: -1 };
      return { kind: 'svc', adv: id === 10, audio: false, access: u(b, 2, 1), program: -1, progType: -1, dataType: u(b, 3, 9), mime12: u(b, 15, 12) };
    }
    case 7: return { kind: 'param', index: u(b, 0, 6), value: u(b, 6, 16) };
    case 8: {
      const frame = u(b, 0, 4);
      if (u(b, 4, 1) === 0) return frame === 0 ? { kind: 'usn', frame, encoding: u(b, 5, 3), append: u(b, 8, 1), bytes: bytesAt(b, 10, 6) } : { kind: 'usn', frame, bytes: bytesAt(b, 10, 6) };
      return frame === 0 ? { kind: 'slogan', frame, encoding: u(b, 5, 3), length: u(b, 11, 7), bytes: bytesAt(b, 18, 5) } : { kind: 'slogan', frame, bytes: bytesAt(b, 10, 6) };
    }
    case 9: return { kind: 'alert', bits: Array.from({ length: SIS_PAYLOAD[9] }, (_, i) => b[i] & 1).join('') };
    default: return { kind: 'other', id };
  }
}

/** One 80-bit SIS PDU in L2 bit order. */
export function parseSis(b: ArrayLike<number>): SisPdu {
  if (b[0]) return { llds: true, msgs: [], timeLocked: 0, advAlfn: 0, crc: 0 };
  const msgs: SisMsg[] = [];
  const id1 = u(b, 2, 4), n1 = SIS_PAYLOAD[id1] ?? 58;
  msgs.push(parseSisMsg(id1, Array.prototype.slice.call(b, 6, 6 + n1)));
  if (b[1]) {
    const p = 6 + n1, id2 = u(b, p, 4), n2 = SIS_PAYLOAD[id2] ?? 0;
    if (n2 && p + 4 + n2 <= 64) msgs.push(parseSisMsg(id2, Array.prototype.slice.call(b, p + 4, p + 4 + n2)));
  }
  return { llds: false, msgs, timeLocked: b[65] & 1, advAlfn: u(b, 66, 2), crc: u(b, 68, 12) };
}

/** ALFN from the 16 ADV ALFN pairs of one frame (1020s 5.3.1): blocks 0..7 the low 16 bits, 8..15 the high. */
export function alfnFromPairs(adv: number[]): number {
  let v = 0;
  for (let bc = 0; bc < 16; bc++) {
    const hi = bc < 8 ? 30 - 2 * bc : 14 - 2 * (bc - 8);
    v += (adv[bc] & 3) * 2 ** (31 - (hi + 1));
  }
  return v;
}
/** ALFN to UTC milliseconds: frames of 65536/44100 s since the GPS epoch, less the GPS-UTC leap seconds. */
export function alfnToMs(alfn: number, leap = 18): number { return Date.UTC(1980, 0, 6) + (alfn * 65536 / 44100 - leap) * 1000; }

/** NRSC-5 program types (the US table shared with RBDS). */
export const PROGRAM_TYPES: Record<number, string> = {
  0: 'None', 1: 'News', 2: 'Information', 3: 'Sports', 4: 'Talk', 5: 'Rock', 6: 'Classic Rock', 7: 'Adult Hits', 8: 'Soft Rock', 9: 'Top 40',
  10: 'Country', 11: 'Oldies', 12: 'Soft', 13: 'Nostalgia', 14: 'Jazz', 15: 'Classical', 16: 'Rhythm and Blues', 17: 'Soft Rhythm and Blues',
  18: 'Foreign Language', 19: 'Religious Music', 20: 'Religious Talk', 21: 'Personality', 22: 'Public', 23: 'College', 24: 'Spanish Talk',
  25: 'Spanish Music', 26: 'Hip-Hop', 29: 'Weather', 30: 'Emergency Test', 31: 'Emergency',
};
export const programTypeName = (t: number | null | undefined) => t === null || t === undefined || t < 0 ? '' : PROGRAM_TYPES[t] ?? `Type ${t}`;
/** Data service types named in 1020s and seen on the air. */
export const DATA_TYPES: Record<number, string> = { 66: 'Image maps', 259: 'Navigation' };
export const dataTypeName = (t: number) => DATA_TYPES[t] ?? `Data type ${t}`;

class Votes<T> {
  private readonly m = new Map<string, { v: T; n: number }>();
  add(key: string, v: T): void { const e = this.m.get(key); if (e) e.n++; else this.m.set(key, { v, n: 1 }); }
  best(): { v: T; n: number; total: number } | null {
    let b: { v: T; n: number } | null = null, total = 0;
    for (const e of this.m.values()) { total += e.n; if (!b || e.n > b.n) b = e; }
    return b ? { ...b, total } : null;
  }
  get size(): number { return this.m.size; }
}

export interface SisSummary {
  callsign: string; country: string; facility: number; longName: string; slogan: string; message: string; universal: string;
  lat: number | null; lon: number | null; altM: number | null;
  audio: { program: number; type: number; access: number }[];
  data: { type: number; mime12: number; access: number }[];
  params: Record<number, number>;
  timeLocked: boolean; alfn: number; alfnMs: number; pdus: number; llds: number; alerts: number;
  /** Votes behind the call sign, out of all short-name messages. */
  nameVotes: [number, number];
}

const text = (b: number[], enc: number | undefined) => {
  const t = enc === 4 ? (() => { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s; })() : String.fromCharCode(...b);
  return t.replace(/\0+$/, '').replace(/[\x00-\x08\x0b-\x1f]/g, '');
};

/** Every SIS PDU of a station, majority-voted field by field. */
export class SisVoter {
  pdus = 0; llds = 0; alerts = 0;
  private readonly short = new Votes<string>(); private readonly id = new Votes<[string, number]>();
  private readonly locHi = new Votes<[number, number]>(); private readonly locLo = new Votes<[number, number]>();
  private readonly long = new Map<number, Votes<string>>(); private longLast = new Votes<number>();
  private readonly slogan = new Map<number, Votes<number[]>>(); private sloganLen = new Votes<[number, number]>();
  private readonly usn = new Map<number, Votes<number[]>>(); private usnEnc = new Votes<number>();
  private readonly smsg = new Map<string, Votes<number[]>>(); private readonly smsgHead = new Map<number, Votes<[number, number]>>();
  private readonly svcAudio = new Map<number, Votes<[number, number]>>(); private readonly svcData = new Map<string, { type: number; mime12: number; access: number; n: number }>();
  private readonly params = new Map<number, Votes<number>>();
  private locked = new Votes<number>();
  private alfn = -1; private alfnFrames = 0; private readonly alfnOff = new Votes<number>();

  add(p: SisPdu): void {
    this.pdus++;
    if (p.llds) { this.llds++; return; }
    this.locked.add(String(p.timeLocked), p.timeLocked);
    for (const m of p.msgs) this.addMsg(m);
  }
  /** One frame's ALFN as sent; without a usable CRC single PDU errors show, so the clock is the voted offset
   *  between the frames counted here and the ALFN sent. */
  setAlfn(a: number): void { this.alfnFrames++; this.alfnOff.add(String(a - this.alfnFrames), a - this.alfnFrames); const b = this.alfnOff.best()!; this.alfn = b.v + this.alfnFrames; }
  /** A missed frame: the next ALFN is one further on. */
  skipFrame(): void { this.alfnFrames++; }

  private addMsg(m: SisMsg): void {
    const map = <K, V>(mp: Map<K, Votes<V>>, k: K) => { let v = mp.get(k); if (!v) { v = new Votes<V>(); mp.set(k, v); } return v; };
    switch (m.kind) {
      case 'id': this.id.add(`${m.country}/${m.facility}`, [m.country, m.facility]); break;
      case 'short': this.short.add(m.name, m.name); break;
      case 'long': map(this.long, m.frame).add(m.chars, m.chars); this.longLast.add(String(m.last), m.last); break;
      case 'loc': (m.high ? this.locHi : this.locLo).add(`${m.deg}/${m.alt}`, [m.deg, m.alt]); break;
      case 'smsg':
        map(this.smsg, `${m.seq}/${m.frame}`).add(m.bytes.join(','), m.bytes);
        if (m.frame === 0) map(this.smsgHead, m.seq).add(`${m.length}/${m.encoding}`, [m.length ?? 0, m.encoding ?? 0]);
        break;
      case 'svc':
        if (m.audio) map(this.svcAudio, m.program).add(`${m.progType}/${m.access}`, [m.progType, m.access]);
        else { const k = `${m.dataType}/${m.mime12}`, e = this.svcData.get(k); if (e) e.n++; else this.svcData.set(k, { type: m.dataType, mime12: m.mime12, access: m.access, n: 1 }); }
        break;
      case 'param': map(this.params, m.index).add(String(m.value), m.value); break;
      case 'usn': map(this.usn, m.frame).add(m.bytes.join(','), m.bytes); if (m.frame === 0 && m.encoding !== undefined) this.usnEnc.add(String(m.encoding), m.encoding); break;
      case 'slogan': map(this.slogan, m.frame).add(m.bytes.join(','), m.bytes); if (m.frame === 0) this.sloganLen.add(`${m.length}/${m.encoding}`, [m.length ?? 0, m.encoding ?? 0]); break;
      case 'alert': this.alerts++; break;
    }
  }

  summary(): SisSummary {
    const sn = this.short.best(), id = this.id.best()?.v, hi = this.locHi.best()?.v, lo = this.locLo.best()?.v;
    const join = (mp: Map<number, Votes<number[]>>) => [...mp.keys()].sort((a, b) => a - b).flatMap(k => mp.get(k)!.best()!.v);
    let longName = '';
    if (this.long.size) { const last = this.longLast.best()?.v ?? 7; for (let f = 0; f <= last; f++) longName += this.long.get(f)?.best()?.v ?? ''; }
    let slogan = '';
    if (this.slogan.size) { const [len, enc] = this.sloganLen.best()?.v ?? [0, 0]; const b = join(this.slogan); slogan = text(len ? b.slice(0, enc === 4 ? 2 * len : len) : b, enc); }
    const universal = this.usn.size ? text(join(this.usn), this.usnEnc.best()?.v) : '';
    let message = '';
    const seqs = [...this.smsgHead.keys()];
    if (seqs.length) {
      const seq = seqs.sort((a, b) => (this.smsgHead.get(b)!.best()!.total) - (this.smsgHead.get(a)!.best()!.total))[0];
      const [len, enc] = this.smsgHead.get(seq)!.best()!.v;
      const b: number[] = [];
      for (let f = 0; f < 32; f++) { const v = this.smsg.get(`${seq}/${f}`)?.best()?.v; if (!v) { if (b.length >= len) break; continue; } b.push(...v); }
      message = text(b.slice(0, len), enc);
    }
    const params: Record<number, number> = {};
    for (const [k, v] of this.params) params[k] = v.best()!.v;
    return {
      callsign: sn?.v ?? '', country: id?.[0] ?? '', facility: id?.[1] ?? -1, longName: longName.replace(/\0+$/, '').trim(), slogan: slogan.trim(), message: message.trim(), universal: universal.trim(),
      lat: hi ? hi[0] : null, lon: lo ? lo[0] : null, altM: hi && lo ? ((hi[1] << 4) | lo[1]) * 16 : null,
      audio: [...this.svcAudio.entries()].filter(([, v]) => v.best()!.n >= 3).map(([program, v]) => ({ program, type: v.best()!.v[0], access: v.best()!.v[1] })).sort((a, b) => a.program - b.program),
      data: [...this.svcData.values()].filter(d => d.n >= 3).map(d => ({ type: d.type, mime12: d.mime12, access: d.access })),
      params, timeLocked: this.locked.best()?.v === 1, alfn: this.alfn, alfnMs: this.alfn >= 0 ? alfnToMs(this.alfn) : 0,
      pdus: this.pdus, llds: this.llds, alerts: this.alerts, nameVotes: sn ? [sn.n, sn.total] : [0, 0],
    };
  }
}
