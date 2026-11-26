/**
 * Everything one HD station sends, built up frame by frame from its L2 PDUs and SIS PDUs: programs and what each is
 * playing (PSD), the fixed and opportunistic data bearers, AAS ports, the service directory, large objects and the
 * voted SIS fields. DOM-free.
 */
import { FixedTracker, HdlcStream, PCI_CONTENT, parseAudioRegion, parseId3, parsePacket, type AudioPdu, type L2Pdu } from './l2.js';
import { LotAssembler, inspectFile, lotKind, parseSig, parseXhdr, scanEmbedded, type Embedded, type Inspect, type LotKind, type LotObject, type SigService } from './lot.js';
import { SisVoter, alfnFromPairs, dataTypeName, mimeName, parseSis, programTypeName, type SisPdu, type SisSummary } from './sis.js';
import { PortInventory, hex, type Finding, type PortInfo } from './inventory.js';

const FRAME_S = 65536 / 44100;
const DDL = [0x9D, 0x2F, 0x39, 0x05, 0xD8];
const BBM = [0x7D, 0x3A, 0xE2, 0x42];
export const SIG_PORT = 0x0020;

export interface Song { ms: number; title: string; artist: string; album: string; genre: string }
export interface ProgramRow {
  n: number; type: number; typeName: string; codecMode: number; kbps: number; lastMs: number; firstMs: number;
  title: string; artist: string; album: string; genre: string; comment: string;
  /** The object id of this song's image (from XHDR), or null; `artFlush` when the station says there is none. */
  artId: number | null; artFlush: boolean; artMime: number;
  songs: Song[]; psdFrames: number; psdBad: number;
  /** Every ID3 frame of the newest tag, decoded where 1028s defines it, else as hex. */
  id3: Id3Row[];
  /** The newest commercial (COMR) and unique file id (UFID) the station sent with a song. */
  commercial: { price: string; validUntil: string; url: string; receivedAs: number; seller: string; description: string } | null; ufid: { owner: string; id: string } | null;
  /** PSD packets that were not ID3 tags, and the ports PSD came on. */
  psdOther: number; psdOtherHex: string; psdPorts: number[];
}
export interface Id3Row { id: string; text: string; desc: string; lang: string; size: number; hex: string; known: boolean }
export interface PortRow { port: number; bearer: string; packets: number; bytes: number; lastMs: number; firstMs: number; seqGaps: number; kind: string; name: string }
export interface ObjectRow {
  port: number; id: number; name: string; size: number; mime: string; kind: LotKind; ms: number; program: number;
  /** The LOT header's MIME hash (and its name), expiry and version; what the file holds beyond its picture. */
  mimeHash: number; mimeName: string; expires: string; version: number; width?: number; height?: number;
  text: { key: string; value: string }[]; embedded: Embedded[]; trailing: number; chunks: string[];
  /** For a carved object: where it came from. */
  from: string;
}
/** One L1 frame: PCI, raw bit error rate before the FEC, sideband SNR, and the HDLC frames (PSD and data) that passed
 *  and failed their FCS in it. */
export interface FrameStat { ms: number; pci: number; pciErrors: number; ber: number; snrLoDb: number; snrHiDb: number; fcsGood: number; fcsBad: number }

export interface StationSnap {
  frames: number; framesGood: number; lastFrameMs: number; firstFrameMs: number; pci: number; pciName: string;
  ber: number; snrLoDb: number; snrHiDb: number; history: FrameStat[];
  sis: SisSummary; programs: ProgramRow[]; sig: SigService[]; sigVerified: boolean; ports: PortRow[]; objects: ObjectRow[];
  pending: { port: number; id: number; name: string; have: number; need: number }[];
  ccc: { mpl: number; subs: { length: number; parity: number; interleave: number }[] } | null; bbm: number; hdlcGood: number; hdlcBad: number;
  /** The MPS blend control (1017s Table 5-4), voted over the last frames; -1 before any. */
  blend: number;
  /** P3 and P4 transfer frames (modes MP2, MP3, MP11): received, with a clean header, and the channel bit error rate. */
  p3: { frames: number; good: number; ber: number };
  /** Every port as it looks on the air, the things found that nothing announced, and what is still not understood. */
  portInfo: PortInfo[]; findings: Finding[]; unknowns: { where: string; what: string }[];
}

