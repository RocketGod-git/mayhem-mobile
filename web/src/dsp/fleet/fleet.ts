/**
 * Fleet: a receive-only monitor for P25 and DMR trunked radio. Finds every carrier in the span, gives the live
 * ones a channel each (the control channels keep theirs, the rest take turns), decodes the control signaling and
 * builds the systems, sites, channel tables, grants, registrations and unit positions from what is on the air.
 * Labels are only what the air carries. Publishes a 'fleet' snapshot (at most two a second) and 'packet' log lines.
 */
import { fft, hann } from '../../fft.js';
import type { Emit, IqProcessor } from '../core.js';
import { Ddc } from '../trains.js';
import { RealFir, lowpassTaps } from '../ham/filters.js';
import { crc12Ok, DMR_CRC_MASK, hex } from './codes.js';
import { parseTsbk, resolveChannel, svcFlags, tsbkLine, h, type Field, type Iden, type Tsbk } from './tsbk.js';
import { parseCsbk, unwrap16, csbkLine, VendorCheck, type Csbk } from './csbk.js';
import { SymbolRx, P25Framer, DmrFramer, CwReader, looksLikeCallsign, type P25Block, type DmrEvent } from './rx.js';

export const CH_RATE = 24_000;
const CUT_HZ = 5_500;
const AUDITION_MS = 3_000;
const LIVE_MS = 4_000;

export type CarrierClass = '' | 'P25 C4FM' | 'P25 CQPSK/LSM' | 'P25 PHASE 2 TDMA' | 'DMR' | 'ANALOG FM' | 'UNKNOWN 4FSK' | 'UNKNOWN LINEAR';
export type Role = '' | 'control' | 'voice' | 'rest' | 'data';
export interface CarrierRow {
  key: number; hz: number; levelDb: number; peakDb: number; firstMs: number; lastMs: number; onMs: number; heardMs: number;
  cls: CarrierClass; role: Role; sys: string; nac: number; cc: number; frames: number; blocks: number; crcOk: number;
  lastDecodeMs: number; envCv: number; eye: number; decoding: boolean; callsign: string; tdma: boolean; lcn: string;
}
export interface SiteRow {
  key: string; label: string; rfss: number; site: number; nac: number; ccHz: number[]; lastMs: number; levelDb: number;
  neighbors: { label: string; hz: number; ch: string; sys: number; heard: boolean }[]; secondary: { hz: number; ch: string }[];
  time: string; callsign: string; carriers: number[]; lcns: { lcn: number; hz: number; slot: number }[]; rest: number; busy: number[];
  idens: Iden[]; units: number; lra: number; cls: number;
}
export interface SystemRow {
  key: string; proto: 'P25' | 'DMR'; color: number; label: string; wacn: number; sysId: number; cc: number; fid: number;
  net: number; model: string; callsign: string; firstMs: number; lastMs: number; sites: SiteRow[]; idens: Iden[];
  grants: number; units: number; tgs: number; derived: boolean;
}
export interface UnitReport { ms: number; hz: number; kind: string; hex: string; verified: boolean; lat: number | null; lon: number | null; text: string }
export interface UnitRow {
  key: string; sys: string; id: number; firstMs: number; lastMs: number; lat: number | null; lon: number | null; posMs: number;
  posVerified: boolean; trail: [number, number, number][]; groups: number[]; grants: number; carriers: number[]; reports: UnitReport[]; site: string;
}
export interface GrantRow { ms: number; lastMs: number; sys: string; kind: string; tg: number; group: boolean; src: number; ch: string; hz: number; slot: number; tdma: boolean; emergency: boolean; encrypted: boolean; carrierHz: number; site: string }
export interface TgRow { key: string; sys: string; tg: number; firstMs: number; lastMs: number; grants: number; recent: number[]; members: number[]; history: GrantRow[] }
export interface LogRow { ms: number; hz: number; proto: string; name: string; text: string; hex: string; ok: boolean }
export interface FleetSnap {
  type: 'fleet'; centerHz: number; rate: number; spanLo: number; spanHi: number; carriers: CarrierRow[]; systems: SystemRow[];
  units: UnitRow[]; tgs: TgRow[]; grants: GrantRow[]; perMin: number; blocks: number; slots: number; ref: boolean;
}

interface Carrier extends CarrierRow { hdr?: { ms: number; slot: number }; lastAuditionMs: number; p25: { sys: number; wacn: number; rfss: number; site: number }; dmrSys: string; tables: Map<number, Iden>; unitIds: Map<number, number> }
interface Site {
  key: string; sys: string; rfss: number; site: number; nac: number; carriers: Set<number>; lastMs: number; neighbors: Map<string, { sys: number; rfss: number; site: number; ch: number }>;
  secondary: Set<number>; time: string; lra: number; cls: number; idens: Map<number, Iden>;
}
interface Sys {
  key: string; proto: 'P25' | 'DMR'; color: number; wacn: number; sysId: number; cc: number; fid: number; net: number; model: string;
  firstMs: number; lastMs: number; idens: Map<number, Iden>; derived: boolean;
  lcns: Map<number, { hz: number; slot: number }>; lcnVotes: Map<string, Map<number, number>>; rest: number; busy: number[];
}
interface Unit { key: string; sys: string; id: number; firstMs: number; lastMs: number; lonLo: number; latLo: number; posMs: number; posVerified: boolean; trail: [number, number, number][]; groups: Set<number>; grants: number; carriers: Set<number>; reports: (UnitReport & { lonLo?: number; latLo?: number })[] }
interface Tg { key: string; sys: string; tg: number; firstMs: number; lastMs: number; grants: number; recent: number[]; members: Set<number>; history: GrantRow[] }

/** Channels a span can run at once: the down-converters cost in proportion to the sample rate. */
export const channelBudget = (rate: number) => Math.max(4, Math.min(24, Math.floor(110e6 / Math.max(rate, 1))));
const gridKey = (hz: number) => Math.round(hz / 6250) * 6250;

