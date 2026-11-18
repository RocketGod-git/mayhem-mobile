/**
 * ATSC 1.0 TV: finds stations by their pilot, and with the whole 6 MHz channel in the span (8 MS/s or more) decodes
 * bursts of it to the transport stream: PSIP (channels, guide, station time), the PMTs and stills from the MPEG-2
 * intra pictures. Bursts go to a pool of workers when there is one; what the CPU cannot take is skipped and counted.
 */
import type { Emit, IqProcessor } from '../core.js';
import { findPilot, type BurstState, type PilotInfo, SR } from './vsb.js';
import { decodeBurst, type BurstOut } from './burst.js';
import { TsDemux, TS_BPS } from './ts.js';
import { crc32, parsePat, parsePmt, parseMgt, parseVct, parseStt, parseEit, parseEtt, parseRrt, gpsToUnixMs, tableTypeName, ratingText, STREAM_TYPES, isVideo,
  type Pat, type Pmt, type Mgt, type Vct, type VChannel, type Rrt, type Descriptors } from './psip.js';
import { StillDecoder, type Still, type SeqInfo } from './mpeg2.js';
import type { AtscPool } from './pool.js';

import { CHANNELS, centerOf, pilotOf, channelAt } from './channels.js';
export { CHANNELS, centerOf, pilotOf, channelAt };

const FIELD_MS = 313 * 832 / SR * 1000;
/** Fields per burst: long enough to hold whole intra pictures of the smaller subchannels. */
const BURST_FIELDS = 14;
const STILL_EVERY_MS = 8_000;

export interface EventRec { sourceId: number; eventId: number; startMs: number; seconds: number; title: string; text: string; rating: string; captions: string; table: number; seenMs: number }
export interface StreamRow { pid: number; type: number; typeName: string; lang: string; info: string; kbps: number; share: number; captions: string }
export interface SubRow {
  key: string; major: number; minor: number; name: string; longName: string; program: number; sourceId: number; serviceType: number;
  hidden: boolean; hideGuide: boolean; access: boolean; streams: StreamRow[]; video: string; stillMs: number; stillComplete: boolean; stillMbs: number;
  now: EventRec | null; next: EventRec | null; events: number;
}
export interface PidRow { pid: number; role: string; packets: number; kbps: number; share: number; ccErrors: number; scrambled: number; pcrs: number; pcrIntervalMs: number; pcrPpm: number }
export interface StationRow {
  key: string; ch: number; band: string; centerHz: number; tsid: number; firstMs: number; lastMs: number;
  pilotDb: number; pilotHz: number; topDb: number; pilotMs: number; pilotOk: boolean; syncMs: number;
  snrDb: number; sliceSnrDb: number; snrMs: number; rs: { ok: number; corrected: number; failed: number; bytes: number };
  fields: number; airFields: number; packets: number; badPackets: number; decodedMs: number;
  subs: SubRow[]; tables: string[]; stt: { utcMs: number; offset: number; ds: boolean; diffMs: number; atMs: number } | null;
  hasVct: boolean; hasEit: boolean; tvName: string; events: number;
}
export interface LiveSignal {
  ch: number; centerHz: number; ms: number; ok: boolean; reason: string; pilot: PilotInfo | null; snrDb: number; sliceSnrDb: number; segPeak: number; syncs: number;
  hist: number[]; eye: number[]; echo: number[]; dfe: number[]; ffe: number[]; eps: number; cpuMs: number; fields: number;
  rs: { ok: number; corrected: number; failed: number; bytes: number }; snrHistory: number[]; rsHistory: number[]; pids: PidRow[];
}
export interface AtscSnap {
  type: 'atsc'; capability: 'decode' | 'pilot'; rate: number; centerHz: number; ch: number; workers: number; busy: number;
  decodedPct: number; cpuPct: number; bursts: number; stations: StationRow[]; live: LiveSignal | null;
  here: { ch: number; pilotOk: boolean; sync: boolean; pilotDb: number; pilotHz: number; topDb: number; snrDb: number; tsid: number; since: number; vct: boolean; stills: number; videoSubs: number; eit: boolean; bursts: number } | null;
}
export interface AtscLogRow { ms: number; ch: number; kind: string; text: string }

