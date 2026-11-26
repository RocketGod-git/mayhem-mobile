/** HDC spectral band replication: 22.05 kHz AAC core -> 44.1 kHz, plus DRM-style parametric stereo for mono streams. */
import { Bits } from './bits.js';
import { SBR_HUFF, NOISE_TABLE } from './sbr-tables.js';
import { buildHuff, huffDecode, type HuffTree } from './sbr-huff.js';
import { buildTables, limiterTable, type SbrHeader, type SbrTables } from './sbr-fbt.js';
import { QmfAnalysis, QmfSynthesis } from './sbr-qmf.js';
import { DrmPs } from './ps.js';

export interface HdcSbrPayload { buf: Uint8Array; bitPos: number; bitEnd: number }

const H = Object.fromEntries(Object.entries(SBR_HUFF).map(([k, v]) => [k, buildHuff(v)])) as Record<string, HuffTree>;

const FIXFIX = 0, FIXVAR = 1, VARFIX = 2, VARVAR = 3;
const SLOTS = 32, HFGEN = 8, HFADJ = 2, ROWS = SLOTS + HFGEN;
const LIM_GAIN = [0.70795, 1.0, 1.41254, 1e10];
const H_SMOOTH = [0.33333333333333, 0.30150283239582, 0.21816949906249, 0.11516383427084, 0.03183050093751];
const DEFAULT_HEADER: SbrHeader = { ampRes: 1, startFreq: 5, stopFreq: 0, xoverBand: 0, freqScale: 2, alterScale: 1, noiseBands: 2, limiterBands: 2, limiterGains: 2, interpolFreq: 1, smoothingMode: 1 };

interface ChFrame {
  frameClass: number; le: number; lq: number; tE: number[]; tQ: number[]; f: number[]; pointer: number; lA: number;
  dfEnv: number[]; dfNoise: number[]; invf: number[]; ampRes: number;
  E: number[][]; Q: number[][]; harmFlag: number; harm: number[];
  eOrig: number[][]; qOrig: number[][];
}

class ChState {
  qa = new QmfAnalysis();
  qs = new QmfSynthesis();
  xr = new Float64Array(ROWS * 64);
  xi = new Float64Array(ROWS * 64);
  ePrev = new Int32Array(64);
  qPrev = new Int32Array(5);
  fPrev = 0;
  prevLaLast = false;
  sIdxPrev = new Uint8Array(64);
  invfPrev = new Int32Array(5);
  bwPrev = new Float64Array(5);
  gHist: Float64Array[] = [0, 1, 2, 3, 4].map(() => new Float64Array(64));
  qHist: Float64Array[] = [0, 1, 2, 3, 4].map(() => new Float64Array(64));
  histValid = false;
  noiseIdx = 0;
  sineIdx = 0;
  endPrev = 16;
  aPrev = 1;
}

export class HdcSbr {
  private hdr: SbrHeader = { ...DEFAULT_HEADER };
  private headerSeen = false;
  private tab: SbrTables | null = null;
  private reset = true;
  private ch: ChState[] = [];
  private nch = 0;
  private kxPrev = 0;
  private mPrev = 0;
  private ps = new DrmPs();
  private psUsed = false;
  private psSynth = new QmfSynthesis();
  private alpha0r = new Float64Array(64); private alpha0i = new Float64Array(64);
  private alpha1r = new Float64Array(64); private alpha1i = new Float64Array(64);
  private xR = new Float64Array(SLOTS * 64); private xI = new Float64Array(SLOTS * 64);
  private rR = new Float64Array(SLOTS * 64); private rI = new Float64Array(SLOTS * 64);
  /** The last parsed frame per channel, replayed for a lost one. */
  private good: ChFrame[] | null = null;
  /** Bit position where the last SBR parse stopped (for bench checks). */
  lastEnd = -1;
  /** Why the last frame was not SBR-processed, '' when it was. */
  lastSkip = '';

  /** scale: core PCM full scale mapped to the 16-bit range the SBR envelopes are coded for. */
  constructor(private readonly scale = 32768) {}