class Chan {
  readonly ddc = new Ddc(CUT_HZ, CH_RATE, 127);
  rx!: SymbolRx;
  readonly p25 = new P25Framer();
  readonly dmr = new DmrFramer();
  cw!: CwReader;
  oi = new Float32Array(0); oq = new Float32Array(0);
  openedMs: number; lastSyncMs = 0; quietSince: number;
  /** [baseband]: samples arrive already mixed to 0 Hz at that rate (a recorded channel clip), no down-converter. */
  constructor(readonly key: number, public hz: number, center: number, rate: number, now: number, baseband = 0) {
    this.ddc.reset(rate); this.ddc.offsetHz = hz - center;
    const fs = baseband || this.ddc.outRate;
    this.rx = new SymbolRx(fs);
    this.cw = new CwReader(fs);
    this.rx.onSymbol = s => { this.p25.push(s); this.dmr.push(s); };
    this.openedMs = now; this.quietSince = now;
  }
  retarget(center: number): void { this.ddc.offsetHz = this.hz - center; }
  push(fi: Float32Array, fq: Float32Array, n: number, now: number): void {
    const need = this.ddc.maxOut(n);
    if (this.oi.length < need) { this.oi = new Float32Array(need); this.oq = new Float32Array(need); }
    const m = this.ddc.push(fi, fq, n, this.oi, this.oq);
    this.channel(this.oi, this.oq, m, now);
  }
  channel(zi: Float32Array, zq: Float32Array, m: number, now: number): void {
    const s0 = this.p25.syncs + this.dmr.syncs;
    this.rx.push(zi, zq, m);
    if (this.p25.syncs + this.dmr.syncs !== s0) { this.lastSyncMs = now; this.quietSince = now; this.cw.reset(); }
    else if (now - this.lastSyncMs > 80) this.cw.push(zi, zq, m);
  }
}

export class FleetProcessor implements IqProcessor {
  centerHz = 0;
  now: () => number = () => Date.now();
  /** The receiver's own position: resolves the derived DMR unit reports (low 16 bits of each coordinate). */
  ref: { lat: number; lon: number } | null = null;
  readonly carriers = new Map<number, Carrier>();
  readonly systems = new Map<string, Sys>();
  readonly sites = new Map<string, Site>();
  readonly units = new Map<string, Unit>();
  readonly tgs = new Map<string, Tg>();
  grants: GrantRow[] = [];
  readonly log: LogRow[] = [];
  blocks = 0;
  private readonly chans = new Map<number, Chan>();
  private rate = 0; private lastCenter = NaN;
  private fi = new Float32Array(0); private fq = new Float32Array(0);
  private nfft = 4096; private re = new Float32Array(0); private im = new Float32Array(0); private win = new Float32Array(0); private acc = new Float32Array(0); private frames = 0;
  private lastFind = 0; private lastPost = 0; private pending = false; private colorNext = 0;
  private readonly logSeen = new Map<string, number>();
  private readonly vendor = new VendorCheck();
  private readonly bbFir = new Map<number, [RealFir, RealFir]>();

  constructor(private readonly emit: Emit | null) {}

  reset(rate: number): void {
    this.rate = rate;
    this.nfft = 1 << Math.max(10, Math.min(15, Math.ceil(Math.log2(rate / 1000))));
    this.re = new Float32Array(this.nfft); this.im = new Float32Array(this.nfft); this.win = hann(this.nfft); this.acc = new Float32Array(this.nfft); this.frames = 0;
    this.chans.clear(); this.lastCenter = this.centerHz;
    this.post(true);
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    const now = this.now(), c = this.centerHz;
    if (c !== this.lastCenter) {
      this.lastCenter = c; this.acc.fill(0); this.frames = 0;
      for (const [k, ch] of this.chans) if (!this.inSpan(ch.hz)) this.chans.delete(k); else ch.retarget(c);
    }
    const n = iq.length >> 1;
    if (this.fi.length < n) { this.fi = new Float32Array(n); this.fq = new Float32Array(n); }
    for (let k = 0; k < n; k++) { this.fi[k] = iq[2 * k] + 0.5; this.fq[k] = iq[2 * k + 1] + 0.5; }
    // the spectrum for finding carriers: a few transforms per buffer are plenty
    const N = this.nfft, step = Math.max(N, Math.floor(n / 4));
    for (let off = 0; off + N <= n && this.frames < 24; off += step) {
      for (let k = 0; k < N; k++) { this.re[k] = this.fi[off + k] * this.win[k]; this.im[k] = this.fq[off + k] * this.win[k]; }
      fft(this.re, this.im);
      for (let k = 0; k < N; k++) this.acc[k] += this.re[k] * this.re[k] + this.im[k] * this.im[k];
      this.frames++;
    }
    for (const ch of this.chans.values()) ch.push(this.fi, this.fq, n, now);
    if (now - this.lastFind > 500 && this.frames >= 4) { this.lastFind = now; this.findCarriers(now); this.assign(now); }
    if (this.pending || now - this.lastPost > 1000) this.post();
  }

  private inSpan(hz: number): boolean { return Math.abs(hz - this.centerHz) < this.rate * 0.44 - 6_250; }
  get spanLo(): number { return this.centerHz - this.rate * 0.44; }
  get spanHi(): number { return this.centerHz + this.rate * 0.44; }

