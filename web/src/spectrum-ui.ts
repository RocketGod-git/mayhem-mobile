/**
 * The Spectrum screen: a bench spectrum analyzer and its zero-span (waveform) mode.
 *
 * FREQ: center and span (or start and stop), RBW, VBW, reference level and scale, four traces (live, max hold, min
 * hold, average, view), four markers with delta and peak search, channel power, occupied bandwidth, ACPR and the noise
 * floor, and a persistence (density) display. Spans wider than the radio sweep, with the Looking Glass's stepping.
 * ZERO SPAN: one frequency through a chosen filter, its amplitude, instantaneous frequency and phase over time, with a
 * level trigger, pre-trigger, single shot, two cursors and pulse measurements.
 *
 * The instrument: big readout tiles for the settings (a +/- knob each, the mouse wheel turns it, a tap opens a keypad),
 * the plot with glowing traces, marker diamonds and the active marker's readout, a marker table and a measurement
 * panel with its results large. On the plot: scroll or pinch to zoom the span, drag to pan, tap to drop a marker, drag
 * a marker to move it.
 *
 * The DSP runs in the worker (`dsp/spectrum/processor.ts`); the traces, markers and measurements are done here on
 * what it sends (`dsp/spectrum/*`). main.ts supplies the radio around it through `Host`.
 * Twin of the Android ui/SpectrumScreen.kt and the iPad/Mac App/ui/SpectrumScreen.swift.
 */

import {
  acpr, autoLevel, autoRbw, autoScale, binOf, channelPower, dbmOffset, defaultMarkers, defaultTraces, fmtHz, fmtSec, nextPeak, nextPeakLeft, nextPeakRight,
  noiseAt, noiseFloor, occupiedBw, peakSearch, planSpan, pulseStats, refinePeak, stepBw, toColumns, zsMaxBw, Persistence,
  DETECTORS, THERMAL_DBM_HZ, fmScale, TRACE_MODES, TRIG_MODES, ZS_BWS, ZS_MAX_POINTS, ZS_OFFSET, zsPlan,
  type Detector, type GainState, type Marker, type PulseStats, type SpanPlan, type SpecConfig, type Trace, type TraceMode, type TrigMode, type WindowKind,
} from './dsp/spectrum/index.js';

/** What the screen needs from the app around it. */
export interface Host {
  post(msg: Record<string, unknown>, transfer?: Transferable[]): void;
  showing(): boolean;
  log(line: string): void;
  /** The radio's gain now, for the dBm scale. */
  gain(): GainState;
  /** The sample rates this radio does well. */
  rates(): number[];
  /** Whether a radio is connected. */
  connected(): boolean;
  /** Tune the radio and start the spectrum processor at this rate with this configuration. */
  start(tuneHz: number, rate: number, cfg: SpecConfig): void;
  /** Open another app on a frequency. */
  openApp(app: 'analyzer' | 'devices', hz: number): void;
  /** Open the RADIO panel (the gain lives there). */
  openRadio(): void;
  /** The frequency in the app's own dial, for the first visit. */
  dial(): number;
}

type Mode = 'FREQ' | 'ZERO';
type Meas = 'OFF' | 'CHP' | 'OBW' | 'ACPR' | 'NOISE';
const MEAS: [Meas, string][] = [['OFF', 'OFF'], ['CHP', 'CH PWR'], ['OBW', 'OBW'], ['ACPR', 'ACPR'], ['NOISE', 'NOISE']];
const MEAS_TITLE: Record<Meas, string> = { OFF: '', CHP: 'CHANNEL POWER', OBW: 'OCCUPIED BANDWIDTH 99 %', ACPR: 'ADJACENT CHANNEL POWER', NOISE: 'NOISE FLOOR' };
/** Trace colors (a bench analyzer's yellow, cyan, magenta, green). */
export const TRACE_COLOR = ['#ffd400', '#3fd0c9', '#ff5dd8', '#3fd07a'];
const ACTIVE = '#ffaf00';
const SPAN_PRESETS: [string, number][] = [['100k', 1e5], ['1M', 1e6], ['2M', 2e6], ['10M', 1e7], ['20M', 2e7], ['100M', 1e8], ['1G', 1e9]];
const DIVS = [1, 2, 5, 10, 20];
const SWEEP_TIMES = [1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5, 1, 2, 5, 10];
const MIN_SPAN = 1000, MAX_HZ = 6e9, MIN_HZ = 1e6;
/** Frames a marker's readout averages over: steady to read, still quick to follow a change. */
const MARKER_AVG = 16;
const KEY = 'mayhem.spectrum';

interface Settings {
  mode: Mode;
  center: number; span: number;
  startStop: boolean;
  rbwAuto: boolean; rbw: number;
  vbwAuto: boolean; vbw: number;
  window: WindowKind;
  ref: number; div: number;
  unit: 'dBm' | 'dBFS';
  det: Detector;
  cal: number;
  traces: { mode: TraceMode; avgN: number }[];
  markers: Marker[];
  active: number;
  meas: Meas; chBw: number; spacing: number;
  persist: boolean;
  // zero span
  zsFreq: number; zsBw: number; zsTime: number; trig: TrigMode; single: boolean; level: number; pre: number;
  showAmp: boolean; showFm: boolean; showPh: boolean; cursors: boolean; curA: number; curB: number;
}

function defaults(dial: number): Settings {
  return {
    mode: 'FREQ', center: dial || 433.92e6, span: 2e6, startStop: false, rbwAuto: true, rbw: 3000, vbwAuto: true, vbw: 3000, window: 'HANN',
    ref: -20, div: 10, unit: 'dBm', det: 'PEAK', cal: 0,
    traces: defaultTraces().map(t => ({ mode: t.mode, avgN: 10 })),
    markers: defaultMarkers(), active: 0, meas: 'OFF', chBw: 25_000, spacing: 25_000, persist: false,
    zsFreq: dial || 433.92e6, zsBw: 100_000, zsTime: 0.02, trig: 'FREE', single: false, level: -60, pre: 0.1,
    showAmp: true, showFm: true, showPh: false, cursors: false, curA: 0.25, curB: 0.75,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const db1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const sgn = (v: number) => (v >= 0 ? '+' : '−');
const bwText = (hz: number) => (hz >= 1e6 ? `${+(hz / 1e6).toFixed(3)} MHz` : hz >= 1e3 ? `${+(hz / 1e3).toFixed(2)} kHz` : `${+hz.toFixed(1)} Hz`);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
/** A frequency split for a big readout: the digits grouped in threes, and the unit. */
function bigHz(hz: number): [string, string] {
  const a = Math.abs(hz);
  const [v, u] = a >= 1e9 ? [hz / 1e9, 'GHz'] : a >= 1e6 ? [hz / 1e6, 'MHz'] : a >= 1e3 ? [hz / 1e3, 'kHz'] : [hz, 'Hz'];
  let t = v.toFixed(u === 'Hz' ? 0 : 6).replace(/0+$/, '').replace(/\.$/, '');
  const [i, f] = t.split('.');
  t = f ? `${i}.${f.replace(/(\d{3})(?=\d)/g, '$1 ')}` : i;
  return [t, u];
}
/** 1-2-5 steps, for the span. */
function step125(v: number, dir: number): number {
  const e = Math.floor(Math.log10(v)), m = v / 10 ** e;
  const ms = [1, 2, 5, 10];
  let i = ms.findIndex(x => x >= m - 1e-9); if (i < 0) i = 3;
  if (dir < 0 && ms[i] > m + 1e-9) i--;
  i += dir;
  const k = i < 0 ? -1 : i > 2 ? 1 : 0;
  return ms[(i + 3) % 3] * 10 ** (e + k);
}

/** A 256-step palette for the density display: night blue, violet, red, orange, yellow, white. */
const PALETTE = (() => {
  const stops: [number, number, number, number][] = [[0, 8, 12, 40], [0.2, 60, 20, 120], [0.45, 190, 30, 110], [0.65, 250, 110, 30], [0.85, 255, 210, 60], [1, 255, 255, 235]];
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    const r = r0 + f * (r1 - r0), g = g0 + f * (g1 - g0), b = b0 + f * (b1 - b0), a = Math.min(255, 40 + t * 600);
    lut[i] = (Math.round(a) << 24) | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r);   // ABGR, little endian
  }
  return lut;
})();

/** The frame as the screen keeps it: where its bins are. */
interface Frame { f0: number; binHz: number; rbw: number; sweep: boolean; step: number; steps: number; }
/** A keypad entry in progress. */
interface Pad { tile: string; label: string; kind: 'hz' | 'db' | 'sec' | 'pct' | 'bw'; text: string; }
type Geom = { l: number; t: number; w: number; h: number; W: number; H: number };

export class SpectrumUi {
  s: Settings;
  readonly traces: Trace[] = defaultTraces();
  private frame: Frame | null = null;
  private persist: Persistence | null = null;
  private zcap: { amp: Float32Array; fm: Float32Array; ph: Float32Array; rate: number; trig: number; roll: boolean; sweepSec: number; preview?: boolean } | null = null;
  private zstats: PulseStats | null = null;
  private armed = true;
  private plan: SpanPlan | null = null;
  private root: HTMLElement | null = null;
  private cv: HTMLCanvasElement | null = null;
  private drawQueued = false;
  private calNote = '';
  private calOk = false;
  /** The measurement's last readout, kept for the export. */
  private measText = '';
  /** The span on screen while a zoom or pan is being made (it is applied when the gesture settles). */
  private view: { center: number; span: number } | null = null;
  private commitTimer = 0;
  /** Pointers down on the plot, and what the gesture is. */
  private readonly pts = new Map<number, { x: number; y: number }>();
  private gesture: { kind: 'tap' | 'pan' | 'pinch' | 'pinchT' | 'marker' | 'cursor'; x0: number; center0: number; span0: number; d0: number; which: number } | null = null;
  private pad: Pad | null = null;
  private densityCanvas: HTMLCanvasElement | null = null;
  /** The sweep time a zero-span pinch is making (the SWEEP tile shows it while the fingers move). */
  private pinchTime = NaN;
  /** Each marker's level, averaged over the last few frames (a live trace on noise jumps several dB a frame). */
  private readonly mkAvg: { hz: number; trace: Trace | null; lin: number; n: number }[] = Array.from({ length: 4 }, () => ({ hz: NaN, trace: null, lin: 0, n: 0 }));