export class HdStation {
  onObject: (o: LotObject & { kind: LotKind; program: number }) => void = () => {};
  onEvent: (line: string) => void = () => {};
  /** Each frame's audio PDUs and the L2 PDU bytes they are in. */
  onAudio: (by: Uint8Array, pdus: AudioPdu[]) => void = () => {};
  private readonly fixed = new FixedTracker();
  private readonly subs: HdlcStream[] = [];
  private readonly opp = new HdlcStream(true);
  private readonly psd = new Map<number, HdlcStream>();
  private readonly progs = new Map<number, ProgramRow>();
  private readonly ports = new Map<number, PortRow & { lastSeq: number }>();
  private readonly lot = new LotAssembler();
  private readonly sisVoter = new SisVoter();
  private sig: SigService[] = []; private sigSeen = 0;
  private readonly objects: ObjectRow[] = [];
  private readonly history: FrameStat[] = [];
  private frames = 0; private framesGood = 0; private lastFrameMs = 0; private firstFrameMs = 0; private lastPci = -1;
  private lastTitle = new Map<number, string>(); private callLogged = '';
  private readonly inv = new PortInventory();
  private readonly p3 = { frames: 0, good: 0, ber: 0 };
  private carvedSeq = 0; private apicSeen = new Set<string>(); private cccFrames = 0;

  constructor() {
    this.lot.onObject = o => {
      const art = new Set<number>(), logo = new Set<number>();
      this.componentPorts(art, logo);
      const kind = lotKind(o, art, logo);
      const program = this.programOfPort(o.port);
      this.addObject({ ...o, kind, program }, inspectFile(o.bytes, o.mime), '');
    };
    this.inv.onCarved = (port, e, bytes) => this.carved(port, e, bytes, `port ${hex4(port)} stream @${e.offset}`);
  }

  private addObject(o: LotObject & { kind: LotKind; program: number }, ins: Inspect, from: string): void {
    const row: ObjectRow = {
      port: o.port, id: o.id, name: o.name, size: o.size, mime: o.mime, kind: o.kind, ms: o.ms, program: o.program,
      mimeHash: o.mimeHash, mimeName: mimeName(o.mimeHash), expires: o.expires, version: o.version, width: ins.width, height: ins.height,
      text: ins.text, embedded: ins.embedded, trailing: ins.trailing, chunks: ins.chunks, from,
    };
    this.objects.unshift(row); if (this.objects.length > 200) this.objects.length = 200;
    this.onObject(o);
    this.onEvent(`object · port ${hex4(o.port)} · ${o.name || `id ${hex4(o.id)}`} · ${o.size} bytes · ${o.kind}`);
    const where = `${o.name || `object ${hex4(o.id)}`} (port ${hex4(o.port)})`;
    for (const t of ins.text) this.inv.note({ where, port: o.port, type: 'text', offset: 0, length: t.value.length, complete: true, note: `${t.key}: ${t.value.slice(0, 200)}`, ms: o.ms });
    if (ins.trailing > 0) this.inv.note({ where, port: o.port, type: 'trailing bytes', offset: o.size - ins.trailing, length: ins.trailing, complete: true, note: `${ins.trailing} bytes after the image's end marker: ${hex(o.bytes.subarray(o.size - ins.trailing, o.size - ins.trailing + 24))}`, ms: o.ms });
    for (const e of ins.embedded) {
      this.inv.note({ where, port: o.port, type: e.type, offset: e.offset, length: e.length, width: e.width, height: e.height, complete: e.complete, note: e.complete ? 'an image inside the file, cut out' : 'an image start inside the file, cut short', ms: o.ms });
      if (e.complete && !from) this.carved(o.port, e, o.bytes.slice(e.offset, e.offset + e.length), `inside ${o.name || hex4(o.id)} @${e.offset}`);
    }
  }
  /** An image cut out of a stream, a file or a PSD frame, reported as an object of its own. */
  private carved(port: number, e: Embedded, bytes: Uint8Array, from: string): void {
    const id = 0x10000 + (this.carvedSeq++ & 0xFFFF), ext = e.type.split('/')[1] ?? 'bin';
    const o = { port, id, name: `carved_${hex4(port).slice(2)}_${this.carvedSeq}.${ext === 'jpeg' ? 'jpg' : ext}`, size: bytes.length, bytes, mime: e.type, ms: Date.now(), version: 0, mimeHash: 0, expires: '', kind: 'carved' as LotKind, program: this.programOfPort(port) };
    this.addObject(o, inspectFile(bytes, e.type), from);
  }
  /** A port's transport by the directory: 0 stream, 1 packet, 3 LOT, -1 not listed. */
  private aasType(port: number): number {
    for (const s of this.sig) for (const c of s.components) if (c.port === port) return c.aasType;
    return -1;
  }
  /** The ports the directory lists as stream or packet services (no LOT framing on them). */
  private notLot(port: number): boolean { const t = this.aasType(port); return t === 0 || t === 1; }