  /** Peaks of the 6 kHz channel power, at least 10 dB over the span's median, 6 kHz apart (a neighbor 12.5 kHz away
   *  stays its own carrier). */
  private findCarriers(now: number): void {
    const N = this.nfft, bin = this.rate / N, p = new Float32Array(N);
    for (let k = 0; k < N; k++) p[k] = this.acc[(k + N / 2) % N] / this.frames;
    this.acc.fill(0); this.frames = 0;
    const W = Math.max(1, Math.round(6_000 / bin)), half = W >> 1, s = new Float32Array(N), P = new Float64Array(N + 1);
    for (let k = 0; k < N; k++) P[k + 1] = P[k] + p[k];
    for (let k = 0; k < N; k++) s[k] = P[Math.min(N, k - half + W)] - P[Math.max(0, k - half)];
    const lo = Math.ceil(N / 2 - this.rate * 0.44 / bin), hi = Math.floor(N / 2 + this.rate * 0.44 / bin);
    const vals = Array.from(s.subarray(lo, hi)).sort((a, b) => a - b), floor = vals[Math.floor(vals.length * 0.4)] || 1e-9;
    const dc = Math.ceil(4_000 / bin), seen = new Set<number>();
    for (let k = lo + 1; k < hi - 1; k++) {
      const v = s[k]; if (v < floor * 10) continue;
      let peak = true; for (let j = Math.max(lo, k - W); j <= Math.min(hi - 1, k + W); j++) if (s[j] > v || (s[j] === v && j < k)) { peak = false; break; }
      if (!peak) continue;
      const db = 10 * Math.log10(v / floor);
      if (Math.abs(k - N / 2) < dc && db < 20) continue;
      let sw = 0, sp = 0; for (let j = k - half; j <= k + half; j++) { sw += p[j]; sp += p[j] * j; }
      const hz = this.centerHz + (sp / sw - N / 2) * bin, key = gridKey(hz);
      seen.add(key);
      const fresh = !this.carriers.has(key), c = this.carrierAt(Math.abs(hz - key) < 1_500 ? key : Math.round(hz / 100) * 100);
      if (fresh) { c.levelDb = db; c.peakDb = db; }
      if (now - c.lastMs < 2_000) c.onMs += now - c.lastMs;
      c.lastMs = now; c.levelDb = Math.round(db * 10) / 10; c.peakDb = Math.max(c.peakDb, c.levelDb);
      const ch = this.chans.get(key); if (ch) ch.hz = hz;
    }
    for (const c of this.carriers.values()) if (!seen.has(c.key) && this.inSpan(c.hz) && now - c.lastMs > 1_000) { const ch = this.chans.get(c.key); if (ch) ch.cw.end(); }
    this.pending = true;
  }

  /** Control channels keep their channel; every other live carrier gets a turn of a few seconds. */
  private assign(now: number): void {
    const budget = channelBudget(this.rate);
    const live = [...this.carriers.values()].filter(c => this.inSpan(c.hz) && now - c.lastMs < LIVE_MS);
    for (const [k, ch] of this.chans) {
      const c = this.carriers.get(k)!;
      if (now - c.lastMs > LIVE_MS || !this.inSpan(c.hz)) { this.chans.delete(k); continue; }
      this.classify(c, ch, now);
    }
    const keep = (c: Carrier) => c.lastDecodeMs > 0 && now - c.lastDecodeMs < 10_000;
    const want: Carrier[] = live.filter(keep).sort((a, b) => b.levelDb - a.levelDb);
    for (const [k, ch] of this.chans) { const c = this.carriers.get(k)!; if (!keep(c) && now - ch.openedMs < AUDITION_MS && !want.includes(c)) want.push(c); }
    const rest = live.filter(c => !want.includes(c)).sort((a, b) => a.lastAuditionMs - b.lastAuditionMs || b.levelDb - a.levelDb);
    for (const c of rest) { if (want.length >= budget) break; want.push(c); }
    const chosen = new Set(want.slice(0, budget).map(c => c.key));
    for (const k of [...this.chans.keys()]) if (!chosen.has(k)) this.chans.delete(k);
    for (const k of chosen) if (!this.chans.has(k)) { const c = this.carriers.get(k)!; c.lastAuditionMs = now; this.open(c, now); }
    for (const c of this.carriers.values()) c.decoding = this.chans.has(c.key);
  }
  private open(c: Carrier, now: number, given?: Chan): void {
    const ch = given ?? new Chan(c.key, c.hz, this.centerHz, this.rate, now);
    ch.p25.onBlock = b => this.p25Block(c, ch, b);
    ch.p25.onFrame = (nac, duid) => { c.envCv = Math.round(ch.rx.envCv * 100) / 100; this.p25Frame(c, nac, duid); };
    ch.dmr.onBurst = e => this.dmrBurst(c, ch, e);
    ch.cw.onText = t => this.cwText(c, t);
    this.chans.set(c.key, ch);
  }
  private classify(c: Carrier, ch: Chan, now: number): void {
    c.heardMs += 500; c.envCv = Math.round(ch.rx.envCv * 100) / 100; c.eye = Math.round(ch.rx.eye * 100) / 100;
    if (c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000) return;
    if (now - ch.openedMs < 2_000) return;
    if (c.tdma && ch.rx.envCv > 0.15) c.cls = 'P25 PHASE 2 TDMA';
    else if (ch.rx.eye > 1.3 && ch.rx.envCv < 0.15) c.cls = 'UNKNOWN 4FSK';
    else if (ch.rx.envCv > 0.18) c.cls = 'UNKNOWN LINEAR';
    else c.cls = 'ANALOG FM';
  }

