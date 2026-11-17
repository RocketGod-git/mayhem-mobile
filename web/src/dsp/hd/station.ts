/**
 * Everything one HD station sends, built up frame by frame from its L2 PDUs and SIS PDUs: programs and what each is
 * playing (PSD), the fixed and opportunistic data bearers, AAS ports, the service directory, large objects and the
 * voted SIS fields. DOM-free.
 */
import { FixedTracker, HdlcStream, PCI_CONTENT, parseAudioRegion, parseId3, parsePacket, type L2Pdu } from './l2.js';
import { LotAssembler, lotKind, parseSig, parseXhdr, type LotKind, type LotObject, type SigService } from './lot.js';
import { SisVoter, alfnFromPairs, parseSis, programTypeName, type SisPdu, type SisSummary } from './sis.js';

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
}
export interface PortRow { port: number; bearer: string; packets: number; bytes: number; lastMs: number; firstMs: number; seqGaps: number; kind: string; name: string }
export interface ObjectRow { port: number; id: number; name: string; size: number; mime: string; kind: LotKind; ms: number; program: number }
export interface FrameStat { ms: number; pci: number; pciErrors: number; ber: number; snrLoDb: number; snrHiDb: number }

export interface StationSnap {
  frames: number; framesGood: number; lastFrameMs: number; firstFrameMs: number; pci: number; pciName: string;
  ber: number; snrLoDb: number; snrHiDb: number; history: FrameStat[];
  sis: SisSummary; programs: ProgramRow[]; sig: SigService[]; sigVerified: boolean; ports: PortRow[]; objects: ObjectRow[];
  pending: { port: number; id: number; name: string; have: number; need: number }[];
  ccc: { mpl: number; subs: { length: number; parity: number; interleave: number }[] } | null; bbm: number; hdlcGood: number; hdlcBad: number;
}

export class HdStation {
  onObject: (o: LotObject & { kind: LotKind; program: number }) => void = () => {};
  onEvent: (line: string) => void = () => {};
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

  constructor() {
    this.lot.onObject = o => {
      const art = new Set<number>(), logo = new Set<number>();
      this.componentPorts(art, logo);
      const kind = lotKind(o, art, logo);
      const program = this.programOfPort(o.port);
      const row: ObjectRow = { port: o.port, id: o.id, name: o.name, size: o.size, mime: o.mime, kind, ms: o.ms, program };
      this.objects.unshift(row); if (this.objects.length > 200) this.objects.length = 200;
      this.onObject({ ...o, kind, program });
      this.onEvent(`object · port ${hex4(o.port)} · ${o.name || `id ${hex4(o.id)}`} · ${o.size} bytes · ${kind}`);
    };
  }

  /** Ports the service directory names as image components: album art (the PSD's MIME) and logos (the rest). */
  private componentPorts(art: Set<number>, logo: Set<number>): void {
    const artMime = new Set<number>();
    for (const p of this.progs.values()) if (p.artMime) artMime.add(p.artMime);
    for (const s of this.sig) if (s.kind === 'audio') for (const c of s.components) (artMime.has(c.mime) ? art : logo).add(c.port);
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
    this.history.push({ ms: now, pci: pdu.pci, pciErrors: pdu.pciErrors, ber: q.ber, snrLoDb: q.snrLoDb, snrHiDb: q.snrHiDb });
    if (this.history.length > 120) this.history.shift();
    this.lastPci = pdu.pci;
    const adv: number[] = [];
    for (const b of sis) { const p: SisPdu = parseSis(b); this.sisVoter.add(p); adv.push(p.advAlfn); }
    if (adv.length === 16) this.sisVoter.setAlfn(alfnFromPairs(adv));
    if (pdu.pciErrors > 4) return;
    this.l2(pdu, now);
    const cs = this.sisVoter.summary().callsign;
    if (cs && cs !== this.callLogged && this.sisVoter.summary().nameVotes[0] >= 3) { this.callLogged = cs; this.onEvent(`station · ${cs}`); }
  }

