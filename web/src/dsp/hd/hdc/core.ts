// HDC (HD Radio audio) AAC LC core decoder: one packet in, 1024 samples per channel at 22050 Hz out.
import { Bits } from './bits.js';
import {
  BOOK, BOOK_DIM, BOOK_LAV, BOOK_SIGNED, Huff, SWB_LONG, SWB_SHORT, TNS_MAX_SFB_LONG, TNS_MAX_SFB_SHORT, WIN_LONG, WIN_SHORT,
} from './aac-tables.js';
import { Imdct } from './imdct.js';

export interface HdcSbrData { buf: Uint8Array; bitPos: number; bitEnd: number }

export interface HdcCoreFrame {
  stereo: boolean;
  blockType: number;
  pcm: Float32Array[];
  sbr: HdcSbrData | null;
  error?: string;
  /** On a concealed frame: its energy against the last good frame (0 once faded out). */
  conceal?: number;
}

const LONG_START = 1, EIGHT_SHORT = 2, LONG_STOP = 3;
const NOISE_HCB = 13, INTENSITY_HCB2 = 14, INTENSITY_HCB = 15, ID_FIL = 6;
const MAX_SFB = 64, TNS_MAX_ORDER = 20;
/** Concealment: lost frames played from the last good spectrum, 3 dB down each, signs scrambled from about 2.8 kHz. */
const CONCEAL_FRAMES = 5, CONCEAL_STEP = Math.pow(10, -3 / 20), SCRAMBLE_FROM = 256;

const POW43 = new Float64Array(8192);
for (let i = 0; i < 8192; i++) POW43[i] = Math.pow(i, 4 / 3);

class Tns {
  present = false;
  nFilt = new Uint8Array(8);
  coefRes = new Uint8Array(8);
  length = new Uint8Array(32);
  order = new Uint8Array(32);
  direction = new Uint8Array(32);
  compress = new Uint8Array(32);
  coef = new Uint8Array(32 * 32);
}

class Ics {
  windowSequence = 0;
  windowShape = 0;
  maxSfb = 0;
  numWindows = 1;
  numGroups = 1;
  groupLen = new Uint8Array(8);
  swb: Uint16Array = SWB_LONG;
  numSwb = 47;
  msMask = 0;
  msUsed = new Uint8Array(8 * MAX_SFB);
  globalGain = 0;
  sfbCb = new Uint8Array(8 * MAX_SFB);
  sf = new Int16Array(8 * MAX_SFB);
  q = new Int32Array(1024);
  tns = new Tns();

  copyHeader(o: Ics): void {
    this.windowSequence = o.windowSequence; this.windowShape = o.windowShape; this.maxSfb = o.maxSfb;
    this.numWindows = o.numWindows; this.numGroups = o.numGroups; this.groupLen.set(o.groupLen);
    this.swb = o.swb; this.numSwb = o.numSwb; this.msMask = o.msMask; this.msUsed.set(o.msUsed);
  }
}

function huff(b: Bits, h: Huff): number {
  const t = h.tree;
  let n = 0;
  for (;;) { const v = t[2 * n + b.bit()]; if (v < 0) return ~v; n = v; }
}

class ChannelState {
  overlap = new Float64Array(1024);
  prevShape = 0;
  /** Spectrum of the last good frame as one long window, for concealment. */
  last = new Float64Array(1024);
  saved = new Float64Array(1024);
  savedLast = new Float64Array(1024);
  savedShape = 0;
}

export class HdcCore {
  private readonly ics = [new Ics(), new Ics()];
  private readonly ch = [new ChannelState(), new ChannelState()];
  private readonly spec = [new Float64Array(1024), new Float64Array(1024)];
  private readonly longT = new Imdct(1024);
  private readonly shortT = new Imdct(128);
  private readonly tbuf = new Float64Array(2048);
  private readonly wbuf = new Float64Array(2048);
  private readonly sbuf = new Float64Array(256);
  private seed = 0x1f2e3d4c;
  private lastStereo = false;
  private haveLast = false;
  private lostRun = 0;
  /** The last frame's window ended on a short slope (LONG_START or EIGHT_SHORT). */
  private shortTail = false;
  private readonly cIcs = new Ics();
  private undoable = false;
  private saved = { stereo: false, haveLast: false, lostRun: 0, shortTail: false };