  /** Ports the service directory names as image components: album art (the PSD's MIME) and logos (the rest). */
  private componentPorts(art: Set<number>, logo: Set<number>): void {
    const artMime = new Set<number>();
    for (const p of this.progs.values()) if (p.artMime) artMime.add(p.artMime);
    for (const s of this.sig) if (s.kind === 'audio') for (const c of s.components) (artMime.has(c.mime) || /album art/.test(c.mimeName) ? art : logo).add(c.port);
  }
  /** The audio program a port belongs to by the directory, or -1. */
  private programOfPort(port: number): number {
    for (const s of this.sig) if (s.kind === 'audio' && s.components.some(c => c.port === port)) return s.program;
    return -1;
  }

  /** One decoded L1 frame: the L2 PDU from P1, the 16 SIS PDUs (L2 bit order) and the frame's quality. */
  addFrame(pdu: L2Pdu, sis: Uint8Array[], q: { ber: number; snrLoDb: number; snrHiDb: number }): void {
    const now = Date.now();
    this.frames++; this.lastFrameMs = now; if (!this.firstFrameMs) this.firstFrameMs = now;
    if (pdu.pciErrors <= 2) this.framesGood++;
    const stat: FrameStat = { ms: now, pci: pdu.pci, pciErrors: pdu.pciErrors, ber: q.ber, snrLoDb: q.snrLoDb, snrHiDb: q.snrHiDb, fcsGood: 0, fcsBad: 0 };
    this.history.push(stat);
    if (this.history.length > 120) this.history.shift();
    this.lastPci = pdu.pci;
    const adv: number[] = [];
    let allOk = sis.length === 16;
    for (const b of sis) { const p: SisPdu = parseSis(b); this.sisVoter.add(p); adv.push(p.advAlfn); allOk &&= p.crcOk; }
    if (allOk) this.sisVoter.setAlfn(alfnFromPairs(adv), now); else if (this.frames > 1) this.sisVoter.skipFrame();
    if (pdu.pciErrors > 4) return;
    const [g0, b0] = this.fcsCounts();
    this.l2(pdu, now);
    const [g1, b1] = this.fcsCounts(); stat.fcsGood = g1 - g0; stat.fcsBad = b1 - b0;
    const cs = this.sisVoter.summary().callsign;
    if (cs && cs !== this.callLogged && this.sisVoter.summary().nameVotes[0] >= 3) { this.callLogged = cs; this.onEvent(`station · ${cs}`); }
  }

