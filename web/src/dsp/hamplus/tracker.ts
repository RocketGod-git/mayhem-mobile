/**
 * HAM+ tracker: what the transmissions heard across the band add up to. No DOM and no DSP; fed finished
 * transmissions and the channels open right now, it keeps:
 *  - stations: on a channel where the talkers' own carriers are heard (simplex, a repeater's input), transmissions are
 *    told apart by each radio's carrier frequency error and sub-audible tone, and lettered A, B, C as they appear;
 *  - repeater pairs: a channel at a band-plan offset from a repeater output, keyed at the same moment as it, again and
 *    again, is that repeater's input; the two become one tile and the input names the talker on the output;
 *  - linked channels: the same audio envelope on several channels at the same moment;
 *  - conversations: back-and-forth on a channel with no gap longer than [CONV_GAP_MS];
 *  - nets: one station coming back between check-ins from many others;
 *  - a 24-hour activity map per band, and per-channel activity for sparklines.
 */
import { planInfo, offsetText, hpBandOf, type PlanInfo } from './plan.js';

export const CONV_GAP_MS = 45_000;
/** A transmission shorter than this has too little carrier for its offset to count. */
export const OFFSET_MIN_MS = 600;
/** Two transmissions this close in Hz (plus their own spread) are one radio. */
export const STATION_TOL_HZ = 60;
export const STATION_TOL_MAX_HZ = 150;
/** Repeater input and output keying together: starts this close, input not outlasting the output by more than this. */
export const PAIR_START_MS = 1_500, PAIR_END_MS = 700;
export const PAIR_HITS = 2;
/** Linked channels: transmissions starting and ending this close, envelopes correlating at least this well. */
export const LINK_EDGE_MS = 1_500, LINK_CORR = 0.8, LINK_HITS = 2, LINK_MIN_MS = 2_000;
/** Envelope frame: 50 ms. A link may delay its audio up to [LINK_LAG] frames. */
export const ENV_MS = 50, LINK_LAG = 25;
export const HEAT_SLOTS = 96;
const MAX_TXS = 3_000, SPARK_MIN = 30;

/** A finished (or, live, a growing) transmission, as the receiver measured it. */
export interface TxRec {
  id: number; hz: number; startMs: number; endMs: number;
  /** Peak SNR in dB. */
  peakDb: number;
  /** Carrier frequency error from the channel in Hz (the discriminator's mean), NaN when not measured. */
  offsetHz: number;
  /** Spread of the 100 ms means the offset is the average of (Hz). */
  offsetSd: number;
  tone: number; dcs: number;
  /** Morse heard on the carrier (a CW ID), or ''. */
  cw: string;
  /** Audio envelope, one value a frame of [ENV_MS]. */
  env: Float32Array;
  /** Demodulated and kept in the time machine. */
  recorded: boolean;
}
/** A channel open right now, as the receiver reports it. */
export interface LiveRec { id: number; hz: number; startMs: number; snrDb: number; levelDb: number; offsetHz: number; tone: number; dcs: number; recorded: boolean }

export interface Station { key: string; letter: string; offsetHz: number; n: number; m2: number; tone: number; dcs: number; callsign: string; firstMs: number; lastMs: number; txs: number; talkMs: number }

interface Chan {
  hz: number; firstMs: number; lastMs: number; talkMs: number; txs: number; unrecorded: number;
  tone: number; dcs: number; callsign: string; callsignMs: number;
  stations: Station[];
  /** Airtime (ms) per minute, keyed by the minute. */
  minutes: Map<number, number>;
}

export interface HpPrefs { hold: string; mute: string[]; prio: string[] }
/**
 * The channel preferences kept between sessions: mutes and priorities. A follow is not kept. It pins the scan to one
 * window and pauses AUTO, and after a relaunch nothing has been heard on that channel yet, so a follow that came back
 * would hold the scan on a channel that may never key up. Reading an older save drops the follow it kept.
 */
