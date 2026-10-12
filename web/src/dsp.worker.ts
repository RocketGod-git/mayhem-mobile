/**
 * DSP worker — the browser twin of core/SdrEngine.kt. Receives signed-int8 IQ, produces the spectrum row, the
 * once/sec RX-health line, WFM / NFM / AM / USB / LSB audio to the AudioWorklet, and feeds the active app's
 * IqProcessor (raw IQ + the NFM discriminator tap for the FM-borne packet modes).
 */
import { fft, hann, loadIqAt, accumulatePower, powerDbFrom } from './fft.js';
import type { Emit, IqProcessor } from './dsp/core.js';
import { AdsbDecoder } from './dsp/adsb.js';
import { AisDecoder } from './dsp/ais.js';
import { AprsDecoder } from './dsp/aprs.js';
import { BtleDecoder } from './dsp/btle.js';
import { ErtDecoder } from './dsp/ert.js';
import { PocsagDecoder } from './dsp/pocsag.js';
import { FlexDecoder } from './dsp/flex.js';
import { SweepProcessor } from './dsp/sweep.js';
import { TpmsDecoder } from './dsp/tpms.js';
import { AcarsDecoder } from './dsp/acars.js';
import { IsmDecoder } from './dsp/ism/ism.js';
import { R433Processor, protocolList } from './dsp/r433/index.js';
import { IqRecorder } from './dsp/capture.js';
import { HamDemod } from './dsp/ham/demod.js';
import { BandMonitor } from './dsp/ham/monitor.js';
import { Classifier } from './dsp/ham/classify.js';
import { VoiceDetector } from './dsp/voice.js';
import { OrbcommDecoder } from './dsp/orbcomm.js';
import { G3ruhDecoder } from './dsp/g3ruh.js';
import { RdsDecoder } from './dsp/rds.js';
import { HdDetector } from './dsp/hdradio.js';
import { SameDecoder } from './dsp/same.js';
import { GeoscanDecoder } from './dsp/geoscan.js';
import { CwDecoder, RttyDecoder, Psk31Decoder, type DigitalDecoder } from './dsp/ham/digital.js';
import { Ft8Decoder } from './dsp/ham/ft8.js';
import { DmrDecoder } from './dsp/ham/dmr.js';
import { SstvDecoder } from './dsp/ham/sstv.js';
import { AptDecoder } from './dsp/ham/apt.js';
import { LrptDecoder } from './dsp/ham/lrpt.js';
import type { FmTap } from './dsp/ham/demod.js';

type Mode = 'WFM' | 'NFM' | 'AM' | 'USB' | 'LSB' | 'NONE';