  // ------------------------------------------------------------------------------------------------ P25
  private p25Frame(c: Carrier, nac: number, duid: number): void {
    const now = this.now();
    c.frames++; c.nac = nac; c.lastDecodeMs = now;
    c.cls = c.envCv > 0.2 ? 'P25 CQPSK/LSM' : 'P25 C4FM';
    if (duid === 7) c.role = 'control';
    else if (duid === 0xc) { if (c.role !== 'control') c.role = 'data'; }
    else if (c.role !== 'control') c.role = 'voice';
    if (duid !== 7) this.pending = true;
  }
  private p25Block(c: Carrier, _ch: Chan | null, b: P25Block): void {
    const now = this.now();
    c.blocks++; this.blocks++;
    if (!b.crcOk) return;
    c.crcOk++;
    const t = parseTsbk(b.bytes);
    const sys = this.p25Identity(c, t, now);
    this.p25Apply(c, t, sys, now);
    const res = (ch: number | undefined) => ch === undefined ? '' : this.chText(c, sys, ch);
    const extra = t.ch !== undefined && t.kind !== 'iden' ? ` → ${res(t.ch)}` : '';
    this.addLog({ ms: now, hz: c.hz, proto: 'P25', name: t.name, text: `NAC ${h(b.nac, 3)} · ${tsbkLine(t)}${extra}`, hex: t.hex, ok: true });
  }
  /** Which system and site a control channel belongs to, from its RFSS and network status. */
  private p25Identity(c: Carrier, t: Tsbk, now: number): Sys | null {
    const id = c.p25;
    if (t.kind === 'rfss') { id.sys = t.sys!; id.rfss = t.rfss!; id.site = t.site!; }
    if (t.kind === 'net') { id.wacn = t.wacn!; id.sys = t.sys!; }
    if (t.kind === 'iden' && t.iden) c.tables.set(t.iden.iden, t.iden);
    if (id.wacn < 0 || id.sys < 0) return null;
    const key = `P25 ${h(id.wacn, 5)}.${h(id.sys, 3)}`;
    let s = this.systems.get(key);
    if (!s) {
      s = { key, proto: 'P25', color: this.colorNext++, wacn: id.wacn, sysId: id.sys, cc: -1, fid: -1, net: -1, model: '', firstMs: now, lastMs: now, idens: new Map(), derived: false, lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [] };
      this.systems.set(key, s);
    }
    s.lastMs = now; c.sys = key;
    for (const [k, v] of c.tables) s.idens.set(k, v);
    if (id.rfss >= 0) {
      const sk = `${key}/${id.rfss}.${id.site}`;
      let site = this.sites.get(sk);
      if (!site) { site = { key: sk, sys: key, rfss: id.rfss, site: id.site, nac: c.nac, carriers: new Set(), lastMs: now, neighbors: new Map(), secondary: new Set(), time: '', lra: -1, cls: -1, idens: new Map() }; this.sites.set(sk, site); }
      site.carriers.add(c.key); site.lastMs = now; site.nac = c.nac;
      for (const [k, v] of c.tables) site.idens.set(k, v);
    }
    return s;
  }
  private siteOf(c: Carrier): Site | undefined {
    const id = c.p25; return c.sys && id.rfss >= 0 ? this.sites.get(`${c.sys}/${id.rfss}.${id.site}`) : undefined;
  }
  private tablesFor(c: Carrier, s: Sys | null): Map<number, Iden> {
    if (!s) return c.tables;
    const m = new Map(s.idens); for (const [k, v] of c.tables) m.set(k, v); return m;
  }
  private chText(c: Carrier, s: Sys | null, ch: number): string {
    const r = resolveChannel(ch, this.tablesFor(c, s));
    return r ? `${(r.hz / 1e6).toFixed(5)} MHz${r.tdma ? ` TDMA slot ${r.slot + 1}` : ''}` : `channel ${h(ch, 4)} (no table yet)`;
  }
  private p25Apply(c: Carrier, t: Tsbk, s: Sys | null, now: number): void {
    const site = this.siteOf(c);
    if (!s) return;
    const tables = this.tablesFor(c, s);
    switch (t.kind) {
      case 'rfss': case 'net': if (site) { site.lra = t.lra ?? site.lra; site.cls = t.cls ?? site.cls; } break;
      case 'adj': if (site && t.sys !== undefined) site.neighbors.set(`${t.sys}.${t.rfss}.${t.site}`, { sys: t.sys, rfss: t.rfss!, site: t.site!, ch: t.ch! }); break;
      case 'sccb': if (site && t.ch !== undefined) { site.secondary.add(t.ch); if (t.ch2 !== undefined && t.ch2 !== t.ch && t.op === 0x39) site.secondary.add(t.ch2); } break;
      case 'time': if (site && t.time) site.time = t.time; break;
      case 'grant': case 'update': case 'u2u': case 'datagrant': {
        const flags = svcFlags(t.svc ?? 0), siteLabel = site ? `${site.rfss}.${site.site}` : '';
        const add = (ch: number, tg: number | undefined, group: boolean, src: number) => {
          const r = resolveChannel(ch, tables);
          if (r) { const vk = gridKey(r.hz), vc = this.carriers.get(vk); if (vc) { if (vc.role !== 'control') vc.role = t.kind === 'datagrant' ? 'data' : 'voice'; vc.tdma = r.tdma; vc.sys = vc.sys || s.key; } }
          this.grant(s.key, { ms: now, lastMs: now, sys: s.key, kind: t.kind, tg: tg ?? 0, group, src, ch: h(ch, 4), hz: r?.hz ?? 0, slot: r?.slot ?? 0, tdma: r?.tdma ?? false, emergency: flags.emergency, encrypted: flags.encrypted, carrierHz: c.hz, site: siteLabel }, t.kind === 'update');
        };
        if (t.kind === 'u2u') { if (t.ch !== undefined) add(t.ch, t.dst, false, t.src ?? 0); if (t.src) this.touchUnit(s.key, t.src, c, now, 'u2u', t, siteLabel); if (t.dst) this.touchUnit(s.key, t.dst, c, now, 'u2u', t, siteLabel); }
        else if (t.ch !== undefined) {
          add(t.ch, t.group ?? t.dst, t.group !== undefined, t.src ?? 0);
          if (t.ch2 !== undefined && t.group2 !== undefined) add(t.ch2, t.group2, true, 0);
          if (t.src) this.touchUnit(s.key, t.src, c, now, t.kind, t, siteLabel, t.group);
          if (t.dst && t.kind === 'datagrant') this.touchUnit(s.key, t.dst, c, now, t.kind, t, siteLabel);
        }
        break;
      }
      case 'affil': if (t.dst) { const u = this.touchUnit(s.key, t.dst, c, now, 'affiliation', t, site ? `${site.rfss}.${site.site}` : ''); if (t.group) { u.groups.add(t.group); this.tgFor(s.key, t.group, now).members.add(t.dst); } } break;
      case 'reg': case 'dereg': case 'unit': { const id = t.kind === 'reg' && t.op === 0x2c ? t.src : t.dst ?? t.src; if (id && id < 0xfffff0) this.touchUnit(s.key, id, c, now, t.kind, t, site ? `${site.rfss}.${site.site}` : ''); break; }
    }
  }