export function hpPrefsSaved(p: HpPrefs): HpPrefs { return { hold: '', mute: [...p.mute], prio: [...p.prio] }; }
export function hpPrefsRestored(v: unknown): HpPrefs {
  const o = (v && typeof v === 'object' ? v : {}) as { mute?: unknown; prio?: unknown };
  const list = (x: unknown) => Array.isArray(x) ? x.filter((k): k is string => typeof k === 'string') : [];
  return { hold: '', mute: list(o.mute), prio: list(o.prio) };
}
export const chanKey = (hz: number) => String(Math.round(hz / 100) * 100);

export interface HpTxRow {
  id: number; hz: number; heardHz: number; startMs: number; endMs: number; live: boolean;
  tone: number; dcs: number; offsetHz: number; peakDb: number;
  station: string; stationLabel: string; color: number; callsign: string;
  /** The talker's own carrier was heard on the repeater's input: they are near. */
  direct: boolean;
  conv: number; recorded: boolean; cw: string;
  /** CB: the mode it was heard in (AM, FM, USB, LSB). HAM+ leaves it out. */
  mode?: string;
  /** The same transmission heard on a linked repeater: the id of the row its conversation shows instead, else 0. */
  echo?: number;
}
export interface HpTile {
  key: string; hz: number; label: string; use: string; kind: string; offset: string;
  inputHz: number; nearMs: number;
  tone: number; dcs: number; live: boolean; snrDb: number; levelDb: number; openMs: number; lastMs: number;
  talkMs: number; txs: number; spark: number[]; callsign: string;
  stations: { key: string; label: string; letter: string; color: number; callsign: string; txs: number; offsetHz: number }[];
  net: { control: string; checkins: number } | null; link: number; unrecorded: number;
  /** The linked repeater this one carries the same audio as (the followed one, else the one on the air, else the latest heard), or 0. */
  linkWith: number;
  followed: boolean; muted: boolean; prio: boolean;
}
export interface HpConv { id: number; key: string; hz: number; startMs: number; endMs: number; live: boolean; txs: number[]; stations: string[]; talkMs: number; net: boolean }
export interface HpHeat { bands: { id: string; slots: number[] }[]; cover: number[] }
export interface HpSaved { chans: { hz: number; callsign: string; tone: number; dcs: number; talkMs: number; txs: number; lastMs: number; firstMs: number }[]; pairs: [number, number][]; links: [number, number][]; heat: HpHeat }

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const looksLikeCall = (s: string) => /^[A-Z]{1,2}\d[A-Z]{1,4}$|^[A-Z]{1,4}\d{1,4}[A-Z]{0,4}$/.test(s) && s.length >= 4 && /\d/.test(s) && /[A-Z]/.test(s);
/** The callsign in a CW ID ('DE W1AW/R', 'W1AW RPT'), or ''. */
export function cwCallsign(text: string): string {
  for (const w of text.toUpperCase().split(/[\s]+/)) { const c = w.split('/')[0]; if (looksLikeCall(c)) return c; }
  return '';
}
const localSlot = (ms: number) => { const d = new Date(ms); return Math.floor((d.getHours() * 60 + d.getMinutes()) / (1440 / HEAT_SLOTS)); };

/** Normalized correlation of two envelopes at the best lag within ±[maxLag] frames (over their overlap). */
export function envCorr(a: Float32Array, b: Float32Array, startDiffFrames: number, maxLag = LINK_LAG): number {
  let best = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    // b[j] lines up with a[j + d]
    const d = startDiffFrames + lag;
    const j0 = Math.max(0, -d), j1 = Math.min(b.length, a.length - d);
    const n = j1 - j0; if (n < 20) continue;
    let sa = 0, sb = 0; for (let j = j0; j < j1; j++) { sa += a[j + d]; sb += b[j]; }
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let j = j0; j < j1; j++) { const x = a[j + d] - ma, y = b[j] - mb; num += x * y; da += x * x; db += y * y; }
    if (da <= 0 || db <= 0) continue;
    best = Math.max(best, num / Math.sqrt(da * db));
  }
  return best;
}

/**
 * What the tracker asks of a band plan: what a frequency is (its name, its use, its repeater offsets) and the row of
 * the activity map it counts in. HAM+ has the ARRL plans and a row per band; CB its channel names and a row a channel.
 */
