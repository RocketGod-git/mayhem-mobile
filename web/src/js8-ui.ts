/**
 * The JS8 app: conversations, groups, stations heard, their map, the band activity waterfall, the inbox, and
 * sending through the licensed transmit path. Decodes come from the worker's JS8 receiver.
 */
import { fmtDist } from './units.js';
import { GeoMap, type GeoItem, mapStart, lastKnownPos, zoneGuess } from './geomap.js';
import { distanceBearing, gridToLatLon } from './callsign.js';
import { HB_HI_HZ, HB_LO_HZ, JS8_DIALS, JS8_MODES, TX_MAX_HZ, TX_MIN_HZ, frameSeconds, js8Mode, symSamples, type Js8Speed } from './dsp/js8/modes.js';
import { Assembler, isStandardCall, parseMessage, unpackFrame, type Js8Meaning, type Js8Message } from './dsp/js8/message.js';
import { buildMessageFrames, isValidCallsign, jscReady, loadJsc } from './dsp/js8/varicode.js';
import type { Frame } from './dsp/js8/codec.js';
import { frameTones } from './dsp/js8/codec.js';
import { toneTrack } from './dsp/js8/synth.js';
import type { Js8Decode } from './dsp/js8/decoder.js';
import { hamSpots } from './ham-spots.js';

export interface Js8Tx {
  readonly enabled: boolean; readonly needsPrompt: boolean; readonly active: boolean;
  js8(label: string, rfHz: number, track: Float32Array, trackRate: number, symSamples: number): boolean;
}
export interface Js8Host {
  readoutHtml(): string;
  refreshReadout(): void;
  segHtml(buttons: string[], cls?: string): string;
  hsHtml(inner: string, cls?: string): string;
  esc(s: string): string;
  log(s: string): void;
  station(): { call: string; grid: string };
  home(): { lat: number; lon: number } | null;
  isOpen(): boolean;
  tune(hz: number): void;
  setSpeeds(s: Record<Js8Speed, boolean>): void;
  tx: Js8Tx;
  showTxSafetyPrompt(): void;
  txReady(): string;
  setGeo(g: GeoMap | null): void;
}

/** Groups every station has: @ALLCALL and @HB, and @TPP, followed from the start. */
export const BUILTIN_GROUPS = ['@ALLCALL', '@HB', '@TPP'];
const DEFAULT_FOLLOW = ['@TPP'];
const KEY = 'mayhem.js8';
type View = 'chat' | 'groups' | 'heard' | 'map' | 'band' | 'inbox' | 'log';
const VIEWS: View[] = ['chat', 'groups', 'heard', 'map', 'band', 'inbox', 'log'];
const VIEW_LABEL: Record<View, string> = { chat: 'CHAT', groups: 'GROUPS', heard: 'HEARD', map: 'MAP', band: 'WATERFALL', inbox: 'INBOX', log: 'ACTIVITY' };

export interface Js8Station {
  call: string; firstMs: number; lastMs: number; snr: number; hz: number; mode: Js8Speed; grid: string;
  dt: number; dtAvg: number; drift: number; heard: number;
}
export interface Js8Entry {
  id: string; ms: number; mode: Js8Speed; hz: number; snr: number; dt: number; text: string; complete: boolean;
  frames: number; mine?: boolean; state?: 'queued' | 'sending' | 'sent' | 'failed'; meaning: Js8Meaning;
}
interface Activity { ms: number; mode: Js8Speed; snr: number; dt: number; hz: number; drift: number; text: string; kind: string; }
interface Saved {
  dial: number; speeds: Record<Js8Speed, boolean>; txSpeed: Js8Speed; txHz: number;
  groups: string[]; follow: string[]; stations: Js8Station[]; entries: Js8Entry[]; activity: Activity[]; read: Record<string, number>;
}

const st = {
  dial: 7_078_000, speeds: { slow: true, normal: true, fast: true, turbo: true } as Record<Js8Speed, boolean>,
  txSpeed: 'normal' as Js8Speed, txHz: 1500,
  groups: [...BUILTIN_GROUPS], follow: [...DEFAULT_FOLLOW],
  stations: new Map<string, Js8Station>(), entries: [] as Js8Entry[], activity: [] as Activity[], read: {} as Record<string, number>,
  view: 'chat' as View, room: '', sel: '' as string, target: '', draft: '',
  wf: [] as { ms: number; row: Uint8Array }[], marks: [] as { ms: number; hz: number; label: string; mode: Js8Speed }[],
  queue: [] as { at: number; label: string; tones: Uint8Array; speed: Js8Speed; entry: string; last: boolean; hz?: number }[],
  hold: false, wired: false, timer: 0, spy: null as (() => void) | null, geo: null as GeoMap | null, saveAt: 0, status: '',
};
const asm = new Assembler();
asm.onMessage = m => onMessage(m);

function load(): void {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    if (!s) return;
    if (s.dial) st.dial = s.dial;
    if (s.speeds) st.speeds = { ...st.speeds, ...s.speeds };
    if (s.txSpeed) st.txSpeed = s.txSpeed;
    if (s.txHz) st.txHz = s.txHz;
    if (Array.isArray(s.groups)) st.groups = [...new Set([...BUILTIN_GROUPS, ...s.groups.map(normGroup).filter(Boolean)])];
    if (Array.isArray(s.follow)) st.follow = [...new Set(s.follow.map(normGroup).filter(Boolean))];
    if (Array.isArray(s.stations)) for (const x of s.stations) st.stations.set(x.call, x);
    if (Array.isArray(s.entries)) st.entries = s.entries.slice(-600);
    if (Array.isArray(s.activity)) st.activity = s.activity.slice(0, 400);
    if (s.read) st.read = s.read;
  } catch { /* private window or old data */ }
}
function save(now = Date.now()): void {
  if (now - st.saveAt < 1500) return;
  st.saveAt = now;
  const s: Saved = { dial: st.dial, speeds: st.speeds, txSpeed: st.txSpeed, txHz: st.txHz, groups: st.groups, follow: st.follow, stations: [...st.stations.values()].sort((a, b) => b.lastMs - a.lastMs).slice(0, 500), entries: st.entries.slice(-600), activity: st.activity.slice(0, 400), read: st.read };
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* full or private */ }
}
load();