  decode(pkt: Uint8Array): HdcCoreFrame {
    let blockType = -1;
    if (!pkt.length) return this.conceal(blockType, 'lost');
    this.save();
    try {
      const b = new Bits(pkt);
      blockType = b.read(3);
      const stereo = blockType === 2 || blockType === 7;
      const n = stereo ? 2 : 1;
      const [a, c] = this.ics;
      this.header(b, a, stereo);
      if (stereo) c.copyHeader(a);
      a.tns.present = b.bit() === 1;
      if (a.tns.present) this.tnsData(b, a);
      if (stereo) { c.tns.present = b.bit() === 1; if (c.tns.present) this.tnsData(b, c); }
      for (let i = 0; i < n; i++) {
        const ics = this.ics[i];
        ics.globalGain = b.read(8);
        this.sectionData(b, ics);
        this.scaleFactors(b, ics);
        this.spectralData(b, ics);
      }
      let sbr: HdcSbrData | null = null;
      if (b.left >= 3 && b.peek(3) === ID_FIL) {
        b.skip(3);
        if (b.bit() === 1) sbr = { buf: pkt, bitPos: b.pos, bitEnd: b.end };
      }
      for (let i = 0; i < n; i++) this.dequant(i);
      if (stereo) { this.msStereo(); this.intensity(); }
      if (!stereo && this.lastStereo) this.ch[1].overlap.fill(0);
      this.lastStereo = stereo;
      const seq = this.ics[0].windowSequence;
      // resuming on a short left slope after a long concealed tail: end that tail on the short slope too
      if (this.lostRun && !this.shortTail && (seq === EIGHT_SHORT || seq === LONG_STOP)) {
        for (let i = 0; i < n; i++) {
          const ov = this.ch[i].overlap, w = WIN_SHORT[this.ch[i].prevShape];
          for (let k = 0; k < 128; k++) ov[448 + k] *= w[127 - k];
          ov.fill(0, 576);
        }
      }
      const pcm: Float32Array[] = [];
      for (let i = 0; i < n; i++) {
        this.tnsDecode(this.ics[i], this.spec[i]);
        pcm.push(this.synth(this.ics[i], this.spec[i], this.ch[i]));
        this.keep(this.ics[i], this.spec[i], this.ch[i].last);
      }
      this.haveLast = true; this.lostRun = 0; this.undoable = true;
      this.shortTail = seq === EIGHT_SHORT || seq === LONG_START;
      return { stereo, blockType, pcm, sbr };
    } catch (e) {
      this.undoable = false;
      return this.conceal(blockType, e instanceof Error ? e.message : String(e));
    }
  }

  /** Takes back the last good decode (its output was garbage) and conceals that frame instead. */
  undo(): HdcCoreFrame {
    if (this.undoable) {
      const s = this.saved;
      this.lastStereo = s.stereo; this.haveLast = s.haveLast; this.lostRun = s.lostRun; this.shortTail = s.shortTail;
      for (const c of this.ch) { c.overlap.set(c.saved); c.last.set(c.savedLast); c.prevShape = c.savedShape; }
      this.undoable = false;
    }
    return this.conceal(-1, 'undone');
  }

  private save(): void {
    const s = this.saved;
    s.stereo = this.lastStereo; s.haveLast = this.haveLast; s.lostRun = this.lostRun; s.shortTail = this.shortTail;
    for (const c of this.ch) { c.saved.set(c.overlap); c.savedLast.set(c.last); c.savedShape = c.prevShape; }
  }

