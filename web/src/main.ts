/** Mayhem Mobile — web. Launcher, screens, WebUSB radio, DSP worker, audio, skins. */
import { openKeypad, FREQ_UNITS, freqAuto } from './keypad.js';
import { BB_FILTER_BW, HackRf, HACKRF_FILTERS, isHackRf, isMayhemSerial, MAYHEM_SERIAL_FILTER } from './hackrf.js';
import { RTL_MAX_GAIN_DB, RTLSDR_FILTERS, RTLSDR_READY, RtlSdr, isRtlSdr } from './rtlsdr.js';
import { APP_NEEDS, RATE_CHOICES, blockedBecause, canSample, canTune, cleanWidest, nearestRate, whyNot, type Radio } from './radio.js';
import type { DmrStatus } from './dsp/ham/dmr.js';
import type { P25Status } from './dsp/ham/p25.js';
import { lookupCall, offlineInfo, latLonToGrid, gridToLatLon, distanceBearing, toAdif, fromAdif, bandOfHz, parseCall, type Qso, type CallInfo } from './callsign.js';
import { SKINS, applySkin, currentSkin, loadSkin } from './theme.js';
import { glyph } from './glyphs.js';
import { Scope, centredLabels, rangeLabels, rowToSpec } from './scope.js';
import { btleChannelFreq } from './dsp/btle.js';
import { BleTracker, KIND_LABEL, parseAdv, type BleDevice } from './ble.js';
import { AcarsPlanes, labelMeaning, normReg, parseAcarsLine, type AcarsMsg } from './acars-planes.js';
import { AcarsStats, Vdl2Tracker, VDL2_CHANNELS, acarsFor, airlineOf, kindLabelOf, msgInsight, numChips, planeInsight, xidSummary, type Airport, type AvlcFrame, type MsgInsight, type PlaneInsight, type VdlAircraft, type VdlStation } from './acars-insight.js';
import { ORBCOMM_CHANNELS, type OrbcommSat } from './dsp/orbcomm.js';
import type { PacketFrame } from './dsp/g3ruh.js';
import { fetchGroup } from './sat.js';
import { PACKET_SATS } from './packet-sats.js';
import { GEOSCAN_SATS } from './dsp/geoscan.js';
import type { HeardDevice, R433Data, R433Protocol, R433Report } from './dsp/r433/index.js';
import type { ZwLink, ZwNode } from './dsp/r433/zwave.js';
import { CREDITS } from './credits.js';
import { AnalyzerUi } from './analyzer-ui.js';
import { SpectrumUi } from './spectrum-ui.js';
import type { Burst } from './dsp/analyzer/capture.js';
import { Tx, type SigMode } from './tx.js';
import * as Apps from './tx-apps.js';
import type { Aircraft } from './dsp/adsb.js';
import type { Vessel } from './dsp/ais.js';
import type { AprsStation } from './dsp/aprs.js';
import { aprsSymbolName } from './aprs-info.js';
import { FleetAuto, type AutoSaved } from './dsp/fleet/auto.js';
import { secText, SEC_FROM, posText, onAirOrder, nowPlaying, callWho, unnamedQuiet, trackStats, sparkSvg, tgTiles, followTap, listenText, activityBuckets, encShare, agoShort, distBearing as flDistBearing, distText } from './dsp/fleet/view.js';
import type { FleetSnap, CallRow as FleetCall, Lock as DispatchLock, TgPrefs, UnitReport as FleetUnitReport, SystemRow as FleetSystem, SiteRow as FleetSite, CarrierRow as FleetCarrier, GrantRow as FleetGrant } from './dsp/fleet/fleet.js';
import type { Iden as FleetIden } from './dsp/fleet/tsbk.js';
import { renderJs8, js8Dial, js8SetDial, js8Speeds, js8OnDecodes, js8OnWaterfall, refreshJs8, type Js8Host } from './js8-ui.js';
import type { Js8Decode } from './dsp/js8/decoder.js';
import type { Js8Speed } from './dsp/js8/modes.js';
import { GeoMap, type GeoItem, type RadarCell, type GeoShape, type GeoImage, mapStart, saveLastPos, lastKnownPos, zoneGuess } from './geomap.js';
import type { StationSnap, ProgramRow } from './dsp/hd/station.js';
import { hdChannelLevels, hdLookPlan, hdMergeLevels, hdStrongStations, hdStrongest, hdVisitOrder, hdWindows, HD_REST_MS, type HdLookPlan } from './hdscan.js';
import { parseTrafficInfo, parseRadarInfo, tileBounds, trafficTile, radarImage, type TrafficInfo, type RadarInfo } from './dsp/hd/lot.js';
import { programTypeName, dataTypeName, locationValid, clockCheck, localTimeHint, utcOffsetText, BLEND_NAMES, type SisSummary } from './dsp/hd/sis.js';
import type { AtscSnap, StationRow as AtscStation, SubRow as AtscSub, EventRec as AtscEvent, LiveSignal as AtscLive } from './dsp/atsc/atsc.js';
import { CHANNELS as ATSC_CHANNELS, centerOf, pilotOf } from './dsp/atsc/channels.js';
import { hubSites, hubSondes, nextLaunchMs, type HubSite, type HubSonde } from './sondehub.js';
import { productsOf, radarBlocks, textOf, parseMetar, stationOf, hazardBlocks, icingOf, overlayOf, suaOf, type Metar, type RadarBlock, type HazardBlock, type Overlay } from './dsp/uat/fisb.js';
import { decodeDownlink, type UatTarget } from './dsp/uat/traffic.js';
import { mmsiInfo, shipTypeName, navStatusName, atonTypeName } from './ais-info.js';
import { BANDS, NON_HAM, bandOf, segmentOf, repeaterInput } from './bands.js';
import { BANDS as LORA_BANDS } from './dsp/lora/plan.js';
import { LoraLocal } from './dsp/lora/local.js';
import { SONDE_BANDS, SONDE_WIDE, SONDE_NARROW, wideCenter as sondeWideCenter, narrowWindows as sondeWindows, type SondeChannelRow } from './dsp/sonde/front.js';
import type { SondeRow } from './dsp/sonde/track.js';
import type { HamMode, AgcMode } from './dsp/ham/demod.js';
import { SATS, Sgp4, look, doppler, passes, fetchTles, type Tle, type Pass, dopplerUp, type SatService } from './sat.js';
import { ISM_COUNTS } from './dsp/ism/counts.js';
import type { CellSnap, CellRow, SibRec as CellSibRec } from './dsp/cell/cell.js';
import type { FeedRow as CellFeedRow } from './dsp/cell/feed.js';
import type { Mib as CellMib } from './dsp/cell/pbch.js';
import { groupAlerts, type AlertGroup } from './dsp/cell/cbs.js';
import { fieldGroups } from './dsp/cell/sysinfo.js';
import { parseWarningArea, parseGeoTrigger, areaRelation, type WarningArea } from './dsp/cell/area.js';
import { CELL_BANDS, findCarriers, newProfile, scanCandidates, stitch, type CarrierGuess, type Profile } from './dsp/cell/bands.js';
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
type AppId = 'transmit' | 'troll' | 'ham' | 'js8' | 'audio' | 'hd' | 'prowl' | 'sat' | 'adsb' | 'uat' | 'ais' | 'aprs' | 'pager' | 'ert' | 'lora' | 'btle' | 'vdl2' | 'acars' | 'trains' | 'fleet' | 'cell' | 'atsc' | 'sondes' | 'subghz' | 'devices' | 'spectrum' | 'analyzer' | 'lookingglass' | 'search' | 'capture' | 'settings';
interface AppDef { id: AppId; title: string; blurb: string; cat: 'Receive' | 'Analyze' | 'Tools' | 'Transmit'; }

const APPS: AppDef[] = [
  { id: 'audio', title: 'Audio', blurb: 'WFM · NFM · AM · SSB', cat: 'Receive' },
  { id: 'hd', title: 'HD Radio', blurb: 'station data · art · traffic', cat: 'Receive' },
  { id: 'fleet', title: 'Dispatch', blurb: 'P25 · DMR · Type II trunking and calls', cat: 'Receive' },
  { id: 'pager', title: 'Pagers', blurb: 'FLEX · POCSAG', cat: 'Receive' },
  { id: 'lora', title: 'Mesh', blurb: 'LoRa · Meshtastic · MeshCore', cat: 'Receive' },
  { id: 'adsb', title: 'Flights', blurb: 'ADS-B · 1090 MHz', cat: 'Receive' },
  { id: 'uat', title: 'Flight UAT', blurb: 'UAT 978 · weather · small planes', cat: 'Receive' },
  { id: 'acars', title: 'Flight Msgs', blurb: 'ACARS · VDL2', cat: 'Receive' },
  // VDL2 has no tile or bar key of its own: it is the 136.975 band of Flight Messages (see MERGED_INTO)
  { id: 'vdl2', title: 'Flight Msgs', blurb: 'VDL Mode 2 · 136.975 MHz', cat: 'Receive' },
  { id: 'trains', title: 'Trains', blurb: 'EOT · PTC', cat: 'Receive' },
  { id: 'ais', title: 'Ships', blurb: 'AIS · 162 MHz', cat: 'Receive' },
  { id: 'cell', title: 'Cell', blurb: 'LTE alerts · cell info', cat: 'Receive' },
  { id: 'devices', title: 'Devices', blurb: 'keys · remotes · TPMS', cat: 'Receive' },
  { id: 'js8', title: 'JS8', blurb: 'HF chat · groups', cat: 'Receive' },
  { id: 'ham', title: 'Ham Radio', blurb: 'SSB · CW · repeaters', cat: 'Receive' },
  { id: 'aprs', title: 'Ham Map', blurb: 'APRS · 144.39 MHz', cat: 'Receive' },
  { id: 'ert', title: 'Utility Meters', blurb: 'ERT · Gridstream · 802.15.4g', cat: 'Receive' },
  { id: 'btle', title: 'Bluetooth', blurb: 'BLE advertising · 2.4 GHz', cat: 'Receive' },
  { id: 'sat', title: 'Satellites', blurb: 'track and decode', cat: 'Receive' },
  { id: 'sondes', title: 'Weather Balloons', blurb: 'radiosondes · 400–406 MHz', cat: 'Receive' },
  { id: 'atsc', title: 'TV', blurb: 'ATSC · guide · pictures', cat: 'Receive' },
  { id: 'prowl', title: 'Prowl', blurb: 'hunts live voice', cat: 'Receive' },
  { id: 'spectrum', title: 'Spectrum', blurb: 'analyzer, zero span', cat: 'Analyze' },
  { id: 'analyzer', title: 'Analyzer', blurb: 'bursts to bits', cat: 'Analyze' },
  { id: 'lookingglass', title: 'Looking Glass', blurb: 'wideband sweep', cat: 'Analyze' },
  { id: 'search', title: 'Search', blurb: 'find active channels', cat: 'Analyze' },
  { id: 'capture', title: 'Capture', blurb: 'record raw IQ', cat: 'Tools' },
  { id: 'transmit', title: 'Transmit', blurb: 'OOK · morse · replay', cat: 'Transmit' },
  { id: 'troll', title: 'Troll', blurb: 'novelty transmitters', cat: 'Transmit' },
  { id: 'settings', title: 'Settings', blurb: 'theme · about', cat: 'Tools' },
];
/** Apps folded into another app's tile and bar key: VDL2 is the second band of Flight Messages. */
const MERGED_INTO: Partial<Record<AppId, AppId>> = { vdl2: 'acars' };
const keyOf = (id: AppId | null) => id ? MERGED_INTO[id] ?? id : id;
const FLIGHT_MSGS_KEY = 'mm.flightmsgs.band';
/** The tile and the bar key open Flight Messages on the band you used last. */
function openPicked(id: AppId): void {
  if (id === 'acars') { let b = 'acars'; try { b = localStorage.getItem(FLIGHT_MSGS_KEY) ?? 'acars'; } catch { /* no storage */ } open(b === 'vdl2' ? 'vdl2' : 'acars'); return; }
  open(id);
}
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
  btleCh: 37, threshold: 15, pager: 'both' as 'flex' | 'pocsag' | 'both',
  /** The pager app's mode, as on Android: MULTI hunts the span's carriers, SINGLE decodes the tuned channel. */
  pagerMulti: true,
  ism: { weather: true, remotes: true, cars: true },
  r433: { heard: [] as HeardDevice[], stats: null as R433Report | null, hop: false, band: 0,
    protocols: [] as R433Protocol[], showProtocols: false, span: 250_000, filter: 'all' as R433Filter, sel: '', hist: new Map<string, { t: number; s: string; hz: number }[]>() }, muted: false, adsbView: 'map' as 'map' | 'list', adsbFollow: true, adsbSel: '' as string, home: null as { lat: number; lon: number } | null,
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
/** The saved dial, only when it is on broadcast FM: the app always opens there, in WFM, where Home and Audio pick the
 *  strongest station (a dial left on 6 m or NOAA is not brought back on a new visit). */
function loadDial(): number { try { const hz = Number(localStorage.getItem('mayhem.dial')) || 0; return hz >= 76e6 && hz <= 108e6 ? hz : 0; } catch { return 0; } }
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
  if (state.app === 'js8') { js8Tune(hz); return; }
  if (state.app === 'hd') { if (hdUi.auto) hdSetAuto(false); hdTune(hz); return; }
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
  if (state.app === 'spectrum') spectrumUi.gainChanged();
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
  syncRadioPanel();
  const g = gainChipInner();
  for (const b of qa('.fgain')) if (b.innerHTML !== g) b.innerHTML = g;
  for (const b of qa('#agc')) { b.textContent = 'AGC'; b.classList.toggle('on', state.agc); b.title = state.agc ? 'The automatic gain sets the gain' : 'The gain is yours; tap to hand it to the AGC'; }
  for (const l of qa('#lna')) { l.textContent = `LNA ${state.lna}${state.agc ? ' AUTO' : ''}`; l.classList.toggle('auto', state.agc); }
  for (const v of qa('#vga')) { v.textContent = `${radio?.kind === 'rtlsdr' ? 'GAIN' : 'VGA'} ${state.vga}${state.agc ? ' AUTO' : ''}`; v.classList.toggle('auto', state.agc); }
}
function setAgc(on: boolean): void {
  state.agc = on;
  // The app's AGC and the tuner's own cannot both drive one knob: handing it to the app takes it from the tuner.
  const rtl = on && radio && radio.kind === 'rtlsdr' ? radio as RtlSdr : null;
  if (rtl) rtl.tunerAgc = false;
  refreshAgcChip(); if (on) agcLast = 0;
}
/** The AGC and AMP chips are the user speaking, so what they leave behind is remembered too. */
const userAgc = (on: boolean) => { setAgc(on); saveGains(); };
/** Manual LNA / VGA taps switch the AGC off so the user's setting sticks. */
const manualGains = (lna: number, vga: number, amp: boolean) => {
  if (state.agc) log('gain set by hand, so the automatic gain is off — tap AGC to hand it back');
  const rtl = radio && radio.kind === 'rtlsdr' ? radio as RtlSdr : null;
  if (rtl?.tunerAgc) { rtl.tunerAgc = false; log('gain set by hand, so the tuner AGC is off'); }
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
  if (state.app === 'lora' && loraGain.level) {
    // LoRa's one-second level swings with the bursts: the median of the last few
    loraGain.rms.push(rms); if (loraGain.rms.length > 8) loraGain.rms.splice(0, loraGain.rms.length - 8);
    if (loraGain.rms.length < 4) return;
    loraAgc([...loraGain.rms].sort((a, b) => a - b)[loraGain.rms.length >> 1], now, lo, hi);
    return;
  }
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

// ---- LoRa's gain ----
/** How long the gain waits after a clip before it climbs again (doubled each time a step up clips, up to 30 min). */
const LORA_HOLD_MS = 120_000;
/** Counts from center the strongest burst may reach after a step up (the converter tops out at 128). */
const LORA_CEIL = 90;
const loraGain = {
  /** The LoRa scanner's strongest sample (counts from center) and clipped share over the last second, and how long
   *  ago a receiver last found a LoRa preamble (ms, -1: never). */
  level: null as { peak: number; clipShare: number; agoMs: number } | null,
  rms: [] as number[],
  /** The strongest sample of each second since the gain last moved: (ms, counts). */
  peaks: [] as [number, number][],
  /** When a burst last clipped, and how long the gain then waits before it climbs again. */
  clipAt: -Infinity, hold: 0,
  /** When it last tried a stage up past what the headroom says, and since when the gain has held still. */
  probeAt: -Infinity, stillSince: 0,
  /** Since when over 1% of samples have clipped every second (0: not now): real overload outlasts any packet. */
  overSince: 0,
  /** Its latest reasoning, for the log. */
  note: 'LoRa gain not started',
};
/** Where the gain settles depends on the antenna and the place (a big antenna beside a node clips at a gain a small one
 *  needs), so what held still for two minutes is kept per board and per 10 MHz of band, and the next LoRa session
 *  there starts from it instead of finding it again. */
const loraGainKey = () => `mm.lora.gain.${radio?.kind === 'rtlsdr' ? 'rtl' : isPro() ? 'pro' : 'one'}.${Math.trunc(state.freq / 10_000_000)}`;
function loraRecall(): void {
  Object.assign(loraGain, { level: null, rms: [], peaks: [], clipAt: -Infinity, hold: 0, probeAt: -Infinity, stillSince: 0, overSince: 0 });
  if (!state.agc || !radio) return;
  let g = 0;
  try { g = Number(localStorage.getItem(loraGainKey()) ?? 0); } catch { /* private window */ }
  if (!(g > 0)) return;
  const lna = Math.trunc(g / 1000) % 1000, vga = g % 1000;
  setGains(lna, vga, radio.kind === 'rtlsdr' ? state.amp : true);
  log(`LoRa gain: starting where it settled last time here (amp ${state.amp ? 'on' : 'off'} LNA ${state.lna} VGA ${state.vga})`);
}
/**
 * LoRa decodes below the noise, so the average level says little: what matters is the strongest burst. A node close
 * by (a good antenna in the same house) clips the converter, which LoRa rides through, while far nodes need the front
 * end's gain. So the gain comes down a stage under sustained overload (a nearby node clipping costs nothing) (the LNA first, then the VGA; the front-end amp
 * stays on, as LoRa hears nothing without it) and climbs back, one stage at a time, only once the strongest burst of the last stretch would still fit after
 * the step. After a clip it waits LORA_HOLD_MS before climbing (doubling each time a step up clips again, up to 30
 * minutes), so a nearby node that only speaks every few minutes doesn't get clipped again on each of its packets.
 */
function loraAgc(rms: number, now: number, lo: number, hi: number): void {
  const lv = loraGain.level, g = loraGain;
  if (!lv || !radio) return;
  const l = state.lna, v = state.vga, a = state.amp;
  const rtl = radio.kind === 'rtlsdr', hasLna = !rtl, hasAmp = !rtl, vMax = 62, LNA_MAX = 40, LNA_STEP = 8;
  let nl = l, nv = v, na = a;
  g.peaks.push([now, lv.peak]); g.peaks = g.peaks.filter(([t]) => now - t <= 60_000);
  // The band's meters burst every second and some clip; a clip lasts only their burst and costs only them, while
  // stepping down for it left far nodes under the noise. So it backs off only for a clip while a LoRa frame is being
  // received (a node close by), or for sustained overload (over 1% of samples).
  const anyClip = lv.clipShare > 1e-4 || lv.peak >= 126;
  const loraNow = lv.agoMs >= 0 && lv.agoMs < 1500;
  // A clip from a node close by costs it nothing: measured with a T114 beside the antenna clipping the converter,
  // 6 of 6 frames at LNA 40, 24 and 0 alike, while stepping down for it sank the far nodes. Only overload that
  // outlasts any packet (over 1% of samples clipped for 8 seconds running) brings the front end down.
  if (lv.clipShare > 0.01) { if (!g.overSince) g.overSince = now; } else g.overSince = 0;
  const clipped = g.overSince > 0 && now - g.overSince >= 8_000;
  let why = '';
  if (hasAmp && !a) {
    // the front-end amp stays on for LoRa: measured on a HackRF Pro, 43 and 14 frames in 4 minutes with it on, none
    // with it off (the VGA cannot make up what the front end loses)
    na = true; why = 'front-end amp back on: LoRa hears nothing without it';
  } else if (clipped) {
    // a step up that clips within a minute doubles the wait before the next try; any other clip (the first seconds
    // of stepping down from a gain set by hand, a node keying up) waits the usual time
    g.hold = now - g.probeAt < 60_000 ? Math.min(1_800_000, Math.max(LORA_HOLD_MS, g.hold * 2)) : LORA_HOLD_MS;
    g.clipAt = now;
    if (hasLna && l > 0) { nl = l - LNA_STEP; why = 'clipped: LNA down'; }
    else if (v > 0) { nv = Math.max(0, v - 6); why = 'clipped: VGA down'; }
    else why = 'clipped at the lowest gain (a transmitter right beside the antenna)';
    g.peaks = [];
  } else if (anyClip && !loraNow && v > vMax / 2 && rms > lo) {
    // a meter's burst clipped: the VGA alone gives a little back, the front end stays where far nodes need it
    nv = Math.max(0, v - 2); why = 'clip outside LoRa: VGA down a step';
  } else if (rms > hi && v > 0) {
    nv = Math.max(0, v - 2); why = 'noise high: VGA down';
  } else {
    const span = g.peaks.length >= 10 ? now - g.peaks[0][0] : 0;
    const peak = g.peaks.length ? Math.max(...g.peaks.map(([, x]) => x)) : 128;
    const waiting = now - g.clipAt < g.hold;
    // step factors: amp about 11 dB, an LNA step 8 dB, a VGA step 2 dB
    const probeDue = now - Math.max(g.probeAt, g.clipAt) > Math.max(LORA_HOLD_MS, g.hold);
    if (span < 9_000) why = 'watching the level';
    else if (waiting) {
      // only the VGA's small steps while it waits, and only for a quiet radio
      if (rms < lo && v < vMax && peak * 1.26 < LORA_CEIL) { nv = Math.min(vMax, v + 2); why = 'quiet: VGA up (holding the front end after a clip)'; }
      else why = `holding ${((g.hold - (now - g.clipAt)) / 1000).toFixed(0)} s after a clip`;
    } else if (hasAmp && !a && peak * 3.55 < LORA_CEIL) { na = true; why = 'room: front-end amp on'; }
    else if (hasLna && l < LNA_MAX && peak * 2.5 < LORA_CEIL) { nl = Math.min(LNA_MAX, l + LNA_STEP); why = 'room: LNA up'; }
    else if (v < vMax && rms * 1.26 < hi && peak * 1.26 < LORA_CEIL) { nv = Math.min(vMax, v + 2); why = 'room: VGA up'; }
    // No room by the strongest burst (often a meter, not a node): now and then it tries one stage up anyway. A clip
    // brings it straight back down and makes the next try wait twice as long, so it settles at the most gain this
    // antenna and place can take.
    else if (probeDue && hasAmp && !a) { na = true; g.probeAt = now; why = 'trying: front-end amp on'; }
    else if (probeDue && hasLna && l < LNA_MAX) { nl = Math.min(LNA_MAX, l + LNA_STEP); g.probeAt = now; why = 'trying: LNA up'; }
    else why = 'settled';
    if (nl !== l || na !== a) g.peaks = [];
  }
  g.note = `${why} · peak ${lv.peak.toFixed(0)} counts, clipped ${(lv.clipShare * 100).toFixed(4)}%, noise ${rms.toFixed(1)} counts`;
  const moved = nl !== l || nv !== v || na !== a;
  if (moved) g.stillSince = now;
  else if (g.stillSince === 0) g.stillSince = now;
  else if (now - g.stillSince > 120_000 && now - g.clipAt > 600_000) {
    const val = (a ? 1 : 0) * 1_000_000 + l * 1000 + v;
    let had = 0;
    try { had = Number(localStorage.getItem(loraGainKey()) ?? 0); } catch { /* private window */ }
    if (had !== val) {
      try { localStorage.setItem(loraGainKey(), String(val)); } catch { /* private window */ }
      log(`LoRa gain: kept amp ${a ? 'on' : 'off'} LNA ${l} VGA ${v} for this radio and band`);
    }
  }
  if (moved) {
    setGains(nl, nv, na);
    log(`LoRa gain: ${why} (amp ${a ? 'on' : 'off'} LNA ${l} VGA ${v} → amp ${state.amp ? 'on' : 'off'} LNA ${state.lna} VGA ${state.vga}; strongest ${lv.peak.toFixed(0)} counts)`);
  }
}
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
  if (!radio || (state.app !== 'lookingglass' && state.app !== 'search' && state.app !== 'spectrum')) return;
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
const sweepCardHtml = () => `<div class="face sweep"><div class="fhead"><span id="ftag" class="ftag"></span><span id="ftitle" class="ftitle"></span>${gainChipHtml()}<span id="lamp" class="lamp"><i></i><b></b></span></div><div id="sweep-title" class="srange">${sweepTitle()}</div><div id="leds" class="leds">${'<i></i>'.repeat(32)}<s hidden></s></div><div id="lscale" class="lscale"></div><div class="fcap"><b id="capl">PASS —</b><span id="capr"></span></div></div>`;
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
/** VDL2: 2 MHz centered here holds 136.10 to 136.975 (every VDL2 channel), with no channel on the radio's center. */
const VDL2_SPAN_HZ = 136_550_000;
/** AIS and APRS: how far above the channel the radio sits, clear of the DC spike at the center of the span. */
const NARROW_SHIFT = 250_000;
/** Whether the radio can sample at `hz` (with no radio yet, a HackRF is assumed: it takes every rate on offer). */
const radioCan = (hz: number) => !radio || canSample(radio.limits, hz);
/** Put the radio NARROW_SHIFT above the channel, as Mayhem keeps its channels off the DC spike; the engine mixes the
 *  channel back down through the offset. */
function narrowShift(): void { state.viewLo = state.freq + NARROW_SHIFT; if (radio) radio.targetFreqHz = state.viewLo; sendOffset(); }
function open(app: AppId | null): void {
  if ((app as string) === 'subghz' || (app as string) === 'tpms') app = 'devices';      // Sub-GHz and TPMS are part of Devices now
  if (app === 'settings') { openSettings(); return; }
  if (app === 'acars' || app === 'vdl2') { try { localStorage.setItem(FLIGHT_MSGS_KEY, app); } catch { /* no storage */ } }
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
    case 'js8': js8Open(); return;
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
    case 'hd': hdOpen(); break;
    case 'prowl': configure('NFM', state.prowl.target ? state.freq : dial, Math.max(RX_RATE, state.rate), 24, 24, false, 'none'); break;
    case 'adsb': configure('NONE', 1_090_000_000, 2e6, 32, 32, true, 'adsb'); requestGeo(); break;
    case 'uat': uatOpen(); break;
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
    case 'sondes': sondesOpen(); break;
    case 'btle': configure('NONE', btleChannelFreq(state.btleCh), 2e6, 32, 40, true, 'btle'); worker?.postMessage({ type: 'btleChannel', ch: state.btleCh }); break;
    // The span is centred on 130.8 MHz: every US ACARS channel (130.025-131.550) is inside it and decoded at once,
    // none of them on the radio's DC spike; 131.550 is the one heard.
    case 'vdl2': configure('AM', 136_975_000, 2e6, 32, 32, false, 'vdl2'); state.viewLo = VDL2_SPAN_HZ; if (radio) radio.targetFreqHz = state.viewLo; sendOffset(); break;
    case 'acars': configure('AM', 131_550_000, 2e6, 32, 32, false, 'acars'); state.viewLo = ACARS_SPAN_HZ; if (radio) radio.targetFreqHz = state.viewLo; sendOffset(); break;
    case 'trains': trainsTune(); if (trainsUi.auto) trainsCycle(); break;
    case 'fleet': fleetOpen(); break;
    case 'cell': cellOpen(); break;
    case 'atsc': atscOpen(); break;
    case 'subghz': configure('NONE', 433_920_000, 2e6, 32, 40, true, 'subghz'); worker?.postMessage({ type: 'ismFamilies', ...state.ism }); break;
    case 'devices':
      // Always open on 433.92, whatever the last visit left behind. The band is remembered while the app is
      // up, and the hop moves it along on its own, so without this a session that wandered to 915 would come
      // back there — when what is wanted on opening is the band that carries most of the protocol set.
      state.r433.band = 0;
      configure('NONE', takeHandoff() ?? R433_BANDS[0][1], 2e6, 32, 40, true, 'r433');
      // The worker is normally created on connect; ask for it here so the protocol list is available
      // whether or not a radio is plugged in.
      ensureWorker().postMessage({ type: 'r433', cmd: 'list' });
      worker?.postMessage({ type: 'r433', cmd: 'span', hz: state.r433.span }); break;
    // the Devices front end with every burst kept: the same bands, gains and rate as Devices
    case 'analyzer': configure('NONE', takeHandoff() ?? R433_BANDS[0][1], 2e6, 32, 40, true, 'analyzer'); break;
    // the processor starts once the screen is up and has worked out its span (SpectrumUi.restart → spectrumStart)
    case 'spectrum': render(app); return;
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
/** The second line of a map's empty overlay: what will show up, and where the map is centered. */
const mapEmptySub = (what: string) => `${what}. ${state.home ? 'Centered on you.' : mapStart(null).standIn ? 'No location yet: allow it to center the map on you.' : 'Centered where you were last.'}`;
function requestGeo(): void {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(p => { state.home = { lat: p.coords.latitude, lon: p.coords.longitude }; saveLastPos(state.home); geo?.setHome(state.home); geo?.recenter(state.home.lat, state.home.lon); if (state.app === 'ais') refreshAis(); else if (state.app === 'aprs') refreshAprs(); else if (state.app === 'adsb') refreshAdsb(); else if (state.app === 'acars' || state.app === 'vdl2') refreshAcars(true); worker?.postMessage({ type: 'geo', lat: p.coords.latitude, lon: p.coords.longitude }); log(`GPS reference ${p.coords.latitude.toFixed(3)},${p.coords.longitude.toFixed(3)} for single-frame CPR`); }, () => log('no GPS fix — ADS-B positions need even+odd frame pairs'), { maximumAge: 600_000, timeout: 8000 });
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
    : emptyState('prowl');
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
    </section>`;
  scope = attach(tunableScope('scope', 90, 70));
  geo = new GeoMap($('orb-map'), { home: state.home, start: mapStart(state.home), onPick: id => { o.sel = Number(id); refreshOrbcomm(); }, log });
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
const readoutHtml = () => `<div class="face"><div class="fhead"><span id="ftag" class="ftag"></span><span id="ftitle" class="ftitle"></span><button id="fav" class="fact" title="save this to FAVES">☆</button><button id="fkey" class="fact" title="type a frequency">⌨</button>${gainChipHtml()}<span id="lamp" class="lamp"><i></i><b></b></span><span id="sq" hidden></span></div><div class="readout"><div id="freq" class="freq">${freqDigitsHtml()}</div></div><div id="leds" class="leds">${'<i></i>'.repeat(32)}<s hidden></s></div><div id="lscale" class="lscale">${scaleHtml(DB_SCALE)}</div><div class="fcap"><b id="capl">SIGNAL —</b><span id="capr"></span></div><div id="health" class="health">waiting for IQ…</div></div>`;
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
/** Key a frequency in on the app's keypad (the same one Spectrum's tiles and the Android app use): a unit key enters
 *  it in that unit, Enter in MHz (or Hz when it was typed out in full). A digit typed on a keyboard opens it with that
 *  digit already in. */
function freqEntry(seed = ''): void {
  openKeypad({ label: 'FREQUENCY', units: FREQ_UNITS, auto: freqAuto, seed, hint: `${+(tunedHz() / 1e6).toFixed(6)} MHz`, onEnter: hz => tune(Math.round(hz)) });
}
const isAndroid = () => /android/i.test(navigator.userAgent);
/**
 * The gain as one line in each app's card header ("AGC · LNA 24 VGA 50 · AMP"); a tap opens RADIO, where every gain
 * control lives. No screen has a gain row of its own.
 */
function gainSummary(): string {
  const rtl = rtlRadio();
  const who = rtl?.tunerAgc ? 'TUNER AGC' : state.agc ? 'AGC' : 'MANUAL';
  if (rtl) return `${who} · GAIN ${rtlGainDb()} dB${state.biast ? ' · BIAS-T' : ''}`;
  return `${who} · LNA ${state.lna} VGA ${state.vga}${state.amp ? ' · AMP' : ''}`;
}
/** The same in a phone header's width: "AGC 46 dB", "MAN 24/50 +A" (+A: the HackRF's amp is on). */
function gainShort(): string {
  const rtl = rtlRadio();
  const who = rtl?.tunerAgc || state.agc ? 'AGC' : 'MAN';
  if (rtl) return `${who} ${rtlGainDb()} dB`;
  return `${who} ${state.lna}/${state.vga}${state.amp ? ' +A' : ''}`;
}
const gainChipInner = () => `<span class="gl">${gainSummary()}</span><span class="gs">${gainShort()}</span>`;
const gainChipHtml = () => `<button class="fgain" title="Gain: tap for RADIO">${gainChipInner()}</button>`;
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
    const left = () => inner.scrollLeft > 4, right = () => inner.scrollLeft < inner.scrollWidth - inner.clientWidth - 4;
    let upd = () => { w.classList.toggle('mL', left()); w.classList.toggle('mR', right()); };
    if (w.classList.contains('bar-pill')) {
      // the app bar hints quietly: the side with more apps glows until you touch it; while you scroll it stays dark,
      // and when you reach an end the glow comes back on the other side, pointing the way you came
      let touched = false, moving = 0;
      const show = () => { const l = left(), r = right(); w.classList.toggle('mL', touched ? !r && l : l); w.classList.toggle('mR', touched ? !l && r : r); };
      const grab = () => { touched = true; };
      for (const ev of ['pointerdown', 'wheel', 'touchstart'] as const) inner.addEventListener(ev, grab, { passive: true });
      upd = () => {
        if (!touched) { show(); return; }
        w.classList.remove('mL', 'mR'); clearTimeout(moving);
        moving = window.setTimeout(show, 140);
      };
    }
    inner.addEventListener('scroll', upd, { passive: true }); new ResizeObserver(upd).observe(inner); upd();
    // the tile you are on, in view
    const on = inner.querySelector<HTMLElement>('.on'); if (on) inner.scrollLeft = Math.max(0, on.offsetLeft - inner.offsetLeft - 60);
  });
}
/** The line over every decode list. PAUSE holds the screen still so a row can be read while packets keep
 *  landing underneath; CLEAR forgets them. Both are wired by id in wireCommon, whichever screen they are on. */
/** The clear-all icon the Android app puts beside PAUSE. */
const CLEAR_SVG = '<svg viewBox="0 0 24 24"><path d="M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zM14 5h-3l-1-1H6L5 5H2v2h12z"/></svg>';
/** PAUSE / RESUME: the word on a wide screen, an icon on a phone so the tabs beside it keep their room. */
const pauseInner = (on: boolean) => `<span class="pw">${on ? 'RESUME' : 'PAUSE'}</span><svg class="pi" viewBox="0 0 24 24" aria-hidden="true"><path d="${on ? 'M8 5v14l11-7z' : 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'}"/></svg>`;
const pauseClearHtml = (id: string) => `<button class="tog pz" id="pause-${id}" aria-label="pause">${pauseInner(false)}</button><button class="ib" id="clear-${id}" title="clear" aria-label="clear">${CLEAR_SVG}</button>`;
const countRowHtml = (id: string, count: string, extra = '') => `<div class="countrow"><span id="count-${id}" class="count">${count}</span><span class="row">${extra}${pauseClearHtml(id)}</span></div>`;
/**
 * What an empty list or card stage says, centered: the app's glyph, what it is waiting for, and one or two concrete
 * things to try. Keyed by app (and a few sub-lists).
 */
const EMPTY: Record<string, [string, string, string[]]> = {
  prowl: ['prowl', 'Nothing heard yet', ['Press HUNT: it lands on anyone talking and moves on when they stop', 'A wider SPAN watches more at once; a narrower one hears weak voices better']],
  search: ['search', 'No active frequencies yet', ['Pick a range above: AIR 118–137 and 2m 144–148 are busy almost everywhere', 'Set ABOVE to +10 dB to catch weaker signals']],
  capture: ['capture', 'No captures yet', ['Tune to a signal and press ● REC', 'Keep it short: 2 Msps fills about 4 MB a second']],
  hd: ['hd', 'No HD stations yet', ['AUTO finds the stations across the FM band, then visits the strong ones from the bottom up until each fills in', 'Most big FM stations in the US are hybrid: name, songs, logos and album art come in within a minute or two', 'What plays is the analog FM: the digital audio codec is not decoded']],
  vdl2: ['vdl2', 'Waiting for VDL2 messages', ['Every VDL2 channel from 136.10 to 136.975 MHz is decoded at once; 136.975 is the common one', 'Aircraft talk to ground stations every few minutes, more near an airport; an antenna that sees the sky hears them 200 miles out']],
  acars: ['acars', 'Waiting for ACARS messages', ['Aircraft send them every few minutes; 131.550 is the busiest US channel', 'Near an airport, or with an antenna that sees the sky, you hear aircraft up to 200 miles out']],
  btle: ['btle', 'Waiting for BLE advertisements', ['Phones, earbuds and watches advertise several times a second: start on CH 37', 'BLE is low power: hold the radio within a few meters of a device']],
  lora: ['lora', 'No nodes yet', ['Meshtastic nodes beacon about every 15 minutes: leave it running', 'AREA picks where you are; a wider SPAN (20 MHz on a HackRF) holds more of its channels']],
  sondes: ['sondes', 'No weather balloons yet', ['Weather services launch around 00:00 and 12:00 UTC; a sonde climbs for about 90 minutes and is heard 200+ miles out', 'Every type is decoded on its own: leave it running and they show up']],
  loramsg: ['lora', 'No messages yet', ['Text on the default Meshtastic and MeshCore public channels shows up here', 'Names and positions arrive first; messages are rarer']],
  cell: ['cell', 'No alerts yet', ['Wireless Emergency Alerts and ETWS warnings ride in SIB12 and SIB10/11: carriers send them only while an alert is active', 'Every alert heard is kept here, newest first, until you clear it', 'Alerts need the whole carrier in the span: a HackRF']],
  atsc: ['atsc', 'No stations yet', ['AUTO looks at every channel for an ATSC pilot and stays on each station it finds', 'An antenna up high, or outside, hears stations 60+ miles away', 'A HackRF decodes the channels, the guide and a picture of each; an RTL-SDR finds the stations']],
  ham: ['ham', 'Nothing open', ['Every channel in the span is watched; one that opens shows up here with its tone', 'Try 2 m near 146.520, or set the threshold to +6 dB']],
  fleet: ['fleet', 'No trunked systems yet', ['Control channels send all the time: a system shows up within seconds of its band being in the span', 'Every call granted jumps to the top while it is on the air', 'AUTO steps through VHF, TETRA 380 to 430, UHF, T-band, 700, 800 and 900 MHz and stays on the band where clear voice is heard; pick a band to stay on it', 'A HackRF at 8 or 20 MHz hears a whole site at once']],
  ert: ['ert', 'No meters yet', ['Meters report every 30 s to a few minutes: give it a minute', 'Most meters sit at 908–924 MHz: the 19.2 MHz span covers them']],
  uat: ['uat', 'Listening on 978 MHz', ['FAA ground towers broadcast weather here several times a second: radar, airport weather, notices', 'Small planes, and the traffic the towers rebroadcast, show up on the map', 'A 978 MHz antenna (a 915 MHz one works) with a view of the sky helps']],
  adsb: ['adsb', 'No aircraft yet', ['Aircraft send on 1090 MHz several times a second: a window with a view of the sky helps', 'A 1090 MHz antenna (about 6.9 cm) reaches 100+ miles']],
  ais: ['ais', 'No vessels yet', ['Ships under way report every 2–10 s, at anchor every 3 minutes', 'AIS is VHF: you need a line of sight to the water']],
  aprs: ['aprs', 'No stations yet', ['North America uses 144.390 MHz: cars and digipeaters beacon every few minutes', 'An antenna up high hears much farther']],
  analyzer: ['analyzer', 'No bursts yet', ['Press a key fob or a remote near the antenna', 'Or IMPORT a recording (.cu8 .cs8 .sub) or a session (.mmanalyzer)']],
  devices: ['devices', 'Nothing heard yet', ['Press a key fob or a remote near the antenna', 'Sensors report every 30 to 60 seconds; tire sensors wake when a car moves', 'HOP takes turns between 315 and 433.92']],
  pager: ['pager', 'No pages yet', ['US FLEX networks sit around 929–932 MHz: try the presets', 'POCSAG is common on 152–158 and 466 MHz']],
};
function emptyState(key: string, title?: string, tips?: string[]): string {
  const e = EMPTY[key]; if (!e) return `<div class="empty">${esc(title ?? 'listening…')}</div>`;
  return `<div class="es"><span class="es-g">${glyph(e[0], 'currentColor', 44)}</span><b>${esc(title ?? e[1])}</b><ul>${(tips ?? e[2]).map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
}
const listHtml = (id: string, title: string) => `<div class="panel list" id="list-${id}">${EMPTY[id] ? emptyState(id) : `<div class="empty">${title}</div>`}</div>`;
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
    // every 100 kHz raster channel in view, scored by the average level across ±80 kHz of it. The middle channel
    // counts too: the radio opens centered on the dial, so the station is often right there, and leaving it out made
    // its two shoulders (±100 kHz) the "strongest stations" and tuned 100 kHz off it. Only the DC spike's own bins
    // (±30 kHz of the middle) are left out of every score.
    const acc = pick.specAcc, n = acc.length, binHz = state.rate / n, w = Math.max(1, Math.floor(80_000 / binHz)), start = c - state.rate / 2;
    const score = (f: number): number => {
      const mid = Math.floor((f - start) / binHz); let sum = 0, cnt = 0;
      for (let k = Math.max(0, mid - w); k <= Math.min(n - 1, mid + w); k++) {
        if (Math.abs(start + (k + 0.5) * binHz - c) < 30_000) continue;
        sum += acc[k]; cnt++;
      }
      return cnt ? sum / cnt * (2 * w + 1) / pick.specN : 0;
    };
    const scores: [number, number][] = [];
    const all: [number, number][] = [];
    for (let f = Math.ceil((c - half) / 100_000) * 100_000; f <= c + half; f += 100_000) all.push([f, score(f)]);
    // the band's own grid, learned from the stations on the air, so it holds in every country: the Americas, Korea and
    // the Philippines put stations on odd tenths only (88.1 to 107.9), Europe and Japan on any 100 kHz step. Off the
    // grid a noise hump can win (101.0 picked on a Mac after Dispatch, garbled)
    const grid = fmGridParity(all);
    for (const s of all) if (grid < 0 || Math.round(s[0] / 100_000) % 2 === grid) scores.push(s);
    if (!scores.length) return null;
    const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
    // already on a good station: stay unless it is under a third of the best one
    if (Math.abs(here - c) <= half && (grid < 0 || Math.round(here / 100_000) % 2 === grid)) {
      const mine = score(here);
      // and only on the station itself: a dial 100 kHz to one side sits on its shoulder (garbled audio)
      // and standing out of the band: an empty dial (a fresh visit's default) scores near every other empty channel,
      // a station at least half again over the median one
      const median = scores.map(x => x[1]).sort((a, b) => a - b)[Math.floor(scores.length / 2)];
      if (mine >= best[1] / 3 && mine >= 1.5 * median && mine >= score(here - 100_000) && mine >= score(here + 100_000)) { log(`start-up: staying on the station already tuned, ${(here / 1e6).toFixed(3)} MHz (level ${Math.round(mine)}, best in view ${(best[0] / 1e6).toFixed(1)} MHz ${Math.round(best[1])})`); return 'stay'; }
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
/**
 * The broadcast grid in view: 1 when the stations heard sit on odd tenths (200 kHz apart, as in the Americas), 0 on
 * even tenths, -1 for any 100 kHz step. A station is a channel that tops both neighbors and is at least twice the
 * median; it takes three of them, nearly all on one parity, to settle it.
 */
export function fmGridParity(all: [number, number][]): number {
  if (all.length < 5) return -1;
  const median = all.map(x => x[1]).sort((a, b) => a - b)[Math.floor(all.length / 2)];
  let odd = 0, even = 0;
  for (let i = 1; i < all.length - 1; i++) {
    const v = all[i][1];
    if (v >= 2 * median && v > 0 && v >= all[i - 1][1] && v >= all[i + 1][1]) { if (Math.round(all[i][0] / 100_000) % 2 === 1) odd++; else even++; }
  }
  const n = odd + even;
  if (n < 3) return -1;
  return odd >= 0.7 * n ? 1 : even >= 0.7 * n ? 0 : -1;
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
/** Each app's long description, kept for Settings, HOW IT WORKS: it is not shown on the app's own screen. */
const appAbout: Partial<Record<AppId, string>> = {};
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
    case 'js8': renderJs8(view, js8Host); break;
    case 'adsb': renderAdsb(view); break;
    case 'uat': renderUat(view); break;
    case 'ais': renderAis(view); break;
    case 'aprs': renderAprs(view); break;
    case 'pager': if (state.pagerMulti) renderHunt(view); else renderPacket(view, app); break;
    case 'ert': renderMeters(view); break;
    case 'lora': renderLora(view); break;
    case 'sondes': renderSondes(view); break;
    case 'trains': renderTrains(view); break;
    case 'fleet': renderFleet(view); break;
    case 'hd': renderHd(view); break;
    case 'cell': renderCell(view); break;
    case 'atsc': renderAtsc(view); break;
    case 'btle': renderBle(view); break;
    case 'vdl2': renderAcars(view, 'vdl2'); break;
    case 'acars': renderAcars(view, 'acars'); break;
    case 'subghz': renderPacket(view, app); break;
    case 'devices': renderR433(view); break;
    case 'analyzer': renderAnalyzer(view); break;
    case 'spectrum': renderSpectrum(view); break;
    case 'lookingglass': case 'search': renderSweep(view, app); break;
    case 'capture': renderCapture(view); break;
    case 'transmit': renderTx(view); break;
    case 'troll': renderTroll(view); break;
    case 'settings': renderSettings(view); break;
  }
  if (app) { const ab = view.querySelector('.note.about'); if (ab?.textContent) appAbout[app] = ab.textContent.trim(); }
  if (app && app !== 'settings') {
    const def = APPS.find(a => a.id === app)!;
    const title = CARD_TITLE[app];
    if (!q('#ftag')?.textContent) setFace(title?.[0] ?? appName(app), title?.[1] ?? def.blurb.toUpperCase());
    if (!q('#lamp b')?.textContent) setLamp(state.connected ? 'LISTENING' : 'NO RADIO', state.connected ? 'amber' : '', state.connected);
  } else if (!app) { setFace('HOME', 'TAP THE WATERFALL TO LISTEN'); setLamp(state.connected ? 'LIVE' : 'NO RADIO', state.connected ? 'ok' : ''); }
  wireCommon(view);
  bindHs(view);
  refreshReadout(); setGains(state.lna, state.vga, state.amp); setMode(state.mode);
  refreshShell();
  window.scrollTo(0, 0);
  // every app shares this one scroller; a new app opens at its top, not where the last one was left (a redraw of
  // the same app keeps its place)
  if (app !== renderedApp) view.scrollTop = 0;
  renderedApp = app;
}
let renderedApp: AppId | null | undefined;

function renderLauncher(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual launch-visual">${readoutHtml()}<div id="launch-scope" class="launch-scope"></div><div id="launch-line" class="launch-line"></div>
    <div class="launch-radio"><div class="caption">BANDS</div>${hsHtml(`<div class="row wrap bandrow">${bandChipsHtml()}</div>`, 'bandhs')}<div class="launch-gain"></div></div></section>
    <section class="controls launch-side"><div class="grid launch-grid">${(['Receive', 'Analyze', 'Transmit', 'Tools'] as const).map(c => {
      const apps = APPS.filter(a => a.cat === c && !MERGED_INTO[a.id]); if (!apps.length) return '';
      // each group's name over its tiles: a grid two to a row on a phone, one sideways row when wide (as on iPad)
      return `<div class="lgrp"><div class="gcat" style="color:${tint(c)}">${c.toUpperCase()}</div><div class="lgrp-in">` + apps.map(a => `<button class="tile" data-app="${a.id}" style="--tint:${tint(a.cat)}"><span class="wm">${glyph(a.id, tintHex(a.cat), 84)}</span><div class="tile-top"><span class="badge">${glyph(a.id, tintHex(a.cat), 26)}</span><span class="cat">${a.cat.toUpperCase()}</span></div><div class="tile-title">${a.title}</div><div class="tile-blurb" data-blurb="${a.blurb}">${a.blurb}</div></button>`).join('') + '</div></div>';
    }).join('')}</div>
    <div class="foot"><span id="version">${versionText}</span> · <a id="release-link" href="${releaseUrl}">release</a> · <a href="https://github.com/RocketGod-git/mayhem-mobile">source</a> · GPL-3.0 · a port of <a href="https://github.com/portapack-mayhem/mayhem-firmware">PortaPack Mayhem</a><br>made by <a href="https://rocketgod.dev">RocketGod</a> · The Pirates' Plunder · <a href="https://discord.gg/thepirates">discord.gg/thepirates</a></div></section>`;
  scope = attach(tunableScope('launch-scope', 70, 90));
  scope.setLabels(centredLabels(state.freq, state.rate));
  qa<HTMLButtonElement>('[data-app]', view).forEach(b => b.onclick = () => openPicked(b.dataset.app as AppId));
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
    // a tile this radio can't run says so in one line (its HACKRF chip is CSS); the full reason is in the tooltip
    const bl = b.querySelector<HTMLElement>('.tile-blurb'); if (bl) bl.textContent = why ? 'needs a HackRF' : (bl.dataset.blurb ?? bl.textContent);
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
/** JS8: the HAM receiver in USB on the dial, its audio feeding the JS8 receiver in the worker. */
function js8Open(): void {
  const d = js8Dial();
  if (radio && !canTune(radio.limits, d)) log(`${radio.label}: ${(d / 1e6).toFixed(3)} MHz is out of its range, JS8 lives on HF`);
  state.hamLo = hamLoFor(d);
  configure('NONE', state.hamLo, HAM_RATE, 32, 40, false, 'js8', { speeds: js8Speeds() });
  state.freq = d;
  render('js8');
  js8Params();
}
function js8Params(): void {
  worker?.postMessage({ type: 'hamParams', params: { offsetHz: js8Dial() - state.hamLo, mode: 'USB', lo: 100, hi: 3200, pitch: 600, agc: 'slow', nr: false, anf: false, squelchDb: 0, volume: state.ham.volume } });
}
function js8Tune(hz: number): void {
  hz = Math.min(6_000_000_000, Math.max(1_000_000, Math.round(hz)));
  js8SetDial(hz); state.freq = hz;
  const off = hz - state.hamLo;
  if (Math.abs(off) > state.rate / 2 - HAM_GUARD || Math.abs(off) < 15_000) { state.hamLo = hamLoFor(hz); if (radio) radio.targetFreqHz = state.hamLo; }
  js8Params(); refreshReadout(); refreshJs8(true);
}
const js8Host: Js8Host = {
  readoutHtml: () => readoutHtml(),
  refreshReadout: () => refreshReadout(),
  segHtml: (b, c) => segHtml(b, c),
  hsHtml: (i, c) => hsHtml(i, c),
  esc: s => esc(s).replace(/"/g, '&quot;'),
  log: s => log(s),
  station: () => ({ call: state.ham.station.call.trim().toUpperCase(), grid: myGrid() }),
  home: () => state.home ?? (myGrid() ? gridToLatLon(myGrid()) : null),
  isOpen: () => state.app === 'js8',
  tune: hz => js8Tune(hz),
  setSpeeds: s => worker?.postMessage({ type: 'js8Speeds', speeds: s }),
  tx: {
    get enabled() { return tx.enabled; },
    get needsPrompt() { return tx.needsPrompt; },
    get active() { return tx.active; },
    js8: (label, rfHz, track, rate, sps) => tx.js8(label, rfHz, track, rate, sps),
  },
  showTxSafetyPrompt: () => showTxSafetyPrompt(),
  txReady: () => !tx.enabled ? 'transmit is switched off in Settings' : !radio || radio.kind !== 'hackrf' ? 'sending needs a HackRF' : !state.ham.station.call.trim() ? 'set your callsign in Settings, STATION' : '',
  setGeo: g => { geo = g; },
};
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
  if (list) list.innerHTML = mon.open.length ? mon.open.map((k, i) => { const hz = mon.first + k * mon.spacing; return `<div class="li tap ${i % 2 ? 'alt' : ''}" data-monk="${k}"><span class="row2"><span>${(hz / 1e6).toFixed(4)} MHz${mon.listening.includes(k) ? ' 🔊' : ''}</span><span>+${Math.round(mon.snr[k])} dB · ${mon.tones[k] ? `CTCSS ${mon.tones[k].toFixed(1)}` : mon.dcs[k] ? `DCS ${String(mon.dcs[k]).padStart(3, '0')}` : '—'} · ${Math.round((mon.since[i] ?? 0) / 1000)}s</span></span></div>`; }).join('') : emptyState('ham');
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
  const bp = q('#ham-bp'), bpKey = `${h.freq}|${h.tone}`; if (bp && bp.dataset.k !== bpKey) { bp.dataset.k = bpKey; bp.innerHTML = hamBandPlanHtml(h.freq); }
  const rep = q('#ham-rep'), rin = repeaterInput(h.freq);
  if (rep) { (rep as HTMLElement).hidden = rin === null || h.mode !== 'NFM'; rep.textContent = 'REV'; rep.title = rin !== null ? `input ${(rin / 1e6).toFixed(4)} MHz` : ''; rep.classList.toggle('on', h.rev); }
  const steps = q('#ham-steps'); if (steps) { const st = band?.step ?? (h.freq < 30e6 ? 500 : 12_500); steps.innerHTML = [[-st * 10], [-st], [st], [st * 10]].map(([s]) => `<button class="chip" data-step="${s}">${s > 0 ? '+' : '−'}${Math.abs(s) >= 1e6 ? `${Math.abs(s) / 1e6}M` : Math.abs(s) >= 1e3 ? `${Math.abs(s) / 1e3}k` : Math.abs(s)}</button>`).join(''); qa<HTMLButtonElement>('[data-step]', steps).forEach(b => b.onclick = () => tune(state.freq + Number(b.dataset.step))); }
  refreshHamMeter();
}
/**
 * The band plan for the band the receiver is in: a strip of its segments with the tuned frequency marked, and each
 * segment as a row (tap one to go there); in a repeater segment, the pair the tuned frequency belongs to.
 */
function hamBandPlanHtml(hz: number): string {
  const b = bandOf(hz);
  const mhz = (v: number) => (v / 1e6).toFixed(v < 30e6 ? 3 : 3);
  if (!b) return `<div class="bp-none">${(hz / 1e6).toFixed(4)} MHz is outside the amateur bands: pick a band above</div>`;
  const span = b.hi - b.lo, at = (v: number) => Math.max(0, Math.min(100, (v - b.lo) / span * 100));
  const inSeg = (s: [number, number, string]) => hz >= s[0] && hz <= s[1];
  const bar = b.segments.map((s, i) => `<i class="s${i % 4}${inSeg(s) ? ' on' : ''}" style="left:${at(s[0]).toFixed(2)}%;width:${Math.max(0.8, at(s[1]) - at(s[0])).toFixed(2)}%"></i>`).join('')
    + `<em style="left:${at(hz).toFixed(2)}%"></em>`;
  const rows = b.segments.map((s, i) => `<button class="bp-row${inSeg(s) ? ' on' : ''}" data-bpf="${s[0] === s[1] ? s[0] : s[0]}"><i class="s${i % 4}"></i><span>${s[0] === s[1] ? mhz(s[0]) : `${mhz(s[0])}–${mhz(s[1])}`}</span><b>${esc(s[2])}</b></button>`).join('');
  const rin = repeaterInput(hz);
  const rep = rin !== null ? `<div class="bp-rep">REPEATER PAIR · out ${(hz / 1e6).toFixed(4)} · in ${(rin / 1e6).toFixed(4)} · ${rin > hz ? '+' : '−'}${Math.abs(rin - hz) / 1e6 >= 1 ? `${Math.abs(rin - hz) / 1e6} MHz` : `${Math.abs(rin - hz) / 1e3} kHz`}${state.ham.tone ? ` · tone ${state.ham.tone.toFixed(1)}` : ''}</div>` : '';
  return `<div class="bp-head"><b>${esc(b.name)}</b><span>${mhz(b.lo)}–${mhz(b.hi)} MHz · ${b.mode}${b.offset ? ` · repeaters ${b.offset > 0 ? '+' : '−'}${Math.abs(b.offset) >= 1e6 ? `${Math.abs(b.offset) / 1e6} MHz` : `${Math.abs(b.offset) / 1e3} kHz`}` : ''}</span></div><div class="bp-bar">${bar}</div>${rep}<div class="bp-rows">${rows}</div>`;
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
      <div class="caption">BAND PLAN · tap a segment to go there</div><div id="ham-bp" class="bandplan"></div>
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
  $('ham-bp').onclick = (e) => { const r = (e.target as HTMLElement).closest<HTMLElement>('[data-bpf]'); if (r) { h.rev = false; hamTune(Number(r.dataset.bpf)); } };
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
      // The PortaPack only reads its serial shell once the host raises DTR. On macOS the system's own serial
      // driver keeps the control interface, so it cannot be claimed and an interface-addressed request is
      // refused; the same requests addressed to the device get through, and without them the command below
      // waits forever.
      const claimed = await d.claimInterface(comm.interfaceNumber).then(() => true, () => false);
      const idx = comm.interfaceNumber;
      const recipient = claimed ? 'interface' as const : 'device' as const;
      await d.controlTransferOut({ requestType: 'class', recipient, request: 0x20, value: 0, index: idx }, new Uint8Array([0x00, 0xc2, 0x01, 0x00, 0, 0, 8])).catch(() => undefined);
      await d.controlTransferOut({ requestType: 'class', recipient, request: 0x22, value: 0x03, index: idx }).catch(() => undefined);
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
    // Never wait on it forever: a board that will not take the command falls through to Web Serial below.
    const sent = await Promise.race([d.transferOut(out.endpointNumber, new TextEncoder().encode('\r\nhackrf\r\n')).then(() => true, () => false), sleepMs(3000).then(() => false)]);
    if (!sent) throw new Error('the PortaPack did not take the command');
    await drain(3000);
    await d.close().catch(() => undefined);
    return true;
  } catch (e) {
    log(`PortaPack over WebUSB: ${(e as Error).message}`);
    await d.close().catch(() => undefined);
    return false;
  }
}
/** When a PortaPack was last told to switch, so the HackRF that comes back is connected without a tap. */
let ppSwitchedAt = 0;
/**
 * The HackRF a PortaPack reboots into is a different USB device to the browser. If this site was never allowed
 * to use it, it cannot connect on its own, so say plainly that one tap is needed, once.
 */
function expectHackRfBack(): void {
  setTimeout(() => { if (!radio?.running && ppSwitchedAt) setStatus('PortaPack is in HackRF mode, tap CONNECT once to allow it', false); }, 12_000);
}
async function portapackToHackRf(d?: USBDevice): Promise<boolean> {
  if (d && (await portapackViaWebUsb(d))) {
    log('PortaPack: sent "hackrf", it is rebooting into HackRF mode and will connect when it comes back.');
    setStatus('PortaPack switching to HackRF mode…', false);
    ppSwitchedAt = Date.now(); expectHackRfBack();
    return true;
  }
  type SerialPortLike = { open: (o: unknown) => Promise<void>; writable: WritableStream<Uint8Array> | null; readable: ReadableStream<Uint8Array> | null; close: () => Promise<void> };
  type SerialPortInfoLike = SerialPortLike & { getInfo?: () => { usbVendorId?: number; usbProductId?: number } };
  const serial = (navigator as unknown as { serial?: { requestPort: (o: unknown) => Promise<SerialPortLike>; getPorts?: () => Promise<SerialPortInfoLike[]> } }).serial;
  if (!serial) { log('PortaPack: this browser has no Web Serial — tap HackRF mode on the PortaPack instead.'); return false; }
  try {
    // A port this origin was already granted needs no chooser and no tap, so a plugged-in PortaPack switches on its own.
    const granted = (await serial.getPorts?.().catch(() => [])) ?? [];
    const port = granted.find(p => { const i = p.getInfo?.(); return i?.usbVendorId === 0x1d50 && i?.usbProductId === 0x6018; })
      ?? await serial.requestPort({ filters: [{ usbVendorId: 0x1d50, usbProductId: 0x6018 }] });
    await port.open({ baudRate: 115200 });
    const r = port.readable?.getReader();
    const reading = (async () => { try { for (;;) { const { done } = await r!.read(); if (done) break; } } catch { /* board rebooted */ } })();
    await sleepMs(300);
    const w = port.writable!.getWriter();
    await w.write(new TextEncoder().encode('\r\nhackrf\r\n'));
    w.releaseLock();
    if (r) { await Promise.race([reading, sleepMs(3000)]); await r.cancel().catch(() => undefined); r.releaseLock(); }
    await port.close().catch(() => undefined);
    log('PortaPack: sent "hackrf", it is rebooting into HackRF mode and will connect when it comes back.');
    setStatus('PortaPack switching to HackRF mode…', false);
    ppSwitchedAt = Date.now(); expectHackRfBack();
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
  // Z-Wave: tuned 420 and 400 kHz below its channels (908.42, 916.00) so neither sits on the radio's DC spike
  ['908.00 · Z-WAVE', 908_000_000],
  ['915.60 · Z-WAVE', 915_600_000],
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
  raw: 'the frame exactly as it arrived, in the usual hex notation for sensor test codes',
  raw_msg: 'the decoded bytes, kept because this family still has bits nobody has explained',
  protocol: 'the number of the decoder that read it',
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
  color_code: 'the DMR color code, which keeps one system from hearing another on the same channel',
  burst: 'the data type of the last burst, from its slot type',
  channels: 'every frequency this color code was heard on',
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

/** A frequency another app (Spectrum) asked the next app to open on, used once. */
let handoffHz: number | null = null;
function takeHandoff(): number | null { const h = handoffHz; handoffHz = null; return h; }
/** The rates this radio does well: an RTL-SDR drops samples above 2.4 Msps. */
function goodRates(): number[] {
  const all = RATE_CHOICES.filter(r => !radio || canSample(radio.limits, r));
  return radio?.kind === 'rtlsdr' ? all.filter(r => r <= 2_400_000) : all;
}
/** Spectrum: its screen lives in spectrum-ui.ts; this is the radio around it. */
const spectrumUi = new SpectrumUi({
  post: (msg, transfer) => ensureWorker().postMessage(msg, transfer ?? []),
  showing: () => state.app === 'spectrum',
  log,
  gain: () => {
    const rtl = rtlRadio();
    return { kind: radio ? radio.kind as 'hackrf' | 'rtlsdr' : 'none', pro: isPro(), lna: state.lna, vga: state.vga, amp: state.amp, tunerDb: rtl ? (rtl.tunerAgc ? NaN : rtlGainDb()) : NaN };
  },
  rates: goodRates,
  connected: () => state.connected,
  start: (tuneHz, rate, cfg) => configure('NONE', tuneHz, rate, 32, 40, true, 'spectrum', { cfg }),
  openApp: (app, hz) => { handoffHz = hz; open(app); },
  openRadio: () => openRadioPanel(),
  dial: () => state.dial || state.radioFreq,
});
function renderSpectrum(view: HTMLElement): void {
  view.innerHTML = spectrumUi.html();
  scope = null;
  spectrumUi.mount(view);
}

/** The Analyzer: its screen lives in analyzer-ui.ts; this is the shell around it, as every receiver has. */
const analyzerUi = new AnalyzerUi({
  center: () => spanCenter(),
  rate: () => state.rate,
  post: (msg, transfer) => ensureWorker().postMessage(msg, transfer ?? []),
  showing: () => state.app === 'analyzer',
  log,
  scope: () => scope,
  empty: (title, tips) => emptyState('analyzer', title, tips),
  // into Transmit's own .sub replay, tuned to the burst; Transmit asks its safety question as it always does
  sendToTx: (sub, hz, fsk) => { txHandoff = { sub, hz, fsk }; open('transmit'); tune(hz); },
});
/** A burst the Analyzer handed to Transmit: its .sub text, where to send it, and whether it was FSK. */
let txHandoff: { sub: string; hz: number; fsk: boolean } | null = null;
function renderAnalyzer(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${presetHtml('BAND', R433_BANDS)}
      ${analyzerUi.html()}
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  analyzerUi.mount(view);
}

function renderR433(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${presetHtml('BAND', R433_BANDS)}
      <div class="ctlrow">${segHtml((['all', 'key', 'remote', 'sensor'] as R433Filter[]).map(f => `<button data-r433f="${f}"></button>`))}<button id="r433-hop" class="tog">HOP</button></div>
      <div id="r433-stats" class="mt-sum"><div>listening&hellip;</div></div>
      <div class="countrow"><span class="count" id="r433-count">0 DEVICES</span><span class="row"><button class="tog" id="r433-ptoggle">PROTOCOLS</button>${pauseClearHtml('devices')}</span></div>
      <div class="mt-stage dv-stage"><div id="r433-list" class="mt-cards dv-cards"></div><div id="r433-detail" class="mt-detail" hidden></div></div>
      <div id="r433-protocols" class="panel devtable" hidden></div>
      <div class="note about">Every burst in the span is tuned to on its own, wherever it lands, and offered to every decoder at once: car keys, gate and garage remotes, tire sensors, weather stations, alarms and hundreds more. Z-Wave networks are read on 908.42 and 916 (the two Z-WAVE bands, or any span that holds them): each card is one network, its controller and nodes. A key that hops between two frequencies is followed on both. 315 and 433.92 are 119 MHz apart, further than any radio here spans, so HOP takes turns. Tire sensors (Schrader, Ford, GM, Toyota and dozens more) repeat about once a minute and wake up when a car moves: 315 in the US, 433.92 in Europe. Tap a card for everything it sent.</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-r433f]', view).forEach(b => b.onclick = () => { state.r433.filter = b.dataset.r433f as R433Filter; state.r433.sel = ''; drawR433(); });
  const pt = $('r433-ptoggle');
  pt.onclick = () => { state.r433.showProtocols = !state.r433.showProtocols; drawR433(); };
  const hop = $('r433-hop');
  hop.classList.toggle('on', state.r433.hop);
  hop.onclick = () => { state.r433.hop = !state.r433.hop; r433Hop(); render('devices'); };
  $('r433-list').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-dv]'); if (c) { state.r433.sel = state.r433.sel === c.dataset.dv ? '' : c.dataset.dv!; drawR433(); } };
  $('r433-detail').onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dvdo]'); if (!b) return; if (b.dataset.dvdo === 'close') { state.r433.sel = ''; drawR433(); } };
  r433Hop();
  clearInterval(r433Tick);
  // ages and the live dots run on between readings
  r433Tick = window.setInterval(() => { if (state.app !== 'devices') { clearInterval(r433Tick); return; } refreshR433(); }, 1000);
  drawR433();
}
let r433Tick = 0;

type R433Filter = 'all' | 'key' | 'remote' | 'sensor';
type R433Kind = 'CAR KEY' | 'REMOTE' | 'TIRE SENSOR' | 'WEATHER' | 'SECURITY' | 'METER' | 'SENSOR' | 'Z-WAVE' | 'RADIO';
/** What a card calls the thing, from who decoded it and what its protocol says it is. */
function r433Kind(d: HeardDevice): R433Kind {
  if (d.family === 'key') return 'CAR KEY';
  if (d.family === 'remote') return 'REMOTE';
  if (d.family === 'weather') return 'WEATHER';
  if (d.family === 'zwave') return 'Z-WAVE';
  if (d.family === 'radio') return 'RADIO';
  const t = `${d.model} ${d.what} ${d.data.type ?? ''}`.toLowerCase();
  if (/tpms|tire|tyre/.test(t)) return 'TIRE SENSOR';
  if (/weather|thermo|temperature|humidity|rain|wind|lightning|hygro|soil|pool|bbq|meat|grill/.test(t)) return 'WEATHER';
  if (/door|window|motion|pir|smoke|alarm|security|leak|water|glass|siren|contact/.test(t)) return 'SECURITY';
  if (/meter|energy|power|gas|current|consumption|ert/.test(t)) return 'METER';
  if (/remote|switch|button|doorbell|bell|keyfob|key fob|gate|garage|blind|shutter|outlet|plug|dimmer/.test(t)) return 'REMOTE';
  return 'SENSOR';
}
const R433_GROUP: Record<R433Kind, R433Filter> = { 'CAR KEY': 'key', REMOTE: 'remote', 'TIRE SENSOR': 'sensor', WEATHER: 'sensor', SECURITY: 'sensor', METER: 'sensor', SENSOR: 'sensor', 'Z-WAVE': 'sensor', RADIO: 'all' };
const R433_FILTER_LABEL: Record<R433Filter, string> = { all: 'ALL', key: 'KEYS', remote: 'REMOTES', sensor: 'SENSORS' };
/** How long a device counts as live: a key or remote is a press, a sensor reports every half minute or so. */
const r433LiveMs = (k: R433Kind) => (k === 'CAR KEY' || k === 'REMOTE' ? 15_000 : 120_000);
function r433Ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ago`;
}
const r433Mhz = (hz: number) => `${(hz / 1e6).toFixed(3)} MHz`;
const r433Num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null);
/** The big line on a card: what this thing just said, in the fewest words. */
function r433Headline(d: HeardDevice, k: R433Kind): [string, string] {
  const v = d.data;
  if (k === 'Z-WAVE') { const n = (v.nodes as ZwNode[] | undefined)?.length ?? 0; return [`${n} node${n === 1 ? '' : 's'}`, `${v.from} → ${v.to} ${v.said}`]; }
  if (k === 'RADIO') return [`CC ${v.color_code}`, `${v.burst} from ${v.from}`];
  if (k === 'CAR KEY' || k === 'REMOTE') return [String(v.button ?? v.btn ?? v.cmd ?? v.state ?? 'PRESS'), v.counter !== undefined ? `counter ${v.counter}` : v.hop !== undefined ? `code ${String(v.hop).slice(0, 8)}` : ''];
  const kpaRaw = r433Num(v.pressure_kPa), psiRaw = r433Num(v.pressure_PSI), barRaw = r433Num(v.pressure_bar);
  const tcRaw = r433Num(v.temperature_C), tfRaw = r433Num(v.temperature_F);
  const tc = tcRaw !== null ? tcRaw : tfRaw !== null ? (tfRaw - 32) * 5 / 9 : null;
  if (k === 'TIRE SENSOR') {
    const psi = psiRaw !== null ? psiRaw : kpaRaw !== null ? kpaRaw * 0.1450377 : barRaw !== null ? barRaw * 14.50377 : null;
    return [psi !== null ? `${psi.toFixed(1)} psi` : 'TIRE', tc !== null ? `${(tc * 9 / 5 + 32).toFixed(0)} °F` : ''];
  }
  if (tc !== null) return [`${(tc * 9 / 5 + 32).toFixed(1)} °F`, v.humidity !== undefined ? `${v.humidity}% humidity` : ''];
  if (typeof v.temperature === 'string') return [v.temperature.split(' · ').pop() ?? v.temperature, v.humidity !== undefined ? `${v.humidity} humidity` : ''];
  const sum = r433Summary(v).split(' · ');
  return [sum[0] || k, sum.slice(1).join(' · ')];
}
function r433Card(d: HeardDevice & { hz?: number }, now: number): string {
  const k = r433Kind(d), age = now - d.lastSeen, live = age < r433LiveMs(k);
  const flash = Math.max(0, 1 - age / 2500);
  const [big, sub] = r433Headline(d, k);
  const id = d.data.id !== undefined ? String(d.data.id) : '';
  return `<div class="mt-card dv-card k-${k.replace(/ /g, '').toLowerCase()} ${state.r433.sel === d.key ? 'sel' : ''} ${live ? '' : 'dim'}" data-dv="${esc(d.key)}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="dv-glyph">${R433_GLYPH[k]}</span><span class="mt-k"><b>${k}</b>${d.model.toUpperCase() === k ? '' : `<small>${esc(d.model)}</small>`}${id ? `<i>ID ${esc(id)}</i>` : ''}</span><span class="mt-live ${live ? 'on' : ''}"><i></i>${live ? 'LIVE' : r433Ago(age)}</span></div>`
    + `<div class="mt-clk"><b>${esc(big)}</b><small>${esc(sub)}</small><em>${d.count}×</em></div>`
    + `<div class="dv-foot"><span>${k === 'Z-WAVE' ? `${((d.data.channels as number[] | undefined) ?? []).map(c => c.toFixed(2)).join(' · ')} MHz` : k === 'RADIO' ? esc(String(d.data.channels)) : d.hz ? r433Mhz(d.hz) : ''}</span><span>${live ? r433Ago(age) : r433Clock(d.lastSeen)}</span></div></div>`;
}
const R433_GLYPH: Record<R433Kind, string> = {
  'CAR KEY': '<svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="4.5"/><path d="M12.5 12H21v3M18 12v2.5"/></svg>',
  REMOTE: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="3"/><circle cx="12" cy="8.5" r="1.6"/><path d="M10 14h4M10 17h4"/></svg>',
  'TIRE SENSOR': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5"/></svg>',
  WEATHER: '<svg viewBox="0 0 24 24"><path d="M10 4v10.5a3.5 3.5 0 1 0 4 0V4a2 2 0 0 0-4 0z"/><path d="M12 9v7"/></svg>',
  SECURITY: '<svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/></svg>',
  METER: '<svg viewBox="0 0 24 24"><path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/></svg>',
  'Z-WAVE': '<svg viewBox="0 0 24 24"><path d="M4 11l8-6.5 8 6.5M6.5 9.5V19h11V9.5"/><circle cx="12" cy="14.5" r="1.4"/><path d="M9.6 12.1a3.4 3.4 0 0 1 4.8 0"/></svg>',
  RADIO: '<svg viewBox="0 0 24 24"><rect x="7.5" y="8" width="9" height="13" rx="2"/><path d="M10 8V3M10 12h4M10 15h4"/></svg>',
  SENSOR: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
};
const ZW_RATE: Record<string, string> = { R1: 'R1 9.6 kb/s', R2: 'R2 40 kb/s', R3: 'R3 100 kb/s' };
/** Seconds as the poll interval reads best. */
const zwEvery = (s: number) => (s < 120 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`);
/** One Z-Wave network: its nodes, who talks to whom, the last frame raw, and every frame heard. */
function zwDetailFields(d: HeardDevice & { hz?: number }): [string, string, string?][] {
  const v = d.data, nodes = (v.nodes as ZwNode[] | undefined) ?? [], links = (v.links as ZwLink[] | undefined) ?? [];
  const f: [string, string, string?][] = [['HOME ID', String(v.id), 'the network ID every node in it shares']];
  for (const n of nodes) {
    const parts = [(n.rates.length ? n.rates : [n.rate]).map(r => `${ZW_RATE[r] ?? r} · ${r === 'R3' ? '916.00' : '908.42'} MHz`).join(', '), n.snr !== null ? `SNR ${n.snr.toFixed(1)} dB` : 'only heard being polled', `last ${r433Clock(n.lastSeen)}`];
    if (n.poll !== null) parts.push(`polled every ${zwEvery(n.poll)}`);
    if (n.last) parts.push(n.last);
    f.push([n.controller ? `CONTROLLER ${n.id}` : `NODE ${n.id}`, parts.join(' · '), n.controller ? 'the node that polls and commands the others' : '']);
  }
  for (const l of links) f.push([`${l.from} → ${l.to}`, `${l.frames} frame${l.frames === 1 ? '' : 's'} · last ${l.last}`, 'frames from one node to another']);
  f.push(['LAST FRAME', `${v.from} → ${v.to} ${v.said} · SNR ${Number(v.snr).toFixed(1)} dB`]);
  f.push(['RAW', String(v.raw), 'the frame as it arrived, home ID first, its check last']);
  f.push(['MODULATION', `FSK, ${ZW_RATE[String(v.rate)] ?? v.rate}${v.rate === 'R1' ? ' Manchester' : ' NRZ'}`]);
  f.push(['DECODER', 'Z-Wave, ITU-T G.9959, kept only when the frame check passes']);
  f.push(['HEARD', `${d.count} frame${d.count === 1 ? '' : 's'} · first ${r433Clock(d.firstSeen)} · last ${r433Clock(d.lastSeen)}`]);
  return f;
}
function r433Fields(d: HeardDevice & { hz?: number }, doubtful: boolean): [string, string, string?][] {
  const fields: [string, string, string?][] = [];
  for (const [key, v] of Object.entries(d.data)) {
    if (key === 'model') continue;
    fields.push([key.replace(/_/g, ' ').toUpperCase(), r433Value(key, v), R433_MEANING[key] ?? '']);
  }
  if (d.hz) fields.push(['FREQUENCY', `${r433Mhz(d.hz)} (${d.offsetHz >= 0 ? '+' : ''}${(d.offsetHz / 1e3).toFixed(0)} kHz from the dial)`]);
  if (d.family === 'radio') {
    fields.push(['MODULATION', '4-level FSK, 4800 symbols a second']);
    fields.push(['DECODER', 'DMR sync and slot type, kept only when the Golay check passes, with the full decode in Dispatch']);
  } else {
    fields.push(['MODULATION', d.family === 'sensor' ? (d.fsk ? 'FSK (frequency shift)' : 'OOK (on-off)') : 'OOK or FSK, both are tried']);
    fields.push(['DECODER', d.family === 'key' ? 'car keys' : d.family === 'sensor' ? `protocol ${d.num} · ${d.what}` : d.family === 'remote' ? 'gate and garage remotes' : 'weather sensors']);
  }
  fields.push(['HEARD', `${d.count} time${d.count === 1 ? '' : 's'} · first ${r433Clock(d.firstSeen)} · last ${r433Clock(d.lastSeen)}`]);
  if (doubtful) fields.push(['NOTE', 'this protocol has no checksum, so nothing in the frame proves the reading']);
  return fields;
}
function r433DetailPanel(d: HeardDevice & { hz?: number }, doubtful: boolean): string {
  const k = r433Kind(d);
  const fields = k === 'Z-WAVE' ? zwDetailFields(d) : r433Fields(d, doubtful);
  const hist = state.r433.hist.get(d.key) ?? [];
  const rows = hist.slice().reverse().map(h => `<div><b>${r433Clock(h.t)}</b><span>${esc(h.s)}${h.hz ? ` · ${r433Mhz(h.hz)}` : ''}</span></div>`).join('');
  return `<div class="mt-dh"><b>${esc(d.data.id !== undefined ? String(d.data.id) : d.model)}</b><span>${d.model.toUpperCase() === k ? k : `${k} · ${esc(d.model)}`}</span><button class="chip" data-dvdo="close">✕</button></div>`
    + `<div class="mt-fields">${fields.map(([a, b, m]) => `<div${m ? ` title="${esc(m)}"` : ''}><b>${esc(a)}</b><span>${esc(b)}</span></div>`).join('')}`
    + (rows ? `<p>EVERY TIME IT WAS HEARD</p>${rows}` : '') + '</div>';
}
/** One line per reading for the history in the detail panel. */
function r433HistLine(d: HeardDevice): string {
  if (d.family === 'zwave') return `${d.data.from} → ${d.data.to} ${d.data.said} · ${Number(d.data.snr).toFixed(1)} dB · ${d.data.raw}`;
  const k = r433Kind(d), [a, b] = r433Headline(d, k);
  return [a, b].filter(Boolean).join(' · ') || r433Summary(d.data);
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

function drawR433(): void {
  const r = state.r433;
  const st = q('#r433-stats');
  if (st) {
    const s = r.stats;
    const lo = (state.freq - (s?.span ?? state.rate) / 2) / 1e6, hi = (state.freq + (s?.span ?? state.rate) / 2) / 1e6;
    st.innerHTML = s
      ? `<div>WATCHING ${lo.toFixed(2)}–${hi.toFixed(2)} MHz${s.zwave?.length ? ` · Z-WAVE ${s.zwave.map(c => c.toFixed(2)).join(', ')}` : ''}${s.channels ? ` · TUNED TO ${s.channels} BURST${s.channels === 1 ? '' : 'S'} NOW` : ''}</div>`
        + `<div class="muted">${s.followed} bursts followed · ${s.decoded} decoded · ${s.protocols} sensor protocols and every car key and remote run on each${s.badChecksum ? ` · ${s.badChecksum} near misses` : ''}</div>`
      : '<div>listening…</div>';
  }
  const c = q('#r433-count');
  // Whichever list is showing is what this counts. Saying "4 devices" over a list of 82 protocols was simply
  // describing the wrong thing.
  if (c) {
    c.textContent = r.showProtocols
      ? `${r.protocols.length} PROTOCOLS · ALL RUNNING`
      : `${r.heard.length} DEVICE${r.heard.length === 1 ? '' : 'S'}`;
  }
  drawR433Protocols();
  const el = q('#r433-list');
  if (!el) return;
  (el as HTMLElement).hidden = r.showProtocols;
  if (r.showProtocols || paused.has('devices')) return;
  const now = Date.now();
  const doubtful = new Set(r.protocols.filter(p => p.doubtful).map(p => p.num));
  qa<HTMLButtonElement>('[data-r433f]').forEach(b => {
    const f = b.dataset.r433f as R433Filter;
    const n = f === 'all' ? r.heard.length : r.heard.filter(d => R433_GROUP[r433Kind(d)] === f).length;
    b.classList.toggle('on', r.filter === f);
    b.textContent = `${R433_FILTER_LABEL[f]} ${n}`;
  });
  const shown = r.heard.filter(d => r.filter === 'all' || R433_GROUP[r433Kind(d)] === r.filter);
  if (!shown.length) {
    el.innerHTML = r.heard.length ? emptyState('devices', `No ${R433_FILTER_LABEL[r.filter].toLowerCase()} yet`, ['Others have been heard: ALL shows them']) : emptyState('devices');
  } else {
    const top = el.scrollTop;
    el.innerHTML = [...shown].sort((a, b) => b.lastSeen - a.lastSeen).map(d => r433Card(d, now)).join('');
    el.scrollTop = top;
  }
  const det = q('#r433-detail') as HTMLElement | null;
  if (det) {
    const sel = r.heard.find(d => d.key === r.sel);
    det.hidden = !sel;
    if (sel) { const top = det.scrollTop; det.innerHTML = r433DetailPanel(sel, doubtful.has(sel.num)); det.scrollTop = top; }
  }
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
      + `<div class="p-name"><b>${esc(p.name)}</b>${p.num ? `<i>${p.num}</i>` : ''}${p.doubtful ? '<i class="tag q" title="no checksum, so a reading from it is worth a second look">?</i>' : ''}</div>`
      + (p.what ? `<div class="p-what">${esc(p.what)}</div>` : '')
      + `<div class="p-meta">${esc(p.coding)}${p.bands.length ? ` · ${p.bands.map(b => b.toFixed(2)).join(', ')} MHz` : ''}${p.doubtful ? ' · no checksum, so it can misread other traffic; it runs anyway' : ''}</div>`
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
  if (m.page.cap >= 0) hunt.caps.add(m.page.cap);   // a ReFLEX frame card has no capcode
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
  if (tg) tg.innerHTML = `<button class="pill ${hunt.protocol !== 'POCSAG' ? 'on' : ''}" data-ht="flex">FLEX ${flexN}</button><button class="pill ${hunt.protocol !== 'FLEX' ? 'on' : ''}" data-ht="pocsag">POCSAG ${msgs.filter(m => m.page.protocol === 'POCSAG').length}</button><button class="pill ${hunt.fold ? 'on' : ''}" data-ht="fold">FOLD</button>`
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
      + `<div class="pc-m">${p.cap >= 0 ? `<button class="${hunt.capcode === p.cap ? 'on' : ''}" data-hcap="${p.cap}">CAP ${p.cap}${caps.size > 1 ? ` +${caps.size - 1}` : ''}</button>` : `<span class="pc-w">${esc(p.where)}</span>`}<button class="hz ${hunt.hz === m.hz ? 'on' : ''}" data-hhz="${m.hz}">${(m.hz / 1e6).toFixed(4)}</button></div>`
      + `<div class="pc-body ${p.text.trim() ? '' : 'muted'}">${esc(body)}</div></div>`;
  }).join('');
  if (atTop) feed.scrollTop = 0;
}
setInterval(() => { if (state.app === 'pager' && state.pagerMulti) refreshHunt(); }, 20_000);

function renderPacket(view: HTMLElement, app: AppId): void {
  let controls = '';
  switch (app) {
    case 'pager': controls = `<div class="row">${(['flex', 'pocsag', 'both'] as const).map(w => `<button class="chip" data-pager="${w}">${w === 'both' ? 'FLEX + POCSAG' : w.toUpperCase()}</button>`).join('')}</div>` + presetHtml('CHANNEL · MHz', [['929.6125', 929_612_500], ['929.6625', 929_662_500], ['931.9375', 931_937_500], ['466.175', 466_175_000]]) + stepHtml([1e5, 12_500, 2_500]); break;
    case 'acars': controls = presetHtml('CHANNEL · MHz', [['131.550 US', 131_550_000], ['131.525 EU', 131_525_000], ['131.725 EU2', 131_725_000], ['131.450 JP', 131_450_000], ['130.025', 130_025_000]]) + `<div class="note">Registration, flight, label and text from each message, CRC checked.</div>`; break;
    case 'subghz': controls = presetHtml('BAND · MHz', [['433.92', 433_920_000], ['315.00', 315_000_000], ['868.35', 868_350_000], ['915.00', 915_000_000], ['303.875', 303_875_000]]) + `<div class="row">${(['weather', 'remotes', 'cars'] as const).map(f => `<button class="chip" data-ism="${f}">${f === 'weather' ? `WEATHER ${ISM_COUNTS.weather}` : f === 'remotes' ? `REMOTES ${ISM_COUNTS.remotes}` : `CAR KEYS ${ISM_COUNTS.cars}`}</button>`).join('')}</div>`; break;
    case 'btle': controls = `<div class="row">${[37, 38, 39].map(ch => `<button class="chip" data-btle="${ch}">CH ${ch} · ${btleChannelFreq(ch) / 1e6}</button>`).join('')}</div>`; break;
  }
  // A radio that cannot reach this app's band says so right on the screen, not just in a passing status line.
  const why = radio ? blockedBecause(APP_NEEDS[app], radio.limits) : '';
  if (why) controls = `<div class="note warn">${esc(radio!.label)} cannot receive this: ${esc(why)}. Nothing will decode here. A HackRF covers 1 MHz to 6 GHz.</div>` + controls;
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">${controls}${logHtml(app, why ? 'out of range for this radio' : 'listening…')}</section>`;
  scope = attach(app === 'btle' ? new Scope($('scope'), 0, { rows: 80, spectrumHeight: 70 }) : tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-ism]', view).forEach(b => { const f = b.dataset.ism as keyof typeof state.ism; b.classList.toggle('on', state.ism[f]); b.onclick = () => { state.ism[f] = !state.ism[f]; b.classList.toggle('on', state.ism[f]); worker?.postMessage({ type: 'ismFamilies', ...state.ism }); }; });
  qa<HTMLButtonElement>('[data-pager]', view).forEach(b => { b.classList.toggle('on', b.dataset.pager === state.pager); b.onclick = () => { state.pager = b.dataset.pager as typeof state.pager; worker?.postMessage({ type: 'pager', which: state.pager }); qa('[data-pager]').forEach(x => x.classList.toggle('on', x === b)); }; });
  qa<HTMLButtonElement>('[data-btle]', view).forEach(b => b.onclick = () => { state.btleCh = Number(b.dataset.btle); worker?.postMessage({ type: 'btleChannel', ch: state.btleCh }); tune(btleChannelFreq(state.btleCh)); refreshBtle(); });
  refreshList(app); refreshAis(); refreshBtle();
}

// ---- BLE RX: one card per advertiser, the raw log one tap away -----------------------------------------------
/** The BLE screen: CARDS shows one card per device (name, maker, type, signal, packets, last heard), a tap opens every
 *  field and its raw advertisements; LOG is the decoder's line per packet. A tracker-type device that stays with you
 *  raises an alert on its card and in the banner. */
const bleUi = { tracker: new BleTracker(), view: 'cards' as 'cards' | 'log', sel: '', drawn: 0, pending: 0, timer: 0, watch: -1, pos: null as { lat: number; lon: number } | null };
const bleAgo = (ms: number) => ms < 2_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`;
/** Live while it keeps advertising: phones and tags send several times a second, so ten quiet seconds means gone. */
const BLE_LIVE_MS = 10_000;
function bleCard(d: BleDevice, now: number): string {
  const age = now - d.lastMs, live = age < BLE_LIVE_MS, flash = Math.max(0, 1 - age / 700);
  const title = d.name || KIND_LABEL[d.kind];
  return `<div class="mt-card ble ${bleUi.sel === d.mac ? 'sel' : ''} ${live ? '' : 'dim'} ${d.alert ? 'alert' : ''}" data-ble="${esc(d.mac)}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="ble-k ${d.tracker ? 'trk' : ''}">${esc(KIND_LABEL[d.kind].toUpperCase())}</span><span class="mt-k"><b>${esc(title)}</b><small>${esc(d.maker || 'unknown maker')}${d.name ? ` · ${esc(KIND_LABEL[d.kind])}` : ''}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${live ? 'LIVE' : bleAgo(age)}</span></div>`
    + (d.alert ? `<div class="ble-warn">⚠ ${esc(d.alert)}</div>` : '')
    + `<div class="mt-clk"><b>${d.rssi[d.rssi.length - 1] ?? '—'} dB</b><small>SIGNAL</small><em>${d.count} packets</em></div>`
    + meshSpark(d.rssi, true, '')
    + `<div class="mt-hex">${esc(d.mac)} · ${d.random ? 'random' : 'public'} · first ${bleAgo(now - d.firstMs)}</div></div>`;
}
function bleDetail(d: BleDevice, now: number): string {
  const rows = [...d.history].reverse().map(h => `<div><span>${new Date(h.ms).toLocaleTimeString()}</span><span>CH ${h.ch}</span><span>${Math.round(h.db)} dB</span><span>${esc(h.pduType)}</span><code>${esc(h.raw)}</code></div>`).join('');
  const more = [{ name: 'First heard', value: `${trClock(d.firstMs)} · ${bleAgo(now - d.firstMs)}` }, { name: 'Last heard', value: `${trClock(d.lastMs)} · ${bleAgo(now - d.lastMs)}` },
    ...(d.firstPos ? [{ name: 'Moved with you', value: `${Math.round(d.movedM)} m` }] : [])];
  return `<div class="mt-dh ${d.alert ? 'red' : ''}"><b>${esc(d.name || KIND_LABEL[d.kind])}</b><span>${esc(d.maker || 'UNKNOWN MAKER')} · ${esc(KIND_LABEL[d.kind].toUpperCase())}</span><button class="chip" data-bdo="close">✕</button></div>`
    + (d.alert ? `<div class="ble-warn">⚠ ${esc(d.alert)}. Look for it in your bag, car or clothes, or check it with a tracker-finder app.</div>` : '')
    + `<div class="mt-fields">${[...d.fields, ...more].map(f => `<div><b>${esc(f.name)}</b><span>${esc(f.value)}</span></div>`).join('')}</div>`
    + `<div class="caption">RAW ADVERTISEMENTS · newest first · ${d.history.length} kept</div><div class="ble-raw">${rows}</div>`;
}
function renderBle(view: HTMLElement): void {
  const why = radio ? blockedBecause(APP_NEEDS.btle, radio.limits) : '';
  view.innerHTML = `
    <section class="${visCls('btle')}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">${why ? `<div class="note warn">${esc(radio!.label)} cannot receive this: ${esc(why)}. Nothing will decode here. A HackRF covers 1 MHz to 6 GHz.</div>` : ''}
      <div class="row">${[37, 38, 39].map(ch => `<button class="chip" data-btle="${ch}">CH ${ch} · ${btleChannelFreq(ch) / 1e6}</button>`).join('')}</div>
      <div id="ble-alert" class="ble-warn big" hidden></div>
      <div class="ctlrow">${segHtml(['cards', 'log'].map(v => `<button data-bleview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('btle')}${pauseClearHtml('btle')}</div>
      <div id="ble-stage" class="mt-stage"><div id="ble-cards" class="mt-cards"></div><div id="ble-detail" class="mt-detail" hidden></div></div>
      <div id="ble-log">${logHtml('btle', 'listening…')}</div>
      <div class="note about">One card per device, by its address: the maker from its manufacturer ID, the type from what it advertises (Find My, Tile, SmartTag, Find Hub, iBeacon, Eddystone, Fast Pair, AirPods, phones, watches). A tracker that stays near you for 20 minutes, or is still there after you move 500 m (with location allowed), is flagged. Phones and tags change their random address every 15 minutes or so, so one phone can show up as several cards over time.</div>
    </section>`;
  scope = attach(new Scope($('scope'), 0, { rows: 80, spectrumHeight: 70 }));
  qa<HTMLButtonElement>('[data-btle]', view).forEach(b => b.onclick = () => { state.btleCh = Number(b.dataset.btle); worker?.postMessage({ type: 'btleChannel', ch: state.btleCh }); tune(btleChannelFreq(state.btleCh)); refreshBtle(); });
  qa<HTMLButtonElement>('[data-bleview]', view).forEach(b => b.onclick = () => { bleUi.view = b.dataset.bleview as typeof bleUi.view; refreshBle(true); });
  $('ble-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-ble]'); if (c) { bleUi.sel = bleUi.sel === c.dataset.ble ? '' : c.dataset.ble!; refreshBle(true); } };
  $('ble-detail').onclick = (e) => { if ((e.target as HTMLElement).closest('[data-bdo="close"]')) { bleUi.sel = ''; refreshBle(true); } };
  // where you are, so a tracker still heard after you have moved is flagged too; only when location is already allowed
  if (bleUi.watch < 0 && 'geolocation' in navigator && navigator.permissions) {
    void navigator.permissions.query({ name: 'geolocation' as PermissionName }).then(p => {
      if (p.state === 'granted' && bleUi.watch < 0) bleUi.watch = navigator.geolocation.watchPosition(x => { bleUi.pos = { lat: x.coords.latitude, lon: x.coords.longitude }; }, () => undefined, { maximumAge: 30_000 });
    }).catch(() => undefined);
  }
  clearInterval(bleUi.timer);
  // ages and live dots run on between packets
  bleUi.timer = window.setInterval(() => {
    if (state.app !== 'btle') { clearInterval(bleUi.timer); if (bleUi.watch >= 0) { navigator.geolocation.clearWatch(bleUi.watch); bleUi.watch = -1; } return; }
    refreshBle();
  }, 1000);
  refreshList('btle'); refreshBtle(); refreshBle(true);
}
function onBleAdv(m: { pdu: number[]; db: number; ch: number }): void {
  const a = parseAdv(m.pdu, m.db, m.ch); if (!a) return;
  bleUi.tracker.add(a, Date.now(), bleUi.pos);
  if (state.app === 'btle') refreshBle();
}
function refreshBle(force = false): void {
  if (state.app !== 'btle') return;
  const now = Date.now();
  if (!force && now - bleUi.drawn < 240) { clearTimeout(bleUi.pending); bleUi.pending = window.setTimeout(() => refreshBle(true), 250); return; }
  bleUi.drawn = now;
  const devs = bleUi.tracker.list(), alerts = devs.filter(d => d.alert);
  qa<HTMLButtonElement>('[data-bleview]').forEach(b => { const v = b.dataset.bleview; b.classList.toggle('on', v === bleUi.view); b.textContent = v === 'cards' ? `DEVICES ${devs.length}` : `LOG ${counts.btle ?? 0}`; });
  const stage = q('#ble-stage'), cards = q('#ble-cards'), det = q('#ble-detail'), logEl = q('#ble-log'), banner = q('#ble-alert');
  if (!stage || !cards || !det || !logEl || !banner) return;
  stage.hidden = bleUi.view !== 'cards'; logEl.hidden = bleUi.view !== 'log';
  banner.hidden = !alerts.length;
  if (alerts.length) banner.textContent = alerts.length === 1 ? `⚠ ${alerts[0].alert}` : `⚠ ${alerts.length} TRACKERS ARE STAYING NEAR YOU`;
  if (bleUi.view === 'cards' && !paused.has('btle')) {
    const top = cards.scrollTop;
    cards.innerHTML = devs.length ? devs.map(d => bleCard(d, now)).join('') : emptyState('btle');
    cards.scrollTop = top;
  }
  const picked = bleUi.tracker.devices.get(bleUi.sel);
  det.hidden = !picked;
  if (picked) { const top = det.scrollTop; det.innerHTML = bleDetail(picked, now); det.scrollTop = top; }
  if (alerts.length) setLamp(`${alerts.length} TRACKER${alerts.length === 1 ? '' : 'S'}`, 'red');
  else if (devs.length) setLamp(`${devs.length} DEVICE${devs.length === 1 ? '' : 'S'}`, 'ok');
}

// ---- ACARS and VDL2: one card per aircraft (VDL2: by ICAO address, ACARS or not), a map, the activity, the log ----
type AcarsView = 'cards' | 'map' | 'stats' | 'log';
type AcarsUi = { planes: AcarsPlanes; stats: AcarsStats; vdl: Vdl2Tracker; view: AcarsView; sel: string; drawn: number; pending: number; timer: number };
const newAcarsUi = (): AcarsUi => ({ planes: new AcarsPlanes(), stats: new AcarsStats(), vdl: new Vdl2Tracker(acLookup), view: 'cards', sel: '', drawn: 0, pending: 0, timer: 0 });
/** ACARS and VDL2 share these screens (VDL2 carries ACARS messages), each with its own aircraft. */
const acarsUis = { acars: newAcarsUi(), vdl2: newAcarsUi() };
type AcarsApp = keyof typeof acarsUis;
const acarsApp = (): AcarsApp => state.app === 'vdl2' ? 'vdl2' : 'acars';
/** The ACARS channels the presets offer (counted even before anything is heard on them). */
const ACARS_CHANNELS = ['131.550', '131.525', '131.725', '131.450', '130.025'];
/** An airport from the bundled list (loaded with the UAT one), for the message readers, the stations and the map. */
function acLookup(id: string): Airport | undefined { const a = uatAirports?.get(id); return a ? { ident: id, lat: a[0], lon: a[1], name: a[2] } : undefined; }
/** Each message's reading, kept until the airports or home change. */
const acInsights = new WeakMap<AcarsMsg, { v: string; i: MsgInsight }>();
function acInsight(m: AcarsMsg): MsgInsight {
  const v = `${uatAirports?.size ?? 0}|${state.home ? `${state.home.lat.toFixed(1)},${state.home.lon.toFixed(1)}` : ''}`;
  const c = acInsights.get(m); if (c && c.v === v) return c.i;
  const i = msgInsight(m, acLookup, state.home);
  acInsights.set(m, { v, i }); return i;
}
/** One aircraft as the cards, the map and the panel show it: an ACARS record, a VDL2 address, or both. */
interface AcRow { key: string; reg: string; flight: string; icao: string; firstMs: number; lastMs: number; msgs: AcarsMsg[]; vdl?: VdlAircraft; ins: PlaneInsight; airline: string }
function acRows(ui: AcarsUi, vdl: boolean): AcRow[] {
  const mk = (key: string, reg: string, flight: string, icao: string, firstMs: number, lastMs: number, msgs: AcarsMsg[], v?: VdlAircraft): AcRow =>
    ({ key, reg, flight, icao, firstMs, lastMs, msgs, vdl: v, ins: planeInsight(msgs, acInsight), airline: airlineOf(flight) });
  if (!vdl) return ui.planes.list().map(p => mk(p.key, p.reg, p.flight, p.icao, p.firstMs, p.lastMs, p.msgs));
  return ui.vdl.list().map(a => { const p = acarsFor(a, ui.planes.planes); return mk(`A:${a.addr}`, a.reg || p?.reg || '', a.flight || p?.flight || '', a.addr, a.firstMs, a.lastMs, p?.msgs ?? [], a); });
}
/** The same aircraft in the ADS-B list: VDL2 by its own address; ACARS by the ICAO address a US registration gives,
 *  the registration looked up for an ADS-B aircraft, or the flight number against its callsign. */
function acarsAdsbMatch(p: { icao: string; reg: string; flight: string; vdl?: VdlAircraft }): Aircraft | undefined {
  if (p.vdl) return state.aircraft.find(a => a.icao.toUpperCase() === p.icao);
  const reg = normReg(p.reg), fl = p.flight.replace(/\s/g, '').toUpperCase();
  return state.aircraft.find(a => (p.icao !== '' && a.icao.toUpperCase() === p.icao)
    || (reg !== '' && normReg(acInfo.get(a.icao)?.reg ?? '') === reg)
    || (fl !== '' && (a.flight ?? '').replace(/\s/g, '').toUpperCase() === fl));
}
/** Where an aircraft is: only the newest position its own messages gave (the radio hears one band at a time, so
 *  nothing here comes from ADS-B). */
function acWhere(r: AcRow): { lat: number; lon: number; ms: number } | null {
  return r.ins.pos ? { lat: r.ins.pos.lat, lon: r.ins.pos.lon, ms: r.ins.posMs } : null;
}
const acTitle = (r: AcRow) => r.reg || r.flight || r.icao;
const acChip = (text: string, cls = '') => `<span class="ac-chip ${cls}">${esc(text)}</span>`;
const acSnr = (n: number) => `${n >= 0 ? '+' : ''}${n} dB`;
function acarsCard(r: AcRow, now: number, sel: string): string {
  const age = now - r.lastMs, live = age < 120_000, flash = Math.max(0, 1 - age / 700), last = r.msgs[0], v = r.vdl;
  const ads = acarsAdsbMatch(r), li = r.ins.last, nums = numChips(r.ins.nums);
  const head = r.airline ? `${r.airline.toUpperCase()}${r.flight ? ` · ${r.flight}` : ''}` : r.flight && (r.reg || v) ? `FLIGHT ${r.flight}` : r.reg ? 'NO FLIGHT NUMBER' : v ? 'NO ACARS YET' : 'NO REGISTRATION';
  const sub = [r.ins.orig ? `${r.ins.orig} → ${r.ins.dest}` : '', r.icao ? `ICAO ${r.icao}` : '', ads ? 'ON ADS-B' : ''].filter(Boolean).join(' · ');
  const count = v ? v.frames : r.msgs.length;
  const what = v ? `FRAME${count === 1 ? '' : 'S'} · ${v.acars} ACARS · ${acSnr(v.snr)}` : `MESSAGE${count === 1 ? '' : 'S'} · LAST ${last?.label ?? ''}`;
  const mhz = v ? (v.hz / 1e6).toFixed(3) : last?.mhz ?? '';
  const chips = [li ? acChip(kindLabelOf(li.kind), 'k') : '', r.ins.phase ? acChip(r.ins.phase, 'ph') : '', r.ins.pos ? acChip(`POS ${bleAgo(now - r.ins.posMs)}`) : '',
    v?.station ? acChip(`GS ${v.station}`) : '', ...r.ins.airports.filter(a => a !== r.ins.orig && a !== r.ins.dest).slice(0, 3).map(a => acChip(a))].join('');
  return `<div class="mt-card ${sel === r.key ? 'sel' : ''} ${live ? '' : 'dim'}" data-acp="${esc(r.key)}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-id">${esc(acTitle(r))}</span><span class="mt-k"><b>${esc(head)}</b><small class="${ads ? 'pos' : ''}">${esc(sub)}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${live ? 'LIVE' : bleAgo(age)}</span></div>`
    + (nums.length ? `<div class="ac-ads">${esc(nums.join(' · '))}<small>${esc(bleAgo(now - r.ins.numsMs))}</small></div>` : '')
    + `<div class="mt-clk"><b>${count}</b><small>${esc(what)}</small><em>${mhz}</em></div>`
    + (chips ? `<div class="ac-chips">${chips}</div>` : '')
    + `<div class="ac-sum">${esc(li?.summary ?? (v ? `link frames with ${v.stations.size} ground station${v.stations.size === 1 ? '' : 's'}` : ''))}</div>`
    + `<div class="mt-hex">${esc(last ? last.text || '(no text)' : v?.events[0]?.text ?? '(no ACARS text)')}</div></div>`;
}
function acStationCard(g: VdlStation, now: number, sel: string): string {
  const age = now - g.lastMs, live = age < 120_000, flash = Math.max(0, 1 - age / 700), apt = g.airport ? acLookup(g.airport) : undefined;
  return `<div class="mt-card ac-gs ${sel === `G:${g.addr}` ? 'sel' : ''} ${live ? '' : 'dim'}" data-acp="G:${g.addr}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-id">${g.addr}</span><span class="mt-k"><b>${esc(apt ? apt.name.toUpperCase() : 'AIRPORT NOT NAMED YET')}</b><small>${esc(g.airport ? `${g.airport} · ${g.airportOwn ? 'from its own XID' : "from an aircraft's XID"}` : 'ground station')}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${live ? 'LIVE' : bleAgo(age)}</span></div>`
    + `<div class="mt-clk"><b>${g.frames}</b><small>FRAME${g.frames === 1 ? '' : 'S'} · ${g.aircraft.size} AIRCRAFT</small><em>${(g.hz / 1e6).toFixed(3)}</em></div>`
    + `<div class="mt-hex">${g.snr !== null ? `heard itself at ${acSnr(g.snr)}` : 'not heard itself yet (only aircraft talking to it)'}</div></div>`;
}
const acFields = (f: [string, string][]) => `<div class="mt-fields">${f.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
function acarsDetail(r: AcRow, now: number): string {
  const ads = acarsAdsbMatch(r), v = r.vdl, i = r.ins;
  const msgs = r.msgs.map(m => {
    const x = acInsight(m);
    const chips = [acChip(kindLabelOf(x.kind), 'k'), x.phase ? acChip(x.phase, 'ph') : '', x.pos ? acChip(`${x.pos.lat.toFixed(3)}, ${x.pos.lon.toFixed(3)}`) : '', ...numChips(x.nums).map(c => acChip(c)), ...x.airports.map(a => acChip(a))].join('');
    return `<div class="ac-msg"><div><b>${new Date(m.ms).toLocaleTimeString()}</b><span>${m.down ? '↓ from the aircraft' : '↑ to the aircraft'} · ${esc(m.label)}${labelMeaning(m.label) ? ` ${esc(labelMeaning(m.label))}` : ''} · blk ${esc(m.blk)}${m.msn ? ` · #${esc(m.msn)}` : ''} · ${m.mhz}${m.crcOk ? '' : ' · CRC?'}</span></div>`
      + `<div class="ac-chips">${chips}</div><div class="ac-sum">${esc(x.summary)}</div>${m.text ? `<pre>${esc(m.text)}</pre>` : ''}</div>`;
  }).join('');
  const fields: [string, string][] = [['Registration', r.reg || '—'], ['Flight', r.flight || '—'], ['Airline', r.airline || '—'], ['ICAO', r.icao || '—'], ['Messages', String(r.msgs.length)]];
  if (v) fields.push(['Frames', `${v.frames} · ${v.acars} ACARS`], ['Last SNR', acSnr(v.snr)],
    ['Ground stations', [...v.stations.keys()].map(g => { const a = acarsUis.vdl2.vdl.stations.get(g)?.airport; return a ? `${g} (${a})` : g; }).join(', ') || '—'], ['Channel', `${(v.hz / 1e6).toFixed(3)} MHz`]);
  fields.push(['Phase', i.phase ? `${i.phase} · ${bleAgo(now - i.phaseMs)}` : '—'], ['Route', i.orig ? `${i.orig} → ${i.dest}` : '—'],
    ['Position', i.pos ? `${i.pos.lat.toFixed(3)}, ${i.pos.lon.toFixed(3)} · from a message ${bleAgo(now - i.posMs)}` : '—'],
    ['Stated', numChips(i.nums).join(' · ') ? `${numChips(i.nums).join(' · ')} · ${bleAgo(now - i.numsMs)}` : '—'],
    ['Airports named', i.airports.join(', ') || '—'], ['First heard', trClock(r.firstMs)], ['Last heard', trClock(r.lastMs)]);
  if (v) fields.push(['XID', v.xid || '—']);
  fields.push(['ADS-B', ads ? `${ads.icao.toUpperCase()}${ads.flight ? ` · ${ads.flight.trim()}` : ''}${ads.alt !== undefined ? ` · ${ads.alt} ft` : ''}` : 'not seen (open Aircraft to look for it)']);
  const events = v ? `<div class="caption">LINK EVENTS · newest first · ${v.events.length}</div>${v.events.length ? v.events.map(e => `<div class="ac-ev"><b>${new Date(e.ms).toLocaleTimeString()}</b><span>${esc(e.text)}</span></div>`).join('') : '<div class="ac-ev"><span>no XID handoffs heard yet</span></div>'}` : '';
  const kind = [r.airline && r.airline.toUpperCase(), r.flight && `FLIGHT ${r.flight}`, r.icao && `ICAO ${r.icao}`].filter(Boolean).join(' · ') || (v ? 'VDL2' : 'ACARS');
  return `<div class="mt-dh"><b>${esc(acTitle(r))}</b><span>${esc(kind)}</span>${acWhere(r) ? '<button class="chip" data-ado="map">MAP</button>' : ''}${ads ? '<button class="chip" data-ado="adsb">ADS-B</button>' : ''}<button class="chip" data-ado="close">✕</button></div>`
    + acFields(fields) + events + `<div class="caption">MESSAGES · newest first · ${r.msgs.length}</div><div class="ac-msgs">${msgs || '<div class="ac-ev"><span>no ACARS messages from it yet</span></div>'}</div>`;
}
function acStationDetail(g: VdlStation, now: number): string {
  const apt = g.airport ? acLookup(g.airport) : undefined, ui = acarsUis.vdl2;
  const fields: [string, string][] = [['Address', g.addr], ['Airport', apt ? `${g.airport} · ${apt.name}` : '—'], ['Placed by', g.airport ? (g.airportOwn ? 'its own XID' : "an aircraft's XID to it") : '—'],
    ['Frames', String(g.frames)], ['SNR', g.snr !== null ? acSnr(g.snr) : 'not heard itself yet'], ['Channel', `${(g.hz / 1e6).toFixed(3)} MHz`], ['First heard', trClock(g.firstMs)], ['Last heard', `${trClock(g.lastMs)} · ${bleAgo(now - g.lastMs)}`],
    ['Its XID', xidSummary(g.xidOwn) || '—'], ['XID to it', xidSummary(g.xidHeard) || '—']];
  const ac = [...g.aircraft].sort((a, b) => b[1] - a[1]).map(([k, t]) => { const a = ui.vdl.aircraft.get(k); return `<div class="ac-ev"><b>${new Date(t).toLocaleTimeString()}</b><span>${esc([a?.reg, a?.flight, k].filter(Boolean).join(' · '))}</span></div>`; }).join('');
  return `<div class="mt-dh"><b>${g.addr}</b><span>GROUND STATION${g.airport ? ` · ${esc(g.airport)}` : ''}</span>${apt ? '<button class="chip" data-ado="map">MAP</button>' : ''}<button class="chip" data-ado="close">✕</button></div>`
    + acFields(fields) + `<div class="caption">AIRCRAFT WORKING IT · ${g.aircraft.size}</div>${ac}`;
}
/** Bars: label, a bar as long as its share of the biggest, count. */
function acBars(rows: [string, number][], empty: string): string {
  if (!rows.length) return `<div class="ac-bar none"><span>${esc(empty)}</span></div>`;
  const top = Math.max(1, ...rows.map(r => r[1]));
  return rows.map(([k, n]) => `<div class="ac-bar ${n ? '' : 'zero'}"><span>${esc(k)}</span><i><u style="width:${(100 * n / top).toFixed(1)}%"></u></i><b>${n}</b></div>`).join('');
}
function acStats(ui: AcarsUi, vdl: boolean, rows: AcRow[], now: number): string {
  const per = ui.stats.minutes(now), peak = Math.max(...per), sum = per.reduce((a, b) => a + b, 0);
  const w = 300, h = 60, pts = per.map((n, k) => `${(w * k / (per.length - 1)).toFixed(1)},${(h - 4 - (h - 8) * n / Math.max(1, peak)).toFixed(1)}`);
  const spark = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="f" d="M0,${h} L${pts.join(' L')} L${w},${h} Z"/><path class="p" d="M${pts.join(' L')}"/></svg>`;
  const chans: [string, number][] = vdl ? VDL2_CHANNELS.slice().sort((a, b) => a - b).map(hz => [(hz / 1e6).toFixed(3), ui.vdl.chans.get(hz) ?? 0] as [string, number])
    : [...new Set([...ACARS_CHANNELS, ...ui.stats.chans.keys()])].sort().map(c => [c, ui.stats.chans.get(c) ?? 0] as [string, number]);
  const tiles: [string, string][] = [['MESSAGES', String(ui.stats.total)], ['AIRCRAFT', String(rows.length)], ['LAST 30 MIN', String(sum)], ['PEAK / MIN', String(peak)]];
  if (vdl) tiles.push(['FRAMES', String(ui.vdl.frames)], ['GROUND STATIONS', String(ui.vdl.stations.size)]);
  return `<div class="ac-tiles">${tiles.map(([k, v]) => `<div><b>${v}</b><small>${k}</small></div>`).join('')}</div>`
    + `<div class="caption">MESSAGES A MINUTE · last 30 min</div><div class="ac-spark">${spark}<b>${peak}</b><em>30 min ago</em><em class="r">now</em></div>`
    + `<div class="ac-cols"><div><div class="caption">${vdl ? 'FRAMES BY CHANNEL · MHz' : 'MESSAGES BY CHANNEL · MHz'}</div>${acBars(chans, '')}</div>`
    + `<div><div class="caption">TOP AIRLINES · aircraft</div>${acBars(ui.stats.topAirlines(), 'none named yet (by flight number)')}</div>`
    + `<div><div class="caption">MESSAGE KINDS</div>${acBars(ui.stats.kindList().map(([k, n]) => [kindLabelOf(k), n] as [string, number]), 'no messages yet')}</div></div>`;
}
function renderAcars(view: HTMLElement, id: AcarsApp): void {
  const ui = acarsUis[id], vdl = id === 'vdl2';
  const why = radio ? blockedBecause(APP_NEEDS[id], radio.limits) : '';
  uatLoadAirports();
  // home for the map and for dropping positions that cannot be this aircraft's (only when location is allowed)
  if (!state.home) requestGeo();
  view.innerHTML = `
    <section class="${visCls(id)}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">${why ? `<div class="note warn">${esc(radio!.label)} cannot receive this: ${esc(why)}. Nothing will decode here. A HackRF covers 1 MHz to 6 GHz.</div>` : ''}
      <div class="ctlrow">${segHtml([['acars', 'ACARS 131'], ['vdl2', 'VDL2 136.975']].map(([k, t]) => `<button data-acband="${k}" class="${k === id ? 'on' : ''}">${t}</button>`))}</div>
      ${vdl ? '' : presetHtml('CHANNEL · MHz', [['131.550 US', 131_550_000], ['131.525 EU', 131_525_000], ['131.725 EU2', 131_725_000], ['131.450 JP', 131_450_000], ['130.025', 130_025_000]])}
      <div class="ctlrow">${segHtml(['cards', 'map', 'stats', 'log'].map(v => `<button data-acview="${v}">${v.toUpperCase()}</button>`))}${wfHtml(id)}${pauseClearHtml(id)}</div>
      <div id="ac-stage" class="mt-stage"><div id="ac-cards" class="mt-cards"></div><div id="ac-map" class="panel map"></div><div id="ac-nopos" class="mt-nopos">no positions yet</div><div id="ac-unplaced" class="ac-unplaced"></div><div id="ac-stats" class="ac-stats"></div><div id="ac-detail" class="mt-detail" hidden></div></div>
      <div id="ac-log">${logHtml(id, 'listening…')}</div>
      <div class="note about">${vdl
        ? 'VDL Mode 2, the digital link that carries most airline ACARS now: every channel from 136.10 to 136.975 MHz at once, each frame checked. One card per aircraft by its ICAO address (exact, so ADS-B links straight to it), ACARS or not, with its registration and flight once it sends ACARS; ground stations below, placed at the airport their XIDs name. MAP plots the aircraft where their own messages put them, with lines to the stations they work.'
        : 'One card per aircraft (by registration, else flight), each message read into plain words: out, off, on and in times, positions, weather, ATIS, free text, engine data. MAP plots them where their own messages put them. ADS-B links to the same aircraft when ADS-B has seen it (by its ICAO address, its registration or its flight).'}</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-acband]', view).forEach(b => b.onclick = () => { if (b.dataset.acband !== id) open(b.dataset.acband as AcarsApp); });
  qa<HTMLButtonElement>('[data-acview]', view).forEach(b => b.onclick = () => { ui.view = b.dataset.acview as AcarsView; refreshAcars(true); if (ui.view === 'map') requestAnimationFrame(() => { geo?.invalidate(); geo?.fit(); }); });
  $('ac-unplaced').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-acp]'); if (c) { ui.sel = ui.sel === c.dataset.acp ? '' : c.dataset.acp!; refreshAcars(true); } };
  $('ac-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-acp]'); if (c) { ui.sel = ui.sel === c.dataset.acp ? '' : c.dataset.acp!; refreshAcars(true); } };
  $('ac-detail').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ado]'); if (!b) return;
    if (b.dataset.ado === 'close') { ui.sel = ''; refreshAcars(true); return; }
    if (b.dataset.ado === 'map') {
      ui.view = 'map'; refreshAcars(true);
      const g = ui.sel.startsWith('G:') ? ui.vdl.stations.get(ui.sel.slice(2)) : undefined, apt = g?.airport ? acLookup(g.airport) : undefined;
      const r = acRows(ui, vdl).find(x => x.key === ui.sel), w = r && acWhere(r);
      const at = apt ?? w; if (at) requestAnimationFrame(() => { geo?.invalidate(); geo?.center(at.lat, at.lon, 9); });
      return;
    }
    const r = acRows(ui, vdl).find(x => x.key === ui.sel), a = r && acarsAdsbMatch(r);
    if (a) { state.adsbSel = a.icao; open('adsb'); }
  };
  geo = new GeoMap($('ac-map'), { home: state.home, start: mapStart(state.home), onPick: id2 => { ui.sel = id2.replace(/^dest:/, ''); refreshAcars(true); }, log });
  clearInterval(ui.timer);
  ui.timer = window.setInterval(() => { if (state.app !== id) { clearInterval(ui.timer); return; } refreshAcars(); }, 2000);
  refreshList(id); refreshAcars(true);
}
function onAcarsLine(line: string, id: AcarsApp): void {
  const m = parseAcarsLine(line, Date.now()), ui = acarsUis[id];
  if (m) {
    const p = ui.planes.add(m);
    if (m.label !== 'SQ') ui.stats.add(m.ms, m.mhz, msgInsight(m).kind, airlineOf(p?.flight ?? m.flight), p?.key ?? '');
  }
  if (state.app === id) refreshAcars();
}
/** A VDL2 frame, ACARS or not: the aircraft and ground stations by address. */
function onVdl2Frame(f: AvlcFrame): void {
  acarsUis.vdl2.vdl.add({ ...f, ms: Date.now() });
  if (state.app === 'vdl2') refreshAcars();
}
function refreshAcars(force = false): void {
  if (state.app !== 'acars' && state.app !== 'vdl2') return;
  const id = acarsApp(), ui = acarsUis[id], vdl = id === 'vdl2';
  const now = Date.now();
  if (!force && now - ui.drawn < 240) { clearTimeout(ui.pending); ui.pending = window.setTimeout(() => refreshAcars(true), 250); return; }
  ui.drawn = now;
  const rows = acRows(ui, vdl), stations = vdl ? ui.vdl.stationList() : [];
  const placed = rows.filter(r => acWhere(r)).length + stations.filter(g => g.airport && acLookup(g.airport)).length;
  qa<HTMLButtonElement>('[data-acview]').forEach(b => {
    const v = b.dataset.acview; b.classList.toggle('on', v === ui.view);
    b.textContent = v === 'cards' ? `AIRCRAFT ${rows.length}` : v === 'map' ? `MAP ${placed}` : v === 'stats' ? 'STATS' : `LOG ${counts[id] ?? 0}`;
  });
  const stage = q('#ac-stage'), cards = q('#ac-cards'), det = q('#ac-detail'), logEl = q('#ac-log'), mapEl = q('#ac-map'), nopos = q('#ac-nopos'), statsEl = q('#ac-stats');
  if (!stage || !cards || !det || !logEl || !mapEl || !nopos || !statsEl) return;
  stage.hidden = ui.view === 'log'; logEl.hidden = ui.view !== 'log';
  cards.hidden = ui.view !== 'cards'; mapEl.hidden = ui.view !== 'map'; statsEl.hidden = ui.view !== 'stats'; nopos.hidden = ui.view !== 'map' || placed > 0;
  if (ui.view === 'cards' && !paused.has(id)) {
    const top = cards.scrollTop;
    const gs = vdl && (rows.length || stations.length)
      ? `<div class="caption ac-span">GROUND STATIONS · ${stations.length}</div>${stations.length ? stations.map(g => acStationCard(g, now, ui.sel)).join('') : '<div class="mt-hex ac-span">none heard yet</div>'}` : '';
    cards.innerHTML = rows.length || stations.length ? rows.map(r => acarsCard(r, now, ui.sel)).join('') + gs : emptyState(id);
    cards.scrollTop = top;
  }
  if (ui.view === 'stats' && !paused.has(id)) statsEl.innerHTML = acStats(ui, vdl, rows, now);
  if (ui.view === 'map') {
    geo?.invalidate();
    const items: GeoItem[] = [], at = new Map<string, [number, number]>(), paths: { pts: [number, number][]; dashed?: boolean; faint?: boolean }[] = [];
    for (const g of stations) {
      const apt = g.airport ? acLookup(g.airport) : undefined; if (!apt) continue;
      items.push({ id: `G:${g.addr}`, lat: apt.lat, lon: apt.lon, label: `GS ${g.addr} · ${g.airport}`, kind: 'tower' }); at.set(g.addr, [apt.lat, apt.lon]);
    }
    for (const r of rows) {
      const w = acWhere(r); if (!w) continue;
      const alt = r.ins.nums.altFt !== null ? ` · ${numChips({ ...r.ins.nums, kt: null, mach: '', hdg: null, fuel: '', eta: '' })[0]}` : '';
      items.push({ id: r.key, lat: w.lat, lon: w.lon, heading: r.ins.posHdg ?? undefined, label: `${acTitle(r)}${alt} · ${bleAgo(now - w.ms)}`, kind: 'plane' });
      at.set(r.key, [w.lat, w.lon]);
      const dest = r.ins.dest ? acLookup(r.ins.dest) : undefined;
      // the picked aircraft's destination, dashed (only then, so the view stays on what is heard here)
      if (dest && ui.sel === r.key) { paths.push({ pts: [[w.lat, w.lon], [dest.lat, dest.lon]], dashed: true }); items.push({ id: `dest:${r.key}`, lat: dest.lat, lon: dest.lon, label: r.ins.dest, kind: 'airport' }); }
    }
    const lines: [[number, number], [number, number]][] = [];
    if (vdl) for (const [a, g] of ui.vdl.links(now)) { const p = at.get(`A:${a}`), s = at.get(g); if (p && s) lines.push([p, s]); }
    geo?.setLines(lines); geo?.setPaths(paths);
    geo?.update(items, ui.sel);
  }
  const un = q('#ac-unplaced');
  if (un) {
    const none = rows.filter(r => !acWhere(r));
    un.hidden = ui.view !== 'map';
    un.innerHTML = `<div class="caption">NO POSITION YET · ${none.length}</div><div class="ac-chips">${none.length ? none.map(r => `<button class="ac-chip ${ui.sel === r.key ? 'k' : ''}" data-acp="${esc(r.key)}">${esc(acTitle(r))}</button>`).join('') : '<span class="ac-chip">every aircraft heard is on the map</span>'}</div>`;
  }
  const g = ui.sel.startsWith('G:') ? ui.vdl.stations.get(ui.sel.slice(2)) : undefined;
  const picked = g ? undefined : rows.find(r => r.key === ui.sel);
  det.hidden = !picked && !g;
  if (picked || g) { const top = det.scrollTop; det.innerHTML = g ? acStationDetail(g, now) : acarsDetail(picked!, now); det.scrollTop = top; }
  if (rows.length) setLamp(`${rows.length} AIRCRAFT`, 'ok');
}

// ---- Meters: ERT meters, the hopping mesh networks and Gridstream meters, all heard at once ----------------------
const METERS_RATE = 4_194_304, METERS_WIDE = 19_200_000;
const MESH_GRIDSTREAM = -1, MESH_ERT = -2, MESH_SUN = -3;
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
const meters = { snap: null as MetersSnap | null, view: 'cards' as 'cards' | 'map' | 'log', sel: '', full: false, drawn: 0, timer: 0, drawPending: 0 };
const meshSync = (s: number) => s === MESH_GRIDSTREAM ? 'Gridstream' : s === MESH_SUN ? '802.15.4g' : s === -4 ? '106 kbaud' : s === 0x9C0015 ? '9C··15' : s.toString(16).toUpperCase().padStart(6, '0');
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
    <section class="${visCls('ert')}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="mt-sum" class="mt-sum"></div>
      <div class="ctlrow">${segHtml(['cards', 'map', 'log'].map(v => `<button data-mtview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('ert')}<button id="mt-full" class="ib" title="full screen" aria-label="full screen">${meters.full ? EXIT_SVG : FULL_SVG}</button>${pauseClearHtml('ert')}</div>
      <div id="mt-stage" class="mt-stage"><div id="mt-cards" class="mt-cards"></div><div id="mt-map" class="panel map"></div><div id="mt-nopos" class="mt-nopos">no positions yet</div><div id="mt-detail" class="mt-detail" hidden></div></div>
      <div id="mt-log">${logHtml('ert', 'watching the band for meters…')}</div>
      ${presetHtml('CENTER', [['904.0', 904_000_000], ['911.6', 911_600_000], ['916.0', 916_000_000], ['920.0', 920_000_000], ['925.0', 925_000_000]])}
      <div class="ctlrow"><span class="rl">SPAN</span>${segHtml(([[2_000_000, '2 MHz'], [METERS_RATE, '4.2 MHz'], [METERS_WIDE, '19.2 MHz']] as [number, string][]).map(([r, l]) => `<button data-rate="${r}" class="${off(r)}">${l}</button>`))}</div>
      <div class="note about">Utility meters, three ways at once: Itron ERT meters (SCM, SCM+, IDM) and Neptune R900 water meters with their readings, the hopping smart-meter mesh networks (each learned by its sync word, every transmitter on its own live card with its hop clock), Landis+Gyr Gridstream meters with their IDs, uptime and position, and IEEE 802.15.4g SUN-FSK nodes with their device and network IDs. 902–928 MHz. A HackRF watches 19.2 MHz at once; an RTL-SDR 2 MHz, and the presets move it across the band.</div>
      </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-mtview]', view).forEach(b => b.onclick = () => { meters.view = b.dataset.mtview as typeof meters.view; refreshMeters(true); });
  $('mt-full').onclick = () => setMetersFull(!meters.full);
  $('mt-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-mdev]'); if (c) { meters.sel = meters.sel === c.dataset.mdev ? '' : c.dataset.mdev!; refreshMeters(true); } };
  $('mt-detail').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mdo]'); if (!b) return;
    const what = b.dataset.mdo;
    if (what === 'close') meters.sel = '';
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
  geo = new GeoMap($('mt-map'), { home: null, start: mapStart(state.home), fitPins: true, onPick: id => { meters.sel = id; refreshMeters(true); }, log });
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
  return `<div>${n.sync === MESH_GRIDSTREAM ? 'GRIDSTREAM' : n.sync === MESH_SUN ? '802.15.4g SUN' : `NETWORK ${meshSync(n.sync)}`} · ${n.frames} frames · ${n.channels.length} channels · ${span}</div>`;
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
  const live = age < 60, ertM = d.net === MESH_ERT, gs = d.net === MESH_GRIDSTREAM, sun = d.net === MESH_SUN;
  const kind = ertM ? 'ERT METER' : gs ? 'GRIDSTREAM METER' : sun ? '802.15.4g NODE' : 'TRANSMITTER';
  const sunNet = sun ? (d.fields.find(f => f.name === 'NETWORK ID')?.value ?? '').replace(/ /g, '') : '';
  const sub = ertM ? `${d.ertKind} · ${d.commodity}` : gs ? (d.lat !== null ? 'POSITION ON AIR' : 'LANDIS+GYR') : sun ? `NET ${sunNet}` : `NET ${meshSync(d.net)}`;
  const status = live ? 'LIVE' : d.lastMs === 0 ? 'ADDRESSED' : age < 120 ? `${Math.floor(age)} s ago` : `${Math.floor(age / 60)} min ago`;
  let clock: string;
  if (ertM) clock = `<b>${d.cons}</b><small>${d.cons > d.consFirst ? `+${d.cons - d.consFirst} SINCE HEARD` : 'CONSUMPTION'}</small><em>${d.frames} readings</em>`;
  else {
    const c = meshClockAt(d, now);
    if (gs) {
      const up = d.uptimeS < 0 ? -1 : d.uptimeS + Math.trunc((now - d.uptimeMs) / 1000);
      const p2 = (x: number) => String(x).padStart(2, '0');
      clock = `<b>${c >= 0 ? (c / 100).toFixed(2).padStart(6, '0') : '---.--'}</b><small>${up >= 0 ? `HOP s · UP ${Math.floor(up / 86400)}d ${p2(Math.floor(up / 3600) % 24)}h ${p2(Math.floor(up / 60) % 60)}m ${p2(up % 60)}s` : 'HOP s'}</small>`;
    } else if (sun) clock = `<b>${d.clock >= 0 ? hx(d.clock, 2) : '--'}</b><small>FRAME COUNTER</small>`;
    else clock = `<b>${c >= 0 ? hx(c, 4) : '----'}</b><small>${d.clockRate !== 0 ? `HOP CLOCK ${d.clockRate >= 0 ? '+' : ''}${d.clockRate.toFixed(0)}/s` : 'HOP CLOCK'}</small>`;
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
  const kind = d.net === MESH_ERT ? 'ERT METER' : d.net === MESH_GRIDSTREAM ? 'GRIDSTREAM METER' : d.net === MESH_SUN ? '802.15.4g NODE' : `MESH NODE · ${meshSync(d.net)}`;
  const votes = Object.values(d.wanVotes);
  return `<div class="mt-dh"><b>${esc(d.label)}</b><span>${kind}</span>${onMap ? '<button class="chip" data-mdo="map">MAP</button>' : ''}${meters.view === 'map' ? '<button class="chip" data-mdo="cards">CARDS</button>' : ''}<button class="chip" data-mdo="close">✕</button></div>`
    + `<div class="mt-fields">${d.fields.map(f => `<div><b>${esc(f.name)}</b><span>${esc(f.value)}</span></div>`).join('')}`
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
    cards.innerHTML = list.length ? list.map(d => meshCard(d, now)).join('') : emptyState('ert');
    cards.scrollTop = top;
  }
  const picked = devs.find(d => d.key === meters.sel);
  det.hidden = !picked;
  if (picked) { const top = det.scrollTop; det.innerHTML = meshDetail(picked, pins.some(p => p.id === picked.key)); det.scrollTop = top; }
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
const trainsUi = { snap: null as TrainsSnap | null, view: 'units' as 'units' | 'ptc' | 'hot', band: 'PTC' as 'EOT' | 'PTC', auto: true, timer: 0, cycle: 0, drawn: 0, pending: 0, picked: false, sel: '' };
/** Tunes for the band: as wide as it needs where the radio can (both EOT channels, or all of 216-222.5 MHz), else the
 *  channels heard most, from 2 MHz. */
/** What the PTC tuning hears, in MHz: a HackRF all of PTC, an RTL-SDR about 2 MHz of it. */
function trainsSpan(): [number, number] {
  const wide = radioCan(TR_PTC_RATE), c = wide ? TR_PTC_CENTER : TR_PTC_NARROW, r = wide ? TR_PTC_RATE : 2e6;
  return [Math.max(216, (c - r * 0.45) / 1e6), Math.min(222.5, (c + r * 0.45) / 1e6)];
}
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
/* Waterfalls that can be put away (the Android app's WATERFALL button). On a wide screen each starts shown; on a phone
 * BLE, ADS-B and Trains start without it (their bursts hardly show on it, and the cards or the map get the room), while
 * Meters, LoRa and ACARS keep it. A choice is remembered per app. */
const WF_PHONE: Partial<Record<AppId, boolean>> = { hd: false, sondes: false, btle: false, adsb: false, trains: false, fleet: false, cell: false, atsc: false, ert: true, lora: true, acars: true, vdl2: true };
const WF_SVG = '<svg viewBox="0 0 24 24"><path d="M3 4h18v3H3V4zm0 5h18v3H3V9zm0 5h18v2.5H3V14zm0 4.5h18V20H3v-1.5z"/></svg>';
function wfShown(app: AppId): boolean {
  let v: string | null = null;
  try { v = localStorage.getItem('mm.wf.' + app); } catch { /* storage blocked */ }
  return v !== null ? v === '1' : window.innerWidth >= 700 || (WF_PHONE[app] ?? true);
}
function setWf(app: AppId, on: boolean): void {
  try { localStorage.setItem('mm.wf.' + app, on ? '1' : '0'); } catch { /* storage blocked */ }
  render(app);
}
/** The visual section's class: without its waterfall when that is put away. */
const visCls = (app: AppId) => (wfShown(app) ? 'visual' : 'visual nowf');
/** The WATERFALL on / off button, as an icon in a toolbar row. */
const wfHtml = (app: AppId) => `<button class="ib wf-tog ${wfShown(app) ? 'on' : ''}" data-wf="${app}" title="${wfShown(app) ? 'hide' : 'show'} the waterfall" aria-label="waterfall" aria-pressed="${wfShown(app)}">${WF_SVG}</button>`;
function renderTrains(view: HTMLElement): void {
  view.innerHTML = `
    <section class="${visCls('trains')}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div class="ctlrow">${segHtml(([['EOT', 'EOT · HOT'], ['PTC', 'PTC 220'], ['BOTH', 'BOTH']] as [string, string][]).map(([k, l]) => `<button data-trband="${k}">${l}</button>`))}</div>
      <div class="ctlrow"><div id="tr-lamps" class="tr-lamps"></div><button id="tr-wf" class="tog ${wfShown('trains') ? 'on' : ''}" data-wf="trains">WATERFALL</button></div>
      <div id="tr-banner" class="tr-banner"></div>
      <div id="tr-strip" class="tr-strip"></div>
      <div class="ctlrow">${segHtml(['units', 'ptc', 'hot'].map(v => `<button data-trview="${v}"></button>`))}${pauseClearHtml('trains')}</div>
      <div class="tr-stage"><div id="tr-cards" class="mt-cards tr-cards"></div><div id="tr-detail" class="mt-detail" hidden></div></div>
      <div id="tr-log">${logHtml('trains', 'listening for trains…')}</div>
      <div class="note about">The railroad's radios, receive only. EOT · HOT decodes the end-of-train units (brake pipe pressure, motion, marker light, battery) and spots the head unit's commands to them; PTC 220 watches the train-control network: base stations, wayside units (and when their status changes) and locomotives. BOTH takes turns. 457.9375 EOT · 452.9375 HOT · 457.925 DPU · 217–222 MHz PTC. A HackRF hears both EOT channels or all of PTC at once. Tap a card for everything decoded from it.</div>
      </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-trband]', view).forEach(b => b.onclick = () => trainsSetBand(b.dataset.trband as 'EOT' | 'PTC' | 'BOTH'));
  qa<HTMLButtonElement>('[data-trview]', view).forEach(b => b.onclick = () => { trainsUi.view = b.dataset.trview as typeof trainsUi.view; trainsUi.picked = true; trainsUi.sel = ''; refreshTrains(true); });
  $('tr-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-trsel]'); if (c) { trainsUi.sel = trainsUi.sel === c.dataset.trsel ? '' : c.dataset.trsel!; refreshTrains(true); } };
  $('tr-detail').onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-trdo]'); if (!b) return; if (b.dataset.trdo === 'close') { trainsUi.sel = ''; refreshTrains(true); } };
  clearInterval(trainsUi.timer);
  // the cards run their ages, countdowns and timelines on between reports
  trainsUi.timer = window.setInterval(() => { if (state.app !== 'trains') { clearInterval(trainsUi.timer); return; } refreshTrains(); }, 250);
  // the screen is drawn again on every band switch (BOTH takes turns): the log's count and rows with it
  refreshList('trains');
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
  return `<div class="mt-dh ${red ? 'red' : ''}"><b>${esc(title)}</b><span>${esc(kind)}</span><button class="chip" data-trdo="close">✕</button></div>`
    + `<div class="mt-fields tr-fields">${fields.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
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
      // each sub-band lit where the span reaches it
      : (() => {
        const [lo, hi] = trainsSpan();
        return ([['WAYSIDE', 217, 220], ['BASE', 220, 221], ['LOCO', 221, 222]] as [string, number, number][]).map(([n, a, b]) => {
          const cover = Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / (b - a);
          return `<span class="tr-lamp ${cover > 0 ? 'on' : ''}"><i></i>${cover >= 0.99 ? n : cover > 0 ? `${n} PART` : `${n} —`}</span>`;
        }).join('') + `<small>HEARS ${lo.toFixed(2)}–${hi.toFixed(2)} MHz</small>`;
      })();
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
        ? (stations.length ? [...stations].sort((a, b) => a.firstMs - b.firstMs).map(x => trStationCard(x, now)).join('') : `<div class="empty">${band === 'PTC' || trainsUi.auto ? `watching ${trainsSpan().map(x => x.toFixed(2)).join('–')} MHz for the train-control network${s && s.other > 0 ? ` · ${s.other} other bursts` : ''}` : 'switch to PTC 220 or BOTH to watch the train-control network'}</div>`)
        : (hots.length ? hots.map(h => trHotRow(h, now)).join('') : '<div class="empty">no head-of-train command heard yet · a locomotive sends one when it checks on its rear unit or brakes</div>');
    cards.scrollTop = top;
  }
  if (det) {
    const u = trainsUi.view === 'units' ? units.find(x => 'u' + x.unit === trainsUi.sel) : undefined;
    const st = trainsUi.view === 'ptc' ? stations.find(x => 's' + x.hz === trainsUi.sel) : undefined;
    det.hidden = !u && !st;
    const top = det.scrollTop;
    if (u) det.innerHTML = trDetail(`${u.unit}`, u.channel === 'DPU' ? 'DISTRIBUTED POWER' : 'END OF TRAIN', trEotFields(u, now), false);
    else if (st) det.innerHTML = trDetail((st.hz / 1e6).toFixed(4), PTC_KIND_LABEL[st.kind], trPtcFields(st, now), st.kind === 'LOCOMOTIVE');
    det.scrollTop = top;
  }
  const b = trainsBurst();
  if (b !== null) setMeter(b / 40, `BURST +${b} dB`);
  if (train) setLamp('TRAIN NEARBY', 'amber', true); else if (stations.length) setLamp(`${stations.length} PTC STATION${stations.length === 1 ? '' : 'S'}`, 'ok');
}

// ---- Dispatch: P25 and DMR trunked systems, sites, grants, units and calls (receive only) ----------------------
const FLEET_BANDS: [string, string, number, number][] = [
  ['VHF', 'VHF 150–174', 150_000_000, 174_000_000], ['TETRA', 'TETRA 380–430', 380_000_000, 430_000_000], ['UHF', 'UHF 450–470', 450_000_000, 470_000_000], ['TBAND', 'T-BAND 470–512', 470_000_000, 512_000_000],
  ['700', '700 769–775', 769_000_000, 775_000_000], ['800', '800 851–869', 851_000_000, 869_000_000], ['900', '900 935–941', 935_000_000, 941_000_000],
];
const FLEET_SPANS: [number, string][] = [[2_400_000, '2.4 MHz'], [8_000_000, '8 MHz'], [20_000_000, '20 MHz']];
/** One color per system, used on the cards, the map, the feed and the frequency list. */
const FLEET_COLORS = ['#4c8dff', '#ffaf00', '#3ddc84', '#ff5bd2', '#00d5ff', '#ff7a45', '#b18cff', '#e8e14a', '#ff5b52', '#52ffb8'];
type FleetView = 'tgs' | 'systems' | 'calls' | 'map' | 'grants' | 'freqs' | 'log';
type FleetSel = { kind: 'unit' | 'tg' | 'sys' | 'car'; key: string } | null;
const fleetUi = {
  snap: null as FleetSnap | null, view: 'tgs' as FleetView, band: 'AUTO', span: 8_000_000, sel: null as FleetSel,
  unit: null as { key: string; reports: FleetUnitReport[]; trail: [number, number, number][]; offArea: number } | null,
  windows: [] as { band: string; hz: number }[], idx: 0, dwellEnd: 0, found: false, timer: 0, scanTimer: 0, drawn: 0, pending: 0, full: false, hold: false, wired: false,
  prefs: loadDispatchPrefs(), airSeen: new Map<string, number>(), audioOn: true, gain: 0.8, following: null as { key: string; home: number; until: number } | null,
  lock: loadDispatchLock(), vu: { key: '', db: -90 },
  /** A short look at a band where a position-reporting system lives, and when the last one was. */
  visit: null as { home: number; until: number; sys: string } | null, lastVisit: Date.now() - 60_000, knownAt: 0,
};
/** Systems and unit positions are kept on the device: every position ever decoded stays on the map. */
const KNOWN_KEY = 'mm.fleet.known';
function dispatchSaveKnown(k: unknown): void {
  try { localStorage.setItem(KNOWN_KEY, JSON.stringify(k)); }
  catch { try { const v = k as { units: unknown[] }; localStorage.setItem(KNOWN_KEY, JSON.stringify({ ...v, units: v.units.slice(0, 500) })); } catch { /* storage full or blocked */ } }
}
function dispatchLoadKnown(): unknown { try { return JSON.parse(localStorage.getItem(KNOWN_KEY) ?? 'null'); } catch { return null; } }
/** The system lock is kept on the device too: ALL is no lock. */
function loadDispatchLock(): DispatchLock | null {
  try { const v = JSON.parse(localStorage.getItem('mm.fleet.lock') ?? 'null'); if (v && typeof v.sys === 'string' && v.sys) return { sys: v.sys, site: typeof v.site === 'string' ? v.site : '', label: String(v.label ?? v.sys), hz: Number(v.hz) || 0 }; } catch { /* storage blocked */ }
  return null;
}
/** What the worker is told: the talkgroup preferences and the lock. */
const dispatchPrefsMsg = (): TgPrefs => ({ ...fleetUi.prefs, lock: fleetUi.lock });
/** Lock on one system (or one of its sites), or back to ALL with null. Tunes to the locked system when it is out of the span. */
function dispatchLock(l: DispatchLock | null): void {
  fleetUi.lock = l;
  try { if (l) localStorage.setItem('mm.fleet.lock', JSON.stringify(l)); else localStorage.removeItem('mm.fleet.lock'); } catch { /* storage blocked */ }
  worker?.postMessage({ type: 'fleet', cmd: 'prefs', prefs: dispatchPrefsMsg() });
  if (l) dispatchTuneLock();
  fleetDwell(); refreshFleet(true);
}
/**
 * Every two minutes in AUTO, a look of 18 s at a band where a system with unit positions was heard and the span does not
 * reach, so its positions stay fresh; never on a band the listener picked, never while locked, and never while the call
 * being heard is on the air.
 */
function dispatchVisitDue(s: FleetSnap, now: number): boolean {
  // only AUTO leaves its band to check positions: a band the listener tapped holds, and LOCK never leaves its system
  if (fleetUi.lock || fleetUi.band !== 'AUTO' || now - fleetUi.lastVisit < 120_000) return false;
  if (fleetUi.audioOn && s.calls.some(c => c.key === s.playing && c.onAir)) return false;
  // a look away only when nothing clear has played for a while
  if (fleetAuto && now - fleetAuto.lastClear < 15_000) return false;
  const out = (hz: number) => hz < s.spanLo + 20_000 || hz > s.spanHi - 20_000;
  const target = s.systems.filter(x => x.positions && x.heardHz.length && x.heardHz.every(out)).sort((a, b) => a.lastMs - b.lastMs)[0];
  if (!target) { fleetUi.lastVisit = now; return false; }
  const hz = target.heardHz[0], span = s.spanHi - s.spanLo;
  fleetUi.visit = { home: s.centerHz, until: now + 18_000, sys: target.key };
  tune(Math.round(hz + span * 0.2));
  refreshFleet(true);
  return true;
}
/** Brings the locked system's control channel into the span, if it is not there. */
function dispatchTuneLock(): void {
  const l = fleetUi.lock, s = fleetUi.snap; if (!l || !l.hz) return;
  if (s && l.hz > s.spanLo + 20_000 && l.hz < s.spanHi - 20_000) return;
  const half = fleetRate() * 0.4, w = fleetUi.windows.map((x, i) => ({ i, d: Math.abs(x.hz - l.hz) })).filter(x => x.d < half).sort((a, b) => a.d - b.d)[0];
  if (fleetUi.following) fleetUi.following = null;
  if (w) { fleetUi.idx = w.i; tune(fleetUi.windows[w.i].hz); } else tune(Math.round(l.hz));
}
/** A lock for a system (and a site), named the way its card names it, with its control channel to come back to. */
function dispatchLockFor(sysKey: string, siteLabel = ''): DispatchLock | null {
  const x = fleetUi.snap?.systems.find(y => y.key === sysKey); if (!x) return null;
  const site = siteLabel ? x.sites.find(y => y.label === siteLabel) : x.sites[0];
  const hz = site?.ccHz[0] ?? x.sites.find(y => y.ccHz.length)?.ccHz[0] ?? 0;
  return { sys: x.key, site: siteLabel, label: `${fleetSysTitle(x)}${siteLabel ? ` · SITE ${siteLabel}` : ''}`, hz };
}
const fleetSysTitle = (sys: FleetSystem) => sys.proto === 'SMARTNET' ? `TYPE II SYS ${sys.sysId.toString(16).toUpperCase().padStart(4, '0')}` : sys.proto === 'NXDN' ? (sys.trunk === 'CONVENTIONAL' ? `NXDN RAN ${sys.sysId}` : sys.trunk === 'TYPE-D' ? `TYPE-D SITE ${sys.sysId}` : `${sys.model} SYS ${sys.sysId}`) : sys.proto === 'TETRA' ? `MCC ${sys.wacn} · MNC ${sys.sysId}` : sys.proto === 'P25' ? `WACN ${sys.wacn.toString(16).toUpperCase().padStart(5, '0')} · SYS ${sys.sysId.toString(16).toUpperCase().padStart(3, '0')}` : sys.net >= 0 ? `${sys.model} NET ${sys.net}` : sys.trunk === 'CAPACITY PLUS' ? `CAP+ CC ${sys.cc}` : `CC ${sys.cc}${sys.fid > 0 ? ` · FID ${sys.fid.toString(16).toUpperCase().padStart(2, '0')}` : ''}`;
/** Talkgroup preferences are kept on the device (the key names keep the app's internal id). */
function loadDispatchPrefs(): TgPrefs {
  try { const v = JSON.parse(localStorage.getItem('mm.fleet.tgprefs') ?? 'null'); if (v && Array.isArray(v.mute) && Array.isArray(v.prio)) return { mute: v.mute, hold: typeof v.hold === 'string' ? v.hold : '', prio: v.prio }; } catch { /* storage blocked */ }
  return { mute: [], hold: '', prio: [] };
}
function dispatchPref(kind: 'mute' | 'hold' | 'prio', key: string): void {
  const p = fleetUi.prefs;
  if (kind === 'hold') p.hold = p.hold === key ? '' : key;
  else { const l = p[kind], i = l.indexOf(key); if (i >= 0) l.splice(i, 1); else l.push(key); }
  try { localStorage.setItem('mm.fleet.tgprefs', JSON.stringify(p)); } catch { /* storage blocked */ }
  worker?.postMessage({ type: 'fleet', cmd: 'prefs', prefs: dispatchPrefsMsg() });
  refreshFleet(true);
}
/** A tap on the talkgroup grid: follow that talkgroup (only it is heard), or back to ALL. The follow is the HOLD preference. */
function dispatchFollowTap(key: string): void {
  const p = fleetUi.prefs, next = followTap(p.hold, key);
  if (next === p.hold) return;
  p.hold = next;
  try { localStorage.setItem('mm.fleet.tgprefs', JSON.stringify(p)); } catch { /* storage blocked */ }
  worker?.postMessage({ type: 'fleet', cmd: 'prefs', prefs: dispatchPrefsMsg() });
  refreshFleet(true);
}
/** The talkgroup grid: ALL first, then a tile per talkgroup (followed, emergency, on the air, then the latest heard). */
function fleetTgTilesHtml(s: FleetSnap, now: number): string {
  const p = fleetUi.prefs, tiles = tgTiles(s.tgs, s.calls, p, now);
  const all = `<div class="fl-tile all ${p.hold ? '' : 'fol'}" role="button" data-flfollow=""><b>ALL</b><small>EVERY TALKGROUP</small><span>first to talk is heard</span></div>`;
  return `<div class="fl-tilegrid">${all}${tiles.map(t => {
    const sys = s.systems.find(x => x.key === t.sys), col = flMapColor(fleetColor(t.sys));
    const when = t.live ? 'ON THE AIR' : t.lastMs ? `${agoShort(now - t.lastMs)} ago` : 'not heard yet';
    return `<div class="fl-tile ${t.followed ? 'fol' : ''} ${t.live ? 'live' : ''} ${t.emergency ? 'emerg' : ''} ${t.muted ? 'muted' : ''}" role="button" style="--sys:${col}" data-flfollow="${esc(t.key)}">`
      + `<b>TG ${t.tg}</b><small>${esc(sys ? fleetSysTitle(sys) : t.sys)}</small>`
      + `<span><i></i>${esc(when)}</span>${t.sec ? `<em class="${t.sec === 'CLEAR' ? 'ok' : 'enc'}">${esc(t.sec)}</em>` : ''}`
      + `${t.followed ? '<u>FOLLOWING</u>' : t.muted ? '<u>MUTED</u>' : ''}<button class="fl-ti" data-flsel="tg:${esc(t.key)}" title="details" aria-label="details">i</button></div>`;
  }).join('')}</div>${tiles.length ? '' : '<div class="fl-dim">talkgroups show here as the control channels grant them and their calls are heard</div>'}`;
}
function dispatchAudio(on: boolean, gain = fleetUi.gain): void {
  fleetUi.audioOn = on; fleetUi.gain = gain;
  try { localStorage.setItem('mm.fleet.audio.v2', JSON.stringify({ on, gain })); } catch { /* storage blocked */ }
  if (on) void ensureAudio();
  worker?.postMessage({ type: 'fleet', cmd: 'audio', on, gain });
}
const fleetColor = (sys: string) => { const s = fleetUi.snap?.systems.find(x => x.key === sys); return s ? FLEET_COLORS[s.color % FLEET_COLORS.length] : 'var(--muted)'; };
const fleetMhz = (hz: number, d = 5) => hz > 0 ? (hz / 1e6).toFixed(d) : '-';
const fleetAgo = (ms: number) => ms < 2_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h`;
const fleetAgoText = (ms: number) => { const a = fleetAgo(ms); return a === 'now' ? 'now' : `${a} ago`; };
const fleetClock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
/** The sample rate Fleet asks for: the chosen span where the radio takes it, else as wide as it goes up to 2.4 MHz. */
function fleetRate(): number {
  const want = fleetUi.span;
  if (radioCan(want)) return want;
  return radioCan(2_400_000) ? 2_400_000 : 2_000_000;
}
/** The centers a band is heard from: one when the span covers it, else even steps across it. */
function fleetWindows(): { band: string; hz: number }[] {
  const rate = fleetRate(), use = rate * 0.8, out: { band: string; hz: number }[] = [];
  for (const [id, , lo, hi] of FLEET_BANDS) {
    if (fleetUi.band !== 'AUTO' && fleetUi.band !== id) continue;
    const n = Math.max(1, Math.ceil((hi - lo) / use));
    for (let i = 0; i < n; i++) out.push({ band: id, hz: Math.round(n === 1 ? (lo + hi) / 2 : lo + use / 2 + i * ((hi - lo - use) / (n - 1))) + 3_125 });
  }
  return out;
}
function fleetOpen(): void {
  fleetUi.windows = fleetWindows(); fleetUi.idx = 0;
  configure('NONE', fleetUi.windows[0].hz, fleetRate(), 32, 40, true, 'fleet');
  fleetUi.following = null;
  worker?.postMessage({ type: 'fleet', cmd: 'prefs', prefs: dispatchPrefsMsg() });
  const known = dispatchLoadKnown(); if (known) worker?.postMessage({ type: 'fleet', cmd: 'restore', known });
  fleetUi.visit = null; fleetUi.lastVisit = Date.now() - 60_000;
  // a saved lock starts on the window holding the locked system's control channel
  const lk = fleetUi.lock;
  if (lk?.hz) { const half = fleetRate() * 0.4, i = fleetUi.windows.findIndex(x => Math.abs(x.hz - lk.hz) < half); if (i > 0) { fleetUi.idx = i; tune(fleetUi.windows[i].hz); } }
  try { const a = JSON.parse(localStorage.getItem('mm.fleet.audio.v2') ?? 'null'); if (a) { fleetUi.audioOn = !!a.on; fleetUi.gain = Number(a.gain) || 0.8; } } catch { /* storage blocked */ }
  worker?.postMessage({ type: 'fleet', cmd: 'audio', on: fleetUi.audioOn, gain: fleetUi.gain });
  const pos = state.home ?? lastKnownPos();
  if (pos) worker?.postMessage({ type: 'geo', lat: pos.lat, lon: pos.lon });
  else { const z = zoneGuess(); if (z) worker?.postMessage({ type: 'fleetRef', lat: z.lat, lon: z.lon }); }
  requestGeo();
  fleetDwell();
}
/** Six seconds a window; a window where a control channel decodes keeps the radio for 25. */
/** AUTO's choice of window, scored by the clear voice heard on each (dsp/fleet/auto.ts). */
let fleetAuto: FleetAuto | null = null, fleetAutoSig = '', fleetAutoSaved = 0;
/** The band scores are kept on the device with the systems, for the same set of windows (band choice and span). */
const fleetWindowSig = () => `${fleetUi.band}|${fleetUi.windows.map(w => w.hz).join(',')}`;
function fleetAutoLoad(sig: string): AutoSaved | null {
  try { const v = JSON.parse(localStorage.getItem('mm.fleet.auto') ?? 'null'); return v && v.sig === sig ? v.saved as AutoSaved : null; } catch { return null; }
}
function fleetAutoSave(now: number): void {
  if (!fleetAuto || now - fleetAutoSaved < 10_000) return;
  fleetAutoSaved = now;
  try { localStorage.setItem('mm.fleet.auto', JSON.stringify({ sig: fleetAutoSig, saved: fleetAuto.save(now) })); } catch { /* storage full or blocked */ }
}
function fleetDwell(): void {
  clearTimeout(fleetUi.scanTimer);
  fleetUi.found = false; fleetUi.dwellEnd = Date.now() + 6_000;
  const sig = fleetWindowSig();
  if (!fleetAuto || fleetAutoSig !== sig) {
    fleetAutoSig = sig;
    fleetAuto = new FleetAuto(fleetUi.windows.length, Date.now(), fleetUi.idx, fleetAutoLoad(sig));
    // a reload with a known best band starts on it
    if (!fleetUi.lock && fleetAuto.idx !== fleetUi.idx && fleetUi.windows[fleetAuto.idx]) { fleetUi.idx = fleetAuto.idx; tune(fleetUi.windows[fleetUi.idx].hz); }
  } else fleetAuto.moved(fleetUi.idx, Date.now());
  // one window (a band the span covers): nothing to step through, but the checks on locks, follows and visits run
  const check = () => {
    if (state.app !== 'fleet') return;
    const s = fleetUi.snap, now = Date.now();
    if (fleetUi.following) { fleetUi.dwellEnd = Math.max(fleetUi.dwellEnd, now + 6_000); fleetUi.scanTimer = window.setTimeout(check, 500); return; }
    // a look at a band where units report positions: back home when it is over
    if (fleetUi.visit) { if (now >= fleetUi.visit.until) { tune(fleetUi.visit.home); fleetUi.visit = null; fleetUi.lastVisit = now; fleetUi.dwellEnd = Math.max(fleetUi.dwellEnd, now + 6_000); refreshFleet(true); } fleetUi.scanTimer = window.setTimeout(check, 500); return; }
    if (s && dispatchVisitDue(s, now)) { fleetUi.scanTimer = window.setTimeout(check, 500); return; }
    // locked: the receiver stays with the locked system (and goes back to it if something moved it)
    if (fleetUi.lock) { fleetUi.found = true; fleetUi.dwellEnd = now + 6_000; if (s && fleetUi.lock.hz && (fleetUi.lock.hz < s.spanLo || fleetUi.lock.hz > s.spanHi)) dispatchTuneLock(); fleetUi.scanTimer = window.setTimeout(check, 500); return; }
    const live = s ? s.carriers.some(c => (c.role === 'control' || c.role === 'rest') && c.hz > s.spanLo && c.hz < s.spanHi && now - c.lastDecodeMs < 5_000) : false;
    // AUTO holds the window where clear voice is heard, looks elsewhere now and then, and scans while nothing has earned it
    const a = fleetAuto;
    if (a && s) {
      const to = a.step({ now, calls: s.calls, playing: fleetUi.audioOn ? s.playing : '', controlLive: live, systems: s.systems.length });
      fleetUi.found = a.mode !== 'scan' || a.found;
      fleetUi.dwellEnd = a.mode === 'hold' ? now + 6_000 : a.until;
      if (to !== null && to !== fleetUi.idx && fleetUi.windows[to]) { fleetUi.idx = to; tune(fleetUi.windows[to].hz); refreshFleet(true); }
      fleetAutoSave(now);
    }
    fleetUi.scanTimer = window.setTimeout(check, 500);
  };
  fleetUi.scanTimer = window.setTimeout(check, 500);
}
function fleetSetBand(b: string): void {
  fleetUi.band = b; fleetUi.windows = fleetWindows(); fleetUi.idx = 0;
  tune(fleetUi.windows[0].hz); fleetDwell(); refreshFleet(true);
}
function fleetSetSpan(r: number): void {
  if (!radioCan(r)) { log(`${radio?.label ?? 'this radio'} cannot sample ${(r / 1e6).toFixed(1)} MHz`); return; }
  fleetUi.span = r; setRate(fleetRate()); fleetUi.windows = fleetWindows(); fleetUi.idx = 0; tune(fleetUi.windows[0].hz); fleetDwell(); refreshFleet(true);
}
function setFleetFull(on: boolean): void {
  fleetUi.full = on;
  const v = q('.view.fleet'); if (!v) return;
  v.classList.toggle('fleetfull', on);
  const b = q('#fl-full'); if (b) { b.innerHTML = on ? EXIT_SVG : FULL_SVG; b.title = on ? 'leave full screen' : 'full screen'; }
  refreshFleet(true);
  requestAnimationFrame(() => geo?.invalidate());
}
/** A desktop-size window: the map takes the big pane where the waterfall sits (a short waterfall strip under it when
 *  that is on), and the column on the right holds everything else all the way down. */
const FLEET_WIDE = window.matchMedia('(min-width: 1000px)');
FLEET_WIDE.addEventListener('change', () => { if (state.app === 'fleet') { const v = q<HTMLElement>('main#view'); if (v) renderFleet(v); } });
let flSpy: (() => void) | null = null;
function renderFleet(view: HTMLElement): void {
  const hack = !radio || radio.kind !== 'rtlsdr', wide = FLEET_WIDE.matches;
  if (wide) { if (fleetUi.view === 'map') fleetUi.view = 'tgs'; fleetUi.full = false; }
  view.classList.toggle('flwide', wide);
  const tabs = (wide ? ['tgs', 'systems', 'calls', 'grants', 'freqs', 'log'] : ['map', 'tgs', 'systems', 'calls', 'grants', 'freqs', 'log']) as FleetView[];
  const tabName = (v: FleetView) => v === 'tgs' ? 'TALKGROUPS' : v === 'freqs' ? 'FREQS' : v.toUpperCase();
  const mapHtml = '<div id="fl-map" class="panel map"></div><div id="fl-nopos" class="mt-nopos"></div>';
  view.innerHTML = `
    <section class="${visCls('fleet')}">${readoutHtml()}${wide ? `<div class="fl-mapbox">${mapHtml}</div>` : ''}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="fl-now" class="fl-now" hidden></div>
      <div id="fl-head" class="fl-head"></div>
      <div class="ctlrow">${segHtml([['AUTO', 'AUTO'], ...FLEET_BANDS.map(b => [b[0], b[0] === 'TBAND' ? 'T-BAND' : b[0]])].map(([k, l]) => `<button data-flband="${k}">${l}</button>`))}</div>
      ${hack ? `<div class="ctlrow"><span class="rl">SPAN</span>${segHtml(FLEET_SPANS.map(([r, l]) => `<button data-flspan="${r}" class="${radioCan(r) ? '' : 'off'}">${l}</button>`))}</div>` : ''}
      <div id="fl-mode" class="ctlrow fl-mode"></div>
      <div id="fl-audio" class="ctlrow fl-audio" hidden></div>
      <div id="fl-onair" class="fl-onair" hidden></div>
      ${wide ? '' : `<nav class="fl-jump">${tabs.map(v => `<button data-flview="${v}"><span>${tabName(v)}</span><b></b></button>`).join('')}</nav>`}<div class="ctlrow fl-tabs">${wide ? segHtml(tabs.map(v => `<button data-flview="${v}">${tabName(v)}</button>`)) : ''}${wfHtml('fleet')}${wide ? '' : `<button id="fl-full" class="ib" title="full screen" aria-label="full screen">${fleetUi.full ? EXIT_SVG : FULL_SVG}</button>`}<button id="fl-export" class="ib" title="export the log (CSV) and the tables (JSON)" aria-label="export"><svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zm7-18-5.5 5.5 1.4 1.4L11 5.8V16h2V5.8l3.1 3.1 1.4-1.4L12 2z"/></svg></button>${pauseClearHtml('fleet')}</div>
      <div id="fl-stage" class="mt-stage fl-stage"><div id="fl-detail" class="mt-detail" hidden></div>${wide ? '' : `<div class="fl-sech" data-flsec="map">MAP</div><div class="fl-mapwrap">${mapHtml}</div>`}${wide ? '' : '<div class="fl-sech" data-flsec="tgs">TALKGROUPS</div>'}<div id="fl-tgs" class="fl-tgs"></div>${wide ? '' : '<div class="fl-sech" data-flsec="systems">SYSTEMS</div>'}<div id="fl-cards" class="fl-cards"></div>${wide ? '' : '<div class="fl-sech" data-flsec="calls">CALLS</div>'}<div id="fl-calls" class="fl-calls"></div>${wide ? '' : '<div class="fl-sech" data-flsec="grants">GRANTS</div>'}<div id="fl-grants" class="fl-grants"></div>${wide ? '' : '<div class="fl-sech" data-flsec="freqs">FREQUENCIES</div>'}<div id="fl-freqs" class="fl-freqs"></div></div>
      <div id="fl-log"><div class="countrow"><span id="count-fleet" class="count">0 DECODED</span></div>${listHtml('fleet', 'watching for control channels…')}</div>
      <div class="note about">Trunked radio systems and their calls, receive only, for P25 Phase 1 (C4FM and CQPSK simulcast), P25 Phase 2, DMR, NXDN and TETRA. Every carrier in the span is found and the live ones decoded at once, and systems are named by what they send (WACN, system, RFSS, site, NAC; the DMR color code and network; the NXDN system and site; the TETRA network and cell; the CW ID callsign). Grants resolve to MHz through the channel tables on the air, and Phase 2 voice channels are marked TDMA. Each call granted jumps to the top while it is on the air, and its voice channel is followed when it is inside the span, with P25 voice frames and terminators and DMR voice bursts and their link control (talkgroup, unit, emergency, privacy). Encrypted means the call itself says so. Clear calls play through the app's own vocoders, and the last calls replay from memory; a receiver that cannot cover the call's channel goes to it and comes back. P25 Phase 2 TDMA calls play too, each timeslot its own call. The channel is descrambled with the system's WACN, system and NAC, and its MAC messages name the talkgroup, the unit and the encryption and end the call. The first call to bring audio is heard until it ends, and a priority talkgroup (then an emergency) takes over; calls fade in and out. ALL hears every system; LOCK stays on one system or site, from its card or a call, and keeps AUTO from moving on. Encryption is shown as the air states it, with the P25 algorithm and key from the encryption sync or the call header, the DMR privacy bit and header, the NXDN cipher type and the TETRA encryption flags; an encrypted call never plays. DMR logical channels are placed on their carriers by matching each grant to the voice that follows it. A call shows where its unit, or a unit in its talkgroup, last reported from, with the distance and direction from you; tap it to see it on the map. Mute, follow and priority are per talkgroup; a tap on a talkgroup tile follows it, so only it is heard, and ALL hears every talkgroup again. DMR unit positions are resolved against your own position (within about 300 km). AUTO steps through the bands until it hears clear voice, then stays on that band and looks at the others only now and then, when nothing clear is playing. Calls with no talkgroup and no audio fold into one line under the stack, like the encrypted ones. NXDN48 and NXDN96 are read on control, traffic and conventional channels. A Type-C control channel names its system and site, its grants are followed to their traffic channels, and each call's VCALL names the talkgroup or unit and says whether it is ciphered (scramble, DES or AES are encrypted and never play); conventional channels are their own systems by RAN, and Type-D repeaters by their site. NXDN carries no channel plan on the air, so channel numbers become frequencies as they are heard, from the control channel's own number and each grant matched to the voice that follows it. Clear NXDN voice plays through the same AMBE+2 vocoder as DMR, and the 9600 bps full-rate mode through the P25 one. TETRA (EN 300 392-2) is read from the cell's synchronization and broadcast bursts on, giving the network (MCC, MNC), the cell (location area, color code, main carrier) and what it offers, call set-up and transmission grants (group, unit, the carrier and timeslot of the call), releases, registrations and SDS text and status messages. TETRA speech is followed onto its timeslot and carrier and played through the app's own TETRA ACELP decoder, written from EN 300 395-2 and checked against the standard's test sequences. A TETRA call set up end-to-end encrypted is marked encrypted and never plays; a cell that encrypts its air interface (TEA) says so on its card, and its traffic is marked encrypted, not decoded. Tap anything for all it carried.</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-flband]', view).forEach(b => b.onclick = () => fleetSetBand(b.dataset.flband!));
  qa<HTMLButtonElement>('[data-flspan]', view).forEach(b => b.onclick = () => fleetSetSpan(Number(b.dataset.flspan)));
  qa<HTMLButtonElement>('[data-flview]', view).forEach(b => b.onclick = () => {
    // a tab is a new view: an open detail card closes, so what the tab shows is what is on screen
    fleetUi.view = b.dataset.flview as FleetView; if (FLEET_WIDE.matches) { fleetUi.sel = null; fleetUi.unit = null; } refreshFleet(true);
    // On a phone every section is on one page: the tab jumps to its section.
    if (!FLEET_WIDE.matches) setTimeout(() => { const t = fleetUi.view === 'log' ? q('#fl-log') : q(`[data-flsec="${fleetUi.view}"]`), sc = $('view'); const r = t?.getBoundingClientRect(); if (t && r) sc.scrollTo({ top: sc.scrollTop + r.top - sc.getBoundingClientRect().top - 56 }); }, 60);
    // the wide column scrolls as one: what the tab shows comes into view under the tabs
    else { const col = q<HTMLElement>('.view.fleet > .controls'), tb = q<HTMLElement>('.fl-tabs'); if (col && tb) col.scrollTo({ top: Math.max(0, tb.getBoundingClientRect().top - col.getBoundingClientRect().top + col.scrollTop - 64), behavior: 'smooth' }); }
  });
  // The chip of the section on screen lights up as the page scrolls.
  const sc = $('view');
  if (flSpy) sc.removeEventListener('scroll', flSpy);
  flSpy = () => {
    if (state.app !== 'fleet' || FLEET_WIDE.matches) return;
    const top = sc.getBoundingClientRect().top + 120;
    let cur = 'map';
    for (const v of ['map', 'tgs', 'systems', 'calls', 'grants', 'freqs', 'log']) {
      const el = v === 'log' ? q('#fl-log') : q(`[data-flsec="${v}"]`);
      if (el && el.getBoundingClientRect().top <= top) cur = v;
    }
    qa<HTMLButtonElement>('.fl-jump [data-flview]').forEach(b => b.classList.toggle('on', b.dataset.flview === cur));
  };
  sc.addEventListener('scroll', flSpy, { passive: true });
  flSpy();
  const full = q('#fl-full'); if (full) full.onclick = () => setFleetFull(!fleetUi.full);
  $('fl-export').onclick = () => worker?.postMessage({ type: 'fleet', cmd: 'export' });
  const pick = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-flsel]');
    if (t) { const [kind, ...rest] = t.dataset.flsel!.split(':'); fleetPick({ kind: kind as 'unit' | 'tg' | 'sys' | 'car', key: rest.join(':') }); }
  };
  /** Lock, unlock and position buttons, wherever they are: true when the click was one of them. */
  const special = (e: Event): boolean => {
    const t = e.target as HTMLElement;
    const lk = t.closest<HTMLElement>('[data-fllock]'); if (lk) { const [sys, site] = lk.dataset.fllock!.split('|'); const l = dispatchLockFor(sys, site ?? ''); if (l) dispatchLock(l); return true; }
    if (t.closest('[data-flunlock]')) { dispatchLock(null); return true; }
    const go = t.closest<HTMLElement>('[data-flgo]'); if (go) { const [la, lo, ...k] = go.dataset.flgo!.split(','); dispatchGoTo(Number(la), Number(lo), k.join(',')); return true; }
    return false;
  };
  $('fl-cards').onclick = (e) => { if (!special(e)) pick(e); };
  $('fl-tgs').onclick = (e) => {
    if ((e.target as HTMLElement).closest('[data-flsel]')) { pick(e); return; }
    const f = (e.target as HTMLElement).closest<HTMLElement>('[data-flfollow]'); if (f) dispatchFollowTap(f.dataset.flfollow ?? '');
  }; $('fl-grants').onclick = pick; $('fl-freqs').onclick = pick;
  $('fl-mode').onclick = (e) => {
    if (special(e)) return;
    const f = (e.target as HTMLElement).closest<HTMLElement>('[data-flfollow]'); if (f) { dispatchFollowTap(f.dataset.flfollow ?? ''); return; }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-flmode]'); if (!b) return;
    if (b.dataset.flmode === 'all') { dispatchLock(null); return; }
    if (fleetUi.lock) return;
    const s = fleetUi.snap, sel = fleetUi.sel?.kind === 'sys' ? fleetUi.sel.key : '';
    const playing = s ? s.calls.find(c => c.key === s.playing) : undefined, now = Date.now();
    const sys = sel || playing?.sys || s?.calls.find(c => c.onAir && c.sys)?.sys || s?.systems.filter(x => now - x.lastMs < 15_000).sort((a, b) => b.grants - a.grants)[0]?.key || '';
    const l = sys ? dispatchLockFor(sys) : null;
    if (l) dispatchLock(l); else log('no system to lock on yet, wait for one to show or lock from its card');
  };
  $('fl-now').onclick = (e) => { if (special(e)) return; pick(e); };
  const callClick = (e: Event) => {
    if (special(e)) return;
    const t = e.target as HTMLElement;
    const pref = t.closest<HTMLElement>('[data-fltg]'); if (pref) { const [kind, ...rest] = pref.dataset.fltg!.split(':'); dispatchPref(kind as 'mute' | 'hold' | 'prio', rest.join(':')); return; }
    const play = t.closest<HTMLElement>('[data-flplay]'); if (play) { void ensureAudio(); worker?.postMessage({ type: 'fleet', cmd: 'replay', key: play.dataset.flplay }); return; }
    pick(e);
  };
  $('fl-onair').onclick = callClick; $('fl-calls').onclick = callClick;
  $('fl-audio').onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-flaudio]'); if (b) { dispatchAudio(!fleetUi.audioOn); refreshFleet(true); } };
  $('fl-audio').oninput = (e) => { const r = e.target as HTMLInputElement; if (r.type === 'range') dispatchAudio(fleetUi.audioOn, Number(r.value) / 100); };
  // A redraw between press and release would swap the element under the pointer and lose the click.
  const hold = () => { fleetUi.hold = true; };
  const release = () => { if (!fleetUi.hold) return; setTimeout(() => { fleetUi.hold = false; refreshFleet(true); }, 0); };
  for (const id of ['fl-tgs', 'fl-cards', 'fl-calls', 'fl-onair', 'fl-grants', 'fl-freqs', 'fl-detail', 'fl-audio', 'fl-mode', 'fl-now']) $(id).onpointerdown = hold;
  if (!fleetUi.wired) { fleetUi.wired = true; window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); }
  $('fl-detail').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-fldo]'); if (b) { if (b.dataset.fldo === 'close') fleetUi.sel = null; else if (b.dataset.fldo === 'map') { if (!FLEET_WIDE.matches) fleetUi.view = 'map'; const u = fleetUi.snap?.units.find(x => x.key === fleetUi.sel?.key); refreshFleet(true); if (u && u.lat !== null && u.lon !== null) geo?.center(u.lat, u.lon, 15); return; } refreshFleet(true); return; }
    const pref = (e.target as HTMLElement).closest<HTMLElement>('[data-fltg]'); if (pref) { const [kind, ...rest] = pref.dataset.fltg!.split(':'); dispatchPref(kind as 'mute' | 'hold' | 'prio', rest.join(':')); return; }
    const play = (e.target as HTMLElement).closest<HTMLElement>('[data-flplay]'); if (play) { void ensureAudio(); worker?.postMessage({ type: 'fleet', cmd: 'replay', key: play.dataset.flplay }); return; }
    pick(e);
  };
  view.classList.toggle('fleetfull', fleetUi.full);
  // Unit reports carry only the low bits of a position: with no position of our own, the region on the map resolves them.
  const dragged = (lat: number, lon: number) => { if (!state.home && !lastKnownPos()) worker?.postMessage({ type: 'fleetRef', lat, lon }); };
  geo = new GeoMap($('fl-map'), { home: state.home, start: mapStart(state.home), fitPins: true, steady: true, declutter: true, twoFinger: !FLEET_WIDE.matches, onPick: id => fleetPick({ kind: 'unit', key: id.replace(/^call:/, '') }), onDragEnd: dragged, log, fallback: () => state.home ?? lastKnownPos() ?? zoneGuess() });
  clearInterval(fleetUi.timer);
  fleetUi.timer = window.setInterval(() => {
    if (state.app !== 'fleet') { clearInterval(fleetUi.timer); clearTimeout(fleetUi.scanTimer); return; }
    if (Date.now() - fleetUi.knownAt > 15_000) { fleetUi.knownAt = Date.now(); worker?.postMessage({ type: 'fleet', cmd: 'known' }); }
    refreshFleet();
  }, 500);
  refreshList('fleet');
  refreshFleet(true);
}
/** Shows a call's position on the map: the map view on a phone, centered there, the unit picked when there is one. */
function dispatchGoTo(lat: number, lon: number, unitKey: string): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (!FLEET_WIDE.matches) fleetUi.view = 'map';
  if (unitKey && fleetUi.snap?.units.some(u => u.key === unitKey)) { fleetUi.sel = { kind: 'unit', key: unitKey }; fleetUi.unit = null; worker?.postMessage({ type: 'fleet', cmd: 'unit', key: unitKey }); }
  refreshFleet(true);
  requestAnimationFrame(() => geo?.center(lat, lon, 15));
}
function fleetPick(sel: FleetSel): void {
  fleetUi.sel = sel && fleetUi.sel && fleetUi.sel.kind === sel.kind && fleetUi.sel.key === sel.key ? null : sel;
  fleetUi.unit = null;
  if (fleetUi.sel?.kind === 'unit') worker?.postMessage({ type: 'fleet', cmd: 'unit', key: fleetUi.sel.key });
  refreshFleet(true);
}
const flPill = (text: string, tone: '' | 'ok' | 'red' | 'acc' = '') => `<span class="tr-pill ${tone}">${esc(text)}</span>`;
function fleetHead(s: FleetSnap | null, now: number): string {
  const sites = s ? s.systems.reduce((n, x) => n + x.sites.length, 0) : 0, units = s?.units.length ?? 0, live = s ? s.carriers.filter(c => c.hz > s.spanLo && c.hz < s.spanHi && now - c.lastMs < 4_000) : [];
  const w = fleetUi.windows[fleetUi.idx], c = s?.centerHz ?? w?.hz ?? 0, band = FLEET_BANDS.find(b => c >= b[2] - 2e6 && c <= b[3] + 2e6) ?? FLEET_BANDS.find(b => b[0] === w?.band);
  const scan = fleetUi.visit ? `CHECKING POSITIONS · BACK IN ${Math.max(0, Math.ceil((fleetUi.visit.until - now) / 1000))} s` : fleetUi.lock ? 'LOCKED' : fleetUi.windows.length > 1 ? (fleetAuto?.mode === 'hold' ? `${fleetUi.band === 'AUTO' ? 'AUTO' : 'SCAN'} · HOLDING WHERE THE VOICE IS` : fleetAuto?.mode === 'survey' ? `AUTO · FIRST PASS · ${fleetUi.idx + 1}/${fleetUi.windows.length} · NEXT ${Math.max(0, Math.ceil((fleetUi.dwellEnd - now) / 1000))} s` : fleetAuto?.mode === 'look' ? `LOOKING AROUND · BACK IN ${Math.max(0, Math.ceil((fleetUi.dwellEnd - now) / 1000))} s` : `${fleetUi.band === 'AUTO' ? 'AUTO SCAN' : 'SCAN'} · ${fleetUi.idx + 1}/${fleetUi.windows.length} · ${fleetUi.found ? 'STAYING' : 'NEXT'} ${Math.max(0, Math.ceil((fleetUi.dwellEnd - now) / 1000))} s`) : 'HOLDING';
  const span = s ? `${fleetMhz(s.spanLo, 3)}–${fleetMhz(s.spanHi, 3)} MHz` : '';
  const tile = (n: number | string, l: string) => `<span><b>${n}</b><small>${l}</small></span>`;
  const onAir = s?.calls.filter(c => c.onAir && c.kind === 'call' && !c.outside).length ?? 0;
  return `<div class="fl-watch"><b>${esc(band ? band[1] + ' MHz' : '')}</b><small>${span}${s ? ` · ${live.length} carriers · ${s.slots} decoding` : ''}</small><em class="${fleetUi.found ? 'on' : ''}">${scan}</em></div>`
    + `<div class="fl-count">${tile(s?.systems.length ?? 0, 'SYSTEMS')}${tile(sites, 'SITES')}${tile(units, 'UNITS')}<span class="${onAir ? 'air' : ''}"><b>${onAir}</b><small>ON AIR</small></span>${tile(s?.perMin ?? 0, 'GRANTS/MIN')}${tile(s?.blocks ?? 0, 'BLOCKS')}</div>`;
}
function fleetIdenRows(idens: FleetIden[]): string {
  if (!idens.length) return '<div class="fl-dim">no channel table heard yet</div>';
  return `<table class="fl-tab"><tr><th>ID</th><th>BASE MHz</th><th>STEP</th><th>OFFSET</th><th>KIND</th></tr>${idens.map(i => `<tr><td>${i.iden}</td><td>${(i.base / 1e6).toFixed(5)}</td><td>${(i.spacing / 1e3).toFixed(3)}k</td><td>${i.txOffset >= 0 ? '+' : ''}${(i.txOffset / 1e6).toFixed(3)}</td><td>${i.tdma ? `TDMA ×${i.slots}` : i.form}</td></tr>`).join('')}</table>`;
}
function fleetSiteHtml(sys: FleetSystem, site: FleetSite, now: number): string {
  const age = now - site.lastMs, live = age < 10_000, s = fleetUi.snap;
  const cars = site.carriers.map(k => s?.carriers.find(c => c.key === k)).filter((c): c is FleetCarrier => !!c);
  const ccs = cars.map(c => `<span class="fl-cc ${c.role}" data-flsel="car:${c.key}">${fleetMhz(c.hz)}<small>${c.role === 'rest' ? 'REST' : c.role === 'control' ? (sys.proto === 'P25' || sys.proto === 'TETRA' || sys.proto === 'SMARTNET' ? 'CONTROL' : 'REPEATER') : c.role.toUpperCase()}${c.lcn ? ` · LCN ${c.lcn}` : ''}</small></span>`).join('');
  const lvl = Math.max(0, Math.min(1, site.levelDb / 50));
  let body = '';
  if (sys.proto === 'SMARTNET') {
    body += `<div class="fl-kv">${site.site >= 0 ? `<span>CONTROL CHANNEL <b>${site.site}</b></span>` : ''}${site.time ? `<span>${esc(site.time.toUpperCase())}</span>` : ''}</div>`;
    if (site.lcns.length) body += `<div class="fl-lcn">${site.lcns.map(l => `<span><b>CH ${l.lcn}</b><i>${fleetMhz(l.hz)}</i></span>`).join('')}</div>`;
  } else if (sys.proto === 'NXDN') {
    body += `<div class="fl-kv"><span>${sys.trunk === 'CONVENTIONAL' ? 'RAN' : 'SITE'} <b>${site.site}</b></span>${site.nac >= 0 && sys.trunk === 'TYPE-C' ? `<span>RAN <b>${site.nac}</b></span>` : ''}${site.time ? `<span>${esc(site.time.toUpperCase())}</span>` : ''}${site.cls > 0 ? `<span>VERSION <b>${site.cls}</b></span>` : ''}</div>`;
    if (site.neighbors.length) body += `<div class="fl-nb"><small>ADJACENT</small>${site.neighbors.map(nb => `<span class="${nb.heard ? 'heard' : ''}">${esc(nb.label.toUpperCase())}<i>${nb.hz ? fleetMhz(nb.hz) : nb.ch}</i></span>`).join('')}</div>`;
    if (site.lcns.length) body += `<div class="fl-lcn">${site.lcns.map(l => `<span><b>${sys.trunk === 'TYPE-D' ? 'REPEATER' : 'CH'} ${l.lcn}</b><i>${fleetMhz(l.hz)}</i></span>`).join('')}</div>`;
  } else if (sys.proto === 'TETRA') {
    body += `<div class="fl-kv">${site.lra >= 0 ? `<span>LA <b>${site.lra}</b></span>` : ''}<span>COLOR CODE <b>${site.site}</b></span>${site.time ? `<span>${esc(site.time.toUpperCase())}</span>` : ''}${site.cls >= 0 ? `<span>CELL LOAD <b>${['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'][site.cls] ?? site.cls}</b></span>` : ''}${sys.security ? `<span><b>${esc(sys.security)}</b></span>` : ''}</div>`;
    if (site.secondary.length) body += `<div class="fl-nb"><small>CARRIERS</small>${site.secondary.map(x => `<span>${fleetMhz(x.hz)}${x.ch ? `<i>${esc(x.ch.toUpperCase())}</i>` : ''}</span>`).join('')}</div>`;
  } else if (sys.proto === 'P25') {
    body += `<div class="fl-kv"><span>NAC <b>${site.nac >= 0 ? site.nac.toString(16).toUpperCase().padStart(3, '0') : '-'}</b></span><span>RFSS <b>${site.rfss}</b></span><span>SITE <b>${site.site}</b></span>${site.time ? `<span>CLOCK <b>${esc(site.time.slice(11, 19))}</b></span>` : ''}</div>`;
    if (site.neighbors.length) body += `<div class="fl-nb"><small>NEIGHBORS</small>${site.neighbors.map(nb => `<span class="${nb.heard ? 'heard' : ''}">${nb.label}<i>${fleetMhz(nb.hz)}</i></span>`).join('')}</div>`;
    if (site.secondary.length) body += `<div class="fl-nb"><small>SECONDARY</small>${site.secondary.map(x => `<span>${fleetMhz(x.hz)}</span>`).join('')}</div>`;
    body += fleetIdenRows(site.idens);
  } else {
    if (site.lcns.length || site.rest >= 0) body += `<div class="fl-lcn">${site.lcns.map(l => `<span class="${l.lcn === site.rest ? 'rest' : site.busy.includes(l.lcn) ? 'busy' : ''}"><b>LCN ${l.lcn}</b><i>${fleetMhz(l.hz)} TS${l.slot + 1}</i></span>`).join('')}${site.rest >= 0 && !site.lcns.some(l => l.lcn === site.rest) ? `<span class="rest"><b>LCN ${site.rest}</b><i>rest, not heard</i></span>` : ''}${site.busy.filter(n => !site.lcns.some(l => l.lcn === n)).map(n => `<span class="busy"><b>LCN ${n}</b><i>busy</i></span>`).join('')}</div>`;
    body += `<div class="fl-kv"><span>UNITS <b>${site.units}</b></span>${site.rest >= 0 ? `<span>REST <b>LCN ${site.rest}</b></span>` : ''}</div>`;
  }
  const lockedHere = fleetUi.lock?.sys === sys.key && fleetUi.lock.site === site.label;
  const siteLock = sys.proto === 'P25' ? `<button class="chip fl-lockb ${lockedHere ? 'on' : ''}" ${lockedHere ? 'data-flunlock="1"' : `data-fllock="${esc(sys.key)}|${esc(site.label)}"`} title="${lockedHere ? 'unlock' : 'lock on this site'}">${lockedHere ? 'LOCKED' : 'LOCK SITE'}</button>` : '';
  return `<div class="fl-site ${live ? '' : 'dim'}"><div class="fl-sh"><b>${esc(sys.proto === 'P25' ? `SITE ${site.label}` : site.label.toUpperCase())}</b>${site.callsign && sys.proto === 'P25' ? `<em>${esc(site.callsign)}</em>` : ''}${siteLock}<span class="fl-lvl"><i style="width:${(100 * lvl).toFixed(0)}%"></i></span><small>${site.levelDb.toFixed(0)} dB · ${fleetAgo(age)}</small></div><div class="fl-ccs">${ccs}</div>${body}</div>`;
}
/** A CW ID chip: the callsign, how long ago it was keyed, and on which channel. */
const flIdChip = (id: string, ago: number, hz = 0) => `<span class="fl-id" title="CW ID${hz ? ` on ${fleetMhz(hz)} MHz` : ''}, ${fleetAgoText(ago)}"><small>ID</small>${esc(id)}<i>${fleetAgo(ago)}</i></span>`;
function fleetSystemCard(sys: FleetSystem, now: number): string {
  const col = FLEET_COLORS[sys.color % FLEET_COLORS.length], age = now - sys.lastMs, flash = Math.max(0, 1 - age / 1500);
  const title = fleetSysTitle(sys);
  const sel = fleetUi.sel?.kind === 'sys' && fleetUi.sel.key === sys.key;
  const locked = fleetUi.lock?.sys === sys.key && !fleetUi.lock.site, out = !!fleetUi.lock && fleetUi.lock.sys !== sys.key;
  const sn = fleetUi.snap, away = !!sn && sys.heardHz.length > 0 && sys.heardHz.every(h => h < sn.spanLo || h > sn.spanHi);
  const lockB = `<button class="chip fl-lockb ${locked ? 'on' : ''}" ${locked ? 'data-flunlock="1"' : `data-fllock="${esc(sys.key)}|"`} title="${locked ? 'unlock' : 'lock on this system'}">${locked ? 'LOCKED' : 'LOCK'}</button>`;
  return `<div class="fl-sys ${sel ? 'sel' : ''} ${age < 15_000 && !out ? '' : 'dim'} ${fleetUi.lock?.sys === sys.key ? 'locked' : ''}" style="--sys:${col};--flash:${flash.toFixed(2)}">`
    + `<div class="fl-syh" data-flsel="sys:${esc(sys.key)}"><span class="fl-proto">${sys.proto}</span><span class="fl-syt"><b>${esc(title)}</b><small>${sys.security ? `${esc(sys.security)} · ` : ''}${sys.callsign ? `${esc(sys.callsign)} · ` : ''}${sys.sites.length} site${sys.sites.length === 1 ? '' : 's'} · ${sys.units} units · ${sys.tgs} talkgroups · ${sys.grants} grants</small></span>${sys.cwId ? flIdChip(sys.cwId, now - sys.cwIdMs, sys.cwIdHz) : ''}${lockB}<span class="mt-live ${age < 15_000 ? 'on' : ''}"><i></i>${age < 15_000 ? 'LIVE' : away ? `NOT IN SPAN · LAST HEARD ${fleetAgoText(age).toUpperCase()}` : fleetAgo(age)}</span></div>`
    + sys.sites.map(x => fleetSiteHtml(sys, x, now)).join('') + '</div>';
}
function fleetGrantRow(g: FleetGrant, now: number): string {
  const col = fleetColor(g.sys), flash = Math.max(0, 1 - (now - g.ms) / 1200);
  const who = g.group ? `<span class="fl-tg" data-flsel="tg:${esc(g.sys)}/${g.tg}">TG ${g.tg}</span>` : `<span class="fl-tg">UNIT ${g.tg}</span>`;
  const nx = g.sys.startsWith('NXDN') || g.sys.startsWith('SMARTNET');
  const ch = g.hz > 0 ? `${fleetMhz(g.hz)}${g.tdma ? ` · TDMA S${g.slot + 1}` : nx ? ` · ${esc(g.ch)}` : g.lpcn !== undefined && g.lpcn >= 0 ? ` · TS${g.slot + 1} · LPCN ${g.lpcn}` : g.sys.startsWith('TETRA') ? ` · TS${g.slot + 1}` : ''}` : `${esc(g.ch)}${nx ? '' : g.lpcn !== undefined && g.lpcn >= 0 ? ` · TS${g.slot + 1}` : g.tdma && g.slot >= 0 ? ` · TS${g.slot + 1}` : ''}`;
  return `<div class="fl-grant ${g.emergency ? 'emerg' : ''}" style="--sys:${col};--flash:${flash.toFixed(2)}"><i></i><span class="fl-gt">${fleetClock(g.ms)}</span>${who}<span class="fl-src">${g.src ? `← ${g.src}` : ''}</span><span class="fl-gch">${ch}</span><span class="fl-gf">${g.emergency ? flPill('EMERG', 'red') : ''}${g.encrypted ? flPill('ENC', 'acc') : ''}${g.kind === 'datagrant' ? flPill('DATA') : g.kind === 'u2u' ? flPill('PRIVATE') : ''}</span></div>`;
}
function fleetGrantsHtml(s: FleetSnap, now: number): string {
  const tgs = s.tgs.filter(t => t.recent.length > 0).sort((a, b) => b.recent.length - a.recent.length || b.lastMs - a.lastMs).slice(0, 14);
  const max = Math.max(1, ...tgs.map(t => t.recent.length));
  const bars = tgs.length ? `<div class="fl-bars">${tgs.map(t => `<div class="fl-bar" data-flsel="tg:${esc(t.key)}" style="--sys:${fleetColor(t.sys)}"><b>TG ${t.tg}</b><span><i style="width:${(100 * t.recent.length / max).toFixed(1)}%"></i></span><small>${t.recent.length} · ${fleetAgo(now - t.lastMs)}</small></div>`).join('')}</div>` : '';
  return (bars || '<div class="fl-dim">talkgroup activity over the last 10 minutes shows here</div>') + (s.grants.length ? s.grants.map(g => fleetGrantRow(g, now)).join('') : '<div class="empty">no grants yet · a quiet system may go minutes between calls</div>');
}
function fleetFreqsHtml(s: FleetSnap, now: number): string {
  const rows = s.carriers.filter(c => now - c.lastMs < 600_000);
  if (!rows.length) return '<div class="empty">no carriers found yet</div>';
  return rows.map(c => {
    const age = now - c.lastMs, inSpan = c.hz > s.spanLo && c.hz < s.spanHi, live = inSpan && age < 4_000;
    const id = c.nac >= 0 ? `NAC ${c.nac.toString(16).toUpperCase().padStart(3, '0')}` : c.cc >= 0 ? `CC ${c.cc}` : '';
    const sel = fleetUi.sel?.kind === 'car' && fleetUi.sel.key === String(c.key);
    return `<div data-flsel="car:${c.key}" class="fl-frow ${live ? '' : 'dim'} ${sel ? 'sel' : ''}" style="--sys:${c.sys ? fleetColor(c.sys) : 'transparent'}"><b><i class="fl-dot"></i>${fleetMhz(c.hz)}</b>`
      + `<span class="fl-fcls">${c.cls || (c.decoding ? 'LISTENING' : 'NOT HEARD YET')}${c.callsign ? ` ${flIdChip(c.callsign, now - c.callsignMs)}` : ''}</span>`
      + `<span class="fl-frole">${c.role ? c.role.toUpperCase() : ''}${c.tdma ? ' TDMA' : ''}</span><span class="fl-fid">${id}</span>`
      + `<span class="fl-flvl"><span class="fl-lvl"><i style="width:${Math.max(0, Math.min(100, 2 * c.levelDb)).toFixed(0)}%"></i></span>${c.levelDb.toFixed(0)} dB</span>`
      + `<em>${live ? (c.decoding ? 'DECODING' : 'LIVE') : inSpan ? fleetAgo(age) : 'OUT OF SPAN'}</em></div>`;
  }).join('');
}
const flDur = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const dispatchKey = (c: FleetCall) => c.group ? `${c.sys}/${c.tg}` : `${c.sys}/u${c.tg}`;
function dispatchPrefButtons(key: string): string {
  const p = fleetUi.prefs, on = (b: boolean) => b ? 'on' : '';
  return `<button class="${on(p.mute.includes(key))}" data-fltg="mute:${esc(key)}">MUTE</button><button class="${on(p.hold === key)}" data-fltg="hold:${esc(key)}">FOLLOW</button><button class="${on(p.prio.includes(key))}" data-fltg="prio:${esc(key)}">PRIORITY</button>`;
}
/** Why a call has no audio, in a few words, or '' when it has some. */
function dispatchAudioNote(c: FleetCall, codecs: string[]): string {
  if (c.encrypted) return 'encrypted, no audio';
  if (c.audioMs > 0) return '';
  if (c.decoded >= 10 && c.badFrames > 0.5 * c.decoded) return 'weak signal';
  if (c.sec === 'unknown' && c.voiceMs) return 'no voice decoded yet';
  if (!codecs.includes(c.codec)) return c.codec === 'imbe' ? 'no audio yet, the P25 full-rate vocoder is not built' : c.codec === 'tetra' ? 'no audio yet, the TETRA codec is not built' : `no audio yet, the half-rate vocoder for ${c.proto === 'DMR' ? 'DMR' : 'Phase 2'} is not built`;
  return c.voiceMs ? '' : 'voice channel not heard';
}
const dispatchWho = callWho;
/** Security as the call itself states it: the grant's service options, the link control, the encryption sync, the privacy bit. */
const dispatchSec = (c: FleetCall) => { const t = secText(c); return c.protectedHint && !c.encrypted ? flPill('PROTECTED?', '') : t ? flPill(t, c.encrypted ? 'acc' : 'ok') : ''; };
/** Where a P25 key and message indicator or a DMR privacy header were read, for the card's security line. */
function dispatchSecLine(c: FleetCall): string {
  if (!c.encrypted) return '';
  const bits: string[] = [];
  if (c.mi) bits.push(`MI ${c.mi.toUpperCase()}`);
  if (c.pi) bits.push(`PRIVACY HEADER ${c.pi.toUpperCase()}`);
  if (c.secFrom) bits.push(`from the ${SEC_FROM[c.secFrom] ?? c.secFrom}`);
  return bits.length ? `<div class="fl-sec ${c.encrypted ? 'enc' : ''}">${esc(bits.join(' · '))}</div>` : '';
}
/** The listener's own position, for distance and direction to a call. */
const dispatchMe = () => state.home ?? lastKnownPos();
/** A call's position as a button that shows it on the map, or '' when it has none. */
function dispatchPosChip(c: FleetCall, long: boolean): string {
  const p = c.pos; if (!p) return '';
  const who = p.via === 'unit' ? `UNIT ${p.unit}` : `TG MEMBER ${p.unit}`;
  return `<button class="fl-loc ${c.onAir ? 'live' : ''}" data-flgo="${p.lat},${p.lon},${esc(c.sys)}/${p.unit}" title="show on the map"><small>${long ? 'HEARD FROM' : 'AT'}</small>${esc(posText(p, dispatchMe()))}${long ? `<i>${esc(who)} · ${fleetAgoText(Date.now() - p.ms)}</i>` : ''}</button>`;
}
function dispatchOnAirCard(c: FleetCall, s: FleetSnap, now: number): string {
  const col = c.sys ? fleetColor(c.sys) : 'var(--accent)', sys = s.systems.find(x => x.key === c.sys);
  const lvl = Math.max(0, Math.min(1, c.levelDb / 40)), segs = 16, lit = Math.round(lvl * segs);
  const meter = Array.from({ length: segs }, (_, i) => `<i class="${i < lit ? (i >= segs - 3 ? 'hi' : 'on') : ''}"></i>`).join('');
  const note = dispatchAudioNote(c, s.codecs), key = dispatchKey(c), sel = c.group ? `tg:${esc(key)}` : `unit:${esc(c.sys)}/${c.tg}`;
  const lpName = c.proto === 'NXDN' || c.proto === 'SMARTNET' ? 'CH' : 'LPCN', lp = c.lpcn >= 0 ? ` · ${lpName} ${c.lpcn}` : '';
  const ch = c.hz > 0 ? `${fleetMhz(c.hz)} MHz${c.tdma ? ` · TDMA S${c.slot + 1}` : c.proto === 'DMR' || c.proto === 'TETRA' ? ` · TS${c.slot + 1}` : ''}${lp}` : c.lpcn >= 0 ? `${lpName} ${c.lpcn}${c.proto === 'DMR' ? ` · TS${c.slot + 1}` : ''} · ${c.proto === 'SMARTNET' ? 'channel plan not proved' : 'learning its frequency'}` : 'channel not resolved';
  // the card slides in once, when the call first shows; the dot blinks with the redraws (twice a second)
  const first = fleetUi.airSeen.get(c.key) ?? now; if (!fleetUi.airSeen.has(c.key)) { fleetUi.airSeen.set(c.key, now); if (fleetUi.airSeen.size > 400) fleetUi.airSeen.delete(fleetUi.airSeen.keys().next().value as string); }
  const fresh = now - first < 450, blink = Math.floor(now / 500) % 2 === 1;
  const following = fleetUi.following?.key === c.key, car = c.hz > 0 ? s.carriers.find(x => Math.abs(x.hz - c.hz) < 3_200 && x.callsign) : undefined;
  const playing = s.playing === c.key && fleetUi.audioOn, ended = !c.onAir;
  const badge = ended ? 'ENDED' : c.emergency ? 'EMERGENCY' : c.outside ? 'OTHER SYSTEM' : c.muted ? 'MUTED' : playing ? 'PLAYING' : 'ON AIR';
  const lockB = !fleetUi.lock && c.sys ? `<button class="chip fl-lockb" data-fllock="${esc(c.sys)}|" title="lock on this system">LOCK</button>` : '';
  const vu = playing ? `<div class="fl-vu" data-vu="${esc(c.key)}" style="--vu:${dispatchVuPct(c.key).toFixed(0)}%"><small>AUDIO</small><span><i></i></span></div>` : '';
  return `<div class="fl-air ${fresh ? 'fresh' : ''} ${blink ? 'blink' : ''} ${c.emergency ? 'emerg' : ''} ${c.encrypted ? 'enc' : ''} ${c.muted ? 'muted' : ''} ${c.outside ? 'out' : ''} ${c.prio ? 'prio' : ''} ${playing ? 'playing' : ''} ${ended ? 'ended' : ''}" data-flkey="${esc(c.key)}" style="--sys:${col}">`
    + `<div class="fl-air-h"><span class="fl-onbadge"><i></i>${badge}</span><span class="fl-proto">${c.proto}</span><b data-flsel="${sel}">${esc(dispatchWho(c))}</b>${c.emergency && !ended ? '' : c.emergency ? flPill(`EMERGENCY · ${fleetAgoText(now - c.endMs)}`, 'red') : ''}${dispatchSec(c)}<span class="fl-air-t">${flDur((ended ? c.endMs : now) - c.startMs)}</span></div>`
    + `<div class="fl-air-b"><span class="fl-air-u">${c.src ? `<small>${c.alias ? esc(c.alias.toUpperCase()) : 'UNIT'}</small><b data-flsel="unit:${esc(c.sys)}/${c.src}">${c.src}</b>` : c.alias ? `<small>TALKER</small><b>${esc(c.alias)}</b>` : '<small>UNIT</small><b>-</b>'}</span><span class="fl-air-s"><small>${esc(sys?.label ?? (c.sys || 'no control channel'))}${c.site ? ` · SITE ${esc(c.site)}` : ''}</small><span>${ch}${following ? ' · FOLLOWING' : ''}</span></span>${car ? flIdChip(car.callsign, now - car.callsignMs, car.hz) : ''}${lockB}</div>`
    + dispatchPosChip(c, true) + dispatchSecLine(c) + vu
    + `<div class="fl-meter" title="signal ${c.levelDb.toFixed(0)} dB">${meter}<small>${c.levelDb > 0 ? `${c.levelDb.toFixed(0)} dB` : ''}</small></div>`
    + `<div class="fl-air-f"><small>${c.voiceMs ? `VOICE ${(c.voiceMs / 1000).toFixed(1)} s` : c.granted ? 'GRANTED' : ''}${note ? ` · ${esc(note)}` : ''}</small><span class="pc-m">${dispatchPrefButtons(key)}</span></div></div>`;
}
function dispatchCallRow(c: FleetCall, now: number): string {
  if (c.kind === 'id') return `<div class="fl-call idrow" style="--sys:${c.sys ? fleetColor(c.sys) : 'var(--muted)'}"><i></i><span class="fl-gt">${fleetClock(c.startMs)}</span>${flIdChip(c.cwId, now - c.startMs, c.hz)}<span class="fl-src">CW ID</span><span class="fl-cd">${fleetMhz(c.hz)} MHz</span></div>`;
  const col = c.sys ? fleetColor(c.sys) : 'var(--muted)', dur = (c.onAir ? now : c.endMs) - c.startMs;
  const sel = c.group ? `tg:${esc(dispatchKey(c))}` : `unit:${esc(c.sys)}/${c.tg}`;
  const enc = c.encrypted ? secText(c).replace(/^ENCRYPTED/, 'ENC') : '';
  return `<div class="fl-call ${c.onAir ? 'live' : ''} ${c.emergency ? 'emerg' : ''} ${c.outside ? 'out' : ''}" style="--sys:${col}"><i></i><span class="fl-gt">${fleetClock(c.startMs)}</span><b class="fl-tg" data-flsel="${sel}">${esc(dispatchWho(c))}</b>`
    + `<span class="fl-src">${c.src ? `← ${c.src}` : ''}${c.alias ? ` ${esc(c.alias)}` : ''}</span><span class="fl-cd">${flDur(dur)}${c.voiceMs ? ` · voice ${(c.voiceMs / 1000).toFixed(1)} s` : ''}</span>`
    + `<span class="fl-gf">${c.onAir ? flPill('ON AIR', 'ok') : ''}${c.emergency ? flPill('EMERG', 'red') : ''}${enc ? flPill(enc, 'acc') : ''}${c.cwId ? flIdChip(c.cwId, now - c.endMs) : ''}${c.audioMs ? `<button class="chip" data-flplay="${esc(c.key)}" title="replay">▶</button>` : ''}</span>${dispatchPosChip(c, false)}</div>`;
}
function dispatchCallsHtml(s: FleetSnap, now: number): string {
  const ended = s.calls.filter(c => !c.onAir && c.kind === 'call');
  if (!s.calls.length) return '<div class="empty">no calls yet · each voice grant and each transmission heard is logged here</div>';
  const total = ended.reduce((n, c) => n + c.endMs - c.startMs, 0);
  return `<div class="fl-dim">${ended.length} recent calls · ${flDur(total)} on the air${s.codecs.length ? ' · audio kept in memory for replay, up to 2 min a call' : ''}</div>` + s.calls.map(c => dispatchCallRow(c, now)).join('');
}
/** One receiver, one channel: a call outside the span is followed there, and the radio comes back when it ends. */
function dispatchFollow(s: FleetSnap, now: number): void {
  const f = fleetUi.following;
  if (f) {
    const c = s.calls.find(x => x.key === f.key);
    if (!c || !c.onAir || now > f.until) { fleetUi.following = null; tune(f.home); }
    return;
  }
  if (!s.follow || !fleetUi.audioOn) return;
  const span = s.spanHi - s.spanLo, home = s.centerHz;
  const cc = s.carriers.find(c => c.role === 'control' && c.hz > s.spanLo && c.hz < s.spanHi && (!fleetUi.lock || c.sys === fleetUi.lock.sys));
  const center = cc && Math.abs(s.follow.hz - cc.hz) < span * 0.8 ? Math.round((s.follow.hz + cc.hz) / 2) : Math.round(s.follow.hz + span * 0.2);
  // the radio stays with the call as long as it is on the air (its own end of transmission brings it back), with ten
  // minutes as a last resort
  fleetUi.following = { key: s.follow.key, home, until: now + 600_000 };
  tune(center);
}
/** The map in the open detail card: what fleetDetail put on it, mounted into its slot after each redraw. */
let fleetCardMap: { key: string; sel: string; me: { lat: number; lon: number } | null; items: GeoItem[]; shapes: GeoShape[]; fit?: [number, number][] } | null = null;
/** The card's map lives across redraws (the card's HTML is rebuilt every tick): its host moves into each new slot. */
let flcGeo: { host: HTMLElement; geo: GeoMap; fit: string; me: string } | null = null;
/** A system color the marker SVG can take (a CSS variable cannot be an SVG fill attribute). */
const flMapColor = (c: string) => c.startsWith('var(') ? '#8899aa' : c;
/** A talkgroup's or system's placed units on the card map, labeled, you with them when you are within 60 miles. */
function fleetCardUnits(key: string, placed: FleetSnap['units'], col: string, me: { lat: number; lon: number } | null): string {
  const c = flMapColor(col), near = me && placed.some(u => flDistBearing(me, { lat: u.lat!, lon: u.lon! }).mi < 60) ? me : null;
  fleetCardMap = { key, sel: '', me: near, shapes: [], items: placed.map(u => ({ id: u.key, lat: u.lat!, lon: u.lon!, label: `${u.id}`, kind: 'station' as const, color: c })) };
  return '<div class="flc-map flc-geo"></div>';
}
/** Puts the card's map into the slot the card just drew, then its markers, track and your position; it frames them when the card changes. */
function fleetCardMapMount(det: HTMLElement): void {
  const slot = det.querySelector<HTMLElement>('.flc-geo'), m = fleetCardMap;
  if (!slot || !m) return;
  if (!flcGeo) {
    const host = document.createElement('div'); host.className = 'map flc-geomap';
    slot.replaceWith(host);
    const geo = new GeoMap(host, { home: null, fitPins: true, declutter: true, twoFinger: !FLEET_WIDE.matches, onPick: id => { if (fleetCardMap?.sel !== id) fleetPick({ kind: 'unit', key: id }); }, log });
    geo.setFollow(false);
    flcGeo = { host, geo, fit: '', me: '' };
  } else slot.replaceWith(flcGeo.host);
  const g = flcGeo.geo, meKey = m.me ? `${m.me.lat},${m.me.lon}` : '';
  g.invalidate();
  if (meKey !== flcGeo.me || !g.ready) { flcGeo.me = meKey; g.setHome(m.me); }
  g.update(m.items, m.sel); g.setShapes(m.shapes);
  const fit = `${m.key}|${m.items.length}|${meKey}`;
  if (fit !== flcGeo.fit) {
    flcGeo.fit = fit;
    g.fitTo([...(m.fit ?? m.items.map(i => [i.lat, i.lon] as [number, number])), ...(m.me ? [[m.me.lat, m.me.lon] as [number, number]] : [])]);
  }
}
function fleetDetail(s: FleetSnap, now: number): string {
  fleetCardMap = null;
  const sel = fleetUi.sel; if (!sel) return '';
  const me = state.home ?? lastKnownPos() ?? null;
  const sysOf = (k: string) => s.systems.find(x => x.key === k);
  // only what has data: a field with no value is left out, never shown as a dash
  const kv = (f: [string, string | number | null | undefined | false][]) => {
    const rows = f.filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '');
    return rows.length ? `<div class="flc-kv">${rows.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(String(v))}</span></div>`).join('')}</div>` : '';
  };
  const sec = (title: string, body: string, wide = false) => body ? `<section class="flc-sec ${wide ? 'wide' : ''}"><h4>${esc(title)}</h4>${body}</section>` : '';
  const chip = (t: string, tone = '') => `<span class="flc-chip ${tone}">${esc(t)}</span>`;
  const big = (v: string, l: string) => v === '0' || v === '0%' ? '' : `<div class="flc-stat"><b>${esc(v)}</b><small>${esc(l)}</small></div>`;
  const seen = (ms: number) => now - ms < 15_000 ? chip('LIVE', 'ok') : chip(`HEARD ${agoShort(now - ms).toUpperCase()} AGO`);
  const head = (id: string, kind: string, label: string, color: string, chips: string, extra = '') =>
    `<div class="flc-head" style="--sys:${color}"><div class="flc-id"><b>${esc(id)}</b><small>${esc(kind)}</small></div><div class="flc-hl"><span>${esc(label)}</span><div class="flc-chips">${chips}</div></div>${extra}<button class="chip" data-fldo="close" aria-label="close">✕</button></div>`;
  const secText2 = (cs: FleetCall[]) => { const [e, n] = encShare(cs); return !n ? '' : e === 0 ? 'CLEAR' : e === n ? 'ENCRYPTED' : `${Math.round(100 * e / n)}% ENCRYPTED`; };
  const spark = (times: number[]) => {
    if (!times.length) return '';
    const hr = activityBuckets(times, now, 3_600_000, 30), day = activityBuckets(times, now, 86_400_000, 24);
    const inHour = hr.reduce((a, b) => a + b, 0), inDay = day.reduce((a, b) => a + b, 0);
    return (inHour ? `<div class="flc-spk"><small>LAST HOUR · ${inHour}</small>${sparkSvg(hr)}</div>` : '') + (inDay > inHour ? `<div class="flc-spk"><small>LAST DAY · ${inDay}</small>${sparkSvg(day)}</div>` : '');
  };
  const callList = (cs: FleetCall[], n = 10) => cs.length ? `<div class="flc-calls">${cs.slice(0, n).map(c => dispatchCallRow(c, now)).join('')}${cs.length > n ? `<div class="fl-dim">${cs.length - n} more</div>` : ''}</div>` : '';

  if (sel.kind === 'unit') {
    const u = s.units.find(x => x.key === sel.key); if (!u) return '';
    const sys = sysOf(u.sys), col = fleetColor(u.sys), dmr = sys?.proto === 'DMR';
    const full = fleetUi.unit?.key === u.key ? fleetUi.unit : null, reports = full ? full.reports : u.reports, trail = full ? full.trail : u.trail;
    const calls = s.calls.filter(c => c.kind === 'call' && c.sys === u.sys && (c.src === u.id || c.srcs.includes(u.id) || (!c.group && c.tg === u.id)));
    const talking = calls.find(c => c.onAir && (c.src === u.id || c.pos?.unit === u.id));
    const emerg = calls.some(c => c.emergency && (c.onAir || now - c.endMs < 600_000));
    const chips = seen(u.lastMs) + (talking ? chip('TALKING NOW', 'ok live') : '') + (emerg ? chip('EMERGENCY', 'red') : '') + (secText2(calls) ? chip(secText2(calls), calls.some(c => c.encrypted) ? 'acc' : 'ok') : '');
    const mapBtn = u.lat !== null && fleetUi.view !== 'map' ? '<button class="chip" data-fldo="map">MAP</button>' : '';
    // where: the track over the rest of the system's units, the stats it gives
    let where = '';
    if (trail.length || (u.lat !== null && u.lon !== null)) {
      const tr: [number, number, number][] = trail.length ? trail : [[u.lat!, u.lon!, u.posMs]];
      const others = s.units.filter(x => x.sys === u.sys && x.key !== u.key && x.lat !== null && x.lon !== null && u.lat !== null && Math.abs(x.lat! - u.lat!) < 0.6 && Math.abs(x.lon! - u.lon!) < 0.8);
      const st = trackStats(tr), last = tr[tr.length - 1], d = me ? flDistBearing(me, { lat: last[0], lon: last[1] }) : null;
      // a real map, the main map's tiles: the unit and its track over the rest of its system's units (dimmed), you as the ring
      const c = flMapColor(col);
      fleetCardMap = { key: `unit:${u.key}`, sel: u.key, me: me && d && d.mi < 60 ? me : null,
        items: [...others.map(x => ({ id: x.key, lat: x.lat!, lon: x.lon!, label: `${x.id}`, kind: 'station' as const, color: c, cls: 'dim' })),
          { id: u.key, lat: last[0], lon: last[1], label: `${u.id}`, kind: 'station' as const, color: c, cls: talking ? 'talk' : '' }],
        shapes: tr.length > 1 ? [{ id: u.key, pts: tr.map(p => [p[0], p[1]] as [number, number]), line: true, color: c, sel: true }] : [],
        // framed on the unit and its track (and you): the rest of the system shows where it falls in that view
        fit: tr.map(p => [p[0], p[1]] as [number, number]) };
      where = `<div class="flc-map flc-geo"></div><div class="flc-stats">`
        + (d ? big(distText(d), `FROM YOU · ${Math.round(d.deg)}°`) : '')
        + (st.mph !== null ? big(st.moving ? `${Math.round(st.mph)} mph` : 'STOPPED', st.moving ? `HEADING ${st.dir} · ${st.course}°` : 'NOT MOVING') : '')
        + big(`${st.fixes}`, st.fixes === 1 ? 'POSITION FIX' : st.spanMs > 0 ? `FIXES OVER ${flSpan(st.spanMs)}` : 'FIXES')
        + big(agoShort(now - last[2]), 'SINCE LAST FIX') + (st.mi >= 0.05 ? big(`${st.mi < 10 ? st.mi.toFixed(1) : Math.round(st.mi)} mi`, 'TRAVELED') : '')
        + `</div>` + kv([['POSITION', `${last[0].toFixed(5)}, ${last[1].toFixed(5)}`], ['LAST FIX', `${fleetClock(last[2])}${u.posVerified ? ' · checked' : ''}`]]);
    }
    const off = full?.offArea ?? u.offArea;
    if (off) where += `<div class="flc-note">${off} position ${off === 1 ? 'report' : 'reports'} outside the system's area, not placed</div>`;
    if (!where && u.posMs) where = `<div class="flc-note">${s.ref ? 'position reports outside the system\'s area, not placed' : 'position reports waiting for your location to resolve'}</div>`;
    // what it said
    const tgs = u.tgCounts.length ? `<div class="flc-tags">${u.tgCounts.slice(0, 16).map(([tg, n]) => `<span data-flsel="tg:${esc(u.sys)}/${tg}"><b>TG ${tg}</b><i>${n}</i></span>`).join('')}</div>` : '';
    // radio facts
    const site = u.site || calls.find(c => c.site)?.site || '';
    const slots = [...new Set(calls.filter(c => c.proto === 'DMR' || c.proto === 'TETRA' || c.tdma).map(c => c.slot + 1))];
    const freqs = [...new Set([...u.carriers.map(k => s.carriers.find(c => c.key === k)?.hz ?? k), ...calls.map(c => c.hz).filter(Boolean)])].sort((a, b) => a - b);
    const restSite = dmr ? sys?.sites.find(x => x.label === site) ?? sys?.sites[0] : undefined;
    const dbs = reports.map(r => r.db).filter((x): x is number => typeof x === 'number');
    const radio = kv([
      ['UNIT ID', `${u.id} · 0x${u.id.toString(16).toUpperCase()}`], ['TALKER ALIAS', u.alias || calls.find(c => c.alias)?.alias || ''],
      ['SYSTEM', sys ? `${fleetSysTitle(sys)} · ${fleetSysType(sys, s)}` : u.sys],
      ['SITE', site], ['COLOR CODE', dmr && sys && sys.cc >= 0 ? `${sys.cc}` : ''], ['SLOT', slots.length ? slots.map(x => `TS${x}`).join(', ') : ''],
      ['REST CHANNEL', restSite && restSite.rest >= 0 ? `LCN ${restSite.rest}` : ''],
      ['WACN · SYSTEM', sys?.proto === 'P25' ? `${sys.wacn.toString(16).toUpperCase().padStart(5, '0')} · ${sys.sysId.toString(16).toUpperCase().padStart(3, '0')}` : ''],
      ['HEARD ON', freqs.length ? freqs.map(h => `${fleetMhz(h)}`).join(' · ') : ''], ['GRANTS', u.grants || ''],
      ['CW ID', sys?.callsign ?? ''], ['FIRST HEARD', `${fleetClock(u.firstMs)} · ${agoShort(now - u.firstMs)} ago`], ['LAST HEARD', `${fleetClock(u.lastMs)} · ${agoShort(now - u.lastMs)} ago`],
    ]) + (dbs.length >= 3 && Math.max(...dbs) - Math.min(...dbs) >= 1 ? `<div class="flc-spk"><small>SIGNAL · ${Math.round(Math.min(...dbs))} to ${Math.round(Math.max(...dbs))} dB</small>${sparkSvg(dbs.slice(-40).map(x => Math.max(1, x)))}</div>` : '');
    const times = [...reports.map(r => r.ms), ...calls.map(c => c.startMs)];
    const hist = reports.length ? [...reports].reverse().slice(0, 40).map(r => `<div class="fl-rep ${r.verified ? '' : 'unv'}"><b>${fleetClock(r.ms)}</b><span>${esc(r.kind)} · ${fleetMhz(r.hz)}${r.lat !== null && r.lon !== null ? ` · ${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : ''}</span><small>${esc(r.text)}</small><code>${esc(r.hex)}</code></div>`).join('') : '';
    return `<div class="flc">${head(`${u.id}`, 'UNIT', `${u.alias ? `${u.alias} · ` : ''}${sys ? fleetSysTitle(sys) : u.sys}`, col, chips, mapBtn)}<div class="flc-grid">`
      + sec('WHERE', where, true) + sec('CALLS', callList(calls)) + sec('TALKGROUPS', tgs) + sec('RADIO', radio) + sec('ACTIVITY', spark(times))
      + sec(`EVERY REPORT · ${reports.length}`, hist ? `<div class="fl-hist flc-reps">${hist}</div>` : '', true) + `</div></div>`;
  }

  if (sel.kind === 'tg') {
    const t = s.tgs.find(x => x.key === sel.key); if (!t) return '';
    const sys = sysOf(t.sys), col = fleetColor(t.sys);
    const calls = s.calls.filter(c => c.kind === 'call' && c.group && c.sys === t.sys && c.tg === t.tg);
    const onAir = calls.find(c => c.onAir), emerg = calls.some(c => c.emergency);
    const chips = seen(Math.max(t.lastMs, ...calls.map(c => c.onAir ? now : c.endMs))) + (onAir ? chip(s.playing === onAir.key ? 'PLAYING' : 'ON THE AIR', 'ok live') : '') + (emerg ? chip('EMERGENCY', 'red') : '') + (secText2(calls) ? chip(secText2(calls), calls.some(c => c.encrypted) ? 'acc' : 'ok') : '');
    const units = s.units.filter(u => u.sys === t.sys && (t.members.includes(u.id) || u.groups.includes(t.tg))).sort((a, b) => b.lastMs - a.lastMs);
    const unitTags = units.length ? `<div class="flc-tags">${units.slice(0, 40).map(u => `<span data-flsel="unit:${esc(u.key)}"><b>${u.id}</b><i>${agoShort(now - u.lastMs)}</i></span>`).join('')}</div>` : '';
    const placed = units.filter(u => u.lat !== null && u.lon !== null);
    const map = placed.length ? fleetCardUnits(`tg:${t.key}`, placed, col, me) : '';
    const stats = `<div class="flc-stats">${big(`${t.grants}`, 'GRANTS')}${big(`${t.recent.length}`, 'IN 10 MIN')}${big(`${calls.length}`, 'CALLS KEPT')}${big(`${units.length}`, 'UNITS')}</div>`;
    const times = [...t.history.map(g => g.ms), ...t.recent, ...calls.map(c => c.startMs)];
    return `<div class="flc">${head(`TG ${t.tg}`, 'TALKGROUP', sys ? fleetSysTitle(sys) : t.sys, col, chips)}<div class="pc-m fl-prefs">${dispatchPrefButtons(t.key)}</div><div class="flc-grid">`
      + sec('NOW', stats + kv([['TALKGROUP', `${t.tg} · 0x${t.tg.toString(16).toUpperCase()}`], ['SYSTEM', sys ? `${fleetSysTitle(sys)} · ${fleetSysType(sys, s)}` : ''], ['FIRST HEARD', fleetClock(t.firstMs)], ['LAST HEARD', `${fleetClock(t.lastMs)} · ${agoShort(now - t.lastMs)} ago`]]), true)
      + sec('RECENT CALLS', callList(calls, 14)) + sec(`UNITS · ${units.length}`, map + unitTags) + sec('ACTIVITY', spark(times))
      + sec('GRANTS', t.history.length ? `<div class="fl-hist">${t.history.map(g => fleetGrantRow(g, now)).join('')}</div>` : '', true) + `</div></div>`;
  }

  if (sel.kind === 'sys') {
    const x = sysOf(sel.key); if (!x) return '';
    const col = fleetColor(x.key), calls = s.calls.filter(c => c.kind === 'call' && c.sys === x.key);
    const units = s.units.filter(u => u.sys === x.key), placed = units.filter(u => u.lat !== null && u.lon !== null);
    const live = s.carriers.some(c => c.sys === x.key && now - c.lastDecodeMs < 10_000);
    const chips = (live ? chip('LIVE', 'ok') : seen(x.lastMs)) + chip(fleetSysType(x, s)) + (secText2(calls) ? chip(secText2(calls), calls.some(c => c.encrypted) ? 'acc' : 'ok') : '') + (calls.some(c => c.onAir) ? chip(`${calls.filter(c => c.onAir).length} ON THE AIR`, 'ok live') : '');
    const tgs = s.tgs.filter(t => t.sys === x.key).sort((a, b) => b.grants - a.grants || b.lastMs - a.lastMs);
    const callTg = new Map<number, number>(); for (const c of calls) if (c.group && c.tg) callTg.set(c.tg, (callTg.get(c.tg) ?? 0) + 1);
    const busiest: [number, number][] = tgs.length ? tgs.slice(0, 12).map(t => [t.tg, t.grants]) : [...callTg].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const tgTags = busiest.length ? `<div class="flc-tags">${busiest.map(([tg, n]) => `<span data-flsel="tg:${esc(x.key)}/${tg}"><b>TG ${tg}</b><i>${n}</i></span>`).join('')}</div>` : '';
    const sites = x.sites.length ? `<div class="flc-sites">${x.sites.map(st => `<div class="flc-site"><b>${esc(x.proto === 'P25' ? `SITE ${st.label}` : st.label.toUpperCase())}</b>`
      + `<span>${st.ccHz.map(h => `${fleetMhz(h)}`).join(' · ')}${st.callsign ? ` · ${esc(st.callsign)}` : ''}</span>`
      + (st.lcns.length ? `<span class="flc-lcn">${st.lcns.map(l => `<i class="${l.lcn === st.rest ? 'rest' : st.busy.includes(l.lcn) ? 'busy' : ''}">LCN ${l.lcn} ${fleetMhz(l.hz)}</i>`).join('')}</span>` : '')
      + (st.neighbors.length ? `<span class="flc-nb">${st.neighbors.length} neighbor${st.neighbors.length > 1 ? 's' : ''}</span>` : '') + `</div>`).join('')}</div>` : '';
    let area = '';
    if (placed.length) {
      const la = placed.map(u => u.lat!), lo = placed.map(u => u.lon!), h = flDistBearing({ lat: Math.min(...la), lon: Math.min(...lo) }, { lat: Math.min(...la), lon: Math.max(...lo) }).mi, v = flDistBearing({ lat: Math.min(...la), lon: lo[0] }, { lat: Math.max(...la), lon: lo[0] }).mi;
      area = fleetCardUnits(`sys:${x.key}`, placed, col, me) + kv([['UNITS PLACED', `${placed.length} of ${units.length}`], ['AREA', `${Math.max(0.1, h).toFixed(1)} × ${Math.max(0.1, v).toFixed(1)} mi`]]);
    }
    const [enc, n] = encShare(calls);
    const stats = `<div class="flc-stats">${big(`${x.sites.length}`, 'SITES')}${big(`${units.length}`, 'UNITS')}${big(`${x.tgs || tgs.length}`, 'TALKGROUPS')}${big(`${x.grants}`, 'GRANTS')}${n ? big(`${Math.round(100 * enc / n)}%`, 'ENCRYPTED') : ''}</div>`;
    const ids: [string, string][] = x.proto === 'SMARTNET' ? [['SYSTEM ID', x.sysId.toString(16).toUpperCase().padStart(4, '0')], ['CHANNEL PLAN', x.sites.find(st => st.time)?.time ?? '']]
      : x.proto === 'NXDN' ? (x.trunk === 'CONVENTIONAL' ? [['RAN', `${x.sysId}`]] : x.trunk === 'TYPE-D' ? [['SITE CODE', `${x.sysId}`]] : [['CATEGORY', x.model], ['SYSTEM CODE', `${x.sysId}`]])
      : x.proto === 'TETRA' ? [['MCC', `${x.wacn}`], ['MNC', `${x.sysId}`], ['COLOR CODE', `${x.cc}`], ['AIR INTERFACE', x.security]]
      : x.proto === 'P25' ? [['WACN', x.wacn.toString(16).toUpperCase().padStart(5, '0')], ['SYSTEM', x.sysId.toString(16).toUpperCase().padStart(3, '0')]]
      : [['COLOR CODE', `${x.cc}`], ['FEATURE SET', x.fid >= 0 ? `0x${x.fid.toString(16).toUpperCase().padStart(2, '0')}` : ''], ['NETWORK', x.net >= 0 ? `${x.model} ${x.net}` : '']];
    const facts = kv([['TYPE', fleetSysType(x, s)], ...ids, ['CW ID', x.callsign], ['FIRST HEARD', `${fleetClock(x.firstMs)} · ${agoShort(now - x.firstMs)} ago`], ['LAST HEARD', `${fleetClock(x.lastMs)} · ${agoShort(now - x.lastMs)} ago`], ['ENCRYPTION', n ? `${enc} of ${n} calls` : '']]);
    const lp = x.lpcns.length ? `<div class="fl-lcn">${x.lpcns.map(l => `<span><b>${x.proto === 'NXDN' ? (x.trunk === 'TYPE-D' ? 'REPEATER' : 'CH') : 'LPCN'} ${l.lpcn}</b><i>${fleetMhz(l.hz)} · ${l.votes} heard</i></span>`).join('')}</div>` : '';
    const times = [...s.grants.filter(g => g.sys === x.key).map(g => g.ms), ...calls.map(c => c.startMs)];
    return `<div class="flc">${head(fleetSysTitle(x), 'SYSTEM', x.label, col, chips)}<div class="flc-grid">`
      + sec('OVERVIEW', stats + facts, true) + sec('SITES AND CHANNELS', sites + lp) + sec('BUSIEST TALKGROUPS', tgTags) + sec('COVERAGE', area)
      + sec(`UNITS · ${units.length}`, units.length ? `<div class="flc-tags">${[...units].sort((a, b) => b.lastMs - a.lastMs).slice(0, 40).map(u => `<span data-flsel="unit:${esc(u.key)}"><b>${u.id}</b><i>${agoShort(now - u.lastMs)}</i></span>`).join('')}${units.length > 40 ? `<span class="more"><i>${units.length - 40} more</i></span>` : ''}</div>` : '') + sec('ACTIVITY', spark(times))
      + sec('RECENT CALLS', callList(calls, 8)) + (x.proto === 'P25' && x.idens.length ? sec('CHANNEL TABLE', fleetIdenRows(x.idens), true) : '') + `</div></div>`;
  }

  const c = s.carriers.find(y => String(y.key) === sel.key); if (!c) return '';
  const sys = c.sys ? sysOf(c.sys) : undefined, col = c.sys ? fleetColor(c.sys) : 'var(--muted)';
  const calls = s.calls.filter(k => k.kind === 'call' && Math.abs(k.hz - c.hz) < 3_200);
  const chips = (now - c.lastDecodeMs < 10_000 ? chip('DECODING', 'ok') : now - c.lastMs < 4_000 ? chip('ON THE AIR', 'ok') : seen(c.lastMs)) + (c.cls ? chip(c.cls) : '') + (c.role ? chip(c.role.toUpperCase(), 'acc') : '');
  const stats = `<div class="flc-stats">${big(`${c.levelDb.toFixed(0)} dB`, `LEVEL · PEAK ${c.peakDb.toFixed(0)}`)}${c.blocks ? big(`${Math.round(100 * c.crcOk / Math.max(1, c.blocks))}%`, `BLOCKS PASSING · ${c.crcOk}/${c.blocks}`) : ''}${c.frames ? big(`${c.frames}`, 'FRAMES') : ''}${c.onMs > 0 ? big(flSpan(c.onMs), 'ON THE AIR') : ''}</div>`;
  const facts = kv([['FREQUENCY', `${fleetMhz(c.hz)} MHz`], ['SYSTEM', sys ? `${fleetSysTitle(sys)} · ${fleetSysType(sys, s)}` : ''], ['NAC', c.nac >= 0 ? c.nac.toString(16).toUpperCase().padStart(3, '0') : ''], ['COLOR CODE', c.cc >= 0 ? `${c.cc}` : ''], ['LCN', c.lcn],
    ['CW ID', c.callsign ? `${c.callsign}${c.callsignMs ? ` · ${fleetClock(c.callsignMs)}` : ''}` : ''], ['ENVELOPE', `${c.envCv.toFixed(2)} (constant near 0, linear near 0.3)`], ['EYE', c.eye.toFixed(2)],
    ['FIRST HEARD', fleetClock(c.firstMs)], ['LAST HEARD', `${fleetClock(c.lastMs)} · ${agoShort(now - c.lastMs)} ago`]]);
  return `<div class="flc">${head(fleetMhz(c.hz), 'CARRIER', sys ? fleetSysTitle(sys) : (c.cls || 'not classed yet'), col, chips)}<div class="flc-grid">`
    + sec('SIGNAL', stats + facts, true) + sec('CALLS ON THIS CHANNEL', callList(calls, 8)) + sec('ACTIVITY', spark(calls.map(k => k.startMs))) + `</div></div>`;
}
/** A span of time, short: '45 s', '12 min', '3.5 h'. */
const flSpan = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;
/** What kind of system it is, as the cards name it. */
function fleetSysType(x: FleetSystem, s: FleetSnap): string {
  if (x.proto === 'P25') return s.carriers.some(c => c.sys === x.key && c.tdma) || s.calls.some(c => c.sys === x.key && c.tdma) ? 'P25 PHASE 1 AND 2' : 'P25 PHASE 1';
  if (x.proto === 'DMR') return x.trunk === 'CAPACITY PLUS' ? 'DMR CAPACITY PLUS' : x.trunk === 'TIER III' ? 'DMR TIER III' : 'DMR';
  if (x.proto === 'NXDN') return x.trunk ? `NXDN ${x.trunk}` : 'NXDN';
  if (x.proto === 'SMARTNET') return 'MOTOROLA TYPE II';
  return x.proto;
}
function refreshFleet(force = false): void {
  if (state.app !== 'fleet') return;
  const now = Date.now();
  if (fleetUi.hold) return;
  if (!force && now - fleetUi.drawn < 240) { clearTimeout(fleetUi.pending); fleetUi.pending = window.setTimeout(() => refreshFleet(true), 250); return; }
  fleetUi.drawn = now;
  const s = fleetUi.snap, view = fleetUi.view;
  const headEl = q('#fl-head'); if (headEl) headEl.innerHTML = fleetHead(s, now);
  qa<HTMLButtonElement>('[data-flband]').forEach(b => b.classList.toggle('on', b.dataset.flband === fleetUi.band));
  qa<HTMLButtonElement>('[data-flspan]').forEach(b => b.classList.toggle('on', Number(b.dataset.flspan) === fleetRate()));
  // the units of calls on the air pulse on the map while they talk
  const talking = new Set((s?.calls ?? []).filter(c => c.onAir && c.pos && !c.outside).map(c => `${c.sys}/${c.pos!.unit}`));
  const pins: GeoItem[] = (s?.units ?? []).filter(u => u.lat !== null && u.lon !== null).map(u => ({ id: u.key, lat: u.lat!, lon: u.lon!, label: `${u.id}`, kind: 'station' as GeoItem['kind'], color: fleetColor(u.sys), cls: talking.has(u.key) ? 'talk' : now - u.posMs > 3_600_000 ? 'older' : now - u.posMs > 600_000 ? 'old' : '' }));
  qa<HTMLButtonElement>('[data-flview]').forEach(b => {
    const v = b.dataset.flview as FleetView; if (FLEET_WIDE.matches) b.classList.toggle('on', v === view);
    const n = v === 'tgs' ? (s ? tgTiles(s.tgs, s.calls, fleetUi.prefs, now).length : 0) : v === 'systems' ? s?.systems.length ?? 0 : v === 'calls' ? s?.calls.length ?? 0 : v === 'map' ? pins.length : v === 'grants' ? s?.grants.length ?? 0 : v === 'freqs' ? (s ? s.carriers.filter(c => c.hz > s.spanLo && c.hz < s.spanHi && now - c.lastMs < 4_000).length : 0) : -1;
    const badge = b.querySelector('b');
    if (badge) { badge.textContent = n > 0 ? String(n) : ''; b.classList.toggle('has', n > 0); }
    else b.textContent = n < 0 ? 'LOG' : `${v === 'freqs' ? 'FREQS' : v === 'tgs' ? 'TALKGROUPS' : v.toUpperCase()} ${n}`;
  });
  const cards = q('#fl-cards'), mapEl = q('#fl-map'), nopos = q('#fl-nopos'), grants = q('#fl-grants'), freqs = q('#fl-freqs'), det = q('#fl-detail'), stage = q('#fl-stage'), logEl = q('#fl-log');
  const tgsEl = q('#fl-tgs'), callsEl = q('#fl-calls'), air = q('#fl-onair'), audio = q('#fl-audio'), mode = q('#fl-mode'), np = q('#fl-now');
  if (!tgsEl || !cards || !mapEl || !nopos || !grants || !freqs || !det || !stage || !logEl || !callsEl || !air || !audio || !mode || !np) return;
  if (s) dispatchFollow(s, now);
  const onAir = s ? s.calls.filter(c => c.onAir && c.kind === 'call' && !c.outside) : [];
  // emergencies are pinned on top (and stay a minute after they end), then the call being heard, then the rest;
  // calls outside the lock are left out of the stack and counted
  // encrypted calls fold into one line under the cards: they never push a clear call out of the stack
  const all = s ? onAirOrder(s.calls, s.playing, now).filter(c => !c.outside) : [];
  const quiet = s ? all.filter(c => c.onAir && unnamedQuiet(c, s.playing)) : [];
  const stack = all.filter(c => !c.encrypted && !quiet.includes(c)), locked = all.filter(c => c.encrypted && c.onAir);
  const others = s ? s.calls.filter(c => c.onAir && c.kind === 'call' && c.outside).length : 0;
  const onMap = view === 'map' && !FLEET_WIDE.matches, max = onMap ? 2 : 4;
  air.hidden = (!stack.length && !others && !locked.length && !quiet.length) || view === 'log';
  air.classList.toggle('onmap', onMap);
  if (!air.hidden && s) flipRender(air, stack.slice(0, max).map(c => dispatchOnAirCard(c, s, now)).join('') + (stack.length > max ? `<div class="fl-dim">${stack.length - max} more on the air</div>` : '') + (locked.length ? `<div class="fl-encrow"><small>ENCRYPTED ON THE AIR</small>${locked.map(c => `<span data-flsel="${c.group ? `tg:${esc(dispatchKey(c))}` : `unit:${esc(c.sys)}/${c.tg}`}">${esc(dispatchWho(c))}<i>${esc(secText(c).replace(/^ENCRYPTED( · )?/, '') || 'encrypted')}</i></span>`).join('')}</div>` : '')
    + (quiet.length ? `<div class="fl-dim">${quiet.length} more with no talkgroup or audio yet (${[...new Set(quiet.map(c => c.proto))].join(', ')})</div>` : '')
    + (others ? `<div class="fl-dim">${others} on other systems, not heard while locked</div>` : ''));
  const hold = fleetUi.prefs.hold;
  mode.innerHTML = `<div class="fl-listen ${hold ? 'on' : ''}"><small>${hold ? 'FOLLOWING' : 'HEARING'}</small><b>${hold ? `TG ${esc(hold.slice(hold.lastIndexOf('/') + 1))}` : 'ALL'}</b><span>${esc(listenText(hold, fleetUi.lock))}</span>${hold ? '<button class="chip" data-flfollow="">BACK TO ALL</button>' : ''}</div>`
    + (fleetUi.lock ? `<button class="fl-lockbar" data-flunlock="1" title="tap to hear every system again"><small>LOCKED ON</small><b>${esc(fleetUi.lock.label)}</b><em>UNLOCK</em></button>` : '<button class="chip fl-lockbtn" data-flmode="lock" title="stay on one system">LOCK SYSTEM</button>');
  dispatchNowBar(np, s, now);
  audio.hidden = !s || !s.codecs.length;
  if (!audio.hidden && !audio.querySelector('input')) audio.innerHTML = `<button class="chip" data-flaudio="1"></button><span class="rl">VOLUME</span><input type="range" min="0" max="150" value="${Math.round(fleetUi.gain * 100)}" aria-label="volume">`;
  const ab = audio.querySelector<HTMLButtonElement>('[data-flaudio]'); if (ab) { ab.textContent = fleetUi.audioOn ? 'AUDIO ON' : 'AUDIO OFF'; ab.classList.toggle('on', fleetUi.audioOn); }
  const wide = FLEET_WIDE.matches, showMap = wide || view === 'map';
  if (wide) {
    callsEl.hidden = view !== 'calls'; tgsEl.hidden = view !== 'tgs';
    cards.hidden = view !== 'systems'; mapEl.hidden = !showMap; grants.hidden = view !== 'grants'; freqs.hidden = view !== 'freqs';
    stage.hidden = view === 'log'; logEl.hidden = view !== 'log';
    nopos.hidden = !showMap || pins.length > 0;
  } else {
    // A phone scrolls easily, so nothing hides behind a tab: the map, systems, calls, grants, frequencies and the
    // log are one page, and the tabs jump to them. The map leads, and fills the screen once anything is on it.
    callsEl.hidden = cards.hidden = mapEl.hidden = grants.hidden = freqs.hidden = stage.hidden = logEl.hidden = tgsEl.hidden = false;
    nopos.hidden = pins.length > 0;
  }
  stage.closest('.view')?.classList.toggle('fl-mapbig', !wide && pins.length > 0);
  if (!nopos.hidden) nopos.textContent = s && s.units.some(u => u.posMs > 0) && !s.ref ? 'unit positions need a region: drag the map to your area' : 'no unit positions on the air yet';
  if (!paused.has('fleet') && s) {
    const keep = (el: HTMLElement, html: string) => { const top = el.scrollTop; el.innerHTML = html; el.scrollTop = top; };
    if (view === 'tgs' || !wide) tgsEl.innerHTML = fleetTgTilesHtml(s, now);
    if (view === 'systems') keep(cards, s.systems.length ? s.systems.map(x => fleetSystemCard(x, now)).join('') : emptyState('fleet'));
    else if (view === 'grants') keep(grants, fleetGrantsHtml(s, now));
    else if (view === 'calls') keep(callsEl, dispatchCallsHtml(s, now));
    else if (view === 'freqs') keep(freqs, fleetFreqsHtml(s, now));
  } else if (!s && view === 'systems') cards.innerHTML = emptyState('fleet');
  if (showMap) {
    geo?.invalidate();
    geo?.update(pins, fleetUi.sel?.kind === 'unit' ? fleetUi.sel.key : '');
    geo?.setShapes((s?.units ?? []).filter(u => u.trail.length > 1).map(u => ({ id: u.key, pts: u.trail.map(p => [p[0], p[1]] as [number, number]), line: true, color: fleetColor(u.sys), sel: fleetUi.sel?.key === u.key })));
  }
  const html = s ? fleetDetail(s, now) : '';
  det.hidden = !html;
  if (html) { const top = det.scrollTop; det.innerHTML = html; fleetCardMapMount(det); det.scrollTop = top; }
  if (onAir.some(c => c.emergency)) setLamp('EMERGENCY', 'red', true);
  else if (onAir.length) setLamp(`${onAir.length} ON AIR`, 'ok', true);
  else if (s && s.systems.length) setLamp(`${s.systems.length} SYSTEM${s.systems.length === 1 ? '' : 'S'}`, 'ok');
  else if (s && s.carriers.some(c => c.decoding)) setLamp('LISTENING', 'amber', true);
}
/** The now-playing bar: what is heard right now, with its level; tapping it opens the talkgroup. */
function dispatchNowBar(el: HTMLElement, s: FleetSnap | null, now: number): void {
  const c = s && fleetUi.audioOn ? nowPlaying(s.calls, s.playing) : null;
  el.hidden = !s || !fleetUi.audioOn || !s.codecs.length;
  if (el.hidden) return;
  el.classList.toggle('on', !!c); el.classList.toggle('emerg', !!c?.emergency);
  if (!c) { el.innerHTML = `<span class="fl-np-l">LISTENING</span><span class="fl-np-t">nothing clear on the air${fleetUi.lock ? ` · locked on ${esc(fleetUi.lock.label)}` : ''}</span>`; return; }
  const sys = s!.systems.find(x => x.key === c.sys), sel = c.group ? `tg:${esc(dispatchKey(c))}` : `unit:${esc(c.sys)}/${c.tg}`, col = c.sys ? fleetColor(c.sys) : 'var(--accent)';
  const where = c.pos ? ` · ${posText(c.pos, dispatchMe())}` : '';
  el.style.setProperty('--sys', col);
  el.innerHTML = `<span class="fl-np-l"><i></i>NOW PLAYING</span><b data-flsel="${sel}">${esc(dispatchWho(c))}</b>${c.src ? `<span class="fl-np-u">← ${c.src}</span>` : ''}`
    + `<span class="fl-np-t">${esc(sys ? fleetSysTitle(sys) : c.sys || c.proto)}${c.site ? ` · SITE ${esc(c.site)}` : ''} · ${fleetMhz(c.hz)} MHz${esc(where)}</span>`
    + `<span class="fl-vu" data-vu="${esc(c.key)}" style="--vu:${dispatchVuPct(c.key).toFixed(0)}%"><span><i></i></span></span><span class="fl-np-d">${flDur(now - c.startMs)}</span>`;
}
/** The audio level of the call heard, 0 to 100, from the worker's level reports. */
const dispatchVuPct = (key: string) => fleetUi.vu.key === key ? Math.max(0, Math.min(100, (fleetUi.vu.db + 60) * 100 / 54)) : 0;
/** A level report: the meters move between redraws. */
function dispatchVu(key: string, db: number): void {
  fleetUi.vu = { key, db };
  for (const el of qa<HTMLElement>('[data-vu]')) el.style.setProperty('--vu', `${dispatchVuPct(el.dataset.vu ?? '').toFixed(0)}%`);
}
/** Redraws a stack of cards and slides the ones that moved from where they were to where they are now. */
function flipRender(el: HTMLElement, html: string): void {
  const before = new Map<string, number>();
  for (const c of qa<HTMLElement>('[data-flkey]', el)) before.set(c.dataset.flkey!, c.getBoundingClientRect().top);
  el.innerHTML = html;
  if (!before.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const c of qa<HTMLElement>('[data-flkey]', el)) {
    const was = before.get(c.dataset.flkey!); if (was === undefined) continue;
    const dy = was - c.getBoundingClientRect().top; if (Math.abs(dy) < 2) continue;
    c.style.transition = 'none'; c.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => { c.style.transition = 'transform .35s cubic-bezier(.2,.8,.2,1)'; c.style.transform = ''; });
  }
}
function fleetExport(csv: string, json: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  download(`dispatch-log-${stamp}.csv`, csv, 'text/csv');
  setTimeout(() => download(`dispatch-tables-${stamp}.json`, json, 'application/json'), 400);
}
// ---- HD Radio: the digital side of hybrid FM stations, with the analog audio under it (receive only) ------------
type HdView = 'now' | 'stations' | 'map' | 'data' | 'log';
interface HdObj { key: string; hz: number; port: number; id: number; name: string; size: number; mime: string; kind: string; program: number; ms: number; url: string; bytes: Uint8Array }
interface HdStationRec {
  hz: number; call: string; slogan: string; longName: string; message: string; facility: number; country: string;
  lat: number | null; lon: number | null; altM: number | null; programs: { n: number; type: number; typeName: string; title: string; artist: string }[];
  data: string[]; firstMs: number; lastMs: number; frames: number; logos: Record<string, string>;
}
const HD_KEY = 'mayhem.hd.stations', HD_MAPS_KEY = 'mayhem.hd.maps';
const HD_RATE = RX_RATE;
/** Station center within this of the span center keeps the radio where it is; the HD sidebands reach 200 kHz out. */
const HD_REACH = HD_RATE / 2 - 260_000;
/** The FM band in windows at the HD rate, each heard from its middle, bottom up. */
const HD_WINDOWS: number[] = hdWindows(HD_RATE);
function loadHdStations(): Map<number, HdStationRec> {
  try { const v = JSON.parse(localStorage.getItem(HD_KEY) ?? '[]') as HdStationRec[]; return new Map(v.filter(s => s && s.hz).map(s => [s.hz, { ...s, logos: s.logos ?? {} }])); } catch { return new Map(); }
}
function loadHdMaps(): { traffic: Record<string, TrafficInfo>; radar: Record<string, RadarInfo> } {
  try { const v = JSON.parse(localStorage.getItem(HD_MAPS_KEY) ?? '{}'); return { traffic: v.traffic ?? {}, radar: v.radar ?? {} }; } catch { return { traffic: {}, radar: {} }; }
}
const hdUi = {
  snap: null as HdSnapMsg | null, view: 'now' as HdView, left: 'now' as 'now' | 'map', prog: 0, sel: '',
  objects: [] as HdObj[], stations: loadHdStations(), maps: loadHdMaps(),
  tileUrls: new Map<string, string>(),
  auto: false,
  scan: {
    phase: 'look' as 'look' | 'survey' | 'dwell' | 'rest', plan: { wide: false, rate: HD_RATE, centers: HD_WINDOWS } as HdLookPlan, step: 0, from: 0, until: 0,
    acc: null as Float64Array | null, accN: 0, levels: new Map<number, number>(), found: [] as number[], queue: [] as number[], locked: 0, cur: 0, started: 0,
    /** This pass: the hybrid channels' scores (survey), the stations visited and how loud, and whether any was digital. */
    cands: new Map<number, number>(), visits: [] as number[], loud: null as Map<number, number> | null, digital: false,
  },
  /** The newest spectrum row on this screen (0..1 of rangeDb), for AUTO's wide look. */
  bins: null as Float32Array | null, binsRange: 0,
  timer: 0, scanTimer: 0, saveTimer: 0, drawn: 0, pending: 0, hold: false, wired: false, mapKey: '', fitted: '',
};
interface HdSnapMsg {
  hz: number; centerHz: number; rate: number; rx: { state: string; cfoHz: number; cpLock: number; blocks: number; blocksBad: number; psmi: number; bc: number };
  station: StationSnap; cands: { hz: number; scoreDb: number; levelDb: number }[];
  det: { present: boolean; snrDb: number; lock: number; sbLoDb: number; sbHiDb: number; refDb: number; analogDb: number; cfoHz: number } | null;
  dropped: number; load: number; queued: number;
}
const HD_WIDE = window.matchMedia('(min-width: 1000px)');
HD_WIDE.addEventListener('change', () => { if (state.app === 'hd') { const v = q<HTMLElement>('main#view'); if (v) { renderHd(v); refreshReadout(); refreshChannel(); } } });
const hdMhz = (hz: number) => (hz / 1e6).toFixed(1);
const hdAgo = (ms: number) => ms < 2_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 172_800_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} days ago`;
const hdClock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
const hdHex = (v: number, n = 4) => `0x${v.toString(16).toUpperCase().padStart(n, '0')}`;
/** A snapshot that is about the station tuned now (the radio's own tuning can sit a little off the target). */
const hdMine = (m: HdSnapMsg | null): m is HdSnapMsg => !!m && Math.abs(m.hz - state.freq) < 2_000;
const hdKey = (hz: number) => Math.round(hz / 100_000) * 100_000;
let hdObjSeq = 0;
const hdSize = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

function hdSaveStations(): void {
  clearTimeout(hdUi.saveTimer);
  hdUi.saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(HD_KEY, JSON.stringify([...hdUi.stations.values()])); } catch { /* full or private */ }
    try { localStorage.setItem(HD_MAPS_KEY, JSON.stringify(hdUi.maps)); } catch { /* full or private */ }
  }, 800);
}
function hdOpen(): void {
  const known = [...hdUi.stations.values()].sort((a, b) => b.lastMs - a.lastMs)[0];
  const dial = state.dial >= 87_900_000 && state.dial <= 107_900_000 ? state.dial : 0;
  const f = dial || known?.hz || HD_WINDOWS[0];
  configure('WFM', f, HD_RATE, 24, 24, false, 'hd');
  worker?.postMessage({ type: 'hdLook', on: false });
  requestGeo();
  if (!dial && !known) hdSetAuto(true);
  else if (hdUi.auto) hdBandStart();
}
/** Tune a station: the channel moves inside the span; the radio follows only when the sidebands would leave it. */
function hdTune(hz: number, recenter = false): void {
  state.freq = Math.round(Math.min(107_900_000, Math.max(87_900_000, hz)) / 100_000) * 100_000;
  const prev = state.viewLo;
  if (recenter || Math.abs(state.freq - state.viewLo) > HD_REACH) {
    state.viewLo = state.freq;
    if (state.viewLo !== prev) scope?.shiftSpan((state.viewLo - prev) / state.rate);
    if (radio) radio.targetFreqHz = state.viewLo;
  }
  sendOffset(); refreshChannel(); refreshReadout();
  refreshHd(true);
}
function hdSetAuto(on: boolean): void {
  const was = hdUi.auto;
  hdUi.auto = on; clearTimeout(hdUi.scanTimer);
  if (on) { hdBandStart(); hdUi.scanTimer = window.setTimeout(hdScanTick, 500); }
  else if (was) hdLookEnd();
  refreshHd(true);
}
/** The spans AUTO's wide look may take here: as wide as Home shows the band on this radio and screen. */
function hdLookRates(): number[] {
  const cap = RX_RATES[Math.min(maxRateIdx(), RX_RATES.length - 1)], widest = radio ? cleanWidest(radio.limits) : RX_RATE;
  return RX_RATES.filter(r => r <= Math.min(cap, widest));
}
/** AUTO from the bottom of the band: find the stations (wide looks, or windows on a narrow radio), then visit them. */
function hdBandStart(): void {
  const s = hdUi.scan;
  s.plan = hdLookPlan(hdLookRates(), HD_RATE); s.step = 0; s.levels = new Map(); s.found = []; s.cands = new Map(); s.queue = []; s.visits = []; s.loud = null; s.digital = false;
  hdLookAt();
}
/** One look (or one window) of the plan. A wide look moves only the span: the dial stays where it is. */
function hdLookAt(): void {
  const s = hdUi.scan, c = s.plan.centers[s.step], now = Date.now();
  s.cur = c; s.acc = null; s.accN = 0;
  if (!s.plan.wide) { s.phase = 'survey'; s.until = now + 2_600; hdTune(c, true); return; }
  s.phase = 'look'; s.from = now + 1_500; s.until = now + 4_000;
  // the HD decoder and the audio demodulator rest while the span is wide: only the spectrum runs at the wide rate.
  // Back at the HD rate the decoder starts over on the first station.
  worker?.postMessage({ type: 'hdLook', on: true });
  if (state.rate !== s.plan.rate) setRate(s.plan.rate);
  if (state.viewLo !== c) scope?.clear();
  state.viewLo = c;
  if (radio) radio.targetFreqHz = c;
  sendOffset(); refreshChannel(); refreshReadout();
}
/** Back from a wide look to the HD rate, on the station tuned. */
function hdLookEnd(): void {
  worker?.postMessage({ type: 'hdLook', on: false });
  if (state.rate === HD_RATE) return;
  setRate(HD_RATE); scope?.clear();
  hdTune(state.freq, true);
}
/** The pass is found: visit its stations, lowest first. */
function hdVisit(queue: number[], loud: Map<number, number> | null): void {
  const s = hdUi.scan;
  s.queue = queue; s.visits = [...queue]; s.loud = loud;
  hdNextCandidate();
}
/** AUTO: find the stations, then dwell on each, lowest first, long enough to fill it in; at the top, look again. */
function hdScanTick(): void {
  if (state.app !== 'hd' || !hdUi.auto) return;
  const s = hdUi.scan, now = Date.now(), m = hdUi.snap;
  if (s.phase === 'look') {
    const bins = hdUi.bins;
    if (now >= s.from && bins && bins.length) {
      // dB over this row's own median, summed
      const db = Float32Array.from(bins, v => v * hdUi.binsRange), med = Float32Array.from(db).sort()[db.length >> 1];
      if (!s.acc || s.acc.length !== db.length) { s.acc = new Float64Array(db.length); s.accN = 0; }
      for (let k = 0; k < db.length; k++) s.acc[k] += db[k] - med;
      s.accN++;
    }
    if ((now >= s.until && s.accN >= 3) || now >= s.until + 4_000) {
      const acc = s.acc, n = s.accN;
      if (acc && n) hdMergeLevels(s.levels, hdChannelLevels(Float64Array.from(acc, v => v / n), state.rate, s.cur));
      if (++s.step < s.plan.centers.length) hdLookAt();
      else {
        const found = hdStrongStations(s.levels), queue = hdVisitOrder(found, [...hdUi.stations.keys()], s.levels);
        log(`HD AUTO: ${found.length} strong stations in a look across the band (${found.map(hdMhz).join(' ')}), visiting ${queue.length} lowest first`);
        hdLookEnd(); hdVisit(queue, s.levels);
      }
    }
  } else if (s.phase === 'survey') {
    if (now >= s.until) {
      for (const c of m && Math.abs(m.centerHz - state.viewLo) < 5_000 ? m.cands : []) if (Math.abs(c.hz - state.viewLo) <= HD_REACH) { s.found.push(c.hz); s.cands.set(c.hz, Math.max(c.scoreDb, s.cands.get(c.hz) ?? -Infinity)); }
      if (++s.step < s.plan.centers.length) hdLookAt();
      else {
        const queue = hdVisitOrder(s.found, [...hdUi.stations.keys()]);
        log(`HD AUTO: ${s.found.length} hybrid channels in ${s.plan.centers.length} windows, visiting ${queue.length} lowest first`);
        hdVisit(queue, s.cands);
      }
    }
  } else if (s.phase === 'rest') {
    if (now >= s.until) hdBandStart();
  } else {
    const st = m && Math.abs(m.hz - s.cur) < 2_000 ? m : null, digital = !!st && (st.station.frames > 0 || st.rx.state === 'sync' || st.rx.state === 'frames');
    if (digital && !s.locked) { s.locked = now; s.until = now + 45_000; s.digital = true; }
    const filled = !!st && !!st.station.sis.callsign && now - s.locked > 20_000 && st.station.programs.every(p => p.title || p.lastMs === 0);
    if (now >= s.until || (s.locked && filled)) hdNextCandidate();
  }
  refreshHd();
  hdUi.scanTimer = window.setTimeout(hdScanTick, 500);
}
/**
 * The next station up. Past the top: a pass that heard digital looks again from the bottom; one that heard none rests
 * on the strongest station for two minutes first (a fresh look every few seconds would only chop its audio).
 */
function hdNextCandidate(): void {
  const s = hdUi.scan, next = s.queue.shift(), now = Date.now();
  if (next !== undefined) { s.phase = 'dwell'; s.cur = next; s.locked = 0; s.started = now; s.until = now + 6_000; hdTune(next); return; }
  if (s.digital) { hdBandStart(); return; }
  const best = hdStrongest(s.visits, s.loud);
  s.phase = 'rest'; s.until = now + HD_REST_MS; s.cur = best ?? state.freq;
  log(`HD AUTO: no digital heard on this pass, resting on ${hdMhz(s.cur)} MHz before the next look`);
  if (best !== null) hdTune(best);
}
/** Step to the next or previous station already heard. */
function hdStep(dir: 1 | -1): void {
  const list = [...hdUi.stations.keys()].sort((a, b) => a - b);
  if (!list.length) { hdTune(state.freq + dir * 200_000); return; }
  const next = dir > 0 ? list.find(h => h > state.freq + 50_000) ?? list[0] : [...list].reverse().find(h => h < state.freq - 50_000) ?? list[list.length - 1];
  hdSetAuto(false); hdTune(next);
}

/** What one snapshot adds to the station's record (kept once the digital side has decoded). */
function hdRecord(m: HdSnapMsg): void {
  const st = m.station, sis = st.sis, hz = hdKey(m.hz);
  if (!st.frames) return;
  const now = Date.now();
  let r = hdUi.stations.get(hz);
  if (!r) { r = { hz, call: '', slogan: '', longName: '', message: '', facility: -1, country: '', lat: null, lon: null, altM: null, programs: [], data: [], firstMs: now, lastMs: now, frames: 0, logos: {} }; hdUi.stations.set(hz, r); }
  r.lastMs = now; r.frames = Math.max(r.frames, st.frames);
  if (sis.callsign && sis.nameVotes[0] >= 3) r.call = sis.callsign;
  if (sis.slogan) r.slogan = sis.slogan;
  if (sis.longName) r.longName = sis.longName;
  if (sis.message) r.message = sis.message;
  if (sis.facility >= 0) { r.facility = sis.facility; r.country = sis.country; }
  if (locationValid(sis.lat, sis.lon)) { r.lat = sis.lat; r.lon = sis.lon; r.altM = sis.altM; }
  for (const p of st.programs) {
    let rp = r.programs.find(x => x.n === p.n);
    if (!rp) { rp = { n: p.n, type: p.type, typeName: p.typeName, title: '', artist: '' }; r.programs.push(rp); r.programs.sort((a, b) => a.n - b.n); }
    if (p.type >= 0) { rp.type = p.type; rp.typeName = p.typeName; }
    if (p.title) { rp.title = p.title; rp.artist = p.artist; }
  }
  const data = [...new Set([...st.sig.filter(s => s.kind === 'data' && s.name).map(s => s.name), ...sis.data.map(d => dataTypeName(d.type))])];
  if (data.length) r.data = data;
  hdSaveStations();
}

/** A finished object from the station: kept for this session; logos, map and radar descriptions kept for good. */
function hdOnObject(m: Record<string, unknown>): void {
  const bytes = m.bytes as Uint8Array, mime = m.mime as string, name = m.name as string, kind = m.kind as string, hz = hdKey(m.hz as number);
  if (hdUi.objects.some(o => o.hz === hz && o.port === m.port && o.name === name && o.size === m.size)) return;
  const key = `o${++hdObjSeq}`;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const o: HdObj = { key, hz, port: m.port as number, id: m.id as number, name, size: m.size as number, mime, kind, program: m.program as number, ms: m.ms as number, url, bytes };
  hdUi.objects.unshift(o);
  while (hdUi.objects.length > 160) { const x = hdUi.objects.pop()!; URL.revokeObjectURL(x.url); hdUi.tileUrls.delete(x.key); }
  const text = () => new TextDecoder('latin1').decode(bytes);
  if (kind === 'traffic-info') { const t = parseTrafficInfo(text()); if (t) { hdUi.maps.traffic[t.map] = t; hdSaveStations(); } }
  else if (kind === 'radar-info') { const r = parseRadarInfo(text()); if (r) { hdUi.maps.radar[r.area] = r; hdSaveStations(); } }
  else if (kind === 'logo' && bytes.length < 60_000) {
    const rec = hdUi.stations.get(hz);
    if (rec) { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); rec.logos[String(Math.max(0, o.program))] = `data:${mime};base64,${btoa(s)}`; hdSaveStations(); }
  }
  if (kind === 'traffic') hdTileUrl(o);
  refreshHd(true);
}
/** A traffic tile with its background color made see-through, so the map shows under it. */
function hdTileUrl(o: HdObj): string {
  const done = hdUi.tileUrls.get(o.key); if (done) return done;
  hdUi.tileUrls.set(o.key, o.url);
  const t = trafficTile(o.name), info = t ? hdUi.maps.traffic[t.map] : undefined, bg = info?.background;
  if (bg && typeof createImageBitmap === 'function') {
    void createImageBitmap(new Blob([o.bytes as BlobPart], { type: o.mime })).then(img => {
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d'); if (!g) return;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height), px = d.data;
      for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - bg[0]) < 10 && Math.abs(px[i + 1] - bg[1]) < 10 && Math.abs(px[i + 2] - bg[2]) < 10) px[i + 3] = 0;
      g.putImageData(d, 0, 0);
      cv.toBlob(b => { if (!b) return; hdUi.tileUrls.set(o.key, URL.createObjectURL(b)); hdUi.mapKey = ''; refreshHd(true); }, 'image/png');
    }).catch(() => undefined);
  }
  return o.url;
}
function hdSaveObject(o: HdObj): void {
  const a = document.createElement('a'); a.href = o.url; a.download = o.name.replace(/[^A-Za-z0-9._$-]/g, '_') || `hd-${hdHex(o.port)}-${hdHex(o.id)}.bin`; a.click();
}
/** The current station's objects. */
const hdObjects = (hz = state.freq) => hdUi.objects.filter(o => o.hz === hdKey(hz));
/** The picture for a program: its song's album art, else its logo, else the station's logo. */
function hdArt(p: ProgramRow | null, hz: number): { url: string; kind: 'art' | 'logo' } | null {
  const objs = hdObjects(hz);
  if (p && p.artId !== null) { const a = objs.find(o => o.id === p.artId && o.mime.startsWith('image/')); if (a) return { url: a.url, kind: 'art' }; }
  const logo = hdLogo(hz, p?.n ?? 0);
  return logo ? { url: logo, kind: 'logo' } : null;
}
function hdLogo(hz: number, prog: number): string | null {
  hz = hdKey(hz);
  const objs = hdObjects(hz).filter(o => o.kind === 'logo');
  const l = objs.find(o => o.program === prog) ?? (prog === 0 ? objs.find(o => o.program < 0) : undefined);
  if (l) return l.url;
  const rec = hdUi.stations.get(hz);
  return rec ? rec.logos[String(prog)] ?? (prog === 0 ? rec.logos['0'] : null) ?? null : null;
}

function renderHd(view: HTMLElement): void {
  const wide = HD_WIDE.matches;
  if (wide && (hdUi.view === 'now' || hdUi.view === 'map')) hdUi.view = 'stations';
  view.classList.toggle('hdwide', wide);
  const tabs = (wide ? ['stations', 'data', 'log'] : ['now', 'stations', 'map', 'data', 'log']) as HdView[];
  const mapHtml = '<div id="hd-map" class="panel map hd-map"></div><div id="hd-legend" class="hd-legend" hidden></div>';
  view.innerHTML = `
    <section class="${visCls('hd')}">${readoutHtml()}${wide ? `<div class="hd-left"><div class="ctlrow">${segHtml([['now', 'NOW PLAYING'], ['map', 'MAP']].map(([k, l]) => `<button data-hdleft="${k}">${l}</button>`))}</div><div id="hd-hero" class="hd-hero"></div><div class="hd-mapbox">${mapHtml}</div></div>` : ''}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="hd-head" class="hd-head"></div>
      <div class="ctlrow"><button id="hd-auto" class="tog">AUTO</button><button id="hd-prev" class="chip" title="the previous station heard" aria-label="previous station">◀</button><button id="hd-next" class="chip" title="the next station heard" aria-label="next station">▶</button>${wfHtml('hd')}<button id="hd-export" class="ib" title="export the stations and the log" aria-label="export"><svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zm7-18-5.5 5.5 1.4 1.4L11 5.8V16h2V5.8l3.1 3.1 1.4-1.4L12 2z"/></svg></button>${pauseClearHtml('hd')}</div>
      <div class="ctlrow">${segHtml(tabs.map(v => `<button data-hdview="${v}">${v === 'now' ? 'NOW' : v.toUpperCase()}</button>`))}</div>
      <div id="hd-detail" class="mt-detail hd-detail" hidden></div>
      <div id="hd-stage" class="hd-stage">${wide ? '' : `<div id="hd-hero" class="hd-hero"></div>${mapHtml}`}<div id="hd-stations" class="hd-stations"></div><div id="hd-data" class="hd-data"></div></div>
      <div id="hd-log"><div class="countrow"><span id="count-hd" class="count">0 DECODED</span></div>${listHtml('hd', 'listening for HD Radio…')}</div>
      <div class="note about">HD Radio (NRSC-5) on hybrid FM stations, receive only. Layer 1 is decoded here from the standard: the station's name, ID, location, slogan and message (SIS, majority-voted: its checksum does not verify yet), each program's title, artist and album (PSD), and the data services: album art, station logos, traffic map tiles and weather radar placed on the map, every file shown in DATA. The digital audio codec is proprietary and not decoded: what plays is the station's analog FM under the digital sidebands. The large-object and service-directory formats are derived from our recordings. AUTO first finds the stations across the band, then visits the strong ones from the bottom up and stays on each until it fills in. At the top it looks again.</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-hdview]', view).forEach(b => b.onclick = () => { hdUi.view = b.dataset.hdview as HdView; hdUi.sel = ''; refreshHd(true); });
  qa<HTMLButtonElement>('[data-hdleft]', view).forEach(b => b.onclick = () => { hdUi.left = b.dataset.hdleft as 'now' | 'map'; refreshHd(true); requestAnimationFrame(() => geo?.invalidate()); });
  $('hd-auto').onclick = () => hdSetAuto(!hdUi.auto);
  $('hd-prev').onclick = () => hdStep(-1);
  $('hd-next').onclick = () => hdStep(1);
  $('hd-export').onclick = hdExport;
  const pick = (e: Event) => {
    const t = e.target as HTMLElement;
    const tuneEl = t.closest<HTMLElement>('[data-hdtune]'); if (tuneEl) { hdSetAuto(false); hdTune(Number(tuneEl.dataset.hdtune)); if (!HD_WIDE.matches) hdUi.view = 'now'; else hdUi.left = 'now'; refreshHd(true); return; }
    const prog = t.closest<HTMLElement>('[data-hdprog]'); if (prog) { hdUi.prog = Number(prog.dataset.hdprog); refreshHd(true); return; }
    const save = t.closest<HTMLElement>('[data-hdsave]'); if (save) { const o = hdUi.objects.find(x => x.key === save.dataset.hdsave); if (o) hdSaveObject(o); return; }
    const obj = t.closest<HTMLElement>('[data-hdobj]'); if (obj) { hdUi.sel = hdUi.sel === obj.dataset.hdobj ? '' : obj.dataset.hdobj!; refreshHd(true); return; }
    const close = t.closest<HTMLElement>('[data-hddo="close"]'); if (close) { hdUi.sel = ''; refreshHd(true); }
  };
  // A redraw between press and release would swap the element under the pointer and lose the click.
  const hold = () => { hdUi.hold = true; };
  const release = () => { if (!hdUi.hold) return; setTimeout(() => { hdUi.hold = false; refreshHd(true); }, 0); };
  for (const id of ['hd-hero', 'hd-stations', 'hd-data', 'hd-detail']) { const el = q<HTMLElement>(`#${id}`); if (el) { el.onclick = pick; el.onpointerdown = hold; } }
  if (!hdUi.wired) { hdUi.wired = true; window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); }
  geo = new GeoMap($('hd-map'), { home: state.home, start: mapStart(state.home), onPick: id => { if (id.startsWith('st:')) { hdSetAuto(false); hdTune(Number(id.slice(3))); } }, log });
  hdUi.mapKey = ''; hdUi.fitted = '';
  clearInterval(hdUi.timer);
  hdUi.timer = window.setInterval(() => { if (state.app !== 'hd') { clearInterval(hdUi.timer); clearTimeout(hdUi.scanTimer); return; } refreshHd(); }, 500);
  if (hdUi.auto) { clearTimeout(hdUi.scanTimer); hdUi.scanTimer = window.setTimeout(hdScanTick, 500); }
  refreshList('hd');
  refreshHd(true);
}

/** The lock, in words, and how it shows. */
function hdLock(m: HdSnapMsg | null, now: number): [string, '' | 'ok' | 'amber' | 'red'] {
  if (!hdMine(m)) return ['TUNING', ''];
  const st = m.station, fresh = st.lastFrameMs && now - st.lastFrameMs < 4_000;
  if (fresh) return [st.ber < 0.05 ? 'DIGITAL LOCK' : 'DIGITAL · WEAK', 'ok'];
  if (m.rx.state === 'frames' || m.rx.state === 'sync') return ['SYNC', 'amber'];
  if (m.rx.state === 'ofdm') return ['OFDM FOUND', 'amber'];
  if (m.det?.present) return ['SIDEBANDS', 'amber'];
  return ['ANALOG ONLY', ''];
}
function hdHead(m: HdSnapMsg | null, now: number): string {
  const st = hdMine(m) ? m.station : null, sis = st?.sis, rec = hdUi.stations.get(hdKey(state.freq));
  const call = sis?.callsign && sis.nameVotes[0] >= 3 ? sis.callsign : rec?.call ?? '';
  const [lock, tone] = hdLock(m, now);
  const s = hdUi.scan;
  const scan = hdUi.auto ? (s.phase === 'rest' ? 'AUTO · NO HD HEARD · LOOKING AGAIN SOON' : s.phase !== 'dwell' ? 'AUTO · FINDING STATIONS 88–108' : `AUTO · ${s.locked ? 'FILLING IN' : 'CHECKING'} ${Math.max(0, Math.ceil((s.until - now) / 1000))} s · ${s.queue.length} NEXT`) : '';
  const tile = (n: number | string, l: string) => `<span><b>${n}</b><small>${l}</small></span>`;
  const progs = st ? st.programs.filter(p => p.lastMs).length : rec?.programs.length ?? 0;
  return `<div class="hd-watch"><b>${hdMhz(state.freq)} MHz</b>${call ? `<strong>${esc(call)}</strong>` : ''}<small>${esc(sis?.slogan || rec?.slogan || (st?.frames ? '' : 'no digital data yet'))}</small><em class="${tone}">${lock}</em></div>`
    + (sis?.message ? `<div class="hd-ticker${sis.messagePriority ? ' prio' : ''}">${sis.messagePriority ? '<em>PRIORITY</em>' : ''}<span><i>${esc(sis.message)}</i></span></div>` : '')
    + (scan ? `<div class="hd-scan">${scan}</div>` : '')
    + `<div class="hd-count">${tile(progs, 'PROGRAMS')}${tile(hdUi.stations.size, 'STATIONS')}${tile(hdObjects().length, 'OBJECTS')}${tile(st?.frames ?? 0, 'FRAMES')}${tile(st && st.frames ? (st.ber * 100).toFixed(2) + '%' : '-', 'RAW BER')}</div>`;
}
/** The station's transmitter as sent: a place on the map, or why it is not one. */
function hdLocText(s: SisSummary): string {
  if (s.lat === null || s.lon === null) return '-';
  const at = `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${s.altM !== null ? ` · ${s.altM} m` : ''}`;
  if (!locationValid(s.lat, s.lon)) return `${at} · not a valid location as sent, not placed on the map`;
  const h = state.home, d = h ? distanceBearing(h.lat, h.lon, s.lat, s.lon) : null;
  return `${at}${d ? ` · ${d.km < 10 ? d.km.toFixed(1) : d.km.toFixed(0)} km at ${d.deg.toFixed(0)}°` : ''}`;
}
/** The station clock, checked against this device's: never used when it disagrees. */
function hdClockText(s: SisSummary): string {
  if (!s.alfnMs) return '-';
  const c = clockCheck(s.alfnMs, s.alfnLocalMs, s.timeLocked), t = `${new Date(s.alfnMs).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  if (c.trusted) return `${t} · agrees with this device (${(c.offsetMs / 1000).toFixed(1)} s) · locked to GPS`;
  const off = Math.abs(c.offsetMs), d = off < 120_000 ? `${(off / 1000).toFixed(0)} s` : off < 7_200_000 ? `${(off / 60_000).toFixed(0)} min` : off < 172_800_000 ? `${(off / 3_600_000).toFixed(1)} h` : `${(off / 86_400_000).toFixed(0)} days`;
  return `${t} · ${s.alfnLocalMs ? `${d} ${c.offsetMs < 0 ? 'behind' : 'ahead of'} this device` : 'not checked'}${s.timeLocked ? '' : ' · not locked to GPS'} · not used`;
}
/** SIS parameter 3 as a hint, marked unreliable when it disagrees with this device or does not hold steady. */
function hdTzText(s: SisSummary): string {
  const v = s.params[3]; if (v === undefined) return '-';
  const h = localTimeHint(v), [n, total] = s.paramVotes[3] ?? [0, 0], now = new Date(), mine = -now.getTimezoneOffset();
  // the standard time offset too, as a station may send it whether or not DST is in effect
  const std = -Math.max(new Date(now.getFullYear(), 0, 1).getTimezoneOffset(), new Date(now.getFullYear(), 6, 1).getTimezoneOffset());
  const steady = total > 0 && n * 2 > total;
  const agrees = steady && (h.offsetMin === mine || h.offsetMin === std);
  return `${utcOffsetText(h.offsetMin)}${h.dstLocal ? ' · DST practiced' : ''}${h.dstNow ? ' · DST in effect' : ''} · ${agrees ? 'agrees with this device' : `unreliable (${steady ? `this device is ${utcOffsetText(mine)}` : 'it changes from frame to frame'})`}`;
}
/** The data services SIS lists (MSG 6 data descriptors), by type, with how many of each. */
function hdDataSvcText(s: SisSummary): string {
  const c = new Map<number, number>(); for (const d of s.data) c.set(d.type, (c.get(d.type) ?? 0) + 1);
  return [...c].map(([t, n]) => `${dataTypeName(t)} (${t})${n > 1 ? ` ×${n}` : ''}`).join(' · ') || '-';
}
/** Emergency alerts: a single EA PDU is most likely a bit error the missing CRC let through, so only a repeat counts. */
function hdAlertText(s: SisSummary): string {
  if (!s.alerts) return 'none';
  return s.alertsRepeated ? `${s.alertsRepeated} repeated, content not decoded` : `none confirmed · ${s.alerts} single EA PDU${s.alerts === 1 ? '' : 's'}, unverified (likely bit errors)`;
}
/** The last frames, each as its raw BER and the FCS results of the packets it carried. */
function hdFrames(st: StationSnap): string {
  const h = st.history.slice(-30); if (!h.length) return '';
  const last = h[h.length - 1];
  return `<div class="hd-frames" title="one bar per L1 frame: its height the raw bit error rate before FEC, red where a packet failed its FCS">${h.map(f => `<i class="${f.fcsBad ? 'bad' : f.ber >= 0.05 ? 'weak' : ''}" style="height:${Math.max(8, Math.min(100, f.ber * 1000)).toFixed(0)}%"></i>`).join('')}</div>`
    + `<div class="hd-kv"><span>LAST FRAME <b>BER ${(last.ber * 100).toFixed(2)}% · FCS ${last.fcsGood} good${last.fcsBad ? ` · ${last.fcsBad} failed` : ''}</b></span><span>FRAMES <b>${st.framesGood} of ${st.frames} with a clean PCI</b></span></div>`;
}
function hdSideband(label: string, snr: number | null, det: number | null, ref: number | null): string {
  const v = snr === null || snr < -50 ? 0 : Math.max(0, Math.min(1, snr / 25));
  return `<div class="hd-sb"><b>${label}</b><span class="hd-bar"><i style="width:${(100 * v).toFixed(0)}%"></i></span><small>${snr === null || snr < -50 ? '-' : `${snr.toFixed(1)} dB SNR`}${det !== null && ref !== null ? ` · ${(det - ref).toFixed(0)} dB over noise` : ''}</small></div>`;
}
function hdHero(m: HdSnapMsg | null, now: number): string {
  const st = hdMine(m) ? m.station : null, rec = hdUi.stations.get(hdKey(state.freq));
  const progs: ProgramRow[] = st?.programs ?? [];
  const sel = progs.find(p => p.n === hdUi.prog) ?? progs[0] ?? null;
  if (sel && sel.n !== hdUi.prog) hdUi.prog = sel.n;
  const art = hdArt(sel, state.freq), logo = hdLogo(hdKey(state.freq), sel?.n ?? 0);
  const call = (st?.sis.callsign && st.sis.nameVotes[0] >= 3 ? st.sis.callsign : rec?.call) || hdMhz(state.freq);
  const artHtml = art ? `<img src="${art.url}" alt="${art.kind === 'art' ? 'album art' : 'station logo'}" class="${art.kind}">` : `<div class="hd-ph"><span>${glyph('hd', 'currentColor', 54)}</span><b>${esc(call)}</b><small>HD${(sel?.n ?? 0) + 1}</small></div>`;
  const recProg = rec?.programs.find(p => p.n === (sel?.n ?? 0));
  const title = sel?.title || '', artist = sel?.artist || '';
  const waiting = !st?.frames ? (hdLock(m, now)[0] === 'ANALOG ONLY' ? 'No digital sidebands on this station: the analog audio plays' : 'Waiting for the digital side') : 'Waiting for this program\'s song data';
  const tabs = progs.length ? `<div class="hd-progs">${progs.map(p => `<button data-hdprog="${p.n}" class="hd-prog ${p.n === sel?.n ? 'on' : ''} ${p.lastMs && now - p.lastMs < 10_000 ? 'live' : ''}"><b>HD${p.n + 1}</b><small>${esc(p.typeName || 'program')}</small><i>${esc(p.title ? `${p.title}${p.artist ? ` · ${p.artist}` : ''}` : p.lastMs ? 'on air' : 'listed in SIS')}</i></button>`).join('')}</div>` : '';
  const det = hdMine(m) ? m.det : null;
  const sig = `<div class="hd-sig">${hdSideband('LOWER', st && st.frames ? st.snrLoDb : null, det?.sbLoDb ?? null, det?.refDb ?? null)}${hdSideband('UPPER', st && st.frames ? st.snrHiDb : null, det?.sbHiDb ?? null, det?.refDb ?? null)}`
    + `<div class="hd-kv"><span>LOCK <b>${hdLock(m, now)[0]}</b></span>${st?.frames ? `<span>RAW BER <b>${(st.ber * 100).toFixed(2)}%</b></span><span>PCI <b>${esc(st.pciName)}</b></span>` : ''}${hdMine(m) ? `<span>CARRIER <b>${m.rx.cfoHz >= 0 ? '+' : ''}${m.rx.cfoHz.toFixed(0)} Hz</b></span>` : ''}${st && st.blend >= 0 ? `<span>BLEND <b>${BLEND_NAMES[st.blend].toUpperCase()}</b></span>` : ''}<span>AUDIO <b>ANALOG FM</b></span></div>${st?.frames ? hdFrames(st) : ''}</div>`;
  const s = st?.frames ? st.sis : null;
  const info = s ? `<div class="hd-info"><small>STATION</small><div class="hd-kv">${s.facility >= 0 ? `<span>FACILITY <b>${esc(s.country)} ${s.facility}</b></span>` : ''}${s.lat !== null ? `<span>TRANSMITTER <b>${esc(hdLocText(s))}</b></span>` : ''}${s.data.length ? `<span>DATA SERVICES <b>${esc(hdDataSvcText(s))}</b></span>` : ''}${s.alfnMs ? `<span>CLOCK <b>${esc(hdClockText(s))}</b></span>` : ''}</div></div>` : '';
  const songs = sel && sel.songs.length > 1 ? `<div class="hd-hist"><small>EARLIER ON HD${sel.n + 1}</small>${sel.songs.slice(1, 8).map(s => `<div><b>${hdClock(s.ms)}</b><span>${esc(s.title)}${s.artist ? ` · ${esc(s.artist)}` : ''}</span></div>`).join('')}</div>` : '';
  return `<div class="hd-np"><div class="hd-art">${artHtml}</div><div class="hd-meta">`
    + `<div class="hd-station">${logo ? `<img src="${logo}" alt="logo">` : ''}<b>${esc(call)}</b><span>${hdMhz(state.freq)} MHz${sel ? ` · HD${sel.n + 1}` : ''}${sel?.typeName ? ` · ${esc(sel.typeName)}` : recProg?.typeName ? ` · ${esc(recProg.typeName)}` : ''}</span></div>`
    + `<div class="hd-title">${esc(title || waiting)}</div>${artist ? `<div class="hd-artist">${esc(artist)}</div>` : ''}${sel?.album ? `<div class="hd-album">${esc(sel.album)}</div>` : ''}`
    + `</div></div>${tabs}${sig}${info}${songs}`;
}
function hdStationsHtml(now: number): string {
  const list = [...hdUi.stations.values()].sort((a, b) => a.hz - b.hz);
  if (!list.length) return emptyState('hd');
  return list.map(r => {
    const logo = hdLogo(r.hz, 0) ?? Object.values(r.logos)[0], here = r.hz === hdKey(state.freq), live = here && now - r.lastMs < 5_000;
    return `<div class="hd-st ${here ? 'sel' : ''}" data-hdtune="${r.hz}"><div class="hd-stl">${logo ? `<img src="${logo}" alt="">` : `<span>${glyph('hd', 'currentColor', 30)}</span>`}</div>`
      + `<div class="hd-stb"><div class="hd-sth"><b>${esc(r.call || 'name not heard yet')}</b><span>${hdMhz(r.hz)} MHz</span><em class="${live ? 'on' : ''}">${live ? 'LIVE' : hdAgo(now - r.lastMs)}</em></div>`
      + `${r.slogan || r.longName ? `<div class="hd-sts">${esc(r.slogan || r.longName)}</div>` : ''}`
      + `<div class="hd-stp">${r.programs.map(p => `<span><b>HD${p.n + 1}</b>${esc(p.typeName || '')}${p.title ? `<i>${esc(p.title)}${p.artist ? ` · ${esc(p.artist)}` : ''}</i>` : ''}</span>`).join('')}</div>`
      + `<div class="hd-stk">${r.facility >= 0 ? `<span>FACILITY <b>${r.facility}</b></span>` : ''}${r.country ? `<span>COUNTRY <b>${esc(r.country)}</b></span>` : ''}${r.lat !== null && r.lon !== null ? `<span>TX <b>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}${r.altM !== null ? ` · ${r.altM} m` : ''}</b></span>` : ''}${r.data.length ? `<span>DATA <b>${esc(r.data.join(', '))}</b></span>` : ''}<span>FIRST <b>${new Date(r.firstMs).toLocaleDateString()}</b></span></div></div></div>`;
  }).join('');
}
const HD_KIND: Record<string, string> = { art: 'ALBUM ART', logo: 'LOGO', traffic: 'TRAFFIC TILE', 'traffic-info': 'TRAFFIC MAP INFO', radar: 'WEATHER RADAR', 'radar-info': 'RADAR INFO', image: 'IMAGE', text: 'TEXT', file: 'FILE' };
function hdDataHtml(m: HdSnapMsg | null, now: number): string {
  const st = hdMine(m) ? m.station : null, objs = hdObjects(state.freq);
  const rows = objs.map(o => `<div class="hd-obj ${hdUi.sel === o.key ? 'sel' : ''}" data-hdobj="${esc(o.key)}">${o.mime.startsWith('image/') ? `<img src="${o.kind === 'traffic' ? hdTileUrl(o) : o.url}" alt="">` : `<span class="hd-oi">${o.mime === 'text/plain' ? 'TXT' : 'BIN'}</span>`}`
    + `<div><b>${esc(o.name || `object ${hdHex(o.id)}`)}</b><small>${HD_KIND[o.kind] ?? o.kind} · port ${hdHex(o.port)} · ${hdSize(o.size)} · ${esc(o.mime)} · ${hdAgo(now - o.ms)}</small></div><button class="chip" data-hdsave="${esc(o.key)}">SAVE</button></div>`).join('');
  const pend = st?.pending.filter(p => p.need < 10_000) ?? [];
  const pendHtml = pend.length ? `<div class="hd-sec"><small>COMING IN</small>${pend.map(p => `<div class="hd-pend"><b>${esc(p.name || `object ${hdHex(p.id)}`)}</b><span class="hd-bar"><i style="width:${(100 * p.have / p.need).toFixed(0)}%"></i></span><small>${p.have}/${p.need} · port ${hdHex(p.port)}</small></div>`).join('')}</div>` : '';
  const ports = st?.ports.length ? `<div class="hd-sec"><small>PORTS</small><table class="hd-tab"><tr><th>PORT</th><th>WHAT</th><th>PACKETS</th><th>BYTES</th><th>LAST</th></tr>${st.ports.map(p => `<tr><td>${hdHex(p.port)}</td><td>${esc([p.kind, p.name].filter(Boolean).join(' · ') || p.bearer)}</td><td>${p.packets}</td><td>${hdSize(p.bytes)}</td><td>${hdAgo(now - p.lastMs)}</td></tr>`).join('')}</table></div>` : '';
  const sig = st?.sig.length ? `<div class="hd-sec"><small>SERVICE DIRECTORY (format derived from recordings)</small>${st.sig.map(s => `<div class="hd-svc"><b>${esc(s.name || (s.kind === 'audio' ? `HD${s.program + 1}` : 'data'))}</b><span>${s.kind === 'audio' ? `HD${s.program + 1} · ${esc(programTypeName(s.progType))}` : 'data service'}</span><small>${s.components.map(c => `port ${hdHex(c.port)} · MIME ${c.mimeHex}`).join(' · ')}</small></div>`).join('')}</div>` : '';
  const sis = st && st.frames ? (() => { const s = st.sis; const f: [string, string][] = [['CALL SIGN', s.callsign ? `${s.callsign} (${s.nameVotes[0]} of ${s.nameVotes[1]} votes)` : '-'], ['LONG NAME', s.longName || '-'], ['UNIVERSAL NAME', s.universal || '-'], ['SLOGAN', s.slogan || '-'], ['MESSAGE', s.message ? `${s.message}${s.messagePriority ? ' (priority)' : ''}` : '-'], ['FACILITY', s.facility >= 0 ? `${s.country} ${s.facility}` : '-'],
    ['TRANSMITTER', hdLocText(s)], ['STATION CLOCK', hdClockText(s)], ['TIME ZONE HINT', hdTzText(s)],
    ['LEAP SECONDS', s.params[0] !== undefined ? `${(s.params[0] << 24) >> 24} s as sent (the clock uses 18 s)` : '-'], ['EMERGENCY ALERTS', hdAlertText(s)],
    ['AUDIO SERVICES', s.audio.map(a => `HD${a.program + 1} ${programTypeName(a.type)}`).join(' · ') || '-'], ['DATA SERVICES', s.data.map(d => `${dataTypeName(d.type)} (${d.type}, MIME ${d.mime12})`).join(' · ') || '-'],
    ['FIXED BEARER', st.ccc ? st.ccc.subs.map(x => `${x.length} B/frame`).join(' + ') : '-'], ['PACKETS', `${st.hdlcGood} good · ${st.hdlcBad} failed FCS`], ['SIS PDUS', `${s.pdus} (${s.llds} other)`]];
    return `<div class="hd-sec"><small>STATION INFORMATION (SIS, voted)</small><div class="mt-fields">${f.map(([k, v]) => `<div><b>${k}</b><span>${esc(v)}</span></div>`).join('')}</div></div>`; })() : '';
  return (rows ? `<div class="hd-objs">${rows}</div>` : `<div class="empty">no files yet · logos and album art take a minute or two to come in whole</div>`) + pendHtml + sis + sig + ports;
}
function hdDetail(now: number): string {
  const o = hdUi.objects.find(x => x.key === hdUi.sel); if (!o) return '';
  const text = o.mime === 'text/plain' ? new TextDecoder('latin1').decode(o.bytes) : '';
  const f: [string, string][] = [['NAME', o.name || '-'], ['KIND', HD_KIND[o.kind] ?? o.kind], ['PORT', hdHex(o.port)], ['OBJECT ID', hdHex(o.id)], ['SIZE', `${o.size} bytes`], ['TYPE', o.mime], ['PROGRAM', o.program >= 0 ? `HD${o.program + 1}` : '-'], ['STATION', `${hdMhz(o.hz)} MHz`], ['RECEIVED', `${hdClock(o.ms)} · ${hdAgo(now - o.ms)}`]];
  return `<div class="hd-dh"><b>${esc(HD_KIND[o.kind] ?? 'FILE')}</b><button class="chip" data-hdsave="${esc(o.key)}">SAVE</button><button class="chip" data-hddo="close">✕</button></div>`
    + (o.mime.startsWith('image/') ? `<div class="hd-big"><img src="${o.url}" alt=""></div>` : '') + (text ? `<pre class="hd-text">${esc(text)}</pre>` : '')
    + `<div class="mt-fields">${f.map(([k, v]) => `<div><b>${k}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
}
/** The map's layers: every station's transmitter, the newest traffic tiles and radar image on their corners. */
function hdMapLayers(): void {
  if (!geo) return;
  const pins: GeoItem[] = [...hdUi.stations.values()].filter(r => r.lat !== null && r.lon !== null).map(r => ({ id: `st:${r.hz}`, lat: r.lat!, lon: r.lon!, label: `${r.call || hdMhz(r.hz)} ${hdMhz(r.hz)}`, kind: 'tower' as GeoItem['kind'] }));
  const imgs: GeoImage[] = [];
  const tiles = new Map<string, HdObj>();
  for (const o of hdUi.objects) {
    if (o.kind !== 'traffic') continue;
    const t = trafficTile(o.name); if (!t || !hdUi.maps.traffic[t.map]) continue;
    const k = `${t.map}/${t.row}/${t.col}`, cur = tiles.get(k), ct = cur ? trafficTile(cur.name)! : null;
    if (!cur || ct!.stamp < t.stamp) tiles.set(k, o);
  }
  for (const [k, o] of tiles) { const t = trafficTile(o.name)!, b = tileBounds(hdUi.maps.traffic[t.map], t.row, t.col); imgs.push({ id: `tile:${k}`, url: hdTileUrl(o), ...b, opacity: 0.9 }); }
  let radarLegend: RadarInfo | null = null, radarStamp = '';
  const radars = new Map<string, HdObj>();
  for (const o of hdUi.objects) { if (o.kind !== 'radar') continue; const r = radarImage(o.name); if (!r || !hdUi.maps.radar[r.area]) continue; const cur = radars.get(r.area); if (!cur || radarImage(cur.name)!.stamp < r.stamp) radars.set(r.area, o); }
  for (const [area, o] of radars) { const info = hdUi.maps.radar[area]; imgs.unshift({ id: `radar:${area}`, url: o.url, north: info.north, south: info.south, west: info.west, east: info.east, opacity: 0.7 }); radarLegend = info; radarStamp = radarImage(o.name)!.stamp; }
  const key = JSON.stringify([pins.map(p => p.id), imgs.map(i => i.id + i.url)]);
  if (key !== hdUi.mapKey) { hdUi.mapKey = key; geo.update(pins, `st:${hdKey(state.freq)}`); geo.setImages(imgs); }
  const fitKey = imgs.length ? imgs.map(i => i.id).sort().join() : '';
  if (geo.ready && fitKey && hdUi.fitted !== fitKey && !pins.length) { const n = Math.max(...imgs.map(i => i.north)), s = Math.min(...imgs.map(i => i.south)), w = Math.min(...imgs.map(i => i.west)), e = Math.max(...imgs.map(i => i.east)); geo.showBounds(n, s, w, e); hdUi.fitted = fitKey; }
  const leg = q('#hd-legend');
  if (leg) {
    const traffic = Object.values(hdUi.maps.traffic)[0];
    leg.hidden = !imgs.length;
    if (imgs.length) leg.innerHTML = `${tiles.size ? `<div><b>TRAFFIC</b><small>${tiles.size} tiles${traffic ? ` · ${esc(traffic.copyright)}` : ''}</small></div>` : ''}${radarLegend ? `<div><b>RADAR ${esc(radarStamp.replace('_', ' '))} UTC</b>${radarLegend.legends.map(l => `<span><small>${esc(l.name.toUpperCase())}</small>${l.colors.map(([, c]) => `<i style="background:rgb(${c[0]},${c[1]},${c[2]})"></i>`).join('')}</span>`).join('')}<small>${esc(radarLegend.copyright)}</small></div>` : ''}`;
  }
  if (!pins.length && !imgs.length) geo.setEmpty('No map data yet', 'Transmitters show here from each station\'s SIS. Where a station sends traffic and weather radar, both come in about 1 to 1.5 minutes after tuning');
  else geo.setEmpty('');
}
function refreshHd(force = false): void {
  if (state.app !== 'hd') return;
  const now = Date.now();
  if (hdUi.hold) return;
  if (!force && now - hdUi.drawn < 240) { clearTimeout(hdUi.pending); hdUi.pending = window.setTimeout(() => refreshHd(true), 250); return; }
  hdUi.drawn = now;
  const m = hdUi.snap, wide = HD_WIDE.matches, view = hdUi.view;
  const head = q('#hd-head'); if (head) head.innerHTML = hdHead(m, now);
  const auto = q('#hd-auto'); if (auto) auto.classList.toggle('on', hdUi.auto);
  qa<HTMLButtonElement>('[data-hdleft]').forEach(b => b.classList.toggle('on', b.dataset.hdleft === hdUi.left));
  const objs = hdObjects().length;
  qa<HTMLButtonElement>('[data-hdview]').forEach(b => {
    const v = b.dataset.hdview as HdView; b.classList.toggle('on', v === view);
    b.textContent = v === 'now' ? 'NOW' : v === 'stations' ? `STATIONS ${hdUi.stations.size}` : v === 'data' ? `DATA ${objs}` : v.toUpperCase();
  });
  const hero = q('#hd-hero'), mapEl = q('#hd-map'), mapBox = q('.hd-mapbox'), stations = q('#hd-stations'), data = q('#hd-data'), det = q('#hd-detail'), stage = q('#hd-stage'), logEl = q('#hd-log');
  if (!hero || !mapEl || !stations || !data || !det || !stage || !logEl) return;
  const showMap = wide ? hdUi.left === 'map' : view === 'map', showHero = wide ? hdUi.left === 'now' : view === 'now';
  hero.hidden = !showHero; if (mapBox) (mapBox as HTMLElement).hidden = !showMap; else mapEl.hidden = !showMap;
  const legend = q('#hd-legend'); if (legend && !showMap) legend.hidden = true;
  stations.hidden = view !== 'stations'; data.hidden = view !== 'data';
  stage.hidden = view === 'log' || (wide && view !== 'stations' && view !== 'data'); logEl.hidden = view !== 'log';
  const keep = (el: HTMLElement, html: string) => { const top = el.scrollTop; if (el.innerHTML !== html) el.innerHTML = html; el.scrollTop = top; };
  if (!paused.has('hd')) {
    if (showHero) keep(hero, hdHero(m, now));
    if (view === 'stations') keep(stations, hdStationsHtml(now));
    else if (view === 'data') keep(data, hdDataHtml(m, now));
  }
  if (showMap) { geo?.invalidate(); hdMapLayers(); }
  const html = hdUi.sel ? hdDetail(now) : '';
  det.hidden = !html; if (html) keep(det, html);
  const [lock, tone] = hdLock(m, now);
  setLamp(lock, tone, tone === 'amber');
  const st = hdMine(m) ? m.station : null, sel = st?.programs.find(p => p.n === hdUi.prog);
  setFace('HD RADIO', st?.sis.callsign && st.sis.nameVotes[0] >= 3 ? `${st.sis.callsign}${sel ? ` · HD${sel.n + 1}` : ''}` : 'NRSC-5 · FM HYBRID', sel?.title ? `${sel.title}${sel.artist ? ` · ${sel.artist}` : ''}` : '');
}
function hdExport(): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const lines = (logs['hd'] ?? []).slice().reverse();
  download(`hd-log-${stamp}.csv`, 'line\n' + lines.map(l => `"${l.replace(/"/g, '""')}"`).join('\n'), 'text/csv');
  const stations = [...hdUi.stations.values()].map(({ logos: _l, ...r }) => r);
  const objects = hdUi.objects.map(({ bytes: _b, url: _u, ...o }) => o);
  setTimeout(() => download(`hd-stations-${stamp}.json`, JSON.stringify({ stations, objects, maps: hdUi.maps, station: hdUi.snap?.station ?? null }, null, 1), 'application/json'), 400);
}
// ---- Cell: LTE cells and emergency alerts (WEA/CMAS, ETWS) from the broadcast channels, receive only ----------------
const CELL_KEY = 'mm.cell.v1';
const CELL_HACKRF_RATE = 15_360_000, CELL_WIDE_RATE = 20_000_000, CELL_RTL_RATE = 1_920_000;
const CELL_WIDE = window.matchMedia('(min-width: 1000px)');
CELL_WIDE.addEventListener('change', () => { if (state.app === 'cell') { const v = q<HTMLElement>('main#view'); if (v) renderCell(v); } });
type CellView = 'alerts' | 'cells' | 'neighbors' | 'log';
interface CellDetail { key: string; mib: CellMib | null; sib1: Record<string, unknown> | null; sib1Hex: string; sibs: CellSibRec[] }
const cellUi = {
  snap: null as CellSnap | null, view: 'alerts' as CellView, band: 'AUTO', sel: '', detail: null as CellDetail | null, detailAsked: 0,
  hold: false, wired: false, timer: 0, scanTimer: 0, drawn: 0, pending: 0, restored: false, clearArm: 0, seenAlerts: new Set<string>(), banner: '', alertSel: '', mapSig: '', feedFilter: 'all' as 'all' | 'alerts' | 'changes', openSib: '',
  html: new Map<string, string>(),
  scan: { phase: 'survey' as 'survey' | 'visit' | 'dwell' | 'stay', bandIdx: 0, windows: [] as number[], wi: 0, cands: [] as CarrierGuess[], ci: 0,
    until: 0, tunedMs: 0, profile: null as Profile | null, stayHz: 0 },
};
const cellRtl = () => !!radio && radio.kind === 'rtlsdr';
const cellRate = () => cellRtl() ? CELL_RTL_RATE : CELL_HACKRF_RATE;
/** A 20 MHz carrier (100 RBs) does not fit 15.36 MS/s: on a HackRF it is read at 20 MS/s, which the decoder resamples to 30.72 MS/s. */
const cellRateFor = (hz: number) => radio?.kind === 'hackrf' && (cellUi.snap?.cells ?? []).some(c => c.hz === hz && c.nrb > 75) ? CELL_WIDE_RATE : cellRate();
const cellMhz = (hz: number) => (hz / 1e6).toFixed(1);
const cellAgo = (ms: number) => ms < 2_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 172_800_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`;
const cellTime = (ms: number) => { const d = new Date(ms); return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toTimeString().slice(0, 8)}`; };
const CELL_RANK_COLOR = ['#8d97ab', '#4c8dff', '#ffaf00', '#ff7a45', '#ff4d4d', '#ff2a6a'];
const cellBands = () => cellUi.band === 'AUTO' ? CELL_BANDS : CELL_BANDS.filter(b => b.id === cellUi.band);
const cellBandAt = (hz: number) => CELL_BANDS.find(b => hz >= b.lo - 2e6 && hz <= b.hi + 2e6) ?? null;
/** What the connected radio can and cannot do here, said plainly. */
function cellCapability(): [string, 'ok' | 'amber' | ''] {
  if (!radio) return ['NO RADIO · a HackRF reads cells, SIBs and alerts; an RTL-SDR reads cells and their MIB', ''];
  if (cellRtl()) return ['RTL-SDR · 1.92 MS/s · cell search and MIB from the center 1.08 MHz · SIBs and alerts need the whole carrier: a HackRF', 'amber'];
  return [`HACKRF · ${state.rate === CELL_WIDE_RATE ? '20 MS/s' : '15.36 MS/s'} · cells, MIB, every SIB and the alerts of carriers up to 20 MHz (20 MS/s for 20 MHz carriers)`, 'ok'];
}

function cellOpen(): void {
  const sc = cellUi.scan;
  if (sc.phase === 'stay' && sc.stayHz) configure('NONE', sc.stayHz, cellRateFor(sc.stayHz), 32, 40, true, 'cell');
  else { cellSurvey(true); configure('NONE', sc.windows[0], cellRate(), 32, 40, true, 'cell'); }
  if (!cellUi.restored) {
    cellUi.restored = true;
    let saved: unknown = null;
    try { saved = JSON.parse(localStorage.getItem(CELL_KEY) ?? 'null'); } catch { /* storage blocked or bad */ }
    if (saved) worker?.postMessage({ type: 'cell', cmd: 'restore', state: saved });
  }
  requestGeo();
  cellTick();
}
/** A band sweep for carriers: windows across the band, a power profile stitched from them. */
function cellSurvey(first = false): void {
  const sc = cellUi.scan, bands = cellBands(), b = bands[sc.bandIdx % bands.length], use = 0.8 * cellRate();
  const n = Math.max(1, Math.ceil((b.hi - b.lo) / use));
  sc.windows = Array.from({ length: n }, (_, i) => Math.round(n === 1 ? (b.lo + b.hi) / 2 : b.lo + use / 2 + i * ((b.hi - b.lo - use) / (n - 1))));
  sc.wi = 0; sc.phase = 'survey'; sc.profile = newProfile(b.lo, b.hi); sc.cands = []; sc.ci = 0;
  if (!first) cellGo(sc.windows[0], 700);
}
function cellGo(hz: number, ms: number): void { const sc = cellUi.scan; sc.until = Date.now() + ms; sc.tunedMs = Date.now(); const r = cellRateFor(hz); if (state.rate !== r) setRate(r); tune(hz); refreshCell(true); }
function cellNextBand(): void { const sc = cellUi.scan; sc.bandIdx = (sc.bandIdx + 1) % cellBands().length; cellSurvey(); }
function cellNextCandidate(): void {
  const sc = cellUi.scan;
  sc.ci++;
  if (sc.ci >= sc.cands.length) { if (cellUi.band === 'AUTO') cellNextBand(); else cellSurvey(); return; }
  sc.phase = 'visit'; cellGo(sc.cands[sc.ci].centerHz, 1600);
}
/** The scan: survey a band, visit each carrier found, stay long enough for its whole SI cycle, move on. */
function cellTick(): void {
  clearTimeout(cellUi.scanTimer);
  if (state.app !== 'cell') return;
  const sc = cellUi.scan, s = cellUi.snap, now = Date.now(), here = s && s.centerHz === state.freq && s.rate === state.rate && s.lastBlockMs > sc.tunedMs ? s : null;
  if (sc.phase === 'survey') {
    if (here?.profile && sc.profile) stitch(sc.profile, here.profile.lo, here.profile.step, here.profile.db);
    if (now >= sc.until && (here || now - sc.tunedMs > 3000)) {
      sc.wi++;
      if (sc.wi < sc.windows.length) cellGo(sc.windows[sc.wi], 700);
      else {
        const b = cellBands()[sc.bandIdx % cellBands().length];
        // exact centers first: the LTE carriers other cells list in SIB5, and cells already heard here
        const exact = [...(s?.cells ?? []).flatMap(c => (c.neighbors?.inter ?? []).filter(f => f.mhz !== null).map(f => Math.round(f.mhz! * 1e6))), ...(s?.cells ?? []).map(c => c.hz)];
        sc.cands = scanCandidates(b.lo, b.hi, sc.profile ? findCarriers(sc.profile) : [], exact);
        if (!sc.cands.length) { if (cellUi.band === 'AUTO') cellNextBand(); else cellSurvey(); }
        else { sc.ci = -1; cellNextCandidate(); }
      }
    }
  } else if (sc.phase === 'visit') {
    // a cell found up to 300 kHz off the tuned center counts: retune to its own center and read it there
    const near = here?.cells.find(c => Math.abs(c.hz - state.freq) <= 300_000 && c.mib && now - c.mibMs < 3000);
    if (near && near.hz !== state.freq) cellGo(near.hz, 2500);
    else if (near) {
      // a 20 MHz carrier: the HackRF goes to 20 MS/s for its SIBs (the cell is read again at the new rate)
      if (cellRateFor(near.hz) !== state.rate) { setRate(cellRateFor(near.hz)); sc.tunedMs = now; }
      sc.phase = 'dwell'; sc.until = now + (cellRtl() ? 2500 : 13_000);
    }
    else if (now >= sc.until && (here || now - sc.tunedMs > 4000)) cellNextCandidate();
  } else if (sc.phase === 'dwell') {
    const cells = here?.cells.filter(c => c.hz === state.freq && now - c.lastMs < 15_000) ?? [];
    const done = cells.length > 0 && cells.every(c => c.complete || !c.fullBand);
    if (done && now < sc.until - 11_000) sc.until = now + 1500;
    if (now >= sc.until) cellNextCandidate();
  }
  cellUi.scanTimer = window.setTimeout(cellTick, 300);
}
function cellSetBand(b: string): void {
  cellUi.band = b; const sc = cellUi.scan; sc.bandIdx = 0; sc.stayHz = 0; cellSurvey(); cellTick();
}
function cellStay(hz: number): void {
  const sc = cellUi.scan;
  if (sc.phase === 'stay' && sc.stayHz === hz) { sc.stayHz = 0; cellSurvey(); cellTick(); return; }
  sc.phase = 'stay'; sc.stayHz = hz; clearTimeout(cellUi.scanTimer); cellGo(hz, 0);
}

function renderCell(view: HTMLElement): void {
  const wide = CELL_WIDE.matches;
  if (wide && cellUi.view === 'alerts') cellUi.view = 'cells';
  view.classList.toggle('clwide', wide);
  cellUi.html.clear();
  const tabs = (wide ? ['cells', 'neighbors', 'log'] : ['alerts', 'cells', 'neighbors', 'log']) as CellView[];
  view.innerHTML = `
    <section class="${visCls('cell')}">${readoutHtml()}${wide ? '<div id="cl-alertbox" class="cl-alertbox"><div class="cl-boxh"><b>MESSAGES</b><small id="cl-alertcount"></small></div><div id="cl-amapbox" class="cl-amapbox"><div id="cl-amap" class="panel map"></div><div id="cl-amapcap" class="cl-amapcap"></div></div><div id="cl-alerts" class="cl-alerts"></div></div>' : ''}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="cl-head" class="cl-head"></div>
      <div class="ctlrow">${segHtml([['AUTO', 'AUTO'], ...CELL_BANDS.map(b => [b.id, b.label])].map(([k, l]) => `<button data-clband="${k}">${l}</button>`))}</div>
      <div class="ctlrow">${segHtml(tabs.map(v => `<button data-clview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('cell')}<button id="cl-export" class="ib" title="export the log (CSV) and every decoded field (JSON)" aria-label="export"><svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zm7-18-5.5 5.5 1.4 1.4L11 5.8V16h2V5.8l3.1 3.1 1.4-1.4L12 2z"/></svg></button></div>
      ${wide ? '<div id="cl-detail" class="mt-detail cl-detail cl-dock" hidden></div>' : ''}
      <div id="cl-stage" class="mt-stage cl-stage">${wide ? '' : '<div id="cl-awrap" class="cl-awrap"><div id="cl-amapbox" class="cl-amapbox"><div id="cl-amap" class="panel map"></div><div id="cl-amapcap" class="cl-amapcap"></div></div><div id="cl-alerts" class="cl-alerts"></div></div>'}<div id="cl-cards" class="cl-cards"></div><div id="cl-nbrs" class="cl-nbrs"></div>${wide ? '' : '<div id="cl-detail" class="mt-detail cl-detail" hidden></div>'}</div>
      <div id="cl-log">${logHtml('cell', 'watching for LTE cells…')}</div>
      <div class="note about">LTE cells and their emergency alerts, receive only. Cell reads what every LTE cell broadcasts to all phones: the MIB, SIB1 (operator, cell and tracking area IDs, band, SI schedule) and the other SIBs (access, reselection, intra and inter-frequency neighbors, NR neighbors from SIB24, CDMA2000 time from SIB8), and the warning messages: CMAS / Wireless Emergency Alerts in SIB12 and ETWS in SIB10/11, in every language sent. Only system information is decoded; paging and phone traffic are left alone. SIBs and alerts need the whole carrier in the span (15.36 MS/s for a 10 or 15 MHz carrier, 20 MS/s for a 20 MHz one, which the app resamples to the LTE rate), which only a HackRF samples; an RTL-SDR covers about 2.4 MHz, enough for cell search and the MIB from the center 1.08 MHz. Carriers send SIB12 only while an alert is active. A WEA alert area is drawn on the map with your position and whether you are inside it; the area and geo-fencing trigger formats are derived from our own recordings (their defining document is outside the specs this app is built from). Cell positions are not on the air, so cells are not mapped. AUTO sweeps the US LTE downlink bands (B12/17, B13, B14, B5/26, B2/25, B4/66, B41), visits each carrier and stays for its whole SI cycle. MESSAGES lists every MIB and SIB as one plain line, newest first: a repeat only counts up, a changed value gets its own row, and warnings (SIB10/11/12) are red and stay pinned on top with their full text until you clear them. Tap a row or a cell for every decoded field. Paging is not decoded.</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-clband]', view).forEach(b => b.onclick = () => cellSetBand(b.dataset.clband!));
  qa<HTMLButtonElement>('[data-clview]', view).forEach(b => b.onclick = () => { cellUi.view = b.dataset.clview as CellView; refreshCell(true); });
  $('cl-export').onclick = () => worker?.postMessage({ type: 'cell', cmd: 'export' });
  const pick = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-clsel],[data-cldo],[data-clfeed],[data-clfilter]');
    if (!t) return;
    const doIt = t.dataset.cldo;
    if (doIt === 'close') { cellUi.sel = ''; cellUi.detail = null; }
    else if (doIt === 'stay') cellStay(Number(t.dataset.hz));
    else if (doIt === 'clearalerts') {
      if (Date.now() - cellUi.clearArm < 4000) { cellUi.clearArm = 0; worker?.postMessage({ type: 'cell', cmd: 'clearAlerts' }); cellUi.seenAlerts.clear(); }
      else cellUi.clearArm = Date.now();
    } else if (doIt === 'alerts') { cellUi.view = 'alerts'; cellUi.banner = ''; }
    else if (t.dataset.clfilter) cellUi.feedFilter = t.dataset.clfilter as typeof cellUi.feedFilter;
    else if (t.dataset.clfeed) { const [key, name] = t.dataset.clfeed.split('|'); if (cellUi.sel !== key) cellPick(key); cellUi.openSib = name.toLowerCase(); cellUi.html.set('open:' + name.toLowerCase(), '1'); }
    else if (t.dataset.clsel?.startsWith('alert:')) { cellUi.alertSel = t.dataset.clsel.slice(6); cellUi.mapSig = ''; }
    else if (t.dataset.clsel) cellPick(t.dataset.clsel);
    else return;
    refreshCell(true);
  };
  for (const id of ['cl-cards', 'cl-detail', 'cl-alerts', 'cl-nbrs', 'cl-head']) $(id).onclick = pick;
  // a redraw between press and release would swap the element under the pointer and lose the tap
  const hold = () => { cellUi.hold = true; };
  const release = () => { if (!cellUi.hold) return; setTimeout(() => { cellUi.hold = false; refreshCell(true); }, 0); };
  for (const id of ['cl-cards', 'cl-detail', 'cl-alerts', 'cl-nbrs', 'cl-head']) $(id).onpointerdown = hold;
  cellUi.mapSig = '';
  geo = new GeoMap($('cl-amap'), { home: state.home, start: mapStart(state.home), onPick: () => undefined, log });
  if (!cellUi.wired) { cellUi.wired = true; window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); }
  clearInterval(cellUi.timer);
  cellUi.timer = window.setInterval(() => { if (state.app !== 'cell') { clearInterval(cellUi.timer); clearTimeout(cellUi.scanTimer); return; } refreshCell(); }, 500);
  refreshList('cell');
  refreshCell(true);
}
function cellPick(key: string): void {
  cellUi.sel = cellUi.sel === key ? '' : key;
  cellUi.detail = null;
  if (cellUi.sel) { cellUi.detailAsked = Date.now(); worker?.postMessage({ type: 'cell', cmd: 'detail', key }); }
}
const clPill = (text: string, tone: '' | 'ok' | 'red' | 'acc' = '') => `<span class="tr-pill ${tone}">${esc(text)}</span>`;
function cellLabel(c: CellRow, pci = true): string {
  const op = c.summary?.plmns.find(p => p.name)?.name ?? c.summary?.plmns[0]?.id ?? '';
  return `${op ? op + ' · ' : ''}${cellMhz(c.hz)} MHz${pci ? ` · PCI ${c.pci}` : ''}`;
}
function cellHead(s: CellSnap | null, now: number): string {
  const sc = cellUi.scan, [cap, tone] = cellCapability(), band = cellBandAt(state.freq);
  const cells = s?.cells ?? [], carriers = new Set(cells.map(c => Math.round(c.hz / 1e5))).size, alerts = s ? groupAlerts(s.alerts).length : 0;
  const sibs = cells.reduce((n, c) => n + c.sibs.length + (c.summary ? 1 : 0), 0);
  const status = sc.phase === 'stay' ? `STAYING · ${cellMhz(sc.stayHz)} MHz` : sc.phase === 'survey' ? `${cellUi.band === 'AUTO' ? 'AUTO · ' : ''}SWEEP ${Math.min(sc.wi + 1, sc.windows.length)}/${sc.windows.length}`
    : `${cellUi.band === 'AUTO' ? 'AUTO · ' : ''}CARRIER ${sc.ci + 1}/${sc.cands.length} · ${sc.phase === 'dwell' ? 'READING' : 'LOOKING'} ${Math.max(0, Math.ceil((sc.until - now) / 1000))} s`;
  const here = cells.filter(c => c.hz === state.freq && now - c.lastMs < 10_000);
  const tile = (n: number | string, l: string, cls = '') => `<span class="${cls}"><b>${n}</b><small>${l}</small></span>`;
  const banner = cellUi.banner && cellUi.view !== 'alerts' && !CELL_WIDE.matches ? `<button class="cl-banner" data-cldo="alerts">${esc(cellUi.banner)} · VIEW</button>` : '';
  return banner + `<div class="cl-watch"><b>${band ? esc(band.label) + ' · ' : ''}${cellMhz(state.freq)} MHz</b><small>${here.length ? here.map(c => `PCI ${c.pci}`).join(' · ') : s?.lte ? 'LTE heard, reading the MIB' : 'no LTE cell on this center'}${s?.cpuMs ? ` · ${s.cpuMs} ms per block` : ''}</small><em class="${sc.phase === 'dwell' || sc.phase === 'stay' ? 'on' : ''}">${status}</em></div>`
    + `<div class="cl-cap ${tone}">${esc(cap)}</div>`
    + `<div class="cl-count">${tile(alerts, 'ALERTS', alerts ? 'al' : '')}${tile(cells.length, 'CELLS')}${tile(carriers, 'CARRIERS')}${tile(sibs, 'SIBS')}${tile(s?.tbOk ?? 0, 'BLOCKS')}</div>`;
}
function cellAlertHtml(g: AlertGroup, s: CellSnap, now: number): string {
  const col = CELL_RANK_COLOR[Math.max(0, Math.min(5, g.rank))], fresh = now - g.lastMs < 600_000;
  const cellRows = g.cells.map(k => s.cells.find(c => c.key === k)).filter((c): c is CellRow => !!c);
  const msgs = g.messages.map(m => {
    const lang = m.language ? m.language.toUpperCase() : m.source === 'SIB10' ? 'WARNING TYPE' : m.alphabet === '8bit' ? 'DATA' : 'TEXT';
    const body = m.complete ? (m.text ? `<p>${esc(m.text)}</p>` : m.binaryHex ? `<p class="cl-hex">${esc(m.binaryHex)}</p><small>binary content; its layout is defined outside the 3GPP specs this app is built from (ATIS-0700041): shown as received</small>` : m.warningType ? `<p>${esc(m.warningType.type.toUpperCase())}${m.warningType.userAlert ? ' · USER ALERT' : ''}${m.warningType.popup ? ' · POPUP' : ''}</p>` : '') : `<p class="cl-dimtxt">segments ${m.segments.join(', ')} of ${m.lastSegment >= 0 ? m.lastSegment + 1 : '?'} received, waiting for the rest</p>`;
    const meta = [`ID ${m.id} (0x${m.id.toString(16).toUpperCase()})`, `SERIAL 0x${m.serial.toString(16).toUpperCase().padStart(4, '0')}`, m.scope, `CODE ${m.messageCode}`, `UPDATE ${m.updateNumber}`, m.dcs >= 0 ? `DCS 0x${m.dcs.toString(16).toUpperCase().padStart(2, '0')}` : '', m.pages ? `${m.pages} PAGE${m.pages === 1 ? '' : 'S'}` : '', m.source].filter(Boolean).join(' · ');
    const ar = m.areaHex ? parseWarningArea(m.areaHex) : null;
    const area = m.areaHex ? `<details class="cl-area"><summary>ALERT AREA · ${ar ? `${ar.points.length} POINTS · ${ar.areaKm2.toFixed(1)} KM² · ${ar.closed ? 'CLOSED RING' : 'OPEN RING'} · ` : ''}${m.areaHex.length / 2} OCTETS</summary><code>${esc(m.areaHex)}</code><small>${ar ? `header 0x${ar.header} (meaning not settled), then ${ar.points.length} points of 22-bit latitude and longitude · format derived from recordings` : 'not a polygon this app can read: shown as received'}</small></details>` : '';
    const trig = m.binaryHex && m.id === 4400 ? parseGeoTrigger(m.binaryHex) : null;
    const links = trig ? `<div class="cl-links"><small>APPLIES TO · header 0x${trig.header} · derived from recordings</small>${trig.pairs.map(p => { const t = s.alerts.find(x => x.id === p.id && x.serial === p.serial); return `<span>${p.id} / 0x${p.serial.toString(16).toUpperCase().padStart(4, '0')}${t ? ` · ${esc(t.language ?? t.cls)}` : ' · not heard'}</span>`; }).join('')}</div>` : '';
    return `<div class="cl-msg"><em>${esc(lang)}${m.additionalLanguage ? ' · ADDITIONAL LANGUAGE' : ''}</em>${body}${links}<small>${esc(meta)}</small>${area}</div>`;
  }).join('');
  const first = g.messages[0], area = groupArea(g), sel = cellUi.alertSel === g.key;
  return `<div class="pcard alert cl-alert ${fresh ? 'fresh' : ''} ${sel && area ? 'sel' : ''}" style="--al:${col}" ${area ? `data-clsel="alert:${esc(g.key)}"` : ''}>`
    + `<div class="pc-h"><span class="pc-b">⚠ ${esc(g.cls.toUpperCase())}</span><span class="pc-t">${esc(new Date(g.lastMs).toTimeString().slice(0, 8))}</span><span class="pc-r">${esc(first.category)}</span>${area ? areaThumb(area) : ''}</div>`
    + (area ? `<div class="cl-where ${whereOf(area)[1]}">${esc(whereOf(area)[0])}</div>` : '')
    + `<div class="cl-when">${esc(cellTime(g.firstMs))} · ${esc(cellAgo(now - g.lastMs))}${g.lastMs - g.firstMs > 2000 ? ` · heard until ${esc(cellTime(g.lastMs))}` : ''}</div>`
    + msgs
    + `<div class="cl-carried"><small>CARRIED BY</small>${cellRows.length ? cellRows.map(c => `<span data-clsel="${esc(c.key)}">${esc(cellLabel(c))}</span>`).join('') : g.cells.map(k => `<span>${esc(k)}</span>`).join('')}</div></div>`;
}
/** The alert area of a group (the first of its messages that carries one). */
function groupArea(g: AlertGroup): WarningArea | null {
  for (const m of g.messages) if (m.areaHex) { const a = parseWarningArea(m.areaHex); if (a) return a; }
  return null;
}
/** INSIDE / OUTSIDE with the distance to the edge, from your position. */
function whereOf(a: WarningArea): [string, 'in' | 'out' | ''] {
  if (!state.home) return ['YOUR POSITION IS NOT KNOWN · allow location to see whether you are inside this alert area', ''];
  const r = areaRelation([state.home.lat, state.home.lon], a), d = r.edgeM < 1000 ? `${Math.round(r.edgeM)} m` : `${(r.edgeM / 1000).toFixed(r.edgeM < 10_000 ? 1 : 0)} km`;
  return r.inside ? [`INSIDE THE ALERT AREA · ${d} from its edge`, 'in'] : [`OUTSIDE THE ALERT AREA · ${d} from its edge`, 'out'];
}
function areaThumb(a: WarningArea): string {
  const [s, w, n, e] = a.bounds, k = Math.cos((s + n) / 2 * Math.PI / 180), sx = (e - w) * k || 1e-6, sy = (n - s) || 1e-6, sc = 52 / Math.max(sx, sy);
  const pts = a.points.map(([la, lo]) => `${(6 + ((lo - w) * k) * sc + (52 - sx * sc) / 2).toFixed(1)},${(6 + (n - la) * sc + (52 - sy * sc) / 2).toFixed(1)}`).join(' ');
  return `<svg class="cl-thumb" viewBox="0 0 64 64" aria-label="alert area outline"><polygon points="${pts}"/></svg>`;
}
/** The selected alert's area on the map, with your position, framed once per change. */
function cellAlertMap(s: CellSnap | null): void {
  const box = q('#cl-amapbox'), cap = q('#cl-amapcap'); if (!box || !cap) return;
  const groups = s ? groupAlerts(s.alerts) : [], withArea = groups.filter(g => groupArea(g));
  if (!withArea.some(g => g.key === cellUi.alertSel)) cellUi.alertSel = withArea[0]?.key ?? '';
  const g = withArea.find(x => x.key === cellUi.alertSel), a = g ? groupArea(g) : null;
  box.hidden = !a;
  if (!g || !a) { cellUi.mapSig = ''; return; }
  const sig = `${g.key}|${state.home?.lat ?? ''}|${state.home?.lon ?? ''}`;
  const [where, tone] = whereOf(a);
  cap.innerHTML = `<b style="color:${CELL_RANK_COLOR[Math.max(0, Math.min(5, g.rank))]}">${esc(g.cls.toUpperCase())}</b><span class="cl-where ${tone}">${esc(where)}</span><small>${a.points.length} points · ${a.areaKm2.toFixed(1)} km² · area format derived from recordings</small>`;
  if (sig === cellUi.mapSig) return;
  cellUi.mapSig = sig;
  geo?.setHome(state.home);
  geo?.setShapes([{ id: g.key, pts: a.points, line: false, color: CELL_RANK_COLOR[Math.max(0, Math.min(5, g.rank))], sel: true, label: g.cls }]);
  const pts: [number, number][] = [...a.points];
  if (state.home) { const r = areaRelation([state.home.lat, state.home.lon], a); if (r.edgeM < 150_000) pts.push([state.home.lat, state.home.lon]); }
  requestAnimationFrame(() => geo?.fitTo(pts));
}
/** One feed row in the Pagers app's card style: warnings are its red call-out cards, changes amber, the rest blue. */
function cellFeedRow(r: CellFeedRow, s: CellSnap, now: number): string {
  const c = s.cells.find(x => x.key === r.cell), band = r.band ? `B${r.band} ` : '';
  const where = `${r.op ? r.op + ' · ' : ''}${band}${cellMhz(r.hz)} · PCI ${r.pci}`;
  const kind = r.alert ? 'alert' : r.change ? 'num' : 'alpha';
  const t = new Date(r.lastMs).toTimeString().slice(0, 8);
  return `<div class="pcard ${kind} cl-frow" data-clfeed="${esc(r.cell)}|${esc(r.name)}"><div class="pc-h"><span class="pc-b">${r.alert ? '⚠ ' : ''}${esc(r.name)}</span><span class="pc-t">${t}</span>${r.count > 1 ? `<span class="pc-x">×${r.count}</span>` : ''}${r.change ? '<span class="pill a2">CHANGED</span>' : ''}<span class="pc-r">${esc(where)}</span></div>`
    + `<div class="pc-body">${esc(r.text)}</div>${r.count > 1 && now - r.firstMs > 60_000 ? `<div class="cl-fsince">first ${esc(cellTime(r.firstMs))}${c ? '' : ' · cell cleared'}</div>` : ''}</div>`;
}
function cellAlertsHtml(s: CellSnap | null, now: number): string {
  const groups = s ? groupAlerts(s.alerts) : [], feed = s?.feed ?? [];
  if (!groups.length && !feed.length) return emptyState('cell');
  const f = cellUi.feedFilter, rows = feed.filter(r => f === 'all' || (f === 'alerts' ? r.alert : r.change));
  const n = (k: typeof f) => k === 'all' ? feed.length : feed.filter(r => k === 'alerts' ? r.alert : r.change).length;
  const chips = `<div class="seg cl-ffilter">${(['all', 'alerts', 'changes'] as const).map(k => `<button data-clfilter="${k}" class="${k === f ? 'on' : ''} ${k === 'alerts' ? 'red' : ''}">${k.toUpperCase()} ${n(k)}</button>`).join('')}</div>`;
  const pinned = groups.map(g => cellAlertHtml(g, s!, now)).join('') + (groups.length ? `<button class="chip cl-clearalerts" data-cldo="clearalerts">${Date.now() - cellUi.clearArm < 4000 ? 'TAP AGAIN TO CLEAR EVERY ALERT' : 'CLEAR ALERTS'}</button>` : '');
  const list = rows.length ? rows.map(r => cellFeedRow(r, s!, now)).join('') : `<div class="empty">${f === 'alerts' ? 'no warning messages heard: carriers send SIB10/11/12 only while an alert is active' : f === 'changes' ? 'no message has changed since it was first heard' : 'every MIB and SIB lands here as it is decoded'}</div>`;
  return pinned + chips + list;
}
function cellCard(c: CellRow, now: number): string {
  const live = now - c.lastMs < 10_000, sel = cellUi.sel === c.key, sm = c.summary;
  const band = c.band ? `B${c.band}${c.tdd ? ' TDD' : ''}` : '';
  const ops = sm ? sm.plmns.map(p => p.name ? `${p.name} ${p.id}` : p.id).join(' · ') : '';
  const kv = (k: string, v: string | number) => `<span>${k} <b>${esc(String(v))}</b></span>`;
  const bw = c.nrb ? `${({ 6: 1.4, 15: 3, 25: 5, 50: 10, 75: 15, 100: 20 } as Record<number, number>)[c.nrb]} MHz` : '-';
  const want = new Set((sm?.schedule ?? []).flatMap(t => t.sibs.map(x => x.replace('sibType', 'sib'))));
  const got = new Set(c.sibs.map(x => x.name.replace(/-v\d+$/, '').replace(/-r\d+$/, '')));
  const chips = sm ? ['sib1', ...[...want].map(x => x.replace(/-v\d+$/, '').replace(/-r\d+$/, ''))].map(n => `<span class="${n === 'sib1' || got.has(n) ? 'on' : ''} ${/^sib1[012]$/.test(n) ? 'warn' : ''}">${n.toUpperCase()}</span>`).join('') : '';
  const flags = [sm?.warning.sib12 ? clPill('WEA SCHEDULED', 'red') : '', sm?.warning.sib10 || sm?.warning.sib11 ? clPill('ETWS SCHEDULED', 'red') : '', c.alerts ? clPill(`${c.alerts} ALERT${c.alerts === 1 ? '' : 'S'}`, 'red') : '',
    sm?.barred === 'barred' ? clPill('BARRED') : '', !c.fullBand && !sm && c.mib ? clPill(c.nrb > (cellUi.snap?.maxRb ?? 0) ? 'MIB ONLY · CARRIER WIDER THAN THE SPAN' : 'MIB ONLY') : ''].join('');
  return `<div class="cl-card ${sel ? 'sel' : ''} ${live ? '' : 'dim'}" data-clsel="${esc(c.key)}">`
    + `<div class="cl-ch"><span class="cl-band">${esc(band || 'LTE')}</span><span class="cl-ct"><b>${esc(ops || 'operator not read yet')}</b><small>${cellMhz(c.hz)} MHz${c.earfcn !== null ? ` · EARFCN ${c.earfcn}` : ''} · ${bw}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${live ? 'LIVE' : esc(cellAgo(now - c.lastMs))}</span></div>`
    + `<div class="cl-kv">${kv('PCI', c.pci)}${sm ? kv('CELL', `${sm.enbId}/${sm.cellId}`) + kv('TAC', sm.tac) : ''}${kv('SNR', `${c.snrDb.toFixed(0)} dB`)}${kv('PORTS', c.ports || '-')}${kv('SFN', c.sfn >= 0 ? c.sfn : '-')}</div>`
    + (chips ? `<div class="cl-sibs">${chips}</div>` : '')
    + (flags ? `<div class="cl-flags">${flags}</div>` : '') + '</div>';
}
function cellNbrsHtml(s: CellSnap, now: number): string {
  const rows = s.cells.filter(c => c.neighbors && (c.neighbors.intra.length || c.neighbors.inter.length || c.neighbors.nr.length || c.neighbors.utra.length || c.neighbors.geran.length || c.neighbors.cdma.length));
  if (!rows.length) return '<div class="empty">neighbor lists arrive in SIB4 (same frequency), SIB5 (other LTE carriers), SIB24 (5G NR) and SIB6/7/8 (older networks) · they need the whole carrier in the span</div>';
  const heard = (mhz: number | null, pci: number) => mhz !== null && s.cells.some(c => Math.abs(c.hz / 1e6 - mhz) < 0.06 && c.pci === pci);
  return rows.map(c => {
    const n = c.neighbors!, mhz = c.hz / 1e6;
    const intra = n.intra.length ? `<div class="cl-nb"><small>SAME FREQUENCY · SIB4</small>${n.intra.map(r => `<span class="${heard(mhz, r.pci) ? 'heard' : ''}">${r.pci}${r.offset && r.offset !== 'dB0' ? `<i>${esc(r.offset)}</i>` : ''}</span>`).join('')}</div>` : '';
    const excl = n.intraExcluded.length ? `<div class="cl-nb"><small>EXCLUDED</small>${n.intraExcluded.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : '';
    const inter = n.inter.length ? `<table class="cl-tab"><tr><th>LTE CARRIER · SIB5</th><th>BAND</th><th>MHz</th><th>PRIO</th><th>CELLS</th></tr>${n.inter.map(f => `<tr><td>${f.earfcn}</td><td>${f.band ?? '-'}${f.bands.length > 1 ? ` (${f.bands.slice(1).join(', ')})` : ''}</td><td>${f.mhz ?? '-'}</td><td>${f.priority ?? '-'}</td><td class="cl-wrap">${f.cells.map(r => `<span class="cl-pci ${heard(f.mhz, r.pci) ? 'heard' : ''}">${r.pci}</span>`).join(' ') || '-'}</td></tr>`).join('')}</table>` : '';
    const nr = n.nr.length ? `<table class="cl-tab"><tr><th>NR CARRIER · SIB24</th><th>MHz</th><th>BAND</th><th>SCS</th><th>PRIO</th></tr>${n.nr.map(f => `<tr><td>${f.arfcn}</td><td>${f.mhz}</td><td>${f.bands.map(b => 'n' + b).join(', ') || '-'}</td><td>${esc(f.scs.replace('kHz', ''))} kHz</td><td>${f.priority ?? '-'}</td></tr>`).join('')}</table>` : '';
    const old = [...n.utra.map(u => `UTRA ${u.kind} ${u.uarfcn}${u.priority !== null ? ` · prio ${u.priority}` : ''}`), ...n.geran.map(g => `GERAN ${g.band} ${g.arfcns.join(', ')}`), ...n.cdma.map(x => `CDMA2000 ${x.bandClass} ch ${x.arfcn}${x.pns.length ? ` · PN ${x.pns.join(', ')}` : ''}`)];
    const oldHtml = old.length ? `<div class="cl-nb"><small>OTHER NETWORKS</small>${old.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : '';
    const live = now - c.lastMs < 10_000;
    return `<div class="cl-nbr ${live ? '' : 'dim'}"><div class="cl-nh" data-clsel="${esc(c.key)}"><b>${esc(cellLabel(c))}</b><small>${n.intra.length} same-frequency · ${n.inter.length} LTE carriers · ${n.nr.length} NR carriers</small></div>${intra}${excl}${inter}${nr}${oldHtml}</div>`;
  }).join('') + '<div class="cl-dim">a highlighted cell is one this app has heard itself</div>';
}
function cellDetailHtml(s: CellSnap, now: number): string {
  const c = s.cells.find(x => x.key === cellUi.sel); if (!c) return '';
  const d = cellUi.detail?.key === c.key ? cellUi.detail : null, sm = c.summary, m = c.mib;
  const fields = (f: [string, string][]) => `<div class="mt-fields">${f.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
  const sect = (t: string, body: string) => `<div class="cl-sect"><small>${esc(t)}</small>${body}</div>`;
  const stay = cellUi.scan.phase === 'stay' && cellUi.scan.stayHz === c.hz;
  let html = `<div class="cl-dh"><b>PCI ${c.pci}</b><span>${esc(cellLabel(c, false))}</span><button class="chip ${stay ? 'on' : ''}" data-cldo="stay" data-hz="${c.hz}">${stay ? 'SCAN AGAIN' : 'STAY HERE'}</button><button class="chip" data-cldo="close">✕</button></div>`;
  html += sect('CELL', fields([['FREQUENCY', `${cellMhz(c.hz)} MHz${c.earfcn !== null ? ` · EARFCN ${c.earfcn}` : ''}${c.band ? ` · band ${c.band}` : ''}`], ['PCI', `${c.pci} (group ${Math.floor(c.pci / 3)}, sector ${c.pci % 3})`],
    ['SIGNAL', `SNR ${c.snrDb.toFixed(1)} dB · RS ${c.levelDb.toFixed(1)} dBFS · CFO ${c.cfoHz} Hz`], ['HEARD', `MIB ${c.mibCount} · SIB1 ${c.sib1Count} · SI DCI ${c.dciCount} · blocks ${c.tbOk} ok, ${c.tbFail} failed`],
    ['FIRST HEARD', cellTime(c.firstMs)], ['LAST HEARD', `${cellTime(c.lastMs)} · ${cellAgo(now - c.lastMs)}`]]));
  if (m) html += sect('MIB', fields([['BANDWIDTH', `n${m.bandwidth} (${m.bandwidth} RBs)`], ['PHICH', `${m.phichDuration} · Ng ${m.phichResource}`], ['CRS PORTS', `${m.ports} (from the CRC mask)`], ['SFN', `${m.sfn}`],
    ['SIB1-BR (LTE-M)', m.sib1BR ? `scheduled, index ${m.sib1BR}` : 'not scheduled'], ['RAW', m.bits]]));
  if (!c.fullBand && !sm) html += `<div class="cl-dim">${c.nrb > (s.maxRb || 0) ? `this carrier (${c.nrb} RBs) is wider than the span this radio samples (${s.maxRb} RBs): cell search and MIB only` : 'SIB1 and the SI messages come next'}</div>`;
  if (sm) {
    html += sect('SIB1', fields([['OPERATOR', sm.plmns.map(p => `${p.id}${p.name ? ` ${p.name}` : ''}`).join(' · ')], ['TRACKING AREA', `${sm.tac} (0x${sm.tac.toString(16).toUpperCase()})`],
      ['CELL IDENTITY', `0x${sm.cellIdentity.toString(16).toUpperCase().padStart(7, '0')} · eNB ${sm.enbId} · cell ${sm.cellId}`], ['ACCESS', `${sm.barred} · intra-frequency reselection ${sm.intraFreqReselection}`],
      ['BANDS', sm.bands.join(', ')], ['SELECTION', `q-RxLevMin ${sm.qRxLevMinDbm ?? '-'} dBm${sm.qQualMinDb !== null ? ` · q-QualMin ${sm.qQualMinDb} dB` : ''}${sm.pMax !== null ? ` · p-Max ${sm.pMax} dBm` : ''}`],
      ['SI', `window ${sm.siWindowMs} ms · value tag ${sm.valueTag}${sm.hyperSfn !== null ? ` · hyper SFN ${sm.hyperSfn}` : ''}`], ['FEATURES', [sm.imsEmergency ? 'IMS emergency' : '', sm.edrx ? 'eDRX' : '', sm.tdd ? `TDD ${sm.tdd}` : ''].filter(Boolean).join(' · ') || '-']]));
    const sched = c.si.map(t => `<tr><td>SI ${t.si}</td><td>${t.periodicity * 10} ms</td><td class="cl-wrap">${esc(t.sibs.map(x => x.replace('sibType', 'SIB')).join(' '))}</td><td>${t.ms ? `${esc(cellAgo(now - t.ms))} · ×${t.count}` : '<span class="cl-dimtxt">not yet</span>'}</td></tr>`).join('');
    html += sect('SI SCHEDULE', `<table class="cl-tab"><tr><th>MESSAGE</th><th>EVERY</th><th>CARRIES</th><th>RECEIVED</th></tr>${sched}</table>`);
  }
  if (c.time) html += sect('TIME · SIB8', fields([['GPS', c.time.gpsIso], ['UTC', `${c.time.utcIso} (18 leap seconds assumed)`]]));
  if (d) {
    const blocks: [string, Record<string, unknown>, string, string][] = [];
    if (d.sib1) blocks.push(['sib1', d.sib1, d.sib1Hex, '']);
    for (const r of [...d.sibs].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) blocks.push([r.name, r.value, r.hex, `SI ${r.si || '?'} · ${cellAgo(now - r.ms)} · ×${r.count}`]);
    for (const [name, value, hex, meta] of blocks) {
      let groups: { name: string; rows: [string, string][] }[] = [];
      try { groups = fieldGroups(name, value); } catch { /* shown raw */ }
      const body = groups.map(g => `<div class="cl-grp"><i>${esc(g.name.toUpperCase())}</i>${g.rows.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`).join('');
      html += `<details class="cl-sib" ${cellUi.html.get('open:' + name) || (cellUi.openSib && name.startsWith(cellUi.openSib)) ? 'open' : ''} data-sib="${esc(name)}"><summary><b>${esc(name.toUpperCase())}</b><small>${esc(meta)}</small></summary>${body}<div class="cl-raw"><small>RAW · ${hex.length / 2} OCTETS</small><code>${esc(hex)}</code></div></details>`;
    }
  } else if (sm || c.sibs.length) html += '<div class="cl-dim">loading every decoded field…</div>';
  return html;
}
function refreshCell(force = false): void {
  if (state.app !== 'cell') return;
  const now = Date.now();
  if (cellUi.hold) return;
  if (!force && now - cellUi.drawn < 240) { clearTimeout(cellUi.pending); cellUi.pending = window.setTimeout(() => refreshCell(true), 250); return; }
  cellUi.drawn = now;
  const s = cellUi.snap, view = cellUi.view, wide = CELL_WIDE.matches;
  const put = (el: HTMLElement | null, key: string, html: string) => { if (!el || cellUi.html.get(key) === html) return; const top = el.scrollTop; el.innerHTML = html; el.scrollTop = top; cellUi.html.set(key, html); };
  put(q('#cl-head'), 'head', cellHead(s, now));
  qa<HTMLButtonElement>('[data-clband]').forEach(b => b.classList.toggle('on', b.dataset.clband === cellUi.band));
  const nAlerts = s ? groupAlerts(s.alerts).length : 0, nb = s ? s.cells.filter(c => c.neighbors && (c.neighbors.intra.length || c.neighbors.inter.length || c.neighbors.nr.length)).length : 0;
  qa<HTMLButtonElement>('[data-clview]').forEach(b => {
    const v = b.dataset.clview as CellView; b.classList.toggle('on', v === view);
    b.textContent = v === 'alerts' ? `MESSAGES${nAlerts ? ` · ${nAlerts} ALERT${nAlerts === 1 ? '' : 'S'}` : ` ${s?.feed?.length ?? 0}`}` : v === 'cells' ? `CELLS ${s?.cells.length ?? 0}` : v === 'neighbors' ? `NEIGHBORS ${nb}` : 'LOG';
  });
  const alerts = q('#cl-alerts'), cards = q('#cl-cards'), nbrs = q('#cl-nbrs'), det = q('#cl-detail'), stage = q('#cl-stage'), logEl = q('#cl-log');
  if (!alerts || !cards || !nbrs || !det || !stage || !logEl) return;
  if (!wide) { const w = q('#cl-awrap'); if (w) w.hidden = view !== 'alerts'; }
  cards.hidden = view !== 'cells'; nbrs.hidden = view !== 'neighbors';
  stage.hidden = view === 'log'; logEl.hidden = view !== 'log';
  const ac = q('#cl-alertcount'); if (ac) ac.textContent = nAlerts ? `${nAlerts} kept until cleared` : '';
  if (!paused.has('cell')) {
    if (wide || view === 'alerts') { put(alerts, 'alerts', cellAlertsHtml(s, now)); cellAlertMap(s); }
    if (view === 'cells') put(cards, 'cards', s && s.cells.length ? s.cells.map(c => cellCard(c, now)).join('') : `<div class="es"><span class="es-g">${glyph('cell', 'currentColor', 44)}</span><b>No cells yet</b><ul><li>AUTO sweeps the LTE downlink bands and stops on each carrier it finds</li><li>A cell appears within a second of its carrier being tuned; SIB1 and the other SIBs follow over a few seconds</li></ul></div>`);
    if (view === 'neighbors') put(nbrs, 'nbrs', s ? cellNbrsHtml(s, now) : '');
  }
  if (cellUi.sel && s) {
    if (!cellUi.detail || now - cellUi.detailAsked > 5000) { cellUi.detailAsked = now; worker?.postMessage({ type: 'cell', cmd: 'detail', key: cellUi.sel }); }
    qa<HTMLDetailsElement>('details.cl-sib', det).forEach(x => cellUi.html.set('open:' + x.dataset.sib, x.open ? '1' : ''));
  }
  const html = s && cellUi.sel ? cellDetailHtml(s, now) : '';
  det.hidden = !html;
  if (html) put(det, 'detail', html); else cellUi.html.delete('detail');
  if (cellUi.openSib && html) {
    const d = qa<HTMLElement>('details.cl-sib', det).find(x => (x.dataset.sib ?? '').startsWith(cellUi.openSib));
    if (d || cellUi.openSib === 'mib') { (d ?? det).scrollIntoView({ block: 'nearest' }); if (d) det.scrollTop = Math.max(0, d.offsetTop - 8); cellUi.openSib = ''; }
  }
  // new alerts: the lamp and a banner until they are looked at
  for (const a of s?.alerts ?? []) if (a.complete && !cellUi.seenAlerts.has(a.key)) { cellUi.seenAlerts.add(a.key); if (now - a.firstMs < 3_600_000) cellUi.banner = `NEW ${a.cls.toUpperCase()}`; }
  if (view === 'alerts' || wide) cellUi.banner = '';
  const recent = (s?.alerts ?? []).some(a => a.complete && now - a.lastMs < 600_000);
  if (recent) setLamp('ALERT', 'red', true);
  else if (s && s.cells.some(c => now - c.lastMs < 10_000)) setLamp(`${s.cells.filter(c => now - c.lastMs < 10_000).length} CELL${s.cells.filter(c => now - c.lastMs < 10_000).length === 1 ? '' : 'S'}`, 'ok');
  else if (s?.lte) setLamp('LTE HEARD', 'amber', true);
  else setLamp(state.connected ? 'SEARCHING' : 'NO RADIO', state.connected ? 'amber' : '', state.connected);
}
function cellExport(csv: string, json: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  download(`cell-log-${stamp}.csv`, csv, 'text/csv');
  setTimeout(() => download(`cell-decoded-${stamp}.json`, json, 'application/json'), 400);
}
function cellSave(st: unknown): void {
  try { localStorage.setItem(CELL_KEY, JSON.stringify(st)); } catch { /* storage full or blocked: kept for this session only */ }
}
// ---- ATSC TV: stations by their pilot, and with a HackRF the channels, the guide and a still of every subchannel --
const ATSC_KEY = 'mm.atsc.v1', ATSC_RATE = 8_000_000;
const ATSC_WIDE = window.matchMedia('(min-width: 1000px)');
ATSC_WIDE.addEventListener('change', () => { if (state.app === 'atsc') { const v = q<HTMLElement>('main#view'); if (v) renderAtsc(v); } });
type AtscView = 'channels' | 'signal' | 'guide' | 'log';
type AtscBand = 'AUTO' | 'VHF' | 'UHF' | 'HOLD';
interface AtscStillRec { url: string; w: number; h: number; dar: number; ms: number; complete: boolean }
interface AtscDetail { key: string; station: AtscStation; program: number; events: AtscEvent[]; raw: { table: string; id: string; hex: string }[]; video: { pid: number; gop: string; pictures: number; iPictures: number }[]; chanText: string }
const atscUi = {
  snap: null as AtscSnap | null, view: 'channels' as AtscView, band: 'AUTO' as AtscBand, sel: '', sigSel: '', detail: null as AtscDetail | null, rawOpen: false,
  stills: new Map<string, AtscStillRec>(), timer: 0, scanTimer: 0, drawn: 0, pending: 0, hold: false, wired: false, restored: false,
  scan: { list: [] as number[], idx: 0, tunedMs: 0, stayCh: 0 },
};
const atscRtl = () => !!radio && radio.kind === 'rtlsdr';
const atscRate = () => atscRtl() ? (radioCan(2_400_000) ? 2_400_000 : 2_048_000) : ATSC_RATE;
/** Where a channel is tuned: its center for a full decode, beside the pilot for a narrow radio (off its DC spike). */
const atscHz = (ch: number) => atscRtl() ? pilotOf(ch) + 400_000 : centerOf(ch);
const atscMhz = (hz: number, d = 0) => (hz / 1e6).toFixed(d);
const atscAgo = (ms: number) => ms < 5_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 172_800_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`;
const atscTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const atscVc = (x: AtscSub) => x.major ? `${x.major}.${x.minor}` : `P${x.program}`;
/** Station time: the device clock corrected by the station's STT when there is one. */
const atscNow = (s: AtscStation | null | undefined) => Date.now() + (s?.stt ? s.stt.diffMs : 0);
function atscCapability(): [string, 'ok' | 'amber' | ''] {
  if (!radio) return ['NO RADIO · a HackRF decodes channels, guide and pictures; an RTL-SDR finds stations by their pilot', ''];
  if (atscRtl()) return ['RTL-SDR · finds stations by their pilot and shows level and offset · it cannot decode them, that needs 8 MS/s across the 6 MHz channel (a HackRF)', 'amber'];
  return ['HACKRF · 8 MS/s · the whole 6 MHz channel, decoded to channels, guide, station time and a picture of every subchannel', 'ok'];
}
function atscChannels(): number[] {
  const all = ATSC_CHANNELS.map(c => c.ch);
  if (atscUi.band === 'VHF') return all.filter(c => c <= 13);
  if (atscUi.band === 'UHF') return all.filter(c => c >= 14);
  return all;
}
function atscOpen(): void {
  const sc = atscUi.scan;
  sc.list = atscChannels(); if (sc.idx >= sc.list.length) sc.idx = 0;
  const ch = atscUi.band === 'HOLD' && sc.stayCh ? sc.stayCh : sc.list[sc.idx];
  configure('NONE', atscHz(ch), atscRate(), 24, 24, false, 'atsc');
  sc.tunedMs = Date.now();
  if (!atscUi.restored) {
    atscUi.restored = true;
    let saved: unknown = null;
    try { saved = JSON.parse(localStorage.getItem(ATSC_KEY) ?? 'null'); } catch { /* storage blocked or bad */ }
    if (saved) worker?.postMessage({ type: 'atsc', cmd: 'restore', state: saved });
    void atscLoadStills();
  }
  atscTick();
}
function atscGo(ch: number): void { const sc = atscUi.scan; sc.tunedMs = Date.now(); tune(atscHz(ch)); refreshAtsc(true); }
/** AUTO: a moment on every channel for its pilot; a station keeps the radio until its channels, a picture of each
 *  subchannel and the guide are in (a minute at most), then the scan moves on. */
function atscTick(): void {
  clearTimeout(atscUi.scanTimer);
  if (state.app !== 'atsc') return;
  const sc = atscUi.scan, s = atscUi.snap, now = Date.now(), e = now - sc.tunedMs;
  if (atscUi.band !== 'HOLD' && sc.list.length) {
    const ch = sc.list[sc.idx % sc.list.length], h = s && s.here && s.here.ch === ch && s.here.since >= sc.tunedMs - 400 ? s.here : null;
    const pilot = !!h && h.pilotOk;
    let next = false;
    // no 8VSB pilot: gone in two seconds; a pilot with no segment sync after a few bursts: gone; a station keeps
    // the radio until its channels, a picture of each and the guide are in (a minute and a half at most)
    if (e > 2_000 && !pilot && !(h && h.sync)) next = true;
    else if (pilot && s?.capability === 'pilot' && e > 3_500) next = true;
    else if (s?.capability === 'decode' && h) {
      const done = h.vct && h.eit && h.stills >= Math.max(1, h.videoSubs);
      if (!h.sync && (h.bursts >= 3 || e > 15_000)) next = true;
      else if (h.sync && ((done && e > 10_000) || e > 90_000 || (e > 45_000 && !h.vct))) next = true;
    }
    if (next) { sc.idx = (sc.idx + 1) % sc.list.length; atscGo(sc.list[sc.idx]); }
  }
  atscUi.scanTimer = window.setTimeout(atscTick, 300);
}
function atscSetBand(b: AtscBand): void {
  const sc = atscUi.scan;
  if (b === 'HOLD') { sc.stayCh = atscUi.snap?.ch || sc.list[sc.idx] || 14; atscUi.band = 'HOLD'; refreshAtsc(true); return; }
  atscUi.band = b; sc.list = atscChannels(); sc.idx = 0; atscGo(sc.list[0]); atscTick();
}
function atscStep(d: number): void {
  const all = ATSC_CHANNELS.map(c => c.ch), cur = atscUi.snap?.ch || atscUi.scan.stayCh || 14;
  const i = Math.max(0, all.indexOf(cur)), ch = all[(i + d + all.length) % all.length];
  atscUi.band = 'HOLD'; atscUi.scan.stayCh = ch; atscGo(ch);
}
function atscHoldOn(ch: number): void { atscUi.band = 'HOLD'; atscUi.scan.stayCh = ch; atscGo(ch); }

// stills: kept as small JPEGs in IndexedDB (one per subchannel), shown from memory
function atscDb(): Promise<IDBDatabase | null> {
  return new Promise(res => {
    try { const r = indexedDB.open('mm-atsc', 1); r.onupgradeneeded = () => r.result.createObjectStore('stills'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); }
  });
}
async function atscLoadStills(): Promise<void> {
  const db = await atscDb(); if (!db) return;
  try {
    const tx = db.transaction('stills', 'readonly'), st = tx.objectStore('stills'), req = st.openCursor();
    req.onsuccess = () => { const c = req.result; if (!c) { refreshAtsc(true); return; } if (!atscUi.stills.has(String(c.key))) atscUi.stills.set(String(c.key), c.value as AtscStillRec); c.continue(); };
  } catch { /* storage blocked */ }
}
async function atscSaveStill(key: string, rec: AtscStillRec): Promise<void> {
  const db = await atscDb(); if (!db) return;
  try { db.transaction('stills', 'readwrite').objectStore('stills').put(rec, key); } catch { /* storage blocked */ }
}
/** A picture with macroblocks never decoded (slices lost to uncorrectable packets) keeps the last still there. */
async function atscOnStill(m: Record<string, unknown>): Promise<void> {
  const w = m.w as number, h = m.h as number, dar = (m.dar as number) || w / h, key = m.key as string;
  const img = new ImageData(new Uint8ClampedArray(m.rgba as ArrayBuffer | Uint8ClampedArray as ArrayBuffer), w, h);
  const prev = atscUi.stills.get(key), have = m.have as Uint8Array | undefined, mbw = m.mbw as number, mbPx = m.mbPx as number;
  let complete = !!m.complete;
  if (!complete && prev && have && mbw && mbPx) {
    const old = await new Promise<HTMLImageElement | null>(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = prev.url; });
    const base = document.createElement('canvas'); base.width = w; base.height = h;
    const bx = base.getContext('2d');
    if (old && bx) {
      bx.drawImage(old, 0, 0, w, h);
      const od = bx.getImageData(0, 0, w, h).data, nd = img.data, rows = have.length / mbw, vpx = h > rows * mbPx ? 2 * mbPx : mbPx;
      for (let k = 0; k < have.length; k++) {
        if (have[k]) continue;
        const x0 = (k % mbw) * mbPx, y0 = Math.floor(k / mbw) * vpx;
        for (let y = y0; y < Math.min(h, y0 + vpx); y++) for (let x = x0; x < Math.min(w, x0 + mbPx); x++) { const o = (y * w + x) * 4; nd[o] = od[o]; nd[o + 1] = od[o + 1]; nd[o + 2] = od[o + 2]; }
      }
      complete = prev.complete;
    }
  }
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  const cx = src.getContext('2d'); if (!cx) return;
  cx.putImageData(img, 0, 0);
  // stored at the display aspect, 480 wide at most
  const ow = Math.min(480, Math.round(Math.max(w, h * dar))), oh = Math.round(ow / dar);
  const out = document.createElement('canvas'); out.width = ow; out.height = oh;
  const ox = out.getContext('2d'); if (!ox) return;
  ox.imageSmoothingQuality = 'high'; ox.drawImage(src, 0, 0, ow, oh);
  const rec: AtscStillRec = { url: out.toDataURL('image/jpeg', 0.82), w: ow, h: oh, dar, ms: Date.now(), complete };
  atscUi.stills.set(key, rec);
  void atscSaveStill(key, rec);
  refreshAtsc();
}
function atscSave(st: unknown): void {
  try { localStorage.setItem(ATSC_KEY, JSON.stringify(st)); }
  catch { try { localStorage.setItem(ATSC_KEY, JSON.stringify({ ...(st as Record<string, unknown>), log: [] })); } catch { /* full */ } }
}
function renderAtsc(view: HTMLElement): void {
  const wide = ATSC_WIDE.matches;
  if (wide && atscUi.view === 'channels') atscUi.view = 'signal';
  view.classList.toggle('atwide', wide);
  const tabs = (wide ? ['signal', 'guide', 'log'] : ['channels', 'signal', 'guide', 'log']) as AtscView[];
  view.innerHTML = `
    <section class="${visCls('atsc')}">${readoutHtml()}${wide ? '<div id="at-wall" class="at-wall"></div>' : ''}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="at-head" class="at-head"></div>
      <div class="ctlrow">${segHtml(([['AUTO', 'AUTO'], ['VHF', 'VHF 2–13'], ['UHF', 'UHF 14–36']] as [AtscBand, string][]).map(([k, l]) => `<button data-atband="${k}">${l}</button>`))}<span class="at-step"><button class="ib" data-atstep="-1" title="previous channel" aria-label="previous channel">◀</button><b id="at-ch">CH</b><button class="ib" data-atstep="1" title="next channel" aria-label="next channel">▶</button></span></div>
      <div class="ctlrow">${segHtml(tabs.map(v => `<button data-atview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('atsc')}<button id="at-export" class="ib" title="export the log (CSV) and the tables (JSON)" aria-label="export"><svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zm7-18-5.5 5.5 1.4 1.4L11 5.8V16h2V5.8l3.1 3.1 1.4-1.4L12 2z"/></svg></button>${pauseClearHtml('atsc')}</div>
      ${wide ? '<div id="at-detail" class="mt-detail at-dock" hidden></div>' : ''}
      <div id="at-stage" class="mt-stage at-stage">${wide ? '' : '<div id="at-wall" class="at-wall"></div>'}<div id="at-signal" class="at-signal"></div><div id="at-guide" class="at-guide"></div>${wide ? '' : '<div id="at-detail" class="mt-detail" hidden></div>'}</div>
      <div id="at-log"><div class="countrow"><span id="count-atsc" class="count">0 DECODED</span></div>${listHtml('atsc', 'looking for stations…')}</div>
      <div class="note about">Over-the-air digital TV (ATSC 1.0), receive only. Stations are found by their pilot, 309 kHz above the bottom of each 6 MHz channel. With a HackRF the whole channel is sampled at 8 MS/s and decoded in bursts through the 8VSB equalizer and trellis decoder, Reed-Solomon, the transport stream and PSIP (the channel list, the program guide, the station clock), with a picture from each subchannel's MPEG-2 video. The CPU decodes what it can and skips the rest. The tables and pictures repeat, so every view still fills in, and the share decoded is shown. AUTO steps through VHF 2–13 and UHF 14–36 and stays on each station until its channels, pictures and guide are in. Everything heard is kept. Tap a subchannel for its guide, its streams and the raw tables.</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-atband]', view).forEach(b => b.onclick = () => atscSetBand(b.dataset.atband as AtscBand));
  qa<HTMLButtonElement>('[data-atstep]', view).forEach(b => b.onclick = () => atscStep(Number(b.dataset.atstep)));
  qa<HTMLButtonElement>('[data-atview]', view).forEach(b => b.onclick = () => { atscUi.view = b.dataset.atview as AtscView; refreshAtsc(true); });
  $('at-export').onclick = () => worker?.postMessage({ type: 'atsc', cmd: 'export' });
  const pick = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-atsel],[data-atsig],[data-atdo]'); if (!t) return;
    if (t.dataset.atsig) { atscUi.sigSel = t.dataset.atsig; refreshAtsc(true); return; }
    const d = t.dataset.atdo;
    if (d === 'close') { atscUi.sel = ''; atscUi.detail = null; refreshAtsc(true); return; }
    if (d === 'raw') { atscUi.rawOpen = !atscUi.rawOpen; refreshAtsc(true); return; }
    if (d?.startsWith('hold:')) { atscHoldOn(Number(d.slice(5))); return; }
    if (d?.startsWith('signal:')) { atscUi.sigSel = d.slice(7); atscUi.view = 'signal'; refreshAtsc(true); return; }
    if (t.dataset.atsel) atscPick(t.dataset.atsel);
  };
  for (const id of ['at-wall', 'at-signal', 'at-guide', 'at-detail', 'at-head']) { const el = q(`#${id}`); if (el) el.onclick = pick; }
  // A redraw between press and release would swap the element under the pointer and lose the click.
  const hold = () => { atscUi.hold = true; };
  const release = () => { if (!atscUi.hold) return; setTimeout(() => { atscUi.hold = false; refreshAtsc(true); }, 0); };
  for (const id of ['at-wall', 'at-signal', 'at-guide', 'at-detail']) { const el = q(`#${id}`); if (el) el.onpointerdown = hold; }
  if (!atscUi.wired) { atscUi.wired = true; window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); }
  clearInterval(atscUi.timer);
  atscUi.timer = window.setInterval(() => { if (state.app !== 'atsc') { clearInterval(atscUi.timer); clearTimeout(atscUi.scanTimer); return; } refreshAtsc(); }, 500);
  refreshList('atsc');
  refreshAtsc(true);
}
function atscPick(key: string): void {
  atscUi.sel = atscUi.sel === key ? '' : key; atscUi.detail = null; atscUi.rawOpen = false;
  if (atscUi.sel) worker?.postMessage({ type: 'atsc', cmd: 'detail', key });
  refreshAtsc(true);
}
function atscHead(s: AtscSnap | null): string {
  const [cap, tone] = atscCapability(), sc = atscUi.scan, now = Date.now();
  const ch = s?.ch || (atscUi.band === 'HOLD' ? sc.stayCh : sc.list[sc.idx]) || 0, h = s?.here && s.here.ch === ch ? s.here : null;
  const status = atscUi.band === 'HOLD' ? `HOLDING CH ${ch}` : `${atscUi.band === 'AUTO' ? 'AUTO' : atscUi.band} · CH ${ch} · ${sc.idx + 1}/${sc.list.length} · ${h && (h.pilotOk || h.sync) ? 'READING' : 'LOOKING'} ${Math.floor((now - sc.tunedMs) / 1000)} s`;
  const subs = s ? s.stations.reduce((n, x) => n + x.subs.length, 0) : 0, onAir = s ? s.stations.reduce((n, x) => n + x.subs.filter(y => y.now).length, 0) : 0;
  const pics = s ? s.stations.reduce((n, x) => n + x.subs.filter(y => atscUi.stills.has(y.key)).length, 0) : 0;
  const tile = (n: number | string, l: string) => `<span><b>${n}</b><small>${l}</small></span>`;
  const dec = s && s.capability === 'decode' ? `${s.decodedPct.toFixed(0)}%` : '-';
  return `<div class="at-cap ${tone}">${esc(cap)}</div>`
    + `<div class="at-watch"><b>CH ${ch}${ch ? ` · ${atscMhz(centerOf(ch))} MHz` : ''}</b><small>${h && h.pilotOk ? `${h.tsid >= 0 ? `TSID 0x${h.tsid.toString(16).toUpperCase().padStart(4, '0')} · ` : ''}pilot +${h.pilotDb.toFixed(0)} dB · channel +${h.topDb.toFixed(0)} dB over the floor${h.sync ? ' · segment sync' : ''}${Number.isFinite(h.snrDb) ? ` · SNR ${h.snrDb.toFixed(1)} dB` : ''}` : h && Number.isFinite(h.topDb) ? `no 8VSB pilot · channel +${h.topDb.toFixed(0)} dB over the floor` : 'no 8VSB pilot yet'}${s && s.capability === 'decode' ? ` · ${s.workers || 1} decoder${(s.workers || 1) === 1 ? '' : 's'}` : ''}</small><em class="${h && (h.pilotOk || h.sync) ? 'on' : ''}">${esc(status)}</em></div>`
    + `<div class="at-count">${tile(s?.stations.length ?? 0, 'STATIONS')}${tile(subs, 'CHANNELS')}${tile(onAir, 'ON NOW')}${tile(pics, 'PICTURES')}${tile(dec, 'DECODED')}</div>`;
}
function atscStillHtml(x: AtscSub, live: boolean): string {
  const r = atscUi.stills.get(x.key);
  const vid = x.streams.find(y => y.type === 0x02 || y.type === 0x1b);
  const empty = !vid ? 'NO VIDEO' : vid.type === 0x1b ? 'H.264 · NO PICTURE' : atscRtl() ? 'PICTURES NEED A HACKRF' : live ? 'WAITING FOR A PICTURE' : 'NO PICTURE YET';
  return `<div class="at-still">${r ? `<img src="${r.url}" alt="">` : `<div class="at-nopic"><i></i><span>${empty}</span></div>`}<span class="at-vc">${atscVc(x)}</span>${live && r && Date.now() - r.ms < 20_000 ? '<span class="at-new">NEW</span>' : ''}</div>`;
}
function atscNowHtml(st: AtscStation, x: AtscSub): string {
  const now = atscNow(st), e = x.now, n = x.next;
  if (!e && !n) return `<div class="at-ev dim">${x.events ? 'nothing on now in the guide' : 'no guide yet'}</div>`;
  const pct = e ? Math.max(0, Math.min(100, 100 * (now - e.startMs) / (e.seconds * 1000))) : 0;
  return (e ? `<div class="at-ev"><b>${esc(e.title || 'untitled')}</b><small>${atscTime(e.startMs)}–${atscTime(e.startMs + e.seconds * 1000)}${e.rating ? ` · ${esc(e.rating)}` : ''}</small><span class="at-bar"><i style="width:${pct.toFixed(0)}%"></i></span></div>` : '')
    + (n ? `<div class="at-next"><small>NEXT ${atscTime(n.startMs)}</small> ${esc(n.title || 'untitled')}</div>` : '');
}
function atscStationHtml(st: AtscStation, s: AtscSnap): string {
  const live = s.ch === st.ch && Date.now() - st.pilotMs < 4_000, now = Date.now();
  const name = st.subs.find(x => x.longName)?.longName ?? st.tvName;
  const head = `<div class="at-sth"><span class="at-rf"><b>${st.ch}</b><small>RF</small></span><span class="at-stt"><b>${esc(name || (st.tsid >= 0 ? `TSID 0x${st.tsid.toString(16).toUpperCase().padStart(4, '0')}` : 'PILOT ONLY'))}</b><small>${atscMhz(st.centerHz)} MHz${st.tsid >= 0 ? ` · TSID 0x${st.tsid.toString(16).toUpperCase().padStart(4, '0')}` : ''} · pilot +${st.pilotDb.toFixed(0)} dB${Number.isFinite(st.snrDb) ? ` · SNR ${st.snrDb.toFixed(1)} dB` : ''} · ${st.subs.length} channel${st.subs.length === 1 ? '' : 's'}</small></span><span class="mt-live ${live ? 'on' : ''}" data-atdo="signal:${st.key}"><i></i>${live ? 'LIVE' : atscAgo(now - st.lastMs).toUpperCase()}</span></div>`;
  if (!st.subs.length) return `<div class="at-st">${head}<div class="at-dim">${s.capability === 'pilot' ? 'a station is on this channel: decoding it needs a HackRF at 8 MS/s' : live ? 'reading the channel list…' : 'channel list not decoded yet'}</div></div>`;
  const tiles = st.subs.map(x => `<div class="at-tile ${atscUi.sel === x.key ? 'sel' : ''}" data-atsel="${esc(x.key)}">${atscStillHtml(x, live)}<div class="at-tb"><div class="at-name"><b>${esc(x.name || `program ${x.program}`)}</b>${x.access ? '<span class="tr-pill acc">PAY</span>' : ''}${x.hidden ? '<span class="tr-pill">HIDDEN</span>' : ''}</div>${atscNowHtml(st, x)}<div class="at-meta">${esc(x.video || x.streams.map(y => y.typeName).join(' · '))}${x.streams.filter(y => y.type === 0x81 || y.type === 0x87).map(y => ` · ${esc(y.lang || 'audio')}`).join('')}${x.streams.some(y => y.captions) ? ' · CC' : ''}</div></div></div>`).join('');
  return `<div class="at-st">${head}<div class="at-tiles">${tiles}</div></div>`;
}
function atscWallHtml(s: AtscSnap): string {
  if (!s.stations.length) return emptyState('atsc');
  return s.stations.slice().sort((a, b) => (b.ch === s.ch ? 1 : 0) - (a.ch === s.ch ? 1 : 0) || (b.subs.length ? 1 : 0) - (a.subs.length ? 1 : 0) || a.ch - b.ch).map(st => atscStationHtml(st, s)).join('');
}
const ATSC_LV = [-7, -5, -3, -1, 1, 3, 5, 7];
function atscCss(name: string, dflt: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || dflt; }
function atscDraw(live: AtscLive | null): void {
  const acc = atscCss('--accent', '#4c8dff'), mut = atscCss('--muted', '#8d97ab'), ok = atscCss('--ok', '#3ddc84'), a2 = atscCss('--accent2', '#ffaf00');
  const canvas = (id: string): [CanvasRenderingContext2D, number, number] | null => {
    const c = q<HTMLCanvasElement>(`#${id}`); if (!c) return null;
    const w = c.clientWidth || 300, h = c.clientHeight || 120, dpr = devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const x = c.getContext('2d'); if (!x) return null;
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h); x.font = '10px system-ui, sans-serif';
    return [x, w, h];
  };
  if (!live) return;
  // slicer histogram: the eight levels as peaks
  let g = canvas('at-hist');
  if (g) {
    const [x, w, h] = g, H = live.hist, mx = Math.max(1, ...H), xs = (v: number) => (v + 10.5) / 21 * w;
    x.strokeStyle = mut; x.globalAlpha = 0.35;
    for (const l of ATSC_LV) { x.beginPath(); x.moveTo(xs(l), 0); x.lineTo(xs(l), h - 12); x.stroke(); }
    x.globalAlpha = 1;
    const grad = x.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, acc); grad.addColorStop(1, 'transparent');
    x.fillStyle = grad; x.beginPath(); x.moveTo(0, h - 12);
    H.forEach((v, i) => x.lineTo(i / H.length * w, h - 12 - (h - 16) * Math.sqrt(v / mx)));
    x.lineTo(w, h - 12); x.closePath(); x.fill();
    x.fillStyle = mut; ATSC_LV.forEach(l => x.fillText(`${l > 0 ? '+' : ''}${l}`, xs(l) - 6, h - 1));
  }
  // the eye: equalized symbols over time against the eight levels
  g = canvas('at-eye');
  if (g) {
    const [x, w, h] = g, ys = (v: number) => h / 2 - v / 9 * (h / 2 - 4);
    x.strokeStyle = mut; x.globalAlpha = 0.3;
    for (const l of ATSC_LV) { x.beginPath(); x.moveTo(0, ys(l)); x.lineTo(w, ys(l)); x.stroke(); }
    x.globalAlpha = 0.7; x.fillStyle = acc;
    const E = live.eye; for (let i = 0; i < E.length; i++) x.fillRect(i / E.length * w, ys(E[i]) - 0.75, 1.5, 1.5);
    x.globalAlpha = 1;
  }
  // the echo profile ("ghosts"): delay in microseconds against level re the main path
  g = canvas('at-echo');
  if (g && live.echo.length) {
    const [x, w, h] = g, E = live.echo, us = (i: number) => (i / 2 - 32) / 10.762237762, umin = us(0), umax = us(E.length - 1);
    const xs = (u: number) => (u - umin) / (umax - umin) * w, ys = (db: number) => 4 + (Math.min(0, Math.max(-40, db)) / -40) * (h - 18);
    x.strokeStyle = mut; x.globalAlpha = 0.3; x.fillStyle = mut;
    for (const db of [-10, -20, -30]) { x.beginPath(); x.moveTo(0, ys(db)); x.lineTo(w, ys(db)); x.stroke(); }
    x.globalAlpha = 1;
    for (let u = 0; u <= umax; u += 10) x.fillText(`${u} µs`, xs(u) + 2, h - 2);
    x.fillText('-20 dB', 2, ys(-20) - 2);
    x.strokeStyle = acc; x.lineWidth = 1.2; x.beginPath();
    E.forEach((v, i) => { const px = xs(us(i)), py = ys(v); if (i) x.lineTo(px, py); else x.moveTo(px, py); });
    x.stroke();
    // echoes over -25 dB away from the main path, labeled
    const sorted = E.slice(2 * 72).slice().sort((a, b) => a - b), floor = sorted[sorted.length >> 1] ?? -30;
    x.fillStyle = a2;
    let last = -99;
    for (let i = 2; i < E.length - 2; i++) {
      const u = us(i);
      if (Math.abs(u) < 1.2 || E[i] < Math.max(-25, floor + 6) || E[i] < E[i - 1] || E[i] < E[i + 1] || u - last < 3) continue;
      last = u; x.beginPath(); x.arc(xs(u), ys(E[i]), 3, 0, 2 * Math.PI); x.fill();
      x.fillText(`${u.toFixed(1)} µs ${E[i].toFixed(0)} dB`, Math.min(w - 90, xs(u) + 5), ys(E[i]) - 4);
    }
    x.fillStyle = ok; x.fillText('MAIN', xs(0) + 4, 12);
  }
  // SNR and uncorrectable-packet history
  g = canvas('at-hist2');
  if (g) {
    const [x, w, h] = g, S = live.snrHistory, R = live.rsHistory, n = Math.max(S.length, 2);
    const ys = (db: number) => h - 4 - Math.max(0, Math.min(1, (db - 10) / 25)) * (h - 8);
    x.strokeStyle = mut; x.globalAlpha = 0.3; x.beginPath(); x.moveTo(0, ys(15)); x.lineTo(w, ys(15)); x.stroke(); x.globalAlpha = 1;
    x.fillStyle = mut; x.fillText('15 dB', 2, ys(15) - 2);
    x.fillStyle = a2; R.forEach((v, i) => { const bh = v * (h - 8); x.fillRect(i / n * w, h - 4 - bh, Math.max(2, w / n - 2), bh); });
    x.strokeStyle = ok; x.lineWidth = 1.5; x.beginPath(); S.forEach((v, i) => { const px = (i + 0.5) / n * w; if (i) x.lineTo(px, ys(v)); else x.moveTo(px, ys(v)); }); x.stroke();
  }
}
function atscSignalHtml(s: AtscSnap): string {
  const key = atscUi.sigSel || (s.ch ? `ch${s.ch}` : s.stations[0]?.key ?? '');
  const st = s.stations.find(x => x.key === key), live = s.live && st && s.live.ch === st.ch ? s.live : null;
  const chips = s.stations.length > 1 ? `<div class="at-chips">${s.stations.map(x => `<button class="chip ${x.key === key ? 'on' : ''}" data-atsig="${x.key}">CH ${x.ch}</button>`).join('')}</div>` : '';
  if (!st) return chips + (s.stations.length ? '' : emptyState('atsc', 'No station yet', ['Each channel takes a moment, AUTO looks at every one for its pilot', 'An antenna up high, or outside, hears stations 60+ miles away']));
  const tot = st.rs.ok + st.rs.corrected + st.rs.failed, fail = tot ? 100 * st.rs.failed / tot : 0;
  const tile = (v: string, l: string, tone = '') => `<span class="${tone}"><b>${v}</b><small>${l}</small></span>`;
  const tiles = `<div class="at-sig">${tile(`+${st.pilotDb.toFixed(1)}`, 'PILOT dB')}${tile(`${st.pilotHz >= 0 ? '+' : ''}${st.pilotHz.toFixed(0)}`, 'PILOT OFFSET Hz')}${tile(Number.isFinite(st.snrDb) ? st.snrDb.toFixed(1) : '-', 'EQUALIZER SNR dB', Number.isFinite(st.snrDb) ? (st.snrDb >= 16 ? 'ok' : st.snrDb >= 14.5 ? 'amber' : 'red') : '')}${tile(tot ? `${fail.toFixed(fail < 1 ? 2 : 0)}%` : '-', 'UNCORRECTABLE', tot ? (fail < 1 ? 'ok' : fail < 10 ? 'amber' : 'red') : '')}${tile(tot ? `${(100 * st.rs.corrected / tot).toFixed(0)}%` : '-', 'RS CORRECTED')}${tile(Number.isFinite(st.topDb) ? `+${st.topDb.toFixed(0)}` : '-', 'CHANNEL OVER FLOOR dB')}</div>`;
  if (!live) return chips + `<div class="at-sigh"><b>CH ${st.ch} · ${atscMhz(st.centerHz)} MHz</b><small>${s.ch === st.ch ? (s.capability === 'pilot' ? 'pilot and level only on this radio' : 'waiting for the first burst…') : `last heard ${atscAgo(Date.now() - st.lastMs)} · tune here for the live equalizer, echoes and packets`}</small>${s.ch !== st.ch ? `<button class="chip" data-atdo="hold:${st.ch}">TUNE</button>` : ''}</div>` + tiles;
  const L = live, rsTot = L.rs.ok + L.rs.corrected + L.rs.failed;
  const pidRows = L.pids.map(p => `<tr><td>0x${p.pid.toString(16).toUpperCase().padStart(4, '0')}</td><td class="at-role">${esc(p.role || '?')}</td><td class="at-kb"><span class="at-lvl"><i style="width:${Math.min(100, 100 * p.share / Math.max(0.01, ...L.pids.map(x => x.share))).toFixed(0)}%"></i></span>${p.kbps >= 1000 ? `${(p.kbps / 1000).toFixed(2)} Mb/s` : `${p.kbps.toFixed(0)} kb/s`}</td><td>${p.ccErrors || ''}</td><td>${p.pcrs ? `${p.pcrIntervalMs.toFixed(0)} ms · ${p.pcrPpm >= 0 ? '+' : ''}${p.pcrPpm.toFixed(1)} ppm` : ''}</td></tr>`).join('');
  return chips
    + `<div class="at-sigh"><b>CH ${st.ch} · ${atscMhz(st.centerHz)} MHz · LIVE</b><small>${L.ok ? `${L.fields} fields in the last burst · ${L.syncs} field syncs · segment sync ${L.segPeak.toFixed(0)}× · clock ${(L.eps * 1e6 >= 0 ? '+' : '')}${(L.eps * 1e6).toFixed(2)} ppm · ${L.cpuMs.toFixed(0)} ms CPU · ${s.decodedPct.toFixed(0)}% of the air time decoded` : esc(L.reason || 'no lock')}</small></div>`
    + tiles
    + `<div class="at-plot"><small>SLICER · the eight 8VSB levels after the equalizer${Number.isFinite(L.sliceSnrDb) ? ` · ${L.sliceSnrDb.toFixed(1)} dB to the nearest level` : ''}</small><canvas id="at-hist"></canvas></div>`
    + `<div class="at-plot"><small>EYE · equalized symbols over the last field</small><canvas id="at-eye"></canvas></div>`
    + `<div class="at-plot"><small>ECHOES · the channel from the field sync (PN511): the main path and its ghosts by delay</small><canvas id="at-echo"></canvas></div>`
    + `<div class="at-plot"><small>HISTORY · SNR per burst (line), share of packets lost (bars) · last burst ${rsTot} packets, ${L.rs.corrected} corrected (${L.rs.bytes} bytes), ${L.rs.failed} lost</small><canvas id="at-hist2"></canvas></div>`
    + `<div class="at-plot"><small>TRANSPORT STREAM · ${st.packets.toLocaleString()} packets · ${st.badPackets.toLocaleString()} lost</small><table class="at-tab at-pids"><tr><th>PID</th><th>CARRIES</th><th>RATE</th><th>CC</th><th>PCR</th></tr>${pidRows}</table></div>`;
}
function atscGuideHtml(s: AtscSnap): string {
  const rows = s.stations.flatMap(st => st.subs.filter(x => !x.hideGuide && x.sourceId >= 0).map(x => ({ st, x })));
  if (!rows.length) return emptyState('atsc', 'No guide yet', ['Stations send the guide every few seconds, and it fills in once a station has been decoded', 'Each station carries its own subchannels\' next few hours']);
  const now = atscNow(s.stations.find(x => x.ch === s.ch) ?? s.stations[0]);
  const t0 = Math.floor(now / 1_800_000) * 1_800_000 - 1_800_000, span = 5 * 3_600_000, ppm = ATSC_WIDE.matches ? 4 : 3, W = span / 60_000 * ppm;
  const xs = (ms: number) => (ms - t0) / 60_000 * ppm;
  let marks = ''; for (let t = t0; t <= t0 + span; t += 1_800_000) marks += `<span style="left:${xs(t).toFixed(0)}px">${atscTime(t)}</span>`;
  const body = rows.map(({ x }) => {
    return `<div class="at-grow" data-atsel="${esc(x.key)}"><div class="at-glab"><b>${atscVc(x)}</b><small>${esc(x.name || '')}</small></div><div class="at-gline" style="width:${W}px" data-gk="${esc(x.key)}"></div></div>`;
  }).join('');
  return `<div class="at-gscroll"><div class="at-gin" style="width:${W + 84}px"><div class="at-gtime" style="width:${W}px">${marks}<i style="left:${xs(now).toFixed(0)}px"></i></div>${body}<i class="at-gnow" style="left:${(84 + xs(now)).toFixed(0)}px"></i></div></div>`;
}
/** The guide's event blocks come from each subchannel's full list (the detail's events, else now and next). */
function atscGuideFill(s: AtscSnap): void {
  const now = atscNow(s.stations.find(x => x.ch === s.ch) ?? s.stations[0]);
  const t0 = Math.floor(now / 1_800_000) * 1_800_000 - 1_800_000, span = 5 * 3_600_000, ppm = ATSC_WIDE.matches ? 4 : 3;
  const xs = (ms: number) => (ms - t0) / 60_000 * ppm;
  for (const el of qa<HTMLElement>('[data-gk]')) {
    const key = el.dataset.gk!, st = s.stations.find(y => key.startsWith(y.key + '/')), x = st?.subs.find(y => y.key === key); if (!x) continue;
    const evs = (atscGuide.get(key) ?? [x.now, x.next].filter((e): e is AtscEvent => !!e));
    el.innerHTML = evs.filter(e => e.startMs + e.seconds * 1000 > t0 && e.startMs < t0 + span).map(e => {
      const a = Math.max(0, xs(e.startMs)), b = Math.min(span / 60_000 * ppm, xs(e.startMs + e.seconds * 1000)), on = e.startMs <= now && e.startMs + e.seconds * 1000 > now;
      return `<span class="at-gev ${on ? 'on' : ''}" style="left:${a.toFixed(0)}px;width:${Math.max(2, b - a - 2).toFixed(0)}px" title="${esc(e.title)}"><b>${esc(e.title || 'untitled')}</b><small>${atscTime(e.startMs)}</small></span>`;
    }).join('');
  }
}
/** Every subchannel's events as the detail requests bring them in (the guide shows more than now and next). */
const atscGuide = new Map<string, AtscEvent[]>();
let atscGuideAsk = 0;
function atscDetailHtml(s: AtscSnap): string {
  const key = atscUi.sel; if (!key) return '';
  const st = s.stations.find(x => key.startsWith(x.key + '/')), x = st?.subs.find(y => y.key === key);
  if (!st || !x) return '';
  const d = atscUi.detail?.key === key ? atscUi.detail : null, r = atscUi.stills.get(key), now = atscNow(st);
  const head = `<div class="mt-dh"><b>${atscVc(x)} ${esc(x.name)}</b><span>${esc(x.longName || `RF ${st.ch} · program ${x.program}`)}</span><button class="chip" data-atdo="hold:${st.ch}">${atscUi.band === 'HOLD' && atscUi.scan.stayCh === st.ch ? 'HOLDING' : 'HOLD HERE'}</button><button class="chip" data-atdo="close">✕</button></div>`;
  const pic = r ? `<div class="at-big"><img src="${r.url}" alt=""><small>${r.complete ? 'whole picture' : 'part of a picture'} · ${atscAgo(Date.now() - r.ms)}</small></div>` : '';
  const evs = d?.events ?? [x.now, x.next].filter((e): e is AtscEvent => !!e);
  const prog = evs.filter(e => e.startMs + e.seconds * 1000 > now - 3_600_000).map(e => {
    const on = e.startMs <= now && e.startMs + e.seconds * 1000 > now;
    return `<div class="at-gl ${on ? 'on' : ''}"><b>${atscTime(e.startMs)}</b><span><em>${esc(e.title || 'untitled')}</em><small>${Math.round(e.seconds / 60)} min${e.rating ? ` · ${esc(e.rating)}` : ''}${e.captions ? ` · ${esc(e.captions)}` : ''}</small>${e.text ? `<i>${esc(e.text)}</i>` : ''}</span></div>`;
  }).join('') || '<div class="at-dim">no guide for this channel yet</div>';
  const streams = `<table class="at-tab"><tr><th>PID</th><th>STREAM</th><th>LANG</th><th>DETAIL</th><th>RATE</th></tr>${x.streams.map(y => `<tr><td>0x${y.pid.toString(16).toUpperCase().padStart(4, '0')}</td><td>${esc(y.typeName)}</td><td>${esc(y.lang)}</td><td>${esc([y.info, y.captions].filter(v => v).join(' · '))}</td><td>${y.kbps >= 1000 ? `${(y.kbps / 1000).toFixed(2)} Mb/s` : `${y.kbps.toFixed(0)} kb/s`}</td></tr>`).join('')}</table>`;
  const vinfo = d?.video.find(v => x.streams.some(y => y.pid === v.pid));
  const fields: [string, string][] = [['VIRTUAL CHANNEL', `${atscVc(x)}${x.name ? ` ${x.name}` : ''}`], ['RF CHANNEL', `${st.ch} · ${atscMhz(st.centerHz)} MHz`], ['TSID', st.tsid >= 0 ? `0x${st.tsid.toString(16).toUpperCase().padStart(4, '0')}` : '-'], ['PROGRAM', `${x.program}`], ['SOURCE ID', x.sourceId >= 0 ? `${x.sourceId}` : '-'],
    ['SERVICE', ATSC_SERVICE[x.serviceType] ?? `type ${x.serviceType}`], ['VIDEO', x.video || '-'], ['PICTURES', vinfo ? `${vinfo.pictures} seen, ${vinfo.iPictures} intra · ${vinfo.gop.slice(-15)}` : '-'],
    ['STATION CLOCK', st.stt ? `${new Date(now).toISOString().slice(11, 19)} UTC · ${(st.stt.diffMs / 1000 >= 0 ? '+' : '')}${(st.stt.diffMs / 1000).toFixed(1)} s from this device` : '-'], ['TABLES', st.tables.join(' ')]];
  const raw = d ? `<div class="at-sec"><small data-atdo="raw" class="at-rawh">RAW TABLES · ${d.raw.length} sections ${atscUi.rawOpen ? '▾' : '▸'}</small>${atscUi.rawOpen ? d.raw.map(t => `<div class="at-raw"><b>${esc(t.table)}</b><code>${esc(t.hex.replace(/(.{64})/g, '$1 '))}</code></div>`).join('') : ''}</div>` : '<div class="at-dim">loading the tables…</div>';
  return head + pic + `<div class="at-sec"><small>PROGRAM GUIDE</small>${d?.chanText ? `<div class="at-dim">${esc(d.chanText)}</div>` : ''}${prog}</div>` + `<div class="mt-fields">${fields.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>` + `<div class="at-sec"><small>STREAMS</small>${streams}</div>` + raw;
}
const ATSC_SERVICE: Record<number, string> = { 0: 'not in the channel table', 1: 'analog TV', 2: 'digital TV', 3: 'audio only', 4: 'data only', 5: 'software download', 6: 'unassociated', 7: 'parameterized', 8: 'ATSC 3.0', 9: 'ATSC 3.0 audio' };
function refreshAtsc(force = false): void {
  if (state.app !== 'atsc') return;
  const now = Date.now();
  if (atscUi.hold) return;
  if (!force && now - atscUi.drawn < 240) { clearTimeout(atscUi.pending); atscUi.pending = window.setTimeout(() => refreshAtsc(true), 250); return; }
  atscUi.drawn = now;
  const s = atscUi.snap, view = atscUi.view, wide = ATSC_WIDE.matches;
  const head = q('#at-head'); if (head) head.innerHTML = atscHead(s);
  qa<HTMLButtonElement>('[data-atband]').forEach(b => b.classList.toggle('on', b.dataset.atband === atscUi.band));
  const chEl = q('#at-ch'); if (chEl) chEl.textContent = `CH ${s?.ch || atscUi.scan.stayCh || atscUi.scan.list[atscUi.scan.idx] || ''}`;
  qa<HTMLButtonElement>('[data-atview]').forEach(b => {
    const v = b.dataset.atview as AtscView; b.classList.toggle('on', v === view);
    b.textContent = v === 'channels' ? `CHANNELS ${s ? s.stations.reduce((n, x) => n + x.subs.length, 0) : 0}` : v === 'signal' ? 'SIGNAL' : v === 'guide' ? 'GUIDE' : 'LOG';
  });
  const wall = q('#at-wall'), sig = q('#at-signal'), guide = q('#at-guide'), det = q('#at-detail'), stage = q('#at-stage'), logEl = q('#at-log');
  if (!wall || !sig || !guide || !det || !stage || !logEl) return;
  if (!wide) wall.hidden = view !== 'channels';
  sig.hidden = view !== 'signal'; guide.hidden = view !== 'guide';
  stage.hidden = view === 'log'; logEl.hidden = view !== 'log';
  const keep = (el: HTMLElement, html: string) => { const top = el.scrollTop, left = el.querySelector('.at-gscroll')?.scrollLeft ?? 0; el.innerHTML = html; el.scrollTop = top; const g = el.querySelector('.at-gscroll'); if (g) g.scrollLeft = left; };
  if (!paused.has('atsc') && s) {
    if (wide || view === 'channels') keep(wall, atscWallHtml(s));
    if (view === 'signal') { keep(sig, atscSignalHtml(s)); atscDraw(s.live && (atscUi.sigSel === '' || atscUi.sigSel === `ch${s.live.ch}`) ? s.live : null); }
    if (view === 'guide') {
      keep(guide, atscGuideHtml(s)); atscGuideFill(s);
      // ask for each subchannel's whole guide now and then
      if (now - atscGuideAsk > 15_000) { atscGuideAsk = now; for (const st of s.stations) for (const x of st.subs) if (x.events > 2) worker?.postMessage({ type: 'atsc', cmd: 'detail', key: x.key }); }
    }
  } else if (!s) { wall.innerHTML = emptyState('atsc'); if (view === 'signal') sig.innerHTML = emptyState('atsc'); }
  const html = s ? atscDetailHtml(s) : '';
  det.hidden = !html;
  if (html) { const top = det.scrollTop; det.innerHTML = html; det.scrollTop = top; }
  if (s) {
    const h = s.here && s.here.ch === s.ch ? s.here : null;
    if (h && h.pilotOk) setMeter(Math.min(1, h.pilotDb / 40), `PILOT +${h.pilotDb.toFixed(0)} dB${Number.isFinite(h.snrDb) ? ` · SNR ${h.snrDb.toFixed(1)} dB` : ''}`);
    else setMeter(0, `CH ${s.ch || '-'} · NO PILOT`);
    const subs = s.stations.reduce((n, x) => n + x.subs.length, 0);
    if (subs) setLamp(`${subs} CHANNEL${subs === 1 ? '' : 'S'}`, 'ok'); else if (s.stations.length) setLamp(`${s.stations.length} STATION${s.stations.length === 1 ? '' : 'S'}`, 'ok'); else setLamp('SCANNING', 'amber', true);
  }
}
function atscOnDetail(m: Record<string, unknown>): void {
  const d = m as unknown as AtscDetail;
  atscGuide.set(d.key, d.events);
  if (d.key === atscUi.sel) atscUi.detail = d;
  refreshAtsc();
}
function atscExport(csv: string, json: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  download(`atsc-log-${stamp}.csv`, csv, 'text/csv');
  setTimeout(() => download(`atsc-tables-${stamp}.json`, json, 'application/json'), 400);
}

// ---- LoRa: every Meshtastic, MeshCore and LoRaWAN node heard across the span ------------------------------------
const LORA_WIDE = 20_000_000, LORA_NARROW = 2_000_000;
interface LoraNodeRow { key: string; proto: string; label: string; name: string | null; kind: string; lat: number | null; lon: number | null; firstMs: number; lastMs: number; packets: number; snr: number[]; fields: { name: string; value: string }[]; last: string; hz: number; modem: string; texts: string[] }
interface LoraEventRow { id: number; ms: number; proto: string; from: string | null; nodeKey: string | null; text: string | null; channel: string | null }
interface LoraSnap { nodes: LoraNodeRow[]; messages: LoraEventRow[]; bursts: number; frames: number; rate: number; centerHz: number; wide: boolean; busy: number; open: number;
  channels: { name: string; hz: number; standing: boolean; active: boolean; hotAgoMs: number | null; frames: number }[] }
/** The LoRa screen: NODES shows every node live; MAP puts the ones that broadcast a position where they say they are;
 *  MESSAGES is the text traffic in order. A tap on a card or a pin opens everything decoded from that node. */
// opens on the LOG: it fills first (every frame and burst), while nodes and chat take minutes
const loraUi = { snap: null as LoraSnap | null, view: 'log' as 'nodes' | 'map' | 'messages' | 'log', sel: '', full: false, drawn: 0, timer: 0, drawPending: 0 };
const loraClock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
const loraPins = (): GeoItem[] => (loraUi.snap?.nodes ?? []).filter(n => n.lat !== null && n.lon !== null).map(n => ({ id: n.key, lat: n.lat!, lon: n.lon!, label: n.label, kind: 'station' as GeoItem['kind'] }));
/** LoRa opens where the user last put it, else centered on what is local to where the browser is (its MeshCore
 *  presets and its Meshtastic region, local.ts): 20 MHz where the radio can sample it, else one channel with the
 *  radio 300 kHz above it (clear of the spike at the center). The gain starts where it settled here last time. */
function loraOpen(): void {
  const wide = radioCan(LORA_WIDE);
  loraSendPlan();
  configure('NONE', wide ? LoraLocal.wideStart() : LoraLocal.narrowStart(), wide ? LORA_WIDE : LORA_NARROW, 32, 40, true, 'lora');
  loraRecall();
}
/** The channels local to the area in use, to the DSP worker (it builds the plan the scanner listens by). */
function loraSendPlan(): void { worker?.postMessage({ type: 'loraPlan', channels: LoraLocal.channels(LoraLocal.area()) }); }
LoraLocal.position = () => state.home ?? lastKnownPos();
// another area or the user's own channel: the channels again, and the span follows
LoraLocal.onChange = () => {
  loraSendPlan();
  if (state.app !== 'lora') return;
  tune(state.rate >= 10_000_000 ? LoraLocal.wideStart() : LoraLocal.narrowStart());
  render('lora');
};
function loraSpan(wide: boolean): void {
  if (wide === state.rate >= 10_000_000) return;
  if (wide) {
    if (!radioCan(LORA_WIDE)) { log(`${radio?.label ?? 'this radio'} cannot sample 20 MHz`); return; }
    setRate(LORA_WIDE); tune(LoraLocal.wideStart());
  } else {
    setRate(LORA_NARROW); tune(LoraLocal.narrowStart());
  }
  render("lora");
}
/** The narrow span's tiles: the area's own channels, most local first. */
const loraNarrowChannels = () => LoraLocal.channels(LoraLocal.area()).slice(0, 8);
/** The wide tiles' and narrow tiles' lit state: LOCAL follows the area; a band tile is the user's own pick. */
function loraTilesOn(): void {
  const user = LoraLocal.userWide(), localHz = LoraLocal.wideCenter(LoraLocal.area()) ?? LoraLocal.wideStart();
  qa<HTMLButtonElement>('[data-lrwide]').forEach(b => {
    const hz = Number(b.dataset.lrwide);
    b.classList.toggle('on', hz === 0 ? user === 0 && state.freq === localHz : user !== 0 && state.freq === hz);
  });
  qa<HTMLButtonElement>('[data-lrnarrow]').forEach(b => b.classList.toggle('on', state.freq - LoraLocal.NARROW_SHIFT === Number(b.dataset.lrnarrow)));
}
const loraBwName = (bw: number) => (bw === 62_500 ? '62.5 kHz' : `${Math.trunc(bw / 1000)} kHz`);
function renderLora(view: HTMLElement): void {
  const wide = state.rate >= 10_000_000;
  const area = LoraLocal.area(), picked = LoraLocal.picked();
  const areaSel = `<select id="lr-area" class="txin lr-area" aria-label="area">${LoraLocal.areas().map(x => `<option value="${esc(x.id)}" ${x.id === picked ? 'selected' : ''}>${esc(x.id === 'AUTO' ? `Automatic · ${LoraLocal.title(area)}` : x.title)}</option>`).join('')}</select>`;
  const short = (n: string) => n.replace('MeshCore ', '').replace('Meshtastic ', '');
  // LOCAL follows the area; a band tile is the user's own pick, kept until LOCAL is tapped again
  const tiles = wide ? hsHtml(`<div class="tiles wide"><button class="tl" data-lrwide="0"><b>LOCAL</b><small>${esc(LoraLocal.title(area))}</small></button>${LORA_BANDS.map(b => `<button class="tl" data-lrwide="${b.center}"><b>${b.title}</b><small>${b.sub}</small></button>`).join('')}</div>`)
    // one channel at a time, the area's own first: the radio sits 300 kHz above it, clear of the spike at the center
    : hsHtml(`<div class="tiles wide">${loraNarrowChannels().map(c => `<button class="tl" data-lrnarrow="${c.hz}"><b>${(c.hz / 1e6).toFixed(3)}</b><small>${esc(short(c.name))}</small></button>`).join('')}</div>`);
  const own = LoraLocal.custom();
  view.innerHTML = `
    <section class="${visCls('lora')}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="lr-sum" class="mt-sum"></div>
      <div class="ctlrow">${segHtml(['nodes', 'map', 'messages', 'log'].map(v => `<button data-lrview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('lora')}<button id="lr-full" class="ib" title="full screen" aria-label="full screen">${loraUi.full ? EXIT_SVG : FULL_SVG}</button>${pauseClearHtml('lora')}</div>
      <div id="lr-stage" class="mt-stage"><div id="lr-cards" class="mt-cards"></div><div id="lr-map" class="panel map"></div><div id="lr-msgs" class="lr-msgs"></div><div id="lr-nopos" class="mt-nopos">no positions yet</div><div id="lr-detail" class="mt-detail" hidden></div><button id="lr-newpill" class="lr-newpill" hidden></button></div>
      <div id="lr-log">${logHtml('lora', 'listening for LoRa…')}</div>
      <div id="lr-chans" class="lr-chans"></div>
      <div class="ctlrow"><span class="rl">AREA</span>${areaSel}</div>
      ${tiles}
      <div class="ctlrow"><span class="rl">SPAN</span>${segHtml([`<button data-lrspan="0" class="${wide ? '' : 'on'}">2 MHz</button>`, `<button data-lrspan="1" class="${wide ? 'on' : ''} ${radioCan(LORA_WIDE) ? '' : 'off'}">20 MHz</button>`])}<button id="lr-own" class="chip" title="your own channel">YOUR CHANNEL</button></div>
      ${own ? `<div class="lr-ownline">YOUR CHANNEL · ${(own.hz / 1e6).toFixed(4)} MHz · ${loraBwName(own.bw)} · SF${own.sf}</div>` : ''}
      <div class="note about">LoRa across the band at once: Meshtastic (decrypted on the default channels: names, positions, telemetry, text), MeshCore (adverts with names and positions, public channel messages) and LoRaWAN (device addresses, frame counters), plus any other LoRa as raw frames. 433, 470–510, 863–870 and 902–928 MHz, by area. It starts on the channels where you are (your language's region, and the part of it your last position is in): MeshCore's community presets and the Meshtastic region. AREA, the band tiles and your own channel change it. A HackRF watches 20 MHz at once; an RTL-SDR one channel at a time.</div>
      </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-lrview]', view).forEach(b => b.onclick = () => { loraUi.view = b.dataset.lrview as typeof loraUi.view; refreshLora(true); });
  qa<HTMLButtonElement>('[data-lrspan]', view).forEach(b => b.onclick = () => loraSpan(b.dataset.lrspan === '1'));
  qa<HTMLButtonElement>('[data-lrwide]', view).forEach(b => b.onclick = () => {
    const hz = Number(b.dataset.lrwide);
    LoraLocal.setUserWide(hz);
    tune(hz === 0 ? LoraLocal.wideStart() : hz);
    loraTilesOn();
  });
  qa<HTMLButtonElement>('[data-lrnarrow]', view).forEach(b => b.onclick = () => {
    const hz = Number(b.dataset.lrnarrow);
    LoraLocal.setUserNarrow(hz); tune(hz + LoraLocal.NARROW_SHIFT); loraTilesOn();
  });
  const sel = q<HTMLSelectElement>('#lr-area', view);
  if (sel) sel.onchange = () => LoraLocal.setPicked(sel.value);
  $('lr-own').onclick = () => loraOwnDialog();
  $('lr-newpill').onclick = () => {
    const el = loraUi.view === 'messages' ? q('#lr-msgs') : q('#lr-cards');
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  };
  $('lr-full').onclick = () => setLoraFull(!loraUi.full);
  const pick = (e: Event) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-lnode]'); if (c && (loraUi.snap?.nodes ?? []).some(n => n.key === c.dataset.lnode)) { loraUi.sel = loraUi.sel === c.dataset.lnode ? '' : c.dataset.lnode!; refreshLora(true); } };
  $('lr-cards').onclick = pick; $('lr-msgs').onclick = pick;
  // scrolled back to the top by hand: the pill goes at once, not at the next refresh
  $('lr-cards').onscroll = () => loraPill(); $('lr-msgs').onscroll = () => loraPill();
  $('lr-detail').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ldo]'); if (!b) return;
    const what = b.dataset.ldo;
    if (what === 'close') loraUi.sel = '';
    else if (what === 'map') {
      loraUi.view = 'map'; refreshLora(true);
      const n = loraUi.snap?.nodes.find(x => x.key === loraUi.sel);
      if (n && n.lat !== null && n.lon !== null) geo?.center(n.lat, n.lon, 15);
      return;
    } else if (what === 'cards') loraUi.view = 'nodes';
    refreshLora(true);
  };
  view.classList.toggle('lorafull', loraUi.full);
  geo = new GeoMap($('lr-map'), { home: null, start: mapStart(state.home), fitPins: true, onPick: id => { loraUi.sel = id; refreshLora(true); }, log });
  clearInterval(loraUi.timer);
  loraUi.timer = window.setInterval(() => { if (state.app !== 'lora') { clearInterval(loraUi.timer); return; } refreshLora(); }, 1000);
  loraTilesOn();
  refreshLora(true);
}
/** A channel of the user's own: frequency, bandwidth and spreading factor, listened to all the time while in span. */
function loraOwnDialog(): void {
  if (q('#lr-owndlg')) return;
  const c = LoraLocal.custom();
  const BWS = [62_500, 125_000, 250_000, 500_000];
  let bw = c?.bw ?? 125_000, sf = c?.sf ?? 7;
  const el = document.createElement('div');
  el.id = 'lr-owndlg'; el.className = 'modal';
  el.innerHTML = `<div class="modal-card lr-owncard"><h3>YOUR OWN CHANNEL</h3>
    <div class="ctlrow"><span class="rl">MHz</span><input id="lr-own-mhz" class="txin" inputmode="decimal" placeholder="915.0000" value="${c ? (c.hz / 1e6).toFixed(4) : ''}"></div>
    <div class="ctlrow"><span class="rl">BW</span>${segHtml(BWS.map(x => `<button data-ownbw="${x}">${loraBwName(x)}</button>`))}</div>
    <div class="ctlrow"><span class="rl">SF</span>${segHtml([7, 8, 9, 10, 11, 12].map(x => `<button data-ownsf="${x}">${x}</button>`))}</div>
    <div id="lr-own-err" class="note" hidden>A frequency from 400 to 1000 MHz</div>
    <div class="modal-actions"><button id="lr-own-clear" class="chip">CLEAR</button><button id="lr-own-save" class="chip primary">SAVE</button></div></div>`;
  document.body.appendChild(el);
  const lit = () => {
    qa<HTMLButtonElement>('[data-ownbw]', el).forEach(b => b.classList.toggle('on', Number(b.dataset.ownbw) === bw));
    qa<HTMLButtonElement>('[data-ownsf]', el).forEach(b => b.classList.toggle('on', Number(b.dataset.ownsf) === sf));
  };
  qa<HTMLButtonElement>('[data-ownbw]', el).forEach(b => b.onclick = () => { bw = Number(b.dataset.ownbw); lit(); });
  qa<HTMLButtonElement>('[data-ownsf]', el).forEach(b => b.onclick = () => { sf = Number(b.dataset.ownsf); lit(); });
  lit();
  const close = () => el.remove();
  el.onclick = e => { if (e.target === el) close(); };
  $('lr-own-clear').onclick = () => { close(); LoraLocal.setCustom(null); };
  $('lr-own-save').onclick = () => {
    const f = Number(($('lr-own-mhz') as HTMLInputElement).value.replace(',', '.'));
    if (!Number.isFinite(f) || f < 400 || f > 1000) { $('lr-own-err').hidden = false; return; }
    close(); LoraLocal.setCustom({ hz: Math.round(f * 1e6), bw, sf });
  };
  ($('lr-own-mhz') as HTMLInputElement).focus();
}
/**
 * A newest-first list the reader may scroll down. At the top it stays on the newest. Scrolled away, the item the
 * reader is on stays where it is on screen (a node heard again moves its card to the top, which used to push the
 * rest down under the reader), and what arrived since shows as "↑ N NEW" over the list; a tap goes back up.
 * Each item carries data-fk (a key) and data-fms (when it last changed).
 */
const loraFollow = { cards: 0, msgs: 0, sondes: 0 };
function followNewest(el: HTMLElement, html: string, which: 'cards' | 'msgs' | 'sondes'): void {
  const box = el.getBoundingClientRect();
  const atTop = el.scrollTop < 24;
  const seen = loraFollow[which];
  // the old items on screen, top first, and where each sits in the view
  const anchors: [string, number][] = [];
  if (!atTop) {
    for (const c of Array.from(el.querySelectorAll<HTMLElement>('[data-fk]'))) {
      const r = c.getBoundingClientRect();
      if (r.bottom <= box.top) continue;
      if (r.top >= box.bottom) break;
      if (Number(c.dataset.fms) <= seen) anchors.push([c.dataset.fk!, r.top - box.top]);
    }
  }
  el.innerHTML = html;
  const items = Array.from(el.querySelectorAll<HTMLElement>('[data-fk]'));
  const newest = items.reduce((m, c) => Math.max(m, Number(c.dataset.fms) || 0), 0);
  if (atTop) { el.scrollTop = 0; loraFollow[which] = newest; return; }
  for (const [k, dy] of anchors) {
    const c = items.find(x => x.dataset.fk === k);
    if (!c || Number(c.dataset.fms) > seen) continue;   // heard again: it moved to the top, the next one holds
    el.scrollTop += c.getBoundingClientRect().top - el.getBoundingClientRect().top - dy;
    break;
  }
}
/** The "↑ N NEW" pill over whichever list is showing, while it is scrolled away from the top. */
function loraPill(): void {
  const pill = q<HTMLButtonElement>('#lr-newpill'); if (!pill) return;
  const which = loraUi.view === 'messages' ? 'msgs' : loraUi.view === 'nodes' ? 'cards' : null;
  const el = which === 'msgs' ? q('#lr-msgs') : which === 'cards' ? q('#lr-cards') : null;
  if (!which || !el || el.scrollTop < 24) {
    pill.hidden = true;
    if (which && el) loraFollow[which] = Array.from(el.querySelectorAll<HTMLElement>('[data-fk]')).reduce((m, c) => Math.max(m, Number(c.dataset.fms) || 0), 0);
    return;
  }
  const seen = loraFollow[which];
  const fresh = Array.from(el.querySelectorAll<HTMLElement>('[data-fk]')).filter(c => Number(c.dataset.fms) > seen).length;
  pill.textContent = fresh > 0 ? `↑ ${fresh} NEW` : '↑ NEWEST';
  pill.hidden = false;
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
  return `<div class="mt-card ${loraUi.sel === n.key ? 'sel' : ''} ${live ? '' : 'dim'}" data-lnode="${esc(n.key)}" data-fk="${esc(n.key)}" data-fms="${n.lastMs}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-id ${n.label.length > 6 ? '' : 'big'}" style="font-size:${n.label.length > 6 ? 16 : 24}px">${esc(n.label)}</span><span class="mt-k"><b>${esc(n.proto.toUpperCase())}</b><small class="${n.lat !== null ? 'pos' : ''}">${esc(n.kind)}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${ago}</span></div>`
    + (n.name && n.name !== n.label ? `<div class="lr-name">${esc(n.name)}</div>` : '')
    + `<div class="mt-clk"><b>${n.packets}</b><small>${n.packets === 1 ? 'PACKET' : 'PACKETS'}</small><em>${(n.hz / 1e6).toFixed(3)} · ${esc(n.modem.split(' · CR')[0])}</em></div>`
    + spark + `<div class="lr-last">${esc(n.last)}</div></div>`;
}
/** One text message: who, where it went, when, and what it said. */
function loraMessage(e: LoraEventRow): string {
  return `<div class="lr-msg" ${e.nodeKey ? `data-lnode="${esc(e.nodeKey)}"` : ''} data-fk="m${e.id}" data-fms="${e.ms}"><div class="lr-mh"><b>${esc(e.from ?? '?')}</b><span>${esc(e.proto.toUpperCase() + (e.channel ? ` · ${e.channel}` : ''))}</span><i>${loraClock(e.ms)}</i></div><div class="lr-mt">${esc(e.text ?? '')}</div></div>`;
}
/** Everything decoded from one node, field by field, its recent messages, with MAP when it has a position. */
function loraDetail(n: LoraNodeRow, onMap: boolean): string {
  const all = [{ name: 'FIRST HEARD', value: loraClock(n.firstMs) }, { name: 'LAST HEARD', value: loraClock(n.lastMs) }, { name: 'PACKETS', value: `${n.packets}` },
    { name: 'FREQUENCY', value: `${(n.hz / 1e6).toFixed(4)} MHz` }, { name: 'MODEM', value: n.modem }, ...n.fields];
  return `<div class="mt-dh"><b>${esc(n.label)}</b><span>${esc(`${n.proto.toUpperCase()} · ${n.kind}`)}</span>${onMap ? '<button class="chip" data-ldo="map">MAP</button>' : ''}${loraUi.view !== 'nodes' ? '<button class="chip" data-ldo="cards">CARDS</button>' : ''}<button class="chip" data-ldo="close">✕</button></div>`
    + `<div class="mt-fields">${all.map(f => `<div><b>${esc(f.name)}</b><span>${esc(f.value)}</span></div>`).join('')}`
    + [...n.texts].reverse().map(t => `<p class="lr-q">“${esc(t)}”</p>`).join('') + '</div>';
}
function refreshLora(force = false): void {
  if (state.app !== 'lora') return;
  const now = Date.now();
  if (!force && now - loraUi.drawn < 240) { clearTimeout(loraUi.drawPending); loraUi.drawPending = window.setTimeout(() => refreshLora(true), 250); return; }
  loraUi.drawn = now;
  const snap = loraUi.snap, nodes = snap?.nodes ?? [], msgs = snap?.messages ?? [], pins = loraPins();
  const by = new Map<string, number>(); for (const n of nodes) by.set(n.proto, (by.get(n.proto) ?? 0) + 1);
  const parts = ['Meshtastic', 'MeshCore', 'LoRaWAN'].filter(p => by.has(p)).map(p => `${p.toUpperCase()} ${by.get(p)}`);
  const sum = q('#lr-sum');
  if (sum) sum.innerHTML = parts.length ? `<div>${parts.join(' · ')} · ${snap?.frames ?? 0} frames</div>` : `<div class="muted">${snap && snap.bursts > 0 ? `${snap.bursts} LoRa bursts heard · ${snap.frames} frames` : 'listening for LoRa'}</div>`;
  qa<HTMLButtonElement>('[data-lrview]').forEach(b => { const v = b.dataset.lrview; b.classList.toggle('on', v === loraUi.view); b.textContent = v === 'nodes' ? `NODES ${nodes.length}` : v === 'map' ? `MAP ${pins.length}` : v === 'messages' ? `CHAT ${msgs.length}` : 'LOG'; });
  const cards = q('#lr-cards'), mapEl = q('#lr-map'), chat = q('#lr-msgs'), logEl = q('#lr-log'), nopos = q('#lr-nopos'), det = q('#lr-detail'), stage = q('#lr-stage');
  if (!cards || !mapEl || !chat || !logEl || !nopos || !det || !stage) return;
  cards.hidden = loraUi.view !== 'nodes'; mapEl.hidden = loraUi.view !== 'map'; chat.hidden = loraUi.view !== 'messages';
  logEl.hidden = loraUi.view !== 'log'; stage.hidden = loraUi.view === 'log';
  nopos.hidden = loraUi.view !== 'map' || pins.length > 0;
  const held = paused.has('lora');
  // newest first, and kept on the newest while the reader is at the top (followNewest)
  if (loraUi.view === 'nodes' && !held) followNewest(cards, nodes.length ? [...nodes].sort((a, b) => b.lastMs - a.lastMs).map(n => loraCard(n, now)).join('') : emptyState('lora'), 'cards');
  if (loraUi.view === 'messages' && !held) followNewest(chat, msgs.length ? msgs.map(loraMessage).join('') : emptyState('loramsg'), 'msgs');
  loraPill();
  loraTilesOn();
  const picked = nodes.find(n => n.key === loraUi.sel);
  det.hidden = !picked;
  if (picked) { const top = det.scrollTop; det.innerHTML = loraDetail(picked, pins.some(p => p.id === picked.key)); det.scrollTop = top; }
  if (loraUi.view === 'map') { geo?.invalidate(); geo?.update(pins, loraUi.sel); }
  // the known channels in the span that matter now (always-on, open, heard): lit while heard, with what they decoded
  const ch = q('#lr-chans');
  if (ch) ch.innerHTML = (snap?.channels ?? []).filter(c => c.standing || c.active || c.frames > 0 || (c.hotAgoMs !== null && c.hotAgoMs < 1500)).map(c => { const hot = c.hotAgoMs !== null && c.hotAgoMs < 1500; return `<span class="${c.active && !c.standing ? 'on' : ''} ${hot ? 'hot' : ''}" title="${(c.hz / 1e6).toFixed(4)} MHz${c.standing ? ' · always on' : ''}">${esc(c.name)}${c.frames ? ` · ${c.frames}` : ''}</span>`; }).join('')
    + (snap && snap.busy > 1.05 ? `<span class="warn">behind the radio: ${Math.round(100 * snap.busy)}% of real time</span>` : '');
  if (nodes.length > 0) setLamp(`${nodes.length} NODE${nodes.length === 1 ? '' : 'S'}`, 'ok');
}

// ---- Sondes: weather radiosondes, every type, the whole band
const SONDE_BAND_KEY = 'mm.sondeBand';
const sondeUi = { snap: null as SondeSnap | null, view: 'sondes' as 'sondes' | 'map' | 'log', sel: '', full: false, about: false, drawn: 0, timer: 0, drawPending: 0 };
interface SondeSnap { sondes: SondeRow[]; channels: SondeChannelRow[]; wide: boolean; centerHz: number; band: string; floor: number; window: { ix: number; of: number } | null }
function sondeBandId(): string { try { return localStorage.getItem(SONDE_BAND_KEY) ?? '400'; } catch { return '400'; } }
function sondesOpen(): void {
  const band = SONDE_BANDS.find(b => b.id === sondeBandId()) ?? SONDE_BANDS[0];
  const wide = radioCan(SONDE_WIDE);
  configure('NONE', wide ? sondeWideCenter(band) : sondeWindows(band, SONDE_NARROW)[0], wide ? SONDE_WIDE : SONDE_NARROW, 32, 40, true, 'sonde');
  worker?.postMessage({ type: 'sondeBand', id: band.id });
  requestGeo();
}
function sondeBand(id: string): void {
  try { localStorage.setItem(SONDE_BAND_KEY, id); } catch { /* storage blocked */ }
  const band = SONDE_BANDS.find(b => b.id === id) ?? SONDE_BANDS[0];
  worker?.postMessage({ type: 'sondeBand', id });
  tune(state.rate >= 6_000_000 ? sondeWideCenter(band) : sondeWindows(band, state.rate)[0]);
  render('sondes');
}
/** Great-circle distance (km) and initial bearing (degrees) from a to b. */
function distBearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): [number, number] {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  const km = 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dLon) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(dLon);
  return [km, (Math.atan2(y, x) / r + 360) % 360];
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8];
const sondeMins = (s: number) => s < 90 ? `${Math.max(0, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const SONDE_PHASE: Record<string, string> = { ground: 'ON THE GROUND', ascent: 'CLIMBING', descent: 'FALLING', landed: 'LANDED', '': 'NO FIX YET' };
function sondeFromHere(lat: number, lon: number): string {
  const me = state.home ?? lastKnownPos(); if (!me) return '';
  const [km, brg] = distBearing(me, { lat, lon });
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km ${compass(brg)}`;
}
function sondeCard(s: SondeRow, now: number): string {
  const age = (now - s.lastMs) / 1000, flash = Math.max(0, 1 - age / 0.9), live = age < 60;
  const ago = age < 60 ? `${Math.max(0, Math.floor(age))} s ago` : age < 3600 ? `${Math.floor(age / 60)} min ago` : `${Math.floor(age / 3600)} h ago`;
  const climb = s.climb !== undefined ? `${s.climb >= 0 ? '▲' : '▼'} ${Math.abs(s.climb).toFixed(1)} m/s` : '';
  const ptu = [s.tempC !== undefined ? `${s.tempC.toFixed(1)} °C` : '', s.rh !== undefined ? `${Math.round(s.rh)}% RH` : '', s.hPa !== undefined ? `${s.hPa.toFixed(1)} hPa` : '', s.battV !== undefined ? `${s.battV.toFixed(1)} V` : ''].filter(Boolean).join(' · ');
  const landFrom = s.predict ? sondeFromHere(s.predict.lat, s.predict.lon) : s.lat !== undefined && s.lon !== undefined ? sondeFromHere(s.lat, s.lon) : '';
  const land = s.predict ? `lands in ${sondeMins(s.predict.inS)}${landFrom ? ` · ${landFrom} from you` : ''}` : s.phase === 'landed' ? `down${landFrom ? ` · ${landFrom} from you` : ''}` : '';
  return `<div class="mt-card ${sondeUi.sel === s.serial ? 'sel' : ''} ${live ? '' : 'dim'}" data-sonde="${esc(s.serial)}" data-fk="${esc(s.serial)}" data-fms="${s.lastMs}" style="--flash:${flash.toFixed(2)}">`
    + `<div class="mt-h"><span class="mt-id" style="font-size:${s.serial.length > 8 ? 16 : 20}px">${esc(s.serial)}</span><span class="mt-k"><b>${esc(s.model ?? s.type)}</b><small class="${s.lat !== undefined ? 'pos' : ''}">${esc(SONDE_PHASE[s.phase] ?? '')}${s.burst ? ' · BURST' : ''}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${ago}</span></div>`
    + `<div class="mt-clk"><b>${s.alt !== undefined ? Math.round(s.alt).toLocaleString('en-US') : '—'}</b><small>METERS</small><em>${esc(climb)}</em></div>`
    + `<div class="lr-name">${(s.hz / 1e6).toFixed(3)} MHz · ${s.frames} ${s.frames === 1 ? 'frame' : 'frames'}${s.vH !== undefined ? ` · ${(s.vH * 3.6).toFixed(0)} km/h ${s.heading !== undefined ? compass(s.heading) : ''}` : ''}</div>`
    + (ptu ? `<div class="lr-last">${esc(ptu)}</div>` : '')
    + (land ? `<div class="lr-last">${esc(land)}</div>` : '') + '</div>';
}
/**
 * What SondeHub knows near you. The launch sites fill the LAUNCH SITES panel; the balloons others hear are never shown
 * (the cards and the map are only what our own radio decodes), they only tell a stepping radio which windows to visit.
 */
const sondeNet = { sites: [] as HubSite[], air: [] as HubSonde[], airAt: 0, sitesAt: 0, busy: false, err: '' };
/** The frequencies a stepping radio should visit: every balloon SondeHub reports in the air near you in the last 10 min. */
function sondeNetHints(): void {
  const hz = sondeNet.air.filter(h => h.mhz !== null && Date.now() - h.ms < 600_000).map(h => Math.round(h.mhz! * 1e6));
  worker?.postMessage({ type: 'sondeHints', hz });
}
function sondeNetPoll(): void {
  const me = state.home ?? lastKnownPos(); if (!me || sondeNet.busy) return;
  const now = Date.now();
  if (!sondeNet.sites.length && now - sondeNet.sitesAt > 60_000) {
    sondeNet.sitesAt = now;
    hubSites().then(x => { sondeNet.sites = x; refreshSondes(true); }).catch(e => { sondeNet.err = String(e?.message ?? e); });
  }
  if (now - sondeNet.airAt < 30_000) return;
  sondeNet.airAt = now; sondeNet.busy = true;
  hubSondes(me.lat, me.lon).then(x => {
    sondeNet.air = x; sondeNet.err = '';
    // where they are heard is where a stepping radio should listen
    sondeNetHints();
  })
    .catch(e => { sondeNet.err = String(e?.message ?? e); }).finally(() => { sondeNet.busy = false; });
}
/** The launch sites near you, nearest first, each with its next launch where it lists a schedule. */
function sondeSitesHtml(now: number): string {
  const me = state.home ?? lastKnownPos(); if (!me || !sondeNet.sites.length) return '';
  const near = sondeNet.sites.map(x => ({ x, d: distBearing(me, x) })).filter(v => v.d[0] < 600).sort((a, b) => a.d[0] - b.d[0]).slice(0, 6);
  if (!near.length) return '';
  const rows = near.map(({ x, d }) => {
    const next = nextLaunchMs(x, now);
    const when = next === null ? (x.times.some(t => /irregular|mission/i.test(t)) ? 'launches irregularly' : 'schedule not listed')
      : next <= now ? `<b class="ok">up now · launched ${sondeMins((now - next) / 1000)} ago</b>` : `next launch in ${sondeMins((next - now) / 1000)}`;
    return `<div class="sd-site"><div class="sd-sn"><b>${esc(x.name)}</b><small>${Math.round(d[0])} km ${compass(d[1])} · ${esc(x.types.join(', ') || 'sonde')}</small></div><div class="sd-sw">${when}</div></div>`;
  }).join('');
  return `<div class="sd-sites"><div class="sd-sh">LAUNCH SITES NEAR YOU</div>${rows}</div>`;
}
function sondeDetail(s: SondeRow, onMap: boolean): string {
  const f = (name: string, value: string | undefined | false) => value ? [{ name, value }] : [];
  const fix = s.lat !== undefined && s.lon !== undefined;
  const t = s.timeS !== undefined ? `${String(Math.floor(s.timeS / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s.timeS / 60) % 60).padStart(2, '0')}:${String(Math.floor(s.timeS % 60)).padStart(2, '0')} UTC` : undefined;
  const all = [
    ...f('TYPE', s.model ?? s.type), ...f('FREQUENCY', `${(s.hz / 1e6).toFixed(4)} MHz`), ...f('SIGNAL', `+${s.level} dB`),
    ...f('FIRST HEARD', loraClock(s.firstMs)), ...f('LAST HEARD', loraClock(s.lastMs)), ...f('FRAMES', `${s.frames}`), ...f('FRAME NUMBER', s.frame !== undefined && `${s.frame}`),
    ...f('GPS TIME', t && (s.date ? `${s.date} ${t}` : t)), ...f('FLIGHT', SONDE_PHASE[s.phase]),
    ...f('POSITION', fix && `${s.lat!.toFixed(5)}, ${s.lon!.toFixed(5)}`), ...f('FROM YOU', fix && sondeFromHere(s.lat!, s.lon!)),
    ...f('ALTITUDE', s.alt !== undefined && `${Math.round(s.alt).toLocaleString('en-US')} m`), ...f('HIGHEST', s.maxAlt !== undefined && `${Math.round(s.maxAlt).toLocaleString('en-US')} m`),
    ...f('CLIMB', s.climb !== undefined && `${s.climb >= 0 ? '+' : ''}${s.climb.toFixed(1)} m/s`), ...f('GROUND SPEED', s.vH !== undefined && `${s.vH.toFixed(1)} m/s (${(s.vH * 3.6).toFixed(0)} km/h)`),
    ...f('HEADING', s.heading !== undefined && `${Math.round(s.heading)}° ${compass(s.heading)}`), ...f('SATELLITES', s.sats !== undefined && `${s.sats}`),
    ...f('TEMPERATURE', s.tempC !== undefined && `${s.tempC.toFixed(1)} °C`), ...f('HUMIDITY', s.rh !== undefined && `${s.rh.toFixed(0)} %`), ...f('PRESSURE', s.hPa !== undefined && `${s.hPa.toFixed(1)} hPa`),
    ...f('BATTERY', s.battV !== undefined && `${s.battV.toFixed(1)} V`), ...f('BURST TIMER', s.killS !== undefined && sondeMins(s.killS)),
    ...f('BURST', s.burst && `${Math.round(s.burst.alt).toLocaleString('en-US')} m at ${loraClock(s.burst.ms)}`),
    ...f('PREDICTED LANDING', s.predict && `${s.predict.lat.toFixed(4)}, ${s.predict.lon.toFixed(4)} in ${sondeMins(s.predict.inS)}`),
    ...f('LANDING FROM YOU', s.predict && sondeFromHere(s.predict.lat, s.predict.lon)),
    ...f('ASSUMED BURST', s.predict && s.phase === 'ascent' && `${s.predict.burstAlt.toLocaleString('en-US')} m`),
    ...f('ERRORS FIXED', s.fixed > 0 && `${s.fixed}`), ...s.fields];
  return `<div class="mt-dh"><b>${esc(s.serial)}</b><span>${esc(`${s.model ?? s.type} · ${SONDE_PHASE[s.phase] ?? ''}`)}</span>${onMap ? '<button class="chip" data-sdo="map">MAP</button>' : ''}${sondeUi.view !== 'sondes' ? '<button class="chip" data-sdo="cards">CARDS</button>' : ''}<button class="chip" data-sdo="close">✕</button></div>`
    + `<div class="mt-fields">${all.map(x => `<div><b>${esc(x.name)}</b><span>${esc(x.value)}</span></div>`).join('')}</div>`;
}
/** What Sondes hears and how, as a short labeled panel instead of a paragraph. */
const SONDE_ABOUT = `<div class="sd-about">
  <div class="sd-types">${['RS41', 'RS92', 'DFM', 'M10', 'M20', 'iMet-1', 'iMet-4', 'iMet-54', 'LMS6', 'Meisei', 'MRZ', 'MTS01'].map(t => `<span>${t}</span>`).join('')}<em>all decoded on their own, no type to pick</em></div>
  <div class="sd-ab"><b>WHEN</b><span>twice a day, about an hour before 00:00 and 12:00 UTC</span></div>
  <div class="sd-ab"><b>HACKRF</b><span>watches all of 400–406 MHz at once</span></div>
  <div class="sd-ab"><b>RTL-SDR</b><span>steps across the band and stays on a sonde once it decodes</span></div>
  <div class="sd-ab"><b>1680 MHz</b><span>the older US LMS6 band</span></div>
  <div class="sd-ab"><b>LANDING</b><span>bursts near 30 km, then drifts on the winds it measured going up</span></div>
</div>`;
function renderSondes(view: HTMLElement): void {
  const bandId = sondeBandId();
  view.innerHTML = `
    <section class="${visCls('sondes')}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="sd-sum" class="mt-sum"></div>
      <div class="ctlrow">${segHtml(['sondes', 'map', 'log'].map(v => `<button data-sdview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('sondes')}<button id="sd-full" class="ib" title="full screen" aria-label="full screen">${sondeUi.full ? EXIT_SVG : FULL_SVG}</button>${pauseClearHtml('sondes')}</div>
      <div id="sd-stage" class="mt-stage"><div id="sd-cards" class="mt-cards"></div><div id="sd-map" class="panel map"></div><div id="sd-nopos" class="mt-nopos">no positions yet</div><div id="sd-detail" class="mt-detail" hidden></div><button id="sd-newpill" class="lr-newpill" hidden></button></div>
      <div id="sd-log">${logHtml('sondes', 'listening for sondes…')}</div>
      <div id="sd-chans" class="lr-chans"></div>
      <div class="ctlrow"><span class="rl">BAND</span>${segHtml(SONDE_BANDS.map(b => `<button data-sdband="${b.id}" class="${b.id === bandId ? 'on' : ''}">${b.title}</button>`))}<button id="sd-info" class="ib" title="about Sondes" aria-label="about Sondes" hidden>ⓘ</button></div>
      <div id="sd-about">${SONDE_ABOUT}</div>
      </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-sdview]', view).forEach(b => b.onclick = () => { sondeUi.view = b.dataset.sdview as typeof sondeUi.view; refreshSondes(true); });
  qa<HTMLButtonElement>('[data-sdband]', view).forEach(b => b.onclick = () => sondeBand(b.dataset.sdband!));
  $('sd-info').onclick = () => { sondeUi.about = !sondeUi.about; refreshSondes(true); };
  $('sd-newpill').onclick = () => q('#sd-cards')?.scrollTo({ top: 0, behavior: 'smooth' });
  $('sd-full').onclick = () => setSondeFull(!sondeUi.full);
  $('sd-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-sonde]'); if (c) { sondeUi.sel = sondeUi.sel === c.dataset.sonde ? '' : c.dataset.sonde!; refreshSondes(true); } };
  $('sd-cards').onscroll = () => sondePill();
  $('sd-detail').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sdo]'); if (!b) return;
    const what = b.dataset.sdo;
    if (what === 'close') sondeUi.sel = '';
    else if (what === 'map') {
      sondeUi.view = 'map'; refreshSondes(true);
      const s = sondeUi.snap?.sondes.find(x => x.serial === sondeUi.sel);
      if (s && s.lat !== undefined && s.lon !== undefined) geo?.center(s.lat, s.lon, 11);
      return;
    } else if (what === 'cards') sondeUi.view = 'sondes';
    refreshSondes(true);
  };
  view.classList.toggle('sondefull', sondeUi.full);
  geo = new GeoMap($('sd-map'), { home: state.home, start: mapStart(state.home), onPick: id => { sondeUi.sel = id.replace(/^(land|burst):/, ''); refreshSondes(true); }, log });
  clearInterval(sondeUi.timer);
  sondeUi.timer = window.setInterval(() => { if (state.app !== 'sondes') { clearInterval(sondeUi.timer); return; } sondeNetPoll(); refreshSondes(); }, 1000);
  sondeNetPoll();
  refreshSondes(true);
}
function setSondeFull(on: boolean): void {
  sondeUi.full = on;
  const v = q('.view.sondes'); if (!v) return;
  v.classList.toggle('sondefull', on);
  const b = q('#sd-full'); if (b) { b.innerHTML = on ? EXIT_SVG : FULL_SVG; b.title = on ? 'leave full screen' : 'full screen'; }
  refreshSondes(true);
  requestAnimationFrame(() => geo?.invalidate());
}
/** The "↑ N NEW" pill over the cards while they are scrolled away from the top. */
function sondePill(): void {
  const pill = q<HTMLButtonElement>('#sd-newpill'), el = q('#sd-cards'); if (!pill) return;
  if (sondeUi.view !== 'sondes' || !el || el.scrollTop < 24) {
    pill.hidden = true;
    if (el) loraFollow.sondes = Array.from(el.querySelectorAll<HTMLElement>('[data-fk]')).reduce((m, c) => Math.max(m, Number(c.dataset.fms) || 0), 0);
    return;
  }
  const fresh = Array.from(el.querySelectorAll<HTMLElement>('[data-fk]')).filter(c => Number(c.dataset.fms) > loraFollow.sondes).length;
  pill.textContent = fresh > 0 ? `↑ ${fresh} NEW` : '↑ NEWEST';
  pill.hidden = false;
}
function refreshSondes(force = false): void {
  if (state.app !== 'sondes') return;
  const now = Date.now();
  if (!force && now - sondeUi.drawn < 240) { clearTimeout(sondeUi.drawPending); sondeUi.drawPending = window.setTimeout(() => refreshSondes(true), 250); return; }
  sondeUi.drawn = now;
  const snap = sondeUi.snap, sondes = snap?.sondes ?? [];
  if (sondeUi.full && sondeUi.view === 'log') sondeUi.view = 'sondes';
  const withPos = sondes.filter(s => s.lat !== undefined && s.lon !== undefined);
  const sum = q('#sd-sum');
  if (sum) {
    const band = SONDE_BANDS.find(b => b.id === (snap?.band ?? sondeBandId())) ?? SONDE_BANDS[0];
    const hunt = !snap ? 'waiting for the radio' : snap.wide ? `watching ${band.title}` : `stepping ${band.title} · window ${(snap.window?.ix ?? 0) + 1} of ${snap.window?.of ?? 1}`;
    sum.innerHTML = sondes.length ? `<div>${sondes.length} SONDE${sondes.length === 1 ? '' : 'S'} · ${esc(hunt)}</div>` : `<div class="muted">${esc(hunt)}${snap?.channels.length ? ` · trying ${snap.channels.length} carrier${snap.channels.length === 1 ? '' : 's'}` : ''}</div>`;
  }
  qa<HTMLButtonElement>('[data-sdview]').forEach(b => { const v = b.dataset.sdview; b.classList.toggle('on', v === sondeUi.view); b.textContent = v === 'sondes' ? `SONDES ${sondes.length}` : v === 'map' ? `MAP ${withPos.length}` : 'LOG'; b.hidden = v === 'log' && sondeUi.full; });
  const cards = q('#sd-cards'), mapEl = q('#sd-map'), logEl = q('#sd-log'), nopos = q('#sd-nopos'), det = q('#sd-detail'), stage = q('#sd-stage');
  if (!cards || !mapEl || !logEl || !nopos || !det || !stage) return;
  cards.hidden = sondeUi.view !== 'sondes'; mapEl.hidden = sondeUi.view !== 'map';
  logEl.hidden = sondeUi.view !== 'log'; stage.hidden = sondeUi.view === 'log';
  nopos.hidden = sondeUi.view !== 'map' || withPos.length > 0 || sondeNet.sites.length > 0;
  // only what our own radio decodes, then the launch sites near you
  const body = sondes.map(s => sondeCard(s, now)).join('');
  if (sondeUi.view === 'sondes' && !paused.has('sondes')) followNewest(cards, (body || emptyState('sondes')) + sondeSitesHtml(now), 'sondes');
  sondePill();
  const picked = sondes.find(s => s.serial === sondeUi.sel);
  det.hidden = !picked;
  if (picked) { const top = det.scrollTop; det.innerHTML = sondeDetail(picked, picked.lat !== undefined); det.scrollTop = top; }
  if (sondeUi.view === 'map') {
    geo?.invalidate();
    const items: GeoItem[] = [];
    const paths: { pts: [number, number][]; dashed?: boolean; faint?: boolean }[] = [];
    for (const s of withPos) {
      const mine = !sondeUi.sel || s.serial === sondeUi.sel;
      items.push({ id: s.serial, lat: s.lat!, lon: s.lon!, label: `${s.serial}${s.alt !== undefined ? ` ${(s.alt / 1000).toFixed(1)} km` : ''}`, kind: 'sonde' });
      paths.push({ pts: s.track.map(p => [p[0], p[1]] as [number, number]), faint: !mine });
      if (s.burst) items.push({ id: `burst:${s.serial}`, lat: s.burst.lat, lon: s.burst.lon, label: 'BURST', kind: 'burst' });
      if (s.predict && mine) { paths.push({ pts: s.predict.path, dashed: true }); items.push({ id: `land:${s.serial}`, lat: s.predict.lat, lon: s.predict.lon, label: `${s.serial} lands`, kind: 'landing' }); }
    }
    const me = state.home ?? lastKnownPos();
    if (me) for (const x of sondeNet.sites) if (distBearing(me, x)[0] < 600) items.push({ id: `site:${x.id}`, lat: x.lat, lon: x.lon, label: x.name, kind: 'station' });
    geo?.setPaths(paths);
    geo?.update(items, sondeUi.sel);
  }
  // the about panel is for an empty screen; once a balloon shows up it folds behind the info button
  const found = sondes.length > 0;
  const ab = q('#sd-about'), ib = q('#sd-info');
  if (ab) ab.hidden = found && !sondeUi.about;
  if (ib) { ib.hidden = !found; ib.classList.toggle('on', sondeUi.about); }
  const ch = q('#sd-chans');
  if (ch) ch.innerHTML = (snap?.channels ?? []).map(c => `<span class="${c.decoding ? 'on hot' : ''}" title="+${c.level} dB">${(c.hz / 1e6).toFixed(3)}${c.decoding ? ` · ${esc(c.decoding)}` : ''}${c.frames ? ` · ${c.frames}` : ''}</span>`).join('');
  if (sondes.length > 0) setLamp(`${sondes.length} SONDE${sondes.length === 1 ? '' : 'S'}`, 'ok');
}

// ---- UAT (978 MHz): FIS-B weather from the FAA's ground towers, and the aircraft that broadcast on 978 ----
type UatView = 'map' | 'weather' | 'notices' | 'traffic' | 'log';
const uatUi = { view: 'map' as UatView, sel: '', timer: 0, drawn: 0, pending: 0, radarAt: 0, radarDirty: true,
  layers: { radar: true, national: true, tops: false, turb: false, ice: false, lightning: true, gairmet: true, traffic: true, airports: true },
  /** The altitude icing and turbulence are drawn at, ft (2,000 to 24,000). */
  altFt: 8000, tap: null as [number, number] | null };
/** The gridded hazards' colors by value: icing by severity, turbulence and cloud tops by level, lightning. */
const UAT_ICE = ['', '#9fd9ff', '#5fb4ff', '#2f7dff', '#5a3dff', '#b04dff', '', ''];
const UAT_TURB = ['', '', '#f8c63c', '#f8a33a', '#f4793a', '#ef4c3c', '#e2304e', '#d02a6e', '#bd2c8e', '#a63aa8', '#8f4bc0', '#7a5cd4', '#6a6ae0', '#5d75e8', '#5d75e8', ''];
const UAT_TOPS = ['', '#d8e6ff', '#c3d6ff', '#adc6ff', '#97b5ff', '#81a4ff', '#6c93ff', '#5a82f4', '#4d71e0', '#4361cc', '#3a52b8', '#3245a4', '#2b3990', '#252f7c', '#252f7c', ''];
const UAT_LIGHTNING = ['', '#fff35c', '#fff35c', '#ffe14a', '#ffe14a', '#ffce38', '#ffce38', '#ffba26', '#ffba26', '#ffa614', '#ffa614', '#ff9200', '#ff9200', '#ff7e00', '#ff7e00', ''];
/** G-AIRMET kinds by element number, with their map colors. */
const UAT_GAIRMET: Record<number, [string, string]> = { 1: ['TURBULENCE', '#f39a1c'], 2: ['LOW-LEVEL WIND SHEAR', '#ff7ad9'], 3: ['SURFACE WIND', '#a07cff'], 4: ['ICING', '#4aa3ff'],
  5: ['FREEZING LEVEL', '#7fd6ff'], 6: ['IFR', '#ff5b52'], 7: ['MOUNTAIN OBSCURATION', '#d562ff'] };
const UAT_ICE_WORD = ['none', 'trace', 'light', 'moderate', 'severe', 'heavy', '', 'no data'];
type UatShape = Overlay & { key: string; at: number };
type UatPlane = UatTarget & { at: number; first: number; frames: number; track: [number, number][] };
interface UatText { kind: string; station: string; text: string; at: number }
const uatData = {
  towers: new Map<string, { lat: number; lon: number; at: number; frames: number }>(),
  regional: new Map<number, RadarBlock>(), national: new Map<number, RadarBlock>(),
  /** Every regional block the tower has reported, clear ones too: the national radar is drawn only outside them. */
  regionalSeen: new Set<number>(),
  radarTime: '', radarAt: 0,
  metars: new Map<string, { m: Metar; at: number }>(),
  texts: new Map<string, UatText>(),
  products: new Map<number, number>(),
  /** Icing, turbulence, cloud tops and lightning blocks by product, keyed level:block, and each product's time. */
  hazards: new Map<number, Map<string, HazardBlock>>(), hazardTime: new Map<number, string>(),
  /** G-AIRMETs and other drawn hazards. */
  shapes: new Map<string, UatShape>(),
  planes: new Map<string, UatPlane>(),
  up: 0, down: 0, bad: 0, firstAt: 0,
};
/** Airport positions for the weather markers (ICAO id to latitude, longitude and name), loaded once when present. */
let uatAirports: Map<string, [number, number, string]> | null = null;
function uatLoadAirports(): void {
  if (uatAirports) return;
  uatAirports = new Map();
  fetch('assets/airports.json').then(r => (r.ok ? r.json() : null)).then((rows: [string, number, number, string][] | null) => {
    if (!rows) return;
    for (const [id, la, lo, name] of rows) uatAirports!.set(id, [la, lo, name]);
    refreshUat(true); refreshAcars(true);
  }).catch(() => undefined);
}
const UAT_PRODUCT: Record<number, string> = { 8: 'notices', 11: 'AIRMET', 12: 'SIGMET', 13: 'special use airspace', 14: 'G-AIRMET', 15: 'center weather', 16: 'notices', 17: 'notices',
  19: 'TFR', 63: 'regional radar', 64: 'national radar', 70: 'icing, low', 71: 'icing, high', 84: 'cloud tops', 90: 'turbulence, low', 91: 'turbulence, high', 103: 'lightning', 413: 'weather text' };
/** Radar intensity 2-7 as colors. Level 1 is not drawn: on the national product it fills whole regions out to the edge
 *  of radar coverage, so it reads as "covered, nothing there" rather than rain (to confirm against the standard). */
const UAT_RADAR = ['', '', '#3ddc84', '#1e9e4b', '#f2df34', '#f39a1c', '#e5382b', '#c42597'];
const UAT_CAT: Record<string, string> = { VFR: '#3ddc84', MVFR: '#4aa3ff', IFR: '#ff5b52', LIFR: '#d562ff' };
const uatClock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
function uatLog(line: string): void {
  const list = (logs.uat ??= []);
  list.unshift(`${uatClock(Date.now())} ${line}`); if (list.length > 300) list.length = 300;
  counts.uat = (counts.uat ?? 0) + 1;
}
function uatOnUp(msg: Uint8Array): void {
  const now = Date.now();
  uatData.up++; if (!uatData.firstAt) uatData.firstAt = now;
  const st = stationOf(msg);
  const key = `${st.lat.toFixed(3)},${st.lon.toFixed(3)}`;
  const tw = uatData.towers.get(key);
  if (!tw) uatLog(`TOWER FIS-B ground station at ${st.lat.toFixed(4)}, ${st.lon.toFixed(4)}`);
  uatData.towers.set(key, { lat: st.lat, lon: st.lon, at: now, frames: (tw?.frames ?? 0) + 1 });
  const got: string[] = [];
  for (const p of productsOf(msg)) {
    uatData.products.set(p.id, (uatData.products.get(p.id) ?? 0) + 1);
    if (p.id === 63 || p.id === 64) {
      const map = p.id === 63 ? uatData.regional : uatData.national;
      for (const b of radarBlocks(p)) { if (p.id === 63 && b.scale === 0) uatData.regionalSeen.add(b.block); if (b.bins) map.set(b.block, b); else map.delete(b.block); }
      uatData.radarTime = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}Z`; uatData.radarAt = now; uatUi.radarDirty = true;
      continue;
    }
    if (p.id === 70 || p.id === 71 || p.id === 84 || p.id === 90 || p.id === 91 || p.id === 103) {
      const map = uatData.hazards.get(p.id) ?? new Map<string, HazardBlock>(); uatData.hazards.set(p.id, map);
      for (const b of hazardBlocks(p)) { const k = `${b.level}:${b.block}`; if (b.bins) map.set(k, b); else map.delete(k); }
      uatData.hazardTime.set(p.id, `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}Z`); uatUi.radarDirty = true;
      continue;
    }
    if ((p.id === 14 || p.id === 8 || (p.id >= 11 && p.id <= 17)) && p.payload[0] >> 4 === 8) {
      const o = overlayOf(p);
      if (o && o.pts.length > 1) {
        const key = `${o.product}:${o.location}:${o.report}:${o.element}:${o.start?.day}.${o.start?.hh}`;
        if (!uatData.shapes.has(key)) got.push(p.id === 14 ? `G-AIRMET ${UAT_GAIRMET[o.element]?.[0] ?? ''}`.trim() : 'AREA');
        uatData.shapes.set(key, { ...o, key, at: now });
        if (uatData.shapes.size > 1500) uatData.shapes.delete(uatData.shapes.keys().next().value!);
      }
      continue;
    }
    const t = textOf(p.payload);
    if (!t) continue;
    if (t.startsWith('METAR') || t.startsWith('SPECI')) {
      const m = parseMetar(t);
      if (m) { if (!uatData.metars.has(m.station)) got.push(`METAR ${m.station}`); uatData.metars.set(m.station, { m, at: now }); }
      continue;
    }
    const kind = t.split(/[\s.]/)[0];
    const station = /^(?:NOTAM-\w+\s+)?K?([A-Z0-9]{3,4})\b/.exec(t.replace(/^\S+\s+/, ''))?.[1] ?? '';
    const k = t.slice(0, 64);
    if (!uatData.texts.has(k)) got.push(kind);
    uatData.texts.set(k, { kind, station, text: t, at: now });
    if (uatData.texts.size > 600) uatData.texts.delete(uatData.texts.keys().next().value!);
  }
  if (got.length) uatLog(`FISB ${got.slice(0, 6).join(' · ')}${got.length > 6 ? ` +${got.length - 6}` : ''}`);
}
function uatOnDown(bytes: Uint8Array): void {
  const now = Date.now();
  uatData.down++;
  const t = decodeDownlink(bytes);
  const was = uatData.planes.get(t.address);
  const p: UatPlane = { ...(was ?? { first: now, frames: 0, track: [] }), ...Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)) as UatTarget, at: now, frames: (was?.frames ?? 0) + 1 } as UatPlane;
  if (t.lat !== undefined && t.lon !== undefined) {
    const last = p.track[p.track.length - 1];
    if (!last || Math.abs(last[0] - t.lat) + Math.abs(last[1] - t.lon) > 0.002) { p.track.push([t.lat, t.lon]); if (p.track.length > 400) p.track.shift(); }
  }
  uatData.planes.set(t.address, p);
  if (!was) uatLog(`AIRCRAFT ${p.callsign ?? p.address} · ${uatSource(p.qualifier)}${p.altFt !== undefined ? ` · ${p.altFt.toLocaleString('en-US')} ft` : ''}`);
}
const uatSource = (q: number) => ['UAT', 'UAT', 'TIS-B', 'TIS-B', 'vehicle', 'beacon', 'ADS-R', '?'][q] ?? '?';
function uatAge(ms: number, now: number): string {
  const s = (now - ms) / 1000;
  return s < 60 ? `${Math.max(0, Math.floor(s))} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}
function uatFromHere(lat: number, lon: number): { km: number; text: string } | null {
  const me = state.home ?? lastKnownPos(); if (!me) return null;
  const [km, brg] = distBearing(me, { lat, lon });
  return { km, text: `${Math.round(km * 0.621371)} mi ${compass(brg)}` };
}
function uatOpen(): void {
  configure('NONE', 978_000_000, 2e6, 32, 32, true, 'uat');
  requestGeo(); uatLoadAirports();
}
function uatPlainWx(m: Metar): string {
  const parts: string[] = [];
  if (m.windKt !== undefined) parts.push(m.windKt === 0 ? 'calm' : `wind ${m.windDir !== undefined ? `${String(m.windDir).padStart(3, '0')}°` : 'variable'} ${m.windKt} kt${m.gustKt ? ` gusting ${m.gustKt}` : ''}`);
  if (m.visSm !== undefined) parts.push(`${m.visSm >= 10 ? '10+' : m.visSm} mi`);
  parts.push(m.sky.length ? m.sky.join(' · ').toLowerCase() : 'sky not reported');
  if (m.wx.length) parts.push(m.wx.join(' '));
  return parts.join(' · ');
}
function uatWxCard(id: string, m: Metar, at: number, now: number): string {
  const ap = uatAirports?.get(id);
  const from = ap ? uatFromHere(ap[0], ap[1]) : null;
  const cat = m.category ?? '';
  const f = (c: number) => Math.round(c * 9 / 5 + 32);
  return `<div class="mt-card ua-wx ${uatUi.sel === `wx:${id}` ? 'sel' : ''}" data-ua="wx:${esc(id)}" style="--cat:${UAT_CAT[cat] ?? 'var(--muted)'}">`
    + `<div class="mt-h"><span class="mt-id">${esc(id)}</span><span class="mt-k"><b>${esc(ap?.[2] ?? '')}</b><small>${m.hh !== undefined ? `${String(m.hh).padStart(2, '0')}:${String(m.mm).padStart(2, '0')}Z · ` : ''}${uatAge(at, now)}${from ? ` · ${from.text}` : ''}</small></span>${cat ? `<span class="ua-cat">${cat}</span>` : ''}</div>`
    + `<div class="mt-clk"><b>${m.tempC !== undefined ? `${f(m.tempC)}°` : '—'}</b><small>F${m.tempC !== undefined ? ` · ${m.tempC}°C` : ''}${m.dewC !== undefined ? ` · dew ${f(m.dewC)}°` : ''}</small><em>${m.altimInHg !== undefined ? `${m.altimInHg.toFixed(2)} inHg` : ''}</em></div>`
    + `<div class="lr-name">${esc(uatPlainWx(m))}</div>`
    + `<div class="lr-last ua-raw">${esc(m.raw)}</div></div>`;
}
function uatTextCard(t: UatText, now: number): string {
  return `<div class="mt-card ua-tx"><div class="mt-h"><span class="mt-id ua-kind">${esc(t.kind)}</span><span class="mt-k"><b>${esc(t.station || ' ')}</b><small>${uatAge(t.at, now)}</small></span></div>`
    + `<div class="ua-text">${esc(t.text.replace(/\n/g, ' '))}</div></div>`;
}
function uatPlaneCard(p: UatPlane, now: number): string {
  const from = p.lat !== undefined && p.lon !== undefined ? uatFromHere(p.lat, p.lon) : null;
  const live = now - p.at < 30_000;
  const vs = p.vertFpm ? `${p.vertFpm > 0 ? '▲' : '▼'} ${Math.abs(p.vertFpm).toLocaleString('en-US')} ft/min` : 'level';
  return `<div class="mt-card ${uatUi.sel === `ac:${p.address}` ? 'sel' : ''} ${live ? '' : 'dim'}" data-ua="ac:${esc(p.address)}">`
    + `<div class="mt-h"><span class="mt-id">${esc(p.callsign ?? p.address)}</span><span class="mt-k"><b>${uatSource(p.qualifier)}</b><small>${esc(p.address)}</small></span><span class="mt-live ${live ? 'on' : ''}"><i></i>${uatAge(p.at, now)}</span></div>`
    + `<div class="mt-clk"><b>${p.altFt !== undefined ? p.altFt.toLocaleString('en-US') : '—'}</b><small>FT${p.onGround ? ' · ON THE GROUND' : ''}</small><em>${esc(vs)}</em></div>`
    + `<div class="lr-name">${p.speedKt !== undefined ? `${p.speedKt} kt` : 'speed —'}${p.trackDeg !== undefined ? ` · heading ${p.trackDeg}° ${compass(p.trackDeg)}` : ''}</div>`
    + (from ? `<div class="lr-last">${esc(from.text)} from you</div>` : '') + '</div>';
}
function uatDetail(now: number): string {
  const [kind, id] = [uatUi.sel.slice(0, 2), uatUi.sel.slice(3)];
  const row = (k: string, v: string | undefined | false) => (v ? `<div><b>${k}</b><span>${esc(v)}</span></div>` : '');
  const close = '<button class="chip" data-uao="map">MAP</button><button class="chip" data-uao="close">✕</button>';
  if (kind === 'wx') {
    const e = uatData.metars.get(id); if (!e) return '';
    const m = e.m, ap = uatAirports?.get(id);
    const tafs = [...uatData.texts.values()].filter(t => t.kind === 'TAF' && t.text.includes(id));
    const notes = [...uatData.texts.values()].filter(t => t.kind.startsWith('NOTAM') && t.station === id.slice(1)).slice(0, 6);
    return `<div class="mt-dh"><b>${esc(id)}</b><span>${esc(ap?.[2] ?? '')}${m.category ? ` · ${m.category}` : ''}</span>${close}</div>`
      + `<div class="mt-fields">${row('Observed', m.hh !== undefined ? `${String(m.hh).padStart(2, '0')}:${String(m.mm).padStart(2, '0')} UTC · ${uatAge(e.at, now)}` : uatAge(e.at, now))}${row('Wind', m.windKt === 0 ? 'calm' : m.windKt !== undefined ? `${m.windDir ?? 'variable'}° at ${m.windKt} kt${m.gustKt ? `, gusts ${m.gustKt}` : ''}` : undefined)}`
      + `${row('Visibility', m.visSm !== undefined ? `${m.visSm} statute miles` : undefined)}${row('Sky', m.sky.join(', ') || undefined)}${row('Weather', m.wx.join(' ') || undefined)}`
      + `${row('Temperature', m.tempC !== undefined ? `${m.tempC} °C · ${Math.round(m.tempC * 9 / 5 + 32)} °F` : undefined)}${row('Dew point', m.dewC !== undefined ? `${m.dewC} °C` : undefined)}${row('Altimeter', m.altimInHg !== undefined ? `${m.altimInHg.toFixed(2)} inHg` : undefined)}</div>`
      + `<div class="ua-text">${esc(m.raw)}</div>` + tafs.map(t => `<div class="ua-text"><b>TAF</b> ${esc(t.text)}</div>`).join('') + notes.map(t => `<div class="ua-text"><b>${esc(t.kind)}</b> ${esc(t.text)}</div>`).join('');
  }
  if (kind === 'ac') {
    const p = uatData.planes.get(id); if (!p) return '';
    const from = p.lat !== undefined && p.lon !== undefined ? uatFromHere(p.lat, p.lon) : null;
    return `<div class="mt-dh"><b>${esc(p.callsign ?? p.address)}</b><span>${uatSource(p.qualifier)} · ${esc(p.address)}</span>${close}</div>`
      + `<div class="mt-fields">${row('Altitude', p.altFt !== undefined ? `${p.altFt.toLocaleString('en-US')} ft (${p.altGeo ? 'GPS' : 'pressure'})` : undefined)}${row('Speed', p.speedKt !== undefined ? `${p.speedKt} kt` : undefined)}`
      + `${row('Heading', p.trackDeg !== undefined ? `${p.trackDeg}° ${compass(p.trackDeg)}` : undefined)}${row('Vertical', p.vertFpm !== undefined ? `${p.vertFpm > 0 ? '+' : ''}${p.vertFpm.toLocaleString('en-US')} ft/min` : undefined)}`
      + `${row('Position', p.lat !== undefined ? `${p.lat.toFixed(4)}, ${p.lon!.toFixed(4)}` : undefined)}${row('From you', from?.text)}${row('First heard', uatClock(p.first))}${row('Frames', `${p.frames}`)}</div>`;
  }
  if (kind === 'pt') { const [la, lo] = id.split(',').map(Number); return uatPointDetail(la, lo); }
  if (kind === 'gm') {
    const sh = uatData.shapes.get(id); if (!sh) return '';
    const [name, color] = UAT_GAIRMET[sh.element] ?? ['AREA', '#ff5b52'];
    const c = sh.pts.reduce((a, p) => [a[0] + p[0] / sh.pts.length, a[1] + p[1] / sh.pts.length], [0, 0]);
    const from = uatFromHere(c[0], c[1]);
    return `<div class="mt-dh"><b style="color:${color}">${sh.product === 14 ? 'G-AIRMET' : 'AREA'}</b><span>${esc(name)}</span>${close}</div>`
      + `<div class="mt-fields">${row('Valid', uatValid(sh))}${row(sh.element === 5 && sh.line ? 'Freezing level' : sh.element >= 5 ? 'What' : 'Altitude', uatAltText(sh))}`
      + `${row('Shape', `${sh.line ? 'line' : 'area'} · ${sh.pts.length} points`)}${row('Center', `${c[0].toFixed(3)}, ${c[1].toFixed(3)}`)}${row('From you', from?.text)}`
      + `${row('Report', sh.report ? `#${sh.report}` : undefined)}${row('Heard', uatAge(sh.at, now))}</div>`;
  }
  if (kind === 'tw') {
    const t = uatData.towers.get(id); if (!t) return '';
    const from = uatFromHere(t.lat, t.lon);
    return `<div class="mt-dh"><b>FIS-B</b><span>ground station</span>${close}</div><div class="mt-fields">${row('Position', `${t.lat.toFixed(4)}, ${t.lon.toFixed(4)}`)}${row('From you', from?.text)}${row('Frames', `${t.frames}`)}${row('Last heard', uatAge(t.at, now))}</div>`
      + `<div class="mt-fields">${[...uatData.products.entries()].sort((x, y) => y[1] - x[1]).map(([id, c]) => row(UAT_PRODUCT[id] ?? `product ${id}`, `${c}`)).join('')}</div>`;
  }
  return '';
}
const UAT_LAYERS: [keyof typeof uatUi.layers, string][] = [['radar', 'RADAR'], ['national', 'NATIONAL'], ['tops', 'CLOUD TOPS'], ['turb', 'TURBULENCE'], ['ice', 'ICING'],
  ['lightning', 'LIGHTNING'], ['gairmet', 'G-AIRMET'], ['traffic', 'TRAFFIC'], ['airports', 'AIRPORTS']];
/** The color keys for what is switched on: radar, then each hazard grid, each a short ramp with its words. */
function uatLegendHtml(): string {
  const ramp = (cols: string[], lo: string, hi: string, name: string) => `<span class="ua-ramp"><b>${name}</b>${cols.map(c => `<i style="background:${c}"></i>`).join('')}<small>${lo} → ${hi}</small></span>`;
  const out: string[] = [];
  if (uatUi.layers.radar) out.push(ramp(UAT_RADAR.slice(2), 'light', 'heavy', 'RAIN / SNOW'));
  if (uatUi.layers.tops) out.push(ramp(UAT_TOPS.slice(1, 14).filter((_, i) => i % 3 === 0), 'low', 'high', 'TOPS'));
  if (uatUi.layers.turb) out.push(ramp(UAT_TURB.slice(1, 14).filter((_, i) => i % 3 === 0), 'light', 'severe', 'TURB'));
  if (uatUi.layers.ice) out.push(ramp(UAT_ICE.slice(1, 6), 'trace', 'heavy', 'ICE'));
  return out.join('');
}
/** A desktop-size window: the map takes the big pane on the left (where the waterfall goes in other apps), the
 *  cards, log and detail share the column on the right, so nothing ever sits on top of the map. */
const UAT_WIDE = window.matchMedia('(min-width: 1000px)');
UAT_WIDE.addEventListener('change', () => { if (state.app === 'uat') { const v = q<HTMLElement>('main#view'); if (v) renderUat(v); } });
function renderUat(view: HTMLElement): void {
  const wide = UAT_WIDE.matches;
  if (wide && uatUi.view === 'map') uatUi.view = 'weather';
  view.classList.toggle('uawide', wide);
  const layersHtml = `<div id="ua-layers" class="ua-layers"><div class="ua-chips">${UAT_LAYERS.map(([k, label]) => `<button class="chip ${uatUi.layers[k] ? 'on' : ''}" data-ualayer="${k}">${label}</button>`).join('')}<select id="ua-alt" class="ua-alt" title="altitude for icing and turbulence">${Array.from({ length: 12 }, (_, i) => (i + 1) * 2000).map(a => `<option value="${a}" ${a === uatUi.altFt ? 'selected' : ''}>${a.toLocaleString('en-US')} FT</option>`).join('')}</select></div><span id="ua-legend" class="ua-legend"></span></div>`;
  const tabs = (wide ? ['weather', 'notices', 'traffic', 'log'] : ['map', 'weather', 'notices', 'traffic', 'log']) as UatView[];
  view.innerHTML = wide ? `
    <section class="${visCls('uat')}">${readoutHtml()}<div id="ua-mapbox" class="ua-mapbox">${layersHtml}<div id="ua-map" class="panel map"></div></div><div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="ua-sum" class="mt-sum"></div>
      <div class="ctlrow">${segHtml(tabs.map(v => `<button data-uaview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('uat')}${pauseClearHtml('uat')}</div>
      <div id="ua-detail" class="mt-detail ua-dock" hidden></div>
      <div id="ua-stage" class="mt-stage"><div id="ua-cards" class="mt-cards"></div></div>
      <div id="ua-log">${logHtml('uat', 'listening for FIS-B…')}</div>
    </section>` : `
    <section class="${visCls('uat')}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div id="ua-sum" class="mt-sum"></div>
      <div class="ctlrow">${segHtml(tabs.map(v => `<button data-uaview="${v}">${v.toUpperCase()}</button>`))}${wfHtml('uat')}${pauseClearHtml('uat')}</div>
      ${layersHtml}
      <div id="ua-stage" class="mt-stage"><div id="ua-map" class="panel map"></div><div id="ua-cards" class="mt-cards"></div><div id="ua-detail" class="mt-detail" hidden></div></div>
      <div id="ua-log">${logHtml('uat', 'listening for FIS-B…')}</div>
    </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-uaview]', view).forEach(b => b.onclick = () => { uatUi.view = b.dataset.uaview as UatView; refreshUat(true); });
  qa<HTMLButtonElement>('[data-ualayer]', view).forEach(b => b.onclick = () => {
    const k = b.dataset.ualayer as keyof typeof uatUi.layers; uatUi.layers[k] = !uatUi.layers[k]; b.classList.toggle('on', uatUi.layers[k]); uatUi.radarDirty = true; uatUi.radarAt = 0; refreshUat(true);
  });
  const alt = q<HTMLSelectElement>('#ua-alt');
  if (alt) alt.onchange = () => { uatUi.altFt = Number(alt.value); uatUi.radarDirty = true; uatUi.radarAt = 0; refreshUat(true); };
  $('ua-cards').onclick = (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('[data-ua]'); if (c) { uatUi.sel = uatUi.sel === c.dataset.ua ? '' : c.dataset.ua!; uatUi.radarDirty = true; uatUi.radarAt = 0; refreshUat(true); if (uatUi.sel.startsWith('gm:') && UAT_WIDE.matches) uatFocus(); } };
  $('ua-detail').onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-uao="close"]')) { uatUi.sel = ''; refreshUat(true); }
    else if (t.closest('[data-uao="map"]')) uatFocus();
  };
  // a log line opens what it was about: the aircraft, the airport's weather, the tower, or the notices
  $('ua-log').onclick = (e) => {
    const li = (e.target as HTMLElement).closest('.li'); const line = li?.textContent ?? '';
    const wideNow = UAT_WIDE.matches;
    let m: RegExpExecArray | null;
    if (/AIRCRAFT/.test(line)) {
      // the line's words run together in textContent, so look for each aircraft's name in it
      const rest = line.slice(line.indexOf('AIRCRAFT') + 9);
      const p = [...uatData.planes.values()].find(x => rest.startsWith(x.callsign ?? x.address) || rest.startsWith(x.address));
      if (p) { uatUi.sel = `ac:${p.address}`; uatUi.view = wideNow ? 'traffic' : 'map'; refreshUat(true); uatFocus(); }
    } else if ((m = /METAR (\w{3,4})/.exec(line)) && uatData.metars.has(m[1])) {
      uatUi.sel = `wx:${m[1]}`; uatUi.view = wideNow ? 'weather' : 'map'; refreshUat(true); uatFocus();
    } else if (/TOWER/.test(line)) {
      const k = [...uatData.towers.keys()][0]; if (k) { uatUi.sel = `tw:${k}`; uatUi.view = wideNow ? 'weather' : 'map'; refreshUat(true); uatFocus(); }
    } else if (/FISB/.test(line)) { uatUi.view = 'notices'; refreshUat(true); }
  };
  geo = new GeoMap($('ua-map'), { home: state.home, start: mapStart(state.home), onPick: id => { uatUi.sel = id; uatUi.tap = null; geo?.setTapMark(null); uatUi.radarDirty = true; uatUi.radarAt = 0; refreshUat(true); }, log,
    // a tap on open map reads every layer at that spot
    onMapTap: (lat, lon) => { uatUi.tap = [lat, lon]; uatUi.sel = `pt:${lat.toFixed(4)},${lon.toFixed(4)}`; geo?.setTapMark([lat, lon]); refreshUat(true); } });
  geo.follow = false;
  uatUi.radarDirty = true;
  clearInterval(uatUi.timer);
  uatUi.timer = window.setInterval(() => { if (state.app !== 'uat') { clearInterval(uatUi.timer); return; } refreshUat(); }, 1000);
  refreshUat(true);
}
/** Pans the map to what is selected. */
function uatFocus(): void {
  const [kind, id] = [uatUi.sel.slice(0, 2), uatUi.sel.slice(3)];
  let at: [number, number] | undefined;
  if (kind === 'ac') { const p = uatData.planes.get(id); if (p?.lat !== undefined && p.lon !== undefined) at = [p.lat, p.lon]; }
  else if (kind === 'wx') { const a = uatAirports?.get(id); if (a) at = [a[0], a[1]]; }
  else if (kind === 'tw') { const t = uatData.towers.get(id); if (t) at = [t.lat, t.lon]; }
  else if (kind === 'gm') { const sh = uatData.shapes.get(id); if (sh) at = sh.pts.reduce((a, p) => [a[0] + p[0] / sh.pts.length, a[1] + p[1] / sh.pts.length], [0, 0]) as [number, number]; }
  if (!at) return;
  if (!UAT_WIDE.matches) { uatUi.view = 'map'; refreshUat(true); }
  geo?.center(at[0], at[1], 8);
}
/** A G-AIRMET's altitudes in words: a freezing level line, a range, or from the surface. */
function uatAltText(o: Overlay): string {
  const a = o.altsFt, ft = (x: number) => (x >= 18000 ? `FL${Math.round(x / 100)}` : `${x.toLocaleString('en-US')} ft`);
  if (o.element === 5 && o.line) return `${ft(a[0] ?? 0)}`;
  if (o.element === 6) return 'ceiling below 1,000 ft or visibility below 3 mi';
  if (o.element === 7) return 'mountains hidden in cloud, haze or rain';
  if (o.element === 5) return !a.length || a[a.length - 1] === 0 ? 'freezing at the surface' : `freezing level ${a.length > 1 ? `${ft(a[0])} to ${ft(a[a.length - 1])}` : `up to ${ft(a[0])}`}`;
  if (!a.length || (a.length === 1 && a[0] === 0)) return 'surface';
  if (a.length === 1) return o.geometry === 4 ? `surface to ${ft(a[0])} AGL` : `up to ${ft(a[0])}`;
  return `${ft(a[0])} to ${ft(a[a.length - 1])}`;
}
const uatWhen = (t?: { month: number; day: number; hh: number; mm: number }) => (t ? `${t.month}/${t.day} ${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}Z` : '');
/** A G-AIRMET's time: a window, or the one forecast time it is a snapshot for. */
const uatValid = (o: Overlay) => (uatWhen(o.start) === uatWhen(o.end) ? `for ${uatWhen(o.start)}` : `${uatWhen(o.start)} – ${uatWhen(o.end)}`);
/** UTC time of a G-AIRMET's start or end, this year (or the next one, across New Year). */
function uatTs(t?: { month: number; day: number; hh: number; mm: number }): number {
  if (!t) return 0;
  const now = new Date(); let y = now.getUTCFullYear();
  if (t.month === 1 && now.getUTCMonth() === 11) y++; else if (t.month === 12 && now.getUTCMonth() === 0) y--;
  return Date.UTC(y, t.month - 1, t.day, t.hh, t.mm);
}
/** The G-AIRMETs (and other areas) for now: each kind's window that covers now, or failing that the latest one sent. */
function uatShapesNow(): UatShape[] {
  const now = Date.now(), all = [...uatData.shapes.values()];
  const byKind = new Map<string, UatShape[]>();
  for (const s of all) { const k = `${s.product}:${s.element}`; (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(s); }
  const out: UatShape[] = [];
  for (const list of byKind.values()) {
    const live = list.filter(s => uatTs(s.start) <= now && now < uatTs(s.end));
    if (live.length) { out.push(...live); continue; }
    const latest = Math.max(...list.map(s => uatTs(s.start)));
    out.push(...list.filter(s => uatTs(s.start) === latest));
  }
  return out;
}
/** What every layer says at one spot: radar, cloud tops, and icing and turbulence at each altitude. */
function uatAt(lat: number, lon: number, id: number): HazardBlock[] {
  const m = uatData.hazards.get(id); if (!m) return [];
  const out: HazardBlock[] = [];
  for (const b of m.values()) if (b.bins && lat >= b.lat && lat < b.lat + b.dLat && lon >= b.lon && lon < b.lon + b.dLon) out.push(b);
  return out;
}
function uatBin(b: { lat: number; lon: number; dLat: number; dLon: number; bins: Uint8Array | null }, lat: number, lon: number): number {
  if (!b.bins) return 0;
  const x = Math.min(31, Math.floor((lon - b.lon) / b.dLon * 32)), y = Math.min(3, 3 - Math.floor((lat - b.lat) / b.dLat * 4));
  return b.bins[y * 32 + x];
}
function uatPointDetail(lat: number, lon: number): string {
  const row = (k: string, v: string | undefined | false) => (v ? `<div><b>${k}</b><span>${esc(v)}</span></div>` : '');
  const radar = [...uatData.regional.values(), ...uatData.national.values()].filter(b => b.bins && lat >= b.lat && lat < b.lat + b.dLat && lon >= b.lon && lon < b.lon + b.dLon)
    .map(b => uatBin(b, lat, lon)).reduce((a, v) => Math.max(a, v), 0);
  const tops = uatAt(lat, lon, 84).map(b => uatBin(b, lat, lon)).find(v => v > 0 && v < 15);
  const lightning = uatAt(lat, lon, 103).map(b => uatBin(b, lat, lon)).find(v => v > 0 && v < 15);
  const levels: string[] = [];
  for (let a = 2000; a <= 24000; a += 2000) {
    const lo = a <= 16000, lvl = lo ? a / 2000 - 1 : (a - 18000) / 2000;
    const ice = uatAt(lat, lon, lo ? 70 : 71).filter(b => b.level === lvl).map(b => icingOf(uatBin(b, lat, lon)))[0];
    const turb = uatAt(lat, lon, lo ? 90 : 91).filter(b => b.level === lvl).map(b => uatBin(b, lat, lon))[0];
    const parts = [ice && !ice.none && ice.severity > 0 && ice.severity < 6 ? `icing ${UAT_ICE_WORD[ice.severity]}${ice.sld ? ', large drops' : ''}` : '', turb && turb < 15 ? `turbulence ${turb}/14` : ''].filter(Boolean);
    if (parts.length) levels.push(`<div><b>${a.toLocaleString('en-US')} FT</b><span>${esc(parts.join(' · '))}</span></div>`);
  }
  const inside = uatShapesNow().filter(s => !s.line && uatInPoly(lat, lon, s.pts)).map(s => `${UAT_GAIRMET[s.element]?.[0] ?? 'AREA'} · ${uatAltText(s)}`);
  const from = uatFromHere(lat, lon);
  return `<div class="mt-dh"><b>HERE</b><span>${lat.toFixed(3)}, ${lon.toFixed(3)}${from ? ` · ${esc(from.text)} from you` : ''}</span><button class="chip" data-uao="close">✕</button></div>`
    + `<div class="mt-fields">${row('Radar', radar >= 2 ? ['', '', 'light', 'light', 'moderate', 'moderate', 'heavy', 'extreme'][radar] + ` (level ${radar})` : 'nothing falling')}${row('Cloud tops', tops ? `level ${tops} of 14` : uatData.hazards.has(84) ? 'clear' : undefined)}`
    + `${row('Lightning', lightning ? `level ${lightning}` : uatData.hazards.has(103) ? 'none' : undefined)}${inside.map(t => row('G-AIRMET', t)).join('')}</div>`
    + (levels.length ? `<div class="mt-fields ua-levels">${levels.join('')}</div>` : (uatData.hazards.has(70) || uatData.hazards.has(90) ? '<div class="ua-text">No icing or turbulence forecast here from 2,000 to 24,000 ft.</div>' : ''));
}
function uatInPoly(lat: number, lon: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ya, xa] = pts[i], [yb, xb] = pts[j];
    if ((ya > lat) !== (yb > lat) && lon < (xb - xa) * (lat - ya) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
function uatShapeCard(sh: UatShape, now: number): string {
  const [name, color] = UAT_GAIRMET[sh.element] ?? ['AREA', '#ff5b52'];
  const c = sh.pts.reduce((a, p) => [a[0] + p[0] / sh.pts.length, a[1] + p[1] / sh.pts.length], [0, 0]);
  const from = uatFromHere(c[0], c[1]);
  const live = uatTs(sh.start) <= now && now < uatTs(sh.end);
  return `<div class="mt-card ua-gm ${uatUi.sel === `gm:${sh.key}` ? 'sel' : ''}" data-ua="gm:${esc(sh.key)}" style="--cat:${color}">`
    + `<div class="mt-h"><span class="mt-id ua-kind" style="color:${color}">${sh.product === 14 ? 'G-AIRMET' : 'AREA'}</span><span class="mt-k"><b>${esc(name)}</b><small>${uatValid(sh)}${live ? ' · NOW' : ''}</small></span></div>`
    + `<div class="lr-name">${esc(uatAltText(sh))}${sh.line ? ' · contour' : ''}</div>`
    + `<div class="lr-last">${sh.pts.length} points${from ? ` · centered ${esc(from.text)} from you` : ''}</div></div>`;
}
function uatSuaCard(t: UatText, now: number): string {
  const s = suaOf(t.text); if (!s) return uatTextCard(t, now);
  const ft = (x?: number) => (x === undefined ? '' : x === 0 ? 'surface' : x >= 18000 ? `FL${x / 100}` : `${x.toLocaleString('en-US')} ft`);
  return `<div class="mt-card ua-tx"><div class="mt-h"><span class="mt-id ua-kind">SUA</span><span class="mt-k"><b>${esc(s.name || 'special use airspace')}</b><small>${uatAge(t.at, now)}</small></span></div>`
    + `<div class="lr-name">${esc([ft(s.bottomFt), ft(s.topFt)].filter(Boolean).join(' to '))}</div><div class="lr-last">${esc([s.from, s.to].filter(Boolean).join(' – '))}</div></div>`;
}
function refreshUat(force = false): void {
  if (state.app !== 'uat') return;
  const now = Date.now();
  if (!force && now - uatUi.drawn < 400) { clearTimeout(uatUi.pending); uatUi.pending = window.setTimeout(() => refreshUat(true), 450); return; }
  uatUi.drawn = now;
  const d = uatData;
  // aircraft not heard for two minutes leave the map and the list
  for (const [k, p] of d.planes) if (now - p.at > 120_000) d.planes.delete(k);
  const sum = q('#ua-sum');
  if (sum) {
    const mins = d.firstAt ? Math.max(1, (now - d.firstAt) / 60000) : 1;
    const towers = [...d.towers.values()].filter(t => now - t.at < 120_000).length;
    sum.innerHTML = d.up || d.down
      ? `<div>${towers} TOWER${towers === 1 ? '' : 'S'} · ${Math.round(d.up / mins)} UPLINKS/MIN · ${d.metars.size} AIRPORTS · ${d.planes.size} AIRCRAFT${d.radarTime ? ` · RADAR ${d.radarTime}` : ''}</div>`
      : `<div class="muted">listening on 978 MHz for FIS-B towers and aircraft</div>`;
  }
  const n = { map: d.towers.size + d.planes.size, weather: d.metars.size, notices: d.texts.size, traffic: d.planes.size, log: 0 };
  qa<HTMLButtonElement>('[data-uaview]').forEach(b => { const v = b.dataset.uaview as UatView; b.classList.toggle('on', v === uatUi.view); b.textContent = v === 'traffic' ? 'PLANES' : v.toUpperCase(); b.title = v === 'log' ? '' : `${n[v]}`; });
  const mapEl = q('#ua-map'), cards = q('#ua-cards'), det = q('#ua-detail'), logEl = q('#ua-log'), stage = q('#ua-stage'), layers = q('#ua-layers');
  if (!mapEl || !cards || !det || !logEl || !stage || !layers) return;
  const wide = UAT_WIDE.matches;
  mapEl.hidden = !wide && uatUi.view !== 'map'; cards.hidden = uatUi.view === 'map' || uatUi.view === 'log';
  logEl.hidden = uatUi.view !== 'log'; stage.hidden = uatUi.view === 'log'; layers.hidden = !wide && uatUi.view !== 'map';
  const detHtml = uatUi.sel ? uatDetail(now) : '';
  det.hidden = !detHtml;
  if (detHtml) { const top = det.scrollTop; det.innerHTML = detHtml; det.scrollTop = top; }
  if (uatUi.view === 'log') { refreshList('uat'); if (!wide) return; }
  if (paused.has('uat')) return;
  if (uatUi.view === 'weather') {
    const me = state.home ?? lastKnownPos();
    const rows = [...d.metars.entries()].map(([id, e]) => {
      const ap = uatAirports?.get(id);
      return { id, e, km: me && ap ? distBearing(me, { lat: ap[0], lon: ap[1] })[0] : 1e9 };
    }).sort((a, b) => a.km - b.km || a.id.localeCompare(b.id));
    cards.innerHTML = rows.length ? rows.map(r => uatWxCard(r.id, r.e.m, r.e.at, now)).join('') : emptyState('uat');
  } else if (uatUi.view === 'notices') {
    const rows = [...d.texts.values()].sort((a, b) => b.at - a.at);
    const order = [6, 7, 1, 4, 2, 3, 5];
    const shapes = uatShapesNow().filter(sh => !sh.line).sort((a, b) => order.indexOf(a.element) - order.indexOf(b.element));
    cards.innerHTML = rows.length || shapes.length ? shapes.map(sh => uatShapeCard(sh, now)).join('') + rows.map(t => (t.kind === 'SUA' ? uatSuaCard(t, now) : uatTextCard(t, now))).join('') : emptyState('uat');
  } else if (uatUi.view === 'traffic') {
    // first heard first: a card keeps its place instead of jumping every time a plane reports
    const rows = [...d.planes.values()].sort((a, b) => a.first - b.first || a.address.localeCompare(b.address));
    cards.innerHTML = rows.length ? rows.map(p => uatPlaneCard(p, now)).join('') : emptyState('uat');
  }
  if (wide || uatUi.view === 'map') {
    geo?.invalidate();
    const items: GeoItem[] = [];
    for (const [k, t] of d.towers) items.push({ id: `tw:${k}`, lat: t.lat, lon: t.lon, label: 'FIS-B', kind: 'tower' });
    if (uatUi.layers.airports && uatAirports) for (const [id, e] of d.metars) {
      const ap = uatAirports.get(id); if (!ap) continue;
      items.push({ id: `wx:${id}`, lat: ap[0], lon: ap[1], label: id, kind: 'airport', color: UAT_CAT[e.m.category ?? ''] ?? '#8a93a6' });
    }
    const paths: { pts: [number, number][]; faint?: boolean }[] = [];
    if (uatUi.layers.traffic) for (const p of d.planes.values()) {
      if (p.lat === undefined || p.lon === undefined) continue;
      items.push({ id: `ac:${p.address}`, lat: p.lat, lon: p.lon, heading: p.trackDeg, label: `${p.callsign ?? p.address}${p.altFt !== undefined ? ` ${Math.round(p.altFt / 100)}` : ''}`, kind: 'plane' });
      if (p.track.length > 1) paths.push({ pts: p.track, faint: uatUi.sel !== `ac:${p.address}` });
    }
    geo?.setPaths(paths);
    geo?.update(items, uatUi.sel);
    if (uatUi.radarDirty && now - uatUi.radarAt > 3000) {
      uatUi.radarDirty = false; uatUi.radarAt = now;
      const cells: RadarCell[] = [];
      const add = (b: RadarBlock) => cells.push({ lat: b.lat, lon: b.lon, dLat: b.dLat, dLon: b.dLon, cols: 32, rows: 4, bins: b.bins! });
      if (uatUi.layers.radar) {
        // the national picture is coarse (each block 5 or 9 times a regional one): where the tower's own regional
        // radar reports, clear or not, it has the say and the national bins under it are left out
        if (uatUi.layers.national) for (const b of d.national.values()) {
          if (!b.bins) continue;
          const bins = b.bins.slice();
          for (let i = 0; i < 128; i++) {
            if (!bins[i]) continue;
            const la = b.lat + b.dLat * (3 - (i >> 5) + 0.5) / 4, lo = b.lon + b.dLon * ((i & 31) + 0.5) / 32;
            const row = Math.floor(la * 15), col = Math.floor(((lo + 360) % 360) / 0.8);
            if (d.regionalSeen.has(row * 450 + col)) bins[i] = 0;
          }
          if (bins.some(v => v >= 2)) cells.push({ lat: b.lat, lon: b.lon, dLat: b.dLat, dLon: b.dLon, cols: 32, rows: 4, bins });
        }
        d.regional.forEach(add);
      }
      const grid = (id: number, colors: string[], level: number | null, map?: (v: number) => number) => {
        for (const b of d.hazards.get(id)?.values() ?? []) {
          if (!b.bins || (level !== null && b.level !== level)) continue;
          cells.push({ lat: b.lat, lon: b.lon, dLat: b.dLat, dLon: b.dLon, cols: 32, rows: 4, bins: map ? b.bins.map(map) : b.bins, colors });
        }
      };
      const lvl = (id: number) => { const lo = uatUi.altFt <= 16000; if ((id === 70 || id === 90) !== lo) return null; return lo ? uatUi.altFt / 2000 - 1 : (uatUi.altFt - 18000) / 2000; };
      if (uatUi.layers.tops) grid(84, UAT_TOPS, null);
      if (uatUi.layers.ice) for (const id of [70, 71]) { const l = lvl(id); if (l !== null) grid(id, UAT_ICE, l, v => { const x = icingOf(v); return x.none || x.severity >= 6 ? 0 : x.severity; }); }
      if (uatUi.layers.turb) for (const id of [90, 91]) { const l = lvl(id); if (l !== null) grid(id, UAT_TURB, l); }
      if (uatUi.layers.lightning) grid(103, UAT_LIGHTNING, null);
      geo?.setRadar(cells, UAT_RADAR);
      const shapes: GeoShape[] = [];
      if (uatUi.layers.gairmet) for (const sh of uatShapesNow()) {
        const [name, color] = UAT_GAIRMET[sh.element] ?? ['AREA', '#ff5b52'];
        shapes.push({ id: `gm:${sh.key}`, pts: sh.pts, line: sh.line, color, dashed: sh.element === 5, sel: uatUi.sel === `gm:${sh.key}`, label: `${sh.product === 14 ? name : 'AREA'} · ${uatAltText(sh)}` });
      }
      geo?.setShapes(shapes);
      const lg = q('#ua-legend'); if (lg) lg.innerHTML = uatLegendHtml();
    }
  }
  const lamp = d.up || d.down;
  if (lamp) setLamp(`${d.towers.size} TOWER${d.towers.size === 1 ? '' : 'S'} · ${d.planes.size} AIRCRAFT`, 'ok');
}

/** The count line, then MAP / LIST / LOG with PAUSE and clear: the three map apps' frame. */
function geoHeadHtml(id: string, glyphText: string, views: string[], wf?: AppId): string {
  return `<div class="countrow"><span id="${id}-count" class="count">${glyphText}</span></div><div class="ctlrow">${segHtml(views.map(v => `<button data-${id}view="${v}">${v.toUpperCase()}</button>`))}${wf ? wfHtml(wf) : ''}${pauseClearHtml(id)}</div>`;
}
function renderAdsb(view: HTMLElement): void {
  view.innerHTML = `
    <section class="${visCls('adsb')}">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${geoHeadHtml('adsb', `✈ ${state.frames} FRAMES · ${state.aircraft.length} AIRCRAFT`, ['map', 'list'], 'adsb')}
      <div id="adsb-card" class="accard" hidden></div>
      <div id="adsb-map" class="panel map"></div>
      <div id="adsb-list" class="panel list"></div>
      </section>`;
  scope = attach(new Scope($('scope'), 0, { rows: 80, spectrumHeight: 70 }));
  q('#pause-adsb')?.insertAdjacentHTML('beforebegin', `<button id="adsb-full" class="ib" title="full-screen map" aria-label="full-screen map">${adsbFull ? EXIT_SVG : FULL_SVG}</button>`);
  $('adsb-full').onclick = () => setAdsbFull(!adsbFull);
  view.classList.toggle('mapfull', adsbFull);
  qa<HTMLButtonElement>('[data-adsbview]', view).forEach(b => b.onclick = () => { state.adsbView = b.dataset.adsbview as 'map' | 'list'; refreshAdsb(); });
  if (!state.home) requestGeo();
  geo = new GeoMap($('adsb-map'), { home: state.home, start: mapStart(state.home), onPick: id => { state.adsbSel = id; refreshAdsb(); }, onFollow: on => { state.adsbFollow = on; }, log });
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
      ${presetHtml('CHANNEL', [['AIS A 161.975', 161_975_000], ['AIS B 162.025', 162_025_000]])}</section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-aisview]', view).forEach(b => b.onclick = () => { state.aisView = b.dataset.aisview as typeof state.aisView; refreshAis(); });
  q('#list-ais')?.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest('.li'); const mm = li?.textContent?.match(/MMSI (\d+)/); if (mm) { state.aisSel = Number(mm[1]); refreshAis(); } });
  if (!state.home) requestGeo();
  geo = new GeoMap($('ais-map'), { home: state.home, start: mapStart(state.home), onPick: id => { state.aisSel = Number(id); refreshAis(); }, log });
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
      </section>`;
  scope = attach(tunableScope('scope', 80, 70));
  qa<HTMLButtonElement>('[data-aprsview]', view).forEach(b => b.onclick = () => { state.aprsView = b.dataset.aprsview as typeof state.aprsView; refreshAprs(); });
  q('#list-aprs')?.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest('.li'); const mm = li?.textContent?.match(/^([A-Za-z0-9-]+)>/); if (mm) { state.aprsSel = mm[1]; refreshAprs(); } });
  if (!state.home) requestGeo();
  geo = new GeoMap($('aprs-map'), { home: state.home, start: mapStart(state.home), onPick: id => { state.aprsSel = id; refreshAprs(); }, log });
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
      ${search ? `<div class="caption">HITS · tap to listen</div><div id="hits" class="panel list">${emptyState('search')}</div>` : ''}
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
  if (!radio || !radio.caps.biasT) return;
  if (state.biast) { applyBiasTee(false); return; }
  if (!biasAcked) { showBiasWarn(); return; }
  applyBiasTee(true);
}
/** Put the bias tee where the UI says it is, on whichever radio is connected. */
function applyBiasTee(on: boolean): void {
  state.biast = on;
  if (radio?.kind === 'rtlsdr') void (radio as RtlSdr).setBiasTee(on);
  else if (radio?.kind === 'hackrf') (radio as HackRf).biasT = on;
  refreshGainUi(); syncRadioPanel();
}
function showBiasWarn(): void {
  if (q('#bias-warn')) return;
  const el = document.createElement('div');
  el.id = 'bias-warn'; el.className = 'modal';
  el.innerHTML = `<div class="modal-card"><h3>Bias-tee: DC on the antenna port</h3><p>This puts about ${radio?.caps.biasVolts ?? 4.5} V DC on the ${radio?.kind === 'hackrf' ? 'HackRF' : 'RTL-SDR'}'s antenna port to power an inline LNA.</p><ul><li>Only turn it on with a bias-tee-ready LNA or feed.</li><li>Never into a plain antenna, a shorted feed, or gear that isn't DC-blocked — the DC can damage it.</li></ul><div class="modal-actions"><button id="bias-cancel" class="chip">CANCEL</button><button id="bias-ok" class="chip primary">ENABLE BIAS-T</button></div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  $('bias-ok').onclick = () => { biasAcked = true; applyBiasTee(true); close(); };
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
  // a burst handed over from the Analyzer opens on the .sub replay, filled in
  let tab = txHandoff ? 9 : 0;
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
      body.innerHTML = `<div class="row"><button id="h-lo" class="txin kpbox" data-hz="433050000" style="flex:1">433.05 MHz</button><button id="h-hi" class="txin kpbox" data-hz="434790000" style="flex:1">434.79 MHz</button></div><div class="row" style="margin-top:6px"><input id="h-count" class="txin" value="16" style="flex:1"><input id="h-dwell" class="txin" value="20" style="flex:1"></div><div class="caption">CW frequency hopper · low-high MHz · [count] random hops · dwell ms each · your own bench work only</div><button class="chip primary" id="h-send" style="margin-top:6px;width:100%">▶ HOP</button>`;
      // the span's edges are frequencies, typed on the app's keypad
      for (const [id, label] of [['h-lo', 'LOW'], ['h-hi', 'HIGH']]) {
        const b = $(id);
        b.onclick = () => openKeypad({ label, units: FREQ_UNITS, auto: freqAuto, hint: `${+(Number(b.dataset.hz) / 1e6).toFixed(6)} MHz`,
          onEnter: hz => { if (hz > 0) { b.dataset.hz = String(Math.round(hz)); b.textContent = `${+(hz / 1e6).toFixed(6)} MHz`; } } });
      }
      $('h-send').onclick = () => {
        const lo = Number($('h-lo').dataset.hz), hi = Number($('h-hi').dataset.hz);
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
  if (txHandoff && tab === 9) {
    const h = txHandoff; txHandoff = null;
    const ta = q<HTMLTextAreaElement>('#s-text');
    if (ta) ta.value = h.sub;
    txStatus(`from the Analyzer: ${(h.hz / 1e6).toFixed(3)} MHz${h.fsk ? ' · this burst is FSK and the replay keys it as OOK, so it will not sound the same' : ''} · press REPLAY to send`);
  }
}

function renderCapture(view: HTMLElement): void {
  view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${stepHtml([1e6, 1e5, 1e4])}
      <div class="caption">RECORD · signed 8-bit I/Q (.c8) + .txt sidecar, stored in the browser</div>
      <div class="row"><button id="rec" class="chip">● REC</button><span id="rec-info" class="info"></span></div>
      <div class="caption">CAPTURES · tap to download, ✕ to delete</div><div id="captures" class="panel list">${emptyState('capture')}</div>
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
  const jumps: [string, string][] = [...(appRows ? [['app', over ? appName(over) : 'APP'] as [string, string]] : []), ['radio', 'RADIO'], ['look', 'LOOK'], ['station', 'STATION'], ['tx', 'TRANSMIT'], ['how', 'HOW IT WORKS'], ['log', 'LOG'], ['about', 'ABOUT']];
  view.innerHTML = `
    <section class="controls settings-page">
    <input id="set-search" class="txin set-search" placeholder="Search settings" autocomplete="off" spellcheck="false">
    <div class="radiocard ${radio ? 'on' : ''}"><div><b>${radio ? 'RADIO CONNECTED' : 'NO RADIO'}</b><small>${esc(radioLine)}</small></div>${radio ? '' : '<button id="set-connect" class="act">CONNECT</button>'}</div>
    <div class="set-jumps">${hsHtml(`<div class="tiles">${jumps.map(([id, l]) => `<button class="pill" data-jump="${id}">${l}</button>`).join('')}</div>`)}</div>
    ${secHtml('app', `THIS APP · ${over ? appName(over) : ''}`, appRows)}
    <section class="sset fold link" id="sec-radio" data-keys="radio gain lna vga amp agc bias tee ppm sample rate filter"><div class="sset-h">RADIO</div></section>
    <section class="sset" id="sec-look"><div class="sset-h">LOOK</div>
    <div class="skins">${SKINS.map(s => `<button class="skin" data-skin="${s.id}" style="background:${s.paper};border-color:${s.id === currentSkin().id ? s.accent : s.line};color:${s.ink}"><div class="skin-head"><span>${s.title}</span>${s.id === currentSkin().id ? `<span style="color:${s.accent}">●</span>` : ''}</div><div class="swatches">${[s.surface, s.panel, s.line, s.muted, s.accent, s.accent2].map(c => `<i style="background:${c}"></i>`).join('')}</div><div class="skin-readout" style="background:${s.surface};border-color:${s.accent}80;color:${s.accent}">92.3000 MHz</div></button>`).join('')}</div>${fsCan() ? srow('Full screen', 'No address bar or status bar on a phone. Swipe down from the top to see them for a moment.', swHtml('fs-toggle', fsOn()), 'full screen fullscreen status bar address bar') : ''}</section>
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
    <section class="sset" id="sec-how"><div class="sset-h">HOW IT WORKS</div><div class="panel about">${over && appAbout[over] ? `<div class="kv"><span>${esc(appName(over))}</span><span>${esc(appAbout[over]!)}</span></div>` : ''}      <div class="kv"><span>Browsers</span><span>Chrome / Edge on Android phones, Windows, macOS, Linux — the same desktop web app runs everywhere. iPhone/iPad and Firefox have no WebUSB; on Android phones the app on Google Play is the recommended route.</span></div>
      <div class="kv"><span>Power</span><span>a HackRF Pro can exceed what a phone's OTG port supplies — use a powered OTG hub if RX reads all zeros</span></div>
      <div class="kv"><span>Reading LOG</span><span>iqRMS ≈ 0.85 with dcI = dcQ ≈ 0.6 means all-zero buffers: cable, power, or a PortaPack not in HackRF mode</span></div>
      <div class="kv"><span>Tuning</span><span>press the waterfall and slide left or right — the amber guide and readout follow your finger, and the radio retunes when you lift it. Tap-and-release on a signal does the same.</span></div>
      <div class="kv"><span>ADS-B map</span><span>aircraft plot live on an OpenStreetMap view (Leaflet loads from the CDN when you open the app); it follows the traffic until you drag, ⌖ re-arms it; allow location so single-frame positions and the map center use your spot</span></div>
      <div class="kv"><span>Pagers</span><span>the Pagers app decodes FLEX (1600/3200/6400, 2- and 4-level) and POCSAG (512/1200/2400) on the same channel, like PDW — messages carry capcode, and FLEX its cycle/frame; in SINGLE mode it can be set to just one of them</span></div>
      <div class="kv"><span>Squelch + scan</span><span>squelch gates audio by channel power against a tracked noise floor; SCAN hops through your bookmarks and holds on any channel where the squelch opens</span></div>
      <div class="kv"><span>Gain</span><span>radio defaults LNA 24 / VGA 24 / amp off (the amp overloads strong FM); ADS-B uses Mayhem's LNA 32 / VGA 32 / amp on</span></div>
      <div class="kv"><span>Windows</span><span>bind the HackRF to the WinUSB driver (Zadig), the same step hackrf_transfer needs; libusbK / libusb-win32 bindings hide it from the browser</span></div>
      <div class="kv"><span>macOS</span><span>nothing to install — just close any other SDR program that has the HackRF open</span></div>
      <div class="kv"><span>Linux</span><span>the udev rule from the hackrf package (53-hackrf.rules) grants access; replug after adding it</span></div>
      <div class="kv"><span>Keyboard</span><span>digits: wheel, click top/bottom, type · ← → tune · ↑ ↓ step size · M mode · X mute · S squelch · B bookmark · Space scan · A amp · G AGC · [ ] LNA · − = VGA · L log · Esc closes Settings, then goes home · mouse wheel over the waterfall tunes, Ctrl+wheel changes the step</span></div></div></section>
    <section class="sset" id="sec-log"><div class="sset-h">LOG</div>${srow('Log', 'Everything the radio and the decoders reported, to read, save or share', '<button id="set-log" class="tog">OPEN</button>')}</section>
    <section class="sset" id="sec-about"><div class="sset-h">ABOUT</div>
    <div class="panel about">
      <div class="row"><button id="install" class="chip" ${installPrompt ? '' : 'disabled'}>${installPrompt ? 'INSTALL TO HOME SCREEN' : 'INSTALLED / NOT OFFERED'}</button><a class="chip primary" href="https://play.google.com/store/apps/details?id=com.rocketgod.mayhem" target="_blank" rel="noopener">GET IT ON GOOGLE PLAY</a></div>
      ${isAndroid() ? `<div class="kv"><span>Android app</span><span>On Google Play. It opens by itself when the radio is plugged in and keeps running in the background.</span></div>` : ''}
      <div class="kv"><span>Mayhem Mobile</span><span>${versionText} — one build, two shells: this web app in any Chrome/Edge browser, and the Android app on Google Play</span></div>
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
  const fs = q('#fs-toggle'); if (fs) fs.onclick = () => { setFsWanted(!fsOn()); setTimeout(refreshSettings, 300); };
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
  // Every group starts folded so the page reads as a short list of headings; the ones opened stay open across redraws.
  const fold = (sec: HTMLElement) => sec.classList.toggle('fold', sec.classList.contains('link') || !setOpen.has(sec.id));
  qa<HTMLElement>('.sset', view).forEach(sec => {
    // an accordion: the heading stays, everything under it goes into a body that slides open and shut
    const h = q<HTMLElement>('.sset-h', sec); if (!h) return;
    h.setAttribute('role', 'button'); h.tabIndex = 0;
    // a link group (RADIO) has no body: its heading opens the panel it names
    if (sec.classList.contains('link')) {
      h.onclick = () => openRadioPanel();
      h.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRadioPanel(); } };
      return;
    }
    const body = document.createElement('div'); body.className = 'sset-body';
    const inner = document.createElement('div'); inner.className = 'sset-in';
    while (h.nextSibling) inner.appendChild(h.nextSibling);
    body.appendChild(inner); sec.appendChild(body);
    sec.classList.add('noanim'); fold(sec); requestAnimationFrame(() => sec.classList.remove('noanim'));
    const flip = () => { if (setOpen.has(sec.id)) setOpen.delete(sec.id); else setOpen.add(sec.id); fold(sec); h.setAttribute('aria-expanded', String(setOpen.has(sec.id))); };
    h.setAttribute('aria-expanded', String(setOpen.has(sec.id)));
    h.onclick = flip;
    h.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
  });
  qa<HTMLButtonElement>('[data-jump]', view).forEach(b => b.onclick = () => {
    const sec = q<HTMLElement>(`#sec-${b.dataset.jump}`, view); if (!sec) return;
    if (sec.classList.contains('link')) { openRadioPanel(); return; }
    setOpen.add(sec.id); fold(sec);
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const search = q<HTMLInputElement>('#set-search', view);
  if (search) search.oninput = () => {
    const t = search.value.trim().toLowerCase();
    qa<HTMLElement>('.srow', view).forEach(r => { r.hidden = !!t && !(r.dataset.keys ?? '').includes(t); });
    // while searching, every group with a hit is open; clearing the search puts the folds back as they were
    qa<HTMLElement>('.sset', view).forEach(sec => {
      const hit = !!t && (sec.textContent!.toLowerCase().includes(t) || (sec.dataset.keys ?? '').includes(t) || qa<HTMLElement>('.srow', sec).some(r => (r.dataset.keys ?? '').includes(t)));
      sec.hidden = !!t && !hit;
      if (t && !sec.classList.contains('link')) sec.classList.toggle('fold', !hit); else fold(sec);
    });
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
  qa<HTMLButtonElement>('[data-wf]', view).forEach(b => b.onclick = () => { const a = b.dataset.wf as AppId; setWf(a, !wfShown(a)); });
  // the waterfall's own show/hide sits on the waterfall (a small button on its corner), or, while it is hidden, as a
  // slim strip where it was, rather than among the list's tabs
  const wb = q<HTMLButtonElement>('.wf-tog', view);
  if (wb && state.app) {
    const sc = q<HTMLElement>('#scope', view), vis = q<HTMLElement>('section.visual', view);
    if (wfShown(state.app) && sc) { wb.classList.add('on-wf'); sc.appendChild(wb); for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'touchstart'] as const) wb.addEventListener(ev, e => e.stopPropagation()); }
    else if (vis) { wb.classList.add('wf-strip'); wb.innerHTML = `${WF_SVG}<span>SHOW WATERFALL</span>`; vis.appendChild(wb); }
  }
  const fav = q<HTMLButtonElement>('#fav', view); if (fav) { fav.onclick = toggleFav; refreshFav(); }
  const fkey = q<HTMLButtonElement>('#fkey', view);
  if (fkey) { if (state.app === 'adsb' || state.app === 'btle') fkey.remove(); else fkey.onclick = () => freqEntry(); }
  qa<HTMLButtonElement>('[data-app]', view).forEach(b => b.onclick = () => openPicked(b.dataset.app as AppId));
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
  qa<HTMLButtonElement>('.fgain', view).forEach(b => b.onclick = () => openRadioPanel());
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
function refreshPauseChips(): void { qa<HTMLButtonElement>('[id^="pause-"]').forEach(b => { const on = paused.has(b.id.slice(6)); b.classList.toggle('on', on); b.innerHTML = pauseInner(on); b.setAttribute('aria-label', on ? 'resume' : 'pause'); }); }
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
    case 'sondes': refreshList(id); refreshSondes(true); break;
    case 'trains': refreshList(id); refreshTrains(true); break;
    case 'fleet': refreshList(id); refreshFleet(true); break;
    case 'hd': refreshList(id); refreshHd(true); break;
    case 'cell': refreshList(id); refreshCell(true); break;
    case 'atsc': refreshList(id); refreshAtsc(true); break;
    case 'btle': refreshList(id); refreshBle(true); break;
    case 'vdl2': case 'acars': refreshList(id); refreshAcars(true); break;
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
    case 'btle': bleUi.tracker.clear(); bleUi.sel = ''; break;
    case 'vdl2': case 'acars': acarsUis[id].planes.clear(); acarsUis[id].stats.clear(); acarsUis[id].vdl.clear(); acarsUis[id].sel = ''; break;
    case 'psat': state.psat.frames = []; state.psat.heard = 0; state.psat.bad = 0; break;
    case 'ert': meters.snap = null; meters.sel = ''; break;
    case 'lora': loraUi.snap = null; loraUi.sel = ''; break;
    case 'sondes': sondeUi.snap = null; sondeUi.sel = ''; break;
    case 'uat': uatData.towers.clear(); uatData.regional.clear(); uatData.national.clear(); uatData.metars.clear(); uatData.texts.clear(); uatData.planes.clear(); uatData.products.clear(); uatData.regionalSeen.clear(); uatData.hazards.clear(); uatData.hazardTime.clear(); uatData.shapes.clear(); uatData.up = uatData.down = 0; uatData.firstAt = 0; uatData.radarTime = ''; uatUi.sel = ''; uatUi.radarDirty = true; break;
    case 'trains': trainsUi.snap = null; break;
    case 'fleet': fleetUi.snap = null; fleetUi.sel = null; fleetUi.unit = null; try { localStorage.removeItem(KNOWN_KEY); } catch { /* storage blocked */ } break;
    case 'hd': hdUi.snap = null; hdUi.sel = ''; for (const o of hdUi.objects) URL.revokeObjectURL(o.url); hdUi.objects = []; hdUi.tileUrls.clear(); hdUi.mapKey = ''; break;
    case 'cell': cellUi.sel = ''; cellUi.detail = null; break;
    case 'atsc': atscUi.snap = null; atscUi.sel = ''; atscUi.detail = null; atscUi.stills.clear(); atscGuide.clear(); worker?.postMessage({ type: 'atsc', cmd: 'clear' }); void atscDb().then(db => { try { db?.transaction('stills', 'readwrite').objectStore('stills').clear(); } catch { /* storage blocked */ } }); try { localStorage.removeItem(ATSC_KEY); } catch { /* storage blocked */ } break;
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
  const total = counts[id] ?? lines.length;
  el.innerHTML = lines.length ? lines.map((l, i) => logLineHtml(l, total - i)).join('') : emptyState(id);
}
/** A log line's kind: the first all-caps word after its leading time ("12:01:02 MESHCORE ..."), or the first word
 *  after a leading frequency and level ("910.649 +32 dB F6E56B node D7 ..."), with where it starts. */
const LOG_KIND = /^\s*(?:\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s+)?([A-Z][A-Z0-9_-]{2,})\b/;
const LOG_KIND_FREQ = /^\s*\d+(?:\.\d+)?(?:\s*MHz)?\s+(?:[+-]?\d+(?:\.\d+)?\s*dB\s+)?([A-Za-z0-9][A-Za-z0-9_-]{2,})\b/;
function logKind(l: string): [number, string] | null {
  const m = LOG_KIND.exec(l) ?? LOG_KIND_FREQ.exec(l);
  return m ? [m[0].length - m[1].length, m[1]] : null;
}
/** The subject that follows a line's kind: a label and its ID ("node D7", "ID 12345678", "unit 5") or a bare ID with a
 *  letter in it ("!61f882d4", "C3"); null for a frequency, a rate, a path or nothing. */
function logSubject(rest: string): string | null {
  const t = rest.trim().split(/\s+/).filter(x => x);
  if (t.length >= 2 && /^[A-Za-z]{2,8}$/.test(t[0]) && /^[!#]?[A-Za-z0-9_-]{1,12}$/.test(t[1]) && !/^\d+\.\d+$/.test(t[1])) return `${t[0]} ${t[1]}`;
  if (t.length && /^[!#]?(?=.*[A-Za-z])[A-Za-z0-9_-]{2,12}$/.test(t[0])) return t[0];
  return null;
}
/** Twelve saturated colors chosen to stay apart on the dark panel (and from each other) for kinds and nodes. */
const LOG_COLORS = ['#4c8dff', '#ffaf00', '#3ddc84', '#22d3ee', '#a78bfa', '#f472b6', '#fb7185', '#facc15', '#2dd4bf', '#f97316', '#c084fc', '#84cc16'];
/** Java's String.hashCode, so a kind or a node has the same color as in the apps. */
function javaHash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; }
const floorMod = (a: number, n: number) => ((a % n) + n) % n;
/** One steady color per kind of line; the app's accent goes first. */
function logKindColor(kind: string): string {
  const i = floorMod(javaHash(kind), LOG_COLORS.length);
  return i === 0 ? (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || LOG_COLORS[0]) : LOG_COLORS[i];
}
/** One steady color per node (or device, or name), so the same one reads the same every time it repeats; never the
 *  kind's own color, so the chip stands apart from the word before it. */
function logNodeColor(name: string, avoid: string): string {
  let i = floorMod((Math.imul(javaHash(name), 31) + 7) | 0, LOG_COLORS.length);
  if (LOG_COLORS[i] === avoid.toLowerCase()) i = (i + 1) % LOG_COLORS.length;
  return LOG_COLORS[i];
}
/** Each line keeps its own stripe (by its place in the whole log, so stripes hold still as lines arrive), the time
 *  goes quiet, its kind takes a color, and its subject (a node, a device, a name) a color of its own from its name,
 *  as a chip and as the bar down the line's left edge, so the same node reads the same every time it repeats. A line
 *  with parts ("head · detail · detail") is two lines on purpose: the head over its details a size smaller. */
function logLineHtml(l: string, n: number): string {
  const k = logKind(l);
  let cut = l.indexOf(' · ');
  if (cut <= 0 || (k && cut <= k[0] + k[1].length)) cut = -1;
  const head = cut > 0 ? l.slice(0, cut) : l, tail = cut > 0 ? l.slice(cut + 3) : null;
  const tl = tail !== null ? `<div class="lt">${esc(tail)}</div>` : '';
  if (!k) return `<div class="li${n % 2 ? '' : ' alt'}">${esc(head)}${tl}</div>`;
  const c = logKindColor(k[1]);
  // only a real identifier is a subject: a label and its ID ("node D7", "ID 12345678") or a bare ID ("!61f882d4");
  // a frequency, a rate or a path is not, and its row takes the kind's color
  const rest = head.slice(k[0] + k[1].length), subj = logSubject(rest), at = subj ? rest.indexOf(subj) : -1;
  const sc = subj && at >= 0 ? logNodeColor(subj, c) : c;
  const restHtml = subj && at >= 0
    ? `${esc(rest.slice(0, at))}<span class="chip" style="color:${sc};background:${sc}29">${esc(subj)}</span><span class="lh">${esc(rest.slice(at + subj.length))}</span>`
    : `<span class="lh">${esc(rest)}</span>`;
  return `<div class="li kind${n % 2 ? '' : ' alt'}" style="--kc:${sc}"><span class="lq">${esc(head.slice(0, k[0]))}</span><b style="color:${c}">${esc(k[1])}</b>${restHtml}${tl}</div>`;
}
function refreshAis(): void {
  if (state.app !== 'ais') return;
  const c = q('#ais-count'); if (c) c.textContent = `⚓ ${counts['ais'] ?? 0} PACKETS · ${state.aisTable.length} VESSELS`;
  qa('[data-aisview]').forEach(b => b.classList.toggle('on', b.dataset.aisview === state.aisView));
  const list = q('#ais-list'), mapEl = q('#ais-map'), logEl = q('#ais-log'); if (!list || !mapEl || !logEl) return;
  list.hidden = state.aisView !== 'list'; mapEl.hidden = state.aisView !== 'map'; logEl.hidden = state.aisView !== 'log';
  if (paused.has('ais')) { qa<HTMLElement>('[data-mmsi]', list).forEach(d => d.classList.toggle('gold', Number(d.dataset.mmsi) === state.aisSel)); renderShipCard(state.aisTable.find(v => v.mmsi === state.aisSel)); return; }
  list.innerHTML = state.aisTable.length ? state.aisTable.map((v, i) => `<div class="li row2 tap ${i % 2 ? 'alt' : ''} ${v.mmsi === state.aisSel ? 'gold' : ''}" data-mmsi="${v.mmsi}"><b>${esc(v.name || String(v.mmsi))}</b><span>${v.name ? v.mmsi + ' · ' : ''}${v.lat !== undefined && v.lon !== undefined ? `${v.lat.toFixed(3)},${v.lon.toFixed(3)}` : 'no fix'}${v.sog !== undefined ? ` · ${v.sog.toFixed(1)} kn` : ''}</span></div>`).join('') : emptyState('ais');
  qa<HTMLElement>('[data-mmsi]', list).forEach(d => d.onclick = () => { state.aisSel = Number(d.dataset.mmsi); const v = state.aisTable.find(x => x.mmsi === state.aisSel); if (v?.lat !== undefined) state.aisView = 'map'; refreshAis(); });
  renderShipCard(state.aisTable.find(v => v.mmsi === state.aisSel));
  if (state.aisView === 'map') geo?.invalidate();
  geo?.setEmpty(state.aisTable.some(v => v.lat !== undefined) ? '' : 'NOTHING HEARD YET', mapEmptySub('ships and buoys appear here as their AIS position reports come in'));
  geo?.update(state.aisTable.filter(v => v.lat !== undefined && v.lon !== undefined).map(v => ({ id: String(v.mmsi), lat: v.lat!, lon: v.lon!, heading: v.hdg ?? v.cog, label: v.name || String(v.mmsi), kind: (v.cls === 'AtoN' ? 'aton' : v.cls === 'base' ? 'object' : 'ship') as GeoItem['kind'] })), String(state.aisSel));
}
function refreshAprs(): void {
  if (state.app !== 'aprs') return;
  // the packet count rides in the card's title, as in the native apps
  if (state.app === 'aprs') setFace('HAM MAP', `${counts['aprs'] ?? 0} PACKETS`);
  qa('[data-aprsview]').forEach(b => b.classList.toggle('on', b.dataset.aprsview === state.aprsView));
  const list = q('#aprs-list'), mapEl = q('#aprs-map'), logEl = q('#aprs-log'); if (!list || !mapEl || !logEl) return;
  list.hidden = state.aprsView !== 'list'; mapEl.hidden = state.aprsView !== 'map'; logEl.hidden = state.aprsView !== 'log';
  if (paused.has('aprs')) { qa<HTMLElement>('[data-call]', list).forEach(d => d.classList.toggle('gold', d.dataset.call === state.aprsSel)); renderStationCard(state.aprsStations.find(s => s.call === state.aprsSel)); return; }
  list.innerHTML = state.aprsStations.length ? state.aprsStations.map((s, i) => `<div class="li row2 tap ${i % 2 ? 'alt' : ''} ${s.call === state.aprsSel ? 'gold' : ''}" data-call="${esc(s.call)}"><b>${esc(s.call)}${s.kind !== 'station' ? ` <small>${s.kind} by ${esc(s.owner ?? '?')}</small>` : ''}</b><span>${esc(aprsSymbolName(s.table, s.symbol))}${s.lat !== undefined && s.lon !== undefined ? ` · ${s.lat.toFixed(3)},${s.lon.toFixed(3)}` : ''}${s.speed ? ` · ${Math.round(s.speed)} kn` : ''}</span></div>`).join('') : emptyState('aprs');
  qa<HTMLElement>('[data-call]', list).forEach(d => d.onclick = () => { state.aprsSel = d.dataset.call!; const s = state.aprsStations.find(x => x.call === state.aprsSel); if (s?.lat !== undefined) state.aprsView = 'map'; refreshAprs(); });
  renderStationCard(state.aprsStations.find(s => s.call === state.aprsSel));
  if (state.aprsView === 'map') geo?.invalidate();
  geo?.setEmpty(state.aprsStations.some(s => s.lat !== undefined) ? '' : 'NOTHING HEARD YET', mapEmptySub('stations, objects and weather reports appear here as their packets come in'));
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
  if (!state.aircraft.length) el.innerHTML = emptyState('adsb');
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
  geo?.setEmpty(state.aircraft.some(a => a.lat !== undefined) ? '' : 'NOTHING HEARD YET', mapEmptySub('aircraft appear here once each one sends its position'));
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
  el.innerHTML = hits.length ? hits.slice(0, 200).map(([, l], i) => `<div class="li tap ${i % 2 ? 'alt' : ''}" data-hit="${l.split(' ')[0]}">${l}</div>`).join('') : emptyState('search');
  qa<HTMLElement>('[data-hit]', el).forEach(d => d.onclick = () => { const mhz = Number(d.dataset.hit); listen(mhz * 1e6, mhz > 87 && mhz < 108 ? 'WFM' : 'NFM'); });
  const r = q('#capr'); if (r) r.textContent = `${hits.length} HITS`;
}
function refreshCapture(): void {
  const b = q('#rec'), info = q('#rec-info'), el = q('#captures');
  if (b) { b.textContent = state.capturing ? '■ STOP' : '● REC'; b.classList.toggle('rec', state.capturing); }
  if (info) info.textContent = state.capturing ? `${(state.captureBytes / 1e6).toFixed(1)} MB · ${state.captureName}` : `${state.rate / 1e6} Msps · ${(state.rate * 2 / 1e6).toFixed(1)} MB/s`;
  if (el) el.innerHTML = state.captures.length ? state.captures.map((f, i) => `<div class="li row2 ${i % 2 ? 'alt' : ''}"><span class="tap" data-dl="${f.name}">${f.name}  ${(f.size / 1e6).toFixed(1)} MB</span><button class="link" data-del="${f.name}">✕</button></div>`).join('') : emptyState('capture');
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
        if (state.app === 'hd') { hdUi.bins = m.bins as Float32Array; hdUi.binsRange = m.rangeDb as number; }
        if (scope) { scope.setScale(m.floorDb as number, m.rangeDb as number); scope.push(m.bins as Float32Array); }
        break;
      // a sweep steers its gain from the 'sweep' message instead: see there
      case 'health': lastHealth = m.line; lastLevel = m.levelDb; loraGain.level = state.app === 'lora' ? m.lora ?? null : null; refreshReadout(); if (state.app !== 'lookingglass' && state.app !== 'search' && state.app !== 'spectrum') agcStep(m.rms as number); log(`${state.board || 'HackRF'} ${m.line}`); if (m.audio) log(`audio: peak=${Math.round(m.audioPeak)}/32000 ${m.audioPeak > 2500 ? '— demod producing audio' : '— silent (no modulation / no signal)'}`); break;
      case 'log': log(m.line); break;
      case 'packet': { if (state.app === 'ham') { const s = state.ham.sat; s.packets.unshift(`${new Date().toTimeString().slice(0, 8)} ${m.line as string}`); if (s.packets.length > 100) s.packets.length = 100; const pk = q('#sat-packet-list'); if (pk) pk.innerHTML = s.packets.map((p, i) => `<div class="li ${i % 2 ? 'alt' : ''}">${p}</div>`).join(''); break; }
        const id = state.app ?? 'x', list = (logs[id] ??= []);
        // a repeat that completed a partial page takes the old line's place rather than adding a second
        const was = typeof m.replaces === 'string' ? list.indexOf(m.replaces) : -1;
        if (was >= 0) list.splice(was, 1); else counts[id] = (counts[id] ?? 0) + 1;
        list.unshift(m.line); if (list.length > 300) list.length = 300; refreshList(id); if (id === 'ais') refreshAis(); else if (id === 'aprs') refreshAprs(); else if (id === 'acars' || id === 'vdl2') onAcarsLine(m.line as string, id); else if (id === 'btle') refreshBle(); break; }
      case 'vdl2frame': onVdl2Frame(m.f as AvlcFrame); break;
      case 'hdsnap': hdUi.snap = m as unknown as HdSnapMsg; hdRecord(hdUi.snap); refreshHd(); break;
      case 'hdobj': hdOnObject(m); break;
      case 'ble': onBleAdv(m as { pdu: number[]; db: number; ch: number }); break;
      case 'rds': lastRds = m as typeof lastRds; drawRds(); break;
      case 'hd': lastHd = m as typeof lastHd; console.log('[hd]', JSON.stringify(m)); drawHd(); break;
      case 'same': onSameAlert(m); break;
      case 'table': state.aisTable = m.rows; refreshAis(); break;
      case 'stations': state.aprsStations = m.rows; refreshAprs(); break;
      case 'meters': meters.snap = m as MetersSnap; refreshMeters(); break;
      case 'uatUp': uatOnUp(new Uint8Array(m.msg as ArrayBuffer | Uint8Array as ArrayBuffer)); refreshUat(); break;
      case 'uatDown': uatOnDown(new Uint8Array(m.bytes as ArrayBuffer | Uint8Array as ArrayBuffer)); refreshUat(); break;
      case 'uatStat': uatData.bad = m.bad as number; break;
      case 'lora': loraUi.snap = m as LoraSnap; refreshLora(); break;
      case 'sonde': sondeUi.snap = m as unknown as SondeSnap; refreshSondes(); break;
      case 'trains': trainsUi.snap = m as TrainsSnap; refreshTrains(); break;
      case 'fleet': fleetUi.snap = m as unknown as FleetSnap; refreshFleet(); break;
      case 'fleetUnit': fleetUi.unit = { key: m.key as string, reports: m.reports as FleetUnitReport[], trail: m.trail as [number, number, number][], offArea: Number(m.offArea) || 0 }; refreshFleet(true); break;
      case 'fleetExport': fleetExport(m.csv as string, m.json as string); break;
      case 'fleetVu': if (state.app === 'fleet') dispatchVu(m.key as string, Number(m.db)); break;
      case 'fleetKnown': dispatchSaveKnown(m.known); break;
      case 'cell': cellUi.snap = m as unknown as CellSnap; refreshCell(); break;
      case 'cellDetail': cellUi.detail = m as unknown as CellDetail; refreshCell(true); break;
      case 'cellExport': cellExport(m.csv as string, m.json as string); break;
      case 'cellState': cellSave(m.state); break;
      case 'atsc': atscUi.snap = m as unknown as AtscSnap; refreshAtsc(); break;
      case 'atscStill': void atscOnStill(m); break;
      case 'atscDetail': atscOnDetail(m); break;
      case 'atscExport': atscExport(m.csv as string, m.json as string); break;
      case 'atscState': atscSave(m.state); break;
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
        const d = m as unknown as HeardDevice & { hz?: number };
        d.hz = state.freq + (d.offsetHz ?? 0);
        const i = r.heard.findIndex(x => x.key === d.key);
        if (i >= 0) r.heard[i] = d; else r.heard.push(d);
        const h = r.hist.get(d.key) ?? [];
        h.push({ t: d.lastSeen, s: r433HistLine(d), hz: d.hz });
        if (h.length > 40) h.shift();
        r.hist.set(d.key, h);
        refreshR433();
        break;
      }
      case 'spframe': spectrumUi.onFrame(m); break;
      case 'zscap': spectrumUi.onCapture(m); break;
      case 'anburst': analyzerUi.onBurst(m.burst as Burst, !!m.file); break;
      case 'anstats': analyzerUi.onStats(m as unknown as Parameters<typeof analyzerUi.onStats>[0]); break;
      case 'animport': analyzerUi.onImport(m as unknown as Parameters<typeof analyzerUi.onImport>[0]); break;
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
      case 'js8': js8OnDecodes(m.list as Js8Decode[], m.speed as Js8Speed, m.slot as number); break;
      case 'js8wf': js8OnWaterfall(m.row as Uint8Array, m.ms as number); break;
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
      ?? await navigator.usb.requestDevice({ filters: [...HACKRF_FILTERS, MAYHEM_SERIAL_FILTER, ...(RTLSDR_READY ? RTLSDR_FILTERS : [])] });
    lastTried = d;
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
    state.biast = false;   // antenna power is off at every connect; keep the UI honest
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
  r.ppm = savedPpm();
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

/** The radio the last CONNECT went for, so a failure names the right one. */
let lastTried: USBDevice | undefined;
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
    const name = lastTried && isRtlSdr(lastTried) ? 'RTL-SDR' : 'HackRF';
    if (os === 'android') text = `Could not open the ${name}: another app has it. When Android asks "Choose an app for the USB device", tap Cancel, or close the app that took it (Mayhem, Wardrive Go, an RTL-SDR driver). Then unplug the radio, plug it back in and tap CONNECT.`;
    else text = `Could not claim the ${name} (${err.message}). Another program probably has it open — close SDR++, SDRangel, GQRX, ${name === 'HackRF' ? 'hackrf_transfer' : 'rtl_tcp'} or a second browser tab, then reconnect.`;
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
    if (state.app === 'analyzer' && analyzerUi.onKey(e)) { e.preventDefault(); return; }
    if (state.app === 'spectrum' && spectrumUi.onKey(e)) { e.preventDefault(); return; }
    // Any field you type into keeps its keys: a textarea or select passing a 'c' through would toggle CONNECT and
    // drop the radio mid-session.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const tunable = !state.app || state.app === 'audio' || state.app === 'capture' || state.app === 'pager' || state.app === 'aprs' || state.app === 'ais' || state.app === 'ert' || state.app === 'lora' || state.app === 'acars' || state.app === 'subghz' || state.app === 'devices' || state.app === 'analyzer';
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
      case 'Escape': if (radioPanelOpen()) closeRadioPanel(); else if (settingsOpen()) closeSettings(); else if (adsbFull && state.app === 'adsb') setAdsbFull(false); else if (meters.full && state.app === 'ert') setMetersFull(false); else if (fleetUi.full && state.app === 'fleet') setFleetFull(false); else if (loraUi.full && state.app === 'lora') setLoraFull(false); else if (sondeUi.full && state.app === 'sondes') setSondeFull(false); else if (state.app) open(null); break;
    }
  });
  // chip strips, the app strips and lists scroll with a held mouse button (touch already pans natively); a real drag
  // swallows the click
  const DRAG_SCROLL = '.bandstrip, .launch-side, .hs-in, .list, .imgwrap, .digitext';
  let drag: { el: HTMLElement; x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
    const el = (e.target as HTMLElement).closest?.(DRAG_SCROLL) as HTMLElement | null;
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
    // A strip that only scrolls sideways (the Home app strip, the app bar, band chips) takes the ordinary vertical
    // wheel as sideways, since a mouse has no other way to move it. It lets go at either end.
    const strip = t.closest?.('.launch-side, .hs-in, .bandstrip') as HTMLElement | null;
    if (strip && !e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)
        && strip.scrollWidth > strip.clientWidth + 1 && strip.scrollHeight <= strip.clientHeight + 1) {
      const dx = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, max = strip.scrollWidth - strip.clientWidth;
      if ((dx < 0 && strip.scrollLeft <= 0) || (dx > 0 && strip.scrollLeft >= max - 1)) return;
      e.preventDefault();
      // Glide, never jump: a jump close to one tile wide reads as the row creeping backward.
      const prev = Number(strip.dataset.wheelTo ?? strip.scrollLeft), from = Math.abs(prev - strip.scrollLeft) > max ? strip.scrollLeft : prev;
      const to = Math.max(0, Math.min(max, from + dx)); strip.dataset.wheelTo = String(to);
      strip.scrollTo({ left: to, behavior: 'smooth' });
      clearTimeout(Number(strip.dataset.wheelT)); strip.dataset.wheelT = String(window.setTimeout(() => { delete strip.dataset.wheelTo; }, 400));
      return;
    }
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

// ---- full screen -----------------------------------------------------------------------------------------------
/* On a phone the app runs full screen: no address bar or status bar in the way, and a swipe down from the top shows
 * them for a moment. A browser only goes full screen from a tap, so the first tap of a visit takes it. Chrome shows
 * its own "swipe to exit" notice each time full screen starts and a page cannot hide it, so once full screen has been
 * left (an edge swipe, back) it is not taken again that visit: the switch in Settings › LOOK brings it back. Installed
 * to the home screen, the manifest opens the app full screen with no notice at all, and nothing is asked here. */
const FS_KEY = 'mm.fullscreen';
const fsCan = () => !!document.documentElement.requestFullscreen;
function fsWanted(): boolean {
  let v: string | null = null;
  try { v = localStorage.getItem(FS_KEY); } catch { /* storage blocked */ }
  return v === null ? matchMedia('(pointer: coarse)').matches : v === '1';
}
function setFsWanted(on: boolean): void {
  try { localStorage.setItem(FS_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
  if (on) enterFullscreen();
  else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}
/** The switch in Settings shows whether the app is full screen now (left with a swipe, it reads off and a tap returns). */
const fsOn = () => !!document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches;
function enterFullscreen(): void {
  if (!fsCan() || document.fullscreenElement) return;
  void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
/** Taps that open a chooser (the USB picker, a file) keep their gesture: full screen waits for the next tap. */
const FS_SKIP = '#connect, #set-connect, #rm-connect, #rp-connect, #an-imp, #log-import, input[type=file], #fs-toggle';
/** Full screen was taken once this visit, or the app already runs full screen as an installed app. */
let fsTaken = false;
function initFullscreen(): void {
  if (matchMedia('(display-mode: fullscreen)').matches) fsTaken = true;
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) fsTaken = true; });
  document.addEventListener('click', (e) => {
    if (fsTaken || !fsWanted() || (e.target as Element | null)?.closest?.(FS_SKIP)) return;
    enterFullscreen();
  });
  // Safari ignores user-scalable=no; its own pinch gesture is turned away here
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

// ---- boot -----------------------------------------------------------------------------------------------------
let versionText = 'dev build', releaseUrl = 'https://github.com/RocketGod-git/mayhem-mobile/releases/tag/latest';

// ---- the phone shell: the Android app's bars ---------------------------------------------------------------------
/** The app bar's order, the native apps' default: by what they do (receive, analyze, transmit, tools), as Home lists them. */
const barApps = (): AppId[] => (['Receive', 'Analyze', 'Transmit', 'Tools'] as const).flatMap(c => APPS.filter(a => a.cat === c && a.id !== 'settings' && !MERGED_INTO[a.id]).map(a => a.id));
/** The app's name in capitals, as its header, Settings and FAVES show it. */
const appName = (id: AppId) => APPS.find(a => a.id === id)?.title.toUpperCase() ?? (id === 'subghz' ? 'SUB-GHZ' : id.toUpperCase());
/** The bar's own shorter names for the longest apps, so a key never takes half the strip (the readout tag uses them too, for
 *  the same room); the header, Settings and FAVES say the full name. */
const BAR_LABEL: Partial<Record<AppId, string>> = { lookingglass: 'GLASS', sat: 'SATS', subghz: 'SUB-GHZ', transmit: 'TX', uat: 'FLIGHT UAT', ert: 'METERS', acars: 'FLIGHT MSGS', adsb: 'FLIGHTS', sondes: 'BALLOONS' };
const barLabel = (id: AppId) => BAR_LABEL[id] ?? appName(id);
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
    if (keyOf(state.app) !== id) openPicked(id);
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
  $('nav-radio').onclick = () => (radioPanelOpen() ? closeRadioPanel() : openRadioPanel());
  $('radio-close').onclick = closeRadioPanel;
  $('radiomodal').onclick = (e) => { if (e.target === $('radiomodal')) closeRadioPanel(); };
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
  js8: ['JS8', 'HF MESSAGING · USB'],
  pager: ['PAGER', 'FLEX · POCSAG'], hd: ['HD RADIO', 'NRSC-5 · FM HYBRID'], vdl2: ['FLIGHT MSGS', 'VDL MODE 2 · 136.975 MHZ'], acars: ['FLIGHT MSGS', 'ACARS · 131 MHZ'], trains: ['TRAINS', 'EOT · PTC'], fleet: ['DISPATCH', 'P25 · DMR TRUNKING'], cell: ['CELL', 'LTE ALERTS · CELL INFO'], atsc: ['TV', 'ATSC · DIGITAL TV · 8VSB'], subghz: ['SUB-GHZ', 'SENSORS · REMOTES · KEYS'],
  ert: ['METERS', 'UTILITY METERS · ERT · MESH · GRIDSTREAM · 802.15.4G'], lora: ['MESH', 'LORA · MESHTASTIC · MESHCORE · LORAWAN'], sondes: ['BALLOONS', 'WEATHER BALLOONS · RADIOSONDES'], btle: ['BLUETOOTH', 'BLE ADVERTISING'], adsb: ['AIRCRAFT', 'ADS-B · 1090 MHZ'], ais: ['SHIPS', 'AIS · 162 MHZ'], aprs: ['HAM MAP', 'APRS · PACKET STATIONS'], uat: ['FLIGHT UAT', 'FLIGHT WEATHER · UAT 978 MHZ'],
  devices: ['DEVICES', 'KEYS · REMOTES · SENSORS'], spectrum: ['SPECTRUM', 'ANALYZER · ZERO SPAN'], analyzer: ['ANALYZER', 'CAPTURE · DEMOD · COMPARE'], capture: ['CAPTURE', 'RAW IQ TO FILE'], prowl: ['PROWL', 'HUNTING FOR VOICE'], lookingglass: ['GLASS', 'WIDEBAND SWEEP'],
  search: ['SEARCH', 'ACTIVE FREQUENCIES'], transmit: ['TX', 'IDLE'], troll: ['TROLL', 'IDLE'],
};
/** The app Settings was opened over: its rows lead the page, and it keeps running underneath. */
let settingsOver: AppId | null = null;
/** The Settings groups opened this visit (all start folded). */
const setOpen = new Set<string>();
const settingsOpen = () => !$('setmodal').hidden;
/** Settings over the running app, which keeps receiving underneath; DONE, Esc or a click outside closes it. */
function openSettings(): void {
  closeRadioPanel();
  setOpen.clear();
  settingsOver = state.app;
  $('setmodal').hidden = false;
  $('set-over').textContent = state.app ? `· ${appName(state.app)}` : '';
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
  view.scrollTop = top;
}
/** A setting changed: redraw the overlay in place. */
function refreshSettings(): void { if (settingsOpen()) drawSettings(); }

// ---- RADIO: the connected radio's own settings -------------------------------------------------------------
/**
 * Everything the connected radio can be told besides frequency, in one place apart from Settings. Each radio lists
 * what it really has (RadioCaps), and only those controls are drawn: a HackRF gets LNA, VGA, the amp, antenna power
 * and the baseband filter; an RTL-SDR gets its tuner gain, the tuner's and the RTL's AGCs, the bias tee, crystal
 * correction and, on an R820T, direct sampling. Every control applies to the radio at once.
 */
const radioPanelOpen = () => !$('radiomodal').hidden;
/** What the panel was drawn for; when the radio changes under it, it is drawn again rather than patched. */
let radioPanelKey = '';
/** The slider being dragged, which a sync must not move under the finger. */
let rpDrag = '';
function openRadioPanel(): void {
  closeSettings();
  $('radiomodal').hidden = false;
  $('radio-over').textContent = state.app ? `· ${appName(state.app)}` : '';
  drawRadioPanel();
  refreshShell();
}
function closeRadioPanel(): void {
  if (!radioPanelOpen()) return;
  $('radiomodal').hidden = true; $('radioview').innerHTML = ''; radioPanelKey = '';
  refreshShell();
}
const rtlRadio = (): RtlSdr | null => (radio && radio.kind === 'rtlsdr' ? radio as RtlSdr : null);
const hackRadio = (): HackRf | null => (radio && radio.kind === 'hackrf' ? radio as HackRf : null);
const mhzTxt = (hz: number) => `${+(hz / 1e6).toFixed(3)} MHz`;
const msps = (hz: number) => `${+(hz / 1e6).toFixed(3)} Msps`;
/** The tuner gain an RTL-SDR is actually running: the app's VGA figure, capped at what the tuner can do. */
const rtlGainDb = () => Math.min(state.vga, RTL_MAX_GAIN_DB);
function radioPanelKeyNow(): string {
  return radio ? `${radio.kind}|${radio.label}|${radio.caps.directSampling}` : 'none';
}
function drawRadioPanel(): void {
  const view = $('radioview'), top = view.scrollTop;
  radioPanelKey = radioPanelKeyNow();
  if (!radio) {
    view.innerHTML = `<section class="controls settings-page"><div class="radiocard"><div><b>NO RADIO</b><small>Plug in a HackRF, a PortaPack in HackRF mode, or an RTL-SDR to see what it can be set to.</small></div><button id="rp-connect" class="act">CONNECT</button></div></section>`;
    q<HTMLElement>('#rp-connect', view)!.onclick = () => $('connect').click();
    return;
  }
  const c = radio.caps, rtl = rtlRadio(), hrf = hackRadio();
  const sub = rtl ? `${rtl.label} · tuner ${rtl.tuner || '?'}` : `${state.board || 'HackRF'}${state.firmware ? ` · fw ${state.firmware}` : ''}`;
  const range = (id: string, min: number, max: number, step: number, v: number) => `<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${v}">`;
  const val = (id: string, text: string) => `<span id="${id}">${text}</span>`;
  let gain = srow('AGC', `The app keeps the level right by stepping the gain${c.stagedGain ? ' (VGA first, then LNA)' : ''}. Moving a gain by hand turns it off.`, swHtml('rp-agc', state.agc), 'automatic gain');
  if (c.stagedGain) {
    gain += srow('LNA', val('rp-lna-v', `${state.lna} dB · 0–40 in 8s`), range('rp-lna', 0, 40, 8, state.lna), 'rf gain low noise amplifier')
      + srow('VGA', val('rp-vga-v', `${state.vga} dB · 0–62 in 2s`), range('rp-vga', 0, 62, 2, state.vga), 'baseband if gain');
  }
  if (c.tunerGain) gain += srow('Tuner gain', val('rp-tg-v', tunerGainText()), range('rp-tg', 0, 48, 2, Math.min(48, state.vga)), 'rf gain');
  if (c.amp) gain += srow('Amp', 'The +14 dB front-end amplifier. Strong local signals can overload it.', swHtml('rp-amp', state.amp), 'amplifier preamp');
  if (c.tunerAgc && rtl) gain += srow('Tuner AGC', 'The R82xx tuner\'s own automatic gain, in place of the app\'s', swHtml('rp-tagc', rtl.tunerAgc), 'hardware agc');
  if (c.rtlAgc && rtl) gain += srow('RTL AGC', 'The RTL2832U\'s digital AGC, which evens out the level after the converter', swHtml('rp-ragc', rtl.rtlAgc), 'digital agc');
  let front = '';
  if (c.biasT) front += srow(rtl ? 'Bias tee' : 'Antenna power', `${c.biasVolts} V DC out the antenna port, for an inline LNA. Off at every connect.`, swHtml('rp-bias', state.biast), 'bias-t bias tee dc lna');
  if (c.bbFilters.length && hrf) {
    const opts = [`<option value="0"${hrf.bbFilterHz ? '' : ' selected'}>AUTO</option>`, ...c.bbFilters.map(b => `<option value="${b}"${hrf.bbFilterHz === b ? ' selected' : ''}>${mhzTxt(b)}</option>`)].join('');
    front += srow('Baseband filter', val('rp-bb-v', bbDesc(hrf)), `<select id="rp-bb" class="txin">${opts}</select>`, 'bandwidth filter');
  }
  const rates = RATE_CHOICES.filter(r => canSample(radio!.limits, r));
  if (!rates.includes(state.rate)) rates.push(state.rate);
  rates.sort((a, b) => b - a);
  let samp = srow('Sample rate', 'Each app opens at its own rate. A change here lasts until you open another app.', `<select id="rp-rate" class="txin">${rates.map(r => `<option value="${r}"${r === state.rate ? ' selected' : ''}>${msps(r)}</option>`).join('')}</select>`, 'bandwidth span');
  if (c.ppm && rtl) samp += srow('Frequency correction', 'Crystal error in parts per million. Remembered for this browser.', `<button id="rp-ppm-m" class="tog">−</button><input id="rp-ppm" class="txin num" type="number" step="1" min="-200" max="200" value="${rtl.ppm}"><button id="rp-ppm-p" class="tog">+</button>`, 'ppm offset crystal');
  if (c.directSampling && rtl) samp += srow('Direct sampling', 'HF below 24 MHz read straight off the ADC (Q branch). Off, the dongle stops at 24 MHz.', swHtml('rp-ds', rtl.directSamplingAllowed), 'hf direct');
  const missing = rtl ? 'No offset tuning: R82xx tuners have no offset mode (librtlsdr refuses it for them too).' : '';
  view.innerHTML = `<section class="controls settings-page">
    <div class="radiocard on"><div><b>${radio.kind === 'rtlsdr' ? 'RTL-SDR' : 'HACKRF'}</b><small>${esc(sub)}</small></div></div>
    ${secHtml('rgain', 'GAIN', gain)}${secHtml('rfront', 'FRONT END', front)}${secHtml('rsamp', 'SAMPLING', samp)}
    ${missing ? `<div class="rp-note">${missing}</div>` : ''}</section>`;
  bindRadioPanel(view);
  view.scrollTop = top;
}
function tunerGainText(): string {
  return `${rtlRadio()?.tunerAgc ? 'tuner AGC' : `${rtlGainDb()} dB`} · 0–${RTL_MAX_GAIN_DB}`;
}
function bbDesc(h: HackRf): string {
  return h.bbFilterHz ? 'Set by hand' : `AUTO follows the sample rate: ${mhzTxt(bbAuto(state.rate))} now`;
}
/** The filter libhackrf picks for a rate: the widest one under it. */
function bbAuto(rate: number): number {
  let chosen = BB_FILTER_BW[0];
  for (const bw of BB_FILTER_BW) { if (bw < rate) chosen = bw; else break; }
  return chosen;
}
function bindRadioPanel(view: HTMLElement): void {
  const el = <T extends HTMLElement>(id: string) => q<T>('#' + id, view);
  const click = (id: string, f: () => void) => { const e = el(id); if (e) e.onclick = f; };
  const slide = (id: string, f: (v: number) => void) => {
    const r = el<HTMLInputElement>(id); if (!r) return;
    r.onpointerdown = () => { rpDrag = id; };
    r.oninput = () => { rpDrag = id; f(Number(r.value)); };
    r.onchange = () => { rpDrag = ''; f(Number(r.value)); };
  };
  click('rp-agc', () => userAgc(!state.agc));
  slide('rp-lna', v => manualGains(v, state.vga, state.amp));
  slide('rp-vga', v => manualGains(state.lna, v, state.amp));
  slide('rp-tg', v => manualGains(state.lna, v, state.amp));
  click('rp-amp', () => { setGains(state.lna, state.vga, !state.amp); saveGains(); });
  click('rp-tagc', () => {
    const r = rtlRadio(); if (!r) return;
    r.tunerAgc = !r.tunerAgc;
    // Two automatic gains fighting over one knob would hunt, so the tuner's takes over from the app's.
    if (r.tunerAgc && state.agc) { setAgc(false); saveGains(); log('tuner AGC on, so the app\'s AGC is off'); }
    syncRadioPanel();
  });
  click('rp-ragc', () => { const r = rtlRadio(); if (r) { r.rtlAgc = !r.rtlAgc; syncRadioPanel(); } });
  click('rp-bias', () => { toggleBiasTee(); syncRadioPanel(); });
  const bb = el<HTMLSelectElement>('rp-bb');
  if (bb) bb.onchange = () => { const h = hackRadio(); if (h) { h.bbFilterHz = Number(bb.value); syncRadioPanel(); } };
  const rate = el<HTMLSelectElement>('rp-rate');
  if (rate) rate.onchange = () => { setRate(Number(rate.value)); rate.blur(); syncRadioPanel(); };
  const ppm = el<HTMLInputElement>('rp-ppm');
  const setPpm = (v: number) => {
    const r = rtlRadio(); if (!r || !Number.isFinite(v)) return;
    r.ppm = Math.max(-200, Math.min(200, Math.round(v)));
    try { localStorage.setItem(PPM_KEY, String(r.ppm)); } catch { /* ignore */ }
    if (ppm) ppm.value = String(r.ppm);
  };
  if (ppm) ppm.onchange = () => setPpm(Number(ppm.value));
  click('rp-ppm-m', () => setPpm((rtlRadio()?.ppm ?? 0) - 1));
  click('rp-ppm-p', () => setPpm((rtlRadio()?.ppm ?? 0) + 1));
  click('rp-ds', () => {
    const r = rtlRadio(); if (!r) return;
    r.setDirectSampling(!r.directSamplingAllowed);
    refreshLauncherLimits();
    syncRadioPanel();
  });
}
/** Where an RTL-SDR's crystal correction is remembered. */
const PPM_KEY = 'mayhem.rtl.ppm';
function savedPpm(): number {
  try { const v = Number(localStorage.getItem(PPM_KEY)); return Number.isFinite(v) ? Math.max(-200, Math.min(200, Math.round(v))) : 0; } catch { return 0; }
}
/** Bring the panel up to date in place: the AGC moves the gains every second, and that must not redraw the page. */
function syncRadioPanel(): void {
  if (!radioPanelOpen()) return;
  if (radioPanelKeyNow() !== radioPanelKey) { drawRadioPanel(); return; }
  const view = $('radioview');
  const sw = (id: string, on: boolean) => { const e = q('#' + id, view); if (e) { e.classList.toggle('on', on); e.setAttribute('aria-checked', String(on)); } };
  const txt = (id: string, t: string) => { const e = q('#' + id, view); if (e) e.textContent = t; };
  const put = (id: string, v: number) => { const e = q<HTMLInputElement>('#' + id, view); if (e && rpDrag !== id) e.value = String(v); };
  const rtl = rtlRadio(), hrf = hackRadio();
  sw('rp-agc', state.agc); sw('rp-amp', state.amp); sw('rp-bias', state.biast);
  put('rp-lna', state.lna); txt('rp-lna-v', `${state.lna} dB · 0–40 in 8s`);
  put('rp-vga', state.vga); txt('rp-vga-v', `${state.vga} dB · 0–62 in 2s`);
  put('rp-tg', Math.min(48, state.vga)); txt('rp-tg-v', tunerGainText());
  if (rtl) { sw('rp-tagc', rtl.tunerAgc); sw('rp-ragc', rtl.rtlAgc); sw('rp-ds', rtl.directSamplingAllowed); }
  if (hrf) txt('rp-bb-v', bbDesc(hrf));
  const rate = q<HTMLSelectElement>('#rp-rate', view);
  if (rate && document.activeElement !== rate && rate.value !== String(state.rate)) drawRadioPanel();
}
/** The phone strip's fill has been put somewhere yet (the first placing jumps; later ones slide). */
let fillPlaced = false;
/** Move the phone strip's fill under the open app's key, sliding there when [slide]; on Home it fades away. */
function placeFill(slide: boolean): void {
  const fill = q<HTMLElement>('#appbar-in .afill'); if (!fill) return;
  const on = q<HTMLElement>(`#appbar-in [data-bar="${keyOf(state.app)}"]`);
  if (!on || !on.offsetWidth) { fill.classList.remove('show'); fillPlaced = false; return; }
  fill.classList.toggle('slide', slide && fillPlaced);
  fill.style.setProperty('--seg', on.style.getPropertyValue('--seg'));
  fill.style.left = `${on.offsetLeft}px`; fill.style.width = `${on.offsetWidth}px`;
  fill.classList.add('show'); fillPlaced = true;
}
/** The app the bar was last scrolled to, so a refresh does not undo the user's own scrolling. */
let barCentered: AppId | null | undefined;
/** The top bar on a phone fits whatever the text size: a phone with larger text (or a narrow screen) gets less letter
 *  spacing first, then the icons alone (each keeps its name as its label for touch and screen readers). */
function fitTopnav(): void {
  const nav = document.getElementById('topnav');
  if (!nav || !nav.offsetWidth) return;
  for (const b of nav.querySelectorAll<HTMLElement>('.tnb')) if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', (b.textContent ?? '').trim());
  nav.classList.remove('tight', 'icons');
  const over = () => nav.scrollWidth > nav.clientWidth + 1 || [...nav.querySelectorAll<HTMLElement>('.tnb')].some(b => b.scrollWidth > b.clientWidth + 1);
  if (over()) nav.classList.add('tight');
  if (over()) nav.classList.add('icons');
}

function refreshShell(): void {
  requestAnimationFrame(fitTopnav);
  const here = keyOf(state.app), setOn = settingsOpen();
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
  $('nav-radio').classList.toggle('on', radioPanelOpen());
  $('radio-btn').classList.toggle('on', radioPanelOpen());
  syncRadioPanel();
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
  list.innerHTML = bookmarks.length ? bookmarks.map((b, i) => `<div class="fav-row" data-fv="${i}"><div><b>${(b.hz / 1e6).toFixed(4)} MHz</b><small>${esc(b.name)} · ${b.app ? appName(b.app) : b.mode}</small></div><button class="x" data-fvx="${i}">✕</button></div>`).join('')
    : '<div class="empty">No FAVES yet. Tune something and tap ☆ beside the frequency.</div>';
  qa<HTMLElement>('[data-fv]', list).forEach(r => r.onclick = (e) => {
    const i = Number(r.dataset.fv);
    if ((e.target as HTMLElement).dataset.fvx !== undefined) { removeBookmark(i); showFaves(true); return; }
    showFaves(false); openBookmark(bookmarks[i]);
  });
}

function init(): void {
  loadSkin();
  initFullscreen();
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
  $('radio-btn').onclick = () => (radioPanelOpen() ? closeRadioPanel() : openRadioPanel());
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
  window.addEventListener('resize', () => { scope?.draw(); sweepScope?.draw(); fitTopnav(); });
  void document.fonts?.ready.then(fitTopnav);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e as Event & { prompt: () => Promise<void> }; });
  fetch('./version.json', { cache: 'no-store' }).then(r => r.json()).then((v: { version: string; commit: string; release: string }) => {
    versionText = `v${v.version} · ${v.commit}`; releaseUrl = v.release;
    const ve = q('#version'); if (ve) ve.textContent = versionText;
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
      const what = isRtlSdr(d) ? 'RTL-SDR' : isMayhemSerial(d) ? 'PortaPack' : 'HackRF';
      setStatus(`${what} remembered — connecting…`, false);
      void connect(d).catch(() => setStatus(`${what} remembered — tap CONNECT`, false));
    }).catch(() => undefined);
    navigator.usb.addEventListener('connect', (e) => {
      const d = e.device;
      log(`USB attached: ${d.productName ?? ''}`);
      if (radio?.running) return;
      // A PortaPack in Mayhem mode is switched to HackRF mode as soon as it is plugged in, and the HackRF it
      // reboots into is connected when it comes back, the same as the Android app does.
      if (isMayhemSerial(d)) { void connect(d).catch(() => undefined); return; }
      // The browser only reports devices this site was already allowed to use, so any radio that shows up here
      // connects on its own: no chooser and no tap after the first time.
      if (isHackRf(d) || (RTLSDR_READY && isRtlSdr(d))) {
        const what = isRtlSdr(d) ? 'RTL-SDR' : Date.now() - ppSwitchedAt < 30_000 ? 'PortaPack in HackRF mode' : 'HackRF';
        ppSwitchedAt = 0;
        setStatus(`${what}, connecting…`, false);
        void connect(d).catch(() => setStatus(`${what} attached, tap CONNECT`, false));
      }
    });
    // Only the radio leaving stops the radio. Any USB device detaching used to end the session - a phone on charge,
    // a hub dropping a port - which looked like the SDR disconnecting by itself.
    navigator.usb.addEventListener('disconnect', (e) => { log(`USB detached: ${e.device.productName ?? ''}`); if (e.device === radioDev) radio?.stop(); });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  log('Mayhem Mobile web ready');
}

init();
