/** DRM parametric stereo (ETSI ES 201 980) as used by HDC: 32 QMF slots per frame instead of 30. */
import type { Bits } from './bits.js';
import { PS_HUFF } from './ps-tables.js';
import { buildHuff, huffDecode } from './sbr-huff.js';

const SA_BANDS = 8, PAN_BANDS = 20, LINKS = 3, SA_QMF = 23;
const SA_SCALE = [0, 1, 2, 3, 5, 7, 10, 13, 23];
const PAN_SCALE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 22, 26, 32, 64];
const PAN_CLASS = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4];
const SA_QUANT = [[0, 0], [0.0501, 0.1778], [0.0706, 0.2818], [0.0995, 0.4467], [0.1399, 0.5623], [0.1957, 0.7079], [0.2713, 0.8913], [0.3699, 1.0]];
const PAN_QUANT = [
  [0, 0, 0, 0, 0], [0.1661, 0.1661, 0.3322, 0.3322, 0.3322], [0.3322, 0.3322, 0.6644, 0.8305, 0.8305],
  [0.4983, 0.6644, 0.9966, 1.4949, 1.6610], [0.6644, 0.9966, 1.4949, 2.1593, 2.4914], [0.8305, 1.3288, 2.1593, 2.9897, 3.4880],
  [0.9966, 1.8271, 2.8236, 3.8202, 4.6507], [1.3288, 2.3253, 3.4880, 4.6507, 5.8134],
];
const FILTER = [0.65143905754106, 0.56471812200776, 0.48954165955695];
const DELAY = [3, 4, 5];
const FRACT = [0.43, 0.75, 0.347];
const PEAK_DECAY = 0.76592833836465, SMOOTH = 0.25;

const bandOf = (scale: number[], b: number) => { let i = 0; while (scale[i + 1] <= b) i++; return i; };
const SA_INV = Array.from({ length: SA_QMF }, (_, b) => bandOf(SA_SCALE, b));
const PAN_INV = Array.from({ length: 64 }, (_, b) => bandOf(PAN_SCALE, b));
const DECAY = Array.from({ length: SA_QMF }, (_, b) => Math.max(0, b < 3 ? 1 : 1 - 0.05 * (b - 2)));
/** exp(-j pi a (k + 1/2)) */
export const PHI_RE = new Float64Array(64), PHI_IM = new Float64Array(64);
export const Q_RE = new Float64Array(64 * LINKS), Q_IM = new Float64Array(64 * LINKS);
for (let k = 0; k < 64; k++) {
  PHI_RE[k] = Math.cos(Math.PI * 0.39 * (k + 0.5)); PHI_IM[k] = -Math.sin(Math.PI * 0.39 * (k + 0.5));
  for (let m = 0; m < LINKS; m++) { Q_RE[k * LINKS + m] = Math.cos(Math.PI * FRACT[m] * (k + 0.5)); Q_IM[k * LINKS + m] = -Math.sin(Math.PI * FRACT[m] * (k + 0.5)); }
}
const HT = { fSa: buildHuff(PS_HUFF.fSa), tSa: buildHuff(PS_HUFF.tSa), fPan: buildHuff(PS_HUFF.fPan), tPan: buildHuff(PS_HUFF.tPan) };
const panGain = (i: number, c: number) => (i < 0 ? -1 : 1) * PAN_QUANT[Math.abs(i)][c];

export class DrmPs {
  private avail = false;
  private enSa = 0; private enPan = 0; private saDt = 0; private panDt = 0;
  private lastSa = false; private lastPan = false;
  private saData = new Int32Array(SA_BANDS); private panData = new Int32Array(PAN_BANDS);
  private sa = new Int32Array(SA_BANDS); private pan = new Int32Array(PAN_BANDS);
  private saPrev = new Int32Array(SA_BANDS); private panPrev = new Int32Array(PAN_BANDS);
  private saGood = new Int32Array(SA_BANDS); private panGood = new Int32Array(PAN_BANDS);
  private saErr = false; private panErr = false;
  private delayIdx = [0, 0, 0];
  private dRe = [new Float64Array(SA_QMF), new Float64Array(SA_QMF)]; private dIm = [new Float64Array(SA_QMF), new Float64Array(SA_QMF)];
  private d2Re = new Float64Array(LINKS * 5 * SA_QMF); private d2Im = new Float64Array(LINKS * 5 * SA_QMF);
  private prevNrg = new Float64Array(SA_QMF); private prevPeak = new Float64Array(SA_QMF); private peakFast = new Float64Array(SA_QMF);
  private saRe = new Float64Array(32 * SA_QMF); private saIm = new Float64Array(32 * SA_QMF);

