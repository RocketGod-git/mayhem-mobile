/**
 * The HD Radio app's processor: the existing sideband detector for a fast presence and level reading, the Layer 1
 * receiver (ofdm.ts), the FEC (fec.ts) run in slices so audio keeps flowing, and the station's data (station.ts).
 * Also a finder over the whole span: FM channels whose spectrum shows both digital sidebands.
 */
import type { Emit, IqProcessor } from '../core.js';
import { fft, hann } from '../../fft.js';
import { HdDetector, type HdReport } from '../hdradio.js';
import { HdRx, NSYM, type FrameSoft } from './ofdm.js';
import { P3Decoder } from './p3.js';
import { N_PIDS, N_P1, PIDS_BITS, PM_ROWS, P1_BITS, TbViterbi, depuncture25, descramble, p1Index, pidsIndex, reencodeBer, viterbiTb } from './fec.js';
import { l1ToL2, pduFromFrame } from './l2.js';
import { HdStation } from './station.js';
import { HdAudio } from './audio.js';
import { HD_BAND_HI, HD_BAND_LO } from '../../hdscan.js';

const L1_SAMPLES = 16 * 32 * NSYM, SNAP_MS = 500, SLICE_MS = 10, AUDIO_SLICE_MS = 12, FIND_N = 4096;

export interface HdCandidate { hz: number; scoreDb: number; levelDb: number }

export class HdProcessor implements IqProcessor {
  centerHz = 0; offsetHz = 0;
  /** AUTO's wide look is on: the span is not one to decode (nothing runs until it is back at the HD rate). */
  paused = false;
  /** The selected program's digital audio, mixed into the worker's audio output. */
  readonly audio = new HdAudio();
  private rx = new HdRx();
  private p3: P3Decoder | null = null; private p4: P3Decoder | null = null;
  private station = new HdStation();
  private readonly det: HdDetector;
  private detReport: HdReport | null = null;
  private tunedHz = 0; private rate = 0;
  private queue: FrameSoft[] = [];
  private job: Generator<void, void, void> | null = null;
  private lastSnap = 0;
  private framesDropped = 0; private cpuMs = 0; private cpuWin = 0; private cpuLoad = 0;
  // finder
  private readonly fre = new Float32Array(FIND_N); private readonly fim = new Float32Array(FIND_N); private readonly pow = new Float64Array(FIND_N);
  private pows = 0; private findSince = 0; private findCenter = 0; private cands: HdCandidate[] = [];

  constructor(private readonly emit: Emit) {
    this.det = new HdDetector(r => { this.detReport = r; });
    this.wire();
  }

  private wire(): void {
    this.rx.onFrame = f => { this.queue.push(f); if (this.queue.length > 2) { this.queue.shift(); this.framesDropped++; } };
    this.station.onAudio = (by, pdus) => this.audio.addFrame(by, pdus);
    this.station.onEvent = line => this.emit({ type: 'packet', line: `${new Date().toTimeString().slice(0, 8)} ${(this.tunedHz / 1e6).toFixed(1)} ${line}` });
    this.station.onObject = o => {
      const bytes = o.bytes.slice();
      this.emit({ type: 'hdobj', hz: this.tunedHz, port: o.port, id: o.id, name: o.name, size: o.size, mime: o.mime, kind: o.kind, program: o.program, ms: o.ms, bytes }, [bytes.buffer]);
    };
  }

  reset(rate: number): void {
    this.rate = rate; this.rx.reset(); this.det.reset(); this.detReport = null; this.queue = []; this.job = null;
    this.pow.fill(0); this.pows = 0; this.cands = [];
  }
  /** A new station: everything starts over. */
  clear(): void {
    this.rx = new HdRx(); this.station = new HdStation(); this.p3 = this.p4 = null; this.wire(); this.det.reset(); this.detReport = null; this.queue = []; this.job = null; this.framesDropped = 0;
    this.audio.reset();
  }
  tuned(): void { this.clear(); }

  onIq(iq: Int8Array, rate: number): void {
    if (this.paused) return;
    const t0 = performance.now();
    const n = iq.length >> 1, hz = this.centerHz + this.offsetHz;
    if (hz !== this.tunedHz) { if (this.tunedHz) this.clear(); this.tunedHz = hz; }
    if (this.centerHz !== this.findCenter) { this.findCenter = this.centerHz; this.pow.fill(0); this.pows = 0; this.cands = []; }
    if (Math.abs(this.offsetHz) < rate / 2 - 240_000) {
      this.rx.push(iq, n, rate, this.offsetHz);
      this.det.push(iq, n, rate, this.offsetHz);
    }
    this.find(iq, n, rate);
    const tEnd = performance.now() + SLICE_MS;
    while (performance.now() < tEnd) {
      if (!this.job) { const f = this.queue.shift(); if (!f) break; this.job = this.frameJob(f); }
      if (this.job.next().done) this.job = null;
    }
    const aEnd = performance.now() + AUDIO_SLICE_MS;
    while (this.audio.decodeOne() && performance.now() < aEnd);
    const now = Date.now();
    this.cpuMs += performance.now() - t0;
    if (now - this.lastSnap >= SNAP_MS) {
      const span = now - (this.cpuWin || now - SNAP_MS); this.cpuLoad = span > 0 ? this.cpuMs / span : 0; this.cpuMs = 0; this.cpuWin = now;
      this.lastSnap = now; this.snap();
    }
  }