export interface TrackerPlan { info(hz: number): PlanInfo; heatRow(hz: number): string }
export const HAM_TRACKER_PLAN: TrackerPlan = { info: planInfo, heatRow: hz => hpBandOf(hz)?.id ?? '' };

export class HamTracker {
  private readonly chans = new Map<string, Chan>();
  private readonly txs: TxRec[] = [];
  private readonly txStation = new Map<number, string>();
  private readonly txHeard = new Map<number, number>();
  private live: LiveRec[] = [];
  /** Repeater pairs, output key → input hz, and the evidence for each candidate 'out|in'. */
  private readonly pairs = new Map<string, number>();
  private readonly pairEv = new Map<string, { hits: number; misses: number }>();
  private readonly linkEv = new Map<string, number>();
  private readonly links = new Set<string>();
  private readonly judged = new Set<number>();
  heat: HpHeat = { bands: [], cover: new Array(HEAT_SLOTS).fill(0) };
  prefs: HpPrefs = { hold: '', mute: [], prio: [] };
  labels: Record<string, string> = {};
  spanLo = 0; spanHi = 0;
  private lastCover = 0;

  constructor(readonly now: () => number = () => Date.now(), readonly plan: TrackerPlan = HAM_TRACKER_PLAN) {}

  setSpan(lo: number, hi: number): void { this.spanLo = lo; this.spanHi = hi; }
  inSpan(hz: number): boolean { return hz > this.spanLo && hz < this.spanHi; }

  private chan(hz: number): Chan {
    const k = chanKey(hz);
    let c = this.chans.get(k);
    if (!c) { c = { hz, firstMs: 0, lastMs: 0, talkMs: 0, txs: 0, unrecorded: 0, tone: 0, dcs: 0, callsign: '', callsignMs: 0, stations: [], minutes: new Map() }; this.chans.set(k, c); }
    return c;
  }
  /** The output a channel is the heard input of, or 0. */
  outputOf(hz: number): number { for (const [k, i] of this.pairs) if (Math.abs(i - hz) < 1_250) return Number(k); return 0; }
  inputOf(hz: number): number { return this.pairs.get(chanKey(hz)) ?? 0; }
  /** A repeater output: the band plan says so, a CW ID was heard on it, or its input was found. */
  repeaterLike(hz: number): boolean {
    const c = this.chans.get(chanKey(hz)), p = this.plan.info(hz);
    if (this.outputOf(hz)) return false;
    return p.use === 'output' || !!this.inputOf(hz) || (!!c?.callsign && p.use !== 'simplex');
  }
  /** The tile a channel shows on: its output when it is a repeater's heard input. */
  tileHz(hz: number): number { return this.outputOf(hz) || hz; }

  /** Clusters one transmission into a station of its channel, returning the station key or ''. */
  private assign(c: Chan, t: { offsetHz: number; offsetSd: number; tone: number; dcs: number; startMs: number; endMs: number }, commit: boolean): Station | null {
    if (!Number.isFinite(t.offsetHz) || t.endMs - t.startMs < OFFSET_MIN_MS) return null;
    const tol = Math.min(STATION_TOL_MAX_HZ, STATION_TOL_HZ + 2 * t.offsetSd);
    let best: Station | null = null, bd = Infinity;
    for (const s of c.stations) {
      if (t.tone && s.tone && Math.abs(t.tone - s.tone) > 0.5) continue;
      if (t.dcs && s.dcs && t.dcs !== s.dcs) continue;
      if ((t.tone && s.dcs) || (t.dcs && s.tone)) continue;
      const d = Math.abs(t.offsetHz - s.offsetHz);
      if (d < tol && d < bd) { bd = d; best = s; }
    }
    if (!commit) return best;
    if (!best) {
      if (c.stations.length >= LETTERS.length) return null;
      const letter = LETTERS[c.stations.length];
      best = { key: `${chanKey(c.hz)}/${letter}`, letter, offsetHz: t.offsetHz, n: 0, m2: 0, tone: 0, dcs: 0, callsign: '', firstMs: t.startMs, lastMs: 0, txs: 0, talkMs: 0 };
      c.stations.push(best);
    }
    // running mean of the station's offset (each transmission one vote)
    best.n++; const d = t.offsetHz - best.offsetHz; best.offsetHz += d / best.n; best.m2 += d * (t.offsetHz - best.offsetHz);
    if (t.tone) best.tone = t.tone; if (t.dcs) best.dcs = t.dcs;
    best.lastMs = Math.max(best.lastMs, t.endMs); best.txs++; best.talkMs += t.endMs - t.startMs;
    return best;
  }