  /** conceal: for a lost frame, the core's energy against its last good one; above 0 the last envelopes play on. */
  process(pcm: Float32Array[], stereo: boolean, sbr: HdcSbrPayload | null, conceal = 0): Float32Array[] {
    const nch = stereo && pcm.length > 1 ? 2 : 1;
    if (nch !== this.nch) {
      this.nch = nch;
      this.ch = Array.from({ length: nch }, () => new ChState());
      this.headerSeen = false; this.tab = null; this.reset = true; this.kxPrev = 0; this.mPrev = 0;
      this.ps = new DrmPs(); this.psUsed = false; this.psSynth = new QmfSynthesis(); this.good = null;
    }
    let frames: ChFrame[] | null = null;
    this.lastEnd = -1; this.lastSkip = '';
    let parsedOk = false;
    if (sbr) {
      try { frames = this.parse(sbr, nch); parsedOk = frames !== null; } catch { frames = null; this.lastSkip = 'overrun'; }
    } else if (conceal > 0 && this.good && this.tab) { frames = this.concealed(this.good, conceal); this.lastSkip = 'concealed'; }
    else this.lastSkip = 'no payload';
    if (parsedOk) this.good = frames;
    const t = this.tab;
    const run = frames !== null && t !== null;
    const out: Float32Array[] = [];
    for (let c = 0; c < nch; c++) {
      const s = this.ch[c];
      this.analyze(s, pcm[c], run ? t!.kx : 32);
      if (run) {
        this.hfGenerate(s, frames![c], t!);
        this.hfAdjust(s, frames![c], t!);
      }
      this.buildX(s, run ? frames![c] : null, t, this.xR, this.xI);
      if (c === 0 && nch === 1 && this.psUsed) {
        this.ps.apply(this.xR, this.xI, this.rR, this.rI, SLOTS, !parsedOk);
      }
      const o = new Float32Array(2048);
      for (let l = 0; l < SLOTS; l++) s.qs.slot(this.xR, this.xI, l * 64, o, l * 64, 1 / this.scale);
      out.push(o);
      if (c === 0 && nch === 1 && this.psUsed) {
        const r = new Float32Array(2048);
        for (let l = 0; l < SLOTS; l++) this.psSynth.slot(this.rR, this.rI, l * 64, r, l * 64, 1 / this.scale);
        out.push(r);
      }
    }
    if (run) {
      for (let c = 0; c < nch; c++) this.savePrev(this.ch[c], frames![c], t!);
      this.kxPrev = t!.kx; this.mPrev = t!.m; this.reset = false;
    }
    for (const s of this.ch) {
      s.xr.copyWithin(0, SLOTS * 64, ROWS * 64); s.xr.fill(0, HFGEN * 64);
      s.xi.copyWithin(0, SLOTS * 64, ROWS * 64); s.xi.fill(0, HFGEN * 64);
    }
    return out;
  }

  // ---- bitstream ----