  /** A P3 or P4 transfer frame (modes MP2, MP3, MP11): its audio and program data. */
  addP3(pdu: L2Pdu, ber: number): void {
    this.p3.frames++; this.p3.ber = this.p3.frames > 1 ? this.p3.ber * 0.9 + ber * 0.1 : ber;
    if (pdu.pciErrors > 4) return;
    this.p3.good++;
    this.l2(pdu, Date.now(), true);
  }

  private l2(pdu: L2Pdu, now: number, p3 = false): void {
    const by = pdu.bytes, pci = pdu.pci, withFixed = !p3 && (pci === 2 || pci === 3 || pci === 4);
    let { pdus, end } = parseAudioRegion(by, by.length);
    if (withFixed && this.fixed.ccc) {
      const fs = this.fixed.fixedStart(by.length);
      pdus = pdus.filter(d => d.end < fs); end = pdus.length ? pdus[pdus.length - 1].end + 1 : 0;
    }
    this.onAudio(by, pdus);
    for (const d of pdus) {
      let p = this.progs.get(d.program);
      if (!p) {
        p = newProgram(d.program, now); p.codecMode = d.codecMode;
        this.progs.set(d.program, p);
        this.onEvent(`program · HD${d.program + 1} · codec mode ${d.codecMode}`);
      }
      p.lastMs = now; p.codecMode = d.codecMode;
      if (d.program === 0) { this.blends.push(d.blend); if (this.blends.length > 8) this.blends.shift(); }
      if (d.progType !== null) { p.type = d.progType; p.typeName = programTypeName(d.progType); }
      const kb = (d.end - d.off + 1) * 8 / (p3 ? FRAME_S / 8 : FRAME_S) / 1000; p.kbps = p.kbps ? p.kbps * 0.8 + kb * 0.2 : kb;
      let s = this.psd.get(d.program); if (!s) { s = new HdlcStream(false); this.psd.set(d.program, s); }
      for (const f of s.feed(d.psd)) {
        if (!f.ok) { p.psdBad++; continue; }
        const pk = parsePacket(f.frame);
        if (!pk) continue;
        p.psdFrames++;
        if (!p.psdPorts.includes(pk.port)) p.psdPorts.push(pk.port);
        const tag = parseId3(pk.payload);
        if (tag) this.onTag(p, tag, now);
        else { p.psdOther++; p.psdOtherHex = hex(pk.payload.subarray(0, 48)); for (const e of scanEmbedded(pk.payload, 0, 4)) if (e.complete) this.carved(pk.port, e, pk.payload.slice(e.offset, e.offset + e.length), `HD${p.n + 1} PSD`); }
      }
    }
    if (p3) return;
    if (withFixed) {
      const { segs, start } = this.fixed.split(by, end);
      segs.forEach((seg, i) => { this.subs[i] ??= new HdlcStream(true); this.feedBearer(this.subs[i], seg, `fixed ${i}`, now); });
      if (pci === 3) this.opportunistic(by, end, start, now);
    } else if (pci === 1) this.opportunistic(by, end, by.length, now);
  }

  /** 1019s 7.4: after the DDL, RS(255,223) codewords each behind a block boundary marker; the systematic bytes. */
  private opportunistic(by: Uint8Array, from: number, to: number, now: number): void {
    const k = find(by, DDL, from, to); if (k < 0) return;
    const data: number[] = [];
    let q = k + 5;
    for (;;) { const j = find(by, BBM, q, to); if (j < 0) break; for (let i = j + 4; i < Math.min(to, j + 4 + 223); i++) data.push(by[i]); q = j + 4 + 255; }
    this.feedBearer(this.opp, Uint8Array.from(data), 'opportunistic', now);
  }