  // The frame's spectrum as one long window (short windows interleaved, sqrt(8) for the same level).
  private keep(ics: Ics, spec: Float64Array, last: Float64Array): void {
    if (ics.windowSequence !== EIGHT_SHORT) { last.set(spec); return; }
    const g = Math.SQRT2 * 2;
    for (let w = 0; w < 8; w++) for (let k = 0; k < 128; k++) last[8 * k + w] = spec[w * 128 + k] * g;
  }

  // Bad or lost packet: the last good spectrum again, decaying, then silence; the window stays long.
  private conceal(blockType: number, error: string): HdcCoreFrame {
    this.undoable = false;
    const run = ++this.lostRun, n = this.lastStereo ? 2 : 1;
    const g = this.haveLast && run <= CONCEAL_FRAMES ? Math.pow(CONCEAL_STEP, run - 1) : 0;
    const ics = this.cIcs, pcm: Float32Array[] = [];
    ics.windowSequence = this.shortTail ? LONG_STOP : 0;
    for (let k = 0; k < 1024; k++) {
      const sg = k >= SCRAMBLE_FROM && this.rand() < 0 ? -g : g;
      for (let i = 0; i < n; i++) this.spec[i][k] = this.ch[i].last[k] * sg;
    }
    for (let i = 0; i < n; i++) {
      ics.windowShape = this.ch[i].prevShape;
      pcm.push(this.synth(ics, this.spec[i], this.ch[i]));
    }
    this.shortTail = false;
    return { stereo: this.lastStereo, blockType, pcm, sbr: null, error, conceal: g * g };
  }

  private header(b: Bits, ics: Ics, stereo: boolean): void {
    if (b.bit() !== 0) throw new Error('reserved bit set');
    ics.windowShape = b.bit();
    ics.windowSequence = b.read(2);
    ics.groupLen.fill(0);
    if (ics.windowSequence === EIGHT_SHORT) {
      ics.maxSfb = b.read(4);
      const grouping = b.read(7);
      ics.numWindows = 8; ics.swb = SWB_SHORT; ics.numSwb = 15;
      ics.numGroups = 1; ics.groupLen[0] = 1;
      for (let w = 1; w < 8; w++) {
        if ((grouping >> (7 - w)) & 1) ics.groupLen[ics.numGroups - 1]++;
        else ics.groupLen[ics.numGroups++] = 1;
      }
    } else {
      ics.maxSfb = b.read(6);
      ics.numWindows = 1; ics.swb = SWB_LONG; ics.numSwb = 47;
      ics.numGroups = 1; ics.groupLen[0] = 1;
    }
    if (ics.maxSfb > ics.numSwb) throw new Error('max_sfb out of range');
    ics.msMask = 0;
    ics.msUsed.fill(0);
    if (stereo) {
      ics.msMask = b.read(2);
      if (ics.msMask === 3) throw new Error('ms_mask_present 3');
      if (ics.msMask === 1) {
        for (let g = 0; g < ics.numGroups; g++) for (let s = 0; s < ics.maxSfb; s++) ics.msUsed[g * MAX_SFB + s] = b.bit();
      }
    }
  }

  private tnsData(b: Bits, ics: Ics): void {
    const t = ics.tns, short = ics.windowSequence === EIGHT_SHORT;
    const lenBits = short ? 4 : 6, ordBits = short ? 3 : 5;
    for (let w = 0; w < ics.numWindows; w++) {
      t.nFilt[w] = short ? b.bit() : 1;
      if (t.nFilt[w]) t.coefRes[w] = b.bit();
      for (let f = 0; f < t.nFilt[w]; f++) {
        const k = w * 4 + f;
        t.length[k] = b.read(lenBits);
        t.order[k] = b.read(ordBits);
        if (t.order[k]) {
          t.direction[k] = b.bit();
          t.compress[k] = b.bit();
          const bits = 3 + t.coefRes[w] - t.compress[k];
          for (let i = 0; i < t.order[k]; i++) t.coef[k * 32 + i] = b.read(bits);
        }
      }
    }
  }