  private parse(p: HdcSbrPayload, nch: number): ChFrame[] | null {
    const b = new Bits(p.buf, p.bitEnd);
    b.pos = p.bitPos;
    if (b.bit()) {
      const h: SbrHeader = { ...DEFAULT_HEADER };
      h.ampRes = b.bit(); h.startFreq = b.read(4); h.stopFreq = b.read(4); h.xoverBand = b.read(3); b.skip(2);
      const x1 = b.bit(), x2 = b.bit();
      if (x1) { h.freqScale = b.read(2); h.alterScale = b.bit(); h.noiseBands = b.read(2); }
      if (x2) { h.limiterBands = b.read(2); h.limiterGains = b.read(2); h.interpolFreq = b.bit(); h.smoothingMode = b.bit(); }
      const o = this.hdr;
      const changed = !this.headerSeen || o.startFreq !== h.startFreq || o.stopFreq !== h.stopFreq || o.freqScale !== h.freqScale ||
        o.alterScale !== h.alterScale || o.xoverBand !== h.xoverBand || o.noiseBands !== h.noiseBands;
      if (changed) {
        const nt = buildTables(h);
        if (!nt) { this.lastSkip = 'bad header'; return null; }
        this.tab = nt; this.reset = true; this.good = null;
        for (const s of this.ch) { s.noiseIdx = 0; }
      } else if (o.limiterBands !== h.limiterBands && this.tab) this.tab.lim = limiterTable(this.tab, h.limiterBands);
      this.hdr = h; this.headerSeen = true;
    }
    if (!this.headerSeen || !this.tab) { this.lastSkip = 'no header yet'; return null; }
    const t = this.tab;
    const fr: ChFrame[] = [];
    if (nch === 1) {
      if (b.bit()) b.skip(4);
      b.skip(1);
      const f = this.grid(b);
      if (!f) return null;
      this.dtdf(b, f); this.invf(b, f, t);
      this.envelope(b, f, this.ch[0], t, false); this.noise(b, f, this.ch[0], t, false);
      this.harmonics(b, f, t);
      fr.push(f);
      this.dequant(f, null, t);
    } else {
      if (b.bit()) b.skip(8);
      const coupling = b.bit();
      if (coupling) {
        const f0 = this.grid(b);
        if (!f0) return null;
        const f1: ChFrame = { ...f0, tE: [...f0.tE], tQ: [...f0.tQ], f: [...f0.f] };
        this.dtdf(b, f0); this.dtdf(b, f1);
        this.invf(b, f0, t); f1.invf = [...f0.invf];
        this.envelope(b, f0, this.ch[0], t, false); this.noise(b, f0, this.ch[0], t, false);
        this.envelope(b, f1, this.ch[1], t, true); this.noise(b, f1, this.ch[1], t, true);
        this.harmonics(b, f0, t); this.harmonics(b, f1, t);
        fr.push(f0, f1);
        this.dequant(f0, f1, t);
      } else {
        const f0 = this.grid(b), f1 = this.grid(b);
        if (!f0 || !f1) return null;
        this.dtdf(b, f0); this.dtdf(b, f1);
        this.invf(b, f0, t); this.invf(b, f1, t);
        this.envelope(b, f0, this.ch[0], t, false); this.envelope(b, f1, this.ch[1], t, false);
        this.noise(b, f0, this.ch[0], t, false); this.noise(b, f1, this.ch[1], t, false);
        this.harmonics(b, f0, t); this.harmonics(b, f1, t);
        fr.push(f0, f1);
        this.dequant(f0, null, t); this.dequant(f1, null, t);
      }
    }
    if (b.bit()) {
      let cnt = b.read(4);
      if (cnt === 15) cnt += b.read(8);
      let left = 8 * cnt, psSeen = false;
      while (left > 7) {
        const id = b.read(2); left -= 2;
        if (id === 0 && nch === 1 && !psSeen) {
          psSeen = true;
          const p0 = b.pos;
          this.ps.read(b);
          if (!this.psUsed) this.psSynth.copyFrom(this.ch[0].qs);
          this.psUsed = true;
          left -= b.pos - p0;
          if (left < 0) throw new RangeError('PS overran extension');
        } else { b.skip(left); left = 0; }
      }
      b.skip(left);
    }
    this.lastEnd = b.pos;
    return fr;
  }

