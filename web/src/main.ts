/** Mayhem Mobile — web. Launcher, screens, WebUSB radio, DSP worker, audio, skins. */
import { HackRf, HACKRF_FILTERS, isMayhemSerial } from './hackrf.js';
import { RTLSDR_FILTERS, RTLSDR_READY, RtlSdr, isRtlSdr } from './rtlsdr.js';
import { APP_NEEDS, blockedBecause, canSample, canTune, cleanWidest, nearestRate, whyNot, type Radio } from './radio.js';
import type { DmrStatus } from './dsp/ham/dmr.js';
import type { P25Status } from './dsp/ham/p25.js';
import { lookupCall, offlineInfo, latLonToGrid, gridToLatLon, distanceBearing, toAdif, fromAdif, bandOfHz, parseCall, type Qso, type CallInfo } from './callsign.js';
import { SKINS, applySkin, currentSkin, loadSkin } from './theme.js';
import { glyph } from './glyphs.js';
import { Scope, centredLabels, rangeLabels, rowToSpec } from './scope.js';
import { btleChannelFreq } from './dsp/btle.js';
import { ORBCOMM_CHANNELS, type OrbcommSat } from './dsp/orbcomm.js';
import type { PacketFrame } from './dsp/g3ruh.js';
import { fetchGroup } from './sat.js';
import { PACKET_SATS } from './packet-sats.js';
import { GEOSCAN_SATS } from './dsp/geoscan.js';
import type { HeardDevice, R433Data, R433Protocol, R433Report } from './dsp/r433/index.js';
import { CREDITS } from './credits.js';
import { Tx, type SigMode } from './tx.js';
import * as Apps from './tx-apps.js';
import type { Aircraft } from './dsp/adsb.js';
import type { Vessel } from './dsp/ais.js';
import type { AprsStation } from './dsp/aprs.js';
import { aprsSymbolName } from './aprs-info.js';
import { GeoMap, type GeoItem } from './geomap.js';
import { mmsiInfo, shipTypeName, navStatusName, atonTypeName } from './ais-info.js';
import { BANDS, NON_HAM, bandOf, segmentOf, repeaterInput } from './bands.js';
import { BANDS as LORA_BANDS, NARROW_TILES as LORA_TILES, NARROW_SHIFT as LORA_SHIFT, homeBand as loraHomeBand } from './dsp/lora/plan.js';
import type { HamMode, AgcMode } from './dsp/ham/demod.js';
import { SATS, Sgp4, look, doppler, passes, fetchTles, type Tle, type Pass, dopplerUp, type SatService } from './sat.js';
import { ISM_COUNTS } from './dsp/ism/counts.js';
import { EOT_CENTER as TR_EOT_CENTER, EOT_RATE as TR_EOT_RATE, EOT_NARROW as TR_EOT_NARROW, PTC_CENTER as TR_PTC_CENTER, PTC_RATE as TR_PTC_RATE, PTC_NARROW as TR_PTC_NARROW, PTC_KIND_LABEL, stationPeriod, stationVaries, symHex, type EotUnit, type HotHeard, type PtcStation } from './dsp/trains.js';

type Mode = 'WFM' | 'NFM' | 'AM' | 'USB' | 'LSB' | 'NONE';
/**
 * The general-purpose receivers' base sample rate. 1.92 Msps, not the rounder 2 Msps, because the audio path
 * decimates by whole numbers and has no resampler: 1.92 M → 240 k → 48 k lands exactly on the 48 kHz player,
 * whereas 2 M gives 250 k → 50 k for WFM (played 4 % fast and sharp) and 48.78 k for NFM (1.6 % fast). The
 * HAM screen already ran the same radio at this rate for the same reason; now the two agree. The fixed-purpose
 * decoders (ADS-B, BTLE, …) keep their own 2 Msps — their timing is built around it and they make no audio.
 */
const RX_RATE = 1_920_000;
type AppId = 'transmit' | 'troll' | 'ham' | 'audio' | 'prowl' | 'sat' | 'adsb' | 'ais' | 'aprs' | 'pager' | 'ert' | 'lora' | 'btle' | 'tpms' | 'acars' | 'trains' | 'subghz' | 'devices' | 'lookingglass' | 'search' | 'capture' | 'settings';
interface AppDef { id: AppId; title: string; blurb: string; cat: 'Receive' | 'Analyze' | 'Tools' | 'Transmit'; }

const APPS: AppDef[] = [
  { id: 'ham', title: 'HAM', blurb: 'SSB · CW · AM · NFM · repeaters · CTCSS', cat: 'Receive' },
  { id: 'audio', title: 'Audio', blurb: 'WFM · NFM · AM · SSB receiver', cat: 'Receive' },
  { id: 'devices', title: 'Devices', blurb: 'alarms, meters, remotes, tire sensors, weather', cat: 'Receive' },
  { id: 'sat', title: 'Satellites', blurb: 'track, listen to and decode what is overhead', cat: 'Receive' },
  { id: 'adsb', title: 'ADS-B', blurb: 'aircraft, 1090 MHz', cat: 'Receive' },
  { id: 'ais', title: 'AIS', blurb: 'ships, 162 MHz', cat: 'Receive' },
  { id: 'aprs', title: 'APRS', blurb: 'packet radio, 144.39 MHz', cat: 'Receive' },
  { id: 'pager', title: 'FLEX', blurb: 'pager RX · FLEX, or POCSAG too', cat: 'Receive' },
  { id: 'ert', title: 'Meters', blurb: 'utility meters: ERT, mesh networks, Gridstream', cat: 'Receive' },
  { id: 'lora', title: 'LoRa', blurb: 'Meshtastic · MeshCore · LoRaWAN, 915 MHz', cat: 'Receive' },
  { id: 'btle', title: 'BLE RX', blurb: 'advertising, 2.4 GHz', cat: 'Receive' },
  { id: 'tpms', title: 'TPMS', blurb: 'tire pressure, 315 / 433 MHz', cat: 'Receive' },
  { id: 'acars', title: 'ACARS', blurb: 'aircraft messages, 131 MHz', cat: 'Receive' },
  { id: 'trains', title: 'Trains', blurb: 'end-of-train telemetry · PTC train control', cat: 'Receive' },
  { id: 'subghz', title: 'Sub-GHz', blurb: 'weather · remotes · car keys, rtl_433 style', cat: 'Receive' },
  { id: 'prowl', title: 'Prowl', blurb: 'hunts live voice across the bands', cat: 'Receive' },
  { id: 'lookingglass', title: 'Looking Glass', blurb: 'wideband sweep waterfall', cat: 'Analyze' },
  { id: 'search', title: 'Search', blurb: 'find active frequencies', cat: 'Analyze' },
  { id: 'capture', title: 'Capture', blurb: 'record raw IQ to file', cat: 'Tools' },
  { id: 'transmit', title: 'Transmit', blurb: 'signal gen · morse · OOK', cat: 'Transmit' },
  { id: 'troll', title: 'Troll', blurb: 'sub-GHz pranks · weather spoof · cart sounds', cat: 'Transmit' },
  { id: 'settings', title: 'Settings', blurb: 'theme · about · install', cat: 'Tools' },
];
const RANGES: [string, number, number][] = [
  ['FM 88-108', 88e6, 108e6], ['AIR 118-137', 118e6, 137e6], ['2m 144-148', 144e6, 148e6], ['70cm 420-450', 420e6, 450e6],
  ['ISM 902-928', 902e6, 928e6], ['GSM 925-960', 925e6, 960e6], ['1.2-1.6G', 1200e6, 1600e6], ['2.4G ISM', 2400e6, 2483e6],
  ['0.1-1 GHz', 100e6, 1000e6], ['1-3 GHz', 1000e6, 3000e6], ['3-6 GHz', 3000e6, 6000e6],
];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const q = <T extends HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector(sel) as T | null;
const qa = <T extends HTMLElement>(sel: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll(sel)) as T[];

const state = {
  app: null as AppId | null,
  freq: 92_300_000, rate: RX_RATE, mode: 'WFM' as Mode, lna: 32, vga: 32, amp: false,
  radioFreq: 92_300_000, radioMode: 'WFM' as Mode,
  // The dial the user set, shared by every app that is not tuned to a fixed purpose, and remembered between
  // visits. 0 = never touched, so each app keeps its own sensible default (broadcast FM, 2 m calling).
  dial: loadDial(),
  hamLo: 0,
  // Always FM on a fresh load. The strip still moves it, and that lasts as long as the tab does.
  launchBand: 'fm',
  viewLo: 0,                                   // the plain receiver's span center (radio LO); state.freq is the channel
  ham: { freq: 146_520_000, mode: 'NFM' as HamMode, lo: 300, hi: 6000, pitch: 600, agc: 'slow' as AgcMode, nr: false, anf: false, squelch: 6, volume: 1, shift: 0, rev: false, back: 0,
    db: -120, floor: -120, open: true, tone: 0, toneDb: 0, dcs: 0, dcsInv: false, gain: 1, audioPeak: 0,
    digi: { mode: 'off' as 'off' | 'auto' | 'cw' | 'rtty' | 'psk31' | 'ft8' | 'dmr' | 'p25' | 'sstv', dmrSlot: 0, dmr: null as DmrStatus | null, p25: null as P25Status | null, text: '', winner: '', conf: [] as [string, number][], wpm: 0, pskHz: 1000, rttyBaud: 45.45, rttyShift: 170, rttyRev: false, ft8: [] as { utc: string; snr: number; dt: number; hz: number; text: string }[] },
    sat: { sel: 25544, svc: 0, view: 'track' as 'track' | 'orbcomm' | 'packet', tles: new Map<number, Tle>(), track: false, dopplerOn: true, passes: [] as Pass[], status: '', packets: [] as string[] },
    img: { mode: '', width: 0, height: 0, line: 0, done: false, apt: 0, lrpt: { planes: {} as Record<number, Uint8Array>, lines: 0, stats: '' } },
    log: { entries: loadLog(), draft: { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' }, info: null as CallInfo | null, editing: '' },
    station: loadStation(),
    ptt: { dev: 2500, tone: 0, on: false },
    tab: 'rx' as 'rx' | 'monitor' | 'digi' | 'sat' | 'tx' | 'log', mon: { spacing: 12_500, threshold: 8, mode: 'mix' as 'mix' | 'latest' | 'lock', lock: -1, wide: false, first: 0, count: 0, snr: new Float32Array(0), open: [] as number[], listening: [] as number[], tones: {} as Record<number, number>, dcs: {} as Record<number, number>, since: [] as number[], log: [] as string[] } },
  sweepRate: 8_000_000, sweep: null as { start: number; end: number; steps: number } | null,
  btleCh: 37, threshold: 15, pager: 'flex' as 'flex' | 'pocsag' | 'both',
  /** The pager app's mode, as on Android: MULTI hunts the span's carriers, SINGLE decodes the tuned channel. */
  pagerMulti: true,
  ism: { weather: true, remotes: true, cars: true },
  r433: { heard: [] as HeardDevice[], stats: null as R433Report | null, hop: false, band: 0,
    protocols: [] as R433Protocol[], showProtocols: false, span: 250_000 }, muted: false, adsbView: 'map' as 'map' | 'list', adsbFollow: true, adsbSel: '' as string, home: null as { lat: number; lon: number } | null,
  capturing: false, captureName: '', captureBytes: 0, captures: [] as { name: string; size: number }[],
  aircraft: [] as Aircraft[], frames: 0, aisTable: [] as Vessel[], aisSel: 0, aisView: 'map' as 'map' | 'list' | 'log',
  aprsStations: [] as AprsStation[], aprsSel: '', aprsView: 'map' as 'map' | 'list' | 'log',
  connected: false, board: '', firmware: '', gainsScaled: false, agc: true, biast: false,
  squelch: 0, sqOpen: true, scanning: false,
  prowl: {
    on: false, target: null as ProwlTarget | null, tracks: new Map<number, ProwlTrack>(), log: [] as ProwlHit[],
    note: '', band: '', win: -1, movedAt: 0, score: 0, best: 0, parts: '', sweep: false, seen: 0, ready: 0,
    held: null as number | null,
  },
  psat: { sats: [] as PacketSat[], sel: -1, frames: [] as PacketFrame[], heard: 0, bad: 0, note: '',
    framing: 'g3ruh' as 'g3ruh' | 'geoscan', pic: { frames: 0, bad: 0, high: 0, complete: false, fragments: 0, url: '' } },
  orb: {
    channel: 137_662_500, hunt: false, huntAt: 0, sel: -1,
    sats: [] as OrbcommSat[], frames: 0, packets: 0, bad: 0, syncs: 0, lastFrames: 0,
    orbits: [] as { name: string; sgp: Sgp4 }[],
    named: new Map<number, { name: string; km: number }>(),
  },
};
/**
 * A favorite. `mode` and `hz` are all the old ones carried; everything after is how the receiver was set up when
 * it was saved, so recalling one puts you back exactly where you were rather than on a bare frequency.
 */
interface Bookmark {
  name: string; hz: number; mode: Mode;
  app?: AppId;                                       // which receiver heard it
  lna?: number; vga?: number; amp?: boolean; agc?: boolean;
  squelch?: number;
  ham?: { mode: HamMode; lo: number; hi: number; squelch: number; agc: AgcMode; nr: boolean; anf: boolean; digi: string };
}
let bookmarks: Bookmark[] = loadBookmarks();
let scanTimer = 0, scanIdx = 0, scanHopAt = 0;
const logs: Record<string, string[]> = {};
const counts: Record<string, number> = {};
const diag: string[] = [];
let logFollow = true;   // stops when the reader scrolls up, resumes at the bottom
let radio: Radio | null = null;
/** The USB device behind `radio`, so a detach event can tell whether it was the radio that left. */
let radioDev: USBDevice | null = null;
/** True from the start of connect() until its radio stops, so two bring-ups never race for one device. */
let connecting = false;
// Transmit is a HackRF capability and there is no polite way to fake it: a dongle receives only. Handing the
// transmitter nothing when an RTL-SDR is connected is what makes every send path refuse cleanly.
const tx = new Tx(() => (radio && radio.kind === 'hackrf' ? radio as HackRf : null));
let worker: Worker | null = null;
let audioCtx: AudioContext | null = null;
let audioPort: MessagePort | null = null;
let muteGain: GainNode | null = null;
let scope: Scope | null = null;
let sweepScope: Scope | null = null;
let lastSweepRow = new Float32Array(0);
let lastSweepBinHz = 0;
// The span filling in live, slice by slice, kept between passes so the trace shows the whole span with the newest
// slices overwriting the oldest — the way a real spectrum sweep paints across. `lastLiveSpec` throttles the redraw.
let sweepLiveRow = new Float32Array(0);
let lastLiveSpec = 0;
let installPrompt: (Event & { prompt: () => Promise<void> }) | null = null;
let lastHealth = '';
let lastCenterSent = 0;
let lastLevel = 0;
let geo: GeoMap | null = null;               // the map of whichever app is open (ADS-B, AIS, APRS)

// ---- log / status -------------------------------------------------------------------------------------------
function log(line: string): void {
  const t = new Date();
  const ts = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}.${t.getMilliseconds().toString().padStart(3, '0')}`;
  diag.push(`${ts} ${line}`);
  if (diag.length > 4000) diag.shift();
  console.log('[mayhem]', line);
  const el = $('log');
  if (el && !$('log-panel').hidden) { el.textContent = diag.join('\n'); if (logFollow) el.scrollTop = el.scrollHeight; }
}

/** What a shared log needs in order to mean anything: the build, the browser, the screen and the radio. */
function logHeader(): string {
  const s = screen;
  return [
    `Mayhem Mobile (web) ${versionText}`,
    `${navigator.userAgent}`,
    `platform ${navigator.platform || '?'} \u00b7 ${s.width}x${s.height} @${devicePixelRatio}x \u00b7 ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `radio ${state.board ? `${state.board}${state.firmware ? ' \u00b7 fw ' + state.firmware : ''}` : 'none attached'}`,
    `captured ${new Date().toISOString()} \u00b7 ${diag.length} lines`,
  ].join('\n');
}

function logText(): string { return logHeader() + '\n\n' + diag.join('\n'); }
function toggleMute(): void {
  state.muted = !state.muted;
  if (muteGain) muteGain.gain.value = state.muted ? 0 : 1;
  refreshShell();
}
function setStatus(s: string, connected: boolean): void {
  state.connected = connected;
  $('status').textContent = s;
  $('dot').className = 'dot ' + (connected ? 'on' : 'off');
  $('board').textContent = state.board ? `${state.board} · ${state.firmware}` : 'no device';
  if ($('topnav')) refreshShell();
}

// ---- radio / engine control -----------------------------------------------------------------------------------
function loadDial(): number { try { return Number(localStorage.getItem('mayhem.dial')) || 0; } catch { return 0; } }
let dialSaveTimer = 0;
/** Remember the dial for the other apps and for the next visit. */
function setDial(hz: number): void {
  state.dial = hz;
  clearTimeout(dialSaveTimer);
  dialSaveTimer = window.setTimeout(() => { try { localStorage.setItem('mayhem.dial', String(state.dial)); } catch { /* ignore */ } }, 500);
}
/**
 * Set while the app retunes on its own (the launcher's auto-pick of the strongest signal). The dial the receiver
 * apps share records only what the USER chose — a deliberate tap, the keypad, a step — so an automatic move
 * never becomes the frequency the next app opens on. That was the "random" frequency on switching apps.
 */
let silentTune = false;
function tune(hz: number, hold = false): void {
  if (state.app === 'ham') { hamTune(hz); return; }
  state.freq = Math.min(6_000_000_000, Math.max(1_000_000, Math.round(hz)));
  // A tap on the launcher waterfall holds the channel inside the span so the view does not jerk out from under
  // the finger that just picked something (`hold`). Explicit tuning — the dial, the keypad, the step keys — is
  // free to go anywhere the radio reaches: the view follows it, so you are never walled inside the band you
  // happened to start in.
  if (state.app === null && state.viewLo && hold) {
    const reach = state.rate / 2 - VIEW_GUARD;
    state.freq = Math.max(state.viewLo - reach, Math.min(state.viewLo + reach, state.freq));
  }
  if (state.app === 'audio' || state.app === 'capture') state.radioFreq = state.freq;
  if (generalPurpose() && !silentTune) setDial(state.freq);
  if (!silentTune) { if (state.app === null) launchTapped = true; if (state.app === 'audio') audioPick = false; }
  if (tunesInSpan()) {
    // the channel moves inside the view; only when it leaves the view does the radio follow it
    const prevLo = state.viewLo;
    if (Math.abs(state.freq - state.viewLo) > state.rate / 2 - VIEW_GUARD) state.viewLo = state.freq + (state.app === 'ais' || state.app === 'aprs' ? NARROW_SHIFT : 0);
    // When the LO does move, slide the waterfall history by the same amount so the spectrum that was already
    // painted stays under its true frequency. Only the genuinely new sliver at the leading edge comes up black,
    // instead of the whole picture restarting empty from the top when you step to a station outside the window.
    if (state.viewLo !== prevLo) scope?.shiftSpan((state.viewLo - prevLo) / state.rate);
    if (radio) radio.targetFreqHz = state.viewLo;
    sendOffset(); refreshChannel();
  } else if (radio) radio.targetFreqHz = state.freq;
  refreshReadout();
  qa('[data-bm]').forEach(b => b.classList.toggle('on', bookmarks[Number(b.dataset.bm)]?.hz === state.freq));
}
const VIEW_GUARD = 100_000;
/** The frequency being listened to, wherever you are: HAM keeps its own dial while the radio's LO sits elsewhere. */
const tunedHz = () => state.app === 'ham' ? state.ham.freq : state.freq;
/** The favorite matching what is tuned now, if there is one. */
function favIndex(): number {
  const hz = tunedHz();
  return bookmarks.findIndex(b => Math.abs(b.hz - hz) < 50);
}
/** Star: save where you are and how you are listening, or drop it if it is already saved. */
function toggleFav(): void {
  const i = favIndex();
  if (i >= 0) { bookmarks.splice(i, 1); saveBookmarks(); refreshBookmarks(); refreshFav(); log(`removed ${(tunedHz() / 1e6).toFixed(4)} from favorites`); return; }
  const hz = tunedHz(), h = state.ham;
  const b: Bookmark = {
    name: `${(hz / 1e6).toFixed(4)} ${state.app === 'ham' ? h.mode : state.mode}`,
    hz, mode: state.app === 'ham' ? 'NFM' : state.mode, app: state.app ?? 'audio',
    lna: state.lna, vga: state.vga, amp: state.amp, agc: state.agc, squelch: state.squelch,
  };
  if (state.app === 'ham') b.ham = { mode: h.mode, lo: h.lo, hi: h.hi, squelch: h.squelch, agc: h.agc, nr: h.nr, anf: h.anf, digi: h.digi.mode };
  bookmarks = bookmarks.filter(x => Math.abs(x.hz - hz) >= 50);
  bookmarks.push(b);
  saveBookmarks(); refreshBookmarks(); refreshFav();
  log(`saved ${b.name} to favorites`);
}
function refreshFav(): void {
  const el = q('#fav'); if (!el) return;
  const on = favIndex() >= 0;
  el.classList.toggle('on', on);
  el.textContent = on ? '★' : '☆';
  el.title = on ? 'remove from favorites' : 'save this to favorites';
}
/**
 * Anything that demodulates one channel out of the span can keep the radio still and move the channel instead.
 * That is every receiver except HAM, which has its own tuning with the local oscillator parked off to one side,
 * and the apps that work on the raw samples rather than a channel, where an offset would mean nothing.
 *
 * The point is that picking something already visible on the waterfall should not throw the waterfall sideways
 * and wipe its history. The radio only follows when the channel actually leaves the span.
 */
/**
 * Whether the tuned channel lives inside the sampled span, with the radio's own tuning left where it is.
 *
 * This is about the view, not the demodulator. On the launcher it is always true: the whole point of that
 * screen is a band you can see all of, so picking something in it must move a marker rather than drag the
 * waterfall out from under the finger that just tapped it.
 */
const tunesInSpan = () => state.app !== 'ham' && (state.app === null || state.mode !== 'NONE');
/** The apps whose frequency is the user's own dial, remembered between visits rather than fixed by purpose. */
const generalPurpose = () => state.app === 'audio' || state.app === 'prowl' || state.app === 'capture' || state.app === 'transmit' || !state.app;
/** Tell the plain receiver where its channel sits relative to the span center. */
function sendOffset(): void { worker?.postMessage({ type: 'config', offsetHz: tunesInSpan() ? state.freq - state.viewLo : 0 }); }
/** The tuned channel has been slid out of the sampled span (nothing can be heard until it is back). */
function channelOff(): boolean {
  if (state.app === 'ham') return state.ham.tab !== 'monitor' && Math.abs(state.ham.freq - state.hamLo) > state.rate / 2 - 40_000;
  return tunesInSpan() && Math.abs(state.freq - state.viewLo) > state.rate / 2 - 40_000;
}
/** Show the frequency under the finger while sliding on the waterfall (null = back to the tuned frequency). */
function previewFreq(hz: number | null): void {
  const r = q('.readout'); if (!r) return;
  r.classList.toggle('preview', hz !== null);
  setFreqDisplay(hz ?? state.freq);
}
function setSquelch(db: number): void {
  state.squelch = db;
  worker?.postMessage({ type: 'config', squelch: db });
  qa('[data-sql]').forEach(b => b.classList.toggle('on', Number(b.dataset.sql) === db));
  if (db === 0) { state.sqOpen = true; refreshSquelch(); }
}
function refreshSquelch(): void {
  if (state.app === 'audio') {
    if (state.scanning) setLamp(state.sqOpen && state.squelch > 0 ? 'SCAN · SIGNAL' : 'SCAN', 'amber', true);
    else if (state.squelch > 0 && !state.sqOpen) setLamp('SQUELCHED');
    else setLamp('OPEN', 'ok');
    const r = q('#capr'); if (r) r.textContent = state.squelch ? `SQL ${state.squelch} dB` : 'SQL OFF';
  }
  const el = q('#sq'); if (!el) return;
  el.hidden = state.squelch === 0 && !state.scanning;
  el.classList.toggle('open', state.sqOpen);
  el.textContent = state.scanning ? (state.sqOpen ? 'SCAN · SIGNAL' : 'SCAN') : state.sqOpen ? 'OPEN' : 'SQL';
}
function loadBookmarks(): Bookmark[] {
  try { const v = JSON.parse(localStorage.getItem('mayhem.bookmarks') ?? '[]'); if (Array.isArray(v)) return v.filter(b => typeof b?.hz === 'number'); } catch { /* ignore */ }
  return [];
}
function saveBookmarks(): void { try { localStorage.setItem('mayhem.bookmarks', JSON.stringify(bookmarks)); } catch { /* ignore */ } }
function addBookmark(): void {
  const label = `${(state.freq / 1e6).toFixed(4)} ${state.mode}`;
  const name = (prompt('Bookmark name', label) ?? '').trim();
  if (!name) return;
  bookmarks = bookmarks.filter(b => b.hz !== state.freq || b.mode !== state.mode);
  bookmarks.push({ name, hz: state.freq, mode: state.mode });
  saveBookmarks(); refreshBookmarks();
}
function removeBookmark(i: number): void { bookmarks.splice(i, 1); saveBookmarks(); refreshBookmarks(); }
function goBookmark(b: Bookmark): void { setMode(b.mode); tune(b.hz); }
/** Recall a favorite the way it was heard: the right receiver, its settings, then the frequency. */
function openBookmark(b: Bookmark): void {
  if (b.app && b.app !== state.app) open(b.app);
  if (typeof b.lna === 'number' && typeof b.vga === 'number') { if (b.agc === false) manualGains(b.lna, b.vga, !!b.amp); else setGains(b.lna, b.vga, !!b.amp); }
  if (b.app === 'ham' && b.ham) {
    const h = state.ham;
    h.lo = b.ham.lo; h.hi = b.ham.hi; h.squelch = b.ham.squelch; h.agc = b.ham.agc; h.nr = b.ham.nr; h.anf = b.ham.anf;
    hamSetMode(b.ham.mode);
    hamTune(b.hz);
    refreshHamUi();
    return;
  }
  if (typeof b.squelch === 'number') setSquelch(b.squelch);
  setMode(b.mode); tune(b.hz);
}
/** Scan: hop through the bookmarks, pausing on any channel where the squelch is open (Mayhem's Scanner app, on your list). */
function setScanning(on: boolean): void {
  state.scanning = on && bookmarks.length > 1;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = 0; }
  if (state.scanning) {
    if (state.squelch === 0) setSquelch(12);
    scanIdx = Math.max(0, bookmarks.findIndex(b => b.hz === state.freq));
    scanHopAt = performance.now();
    scanTimer = window.setInterval(() => {
      if (state.app !== 'audio') { setScanning(false); return; }
      const now = performance.now();
      if (state.sqOpen && now - scanHopAt > 250) return;          // busy channel: stay until it goes quiet
      if (now - scanHopAt < 250) return;                          // let the tuner and the floor tracker settle
      scanIdx = (scanIdx + 1) % bookmarks.length;
      goBookmark(bookmarks[scanIdx]); scanHopAt = now; refreshBookmarks();
    }, 100);
  } else if (on) log('scan needs at least two bookmarks — ★ SAVE some first');
  const b = q('#scan'); if (b) b.classList.toggle('on', state.scanning);
  refreshSquelch();
}
function refreshBookmarks(): void {
  const el = q('#bookmarks'); if (!el) return;
  el.innerHTML = bookmarks.map((b, i) => `<button class="chip bm ${b.hz === state.freq ? 'on' : ''}" data-bm="${i}">${esc(b.name)}<i data-bmx="${i}">✕</i></button>`).join('') || '<span class="empty">no bookmarks — tune something and tap ★ SAVE</span>';
  qa<HTMLButtonElement>('[data-bm]', el).forEach(b => b.onclick = (ev) => {
    const i = Number(b.dataset.bm);
    if ((ev.target as HTMLElement).dataset.bmx !== undefined) { removeBookmark(i); return; }
    if (state.scanning) setScanning(false);
    openBookmark(bookmarks[i]); refreshBookmarks();
  });
}
function setMode(m: Mode): void {
  state.mode = m;
  if (tunesInSpan() && m !== 'NONE') state.radioMode = m;
  worker?.postMessage({ type: 'config', mode: m });
  qa('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  if (state.app === 'audio') setFace(m, audioTitle());
  refreshChannel();
  if (m !== 'WFM') { lastRds = null; lastHd = null; }
  drawRds(); drawHd();
}
function setRate(r: number): void {
  // An RTL-SDR tops out at 3.2 Msps and has a hole between 300 and 900 kHz. Clamping to the nearest rate it
  // will accept beats letting the app ask for something the hardware answers with silence.
  if (radio) {
    const ok = nearestRate(radio.limits, r);
    if (ok !== r) { log(`${radio.label}: ${(r / 1e6).toFixed(3)} Msps is out of range — using ${(ok / 1e6).toFixed(3)}`); r = ok; }
  }
  state.rate = r;
  if (radio) radio.targetRateHz = r;
  worker?.postMessage({ type: 'config', rate: r });
  refreshReadout();
  qa('[data-rate]').forEach(b => b.classList.toggle('on', Number(b.dataset.rate) === r));
}
/**
 * Gain the user chose, remembered between apps and between visits. Each app opens with a gain that suits it, but
 * once you have set one by hand that is what every app gets: having to re-do it on every screen was the annoyance.
 * Saved after the board's own scaling, so it is re-applied exactly and never scaled twice.
 */
interface GainPref { lna: number; vga: number; amp: boolean; agc: boolean }
// Kept per board family: a Pro needs roughly 28 dB more VGA than a One for the same level, so one remembered setting
// would leave a Pro flat (One gains sit under 1 ADC count) or a One clipping (Pro gains).
const gainKey = () => (isPro() ? 'mayhem.gain.pro' : 'mayhem.gain');
let gainPref: GainPref | null = loadGains();
let gainPrefKey = 'mayhem.gain';
function currentGainPref(): GainPref | null {
  if (gainKey() !== gainPrefKey) { gainPrefKey = gainKey(); gainPref = loadGains(gainPrefKey); }
  return gainPref;
}
function loadGains(key = 'mayhem.gain'): GainPref | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (v && typeof v.lna === 'number' && typeof v.vga === 'number') return { lna: v.lna, vga: v.vga, amp: !!v.amp, agc: v.agc !== false };
  } catch { /* ignore */ }
  return null;
}
function saveGains(): void {
  gainPrefKey = gainKey();
  gainPref = { lna: state.lna, vga: state.vga, amp: state.amp, agc: state.agc };
  try { localStorage.setItem(gainPrefKey, JSON.stringify(gainPref)); } catch { /* ignore */ }
}
function setGains(lna: number, vga: number, amp: boolean): void {
  state.lna = Math.max(0, Math.min(40, lna)) & ~7; state.vga = Math.max(0, Math.min(62, vga)) & ~1; state.amp = amp;
  radio?.setGain(state.lna, state.vga, state.amp);
  // Say who is driving these. With the automatic gain on they are an output, not a setting, and a value typed in
  // by hand lasts until the next second — which is exactly what it looks like when they spring back to maximum.
  for (const a of qa('#amp')) { a.textContent = state.amp ? 'AMP +14' : 'AMP OFF'; a.classList.toggle('on', state.amp); }
  refreshAgcChip();
  refreshGainUi();
}
/**
 * Show the gain controls the connected radio actually has.
 *
 * A HackRF has an amplifier, an LNA and a VGA. A dongle has one tuner gain. Leaving all four on screen and
 * quietly ignoring two of them would mean a control that moves and does nothing, which is worse than no
 * control at all.
 */
function refreshGainUi(): void {
  const rtl = radio?.kind === 'rtlsdr';
  for (const l of qa('#lna')) { const st = l.closest('.stepper') as HTMLElement | null; if (st) st.hidden = rtl; }
  for (const amp of qa('#amp')) amp.hidden = rtl;
  // Bias tee is an RTL-SDR Blog feature; it takes the slot the (hidden) amp button leaves on a dongle.
  for (const biast of qa('#biast')) { biast.hidden = !rtl; biast.classList.toggle('on', state.biast); biast.textContent = state.biast ? 'BIAS-T ON' : 'BIAS-T'; }
  for (const cap of qa('#gain-cap')) cap.textContent = rtl ? 'GAIN · AGC / TUNER · 0–48.8 dB' : 'GAIN';
}

function refreshAgcChip(): void {
  for (const b of qa('#agc')) { b.textContent = 'AGC'; b.classList.toggle('on', state.agc); b.title = state.agc ? 'The automatic gain sets the gain' : 'The gain is yours; tap to hand it to the AGC'; }
  for (const l of qa('#lna')) { l.textContent = `LNA ${state.lna}${state.agc ? ' AUTO' : ''}`; l.classList.toggle('auto', state.agc); }
  for (const v of qa('#vga')) { v.textContent = `${radio?.kind === 'rtlsdr' ? 'GAIN' : 'VGA'} ${state.vga}${state.agc ? ' AUTO' : ''}`; v.classList.toggle('auto', state.agc); }
}
function setAgc(on: boolean): void { state.agc = on; refreshAgcChip(); if (on) agcLast = 0; }
/** The AGC and AMP chips are the user speaking, so what they leave behind is remembered too. */
const userAgc = (on: boolean) => { setAgc(on); saveGains(); };
/** Manual LNA / VGA taps switch the AGC off so the user's setting sticks. */
const manualGains = (lna: number, vga: number, amp: boolean) => {
  if (state.agc) log('gain set by hand, so the automatic gain is off — tap AGC to hand it back');
  setAgc(false); setGains(lna, vga, amp); saveGains();
};
let agcLast = 0, agcSaidMax = 0;
/**
 * Automatic gain: keep the ADC level (iqRMS over the once/sec health sample) between AGC_LO and AGC_HI counts.
 * That is where the HackRF's 8-bit converter has both headroom and resolution — under ~2 counts the FFT is
 * quantisation mush, over ~40 it clips. Steps VGA 2 dB at a time (8 dB when far off), then falls back to the LNA.
 */
const AGC_LO = 7, AGC_HI = 22;
/**
 * The AGC window scales with the span. iqRMS is the total power across the whole sampled width, so a 20 MHz
 * launcher view holds several times the RMS of a 2 MHz channel at the SAME per-signal level. Targeting the fixed
 * 7-22 counts on a wide span makes the AGC read it as "too hot" and crank the gain down until real signals sink
 * into the ADC noise — the launcher opening on static. Let a wider span sit proportionally hotter (per-Hz level
 * held constant), capped short of the 8-bit converter's ~40-count clip.
 */
function agcTargets(): [number, number] {
  const scale = Math.min(3.2, Math.sqrt(state.rate / RX_RATE));
  return [Math.min(24, AGC_LO * scale), Math.min(34, AGC_HI * scale)];
}
/**
 * The pager's level over the last [PAGER_HOLD_MS]. Pager transmitters key up for a burst and drop again, so the
 * one-second level swings by tens of dB; stepping the gain on each second pumped it (every step shifts the whole
 * waterfall, and a step up just before the next key-up clips the front end across the span). The pager steps down
 * at once when a burst is too strong, and up only when nothing in the hold has come near the target.
 */
const PAGER_HOLD_MS = 12_000;
let pagerLevels: [number, number][] = [], pagerDown = 0;
function agcStep(rms: number): void {
  if (!state.agc || !radio || tx.active || state.app === 'transmit' || !Number.isFinite(rms)) return;
  const now = performance.now(); if (now - agcLast < 900) return; agcLast = now;
  const [lo, hi] = agcTargets();
  if (state.app === 'pager') {
    pagerLevels.push([now, rms]); pagerLevels = pagerLevels.filter(([t]) => now - t < PAGER_HOLD_MS);
    const was = `LNA ${state.lna} / ${radio.kind === 'rtlsdr' ? 'GAIN' : 'VGA'} ${state.vga}`;
    if (rms > hi) {
      pagerDown = now;
      if (state.vga > 0) setGains(state.lna, state.vga - (rms > hi * 2 ? 8 : 2), state.amp);
      else if (state.lna > 0) setGains(state.lna - 8, state.vga, state.amp);
    } else if (now - pagerDown > PAGER_HOLD_MS && pagerLevels.length >= 10 && Math.max(...pagerLevels.map(([, r]) => r)) < lo) {
      if (state.vga < 62) setGains(state.lna, state.vga + 2, state.amp);
      else if (state.lna < 40) setGains(state.lna + 8, state.vga, state.amp);
      pagerLevels = [];
    }
    const now2 = `LNA ${state.lna} / ${radio.kind === 'rtlsdr' ? 'GAIN' : 'VGA'} ${state.vga}`;
    if (now2 !== was) log(`AGC: ${was} → ${now2} (level ${rms.toFixed(1)} counts)`);
    return;
  }
  if (rms < lo) {
    if (state.vga < 62) setGains(state.lna, state.vga + (rms < 2 ? 8 : 2), state.amp);
    else if (state.lna < 40) setGains(state.lna + 8, state.vga, state.amp);
    // Only warn for a continuous signal. The pulse/burst apps (ADS-B, TPMS, sub-GHz, BLE, ERT…) run in NONE mode,
    // where a low average iqRMS is normal between bursts even while they decode fine — ADS-B tracks aircraft at
    // ~1.4 counts. Crying "check the antenna" there is a false alarm, so hold it for the voice modes.
    else if (state.mode !== 'NONE' && now - agcSaidMax > 20_000) { agcSaidMax = now; log(`AGC is at maximum and the level is still ${rms.toFixed(1)} counts — check the antenna, or turn AGC off if you want to set the gain yourself`); }
  } else if (rms > hi) {
    // too hot: step down by how far over it is (up to 16 dB at once), so a radio that opens overloaded settles in a step or two
    if (state.vga > 0) setGains(state.lna, state.vga - Math.min(16, Math.max(2, Math.trunc((20 * Math.log10(rms / hi) + 2) / 2) * 2)), state.amp);
    else if (state.lna > 0) setGains(state.lna - 8, state.vga, state.amp);
  }
}
const isPro = () => /pro/i.test(state.board);
/**
 * Per-app gain presets are written for a HackRF One. Bench-measured on a HackRF Pro (Mayhem n_260903): the same
 * settings leave the ADC under one count (iqRMS 0.2, the waterfall shows nothing), and the Pro needs roughly 28 dB
 * more VGA for the same level — LNA 40 / VGA 52 lands the noise floor near 10 counts with no DC spur (VGA ≥ 56
 * starts one). LNA steps count for less on the Pro, so it is pinned at 40 and the difference goes into the VGA.
 */
function boardGains(lna: number, vga: number, amp: boolean): [number, number, boolean] {
  if (!isPro()) return [lna, vga, amp];
  return [40, Math.min(amp ? 56 : 62, vga + 28), amp];
}
function configure(mode: Mode, freq: number, rate: number, lna: number, vga: number, amp: boolean, app: string, extra: Record<string, unknown> = {}): void {
  worker?.postMessage({ type: 'app', app: 'none' });
  state.mode = mode; state.rate = rate; state.freq = freq; state.viewLo = freq;
  if (radio) {
    // Say it plainly at the moment the app opens. A dongle that cannot reach 2.4 GHz will show a waterfall of
    // noise on the Bluetooth screen and look broken; it is not, it just cannot go there.
    const no = whyNot(radio.limits, freq, rate);
    if (no) { log(`${radio.label}: this app ${no}.`); setStatus(`${radio.label} cannot do this one — ${no}`, true); }
    rate = nearestRate(radio.limits, rate);
    state.rate = rate;
    radio.targetFreqHz = freq; radio.targetRateHz = rate;
  }
  if (!radio || radio.kind === 'hackrf') { [lna, vga, amp] = boardGains(lna, vga, amp); state.gainsScaled = isPro(); }
  // A gain set by hand outranks the app's own default, on every app, until it is changed again. Before there
  // is one, no app starts below 32 on either stage; each app's own amplifier choice still stands.
  const pref = currentGainPref();
  if (pref) { lna = pref.lna; vga = pref.vga; amp = pref.amp; state.agc = pref.agc; }
  // Before the user has touched gain: floor both stages at 32 and, on a HackRF, run the front-end amp on. It is a
  // receive-safe preamp and AGC (on by default) trims the stages if a strong signal would clip, so the whole app
  // set starts sensitive; the moment they tap AMP off it is saved and honoured everywhere. Not on an RTL-SDR,
  // whose "amp" can be a bias-tee (DC out the antenna).
  else { lna = Math.max(lna, 32); vga = Math.max(vga, 32); if (radio && radio.kind === 'hackrf') amp = true; }
  setGains(lna, vga, amp);
  worker?.postMessage({ type: 'config', mode, rate, offsetHz: 0 });
  worker?.postMessage({ type: 'app', app, ...extra });
}
/** A sweep step is only as slow as the retune. Both radios put the frequency they have actually applied in
 *  every status line, and the HackRF driver sends one the moment a retune lands, so a status naming the
 *  sweep's target tells the worker the reads still in flight are the last stale ones - it can stop discarding
 *  on a generous fixed timer and count those down instead. */
function ackTune(s: string): void {
  if (!radio || (state.app !== 'lookingglass' && state.app !== 'search')) return;
  const m = /(\d+\.\d+) MHz/.exec(s); if (!m) return;
  if (Math.abs(Number(m[1]) * 1e6 - radio.targetFreqHz) < 600) worker?.postMessage({ type: 'tuned' });
}
function startSweep(start: number, end: number): void {
  // The step size is worked out from the slice width, so a slice the radio cannot actually sample would leave
  // unswept gaps between steps rather than merely running slower. Pull it to something real first. A HackRF
  // does every slice on offer, so this never fires on one.
  if (radio) {
    const ok = nearestRate(radio.limits, state.sweepRate);
    if (ok !== state.sweepRate) {
      log(`${radio.label}: ${state.sweepRate / 1e6} MHz slices are out of range — sweeping in ${(ok / 1e6).toFixed(2)} MHz`);
      state.sweepRate = ok;
    }
  }
  const steps = Math.max(1, Math.ceil((end - start) / (state.sweepRate * 204 / 256)));
  state.sweep = { start, end, steps };
  lastSweepRow = new Float32Array(0); sweepLiveRow = new Float32Array(0);
  configure('NONE', start + state.sweepRate / 2, state.sweepRate, 24, 24, false, 'sweep', { start, end, slice: state.sweepRate });
  refreshSweepCard(0, 0);
  sweepScope?.clear();
  qa('[data-range]').forEach(b => b.classList.toggle('on', Number(b.dataset.range) === start));
}
const sweepMhz = (hz: number) => hz >= 1e9 ? `${+(hz / 1e9).toFixed(2)}G` : `${+(hz / 1e6).toFixed(1)}`;
/** The range being swept, where the digits sit on the other apps' cards. */
function sweepTitle(): string {
  const s = state.sweep; if (!s) return 'NO SWEEP';
  return `${sweepMhz(s.start)}–${sweepMhz(s.end)}${s.end < 1e9 ? ' MHz' : ''}`;
}
/** A range as a tile: the span large, its name under it. */
function rangeTile(l: string, a: number, b: number): string {
  const sub = l.replace(/[\d.]+-[\d.]+\s*G?(Hz)?/, '').replace(/^[\d.]+G\s*/, '').trim() || (b >= 1e9 ? 'GHz' : 'MHz');
  return `<button class="tl" data-range="${a}" data-end="${b}"><b>${sweepMhz(a)}–${sweepMhz(b)}</b><small>${sub}</small></button>`;
}
/** The sweeps' card: the Android app's, with the range in place of the digits and the pass on the meter. */
const sweepCardHtml = () => `<div class="face sweep"><div class="fhead"><span id="ftag" class="ftag"></span><span id="ftitle" class="ftitle"></span><span id="lamp" class="lamp"><i></i><b></b></span></div><div id="sweep-title" class="srange">${sweepTitle()}</div><div id="leds" class="leds">${'<i></i>'.repeat(32)}<s hidden></s></div><div id="lscale" class="lscale"></div><div class="fcap"><b id="capl">PASS —</b><span id="capr"></span></div></div>`;
function refreshSweepCard(progress: number, sweeps: number): void {
  const s = state.sweep, t = q('#sweep-title');
  if (t && !t.classList.contains('preview')) t.textContent = sweepTitle();
  if (!s) return;
  setMeter(s.steps ? progress / s.steps : 0, `SLICE ${progress}/${s.steps} · PASS ${sweeps}`, null, [[0, sweepMhz(s.start)], [1, sweepMhz(s.end)]]);
  setLamp(state.connected ? 'SWEEPING' : 'NO RADIO', state.connected ? 'amber' : '', state.connected);
}
function listen(hz: number, mode: Mode): void {
  state.radioFreq = Math.round(hz / 10_000) * 10_000; state.radioMode = mode;
  open('audio');
}

// ---- apps -----------------------------------------------------------------------------------------------------
/**
 * Where the front door can point.
 *
 * Each of these fits in one shot of a HackRF at its widest, so the whole band is on screen at once and the
 * frequency picker has somewhere real to pick from - no sweeping, no stitching, nothing that takes a minute to
 * come round again. Broadcast FM leads because twenty megahertz covers 88 to 108 exactly and the band is never
 * empty, so the first thing anyone sees is a screen full of signal rather than a flat line.
 *
 * A dongle sees a narrower window into the same places, which is the honest thing for it to do.
 */
interface LaunchBand { id: string; name: string; lo: number; hi: number; what: string; center?: number; mode: Mode }
const LAUNCH_BANDS: LaunchBand[] = [
  { id: 'fm', name: 'FM', lo: 88_000_000, hi: 108_000_000, what: 'broadcast radio', mode: 'WFM' },
  { id: 'air', name: 'AIR', lo: 118_000_000, hi: 137_000_000, what: 'airband AM', mode: 'AM' },
  { id: 'vhf', name: 'VHF', lo: 144_000_000, hi: 163_000_000, what: 'two meters, marine, weather', mode: 'NFM' },
  { id: 'ism3', name: '315', lo: 314_000_000, hi: 316_000_000, what: 'American remotes and sensors', mode: 'NONE' },
  { id: 'uhf', name: 'UHF', lo: 430_000_000, hi: 450_000_000, what: 'seventy centimeters', mode: 'NFM' },
  { id: 'ism4', name: '433', lo: 433_000_000, hi: 435_000_000, what: 'European remotes and sensors', mode: 'NONE' },
  { id: 'ism9', name: '915', lo: 902_000_000, hi: 928_000_000, what: 'meters and telemetry', mode: 'NONE' },
  // Nothing at 1090 is worth hearing, and the digital bands would only put a wall of noise through the
  // speaker. They still tune inside the span like everything else; there is just no channel to frame.
  { id: 'adsb', name: '1090', lo: 1_089_000_000, hi: 1_091_000_000, what: 'aircraft', mode: 'NONE' },
];

/**
 * Where the launcher is pointing and how wide.
 *
 * The span is the band's own width, held to what the radio can actually deliver in one shot. A two megahertz
 * slice under a big tuning dial reads as a receiver that has lost its audio; a whole band says what the screen
 * is for, which is to find something and then pick the app to listen with.
 */
/** The band chips (FM / AIR / VHF / 315 / UHF / 433 / 915 / 1090), shared by the launcher and the receiver apps. */
/** The bands as tiles, each with its range, for a receiver's tile row (the launcher keeps its chips). */
function bandTilesHtml(): string {
  return `<div class="tiles">${LAUNCH_BANDS.map(b => `<button class="tl" data-lband="${b.id}"><b>${b.name}</b><small>${(b.lo / 1e6).toFixed(0)}–${(b.hi / 1e6).toFixed(0)}</small></button>`).join('')}</div>`;
}
/** What the tuned frequency is, in a few words (the Android app's band title). */
function bandTitle(hz: number): string {
  if (hz >= 87.5e6 && hz <= 108e6) return 'FM BROADCAST';
  if (hz > 108e6 && hz < 118e6) return 'AIR NAVIGATION';
  if (hz >= 118e6 && hz <= 137e6) return 'AIRBAND';
  if (hz >= 144e6 && hz <= 146e6) return '2 M AMATEUR';
  if (hz >= 156e6 && hz <= 162.025e6) return 'MARINE VHF';
  if (hz >= 162.4e6 && hz <= 162.55e6) return 'NOAA WEATHER';
  if (hz >= 433.05e6 && hz <= 434.79e6) return 'ISM 433';
  if (hz >= 430e6 && hz <= 440e6) return '70 CM AMATEUR';
  if (hz >= 902e6 && hz <= 928e6) return 'ISM 915';
  if (hz >= 1089e6 && hz <= 1091e6) return 'ADS-B';
  return LAUNCH_BANDS.find(b => hz >= b.lo && hz <= b.hi)?.what.toUpperCase() ?? 'GENERAL COVERAGE';
}
/**
 * How far the tuned channel stands over the noise, in dB: the mean power of the spectrum bins inside the channel
 * against the median bin of the whole span. (The squelch's own floor rises to meet a carrier that stays up, so it
 * can't drive a meter; the median doesn't.) The spectrum arrives scaled 0..1 across [rangeDb] for drawing, so it is
 * put back in dB first, as the Android app does.
 */
function channelOverNoise(bins: Float32Array, rangeDb: number): number {
  const n = bins.length; if (n < 16 || state.rate <= 0) return 0;
  const half: Record<string, [number, number]> = { WFM: [-100e3, 100e3], NFM: [-6250, 6250], AM: [-5000, 5000], USB: [0, 3000], LSB: [-3000, 0] };
  const [a, b] = half[state.mode] ?? [0, 0]; if (a === b) return 0;
  const off = tunedHz() - spanCenter();
  const i0 = Math.max(0, Math.min(n - 1, Math.floor((0.5 + (off + a) / state.rate) * n)));
  const i1 = Math.max(i0, Math.min(n - 1, Math.floor((0.5 + (off + b) / state.rate) * n)));
  let sum = 0; for (let i = i0; i <= i1; i++) sum += Math.pow(10, bins[i] * rangeDb / 10);
  const sorted = Float32Array.from(bins).sort();
  return Math.max(0, 10 * Math.log10(sum / (i1 - i0 + 1)) - sorted[n >> 1] * rangeDb);
}
function bandChipsHtml(): string {
  return LAUNCH_BANDS.map(b => `<button class="chip" data-lband="${b.id}" title="${esc(b.name)} · ${esc(b.what)} · ${(b.lo / 1e6).toFixed(0)}–${(b.hi / 1e6).toFixed(0)} MHz">${b.name}</button>`).join('');
}
/** A band chip was tapped: on the launcher it recenters the browse view; in a receiver it jumps the dial to the band. */
function gotoBand(id: string): void {
  const b = LAUNCH_BANDS.find(x => x.id === id); if (!b) return;
  if (state.app === null) { state.launchBand = id; applyLauncherView(); }
  else { setMode(b.mode === 'NONE' ? 'NFM' : b.mode); tune(Math.round((b.lo + b.hi) / 2)); }   // NONE bands (ISM/ADS-B) have no voice mode; NFM is the sane default to browse them
  highlightBands();
}
/** Light the chip for where we are: the picked band on the launcher, the band holding the dial in a receiver. */
function highlightBands(): void {
  const hz = tunedHz();
  const cur = state.app === null ? state.launchBand : (LAUNCH_BANDS.find(x => hz >= x.lo && hz <= x.hi)?.id ?? '');
  qa<HTMLElement>('[data-lband]').forEach(el => el.classList.toggle('on', el.dataset.lband === cur));
}
function launcherView(): { center: number; rate: number; mode: Mode } {
  const b = LAUNCH_BANDS.find(x => x.id === state.launchBand) ?? LAUNCH_BANDS[0];
  // With nothing connected there is no point asking for a span nothing will fill.
  const widest = radio ? cleanWidest(radio.limits) : RX_RATE;
  // The same ceiling the HAM screen uses, and for the same reason: past it the front end and the USB link stop
  // keeping up, and a phone gives up sooner than a desktop. A launcher that stutters is worse than a narrow one.
  const cap = RX_RATES[Math.min(maxRateIdx(), RX_RATES.length - 1)];
  // Center the VIEW on the band's midpoint so the span sits over the band itself, not off to one side — an FM
  // view centred on 93.1 spent its left third below 88 (empty) and cut off 103-108. The marker then lands on the
  // strongest signal (see the auto-pick), so we no longer need a "recognizable station" as the centre.
  const rate = Math.max(RX_RATE, Math.min(widest, cap, b.hi - b.lo));
  return { center: Math.round((b.lo + b.hi) / 2), rate, mode: b.mode };
}

/** Re-point the launcher, for when the band changes or a radio arrives that can show more of it. */
function applyLauncherView(): void {
  if (state.app) return;
  launchPicked = false; launchTapped = false; pickArm();
  const v = launcherView();
  configure(v.mode, v.center, v.rate, 24, 24, false, 'none');
  // The band's midpoint is where the launcher LOOKS, not a choice the user made: it must never overwrite the
  // dial the receiver apps share, or Audio would reopen on a band centre instead of where you left it.
  refreshReadout();
  refreshChannel();
  sendOffset();
  scope?.setLabels(centredLabels(state.freq, state.rate));
}

const ACARS_SPAN_HZ = 130_800_000;
/** AIS and APRS: how far above the channel the radio sits, clear of the DC spike at the center of the span. */
const NARROW_SHIFT = 250_000;
/** Whether the radio can sample at `hz` (with no radio yet, a HackRF is assumed: it takes every rate on offer). */
const radioCan = (hz: number) => !radio || canSample(radio.limits, hz);
/** Put the radio NARROW_SHIFT above the channel, as Mayhem keeps its channels off the DC spike; the engine mixes the
 *  channel back down through the offset. */
function narrowShift(): void { state.viewLo = state.freq + NARROW_SHIFT; if (radio) radio.targetFreqHz = state.viewLo; sendOffset(); }
function open(app: AppId | null): void {
  if (app === 'settings') { openSettings(); return; }
  if (state.capturing) { worker?.postMessage({ type: 'capture', cmd: 'stop' }); state.capturing = false; }
  if (state.scanning && app !== 'audio') setScanning(false);
  if (state.prowl.on && app !== 'prowl') prowlStop();       // the hunt owns the receiver; anything else takes it back
  const prev = state.app;
  // the dial follows you between the general-purpose apps; the ones tuned to a fixed purpose keep their frequency
  const dial = state.dial || state.radioFreq;
  // HAM keeps its own last frequency. It takes the shared dial only when you arrive FROM THE LAUNCHER, where a
  // tap is an explicit "go here"; coming from Audio it must not be dropped onto a broadcast station.
  if (state.dial && app === 'ham' && prev === null) state.ham.freq = state.dial;
  state.app = app;
  ensureWorker();
  switch (app) {
    // The front door is a spectrum browser, not a receiver: no demodulator, and the widest view the radio can
    // give in one shot so that picking a frequency here means choosing where to go next. NONE is what makes a
    // tap retune the radio rather than slide a channel about inside the span.
    // No gain UI here, so ride AGC so the wide band isn't a wall of static (the HackRF amp default is handled in
    // configure, and stays off if the user has turned it off).
    case null: { const v = launcherView(); configure(v.mode, v.center, v.rate, 32, 32, false, 'none'); setAgc(true); launchPicked = false; launchTapped = false; pickArm(); break; }
    case 'ham': hamOpen(); return;
    // Arriving from the launcher is "take me to what I am looking at": open on the station the launcher has
    // (its auto-pick of the strongest, or one you tapped), state.freq. From anywhere else, keep the shared dial —
    // the launcher's auto-pick still never writes that dial, so a plain app-to-app hop is never thrown onto it.
    // Unless you picked something on the launcher, Audio lands on the band's strongest station: the launcher's own
    // pick if it has landed, the last one it found in this band if not, and failing both its own pick once the
    // first signals arrive. Never the band's midpoint, and never wherever ADS-B or AIS last left the radio.
    case 'audio': {
      let f = prev === null ? state.freq : dial;
      audioPick = false;
      if (prev === null && !launchTapped && !launchPicked) {
        const known = bandBest.get(state.launchBand);
        if (known) f = known; else { audioPick = true; pick.viewed = false; pickArm(); }
      }
      configure(state.radioMode, f, RX_RATE, 24, 24, false, 'none');
      break;
    }
    case 'prowl': configure('NFM', state.prowl.target ? state.freq : dial, Math.max(RX_RATE, state.rate), 24, 24, false, 'none'); break;
    case 'adsb': configure('NONE', 1_090_000_000, 2e6, 32, 32, true, 'adsb'); requestGeo(); break;
    case 'sat': satAppOpen(); return;
    case 'ais': configure('NFM', 161_975_000, 2e6, 32, 32, false, 'ais'); narrowShift(); requestGeo(); break;
    case 'aprs': configure('NFM', 144_390_000, 2e6, 24, 24, false, 'aprs'); narrowShift(); requestGeo(); break;
    case 'pager':
      // MULTI where the radio can take 3.84 Msps: the whole US pager band (929.0-932.0 MHz) from its middle,
      // instead of half of it at 2 Msps
      if (state.pagerMulti) { if (radioCan(3_840_000)) configure('NONE', 930_500_000, 3_840_000, 32, 40, true, 'pagerhunt'); else if (radioCan(3_200_000)) configure('NONE', 930_200_000, 3_200_000, 32, 40, true, 'pagerhunt'); else configure('NONE', 929_612_500, 2e6, 32, 40, true, 'pagerhunt'); }
      else { configure('NFM', 929_612_500, 2e6, 32, 32, false, 'pager'); worker?.postMessage({ type: 'pager', which: state.pager }); }
      break;
    // Meters: as wide as the radio goes (19.2 Msps on a HackRF hears 118 hopping channels and about six times the
    // meters of Mayhem's 4.19 Msps ERT span), else Mayhem's ERT rate, else 2 Msps; centered where the ERT meters sit
    case 'ert': configure('NONE', 911_600_000, radioCan(METERS_WIDE) ? METERS_WIDE : radioCan(METERS_RATE) ? METERS_RATE : 2e6, 32, 40, true, 'ert'); break;
    case 'lora': loraOpen(); break;
    case 'btle': configure('NONE', btleChannelFreq(state.btleCh), 2e6, 32, 40, true, 'btle'); worker?.postMessage({ type: 'btleChannel', ch: state.btleCh }); break;
    case 'tpms': configure('NONE', 315_000_000, 2e6, 32, 40, true, 'tpms'); break;
    // The span is centred on 130.8 MHz: every US ACARS channel (130.025-131.550) is inside it and decoded at once,
    // none of them on the radio's DC spike; 131.550 is the one heard.
    case 'acars': configure('AM', 131_550_000, 2e6, 32, 32, false, 'acars'); state.viewLo = ACARS_SPAN_HZ; if (radio) radio.targetFreqHz = state.viewLo; sendOffset(); break;
    case 'trains': trainsTune(); if (trainsUi.auto) trainsCycle(); break;
    case 'subghz': configure('NONE', 433_920_000, 2e6, 32, 40, true, 'subghz'); worker?.postMessage({ type: 'ismFamilies', ...state.ism }); break;
    case 'devices':
      // Always open on 433.92, whatever the last visit left behind. The band is remembered while the app is
      // up, and the hop moves it along on its own, so without this a session that wandered to 915 would come
      // back there — when what is wanted on opening is the band that carries most of the protocol set.
      state.r433.band = 0;
      configure('NONE', R433_BANDS[0][1], 2e6, 32, 40, true, 'r433');
      // The worker is normally created on connect; ask for it here so the protocol list is available
      // whether or not a radio is plugged in.
      ensureWorker().postMessage({ type: 'r433', cmd: 'list' });
      worker?.postMessage({ type: 'r433', cmd: 'span', hz: state.r433.span }); break;
    case 'lookingglass': render(app); startSweep(88e6, 108e6); return;
    case 'search': render(app); startSweep(400e6, 470e6); return;
    case 'capture': configure('NONE', dial, RX_RATE, 24, 24, false, 'capture'); worker?.postMessage({ type: 'capture', cmd: 'list' }); break;
    case 'transmit': configure('NONE', dial, RX_RATE, 24, 24, false, 'none'); break;
    case 'troll': configure('NONE', dial, RX_RATE, 24, 24, false, 'none'); break;
  }
  render(app);
  // SAME weather-alert decoding belongs to the audio app (NOAA weather radio); scope it so no other NFM app pays for it.
  worker?.postMessage({ type: 'same', on: app === 'audio' });
}
function requestGeo(): void {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(p => { state.home = { lat: p.coords.latitude, lon: p.coords.longitude }; geo?.setHome(state.home); worker?.postMessage({ type: 'geo', lat: p.coords.latitude, lon: p.coords.longitude }); log(`GPS reference ${p.coords.latitude.toFixed(3)},${p.coords.longitude.toFixed(3)} for single-frame CPR`); }, () => log('no GPS fix — ADS-B positions need even+odd frame pairs'), { maximumAge: 600_000, timeout: 8000 });
}


// ---- prowl ----------------------------------------------------------------------------------------------------
/**
 * Hunting live voice. This is not the bookmark scanner in the Audio app: there is no list. It watches whatever the
 * receiver can see, lands on anything new that might be somebody talking, checks that it really is, listens until
 * the conversation stops, and moves on. Broadcast stations and permanent carriers are what it works hardest to
 * avoid, because they are strong, they are always there, and they would otherwise capture it forever.
 */
interface HuntRange { lo: number; hi: number; mode: Mode; name: string }
const HUNT: HuntRange[] = [
  { lo: 118e6, hi: 137e6, mode: 'AM', name: 'airband' },
  { lo: 144e6, hi: 148e6, mode: 'NFM', name: '2 m ham' },
  { lo: 150e6, hi: 174e6, mode: 'NFM', name: 'VHF business' },
  { lo: 420e6, hi: 470e6, mode: 'NFM', name: 'UHF' },
  { lo: 851e6, hi: 869e6, mode: 'NFM', name: '800 public safety' },
];
interface ProwlTrack { hz: number; first: number; last: number; best: number; hits: number; skipUntil: number; why: string }
interface ProwlHit { at: number; hz: number; mode: Mode; cls: string; secs: number; score: number; db: number; band: string; kept: boolean; why: string }
interface ProwlTarget { hz: number; bw: number; cls: string; at: number; lastLive: number; lastSeen: number; judged: boolean; peak: number; band: string }

// The quiet timeout has to outlast the test, or a channel gets dropped before it can be judged and the log
// fills with things that were never actually listened to.
const PROWL_HANG = 3500;        // quiet for this long and the over is finished
const PROWL_TEST = 2400;        // listen this long before deciding it really is speech
const PROWL_SETTLE = 1500;      // a signal must hold this long before it is worth stopping for
const PROWL_IDLE = 25_000;      // an empty span for this long before moving, and only when sweeping is on
const PROWL_MAX = 180_000;      // never sit on one channel longer than this
const PROWL_SKIP = 240_000;     // how long a rejected channel is left alone
const PROWL_CONST = 45_000;     // up this long without a break: a link or a beacon, not a conversation
const PROWL_VOICE = 0.45;       // speech score needed to stay

let prowlTimer = 0;
const mhz = (hz: number) => (hz / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');

function prowlWindows(): { center: number; mode: Mode; name: string }[] {
  const span = Math.max(1e6, state.rate - 400_000);        // keep signals away from the edges of the span
  const out: { center: number; mode: Mode; name: string }[] = [];
  for (const h of HUNT) {
    const n = Math.max(1, Math.ceil((h.hi - h.lo) / span)), step = (h.hi - h.lo) / n;
    for (let k = 0; k < n; k++) out.push({ center: Math.round(h.lo + step * (k + 0.5)), mode: h.mode, name: h.name });
  }
  return out;
}
/**
 * Could this be a voice channel? The rule of thumb is that anything you can pick out on the waterfall with your
 * eyes should get a try, so this only refuses what is definitely not a conversation: the broadcast band, anything
 * far too wide to be a voice channel, and anything down in the noise.
 */
function prowlWorthy(s: SeenSignal): boolean {
  if (s.hz > 87.4e6 && s.hz < 108.1e6) return false;       // FM broadcast: always there, never what we are after
  if (s.bw > 60_000) return false;                         // a broadcast carrier or a sweep, not a channel
  if (s.snr < 10) return false;                            // if it is visible on the waterfall it clears this
  if (s.cls === 'WFM' || s.cls === 'WIDE') return false;
  return true;
}
const prowlKey = (hz: number) => Math.round(hz / 5000);
function prowlSkip(hz: number, why: string, now: number, forMs = PROWL_SKIP): void {
  const t = state.prowl.tracks.get(prowlKey(hz));
  if (t) { t.skipUntil = now + forMs; t.why = why; }
}
function prowlNote(line: string): void { state.prowl.note = line; const el = q('#prowl-note'); if (el) el.textContent = line; }

function prowlTick(): void {
  // A hunt that dies quietly looks exactly like a hunt that has found nothing, so failures are shown, not swallowed.
  try { prowlStep(); } catch (e) { prowlNote(`hunt stopped: ${(e as Error).message}`); prowlStop(); }
}
function prowlStep(): void {
  const p = state.prowl;
  if (!p.on) return;
  const now = performance.now();
  for (const s of lastSignals) {
    if (!prowlWorthy(s)) continue;
    const key = prowlKey(s.hz);
    let t = p.tracks.get(key);
    // A signal that comes and goes starts counting again: a peak that flickers for one frame is noise, and
    // stopping on those is what filled the list with nothing.
    if (!t || now - t.last > 1500) t = { hz: s.hz, first: now, last: now, best: s.snr, hits: 0, skipUntil: t ? t.skipUntil : 0, why: t ? t.why : '' };
    t.last = now; t.hz = s.hz; t.hits++; if (s.snr > t.best) t.best = s.snr;
    if (now - t.first > PROWL_CONST && now > t.skipUntil) {
      t.skipUntil = now + PROWL_SKIP; t.why = 'always on';
      if (!p.target || p.target.hz !== t.hz) prowlNote(`${mhz(t.hz)} has been up ${Math.round((now - t.first) / 1000)}s without a break, leaving it`);
    }
    p.tracks.set(key, t);
  }
  if (p.tracks.size > 300) for (const [k, t] of p.tracks) if (now - t.last > 120_000 && now > t.skipUntil) p.tracks.delete(k);

  p.seen = 0; p.ready = 0;
  for (const tr of p.tracks.values()) {
    if (now - tr.last > 800) continue;
    p.seen++;
    if (now >= tr.skipUntil) p.ready++;
  }
  if (p.target) { prowlHold(now); return; }
  const pick = prowlPick(now);
  if (pick) { prowlLand(pick, now); return; }
  // Working the span it is on. Wandering off it is opt-in, because the thing you can see is usually right here.
  if (p.sweep && now - p.movedAt > PROWL_IDLE) { prowlMove(now); return; }
  prowlNote(p.seen ? `${p.seen} signals in view, ${p.ready} still worth a try` : 'nothing in the span right now');
  refreshProwl();
}

function prowlPick(now: number): ProwlTrack | null {
  let best: ProwlTrack | null = null, bestVal = -1e9;
  for (const t of state.prowl.tracks.values()) {
    if (now < t.skipUntil) continue;                       // still serving a skip
    if (now - t.last > 800) continue;                      // must be on the air right now
    if (now - t.first < PROWL_SETTLE || t.hits < 5) continue;   // and must have held, not just flickered
    const val = t.best + (now - t.first < 20_000 ? 12 : 0); // something that just started beats something lingering
    if (val > bestVal) { bestVal = val; best = t; }
  }
  return best;
}

function prowlLand(t: ProwlTrack, now: number): void {
  const p = state.prowl;
  const sig = lastSignals.find(s => prowlKey(s.hz) === prowlKey(t.hz));
  const mode: Mode = t.hz > 117e6 && t.hz < 138e6 ? 'AM' : 'NFM';
  if (state.mode !== mode) setMode(mode);
  tune(t.hz);
  p.target = { hz: t.hz, bw: sig ? sig.bw : 12_500, cls: sig ? sig.cls : '', at: now, lastLive: now, lastSeen: now, judged: false, peak: t.best, band: p.band };
  p.score = 0; p.best = 0; p.parts = '';
  worker?.postMessage({ type: 'config', voice: true });
  prowlNote(`${mhz(t.hz)} ${mode} at ${Math.round(t.best)} dB, listening`);
  refreshProwl();
}

function prowlHold(now: number): void {
  const p = state.prowl, t = p.target;
  if (!t) return;
  const sig = lastSignals.find(s => Math.abs(s.hz - t.hz) < Math.max(7000, t.bw));
  if (sig && sig.snr > 7) { t.lastLive = now; t.lastSeen = now; if (sig.snr > t.peak) t.peak = sig.snr; }
  // An open squelch keeps a weak over alive between sightings, but cannot hold the receiver on its own: a squelch
  // stuck open on noise would otherwise end the hunt for good.
  else if (state.sqOpen && state.squelch > 0 && now - t.lastSeen < 4000) t.lastLive = now;
  const dwell = now - t.at;
  if (!t.judged && dwell > PROWL_TEST) {
    t.judged = true;
    if (p.best < PROWL_VOICE) {
      prowlSkip(t.hz, 'not speech', now);
      prowlNote(`${mhz(t.hz)} scored ${p.best.toFixed(2)} for speech, leaving it · ${p.parts}`);
      prowlRelease(now, false, 'not speech');
      return;
    }
    prowlNote(`${mhz(t.hz)} speech ${p.best.toFixed(2)}, holding · ${p.parts}`);
  }
  if (now - t.lastLive > PROWL_HANG || dwell > PROWL_MAX) prowlRelease(now, t.judged && p.best >= PROWL_VOICE, t.judged ? '' : 'gone before it could be judged');
  else refreshProwl();
}

/**
 * Let a channel go. Everything it stopped on is written down, kept or not, with the reason: a log of only the
 * successes gives you no way to tell a quiet band from a speech test that is set too strictly.
 */
function prowlRelease(now: number, kept: boolean, why = ''): void {
  const p = state.prowl, t = p.target;
  p.target = null; p.movedAt = now;
  worker?.postMessage({ type: 'config', voice: false });
  if (!t) return;
  const secs = (now - t.at) / 1000;
  if (!t.judged) {
    // It went away before there was enough audio to judge it. That is not a finding, so it is not written down;
    // it is simply left alone for a while so the hunt does not come straight back to it.
    prowlSkip(t.hz, 'went away before it could be judged', now, 45_000);
    prowlNote(`${mhz(t.hz)} went before it could be judged`);
  } else if (secs > 0.8) {
    p.log.unshift({ at: Date.now(), hz: t.hz, mode: state.mode, cls: t.cls, secs, score: p.best, db: t.peak, band: t.band, kept, why });
    if (p.log.length > 200) p.log.length = 200;
    if (kept) prowlNote(`${mhz(t.hz)} finished after ${secs.toFixed(0)}s`);
  }
  refreshProwl();
}

function prowlMove(now: number): void {
  const p = state.prowl;
  const wins = prowlWindows();
  p.win = (p.win + 1) % wins.length;
  const w = wins[p.win];
  p.band = w.name; p.movedAt = now;
  state.viewLo = w.center; state.freq = w.center;
  if (radio) radio.targetFreqHz = w.center;
  if (state.mode !== w.mode) setMode(w.mode);
  sendOffset(); refreshReadout(); refreshChannel();
  prowlNote(`sweeping ${w.name} around ${mhz(w.center)}`);
  refreshProwl();
}

function prowlStart(): void {
  const p = state.prowl;
  p.on = true;
  try { localStorage.setItem('mayhem.prowl', '1'); } catch { /* ignore */ }
  if (state.squelch === 0) setSquelch(9);
  p.held = null;
  p.movedAt = performance.now();                          // work the span it is already on, do not jump away
  if (!prowlTimer) prowlTimer = window.setInterval(prowlTick, 250);
  refreshProwl();
}
function prowlStop(): void {
  try { localStorage.setItem('mayhem.prowl', '0'); } catch { /* ignore */ }
  prowlPause();
}
/** Stop hunting without deciding you are done with it, so the next visit still starts on its own. */
function prowlPause(): void {
  const p = state.prowl;
  p.on = false;
  if (prowlTimer) { clearInterval(prowlTimer); prowlTimer = 0; }
  if (p.target) prowlRelease(performance.now(), false, 'stopped by hand');
  worker?.postMessage({ type: 'config', voice: false });
  refreshProwl();
}
/**
 * Stay on something it found and keep listening there. The hunt pauses rather than ending, so nothing will move
 * the receiver again until HUNT is pressed.
 */
function prowlHoldAt(h: ProwlHit): void {
  prowlPause();
  state.prowl.held = h.hz;
  setMode(h.mode); tune(h.hz);
  prowlNote(`holding ${mhz(h.hz)} · press HUNT to carry on looking`);
  refreshProwl();
}

function renderProwl(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel"></div></section>
    <section class="controls">
      <div class="row"><button class="chip primary" id="prowl-go" style="flex:1"></button><button class="chip" id="prowl-skip">SKIP</button></div>
      <div class="caption">NOW</div><div class="panel dmrslot" id="prowl-status"></div>
      <div id="prowl-note" class="info"></div>
      <div class="caption">SPAN &middot; wider hears more at once, narrower hears further into the noise</div>
      <div class="row">${[1.92e6, 7.68e6, 19.2e6].map(r => `<button class="chip" data-prate="${r}">${r / 1e6} MHz</button>`).join('')}</div>
      <div class="caption">WHEN THIS SPAN GOES QUIET</div>
      <div class="row"><button class="chip" id="prowl-sweep" style="flex:1"></button></div>
      ${gainHtml()}
      <div class="countrow"><span class="count">HEARD</span><span><button id="prowl-clear" class="link">CLEAR</button></span></div>
      <div id="prowl-log" class="wrap"></div>
    </section>`;
  scope = attach(tunableScope('scope', 200));
  qa<HTMLButtonElement>('[data-prate]', view).forEach(b => b.onclick = () => { setRate(Number(b.dataset.prate)); worker?.postMessage({ type: 'config', specBins: wantBins(scope?.bins ?? 4096) }); qa('[data-prate]').forEach(x => x.classList.toggle('on', x === b)); });
  qa('[data-prate]').forEach(b => b.classList.toggle('on', Number((b as HTMLElement).dataset.prate) === state.rate));
  $('prowl-go').onclick = () => state.prowl.on ? prowlStop() : prowlStart();
  $('prowl-skip').onclick = () => {
    const now = performance.now();
    if (state.prowl.target) { prowlSkip(state.prowl.target.hz, 'skipped by hand', now); prowlRelease(now, false); }
    else prowlMove(now);
  };
  $('prowl-clear').onclick = () => { state.prowl.log.length = 0; refreshProwl(); };
  $('prowl-sweep').onclick = () => { state.prowl.sweep = !state.prowl.sweep; state.prowl.movedAt = performance.now(); refreshProwl(); };
  refreshProwl();
}

function refreshProwl(): void {
  const p = state.prowl;
  const go = q('#prowl-go');
  if (go) { go.textContent = p.on ? 'STOP HUNTING' : 'HUNT'; go.classList.toggle('on', p.on); }
  const skip = q('#prowl-skip'); if (skip) skip.textContent = p.on ? 'SKIP' : 'NEXT';
  const sw = q('#prowl-sweep');
  if (sw) { sw.textContent = p.sweep ? 'MOVE TO ANOTHER BAND' : 'STAY WHERE I PUT IT'; sw.classList.toggle('on', p.sweep); }
  const st = q('#prowl-status');
  if (st) {
    const t = p.target;
    st.classList.toggle('voice', !!t && t.judged && p.score >= PROWL_VOICE);
    st.innerHTML = t
      ? `<b>${esc(mhz(t.hz))} MHz &middot; ${esc(state.mode)}</b><span>${esc(t.cls || 'unclassified')} &middot; ${Math.round(t.peak)} dB &middot; ${((performance.now() - t.at) / 1000).toFixed(0)}s</span><span class="dim">speech ${p.score.toFixed(2)}, best ${p.best.toFixed(2)}${t.judged ? '' : ' &middot; deciding'}</span>`
      : p.held !== null
        ? `<b>HOLDING ${esc(mhz(p.held))} MHz</b><span>listening here until you press HUNT</span><span class="dim">${p.seen} in view · ${p.tracks.size} remembered</span>`
        : `<b>${p.on ? 'HUNTING' : 'STOPPED'}</b><span>${p.seen} in view · ${p.ready} worth a try</span><span class="dim">${p.tracks.size} remembered${p.sweep ? ` · ${esc(p.band || 'this span')}` : ''}</span>`;
  }
  const note = q('#prowl-note'); if (note) note.textContent = p.note;
  const el = q('#prowl-log');
  if (!el) return;
  el.innerHTML = p.log.length
    ? p.log.map((h, i) => `<button class="chip bm${h.kept ? ' on' : ''}${h.kept ? '' : ' faded'}" data-ph="${i}" title="tap to hold here &middot; ${esc(h.kept ? 'speech' : h.why || 'not speech')} &middot; speech score ${h.score.toFixed(2)}">${esc(mhz(h.hz))} &middot; ${h.secs.toFixed(0)}s &middot; ${h.score.toFixed(2)}<i data-phx="${i}">✕</i></button>`).join('')
    : '<span class="empty">nothing heard yet, press HUNT</span>';
  // Tapping one holds the receiver on it.
  qa<HTMLButtonElement>('[data-ph]', el).forEach(b => b.onclick = (ev) => {
    const i = Number(b.dataset.ph);
    if ((ev.target as HTMLElement).dataset.phx !== undefined) { p.log.splice(i, 1); refreshProwl(); return; }
    const h = p.log[i];
    if (h) prowlHoldAt(h);
  });
}


// ---- ORBCOMM ------------------------------------------------------------------------------------------------
/**
 * The satellites that carry short machine messages for trackers and remote sensors. Their messages are
 * encrypted, but every four seconds each one broadcasts where it is, so it can be put on the map from its own
 * transmission with nothing fetched from the internet. Same 137 MHz antenna as the weather satellites, and the
 * channel plan deliberately avoids them, so nothing collides.
 */
let orbTimer = 0;
/**
 * Where to park the radio. The whole channel plan spans 137.2 to 137.8 MHz, so a two megahertz window holds
 * every one of them and stepping between channels is a change of demodulator, not of tuning: the waterfall
 * stops jumping, its history survives, and every channel stays visible while you listen to one.
 */
const ORB_SPAN_CENTER = 137_500_000;
function renderOrbcomm(view: HTMLElement): void {
  const o = state.orb;
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div>
      <div id="orb-map" class="panel map"></div></section>
    <section class="controls">${satStrip()}
      <div class="caption">CHANNEL &middot; the busy ones are listed first</div>
      <div class="row bandstrip">${ORBCOMM_CHANNELS.map(hz => `<button class="chip" data-orb="${hz}">${(hz / 1e6).toFixed(4).replace(/0+$/, '')}</button>`).join('')}</div>
      <div class="row"><button class="chip" id="orb-hunt" style="flex:1"></button></div>
      <div id="orb-stats" class="health"></div>
      <div class="countrow"><span class="count" id="count-orb">0 SATELLITES</span></div>
      <div id="orb-list" class="panel list short"></div>
      <div class="about">The message packets are encrypted and are not decoded. What is shown is each satellite's
        own report of where it is, which it sends every four seconds, plus its clock and speed.</div>
      ${gainHtml()}
    </section>`;
  scope = attach(tunableScope('scope', 90, 70));
  geo = new GeoMap($('orb-map'), { home: state.home, onPick: id => { o.sel = Number(id); refreshOrbcomm(); }, log });
  qa<HTMLButtonElement>('[data-orb]', view).forEach(b => b.onclick = () => { o.hunt = false; orbTune(Number(b.dataset.orb)); });
  $('orb-hunt').onclick = () => { o.hunt = !o.hunt; o.huntAt = performance.now(); refreshOrbcomm(); };
  clearInterval(orbTimer);
  orbTimer = window.setInterval(orbTick, 1000);
  void orbLoadOrbits();
  refreshOrbcomm();
}

/**
 * Names for the satellites. Over the air each one gives only a one-byte identifier, but it also says where it is,
 * so propagating the published orbits and seeing which one is in that spot names it — and, usefully, says how far
 * apart the two answers are, which is an independent check that the decode is right.
 */
async function orbLoadOrbits(): Promise<void> {
  const o = state.orb;
  if (o.orbits.length) return;
  try {
    const tles = await fetchGroup('orbcomm');
    for (const tle of tles) { try { o.orbits.push({ name: tle.name, sgp: new Sgp4(tle) }); } catch { /* a bad element set is not fatal */ } }
    log(`ORBCOMM: ${o.orbits.length} orbits loaded, for naming what is heard`);
    orbName();
    refreshOrbcomm();
  } catch { log('ORBCOMM: could not fetch orbits, satellites will show by identifier only'); }
}

/** Match every satellite that has reported a position against the published orbits. */
function orbName(): void {
  const o = state.orb;
  if (!o.orbits.length) return;
  const now = Date.now(), R = 6371;
  for (const s of o.sats) {
    if (s.lat === undefined || o.named.has(s.id)) continue;
    let best = '', bestKm = Infinity;
    for (const c of o.orbits) {
      let l;
      try { l = look(c.sgp, now, 0, 0); } catch { continue; }
      const dLat = (l.lat - s.lat) * Math.PI / 180, dLon = (l.lon - s.lon!) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(l.lat * Math.PI / 180) * Math.cos(s.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
      if (km < bestKm) { bestKm = km; best = c.name; }
    }
    if (best && bestKm < 300) o.named.set(s.id, { name: best, km: bestKm });
  }
}

function orbTune(hz: number): void {
  state.orb.channel = hz;
  tune(hz);
  qa('[data-orb]').forEach(b => b.classList.toggle('on', Number((b as HTMLElement).dataset.orb) === hz));
  refreshOrbcomm();
}

/** Step through the channel plan while nothing is decoding, and stop as soon as a frame comes in. */
function orbTick(): void {
  const o = state.orb;
  if (!q('#orb-stats')) { clearInterval(orbTimer); orbTimer = 0; return; }
  if (o.hunt) {
    const now = performance.now();
    if (o.frames > o.lastFrames) { o.hunt = false; o.lastFrames = o.frames; log(`ORBCOMM locked on ${(o.channel / 1e6).toFixed(4)}`); }
    else if (now - o.huntAt > 6000) {
      o.huntAt = now;
      const i = (ORBCOMM_CHANNELS.indexOf(o.channel) + 1) % ORBCOMM_CHANNELS.length;
      orbTune(ORBCOMM_CHANNELS[i]);
    }
  }
  o.lastFrames = o.frames;
  refreshOrbcomm();
}

function refreshOrbcomm(): void {
  const o = state.orb;
  const hunt = q('#orb-hunt');
  if (hunt) { hunt.textContent = o.hunt ? 'SEARCHING THE CHANNELS' : 'FIND A BUSY CHANNEL'; hunt.classList.toggle('on', o.hunt); }
  const st = q('#orb-stats');
  // A pass shows up here as soon as anything frames, well before any satellite has said where it is, so an empty
  // list with frames climbing means it is working and just has not reached an ephemeris packet yet.
  if (st) st.textContent = o.frames
    ? `${o.frames} frames · ${o.packets} packets, ${o.packets - o.bad} good · ${(o.channel / 1e6).toFixed(4)} MHz`
      + (o.sats.length ? '' : ' · decoding, waiting for a position report')
    : `nothing decoded yet on ${(o.channel / 1e6).toFixed(4)} MHz · a pass lasts about ten minutes and there is`
      + ` often nothing overhead · look for a narrow line on the waterfall and a blip once a second in the audio`;
  const c = q('#count-orb'); if (c) c.textContent = `${o.sats.length} SATELLITE${o.sats.length === 1 ? '' : 'S'}`;
  const el = q('#orb-list');
  if (el) {
    el.innerHTML = o.sats.length
      ? o.sats.map((s, i) => { const n = o.named.get(s.id); return `<div class="li tap ${i % 2 ? 'alt' : ''}${s.id === o.sel ? ' sel' : ''}" data-orbsat="${s.id}">${
          esc(n ? n.name : `0x${s.id.toString(16).toUpperCase().padStart(2, '0')}`)} · ${s.lat !== undefined ? `${s.lat.toFixed(2)}, ${s.lon!.toFixed(2)} · ${s.altKm!.toFixed(0)} km · ${s.speedKms!.toFixed(2)} km/s` : 'heard, no position yet'
        }${n ? ` · ${n.km.toFixed(0)} km from its published orbit` : ''}${s.utc ? ` · ${new Date(s.utc).toISOString().slice(11, 19)}Z` : ''}</div>`; }).join('')
      : '<div class="empty">nothing yet — try FIND A BUSY CHANNEL, or wait for a pass</div>';
    qa<HTMLElement>('[data-orbsat]', el).forEach(b => b.onclick = () => { o.sel = Number(b.dataset.orbsat); refreshOrbcomm(); });
  }
  if (geo && state.app === 'sat' && state.ham.sat.view === 'orbcomm') {
    geo.update(o.sats.filter(s => s.lat !== undefined).map(s => ({
      id: String(s.id), lat: s.lat!, lon: s.lon!, kind: 'sat' as const,
      label: `${o.named.get(s.id)?.name ?? `0x${s.id.toString(16).toUpperCase()}`} · ${s.altKm!.toFixed(0)} km`,
    })), String(o.sel));
  }
}


// ---- packet satellites --------------------------------------------------------------------------------------
/**
 * The cubesats that send their telemetry as 9600 baud packet. This is by far the most common cubesat downlink
 * there is, and it is ordinary AX.25 underneath, so the frames carry callsigns you can read even when the payload
 * is binary telemetry.
 *
 * The list is not hard-coded. It comes from the SatNOGS transmitter database, which the people who track these
 * things keep current, filtered to the ones still alive at a baud rate and in a band a whip can actually hear.
 * Orbits come from CelesTrak, so the list can be sorted by what is above the horizon right now.
 */
interface PacketSat { norad: number; hz: number; baud: number; what: string; name: string; el: number; sgp: Sgp4 | null;
  /** Which framing sits on top of the bits: ordinary packet, or the Geoscan picture format. */
  framing: 'g3ruh' | 'geoscan' }
let packetTimer = 0;

function renderPacketSats(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">${satStrip()}
      <div class="caption">ABOVE THE HORIZON NOW &middot; tap to listen</div>
      <div id="psat-list" class="panel list short"></div>
      <div id="psat-note" class="health"></div>
      <div id="psat-pic" hidden><div class="caption">PICTURE &middot; built up as the pass goes on</div>
        <div class="panel imgwrap"><img id="psat-img" alt="picture from the satellite" style="width:100%;display:block"></div>
        <div id="psat-picnote" class="health"></div></div>
      <div class="countrow"><span class="count" id="count-psat">0 FRAMES</span><span class="row"><button class="link" id="pause-psat">PAUSE</button><button class="link" id="clear-psat">CLEAR</button></span></div>
      <div id="psat-frames" class="panel list"></div>
      <div class="about">Ordinary AX.25 at 9600 baud, scrambled the way James Miller's modem does it. The payload is
        usually binary telemetry rather than text, so the callsigns are the part you read: they tell you which
        satellite you just heard.</div>
      ${gainHtml()}
    </section>`;
  scope = attach(tunableScope('scope', 110, 80));
  clearInterval(packetTimer);
  packetTimer = window.setInterval(() => { if (!q('#psat-list')) { clearInterval(packetTimer); packetTimer = 0; return; } packetRank(); }, 5000);
  void packetLoad();
  refreshPacketSats();
}

async function packetLoad(): Promise<void> {
  const p = state.psat;
  if (p.sats.length) { packetRank(); return; }
  for (const [norad, hz, baud, name] of PACKET_SATS) p.sats.push({ norad, hz, baud, what: '', name, el: -90, sgp: null, framing: 'g3ruh' });
  for (const [norad, hz, name] of GEOSCAN_SATS) p.sats.push({ norad, hz, baud: 9600, what: 'pictures', name, el: -90, sgp: null, framing: 'geoscan' });
  refreshPacketSats();
  // Orbits are what make the list useful: without them everything reads the same and you cannot tell what is up.
  try {
    const groups = await Promise.all([fetchGroup('amateur'), fetchGroup('cubesat')]);
    const byNorad = new Map<number, Tle>();
    for (const g of groups) for (const tle of g) { const n = Number(tle.line1.substring(2, 7)); if (n && !byNorad.has(n)) byNorad.set(n, tle); }
    for (const s of p.sats) {
      const tle = byNorad.get(s.norad);
      if (tle) { try { s.sgp = new Sgp4(tle); } catch { s.sgp = null; } }
    }
    log(`packet satellites: ${p.sats.length} transmitters, ${p.sats.filter(s => s.sgp).length} with orbits`);
  } catch { p.note = 'no orbits — the list still tunes, but cannot be sorted by what is overhead'; }
  packetRank();
}

/** Work out what is up right now, and put the highest first. */
function packetRank(): void {
  const p = state.psat, home = state.home;
  if (home) {
    const now = Date.now();
    for (const s of p.sats) { try { s.el = s.sgp ? look(s.sgp, now, home.lat, home.lon).el : -90; } catch { s.el = -90; } }
    p.sats.sort((a, b) => b.el - a.el || a.name.localeCompare(b.name));
  } else {
    // Without a position nothing can be ranked, so at least put them in an order somebody can search by eye.
    p.sats.sort((a, b) => a.name.localeCompare(b.name));
  }
  refreshPacketSats();
}

function packetListen(s: PacketSat): void {
  const p = state.psat;
  p.sel = s.norad;
  state.ham.freq = s.hz;
  p.framing = s.framing;
  worker?.postMessage({ type: 'satService', kind: s.framing, baud: s.baud });
  open('sat');
  log(`listening to ${s.name} on ${(s.hz / 1e6).toFixed(4)} at ${s.baud} baud${s.framing === 'geoscan' ? ', looking for pictures' : ''}`);
}

function refreshPacketSats(): void {
  const p = state.psat;
  const el = q('#psat-list');
  if (el) {
    const up = p.sats.filter(s => s.el > -1);
    const show = (up.length ? up : p.sats).slice(0, 60);
    el.innerHTML = show.length
      ? show.map((s, i) => `<div class="li tap ${i % 2 ? 'alt' : ''}${s.norad === p.sel ? ' sel' : ''}" data-psat="${s.norad}">${
          esc(s.name)} · ${(s.hz / 1e6).toFixed(4)} · ${s.baud}bd${s.framing === 'geoscan' ? ' · 📷' : ''} · ${s.el > -1 ? `el ${s.el.toFixed(0)}°` : s.sgp ? 'below the horizon' : 'no orbit'}</div>`).join('')
      : `<div class="empty">${esc(p.note || 'fetching the list of packet satellites…')}</div>`;
    qa<HTMLElement>('[data-psat]', el).forEach(b => b.onclick = () => {
      const s = p.sats.find(x => x.norad === Number(b.dataset.psat));
      if (s) packetListen(s);
    });
  }
  const note = q('#psat-note');
  if (note) {
    const up = p.sats.filter(s => s.el > -1).length;
    note.textContent = !state.home ? 'allow location to sort these by what is overhead'
      : p.sats.length ? `${up} of ${p.sats.length} above the horizon${p.bad ? ` · ${p.bad} frames failed their check` : ''}`
      : (p.note || 'fetching…');
  }
  const c = q('#count-psat'); if (c) c.textContent = `${p.heard} FRAME${p.heard === 1 ? '' : 'S'}`;
  const pic = q('#psat-pic'), g = p.pic;
  if (pic) {
    (pic as HTMLElement).hidden = p.framing !== 'geoscan';
    const im = q<HTMLImageElement>('#psat-img');
    if (im && g.url && im.src !== g.url) im.src = g.url;
    const pn = q('#psat-picnote');
    if (pn) pn.textContent = g.frames
      ? `${g.frames} frames · ${g.fragments} pieces of picture · ${(g.high / 1024).toFixed(1)} kB${g.complete ? ' · complete' : ''}${g.bad ? ` · ${g.bad} failed the checksum` : ''}`
      : 'nothing yet — a picture takes most of a pass to come down';
  }
  const fr = q('#psat-frames');
  if (fr && !paused.has('psat')) fr.innerHTML = p.frames.length
    ? p.frames.map((f, i) => `<div class="li ${i % 2 ? 'alt' : ''}"><b>${esc(f.from)} &gt; ${esc(f.to)}</b> · ${f.payload.length} bytes<br>${esc(f.text || f.hex)}</div>`).join('')
    : '<div class="empty">nothing heard yet — pick something that is up and wait for a beacon</div>';
}

// ---- rendering ------------------------------------------------------------------------------------------------
function tint(cat: string): string { return cat === 'Receive' ? 'var(--accent)' : cat === 'Analyze' ? 'var(--accent2)' : cat === 'Transmit' ? 'var(--danger)' : 'var(--muted)'; }
function tintHex(cat: string): string { const s = currentSkin(); return cat === 'Receive' ? s.accent : cat === 'Analyze' ? s.accent2 : cat === 'Transmit' ? '#ff5b52' : s.muted; }

/**
 * The frequency readout: every digit from 1 GHz down to 1 Hz is its own control — mouse wheel over a digit, click
 * or tap its top half to add one and its bottom half to subtract one, ← → / ↑ ↓ on a focused digit. Leading zeros
 * are dimmed so the eye lands on the live digits, and each group is captioned with its unit. ⌨ (or typing a number
 * with nothing focused) swaps the digits for a text box to key a frequency in whole.
 */
const FREQ_GROUPS: [number[], string][] = [[[1e9], 'GHz'], [[1e8, 1e7, 1e6], 'MHz'], [[1e5, 1e4, 1e3], 'kHz'], [[1e2, 1e1, 1], 'Hz']];
const freqDigitsHtml = () => FREQ_GROUPS.map(([ws, unit], gi) =>
  `${gi ? '<span class="fsep">.</span>' : ''}<span class="fgrp"><span class="fds">${ws.map(w => `<span class="fd" data-w="${w}" tabindex="0" role="spinbutton" aria-label="${unit} digit">0</span>`).join('')}</span><span class="funit">${unit}</span></span>`).join('');
/** The 0–40 dB scale a signal meter reads in, unless an app gives its own (fractions of the meter, labels). */
const DB_SCALE: [number, string][] = [[0, '0'], [0.25, '10'], [0.5, '20'], [0.75, '30'], [1, '40 dB']];
const scaleHtml = (sc: [number, string][]) => sc.map(([at, l]) => at >= 0.98 ? `<span class="end">${l}</span>` : `<span style="left:${at * 100}%">${l}</span>`).join('');
/**
 * The frequency card, the same on every app (the Android app's): a tag, a title, ☆ and ⌨, a lamp; the digits
 * across the full width; a 32-LED meter with its scale; a caption line. setFace / setLamp / setMeter fill it.
 */
const readoutHtml = () => `<div class="face"><div class="fhead"><span id="ftag" class="ftag"></span><span id="ftitle" class="ftitle"></span><button id="fav" class="fact" title="save this to FAVES">☆</button><button id="fkey" class="fact" title="type a frequency">⌨</button><span id="lamp" class="lamp"><i></i><b></b></span><span id="sq" hidden></span></div><div class="readout"><div id="freq" class="freq">${freqDigitsHtml()}</div></div><div id="leds" class="leds">${'<i></i>'.repeat(32)}<s hidden></s></div><div id="lscale" class="lscale">${scaleHtml(DB_SCALE)}</div><div class="fcap"><b id="capl">SIGNAL —</b><span id="capr"></span></div><div id="health" class="health">waiting for IQ…</div></div>`;
/** What the card says: its tag, its title, and (optionally) the caption's right side. */
function setFace(tag: string, title: string, right?: string): void {
  const t = q('#ftag'); if (t) t.textContent = tag;
  const ti = q('#ftitle'); if (ti) ti.textContent = title;
  if (right !== undefined) { const r = q('#capr'); if (r) r.textContent = right; }
}
/** The card's lamp: a word and its colour ('ok' green, 'amber', 'red', or muted when none), blinking while searching. */
function setLamp(text: string, tone: '' | 'ok' | 'amber' | 'red' = '', blink = false): void {
  const l = q('#lamp'); if (!l) return;
  l.className = `lamp ${tone}${tone ? ' lit' : ''}${blink ? ' blink' : ''}`;
  const b = l.querySelector('b'); if (b && b.textContent !== text) b.textContent = text;
}
/** Light the meter to [frac] of full scale, with a threshold mark at [tick] (both 0..1), and its caption's left side. */
function setMeter(frac: number, left: string, tick: number | null = null, scale?: [number, string][]): void {
  const ls = qa<HTMLElement>('#leds i'); if (!ls.length) return;
  const lit = Math.max(0, Math.min(32, Math.round(frac * 32)));
  ls.forEach((e, i) => { const c = i >= lit ? '' : i < 14 ? 'l1' : i < 22 ? 'l2' : i < 28 ? 'l3' : 'l4'; if (e.className !== c) e.className = c; });
  const m = q<HTMLElement>('#leds s'); if (m) { m.hidden = tick === null; if (tick !== null) m.style.left = `${Math.max(0, Math.min(1, tick)) * 100}%`; }
  const c = q('#capl'); if (c && c.textContent !== left) c.textContent = left;
  if (scale) { const sc = q('#lscale'); if (sc) sc.innerHTML = scaleHtml(scale); }
}
/** Paint hz into the digit readout (leading zeros dimmed down to the MHz units digit). */
function setFreqDisplay(hz: number): void {
  const ds = qa<HTMLElement>('#freq .fd'); if (!ds.length) return;
  // below 1 GHz the GHz digit is a zero nobody taps, so it goes and the digits get its width
  q('#freq')?.classList.toggle('noghz', hz < 1e9);
  let lead = true;
  for (const d of ds) {
    const w = Number(d.dataset.w);
    const v = Math.floor(hz / w) % 10;
    if (v !== 0 || w <= 1e6) lead = false;
    const t = String(v);
    if (d.textContent !== t) d.textContent = t;
    d.classList.toggle('dim', lead);
  }
}
/** Nudge one digit of the tuned frequency; flashes the digit in the direction it moved. */
function nudgeDigit(el: HTMLElement, dir: 1 | -1): void {
  const w = Number(el.dataset.w); if (!w) return;
  tune(state.freq + dir * w);
  el.classList.remove('up', 'down'); void el.offsetWidth; el.classList.add(dir > 0 ? 'up' : 'down');
}
/**
 * "433.92", "433,92", "144390k", "1.2 GHz", "162550000 Hz": a unit wins; a bare number is MHz, or Hz once it is too
 * big to be MHz. Null when it doesn't read as a frequency at all (tune() clamps the range).
 */
function parseFreq(s: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*([kmg])?(hz)?\s*$/i.exec(s); if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  const mul = m[2] ? { k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'g'] : m[3] || v >= 1e5 ? 1 : 1e6;
  return v > 0 ? v * mul : null;
}
/** Key a frequency in: the digits give way to a text box (a phone brings up its number pad). Enter or leaving it tunes, Esc backs out. */
function freqEntry(seed = ''): void {
  const fr = q('#freq'); if (!fr || q('#fentry')) return;
  const inp = document.createElement('input');
  inp.id = 'fentry'; inp.className = 'txin fentry'; inp.inputMode = 'decimal'; inp.autocomplete = 'off'; inp.enterKeyHint = 'go';
  inp.placeholder = `${+(tunedHz() / 1e6).toFixed(6)} MHz`; inp.value = seed;
  fr.hidden = true; fr.after(inp); inp.focus(); inp.setSelectionRange(seed.length, seed.length);
  let done = false;
  const close = (ok: boolean) => {
    if (done) return; done = true;
    const text = inp.value.trim(), hz = ok ? parseFreq(text) : null;
    inp.remove(); fr.hidden = false;
    if (hz) tune(hz); else if (ok && text) log(`"${text}" isn't a frequency — try 433.92, 144390k or 1.2G`);
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); close(true); } else if (e.key === 'Escape') { e.preventDefault(); close(false); } };
  inp.onblur = () => close(true);
}
const isAndroid = () => /android/i.test(navigator.userAgent);
const gainHtml = () => `<div class="gainwrap"><div class="caption" id="gain-cap">GAIN</div><div class="row"><button id="agc" class="chip">AGC</button><button id="amp" class="chip">AMP OFF</button><button id="biast" class="chip" hidden>BIAS-T</button><div class="stepper"><button id="lna-minus">−</button><span id="lna">LNA</span><button id="lna-plus">+</button></div><div class="stepper"><button id="vga-minus">−</button><span id="vga">VGA</span><button id="vga-plus">+</button></div></div></div>`;
/** Tune steps went with the Android app's redesign: every digit tunes itself. Kept so the call sites read the same. */
const stepHtml = (_steps: number[]) => '';
/** A sideways scroller whose edges glow while there is more past them (wired by bindHs). */
const hsHtml = (inner: string, cls = '') => `<div class="hs ${cls}"><div class="hs-in">${inner}</div></div>`;
/** Presets as a tile row: the number large, what it is under it ("FM 92.3" → 92.3 / FM, "315.000 · US" → 315.000 / US). */
const presetHtml = (_title: string, presets: [string, number, Mode?][]) => hsHtml(`<div class="tiles wide">${presets.map(([l, hz, m]) => {
  const parts = l.replace(' · ', ' ').split(' ');
  const num = parts.find(x => /^[0-9.]+$/.test(x)) ?? (hz / 1e6).toFixed(3);
  const sub = parts.filter(x => x !== num).join(' ') || 'MHz';
  return `<button class="tl" data-preset="${hz}" ${m ? `data-pmode="${m}"` : ''}><b>${num}</b><small>${sub}</small></button>`;
}).join('')}</div>`);
/** One bar of equal segments for a single choice; the buttons keep their data attributes, so their wiring is unchanged. */
const segHtml = (buttons: string[], cls = '') => `<div class="seg ${cls}">${buttons.join('')}</div>`;
/** Every .hs under [root]: glow an edge while there is more to scroll that way. */
function bindHs(root: ParentNode = document): void {
  qa<HTMLElement>('.hs', root as HTMLElement).forEach(w => {
    const inner = w.querySelector<HTMLElement>('.hs-in'); if (!inner || inner.dataset.hs) return;
    inner.dataset.hs = '1';
    const upd = () => { w.classList.toggle('mL', inner.scrollLeft > 4); w.classList.toggle('mR', inner.scrollLeft < inner.scrollWidth - inner.clientWidth - 4); };
    inner.addEventListener('scroll', upd, { passive: true }); new ResizeObserver(upd).observe(inner); upd();
    // the tile you are on, in view
    const on = inner.querySelector<HTMLElement>('.on'); if (on) inner.scrollLeft = Math.max(0, on.offsetLeft - inner.offsetLeft - 60);
  });
}
/** The line over every decode list. PAUSE holds the screen still so a row can be read while packets keep
 *  landing underneath; CLEAR forgets them. Both are wired by id in wireCommon, whichever screen they are on. */
/** The clear-all icon the Android app puts beside PAUSE. */
const CLEAR_SVG = '<svg viewBox="0 0 24 24"><path d="M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zM14 5h-3l-1-1H6L5 5H2v2h12z"/></svg>';
const pauseClearHtml = (id: string) => `<button class="tog" id="pause-${id}">PAUSE</button><button class="ib" id="clear-${id}" title="clear" aria-label="clear">${CLEAR_SVG}</button>`;
const countRowHtml = (id: string, count: string, extra = '') => `<div class="countrow"><span id="count-${id}" class="count">${count}</span><span class="row">${extra}${pauseClearHtml(id)}</span></div>`;
const listHtml = (id: string, title: string) => `<div class="panel list" id="list-${id}"><div class="empty">${title}</div></div>`;
const logHtml = (id: string, title: string) => countRowHtml(id, '0 DECODED') + listHtml(id, title);

/** Where the launcher's app strip was scrolled to, kept across app visits so returning home does not snap it back. */
const launchScroll = { x: 0, y: 0 };
/** The launcher tunes its marker to the strongest signal in view, once per band open, so it never lands on a dead
 *  frequency (the band midpoint is often empty). Re-armed when the launcher opens or the band changes. */
let launchPicked = false;
/** The user tuned on the launcher this visit (a tap, the keypad, a step): Audio then opens exactly there. */
let launchTapped = false;
/** The strongest station the launcher has found in each of its bands. Audio opens on it when it is tapped before
 *  this visit's pick has landed; broadcast stations do not move, so the last one found is still right. */
const bandBest = new Map<string, number>();
/** Audio opened with nothing better to go on: take the strongest station in its own view once signals arrive. */
let audioPick = false;
/** The span was widened or narrowed by hand this visit (− / +): the start-up pick leaves it alone. */
let spanByHand = false;
/**
 * The start-up pick's clock and memory (the same rules as the iPad and Android apps). Nothing counts for 1.5 s
 * after it is armed (lists from the old view still in flight, the AGC settling), then it waits 2.5 s more, and for
 * the gain to hold within 3 dB for 1 s (a pick taken while the AGC steps measures stations through an overloaded
 * front end). On broadcast FM the pick is the 160 kHz channel with the most level across it on the averaged
 * spectrum: the classifier's verdict on a strong station swings frame to frame (47 kHz to 1.8 MHz wide as its HD
 * sidebands merge in, its center wandering 200 kHz) and a HackRF's clock line at an exact megahertz sometimes passes
 * for a station, while a real station fills the channel and a clock line is one bin however tall. Elsewhere it is
 * the strongest signal seen in at least a third of the frames since the gain settled.
 */
const pick = { armedAt: 0, firstSeen: 0, tally: new Map<number, [number, SeenSignal]>(), frames: 0, viewed: false, gainAt: -1, gainSince: 0, specAcc: null as Float64Array | null, specN: 0 };
function pickArm(): void { pick.armedAt = performance.now(); pick.firstSeen = 0; pick.tally.clear(); pick.frames = 0; pick.gainAt = -1; pick.specAcc = null; pick.specN = 0; }
/** The newest averaged spectrum (dB above its own median), for the broadcast pick. */
let pickSpec: Float32Array | null = null;
function notePickSpectrum(bins: Float32Array, rangeDb: number): void {
  const db = Float32Array.from(bins, v => v * rangeDb);
  const sorted = Float32Array.from(db).sort(); const med = sorted[sorted.length >> 1];
  for (let k = 0; k < db.length; k++) db[k] = Math.max(0, db[k] - med);
  pickSpec = db;
}
/** One look at the newest list: 'stay' (a good station is already tuned, or it gave up), a station, or null (not yet). */
function pickStep(here: number): SeenSignal | 'stay' | null {
  const now = performance.now();
  if (now - pick.armedAt < 1500 || !lastSignals.length) return null;
  if (!pick.firstSeen) { pick.firstSeen = now; return null; }
  if (now - pick.firstSeen > 30_000) return 'stay';
  const gain = state.lna + state.vga + (state.amp ? 14 : 0);
  if (pick.gainAt < 0 || Math.abs(gain - pick.gainAt) > 3) { pick.gainAt = gain; pick.gainSince = now; pick.tally.clear(); pick.frames = 0; pick.specAcc = null; pick.specN = 0; return null; }
  const half = state.rate / 2 - VIEW_GUARD, c = spanCenter();
  const broadcast = state.mode === 'WFM';
  // in view, and not the radio's own spike at the middle of the span (a HackRF's DC offset)
  const inView = lastSignals.filter(s => Math.abs(s.hz - c) <= half && Math.abs(s.hz - c) > 30_000);
  const pool = broadcast ? inView.filter(s => s.bw > 25_000 && (s.bw < 400_000 || (s.snr >= 25 && s.bw < 1_000_000))) : inView;
  // already on a good station: stay there, never trade it for another (broadcast decides this from the channel
  // levels below: a dial on the radio's own DC spike passed for a 17 dB station here)
  if (!broadcast) {
    const on = pool.find(s => Math.abs(s.hz - here) <= Math.max(50_000, Math.min(s.bw, 300_000) / 2));
    if (on && on.snr >= 15) { log(`start-up: staying on the station already tuned, ${(on.hz / 1e6).toFixed(3)} MHz ${Math.round(on.snr)} dB ${Math.round(on.bw / 1e3)} kHz wide`); return 'stay'; }
  }
  pick.frames++;
  const seen = new Set<number>();
  for (const s of [...pool].sort((a, b) => b.snr - a.snr)) {
    const k = Math.round(s.hz / 100_000);
    if (seen.has(k)) continue;
    seen.add(k);
    const t = pick.tally.get(k);
    pick.tally.set(k, [(t?.[0] ?? 0) + 1, !t || s.snr > t[1].snr ? s : t[1]]);
  }
  if (broadcast && pickSpec) {
    if (!pick.specAcc || pick.specAcc.length !== pickSpec.length) { pick.specAcc = new Float64Array(pickSpec.length); pick.specN = 0; }
    for (let k = 0; k < pickSpec.length; k++) pick.specAcc[k] += pickSpec[k];
    pick.specN++;
  }
  if (now - pick.firstSeen < 2500 || now - pick.gainSince < 1000 || pick.frames < 3) return null;
  if (broadcast && pick.specAcc && pick.specN >= 3) {
    // every 100 kHz raster channel in view (clear of the DC spike at the middle), scored by the average level
    // summed across ±80 kHz of it
    const acc = pick.specAcc, n = acc.length, binHz = state.rate / n, w = Math.max(1, Math.floor(80_000 / binHz)), start = c - state.rate / 2;
    const score = (f: number): number => {
      const mid = Math.floor((f - start) / binHz); let sum = 0;
      for (let k = Math.max(0, mid - w); k <= Math.min(n - 1, mid + w); k++) sum += acc[k];
      return sum / pick.specN;
    };
    const scores: [number, number][] = [];
    for (let f = Math.ceil((c - half) / 100_000) * 100_000; f <= c + half; f += 100_000) if (Math.abs(f - c) > 60_000) scores.push([f, score(f)]);
    if (!scores.length) return null;
    const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
    // already on a good station: stay unless it is under a third of the best one; a dial on the DC spike at the
    // middle of the span cannot be judged, so it is not kept
    if (Math.abs(here - c) > 60_000 && Math.abs(here - c) <= half) {
      const mine = score(here);
      if (mine >= best[1] / 3) { log(`start-up: staying on the station already tuned, ${(here / 1e6).toFixed(3)} MHz (level ${Math.round(mine)}, best in view ${(best[0] / 1e6).toFixed(1)} MHz ${Math.round(best[1])})`); return 'stay'; }
    }
    log(`start-up: channels by level across 160 kHz (MHz/score, ${pick.specN} frames) ${[...scores].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, v]) => `${(f / 1e6).toFixed(1)}/${Math.round(v)}`).join(' ')}`);
    log(`start-up: tuned the strongest station in view, ${(best[0] / 1e6).toFixed(1)} MHz`);
    return { hz: best[0], db: 0, snr: best[1], bw: 200_000, cls: 'WFM', conf: 1, val: 0 };
  }
  let best: SeenSignal | null = null;
  for (const [n, s] of pick.tally.values()) if (n * 3 >= pick.frames && (!best || s.snr > best.snr)) best = s;
  if (best) log(`start-up: tuned the strongest steady signal in view, ${(best.hz / 1e6).toFixed(3)} MHz ${best.cls} ${Math.round(best.snr)} dB ${Math.round(best.bw / 1e3)} kHz wide`);
  return best;
}
function launchAutoPick(): void {
  if (state.app !== null || launchPicked || !lastSignals.length) return;
  const r = pickStep(state.freq);
  if (!r) return;
  launchPicked = true;
  if (r === 'stay') return;
  // An automatic pick is a suggestion on screen, not the user's choice: it must not become the shared dial.
  bandBest.set(state.launchBand, r.hz);
  silentTune = true; try { tune(r.hz, true); } finally { silentTune = false; }
}
/**
 * Audio opened with nothing better to go on (it is the desktop's first screen): once the radio is up, look across
 * the band the dial is in. A radio that sees most of it in one span (a HackRF) shows it all, zoomed out; a narrow
 * one (an RTL-SDR) stays on the dial as wide as it goes. A span set by hand is left alone.
 */
function audioViewBand(): void {
  if (!radio || spanByHand) return;
  const b = LAUNCH_BANDS.find(x => state.freq >= x.lo && state.freq <= x.hi);
  if (!b) return;
  const widest = cleanWidest(radio.limits);
  if (widest * 2 < b.hi - b.lo) { setRate(widest); scope?.clear(); refreshChannel(); return; }
  const cap = RX_RATES[Math.min(maxRateIdx(), RX_RATES.length - 1)];
  const fits = RX_RATES.filter(r => r <= Math.min(cap, widest));
  const rate = fits.find(r => r >= b.hi - b.lo) ?? fits[fits.length - 1] ?? RX_RATE;
  setRate(rate);
  // the band's middle, when the dial is still inside the view from there
  const mid = Math.round((b.lo + b.hi) / 2);
  state.viewLo = Math.abs(state.freq - mid) <= state.rate / 2 - VIEW_GUARD ? mid : state.freq;
  if (radio) radio.targetFreqHz = state.viewLo;
  scope?.clear(); sendOffset(); refreshChannel(); refreshReadout();
}
/** Audio's own pick: the strongest steady station in view, tuned where it shows (no recentering: the retune chops). */
function audioAutoPick(): void {
  if (state.app !== 'audio' || !audioPick || !lastSignals.length) return;
  if (!pick.viewed) { pick.viewed = true; audioViewBand(); pickArm(); return; }
  const r = pickStep(state.freq);
  if (!r) return;
  audioPick = false;
  if (r !== 'stay') { silentTune = true; try { tune(r.hz); } finally { silentTune = false; } }
}
function render(app: AppId | null): void {
  const view = $('view');
  const header = $('title');
  header.innerHTML = app ? `‹ ${APPS.find(a => a.id === app)!.title.toUpperCase()}` : `MAYHEM<span>MOBILE</span>`;
  $('sub').textContent = app ? APPS.find(a => a.id === app)!.blurb
    : !radio ? 'HackRF or RTL-SDR · no device'
    : radio.kind === 'rtlsdr' ? radio.label
    : `HackRF · ${state.board || 'HackRF'}${state.firmware ? ' · ' + state.firmware : ''}`;
  scope = null; sweepScope = null;
  // Audio, Looking Glass and Capture have short controls: on a wide screen they sit beside the card, over a
  // full-width waterfall (the .stack layout)
  view.className = 'view ' + (app ?? 'launcher') + (app === 'audio' || app === 'lookingglass' || app === 'capture' ? ' stack' : '');
  view.dataset.tab = app === 'ham' ? state.ham.tab : '';   // phones size the waterfall by what the tab is for
  switch (app) {
    case null: renderLauncher(view); break;
    case 'audio': renderAudio(view); break;
    case 'prowl': renderProwl(view); break;
    case 'sat':
      if (state.ham.sat.view === 'orbcomm') renderOrbcomm(view);
      else if (state.ham.sat.view === 'packet') renderPacketSats(view);
      else renderSat(view, satStrip());
      break;
    case 'ham': renderHam(view); break;
    case 'adsb': renderAdsb(view); break;
    case 'ais': renderAis(view); break;
    case 'aprs': renderAprs(view); break;
    case 'pager': if (state.pagerMulti) renderHunt(view); else renderPacket(view, app); break;
    case 'ert': renderMeters(view); break;
    case 'lora': renderLora(view); break;
    case 'trains': renderTrains(view); break;
    case 'btle': case 'tpms': case 'acars': case 'subghz': renderPacket(view, app); break;
    case 'devices': renderR433(view); break;
    case 'lookingglass': case 'search': renderSweep(view, app); break;
    case 'capture': renderCapture(view); break;
    case 'transmit': renderTx(view); break;
    case 'troll': renderTroll(view); break;
    case 'settings': renderSettings(view); break;
  }
  if (app && app !== 'settings') {
    const def = APPS.find(a => a.id === app)!;
    const title = CARD_TITLE[app];
    if (!q('#ftag')?.textContent) setFace(title?.[0] ?? barLabel(app), title?.[1] ?? def.blurb.toUpperCase());
    if (!q('#lamp b')?.textContent) setLamp(state.connected ? 'LISTENING' : 'NO RADIO', state.connected ? 'amber' : '', state.connected);
  } else if (!app) { setFace('HOME', 'TAP THE WATERFALL TO LISTEN'); setLamp(state.connected ? 'LIVE' : 'NO RADIO', state.connected ? 'ok' : ''); }
  wireCommon(view);
  bindHs(view);
  refreshReadout(); setGains(state.lna, state.vga, state.amp); setMode(state.mode);
  refreshShell();
  window.scrollTo(0, 0);
}

function renderLauncher(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual launch-visual">${readoutHtml()}<div id="launch-scope" class="launch-scope"></div><div id="launch-line" class="launch-line"></div>
    <div class="launch-radio"><div class="caption">BANDS</div>${hsHtml(`<div class="row wrap bandrow">${bandChipsHtml()}</div>`, 'bandhs')}<div class="launch-gain">${gainHtml()}</div></div></section>
    <section class="controls launch-side"><div class="grid launch-grid">${(['Receive', 'Analyze', 'Transmit', 'Tools'] as const).map(c => {
      const apps = APPS.filter(a => a.cat === c); if (!apps.length) return '';
      // each group's name over its tiles: a grid two to a row on a phone, one sideways row when wide (as on iPad)
      return `<div class="lgrp"><div class="gcat" style="color:${tint(c)}">${c.toUpperCase()}</div><div class="lgrp-in">` + apps.map(a => `<button class="tile" data-app="${a.id}" style="--tint:${tint(a.cat)}"><div class="tile-top">${glyph(a.id, tintHex(a.cat), 36)}<span class="cat">${a.cat.toUpperCase()}</span></div><div class="tile-title">${a.title}</div><div class="tile-blurb">${a.blurb}</div></button>`).join('') + '</div></div>';
    }).join('')}</div>
    <div class="foot"><span id="version">${versionText}</span> · <a id="release-link" href="${releaseUrl}">release</a> · <a href="https://github.com/RocketGod-git/mayhem-mobile">source</a> · GPL-3.0 · a port of <a href="https://github.com/portapack-mayhem/mayhem-firmware">PortaPack Mayhem</a><br>made by <a href="https://rocketgod.dev">RocketGod</a> · The Pirates' Plunder · <a href="https://discord.gg/thepirates">discord.gg/thepirates</a></div></section>`;
  scope = attach(tunableScope('launch-scope', 70, 90));
  scope.setLabels(centredLabels(state.freq, state.rate));
  qa<HTMLButtonElement>('[data-app]', view).forEach(b => b.onclick = () => open(b.dataset.app as AppId));
  // Restore the app strip to where it was, and keep track as it moves, so opening an app and coming back does not
  // jump it to the start (the strip scrolls sideways on a phone, down on a wide screen — remember both).
  const strip = view.querySelector<HTMLElement>('.launch-side');
  if (strip) {
    const restore = () => { strip.scrollLeft = launchScroll.x; strip.scrollTop = launchScroll.y; };
    restore(); requestAnimationFrame(restore);
    strip.addEventListener('scroll', () => { launchScroll.x = strip.scrollLeft; launchScroll.y = strip.scrollTop; }, { passive: true });
  }
  refreshLauncherLimits();
}

/**
 * Dim the apps the connected radio cannot serve.
 *
 * Only ever dims: the tiles stay live, because a dongle owner may still want two-metre HAM and should not be
 * stopped from trying. With nothing connected, or with a radio that can do everything, this changes nothing at
 * all - which is what keeps a HackRF session looking exactly as it always did.
 */
function refreshLauncherLimits(): void {
  qa<HTMLElement>('[data-app]').forEach(b => {
    const id = b.dataset.app ?? '';
    const why = radio ? blockedBecause(APP_NEEDS[id], radio.limits) : '';
    b.classList.toggle('limited', !!why);
    if (why) b.title = `${APPS.find(a => a.id === id)?.title ?? id} on a ${radio?.label}: ${why}`;
    else b.removeAttribute('title');
  });
}

/** Tell the worker how many spectrum bins this scope can show (it sizes the FFT to match). */
/**
 * How finely to split the span. The waterfall only needs one bin per column, but the signal finder needs enough
 * resolution to measure a channel's width: at 20 MHz across 680 columns a bin is 29 kHz, and a 12.5 kHz channel
 * is then narrower than one bin and cannot be told from a carrier. The hunting app asks for far more.
 */
const wantBins = (bins: number) => state.app === 'prowl' ? Math.min(8192, Math.max(4096, bins)) : bins;
function attach(s: Scope): Scope {
  worker?.postMessage({ type: 'config', specBins: wantBins(s.bins) });
  s.onResize = bins => worker?.postMessage({ type: 'config', specBins: wantBins(bins) });
  s.setChannel(state.mode === 'NONE' ? null : CHANNEL_BW[state.mode] / state.rate);
  return s;
}

/** Center of the waterfall span: the tuned frequency, except in HAM where the LO stays put and the channel moves. */
const spanCenter = () => state.app === 'ham' ? state.hamLo : tunesInSpan() ? state.viewLo : state.freq;
/** What the worker's classifier last saw in the span (center, −6 / −20 dB widths, class). */
interface SeenSignal { hz: number; db: number; snr: number; bw: number; cls: string; conf: number; val: number }
let lastSignals: SeenSignal[] = [];
/** The classified signal under a tap, if the tap landed on (or right beside) one. */
function signalAt(hz: number): SeenSignal | null {
  const reach = 24 * state.rate / (scope?.zoom ?? 1) / (scope?.cssWidth ?? 1000);   // 24 CSS px of the visible span: a fingertip
  // a tap inside a signal's -6 dB band takes the strongest such signal (a wide station beats a bump on its shoulder);
  // otherwise the nearest signal within a fingertip
  let inside: SeenSignal | null = null, near: SeenSignal | null = null, nearD = Infinity;
  for (const s of lastSignals) {
    const d = Math.abs(s.hz - hz);
    if (d <= s.bw / 2 + reach / 3 && (!inside || s.db > inside.db)) inside = s;
    if (d <= reach && d < nearD) { near = s; nearD = d; }
  }
  return inside ?? near;
}
/**
 * Where to put the dial for a signal: its measured center, pulled onto the band's channel raster when it is
 * within a third of a step (a repeater measured 200 Hz off still reads 146.520). SSB humps sit above (USB) or
 * below (LSB) the suppressed carrier, so the dial goes to the carrier.
 */
function signalDial(s: SeenSignal): number {
  let hz = s.hz;
  if (s.cls === 'USB') hz -= s.bw / 2 + 300; else if (s.cls === 'LSB') hz += s.bw / 2 + 300;
  const raster = rasterStep(), onRaster = Math.round(hz / raster) * raster;
  const wide = s.cls === 'WFM' || s.cls === 'WIDE' || s.bw > 60_000;   // broadcast-class signals always sit on the raster
  if (Math.abs(onRaster - hz) < (wide ? raster / 2 : Math.max(raster / 3, s.bw * 0.2))) return onRaster;
  return Math.round(hz / 100) * 100;
}
/**
 * Tapped a classified signal: open the filter to just cover it, and switch mode only when the shape is clear —
 * a wide hump (or anything in the FM broadcast band) is WFM, a confident label picks its mode, a doubtful one
 * ("WIDE?", "AM?") leaves the mode alone rather than putting a broadcast station through a 12.5 kHz FM demod.
 */
function fitSignal(s: SeenSignal): void {
  const bw = s.bw * 1.15;                                             // −6 dB width plus a little shoulder
  const wide = s.cls === 'WFM' || s.cls === 'WIDE' || s.bw > 60_000 || (s.hz > 87_500_000 && s.hz < 108_000_000);
  const sure = s.conf >= 0.6;
  if (state.app === 'ham') {
    const h = state.ham;
    const ssb = s.cls === 'USB' || s.cls === 'LSB' || s.cls === 'SSB';
    let want: HamMode = h.mode;
    if (wide) want = 'NFM';
    else if (sure) want = s.cls === 'CW' ? 'CW' : s.cls === 'AM' ? 'AM' : ssb ? (s.cls === 'LSB' || (s.cls === 'SSB' && s.hz < 10_000_000) ? 'LSB' : 'USB') : 'NFM';
    else if (h.mode === 'AM' && s.bw > 4500) want = 'NFM';          // an AM filter on a doubtful 5+ kHz hump is not it; FM is the safe guess
    if (h.mode !== want) hamSetMode(want);
    if (want === 'CW') hamSetWidth(bw < 180 ? 100 : bw < 400 ? 250 : bw < 800 ? 500 : 1000);
    else if (want === 'USB' || want === 'LSB') hamSetWidth(Math.max(1800, Math.min(3500, Math.round(bw / 100) * 100)));
    else if (want === 'AM') hamSetWidth(Math.max(4000, Math.min(10_000, Math.ceil(bw / 1000) * 1000)));
    else hamSetWidth(bw <= 8500 ? 8000 : bw <= 13_000 ? 12_500 : bw <= 17_000 ? 16_000 : bw <= 26_000 ? 25_000 : Math.min(48_000, Math.ceil(bw / 1000) * 1000));
    return;
  }
  if (state.app === 'audio') {
    let want: Mode = state.mode;
    if (wide) want = 'WFM';
    else if (sure) want = s.cls === 'AM' ? 'AM' : s.cls === 'USB' ? 'USB' : s.cls === 'LSB' || s.cls === 'SSB' ? 'LSB' : 'NFM';
    else if (state.mode === 'WFM' || state.mode === 'NONE') want = 'NFM';   // a narrow hump while in WFM: NFM is the safe guess
    if (state.mode !== want) setMode(want);
  }
}
/** A waterfall whose press-slide-release gesture retunes within the current span. */
/** Where the span was when a two-finger drag started, so the pan is absolute rather than accumulating. */
let spanDragFrom = 0;
function tunableScope(id: string, rows: number, spectrumHeight?: number): Scope {
  const snap = state.app === 'ham' ? 100 : 1000;
  const hzAt = (f: number) => spanCenter() + (f - 0.5) * state.rate;
  // release on a classified signal: snap to its center and fit the filter; elsewhere: the frequency under the finger
  const target = (f: number) => { const hz = hzAt(f), s = signalAt(hz); return s ? { hz: signalDial(s), s } : { hz: Math.round(hz / snap) * snap, s: null }; };
  return new Scope($(id), 0, {
    rows, spectrumHeight,
    onTap: f => {
      // the hunter's span stays put: a tap picks the carrier there for its own receiver (and turns AUTO off)
      if (state.app === 'pager' && state.pagerMulti) { worker?.postMessage({ type: 'hunt', cmd: 'pick', hz: hzAt(f) }); wakeAudio(); return; }
      const t = target(f); if (t.s) fitSignal(t.s); tune(t.hz, true); wakeAudio();
    },
    onPreview: f => previewFreq(f === null ? null : target(f).hz),
    labelAt: (f, zoom = 1) => ((spanCenter() + (f - 0.5) * state.rate) / 1e6).toFixed(zoom >= 8 ? 5 : zoom >= 2 ? 4 : 3),
    onChannel: state.app === 'ham' ? hamChannelEdges : undefined,
    onSlide: (f, done) => { const r = spanBarRange(); slideSpan(r.lo + f * (r.hi - r.lo), done); },
    onSpanStep: spanStep,
    canSpanStep: (dir) => spanStep(dir, true),
    onCenter: recentreView,
    onDragSpan: (delta, done) => {
      // Two fingers across a span already showing everything cannot pan within the view, so it moves the view
      // itself - which is what "pan the waterfall" means when you are looking at a whole band.
      if (!spanDragFrom) spanDragFrom = spanCenter();
      slideSpan(spanDragFrom - delta * state.rate, done);
      if (done) spanDragFrom = 0;
    },
  });
}
/** ⌖: bring the view back to the tuned channel (HAM parks the LO its usual 250 kHz above it, the receiver centers on it). */
function recentreView(): void {
  if (state.app === 'ham') {
    const h = state.ham; if (h.tab === 'monitor') { monitorOpen(); return; }
    const lo = hamLoFor(h.freq), d = lo - state.hamLo; if (!d) return;
    scope?.shiftSpan(d / state.rate); state.hamLo = lo; if (radio) radio.targetFreqHz = lo;
    hamSend(); refreshReadout(); refreshHamUi();
  } else if (state.app === 'audio') {
    const d = state.freq - state.viewLo; if (!d) return;
    scope?.shiftSpan(d / state.rate); state.viewLo = state.freq; if (radio) radio.targetFreqHz = state.viewLo;
    sendOffset(); refreshReadout(); refreshChannel();
  }
  settleSpanBar();
}
/** One wheel notch over the waterfall = one channel step of the band (10 with shift); trackpads accumulate. */
let wheelAcc = 0;
/** Channel raster under the dial: the band plan's step in HAM, the mode's natural spacing elsewhere. */
function rasterStep(): number {
  if (state.app !== 'ham') return state.mode === 'WFM' ? 100_000 : state.mode === 'NFM' ? 12_500 : state.mode === 'AM' ? 10_000 : state.mode === 'NONE' ? STEPS[stepIdx] : 1000;
  const band = bandOf(state.ham.freq);
  return band?.step ?? (state.ham.freq < 30e6 ? 500 : 12_500);
}
/** One notch = the filter width rounded to the raster (never less than a raster step), so a notch never skips a signal the filter could hold. */
function wheelStep(): number {
  const raster = rasterStep(), bw = state.app === 'ham' ? hamWidth() : CHANNEL_BW[state.mode];
  return Math.max(raster, Math.round(bw / raster) * raster);
}
/** Sticky window the span bar covers: 24 spans wide, re-centered only when the span nears its edge (on release). */
let spanBar: { lo: number; hi: number } | null = null;
function spanBarRange(): { lo: number; hi: number } {
  // On the launcher the bar is the radio itself, end to end: one drag reaches anything it can tune. Everywhere
  // else it stays a window around where you are, which is what you want when you are working inside a band
  // rather than looking for one - and the launcher is the screen for looking for one.
  if (state.app === null) {
    const lim = radio?.limits;
    return { lo: Math.max(1e6, lim?.minHz ?? 1e6), hi: lim?.maxHz ?? 6_000_000_000 };
  }
  const c = spanCenter(), half = state.rate / 2, w = 24 * state.rate;
  if (!spanBar || c - half < spanBar.lo || c + half > spanBar.hi || spanBar.hi - spanBar.lo !== w) spanBar = { lo: Math.max(0, c - w / 2), hi: Math.max(w, c + w / 2) };
  return spanBar;
}
/** After a drag: if the span ended up near the window's edge, re-center the window so the next drag can go on. */
function settleSpanBar(): void {
  if (state.app === null) { syncLaunchBand(); refreshSpanBar(); return; }
  if (spanBar) { const c = spanCenter(), w = spanBar.hi - spanBar.lo; if (c - spanBar.lo < 0.12 * w || spanBar.hi - c < 0.12 * w) spanBar = null; }
  refreshSpanBar();
}

/**
 * Panning can carry the view out of the band the strip is pointing at, so keep the two in step.
 *
 * Landing in a band lights its chip and adopts the way you would listen there, which is what stops a drag from
 * 93 MHz to 433 leaving wideband FM running over a digital band and putting a wall of noise through the
 * speaker. Landing between bands lights nothing and changes nothing.
 */
function syncLaunchBand(): void {
  if (state.app !== null) return;
  const c = spanCenter();
  const b = LAUNCH_BANDS.find(x => c >= x.lo && c <= x.hi);
  qa<HTMLElement>('[data-lband]').forEach(el => el.classList.toggle('on', !!b && el.dataset.lband === b.id));
  if (!b || b.id === state.launchBand) return;
  state.launchBand = b.id;
  if (b.mode !== state.mode) {
    state.mode = b.mode;
    worker?.postMessage({ type: 'config', mode: b.mode });
    refreshChannel();
  }
}
function refreshSpanBar(): void {
  if (!scope) return;
  const r = spanBarRange(), w = r.hi - r.lo, c = spanCenter(), half = state.rate / 2;
  const mhz = (hz: number) => w > 2e9
    ? (hz >= 1e9 ? `${(hz / 1e9).toFixed(hz % 1e9 ? 1 : 0)} GHz` : `${Math.round(hz / 1e6)} MHz`)
    : (hz / 1e6).toFixed(w < 5e6 ? 3 : w < 50e6 ? 2 : 1);
  const span = state.rate % 1e6 ? `${(state.rate / 1e6).toFixed(2)} MHz` : `${state.rate / 1e6} MHz`;
  scope.setSpanBar((c - half - r.lo) / w, (c + half - r.lo) / w, mhz(r.lo), mhz(r.hi), span);
}
/**
 * Slide the view: the span's center (the radio's LO) goes to `hz` while the dial frequency stays put, so you can
 * look further along the band than the screen shows. The channel keeps playing as long as it is still inside the
 * span; slid out of it, the receiver goes quiet until it is back (or you tap a signal). The waterfall history
 * slides with the view. The monitor tab re-plants its whole channel set on the new center on release.
 */
function slideSpan(hz: number, done = true, clamp = true): void {
  const half = state.rate / 2;
  if (clamp) { const r = spanBarRange(); hz = Math.min(r.hi - half, Math.max(r.lo + half, hz)); }
  hz = Math.max(1_000_000, hz);
  const raster = rasterStep(), d = Math.round((hz - spanCenter()) / raster) * raster;
  if (state.app === 'ham' && state.ham.tab === 'monitor') { if (done && d) monitorOpen(state.hamLo + d); return; }
  if (d) {
    scope?.shiftSpan(d / state.rate);
    if (state.app === 'ham') { state.hamLo += d; if (radio) radio.targetFreqHz = state.hamLo; hamSend(); refreshReadout(); refreshHamUi(); }
    // The launcher moves its view the same way the receiver does: the span slides and the tuned channel keeps
    // the frequency it had. Going through tune() instead would be clamped back inside the span, since a tap
    // there is deliberately not allowed to move the view.
    else if (state.app === 'audio' || state.app === null) { state.viewLo += d; if (radio) radio.targetFreqHz = state.viewLo; sendOffset(); refreshReadout(); refreshChannel(); }
    else tune(state.freq + d);
  }
  if (done) settleSpanBar();
}
/** A filter edge was dragged on the waterfall: turn the new band (full-span fractions) into the mode's lo / hi. */
function hamChannelEdges(loF: number, hiF: number, which: 'lo' | 'hi'): void {
  const h = state.ham, off = h.freq - state.hamLo;
  const a = Math.round((loF - 0.5) * state.rate - off), b = Math.round((hiF - 0.5) * state.rate - off);   // Hz relative to the carrier
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (h.mode === 'USB') { h.lo = clamp(a, 0, 5000); h.hi = clamp(b, h.lo + 100, 6000); }
  else if (h.mode === 'LSB') { h.lo = clamp(-b, 0, 5000); h.hi = clamp(-a, h.lo + 100, 6000); }
  else if (h.mode === 'CW') { const w = clamp(b - a, 50, 2000); h.lo = 0; h.hi = w; }
  else { h.hi = clamp(Math.abs(which === 'lo' ? a : b), h.mode === 'AM' ? 1500 : 2500, h.mode === 'NFM' ? 25_000 : 12_000); h.lo = 0; }   // symmetric modes follow the edge being dragged
  h.shift = 0;
  hamSend(); refreshHamUi();
  const seg = q('#ham-seg'); if (seg) seg.textContent = h.mode === 'USB' || h.mode === 'LSB' ? `filter ${h.lo}–${h.hi} Hz` : h.mode === 'CW' ? `filter ${h.hi} Hz` : `filter ±${h.hi} Hz (${(2 * h.hi / 1000).toFixed(1)} kHz)`;
}
/** Demodulated channel width per mode, shown as a shaded band on the waterfall. */
const CHANNEL_BW: Record<Mode, number> = { WFM: 200_000, NFM: 12_500, AM: 10_000, USB: 3_000, LSB: 3_000, NONE: 0 };
function refreshChannel(): void { if (state.app === 'ham') { refreshHamChannel(); return; } if (state.app === 'pager' && state.pagerMulti) { huntChannel(); return; } scope?.setChannel(state.mode === 'NONE' ? null : CHANNEL_BW[state.mode] / state.rate, tunesInSpan() ? 0.5 + (state.freq - state.viewLo) / state.rate : 0.5); }

// ---- HAM ---------------------------------------------------------------------------------------------------------
const HAM_RATE = 1_920_000, HAM_GUARD = 120_000, HAM_LO_OFFSET = 250_000;
/** Span ladders for zooming out past 1×: HAM rates keep the 48 k audio chain exact, receiver rates are round. 20 Msps is all a HackRF can see. */
const HAM_RATES = [1_920_000, 3_840_000, 7_680_000, 15_360_000, 19_200_000];
const RX_RATES = [1_920_000, 3_840_000, 7_680_000, 15_360_000, 19_200_000];
let hamRateIdx = 0;
/** Phones stop at 3.84 Msps (the JS front end and the USB link would not keep up); desktops may go all the way. */
const maxRateIdx = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 1 : HAM_RATES.length - 1;
/** The zoom control went past 1×: widen (−1) or narrow (+1) the span by moving one rung on the rate ladder. */
function spanStep(dir: -1 | 1, dry = false): boolean {
  if (state.app === 'ham') {
    const h = state.ham;
    if (h.tab === 'monitor') { if (window.innerWidth < 720 || h.mon.wide === (dir < 0)) return false; if (dry) return true; h.mon.wide = dir < 0; open('ham'); return true; }
    const i = Math.min(maxRateIdx(), Math.max(0, hamRateIdx - dir));
    if (i === hamRateIdx) return false;
    if (dry) return true;
    hamRateIdx = i; setRate(HAM_RATES[i]); scope?.clear(); hamSend(); refreshHamUi(); refreshChannel();
    return true;
  }
  if (state.app === 'audio') {
    // the rung at or above the span now (an RTL-SDR's 2.4 Msps sits between two)
    const at = RX_RATES.findIndex(r => r >= state.rate), cur = at < 0 ? RX_RATES.length - 1 : at;
    const i = Math.min(maxRateIdx(), Math.max(0, cur - dir));
    if (i === cur && RX_RATES[i] === state.rate) return false;
    if (dry) return true;
    spanByHand = true;
    setRate(RX_RATES[i]); scope?.clear(); refreshChannel();
    return true;
  }
  return false;
}
const HAM_WIDTHS: Record<HamMode, [string, number][]> = {
  USB: [['1.8k', 1800], ['2.4k', 2400], ['2.7k', 2700], ['3.0k', 3000], ['3.5k', 3500]],
  LSB: [['1.8k', 1800], ['2.4k', 2400], ['2.7k', 2700], ['3.0k', 3000], ['3.5k', 3500]],
  CW: [['100', 100], ['250', 250], ['500', 500], ['1k', 1000]],
  AM: [['4k', 4000], ['6k', 6000], ['8k', 8000], ['10k', 10000]],
  NFM: [['8k', 8000], ['12.5k', 12500], ['16k', 16000], ['25k', 25000]],
  WFM: [['200k', 200_000]],   // broadcast FM is one width; the value is the full channel, hi = half of it
};
const hamWidth = () => { const h = state.ham; return h.mode === 'USB' || h.mode === 'LSB' ? h.hi - h.lo : h.mode === 'CW' ? h.hi - h.lo : h.hi * 2; };
/** Place the LO so the channel sits HAM_LO_OFFSET below it, clear of the DC spike, with the band to both sides. */
const hamLoFor = (hz: number) => hz + HAM_LO_OFFSET;
/**
 * The satellite app. It was a tab inside HAM, which made no sense once there was more than one kind of satellite
 * to listen to: the amateur birds you track and talk through, and the constellations you simply receive.
 */
function satAppOpen(): void {
  const h = state.ham;
  h.tab = 'sat';
  if (h.sat.view === 'orbcomm') {
    configure('NFM', ORB_SPAN_CENTER, 2e6, 32, 32, false, 'orbcomm');
    requestGeo(); render('sat');
    tune(state.orb.channel);                              // the channel moves inside the span, the radio does not
    return;
  }
  if (h.sat.view === 'packet') {
    if (!state.home) requestGeo();
    state.hamLo = hamLoFor(h.freq);
    configure('NFM', state.hamLo, HAM_RATES[hamRateIdx], 32, 40, false, 'ham');
    state.freq = h.freq;
    render('sat'); hamSend();
    worker?.postMessage({ type: 'satService', kind: state.psat.framing });
    return;
  }
  satOpen();
  state.hamLo = hamLoFor(h.freq);
  configure('NONE', state.hamLo, HAM_RATES[hamRateIdx], 32, 40, false, 'ham');
  state.freq = h.freq;
  render('sat');
  hamSend();
}
/** The halves of the satellite app: tracking what is overhead, packet cubesats, and the ORBCOMM fleet. */
function satStrip(): string {
  const v = state.ham.sat.view;
  return segHtml([['track', 'TRACK'], ['packet', 'PACKET'], ['orbcomm', 'ORBCOMM']].map(([k, l]) => `<button class="${v === k ? 'on' : ''}" data-satview="${k}">${l}</button>`), 'sattabs');
}

function hamOpen(): void {
  const h = state.ham;
  if (h.tab === 'sat') h.tab = 'rx';                   // satellites left HAM and became their own app
  // a dongle starts at 24 MHz: a channel it cannot reach (FT8 at 14.074, say) opens on the 2 m calling frequency
  if (radio && !canTune(radio.limits, h.freq)) { h.freq = 146_520_000; h.rev = false; if (h.mode !== 'NFM') hamSetMode('NFM'); }
  if (h.tab === 'monitor') { monitorOpen(); return; }
  if (h.tab === 'digi' && h.digi.mode === 'ft8' && h.mode !== 'USB') hamSetMode('USB');
  if (h.tab === 'digi' && (h.digi.mode === 'dmr' || h.digi.mode === 'p25') && h.mode !== 'NFM') hamSetMode('NFM');
  state.hamLo = hamLoFor(h.freq);
  configure('NONE', state.hamLo, HAM_RATES[hamRateIdx], 32, 40, false, 'ham');
  state.freq = h.freq;
  render('ham');
  hamSend();
}
/** MONITOR: the LO sits on the band (or the current channel) and every raster channel in the span is watched. */
function monitorOpen(at?: number): void {
  const h = state.ham, band = bandOf(h.freq);
  const rate = h.mon.wide && window.innerWidth >= 720 ? 3_840_000 : HAM_RATE;
  const center = at ?? (band && band.hi - band.lo <= rate ? Math.round((band.lo + band.hi) / 2) : h.freq + 10_000);
  state.hamLo = center;
  configure('NONE', center, rate, 32, 40, false, 'monitor');
  state.freq = h.freq;
  render('ham');
  monitorSend();
}
function digiSend(): void {
  const g = state.ham.digi;
  worker?.postMessage({ type: 'digital', mode: g.mode, pitch: state.ham.pitch, pskHz: g.pskHz, rttyBaud: g.rttyBaud, rttyShift: g.rttyShift, rttyRev: g.rttyRev, dmrSlot: g.dmrSlot });
  qa('[data-digi]').forEach(b => b.classList.toggle('on', b.dataset.digi === g.mode));
  qa('[data-dmrslot]').forEach(b => b.classList.toggle('on', Number(b.dataset.dmrslot) === g.dmrSlot));
  const dp = q('#dmr-panel'); if (dp) (dp as HTMLElement).hidden = !(g.mode === 'dmr' || g.mode === 'auto');
  const pp = q('#p25-panel'); if (pp) (pp as HTMLElement).hidden = !(g.mode === 'p25' || g.mode === 'auto');
  const sp = q('#sstv-panel'); if (sp) (sp as HTMLElement).hidden = !(g.mode === 'sstv' || g.mode === 'auto');
  qa('[data-pskhz]').forEach(b => b.classList.toggle('on', Number(b.dataset.pskhz) === g.pskHz));
  qa('[data-rtty]').forEach(b => b.classList.toggle('on', b.dataset.rtty === `${g.rttyBaud}/${g.rttyShift}`));
  const rv = q('#rtty-rev'); if (rv) rv.classList.toggle('on', g.rttyRev);
  const ftp = q('#ft8-panel'); if (ftp) (ftp as HTMLElement).hidden = !(g.mode === 'ft8' || g.mode === 'auto');
  const ftc = q('#ft8-clock'); if (ftc) ftc.textContent = '';
}
/** The DMR panel: what the decoder is locked to and who is talking on each time slot. */
function refreshDmr(): void {
  const g = state.ham.digi, s = g.dmr, head = q('#dmr-head'); if (!head) return;
  if (!s) { head.textContent = 'waiting for the decoder'; return; }
  head.textContent = s.locked ? `LOCKED · ${s.source === 'BS' ? 'repeater / base' : s.source === 'MS' ? 'mobile' : 'direct mode'} · color code ${s.cc >= 0 ? s.cc : '?'} · deviation ${(s.level * 48000 / (2 * Math.PI)).toFixed(0)} Hz · audio slot ${s.audioSlot}`
    : s.dv ? `${s.dv} sync seen · identification only (no ${s.dv} vocoder yet)` : 'searching for sync · tune a DMR channel in NFM';
  for (let i = 0; i < 2; i++) {
    const el = q(`#dmr-s${i + 1}`), sl = s.slots[i]; if (!el) continue;
    el.classList.toggle('voice', sl.voice);
    el.classList.toggle('on', s.locked && s.audioSlot === i + 1);
    const who = sl.tg || sl.src ? `${sl.group ? 'TG' : 'ID'} ${sl.tg} ← ${sl.src}${sl.alias ? ` “${sl.alias}”` : ''}` : 'no call seen';
    el.innerHTML = `<b>SLOT ${i + 1}${sl.voice ? ' · ▶ VOICE' : ''}${s.locked && s.audioSlot === i + 1 ? ' · 🔊' : ''}</b><span>${who}</span><span class="dim">${sl.last || (s.locked ? 'idle' : '—')}${sl.cc >= 0 ? ` · CC ${sl.cc}` : ''}${sl.errs > 0.02 ? ` · ${(sl.errs * 100).toFixed(0)}% frame errors` : ''}</span>`;
  }
}
/** P25 Phase 1: which system, which kind of frame, and who is talking. */
function refreshP25(): void {
  const s = state.ham.digi.p25, head = q('#p25-head'), call = q('#p25-call');
  if (!head || !call) return;
  if (!s || s.nac < 0) { head.textContent = 'searching for sync · tune a P25 channel in NFM'; call.innerHTML = '<b>NO CALL SEEN</b><span>—</span>'; return; }
  const stale = s.since > 2 * 48_000;
  head.textContent = s.locked ? `LOCKED · NAC ${s.nac.toString(16).toUpperCase()} · ${s.frames} frames${s.errs ? ` · ${s.errs} rejected` : ''}`
    : `last heard NAC ${s.nac.toString(16).toUpperCase()} · ${s.frames} frames`;
  const who = !(s.talkgroup || s.source) ? 'no link control yet'
    : s.lcf === 0x03 ? `radio ${s.talkgroup} ← ${s.source}` : `TG ${s.talkgroup} ← ${s.source}`;
  call.classList.toggle('voice', !stale && (s.duid === 0x5 || s.duid === 0xa));
  call.innerHTML = `<b>${esc(s.frame || '—')}${s.encrypted ? ' · 🔒 ENCRYPTED' : ''}</b><span>${esc(who)}</span><span class="dim">${stale ? 'idle' : 'receiving'}${s.lcf ? ` · LCF ${s.lcf.toString(16)}` : ''}</span>`;
}
function refreshFt8(): void {
  const g = state.ham.digi, el = q('#ft8-list'); if (!el) return;
  el.innerHTML = g.ft8.length ? g.ft8.slice(0, 60).map((r, i) => `<div class="li tap ${i % 2 ? 'alt' : ''} ${/^CQ /.test(r.text) ? 'gold' : ''}" data-ft8i="${i}"><span class="row2"><span>${r.utc}  ${String(r.snr).padStart(3)}  ${r.dt.toFixed(1)}  ${r.hz}</span><span>${r.text}</span></span></div>`).join('') : '<div class="empty">FT8 decodes appear every 15 s — tune a band\'s FT8 frequency in USB (the FT8 chip does that) · tap a decode to log the station</div>';
  qa<HTMLElement>('[data-ft8i]', el).forEach(row => row.onclick = () => { const r = g.ft8[Number(row.dataset.ft8i)]; if (!r) return; const tok = r.text.replace(/^CQ (DX|POTA|SOTA|[A-Z]{2}) /, 'CQ ').split(/\s+/); const call = tok[0] === 'CQ' ? tok[1] : tok[1] ?? tok[0]; const grid = tok.find(x => /^[A-R]{2}\d{2}$/.test(x)) ?? ''; logPrefill({ call: (call ?? '').replace(/^<|>$/g, ''), grid, rstR: String(r.snr), rstS: '', mode: 'FT8', notes: r.text }); });
}
let ft8Timer = 0;
function monitorSend(): void {
  const h = state.ham, band = bandOf(h.freq);
  worker?.postMessage({ type: 'monitorParams', params: { centreHz: state.hamLo, spacingHz: h.mon.spacing, originHz: band?.lo ?? Math.floor(h.freq / 1e6) * 1e6, thresholdDb: h.mon.threshold, mode: h.mon.mode, lock: h.mon.lock, maxDemods: window.innerWidth >= 720 ? 4 : 2, volume: h.volume } });
}
function onMonitor(m: Record<string, unknown>): void {
  const mon = state.ham.mon;
  const prevOpen = mon.open;
  mon.first = m.first as number; mon.count = m.count as number; mon.snr = m.snr as Float32Array; mon.open = m.open as number[]; mon.listening = m.listening as number[];
  mon.tones = m.tones as Record<number, number>; mon.dcs = m.dcs as Record<number, number>; mon.since = m.since as number[];
  for (const k of mon.open) if (!prevOpen.includes(k)) { const t = new Date(); mon.log.unshift(`${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}  ${((mon.first + k * mon.spacing) / 1e6).toFixed(4)} MHz`); if (mon.log.length > 60) mon.log.length = 60; }
  refreshMonitor();
}
function refreshMonitor(): void {
  const mon = state.ham.mon, cv = q<HTMLCanvasElement>('#mon-grid'); if (!cv) return;
  const n = mon.count; if (!n) return;
  const dpr = window.devicePixelRatio || 1, cssW = cv.clientWidth || 300, cols = Math.min(n, Math.max(8, Math.floor(cssW / 22))), rows = Math.ceil(n / cols);
  const cellW = cssW / cols, cellH = 26, H = rows * cellH;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(cssW * dpr); cv.height = Math.round(H * dpr); cv.style.height = `${H}px`; }
  const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cssW, H);
  const s = currentSkin();
  g.font = '8px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let k = 0; k < n; k++) {
    const x = (k % cols) * cellW, y = Math.floor(k / cols) * cellH, snr = mon.snr[k] ?? 0, open = mon.open.includes(k), lis = mon.listening.includes(k);
    const t = Math.min(1, Math.max(0, snr / 30));
    g.fillStyle = open ? s.accent2 : `rgba(76,141,255,${(0.08 + t * 0.7).toFixed(2)})`;
    g.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
    if (lis) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4); }
    if (mon.lock === k) { g.strokeStyle = '#ff5b52'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2); }
    g.fillStyle = open ? '#05080a' : s.ink;
    const hz = mon.first + k * mon.spacing;
    g.fillText(((hz / 1e6) % 1).toFixed(mon.spacing >= 25_000 ? 3 : 4).slice(1), x + cellW / 2, y + 9);
    if (open) g.fillText(mon.tones[k] ? mon.tones[k].toFixed(1) : mon.dcs[k] ? `D${String(mon.dcs[k]).padStart(3, '0')}` : `+${Math.round(snr)}`, x + cellW / 2, y + 18);
  }
  const list = q('#mon-list');
  if (list) list.innerHTML = mon.open.length ? mon.open.map((k, i) => { const hz = mon.first + k * mon.spacing; return `<div class="li tap ${i % 2 ? 'alt' : ''}" data-monk="${k}"><span class="row2"><span>${(hz / 1e6).toFixed(4)} MHz${mon.listening.includes(k) ? ' 🔊' : ''}</span><span>+${Math.round(mon.snr[k])} dB · ${mon.tones[k] ? `CTCSS ${mon.tones[k].toFixed(1)}` : mon.dcs[k] ? `DCS ${String(mon.dcs[k]).padStart(3, '0')}` : '—'} · ${Math.round((mon.since[i] ?? 0) / 1000)}s</span></span></div>`; }).join('') : '<div class="empty">nothing open — watching every channel</div>';
  qa<HTMLElement>('[data-monk]', list ?? document).forEach(d => d.onclick = () => monitorLock(Number(d.dataset.monk)));
  const lg = q('#mon-log'); if (lg) lg.innerHTML = mon.log.length ? mon.log.slice(0, 30).map((l, i) => `<div class="li ${i % 2 ? 'alt' : ''}">${l}</div>`).join('') : '<div class="empty">activity log</div>';
  const st = q('#mon-status'); if (st) st.textContent = `${n} channels @ ${mon.spacing / 1e3} kHz · ${mon.open.length} open · ${mon.listening.length} playing`;
}
function monitorLock(k: number): void { const mon = state.ham.mon; if (mon.lock === k) { mon.lock = -1; mon.mode = 'mix'; } else { mon.lock = k; mon.mode = 'lock'; } monitorSend(); refreshMonitorChips(); refreshMonitor(); }
function refreshMonitorChips(): void {
  const mon = state.ham.mon;
  qa('[data-monmode]').forEach(b => b.classList.toggle('on', b.dataset.monmode === mon.mode));
  qa('[data-monsp]').forEach(b => b.classList.toggle('on', Number(b.dataset.monsp) === mon.spacing));
  qa('[data-monthr]').forEach(b => b.classList.toggle('on', Number(b.dataset.monthr) === mon.threshold));
  const w = q('#mon-wide'); if (w) w.classList.toggle('on', mon.wide);
}
function hamTune(hz: number): void {
  const h = state.ham;
  hz = Math.min(6_000_000_000, Math.max(1_000_000, Math.round(hz)));
  if (h.tab === 'monitor') {
    h.freq = hz; state.freq = hz; refreshReadout();
    // inside the monitored span: lock that channel; outside it: move the whole monitor there
    if (Math.abs(hz - state.hamLo) > state.rate / 2 - HAM_GUARD) { monitorOpen(); return; }
    const mon = h.mon; if (mon.count) { const k = Math.round((hz - mon.first) / mon.spacing); if (k >= 0 && k < mon.count) { mon.lock = k; mon.mode = 'lock'; monitorSend(); refreshMonitorChips(); refreshMonitor(); } }
    return;
  }
  h.freq = hz; state.freq = hz; setDial(hz);
  const off = hz - state.hamLo;
  if (Math.abs(off) > state.rate / 2 - HAM_GUARD || Math.abs(off) < 15_000) { state.hamLo = hamLoFor(hz); if (radio) radio.targetFreqHz = state.hamLo; }
  hamSend(); refreshReadout(); refreshHamUi();
}
function hamSetMode(m: HamMode): void {
  const h = state.ham; h.mode = m; h.shift = 0;
  if (m === 'USB' || m === 'LSB') { h.lo = 100; h.hi = 2800; }
  else if (m === 'CW') { h.lo = 0; h.hi = 500; }
  else if (m === 'AM') { h.lo = 0; h.hi = 3000; }
  else if (m === 'WFM') { h.lo = 0; h.hi = 100_000; }   // ±100 kHz: the 200 kHz broadcast channel
  else { h.lo = 0; h.hi = 6000; }
  hamSend(); refreshHamUi();
}
function hamSetWidth(w: number): void {
  const h = state.ham;
  if (h.mode === 'USB' || h.mode === 'LSB') { h.lo = 100; h.hi = 100 + w; }
  else if (h.mode === 'CW') { h.lo = 0; h.hi = w; }
  else h.hi = w / 2;
  hamSend(); refreshHamUi();
}
function hamSend(): void {
  const h = state.ham;
  const ssb = h.mode === 'USB' || h.mode === 'LSB';
  worker?.postMessage({ type: 'hamParams', params: { offsetHz: h.freq - state.hamLo, mode: h.mode, lo: ssb ? h.lo + h.shift : h.lo, hi: ssb ? h.hi + h.shift : h.hi, pitch: h.pitch, agc: h.agc, nr: h.nr, anf: h.anf, squelchDb: h.mode === 'NFM' ? h.squelch : 0, volume: h.volume } });
  refreshHamChannel();
}
/** Shade the demodulated pass band on the panadapter: SSB is one-sided, everything else symmetric. */
function refreshHamChannel(): void {
  const h = state.ham; if (!scope || state.app !== 'ham') return;
  let lo: number, hi: number;
  if (h.mode === 'USB') { lo = h.lo + h.shift; hi = h.hi + h.shift; }
  else if (h.mode === 'LSB') { lo = -(h.hi + h.shift); hi = -(h.lo + h.shift); }
  else if (h.mode === 'CW') { lo = -(h.hi - h.lo) / 2; hi = (h.hi - h.lo) / 2; }
  else { lo = -h.hi; hi = h.hi; }
  const off = h.freq - state.hamLo;
  scope.setChannel(Math.max(0.002, (hi - lo) / state.rate), 0.5 + (off + (lo + hi) / 2) / state.rate);
}
/** Rough dBm from dBFS: the HackRF's ADC clips near −5 dBm at zero gain, minus whatever gain is dialled in. */
function hamDbm(): number { return state.ham.db - 5 - state.lna - state.vga - (state.amp ? 14 : 0); }
function sUnits(dbm: number, hz: number): string {
  const s9 = hz >= 30e6 ? -93 : -73;
  if (dbm >= s9) return `S9+${Math.round(dbm - s9)}`;
  return `S${Math.max(0, Math.min(9, Math.round(9 + (dbm - s9) / 6)))}`;
}
/** The S-meter's scale on the card: S0 at the left, 6 dB an S-unit to S9, then dB over to S9+60. */
const HAM_SCALE: [number, string][] = ([[6, 'S1'], [18, '3'], [30, '5'], [42, '7'], [54, '9'], [74, '+20'], [94, '+40'], [114, '+60']] as [number, string][]).map(([u, l]) => [u / 114, l]);
function refreshHamCard(): void {
  if (state.app !== 'ham' && state.app !== 'sat') return;
  const h = state.ham, dbm = hamDbm(), s9 = h.freq >= 30e6 ? -93 : -73;
  if (state.app === 'ham') setFace(h.mode, ((segmentOf(h.freq) || 'outside the amateur bands') + (h.rev ? ' · reverse' : '')).toUpperCase());
  if (!q('#lscale span')?.textContent?.startsWith('S1')) setMeter(0, '', null, HAM_SCALE);
  setMeter(Math.min(1, Math.max(0, (dbm - (s9 - 54)) / 114)), `${sUnits(dbm, h.freq)} · ${dbm.toFixed(0)} dBm`);
  const tone = q('#ham-tone'), r = q('#capr'); if (r && tone) r.textContent = tone.textContent ?? '';
  if (!state.connected) setLamp('NO RADIO');
  else if (h.mode === 'NFM' && h.squelch > 0 && !h.open) setLamp('SQUELCHED');
  else if (h.mode === 'NFM' && h.squelch > 0) setLamp('OPEN', 'ok');
  else setLamp('RX', 'ok');
}
function refreshHamMeter(): void {
  const h = state.ham, bar = q('#sbar'), val = q('#sval'), tone = q('#ham-tone');
  if (bar) { const dbm = hamDbm(); const s9 = h.freq >= 30e6 ? -93 : -73; const frac = Math.min(1, Math.max(0, (dbm - (s9 - 54)) / 114)); bar.style.width = `${(frac * 100).toFixed(1)}%`; bar.classList.toggle('hot', dbm > s9 + 30); }
  if (val) val.textContent = `${sUnits(hamDbm(), h.freq)} · ${hamDbm().toFixed(0)} dBm est · +${(h.db - h.floor).toFixed(0)} dB · audio ${Math.round(h.audioPeak * 100)}%`;
  if (tone) {
    const parts: string[] = [];
    if (h.mode === 'NFM') { parts.push(h.open ? 'OPEN' : 'SQL'); if (h.tone) parts.push(`CTCSS ${h.tone.toFixed(1)}`); if (h.dcs) parts.push(`DCS ${String(h.dcs).padStart(3, '0')}${h.dcsInv ? 'I' : ''}`); if (!h.tone && !h.dcs && h.open) parts.push('no tone'); }
    else parts.push(h.agc === 'off' ? 'AGC off' : `AGC ${h.gain >= 1000 ? '60' : (20 * Math.log10(Math.max(1, h.gain))).toFixed(0)} dB`);
    tone.textContent = parts.join(' · ');
    tone.classList.toggle('open', h.mode === 'NFM' && h.open);
  }
  refreshHamCard();
}
function refreshHamUi(): void {
  const h = state.ham;
  qa('[data-hmode]').forEach(b => b.classList.toggle('on', b.dataset.hmode === h.mode));
  const widths = q('#ham-widths');
  if (widths && !widths.contains(document.activeElement)) {            // do not rebuild under a finger / cursor in the boxes
    const ssb = h.mode === 'USB' || h.mode === 'LSB';
    const boxes = ssb ? `<span class="fbox"><input class="txin num" data-fw="lo" value="${h.lo}" inputmode="numeric" title="low edge, Hz"> – <input class="txin num" data-fw="hi" value="${h.hi}" inputmode="numeric" title="high edge, Hz"> Hz</span>`
      : `<span class="fbox"><input class="txin num" data-fw="w" value="${hamWidth()}" inputmode="numeric" title="filter width, Hz"> Hz${h.mode === 'CW' ? '' : ' wide'}</span>`;
    widths.innerHTML = HAM_WIDTHS[h.mode].map(([l, w]) => `<button class="${hamWidth() === w ? 'on' : ''}" data-hw="${w}">${l}</button>`).join('') + boxes;
    qa<HTMLButtonElement>('[data-hw]').forEach(b => b.onclick = () => hamSetWidth(Number(b.dataset.hw)));
    qa<HTMLInputElement>('[data-fw]', widths).forEach(i => {
      const apply = () => {
        const v = Math.round(Number(i.value)); if (!Number.isFinite(v)) return;
        if (i.dataset.fw === 'w') hamSetWidth(Math.max(50, Math.min(50_000, v)));
        else { const lo = i.dataset.fw === 'lo' ? v : h.lo, hi = i.dataset.fw === 'hi' ? v : h.hi; h.lo = Math.max(0, Math.min(5000, lo)); h.hi = Math.max(h.lo + 100, Math.min(6000, hi)); h.shift = 0; hamSend(); refreshHamUi(); }
      };
      i.onchange = apply; i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); i.blur(); } };
    });
  }
  const agcRow = q('#ham-agcrow'); if (agcRow) (agcRow as HTMLElement).hidden = h.mode === 'NFM';
  qa('[data-agc]').forEach(b => b.classList.toggle('on', b.dataset.agc === h.agc));
  qa('[data-hsq]').forEach(b => b.classList.toggle('on', Number(b.dataset.hsq) === h.squelch));
  qa('[data-pitch]').forEach(b => b.classList.toggle('on', Number(b.dataset.pitch) === h.pitch));
  const nr = q('#ham-nr'); if (nr) nr.classList.toggle('on', h.nr);
  const anf = q('#ham-anf'); if (anf) anf.classList.toggle('on', h.anf);
  const cw = q('#ham-cw'); if (cw) (cw as HTMLElement).hidden = h.mode !== 'CW';
  const pbt = q('#ham-pbt'); if (pbt) (pbt as HTMLElement).hidden = !(h.mode === 'USB' || h.mode === 'LSB');
  const sq = q('#ham-sq'); if (sq) (sq as HTMLElement).hidden = h.mode !== 'NFM';
  const band = bandOf(h.freq);
  qa('[data-band]').forEach(b => b.classList.toggle('on', b.dataset.band === band?.id));
  const seg = q('#ham-seg'); if (seg) seg.textContent = segmentOf(h.freq) || 'outside the amateur bands';
  const rep = q('#ham-rep'), rin = repeaterInput(h.freq);
  if (rep) { (rep as HTMLElement).hidden = rin === null || h.mode !== 'NFM'; rep.textContent = 'REV'; rep.title = rin !== null ? `input ${(rin / 1e6).toFixed(4)} MHz` : ''; rep.classList.toggle('on', h.rev); }
  const steps = q('#ham-steps'); if (steps) { const st = band?.step ?? (h.freq < 30e6 ? 500 : 12_500); steps.innerHTML = [[-st * 10], [-st], [st], [st * 10]].map(([s]) => `<button class="chip" data-step="${s}">${s > 0 ? '+' : '−'}${Math.abs(s) >= 1e6 ? `${Math.abs(s) / 1e6}M` : Math.abs(s) >= 1e3 ? `${Math.abs(s) / 1e3}k` : Math.abs(s)}</button>`).join(''); qa<HTMLButtonElement>('[data-step]', steps).forEach(b => b.onclick = () => tune(state.freq + Number(b.dataset.step))); }
  refreshHamMeter();
}
/** HAM's bands as tiles with their ranges. */
function hamBandTiles(): string {
  const mhz = (hz: number) => hz < 30e6 ? (hz / 1e6).toFixed(1) : String(Math.round(hz / 1e6));
  return hsHtml(`<div class="tiles">${[...BANDS, ...NON_HAM].map(b => `<button class="tl" data-band="${b.id}"><b>${b.name}</b><small>${mhz(b.lo)}–${mhz(b.hi)}</small></button>`).join('')}</div>`);
}
function renderHam(view: HTMLElement): void {
  const h = state.ham;
  const tabs = segHtml(([['rx', 'RX'], ['monitor', 'MONITOR'], ['digi', 'DIGITAL'], ['tx', 'TX'], ['log', 'LOG']] as const).map(([id, l]) => `<button class="${h.tab === id ? 'on' : ''}" data-hamtab="${id}">${l}</button>`), 'hamtabs');
  if (h.tab === 'tx') { renderPtt(view, tabs); return; }
  if (h.tab === 'log') { renderLog(view, tabs); return; }
  if (h.tab === 'digi') {
    const g = h.digi;
    view.innerHTML = `
      <section class="visual">${readoutHtml()}
        <div class="smeter"><div class="sbar"><div id="sbar"></div><i style="left:${(54 / 114 * 100).toFixed(1)}%">S9</i></div><span id="sval" class="sval">—</span></div>
        <div class="hamline"><span id="digi-status" class="seg">${g.mode === 'off' ? 'pick a decoder' : g.mode.toUpperCase()}</span><span id="ham-tone" class="sq" hidden></span></div>
        <div id="scope" class="panel"></div></section>
      <section class="controls">${tabs}
        <div class="tgrid c3">${DIGI_TILES.map(([m, sub]) => `<button class="tl" data-digi="${m}"><b>${m.toUpperCase()}</b><small>${sub}</small></button>`).join('')}</div>
        <div class="ctlrow"><span class="rl">MODE</span>${segHtml((['USB', 'LSB', 'CW', 'NFM'] as const).map(m => `<button data-hmode="${m}">${m}</button>`))}<button id="digi-clear" class="ib" title="clear" aria-label="clear">${CLEAR_SVG}</button></div>
        <div id="p25-panel" hidden><div class="caption">P25 · <span id="p25-head">searching for sync</span></div>
          <div class="panel dmrslot" id="p25-call"></div></div>
        <div id="dmr-panel" hidden><div class="caption">DMR · <span id="dmr-head">searching for sync</span></div>
          <div class="dmrslots"><div class="panel dmrslot" id="dmr-s1"></div><div class="panel dmrslot" id="dmr-s2"></div></div>
          <div class="ctlrow"><span class="rl">HEAR</span>${segHtml([['0', 'LATEST'], ['1', 'SLOT 1'], ['2', 'SLOT 2']].map(([v, l]) => `<button data-dmrslot="${v}">${l}</button>`))}</div><div class="note">Both time slots are decoded; you hear one.</div></div>
        <div class="ctlrow"><span class="rl">PSK Hz</span>${segHtml([500, 1000, 1500, 2000].map(f => `<button data-pskhz="${f}">${f}</button>`))}</div>
        <div class="ctlrow"><span class="rl">RTTY</span>${segHtml([['45.45', '170'], ['50', '170'], ['75', '170'], ['45.45', '450'], ['50', '850']].map(([b, s]) => `<button data-rtty="${b}/${s}">${b === '45.45' ? '45' : b}/${s}</button>`), 'tight')}<button id="rtty-rev" class="tog">REV</button></div>
        <div class="caption">TEXT</div><pre id="digi-text" class="panel digitext">${g.text}</pre>
        <div id="sstv-panel" hidden>${imgPanelHtml()}${hsHtml(`<div class="tiles wide">${[['20m 14.230', 14_230_000, 'USB'], ['20m 14.233', 14_233_000, 'USB'], ['10m 28.680', 28_680_000, 'USB'], ['40m 7.171', 7_171_000, 'LSB'], ['ISS 145.800', 145_800_000, 'NFM']].map(([l, f, md]) => `<button class="tl" data-sstvf="${f}" data-sstvm="${md}"><b>${String(l).split(' ')[1]}</b><small>SSTV · ${String(l).split(' ')[0]} ${md}</small></button>`).join('')}</div>`)}</div>
        <div id="ft8-panel"><div class="caption">FT8 · <span id="ft8-clock"></span> · UTC  SNR  DT  Hz  message</div><div id="ft8-list" class="panel list"></div>
          ${hsHtml(`<div class="tiles">${[['160m', 1_840_000], ['80m', 3_573_000], ['40m', 7_074_000], ['30m', 10_136_000], ['20m', 14_074_000], ['17m', 18_100_000], ['15m', 21_074_000], ['12m', 24_915_000], ['10m', 28_074_000], ['6m', 50_313_000], ['2m', 144_174_000]].map(([l, f]) => `<button class="tl" data-ft8f="${f}"><b>${l}</b><small>${(Number(f) / 1e6).toFixed(3)}</small></button>`).join('')}</div>`)}</div>
        ${gainHtml()}
      </section>`;
    scope = attach(tunableScope('scope', 200));
    qa<HTMLButtonElement>('[data-hamtab]', view).forEach(b => b.onclick = () => { h.tab = b.dataset.hamtab as typeof h.tab; open('ham'); });
    qa<HTMLButtonElement>('[data-digi]', view).forEach(b => b.onclick = () => { g.mode = b.dataset.digi as typeof g.mode; if (g.mode === 'ft8' && h.mode !== 'USB') hamSetMode('USB'); if (g.mode === 'cw' && h.mode !== 'CW') hamSetMode('CW'); if ((g.mode === 'dmr' || g.mode === 'p25') && h.mode !== 'NFM') hamSetMode('NFM'); if ((g.mode === 'psk31' || g.mode === 'rtty') && h.mode !== 'USB' && h.mode !== 'LSB') hamSetMode('USB'); digiSend(); });
    qa<HTMLButtonElement>('[data-dmrslot]', view).forEach(b => b.onclick = () => { g.dmrSlot = Number(b.dataset.dmrslot); digiSend(); });
    qa<HTMLButtonElement>('[data-sstvf]', view).forEach(b => b.onclick = () => { g.mode = 'sstv'; const md = b.dataset.sstvm as HamMode; if (h.mode !== md) hamSetMode(md); hamTune(Number(b.dataset.sstvf)); digiSend(); });
    imgBind();
    qa<HTMLButtonElement>('[data-hmode]', view).forEach(b => b.onclick = () => hamSetMode(b.dataset.hmode as HamMode));
    qa<HTMLButtonElement>('[data-pskhz]', view).forEach(b => b.onclick = () => { g.pskHz = Number(b.dataset.pskhz); digiSend(); });
    qa<HTMLButtonElement>('[data-rtty]', view).forEach(b => b.onclick = () => { const [bd, sh] = b.dataset.rtty!.split('/'); g.rttyBaud = Number(bd); g.rttyShift = Number(sh); digiSend(); });
    $('rtty-rev').onclick = () => { g.rttyRev = !g.rttyRev; digiSend(); };
    $('digi-clear').onclick = () => { g.text = ''; g.ft8 = []; $('digi-text').textContent = ''; refreshFt8(); };
    qa<HTMLButtonElement>('[data-ft8f]', view).forEach(b => b.onclick = () => { g.mode = 'ft8'; if (h.mode !== 'USB') hamSetMode('USB'); hamTune(Number(b.dataset.ft8f)); digiSend(); });
    clearInterval(ft8Timer);
    ft8Timer = window.setInterval(() => { const c = q('#ft8-clock'); if (!c) { clearInterval(ft8Timer); return; } const s = (Date.now() / 1000) % 15; c.textContent = `${(15 - s).toFixed(0)} s to next slot`; }, 500);
    refreshHamUi(); digiSend(); refreshFt8(); refreshDmr(); refreshP25();
    return;
  }
  if (h.tab === 'monitor') {
    view.innerHTML = `
      <section class="visual">${readoutHtml()}
        <div class="hamline"><span id="mon-status" class="seg">monitor</span><span id="ham-tone" class="sq" hidden></span></div>
        <div id="scope" class="panel"></div></section>
      <section class="controls">${tabs}
        <div class="caption">CHANNELS · tap to lock one, tap again to mix</div><canvas id="mon-grid" class="mongrid"></canvas>
        <div class="caption">OPEN NOW</div><div id="mon-list" class="panel list short"></div>
        <div class="caption">LISTEN</div><div class="row">${(['mix', 'latest', 'lock'] as const).map(m => `<button class="chip" data-monmode="${m}">${m.toUpperCase()}</button>`).join('')}</div>
        <div class="caption">RASTER · THRESHOLD · SPAN</div><div class="row">${[12_500, 25_000].map(s => `<button class="chip" data-monsp="${s}">${s / 1e3} kHz</button>`).join('')}${[6, 8, 12].map(t => `<button class="chip" data-monthr="${t}">+${t} dB</button>`).join('')}<button id="mon-wide" class="chip" ${window.innerWidth >= 720 ? '' : 'hidden'}>3.84 MHz</button></div>
        <div style="margin-top:6px">${hamBandTiles()}</div>
        <div class="caption">ACTIVITY</div><div id="mon-log" class="panel list short"></div>
        ${gainHtml()}
      </section>`;
    scope = attach(tunableScope('scope', 200));
    qa<HTMLButtonElement>('[data-hamtab]', view).forEach(b => b.onclick = () => { h.tab = b.dataset.hamtab as typeof h.tab; open('ham'); });
    qa<HTMLButtonElement>('[data-band]', view).forEach(b => b.onclick = () => { const band = [...BANDS, ...NON_HAM].find(x => x.id === b.dataset.band)!; h.freq = band.calling ?? band.lo; if (band.mode !== h.mode) hamSetMode(band.mode); h.mon.lock = -1; open('ham'); });
    qa<HTMLButtonElement>('[data-monmode]', view).forEach(b => b.onclick = () => { h.mon.mode = b.dataset.monmode as 'mix' | 'latest' | 'lock'; if (h.mon.mode !== 'lock') h.mon.lock = -1; monitorSend(); refreshMonitorChips(); });
    qa<HTMLButtonElement>('[data-monsp]', view).forEach(b => b.onclick = () => { h.mon.spacing = Number(b.dataset.monsp); monitorSend(); refreshMonitorChips(); });
    qa<HTMLButtonElement>('[data-monthr]', view).forEach(b => b.onclick = () => { h.mon.threshold = Number(b.dataset.monthr); monitorSend(); refreshMonitorChips(); });
    $('mon-wide').onclick = () => { h.mon.wide = !h.mon.wide; open('ham'); };
    refreshMonitorChips(); refreshMonitor();
    const band = bandOf(h.freq); qa('[data-band]').forEach(b => b.classList.toggle('on', b.dataset.band === band?.id));
    return;
  }
  view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <div class="smeter"><div class="sbar"><div id="sbar"></div><i style="left:${(54 / 114 * 100).toFixed(1)}%">S9</i></div><span id="sval" class="sval">—</span></div>
      <div class="hamline"><span id="ham-seg" class="seg"></span><span id="ham-tone" class="sq">—</span></div>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      <div style="margin-top:6px">${hamBandTiles()}</div>
      <div style="margin-top:6px">${segHtml((['LSB', 'USB', 'CW', 'AM', 'NFM', 'WFM'] as HamMode[]).map(m => `<button data-hmode="${m}">${m}</button>`))}</div>
      <div class="ctlrow"><span class="rl" id="ham-filter-cap">FILTER</span><div id="ham-widths" class="seg"></div></div>
      <div id="ham-pbt" class="hamfine"><div class="caption">PASSBAND SHIFT · <span id="pbt-val">0</span> Hz</div><input id="pbt" type="range" min="-600" max="600" step="50" value="${h.shift}"></div>
      <div id="ham-cw" class="hamfine"><div class="caption">CW PITCH · Hz</div><div class="row">${[500, 600, 700, 800].map(p => `<button class="chip" data-pitch="${p}">${p}</button>`).join('')}</div></div>
      <div class="ctlrow" id="ham-agcrow"><span class="rl">AGC</span>${segHtml((['off', 'fast', 'slow'] as AgcMode[]).map(a => `<button data-agc="${a}">${a.toUpperCase()}</button>`))}<button id="ham-nr" class="tog">NR</button><button id="ham-anf" class="tog">NOTCH</button></div>
      <div id="ham-sq" class="ctlrow"><span class="rl">SQL</span>${segHtml([0, 3, 6, 10, 15].map(d => `<button data-hsq="${d}">${d ? d : 'OFF'}</button>`))}<button id="ham-rep" class="tog" hidden>REV</button></div>
      <div class="hamfine"><div class="caption">VOLUME</div><input id="ham-vol" type="range" min="0" max="2" step="0.05" value="${h.volume}"></div>
      ${gainHtml()}
    </section>`;
  scope = attach(tunableScope('scope', 200));
  qa<HTMLButtonElement>('[data-hamtab]', view).forEach(b => b.onclick = () => { h.tab = b.dataset.hamtab as typeof h.tab; open('ham'); });
  qa<HTMLButtonElement>('[data-band]', view).forEach(b => b.onclick = () => { const band = [...BANDS, ...NON_HAM].find(x => x.id === b.dataset.band)!; h.rev = false; if (band.mode !== h.mode) hamSetMode(band.mode); hamTune(band.calling ?? band.lo); });
  qa<HTMLButtonElement>('[data-hmode]', view).forEach(b => b.onclick = () => hamSetMode(b.dataset.hmode as HamMode));
  qa<HTMLButtonElement>('[data-agc]', view).forEach(b => b.onclick = () => { h.agc = b.dataset.agc as AgcMode; hamSend(); refreshHamUi(); });
  qa<HTMLButtonElement>('[data-hsq]', view).forEach(b => b.onclick = () => { h.squelch = Number(b.dataset.hsq); hamSend(); refreshHamUi(); });
  qa<HTMLButtonElement>('[data-pitch]', view).forEach(b => b.onclick = () => { h.pitch = Number(b.dataset.pitch); hamSend(); refreshHamUi(); });
  $('ham-nr').onclick = () => { h.nr = !h.nr; hamSend(); refreshHamUi(); };
  $('ham-anf').onclick = () => { h.anf = !h.anf; hamSend(); refreshHamUi(); };
  $('ham-rep').onclick = () => { if (!h.rev) { const rin = repeaterInput(h.freq); if (rin === null) return; h.back = h.freq; h.rev = true; hamTune(rin); } else { h.rev = false; hamTune(h.back || h.freq); } };
  $<HTMLInputElement>('pbt').oninput = (e) => { h.shift = Number((e.target as HTMLInputElement).value); $('pbt-val').textContent = String(h.shift); hamSend(); };
  $<HTMLInputElement>('ham-vol').oninput = (e) => { h.volume = Number((e.target as HTMLInputElement).value); hamSend(); };
  refreshHamUi();
}

// ---- SATELLITE ---------------------------------------------------------------------------------------------------
let satTimer = 0;
function satOpen(): void {
  const s = state.ham.sat;
  if (!state.home) requestGeo();
  if (s.tles.size === 0) { s.status = 'fetching TLEs…'; fetchTles(SATS.map(x => x.norad)).then(m => { s.tles = m; s.status = `${m.size} TLEs`; satRefresh(true); }).catch(e => { s.status = `TLE fetch failed: ${(e as Error).message}`; satRefresh(); }); }
}
/** The selected bird and service; `sgp` is null until (unless) a TLE is available — tuning never waits for one. */
function satSel(): { def: typeof SATS[number]; svc: SatService; sgp: Sgp4 | null } | null {
  const s = state.ham.sat, def = SATS.find(x => x.norad === s.sel), tle = def && s.tles.get(def.norad);
  if (!def) return null;
  const svc = def.services[Math.min(s.svc, def.services.length - 1)];
  let sgp: Sgp4 | null = null;
  if (tle) { try { sgp = new Sgp4(tle); } catch { sgp = null; } }
  return { def, svc, sgp };
}
/** Put the receiver (and the worker's decoders) into the shape the selected service needs. */
function satApplyService(): void {
  const h = state.ham, cur = satSel(); if (!cur) return;
  const k = cur.svc.kind;
  const mode: HamMode = k === 'linear' ? 'USB' : k === 'cw' ? 'CW' : 'NFM';
  if (h.mode !== mode) hamSetMode(mode);
  if (k === 'apt' || k === 'lrpt') { h.hi = 20_000; hamSend(); }
  worker?.postMessage({ type: 'satService', kind: k });
  if (k === 'sstv') { h.digi.mode = 'sstv'; digiSend(); } else if (h.digi.mode === 'sstv') { h.digi.mode = 'off'; digiSend(); }
  h.sat.packets = []; imgReset();
  hamTune(cur.svc.down);
  const p = q('#sat-panel'); if (p) { (p as HTMLElement).hidden = !(k === 'packet' || k === 'sstv' || k === 'apt' || k === 'lrpt'); }
  const pk = q('#sat-packets'); if (pk) { (pk as HTMLElement).hidden = k !== 'packet'; }
  const im = q('#sat-image'); if (im) { (im as HTMLElement).hidden = !(k === 'sstv' || k === 'apt' || k === 'lrpt'); }
  const pt = q('#sat-ptt'); if (pt) { (pt as HTMLElement).hidden = !cur.svc.up; }
}
let satTrackAt = 0;
/** The map in the SATELLITE tab: where the bird is now, its footprint, and the next 90 minutes of ground track. */
function satMap(cur: NonNullable<ReturnType<typeof satSel>>): void {
  if (!geo || !cur.sgp) return;
  const home = state.home ?? { lat: 0, lon: 0 }, now = Date.now(), XKMPER = 6378.137;
  const l = look(cur.sgp, now, home.lat, home.lon);
  const label = state.home ? `${cur.def.name} · el ${l.el.toFixed(0)}°` : cur.def.name;
  geo.update([{ id: 'sat', lat: l.lat, lon: l.lon, label, kind: 'sat' }], 'sat');
  geo.setFootprint(l.lat, l.lon, XKMPER * Math.acos(XKMPER / (XKMPER + Math.max(100, l.altKm))));
  if (now - satTrackAt > 30_000) {
    satTrackAt = now;
    const pts: [number, number][] = [];
    for (let t = now; t <= now + 90 * 60_000; t += 60_000) { const p = look(cur.sgp, t, home.lat, home.lon); pts.push([p.lat, p.lon]); }
    geo.setTrack(pts);
  }
}
function satRefresh(recomputePasses = false): void {
  const s = state.ham.sat, cur = satSel(), home = state.home;
  const st = q('#sat-status'); if (st) st.textContent = s.status + (home ? ` · ${home.lat.toFixed(2)}, ${home.lon.toFixed(2)}` : ' · no GPS fix');
  qa('[data-sat]').forEach(b => b.classList.toggle('on', Number(b.dataset.sat) === s.sel));
  const svcRow = q('#sat-services');
  if (svcRow && cur) {
    const want = cur.def.services.map((x, i) => `<button class="tl ${i === s.svc ? 'on' : ''}" data-svc="${i}"><b>${x.name.toUpperCase()}</b><small>${(x.down / 1e6).toFixed(3)} MHz</small></button>`).join('');
    if (svcRow.innerHTML !== want) { svcRow.innerHTML = want; qa<HTMLButtonElement>('[data-svc]', svcRow).forEach(b => b.onclick = () => { s.svc = Number(b.dataset.svc); satApplyService(); satRefresh(); }); }
  }
  const trk = q('#sat-track'); if (trk) { trk.classList.toggle('on', s.track); trk.textContent = s.track ? 'LISTENING · DOPPLER ON' : 'LISTEN · TRACK DOPPLER'; }
  if (!cur) return;
  satMap(cur);
  const svc = cur.svc;
  const note = q('#sat-note'); if (note) note.textContent = `${svc.name} · ${(svc.down / 1e6).toFixed(4)} MHz down${svc.up ? ` · ${(svc.up / 1e6).toFixed(3)} up${svc.tone ? ` tone ${svc.tone}` : ''}` : ''}${svc.note ? ` · ${svc.note}` : ''}`;
  // What the satellite is, and what you would actually do on the service you picked.
  const what = q('#sat-what'); if (what) what.textContent = cur.def.what ?? '';
  const how = q('#sat-how');
  if (how) how.textContent = `${svc.up ? 'Two-way, license needed to transmit. ' : 'Receive only. '}${svc.how ?? ''}`.trim();
  const info = q('#sat-now');
  if (!cur.sgp) { if (info) info.innerHTML = `<div class="kv"><span>${cur.def.name}</span><span>${s.tles.size ? 'no orbit data from CelesTrak — retired or renamed; the receiver is tuned anyway' : 'waiting for orbit data…'}</span></div>`; const pl0 = q('#sat-passes'); if (pl0) pl0.innerHTML = '<div class="empty">no TLE, no passes</div>'; return; }
  if (!home) { if (info) info.innerHTML = `<div class="kv"><span>${cur.def.name}</span><span>allow location to get look angles, Doppler and passes</span></div>`; return; }
  const now = Date.now(), l = look(cur.sgp, now, home.lat, home.lon);
  const rx = doppler(svc.down, l.rangeRate), txf = svc.up ? dopplerUp(svc.up, l.rangeRate) : 0;
  if (info) info.innerHTML = `<div class="kv"><span>Now</span><span>az ${l.az.toFixed(0)}° · el ${l.el.toFixed(1)}° · ${l.rangeKm.toFixed(0)} km · ${l.rangeRate >= 0 ? '+' : ''}${(l.rangeRate).toFixed(2)} km/s${l.el < 0 ? ' · below the horizon' : ''}</span></div><div class="kv"><span>Receive</span><span>${(svc.down / 1e6).toFixed(4)} → <b>${(rx / 1e6).toFixed(4)} MHz</b> (${rx - svc.down >= 0 ? '+' : ''}${rx - svc.down} Hz)</span></div>${svc.up ? `<div class="kv"><span>Transmit</span><span>${(svc.up / 1e6).toFixed(4)} → <b>${(txf / 1e6).toFixed(4)} MHz</b>${svc.tone ? ` · CTCSS ${svc.tone.toFixed(1)}` : ' · no tone'}</span></div>` : ''}<div class="kv"><span>Sub-point</span><span>${l.lat.toFixed(1)}, ${l.lon.toFixed(1)} · ${l.altKm.toFixed(0)} km</span></div>`;
  if (recomputePasses || !s.passes.length) s.passes = passes(cur.sgp, home.lat, home.lon, now, 24);
  const pl = q('#sat-passes');
  if (pl) pl.innerHTML = s.passes.length ? s.passes.map((p, i) => { const a = new Date(p.aos), b = new Date(p.los); const live = now >= p.aos && now <= p.los; return `<div class="li ${i % 2 ? 'alt' : ''} ${live ? 'gold' : ''}"><span class="row2"><span>${live ? 'NOW · ' : ''}${a.getHours().toString().padStart(2, '0')}:${a.getMinutes().toString().padStart(2, '0')} → ${b.getHours().toString().padStart(2, '0')}:${b.getMinutes().toString().padStart(2, '0')} (${Math.round((p.los - p.aos) / 60000)} min)</span><span>max el ${p.maxEl.toFixed(0)}° · az ${p.aosAz.toFixed(0)}→${p.losAz.toFixed(0)}</span></span></div>`; }).join('') : '<div class="empty">no passes in the next 24 h</div>';
  if (s.track && s.dopplerOn && l.el > -5 && Math.abs(rx - state.ham.freq) > 25 && !state.ham.ptt.on) hamTune(rx);
}
/** Live image panel shared by SSTV (DIGITAL / SATELLITE) and APT (SATELLITE). */
function imgReset(): void { const im = state.ham.img; im.mode = ''; im.width = 0; im.height = 0; im.line = 0; im.done = false; im.apt = 0; im.lrpt.planes = {}; im.lrpt.lines = 0; im.lrpt.stats = ''; const c = q('#img-canvas') as HTMLCanvasElement | null; if (c) { c.width = 320; c.height = 240; c.getContext('2d')?.clearRect(0, 0, c.width, c.height); } const cap = q('#img-caption'); if (cap) cap.textContent = 'waiting for a picture'; }
function imgPanelHtml(): string { return `<div class="caption">PICTURE · <span id="img-caption">waiting for a picture</span></div><div class="imgwrap panel"><canvas id="img-canvas" width="320" height="240"></canvas></div><div class="row"><button id="img-save" class="chip">SAVE PNG</button><button id="img-clear" class="chip">CLEAR</button></div>`; }
function imgBind(): void {
  const save = q('#img-save'), clear = q('#img-clear');
  if (save) save.addEventListener('click', () => { const c = q('#img-canvas') as HTMLCanvasElement | null; if (!c) return; c.toBlob(b => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${state.ham.img.mode || 'image'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }, 'image/png'); });
  if (clear) clear.addEventListener('click', imgReset);
}
function onSstv(m: Record<string, unknown>): void {
  const im = state.ham.img, c = q('#img-canvas') as HTMLCanvasElement | null; if (!c) return;
  const width = m.width as number, height = m.height as number, line = m.line as number, count = m.count as number, rows = m.rows as Uint8ClampedArray;
  if (im.mode !== m.mode || im.width !== width || line === 0) { im.mode = m.mode as string; im.width = width; im.height = height; im.done = false; c.width = width; c.height = height; c.getContext('2d')!.fillStyle = '#000'; c.getContext('2d')!.fillRect(0, 0, width, height); }
  im.line = line + count; im.done = im.line >= height;
  c.getContext('2d')!.putImageData(new ImageData(rows, width, count), 0, line);
  const cap = q('#img-caption'); if (cap) cap.textContent = `SSTV ${im.mode} · ${width}×${height} · line ${im.line}${im.done ? ' · complete' : ''}`;
}
/** Meteor LRPT: three spectral channels arrive as 8-row strips; keep a plane per APID and paint a color composite. */
const LRPT_W = 1568;
function lrptPlane(apid: number, lines: number): Uint8Array {
  const L = state.ham.img.lrpt, need = lines * 8 * LRPT_W;
  let p = L.planes[apid];
  if (!p || p.length < need) { const np = new Uint8Array(Math.max(need, (p?.length ?? 0) * 2, 64 * 8 * LRPT_W)); if (p) np.set(p); p = np; L.planes[apid] = p; }
  return p;
}
function onLrpt(m: Record<string, unknown>): void {
  const im = state.ham.img, L = im.lrpt, c = q('#img-canvas') as HTMLCanvasElement | null; if (!c) return;
  const apid = m.apid as number, line = m.line as number, x = m.x as number, px = m.pixels as Uint8Array;
  if (im.mode !== 'LRPT') { im.mode = 'LRPT'; im.width = LRPT_W; L.planes = {}; L.lines = 0; c.width = LRPT_W; c.height = 256; c.getContext('2d')!.fillStyle = '#000'; c.getContext('2d')!.fillRect(0, 0, c.width, c.height); }
  const plane = lrptPlane(apid, line + 1);
  for (let y = 0; y < 8; y++) plane.set(px.subarray(y * 112, y * 112 + 112), (line * 8 + y) * LRPT_W + x);
  if (line + 1 > L.lines) L.lines = line + 1;
  const rowsNeeded = L.lines * 8;
  if (c.height < rowsNeeded) { const ctx = c.getContext('2d')!, keep = ctx.getImageData(0, 0, c.width, c.height); c.height = rowsNeeded + 256; ctx.putImageData(keep, 0, 0); }
  // composite: red 66 (or 68), green 65 (or 67), blue 64; a missing plane borrows the one that arrived
  const P = L.planes, r = P[66] ?? P[68] ?? P[apid], g = P[65] ?? P[67] ?? P[apid], b = P[64] ?? P[apid];
  const out = new Uint8ClampedArray(8 * 112 * 4);
  for (let y = 0; y < 8; y++) for (let k = 0; k < 112; k++) {
    const src = (line * 8 + y) * LRPT_W + x + k, o = (y * 112 + k) * 4;
    out[o] = r[src] ?? 0; out[o + 1] = g[src] ?? 0; out[o + 2] = b[src] ?? 0; out[o + 3] = 255;
  }
  c.getContext('2d')!.putImageData(new ImageData(out, 112, 8), x, line * 8);
  const cap = q('#img-caption'); if (cap) cap.textContent = `LRPT · ${L.lines} lines · channels ${Object.keys(P).join(', ')}${L.stats ? ` · ${L.stats}` : ''}`;
}
function onLrptStats(m: Record<string, unknown>): void {
  const s = m.stats as { lock: boolean; freqHz: number; ber: number; rs: number; frames: number; badFrames: number };
  state.ham.img.lrpt.stats = s.lock ? `locked · ${s.freqHz >= 0 ? '+' : ''}${s.freqHz.toFixed(0)} Hz · BER ${(s.ber * 100).toFixed(1)}% · RS ${s.rs < 0 ? 'fail' : s.rs} · frames ${s.frames}/${s.frames + s.badFrames}` : `searching (offset ${s.freqHz.toFixed(0)} Hz)`;
  const cap = q('#img-caption'); if (cap && state.ham.img.mode !== 'SSTV' && state.ham.img.mode !== 'APT') cap.textContent = `LRPT · ${state.ham.img.lrpt.lines} lines · ${state.ham.img.lrpt.stats}`;
}
function onApt(m: Record<string, unknown>): void {
  const im = state.ham.img, c = q('#img-canvas') as HTMLCanvasElement | null; if (!c) return;
  const row = m.row as Uint8ClampedArray, line = m.line as number;
  if (im.mode !== 'APT' || line === 0) { im.mode = 'APT'; im.width = 2080; im.height = 0; im.apt = 0; c.width = 2080; c.height = 400; c.getContext('2d')!.fillStyle = '#000'; c.getContext('2d')!.fillRect(0, 0, c.width, c.height); }
  if (im.apt >= c.height) { const ctx = c.getContext('2d')!, keep = ctx.getImageData(0, 0, c.width, c.height); c.height += 400; ctx.putImageData(keep, 0, 0); }
  const px = new Uint8ClampedArray(2080 * 4);
  for (let k = 0; k < 2080; k++) { px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = row[k]; px[k * 4 + 3] = 255; }
  c.getContext('2d')!.putImageData(new ImageData(px, 2080, 1), 0, im.apt);
  im.apt++; im.line = im.apt;
  const cap = q('#img-caption'); if (cap) cap.textContent = `APT · ${im.apt} lines · channel A left, B right`;
}
function renderSat(view: HTMLElement, tabs: string): void {
  const h = state.ham, s = h.sat;
  view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <span id="ham-tone" hidden>—</span>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      ${hsHtml(`<div class="tiles auto">${SATS.map(x => `<button class="tl" data-sat="${x.norad}"><b>${x.name}</b><small>${x.services.map(v => v.name).join(' · ')}</small></button>`).join('')}</div>`)}
      <div id="sat-what" class="about"></div>
      <div class="rl offers">WHAT IT OFFERS · tap to set the receiver up for it</div>${hsHtml('<div id="sat-services" class="tiles auto"></div>')}
      <div id="sat-how" class="about"></div>
      <div id="sat-note" class="note"></div>
      <div class="ctlrow"><button id="sat-track" class="act grow">LISTEN · TRACK DOPPLER</button><button id="sat-refresh" class="tog">TLE ↻</button></div>
      <div id="sat-status" class="note">${s.status}</div>
      <button id="sat-ptt" class="chip ptt" hidden>PUSH TO TALK · UPLINK</button>
      <div id="tx-status" class="health"></div>
      <div id="sat-now" class="panel about"></div>
      <div id="sat-map" class="panel map"></div>
      <div id="sat-panel" hidden><div id="sat-packets" hidden><div class="caption">PACKETS HEARD</div><div id="sat-packet-list" class="panel list short"></div></div><div id="sat-image" hidden>${imgPanelHtml()}</div></div>
      <div class="caption">PASSES · next 24 h · local time</div><div id="sat-passes" class="panel list short"></div>
      ${gainHtml()}
    </section>`;
  scope = attach(tunableScope('scope', 200));
  qa<HTMLButtonElement>('[data-hamtab]', view).forEach(b => b.onclick = () => { pttStop(); worker?.postMessage({ type: 'satService', kind: 'none' }); h.tab = b.dataset.hamtab as typeof h.tab; open('ham'); });
  qa<HTMLButtonElement>('[data-satview]', view).forEach(b => b.onclick = () => { pttStop(); worker?.postMessage({ type: 'satService', kind: 'none' }); state.ham.sat.view = b.dataset.satview as typeof state.ham.sat.view; open('sat'); });
  qa<HTMLButtonElement>('[data-sat]', view).forEach(b => b.onclick = () => { s.sel = Number(b.dataset.sat); s.svc = 0; s.passes = []; satApplyService(); satRefresh(true); });
  $('sat-track').onclick = () => { s.track = !s.track; if (s.track) satApplyService(); satRefresh(); };
  $('sat-refresh').onclick = () => { try { localStorage.removeItem('mayhem.tle'); } catch { /* ignore */ } s.tles = new Map(); satOpen(); };
  const ptt = $('sat-ptt');
  const satPtt = () => { const cur = satSel(), home = state.home; if (!cur || !cur.svc.up) return; const rr = home && cur.sgp ? look(cur.sgp, Date.now(), home.lat, home.lon).rangeRate : 0; pttStart(dopplerUp(cur.svc.up, rr), cur.svc.tone ?? 0, ptt); };
  ptt.onpointerdown = (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); satPtt(); };
  ptt.onpointerup = ptt.onpointercancel = () => pttStop();
  ptt.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); satPtt(); } };
  ptt.onkeyup = (e) => { if (e.key === ' ' || e.key === 'Enter') pttStop(); };
  imgBind();
  geo = new GeoMap($('sat-map'), { home: state.home, onPick: () => undefined, log }); satTrackAt = 0;
  clearInterval(satTimer); satTimer = window.setInterval(() => { if (!q('#sat-now')) { clearInterval(satTimer); return; } satRefresh(); }, 1000);
  refreshHamUi(); satApplyService(); satRefresh(true);
  const pk = q('#sat-packet-list'); if (pk) { pk.innerHTML = s.packets.map((p, i) => `<div class="li tap ${i % 2 ? 'alt' : ''}">${p}</div>`).join(''); pk.onclick = (ev) => { const li = (ev.target as HTMLElement).closest('.li'); const m = li?.textContent?.match(/^\S+\s+([A-Z0-9-]+)>/); if (m) logPrefill({ call: m[1].replace(/-\d+$/, ''), mode: 'APRS', notes: li!.textContent!.slice(9) }); }; }
}

// ---- Logbook: contacts, callsign details, ADIF -------------------------------------------------------------------
function loadLog(): Qso[] { try { const v = JSON.parse(localStorage.getItem('mayhem.logbook') ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function saveLog(): void { try { localStorage.setItem('mayhem.logbook', JSON.stringify(state.ham.log.entries)); } catch { /* ignore */ } }
type Station = { call: string; grid: string; name: string; dmrId: string; aprsSsid: string; license: string };
function stationEmpty(): Station { return { call: '', grid: '', name: '', dmrId: '', aprsSsid: '9', license: '' }; }
function loadStation(): Station { try { return { ...stationEmpty(), ...JSON.parse(localStorage.getItem('mayhem.station') ?? '{}') }; } catch { return stationEmpty(); } }
/** The station callsign with the APRS SSID, or a placeholder when nothing is set. */
function aprsCall(): string { const s = state.ham.station; return s.call ? `${s.call}${s.aprsSsid && s.aprsSsid !== '0' ? `-${s.aprsSsid}` : ''}` : 'N0CALL-9'; }
function saveStation(): void { try { localStorage.setItem('mayhem.station', JSON.stringify(state.ham.station)); } catch { /* ignore */ } }
/** The mode a contact is being made in right now: the active digital decoder, else the receiver mode. */
function logModeNow(): string {
  const h = state.ham, d = h.digi.mode, ssb = h.mode === 'USB' || h.mode === 'LSB' || h.mode === 'CW';
  // a digital mode only counts when the receiver is set up for it: audio modems need sideband / CW, DMR needs NFM
  if (ssb && (d === 'cw' || d === 'rtty' || d === 'psk31' || d === 'ft8' || d === 'sstv')) return d.toUpperCase();
  if (h.mode === 'NFM' && (d === 'dmr' || (d === 'auto' && h.digi.winner === 'DMR'))) return 'DMR';
  if (ssb && d === 'auto' && h.digi.winner && h.digi.winner !== 'ANALOG VOICE') return h.digi.winner.toUpperCase();
  return h.mode === 'NFM' ? 'FM' : h.mode;
}
/** Conventional report for the mode: 59 for voice, 599 for CW and the keyboard modes, an SNR-style dB for FT8. */
function rstDefault(mode: string): string { return /^(FM|NFM|AM|USB|LSB|SSB|DMR)$/.test(mode) ? '59' : /FT8/.test(mode) ? '-10' : '599'; }
function myGrid(): string { const s = state.ham.station; if (s.grid) return s.grid.toUpperCase(); return state.home ? latLonToGrid(state.home.lat, state.home.lon) : ''; }
function myLatLon(): { lat: number; lon: number } | null { const s = state.ham.station; if (s.grid) return gridToLatLon(s.grid); return state.home; }
/** What we know about a callsign, as one line of HTML: entity, worked-before, distance and bearing. */
function callInfoHtml(info: CallInfo | null, call: string): string {
  const p = parseCall(call);
  if (!p.base) return 'type a callsign — the prefix says where it is, LOOKUP asks HamQTH / hamdb / callook for the rest';
  const worked = state.ham.log.entries.filter(q => parseCall(q.call).base === p.base).sort((a, b) => b.ts - a.ts);
  const parts: string[] = [];
  if (info) {
    parts.push(`<b>${info.base}</b>${info.prefix && info.prefix !== info.base.slice(0, info.prefix.length) ? ` (operating from ${info.prefix})` : ''}`);
    if (info.name) parts.push(info.name + (info.class ? ` · ${info.class}` : ''));
    if (info.country) parts.push(`${info.country}${info.continent ? ` · ${info.continent}` : ''}${info.cq ? ` · CQ ${info.cq}` : ''}${info.itu ? ` · ITU ${info.itu}` : ''}${info.utc !== undefined ? ` · UTC${-info.utc >= 0 ? '+' : '−'}${Math.abs(info.utc)}` : ''}`);
    if (info.qth) parts.push(info.qth);
    const here = myLatLon();
    const there = info.grid ? gridToLatLon(info.grid) : info.lat !== undefined && info.lon !== undefined ? { lat: info.lat, lon: info.lon } : null;
    if (here && there) { const d = distanceBearing(here.lat, here.lon, there.lat, there.lon); parts.push(`${info.grid ? `grid ${info.grid} · ` : ''}${d.km >= 100 ? d.km.toFixed(0) : d.km.toFixed(1)} km · bearing ${d.deg.toFixed(0)}°${d.km > 500 ? ` (long path ${((d.deg + 180) % 360).toFixed(0)}°)` : ''}`); }
    else if (info.grid) parts.push(`grid ${info.grid}`);
    parts.push(`<span class="dim">${info.source}</span>`);
  }
  if (worked.length) { const w = worked[0]; parts.push(`<span class="gold">worked ${worked.length}× · last ${new Date(w.ts).toISOString().slice(0, 10)} ${bandOfHz(w.freq)} ${w.mode}${w.name ? ` · ${w.name}` : ''}</span>`); }
  else parts.push('<span class="dim">new one — not in the log yet</span>');
  return parts.join('<br>');
}
function logRefreshInfo(): void {
  logMap();
  const h = state.ham, el = q('#q-info'); if (!el) return;
  const call = (q('#q-call') as HTMLInputElement | null)?.value ?? h.log.draft.call;
  if (!h.log.info || parseCall(h.log.info.call).base !== parseCall(call).base) h.log.info = call.trim() ? offlineInfo(call) : null;
  el.innerHTML = callInfoHtml(h.log.info, call);
}
async function logLookup(): Promise<void> {
  const h = state.ham, call = (q('#q-call') as HTMLInputElement | null)?.value?.trim() ?? '';
  if (!call) return;
  const el = q('#q-info'); if (el) el.innerHTML = `looking up ${call.toUpperCase()}…`;
  const info = await lookupCall(call);
  h.log.info = info;
  const fill = (id: string, v?: string) => { const i = q(id) as HTMLInputElement | null; if (i && !i.value && v) i.value = v; };
  fill('#q-name', info.name); fill('#q-qth', info.qth?.replace(/^call area \d · /, '')); fill('#q-grid', info.grid);
  logRefreshInfo();
}
function logPrefill(p: Partial<typeof state.ham.log.draft>): void {
  const h = state.ham; Object.assign(h.log.draft, { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' }, p); h.log.editing = ''; h.log.info = null;
  h.tab = 'log'; open('ham');
}
function logDraftFromForm(): void {
  const d = state.ham.log.draft, v = (id: string) => (q(id) as HTMLInputElement | null)?.value ?? '';
  d.call = v('#q-call').trim().toUpperCase(); d.rstS = v('#q-rsts').trim(); d.rstR = v('#q-rstr').trim(); d.name = v('#q-name').trim(); d.qth = v('#q-qth').trim(); d.grid = v('#q-grid').trim().toUpperCase(); d.notes = v('#q-notes').trim();
}
function logSave(): void {
  const h = state.ham; logDraftFromForm();
  const d = h.log.draft, call = parseCall(d.call).call;
  if (!call) { const el = q('#q-info'); if (el) el.innerHTML = '<span class="gold">a callsign, at least</span>'; return; }
  const existing = h.log.editing ? h.log.entries.find(x => x.id === h.log.editing) : undefined;
  const qso: Qso = existing ?? { id: `${Date.now()}-${call}`, call, ts: Date.now(), freq: h.freq, mode: d.mode || logModeNow(), rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '' };
  Object.assign(qso, { call, rstS: d.rstS, rstR: d.rstR, name: d.name, qth: d.qth, grid: d.grid, notes: d.notes, country: h.log.info?.country ?? qso.country });
  if (!existing) h.log.entries.unshift(qso);
  saveLog();
  h.log.editing = ''; Object.assign(d, { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' }); h.log.info = null;
  renderLogForm(); logRefreshList();
  log(`logged ${qso.call} · ${(qso.freq / 1e6).toFixed(4)} MHz ${qso.mode}`);
}
/** Contacts on the map: every entry with a grid square, a line home to each, plus the callsign being looked up. */
function logMap(): void {
  const h = state.ham; if (!geo || h.tab !== 'log') return;
  const me = myLatLon();
  const items: GeoItem[] = []; const lines: [[number, number], [number, number]][] = [];
  for (const e of h.log.entries) {
    if (!/^[A-R]{2}\d{2}([A-X]{2})?/i.test(e.grid)) continue;
    const p = gridToLatLon(e.grid); if (!p) continue;
    items.push({ id: e.id, lat: p.lat, lon: p.lon, label: e.call, kind: 'qso' });
    if (me) lines.push([[me.lat, me.lon], [p.lat, p.lon]]);
  }
  const info = h.log.info;
  if (info && (info.grid || (info.lat !== undefined && info.lon !== undefined))) { const p = info.grid ? gridToLatLon(info.grid) : { lat: info.lat!, lon: info.lon! }; if (p) items.push({ id: 'lookup', lat: p.lat, lon: p.lon, label: info.call, kind: 'object' }); }
  geo.setLines(lines);
  geo.update(items, h.log.editing || 'lookup');
}
function logEdit(id: string): void {
  const h = state.ham, x = h.log.entries.find(e => e.id === id); if (!x) return;
  h.log.editing = id; Object.assign(h.log.draft, { call: x.call, rstS: x.rstS, rstR: x.rstR, name: x.name, qth: x.qth, grid: x.grid, notes: x.notes, mode: x.mode }); h.log.info = null;
  renderLogForm();
}
function logDelete(id: string): void { const h = state.ham; h.log.entries = h.log.entries.filter(e => e.id !== id); saveLog(); if (h.log.editing === id) { h.log.editing = ''; renderLogForm(); } logRefreshList(); }
function download(name: string, text: string, type = 'text/plain'): void { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
function logRefreshList(): void {
  const h = state.ham, list = q('#log-list'), stats = q('#log-stats'); if (!list) return;
  const e = h.log.entries;
  if (stats) { const calls = new Set(e.map(x => parseCall(x.call).base)).size, ents = new Set(e.map(x => x.country ?? offlineInfo(x.call).country).filter(Boolean)).size; stats.textContent = e.length ? `${e.length} QSO${e.length === 1 ? '' : 's'} · ${calls} callsign${calls === 1 ? '' : 's'} · ${ents} entit${ents === 1 ? 'y' : 'ies'}` : 'empty'; }
  list.innerHTML = e.length ? e.slice(0, 300).map((x, i) => { const d = new Date(x.ts); return `<div class="li tap ${i % 2 ? 'alt' : ''} ${x.id === h.log.editing ? 'gold' : ''}" data-qso="${x.id}"><span class="row2"><span><b>${x.call}</b> ${d.toISOString().slice(0, 16).replace('T', ' ')}z · ${(x.freq / 1e6).toFixed(4)} ${x.mode}${x.rstS || x.rstR ? ` · ${x.rstS || '—'}/${x.rstR || '—'}` : ''}</span><span>${[x.name, x.qth, x.grid, x.country].filter(Boolean).join(' · ')} <button class="x" data-del="${x.id}" title="delete">✕</button></span></span></div>`; }).join('') : '<div class="empty">no contacts yet — work someone and LOG IT, or import an ADIF</div>';
  qa<HTMLElement>('[data-qso]', list).forEach(r => r.onclick = (ev) => { if ((ev.target as HTMLElement).dataset.del) return; logEdit(r.dataset.qso!); });
  logMap();
  qa<HTMLElement>('[data-del]', list).forEach(b => b.onclick = (ev) => { ev.stopPropagation(); logDelete(b.dataset.del!); });
}
function renderLogForm(): void {
  const h = state.ham, d = h.log.draft, set = (id: string, v: string) => { const i = q(id) as HTMLInputElement | null; if (i) i.value = v; };
  set('#q-call', d.call); set('#q-rsts', d.rstS || rstDefault(d.mode || logModeNow())); set('#q-rstr', d.rstR || rstDefault(d.mode || logModeNow())); set('#q-name', d.name); set('#q-qth', d.qth); set('#q-grid', d.grid); set('#q-notes', d.notes);
  const btn = q('#q-save'); if (btn) btn.textContent = h.log.editing ? 'SAVE CHANGES' : 'LOG IT';
  const when = q('#log-when'); if (when) when.textContent = h.log.editing ? 'editing an earlier contact' : `now · ${new Date().toISOString().slice(11, 16)}z · ${(h.freq / 1e6).toFixed(4)} MHz · ${d.mode || logModeNow()} · ${bandOfHz(h.freq) || 'out of band'}`;
  logRefreshInfo();
}
function renderLog(view: HTMLElement, tabs: string): void {
  const h = state.ham, s = h.station;
  view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <div class="hamline"><span id="ham-seg" class="seg"></span><span id="ham-tone" class="sq">—</span></div>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      <div class="caption">STATION · ${s.call ? `${s.call}${s.name ? ` · ${s.name}` : ''} · grid ${myGrid() || '?'}` : 'set your callsign and grid in Settings'}${s.license ? ` · ${s.license}` : ''}</div>
      <div class="caption">CONTACT · <span id="log-when"></span></div>
      <div class="row"><input id="q-call" class="txin" style="flex:2" placeholder="CALLSIGN" autocapitalize="characters" spellcheck="false" autocomplete="off"><button id="q-lookup" class="tog">LOOKUP</button><button id="q-qrz" class="tog">QRZ ↗</button></div>
      <div id="q-info" class="panel about small"></div>
      <div class="row"><input id="q-rsts" class="txin" placeholder="RST sent"><input id="q-rstr" class="txin" placeholder="RST rcvd"><input id="q-name" class="txin" style="flex:2" placeholder="name"></div>
      <div class="row"><input id="q-qth" class="txin" style="flex:2" placeholder="QTH"><input id="q-grid" class="txin" placeholder="grid" autocapitalize="characters"></div>
      <input id="q-notes" class="txin" placeholder="notes">
      <div class="ctlrow"><button id="q-save" class="act grow">LOG IT</button><button id="q-clear" class="tog">CLEAR</button></div>
      <div class="caption">LOGBOOK · <span id="log-stats"></span> · tap a contact to edit it</div><div id="log-list" class="panel list"></div>
      <div class="caption">MAP · contacts by grid square, the callsign you are looking up in gold</div><div id="log-map" class="panel map"></div>
      <div class="row bandstrip"><button id="log-export" class="chip">EXPORT ADIF</button><button id="log-import" class="chip">IMPORT ADIF</button><button id="log-csv" class="chip">EXPORT CSV</button><button id="log-wipe" class="chip">DELETE ALL</button></div>
      <input id="log-file" type="file" accept=".adi,.adif,.txt" hidden>
    </section>`;
  scope = attach(tunableScope('scope', 200));
  geo = new GeoMap($('log-map'), { home: myLatLon(), onPick: id => { if (id !== 'lookup') logEdit(id); }, log });
  qa<HTMLButtonElement>('[data-hamtab]', view).forEach(b => b.onclick = () => { logDraftFromForm(); h.tab = b.dataset.hamtab as typeof h.tab; open('ham'); });
  const callIn = $('q-call') as HTMLInputElement;
  callIn.oninput = () => { callIn.value = callIn.value.toUpperCase(); h.log.info = null; logRefreshInfo(); };
  callIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void logLookup(); } };
  $('q-lookup').onclick = () => void logLookup();
  $('q-qrz').onclick = () => { const c = parseCall(callIn.value).base; if (c) window.open(`https://www.qrz.com/db/${c}`, '_blank', 'noopener'); };
  $('q-save').onclick = logSave;
  $('q-clear').onclick = () => { h.log.editing = ''; Object.assign(h.log.draft, { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' }); h.log.info = null; renderLogForm(); logRefreshList(); };
  $('log-export').onclick = () => download(`mayhem-log-${new Date().toISOString().slice(0, 10)}.adi`, toAdif(h.log.entries, s.call, myGrid()));
  $('log-csv').onclick = () => download(`mayhem-log-${new Date().toISOString().slice(0, 10)}.csv`, 'call,utc,freq_mhz,band,mode,rst_sent,rst_rcvd,name,qth,grid,country,notes\n' + h.log.entries.map(x => [x.call, new Date(x.ts).toISOString(), (x.freq / 1e6).toFixed(6), bandOfHz(x.freq), x.mode, x.rstS, x.rstR, x.name, x.qth, x.grid, x.country ?? '', x.notes].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n', 'text/csv');
  $('log-import').onclick = () => ($('log-file') as HTMLInputElement).click();
  ($('log-file') as HTMLInputElement).onchange = async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; const got = fromAdif(await f.text()); const have = new Set(h.log.entries.map(x => x.id)); let n = 0; for (const x of got) if (!have.has(x.id)) { h.log.entries.push(x); n++; } h.log.entries.sort((a, b) => b.ts - a.ts); saveLog(); logRefreshList(); log(`imported ${n} contacts from ${f.name}`); };
  $('log-wipe').onclick = () => { if (confirm(`Delete all ${h.log.entries.length} contacts? Export an ADIF first if you want to keep them.`)) { h.log.entries = []; saveLog(); logRefreshList(); } };
  renderLogForm(); logRefreshList(); refreshHamUi();
  if (h.log.draft.call && !h.log.info) void logLookup();
}

// ---- PTT (FM voice from the microphone) ----------------------------------------------------------------------------
let micNode: AudioWorkletNode | null = null; let micRing: Float32Array | null = null; let micR = 0; let micW = 0;
async function ensureMic(): Promise<boolean> {
  if (micNode) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    await ensureAudio();
    const ctx = audioCtx!;
    await ctx.audioWorklet.addModule('./mic-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    micNode = new AudioWorkletNode(ctx, 'mayhem-mic', { numberOfOutputs: 0 });
    micRing = new Float32Array(48_000 * 2); micR = 0; micW = 0;
    micNode.port.onmessage = (e) => { const a = e.data as Float32Array; for (let i = 0; i < a.length; i++) { micRing![micW] = a[i]; micW = (micW + 1) % micRing!.length; } };
    src.connect(micNode);
    return true;
  } catch (e) { log(`mic: ${(e as Error).message}`); return false; }
}
const micReader = { read: () => { if (!micRing || micR === micW) return 0; const v = micRing[micR]; micR = (micR + 1) % micRing.length; return v; } };
let pttButton: HTMLElement | null = null;
function pttStart(freqHz?: number, toneHz?: number, button?: HTMLElement): void {
  const h = state.ham; if (h.ptt.on) return;
  if (tx.needsPrompt) { showTxSafetyPrompt(); return; }
  void ensureMic().then(ok => {
    if (!ok) { txStatus('no microphone'); return; }
    micR = micW;                                             // drop whatever buffered while idle
    const f = freqHz ?? (h.rev ? h.freq : (repeaterInput(h.freq) ?? h.freq));   // talk on the repeater input when listening to an output
    const tone = toneHz ?? h.ptt.tone;
    if (tx.fmVoice(f, h.ptt.dev, tone, micReader)) { h.ptt.on = true; pttButton = button ?? q('#ptt'); if (pttButton) { pttButton.classList.add('on'); pttButton.textContent = `TX ${(f / 1e6).toFixed(4)}${tone ? ` · ${tone.toFixed(1)} Hz` : ''}`; } }
  });
}
function pttStop(): void { const h = state.ham; if (!h.ptt.on) return; tx.stop(); h.ptt.on = false; const b = pttButton; if (b) { b.classList.remove('on'); b.textContent = b.id === 'sat-ptt' ? 'PUSH TO TALK · UPLINK' : 'PUSH TO TALK'; } }
/** The digital decoders as tiles, with what each one is for. */
const DIGI_TILES: [string, string][] = [['auto', 'picks one'], ['cw', 'morse'], ['rtty', 'teletype'], ['psk31', 'keyboard chat'], ['ft8', '15 s slots'], ['sstv', 'pictures'],
  ['dmr', 'digital voice'], ['p25', 'digital voice'], ['off', 'audio only']];
function renderPtt(view: HTMLElement, tabs: string): void {
  const h = state.ham, rin = repeaterInput(h.freq);
  view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <div class="hamline"><span id="ham-seg" class="seg"></span><span id="ham-tone" class="sq">—</span></div>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      <div class="caption">TX · ${rin !== null ? `repeater input ${(rin / 1e6).toFixed(4)} MHz (offset applied)` : 'simplex on the dial frequency'} · hold the button</div>
      <button id="ptt" class="chip ptt">PUSH TO TALK</button>
      <div id="tx-status" class="health">idle</div>
      <div class="ctlrow"><span class="rl">DEV</span>${segHtml([2500, 5000].map(d => `<button data-dev="${d}">±${d / 1000} kHz</button>`))}</div>
      <div class="rl offers">CTCSS TONE</div>${hsHtml(`<div class="tiles">${[0, 67.0, 71.9, 77.0, 88.5, 100.0, 103.5, 107.2, 114.8, 123.0, 131.8, 141.3, 151.4, 162.2, 173.8, 186.2, 203.5].map(t => `<button class="tl" data-tone="${t}"><b>${t ? t.toFixed(1) : 'OFF'}</b><small>${t ? 'Hz' : 'no tone'}</small></button>`).join('')}</div>`)}
      ${txGainHtml()}
      <div style="margin-top:6px">${hamBandTiles()}</div>
      <div class="ctlrow"><span class="rl">RX</span>${segHtml((['NFM', 'USB', 'LSB'] as HamMode[]).map(m => `<button data-hmode="${m}">${m}</button>`))}</div><div class="note">The mode heard between overs.</div>
    </section>`;
  scope = attach(tunableScope('scope', 200));
  qa<HTMLButtonElement>('[data-hamtab]', view).forEach(b => b.onclick = () => { pttStop(); h.tab = b.dataset.hamtab as typeof h.tab; open('ham'); });
  qa<HTMLButtonElement>('[data-band]', view).forEach(b => b.onclick = () => { const band = [...BANDS, ...NON_HAM].find(x => x.id === b.dataset.band)!; if (band.mode !== h.mode) hamSetMode(band.mode); hamTune(band.calling ?? band.lo); render('ham'); });
  qa<HTMLButtonElement>('[data-hmode]', view).forEach(b => b.onclick = () => hamSetMode(b.dataset.hmode as HamMode));
  qa<HTMLButtonElement>('[data-dev]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.dev) === h.ptt.dev); b.onclick = () => { h.ptt.dev = Number(b.dataset.dev); qa('[data-dev]').forEach(x => x.classList.toggle('on', x === b)); }; });
  qa<HTMLButtonElement>('[data-tone]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.tone) === h.ptt.tone); b.onclick = () => { h.ptt.tone = Number(b.dataset.tone); qa('[data-tone]').forEach(x => x.classList.toggle('on', x === b)); }; });
  qa<HTMLButtonElement>('[data-txg]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.txg) === tx.gain); b.onclick = () => { tx.gain = Number(b.dataset.txg); qa('[data-txg]').forEach(x => x.classList.toggle('on', x === b)); }; });
  const ampb = $('tx-amp'); ampb.classList.toggle('on', tx.amp); ampb.onclick = () => { tx.amp = !tx.amp; ampb.classList.toggle('on', tx.amp); };
  const ptt = $('ptt');
  ptt.onpointerdown = (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); pttStart(); };
  ptt.onpointerup = ptt.onpointercancel = () => pttStop();
  ptt.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pttStart(); } };
  ptt.onkeyup = (e) => { if (e.key === ' ' || e.key === 'Enter') pttStop(); };
  if (tx.needsPrompt) showTxSafetyPrompt();
  refreshHamUi();
}

// ---- PortaPack in Mayhem mode: switch it to HackRF mode over its USB serial shell -----------------------------------
// The shell echoes and prints a prompt; Mayhem only reboots into HackRF mode once that output has been read, so both
// routes keep reading after the command. WebUSB first (Android Chrome, where no OS serial driver holds the port), then
// Web Serial (desktop Chrome / Edge, where the OS driver owns it and WebUSB cannot claim it).
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function portapackViaWebUsb(d: USBDevice): Promise<boolean> {
  try {
    const ifs = d.configuration?.interfaces ?? [];
    const data = ifs.find((i) => i.alternate.interfaceClass === 0x0a);
    const comm = ifs.find((i) => i.alternate.interfaceClass === 0x02);
    const out = data?.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    const inp = data?.alternate.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
    if (!data || !out) return false;
    await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    await d.claimInterface(data.interfaceNumber);
    if (comm) {
      await d.claimInterface(comm.interfaceNumber).catch(() => undefined);
      const idx = comm.interfaceNumber;
      await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: idx }, new Uint8Array([0x00, 0xc2, 0x01, 0x00, 0, 0, 8])).catch(() => undefined);
      await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0x03, index: idx }).catch(() => undefined);
    }
    let gone = false;
    const drain = async (ms: number) => {
      const end = Date.now() + ms;
      while (!gone && Date.now() < end) {
        if (!inp) { await sleepMs(100); continue; }
        await Promise.race([d.transferIn(inp.endpointNumber, 512).catch(() => { gone = true; }), sleepMs(150)]);
      }
    };
    await drain(300);
    await d.transferOut(out.endpointNumber, new TextEncoder().encode('\r\nhackrf\r\n'));
    await drain(3000);
    await d.close().catch(() => undefined);
    return true;
  } catch (e) {
    log(`PortaPack over WebUSB: ${(e as Error).message}`);
    await d.close().catch(() => undefined);
    return false;
  }
}
async function portapackToHackRf(d?: USBDevice): Promise<boolean> {
  if (d && (await portapackViaWebUsb(d))) {
    log('PortaPack: sent "hackrf" — it is rebooting into HackRF mode; tap CONNECT again in a few seconds.');
    setStatus('PortaPack switching to HackRF mode… tap CONNECT in 5 s', false);
    return true;
  }
  type SerialPortLike = { open: (o: unknown) => Promise<void>; writable: WritableStream<Uint8Array> | null; readable: ReadableStream<Uint8Array> | null; close: () => Promise<void> };
  const serial = (navigator as unknown as { serial?: { requestPort: (o: unknown) => Promise<SerialPortLike> } }).serial;
  if (!serial) { log('PortaPack: this browser has no Web Serial — tap HackRF mode on the PortaPack instead.'); return false; }
  try {
    const port = await serial.requestPort({ filters: [{ usbVendorId: 0x1d50, usbProductId: 0x6018 }] });
    await port.open({ baudRate: 115200 });
    const r = port.readable?.getReader();
    const reading = (async () => { try { for (;;) { const { done } = await r!.read(); if (done) break; } } catch { /* board rebooted */ } })();
    await sleepMs(300);
    const w = port.writable!.getWriter();
    await w.write(new TextEncoder().encode('\r\nhackrf\r\n'));
    w.releaseLock();
    if (r) { await Promise.race([reading, sleepMs(3000)]); await r.cancel().catch(() => undefined); r.releaseLock(); }
    await port.close().catch(() => undefined);
    log('PortaPack: sent "hackrf" — it is rebooting into HackRF mode; tap CONNECT again in a few seconds.');
    setStatus('PortaPack switching to HackRF mode… tap CONNECT in 5 s', false);
    return true;
  } catch (e) { log(`PortaPack switch: ${(e as Error).message}`); return false; }
}

function renderAudio(view: HTMLElement): void {
  // The Android app's Audio: the card, RDS as its own strip, the waterfall; then three rows — how to listen,
  // where (the bands), and squelch with SCAN. RDS and HD Radio are switches in Settings; gain is in Settings too.
  view.innerHTML = `
    <section class="visual"><div id="same-alert" class="samealert" hidden></div>${readoutHtml()}<div id="rds" class="rdsbar station" hidden></div><div id="scope" class="panel"></div></section>
    <section class="controls">
      ${segHtml(['WFM', 'NFM', 'AM', 'USB', 'LSB'].map(m => `<button data-mode="${m}">${m}</button>`))}
      <div style="margin-top:6px">${hsHtml(bandTilesHtml())}</div>
      <div class="ctlrow"><span class="rl">SQL</span>${segHtml([0, 6, 12, 20].map(d => `<button data-sql="${d}">${d ? `${d} dB` : 'OFF'}</button>`))}<button id="scan" class="tog">SCAN</button></div>
      ${gainHtml()}
    </section>`;
  scope = attach(tunableScope('scope', 200));
  // The RDS ticker overlays the waterfall itself (the scope box is position:relative), so the scope stays a direct
  // child of .visual and keeps the flex-fill height every other app's waterfall gets — no wrapper to break it.
  qa<HTMLButtonElement>('[data-sql]', view).forEach(b => b.onclick = () => setSquelch(Number(b.dataset.sql)));
  setSquelch(state.squelch);
  $('scan').onclick = () => { if (bookmarks.length < 2) { log('SCAN hops your FAVES — star a few with ☆ beside the frequency first'); showHint(new Error('SCAN hops your FAVES — star a few with ☆ beside the frequency first')); return; } setScanning(!state.scanning); };
  $('scan').classList.toggle('on', state.scanning);
  const hdEl = document.createElement('div'); hdEl.id = 'hd'; hdEl.className = 'hdbadge'; hdEl.hidden = true; $('scope').appendChild(hdEl);
  refreshBookmarks(); refreshSquelch();
  sendRds(); drawRds(); sendHd(); drawHd();
}

// ---- HD Radio: a badge over the waterfall saying whether the station carries a digital signal beside it, from
// the worker's sideband detector. Detection only: the audio codec is proprietary, so there is nothing to play.
let hdWanted = false;
let lastHd: { present: boolean; snrDb: number; lock: number; cfoHz: number; symbols: number } | null = null;
function sendHd(): void { worker?.postMessage({ type: 'hd', on: hdWanted }); }
function drawHd(): void {
  const t = q('#hd-toggle'); if (t) t.classList.toggle('on', hdWanted);
  const el = q('#hd'); if (!el) return;
  if (!hdWanted || state.mode !== 'WFM') { el.hidden = true; return; }
  el.hidden = false;
  if (!lastHd) { el.className = 'hdbadge'; el.textContent = 'HD · listening…'; return; }
  const r = lastHd;
  el.className = 'hdbadge' + (r.present ? ' on' : '');
  const cfo = r.present && Number.isFinite(r.cfoHz) ? ` · ${r.cfoHz >= 0 ? '+' : ''}${r.cfoHz.toFixed(0)} Hz` : '';
  el.textContent = r.present ? `HD ◉ ${r.snrDb.toFixed(0)} dB · lock ${r.lock.toFixed(1)}${cfo}` : `HD · none (${r.snrDb.toFixed(0)} dB · lock ${r.lock.toFixed(2)})`;
}

// ---- SAME / EAS: a weather-alert banner over the audio app when a NOAA weather-radio header decodes on NFM.
function onSameAlert(m: { event: string; header?: { eventName: string; originatorName: string; locations: unknown[]; duration: { hours: number; minutes: number }; callsign: string } }): void {
  const el = q('#same-alert'); if (!el) return;
  if (m.event === 'eom') { el.hidden = true; return; }        // the alert said it is over
  if (m.event !== 'header' || !m.header) return;
  const h = m.header;
  const dur = h.duration.hours || h.duration.minutes ? ` · ${h.duration.hours ? h.duration.hours + 'h' : ''}${h.duration.minutes ? h.duration.minutes + 'm' : ''}` : '';
  const areas = h.locations.length ? ` · ${h.locations.length} area${h.locations.length === 1 ? '' : 's'}` : '';
  el.textContent = `⚠ ${h.eventName.toUpperCase()} · ${h.originatorName}${areas}${dur}${h.callsign ? ' · ' + h.callsign : ''}   ✕`;
  el.hidden = false;
  el.onclick = () => { el.hidden = true; };                    // tap to dismiss
  log(`SAME: ${h.eventName} from ${h.callsign}`);
}

// ---- RDS: station name / RadioText ticker over the audio waterfall, decoded from the WFM composite in the worker.
let rdsWanted = true;
let lastRds: { ps: string; rt: string; ptyName: string; pi: number | null; synced: boolean } | null = null;
function sendRds(): void { worker?.postMessage({ type: 'rds', on: rdsWanted }); }
/** The running marquee (when the line is too long to sit still) and the last content shown, so an unchanged
 *  update leaves a scrolling line alone instead of yanking it back to the start every frame RDS repeats. */
let rdsAnim: Animation | null = null;
let rdsShownKey = '';
let rdsAnimLw = 0;   // the line width the running marquee was aimed at, so a name tick (tiny width change) does not rebuild it
/**
 * The Audio card's title. With RDS on and broadcast FM tuned it is the station: "NAME · PROGRAM TYPE" once the name
 * is known, "FM BROADCAST · RDS…" while RDS is still listening; otherwise what the band is.
 */
function audioTitle(): string {
  if (!rdsWanted || state.mode !== 'WFM') return bandTitle(tunedHz());
  const ps = lastRds?.ps.trim() ?? '';
  if (!ps) return 'FM BROADCAST · RDS…';
  const pty = lastRds?.ptyName && lastRds.ptyName !== 'None' ? lastRds.ptyName : '';
  return pty ? `${ps} · ${pty.toUpperCase()}` : ps;
}
function drawRds(): void {
  const t = q('#rds-toggle'); if (t) t.classList.toggle('on', rdsWanted);
  if (state.app === 'audio') setFace(state.mode, audioTitle());
  const el = q('#rds'); if (!el) return;
  // RDS only rides the broadcast-FM subcarrier; on any other mode there is nothing to read. The strip appears only
  // once there is a name or RadioText to show (the card's title says RDS is listening until then).
  if (!rdsWanted || state.mode !== 'WFM' || !lastRds || !(lastRds.ps.trim() || lastRds.rt.trim())) { el.hidden = true; el.classList.remove('ticker'); rdsAnim?.cancel(); rdsAnim = null; rdsShownKey = ''; return; }
  el.hidden = false;
  el.classList.toggle('dim', !lastRds.synced);   // dim until a station's data actually locks
  const r = lastRds;
  const pty = r.ptyName && r.ptyName !== 'None' ? r.ptyName : '';
  const pi = r.pi != null ? r.pi.toString(16).toUpperCase().padStart(4, '0') : '';
  // Everything RDS gave us, station identity first and RadioText (the long one) last.
  const fields: [string, string][] = [];
  if (r.ps.trim()) fields.push(['', r.ps.trim()]);
  if (pty) fields.push(['', pty]);
  if (pi) fields.push(['PI', pi]);
  if (r.rt.trim()) fields.push(['', r.rt.trim()]);
  const key = fields.map(f => f.join(':')).join('|') + (r.synced ? '#s' : '#-');
  if (key === rdsShownKey) return;                 // nothing changed: let any running marquee carry on
  rdsShownKey = key;
  const body = fields.length
    ? fields.map(([k, v]) => `${k ? `<i>${esc(k)}</i>` : ''}<b>${esc(v)}</b>`).join('<em>·</em>')
    : `<b>${r.synced ? 'RDS · reading…' : 'RDS · listening…'}</b>`;
  // Reuse the one line node and just replace its text: the name is dynamic and changes about once a second, and
  // recreating the node each time restarted the marquee from the right edge, so it never scrolled past its first
  // second — the whole message barely moved and the start of it looked like it was scrolling in a little box.
  // Keeping the node alive lets the marquee run continuously across every name change; there are no fixed field
  // widths, so each field is as wide as its text and the whole line scrolls as one when it overflows the bar.
  let line = el.querySelector('.rdsline') as HTMLElement | null;
  if (!line) { el.innerHTML = '<span class="rdsline"></span>'; line = el.firstElementChild as HTMLElement; rdsAnim?.cancel(); rdsAnim = null; }
  line.innerHTML = body;
  const node = line;
  requestAnimationFrame(() => {
    if (!node.isConnected || el.hidden) return;
    const cw = el.clientWidth, lw = node.scrollWidth;
    if (lw <= cw) { el.classList.remove('ticker'); rdsAnim?.cancel(); rdsAnim = null; return; }   // fits: static, every field visible at once
    el.classList.add('ticker');
    // Start the marquee once and let it keep running as the text updates. Rebuild it only when the width really
    // changes — a new RadioText — not on a name tick, whose few characters barely move the total; that is what
    // kept it from ever scrolling past the start.
    if (!rdsAnim || Math.abs(lw - rdsAnimLw) > 24) {
      rdsAnim?.cancel();
      rdsAnim = node.animate([{ transform: `translateX(${cw}px)` }, { transform: `translateX(${-lw}px)` }], { duration: (cw + lw) / 90 * 1000, iterations: Infinity });
      rdsAnimLw = lw;
    }
  });
}

/**
 * The bands these sensors use. 433.92 first because most of the protocol set lives there; the four American
 * frequencies are listed separately because they are spread over fourteen megahertz, which is wider than one
 * span, so hearing all of them means visiting each in turn.
 */
const R433_BANDS: [string, number][] = [
  ['433.92', 433_920_000],
  ['315.00', 315_000_000],
  ['345.00', 345_000_000],
  ['310.00', 310_000_000],
  ['318.00', 318_000_000],
  ['303.875', 303_875_000],
  ['868.30', 868_300_000],
  ['912.60', 912_600_000],
  ['915.00', 915_000_000],
];
/** How long to sit on each band when hopping. Most of these sensors report every thirty to sixty seconds. */
const R433_DWELL_MS = 20_000;
let r433Timer = 0;

/** Units for the readings, so a number is never shown bare. */
const R433_UNITS: Record<string, string> = {
  temperature_C: ' °C', temperature_1_C: ' °C', temperature_F: ' °F',
  humidity: ' %', humidity_1: ' %', moisture: ' %',
  pressure_hPa: ' hPa', pressure_kPa: ' kPa', pressure_PSI: ' PSI',
  wind_avg_km_h: ' km/h', wind_max_km_h: ' km/h', wind_avg_m_s: ' m/s', wind_max_m_s: ' m/s',
  wind_avg_mi_h: ' mph', wind_dir_deg: '°',
  rain_mm: ' mm', rain_in: ' in', light_lux: ' lux', battery_mV: ' mV',
  pm2_5_ug_m3: ' µg/m³', estimated_pm10_0_ug_m3: ' µg/m³',
  storm_dist: ' km', strike_distance: ' mi',
};
/** Which fields make the one-line summary, in the order a person would want to read them. */
const R433_SUMMARY = ['temperature_C', 'temperature_F', 'humidity', 'pressure_hPa', 'pressure_PSI', 'pressure_kPa',
  'moisture', 'rain_mm', 'rain_in', 'wind_avg_km_h', 'wind_avg_mi_h', 'wind_avg_m_s', 'leak_detected',
  'strike_count', 'pm2_5_ug_m3', 'light_lux'];
/** Bookkeeping the reader does not need on the summary line. It is all still shown when a device is opened. */
const R433_HIDDEN = new Set(['model', 'id', 'channel', 'subtype', 'type', 'mic', 'exception', 'message_type',
  'sequence_num', 'unknown1', 'family', 'raw', 'raw_msg', 'protocol', 'code']);

/** How each field is explained when a device is opened. Anything not here is shown under its own name. */
const R433_MEANING: Record<string, string> = {
  raw: 'the frame exactly as it arrived, in the notation rtl_433 uses for its own test codes',
  raw_msg: 'the decoded bytes, kept because this family still has bits nobody has explained',
  protocol: 'rtl_433 protocol number — look this up against that project’s documentation',
  mic: 'which error check the reading passed',
  exception: 'a bit was set that should not have been; the reading may still be right',
  battery_mV: 'battery voltage as the sensor measures it',
  ad_raw: 'the sensor’s own reading before it was turned into a percentage',
  storm_dist: 'the detector’s estimate of how far off the leading edge of the storm is',
  strike_count: 'a running total since the batteries went in, not a rate',
  rfi: 'broadband interference, which stops the detector hearing strikes at all',
  consumption_data: 'a meter register reading, not a unit of energy — the multiplier is the utility’s',
  DifferentialConsumptionIntervals: 'consumption in each recent interval, oldest first',
  tristate: 'the solder links or switches inside the remote: 0 low, 1 high, Z floating',
  counter: 'advances every button press, which is what stops a recording being replayed',
  learn: 'the device is being taught to a receiver rather than reporting',
  heartbeat: 'a periodic check-in, not an event',
};

function r433Value(k: string, v: unknown): string {
  if (k === 'battery_ok') return v === 1 || v === true ? 'battery ok' : typeof v === 'number' && v > 0 && v < 1 ? `battery ${Math.round(v * 100)}%` : 'BATTERY LOW';
  if (k === 'leak_detected') return v ? 'WET' : 'dry';
  return `${v}${R433_UNITS[k] ?? ''}`;
}

/** The line under a device's name: the two or three readings that actually say what it is doing. */
function r433Summary(d: R433Data): string {
  const parts: string[] = [];
  for (const k of R433_SUMMARY) {
    if (d[k] === undefined) continue;
    parts.push(r433Value(k, d[k]));
    if (parts.length === 3) break;
  }
  if (!parts.length) {
    for (const [k, v] of Object.entries(d)) {
      if (R433_HIDDEN.has(k) || parts.length === 3) continue;
      parts.push(`${k.replace(/_/g, ' ')} ${r433Value(k, v)}`);
    }
  }
  return parts.join(' · ');
}

function renderR433(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${presetHtml('BAND', R433_BANDS)}
      <div class="ctlrow"><span class="rl">SPAN</span>${segHtml([['250k', 250_000], ['500k', 500_000], ['1M', 1_000_000], ['2M', 2_000_000]].map(([l, hz]) => `<button data-span="${hz}">${l}</button>`))}<button id="r433-hop" class="tog">HOP</button></div>
      <div class="note">433.92 carries most of the protocol set; the American four sit 14 MHz apart, so HOP visits each in turn. A narrower span hears weaker devices.</div>
      <div id="r433-stats" class="note">listening&hellip;</div>
      <div class="countrow"><span class="count" id="r433-count">0 DEVICES</span><span class="row"><button class="tog" id="r433-ptoggle">PROTOCOLS</button>${pauseClearHtml('devices')}</span></div>
      <div id="r433-list" class="panel devtable"></div>
      <div id="r433-protocols" class="panel devtable" hidden></div>
      <div class="gainwrap">${gainHtml()}</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-span]', view).forEach(b => {
    const hz = Number(b.dataset.span);
    b.classList.toggle('on', hz === state.r433.span);
    b.onclick = () => {
      state.r433.span = hz;
      worker?.postMessage({ type: 'r433', cmd: 'span', hz });
      qa('[data-span]').forEach(x => x.classList.toggle('on', x === b));
    };
  });
  const pt = $('r433-ptoggle');
  pt.onclick = () => { state.r433.showProtocols = !state.r433.showProtocols; drawR433(); };
  const hop = $('r433-hop');
  hop.classList.toggle('on', state.r433.hop);
  hop.onclick = () => { state.r433.hop = !state.r433.hop; r433Hop(); render('devices'); };
  r433Hop();
  drawR433();
}

/** Start or stop the band walk. Tuning happens through the normal path, so the waterfall follows. */
function r433Hop(): void {
  clearInterval(r433Timer);
  r433Timer = 0;
  if (!state.r433.hop || state.app !== 'devices') return;
  r433Timer = window.setInterval(() => {
    if (state.app !== 'devices') { clearInterval(r433Timer); r433Timer = 0; return; }
    state.r433.band = (state.r433.band + 1) % R433_BANDS.length;
    tune(R433_BANDS[state.r433.band][1]);
    refreshR433();
  }, R433_DWELL_MS);
}

let r433Pending = 0;
/** Coalesce redraws: readings can arrive in bursts, and rebuilding the list under a finger is unpleasant. */
function refreshR433(): void {
  if (r433Pending) return;
  r433Pending = window.setTimeout(() => { r433Pending = 0; drawR433(); }, 250);
}

/** `14:23:07` — what someone comparing a reading against the doorbell they just pressed wants to see. */
function r433Clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Fields too long for the wrapped list; each gets its own monospaced line in the card. */
const R433_LONG = new Set(['raw', 'raw_msg', 'code', 'summary', 'DifferentialConsumptionIntervals']);

/**
 * Everything the device sent, under its row.
 *
 * Always shown rather than hidden behind a tap. These readings are mostly two or three numbers and a frame of
 * hex; a device that reports a wind gust and a rain total and a battery voltage has nothing worth hiding, and
 * having to open each one in turn to compare two sensors is worse than a longer list you can scroll.
 */
function r433Detail(d: HeardDevice, doubtful: boolean): string {
  const entries = Object.entries(d.data).filter(([k]) => k !== 'model');
  const shape = d.shape;

  const fields = entries.filter(([k]) => !R433_LONG.has(k)).map(([k, v]) => {
    // A couple of values already read as a sentence; repeating the field name in front of them would give
    // "battery ok battery ok".
    const speaks = k === 'battery_ok' || k === 'leak_detected';
    const label = speaks ? '' : `<b>${esc(k.replace(/_/g, ' '))}</b> `;
    return `<span${R433_MEANING[k] ? ` title="${esc(R433_MEANING[k])}"` : ''}>${label}${esc(r433Value(k, v))}</span>`;
  }).join('');

  // One short line rather than a paragraph, because it repeats on every row of its kind. The tooltip on the
  // row's own marker carries the longer explanation.
  const note = d.num === 0
    ? `<span class="warn" title="no protocol in the set recognized this transmission — most likely a device this port does not cover yet, possibly interference that keyed hard enough to look deliberate">nothing claimed this${shape && shape.coding ? ` — timings look like ${esc(shape.coding)}` : ' — the timings do not settle how the bits are carried'}</span>`
    : doubtful
      ? '<span class="warn" title="rtl_433 ships this protocol switched off for exactly this reason; an implausible reading from it is almost certainly another device’s transmission being misread">no checksum — nothing in the frame proves this reading</span>'
      : '';

  const marks = shape
    ? `<div class="r433-raw"><b>marks</b> ${shape.mark.map(c => `${c.us} µs ×${c.n}`).join(' · ') || 'none recurring'}   <b>gaps</b> ${shape.space.map(c => `${c.us} µs ×${c.n}`).join(' · ') || 'none recurring'}</div>`
    : '';
  const long = entries.filter(([k]) => R433_LONG.has(k) && k !== 'summary').map(([k, v]) =>
    `<div class="r433-raw"${R433_MEANING[k] ? ` title="${esc(R433_MEANING[k])}"` : ''}><b>${esc(k.replace(/_/g, ' '))}</b> ${esc(String(v))}</div>`).join('');

  return `<div class="devdetail"><div class="devfields">${fields}<span class="faint">${esc(d.what)}${d.num ? ` · rtl_433 protocol ${d.num}` : ''} · first heard ${r433Clock(d.firstSeen)}</span>${note}</div>${marks}${long}</div>`;
}

function drawR433(): void {
  const r = state.r433;
  const st = q('#r433-stats');
  if (st) {
    const s = r.stats;
    st.textContent = s
      ? `${R433_BANDS[r.band][0]} MHz · ${s.protocols} protocols · ${s.bursts} bursts (${s.ook} keyed, ${s.fsk} shifted) · ${s.decoded} decoded${s.badChecksum ? ` · ${s.badChecksum} failed their checksum` : ''} · listening across ${s.span >= 1e6 ? `${s.span / 1e6} MHz` : `${Math.round(s.span / 1e3)} kHz`} · noise ${s.noise}, triggers above ${s.trigger}`
      : 'listening…';
  }
  const named = r.heard.filter(d => d.num !== 0).length;
  const c = q('#r433-count');
  // Whichever list is showing is what this counts. Saying "4 devices" over a list of 82 protocols was simply
  // describing the wrong thing.
  if (c) {
    c.textContent = r.showProtocols
      ? `${r.protocols.length} PROTOCOLS · ALL RUNNING`
      : `${named} DEVICE${named === 1 ? '' : 'S'}${r.heard.length > named ? ` · ${r.heard.length - named} UNKNOWN` : ''}`;
  }
  drawR433Protocols();
  const el = q('#r433-list');
  if (!el) return;
  (el as HTMLElement).hidden = r.showProtocols;
  if (r.showProtocols || paused.has('devices')) return;
  if (!r.heard.length) { el.innerHTML = '<div class="empty">nothing yet — most of these report every thirty to sixty seconds, so give it a minute</div>'; return; }

  // Which protocols rtl_433 ships switched off for having no checksum. A reading from one of those is worth
  // marking: nothing in the frame proves it is not another maker's transmission being read wrongly.
  const doubtful = new Set(r.protocols.filter(p => p.doubtful).map(p => p.num));
  const rows = [...r.heard].sort((a, b) => b.lastSeen - a.lastSeen);
  el.innerHTML = '<div class="devhead"><span>DEVICE</span><span>READING</span><span>SEEN</span><span>LAST</span></div>'
    + rows.map((d, i) => {
      const iffy = doubtful.has(d.num);
      const mic = d.data.mic ? String(d.data.mic) : '';
      const tag = d.num === 0 ? '<i class="tag q" title="no protocol claimed this transmission">?</i>'
        : iffy ? '<i class="tag q" title="this protocol has no checksum — the reading is unverified">?</i>'
          : mic ? `<i class="tag ok" title="passed the device’s own ${esc(mic)} check">✓</i>` : '';
      const id = d.num === 0 ? '' : [d.data.id !== undefined ? String(d.data.id) : '', d.data.channel !== undefined ? `ch ${d.data.channel}` : ''].filter(Boolean).join(' ');
      const reading = d.num === 0 ? String(d.data.summary ?? '') : r433Summary(d.data);
      return `<div class="devrow${i % 2 ? ' alt' : ''}${d.num === 0 ? ' anon' : ''}">`
        + `<span class="c-name" title="${esc(d.model)}${id ? ` ${esc(id)}` : ''} — ${esc(d.what)}"><b>${esc(d.model)}</b>${id ? `<i>${esc(id)}</i>` : ''}${tag}</span>`
        + `<span class="c-read" title="${esc(reading)}">${esc(reading)}</span>`
        + `<span class="c-n">${d.count}×</span>`
        + `<span class="c-time">${r433Clock(d.lastSeen)}</span>`
        + r433Detail(d, iffy)
        + '</div>';
    }).join('');
}

/** Everything the receiver can recognise, so it is possible to tell "nothing there" from "not supported". */
function drawR433Protocols(): void {
  const r = state.r433;
  const tog = q('#r433-ptoggle');
  if (tog) {
    tog.textContent = r.showProtocols ? 'DEVICES' : `PROTOCOLS${r.protocols.length ? ` ${r.protocols.length}` : ''}`;
    tog.classList.toggle('on', r.showProtocols);
  }
  const el = q('#r433-protocols');
  if (!el) return;
  (el as HTMLElement).hidden = !r.showProtocols;
  if (!r.showProtocols) return;
  el.innerHTML = '<div class="devnote">Every one of these runs over every burst, so nothing has to be chosen in '
    + 'advance: whatever transmits nearby is decoded. Weather stations and tire sensors, but also door contacts '
    + 'and motion detectors, gas and electricity meters, gate and blind remotes, doorbells, smoke alarms, leak '
    + 'detectors and cooking probes — anything that talks in the clear. Bursts that none of them claim are still '
    + 'listed, described by their timings.</div>'
    + r.protocols.map((p, i) => `<div class="devrow p${i % 2 ? ' alt' : ''}">`
      + `<div class="p-name"><b>${esc(p.name)}</b><i>${p.num}</i>${p.doubtful ? '<i class="tag q" title="no checksum, so a reading from it is worth a second look">?</i>' : ''}</div>`
      + (p.what ? `<div class="p-what">${esc(p.what)}</div>` : '')
      + `<div class="p-meta">${esc(p.coding)}${p.bands.length ? ` · ${p.bands.map(b => b.toFixed(2)).join(', ')} MHz` : ''}${p.doubtful ? ' · no checksum — rtl_433 ships this one off; it runs here anyway' : ''}</div>`
      + '</div>').join('');
}

// ---- pager MULTI: the hunter (the Android app's pager screen) ----------------------------------------------------
interface HuntPage { protocol: string; rate: string; cap: number; kind: string; text: string; errors: number; where: string }
interface HuntMsg { id: number; at: number; hz: number; page: HuntPage; alert: boolean; line?: string }
interface HuntChan { hz: number; db: number; listening: boolean; protocol: string; rate: string; pages: number }
/** Words that make a page a call-out: fire, EMS, police, hospital codes. */
const HUNT_ALERT = /\b(FIRE|EMS|MEDIC|AMBULANCE|CARDIAC|ARREST|STROKE|TRAUMA|CODE|STEMI|WARNING|CRITICAL|PATIENT|STRUCTURE|MVA|MVC|ACCIDENT|SHOOTING|SHOTS|STABBING|OVERDOSE|UNRESPONSIVE|RESCUE|HAZMAT|ALARM|POLICE|SWAT|ENGINE \d+|LADDER \d+|BATTALION|MEDIC \d+|RESPOND|STAT)\b/;
/** Networks send the same text again and again; folding keeps the newest copy with a count. */
const HUNT_FOLD_MS = 120_000;
const hunt = {
  messages: [] as HuntMsg[], caps: new Set<number>(), nextId: 1,
  channels: [] as HuntChan[], text: 'Waiting for the radio', hunting: true, pinned: [] as number[], heardHz: null as number | null,
  kind: 1, protocol: null as string | null, capcode: null as number | null, hz: null as number | null,
  fold: true, noise: false, full: false, drawn: 0,
};
const FULL_SVG = '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
const EXIT_SVG = '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';
const RADAR_SVG = '<svg class="radar" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".5"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".7"/><line class="sweep" x1="12" y1="12" x2="12" y2="3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></svg>';
/** TEXT shows what a person reads: letters, digits, spaces and ordinary punctuation make up at least 85% of it, and
 *  fewer than three symbols ordinary writing hardly uses (~ ^ ` [ ] \ _ = + $ ...) appear outside a network's
 *  trailing "[nn]" sequence number (the Android app's rule). Machine data and encoded payloads stay under ALL. */
function readsAsText(s: string): boolean {
  if (!s) return false;
  let good = 0;
  for (const c of s) if (/[\p{L}\p{N} .,:;!?\-\/()#@'"&\n]/u.test(c)) good++;
  if (good * 100 < s.length * 85) return false;
  let odd = 0;
  for (const c of s.replace(/\s*\[\d+\]$/, '')) if ('~^`[]\\{}|_=+<>$%*'.includes(c)) odd++;
  return odd < 3;
}
/** A page the decoder gave up on: its words were lost before anything readable came through. */
const huntUnreadable = (m: HuntMsg) => m.page.errors > 0 && !m.page.text.trim() && (m.page.kind === 'ALPHA' || m.page.kind === 'SECURE' || m.page.kind === 'BIN');

function onHuntPage(m: { hz: number; page: HuntPage; line?: string; replaces?: string }): void {
  // another transmission that filled words an earlier copy lost takes that card's place
  if (m.replaces) hunt.messages = hunt.messages.filter(x => x.line !== m.replaces);
  hunt.messages.unshift({ id: hunt.nextId++, at: Date.now(), hz: m.hz, page: m.page, alert: HUNT_ALERT.test(m.page.text.toUpperCase()), line: m.line });
  if (hunt.messages.length > 400) hunt.messages.length = 400;
  hunt.caps.add(m.page.cap);
  refreshHunt();
}
function onHuntState(m: { text: string; hunting: boolean; pinned: number[]; channels: HuntChan[]; heardHz?: number | null }): void {
  hunt.text = m.text; hunt.hunting = m.hunting; hunt.pinned = m.pinned; hunt.channels = m.channels; hunt.heardHz = m.heardHz ?? null;
  huntChannel();
  refreshHunt();
}

/** Each hunter receiver passes ±10 kHz around its carrier; the waterfall shades that around the channel being heard. */
const HUNT_CHANNEL_BW = 20_000;
function huntChannel(): void {
  const hz = hunt.heardHz;
  scope?.setChannel(hz === null ? null : HUNT_CHANNEL_BW / state.rate, hz === null ? 0.5 : 0.5 + (hz - spanCenter()) / state.rate);
}

function renderHunt(view: HTMLElement): void {
  view.classList.toggle('hfull', hunt.full);
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel"></div></section>
    <section class="controls hunt">
      ${hsHtml('<div id="hchans" class="tiles"></div>')}
      <div class="ctlrow hfeedhead">${segHtml([`<button data-hk="0">ALL</button>`, `<button data-hk="1">TEXT</button>`, `<button data-hk="2" class="red">CALL-OUTS</button>`])}<button id="hfullb" class="ib" title="full screen" aria-label="full screen">${hunt.full ? EXIT_SVG : FULL_SVG}</button><button id="hclear" class="ib" title="clear" aria-label="clear">${CLEAR_SVG}</button></div>
      ${hsHtml('<div id="htogs" class="pills"></div>')}
      <div id="hfeed" class="hfeed"></div>
    </section>`;
  q('.face')?.insertAdjacentHTML('beforeend', `<div class="hstats"><div><b id="hs-p">0</b><small>PAGES</small></div><div><b id="hs-c">0</b><small>CAPCODES</small></div><div class="red"><b id="hs-a">0</b><small>CALL-OUTS</small></div><div><b id="hs-ch">0 / 0</b><small>CHANNELS</small></div></div><div class="hspark"><div id="hspark"></div><div class="hspark-l"><span>−30 MIN</span><span>PAGES / MIN</span><span>NOW</span></div></div>`);
  scope = attach(tunableScope('scope', 70, 60)); huntChannel();
  qa<HTMLButtonElement>('[data-hk]', view).forEach(b => b.onclick = () => { hunt.kind = Number(b.dataset.hk); refreshHunt(); });
  $('hfullb').onclick = () => { hunt.full = !hunt.full; render('pager'); };
  $('hclear').onclick = () => { hunt.messages = []; hunt.caps.clear(); hunt.capcode = null; hunt.hz = null; refreshHunt(); };
  $('hchans').onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-hch],[data-hauto]'); if (!t) return;
    if (t.dataset.hauto !== undefined) worker?.postMessage({ type: 'hunt', cmd: 'auto' });
    else { const hz = Number(t.dataset.hch); worker?.postMessage({ type: 'hunt', cmd: hunt.pinned.includes(hz) ? 'unpin' : 'pin', hz }); }
  };
  $('htogs').onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-ht]'); if (!t) return;
    switch (t.dataset.ht) {
      // a lit toggle is shown; the only one lit can't hide everything, so tapping it lights the other again
      case 'flex': hunt.protocol = hunt.protocol === null ? 'POCSAG' : null; break;
      case 'pocsag': hunt.protocol = hunt.protocol === null ? 'FLEX' : null; break;
      case 'fold': hunt.fold = !hunt.fold; break;
      case 'noise': hunt.noise = !hunt.noise; break;
      case 'cap': hunt.capcode = null; break;
      case 'hz': hunt.hz = null; break;
    }
    refreshHunt();
  };
  $('hfeed').onclick = (e) => {
    const el = e.target as HTMLElement;
    const cap = el.closest<HTMLElement>('[data-hcap]'), hz = el.closest<HTMLElement>('[data-hhz]'), card = el.closest<HTMLElement>('[data-hid]');
    if (cap) { const c = Number(cap.dataset.hcap); hunt.capcode = hunt.capcode === c ? null : c; refreshHunt(); return; }
    if (hz) { const h = Number(hz.dataset.hhz); hunt.hz = hunt.hz === h ? null : h; refreshHunt(); return; }
    if (card) {
      const m = hunt.messages.find(x => x.id === Number(card.dataset.hid)); if (!m) return;
      void navigator.clipboard?.writeText(m.page.text.trim() || `CAP ${m.page.cap}`).then(() => setStatus('copied', false), () => undefined);
    }
  };
  hunt.drawn = 0;
  refreshHunt();
}

let huntFrame = 0;
/** Redraw the hunter, at most once a frame however fast pages land. */
function refreshHunt(): void {
  if (huntFrame) return;
  huntFrame = requestAnimationFrame(() => { huntFrame = 0; drawHunt(); });
}
function drawHunt(): void {
  if (state.app !== 'pager' || !state.pagerMulti || !q('#hfeed')) return;
  const msgs = hunt.messages, chans = hunt.channels;
  const decoding = chans.filter(c => c.listening && c.protocol).length;
  const alerts = msgs.filter(m => m.alert).length, flexN = msgs.filter(m => m.page.protocol === 'FLEX').length, noise = msgs.filter(huntUnreadable).length;
  // the card
  setFace(hunt.hunting ? 'HUNT' : hunt.pinned.length ? 'PINNED' : 'MANUAL', 'FLEX · POCSAG', hunt.text);
  if (!hunt.hunting) setLamp(hunt.pinned.length ? `PINNED ${hunt.pinned.length}` : 'AUTO OFF', hunt.pinned.length || decoding ? 'ok' : 'amber');
  else if (decoding) setLamp(`DECODING ${decoding}`, 'ok');
  else setLamp(state.connected ? 'HUNTING' : 'NO RADIO', state.connected ? 'amber' : '', state.connected);
  const set = (id: string, v: string) => { const e = q('#' + id); if (e && e.textContent !== v) e.textContent = v; };
  set('hs-p', String(msgs.length)); set('hs-c', String(hunt.caps.size)); set('hs-a', String(alerts)); set('hs-ch', `${decoding} / ${chans.length}`);
  // pages a minute over the last thirty, oldest at the left; a minute with a call-out in it is red
  const counts = new Array(30).fill(0), red = new Array(30).fill(false), end = Date.now();
  for (const m of msgs) { const ago = Math.floor((end - m.at) / 60_000); if (ago >= 0 && ago < 30) { counts[29 - ago]++; if (m.alert) red[29 - ago] = true; } }
  const top = Math.max(1, ...counts);
  const sp = q('#hspark'); if (sp) sp.innerHTML = counts.map((c, i) => `<i class="${c ? (red[i] ? 'r' : 'on') : ''}" style="height:${c ? Math.max(25, 100 * c / top) : 17}%"></i>`).join('');
  // the carriers: AUTO, then each one; a carrier decoding has a live dot, a pinned one is lit
  const ch = q('#hchans');
  if (ch) ch.innerHTML = `<button class="tl hauto ${hunt.hunting ? 'on' : ''}" data-hauto>${RADAR_SVG}<span><b>AUTO</b><small>${hunt.hunting ? 'hunting' : 'off · tap to hunt'}</small></span></button>` + chans.map(c => {
    const pinned = hunt.pinned.includes(c.hz), live = c.listening && !!c.protocol;
    const sub = c.protocol ? `${c.protocol} ${c.rate}${c.pages ? ` · ${c.pages}p` : ''}` : c.listening ? 'trying' : `${c.db.toFixed(0)} dB`;
    const bars = Math.max(0, Math.min(5, Math.round(c.db / 6)));
    return `<button class="tl hch ${pinned ? 'on' : ''} ${live ? 'live' : ''}" data-hch="${c.hz}"><b>${live ? '<i class="dot"></i>' : ''}${(c.hz / 1e6).toFixed(4)}</b><small>${sub}</small><span class="bars">${[0, 1, 2, 3, 4].map(i => `<i class="${i < bars ? 'on' : ''}"></i>`).join('')}</span></button>`;
  }).join('');
  // the feed's head
  qa<HTMLButtonElement>('[data-hk]').forEach(b => { const k = Number(b.dataset.hk); b.classList.toggle('on', k === hunt.kind); b.textContent = k === 0 ? `ALL ${msgs.length}` : k === 1 ? 'TEXT' : `CALL-OUTS${alerts ? ` ${alerts}` : ''}`; });
  const tg = q('#htogs');
  if (tg) tg.innerHTML = `<button class="pill ${hunt.protocol !== 'POCSAG' ? 'on' : ''}" data-ht="flex">FLEX ${flexN}</button><button class="pill ${hunt.protocol !== 'FLEX' ? 'on' : ''}" data-ht="pocsag">POCSAG ${msgs.length - flexN}</button><button class="pill ${hunt.fold ? 'on' : ''}" data-ht="fold">FOLD</button>`
    + (noise ? `<button class="pill ${hunt.noise ? 'on' : ''}" data-ht="noise">NOISE ${noise}</button>` : '')
    + (hunt.capcode !== null ? `<button class="pill only" data-ht="cap">CAP ${hunt.capcode} ✕</button>` : '')
    + (hunt.hz !== null ? `<button class="pill only" data-ht="hz">${(hunt.hz / 1e6).toFixed(4)} MHz ✕</button>` : '');
  // the cards
  const keep = (m: HuntMsg) => (hunt.noise || !huntUnreadable(m)) && (hunt.capcode === null || m.page.cap === hunt.capcode) && (hunt.hz === null || m.hz === hunt.hz)
    && (hunt.protocol === null || m.page.protocol === hunt.protocol) && (hunt.kind === 1 ? m.page.kind === 'ALPHA' && readsAsText(m.page.text.trim()) : hunt.kind === 2 ? m.alert : true);
  const rows: { m: HuntMsg; n: number; caps: Set<number> }[] = [];
  const open = new Map<string, number>();
  for (const m of msgs) {
    if (!keep(m)) continue;
    const t = m.page.text.trim(), at = hunt.fold && t ? open.get(t) : undefined;
    if (at !== undefined && rows[at].m.at - m.at <= HUNT_FOLD_MS) { rows[at].n++; rows[at].caps.add(m.page.cap); continue; }
    rows.push({ m, n: 1, caps: new Set([m.page.cap]) });
    if (t && hunt.fold) open.set(t, rows.length - 1);
  }
  const feed = q('#hfeed'); if (!feed) return;
  if (!rows.length) {
    feed.innerHTML = `<div class="hempty">${msgs.length ? '' : RADAR_SVG}<span>${msgs.length ? 'nothing matches these filters yet' : 'hunting the span for pager carriers…<br>pages land here the moment one decodes'}</span></div>`;
    return;
  }
  const atTop = feed.scrollTop < 8;
  feed.innerHTML = rows.map(({ m, n, caps }) => {
    const p = m.page, kind = m.alert ? 'alert' : p.kind === 'ALPHA' ? 'alpha' : p.kind === 'NUM' ? 'num' : 'other';
    const body = p.text.trim() ? p.text : p.kind === 'TONE' ? 'tone only (beep)' : p.errors > 0 ? 'unreadable: too much of it was lost on the air' : 'no message';
    const time = new Date(m.at).toTimeString().slice(0, 8);
    return `<div class="pcard ${kind}" data-hid="${m.id}"><div class="pc-h"><span class="pc-b">${m.alert ? '⚠ CALL-OUT' : p.kind}</span><span class="pc-t">${time}</span>${n > 1 ? `<span class="pc-x">×${n}</span>` : ''}${p.errors > 0 && p.text.trim() ? '<span class="pill a2">PARTIAL</span>' : ''}<span class="pc-r">${p.protocol} ${p.rate}</span></div>`
      + `<div class="pc-m"><button class="${hunt.capcode === p.cap ? 'on' : ''}" data-hcap="${p.cap}">CAP ${p.cap}${caps.size > 1 ? ` +${caps.size - 1}` : ''}</button><button class="hz ${hunt.hz === m.hz ? 'on' : ''}" data-hhz="${m.hz}">${(m.hz / 1e6).toFixed(4)}</button></div>`
      + `<div class="pc-body ${p.text.trim() ? '' : 'muted'}">${esc(body)}</div></div>`;
  }).join('');
  if (atTop) feed.scrollTop = 0;
}
setInterval(() => { if (state.app === 'pager' && state.pagerMulti) refreshHunt(); }, 20_000);

function renderPacket(view: HTMLElement, app: AppId): void {
  let controls = '';
  switch (app) {
    case 'pager': controls = `<div class="row">${(['flex', 'pocsag', 'both'] as const).map(w => `<button class="chip" data-pager="${w}">${w === 'both' ? 'FLEX + POCSAG' : w.toUpperCase()}</button>`).join('')}</div>` + presetHtml('CHANNEL · MHz', [['929.6125', 929_612_500], ['929.6625', 929_662_500], ['931.9375', 931_937_500], ['466.175', 466_175_000]]) + stepHtml([1e5, 12_500, 2_500]); break;
    case 'tpms': controls = presetHtml('BAND · MHz', [['315.000 · US', 315_000_000], ['433.920 · EU', 433_920_000]]) + `<div class="note">Schrader, FLM and GMC sensors. Drive past parked cars: each one repeats every minute or so.</div>`; break;
    case 'acars': controls = presetHtml('CHANNEL · MHz', [['131.550 US', 131_550_000], ['131.525 EU', 131_525_000], ['131.725 EU2', 131_725_000], ['131.450 JP', 131_450_000], ['130.025', 130_025_000]]) + `<div class="note">Registration, flight, label and text from each message, CRC checked.</div>`; break;
    case 'subghz': controls = presetHtml('BAND · MHz', [['433.92', 433_920_000], ['315.00', 315_000_000], ['868.35', 868_350_000], ['915.00', 915_000_000], ['303.875', 303_875_000]]) + `<div class="row">${(['weather', 'remotes', 'cars'] as const).map(f => `<button class="chip" data-ism="${f}">${f === 'weather' ? `WEATHER ${ISM_COUNTS.weather}` : f === 'remotes' ? `REMOTES ${ISM_COUNTS.remotes}` : `CAR KEYS ${ISM_COUNTS.cars}`}</button>`).join('')}</div>`; break;
    case 'btle': controls = `<div class="row">${[37, 38, 39].map(ch => `<button class="chip" data-btle="${ch}">CH ${ch} · ${btleChannelFreq(ch) / 1e6}</button>`).join('')}</div>`; break;
  }
  // A radio that cannot reach this app's band says so right on the screen, not just in a passing status line.
  const why = radio ? blockedBecause(APP_NEEDS[app], radio.limits) : '';
  if (why) controls = `<div class="note warn">${esc(radio!.label)} cannot receive this: ${esc(why)}. Nothing will decode here. A HackRF covers 1 MHz to 6 GHz.</div>` + controls;
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">${controls}${gainHtml()}${logHtml(app, why ? 'out of range for this radio' : 'listening…')}</section>`;
  scope = attach(app === 'btle' ? new Scope($('scope'), 0, { rows: 80, spectrumHeight: 70 }) : tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-ism]', view).forEach(b => { const f = b.dataset.ism as keyof typeof state.ism; b.classList.toggle('on', state.ism[f]); b.onclick = () => { state.ism[f] = !state.ism[f]; b.classList.toggle('on', state.ism[f]); worker?.postMessage({ type: 'ismFamilies', ...state.ism }); }; });
  qa<HTMLButtonElement>('[data-pager]', view).forEach(b => { b.classList.toggle('on', b.dataset.pager === state.pager); b.onclick = () => { state.pager = b.dataset.pager as typeof state.pager; worker?.postMessage({ type: 'pager', which: state.pager }); qa('[data-pager]').forEach(x => x.classList.toggle('on', x === b)); }; });
  qa<HTMLButtonElement>('[data-btle]', view).forEach(b => b.onclick = () => { state.btleCh = Number(b.dataset.btle); worker?.postMessage({ type: 'btleChannel', ch: state.btleCh }); tune(btleChannelFreq(state.btleCh)); refreshBtle(); });
  refreshList(app); refreshAis(); refreshBtle();
}

// ---- Meters: ERT meters, the hopping mesh networks and Gridstream meters, all heard at once ----------------------
const METERS_RATE = 4_194_304, METERS_WIDE = 19_200_000;
const MESH_GRIDSTREAM = -1, MESH_ERT = -2;
interface MeshDev {
  key: string; net: number; id: number; label: string; frames: number; firstMs: number; lastMs: number;
  hops: { hz: number; ms: number }[]; snr: number[]; clock: number; clockMs: number; clockRate: number; lastHex: string;
  address: number; uptimeS: number; uptimeMs: number; ertKind: string; commodity: string; consFirst: number; cons: number;
  consHistory: number[]; lat: number | null; lon: number | null; wanVotes: Record<string, number>; fields: { name: string; value: string }[];
}
interface MeshNetRow { sync: number; frames: number; channels: number[]; loHz: number; hiHz: number }
interface MetersSnap { nets: MeshNetRow[]; devices: MeshDev[]; links: { a: number; b: number }[]; bursts: number }
/** The Meters screen: CARDS shows every device live; MAP puts the ones that broadcast a position where they say they
 *  are (only positions decoded off the air), with the mesh links between them. A tap on a card or a pin opens
 *  everything decoded from that device. */
const meters = { snap: null as MetersSnap | null, view: 'cards' as 'cards' | 'map' | 'log', sel: '', full: false, tall: false, drawn: 0, timer: 0, drawPending: 0 };
const meshSync = (s: number) => s === MESH_GRIDSTREAM ? 'Gridstream' : s.toString(16).toUpperCase().padStart(6, '0');
const hx = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, '0');
function meshClockAt(d: MeshDev, ms: number): number {
  if (d.clock < 0) return -1;
  const v = d.clock + Math.round(d.clockRate * (ms - d.clockMs) / 1000);
  return d.net === MESH_GRIDSTREAM ? ((v % 16_800) + 16_800) % 16_800 : v & 0xFFFF;
}
function meshPerSecond(d: MeshDev): number {
  const h = d.hops; if (h.length < 2 || h[h.length - 1].ms <= h[0].ms) return 0;
  return (h.length - 1) / ((h[h.length - 1].ms - h[0].ms) / 1000);
}
/** Positioned devices: only positions decoded off the air (this device's own location is not used). */
const metersPins = (): GeoItem[] => (meters.snap?.devices ?? []).filter(d => d.lat !== null && d.lon !== null).map(d => ({ id: d.key, lat: d.lat!, lon: d.lon!, label: d.label, kind: 'station' as GeoItem['kind'] }));
function renderMeters(view: HTMLElement): void {
  const off = (r: number) => radioCan(r) ? '' : 'off';
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="mt-sum" class="mt-sum"></div>
      <div class="ctlrow">${segHtml(['cards', 'map', 'log'].map(v => `<button data-mtview="${v}">${v.toUpperCase()}</button>`))}<button id="mt-full" class="ib" title="full screen" aria-label="full screen">${meters.full ? EXIT_SVG : FULL_SVG}</button>${pauseClearHtml('ert')}</div>
      <div id="mt-stage" class="mt-stage"><div id="mt-cards" class="mt-cards"></div><div id="mt-map" class="panel map"></div><div id="mt-nopos" class="mt-nopos">no positions yet</div><div id="mt-detail" class="mt-detail" hidden></div></div>
      <div id="mt-log">${logHtml('ert', 'watching the band for meters…')}</div>
      ${presetHtml('CENTER', [['904.0', 904_000_000], ['911.6', 911_600_000], ['916.0', 916_000_000], ['920.0', 920_000_000], ['925.0', 925_000_000]])}
      <div class="ctlrow"><span class="rl">SPAN</span>${segHtml(([[2_000_000, '2 MHz'], [METERS_RATE, '4.2 MHz'], [METERS_WIDE, '19.2 MHz']] as [number, string][]).map(([r, l]) => `<button data-rate="${r}" class="${off(r)}">${l}</button>`))}</div>
      <div class="note">Utility meters, three ways at once: Itron ERT meters (SCM, SCM+, IDM) and Neptune R900 water meters with their readings, the hopping smart-meter mesh networks (each learned by its sync word, every transmitter on its own live card with its hop clock), and Landis+Gyr Gridstream meters with their IDs, uptime and position. 902–928 MHz. A HackRF watches 19.2 MHz at once; an RTL-SDR 2 MHz, and the presets move it across the band.</div>
      ${gainHtml()}</section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-mtview]', view).forEach(b => b.onclick = () => { meters.view = b.dataset.mtview as typeof meters.view; refreshMeters(true); });
  $('mt-full').onclick = () => setMetersFull(!meters.full);
  $('mt-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-mdev]'); if (c) { meters.sel = meters.sel === c.dataset.mdev ? '' : c.dataset.mdev!; refreshMeters(true); } };
  $('mt-detail').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mdo]'); if (!b) return;
    const what = b.dataset.mdo;
    if (what === 'close') meters.sel = '';
    else if (what === 'tall') meters.tall = !meters.tall;
    else if (what === 'map') {
      meters.view = 'map'; refreshMeters(true);
      const d = meters.snap?.devices.find(x => x.key === meters.sel);
      if (d && d.lat !== null && d.lon !== null) geo?.center(d.lat, d.lon, 15);
      return;
    } else if (what === 'cards') meters.view = 'cards';
    refreshMeters(true);
  };
  view.classList.toggle('metersfull', meters.full);
  // the map fits the pins themselves, never this device's own location (the meters' positions come off the air)
  geo = new GeoMap($('mt-map'), { home: null, fitPins: true, onPick: id => { meters.sel = id; refreshMeters(true); }, log });
  clearInterval(meters.timer);
  // the cards run their clocks and ages on between frames
  meters.timer = window.setInterval(() => { if (state.app !== 'ert') { clearInterval(meters.timer); return; } refreshMeters(); }, 500);
  refreshMeters(true);
}
function setMetersFull(on: boolean): void {
  meters.full = on;
  const v = q('.view.ert'); if (!v) return;
  v.classList.toggle('metersfull', on);
  const b = q('#mt-full'); if (b) { b.innerHTML = on ? EXIT_SVG : FULL_SVG; b.title = on ? 'leave full screen' : 'full screen'; }
  refreshMeters(true);
  requestAnimationFrame(() => geo?.invalidate());
}
function metersNetLine(n: MeshNetRow): string {
  const span = n.hiHz > n.loHz ? `${(n.loHz / 1e6).toFixed(2)}–${(n.hiHz / 1e6).toFixed(2)} MHz` : `${(n.loHz / 1e6).toFixed(3)} MHz`;
  return `<div>${n.sync === MESH_GRIDSTREAM ? 'GRIDSTREAM' : `NETWORK ${meshSync(n.sync)}`} · ${n.frames} frames · ${n.channels.length} channels · ${span}</div>`;
}
/** Each recent hop at its frequency across the span; time runs down the strip, joined by a faint path. */
function meshHopTrail(d: MeshDev, now: number): string {
  const lo = spanCenter() - state.rate / 2, span = Math.max(state.rate, 1), n = d.hops.length, W = 300, H = 46;
  const grid = Array.from({ length: 7 }, (_, k) => `<line x1="${W * (k + 1) / 8}" y1="2" x2="${W * (k + 1) / 8}" y2="${H - 2}"/>`).join('');
  if (!n) return `<svg class="mt-trail" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="g">${grid}</g></svg>`;
  const pts = d.hops.map((h, i) => [W * Math.min(Math.max((h.hz - lo) / span, 0), 1), n === 1 ? H / 2 : 4 + (H - 8) * i / (n - 1)]);
  const dots = pts.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === n - 1 ? 3.6 : 2.2}" opacity="${(0.15 + 0.85 * (i + 1) / n).toFixed(2)}"/>`).join('');
  const fresh = Math.max(0, 1 - (now - d.lastMs) / 900), last = pts[n - 1];
  return `<svg class="mt-trail" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="g">${grid}</g><polyline points="${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" class="p"/>${dots}${fresh > 0 ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="${(4 + 9 * (1 - fresh)).toFixed(1)}" class="ring" opacity="${(0.8 * fresh).toFixed(2)}"/>` : ''}</svg>`;
}
/** A line over recent values: an ERT meter's consumption (rising), or the signal of a transmitter's recent frames. */
function meshSpark(v: number[], fill: boolean, label: string): string {
  if (v.length < 2) return fill ? '<div class="mt-spark"></div>' : '<div class="mt-wait">waiting for the next reading</div>';
  const W = 300, H = fill ? 24 : 34;
  const lo = Math.min(...v) - (fill ? 3 : 0), hi = Math.max(...v) + (fill ? 3 : 0), sp = Math.max(hi - lo, 1);
  const pts = v.map((x, i) => `${(W * i / (v.length - 1)).toFixed(1)},${(H - H * (x - lo) / sp).toFixed(1)}`);
  return `<div class="mt-spark ${fill ? '' : 'cons'}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${fill ? `<polygon points="${pts.join(' ')} ${W},${H} 0,${H}" class="f"/>` : ''}<polyline points="${pts.join(' ')}" class="p"/></svg>${label ? `<b>${label}</b>` : ''}</div>`;
}
/** One transmitter, live: its id, its hop clock running on between frames, a trail of where its last hops landed
 *  across the span (newest at the bottom, brightest), its signal over the recent frames, and the last frame. The
 *  card lights up as each frame arrives. */
function meshCard(d: MeshDev, now: number): string {
  const age = d.lastMs > 0 ? (now - d.lastMs) / 1000 : 1e9, flash = Math.max(0, 1 - age / 0.7);
  // bursty senders go quiet for a while between bursts: a device stays lit for a minute, and once found it stays on
  // the board, dimmed only a little
  const live = age < 60, ertM = d.net === MESH_ERT, gs = d.net === MESH_GRIDSTREAM;
  const kind = ertM ? 'ERT METER' : gs ? 'GRIDSTREAM METER' : 'TRANSMITTER';
  const sub = ertM ? `${d.ertKind} · ${d.commodity}` : gs ? (d.lat !== null ? 'POSITION ON AIR' : 'LANDIS+GYR') : `NET ${meshSync(d.net)}`;
  const status = live ? 'LIVE' : d.lastMs === 0 ? 'ADDRESSED' : age < 120 ? `${Math.floor(age)} s ago` : `${Math.floor(age / 60)} min ago`;
  let clock: string;
  if (ertM) clock = `<b>${d.cons}</b><small>${d.cons > d.consFirst ? `+${d.cons - d.consFirst} SINCE HEARD` : 'CONSUMPTION'}</small><em>${d.frames} readings</em>`;
  else {
    const c = meshClockAt(d, now);
    if (gs) {
      const up = d.uptimeS < 0 ? -1 : d.uptimeS + Math.trunc((now - d.uptimeMs) / 1000);
      const p2 = (x: number) => String(x).padStart(2, '0');
      clock = `<b>${c >= 0 ? (c / 100).toFixed(2).padStart(6, '0') : '---.--'}</b><small>${up >= 0 ? `HOP s · UP ${Math.floor(up / 86400)}d ${p2(Math.floor(up / 3600) % 24)}h ${p2(Math.floor(up / 60) % 60)}m ${p2(up % 60)}s` : 'HOP s'}</small>`;
    } else clock = `<b>${c >= 0 ? hx(c, 4) : '----'}</b><small>${d.clockRate !== 0 ? `HOP CLOCK ${d.clockRate >= 0 ? '+' : ''}${d.clockRate.toFixed(0)}/s` : 'HOP CLOCK'}</small>`;
    clock += `<em>${d.frames} · ${meshPerSecond(d).toFixed(1)}/s</em>`;
  }
  return `<div class="mt-card ${meters.sel === d.key ? 'sel' : ''} ${live ? '' : 'dim'}" data-mdev="${esc(d.key)}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-id ${d.label.length > 2 ? '' : 'big'}">${esc(d.label)}</span><span class="mt-k"><b>${kind}</b><small class="${d.lat !== null ? 'pos' : ''}">${esc(sub)}</small>${d.address >= 0 ? `<i>NODE ID ${hx(d.address, 6)} · ${d.address}</i>` : ''}</span><span class="mt-live ${live ? 'on' : ''}"><i></i>${status}</span></div>`
    + `<div class="mt-clk">${clock}</div>`
    + (ertM ? meshSpark(d.consHistory, false, '') : meshHopTrail(d, now) + meshSpark(d.snr, true, d.snr.length ? `+${d.snr[d.snr.length - 1]} dB` : ''))
    + `<div class="mt-hex">${esc(d.lastHex)}</div></div>`;
}
/** Everything decoded from one device, field by field, with MAP when it has a position. */
function meshDetail(d: MeshDev, onMap: boolean): string {
  const kind = d.net === MESH_ERT ? 'ERT METER' : d.net === MESH_GRIDSTREAM ? 'GRIDSTREAM METER' : `MESH NODE · ${meshSync(d.net)}`;
  const votes = Object.values(d.wanVotes);
  return `<div class="mt-dh"><b>${esc(d.label)}</b><span>${kind}</span>${onMap ? '<button class="chip" data-mdo="map">MAP</button>' : ''}${meters.view === 'map' ? '<button class="chip" data-mdo="cards">CARDS</button>' : ''}<button class="chip" data-mdo="tall">${meters.tall ? 'LESS' : 'MORE'}</button><button class="chip" data-mdo="close">✕</button></div>`
    + `<div class="mt-fields ${meters.tall ? 'tall' : ''}">${d.fields.map(f => `<div><b>${esc(f.name)}</b><span>${esc(f.value)}</span></div>`).join('')}`
    + (d.net === MESH_GRIDSTREAM && votes.length > 1 ? `<p>position heard ${Math.max(...votes)}× of ${votes.reduce((a, b) => a + b, 0)} beacons (the most-heard one is shown)</p>` : '') + '</div>';
}
function refreshMeters(force = false): void {
  if (state.app !== 'ert') return;
  const now = Date.now();
  // the cards repaint at most four times a second
  if (!force && now - meters.drawn < 240) { clearTimeout(meters.drawPending); meters.drawPending = window.setTimeout(() => refreshMeters(true), 250); return; }
  meters.drawn = now;
  const snap = meters.snap, devs = snap?.devices ?? [], nets = snap?.nets ?? [];
  const ertN = devs.filter(d => d.net === MESH_ERT).length, pins = metersPins();
  if (meters.full && meters.view === 'log') meters.view = 'cards';
  const sum = q('#mt-sum');
  if (sum) sum.innerHTML = (nets.length === 0 && ertN === 0 ? `<div class="muted">${snap && snap.bursts > 0 ? `${snap.bursts} bursts heard, no network locked yet` : 'watching the band for meters'}</div>` : '')
    + nets.slice(0, 3).map(metersNetLine).join('') + (ertN ? `<div>ERT · ${ertN} meters</div>` : '');
  qa<HTMLButtonElement>('[data-mtview]').forEach(b => { const v = b.dataset.mtview; b.classList.toggle('on', v === meters.view); b.textContent = v === 'cards' ? `DEVICES ${devs.length}` : v === 'map' ? `MAP ${pins.length}` : 'LOG'; b.hidden = v === 'log' && meters.full; });
  const cards = q('#mt-cards'), mapEl = q('#mt-map'), logEl = q('#mt-log'), nopos = q('#mt-nopos'), det = q('#mt-detail'), stage = q('#mt-stage');
  if (!cards || !mapEl || !logEl || !nopos || !det || !stage) return;
  cards.hidden = meters.view !== 'cards'; mapEl.hidden = meters.view !== 'map';
  logEl.hidden = meters.view !== 'log'; stage.hidden = meters.view === 'log';
  nopos.hidden = meters.view !== 'map' || pins.length > 0;
  if (meters.view === 'cards' && !paused.has('ert')) {
    const top = cards.scrollTop;
    const list = [...devs].sort((a, b) => a.firstMs - b.firstMs || (a.key < b.key ? -1 : 1));
    cards.innerHTML = list.length ? list.map(d => meshCard(d, now)).join('') : '<div class="empty">no devices yet</div>';
    cards.scrollTop = top;
  }
  const picked = devs.find(d => d.key === meters.sel);
  det.hidden = !picked;
  if (picked) { const top = q('.mt-fields', det)?.scrollTop ?? 0; det.innerHTML = meshDetail(picked, pins.some(p => p.id === picked.key)); const f = q('.mt-fields', det); if (f) f.scrollTop = top; }
  if (meters.view === 'map') {
    geo?.invalidate();
    geo?.update(pins, meters.sel);
    const at = new Map<number, [number, number]>();
    for (const d of devs) if (d.net === MESH_GRIDSTREAM && d.lat !== null && d.lon !== null) at.set(d.id, [d.lat, d.lon]);
    geo?.setLines((snap?.links ?? []).filter(l => at.has(l.a) && at.has(l.b)).map(l => [at.get(l.a)!, at.get(l.b)!]));
  }
  const n = devs.length;
  if (n > 0) setLamp(`${n} DEVICE${n === 1 ? '' : 'S'}`, 'ok');
}

// ---- Trains: end-of-train telemetry and the PTC train-control network (receive only) ----------------------------
interface TrainsSnap { band: 'EOT' | 'PTC'; hears: string[]; units: EotUnit[]; hots: HotHeard[]; stations: PtcStation[]; activity: Record<string, number>; other: number }
const trainsUi = { snap: null as TrainsSnap | null, view: 'units' as 'units' | 'ptc' | 'hot', band: 'PTC' as 'EOT' | 'PTC', auto: true, timer: 0, cycle: 0, drawn: 0, pending: 0, picked: false, sel: '', tall: false, waterfall: null as boolean | null };
/** Tunes for the band: as wide as it needs where the radio can (both EOT channels, or all of 216-222.5 MHz), else the
 *  channels heard most, from 2 MHz. */
function trainsTune(): void {
  if (trainsUi.band === 'EOT') {
    const wide = radioCan(TR_EOT_RATE);
    configure('NONE', wide ? TR_EOT_CENTER : TR_EOT_NARROW, wide ? TR_EOT_RATE : 2e6, 32, 40, true, 'trains', { band: 'EOT' });
  } else {
    const wide = radioCan(TR_PTC_RATE);
    configure('NONE', wide ? TR_PTC_CENTER : TR_PTC_NARROW, wide ? TR_PTC_RATE : 2e6, 32, 40, true, 'trains', { band: 'PTC' });
  }
}
/** BOTH: the radio takes turns, 30 s on PTC (a wayside speaks every ~46 s) and 20 s on EOT, while the app is open. */
function trainsCycle(): void {
  clearTimeout(trainsUi.cycle);
  trainsUi.cycle = window.setTimeout(() => {
    if (state.app !== 'trains' || !trainsUi.auto) return;
    trainsUi.band = trainsUi.band === 'EOT' ? 'PTC' : 'EOT'; trainsTune(); render('trains'); trainsCycle();
  }, trainsUi.band === 'PTC' ? 30_000 : 20_000);
}
function trainsSetBand(b: 'EOT' | 'PTC' | 'BOTH'): void {
  clearTimeout(trainsUi.cycle);
  trainsUi.auto = b === 'BOTH';
  if (b !== 'BOTH') trainsUi.band = b;
  // BOTH: the radio takes turns, 20 s on each band, while the app is open
  if (trainsUi.auto) trainsCycle();
  if (state.app === 'trains') { trainsTune(); render('trains'); }
}
/** The strongest burst in the last 4 s: 20 ms PTC bursts and 0.2 s EOT frames barely move the band's average, so the
 *  meter follows the bursts themselves. */
function trainsBurst(): number | null {
  const s = trainsUi.snap; if (!s) return null;
  const now = Date.now();
  const v = [...s.stations.filter(x => now - x.lastMs < 4000).map(x => x.snr[x.snr.length - 1]), ...s.units.filter(u => now - u.lastMs < 4000).map(u => u.snr[u.snr.length - 1])].filter(x => x !== undefined);
  return v.length ? Math.max(...v) : null;
}
const trAgo = (ms: number) => ms < 2_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`;
const trClock = (ms: number) => new Date(ms).toLocaleTimeString();
const trPill = (text: string, tone: '' | 'ok' | 'red' | 'acc' = '') => `<span class="tr-pill ${tone}">${esc(text)}</span>`;

/** What the rear unit's brake pipe says: a drop from where it was charged is a brake application, the line vented near
 *  zero is an emergency, and pressure coming back is the release. */
function trBrake(u: EotUnit): [string, 'red' | 'ok'] | null {
  const p = u.last.psig, peak = u.pressure.filter(x => u.lastMs - x[0] < 600_000).reduce((m, x) => Math.max(m, x[1]), p);
  const prev = u.pressure.length >= 2 ? u.pressure[u.pressure.length - 2][1] : p;
  if (p < 15 && peak >= 40) return ['EMERGENCY · LINE VENTED', 'red'];
  if (peak - p >= 6 && p <= prev) return [`BRAKES APPLIED −${peak - p} PSI`, 'red'];
  if (p - prev >= 3) return [`RELEASING +${p - prev} PSI`, 'ok'];
  return null;
}

/** The waterfall at 8 MHz shows little of a 20 ms burst: a phone-width window leaves it out for the cards (the band
 *  strip shows the bursts), a wider one keeps it, and the WATERFALL button overrides either. */
const trainsWaterfall = () => trainsUi.waterfall ?? window.innerWidth >= 700;
function renderTrains(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual ${trainsWaterfall() ? '' : 'tr-nowf'}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div class="ctlrow">${segHtml(([['EOT', 'EOT'], ['PTC', 'PTC'], ['BOTH', 'BOTH']] as [string, string][]).map(([k, l]) => `<button data-trband="${k}">${l}</button>`))}<button id="tr-wf" class="tog ${trainsWaterfall() ? 'on' : ''}">WATERFALL</button></div>
      <div id="tr-lamps" class="tr-lamps"></div>
      <div id="tr-banner" class="tr-banner"></div>
      <div id="tr-strip" class="tr-strip"></div>
      <div class="ctlrow">${segHtml(['units', 'ptc', 'hot'].map(v => `<button data-trview="${v}"></button>`))}${pauseClearHtml('trains')}</div>
      <div class="tr-stage"><div id="tr-cards" class="mt-cards tr-cards"></div><div id="tr-detail" class="mt-detail" hidden></div></div>
      <div id="tr-log">${logHtml('trains', 'listening for trains…')}</div>
      <div class="note">The railroad's radios, receive only. EOT · HOT decodes the end-of-train units (brake pipe pressure, motion, marker light, battery) and spots the head unit's commands to them; PTC 220 watches the train-control network: base stations, wayside units (and when their status changes) and locomotives. BOTH takes turns. 457.9375 EOT · 452.9375 HOT · 457.925 DPU · 217–222 MHz PTC. A HackRF hears both EOT channels or all of PTC at once. Tap a card for everything decoded from it.</div>
      ${gainHtml()}</section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-trband]', view).forEach(b => b.onclick = () => trainsSetBand(b.dataset.trband as 'EOT' | 'PTC' | 'BOTH'));
  $('tr-wf').onclick = () => { trainsUi.waterfall = !trainsWaterfall(); render('trains'); };
  qa<HTMLButtonElement>('[data-trview]', view).forEach(b => b.onclick = () => { trainsUi.view = b.dataset.trview as typeof trainsUi.view; trainsUi.picked = true; trainsUi.sel = ''; refreshTrains(true); });
  $('tr-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-trsel]'); if (c) { trainsUi.sel = trainsUi.sel === c.dataset.trsel ? '' : c.dataset.trsel!; refreshTrains(true); } };
  $('tr-detail').onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-trdo]'); if (!b) return; if (b.dataset.trdo === 'close') trainsUi.sel = ''; else trainsUi.tall = !trainsUi.tall; refreshTrains(true); };
  clearInterval(trainsUi.timer);
  // the cards run their ages, countdowns and timelines on between reports
  trainsUi.timer = window.setInterval(() => { if (state.app !== 'trains') { clearInterval(trainsUi.timer); return; } refreshTrains(); }, 250);
  refreshTrains(true);
}

/** Brake pipe pressure, 0-127 psig, on an arc; a charged train line is about 90. */
function trGauge(psig: number, red: boolean): string {
  const f = Math.max(0, Math.min(1, psig / 127)), a = Math.PI * (1 + f), x = 42 + 34 * Math.cos(a), y = 52 + 34 * Math.sin(a);
  const t = Math.PI * (1 + 90 / 127);
  return `<svg class="tr-gauge ${red ? 'red' : ''}" viewBox="0 0 84 60"><path class="t" d="M8 52 A34 34 0 0 1 76 52"/><path class="v" d="M8 52 A34 34 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}"/>`
    + `<line x1="${(42 + 29 * Math.cos(t)).toFixed(1)}" y1="${(52 + 29 * Math.sin(t)).toFixed(1)}" x2="${(42 + 39 * Math.cos(t)).toFixed(1)}" y2="${(52 + 39 * Math.sin(t)).toFixed(1)}"/>`
    + `<text x="42" y="46" class="n">${psig}</text><text x="42" y="57" class="u">PSIG</text></svg>`;
}
/** The rear unit's brake pipe pressure across its reports: a drop is the brakes going on. */
function trPressure(u: EotUnit): string {
  const v = u.pressure;
  if (v.length < 2) return '<div class="mt-wait">pressure history builds with each report</div>';
  const t0 = v[0][0], t1 = Math.max(v[v.length - 1][0], t0 + 1), lo = Math.min(...v.map(p => p[1])) - 4, hi = Math.max(...v.map(p => p[1])) + 4;
  const pts = v.map(([t, p]) => `${(100 * (t - t0) / (t1 - t0)).toFixed(2)},${(34 - 34 * (p - lo) / Math.max(hi - lo, 1)).toFixed(2)}`);
  return `<div class="mt-spark cons"><svg viewBox="0 0 100 34" preserveAspectRatio="none"><polygon class="f" points="0,34 ${pts.join(' ')} 100,34"/><polyline class="p" points="${pts.join(' ')}"/></svg></div>`;
}
function trUnitCard(u: EotUnit, now: number): string {
  const age = now - u.lastMs, flash = Math.max(0, 1 - age / 900), live = age < 120_000, p = u.last, br = trBrake(u);
  const batt = p.batteryCond === 'OK' ? 'ok' : p.batteryCond === 'NOT MONITORED' ? '' : 'red';
  return `<div class="mt-card tr-card ${trainsUi.sel === 'u' + u.unit ? 'sel' : ''} ${live ? '' : 'dim'}" data-trsel="u${u.unit}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-k"><span class="tr-id">${u.unit}</span><b>${u.channel === 'DPU' ? 'DISTRIBUTED POWER' : 'END OF TRAIN'}</b><small>${u.frames} report${u.frames === 1 ? '' : 's'} · first ${trAgo(now - u.firstMs)}</small></span>${trGauge(p.psig, br?.[1] === 'red')}</div>`
    + `<div class="tr-pills">${br ? trPill(br[0], br[1]) : ''}${trPill(p.motion ? 'MOVING' : 'STOPPED', p.motion ? 'acc' : '')}${trPill(p.markerLight ? 'MARKER ON' : 'MARKER OFF', p.markerLight ? 'ok' : '')}${trPill(`BATT ${p.batteryPct}%`, batt)}${p.arm !== 'NORMAL' ? trPill(p.arm, 'red') : ''}${u.hotMs > 0 && now - u.hotMs < 600_000 ? trPill('HOT LINK', 'acc') : ''}</div>`
    + trPressure(u)
    + `<div class="tr-foot"><span class="mt-live ${live ? 'on' : ''}"><i></i>${live ? 'LIVE · ' : ''}${trAgo(age)}</span><small>battery ${p.batteryCond.toLowerCase()} · turbine ${p.turbine ? 'on' : 'off'}${u.snr.length ? ` · +${u.snr[u.snr.length - 1]} dB` : ''}</small></div></div>`;
}
/** One PTC station: where, what it is, how often it speaks, when it should speak next, whether its message changes,
 *  and the last five minutes. */
function trStationCard(s: PtcStation, now: number): string {
  const age = now - s.lastMs, flash = Math.max(0, 1 - age / 700), per = stationPeriod(s), live = age < Math.max(30_000, per * 2500);
  const changed = s.lastChangeMs > 0 && now - s.lastChangeMs < 60_000, loco = s.kind === 'LOCOMOTIVE';
  const status = changed ? trPill(`STATUS CHANGED ${trAgo(now - s.lastChangeMs)}`, 'red') : stationVaries(s) ? trPill('NEW CONTENT EVERY BURST') : s.steady >= 1 ? trPill(`SAME STATUS ×${s.steady + 1}`, 'ok') : trPill('LISTENING');
  let next = '';
  // BOTH has the radio on the EOT channels for a while: nothing is late, it just isn't being heard
  if (per > 0 && trainsUi.band !== 'PTC') next = '<div class="tr-next"><b class="muted">ON EOT · BACK SOON</b></div>';
  else if (per > 0) {
    const el = age / 1000, late = el > per * 1.3;
    next = `<div class="tr-next ${late ? 'late' : ''}"><span><i style="width:${(100 * Math.min(1, el / per)).toFixed(1)}%"></i></span><b>${late ? `OVERDUE ${(el - per).toFixed(0)} s` : `NEXT IN ${(per - el).toFixed(1)} s`}</b></div>`;
  }
  const ticks = s.times.map(t => {
    const x = 100 * (1 - (now - t) / 300_000); if (x < 0) return '';
    const fr = Math.max(0, 1 - (now - t) / 1500);
    return `<line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="3" y2="17" style="stroke-opacity:${(0.55 + 0.45 * fr).toFixed(2)};stroke-width:${(1.4 + 2 * fr).toFixed(1)}"/>`;
  }).join('');
  const shades = [0.18, 0.42, 0.66, 0.95], w = 100 / Math.max(1, s.print.length);
  const print = s.print.map((v, i) => `<rect x="${(i * w).toFixed(2)}" width="${(w - 0.6).toFixed(2)}" y="0" height="12" style="fill-opacity:${shades[v & 3]}"/>`).join('');
  return `<div class="mt-card tr-card ${loco ? 'loco' : ''} ${changed || trainsUi.sel === 's' + s.hz ? 'sel' : ''} ${live ? '' : 'dim'}" data-trsel="s${s.hz}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-k"><span class="tr-id">${(s.hz / 1e6).toFixed(4)}</span><b>${PTC_KIND_LABEL[s.kind]}</b></span><span class="tr-per"><b>${per > 0 ? per.toFixed(per < 10 ? 2 : 1) + ' s' : s.bursts === 1 ? 'HEARD ONCE' : '—'}</b><small>${per > 0 ? `EVERY · ${s.bursts} BURSTS` : `${s.bursts} BURST${s.bursts === 1 ? '' : 'S'}`}</small></span></div>`
    + `<div class="tr-pills">${status}${s.changes > 0 && !changed ? trPill(`${s.changes} CHANGE${s.changes > 1 ? 'S' : ''}`, 'acc') : ''}${trPill(`${s.lastSymbols} SYM`)}</div>`
    + next
    + `<svg class="tr-time" viewBox="0 0 100 20" preserveAspectRatio="none"><g class="g">${[20, 40, 60, 80].map(x => `<line x1="${x}" x2="${x}" y1="1" y2="19"/>`).join('')}</g>${ticks}</svg>`
    + `<svg class="tr-print" viewBox="0 0 100 12" preserveAspectRatio="none">${print}</svg>`
    + `<div class="tr-foot"><span class="mt-live ${live ? 'on' : ''}"><i></i>${live ? 'LIVE · ' : ''}${trAgo(age)}</span><small>π/4-DQPSK 16 kbps${s.snr.length ? ` · +${s.snr[s.snr.length - 1]} dB` : ''}</small></div></div>`;
}
function trHotRow(h: HotHeard, now: number): string {
  return `<div class="tr-hot panel"><b>HOT</b><span><em>command ${h.data.toString(16).toUpperCase().padStart(8, '0')}${h.unit !== null ? ` → unit ${h.unit}` : ''}</em><small>sync ${h.sync24.toString(16).toUpperCase().padStart(6, '0')} · ${h.agree} of 3 copies agree${h.parityOk ? '' : ' · parity?'} · +${h.snrDb} dB</small></span><small>${trAgo(now - h.ms)}</small></div>`;
}
/** The PTC band, 216-222.5 MHz: the wayside, base and locomotive sub-bands, and every station heard as a mark at its
 *  frequency that flares on each burst. The waterfall at 8 MHz can't show a 20 ms burst; this can. */
function trStrip(stations: PtcStation[], now: number): string {
  const x = (mhz: number) => 100 * (mhz - 216) / 6.5;
  const zones = ([[217, 220, 'w'], [220, 221, 'b'], [221, 222, 'l']] as [number, number, string][]).map(([a, b, k]) => `<rect class="z ${k}" x="${x(a)}" width="${x(b) - x(a)}" y="0" height="40"/><line class="u ${k}" x1="${x(a)}" x2="${x(b)}" y1="39" y2="39"/>`).join('');
  const grid = [217, 218, 219, 220, 221, 222].map(m => `<line class="g" x1="${x(m)}" x2="${x(m)}" y1="0" y2="40"/>`).join('');
  const marks = stations.map(s => {
    const fr = Math.max(0, 1 - (now - s.lastMs) / 1200), px = x(s.hz / 1e6), k = s.kind === 'LOCOMOTIVE' ? 'l' : s.kind === 'WAYSIDE' ? 'w' : 'b';
    return (fr > 0 ? `<ellipse class="f ${k}" cx="${px.toFixed(2)}" cy="18" rx="${(1 + 3 * (1 - fr)).toFixed(2)}" ry="${(6 + 14 * (1 - fr)).toFixed(1)}" style="fill-opacity:${(0.35 * fr).toFixed(2)}"/>` : '')
      + `<line class="m ${k}" x1="${px.toFixed(2)}" x2="${px.toFixed(2)}" y1="5" y2="33" style="stroke-width:${(2 + 2.5 * fr).toFixed(1)};stroke-opacity:${(0.55 + 0.45 * fr).toFixed(2)}"/>`;
  }).join('');
  const labels = [217, 218, 219, 220, 221, 222].map(m => `<span style="left:${x(m).toFixed(2)}%">${m}</span>`).join('');
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none">${zones}${grid}${marks}</svg><div class="tr-scale">${labels}</div>`;
}
/** Every field the rear unit's frame carries, and what the receiver made of it. */
function trEotFields(u: EotUnit, now: number): [string, string][] {
  const p = u.last, lo = Math.min(...u.pressure.map(x => x[1])), hi = Math.max(...u.pressure.map(x => x[1]));
  let hex = ''; for (let i = 0; i < p.bits.length; i += 4) hex += parseInt(p.bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16).toUpperCase();
  return [
    ['UNIT ID', `${p.unit}  (0x${p.unit.toString(16).toUpperCase().padStart(5, '0')})`], ['CHANNEL', u.channel === 'DPU' ? 'DPU 457.925 MHz' : 'EOT 457.9375 MHz'],
    ['BRAKE PIPE', `${p.psig} psig`], ['RANGE HEARD', `${lo} – ${hi} psig over ${u.pressure.length} reports`], ['BRAKES', trBrake(u)?.[0] ?? 'released / steady'],
    ['MOTION', p.motion ? 'moving' : 'stopped'], ['MARKER LIGHT', p.markerLight ? 'on' : 'off'], ['MARKER BATTERY', p.markerBattery ? 'ok' : 'weak'],
    ['BATTERY', `${p.batteryPct}% · ${p.batteryCond.toLowerCase()}`], ['AIR TURBINE', p.turbine ? 'generating' : 'off'], ['VALVE CIRCUIT', p.valve ? '1 (ready)' : '0'],
    ['ARM STATUS', p.arm.toLowerCase()], ['MESSAGE TYPE', `${p.type} (${p.type.toString(2).padStart(3, '0')})`], ['CONFIRM BIT', p.confirm ? '1' : '0'],
    ['HEAD UNIT LINK', u.hotMs > 0 ? `command heard ${trAgo(now - u.hotMs)}` : 'none heard'], ['REPORTS', `${u.frames}`],
    ['FIRST HEARD', trClock(u.firstMs)], ['LAST HEARD', `${trClock(u.lastMs)} · ${trAgo(now - u.lastMs)}`],
    ['SIGNAL', u.snr.length ? `+${u.snr[u.snr.length - 1]} dB (best +${Math.max(...u.snr)} dB)` : '—'], ['CHECK', 'BCH(63,45) passed'], ['FRAME', hex],
  ];
}
/** Everything that can be read off a PTC station without the network's keys. */
function trPtcFields(s: PtcStation, now: number): [string, string][] {
  const per = stationPeriod(s);
  const role = s.kind === 'WAYSIDE' ? 'wayside interface unit (217–220 MHz): signals and switches on its block' : s.kind === 'BASE' ? "base station (220–221 MHz): the network's beacon" : s.kind === 'LOCOMOTIVE' ? 'locomotive (221–222 MHz): a PTC train in range' : 'PTC, outside the usual sub-bands';
  return [
    ['FREQUENCY', `${(s.hz / 1e6).toFixed(4)} MHz`], ['ROLE', role],
    ['PERIOD', per > 0 ? `${per.toFixed(2)} s (${s.gaps.slice(-4).map(g => g.toFixed(1)).join(' · ')})` : '—'], ['BURSTS', `${s.bursts}`],
    ['MESSAGE LENGTHS', s.lengths.map(n => `${n} sym`).join(' · ')], ['CONTENT', stationVaries(s) ? 'new every burst (a running counter or time)' : s.steady >= 1 ? `same ×${s.steady + 1}` : '—'],
    ['STATUS CHANGES', s.changes > 0 ? `${s.changes} · last ${trAgo(now - s.lastChangeMs)}` : 'none'], ['STATION HEADER', symHex(s.last, 0, 16)],
    ['CARRIER', `${s.carrierHz >= 0 ? '+' : ''}${s.carrierHz.toFixed(0)} Hz off channel (its own crystal)`], ['SIGNAL', `+${s.snr[s.snr.length - 1] ?? 0} dB (best +${s.snrMax} dB)`],
    ['FIRST HEARD', trClock(s.firstMs)], ['LAST HEARD', `${trClock(s.lastMs)} · ${trAgo(now - s.lastMs)}`],
    ['MODULATION', 'π/4-DQPSK · 8000 sym/s · 16 kbps · 25 kHz'], ['SYNC', '9-symbol preamble + shared 30-symbol word'], ['MESSAGE', symHex(s.last)],
  ];
}
function trDetail(title: string, kind: string, fields: [string, string][], red: boolean): string {
  return `<div class="mt-dh ${red ? 'red' : ''}"><b>${esc(title)}</b><span>${esc(kind)}</span><button class="chip" data-trdo="tall">${trainsUi.tall ? 'LESS' : 'MORE'}</button><button class="chip" data-trdo="close">✕</button></div>`
    + `<div class="mt-fields tr-fields ${trainsUi.tall ? 'tall' : ''}">${fields.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
}
const TRAIN_SCENE = '<svg class="tr-scene" viewBox="0 0 92 40"><line class="rail" x1="0" y1="37.6" x2="92" y2="37.6"/><g class="ties">'
  + Array.from({ length: 12 }, (_, i) => `<line x1="${i * 10.2 - 10}" y1="36" x2="${i * 10.2 - 12.5}" y2="40"/>`).join('')
  + '</g><rect class="body" x="5.5" y="11.2" width="57" height="16.8" rx="3"/><rect x="41" y="2.4" width="17" height="8.8" rx="2"/><path d="M62.5 14.6 L71.7 20.4 L71.7 28 L62.5 28"/>'
  + '<circle class="lamp" cx="71.7" cy="21.6" r="2.4"/><path class="beam" d="M71.7 21.6 L92 10.4 L92 30.4 Z"/>'
  + '<g class="w"><circle cx="16" cy="32" r="4.8"/><circle cx="34.3" cy="32" r="4.8"/><circle cx="52.6" cy="32" r="4.8"/></g></svg>';
function refreshTrains(force = false): void {
  if (state.app !== 'trains') return;
  const now = Date.now();
  if (!force && now - trainsUi.drawn < 240) { clearTimeout(trainsUi.pending); trainsUi.pending = window.setTimeout(() => refreshTrains(true), 250); return; }
  trainsUi.drawn = now;
  const s = trainsUi.snap, units = s?.units ?? [], stations = s?.stations ?? [], hots = s?.hots ?? [], band = trainsUi.band;
  // whoever is heard first picks the view: a unit's card, else the PTC stations
  if (!trainsUi.picked && units.length === 0 && stations.length > 0 && trainsUi.view === 'units') trainsUi.view = 'ptc';
  qa<HTMLButtonElement>('[data-trband]').forEach(b => b.classList.toggle('on', trainsUi.auto ? b.dataset.trband === 'BOTH' : b.dataset.trband === band));
  qa<HTMLButtonElement>('[data-trview]').forEach(b => { const v = b.dataset.trview; b.classList.toggle('on', v === trainsUi.view); b.textContent = v === 'units' ? `EOT · ${units.length}` : v === 'ptc' ? `PTC · ${stations.length}` : `HOT · ${hots.length}`; });
  const lamps = q('#tr-lamps');
  if (lamps) {
    const hears = s?.hears ?? [], act = s?.activity ?? {};
    lamps.innerHTML = band === 'EOT'
      ? ([['EOT', '457.9375'], ['HOT', '452.9375'], ['DPU', '457.925']] as [string, string][]).map(([n, mhz]) => { const on = hears.includes(n), lit = on && now - (act[n] ?? 0) < 1500; return `<span class="tr-lamp ${lit ? 'lit' : on ? 'on' : ''}"><i></i>${n} ${mhz}</span>`; }).join('') + (hears.includes('HOT') || !s ? '' : '<small>HOT needs a radio 6 MHz wide</small>')
      : '<span class="tr-lamp on"><i></i>WAYSIDE 217</span><span class="tr-lamp on"><i></i>BASE 220</span><span class="tr-lamp on"><i></i>LOCO 221</span>';
  }
  // the headline: a train nearby (a rear unit, a locomotive on PTC, or a head unit's command in the last two minutes),
  // moving, stopped or braking; a PTC locomotive or the brakes going on turn it red
  const recent = units.filter(u => now - u.lastMs < 120_000), loco = stations.filter(x => x.kind === 'LOCOMOTIVE' && now - x.lastMs < 120_000), hot = hots.find(h => now - h.ms < 120_000);
  const train = recent.length > 0 || loco.length > 0 || !!hot, moving = recent.some(u => u.last.motion);
  const braking = recent.map(trBrake).find(b => b !== null) ?? null;
  const red = braking?.[1] === 'red' || loco.length > 0;
  const head = braking?.[1] === 'red' ? (braking[0].startsWith('EMERGENCY') ? 'EMERGENCY BRAKING' : 'TRAIN BRAKING') : train && moving ? 'TRAIN NEARBY · MOVING' : recent.length ? 'TRAIN NEARBY · STOPPED' : loco.length ? 'PTC TRAIN APPROACHING' : train ? 'TRAIN NEARBY' : stations.length ? 'PTC TERRITORY' : 'LISTENING FOR TRAINS';
  const bits: string[] = [];
  if (recent[0]) bits.push(`rear unit ${recent[0].unit} · ${recent[0].last.psig} psig`);
  if (loco.length) bits.push(`${loco.length} locomotive${loco.length > 1 ? 's' : ''} on PTC`);
  if (hot) bits.push(`head unit command ${trAgo(now - hot.ms)}`);
  // a wayside's status changing is the signal and switch logic reacting to a train on its block
  const way = stations.filter(x => x.kind === 'WAYSIDE' && x.lastChangeMs > 0 && now - x.lastChangeMs < 120_000).sort((a, b) => b.lastChangeMs - a.lastChangeMs)[0];
  if (way) bits.push(`wayside ${(way.hz / 1e6).toFixed(4)} changed ${trAgo(now - way.lastChangeMs)}`);
  if (!bits.length) { const base = stations.filter(x => x.kind === 'BASE').length, wn = stations.filter(x => x.kind === 'WAYSIDE').length; bits.push(stations.length ? `${base} base · ${wn} wayside station${wn === 1 ? '' : 's'} heard` : 'end-of-train units and the PTC network'); }
  const banner = q('#tr-banner');
  if (banner) {
    banner.className = `tr-banner ${train ? 'train' : ''} ${red ? 'red' : ''} ${moving || (loco.length && !recent.length) ? 'rolling' : ''}`;
    if (!banner.firstElementChild) banner.innerHTML = `${TRAIN_SCENE}<span><b></b><small></small></span>`;
    q('b', banner)!.textContent = head; q('small', banner)!.textContent = bits.join(' · ');
  }
  const strip = q('#tr-strip');
  if (strip) { strip.hidden = !(band === 'PTC' || trainsUi.auto || stations.length > 0); if (!strip.hidden) strip.innerHTML = trStrip(stations, now); }
  const cards = q('#tr-cards'), det = q('#tr-detail');
  if (cards && !paused.has('trains')) {
    const top = cards.scrollTop, v = trainsUi.view;
    cards.innerHTML = v === 'units'
      ? (units.length ? [...units].sort((a, b) => a.firstMs - b.firstMs).map(u => trUnitCard(u, now)).join('') : `<div class="empty">${band === 'EOT' || trainsUi.auto ? 'no end-of-train unit heard yet · they report about once a minute and on every brake change' : 'switch to EOT · HOT to hear the rear units'}</div>`)
      : v === 'ptc'
        // in the order first heard: a new station joins at the end, so nothing the eye is on moves
        ? (stations.length ? [...stations].sort((a, b) => a.firstMs - b.firstMs).map(x => trStationCard(x, now)).join('') : `<div class="empty">${band === 'PTC' || trainsUi.auto ? `watching 216–222.5 MHz for the train-control network${s && s.other > 0 ? ` · ${s.other} other bursts` : ''}` : 'switch to PTC 220 to watch the train-control network'}</div>`)
        : (hots.length ? hots.map(h => trHotRow(h, now)).join('') : '<div class="empty">no head-of-train command heard yet · a locomotive sends one when it checks on its rear unit or brakes</div>');
    cards.scrollTop = top;
  }
  if (det) {
    const u = trainsUi.view === 'units' ? units.find(x => 'u' + x.unit === trainsUi.sel) : undefined;
    const st = trainsUi.view === 'ptc' ? stations.find(x => 's' + x.hz === trainsUi.sel) : undefined;
    det.hidden = !u && !st;
    const top = q('.mt-fields', det)?.scrollTop ?? 0;
    if (u) det.innerHTML = trDetail(`${u.unit}`, u.channel === 'DPU' ? 'DISTRIBUTED POWER' : 'END OF TRAIN', trEotFields(u, now), false);
    else if (st) det.innerHTML = trDetail((st.hz / 1e6).toFixed(4), PTC_KIND_LABEL[st.kind], trPtcFields(st, now), st.kind === 'LOCOMOTIVE');
    const f = q('.mt-fields', det); if (f) f.scrollTop = top;
  }
  const b = trainsBurst();
  if (b !== null) setMeter(b / 40, `BURST +${b} dB`);
  if (train) setLamp('TRAIN NEARBY', 'amber', true); else if (stations.length) setLamp(`${stations.length} PTC STATION${stations.length === 1 ? '' : 'S'}`, 'ok');
}

// ---- LoRa: every Meshtastic, MeshCore and LoRaWAN node heard across the span ------------------------------------
const LORA_WIDE = 20_000_000, LORA_NARROW = 2_000_000;
interface LoraNodeRow { key: string; proto: string; label: string; name: string | null; kind: string; lat: number | null; lon: number | null; firstMs: number; lastMs: number; packets: number; snr: number[]; fields: { name: string; value: string }[]; last: string; hz: number; modem: string; texts: string[] }
interface LoraEventRow { id: number; ms: number; proto: string; from: string | null; nodeKey: string | null; text: string | null; channel: string | null }
interface LoraSnap { nodes: LoraNodeRow[]; messages: LoraEventRow[]; bursts: number; frames: number; rate: number; centerHz: number; wide: boolean; busy: number; open: number;
  channels: { name: string; hz: number; standing: boolean; active: boolean; hotAgoMs: number | null; frames: number }[] }
/** The LoRa screen: NODES shows every node live; MAP puts the ones that broadcast a position where they say they are;
 *  MESSAGES is the text traffic in order. A tap on a card or a pin opens everything decoded from that node. */
const loraUi = { snap: null as LoraSnap | null, view: 'nodes' as 'nodes' | 'map' | 'messages' | 'log', sel: '', full: false, tall: false, drawn: 0, timer: 0, drawPending: 0 };
const loraClock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
const loraPins = (): GeoItem[] => (loraUi.snap?.nodes ?? []).filter(n => n.lat !== null && n.lon !== null).map(n => ({ id: n.key, lat: n.lat!, lon: n.lon!, label: n.label, kind: 'station' as GeoItem['kind'] }));
/** LoRa opens on the band of the browser's own region setting (its locale, not its location): the whole 20 MHz band
 *  where the radio can sample it, else that band's main channel with the radio 300 kHz above it. */
function loraOpen(): void {
  const band = loraHomeBand(), wide = radioCan(LORA_WIDE);
  configure('NONE', wide ? band.center : band.narrow + LORA_SHIFT, wide ? LORA_WIDE : LORA_NARROW, 32, 40, true, 'lora');
}
function loraSpan(wide: boolean): void {
  if (wide === state.rate >= 10_000_000) return;
  if (wide) {
    if (!radioCan(LORA_WIDE)) { log(`${radio?.label ?? 'this radio'} cannot sample 20 MHz`); return; }
    const b = [...LORA_BANDS].sort((x, y) => Math.abs(x.center - state.freq) - Math.abs(y.center - state.freq))[0] ?? loraHomeBand();
    setRate(LORA_WIDE); tune(b.center);
  } else {
    const b = LORA_BANDS.find(x => x.center === state.freq) ?? loraHomeBand();
    setRate(LORA_NARROW); tune(b.narrow + LORA_SHIFT);
  }
  render("lora");
}
function renderLora(view: HTMLElement): void {
  const wide = state.rate >= 10_000_000;
  const tiles = wide ? hsHtml(`<div class="tiles wide">${LORA_BANDS.map(b => `<button class="tl" data-preset="${b.center}"><b>${b.title}</b><small>${b.sub}</small></button>`).join('')}</div>`)
    // one channel at a time: the radio sits 300 kHz above it, clear of the spike at the center
    : hsHtml(`<div class="tiles wide">${LORA_TILES.map(t => `<button class="tl" data-preset="${t.hz + LORA_SHIFT}"><b>${t.title}</b><small>${t.sub}</small></button>`).join('')}</div>`);
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="lr-sum" class="mt-sum"></div>
      <div class="ctlrow">${segHtml(['nodes', 'map', 'messages', 'log'].map(v => `<button data-lrview="${v}">${v.toUpperCase()}</button>`))}<button id="lr-full" class="ib" title="full screen" aria-label="full screen">${loraUi.full ? EXIT_SVG : FULL_SVG}</button>${pauseClearHtml('lora')}</div>
      <div id="lr-stage" class="mt-stage"><div id="lr-cards" class="mt-cards"></div><div id="lr-map" class="panel map"></div><div id="lr-msgs" class="lr-msgs"></div><div id="lr-nopos" class="mt-nopos">no positions yet</div><div id="lr-detail" class="mt-detail" hidden></div></div>
      <div id="lr-log">${logHtml('lora', 'listening for LoRa…')}</div>
      <div id="lr-chans" class="lr-chans"></div>
      ${tiles}
      <div class="ctlrow"><span class="rl">SPAN</span>${segHtml([`<button data-lrspan="0" class="${wide ? '' : 'on'}">2 MHz</button>`, `<button data-lrspan="1" class="${wide ? 'on' : ''} ${radioCan(LORA_WIDE) ? '' : 'off'}">20 MHz</button>`])}</div>
      <div class="note">LoRa across the band at once: Meshtastic (decrypted on the default channels: names, positions, telemetry, text), MeshCore (adverts with names and positions, public channel messages) and LoRaWAN (device addresses, frame counters), plus any other LoRa as raw frames. 902–928 MHz in the US, and every other region's band from its tile. A HackRF watches 20 MHz at once; an RTL-SDR one channel at a time.</div>
      ${gainHtml()}</section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-lrview]', view).forEach(b => b.onclick = () => { loraUi.view = b.dataset.lrview as typeof loraUi.view; refreshLora(true); });
  qa<HTMLButtonElement>('[data-lrspan]', view).forEach(b => b.onclick = () => loraSpan(b.dataset.lrspan === '1'));
  $('lr-full').onclick = () => setLoraFull(!loraUi.full);
  const pick = (e: Event) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-lnode]'); if (c && (loraUi.snap?.nodes ?? []).some(n => n.key === c.dataset.lnode)) { loraUi.sel = loraUi.sel === c.dataset.lnode ? '' : c.dataset.lnode!; refreshLora(true); } };
  $('lr-cards').onclick = pick; $('lr-msgs').onclick = pick;
  $('lr-detail').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ldo]'); if (!b) return;
    const what = b.dataset.ldo;
    if (what === 'close') loraUi.sel = '';
    else if (what === 'tall') loraUi.tall = !loraUi.tall;
    else if (what === 'map') {
      loraUi.view = 'map'; refreshLora(true);
      const n = loraUi.snap?.nodes.find(x => x.key === loraUi.sel);
      if (n && n.lat !== null && n.lon !== null) geo?.center(n.lat, n.lon, 15);
      return;
    } else if (what === 'cards') loraUi.view = 'nodes';
    refreshLora(true);
  };
  view.classList.toggle('lorafull', loraUi.full);
  geo = new GeoMap($('lr-map'), { home: null, fitPins: true, onPick: id => { loraUi.sel = id; refreshLora(true); }, log });
  clearInterval(loraUi.timer);
  loraUi.timer = window.setInterval(() => { if (state.app !== 'lora') { clearInterval(loraUi.timer); return; } refreshLora(); }, 1000);
  refreshLora(true);
}
function setLoraFull(on: boolean): void {
  loraUi.full = on;
  const v = q('.view.lora'); if (!v) return;
  v.classList.toggle('lorafull', on);
  const b = q('#lr-full'); if (b) { b.innerHTML = on ? EXIT_SVG : FULL_SVG; b.title = on ? 'leave full screen' : 'full screen'; }
  refreshLora(true);
  requestAnimationFrame(() => geo?.invalidate());
}
/** One node, live: its name, what it is, how it was last heard, its signal over the recent packets. */
function loraCard(n: LoraNodeRow, now: number): string {
  const age = (now - n.lastMs) / 1000, flash = Math.max(0, 1 - age / 0.9);
  // nodes speak every few minutes: lit for ten, and once heard a node stays on the board
  const live = age < 600;
  const ago = age < 60 ? `${Math.max(0, Math.floor(age))} s ago` : age < 3600 ? `${Math.floor(age / 60)} min ago` : `${Math.floor(age / 3600)} h ago`;
  const v = n.snr, lastV = v[v.length - 1];
  let spark = '<div class="mt-spark"></div>';
  if (v.length) {
    const W = 300, H = 22, lo = Math.min(...v) - 3, hi = Math.max(...v) + 3, sp = Math.max(hi - lo, 1);
    const pts = v.length >= 2 ? v.map((x, i) => `${(W * i / (v.length - 1)).toFixed(1)},${(H - H * (x - lo) / sp).toFixed(1)}`) : [];
    spark = `<div class="mt-spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${pts.length ? `<polygon points="${pts.join(' ')} ${W},${H} 0,${H}" class="f"/><polyline points="${pts.join(' ')}" class="p"/>` : ''}</svg><b>${lastV >= 0 ? '+' : ''}${lastV} dB</b></div>`;
  }
  return `<div class="mt-card ${loraUi.sel === n.key ? 'sel' : ''} ${live ? '' : 'dim'}" data-lnode="${esc(n.key)}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-id ${n.label.length > 6 ? '' : 'big'}" style="font-size:${n.label.length > 6 ? 16 : 24}px">${esc(n.label)}</span><span class="mt-k"><b>${esc(n.proto.toUpperCase())}</b><small class="${n.lat !== null ? 'pos' : ''}">${esc(n.kind)}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${ago}</span></div>`
    + (n.name && n.name !== n.label ? `<div class="lr-name">${esc(n.name)}</div>` : '')
    + `<div class="mt-clk"><b>${n.packets}</b><small>${n.packets === 1 ? 'PACKET' : 'PACKETS'}</small><em>${(n.hz / 1e6).toFixed(3)} · ${esc(n.modem.split(' · CR')[0])}</em></div>`
    + spark + `<div class="lr-last">${esc(n.last)}</div></div>`;
}
/** One text message: who, where it went, when, and what it said. */
function loraMessage(e: LoraEventRow): string {
  return `<div class="lr-msg" ${e.nodeKey ? `data-lnode="${esc(e.nodeKey)}"` : ''}><div class="lr-mh"><b>${esc(e.from ?? '?')}</b><span>${esc(e.proto.toUpperCase() + (e.channel ? ` · ${e.channel}` : ''))}</span><i>${loraClock(e.ms)}</i></div><div class="lr-mt">${esc(e.text ?? '')}</div></div>`;
}
/** Everything decoded from one node, field by field, its recent messages, with MAP when it has a position. */
function loraDetail(n: LoraNodeRow, onMap: boolean): string {
  const all = [{ name: 'FIRST HEARD', value: loraClock(n.firstMs) }, { name: 'LAST HEARD', value: loraClock(n.lastMs) }, { name: 'PACKETS', value: `${n.packets}` },
    { name: 'FREQUENCY', value: `${(n.hz / 1e6).toFixed(4)} MHz` }, { name: 'MODEM', value: n.modem }, ...n.fields];
  return `<div class="mt-dh"><b>${esc(n.label)}</b><span>${esc(`${n.proto.toUpperCase()} · ${n.kind}`)}</span>${onMap ? '<button class="chip" data-ldo="map">MAP</button>' : ''}${loraUi.view !== 'nodes' ? '<button class="chip" data-ldo="cards">CARDS</button>' : ''}<button class="chip" data-ldo="tall">${loraUi.tall ? 'LESS' : 'MORE'}</button><button class="chip" data-ldo="close">✕</button></div>`
    + `<div class="mt-fields ${loraUi.tall ? 'tall' : ''}">${all.map(f => `<div><b>${esc(f.name)}</b><span>${esc(f.value)}</span></div>`).join('')}`
    + [...n.texts].reverse().map(t => `<p class="lr-q">“${esc(t)}”</p>`).join('') + '</div>';
}
function refreshLora(force = false): void {
  if (state.app !== 'lora') return;
  const now = Date.now();
  if (!force && now - loraUi.drawn < 240) { clearTimeout(loraUi.drawPending); loraUi.drawPending = window.setTimeout(() => refreshLora(true), 250); return; }
  loraUi.drawn = now;
  const snap = loraUi.snap, nodes = snap?.nodes ?? [], msgs = snap?.messages ?? [], pins = loraPins();
  if (loraUi.full && loraUi.view === 'log') loraUi.view = 'nodes';
  const by = new Map<string, number>(); for (const n of nodes) by.set(n.proto, (by.get(n.proto) ?? 0) + 1);
  const parts = ['Meshtastic', 'MeshCore', 'LoRaWAN'].filter(p => by.has(p)).map(p => `${p.toUpperCase()} ${by.get(p)}`);
  const sum = q('#lr-sum');
  if (sum) sum.innerHTML = parts.length ? `<div>${parts.join(' · ')} · ${snap?.frames ?? 0} frames</div>` : `<div class="muted">${snap && snap.bursts > 0 ? `${snap.bursts} LoRa bursts heard · ${snap.frames} frames` : 'listening for LoRa'}</div>`;
  qa<HTMLButtonElement>('[data-lrview]').forEach(b => { const v = b.dataset.lrview; b.classList.toggle('on', v === loraUi.view); b.textContent = v === 'nodes' ? `NODES ${nodes.length}` : v === 'map' ? `MAP ${pins.length}` : v === 'messages' ? `CHAT ${msgs.length}` : 'LOG'; b.hidden = v === 'log' && loraUi.full; });
  const cards = q('#lr-cards'), mapEl = q('#lr-map'), chat = q('#lr-msgs'), logEl = q('#lr-log'), nopos = q('#lr-nopos'), det = q('#lr-detail'), stage = q('#lr-stage');
  if (!cards || !mapEl || !chat || !logEl || !nopos || !det || !stage) return;
  cards.hidden = loraUi.view !== 'nodes'; mapEl.hidden = loraUi.view !== 'map'; chat.hidden = loraUi.view !== 'messages';
  logEl.hidden = loraUi.view !== 'log'; stage.hidden = loraUi.view === 'log';
  nopos.hidden = loraUi.view !== 'map' || pins.length > 0;
  const held = paused.has('lora');
  if (loraUi.view === 'nodes' && !held) {
    const top = cards.scrollTop;
    cards.innerHTML = nodes.length ? [...nodes].sort((a, b) => b.lastMs - a.lastMs).map(n => loraCard(n, now)).join('') : '<div class="empty">no nodes yet</div>';
    cards.scrollTop = top;
  }
  if (loraUi.view === 'messages' && !held) chat.innerHTML = msgs.length ? msgs.map(loraMessage).join('') : '<div class="empty">no messages yet</div>';
  const picked = nodes.find(n => n.key === loraUi.sel);
  det.hidden = !picked;
  if (picked) { const top = q('.mt-fields', det)?.scrollTop ?? 0; det.innerHTML = loraDetail(picked, pins.some(p => p.id === picked.key)); const f = q('.mt-fields', det); if (f) f.scrollTop = top; }
  if (loraUi.view === 'map') { geo?.invalidate(); geo?.update(pins, loraUi.sel); }
  // the known channels in the span that matter now (always-on, open, heard): lit while heard, with what they decoded
  const ch = q('#lr-chans');
  if (ch) ch.innerHTML = (snap?.channels ?? []).filter(c => c.standing || c.active || c.frames > 0 || (c.hotAgoMs !== null && c.hotAgoMs < 1500)).map(c => { const hot = c.hotAgoMs !== null && c.hotAgoMs < 1500; return `<span class="${c.active && !c.standing ? 'on' : ''} ${hot ? 'hot' : ''}" title="${(c.hz / 1e6).toFixed(4)} MHz${c.standing ? ' · always on' : ''}">${esc(c.name)}${c.frames ? ` · ${c.frames}` : ''}</span>`; }).join('')
    + (snap && snap.busy > 1.05 ? `<span class="warn">behind the radio: ${Math.round(100 * snap.busy)}% of real time</span>` : '');
  if (nodes.length > 0) setLamp(`${nodes.length} NODE${nodes.length === 1 ? '' : 'S'}`, 'ok');
}

/** The count line, then MAP / LIST / LOG with PAUSE and clear: the three map apps' frame. */
function geoHeadHtml(id: string, glyphText: string, views: string[]): string {
  return `<div class="countrow"><span id="${id}-count" class="count">${glyphText}</span></div><div class="ctlrow">${segHtml(views.map(v => `<button data-${id}view="${v}">${v.toUpperCase()}</button>`))}${pauseClearHtml(id)}</div>`;
}
function renderAdsb(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${geoHeadHtml('adsb', `✈ ${state.frames} FRAMES · ${state.aircraft.length} AIRCRAFT`, ['map', 'list'])}
      <div id="adsb-card" class="accard" hidden></div>
      <div id="adsb-map" class="panel map"></div>
      <div id="adsb-list" class="panel list"></div>
      ${gainHtml()}</section>`;
  scope = attach(new Scope($('scope'), 0, { rows: 80, spectrumHeight: 70 }));
  q('#pause-adsb')?.insertAdjacentHTML('beforebegin', `<button id="adsb-full" class="ib" title="full-screen map" aria-label="full-screen map">${adsbFull ? EXIT_SVG : FULL_SVG}</button>`);
  $('adsb-full').onclick = () => setAdsbFull(!adsbFull);
  view.classList.toggle('mapfull', adsbFull);
  qa<HTMLButtonElement>('[data-adsbview]', view).forEach(b => b.onclick = () => { state.adsbView = b.dataset.adsbview as 'map' | 'list'; refreshAdsb(); });
  geo = new GeoMap($('adsb-map'), { home: state.home, onPick: id => { state.adsbSel = id; refreshAdsb(); }, onFollow: on => { state.adsbFollow = on; }, log });
  geo.setFollow(state.adsbFollow);
  refreshAdsb();
}
function renderAis(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${geoHeadHtml('ais', '⚓ 0 PACKETS · 0 VESSELS', ['map', 'list', 'log'])}
      <div id="ais-card" class="accard" hidden></div>
      <div id="ais-map" class="panel map"></div>
      <div id="ais-list" class="panel list"></div>
      <div id="ais-log">${listHtml('ais', 'listening on the AIS channel…')}</div>
      ${presetHtml('CHANNEL', [['AIS A 161.975', 161_975_000], ['AIS B 162.025', 162_025_000]])}${gainHtml()}</section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-aisview]', view).forEach(b => b.onclick = () => { state.aisView = b.dataset.aisview as typeof state.aisView; refreshAis(); });
  q('#list-ais')?.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest('.li'); const mm = li?.textContent?.match(/MMSI (\d+)/); if (mm) { state.aisSel = Number(mm[1]); refreshAis(); } });
  geo = new GeoMap($('ais-map'), { home: state.home, onPick: id => { state.aisSel = Number(id); refreshAis(); }, log });
  refreshAis();
}
function renderAprs(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${presetHtml('REGION', [['144.390 N. America', 144_390_000], ['144.800 Europe', 144_800_000], ['145.175 Australia', 145_175_000], ['144.640 Japan', 144_640_000]])}
      <div class="ctlrow">${segHtml(['map', 'list', 'log'].map(v => `<button data-aprsview="${v}">${v.toUpperCase()}</button>`))}${pauseClearHtml('aprs')}</div>
      <div id="aprs-card" class="accard" hidden></div>
      <div id="aprs-map" class="panel map"></div>
      <div id="aprs-list" class="panel list"></div>
      <div id="aprs-log">${listHtml('aprs', 'listening on the APRS frequency…')}</div>
      ${gainHtml()}</section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-aprsview]', view).forEach(b => b.onclick = () => { state.aprsView = b.dataset.aprsview as typeof state.aprsView; refreshAprs(); });
  q('#list-aprs')?.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest('.li'); const mm = li?.textContent?.match(/^([A-Za-z0-9-]+)>/); if (mm) { state.aprsSel = mm[1]; refreshAprs(); } });
  geo = new GeoMap($('aprs-map'), { home: state.home, onPick: id => { state.aprsSel = id; refreshAprs(); }, log });
  refreshAprs();
}

function renderSweep(view: HTMLElement, app: AppId): void {
  const search = app === 'search';
  view.innerHTML = `
    <section class="visual">${sweepCardHtml()}<div id="sweep-scope" class="panel ${search ? 'short' : ''}"></div></section>
    <section class="controls">
      ${hsHtml(`<div class="tiles wide">${RANGES.map(([l, a, b]) => rangeTile(l, a, b)).join('')}<button class="tl" id="sweep-full"><b>1M–6G</b><small>FULL · SLOW</small></button></div>`)}
      <div class="ctlrow"><span class="rl">SLICE</span>${segHtml([2e6, 4e6, 8e6, 16e6].map(r => `<button data-slice="${r}">${r / 1e6}M</button>`))}</div>
      ${search ? `<div class="ctlrow"><span class="rl">ABOVE</span>${segHtml([10, 15, 20, 30].map(t => `<button data-thr="${t}">+${t} dB</button>`))}</div>` : ''}
      <div class="note">Wider ranges sweep slower; a wider slice is faster.</div>
      ${gainHtml()}
      ${search ? `<div class="caption">HITS · tap to listen</div><div id="hits" class="panel list"><div class="empty">sweeping… hits appear after the first full pass</div></div>` : ''}
    </section>`;
  const sweepLabel = (f: number) => { const s = state.sweep; return s ? ((s.start + (s.end - s.start) * f) / 1e6).toFixed(3) : ''; };
  sweepScope = new Scope($('sweep-scope'), 0, { rows: search ? 140 : 300, center: false, spectrumHeight: search ? 60 : 90, rowPx: 2, labelAt: sweepLabel, onTap: search ? undefined : f => { const s = state.sweep; if (s) { const hz = s.start + (s.end - s.start) * f; listen(hz, hz > 87e6 && hz < 108e6 ? 'WFM' : 'NFM'); } },
    onPreview: search ? undefined : f => { const t = q('#sweep-title'), s = state.sweep; if (!t || !s) return; if (f === null) { t.classList.remove('preview'); t.textContent = sweepTitle(); } else { t.classList.add('preview'); t.textContent = `${((s.start + (s.end - s.start) * f) / 1e6).toFixed(3)} MHz`; } } });
  qa<HTMLButtonElement>('[data-range]', view).forEach(b => b.onclick = () => startSweep(Number(b.dataset.range), Number(b.dataset.end)));
  // FULL sweeps the whole radio (a HackRF Pro reaches higher than a plain one); it is slow — hundreds of steps —
  // but it is the "what is out there anywhere" view.
  const full = q('#sweep-full'); if (full) full.onclick = () => startSweep(radio?.limits.minHz ?? 1e6, radio?.limits.maxHz ?? 6e9);
  qa<HTMLButtonElement>('[data-slice]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.slice) === state.sweepRate); b.onclick = () => { state.sweepRate = Number(b.dataset.slice); qa('[data-slice]').forEach(x => x.classList.toggle('on', x === b)); const s = state.sweep; if (s) startSweep(s.start, s.end); }; });
  qa<HTMLButtonElement>('[data-thr]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.thr) === state.threshold); b.onclick = () => { state.threshold = Number(b.dataset.thr); qa('[data-thr]').forEach(x => x.classList.toggle('on', x === b)); refreshHits(); }; });
}

function txStatus(s: string): void { const e = q('#tx-status'); if (e) e.textContent = s; const stop = q('#tx-stop'); if (stop) (stop as HTMLElement).hidden = !tx.active; }
/**
 * Shopping-cart wheel locks listen for a signal in the air, not over radio, so this trick is pure phone-speaker
 * audio and works with no HackRF attached. These are the real recordings for the two common systems — Gatekeeper
 * (a 7.8 kHz tone) and Rocateq — from begaydocrime.com, credited in the About screen. Point the speaker at a wheel.
 */
const CART_SOUNDS: Record<string, Record<string, string>> = {
  gatekeeper: { lock: 'assets/cart/GateKeeperCartKeyLock78.wav', unlock: 'assets/cart/unlock-cart.wav' },
  rocateq: { lock: 'assets/cart/roca-lock.mp3', unlock: 'assets/cart/roca-unlock.mp3', arm: 'assets/cart/roca-armingsignal-17s.mp3', purchase: 'assets/cart/roca-purcheck-ok.mp3' },
};

let cartAudioEl: HTMLAudioElement | null = null;

function cartSound(brand: 'gatekeeper' | 'rocateq', action: string): void {
  try {
    if (cartAudioEl) { cartAudioEl.pause(); cartAudioEl.currentTime = 0; }   // one at a time; a new tap interrupts
    const a = cartAudioEl = new Audio(CART_SOUNDS[brand][action]);
    a.volume = 1;
    void a.play().catch(e => log(`cart audio: ${(e as Error).message}`));
    setStatus(`cart · ${brand} ${action} · through the speaker`, false);
  } catch (e) { log(`cart audio: ${(e as Error).message}`); }
}

function renderTroll(view: HTMLElement): void {
  tx.onStatus = txStatus;
  if (!tx.enabled) {
    view.innerHTML = `<div class="notice tx-off"><b>Transmit is switched off in Settings.</b> Most Troll tricks transmit, so turn it back on there — the shopping-cart one is phone audio and works regardless.<div class="row" style="margin-top:10px"><button id="tx-settings" class="chip">OPEN SETTINGS</button><button id="tr-cart-only" class="chip">CART · UNLOCK</button></div></div>`;
    $('tx-settings').onclick = () => open('settings');
    $('tr-cart-only').onclick = () => cartSound('gatekeeper', 'unlock');
    return;
  }
  if (tx.needsPrompt) showTxSafetyPrompt();
  view.innerHTML = `
    <section class="visual">${readoutHtml()}</section>
    <section class="controls trollctl">
      <div class="trollintro">Everything here <b>transmits</b> unless noted — use a dummy load or an antenna you are allowed to key. Some of these are regulated on air where you live. Harmless fun, your call.</div>
      ${stepHtml([1e6, 1e5, 1e4])}
      ${txGainHtml()}

      <div class="trollcard sub">
        <div class="trollhead"><span class="ico">📡</span><b>ON THE DIAL</b><small>fires on the frequency tuned above</small></div>
        <div class="trollsub">Band <em>sub-GHz</em></div>
        <div class="trollgrid band">${[['433.92', 433_920_000], ['315.00', 315_000_000], ['868.35', 868_350_000], ['915.00', 915_000_000]].map(([l, hz]) => `<button class="chip" data-preset="${hz}">${l}</button>`).join('')}</div>
        <div class="trollsub">Fixed-code OOK <em>doorbells · outlets · gates</em></div>
        <div class="trollgrid"><button class="chip" id="tr-doorbell">Doorbell</button><button class="chip" id="tr-outlet">Outlet</button><button class="chip" id="tr-fan">Fan / LED</button><button class="chip" id="tr-walk">Code walk</button><button class="chip" id="tr-gate">Gate opener</button><button class="chip" id="tr-noise">Static burst</button></div>
        <div class="trollsub">Replay a capture <em>paste a Flipper .sub</em></div>
        <textarea id="tr-sub" class="txin mono" rows="3" placeholder="Protocol: RAW&#10;RAW_Data: 340 -1020 340 -1020 ..."></textarea>
        <div class="row tight"><span id="tr-rep" class="unit">×3</span><button class="chip" id="tr-repm">−</button><button class="chip" id="tr-repp">+</button><button class="chip primary wide2" id="tr-subsend">FIRE .SUB</button></div>
        <div class="trollsub">FM jingle <em>tune to a station first</em></div>
        <div class="trollgrid">${Apps.tuneNames().map(n => `<button class="chip" data-tune="${n}">${n}</button>`).join('')}</div>
        <div class="trollsub">Morse <em>troll a repeater in code</em></div>
        <div class="row tight"><input id="tr-morse" class="txin" value="HI HI" maxlength="60"><button class="chip primary" id="tr-morsesend">SEND</button></div>
      </div>

      <div class="trolldivide"></div>

      <div class="trollcard spoof">
        <div class="trollhead"><span class="ico">🎯</span><b>FIXED SIGNALS</b><small>each sets its own frequency</small></div>
        <div class="trollsub">Tesla charge port</div>
        <div class="trollgrid two"><button class="chip" id="tr-tesla-us">US · 315</button><button class="chip" id="tr-tesla-eu">EU · 433.92</button></div>
        <div class="trollsub">Weather spoof <em>phantom Acurite · 433.92</em></div>
        <div class="row tight"><input id="tr-wx-temp" class="txin" value="45" inputmode="decimal"><span class="unit">°C</span><input id="tr-wx-hum" class="txin" value="50" inputmode="numeric"><span class="unit">%RH</span><button class="chip primary" id="tr-wx">SEND</button></div>
      </div>

      <div class="trollcard cart">
        <div class="trollhead"><span class="ico">🛒</span><b>SHOPPING CART</b><small>real wheel sounds · phone speaker · no radio</small></div>
        <div class="cartbrands">
          <div class="cartbrand"><img src="assets/cart/gatekeeper.png" alt="Gatekeeper locking cart wheel" loading="lazy"><div class="cartname">Gatekeeper · 7.8 kHz</div><div class="trollgrid two"><button class="chip" id="tr-gk-unlock">Unlock</button><button class="chip" id="tr-gk-lock">Lock</button></div></div>
          <div class="cartbrand"><img src="assets/cart/rocateq.png" alt="Rocateq locking cart wheel" loading="lazy"><div class="cartname">Rocateq</div><div class="trollgrid two"><button class="chip" id="tr-rc-unlock">Unlock</button><button class="chip" id="tr-rc-lock">Lock</button><button class="chip" id="tr-rc-arm">Arm</button><button class="chip" id="tr-rc-purchase">Purchase check</button></div></div>
        </div>
      </div>
    </section>`;

  // gain / amp / stop — same controls and ids as the Transmit app; only one view is mounted at a time
  const setg = () => qa('[data-txg]').forEach(b => b.classList.toggle('on', Number(b.dataset.txg) === tx.gain));
  qa<HTMLButtonElement>('[data-txg]', view).forEach(b => b.onclick = () => { tx.gain = Number(b.dataset.txg); setg(); });
  setg();
  const ampb = $('tx-amp'); ampb.classList.toggle('on', tx.amp);
  ampb.onclick = () => { tx.amp = !tx.amp; ampb.classList.toggle('on', tx.amp); };
  // STOP belongs to the card of the tool that is transmitting, not a bar at the foot of the page. Remember the last
  // card tapped, and while a transmission runs, move the status + STOP strip into that card.
  const ctl = view.querySelector('.trollctl') as HTMLElement;
  const runStrip = document.createElement('div');
  runStrip.className = 'trollrun'; runStrip.hidden = true;
  runStrip.innerHTML = '<span class="health" id="tx-status">TX running</span><button id="tx-stop" class="chip rec">■ STOP</button>';
  ctl.appendChild(runStrip);
  $('tx-stop').onclick = () => tx.stop();
  let activeCard: HTMLElement | null = null;
  ctl.addEventListener('click', (e) => { const c = (e.target as HTMLElement).closest('.trollcard'); if (c) activeCard = c as HTMLElement; }, true);
  tx.onStatus = (s) => {
    const st = q('#tx-status'); if (st) st.textContent = s;
    if (tx.active) { (activeCard ?? ctl).appendChild(runStrip); runStrip.hidden = false; }
    else runStrip.hidden = true;
  };

  $('tr-tesla-us').onclick = () => { tune(315_000_000); tx.teslaChargePort(315_000_000); };
  $('tr-tesla-eu').onclick = () => { tune(433_920_000); tx.teslaChargePort(433_920_000); };
  // cheap wireless doorbells / outlet remotes are fixed Princeton codes; blast one, flicker a pair, or walk a slice
  $('tr-doorbell').onclick = () => tx.ookPrinceton(state.freq, 0x1A2B3C, 24, 350, 12);
  $('tr-outlet').onclick = () => tx.ookPrinceton(state.freq, 0x145591, 24, 320, 10);
  $('tr-fan').onclick = () => tx.ookPrinceton(state.freq, 0x0AAA55, 24, 380, 10);
  $('tr-walk').onclick = () => tx.ookBrute(24, 0x000000, 0x0000FF, 350, state.freq);
  $('tr-gate').onclick = () => tx.gateOpener(12, 350, state.freq);
  $('tr-noise').onclick = () => tx.ookNoise(100, 3, state.freq);

  let reps = 3;
  $('tr-repm').onclick = () => { reps = Math.max(1, reps - 1); $('tr-rep').textContent = `×${reps}`; };
  $('tr-repp').onclick = () => { reps = Math.min(20, reps + 1); $('tr-rep').textContent = `×${reps}`; };
  $('tr-subsend').onclick = () => tx.subghzReplay(($('tr-sub') as HTMLTextAreaElement).value, state.freq, reps);

  $('tr-wx').onclick = () => { tune(433_920_000); const t = parseFloat(($('tr-wx-temp') as HTMLInputElement).value); const h = ($('tr-wx-hum') as HTMLInputElement).value.trim(); tx.weatherSpoof(isNaN(t) ? 20 : t, h === '' ? undefined : parseInt(h, 10), 433_920_000); };
  qa<HTMLButtonElement>('[data-tune]', view).forEach(b => b.onclick = () => tx.jingle(b.dataset.tune!, state.freq));
  $('tr-morsesend').onclick = () => tx.morse(($('tr-morse') as HTMLInputElement).value, 20, state.freq, true);
  $('tr-gk-lock').onclick = () => cartSound('gatekeeper', 'lock');
  $('tr-gk-unlock').onclick = () => cartSound('gatekeeper', 'unlock');
  $('tr-rc-lock').onclick = () => cartSound('rocateq', 'lock');
  $('tr-rc-unlock').onclick = () => cartSound('rocateq', 'unlock');
  $('tr-rc-arm').onclick = () => cartSound('rocateq', 'arm');
  $('tr-rc-purchase').onclick = () => cartSound('rocateq', 'purchase');
}

/** Session-scoped safety modal: confirms an antenna or a dummy load is attached before the first transmission. */
let biasAcked = false;
/** Bias-tee pushes DC out the antenna port, so it is off by default and the first enable each session asks first. */
function toggleBiasTee(): void {
  const rtl = radio && radio.kind === 'rtlsdr' ? radio as RtlSdr : null;
  if (!rtl) return;
  if (state.biast) { state.biast = false; void rtl.setBiasTee(false); refreshGainUi(); return; }
  if (!biasAcked) { showBiasWarn(); return; }
  state.biast = true; void rtl.setBiasTee(true); refreshGainUi();
}
function showBiasWarn(): void {
  if (q('#bias-warn')) return;
  const el = document.createElement('div');
  el.id = 'bias-warn'; el.className = 'modal';
  el.innerHTML = `<div class="modal-card"><h3>Bias-tee: DC on the antenna port</h3><p>This puts about 4.5 V DC on the RTL-SDR's antenna input to power an inline LNA.</p><ul><li>Only turn it on with a bias-tee-ready LNA or feed.</li><li>Never into a plain antenna, a shorted feed, or gear that isn't DC-blocked — the DC can damage it.</li></ul><div class="modal-actions"><button id="bias-cancel" class="chip">CANCEL</button><button id="bias-ok" class="chip primary">ENABLE BIAS-T</button></div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  $('bias-ok').onclick = () => { biasAcked = true; state.biast = true; const rtl = radio && radio.kind === 'rtlsdr' ? radio as RtlSdr : null; if (rtl) void rtl.setBiasTee(true); refreshGainUi(); close(); };
  $('bias-cancel').onclick = close;
}
function showTxSafetyPrompt(): void {
  if (q('#tx-safety')) return;
  const el = document.createElement('div');
  el.id = 'tx-safety'; el.className = 'modal';
  el.innerHTML = `<div class="modal-card"><h3>Before you transmit</h3><p>Do you have an antenna, dummy load or matched load on the ANT port?</p><ul><li>Transmitting into an open port can damage the HackRF.</li><li>Most bands need a license — know the rules where you are.</li><li>Turn TX GAIN low first; the amp adds +14 dB.</li></ul><div class="modal-actions"><button id="tx-cancel" class="chip">CANCEL</button><button id="tx-ack" class="chip primary">I HAVE ONE — CONTINUE</button></div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  $('tx-ack').onclick = () => { tx.acknowledgeSafety(); close(); };
  $('tx-cancel').onclick = () => { close(); open(homeApp()); };
}

/** The transmit modes, each with what it sends (the Android app's tiles). */
const TX_MODES: [string, string][] = [['Signal', 'test carrier'], ['Tones', 'DTMF'], ['POCSAG', 'pager'], ['RTTY', '45 baud'], ['APRS', 'AX.25'], ['Morse', 'CW'], ['OOK', 'PT2262'],
  ['MDC', 'PTT-ID'], ['QC-II', 'two-tone'], ['SubGHz', 'Flipper .sub'], ['KeeLoq', 'HCS301'], ['Noise', 'OOK noise'], ['Brute', 'PT2262'], ['Hopper', 'hop list'], ['ADS-B', 'DF17']];
/** TX gain as one bar, IF 0–47 dB, with the +14 dB amp beside it. */
const txGainHtml = () => `<div class="ctlrow"><span class="rl">GAIN</span>${segHtml([0, 10, 20, 30, 47].map(g => `<button data-txg="${g}">${g}</button>`))}<button id="tx-amp" class="tog" title="the amp adds +14 dB">AMP</button></div>`;
function renderTx(view: HTMLElement): void {
  tx.onStatus = txStatus;
  if (!tx.enabled) {
    view.innerHTML = `<div class="notice tx-off"><b>Transmit is switched off in Settings.</b> Turn it back on there when you want to use it.<div class="row" style="margin-top:10px"><button id="tx-settings" class="chip">OPEN SETTINGS</button></div></div>`;
    $('tx-settings').onclick = () => open('settings');
    return;
  }
  if (tx.needsPrompt) showTxSafetyPrompt();
  view.innerHTML = `
    <section class="visual">${readoutHtml()}</section>
    <section class="controls">
      ${stepHtml([1e6, 1e5, 1e4])}
      ${txGainHtml()}
      <div class="tgrid">${TX_MODES.map(([t, sub], i) => `<button class="tl" data-txtab="${i}"><b>${t.toUpperCase()}</b><small>${sub}</small></button>`).join('')}</div>
      <div id="tx-body"></div>
      <div class="health" id="tx-status" style="margin-top:8px">idle</div>
      <button id="tx-stop" class="chip rec" style="margin-top:8px" hidden>■ STOP</button>
    </section>`;
  const setg = () => qa('[data-txg]').forEach(b => b.classList.toggle('on', Number(b.dataset.txg) === tx.gain));
  qa<HTMLButtonElement>('[data-txg]', view).forEach(b => b.onclick = () => { tx.gain = Number(b.dataset.txg); setg(); });
  setg();
  const ampb = $('tx-amp'); ampb.classList.toggle('on', tx.amp);
  ampb.onclick = () => { tx.amp = !tx.amp; ampb.classList.toggle('on', tx.amp); };
  $('tx-stop').onclick = () => tx.stop();
  let tab = 0;
  const body = $('tx-body');
  const drawTab = () => {
    qa('[data-txtab]').forEach(b => b.classList.toggle('on', Number(b.dataset.txtab) === tab));
    if (tab === 0) {
      body.innerHTML = `<div class="caption">CONTINUOUS · until STOP · use a dummy load</div><div class="grid-tx">${([['cw', 'CW carrier'], ['fm', 'FM tone'], ['am', 'AM tone'], ['sweep', 'sweep ±50 kHz']] as [SigMode, string][]).map(([m, l]) => `<button class="chip" data-sig="${m}">${l}</button>`).join('')}</div>`;
      qa<HTMLButtonElement>('[data-sig]', body).forEach(b => b.onclick = () => tx.sigGen(state.freq, b.dataset.sig as SigMode));
    } else if (tab === 1) {
      body.innerHTML = `<div class="grid-tx"><button class="chip" id="t-single">1 kHz</button><button class="chip" id="t-two">two-tone</button></div><input id="tx-dtmf" class="txin" value="1234" maxlength="32" style="margin-top:6px"><button class="chip primary" id="t-dtmf" style="margin-top:6px;width:100%">▶ SEND DTMF</button>`;
      $('t-single').onclick = () => tx.tones('single', '', state.freq);
      $('t-two').onclick = () => tx.tones('two', '', state.freq);
      $('t-dtmf').onclick = () => tx.tones('dtmf', ($('tx-dtmf') as HTMLInputElement).value, state.freq);
    } else if (tab === 2) {
      body.innerHTML = `<input id="p-addr" class="txin" value="1234567" maxlength="7" inputmode="numeric"><input id="p-msg" class="txin" value="TEST DE MAYHEM" maxlength="80" style="margin-top:6px"><div class="row" style="margin-top:6px"><button class="chip" id="p-baud">1200 bd</button><button class="chip" id="p-num">alpha</button></div><div class="caption">Decodes on the Pager RX app and PDW · RIC + function 3</div><button class="chip primary" id="p-send" style="margin-top:6px;width:100%">▶ PAGE</button>`;
      let baud = 1200, numeric = false;
      $('p-baud').onclick = () => { baud = baud === 1200 ? 2400 : baud === 2400 ? 512 : 1200; $('p-baud').textContent = `${baud} bd`; };
      const nb = $('p-num'); nb.onclick = () => { numeric = !numeric; nb.classList.toggle('on', numeric); nb.textContent = numeric ? 'numeric' : 'alpha'; };
      $('p-send').onclick = () => tx.pocsagTx(parseInt(($('p-addr') as HTMLInputElement).value || '0', 10), 3, ($('p-msg') as HTMLInputElement).value, numeric ? 1 : 0, baud, state.freq);
    } else if (tab === 3) {
      body.innerHTML = `<input id="r-text" class="txin" value="RYRYRY DE ${state.ham.station.call || 'MAYHEM'}" maxlength="120"><div class="row" style="margin-top:6px"><button class="chip" id="r-shift">170 Hz</button><button class="chip primary" id="r-send" style="flex:1.4">▶ SEND 45 bd</button></div><div class="caption">ITA2 Baudot 45.45 baud — decodes in fldigi etc.</div>`;
      let shift = 170;
      $('r-shift').onclick = () => { shift = shift === 170 ? 425 : shift === 425 ? 850 : 170; $('r-shift').textContent = `${shift} Hz`; };
      $('r-send').onclick = () => tx.rtty(($('r-text') as HTMLInputElement).value, 45, shift, state.freq);
    } else if (tab === 4) {
      body.innerHTML = `<input id="a-call" class="txin" value="${aprsCall()}" maxlength="9"><input id="a-info" class="txin" value="!4903.50N/07201.75W-Mayhem Mobile" maxlength="120" style="margin-top:6px"><div class="caption">Bell 202 AX.25 UI frame — APRS app / any TNC. Ham license on 144.39.</div><button class="chip primary" id="a-send" style="margin-top:6px;width:100%">▶ BEACON</button>`;
      $('a-send').onclick = () => tx.aprs(($('a-call') as HTMLInputElement).value, ($('a-info') as HTMLInputElement).value, state.freq);
    } else if (tab === 5) {
      body.innerHTML = `<input id="tx-msg" class="txin" value="CQ DE ${state.ham.station.call || 'MAYHEM'}" maxlength="80"><div class="row" style="margin-top:6px"><span id="tx-wpm" class="info">20 WPM</span><button class="chip" id="wpm-">−</button><button class="chip" id="wpm+">+</button><button class="chip on" id="tx-fm">FM tone</button></div><button class="chip primary" id="tx-send" style="margin-top:6px;width:100%">▶ SEND</button>`;
      let wpm = 20, fm = true;
      $('wpm-').onclick = () => { wpm = Math.max(5, wpm - 5); $('tx-wpm').textContent = `${wpm} WPM`; };
      $('wpm+').onclick = () => { wpm = Math.min(60, wpm + 5); $('tx-wpm').textContent = `${wpm} WPM`; };
      const fmb = $('tx-fm'); fmb.onclick = () => { fm = !fm; fmb.classList.toggle('on', fm); fmb.textContent = fm ? 'FM tone' : 'CW key'; };
      $('tx-send').onclick = () => tx.morse(($('tx-msg') as HTMLInputElement).value, wpm, state.freq, fm);
    } else if (tab === 6) {
      body.innerHTML = `<input id="tx-hex" class="txin" value="A5C3F1" maxlength="12"><div class="row" style="margin-top:6px"><span id="tx-ook" class="info">24 bit 350µs</span><button class="chip" id="ook-bits">bits</button><button class="chip" id="ook-te">te</button></div><div class="caption">Fixed-code Princeton/PT2262 — remotes you own on a license-free ISM band</div><button class="chip primary" id="tx-ooksend" style="margin-top:6px;width:100%">▶ SEND ×8</button>`;
      let bits = 24, te = 350;
      const upd = () => $('tx-ook').textContent = `${bits} bit ${te}µs`;
      $('ook-bits').onclick = () => { bits = bits === 24 ? 12 : bits === 12 ? 32 : 24; upd(); };
      $('ook-te').onclick = () => { te = te === 350 ? 500 : te === 500 ? 200 : 350; upd(); };
      $('tx-ooksend').onclick = () => tx.ookPrinceton(state.freq, parseInt(($('tx-hex') as HTMLInputElement).value || '0', 16) >>> 0, bits, te, 8);
    } else if (tab === 7) {
      body.innerHTML = `<div class="row"><input id="m-op" class="txin" value="01" maxlength="2" style="flex:1"><input id="m-arg" class="txin" value="00" maxlength="2" style="flex:1"><input id="m-unit" class="txin" value="1234" maxlength="4" style="flex:2"></div><div class="caption">MDC-1200 Motorola PTT-ID · op / arg (hex) / 16-bit unit ID (hex) · 1200 bd AFSK</div><button class="chip primary" id="m-send" style="margin-top:6px;width:100%">▶ PTT-ID</button>`;
      $('m-send').onclick = () => tx.mdc1200(parseInt(($('m-op') as HTMLInputElement).value || '0', 16), parseInt(($('m-arg') as HTMLInputElement).value || '0', 16), parseInt(($('m-unit') as HTMLInputElement).value || '0', 16), state.freq);
    } else if (tab === 8) {
      body.innerHTML = `<div class="row"><input id="q-a" class="txin" value="1122.5" style="flex:1"><input id="q-b" class="txin" value="1465.5" style="flex:1"></div><div class="caption">Motorola Quick-Call II two-tone paging · tone A 1 s + tone B 3 s + 26 s carrier tail</div><button class="chip primary" id="q-send" style="margin-top:6px;width:100%">▶ PAGE QC-II</button>`;
      $('q-send').onclick = () => tx.quickCall2(parseFloat(($('q-a') as HTMLInputElement).value || '0'), parseFloat(($('q-b') as HTMLInputElement).value || '0'), state.freq);
    } else if (tab === 9) {
      body.innerHTML = `<textarea id="s-text" class="txin" rows="5" style="width:100%;font-family:monospace" placeholder="Paste a Flipper .sub file here — 'Protocol: RAW / RAW_Data: 340 -1020 …'"></textarea><div class="row" style="margin-top:6px"><span id="s-rep" class="info">×3</span><button class="chip" id="s-repm">−</button><button class="chip" id="s-repp">+</button></div><div class="caption">SubGHz replay of a Flipper Zero .sub RAW file · OOK, 2 Msps</div><button class="chip primary" id="s-send" style="margin-top:6px;width:100%">▶ REPLAY</button>`;
      let reps = 3;
      $('s-repm').onclick = () => { reps = Math.max(1, reps - 1); $('s-rep').textContent = `×${reps}`; };
      $('s-repp').onclick = () => { reps = Math.min(20, reps + 1); $('s-rep').textContent = `×${reps}`; };
      $('s-send').onclick = () => tx.subghzReplay(($('s-text') as HTMLTextAreaElement).value, state.freq, reps);
    } else if (tab === 10) {
      body.innerHTML = `<input id="k-key" class="txin" value="5CEC6701B79FD949" maxlength="16"><div class="row" style="margin-top:6px"><input id="k-serial" class="txin" value="1234567" maxlength="7" style="flex:1.5"><input id="k-btn" class="txin" value="2" maxlength="1" style="flex:0.5"><input id="k-cnt" class="txin" value="42" maxlength="6" style="flex:1"></div><div class="row" style="margin-top:6px"><span id="k-rep" class="info">×3</span><button class="chip" id="k-repm">−</button><button class="chip" id="k-repp">+</button></div><div class="caption">HCS301 KeeLoq · 64-bit key (hex) / 28-bit serial (hex) / 4-bit button / counter · OOK PWM 433.92 MHz-ish</div><button class="chip primary" id="k-send" style="margin-top:6px;width:100%">▶ HOP</button>`;
      let reps = 3;
      $('k-repm').onclick = () => { reps = Math.max(1, reps - 1); $('k-rep').textContent = `×${reps}`; };
      $('k-repp').onclick = () => { reps = Math.min(8, reps + 1); $('k-rep').textContent = `×${reps}`; };
      $('k-send').onclick = () => tx.keeloqTx(BigInt('0x' + (($('k-key') as HTMLInputElement).value || '0')), parseInt(($('k-serial') as HTMLInputElement).value || '0', 16), parseInt(($('k-btn') as HTMLInputElement).value || '0', 10), parseInt(($('k-cnt') as HTMLInputElement).value || '0', 10), state.freq, reps);
    } else if (tab === 11) {
      body.innerHTML = `<div class="row"><input id="n-chip" class="txin" value="100" style="flex:1"><input id="n-sec" class="txin" value="3" style="flex:1"></div><div class="caption">Pseudo-random OOK · chipUs µs per chip, [seconds] total · authorized RF-lab work on your own gear</div><button class="chip primary" id="n-send" style="margin-top:6px;width:100%">▶ NOISE</button>`;
      $('n-send').onclick = () => tx.ookNoise(parseInt(($('n-chip') as HTMLInputElement).value || '0', 10), parseInt(($('n-sec') as HTMLInputElement).value || '0', 10), state.freq);
    } else if (tab === 12) {
      body.innerHTML = `<div class="row"><input id="b-bits" class="txin" value="24" style="flex:1"><input id="b-from" class="txin" value="0" style="flex:1"><input id="b-to" class="txin" value="255" style="flex:1"></div><input id="b-te" class="txin" value="350" style="margin-top:6px"><div class="caption">Princeton PT2262 brute-force · bits (12/24/32), start-end (decimal), te µs · a gate you own on ISM</div><button class="chip primary" id="b-send" style="margin-top:6px;width:100%">▶ BRUTE</button>`;
      $('b-send').onclick = () => tx.ookBrute(parseInt(($('b-bits') as HTMLInputElement).value || '24', 10), parseInt(($('b-from') as HTMLInputElement).value || '0', 10), parseInt(($('b-to') as HTMLInputElement).value || '0', 10), parseInt(($('b-te') as HTMLInputElement).value || '350', 10), state.freq);
    } else if (tab === 13) {
      body.innerHTML = `<div class="row"><input id="h-lo" class="txin" value="433.05" style="flex:1"><input id="h-hi" class="txin" value="434.79" style="flex:1"></div><div class="row" style="margin-top:6px"><input id="h-count" class="txin" value="16" style="flex:1"><input id="h-dwell" class="txin" value="20" style="flex:1"></div><div class="caption">CW frequency hopper · low-high MHz · [count] random hops · dwell ms each · your own bench work only</div><button class="chip primary" id="h-send" style="margin-top:6px;width:100%">▶ HOP</button>`;
      $('h-send').onclick = () => {
        const lo = Math.round(parseFloat(($('h-lo') as HTMLInputElement).value || '0') * 1e6);
        const hi = Math.round(parseFloat(($('h-hi') as HTMLInputElement).value || '0') * 1e6);
        const n = parseInt(($('h-count') as HTMLInputElement).value || '16', 10);
        const d = parseInt(($('h-dwell') as HTMLInputElement).value || '20', 10);
        tx.frequencyHopper(Apps.hopList(lo, hi, n), d);
      };
    } else {
      body.innerHTML = `<input id="a-icao" class="txin" value="A19E43" maxlength="6"><input id="a-me" class="txin" value="58C382C82F4D4A" maxlength="14" style="margin-top:6px"><div class="caption">Mode-S DF17 Extended Squitter · ICAO 24-bit hex + ME 56-bit hex · dummy load only, real airspace is illegal</div><button class="chip primary" id="a-send" style="margin-top:6px;width:100%">▶ SQUITTER</button>`;
      $('a-send').onclick = () => {
        const icao = parseInt(($('a-icao') as HTMLInputElement).value || '0', 16);
        const meStr = (($('a-me') as HTMLInputElement).value || '').padStart(14, '0');
        const meHi = parseInt(meStr.slice(0, 6), 16);
        const meLo = parseInt(meStr.slice(6, 14), 16);
        tx.adsb(icao, meLo, meHi);
      };
    }
  };
  qa<HTMLButtonElement>('[data-txtab]', view).forEach(b => b.onclick = () => { tab = Number(b.dataset.txtab); drawTab(); });
  drawTab();
  txStatus(tx.active ? 'transmitting' : 'idle');
}

function renderCapture(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${stepHtml([1e6, 1e5, 1e4])}${gainHtml()}
      <div class="caption">RECORD · signed 8-bit I/Q (.c8) + .txt sidecar, stored in the browser</div>
      <div class="row"><button id="rec" class="chip">● REC</button><span id="rec-info" class="info"></span></div>
      <div class="caption">CAPTURES · tap to download, ✕ to delete</div><div id="captures" class="panel list"><div class="empty">no captures yet</div></div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  $('rec').onclick = () => {
    if (state.capturing) worker?.postMessage({ type: 'capture', cmd: 'stop' });
    else worker?.postMessage({ type: 'capture', cmd: 'start', freq: state.freq, rate: state.rate });
  };
  refreshCapture();
}

/** A Settings row: what it is (and a line saying why) on the left, its control on the right. */
const srow = (label: string, desc: string, control: string, keys = '') => `<div class="srow" data-keys="${esc((label + ' ' + desc + ' ' + keys).toLowerCase())}"><div class="srl"><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</div><div class="src">${control}</div></div>`;
const swHtml = (id: string, on: boolean) => `<button id="${id}" class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${on}"><i></i></button>`;
const secHtml = (id: string, title: string, body: string) => body ? `<section class="sset" id="sec-${id}"><div class="sset-h">${title}</div>${body}</section>` : '';
/** The rows Settings shows for the app it was opened over (the Android app's "This app" section). */
function thisAppRows(app: AppId | null): string {
  const h = state.ham;
  switch (app) {
    case 'audio': return srow('RDS', 'Station name and radiotext on broadcast FM', swHtml('set-rds', rdsWanted)) + srow('HD Radio', 'The digital sidebands, where a station has them', swHtml('set-hd', hdWanted));
    case 'ham': {
      const ssb = h.mode === 'USB' || h.mode === 'LSB';
      return (ssb ? srow('Filter edges', 'Low and high edge of the pass band, Hz', `<input class="txin num" id="set-lo" value="${h.lo}" inputmode="numeric"> – <input class="txin num" id="set-hi" value="${h.hi}" inputmode="numeric">`)
          + srow('Passband shift', `${h.shift} Hz`, `<input id="set-pbt" type="range" min="-600" max="600" step="50" value="${h.shift}">`)
        : srow('Filter width', 'Hz', `<input class="txin num" id="set-w" value="${hamWidth()}" inputmode="numeric">`))
        + (h.mode === 'CW' ? srow('CW pitch', 'Hz', segHtml([500, 600, 700, 800].map(p => `<button data-setpitch="${p}" class="${h.pitch === p ? 'on' : ''}">${p}</button>`))) : '')
        + srow('Volume', `${Math.round(h.volume * 100)} %`, `<input id="set-vol" type="range" min="0" max="2" step="0.05" value="${h.volume}">`);
    }
    case 'pager': return srow('Mode', 'MULTI decodes up to four channels across the span at once; SINGLE the tuned one', segHtml([['0', 'SINGLE'], ['1', 'MULTI']].map(([v, l]) => `<button data-setmulti="${v}" class="${(v === '1') === state.pagerMulti ? 'on' : ''}">${l}</button>`)))
      + srow('Fold repeats', 'The same text sent again within two minutes is one card with a count', swHtml('set-fold', hunt.fold));
    default: return '';
  }
}
function renderSettings(view: HTMLElement): void {
  const over = settingsOver;
  const radioLine = radio ? (radio.kind === 'rtlsdr' ? radio.label : `HackRF · ${state.board || 'HackRF'}${state.firmware ? ' · fw ' + state.firmware : ''}`) : 'No radio attached';
  const appRows = thisAppRows(over);
  const jumps: [string, string][] = [...(appRows ? [['app', over ? barLabel(over) : 'APP'] as [string, string]] : []), ['radio', 'RADIO'], ['look', 'LOOK'], ['station', 'STATION'], ['tx', 'TRANSMIT'], ['how', 'HOW IT WORKS'], ['log', 'LOG'], ['about', 'ABOUT']];
  view.innerHTML = `
    <section class="controls settings-page">
    <input id="set-search" class="txin set-search" placeholder="Search settings" autocomplete="off" spellcheck="false">
    <div class="radiocard ${radio ? 'on' : ''}"><div><b>${radio ? 'RADIO CONNECTED' : 'NO RADIO'}</b><small>${esc(radioLine)}</small></div>${radio ? '' : '<button id="set-connect" class="act">CONNECT</button>'}</div>
    <div class="set-jumps">${hsHtml(`<div class="tiles">${jumps.map(([id, l]) => `<button class="pill" data-jump="${id}">${l}</button>`).join('')}</div>`)}</div>
    ${secHtml('app', `THIS APP · ${over ? barLabel(over) : ''}`, appRows)}
    ${secHtml('radio', 'RADIO', gainHtml())}
    <section class="sset" id="sec-look"><div class="sset-h">LOOK</div>
    <div class="skins">${SKINS.map(s => `<button class="skin" data-skin="${s.id}" style="background:${s.paper};border-color:${s.id === currentSkin().id ? s.accent : s.line};color:${s.ink}"><div class="skin-head"><span>${s.title}</span>${s.id === currentSkin().id ? `<span style="color:${s.accent}">●</span>` : ''}</div><div class="swatches">${[s.surface, s.panel, s.line, s.muted, s.accent, s.accent2].map(c => `<i style="background:${c}"></i>`).join('')}</div><div class="skin-readout" style="background:${s.surface};border-color:${s.accent}80;color:${s.accent}">92.3000 MHz</div></button>`).join('')}</div></section>
    <section class="sset" id="sec-station"><div class="sset-h">STATION</div>
    <div class="panel about" id="station">
      <div class="row"><input class="txin" data-st="call" placeholder="CALLSIGN" value="${state.ham.station.call}" autocapitalize="characters" spellcheck="false"><input class="txin" data-st="license" placeholder="license class (Technician, General…)" value="${state.ham.station.license}"></div>
      <div class="row"><input class="txin" data-st="name" placeholder="name" value="${state.ham.station.name}"><input class="txin" data-st="grid" placeholder="${state.home ? `grid ${latLonToGrid(state.home.lat, state.home.lon)} (from GPS)` : 'grid square, e.g. DM04og'}" value="${state.ham.station.grid}" autocapitalize="characters"></div>
      <div class="row"><input class="txin" data-st="dmrId" placeholder="DMR ID (radioid.net)" value="${state.ham.station.dmrId}" inputmode="numeric"><input class="txin" data-st="aprsSsid" placeholder="APRS SSID (9 = mobile)" value="${state.ham.station.aprsSsid}" inputmode="numeric"></div>
      <div class="kv"><span>Where it goes</span><span>ADIF STATION_CALLSIGN / MY_GRIDSQUARE, the APRS beacon source, CW and RTTY message defaults, the logbook's distance and bearing. Nothing is sent anywhere else.</span></div>
    </div></section>
    <section class="sset" id="sec-tx"><div class="sset-h">TRANSMIT</div>
      ${srow('Transmit', 'The transmit apps. Most bands need a license: use a dummy load or an antenna rated for the frequency.', swHtml('tx-toggle', tx.enabled), 'tx enable')}
    </section>
    <section class="sset" id="sec-how"><div class="sset-h">HOW IT WORKS</div><div class="panel about">      <div class="kv"><span>Browsers</span><span>Chrome / Edge on Android phones, Windows, macOS, Linux — the same desktop web app runs everywhere. iPhone/iPad and Firefox have no WebUSB; on Android phones the APK is the recommended route.</span></div>
      <div class="kv"><span>Power</span><span>a HackRF Pro can exceed what a phone's OTG port supplies — use a powered OTG hub if RX reads all zeros</span></div>
      <div class="kv"><span>Reading LOG</span><span>iqRMS ≈ 0.85 with dcI = dcQ ≈ 0.6 means all-zero buffers: cable, power, or a PortaPack not in HackRF mode</span></div>
      <div class="kv"><span>Tuning</span><span>press the waterfall and slide left or right — the amber guide and readout follow your finger, and the radio retunes when you lift it. Tap-and-release on a signal does the same.</span></div>
      <div class="kv"><span>ADS-B map</span><span>aircraft plot live on an OpenStreetMap view (Leaflet loads from the CDN when you open the app); it follows the traffic until you drag, ⌖ re-arms it; allow location so single-frame positions and the map center use your spot</span></div>
      <div class="kv"><span>FLEX</span><span>the pager app decodes FLEX (1600/3200, 2- and 4-level) by default — messages carry cycle/frame and capcode; switch the decoder to POCSAG (512/1200/2400) or run both on one channel like PDW</span></div>
      <div class="kv"><span>Squelch + scan</span><span>squelch gates audio by channel power against a tracked noise floor; SCAN hops through your bookmarks and holds on any channel where the squelch opens</span></div>
      <div class="kv"><span>Gain</span><span>radio defaults LNA 24 / VGA 24 / amp off (the amp overloads strong FM); ADS-B uses Mayhem's LNA 32 / VGA 32 / amp on</span></div>
      <div class="kv"><span>Windows</span><span>bind the HackRF to the WinUSB driver (Zadig), the same step hackrf_transfer needs; libusbK / libusb-win32 bindings hide it from the browser</span></div>
      <div class="kv"><span>macOS</span><span>nothing to install — just close any other SDR program that has the HackRF open</span></div>
      <div class="kv"><span>Linux</span><span>the udev rule from the hackrf package (53-hackrf.rules) grants access; replug after adding it</span></div>
      <div class="kv"><span>Keyboard</span><span>digits: wheel, click top/bottom, type · ← → tune · ↑ ↓ step size · M mode · X mute · S squelch · B bookmark · Space scan · A amp · G AGC · [ ] LNA · − = VGA · L log · Esc closes Settings, then goes home · mouse wheel over the waterfall tunes, Ctrl+wheel changes the step</span></div></div></section>
    <section class="sset" id="sec-log"><div class="sset-h">LOG</div>${srow('Log', 'Everything the radio and the decoders reported, to read, save or share', '<button id="set-log" class="tog">OPEN</button>')}</section>
    <section class="sset" id="sec-about"><div class="sset-h">ABOUT</div>
    <div class="panel about">
      <div class="row"><button id="install" class="chip" ${installPrompt ? '' : 'disabled'}>${installPrompt ? 'INSTALL TO HOME SCREEN' : 'INSTALLED / NOT OFFERED'}</button>${isAndroid() ? `<a class="chip primary" href="https://play.google.com/store/apps/details?id=com.rocketgod.mayhem">GET IT ON GOOGLE PLAY</a><a id="apk" class="chip" href="${apkUrl}" download="mayhem.apk">DOWNLOAD APK</a>` : ''}</div>
      ${isAndroid() ? `<div class="kv"><span>APK</span><span>The native app auto-launches when the HackRF is plugged in and keeps running in the background. It is served from this site, built from the same commit as the page you are reading, so it needs no GitHub account and can never be a different version from this one.</span></div>` : ''}
      <div class="kv"><span>Mayhem Mobile</span><span>${versionText} — one build, two shells: this desktop web app in any Chrome/Edge browser, and an APK that installs on Android phones</span></div>
      <div class="kv"><span>Device</span><span>${state.board ? (radio?.kind === 'rtlsdr' ? state.board : `${state.board} · fw ${state.firmware}`) : 'no radio attached'}</span></div>
      <div class="kv"><span>What it is</span><span>PortaPack Mayhem's receivers ported to run in the browser from raw HackRF IQ over WebUSB</span></div>
      <div class="kv"><span>Source</span><span><a href="https://github.com/RocketGod-git/mayhem-mobile">github.com/RocketGod-git/mayhem-mobile</a></span></div>
      <div class="kv"><span>Upstream</span><span><a href="https://github.com/portapack-mayhem/mayhem-firmware">portapack-mayhem/mayhem-firmware</a></span></div>
      <div class="kv"><span>License</span><span>GPL-3.0 (Mayhem-derived)</span></div>
    </div>
    <div class="panel about">
      <div class="kv"><span>RocketGod</span><span><a href="https://rocketgod.dev">RocketGod.dev</a></span></div>
      <div class="kv"><span>Crew</span><span>The Pirates' Plunder — <a href="https://discord.gg/thepirates">discord.gg/thepirates</a></span></div>
    </div>
    <div class="sset-sub">CREDITS · drag to steer</div>
    <div class="panel credits" id="credits"><div class="credits-roll" id="credits-roll">${(() => { const inner = CREDITS.map(([h, t]) => h ? `<h4>${esc(t)}</h4>` : `<p>${esc(t)}</p>`).join(''); return `<div class="credits-copy">${inner}</div><div class="credits-copy" aria-hidden="true">${inner}</div>`; })()}</div></div>
    </section></section>`;
  qa<HTMLInputElement>('[data-st]', view).forEach(i => i.oninput = () => { const k = i.dataset.st as keyof Station; const v = k === 'call' || k === 'grid' ? i.value.toUpperCase() : i.value; if (k === 'call' || k === 'grid') i.value = v; state.ham.station[k] = v; saveStation(); });
  qa<HTMLButtonElement>('[data-skin]', view).forEach(b => b.onclick = () => { applySkin(SKINS.find(s => s.id === b.dataset.skin)!); refreshSettings(); });
  const tg = q('#tx-toggle'); if (tg) tg.onclick = () => { tx.setEnabled(!tx.enabled); refreshSettings(); };
  bindSettings(view);
  $('install').onclick = async () => { if (installPrompt) { await installPrompt.prompt(); installPrompt = null; refreshSettings(); } };
  attachCreditsScroller($('credits'), $('credits-roll'));
}

/** Settings' own controls: search, jumps, the radio card, and the rows for the app it was opened over. */
function bindSettings(view: HTMLElement): void {
  const on = (id: string, f: () => void) => { const el = q<HTMLElement>('#' + id, view); if (el) el.onclick = f; };
  on('set-connect', () => $('connect').click());
  on('set-log', () => $('log-toggle').click());
  on('set-rds', () => { rdsWanted = !rdsWanted; if (!rdsWanted) lastRds = null; sendRds(); refreshSettings(); });
  on('set-hd', () => { hdWanted = !hdWanted; if (!hdWanted) lastHd = null; sendHd(); refreshSettings(); });
  const h = state.ham;
  const num = (id: string, f: (v: number) => void) => { const el = q<HTMLInputElement>('#' + id, view); if (el) el.onchange = () => { const v = Math.round(Number(el.value)); if (Number.isFinite(v)) f(v); }; };
  num('set-lo', v => { h.lo = Math.max(0, Math.min(5000, v)); h.hi = Math.max(h.lo + 100, h.hi); h.shift = 0; hamSend(); refreshSettings(); });
  num('set-hi', v => { h.hi = Math.max(h.lo + 100, Math.min(6000, v)); h.shift = 0; hamSend(); refreshSettings(); });
  num('set-w', v => { hamSetWidth(Math.max(50, Math.min(50_000, v))); refreshSettings(); });
  const pbt = q<HTMLInputElement>('#set-pbt', view); if (pbt) pbt.oninput = () => { h.shift = Number(pbt.value); hamSend(); const d = pbt.closest('.srow')?.querySelector('small'); if (d) d.textContent = `${h.shift} Hz`; };
  const vol = q<HTMLInputElement>('#set-vol', view); if (vol) vol.oninput = () => { h.volume = Number(vol.value); hamSend(); const d = vol.closest('.srow')?.querySelector('small'); if (d) d.textContent = `${Math.round(h.volume * 100)} %`; };
  qa<HTMLButtonElement>('[data-setpitch]', view).forEach(b => b.onclick = () => { h.pitch = Number(b.dataset.setpitch); hamSend(); refreshSettings(); });
  qa<HTMLButtonElement>('[data-setmulti]', view).forEach(b => b.onclick = () => {
    const multi = b.dataset.setmulti === '1'; if (multi === state.pagerMulti) return;
    state.pagerMulti = multi; if (state.app === 'pager') open('pager');   // the pager under the overlay switches now
    refreshSettings();
  });
  const sf = q('#set-fold'); if (sf) sf.onclick = () => { hunt.fold = !hunt.fold; sf.classList.toggle('on', hunt.fold); };
  qa<HTMLButtonElement>('[data-jump]', view).forEach(b => b.onclick = () => q(`#sec-${b.dataset.jump}`, view)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  const search = q<HTMLInputElement>('#set-search', view);
  if (search) search.oninput = () => {
    const t = search.value.trim().toLowerCase();
    qa<HTMLElement>('.srow', view).forEach(r => { r.hidden = !!t && !(r.dataset.keys ?? '').includes(t); });
    qa<HTMLElement>('.sset', view).forEach(sec => { sec.hidden = !!t && !sec.textContent!.toLowerCase().includes(t); });
  };
}
/** Endless-loop credits scroller. Content is rendered twice; a rAF loop translates the roll upward at a steady
 *  pixels/sec, and when it crosses one copy's height it wraps back — so there's no visible seam or pause. Pointer
 *  drag on the panel takes over: the roll follows the finger, and the auto-scroll resumes on release, keeping any
 *  fling momentum you gave it. */
function attachCreditsScroller(panel: HTMLElement | null, roll: HTMLElement | null): void {
  if (!panel || !roll) return;
  const AUTO_PX_PER_SEC = 22;
  let offset = 0;
  let dragging = false;
  let velocity = 0;
  let lastY = 0;
  let lastT = performance.now();
  let raf = 0;
  const halfHeight = () => (roll.scrollHeight || 1) / 2;
  const paint = () => { roll.style.transform = `translateY(${-offset}px)`; };
  const step = (now: number) => {
    const dt = Math.min(80, now - lastT) / 1000; lastT = now;
    if (!dragging) {
      offset += AUTO_PX_PER_SEC * dt;
      if (Math.abs(velocity) > 5) { offset += velocity * dt; velocity *= Math.pow(0.001, dt); }
    }
    const h = halfHeight();
    if (h > 0) { while (offset >= h) offset -= h; while (offset < 0) offset += h; }
    paint();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  panel.style.touchAction = 'none';
  panel.style.cursor = 'grab';
  const down = (e: PointerEvent) => {
    dragging = true; velocity = 0; lastY = e.clientY; panel.style.cursor = 'grabbing';
    try { panel.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const move = (e: PointerEvent) => {
    if (!dragging) return;
    const dy = e.clientY - lastY; lastY = e.clientY;
    offset -= dy;
    velocity = -dy * 60; // px/sec-ish for the coast
    paint();
  };
  const up = (e: PointerEvent) => {
    dragging = false; panel.style.cursor = 'grab';
    try { panel.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  panel.addEventListener('pointerdown', down);
  panel.addEventListener('pointermove', move);
  panel.addEventListener('pointerup', up);
  panel.addEventListener('pointercancel', up);
  // Stop the loop when the settings view is torn down so it doesn't keep painting a detached node.
  const stop = new MutationObserver(() => { if (!document.body.contains(roll)) { cancelAnimationFrame(raf); stop.disconnect(); } });
  stop.observe(document.body, { childList: true, subtree: true });
}

function wireCommon(view: HTMLElement): void {
  const fav = q<HTMLButtonElement>('#fav', view); if (fav) { fav.onclick = toggleFav; refreshFav(); }
  const fkey = q<HTMLButtonElement>('#fkey', view); if (fkey) fkey.onclick = () => freqEntry();
  qa<HTMLButtonElement>('[data-app]', view).forEach(b => b.onclick = () => open(b.dataset.app as AppId));
  qa<HTMLButtonElement>('[data-satview]', view).forEach(b => b.onclick = () => { state.ham.sat.view = b.dataset.satview as typeof state.ham.sat.view; open('sat'); });
  qa<HTMLButtonElement>('[data-mode]', view).forEach(b => b.onclick = () => setMode(b.dataset.mode as Mode));
  qa<HTMLButtonElement>('[data-step]', view).forEach(b => b.onclick = () => tune(state.freq + Number(b.dataset.step)));
  qa<HTMLButtonElement>('[data-preset]', view).forEach(b => b.onclick = () => { if (b.dataset.pmode) setMode(b.dataset.pmode as Mode); tune(Number(b.dataset.preset)); });
  qa<HTMLButtonElement>('[data-lband]', view).forEach(b => b.onclick = () => gotoBand(b.dataset.lband || 'fm'));
  qa<HTMLButtonElement>('[data-rate]', view).forEach(b => b.onclick = () => setRate(Number(b.dataset.rate)));
  highlightBands();
  const on = (id: string, f: () => void) => { const el = q<HTMLButtonElement>('#' + id, view); if (el) el.onclick = f; };
  on('lna-minus', () => manualGains(state.lna - 8, state.vga, state.amp)); on('lna-plus', () => manualGains(state.lna + 8, state.vga, state.amp));
  on('vga-minus', () => manualGains(state.lna, state.vga - 2, state.amp)); on('vga-plus', () => manualGains(state.lna, state.vga + 2, state.amp));
  on('amp', () => { setGains(state.lna, state.vga, !state.amp); saveGains(); });
  on('biast', () => toggleBiasTee());
  on('agc', () => userAgc(!state.agc)); refreshAgcChip(); refreshGainUi();
  // by id, whatever screen they are on. The old loop keyed off `logs`, which only the first packet creates, so
  // a CLEAR tapped on a screen opened before anything arrived was never wired at all.
  qa<HTMLButtonElement>('[id^="clear-"]', view).forEach(b => b.onclick = () => clearApp(b.id.slice(6)));
  qa<HTMLButtonElement>('[id^="pause-"]', view).forEach(b => b.onclick = () => togglePause(b.id.slice(6)));
  refreshPauseChips();
  qa<HTMLButtonElement>('[data-rate]', view).forEach(b => b.classList.toggle('on', Number(b.dataset.rate) === state.rate));
}

function refreshReadout(): void {
  setFreqDisplay(state.freq);
  if (state.app === 'audio') setFace(state.mode, audioTitle());
  scope?.setLabels(centredLabels(spanCenter(), state.rate));
  refreshSpanBar();
  document.body.classList.toggle('offspan', channelOff());
  if (lastCenterSent !== spanCenter()) { lastCenterSent = spanCenter(); worker?.postMessage({ type: 'config', centreHz: lastCenterSent }); }
  qa('[data-preset]').forEach(b => b.classList.toggle('on', Number(b.dataset.preset) === state.freq));
  highlightBands();
  refreshFav();
  const h = q('#health'); if (h && lastHealth) h.textContent = lastHealth;
  const ll = q('#launch-line'); if (ll) ll.textContent = lastHealth ? `${(state.freq / 1e6).toFixed(3)} MHz${state.mode === 'NONE' ? '' : ` ${state.mode}`} · ${lastHealth}` : 'no IQ yet — connect a HackRF or an RTL-SDR';
  if (!meterOwned()) setMeter(lastLevel / 40, `SIGNAL +${Math.max(0, Math.round(lastLevel))} dB`);
}
/** Apps that drive the card's meter themselves (Audio's channel over the noise, HAM's S-meter, sweeps' progress). */
const meterOwned = () => (state.app === 'trains' && trainsBurst() !== null) || state.app === 'audio' || state.app === 'ham' || state.app === 'sat' || state.app === 'lookingglass' || state.app === 'search' || state.app === 'prowl' || state.app === 'transmit' || state.app === 'troll';
/** Screens held still by their PAUSE button. Decoding carries on underneath; the rows catch up on RESUME. */
const paused = new Set<string>();
function togglePause(id: string): void {
  if (!paused.delete(id)) paused.add(id);
  refreshPauseChips();
  if (!paused.has(id)) redraw(id);
}
function refreshPauseChips(): void { qa<HTMLButtonElement>('[id^="pause-"]').forEach(b => { const on = paused.has(b.id.slice(6)); b.classList.toggle('on', on); b.textContent = on ? 'RESUME' : 'PAUSE'; }); }
/** The whole screen for one list, drawn again from what is held in memory. */
function redraw(id: string): void {
  switch (id) {
    case 'ais': refreshAis(); break;
    case 'aprs': refreshAprs(); break;
    case 'adsb': refreshAdsb(); break;
    case 'devices': drawR433(); break;
    case 'psat': refreshPacketSats(); break;
    case 'ert': refreshList(id); refreshMeters(true); break;
    case 'lora': refreshList(id); refreshLora(true); break;
    case 'trains': refreshList(id); refreshTrains(true); break;
    default: refreshList(id);
  }
}
/** CLEAR forgets what a screen has heard - the rows here and the table the worker keeps behind them. The worker's
 *  copy matters: vessels, stations, aircraft and devices are re-sent whole with every packet, so clearing only
 *  this side brought the entire list straight back with the next one. */
function clearApp(id: string): void {
  logs[id] = []; counts[id] = 0;
  switch (id) {
    case 'ais': state.aisTable = []; state.aisSel = 0; break;
    case 'aprs': state.aprsStations = []; state.aprsSel = ''; break;
    case 'adsb': state.aircraft = []; state.frames = 0; state.adsbSel = ''; break;
    case 'devices': state.r433.heard = []; break;
    case 'psat': state.psat.frames = []; state.psat.heard = 0; state.psat.bad = 0; break;
    case 'ert': meters.snap = null; meters.sel = ''; break;
    case 'lora': loraUi.snap = null; loraUi.sel = ''; break;
    case 'trains': trainsUi.snap = null; break;
  }
  worker?.postMessage({ type: 'clear' });
  // a cleared screen shows empty even while paused - the freeze is for reading rows, and there are none now
  const held = paused.delete(id); redraw(id); if (held) paused.add(id);
}
function refreshList(id: string): void {
  const c = q(`#count-${id}`); if (c) c.textContent = `${counts[id] ?? 0} DECODED`;
  if (id === state.app) {
    const n = counts[id] ?? 0;
    if (n > 0) setLamp(`${n} DECODED`, 'ok'); else setLamp(state.connected ? 'LISTENING' : 'NO RADIO', state.connected ? 'amber' : '', state.connected);
    const r = q('#capr'); if (r) r.textContent = n > 0 ? `${n} decoded` : 'nothing decoded yet';
  }
  const el = q(`#list-${id}`); if (!el || paused.has(id)) return;
  const lines = logs[id] ?? [];
  el.innerHTML = lines.length ? lines.map((l, i) => `<div class="li ${i % 2 ? 'alt' : ''}">${esc(l)}</div>`).join('') : '<div class="empty">listening…</div>';
}
function refreshAis(): void {
  if (state.app !== 'ais') return;
  const c = q('#ais-count'); if (c) c.textContent = `⚓ ${counts['ais'] ?? 0} PACKETS · ${state.aisTable.length} VESSELS`;
  qa('[data-aisview]').forEach(b => b.classList.toggle('on', b.dataset.aisview === state.aisView));
  const list = q('#ais-list'), mapEl = q('#ais-map'), logEl = q('#ais-log'); if (!list || !mapEl || !logEl) return;
  list.hidden = state.aisView !== 'list'; mapEl.hidden = state.aisView !== 'map'; logEl.hidden = state.aisView !== 'log';
  if (paused.has('ais')) { qa<HTMLElement>('[data-mmsi]', list).forEach(d => d.classList.toggle('gold', Number(d.dataset.mmsi) === state.aisSel)); renderShipCard(state.aisTable.find(v => v.mmsi === state.aisSel)); return; }
  list.innerHTML = state.aisTable.length ? state.aisTable.map((v, i) => `<div class="li row2 tap ${i % 2 ? 'alt' : ''} ${v.mmsi === state.aisSel ? 'gold' : ''}" data-mmsi="${v.mmsi}"><b>${esc(v.name || String(v.mmsi))}</b><span>${v.name ? v.mmsi + ' · ' : ''}${v.lat !== undefined && v.lon !== undefined ? `${v.lat.toFixed(3)},${v.lon.toFixed(3)}` : 'no fix'}${v.sog !== undefined ? ` · ${v.sog.toFixed(1)} kn` : ''}</span></div>`).join('') : '<div class="empty">no vessels yet</div>';
  qa<HTMLElement>('[data-mmsi]', list).forEach(d => d.onclick = () => { state.aisSel = Number(d.dataset.mmsi); const v = state.aisTable.find(x => x.mmsi === state.aisSel); if (v?.lat !== undefined) state.aisView = 'map'; refreshAis(); });
  renderShipCard(state.aisTable.find(v => v.mmsi === state.aisSel));
  if (state.aisView === 'map') geo?.invalidate();
  geo?.update(state.aisTable.filter(v => v.lat !== undefined && v.lon !== undefined).map(v => ({ id: String(v.mmsi), lat: v.lat!, lon: v.lon!, heading: v.hdg ?? v.cog, label: v.name || String(v.mmsi), kind: (v.cls === 'AtoN' ? 'aton' : v.cls === 'base' ? 'object' : 'ship') as GeoItem['kind'] })), String(state.aisSel));
}
function refreshAprs(): void {
  if (state.app !== 'aprs') return;
  // the packet count rides in the card's title, as in the native apps
  if (state.app === 'aprs') setFace('APRS', `${counts['aprs'] ?? 0} PACKETS`);
  qa('[data-aprsview]').forEach(b => b.classList.toggle('on', b.dataset.aprsview === state.aprsView));
  const list = q('#aprs-list'), mapEl = q('#aprs-map'), logEl = q('#aprs-log'); if (!list || !mapEl || !logEl) return;
  list.hidden = state.aprsView !== 'list'; mapEl.hidden = state.aprsView !== 'map'; logEl.hidden = state.aprsView !== 'log';
  if (paused.has('aprs')) { qa<HTMLElement>('[data-call]', list).forEach(d => d.classList.toggle('gold', d.dataset.call === state.aprsSel)); renderStationCard(state.aprsStations.find(s => s.call === state.aprsSel)); return; }
  list.innerHTML = state.aprsStations.length ? state.aprsStations.map((s, i) => `<div class="li row2 tap ${i % 2 ? 'alt' : ''} ${s.call === state.aprsSel ? 'gold' : ''}" data-call="${esc(s.call)}"><b>${esc(s.call)}${s.kind !== 'station' ? ` <small>${s.kind} by ${esc(s.owner ?? '?')}</small>` : ''}</b><span>${esc(aprsSymbolName(s.table, s.symbol))}${s.lat !== undefined && s.lon !== undefined ? ` · ${s.lat.toFixed(3)},${s.lon.toFixed(3)}` : ''}${s.speed ? ` · ${Math.round(s.speed)} kn` : ''}</span></div>`).join('') : '<div class="empty">no stations yet</div>';
  qa<HTMLElement>('[data-call]', list).forEach(d => d.onclick = () => { state.aprsSel = d.dataset.call!; const s = state.aprsStations.find(x => x.call === state.aprsSel); if (s?.lat !== undefined) state.aprsView = 'map'; refreshAprs(); });
  renderStationCard(state.aprsStations.find(s => s.call === state.aprsSel));
  if (state.aprsView === 'map') geo?.invalidate();
  geo?.update(state.aprsStations.filter(s => s.lat !== undefined && s.lon !== undefined).map(s => ({ id: s.call, lat: s.lat!, lon: s.lon!, heading: s.course, label: s.call, kind: (s.kind === 'station' ? 'station' : 'object') as GeoItem['kind'] })), state.aprsSel);
}
function refreshBtle(): void { qa('[data-btle]').forEach(b => b.classList.toggle('on', Number(b.dataset.btle) === state.btleCh)); }
/** The map over the whole window with the selected aircraft and the list beside it (Esc or ⛶ again leaves). */
let adsbFull = false;
function setAdsbFull(on: boolean): void {
  adsbFull = on;
  const v = q('.view.adsb'); if (!v) return;
  v.classList.toggle('mapfull', on);
  const b = q('#adsb-full'); if (b) { b.innerHTML = on ? EXIT_SVG : FULL_SVG; b.title = on ? 'leave the full-screen map' : 'full-screen map'; }
  refreshAdsb();
  // Leaflet measures its box once; tell it the box changed after the layout settles
  requestAnimationFrame(() => geo?.invalidate());
}
/**
 * One aircraft in the list: its photo (from the registry, a plane glyph until one comes), callsign, registration and
 * type, operator, then altitude, speed and distance. Rows are kept per aircraft and updated in place, so a photo is
 * loaded once rather than every frame.
 */
function acRowFill(row: HTMLElement, a: Aircraft): void {
  lookupAircraft(a);
  const info = acInfo.get(a.icao);
  const set = (k: string, v: string) => { const e = row.querySelector<HTMLElement>(`[data-r="${k}"]`); if (e && e.textContent !== v) e.textContent = v; };
  const th = row.querySelector<HTMLElement>('.acth')!;
  const photo = info?.photo ?? '';
  if (th.dataset.src !== photo) {
    th.dataset.src = photo;
    th.innerHTML = photo ? `<img src="${esc(photo)}" alt="" loading="lazy" onerror="this.parentElement.dataset.src='';this.remove()">` : glyph('adsb', 'currentColor', 26);
  }
  const call = (a.flight ?? '').trim();
  set('call', call || a.icao.toUpperCase());
  set('hex', call ? a.icao.toUpperCase() : '');
  set('id', [info?.reg, info?.typeIcao].filter(Boolean).join(' · ') || (info && !info.done ? 'looking up…' : ''));
  set('op', info?.owner ?? [info?.maker, info?.type].filter(Boolean).join(' '));
  set('alt', a.alt !== undefined ? `${a.alt.toLocaleString()} ft` : '— ft');
  set('gs', a.gs !== undefined ? `${a.gs} kt` : '— kt');
  let far = a.lat === undefined ? 'no position' : '';
  if (!far && state.home && a.lon !== undefined) { const d = distanceBearing(state.home.lat, state.home.lon, a.lat!, a.lon); far = `${(d.km * 0.539957).toFixed(0)} nmi · ${Math.round(d.deg)}°`; }
  set('far', far);
  const climb = a.vr === undefined ? '' : a.vr > 300 ? '▲' : a.vr < -300 ? '▼' : '';
  set('vr', climb);
  row.classList.toggle('gold', a.icao === state.adsbSel);
  row.classList.toggle('nopos', a.lat === undefined);
}
function refreshAdsb(): void {
  const c = q('#adsb-count'); if (c) c.textContent = `✈ ${state.frames} FRAMES · ${state.aircraft.length} AIRCRAFT`;
  qa('[data-adsbview]').forEach(b => b.classList.toggle('on', b.dataset.adsbview === state.adsbView));
  const el = q('#adsb-list'), mapEl = q('#adsb-map'); if (!el || !mapEl) return;
  el.hidden = !adsbFull && state.adsbView !== 'list'; mapEl.hidden = !adsbFull && state.adsbView !== 'map';
  renderAcCard(state.aircraft.find(a => a.icao === state.adsbSel));
  if (paused.has('adsb')) { qa<HTMLElement>('[data-icao]', el).forEach(d => d.classList.toggle('gold', d.dataset.icao === state.adsbSel)); return; }
  if (!state.aircraft.length) el.innerHTML = '<div class="empty">listening on 1090 MHz…</div>';
  else {
    el.querySelector('.empty')?.remove();
    const rows = new Map(qa<HTMLElement>('[data-icao]', el).map(r => [r.dataset.icao!, r]));
    state.aircraft.forEach((a) => {
      let row = rows.get(a.icao);
      if (!row) {
        row = document.createElement('div');
        row.className = 'acrow tap'; row.dataset.icao = a.icao;
        row.innerHTML = '<div class="acth"></div><div class="acmid"><div><b data-r="call"></b> <span class="achex" data-r="hex"></span></div><div class="acid" data-r="id"></div><div class="acop" data-r="op"></div></div><div class="acnum"><b><span data-r="alt"></span> <i data-r="vr"></i></b><span data-r="gs"></span><small data-r="far"></small></div>';
        row.onclick = () => {
          state.adsbSel = row!.dataset.icao!; const p = state.aircraft.find(x => x.icao === state.adsbSel);
          if (p?.lat !== undefined && p.lon !== undefined) { if (!adsbFull) state.adsbView = 'map'; refreshAdsb(); geo?.center(p.lat, p.lon); } else refreshAdsb();
        };
      }
      rows.delete(a.icao);
      acRowFill(row, a);
      el.appendChild(row);   // moves an existing row into the current order
    });
    for (const r of rows.values()) r.remove();
  }
  if (state.adsbView === 'map' || adsbFull) geo?.invalidate();
  geo?.update(state.aircraft.filter(a => a.lat !== undefined && a.lon !== undefined).map(a => ({ id: a.icao, lat: a.lat!, lon: a.lon!, heading: a.track, label: (a.flight ?? '').trim() || a.icao.toUpperCase(), kind: 'plane' as const })), state.adsbSel);
}
// ---- AIS vessel card: everything the station has said about itself ----------------------------------------------------
let shipCardKey = '';
function renderShipCard(v: Vessel | undefined): void {
  const card = q<HTMLElement>('#ais-card'); if (!card) return;
  if (!v) { card.hidden = true; shipCardKey = ''; return; }
  card.hidden = false;
  const who = mmsiInfo(v.mmsi);
  const kind = v.cls === 'A' ? 'Class A' : v.cls === 'B' ? 'Class B' : v.cls === 'base' ? 'Base station' : v.cls === 'AtoN' ? (v.virtualAton ? 'Virtual aid to navigation' : 'Aid to navigation') : v.cls === 'SAR' ? 'SAR aircraft' : who.kind;
  const key = [v.mmsi, v.name, v.callsign, v.imo, v.shipType, v.atonType, v.dest, v.eta?.day, v.dimA, v.dimB, v.dimC, v.dimD, v.draft, v.cls, v.navStatus].join('|');
  if (key !== shipCardKey) {
    shipCardKey = key;
    const lines: string[] = [];
    const id = [v.callsign ? `call ${esc(v.callsign)}` : '', v.imo ? `IMO ${v.imo}` : ''].filter(Boolean).join(' · ');
    if (id) lines.push(`<div class="accard-reg">${id}</div>`);
    const type = v.cls === 'AtoN' ? atonTypeName(v.atonType) : shipTypeName(v.shipType);
    lines.push(`<div class="accard-model">${esc([kind, type].filter(Boolean).join(' · '))}</div>`);
    if (v.navStatus !== undefined && navStatusName(v.navStatus)) lines.push(`<div class="accard-op">${esc(navStatusName(v.navStatus))}</div>`);
    if (v.dest) lines.push(`<div class="accard-op">→ ${esc(v.dest)}${v.eta ? ` · ETA ${String(v.eta.day).padStart(2, '0')}/${String(v.eta.month).padStart(2, '0')} ${String(v.eta.hour).padStart(2, '0')}:${String(v.eta.minute).padStart(2, '0')} UTC` : ''}</div>`);
    const len = v.dimA !== undefined && v.dimB !== undefined ? v.dimA + v.dimB : 0, beam = v.dimC !== undefined && v.dimD !== undefined ? v.dimC + v.dimD : 0;
    const size = [len ? `${len} m long` : '', beam ? `${beam} m beam` : '', v.draft ? `draft ${v.draft.toFixed(1)} m` : ''].filter(Boolean).join(' · ');
    if (size) lines.push(`<div class="accard-country">${esc(size)}</div>`);
    if (who.flag) lines.push(`<div class="accard-country">${esc(who.flag)}</div>`);
    if (v.vendor) lines.push(`<div class="accard-country">transponder ${esc(v.vendor)}</div>`);
    card.innerHTML = `
      <div class="accard-bar">
        <b>${esc(v.name || `MMSI ${v.mmsi}`)}</b><span class="accard-hex">${v.name ? `MMSI ${v.mmsi}` : 'no name yet'}</span>
        <span class="accard-btns"><button class="chip" data-shipmap title="center the map on it" ${v.lat === undefined ? 'hidden' : ''}>MAP</button><button class="chip" data-shipclose title="close">✕</button></span>
      </div>
      <div class="accard-body"><div class="accard-id">${lines.join('')}</div></div>
      <div class="accard-grid">
        ${['SPEED', 'COURSE', 'HEADING', 'TURN', 'POSITION', 'FROM YOU', 'HEARD', 'FIRST HEARD', 'MESSAGES'].map(k => `<div><span class="k">${k}</span><span class="v" data-f="${k}">—</span></div>`).join('')}
      </div>`;
    qa<HTMLButtonElement>('[data-shipclose]', card).forEach(b => b.onclick = () => { state.aisSel = 0; refreshAis(); });
    qa<HTMLButtonElement>('[data-shipmap]', card).forEach(b => b.onclick = () => { state.aisView = 'map'; refreshAis(); const s = state.aisTable.find(x => x.mmsi === state.aisSel); if (s?.lat !== undefined && s.lon !== undefined) geo?.center(s.lat, s.lon); });
  }
  const now = Date.now();
  const set = (k: string, val: string) => { const el = card.querySelector<HTMLElement>(`[data-f="${k}"]`); if (el && el.textContent !== val) el.textContent = val; };
  set('SPEED', v.sog !== undefined ? `${v.sog.toFixed(1)} kn` : '—');
  set('COURSE', v.cog !== undefined ? `${v.cog.toFixed(0)}°` : '—');
  set('HEADING', v.hdg !== undefined ? `${v.hdg}°` : '—');
  set('TURN', v.rot !== undefined ? (Math.abs(v.rot) < 0.5 ? 'steady' : `${v.rot > 0 ? '→' : '←'} ${Math.abs(v.rot).toFixed(0)}°/min`) : '—');
  set('POSITION', v.lat !== undefined && v.lon !== undefined ? `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}${v.accuracy ? '' : ' (≈)'}` : 'no fix yet');
  if (state.home && v.lat !== undefined && v.lon !== undefined) { const d = distanceBearing(state.home.lat, state.home.lon, v.lat, v.lon); set('FROM YOU', `${d.km.toFixed(d.km < 10 ? 1 : 0)} km · ${(d.km * 0.539957).toFixed(0)} nmi · ${Math.round(d.deg)}°`); }
  else set('FROM YOU', state.home ? '—' : 'allow location to see');
  set('HEARD', ageText(now - v.lastMs));
  set('FIRST HEARD', `${ageText(now - v.firstMs)} · ${new Date(v.firstMs).toLocaleTimeString()}`);
  set('MESSAGES', String(v.msgs));
}
// ---- APRS station card: the packet fields, the symbol, and who the callsign belongs to --------------------------------
const stationInfo = new Map<string, CallInfo | null>();
let stationCardKey = '';
function renderStationCard(s: AprsStation | undefined): void {
  const card = q<HTMLElement>('#aprs-card'); if (!card) return;
  if (!s) { card.hidden = true; stationCardKey = ''; return; }
  card.hidden = false;
  const base = parseCall(s.call.replace(/-\d+$/, '')).base;
  if (s.kind === 'station' && base && !stationInfo.has(base)) { stationInfo.set(base, null); void lookupCall(base).then(i => { stationInfo.set(base, i); if (state.app === 'aprs') refreshAprs(); }).catch(() => undefined); }
  const info = base ? stationInfo.get(base) ?? null : null;
  const key = [s.call, s.kind, s.owner, s.symbol, s.table, s.comment, s.status, s.mice, s.dest, s.path, s.via, s.lastMsg?.text, info?.name, info?.qth, info?.country, s.wx ? 1 : 0].join('|');
  if (key !== stationCardKey) {
    stationCardKey = key;
    const lines: string[] = [];
    const sym = aprsSymbolName(s.table, s.symbol);
    lines.push(`<div class="accard-model">${esc([s.kind === 'object' ? `Object from ${s.owner}` : s.kind === 'item' ? `Item from ${s.owner}` : '', sym].filter(Boolean).join(' · ') || 'APRS station')}</div>`);
    if (info?.name || info?.qth) lines.push(`<div class="accard-op">${esc([info.name, info.qth].filter(Boolean).join(' · '))}</div>`);
    if (info?.country) lines.push(`<div class="accard-country">${esc(info.country)}${info.class ? ` · ${esc(info.class)}` : ''}</div>`);
    if (s.mice) lines.push(`<div class="accard-op">Mic-E: ${esc(s.mice)}</div>`);
    if (s.status) lines.push(`<div class="accard-op">${esc(s.status)}</div>`);
    if (s.comment) lines.push(`<div class="accard-op">${esc(s.comment)}</div>`);
    if (s.lastMsg) lines.push(`<div class="accard-op">→ ${esc(s.lastMsg.to)}: ${esc(s.lastMsg.text)}</div>`);
    if (s.path || s.via) lines.push(`<div class="accard-country">${esc([s.dest ? `to ${s.dest}` : '', s.path ? `via ${s.path}` : 'direct', s.via ? `relayed by ${s.via}` : ''].filter(Boolean).join(' · '))}</div>`);
    const wx = s.wx ? ['TEMP', 'WIND', 'GUST', 'HUMIDITY', 'PRESSURE', 'RAIN 1H', 'RAIN 24H'] : [];
    card.innerHTML = `
      <div class="accard-bar">
        <b>${esc(s.call)}</b><span class="accard-hex">${esc(s.kind === 'station' ? 'APRS' : s.kind)}</span>
        <span class="accard-btns"><button class="chip" data-stmap title="center the map on it" ${s.lat === undefined ? 'hidden' : ''}>MAP</button><button class="chip" data-stclose title="close">✕</button></span>
      </div>
      <div class="accard-body"><div class="accard-id">${lines.join('')}</div></div>
      <div class="accard-grid">
        ${['POSITION', 'GRID', 'FROM YOU', 'COURSE', 'SPEED', 'ALTITUDE', ...wx, 'HEARD', 'FIRST HEARD', 'PACKETS'].map(k => `<div><span class="k">${k}</span><span class="v" data-f="${k}">—</span></div>`).join('')}
      </div>`;
    qa<HTMLButtonElement>('[data-stclose]', card).forEach(b => b.onclick = () => { state.aprsSel = ''; refreshAprs(); });
    qa<HTMLButtonElement>('[data-stmap]', card).forEach(b => b.onclick = () => { state.aprsView = 'map'; refreshAprs(); const x = state.aprsStations.find(y => y.call === state.aprsSel); if (x?.lat !== undefined && x.lon !== undefined) geo?.center(x.lat, x.lon, 11); });
  }
  const now = Date.now();
  const set = (k: string, val: string) => { const el = card.querySelector<HTMLElement>(`[data-f="${k}"]`); if (el && el.textContent !== val) el.textContent = val; };
  const hasPos = s.lat !== undefined && s.lon !== undefined;
  set('POSITION', hasPos ? `${s.lat!.toFixed(4)}, ${s.lon!.toFixed(4)}` : 'no position');
  set('GRID', hasPos ? latLonToGrid(s.lat!, s.lon!, 8) : '—');
  if (state.home && hasPos) { const d = distanceBearing(state.home.lat, state.home.lon, s.lat!, s.lon!); set('FROM YOU', `${d.km.toFixed(d.km < 10 ? 1 : 0)} km · ${(d.km * 0.621371).toFixed(0)} mi · ${Math.round(d.deg)}°`); }
  else set('FROM YOU', state.home ? '—' : 'allow location to see');
  set('COURSE', s.course !== undefined ? `${Math.round(s.course)}°` : '—');
  set('SPEED', s.speed !== undefined ? `${Math.round(s.speed * 1.15078)} mph · ${Math.round(s.speed)} kn` : '—');
  set('ALTITUDE', s.alt !== undefined ? `${Math.round(s.alt * 3.28084).toLocaleString()} ft · ${Math.round(s.alt)} m` : '—');
  if (s.wx) {
    const w = s.wx;
    set('TEMP', w.tempF !== undefined ? `${w.tempF} °F · ${((w.tempF - 32) * 5 / 9).toFixed(1)} °C` : '—');
    set('WIND', w.windMph !== undefined ? `${w.windMph} mph${w.windDir !== undefined ? ` from ${w.windDir}°` : ''}` : '—');
    set('GUST', w.gustMph !== undefined ? `${w.gustMph} mph` : '—');
    set('HUMIDITY', w.humidity !== undefined ? `${w.humidity} %` : '—');
    set('PRESSURE', w.pressureMb !== undefined ? `${w.pressureMb.toFixed(1)} mb` : '—');
    set('RAIN 1H', w.rain1h !== undefined ? `${(w.rain1h / 100).toFixed(2)} in` : '—');
    set('RAIN 24H', w.rain24h !== undefined ? `${(w.rain24h / 100).toFixed(2)} in` : '—');
  }
  set('HEARD', ageText(now - s.lastMs));
  set('FIRST HEARD', `${ageText(now - s.firstMs)} · ${new Date(s.firstMs).toLocaleTimeString()}`);
  set('PACKETS', String(s.packets));
}
// ---- ADS-B details card: what the frames say plus what the registries know ------------------------------------------
interface AcInfo { reg?: string; type?: string; typeIcao?: string; maker?: string; owner?: string; country?: string; photo?: string; done: boolean }
const acInfo = new Map<string, AcInfo>();
let acCardKey = '';
/** Registration / type / operator from the adsbdb registry mirror (free, CORS-friendly), cached per hex. (No route lookup: the callsign→route table is crowd-sourced and often stale.) */
function lookupAircraft(a: Aircraft): void {
  const key = a.icao;
  if (acInfo.has(key)) return;
  const info: AcInfo = { done: false }; acInfo.set(key, info);
  const jobs: Promise<void>[] = [
    fetch(`https://api.adsbdb.com/v0/aircraft/${a.icao.toUpperCase()}`).then(r => r.ok ? r.json() : null).then((j: any) => {
      const x = j?.response?.aircraft; if (!x) return;
      info.reg = x.registration; info.type = x.type; info.typeIcao = x.icao_type; info.maker = x.manufacturer; info.owner = x.registered_owner; info.country = x.registered_owner_country_name; info.photo = x.url_photo_thumbnail;
    }).catch(() => undefined),
  ];
  void Promise.all(jobs).then(() => { info.done = true; if (state.app === 'adsb') refreshAdsb(); });
}
const ageText = (ms: number) => ms < 1000 ? 'now' : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`;
/** The selected aircraft's card: rebuilt when the selection or the registry data changes, live fields refreshed every frame. */
function renderAcCard(a: Aircraft | undefined): void {
  const card = q<HTMLElement>('#adsb-card'); if (!card) return;
  if (!a) { card.hidden = true; acCardKey = ''; return; }
  card.hidden = false;
  lookupAircraft(a);
  const info = acInfo.get(a.icao);
  const key = `${a.icao}|${a.flight ?? ''}|${info?.done ? 1 : 0}`;
  const call = (a.flight ?? '').trim();
  if (key !== acCardKey) {
    acCardKey = key;
    // identity, one fact per line so nothing wraps mid-phrase: registration + type code / manufacturer + model / operator / country
    const lines: string[] = [];
    if (info?.reg || info?.typeIcao) lines.push(`<div class="accard-reg">${esc(info.reg ?? '')}${info.typeIcao ? ` <span>${esc(info.typeIcao)}</span>` : ''}</div>`);
    const model = [info?.maker, info?.type].filter((s): s is string => !!s).join(' '); if (model) lines.push(`<div class="accard-model">${esc(model)}</div>`);
    if (info?.owner) lines.push(`<div class="accard-op">${esc(info.owner)}</div>`);
    if (info?.country) lines.push(`<div class="accard-country">${esc(info.country)}</div>`);
    if (!lines.length) lines.push(`<div class="accard-country">${info && !info.done ? 'looking up the registry…' : info?.done ? 'not in the registry' : ''}</div>`);
    const side = info?.photo ? `<img class="accard-photo" src="${esc(info.photo)}" alt="" onerror="this.remove()">` : '';
    card.innerHTML = `
      <div class="accard-bar">
        <b>${esc(call || a.icao.toUpperCase())}</b><span class="accard-hex">${call ? esc(a.icao.toUpperCase()) : 'no callsign yet'}</span>
        <span class="accard-btns">${a.lat !== undefined ? '<button class="chip" data-acfly title="center the map on it">MAP</button>' : ''}<button class="chip" data-acclose title="close">✕</button></span>
      </div>
      <div class="accard-body">
        <div class="accard-id">${lines.join('')}</div>
        ${side ? `<div class="accard-side">${side}</div>` : ''}
      </div>
      <div class="accard-grid">
        ${['ALTITUDE', 'GROUND SPEED', 'TRACK', 'CLIMB', 'POSITION', 'FROM YOU', 'HEARD', 'FIRST HEARD'].map(k => `<div><span class="k">${k}</span><span class="v" data-f="${k}">—</span></div>`).join('')}
      </div>`;
    qa<HTMLButtonElement>('[data-acclose]', card).forEach(b => b.onclick = () => { state.adsbSel = ''; refreshAdsb(); });
    qa<HTMLButtonElement>('[data-acfly]', card).forEach(b => b.onclick = () => {
      state.adsbView = 'map'; refreshAdsb();
      const p = state.aircraft.find(x => x.icao === state.adsbSel); if (p?.lat !== undefined && p.lon !== undefined) geo?.center(p.lat, p.lon);
    });
  }
  const now = Date.now();
  const set = (k: string, v: string) => { const el = card.querySelector<HTMLElement>(`[data-f="${k}"]`); if (el && el.textContent !== v) el.textContent = v; };
  set('ALTITUDE', a.alt !== undefined ? `${a.alt.toLocaleString()} ft` : '—');
  set('GROUND SPEED', a.gs !== undefined ? `${a.gs} kt` : '—');
  set('TRACK', a.track !== undefined ? `${a.track}°` : '—');
  set('CLIMB', a.vr !== undefined ? `${a.vr > 0 ? '+' : ''}${a.vr} ft/min` : '—');
  set('POSITION', a.lat !== undefined && a.lon !== undefined ? `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` : 'no position yet');
  if (state.home && a.lat !== undefined && a.lon !== undefined) { const d = distanceBearing(state.home.lat, state.home.lon, a.lat, a.lon); set('FROM YOU', `${d.km.toFixed(d.km < 10 ? 1 : 0)} km · ${(d.km * 0.539957).toFixed(0)} nmi · ${Math.round(d.deg)}°`); }
  else set('FROM YOU', state.home ? '—' : 'allow location to see');
  set('HEARD', ageText(now - a.seenMs));
  set('FIRST HEARD', `${ageText(now - a.firstMs)} · ${new Date(a.firstMs).toLocaleTimeString()}`);
}
function refreshHits(): void {
  const el = q('#hits'); const s = state.sweep; if (!el || !s) return;
  const row = lastSweepRow; if (!row.length) return;
  const sorted = Float32Array.from(row).sort(); const floor = sorted[sorted.length >> 1];
  const hits: [number, string][] = [];
  for (let i = 0; i < row.length;) {
    if (row[i] - floor >= state.threshold) {
      let peak = row[i], pi = i, j = i;
      while (j < row.length && row[j] - floor >= state.threshold) { if (row[j] > peak) { peak = row[j]; pi = j; } j++; }
      hits.push([peak - floor, `${((s.start + pi * (lastSweepBinHz || state.sweepRate / 512)) / 1e6).toFixed(4)} MHz  +${(peak - floor).toFixed(0)} dB`]); i = j;
    } else i++;
  }
  hits.sort((a, b) => b[0] - a[0]);
  el.innerHTML = hits.length ? hits.slice(0, 200).map(([, l], i) => `<div class="li tap ${i % 2 ? 'alt' : ''}" data-hit="${l.split(' ')[0]}">${l}</div>`).join('') : '<div class="empty">nothing above the threshold yet</div>';
  qa<HTMLElement>('[data-hit]', el).forEach(d => d.onclick = () => { const mhz = Number(d.dataset.hit); listen(mhz * 1e6, mhz > 87 && mhz < 108 ? 'WFM' : 'NFM'); });
  const r = q('#capr'); if (r) r.textContent = `${hits.length} HITS`;
}
function refreshCapture(): void {
  const b = q('#rec'), info = q('#rec-info'), el = q('#captures');
  if (b) { b.textContent = state.capturing ? '■ STOP' : '● REC'; b.classList.toggle('rec', state.capturing); }
  if (info) info.textContent = state.capturing ? `${(state.captureBytes / 1e6).toFixed(1)} MB · ${state.captureName}` : `${state.rate / 1e6} Msps · ${(state.rate * 2 / 1e6).toFixed(1)} MB/s`;
  if (el) el.innerHTML = state.captures.length ? state.captures.map((f, i) => `<div class="li row2 ${i % 2 ? 'alt' : ''}"><span class="tap" data-dl="${f.name}">${f.name}  ${(f.size / 1e6).toFixed(1)} MB</span><button class="link" data-del="${f.name}">✕</button></div>`).join('') : '<div class="empty">no captures yet</div>';
  qa<HTMLElement>('[data-dl]').forEach(d => d.onclick = () => worker?.postMessage({ type: 'capture', cmd: 'get', name: d.dataset.dl }));
  qa<HTMLElement>('[data-del]').forEach(d => d.onclick = () => worker?.postMessage({ type: 'capture', cmd: 'remove', name: d.dataset.del }));
}
function esc(s: string): string { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }

// ---- worker / audio / radio -----------------------------------------------------------------------------------
function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker('./build/dsp-worker.js', { type: 'module' });
  (window as unknown as { mmFeed: (m: unknown) => void }).mmFeed = (m) => worker!.onmessage!({ data: m } as MessageEvent);   // support hook: inject a worker message
  (window as unknown as { mmWorker: (m: unknown) => void }).mmWorker = (m) => worker!.postMessage(m);                             // support hook: send the worker a message
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    switch (m.type) {
      case 'spectrum':
        // the meter reads the bins before the waterfall takes them
        if (state.app === 'audio') { const db = channelOverNoise(m.bins as Float32Array, m.rangeDb as number); setMeter(db / 40, `+${Math.round(db)} dB over the noise`, state.squelch ? state.squelch / 40 : null); }
        if (pick.armedAt && (launchPicked === false || audioPick)) notePickSpectrum(m.bins as Float32Array, m.rangeDb as number);
        if (scope) { scope.setScale(m.floorDb as number, m.rangeDb as number); scope.push(m.bins as Float32Array); }
        break;
      // a sweep steers its gain from the 'sweep' message instead: see there
      case 'health': lastHealth = m.line; lastLevel = m.levelDb; refreshReadout(); if (state.app !== 'lookingglass' && state.app !== 'search') agcStep(m.rms as number); log(`${state.board || 'HackRF'} ${m.line}`); if (m.audio) log(`audio: peak=${Math.round(m.audioPeak)}/32000 ${m.audioPeak > 2500 ? '— demod producing audio' : '— silent (no modulation / no signal)'}`); break;
      case 'log': log(m.line); break;
      case 'packet': { if (state.app === 'ham') { const s = state.ham.sat; s.packets.unshift(`${new Date().toTimeString().slice(0, 8)} ${m.line as string}`); if (s.packets.length > 100) s.packets.length = 100; const pk = q('#sat-packet-list'); if (pk) pk.innerHTML = s.packets.map((p, i) => `<div class="li ${i % 2 ? 'alt' : ''}">${p}</div>`).join(''); break; }
        const id = state.app ?? 'x', list = (logs[id] ??= []);
        // a repeat that completed a partial page takes the old line's place rather than adding a second
        const was = typeof m.replaces === 'string' ? list.indexOf(m.replaces) : -1;
        if (was >= 0) list.splice(was, 1); else counts[id] = (counts[id] ?? 0) + 1;
        list.unshift(m.line); if (list.length > 300) list.length = 300; refreshList(id); if (id === 'ais') refreshAis(); else if (id === 'aprs') refreshAprs(); break; }
      case 'rds': lastRds = m as typeof lastRds; drawRds(); break;
      case 'hd': lastHd = m as typeof lastHd; console.log('[hd]', JSON.stringify(m)); drawHd(); break;
      case 'same': onSameAlert(m); break;
      case 'table': state.aisTable = m.rows; refreshAis(); break;
      case 'stations': state.aprsStations = m.rows; refreshAprs(); break;
      case 'meters': meters.snap = m as MetersSnap; refreshMeters(); break;
      case 'lora': loraUi.snap = m as LoraSnap; refreshLora(); break;
      case 'trains': trainsUi.snap = m as TrainsSnap; refreshTrains(); break;
      case 'fmTap': (window as unknown as { mmFmTap: unknown }).mmFmTap = { rate: m.rate, samples: m.samples }; log(`fm tap: ${(m.samples as Float32Array).length} samples @ ${m.rate}`); break;
      case 'aircraft': state.aircraft = m.list; state.frames = m.frames; refreshAdsb(); break;
      case 'huntPage': onHuntPage(m); break;
      case 'huntState': onHuntState(m); break;
      case 'tune': tune(m.hz as number); break;
      case 'geoscan': {
        const g = state.psat.pic;
        g.frames = m.frames as number; g.bad = m.bad as number;
        g.high = m.high as number; g.complete = m.complete as boolean; g.fragments = m.fragments as number;
        const jpeg = m.jpeg as Uint8Array | null;
        if (jpeg && jpeg.length) {
          if (g.url) URL.revokeObjectURL(g.url);
          g.url = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
        }
        refreshPacketSats();
        break;
      }
      case 'r433': {
        const r = state.r433;
        const d = m as unknown as HeardDevice;
        const i = r.heard.findIndex(x => x.key === d.key);
        if (i >= 0) r.heard[i] = d; else r.heard.push(d);
        refreshR433();
        break;
      }
      case 'r433stats': {
        state.r433.stats = m as unknown as R433Report;
        refreshR433();
        break;
      }
      case 'r433list': {
        state.r433.protocols = m.protocols as R433Protocol[];
        drawR433();
        break;
      }
      case 'packetsat': {
        const p = state.psat;
        p.frames = m.frames as PacketFrame[]; p.heard = m.heard as number; p.bad = m.bad as number;
        refreshPacketSats();
        break;
      }
      case 'orbcomm': {
        const o = state.orb;
        o.sats = m.sats as OrbcommSat[]; o.frames = m.frames as number; o.packets = m.packets as number;
        o.bad = m.bad as number; o.syncs = m.syncs as number;
        if (o.sel < 0 && o.sats.length) o.sel = o.sats[0].id;
        orbName();
        refreshOrbcomm();
        break;
      }
      case 'voice': {
        const p = state.prowl;
        p.score = m.score as number;
        if (p.score > p.best) p.best = p.score;       // speech has pauses, so judge on its best moment
        p.parts = `band ${(m.band as number).toFixed(2)} · rhythm ${(m.mod as number).toFixed(3)} · swing ${(m.vary as number).toFixed(1)} dB · level ${(m.levelDb as number).toFixed(0)} dB`;
        break;
      }
      case 'sq': if (m.open !== state.sqOpen) { state.sqOpen = m.open; refreshSquelch(); } break;
      case 'signals': if (scope && state.app !== 'lookingglass' && state.app !== 'search') { const c = spanCenter(); lastSignals = m.list as SeenSignal[]; (window as unknown as { mmSignals: SeenSignal[] }).mmSignals = lastSignals; launchAutoPick(); audioAutoPick(); scope.setSignals((m.list as { hz: number; db: number; cls: string; conf: number; val: number }[]).map(s => ({ frac: 0.5 + (s.hz - c) / state.rate, val: s.val, text: `${(s.hz / 1e6).toFixed(3)}${s.cls ? ` ${s.cls}${s.conf < 0.6 ? '?' : ''}` : ''} ${Math.round(s.db)}dB` }))); } break;
      case 'monitor': onMonitor(m); break;
      case 'digi': { const g = state.ham.digi; g.text += m.text as string; if (g.text.length > 4000) g.text = g.text.slice(-3000); const el = q('#digi-text'); if (el) { el.textContent = g.text; el.scrollTop = el.scrollHeight; } break; }
      case 'digiStatus': {
        const g = state.ham.digi;
        g.winner = m.winner as string; g.conf = m.conf as [string, number][]; g.wpm = m.wpm as number;
        const st = q('#digi-status');
        // Only AUTO is a contest between decoders. Once a mode is chosen, the other decoders' scores are noise,
        // and the word rate belongs to CW.
        const conf = g.mode === 'auto' ? g.conf : g.conf.filter(([n]) => n.toLowerCase() === g.mode);
        const wpm = g.wpm && (g.mode === 'auto' || g.mode === 'cw') ? ` · ${g.wpm} WPM` : '';
        const head = g.mode === 'auto' ? (g.winner ? `AUTO → ${g.winner}` : 'AUTO · listening') : g.mode.toUpperCase();
        if (st) st.textContent = head + conf.map(([n, c]) => ` · ${n} ${c}%`).join('') + wpm;
        break;
      }
      case 'ft8': { const g = state.ham.digi; g.ft8.unshift(...(m.list as typeof g.ft8)); if (g.ft8.length > 200) g.ft8.length = 200; refreshFt8(); break; }
      case 'dmr': state.ham.digi.dmr = m.status as DmrStatus; refreshDmr(); break;
      case 'p25': state.ham.digi.p25 = m.status as P25Status; refreshP25(); break;
      case 'sstv': onSstv(m); break;
      case 'apt': onApt(m); break;
      case 'lrpt': onLrpt(m); break;
      case 'lrptStats': onLrptStats(m); break;
      case 'ham': Object.assign(state.ham, { db: m.db, floor: m.floor, open: m.open, tone: m.tone, toneDb: m.toneDb, dcs: m.dcs, dcsInv: m.dcsInv, gain: m.gain, audioPeak: m.audioPeak }); refreshHamMeter(); break;
      case 'sweepProgress': { if (state.sweep) state.sweep.steps = m.steps as number; refreshSweepCard(m.progress, m.sweeps); break; }
      case 'sweepLive': {
        const s = sweepScope; if (!s) break;
        const slice = m.slice as Float32Array, keep = slice.length, steps = m.steps as number;
        if (sweepLiveRow.length !== steps * keep) sweepLiveRow = new Float32Array(steps * keep);
        sweepLiveRow.set(slice, (m.step as number) * keep);
        // Throttle the redraw (and its sort): steps can land many times a second, and one repaint per ~110 ms is
        // smooth to the eye while keeping the cost off a full-range sweep. The completed pass corrects everything.
        const now = performance.now();
        if (now - lastLiveSpec > 110) {
          lastLiveSpec = now;
          const sorted = Float32Array.from(sweepLiveRow).sort();
          s.setScale(sorted[sorted.length >> 1] + 1, 32);
          s.setSpectrum(rowToSpec(typeof m.bins === 'number' ? sweepLiveRow.subarray(0, m.bins as number) : sweepLiveRow, s.cols));
        }
        break;
      }
      case 'sweep': {
        // A sweep's slices take turns being loud and quiet, and the once-a-second health sample lands on whichever
        // is current: steering by it put part of every pass at another gain (dark bands across Looking Glass). So
        // a sweep's gain moves at most once a pass, by its loudest slice, and every slice of a pass shares one gain.
        if (typeof m.peakRms === 'number' && m.peakRms > 0) agcStep(m.peakRms);
        lastSweepRow = m.row; lastSweepBinHz = m.binHz as number;
        if (state.sweep) state.sweep.steps = m.steps as number;
        const s = sweepScope;
        if (s) {
          const sorted = Float32Array.from(m.row as Float32Array).sort();
          s.setScale(sorted[sorted.length >> 1] + 1, 32);
          s.push(rowToSpec(m.row, s.cols)); s.setLabels(rangeLabels(m.startHz, m.endHz, s.cols > 900 ? 7 : 5));
        }
        refreshSweepCard(0, m.sweeps); refreshHits(); break;
      }
      case 'capture': state.capturing = m.recording; state.captureName = m.name; state.captureBytes = m.bytes; refreshCapture(); break;
      case 'captures': state.captures = m.files; refreshCapture(); break;
      case 'captureFile': { const f = m.file as File; const url = URL.createObjectURL(f); const a = document.createElement('a'); a.href = url; a.download = m.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); if (m.sidecar) { const b = new Blob([m.sidecar], { type: 'text/plain' }); const u2 = URL.createObjectURL(b); const a2 = document.createElement('a'); a2.href = u2; a2.download = (m.name as string).replace(/\.c8$/, '.txt'); setTimeout(() => { a2.click(); setTimeout(() => URL.revokeObjectURL(u2), 60_000); }, 500); } break; }
    }
  };
  worker.postMessage({ type: 'config', rate: state.rate, mode: state.mode, squelch: state.squelch, specBins: scope?.cols, centreHz: spanCenter() });
  lastCenterSent = spanCenter();
  if (audioPort) { worker.postMessage({ type: 'audioPort', port: audioPort }, [audioPort]); audioPort = null; }
  return worker;
}

async function ensureAudio(): Promise<void> {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 48_000 });
    await audioCtx.audioWorklet.addModule('./audio-worklet.js');
    const node = new AudioWorkletNode(audioCtx, 'mayhem-player', { outputChannelCount: [1] });
    muteGain = audioCtx.createGain(); muteGain.gain.value = state.muted ? 0 : 1;
    node.connect(muteGain); muteGain.connect(audioCtx.destination);
    const ch = new MessageChannel();
    node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    audioPort = ch.port2;
    if (worker) { worker.postMessage({ type: 'audioPort', port: audioPort }, [audioPort]); audioPort = null; }
  }
  // A browser will not start audio until the page has been interacted with. When the radio comes up on its own
  // at start-up there has been no gesture yet, so a refusal here is expected and must not stop the receiver: the
  // first tap anywhere resumes it.
  // Not awaited. Without a gesture Chrome neither resumes nor refuses: the promise just stays pending until a
  // later resume() runs inside one. Awaited, that parked the radio's start-up behind audio forever, because the
  // listener that makes that later call (armAudioResume) was only set up after this line.
  armAudioResume();
  void audioCtx.resume().catch(() => { /* resumed on the first gesture instead */ });
}
let audioArmed = false;
/**
 * Keep nudging the audio context back awake.
 *
 * This used to be armed only when the context was still asleep at start-up, on the reasoning that a context
 * already running would stay running. Android does not work that way: it suspends audio again whenever the
 * page loses focus, the screen locks, or another app takes audio focus, and nothing brought it back - which is
 * how you end up parked on a clear station hearing nothing, and why visiting another screen and coming back
 * seemed to fix it. Arm it always, and try again on anything that could plausibly be the user returning.
 */
function armAudioResume(): void {
  if (audioArmed) return;
  audioArmed = true;
  const go = () => { if (audioCtx && audioCtx.state !== 'running') void audioCtx.resume(); };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, go, { once: false, passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) go(); });
  addEventListener('focus', go);
}
/** Called from anything that means "the user wants to hear this now". */
function wakeAudio(): void {
  if (audioCtx && audioCtx.state !== 'running') void audioCtx.resume();
}

async function connect(dev?: USBDevice): Promise<void> {
  const btn = $<HTMLButtonElement>('connect');
  if (radio?.running) { radio.stop(); btn.textContent = 'CONNECT'; return; }
  // One bring-up at a time. A second open() on the same device fails, and the loser's cleanup below cleared
  // `radio` out from under the winner: the dongle kept streaming but no app could retune it any more, so every
  // decoder went deaf until you reconnected.
  if (connecting) return;
  connecting = true;
  hideHint();                       // a fresh attempt clears a stale hint from the last one
  try {
    // A device this origin was already granted skips the chooser (and works without a click gesture).
    const d = dev ?? await HackRf.remembered() ?? (RTLSDR_READY ? await RtlSdr.remembered() : undefined)
      ?? await navigator.usb.requestDevice({ filters: [...HACKRF_FILTERS, ...(RTLSDR_READY ? RTLSDR_FILTERS : [])] });
    if (isMayhemSerial(d)) {
      log('That is a PortaPack in Mayhem serial mode.');
      setStatus('PortaPack in Mayhem mode — switching…', false);
      if (!(await portapackToHackRf(d))) { setStatus('PortaPack in serial mode — tap HackRF on its screen', false); showHint(new Error('PortaPack in Mayhem mode. CONNECT could not switch it. On the PortaPack, choose HackRF mode.')); }
      return;
    }
    await ensureAudio();
    const w = ensureWorker();
    const events = {
      onIq: (buf: Int8Array) => w.postMessage({ type: 'iq', buf: buf.buffer }, [buf.buffer]),
      onLog: log,
    };
    if (isRtlSdr(d)) {
      if (!RTLSDR_READY) {
        // Reachable when a dongle was granted to this origin before support was switched off.
        log('RTL-SDR support is switched off: the driver brings the dongle up but hears almost nothing, and the input routing is still being chased. Use a HackRF for now.');
        setStatus('RTL-SDR support is not ready yet', false);
        return;
      }
      await connectRtl(d, events); return;
    }
    const r = new HackRf(d, {
      ...events,
      onStatus: s => {
        ackTune(s);
        const newBoard = state.board !== r.board;
        state.board = r.board; state.firmware = r.firmware; setStatus(s, true);
        if (!state.app) $('sub').textContent = `HackRF · ${r.board} · ${r.firmware}`;
        // The board is only known after bring-up: re-scale the One-flavoured gains once for a Pro.
        if (newBoard && isPro() && !state.gainsScaled) {
          const pref = currentGainPref();
          const [l, v, a] = pref ? [pref.lna, pref.vga, pref.amp] as [number, number, boolean] : boardGains(state.lna, state.vga, state.amp);
          setAgc(pref ? pref.agc : true);
          state.gainsScaled = true; setGains(l, v, a);
          log(`HackRF Pro: gains LNA ${l} / VGA ${v}${a ? ' / amp' : ''} (${pref ? 'your saved Pro gain' : 'scaled up: One presets sit under 1 ADC count on a Pro'})`);
        }
      },
    });
    r.targetFreqHz = state.freq; r.targetRateHz = state.rate; r.setGain(state.lna, state.vga, state.amp);
    radio = r; radioDev = d;
    refreshLauncherLimits();
    applyLauncherView();          // now we know how wide it can go, show the whole band rather than a slice
    await r.open();
    btn.textContent = 'DISCONNECT';
    hideHint();                     // claimed — any "device busy / not found" hint is now stale
    await r.run();
  } catch (e) {
    const err = e as Error;
    log(`connect failed: ${err.message}`);
    setStatus(err.name === 'NotFoundError' ? 'no device chosen' : `error: ${err.message}`, false);
    showHint(err);
  } finally {
    connecting = false;
    btn.textContent = 'CONNECT';
    setStatus(state.board ? `${state.board} disconnected` : 'disconnected', false);
    radio = null; radioDev = null;
    refreshLauncherLimits();
  }
}

/**
 * Bring up an RTL-SDR.
 *
 * Separate from the HackRF path because almost nothing it needs to say is the same: no board id, no firmware
 * string, no PortaPack, no gain rescaling, and a rate that has to be pulled inside what the dongle will do
 * before the first buffer rather than after.
 */
async function connectRtl(d: USBDevice, events: { onIq: (b: Int8Array) => void; onLog: (l: string) => void }): Promise<void> {
  const btn = $<HTMLButtonElement>('connect');
  const r = new RtlSdr(d, {
    ...events,
    onStatus: s => { ackTune(s); state.board = r.label; state.firmware = r.tuner; setStatus(s, true); if (!state.app) $('sub').textContent = r.label; },
  });
  r.targetFreqHz = state.freq;
  r.targetRateHz = nearestRate(r.limits, state.rate);
  r.setGain(state.lna, state.vga, state.amp);
  state.biast = false;   // the dongle powers up with the bias tee off; keep the UI honest
  radio = r; radioDev = d;
  refreshLauncherLimits();
  applyLauncherView();
  if (r.targetRateHz !== state.rate) { state.rate = r.targetRateHz; worker?.postMessage({ type: 'config', rate: state.rate }); refreshReadout(); }
  await r.open();
  btn.textContent = 'DISCONNECT';
  hideHint();                       // claimed — clear any stale connect hint
  await r.run();
}

/** Platform-specific help when WebUSB can't see or claim the HackRF. */
function platform(): 'windows' | 'mac' | 'linux' | 'android' | 'other' {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|CrOS/i.test(ua)) return 'linux';
  return 'other';
}
function showHint(err: Error): void {
  const os = platform();
  const box = $('hint');
  const notListed = err.name === 'NotFoundError';
  const busy = /claim|access denied|busy|in use|failed to open/i.test(err.message) || err.name === 'NetworkError' || err.name === 'SecurityError';
  let text = '';
  if (notListed) {
    text = 'The chooser showed no HackRF or RTL-SDR. Check the USB cable carries data, then: ';
    if (os === 'windows') text += 'on Windows the radio must be bound to the WinUSB driver — run Zadig, pick "HackRF One" (or for an RTL-SDR the "Bulk-In, Interface (Interface 0)" entry), choose WinUSB, Replace Driver (a libusbK or libusb-win32 binding hides it from the browser).';
    else if (os === 'linux') text += 'on Linux add the udev rule the hackrf package ships (53-hackrf.rules) or run the browser as a user in the plugdev group, then replug.';
    else if (os === 'mac') text += 'on macOS nothing needs installing — try another cable or port, and make sure a PortaPack is in HackRF mode, not Mayhem serial mode.';
    else if (os === 'android') text += 'on Android use a data-capable OTG cable or a powered OTG hub; a PortaPack must be in HackRF mode.';
    else text += 'make sure a PortaPack is in HackRF mode.';
  } else if (busy) {
    text = `Could not claim the HackRF (${err.message}). Another program probably has it open — close SDR++, SDRangel, GQRX, hackrf_transfer or a second browser tab, then reconnect.`;
    if (os === 'windows') text += ' On Windows also confirm the WinUSB driver binding (Zadig).';
  } else return;
  box.textContent = text;
  box.hidden = false;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = window.setTimeout(hideHint, 15_000);
}
let hintTimer = 0;
/** Clear the connect hint: on its own 15 s timer, when the user taps it away, or the moment a radio is actually
 *  claimed — the "device busy / nothing in the chooser" condition it warned about is gone by then. */
function hideHint(): void {
  const b = q('#hint'); if (b) b.hidden = true;
  if (hintTimer) { clearTimeout(hintTimer); hintTimer = 0; }
}

// ---- keyboard + wheel (desktop) --------------------------------------------------------------------------------
const STEPS = [1e6, 1e5, 1e4, 1e3];
let stepIdx = 1;
/**
 * Edge glows on anything that scrolls further than it shows. Every scroller gets four zero-size sticky children
 * (left / right / top / bottom) whose ::after paints an accent glow over the clipped edge; classes on the scroller
 * say which edges have more behind them. Re-armed whenever the view re-renders (MutationObserver) and on scroll.
 */
function scrollHints(): void {
  const SEL = '.bandstrip, .launch-side, .controls, .list, .imgwrap';
  const update = (el: HTMLElement) => {
    const h = el.scrollWidth - el.clientWidth > 4, v = el.scrollHeight - el.clientHeight > 4;
    el.classList.toggle('sh-can-l', h && el.scrollLeft > 2);
    el.classList.toggle('sh-can-r', h && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    el.classList.toggle('sh-can-t', v && el.scrollTop > 2);
    el.classList.toggle('sh-can-b', v && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };
  const arm = () => {
    for (const el of qa<HTMLElement>(SEL)) {
      let hints = el.querySelectorAll<HTMLElement>(':scope > .sh');
      if (hints.length !== 4) {
        hints.forEach(h => h.remove());
        for (const k of ['l', 't', 'r', 'b']) { const i = document.createElement('i'); i.className = `sh sh-${k}`; if (k === 'l' || k === 't') el.prepend(i); else el.append(i); }
      } else {
        // the trailing hints must stay last so `bottom: 0` / `right: 0` stick to the far edge
        const r = el.querySelector<HTMLElement>(':scope > .sh-r')!, b = el.querySelector<HTMLElement>(':scope > .sh-b')!;
        if (b !== el.lastElementChild || r !== b.previousElementSibling) { el.append(r); el.append(b); }
      }
      update(el);
    }
  };
  // re-arm synchronously (the observer runs before the next paint), so a list that just re-rendered never shows a
  // frame without its glow — that gap read as flicker
  let arming = false;
  const rearm = () => { if (arming) return; arming = true; try { arm(); } finally { arming = false; } };
  new MutationObserver(rearm).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', rearm);
  document.addEventListener('scroll', (e) => { const el = e.target as HTMLElement; if (el instanceof HTMLElement && el.matches(SEL)) update(el); }, true);
  arm();
}
function bindDesktop(): void {
  window.addEventListener('keydown', (e) => {
    // Any field you type into keeps its keys: a textarea or select passing a 'c' through would toggle CONNECT and
    // drop the radio mid-session.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const tunable = !state.app || state.app === 'audio' || state.app === 'capture' || state.app === 'pager' || state.app === 'aprs' || state.app === 'ais' || state.app === 'ert' || state.app === 'lora' || state.app === 'acars' || state.app === 'tpms' || state.app === 'subghz' || state.app === 'devices';
    // start typing a number (or F) to key in a frequency; a focused readout digit already took its own keystroke
    if ((tunable || state.app === 'ham') && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.,fF]$/.test(e.key)) {
      freqEntry(/[fF]/.test(e.key) ? '' : e.key); e.preventDefault(); return;
    }
    switch (e.key) {
      case 'ArrowLeft': if (tunable) { tune(state.freq - STEPS[stepIdx]); e.preventDefault(); } break;
      case 'ArrowRight': if (tunable) { tune(state.freq + STEPS[stepIdx]); e.preventDefault(); } break;
      case 'ArrowUp': stepIdx = Math.max(0, stepIdx - 1); log(`tune step ${STEPS[stepIdx] / 1e6} MHz`); e.preventDefault(); break;
      case 'ArrowDown': stepIdx = Math.min(STEPS.length - 1, stepIdx + 1); log(`tune step ${STEPS[stepIdx] / 1e6} MHz`); e.preventDefault(); break;
      case 'm': case 'M': if (state.app === 'audio') { const modes: Mode[] = ['WFM', 'NFM', 'AM', 'USB', 'LSB']; setMode(modes[(modes.indexOf(state.mode) + 1) % modes.length]); } break;
      case 'a': case 'A': setGains(state.lna, state.vga, !state.amp); break;
      case '[': manualGains(state.lna - 8, state.vga, state.amp); break; case ']': manualGains(state.lna + 8, state.vga, state.amp); break;
      case '-': case '_': manualGains(state.lna, state.vga - 2, state.amp); break; case '=': case '+': manualGains(state.lna, state.vga + 2, state.amp); break;
      case 'g': case 'G': setAgc(!state.agc); break;
      case 's': case 'S': if (state.app === 'audio') setSquelch([0, 6, 12, 20][([0, 6, 12, 20].indexOf(state.squelch) + 1) % 4]); break;
      case 'b': case 'B': if (state.app === 'audio') addBookmark(); break;
      case ' ': if (state.app === 'audio') { setScanning(!state.scanning); e.preventDefault(); } break;
      case 'l': case 'L': $('log-toggle').click(); break;
      case 'x': case 'X': toggleMute(); break;
      case 'Escape': if (settingsOpen()) closeSettings(); else if (adsbFull && state.app === 'adsb') setAdsbFull(false); else if (meters.full && state.app === 'ert') setMetersFull(false); else if (loraUi.full && state.app === 'lora') setLoraFull(false); else if (state.app) open(null); break;
    }
  });
  // chip strips and lists scroll with a held mouse button (touch already pans natively); a real drag swallows the click
  let drag: { el: HTMLElement; x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const el = (e.target as HTMLElement).closest?.('.bandstrip, .list, .imgwrap, .digitext') as HTMLElement | null;
    if (!el || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return;
    drag = { el, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true; drag.el.classList.add('dragging');
    drag.el.scrollLeft = drag.left - dx; drag.el.scrollTop = drag.top - dy;
  });
  const endDrag = () => { if (!drag) return; const d = drag; drag = null; if (d.moved) { setTimeout(() => d.el.classList.remove('dragging'), 0); } };
  document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
  document.addEventListener('click', (e) => { const el = (e.target as HTMLElement).closest?.('.dragging'); if (el) { e.stopPropagation(); e.preventDefault(); } }, true);
  // frequency digits: wheel, click / tap (top half up, bottom half down), arrow keys on a focused digit
  document.addEventListener('click', (e) => {
    const d = (e.target as HTMLElement).closest?.('.fd') as HTMLElement | null; if (!d) return;
    const r = d.getBoundingClientRect();
    nudgeDigit(d, e.clientY < r.top + r.height / 2 ? 1 : -1);
  });
  document.addEventListener('keydown', (e) => {
    const d = document.activeElement as HTMLElement | null;
    if (!d?.classList.contains('fd')) return;
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { nudgeDigit(d, 1); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') { nudgeDigit(d, -1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const ds = qa<HTMLElement>('#freq .fd'); const i = ds.indexOf(d); const n = ds[i + (e.key === 'ArrowLeft' ? -1 : 1)]; if (n) n.focus(); e.preventDefault(); }
    else if (/^[0-9]$/.test(e.key)) { const w = Number(d.dataset.w); const cur = Math.floor(state.freq / w) % 10; tune(state.freq + (Number(e.key) - cur) * w); const ds = qa<HTMLElement>('#freq .fd'); ds[ds.indexOf(d) + 1]?.focus(); e.preventDefault(); }
  });
  // mouse wheel over a digit steps that digit; over any scope it tunes in the current step (ctrl+wheel changes the step)
  window.addEventListener('wheel', (e) => {
    const t = e.target as HTMLElement;
    const d = t.closest?.('.fd') as HTMLElement | null;
    if (d) { e.preventDefault(); nudgeDigit(d, e.deltaY < 0 ? 1 : -1); return; }
    if (!t.closest?.('.scope') || state.app === 'lookingglass' || state.app === 'search' || state.app === 'adsb' || state.app === 'btle') return;
    if (e.ctrlKey || e.metaKey) return;                                   // the scope zooms on ctrl+wheel
    e.preventDefault();
    if (e.altKey) { stepIdx = e.deltaY > 0 ? Math.min(STEPS.length - 1, stepIdx + 1) : Math.max(0, stepIdx - 1); return; }
    scope?.holdView();
    wheelAcc += e.deltaY;
    const notches = Math.trunc(wheelAcc / 100); if (!notches) return;
    wheelAcc -= notches * 100;
    const step = wheelStep(), raster = rasterStep(), cur = state.app === 'ham' ? state.ham.freq : state.freq;
    tune(Math.round((cur - notches * (e.shiftKey ? 10 : 1) * step) / raster) * raster);   // one filter width per notch, on the raster
  }, { passive: false });
}

// ---- boot -----------------------------------------------------------------------------------------------------
let versionText = 'dev build', apkUrl = './mayhem.apk', releaseUrl = 'https://github.com/RocketGod-git/mayhem-mobile/releases/tag/latest';

// ---- the phone shell: the Android app's bars ---------------------------------------------------------------------
/** The app bar's order, the native apps' default: by what they do (receive, analyze, transmit, tools), as Home lists them. */
const barApps = (): AppId[] => (['Receive', 'Analyze', 'Transmit', 'Tools'] as const).flatMap(c => APPS.filter(a => a.cat === c && a.id !== 'settings').map(a => a.id));
const BAR_LABEL: Partial<Record<AppId, string>> = { lookingglass: 'GLASS', sat: 'SATS', subghz: 'SUB-GHZ', btle: 'BLE', transmit: 'TX' };
const barLabel = (id: AppId) => BAR_LABEL[id] ?? APPS.find(a => a.id === id)!.title.toUpperCase();
/** A wide screen (tablet or desktop): Home lays the waterfall over one sideways row of app tiles, as on iPad. */
const wideShell = matchMedia('(min-width: 720px)');
/** Where "home" is: the launcher at every width, as in the native apps. */
const homeApp = (): AppId | null => null;
/**
 * The apps bar, the native apps' strip at every width: a gear, then each app's glyph and short name in the bar's
 * order, the open one lit in its group's color, the blurb on hover.
 */
function buildBar(): void {
  const bar = $('appbar-in');
  const btn = (id: AppId) => { const a = APPS.find(x => x.id === id)!; return `<button data-bar="${id}" style="--seg:${tint(a.cat)}" title="${esc(a.title)} · ${esc(a.blurb)}"><span class="ag">${glyph(id, 'currentColor', 24)}</span><span class="al">${barLabel(id)}</span></button>`; };
  // phone: the keys sit in a hairline pill behind one fill that slides to the open app (see placeFill)
  bar.innerHTML = '<i class="afill"></i>' + barApps().map(btn).join('');
  fillPlaced = false;
  qa<HTMLButtonElement>('[data-bar]', bar).forEach(b => b.onclick = () => {
    const id = b.dataset.bar as AppId;
    closeSettings();
    if (state.app !== id) open(id);
  });
  refreshShell();
}
function initShell(): void {
  buildBar();
  // Home's layout follows the width (a waterfall over a tile row when wide, the phone's grid when narrow)
  wideShell.addEventListener('change', () => { if (state.app === null) open(null); });
  bindHs($('appbar').parentElement!);
  $('nav-home').onclick = () => { closeSettings(); if (state.app) open(null); };
  $('nav-settings').onclick = () => (settingsOpen() ? closeSettings() : openSettings());
  $('bar-gear').onclick = () => (settingsOpen() ? closeSettings() : openSettings());
  new ResizeObserver(() => placeFill(false)).observe($('appbar-in'));
  $('set-close').onclick = closeSettings;
  $('setmodal').onclick = (e) => { if (e.target === $('setmodal')) closeSettings(); };
  $('nav-mute').onclick = toggleMute;
  $('nav-faves').onclick = () => showFaves(true);
  $('faves-done').onclick = () => showFaves(false);
  $('faves').onclick = (e) => { if (e.target === $('faves')) showFaves(false); };
  $('rm-connect').onclick = () => $('connect').click();
  refreshShell();
}
/** Each app's card tag and title (the Android app's). */
const CARD_TITLE: Partial<Record<AppId, [string, string]>> = {
  pager: ['PAGER', 'FLEX · POCSAG'], tpms: ['TPMS', 'TIRE SENSORS'], acars: ['ACARS', 'AIRCRAFT DATALINK'], trains: ['TRAINS', 'EOT · PTC'], subghz: ['SUB-GHZ', 'SENSORS · REMOTES · KEYS'],
  ert: ['METERS', 'ERT · MESH · GRIDSTREAM'], lora: ['LORA', 'MESHTASTIC · MESHCORE · LORAWAN'], btle: ['BLE', 'ADVERTISING'], adsb: ['ADS-B', '1090 MHZ AIRCRAFT'], ais: ['AIS', 'SHIPS'], aprs: ['APRS', 'PACKET STATIONS'],
  devices: ['DEVICES', 'SENSORS · METERS · REMOTES'], capture: ['CAPTURE', 'RAW IQ TO FILE'], prowl: ['PROWL', 'HUNTING FOR VOICE'], lookingglass: ['GLASS', 'WIDEBAND SWEEP'],
  search: ['SEARCH', 'ACTIVE FREQUENCIES'], transmit: ['TX', 'IDLE'], troll: ['TROLL', 'IDLE'],
};
/** The app Settings was opened over: its rows lead the page, and it keeps running underneath. */
let settingsOver: AppId | null = null;
const settingsOpen = () => !$('setmodal').hidden;
/** Settings over the running app, which keeps receiving underneath; DONE, Esc or a click outside closes it. */
function openSettings(): void {
  settingsOver = state.app;
  $('setmodal').hidden = false;
  $('set-over').textContent = state.app ? `· ${barLabel(state.app)}` : '';
  drawSettings();
  refreshShell();
}
function closeSettings(): void {
  if (!settingsOpen()) return;
  $('setmodal').hidden = true; $('setview').innerHTML = '';
  refreshShell();
}
function drawSettings(): void {
  const view = $('setview'), top = view.scrollTop;
  renderSettings(view); wireCommon(view); bindHs(view);
  setGains(state.lna, state.vga, state.amp);
  view.scrollTop = top;
}
/** A setting changed: redraw the overlay in place. */
function refreshSettings(): void { if (settingsOpen()) drawSettings(); }
/** The phone strip's fill has been put somewhere yet (the first placing jumps; later ones slide). */
let fillPlaced = false;
/** Move the phone strip's fill under the open app's key, sliding there when [slide]; on Home it fades away. */
function placeFill(slide: boolean): void {
  const fill = q<HTMLElement>('#appbar-in .afill'); if (!fill) return;
  const on = q<HTMLElement>(`#appbar-in [data-bar="${state.app}"]`);
  if (!on || !on.offsetWidth) { fill.classList.remove('show'); fillPlaced = false; return; }
  fill.classList.toggle('slide', slide && fillPlaced);
  fill.style.setProperty('--seg', on.style.getPropertyValue('--seg'));
  fill.style.left = `${on.offsetLeft}px`; fill.style.width = `${on.offsetWidth}px`;
  fill.classList.add('show'); fillPlaced = true;
}
/** The app the bar was last scrolled to, so a refresh does not undo the user's own scrolling. */
let barCentered: AppId | null | undefined;
function refreshShell(): void {
  const here = state.app, setOn = settingsOpen();
  qa<HTMLButtonElement>('[data-bar]').forEach(b => {
    const id = b.dataset.bar as AppId;
    b.classList.toggle('on', id === here);
    b.classList.toggle('dim', !!radio && !!blockedBecause(APP_NEEDS[id], radio.limits));
  });
  // bring the app you are on into view only when it changes: this runs on every status update, and re-centering
  // each time snapped the strip back as soon as you slid it to look for another app
  const on = q<HTMLElement>(`[data-bar="${here}"]`), bar = $('appbar-in');
  if (on && here !== barCentered) { barCentered = here; bar.scrollTo({ left: on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2, behavior: 'smooth' }); }
  placeFill(true);
  $('nav-home').classList.toggle('on', state.app === null && !setOn);
  $('nav-settings').classList.toggle('on', setOn);
  $('home').classList.toggle('on', state.app === null && !setOn);
  $('settings-btn').classList.toggle('on', setOn);
  $('mute').classList.toggle('muted', state.muted);
  $('mute').querySelector('span')!.textContent = state.muted ? 'MUTED' : 'MUTE';
  $('nav-mute').classList.toggle('muted', state.muted);
  $('nav-mute-t').textContent = state.muted ? 'MUTED' : 'MUTE';
  $('nav-mute-ico').setAttribute('d', state.muted
    ? 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z'
    : 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z');
  $('mute-ico').setAttribute('d', $('nav-mute-ico').getAttribute('d')!);
  $('nav-dot').classList.toggle('on', state.connected);
  const act = (a: string) => q<HTMLElement>(`[data-act="${a}"]`);
  act('settings')?.classList.toggle('on', setOn);
  act('settings')?.querySelector('.adot')?.classList.toggle('on', state.connected);
  act('log')?.classList.toggle('on', !$('log-panel').hidden);
  const mu = act('mute');
  if (mu) {
    mu.classList.toggle('muted', state.muted);
    mu.querySelector('.al')!.textContent = state.muted ? 'MUTED' : 'MUTE';
    mu.querySelector('path')?.setAttribute('d', $('nav-mute-ico').getAttribute('d')!);
  }
  $('radiomiss').hidden = state.connected;
}
/** FAVES: the frequencies starred with ☆. A tap brings one back in its own app, as it was heard. */
function showFaves(open: boolean): void {
  const sh = $('faves'); sh.hidden = !open; if (!open) return;
  const list = $('faves-list');
  list.innerHTML = bookmarks.length ? bookmarks.map((b, i) => `<div class="fav-row" data-fv="${i}"><div><b>${(b.hz / 1e6).toFixed(4)} MHz</b><small>${esc(b.name)} · ${b.app ? barLabel(b.app) : b.mode}</small></div><button class="x" data-fvx="${i}">✕</button></div>`).join('')
    : '<div class="empty">No FAVES yet. Tune something and tap ☆ beside the frequency.</div>';
  qa<HTMLElement>('[data-fv]', list).forEach(r => r.onclick = (e) => {
    const i = Number(r.dataset.fv);
    if ((e.target as HTMLElement).dataset.fvx !== undefined) { removeBookmark(i); showFaves(true); return; }
    showFaves(false); openBookmark(bookmarks[i]);
  });
}

function init(): void {
  loadSkin();
  const supported = 'usb' in navigator;
  $('unsupported').hidden = supported;
  $<HTMLButtonElement>('connect').disabled = !supported;
  if (!supported) setStatus('WebUSB not available in this browser', false);
  $('connect').onclick = () => connect();
  $('mute').onclick = toggleMute;
  $('home').onclick = () => { closeSettings(); if (state.app) open(null); };
  $('brand').onclick = () => { closeSettings(); if (state.app) open(null); };
  $('faves-btn').onclick = () => showFaves(true);
  $('settings-btn').onclick = () => (settingsOpen() ? closeSettings() : openSettings());
  initShell();
  $('hint').onclick = () => hideHint();
  bindDesktop();
  scrollHints();
  const panel = $('log-panel'), body = $('log');
  const refreshLog = () => { $('log-head').textContent = logHeader(); body.textContent = diag.join('\n'); if (logFollow) body.scrollTop = body.scrollHeight; };
  $('log-toggle').onclick = () => { panel.hidden = !panel.hidden; $('log-toggle').classList.toggle('on', !panel.hidden); if (!panel.hidden) refreshLog(); };
  $('log-close').onclick = () => { panel.hidden = true; $('log-toggle').classList.remove('on'); refreshShell(); };
  $('log-clear').onclick = () => { diag.length = 0; refreshLog(); };
  $('log-pip').onclick = () => {
    const pip = panel.classList.toggle('pip');
    $('log-pip').textContent = pip ? 'FULL' : 'PIP';
    if (pip) { panel.style.left = '12px'; panel.style.top = '12px'; } else { panel.style.left = panel.style.top = ''; }
  };
  // Auto-follow the tail, but stop the moment the reader scrolls away from the bottom.
  body.addEventListener('scroll', () => { logFollow = body.scrollTop + body.clientHeight >= body.scrollHeight - 4; });
  $('log-save').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
    a.download = `mayhem-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('log-share').onclick = async () => {
    const file = new File([logText()], 'mayhem.log', { type: 'text/plain' });
    // Only some browsers can share a file; the rest get the text, and failing that the clipboard.
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Mayhem Mobile log' }); return; }
      if (navigator.share) { await navigator.share({ title: 'Mayhem Mobile log', text: logText().slice(0, 4000) }); return; }
      await navigator.clipboard.writeText(logText()); log('log copied to the clipboard');
    } catch { /* the user dismissed the sheet */ }
  };
  // Drag the window by its bar. Pointer events cover mouse and touch with one path.
  let dragging = false, dx = 0, dy = 0;
  const bar = $('log-bar');
  bar.addEventListener('pointerdown', e => {
    if (!panel.classList.contains('pip')) return;
    dragging = true; bar.setPointerCapture(e.pointerId);
    dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop;
  });
  bar.addEventListener('pointermove', e => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, Math.min(innerWidth - panel.offsetWidth, e.clientX - dx))}px`;
    panel.style.top = `${Math.max(0, Math.min(innerHeight - panel.offsetHeight, e.clientY - dy))}px`;
  });
  bar.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('popstate', () => { if (state.app) open(null); });
  window.addEventListener('resize', () => { scope?.draw(); sweepScope?.draw(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e as Event & { prompt: () => Promise<void> }; });
  fetch('./version.json', { cache: 'no-store' }).then(r => r.json()).then((v: { version: string; commit: string; apk: string; release: string }) => {
    versionText = `v${v.version} · ${v.commit}`; apkUrl = v.apk; releaseUrl = v.release;
    const ve = q('#version'); if (ve) ve.textContent = versionText;
    const a = q<HTMLAnchorElement>('#apk'); if (a) a.href = apkUrl;
    const rl = q<HTMLAnchorElement>('#release-link'); if (rl) rl.href = releaseUrl;
  }).catch(() => undefined);
  // Not `render(null)`: the launcher needs the same configuration going Home gives it. Rendering alone left
  // the first view with whatever the defaults happened to be - mode WFM and a span centre of zero - so the
  // frequency picker computed its taps against nothing and appeared not to work until you had entered an app
  // and come back.
  open(homeApp());
  if (supported) {
    // Already granted to this origin: open it without waiting to be asked. WebUSB allows that for a device the
    // user has permitted before, so the receiver is running by the time the page has finished settling.
    (async () => await HackRf.remembered() ?? (RTLSDR_READY ? await RtlSdr.remembered() : undefined))().then(d => {
      if (!d || radio) return;
      const what = isRtlSdr(d) ? 'RTL-SDR' : 'HackRF';
      setStatus(`${what} remembered — connecting…`, false);
      void connect(d).catch(() => setStatus(`${what} remembered — tap CONNECT`, false));
    }).catch(() => undefined);
    navigator.usb.addEventListener('connect', (e) => { log(`USB attached: ${e.device.productName ?? ''}`); if (!radio) setStatus(`${isRtlSdr(e.device) ? 'RTL-SDR' : 'HackRF'} attached — tap CONNECT`, false); });
    // Only the radio leaving stops the radio. Any USB device detaching used to end the session - a phone on charge,
    // a hub dropping a port - which looked like the SDR disconnecting by itself.
    navigator.usb.addEventListener('disconnect', (e) => { log(`USB detached: ${e.device.productName ?? ''}`); if (e.device === radioDev) radio?.stop(); });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  log('Mayhem Mobile web ready');
}

init();