  private feedBearer(s: HdlcStream, seg: Uint8Array, bearer: string, now: number): void {
    for (const f of s.feed(seg)) {
      if (!f.ok) continue;
      const pk = parsePacket(f.frame); if (!pk) continue;
      // the fixed bearer's CCC (1019s 7.5) is HDLC framed too: it reads as port 0 with a zero DTPF
      if (pk.dtpf === 0 && pk.port === 0) { this.cccFrames++; continue; }
      let r = this.ports.get(pk.port);
      if (!r) { r = { port: pk.port, bearer, packets: 0, bytes: 0, lastMs: now, firstMs: now, seqGaps: 0, kind: '', name: '', lastSeq: -1 }; this.ports.set(pk.port, r); }
      if (r.lastSeq >= 0 && ((pk.seq - r.lastSeq) & 0xFFFF) !== 1) r.seqGaps++;
      r.lastSeq = pk.seq; r.packets++; r.bytes += pk.payload.length; r.lastMs = now;
      this.inv.add(pk.port, pk.dtpf, pk.seq, pk.payload, this.aasType(pk.port));
      if (pk.port === SIG_PORT) { const s2 = parseSig(pk.payload); if (s2.length) { this.sig = s2; this.sigSeen++; } r.kind = 'directory'; continue; }
      if (!this.notLot(pk.port)) this.lot.add(pk.port, pk.payload);
    }
  }

  private onTag(p: ProgramRow, tag: ReturnType<typeof parseId3> & object, now: number): void {
    let title = '', artist = '', album = '', genre = '', comment = '';
    for (const f of tag) {
      if (f.id === 'TIT2') title = f.text ?? ''; else if (f.id === 'TPE1') artist = f.text ?? ''; else if (f.id === 'TALB') album = f.text ?? '';
      else if (f.id === 'TCON') genre = f.text ?? ''; else if (f.id === 'COMM') comment = f.text ?? '';
      else if (f.id === 'XHDR') { const x = parseXhdr(f.bytes); if (x) { p.artMime = x.mime; p.artId = x.objectId; p.artFlush = x.flush && x.objectId === null; } }
      else if (f.id === 'COMR' && f.commercial) { const { logo: _l, logoMime: _m, ...c } = f.commercial; p.commercial = c; }
      else if (f.id === 'UFID') p.ufid = { owner: f.desc ?? '', id: f.text || hex(f.data ?? []) };
      const pic = f.id === 'APIC' && f.data?.length ? f.data : f.id === 'COMR' && f.commercial?.logo?.length ? f.commercial.logo : f.id === 'GEOB' && f.data?.length ? f.data : null;
      if (pic) {
        const key = `${p.n}/${pic.length}/${hex(pic.subarray(0, 16))}`;
        if (!this.apicSeen.has(key)) {
          this.apicSeen.add(key);
          const e = scanEmbedded(pic, 0, 1)[0], type = e?.offset === 0 ? e.type : f.mime || f.commercial?.logoMime || 'application/octet-stream';
          this.carved(0x5100 + p.n, { type, offset: 0, length: pic.length, complete: true, width: e?.width, height: e?.height }, pic.slice(), `HD${p.n + 1} PSD ${f.id}${f.desc ? ` "${f.desc}"` : ''}`);
        }
      }
    }
    p.id3 = tag.map(f => ({ id: f.id, text: f.text ?? '', desc: f.desc ?? '', lang: f.lang ?? '', size: f.bytes.length, hex: hex(f.bytes.subarray(0, 64)), known: KNOWN_ID3.test(f.id) }));
    p.title = title; p.artist = artist; p.album = album; p.genre = genre; p.comment = comment;
    const key = `${title}\u0001${artist}`;
    if (title && this.lastTitle.get(p.n) !== key) {
      this.lastTitle.set(p.n, key);
      p.songs.unshift({ ms: now, title, artist, album, genre }); if (p.songs.length > 50) p.songs.length = 50;
      this.onEvent(`HD${p.n + 1} · ${title}${artist ? ` · ${artist}` : ''}${album ? ` · ${album}` : ''}`);
    }
  }