  private grid(b: Bits): ChFrame | null {
    const cls = b.read(2);
    let le = 0, pointer = 0;
    const tE: number[] = [], f: number[] = [];
    if (cls === FIXFIX) {
      le = Math.min(1 << b.read(2), 4);
      const r = b.bit();
      for (let i = 0; i < le; i++) f.push(r);
      for (let i = 0; i <= le; i++) tE.push(Math.round(16 * i / le));
    } else if (cls === FIXVAR || cls === VARFIX) {
      const abs = b.read(2), nrel = b.read(2);
      le = nrel + 1;
      const rel: number[] = [];
      for (let i = 0; i < nrel; i++) rel.push(2 * b.read(2) + 2);
      pointer = b.read(ceilLog2(le + 1));
      for (let i = 0; i < le; i++) f.push(b.bit());
      if (cls === FIXVAR) {
        f.reverse();
        tE.length = le + 1; tE[0] = 0; tE[le] = abs + 16;
        for (let i = 0; i < nrel; i++) tE[le - 1 - i] = tE[le - i] - rel[i];
      } else {
        tE.push(abs);
        for (let i = 0; i < nrel; i++) tE.push(tE[i] + rel[i]);
        tE.push(16);
      }
    } else {
      const lead = b.read(2), trail = b.read(2) + 16, n0 = b.read(2), n1 = b.read(2);
      le = n0 + n1 + 1;
      const r0: number[] = [], r1: number[] = [];
      for (let i = 0; i < n0; i++) r0.push(2 * b.read(2) + 2);
      for (let i = 0; i < n1; i++) r1.push(2 * b.read(2) + 2);
      pointer = b.read(ceilLog2(le + 1));
      for (let i = 0; i < le; i++) f.push(b.bit());
      if (le > 5) return this.fail('grid: too many envelopes');
      tE.length = le + 1; tE[0] = lead; tE[le] = trail;
      for (let i = 0; i < n0; i++) tE[i + 1] = tE[i] + r0[i];
      for (let i = 0; i < n1; i++) tE[le - 1 - i] = tE[le - i] - r1[i];
    }
    if (pointer > le + 1) return this.fail('grid: pointer');
    for (let i = 1; i <= le; i++) if (!(tE[i] > tE[i - 1])) return this.fail('grid: borders');
    const lq = le > 1 ? 2 : 1;
    const tQ = [tE[0]];
    if (lq === 2) {
      let idx: number;
      if (cls === FIXFIX) idx = le >> 1;
      else if (cls === VARFIX) idx = pointer === 0 ? 1 : pointer === 1 ? le - 1 : pointer - 1;
      else idx = pointer > 1 ? le + 1 - pointer : le - 1;
      if (idx <= 0 || idx >= le) return this.fail('grid: noise border');
      tQ.push(tE[idx]);
    }
    tQ.push(tE[le]);
    let lA = -1;
    if ((cls === FIXVAR || cls === VARVAR) && pointer > 0) lA = le + 1 - pointer;
    else if (cls === VARFIX && pointer > 1) lA = pointer - 1;
    const ampRes = cls === FIXFIX && le === 1 ? 0 : this.hdr.ampRes;
    return { frameClass: cls, le, lq, tE, tQ, f, pointer, lA, dfEnv: [], dfNoise: [], invf: [], ampRes, E: [], Q: [], harmFlag: 0, harm: [], eOrig: [], qOrig: [] };
  }

  private fail(why: string): null { this.lastSkip = why; return null; }

  // One envelope over the whole lost frame from each channel's last one, energy scaled by e.
  private concealed(good: ChFrame[], e: number): ChFrame[] {
    return good.map((p, c) => {
      const lE = p.le - 1, lQ = p.lq - 1, t0 = Math.max(0, this.ch[c].endPrev - 16);
      return {
        frameClass: FIXFIX, le: 1, lq: 1, tE: [t0, 16], tQ: [t0, 16], f: [p.f[lE]], pointer: 0, lA: -1,
        dfEnv: [0], dfNoise: [0], invf: p.invf, ampRes: p.ampRes, E: [p.E[lE]], Q: [p.Q[lQ]], harmFlag: p.harmFlag, harm: p.harm,
        eOrig: [p.eOrig[lE].map(v => v * e)], qOrig: [p.qOrig[lQ]],
      };
    });
  }

  private dtdf(b: Bits, f: ChFrame): void {
    f.dfEnv = []; f.dfNoise = [];
    for (let i = 0; i < f.le; i++) f.dfEnv.push(b.bit());
    for (let i = 0; i < f.lq; i++) f.dfNoise.push(b.bit());
  }

  private invf(b: Bits, f: ChFrame, t: SbrTables): void {
    f.invf = [];
    for (let i = 0; i < t.nQ; i++) f.invf.push(b.read(2));
  }