  /** A transmission ended. */
  addTx(t: TxRec): void {
    this.txs.push(t);
    if (this.txs.length > MAX_TXS) { const old = this.txs.splice(0, this.txs.length - MAX_TXS); for (const o of old) { this.txStation.delete(o.id); this.judged.delete(o.id); this.txHeard.delete(o.id); } }
    const c = this.chan(t.hz), dur = t.endMs - t.startMs;
    if (!c.firstMs) c.firstMs = t.startMs;
    c.lastMs = Math.max(c.lastMs, t.endMs); c.talkMs += dur; c.txs++; if (!t.recorded) c.unrecorded++;
    if (t.tone) { c.tone = t.tone; c.dcs = 0; } else if (t.dcs) { c.dcs = t.dcs; c.tone = 0; }
    // airtime a minute, for the sparkline
    for (let m = Math.floor(t.startMs / 60_000); m <= Math.floor(t.endMs / 60_000); m++) {
      const a = Math.max(t.startMs, m * 60_000), b = Math.min(t.endMs, (m + 1) * 60_000);
      if (b > a) c.minutes.set(m, (c.minutes.get(m) ?? 0) + b - a);
    }
    for (const m of c.minutes.keys()) if (m < Math.floor(t.endMs / 60_000) - SPARK_MIN) c.minutes.delete(m);
    const row = this.plan.heatRow(t.hz);
    if (row) {
      let b = this.heat.bands.find(x => x.id === row);
      if (!b) { b = { id: row, slots: new Array(HEAT_SLOTS).fill(0) }; this.heat.bands.push(b); }
      b.slots[localSlot(t.startMs)] += dur / 1000;
    }
    const call = cwCallsign(t.cw);
    // every transmission is clustered; on a repeater output the clusters are the repeater's own carrier and go unused
    const s = this.assign(c, t, true);
    if (s) this.txStation.set(t.id, s.key);
    if (call) { const u = this.plan.info(t.hz).use; if (s && (u === 'simplex' || u === 'input' || this.outputOf(t.hz))) s.callsign = call; else { c.callsign = call; c.callsignMs = t.endMs; } }
    this.judge(this.now());
  }

  /** The channels open now. */
  setLive(live: LiveRec[]): void {
    this.live = live;
    const now = this.now();
    // listening time per slot of the day, so a quiet hour and an hour not heard look different
    if (this.lastCover && now - this.lastCover < 5_000) this.heat.cover[localSlot(now)] += (now - this.lastCover) / 1000;
    this.lastCover = now;
  }