const post = (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage.bind(self);
const emit: Emit = (m, t) => post(m, t);

// Spectrum: Hann FFTs sized to the screen (2 × the requested column count, 2048..16384 points), power-averaged over
// every sample that arrives between frames (a 30 Hz frame at 2 Msps averages ~65 k samples), peak-downsampled to
// `bins`. Averaging pulls the noise spread down to a dB or two so an FM station that is only ~8 dB/bin above the
// floor stands out; the floor is the spectrum's median (robust to strong carriers), the display range is
// SPEC_RANGE_DB above it. The UI sets `specBins` from its column count.
const SPEC_INTERVAL_MS = 33, SPEC_RANGE_DB = 40, SPEC_FLOOR_PAD_DB = 4, AUDIO_RATE = 48_000;
let fftN = 2048, bins = 1024;
let rate = 2_000_000;
let mode: Mode = 'WFM';
let audioPort: MessagePort | null = null;
let processor: IqProcessor | null = null;
let lastProc: IqProcessor | null = null;
let lastProcRate = 0;

// decoders are singletons so their state (aircraft, vessels, GPS reference) survives leaving and re-entering
const adsb = new AdsbDecoder(emit);
const ais = new AisDecoder(emit);
const aprs = new AprsDecoder(emit);
const pocsag = new PocsagDecoder(emit);
const flex = new FlexDecoder(emit);
/** Pager RX: FLEX first (the default), POCSAG optionally alongside on the same discriminator (what PDW does). */
let pagerWhich: 'flex' | 'pocsag' | 'both' = 'flex';
const pager: IqProcessor = {
  wantsFm: true,
  reset() { pocsag.reset(); flex.reset(); },
  onIq() {},
  onFm(sm, n, r) { if (pagerWhich !== 'pocsag') flex.onFm(sm, n, r); if (pagerWhich !== 'flex') pocsag.onFm(sm, n, r); },
};
const ert = new ErtDecoder(emit);
const btle = new BtleDecoder(emit);
const tpms = new TpmsDecoder(emit);
const acars = new AcarsDecoder(emit);
const ism = new IsmDecoder(emit);
/** The rtl_433 port: every registered protocol, run over every burst found anywhere in the sampled span. */
const r433 = new R433Processor(emit);
// RDS rides the WFM composite: it is not a `processor`, it taps the discriminator output in the audio path when a
// broadcast station is tuned, so the audio app can show a station-name / RadioText ticker without a mode of its own.
const rds = new RdsDecoder(st => post({ type: 'rds', ps: st.ps, rt: st.rt, pty: st.pty, ptyName: st.ptyName, pi: st.pi, tp: st.tp, ta: st.ta, af: st.af, synced: st.synced }));
let rdsOn = false; const rdsBuf = new Float32Array(8192); let rdsN = 0;
// HD Radio: the digital sidebands beside a broadcast-FM station, detected from the raw IQ (they are outside the
// audio path's channel filter). Off unless the audio app asks; it costs a sideband's worth of filtering.
const hd = new HdDetector(r => post({ type: 'hd', ...r }));
let hdOn = false;
// SAME / EAS weather-radio alerts ride the NFM discriminator the same way, tapped only while the audio app asks
// for it (NOAA weather radio is NFM at 162 MHz), so it costs nothing elsewhere.
const same = new SameDecoder(emit);
let sameOn = false, sameRate = 0; const sameBuf = new Float32Array(4096); let sameN = 0;
const recorder = new IqRecorder(emit);
/** The HAM receiver writes its own 48 kHz audio straight to the AudioWorklet port (the worker's demod is off). */
let audioChunks = 0;
const vBuf = new Float32Array(1);
const toAudio = (chunk: Float32Array) => { audioChunks++; if (audioPort) audioPort.postMessage(chunk, [chunk.buffer]); };
const ham = new HamDemod(emit, toAudio);
const orbcomm = new OrbcommDecoder(emit);
const g3ruh = new G3ruhDecoder(emit);
const geoscan = new GeoscanDecoder(emit);
const monitor = new BandMonitor(emit, toAudio);
const classifier = new Classifier();
// digital decoders on the HAM audio; 'auto' runs the three audio modems together and shows whichever is making sense
const cw = new CwDecoder(600), rtty = new RttyDecoder(), psk = new Psk31Decoder(1000), ft8 = new Ft8Decoder(), sstv = new SstvDecoder();
const digiAll: DigitalDecoder[] = [cw, rtty, psk, ft8, sstv];
sstv.onImage = img => post({ type: 'sstv', ...img }, [img.rows.buffer]);
let digiMode = 'off', digiWinner = '';
for (const d of digiAll) d.onText = (t, meta) => { if (digiMode === d.name.toLowerCase() || (digiMode === 'auto' && (digiWinner === d.name || d.name === 'FT8' || d.name === 'SSTV'))) post({ type: 'digi', from: d.name, text: t, meta }); };
ft8.onDecodes = (list, slot) => post({ type: 'ft8', list, slot });
// DMR runs on the NFM discriminator rather than the audio; its voice replaces the analog audio while it decodes
const dmr = new DmrDecoder();
dmr.onLog = line => { if (dvMode()) post({ type: 'digi', from: 'DMR', text: `${line}\n` }); };
dmr.p25.onLog = line => { if (dvMode()) post({ type: 'digi', from: 'P25', text: `${line}\n` }); };
/** The DIGITAL modes that want the 4FSK receiver running. */
const dvMode = () => digiMode === 'dmr' || digiMode === 'p25' || digiMode === 'auto';
dmr.onAudio = pcm => { const v = ham.params.volume; for (let i = 0; i < pcm.length; i++) pcm[i] *= v; toAudio(pcm); };
// satellite services on the HAM receiver: packet (AX.25 from the ISS and cubesats) and APT images ride the discriminator
const apt = new AptDecoder();
apt.onRow = (row, line) => post({ type: 'apt', line, row }, [row.buffer]);
const satAprs = new AprsDecoder(emit);
const lrpt = new LrptDecoder();
lrpt.onStrip = s => post({ type: 'lrpt', apid: s.apid, line: s.line, x: s.x, pixels: s.pixels }, [s.pixels.buffer]);
lrpt.onStats = s => post({ type: 'lrptStats', stats: s });
lrpt.onLog = line => emit({ type: 'log', line });
let satKind = 'none';
let satTaps: FmTap[] = [];
// AUTO stops looking for DMR once an analog voice channel is evident (a CTCSS tone, or 2.5 s of carrier with no
// checked DMR data) and goes back to plain audio with the normal channel width until the carrier drops
let autoSettled = false, autoCarrierSince = 0;
/** Support hook: records exactly the discriminator stream the HAM decoders see, so an on-air problem can be
 *  replayed offline through the same code. Armed by a `tapFm` message, harvested as an `fmTap` message. */
const hamRec = {
  onFm(samples: Float32Array, n: number, rate: number): void {
    if (!fmTap) return;
    fmTapRate = rate;
    for (let i = 0; i < n && fmTapN < fmTap.length; i++) fmTap[fmTapN++] = samples[i];
    if (fmTapN >= fmTap.length || performance.now() > fmBurstEnd) { const a = fmTap.slice(0, fmTapN); fmTap = null; post({ type: 'fmTap', rate: fmTapRate, samples: a }, [a.buffer]); }
  },
};
function applyTaps(): void { ham.setFmTaps([...(digiMode === 'dmr' || digiMode === 'p25' || (digiMode === 'auto' && !autoSettled) ? [dmr] : []), ...satTaps, hamRec]); }
function setSatService(kind: string): void {
  satKind = kind;
  satTaps = kind === 'packet' ? [satAprs] : kind === 'apt' ? [apt] : kind === 'g3ruh' ? [g3ruh] : kind === 'geoscan' ? [geoscan] : [];
  if (kind === 'apt') apt.reset();
  if (kind === 'packet') satAprs.reset();
  if (kind === 'g3ruh') g3ruh.reset();
  if (kind === 'geoscan') geoscan.reset();
  if (kind === 'lrpt') { lrpt.reset(); ham.iqTaps = [lrpt]; } else ham.iqTaps = [];
  ham.analogMute = digiMode === 'dmr' || kind === 'lrpt';
  applyTaps();
}
function setDigital(mode: string, opts: Record<string, unknown>): void {
  const dvWanted = mode === 'dmr' || mode === 'p25' || mode === 'auto';
  if (dvWanted && !dvMode()) dmr.reset();
  dmr.p25On = mode === 'p25' || mode === 'auto';
  digiMode = mode; autoSettled = false; autoCarrierSince = 0; applyTaps();
  if (typeof opts.dmrSlot === 'number') dmr.slotSel = opts.dmrSlot;
  digiMode = mode;
  ham.analogMute = mode === 'dmr' || mode === 'p25' || satKind === 'lrpt';
  if (typeof opts.pitch === 'number') cw.setPitch(opts.pitch);
  if (typeof opts.pskHz === 'number') psk.setCenter(opts.pskHz);
  if (typeof opts.rttyBaud === 'number') rtty.configure(opts.rttyMark as number ?? 2125, opts.rttyShift as number ?? 170, opts.rttyBaud, !!opts.rttyRev);
  const wanted = mode === 'off' ? [] : mode === 'auto' ? digiAll : mode === 'ft8' ? [ft8] : mode === 'sstv' ? [sstv] : digiAll.filter(d => d.name.toLowerCase() === mode);
  for (const d of wanted) if (!ham.digital.includes(d)) d.reset();
  ham.digital = wanted;
}
setInterval(() => {
  if (digiMode === 'off') return;
  const dv = dvMode() ? dmr.status() : null;
  if (dv) post({ type: 'dmr', status: dv });
  if (dvMode()) post({ type: 'p25', status: dmr.p25.status(dmr.samples) });
  if (digiMode === 'auto') {
    const strong = !!dv?.locked && !!dv?.strong;
    ham.analogMute = strong;
    const was = autoSettled;
    if (!ham.carrier) { autoCarrierSince = 0; autoSettled = false; }
    else if (!strong) { if (!autoCarrierSince) autoCarrierSince = Date.now(); if (ham.tone > 0 || Date.now() - autoCarrierSince > 2500) autoSettled = true; }
    else { autoSettled = false; autoCarrierSince = 0; }
    if (autoSettled !== was) { applyTaps(); if (!autoSettled) dmr.reset(); }
  } else { autoSettled = false; autoCarrierSince = 0; }
  if (ham.digital.length === 0 && !dv) return;
  let best = ham.digital[0]; for (const d of ham.digital) if (d.name !== 'FT8' && d.confidence > best.confidence) best = d;
  if (digiMode === 'auto') digiWinner = dv?.locked ? 'DMR' : best && best.confidence > 0.35 ? best.name : '';
  const conf: [string, number][] = ham.digital.map(d => [d.name, Math.round(d.confidence * 100)]);
  if (dv) conf.push(['DMR', dv.locked ? 100 : 0]);
  post({ type: 'digiStatus', conf, winner: digiMode === 'auto' ? (autoSettled ? 'ANALOG VOICE' : digiWinner) : digiMode.toUpperCase(), wpm: cw.wpm });
}, 700);
let centreHz = 0, specFrame = 0;

let fre = new Float32Array(fftN), fim = new Float32Array(fftN), pdb = new Float32Array(bins);
let win = hann(fftN), acc = new Float32Array(fftN), sortBuf = new Float32Array(bins);
let frames = 0;
let floorEma = NaN;
let prevOut: Float32Array | null = null;
function setSpecBins(n: number): void {
  const b = Math.max(256, Math.min(8192, 1 << Math.ceil(Math.log2(Math.max(1, n)))));
  if (b === bins) return;
  bins = b; fftN = Math.max(2048, Math.min(16384, b * 2));
  fre = new Float32Array(fftN); fim = new Float32Array(fftN); pdb = new Float32Array(bins);
  win = hann(fftN); acc = new Float32Array(fftN); sortBuf = new Float32Array(bins);
  frames = 0; floorEma = NaN; prevOut = null;
}
let lastSpec = 0, lastDiag = 0;
let prevI = 0, prevQ = 0, deemph = 0, amDc = 0, wph = 0;
let dcFmI = 0, dcFmQ = 0;   // slow estimate of the front-end I/Q DC offset, stripped before the NFM discriminator
let lpI1 = 0, lpI2 = 0, lpQ1 = 0, lpQ2 = 0;
/**
 * Channel filter for the plain receiver's NFM / AM paths: a 4th-order Butterworth low-pass (two biquads, run on I
 * and Q) at the decimated rate, just before the discriminator. Without it the discriminator sees the whole
 * ~48 kHz and a packet with 10 dB of SNR in its 12.5 kHz channel sits below the FM threshold.
 */
const chan = { key: '', s: [] as { b0: number; b1: number; b2: number; a1: number; a2: number; zi1: number; zi2: number; zq1: number; zq2: number }[] };
function chanDesign(cutoffHz: number, fs: number): void {
  const key = `${cutoffHz}|${fs}`; if (chan.key === key) return;
  chan.key = key; chan.s = [];
  for (const q of [0.5412, 1.3066]) {
    const w0 = 2 * Math.PI * Math.min(0.45 * fs, cutoffHz) / fs, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0), a0 = 1 + alpha;
    chan.s.push({ b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0, zi1: 0, zi2: 0, zq1: 0, zq2: 0 });
  }
}
let decAcc = 0, decCnt = 0, s1I = 0, s1Q = 0, s1n = 0;
/** Channel offset from the span center for the plain receiver (the view can be slid while the dial stays put). */
let offsetHz = 0, offCr = 1, offCi = 0;
const audioBuf = new Float32Array(2048); let audioLen = 0, audioPeak = 0;
const fmBuf = new Float32Array(4096); let fmN = 0;
/** Diagnostic: collect the discriminator audio for a while, then post it (`tapFm` message). */
let fmTap: Float32Array | null = null, fmTapN = 0, fmTapRate = 0;
// burst mode: keep only the stretches where the discriminator quiets (a carrier is up), with a little pre/post roll
let fmBurst = false, fmBurstEnd = 0, fmPre = new Float32Array(0), fmPreN = 0, fmHold = 0, fmAcc = 0, fmAccN = 0, fmFloor = 0, fmBurstCount = 0;
let prevMode: Mode | null = null;
// squelch: channel power vs a slow noise-floor tracker
let squelchDb = 0, sqFloor = NaN, sqOpen = true, sqLastReport = 0, chPow = 0, chN = 0;
// Is what we are hearing actually a person? The hunting app needs this to tell a dispatcher from a data link.
const voice = new VoiceDetector();
let voiceOn = false, voiceLast = 0;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case 'iq': process(new Int8Array(m.buf as ArrayBuffer)); break;
    case 'config':
      if (typeof m.rate === 'number') rate = m.rate;
      if (typeof m.specBins === 'number') setSpecBins(m.specBins);
      if (typeof m.centreHz === 'number') centreHz = m.centreHz;
      // The channel being demodulated is the span center plus the offset, not the span center.
      orbcomm.channelHz = centreHz + offsetHz;
      if (typeof m.offsetHz === 'number') offsetHz = m.offsetHz;
      if (m.mode) mode = m.mode as Mode;
      if (typeof m.squelch === 'number') { squelchDb = m.squelch; if (squelchDb === 0) sqOpen = true; }
      if (typeof m.voice === 'boolean') { voiceOn = m.voice; if (!voiceOn) voice.reset(); }
      break;
    case 'audioPort': audioPort = m.port as MessagePort; break;
    case 'app': processor = makeProcessor(m.app as string, m); break;
    case 'geo': adsb.ref = { lat: m.lat as number, lon: m.lon as number }; break;
    case 'btleChannel': btle.channel = m.ch as number; break;
    case 'rds': rdsOn = !!m.on; if (!rdsOn) { rds.reset(); rdsN = 0; } break;
    case 'hd': hdOn = !!m.on; if (!hdOn) hd.reset(); break;
    case 'same': sameOn = !!m.on; if (!sameOn) { sameN = 0; sameRate = 0; } break;
    case 'pager': pagerWhich = m.which; pocsag.reset(); flex.reset(); break;
    case 'ismFamilies': ism.weather = !!m.weather; ism.remotes = !!m.remotes; ism.cars = !!m.cars; break;
    // Every list screen's CLEAR: whichever decoder is running forgets its table, if it keeps one.
    case 'clear': (processor as { clear?: () => void } | null)?.clear?.(); break;
    // The radio has confirmed the frequency the sweep asked for (see ackTune in main).
    case 'tuned': (processor as { tuned?: () => void } | null)?.tuned?.(); break;
    case 'r433':
      if (m.cmd === 'clear') r433.clear();
      else if (m.cmd === 'protocols') r433.setProtocols(m.nums as number[] | null);
      else if (m.cmd === 'list') post({ type: 'r433list', protocols: protocolList() });
      else if (m.cmd === 'span') r433.setSpan(m.hz as number);
      break;
    case 'capture': void captureCmd(m); break;
    case 'hamParams': ham.set(m.params); break;
    case 'monitorParams': monitor.set(m.params); break;
    case 'digital': setDigital(m.mode as string, m); break;
    case 'satService': if (typeof m.baud === 'number') g3ruh.setBaud(m.baud); setSatService(m.kind as string); break;
    case 'tapFm': fmTap = new Float32Array(Math.round((m.seconds as number) * 50_000)); fmTapN = 0; applyTaps(); fmBurst = !!m.bursts; fmBurstEnd = performance.now() + ((m.wall as number) ?? m.seconds as number) * 1000; fmPre = new Float32Array(20_000); fmPreN = 0; fmHold = 0; fmAcc = 0; fmAccN = 0; fmFloor = 0; fmBurstCount = 0; break;
  }
};