  private envelope(b: Bits, f: ChFrame, s: ChState, t: SbrTables, bal: boolean): void {
    const delta = bal ? 2 : 1, n = [t.nLow, t.nHigh], odd = t.nHigh & 1;
    const th = bal ? (f.ampRes ? H.tEnvBal30 : H.tEnvBal15) : (f.ampRes ? H.tEnv30 : H.tEnv15);
    const fh = bal ? (f.ampRes ? H.fEnvBal30 : H.fEnvBal15) : (f.ampRes ? H.fEnv30 : H.fEnv15);
    const bits = (bal ? 5 : 6) + (f.ampRes ? 0 : 1);
    let prev: ArrayLike<number> = s.ePrev, gPrev = s.fPrev;
    // the reference frame was coded in the other amplitude resolution (after a loss)
    if (s.aPrev !== f.ampRes) prev = Array.from(s.ePrev, v => f.ampRes ? v >> 1 : 2 * v);
    f.E = [];
    for (let l = 0; l < f.le; l++) {
      const res = f.f[l], e: number[] = [];
      if (!f.dfEnv[l]) {
        e.push(delta * b.read(bits));
        for (let k = 1; k < n[res]; k++) e.push(e[k - 1] + delta * huffDecode(b, fh));
      } else {
        for (let k = 0; k < n[res]; k++) {
          const i = res === gPrev ? k : res ? (k + odd) >> 1 : (k ? 2 * k - odd : 0);
          e.push(prev[i] + delta * huffDecode(b, th));
        }
      }
      for (let k = 0; k < e.length; k++) e[k] = Math.max(0, Math.min(127, e[k]));
      f.E.push(e); prev = e; gPrev = res;
    }
  }

  private noise(b: Bits, f: ChFrame, s: ChState, t: SbrTables, bal: boolean): void {
    const delta = bal ? 2 : 1;
    const th = bal ? H.tNoiseBal30 : H.tNoise30, fh = bal ? H.fEnvBal30 : H.fEnv30;
    let prev: ArrayLike<number> = s.qPrev;
    f.Q = [];
    for (let l = 0; l < f.lq; l++) {
      const q: number[] = [];
      if (!f.dfNoise[l]) {
        q.push(delta * b.read(5));
        for (let k = 1; k < t.nQ; k++) q.push(q[k - 1] + delta * huffDecode(b, fh));
      } else for (let k = 0; k < t.nQ; k++) q.push(prev[k] + delta * huffDecode(b, th));
      for (let k = 0; k < q.length; k++) q[k] = Math.max(0, Math.min(30, q[k]));
      f.Q.push(q); prev = q;
    }
  }

  private harmonics(b: Bits, f: ChFrame, t: SbrTables): void {
    f.harmFlag = b.bit(); f.harm = [];
    if (f.harmFlag) for (let i = 0; i < t.nHigh; i++) f.harm.push(b.bit());
  }

  private dequant(f0: ChFrame, f1: ChFrame | null, t: SbrTables): void {
    this.dequantRaw(f0, f1, t);
    // 16-bit audio never needs subband energies near 2^50; larger means corrupt bits
    for (const f of f1 ? [f0, f1] : [f0]) for (const e of f.eOrig) for (const v of e) if (!(v < 2 ** 50)) throw new RangeError('envelope out of range');
  }

  private dequantRaw(f0: ChFrame, f1: ChFrame | null, t: SbrTables): void {
    const n = [t.nLow, t.nHigh];
    if (!f1) {
      const a = f0.ampRes ? 1 : 2;
      f0.eOrig = f0.E.map(e => e.map(v => Math.pow(2, v / a + 6)));
      f0.qOrig = f0.Q.map(q => q.map(v => Math.pow(2, 6 - v)));
      return;
    }
    const a = f0.ampRes ? 1 : 2, pan = f0.ampRes ? 12 : 24;
    f0.eOrig = []; f1.eOrig = [];
    for (let l = 0; l < f0.le; l++) {
      const e0: number[] = [], e1: number[] = [];
      for (let k = 0; k < n[f0.f[l]]; k++) {
        const t1 = Math.pow(2, f0.E[l][k] / a + 7), t2 = Math.pow(2, (pan - f1.E[l][k]) / a), fac = t1 / (1 + t2);
        e0.push(fac); e1.push(fac * t2);
      }
      f0.eOrig.push(e0); f1.eOrig.push(e1);
    }
    f0.qOrig = []; f1.qOrig = [];
    for (let l = 0; l < f0.lq; l++) {
      const q0: number[] = [], q1: number[] = [];
      for (let k = 0; k < t.nQ; k++) {
        const t1 = Math.pow(2, 6 - f0.Q[l][k] + 1), t2 = Math.pow(2, 12 - f1.Q[l][k]), fac = t1 / (1 + t2);
        q0.push(fac); q1.push(fac * t2);
      }
      f0.qOrig.push(q0); f1.qOrig.push(q1);
    }
  }