interface Station {
  key: string; ch: number; centerHz: number; tsid: number; firstMs: number; lastMs: number;
  pilotDb: number; pilotHz: number; topDb: number; pilotMs: number;
  /** The pilot met the 8VSB rule (a plateau over the floor, the pilot at its level over it); segment sync was seen. */
  pilotOk: boolean; syncMs: number;
  /** SNR of the last burst that decoded fields with most packets correctable (snrMs 0: none yet). */
  snrDb: number; sliceSnrDb: number; snrMs: number; rs: { ok: number; corrected: number; failed: number; bytes: number };
  fields: number; airFields: number; packets: number; badPackets: number;
  pat: Pat | null; pmts: Record<number, Pmt>; vct: Vct | null; mgt: Mgt | null; rrt: Rrt | null;
  stt: { utcMs: number; offset: number; ds: boolean; diffMs: number; atMs: number } | null;
  events: Record<string, EventRec>; etts: Record<string, string>; chanEtt: Record<number, string>;
  raw: Record<string, string>; pidStats: Record<number, { packets: number; ccErrors: number; scrambled: number; pcrs: number; pcrIntervalMs: number; pcrPpm: number }>;
  video: Record<number, { seq: SeqInfo | null; gop: string; pictures: number; iPictures: number }>;
  stills: Record<number, { ms: number; complete: boolean; mbs: number; w: number; h: number; dar: number }>;
}
export interface AtscState { v: 1; stations: Station[]; log: AtscLogRow[] }

const hex = (b: Uint8Array) => { let s = ''; for (const v of b) s += v.toString(16).padStart(2, '0'); return s; };
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

export class AtscProcessor implements IqProcessor {
  centerHz = 0;
  now: () => number = () => Date.now();
  /** Live radio: bursts are captured only when a decoder is free. Off for recordings and tests: every burst. */
  realtime = true;
  pool: AtscPool | null = null;
  readonly stations = new Map<string, Station>();
  readonly log: AtscLogRow[] = [];
  version = 0;
  /** Each decoded intra picture as a still (for the page to keep). */
  onStill: ((key: string, s: Still) => void) | null = null;

  private rate = 0; private lastCenter = NaN; private ch = 0;
  private readonly demux = new TsDemux();
  private stills = new Map<number, StillDecoder>();
  private cap: Int8Array | null = null; private capN = 0; private capLen = 0; private capturing = false;
  private inFlight = 0; private bursts = 0;
  private st: BurstState = { eps: 0, pilotHz: 0 };
  private live: LiveSignal | null = null;
  private snrHistory: number[] = []; private rsHistory: number[] = [];
  private airSamples = 0; private decodedSamples = 0; private cpuMs = 0; private wallStart = 0;
  private pilotAcc = 0; private pilotRe = new Float32Array(32768); private pilotIm = new Float32Array(32768); private pilotN = 0;
  private hereSince = 0; private hereBursts = 0; private settle = 0;
  private lastPost = 0; private dirty = false;

  constructor(private readonly emit: Emit | null) {
    this.demux.onSection = (pid, s) => this.section(pid, s);
    this.demux.onPes = (pid, es, holes) => this.pes(pid, es, holes);
  }

  reset(rate: number): void { this.rate = rate; this.capN = 0; this.capturing = false; this.demux.gap(); this.st = { eps: this.st.eps, pilotHz: 0 }; this.allocCap(); this.post(true); }
  private allocCap(): void {
    if (this.rate < 6_400_000) { this.cap = null; this.capLen = 0; return; }
    this.capLen = Math.round(this.rate * FIELD_MS / 1000 * (BURST_FIELDS + 1.2));
    if (!this.realtime || !this.pool) this.cap = new Int8Array(2 * this.capLen);
  }
  get capability(): 'decode' | 'pilot' { return this.rate >= 6_400_000 ? 'decode' : 'pilot'; }