  read(b: Bits): void {
    this.avail = true;
    this.enSa = b.bit(); this.enPan = b.bit();
    if (this.enSa) { this.saDt = b.bit(); const h = this.saDt ? HT.tSa : HT.fSa; for (let i = 0; i < SA_BANDS; i++) this.saData[i] = huffDecode(b, h); }
    if (this.enPan) { this.panDt = b.bit(); const h = this.panDt ? HT.tPan : HT.fPan; for (let i = 0; i < PAN_BANDS; i++) this.panData[i] = huffDecode(b, h); }
  }

  /** X (slots x 64, in place) -> left; right into R. guess: SBR data of this frame was bad. */
  apply(xr: Float64Array, xi: Float64Array, rr: Float64Array, ri: Float64Array, slots: number, guess: boolean): void {
    if (!this.avail && !guess) {
      rr.set(xr); ri.set(xi);
      this.saPrev.fill(0); this.panPrev.fill(0);
      return;
    }
    if (!guess) { this.saErr = false; this.panErr = false; this.deltaDecode(); } else { this.saErr = true; this.panErr = true; }
    this.avail = false;
    this.sideSignal(xr, xi, slots);
    this.ambiance(xr, xi, rr, ri, slots);
    if (this.enSa) { this.lastSa = true; this.saPrev.set(this.sa); } else this.lastSa = false;
    if (this.enPan) { this.addPan(xr, xi, rr, ri, slots); this.lastPan = true; this.panPrev.set(this.pan); } else this.lastPan = false;
  }

  private deltaDecode(): void {
    const clipSa = (v: number) => { if (v < 0) { this.saErr = true; return 0; } if (v > 7) { this.saErr = true; return 7; } return v; };
    const clipPan = (v: number) => { if (v < -7) { this.panErr = true; return -7; } if (v > 7) { this.panErr = true; return 7; } return v; };
    if (this.enSa) {
      if (this.saDt && !this.lastSa) this.enSa = 0;
      else if (this.saDt) this.sa[0] = clipSa(this.saPrev[0] + this.saData[0]);
      else this.sa[0] = clipSa(this.saData[0]);
      for (let i = 1; i < SA_BANDS; i++) {
        if (this.saDt && this.lastSa) this.sa[i] = clipSa(this.saPrev[i] + this.saData[i]);
        else if (!this.saDt) this.sa[i] = clipSa(this.sa[i - 1] + this.saData[i]);
      }
    }
    if (this.saErr) { this.panErr = true; this.enPan = this.lastPan ? 1 : 0; this.enSa = this.lastSa ? 1 : 0; }
    if (this.enSa) { if (this.saErr) this.sa.set(this.saGood); else this.saGood.set(this.sa); }
    if (this.enPan) {
      if (this.panDt && !this.lastPan) this.enPan = 0;
      else if (this.panDt) this.pan[0] = clipPan(this.panPrev[0] + this.panData[0]);
      else this.pan[0] = clipPan(this.panData[0]);
      for (let i = 1; i < PAN_BANDS; i++) {
        if (this.panDt && this.lastPan) this.pan[i] = clipPan(this.panPrev[i] + this.panData[i]);
        else if (!this.panDt) this.pan[i] = clipPan(this.pan[i - 1] + this.panData[i]);
      }
      if (this.panErr) this.pan.set(this.panGood); else this.panGood.set(this.pan);
    }
  }