  // ---- signal path ----

  private analyze(s: ChState, pcm: Float32Array, kx: number): void {
    for (let l = 0; l < SLOTS; l++) {
      const o = (l + HFGEN) * 64;
      s.qa.slot(pcm, l * 32, this.scale, s.xr, s.xi, o);
      for (let k = kx; k < 32; k++) { s.xr[o + k] = 0; s.xi[o + k] = 0; }
    }
  }

  private hfGenerate(s: ChState, f: ChFrame, t: SbrTables): void {
    const xr = s.xr, xi = s.xi;
    for (let k = 0; k < t.k0; k++) this.lpc(xr, xi, k);
    const bw = new Float64Array(5);
    for (let i = 0; i < t.nQ; i++) {
      const cur = f.invf[i], prv = s.invfPrev[i];
      let nb = cur + prv === 1 ? 0.6 : [0, 0.75, 0.9, 0.98][cur];
      nb = nb < s.bwPrev[i] ? 0.75 * nb + 0.25 * s.bwPrev[i] : 0.90625 * nb + 0.09375 * s.bwPrev[i];
      bw[i] = nb < 0.015625 ? 0 : nb;
    }
    const l0 = 2 * f.tE[0], l1 = 2 * f.tE[f.le];
    let k = t.kx;
    for (let p = 0; p < t.patchCount.length; p++) {
      for (let x = 0; x < t.patchCount[p]; x++, k++) {
        const src = t.patchStart[p] + x;
        let g = 0;
        while (g < t.nQ - 1 && k >= t.noise[g + 1]) g++;
        const w = bw[g], a0r = this.alpha0r[src] * w, a0i = this.alpha0i[src] * w, w2 = w * w, a1r = this.alpha1r[src] * w2, a1i = this.alpha1i[src] * w2;
        for (let l = l0; l < l1; l++) {
          const i0 = (l + HFADJ) * 64 + src, i1 = i0 - 64, i2 = i0 - 128;
          xr[(l + HFADJ) * 64 + k] = xr[i0] + a0r * xr[i1] - a0i * xi[i1] + a1r * xr[i2] - a1i * xi[i2];
          xi[(l + HFADJ) * 64 + k] = xi[i0] + a0r * xi[i1] + a0i * xr[i1] + a1r * xi[i2] + a1i * xr[i2];
        }
      }
    }
    for (; k < 64; k++) for (let l = l0; l < l1; l++) { xr[(l + HFADJ) * 64 + k] = 0; xi[(l + HFADJ) * 64 + k] = 0; }
    for (let i = 0; i < t.nQ; i++) { s.bwPrev[i] = bw[i]; s.invfPrev[i] = f.invf[i]; }
  }

  private lpc(xr: Float64Array, xi: Float64Array, k: number): void {
    // phi(i,j) = sum_n x[n+2-i] conj(x[n+2-j]), n = 0..37
    let p11 = 0, p22 = 0, p01r = 0, p01i = 0, p02r = 0, p02i = 0, p12r = 0, p12i = 0;
    for (let n = 0; n < SLOTS + 6; n++) {
      const a = (n + 2) * 64 + k, b = a - 64, c = a - 128;
      const ar = xr[a], ai = xi[a], br = xr[b], bi = xi[b], cr = xr[c], ci = xi[c];
      p11 += br * br + bi * bi; p22 += cr * cr + ci * ci;
      p01r += ar * br + ai * bi; p01i += ai * br - ar * bi;
      p02r += ar * cr + ai * ci; p02i += ai * cr - ar * ci;
      p12r += br * cr + bi * ci; p12i += bi * cr - br * ci;
    }
    const d = p22 * p11 - (p12r * p12r + p12i * p12i) / (1 + 1e-6);
    let a1r = 0, a1i = 0, a0r = 0, a0i = 0;
    if (d !== 0) {
      a1r = (p01r * p12r - p01i * p12i - p02r * p11) / d;
      a1i = (p01r * p12i + p01i * p12r - p02i * p11) / d;
    }
    if (p11 !== 0) {
      a0r = -(p01r + a1r * p12r + a1i * p12i) / p11;
      a0i = -(p01i + a1i * p12r - a1r * p12i) / p11;
    }
    if (a1r * a1r + a1i * a1i >= 16 || a0r * a0r + a0i * a0i >= 16 || !isFinite(a0r + a0i + a1r + a1i)) a0r = a0i = a1r = a1i = 0;
    this.alpha0r[k] = a0r; this.alpha0i[k] = a0i; this.alpha1r[k] = a1r; this.alpha1i[k] = a1i;
  }