  private station(): Station | null {
    if (!this.ch) return null;
    const key = `ch${this.ch}`;
    let s = this.stations.get(key);
    if (!s) {
      const now = this.now();
      s = { key, ch: this.ch, centerHz: centerOf(this.ch), tsid: -1, firstMs: now, lastMs: now, pilotDb: 0, pilotHz: 0, topDb: NaN, pilotMs: 0, pilotOk: false, syncMs: 0, snrDb: NaN, sliceSnrDb: NaN, snrMs: 0,
        rs: { ok: 0, corrected: 0, failed: 0, bytes: 0 }, fields: 0, airFields: 0, packets: 0, badPackets: 0, pat: null, pmts: {}, vct: null, mgt: null, rrt: null, stt: null,
        events: {}, etts: {}, chanEtt: {}, raw: {}, pidStats: {}, video: {}, stills: {} };
      this.stations.set(key, s);
    }
    return s;
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    if (this.centerHz !== this.lastCenter) this.retuned();
    let n = iq.length >> 1;
    // samples still in flight from before the retune are not this channel's
    if (this.settle > 0) { const k = Math.min(n, this.settle); this.settle -= k; if (k === n) return; iq = iq.subarray(2 * k); n -= k; }
    // the pilot, from a stretch of every buffer, about twice a second (any radio)
    this.pilotAcc += n;
    if (this.pilotAcc > rate / 4) {
      const take = Math.min(n, this.pilotRe.length - this.pilotN);
      for (let i = 0; i < take; i++) { this.pilotRe[this.pilotN + i] = iq[2 * i]; this.pilotIm[this.pilotN + i] = iq[2 * i + 1]; }
      this.pilotN += take;
      if (this.pilotN >= this.pilotRe.length) { this.pilotAcc = 0; this.pilotN = 0; this.pilotLook(); }
    }
    if (this.capability !== 'decode') return;
    const st = this.station();
    const live = !!st && st.pilotOk && this.now() - st.pilotMs < 3_000;
    if (live) this.airSamples += n;
    // a burst starts only when a decoder can take it, on a channel whose pilot met the 8VSB rule
    if (!this.capturing) {
      if (!st || (this.realtime && !live)) return;
      if (this.realtime && this.pool && (this.pool.free === 0 || this.pool.failed)) return;
      if (this.realtime && !this.pool && this.inFlight) return;
      this.capturing = true; this.capN = 0;
      if (!this.cap || this.cap.length !== 2 * this.capLen) this.cap = new Int8Array(2 * this.capLen);
    }
    const take = Math.min(n, this.capLen - this.capN);
    this.cap!.set(iq.subarray(0, 2 * take), 2 * this.capN);
    this.capN += take;
    if (this.capN >= this.capLen) { this.capturing = false; this.burst(this.cap!); if (this.pool && this.realtime) this.cap = null; }
  }

  private retuned(): void {
    this.lastCenter = this.centerHz;
    const c = channelAt(this.centerHz);
    // decoding needs the channel centered; a narrow radio looks at the pilot wherever it is in the span
    this.ch = c ? c.ch : 0;
    this.capturing = false; this.capN = 0; this.pilotAcc = 0; this.pilotN = 0;
    this.settle = this.realtime ? Math.round(this.rate * 0.3) : 0;
    this.demux.clear(); this.stills = new Map();
    // nothing measured before this visit stands for it
    const s = this.station(); if (s) { s.snrDb = NaN; s.sliceSnrDb = NaN; s.snrMs = 0; s.pilotOk = false; s.pilotDb = 0; }
    this.st = { eps: this.st.eps, pilotHz: 0 };
    this.hereSince = this.now(); this.hereBursts = 0; this.live = null; this.snrHistory = []; this.rsHistory = [];
    this.post(true);
  }

  private pilotLook(): void {
    if (!this.ch) return;
    const expect = pilotOf(this.ch) - this.centerHz;
    if (Math.abs(expect) > this.rate / 2 - 50_000) return;
    const p = findPilot(this.pilotRe, this.pilotIm, this.rate, 30_000, expect);
    const s = this.station(); if (!s) return;
    const now = this.now();
    if (p && p.ok) {
      const first = s.pilotMs === 0;
      s.pilotDb = s.pilotOk && s.pilotDb > 0 ? 0.7 * s.pilotDb + 0.3 * p.db : p.db; s.pilotHz = p.hz; s.topDb = p.topDb; s.pilotMs = now; s.lastMs = now; s.pilotOk = true;
      if (first) this.note('PILOT', `ch ${s.ch} ${(s.centerHz / 1e6).toFixed(0)} MHz · pilot +${p.db.toFixed(1)} dB · ${p.hz >= 0 ? '+' : ''}${p.hz.toFixed(0)} Hz · channel +${p.topDb.toFixed(1)} dB over the floor`);
      this.version++;
    } else { s.pilotOk = false; s.pilotDb = 0; if (p && Number.isFinite(p.topDb)) s.topDb = p.topDb; }
    this.dirty = true; this.post();
  }

  private burst(buf: Int8Array): void {
    const rate = this.rate, ch = this.ch, center = this.centerHz;
    const done = (out: BurstOut | null, st: BurstState | null) => {
      this.inFlight--;
      if (!out || ch !== this.ch || center !== this.centerHz) return;
      if (st) this.st = { eps: st.eps, pilotHz: st.pilotHz };
      this.result(out);
    };
    this.inFlight++; this.bursts++;
    if (this.pool && this.realtime && !this.pool.failed) {
      const p = this.pool.run(buf, rate, { ...this.st });
      if (p) { p.then(r => done(r?.out ?? null, r?.st ?? null)); return; }
    }
    const st = { ...this.st };
    let out: BurstOut | null = null;
    try { out = decodeBurst(buf, rate, st); } catch (e) { this.emit?.({ type: 'log', line: `ATSC: ${(e as Error).message}` }); }
    done(out, st);
  }