export const js8Dial = (): number => st.dial;
export const js8Speeds = (): Record<Js8Speed, boolean> => ({ ...st.speeds });
export function js8SetDial(hz: number): void { st.dial = hz; save(0); }
/** Group names are not case-sensitive on the air: one spelling, upper case with its @. */
export function normGroup(g: string): string { const t = g.trim().toUpperCase().replace(/^@?/, '@'); return /^@[A-Z0-9/]{1,9}$/.test(t) ? t : ''; }
const isGroup = (k: string) => k.startsWith('@');
const followed = (g: string) => st.follow.includes(g);

// ---- receiving ----------------------------------------------------------------------------------------------------
let host: Js8Host | null = null;
export function js8OnDecodes(list: Js8Decode[], speed: Js8Speed, slotMs: number): void {
  const m = js8Mode(speed);
  for (const d of list) {
    st.activity.unshift({ ms: slotMs, mode: speed, snr: d.snr, dt: d.dt, hz: d.hz, drift: d.drift, text: d.frame.text ?? frameLabel(d.frame.kind), kind: d.frame.kind });
    asm.push({ frame: d.frame, mode: speed, hz: d.hz, slotMs, snr: d.snr, dt: d.dt }, m.period, m.spacing);
    const call = d.frame.from && isStandardCall(d.frame.from) ? d.frame.from : '';
    if (call) heardStation(call, slotMs, d);
    st.marks.push({ ms: slotMs + (m.delay + d.dt) * 1000, hz: d.hz, label: call || frameLabel(d.frame.kind), mode: speed });
  }
  if (st.activity.length > 400) st.activity.length = 400;
  if (st.marks.length > 200) st.marks.splice(0, st.marks.length - 200);
  asm.tick(slotMs);
  save();
  refresh(true);
}
function frameLabel(kind: string): string {
  return kind === 'heartbeat' ? 'HEARTBEAT FRAME' : kind === 'compound' ? 'COMPOUND CALL FRAME' : kind === 'compoundDirected' ? 'COMPOUND DIRECTED FRAME' : kind === 'compressed' ? 'COMPRESSED TEXT FRAME' : kind.toUpperCase();
}
function heardStation(call: string, ms: number, d: { snr: number; hz: number; dt: number; drift: number; mode: Js8Speed }): void {
  const s = st.stations.get(call) ?? { call, firstMs: ms, lastMs: ms, snr: d.snr, hz: d.hz, mode: d.mode, grid: '', dt: d.dt, dtAvg: d.dt, drift: d.drift, heard: 0 };
  s.lastMs = Math.max(s.lastMs, ms); s.snr = d.snr; s.hz = d.hz; s.mode = d.mode; s.dt = d.dt; s.drift = d.drift; s.heard++;
  s.dtAvg = s.heard === 1 ? d.dt : s.dtAvg + 0.2 * (d.dt - s.dtAvg);
  st.stations.set(call, s);
}
function onMessage(m: Js8Message): void {
  const mode = m.mode as Js8Speed;
  const e: Js8Entry = { id: m.id, ms: m.startMs, mode, hz: m.hz, snr: m.snr, dt: m.dt, text: m.text, complete: m.complete, frames: m.frames, meaning: m.meaning };
  const i = st.entries.findIndex(x => x.id === m.id);
  if (i >= 0) st.entries[i] = e; else st.entries.push(e);
  if (st.entries.length > 600) st.entries.splice(0, st.entries.length - 600);
  const mm = m.meaning;
  if (mm.from && isStandardCall(mm.from)) {
    const s = st.stations.get(mm.from);
    if (s && mm.grid) s.grid = mm.grid.toUpperCase();
  }
  // Ham Map plots the sender at its grid, whether or not Ham Map is open (once per message, when it completes)
  if (m.complete) hamSpots.js8(mm, { snr: m.snr, hz: m.hz, ms: m.endMs || m.startMs, text: m.text }, st.dial);
}
/** Feed for the demo and tests: complete messages as if assembled from the air. */
export function js8Inject(m: Js8Message, station?: Partial<Js8Station>): void {
  onMessage(m);
  if (station?.call) st.stations.set(station.call, { firstMs: m.startMs, lastMs: m.endMs, snr: m.snr, hz: m.hz, mode: m.mode as Js8Speed, grid: '', dt: m.dt, dtAvg: m.dt, drift: 0, heard: 1, ...st.stations.get(station.call), ...station } as Js8Station);
  refresh(true);
}
export function js8OnWaterfall(row: Uint8Array, ms: number): void {
  st.wf.push({ ms, row });
  if (st.wf.length > 480) st.wf.splice(0, st.wf.length - 480);
  if (host?.isOpen()) drawWaterfall();
}

// ---- conversations -------------------------------------------------------------------------------------------------
const me = () => host?.station().call.toUpperCase() ?? '';
/** Which room an entry belongs to: the group, @ALLCALL, the other station, or BAND for text with no address. */
function roomOf(e: Js8Entry): string {
  const m = e.meaning, my = me();
  if (m.to && isGroup(m.to)) return normGroup(m.to) || m.to;
  if (m.kind === 'cq') return '@CQ';
  if (m.from && m.to) return m.from === my ? m.to : m.to === my ? m.from : [m.from, m.to].sort().join('|');
  if (m.from) return m.from === my ? 'BAND' : m.from;
  return 'BAND';
}
function rooms(): { key: string; last: number; n: number; unread: number }[] {
  const map = new Map<string, { key: string; last: number; n: number; unread: number }>();
  for (const g of st.follow) map.set(g, { key: g, last: 0, n: 0, unread: 0 });
  for (const e of st.entries) {
    const k = roomOf(e);
    const r = map.get(k) ?? { key: k, last: 0, n: 0, unread: 0 };
    r.last = Math.max(r.last, e.ms); r.n++; if (!e.mine && e.ms > (st.read[k] ?? 0)) r.unread++;
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => (followed(b.key) ? 1 : 0) - (followed(a.key) ? 1 : 0) || b.last - a.last);
}
function roomTitle(k: string): string { return k.includes('|') ? k.replace('|', ' · ') : k === 'BAND' ? 'BAND TEXT' : k; }
const forMe = (e: Js8Entry) => { const my = me(); return !!my && (e.meaning.to === my || e.meaning.dest === my); };