  private hfAdjust(s: ChState, f: ChFrame, t: SbrTables): void {
    const { kx, m: M } = t, xr = s.xr, xi = s.xi;
    const tables = [t.low, t.high];
    const laPrev = s.prevLaLast ? 0 : -1;
    const hSL = this.hdr.smoothingMode ? 0 : 4;
    const sIdx = new Uint8Array(64);
    const eo = new Float64Array(64), qm = new Float64Array(64), sm = new Uint8Array(64), ec = new Float64Array(64);
    const G = new Float64Array(64), QM = new Float64Array(64), SM = new Float64Array(64);
    if (this.reset || !s.histValid) s.histValid = false;
    for (let l = 0; l < f.le; l++) {
      const tab = tables[f.f[l]], nb = tab.length - 1;
      for (let i = 0; i < nb; i++) for (let k = tab[i]; k < tab[i + 1]; k++) eo[k - kx] = f.eOrig[l][i];
      const qi = f.lq === 2 && f.tE[l] >= f.tQ[1] ? 1 : 0;
      for (let i = 0; i < t.nQ; i++) for (let k = t.noise[i]; k < t.noise[i + 1]; k++) qm[k - kx] = f.qOrig[qi][i];
      const prevS = s.sIdxPrev;
      sIdx.fill(0);
      if (f.harmFlag) for (let i = 0; i < t.nHigh; i++) {
        const mid = ((t.high[i] + t.high[i + 1]) >> 1) - kx;
        sIdx[mid] = f.harm[i] && (l >= f.lA || prevS[mid] === 1) ? 1 : 0;
      }
      for (let i = 0; i < nb; i++) {
        let any = 0;
        for (let k = tab[i]; k < tab[i + 1]; k++) if (sIdx[k - kx]) { any = 1; break; }
        for (let k = tab[i]; k < tab[i + 1]; k++) sm[k - kx] = any;
      }
      const s0 = 2 * f.tE[l] + HFADJ, s1 = 2 * f.tE[l + 1] + HFADJ;
      if (this.hdr.interpolFreq) {
        for (let m = 0; m < M; m++) {
          let e = 0;
          for (let i = s0; i < s1; i++) { const j = i * 64 + m + kx; e += xr[j] * xr[j] + xi[j] * xi[j]; }
          ec[m] = e / (s1 - s0);
        }
      } else {
        for (let i = 0; i < nb; i++) {
          let e = 0;
          for (let k = tab[i]; k < tab[i + 1]; k++) for (let j = s0; j < s1; j++) { const x = j * 64 + k; e += xr[x] * xr[x] + xi[x] * xi[x]; }
          e /= (s1 - s0) * (tab[i + 1] - tab[i]);
          for (let k = tab[i]; k < tab[i + 1]; k++) ec[k - kx] = e;
        }
      }
      const trans = l === f.lA || l === laPrev;
      const delta = trans ? 0 : 1;
      for (let b = 0; b + 1 < t.lim.length; b++) {
        const m0 = t.lim[b] - kx, m1 = t.lim[b + 1] - kx;
        let so = 0, sc = 0;
        for (let m = m0; m < m1; m++) {
          const tmp = eo[m] / (1 + qm[m]);
          QM[m] = Math.sqrt(tmp * qm[m]);
          SM[m] = Math.sqrt(tmp * sIdx[m]);
          G[m] = sm[m] ? Math.sqrt(eo[m] * qm[m] / ((1 + ec[m]) * (1 + qm[m]))) : Math.sqrt(eo[m] / ((1 + ec[m]) * (1 + qm[m] * delta)));
          so += eo[m]; sc += ec[m];
        }
        const gMax = Math.min(1e5, LIM_GAIN[this.hdr.limiterGains] * Math.sqrt((1e-12 + so) / (1e-12 + sc)));
        let den = 0;
        for (let m = m0; m < m1; m++) {
          if (G[m] > gMax) { QM[m] *= gMax / G[m]; G[m] = gMax; }
          den += ec[m] * G[m] * G[m] + SM[m] * SM[m] + (delta && !SM[m] ? QM[m] * QM[m] : 0);
        }
        const boost = Math.min(1.584893192, Math.sqrt((1e-12 + so) / (1e-12 + den)));
        for (let m = m0; m < m1; m++) { G[m] *= boost; QM[m] *= boost; SM[m] *= boost; }
      }
      if (!s.histValid) {
        for (let h = 0; h < 5; h++) { s.gHist[h].set(G); s.qHist[h].set(QM); }
        s.histValid = true;
      }
      for (let i = s0 - HFADJ; i < s1 - HFADJ; i++) {
        const gh = s.gHist.pop()!, qh = s.qHist.pop()!;
        gh.set(G); qh.set(QM);
        s.gHist.unshift(gh); s.qHist.unshift(qh);
        const row = (i + HFADJ) * 64 + kx;
        const sine = s.sineIdx, sr = [1, 0, -1, 0][sine], si = [0, 1, 0, -1][sine];
        for (let m = 0; m < M; m++) {
          let g = G[m], q = QM[m];
          if (hSL && !trans) {
            g = 0; q = 0;
            for (let j = 0; j <= 4; j++) { g += s.gHist[j][m] * H_SMOOTH[j]; q += s.qHist[j][m] * H_SMOOTH[j]; }
          }
          const x = row + m;
          xr[x] *= g; xi[x] *= g;
          const ni = (s.noiseIdx + m + 1) & 511;
          if (SM[m]) {
            const sg = ((m + kx) & 1) ? -1 : 1;
            xr[x] += SM[m] * sr; xi[x] += SM[m] * si * sg;
          } else if (!trans) {
            xr[x] += q * NOISE_TABLE[2 * ni]; xi[x] += q * NOISE_TABLE[2 * ni + 1];
          }
        }
        s.noiseIdx = (s.noiseIdx + M) & 511;
        s.sineIdx = (s.sineIdx + 1) & 3;
      }
      if (l === f.le - 1) s.sIdxPrev.set(sIdx);
    }
  }