  snapshot(): StationSnap {
    const last = this.history[this.history.length - 1];
    const sis = this.sisVoter.summary();
    const programs = [...this.progs.values()].sort((a, b) => a.n - b.n);
    for (const p of programs) if (p.type < 0) { const a = sis.audio.find(x => x.program === p.n); if (a) { p.type = a.type; p.typeName = programTypeName(a.type); } }
    for (const a of sis.audio) if (!this.progs.has(a.program)) { const q = newProgram(a.program, 0); q.lastMs = 0; q.firstMs = 0; q.type = a.type; q.typeName = programTypeName(a.type); programs.push(q); }
    programs.sort((a, b) => a.n - b.n);
    const ports = [...this.ports.values()].map(({ lastSeq: _l, ...r }) => {
      const comp = this.sig.flatMap(s => s.components.map(c => ({ s, c }))).find(x => x.c.port === r.port);
      return { ...r, name: comp ? comp.s.name : r.name, kind: r.kind || (comp ? (comp.s.kind === 'audio' ? `HD${comp.s.program + 1}` : 'data') : '') };
    }).sort((a, b) => a.port - b.port);
    const subs = this.subs.filter(Boolean);
    return {
      frames: this.frames, framesGood: this.framesGood, lastFrameMs: this.lastFrameMs, firstFrameMs: this.firstFrameMs,
      pci: this.lastPci, pciName: this.lastPci >= 0 ? PCI_CONTENT[this.lastPci] : '',
      ber: last?.ber ?? 1, snrLoDb: last?.snrLoDb ?? -99, snrHiDb: last?.snrHiDb ?? -99, history: this.history.slice(-60),
      sis, programs: programs.map(p => ({ ...p, songs: p.songs.slice(0, 20) })), sig: this.sig, sigVerified: false, ports, objects: this.objects.slice(0, 120), pending: this.lot.pending().slice(0, 40),
      ccc: this.fixed.ccc ? { mpl: this.fixed.ccc.mpl, subs: this.fixed.ccc.subs } : null,
      bbm: subs.reduce((a, s) => a + s.bbm, 0) + this.opp.bbm, hdlcGood: subs.reduce((a, s) => a + s.good, 0) + this.opp.good, hdlcBad: subs.reduce((a, s) => a + s.bad, 0) + this.opp.bad,
      blend: this.blend(),
      p3: { ...this.p3 }, portInfo: this.inv.info(this.lotPorts()), findings: this.inv.findings.slice(0, 80), unknowns: this.unknowns(sis, ports),
    };
  }