  private sectionData(b: Bits, ics: Ics): void {
    const short = ics.windowSequence === EIGHT_SHORT, bits = short ? 3 : 5, esc = (1 << bits) - 1;
    ics.sfbCb.fill(0);
    for (let g = 0; g < ics.numGroups; g++) {
      let k = 0, sections = 0;
      while (k < ics.maxSfb) {
        if (++sections > 120) throw new Error('too many sections');
        const cb = b.read(4);
        if (cb === 12) throw new Error('codebook 12');
        let len = 0, inc: number;
        while ((inc = b.read(bits)) === esc) len += inc;
        len += inc;
        if (k + len > ics.maxSfb) throw new Error('section past max_sfb');
        for (let s = k; s < k + len; s++) ics.sfbCb[g * MAX_SFB + s] = cb;
        k += len;
      }
    }
  }

  private scaleFactors(b: Bits, ics: Ics): void {
    let sf = ics.globalGain, isPos = 0, noise = ics.globalGain - 90, firstNoise = true;
    for (let g = 0; g < ics.numGroups; g++) {
      for (let s = 0; s < ics.maxSfb; s++) {
        const i = g * MAX_SFB + s, cb = ics.sfbCb[i];
        if (cb === 0) { ics.sf[i] = 0; continue; }
        if (cb === INTENSITY_HCB || cb === INTENSITY_HCB2) { isPos += huff(b, BOOK[0]) - 60; ics.sf[i] = isPos; continue; }
        if (cb === NOISE_HCB) {
          if (firstNoise) { firstNoise = false; noise += b.read(9) - 256; } else noise += huff(b, BOOK[0]) - 60;
          ics.sf[i] = noise; continue;
        }
        sf += huff(b, BOOK[0]) - 60;
        if (sf < 0 || sf > 255) throw new Error('scalefactor out of range');
        ics.sf[i] = sf;
      }
    }
  }

  // Quantized values in bitstream order (per group: band, window, bin).
  private spectralData(b: Bits, ics: Ics): void {
    const q = ics.q, swb = ics.swb;
    q.fill(0);
    let base = 0;
    for (let g = 0; g < ics.numGroups; g++) {
      const L = ics.groupLen[g];
      for (let s = 0; s < ics.maxSfb; s++) {
        const cb = ics.sfbCb[g * MAX_SFB + s];
        if (cb === 0 || cb > 11) continue;
        const h = BOOK[cb], dim = BOOK_DIM[cb], signed = BOOK_SIGNED[cb], lav = BOOK_LAV[cb];
        const start = base + swb[s] * L, end = base + swb[s + 1] * L;
        for (let k = start; k < end; k += dim) {
          let sym = huff(b, h);
          if (dim === 4) {
            const off = signed ? 1 : 0;
            q[k + 3] = (sym % 3) - off; sym = (sym / 3) | 0;
            q[k + 2] = (sym % 3) - off; sym = (sym / 3) | 0;
            q[k + 1] = (sym % 3) - off;
            q[k] = ((sym / 3) | 0) - off;
          } else {
            const mod = signed ? 2 * lav + 1 : lav + 1, off = signed ? lav : 0;
            q[k + 1] = (sym % mod) - off;
            q[k] = ((sym / mod) | 0) - off;
          }
          if (!signed) {
            for (let j = 0; j < dim; j++) if (q[k + j] && b.bit()) q[k + j] = -q[k + j];
            if (cb === 11) {
              for (let j = 0; j < 2; j++) {
                const v = q[k + j];
                if (v === 16 || v === -16) {
                  let n = 0;
                  while (b.bit()) if (++n > 8) throw new Error('escape too long');
                  const m = (1 << (n + 4)) + b.read(n + 4);
                  q[k + j] = v < 0 ? -m : m;
                }
              }
            }
          }
        }
      }
      base += 128 * L;
    }
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
    return this.seed / 2147483648;
  }