// ---- sending -------------------------------------------------------------------------------------------------------
function nextSlot(speed: Js8Speed, now = Date.now()): number { const P = js8Mode(speed).period * 1000; return Math.ceil((now + 300) / P) * P; }
/** What SEND would do with the target and text now, or why it cannot. */
function plan(target: string, text: string): { frames: Frame[] | null; why: string; line: string } {
  const call = me();
  if (!call) return { frames: null, why: 'set your callsign in Settings, STATION', line: '' };
  if (!isValidCallsign(call).valid) return { frames: null, why: `${call} is not a callsign JS8 can send`, line: '' };
  if (!jscReady()) { void loadJsc('assets/js8-jsc.json').then(() => refresh(true)).catch(() => undefined); return { frames: null, why: 'loading the JS8 dictionary', line: '' }; }
  const body = text.toUpperCase().replace(/\s+/g, ' ').trim();
  let line: string;
  if (target === 'HB') line = `@HB HEARTBEAT ${grid4()}`.trim();
  else if (target === 'CQ') line = `CQ CQ CQ ${grid4()}`.trim();
  else if (target === 'HB SNR') return { frames: null, why: '', line: '' };
  else if (!target || target === 'BAND') {
    if (!body) return { frames: null, why: '', line: '' };
    line = /\bDE [A-Z0-9/]+$/.test(body) || body.includes(call) ? body : `${body} DE ${call}`;
  } else {
    if (!isValidCallsign(target).valid) return { frames: null, why: `${target} is not a callsign or group`, line: '' };
    line = `${target} ${body}`.trim();
  }
  const frames = buildMessageFrames(call, grid4(), '', line, st.txSpeed);
  return frames.length ? { frames, why: '', line } : { frames: null, why: 'nothing JS8 can send in that', line };
}
const grid4 = (): string => (host?.station().grid ?? '').slice(0, 4).toUpperCase();
/** How a frame list reads on the air, exactly as a receiver shows it. */
const asShown = (frames: Frame[]): string => frames.map(f => unpackFrame(f).text ?? '').join('').replace(/\s+/g, ' ').trim();
function send(kind: 'text' | 'hbsnr' | 'hb' | 'cq', target: string, text: string, snr = 0): void {
  if (!host) return;
  const why = host.txReady();
  if (why) { status(why); return; }
  if (host.tx.needsPrompt) { host.showTxSafetyPrompt(); return; }
  const call = me();
  const p = kind === 'hbsnr' ? plan(target, `HEARTBEAT SNR ${snr < 0 ? '-' : '+'}${String(Math.abs(Math.round(snr))).padStart(2, '0')}`)
    : kind === 'hb' ? plan('HB', '') : kind === 'cq' ? plan('CQ', '') : plan(target, text);
  const frames = p.frames;
  if (!frames) { status(p.why || 'nothing to send'); return; }
  const speed = st.txSpeed, m = js8Mode(speed);
  const first = nextSlot(speed);
  const id = `tx-${first}`;
  // heartbeats and CQs go in the heartbeat part of the passband, the way JS8 stations listen for them
  const hz = kind === 'hb' || kind === 'cq' ? HB_LO_HZ + Math.random() * (HB_HI_HZ - HB_LO_HZ) : st.txHz;
  const shown = asShown(frames);
  st.entries.push({ id, ms: first, mode: speed, hz, snr: 0, dt: 0, text: shown, complete: true, frames: frames.length, mine: true, state: 'queued', meaning: parseMessage(shown) });
  frames.forEach((f, k) => st.queue.push({ at: first + k * m.period * 1000 + m.delay * 1000, label: `JS8 ${m.label} ${k + 1}/${frames.length}`, tones: frameTones(f, m.costas), speed, entry: id, last: k === frames.length - 1, hz }));
  if (kind === 'text') { st.draft = ''; const tf = document.getElementById('j8-text') as HTMLInputElement | null; if (tf) tf.value = ''; }
  status(`${frames.length} frame${frames.length > 1 ? 's' : ''} · ${m.label} · ${Math.round(hz)} Hz · starts ${new Date(first).toISOString().slice(11, 19)} UTC`);
  void call;
  save(0); refresh(true);
}
function pump(now: number): void {
  if (!host || !st.queue.length) return;
  const q0 = st.queue[0];
  if (now < q0.at - 40) return;
  st.queue.shift();
  const e = st.entries.find(x => x.id === q0.entry);
  if (now > q0.at + 1500) {
    // too late for its slot: everything still queued for this message moves on by whole slots
    const P = js8Mode(q0.speed).period * 1000, late = Math.ceil((now - q0.at) / P) * P;
    st.queue.unshift({ ...q0, at: q0.at + late }); for (const x of st.queue) if (x.entry === q0.entry && x !== st.queue[0]) x.at += late;
    return;
  }
  const m = js8Mode(q0.speed), rate = 12_000;
  const ok = host.tx.js8(q0.label, st.dial + (q0.hz ?? st.txHz), toneTrack(q0.tones, m, rate), rate, Math.round(m.symbol * rate));
  if (e) e.state = ok ? (q0.last ? 'sent' : 'sending') : 'failed';
  if (!ok) { for (let i = st.queue.length - 1; i >= 0; i--) if (st.queue[i].entry === q0.entry) st.queue.splice(i, 1); }
  refresh(true);
}
function status(s: string): void { st.status = s; const el = document.getElementById('j8-status'); if (el) el.textContent = s; }
export function js8Stop(): void { st.queue = []; for (const e of st.entries) if (e.mine && (e.state === 'queued' || e.state === 'sending')) e.state = 'failed'; }