  /** Pairs and links, worked out on transmissions that ended a few seconds ago (their partners have ended too). */
  judge(now: number): void {
    for (const t of this.txs) {
      if (this.judged.has(t.id) || now - t.endMs < 4_000) continue;
      this.judged.add(t.id);
      // as a repeater input: an output at a plan offset keyed with it
      for (const c of this.chans.values()) {
        const off = t.hz - c.hz, p = this.plan.info(c.hz);
        if (!p.offsets.some(o => Math.abs(o - off) < 1_250)) continue;
        const k = `${chanKey(c.hz)}|${chanKey(t.hz)}`;
        const ev = this.pairEv.get(k) ?? { hits: 0, misses: 0 };
        const hit = this.txs.some(o => o.hz === c.hz && Math.abs(o.startMs - t.startMs) <= PAIR_START_MS && o.endMs >= t.endMs - PAIR_END_MS);
        if (hit) ev.hits++; else if (this.inSpan(c.hz)) ev.misses++; else continue;
        this.pairEv.set(k, ev);
        if (ev.hits >= PAIR_HITS && ev.hits >= 2 * ev.misses) { this.pairs.set(chanKey(c.hz), t.hz); }
        else if (this.pairs.get(chanKey(c.hz)) === t.hz && ev.misses > ev.hits) this.pairs.delete(chanKey(c.hz));
      }
      // linked: the same audio on another channel at the same moment
      if (t.endMs - t.startMs < LINK_MIN_MS || t.env.length < 20) continue;
      for (const o of this.txs) {
        if (o.id >= t.id || o.hz === t.hz || Math.abs(o.hz - t.hz) < 50_000 || o.env.length < 20) continue;
        if (Math.abs(o.startMs - t.startMs) > LINK_EDGE_MS || Math.abs(o.endMs - t.endMs) > LINK_EDGE_MS) continue;
        if (this.pairedTogether(o.hz, t.hz)) continue;
        const r = envCorr(o.env, t.env, Math.round((t.startMs - o.startMs) / ENV_MS));
        if (r < LINK_CORR) continue;
        const k = [chanKey(this.tileHz(o.hz)), chanKey(this.tileHz(t.hz))].sort().join('|');
        if (k.split('|')[0] === k.split('|')[1]) continue;
        const n = (this.linkEv.get(k) ?? 0) + 1; this.linkEv.set(k, n);
        if (n >= LINK_HITS) this.links.add(k);
      }
    }
  }
  private pairedTogether(a: number, b: number): boolean {
    return Math.abs(this.inputOf(a) - b) < 1_250 || Math.abs(this.inputOf(b) - a) < 1_250 || this.plan.info(a).offsets.some(o => Math.abs(b - a - o) < 1_250) && this.pairEv.has(`${chanKey(a)}|${chanKey(b)}`) || this.plan.info(b).offsets.some(o => Math.abs(a - b - o) < 1_250) && this.pairEv.has(`${chanKey(b)}|${chanKey(a)}`);
  }

  /** Tile pairs ('a|b', sorted) the receiver hears carrying the same audio right now; set by the engine. */
  liveLinks = new Set<string>();
  /** Link groups: each tile key in a linked network (learned, or heard linked right now) mapped to a group number from 1. */
  linkGroups(): Map<string, number> {
    const parent = new Map<string, string>();
    const find = (x: string): string => { let p = parent.get(x) ?? x; if (p !== x) { p = find(p); parent.set(x, p); } return p; };
    const all = [...new Set([...this.heardLinks(), ...this.liveLinks])].sort();
    for (const k of all) { const [a, b] = k.split('|'); parent.set(find(a), find(b)); }
    const roots = new Map<string, number>(), out = new Map<string, number>();
    for (const k of all) for (const x of k.split('|')) { const r = find(x); if (!roots.has(r)) roots.set(r, roots.size + 1); out.set(x, roots.get(r)!); }
    return out;
  }
  /** A channel with transmissions heard on it (this session or a restored one). */
  private heard(key: string): boolean { return (this.chans.get(key)?.txs ?? 0) > 0; }
  /**
   * The learned links whose two channels both have transmissions. A link is the same voice on two channels, so one
   * with a channel never heard is no link: an older save could keep one made on a carrier with no voice.
   */
  private heardLinks(): string[] { return [...this.links].filter(k => { const [a, b] = k.split('|'); return this.heard(a) && this.heard(b); }); }
  /** Two tiles are a learned link (the same network). */
  linked(a: string, b: string): boolean {
    if (a === b || !this.links.size) return false;
    const parent = new Map<string, string>();
    const find = (x: string): string => { let p = parent.get(x) ?? x; if (p !== x) { p = find(p); parent.set(x, p); } return p; };
    for (const k of this.heardLinks()) { const [x, y] = k.split('|'); parent.set(find(x), find(y)); }
    return find(a) === find(b);
  }

