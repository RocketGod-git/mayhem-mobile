/**
 * The HAM channel receiver: one narrowband channel anywhere inside the HackRF's span, demodulated properly.
 *
 *   int8 IQ @ 1.92 Msps ─ NCO (channel → DC) ─ FIR/8 → 240 k ─ FIR/5 → 48 k complex baseband
 *     USB / LSB / CW : complex band-pass (phasing method) → real audio
 *     AM             : channel low-pass → envelope → DC block
 *     NFM            : channel low-pass → discriminator → CTCSS/DCS tap → de-emphasis → 3 kHz low-pass, squelch
 *   then AGC (fast/slow/off) → noise reduction → auto-notch → level → 48 kHz audio to the AudioWorklet.
 *
 * The LO stays put while you tune inside the span (a panadapter), so the waterfall does not lurch and the
 * HackRF's DC spike stays away from the channel.
 */
import type { Emit, IqProcessor } from '../core.js';
import { Cic3Decimator, Agc, AutoNotch, ComplexBandpassToReal, ComplexFirDecimator, DcBlock, Mixer, NoiseReducer, RealFir, Resampler, complexBandpassTaps, lowpassTaps } from './filters.js';
import { SubAudioDecoder } from './ctcss.js';
import type { DigitalDecoder } from './digital.js';


export type HamMode = 'USB' | 'LSB' | 'CW' | 'AM' | 'NFM' | 'WFM';
export interface FmTap { onFm(samples: Float32Array, n: number, rate: number): void; readonly minHalf?: number }
export interface IqTap { onIq240(buf: Float32Array, n: number): void }
export type AgcMode = 'off' | 'fast' | 'slow';
export interface HamParams {
  offsetHz: number;     // channel carrier relative to the LO
  mode: HamMode;
  lo: number;           // audio pass band, Hz (SSB: 100..hi; AM/NFM: half bandwidth is hi)
  hi: number;
  pitch: number;        // CW side tone
  agc: AgcMode;
  nr: boolean;
  anf: boolean;
  squelchDb: number;    // NFM: 0 = open
  volume: number;       // linear
}

const AUDIO_RATE = 48_000;

export class HamDemod implements IqProcessor {
  readonly wantsFm = false;
  params: HamParams = { offsetHz: 0, mode: 'USB', lo: 100, hi: 2800, pitch: 600, agc: 'slow', nr: false, anf: false, squelchDb: 0, volume: 1 };
  private rate = 0;
  private mixer = new Mixer(1_920_000, 0);
  private stageA!: ComplexFirDecimator;
  private stageB!: ComplexFirDecimator;
  private interRate = AUDIO_RATE;
  private chan!: ComplexFirDecimator;        // AM / NFM channel low-pass (decim 1)
  private ssb!: ComplexBandpassToReal;
  private audioLp!: RealFir;
  private resampler: Resampler | null = null;
  private readonly agc = new Agc(AUDIO_RATE);
  private readonly nr = new NoiseReducer();
  private readonly anf = new AutoNotch();
  private readonly dcAudio = new DcBlock(0.995);
  private readonly sub = new SubAudioDecoder(AUDIO_RATE);
  private tmp = new Float32Array(0);
  private bufPre = new Float32Array(0);
  /** The channel sits outside the sampled span (the view was slid away from it): nothing to demodulate. */
  private offRange = false;
  /** Above 3.84 Msps: integer CIC bringing the mixed stream down to 1.92 M before the FIR stages. */
  private pre: Cic3Decimator | null = null;
  private bufA = new Float32Array(0);
  private buf48 = new Float32Array(0);
  private bufC = new Float32Array(0);
  private audio = new Float32Array(0);
  private audio2 = new Float32Array(0);
  private outChunk = new Float32Array(2048); private outLen = 0;
  private prevI = 0; private prevQ = 0; private deemph = 0;
  /** WFM (broadcast) demodulates at the wide intermediate stage — the 240 kHz+ complex baseband after the first
   *  decimator (`bufA`) — since ±75 kHz deviation cannot survive the 48 kHz channel the narrow modes use. The
   *  discriminator runs there and a boxcar brings it to the audio rate (its null lands on that rate), with the
   *  US broadcast 75 µs de-emphasis applied at the audio rate. */
  private wfmDecim = 1; private wfmDeCoef = 0.25;
  private wfmAcc = 0; private wfmCnt = 0; private wfmDeemph = 0;
  private audioPeak = 0;
  private chPow = 0; private chN = 0; private floorDb = NaN; private sqOpen = true; private lastMeter = 0; private lastDb = -200;
  /** Something is on the channel (6 dB over the tracked floor), regardless of the squelch setting. */
  get carrier(): boolean { return this.lastDb > this.floorDb + 6; }
  /** CTCSS tone being received (0 = none) — a sure sign of an analog voice channel. */
  get tone(): number { return this.sub.tone; }
  private filterKey = '';