// ---- rendering -----------------------------------------------------------------------------------------------------
const WIDE = window.matchMedia('(min-width: 1000px)');
const ago = (ms: number, now: number) => { const s = Math.max(0, Math.round((now - ms) / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };
const utc = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const fmtSnr = (s: number) => `${s >= 0 ? '+' : ''}${s}`;
const SPEED_SHORT: Record<Js8Speed, string> = { slow: 'S', normal: 'N', fast: 'F', turbo: 'T' };
function where(grid: string): { km: number; deg: number } | null {
  const p = gridToLatLon(grid); const h = host?.home() ?? (host?.station().grid ? gridToLatLon(host.station().grid) : null);
  if (!p || !h) return null;
  return distanceBearing(h.lat, h.lon, p.lat, p.lon);
}
const compass = (d: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];

export function renderJs8(view: HTMLElement, h: Js8Host): void {
  host = h;
  const wide = WIDE.matches;
  if (wide && st.view === 'map') st.view = 'chat';
  view.classList.toggle('j8wide', wide);
  const views = wide ? VIEWS.filter(v => v !== 'map' && v !== 'band') : VIEWS;
  const mapHtml = '<div id="j8-map" class="panel map"></div>';
  const wfHtml = '<div class="j8-wfbox"><canvas id="j8-wf" class="j8-wf"></canvas><div id="j8-wfscale" class="j8-wfscale"></div></div>';
  view.innerHTML = `
    <section class="visual">${h.readoutHtml()}${wide ? `<div class="j8-mapbox">${mapHtml}</div>${wfHtml}` : ''}</section>
    <section class="controls">
      ${h.hsHtml(`<div class="tiles">${JS8_DIALS.map(([l, f]) => `<button class="tl" data-j8dial="${f}"><b>${l}</b><small>${(f / 1e6).toFixed(3)}</small></button>`).join('')}</div>`)}
      <div class="ctlrow">${h.segHtml(JS8_MODES.map(m => `<button data-j8speed="${m.id}">${m.label}</button>`))}</div>
      <div id="j8-clock" class="j8-clock"></div>
      ${wide ? `<div class="ctlrow">${h.segHtml(views.map(v => `<button data-j8view="${v}">${VIEW_LABEL[v]}</button>`))}</div>` : `<nav class="fl-jump">${views.map(v => `<button data-j8view="${v}"><span>${VIEW_LABEL[v]}</span><b></b></button>`).join('')}</nav>`}
      <div id="j8-stage" class="j8-stage">
        ${wide ? '' : '<div class="fl-sech" data-j8sec="chat">CHAT</div>'}<div id="j8-chat" class="j8-chat"></div><div id="j8-compose" class="j8-compose">${composeHtml()}</div>
        ${wide ? '' : '<div class="fl-sech" data-j8sec="groups">GROUPS</div>'}<div id="j8-groups" class="j8-groups"></div>
        ${wide ? '' : '<div class="fl-sech" data-j8sec="heard">HEARD</div>'}<div id="j8-heard" class="j8-heard"></div>
        ${wide ? '' : `<div class="fl-sech" data-j8sec="map">MAP</div><div class="j8-mapwrap">${mapHtml}</div>`}
        ${wide ? '' : `<div class="fl-sech" data-j8sec="band">WATERFALL</div>${wfHtml}`}
        ${wide ? '' : '<div class="fl-sech" data-j8sec="inbox">INBOX</div>'}<div id="j8-inbox" class="j8-inbox"></div>
        ${wide ? '' : '<div class="fl-sech" data-j8sec="log">ACTIVITY</div>'}<div id="j8-log" class="j8-log"></div>
      </div>
      <div class="note about">JS8 keyboard-to-keyboard messaging on HF, receive and send. Every JS8 signal in the USB passband is decoded at all four speeds at once, Slow (3.125 baud, 30 s slots), Normal (6.25 baud, 15 s), Fast (10 baud, 10 s) and Turbo (20 baud, 6 s), each 79 tones of 8-FSK with three Costas sync blocks, the (174,87) LDPC code and the 12-bit CRC. Slots follow the device clock, and each station shows its time offset (DT), its drift across the frame and its offset in the passband. Frames join into messages by their first and last flags, directed messages with their command, heartbeat acknowledgements with the signal report, and text in JS8's character code. CHAT keeps a conversation per station and per group, GROUPS lists @ALLCALL, @HB, @TPP and any group you add, HEARD lists the stations with SNR, time, offset, grid, distance and bearing, the map places them by grid, the waterfall shows the passband with each decode marked, and INBOX keeps what was sent to you. Sending uses your callsign from Settings and the transmit gate. Directed messages, acknowledgements and text go out on the next slot boundary of the chosen speed at the chosen offset, one frame per slot. Tap the waterfall to set the transmit offset.</div>
    </section>`;
  h.setGeo(null);
  st.geo = new GeoMap(document.getElementById('j8-map')!, { home: h.home(), start: mapStart(h.home()), fitPins: true, steady: true, twoFinger: !wide, onPick: id => { st.sel = id; st.view = 'heard'; refresh(true); }, log: h.log, fallback: () => h.home() ?? lastKnownPos() ?? zoneGuess() });
  h.setGeo(st.geo);
  wire(view);
  clearInterval(st.timer);
  st.timer = window.setInterval(() => { if (!h.isOpen()) { clearInterval(st.timer); return; } const now = Date.now(); pump(now); clock(now); if (now % 2000 < 260) refresh(); }, 100);
  refresh(true);
  drawWaterfall();
}

function wire(view: HTMLElement): void {
  const h = host!;
  targetsKey = '';
  view.querySelectorAll<HTMLButtonElement>('[data-j8dial]').forEach(b => b.onclick = () => h.tune(Number(b.dataset.j8dial)));
  view.querySelectorAll<HTMLButtonElement>('[data-j8speed]').forEach(b => b.onclick = () => {
    const id = b.dataset.j8speed as Js8Speed;
    st.speeds[id] = !st.speeds[id];
    if (!Object.values(st.speeds).some(Boolean)) st.speeds[id] = true;
    h.setSpeeds(st.speeds); save(0); refresh(true);
  });
  view.querySelectorAll<HTMLButtonElement>('[data-j8view]').forEach(b => b.onclick = () => {
    st.view = b.dataset.j8view as View; refresh(true);
    if (!WIDE.matches) setTimeout(() => { const t = view.querySelector(`[data-j8sec="${st.view}"]`), sc = document.getElementById('view')!; const r = t?.getBoundingClientRect(); if (t && r) sc.scrollTo({ top: sc.scrollTop + r.top - sc.getBoundingClientRect().top - 56 }); }, 60);
  });
  const sc = document.getElementById('view')!;
  if (st.spy) sc.removeEventListener('scroll', st.spy);
  st.spy = () => {
    if (!h.isOpen() || WIDE.matches) return;
    const top = sc.getBoundingClientRect().top + 120; let cur: View = 'chat';
    for (const v of VIEWS) { const el = view.querySelector(`[data-j8sec="${v}"]`); if (el && el.getBoundingClientRect().top <= top) cur = v; }
    view.querySelectorAll<HTMLButtonElement>('.fl-jump [data-j8view]').forEach(b => b.classList.toggle('on', b.dataset.j8view === cur));
  };
  sc.addEventListener('scroll', st.spy, { passive: true });
  // a redraw between press and release would swap the element under the pointer
  const hold = () => { st.hold = true; };
  for (const id of ['j8-chat', 'j8-groups', 'j8-heard', 'j8-inbox', 'j8-log']) { const el = document.getElementById(id); if (el) el.onpointerdown = hold; }
  if (!st.wired) { st.wired = true; const rel = () => { if (!st.hold) return; setTimeout(() => { st.hold = false; refresh(true); }, 0); }; window.addEventListener('pointerup', rel); window.addEventListener('pointercancel', rel); }
  const ctl = view.querySelector<HTMLElement>('section.controls')!;
  ctl.addEventListener('click', onClick);
  ctl.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.id === 'j8-text') { st.draft = t.value; budget(); } });
  ctl.addEventListener('keydown', e => { const t = e.target as HTMLInputElement; if (t.id === 'j8-text' && e.key === 'Enter') { e.preventDefault(); send('text', st.target, st.draft); } if (t.id === 'j8-addgroup' && e.key === 'Enter') { e.preventDefault(); addGroup(t.value); } });
  ctl.addEventListener('change', e => { const t = e.target as HTMLSelectElement; if (t.id === 'j8-target') { st.target = t.value; refresh(true); } if (t.id === 'j8-txspeed') { st.txSpeed = t.value as Js8Speed; save(0); refresh(true); } });
  const wf = document.getElementById('j8-wf') as HTMLCanvasElement | null;
  if (wf) wf.onclick = e => { const r = wf.getBoundingClientRect(); const hz = Math.round(((e.clientX - r.left) / r.width) * 3200 / 10) * 10; st.txHz = Math.max(TX_MIN_HZ, Math.min(TX_MAX_HZ, hz)); save(0); status(`transmit offset ${st.txHz} Hz`); drawWaterfall(); refresh(true); };
}
function addGroup(v: string): void { const g = normGroup(v); if (!g) { status('a group is @ and up to 9 letters or digits'); return; } if (!st.groups.includes(g)) st.groups.push(g); if (!st.follow.includes(g)) st.follow.push(g); save(0); refresh(true); }
function onClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  const a = t.closest<HTMLElement>('[data-j8do]'); if (!a) return;
  const [what, arg] = (a.dataset.j8do ?? '').split(':');
  const val = a.dataset.j8arg ?? arg ?? '';
  switch (what) {
    case 'room': st.room = val; st.read[val] = Date.now(); if (!isGroup(val) && val !== 'BAND' && !val.includes('|') && val !== '@CQ') st.target = val; else if (isGroup(val)) st.target = val; else st.target = 'BAND'; save(0); break;
    case 'rooms': st.room = ''; break;
    case 'send': send('text', st.target, (document.getElementById('j8-text') as HTMLInputElement | null)?.value ?? st.draft); return;
    case 'hbsnr': { const s = st.stations.get(val); if (s) send('hbsnr', s.call, '', s.snr); return; }
    case 'hb': send('hb', '', ''); return;
    case 'cq': send('cq', '', ''); return;
    case 'follow': if (followed(val)) st.follow = st.follow.filter(x => x !== val); else st.follow.push(val); save(0); break;
    case 'delgroup': if (!BUILTIN_GROUPS.includes(val)) { st.groups = st.groups.filter(x => x !== val); st.follow = st.follow.filter(x => x !== val); save(0); } break;
    case 'addgroup': addGroup((document.getElementById('j8-addgroup') as HTMLInputElement | null)?.value ?? ''); return;
    case 'station': st.sel = st.sel === val ? '' : val; break;
    case 'chatwith': st.room = val; st.target = val; st.view = 'chat'; st.read[val] = Date.now(); break;
    case 'map': { const s = st.stations.get(val); const p = s?.grid ? gridToLatLon(s.grid) : null; if (p) { st.view = 'map'; st.geo?.center(p.lat, p.lon, 5); } break; }
    case 'entry': st.sel = st.sel === `e:${val}` ? '' : `e:${val}`; break;
    case 'deliver': { const e = st.entries.find(x => x.id === val); if (e?.meaning.dest) { st.room = e.meaning.dest; st.target = e.meaning.dest; st.draft = `MSG FROM ${e.meaning.from} ${e.meaning.body}`; st.view = 'chat'; } break; }
    case 'tx': st.txHz = Math.max(TX_MIN_HZ, Math.min(TX_MAX_HZ, st.txHz + Number(val))); save(0); drawWaterfall(); break;
    case 'clearlog': st.activity = []; save(0); break;
  }
  refresh(true);
}