  /** Ports that carry objects: the directory says LOT, or an object came or is coming on them. */
  private lotPorts(): Set<number> {
    const s = new Set<number>();
    for (const v of this.sig) for (const c of v.components) if (c.aasType === 3) s.add(c.port);
    for (const o of this.objects) if (!o.from) s.add(o.port);
    for (const p of this.lot.pending()) s.add(p.port);
    return s;
  }
  /** What the station sends that is not decoded, each with what could be told about it. */
  private unknowns(sis: SisSummary, ports: PortRow[]): { where: string; what: string }[] {
    const out: { where: string; what: string }[] = [];
    const lot = this.lotPorts();
    for (const pi of this.inv.info(lot)) {
      if (pi.port === SIG_PORT || pi.content === 'LOT objects' || pi.content === 'images') continue;
      const comp = this.sig.flatMap(s => s.components.map(c => ({ s, c }))).find(x => x.c.port === pi.port);
      const named = comp ? `${comp.s.name || 'unnamed service'} · ${comp.c.mimeName || `MIME ${comp.c.mimeHex}`} · ${comp.c.aasTypeName} · ${dataTypeName(comp.c.dataType)}` : 'not in the service directory';
      const t = pi.tpeg;
      const body = t && t.frames ? `TPEG transport frames (${t.frames}, header CRC verified; frame types ${Object.entries(t.frameTypes).map(([k, n]) => `${k}${k === '1' ? '' : ' (not a TPEG type)'} ×${n}`).join(', ')}${t.services.length ? `; service ${t.services.map(s => `${s.text || s.sid} with encryption indicator ${s.encId === 0 ? '0 (clear)' : `0x${s.encId.toString(16)}`}`).join(', ')}` : ''}): the service frame contents are scrambled (a subscription service), so they are not decoded`
        : `${pi.content}, ${pi.entropy} bits/byte, ${pi.minLen}..${pi.maxLen} B packets, starts ${pi.firstHex.slice(0, 24)}`;
      out.push({ where: `port ${hex4(pi.port)} (${ports.find(r => r.port === pi.port)?.bearer ?? ''})`, what: `${named}: ${body}` });
    }
    for (const s of this.sig) for (const e of s.extra) if (e.tag !== 0x66 && !e.text) out.push({ where: `service directory ${s.name || s.id}`, what: `tag 0x${e.tag.toString(16)}: ${e.hex}${e.text ? ` (${e.text})` : ''}` });
    for (const s of this.sig) for (const c of s.components) if (!ports.some(r => r.port === c.port)) out.push({ where: `port ${hex4(c.port)}`, what: `listed in the directory (${s.name || s.id} · ${c.mimeName || `MIME ${c.mimeHex}`} · ${c.aasTypeName}) but nothing heard on it yet` });
    for (const o of sis.other) out.push({ where: `SIS message ${o.id}`, what: `${o.n} PDUs with a message id the standard reserves: ${o.bits}` });
    if (sis.llds) out.push({ where: 'SIS LLDS', what: `${sis.llds} low latency data PDUs (${sis.lldsDistinct} distinct), not in the documents: ${sis.lldsLast}` });
    if (sis.alertsBad) out.push({ where: 'SIS emergency alert', what: `${sis.alertsBad} alerts whose CRC failed` });
    for (const p of this.progs.values()) {
      if (p.psdOther) out.push({ where: `HD${p.n + 1} PSD`, what: `${p.psdOther} packets that are not ID3: ${p.psdOtherHex}` });
      for (const f of p.id3) if (!f.known) out.push({ where: `HD${p.n + 1} ID3 ${f.id}`, what: `${f.size} bytes: ${f.hex}` });
    }
    if (this.fixed.ccc?.subs.some(s => s.parity || s.interleave)) out.push({ where: 'fixed data', what: `sub-channels with RS parity or interleaving (${JSON.stringify(this.fixed.ccc.subs)}), not undone` });
    return out;
  }

  private readonly blends: number[] = [];
  /** HDLC frames so far that passed and failed their FCS, every stream. */
  private fcsCounts(): [number, number] {
    let g = 0, b = 0;
    for (const s of [...this.subs, this.opp, ...this.psd.values()]) if (s) { g += s.good; b += s.bad; }
    return [g, b];
  }
  private blend(): number {
    const c = [0, 0, 0, 0]; for (const b of this.blends) c[b & 3]++;
    return this.blends.length ? c.indexOf(Math.max(...c)) : -1;
  }

  /** A missed frame breaks the byte streams: drop the partial frames. */
  gap(): void { for (const s of [...this.subs, this.opp, ...this.psd.values()]) s?.clear(); }
}

const hex4 = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
/** ID3 frames 1028s gives a meaning to, and the ones every tag reader knows. */
const KNOWN_ID3 = /^(T[A-Z0-9]{3}|COMM|COMR|UFID|XHDR|APIC|GEOB|PRIV|USLT|W[A-Z0-9]{3})$/;
function newProgram(n: number, now: number): ProgramRow {
  return { n, type: -1, typeName: '', codecMode: -1, kbps: 0, lastMs: now, firstMs: now, title: '', artist: '', album: '', genre: '', comment: '', artId: null, artFlush: false, artMime: 0, songs: [], psdFrames: 0, psdBad: 0, id3: [], commercial: null, ufid: null, psdOther: 0, psdOtherHex: '', psdPorts: [] };
}
function find(by: Uint8Array, pat: number[], from: number, to: number): number {
  outer: for (let i = Math.max(0, from); i + pat.length <= to; i++) { for (let j = 0; j < pat.length; j++) if (by[i + j] !== pat[j]) continue outer; return i; }
  return -1;
}