function makeProcessor(app: string, m: Record<string, unknown>): IqProcessor | null {
  switch (app) {
    case 'adsb': return adsb;
    case 'orbcomm': orbcomm.channelHz = centreHz + offsetHz; return orbcomm;
    case 'ais': return ais;
    case 'aprs': return aprs;
    case 'pocsag': return pocsag;
    case 'pager': return pager;
    case 'ert': return ert;
    case 'btle': return btle;
    case 'tpms': return tpms;
    case 'acars': return acars;
    case 'subghz': return ism;
    case 'r433': return r433;
    case 'sweep': return new SweepProcessor(m.start as number, m.end as number, m.slice as number, emit);
    case 'capture': return recorder;
    case 'ham': return ham;
    case 'monitor': return monitor;
    default: return null;
  }
}

async function captureCmd(m: Record<string, unknown>): Promise<void> {
  try {
    switch (m.cmd) {
      case 'start': await recorder.start(m.freq as number, m.rate as number); break;
      case 'stop': await recorder.stop(); break;
      case 'list': await recorder.list(); break;
      case 'get': await recorder.get(m.name as string); break;
      case 'remove': await recorder.remove(m.name as string); break;
    }
  } catch (e) { emit({ type: 'log', line: `capture: ${(e as Error).message}` }); }
}