function clock(now: number): void {
  const el = document.getElementById('j8-clock'); if (!el) return;
  el.innerHTML = JS8_MODES.map(m => { const P = m.period * 1000, left = Math.ceil((P - (now % P)) / 1000); return `<span class="${st.speeds[m.id] ? 'on' : ''} ${m.id === st.txSpeed ? 'tx' : ''}">${m.label} ${left} s</span>`; }).join('') + `<span class="utc">${utc(now)} UTC</span>`;
}
function budget(): void {
  const el = document.getElementById('j8-budget'); if (!el) return;
  const p = plan(st.target, st.draft);
  if (p.why) { el.textContent = p.why; return; }
  const n = p.frames?.length ?? 0, m = js8Mode(st.txSpeed);
  el.textContent = n ? `${n} frame${n > 1 ? 's' : ''} · ${Math.round(n * m.period)} s at ${m.label}` : 'type a message';
}

export function refreshJs8(force = false): void { refresh(force); }
function refresh(force = false): void {
  if (!host || !host.isOpen() || (st.hold && !force)) return;
  const wide = WIDE.matches, now = Date.now();
  document.querySelectorAll<HTMLButtonElement>('[data-j8dial]').forEach(b => b.classList.toggle('on', Number(b.dataset.j8dial) === st.dial));
  document.querySelectorAll<HTMLButtonElement>('[data-j8speed]').forEach(b => b.classList.toggle('on', !!st.speeds[b.dataset.j8speed as Js8Speed]));
  const rs = rooms(), unreadAll = rs.reduce((s, r) => s + r.unread, 0), inbox = st.entries.filter(e => !e.mine && forMe(e));
  const counts: Record<View, string> = { chat: unreadAll ? String(unreadAll) : '', groups: String(st.groups.length), heard: st.stations.size ? String(st.stations.size) : '', map: '', band: '', inbox: inbox.length ? String(inbox.length) : '', log: st.activity.length ? String(st.activity.length) : '' };
  document.querySelectorAll<HTMLButtonElement>('[data-j8view]').forEach(b => { if (wide) b.classList.toggle('on', b.dataset.j8view === st.view); const c = b.querySelector('b'); if (c) c.textContent = counts[b.dataset.j8view as View]; });
  const show = (id: string, v: View) => { const el = document.getElementById(id); if (el) el.hidden = wide && st.view !== v; return el; };
  const chat = show('j8-chat', 'chat'); if (chat) chat.innerHTML = chatHtml(rs, now);
  const gr = show('j8-groups', 'groups'); if (gr) gr.innerHTML = groupsHtml(rs);
  const he = show('j8-heard', 'heard'); if (he) he.innerHTML = heardHtml(now);
  const ib = show('j8-inbox', 'inbox'); if (ib) ib.innerHTML = inboxHtml(inbox, now);
  const lg = show('j8-log', 'log'); if (lg) lg.innerHTML = logHtml();
  const co = show('j8-compose', 'chat'); if (co) refreshCompose();
  budget();
  mapPins();
  status(st.status);
}