  // ------------------------------------------------------------------------------------------------ DMR
  private dmrBurst(c: Carrier, _ch: Chan | null, e: DmrEvent): void {
    const now = this.now(), b = e.burst;
    if (b.dt > 10) return;
    c.frames++; c.cc = b.cc; c.cls = 'DMR'; c.lastDecodeMs = now;
    if (b.dt === 1 || b.dt === 2) { if (c.role !== 'control' && c.role !== 'rest') c.role = 'voice'; this.pending = true; return; }
    if (b.dt === 9) return;
    c.blocks++; this.blocks++;
    const mask = DMR_CRC_MASK[b.dt];
    const ok = mask !== undefined && crc12Ok(b.bytes, mask);
    if (ok) c.crcOk++;
    if (b.dt === 3) {
      const op = b.bytes[0] & 0x3f, vendor = !ok && b.bytes[1] === 0x10 && (op === 0x09 || op === 0x3d);
      const vok = vendor && this.vendor.check(b.bytes, `${b.cc}`);
      if (vok) c.crcOk++;
      const cs = parseCsbk(b.bytes, ok || vok);
      // the unit-report families are kept when their check fails (shown unverified); anything else has to pass its CRC
      if (!ok && !vok && !(cs.derived && (cs.kind === 'unitrpt' || cs.kind === 'unithdr' || cs.kind === 'callann'))) return;
      if (c.role === '' || c.role === 'voice') c.role = 'control';
      const s = this.dmrSystem(c, cs, b.cc, now);
      this.dmrApply(c, cs, b.slot, s, now);
      this.addLog({ ms: now, hz: c.hz, proto: 'DMR', name: cs.name, text: `CC ${b.cc} · TS${b.slot + 1} · ${csbkLine(cs)}`, hex: cs.hex, ok: ok || vok });
    } else if (ok || b.dt === 7) {
      if (b.dt === 6 || b.dt === 7) { if (c.role === '') c.role = 'data'; }
      const name = ['PI HEADER', 'VOICE HEADER', 'TERMINATOR', 'CSBK', 'MBC HEADER', 'MBC CONTINUATION', 'DATA HEADER', 'RATE 1/2 DATA', 'RATE 3/4 DATA', 'IDLE', 'RATE 1 DATA'][b.dt];
      this.addLog({ ms: now, hz: c.hz, proto: 'DMR', name, text: `CC ${b.cc} · TS${b.slot + 1} · ${name}${ok ? '' : ' · no block CRC'} · ${hex(b.bytes)}`, hex: hex(b.bytes), ok });
    }
  }
  private dmrSystem(c: Carrier, cs: Csbk, cc: number, now: number): Sys {
    let key = c.dmrSys;
    if (cs.verified && cs.sysCode !== undefined) key = `DMR ${cs.model} ${cs.net}`;
    else if (!key) key = `DMR CC${cc} FID ${h(cs.fid, 2)}`;
    c.dmrSys = key; c.sys = key;
    let s = this.systems.get(key);
    if (!s) {
      s = { key, proto: 'DMR', color: this.colorNext++, wacn: -1, sysId: -1, cc, fid: cs.fid, net: cs.net ?? -1, model: cs.model ?? '', firstMs: now, lastMs: now, idens: new Map(), derived: !!cs.derived, lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [] };
      this.systems.set(key, s);
    }
    s.lastMs = now; s.cc = cc; if (cs.derived) s.derived = true;
    return s;
  }
  private dmrApply(c: Carrier, cs: Csbk, slot: number, s: Sys, now: number): void {
    switch (cs.kind) {
      case 'beacon': {
        s.rest = cs.rest ?? -1; s.busy = cs.busy ?? [];
        // a unit exchange on this carrier just now and one logical channel busy: that channel is this carrier's slot
        if (s.busy.length === 1 && c.hdr && now - c.hdr.ms < 1_000) this.lcnVote(s, s.busy[0], c.hz, c.hdr.slot);
        c.lcn = [...s.lcns].filter(([, v]) => v.hz === c.hz).map(([k]) => k).join('/');
        for (const k of this.carriers.values()) if (k.sys === s.key) {
          const mine = [...s.lcns].filter(([, v]) => v.hz === k.hz).map(([n]) => n);
          k.role = mine.includes(s.rest) ? 'rest' : k.role === 'rest' ? 'control' : k.role;
        }
        if (cs.unit !== undefined) this.touchUnit(s.key, cs.unit, c, now, 'busy channel', cs, '');
        break;
      }
      case 'unithdr': if (cs.unit !== undefined) { c.hdr = { ms: now, slot }; this.touchUnit(s.key, cs.unit, c, now, 'unit report header', cs, ''); } break;
      case 'unitrpt': if (cs.unit !== undefined) this.unitReport(s, c, cs, now); break;
      case 'grant': {
        if (cs.dst === undefined) break;
        this.grant(s.key, { ms: now, lastMs: now, sys: s.key, kind: cs.group ? 'grant' : 'u2u', tg: cs.dst, group: !!cs.group, src: cs.src ?? 0, ch: `LPCN ${cs.lpcn}`, hz: 0, slot: cs.slot ?? 0, tdma: true, emergency: !!cs.emergency, encrypted: false, carrierHz: c.hz, site: '' }, false);
        if (cs.src) this.touchUnit(s.key, cs.src, c, now, 'grant', cs, '', cs.group ? cs.dst : undefined);
        break;
      }
      case 'ack': case 'unit': case 'aloha': case 'callann': { const id = cs.kind === 'callann' ? cs.unit : cs.dst; if (id && id < 0xfffff0) this.touchUnit(s.key, id, c, now, cs.kind === 'ack' ? 'acknowledged' : cs.name.toLowerCase(), cs, ''); break; }
    }
  }
  /** Votes per carrier slot for the logical channel it is; each slot takes the one it got at least two thirds of. */
  private lcnVote(s: Sys, lcn: number, hz: number, slot: number): void {
    const k = `${hz}:${slot}`, v = s.lcnVotes.get(k) ?? new Map<number, number>();
    v.set(lcn, (v.get(lcn) ?? 0) + 1); s.lcnVotes.set(k, v);
    let best = -1, n = 0, all = 0; for (const [l, c] of v) { all += c; if (c > n) { n = c; best = l; } }
    if (n >= 3 && n * 3 >= all * 2) {
      for (const [l, at] of s.lcns) if (at.hz === hz && at.slot === slot && l !== best) s.lcns.delete(l);
      s.lcns.set(best, { hz, slot });
    }
  }
  private unitReport(s: Sys, c: Carrier, cs: Csbk, now: number): void {
    const u = this.touchUnit(s.key, cs.unit!, c, now, 'unit report', cs, '');
    c.unitIds.set(cs.unit!, now);
    if (cs.noFix || cs.lonLo === undefined || cs.latLo === undefined) return;
    u.lonLo = cs.lonLo; u.latLo = cs.latLo; u.posMs = now; u.posVerified = cs.verified;
    const last = u.reports[u.reports.length - 1];
    if (last) { last.lonLo = cs.lonLo; last.latLo = cs.latLo; }
    if (this.ref) {
      const lat = unwrap16(cs.latLo, this.ref.lat), lon = unwrap16(cs.lonLo, this.ref.lon);
      if (last) { last.lat = round6(lat); last.lon = round6(lon); }
      const tr = u.trail[u.trail.length - 1];
      if (!tr || tr[0] !== round6(lat) || tr[1] !== round6(lon)) { u.trail.push([round6(lat), round6(lon), now]); if (u.trail.length > 30) u.trail.shift(); }
    }
  }
  private cwText(c: Carrier, text: string): void {
    const word = text.split(' ').find(looksLikeCallsign);
    this.addLog({ ms: this.now(), hz: c.hz, proto: 'CW', name: 'CW ID', text: `CW ID · ${text}`, hex: '', ok: !!word });
    if (word) { c.callsign = word; this.pending = true; }
  }