  /** The station a transmission came from (on an output with its input heard, the input's), and whether direct. */
  private stationOf(t: { id: number; hz: number; startMs: number; endMs: number }): { st: Station | null; direct: boolean } {
    const k = this.txStation.get(t.id);
    const find = (key: string | undefined) => { if (!key) return null; const c = this.chans.get(key.slice(0, key.indexOf('/'))); return c?.stations.find(s => s.key === key) ?? null; };
    if (!this.repeaterLike(t.hz)) return { st: find(k), direct: false };
    const inHz = this.inputOf(t.hz);
    if (!inHz) return { st: null, direct: false };
    // the input transmission keyed with this one
    const i = this.txs.find(o => Math.abs(o.hz - inHz) < 1_250 && Math.abs(o.startMs - t.startMs) <= PAIR_START_MS && (t.endMs === 0 || o.endMs <= t.endMs + PAIR_END_MS));
    if (i) return { st: find(this.txStation.get(i.id)), direct: true };
    const l = this.live.find(o => Math.abs(o.hz - inHz) < 1_250 && Math.abs(o.startMs - t.startMs) <= PAIR_START_MS);
    if (l) { const c = this.chans.get(chanKey(inHz)); const s = c ? this.assign(c, { ...l, offsetSd: 30, endMs: this.now() }, false) : null; return { st: s, direct: true }; }
    return { st: null, direct: false };
  }

  private stationLabel(s: Station | null): string { return !s ? '' : this.labels[s.key] || s.callsign || s.letter; }

  /** Rows for the log and the conversations: finished transmissions and the ones on the air, newest first. */
  rows(now: number, max = 400): HpTxRow[] {
    const out: HpTxRow[] = [];
    const add = (t: { id: number; hz: number; startMs: number; endMs: number; tone: number; dcs: number; offsetHz: number; peakDb: number; recorded: boolean; cw: string }, live: boolean) => {
      let st: Station | null = null, direct = false;
      if (live && !this.repeaterLike(t.hz)) { const c = this.chans.get(chanKey(t.hz)); st = c ? this.assign(c, { ...t, offsetSd: 30, endMs: now }, false) : null; }
      else ({ st, direct } = this.stationOf(t));
      const tile = this.tileHz(t.hz);
      out.push({ id: t.id, hz: tile, heardHz: t.hz, startMs: t.startMs, endMs: live ? 0 : t.endMs, live, tone: t.tone, dcs: t.dcs, offsetHz: t.offsetHz, peakDb: t.peakDb,
        station: st?.key ?? '', stationLabel: this.stationLabel(st), color: st ? LETTERS.indexOf(st.letter) : -1, callsign: st?.callsign ?? '', direct, conv: 0, recorded: t.recorded, cw: t.cw });
    };
    for (const l of this.live) add({ ...l, endMs: 0, peakDb: l.snrDb, cw: '' }, true);
    for (let i = this.txs.length - 1; i >= 0 && out.length < max; i--) add(this.txs[i], false);
    // an input transmission shows as the talker on its output: the output's row carries it, the input's row goes
    const shown = out.filter(r => r.hz === r.heardHz || !out.some(o => o.heardHz === r.hz && Math.abs(o.startMs - r.startMs) <= PAIR_START_MS));
    // conversations: per tile (linked repeaters share one), transmissions with no gap longer than CONV_GAP_MS
    const groups = this.linkGroups();
    const byTile = new Map<string, HpTxRow[]>();
    for (const r of shown) { const g = groups.get(chanKey(r.hz)), k = g ? `g${g}` : chanKey(r.hz); byTile.set(k, [...(byTile.get(k) ?? []), r]); }
    for (const list of byTile.values()) {
      list.sort((a, b) => a.startMs - b.startMs);
      let conv = 0, end = -Infinity;
      for (const r of list) { if (r.startMs - end > CONV_GAP_MS) conv = r.id; r.conv = conv; end = Math.max(end, r.live ? now : r.endMs); }
      // one transmission heard on two linked repeaters is one bubble: the stronger copy
      for (const r of list) for (const o of list) {
        if (o === r || o.hz === r.hz || r.echo || o.echo || Math.abs(o.startMs - r.startMs) > LINK_EDGE_MS) continue;
        const keep = o.peakDb > r.peakDb || (o.peakDb === r.peakDb && o.id < r.id) ? o : r;
        (keep === o ? r : o).echo = keep.id;
      }
    }
    return shown.sort((a, b) => b.startMs - a.startMs);
  }

