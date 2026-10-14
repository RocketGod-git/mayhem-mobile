import { HackRf, HACKRF_FILTERS, isMayhemSerial } from './hackrf.js';
import { RTLSDR_FILTERS, RTLSDR_READY, RtlSdr, isRtlSdr } from './rtlsdr.js';
import { APP_NEEDS, blockedBecause, nearestRate, whyNot } from './radio.js';
import { lookupCall, offlineInfo, latLonToGrid, gridToLatLon, distanceBearing, toAdif, fromAdif, bandOfHz, parseCall } from './callsign.js';
import { SKINS, applySkin, currentSkin, loadSkin } from './theme.js';
import { glyph } from './glyphs.js';
import { Scope, centredLabels, rangeLabels, rowToSpec } from './scope.js';
import { btleChannelFreq } from './dsp/btle.js';
import { ORBCOMM_CHANNELS } from './dsp/orbcomm.js';
import { fetchGroup } from './sat.js';
import { PACKET_SATS } from './packet-sats.js';
import { GEOSCAN_SATS } from './dsp/geoscan.js';
import { CREDITS } from './credits.js';
import { Tx } from './tx.js';
import * as Apps from './tx-apps.js';
import { aprsSymbolName } from './aprs-info.js';
import { GeoMap } from './geomap.js';
import { mmsiInfo, shipTypeName, navStatusName, atonTypeName } from './ais-info.js';
import { BANDS, NON_HAM, bandOf, segmentOf, repeaterInput } from './bands.js';
import { SATS, Sgp4, look, doppler, passes, fetchTles, dopplerUp } from './sat.js';
const RX_RATE = 1920000;
const APPS = [
    { id: 'ham', title: 'HAM', blurb: 'SSB · CW · AM · NFM · repeaters · CTCSS', cat: 'Receive' },
    { id: 'audio', title: 'Audio', blurb: 'WFM · NFM · AM · SSB receiver', cat: 'Receive' },
    { id: 'devices', title: 'Devices', blurb: 'alarms, meters, remotes, tire sensors, weather', cat: 'Receive' },
    { id: 'sat', title: 'Satellites', blurb: 'track, listen to and decode what is overhead', cat: 'Receive' },
    { id: 'adsb', title: 'ADS-B', blurb: 'aircraft, 1090 MHz', cat: 'Receive' },
    { id: 'ais', title: 'AIS', blurb: 'ships, 162 MHz', cat: 'Receive' },
    { id: 'aprs', title: 'APRS', blurb: 'packet radio, 144.39 MHz', cat: 'Receive' },
    { id: 'pager', title: 'FLEX', blurb: 'pager RX · FLEX, or POCSAG too', cat: 'Receive' },
    { id: 'ert', title: 'ERT', blurb: 'utility meters, 915 MHz', cat: 'Receive' },
    { id: 'btle', title: 'BLE RX', blurb: 'advertising, 2.4 GHz', cat: 'Receive' },
    { id: 'tpms', title: 'TPMS', blurb: 'tire pressure, 315 / 433 MHz', cat: 'Receive' },
    { id: 'acars', title: 'ACARS', blurb: 'aircraft messages, 131 MHz', cat: 'Receive' },
    { id: 'subghz', title: 'Sub-GHz', blurb: 'weather · remotes · car keys, rtl_433 style', cat: 'Receive' },
    { id: 'prowl', title: 'Prowl', blurb: 'hunts live voice across the bands', cat: 'Receive' },
    { id: 'lookingglass', title: 'Looking Glass', blurb: 'wideband sweep waterfall', cat: 'Analyze' },
    { id: 'search', title: 'Search', blurb: 'find active frequencies', cat: 'Analyze' },
    { id: 'capture', title: 'Capture', blurb: 'record raw IQ to file', cat: 'Tools' },
    { id: 'transmit', title: 'Transmit', blurb: 'signal gen · morse · OOK', cat: 'Transmit' },
    { id: 'troll', title: 'Troll', blurb: 'sub-GHz pranks · weather spoof · cart sounds', cat: 'Transmit' },
    { id: 'settings', title: 'Settings', blurb: 'theme · about · install', cat: 'Tools' },
];
const RANGES = [
    ['FM 88-108', 88e6, 108e6], ['AIR 118-137', 118e6, 137e6], ['2m 144-148', 144e6, 148e6], ['70cm 420-450', 420e6, 450e6],
    ['ISM 902-928', 902e6, 928e6], ['GSM 925-960', 925e6, 960e6], ['1.2-1.6G', 1200e6, 1600e6], ['2.4G ISM', 2400e6, 2483e6],
    ['0.1-1 GHz', 100e6, 1000e6], ['1-3 GHz', 1000e6, 3000e6], ['3-6 GHz', 3000e6, 6000e6],
];
const $ = (id) => document.getElementById(id);
const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const state = {
    app: null,
    freq: 92300000, rate: RX_RATE, mode: 'WFM', lna: 32, vga: 32, amp: false,
    radioFreq: 92300000, radioMode: 'WFM',
    dial: loadDial(),
    hamLo: 0,
    launchBand: 'fm',
    viewLo: 0,
    ham: { freq: 146520000, mode: 'NFM', lo: 300, hi: 6000, pitch: 600, agc: 'slow', nr: false, anf: false, squelch: 6, volume: 1, shift: 0, rev: false, back: 0,
        db: -120, floor: -120, open: true, tone: 0, toneDb: 0, dcs: 0, dcsInv: false, gain: 1, audioPeak: 0,
        digi: { mode: 'off', dmrSlot: 0, dmr: null, p25: null, text: '', winner: '', conf: [], wpm: 0, pskHz: 1000, rttyBaud: 45.45, rttyShift: 170, rttyRev: false, ft8: [] },
        sat: { sel: 25544, svc: 0, view: 'track', tles: new Map(), track: false, dopplerOn: true, passes: [], status: '', packets: [] },
        img: { mode: '', width: 0, height: 0, line: 0, done: false, apt: 0, lrpt: { planes: {}, lines: 0, stats: '' } },
        log: { entries: loadLog(), draft: { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' }, info: null, editing: '' },
        station: loadStation(),
        ptt: { dev: 2500, tone: 0, on: false },
        tab: 'rx', mon: { spacing: 12500, threshold: 8, mode: 'mix', lock: -1, wide: false, first: 0, count: 0, snr: new Float32Array(0), open: [], listening: [], tones: {}, dcs: {}, since: [], log: [] } },
    sweepRate: 8000000, sweep: null,
    btleCh: 37, threshold: 15, pager: 'flex',
    ism: { weather: true, remotes: true, cars: true },
    r433: { heard: [], stats: null, hop: false, band: 0,
        protocols: [], showProtocols: false, span: 250000 }, muted: false, adsbView: 'map', adsbFollow: true, adsbSel: '', home: null,
    capturing: false, captureName: '', captureBytes: 0, captures: [],
    aircraft: [], frames: 0, aisTable: [], aisSel: 0, aisView: 'map',
    aprsStations: [], aprsSel: '', aprsView: 'map',
    connected: false, board: '', firmware: '', gainsScaled: false, agc: true,
    squelch: 0, sqOpen: true, scanning: false,
    prowl: {
        on: false, target: null, tracks: new Map(), log: [],
        note: '', band: '', win: -1, movedAt: 0, score: 0, best: 0, parts: '', sweep: false, seen: 0, ready: 0,
        held: null,
    },
    psat: { sats: [], sel: -1, frames: [], heard: 0, bad: 0, note: '',
        framing: 'g3ruh', pic: { frames: 0, bad: 0, high: 0, complete: false, fragments: 0, url: '' } },
    orb: {
        channel: 137662500, hunt: false, huntAt: 0, sel: -1,
        sats: [], frames: 0, packets: 0, bad: 0, syncs: 0, lastFrames: 0,
        orbits: [],
        named: new Map(),
    },
};
let bookmarks = loadBookmarks();
let scanTimer = 0, scanIdx = 0, scanHopAt = 0;
const logs = {};
const counts = {};
const diag = [];
let logFollow = true;
let radio = null;
const tx = new Tx(() => (radio && radio.kind === 'hackrf' ? radio : null));
let worker = null;
let audioCtx = null;
let audioPort = null;
let muteGain = null;
let scope = null;
let sweepScope = null;
let lastSweepRow = new Float32Array(0);
let lastSweepBinHz = 0;
let sweepLiveRow = new Float32Array(0);
let lastLiveSpec = 0;
let installPrompt = null;
let lastHealth = '';
let lastCenterSent = 0;
let lastLevel = 0;
let geo = null;
function log(line) {
    const t = new Date();
    const ts = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}.${t.getMilliseconds().toString().padStart(3, '0')}`;
    diag.push(`${ts} ${line}`);
    if (diag.length > 4000)
        diag.shift();
    console.log('[mayhem]', line);
    const el = $('log');
    if (el && !$('log-panel').hidden) {
        el.textContent = diag.join('\n');
        if (logFollow)
            el.scrollTop = el.scrollHeight;
    }
}
function logHeader() {
    const s = screen;
    return [
        `Mayhem Mobile (web) ${versionText}`,
        `${navigator.userAgent}`,
        `platform ${navigator.platform || '?'} \u00b7 ${s.width}x${s.height} @${devicePixelRatio}x \u00b7 ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `radio ${state.board ? `${state.board}${state.firmware ? ' \u00b7 fw ' + state.firmware : ''}` : 'none attached'}`,
        `captured ${new Date().toISOString()} \u00b7 ${diag.length} lines`,
    ].join('\n');
}
function logText() { return logHeader() + '\n\n' + diag.join('\n'); }
function setTools(open) {
    $('toolbar').classList.toggle('open', open);
    $('tools').textContent = open ? '✕' : '☰';
    $('tools').classList.toggle('on', open);
}
function toggleMute() {
    state.muted = !state.muted;
    if (muteGain)
        muteGain.gain.value = state.muted ? 0 : 1;
    const b = q('#mute');
    if (b) {
        b.textContent = state.muted ? 'UNMUTE' : 'MUTE';
        b.classList.toggle('on', state.muted);
    }
}
function setStatus(s, connected) {
    if (connected !== state.connected)
        setTools(!connected);
    state.connected = connected;
    $('status').textContent = s;
    $('dot').className = 'dot ' + (connected ? 'on' : 'off');
    $('board').textContent = state.board ? `${state.board} · ${state.firmware}` : 'no device';
}
function loadDial() { try {
    return Number(localStorage.getItem('mayhem.dial')) || 0;
}
catch {
    return 0;
} }
let dialSaveTimer = 0;
function setDial(hz) {
    state.dial = hz;
    clearTimeout(dialSaveTimer);
    dialSaveTimer = window.setTimeout(() => { try {
        localStorage.setItem('mayhem.dial', String(state.dial));
    }
    catch { } }, 500);
}
let silentTune = false;
function tune(hz, hold = false) {
    if (state.app === 'ham') {
        hamTune(hz);
        return;
    }
    state.freq = Math.min(6000000000, Math.max(1000000, Math.round(hz)));
    if (state.app === null && state.viewLo && hold) {
        const reach = state.rate / 2 - VIEW_GUARD;
        state.freq = Math.max(state.viewLo - reach, Math.min(state.viewLo + reach, state.freq));
    }
    if (state.app === 'audio' || state.app === 'capture')
        state.radioFreq = state.freq;
    if (generalPurpose() && !silentTune)
        setDial(state.freq);
    if (tunesInSpan()) {
        const prevLo = state.viewLo;
        if (Math.abs(state.freq - state.viewLo) > state.rate / 2 - VIEW_GUARD)
            state.viewLo = state.freq;
        if (state.viewLo !== prevLo)
            scope?.shiftSpan((state.viewLo - prevLo) / state.rate);
        if (radio)
            radio.targetFreqHz = state.viewLo;
        sendOffset();
        refreshChannel();
    }
    else if (radio)
        radio.targetFreqHz = state.freq;
    refreshReadout();
    qa('[data-bm]').forEach(b => b.classList.toggle('on', bookmarks[Number(b.dataset.bm)]?.hz === state.freq));
}
const VIEW_GUARD = 100000;
const tunedHz = () => state.app === 'ham' ? state.ham.freq : state.freq;
function favIndex() {
    const hz = tunedHz();
    return bookmarks.findIndex(b => Math.abs(b.hz - hz) < 50);
}
function toggleFav() {
    const i = favIndex();
    if (i >= 0) {
        bookmarks.splice(i, 1);
        saveBookmarks();
        refreshBookmarks();
        refreshFav();
        log(`removed ${(tunedHz() / 1e6).toFixed(4)} from favorites`);
        return;
    }
    const hz = tunedHz(), h = state.ham;
    const b = {
        name: `${(hz / 1e6).toFixed(4)} ${state.app === 'ham' ? h.mode : state.mode}`,
        hz, mode: state.app === 'ham' ? 'NFM' : state.mode, app: state.app ?? 'audio',
        lna: state.lna, vga: state.vga, amp: state.amp, agc: state.agc, squelch: state.squelch,
    };
    if (state.app === 'ham')
        b.ham = { mode: h.mode, lo: h.lo, hi: h.hi, squelch: h.squelch, agc: h.agc, nr: h.nr, anf: h.anf, digi: h.digi.mode };
    bookmarks = bookmarks.filter(x => Math.abs(x.hz - hz) >= 50);
    bookmarks.push(b);
    saveBookmarks();
    refreshBookmarks();
    refreshFav();
    log(`saved ${b.name} to favorites`);
}
function refreshFav() {
    const el = q('#fav');
    if (!el)
        return;
    const on = favIndex() >= 0;
    el.classList.toggle('on', on);
    el.textContent = on ? '★' : '☆';
    el.title = on ? 'remove from favorites' : 'save this to favorites';
}
const tunesInSpan = () => state.app !== 'ham' && (state.app === null || state.mode !== 'NONE');
const generalPurpose = () => state.app === 'audio' || state.app === 'prowl' || state.app === 'capture' || state.app === 'transmit' || !state.app;
function sendOffset() { worker?.postMessage({ type: 'config', offsetHz: tunesInSpan() ? state.freq - state.viewLo : 0 }); }
function channelOff() {
    if (state.app === 'ham')
        return state.ham.tab !== 'monitor' && Math.abs(state.ham.freq - state.hamLo) > state.rate / 2 - 40000;
    return tunesInSpan() && Math.abs(state.freq - state.viewLo) > state.rate / 2 - 40000;
}
function previewFreq(hz) {
    const r = q('.readout');
    if (!r)
        return;
    r.classList.toggle('preview', hz !== null);
    setFreqDisplay(hz ?? state.freq);
}
function setSquelch(db) {
    state.squelch = db;
    worker?.postMessage({ type: 'config', squelch: db });
    qa('[data-sql]').forEach(b => b.classList.toggle('on', Number(b.dataset.sql) === db));
    if (db === 0) {
        state.sqOpen = true;
        refreshSquelch();
    }
}
function refreshSquelch() {
    const el = q('#sq');
    if (!el)
        return;
    el.hidden = state.squelch === 0 && !state.scanning;
    el.classList.toggle('open', state.sqOpen);
    el.textContent = state.scanning ? (state.sqOpen ? 'SCAN · SIGNAL' : 'SCAN') : state.sqOpen ? 'OPEN' : 'SQL';
}
function loadBookmarks() {
    try {
        const v = JSON.parse(localStorage.getItem('mayhem.bookmarks') ?? '[]');
        if (Array.isArray(v))
            return v.filter(b => typeof b?.hz === 'number');
    }
    catch { }
    return [];
}
function saveBookmarks() { try {
    localStorage.setItem('mayhem.bookmarks', JSON.stringify(bookmarks));
}
catch { } }
function addBookmark() {
    const label = `${(state.freq / 1e6).toFixed(4)} ${state.mode}`;
    const name = (prompt('Bookmark name', label) ?? '').trim();
    if (!name)
        return;
    bookmarks = bookmarks.filter(b => b.hz !== state.freq || b.mode !== state.mode);
    bookmarks.push({ name, hz: state.freq, mode: state.mode });
    saveBookmarks();
    refreshBookmarks();
}
function removeBookmark(i) { bookmarks.splice(i, 1); saveBookmarks(); refreshBookmarks(); }
function goBookmark(b) { setMode(b.mode); tune(b.hz); }
function openBookmark(b) {
    if (b.app && b.app !== state.app)
        open(b.app);
    if (typeof b.lna === 'number' && typeof b.vga === 'number') {
        if (b.agc === false)
            manualGains(b.lna, b.vga, !!b.amp);
        else
            setGains(b.lna, b.vga, !!b.amp);
    }
    if (b.app === 'ham' && b.ham) {
        const h = state.ham;
        h.lo = b.ham.lo;
        h.hi = b.ham.hi;
        h.squelch = b.ham.squelch;
        h.agc = b.ham.agc;
        h.nr = b.ham.nr;
        h.anf = b.ham.anf;
        hamSetMode(b.ham.mode);
        hamTune(b.hz);
        refreshHamUi();
        return;
    }
    if (typeof b.squelch === 'number')
        setSquelch(b.squelch);
    setMode(b.mode);
    tune(b.hz);
}
function setScanning(on) {
    state.scanning = on && bookmarks.length > 1;
    if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = 0;
    }
    if (state.scanning) {
        if (state.squelch === 0)
            setSquelch(12);
        scanIdx = Math.max(0, bookmarks.findIndex(b => b.hz === state.freq));
        scanHopAt = performance.now();
        scanTimer = window.setInterval(() => {
            if (state.app !== 'audio') {
                setScanning(false);
                return;
            }
            const now = performance.now();
            if (state.sqOpen && now - scanHopAt > 250)
                return;
            if (now - scanHopAt < 250)
                return;
            scanIdx = (scanIdx + 1) % bookmarks.length;
            goBookmark(bookmarks[scanIdx]);
            scanHopAt = now;
            refreshBookmarks();
        }, 100);
    }
    else if (on)
        log('scan needs at least two bookmarks — ★ SAVE some first');
    const b = q('#scan');
    if (b)
        b.classList.toggle('on', state.scanning);
    refreshSquelch();
}
function refreshBookmarks() {
    const el = q('#bookmarks');
    if (!el)
        return;
    el.innerHTML = bookmarks.map((b, i) => `<button class="chip bm ${b.hz === state.freq ? 'on' : ''}" data-bm="${i}">${esc(b.name)}<i data-bmx="${i}">✕</i></button>`).join('') || '<span class="empty">no bookmarks — tune something and tap ★ SAVE</span>';
    qa('[data-bm]', el).forEach(b => b.onclick = (ev) => {
        const i = Number(b.dataset.bm);
        if (ev.target.dataset.bmx !== undefined) {
            removeBookmark(i);
            return;
        }
        if (state.scanning)
            setScanning(false);
        openBookmark(bookmarks[i]);
        refreshBookmarks();
    });
}
function setMode(m) {
    state.mode = m;
    if (tunesInSpan() && m !== 'NONE')
        state.radioMode = m;
    worker?.postMessage({ type: 'config', mode: m });
    qa('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    refreshChannel();
    if (m !== 'WFM') {
        lastRds = null;
        lastHd = null;
    }
    drawRds();
    drawHd();
}
function setRate(r) {
    if (radio) {
        const ok = nearestRate(radio.limits, r);
        if (ok !== r) {
            log(`${radio.label}: ${(r / 1e6).toFixed(3)} Msps is out of range — using ${(ok / 1e6).toFixed(3)}`);
            r = ok;
        }
    }
    state.rate = r;
    if (radio)
        radio.targetRateHz = r;
    worker?.postMessage({ type: 'config', rate: r });
    refreshReadout();
    qa('[data-rate]').forEach(b => b.classList.toggle('on', Number(b.dataset.rate) === r));
}
let gainPref = loadGains();
function loadGains() {
    try {
        const v = JSON.parse(localStorage.getItem('mayhem.gain') ?? 'null');
        if (v && typeof v.lna === 'number' && typeof v.vga === 'number')
            return { lna: v.lna, vga: v.vga, amp: !!v.amp, agc: v.agc !== false };
    }
    catch { }
    return null;
}
function saveGains() {
    gainPref = { lna: state.lna, vga: state.vga, amp: state.amp, agc: state.agc };
    try {
        localStorage.setItem('mayhem.gain', JSON.stringify(gainPref));
    }
    catch { }
}
function setGains(lna, vga, amp) {
    state.lna = Math.max(0, Math.min(40, lna)) & ~7;
    state.vga = Math.max(0, Math.min(62, vga)) & ~1;
    state.amp = amp;
    radio?.setGain(state.lna, state.vga, state.amp);
    const l = q('#lna'), v = q('#vga'), a = q('#amp');
    const auto = state.agc ? ' AUTO' : '';
    if (l) {
        l.textContent = `LNA ${state.lna}${auto}`;
        l.classList.toggle('auto', state.agc);
    }
    if (v) {
        v.textContent = `${radio?.kind === 'rtlsdr' ? 'GAIN' : 'VGA'} ${state.vga}${auto}`;
        v.classList.toggle('auto', state.agc);
    }
    if (a) {
        a.textContent = state.amp ? 'AMP +14' : 'AMP OFF';
        a.classList.toggle('on', state.amp);
    }
    refreshAgcChip();
    refreshGainUi();
}
function refreshGainUi() {
    const rtl = radio?.kind === 'rtlsdr';
    const lnaStep = q('#lna')?.closest('.stepper');
    const amp = q('#amp');
    const cap = q('#gain-cap');
    if (lnaStep)
        lnaStep.hidden = rtl;
    if (amp)
        amp.hidden = rtl;
    if (cap)
        cap.textContent = rtl ? 'GAIN · AGC / TUNER · 0–48.8 dB' : 'GAIN';
}
function refreshAgcChip() {
    const b = q('#agc');
    if (b) {
        b.textContent = state.agc ? 'AGC SETS GAIN' : 'GAIN IS MINE';
        b.classList.toggle('on', state.agc);
    }
    const l = q('#lna'), v = q('#vga');
    if (l) {
        l.textContent = `LNA ${state.lna}${state.agc ? ' AUTO' : ''}`;
        l.classList.toggle('auto', state.agc);
    }
    if (v) {
        v.textContent = `${radio?.kind === 'rtlsdr' ? 'GAIN' : 'VGA'} ${state.vga}${state.agc ? ' AUTO' : ''}`;
        v.classList.toggle('auto', state.agc);
    }
}
function setAgc(on) { state.agc = on; refreshAgcChip(); if (on)
    agcLast = 0; }
const userAgc = (on) => { setAgc(on); saveGains(); };
const manualGains = (lna, vga, amp) => {
    if (state.agc)
        log('gain set by hand, so the automatic gain is off — tap AGC to hand it back');
    setAgc(false);
    setGains(lna, vga, amp);
    saveGains();
};
let agcLast = 0, agcSaidMax = 0;
const AGC_LO = 7, AGC_HI = 22;
function agcTargets() {
    const scale = Math.min(3.2, Math.sqrt(state.rate / RX_RATE));
    return [Math.min(24, AGC_LO * scale), Math.min(34, AGC_HI * scale)];
}
function agcStep(rms) {
    if (!state.agc || !radio || tx.active || state.app === 'transmit' || !Number.isFinite(rms))
        return;
    const now = performance.now();
    if (now - agcLast < 900)
        return;
    agcLast = now;
    const [lo, hi] = agcTargets();
    if (rms < lo) {
        if (state.vga < 62)
            setGains(state.lna, state.vga + (rms < 2 ? 8 : 2), state.amp);
        else if (state.lna < 40)
            setGains(state.lna + 8, state.vga, state.amp);
        else if (state.mode !== 'NONE' && now - agcSaidMax > 20000) {
            agcSaidMax = now;
            log(`AGC is at maximum and the level is still ${rms.toFixed(1)} counts — check the antenna, or turn AGC off if you want to set the gain yourself`);
        }
    }
    else if (rms > hi) {
        if (state.vga > 0)
            setGains(state.lna, state.vga - (rms > hi * 2 ? 8 : 2), state.amp);
        else if (state.lna > 0)
            setGains(state.lna - 8, state.vga, state.amp);
    }
}
const isPro = () => /pro/i.test(state.board);
function boardGains(lna, vga, amp) {
    if (!isPro())
        return [lna, vga, amp];
    return [40, Math.min(amp ? 56 : 62, vga + 28), amp];
}
function configure(mode, freq, rate, lna, vga, amp, app, extra = {}) {
    worker?.postMessage({ type: 'app', app: 'none' });
    state.mode = mode;
    state.rate = rate;
    state.freq = freq;
    state.viewLo = freq;
    if (radio) {
        const no = whyNot(radio.limits, freq, rate);
        if (no) {
            log(`${radio.label}: this app ${no}.`);
            setStatus(`${radio.label} cannot do this one — ${no}`, true);
        }
        rate = nearestRate(radio.limits, rate);
        state.rate = rate;
        radio.targetFreqHz = freq;
        radio.targetRateHz = rate;
    }
    if (!radio || radio.kind === 'hackrf') {
        [lna, vga, amp] = boardGains(lna, vga, amp);
        state.gainsScaled = isPro();
    }
    if (gainPref) {
        lna = gainPref.lna;
        vga = gainPref.vga;
        amp = gainPref.amp;
        state.agc = gainPref.agc;
    }
    else {
        lna = Math.max(lna, 32);
        vga = Math.max(vga, 32);
        if (radio && radio.kind === 'hackrf')
            amp = true;
    }
    setGains(lna, vga, amp);
    worker?.postMessage({ type: 'config', mode, rate, offsetHz: 0 });
    worker?.postMessage({ type: 'app', app, ...extra });
}
function ackTune(s) {
    if (!radio || (state.app !== 'lookingglass' && state.app !== 'search'))
        return;
    const m = /(\d+\.\d+) MHz/.exec(s);
    if (!m)
        return;
    if (Math.abs(Number(m[1]) * 1e6 - radio.targetFreqHz) < 600)
        worker?.postMessage({ type: 'tuned' });
}
function startSweep(start, end) {
    if (radio) {
        const ok = nearestRate(radio.limits, state.sweepRate);
        if (ok !== state.sweepRate) {
            log(`${radio.label}: ${state.sweepRate / 1e6} MHz slices are out of range — sweeping in ${(ok / 1e6).toFixed(2)} MHz`);
            state.sweepRate = ok;
        }
    }
    const steps = Math.max(1, Math.ceil((end - start) / (state.sweepRate * 204 / 256)));
    state.sweep = { start, end, steps };
    lastSweepRow = new Float32Array(0);
    sweepLiveRow = new Float32Array(0);
    configure('NONE', start + state.sweepRate / 2, state.sweepRate, 24, 24, false, 'sweep', { start, end, slice: state.sweepRate });
    const t = q('#sweep-title');
    if (t)
        t.textContent = sweepTitle(0, 0);
    sweepScope?.clear();
    qa('[data-range]').forEach(b => b.classList.toggle('on', Number(b.dataset.range) === start));
}
function sweepTitle(progress, sweeps) {
    const s = state.sweep;
    if (!s)
        return 'no sweep';
    const mhz = (hz) => (hz / 1e6).toFixed(hz % 1e6 ? 1 : 0);
    return `${mhz(s.start)}–${mhz(s.end)} MHz · ${progress}/${s.steps} · #${sweeps}`;
}
function listen(hz, mode) {
    state.radioFreq = Math.round(hz / 10000) * 10000;
    state.radioMode = mode;
    open('audio');
}
const LAUNCH_BANDS = [
    { id: 'fm', name: 'FM', lo: 88000000, hi: 108000000, what: 'broadcast radio', mode: 'WFM' },
    { id: 'air', name: 'AIR', lo: 118000000, hi: 137000000, what: 'airband AM', mode: 'AM' },
    { id: 'vhf', name: 'VHF', lo: 144000000, hi: 163000000, what: 'two metres, marine, weather', mode: 'NFM' },
    { id: 'ism3', name: '315', lo: 314000000, hi: 316000000, what: 'American remotes and sensors', mode: 'NONE' },
    { id: 'uhf', name: 'UHF', lo: 430000000, hi: 450000000, what: 'seventy centimetres', mode: 'NFM' },
    { id: 'ism4', name: '433', lo: 433000000, hi: 435000000, what: 'European remotes and sensors', mode: 'NONE' },
    { id: 'ism9', name: '915', lo: 902000000, hi: 928000000, what: 'meters and telemetry', mode: 'NONE' },
    { id: 'adsb', name: '1090', lo: 1089000000, hi: 1091000000, what: 'aircraft', mode: 'NONE' },
];
function bandChipsHtml() {
    return LAUNCH_BANDS.map(b => `<button class="chip" data-lband="${b.id}" title="${esc(b.name)} · ${esc(b.what)} · ${(b.lo / 1e6).toFixed(0)}–${(b.hi / 1e6).toFixed(0)} MHz">${b.name}</button>`).join('');
}
function gotoBand(id) {
    const b = LAUNCH_BANDS.find(x => x.id === id);
    if (!b)
        return;
    if (state.app === null) {
        state.launchBand = id;
        applyLauncherView();
    }
    else {
        setMode(b.mode === 'NONE' ? 'NFM' : b.mode);
        tune(Math.round((b.lo + b.hi) / 2));
    }
    highlightBands();
}
function highlightBands() {
    const hz = tunedHz();
    const cur = state.app === null ? state.launchBand : (LAUNCH_BANDS.find(x => hz >= x.lo && hz <= x.hi)?.id ?? '');
    qa('[data-lband]').forEach(el => el.classList.toggle('on', el.dataset.lband === cur));
}
function launcherView() {
    const b = LAUNCH_BANDS.find(x => x.id === state.launchBand) ?? LAUNCH_BANDS[0];
    const widest = radio ? Math.max(...radio.limits.rates.map(([, hi]) => hi)) : RX_RATE;
    const cap = RX_RATES[Math.min(maxRateIdx(), RX_RATES.length - 1)];
    const rate = Math.max(RX_RATE, Math.min(widest, cap, b.hi - b.lo));
    return { center: Math.round((b.lo + b.hi) / 2), rate, mode: b.mode };
}
function applyLauncherView() {
    if (state.app)
        return;
    launchPicked = false;
    const v = launcherView();
    configure(v.mode, v.center, v.rate, 24, 24, false, 'none');
    refreshReadout();
    refreshChannel();
    sendOffset();
    scope?.setLabels(centredLabels(state.freq, state.rate));
}
function open(app) {
    if (state.capturing) {
        worker?.postMessage({ type: 'capture', cmd: 'stop' });
        state.capturing = false;
    }
    if (state.scanning && app !== 'audio')
        setScanning(false);
    if (state.prowl.on && app !== 'prowl')
        prowlStop();
    const prev = state.app;
    const dial = state.dial || state.radioFreq;
    if (state.dial && app === 'ham' && prev === null)
        state.ham.freq = state.dial;
    state.app = app;
    ensureWorker();
    switch (app) {
        case null: {
            const v = launcherView();
            configure(v.mode, v.center, v.rate, 32, 32, false, 'none');
            setAgc(true);
            launchPicked = false;
            break;
        }
        case 'settings':
            configure('NONE', dial, RX_RATE, 24, 24, false, 'none');
            break;
        case 'ham':
            hamOpen();
            return;
        case 'audio':
            configure(state.radioMode, prev === null ? state.freq : dial, RX_RATE, 24, 24, false, 'none');
            break;
        case 'prowl':
            configure('NFM', state.prowl.target ? state.freq : dial, Math.max(RX_RATE, state.rate), 24, 24, false, 'none');
            break;
        case 'adsb':
            configure('NONE', 1090000000, 2e6, 32, 32, true, 'adsb');
            requestGeo();
            break;
        case 'sat':
            satAppOpen();
            return;
        case 'ais':
            configure('NFM', 161975000, 2e6, 32, 32, false, 'ais');
            requestGeo();
            break;
        case 'aprs':
            configure('NFM', 144390000, 2e6, 24, 24, false, 'aprs');
            requestGeo();
            break;
        case 'pager':
            configure('NFM', 929612500, 2e6, 32, 32, false, 'pager');
            worker?.postMessage({ type: 'pager', which: state.pager });
            break;
        case 'ert':
            configure('NONE', 911600000, 2e6, 32, 40, true, 'ert');
            break;
        case 'btle':
            configure('NONE', btleChannelFreq(state.btleCh), 2e6, 32, 40, true, 'btle');
            worker?.postMessage({ type: 'btleChannel', ch: state.btleCh });
            break;
        case 'tpms':
            configure('NONE', 315000000, 2e6, 32, 40, true, 'tpms');
            break;
        case 'acars':
            configure('AM', 131550000, 2e6, 32, 32, false, 'acars');
            break;
        case 'subghz':
            configure('NONE', 433920000, 2e6, 32, 40, true, 'subghz');
            worker?.postMessage({ type: 'ismFamilies', ...state.ism });
            break;
        case 'devices':
            state.r433.band = 0;
            configure('NONE', R433_BANDS[0][1], 2e6, 32, 40, true, 'r433');
            ensureWorker().postMessage({ type: 'r433', cmd: 'list' });
            worker?.postMessage({ type: 'r433', cmd: 'span', hz: state.r433.span });
            break;
        case 'lookingglass':
            render(app);
            startSweep(88e6, 108e6);
            return;
        case 'search':
            render(app);
            startSweep(400e6, 470e6);
            return;
        case 'capture':
            configure('NONE', dial, RX_RATE, 24, 24, false, 'capture');
            worker?.postMessage({ type: 'capture', cmd: 'list' });
            break;
        case 'transmit':
            configure('NONE', dial, RX_RATE, 24, 24, false, 'none');
            break;
        case 'troll':
            configure('NONE', dial, RX_RATE, 24, 24, false, 'none');
            break;
    }
    render(app);
    worker?.postMessage({ type: 'same', on: app === 'audio' });
}
function requestGeo() {
    if (!('geolocation' in navigator))
        return;
    navigator.geolocation.getCurrentPosition(p => { state.home = { lat: p.coords.latitude, lon: p.coords.longitude }; geo?.setHome(state.home); worker?.postMessage({ type: 'geo', lat: p.coords.latitude, lon: p.coords.longitude }); log(`GPS reference ${p.coords.latitude.toFixed(3)},${p.coords.longitude.toFixed(3)} for single-frame CPR`); }, () => log('no GPS fix — ADS-B positions need even+odd frame pairs'), { maximumAge: 600000, timeout: 8000 });
}
const HUNT = [
    { lo: 118e6, hi: 137e6, mode: 'AM', name: 'airband' },
    { lo: 144e6, hi: 148e6, mode: 'NFM', name: '2 m ham' },
    { lo: 150e6, hi: 174e6, mode: 'NFM', name: 'VHF business' },
    { lo: 420e6, hi: 470e6, mode: 'NFM', name: 'UHF' },
    { lo: 851e6, hi: 869e6, mode: 'NFM', name: '800 public safety' },
];
const PROWL_HANG = 3500;
const PROWL_TEST = 2400;
const PROWL_SETTLE = 1500;
const PROWL_IDLE = 25000;
const PROWL_MAX = 180000;
const PROWL_SKIP = 240000;
const PROWL_CONST = 45000;
const PROWL_VOICE = 0.45;
let prowlTimer = 0;
const mhz = (hz) => (hz / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
function prowlWindows() {
    const span = Math.max(1e6, state.rate - 400000);
    const out = [];
    for (const h of HUNT) {
        const n = Math.max(1, Math.ceil((h.hi - h.lo) / span)), step = (h.hi - h.lo) / n;
        for (let k = 0; k < n; k++)
            out.push({ center: Math.round(h.lo + step * (k + 0.5)), mode: h.mode, name: h.name });
    }
    return out;
}
function prowlWorthy(s) {
    if (s.hz > 87.4e6 && s.hz < 108.1e6)
        return false;
    if (s.bw > 60000)
        return false;
    if (s.snr < 10)
        return false;
    if (s.cls === 'WFM' || s.cls === 'WIDE')
        return false;
    return true;
}
const prowlKey = (hz) => Math.round(hz / 5000);
function prowlSkip(hz, why, now, forMs = PROWL_SKIP) {
    const t = state.prowl.tracks.get(prowlKey(hz));
    if (t) {
        t.skipUntil = now + forMs;
        t.why = why;
    }
}
function prowlNote(line) { state.prowl.note = line; const el = q('#prowl-note'); if (el)
    el.textContent = line; }
function prowlTick() {
    try {
        prowlStep();
    }
    catch (e) {
        prowlNote(`hunt stopped: ${e.message}`);
        prowlStop();
    }
}
function prowlStep() {
    const p = state.prowl;
    if (!p.on)
        return;
    const now = performance.now();
    for (const s of lastSignals) {
        if (!prowlWorthy(s))
            continue;
        const key = prowlKey(s.hz);
        let t = p.tracks.get(key);
        if (!t || now - t.last > 1500)
            t = { hz: s.hz, first: now, last: now, best: s.snr, hits: 0, skipUntil: t ? t.skipUntil : 0, why: t ? t.why : '' };
        t.last = now;
        t.hz = s.hz;
        t.hits++;
        if (s.snr > t.best)
            t.best = s.snr;
        if (now - t.first > PROWL_CONST && now > t.skipUntil) {
            t.skipUntil = now + PROWL_SKIP;
            t.why = 'always on';
            if (!p.target || p.target.hz !== t.hz)
                prowlNote(`${mhz(t.hz)} has been up ${Math.round((now - t.first) / 1000)}s without a break, leaving it`);
        }
        p.tracks.set(key, t);
    }
    if (p.tracks.size > 300)
        for (const [k, t] of p.tracks)
            if (now - t.last > 120000 && now > t.skipUntil)
                p.tracks.delete(k);
    p.seen = 0;
    p.ready = 0;
    for (const tr of p.tracks.values()) {
        if (now - tr.last > 800)
            continue;
        p.seen++;
        if (now >= tr.skipUntil)
            p.ready++;
    }
    if (p.target) {
        prowlHold(now);
        return;
    }
    const pick = prowlPick(now);
    if (pick) {
        prowlLand(pick, now);
        return;
    }
    if (p.sweep && now - p.movedAt > PROWL_IDLE) {
        prowlMove(now);
        return;
    }
    prowlNote(p.seen ? `${p.seen} signals in view, ${p.ready} still worth a try` : 'nothing in the span right now');
    refreshProwl();
}
function prowlPick(now) {
    let best = null, bestVal = -1e9;
    for (const t of state.prowl.tracks.values()) {
        if (now < t.skipUntil)
            continue;
        if (now - t.last > 800)
            continue;
        if (now - t.first < PROWL_SETTLE || t.hits < 5)
            continue;
        const val = t.best + (now - t.first < 20000 ? 12 : 0);
        if (val > bestVal) {
            bestVal = val;
            best = t;
        }
    }
    return best;
}
function prowlLand(t, now) {
    const p = state.prowl;
    const sig = lastSignals.find(s => prowlKey(s.hz) === prowlKey(t.hz));
    const mode = t.hz > 117e6 && t.hz < 138e6 ? 'AM' : 'NFM';
    if (state.mode !== mode)
        setMode(mode);
    tune(t.hz);
    p.target = { hz: t.hz, bw: sig ? sig.bw : 12500, cls: sig ? sig.cls : '', at: now, lastLive: now, lastSeen: now, judged: false, peak: t.best, band: p.band };
    p.score = 0;
    p.best = 0;
    p.parts = '';
    worker?.postMessage({ type: 'config', voice: true });
    prowlNote(`${mhz(t.hz)} ${mode} at ${Math.round(t.best)} dB, listening`);
    refreshProwl();
}
function prowlHold(now) {
    const p = state.prowl, t = p.target;
    if (!t)
        return;
    const sig = lastSignals.find(s => Math.abs(s.hz - t.hz) < Math.max(7000, t.bw));
    if (sig && sig.snr > 7) {
        t.lastLive = now;
        t.lastSeen = now;
        if (sig.snr > t.peak)
            t.peak = sig.snr;
    }
    else if (state.sqOpen && state.squelch > 0 && now - t.lastSeen < 4000)
        t.lastLive = now;
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
    if (now - t.lastLive > PROWL_HANG || dwell > PROWL_MAX)
        prowlRelease(now, t.judged && p.best >= PROWL_VOICE, t.judged ? '' : 'gone before it could be judged');
    else
        refreshProwl();
}
function prowlRelease(now, kept, why = '') {
    const p = state.prowl, t = p.target;
    p.target = null;
    p.movedAt = now;
    worker?.postMessage({ type: 'config', voice: false });
    if (!t)
        return;
    const secs = (now - t.at) / 1000;
    if (!t.judged) {
        prowlSkip(t.hz, 'went away before it could be judged', now, 45000);
        prowlNote(`${mhz(t.hz)} went before it could be judged`);
    }
    else if (secs > 0.8) {
        p.log.unshift({ at: Date.now(), hz: t.hz, mode: state.mode, cls: t.cls, secs, score: p.best, db: t.peak, band: t.band, kept, why });
        if (p.log.length > 200)
            p.log.length = 200;
        if (kept)
            prowlNote(`${mhz(t.hz)} finished after ${secs.toFixed(0)}s`);
    }
    refreshProwl();
}
function prowlMove(now) {
    const p = state.prowl;
    const wins = prowlWindows();
    p.win = (p.win + 1) % wins.length;
    const w = wins[p.win];
    p.band = w.name;
    p.movedAt = now;
    state.viewLo = w.center;
    state.freq = w.center;
    if (radio)
        radio.targetFreqHz = w.center;
    if (state.mode !== w.mode)
        setMode(w.mode);
    sendOffset();
    refreshReadout();
    refreshChannel();
    prowlNote(`sweeping ${w.name} around ${mhz(w.center)}`);
    refreshProwl();
}
function prowlStart() {
    const p = state.prowl;
    p.on = true;
    try {
        localStorage.setItem('mayhem.prowl', '1');
    }
    catch { }
    if (state.squelch === 0)
        setSquelch(9);
    p.held = null;
    p.movedAt = performance.now();
    if (!prowlTimer)
        prowlTimer = window.setInterval(prowlTick, 250);
    refreshProwl();
}
function prowlStop() {
    try {
        localStorage.setItem('mayhem.prowl', '0');
    }
    catch { }
    prowlPause();
}
function prowlPause() {
    const p = state.prowl;
    p.on = false;
    if (prowlTimer) {
        clearInterval(prowlTimer);
        prowlTimer = 0;
    }
    if (p.target)
        prowlRelease(performance.now(), false, 'stopped by hand');
    worker?.postMessage({ type: 'config', voice: false });
    refreshProwl();
}
function prowlHoldAt(h) {
    prowlPause();
    state.prowl.held = h.hz;
    setMode(h.mode);
    tune(h.hz);
    prowlNote(`holding ${mhz(h.hz)} · press HUNT to carry on looking`);
    refreshProwl();
}
function renderProwl(view) {
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
    qa('[data-prate]', view).forEach(b => b.onclick = () => { setRate(Number(b.dataset.prate)); worker?.postMessage({ type: 'config', specBins: wantBins(scope?.bins ?? 4096) }); qa('[data-prate]').forEach(x => x.classList.toggle('on', x === b)); });
    qa('[data-prate]').forEach(b => b.classList.toggle('on', Number(b.dataset.prate) === state.rate));
    $('prowl-go').onclick = () => state.prowl.on ? prowlStop() : prowlStart();
    $('prowl-skip').onclick = () => {
        const now = performance.now();
        if (state.prowl.target) {
            prowlSkip(state.prowl.target.hz, 'skipped by hand', now);
            prowlRelease(now, false);
        }
        else
            prowlMove(now);
    };
    $('prowl-clear').onclick = () => { state.prowl.log.length = 0; refreshProwl(); };
    $('prowl-sweep').onclick = () => { state.prowl.sweep = !state.prowl.sweep; state.prowl.movedAt = performance.now(); refreshProwl(); };
    refreshProwl();
}
function refreshProwl() {
    const p = state.prowl;
    const go = q('#prowl-go');
    if (go) {
        go.textContent = p.on ? 'STOP HUNTING' : 'HUNT';
        go.classList.toggle('on', p.on);
    }
    const skip = q('#prowl-skip');
    if (skip)
        skip.textContent = p.on ? 'SKIP' : 'NEXT';
    const sw = q('#prowl-sweep');
    if (sw) {
        sw.textContent = p.sweep ? 'MOVE TO ANOTHER BAND' : 'STAY WHERE I PUT IT';
        sw.classList.toggle('on', p.sweep);
    }
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
    const note = q('#prowl-note');
    if (note)
        note.textContent = p.note;
    const el = q('#prowl-log');
    if (!el)
        return;
    el.innerHTML = p.log.length
        ? p.log.map((h, i) => `<button class="chip bm${h.kept ? ' on' : ''}${h.kept ? '' : ' faded'}" data-ph="${i}" title="tap to hold here &middot; ${esc(h.kept ? 'speech' : h.why || 'not speech')} &middot; speech score ${h.score.toFixed(2)}">${esc(mhz(h.hz))} &middot; ${h.secs.toFixed(0)}s &middot; ${h.score.toFixed(2)}<i data-phx="${i}">✕</i></button>`).join('')
        : '<span class="empty">nothing heard yet, press HUNT</span>';
    qa('[data-ph]', el).forEach(b => b.onclick = (ev) => {
        const i = Number(b.dataset.ph);
        if (ev.target.dataset.phx !== undefined) {
            p.log.splice(i, 1);
            refreshProwl();
            return;
        }
        const h = p.log[i];
        if (h)
            prowlHoldAt(h);
    });
}
let orbTimer = 0;
const ORB_SPAN_CENTER = 137500000;
function renderOrbcomm(view) {
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
    qa('[data-orb]', view).forEach(b => b.onclick = () => { o.hunt = false; orbTune(Number(b.dataset.orb)); });
    $('orb-hunt').onclick = () => { o.hunt = !o.hunt; o.huntAt = performance.now(); refreshOrbcomm(); };
    clearInterval(orbTimer);
    orbTimer = window.setInterval(orbTick, 1000);
    void orbLoadOrbits();
    refreshOrbcomm();
}
async function orbLoadOrbits() {
    const o = state.orb;
    if (o.orbits.length)
        return;
    try {
        const tles = await fetchGroup('orbcomm');
        for (const tle of tles) {
            try {
                o.orbits.push({ name: tle.name, sgp: new Sgp4(tle) });
            }
            catch { }
        }
        log(`ORBCOMM: ${o.orbits.length} orbits loaded, for naming what is heard`);
        orbName();
        refreshOrbcomm();
    }
    catch {
        log('ORBCOMM: could not fetch orbits, satellites will show by identifier only');
    }
}
function orbName() {
    const o = state.orb;
    if (!o.orbits.length)
        return;
    const now = Date.now(), R = 6371;
    for (const s of o.sats) {
        if (s.lat === undefined || o.named.has(s.id))
            continue;
        let best = '', bestKm = Infinity;
        for (const c of o.orbits) {
            let l;
            try {
                l = look(c.sgp, now, 0, 0);
            }
            catch {
                continue;
            }
            const dLat = (l.lat - s.lat) * Math.PI / 180, dLon = (l.lon - s.lon) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(l.lat * Math.PI / 180) * Math.cos(s.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
            const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
            if (km < bestKm) {
                bestKm = km;
                best = c.name;
            }
        }
        if (best && bestKm < 300)
            o.named.set(s.id, { name: best, km: bestKm });
    }
}
function orbTune(hz) {
    state.orb.channel = hz;
    tune(hz);
    qa('[data-orb]').forEach(b => b.classList.toggle('on', Number(b.dataset.orb) === hz));
    refreshOrbcomm();
}
function orbTick() {
    const o = state.orb;
    if (!q('#orb-stats')) {
        clearInterval(orbTimer);
        orbTimer = 0;
        return;
    }
    if (o.hunt) {
        const now = performance.now();
        if (o.frames > o.lastFrames) {
            o.hunt = false;
            o.lastFrames = o.frames;
            log(`ORBCOMM locked on ${(o.channel / 1e6).toFixed(4)}`);
        }
        else if (now - o.huntAt > 6000) {
            o.huntAt = now;
            const i = (ORBCOMM_CHANNELS.indexOf(o.channel) + 1) % ORBCOMM_CHANNELS.length;
            orbTune(ORBCOMM_CHANNELS[i]);
        }
    }
    o.lastFrames = o.frames;
    refreshOrbcomm();
}
function refreshOrbcomm() {
    const o = state.orb;
    const hunt = q('#orb-hunt');
    if (hunt) {
        hunt.textContent = o.hunt ? 'SEARCHING THE CHANNELS' : 'FIND A BUSY CHANNEL';
        hunt.classList.toggle('on', o.hunt);
    }
    const st = q('#orb-stats');
    if (st)
        st.textContent = o.frames
            ? `${o.frames} frames · ${o.packets} packets, ${o.packets - o.bad} good · ${(o.channel / 1e6).toFixed(4)} MHz`
                + (o.sats.length ? '' : ' · decoding, waiting for a position report')
            : `nothing decoded yet on ${(o.channel / 1e6).toFixed(4)} MHz · a pass lasts about ten minutes and there is`
                + ` often nothing overhead · look for a narrow line on the waterfall and a blip once a second in the audio`;
    const c = q('#count-orb');
    if (c)
        c.textContent = `${o.sats.length} SATELLITE${o.sats.length === 1 ? '' : 'S'}`;
    const el = q('#orb-list');
    if (el) {
        el.innerHTML = o.sats.length
            ? o.sats.map((s, i) => {
                const n = o.named.get(s.id);
                return `<div class="li tap ${i % 2 ? 'alt' : ''}${s.id === o.sel ? ' sel' : ''}" data-orbsat="${s.id}">${esc(n ? n.name : `0x${s.id.toString(16).toUpperCase().padStart(2, '0')}`)} · ${s.lat !== undefined ? `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)} · ${s.altKm.toFixed(0)} km · ${s.speedKms.toFixed(2)} km/s` : 'heard, no position yet'}${n ? ` · ${n.km.toFixed(0)} km from its published orbit` : ''}${s.utc ? ` · ${new Date(s.utc).toISOString().slice(11, 19)}Z` : ''}</div>`;
            }).join('')
            : '<div class="empty">nothing yet — try FIND A BUSY CHANNEL, or wait for a pass</div>';
        qa('[data-orbsat]', el).forEach(b => b.onclick = () => { o.sel = Number(b.dataset.orbsat); refreshOrbcomm(); });
    }
    if (geo && state.app === 'sat' && state.ham.sat.view === 'orbcomm') {
        geo.update(o.sats.filter(s => s.lat !== undefined).map(s => ({
            id: String(s.id), lat: s.lat, lon: s.lon, kind: 'sat',
            label: `${o.named.get(s.id)?.name ?? `0x${s.id.toString(16).toUpperCase()}`} · ${s.altKm.toFixed(0)} km`,
        })), String(o.sel));
    }
}
let packetTimer = 0;
function renderPacketSats(view) {
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
    packetTimer = window.setInterval(() => { if (!q('#psat-list')) {
        clearInterval(packetTimer);
        packetTimer = 0;
        return;
    } packetRank(); }, 5000);
    void packetLoad();
    refreshPacketSats();
}
async function packetLoad() {
    const p = state.psat;
    if (p.sats.length) {
        packetRank();
        return;
    }
    for (const [norad, hz, baud, name] of PACKET_SATS)
        p.sats.push({ norad, hz, baud, what: '', name, el: -90, sgp: null, framing: 'g3ruh' });
    for (const [norad, hz, name] of GEOSCAN_SATS)
        p.sats.push({ norad, hz, baud: 9600, what: 'pictures', name, el: -90, sgp: null, framing: 'geoscan' });
    refreshPacketSats();
    try {
        const groups = await Promise.all([fetchGroup('amateur'), fetchGroup('cubesat')]);
        const byNorad = new Map();
        for (const g of groups)
            for (const tle of g) {
                const n = Number(tle.line1.substring(2, 7));
                if (n && !byNorad.has(n))
                    byNorad.set(n, tle);
            }
        for (const s of p.sats) {
            const tle = byNorad.get(s.norad);
            if (tle) {
                try {
                    s.sgp = new Sgp4(tle);
                }
                catch {
                    s.sgp = null;
                }
            }
        }
        log(`packet satellites: ${p.sats.length} transmitters, ${p.sats.filter(s => s.sgp).length} with orbits`);
    }
    catch {
        p.note = 'no orbits — the list still tunes, but cannot be sorted by what is overhead';
    }
    packetRank();
}
function packetRank() {
    const p = state.psat, home = state.home;
    if (home) {
        const now = Date.now();
        for (const s of p.sats) {
            try {
                s.el = s.sgp ? look(s.sgp, now, home.lat, home.lon).el : -90;
            }
            catch {
                s.el = -90;
            }
        }
        p.sats.sort((a, b) => b.el - a.el || a.name.localeCompare(b.name));
    }
    else {
        p.sats.sort((a, b) => a.name.localeCompare(b.name));
    }
    refreshPacketSats();
}
function packetListen(s) {
    const p = state.psat;
    p.sel = s.norad;
    state.ham.freq = s.hz;
    p.framing = s.framing;
    worker?.postMessage({ type: 'satService', kind: s.framing, baud: s.baud });
    open('sat');
    log(`listening to ${s.name} on ${(s.hz / 1e6).toFixed(4)} at ${s.baud} baud${s.framing === 'geoscan' ? ', looking for pictures' : ''}`);
}
function refreshPacketSats() {
    const p = state.psat;
    const el = q('#psat-list');
    if (el) {
        const up = p.sats.filter(s => s.el > -1);
        const show = (up.length ? up : p.sats).slice(0, 60);
        el.innerHTML = show.length
            ? show.map((s, i) => `<div class="li tap ${i % 2 ? 'alt' : ''}${s.norad === p.sel ? ' sel' : ''}" data-psat="${s.norad}">${esc(s.name)} · ${(s.hz / 1e6).toFixed(4)} · ${s.baud}bd${s.framing === 'geoscan' ? ' · 📷' : ''} · ${s.el > -1 ? `el ${s.el.toFixed(0)}°` : s.sgp ? 'below the horizon' : 'no orbit'}</div>`).join('')
            : `<div class="empty">${esc(p.note || 'fetching the list of packet satellites…')}</div>`;
        qa('[data-psat]', el).forEach(b => b.onclick = () => {
            const s = p.sats.find(x => x.norad === Number(b.dataset.psat));
            if (s)
                packetListen(s);
        });
    }
    const note = q('#psat-note');
    if (note) {
        const up = p.sats.filter(s => s.el > -1).length;
        note.textContent = !state.home ? 'allow location to sort these by what is overhead'
            : p.sats.length ? `${up} of ${p.sats.length} above the horizon${p.bad ? ` · ${p.bad} frames failed their check` : ''}`
                : (p.note || 'fetching…');
    }
    const c = q('#count-psat');
    if (c)
        c.textContent = `${p.heard} FRAME${p.heard === 1 ? '' : 'S'}`;
    const pic = q('#psat-pic'), g = p.pic;
    if (pic) {
        pic.hidden = p.framing !== 'geoscan';
        const im = q('#psat-img');
        if (im && g.url && im.src !== g.url)
            im.src = g.url;
        const pn = q('#psat-picnote');
        if (pn)
            pn.textContent = g.frames
                ? `${g.frames} frames · ${g.fragments} pieces of picture · ${(g.high / 1024).toFixed(1)} kB${g.complete ? ' · complete' : ''}${g.bad ? ` · ${g.bad} failed the checksum` : ''}`
                : 'nothing yet — a picture takes most of a pass to come down';
    }
    const fr = q('#psat-frames');
    if (fr && !paused.has('psat'))
        fr.innerHTML = p.frames.length
            ? p.frames.map((f, i) => `<div class="li ${i % 2 ? 'alt' : ''}"><b>${esc(f.from)} &gt; ${esc(f.to)}</b> · ${f.payload.length} bytes<br>${esc(f.text || f.hex)}</div>`).join('')
            : '<div class="empty">nothing heard yet — pick something that is up and wait for a beacon</div>';
}
function tint(cat) { return cat === 'Receive' ? 'var(--accent)' : cat === 'Analyze' ? 'var(--accent2)' : cat === 'Transmit' ? 'var(--danger)' : 'var(--muted)'; }
function tintHex(cat) { const s = currentSkin(); return cat === 'Receive' ? s.accent : cat === 'Analyze' ? s.accent2 : cat === 'Transmit' ? '#ff5b52' : s.muted; }
const FREQ_GROUPS = [[[1e9], 'GHz'], [[1e8, 1e7, 1e6], 'MHz'], [[1e5, 1e4, 1e3], 'kHz'], [[1e2, 1e1, 1], 'Hz']];
const freqDigitsHtml = () => FREQ_GROUPS.map(([ws, unit], gi) => `${gi ? '<span class="fsep">.</span>' : ''}<span class="fgrp"><span class="fds">${ws.map(w => `<span class="fd" data-w="${w}" tabindex="0" role="spinbutton" aria-label="${unit} digit">0</span>`).join('')}</span><span class="funit">${unit}</span></span>`).join('');
const readoutHtml = () => `<div class="readout"><div id="freq" class="freq">${freqDigitsHtml()}</div><button id="fkey" class="fav" title="type a frequency">⌨</button><button id="fav" class="fav" title="save this to favorites">☆</button><span id="sq" class="sq" hidden>SQL</span></div><div class="levelbar"><div id="level"></div></div><div id="health" class="health">waiting for IQ…</div>`;
function setFreqDisplay(hz) {
    const ds = qa('#freq .fd');
    if (!ds.length)
        return;
    let lead = true;
    for (const d of ds) {
        const w = Number(d.dataset.w);
        const v = Math.floor(hz / w) % 10;
        if (v !== 0 || w <= 1e6)
            lead = false;
        const t = String(v);
        if (d.textContent !== t)
            d.textContent = t;
        d.classList.toggle('dim', lead);
    }
}
function nudgeDigit(el, dir) {
    const w = Number(el.dataset.w);
    if (!w)
        return;
    tune(state.freq + dir * w);
    el.classList.remove('up', 'down');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'up' : 'down');
}
function parseFreq(s) {
    const m = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*([kmg])?(hz)?\s*$/i.exec(s);
    if (!m)
        return null;
    const v = Number(m[1].replace(',', '.'));
    const mul = m[2] ? { k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase()] : m[3] || v >= 1e5 ? 1 : 1e6;
    return v > 0 ? v * mul : null;
}
function freqEntry(seed = '') {
    const fr = q('#freq');
    if (!fr || q('#fentry'))
        return;
    const inp = document.createElement('input');
    inp.id = 'fentry';
    inp.className = 'txin fentry';
    inp.inputMode = 'decimal';
    inp.autocomplete = 'off';
    inp.enterKeyHint = 'go';
    inp.placeholder = `${+(tunedHz() / 1e6).toFixed(6)} MHz`;
    inp.value = seed;
    fr.hidden = true;
    fr.after(inp);
    inp.focus();
    inp.setSelectionRange(seed.length, seed.length);
    let done = false;
    const close = (ok) => {
        if (done)
            return;
        done = true;
        const text = inp.value.trim(), hz = ok ? parseFreq(text) : null;
        inp.remove();
        fr.hidden = false;
        if (hz)
            tune(hz);
        else if (ok && text)
            log(`"${text}" isn't a frequency — try 433.92, 144390k or 1.2G`);
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
    }
    else if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
    } };
    inp.onblur = () => close(true);
}
const isAndroid = () => /android/i.test(navigator.userAgent);
const gainHtml = () => `<div class="caption" id="gain-cap">GAIN</div><div class="row"><button id="agc" class="chip">AGC</button><button id="amp" class="chip">AMP OFF</button><div class="stepper"><button id="lna-minus">−</button><span id="lna">LNA</span><button id="lna-plus">+</button></div><div class="stepper"><button id="vga-minus">−</button><span id="vga">VGA</span><button id="vga-plus">+</button></div></div>`;
const stepHtml = (steps) => `<div class="caption">TUNE · MHz</div><div class="row">${steps.map(s => `<button class="chip" data-step="${-s}">−${stepLabel(s)}</button>`).join('')}${[...steps].reverse().map(s => `<button class="chip" data-step="${s}">+${stepLabel(s)}</button>`).join('')}</div>`;
const presetHtml = (title, presets) => `<div class="caption">${title}</div><div class="row">${presets.map(([l, hz, m]) => `<button class="chip" data-preset="${hz}" ${m ? `data-pmode="${m}"` : ''}>${l}</button>`).join('')}</div>`;
function stepLabel(hz) { return hz >= 1e6 ? `${hz / 1e6}` : hz >= 1e5 ? `.${hz / 1e5}` : hz >= 1e4 ? `.0${hz / 1e4}` : hz >= 1e3 ? `.00${hz / 1e3}` : `.000${hz / 100}`; }
const countRowHtml = (id, count, extra = '') => `<div class="countrow"><span id="count-${id}" class="count">${count}</span><span class="row">${extra}<button class="link" id="pause-${id}">PAUSE</button><button class="link" id="clear-${id}">CLEAR</button></span></div>`;
const listHtml = (id, title) => `<div class="panel list" id="list-${id}"><div class="empty">${title}</div></div>`;
const logHtml = (id, title) => countRowHtml(id, '0 DECODED') + listHtml(id, title);
const launchScroll = { x: 0, y: 0 };
let launchPicked = false;
function launchAutoPick() {
    if (state.app !== null || launchPicked || !lastSignals.length)
        return;
    const half = state.rate / 2 - VIEW_GUARD, c = spanCenter();
    let best = null;
    for (const s of lastSignals) {
        if (Math.abs(s.hz - c) > half)
            continue;
        if (!best || s.snr > best.snr)
            best = s;
    }
    if (best) {
        launchPicked = true;
        silentTune = true;
        try {
            tune(best.hz, true);
        }
        finally {
            silentTune = false;
        }
    }
}
function render(app) {
    const view = $('view');
    const header = $('title');
    header.innerHTML = app ? `‹ ${APPS.find(a => a.id === app).title.toUpperCase()}` : `MAYHEM<span>MOBILE</span>`;
    $('sub').textContent = app ? APPS.find(a => a.id === app).blurb
        : !radio ? 'HackRF or RTL-SDR · no device'
            : radio.kind === 'rtlsdr' ? radio.label
                : `HackRF · ${state.board || 'HackRF'}${state.firmware ? ' · ' + state.firmware : ''}`;
    scope = null;
    sweepScope = null;
    view.className = 'view ' + (app ?? 'launcher');
    view.dataset.tab = app === 'ham' ? state.ham.tab : '';
    switch (app) {
        case null:
            renderLauncher(view);
            break;
        case 'audio':
            renderAudio(view);
            break;
        case 'prowl':
            renderProwl(view);
            break;
        case 'sat':
            if (state.ham.sat.view === 'orbcomm')
                renderOrbcomm(view);
            else if (state.ham.sat.view === 'packet')
                renderPacketSats(view);
            else
                renderSat(view, satStrip());
            break;
        case 'ham':
            renderHam(view);
            break;
        case 'adsb':
            renderAdsb(view);
            break;
        case 'ais':
            renderAis(view);
            break;
        case 'aprs':
            renderAprs(view);
            break;
        case 'pager':
        case 'ert':
        case 'btle':
        case 'tpms':
        case 'acars':
        case 'subghz':
            renderPacket(view, app);
            break;
        case 'devices':
            renderR433(view);
            break;
        case 'lookingglass':
        case 'search':
            renderSweep(view, app);
            break;
        case 'capture':
            renderCapture(view);
            break;
        case 'transmit':
            renderTx(view);
            break;
        case 'troll':
            renderTroll(view);
            break;
        case 'settings':
            renderSettings(view);
            break;
    }
    wireCommon(view);
    refreshReadout();
    setGains(state.lna, state.vga, state.amp);
    setMode(state.mode);
    window.scrollTo(0, 0);
}
function renderLauncher(view) {
    view.innerHTML = `
    <section class="visual launch-visual">${readoutHtml()}<div id="launch-scope" class="launch-scope"></div></section>
    <section class="controls launch-side"><div class="grid launch-grid">${APPS.map(a => `<button class="tile" data-app="${a.id}" style="--tint:${tint(a.cat)}"><div class="tile-top">${glyph(a.id, tintHex(a.cat), 36)}<span class="cat">${a.cat.toUpperCase()}</span></div><div class="tile-title">${a.title}</div><div class="tile-blurb">${a.blurb}</div></button>`).join('')}</div>
    <div class="launch-radio"><div class="caption">BANDS</div><div class="row wrap bandrow">${bandChipsHtml()}</div><div class="launch-gain">${gainHtml()}</div></div>
    <div class="foot"><span id="version">${versionText}</span> · <a id="release-link" href="${releaseUrl}">release</a> · <a href="https://github.com/RocketGod-git/mayhem-mobile">source</a> · GPL-3.0 · a port of <a href="https://github.com/portapack-mayhem/mayhem-firmware">PortaPack Mayhem</a><br>made by <a href="https://rocketgod.dev">RocketGod</a> · The Pirates' Plunder · <a href="https://discord.gg/thepirates">discord.gg/thepirates</a></div></section>`;
    scope = attach(tunableScope('launch-scope', 70, 90));
    scope.setLabels(centredLabels(state.freq, state.rate));
    qa('[data-app]', view).forEach(b => b.onclick = () => open(b.dataset.app));
    const strip = view.querySelector('.launch-side');
    if (strip) {
        const restore = () => { strip.scrollLeft = launchScroll.x; strip.scrollTop = launchScroll.y; };
        restore();
        requestAnimationFrame(restore);
        strip.addEventListener('scroll', () => { launchScroll.x = strip.scrollLeft; launchScroll.y = strip.scrollTop; }, { passive: true });
    }
    refreshLauncherLimits();
}
function refreshLauncherLimits() {
    qa('[data-app]').forEach(b => {
        const id = b.dataset.app ?? '';
        const why = radio ? blockedBecause(APP_NEEDS[id], radio.limits) : '';
        b.classList.toggle('limited', !!why);
        if (why)
            b.title = `${APPS.find(a => a.id === id)?.title ?? id} on a ${radio?.label}: ${why}`;
        else
            b.removeAttribute('title');
    });
}
const wantBins = (bins) => state.app === 'prowl' ? Math.min(8192, Math.max(4096, bins)) : bins;
function attach(s) {
    worker?.postMessage({ type: 'config', specBins: wantBins(s.bins) });
    s.onResize = bins => worker?.postMessage({ type: 'config', specBins: wantBins(bins) });
    s.setChannel(state.mode === 'NONE' ? null : CHANNEL_BW[state.mode] / state.rate);
    return s;
}
const spanCenter = () => state.app === 'ham' ? state.hamLo : tunesInSpan() ? state.viewLo : state.freq;
let lastSignals = [];
function signalAt(hz) {
    const reach = 24 * state.rate / (scope?.zoom ?? 1) / (scope?.cssWidth ?? 1000);
    let inside = null, near = null, nearD = Infinity;
    for (const s of lastSignals) {
        const d = Math.abs(s.hz - hz);
        if (d <= s.bw / 2 + reach / 3 && (!inside || s.db > inside.db))
            inside = s;
        if (d <= reach && d < nearD) {
            near = s;
            nearD = d;
        }
    }
    return inside ?? near;
}
function signalDial(s) {
    let hz = s.hz;
    if (s.cls === 'USB')
        hz -= s.bw / 2 + 300;
    else if (s.cls === 'LSB')
        hz += s.bw / 2 + 300;
    const raster = rasterStep(), onRaster = Math.round(hz / raster) * raster;
    const wide = s.cls === 'WFM' || s.cls === 'WIDE' || s.bw > 60000;
    if (Math.abs(onRaster - hz) < (wide ? raster / 2 : Math.max(raster / 3, s.bw * 0.2)))
        return onRaster;
    return Math.round(hz / 100) * 100;
}
function fitSignal(s) {
    const bw = s.bw * 1.15;
    const wide = s.cls === 'WFM' || s.cls === 'WIDE' || s.bw > 60000 || (s.hz > 87500000 && s.hz < 108000000);
    const sure = s.conf >= 0.6;
    if (state.app === 'ham') {
        const h = state.ham;
        const ssb = s.cls === 'USB' || s.cls === 'LSB' || s.cls === 'SSB';
        let want = h.mode;
        if (wide)
            want = 'NFM';
        else if (sure)
            want = s.cls === 'CW' ? 'CW' : s.cls === 'AM' ? 'AM' : ssb ? (s.cls === 'LSB' || (s.cls === 'SSB' && s.hz < 10000000) ? 'LSB' : 'USB') : 'NFM';
        else if (h.mode === 'AM' && s.bw > 4500)
            want = 'NFM';
        if (h.mode !== want)
            hamSetMode(want);
        if (want === 'CW')
            hamSetWidth(bw < 180 ? 100 : bw < 400 ? 250 : bw < 800 ? 500 : 1000);
        else if (want === 'USB' || want === 'LSB')
            hamSetWidth(Math.max(1800, Math.min(3500, Math.round(bw / 100) * 100)));
        else if (want === 'AM')
            hamSetWidth(Math.max(4000, Math.min(10000, Math.ceil(bw / 1000) * 1000)));
        else
            hamSetWidth(bw <= 8500 ? 8000 : bw <= 13000 ? 12500 : bw <= 17000 ? 16000 : bw <= 26000 ? 25000 : Math.min(48000, Math.ceil(bw / 1000) * 1000));
        return;
    }
    if (state.app === 'audio') {
        let want = state.mode;
        if (wide)
            want = 'WFM';
        else if (sure)
            want = s.cls === 'AM' ? 'AM' : s.cls === 'USB' ? 'USB' : s.cls === 'LSB' || s.cls === 'SSB' ? 'LSB' : 'NFM';
        else if (state.mode === 'WFM' || state.mode === 'NONE')
            want = 'NFM';
        if (state.mode !== want)
            setMode(want);
    }
}
let spanDragFrom = 0;
function tunableScope(id, rows, spectrumHeight) {
    const snap = state.app === 'ham' ? 100 : 1000;
    const hzAt = (f) => spanCenter() + (f - 0.5) * state.rate;
    const target = (f) => { const hz = hzAt(f), s = signalAt(hz); return s ? { hz: signalDial(s), s } : { hz: Math.round(hz / snap) * snap, s: null }; };
    return new Scope($(id), 0, {
        rows, spectrumHeight,
        onTap: f => { const t = target(f); if (t.s)
            fitSignal(t.s); tune(t.hz, true); wakeAudio(); },
        onPreview: f => previewFreq(f === null ? null : target(f).hz),
        labelAt: (f, zoom = 1) => ((spanCenter() + (f - 0.5) * state.rate) / 1e6).toFixed(zoom >= 8 ? 5 : zoom >= 2 ? 4 : 3),
        onChannel: state.app === 'ham' ? hamChannelEdges : undefined,
        onSlide: (f, done) => { const r = spanBarRange(); slideSpan(r.lo + f * (r.hi - r.lo), done); },
        onSpanStep: spanStep,
        onCenter: recentreView,
        onDragSpan: (delta, done) => {
            if (!spanDragFrom)
                spanDragFrom = spanCenter();
            slideSpan(spanDragFrom - delta * state.rate, done);
            if (done)
                spanDragFrom = 0;
        },
    });
}
function recentreView() {
    if (state.app === 'ham') {
        const h = state.ham;
        if (h.tab === 'monitor') {
            monitorOpen();
            return;
        }
        const lo = hamLoFor(h.freq), d = lo - state.hamLo;
        if (!d)
            return;
        scope?.shiftSpan(d / state.rate);
        state.hamLo = lo;
        if (radio)
            radio.targetFreqHz = lo;
        hamSend();
        refreshReadout();
        refreshHamUi();
    }
    else if (state.app === 'audio') {
        const d = state.freq - state.viewLo;
        if (!d)
            return;
        scope?.shiftSpan(d / state.rate);
        state.viewLo = state.freq;
        if (radio)
            radio.targetFreqHz = state.viewLo;
        sendOffset();
        refreshReadout();
        refreshChannel();
    }
    settleSpanBar();
}
let wheelAcc = 0;
function rasterStep() {
    if (state.app !== 'ham')
        return state.mode === 'WFM' ? 100000 : state.mode === 'NFM' ? 12500 : state.mode === 'AM' ? 10000 : state.mode === 'NONE' ? STEPS[stepIdx] : 1000;
    const band = bandOf(state.ham.freq);
    return band?.step ?? (state.ham.freq < 30e6 ? 500 : 12500);
}
function wheelStep() {
    const raster = rasterStep(), bw = state.app === 'ham' ? hamWidth() : CHANNEL_BW[state.mode];
    return Math.max(raster, Math.round(bw / raster) * raster);
}
let spanBar = null;
function spanBarRange() {
    if (state.app === null) {
        const lim = radio?.limits;
        return { lo: Math.max(1e6, lim?.minHz ?? 1e6), hi: lim?.maxHz ?? 6000000000 };
    }
    const c = spanCenter(), half = state.rate / 2, w = 24 * state.rate;
    if (!spanBar || c - half < spanBar.lo || c + half > spanBar.hi || spanBar.hi - spanBar.lo !== w)
        spanBar = { lo: Math.max(0, c - w / 2), hi: Math.max(w, c + w / 2) };
    return spanBar;
}
function settleSpanBar() {
    if (state.app === null) {
        syncLaunchBand();
        refreshSpanBar();
        return;
    }
    if (spanBar) {
        const c = spanCenter(), w = spanBar.hi - spanBar.lo;
        if (c - spanBar.lo < 0.12 * w || spanBar.hi - c < 0.12 * w)
            spanBar = null;
    }
    refreshSpanBar();
}
function syncLaunchBand() {
    if (state.app !== null)
        return;
    const c = spanCenter();
    const b = LAUNCH_BANDS.find(x => c >= x.lo && c <= x.hi);
    qa('[data-lband]').forEach(el => el.classList.toggle('on', !!b && el.dataset.lband === b.id));
    if (!b || b.id === state.launchBand)
        return;
    state.launchBand = b.id;
    if (b.mode !== state.mode) {
        state.mode = b.mode;
        worker?.postMessage({ type: 'config', mode: b.mode });
        refreshChannel();
    }
}
function refreshSpanBar() {
    if (!scope)
        return;
    const r = spanBarRange(), w = r.hi - r.lo, c = spanCenter(), half = state.rate / 2;
    const mhz = (hz) => w > 2e9
        ? (hz >= 1e9 ? `${(hz / 1e9).toFixed(hz % 1e9 ? 1 : 0)} GHz` : `${Math.round(hz / 1e6)} MHz`)
        : (hz / 1e6).toFixed(w < 5e6 ? 3 : w < 50e6 ? 2 : 1);
    const span = state.rate % 1e6 ? `${(state.rate / 1e6).toFixed(2)} MHz` : `${state.rate / 1e6} MHz`;
    scope.setSpanBar((c - half - r.lo) / w, (c + half - r.lo) / w, mhz(r.lo), mhz(r.hi), span);
}
function slideSpan(hz, done = true, clamp = true) {
    const half = state.rate / 2;
    if (clamp) {
        const r = spanBarRange();
        hz = Math.min(r.hi - half, Math.max(r.lo + half, hz));
    }
    hz = Math.max(1000000, hz);
    const raster = rasterStep(), d = Math.round((hz - spanCenter()) / raster) * raster;
    if (state.app === 'ham' && state.ham.tab === 'monitor') {
        if (done && d)
            monitorOpen(state.hamLo + d);
        return;
    }
    if (d) {
        scope?.shiftSpan(d / state.rate);
        if (state.app === 'ham') {
            state.hamLo += d;
            if (radio)
                radio.targetFreqHz = state.hamLo;
            hamSend();
            refreshReadout();
            refreshHamUi();
        }
        else if (state.app === 'audio' || state.app === null) {
            state.viewLo += d;
            if (radio)
                radio.targetFreqHz = state.viewLo;
            sendOffset();
            refreshReadout();
            refreshChannel();
        }
        else
            tune(state.freq + d);
    }
    if (done)
        settleSpanBar();
}
function hamChannelEdges(loF, hiF, which) {
    const h = state.ham, off = h.freq - state.hamLo;
    const a = Math.round((loF - 0.5) * state.rate - off), b = Math.round((hiF - 0.5) * state.rate - off);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    if (h.mode === 'USB') {
        h.lo = clamp(a, 0, 5000);
        h.hi = clamp(b, h.lo + 100, 6000);
    }
    else if (h.mode === 'LSB') {
        h.lo = clamp(-b, 0, 5000);
        h.hi = clamp(-a, h.lo + 100, 6000);
    }
    else if (h.mode === 'CW') {
        const w = clamp(b - a, 50, 2000);
        h.lo = 0;
        h.hi = w;
    }
    else {
        h.hi = clamp(Math.abs(which === 'lo' ? a : b), h.mode === 'AM' ? 1500 : 2500, h.mode === 'NFM' ? 25000 : 12000);
        h.lo = 0;
    }
    h.shift = 0;
    hamSend();
    refreshHamUi();
    const seg = q('#ham-seg');
    if (seg)
        seg.textContent = h.mode === 'USB' || h.mode === 'LSB' ? `filter ${h.lo}–${h.hi} Hz` : h.mode === 'CW' ? `filter ${h.hi} Hz` : `filter ±${h.hi} Hz (${(2 * h.hi / 1000).toFixed(1)} kHz)`;
}
const CHANNEL_BW = { WFM: 200000, NFM: 12500, AM: 10000, USB: 3000, LSB: 3000, NONE: 0 };
function refreshChannel() { if (state.app === 'ham') {
    refreshHamChannel();
    return;
} scope?.setChannel(state.mode === 'NONE' ? null : CHANNEL_BW[state.mode] / state.rate, tunesInSpan() ? 0.5 + (state.freq - state.viewLo) / state.rate : 0.5); }
const HAM_RATE = 1920000, HAM_GUARD = 120000, HAM_LO_OFFSET = 250000;
const HAM_RATES = [1920000, 3840000, 7680000, 15360000, 19200000];
const RX_RATES = [1920000, 3840000, 7680000, 15360000, 19200000];
let hamRateIdx = 0;
const maxRateIdx = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 1 : HAM_RATES.length - 1;
function spanStep(dir) {
    if (state.app === 'ham') {
        const h = state.ham;
        if (h.tab === 'monitor') {
            if (window.innerWidth < 720 || h.mon.wide === (dir < 0))
                return false;
            h.mon.wide = dir < 0;
            open('ham');
            return true;
        }
        const i = Math.min(maxRateIdx(), Math.max(0, hamRateIdx - dir));
        if (i === hamRateIdx)
            return false;
        hamRateIdx = i;
        setRate(HAM_RATES[i]);
        scope?.clear();
        hamSend();
        refreshHamUi();
        refreshChannel();
        return true;
    }
    if (state.app === 'audio') {
        const cur = Math.max(0, RX_RATES.indexOf(state.rate)), i = Math.min(maxRateIdx(), Math.max(0, cur - dir));
        if (i === cur)
            return false;
        setRate(RX_RATES[i]);
        scope?.clear();
        refreshChannel();
        return true;
    }
    return false;
}
const HAM_WIDTHS = {
    USB: [['1.8k', 1800], ['2.4k', 2400], ['2.7k', 2700], ['3.0k', 3000], ['3.5k', 3500]],
    LSB: [['1.8k', 1800], ['2.4k', 2400], ['2.7k', 2700], ['3.0k', 3000], ['3.5k', 3500]],
    CW: [['100', 100], ['250', 250], ['500', 500], ['1k', 1000]],
    AM: [['4k', 4000], ['6k', 6000], ['8k', 8000], ['10k', 10000]],
    NFM: [['8k', 8000], ['12.5k', 12500], ['16k', 16000], ['25k', 25000]],
    WFM: [['200k', 200000]],
};
const hamWidth = () => { const h = state.ham; return h.mode === 'USB' || h.mode === 'LSB' ? h.hi - h.lo : h.mode === 'CW' ? h.hi - h.lo : h.hi * 2; };
const hamLoFor = (hz) => hz + HAM_LO_OFFSET;
function satAppOpen() {
    const h = state.ham;
    h.tab = 'sat';
    if (h.sat.view === 'orbcomm') {
        configure('NFM', ORB_SPAN_CENTER, 2e6, 32, 32, false, 'orbcomm');
        requestGeo();
        render('sat');
        tune(state.orb.channel);
        return;
    }
    if (h.sat.view === 'packet') {
        if (!state.home)
            requestGeo();
        state.hamLo = hamLoFor(h.freq);
        configure('NFM', state.hamLo, HAM_RATES[hamRateIdx], 32, 40, false, 'ham');
        state.freq = h.freq;
        render('sat');
        hamSend();
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
function satStrip() {
    const v = state.ham.sat.view;
    return `<div class="row tabs bandstrip">` +
        `<button class="chip ${v === 'track' ? 'on' : ''}" data-satview="track">TRACK &amp; LISTEN</button>` +
        `<button class="chip ${v === 'packet' ? 'on' : ''}" data-satview="packet">PACKET</button>` +
        `<button class="chip ${v === 'orbcomm' ? 'on' : ''}" data-satview="orbcomm">ORBCOMM</button></div>`;
}
function hamOpen() {
    const h = state.ham;
    if (h.tab === 'sat')
        h.tab = 'rx';
    if (h.tab === 'monitor') {
        monitorOpen();
        return;
    }
    if (h.tab === 'digi' && h.digi.mode === 'ft8' && h.mode !== 'USB')
        hamSetMode('USB');
    if (h.tab === 'digi' && (h.digi.mode === 'dmr' || h.digi.mode === 'p25') && h.mode !== 'NFM')
        hamSetMode('NFM');
    state.hamLo = hamLoFor(h.freq);
    configure('NONE', state.hamLo, HAM_RATES[hamRateIdx], 32, 40, false, 'ham');
    state.freq = h.freq;
    render('ham');
    hamSend();
}
function monitorOpen(at) {
    const h = state.ham, band = bandOf(h.freq);
    const rate = h.mon.wide && window.innerWidth >= 720 ? 3840000 : HAM_RATE;
    const center = at ?? (band && band.hi - band.lo <= rate ? Math.round((band.lo + band.hi) / 2) : h.freq + 10000);
    state.hamLo = center;
    configure('NONE', center, rate, 32, 40, false, 'monitor');
    state.freq = h.freq;
    render('ham');
    monitorSend();
}
function digiSend() {
    const g = state.ham.digi;
    worker?.postMessage({ type: 'digital', mode: g.mode, pitch: state.ham.pitch, pskHz: g.pskHz, rttyBaud: g.rttyBaud, rttyShift: g.rttyShift, rttyRev: g.rttyRev, dmrSlot: g.dmrSlot });
    qa('[data-digi]').forEach(b => b.classList.toggle('on', b.dataset.digi === g.mode));
    qa('[data-dmrslot]').forEach(b => b.classList.toggle('on', Number(b.dataset.dmrslot) === g.dmrSlot));
    const dp = q('#dmr-panel');
    if (dp)
        dp.hidden = !(g.mode === 'dmr' || g.mode === 'auto');
    const pp = q('#p25-panel');
    if (pp)
        pp.hidden = !(g.mode === 'p25' || g.mode === 'auto');
    const sp = q('#sstv-panel');
    if (sp)
        sp.hidden = !(g.mode === 'sstv' || g.mode === 'auto');
    qa('[data-pskhz]').forEach(b => b.classList.toggle('on', Number(b.dataset.pskhz) === g.pskHz));
    qa('[data-rtty]').forEach(b => b.classList.toggle('on', b.dataset.rtty === `${g.rttyBaud}/${g.rttyShift}`));
    const rv = q('#rtty-rev');
    if (rv)
        rv.classList.toggle('on', g.rttyRev);
    const ftp = q('#ft8-panel');
    if (ftp)
        ftp.hidden = !(g.mode === 'ft8' || g.mode === 'auto');
    const ftc = q('#ft8-clock');
    if (ftc)
        ftc.textContent = '';
}
function refreshDmr() {
    const g = state.ham.digi, s = g.dmr, head = q('#dmr-head');
    if (!head)
        return;
    if (!s) {
        head.textContent = 'waiting for the decoder';
        return;
    }
    head.textContent = s.locked ? `LOCKED · ${s.source === 'BS' ? 'repeater / base' : s.source === 'MS' ? 'mobile' : 'direct mode'} · color code ${s.cc >= 0 ? s.cc : '?'} · deviation ${(s.level * 48000 / (2 * Math.PI)).toFixed(0)} Hz · audio slot ${s.audioSlot}`
        : s.dv ? `${s.dv} sync seen · identification only (no ${s.dv} vocoder yet)` : 'searching for sync · tune a DMR channel in NFM';
    for (let i = 0; i < 2; i++) {
        const el = q(`#dmr-s${i + 1}`), sl = s.slots[i];
        if (!el)
            continue;
        el.classList.toggle('voice', sl.voice);
        el.classList.toggle('on', s.locked && s.audioSlot === i + 1);
        const who = sl.tg || sl.src ? `${sl.group ? 'TG' : 'ID'} ${sl.tg} ← ${sl.src}${sl.alias ? ` “${sl.alias}”` : ''}` : 'no call seen';
        el.innerHTML = `<b>SLOT ${i + 1}${sl.voice ? ' · ▶ VOICE' : ''}${s.locked && s.audioSlot === i + 1 ? ' · 🔊' : ''}</b><span>${who}</span><span class="dim">${sl.last || (s.locked ? 'idle' : '—')}${sl.cc >= 0 ? ` · CC ${sl.cc}` : ''}${sl.errs > 0.02 ? ` · ${(sl.errs * 100).toFixed(0)}% frame errors` : ''}</span>`;
    }
}
function refreshP25() {
    const s = state.ham.digi.p25, head = q('#p25-head'), call = q('#p25-call');
    if (!head || !call)
        return;
    if (!s || s.nac < 0) {
        head.textContent = 'searching for sync · tune a P25 channel in NFM';
        call.innerHTML = '<b>NO CALL SEEN</b><span>—</span>';
        return;
    }
    const stale = s.since > 2 * 48000;
    head.textContent = s.locked ? `LOCKED · NAC ${s.nac.toString(16).toUpperCase()} · ${s.frames} frames${s.errs ? ` · ${s.errs} rejected` : ''}`
        : `last heard NAC ${s.nac.toString(16).toUpperCase()} · ${s.frames} frames`;
    const who = !(s.talkgroup || s.source) ? 'no link control yet'
        : s.lcf === 0x03 ? `radio ${s.talkgroup} ← ${s.source}` : `TG ${s.talkgroup} ← ${s.source}`;
    call.classList.toggle('voice', !stale && (s.duid === 0x5 || s.duid === 0xa));
    call.innerHTML = `<b>${esc(s.frame || '—')}${s.encrypted ? ' · 🔒 ENCRYPTED' : ''}</b><span>${esc(who)}</span><span class="dim">${stale ? 'idle' : 'receiving'}${s.lcf ? ` · LCF ${s.lcf.toString(16)}` : ''}</span>`;
}
function refreshFt8() {
    const g = state.ham.digi, el = q('#ft8-list');
    if (!el)
        return;
    el.innerHTML = g.ft8.length ? g.ft8.slice(0, 60).map((r, i) => `<div class="li tap ${i % 2 ? 'alt' : ''} ${/^CQ /.test(r.text) ? 'gold' : ''}" data-ft8i="${i}"><span class="row2"><span>${r.utc}  ${String(r.snr).padStart(3)}  ${r.dt.toFixed(1)}  ${r.hz}</span><span>${r.text}</span></span></div>`).join('') : '<div class="empty">FT8 decodes appear every 15 s — tune a band\'s FT8 frequency in USB (the FT8 chip does that) · tap a decode to log the station</div>';
    qa('[data-ft8i]', el).forEach(row => row.onclick = () => { const r = g.ft8[Number(row.dataset.ft8i)]; if (!r)
        return; const tok = r.text.replace(/^CQ (DX|POTA|SOTA|[A-Z]{2}) /, 'CQ ').split(/\s+/); const call = tok[0] === 'CQ' ? tok[1] : tok[1] ?? tok[0]; const grid = tok.find(x => /^[A-R]{2}\d{2}$/.test(x)) ?? ''; logPrefill({ call: (call ?? '').replace(/^<|>$/g, ''), grid, rstR: String(r.snr), rstS: '', mode: 'FT8', notes: r.text }); });
}
let ft8Timer = 0;
function monitorSend() {
    const h = state.ham, band = bandOf(h.freq);
    worker?.postMessage({ type: 'monitorParams', params: { centreHz: state.hamLo, spacingHz: h.mon.spacing, originHz: band?.lo ?? Math.floor(h.freq / 1e6) * 1e6, thresholdDb: h.mon.threshold, mode: h.mon.mode, lock: h.mon.lock, maxDemods: window.innerWidth >= 720 ? 4 : 2, volume: h.volume } });
}
function onMonitor(m) {
    const mon = state.ham.mon;
    const prevOpen = mon.open;
    mon.first = m.first;
    mon.count = m.count;
    mon.snr = m.snr;
    mon.open = m.open;
    mon.listening = m.listening;
    mon.tones = m.tones;
    mon.dcs = m.dcs;
    mon.since = m.since;
    for (const k of mon.open)
        if (!prevOpen.includes(k)) {
            const t = new Date();
            mon.log.unshift(`${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}  ${((mon.first + k * mon.spacing) / 1e6).toFixed(4)} MHz`);
            if (mon.log.length > 60)
                mon.log.length = 60;
        }
    refreshMonitor();
}
function refreshMonitor() {
    const mon = state.ham.mon, cv = q('#mon-grid');
    if (!cv)
        return;
    const n = mon.count;
    if (!n)
        return;
    const dpr = window.devicePixelRatio || 1, cssW = cv.clientWidth || 300, cols = Math.min(n, Math.max(8, Math.floor(cssW / 22))), rows = Math.ceil(n / cols);
    const cellW = cssW / cols, cellH = 26, H = rows * cellH;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(cssW * dpr);
        cv.height = Math.round(H * dpr);
        cv.style.height = `${H}px`;
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, H);
    const s = currentSkin();
    g.font = '8px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let k = 0; k < n; k++) {
        const x = (k % cols) * cellW, y = Math.floor(k / cols) * cellH, snr = mon.snr[k] ?? 0, open = mon.open.includes(k), lis = mon.listening.includes(k);
        const t = Math.min(1, Math.max(0, snr / 30));
        g.fillStyle = open ? s.accent2 : `rgba(76,141,255,${(0.08 + t * 0.7).toFixed(2)})`;
        g.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        if (lis) {
            g.strokeStyle = '#fff';
            g.lineWidth = 2;
            g.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);
        }
        if (mon.lock === k) {
            g.strokeStyle = '#ff5b52';
            g.lineWidth = 2;
            g.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
        }
        g.fillStyle = open ? '#05080a' : s.ink;
        const hz = mon.first + k * mon.spacing;
        g.fillText(((hz / 1e6) % 1).toFixed(mon.spacing >= 25000 ? 3 : 4).slice(1), x + cellW / 2, y + 9);
        if (open)
            g.fillText(mon.tones[k] ? mon.tones[k].toFixed(1) : mon.dcs[k] ? `D${String(mon.dcs[k]).padStart(3, '0')}` : `+${Math.round(snr)}`, x + cellW / 2, y + 18);
    }
    const list = q('#mon-list');
    if (list)
        list.innerHTML = mon.open.length ? mon.open.map((k, i) => { const hz = mon.first + k * mon.spacing; return `<div class="li tap ${i % 2 ? 'alt' : ''}" data-monk="${k}"><span class="row2"><span>${(hz / 1e6).toFixed(4)} MHz${mon.listening.includes(k) ? ' 🔊' : ''}</span><span>+${Math.round(mon.snr[k])} dB · ${mon.tones[k] ? `CTCSS ${mon.tones[k].toFixed(1)}` : mon.dcs[k] ? `DCS ${String(mon.dcs[k]).padStart(3, '0')}` : '—'} · ${Math.round((mon.since[i] ?? 0) / 1000)}s</span></span></div>`; }).join('') : '<div class="empty">nothing open — watching every channel</div>';
    qa('[data-monk]', list ?? document).forEach(d => d.onclick = () => monitorLock(Number(d.dataset.monk)));
    const lg = q('#mon-log');
    if (lg)
        lg.innerHTML = mon.log.length ? mon.log.slice(0, 30).map((l, i) => `<div class="li ${i % 2 ? 'alt' : ''}">${l}</div>`).join('') : '<div class="empty">activity log</div>';
    const st = q('#mon-status');
    if (st)
        st.textContent = `${n} channels @ ${mon.spacing / 1e3} kHz · ${mon.open.length} open · ${mon.listening.length} playing`;
}
function monitorLock(k) { const mon = state.ham.mon; if (mon.lock === k) {
    mon.lock = -1;
    mon.mode = 'mix';
}
else {
    mon.lock = k;
    mon.mode = 'lock';
} monitorSend(); refreshMonitorChips(); refreshMonitor(); }
function refreshMonitorChips() {
    const mon = state.ham.mon;
    qa('[data-monmode]').forEach(b => b.classList.toggle('on', b.dataset.monmode === mon.mode));
    qa('[data-monsp]').forEach(b => b.classList.toggle('on', Number(b.dataset.monsp) === mon.spacing));
    qa('[data-monthr]').forEach(b => b.classList.toggle('on', Number(b.dataset.monthr) === mon.threshold));
    const w = q('#mon-wide');
    if (w)
        w.classList.toggle('on', mon.wide);
}
function hamTune(hz) {
    const h = state.ham;
    hz = Math.min(6000000000, Math.max(1000000, Math.round(hz)));
    if (h.tab === 'monitor') {
        h.freq = hz;
        state.freq = hz;
        refreshReadout();
        if (Math.abs(hz - state.hamLo) > state.rate / 2 - HAM_GUARD) {
            monitorOpen();
            return;
        }
        const mon = h.mon;
        if (mon.count) {
            const k = Math.round((hz - mon.first) / mon.spacing);
            if (k >= 0 && k < mon.count) {
                mon.lock = k;
                mon.mode = 'lock';
                monitorSend();
                refreshMonitorChips();
                refreshMonitor();
            }
        }
        return;
    }
    h.freq = hz;
    state.freq = hz;
    setDial(hz);
    const off = hz - state.hamLo;
    if (Math.abs(off) > state.rate / 2 - HAM_GUARD || Math.abs(off) < 15000) {
        state.hamLo = hamLoFor(hz);
        if (radio)
            radio.targetFreqHz = state.hamLo;
    }
    hamSend();
    refreshReadout();
    refreshHamUi();
}
function hamSetMode(m) {
    const h = state.ham;
    h.mode = m;
    h.shift = 0;
    if (m === 'USB' || m === 'LSB') {
        h.lo = 100;
        h.hi = 2800;
    }
    else if (m === 'CW') {
        h.lo = 0;
        h.hi = 500;
    }
    else if (m === 'AM') {
        h.lo = 0;
        h.hi = 3000;
    }
    else if (m === 'WFM') {
        h.lo = 0;
        h.hi = 100000;
    }
    else {
        h.lo = 0;
        h.hi = 6000;
    }
    hamSend();
    refreshHamUi();
}
function hamSetWidth(w) {
    const h = state.ham;
    if (h.mode === 'USB' || h.mode === 'LSB') {
        h.lo = 100;
        h.hi = 100 + w;
    }
    else if (h.mode === 'CW') {
        h.lo = 0;
        h.hi = w;
    }
    else
        h.hi = w / 2;
    hamSend();
    refreshHamUi();
}
function hamSend() {
    const h = state.ham;
    const ssb = h.mode === 'USB' || h.mode === 'LSB';
    worker?.postMessage({ type: 'hamParams', params: { offsetHz: h.freq - state.hamLo, mode: h.mode, lo: ssb ? h.lo + h.shift : h.lo, hi: ssb ? h.hi + h.shift : h.hi, pitch: h.pitch, agc: h.agc, nr: h.nr, anf: h.anf, squelchDb: h.mode === 'NFM' ? h.squelch : 0, volume: h.volume } });
    refreshHamChannel();
}
function refreshHamChannel() {
    const h = state.ham;
    if (!scope || state.app !== 'ham')
        return;
    let lo, hi;
    if (h.mode === 'USB') {
        lo = h.lo + h.shift;
        hi = h.hi + h.shift;
    }
    else if (h.mode === 'LSB') {
        lo = -(h.hi + h.shift);
        hi = -(h.lo + h.shift);
    }
    else if (h.mode === 'CW') {
        lo = -(h.hi - h.lo) / 2;
        hi = (h.hi - h.lo) / 2;
    }
    else {
        lo = -h.hi;
        hi = h.hi;
    }
    const off = h.freq - state.hamLo;
    scope.setChannel(Math.max(0.002, (hi - lo) / state.rate), 0.5 + (off + (lo + hi) / 2) / state.rate);
}
function hamDbm() { return state.ham.db - 5 - state.lna - state.vga - (state.amp ? 14 : 0); }
function sUnits(dbm, hz) {
    const s9 = hz >= 30e6 ? -93 : -73;
    if (dbm >= s9)
        return `S9+${Math.round(dbm - s9)}`;
    return `S${Math.max(0, Math.min(9, Math.round(9 + (dbm - s9) / 6)))}`;
}
function refreshHamMeter() {
    const h = state.ham, bar = q('#sbar'), val = q('#sval'), tone = q('#ham-tone');
    if (bar) {
        const dbm = hamDbm();
        const s9 = h.freq >= 30e6 ? -93 : -73;
        const frac = Math.min(1, Math.max(0, (dbm - (s9 - 54)) / 114));
        bar.style.width = `${(frac * 100).toFixed(1)}%`;
        bar.classList.toggle('hot', dbm > s9 + 30);
    }
    if (val)
        val.textContent = `${sUnits(hamDbm(), h.freq)} · ${hamDbm().toFixed(0)} dBm est · +${(h.db - h.floor).toFixed(0)} dB · audio ${Math.round(h.audioPeak * 100)}%`;
    if (tone) {
        const parts = [];
        if (h.mode === 'NFM') {
            parts.push(h.open ? 'OPEN' : 'SQL');
            if (h.tone)
                parts.push(`CTCSS ${h.tone.toFixed(1)}`);
            if (h.dcs)
                parts.push(`DCS ${String(h.dcs).padStart(3, '0')}${h.dcsInv ? 'I' : ''}`);
            if (!h.tone && !h.dcs && h.open)
                parts.push('no tone');
        }
        else
            parts.push(h.agc === 'off' ? 'AGC off' : `AGC ${h.gain >= 1000 ? '60' : (20 * Math.log10(Math.max(1, h.gain))).toFixed(0)} dB`);
        tone.textContent = parts.join(' · ');
        tone.classList.toggle('open', h.mode === 'NFM' && h.open);
    }
}
function refreshHamUi() {
    const h = state.ham;
    qa('[data-hmode]').forEach(b => b.classList.toggle('on', b.dataset.hmode === h.mode));
    const widths = q('#ham-widths');
    if (widths && !widths.contains(document.activeElement)) {
        const ssb = h.mode === 'USB' || h.mode === 'LSB';
        const boxes = ssb ? `<span class="fbox"><input class="txin num" data-fw="lo" value="${h.lo}" inputmode="numeric" title="low edge, Hz"> – <input class="txin num" data-fw="hi" value="${h.hi}" inputmode="numeric" title="high edge, Hz"> Hz</span>`
            : `<span class="fbox"><input class="txin num" data-fw="w" value="${hamWidth()}" inputmode="numeric" title="filter width, Hz"> Hz${h.mode === 'CW' ? '' : ' wide'}</span>`;
        widths.innerHTML = HAM_WIDTHS[h.mode].map(([l, w]) => `<button class="chip ${hamWidth() === w ? 'on' : ''}" data-hw="${w}">${l}</button>`).join('') + boxes;
        qa('[data-hw]').forEach(b => b.onclick = () => hamSetWidth(Number(b.dataset.hw)));
        qa('[data-fw]', widths).forEach(i => {
            const apply = () => {
                const v = Math.round(Number(i.value));
                if (!Number.isFinite(v))
                    return;
                if (i.dataset.fw === 'w')
                    hamSetWidth(Math.max(50, Math.min(50000, v)));
                else {
                    const lo = i.dataset.fw === 'lo' ? v : h.lo, hi = i.dataset.fw === 'hi' ? v : h.hi;
                    h.lo = Math.max(0, Math.min(5000, lo));
                    h.hi = Math.max(h.lo + 100, Math.min(6000, hi));
                    h.shift = 0;
                    hamSend();
                    refreshHamUi();
                }
            };
            i.onchange = apply;
            i.onkeydown = (e) => { if (e.key === 'Enter') {
                e.preventDefault();
                apply();
                i.blur();
            } };
        });
    }
    const fcap = q('#ham-filter-cap');
    if (fcap)
        fcap.textContent = h.mode === 'USB' || h.mode === 'LSB' ? `FILTER · ${h.lo}–${h.hi} Hz` : h.mode === 'CW' ? `FILTER · ${hamWidth()} Hz` : `FILTER · ${hamWidth()} Hz wide (±${h.hi})`;
    qa('[data-agc]').forEach(b => b.classList.toggle('on', b.dataset.agc === h.agc));
    qa('[data-hsq]').forEach(b => b.classList.toggle('on', Number(b.dataset.hsq) === h.squelch));
    qa('[data-pitch]').forEach(b => b.classList.toggle('on', Number(b.dataset.pitch) === h.pitch));
    const nr = q('#ham-nr');
    if (nr)
        nr.classList.toggle('on', h.nr);
    const anf = q('#ham-anf');
    if (anf)
        anf.classList.toggle('on', h.anf);
    const cw = q('#ham-cw');
    if (cw)
        cw.hidden = h.mode !== 'CW';
    const pbt = q('#ham-pbt');
    if (pbt)
        pbt.hidden = !(h.mode === 'USB' || h.mode === 'LSB');
    const sq = q('#ham-sq');
    if (sq)
        sq.hidden = h.mode !== 'NFM';
    const band = bandOf(h.freq);
    qa('[data-band]').forEach(b => b.classList.toggle('on', b.dataset.band === band?.id));
    const seg = q('#ham-seg');
    if (seg)
        seg.textContent = segmentOf(h.freq) || 'outside the amateur bands';
    const rep = q('#ham-rep'), rin = repeaterInput(h.freq);
    if (rep) {
        rep.hidden = rin === null || h.mode !== 'NFM';
        if (rin !== null)
            rep.textContent = `${h.rev ? 'LISTENING ON INPUT' : 'REV'} · input ${(rin / 1e6).toFixed(4)}`;
        rep.classList.toggle('on', h.rev);
    }
    const steps = q('#ham-steps');
    if (steps) {
        const st = band?.step ?? (h.freq < 30e6 ? 500 : 12500);
        steps.innerHTML = [[-st * 10], [-st], [st], [st * 10]].map(([s]) => `<button class="chip" data-step="${s}">${s > 0 ? '+' : '−'}${Math.abs(s) >= 1e6 ? `${Math.abs(s) / 1e6}M` : Math.abs(s) >= 1e3 ? `${Math.abs(s) / 1e3}k` : Math.abs(s)}</button>`).join('');
        qa('[data-step]', steps).forEach(b => b.onclick = () => tune(state.freq + Number(b.dataset.step)));
    }
    refreshHamMeter();
}
function renderHam(view) {
    const h = state.ham;
    const tabs = `<div class="row tabs bandstrip">${[['rx', 'RECEIVE'], ['monitor', 'MONITOR'], ['digi', 'DIGITAL'], ['tx', 'TRANSMIT'], ['log', 'LOGBOOK']].map(([id, l]) => `<button class="chip ${h.tab === id ? 'on' : ''}" data-hamtab="${id}">${l}</button>`).join('')}</div>`;
    if (h.tab === 'tx') {
        renderPtt(view, tabs);
        return;
    }
    if (h.tab === 'log') {
        renderLog(view, tabs);
        return;
    }
    if (h.tab === 'digi') {
        const g = h.digi;
        view.innerHTML = `
      <section class="visual">${readoutHtml()}
        <div class="smeter"><div class="sbar"><div id="sbar"></div><i style="left:${(54 / 114 * 100).toFixed(1)}%">S9</i></div><span id="sval" class="sval">—</span></div>
        <div class="hamline"><span id="digi-status" class="seg">${g.mode === 'off' ? 'pick a decoder' : g.mode.toUpperCase()}</span><span id="ham-tone" class="sq" hidden></span></div>
        <div id="scope" class="panel"></div></section>
      <section class="controls">${tabs}
        <div class="caption">DECODER · AUTO picks whichever modem is making sense</div><div class="row bandstrip">${['auto', 'cw', 'rtty', 'psk31', 'ft8', 'sstv', 'dmr', 'p25', 'off'].map(m => `<button class="chip" data-digi="${m}">${m.toUpperCase()}</button>`).join('')}</div>
        <div class="row bandstrip"><button class="chip" data-hmode="USB">USB</button><button class="chip" data-hmode="LSB">LSB</button><button class="chip" data-hmode="CW">CW</button><button class="chip" data-hmode="NFM">NFM</button><button id="digi-clear" class="chip">CLEAR</button></div>
        <div id="p25-panel" hidden><div class="caption">P25 · <span id="p25-head">searching for sync</span></div>
          <div class="panel dmrslot" id="p25-call"></div></div>
        <div id="dmr-panel" hidden><div class="caption">DMR · <span id="dmr-head">searching for sync</span></div>
          <div class="dmrslots"><div class="panel dmrslot" id="dmr-s1"></div><div class="panel dmrslot" id="dmr-s2"></div></div>
          <div class="caption">AUDIO FOLLOWS · both time slots are decoded, you hear one</div><div class="row bandstrip">${[['0', 'AUTO (latest caller)'], ['1', 'SLOT 1'], ['2', 'SLOT 2']].map(([v, l]) => `<button class="chip" data-dmrslot="${v}">${l}</button>`).join('')}</div></div>
        <div class="caption">PSK31 AUDIO CENTER · RTTY BAUD/SHIFT</div><div class="row bandstrip">${[500, 1000, 1500, 2000].map(f => `<button class="chip" data-pskhz="${f}">${f}</button>`).join('')}${[['45.45', '170'], ['50', '170'], ['75', '170'], ['45.45', '450'], ['50', '850']].map(([b, s]) => `<button class="chip" data-rtty="${b}/${s}">${b}/${s}</button>`).join('')}<button id="rtty-rev" class="chip">REV</button></div>
        <div class="caption">TEXT</div><pre id="digi-text" class="panel digitext">${g.text}</pre>
        <div id="sstv-panel" hidden>${imgPanelHtml()}<div class="caption">SSTV FREQUENCIES</div><div class="row bandstrip">${[['20m 14.230', 14230000, 'USB'], ['20m 14.233', 14233000, 'USB'], ['10m 28.680', 28680000, 'USB'], ['40m 7.171', 7171000, 'LSB'], ['ISS 145.800', 145800000, 'NFM']].map(([l, f, md]) => `<button class="chip" data-sstvf="${f}" data-sstvm="${md}">${l}</button>`).join('')}</div></div>
        <div id="ft8-panel"><div class="caption">FT8 · <span id="ft8-clock"></span> · UTC  SNR  DT  Hz  message</div><div id="ft8-list" class="panel list"></div>
          <div class="caption">FT8 FREQUENCIES</div><div class="row bandstrip">${[['160m', 1840000], ['80m', 3573000], ['40m', 7074000], ['30m', 10136000], ['20m', 14074000], ['17m', 18100000], ['15m', 21074000], ['12m', 24915000], ['10m', 28074000], ['6m', 50313000], ['2m', 144174000]].map(([l, f]) => `<button class="chip" data-ft8f="${f}">${l}</button>`).join('')}</div></div>
        <div class="caption">TUNE</div><div id="ham-steps" class="row"></div>
        ${gainHtml()}
      </section>`;
        scope = attach(tunableScope('scope', 200));
        qa('[data-hamtab]', view).forEach(b => b.onclick = () => { h.tab = b.dataset.hamtab; open('ham'); });
        qa('[data-digi]', view).forEach(b => b.onclick = () => { g.mode = b.dataset.digi; if (g.mode === 'ft8' && h.mode !== 'USB')
            hamSetMode('USB'); if (g.mode === 'cw' && h.mode !== 'CW')
            hamSetMode('CW'); if ((g.mode === 'dmr' || g.mode === 'p25') && h.mode !== 'NFM')
            hamSetMode('NFM'); if ((g.mode === 'psk31' || g.mode === 'rtty') && h.mode !== 'USB' && h.mode !== 'LSB')
            hamSetMode('USB'); digiSend(); });
        qa('[data-dmrslot]', view).forEach(b => b.onclick = () => { g.dmrSlot = Number(b.dataset.dmrslot); digiSend(); });
        qa('[data-sstvf]', view).forEach(b => b.onclick = () => { g.mode = 'sstv'; const md = b.dataset.sstvm; if (h.mode !== md)
            hamSetMode(md); hamTune(Number(b.dataset.sstvf)); digiSend(); });
        imgBind();
        qa('[data-hmode]', view).forEach(b => b.onclick = () => hamSetMode(b.dataset.hmode));
        qa('[data-pskhz]', view).forEach(b => b.onclick = () => { g.pskHz = Number(b.dataset.pskhz); digiSend(); });
        qa('[data-rtty]', view).forEach(b => b.onclick = () => { const [bd, sh] = b.dataset.rtty.split('/'); g.rttyBaud = Number(bd); g.rttyShift = Number(sh); digiSend(); });
        $('rtty-rev').onclick = () => { g.rttyRev = !g.rttyRev; digiSend(); };
        $('digi-clear').onclick = () => { g.text = ''; g.ft8 = []; $('digi-text').textContent = ''; refreshFt8(); };
        qa('[data-ft8f]', view).forEach(b => b.onclick = () => { g.mode = 'ft8'; if (h.mode !== 'USB')
            hamSetMode('USB'); hamTune(Number(b.dataset.ft8f)); digiSend(); });
        clearInterval(ft8Timer);
        ft8Timer = window.setInterval(() => { const c = q('#ft8-clock'); if (!c) {
            clearInterval(ft8Timer);
            return;
        } const s = (Date.now() / 1000) % 15; c.textContent = `${(15 - s).toFixed(0)} s to next slot`; }, 500);
        refreshHamUi();
        digiSend();
        refreshFt8();
        refreshDmr();
        refreshP25();
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
        <div class="caption">LISTEN</div><div class="row">${['mix', 'latest', 'lock'].map(m => `<button class="chip" data-monmode="${m}">${m.toUpperCase()}</button>`).join('')}</div>
        <div class="caption">RASTER · THRESHOLD · SPAN</div><div class="row">${[12500, 25000].map(s => `<button class="chip" data-monsp="${s}">${s / 1e3} kHz</button>`).join('')}${[6, 8, 12].map(t => `<button class="chip" data-monthr="${t}">+${t} dB</button>`).join('')}<button id="mon-wide" class="chip" ${window.innerWidth >= 720 ? '' : 'hidden'}>3.84 MHz</button></div>
        <div class="caption">BAND</div><div class="row bandstrip">${[...BANDS, ...NON_HAM].map(b => `<button class="chip" data-band="${b.id}">${b.name}</button>`).join('')}</div>
        <div class="caption">ACTIVITY</div><div id="mon-log" class="panel list short"></div>
        ${gainHtml()}
      </section>`;
        scope = attach(tunableScope('scope', 200));
        qa('[data-hamtab]', view).forEach(b => b.onclick = () => { h.tab = b.dataset.hamtab; open('ham'); });
        qa('[data-band]', view).forEach(b => b.onclick = () => { const band = [...BANDS, ...NON_HAM].find(x => x.id === b.dataset.band); h.freq = band.calling ?? band.lo; if (band.mode !== h.mode)
            hamSetMode(band.mode); h.mon.lock = -1; open('ham'); });
        qa('[data-monmode]', view).forEach(b => b.onclick = () => { h.mon.mode = b.dataset.monmode; if (h.mon.mode !== 'lock')
            h.mon.lock = -1; monitorSend(); refreshMonitorChips(); });
        qa('[data-monsp]', view).forEach(b => b.onclick = () => { h.mon.spacing = Number(b.dataset.monsp); monitorSend(); refreshMonitorChips(); });
        qa('[data-monthr]', view).forEach(b => b.onclick = () => { h.mon.threshold = Number(b.dataset.monthr); monitorSend(); refreshMonitorChips(); });
        $('mon-wide').onclick = () => { h.mon.wide = !h.mon.wide; open('ham'); };
        refreshMonitorChips();
        refreshMonitor();
        const band = bandOf(h.freq);
        qa('[data-band]').forEach(b => b.classList.toggle('on', b.dataset.band === band?.id));
        return;
    }
    view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <div class="smeter"><div class="sbar"><div id="sbar"></div><i style="left:${(54 / 114 * 100).toFixed(1)}%">S9</i></div><span id="sval" class="sval">—</span></div>
      <div class="hamline"><span id="ham-seg" class="seg"></span><span id="ham-tone" class="sq">—</span></div>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      <div class="caption">BAND</div><div class="row bandstrip">${[...BANDS, ...NON_HAM].map(b => `<button class="chip" data-band="${b.id}">${b.name}</button>`).join('')}</div>
      <div class="caption">MODE</div><div class="row">${['LSB', 'USB', 'CW', 'AM', 'NFM', 'WFM'].map(m => `<button class="chip" data-hmode="${m}">${m}</button>`).join('')}</div>
      <div class="caption">TUNE</div><div id="ham-steps" class="row"></div>
      <div class="caption" id="ham-filter-cap">FILTER · Hz</div><div id="ham-widths" class="row"></div>
      <div id="ham-pbt"><div class="caption">PASSBAND SHIFT · <span id="pbt-val">0</span> Hz</div><input id="pbt" type="range" min="-600" max="600" step="50" value="${h.shift}"></div>
      <div id="ham-cw"><div class="caption">CW PITCH · Hz</div><div class="row">${[500, 600, 700, 800].map(p => `<button class="chip" data-pitch="${p}">${p}</button>`).join('')}</div></div>
      <div class="caption">AGC · DSP</div><div class="row">${['off', 'fast', 'slow'].map(a => `<button class="chip" data-agc="${a}">AGC ${a.toUpperCase()}</button>`).join('')}<button id="ham-nr" class="chip">NR</button><button id="ham-anf" class="chip">NOTCH</button></div>
      <div id="ham-sq"><div class="caption">SQUELCH · dB over floor</div><div class="row">${[0, 3, 6, 10, 15].map(d => `<button class="chip" data-hsq="${d}">${d ? d : 'OFF'}</button>`).join('')}<button id="ham-rep" class="chip" hidden>REV</button></div></div>
      <div class="caption">VOLUME</div><input id="ham-vol" type="range" min="0" max="2" step="0.05" value="${h.volume}">
      ${gainHtml()}
    </section>`;
    scope = attach(tunableScope('scope', 200));
    qa('[data-hamtab]', view).forEach(b => b.onclick = () => { h.tab = b.dataset.hamtab; open('ham'); });
    qa('[data-band]', view).forEach(b => b.onclick = () => { const band = [...BANDS, ...NON_HAM].find(x => x.id === b.dataset.band); h.rev = false; if (band.mode !== h.mode)
        hamSetMode(band.mode); hamTune(band.calling ?? band.lo); });
    qa('[data-hmode]', view).forEach(b => b.onclick = () => hamSetMode(b.dataset.hmode));
    qa('[data-agc]', view).forEach(b => b.onclick = () => { h.agc = b.dataset.agc; hamSend(); refreshHamUi(); });
    qa('[data-hsq]', view).forEach(b => b.onclick = () => { h.squelch = Number(b.dataset.hsq); hamSend(); refreshHamUi(); });
    qa('[data-pitch]', view).forEach(b => b.onclick = () => { h.pitch = Number(b.dataset.pitch); hamSend(); refreshHamUi(); });
    $('ham-nr').onclick = () => { h.nr = !h.nr; hamSend(); refreshHamUi(); };
    $('ham-anf').onclick = () => { h.anf = !h.anf; hamSend(); refreshHamUi(); };
    $('ham-rep').onclick = () => { if (!h.rev) {
        const rin = repeaterInput(h.freq);
        if (rin === null)
            return;
        h.back = h.freq;
        h.rev = true;
        hamTune(rin);
    }
    else {
        h.rev = false;
        hamTune(h.back || h.freq);
    } };
    $('pbt').oninput = (e) => { h.shift = Number(e.target.value); $('pbt-val').textContent = String(h.shift); hamSend(); };
    $('ham-vol').oninput = (e) => { h.volume = Number(e.target.value); hamSend(); };
    refreshHamUi();
}
let satTimer = 0;
function satOpen() {
    const s = state.ham.sat;
    if (!state.home)
        requestGeo();
    if (s.tles.size === 0) {
        s.status = 'fetching TLEs…';
        fetchTles(SATS.map(x => x.norad)).then(m => { s.tles = m; s.status = `${m.size} TLEs`; satRefresh(true); }).catch(e => { s.status = `TLE fetch failed: ${e.message}`; satRefresh(); });
    }
}
function satSel() {
    const s = state.ham.sat, def = SATS.find(x => x.norad === s.sel), tle = def && s.tles.get(def.norad);
    if (!def)
        return null;
    const svc = def.services[Math.min(s.svc, def.services.length - 1)];
    let sgp = null;
    if (tle) {
        try {
            sgp = new Sgp4(tle);
        }
        catch {
            sgp = null;
        }
    }
    return { def, svc, sgp };
}
function satApplyService() {
    const h = state.ham, cur = satSel();
    if (!cur)
        return;
    const k = cur.svc.kind;
    const mode = k === 'linear' ? 'USB' : k === 'cw' ? 'CW' : 'NFM';
    if (h.mode !== mode)
        hamSetMode(mode);
    if (k === 'apt' || k === 'lrpt') {
        h.hi = 20000;
        hamSend();
    }
    worker?.postMessage({ type: 'satService', kind: k });
    if (k === 'sstv') {
        h.digi.mode = 'sstv';
        digiSend();
    }
    else if (h.digi.mode === 'sstv') {
        h.digi.mode = 'off';
        digiSend();
    }
    h.sat.packets = [];
    imgReset();
    hamTune(cur.svc.down);
    const p = q('#sat-panel');
    if (p) {
        p.hidden = !(k === 'packet' || k === 'sstv' || k === 'apt' || k === 'lrpt');
    }
    const pk = q('#sat-packets');
    if (pk) {
        pk.hidden = k !== 'packet';
    }
    const im = q('#sat-image');
    if (im) {
        im.hidden = !(k === 'sstv' || k === 'apt' || k === 'lrpt');
    }
    const pt = q('#sat-ptt');
    if (pt) {
        pt.hidden = !cur.svc.up;
    }
}
let satTrackAt = 0;
function satMap(cur) {
    if (!geo || !cur.sgp)
        return;
    const home = state.home ?? { lat: 0, lon: 0 }, now = Date.now(), XKMPER = 6378.137;
    const l = look(cur.sgp, now, home.lat, home.lon);
    const label = state.home ? `${cur.def.name} · el ${l.el.toFixed(0)}°` : cur.def.name;
    geo.update([{ id: 'sat', lat: l.lat, lon: l.lon, label, kind: 'sat' }], 'sat');
    geo.setFootprint(l.lat, l.lon, XKMPER * Math.acos(XKMPER / (XKMPER + Math.max(100, l.altKm))));
    if (now - satTrackAt > 30000) {
        satTrackAt = now;
        const pts = [];
        for (let t = now; t <= now + 90 * 60000; t += 60000) {
            const p = look(cur.sgp, t, home.lat, home.lon);
            pts.push([p.lat, p.lon]);
        }
        geo.setTrack(pts);
    }
}
function satRefresh(recomputePasses = false) {
    const s = state.ham.sat, cur = satSel(), home = state.home;
    const st = q('#sat-status');
    if (st)
        st.textContent = s.status + (home ? ` · ${home.lat.toFixed(2)}, ${home.lon.toFixed(2)}` : ' · no GPS fix');
    qa('[data-sat]').forEach(b => b.classList.toggle('on', Number(b.dataset.sat) === s.sel));
    const svcRow = q('#sat-services');
    if (svcRow && cur) {
        const want = cur.def.services.map((x, i) => `<button class="chip ${i === s.svc ? 'on' : ''}" data-svc="${i}">${x.name.toUpperCase()}</button>`).join('');
        if (svcRow.innerHTML !== want) {
            svcRow.innerHTML = want;
            qa('[data-svc]', svcRow).forEach(b => b.onclick = () => { s.svc = Number(b.dataset.svc); satApplyService(); satRefresh(); });
        }
    }
    const trk = q('#sat-track');
    if (trk) {
        trk.classList.toggle('on', s.track);
        trk.textContent = s.track ? 'LISTENING · DOPPLER ON' : 'LISTEN · TRACK DOPPLER';
    }
    if (!cur)
        return;
    satMap(cur);
    const svc = cur.svc;
    const note = q('#sat-note');
    if (note)
        note.textContent = `${svc.name} · ${(svc.down / 1e6).toFixed(4)} MHz down${svc.up ? ` · ${(svc.up / 1e6).toFixed(3)} up${svc.tone ? ` tone ${svc.tone}` : ''}` : ''}${svc.note ? ` · ${svc.note}` : ''}`;
    const what = q('#sat-what');
    if (what)
        what.textContent = cur.def.what ?? '';
    const how = q('#sat-how');
    if (how)
        how.textContent = `${svc.up ? 'Two-way, license needed to transmit. ' : 'Receive only. '}${svc.how ?? ''}`.trim();
    const info = q('#sat-now');
    if (!cur.sgp) {
        if (info)
            info.innerHTML = `<div class="kv"><span>${cur.def.name}</span><span>${s.tles.size ? 'no orbit data from CelesTrak — retired or renamed; the receiver is tuned anyway' : 'waiting for orbit data…'}</span></div>`;
        const pl0 = q('#sat-passes');
        if (pl0)
            pl0.innerHTML = '<div class="empty">no TLE, no passes</div>';
        return;
    }
    if (!home) {
        if (info)
            info.innerHTML = `<div class="kv"><span>${cur.def.name}</span><span>allow location to get look angles, Doppler and passes</span></div>`;
        return;
    }
    const now = Date.now(), l = look(cur.sgp, now, home.lat, home.lon);
    const rx = doppler(svc.down, l.rangeRate), txf = svc.up ? dopplerUp(svc.up, l.rangeRate) : 0;
    if (info)
        info.innerHTML = `<div class="kv"><span>Now</span><span>az ${l.az.toFixed(0)}° · el ${l.el.toFixed(1)}° · ${l.rangeKm.toFixed(0)} km · ${l.rangeRate >= 0 ? '+' : ''}${(l.rangeRate).toFixed(2)} km/s${l.el < 0 ? ' · below the horizon' : ''}</span></div><div class="kv"><span>Receive</span><span>${(svc.down / 1e6).toFixed(4)} → <b>${(rx / 1e6).toFixed(4)} MHz</b> (${rx - svc.down >= 0 ? '+' : ''}${rx - svc.down} Hz)</span></div>${svc.up ? `<div class="kv"><span>Transmit</span><span>${(svc.up / 1e6).toFixed(4)} → <b>${(txf / 1e6).toFixed(4)} MHz</b>${svc.tone ? ` · CTCSS ${svc.tone.toFixed(1)}` : ' · no tone'}</span></div>` : ''}<div class="kv"><span>Sub-point</span><span>${l.lat.toFixed(1)}, ${l.lon.toFixed(1)} · ${l.altKm.toFixed(0)} km</span></div>`;
    if (recomputePasses || !s.passes.length)
        s.passes = passes(cur.sgp, home.lat, home.lon, now, 24);
    const pl = q('#sat-passes');
    if (pl)
        pl.innerHTML = s.passes.length ? s.passes.map((p, i) => { const a = new Date(p.aos), b = new Date(p.los); const live = now >= p.aos && now <= p.los; return `<div class="li ${i % 2 ? 'alt' : ''} ${live ? 'gold' : ''}"><span class="row2"><span>${live ? 'NOW · ' : ''}${a.getHours().toString().padStart(2, '0')}:${a.getMinutes().toString().padStart(2, '0')} → ${b.getHours().toString().padStart(2, '0')}:${b.getMinutes().toString().padStart(2, '0')} (${Math.round((p.los - p.aos) / 60000)} min)</span><span>max el ${p.maxEl.toFixed(0)}° · az ${p.aosAz.toFixed(0)}→${p.losAz.toFixed(0)}</span></span></div>`; }).join('') : '<div class="empty">no passes in the next 24 h</div>';
    if (s.track && s.dopplerOn && l.el > -5 && Math.abs(rx - state.ham.freq) > 25 && !state.ham.ptt.on)
        hamTune(rx);
}
function imgReset() { const im = state.ham.img; im.mode = ''; im.width = 0; im.height = 0; im.line = 0; im.done = false; im.apt = 0; im.lrpt.planes = {}; im.lrpt.lines = 0; im.lrpt.stats = ''; const c = q('#img-canvas'); if (c) {
    c.width = 320;
    c.height = 240;
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
} const cap = q('#img-caption'); if (cap)
    cap.textContent = 'waiting for a picture'; }
function imgPanelHtml() { return `<div class="caption">PICTURE · <span id="img-caption">waiting for a picture</span></div><div class="imgwrap panel"><canvas id="img-canvas" width="320" height="240"></canvas></div><div class="row"><button id="img-save" class="chip">SAVE PNG</button><button id="img-clear" class="chip">CLEAR</button></div>`; }
function imgBind() {
    const save = q('#img-save'), clear = q('#img-clear');
    if (save)
        save.addEventListener('click', () => { const c = q('#img-canvas'); if (!c)
            return; c.toBlob(b => { if (!b)
            return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${state.ham.img.mode || 'image'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }, 'image/png'); });
    if (clear)
        clear.addEventListener('click', imgReset);
}
function onSstv(m) {
    const im = state.ham.img, c = q('#img-canvas');
    if (!c)
        return;
    const width = m.width, height = m.height, line = m.line, count = m.count, rows = m.rows;
    if (im.mode !== m.mode || im.width !== width || line === 0) {
        im.mode = m.mode;
        im.width = width;
        im.height = height;
        im.done = false;
        c.width = width;
        c.height = height;
        c.getContext('2d').fillStyle = '#000';
        c.getContext('2d').fillRect(0, 0, width, height);
    }
    im.line = line + count;
    im.done = im.line >= height;
    c.getContext('2d').putImageData(new ImageData(rows, width, count), 0, line);
    const cap = q('#img-caption');
    if (cap)
        cap.textContent = `SSTV ${im.mode} · ${width}×${height} · line ${im.line}${im.done ? ' · complete' : ''}`;
}
const LRPT_W = 1568;
function lrptPlane(apid, lines) {
    const L = state.ham.img.lrpt, need = lines * 8 * LRPT_W;
    let p = L.planes[apid];
    if (!p || p.length < need) {
        const np = new Uint8Array(Math.max(need, (p?.length ?? 0) * 2, 64 * 8 * LRPT_W));
        if (p)
            np.set(p);
        p = np;
        L.planes[apid] = p;
    }
    return p;
}
function onLrpt(m) {
    const im = state.ham.img, L = im.lrpt, c = q('#img-canvas');
    if (!c)
        return;
    const apid = m.apid, line = m.line, x = m.x, px = m.pixels;
    if (im.mode !== 'LRPT') {
        im.mode = 'LRPT';
        im.width = LRPT_W;
        L.planes = {};
        L.lines = 0;
        c.width = LRPT_W;
        c.height = 256;
        c.getContext('2d').fillStyle = '#000';
        c.getContext('2d').fillRect(0, 0, c.width, c.height);
    }
    const plane = lrptPlane(apid, line + 1);
    for (let y = 0; y < 8; y++)
        plane.set(px.subarray(y * 112, y * 112 + 112), (line * 8 + y) * LRPT_W + x);
    if (line + 1 > L.lines)
        L.lines = line + 1;
    const rowsNeeded = L.lines * 8;
    if (c.height < rowsNeeded) {
        const ctx = c.getContext('2d'), keep = ctx.getImageData(0, 0, c.width, c.height);
        c.height = rowsNeeded + 256;
        ctx.putImageData(keep, 0, 0);
    }
    const P = L.planes, r = P[66] ?? P[68] ?? P[apid], g = P[65] ?? P[67] ?? P[apid], b = P[64] ?? P[apid];
    const out = new Uint8ClampedArray(8 * 112 * 4);
    for (let y = 0; y < 8; y++)
        for (let k = 0; k < 112; k++) {
            const src = (line * 8 + y) * LRPT_W + x + k, o = (y * 112 + k) * 4;
            out[o] = r[src] ?? 0;
            out[o + 1] = g[src] ?? 0;
            out[o + 2] = b[src] ?? 0;
            out[o + 3] = 255;
        }
    c.getContext('2d').putImageData(new ImageData(out, 112, 8), x, line * 8);
    const cap = q('#img-caption');
    if (cap)
        cap.textContent = `LRPT · ${L.lines} lines · channels ${Object.keys(P).join(', ')}${L.stats ? ` · ${L.stats}` : ''}`;
}
function onLrptStats(m) {
    const s = m.stats;
    state.ham.img.lrpt.stats = s.lock ? `locked · ${s.freqHz >= 0 ? '+' : ''}${s.freqHz.toFixed(0)} Hz · BER ${(s.ber * 100).toFixed(1)}% · RS ${s.rs < 0 ? 'fail' : s.rs} · frames ${s.frames}/${s.frames + s.badFrames}` : `searching (offset ${s.freqHz.toFixed(0)} Hz)`;
    const cap = q('#img-caption');
    if (cap && state.ham.img.mode !== 'SSTV' && state.ham.img.mode !== 'APT')
        cap.textContent = `LRPT · ${state.ham.img.lrpt.lines} lines · ${state.ham.img.lrpt.stats}`;
}
function onApt(m) {
    const im = state.ham.img, c = q('#img-canvas');
    if (!c)
        return;
    const row = m.row, line = m.line;
    if (im.mode !== 'APT' || line === 0) {
        im.mode = 'APT';
        im.width = 2080;
        im.height = 0;
        im.apt = 0;
        c.width = 2080;
        c.height = 400;
        c.getContext('2d').fillStyle = '#000';
        c.getContext('2d').fillRect(0, 0, c.width, c.height);
    }
    if (im.apt >= c.height) {
        const ctx = c.getContext('2d'), keep = ctx.getImageData(0, 0, c.width, c.height);
        c.height += 400;
        ctx.putImageData(keep, 0, 0);
    }
    const px = new Uint8ClampedArray(2080 * 4);
    for (let k = 0; k < 2080; k++) {
        px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = row[k];
        px[k * 4 + 3] = 255;
    }
    c.getContext('2d').putImageData(new ImageData(px, 2080, 1), 0, im.apt);
    im.apt++;
    im.line = im.apt;
    const cap = q('#img-caption');
    if (cap)
        cap.textContent = `APT · ${im.apt} lines · channel A left, B right`;
}
function renderSat(view, tabs) {
    const h = state.ham, s = h.sat;
    view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <div class="hamline"><span id="sat-status" class="seg">${s.status}</span><span id="ham-tone" class="sq">—</span></div>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      <div class="caption">SATELLITE</div><div class="row bandstrip">${SATS.map(x => `<button class="chip" data-sat="${x.norad}">${x.name}</button>`).join('')}</div>
      <div id="sat-what" class="about"></div>
      <div class="caption">WHAT IT OFFERS · tap to set the receiver up for it</div><div id="sat-services" class="row bandstrip"></div>
      <div id="sat-how" class="about"></div>
      <div id="sat-note" class="health"></div>
      <div class="row"><button id="sat-track" class="chip primary" style="flex:2">LISTEN · TRACK DOPPLER</button><button id="sat-refresh" class="chip">REFRESH TLE</button></div>
      <button id="sat-ptt" class="chip ptt" hidden>PUSH TO TALK · UPLINK</button>
      <div id="tx-status" class="health"></div>
      <div id="sat-now" class="panel about"></div>
      <div id="sat-map" class="panel map"></div>
      <div id="sat-panel" hidden><div id="sat-packets" hidden><div class="caption">PACKETS HEARD</div><div id="sat-packet-list" class="panel list short"></div></div><div id="sat-image" hidden>${imgPanelHtml()}</div></div>
      <div class="caption">PASSES · next 24 h · local time</div><div id="sat-passes" class="panel list short"></div>
      ${gainHtml()}
    </section>`;
    scope = attach(tunableScope('scope', 200));
    qa('[data-hamtab]', view).forEach(b => b.onclick = () => { pttStop(); worker?.postMessage({ type: 'satService', kind: 'none' }); h.tab = b.dataset.hamtab; open('ham'); });
    qa('[data-satview]', view).forEach(b => b.onclick = () => { pttStop(); worker?.postMessage({ type: 'satService', kind: 'none' }); state.ham.sat.view = b.dataset.satview; open('sat'); });
    qa('[data-sat]', view).forEach(b => b.onclick = () => { s.sel = Number(b.dataset.sat); s.svc = 0; s.passes = []; satApplyService(); satRefresh(true); });
    $('sat-track').onclick = () => { s.track = !s.track; if (s.track)
        satApplyService(); satRefresh(); };
    $('sat-refresh').onclick = () => { try {
        localStorage.removeItem('mayhem.tle');
    }
    catch { } s.tles = new Map(); satOpen(); };
    const ptt = $('sat-ptt');
    const satPtt = () => { const cur = satSel(), home = state.home; if (!cur || !cur.svc.up)
        return; const rr = home && cur.sgp ? look(cur.sgp, Date.now(), home.lat, home.lon).rangeRate : 0; pttStart(dopplerUp(cur.svc.up, rr), cur.svc.tone ?? 0, ptt); };
    ptt.onpointerdown = (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); satPtt(); };
    ptt.onpointerup = ptt.onpointercancel = () => pttStop();
    ptt.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        satPtt();
    } };
    ptt.onkeyup = (e) => { if (e.key === ' ' || e.key === 'Enter')
        pttStop(); };
    imgBind();
    geo = new GeoMap($('sat-map'), { home: state.home, onPick: () => undefined, log });
    satTrackAt = 0;
    clearInterval(satTimer);
    satTimer = window.setInterval(() => { if (!q('#sat-now')) {
        clearInterval(satTimer);
        return;
    } satRefresh(); }, 1000);
    refreshHamUi();
    satApplyService();
    satRefresh(true);
    const pk = q('#sat-packet-list');
    if (pk) {
        pk.innerHTML = s.packets.map((p, i) => `<div class="li tap ${i % 2 ? 'alt' : ''}">${p}</div>`).join('');
        pk.onclick = (ev) => { const li = ev.target.closest('.li'); const m = li?.textContent?.match(/^\S+\s+([A-Z0-9-]+)>/); if (m)
            logPrefill({ call: m[1].replace(/-\d+$/, ''), mode: 'APRS', notes: li.textContent.slice(9) }); };
    }
}
function loadLog() { try {
    const v = JSON.parse(localStorage.getItem('mayhem.logbook') ?? '[]');
    return Array.isArray(v) ? v : [];
}
catch {
    return [];
} }
function saveLog() { try {
    localStorage.setItem('mayhem.logbook', JSON.stringify(state.ham.log.entries));
}
catch { } }
function stationEmpty() { return { call: '', grid: '', name: '', dmrId: '', aprsSsid: '9', license: '' }; }
function loadStation() { try {
    return { ...stationEmpty(), ...JSON.parse(localStorage.getItem('mayhem.station') ?? '{}') };
}
catch {
    return stationEmpty();
} }
function aprsCall() { const s = state.ham.station; return s.call ? `${s.call}${s.aprsSsid && s.aprsSsid !== '0' ? `-${s.aprsSsid}` : ''}` : 'N0CALL-9'; }
function saveStation() { try {
    localStorage.setItem('mayhem.station', JSON.stringify(state.ham.station));
}
catch { } }
function logModeNow() {
    const h = state.ham, d = h.digi.mode, ssb = h.mode === 'USB' || h.mode === 'LSB' || h.mode === 'CW';
    if (ssb && (d === 'cw' || d === 'rtty' || d === 'psk31' || d === 'ft8' || d === 'sstv'))
        return d.toUpperCase();
    if (h.mode === 'NFM' && (d === 'dmr' || (d === 'auto' && h.digi.winner === 'DMR')))
        return 'DMR';
    if (ssb && d === 'auto' && h.digi.winner && h.digi.winner !== 'ANALOG VOICE')
        return h.digi.winner.toUpperCase();
    return h.mode === 'NFM' ? 'FM' : h.mode;
}
function rstDefault(mode) { return /^(FM|NFM|AM|USB|LSB|SSB|DMR)$/.test(mode) ? '59' : /FT8/.test(mode) ? '-10' : '599'; }
function myGrid() { const s = state.ham.station; if (s.grid)
    return s.grid.toUpperCase(); return state.home ? latLonToGrid(state.home.lat, state.home.lon) : ''; }
function myLatLon() { const s = state.ham.station; if (s.grid)
    return gridToLatLon(s.grid); return state.home; }
function callInfoHtml(info, call) {
    const p = parseCall(call);
    if (!p.base)
        return 'type a callsign — the prefix says where it is, LOOKUP asks HamQTH / hamdb / callook for the rest';
    const worked = state.ham.log.entries.filter(q => parseCall(q.call).base === p.base).sort((a, b) => b.ts - a.ts);
    const parts = [];
    if (info) {
        parts.push(`<b>${info.base}</b>${info.prefix && info.prefix !== info.base.slice(0, info.prefix.length) ? ` (operating from ${info.prefix})` : ''}`);
        if (info.name)
            parts.push(info.name + (info.class ? ` · ${info.class}` : ''));
        if (info.country)
            parts.push(`${info.country}${info.continent ? ` · ${info.continent}` : ''}${info.cq ? ` · CQ ${info.cq}` : ''}${info.itu ? ` · ITU ${info.itu}` : ''}${info.utc !== undefined ? ` · UTC${-info.utc >= 0 ? '+' : '−'}${Math.abs(info.utc)}` : ''}`);
        if (info.qth)
            parts.push(info.qth);
        const here = myLatLon();
        const there = info.grid ? gridToLatLon(info.grid) : info.lat !== undefined && info.lon !== undefined ? { lat: info.lat, lon: info.lon } : null;
        if (here && there) {
            const d = distanceBearing(here.lat, here.lon, there.lat, there.lon);
            parts.push(`${info.grid ? `grid ${info.grid} · ` : ''}${d.km >= 100 ? d.km.toFixed(0) : d.km.toFixed(1)} km · bearing ${d.deg.toFixed(0)}°${d.km > 500 ? ` (long path ${((d.deg + 180) % 360).toFixed(0)}°)` : ''}`);
        }
        else if (info.grid)
            parts.push(`grid ${info.grid}`);
        parts.push(`<span class="dim">${info.source}</span>`);
    }
    if (worked.length) {
        const w = worked[0];
        parts.push(`<span class="gold">worked ${worked.length}× · last ${new Date(w.ts).toISOString().slice(0, 10)} ${bandOfHz(w.freq)} ${w.mode}${w.name ? ` · ${w.name}` : ''}</span>`);
    }
    else
        parts.push('<span class="dim">new one — not in the log yet</span>');
    return parts.join('<br>');
}
function logRefreshInfo() {
    logMap();
    const h = state.ham, el = q('#q-info');
    if (!el)
        return;
    const call = q('#q-call')?.value ?? h.log.draft.call;
    if (!h.log.info || parseCall(h.log.info.call).base !== parseCall(call).base)
        h.log.info = call.trim() ? offlineInfo(call) : null;
    el.innerHTML = callInfoHtml(h.log.info, call);
}
async function logLookup() {
    const h = state.ham, call = q('#q-call')?.value?.trim() ?? '';
    if (!call)
        return;
    const el = q('#q-info');
    if (el)
        el.innerHTML = `looking up ${call.toUpperCase()}…`;
    const info = await lookupCall(call);
    h.log.info = info;
    const fill = (id, v) => { const i = q(id); if (i && !i.value && v)
        i.value = v; };
    fill('#q-name', info.name);
    fill('#q-qth', info.qth?.replace(/^call area \d · /, ''));
    fill('#q-grid', info.grid);
    logRefreshInfo();
}
function logPrefill(p) {
    const h = state.ham;
    Object.assign(h.log.draft, { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' }, p);
    h.log.editing = '';
    h.log.info = null;
    h.tab = 'log';
    open('ham');
}
function logDraftFromForm() {
    const d = state.ham.log.draft, v = (id) => q(id)?.value ?? '';
    d.call = v('#q-call').trim().toUpperCase();
    d.rstS = v('#q-rsts').trim();
    d.rstR = v('#q-rstr').trim();
    d.name = v('#q-name').trim();
    d.qth = v('#q-qth').trim();
    d.grid = v('#q-grid').trim().toUpperCase();
    d.notes = v('#q-notes').trim();
}
function logSave() {
    const h = state.ham;
    logDraftFromForm();
    const d = h.log.draft, call = parseCall(d.call).call;
    if (!call) {
        const el = q('#q-info');
        if (el)
            el.innerHTML = '<span class="gold">a callsign, at least</span>';
        return;
    }
    const existing = h.log.editing ? h.log.entries.find(x => x.id === h.log.editing) : undefined;
    const qso = existing ?? { id: `${Date.now()}-${call}`, call, ts: Date.now(), freq: h.freq, mode: d.mode || logModeNow(), rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '' };
    Object.assign(qso, { call, rstS: d.rstS, rstR: d.rstR, name: d.name, qth: d.qth, grid: d.grid, notes: d.notes, country: h.log.info?.country ?? qso.country });
    if (!existing)
        h.log.entries.unshift(qso);
    saveLog();
    h.log.editing = '';
    Object.assign(d, { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' });
    h.log.info = null;
    renderLogForm();
    logRefreshList();
    log(`logged ${qso.call} · ${(qso.freq / 1e6).toFixed(4)} MHz ${qso.mode}`);
}
function logMap() {
    const h = state.ham;
    if (!geo || h.tab !== 'log')
        return;
    const me = myLatLon();
    const items = [];
    const lines = [];
    for (const e of h.log.entries) {
        if (!/^[A-R]{2}\d{2}([A-X]{2})?/i.test(e.grid))
            continue;
        const p = gridToLatLon(e.grid);
        if (!p)
            continue;
        items.push({ id: e.id, lat: p.lat, lon: p.lon, label: e.call, kind: 'qso' });
        if (me)
            lines.push([[me.lat, me.lon], [p.lat, p.lon]]);
    }
    const info = h.log.info;
    if (info && (info.grid || (info.lat !== undefined && info.lon !== undefined))) {
        const p = info.grid ? gridToLatLon(info.grid) : { lat: info.lat, lon: info.lon };
        if (p)
            items.push({ id: 'lookup', lat: p.lat, lon: p.lon, label: info.call, kind: 'object' });
    }
    geo.setLines(lines);
    geo.update(items, h.log.editing || 'lookup');
}
function logEdit(id) {
    const h = state.ham, x = h.log.entries.find(e => e.id === id);
    if (!x)
        return;
    h.log.editing = id;
    Object.assign(h.log.draft, { call: x.call, rstS: x.rstS, rstR: x.rstR, name: x.name, qth: x.qth, grid: x.grid, notes: x.notes, mode: x.mode });
    h.log.info = null;
    renderLogForm();
}
function logDelete(id) { const h = state.ham; h.log.entries = h.log.entries.filter(e => e.id !== id); saveLog(); if (h.log.editing === id) {
    h.log.editing = '';
    renderLogForm();
} logRefreshList(); }
function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
function logRefreshList() {
    const h = state.ham, list = q('#log-list'), stats = q('#log-stats');
    if (!list)
        return;
    const e = h.log.entries;
    if (stats) {
        const calls = new Set(e.map(x => parseCall(x.call).base)).size, ents = new Set(e.map(x => x.country ?? offlineInfo(x.call).country).filter(Boolean)).size;
        stats.textContent = e.length ? `${e.length} QSO${e.length === 1 ? '' : 's'} · ${calls} callsign${calls === 1 ? '' : 's'} · ${ents} entit${ents === 1 ? 'y' : 'ies'}` : 'empty';
    }
    list.innerHTML = e.length ? e.slice(0, 300).map((x, i) => { const d = new Date(x.ts); return `<div class="li tap ${i % 2 ? 'alt' : ''} ${x.id === h.log.editing ? 'gold' : ''}" data-qso="${x.id}"><span class="row2"><span><b>${x.call}</b> ${d.toISOString().slice(0, 16).replace('T', ' ')}z · ${(x.freq / 1e6).toFixed(4)} ${x.mode}${x.rstS || x.rstR ? ` · ${x.rstS || '—'}/${x.rstR || '—'}` : ''}</span><span>${[x.name, x.qth, x.grid, x.country].filter(Boolean).join(' · ')} <button class="x" data-del="${x.id}" title="delete">✕</button></span></span></div>`; }).join('') : '<div class="empty">no contacts yet — work someone and LOG IT, or import an ADIF</div>';
    qa('[data-qso]', list).forEach(r => r.onclick = (ev) => { if (ev.target.dataset.del)
        return; logEdit(r.dataset.qso); });
    logMap();
    qa('[data-del]', list).forEach(b => b.onclick = (ev) => { ev.stopPropagation(); logDelete(b.dataset.del); });
}
function renderLogForm() {
    const h = state.ham, d = h.log.draft, set = (id, v) => { const i = q(id); if (i)
        i.value = v; };
    set('#q-call', d.call);
    set('#q-rsts', d.rstS || rstDefault(d.mode || logModeNow()));
    set('#q-rstr', d.rstR || rstDefault(d.mode || logModeNow()));
    set('#q-name', d.name);
    set('#q-qth', d.qth);
    set('#q-grid', d.grid);
    set('#q-notes', d.notes);
    const btn = q('#q-save');
    if (btn)
        btn.textContent = h.log.editing ? 'SAVE CHANGES' : 'LOG IT';
    const when = q('#log-when');
    if (when)
        when.textContent = h.log.editing ? 'editing an earlier contact' : `now · ${new Date().toISOString().slice(11, 16)}z · ${(h.freq / 1e6).toFixed(4)} MHz · ${d.mode || logModeNow()} · ${bandOfHz(h.freq) || 'out of band'}`;
    logRefreshInfo();
}
function renderLog(view, tabs) {
    const h = state.ham, s = h.station;
    view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <div class="hamline"><span id="ham-seg" class="seg"></span><span id="ham-tone" class="sq">—</span></div>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      <div class="caption">STATION · ${s.call ? `${s.call}${s.name ? ` · ${s.name}` : ''} · grid ${myGrid() || '?'}` : 'set your callsign and grid in Settings'}${s.license ? ` · ${s.license}` : ''}</div>
      <div class="caption">CONTACT · <span id="log-when"></span></div>
      <div class="row"><input id="q-call" class="txin" style="flex:2" placeholder="CALLSIGN" autocapitalize="characters" spellcheck="false" autocomplete="off"><button id="q-lookup" class="chip">LOOKUP</button><button id="q-qrz" class="chip">QRZ ↗</button></div>
      <div id="q-info" class="panel about small"></div>
      <div class="row"><input id="q-rsts" class="txin" placeholder="RST sent"><input id="q-rstr" class="txin" placeholder="RST rcvd"><input id="q-name" class="txin" style="flex:2" placeholder="name"></div>
      <div class="row"><input id="q-qth" class="txin" style="flex:2" placeholder="QTH"><input id="q-grid" class="txin" placeholder="grid" autocapitalize="characters"></div>
      <input id="q-notes" class="txin" placeholder="notes">
      <div class="row"><button id="q-save" class="chip primary" style="flex:2">LOG IT</button><button id="q-clear" class="chip">CLEAR</button></div>
      <div class="caption">LOGBOOK · <span id="log-stats"></span> · tap a contact to edit it</div><div id="log-list" class="panel list"></div>
      <div class="caption">MAP · contacts by grid square, the callsign you are looking up in gold</div><div id="log-map" class="panel map"></div>
      <div class="row bandstrip"><button id="log-export" class="chip">EXPORT ADIF</button><button id="log-import" class="chip">IMPORT ADIF</button><button id="log-csv" class="chip">EXPORT CSV</button><button id="log-wipe" class="chip">DELETE ALL</button></div>
      <input id="log-file" type="file" accept=".adi,.adif,.txt" hidden>
    </section>`;
    scope = attach(tunableScope('scope', 200));
    geo = new GeoMap($('log-map'), { home: myLatLon(), onPick: id => { if (id !== 'lookup')
            logEdit(id); }, log });
    qa('[data-hamtab]', view).forEach(b => b.onclick = () => { logDraftFromForm(); h.tab = b.dataset.hamtab; open('ham'); });
    const callIn = $('q-call');
    callIn.oninput = () => { callIn.value = callIn.value.toUpperCase(); h.log.info = null; logRefreshInfo(); };
    callIn.onkeydown = (e) => { if (e.key === 'Enter') {
        e.preventDefault();
        void logLookup();
    } };
    $('q-lookup').onclick = () => void logLookup();
    $('q-qrz').onclick = () => { const c = parseCall(callIn.value).base; if (c)
        window.open(`https://www.qrz.com/db/${c}`, '_blank', 'noopener'); };
    $('q-save').onclick = logSave;
    $('q-clear').onclick = () => { h.log.editing = ''; Object.assign(h.log.draft, { call: '', rstS: '', rstR: '', name: '', qth: '', grid: '', notes: '', mode: '' }); h.log.info = null; renderLogForm(); logRefreshList(); };
    $('log-export').onclick = () => download(`mayhem-log-${new Date().toISOString().slice(0, 10)}.adi`, toAdif(h.log.entries, s.call, myGrid()));
    $('log-csv').onclick = () => download(`mayhem-log-${new Date().toISOString().slice(0, 10)}.csv`, 'call,utc,freq_mhz,band,mode,rst_sent,rst_rcvd,name,qth,grid,country,notes\n' + h.log.entries.map(x => [x.call, new Date(x.ts).toISOString(), (x.freq / 1e6).toFixed(6), bandOfHz(x.freq), x.mode, x.rstS, x.rstR, x.name, x.qth, x.grid, x.country ?? '', x.notes].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n', 'text/csv');
    $('log-import').onclick = () => $('log-file').click();
    $('log-file').onchange = async (e) => { const f = e.target.files?.[0]; if (!f)
        return; const got = fromAdif(await f.text()); const have = new Set(h.log.entries.map(x => x.id)); let n = 0; for (const x of got)
        if (!have.has(x.id)) {
            h.log.entries.push(x);
            n++;
        } h.log.entries.sort((a, b) => b.ts - a.ts); saveLog(); logRefreshList(); log(`imported ${n} contacts from ${f.name}`); };
    $('log-wipe').onclick = () => { if (confirm(`Delete all ${h.log.entries.length} contacts? Export an ADIF first if you want to keep them.`)) {
        h.log.entries = [];
        saveLog();
        logRefreshList();
    } };
    renderLogForm();
    logRefreshList();
    refreshHamUi();
    if (h.log.draft.call && !h.log.info)
        void logLookup();
}
let micNode = null;
let micRing = null;
let micR = 0;
let micW = 0;
async function ensureMic() {
    if (micNode)
        return true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
        await ensureAudio();
        const ctx = audioCtx;
        await ctx.audioWorklet.addModule('./mic-worklet.js');
        const src = ctx.createMediaStreamSource(stream);
        micNode = new AudioWorkletNode(ctx, 'mayhem-mic', { numberOfOutputs: 0 });
        micRing = new Float32Array(48000 * 2);
        micR = 0;
        micW = 0;
        micNode.port.onmessage = (e) => { const a = e.data; for (let i = 0; i < a.length; i++) {
            micRing[micW] = a[i];
            micW = (micW + 1) % micRing.length;
        } };
        src.connect(micNode);
        return true;
    }
    catch (e) {
        log(`mic: ${e.message}`);
        return false;
    }
}
const micReader = { read: () => { if (!micRing || micR === micW)
        return 0; const v = micRing[micR]; micR = (micR + 1) % micRing.length; return v; } };
let pttButton = null;
function pttStart(freqHz, toneHz, button) {
    const h = state.ham;
    if (h.ptt.on)
        return;
    if (tx.needsPrompt) {
        showTxSafetyPrompt();
        return;
    }
    void ensureMic().then(ok => {
        if (!ok) {
            txStatus('no microphone');
            return;
        }
        micR = micW;
        const f = freqHz ?? (h.rev ? h.freq : (repeaterInput(h.freq) ?? h.freq));
        const tone = toneHz ?? h.ptt.tone;
        if (tx.fmVoice(f, h.ptt.dev, tone, micReader)) {
            h.ptt.on = true;
            pttButton = button ?? q('#ptt');
            if (pttButton) {
                pttButton.classList.add('on');
                pttButton.textContent = `TX ${(f / 1e6).toFixed(4)}${tone ? ` · ${tone.toFixed(1)} Hz` : ''}`;
            }
        }
    });
}
function pttStop() { const h = state.ham; if (!h.ptt.on)
    return; tx.stop(); h.ptt.on = false; const b = pttButton; if (b) {
    b.classList.remove('on');
    b.textContent = b.id === 'sat-ptt' ? 'PUSH TO TALK · UPLINK' : 'PUSH TO TALK';
} }
function renderPtt(view, tabs) {
    const h = state.ham, rin = repeaterInput(h.freq);
    view.innerHTML = `
    <section class="visual">${readoutHtml()}
      <div class="hamline"><span id="ham-seg" class="seg"></span><span id="ham-tone" class="sq">—</span></div>
      <div id="scope" class="panel"></div></section>
    <section class="controls">${tabs}
      <div class="caption">TX · ${rin !== null ? `repeater input ${(rin / 1e6).toFixed(4)} MHz (offset applied)` : 'simplex on the dial frequency'} · hold the button</div>
      <button id="ptt" class="chip ptt">PUSH TO TALK</button>
      <div id="tx-status" class="health">idle</div>
      <div class="caption">DEVIATION · CTCSS</div><div class="row bandstrip">${[2500, 5000].map(d => `<button class="chip" data-dev="${d}">±${d / 1000} kHz</button>`).join('')}${[0, 67.0, 71.9, 77.0, 88.5, 100.0, 103.5, 107.2, 114.8, 123.0, 131.8, 141.3, 151.4, 162.2, 173.8, 186.2, 203.5].map(t => `<button class="chip" data-tone="${t}">${t ? t.toFixed(1) : 'no tone'}</button>`).join('')}</div>
      <div class="caption">TX GAIN · IF 0–47 dB · AMP +14 dB</div><div class="row">${[0, 10, 20, 30, 47].map(g => `<button class="chip" data-txg="${g}">${g}</button>`).join('')}<button id="tx-amp" class="chip">amp</button></div>
      <div class="caption">BAND</div><div class="row bandstrip">${[...BANDS, ...NON_HAM].map(b => `<button class="chip" data-band="${b.id}">${b.name}</button>`).join('')}</div>
      <div class="caption">MODE (receive between overs)</div><div class="row">${['NFM', 'USB', 'LSB'].map(m => `<button class="chip" data-hmode="${m}">${m}</button>`).join('')}</div>
      <div class="caption">TUNE</div><div id="ham-steps" class="row"></div>
    </section>`;
    scope = attach(tunableScope('scope', 200));
    qa('[data-hamtab]', view).forEach(b => b.onclick = () => { pttStop(); h.tab = b.dataset.hamtab; open('ham'); });
    qa('[data-band]', view).forEach(b => b.onclick = () => { const band = [...BANDS, ...NON_HAM].find(x => x.id === b.dataset.band); if (band.mode !== h.mode)
        hamSetMode(band.mode); hamTune(band.calling ?? band.lo); render('ham'); });
    qa('[data-hmode]', view).forEach(b => b.onclick = () => hamSetMode(b.dataset.hmode));
    qa('[data-dev]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.dev) === h.ptt.dev); b.onclick = () => { h.ptt.dev = Number(b.dataset.dev); qa('[data-dev]').forEach(x => x.classList.toggle('on', x === b)); }; });
    qa('[data-tone]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.tone) === h.ptt.tone); b.onclick = () => { h.ptt.tone = Number(b.dataset.tone); qa('[data-tone]').forEach(x => x.classList.toggle('on', x === b)); }; });
    qa('[data-txg]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.txg) === tx.gain); b.onclick = () => { tx.gain = Number(b.dataset.txg); qa('[data-txg]').forEach(x => x.classList.toggle('on', x === b)); }; });
    const ampb = $('tx-amp');
    ampb.classList.toggle('on', tx.amp);
    ampb.onclick = () => { tx.amp = !tx.amp; ampb.classList.toggle('on', tx.amp); };
    const ptt = $('ptt');
    ptt.onpointerdown = (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); pttStart(); };
    ptt.onpointerup = ptt.onpointercancel = () => pttStop();
    ptt.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        pttStart();
    } };
    ptt.onkeyup = (e) => { if (e.key === ' ' || e.key === 'Enter')
        pttStop(); };
    if (tx.needsPrompt)
        showTxSafetyPrompt();
    refreshHamUi();
}
async function portapackToHackRf() {
    const serial = navigator.serial;
    if (!serial) {
        log('PortaPack: this browser has no Web Serial — tap HackRF mode on the PortaPack instead.');
        return false;
    }
    try {
        const port = await serial.requestPort({ filters: [{ usbVendorId: 0x1d50, usbProductId: 0x6018 }] });
        await port.open({ baudRate: 115200 });
        const w = port.writable.getWriter();
        await w.write(new TextEncoder().encode('hackrf\r\n'));
        w.releaseLock();
        await port.close().catch(() => undefined);
        log('PortaPack: sent "hackrf" — it is rebooting into HackRF mode; tap CONNECT again in a few seconds.');
        setStatus('PortaPack switching to HackRF mode… tap CONNECT in 5 s', false);
        return true;
    }
    catch (e) {
        log(`PortaPack switch: ${e.message}`);
        return false;
    }
}
function renderAudio(view) {
    view.innerHTML = `
    <section class="visual"><div id="same-alert" class="samealert" hidden></div>${readoutHtml()}<div id="scope" class="panel"></div></section>
    <section class="controls">
      <div class="caption">MODE</div><div class="row">${['WFM', 'NFM', 'AM', 'USB', 'LSB'].map(m => `<button class="chip" data-mode="${m}">${m}</button>`).join('')}<button class="chip" id="rds-toggle">RDS</button><button class="chip" id="hd-toggle" title="look for an HD Radio digital signal beside this station">HD</button></div>
      ${stepHtml([1e6, 1e5, 1e4])}
      ${presetHtml('PRESETS', [['FM 92.3', 92300000, 'WFM'], ['AIR 121.5', 121500000, 'AM'], ['NOAA 162.4', 162400000, 'NFM'], ['ISM 433.92', 433920000, 'NFM']])}
      <div class="caption">BANDS</div><div class="row wrap bandrow">${bandChipsHtml()}</div>
      <div class="caption">SQUELCH · dB above the noise floor</div><div class="row">${[0, 6, 12, 20].map(d => `<button class="chip" data-sql="${d}">${d ? `${d} dB` : 'OFF'}</button>`).join('')}</div>
      ${gainHtml()}
      <div class="countrow"><span class="count">BOOKMARKS</span><span><button id="save-bm" class="link">★ SAVE</button><button id="scan" class="link">⟳ SCAN</button></span></div>
      <div id="bookmarks" class="wrap"></div>
    </section>`;
    scope = attach(tunableScope('scope', 200));
    const rdsEl = document.createElement('div');
    rdsEl.id = 'rds';
    rdsEl.className = 'rdsbar';
    rdsEl.hidden = true;
    $('scope').appendChild(rdsEl);
    qa('[data-sql]', view).forEach(b => b.onclick = () => setSquelch(Number(b.dataset.sql)));
    setSquelch(state.squelch);
    $('save-bm').onclick = addBookmark;
    $('scan').onclick = () => setScanning(!state.scanning);
    $('scan').classList.toggle('on', state.scanning);
    $('rds-toggle').onclick = () => { rdsWanted = !rdsWanted; if (!rdsWanted)
        lastRds = null; sendRds(); drawRds(); };
    const hdEl = document.createElement('div');
    hdEl.id = 'hd';
    hdEl.className = 'hdbadge';
    hdEl.hidden = true;
    $('scope').appendChild(hdEl);
    $('hd-toggle').onclick = () => { hdWanted = !hdWanted; if (!hdWanted)
        lastHd = null; sendHd(); drawHd(); };
    refreshBookmarks();
    refreshSquelch();
    sendRds();
    drawRds();
    sendHd();
    drawHd();
}
let hdWanted = false;
let lastHd = null;
function sendHd() { worker?.postMessage({ type: 'hd', on: hdWanted }); }
function drawHd() {
    const t = q('#hd-toggle');
    if (t)
        t.classList.toggle('on', hdWanted);
    const el = q('#hd');
    if (!el)
        return;
    if (!hdWanted || state.mode !== 'WFM') {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    if (!lastHd) {
        el.className = 'hdbadge';
        el.textContent = 'HD · listening…';
        return;
    }
    const r = lastHd;
    el.className = 'hdbadge' + (r.present ? ' on' : '');
    const cfo = r.present && Number.isFinite(r.cfoHz) ? ` · ${r.cfoHz >= 0 ? '+' : ''}${r.cfoHz.toFixed(0)} Hz` : '';
    el.textContent = r.present ? `HD ◉ ${r.snrDb.toFixed(0)} dB · lock ${r.lock.toFixed(1)}${cfo}` : `HD · none (${r.snrDb.toFixed(0)} dB · lock ${r.lock.toFixed(2)})`;
}
function onSameAlert(m) {
    const el = q('#same-alert');
    if (!el)
        return;
    if (m.event === 'eom') {
        el.hidden = true;
        return;
    }
    if (m.event !== 'header' || !m.header)
        return;
    const h = m.header;
    const dur = h.duration.hours || h.duration.minutes ? ` · ${h.duration.hours ? h.duration.hours + 'h' : ''}${h.duration.minutes ? h.duration.minutes + 'm' : ''}` : '';
    const areas = h.locations.length ? ` · ${h.locations.length} area${h.locations.length === 1 ? '' : 's'}` : '';
    el.textContent = `⚠ ${h.eventName.toUpperCase()} · ${h.originatorName}${areas}${dur}${h.callsign ? ' · ' + h.callsign : ''}   ✕`;
    el.hidden = false;
    el.onclick = () => { el.hidden = true; };
    log(`SAME: ${h.eventName} from ${h.callsign}`);
}
let rdsWanted = true;
let lastRds = null;
function sendRds() { worker?.postMessage({ type: 'rds', on: rdsWanted }); }
let rdsAnim = null;
let rdsShownKey = '';
let rdsAnimLw = 0;
function drawRds() {
    const t = q('#rds-toggle');
    if (t)
        t.classList.toggle('on', rdsWanted);
    const el = q('#rds');
    if (!el)
        return;
    if (!rdsWanted || state.mode !== 'WFM' || !lastRds) {
        el.hidden = true;
        el.classList.remove('ticker');
        rdsAnim?.cancel();
        rdsAnim = null;
        rdsShownKey = '';
        return;
    }
    el.hidden = false;
    el.classList.toggle('dim', !lastRds.synced);
    const r = lastRds;
    const pty = r.ptyName && r.ptyName !== 'None' ? r.ptyName : '';
    const pi = r.pi != null ? r.pi.toString(16).toUpperCase().padStart(4, '0') : '';
    const fields = [];
    if (r.ps.trim())
        fields.push(['', r.ps.trim()]);
    if (pty)
        fields.push(['', pty]);
    if (pi)
        fields.push(['PI', pi]);
    if (r.rt.trim())
        fields.push(['', r.rt.trim()]);
    const key = fields.map(f => f.join(':')).join('|') + (r.synced ? '#s' : '#-');
    if (key === rdsShownKey)
        return;
    rdsShownKey = key;
    const body = fields.length
        ? fields.map(([k, v]) => `${k ? `<i>${esc(k)}</i>` : ''}<b>${esc(v)}</b>`).join('<em>·</em>')
        : `<b>${r.synced ? 'RDS · reading…' : 'RDS · listening…'}</b>`;
    let line = el.querySelector('.rdsline');
    if (!line) {
        el.innerHTML = '<span class="rdsline"></span>';
        line = el.firstElementChild;
        rdsAnim?.cancel();
        rdsAnim = null;
    }
    line.innerHTML = body;
    const node = line;
    requestAnimationFrame(() => {
        if (!node.isConnected || el.hidden)
            return;
        const cw = el.clientWidth, lw = node.scrollWidth;
        if (lw <= cw) {
            el.classList.remove('ticker');
            rdsAnim?.cancel();
            rdsAnim = null;
            return;
        }
        el.classList.add('ticker');
        if (!rdsAnim || Math.abs(lw - rdsAnimLw) > 24) {
            rdsAnim?.cancel();
            rdsAnim = node.animate([{ transform: `translateX(${cw}px)` }, { transform: `translateX(${-lw}px)` }], { duration: (cw + lw) / 90 * 1000, iterations: Infinity });
            rdsAnimLw = lw;
        }
    });
}
const R433_BANDS = [
    ['433.92', 433920000],
    ['315.00', 315000000],
    ['345.00', 345000000],
    ['310.00', 310000000],
    ['318.00', 318000000],
    ['303.875', 303875000],
    ['868.30', 868300000],
    ['912.60', 912600000],
    ['915.00', 915000000],
];
const R433_DWELL_MS = 20000;
let r433Timer = 0;
const R433_UNITS = {
    temperature_C: ' °C', temperature_1_C: ' °C', temperature_F: ' °F',
    humidity: ' %', humidity_1: ' %', moisture: ' %',
    pressure_hPa: ' hPa', pressure_kPa: ' kPa', pressure_PSI: ' PSI',
    wind_avg_km_h: ' km/h', wind_max_km_h: ' km/h', wind_avg_m_s: ' m/s', wind_max_m_s: ' m/s',
    wind_avg_mi_h: ' mph', wind_dir_deg: '°',
    rain_mm: ' mm', rain_in: ' in', light_lux: ' lux', battery_mV: ' mV',
    pm2_5_ug_m3: ' µg/m³', estimated_pm10_0_ug_m3: ' µg/m³',
    storm_dist: ' km', strike_distance: ' mi',
};
const R433_SUMMARY = ['temperature_C', 'temperature_F', 'humidity', 'pressure_hPa', 'pressure_PSI', 'pressure_kPa',
    'moisture', 'rain_mm', 'rain_in', 'wind_avg_km_h', 'wind_avg_mi_h', 'wind_avg_m_s', 'leak_detected',
    'strike_count', 'pm2_5_ug_m3', 'light_lux'];
const R433_HIDDEN = new Set(['model', 'id', 'channel', 'subtype', 'type', 'mic', 'exception', 'message_type',
    'sequence_num', 'unknown1', 'family', 'raw', 'raw_msg', 'protocol', 'code']);
const R433_MEANING = {
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
function r433Value(k, v) {
    if (k === 'battery_ok')
        return v === 1 || v === true ? 'battery ok' : typeof v === 'number' && v > 0 && v < 1 ? `battery ${Math.round(v * 100)}%` : 'BATTERY LOW';
    if (k === 'leak_detected')
        return v ? 'WET' : 'dry';
    return `${v}${R433_UNITS[k] ?? ''}`;
}
function r433Summary(d) {
    const parts = [];
    for (const k of R433_SUMMARY) {
        if (d[k] === undefined)
            continue;
        parts.push(r433Value(k, d[k]));
        if (parts.length === 3)
            break;
    }
    if (!parts.length) {
        for (const [k, v] of Object.entries(d)) {
            if (R433_HIDDEN.has(k) || parts.length === 3)
                continue;
            parts.push(`${k.replace(/_/g, ' ')} ${r433Value(k, v)}`);
        }
    }
    return parts.join(' · ');
}
function renderR433(view) {
    view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      <div class="caption">BAND &middot; MHz &middot; 433.92 carries most of the protocol set; the American four are spread over 14 MHz, wider than one span, so hearing them all means visiting each in turn</div>
      <div class="row wrap">${R433_BANDS.map(([l, hz]) => `<button class="chip" data-preset="${hz}">${l}</button>`).join('')}</div>
      ${stepHtml([1e6, 1e5, 1e4])}
      <div class="caption">LISTEN ACROSS &middot; narrower hears weaker devices, wider finds ones off the dial</div>
      <div class="row">${[['250 kHz', 250000], ['500 kHz', 500000], ['1 MHz', 1000000], ['2 MHz', 2000000]]
        .map(([l, hz]) => `<button class="chip" data-span="${hz}">${l}</button>`).join('')}<button id="r433-hop" class="chip">HOP OFF</button></div>
      <div id="r433-stats" class="health">listening&hellip;</div>
      <div class="countrow"><span class="count" id="r433-count">0 DEVICES</span><span class="row"><button class="chip" id="r433-ptoggle">PROTOCOLS</button><button class="chip" id="pause-devices">PAUSE</button><button class="chip" id="clear-devices">CLEAR</button></span></div>
      <div id="r433-list" class="panel devtable"></div>
      <div id="r433-protocols" class="panel devtable" hidden></div>
      <div class="gainwrap">${gainHtml()}</div>
    </section>`;
    scope = attach(tunableScope('scope', 80, 70));
    qa('[data-span]', view).forEach(b => {
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
    hop.textContent = state.r433.hop ? 'HOP ON' : 'HOP OFF';
    hop.onclick = () => { state.r433.hop = !state.r433.hop; r433Hop(); render('devices'); };
    r433Hop();
    drawR433();
}
function r433Hop() {
    clearInterval(r433Timer);
    r433Timer = 0;
    if (!state.r433.hop || state.app !== 'devices')
        return;
    r433Timer = window.setInterval(() => {
        if (state.app !== 'devices') {
            clearInterval(r433Timer);
            r433Timer = 0;
            return;
        }
        state.r433.band = (state.r433.band + 1) % R433_BANDS.length;
        tune(R433_BANDS[state.r433.band][1]);
        refreshR433();
    }, R433_DWELL_MS);
}
let r433Pending = 0;
function refreshR433() {
    if (r433Pending)
        return;
    r433Pending = window.setTimeout(() => { r433Pending = 0; drawR433(); }, 250);
}
function r433Clock(t) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
const R433_LONG = new Set(['raw', 'raw_msg', 'code', 'summary', 'DifferentialConsumptionIntervals']);
function r433Detail(d, doubtful) {
    const entries = Object.entries(d.data).filter(([k]) => k !== 'model');
    const shape = d.shape;
    const fields = entries.filter(([k]) => !R433_LONG.has(k)).map(([k, v]) => {
        const speaks = k === 'battery_ok' || k === 'leak_detected';
        const label = speaks ? '' : `<b>${esc(k.replace(/_/g, ' '))}</b> `;
        return `<span${R433_MEANING[k] ? ` title="${esc(R433_MEANING[k])}"` : ''}>${label}${esc(r433Value(k, v))}</span>`;
    }).join('');
    const note = d.num === 0
        ? `<span class="warn" title="no protocol in the set recognized this transmission — most likely a device this port does not cover yet, possibly interference that keyed hard enough to look deliberate">nothing claimed this${shape && shape.coding ? ` — timings look like ${esc(shape.coding)}` : ' — the timings do not settle how the bits are carried'}</span>`
        : doubtful
            ? '<span class="warn" title="rtl_433 ships this protocol switched off for exactly this reason; an implausible reading from it is almost certainly another device’s transmission being misread">no checksum — nothing in the frame proves this reading</span>'
            : '';
    const marks = shape
        ? `<div class="r433-raw"><b>marks</b> ${shape.mark.map(c => `${c.us} µs ×${c.n}`).join(' · ') || 'none recurring'}   <b>gaps</b> ${shape.space.map(c => `${c.us} µs ×${c.n}`).join(' · ') || 'none recurring'}</div>`
        : '';
    const long = entries.filter(([k]) => R433_LONG.has(k) && k !== 'summary').map(([k, v]) => `<div class="r433-raw"${R433_MEANING[k] ? ` title="${esc(R433_MEANING[k])}"` : ''}><b>${esc(k.replace(/_/g, ' '))}</b> ${esc(String(v))}</div>`).join('');
    return `<div class="devdetail"><div class="devfields">${fields}<span class="faint">${esc(d.what)}${d.num ? ` · rtl_433 protocol ${d.num}` : ''} · first heard ${r433Clock(d.firstSeen)}</span>${note}</div>${marks}${long}</div>`;
}
function drawR433() {
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
    if (c) {
        c.textContent = r.showProtocols
            ? `${r.protocols.length} PROTOCOLS · ALL RUNNING`
            : `${named} DEVICE${named === 1 ? '' : 'S'}${r.heard.length > named ? ` · ${r.heard.length - named} UNKNOWN` : ''}`;
    }
    drawR433Protocols();
    const el = q('#r433-list');
    if (!el)
        return;
    el.hidden = r.showProtocols;
    if (r.showProtocols || paused.has('devices'))
        return;
    if (!r.heard.length) {
        el.innerHTML = '<div class="empty">nothing yet — most of these report every thirty to sixty seconds, so give it a minute</div>';
        return;
    }
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
function drawR433Protocols() {
    const r = state.r433;
    const tog = q('#r433-ptoggle');
    if (tog) {
        tog.textContent = r.showProtocols ? 'DEVICES' : `PROTOCOLS${r.protocols.length ? ` ${r.protocols.length}` : ''}`;
        tog.classList.toggle('on', r.showProtocols);
    }
    const el = q('#r433-protocols');
    if (!el)
        return;
    el.hidden = !r.showProtocols;
    if (!r.showProtocols)
        return;
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
function renderPacket(view, app) {
    let controls = '';
    switch (app) {
        case 'pager':
            controls = `<div class="caption">DECODER · FLEX 1600/3200 2L/4L · POCSAG 512/1200/2400</div><div class="row">${['flex', 'pocsag', 'both'].map(w => `<button class="chip" data-pager="${w}">${w === 'both' ? 'FLEX + POCSAG' : w.toUpperCase()}</button>`).join('')}</div>` + presetHtml('CHANNEL · MHz', [['929.6125', 929612500], ['929.6625', 929662500], ['931.9375', 931937500], ['466.175', 466175000]]) + stepHtml([1e5, 12500, 2500]);
            break;
        case 'ert':
            controls = presetHtml('CENTER · MHz', [['911.6', 911600000], ['915.0', 915000000], ['920.0', 920000000]]) + `<div class="caption">IQ RATE</div><div class="row"><button class="chip" data-rate="2000000">2.0 Msps</button><button class="chip" data-rate="4194304">4.194 Msps · Mayhem</button></div>`;
            break;
        case 'tpms':
            controls = presetHtml('BAND · MHz', [['315.000 · US', 315000000], ['433.920 · EU', 433920000]]) + `<div class="caption">DECODES · FSK 19.2k Schrader FLM 64/72/80 · OOK 8.192k Schrader · OOK 8.4k GMC — readings repeat every minute or so</div>`;
            break;
        case 'acars':
            controls = presetHtml('CHANNEL · MHz', [['131.550 US', 131550000], ['131.525 EU', 131525000], ['131.725 EU2', 131725000], ['131.450 JP', 131450000], ['130.025', 130025000]]) + stepHtml([1e6, 25000, 5000]) + `<div class="caption">AM · 2400 bps MSK · registration, label, block, message number, flight, text · CRC-16 checked</div>`;
            break;
        case 'subghz':
            controls = presetHtml('BAND · MHz', [['433.92', 433920000], ['315.00', 315000000], ['868.35', 868350000], ['915.00', 915000000], ['303.875', 303875000]]) + stepHtml([1e6, 1e5, 1e4]) + `<div class="caption">FAMILIES · every protocol runs at once; tap to mute a family</div><div class="row">${['weather', 'remotes', 'cars'].map(f => `<button class="chip" data-ism="${f}">${f === 'weather' ? 'WEATHER 26' : f === 'remotes' ? 'REMOTES 47' : 'CAR KEYS 11'}</button>`).join('')}</div>`;
            break;
        case 'btle':
            controls = `<div class="caption">ADVERTISING CHANNEL</div><div class="row">${[37, 38, 39].map(ch => `<button class="chip" data-btle="${ch}">CH ${ch} · ${btleChannelFreq(ch) / 1e6}</button>`).join('')}</div>`;
            break;
    }
    view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">${controls}${gainHtml()}${logHtml(app, 'listening…')}</section>`;
    scope = attach(app === 'btle' ? new Scope($('scope'), 0, { rows: 80, spectrumHeight: 70 }) : tunableScope('scope', 80, 70));
    qa('[data-ism]', view).forEach(b => { const f = b.dataset.ism; b.classList.toggle('on', state.ism[f]); b.onclick = () => { state.ism[f] = !state.ism[f]; b.classList.toggle('on', state.ism[f]); worker?.postMessage({ type: 'ismFamilies', ...state.ism }); }; });
    qa('[data-pager]', view).forEach(b => { b.classList.toggle('on', b.dataset.pager === state.pager); b.onclick = () => { state.pager = b.dataset.pager; worker?.postMessage({ type: 'pager', which: state.pager }); qa('[data-pager]').forEach(x => x.classList.toggle('on', x === b)); }; });
    qa('[data-btle]', view).forEach(b => b.onclick = () => { state.btleCh = Number(b.dataset.btle); worker?.postMessage({ type: 'btleChannel', ch: state.btleCh }); tune(btleChannelFreq(state.btleCh)); refreshBtle(); });
    refreshList(app);
    refreshAis();
    refreshBtle();
}
function geoHeadHtml(id, glyphText, views) {
    return `<div class="countrow"><span id="${id}-count" class="count">${glyphText}</span><span class="row">${views.map(v => `<button class="chip" data-${id}view="${v}">${v.toUpperCase()}</button>`).join('')}<button class="link" id="pause-${id}">PAUSE</button><button class="link" id="clear-${id}">CLEAR</button></span></div>`;
}
function renderAdsb(view) {
    view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${geoHeadHtml('adsb', `✈ ${state.frames} FRAMES · ${state.aircraft.length} AIRCRAFT`, ['map', 'list'])}
      <div id="adsb-card" class="accard" hidden></div>
      <div id="adsb-map" class="panel map"></div>
      <div id="adsb-list" class="panel list"></div>
      ${gainHtml()}</section>`;
    scope = attach(new Scope($('scope'), 0, { rows: 80, spectrumHeight: 70 }));
    qa('[data-adsbview]', view).forEach(b => b.onclick = () => { state.adsbView = b.dataset.adsbview; refreshAdsb(); });
    geo = new GeoMap($('adsb-map'), { home: state.home, onPick: id => { state.adsbSel = id; refreshAdsb(); }, onFollow: on => { state.adsbFollow = on; }, log });
    geo.setFollow(state.adsbFollow);
    refreshAdsb();
}
function renderAis(view) {
    view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${geoHeadHtml('ais', '⚓ 0 PACKETS · 0 VESSELS', ['map', 'list', 'log'])}
      <div id="ais-card" class="accard" hidden></div>
      <div id="ais-map" class="panel map"></div>
      <div id="ais-list" class="panel list"></div>
      <div id="ais-log">${listHtml('ais', 'listening on the AIS channel…')}</div>
      ${presetHtml('CHANNEL', [['AIS A 161.975', 161975000], ['AIS B 162.025', 162025000]])}${gainHtml()}</section>`;
    scope = attach(tunableScope('scope', 80, 70));
    qa('[data-aisview]', view).forEach(b => b.onclick = () => { state.aisView = b.dataset.aisview; refreshAis(); });
    q('#list-ais')?.addEventListener('click', (e) => { const li = e.target.closest('.li'); const mm = li?.textContent?.match(/MMSI (\d+)/); if (mm) {
        state.aisSel = Number(mm[1]);
        refreshAis();
    } });
    geo = new GeoMap($('ais-map'), { home: state.home, onPick: id => { state.aisSel = Number(id); refreshAis(); }, log });
    refreshAis();
}
function renderAprs(view) {
    view.innerHTML = `
    <section class="visual">${readoutHtml()}<div id="scope" class="panel short"></div></section>
    <section class="controls">
      ${geoHeadHtml('aprs', '📡 0 PACKETS · 0 STATIONS', ['map', 'list', 'log'])}
      <div id="aprs-card" class="accard" hidden></div>
      <div id="aprs-map" class="panel map"></div>
      <div id="aprs-list" class="panel list"></div>
      <div id="aprs-log">${listHtml('aprs', 'listening on the APRS frequency…')}</div>
      ${presetHtml('REGION', [['NA 144.39', 144390000], ['EU 144.80', 144800000], ['AU 145.175', 145175000], ['JP 144.64', 144640000]])}${gainHtml()}</section>`;
    scope = attach(tunableScope('scope', 80, 70));
    qa('[data-aprsview]', view).forEach(b => b.onclick = () => { state.aprsView = b.dataset.aprsview; refreshAprs(); });
    q('#list-aprs')?.addEventListener('click', (e) => { const li = e.target.closest('.li'); const mm = li?.textContent?.match(/^([A-Za-z0-9-]+)>/); if (mm) {
        state.aprsSel = mm[1];
        refreshAprs();
    } });
    geo = new GeoMap($('aprs-map'), { home: state.home, onPick: id => { state.aprsSel = id; refreshAprs(); }, log });
    refreshAprs();
}
function renderSweep(view, app) {
    const search = app === 'search';
    view.innerHTML = `
    <section class="visual"><div id="sweep-title" class="count center">${sweepTitle(0, 0)}</div><div id="sweep-scope" class="panel ${search ? 'short' : ''}"></div></section>
    <section class="controls">
      ${search ? `<div class="caption">THRESHOLD · above noise floor</div><div class="row">${[10, 15, 20, 30].map(t => `<button class="chip" data-thr="${t}">+${t} dB</button>`).join('')}</div>` : ''}
      <div class="caption">RANGE · wider spans sweep slower</div><div class="row">${RANGES.slice(0, 4).map(([l, a, b]) => `<button class="chip" data-range="${a}" data-end="${b}">${l}</button>`).join('')}</div>
      <div class="row" style="margin-top:4px">${RANGES.slice(4, 8).map(([l, a, b]) => `<button class="chip" data-range="${a}" data-end="${b}">${l}</button>`).join('')}</div>
      <div class="row" style="margin-top:4px">${RANGES.slice(8).map(([l, a, b]) => `<button class="chip" data-range="${a}" data-end="${b}">${l}</button>`).join('')}<button class="chip" id="sweep-full">FULL · 1M–6G</button></div>
      <div class="caption">SLICE WIDTH · wider = faster</div><div class="row">${[2e6, 4e6, 8e6, 16e6].map(r => `<button class="chip" data-slice="${r}">${r / 1e6} MHz</button>`).join('')}</div>
      ${gainHtml()}
      ${search ? `<div class="caption">HITS · tap to listen</div><div id="hits" class="panel list"><div class="empty">sweeping… hits appear after the first full pass</div></div>` : ''}
    </section>`;
    const sweepLabel = (f) => { const s = state.sweep; return s ? ((s.start + (s.end - s.start) * f) / 1e6).toFixed(3) : ''; };
    sweepScope = new Scope($('sweep-scope'), 0, { rows: search ? 140 : 300, center: false, spectrumHeight: search ? 60 : 90, rowPx: 2, labelAt: sweepLabel, onTap: search ? undefined : f => { const s = state.sweep; if (s) {
            const hz = s.start + (s.end - s.start) * f;
            listen(hz, hz > 87e6 && hz < 108e6 ? 'WFM' : 'NFM');
        } },
        onPreview: search ? undefined : f => { const t = q('#sweep-title'), s = state.sweep; if (!t || !s)
            return; if (f === null) {
            t.classList.remove('preview');
            t.textContent = sweepTitle(0, 0);
        }
        else {
            t.classList.add('preview');
            t.textContent = `LISTEN ${((s.start + (s.end - s.start) * f) / 1e6).toFixed(3)} MHz — lift to tune`;
        } } });
    qa('[data-range]', view).forEach(b => b.onclick = () => startSweep(Number(b.dataset.range), Number(b.dataset.end)));
    const full = q('#sweep-full');
    if (full)
        full.onclick = () => startSweep(radio?.limits.minHz ?? 1e6, radio?.limits.maxHz ?? 6e9);
    qa('[data-slice]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.slice) === state.sweepRate); b.onclick = () => { state.sweepRate = Number(b.dataset.slice); qa('[data-slice]').forEach(x => x.classList.toggle('on', x === b)); const s = state.sweep; if (s)
        startSweep(s.start, s.end); }; });
    qa('[data-thr]', view).forEach(b => { b.classList.toggle('on', Number(b.dataset.thr) === state.threshold); b.onclick = () => { state.threshold = Number(b.dataset.thr); qa('[data-thr]').forEach(x => x.classList.toggle('on', x === b)); refreshHits(); }; });
}
function txStatus(s) { const e = q('#tx-status'); if (e)
    e.textContent = s; const stop = q('#tx-stop'); if (stop)
    stop.hidden = !tx.active; }
const CART_SOUNDS = {
    gatekeeper: { lock: 'assets/cart/GateKeeperCartKeyLock78.wav', unlock: 'assets/cart/unlock-cart.wav' },
    rocateq: { lock: 'assets/cart/roca-lock.mp3', unlock: 'assets/cart/roca-unlock.mp3', arm: 'assets/cart/roca-armingsignal-17s.mp3', purchase: 'assets/cart/roca-purcheck-ok.mp3' },
};
let cartAudioEl = null;
function cartSound(brand, action) {
    try {
        if (cartAudioEl) {
            cartAudioEl.pause();
            cartAudioEl.currentTime = 0;
        }
        const a = cartAudioEl = new Audio(CART_SOUNDS[brand][action]);
        a.volume = 1;
        void a.play().catch(e => log(`cart audio: ${e.message}`));
        setStatus(`cart · ${brand} ${action} · through the speaker`, false);
    }
    catch (e) {
        log(`cart audio: ${e.message}`);
    }
}
function renderTroll(view) {
    tx.onStatus = txStatus;
    if (!tx.enabled) {
        view.innerHTML = `<div class="notice tx-off"><b>Transmit is switched off in Settings.</b> Most Troll tricks transmit, so turn it back on there — the shopping-cart one is phone audio and works regardless.<div class="row" style="margin-top:10px"><button id="tx-settings" class="chip">OPEN SETTINGS</button><button id="tr-cart-only" class="chip">CART · UNLOCK</button></div></div>`;
        $('tx-settings').onclick = () => open('settings');
        $('tr-cart-only').onclick = () => cartSound('gatekeeper', 'unlock');
        return;
    }
    if (tx.needsPrompt)
        showTxSafetyPrompt();
    view.innerHTML = `
    <section class="visual">${readoutHtml()}</section>
    <section class="controls trollctl">
      <div class="trollintro">Everything here <b>transmits</b> unless noted — use a dummy load or an antenna you are allowed to key. Some of these are regulated on air where you live. Harmless fun, your call.</div>
      ${stepHtml([1e6, 1e5, 1e4])}
      <div class="trollgain"><span class="trolllabel">TX&nbsp;GAIN</span><div class="row">${[0, 10, 20, 30, 47].map(g => `<button class="chip" data-txg="${g}">${g}</button>`).join('')}<button id="tx-amp" class="chip">amp</button></div></div>

      <div class="trollcard sub">
        <div class="trollhead"><span class="ico">📡</span><b>ON THE DIAL</b><small>fires on the frequency tuned above</small></div>
        <div class="trollsub">Band <em>sub-GHz</em></div>
        <div class="trollgrid band">${[['433.92', 433920000], ['315.00', 315000000], ['868.35', 868350000], ['915.00', 915000000]].map(([l, hz]) => `<button class="chip" data-preset="${hz}">${l}</button>`).join('')}</div>
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
    const setg = () => qa('[data-txg]').forEach(b => b.classList.toggle('on', Number(b.dataset.txg) === tx.gain));
    qa('[data-txg]', view).forEach(b => b.onclick = () => { tx.gain = Number(b.dataset.txg); setg(); });
    setg();
    const ampb = $('tx-amp');
    ampb.classList.toggle('on', tx.amp);
    ampb.textContent = tx.amp ? 'AMP' : 'amp';
    ampb.onclick = () => { tx.amp = !tx.amp; ampb.classList.toggle('on', tx.amp); ampb.textContent = tx.amp ? 'AMP' : 'amp'; };
    const ctl = view.querySelector('.trollctl');
    const runStrip = document.createElement('div');
    runStrip.className = 'trollrun';
    runStrip.hidden = true;
    runStrip.innerHTML = '<span class="health" id="tx-status">TX running</span><button id="tx-stop" class="chip rec">■ STOP</button>';
    ctl.appendChild(runStrip);
    $('tx-stop').onclick = () => tx.stop();
    let activeCard = null;
    ctl.addEventListener('click', (e) => { const c = e.target.closest('.trollcard'); if (c)
        activeCard = c; }, true);
    tx.onStatus = (s) => {
        const st = q('#tx-status');
        if (st)
            st.textContent = s;
        if (tx.active) {
            (activeCard ?? ctl).appendChild(runStrip);
            runStrip.hidden = false;
        }
        else
            runStrip.hidden = true;
    };
    $('tr-tesla-us').onclick = () => { tune(315000000); tx.teslaChargePort(315000000); };
    $('tr-tesla-eu').onclick = () => { tune(433920000); tx.teslaChargePort(433920000); };
    $('tr-doorbell').onclick = () => tx.ookPrinceton(state.freq, 0x1A2B3C, 24, 350, 12);
    $('tr-outlet').onclick = () => tx.ookPrinceton(state.freq, 0x145591, 24, 320, 10);
    $('tr-fan').onclick = () => tx.ookPrinceton(state.freq, 0x0AAA55, 24, 380, 10);
    $('tr-walk').onclick = () => tx.ookBrute(24, 0x000000, 0x0000FF, 350, state.freq);
    $('tr-gate').onclick = () => tx.gateOpener(12, 350, state.freq);
    $('tr-noise').onclick = () => tx.ookNoise(100, 3, state.freq);
    let reps = 3;
    $('tr-repm').onclick = () => { reps = Math.max(1, reps - 1); $('tr-rep').textContent = `×${reps}`; };
    $('tr-repp').onclick = () => { reps = Math.min(20, reps + 1); $('tr-rep').textContent = `×${reps}`; };
    $('tr-subsend').onclick = () => tx.subghzReplay($('tr-sub').value, state.freq, reps);
    $('tr-wx').onclick = () => { tune(433920000); const t = parseFloat($('tr-wx-temp').value); const h = $('tr-wx-hum').value.trim(); tx.weatherSpoof(isNaN(t) ? 20 : t, h === '' ? undefined : parseInt(h, 10), 433920000); };
    qa('[data-tune]', view).forEach(b => b.onclick = () => tx.jingle(b.dataset.tune, state.freq));
    $('tr-morsesend').onclick = () => tx.morse($('tr-morse').value, 20, state.freq, true);
    $('tr-gk-lock').onclick = () => cartSound('gatekeeper', 'lock');
    $('tr-gk-unlock').onclick = () => cartSound('gatekeeper', 'unlock');
    $('tr-rc-lock').onclick = () => cartSound('rocateq', 'lock');
    $('tr-rc-unlock').onclick = () => cartSound('rocateq', 'unlock');
    $('tr-rc-arm').onclick = () => cartSound('rocateq', 'arm');
    $('tr-rc-purchase').onclick = () => cartSound('rocateq', 'purchase');
}
function showTxSafetyPrompt() {
    if (q('#tx-safety'))
        return;
    const el = document.createElement('div');
    el.id = 'tx-safety';
    el.className = 'modal';
    el.innerHTML = `<div class="modal-card"><h3>Before you transmit</h3><p>Do you have an antenna, dummy load or matched load on the ANT port?</p><ul><li>Transmitting into an open port can damage the HackRF.</li><li>Most bands need a license — know the rules where you are.</li><li>Turn TX GAIN low first; the amp adds +14 dB.</li></ul><div class="modal-actions"><button id="tx-cancel" class="chip">CANCEL</button><button id="tx-ack" class="chip primary">I HAVE ONE — CONTINUE</button></div></div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    $('tx-ack').onclick = () => { tx.acknowledgeSafety(); close(); };
    $('tx-cancel').onclick = () => { close(); open(null); };
}
function renderTx(view) {
    tx.onStatus = txStatus;
    if (!tx.enabled) {
        view.innerHTML = `<div class="notice tx-off"><b>Transmit is switched off in Settings.</b> Turn it back on there when you want to use it.<div class="row" style="margin-top:10px"><button id="tx-settings" class="chip">OPEN SETTINGS</button></div></div>`;
        $('tx-settings').onclick = () => open('settings');
        return;
    }
    if (tx.needsPrompt)
        showTxSafetyPrompt();
    view.innerHTML = `
    <section class="visual">${readoutHtml()}</section>
    <section class="controls">
      ${stepHtml([1e6, 1e5, 1e4])}
      <div class="caption">TX GAIN · IF 0–47 dB  ·  AMP +14 dB</div>
      <div class="row">${[0, 10, 20, 30, 47].map(g => `<button class="chip" data-txg="${g}">${g}</button>`).join('')}<button id="tx-amp" class="chip">amp</button></div>
      <div class="caption">MODE</div>
      <div class="wrap">${['Signal', 'Tones', 'POCSAG', 'RTTY', 'APRS', 'Morse', 'OOK', 'MDC', 'QC-II', 'SubGHz', 'KeeLoq', 'Noise', 'Brute', 'Hopper', 'ADS-B'].map((t, i) => `<button class="chip" data-txtab="${i}">${t}</button>`).join('')}</div>
      <div id="tx-body"></div>
      <div class="health" id="tx-status" style="margin-top:8px">idle</div>
      <button id="tx-stop" class="chip rec" style="margin-top:8px" hidden>■ STOP</button>
    </section>`;
    const setg = () => qa('[data-txg]').forEach(b => b.classList.toggle('on', Number(b.dataset.txg) === tx.gain));
    qa('[data-txg]', view).forEach(b => b.onclick = () => { tx.gain = Number(b.dataset.txg); setg(); });
    setg();
    const ampb = $('tx-amp');
    ampb.classList.toggle('on', tx.amp);
    ampb.textContent = tx.amp ? 'AMP' : 'amp';
    ampb.onclick = () => { tx.amp = !tx.amp; ampb.classList.toggle('on', tx.amp); ampb.textContent = tx.amp ? 'AMP' : 'amp'; };
    $('tx-stop').onclick = () => tx.stop();
    let tab = 0;
    const body = $('tx-body');
    const drawTab = () => {
        qa('[data-txtab]').forEach(b => b.classList.toggle('on', Number(b.dataset.txtab) === tab));
        if (tab === 0) {
            body.innerHTML = `<div class="caption">CONTINUOUS · until STOP · use a dummy load</div><div class="grid-tx">${[['cw', 'CW carrier'], ['fm', 'FM tone'], ['am', 'AM tone'], ['sweep', 'sweep ±50 kHz']].map(([m, l]) => `<button class="chip" data-sig="${m}">${l}</button>`).join('')}</div>`;
            qa('[data-sig]', body).forEach(b => b.onclick = () => tx.sigGen(state.freq, b.dataset.sig));
        }
        else if (tab === 1) {
            body.innerHTML = `<div class="grid-tx"><button class="chip" id="t-single">1 kHz</button><button class="chip" id="t-two">two-tone</button></div><input id="tx-dtmf" class="txin" value="1234" maxlength="32" style="margin-top:6px"><button class="chip primary" id="t-dtmf" style="margin-top:6px;width:100%">▶ SEND DTMF</button>`;
            $('t-single').onclick = () => tx.tones('single', '', state.freq);
            $('t-two').onclick = () => tx.tones('two', '', state.freq);
            $('t-dtmf').onclick = () => tx.tones('dtmf', $('tx-dtmf').value, state.freq);
        }
        else if (tab === 2) {
            body.innerHTML = `<input id="p-addr" class="txin" value="1234567" maxlength="7" inputmode="numeric"><input id="p-msg" class="txin" value="TEST DE MAYHEM" maxlength="80" style="margin-top:6px"><div class="row" style="margin-top:6px"><button class="chip" id="p-baud">1200 bd</button><button class="chip" id="p-num">alpha</button></div><div class="caption">Decodes on the Pager RX app and PDW · RIC + function 3</div><button class="chip primary" id="p-send" style="margin-top:6px;width:100%">▶ PAGE</button>`;
            let baud = 1200, numeric = false;
            $('p-baud').onclick = () => { baud = baud === 1200 ? 2400 : baud === 2400 ? 512 : 1200; $('p-baud').textContent = `${baud} bd`; };
            const nb = $('p-num');
            nb.onclick = () => { numeric = !numeric; nb.classList.toggle('on', numeric); nb.textContent = numeric ? 'numeric' : 'alpha'; };
            $('p-send').onclick = () => tx.pocsagTx(parseInt($('p-addr').value || '0', 10), 3, $('p-msg').value, numeric ? 1 : 0, baud, state.freq);
        }
        else if (tab === 3) {
            body.innerHTML = `<input id="r-text" class="txin" value="RYRYRY DE ${state.ham.station.call || 'MAYHEM'}" maxlength="120"><div class="row" style="margin-top:6px"><button class="chip" id="r-shift">170 Hz</button><button class="chip primary" id="r-send" style="flex:1.4">▶ SEND 45 bd</button></div><div class="caption">ITA2 Baudot 45.45 baud — decodes in fldigi etc.</div>`;
            let shift = 170;
            $('r-shift').onclick = () => { shift = shift === 170 ? 425 : shift === 425 ? 850 : 170; $('r-shift').textContent = `${shift} Hz`; };
            $('r-send').onclick = () => tx.rtty($('r-text').value, 45, shift, state.freq);
        }
        else if (tab === 4) {
            body.innerHTML = `<input id="a-call" class="txin" value="${aprsCall()}" maxlength="9"><input id="a-info" class="txin" value="!4903.50N/07201.75W-Mayhem Mobile" maxlength="120" style="margin-top:6px"><div class="caption">Bell 202 AX.25 UI frame — APRS app / any TNC. Ham license on 144.39.</div><button class="chip primary" id="a-send" style="margin-top:6px;width:100%">▶ BEACON</button>`;
            $('a-send').onclick = () => tx.aprs($('a-call').value, $('a-info').value, state.freq);
        }
        else if (tab === 5) {
            body.innerHTML = `<input id="tx-msg" class="txin" value="CQ DE ${state.ham.station.call || 'MAYHEM'}" maxlength="80"><div class="row" style="margin-top:6px"><span id="tx-wpm" class="info">20 WPM</span><button class="chip" id="wpm-">−</button><button class="chip" id="wpm+">+</button><button class="chip on" id="tx-fm">FM tone</button></div><button class="chip primary" id="tx-send" style="margin-top:6px;width:100%">▶ SEND</button>`;
            let wpm = 20, fm = true;
            $('wpm-').onclick = () => { wpm = Math.max(5, wpm - 5); $('tx-wpm').textContent = `${wpm} WPM`; };
            $('wpm+').onclick = () => { wpm = Math.min(60, wpm + 5); $('tx-wpm').textContent = `${wpm} WPM`; };
            const fmb = $('tx-fm');
            fmb.onclick = () => { fm = !fm; fmb.classList.toggle('on', fm); fmb.textContent = fm ? 'FM tone' : 'CW key'; };
            $('tx-send').onclick = () => tx.morse($('tx-msg').value, wpm, state.freq, fm);
        }
        else if (tab === 6) {
            body.innerHTML = `<input id="tx-hex" class="txin" value="A5C3F1" maxlength="12"><div class="row" style="margin-top:6px"><span id="tx-ook" class="info">24 bit 350µs</span><button class="chip" id="ook-bits">bits</button><button class="chip" id="ook-te">te</button></div><div class="caption">Fixed-code Princeton/PT2262 — remotes you own on a license-free ISM band</div><button class="chip primary" id="tx-ooksend" style="margin-top:6px;width:100%">▶ SEND ×8</button>`;
            let bits = 24, te = 350;
            const upd = () => $('tx-ook').textContent = `${bits} bit ${te}µs`;
            $('ook-bits').onclick = () => { bits = bits === 24 ? 12 : bits === 12 ? 32 : 24; upd(); };
            $('ook-te').onclick = () => { te = te === 350 ? 500 : te === 500 ? 200 : 350; upd(); };
            $('tx-ooksend').onclick = () => tx.ookPrinceton(state.freq, parseInt($('tx-hex').value || '0', 16) >>> 0, bits, te, 8);
        }
        else if (tab === 7) {
            body.innerHTML = `<div class="row"><input id="m-op" class="txin" value="01" maxlength="2" style="flex:1"><input id="m-arg" class="txin" value="00" maxlength="2" style="flex:1"><input id="m-unit" class="txin" value="1234" maxlength="4" style="flex:2"></div><div class="caption">MDC-1200 Motorola PTT-ID · op / arg (hex) / 16-bit unit ID (hex) · 1200 bd AFSK</div><button class="chip primary" id="m-send" style="margin-top:6px;width:100%">▶ PTT-ID</button>`;
            $('m-send').onclick = () => tx.mdc1200(parseInt($('m-op').value || '0', 16), parseInt($('m-arg').value || '0', 16), parseInt($('m-unit').value || '0', 16), state.freq);
        }
        else if (tab === 8) {
            body.innerHTML = `<div class="row"><input id="q-a" class="txin" value="1122.5" style="flex:1"><input id="q-b" class="txin" value="1465.5" style="flex:1"></div><div class="caption">Motorola Quick-Call II two-tone paging · tone A 1 s + tone B 3 s + 26 s carrier tail</div><button class="chip primary" id="q-send" style="margin-top:6px;width:100%">▶ PAGE QC-II</button>`;
            $('q-send').onclick = () => tx.quickCall2(parseFloat($('q-a').value || '0'), parseFloat($('q-b').value || '0'), state.freq);
        }
        else if (tab === 9) {
            body.innerHTML = `<textarea id="s-text" class="txin" rows="5" style="width:100%;font-family:monospace" placeholder="Paste a Flipper .sub file here — 'Protocol: RAW / RAW_Data: 340 -1020 …'"></textarea><div class="row" style="margin-top:6px"><span id="s-rep" class="info">×3</span><button class="chip" id="s-repm">−</button><button class="chip" id="s-repp">+</button></div><div class="caption">SubGHz replay of a Flipper Zero .sub RAW file · OOK, 2 Msps</div><button class="chip primary" id="s-send" style="margin-top:6px;width:100%">▶ REPLAY</button>`;
            let reps = 3;
            $('s-repm').onclick = () => { reps = Math.max(1, reps - 1); $('s-rep').textContent = `×${reps}`; };
            $('s-repp').onclick = () => { reps = Math.min(20, reps + 1); $('s-rep').textContent = `×${reps}`; };
            $('s-send').onclick = () => tx.subghzReplay($('s-text').value, state.freq, reps);
        }
        else if (tab === 10) {
            body.innerHTML = `<input id="k-key" class="txin" value="5CEC6701B79FD949" maxlength="16"><div class="row" style="margin-top:6px"><input id="k-serial" class="txin" value="1234567" maxlength="7" style="flex:1.5"><input id="k-btn" class="txin" value="2" maxlength="1" style="flex:0.5"><input id="k-cnt" class="txin" value="42" maxlength="6" style="flex:1"></div><div class="row" style="margin-top:6px"><span id="k-rep" class="info">×3</span><button class="chip" id="k-repm">−</button><button class="chip" id="k-repp">+</button></div><div class="caption">HCS301 KeeLoq · 64-bit key (hex) / 28-bit serial (hex) / 4-bit button / counter · OOK PWM 433.92 MHz-ish</div><button class="chip primary" id="k-send" style="margin-top:6px;width:100%">▶ HOP</button>`;
            let reps = 3;
            $('k-repm').onclick = () => { reps = Math.max(1, reps - 1); $('k-rep').textContent = `×${reps}`; };
            $('k-repp').onclick = () => { reps = Math.min(8, reps + 1); $('k-rep').textContent = `×${reps}`; };
            $('k-send').onclick = () => tx.keeloqTx(BigInt('0x' + ($('k-key').value || '0')), parseInt($('k-serial').value || '0', 16), parseInt($('k-btn').value || '0', 10), parseInt($('k-cnt').value || '0', 10), state.freq, reps);
        }
        else if (tab === 11) {
            body.innerHTML = `<div class="row"><input id="n-chip" class="txin" value="100" style="flex:1"><input id="n-sec" class="txin" value="3" style="flex:1"></div><div class="caption">Pseudo-random OOK · chipUs µs per chip, [seconds] total · authorised RF-lab work on your own gear</div><button class="chip primary" id="n-send" style="margin-top:6px;width:100%">▶ NOISE</button>`;
            $('n-send').onclick = () => tx.ookNoise(parseInt($('n-chip').value || '0', 10), parseInt($('n-sec').value || '0', 10), state.freq);
        }
        else if (tab === 12) {
            body.innerHTML = `<div class="row"><input id="b-bits" class="txin" value="24" style="flex:1"><input id="b-from" class="txin" value="0" style="flex:1"><input id="b-to" class="txin" value="255" style="flex:1"></div><input id="b-te" class="txin" value="350" style="margin-top:6px"><div class="caption">Princeton PT2262 brute-force · bits (12/24/32), start-end (decimal), te µs · a gate you own on ISM</div><button class="chip primary" id="b-send" style="margin-top:6px;width:100%">▶ BRUTE</button>`;
            $('b-send').onclick = () => tx.ookBrute(parseInt($('b-bits').value || '24', 10), parseInt($('b-from').value || '0', 10), parseInt($('b-to').value || '0', 10), parseInt($('b-te').value || '350', 10), state.freq);
        }
        else if (tab === 13) {
            body.innerHTML = `<div class="row"><input id="h-lo" class="txin" value="433.05" style="flex:1"><input id="h-hi" class="txin" value="434.79" style="flex:1"></div><div class="row" style="margin-top:6px"><input id="h-count" class="txin" value="16" style="flex:1"><input id="h-dwell" class="txin" value="20" style="flex:1"></div><div class="caption">CW frequency hopper · low-high MHz · [count] random hops · dwell ms each · your own bench work only</div><button class="chip primary" id="h-send" style="margin-top:6px;width:100%">▶ HOP</button>`;
            $('h-send').onclick = () => {
                const lo = Math.round(parseFloat($('h-lo').value || '0') * 1e6);
                const hi = Math.round(parseFloat($('h-hi').value || '0') * 1e6);
                const n = parseInt($('h-count').value || '16', 10);
                const d = parseInt($('h-dwell').value || '20', 10);
                tx.frequencyHopper(Apps.hopList(lo, hi, n), d);
            };
        }
        else {
            body.innerHTML = `<input id="a-icao" class="txin" value="A19E43" maxlength="6"><input id="a-me" class="txin" value="58C382C82F4D4A" maxlength="14" style="margin-top:6px"><div class="caption">Mode-S DF17 Extended Squitter · ICAO 24-bit hex + ME 56-bit hex · dummy load only, real airspace is illegal</div><button class="chip primary" id="a-send" style="margin-top:6px;width:100%">▶ SQUITTER</button>`;
            $('a-send').onclick = () => {
                const icao = parseInt($('a-icao').value || '0', 16);
                const meStr = ($('a-me').value || '').padStart(14, '0');
                const meHi = parseInt(meStr.slice(0, 6), 16);
                const meLo = parseInt(meStr.slice(6, 14), 16);
                tx.adsb(icao, meLo, meHi);
            };
        }
    };
    qa('[data-txtab]', view).forEach(b => b.onclick = () => { tab = Number(b.dataset.txtab); drawTab(); });
    drawTab();
    txStatus(tx.active ? 'transmitting' : 'idle');
}
function renderCapture(view) {
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
        if (state.capturing)
            worker?.postMessage({ type: 'capture', cmd: 'stop' });
        else
            worker?.postMessage({ type: 'capture', cmd: 'start', freq: state.freq, rate: state.rate });
    };
    refreshCapture();
}
function renderSettings(view) {
    view.innerHTML = `
    <div class="caption">THEME · the PortaPack Mayhem firmware skins, plus the mobile default</div>
    <div class="skins">${SKINS.map(s => `<button class="skin" data-skin="${s.id}" style="background:${s.paper};border-color:${s.id === currentSkin().id ? s.accent : s.line};color:${s.ink}"><div class="skin-head"><span>${s.title}</span>${s.id === currentSkin().id ? `<span style="color:${s.accent}">●</span>` : ''}</div><div class="swatches">${[s.surface, s.panel, s.line, s.muted, s.accent, s.accent2].map(c => `<i style="background:${c}"></i>`).join('')}</div><div class="skin-readout" style="background:${s.surface};border-color:${s.accent}80;color:${s.accent}">92.3000 MHz</div></button>`).join('')}</div>
    <div class="caption">STATION · your license details — the logbook, ADIF export and the transmit apps use these</div>
    <div class="panel about" id="station">
      <div class="row"><input class="txin" data-st="call" placeholder="CALLSIGN" value="${state.ham.station.call}" autocapitalize="characters" spellcheck="false"><input class="txin" data-st="license" placeholder="license class (Technician, General…)" value="${state.ham.station.license}"></div>
      <div class="row"><input class="txin" data-st="name" placeholder="name" value="${state.ham.station.name}"><input class="txin" data-st="grid" placeholder="${state.home ? `grid ${latLonToGrid(state.home.lat, state.home.lon)} (from GPS)` : 'grid square, e.g. DM04og'}" value="${state.ham.station.grid}" autocapitalize="characters"></div>
      <div class="row"><input class="txin" data-st="dmrId" placeholder="DMR ID (radioid.net)" value="${state.ham.station.dmrId}" inputmode="numeric"><input class="txin" data-st="aprsSsid" placeholder="APRS SSID (9 = mobile)" value="${state.ham.station.aprsSsid}" inputmode="numeric"></div>
      <div class="kv"><span>Where it goes</span><span>ADIF STATION_CALLSIGN / MY_GRIDSQUARE, the APRS beacon source, CW and RTTY message defaults, the logbook's distance and bearing. Nothing is sent anywhere else.</span></div>
    </div>
    <div class="caption">APP</div>
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
    <div class="caption">TRANSMIT · on by default with a safety prompt — you are responsible for what you send</div>
    <div class="panel about tx-gate ${tx.enabled ? 'on' : ''}">
      <div class="apk-card" style="padding:0">
        <div><div class="apk-title">${tx.enabled ? 'TX ENABLED' : 'TX DISABLED'}</div><div class="apk-sub">Enables the Transmit app (signal generator, Morse, OOK remotes). Most bands require a license; always use a dummy load or an antenna rated for the frequency.</div></div>
        <button id="tx-toggle" class="chip ${tx.enabled ? 'rec' : ''}">${tx.enabled ? 'ON' : 'OFF'}</button>
      </div>
    </div>
    <div class="caption">MADE BY</div>
    <div class="panel about">
      <div class="kv"><span>RocketGod</span><span><a href="https://rocketgod.dev">RocketGod.dev</a></span></div>
      <div class="kv"><span>Crew</span><span>The Pirates' Plunder — <a href="https://discord.gg/thepirates">discord.gg/thepirates</a></span></div>
    </div>
    <div class="caption">CREDITS · who wrote what this app is built from · drag to steer</div>
    <div class="panel credits" id="credits"><div class="credits-roll" id="credits-roll">${(() => { const inner = CREDITS.map(([h, t]) => h ? `<h4>${esc(t)}</h4>` : `<p>${esc(t)}</p>`).join(''); return `<div class="credits-copy">${inner}</div><div class="credits-copy" aria-hidden="true">${inner}</div>`; })()}</div></div>
    <div class="caption">FIELD NOTES</div>
    <div class="panel about">
      <div class="kv"><span>Browsers</span><span>Chrome / Edge on Android phones, Windows, macOS, Linux — the same desktop web app runs everywhere. iPhone/iPad and Firefox have no WebUSB; on Android phones the APK is the recommended route.</span></div>
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
      <div class="kv"><span>Keyboard</span><span>digits: wheel, click top/bottom, type · ← → tune · ↑ ↓ step size · M mode · X mute · T toolbar · S squelch · B bookmark · Space scan · A amp · G AGC · [ ] LNA · − = VGA · C connect · L log · Esc home · mouse wheel over the waterfall tunes, Ctrl+wheel changes the step</span></div>
    </div>`;
    qa('[data-st]', view).forEach(i => i.oninput = () => { const k = i.dataset.st; const v = k === 'call' || k === 'grid' ? i.value.toUpperCase() : i.value; if (k === 'call' || k === 'grid')
        i.value = v; state.ham.station[k] = v; saveStation(); });
    qa('[data-skin]', view).forEach(b => b.onclick = () => { applySkin(SKINS.find(s => s.id === b.dataset.skin)); render('settings'); });
    const tg = q('#tx-toggle');
    if (tg)
        tg.onclick = () => { tx.setEnabled(!tx.enabled); render('settings'); };
    $('install').onclick = async () => { if (installPrompt) {
        await installPrompt.prompt();
        installPrompt = null;
        render('settings');
    } };
    attachCreditsScroller($('credits'), $('credits-roll'));
}
function attachCreditsScroller(panel, roll) {
    if (!panel || !roll)
        return;
    const AUTO_PX_PER_SEC = 22;
    let offset = 0;
    let dragging = false;
    let velocity = 0;
    let lastY = 0;
    let lastT = performance.now();
    let raf = 0;
    const halfHeight = () => (roll.scrollHeight || 1) / 2;
    const paint = () => { roll.style.transform = `translateY(${-offset}px)`; };
    const step = (now) => {
        const dt = Math.min(80, now - lastT) / 1000;
        lastT = now;
        if (!dragging) {
            offset += AUTO_PX_PER_SEC * dt;
            if (Math.abs(velocity) > 5) {
                offset += velocity * dt;
                velocity *= Math.pow(0.001, dt);
            }
        }
        const h = halfHeight();
        if (h > 0) {
            while (offset >= h)
                offset -= h;
            while (offset < 0)
                offset += h;
        }
        paint();
        raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    panel.style.touchAction = 'none';
    panel.style.cursor = 'grab';
    const down = (e) => {
        dragging = true;
        velocity = 0;
        lastY = e.clientY;
        panel.style.cursor = 'grabbing';
        try {
            panel.setPointerCapture(e.pointerId);
        }
        catch { }
    };
    const move = (e) => {
        if (!dragging)
            return;
        const dy = e.clientY - lastY;
        lastY = e.clientY;
        offset -= dy;
        velocity = -dy * 60;
        paint();
    };
    const up = (e) => {
        dragging = false;
        panel.style.cursor = 'grab';
        try {
            panel.releasePointerCapture(e.pointerId);
        }
        catch { }
    };
    panel.addEventListener('pointerdown', down);
    panel.addEventListener('pointermove', move);
    panel.addEventListener('pointerup', up);
    panel.addEventListener('pointercancel', up);
    const stop = new MutationObserver(() => { if (!document.body.contains(roll)) {
        cancelAnimationFrame(raf);
        stop.disconnect();
    } });
    stop.observe(document.body, { childList: true, subtree: true });
}
function wireCommon(view) {
    const fav = q('#fav', view);
    if (fav) {
        fav.onclick = toggleFav;
        refreshFav();
    }
    const fkey = q('#fkey', view);
    if (fkey)
        fkey.onclick = () => freqEntry();
    qa('[data-app]', view).forEach(b => b.onclick = () => open(b.dataset.app));
    qa('[data-satview]', view).forEach(b => b.onclick = () => { state.ham.sat.view = b.dataset.satview; open('sat'); });
    qa('[data-mode]', view).forEach(b => b.onclick = () => setMode(b.dataset.mode));
    qa('[data-step]', view).forEach(b => b.onclick = () => tune(state.freq + Number(b.dataset.step)));
    qa('[data-preset]', view).forEach(b => b.onclick = () => { if (b.dataset.pmode)
        setMode(b.dataset.pmode); tune(Number(b.dataset.preset)); });
    qa('[data-lband]', view).forEach(b => b.onclick = () => gotoBand(b.dataset.lband || 'fm'));
    qa('[data-rate]', view).forEach(b => b.onclick = () => setRate(Number(b.dataset.rate)));
    highlightBands();
    const on = (id, f) => { const el = q('#' + id, view); if (el)
        el.onclick = f; };
    on('lna-minus', () => manualGains(state.lna - 8, state.vga, state.amp));
    on('lna-plus', () => manualGains(state.lna + 8, state.vga, state.amp));
    on('vga-minus', () => manualGains(state.lna, state.vga - 2, state.amp));
    on('vga-plus', () => manualGains(state.lna, state.vga + 2, state.amp));
    on('amp', () => { setGains(state.lna, state.vga, !state.amp); saveGains(); });
    on('agc', () => userAgc(!state.agc));
    refreshAgcChip();
    refreshGainUi();
    qa('[id^="clear-"]', view).forEach(b => b.onclick = () => clearApp(b.id.slice(6)));
    qa('[id^="pause-"]', view).forEach(b => b.onclick = () => togglePause(b.id.slice(6)));
    refreshPauseChips();
    qa('[data-rate]', view).forEach(b => b.classList.toggle('on', Number(b.dataset.rate) === state.rate));
}
function refreshReadout() {
    setFreqDisplay(state.freq);
    scope?.setLabels(centredLabels(spanCenter(), state.rate));
    refreshSpanBar();
    document.body.classList.toggle('offspan', channelOff());
    if (lastCenterSent !== spanCenter()) {
        lastCenterSent = spanCenter();
        worker?.postMessage({ type: 'config', centreHz: lastCenterSent });
    }
    qa('[data-preset]').forEach(b => b.classList.toggle('on', Number(b.dataset.preset) === state.freq));
    highlightBands();
    refreshFav();
    const h = q('#health');
    if (h && lastHealth)
        h.textContent = lastHealth;
    const l = q('#level');
    if (l)
        l.style.width = `${Math.min(100, Math.max(0, lastLevel / 45 * 100))}%`;
}
const paused = new Set();
function togglePause(id) {
    if (!paused.delete(id))
        paused.add(id);
    refreshPauseChips();
    if (!paused.has(id))
        redraw(id);
}
function refreshPauseChips() { qa('[id^="pause-"]').forEach(b => { const on = paused.has(b.id.slice(6)); b.classList.toggle('on', on); b.textContent = on ? 'RESUME' : 'PAUSE'; }); }
function redraw(id) {
    switch (id) {
        case 'ais':
            refreshAis();
            break;
        case 'aprs':
            refreshAprs();
            break;
        case 'adsb':
            refreshAdsb();
            break;
        case 'devices':
            drawR433();
            break;
        case 'psat':
            refreshPacketSats();
            break;
        default: refreshList(id);
    }
}
function clearApp(id) {
    logs[id] = [];
    counts[id] = 0;
    switch (id) {
        case 'ais':
            state.aisTable = [];
            state.aisSel = 0;
            break;
        case 'aprs':
            state.aprsStations = [];
            state.aprsSel = '';
            break;
        case 'adsb':
            state.aircraft = [];
            state.frames = 0;
            state.adsbSel = '';
            break;
        case 'devices':
            state.r433.heard = [];
            break;
        case 'psat':
            state.psat.frames = [];
            state.psat.heard = 0;
            state.psat.bad = 0;
            break;
    }
    worker?.postMessage({ type: 'clear' });
    const held = paused.delete(id);
    redraw(id);
    if (held)
        paused.add(id);
}
function refreshList(id) {
    const c = q(`#count-${id}`);
    if (c)
        c.textContent = `${counts[id] ?? 0} DECODED`;
    const el = q(`#list-${id}`);
    if (!el || paused.has(id))
        return;
    const lines = logs[id] ?? [];
    el.innerHTML = lines.length ? lines.map((l, i) => `<div class="li ${i % 2 ? 'alt' : ''}">${esc(l)}</div>`).join('') : '<div class="empty">listening…</div>';
}
function refreshAis() {
    if (state.app !== 'ais')
        return;
    const c = q('#ais-count');
    if (c)
        c.textContent = `⚓ ${counts['ais'] ?? 0} PACKETS · ${state.aisTable.length} VESSELS`;
    qa('[data-aisview]').forEach(b => b.classList.toggle('on', b.dataset.aisview === state.aisView));
    const list = q('#ais-list'), mapEl = q('#ais-map'), logEl = q('#ais-log');
    if (!list || !mapEl || !logEl)
        return;
    list.hidden = state.aisView !== 'list';
    mapEl.hidden = state.aisView !== 'map';
    logEl.hidden = state.aisView !== 'log';
    if (paused.has('ais')) {
        qa('[data-mmsi]', list).forEach(d => d.classList.toggle('gold', Number(d.dataset.mmsi) === state.aisSel));
        renderShipCard(state.aisTable.find(v => v.mmsi === state.aisSel));
        return;
    }
    list.innerHTML = state.aisTable.length ? state.aisTable.map((v, i) => `<div class="li row2 tap ${i % 2 ? 'alt' : ''} ${v.mmsi === state.aisSel ? 'gold' : ''}" data-mmsi="${v.mmsi}"><b>${esc(v.name || String(v.mmsi))}</b><span>${v.name ? v.mmsi + ' · ' : ''}${v.lat !== undefined && v.lon !== undefined ? `${v.lat.toFixed(3)},${v.lon.toFixed(3)}` : 'no fix'}${v.sog !== undefined ? ` · ${v.sog.toFixed(1)} kn` : ''}</span></div>`).join('') : '<div class="empty">no vessels yet</div>';
    qa('[data-mmsi]', list).forEach(d => d.onclick = () => { state.aisSel = Number(d.dataset.mmsi); const v = state.aisTable.find(x => x.mmsi === state.aisSel); if (v?.lat !== undefined)
        state.aisView = 'map'; refreshAis(); });
    renderShipCard(state.aisTable.find(v => v.mmsi === state.aisSel));
    if (state.aisView === 'map')
        geo?.invalidate();
    geo?.update(state.aisTable.filter(v => v.lat !== undefined && v.lon !== undefined).map(v => ({ id: String(v.mmsi), lat: v.lat, lon: v.lon, heading: v.hdg ?? v.cog, label: v.name || String(v.mmsi), kind: (v.cls === 'AtoN' ? 'aton' : v.cls === 'base' ? 'object' : 'ship') })), String(state.aisSel));
}
function refreshAprs() {
    if (state.app !== 'aprs')
        return;
    const c = q('#aprs-count');
    if (c)
        c.textContent = `📡 ${counts['aprs'] ?? 0} PACKETS · ${state.aprsStations.length} STATIONS`;
    qa('[data-aprsview]').forEach(b => b.classList.toggle('on', b.dataset.aprsview === state.aprsView));
    const list = q('#aprs-list'), mapEl = q('#aprs-map'), logEl = q('#aprs-log');
    if (!list || !mapEl || !logEl)
        return;
    list.hidden = state.aprsView !== 'list';
    mapEl.hidden = state.aprsView !== 'map';
    logEl.hidden = state.aprsView !== 'log';
    if (paused.has('aprs')) {
        qa('[data-call]', list).forEach(d => d.classList.toggle('gold', d.dataset.call === state.aprsSel));
        renderStationCard(state.aprsStations.find(s => s.call === state.aprsSel));
        return;
    }
    list.innerHTML = state.aprsStations.length ? state.aprsStations.map((s, i) => `<div class="li row2 tap ${i % 2 ? 'alt' : ''} ${s.call === state.aprsSel ? 'gold' : ''}" data-call="${esc(s.call)}"><b>${esc(s.call)}${s.kind !== 'station' ? ` <small>${s.kind} by ${esc(s.owner ?? '?')}</small>` : ''}</b><span>${esc(aprsSymbolName(s.table, s.symbol))}${s.lat !== undefined && s.lon !== undefined ? ` · ${s.lat.toFixed(3)},${s.lon.toFixed(3)}` : ''}${s.speed ? ` · ${Math.round(s.speed)} kn` : ''}</span></div>`).join('') : '<div class="empty">no stations yet</div>';
    qa('[data-call]', list).forEach(d => d.onclick = () => { state.aprsSel = d.dataset.call; const s = state.aprsStations.find(x => x.call === state.aprsSel); if (s?.lat !== undefined)
        state.aprsView = 'map'; refreshAprs(); });
    renderStationCard(state.aprsStations.find(s => s.call === state.aprsSel));
    if (state.aprsView === 'map')
        geo?.invalidate();
    geo?.update(state.aprsStations.filter(s => s.lat !== undefined && s.lon !== undefined).map(s => ({ id: s.call, lat: s.lat, lon: s.lon, heading: s.course, label: s.call, kind: (s.kind === 'station' ? 'station' : 'object') })), state.aprsSel);
}
function refreshBtle() { qa('[data-btle]').forEach(b => b.classList.toggle('on', Number(b.dataset.btle) === state.btleCh)); }
function refreshAdsb() {
    const c = q('#adsb-count');
    if (c)
        c.textContent = `✈ ${state.frames} FRAMES · ${state.aircraft.length} AIRCRAFT`;
    qa('[data-adsbview]').forEach(b => b.classList.toggle('on', b.dataset.adsbview === state.adsbView));
    const el = q('#adsb-list'), mapEl = q('#adsb-map');
    if (!el || !mapEl)
        return;
    el.hidden = state.adsbView !== 'list';
    mapEl.hidden = state.adsbView !== 'map';
    renderAcCard(state.aircraft.find(a => a.icao === state.adsbSel));
    if (paused.has('adsb')) {
        qa('[data-icao]', el).forEach(d => d.classList.toggle('gold', d.dataset.icao === state.adsbSel));
        return;
    }
    el.innerHTML = state.aircraft.length ? state.aircraft.map((a, i) => `<div class="li row2 tap ${i % 2 ? 'alt' : ''} ${a.icao === state.adsbSel ? 'gold' : ''}" data-icao="${a.icao}"><b>${a.icao.toUpperCase()} ${esc(a.flight ?? '')}</b><span>${a.alt !== undefined ? a.alt + 'ft' : ''} ${a.gs !== undefined ? a.gs + 'kt' : ''} ${a.track !== undefined ? a.track + '°' : ''} ${a.lat !== undefined && a.lon !== undefined ? a.lat.toFixed(3) + ',' + a.lon.toFixed(3) : 'no pos'}</span></div>`).join('') : '<div class="empty">listening on 1090 MHz…</div>';
    qa('[data-icao]', el).forEach(d => d.onclick = () => { state.adsbSel = d.dataset.icao; const a = state.aircraft.find(x => x.icao === state.adsbSel); if (a?.lat !== undefined)
        state.adsbView = 'map'; refreshAdsb(); });
    if (state.adsbView === 'map')
        geo?.invalidate();
    geo?.update(state.aircraft.filter(a => a.lat !== undefined && a.lon !== undefined).map(a => ({ id: a.icao, lat: a.lat, lon: a.lon, heading: a.track, label: (a.flight ?? '').trim() || a.icao.toUpperCase(), kind: 'plane' })), state.adsbSel);
}
let shipCardKey = '';
function renderShipCard(v) {
    const card = q('#ais-card');
    if (!card)
        return;
    if (!v) {
        card.hidden = true;
        shipCardKey = '';
        return;
    }
    card.hidden = false;
    const who = mmsiInfo(v.mmsi);
    const kind = v.cls === 'A' ? 'Class A' : v.cls === 'B' ? 'Class B' : v.cls === 'base' ? 'Base station' : v.cls === 'AtoN' ? (v.virtualAton ? 'Virtual aid to navigation' : 'Aid to navigation') : v.cls === 'SAR' ? 'SAR aircraft' : who.kind;
    const key = [v.mmsi, v.name, v.callsign, v.imo, v.shipType, v.atonType, v.dest, v.eta?.day, v.dimA, v.dimB, v.dimC, v.dimD, v.draft, v.cls, v.navStatus].join('|');
    if (key !== shipCardKey) {
        shipCardKey = key;
        const lines = [];
        const id = [v.callsign ? `call ${esc(v.callsign)}` : '', v.imo ? `IMO ${v.imo}` : ''].filter(Boolean).join(' · ');
        if (id)
            lines.push(`<div class="accard-reg">${id}</div>`);
        const type = v.cls === 'AtoN' ? atonTypeName(v.atonType) : shipTypeName(v.shipType);
        lines.push(`<div class="accard-model">${esc([kind, type].filter(Boolean).join(' · '))}</div>`);
        if (v.navStatus !== undefined && navStatusName(v.navStatus))
            lines.push(`<div class="accard-op">${esc(navStatusName(v.navStatus))}</div>`);
        if (v.dest)
            lines.push(`<div class="accard-op">→ ${esc(v.dest)}${v.eta ? ` · ETA ${String(v.eta.day).padStart(2, '0')}/${String(v.eta.month).padStart(2, '0')} ${String(v.eta.hour).padStart(2, '0')}:${String(v.eta.minute).padStart(2, '0')} UTC` : ''}</div>`);
        const len = v.dimA !== undefined && v.dimB !== undefined ? v.dimA + v.dimB : 0, beam = v.dimC !== undefined && v.dimD !== undefined ? v.dimC + v.dimD : 0;
        const size = [len ? `${len} m long` : '', beam ? `${beam} m beam` : '', v.draft ? `draft ${v.draft.toFixed(1)} m` : ''].filter(Boolean).join(' · ');
        if (size)
            lines.push(`<div class="accard-country">${esc(size)}</div>`);
        if (who.flag)
            lines.push(`<div class="accard-country">${esc(who.flag)}</div>`);
        if (v.vendor)
            lines.push(`<div class="accard-country">transponder ${esc(v.vendor)}</div>`);
        card.innerHTML = `
      <div class="accard-bar">
        <b>${esc(v.name || `MMSI ${v.mmsi}`)}</b><span class="accard-hex">${v.name ? `MMSI ${v.mmsi}` : 'no name yet'}</span>
        <span class="accard-btns"><button class="chip" data-shipmap title="center the map on it" ${v.lat === undefined ? 'hidden' : ''}>MAP</button><button class="chip" data-shipclose title="close">✕</button></span>
      </div>
      <div class="accard-body"><div class="accard-id">${lines.join('')}</div></div>
      <div class="accard-grid">
        ${['SPEED', 'COURSE', 'HEADING', 'TURN', 'POSITION', 'FROM YOU', 'HEARD', 'FIRST HEARD', 'MESSAGES'].map(k => `<div><span class="k">${k}</span><span class="v" data-f="${k}">—</span></div>`).join('')}
      </div>`;
        qa('[data-shipclose]', card).forEach(b => b.onclick = () => { state.aisSel = 0; refreshAis(); });
        qa('[data-shipmap]', card).forEach(b => b.onclick = () => { state.aisView = 'map'; refreshAis(); const s = state.aisTable.find(x => x.mmsi === state.aisSel); if (s?.lat !== undefined && s.lon !== undefined)
            geo?.center(s.lat, s.lon); });
    }
    const now = Date.now();
    const set = (k, val) => { const el = card.querySelector(`[data-f="${k}"]`); if (el && el.textContent !== val)
        el.textContent = val; };
    set('SPEED', v.sog !== undefined ? `${v.sog.toFixed(1)} kn` : '—');
    set('COURSE', v.cog !== undefined ? `${v.cog.toFixed(0)}°` : '—');
    set('HEADING', v.hdg !== undefined ? `${v.hdg}°` : '—');
    set('TURN', v.rot !== undefined ? (Math.abs(v.rot) < 0.5 ? 'steady' : `${v.rot > 0 ? '→' : '←'} ${Math.abs(v.rot).toFixed(0)}°/min`) : '—');
    set('POSITION', v.lat !== undefined && v.lon !== undefined ? `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}${v.accuracy ? '' : ' (≈)'}` : 'no fix yet');
    if (state.home && v.lat !== undefined && v.lon !== undefined) {
        const d = distanceBearing(state.home.lat, state.home.lon, v.lat, v.lon);
        set('FROM YOU', `${d.km.toFixed(d.km < 10 ? 1 : 0)} km · ${(d.km * 0.539957).toFixed(0)} nmi · ${Math.round(d.deg)}°`);
    }
    else
        set('FROM YOU', state.home ? '—' : 'allow location to see');
    set('HEARD', ageText(now - v.lastMs));
    set('FIRST HEARD', `${ageText(now - v.firstMs)} · ${new Date(v.firstMs).toLocaleTimeString()}`);
    set('MESSAGES', String(v.msgs));
}
const stationInfo = new Map();
let stationCardKey = '';
function renderStationCard(s) {
    const card = q('#aprs-card');
    if (!card)
        return;
    if (!s) {
        card.hidden = true;
        stationCardKey = '';
        return;
    }
    card.hidden = false;
    const base = parseCall(s.call.replace(/-\d+$/, '')).base;
    if (s.kind === 'station' && base && !stationInfo.has(base)) {
        stationInfo.set(base, null);
        void lookupCall(base).then(i => { stationInfo.set(base, i); if (state.app === 'aprs')
            refreshAprs(); }).catch(() => undefined);
    }
    const info = base ? stationInfo.get(base) ?? null : null;
    const key = [s.call, s.kind, s.owner, s.symbol, s.table, s.comment, s.status, s.mice, s.dest, s.path, s.via, s.lastMsg?.text, info?.name, info?.qth, info?.country, s.wx ? 1 : 0].join('|');
    if (key !== stationCardKey) {
        stationCardKey = key;
        const lines = [];
        const sym = aprsSymbolName(s.table, s.symbol);
        lines.push(`<div class="accard-model">${esc([s.kind === 'object' ? `Object from ${s.owner}` : s.kind === 'item' ? `Item from ${s.owner}` : '', sym].filter(Boolean).join(' · ') || 'APRS station')}</div>`);
        if (info?.name || info?.qth)
            lines.push(`<div class="accard-op">${esc([info.name, info.qth].filter(Boolean).join(' · '))}</div>`);
        if (info?.country)
            lines.push(`<div class="accard-country">${esc(info.country)}${info.class ? ` · ${esc(info.class)}` : ''}</div>`);
        if (s.mice)
            lines.push(`<div class="accard-op">Mic-E: ${esc(s.mice)}</div>`);
        if (s.status)
            lines.push(`<div class="accard-op">${esc(s.status)}</div>`);
        if (s.comment)
            lines.push(`<div class="accard-op">${esc(s.comment)}</div>`);
        if (s.lastMsg)
            lines.push(`<div class="accard-op">→ ${esc(s.lastMsg.to)}: ${esc(s.lastMsg.text)}</div>`);
        if (s.path || s.via)
            lines.push(`<div class="accard-country">${esc([s.dest ? `to ${s.dest}` : '', s.path ? `via ${s.path}` : 'direct', s.via ? `relayed by ${s.via}` : ''].filter(Boolean).join(' · '))}</div>`);
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
        qa('[data-stclose]', card).forEach(b => b.onclick = () => { state.aprsSel = ''; refreshAprs(); });
        qa('[data-stmap]', card).forEach(b => b.onclick = () => { state.aprsView = 'map'; refreshAprs(); const x = state.aprsStations.find(y => y.call === state.aprsSel); if (x?.lat !== undefined && x.lon !== undefined)
            geo?.center(x.lat, x.lon, 11); });
    }
    const now = Date.now();
    const set = (k, val) => { const el = card.querySelector(`[data-f="${k}"]`); if (el && el.textContent !== val)
        el.textContent = val; };
    const hasPos = s.lat !== undefined && s.lon !== undefined;
    set('POSITION', hasPos ? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}` : 'no position');
    set('GRID', hasPos ? latLonToGrid(s.lat, s.lon, 8) : '—');
    if (state.home && hasPos) {
        const d = distanceBearing(state.home.lat, state.home.lon, s.lat, s.lon);
        set('FROM YOU', `${d.km.toFixed(d.km < 10 ? 1 : 0)} km · ${(d.km * 0.621371).toFixed(0)} mi · ${Math.round(d.deg)}°`);
    }
    else
        set('FROM YOU', state.home ? '—' : 'allow location to see');
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
const acInfo = new Map();
let acCardKey = '';
function lookupAircraft(a) {
    const key = a.icao;
    if (acInfo.has(key))
        return;
    const info = { done: false };
    acInfo.set(key, info);
    const jobs = [
        fetch(`https://api.adsbdb.com/v0/aircraft/${a.icao.toUpperCase()}`).then(r => r.ok ? r.json() : null).then((j) => {
            const x = j?.response?.aircraft;
            if (!x)
                return;
            info.reg = x.registration;
            info.type = x.type;
            info.typeIcao = x.icao_type;
            info.maker = x.manufacturer;
            info.owner = x.registered_owner;
            info.country = x.registered_owner_country_name;
            info.photo = x.url_photo_thumbnail;
        }).catch(() => undefined),
    ];
    void Promise.all(jobs).then(() => { info.done = true; if (state.app === 'adsb')
        refreshAdsb(); });
}
const ageText = (ms) => ms < 1000 ? 'now' : ms < 60000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60000)} min ago`;
function renderAcCard(a) {
    const card = q('#adsb-card');
    if (!card)
        return;
    if (!a) {
        card.hidden = true;
        acCardKey = '';
        return;
    }
    card.hidden = false;
    lookupAircraft(a);
    const info = acInfo.get(a.icao);
    const key = `${a.icao}|${a.flight ?? ''}|${info?.done ? 1 : 0}`;
    const call = (a.flight ?? '').trim();
    if (key !== acCardKey) {
        acCardKey = key;
        const lines = [];
        if (info?.reg || info?.typeIcao)
            lines.push(`<div class="accard-reg">${esc(info.reg ?? '')}${info.typeIcao ? ` <span>${esc(info.typeIcao)}</span>` : ''}</div>`);
        const model = [info?.maker, info?.type].filter((s) => !!s).join(' ');
        if (model)
            lines.push(`<div class="accard-model">${esc(model)}</div>`);
        if (info?.owner)
            lines.push(`<div class="accard-op">${esc(info.owner)}</div>`);
        if (info?.country)
            lines.push(`<div class="accard-country">${esc(info.country)}</div>`);
        if (!lines.length)
            lines.push(`<div class="accard-country">${info && !info.done ? 'looking up the registry…' : info?.done ? 'not in the registry' : ''}</div>`);
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
        qa('[data-acclose]', card).forEach(b => b.onclick = () => { state.adsbSel = ''; refreshAdsb(); });
        qa('[data-acfly]', card).forEach(b => b.onclick = () => {
            state.adsbView = 'map';
            refreshAdsb();
            const p = state.aircraft.find(x => x.icao === state.adsbSel);
            if (p?.lat !== undefined && p.lon !== undefined)
                geo?.center(p.lat, p.lon);
        });
    }
    const now = Date.now();
    const set = (k, v) => { const el = card.querySelector(`[data-f="${k}"]`); if (el && el.textContent !== v)
        el.textContent = v; };
    set('ALTITUDE', a.alt !== undefined ? `${a.alt.toLocaleString()} ft` : '—');
    set('GROUND SPEED', a.gs !== undefined ? `${a.gs} kt` : '—');
    set('TRACK', a.track !== undefined ? `${a.track}°` : '—');
    set('CLIMB', a.vr !== undefined ? `${a.vr > 0 ? '+' : ''}${a.vr} ft/min` : '—');
    set('POSITION', a.lat !== undefined && a.lon !== undefined ? `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` : 'no position yet');
    if (state.home && a.lat !== undefined && a.lon !== undefined) {
        const d = distanceBearing(state.home.lat, state.home.lon, a.lat, a.lon);
        set('FROM YOU', `${d.km.toFixed(d.km < 10 ? 1 : 0)} km · ${(d.km * 0.539957).toFixed(0)} nmi · ${Math.round(d.deg)}°`);
    }
    else
        set('FROM YOU', state.home ? '—' : 'allow location to see');
    set('HEARD', ageText(now - a.seenMs));
    set('FIRST HEARD', `${ageText(now - a.firstMs)} · ${new Date(a.firstMs).toLocaleTimeString()}`);
}
function refreshHits() {
    const el = q('#hits');
    const s = state.sweep;
    if (!el || !s)
        return;
    const row = lastSweepRow;
    if (!row.length)
        return;
    const sorted = Float32Array.from(row).sort();
    const floor = sorted[sorted.length >> 1];
    const hits = [];
    for (let i = 0; i < row.length;) {
        if (row[i] - floor >= state.threshold) {
            let peak = row[i], pi = i, j = i;
            while (j < row.length && row[j] - floor >= state.threshold) {
                if (row[j] > peak) {
                    peak = row[j];
                    pi = j;
                }
                j++;
            }
            hits.push([peak - floor, `${((s.start + pi * (lastSweepBinHz || state.sweepRate / 512)) / 1e6).toFixed(4)} MHz  +${(peak - floor).toFixed(0)} dB`]);
            i = j;
        }
        else
            i++;
    }
    hits.sort((a, b) => b[0] - a[0]);
    el.innerHTML = hits.length ? hits.slice(0, 200).map(([, l], i) => `<div class="li tap ${i % 2 ? 'alt' : ''}" data-hit="${l.split(' ')[0]}">${l}</div>`).join('') : '<div class="empty">nothing above the threshold yet</div>';
    qa('[data-hit]', el).forEach(d => d.onclick = () => { const mhz = Number(d.dataset.hit); listen(mhz * 1e6, mhz > 87 && mhz < 108 ? 'WFM' : 'NFM'); });
    const t = q('#sweep-title');
    if (t)
        t.textContent = t.textContent.replace(/( · \d+ hits)?$/, ` · ${hits.length} hits`);
}
function refreshCapture() {
    const b = q('#rec'), info = q('#rec-info'), el = q('#captures');
    if (b) {
        b.textContent = state.capturing ? '■ STOP' : '● REC';
        b.classList.toggle('rec', state.capturing);
    }
    if (info)
        info.textContent = state.capturing ? `${(state.captureBytes / 1e6).toFixed(1)} MB · ${state.captureName}` : `${state.rate / 1e6} Msps · ${(state.rate * 2 / 1e6).toFixed(1)} MB/s`;
    if (el)
        el.innerHTML = state.captures.length ? state.captures.map((f, i) => `<div class="li row2 ${i % 2 ? 'alt' : ''}"><span class="tap" data-dl="${f.name}">${f.name}  ${(f.size / 1e6).toFixed(1)} MB</span><button class="link" data-del="${f.name}">✕</button></div>`).join('') : '<div class="empty">no captures yet</div>';
    qa('[data-dl]').forEach(d => d.onclick = () => worker?.postMessage({ type: 'capture', cmd: 'get', name: d.dataset.dl }));
    qa('[data-del]').forEach(d => d.onclick = () => worker?.postMessage({ type: 'capture', cmd: 'remove', name: d.dataset.del }));
}
function esc(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function ensureWorker() {
    if (worker)
        return worker;
    worker = new Worker('./dist/dsp.worker.js', { type: 'module' });
    window.mmFeed = (m) => worker.onmessage({ data: m });
    window.mmWorker = (m) => worker.postMessage(m);
    worker.onmessage = (e) => {
        const m = e.data;
        switch (m.type) {
            case 'spectrum':
                if (scope) {
                    scope.setScale(m.floorDb, m.rangeDb);
                    scope.push(m.bins);
                }
                break;
            case 'health':
                lastHealth = m.line;
                lastLevel = m.levelDb;
                refreshReadout();
                agcStep(m.rms);
                log(`${state.board || 'HackRF'} ${m.line}`);
                if (m.audio)
                    log(`audio: peak=${Math.round(m.audioPeak)}/32000 ${m.audioPeak > 2500 ? '— demod producing audio' : '— silent (no modulation / no signal)'}`);
                break;
            case 'log':
                log(m.line);
                break;
            case 'packet': {
                if (state.app === 'ham') {
                    const s = state.ham.sat;
                    s.packets.unshift(`${new Date().toTimeString().slice(0, 8)} ${m.line}`);
                    if (s.packets.length > 100)
                        s.packets.length = 100;
                    const pk = q('#sat-packet-list');
                    if (pk)
                        pk.innerHTML = s.packets.map((p, i) => `<div class="li ${i % 2 ? 'alt' : ''}">${p}</div>`).join('');
                    break;
                }
                const id = state.app ?? 'x';
                (logs[id] ?? (logs[id] = [])).unshift(m.line);
                if (logs[id].length > 300)
                    logs[id].length = 300;
                counts[id] = (counts[id] ?? 0) + 1;
                refreshList(id);
                if (id === 'ais')
                    refreshAis();
                else if (id === 'aprs')
                    refreshAprs();
                break;
            }
            case 'rds':
                lastRds = m;
                drawRds();
                break;
            case 'hd':
                lastHd = m;
                console.log('[hd]', JSON.stringify(m));
                drawHd();
                break;
            case 'same':
                onSameAlert(m);
                break;
            case 'table':
                state.aisTable = m.rows;
                refreshAis();
                break;
            case 'stations':
                state.aprsStations = m.rows;
                refreshAprs();
                break;
            case 'fmTap':
                window.mmFmTap = { rate: m.rate, samples: m.samples };
                log(`fm tap: ${m.samples.length} samples @ ${m.rate}`);
                break;
            case 'aircraft':
                state.aircraft = m.list;
                state.frames = m.frames;
                refreshAdsb();
                break;
            case 'tune':
                tune(m.hz);
                break;
            case 'geoscan': {
                const g = state.psat.pic;
                g.frames = m.frames;
                g.bad = m.bad;
                g.high = m.high;
                g.complete = m.complete;
                g.fragments = m.fragments;
                const jpeg = m.jpeg;
                if (jpeg && jpeg.length) {
                    if (g.url)
                        URL.revokeObjectURL(g.url);
                    g.url = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
                }
                refreshPacketSats();
                break;
            }
            case 'r433': {
                const r = state.r433;
                const d = m;
                const i = r.heard.findIndex(x => x.key === d.key);
                if (i >= 0)
                    r.heard[i] = d;
                else
                    r.heard.push(d);
                refreshR433();
                break;
            }
            case 'r433stats': {
                state.r433.stats = m;
                refreshR433();
                break;
            }
            case 'r433list': {
                state.r433.protocols = m.protocols;
                drawR433();
                break;
            }
            case 'packetsat': {
                const p = state.psat;
                p.frames = m.frames;
                p.heard = m.heard;
                p.bad = m.bad;
                refreshPacketSats();
                break;
            }
            case 'orbcomm': {
                const o = state.orb;
                o.sats = m.sats;
                o.frames = m.frames;
                o.packets = m.packets;
                o.bad = m.bad;
                o.syncs = m.syncs;
                if (o.sel < 0 && o.sats.length)
                    o.sel = o.sats[0].id;
                orbName();
                refreshOrbcomm();
                break;
            }
            case 'voice': {
                const p = state.prowl;
                p.score = m.score;
                if (p.score > p.best)
                    p.best = p.score;
                p.parts = `band ${m.band.toFixed(2)} · rhythm ${m.mod.toFixed(3)} · swing ${m.vary.toFixed(1)} dB · level ${m.levelDb.toFixed(0)} dB`;
                break;
            }
            case 'sq':
                if (m.open !== state.sqOpen) {
                    state.sqOpen = m.open;
                    refreshSquelch();
                }
                break;
            case 'signals':
                if (scope && state.app !== 'lookingglass' && state.app !== 'search') {
                    const c = spanCenter();
                    lastSignals = m.list;
                    window.mmSignals = lastSignals;
                    launchAutoPick();
                    scope.setSignals(m.list.map(s => ({ frac: 0.5 + (s.hz - c) / state.rate, val: s.val, text: `${(s.hz / 1e6).toFixed(3)}${s.cls ? ` ${s.cls}${s.conf < 0.6 ? '?' : ''}` : ''} ${Math.round(s.db)}dB` })));
                }
                break;
            case 'monitor':
                onMonitor(m);
                break;
            case 'digi': {
                const g = state.ham.digi;
                g.text += m.text;
                if (g.text.length > 4000)
                    g.text = g.text.slice(-3000);
                const el = q('#digi-text');
                if (el) {
                    el.textContent = g.text;
                    el.scrollTop = el.scrollHeight;
                }
                break;
            }
            case 'digiStatus': {
                const g = state.ham.digi;
                g.winner = m.winner;
                g.conf = m.conf;
                g.wpm = m.wpm;
                const st = q('#digi-status');
                const conf = g.mode === 'auto' ? g.conf : g.conf.filter(([n]) => n.toLowerCase() === g.mode);
                const wpm = g.wpm && (g.mode === 'auto' || g.mode === 'cw') ? ` · ${g.wpm} WPM` : '';
                const head = g.mode === 'auto' ? (g.winner ? `AUTO → ${g.winner}` : 'AUTO · listening') : g.mode.toUpperCase();
                if (st)
                    st.textContent = head + conf.map(([n, c]) => ` · ${n} ${c}%`).join('') + wpm;
                break;
            }
            case 'ft8': {
                const g = state.ham.digi;
                g.ft8.unshift(...m.list);
                if (g.ft8.length > 200)
                    g.ft8.length = 200;
                refreshFt8();
                break;
            }
            case 'dmr':
                state.ham.digi.dmr = m.status;
                refreshDmr();
                break;
            case 'p25':
                state.ham.digi.p25 = m.status;
                refreshP25();
                break;
            case 'sstv':
                onSstv(m);
                break;
            case 'apt':
                onApt(m);
                break;
            case 'lrpt':
                onLrpt(m);
                break;
            case 'lrptStats':
                onLrptStats(m);
                break;
            case 'ham':
                Object.assign(state.ham, { db: m.db, floor: m.floor, open: m.open, tone: m.tone, toneDb: m.toneDb, dcs: m.dcs, dcsInv: m.dcsInv, gain: m.gain, audioPeak: m.audioPeak });
                refreshHamMeter();
                break;
            case 'sweepProgress': {
                if (state.sweep)
                    state.sweep.steps = m.steps;
                const t = q('#sweep-title');
                if (t)
                    t.textContent = sweepTitle(m.progress, m.sweeps) + (state.app === 'search' ? t.textContent.replace(/^.*?(?= · \d+ hits|$)/, '') : '');
                break;
            }
            case 'sweepLive': {
                const s = sweepScope;
                if (!s)
                    break;
                const slice = m.slice, keep = slice.length, steps = m.steps;
                if (sweepLiveRow.length !== steps * keep)
                    sweepLiveRow = new Float32Array(steps * keep);
                sweepLiveRow.set(slice, m.step * keep);
                const now = performance.now();
                if (now - lastLiveSpec > 110) {
                    lastLiveSpec = now;
                    const sorted = Float32Array.from(sweepLiveRow).sort();
                    s.setScale(sorted[sorted.length >> 1] - 4, 30);
                    s.setSpectrum(rowToSpec(sweepLiveRow, s.cols));
                }
                break;
            }
            case 'sweep': {
                lastSweepRow = m.row;
                lastSweepBinHz = m.binHz;
                if (state.sweep)
                    state.sweep.steps = m.steps;
                const s = sweepScope;
                if (s) {
                    const sorted = Float32Array.from(m.row).sort();
                    s.setScale(sorted[sorted.length >> 1] - 4, 30);
                    s.push(rowToSpec(m.row, s.cols));
                    s.setLabels(rangeLabels(m.startHz, m.endHz, s.cols > 900 ? 7 : 5));
                }
                const t = q('#sweep-title');
                if (t)
                    t.textContent = sweepTitle(0, m.sweeps);
                refreshHits();
                break;
            }
            case 'capture':
                state.capturing = m.recording;
                state.captureName = m.name;
                state.captureBytes = m.bytes;
                refreshCapture();
                break;
            case 'captures':
                state.captures = m.files;
                refreshCapture();
                break;
            case 'captureFile': {
                const f = m.file;
                const url = URL.createObjectURL(f);
                const a = document.createElement('a');
                a.href = url;
                a.download = m.name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                if (m.sidecar) {
                    const b = new Blob([m.sidecar], { type: 'text/plain' });
                    const u2 = URL.createObjectURL(b);
                    const a2 = document.createElement('a');
                    a2.href = u2;
                    a2.download = m.name.replace(/\.c8$/, '.txt');
                    setTimeout(() => { a2.click(); setTimeout(() => URL.revokeObjectURL(u2), 60000); }, 500);
                }
                break;
            }
        }
    };
    worker.postMessage({ type: 'config', rate: state.rate, mode: state.mode, squelch: state.squelch, specBins: scope?.cols, centreHz: spanCenter() });
    lastCenterSent = spanCenter();
    if (audioPort) {
        worker.postMessage({ type: 'audioPort', port: audioPort }, [audioPort]);
        audioPort = null;
    }
    return worker;
}
async function ensureAudio() {
    if (!audioCtx) {
        audioCtx = new AudioContext({ sampleRate: 48000 });
        await audioCtx.audioWorklet.addModule('./audio-worklet.js');
        const node = new AudioWorkletNode(audioCtx, 'mayhem-player', { outputChannelCount: [1] });
        muteGain = audioCtx.createGain();
        muteGain.gain.value = state.muted ? 0 : 1;
        node.connect(muteGain);
        muteGain.connect(audioCtx.destination);
        const ch = new MessageChannel();
        node.port.postMessage({ port: ch.port1 }, [ch.port1]);
        audioPort = ch.port2;
        if (worker) {
            worker.postMessage({ type: 'audioPort', port: audioPort }, [audioPort]);
            audioPort = null;
        }
    }
    try {
        await audioCtx.resume();
    }
    catch { }
    armAudioResume();
}
let audioArmed = false;
function armAudioResume() {
    if (audioArmed)
        return;
    audioArmed = true;
    const go = () => { if (audioCtx && audioCtx.state !== 'running')
        void audioCtx.resume(); };
    for (const ev of ['pointerdown', 'keydown', 'touchend'])
        addEventListener(ev, go, { once: false, passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden)
        go(); });
    addEventListener('focus', go);
}
function wakeAudio() {
    if (audioCtx && audioCtx.state !== 'running')
        void audioCtx.resume();
}
async function connect(dev) {
    const btn = $('connect');
    if (radio?.running) {
        radio.stop();
        btn.textContent = 'CONNECT';
        return;
    }
    hideHint();
    try {
        const d = dev ?? await HackRf.remembered() ?? (RTLSDR_READY ? await RtlSdr.remembered() : undefined)
            ?? await navigator.usb.requestDevice({ filters: [...HACKRF_FILTERS, ...(RTLSDR_READY ? RTLSDR_FILTERS : [])] });
        if (isMayhemSerial(d)) {
            log('That is a PortaPack in Mayhem serial mode.');
            setStatus('PortaPack in Mayhem mode — switching…', false);
            if (!(await portapackToHackRf())) {
                setStatus('PortaPack in serial mode — tap HackRF on its screen', false);
                showHint(new Error('PortaPack in Mayhem mode. On the PortaPack, choose HackRF mode; on a desktop browser CONNECT can do it for you over the serial shell.'));
            }
            return;
        }
        await ensureAudio();
        const w = ensureWorker();
        const events = {
            onIq: (buf) => w.postMessage({ type: 'iq', buf: buf.buffer }, [buf.buffer]),
            onLog: log,
        };
        if (isRtlSdr(d)) {
            if (!RTLSDR_READY) {
                log('RTL-SDR support is switched off: the driver brings the dongle up but hears almost nothing, and the input routing is still being chased. Use a HackRF for now.');
                setStatus('RTL-SDR support is not ready yet', false);
                return;
            }
            await connectRtl(d, events);
            return;
        }
        const r = new HackRf(d, {
            ...events,
            onStatus: s => {
                ackTune(s);
                const newBoard = state.board !== r.board;
                state.board = r.board;
                state.firmware = r.firmware;
                setStatus(s, true);
                if (!state.app)
                    $('sub').textContent = `HackRF · ${r.board} · ${r.firmware}`;
                if (newBoard && isPro() && !state.gainsScaled) {
                    const [l, v, a] = boardGains(state.lna, state.vga, state.amp);
                    state.gainsScaled = true;
                    setGains(l, v, a);
                    log(`HackRF Pro: gains scaled to LNA ${l} / VGA ${v}${a ? ' / amp' : ''} (One presets sit under 1 ADC count on a Pro)`);
                }
            },
        });
        r.targetFreqHz = state.freq;
        r.targetRateHz = state.rate;
        r.setGain(state.lna, state.vga, state.amp);
        radio = r;
        refreshLauncherLimits();
        applyLauncherView();
        await r.open();
        btn.textContent = 'DISCONNECT';
        hideHint();
        await r.run();
    }
    catch (e) {
        const err = e;
        log(`connect failed: ${err.message}`);
        setStatus(err.name === 'NotFoundError' ? 'no device chosen' : `error: ${err.message}`, false);
        showHint(err);
    }
    finally {
        btn.textContent = 'CONNECT';
        setStatus(state.board ? `${state.board} disconnected` : 'disconnected', false);
        radio = null;
        refreshLauncherLimits();
    }
}
async function connectRtl(d, events) {
    const btn = $('connect');
    const r = new RtlSdr(d, {
        ...events,
        onStatus: s => { ackTune(s); state.board = r.label; state.firmware = r.tuner; setStatus(s, true); if (!state.app)
            $('sub').textContent = r.label; },
    });
    r.targetFreqHz = state.freq;
    r.targetRateHz = nearestRate(r.limits, state.rate);
    r.setGain(state.lna, state.vga, state.amp);
    radio = r;
    refreshLauncherLimits();
    applyLauncherView();
    if (r.targetRateHz !== state.rate) {
        state.rate = r.targetRateHz;
        worker?.postMessage({ type: 'config', rate: state.rate });
        refreshReadout();
    }
    await r.open();
    btn.textContent = 'DISCONNECT';
    hideHint();
    await r.run();
}
function platform() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua))
        return 'android';
    if (/Windows/i.test(ua))
        return 'windows';
    if (/Mac OS X|Macintosh/i.test(ua))
        return 'mac';
    if (/Linux|CrOS/i.test(ua))
        return 'linux';
    return 'other';
}
function showHint(err) {
    const os = platform();
    const box = $('hint');
    const notListed = err.name === 'NotFoundError';
    const busy = /claim|access denied|busy|in use|failed to open/i.test(err.message) || err.name === 'NetworkError' || err.name === 'SecurityError';
    let text = '';
    if (notListed) {
        text = 'The chooser showed no HackRF or RTL-SDR. Check the USB cable carries data, then: ';
        if (os === 'windows')
            text += 'on Windows the radio must be bound to the WinUSB driver — run Zadig, pick "HackRF One" (or for an RTL-SDR the "Bulk-In, Interface (Interface 0)" entry), choose WinUSB, Replace Driver (a libusbK or libusb-win32 binding hides it from the browser).';
        else if (os === 'linux')
            text += 'on Linux add the udev rule the hackrf package ships (53-hackrf.rules) or run the browser as a user in the plugdev group, then replug.';
        else if (os === 'mac')
            text += 'on macOS nothing needs installing — try another cable or port, and make sure a PortaPack is in HackRF mode, not Mayhem serial mode.';
        else if (os === 'android')
            text += 'on Android use a data-capable OTG cable or a powered OTG hub; a PortaPack must be in HackRF mode.';
        else
            text += 'make sure a PortaPack is in HackRF mode.';
    }
    else if (busy) {
        text = `Could not claim the HackRF (${err.message}). Another program probably has it open — close SDR++, SDRangel, GQRX, hackrf_transfer or a second browser tab, then reconnect.`;
        if (os === 'windows')
            text += ' On Windows also confirm the WinUSB driver binding (Zadig).';
    }
    else
        return;
    box.textContent = text;
    box.hidden = false;
    if (hintTimer)
        clearTimeout(hintTimer);
    hintTimer = window.setTimeout(hideHint, 15000);
}
let hintTimer = 0;
function hideHint() {
    const b = q('#hint');
    if (b)
        b.hidden = true;
    if (hintTimer) {
        clearTimeout(hintTimer);
        hintTimer = 0;
    }
}
const STEPS = [1e6, 1e5, 1e4, 1e3];
let stepIdx = 1;
function scrollHints() {
    const SEL = '.bandstrip, .launch-side, .controls, .list, .imgwrap';
    const update = (el) => {
        const h = el.scrollWidth - el.clientWidth > 4, v = el.scrollHeight - el.clientHeight > 4;
        el.classList.toggle('sh-can-l', h && el.scrollLeft > 2);
        el.classList.toggle('sh-can-r', h && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
        el.classList.toggle('sh-can-t', v && el.scrollTop > 2);
        el.classList.toggle('sh-can-b', v && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    };
    const arm = () => {
        for (const el of qa(SEL)) {
            let hints = el.querySelectorAll(':scope > .sh');
            if (hints.length !== 4) {
                hints.forEach(h => h.remove());
                for (const k of ['l', 't', 'r', 'b']) {
                    const i = document.createElement('i');
                    i.className = `sh sh-${k}`;
                    if (k === 'l' || k === 't')
                        el.prepend(i);
                    else
                        el.append(i);
                }
            }
            else {
                const r = el.querySelector(':scope > .sh-r'), b = el.querySelector(':scope > .sh-b');
                if (b !== el.lastElementChild || r !== b.previousElementSibling) {
                    el.append(r);
                    el.append(b);
                }
            }
            update(el);
        }
    };
    let arming = false;
    const rearm = () => { if (arming)
        return; arming = true; try {
        arm();
    }
    finally {
        arming = false;
    } };
    new MutationObserver(rearm).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', rearm);
    document.addEventListener('scroll', (e) => { const el = e.target; if (el instanceof HTMLElement && el.matches(SEL))
        update(el); }, true);
    arm();
}
function bindDesktop() {
    window.addEventListener('keydown', (e) => {
        if (e.target?.tagName === 'INPUT')
            return;
        const tunable = !state.app || state.app === 'audio' || state.app === 'capture' || state.app === 'pager' || state.app === 'aprs' || state.app === 'ais' || state.app === 'ert' || state.app === 'acars' || state.app === 'tpms' || state.app === 'subghz' || state.app === 'devices';
        if ((tunable || state.app === 'ham') && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.,fF]$/.test(e.key)) {
            freqEntry(/[fF]/.test(e.key) ? '' : e.key);
            e.preventDefault();
            return;
        }
        switch (e.key) {
            case 'ArrowLeft':
                if (tunable) {
                    tune(state.freq - STEPS[stepIdx]);
                    e.preventDefault();
                }
                break;
            case 'ArrowRight':
                if (tunable) {
                    tune(state.freq + STEPS[stepIdx]);
                    e.preventDefault();
                }
                break;
            case 'ArrowUp':
                stepIdx = Math.max(0, stepIdx - 1);
                log(`tune step ${STEPS[stepIdx] / 1e6} MHz`);
                e.preventDefault();
                break;
            case 'ArrowDown':
                stepIdx = Math.min(STEPS.length - 1, stepIdx + 1);
                log(`tune step ${STEPS[stepIdx] / 1e6} MHz`);
                e.preventDefault();
                break;
            case 'm':
            case 'M':
                if (state.app === 'audio') {
                    const modes = ['WFM', 'NFM', 'AM', 'USB', 'LSB'];
                    setMode(modes[(modes.indexOf(state.mode) + 1) % modes.length]);
                }
                break;
            case 'a':
            case 'A':
                setGains(state.lna, state.vga, !state.amp);
                break;
            case '[':
                manualGains(state.lna - 8, state.vga, state.amp);
                break;
            case ']':
                manualGains(state.lna + 8, state.vga, state.amp);
                break;
            case '-':
            case '_':
                manualGains(state.lna, state.vga - 2, state.amp);
                break;
            case '=':
            case '+':
                manualGains(state.lna, state.vga + 2, state.amp);
                break;
            case 'g':
            case 'G':
                setAgc(!state.agc);
                break;
            case 's':
            case 'S':
                if (state.app === 'audio')
                    setSquelch([0, 6, 12, 20][([0, 6, 12, 20].indexOf(state.squelch) + 1) % 4]);
                break;
            case 'b':
            case 'B':
                if (state.app === 'audio')
                    addBookmark();
                break;
            case ' ':
                if (state.app === 'audio') {
                    setScanning(!state.scanning);
                    e.preventDefault();
                }
                break;
            case 'c':
            case 'C':
                void connect();
                break;
            case 'l':
            case 'L':
                $('log-toggle').click();
                break;
            case 'x':
            case 'X':
                toggleMute();
                break;
            case 't':
            case 'T':
                $('tools').click();
                break;
            case 'Escape':
                if (state.app)
                    open(null);
                break;
        }
    });
    let drag = null;
    document.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0)
            return;
        const el = e.target.closest?.('.bandstrip, .list, .imgwrap, .digitext');
        if (!el || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight))
            return;
        drag = { el, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
    });
    document.addEventListener('pointermove', (e) => {
        if (!drag)
            return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 6)
            return;
        drag.moved = true;
        drag.el.classList.add('dragging');
        drag.el.scrollLeft = drag.left - dx;
        drag.el.scrollTop = drag.top - dy;
    });
    const endDrag = () => { if (!drag)
        return; const d = drag; drag = null; if (d.moved) {
        setTimeout(() => d.el.classList.remove('dragging'), 0);
    } };
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    document.addEventListener('click', (e) => { const el = e.target.closest?.('.dragging'); if (el) {
        e.stopPropagation();
        e.preventDefault();
    } }, true);
    document.addEventListener('click', (e) => {
        const d = e.target.closest?.('.fd');
        if (!d)
            return;
        const r = d.getBoundingClientRect();
        nudgeDigit(d, e.clientY < r.top + r.height / 2 ? 1 : -1);
    });
    document.addEventListener('keydown', (e) => {
        const d = document.activeElement;
        if (!d?.classList.contains('fd'))
            return;
        if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
            nudgeDigit(d, 1);
            e.preventDefault();
        }
        else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') {
            nudgeDigit(d, -1);
            e.preventDefault();
        }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const ds = qa('#freq .fd');
            const i = ds.indexOf(d);
            const n = ds[i + (e.key === 'ArrowLeft' ? -1 : 1)];
            if (n)
                n.focus();
            e.preventDefault();
        }
        else if (/^[0-9]$/.test(e.key)) {
            const w = Number(d.dataset.w);
            const cur = Math.floor(state.freq / w) % 10;
            tune(state.freq + (Number(e.key) - cur) * w);
            const ds = qa('#freq .fd');
            ds[ds.indexOf(d) + 1]?.focus();
            e.preventDefault();
        }
    });
    window.addEventListener('wheel', (e) => {
        const t = e.target;
        const d = t.closest?.('.fd');
        if (d) {
            e.preventDefault();
            nudgeDigit(d, e.deltaY < 0 ? 1 : -1);
            return;
        }
        if (!t.closest?.('.scope') || state.app === 'lookingglass' || state.app === 'search' || state.app === 'adsb' || state.app === 'btle')
            return;
        if (e.ctrlKey || e.metaKey)
            return;
        e.preventDefault();
        if (e.altKey) {
            stepIdx = e.deltaY > 0 ? Math.min(STEPS.length - 1, stepIdx + 1) : Math.max(0, stepIdx - 1);
            return;
        }
        scope?.holdView();
        wheelAcc += e.deltaY;
        const notches = Math.trunc(wheelAcc / 100);
        if (!notches)
            return;
        wheelAcc -= notches * 100;
        const step = wheelStep(), raster = rasterStep(), cur = state.app === 'ham' ? state.ham.freq : state.freq;
        tune(Math.round((cur - notches * (e.shiftKey ? 10 : 1) * step) / raster) * raster);
    }, { passive: false });
}
let versionText = 'dev build', apkUrl = './mayhem.apk', releaseUrl = 'https://github.com/RocketGod-git/mayhem-mobile/releases/tag/latest';
function init() {
    loadSkin();
    const supported = 'usb' in navigator;
    $('unsupported').hidden = supported;
    $('connect').disabled = !supported;
    if (!supported)
        setStatus('WebUSB not available in this browser', false);
    $('connect').onclick = () => connect();
    $('tools').onclick = () => setTools(!$('toolbar').classList.contains('open'));
    $('mute').onclick = toggleMute;
    $('home').onclick = () => { if (state.app)
        open(null); };
    $('settings-btn').onclick = () => open('settings');
    setTools(true);
    $('hint').onclick = () => hideHint();
    bindDesktop();
    scrollHints();
    const panel = $('log-panel'), body = $('log');
    const refreshLog = () => { $('log-head').textContent = logHeader(); body.textContent = diag.join('\n'); if (logFollow)
        body.scrollTop = body.scrollHeight; };
    $('log-toggle').onclick = () => { panel.hidden = !panel.hidden; $('log-toggle').classList.toggle('on', !panel.hidden); if (!panel.hidden)
        refreshLog(); };
    $('log-close').onclick = () => { panel.hidden = true; $('log-toggle').classList.remove('on'); };
    $('log-clear').onclick = () => { diag.length = 0; refreshLog(); };
    $('log-pip').onclick = () => {
        const pip = panel.classList.toggle('pip');
        $('log-pip').textContent = pip ? 'FULL' : 'PIP';
        if (pip) {
            panel.style.left = '12px';
            panel.style.top = '12px';
        }
        else {
            panel.style.left = panel.style.top = '';
        }
    };
    body.addEventListener('scroll', () => { logFollow = body.scrollTop + body.clientHeight >= body.scrollHeight - 4; });
    $('log-save').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
        a.download = `mayhem-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
        a.click();
        URL.revokeObjectURL(a.href);
    };
    $('log-share').onclick = async () => {
        const file = new File([logText()], 'mayhem.log', { type: 'text/plain' });
        try {
            if (navigator.canShare?.({ files: [file] })) {
                await navigator.share({ files: [file], title: 'Mayhem Mobile log' });
                return;
            }
            if (navigator.share) {
                await navigator.share({ title: 'Mayhem Mobile log', text: logText().slice(0, 4000) });
                return;
            }
            await navigator.clipboard.writeText(logText());
            log('log copied to the clipboard');
        }
        catch { }
    };
    let dragging = false, dx = 0, dy = 0;
    const bar = $('log-bar');
    bar.addEventListener('pointerdown', e => {
        if (!panel.classList.contains('pip'))
            return;
        dragging = true;
        bar.setPointerCapture(e.pointerId);
        dx = e.clientX - panel.offsetLeft;
        dy = e.clientY - panel.offsetTop;
    });
    bar.addEventListener('pointermove', e => {
        if (!dragging)
            return;
        panel.style.left = `${Math.max(0, Math.min(innerWidth - panel.offsetWidth, e.clientX - dx))}px`;
        panel.style.top = `${Math.max(0, Math.min(innerHeight - panel.offsetHeight, e.clientY - dy))}px`;
    });
    bar.addEventListener('pointerup', () => { dragging = false; });
    $('title').onclick = () => { if (state.app)
        open(null); };
    window.addEventListener('popstate', () => { if (state.app)
        open(null); });
    window.addEventListener('resize', () => { scope?.draw(); sweepScope?.draw(); });
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
    fetch('./version.json', { cache: 'no-store' }).then(r => r.json()).then((v) => {
        versionText = `v${v.version} · ${v.commit}`;
        apkUrl = v.apk;
        releaseUrl = v.release;
        const ve = q('#version');
        if (ve)
            ve.textContent = versionText;
        const a = q('#apk');
        if (a)
            a.href = apkUrl;
        const rl = q('#release-link');
        if (rl)
            rl.href = releaseUrl;
    }).catch(() => undefined);
    open(null);
    if (supported) {
        (async () => await HackRf.remembered() ?? (RTLSDR_READY ? await RtlSdr.remembered() : undefined))().then(d => {
            if (!d || radio)
                return;
            const what = isRtlSdr(d) ? 'RTL-SDR' : 'HackRF';
            setStatus(`${what} remembered — connecting…`, false);
            void connect(d).catch(() => setStatus(`${what} remembered — tap CONNECT`, false));
        }).catch(() => undefined);
        navigator.usb.addEventListener('connect', (e) => { log(`USB attached: ${e.device.productName ?? ''}`); if (!radio)
            setStatus(`${isRtlSdr(e.device) ? 'RTL-SDR' : 'HackRF'} attached — tap CONNECT`, false); });
        navigator.usb.addEventListener('disconnect', (e) => { log(`USB detached: ${e.device.productName ?? ''}`); radio?.stop(); });
    }
    if ('serviceWorker' in navigator)
        navigator.serviceWorker.register('./sw.js').catch(() => undefined);
    log('Mayhem Mobile web ready');
}
init();