  private l2(pdu: L2Pdu, now: number): void {
    const by = pdu.bytes, pci = pdu.pci, withFixed = pci === 2 || pci === 3 || pci === 4;
    let { pdus, end } = parseAudioRegion(by, by.length);
    if (withFixed && this.fixed.ccc) {
      const fs = this.fixed.fixedStart(by.length);
      pdus = pdus.filter(d => d.end < fs); end = pdus.length ? pdus[pdus.length - 1].end + 1 : 0;
    }
    for (const d of pdus) {
      let p = this.progs.get(d.program);
      if (!p) {
        p = { n: d.program, type: -1, typeName: '', codecMode: d.codecMode, kbps: 0, lastMs: now, firstMs: now, title: '', artist: '', album: '', genre: '', comment: '', artId: null, artFlush: false, artMime: 0, songs: [], psdFrames: 0, psdBad: 0 };
        this.progs.set(d.program, p);
        this.onEvent(`program · HD${d.program + 1} · codec mode ${d.codecMode}`);
      }
      p.lastMs = now; p.codecMode = d.codecMode;
      if (d.progType !== null) { p.type = d.progType; p.typeName = programTypeName(d.progType); }
      const kb = (d.end - d.off + 1) * 8 / FRAME_S / 1000; p.kbps = p.kbps ? p.kbps * 0.8 + kb * 0.2 : kb;
      let s = this.psd.get(d.program); if (!s) { s = new HdlcStream(false); this.psd.set(d.program, s); }
      for (const f of s.feed(d.psd)) {
        if (!f.ok) { p.psdBad++; continue; }
        const pk = parsePacket(f.frame);
        if (!pk) continue;
        p.psdFrames++;
        const tag = parseId3(pk.payload);
        if (tag) this.onTag(p, tag, now);
      }
    }
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
      let r = this.ports.get(pk.port);
      if (!r) { r = { port: pk.port, bearer, packets: 0, bytes: 0, lastMs: now, firstMs: now, seqGaps: 0, kind: '', name: '', lastSeq: -1 }; this.ports.set(pk.port, r); }
      if (r.lastSeq >= 0 && ((pk.seq - r.lastSeq) & 0xFFFF) !== 1) r.seqGaps++;
      r.lastSeq = pk.seq; r.packets++; r.bytes += pk.payload.length; r.lastMs = now;
      if (pk.port === SIG_PORT) { const s2 = parseSig(pk.payload); if (s2.length) { this.sig = s2; this.sigSeen++; } r.kind = 'directory'; continue; }
      this.lot.add(pk.port, pk.payload);
    }
  }

  private onTag(p: ProgramRow, tag: ReturnType<typeof parseId3> & object, now: number): void {
    let title = '', artist = '', album = '', genre = '', comment = '';
    for (const f of tag) {
      if (f.id === 'TIT2') title = f.text ?? ''; else if (f.id === 'TPE1') artist = f.text ?? ''; else if (f.id === 'TALB') album = f.text ?? '';
      else if (f.id === 'TCON') genre = f.text ?? ''; else if (f.id === 'COMM') comment = f.text ?? '';
      else if (f.id === 'XHDR') { const x = parseXhdr(f.bytes); if (x) { p.artMime = x.mime; p.artId = x.objectId; p.artFlush = x.flush && x.objectId === null; } }
    }
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
    for (const a of sis.audio) if (!this.progs.has(a.program)) programs.push({ n: a.program, type: a.type, typeName: programTypeName(a.type), codecMode: -1, kbps: 0, lastMs: 0, firstMs: 0, title: '', artist: '', album: '', genre: '', comment: '', artId: null, artFlush: false, artMime: 0, songs: [], psdFrames: 0, psdBad: 0 });
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
    };
  }

  /** A missed frame breaks the byte streams: drop the partial frames. */
  gap(): void { for (const s of [...this.subs, this.opp, ...this.psd.values()]) s?.clear(); }
}

const hex4 = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
function find(by: Uint8Array, pat: number[], from: number, to: number): number {
  outer: for (let i = Math.max(0, from); i + pat.length <= to; i++) { for (let j = 0; j < pat.length; j++) if (by[i + j] !== pat[j]) continue outer; return i; }
  return -1;
}
