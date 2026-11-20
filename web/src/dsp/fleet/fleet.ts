/**
 * Dispatch: a receive-only monitor for P25, DMR, TETRA, NXDN and Motorola Type II trunked radio. Finds every carrier in the span, gives the live
 * ones a channel each (the control channels and the channels of calls on the air keep theirs, the rest take turns),
 * decodes the control signaling and builds the systems, sites, channel tables, grants, registrations, unit positions
 * and calls from what is on the air. Labels are only what the air carries. Publishes a 'fleet' snapshot (at most two
 * a second) and 'packet' log lines.
 */
import { fft, hann } from '../../fft.js';
import type { Emit, IqProcessor } from '../core.js';
import { Ddc } from '../trains.js';
import { RealFir, lowpassTaps } from '../ham/filters.js';
import { crc12Ok, DMR_CRC_MASK, hex } from './codes.js';
import { parseTsbk, resolveChannel, svcFlags, tsbkLine, h, type Field, type Iden, type Tsbk } from './tsbk.js';
import { parseCsbk, unwrap16, csbkLine, VendorCheck, type Csbk } from './csbk.js';
import { SymbolRx, P25Framer, DmrFramer, CwReader, looksLikeCallsign, slice, type P25Block, type DmrEvent } from './rx.js';
import { P25Decoder } from '../ham/p25.js';
import './vocoders.js';
import { CallTracker, type CallRow, type CallPos, type CallProto, type Lock, type TgPrefs } from './calls.js';
import { parseLc, voiceFrames, readEmb, embBits, EmbLcAssembler, parseEmbLc, TalkerAlias } from './lc.js';
import { hasCodec, type CodecId } from './codec.js';
import { TetraRx, type TetraSync } from './tetra.js';
import { TetraMac, tetraCarrierHz, tetraDisconnectCause, tetraGrantName, tetraCommName, type TetraEvent, type TetraSysinfo, type TetraCmce, type TetraMacInfo } from './tetra-mac.js';
import { NxdnRx, NxdnPlan, NXDN_CATEGORY, nxdnLine, nxdnId, type NxdnSite, type NxdnMsg, type NxdnTraffic, type NxdnScch, type NxdnAdj } from './nxdn.js';
import { OswRx, OswParser, FmVoice, provePlan, tgOf, tgStatus, oswHex, oswWordText, type Osw, type OswEvent, type OswPlan } from './smartnet.js';
import { P2Rx, p2Messages, p2Ptt, p2EndPtt, MAC_OPS, type P2Mac, type P2Seed } from './p2.js';

export const CH_RATE = 24_000;
/** How far from its system's area a DMR unit position may resolve, and from the receiver before the area is known (km). */
export const PLACE_KM = 80, PLACE_RX_KM = 150;
/** Distance in km between two points (equirectangular, plenty for a region). */
export const kmBetween = (a: number, b: number, c: number, d: number): number => {
  const r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
  return 6371 * Math.hypot(x, y);
};
const CUT_HZ = 5_500;
/**
 * Turns on a channel for carriers nothing has decoded lately go two ways at once. Full looks of [AUDITION_MS] (long enough
 * for NXDN and TETRA, whose receivers start 1.5 s in) for the strong new carriers ([FULL_DB] over the floor and off any
 * stronger one's skirt), strongest first, and after them for every carrier in turn, the one waiting longest first. Quick
 * looks of [AUDITION_FIRST_MS] for the weaker new ones, strongest first (a control channel at a fair level shows its syncs
 * well inside one), held for [AUDITION_MS] when something on it looked like a signal Dispatch reads (syncs, words through
 * their check, training sequences).
 */
const AUDITION_MS = 3_000, AUDITION_FIRST_MS = 500, FULL_DB = 20;
/** The quickest a carrier is classed analog or otherwise. */
const CLASS_MS = 1_500;
/** A control channel found on a turn keeps its channel until its system is read, up to this long. */
const IDENTIFY_MS = 10_000;
/** More control channels than channels for them: each holds one this long, then the one waiting longest takes it. */
const CORE_TURN_MS = 20_000;
/** A carrier classed analog or unknown, or one already identified that is not a control channel, waits this long for another turn. */
const RECHECK_MS = 300_000;
/** When the span has more carriers than channels, this many channels stay free for turns while new carriers wait (one after). */
const TURN_CHANNELS = 2;
const LIVE_MS = 4_000;

export type SysProto = 'P25' | 'DMR' | 'TETRA' | 'NXDN' | 'SMARTNET';
export type CarrierClass = '' | 'TETRA' | 'NXDN48' | 'NXDN96' | 'P25 C4FM' | 'P25 CQPSK/LSM' | 'P25 PHASE 2 TDMA' | 'DMR' | 'ANALOG FM' | 'UNKNOWN 4FSK' | 'UNKNOWN LINEAR' | 'MOTOROLA TYPE II';
export type Role = '' | 'control' | 'voice' | 'rest' | 'data';
export interface CarrierRow {
  key: number; hz: number; levelDb: number; peakDb: number; firstMs: number; lastMs: number; onMs: number; heardMs: number;
  cls: CarrierClass; role: Role; sys: string; nac: number; cc: number; frames: number; blocks: number; crcOk: number;
  lastDecodeMs: number; envCv: number; eye: number; decoding: boolean; callsign: string; tdma: boolean; lcn: string;
  /** When the channel last keyed its CW ID. */
  callsignMs: number;
}
export interface SiteRow {
  key: string; label: string; rfss: number; site: number; nac: number; ccHz: number[]; lastMs: number; levelDb: number;
  neighbors: { label: string; hz: number; ch: string; sys: number; heard: boolean }[]; secondary: { hz: number; ch: string }[];
  time: string; callsign: string; carriers: number[]; lcns: { lcn: number; hz: number; slot: number }[]; rest: number; busy: number[];
  idens: Iden[]; units: number; lra: number; cls: number;
}
export interface SystemRow {
  key: string; proto: SysProto; color: number; label: string; wacn: number; sysId: number; cc: number; fid: number;
  net: number; model: string; callsign: string; firstMs: number; lastMs: number; sites: SiteRow[]; idens: Iden[];
  /** How a DMR system trunks, from what its channels send: 'CAPACITY PLUS' (rest-channel beacons), 'TIER III' (Aloha and grants). */
  trunk: string;
  /** The latest CW ID heard on any of the system's channels (control, voice, conventional): text, when, where. */
  cwId: string; cwIdMs: number; cwIdHz: number;
  grants: number; units: number; tgs: number; derived: boolean;
  /** DMR logical channels resolved to MHz from grants and the voice link control that followed them (derived). */
  lpcns: { lpcn: number; hz: number; votes: number }[];
  /** The channels the system was heard on (kept when it is out of the span), and whether its units report positions. */
  heardHz: number[]; positions: boolean;
  /** TETRA: what the cell broadcasts and the MAC headers say about air interface encryption ('' for the others). */
  security: string;
}
export interface UnitReport { ms: number; hz: number; kind: string; hex: string; verified: boolean; lat: number | null; lon: number | null; text: string; /** The carrier's level when it was heard (dB over the floor). */ db?: number }
export interface UnitRow {
  key: string; sys: string; id: number; firstMs: number; lastMs: number; lat: number | null; lon: number | null; posMs: number;
  posVerified: boolean; trail: [number, number, number][]; groups: number[]; grants: number; carriers: number[]; reports: UnitReport[]; site: string;
  /** Talkgroups the unit was heard on, with how many times. */
  tgCounts: [number, number][];
  /** The talker alias its radio sent (DMR), or ''. */
  alias: string;
  /** Position reports that resolved outside the system's area (left off the map), and all position reports. */
  offArea: number; fixes: number;
}
export interface GrantRow { ms: number; lastMs: number; sys: string; kind: string; tg: number; group: boolean; src: number; ch: string; hz: number; slot: number; tdma: boolean; emergency: boolean; encrypted: boolean; carrierHz: number; site: string; lpcn?: number; chDerived?: boolean; efr?: boolean }
export interface TgRow { key: string; sys: string; tg: number; firstMs: number; lastMs: number; grants: number; recent: number[]; members: number[]; history: GrantRow[] }
export interface LogRow { ms: number; hz: number; proto: string; name: string; text: string; hex: string; ok: boolean }
export interface FleetSnap {
  type: 'fleet'; centerHz: number; rate: number; spanLo: number; spanHi: number; carriers: CarrierRow[]; systems: SystemRow[];
  units: UnitRow[]; tgs: TgRow[]; grants: GrantRow[]; perMin: number; blocks: number; slots: number; ref: boolean;
  calls: CallRow[]; follow: { key: string; hz: number } | null; codecs: CodecId[];
  /** The call being heard (its key), and the system lock in force. */
  playing: string; lock: Lock | null;
}
export type { CallRow, CallPos, Lock, TgPrefs };
/** What the device keeps between sessions (see FleetProcessor.known). */
export interface KnownSystem { key: string; proto: SysProto; wacn: number; sysId: number; cc: number; fid: number; net: number; model: string; firstMs: number; lastMs: number; derived: boolean; hz: number[] }
export interface KnownUnit { sys: string; id: number; lat: number; lon: number; posMs: number; verified: boolean; firstMs: number; lastMs: number }
export interface KnownState { v: 1; systems: KnownSystem[]; units: KnownUnit[] }
const KNOWN_UNITS = 3000;

interface Carrier extends CarrierRow { tetra?: TetraSync; tetraCell?: TetraSysinfo; nxdn?: NxdnSite & { baud: number }; nxdnAdj?: Map<string, NxdnAdj>; nxdnRan?: number; nxdnRanN?: number;
  /** A Type-D repeater's call as its SCCH builds it up: source (INFO3), destination (INFO2/INFO4), cipher (INFO1). */
  nxdnD?: { src: number; dst: number; group: boolean; cipher: number; keyId: number; ms: number }; hdr?: { ms: number; slot: number }; lastAuditionMs: number;
  /** Motorola Type II: the channel number the control channel announces for itself, and the plan that number proved. */
  osw?: { cc: number; plan: OswPlan | null };
  /** Turns the carrier has had on a channel, and its level at the last. */
  turns: number; turnDb: number;
  p25: { sys: number; wacn: number; rfss: number; site: number }; dmrSys: string; tables: Map<number, Iden>; unitIds: Map<number, number> }
interface Site {
  key: string; sys: string; rfss: number; site: number; nac: number; carriers: Set<number>; lastMs: number; neighbors: Map<string, { sys: number; rfss: number; site: number; ch: number }>;
  secondary: Set<number>; time: string; lra: number; cls: number; idens: Map<number, Iden>;
}
interface Sys {
  key: string; proto: SysProto; color: number; wacn: number; sysId: number; cc: number; fid: number; net: number; model: string;
  firstMs: number; lastMs: number; idens: Map<number, Iden>; derived: boolean; trunk?: string;
  lcns: Map<number, { hz: number; slot: number }>; lcnVotes: Map<string, Map<number, number>>; rest: number; busy: number[];
  /** Tier III logical channel (LPCN) to carrier: votes, and the ones resolved. */
  lpcnVotes: Map<number, Map<number, number>>; lpcnHz: Map<number, number>;
  /** Where the system was heard (its control or rest channels), kept across retunes and sessions. */
  heardHz: Set<number>;
  /** TETRA: calls by call identifier, and the air interface encryption seen. */
  tetra?: TetraSys;
  /** NXDN: the channel plan learned from what was heard, and the symbol rate of the system's channels. */
  nxdnPlan?: NxdnPlan; nxdnBaud?: number;
  /** Motorola Type II: the channel plan its control channel proved (null until one does), and the channels granted (count). */
  osw?: { plan: OswPlan | null; chans: Map<number, number> };
}
interface TetraSys { calls: Map<number, { tg: number; group: boolean; src: number; hz: number; slot: number; e2ee: boolean; ms: number }>; encSdus: number; clearSdus: number; aie: boolean; sec: TetraSysinfo['security']; carriers: Map<number, number> }
interface Unit { key: string; sys: string; id: number; firstMs: number; lastMs: number; lonLo: number; latLo: number; posMs: number; posVerified: boolean; trail: [number, number, number][]; groups: Set<number>; grants: number; carriers: Set<number>; reports: (UnitReport & { lonLo?: number; latLo?: number })[];
  /** Every position report as sent (low 16 bits), resolved when shown: [time, lat16, lon16]. */
  fixes: [number, number, number][]; tgCounts: Map<number, number>;
  /** The talker alias its radio sent (DMR), or ''. */
  alias?: string;
  /** A position kept from an earlier session (restored from the device), used until a report on the air replaces it. */
  fix?: [number, number] }
interface Tg { key: string; sys: string; tg: number; firstMs: number; lastMs: number; grants: number; recent: number[]; members: Set<number>; history: GrantRow[] }

/** Channels a span can run at once: the down-converters cost in proportion to the sample rate. */
export const channelBudget = (rate: number) => Math.max(4, Math.min(24, Math.floor(110e6 / Math.max(rate, 1))));
const gridKey = (hz: number) => Math.round(hz / 6250) * 6250;
/** TETRA is not tried on 925 to 960 MHz (the 900 MHz land mobile and GSM downlink band), where none is allocated. */
const tetraBand = (hz: number) => hz < 925e6 || hz > 960e6;