  /** Feed a decoded burst (the pool's or inline). */
  private result(r: BurstOut): void {
    const s = this.station(); if (!s) return;
    const now = this.now();
    this.cpuMs += r.cpuMs; this.hereBursts++;
    if (!this.wallStart) this.wallStart = now;
    this.decodedSamples += r.fields * FIELD_MS / 1000 * this.rate;
    s.fields += r.fields; s.airFields = Math.round(this.airSamples / this.rate * 1000 / FIELD_MS);
    if (r.segPeak >= 6 && r.reason !== 'no segment sync' && r.reason !== 'no pilot') s.syncMs = now;
    if (r.ok) {
      const tot = r.rs.ok + r.rs.corrected + r.rs.failed;
      // an SNR measured against decisions that are mostly wrong says nothing: shown only when most packets correct
      if (r.fields > 0 && tot && r.rs.failed / tot < 0.5) { s.snrDb = r.snrDb; s.sliceSnrDb = r.sliceSnrDb; s.snrMs = now; }
      else { s.snrDb = NaN; s.sliceSnrDb = NaN; }
      s.rs.ok += r.rs.ok; s.rs.corrected += r.rs.corrected; s.rs.failed += r.rs.failed; s.rs.bytes += r.rs.bytes;
      this.snrHistory.push(r.snrDb); if (this.snrHistory.length > 60) this.snrHistory.shift();
      this.rsHistory.push(tot ? r.rs.failed / tot : 1); if (this.rsHistory.length > 60) this.rsHistory.shift();
    }
    // the signal view is for a channel with an 8VSB pilot; a burst of noise leaves it empty
    if (r.reason === 'no pilot') this.live = null;
    else this.live = { ch: s.ch, centerHz: s.centerHz, ms: now, ok: r.ok, reason: r.reason, pilot: r.pilot, snrDb: r.snrDb, sliceSnrDb: r.sliceSnrDb, segPeak: r.segPeak, syncs: r.syncs,
      hist: Array.from(r.hist), eye: Array.from(r.eye.subarray(0, 1500), v => Math.round(v * 100) / 100), echo: Array.from(r.echo, v => Math.round(v * 10) / 10), dfe: Array.from(r.dfe, v => Math.round(v * 1e4) / 1e4), ffe: Array.from(r.ffe, v => Math.round(v * 1e4) / 1e4),
      eps: r.eps, cpuMs: r.cpuMs, fields: r.fields, rs: r.rs, snrHistory: this.snrHistory.slice(), rsHistory: this.rsHistory.slice(), pids: [] };
    if (r.ts.length) {
      this.demux.gap();
      this.demux.feed(r.ts);
      this.demux.gap(0);
      s.packets = this.demux.total; s.badPackets = this.demux.bad;
      for (const [pid, p] of this.demux.pids) s.pidStats[pid] = { packets: p.packets, ccErrors: p.ccErrors, scrambled: p.scrambled, pcrs: p.pcrs, pcrIntervalMs: p.pcrIntervalMs, pcrPpm: p.pcrPpm };
    }
    s.lastMs = now;
    this.version++; this.dirty = true; this.post();
  }