  convs(rows: HpTxRow[], now: number): HpConv[] {
    const by = new Map<number, HpConv>();
    for (const r of [...rows].reverse()) {
      if (r.echo) continue;
      let c = by.get(r.conv);
      if (!c) { c = { id: r.conv, key: chanKey(r.hz), hz: r.hz, startMs: r.startMs, endMs: 0, live: false, txs: [], stations: [], talkMs: 0, net: false }; by.set(r.conv, c); }
      c.txs.push(r.id); c.live ||= r.live; c.endMs = Math.max(c.endMs, r.live ? now : r.endMs); c.talkMs += (r.live ? now : r.endMs) - r.startMs;
      if (r.station && !c.stations.includes(r.station)) c.stations.push(r.station);
    }
    const out = [...by.values()].sort((a, b) => b.endMs - a.endMs);
    for (const c of out) c.net = !!netOf(rows.filter(r => r.conv === c.id && !r.echo).sort((a, b) => a.startMs - b.startMs).map(r => r.station));
    return out;
  }

  tiles(now: number, rows: HpTxRow[], max = 80): HpTile[] {
    const groups = this.linkGroups(), out: HpTile[] = [], seen = new Set<string>();
    const nowMin = Math.floor(now / 60_000);
    const keys = new Set<string>([...this.chans.keys(), ...this.live.map(l => chanKey(l.hz))]);
    if (this.prefs.hold) keys.add(this.prefs.hold);
    for (const k0 of keys) {
      const hz0 = Number(k0), tileHz = this.tileHz(hz0), k = chanKey(tileHz);
      if (seen.has(k)) continue; seen.add(k);
      const c = this.chans.get(k) ?? this.chan(tileHz), inHz = this.inputOf(tileHz), ci = inHz ? this.chans.get(chanKey(inHz)) : undefined;
      const lv = this.live.filter(l => Math.abs(l.hz - tileHz) < 1_250 || (inHz && Math.abs(l.hz - inHz) < 1_250));
      const lo = lv.find(l => Math.abs(l.hz - tileHz) < 1_250) ?? lv[0];
      const p = this.plan.info(tileHz), rep = this.repeaterLike(tileHz);
      const spark: number[] = []; for (let m = nowMin - SPARK_MIN + 1; m <= nowMin; m++) spark.push(Math.round((c.minutes.get(m) ?? 0) / 1000));
      if (lo) { const a = Math.max(lo.startMs, nowMin * 60_000); spark[spark.length - 1] += Math.round((now - a) / 1000); }
      const sts = rep ? ci?.stations ?? [] : c.stations;
      const tr = rows.filter(r => r.hz === tileHz);
      const lastConv = tr.length ? tr[0].conv : 0;
      const net = netOf(tr.filter(r => r.conv === lastConv).sort((a, b) => a.startMs - b.startMs).map(r => r.station));
      const st = net ? sts.find(s => s.key === net.control) ?? null : null;
      out.push({
        key: k, hz: tileHz, label: p.label, use: p.use, kind: rep ? 'REPEATER' : p.use === 'simplex' ? 'SIMPLEX' : p.use === 'input' ? 'INPUT' : p.use === 'satellite' ? 'SATELLITE' : '', offset: rep || p.use === 'output' ? offsetText(inHz ? [inHz - tileHz] : p.offsets) : '',
        inputHz: inHz, nearMs: ci?.lastMs ?? 0, tone: lo?.tone || c.tone || ci?.tone || 0, dcs: lo?.dcs || c.dcs || 0,
        live: !!lo, snrDb: lo?.snrDb ?? 0, levelDb: lo?.levelDb ?? -90, openMs: lo ? now - lo.startMs : 0, lastMs: lo ? now : Math.max(c.lastMs, ci?.lastMs ?? 0),
        talkMs: c.talkMs + (lo ? now - lo.startMs : 0), txs: c.txs + (lo ? 1 : 0), spark, callsign: c.callsign,
        stations: sts.map(s => ({ key: s.key, label: this.stationLabel(s), letter: s.letter, color: LETTERS.indexOf(s.letter), callsign: s.callsign, txs: s.txs, offsetHz: Math.round(s.offsetHz) })),
        net: net ? { control: this.stationLabel(st) || net.control, checkins: net.checkins } : null, link: groups.get(k) ?? 0, linkWith: 0,
        unrecorded: c.unrecorded + (ci?.unrecorded ?? 0) + lv.filter(l => !l.recorded).length,
        followed: this.prefs.hold === k, muted: this.prefs.mute.includes(k), prio: this.prefs.prio.includes(k),
      });
    }
    // a linked repeater names the one it carries the same audio as: the followed one, else the one on the air, else the latest heard
    for (const t of out) {
      if (!t.link) continue;
      const others = out.filter(o => o !== t && o.link === t.link);
      const w = others.find(o => o.followed) ?? others.filter(o => o.live).sort((a, b) => b.snrDb - a.snrDb)[0] ?? others.sort((a, b) => b.lastMs - a.lastMs)[0];
      t.linkWith = w?.hz ?? 0;
    }
    const rank = (t: HpTile) => t.followed ? 0 : t.live ? 1 : 2;
    return out.filter(t => t.followed || t.live || t.txs > 0).sort((a, b) => rank(a) - rank(b) || b.lastMs - a.lastMs || a.hz - b.hz).slice(0, max);
  }