  // ------------------------------------------------------------------------------------------------ tables
  private touchUnit(sys: string, id: number, c: Carrier, now: number, kind: string, msg: Tsbk | Csbk, site: string, group?: number): Unit {
    const key = `${sys}/${id}`;
    let u = this.units.get(key);
    if (!u) { u = { key, sys, id, firstMs: now, lastMs: now, lonLo: -1, latLo: -1, posMs: 0, posVerified: false, trail: [], groups: new Set(), grants: 0, carriers: new Set(), reports: [] }; this.units.set(key, u); }
    u.lastMs = now; u.carriers.add(c.key);
    if (group !== undefined) { u.groups.add(group); this.tgFor(sys, group, now).members.add(id); }
    if (kind === 'grant' || kind === 'u2u' || kind === 'datagrant') u.grants++;
    const cs = 'verified' in msg ? msg as Csbk : null, text = cs ? csbkLine(cs) : tsbkLine(msg as Tsbk);
    u.reports.push({ ms: now, hz: c.hz, kind: `${kind}${site ? ` · site ${site}` : ''}`, hex: msg.hex, verified: cs ? cs.verified : true, lat: null, lon: null, text });
    if (u.reports.length > 60) u.reports.shift();
    this.pending = true;
    return u;
  }
  private tgFor(sys: string, tg: number, now: number): Tg {
    const key = `${sys}/${tg}`;
    let t = this.tgs.get(key);
    if (!t) { t = { key, sys, tg, firstMs: now, lastMs: now, grants: 0, recent: [], members: new Set(), history: [] }; this.tgs.set(key, t); }
    return t;
  }
  /** A grant, or an update of one already on the feed (the same talkgroup on the same channel within 5 s). */
  private grant(sys: string, g: GrantRow, update: boolean): void {
    const same = this.grants.find(x => x.sys === sys && x.tg === g.tg && x.ch === g.ch && x.group === g.group && g.ms - x.lastMs < 5_000);
    if (same) { same.lastMs = g.ms; if (g.src && !same.src) same.src = g.src; this.pending = true; return; }
    if (update && !g.tg) return;
    this.grants.unshift(g); if (this.grants.length > 300) this.grants.length = 300;
    if (g.group) {
      const t = this.tgFor(sys, g.tg, g.ms);
      t.lastMs = g.ms; t.grants++; t.recent.push(g.ms); t.recent = t.recent.filter(x => g.ms - x < 600_000);
      t.history.unshift(g); if (t.history.length > 60) t.history.length = 60;
      if (g.src) t.members.add(g.src);
    }
    this.pending = true;
  }
  private addLog(r: LogRow): void {
    this.log.push(r); if (this.log.length > 20_000) this.log.splice(0, 5_000);
    const k = `${r.hz}|${r.hex || r.text}`, last = this.logSeen.get(k);
    this.logSeen.set(k, r.ms);
    if (this.logSeen.size > 4000) { for (const [kk, t] of this.logSeen) if (r.ms - t > 30_000) this.logSeen.delete(kk); }
    if (last !== undefined && r.ms - last < 30_000) return;
    const t = new Date(r.ms).toTimeString().slice(0, 8);
    this.emit?.({ type: 'packet', line: `${t} ${r.proto} ${(r.hz / 1e6).toFixed(5)} ${r.text}${r.hex && !r.text.includes(r.hex) ? ` · ${r.hex}` : ''}` });
  }