  // ---- tables ----
  private section(pid: number, sec: Uint8Array): void {
    if (sec.length < 12 || crc32(sec) !== 0) return;
    const s = this.station(); if (!s) return;
    const tid = sec[0], now = this.now();
    s.raw[`${tid.toString(16)}/${(sec[3] << 8) | sec[4]}/${sec[6]}`] = hex(sec);
    try {
      if (tid === 0x00 && pid === 0) {
        const pat = parsePat(sec);
        if (s.tsid !== pat.tsid) { if (s.tsid >= 0) this.forget(s); s.tsid = pat.tsid; this.note('STATION', `ch ${s.ch} ${(s.centerHz / 1e6).toFixed(0)} MHz · TSID 0x${pat.tsid.toString(16).padStart(4, '0').toUpperCase()} · ${pat.programs.length} program${pat.programs.length === 1 ? '' : 's'}`); }
        s.pat = pat;
        for (const p of pat.programs) this.demux.watchSections(p.pid);
      } else if (tid === 0x02) {
        const pmt = parsePmt(sec), had = s.pmts[pmt.program];
        s.pmts[pmt.program] = pmt;
        for (const es of pmt.streams) if (es.type === 0x02) this.demux.watchPes(es.pid);
        if (!had || had.version !== pmt.version) this.version++;
      } else if (tid === 0xc7) {
        const mgt = parseMgt(sec);
        s.mgt = mgt;
        for (const t of mgt.tables) if ((t.type >= 0x100 && t.type <= 0x17f) || (t.type >= 0x200 && t.type <= 0x27f) || t.type === 4 || (t.type >= 0x301 && t.type <= 0x3ff)) this.demux.watchSections(t.pid);
      } else if (tid === 0xc8 || tid === 0xc9) {
        const v = parseVct(sec);
        const prev = s.vct;
        if (!prev || prev.version !== v.version || v.section === 0) s.vct = { ...v, channels: v.section === 0 || !prev || prev.version !== v.version ? v.channels : [...prev.channels.filter(c => !v.channels.some(x => x.major === c.major && x.minor === c.minor)), ...v.channels] };
        else s.vct = { ...prev, channels: [...prev.channels.filter(c => !v.channels.some(x => x.major === c.major && x.minor === c.minor)), ...v.channels] };
        if (!prev || prev.version !== v.version) for (const c of v.channels) this.note('CHANNEL', `${c.major}.${c.minor} ${c.shortName || '?'} · ch ${s.ch} · program ${c.program}${c.desc.longName ? ` · ${c.desc.longName}` : ''}`);
      } else if (tid === 0xcd) {
        const t = parseStt(sec), diff = t.utcMs - now, first = !s.stt;
        s.stt = { utcMs: t.utcMs, offset: t.offset, ds: t.dsStatus, diffMs: s.stt ? 0.8 * s.stt.diffMs + 0.2 * diff : diff, atMs: now };
        if (first) this.note('TIME', `ch ${s.ch} station clock ${new Date(t.utcMs).toISOString().slice(0, 19).replace('T', ' ')} UTC · ${diff >= 0 ? '+' : ''}${(diff / 1000).toFixed(1)} s from this device`);
      } else if (tid === 0xcb) {
        const e = parseEit(sec), table = s.mgt?.tables.find(t => t.pid === pid)?.type ?? 0x100, off = s.stt?.offset ?? 18;
        for (const ev of e.events) {
          const k = `${e.sourceId}/${ev.eventId}`, startMs = gpsToUnixMs(ev.startGps, off), had = s.events[k];
          const cap = ev.desc.captions?.length ? ev.desc.captions.map(c => c.digital ? `CC${c.service}` : `608 F${c.line21Field + 1}`).join(' ') : '';
          s.events[k] = { sourceId: e.sourceId, eventId: ev.eventId, startMs, seconds: ev.seconds, title: ev.title, text: had?.startMs === startMs ? had.text : '', rating: ratingText(ev.desc.advisory), captions: cap, table: table - 0x100, seenMs: now };
          const t = s.etts[k]; if (t) s.events[k].text = t;
          if (!had) this.version++;
        }
        this.prune(s);
      } else if (tid === 0xcc) {
        const t = parseEtt(sec), k = `${t.sourceId}/${t.eventId}`;
        if (t.isEvent) { s.etts[k] = t.text; const ev = s.events[k]; if (ev) ev.text = t.text; }
        else s.chanEtt[t.sourceId] = t.text;
      } else if (tid === 0xca) s.rrt = parseRrt(sec);
    } catch { /* a malformed table */ }
    s.lastMs = now;
    this.dirty = true;
  }

  private forget(s: Station): void { s.pat = null; s.pmts = {}; s.vct = null; s.mgt = null; s.stt = null; s.events = {}; s.etts = {}; s.raw = {}; s.video = {}; s.stills = {}; s.pidStats = {}; }

  private prune(s: Station): void {
    const cut = this.now() + (s.stt?.diffMs ?? 0) - 6 * 3_600_000, keys = Object.keys(s.events);
    if (keys.length < 400) { for (const k of keys) if (s.events[k].startMs + s.events[k].seconds * 1000 < cut) delete s.events[k]; return; }
    keys.sort((a, b) => s.events[a].startMs - s.events[b].startMs).slice(0, keys.length - 400).forEach(k => delete s.events[k]);
  }

  private programOfPid(s: Station, pid: number): number {
    for (const p of Object.values(s.pmts)) if (p.streams.some(x => x.pid === pid)) return p.program;
    return -1;
  }