  /** What to keep between sessions. */
  save(): HpSaved {
    const chans = [...this.chans.values()].filter(c => c.txs > 0).sort((a, b) => b.lastMs - a.lastMs).slice(0, 200)
      .map(c => ({ hz: c.hz, callsign: c.callsign, tone: c.tone, dcs: c.dcs, talkMs: c.talkMs, txs: c.txs, lastMs: c.lastMs, firstMs: c.firstMs }));
    return { chans, pairs: [...this.pairs].map(([k, v]) => [Number(k), v]), links: this.heardLinks().map(k => k.split('|').map(Number) as [number, number]), heat: this.heat };
  }
  restore(s: HpSaved | null): void {
    if (!s) return;
    for (const x of s.chans ?? []) { const c = this.chan(x.hz); c.callsign ||= x.callsign; c.tone ||= x.tone; c.dcs ||= x.dcs; c.talkMs += x.talkMs; c.txs += x.txs; c.lastMs = Math.max(c.lastMs, x.lastMs); c.firstMs ||= x.firstMs; }
    for (const [o, i] of s.pairs ?? []) { this.pairs.set(chanKey(o), i); this.pairEv.set(`${chanKey(o)}|${chanKey(i)}`, { hits: PAIR_HITS, misses: 0 }); }
    // a link comes back only between channels that come back with transmissions (see [heardLinks])
    for (const [a, b] of s.links ?? []) { const k = [chanKey(a), chanKey(b)].sort().join('|'); if (!this.heard(chanKey(a)) || !this.heard(chanKey(b))) continue; this.links.add(k); this.linkEv.set(k, LINK_HITS); }
    if (s.heat?.cover?.length === HEAT_SLOTS) this.heat = { bands: (s.heat.bands ?? []).filter(b => b.slots?.length === HEAT_SLOTS), cover: s.heat.cover };
  }
  clear(): void { this.chans.clear(); this.txs.length = 0; this.txStation.clear(); this.pairs.clear(); this.pairEv.clear(); this.links.clear(); this.linkEv.clear(); this.judged.clear(); }
  tx(id: number): TxRec | undefined { return this.txs.find(t => t.id === id); }
  get stationCount(): number { let n = 0; for (const c of this.chans.values()) n += c.stations.length; return n; }
}

/**
 * A net in a run of transmissions (station keys in time order, '' unknown): one station keeps coming back between
 * check-ins from at least four others, and takes at least half of all the turns after another station's.
 */
export function netOf(seq: string[]): { control: string; checkins: number } | null {
  const known = seq.filter(Boolean);
  if (known.length < 8) return null;
  const count = new Map<string, number>(); for (const s of known) count.set(s, (count.get(s) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const others = new Set(known.filter(s => s !== top));
  if (others.size < 4 || (count.get(top) ?? 0) < 4) return null;
  let after = 0, otherTurns = 0;
  for (let i = 0; i + 1 < known.length; i++) if (known[i] !== top) { otherTurns++; if (known[i + 1] === top) after++; }
  return otherTurns > 0 && after / otherTurns >= 0.5 ? { control: top, checkins: others.size } : null;
}