  constructor(private readonly host: Host) {
    this.s = defaults(host.dial());
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (v && typeof v === 'object') this.s = { ...this.s, ...v, markers: Array.isArray(v.markers) && v.markers.length === 4 ? v.markers : this.s.markers, traces: Array.isArray(v.traces) && v.traces.length === 4 ? v.traces : this.s.traces };
    } catch { /* first visit */ }
    this.s.traces.forEach((t, i) => { this.traces[i].mode = t.mode; this.traces[i].avgN = t.avgN; });
  }
  private save(): void { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* ignore */ } }

  // ---- span and plan ------------------------------------------------------------------------------------------

  get start(): number { return this.s.center - this.s.span / 2; }
  get stop(): number { return this.s.center + this.s.span / 2; }
  /** The span drawn: the settled one, or the one a gesture is making. */
  private vCenter(): number { return this.view?.center ?? this.s.center; }
  private vSpan(): number { return this.view?.span ?? this.s.span; }
  rbwHz(): number { return this.s.rbwAuto ? autoRbw(this.s.span) : this.s.rbw; }
  vbwHz(): number { return this.s.vbwAuto ? this.frame?.rbw ?? this.rbwHz() : this.s.vbw; }

  /** The zero-span rate: the smallest rate (from 2 Msps up, the HackRF's floor) whose span holds the filter clear of DC. */
  private zsRate(): number {
    const rates = [...this.host.rates()].sort((a, b) => a - b);
    return rates.find(r => r >= Math.min(2e6, rates[rates.length - 1]) && zsMaxBw(r) >= this.s.zsBw) ?? rates[rates.length - 1] ?? 2e6;
  }
  /** Filter bandwidths this radio can do. */
  zsBws(): number[] { const top = Math.max(...this.host.rates(), 2e6); return ZS_BWS.filter(b => b <= zsMaxBw(top)); }

  private config(): SpecConfig {
    const s = this.s;
    const zsRate = this.zsRate(), zsTune = s.zsFreq - ZS_OFFSET * zsRate;
    const base: SpecConfig = {
      mode: 'FFT', tuneHz: 0, startHz: this.start, stopHz: this.stop, rbwHz: this.rbwHz(), window: s.window,
      vbwHz: s.vbwAuto ? 1e12 : s.vbw, dcPatch: false, sliceRate: 0,
      zs: { offsetHz: s.zsFreq - zsTune, bwHz: s.zsBw, sweepSec: s.zsTime, trigger: s.trig, single: s.single, levelDb: s.level - this.offset(), pre: s.pre },
    };
    if (s.mode === 'ZERO') return { ...base, mode: 'ZERO', tuneHz: zsTune };
    const p = this.plan = planSpan(this.start, this.stop, this.host.rates());
    if (p.kind === 'FFT') return { ...base, tuneHz: p.tuneHz, dcPatch: p.dcPatch };
    return { ...base, mode: 'SWEEP', sliceRate: p.sliceRate };
  }

  /** Retune and restart the processor (span, RBW, mode or window changed). */
  restart(): void {
    const cfg = this.config();
    // a marker the new span leaves behind goes off rather than reading the trace's edge
    for (const m of this.s.markers) if (m.hz < this.start || m.hz > this.stop) { m.on = false; m.delta = false; m.hz = 0; }
    this.frame = null; this.zcap = null; this.zstats = null; this.armed = true; this.view = null;
    // the marker averages belong to the old span's traces
    for (const a of this.mkAvg) a.n = 0;
    for (const t of this.traces) t.clear();
    this.persist?.clear();
    if (cfg.mode === 'ZERO') this.host.start(cfg.tuneHz, this.zsRate(), cfg);
    else if (cfg.mode === 'SWEEP') this.host.start(cfg.startHz + cfg.sliceRate / 2, cfg.sliceRate, cfg);
    else this.host.start(cfg.tuneHz, (this.plan as { rate: number }).rate, cfg);
    this.save(); this.tiles(); this.draw();
  }
  /** Settings the processor takes in place (VBW, trigger, level). */
  private update(): void {
    this.host.post({ type: 'spectrum', cmd: 'set', cfg: this.config() });
    this.save(); this.tiles(); this.draw();
  }
  /** The longest zero-span window this filter allows. */
  private zsMostSec(): number { return ZS_MAX_POINTS / zsPlan(this.zsRate(), this.s.zsBw).outRate; }
  /** Set the span (clamped to what a radio reaches) and restart. */
  private setSpan(center: number, span: number): void {
    span = Math.max(MIN_SPAN, Math.min(MAX_HZ - MIN_HZ, span));
    center = Math.max(MIN_HZ + span / 2, Math.min(MAX_HZ - span / 2, center));
    this.s.center = center; this.s.span = span;
    this.controls(); this.restart();
  }

  // ---- the dBm scale ------------------------------------------------------------------------------------------

  /** dBFS to the display unit. */
  offset(): number {
    if (this.s.unit === 'dBFS') { this.calNote = 'dBFS: relative to the converter\'s full scale'; this.calOk = true; return 0; }
    const o = dbmOffset(this.host.gain(), this.s.cal);
    this.calOk = o.ok;
    this.calNote = o.ok ? `dBm ${o.note}${this.s.cal ? ` · CAL ${this.s.cal > 0 ? '+' : ''}${this.s.cal} dB` : ''} · approximate` : `dBm uncalibrated: ${o.note}`;
    return o.offset;
  }
  unitLabel(): string { return this.s.unit === 'dBm' ? 'dBm' : 'dBFS'; }

  /** The radio's gain moved (RADIO panel): the chip says so, and a trigger level in dBm keeps its meaning. */
  gainChanged(): void {
    const b = this.root?.querySelector<HTMLElement>('[data-act="radio"]');
    if (b) b.textContent = `RADIO · ${this.gainText()}`;
    if (this.s.mode === 'ZERO' && this.s.trig !== 'FREE') this.update();
  }
  private gainText(): string {
    const g = this.host.gain();
    return g.kind === 'rtlsdr' ? (Number.isFinite(g.tunerDb) ? `GAIN ${g.tunerDb} dB` : 'TUNER AGC') : g.kind === 'hackrf' ? `LNA ${g.lna} · VGA ${g.vga}${g.amp ? ' · AMP' : ''}` : 'NO RADIO';
  }

  // ---- what the worker sends ----------------------------------------------------------------------------------

  onFrame(m: { live: Float32Array; max: Float32Array | null; min: Float32Array | null; f0: number; binHz: number; rbw: number; sweep: boolean; step: number; steps: number }): void {
    if (this.s.mode !== 'FREQ') return;
    const off = this.offset();
    const shift = (a: Float32Array | null) => { if (!a) return null; for (let i = 0; i < a.length; i++) a[i] += off; return a; };
    const live = shift(m.live)!, max = shift(m.max), min = shift(m.min);
    const rbwMoved = this.frame?.rbw !== m.rbw;
    this.frame = { f0: m.f0, binHz: m.binHz, rbw: m.rbw, sweep: m.sweep, step: m.step, steps: m.steps };
    // a sweep row is redrawn while it fills: only its finished passes feed the holds, the average and the density
    const whole = !m.sweep || m.step === m.steps;
    this.traces.forEach(t => { if (t.mode === 'LIVE' || whole) t.update(live, max, min, m.f0, m.binHz); });
    if (this.s.persist && whole && !this.view) this.addDensity(live, m.f0, m.binHz);
    this.s.markers.forEach((_, k) => this.smoothMarker(k));
    if (rbwMoved) this.tiles();
    this.draw();
  }

  onCapture(m: { amp: Float32Array; fm: Float32Array; ph: Float32Array; rate: number; trig: number; roll: boolean; sweepSec: number; armed: boolean; preview?: boolean }): void {
    if (this.s.mode !== 'ZERO') return;
    // a preview (the channel while a trigger waits) never covers a capture already taken
    if (m.preview && this.zcap && !this.zcap.preview) return;
    const off = this.offset();
    for (let i = 0; i < m.amp.length; i++) m.amp[i] += off;
    this.zcap = m;
    const was = this.armed;
    this.armed = m.armed;
    this.zstats = m.preview ? null : pulseStats(m.amp, m.rate);
    if (was !== this.armed) this.tiles();
    this.draw();
  }

  /** The density display at the plot's own resolution: each frame reduced to columns, joined column to column. */
  private addDensity(live: Float32Array, f0: number, binHz: number): void {
    const g = this.cv ? this.geom() : null; if (!g) return;
    const cols = Math.max(64, Math.min(1600, Math.round(g.w))), rows = Math.max(64, Math.min(600, Math.round(g.h)));
    if (!this.persist || this.persist.cols !== cols || this.persist.rows !== rows) this.persist = new Persistence(cols, rows, 0.9);
    // the frame's bins placed on the screen's columns (it may not fill the span exactly)
    const y = new Float32Array(cols).fill(-1e9);
    const x0 = (f0 - binHz / 2 - this.start) / this.s.span * cols, x1 = (f0 + (live.length - 0.5) * binHz - this.start) / this.s.span * cols;
    const a = Math.max(0, Math.ceil(x0)), b = Math.min(cols, Math.floor(x1));
    if (b - a < 2) return;
    y.set(toColumns(live, b - a, 'PEAK'), a);
    this.persist.addColumns(y, this.s.ref, this.s.div * 10);
  }

  // ---- screen -------------------------------------------------------------------------------------------------

  html(): string {
    return `
    <section class="visual sp-visual">
      <div id="sp-tiles" class="sp-tiles"></div>
      <div id="sp-status" class="sp-status"></div>
      <div class="sp-main">
        <div class="sp-screen"><canvas id="sp-cv"></canvas></div>
        <aside class="sp-side"><div id="sp-meas" class="sp-meas"></div><div id="sp-mkt" class="sp-mkt"></div></aside>
      </div>
    </section>
    <section class="controls sp-controls" id="sp-ctl"></section>
    <div id="sp-pad" class="sp-padwrap" hidden></div>`;
  }

  mount(root: HTMLElement): void {
    this.root = root;
    this.cv = root.querySelector<HTMLCanvasElement>('#sp-cv');
    const cv = this.cv!;
    cv.onpointerdown = (e) => this.down(e);
    cv.onpointermove = (e) => this.move(e);
    cv.onpointerup = (e) => this.up(e);
    // the browser took the touch for a scroll of the page (the canvas allows vertical panning): forget the gesture
    cv.onpointercancel = (e) => { this.pts.delete(e.pointerId); this.gesture = null; };
    cv.onwheel = (e) => this.wheel(e);
    const tiles = root.querySelector<HTMLElement>('#sp-tiles')!;
    tiles.onclick = (e) => {
      const b = (e.target as HTMLElement).closest('[data-t]') as HTMLElement | null; if (!b) return;
      const t = b.dataset.t!, d = b.dataset;
      if (d.k === 'dn' || d.k === 'up') this.turn(t, d.k === 'up' ? 1 : -1);
      else if (d.k === 'auto') this.toggle(t === 'rbw' ? 'rbwa' : 'vbwa');
      else if (d.k === 'pad' && t === 'ref' && (e.target as HTMLElement).tagName === 'B') this.autoScaleNow();
      else if (d.k === 'edge') { this.s.trig = this.s.trig === 'RISE' ? 'FALL' : 'RISE'; this.controls(); this.update(); }
      else this.openPad(t);
    };
    tiles.onwheel = (e) => {
      const b = (e.target as HTMLElement).closest('[data-tile]') as HTMLElement | null; if (!b) return;
      e.preventDefault();
      this.turn(b.dataset.tile!, e.deltaY < 0 ? 1 : -1);
    };
    this.controls();
    this.restart();
  }

  private ctl(): HTMLElement | null { return this.root?.querySelector<HTMLElement>('#sp-ctl') ?? null; }

  // ---- the readout tiles: big values with a knob each ---------------------------------------------------------

  /** The tiles for the mode: [id, label, value, unit, badge]. */
  private tileList(): [string, string, string, string, string][] {
    const s = this.s, u = this.unitLabel();
    if (s.mode === 'ZERO') {
      const [fv, fu] = bigHz(s.zsFreq);
      return [
        ['zf', 'FREQUENCY', fv, fu, ''],
        ['zbw', 'FILTER', ...bigHz(s.zsBw), ''],
        ['zst', 'SWEEP', ...(fmtSec(Number.isFinite(this.pinchTime) ? this.pinchTime : this.zcap?.sweepSec ?? s.zsTime).split(' ') as [string, string]), ''],
        ['lvl', 'TRIGGER', s.trig === 'FREE' ? 'FREE' : String(s.level), s.trig === 'FREE' ? 'RUN' : u, s.trig === 'FREE' ? '' : s.trig === 'RISE' ? 'RISE ↑' : 'FALL ↓'],
        ['ref', 'REF LEVEL', String(s.ref), u, `${s.div} dB/div · AUTO`],
      ];
    }
    const rbw = this.frame?.rbw ?? this.rbwHz();
    const a: [string, string, string, string, string][] = s.startStop
      ? [['start', 'START', ...bigHz(this.start), ''], ['stop', 'STOP', ...bigHz(this.stop), '']]
      : [['center', 'CENTER', ...bigHz(s.center), ''], ['span', 'SPAN', ...bigHz(s.span), '']];
    return [...a,
      ['rbw', 'RBW', ...bigHz(rbw), s.rbwAuto ? 'AUTO' : 'MAN'],
      ['vbw', 'VBW', ...(s.vbwAuto ? bigHz(rbw) : bigHz(s.vbw)), s.vbwAuto ? 'AUTO' : 'MAN'],
      ['ref', 'REF LEVEL', String(s.ref), u, `${s.div} dB/div · AUTO`]];
  }
  /** Set REF and dB/div to frame the measured trace. */
  private autoScaleNow(): void {
    // zero span frames its amplitude trace; the frequency view frames the trace the measurements read
    const y = this.s.mode === 'ZERO' ? this.zcap?.amp : (this.traceFor(this.s.markers[this.s.active].trace) ?? this.traces.find(x => x.data))?.data;
    if (!y) return;
    const a = autoScale(y, DIVS);
    this.s.ref = a.ref; this.s.div = a.div; this.persist?.clear();
    this.controls(); this.update();
  }

  private tiles(): void {
    const el = this.root?.querySelector<HTMLElement>('#sp-tiles'); if (!el) return;
    el.innerHTML = this.tileList().map(([id, label, v, unit, badge]) => `
      <div class="sp-tile" data-tile="${id}">
        <div class="sp-tl"><span>${label}</span>${badge ? `<b data-t="${id}" data-k="${badge === 'AUTO' || badge === 'MAN' ? 'auto' : badge.startsWith('RISE') || badge.startsWith('FALL') ? 'edge' : 'pad'}" class="${badge === 'AUTO' ? 'on' : ''}">${badge}</b>` : ''}</div>
        <button class="sp-tv" data-t="${id}" data-k="pad" title="Tap to type a value; the wheel turns it">${esc(v)}<small>${esc(unit)}</small></button>
        <div class="sp-knob"><button data-t="${id}" data-k="dn" aria-label="${label} down">‹</button><i></i><button data-t="${id}" data-k="up" aria-label="${label} up">›</button></div>
      </div>`).join('');
    this.status();
  }

  /** One click of a tile's knob. */
  private turn(id: string, dir: number): void {
    const s = this.s;
    switch (id) {
      case 'center': this.setSpan(s.center + dir * s.span / 10, s.span); return;
      case 'start': this.setSpan(s.center + dir * s.span / 20, s.span - dir * s.span / 10); return;
      case 'stop': this.setSpan(s.center + dir * s.span / 20, s.span + dir * s.span / 10); return;
      case 'span': this.setSpan(s.center, step125(s.span, dir)); return;
      case 'rbw': s.rbw = stepBw(this.frame?.rbw ?? this.rbwHz(), dir); s.rbwAuto = false; this.controls(); this.restart(); return;
      case 'vbw': s.vbw = stepBw(s.vbwAuto ? this.vbwHz() : s.vbw, dir); s.vbwAuto = false; break;
      case 'ref': s.ref += dir * (s.div >= 5 ? 5 : 1); this.persist?.clear(); break;
      case 'zf': s.zsFreq += dir * s.zsBw / 4; this.restart(); return;
      case 'zbw': { const b = this.zsBws(), i = Math.max(0, Math.min(b.length - 1, b.indexOf(s.zsBw) + dir)); s.zsBw = b[i]; this.controls(); this.restart(); return; }
      case 'zst': this.stepper('zst', dir); return;
      // in FREE RUN the knob arms a rising trigger at the level shown; after that it moves the level
      case 'lvl': if (s.trig === 'FREE') s.trig = 'RISE'; else s.level += dir; break;
      default: this.stepper(id, dir); return;
    }
    this.controls(); this.update();
  }

  // ---- keypad -------------------------------------------------------------------------------------------------

  private openPad(tile: string): void {
    const t = this.tileList().find(x => x[0] === tile); if (!t) return;
    if (tile === 'lvl' && this.s.trig === 'FREE') { this.turn('lvl', 1); return; }
    const kind: Pad['kind'] = tile === 'ref' || tile === 'lvl' ? 'db' : tile === 'zst' ? 'sec' : tile === 'rbw' || tile === 'vbw' || tile === 'span' || tile === 'zbw' ? 'bw' : 'hz';
    this.pad = { tile, label: t[1], kind, text: '' };
    this.drawPad();
  }
  private drawPad(): void {
    const el = this.root?.querySelector<HTMLElement>('#sp-pad'); if (!el) return;
    const p = this.pad;
    el.hidden = !p;
    if (!p) { el.innerHTML = ''; return; }
    const units: [string, string][] = p.kind === 'db' ? [[this.unitLabel(), '1']] : p.kind === 'sec' ? [['s', '1'], ['ms', '1e-3'], ['µs', '1e-6']] : [['GHz', '1e9'], ['MHz', '1e6'], ['kHz', '1e3'], ['Hz', '1']];
    const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', p.kind === 'db' ? '±' : 'C'];
    el.innerHTML = `<div class="sp-pad" role="dialog" aria-label="${p.label}">
      <div class="sp-padh"><span>${p.label}</span><button data-p="esc" aria-label="Close">✕</button></div>
      <div class="sp-padv">${esc(p.text || ' ')}<i></i></div>
      <div class="sp-padg"><div class="sp-padk">${keys.map(k => `<button data-p="${k}">${k}</button>`).join('')}</div>
      <div class="sp-padu">${units.map(([l, m]) => `<button data-p="u" data-m="${m}">${l}</button>`).join('')}<button data-p="bs">⌫</button></div></div></div>`;
    el.onclick = (e) => {
      if (e.target === el) { this.pad = null; this.drawPad(); return; }
      const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!b || !this.pad) return;
      const k = b.dataset.p!;
      if (k === 'esc') { this.pad = null; this.drawPad(); return; }
      if (k === 'u') { this.enterPad(Number(b.dataset.m)); return; }
      this.padKey(k);
    };
  }
  private padKey(k: string): void {
    const p = this.pad; if (!p) return;
    if (k === 'bs') p.text = p.text.slice(0, -1);
    else if (k === 'C') p.text = '';
    else if (k === '±') p.text = p.text.startsWith('-') ? p.text.slice(1) : '-' + p.text;
    else if (k === '.' ? !p.text.includes('.') : /^\d$/.test(k)) p.text += k;
    const v = this.root?.querySelector('.sp-padv'); if (v) v.innerHTML = `${esc(p.text || ' ')}<i></i>`;
  }
  /** Apply the keypad's number times a unit multiplier. */
  private enterPad(mult: number): void {
    const p = this.pad; if (!p) return;
    const v = Number(p.text) * mult;
    this.pad = null; this.drawPad();
    if (!p.text || !Number.isFinite(v)) return;
    const s = this.s;
    switch (p.tile) {
      case 'center': this.setSpan(v, s.span); return;
      case 'span': this.setSpan(s.center, v); return;
      case 'start': { const st = this.stop; this.setSpan((v + st) / 2, st - v); return; }
      case 'stop': { const a = this.start; this.setSpan((a + v) / 2, v - a); return; }
      case 'rbw': s.rbw = Math.max(1, v); s.rbwAuto = false; this.restart(); return;
      case 'vbw': s.vbw = Math.max(1, v); s.vbwAuto = false; break;
      case 'ref': s.ref = Math.round(v); this.persist?.clear(); break;
      case 'lvl': s.level = Math.round(v); break;
      case 'zf': s.zsFreq = Math.max(MIN_HZ, Math.min(MAX_HZ, v)); this.restart(); return;
      case 'zbw': { const b = this.zsBws(); s.zsBw = b.reduce((a, x) => (Math.abs(Math.log(x / v)) < Math.abs(Math.log(a / v)) ? x : a), b[0]); this.controls(); this.restart(); return; }
      case 'zst': { const max = ZS_MAX_POINTS / zsPlan(this.zsRate(), s.zsBw).outRate; s.zsTime = Math.max(1e-5, Math.min(max, v)); this.restart(); return; }
    }
    this.controls(); this.update();
  }

  /** The line under the tiles: how the span is taken, the scale's calibration, the gain. */
  private status(): void {
    const el = this.root?.querySelector<HTMLElement>('#sp-status'); if (!el) return;
    const s = this.s, f = this.frame;
    const parts: string[] = [];
    if (s.mode === 'FREQ') {
      parts.push(this.plan?.kind === 'SWEEP' ? `SWEEP · ${f ? `${f.steps} STEPS` : '…'}` : this.plan?.kind === 'FFT' ? `FFT · ${+(this.plan.rate / 1e6).toFixed(3)} Msps${this.plan.dcPatch ? '' : ' · OFF DC'}` : '');
      parts.push(`${s.window === 'HANN' ? 'HANN' : 'FLAT TOP'} · ${s.det}`);
    } else {
      parts.push(`ZERO SPAN${s.single ? (this.armed ? ' · SINGLE ARMED' : ' · SINGLE DONE') : ''}${s.trig !== 'FREE' ? ` · PRE ${Math.round(s.pre * 100)} %` : ''}`);
    }
    parts.push(this.gainText());
    el.innerHTML = `${parts.filter(Boolean).map(esc).join(' · ')}<span class="${this.calOk ? '' : 'warn'}">${esc(this.calNote)}</span>`;
  }

  // ---- the controls under the instrument ----------------------------------------------------------------------

  /** Build the controls for the mode (redrawn when the mode or a structural choice changes). */
  controls(): void {
    const c = this.ctl(); if (!c) return;
    const s = this.s;
    const seg = (items: [string, string][], cur: string, attr: string) => `<div class="seg sp-seg">${items.map(([v, l]) => `<button data-${attr}="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const step = (id: string, label: string, val: string) => `<div class="stepper sp-step"><button data-dn="${id}">−</button><span><i>${label}</i> ${val}</span><button data-up="${id}">+</button></div>`;
    const tog = (id: string, label: string, on: boolean) => `<button data-tog="${id}" class="tog${on ? ' on' : ''}">${label}</button>`;
    const act = (id: string, label: string, cls = '') => `<button data-act="${id}" class="chip ${cls}">${label}</button>`;
    const common = `
      <div class="caption">RADIO · EXPORT · OPEN IN</div>
      <div class="ctlrow sp-row">${act('radio', `RADIO · ${this.gainText()}`)}${act('csv', 'CSV')}${act('png', 'PNG')}${act('analyzer', 'OPEN IN ANALYZER')}${act('devices', 'OPEN IN DEVICES')}</div>
      <div class="note">Gain is set in RADIO and held while Spectrum is open (the AGC does not move it under a measurement). The dBm scale follows the gain and is approximate; CAL trims it against a known source. ANALYZER and DEVICES open on ${s.mode === 'ZERO' ? 'the zero-span frequency' : 'the active marker (or the center)'}. On the plot: scroll or pinch to zoom, drag to pan, tap to drop the active marker, drag a marker to move it.</div>`;
    let body = `<div class="ctlrow sp-row">${seg([['FREQ', 'FREQUENCY'], ['ZERO', 'ZERO SPAN']], s.mode, 'mode')}</div>`;
    if (s.mode === 'FREQ') {
      body += `
      <div class="caption">SPAN</div>
      <div class="ctlrow sp-row sp-presets">${SPAN_PRESETS.map(([l, v]) => `<button data-span="${v}" class="chip${s.span === v ? ' on' : ''}">${l}</button>`).join('')}${tog('ss', 'START/STOP', s.startStop)}</div>
      <div class="caption">SCALE · RESOLUTION</div>
      <div class="ctlrow sp-row">${step('div', 'SCALE', `${s.div} dB/div`)}${seg([['dBm', 'dBm'], ['dBFS', 'dBFS']], s.unit, 'unit')}${step('cal', 'CAL', `${s.cal > 0 ? '+' : ''}${s.cal} dB`)}</div>
      <div class="ctlrow sp-row">${seg([['HANN', 'HANN'], ['FLATTOP', 'FLAT TOP']], s.window, 'win')}${seg(DETECTORS.map(d => [d, d] as [string, string]), s.det, 'det')}</div>
      <div class="caption">TRACES</div>
      ${this.traces.map((t, i) => `<div class="ctlrow sp-row sp-trace" style="--tc:${TRACE_COLOR[i]}"><b>T${i + 1}</b>${seg(TRACE_MODES.map(m => [m, m] as [string, string]), t.mode, `tr${i}`)}${t.mode === 'AVG' ? step(`avg${i}`, 'N', String(t.avgN)) : ''}<button data-clr="${i}" class="tog">CLEAR</button></div>`).join('')}
      <div class="caption">MARKERS</div>
      <div class="ctlrow sp-row">${seg(s.markers.map((m, i) => [String(i), `M${i + 1}${m.on ? (m.delta ? ' Δ' : ' ◆') : ''}`] as [string, string]), String(s.active), 'mk')}${tog('mkon', 'ON', s.markers[s.active].on)}${s.active ? tog('mkd', 'DELTA', s.markers[s.active].delta) : ''}</div>
      <div class="ctlrow sp-row">${seg([0, 1, 2, 3].map(i => [String(i), `READS T${i + 1}`] as [string, string]), String(s.markers[s.active].trace), 'mkt')}</div>
      <div class="ctlrow sp-row sp-pk">${act('peak', 'PEAK', 'hot')}${act('next', 'NEXT PEAK')}${act('left', '◀ NEXT')}${act('right', 'NEXT ▶')}${act('mkcf', 'MKR → CENTER')}${act('mkoff', 'ALL OFF')}${act('autoscale', 'AUTO SCALE')}</div>
      <div class="caption">MEASURE</div>
      <div class="ctlrow sp-row">${seg(MEAS, s.meas, 'meas')}${tog('persist', 'PERSISTENCE', s.persist)}</div>
      ${s.meas === 'CHP' || s.meas === 'ACPR' ? `<div class="ctlrow sp-row">${step('chbw', 'CHANNEL', bwText(s.chBw))}${s.meas === 'ACPR' ? step('spacing', 'SPACING', bwText(s.spacing)) : ''}</div>` : ''}`;
    } else {
      body += `
      <div class="caption">FILTER</div>
      <div class="ctlrow sp-row">${seg(this.zsBws().map(b => [String(b), bwText(b).replace(' ', '')] as [string, string]), String(s.zsBw), 'zbw')}</div>
      <div class="caption">TRIGGER</div>
      <div class="ctlrow sp-row">${seg(TRIG_MODES.map(m => [m, m === 'FREE' ? 'FREE RUN' : m === 'RISE' ? 'RISING' : 'FALLING'] as [string, string]), s.trig, 'trig')}${tog('single', 'SINGLE', s.single)}${s.single ? act('arm', this.armed ? 'ARMED' : 'ARM', this.armed ? 'hot' : '') : ''}${act('autolvl', 'AUTO LEVEL')}</div>
      ${s.trig !== 'FREE' ? `<div class="ctlrow sp-row">${step('pre', 'PRE-TRIGGER', `${Math.round(s.pre * 100)} %`)}</div>` : ''}
      <div class="caption">VIEW · SCALE</div>
      <div class="ctlrow sp-row">${tog('vamp', 'AMPLITUDE', s.showAmp)}${tog('vfm', 'FREQUENCY', s.showFm)}${tog('vph', 'PHASE', s.showPh)}${tog('cur', 'CURSORS', s.cursors)}</div>
      <div class="ctlrow sp-row">${step('div', 'SCALE', `${s.div} dB/div`)}${seg([['dBm', 'dBm'], ['dBFS', 'dBFS']], s.unit, 'unit')}</div>`;
    }
    c.innerHTML = body + common;
    this.bind(c);
  }

  private bind(c: HTMLElement): void {
    const s = this.s;
    c.onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!b) return;
      const d = b.dataset;
      if (d.mode) { s.mode = d.mode as Mode; this.controls(); this.restart(); return; }
      if (d.span) { this.setSpan(s.center, Number(d.span)); return; }
      if (d.unit) { s.unit = d.unit as 'dBm' | 'dBFS'; for (const t of this.traces) t.clear(); for (const a of this.mkAvg) a.n = 0; this.persist?.clear(); this.controls(); this.update(); return; }
      if (d.win) { s.window = d.win as WindowKind; this.controls(); this.restart(); return; }
      if (d.det) { s.det = d.det as Detector; this.controls(); this.tiles(); this.draw(); return; }
      if (d.meas) { s.meas = d.meas as Meas; this.controls(); this.draw(); return; }
      if (d.mk) { s.active = Number(d.mk); this.controls(); this.draw(); return; }
      if (d.mkt) { s.markers[s.active].trace = Number(d.mkt); this.controls(); this.draw(); this.save(); return; }
      if (d.zbw) { s.zsBw = Number(d.zbw); this.controls(); this.restart(); return; }
      if (d.trig) { s.trig = d.trig as TrigMode; this.controls(); this.update(); return; }
      if (d.clr !== undefined) { this.traces[Number(d.clr)].clear(); for (const a of this.mkAvg) a.n = 0; this.draw(); return; }
      for (let i = 0; i < 4; i++) if (d[`tr${i}`]) { this.traces[i].setMode(d[`tr${i}`] as TraceMode); s.traces[i].mode = this.traces[i].mode; this.controls(); this.save(); this.draw(); return; }
      if (d.up || d.dn) { this.stepper((d.up || d.dn)!, d.up ? 1 : -1); return; }
      if (d.tog) { this.toggle(d.tog); return; }
      if (d.act) { this.action(d.act); return; }
    };
  }

  private stepper(id: string, dir: number): void {
    const s = this.s;
    const idx = <T>(list: T[], v: T) => Math.max(0, list.indexOf(v));
    switch (id) {
      case 'div': s.div = DIVS[Math.max(0, Math.min(DIVS.length - 1, idx(DIVS, s.div) + dir))]; this.persist?.clear(); break;
      case 'cal': s.cal = Math.max(-40, Math.min(40, s.cal + dir)); break;
      case 'chbw': s.chBw = Math.min(stepBw(s.chBw, dir), Math.max(1000, s.span)); break;
      case 'spacing': s.spacing = stepBw(s.spacing, dir); break;
      case 'zst': {
        const plan = zsPlan(this.zsRate(), s.zsBw), max = ZS_MAX_POINTS / plan.outRate;
        const i = SWEEP_TIMES.findIndex(x => x >= s.zsTime * 0.999);
        s.zsTime = Math.min(max, SWEEP_TIMES[Math.max(0, Math.min(SWEEP_TIMES.length - 1, (i < 0 ? SWEEP_TIMES.length - 1 : i) + dir))]);
        this.controls(); this.restart(); return;
      }
      case 'pre': s.pre = Math.max(0, Math.min(0.9, Math.round((s.pre + dir * 0.1) * 10) / 10)); break;
      default: {
        const m = /^avg(\d)$/.exec(id);
        if (m) { const t = this.traces[Number(m[1])]; t.avgN = Math.max(2, Math.min(1000, t.avgN < 10 ? t.avgN + dir : Math.round(t.avgN * (dir > 0 ? 2 : 0.5)))); s.traces[Number(m[1])].avgN = t.avgN; t.clear(); }
      }
    }
    this.controls(); this.update();
  }

  private toggle(id: string): void {
    const s = this.s, m = s.markers[s.active];
    switch (id) {
      case 'ss': s.startStop = !s.startStop; this.tiles(); break;
      case 'rbwa': s.rbwAuto = !s.rbwAuto; this.controls(); this.restart(); return;
      case 'vbwa': s.vbwAuto = !s.vbwAuto; this.controls(); this.update(); return;
      // a marker switched on with nowhere in the span to be starts on the highest peak
      case 'mkon': m.on = !m.on; if (m.on && !(m.hz >= this.start && m.hz <= this.stop)) { m.on = false; this.markerTo(s.active, 'peak'); } break;
      case 'mkd': m.delta = !m.delta; if (m.delta && !s.markers[0].on) { s.markers[0].on = true; s.markers[0].hz = m.hz; } break;
      case 'persist': s.persist = !s.persist; this.persist = null; break;
      case 'single': s.single = !s.single; this.controls(); this.update(); if (!s.single) this.host.post({ type: 'spectrum', cmd: 'rearm' }); return;
      case 'vamp': s.showAmp = !s.showAmp; break;
      case 'vfm': s.showFm = !s.showFm; break;
      case 'vph': s.showPh = !s.showPh; break;
      case 'cur': s.cursors = !s.cursors; break;
    }
    this.controls(); this.save(); this.draw();
  }

  private action(id: string): void {
    const s = this.s;
    switch (id) {
      case 'peak': case 'next': case 'left': case 'right': this.markerTo(s.active, id); break;
      case 'mkcf': { const m = s.markers[s.active]; if (m.on) this.setSpan(m.hz, s.span); return; }
      case 'mkoff': for (const m of s.markers) { m.on = false; m.delta = false; } break;
      case 'autoscale': this.autoScaleNow(); return;
      // the trigger level from what is on screen: the noise between bursts plus 12 dB (arming RISE from FREE RUN)
      case 'autolvl': { const z = this.zcap; if (!z) return; const l = autoLevel(z.amp); if (!Number.isFinite(l)) return; s.level = l; if (s.trig === 'FREE') s.trig = 'RISE'; this.controls(); this.update(); return; }
      case 'arm': this.armed = true; this.host.post({ type: 'spectrum', cmd: 'rearm' }); this.tiles(); break;
      case 'radio': this.host.openRadio(); return;
      case 'csv': this.exportCsv(); return;
      case 'png': this.exportPng(); return;
      case 'analyzer': case 'devices': this.host.openApp(id, this.selectedHz()); return;
    }
    this.controls(); this.save(); this.draw();
  }

  /** The frequency the OPEN IN buttons hand over. */
  selectedHz(): number {
    const s = this.s;
    if (s.mode === 'ZERO') return s.zsFreq;
    const m = s.markers[s.active];
    return m.on ? m.hz : s.center;
  }

  /** The trace a marker reads, falling back to the first one with data. */
  private traceFor(i: number): Trace | null {
    const t = this.traces[i];
    if (t.data && t.mode !== 'OFF') return t;
    return this.traces.find(x => x.data && x.mode !== 'OFF') ?? null;
  }

  /** Peak search for marker `k`. */
  markerTo(k: number, how: 'peak' | 'next' | 'left' | 'right'): void {
    const m = this.s.markers[k], t = this.traceFor(m.trace);
    if (!t?.data) return;
    const n = t.data.length, cur = binOf(m.hz, t.f0, t.binHz, n);
    // a marker off, or left outside the trace, starts from a peak search whatever was asked
    const inside = m.hz >= t.f0 - t.binHz && m.hz <= t.f0 + n * t.binHz;
    const i = !m.on || !inside || how === 'peak' ? peakSearch(t.data) : how === 'next' ? nextPeak(t.data, cur) : how === 'left' ? nextPeakLeft(t.data, cur) : nextPeakRight(t.data, cur);
    const r = refinePeak(t.data, i);
    m.hz = t.f0 + (i + r.offset) * t.binHz; m.on = true;
  }

  // ---- gestures on the plot -----------------------------------------------------------------------------------

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.cv!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  /** Plot x (CSS px) to hertz on the span drawn. */
  private hzAt(x: number): number { const g = this.geom(); return this.vCenter() - this.vSpan() / 2 + (x - g.l) / g.w * this.vSpan(); }
  private xOfHz(hz: number): number { const g = this.geom(); return g.l + (hz - (this.vCenter() - this.vSpan() / 2)) / this.vSpan() * g.w; }

  private down(e: PointerEvent): void {
    try { this.cv!.setPointerCapture(e.pointerId); } catch { /* a pointer the page did not see go down */ }
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    const g = this.geom();
    if (this.s.mode === 'ZERO') {
      // zero span takes no pinch (the plot is left to a capture); the nearer cursor follows a drag or jumps to a tap
      if (!this.s.cursors || this.pts.size > 1) return;
      const fx = (p.x - g.l) / g.w;
      this.gesture = { kind: 'cursor', x0: p.x, center0: 0, span0: 0, d0: 0, which: Math.abs(fx - this.s.curA) < Math.abs(fx - this.s.curB) ? 0 : 1 };
      return;
    }
    if (this.pts.size === 2) {
      const [a, b] = [...this.pts.values()];
      this.gesture = { kind: 'pinch', x0: (a.x + b.x) / 2, center0: this.vCenter(), span0: this.vSpan(), d0: Math.max(10, Math.abs(a.x - b.x)), which: 0 };
      return;
    }
    // on a marker: drag it; anywhere else: a tap drops the active marker, a drag pans
    const near = this.s.markers.findIndex(m => m.on && Math.abs(this.xOfHz(m.hz) - p.x) < 12);
    if (near >= 0) { this.s.active = near; this.gesture = { kind: 'marker', x0: p.x, center0: 0, span0: 0, d0: 0, which: near }; this.controls(); return; }
    this.gesture = { kind: 'tap', x0: p.x, center0: this.vCenter(), span0: this.vSpan(), d0: 0, which: 0 };
  }

  private move(e: PointerEvent): void {
    if (!this.pts.has(e.pointerId) || !this.gesture) return;
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    const g = this.geom(), gs = this.gesture;
    if (gs.kind === 'pinchT') {
      if (this.pts.size < 2) return;
      const [a, b] = [...this.pts.values()];
      this.pinchTime = Math.max(SWEEP_TIMES[0], Math.min(this.zsMostSec(), gs.span0 * gs.d0 / Math.max(10, Math.abs(a.x - b.x))));
      this.tiles(); return;
    }
    if (gs.kind === 'cursor') {
      const fx = Math.max(0, Math.min(1, (p.x - g.l) / g.w));
      if (gs.which === 0) this.s.curA = fx; else this.s.curB = fx;
      this.draw(); return;
    }
    if (gs.kind === 'marker') { const m = this.s.markers[gs.which]; m.hz = Math.max(this.start, Math.min(this.stop, this.hzAt(p.x))); this.draw(); return; }
    if (gs.kind === 'pinch' && this.pts.size >= 2) {
      const [a, b] = [...this.pts.values()];
      const d = Math.max(10, Math.abs(a.x - b.x));
      const anchor = gs.center0 - gs.span0 / 2 + (gs.x0 - g.l) / g.w * gs.span0;
      const span = Math.max(MIN_SPAN, gs.span0 * gs.d0 / d);
      const mid = (a.x + b.x) / 2;
      this.preview(anchor - ((mid - g.l) / g.w - 0.5) * span, span);
      return;
    }
    if (gs.kind === 'tap' && Math.abs(p.x - gs.x0) > 6) gs.kind = 'pan';
    if (gs.kind === 'pan') this.preview(gs.center0 - (p.x - gs.x0) / g.w * gs.span0, gs.span0);
  }

  private up(e: PointerEvent): void {
    const gs = this.gesture;
    const p = this.pts.get(e.pointerId);
    this.pts.delete(e.pointerId);
    if (!gs) return;
    if (gs.kind === 'pinch') { if (this.pts.size < 2) { this.gesture = null; this.commitSoon(0); } return; }
    if (gs.kind === 'pinchT') {
      if (this.pts.size >= 2) return;
      this.gesture = null;
      // snap to the nearest 1-2-5 sweep time
      const want = this.pinchTime; this.pinchTime = NaN;
      if (Number.isFinite(want)) { this.s.zsTime = Math.min(this.zsMostSec(), SWEEP_TIMES.reduce((p, x) => (Math.abs(Math.log(x / want)) < Math.abs(Math.log(p / want)) ? x : p))); this.controls(); this.restart(); }
      return;
    }
    this.gesture = null;
    if (gs.kind === 'tap' && p && this.s.mode === 'FREQ') {
      const m = this.s.markers[this.s.active];
      m.on = true; m.hz = this.hzAt(p.x);
      // a tap snaps to the peak under the finger when there is one within a few pixels
      const t = this.traceFor(m.trace);
      if (t?.data) {
        const g = this.geom(), half = Math.max(1, Math.round(8 / g.w * this.s.span / t.binHz));
        const c = binOf(m.hz, t.f0, t.binHz, t.data.length);
        let best = c; for (let i = Math.max(0, c - half); i <= Math.min(t.data.length - 1, c + half); i++) if (t.data[i] > t.data[best]) best = i;
        m.hz = t.f0 + (best + refinePeak(t.data, best).offset) * t.binHz;
      }
      this.controls(); this.save(); this.draw();
    } else if (gs.kind === 'pan') this.commitSoon(0);
    else if (gs.kind === 'cursor' && p) { const g = this.geom(), fx = Math.max(0, Math.min(1, (p.x - g.l) / g.w)); if (gs.which === 0) this.s.curA = fx; else this.s.curB = fx; this.save(); this.draw(); }
    else if (gs.kind === 'marker') { this.save(); this.draw(); }
  }

  private wheel(e: WheelEvent): void {
    if (this.s.mode !== 'FREQ') return;
    e.preventDefault();
    const g = this.geom(), p = this.local(e);
    const span = this.vSpan(), center = this.vCenter();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // sideways: pan by a tenth of the span per notch
      const d = (e.shiftKey ? e.deltaY : e.deltaX) > 0 ? 1 : -1;
      this.preview(center + d * span / 10, span);
    } else {
      // zoom about the frequency under the pointer
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      const anchor = this.hzAt(p.x), fx = (p.x - g.l) / g.w;
      const ns = Math.max(MIN_SPAN, Math.min(MAX_HZ - MIN_HZ, span * k));
      this.preview(anchor - (fx - 0.5) * ns, ns);
    }
    this.commitSoon(350);
  }

  /** Draw the span a gesture is making, with what is already measured shifted under it. */
  private preview(center: number, span: number): void {
    span = Math.max(MIN_SPAN, Math.min(MAX_HZ - MIN_HZ, span));
    center = Math.max(MIN_HZ + span / 2, Math.min(MAX_HZ - span / 2, center));
    this.view = { center, span };
    this.tilesPreview();
    this.draw();
  }
  /** The CENTER and SPAN tiles follow a gesture as it is made. */
  private tilesPreview(): void {
    const v = this.view; if (!v || this.s.startStop) return;
    const put = (id: string, hz: number) => { const b = this.root?.querySelector(`[data-tile="${id}"] .sp-tv`); if (b) { const [t, u] = bigHz(hz); b.innerHTML = `${esc(t)}<small>${u}</small>`; } };
    put('center', v.center); put('span', v.span);
  }
  /** Apply the gesture's span once it settles. */
  private commitSoon(ms: number): void {
    clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      if (!this.view || this.gesture) return;
      const v = this.view;
      this.setSpan(v.center, v.span);
    }, ms);
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  draw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.paint(); });
  }

  /** The plot area inside the canvas, in CSS pixels. */
  private geom(): Geom {
    const cv = this.cv!, W = cv.clientWidth || 600, H = cv.clientHeight || 300;
    const l = 48, t = 30, r = 10, b = 24;
    return { l, t, w: W - l - r, h: H - t - b, W, H };
  }

  private paint(): void {
    const cv = this.cv; if (!cv || !this.host.showing()) return;
    const dpr = window.devicePixelRatio || 1;
    const g = this.geom();
    if (cv.width !== Math.round(g.W * dpr) || cv.height !== Math.round(g.H * dpr)) { cv.width = Math.round(g.W * dpr); cv.height = Math.round(g.H * dpr); }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render(ctx, g);
    this.side();
  }

  /** Draw the whole plot into a context (the screen, or the PNG export). */
  render(ctx: CanvasRenderingContext2D, g: Geom): void {
    const css = getComputedStyle(document.documentElement);
    const paper = css.getPropertyValue('--paper').trim() || '#0a0d13', line = css.getPropertyValue('--line').trim() || '#2a3348', muted = css.getPropertyValue('--muted').trim() || '#8d97ab', ink = css.getPropertyValue('--ink').trim() || '#e8ecf4', accent = css.getPropertyValue('--accent').trim() || '#4c8dff';
    ctx.fillStyle = paper; ctx.fillRect(0, 0, g.W, g.H);
    // the screen: a faint glass gradient inside the graticule
    const bg = ctx.createLinearGradient(0, g.t, 0, g.t + g.h);
    bg.addColorStop(0, 'rgba(76,141,255,0.07)'); bg.addColorStop(1, 'rgba(76,141,255,0.015)');
    ctx.fillStyle = bg; ctx.fillRect(g.l, g.t, g.w, g.h);
    if (this.s.mode === 'ZERO') { this.renderZero(ctx, g, line, muted, ink); return; }
    const s = this.s, top = s.ref, range = s.div * 10;
    const vs = this.vSpan(), vStart = this.vCenter() - vs / 2;
    const yOf = (v: number) => g.t + (top - v) / range * g.h;
    const xOf = (hz: number) => g.l + (hz - vStart) / vs * g.w;
    // the density display, under everything (it is drawn for the settled span only)
    if (s.persist && this.persist && !this.view) this.renderDensity(ctx, g);
    this.graticule(ctx, g, line, muted, (k) => String(+(top - k * s.div).toFixed(1)));
    ctx.font = '600 11px ui-monospace, monospace'; ctx.fillStyle = muted;
    const wide = g.w >= 560;
    ctx.textAlign = 'left'; ctx.fillText(`${wide ? 'START ' : ''}${fmtHz(vStart, 4)}`, g.l, g.t + g.h + 16);
    ctx.textAlign = 'center'; ctx.fillText(wide ? `${fmtHz(vStart + vs / 2, 6)}  ·  ${bwText(vs / 10)}/div` : `${bwText(vs / 10)}/div`, g.l + g.w / 2, g.t + g.h + 16);
    ctx.textAlign = 'right'; ctx.fillText(`${wide ? 'STOP ' : ''}${fmtHz(vStart + vs, 4)}`, g.l + g.w, g.t + g.h + 16);
    // top-left: the scale
    ctx.textAlign = 'left'; ctx.fillStyle = ink; ctx.font = '700 12px ui-monospace, monospace';
    ctx.fillText(`REF ${s.ref} ${this.unitLabel()}`, g.l, 13);
    ctx.fillStyle = muted; ctx.font = '600 11px ui-monospace, monospace';
    // a narrow plot (a phone) leaves the second line to the marker: RBW and VBW are on the tiles anyway
    const narrow = g.w < 560;
    if (!narrow) ctx.fillText(`${s.div} dB/div · RBW ${bwText(this.frame?.rbw ?? this.rbwHz())} · VBW ${s.vbwAuto ? 'AUTO' : bwText(s.vbw)}`, g.l, 26);
    else { ctx.textAlign = 'left'; ctx.fillText(`${s.div} dB/div`, g.l + ctx.measureText(`REF ${s.ref} ${this.unitLabel()}  `).width + 12, 13); }
    ctx.save(); ctx.beginPath(); ctx.rect(g.l, g.t, g.w, g.h); ctx.clip();
    // measurement bands
    const t0 = this.measTrace();
    if (t0 && s.meas !== 'OFF' && s.meas !== 'NOISE') {
      const band = (c: number, bw: number, col: string) => {
        const a = xOf(c - bw / 2), b = xOf(c + bw / 2);
        ctx.fillStyle = col; ctx.fillRect(a, g.t, Math.max(1, b - a), g.h);
        ctx.strokeStyle = col.replace(/[\d.]+\)$/, '0.7)'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(a, g.t); ctx.lineTo(a, g.t + g.h); ctx.moveTo(b, g.t); ctx.lineTo(b, g.t + g.h); ctx.stroke(); ctx.setLineDash([]);
      };
      if (s.meas === 'CHP') band(s.center, s.chBw, 'rgba(76,141,255,0.16)');
      if (s.meas === 'ACPR') { band(s.center, s.chBw, 'rgba(76,141,255,0.16)'); band(s.center - s.spacing, s.chBw, 'rgba(255,175,0,0.13)'); band(s.center + s.spacing, s.chBw, 'rgba(255,175,0,0.13)'); }
      if (s.meas === 'OBW' && t0.data) { const o = occupiedBw(t0.data, t0.f0, t0.binHz, this.frame?.rbw ?? 1); band((o.lo + o.hi) / 2, o.bw, 'rgba(76,141,255,0.16)'); }
    }
    // traces: a soft glow under a crisp line, the live trace filled down to the floor
    const cols = Math.max(2, Math.round(g.w));
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const t = this.traces[i];
      if (!t.data || t.mode === 'OFF') continue;
      const x0 = xOf(t.f0 - t.binHz / 2), x1 = xOf(t.f0 + (t.data.length - 0.5) * t.binHz);
      const a = Math.max(g.l - 2, x0), b = Math.min(g.l + g.w + 2, x1);
      if (b <= a) continue;
      // the bins visible on screen, one column per pixel
      const n = Math.max(2, Math.min(cols, Math.round(b - a)));
      const i0 = Math.max(0, Math.floor((a - x0) / (x1 - x0) * t.data.length)), i1 = Math.min(t.data.length, Math.ceil((b - x0) / (x1 - x0) * t.data.length));
      if (i1 - i0 < 1) continue;
      const y = toColumns(t.data.subarray(i0, i1), n, s.det);
      const xa = x0 + i0 / t.data.length * (x1 - x0), xb = x0 + i1 / t.data.length * (x1 - x0);
      const path = new Path2D();
      for (let c = 0; c < n; c++) { const x = xa + (c + 0.5) * (xb - xa) / n, yy = yOf(y[c]); if (c) path.lineTo(x, yy); else path.moveTo(x, yy); }
      const col = TRACE_COLOR[i];
      if (t.mode === 'LIVE' && !s.persist) {
        const fill = new Path2D(path); fill.lineTo(xb, g.t + g.h); fill.lineTo(xa, g.t + g.h); fill.closePath();
        const gr = ctx.createLinearGradient(0, g.t, 0, g.t + g.h);
        gr.addColorStop(0, col + '2e'); gr.addColorStop(0.6, col + '0c'); gr.addColorStop(1, col + '00');
        ctx.fillStyle = gr; ctx.fill(fill);
      }
      ctx.lineJoin = 'round';
      ctx.strokeStyle = col + '22'; ctx.lineWidth = 7; ctx.stroke(path);
      ctx.strokeStyle = col + '55'; ctx.lineWidth = 3.5; ctx.stroke(path);
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke(path);
    }
    // a sweep's position: a thin bright line where the radio is now
    const f = this.frame;
    if (f?.sweep && f.steps > 1 && f.step < f.steps && !this.view) {
      const x = g.l + g.w * f.step / f.steps;
      const gr = ctx.createLinearGradient(x - 18, 0, x, 0); gr.addColorStop(0, 'rgba(255,175,0,0)'); gr.addColorStop(1, 'rgba(255,175,0,0.25)');
      ctx.fillStyle = gr; ctx.fillRect(x - 18, g.t, 18, g.h);
      ctx.fillStyle = ACTIVE; ctx.fillRect(x - 1, g.t, 2, g.h);
    }
    ctx.restore();
    // markers: a diamond on the trace and a numbered tag over it
    s.markers.forEach((m, k) => {
      if (!m.on) return;
      const lvl = this.markerLevel(k);
      const x = xOf(m.hz);
      if (x < g.l - 1 || x > g.l + g.w + 1) return;
      const y = Number.isFinite(lvl) ? Math.max(g.t + 4, Math.min(g.t + g.h - 4, yOf(lvl))) : g.t + 12;
      const col = k === s.active ? ACTIVE : '#ffffff';
      ctx.save();
      ctx.shadowColor = col; ctx.shadowBlur = 10;
      ctx.fillStyle = col; ctx.strokeStyle = '#05080a'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      const tag = `${m.delta && k ? 'Δ' : ''}${k + 1}`;
      ctx.font = '800 11px ui-monospace, monospace';
      const tw = ctx.measureText(tag).width + 8, ty = Math.max(g.t + 2, y - 26);
      ctx.fillStyle = col; this.roundRect(ctx, x - tw / 2, ty, tw, 15, 4); ctx.fill();
      ctx.fillStyle = '#05080a'; ctx.textAlign = 'center'; ctx.fillText(tag, x, ty + 11);
    });
    // top-right: the active marker, large, as a bench analyzer prints it
    const am = s.markers[s.active];
    if (am.on) {
      const lv = this.markerLevel(s.active);
      const d = am.delta && s.active > 0 && s.markers[0].on;
      const ref = d ? this.markerLevel(0) : 0;
      const head = d ? `ΔMKR${s.active + 1}` : `MKR${s.active + 1}`;
      const fx = d ? `${sgn(am.hz - s.markers[0].hz)}${fmtHz(Math.abs(am.hz - s.markers[0].hz), 6)}` : fmtHz(am.hz, 6);
      const fy = d ? `${sgn(lv - ref)}${db1(Math.abs(lv - ref))} dB` : `${db1(lv)} ${this.unitLabel()}`;
      ctx.textAlign = 'right';
      ctx.font = '700 11px ui-monospace, monospace'; ctx.fillStyle = ACTIVE; ctx.fillText(head, g.l + g.w, 13);
      ctx.font = `800 ${g.w < 560 ? 13 : 15}px ui-monospace, monospace`; ctx.fillStyle = ink; ctx.fillText(`${fx}   ${fy}`, g.l + g.w, 27);
    }
    if (!this.host.connected()) { ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.font = '600 13px sans-serif'; ctx.fillText('Connect a radio to measure', g.l + g.w / 2, g.t + g.h / 2); }
    void accent;
  }

  private graticule(ctx: CanvasRenderingContext2D, g: Geom, line: string, muted: string, label: (k: number) => string, rows = 10): void {
    ctx.lineWidth = 1;
    for (let k = 0; k <= 10; k++) {
      const x = Math.round(g.l + k * g.w / 10) + 0.5;
      ctx.strokeStyle = k === 5 ? line : line + 'aa';
      ctx.beginPath(); ctx.moveTo(x, g.t); ctx.lineTo(x, g.t + g.h); ctx.stroke();
    }
    ctx.font = '600 10px ui-monospace, monospace'; ctx.fillStyle = muted; ctx.textAlign = 'right';
    for (let k = 0; k <= rows; k++) {
      const y = Math.round(g.t + k * g.h / rows) + 0.5;
      ctx.strokeStyle = k === rows / 2 ? line : line + 'aa';
      ctx.beginPath(); ctx.moveTo(g.l, y); ctx.lineTo(g.l + g.w, y); ctx.stroke();
      ctx.fillText(label(k), g.l - 5, y + 3);
    }
    // minor ticks along the center lines, as on a bench screen
    ctx.strokeStyle = line;
    for (let k = 0; k <= 50; k++) { const x = Math.round(g.l + k * g.w / 50) + 0.5, y = g.t + g.h / 2; ctx.beginPath(); ctx.moveTo(x, y - 2); ctx.lineTo(x, y + 2); ctx.stroke(); }
    for (let k = 0; k <= rows * 5; k++) { const y = Math.round(g.t + k * g.h / (rows * 5)) + 0.5, x = g.l + g.w / 2; ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x + 2, y); ctx.stroke(); }
  }

  private renderDensity(ctx: CanvasRenderingContext2D, g: Geom): void {
    const p = this.persist!;
    const lv = p.level();
    const c = this.densityCanvas ??= document.createElement('canvas');
    if (c.width !== p.cols || c.height !== p.rows) { c.width = p.cols; c.height = p.rows; }
    const cc = c.getContext('2d')!;
    const img = cc.createImageData(p.cols, p.rows);
    const px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < lv.length; i++) { const v = lv[i]; px[i] = v > 0.003 ? PALETTE[Math.min(255, Math.round(Math.sqrt(v) * 255))] : 0; }
    cc.putImageData(img, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(c, g.l, g.t, g.w, g.h);
    ctx.restore();
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  private renderZero(ctx: CanvasRenderingContext2D, g: Geom, line: string, muted: string, ink: string): void {
    const s = this.s, z = this.zcap;
    const panes: ('amp' | 'fm' | 'ph')[] = [];
    if (s.showAmp) panes.push('amp'); if (s.showFm) panes.push('fm'); if (s.showPh) panes.push('ph');
    if (!panes.length) panes.push('amp');
    const gap = 12, ph = (g.h - gap * (panes.length - 1)) / panes.length;
    const len = z ? z.amp.length : 1, rate = z?.rate ?? 1, total = z ? len / rate : s.zsTime;
    const t0 = z && z.trig >= 0 ? -z.trig / rate : 0;
    // the level frequency and phase are drawn above: 10 dB over the median of the window (the noise between bursts)
    const gate = !z ? 0 : (() => { const q = Float32Array.from(z.amp).sort(); return q[q.length >> 1] + 10; })();
    // the frequency pane fits the signal's swing (an FSK tone may sit past half the filter), in 1-2-5 steps
    const fmHalf = z ? fmScale(z.fm, z.amp, gate, s.zsBw) : s.zsBw / 2;
    ctx.textAlign = 'left'; ctx.fillStyle = ink; ctx.font = '700 12px ui-monospace, monospace';
    ctx.fillText(`${fmtHz(s.zsFreq, 6)} · FILTER ${bwText(s.zsBw)}`, g.l, 13);
    ctx.fillStyle = muted; ctx.font = '600 11px ui-monospace, monospace';
    ctx.fillText(`REF ${s.ref} ${this.unitLabel()} · ${s.div} dB/div · ${s.trig === 'FREE' ? 'FREE RUN' : `${s.trig === 'RISE' ? 'RISING' : 'FALLING'} ${s.level} ${this.unitLabel()}`}`, g.l, 26);
    panes.forEach((p, k) => {
      const top = g.t + k * (ph + gap);
      const rows = p === 'amp' ? 10 : 4;
      let lo: number, hi: number;
      if (p === 'amp') { hi = s.ref; lo = s.ref - s.div * 10; }
      else if (p === 'fm') { hi = fmHalf; lo = -fmHalf; }
      else { hi = 180; lo = -180; }
      const pg: Geom = { ...g, t: top, h: ph };
      if (k > 0) { ctx.fillStyle = 'rgba(76,141,255,0.05)'; ctx.fillRect(g.l, top, g.w, ph); }
      this.graticule(ctx, pg, line, muted, (d) => { const v = hi - d * (hi - lo) / rows; return p === 'fm' ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${bwText(Math.abs(v)).replace(' ', '')}` : String(+v.toFixed(0)); }, rows);
      const col = TRACE_COLOR[p === 'amp' ? 0 : p === 'fm' ? 1 : 2];
      ctx.textAlign = 'left'; ctx.fillStyle = col; ctx.font = '700 10px ui-monospace, monospace';
      ctx.fillText(p === 'amp' ? `AMPLITUDE ${this.unitLabel()}` : p === 'fm' ? 'FREQUENCY' : 'PHASE °', g.l + 5, top + 12);
      if (!z) return;
      const arr = p === 'amp' ? z.amp : p === 'fm' ? z.fm : z.ph;
      const yOf = (v: number) => top + (hi - v) / (hi - lo) * ph;
      ctx.save(); ctx.beginPath(); ctx.rect(g.l, top, g.w, ph); ctx.clip();
      if (p === 'amp' && s.trig !== 'FREE') { ctx.strokeStyle = ACTIVE; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(g.l, yOf(s.level)); ctx.lineTo(g.l + g.w, yOf(s.level)); ctx.stroke(); ctx.setLineDash([]); }
      // Frequency and phase mean something only while there is a signal: they are drawn where the amplitude stands
      // 10 dB over the noise and left blank in the noise between.
      const gated = (i: number) => p === 'amp' || z.amp[i] >= gate;
      const cols = Math.max(2, Math.round(g.w));
      const band = new Path2D(), trace = new Path2D();
      let pen = false;
      if (arr.length > cols * 2) {
        // dense: each column's spread as a faint band, and a crisp line through its peak (amplitude) or its middle
        for (let c = 0; c < cols; c++) {
          const a = Math.floor(c * arr.length / cols), b = Math.max(a + 1, Math.floor((c + 1) * arr.length / cols));
          let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
          for (let i = a; i < b; i++) { if (!gated(i)) continue; const v = arr[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++; }
          const x = g.l + c + 0.5;
          if (!n) { pen = false; continue; }
          band.moveTo(x, yOf(mx)); band.lineTo(x, yOf(mn) + 0.6);
          const y = yOf(p === 'amp' ? mx : p === 'fm' ? sum / n : arr[Math.floor((a + b) / 2)]);
          if (pen) trace.lineTo(x, y); else trace.moveTo(x, y);
          pen = true;
        }
      } else {
        for (let i = 0; i < arr.length; i++) {
          if (!gated(i)) { pen = false; continue; }
          const x = g.l + (i + 0.5) / arr.length * g.w, y = yOf(arr[i]);
          if (pen) trace.lineTo(x, y); else trace.moveTo(x, y);
          pen = true;
        }
      }
      // a preview (waiting for the trigger) is drawn dimmed: it is the channel now, not a capture
      const dim = z.preview ? 0.4 : 1;
      ctx.globalAlpha = 0.22 * dim; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke(band);
      ctx.globalAlpha = dim;
      ctx.strokeStyle = col + '30'; ctx.lineWidth = 4; ctx.stroke(trace);
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke(trace);
      ctx.globalAlpha = 1;
      if (z.trig >= 0) { const x = g.l + z.trig / len * g.w; ctx.strokeStyle = ACTIVE; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke(); if (k === 0) { ctx.fillStyle = ACTIVE; ctx.beginPath(); ctx.moveTo(x - 6, top); ctx.lineTo(x + 6, top); ctx.lineTo(x, top + 8); ctx.fill(); } }
      if (s.cursors) for (const [c, l] of [[s.curA, 'A'], [s.curB, 'B']] as [number, string][]) {
        const x = g.l + c * g.w; ctx.strokeStyle = '#ffffff'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke(); ctx.setLineDash([]);
        if (k === 0) { ctx.fillStyle = '#ffffff'; this.roundRect(ctx, x - 8, top + 2, 16, 15, 4); ctx.fill(); ctx.fillStyle = '#05080a'; ctx.textAlign = 'center'; ctx.font = '800 11px ui-monospace, monospace'; ctx.fillText(l, x, top + 13); }
      }
      ctx.restore();
    });
    ctx.fillStyle = muted; ctx.font = '600 11px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.fillText(fmtSec(t0), g.l, g.t + g.h + 16);
    ctx.textAlign = 'right'; ctx.fillText(fmtSec(t0 + total), g.l + g.w, g.t + g.h + 16);
    ctx.textAlign = 'center'; ctx.fillText(`${fmtSec(total / 10)}/div`, g.l + g.w / 2, g.t + g.h + 16);
    ctx.font = '600 13px sans-serif';
    if (!this.host.connected()) ctx.fillText('Connect a radio to measure', g.l + g.w / 2, g.t + g.h / 2);
    else if (!z || z.preview) {
      const msg = s.trig === 'FREE' ? 'Starting…' : `Waiting for the trigger (${s.trig === 'RISE' ? 'rising' : 'falling'} through ${s.level} ${this.unitLabel()})`;
      // with a preview on screen the dimmed trace says it all (the status line says ARMED); text only on an empty plot
      if (!z) ctx.fillText(msg, g.l + g.w / 2, g.t + g.h / 2);
    }
  }

  /** The trace the measurements read: the active marker's, else the first with data. */
  private measTrace(): Trace | null { return this.traceFor(this.s.markers[this.s.active].trace); }

  // ---- the side panel: the measurement, large, and the marker table --------------------------------------------

  private side(): void {
    const meas = this.root?.querySelector<HTMLElement>('#sp-meas'), mkt = this.root?.querySelector<HTMLElement>('#sp-mkt');
    if (!meas || !mkt) return;
    const s = this.s, u = this.unitLabel();
    const big = (label: string, v: string, unit: string, cls = '') => `<div class="sp-big ${cls}"><span>${label}</span><b>${esc(v)}<small>${esc(unit)}</small></b></div>`;
    if (s.mode === 'ZERO') {
      const z = this.zcap, st = this.zstats;
      const split = (t: string) => { const i = t.lastIndexOf(' '); return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)]; };
      let h = `<div class="sp-mh">PULSE</div>`;
      if (st) {
        const cells: [string, string][] = [['WIDTH', fmtSec(st.width)], ['PERIOD', fmtSec(st.period)], ['DUTY', Number.isFinite(st.duty) ? `${(st.duty * 100).toFixed(1)} %` : '—'], ['RISE', fmtSec(st.rise)], ['FALL', fmtSec(st.fall)], ['PULSES', `${st.pulses} `]];
        h += `<div class="sp-bigs">${cells.map(([l, v]) => { const [a, b] = split(v); return big(l, a, b); }).join('')}</div>
          <div class="sp-msub">top ${db1(st.top)} ${u} · base ${db1(st.base)} ${u} · ${db1(st.top - st.base)} dB on/off</div>`;
      } else h += `<div class="sp-msub">${z?.preview ? 'Waiting for the trigger: the channel is shown dimmed until something crosses the level.' : z ? 'No pulses in this window: it needs two distinct levels at least 10 dB apart.' : 'Waiting for samples.'}</div>`;
      meas.innerHTML = h;
      if (s.cursors && z) {
        const len = z.amp.length, at = (c: number) => Math.max(0, Math.min(len - 1, Math.round(c * (len - 1))));
        const a = at(s.curA), b = at(s.curB), dt = (b - a) / z.rate;
        const t = (i: number) => (i - Math.max(0, z.trig)) / z.rate;
        const row = (k: string, i: number) => `<tr><td><b class="sp-dot" style="--c:#fff">${k}</b></td><td>${fmtSec(t(i))}</td><td>${db1(z.amp[i])} ${u}</td><td>${sgn(z.fm[i])}${bwText(Math.abs(z.fm[i]))}</td><td>${z.ph[i].toFixed(0)}°</td></tr>`;
        mkt.innerHTML = `<table><thead><tr><th>CUR</th><th>TIME</th><th>AMPLITUDE</th><th>FREQ</th><th>PHASE</th></tr></thead><tbody>${row('A', a)}${row('B', b)}
          <tr class="d"><td><b>B−A</b></td><td>${fmtSec(dt)}</td><td>${sgn(z.amp[b] - z.amp[a])}${db1(Math.abs(z.amp[b] - z.amp[a]))} dB</td><td colspan="2">${dt ? `1/Δt ${bwText(Math.abs(1 / dt))}` : ''}</td></tr></tbody></table>`;
      } else mkt.innerHTML = `<div class="sp-msub">CURSORS (below) puts two time cursors on the trace.</div>`;
      return;
    }
    // the measurement
    const t = this.measTrace(), f = this.frame;
    this.measText = '';
    let h = '';
    if (s.meas === 'OFF') h = `<div class="sp-mh">MEASURE</div><div class="sp-msub">Pick CH PWR, OBW, ACPR or NOISE below for a measurement here.</div>`;
    else if (!t?.data || !f) h = `<div class="sp-mh">${MEAS_TITLE[s.meas]}</div><div class="sp-msub">Waiting for a trace.</div>`;
    else {
      const y = t.data, rbw = f.rbw;
      h = `<div class="sp-mh">${MEAS_TITLE[s.meas]}<i>T${this.traces.indexOf(t) + 1}</i></div>`;
      if (s.meas === 'CHP') {
        const p = channelPower(y, t.f0, t.binHz, rbw, s.center, s.chBw), d = p - 10 * Math.log10(s.chBw);
        this.measText = `channel power ${db1(p)} ${u} in ${bwText(s.chBw)} · ${db1(d)} ${u}/Hz`;
        h += big('POWER', db1(p), u, 'xl') + `<div class="sp-bigs">${big('DENSITY', db1(d), `${u}/Hz`)}${big('CHANNEL', ...(bwText(s.chBw).split(' ') as [string, string]))}</div>`;
      }
      if (s.meas === 'OBW') {
        const o = occupiedBw(y, t.f0, t.binHz, rbw);
        this.measText = `99 % occupied bandwidth ${bwText(o.bw)} (${fmtHz(o.lo, 4)} to ${fmtHz(o.hi, 4)}) · total ${db1(o.total)} ${u}`;
        h += big('OCCUPIED', ...(bwText(o.bw).split(' ') as [string, string]), 'xl') + `<div class="sp-bigs">${big('TOTAL POWER', db1(o.total), u)}${big('CENTER', ...bigHz((o.lo + o.hi) / 2))}</div>
          <div class="sp-msub">${esc(fmtHz(o.lo, 4))} to ${esc(fmtHz(o.hi, 4))}</div>`;
      }
      if (s.meas === 'ACPR') {
        const a = acpr(y, t.f0, t.binHz, rbw, s.center, s.chBw, s.spacing);
        this.measText = `main ${db1(a.main)} ${u} · lower ${db1(a.lowerDbc)} dBc · upper ${db1(a.upperDbc)} dBc (${bwText(s.chBw)} channels ${bwText(s.spacing)} apart)`;
        h += `<div class="sp-bigs three">${big('LOWER', db1(a.lowerDbc), 'dBc')}${big('MAIN', db1(a.main), u, 'hot')}${big('UPPER', db1(a.upperDbc), 'dBc')}</div>
          <div class="sp-msub">${bwText(s.chBw)} channels, ${bwText(s.spacing)} apart · lower ${db1(a.lower)} ${u} · upper ${db1(a.upper)} ${u}</div>`;
      }
      if (s.meas === 'NOISE') {
        const n = noiseFloor(y, rbw);
        this.measText = `noise floor ${db1(n.floor)} ${u} per ${bwText(rbw)} · ${db1(n.density)} ${u}/Hz`;
        h += big('DENSITY', db1(n.density), `${u}/Hz`, 'xl') + `<div class="sp-bigs">${big('FLOOR', db1(n.floor), u)}${big('PER RBW', ...(bwText(rbw).split(' ') as [string, string]))}</div>`;
        // a dBm floor under thermal noise is the scale being wrong, not a quiet band: say so
        if (s.unit === 'dBm' && n.density < THERMAL_DBM_HZ) h += `<div class="sp-msub warn">Below thermal noise (${THERMAL_DBM_HZ} dBm/Hz): the dBm scale reads ${db1(THERMAL_DBM_HZ - n.density)} dB or more low on this radio here. Raise CAL to correct it.</div>`;
      }
    }
    meas.innerHTML = h;
    // the marker table
    const on = s.markers.map((m, k) => ({ m, k })).filter(x => x.m.on);
    if (!on.length) { mkt.innerHTML = `<div class="sp-msub">Tap the trace to drop a marker, or PEAK below.</div>`; return; }
    const m1 = s.markers[0], ref = this.markerLevel(0);
    mkt.innerHTML = `<table><thead><tr><th>MKR</th><th>TRC</th><th>X</th><th>Y</th><th>NOISE</th></tr></thead><tbody>${on.map(({ m, k }) => {
      const lv = this.markerLevel(k), tr = this.traceFor(m.trace);
      const nd = tr?.data && f ? noiseAt(tr.data, binOf(m.hz, tr.f0, tr.binHz, tr.data.length), f.rbw) : NaN;
      const d = m.delta && k > 0 && m1.on;
      return `<tr class="${k === s.active ? 'on' : ''}" data-row="${k}"><td><b class="sp-dot" style="--c:${k === s.active ? ACTIVE : '#fff'}">${d ? 'Δ' : ''}${k + 1}</b></td><td style="color:${TRACE_COLOR[m.trace]}">T${m.trace + 1}</td>
        <td>${d ? `${sgn(m.hz - m1.hz)}${esc(fmtHz(Math.abs(m.hz - m1.hz), 6))}` : esc(fmtHz(m.hz, 6))}</td>
        <td>${d ? `${sgn(lv - ref)}${db1(Math.abs(lv - ref))} dB` : `${db1(lv)} ${u}`}</td><td>${d ? '' : `${db1(nd)}<small> ${u}/Hz</small>`}</td></tr>`;
    }).join('')}</tbody></table>`;
    mkt.querySelectorAll<HTMLElement>('[data-row]').forEach(r => { r.onclick = () => { s.active = Number(r.dataset.row); this.controls(); this.draw(); }; });
  }

  /** Fold this frame's level at marker k into its running average (power mean of about the last MARKER_AVG frames). */
  private smoothMarker(k: number): void {
    const a = this.mkAvg[k], m = this.s.markers[k];
    const raw = this.rawLevel(k);
    if (!m.on || !Number.isFinite(raw)) { a.n = 0; return; }
    const t = this.traceFor(m.trace);
    if (a.hz !== m.hz || a.trace !== t) { a.hz = m.hz; a.trace = t; a.n = 0; }
    const p = 10 ** (raw / 10);
    a.n = Math.min(a.n + 1, MARKER_AVG);
    a.lin += (p - a.lin) / a.n;
  }

  /** A marker's level as shown: its running average once it has one, else the trace under it. */
  private markerLevel(k: number): number {
    const a = this.mkAvg[k], m = this.s.markers[k];
    if (a.n > 0 && a.hz === m.hz && a.trace === this.traceFor(m.trace)) return 10 * Math.log10(a.lin + 1e-30);
    return this.rawLevel(k);
  }

  /** The trace's value under marker k this frame. */
  private rawLevel(k: number): number {
    const m = this.s.markers[k], t = this.traceFor(m.trace);
    if (!t?.data) return NaN;
    if (m.hz < t.f0 - t.binHz || m.hz > t.f0 + t.data.length * t.binHz) return NaN;
    const i = binOf(m.hz, t.f0, t.binHz, t.data.length);
    return t.data[i];
  }

  // ---- export -------------------------------------------------------------------------------------------------

  private name(ext: string): string {
    const hz = this.s.mode === 'ZERO' ? this.s.zsFreq : this.s.center;
    return `spectrum_${(hz / 1e6).toFixed(3)}MHz_${this.s.mode === 'ZERO' ? 'zerospan_' : ''}${stamp()}.${ext}`;
  }

  /** The trace(s) or the zero-span window as CSV, with the settings in comment lines. */
  csv(): string {
    const s = this.s, u = this.unitLabel(), lines: string[] = ['# Mayhem Mobile · Spectrum'];
    if (s.mode === 'ZERO') {
      const z = this.zcap;
      lines.push(`# zero span ${s.zsFreq} Hz · filter ${s.zsBw} Hz · trigger ${s.trig}${s.trig !== 'FREE' ? ` ${s.level} ${u} pre ${s.pre}` : ''}`, `# ${this.calNote}`);
      lines.push(`time_s,amplitude_${u},frequency_offset_hz,phase_deg`);
      if (z) for (let i = 0; i < z.amp.length; i++) lines.push(`${((i - Math.max(0, z.trig)) / z.rate).toExponential(6)},${z.amp[i].toFixed(2)},${z.fm[i].toFixed(1)},${z.ph[i].toFixed(1)}`);
      return lines.join('\n') + '\n';
    }
    const f = this.frame;
    lines.push(`# center ${s.center} Hz · span ${s.span} Hz · RBW ${f?.rbw.toFixed(1) ?? ''} Hz · VBW ${s.vbwAuto ? 'auto' : s.vbw} · ${s.window} window`, `# ${this.calNote}`);
    if (this.measText) lines.push(`# ${this.measText}`);
    for (const [k, m] of s.markers.entries()) if (m.on) lines.push(`# marker ${k + 1}: ${m.hz.toFixed(1)} Hz ${db1(this.markerLevel(k))} ${u}`);
    const ts = this.traces.map((t, i) => ({ t, i })).filter(x => x.t.data && x.t.mode !== 'OFF');
    lines.push(['frequency_hz', ...ts.map(x => `T${x.i + 1}_${x.t.mode}_${u}`)].join(','));
    const n = ts.length ? Math.max(...ts.map(x => x.t.data!.length)) : 0;
    const t0 = ts[0]?.t;
    for (let k = 0; k < n && t0; k++) lines.push([(t0.f0 + k * t0.binHz).toFixed(1), ...ts.map(x => (x.t.data![k] ?? NaN).toFixed(2))].join(','));
    return lines.join('\n') + '\n';
  }

  private exportCsv(): void { this.download(new Blob([this.csv()], { type: 'text/csv' }), this.name('csv')); }

  /** The plot with its settings and readouts, as a PNG. */
  private exportPng(): void {
    const W = 1600, plotH = 720, head = 64;
    const rows = this.root?.querySelectorAll('#sp-mkt tbody tr').length ?? 0;
    const foot = 34 + 22 * (rows + (this.measText ? 1 : 0));
    const c = document.createElement('canvas'); c.width = W; c.height = head + plotH + foot;
    const ctx = c.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim() || '#e8ecf4', muted = css.getPropertyValue('--muted').trim() || '#8d97ab';
    ctx.fillStyle = css.getPropertyValue('--paper').trim() || '#0a0d13'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = ink; ctx.font = '800 24px ui-monospace, monospace';
    const tl = this.tileList().map(([, l, v, u2]) => `${l} ${v} ${u2}`).join('   ');
    ctx.fillText(tl, 16, 30);
    ctx.font = '13px ui-monospace, monospace'; ctx.fillStyle = muted;
    ctx.fillText(`Mayhem Mobile · Spectrum · ${new Date().toLocaleString('en-US')} · ${this.calNote}`, 16, 52);
    ctx.save(); ctx.translate(0, head);
    this.render(ctx, { l: 60, t: 34, w: W - 60 - 14, h: plotH - 34 - 28, W, H: plotH });
    ctx.restore();
    ctx.font = '15px ui-monospace, monospace'; ctx.fillStyle = ink;
    let y = head + plotH + 24;
    if (this.measText) { ctx.fillText(this.measText, 16, y); y += 22; }
    this.root?.querySelectorAll('#sp-mkt tbody tr').forEach(r => { ctx.fillText([...r.querySelectorAll('td')].map(td => td.textContent?.trim()).join('   '), 16, y); y += 22; });
    c.toBlob(b => { if (b) this.download(b, this.name('png')); }, 'image/png');
  }

  private download(b: Blob, name: string): void {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.host.log(`Spectrum: saved ${name}`);
  }

  /** Keys: the keypad when it is open; otherwise ←/→ next peak left/right, P peak, N next peak, +/- zoom. */
  onKey(e: KeyboardEvent): boolean {
    if (this.pad) {
      if (e.key === 'Escape') { this.pad = null; this.drawPad(); }
      else if (e.key === 'Enter') this.enterPad(this.pad.kind === 'db' || this.pad.kind === 'sec' ? 1 : 1e6);
      else if (e.key === 'Backspace') this.padKey('bs');
      else if (e.key === '-') this.padKey('±');
      else if (/^[0-9.]$/.test(e.key)) this.padKey(e.key);
      else if (/^[gmk]$/i.test(e.key) && this.pad.kind !== 'db') this.enterPad(this.pad.kind === 'sec' ? (e.key.toLowerCase() === 'm' ? 1e-3 : 1) : ({ g: 1e9, m: 1e6, k: 1e3 } as Record<string, number>)[e.key.toLowerCase()]);
      return true;
    }
    if (this.s.mode !== 'FREQ') return false;
    if (e.key === 'ArrowLeft') this.markerTo(this.s.active, 'left');
    else if (e.key === 'ArrowRight') this.markerTo(this.s.active, 'right');
    else if (e.key === 'p' || e.key === 'P') this.markerTo(this.s.active, 'peak');
    else if (e.key === 'n' || e.key === 'N') this.markerTo(this.s.active, 'next');
    else if (e.key === '+' || e.key === '=') { this.setSpan(this.s.center, step125(this.s.span, -1)); return true; }
    else if (e.key === '-') { this.setSpan(this.s.center, step125(this.s.span, 1)); return true; }
    else return false;
    this.controls(); this.save(); this.draw();
    return true;
  }
}