  /** Digital decoders fed with the demodulated audio (after AGC, before NR/notch/volume). */
  digital: DigitalDecoder[] = [];
  /** Consumers of the raw NFM discriminator (before de-emphasis): DMR, APT, packet. Each may ask for a wider channel. */
  private fmTaps: FmTap[] = [];
  /** Consumers of the 240 kHz complex baseband after the mixer and first decimator (wideband digital: LRPT). */
  iqTaps: IqTap[] = [];
  private minHalf = 0;
  /** Mute the analog audio (a digital voice decoder is supplying the audio instead). */
  analogMute = false;
  setFmTaps(taps: FmTap[]): void {
    this.fmTaps = taps;
    const half = taps.reduce((m, t) => Math.max(m, t.minHalf ?? 0), 0);
    if (half !== this.minHalf) { this.minHalf = half; this.filterKey = ''; this.rebuildFilters(); }
  }
  constructor(private readonly emit: Emit, private readonly sink: (chunk: Float32Array) => void) {}

  set(p: Partial<HamParams>): void {
    Object.assign(this.params, p);
    this.offRange = this.rate > 0 && Math.abs(this.params.offsetHz) > this.rate / 2 - 40_000;
    this.mixer.setFreq(this.params.offsetHz - (this.params.mode === 'CW' ? this.params.pitch : 0));
    this.rebuildFilters();
    if (p.agc) this.agc.setSpeed(p.agc === 'fast' ? 120 : 600, p.agc === 'fast' ? 60 : 300);
  }

  reset(rate: number): void {
    this.rate = rate;
    this.offRange = Math.abs(this.params.offsetHz) > rate / 2 - 40_000;
    this.mixer.setRate(rate);
    // wide spans (7.68 / 15.36 / 19.2 Msps) first come down to 1.92 M through a cheap third-order CIC
    const preD = rate > 3_840_000 ? Math.max(2, Math.round(rate / 1_920_000)) : 1;
    this.pre = preD > 1 ? new Cic3Decimator(preD) : null;
    const base = rate / preD;
    // base → 48 k in two stages: /8 then /(rest); 1.92 M → 240 k → 48 k exactly, 2 M → 250 k → 50 k + resample
    const a = 8, b = Math.max(1, Math.round(base / a / AUDIO_RATE));
    this.stageA = new ComplexFirDecimator(lowpassTaps(0.45 / a, 63), a);
    this.stageB = new ComplexFirDecimator(lowpassTaps(0.42 / b, 63), b);
    this.interRate = base / a / b;
    this.wfmDecim = b;                                   // the wide stage (base / a) box-averages by b down to interRate
    this.wfmDeCoef = 1 - Math.exp(-1 / (this.interRate * 75e-6));
    this.resampler = Math.abs(this.interRate - AUDIO_RATE) > 1 ? new Resampler(AUDIO_RATE / this.interRate) : null;
    this.filterKey = ''; this.rebuildFilters();
    this.audioLp = new RealFir(lowpassTaps(3000 / this.interRate, 63));
    this.agc.setSpeed(this.params.agc === 'fast' ? 120 : 600, this.params.agc === 'fast' ? 60 : 300);
    this.nr.reset(); this.anf.reset(); this.sub.reset(this.interRate);
    this.prevI = this.prevQ = this.deemph = 0; this.wfmAcc = this.wfmCnt = this.wfmDeemph = 0; this.chPow = 0; this.chN = 0; this.floorDb = NaN; this.outLen = 0;
    this.emit({ type: 'log', line: `HAM: ${(rate / 1e6).toFixed(2)} Msps${this.pre ? ` → CIC/${preD}` : ''} → ${this.interRate} Hz baseband${this.resampler ? ' (resampled to 48 k)' : ''}` });
  }