  private sideSignal(xr: Float64Array, xi: Float64Array, slots: number): void {
    const idx = [0, 0, 0];
    for (let b = 0; b < SA_QMF; b++) {
      for (let k = 0; k < LINKS; k++) idx[k] = this.delayIdx[k];
      const slope = FILTER.map(c => DECAY[b] * c);
      for (let s = 0; s < slots; s++) {
        const inR = xr[s * 64 + b], inI = xi[s * 64 + b], power = inR * inR + inI * inI;
        this.peakFast[b] = Math.max(this.peakFast[b] * PEAK_DECAY, power);
        const peak = this.prevPeak[b] += (this.peakFast[b] - power - this.prevPeak[b]) * SMOOTH;
        const nrg = this.prevNrg[b] += (power - this.prevNrg[b]) * SMOOTH;
        const ratio = peak * 1.5 <= nrg ? 1.5625 : nrg / (peak * 1.5) * 1.5625;
        const t0r = this.dRe[0][b], t0i = this.dIm[0][b];
        this.dRe[0][b] = this.dRe[1][b]; this.dIm[0][b] = this.dIm[1][b];
        this.dRe[1][b] = inR; this.dIm[1][b] = inI;
        let r0r = t0r * PHI_RE[b] - t0i * PHI_IM[b], r0i = t0r * PHI_IM[b] + t0i * PHI_RE[b];
        for (let k = 0; k < LINKS; k++) {
          const at = (k * 5 + idx[k]) * SA_QMF + b, dr = this.d2Re[at], di = this.d2Im[at];
          const qr = Q_RE[b * LINKS + k], qi = Q_IM[b * LINKS + k];
          const tr = dr * qr - di * qi - slope[k] * r0r, ti = dr * qi + di * qr - slope[k] * r0i;
          this.d2Re[at] = r0r + slope[k] * tr; this.d2Im[at] = r0i + slope[k] * ti;
          r0r = tr; r0i = ti;
        }
        this.saRe[s * SA_QMF + b] = r0r * ratio; this.saIm[s * SA_QMF + b] = r0i * ratio;
        for (let k = 0; k < LINKS; k++) if (++idx[k] >= DELAY[k]) idx[k] = 0;
      }
    }
    for (let k = 0; k < LINKS; k++) this.delayIdx[k] = idx[k];
  }

  private ambiance(xr: Float64Array, xi: Float64Array, rr: Float64Array, ri: Float64Array, slots: number): void {
    rr.set(xr); ri.set(xi);
    if (!this.enSa) return;
    for (let b = 0; b < SA_QMF; b++) {
      const f = SA_INV[b], c = b ? 1 : 0;
      let sa = SA_QUANT[this.saPrev[f]][c], dir = Math.sqrt(1 - sa * sa);
      const saN = SA_QUANT[this.sa[f]][c], dirN = Math.sqrt(1 - saN * saN);
      const kSa = (saN - sa) / slots, kDir = (dirN - dir) / slots;
      for (let s = 0; s < slots; s++) {
        const x = s * 64 + b, y = s * SA_QMF + b;
        const lr = xr[x], li = xi[x], sr = this.saRe[y], si = this.saIm[y];
        rr[x] = lr * dir - sr * sa; ri[x] = li * dir - si * sa;
        xr[x] = lr * dir + sr * sa; xi[x] = li * dir + si * sa;
        sa += kSa; dir += kDir;
      }
    }
  }

  private addPan(xr: Float64Array, xi: Float64Array, rr: Float64Array, ri: Float64Array, slots: number): void {
    for (let b = 0; b < 64; b++) {
      const f = PAN_INV[b], c = PAN_CLASS[f];
      const g0 = panGain(this.panPrev[f], c), g1 = panGain(this.pan[f], c);
      let base = Math.pow(2, g0);
      const step = Math.pow(2, (g1 - g0) / slots);
      for (let s = 0; s < slots; s++) {
        const x = s * 64 + b, c2 = 2 / (1 + base), c1 = c2 * base;
        xr[x] *= c1; xi[x] *= c1; rr[x] *= c2; ri[x] *= c2;
        base *= step;
      }
    }
  }
}