class Chan {
  readonly ddc = new Ddc(CUT_HZ, CH_RATE, 127);
  rx!: SymbolRx;
  readonly p25 = new P25Framer();
  readonly p25v = new P25Decoder();
  /** Symbols so far, the P25 voice decoder's clock; [lcErrs] its failure count at the last link control read. */
  t = 0; lcErrs = 0;
  readonly dmr = new DmrFramer();
  /** Motorola Type II signaling words, and analog FM voice on a channel a Type II grant named. */
  osw!: OswRx; fm: FmVoice | null = null;
  cw!: CwReader;
  oi = new Float32Array(0); oq = new Float32Array(0);
  openedMs: number; lastSyncMs = 0; quietSince: number; private cwOn = false;
  /** The Phase 2 TDMA receiver, on a channel a grant named TDMA. */
  p2: P2Rx | null = null; readonly fs: number;
  /** A TETRA receiver on its own wider down-converter (a TETRA carrier is 25 kHz wide), for a carrier nothing else read. */
  tetra: { rx: TetraRx; ddc: Ddc | null; oi: Float32Array; oq: Float32Array } | null = null;
  /** NXDN frame syncs on their grid seen so far, and the callback when more come (the baud they came at). */
  private nxdnGrid = 0;
  onNxdnSync: (baud: number) => void = () => undefined;
  nxdnSyncCheck(): void {
    if (!this.nxdn) return;
    for (const r of this.nxdn) { if (r.framer.steady && r.framer.gridSyncs > this.nxdnGrid + 2) { this.nxdnGrid = r.framer.gridSyncs; this.onNxdnSync(r.baud); } }
  }
  /** NXDN receivers (NXDN48 and NXDN96) on the channel baseband, for a carrier nothing else read; the one that locks stays. */
  nxdn: NxdnRx[] | null = null;
  /** The TETRA MAC on the TETRA receiver's bursts. */
  tetraMac: TetraMac | null = null;
  /**
   * NXDN96's own down-converter on a span channel: 48 kS/s and 7 kHz wide, so its 4800 symbols a second get ten samples
   * each (at the channel's 24 kS/s the symbol timing slips now and then) and its outer deviation is not clipped.
   */
  nxdnDdc: { ddc: Ddc; oi: Float32Array; oq: Float32Array } | null = null;
  /** The sample rate an NXDN receiver at [baud] gets: [wide] for an NXDN96 channel known as one. */
  nxdnFs(baud: number, wide: boolean): number {
    if (!wide || baud === 2400 || this.rate === 0) return this.fs;
    if (!this.nxdnDdc) { const d = new Ddc(7_000, 48_000, 63); d.reset(this.rate); d.offsetHz = this.hz - this.center; this.nxdnDdc = { ddc: d, oi: new Float32Array(0), oq: new Float32Array(0) }; }
    return this.nxdnDdc.ddc.outRate;
  }
  private center = 0; private rate = 0;
  /** Fed a recorded channel at its own rate (no down-converter, so no DC spike of the receiver's). */
  get baseband(): boolean { return this.rate === 0; }
  /** [baseband]: samples arrive already mixed to 0 Hz at that rate (a recorded channel clip), no down-converter. */
  constructor(readonly key: number, public hz: number, center: number, rate: number, now: number, baseband = 0) {
    this.ddc.reset(rate); this.ddc.offsetHz = hz - center;
    this.center = center; this.rate = baseband ? 0 : rate;
    const fs = baseband || this.ddc.outRate;
    this.fs = fs;
    this.rx = new SymbolRx(fs);
    this.osw = new OswRx(fs);
    this.cw = new CwReader(fs);
    // the voice frames' payload (nine vocoder frames and the link control of each LDU) is read by the HAM receiver's
    // P25 decoder, driven by this channel's frame syncs
    this.rx.onSymbol = s => {
      if ((this.t & 31) === 0) this.fillDue();
      const n0 = this.p25.syncs;
      this.p25.push(s); this.dmr.push(s);
      if (this.p25.syncs !== n0) this.p25v.sync(this.t); else this.p25v.push(slice(s), this.t);
      this.t++;
    };
    this.openedMs = now; this.quietSince = now;
  }
  /**
   * Lost voice is filled, not left silent: a P25 LDU (9 frames, 864 symbols) or a DMR voice burst (3 frames, 60 ms a
   * slot) that does not come when due is replaced by erasures, which the vocoder answers with the last frame repeated
   * and faded to a faint floor. So the player never runs dry inside a call. The fill never starts, extends, takes or
   * keeps a call (the fleet drops it for a call no longer on the air), and stops 5 s after the lane's last voice.
   */
  onFill: (lane: number, frames: number) => void = () => undefined;
  /** Lanes: 0 and 1 the DMR slots, 2 P25. Symbol time of the last voice, and when the next fill falls due. */
  private readonly lastVoice = [-1e9, -1e9, -1e9]; private readonly due = [Infinity, Infinity, Infinity];
  /** Voice arrived on a lane (DMR slot 0 or 1, or 2 for P25). */
  voiced(lane: number): void { const per = lane === 2 ? 864 : 288; this.lastVoice[lane] = this.t; this.due[lane] = this.t + per + (lane === 2 ? 216 : 96); }
  private fillDue(): void {
    for (let lane = 0; lane < 3; lane++) {
      if (this.t < this.due[lane]) continue;
      if (this.t - this.lastVoice[lane] > 24_000) { this.due[lane] = Infinity; continue; }
      const per = lane === 2 ? 864 : 288;
      this.due[lane] += per;
      this.onFill(lane, lane === 2 ? 9 : 3);
    }
  }
  /** Something on the channel looks like a signal Dispatch reads (syncs, words through their check, training sequences). */
  hinted(): boolean {
    return this.p25.clean > 0 || this.p25.syncs >= 2 || this.dmr.syncs >= 2 || this.osw.good >= 2 || (this.nxdn?.some(r => r.framer.gridSyncs > 0) ?? false)
      || (this.tetra ? this.tetra.rx.stats.bschOk > 0 || this.tetra.rx.stats.trainings >= 3 : false);
  }
  /** The turn of a carrier nothing has decoded is over. */
  turnOver(now: number): boolean { return now - this.openedMs >= (this.quick && !this.hinted() ? AUDITION_FIRST_MS : AUDITION_MS); }
  /** The turn is a quick first look. */
  quick = false;
  retarget(center: number): void { this.ddc.offsetHz = this.hz - center; this.center = center; if (this.tetra?.ddc) this.tetra.ddc.offsetHz = this.tetraHz - center; if (this.nxdnDdc) this.nxdnDdc.ddc.offsetHz = this.hz - center; }
  /** Where the TETRA receiver is centered: the middle of the whole 25 kHz signal, not of the piece the finder saw. */
  private tetraHz = 0;
  /** Starts the TETRA receiver: 72 kS/s off its own down-converter, or the baseband itself when it is fast enough. */
  tetraOn(hz = this.hz): TetraRx | null {
    if (this.tetra) return this.tetra.rx;
    if (this.rate > 0) { const d = new Ddc(13_500, 72_000, 63); d.reset(this.rate); d.offsetHz = hz - this.center; this.tetraHz = hz; this.tetra = { rx: new TetraRx(d.outRate), ddc: d, oi: new Float32Array(0), oq: new Float32Array(0) }; }
    else if (this.fs >= 36_000) this.tetra = { rx: new TetraRx(this.fs), ddc: null, oi: new Float32Array(0), oq: new Float32Array(0) };
    return this.tetra?.rx ?? null;
  }
  push(fi: Float32Array, fq: Float32Array, n: number, now: number): void {
    const need = this.ddc.maxOut(n);
    if (this.oi.length < need) { this.oi = new Float32Array(need); this.oq = new Float32Array(need); }
    const m = this.ddc.push(fi, fq, n, this.oi, this.oq);
    this.channel(this.oi, this.oq, m, now);
    const x = this.nxdnDdc;
    if (x && this.nxdn?.some(r => r.fs !== this.fs)) {
      const k = x.ddc.maxOut(n); if (x.oi.length < k) { x.oi = new Float32Array(k); x.oq = new Float32Array(k); }
      const j = x.ddc.push(fi, fq, n, x.oi, x.oq);
      for (const r of this.nxdn) if (r.fs !== this.fs) r.push(x.oi, x.oq, j);
    } else if (x && this.nxdn) this.nxdnDdc = null;
    const t = this.tetra;
    if (t?.ddc) { const k = t.ddc.maxOut(n); if (t.oi.length < k) { t.oi = new Float32Array(k); t.oq = new Float32Array(k); } const j = t.ddc.push(fi, fq, n, t.oi, t.oq); t.rx.push(t.oi, t.oq, j); }
  }
  /** Baseband straight to the TETRA receiver (a recorded or synthesized channel at its own rate). */
  tetraBaseband(zi: Float32Array, zq: Float32Array, m: number): void { if (this.tetra && !this.tetra.ddc) this.tetra.rx.push(zi, zq, m); }
  channel(zi: Float32Array, zq: Float32Array, m: number, now: number): void {
    // decoded frames, not bare syncs, mark the channel digital: a keyed CW tone can pass for a sync now and then
    const s0 = this.p25.clean + this.dmr.bursts;
    this.rx.push(zi, zq, m);
    this.osw.push(zi, zq, m); this.fm?.push(zi, zq, m);
    this.p2?.push(zi, zq, m);
    if (this.nxdn) for (const r of this.nxdn) if (r.fs === this.fs) r.push(zi, zq, m);
    this.nxdnSyncCheck();
    if (this.p25.clean + this.dmr.bursts !== s0) { this.lastSyncMs = now; this.quietSince = now; this.cwOn = false; }
    // a CW ID comes once the digital signal has stopped (a voice channel's frames are 180 ms apart); the reader starts
    // fresh then, so the digital signal's levels do not hide the tone
    else if (now - this.lastSyncMs > 250) { if (!this.cwOn) { this.cw.reset(); this.cwOn = true; } this.cw.push(zi, zq, m); }
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
  readonly calls = new CallTracker(() => this.now());
  private readonly p25Seen = new Map<number, number>();
  private readonly dmrSeen = new Map<number, number>();
  /** When each carrier last sent a Phase 2 sync pair: DMR syncs read off a Phase 2 signal are not DMR. */
  private readonly p2Seen = new Map<number, number>();
  /** DMR grants of the last moments, waiting for the voice link control that says which carrier their channel is. */
  private pendingGrants: { sys: string; tg: number; group: boolean; lpcn: number; slot: number; ms: number }[] = [];

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
      const n0 = this.carriers.size, c = this.carrierAt(Math.abs(hz - key) < 1_500 ? key : Math.round(hz / 100) * 100), fresh = this.carriers.size > n0;
      seen.add(c.key);
      if (fresh) { c.levelDb = db; c.peakDb = db; }
      if (now - c.lastMs < 2_000) c.onMs += now - c.lastMs;
      c.lastMs = now; c.levelDb = Math.round(db * 10) / 10; c.peakDb = Math.max(c.peakDb, c.levelDb);
      const ch = this.chans.get(c.key); if (ch) ch.hz = hz;
    }
    for (const c of this.carriers.values()) if (!seen.has(c.key) && this.inSpan(c.hz) && now - c.lastMs > 1_000) { const ch = this.chans.get(c.key); if (ch) ch.cw.end(); }
    this.pending = true;
  }

  /** Control channels keep their channel; every other live carrier gets a turn of a few seconds. */
  private assign(now: number): void {
    const budget = channelBudget(this.rate);
    this.calls.tick(hz => { const c = this.carriers.get(gridKey(hz)); return c && now - c.lastMs < 1_500 ? c.levelDb : null; }, now);
    // the channels of calls on the air keep a channel while they last: from the grant on (the first voice frames come
    // before the spectrum shows the carrier), and past the first moments only while the carrier is up
    const pinned = this.calls.ranked().filter(x => !x.muted && !x.outside && x.hz > 0 && this.inSpan(x.hz))
      .map(x => { const c = this.carriers.get(gridKey(x.hz)); return c && now - c.lastMs < LIVE_MS ? c : now - x.startMs < 1_500 ? this.carrierAt(x.hz) : null; })
      .filter((c): c is Carrier => !!c);
    const pinnedKeys = new Set(pinned.map(c => c.key));
    const live = [...this.carriers.values()].filter(c => this.inSpan(c.hz) && now - c.lastMs < LIVE_MS);
    for (const [k, ch] of this.chans) {
      const c = this.carriers.get(k)!;
      if ((now - c.lastMs > LIVE_MS && !pinnedKeys.has(k)) || !this.inSpan(c.hz)) { this.chans.delete(k); continue; }
      this.classify(c, ch, now);
    }
    const keep = (c: Carrier) => c.lastDecodeMs > 0 && now - c.lastDecodeMs < 10_000;
    // control and rest channels, and the ones carrying unit reports, come first (the locked system's when locked);
    // the channels of calls on the air come right after them, never in their place
    const lock = this.calls.prefs.lock?.sys ?? '';
    const core0 = (c: Carrier) => (c.role === 'control' || c.role === 'rest' || this.reportsOn(c, now)) && (!lock || !c.sys || c.sys === lock);
    // one control channel a P25 site is enough: the others the same site's are heard on (a secondary control channel, or
    // the copies of a strong one the receiver makes beside it) wait their turns like any carrier
    const bestOfSite = new Map<string, Carrier>();
    for (const c of live) if (c.p25.site >= 0 && c.sys && core0(c)) { const k = `${c.sys}/${c.p25.rfss}/${c.p25.site}`, b = bestOfSite.get(k); if (!b || c.levelDb > b.levelDb) bestOfSite.set(k, c); }
    const core = (c: Carrier) => core0(c) && (c.p25.site < 0 || !c.sys || bestOfSite.get(`${c.sys}/${c.p25.rfss}/${c.p25.site}`) === c);
    // a carrier classed analog or unknown, or one a system already owns that is not a control channel, waits for its next turn
    // (a voice channel comes back through the grants that name it)
    // (one classed unknown comes back sooner when it keys up 6 dB stronger)
    const settled = (c: Carrier) => c.lastAuditionMs > 0 && now - c.lastAuditionMs < RECHECK_MS && !core(c)
      && (!!c.sys || c.cls === 'ANALOG FM' || ((c.cls === 'UNKNOWN 4FSK' || c.cls === 'UNKNOWN LINEAR') && c.levelDb < c.turnDb + 6));
    const sorted = live.filter(keep).sort((a, b) => Number(core(b)) - Number(core(a)) || b.levelDb - a.levelDb);
    // carriers still waiting for a turn keep a share of the channels free, so a span with more carriers than channels
    // visits all of them: the decoding control channels take the rest, strongest first, and the others come round
    // turns: carriers never heard first, strongest first (one sitting on the skirt of a much stronger neighbor later),
    // then the one waiting longest
    const byHz = [...live].sort((a, b) => a.hz - b.hz), score = new Map<number, number>();
    for (let i = 0; i < byHz.length; i++) {
      const c = byHz[i]; let skirt = false;
      for (let j = i - 1; j >= 0 && c.hz - byHz[j].hz <= 10_000 && !skirt; j--) skirt = byHz[j].levelDb >= c.levelDb + 15;
      for (let j = i + 1; j < byHz.length && byHz[j].hz - c.hz <= 10_000 && !skirt; j++) skirt = byHz[j].levelDb >= c.levelDb + 15;
      score.set(c.key, c.levelDb - (skirt ? 20 : 0));
    }
    const waiting = live.filter(c => !this.chans.has(c.key) && !keep(c) && !settled(c));
    // a carrier is new to the turns until it has had one, and again when it comes up 6 dB over its level then (a channel
    // that keys up now and then). The full share while new carriers or strong ones' second looks wait, one channel after.
    const fresh = (c: Carrier) => c.turns === 0 || c.levelDb >= c.turnDb + 6;
    const reserve = waiting.length && live.length > budget ? (waiting.some(fresh) ? TURN_CHANNELS : 1) : 0, cap = budget - reserve;
    // the control channels known take turns when there are more than channels for them: one holding its channel keeps
    // it for [CORE_TURN_MS], then the one that has waited longest goes next. One granting calls keeps its channel.
    const busy = new Map<number, number>();
    for (const g of this.grants) { if (now - g.lastMs > 60_000) continue; const k = gridKey(g.carrierHz); busy.set(k, (busy.get(k) ?? 0) + 1); }
    const rank = (c: Carrier) => { const ch = this.chans.get(c.key); return !ch ? 2 : busy.get(c.key) ? 0 : now - ch.openedMs < CORE_TURN_MS ? 1 : 3; };
    const coreL = live.filter(core).sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra - rb || (ra === 0 ? busy.get(b.key)! - busy.get(a.key)! : ra === 1 ? b.levelDb - a.levelDb : a.lastAuditionMs - b.lastAuditionMs);
    });
    const others = sorted.filter(c => !core(c) && !pinnedKeys.has(c.key));
    const nCore = Math.min(coreL.length, Math.max(1, cap));
    const held = coreL.slice(0, nCore), calls = pinned.filter(c => !held.includes(c));
    const want: Carrier[] = [...held, ...calls, ...others].slice(0, Math.max(cap, held.length + calls.length));
    // a carrier found decoding on its turn (a control channel, or a DMR or NXDN channel whose system its own frames name)
    // keeps the channel until its system is read
    for (const [k, ch] of this.chans) { const c = this.carriers.get(k)!; if (!want.includes(c) && (c.role === 'control' || c.role === 'rest' || (keep(c) && (c.cls === 'DMR' || c.cls.startsWith('NXDN')))) && !c.sys && now - ch.openedMs < IDENTIFY_MS) want.splice(Math.min(nCore, want.length), 0, c); }
    for (const [k, ch] of this.chans) { const c = this.carriers.get(k)!; if (!keep(c) && !ch.turnOver(now) && !want.includes(c)) want.push(c); }
    // the two ways of turns share the free channels: full looks (strong new carriers strongest first, then every
    // carrier, the one waiting longest first) and quick looks (the weaker new carriers, strongest first)
    const free = live.filter(c => !want.includes(c) && !settled(c));
    const fullQ = free.filter(c => !fresh(c) || score.get(c.key)! >= FULL_DB).sort((a, b) => Number(fresh(b)) - Number(fresh(a)) || (fresh(a) ? score.get(b.key)! - score.get(a.key)! : a.lastAuditionMs - b.lastAuditionMs));
    const quickQ = free.filter(c => fresh(c) && score.get(c.key)! < FULL_DB).sort((a, b) => score.get(b.key)! - score.get(a.key)!);
    let nQuick = 0, nFull = 0;
    for (const [, ch] of this.chans) if (!ch.turnOver(now)) { if (ch.quick) nQuick++; else nFull++; }
    const quickSet = new Set<number>();
    for (let fi = 0, qi = 0; want.length < budget && (fi < fullQ.length || qi < quickQ.length);) {
      const q = qi < quickQ.length && (nQuick <= nFull || fi >= fullQ.length);
      if (q) { const c = quickQ[qi++]; want.push(c); quickSet.add(c.key); nQuick++; } else { want.push(fullQ[fi++]); nFull++; }
    }
    // channels still free after every turn waiting (a narrow span): the settled carriers keep or get one too, the one
    // waiting longest first, as every live carrier always did
    for (const c of live.filter(x => !want.includes(x) && settled(x)).sort((a, b) => a.lastAuditionMs - b.lastAuditionMs)) { if (want.length >= budget) break; want.push(c); }
    const chosen = new Set(want.slice(0, budget).map(c => c.key));
    for (const k of [...this.chans.keys()]) if (!chosen.has(k)) this.chans.delete(k);
    for (const k of chosen) if (!this.chans.has(k)) { const c = this.carriers.get(k)!, quick = quickSet.has(k); c.lastAuditionMs = now; c.turns++; c.turnDb = c.levelDb; this.open(c, now); const ch = this.chans.get(k); if (ch) ch.quick = quick; }
    for (const c of this.carriers.values()) c.decoding = this.chans.has(c.key);
    for (const [k, ch] of this.chans) if (ch.p2 && !ch.p2.seed) { const c = this.carriers.get(k); if (c) ch.p2.setSeeds(this.p2Seeds(c)); }
    this.placeCalls();
  }
  /** A carrier that has sent unit reports in the last minute. */
  private reportsOn(c: Carrier, now: number): boolean { for (const t of c.unitIds.values()) if (now - t < 60_000) return true; return false; }
  private open(c: Carrier, now: number, given?: Chan): void {
    const ch = given ?? new Chan(c.key, c.hz, this.centerHz, this.rate, now);
    ch.p25.onBlock = b => this.p25Block(c, ch, b);
    ch.p25.onFrame = (nac, duid) => { c.envCv = Math.round(ch.rx.envCv * 100) / 100; this.p25Frame(c, nac, duid); };
    ch.dmr.onBurst = e => this.dmrBurst(c, ch, e);
    ch.dmr.onVoice = (slot, d, n) => this.dmrVoice(c, ch, slot, d, n);
    ch.p25v.onVoice = bits => this.p25Voice(c, bits, ch);
    ch.onFill = (lane, n) => this.fill(c, lane, n);
    ch.onNxdnSync = baud => this.nxdnSeen.set(c.key, { ms: this.now(), baud });
    ch.p25v.onLog = () => this.p25Lc(c, ch);
    ch.p25v.onEs = es => this.p25Sec(c, 'LDU2', es);
    ch.p25v.onHdu = hd => this.p25Sec(c, 'HDU', hd);
    ch.cw.onText = t => this.cwText(c, t);
    ch.osw.onOsw = (o, gap) => this.oswWord(c, ch, o, gap);
    if (c.tdma) this.p2On(c, ch);
    this.chans.set(c.key, ch);
    if (this.calls.at('', c.hz, 0)?.proto === 'SMARTNET') this.fmOn(c, ch);
  }
  /** A Phase 2 TDMA channel: its S-ISCH syncs class it and keep it decoding (its voice is not built yet). */
  private p2On(c: Carrier, ch: Chan): void {
    if (ch.p2) return;
    ch.p2 = new P2Rx(ch.fs);
    ch.p2.onSync = paired => { if (!paired) return; const now = this.now(); c.cls = 'P25 PHASE 2 TDMA'; c.lastDecodeMs = now; c.frames++; if (c.role !== 'control') c.role = 'voice'; this.p2Seen.set(c.key, now); this.pending = true; };
    ch.p2.setSeeds(this.p2Seeds(c));
    ch.p2.onSeed = s => { if (!c.sys) c.sys = s.sys; this.addLog({ ms: this.now(), hz: c.hz, proto: 'P25', name: 'PHASE 2 SCRAMBLING', text: `PHASE 2 · descrambling with WACN ${h(s.wacn, 5)} · SYSTEM ${h(s.sysId, 3)} · NAC ${h(s.nac, 3)}`, hex: '', ok: true }); };
    ch.p2.onVoice = (lch, fr) => {
      // an erasure keeps the timing of a call already on the air; it never starts or extends one
      if (!fr.length) { const call = this.calls.at(c.sys, c.hz, lch); if (call?.onAir) this.calls.frames(call, [fr]); return; }
      const now = this.now(), call = this.calls.voice(c.sys, 'P25', c.hz, lch, 20, now, true); this.calls.frames(call, [fr]); this.pending = true;
    };
    ch.p2.onMac = m => this.p2Mac(c, m);
    ch.p2.onEss = (lch, e) => { const call = this.calls.at(c.sys, c.hz, lch); if (call) this.calls.security(call, { enc: e.algId !== 0x80, from: 'ESS', algId: e.algId, keyId: e.keyId, mi: e.mi }); };
  }
  // ------------------------------------------------------------------------------------------------ NXDN
  /**
   * NXDN receivers on a channel: both bandwidths until one locks, or the one a system's grant names. The one that locks
   * stays; an NXDN96 one moves to its own 48 kS/s down-converter then (a carrier tried and not NXDN never costs one).
   */
  private nxdnOn(c: Carrier, ch: Chan, baud?: number): void {
    if (ch.nxdn) return;
    const make = (b: 2400 | 4800, wide: boolean): NxdnRx => {
      const r = new NxdnRx(ch.nxdnFs(b, wide), b);
      const keep = () => {
        if (!r.framer.locked || !ch.nxdn?.includes(r)) return;
        if (b === 4800 && !wide && !ch.baseband) ch.nxdn = [make(4800, true)];
        else if (ch.nxdn.length > 1) ch.nxdn = [r];
      };
      r.framer.onCac = (sr, msgs) => { keep(); this.nxdnCac(c, sr, msgs, b); };
      r.framer.onTraffic = t => { keep(); if (r.framer.locked || t.msgs.length) this.nxdnTraffic(c, t, b); };
      return r;
    };
    ch.nxdn = ([2400, 4800] as const).filter(b => !baud || b === baud).map(b => make(b, b === baud));
  }
  private nxdnSys(key: string, now: number, init: { model: string; wacn: number; sysId: number; trunk: string; baud: number }): Sys {
    let s = this.systems.get(key);
    if (!s) { s = { key, proto: 'NXDN', color: this.colorNext++, wacn: init.wacn, sysId: init.sysId, cc: -1, fid: -1, net: -1, model: init.model, firstMs: now, lastMs: now, idens: new Map(), derived: false, lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [], lpcnVotes: new Map(), lpcnHz: new Map(), heardHz: new Set() }; this.systems.set(key, s); }
    s.trunk = init.trunk; s.lastMs = now;
    if (!s.nxdnPlan) s.nxdnPlan = new NxdnPlan();
    s.nxdnBaud = init.baud; s.nxdnPlan.spacing = init.baud === 2400 ? 6250 : 12500;
    return s;
  }
  /** Grants of the last moments, waiting for the voice that says which carrier their channel is (TS 1-A gives no plan). */
  private nxdnPending: { sys: string; ch: number; src: number; dst: number; group: boolean; ms: number }[] = [];
  /** Carriers whose NXDN frame syncs keep their grid: NXDN, decoded or not, so never DMR. */
  private readonly nxdnSeen = new Map<number, { ms: number; baud: number }>();
  private nxdnLately(c: Carrier, now: number): boolean { const x = this.nxdnSeen.get(c.key); return !!x && now - x.ms < 5_000; }
  private nxdnLog(c: Carrier, name: string, text: string, hex: string): void { this.addLog({ ms: this.now(), hz: c.hz, proto: 'NXDN', name, text: `${c.cls} · ${text}`, hex, ok: true }); }
  /** Where an NXDN channel is: heard, from the plan, or a guess used only where a carrier is live in the span. */
  private nxdnHz(s: Sys, ch: number, now: number): { hz: number; derived: boolean } {
    const r = s.nxdnPlan?.resolve(ch);
    if (!r) return { hz: 0, derived: false };
    if (r.how === 'guess') {
      const k = this.carriers.get(gridKey(r.hz));
      return k && this.inSpan(r.hz) && now - k.lastMs < LIVE_MS && Math.abs(k.hz - r.hz) < 1_500 ? { hz: r.hz, derived: true } : { hz: 0, derived: false };
    }
    return { hz: r.hz, derived: r.how !== 'heard' };
  }
  /** An outbound control channel frame (TS 1-A 4.4.1): its messages build the system, its grants and its units. */
  private nxdnCac(c: Carrier, sr: number, msgs: NxdnMsg[], baud: number): void {
    const now = this.now();
    c.cls = baud === 2400 ? 'NXDN48' : 'NXDN96'; c.role = 'control'; c.lastDecodeMs = now; c.frames++; c.crcOk++; c.blocks++; this.blocks++; c.nxdnRan = sr & 0x3f;
    for (const m of msgs) {
      if (m.site) this.nxdnSite(c, m.site, baud);
      const s = c.sys ? this.systems.get(c.sys) : undefined;
      if (s) { s.lastMs = now; this.nxdnControl(c, s, m, c.nxdn ? `site ${c.nxdn.site}` : '', now); }
      if (m.type !== 0x10 && !m.site) this.nxdnLog(c, m.name, nxdnLine(m), m.hex);
    }
    this.pending = true;
  }
  /** SITE_INFO (TS 1-A 6.4.3.1): the Location ID names the system and site, and the control channels. */
  private nxdnSite(c: Carrier, x: NxdnSite, baud: number): void {
    const now = this.now(), cat = NXDN_CATEGORY[x.category], key = `NXDN ${cat}-${x.system}`;
    const s = this.nxdnSys(key, now, { model: cat, wacn: x.category, sysId: x.system, trunk: 'TYPE-C', baud });
    s.heardHz.add(c.key);
    c.cls = baud === 2400 ? 'NXDN48' : 'NXDN96'; c.role = 'control'; c.sys = key;
    c.nxdn = { ...x, baud, service: c.nxdn?.service ?? x.service };
    // the control channel's own number: with one control channel named it is this one; with two, the one the plan puts here
    const plan = s.nxdnPlan!;
    if (x.cc1 && (!x.cc2 || x.cc2 === x.cc1)) plan.vote(x.cc1, c.hz);
    else if (x.cc1) for (const n of [x.cc1, x.cc2]) { const r = plan.resolve(n); if (r && r.how !== 'guess' && Math.abs(r.hz - c.hz) < 1_000) plan.vote(n, c.hz); }
    this.addLog({ ms: now, hz: c.hz, proto: 'NXDN', name: 'SITE_INFO', text: `${c.cls} · SITE_INFO · ${cat} SYSTEM ${x.system} · SITE ${x.site} · control channel ${x.cc1}${x.cc2 ? ` and ${x.cc2}` : ''} · ${x.adjacent} adjacent sites · version ${x.version}`, hex: '', ok: true });
    this.pending = true;
  }
  /** A control message of a known system: grants, registrations, neighbors, channels. */
  private nxdnControl(c: Carrier, s: Sys, m: NxdnMsg, site: string, now: number): void {
    const msg = { hex: m.hex, line: nxdnLine(m) };
    if ((m.type === 0x04 || m.type === 0x05) && m.ch && m.dst !== undefined) {
      const at = this.nxdnHz(s, m.ch, now), efr = ((m.voiceOpt ?? 0) & 7) === 3;
      this.nxdnPending = this.nxdnPending.filter(g => now - g.ms < 3_000);
      if (!this.nxdnPending.some(g => g.sys === s.key && g.ch === m.ch && g.dst === m.dst)) this.nxdnPending.push({ sys: s.key, ch: m.ch, src: m.src ?? 0, dst: m.dst, group: !!m.group, ms: now });
      this.grant(s.key, { ms: now, lastMs: now, sys: s.key, kind: m.group ? 'grant' : 'u2u', tg: m.dst, group: !!m.group, src: m.src ?? 0, ch: `CH ${m.ch}`, hz: at.hz, slot: 0, tdma: false, emergency: !!m.emergency, encrypted: false, carrierHz: c.hz, site, lpcn: m.ch, chDerived: at.derived, efr }, m.type === 0x05);
      if (m.src) this.touchUnit(s.key, m.src, c, now, 'grant', msg, site, m.group ? m.dst : undefined);
      if (!m.group && m.dst) this.touchUnit(s.key, m.dst, c, now, 'u2u', msg, site);
    } else if ((m.type === 0x20 || m.type === 0x24) && m.unit && m.unit < 0xfff0) {
      const u = this.touchUnit(s.key, m.unit, c, now, m.type === 0x20 ? 'registration' : 'group registration', msg, site);
      // a registration accepted (Cause (MM) 0x01, Table 6.5-27) puts the unit in its group
      if (m.gid && m.gid < 0xfff0 && m.cause === 1) { u.groups.add(m.gid); this.tgFor(s.key, m.gid, now).members.add(m.unit); }
    } else if ((m.type === 0x22 || m.type === 0x23) && m.unit && m.unit < 0xfff0) this.touchUnit(s.key, m.unit, c, now, m.type === 0x22 ? 'registration clear' : 'registration command', msg, site);
    else if (m.type === 0x1b && m.adj) { c.nxdnAdj ??= new Map(); for (const a of m.adj) c.nxdnAdj.set(`${a.category}-${a.system}-${a.site}`, a); }
    else if (m.type === 0x1a && m.cch && c.nxdn && m.cch.site === c.nxdn.site && m.cch.system === c.nxdn.system && m.cch.flags === 8 && m.cch.ch1 && !m.cch.ch2) s.nxdnPlan!.vote(m.cch.ch1, c.hz);
    else if (m.type === 0x19 && c.nxdn && m.service !== undefined) c.nxdn.service = m.service;
  }
  /**
   * A traffic channel frame (RTCH, RDCH, or a Type-D RTCH2): the VCALL in its SACCH or FACCH1 names the call and says
   * whether it is ciphered, TX_REL ends it, and its VCHs are the voice. A conventional channel (RDCH) is its own system,
   * named by its RAN; a trunked one belongs to the system whose grant named it.
   */
  private nxdnTraffic(c: Carrier, t: NxdnTraffic, baud: number): void {
    const now = this.now();
    c.cls = baud === 2400 ? 'NXDN48' : 'NXDN96'; c.lastDecodeMs = now; c.frames++;
    if (c.role !== 'control') c.role = 'voice';
    // a conventional system is named by its RAN once two SACCHs agree on it
    if (t.ran >= 0) { c.nxdnRanN = c.nxdnRan === t.ran ? (c.nxdnRanN ?? 0) + 1 : 1; c.nxdnRan = t.ran; }
    if (t.rf === 2 && t.ran >= 0 && (c.nxdnRanN ?? 0) >= 2) {
      const key = `NXDN CONV RAN ${t.ran}`;
      const s = this.nxdnSys(key, now, { model: 'CONVENTIONAL', wacn: -1, sysId: t.ran, trunk: 'CONVENTIONAL', baud });
      s.heardHz.add(c.key); c.sys = key;
    }
    if (t.scch) this.nxdnScch(c, t.scch, now, baud);
    for (const m of t.msgs) {
      if (m.type === 0x01 && m.dst !== undefined) {
        this.nxdnLearn(c, m.src ?? 0, m.dst, !!m.group, now);
        const call = this.calls.lc(c.sys, c.hz, 0, { group: !!m.group, dst: m.dst, src: m.src ?? 0, emergency: !!m.emergency, privacy: !!m.cipher }, now, 'NXDN');
        if (((m.voiceOpt ?? 0) & 7) === 3) this.calls.setCodec(call, 'imbe');
        this.calls.security(call, { enc: !!m.cipher, from: 'VCALL', algId: m.cipher, keyId: m.keyId });
        if (call.sys && !c.sys) c.sys = call.sys;
      } else if (m.type === 0x08 || m.type === 0x07 || m.type === 0x11) this.calls.terminate(c.sys, c.hz, 0, now);
      else if (m.type === 0x05 && m.ch && c.sys) { const s = this.systems.get(c.sys); if (s) this.nxdnControl(c, s, m, '', now); }
      if (m.type !== 0x10) this.nxdnLog(c, m.name, `${t.rf === 2 ? 'RDCH' : t.typeD ? 'RTCH2' : 'RTCH'} · ${nxdnLine(m)}`, m.hex);
    }
    const halves = t.halves.filter((x): x is Uint8Array => !!x);
    if (!halves.length) { this.pending = true; return; }
    const call = this.calls.voice(c.sys, 'NXDN', c.hz, 0, 0, now);
    // EHR: two 72-bit VCHs a half; EFR (the IMBE frame): one 144-bit VCH a half
    const frames: Uint8Array[] = [];
    for (const h of halves) { if (call.codec === 'imbe') frames.push(h); else frames.push(h.slice(0, 72), h.slice(72)); }
    call.voiceMs += 20 * frames.length;
    this.calls.frames(call, frames);
    this.pending = true;
  }
  /** A call named on a carrier: a grant of the last moments to the same talkgroup or unit says which channel it is. */
  private nxdnLearn(c: Carrier, src: number, dst: number, group: boolean, now: number): void {
    const i = this.nxdnPending.findIndex(g => now - g.ms < 3_000 && g.dst === dst && g.group === group && (!src || !g.src || g.src === src) && (!c.sys || c.sys === g.sys));
    if (i < 0) return;
    const g = this.nxdnPending[i]; this.nxdnPending.splice(i, 1);
    const s = this.systems.get(g.sys); if (!s?.nxdnPlan) return;
    if (!c.sys) c.sys = g.sys;
    if (s.nxdnPlan.vote(g.ch, c.hz)) {
      this.pending = true;
      this.addLog({ ms: now, hz: c.hz, proto: 'NXDN', name: 'CHANNEL', text: `${c.cls} · channel ${g.ch} is ${(c.hz / 1e6).toFixed(5)} MHz, from a grant and the voice that followed it`, hex: '', ok: true });
    }
  }
  /** A Type-D SCCH message (TS 1-E 6.5.3): the site, a call's source, destination and cipher, the end of a transmission. */
  private nxdnScch(c: Carrier, x: NxdnScch, now: number, baud: number): void {
    if (x.kind === 'site' && x.siteCode !== undefined) {
      const key = `NXDN TYPE-D SITE ${x.siteCode}`;
      const s = this.nxdnSys(key, now, { model: 'TYPE-D', wacn: -1, sysId: x.siteCode, trunk: 'TYPE-D', baud });
      s.heardHz.add(c.key); c.sys = key;
      return;
    }
    if (x.kind === 'idle' || x.kind === 'free' || x.kind === 'halt') return;
    const d = c.nxdnD && now - c.nxdnD.ms < 2_000 ? c.nxdnD : (c.nxdnD = { src: 0, dst: -1, group: true, cipher: -1, keyId: 0, ms: now });
    d.ms = now;
    if (x.info === 3 && x.src !== undefined) d.src = x.src;
    if (x.info === 1 && x.cipher !== undefined) { d.cipher = x.cipher; d.keyId = x.keyId ?? 0; }
    if (x.kind === 'busy' && x.dst !== undefined) {
      // Go to Repeater 31 is the end of a transmission (1-E 6.6.11)
      if (x.goTo === 31) { this.calls.terminate(c.sys, c.hz, 0, now); c.nxdnD = undefined; return; }
      d.dst = x.dst; d.group = !!x.group;
      // INFO4 on a repeater sends units elsewhere: a grant to that repeater's channel (INFO2 names this repeater's own call)
      const s = c.sys ? this.systems.get(c.sys) : undefined;
      if (s && x.info === 4 && x.goTo && !this.calls.onAirAt(c.sys, c.hz, 0)) {
        const at = this.nxdnHz(s, x.goTo, now);
        this.nxdnPending = this.nxdnPending.filter(g => now - g.ms < 3_000);
        if (!this.nxdnPending.some(g => g.sys === s.key && g.ch === x.goTo && g.dst === x.dst)) this.nxdnPending.push({ sys: s.key, ch: x.goTo, src: 0, dst: x.dst, group: !!x.group, ms: now });
        this.grant(s.key, { ms: now, lastMs: now, sys: s.key, kind: x.group ? 'grant' : 'u2u', tg: x.dst, group: !!x.group, src: 0, ch: `REPEATER ${x.goTo}`, hz: at.hz, slot: 0, tdma: false, emergency: false, encrypted: false, carrierHz: c.hz, site: '', lpcn: x.goTo, chDerived: at.derived }, false);
        this.nxdnLog(c, 'INFO4', `GO TO REPEATER ${x.goTo} · ${x.group ? 'TG' : 'UNIT'} ${nxdnId(x.dst, true)}`, '');
        return;
      }
    }
    if (d.dst >= 0 && (d.src || this.calls.onAirAt(c.sys, c.hz, 0))) {
      this.nxdnLearn(c, d.src, d.dst, d.group, now);
      const call = this.calls.lc(c.sys, c.hz, 0, { group: d.group, dst: d.dst, src: d.src, emergency: false, privacy: d.cipher > 0 }, now, 'NXDN');
      if (d.cipher >= 0) this.calls.security(call, { enc: d.cipher > 0, from: 'SCCH', algId: d.cipher, keyId: d.keyId });
    }
  }
  private tetraOn(c: Carrier, ch: Chan): void {
    // the carrier finder can split a 25 kHz signal into pieces: the receiver is centered on all of them together
    const now = this.now(), parts = [...this.carriers.values()].filter(x => Math.abs(x.hz - c.hz) <= 16_000 && now - x.lastMs < LIVE_MS && x.cls !== 'P25 C4FM' && x.cls !== 'DMR');
    // one receiver per signal: a piece next to one that already has it reads nothing twice
    for (const [k, x] of this.chans) if (k !== c.key && x.tetra && Math.abs((this.carriers.get(k)?.hz ?? 0) - c.hz) <= 16_000) return;
    let w = 0, sum = 0; for (const x of parts) { const p = 10 ** (x.levelDb / 10); w += p; sum += p * x.hz; }
    const rx = ch.tetraOn(w > 0 ? sum / w : c.hz); if (!rx) return;
    rx.onSync = s => this.tetraSync(c, s);
    if (!ch.tetraMac) { ch.tetraMac = new TetraMac(rx); ch.tetraMac.onEvent = e => this.tetraEvent(c, e); }
    // a carrier a grant sent us to: its scrambling is the cell's, known before its own synchronization bursts come
    const s = this.systems.get(c.sys);
    if (s?.proto === 'TETRA' && !ch.tetraMac.cellKnown) ch.tetraMac.setCell(s.wacn, s.sysId, s.cc);
  }
  /** A TETRA synchronization burst (EN 300 392-2 BSCH): the network (MCC, MNC), the cell's color code and timing. */
  private tetraSync(c: Carrier, t: TetraSync): void {
    const now = this.now(), key = `TETRA ${t.mcc}-${t.mnc}`;
    let s = this.systems.get(key);
    if (!s) { s = { key, proto: 'TETRA', color: this.colorNext++, wacn: t.mcc, sysId: t.mnc, cc: t.colorCode, fid: -1, net: -1, model: '', firstMs: now, lastMs: now, idens: new Map(), derived: false, lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [], lpcnVotes: new Map(), lpcnHz: new Map(), heardHz: new Set() }; this.systems.set(key, s); }
    s.lastMs = now; s.heardHz.add(c.key);
    c.cls = 'TETRA'; if (c.role !== 'voice') c.role = 'control'; c.sys = key; c.cc = t.colorCode; c.lastDecodeMs = now; c.frames++; c.crcOk++; c.blocks++; this.blocks++;
    c.tetra = t;
    // the other pieces of the same 25 kHz signal are the same carrier
    for (const x of this.carriers.values()) if (x !== c && Math.abs(x.hz - c.hz) <= 13_000 && x.cls !== 'TETRA' && !(x.lastDecodeMs > 0 && now - x.lastDecodeMs < 5_000)) { x.cls = 'TETRA'; x.role = 'control'; x.sys = key; x.cc = t.colorCode; x.lastDecodeMs = now; }
    this.addLog({ ms: now, hz: c.hz, proto: 'TETRA', name: 'SYNC', text: `TETRA · SYNC · MCC ${t.mcc} · MNC ${t.mnc} · color code ${t.colorCode} · TS${t.timeslot} · frame ${t.frame} · multiframe ${t.multiframe} · cell load ${t.cellLoad}`, hex: '', ok: true });
    this.pending = true;
  }
  /** The TETRA state of a carrier's system. */
  private tetraOf(c: Carrier): Sys | undefined {
    const s = this.systems.get(c.sys); if (!s || s.proto !== 'TETRA') return undefined;
    if (!s.tetra) s.tetra = { calls: new Map(), encSdus: 0, clearSdus: 0, aie: false, sec: null, carriers: new Map() };
    return s;
  }
  /** What the TETRA MAC read on a carrier (EN 300 392-2 clauses 14, 16, 18, 21). */
  private tetraEvent(c: Carrier, e: TetraEvent): void {
    const s = this.tetraOf(c); if (!s) return;
    const t = s.tetra!, now = this.now();
    const log = (name: string, text: string) => this.addLog({ ms: now, hz: c.hz, proto: 'TETRA', name, text: `TETRA · ${text}`, hex: '', ok: true });
    switch (e.kind) {
      case 'sysinfo': {
        const i = e.info; c.tetraCell = i; c.lastDecodeMs = now; c.blocks++; c.crcOk++; this.blocks++;
        t.aie = i.services.aie; if (i.security) t.sec = i.security;
        const mhz = i.mainHz ? ` (${(i.mainHz / 1e6).toFixed(5)} MHz)` : '', sec = i.security ? ` · security class ${i.security.class3 ? 3 : 2}${i.security.auth ? ' · authentication required' : ''}` : '';
        log('SYSINFO', `SYSINFO · LA ${i.la} · main carrier ${i.mainCarrier}${mhz} · ${i.services.aie ? 'air interface encryption available' : 'no air interface encryption'}${sec} · ${i.services.voice ? 'voice service' : 'no voice service'}${i.services.registration ? ' · registration required' : ''}`);
        break;
      }
      case 'access': log('ACCESS-DEFINE', e.text); break;
      case 'encrypted': t.encSdus++; c.blocks++; this.blocks++; log('ENCRYPTED', `TS${e.mac.tn} · signalling encrypted on the air interface (encryption mode ${e.mac.enc})`); break;
      case 'alloc': if (e.mac.chan) log('CHANNEL ALLOCATION', `TS${e.mac.tn} · SSI ${e.mac.ssi}${e.mac.um >= 0 ? ` · usage marker ${e.mac.um}` : ''} · ${this.tetraChanText(c, e.mac)}`); break;
      case 'mm':
        t.clearSdus++; c.blocks++; c.crcOk++; this.blocks++;
        if (e.type === 5 && e.mac.ssi > 0) this.tetraUnit(s.key, e.mac.ssi, c, now, 'registration', e.name);
        log(e.name, `TS${e.mac.tn} · ${e.name}${e.mac.ssi >= 0 ? ` · SSI ${e.mac.ssi}` : ''}`);
        break;
      case 'other': log(e.name, `TS${e.mac.tn} · ${e.name}${e.mac.ssi >= 0 ? ` · SSI ${e.mac.ssi}` : ''}`); break;
      case 'cmce': t.clearSdus++; c.blocks++; c.crcOk++; this.blocks++; this.tetraCmce(c, s, e.pdu, e.mac, now); break;
      case 'voice': this.tetraVoice(c, s, e.tn, e.frames, now); break;
      case 'aach':
        // a traffic slot of a cell whose signalling is encrypted on the air interface, with no call read for it: an
        // encrypted call (the cell's broadcast and the MAC headers both say so)
        if (e.usage >= 4 && t.aie && t.encSdus > 0) {
          const k = this.calls.at(s.key, c.hz, e.tn - 1);
          if (!k) { const call = this.calls.voice(s.key, 'TETRA', c.hz, e.tn - 1, 0, now); this.calls.security(call, { enc: true, from: 'AIE' }); }
          else if (k.sec === 'enc') this.calls.voice(s.key, 'TETRA', c.hz, e.tn - 1, 0, now);
        }
        return;
    }
    this.pending = true;
  }
  /**
   * A channel allocation to a frequency and slot: the cell's band and offset unless it gives its own, placed relative
   * to the cell's main carrier as received.
   */
  private tetraChanHz(c: Carrier, a: { carrier: number; band: number; offset: number; tn: number }): { hz: number; slot: number } {
    const cell = c.tetraCell ?? [...this.carriers.values()].find(x => x.sys === c.sys && x.tetraCell)?.tetraCell;
    let hz = 0;
    if (a.band > 0) hz = tetraCarrierHz(a.carrier, a.band, a.offset);
    else if (cell && cell.band > 0) hz = tetraCarrierHz(a.carrier, cell.band, cell.offset);
    const main = cell ? [...this.carriers.values()].find(x => x.sys === c.sys && x.tetraCell && Math.abs(x.hz - cell.mainHz) < 15_000) : undefined;
    if (cell && main && hz) hz = main.hz + (hz - cell.mainHz);
    else if (!hz && cell && a.carrier === cell.mainCarrier) hz = c.hz;
    const s = this.tetraOf(c);
    if (hz && s) s.tetra!.carriers.set(a.carrier, Math.round(hz));
    return { hz: Math.round(hz), slot: Math.max(0, a.tn - 1) };
  }
  private tetraChanText(c: Carrier, mac: TetraMacInfo): string {
    const a = mac.chan; if (!a) return '';
    if (a.tn === 0) return 'to the control channel';
    const r = this.tetraChanHz(c, a);
    return `carrier ${a.carrier}${r.hz ? ` (${(r.hz / 1e6).toFixed(5)} MHz)` : ''} TS${a.tn}${a.updown === 1 ? ' downlink' : a.updown === 2 ? ' uplink' : ''}`;
  }
  /** TETRA call control (14.7.1): set-up, connect, transmission grants and the end of a call build the call. */
  private tetraCmce(c: Carrier, s: Sys, p: TetraCmce, mac: TetraMacInfo, now: number): void {
    const t = s.tetra!;
    let call = p.callId >= 0 ? t.calls.get(p.callId) : undefined;
    const at = mac.chan && mac.chan.tn > 0 ? this.tetraChanHz(c, mac.chan) : null;
    const who = () => call ? ` · ${call.group ? 'TG' : 'UNIT'} ${call.tg}` : '';
    let text = `TS${mac.tn} · ${p.name}${p.callId >= 0 ? ` · call ${p.callId}` : ''}`;
    let grant = false;
    switch (p.type) {
      case 7: {   // D-SETUP: sent to the called group (or unit), naming the calling unit
        const group = (p.basic?.comm ?? 1) !== 0;
        call = { tg: mac.ssi, group, src: p.calling > 0 ? p.calling : 0, hz: at?.hz ?? call?.hz ?? 0, slot: at?.slot ?? call?.slot ?? 0, e2ee: !!p.basic?.e2ee, ms: now };
        if (p.callId >= 0) t.calls.set(p.callId, call);
        const kind = p.basic && p.basic.mode !== 0 ? ` · circuit mode ${p.basic.mode}` : ' speech';
        text += ` · ${group ? 'TG' : 'UNIT'} ${mac.ssi}${call.src ? ` ← ${call.src}` : ''} · ${tetraCommName(p.basic?.comm ?? 1)}${kind}${p.basic?.e2ee ? ' · END-TO-END ENCRYPTED' : ''} · priority ${p.prio}`;
        grant = true;
        break;
      }
      case 2: case 14:   // D-CONNECT (to the calling unit), D-CALL RESTORE
        if (call && at) { call.hz = at.hz; call.slot = at.slot; }
        if (call && p.basic) call.e2ee = p.basic.e2ee;
        if (call && p.newCallId >= 0) { t.calls.delete(p.callId); t.calls.set(p.newCallId, call); text += ` · now call ${p.newCallId}`; }
        if (call && p.type === 2 && mac.ssi > 0 && !call.src) call.src = mac.ssi;
        text += who();
        grant = !!call;
        break;
      case 11: case 13:   // D-TX GRANTED, D-TX INTERRUPT: who talks now
        if (call && p.talker > 0 && (p.grant === 0 || p.grant === 3)) call.src = p.talker;
        if (call && at) { call.hz = at.hz; call.slot = at.slot; }
        if (call && p.encCtl === 1) call.e2ee = true;
        text += `${who()} · ${tetraGrantName(p.grant)}${p.talker > 0 ? ` · talker ${p.talker}` : ''}${p.encCtl === 1 ? ' · END-TO-END ENCRYPTED' : ''}`;
        grant = !!call && (p.grant === 0 || p.grant === 3);
        break;
      case 9: text += `${who()} · transmission ceased`; break;
      case 4: case 6:   // D-DISCONNECT, D-RELEASE
        text += `${who()} · ${tetraDisconnectCause(p.cause)}`;
        if (call && p.type === 6) { if (call.hz) this.calls.terminate(s.key, call.hz, call.slot, now); t.calls.delete(p.callId); }
        break;
      case 8: case 15: {   // D-STATUS, D-SDS-DATA
        const x = p.sds; if (!x) break;
        const body = x.kind === 'text' ? `"${x.text}"` : x.kind === 'status' ? `status ${x.status}` : `${x.kind} ${x.hex}`;
        text += ` · ${x.from > 0 ? `${x.from} → ` : ''}${mac.ssi} · ${body}`;
        const what = `${x.kind === 'text' ? 'SDS text' : x.kind === 'status' ? 'status' : 'SDS'} ${body}`;
        if (x.from > 0) this.tetraUnit(s.key, x.from, c, now, `${what} to ${mac.ssi}`, text);
        if (mac.ssi > 0) this.tetraUnit(s.key, mac.ssi, c, now, `${what}${x.from > 0 ? ` from ${x.from}` : ''}`, text);
        break;
      }
      default: text += who();
    }
    if (call && grant) {
      if (call.src) this.tetraUnit(s.key, call.src, c, now, 'call', text, call.group ? call.tg : undefined);
      const ch = at ? `carrier ${mac.chan!.carrier} TS${mac.chan!.tn}` : `call ${p.callId}`;
      if (call.tg || call.hz) this.grant(s.key, { ms: now, lastMs: now, sys: s.key, kind: call.group ? 'grant' : 'u2u', tg: call.tg, group: call.group, src: call.src, ch, hz: call.hz, slot: call.slot, tdma: false, emergency: false, encrypted: call.e2ee, carrierHz: c.hz, site: '' }, p.type !== 7);
    }
    if (at) text += ` · ${this.tetraChanText(c, mac)}`;
    this.addLog({ ms: now, hz: c.hz, proto: 'TETRA', name: p.name, text: `TETRA · ${text}`, hex: '', ok: true });
  }
  /** Speech of a traffic slot: the call on that carrier and slot takes it (one the air named, or a new one that waits). */
  private tetraVoice(c: Carrier, s: Sys, tn: number, frames: Uint8Array[], now: number): void {
    c.lastDecodeMs = now; c.frames++; if (c.role !== 'control') c.role = 'voice';
    // the call on this signal and slot, where the grant put it (the receiver may sit on a piece of the same signal)
    const near = this.calls.calls.find(k => k.kind === 'call' && k.onAir && k.proto === 'TETRA' && k.sys === s.key && k.slot === tn - 1 && Math.abs(k.hz - c.hz) <= 13_000);
    const call = this.calls.voice(s.key, 'TETRA', near ? near.hz : c.hz, tn - 1, 30 * frames.filter(f => f.length).length, now);
    this.calls.frames(call, frames);
  }
  /** A TETRA unit heard: what it did, with the group when there is one. */
  private tetraUnit(sys: string, id: number, c: Carrier, now: number, kind: string, text: string, group?: number): void {
    const key = `${sys}/${id}`;
    let u = this.units.get(key);
    if (!u) { u = { key, sys, id, firstMs: now, lastMs: now, lonLo: -1, latLo: -1, posMs: 0, posVerified: false, trail: [], groups: new Set(), grants: 0, carriers: new Set(), reports: [], fixes: [], tgCounts: new Map() }; this.units.set(key, u); }
    u.lastMs = now; u.carriers.add(c.key);
    if (group !== undefined) { u.groups.add(group); u.tgCounts.set(group, (u.tgCounts.get(group) ?? 0) + 1); this.tgFor(sys, group, now).members.add(id); }
    if (kind === 'call') u.grants++;
    u.reports.push({ ms: now, hz: c.hz, kind, hex: '', verified: true, lat: null, lon: null, text, db: c.levelDb });
    if (u.reports.length > 60) u.reports.shift();
    this.pending = true;
  }
  /** What a TETRA system's cells broadcast and its MAC headers say about air interface encryption. */
  private tetraSecurity(s: Sys): string {
    const t = s.tetra; if (!t) return [...this.carriers.values()].some(c => c.sys === s.key && c.tetraCell) ? 'CLEAR AIR INTERFACE' : '';
    const cls = t.sec ? ` · SECURITY CLASS ${t.sec.class3 ? 3 : 2}` : '';
    if (t.aie && t.encSdus > 0) return `AIR INTERFACE ENCRYPTED${cls}`;
    if (t.aie) return `AIR INTERFACE ENCRYPTION AVAILABLE${cls}`;
    return [...this.carriers.values()].some(c => c.sys === s.key && c.tetraCell) ? 'CLEAR AIR INTERFACE' : '';
  }
  /** The scrambling seeds a Phase 2 channel may use: its own system first, then every P25 system and site heard. */
  private p2Seeds(c: Carrier): P2Seed[] {
    const out: P2Seed[] = [], add = (s: Sys, nac: number) => { if (nac >= 0 && s.wacn >= 0 && s.sysId >= 0 && !out.some(x => x.sys === s.key && x.nac === nac)) out.push({ wacn: s.wacn, sysId: s.sysId, nac, sys: s.key }); };
    const own = this.systems.get(c.sys);
    const nacs = (s: Sys) => [...this.sites.values()].filter(x => x.sys === s.key).map(x => x.nac);
    if (own && own.proto === 'P25') for (const n of nacs(own)) add(own, n);
    for (const s of this.systems.values()) if (s.proto === 'P25') for (const n of nacs(s)) add(s, n);
    return out;
  }
  /** A Phase 2 MAC PDU (BBAC 8): push to talk names the call and its encryption, end of push to talk ends it. */
  private p2Mac(c: Carrier, m: P2Mac): void {
    const now = this.now(), op = MAC_OPS[m.opcode] ?? `MAC ${m.opcode}`, sys = c.sys, lch = m.lch;
    let text = `${op} · TS${lch + 1}`;
    if (m.opcode === 1) {
      const p = p2Ptt(m.bytes);
      const call = this.calls.lc(sys, c.hz, lch, { group: true, dst: p.group, src: p.src, emergency: false, privacy: false }, now, 'P25', true);
      this.calls.security(call, { enc: p.algId !== 0x80, from: 'MAC', algId: p.algId, keyId: p.keyId, mi: p.mi });
      text += ` · TG ${p.group}${p.src ? ` ← ${p.src}` : ''} · ALGID ${h(p.algId, 2)} · KEY ${h(p.keyId, 4)}${p.algId !== 0x80 ? ` · MI ${p.mi.toUpperCase()}` : ''}`;
    } else if (m.opcode === 2) {
      const e = p2EndPtt(m.bytes);
      this.calls.terminate(sys, c.hz, lch, now);
      text += ` · TG ${e.group}${e.src && e.src !== 0xffffff ? ` ← ${e.src}` : ''} · NAC ${h(e.nac, 3)}`;
    } else {
      const msgs = p2Messages(m.bytes);
      for (const x of msgs) {
        const b = x.bytes;
        if (x.b === 0 && x.mco === 1 && b.length >= 7) {
          // a group voice channel user: who is on this logical channel (while it is active)
          const so = b[1], group = (b[2] << 8) | b[3], src = (b[4] << 16) | (b[5] << 8) | b[6];
          if (m.opcode === 4) {
            const call = this.calls.lc(sys, c.hz, lch, { group: true, dst: group, src, emergency: (so & 0x80) !== 0, privacy: false }, now, 'P25', true);
            if (so & 0x40) this.calls.security(call, { enc: true, from: 'grant' });
          }
          text += ` · ${x.name} TG ${group}${src ? ` ← ${src}` : ''}${so & 0x80 ? ' · EMERGENCY' : ''}${so & 0x40 ? ' · PROTECTED' : ''}`;
        } else if (x.b === 1 && b.length >= 9) {
          // a Phase 1 broadcast in its abbreviated form: the trunking block parser reads it
          const t = parseTsbk(Uint8Array.from([x.mco, 0, ...b.subarray(1, 9), 0, 0]));
          const s = this.systems.get(sys);
          if (s && (t.kind === 'update' || t.kind === 'grant')) this.p25Apply(c, t, s, now);
          text += ` · ${tsbkLine(t)}`;
        } else text += ` · ${x.name}`;
      }
    }
    this.addLog({ ms: now, hz: c.hz, proto: 'P25', name: op, text: `PHASE 2 · ${text}`, hex: hex(m.bytes), ok: true });
    this.pending = true;
  }
  private classify(c: Carrier, ch: Chan, now: number): void {
    if (c.tdma && !ch.p2) this.p2On(c, ch);
    if (!c.tdma && !ch.tetra && c.cls !== 'TETRA' && now - ch.openedMs > 1_500 && !(c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000) && tetraBand(c.hz)) this.tetraOn(c, ch);
    if (!c.tdma && !ch.nxdn && c.cls !== 'TETRA' && now - ch.openedMs > 1_500 && !(c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000)) this.nxdnOn(c, ch);
    c.heardMs += 500; c.envCv = Math.round(ch.rx.envCv * 100) / 100; c.eye = Math.round(ch.rx.eye * 100) / 100;
    if (c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000) return;
    if (now - ch.openedMs < CLASS_MS) return;
    if (c.tdma && ch.rx.envCv > 0.15) c.cls = 'P25 PHASE 2 TDMA';
    else if (ch.rx.eye > 1.3 && ch.rx.envCv < 0.15) c.cls = 'UNKNOWN 4FSK';
    else if (ch.rx.envCv > 0.18) c.cls = 'UNKNOWN LINEAR';
    else c.cls = 'ANALOG FM';
    const nx = this.nxdnSeen.get(c.key); if (nx && now - nx.ms < 5_000) c.cls = nx.baud === 2400 ? 'NXDN48' : 'NXDN96';
  }

  // ------------------------------------------------------------------------------------------------ Motorola Type II
  private readonly oswParsers = new Map<number, OswParser>();
  /**
   * A signaling word that passed its check. A carrier becomes a Type II control channel on its third word, with at
   * least half the frames since its first passing: a chance pass on noise never makes one.
   */
  private oswWord(c: Carrier, ch: Chan, o: Osw, gap: number): void {
    const now = this.now(), rx = ch.osw;
    if (c.cls !== 'MOTOROLA TYPE II') {
      if (rx.good < 3 || rx.good < 0.5 * rx.expected) return;
      c.cls = 'MOTOROLA TYPE II'; c.role = 'control';
    }
    c.frames++; c.blocks = rx.expected; c.crcOk = rx.good; c.lastDecodeMs = now; this.blocks++;
    let p = this.oswParsers.get(c.key); if (!p) { p = new OswParser(); this.oswParsers.set(c.key, p); }
    const ev = gap > 1 ? p.lost() : [];
    ev.push(...p.push(o));
    for (const e of ev) this.oswEvent(c, e, now);
  }
  private oswSys(id: number, now: number): Sys {
    const key = `SMARTNET ${h(id, 4)}`;
    let s = this.systems.get(key);
    if (!s) {
      s = { key, proto: 'SMARTNET', color: this.colorNext++, wacn: -1, sysId: id, cc: -1, fid: -1, net: -1, model: '', firstMs: now, lastMs: now, idens: new Map(), derived: false, trunk: 'TYPE II', lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [], lpcnVotes: new Map(), lpcnHz: new Map(), heardHz: new Set() };
      this.systems.set(key, s);
    }
    s.trunk = 'TYPE II';
    if (!s.osw) s.osw = { plan: null, chans: new Map() };
    s.lastMs = now;
    return s;
  }
  private oswEvent(c: Carrier, e: OswEvent, now: number): void {
    const hexw = oswHex(e.words), log = (name: string, text: string) => this.addLog({ ms: now, hz: c.hz, proto: 'TYPE II', name, text, hex: hexw, ok: true });
    if (e.kind === 'sysid') {
      const s = this.oswSys(e.sys, now); c.sys = s.key; s.heardHz.add(c.key);
      const plan = provePlan(e.cc, c.hz);
      c.osw = { cc: e.cc, plan };
      if (plan && !s.osw!.plan) s.osw!.plan = plan;
      log('SYSTEM ID', `SYSTEM ${h(e.sys, 4)} · CONTROL CHANNEL ${e.cc}${plan ? ` · ${plan.label}` : ' · no channel plan puts that number on this frequency'}`);
      this.pending = true;
      return;
    }
    const s = c.sys ? this.systems.get(c.sys) : undefined;
    if (e.kind === 'grant' || e.kind === 'update') {
      const tg = e.group ? tgOf(e.tg) : e.tg, st = e.group ? tgStatus(e.tg) : 0;
      const who = `${e.group ? 'TG' : 'UNIT'} ${tg}${st ? ` · STATUS ${st}` : ''}${e.kind === 'grant' ? ` ← ${e.src}` : ''}`;
      if (!s?.osw) { log(e.kind === 'grant' ? 'GRANT' : 'UPDATE', `${who} · CH ${e.ch} · system ID not heard yet`); return; }
      s.lastMs = now;
      const plan = s.osw.plan, hz = plan ? plan.hz(e.ch) : 0;
      s.osw.chans.set(e.ch, (s.osw.chans.get(e.ch) ?? 0) + 1);
      const site = this.oswSiteLabel(c);
      this.grant(s.key, { ms: now, lastMs: now, sys: s.key, kind: e.kind === 'grant' ? 'grant' : 'update', tg, group: e.group, src: e.kind === 'grant' ? e.src : 0, ch: `CH ${e.ch}`, hz, slot: 0, tdma: false, emergency: false, encrypted: false, carrierHz: c.hz, site, lpcn: e.ch }, e.kind === 'update');
      if (e.kind === 'grant') this.touchUnit(s.key, e.src, c, now, 'grant', { hex: hexw, line: `GRANT ${who} · CH ${e.ch}` }, site, e.group ? tg : undefined);
      log(e.kind === 'grant' ? 'GRANT' : 'UPDATE', `${who} · CH ${e.ch}${hz ? ` · ${(hz / 1e6).toFixed(4)} MHz` : ''}`);
      return;
    }
    if (e.kind === 'idle') return;
    log(`OSW ${e.words.map(w => h(w.cmd, 3)).join('+')}`, `not read · ${e.words.map(oswWordText).join(' / ')}`);
  }
  private oswSiteLabel(c: Carrier): string { return c.osw ? `channel ${c.osw.cc}` : `${(c.hz / 1e6).toFixed(4)} MHz`; }
  /** A Type II voice channel: analog FM voice to the call on the air there. */
  private fmOn(c: Carrier, ch: Chan): void {
    if (ch.fm) return;
    ch.fm = new FmVoice(ch.fs);
    ch.fm.onPcm = (pcm, open) => { const call = this.calls.at('', c.hz, 0); if (call?.proto === 'SMARTNET') { this.calls.analog(call, pcm, open); if (open) this.pending = true; } };
  }
  private oswSites(s: Sys): SiteRow[] {
    const cs = [...this.carriers.values()].filter(c => c.sys === s.key && c.cls === 'MOTOROLA TYPE II');
    const plan = s.osw?.plan ?? null;
    const lcns = plan ? [...(s.osw?.chans.keys() ?? [])].sort((a, b) => a - b).map(ch => ({ lcn: ch, hz: plan.hz(ch), slot: 0 })) : [];
    return cs.map(c => ({ key: `${s.key}/${c.key}`, label: this.oswSiteLabel(c), rfss: -1, site: c.osw?.cc ?? -1, nac: -1, ccHz: [c.hz], lastMs: c.lastMs, levelDb: c.levelDb,
      neighbors: [], secondary: [], time: c.osw ? (c.osw.plan ? c.osw.plan.label : 'channel plan not proved') : '', callsign: c.callsign, carriers: [c.key], lcns, rest: -1, busy: [], idens: [], units: 0, lra: -1, cls: -1 }));
  }

  // ------------------------------------------------------------------------------------------------ P25
  private p25Frame(c: Carrier, nac: number, duid: number): void {
    const now = this.now();
    c.frames++; c.nac = nac; c.lastDecodeMs = now; this.p25Seen.set(c.key, now);
    c.cls = c.envCv > 0.2 ? 'P25 CQPSK/LSM' : 'P25 C4FM';
    if (duid === 7) c.role = 'control';
    else if (duid === 0xc) { if (c.role !== 'control') c.role = 'data'; }
    else if (c.role !== 'control') c.role = 'voice';
    if (duid !== 7) this.pending = true;
    if (c.role === 'voice') {
      // header, voice frames (nine vocoder frames each), terminators
      if (duid === 0 || duid === 5 || duid === 10) this.calls.voice(c.sys, 'P25', c.hz, 0, duid === 0 ? 0 : 180, now);
      else if (duid === 3 || duid === 15) this.calls.terminate(c.sys, c.hz, 0, now);
    }
  }
  private p25Block(c: Carrier, _ch: Chan | null, b: P25Block): void {
    const now = this.now();
    // voice channels carry no trunking blocks: one that fails its CRC there is noise that looked like a frame
    if (!b.crcOk && c.role === 'voice') return;
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
      s = { key, proto: 'P25', color: this.colorNext++, wacn: id.wacn, sysId: id.sys, cc: -1, fid: -1, net: -1, model: '', firstMs: now, lastMs: now, idens: new Map(), derived: false, lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [], lpcnVotes: new Map(), lpcnHz: new Map(), heardHz: new Set() };
      this.systems.set(key, s);
    }
    s.lastMs = now; c.sys = key; if (t.kind !== 'iden') s.heardHz.add(c.key);
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
    // a mobile's burst (MS sync) carries no CACH: no slot is read from it
    const ts = b.ms ? 'FROM A RADIO' : `TS${b.slot + 1}`;
    // an NXDN carrier's 2400 or 4800 symbols can pass for a DMR burst now and then
    if (this.nxdnLately(c, now)) return;
    if (b.dt > 10) return;
    if (c.tdma || this.now() - (this.p2Seen.get(c.key) ?? -1e12) < 5_000) return;
    // nor are a P25 carrier's, as for the voice bursts below
    if (now - (this.p25Seen.get(c.key) ?? -1e12) < 2_000) return;
    if (!this.dmrProven(c, b, now)) return;
    c.frames++; if (b.stErrs === 0 || c.cc < 0) c.cc = b.cc; c.cls = 'DMR'; c.lastDecodeMs = now; this.dmrSeen.set(c.key, now);
    if (b.dt === 1 || b.dt === 2) {
      if (c.role !== 'control' && c.role !== 'rest') c.role = 'voice';
      this.pending = true;
      const lc = parseLc(b.bytes, b.dt);
      if (lc?.ok) {
        // a terminator labels the call it ends; on its own it is no call
        if (b.dt === 1 || this.calls.onAirAt(c.sys, c.hz, b.slot)) {
          if (b.dt === 1) this.learnLpcn(c, b.slot, lc, now);
          const call = this.calls.lc(c.sys, c.hz, b.slot, lc, now);
          if (call.sys && !c.sys) c.sys = call.sys;
        }
        if (b.dt === 2) this.calls.terminate(c.sys, c.hz, b.slot, now);
        const name = b.dt === 1 ? 'VOICE LC HEADER' : 'TERMINATOR WITH LC';
        this.addLog({ ms: now, hz: c.hz, proto: 'DMR', name, text: `CC ${b.cc} · ${ts} · ${name} · ${lc.group ? 'TG' : 'UNIT'} ${lc.dst} ← ${lc.src}${lc.emergency ? ' · EMERGENCY' : ''}${lc.privacy ? ' · PRIVACY' : ''}`, hex: hex(b.bytes), ok: true });
      } else if (b.dt === 2) this.calls.terminate(c.sys, c.hz, b.slot, now);
      return;
    }
    if (b.dt === 9) return;
    const mask = DMR_CRC_MASK[b.dt];
    const ok = mask !== undefined && crc12Ok(b.bytes, mask);
    // a privacy indicator header (it follows the voice LC header of an encrypted call): the call it opens is encrypted
    // its fields (not in ETSI TS 102 361; read from public descriptions, not yet verified on air): algorithm ID in
    // octet 0, key ID in octet 2, a 32-bit MI in octets 3 to 6
    if (b.dt === 0 && ok) { const y = b.bytes; this.calls.securityAt(c.sys, c.hz, b.slot, { enc: true, from: 'PI', pi: hex(y, 0, 10), algId: y[0], keyId: y[2], mi: hex(y, 3, 7) }); this.pending = true; }
    // as on P25: a block failing its CRC on a voice channel is noise that looked like a burst
    if (!ok && c.role === 'voice' && b.dt !== 3) return;
    if (!ok && c.role === 'voice' && b.dt === 3 && !(b.bytes[1] === 0x10 && ((b.bytes[0] & 0x3f) === 0x09 || (b.bytes[0] & 0x3f) === 0x3d))) return;
    c.blocks++; this.blocks++;
    if (ok) c.crcOk++;
    if (b.dt === 3) {
      const op = b.bytes[0] & 0x3f, vendor = !ok && b.bytes[1] === 0x10 && (op === 0x09 || op === 0x3d);
      const vok = vendor && this.vendor.check(b.bytes, `${b.cc}`);
      if (vok) c.crcOk++;
      const cs = parseCsbk(b.bytes, ok || vok);
      // the unit-report families are kept when their check fails (shown unverified); anything else has to pass its CRC
      if (!ok && !vok && !(cs.derived && (cs.kind === 'unitrpt' || cs.kind === 'unithdr' || cs.kind === 'callann'))) return;
      // radios heard directly (inbound or talkaround) are not a control channel
      if (c.role === '' || c.role === 'voice') c.role = b.ms ? 'data' : 'control';
      const s = this.dmrSystem(c, cs, b.cc, now);
      this.dmrApply(c, cs, b.slot, s, now);
      this.addLog({ ms: now, hz: c.hz, proto: 'DMR', name: cs.name, text: `CC ${b.cc} · ${ts} · ${csbkLine(cs)}`, hex: cs.hex, ok: ok || vok });
    } else if (ok || b.dt === 7) {
      if (b.dt === 6 || b.dt === 7) { if (c.role === '') c.role = 'data'; }
      const name = ['PI HEADER', 'VOICE HEADER', 'TERMINATOR', 'CSBK', 'MBC HEADER', 'MBC CONTINUATION', 'DATA HEADER', 'RATE 1/2 DATA', 'RATE 3/4 DATA', 'IDLE', 'RATE 1 DATA'][b.dt];
      this.addLog({ ms: now, hz: c.hz, proto: 'DMR', name, text: `CC ${b.cc} · ${ts} · ${name}${ok ? '' : ' · no block CRC'} · ${hex(b.bytes)}`, hex: hex(b.bytes), ok });
    }
  }
  /** A DMR voice burst: keeps its call on the air and hands its three vocoder frames on. */
  /**
   * One IMBE frame out of a P25 voice frame. Until a grant or the link control says what the call is, its frames wait
   * in the call (the LDU1 that names it arrives after its own nine frames, which used to be thrown away).
   */
  private p25Voice(c: Carrier, bits: Uint8Array, ch?: Chan): void {
    const call = this.calls.at(c.sys, c.hz, 0);
    if (call) { this.calls.frames(call, [bits]); ch?.voiced(2); }
  }
  /** Erasures for voice that did not come when due ([Chan.onFill]): only for a call on the air, never making one. */
  private fill(c: Carrier, lane: number, n: number): void {
    const call = this.calls.at(c.sys, c.hz, lane === 2 ? 0 : lane);
    if (!call?.onAir || call.proto !== (lane === 2 ? 'P25' : 'DMR') || call.tdma) return;
    this.calls.frames(call, Array.from({ length: n }, () => new Uint8Array(0)));
  }
  /** Link control read out of an LDU1 (talkgroup or unit, source, encryption) labels the call on that channel. */
  private p25Lc(c: Carrier, ch: Chan): void {
    const st = ch.p25v.status(ch.t), fresh = st.errs === ch.lcErrs;
    ch.lcErrs = st.errs;
    if (st.duid !== 5 || !fresh || (st.lcf !== 0 && st.lcf !== 3) || (!st.talkgroup && !st.source) || !this.calls.onAirAt(c.sys, c.hz, 0)) return;
    this.calls.lc(c.sys, c.hz, 0, { group: st.lcf === 0, dst: st.talkgroup, src: st.source, emergency: st.emergency, privacy: st.encrypted }, this.now(), 'P25');
  }
  /** The encryption sync of an LDU2, or a call header: algorithm, key, message indicator. 0x80 is in the clear. */
  private p25Sec(c: Carrier, from: 'LDU2' | 'HDU', es: { algId: number; keyId: number; mi: string }): void {
    const now = this.now(), clear = es.algId === 0x80;
    const call = this.calls.securityAt(c.sys, c.hz, 0, { enc: !clear, from, algId: es.algId, keyId: es.keyId, mi: es.mi });
    if (call) this.pending = true;
    const name = from === 'HDU' ? 'HEADER' : 'ENCRYPTION SYNC';
    this.addLog({ ms: now, hz: c.hz, proto: 'P25', name, text: `NAC ${h(Math.max(0, c.nac), 3)} · ${name} · ALGID ${h(es.algId, 2)} · KEY ${h(es.keyId, 4)} · MI ${es.mi.toUpperCase()}`, hex: '', ok: true });
  }
  /** Embedded LC fragments and talker aliases being put together, per carrier and slot. */
  private readonly embAsm = new Map<string, EmbLcAssembler>(); private readonly aliases = new Map<string, TalkerAlias>();
  private readonly embSeen = new Map<string, number>(); private readonly unitAlias = new Map<string, string>();
  /** An embedded voice LC: the call on that slot is named (talkgroup, unit) and its privacy bit taken, as from a header. */
  private embLc(c: Carrier, slot: number, lc: { group: boolean; dst: number; src: number; emergency: boolean; privacy: boolean; fid: number }, now: number): void {
    if (!lc.dst && !lc.src) return;
    const call = this.calls.lc(c.sys, c.hz, slot, { ...lc }, now, 'DMR');
    if (call.sys && !c.sys) c.sys = call.sys;
    const k = `${c.key}:${slot}:${lc.dst}:${lc.src}:${lc.privacy}`;
    if (this.embSeen.get(k) === undefined || now - this.embSeen.get(k)! > 10_000) {
      this.embSeen.set(k, now); if (this.embSeen.size > 500) this.embSeen.clear();
      this.addLog({ ms: now, hz: c.hz, proto: 'DMR', name: 'EMBEDDED LC', text: `CC ${c.cc} · TS${slot + 1} · EMBEDDED LC · ${lc.group ? 'TG' : 'UNIT'} ${lc.dst} ← ${lc.src}${lc.fid === 0x10 ? ' · FID 10' : ''}${lc.emergency ? ' · EMERGENCY' : ''}${lc.privacy ? ' · PRIVACY' : ''}`, hex: '', ok: true });
    }
    this.pending = true;
  }
  /** A talker alias part: once the name is whole it labels the call and its unit. */
  private embAlias(c: Carrier, slot: number, part: number, bytes: Uint8Array): void {
    const k = `${c.key}:${slot}`, ta = this.aliases.get(k) ?? (() => { const x = new TalkerAlias(); this.aliases.set(k, x); return x; })();
    const name = ta.push(part, bytes); if (!name) return;
    const call = this.calls.at(c.sys, c.hz, slot);
    if (call && call.alias !== name) { call.alias = name; this.pending = true; }
    if (call && call.src) { this.unitAlias.set(`${call.sys || c.sys}/${call.src}`, name); const u = this.units.get(`${call.sys || c.sys}/${call.src}`); if (u) u.alias = name; }
    if (call && call.alias === name) this.addLog({ ms: this.now(), hz: c.hz, proto: 'DMR', name: 'TALKER ALIAS', text: `TS${slot + 1} · TALKER ALIAS · ${name}${call.src ? ` · UNIT ${call.src}` : ''}`, hex: '', ok: true });
  }
  /**
   * A carrier not heard as DMR in the last 3 s has to prove it before a burst counts: the burst's own check passes (the
   * block CRC, or the RS check of a voice header or terminator), or its slot type needed no correction. A pager, an
   * analog or bare carrier, or a P25 voice channel passes the 0.82 sync now and then, and about a third of those chance
   * bursts pass the slot type's Golay code with corrections (almost none without): such a carrier was labeled DMR
   * voice, and its unchecked blocks could reach the tables.
   */
  private dmrProven(c: Carrier, b: DmrEvent['burst'], now: number): boolean {
    if (b.stErrs === 0 || now - (this.dmrSeen.get(c.key) ?? -1e12) <= 3_000) return true;
    if (b.dt === 1 || b.dt === 2) return !!parseLc(b.bytes, b.dt)?.ok;
    const mask = DMR_CRC_MASK[b.dt];
    return mask !== undefined && crc12Ok(b.bytes, mask);
  }
  /** Per carrier: the last EMB that passed its check on a voice burst with no DMR data heard, for [dmrVoice]. */
  private readonly embVotes = new Map<number, { cc: number; ms: number }>();
  private dmrVoice(c: Carrier, ch: Chan | null, slot: number, d: Uint8Array, n = 0): void {
    const now = this.now();
    // a P25 channel's voice frames can look like a DMR voice sync now and then
    // and a voice sync counts on a carrier that has sent real DMR bursts lately, or whose voice superframes keep
    // their 360 ms grid on their own (a call joined late, with no data burst heard)
    if (now - (this.p25Seen.get(c.key) ?? -1e12) < 2_000) return;
    if (this.nxdnLately(c, now)) return;
    // a P25 Phase 2 channel (a grant said TDMA, or its syncs were heard) is never read as DMR
    if (c.tdma || now - (this.p2Seen.get(c.key) ?? -1e12) < 5_000) return;
    // nor is a carrier next to one (a Phase 2 signal the carrier finder split, or its neighbor 12.5 kHz away)
    for (const x of this.carriers.values()) if (x !== c && Math.abs(x.hz - c.hz) <= 13_000 && (x.tdma || now - (this.p2Seen.get(x.key) ?? -1e12) < 5_000)) return;
    // the receiver's own DC spike at the center of the span, and bursts of one repeated symbol (a bare carrier),
    // are not DMR: an all-zero EMB passes any linear code
    if (ch && !ch.baseband && Math.abs(c.hz - this.centerHz) < 2_000) return;
    { const k = [0, 0, 0, 0]; for (let i = 0; i < d.length; i++) k[d[i] & 3]++; if (Math.max(...k) > 0.7 * d.length) return; }
    const data = now - (this.dmrSeen.get(c.key) ?? -1e12) <= 3_000;
    if (!data && !ch?.dmr.voiceLive) return;
    // with no DMR data burst heard lately, the voice alone has to prove itself: two EMBs that pass their (16,7) check
    // with the same color code within a second (a Phase 2 superframe also repeats every 360 ms)
    if (!data && !this.calls.at(c.sys, c.hz, slot)) {
      if (n === 0) return;
      const e = readEmb(d); if (!e.ok) return;
      const v = this.embVotes.get(c.key);
      if (!v || v.cc !== e.cc || now - v.ms > 1_000) { this.embVotes.set(c.key, { cc: e.cc, ms: now }); return; }
    }
    c.lastDecodeMs = now; c.cls = 'DMR'; c.frames++;
    if (c.role === '') c.role = 'voice';
    const call = this.calls.voice(c.sys, 'DMR', c.hz, slot, 60, now);
    // bursts B to F carry the EMB: its privacy bit says whether the call is encrypted, read before the frames play
    if (n > 0) {
      const e = readEmb(d);
      if (e.ok && (c.cc < 0 || e.cc === c.cc)) {
        this.calls.security(call, { enc: e.pi, from: 'EMB' });
        // bursts B to E also carry the embedded LC in four fragments: who is talking to whom, the privacy bit, the alias
        const k = `${c.key}:${slot}`, asm = this.embAsm.get(k) ?? (() => { const x = new EmbLcAssembler(); this.embAsm.set(k, x); return x; })();
        const lc = n <= 4 ? asm.push(e.lcss, embBits(d)) : (asm.reset(), null);
        const p = lc ? parseEmbLc(lc) : null;
        if (p?.kind === 'voice') this.embLc(c, slot, p.lc, now);
        else if (p?.kind === 'alias') this.embAlias(c, slot, p.part, p.bytes);
      }
    }
    this.calls.frames(call, voiceFrames(d)); ch?.voiced(slot);
    this.pending = true;
  }
  private dmrSystem(c: Carrier, cs: Csbk, cc: number, now: number): Sys {
    let key = c.dmrSys;
    if (cs.verified && cs.sysCode !== undefined) key = `DMR ${cs.model} ${cs.net}`;
    else if (!key) key = `DMR CC${cc} FID ${h(cs.fid, 2)}`;
    c.dmrSys = key; c.sys = key;
    let s = this.systems.get(key);
    if (!s) {
      s = { key, proto: 'DMR', color: this.colorNext++, wacn: -1, sysId: -1, cc, fid: cs.fid, net: cs.net ?? -1, model: cs.model ?? '', firstMs: now, lastMs: now, idens: new Map(), derived: !!cs.derived, lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [], lpcnVotes: new Map(), lpcnHz: new Map(), heardHz: new Set() };
      this.systems.set(key, s);
    }
    s.lastMs = now; s.cc = cc; s.heardHz.add(c.key); if (cs.derived) s.derived = true;
    return s;
  }
  private dmrApply(c: Carrier, cs: Csbk, slot: number, s: Sys, now: number): void {
    switch (cs.kind) {
      case 'beacon': {
        s.trunk = 'CAPACITY PLUS';
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
        if (cs.verified && cs.fid === 0) s.trunk = 'TIER III';
        if (cs.dst === undefined) break;
        const lp = cs.lpcn ?? -1, hz = s.lpcnHz.get(lp) ?? 0;
        this.pendingGrants = this.pendingGrants.filter(g => now - g.ms < 3_000);
        this.pendingGrants.push({ sys: s.key, tg: cs.dst, group: !!cs.group, lpcn: lp, slot: cs.slot ?? 0, ms: now });
        this.grant(s.key, { ms: now, lastMs: now, sys: s.key, kind: cs.group ? 'grant' : 'u2u', tg: cs.dst, group: !!cs.group, src: cs.src ?? 0, ch: `LPCN ${lp}`, hz, slot: cs.slot ?? 0, tdma: false, emergency: !!cs.emergency, encrypted: false, carrierHz: c.hz, site: '', lpcn: lp, chDerived: hz > 0 }, false);
        if (cs.src) this.touchUnit(s.key, cs.src, c, now, 'grant', cs, '', cs.group ? cs.dst : undefined);
        break;
      }
      case 'ack': case 'unit': case 'aloha': case 'callann': {
        if (cs.kind === 'aloha' && cs.verified) s.trunk = 'TIER III'; const id = cs.kind === 'callann' ? cs.unit : cs.dst; if (id && id < 0xfffff0) this.touchUnit(s.key, id, c, now, cs.kind === 'ack' ? 'acknowledged' : cs.name.toLowerCase(), cs, ''); break; }
    }
  }
  /**
   * A voice LC header on [c]: a DMR grant of the last two seconds to the same talkgroup and slot says which logical
   * channel this carrier is. Each logical channel takes the carrier it got at least two votes and two thirds of
   * (derived from what the channels carry, not from a channel plan on the air).
   */
  private learnLpcn(c: Carrier, slot: number, lc: { group: boolean; dst: number }, now: number): void {
    const i = this.pendingGrants.findIndex(g => now - g.ms < 2_000 && g.lpcn >= 0 && g.tg === lc.dst && g.group === lc.group && g.slot === slot && (!c.sys || c.sys === g.sys));
    if (i < 0) return;
    const g = this.pendingGrants[i]; this.pendingGrants.splice(i, 1);
    const s = this.systems.get(g.sys); if (!s) return;
    const v = s.lpcnVotes.get(g.lpcn) ?? new Map<number, number>(), k = c.hz;
    v.set(k, (v.get(k) ?? 0) + 1); s.lpcnVotes.set(g.lpcn, v);
    let best = 0, n = 0, all = 0; for (const [hz, m] of v) { all += m; if (m > n) { n = m; best = hz; } }
    if (n >= 2 && n * 3 >= all * 2) {
      for (const [l, hz] of s.lpcnHz) if (hz === best && l !== g.lpcn) s.lpcnHz.delete(l);
      if (s.lpcnHz.get(g.lpcn) !== best) { s.lpcnHz.set(g.lpcn, best); this.pending = true; }
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
    const fx = u.fixes[u.fixes.length - 1];
    if (!fx || fx[1] !== cs.latLo || fx[2] !== cs.lonLo) { u.fixes.push([now, cs.latLo, cs.lonLo]); if (u.fixes.length > 300) u.fixes.shift(); }
    this.anchorsAt = -1;
    const p = this.place(s.key, cs.latLo, cs.lonLo);
    if (last && p) { last.lat = p[0]; last.lon = p[1]; }
  }
  private cwText(c: Carrier, text: string): void {
    const word = text.split(' ').find(looksLikeCallsign);
    this.addLog({ ms: this.now(), hz: c.hz, proto: 'CW', name: 'CW ID', text: `CW ID · ${text}`, hex: '', ok: !!word });
    if (word) { const now = this.now(); c.callsign = word; c.callsignMs = now; this.calls.cwId(c.sys, c.hz, word, now); this.pending = true; }
  }

  // ------------------------------------------------------------------------------------------------ tables
  private touchUnit(sys: string, id: number, c: Carrier, now: number, kind: string, msg: Tsbk | Csbk | { hex: string; line: string }, site: string, group?: number): Unit {
    const key = `${sys}/${id}`;
    let u = this.units.get(key);
    if (!u) { u = { key, sys, id, firstMs: now, lastMs: now, lonLo: -1, latLo: -1, posMs: 0, posVerified: false, trail: [], groups: new Set(), grants: 0, carriers: new Set(), reports: [], fixes: [], tgCounts: new Map() }; this.units.set(key, u); }
    u.lastMs = now; u.carriers.add(c.key);
    if (group !== undefined) { u.groups.add(group); u.tgCounts.set(group, (u.tgCounts.get(group) ?? 0) + 1); this.tgFor(sys, group, now).members.add(id); }
    if (kind === 'grant' || kind === 'u2u' || kind === 'datagrant') u.grants++;
    const cs = 'verified' in msg ? msg as Csbk : null, text = 'line' in msg ? msg.line : cs ? csbkLine(cs) : tsbkLine(msg as Tsbk);
    u.reports.push({ ms: now, hz: c.hz, kind: `${kind}${site ? ` · site ${site}` : ''}`, hex: msg.hex, verified: cs ? cs.verified : true, lat: null, lon: null, text, db: c.levelDb });
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
    if (g.kind !== 'datagrant') {
      const p25 = sys.startsWith('P25'), tetra = sys.startsWith('TETRA'), nxdn = sys.startsWith('NXDN'), sn = sys.startsWith('SMARTNET');
      const proto: CallProto = p25 ? 'P25' : tetra ? 'TETRA' : nxdn ? 'NXDN' : sn ? 'SMARTNET' : 'DMR';
      const call = this.calls.grant({ sys, proto, tg: g.tg, group: g.group, src: g.src, hz: g.hz, slot: p25 ? (g.tdma ? g.slot : 0) : g.slot, tdma: g.tdma, encrypted: g.encrypted, emergency: g.emergency, site: g.site, lpcn: g.lpcn, chDerived: g.chDerived, efr: g.efr }, g.ms);
      // a voice channel inside the span is listened to from the grant on, not from the next channel assignment
      if (call?.onAir && !call.muted && call.hz && this.rate > 0 && this.inSpan(call.hz)) {
        const vc = this.carrierAt(call.hz); if (!vc.role) vc.role = 'voice'; if (!vc.sys) vc.sys = sys;
        if (!this.chans.has(vc.key)) { vc.lastAuditionMs = g.ms; this.open(vc, g.ms); vc.decoding = true; }
        const ch = this.chans.get(vc.key);
        if (tetra && ch && !ch.tetra) this.tetraOn(vc, ch);
        // an NXDN voice channel is read from its first frame, at the system's symbol rate
        if (nxdn && ch && !ch.nxdn) this.nxdnOn(vc, ch, this.systems.get(sys)?.nxdnBaud);
        // a Type II voice channel carries analog FM
        if (sn && ch) this.fmOn(vc, ch);
      } else if (sn && call?.onAir && call.hz) {
        // a recorded channel fed as its own baseband
        const vc = this.carriers.get(gridKey(call.hz)), ch = vc && this.chans.get(vc.key);
        if (vc && ch) { if (!vc.role) vc.role = 'voice'; if (!vc.sys) vc.sys = sys; this.fmOn(vc, ch); }
      }
    }
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
    if (u.lonLo < 0 && u.fix) {
      // a position kept from an earlier session: shown only where the system's radios can be (an older build drew
      // some reports in the wrong place)
      const a = this.anchorFor(u.sys), r = a ?? this.ref;
      return !r || kmBetween(u.fix[0], u.fix[1], r.lat, r.lon) <= (a ? PLACE_KM : PLACE_RX_KM) ? [u.fix[0], u.fix[1]] : [null, null];
    }
    if (u.lonLo < 0) return [null, null];
    const p = this.place(u.sys, u.latLo, u.lonLo);
    return p ? p : [null, null];
  }
  /**
   * DMR unit reports carry only the low 16 bits of each coordinate (about 5.6 degrees a cycle), so each report has a
   * twin every 5.6 degrees and is resolved to the one nearest a reference. The reference is the system's own area
   * once three or more of its units agree on it (the median of their positions, at least three within 40 km of it):
   * units of one system cluster around its sites. A report that lands farther than [PLACE_KM] from that area (or
   * [PLACE_RX_KM] from the receiver, before the system has an area) is not a place the system's radios can be: it is
   * left off the map rather than drawn in the ocean, and counted.
   */
  private place(sys: string, lat16: number, lon16: number): [number, number] | null {
    if (!this.ref) return null;
    const a = this.anchorFor(sys), r = a ?? this.ref;
    const lat = round6(unwrap16(lat16, r.lat)), lon = round6(unwrap16(lon16, r.lon));
    return kmBetween(lat, lon, r.lat, r.lon) <= (a ? PLACE_KM : PLACE_RX_KM) ? [lat, lon] : null;
  }
  private readonly anchors = new Map<string, { lat: number; lon: number } | null>(); private anchorsAt = -1;
  private anchorFor(sys: string): { lat: number; lon: number } | null {
    if (this.anchorsAt < 0) { this.anchors.clear(); this.anchorsAt = 1; }
    if (this.anchors.has(sys)) return this.anchors.get(sys)!;
    let out: { lat: number; lon: number } | null = null;
    if (this.ref) {
      const pts: [number, number][] = [];
      for (const u of this.units.values()) if (u.sys === sys && u.lonLo >= 0) pts.push([unwrap16(u.latLo, this.ref.lat), unwrap16(u.lonLo, this.ref.lon)]);
      if (pts.length >= 3) {
        const med = (v: number[]) => { const x = [...v].sort((p, q) => p - q); return x[x.length >> 1]; };
        const m = { lat: med(pts.map(p => p[0])), lon: med(pts.map(p => p[1])) };
        if (pts.filter(p => kmBetween(p[0], p[1], m.lat, m.lon) <= 40).length >= 3) out = m;
      }
    }
    this.anchors.set(sys, out);
    return out;
  }
  /**
   * Where each call on the air is heard from: the talking unit's last position, else the latest position of any unit
   * in the talkgroup. The call keeps the last one placed while it was on the air.
   */
  private placeCalls(): void {
    if (!this.ref) return;
    for (const c of this.calls.calls) {
      if (!c.onAir || c.kind !== 'call') continue;
      const pos = this.callPos(c);
      if (pos) this.calls.place(c, pos);
    }
  }
  private callPos(c: CallRow): CallPos | null {
    const at = (u: Unit | undefined, via: 'unit' | 'talkgroup'): CallPos | null => {
      if (!u || u.lonLo < 0) return null;
      const [lat, lon] = this.resolvePos(u);
      return lat === null || lon === null ? null : { lat, lon, unit: u.id, ms: u.posMs, via, verified: u.posVerified };
    };
    const unitOf = (id: number): Unit | undefined => {
      if (!id) return undefined;
      if (c.sys) return this.units.get(`${c.sys}/${id}`) ?? (id > 0xffff ? this.units.get(`${c.sys}/${id & 0xffff}`) : undefined);
      let found: Unit | undefined;
      for (const u of this.units.values()) if (u.id === id && u.lonLo >= 0) { if (found) return undefined; found = u; }
      return found;
    };
    const own = at(unitOf(c.src), 'unit'); if (own) return own;
    if (!c.group || !c.tg) return null;
    // a call on a channel no control channel has named yet: the talkgroup, when only one system has it
    const t = c.sys ? this.tgs.get(`${c.sys}/${c.tg}`) : (() => { const m = [...this.tgs.values()].filter(x => x.tg === c.tg); return m.length === 1 ? m[0] : undefined; })();
    let best: CallPos | null = null;
    for (const m of t?.members ?? []) { const p = at(unitOf(m), 'talkgroup'); if (p && (!best || p.ms > best.ms)) best = p; }
    return best;
  }
  /**
   * What the device keeps between sessions: every system heard (where, and what it was) and every unit position
   * decoded. [restore] puts it back; positions from the air replace the kept ones as they come.
   */
  known(): KnownState {
    const systems: KnownSystem[] = [...this.systems.values()].map(s => ({ key: s.key, proto: s.proto, wacn: s.wacn, sysId: s.sysId, cc: s.cc, fid: s.fid, net: s.net, model: s.model, firstMs: s.firstMs, lastMs: s.lastMs, derived: s.derived, hz: [...s.heardHz].slice(0, 12) }));
    const units: KnownUnit[] = [];
    for (const u of this.units.values()) { const [lat, lon] = this.resolvePos(u); if (lat !== null && lon !== null) units.push({ sys: u.sys, id: u.id, lat, lon, posMs: u.posMs, verified: u.posVerified, firstMs: u.firstMs, lastMs: u.lastMs }); }
    units.sort((a, b) => b.posMs - a.posMs);
    return { v: 1, systems, units: units.slice(0, KNOWN_UNITS) };
  }
  restore(k: KnownState): void {
    if (!k || k.v !== 1) return;
    for (const x of k.systems ?? []) {
      let s = this.systems.get(x.key);
      if (!s) { s = { key: x.key, proto: x.proto, color: this.colorNext++, wacn: x.wacn, sysId: x.sysId, cc: x.cc, fid: x.fid, net: x.net, model: x.model, firstMs: x.firstMs, lastMs: x.lastMs, idens: new Map(), derived: x.derived, lcns: new Map(), lcnVotes: new Map(), rest: -1, busy: [], lpcnVotes: new Map(), lpcnHz: new Map(), heardHz: new Set() }; this.systems.set(x.key, s); }
      for (const hz of x.hz ?? []) s.heardHz.add(hz);
    }
    for (const x of k.units ?? []) {
      const key = `${x.sys}/${x.id}`;
      let u = this.units.get(key);
      if (!u) { u = { key, sys: x.sys, id: x.id, firstMs: x.firstMs, lastMs: x.lastMs, lonLo: -1, latLo: -1, posMs: x.posMs, posVerified: x.verified, trail: [[x.lat, x.lon, x.posMs]], groups: new Set(), grants: 0, carriers: new Set(), reports: [], fixes: [], tgCounts: new Map() }; this.units.set(key, u); }
      if (u.lonLo < 0 && x.posMs >= u.posMs) { u.fix = [x.lat, x.lon]; u.posMs = x.posMs; u.posVerified = x.verified; }
    }
    this.post(true);
  }
  /** The receiver's position arrived or moved: every stored report is resolved against it again. */
  setRef(lat: number, lon: number): void {
    this.ref = { lat, lon };
    for (const u of this.units.values()) {
      if (u.lonLo < 0) continue;
      this.anchorsAt = -1;
      for (const r of u.reports) if (r.lonLo !== undefined && r.latLo !== undefined) { const p = this.place(u.sys, r.latLo, r.lonLo); r.lat = p ? p[0] : null; r.lon = p ? p[1] : null; }
    }
    this.post(true);
  }
  /**
   * NXDN sites: a Type-C control channel per site (its SITE_INFO), with its adjacent sites and the channels learned;
   * a conventional or Type-D system's carriers make one site.
   */
  private nxdnSites(s: Sys): SiteRow[] {
    const plan = s.nxdnPlan, now = this.now();
    const lcns = plan ? [...plan.heard].sort((a, b) => a[0] - b[0]).map(([lcn, hz]) => ({ lcn, hz, slot: 0 })) : [];
    const cs = [...this.carriers.values()].filter(c => c.sys === s.key);
    if (s.trunk === 'TYPE-C') {
      return cs.filter(c => c.nxdn).map(c => {
        const x = c.nxdn!, adj = [...(c.nxdnAdj?.values() ?? [])];
        return { key: `${s.key}/${x.site}`, label: `site ${x.site}`, rfss: -1, site: x.site, nac: c.nxdnRan ?? -1, ccHz: [c.hz], lastMs: c.lastMs, levelDb: c.levelDb,
          neighbors: adj.map(a => { const r = plan?.resolve(a.ch); return { label: a.system === x.system && a.category === x.category ? `site ${a.site}` : `${NXDN_CATEGORY[a.category]} ${a.system} site ${a.site}`, hz: r && r.how !== 'guess' ? r.hz : 0, ch: `CH ${a.ch}`, sys: a.system, heard: cs.some(o => o.nxdn?.site === a.site && now - o.lastMs < 60_000) }; }),
          secondary: [], time: `${c.cls} · control channel ${x.cc1}${x.cc2 ? ` and ${x.cc2}` : ''} · ${x.adjacent} adjacent sites`, callsign: c.callsign, carriers: [c.key], lcns, rest: -1, busy: [], idens: [], units: 0, lra: -1, cls: x.version };
      });
    }
    if (!cs.length) return [];
    return [{ key: `${s.key}/1`, label: s.trunk === 'TYPE-D' ? `site ${s.sysId}` : `RAN ${s.sysId}`, rfss: -1, site: s.sysId, nac: s.trunk === 'CONVENTIONAL' ? s.sysId : -1, ccHz: cs.map(c => c.hz).sort((a, b) => a - b), lastMs: Math.max(...cs.map(c => c.lastMs)), levelDb: Math.max(...cs.map(c => c.levelDb)),
      neighbors: [], secondary: [], time: cs[0].cls, callsign: cs.find(c => c.callsign)?.callsign ?? '', carriers: cs.map(c => c.key), lcns, rest: -1, busy: [], idens: [], units: 0, lra: -1, cls: -1 }];
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
    this.placeCalls();
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
      } else if (s.proto === 'TETRA') {
        // one site per cell (color code): its control carriers, and the traffic carriers heard or allocated
        const cells = new Map<number, Carrier[]>();
        for (const c of this.carriers.values()) if (c.sys === s.key && (c.tetra || c.tetraCell)) { const k = c.tetra?.colorCode ?? c.cc; (cells.get(k) ?? cells.set(k, []).get(k)!).push(c); }
        sites = [...cells].map(([cc, cs]) => {
          const info = cs.find(c => c.tetraCell)?.tetraCell, sy = cs.find(c => c.tetra && c.role === 'control')?.tetra ?? cs.find(c => c.tetra)?.tetra;
          const ctrl = cs.filter(c => c.role !== 'voice'), traffic = new Map<number, string>();
          for (const c of cs) if (c.role === 'voice') traffic.set(c.hz, '');
          for (const [n, hz] of s.tetra?.carriers ?? []) if (![...traffic.keys()].some(h => Math.abs(h - hz) < 3_200) && !ctrl.some(c => Math.abs(c.hz - hz) < 3_200)) traffic.set(hz, `carrier ${n}`);
          const units = new Set<number>(); for (const u of this.units.values()) if (u.sys === s.key && cs.some(c => u.carriers.has(c.key))) units.add(u.id);
          return { key: `${s.key}/${cc}`, label: info ? `cell LA ${info.la}` : `color code ${cc}`, rfss: -1, site: cc, nac: -1, ccHz: ctrl.map(c => c.hz), lastMs: Math.max(...cs.map(c => c.lastMs)), levelDb: Math.max(...cs.map(c => c.levelDb)),
            neighbors: [], secondary: [...traffic].map(([hz, ch]) => ({ hz, ch })).sort((a, b) => a.hz - b.hz), time: sy ? `TS${sy.timeslot} · frame ${sy.frame} · multiframe ${sy.multiframe}` : '', callsign: '', carriers: cs.map(c => c.key),
            lcns: [], rest: -1, busy: [], idens: [], units: units.size, lra: info?.la ?? -1, cls: sy?.cellLoad ?? -1 };
        });
      } else if (s.proto === 'NXDN') sites = this.nxdnSites(s);
      else if (s.proto === 'SMARTNET') sites = this.oswSites(s);
      else sites = this.dmrSites(s);
      for (const st of sites) for (const k of st.carriers) for (const u of this.units.values()) if (u.sys === s.key && u.carriers.has(k)) unitSite.set(u.key, st.label);
      const label = s.proto === 'SMARTNET' ? `MOTOROLA TYPE II · SYSTEM ${h(s.sysId, 4)}` : s.proto === 'NXDN' ? (s.trunk === 'CONVENTIONAL' ? `NXDN · CONVENTIONAL · RAN ${s.sysId}` : s.trunk === 'TYPE-D' ? `NXDN · TYPE-D · SITE ${s.sysId}` : `NXDN · ${s.model} SYSTEM ${s.sysId}`) : s.proto === 'TETRA' ? `TETRA · MCC ${s.wacn} · MNC ${s.sysId}` : s.proto === 'P25' ? `WACN ${h(s.wacn, 5)} · SYSTEM ${h(s.sysId, 3)}` : s.net >= 0 ? `${s.model} NETWORK ${s.net}` : s.trunk === 'CAPACITY PLUS' ? `CAPACITY PLUS · COLOR CODE ${s.cc}` : `COLOR CODE ${s.cc}${s.fid > 0 ? ` · FID ${h(s.fid, 2)}` : ''}`;
      const units = [...this.units.values()].filter(u => u.sys === s.key).length, tgs = [...this.tgs.values()].filter(t => t.sys === s.key).length;
      const lpcns = s.nxdnPlan ? [...s.nxdnPlan.heard].map(([lpcn, hz]) => ({ lpcn, hz, votes: s.nxdnPlan!.votes.get(lpcn)?.get(hz) ?? 0 })).sort((a, b) => a.lpcn - b.lpcn)
        : [...s.lpcnHz].map(([lpcn, hz]) => ({ lpcn, hz, votes: s.lpcnVotes.get(lpcn)?.get(hz) ?? 0 })).sort((a, b) => a.lpcn - b.lpcn);
      return { key: s.key, proto: s.proto, color: s.color, label, trunk: s.trunk ?? '', wacn: s.wacn, sysId: s.sysId, cc: s.cc, fid: s.fid, net: s.net, model: s.model,
        callsign: sites.find(x => x.callsign)?.callsign ?? '', ...this.latestId(s.key), firstMs: s.firstMs, lastMs: s.lastMs, sites, idens: [...s.idens.values()].sort((a, b) => a.iden - b.iden),
        grants: this.grants.filter(g => g.sys === s.key).length, units, tgs, derived: s.derived || lpcns.length > 0, lpcns, heardHz: [...s.heardHz].slice(0, 12),
        positions: [...this.units.values()].some(u => u.sys === s.key && (u.lonLo >= 0 || !!u.fix)), security: s.proto === 'TETRA' ? this.tetraSecurity(s) : '' };
    }).sort((a, b) => a.firstMs - b.firstMs);
    const units: UnitRow[] = [...this.units.values()].map(u => {
      const [lat, lon] = this.resolvePos(u);
      const tr = this.trailOf(u);
      return { key: u.key, sys: u.sys, id: u.id, firstMs: u.firstMs, lastMs: u.lastMs, lat, lon, posMs: u.posMs, posVerified: u.posVerified, trail: tr.trail.slice(-12),
        groups: [...u.groups], grants: u.grants, carriers: [...u.carriers], reports: u.reports.slice(-6).map(r => ({ ...r, lonLo: undefined, latLo: undefined })), site: unitSite.get(u.key) ?? '',
        tgCounts: [...u.tgCounts].sort((a, b) => b[1] - a[1]), offArea: tr.off, fixes: u.fixes.length, alias: u.alias ?? this.unitAlias.get(u.key) ?? '' };
    });
    const tgs: TgRow[] = [...this.tgs.values()].map(t => ({ key: t.key, sys: t.sys, tg: t.tg, firstMs: t.firstMs, lastMs: t.lastMs, grants: t.grants, recent: t.recent.filter(x => now - x < 600_000), members: [...t.members].slice(0, 200), history: t.history.slice(0, 12) }));
    const carriers: CarrierRow[] = [...this.carriers.values()].map(c => {
      const { lastAuditionMs: _a, turns: _tu, turnDb: _td, osw: _o, p25: _p, dmrSys: _d, tables: _t, unitIds: _u, hdr: _h, nxdnAdj: _n, nxdnD: _x, nxdnRanN: _r, ...row } = c;
      return { ...row };
    }).sort((a, b) => a.hz - b.hz);
    return { type: 'fleet', centerHz: this.centerHz, rate: this.rate, spanLo: this.spanLo, spanHi: this.spanHi, carriers, systems, units, tgs, grants: this.grants.slice(0, 120),
      perMin: this.grants.filter(g => now - g.ms < 60_000).length, blocks: this.blocks, slots: this.chans.size, ref: this.ref !== null,
      calls: this.calls.rows(), follow: this.followTarget(), codecs: [...(['imbe', 'ambe2', 'tetra'] as CodecId[]).filter(hasCodec), 'fm'], playing: this.calls.playing, lock: this.calls.prefs.lock ?? null };
  }
  /** The call a one-channel receiver should go to, outside the span: only one there is something to hear on. */
  followTarget(): { key: string; hz: number } | null {
    const c = this.calls.followTarget(hz => this.inSpan(hz), x => (hasCodec(x.codec) || x.codec === 'fm') && !x.encrypted && !x.protectedHint && x.sec !== 'unknown');
    return c ? { key: c.key, hz: c.hz } : null;
  }
  private latestId(sys: string): { cwId: string; cwIdMs: number; cwIdHz: number } {
    let best: Carrier | null = null;
    for (const c of this.carriers.values()) if (c.sys === sys && c.callsignMs && (!best || c.callsignMs > best.callsignMs)) best = c;
    return best ? { cwId: best.callsign, cwIdMs: best.callsignMs, cwIdHz: best.hz } : { cwId: '', cwIdMs: 0, cwIdHz: 0 };
  }
  setPrefs(p: TgPrefs): void { this.calls.setPrefs(p); this.post(true); }
  callAudio(key: string): Float32Array | null { return this.calls.audioOf(key); }
  /** A carrier at [hz] as if found in the span (recorded blocks are replayed through it). */
  carrierAt(hz: number): Carrier {
    const key = gridKey(hz), now = this.now();
    let c = this.carriers.get(key);
    // a carrier off the 6.25 kHz grid sits near the boundary of two keys: the one already heard within 1.5 kHz is it
    if (!c) for (const x of this.carriers.values()) if (Math.abs(x.hz - hz) < 1_500) { c = x; break; }
    if (!c) {
      c = { key, hz, levelDb: 0, peakDb: 0, firstMs: now, lastMs: now, onMs: 0, heardMs: 0, cls: '', role: '', sys: '', nac: -1, cc: -1, frames: 0, blocks: 0, crcOk: 0, lastDecodeMs: 0,
        envCv: 0, eye: 0, decoding: false, callsign: '', callsignMs: 0, tdma: false, lcn: '', lastAuditionMs: 0, turns: 0, turnDb: 0, p25: { sys: -1, wacn: -1, rfss: -1, site: -1 }, dmrSys: '', tables: new Map(), unitIds: new Map() };
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
  /** One recorded DMR voice burst (144 dibits) heard on [hz]: [n] is its place in the superframe (0 has the sync). */
  feedDmrVoice(hz: number, slot: number, dibits: Uint8Array, n: number): void { const c = this.carrierAt(hz); this.dmrSeen.set(c.key, this.now()); this.dmrVoice(c, null, slot, dibits, n); }
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
    ch.tetraBaseband(zi, zq, n);
  }
  /** Starts the TETRA receiver on a carrier now (the recorded and synthesized channels in the tests). */
  tetraNow(hz: number): void { const c = this.carrierAt(hz), ch = this.chans.get(c.key); if (ch) this.tetraOn(c, ch); }
  /** Starts the NXDN receivers on a carrier now (the synthesized channels in the tests). */
  nxdnNow(hz: number): void { const c = this.carrierAt(hz), ch = this.chans.get(c.key); if (ch && !ch.nxdn) this.nxdnOn(c, ch); }
  /** The end of a recording: the samples still waiting for a whole timing block are decoded too. */
  flush(): void { for (const ch of this.chans.values()) { ch.rx.flush(); for (const r of ch.nxdn ?? []) r.flush(); } }
  /** A CW ID read on [hz]. */
  feedCw(hz: number, text: string): void { this.cwText(this.carrierAt(hz), text); }
  /** Everything held about one unit, for its detail view. */
  /** A unit's track: every position report placed (in order, repeats folded), and how many could not be placed. */
  private trailOf(u: Unit): { trail: [number, number, number][]; off: number } {
    if (!u.fixes.length) return { trail: u.trail, off: 0 };
    const trail: [number, number, number][] = []; let off = 0;
    for (const [ms, la, lo] of u.fixes) { const p = this.place(u.sys, la, lo); if (!p) { off++; continue; } const l = trail[trail.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) trail.push([p[0], p[1], ms]); }
    return { trail, off };
  }
  unitDetail(key: string): { key: string; reports: UnitReport[]; trail: [number, number, number][]; offArea: number } | null {
    const u = this.units.get(key); if (!u) return null;
    const tr = this.trailOf(u);
    return { key, reports: u.reports.map(r => ({ ms: r.ms, hz: r.hz, kind: r.kind, hex: r.hex, verified: r.verified, lat: r.lat, lon: r.lon, text: r.text, db: r.db })), trail: tr.trail, offArea: tr.off };
  }
  /** The block log as CSV, and the tables as JSON. */
  exportAll(): { csv: string; json: string } {
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = 'utc,mhz,protocol,type,crc_ok,fields,hex\n' + this.log.map(r => [new Date(r.ms).toISOString(), (r.hz / 1e6).toFixed(5), r.proto, q(r.name), r.ok ? 1 : 0, q(r.text), r.hex].join(',')).join('\n') + '\n';
    const s = this.snapshot();
    const json = JSON.stringify({ exported: new Date(this.now()).toISOString(), systems: s.systems, carriers: s.carriers, talkgroups: s.tgs, grants: this.grants,
      units: [...this.units.values()].map(u => ({ sys: u.sys, id: u.id, first: new Date(u.firstMs).toISOString(), last: new Date(u.lastMs).toISOString(), groups: [...u.groups], position: this.resolvePos(u), positionVerified: u.posVerified, trail: this.trailOf(u).trail, reports: u.reports })) }, null, 1);
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
    this.chans.clear(); this.blocks = 0; this.colorNext = 0; this.calls.clear(); this.pendingGrants = []; this.nxdnPending = []; this.oswParsers.clear();
    this.post(true);
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
export type { Field };