  private buildX(s: ChState, f: ChFrame | null, t: SbrTables | null, XR: Float64Array, XI: Float64Array): void {
    XR.fill(0); XI.fill(0);
    for (let l = 0; l < SLOTS; l++) {
      let top = 32;
      if (f && t) top = l < 2 * f.tE[0] ? (this.kxPrev ? this.kxPrev + this.mPrev : t.kx) : t.kx + t.m;
      const src = (l + HFADJ) * 64, dst = l * 64;
      for (let k = 0; k < top; k++) { XR[dst + k] = s.xr[src + k]; XI[dst + k] = s.xi[src + k]; }
    }
  }

  private savePrev(s: ChState, f: ChFrame, _t: SbrTables): void {
    const last = f.E[f.le - 1];
    s.ePrev.fill(0); for (let i = 0; i < last.length; i++) s.ePrev[i] = last[i];
    s.fPrev = f.f[f.le - 1];
    const q = f.Q[f.lq - 1];
    s.qPrev.fill(0); for (let i = 0; i < q.length; i++) s.qPrev[i] = q[i];
    s.prevLaLast = f.lA === f.le;
    s.endPrev = f.tE[f.le];
    s.aPrev = f.ampRes;
  }
}

function ceilLog2(x: number): number { return [0, 0, 1, 2, 2, 3, 3, 3, 3, 4][x] ?? 4; }