  private pes(pid: number, es: Uint8Array, holes: number[]): void {
    const s = this.station(); if (!s) return;
    const prog = this.programOfPid(s, pid);
    let dec = this.stills.get(pid);
    if (!dec) { dec = new StillDecoder(); this.stills.set(pid, dec); }
    const last = s.stills[prog], now = this.now();
    const want = prog >= 0 && (!last || !last.complete || now - last.ms > STILL_EVERY_MS);
    const still = dec.unit(es, holes, want);
    s.video[pid] = { seq: dec.seq, gop: dec.gop, pictures: dec.pictures, iPictures: dec.iPictures };
    if (still && prog >= 0) {
      // a picture that came out with fewer rows than the one we have keeps the old still
      if (last && last.complete && !still.filled && now - last.ms < 60_000) return;
      s.stills[prog] = { ms: now, complete: still.filled, mbs: still.mbs, w: still.width, h: still.height, dar: still.dar };
      const vc = s.vct?.channels.find(c => c.program === prog);
      if (!last) this.note('STILL', `${vc ? `${vc.major}.${vc.minor} ${vc.shortName}` : `program ${prog}`} · ${still.seq.width}x${still.seq.height}${still.seq.progressive ? 'p' : 'i'} · ${still.complete ? 'whole picture' : `${Math.round(100 * still.mbs / still.mbsTotal)} % of the picture`}`);
      this.onStill?.(`${s.key}/${prog}`, still);
      this.version++; this.dirty = true;
    }
  }

  // ---- out ----
  private note(kind: string, text: string): void {
    const ms = this.now();
    this.log.unshift({ ms, ch: this.ch, kind, text }); if (this.log.length > 500) this.log.length = 500;
    this.emit?.({ type: 'packet', line: `${clock(ms)} ${kind} ${text}` });
  }

  private subRows(s: Station): SubRow[] {
    const now = this.now(), rows: SubRow[] = [];
    const chans: VChannel[] = s.vct?.channels ?? [];
    const total = Math.max(1, Object.values(s.pidStats).reduce((a, p) => a + p.packets, 0));
    const progs = new Set<number>(chans.map(c => c.program));
    // programs in the PAT with no channel in the TVCT still show (by program number)
    for (const p of s.pat?.programs ?? []) if (!progs.has(p.program)) chans.push({ major: 0, minor: p.program, shortName: '', modulation: 4, carrierHz: 0, tsid: s.tsid, program: p.program, etm: 0, access: false, hidden: false, hideGuide: false, serviceType: 0, sourceId: -1, desc: { tags: [] } });
    for (const c of chans) {
      const pmt = s.pmts[c.program];
      const elems = c.desc.elements ?? [];
      const streams: StreamRow[] = (pmt?.streams ?? elems.map(e => ({ type: e.streamType, pid: e.pid, desc: { tags: [], lang: e.lang } as Descriptors }))).map(x => {
        const ps = s.pidStats[x.pid], v = s.video[x.pid]?.seq;
        const lang = x.desc.lang ?? x.desc.ac3?.lang ?? elems.find(e => e.pid === x.pid)?.lang ?? '';
        const info = v ? videoText(v) : x.desc.ac3 ? `${x.desc.ac3.channels} · ${x.desc.ac3.kbps} kb/s` : '';
        return { pid: x.pid, type: x.type, typeName: STREAM_TYPES[x.type] ?? `type 0x${x.type.toString(16)}`, lang, info, kbps: ps ? ps.packets / total * TS_BPS / 1000 : 0, share: ps ? ps.packets / total : 0,
          captions: (x.desc.captions ?? []).map(cc => cc.digital ? `CC${cc.service} ${cc.lang}` : `608 ${cc.lang}`).join(', ') };
      });
      const vid = streams.find(x => isVideo(x.type));
      const evs = Object.values(s.events).filter(e => e.sourceId === c.sourceId).sort((a, b) => a.startMs - b.startMs);
      const nowMs = s.stt ? now + s.stt.diffMs : now;
      const cur = evs.find(e => e.startMs <= nowMs && e.startMs + e.seconds * 1000 > nowMs) ?? null;
      const nxt = evs.find(e => e.startMs > nowMs) ?? null;
      const still = s.stills[c.program];
      rows.push({ key: `${s.key}/${c.program}`, major: c.major, minor: c.minor, name: c.shortName, longName: c.desc.longName ?? '', program: c.program, sourceId: c.sourceId, serviceType: c.serviceType,
        hidden: c.hidden, hideGuide: c.hideGuide, access: c.access, streams, video: vid ? (s.video[vid.pid]?.seq ? videoText(s.video[vid.pid].seq!) : vid.typeName) : '',
        stillMs: still?.ms ?? 0, stillComplete: still?.complete ?? false, stillMbs: still?.mbs ?? 0, now: cur, next: nxt, events: evs.length });
    }
    return rows.sort((a, b) => (a.major || 999) - (b.major || 999) || a.minor - b.minor);
  }