  private rebuildFilters(): void {
    const p = this.params, r = this.interRate;
    const key = `${p.mode}|${p.lo}|${p.hi}|${p.pitch}|${r}|${this.minHalf}`;
    if (key === this.filterKey) return;
    this.filterKey = key;
    // WFM never touches the 48 kHz channel filters: its 100 kHz half-width would be past that rate's Nyquist and
    // it is demodulated on the wide stage instead. Leave the narrow filters as they were for the next mode.
    if (p.mode === 'WFM') return;
    const taps = 255;
    if (p.mode === 'USB') this.ssb = new ComplexBandpassToReal(complexBandpassTaps(p.lo, p.hi, r, taps));
    else if (p.mode === 'LSB') this.ssb = new ComplexBandpassToReal(complexBandpassTaps(-p.hi, -p.lo, r, taps));
    else if (p.mode === 'CW') { const w = Math.max(50, p.hi - p.lo); this.ssb = new ComplexBandpassToReal(complexBandpassTaps(p.pitch - w / 2, p.pitch + w / 2, r, taps)); }
    const half = p.mode === 'NFM' ? Math.max(4000, p.hi, this.minHalf) : Math.max(2000, p.hi);
    this.chan = new ComplexFirDecimator(lowpassTaps(half / r, 127), 1);
  }