function bubble(e: Js8Entry, now: number): string {
  const esc = host!.esc, m = e.meaning;
  const who = e.mine ? 'YOU' : m.from || 'UNKNOWN';
  const body = m.from && e.text.startsWith(`${m.from}:`) ? e.text.slice(m.from.length + 1).trim() : e.text;
  const meta = e.mine ? `${utc(e.ms)} · ${js8Mode(e.mode).label} · ${e.hz} Hz · ${e.state === 'sent' ? 'SENT' : e.state === 'sending' ? 'SENDING' : e.state === 'failed' ? 'NOT SENT' : 'QUEUED'}` : `${utc(e.ms)} · ${SPEED_SHORT[e.mode]} · ${fmtSnr(e.snr)} dB · ${e.hz} Hz`;
  const tag = m.kind !== 'directed' && m.kind !== 'text' ? `<i class="j8-kind">${m.command ?? m.kind.toUpperCase()}</i>` : '';
  return `<div class="j8-msg ${e.mine ? 'mine' : ''} ${forMe(e) ? 'tome' : ''}" data-j8do="entry:${esc(e.id)}"><div class="j8-who"><b>${esc(who)}</b>${tag}<span>${meta}</span></div><div class="j8-body">${esc(body)}${e.complete && !e.mine ? ' <span class="eot">♢</span>' : ''}</div>${st.sel === `e:${e.id}` ? entryDetail(e, now) : ''}</div>`;
}
function entryDetail(e: Js8Entry, now: number): string {
  const esc = host!.esc, m = e.meaning, rows: [string, string][] = [
    ['Heard', `${utc(e.ms)} UTC, ${ago(e.ms, now)} ago`], ['Speed', js8Mode(e.mode).label], ['Offset', `${e.hz} Hz`], ['SNR', `${fmtSnr(e.snr)} dB`], ['DT', `${e.dt.toFixed(1)} s`], ['Frames', String(e.frames)],
    ['Type', m.command ?? m.kind.toUpperCase()], ...(m.from ? [['From', m.from] as [string, string]] : []), ...(m.to ? [['To', m.to] as [string, string]] : []),
    ...(m.path?.length ? [['Relay', [m.to, ...m.path].join(' > ')] as [string, string]] : []), ...(m.dest ? [['For', m.dest] as [string, string]] : []),
    ...(m.snr !== undefined ? [['Report', `${fmtSnr(m.snr)} dB`] as [string, string]] : []), ...(m.grid ? [['Grid', m.grid] as [string, string]] : []), ...(m.msgId !== undefined ? [['Message', String(m.msgId)] as [string, string]] : []),
  ];
  return `<div class="j8-detail">${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${esc(v)}</span></div>`).join('')}<div class="kv"><span>Text</span><span>${esc(e.text)}</span></div></div>`;
}
function chatHtml(rs: ReturnType<typeof rooms>, now: number): string {
  const esc = host!.esc;
  const room = st.room;
  const list = `<div class="j8-rooms">${rs.length ? rs.map(r => `<button class="j8-room ${r.key === room ? 'on' : ''} ${followed(r.key) ? 'fol' : ''}" data-j8do="room" data-j8arg="${esc(r.key)}"><b>${esc(roomTitle(r.key))}</b><span>${r.n ? `${r.n} · ${ago(r.last, now)}` : 'no messages yet'}</span>${r.unread ? `<i>${r.unread}</i>` : ''}</button>`).join('') : '<div class="empty">Messages show here as they are heard: tune a JS8 frequency in USB</div>'}</div>`;
  const items = room ? st.entries.filter(e => roomOf(e) === room).slice(-80) : st.entries.filter(e => e.meaning.kind !== 'text' || e.mine || e.frames > 1).slice(-30);
  const thread = `<div class="j8-thread">${items.length ? items.map(e => bubble(e, now)).join('') : `<div class="empty">${room ? `Nothing in ${esc(roomTitle(room))} yet` : 'No messages yet'}</div>`}</div>`;
  return `<div class="j8-chathead">${room ? `<button class="chip" data-j8do="rooms">‹ ALL</button><b>${esc(roomTitle(room))}</b>` : '<b>ALL ROOMS</b>'}</div>${room ? '' : list}${thread}`;
}
function targetList(): string[] {
  const t = ['BAND', ...st.groups, ...[...st.stations.values()].sort((a, b) => b.lastMs - a.lastMs).slice(0, 40).map(s => s.call)];
  if (st.target && !t.includes(st.target)) t.splice(1, 0, st.target);
  return t;
}
function targetOptions(): string {
  const esc = host!.esc;
  return targetList().map(v => `<option value="${esc(v)}" ${v === (st.target || 'BAND') ? 'selected' : ''}>${v === 'BAND' ? 'BAND (no address)' : esc(v)}${followed(v) ? ' ★' : ''}</option>`).join('');
}
/** Built once per render: a redraw must never take the text field from under the typing. */
function composeHtml(): string {
  const esc = host!.esc;
  return `<div class="row"><select id="j8-target" class="txin">${targetOptions()}</select><select id="j8-txspeed" class="txin">${JS8_MODES.map(m => `<option value="${m.id}" ${m.id === st.txSpeed ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
    <div class="row"><input id="j8-text" class="txin" placeholder="message" value="${esc(st.draft)}" autocapitalize="characters" spellcheck="false"><button class="chip primary" data-j8do="send">SEND</button></div>
    <div class="row j8-quick"><button class="chip" data-j8do="hb">HEARTBEAT</button><button class="chip" data-j8do="cq">CQ</button></div>
    <div class="row j8-txrow"><span id="j8-budget" class="j8-budget"></span><span class="j8-off"><button class="chip" data-j8do="tx:-50">−</button><b id="j8-txhz">TX ${Math.round(st.txHz)} Hz</b><button class="chip" data-j8do="tx:50">+</button></span></div>
    <div id="j8-status" class="health">${esc(st.status)}</div>`;
}
let targetsKey = '';
function refreshCompose(): void {
  const sel = document.getElementById('j8-target') as HTMLSelectElement | null;
  const key = `${targetList().join(',')}|${st.target}|${st.follow.join(',')}`;
  if (sel && document.activeElement !== sel && key !== targetsKey) { targetsKey = key; sel.innerHTML = targetOptions(); }
  const txt = document.getElementById('j8-text') as HTMLInputElement | null;
  if (txt && document.activeElement !== txt && txt.value !== st.draft) txt.value = st.draft;
  const hz = document.getElementById('j8-txhz'); if (hz) hz.textContent = `TX ${Math.round(st.txHz)} Hz`;
  const sp = document.getElementById('j8-txspeed') as HTMLSelectElement | null; if (sp && document.activeElement !== sp) sp.value = st.txSpeed;
}
function groupsHtml(rs: ReturnType<typeof rooms>): string {
  const esc = host!.esc;
  const n = (g: string) => rs.find(r => r.key === g)?.n ?? 0;
  return `<div class="j8-glist">${st.groups.map(g => `<div class="j8-grp ${followed(g) ? 'fol' : ''}"><button class="j8-gname" data-j8do="room" data-j8arg="${esc(g)}"><b>${esc(g)}</b><span>${n(g)} message${n(g) === 1 ? '' : 's'}${BUILTIN_GROUPS.includes(g) ? ' · built in' : ''}</span></button><button class="chip ${followed(g) ? 'on' : ''}" data-j8do="follow" data-j8arg="${esc(g)}">${followed(g) ? 'FOLLOWING' : 'FOLLOW'}</button>${BUILTIN_GROUPS.includes(g) ? '' : `<button class="ib" data-j8do="delgroup" data-j8arg="${esc(g)}" aria-label="remove">✕</button>`}</div>`).join('')}</div>
    <div class="row j8-add"><input id="j8-addgroup" class="txin" placeholder="@GROUPNAME" autocapitalize="characters" spellcheck="false"><button class="chip" data-j8do="addgroup">ADD</button></div>`;
}
function heardHtml(now: number): string {
  const esc = host!.esc;
  const list = [...st.stations.values()].sort((a, b) => b.lastMs - a.lastMs);
  if (!list.length) return '<div class="empty">Stations show here as they are heard</div>';
  return `<div class="j8-stations">${list.map(s => {
    const w = s.grid ? where(s.grid) : null;
    const sel = st.sel === s.call;
    return `<div class="j8-st ${sel ? 'sel' : ''} ${now - s.lastMs < 5 * 60_000 ? 'live' : ''}" data-j8do="station" data-j8arg="${esc(s.call)}">
      <div class="j8-strow"><b>${esc(s.call)}</b><span class="snr">${fmtSnr(s.snr)} dB</span><span>${ago(s.lastMs, now)}</span><span>${Math.round(s.hz)} Hz</span><span>${esc(s.grid)}</span><span>${w ? `${fmtDist(w.km)} ${compass(w.deg)}` : ''}</span></div>
      ${sel ? `<div class="j8-detail"><div class="kv"><span>Last heard</span><span>${utc(s.lastMs)} UTC · ${js8Mode(s.mode).label}</span></div><div class="kv"><span>Offset</span><span>${Math.round(s.hz)} Hz</span></div><div class="kv"><span>SNR</span><span>${fmtSnr(s.snr)} dB</span></div><div class="kv"><span>DT</span><span>${s.dt.toFixed(2)} s now · ${s.dtAvg.toFixed(2)} s average</span></div><div class="kv"><span>Drift</span><span>${s.drift.toFixed(1)} Hz/min</span></div>${s.grid ? `<div class="kv"><span>Grid</span><span>${esc(s.grid)}</span></div>` : ''}${w ? `<div class="kv"><span>From you</span><span>${fmtDist(w.km)} · ${Math.round(w.deg)}° ${compass(w.deg)}</span></div>` : ''}<div class="kv"><span>Frames</span><span>${s.heard} since ${utc(s.firstMs)} UTC</span></div>
        <div class="row"><button class="chip" data-j8do="chatwith" data-j8arg="${esc(s.call)}">MESSAGE</button><button class="chip" data-j8do="hbsnr" data-j8arg="${esc(s.call)}">ACK ${fmtSnr(s.snr)} dB</button>${s.grid ? `<button class="chip" data-j8do="map" data-j8arg="${esc(s.call)}">MAP</button>` : ''}</div></div>` : ''}
    </div>`;
  }).join('')}</div>`;
}
function inboxHtml(list: Js8Entry[], now: number): string {
  const esc = host!.esc;
  const stored = st.entries.filter(e => e.meaning.kind === 'msgto' && !e.mine && e.meaning.dest && e.meaning.dest !== me());
  if (!list.length && !stored.length) return `<div class="empty">${me() ? `Messages to ${esc(me())} land here` : 'Set your callsign in Settings, STATION, and messages to you land here'}</div>`;
  return `${list.slice().reverse().map(e => bubble(e, now)).join('')}${stored.length ? `<div class="caption">KEPT FOR OTHERS</div>${stored.map(e => `<div class="j8-msg"><div class="j8-who"><b>${esc(e.meaning.from)}</b><i class="j8-kind">FOR ${esc(e.meaning.dest ?? '')}</i><span>${utc(e.ms)}</span></div><div class="j8-body">${esc(e.meaning.body)}</div><div class="row"><button class="chip" data-j8do="deliver" data-j8arg="${esc(e.id)}">DELIVER</button></div></div>`).join('')}` : ''}`;
}
function logHtml(): string {
  const esc = host!.esc;
  if (!st.activity.length) return '<div class="empty">Every frame decoded shows here: time, speed, SNR, DT, offset</div>';
  return `<div class="panel list j8-act">${st.activity.slice(0, 200).map((a, i) => `<div class="li ${i % 2 ? 'alt' : ''}"><span class="row2"><span>${utc(a.ms)} ${SPEED_SHORT[a.mode]} ${fmtSnr(a.snr).padStart(3)} ${a.dt.toFixed(1).padStart(4)} ${String(Math.round(a.hz)).padStart(4)}</span><span>${esc(a.text)}</span></span></div>`).join('')}</div><div class="row"><button class="chip" data-j8do="clearlog">CLEAR</button></div>`;
}
function mapPins(): void {
  if (!st.geo) return;
  const items: GeoItem[] = [];
  for (const s of st.stations.values()) { const p = s.grid ? gridToLatLon(s.grid) : null; if (p) items.push({ id: s.call, lat: p.lat, lon: p.lon, label: `${s.call} ${fmtSnr(s.snr)}`, kind: 'station' }); }
  st.geo.update(items, st.sel);
  st.geo.setEmpty(items.length ? '' : 'No stations with a grid yet', 'Stations appear on the map once they send their grid');
}

// ---- band activity waterfall --------------------------------------------------------------------------------------
function drawWaterfall(): void {
  const c = document.getElementById('j8-wf') as HTMLCanvasElement | null; if (!c) return;
  const w = Math.max(200, Math.round(c.clientWidth)), hgt = Math.max(120, Math.round(c.clientHeight));
  if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; }
  const g = c.getContext('2d'); if (!g) return;
  const css = getComputedStyle(c), accent = css.getPropertyValue('--accent').trim() || '#20d0a0';
  const img = g.createImageData(w, hgt);
  const rows = st.wf, n = rows.length, bins = 512, maxHz = 3200;
  const rowH = hgt / Math.max(60, Math.min(240, n));
  for (let y = 0; y < hgt; y++) {
    const ri = n - 1 - Math.floor(y / rowH); if (ri < 0) break;
    const r = rows[ri].row;
    for (let x = 0; x < w; x++) {
      const v = r[Math.min(bins - 1, Math.floor(x / w * bins))];
      const o = (y * w + x) * 4;
      img.data[o] = Math.min(255, v * 1.1 > 180 ? (v - 160) * 3 : 0); img.data[o + 1] = Math.min(255, v * 0.9); img.data[o + 2] = Math.min(255, 40 + v * 0.7); img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const newest = n ? rows[n - 1].ms : Date.now(), msPerRow = 250;
  g.font = '600 10px system-ui, sans-serif'; g.textBaseline = 'middle';
  for (const mk of st.marks) {
    const y = (newest - mk.ms) / msPerRow * rowH; if (y < 0 || y > hgt) continue;
    const x = mk.hz / maxHz * w, bw = Math.max(3, 8 * js8Mode(mk.mode).spacing / maxHz * w);
    g.strokeStyle = accent; g.lineWidth = 1.5; g.strokeRect(x, y - 2, bw, 4);
    g.fillStyle = accent; g.fillText(mk.label, Math.min(w - 60, x + bw + 3), y);
  }
  // transmit offset
  const tx = st.txHz / maxHz * w, tw = 8 * js8Mode(st.txSpeed).spacing / maxHz * w;
  g.fillStyle = 'rgba(255,80,80,0.18)'; g.fillRect(tx, 0, Math.max(2, tw), hgt);
  g.strokeStyle = '#ff5050'; g.lineWidth = 1; g.beginPath(); g.moveTo(tx + 0.5, 0); g.lineTo(tx + 0.5, hgt); g.stroke();
  const sc = document.getElementById('j8-wfscale');
  if (sc && !sc.childElementCount) sc.innerHTML = [500, 1000, 1500, 2000, 2500, 3000].map(f => `<span style="left:${f / maxHz * 100}%">${f}</span>`).join('');
}

/** Frames a text takes at a speed, for the compose line and tests. */
export function js8FrameCount(target: string, text: string): number { return plan(target, text).frames?.length ?? 0; }
export const js8State = st;
export { frameSeconds, symSamples };