  stationRow(s: Station): StationRow {
    const subs = this.subRows(s);
    return { key: s.key, ch: s.ch, band: CHANNELS.find(c => c.ch === s.ch)?.band ?? '', centerHz: s.centerHz, tsid: s.tsid, firstMs: s.firstMs, lastMs: s.lastMs,
      pilotDb: s.pilotDb, pilotHz: s.pilotHz, topDb: s.topDb, pilotMs: s.pilotMs, pilotOk: s.pilotOk, syncMs: s.syncMs, snrDb: s.snrMs ? s.snrDb : NaN, sliceSnrDb: s.snrMs ? s.sliceSnrDb : NaN, snrMs: s.snrMs, rs: s.rs,
      fields: s.fields, airFields: s.airFields, packets: s.packets, badPackets: s.badPackets, decodedMs: s.fields * FIELD_MS,
      subs, tables: [...new Set([s.pat ? 'PAT' : '', ...Object.keys(s.pmts).map(() => 'PMT'), s.mgt ? 'MGT' : '', s.vct ? (s.vct.cable ? 'CVCT' : 'TVCT') : '', s.stt ? 'STT' : '', Object.keys(s.events).length ? 'EIT' : '', Object.keys(s.etts).length ? 'ETT' : '', s.rrt ? 'RRT' : ''].filter(x => x))],
      stt: s.stt, hasVct: !!s.vct, hasEit: Object.keys(s.events).length > 0, tvName: subs.find(x => x.name)?.name ?? '', events: Object.keys(s.events).length };
  }

  private pidRows(s: Station): PidRow[] {
    const total = Math.max(1, Object.values(s.pidStats).reduce((a, p) => a + p.packets, 0));
    const role = (pid: number): string => {
      if (pid === 0) return 'PAT'; if (pid === 0x1ffb) return 'PSIP base (MGT TVCT STT)'; if (pid === 0x1fff) return 'null'; if (pid === 8192) return 'uncorrectable (RS)';
      for (const p of s.pat?.programs ?? []) if (p.pid === pid) { const vc = s.vct?.channels.find(c => c.program === p.program); return `PMT ${vc ? `${vc.major}.${vc.minor}` : `program ${p.program}`}`; }
      for (const pm of Object.values(s.pmts)) for (const x of pm.streams) if (x.pid === pid) { const vc = s.vct?.channels.find(c => c.program === pm.program); return `${vc ? `${vc.major}.${vc.minor}` : `program ${pm.program}`} ${STREAM_TYPES[x.type] ?? `type 0x${x.type.toString(16)}`}${x.desc.lang ? ` ${x.desc.lang}` : ''}`; }
      const t = s.mgt?.tables.find(x => x.pid === pid); if (t) return tableTypeName(t.type);
      return '';
    };
    return Object.entries(s.pidStats).map(([k, p]) => { const pid = Number(k); return { pid, role: role(pid), packets: p.packets, kbps: p.packets / total * TS_BPS / 1000, share: p.packets / total, ccErrors: p.ccErrors, scrambled: p.scrambled, pcrs: p.pcrs, pcrIntervalMs: p.pcrIntervalMs, pcrPpm: p.pcrPpm }; })
      .sort((a, b) => a.pid - b.pid);
  }

  /** A station: its tables were read, or its segment sync seen; with a narrow radio, its pilot met the 8VSB rule. */
  private listed(x: Station): boolean { return x.tsid >= 0 || x.syncMs > 0 || (this.capability === 'pilot' && x.pilotOk); }

  snapshot(): AtscSnap {
    const s = this.ch ? this.stations.get(`ch${this.ch}`) ?? null : null, now = this.now();
    const wall = this.wallStart ? Math.max(1, now - this.wallStart) : 1;
    const live = this.live && s ? { ...this.live, pids: this.pidRows(s) } : null;
    const subs = s ? this.subRows(s) : [];
    const videoSubs = subs.filter(x => x.streams.some(y => y.type === 0x02));
    return {
      type: 'atsc', capability: this.capability, rate: this.rate, centerHz: this.centerHz, ch: this.ch, workers: this.pool?.size ?? 0, busy: this.inFlight,
      decodedPct: this.airSamples ? Math.min(100, 100 * this.decodedSamples / this.airSamples) : 0, cpuPct: Math.min(400, 100 * this.cpuMs / wall), bursts: this.bursts,
      stations: [...this.stations.values()].filter(x => this.listed(x)).sort((a, b) => a.ch - b.ch).map(x => this.stationRow(x)), live,
      here: s ? { ch: s.ch, pilotOk: s.pilotOk, sync: s.syncMs >= this.hereSince, pilotDb: s.pilotDb, pilotHz: s.pilotHz, topDb: s.topDb, snrDb: s.snrMs >= this.hereSince ? s.snrDb : NaN, tsid: s.tsid, since: this.hereSince, vct: !!s.vct, stills: videoSubs.filter(x => x.stillMs > this.hereSince).length, videoSubs: videoSubs.length, eit: Object.values(s.events).some(e => e.seenMs > this.hereSince), bursts: this.hereBursts } : null,
    };
  }