  // Inverse quantization, deinterleaving into window order, and noise substitution.
  private dequant(c: number): void {
    const ics = this.ics[c], spec = this.spec[c], q = ics.q, swb = ics.swb;
    spec.fill(0);
    let win = 0, base = 0;
    for (let g = 0; g < ics.numGroups; g++) {
      const L = ics.groupLen[g];
      for (let s = 0; s < ics.maxSfb; s++) {
        const i = g * MAX_SFB + s, cb = ics.sfbCb[i], w0 = swb[s], width = swb[s + 1] - w0;
        if (cb === NOISE_HCB) {
          const shared = c === 1 && this.ics[0].sfbCb[i] === NOISE_HCB && (ics.msMask === 2 || ics.msUsed[i]);
          const gain = Math.pow(2, 0.25 * ics.sf[i]);
          for (let w = 0; w < L; w++) {
            const o = (win + w) * 128 + w0;
            let e = 0;
            for (let k = 0; k < width; k++) { const v = shared ? this.spec[0][o + k] : this.rand(); spec[o + k] = v; e += v * v; }
            const sc = e > 0 ? gain / Math.sqrt(e) : 0;
            for (let k = 0; k < width; k++) spec[o + k] *= sc;
          }
          continue;
        }
        if (cb === 0 || cb > 11) continue;
        const gain = Math.pow(2, 0.25 * (ics.sf[i] - 100));
        for (let w = 0; w < L; w++) {
          const src = base + w0 * L + w * width, dst = (win + w) * 128 + w0;
          for (let k = 0; k < width; k++) {
            const v = q[src + k];
            if (v === 0) continue;
            spec[dst + k] = v > 0 ? POW43[v] * gain : -POW43[-v] * gain;
          }
        }
      }
      win += L; base += 128 * L;
    }
  }

  private msStereo(): void {
    const [a, c] = this.ics, l = this.spec[0], r = this.spec[1];
    if (a.msMask === 0) return;
    let win = 0;
    for (let g = 0; g < a.numGroups; g++) {
      const L = a.groupLen[g];
      for (let s = 0; s < a.maxSfb; s++) {
        const i = g * MAX_SFB + s, cb1 = a.sfbCb[i], cb2 = c.sfbCb[i];
        if (!(a.msMask === 2 || a.msUsed[i])) continue;
        if (cb2 === INTENSITY_HCB || cb2 === INTENSITY_HCB2 || cb1 === NOISE_HCB || cb2 === NOISE_HCB) continue;
        for (let w = 0; w < L; w++) {
          const o = (win + w) * 128;
          for (let k = a.swb[s]; k < a.swb[s + 1]; k++) { const m = l[o + k], d = r[o + k]; l[o + k] = m + d; r[o + k] = m - d; }
        }
      }
      win += L;
    }
  }

  private intensity(): void {
    const [a, c] = this.ics, l = this.spec[0], r = this.spec[1];
    let win = 0;
    for (let g = 0; g < c.numGroups; g++) {
      const L = c.groupLen[g];
      for (let s = 0; s < c.maxSfb; s++) {
        const i = g * MAX_SFB + s, cb = c.sfbCb[i];
        if (cb !== INTENSITY_HCB && cb !== INTENSITY_HCB2) continue;
        let sign = cb === INTENSITY_HCB ? 1 : -1;
        if (a.msMask === 1 && a.msUsed[i]) sign = -sign;
        const sc = sign * Math.pow(2, -0.25 * c.sf[i]);
        for (let w = 0; w < L; w++) {
          const o = (win + w) * 128;
          for (let k = c.swb[s]; k < c.swb[s + 1]; k++) r[o + k] = l[o + k] * sc;
        }
      }
      win += L;
    }
  }