  /**
   * Broadcast FM on the wide stage. `buf` is the complex baseband after the first decimator (240 kHz at the
   * 1.92 Msps HAM rate, wider at the higher ones — always enough for ±75 kHz deviation), `n` its sample count.
   * Discriminate every sample, box-average `wfmDecim` of them down to the audio rate (the boxcar's first null
   * sits exactly on that rate, so it is also the anti-alias), then 75 µs de-emphasis. Returns the audio sample
   * count written to `out`, at `interRate`, ready for the common AGC / NR / volume / resample tail.
   */
  private demodWfm(buf: Float32Array, n: number, out: Float32Array): number {
    const decim = this.wfmDecim, k = this.wfmDeCoef;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const ci = buf[2 * i], cq = buf[2 * i + 1];
      const d = Math.atan2(cq * this.prevI - ci * this.prevQ, ci * this.prevI + cq * this.prevQ);
      this.prevI = ci; this.prevQ = cq;
      this.chPow += ci * ci + cq * cq; this.chN++;
      this.wfmAcc += d;
      if (++this.wfmCnt >= decim) {
        const v = this.wfmAcc / this.wfmCnt; this.wfmAcc = 0; this.wfmCnt = 0;
        this.wfmDeemph += k * (v - this.wfmDeemph);
        // Full broadcast deviation is ~2 rad per sample at 240 k; program material after de-emphasis sits well
        // under that, so this lands speech and music around half scale with headroom for the AGC or volume.
        out[m++] = this.wfmDeemph * 1.6;
      }
    }
    return m;
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    if (this.offRange) return;
    const n = iq.length >> 1;
    if (this.tmp.length < 2 * n) { this.tmp = new Float32Array(2 * n); this.bufPre = new Float32Array(2 * Math.ceil(n / 2) + 8); this.bufA = new Float32Array(2 * Math.ceil(n / 8) + 8); this.buf48 = new Float32Array(this.bufA.length); this.bufC = new Float32Array(this.bufA.length); this.audio = new Float32Array(this.bufA.length); this.audio2 = new Float32Array(this.bufA.length); }
    this.mixer.process(iq, n, this.tmp);
    let src = this.tmp, nPre = n;
    if (this.pre) { nPre = this.pre.process(this.tmp, n, this.bufPre); src = this.bufPre; }
    const nA = this.stageA.process(src, nPre, this.bufA);
    for (const t of this.iqTaps) t.onIq240(this.bufA, nA);
    const p = this.params, out = this.audio;
    let m: number;
    if (p.mode === 'WFM') {
      // Broadcast FM: discriminate on the wide stage before the second decimator (see the field note).
      m = this.demodWfm(this.bufA, nA, out);
      if (m === 0) return;
    } else {
    const nB = this.stageB.process(this.bufA, nA, this.buf48);
    if (nB === 0) return;
    const x = this.buf48;
    m = nB;
    if (p.mode === 'USB' || p.mode === 'LSB' || p.mode === 'CW') {
      this.ssb.process(x, nB, out);
      let pw = 0; for (let i = 0; i < nB; i++) pw += out[i] * out[i];
      this.chPow += pw; this.chN += nB;
    } else {
      this.chan.process(x, nB, this.bufC);
      const c = this.bufC;
      let pw = 0; for (let i = 0; i < nB; i++) pw += c[2 * i] * c[2 * i] + c[2 * i + 1] * c[2 * i + 1];
      this.chPow += pw; this.chN += nB;
      if (p.mode === 'AM') {
        for (let i = 0; i < nB; i++) out[i] = Math.sqrt(c[2 * i] * c[2 * i] + c[2 * i + 1] * c[2 * i + 1]);
        this.dcAudio.process(out, nB);
      } else { // NFM
        for (let i = 0; i < nB; i++) {
          const ci = c[2 * i], cq = c[2 * i + 1];
          out[i] = Math.atan2(cq * this.prevI - ci * this.prevQ, ci * this.prevI + cq * this.prevQ);
          this.prevI = ci; this.prevQ = cq;
        }
        this.sub.push(out, nB);
        for (const tap of this.fmTaps) tap.onFm(out, nB, this.interRate);
        const a = 1 - Math.exp(-1 / (this.interRate * 530e-6));
        for (let i = 0; i < nB; i++) { this.deemph += a * (out[i] - this.deemph); out[i] = this.deemph * 0.6; }
        this.audioLp.process(out, nB, this.audio2); out.set(this.audio2.subarray(0, nB));
      }
    }
    }
    // metering + squelch on the channel power
    const now = performance.now();
    if (now - this.lastMeter > 100 && this.chN > 0) {
      this.lastMeter = now;
      const db = 10 * Math.log10(this.chPow / this.chN / (127 * 127) + 1e-12);
      this.chPow = 0; this.chN = 0; this.lastDb = db;
      this.floorDb = Number.isNaN(this.floorDb) ? db : db < this.floorDb ? this.floorDb + 0.2 * (db - this.floorDb) : this.floorDb + 0.003 * (db - this.floorDb);
      const open = p.squelchDb === 0 || p.mode !== 'NFM' || db > this.floorDb + p.squelchDb;
      this.sqOpen = open;
      this.emit({ type: 'ham', db, floor: this.floorDb, open, tone: this.sub.tone, toneDb: this.sub.toneDb, dcs: this.sub.dcs, dcsInv: this.sub.dcsInverted, gain: this.agc.gain, audioPeak: this.audioPeak }); this.audioPeak = 0;
    }
    if (p.mode !== 'NFM') { this.dcAudio.process(out, m); }
    if (p.agc !== 'off') this.agc.process(out, m); else for (let i = 0; i < m; i++) out[i] *= p.mode === 'NFM' || p.mode === 'WFM' ? 1 : 1 / 64;
    for (const d of this.digital) d.push(out, m);
    if (p.nr) this.nr.process(out, m);
    if (p.anf) this.anf.process(out, m);
    const g = (this.sqOpen && !this.analogMute ? 1 : 0) * p.volume;
    for (let i = 0; i < m; i++) { const v = out[i] * g; const c = v > 1 ? 1 : v < -1 ? -1 : v; out[i] = c; const a = c < 0 ? -c : c; if (a > this.audioPeak) this.audioPeak = a; }
    // A digital mode owns the audio: its vocoder writes to the player itself. The analog chain has to go
    // silent by not writing at all, rather than by writing silence. Two streams into one buffer fills it at
    // twice real time, so speech arrives interleaved with equal amounts of nothing and the buffer's overflow
    // rule then throws away whole chunks. Heard as heavy chopping behind a perfectly clean decode.
    if (this.analogMute) { this.outLen = 0; return; }
    if (this.resampler) { m = this.resampler.process(out, m, this.audio2); out.set(this.audio2.subarray(0, m)); }
    for (let i = 0; i < m; i++) { this.outChunk[this.outLen++] = out[i]; if (this.outLen >= this.outChunk.length) { this.sink(this.outChunk.slice()); this.outLen = 0; } }
  }
}