  post(force = false): void {
    const now = performance.now();
    if (!force && (!this.dirty || now - this.lastPost < 500)) return;
    this.lastPost = now; this.dirty = false;
    this.emit?.(this.snapshot() as unknown as Record<string, unknown>);
  }

  /** Everything known of a station for the detail panel: the guide, the streams and the raw tables. */
  detail(key: string): Record<string, unknown> | null {
    const [sk, prog] = key.split('/'), s = this.stations.get(sk); if (!s) return null;
    const p = Number(prog), vc = s.vct?.channels.find(c => c.program === p);
    const events = Object.values(s.events).filter(e => vc ? e.sourceId === vc.sourceId : true).sort((a, b) => a.startMs - b.startMs);
    const raw = Object.entries(s.raw).filter(([k]) => {
      const [tid, ext] = k.split('/').map(x => parseInt(x, 16));
      if (tid === 0x2) return parseInt(k.split('/')[1], 10) === p;
      if (tid === 0xcb) return !vc || Number(k.split('/')[1]) === vc.sourceId;
      return tid !== 0xcc || ext >= 0;
    }).map(([k, v]) => ({ table: tableName(parseInt(k.split('/')[0], 16)), id: k, hex: v })).slice(0, 80);
    return { key, station: this.stationRow(s), program: p, events, raw, video: Object.entries(s.video).map(([pid, v]) => ({ pid: Number(pid), ...v })), mgt: s.mgt, chanText: vc ? s.chanEtt[vc.sourceId] ?? '' : '' };
  }

  exportAll(): { csv: string; json: string } {
    const csv = ['time,channel,kind,text', ...this.log.slice().reverse().map(r => `${new Date(r.ms).toISOString()},${r.ch},${r.kind},"${r.text.replace(/"/g, '""')}"`)].join('\n');
    const json = JSON.stringify({ exported: new Date(this.now()).toISOString(), stations: [...this.stations.values()].map(s => ({ ...this.stationRow(s), pat: s.pat, pmts: s.pmts, vct: s.vct, mgt: s.mgt, stt: s.stt, events: Object.values(s.events), raw: s.raw })) }, null, 1);
    return { csv, json };
  }

  exportState(): AtscState {
    return { v: 1, stations: [...this.stations.values()].map(s => ({ ...s, raw: {} })), log: this.log.slice(0, 200) };
  }
  restore(st: AtscState | null): void {
    if (!st || st.v !== 1) return;
    // a saved station from before the 8VSB rule, with nothing decoded, was likely a spur: it is not brought back
    for (const s of st.stations ?? []) if (!this.stations.has(s.key) && (s.tsid >= 0 || s.syncMs > 0 || s.pilotOk))
      this.stations.set(s.key, { ...s, pilotOk: !!s.pilotOk, syncMs: s.syncMs ?? 0, snrMs: s.snrMs ?? 0, snrDb: s.snrMs ? s.snrDb : NaN, raw: s.raw ?? {}, pidStats: s.pidStats ?? {}, video: s.video ?? {}, stills: s.stills ?? {}, chanEtt: s.chanEtt ?? {} });
    if (!this.log.length) this.log.push(...(st.log ?? []));
    this.post(true);
  }
  clear(): void { this.stations.clear(); this.log.length = 0; this.demux.clear(); this.stills.clear(); this.live = null; this.airSamples = this.decodedSamples = this.cpuMs = 0; this.wallStart = 0; this.version++; this.post(true); }
}

function tableName(tid: number): string {
  return ({ 0x00: 'PAT', 0x02: 'PMT', 0xc7: 'MGT', 0xc8: 'TVCT', 0xc9: 'CVCT', 0xca: 'RRT', 0xcb: 'EIT', 0xcc: 'ETT', 0xcd: 'STT' } as Record<number, string>)[tid] ?? `0x${tid.toString(16)}`;
}
export function videoText(v: SeqInfo): string {
  const fr = v.frameRate ? (Math.abs(v.frameRate - Math.round(v.frameRate)) > 0.01 ? v.frameRate.toFixed(2) : v.frameRate.toFixed(0)) : '';
  return `${v.width}x${v.height}${v.progressive ? 'p' : 'i'} ${fr}${v.aspect === 3 ? ' 16:9' : v.aspect === 2 ? ' 4:3' : ''}`;
}