  private tnsDecode(ics: Ics, spec: Float64Array): void {
    const t = ics.tns;
    if (!t.present) return;
    const short = ics.windowSequence === EIGHT_SHORT, tmax = short ? TNS_MAX_SFB_SHORT : TNS_MAX_SFB_LONG;
    const lpc = new Float64Array(TNS_MAX_ORDER + 1), tmp = new Float64Array(TNS_MAX_ORDER + 1), st = new Float64Array(TNS_MAX_ORDER);
    for (let w = 0; w < ics.numWindows; w++) {
      let bottom = ics.numSwb;
      for (let f = 0; f < t.nFilt[w]; f++) {
        const k = w * 4 + f, top = bottom;
        bottom = Math.max(top - t.length[k], 0);
        const order = Math.min(t.order[k], TNS_MAX_ORDER);
        if (!order) continue;
        const resBits = 3 + t.coefRes[w], bits = resBits - t.compress[k];
        const iq = ((1 << (resBits - 1)) - 0.5) / (Math.PI / 2), iqm = ((1 << (resBits - 1)) + 0.5) / (Math.PI / 2);
        lpc.fill(0); lpc[0] = 1;
        for (let m = 1; m <= order; m++) {
          let v = t.coef[k * 32 + m - 1];
          if (v & (1 << (bits - 1))) v -= 1 << bits;
          const rc = Math.sin(v / (v >= 0 ? iq : iqm));
          for (let i = 1; i < m; i++) tmp[i] = lpc[i] + rc * lpc[m - i];
          for (let i = 1; i < m; i++) lpc[i] = tmp[i];
          lpc[m] = rc;
        }
        const start = ics.swb[Math.min(bottom, tmax, ics.maxSfb)], end = ics.swb[Math.min(top, tmax, ics.maxSfb)];
        const size = end - start;
        if (size <= 0) continue;
        const inc = t.direction[k] ? -1 : 1, o = w * 128;
        let p = o + (t.direction[k] ? end - 1 : start);
        st.fill(0);
        for (let n = 0; n < size; n++, p += inc) {
          let y = spec[p];
          for (let j = 0; j < order; j++) y -= lpc[j + 1] * st[j];
          for (let j = order - 1; j > 0; j--) st[j] = st[j - 1];
          st[0] = y; spec[p] = y;
        }
      }
    }
  }

  // IMDCT, windowing with shape switching, overlap-add.
  private synth(ics: Ics, spec: Float64Array, ch: ChannelState): Float32Array {
    const seq = ics.windowSequence, buf = this.wbuf, t = this.tbuf;
    const lp = WIN_LONG[ch.prevShape], lc = WIN_LONG[ics.windowShape];
    const sp = WIN_SHORT[ch.prevShape], sc = WIN_SHORT[ics.windowShape];
    if (seq === EIGHT_SHORT) {
      buf.fill(0);
      const s = this.sbuf;
      for (let w = 0; w < 8; w++) {
        this.shortT.run(spec, w * 128, s);
        const rise = w === 0 ? sp : sc, o = 448 + 128 * w;
        for (let n = 0; n < 128; n++) { buf[o + n] += s[n] * rise[n]; buf[o + 128 + n] += s[128 + n] * sc[127 - n]; }
      }
    } else {
      this.longT.run(spec, 0, t);
      if (seq === LONG_STOP) {
        for (let n = 0; n < 448; n++) buf[n] = 0;
        for (let n = 0; n < 128; n++) buf[448 + n] = t[448 + n] * sp[n];
        for (let n = 576; n < 1024; n++) buf[n] = t[n];
      } else {
        for (let n = 0; n < 1024; n++) buf[n] = t[n] * lp[n];
      }
      if (seq === LONG_START) {
        for (let n = 1024; n < 1472; n++) buf[n] = t[n];
        for (let n = 0; n < 128; n++) buf[1472 + n] = t[1472 + n] * sc[127 - n];
        for (let n = 1600; n < 2048; n++) buf[n] = 0;
      } else {
        for (let n = 0; n < 1024; n++) buf[1024 + n] = t[1024 + n] * lc[1023 - n];
      }
    }
    const out = new Float32Array(1024), ov = ch.overlap;
    for (let n = 0; n < 1024; n++) { out[n] = (ov[n] + buf[n]) / 32768; ov[n] = buf[1024 + n]; }
    ch.prevShape = ics.windowShape;
    return out;
  }
}