function process(iq: Int8Array): void {
  const nSamp = iq.length >> 1;
  if (nSamp < 4) return;
  const p = processor;
  if (p && (p !== lastProc || rate !== lastProcRate)) { try { p.reset(rate); } catch (e) { emit({ type: 'log', line: `processor reset: ${(e as Error).message}` }); } lastProc = p; lastProcRate = rate; }
  else if (!p) lastProc = null;
  if (mode !== prevMode) { prevI = prevQ = deemph = amDc = wph = 0; dcFmI = dcFmQ = 0; lpI1 = lpI2 = lpQ1 = lpQ2 = 0; decAcc = 0; decCnt = 0; s1I = s1Q = 0; s1n = 0; audioLen = 0; rdsN = 0; sameN = 0; if (mode !== 'WFM') { rds.reset(); hd.reset(); } prevMode = mode; }

  const now = performance.now();
  // accumulate every whole FFT frame in this buffer (a short buffer contributes one zero-padded frame)
  // wide spans (up to 20 Msps) would need ten times the transforms: skip frames so ~2.4 M samples/s are transformed
  const skip = Math.max(1, Math.round(rate / 2_400_000));
  if (nSamp >= fftN) { for (let off = 0; off + fftN <= nSamp; off += fftN * skip) { loadIqAt(iq, off, fre, fim, win); fft(fre, fim); accumulatePower(fre, fim, acc); frames++; } }
  else if (frames === 0) {
    fre.fill(0); fim.fill(0);
    for (let k = 0; k < nSamp; k++) { fre[k] = iq[2 * k] * win[k]; fim[k] = iq[2 * k + 1] * win[k]; }
    fft(fre, fim); accumulatePower(fre, fim, acc); frames = 1;
  }
  if (now - lastSpec > SPEC_INTERVAL_MS && frames > 0) {
    lastSpec = now;
    const nAvg = frames;
    powerDbFrom(acc, nAvg, pdb);
    acc.fill(0); frames = 0;
    sortBuf.set(pdb); sortBuf.sort();
    const median = sortBuf[bins >> 1];
    floorEma = Number.isNaN(floorEma) ? median : floorEma + 0.2 * (median - floorEma);
    const base = floorEma - SPEC_FLOOR_PAD_DB;
    const out = new Float32Array(bins);
    // With very large FFTs a frame averages only a few transforms; blend with the previous row so the noise
    // stays flat (weight by how much averaging this frame already had).
    const keep = prevOut && prevOut.length === bins ? Math.max(0, 0.6 - nAvg * 0.05) : 0;
    for (let k = 0; k < bins; k++) {
      const v = Math.min(1, Math.max(0, (pdb[k] - base) / SPEC_RANGE_DB));
      out[k] = keep > 0 ? v * (1 - keep) + prevOut![k] * keep : v;
    }
    prevOut = Float32Array.from(out);
    post({ type: 'spectrum', bins: out, floorDb: base, rangeDb: SPEC_RANGE_DB }, [out.buffer]);
    // signal finder + classifier on every third frame (~10 Hz)
    if ((++specFrame % 3) === 0 && centreHz > 0) {
      const sigs = classifier.update(pdb, rate, centreHz, median);
      post({ type: 'signals', list: sigs.map(s => ({ hz: s.hz, db: s.db, snr: s.snr, bw: s.bw6, cls: s.cls, conf: s.conf, val: Math.min(1, Math.max(0, (s.db - base) / SPEC_RANGE_DB)) })) });
    }
    if (now - lastDiag > 1000) {
      lastDiag = now;
      let sI = 0, sQ = 0, sSq = 0;
      const nn = Math.min(nSamp, 4096);
      for (let k = 0; k < nn; k++) { const iv = iq[2 * k], qv = iq[2 * k + 1]; sI += iv; sQ += qv; sSq += iv * iv + qv * qv; }
      const rms = Math.sqrt(sSq / nn);
      let peak = -999, peakIdx = 0;
      for (let k = 0; k < bins; k++) if (pdb[k] > peak) { peak = pdb[k]; peakIdx = k; }
      const offKhz = (peakIdx - bins / 2) * (rate / bins) / 1000;
      const line = `RX: iqRMS=${rms.toFixed(1)} dcI=${(sI / nn).toFixed(1)} dcQ=${(sQ / nn).toFixed(1)} · peak ${offKhz >= 0 ? '+' : ''}${offKhz.toFixed(0)} kHz ${peak.toFixed(0)}dB vs floor ${median.toFixed(0)}dB (Δ${(peak - median).toFixed(0)})`;
      post({ type: 'health', line: processor === ham || processor === monitor ? `${line} · audio chunks ${audioChunks}${audioPort ? '' : ' (NO PORT)'}` : line, levelDb: peak - median, audioPeak, rms, audio: mode !== 'NONE' });
      audioPeak = 0;
    }
  }

  // HD Radio sidebands reach 200 kHz either side of the station; the detector needs them inside the span.
  if (hdOn && mode === 'WFM' && Math.abs(offsetHz) < rate / 2 - 240_000) hd.push(iq, nSamp, rate, offsetHz);
  if (mode !== 'NONE' && Math.abs(offsetHz) < rate / 2 - 40_000) {       // a channel slid off the span is silent
    const mixing = offsetHz !== 0, offW = -2 * Math.PI * offsetHz / rate, offDr = Math.cos(offW), offDi = Math.sin(offW);
    const stage1 = mode === 'WFM' ? Math.max(1, Math.floor(rate / 240_000)) : Math.max(1, Math.floor(rate / AUDIO_RATE));
    const interRate = rate / stage1;
    const stage2 = Math.max(1, Math.floor(interRate / AUDIO_RATE));
    const wantFm = !!(p && p.wantsFm && p.onFm);
    const wInc = 2 * Math.PI * 1500 / interRate;
    // Channel width before the discriminator. AIS is 9.6 kbaud GMSK in a 25 kHz channel. ORBCOMM is 4.8 kbaud
    // and only about 10 kHz wide, but it is in low orbit and swings +-3.1 kHz with Doppler across a pass, so
    // it needs the room. Everything else is NFM voice or 1200 baud packet.
    const filtered = mode === 'NFM' || mode === 'AM';
    const wideDigital = p === ais || satKind === 'g3ruh' || satKind === 'geoscan';   // 9600 baud wants the whole channel
    if (filtered) chanDesign(wideDigital ? 10_000 : p === orbcomm ? 9_000 : mode === 'AM' ? 5_000 : 6_500, interRate);
    const cs = chan.s;
    for (let i = 0; i < nSamp; i++) {
      let a = iq[2 * i], b = iq[2 * i + 1];
      if (mixing) {                                                        // shift the channel to DC first
        const ri = a * offCr - b * offCi, rq = a * offCi + b * offCr; a = ri; b = rq;
        const nr = offCr * offDr - offCi * offDi; offCi = offCr * offDi + offCi * offDr; offCr = nr;
        if ((i & 1023) === 1023) { const g = 1 / Math.sqrt(offCr * offCr + offCi * offCi); offCr *= g; offCi *= g; }
      }
      s1I += a; s1Q += b; s1n++;
      if (s1n >= stage1) {
        let ci = s1I / s1n, cq = s1Q / s1n; s1I = 0; s1Q = 0; s1n = 0;
        if (filtered) for (const f of cs) {
          const oi = f.b0 * ci + f.zi1; f.zi1 = f.b1 * ci - f.a1 * oi + f.zi2; f.zi2 = f.b2 * ci - f.a2 * oi;
          const oq = f.b0 * cq + f.zq1; f.zq1 = f.b1 * cq - f.a1 * oq + f.zq2; f.zq2 = f.b2 * cq - f.a2 * oq;
          ci = oi; cq = oq;
        }
        chPow += ci * ci + cq * cq; chN++;
        let s: number;
        if (mode === 'AM') { const env = Math.sqrt(ci * ci + cq * cq); amDc += 0.001 * (env - amDc); s = env - amDc; }
        else if (mode === 'USB' || mode === 'LSB') {
          wph += mode === 'USB' ? -wInc : wInc;
          if (wph > 2 * Math.PI) wph -= 2 * Math.PI; else if (wph < 0) wph += 2 * Math.PI;
          const c = Math.cos(wph), sn = Math.sin(wph);
          const ri = ci * c - cq * sn, rq = ci * sn + cq * c;
          lpI1 += 0.18 * (ri - lpI1); lpI2 += 0.18 * (lpI1 - lpI2);
          lpQ1 += 0.18 * (rq - lpQ1); lpQ2 += 0.18 * (lpQ1 - lpQ2);
          s = lpI2 * c + lpQ2 * sn;
        } else {
          // Strip the front-end DC/LO offset before the discriminator. A HackRF One holds a steady dc on I/Q
          // (the dcI/dcQ in the health line); a narrowband decoder tuned to the carrier (NFM, offset 0 — APRS,
          // AIS, pager…) puts the wanted signal right on that dc, which anchors the phasor and suppresses its
          // effective deviation, so the tones demodulate weak. A slow one-pole (~15 Hz at the intermediate rate)
          // tracks only the static offset, far below the 1200/2200 Hz Bell-202 content. WFM is wideband and
          // strong, so it keeps the raw path untouched (RDS/HD unaffected).
          let fi = ci, fq = cq;
          if (mode === 'NFM') { dcFmI += 2e-3 * (ci - dcFmI); dcFmQ += 2e-3 * (cq - dcFmQ); fi = ci - dcFmI; fq = cq - dcFmQ; }
          s = Math.atan2(fq * prevI - fi * prevQ, fi * prevI + fq * prevQ); prevI = fi; prevQ = fq;
        }
        if (wantFm) { fmBuf[fmN++] = s; if (fmN >= fmBuf.length) { p!.onFm!(fmBuf, fmN, interRate); fmN = 0; } }
        if (rdsOn && mode === 'WFM') { rdsBuf[rdsN++] = s; if (rdsN >= rdsBuf.length) { rds.push(rdsBuf, rdsN, interRate); rdsN = 0; } }
        if (sameOn && mode === 'NFM') { if (sameRate !== interRate) { same.reset(interRate); sameRate = interRate; } sameBuf[sameN++] = s; if (sameN >= sameBuf.length) { same.onFm(sameBuf, sameN, interRate); sameN = 0; } }
        if (fmTap) {
          fmTapRate = interRate;
          if (!fmBurst) { if (fmTapN < fmTap.length) fmTap[fmTapN++] = s; else { const t = fmTap; fmTap = null; post({ type: 'fmTap', rate: fmTapRate, samples: t }, [t.buffer]); } }
          else {
            // 20 ms RMS against a slow floor: a carrier drops the discriminator noise to well under half the floor
            fmAcc += s * s; if (++fmAccN >= 1000) { const r = Math.sqrt(fmAcc / fmAccN); fmAcc = 0; fmAccN = 0; fmFloor = fmFloor ? (r > fmFloor ? fmFloor + 0.02 * (r - fmFloor) : fmFloor + 0.002 * (r - fmFloor)) : r; if (r < fmFloor * 0.6) { if (!fmHold) { fmBurstCount++; for (let k = 0; k < fmPreN && fmTapN < fmTap.length; k++) fmTap[fmTapN++] = fmPre[(k) % fmPre.length]; } fmHold = 12; } else if (fmHold) fmHold--; }
            if (fmHold) { if (fmTapN < fmTap.length) fmTap[fmTapN++] = s; }
            else { fmPre[fmPreN % fmPre.length] = s; fmPreN++; }
            if (fmTapN >= fmTap.length || performance.now() > fmBurstEnd) { const t = fmTap.slice(0, fmTapN); fmTap = null; post({ type: 'fmTap', rate: fmTapRate, samples: t, bursts: fmBurstCount }, [t.buffer]); }
          }
        }
        decAcc += s; decCnt++;
        if (decCnt >= stage2) {
          let v = decAcc / decCnt; decAcc = 0; decCnt = 0;
          if (mode === 'WFM') { deemph += 0.28 * (v - deemph); v = deemph * 9000; }
          else if (mode === 'NFM') v *= 16000;
          else if (mode === 'AM') v *= 60;
          else v *= 150;
          const clipped = Math.max(-32000, Math.min(32000, v));
          const a = Math.abs(clipped); if (a > audioPeak) audioPeak = a;
          if (voiceOn) { vBuf[0] = clipped / 32768; voice.push(vBuf, 1); }   // judged before the squelch gates it
          audioBuf[audioLen++] = sqOpen ? clipped / 32768 : 0;
          if (audioLen >= audioBuf.length) flushAudio();
        }
      }
    }
    if (wantFm && fmN > 0) { p!.onFm!(fmBuf, fmN, interRate); fmN = 0; }
    if (audioLen > 0) flushAudio();
    if (voiceOn && now - voiceLast > 250) { voiceLast = now; post({ type: 'voice', ...voice.read() }); }
    if (chN > 0) {
      const db = 10 * Math.log10(chPow / chN + 1e-9); chPow = 0; chN = 0;
      sqFloor = Number.isNaN(sqFloor) ? db : db < sqFloor ? sqFloor + 0.2 * (db - sqFloor) : sqFloor + 0.002 * (db - sqFloor);
      const open = squelchDb === 0 || db > sqFloor + squelchDb;
      if (open !== sqOpen || now - sqLastReport > 250) { sqOpen = open; sqLastReport = now; post({ type: 'sq', open, db, floor: sqFloor }); }
    }
  }
  if (p) { try { p.onIq(iq, rate); } catch (e) { emit({ type: 'log', line: `processor error: ${(e as Error).message}` }); } }
}

function flushAudio(): void {
  if (audioPort) { const chunk = audioBuf.slice(0, audioLen); audioPort.postMessage(chunk, [chunk.buffer]); }
  audioLen = 0;
}