  // ------------------------------------------------------------------------------------------------ output
  private resolvePos(u: Unit): [number | null, number | null] {
    if (!this.ref || u.lonLo < 0) return [null, null];
    return [round6(unwrap16(u.latLo, this.ref.lat)), round6(unwrap16(u.lonLo, this.ref.lon))];
  }
  /** The receiver's position arrived or moved: every stored report is resolved against it again. */
  setRef(lat: number, lon: number): void {
    this.ref = { lat, lon };
    for (const u of this.units.values()) {
      if (u.lonLo < 0) continue;
      for (const r of u.reports) if (r.lonLo !== undefined && r.latLo !== undefined) { r.lat = round6(unwrap16(r.latLo, lat)); r.lon = round6(unwrap16(r.lonLo, lon)); }
      const [la, lo] = this.resolvePos(u);
      if (la !== null && lo !== null && !u.trail.length) u.trail.push([la, lo, u.posMs]);
    }
    this.post(true);
  }
  private dmrSites(s: Sys): SiteRow[] {
    const cs = [...this.carriers.values()].filter(c => c.sys === s.key);
    const parent = new Map<number, number>(cs.map(c => [c.key, c.key]));
    const find = (k: number): number => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
    const owner = new Map<number, number>();
    for (const c of cs) for (const id of c.unitIds.keys()) { const o = owner.get(id); if (o === undefined) owner.set(id, c.key); else parent.set(find(c.key), find(o)); }
    for (const a of cs) for (const b of cs) if (a.callsign && a.callsign === b.callsign) parent.set(find(a.key), find(b.key));
    const groups = new Map<number, Carrier[]>();
    for (const c of cs) { const r = find(c.key); (groups.get(r) ?? groups.set(r, []).get(r)!).push(c); }
    let n = 0;
    return [...groups.values()].sort((a, b) => Math.min(...a.map(c => c.firstMs)) - Math.min(...b.map(c => c.firstMs))).map(g => {
      n++;
      const call = g.find(c => c.callsign)?.callsign ?? '', keys = new Set(g.map(c => c.key));
      const lcns = [...s.lcns].filter(([, v]) => keys.has(gridKey(v.hz)) || g.some(c => c.hz === v.hz)).map(([lcn, v]) => ({ lcn, hz: v.hz, slot: v.slot })).sort((a, b) => a.lcn - b.lcn);
      const ids = new Set<number>(); for (const c of g) for (const id of c.unitIds.keys()) ids.add(id);
      return { key: `${s.key}/${n}`, label: call || (s.net >= 0 ? `site ${s.net}` : `site ${n}`), rfss: -1, site: n, nac: -1, ccHz: g.map(c => c.hz).sort((a, b) => a - b),
        lastMs: Math.max(...g.map(c => c.lastMs)), levelDb: Math.max(...g.map(c => c.levelDb)), neighbors: [], secondary: [], time: '', callsign: call,
        carriers: g.map(c => c.key), lcns, rest: s.rest, busy: s.busy, idens: [], units: ids.size, lra: -1, cls: -1 };
    });
  }
  snapshot(): FleetSnap {
    const now = this.now();
    const unitSite = new Map<string, string>();
    const systems: SystemRow[] = [...this.systems.values()].map(s => {
      let sites: SiteRow[];
      if (s.proto === 'P25') {
        sites = [...this.sites.values()].filter(x => x.sys === s.key).map(x => {
          const tables = new Map(s.idens); for (const [k, v] of x.idens) tables.set(k, v);
          const ccs = [...x.carriers].map(k => this.carriers.get(k)!).filter(Boolean);
          return { key: x.key, label: `${x.rfss}.${x.site}`, rfss: x.rfss, site: x.site, nac: x.nac, ccHz: ccs.map(c => c.hz), lastMs: x.lastMs, levelDb: Math.max(...ccs.map(c => c.levelDb)),
            neighbors: [...x.neighbors.values()].map(nb => { const r = resolveChannel(nb.ch, tables); return { label: `${nb.rfss}.${nb.site}`, hz: r?.hz ?? 0, ch: h(nb.ch, 4), sys: nb.sys, heard: [...this.sites.values()].some(o => o.sys === s.key && o.rfss === nb.rfss && o.site === nb.site) }; }).sort((a, b) => a.hz - b.hz),
            secondary: [...x.secondary].map(ch => ({ ch: h(ch, 4), hz: resolveChannel(ch, tables)?.hz ?? 0 })), time: x.time, callsign: ccs.find(c => c.callsign)?.callsign ?? '',
            carriers: [...x.carriers], lcns: [], rest: -1, busy: [], idens: [...tables.values()].sort((a, b) => a.iden - b.iden), units: 0, lra: x.lra, cls: x.cls };
        });
      } else sites = this.dmrSites(s);
      for (const st of sites) for (const k of st.carriers) for (const u of this.units.values()) if (u.sys === s.key && u.carriers.has(k)) unitSite.set(u.key, st.label);
      const label = s.proto === 'P25' ? `WACN ${h(s.wacn, 5)} · SYSTEM ${h(s.sysId, 3)}` : s.net >= 0 ? `${s.model} NETWORK ${s.net}` : `COLOR CODE ${s.cc}${s.fid > 0 ? ` · FID ${h(s.fid, 2)}` : ''}`;
      const units = [...this.units.values()].filter(u => u.sys === s.key).length, tgs = [...this.tgs.values()].filter(t => t.sys === s.key).length;
      return { key: s.key, proto: s.proto, color: s.color, label, wacn: s.wacn, sysId: s.sysId, cc: s.cc, fid: s.fid, net: s.net, model: s.model,
        callsign: sites.find(x => x.callsign)?.callsign ?? '', firstMs: s.firstMs, lastMs: s.lastMs, sites, idens: [...s.idens.values()].sort((a, b) => a.iden - b.iden),
        grants: this.grants.filter(g => g.sys === s.key).length, units, tgs, derived: s.derived };
    }).sort((a, b) => a.firstMs - b.firstMs);
    const units: UnitRow[] = [...this.units.values()].map(u => {
      const [lat, lon] = this.resolvePos(u);
      return { key: u.key, sys: u.sys, id: u.id, firstMs: u.firstMs, lastMs: u.lastMs, lat, lon, posMs: u.posMs, posVerified: u.posVerified, trail: u.trail.slice(-12),
        groups: [...u.groups], grants: u.grants, carriers: [...u.carriers], reports: u.reports.slice(-6).map(r => ({ ...r, lonLo: undefined, latLo: undefined })), site: unitSite.get(u.key) ?? '' };
    });
    const tgs: TgRow[] = [...this.tgs.values()].map(t => ({ key: t.key, sys: t.sys, tg: t.tg, firstMs: t.firstMs, lastMs: t.lastMs, grants: t.grants, recent: t.recent.filter(x => now - x < 600_000), members: [...t.members].slice(0, 200), history: t.history.slice(0, 12) }));
    const carriers: CarrierRow[] = [...this.carriers.values()].map(c => {
      const { lastAuditionMs: _a, p25: _p, dmrSys: _d, tables: _t, unitIds: _u, hdr: _h, ...row } = c;
      return { ...row };
    }).sort((a, b) => a.hz - b.hz);
    return { type: 'fleet', centerHz: this.centerHz, rate: this.rate, spanLo: this.spanLo, spanHi: this.spanHi, carriers, systems, units, tgs, grants: this.grants.slice(0, 120),
      perMin: this.grants.filter(g => now - g.ms < 60_000).length, blocks: this.blocks, slots: this.chans.size, ref: this.ref !== null };
  }
  /** A carrier at [hz] as if found in the span (recorded blocks are replayed through it). */
  carrierAt(hz: number): Carrier {
    const key = gridKey(hz), now = this.now();
    let c = this.carriers.get(key);
    if (!c) {
      c = { key, hz, levelDb: 0, peakDb: 0, firstMs: now, lastMs: now, onMs: 0, heardMs: 0, cls: '', role: '', sys: '', nac: -1, cc: -1, frames: 0, blocks: 0, crcOk: 0, lastDecodeMs: 0,
        envCv: 0, eye: 0, decoding: false, callsign: '', tdma: false, lcn: '', lastAuditionMs: 0, p25: { sys: -1, wacn: -1, rfss: -1, site: -1 }, dmrSys: '', tables: new Map(), unitIds: new Map() };
      this.carriers.set(key, c);
    }
    return c;
  }
  /** One recorded P25 trunking block (12 bytes, CRC included) heard on [hz]. */
  feedP25(hz: number, nac: number, bytes: Uint8Array): void {
    const c = this.carrierAt(hz);
    this.p25Frame(c, nac, 7);
    this.p25Block(c, null, { nac, nidErrs: 0, bytes, crcOk: crc12Ok(bytes), metric: 0, index: 0 });
  }
  /** One recorded DMR burst's contents heard on [hz]. */
  feedDmr(hz: number, slot: number, cc: number, dt: number, bytes: Uint8Array): void {
    this.dmrBurst(this.carrierAt(hz), null, { burst: { slot, cc, dt, stErrs: 0, bytes, busy: 1 }, dibits: new Uint8Array(0) });
  }
  /** A recorded channel clip, complex baseband at [fs] mixed to 0 Hz from [hz]: decoded as a channel of the span. */
  feedBaseband(hz: number, fs: number, zi: Float32Array, zq: Float32Array, n: number): void {
    const c = this.carrierAt(hz), now = this.now();
    let ch = this.chans.get(c.key);
    if (!ch) { ch = new Chan(c.key, hz, hz, fs * 4, now, fs); this.open(c, now, ch); }
    c.lastMs = now; c.decoding = true;
    // the same channel filter the down-converter applies: a neighbor 12.5 kHz away is inside a 48 kS/s clip
    const f = this.bbFir.get(c.key) ?? (() => { const t = lowpassTaps(CUT_HZ / fs, 127); const v = [new RealFir(t), new RealFir(t)] as [RealFir, RealFir]; this.bbFir.set(c.key, v); return v; })();
    const fi = new Float32Array(n), fq = new Float32Array(n);
    f[0].process(zi, n, fi); f[1].process(zq, n, fq);
    ch.channel(fi, fq, n, now);
  }
  /** The end of a recording: the samples still waiting for a whole timing block are decoded too. */
  flush(): void { for (const ch of this.chans.values()) ch.rx.flush(); }
  /** A CW ID read on [hz]. */
  feedCw(hz: number, text: string): void { this.cwText(this.carrierAt(hz), text); }
  /** Everything held about one unit, for its detail view. */
  unitDetail(key: string): { key: string; reports: UnitReport[]; trail: [number, number, number][] } | null {
    const u = this.units.get(key); if (!u) return null;
    return { key, reports: u.reports.map(r => ({ ms: r.ms, hz: r.hz, kind: r.kind, hex: r.hex, verified: r.verified, lat: r.lat, lon: r.lon, text: r.text })), trail: u.trail };
  }
  /** The block log as CSV, and the tables as JSON. */
  exportAll(): { csv: string; json: string } {
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = 'utc,mhz,protocol,type,crc_ok,fields,hex\n' + this.log.map(r => [new Date(r.ms).toISOString(), (r.hz / 1e6).toFixed(5), r.proto, q(r.name), r.ok ? 1 : 0, q(r.text), r.hex].join(',')).join('\n') + '\n';
    const s = this.snapshot();
    const json = JSON.stringify({ exported: new Date(this.now()).toISOString(), systems: s.systems, carriers: s.carriers, talkgroups: s.tgs, grants: this.grants,
      units: [...this.units.values()].map(u => ({ sys: u.sys, id: u.id, first: new Date(u.firstMs).toISOString(), last: new Date(u.lastMs).toISOString(), groups: [...u.groups], position: this.resolvePos(u), positionVerified: u.posVerified, trail: u.trail, reports: u.reports })) }, null, 1);
    return { csv, json };
  }
  private post(force = false): void {
    const t = this.now();
    if (!force && t - this.lastPost < 500) { this.pending = true; return; }
    this.pending = false; this.lastPost = t;
    this.emit?.(this.snapshot() as unknown as Record<string, unknown>);
  }
  clear(): void {
    this.carriers.clear(); this.systems.clear(); this.sites.clear(); this.units.clear(); this.tgs.clear(); this.grants = []; this.log.length = 0; this.logSeen.clear();
    this.chans.clear(); this.blocks = 0; this.colorNext = 0;
    this.post(true);
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
export type { Field };