  private *frameJob(f: FrameSoft): Generator<void, void, void> {
    const idx = p1Index(), soft = new Float32Array(N_P1);
    for (let i = 0; i < N_P1; i++) soft[i] = f.pm[idx[i]];
    const llr = depuncture25(soft, P1_BITS);
    const v = new TbViterbi(); v.start(llr, P1_BITS);
    while (!v.run(6000)) yield;
    const bits = v.bits.slice();
    const ber = reencodeBer(bits, soft);
    yield;
    const sis: Uint8Array[] = [];
    for (let bc = 0; bc < 16; bc++) {
      const pi = pidsIndex(bc), s = new Float32Array(N_PIDS);
      for (let i = 0; i < N_PIDS; i++) s[i] = f.pm[pi[i]];
      sis.push(l1ToL2(descramble(viterbiTb(depuncture25(s, PIDS_BITS), PIDS_BITS, 40))));
    }
    yield;
    const pdu = pduFromFrame(descramble(bits));
    this.station.addFrame(pdu, sis, { ber, snrLoDb: f.snrLoDb, snrHiDb: f.snrHiDb });
    if (!f.px) return;
    const cols = f.px.length / PM_ROWS, ext = cols / 72;
    if (this.p3?.J !== 2 * ext) this.p3 = new P3Decoder(ext);
    if (f.px2) this.p4 ??= new P3Decoder(2); else this.p4 = null;
    const first = Math.round(f.startSample / L1_SAMPLES) * 8;
    for (let bp = 0; bp < 8; bp++) {
      yield;
      for (const r of this.p3.push(f.px.subarray(bp * 64 * cols, (bp + 1) * 64 * cols), first + bp)) this.station.addP3(r.pdu, r.ber);
      if (f.px2 && this.p4) for (const r of this.p4.push(f.px2.subarray(bp * 64 * 144, (bp + 1) * 64 * 144), first + bp)) this.station.addP3(r.pdu, r.ber);
    }
  }

  /** Power spectrum of the whole span; every second, the FM channels that show both digital sidebands. */
  private find(iq: Int8Array, n: number, rate: number): void {
    const w = hann(FIND_N), now = Date.now();
    for (let f = 0; f < 4 && (f + 1) * FIND_N <= n; f++) {
      const o = f * Math.floor(n / 4);
      for (let k = 0; k < FIND_N; k++) { this.fre[k] = iq[2 * (o + k)] * w[k]; this.fim[k] = iq[2 * (o + k) + 1] * w[k]; }
      fft(this.fre, this.fim);
      for (let k = 0; k < FIND_N; k++) this.pow[k] += this.fre[k] * this.fre[k] + this.fim[k] * this.fim[k];
      this.pows++;
    }
    if (this.pows < 24 || now - this.findSince < 1000) return;
    this.findSince = now;
    const binHz = rate / FIND_N, db = (lo: number, hi: number) => {
      let a = Math.round(lo / binHz), b = Math.round(hi / binHz); if (a > b) [a, b] = [b, a];
      let s = 0, c = 0; for (let k = a; k < b; k++) { const i = ((k % FIND_N) + FIND_N) % FIND_N; s += this.pow[i]; c++; }
      return 10 * Math.log10(s / Math.max(1, c) / this.pows + 1e-12);
    };
    const out: HdCandidate[] = [];
    const lo = this.centerHz - rate / 2 + 240_000, hi = this.centerHz + rate / 2 - 240_000;
    for (let ch = Math.ceil((lo - HD_BAND_LO) / 200_000) * 200_000 + HD_BAND_LO; ch <= hi; ch += 200_000) {
      if (ch < HD_BAND_LO || ch > HD_BAND_HI) continue;
      const o = ch - this.centerHz;
      const sbL = db(o - 198_000, o - 130_000), sbH = db(o + 130_000, o + 198_000);
      const outL = db(o - 230_000, o - 206_000), outH = db(o + 206_000, o + 230_000);
      const gapL = db(o - 125_000, o - 112_000), gapH = db(o + 112_000, o + 125_000);
      const analog = db(o - 50_000, o + 50_000);
      const edge = Math.min(sbL - outL, sbH - outH), flat = Math.abs(sbL - sbH);
      if (edge >= 4 && flat < 8 && analog > Math.max(sbL, sbH) && Math.min(sbL - gapL, sbH - gapH) > -6) out.push({ hz: ch, scoreDb: edge, levelDb: Math.max(sbL, sbH) });
    }
    this.cands = out;
    this.pow.fill(0); this.pows = 0;
  }

  private snap(): void {
    const st = this.station.snapshot(), rx = this.rx.status, d = this.detReport;
    this.emit({
      type: 'hdsnap', hz: this.tunedHz, centerHz: this.centerHz, rate: this.rate, rx, station: st, cands: this.cands,
      det: d ? { present: d.present, snrDb: d.snrDb, lock: d.lock, sbLoDb: d.sbLoDb, sbHiDb: d.sbHiDb, refDb: d.refDb, analogDb: d.analogDb, cfoHz: d.cfoHz } : null,
      dropped: this.framesDropped, load: this.cpuLoad, queued: this.queue.length + (this.job ? 1 : 0), audio: this.audio.status(),
    });
  }
}
