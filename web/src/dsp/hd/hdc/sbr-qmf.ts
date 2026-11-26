/** Complex SBR QMF banks (ISO/IEC 14496-3 4.6.18.4): 32-band analysis and 64-band synthesis. */
import { QMF_WINDOW } from './sbr-tables.js';

const A_COS = new Float64Array(32 * 64), A_SIN = new Float64Array(32 * 64);
const S_COS = new Float64Array(128 * 64), S_SIN = new Float64Array(128 * 64);
const WIN_A = new Float64Array(320);
for (let k = 0; k < 32; k++) for (let n = 0; n < 64; n++) {
  const a = Math.PI / 64 * (k + 0.5) * (2 * n - 0.5);
  A_COS[k * 64 + n] = 2 * Math.cos(a); A_SIN[k * 64 + n] = 2 * Math.sin(a);
}
for (let n = 0; n < 128; n++) for (let k = 0; k < 64; k++) {
  const a = Math.PI / 128 * (k + 0.5) * (2 * n - 255);
  S_COS[n * 64 + k] = Math.cos(a) / 64; S_SIN[n * 64 + k] = Math.sin(a) / 64;
}
for (let n = 0; n < 320; n++) WIN_A[n] = QMF_WINDOW[2 * n];

export class QmfAnalysis {
  private x = new Float64Array(320);
  private u = new Float64Array(64);
  /** 32 input samples -> 32 complex subbands written to re/im at offset. */
  slot(input: ArrayLike<number>, inOff: number, scale: number, re: Float64Array, im: Float64Array, off: number): void {
    const x = this.x, u = this.u;
    x.copyWithin(32, 0, 288);
    for (let n = 0; n < 32; n++) x[31 - n] = input[inOff + n] * scale;
    for (let n = 0; n < 64; n++) u[n] = x[n] * WIN_A[n] + x[n + 64] * WIN_A[n + 64] + x[n + 128] * WIN_A[n + 128] + x[n + 192] * WIN_A[n + 192] + x[n + 256] * WIN_A[n + 256];
    for (let k = 0; k < 32; k++) {
      let r = 0, i = 0;
      const b = k * 64;
      for (let n = 0; n < 64; n++) { r += u[n] * A_COS[b + n]; i += u[n] * A_SIN[b + n]; }
      re[off + k] = r; im[off + k] = i;
    }
  }
  reset(): void { this.x.fill(0); }
}

export class QmfSynthesis {
  private v = new Float64Array(1280);
  /** 64 complex subbands -> 64 output samples. */
  slot(re: Float64Array, im: Float64Array, off: number, out: Float32Array, outOff: number, scale: number): void {
    const v = this.v;
    v.copyWithin(128, 0, 1152);
    for (let n = 0; n < 128; n++) {
      let s = 0;
      const b = n * 64;
      for (let k = 0; k < 64; k++) s += re[off + k] * S_COS[b + k] - im[off + k] * S_SIN[b + k];
      v[n] = s;
    }
    const c = QMF_WINDOW;
    for (let n = 0; n < 64; n++) {
      let s = 0;
      for (let i = 0; i < 5; i++) s += v[256 * i + n] * c[128 * i + n] + v[256 * i + 192 + n] * c[128 * i + 64 + n];
      out[outOff + n] = s * scale;
    }
  }
  reset(): void { this.v.fill(0); }
  copyFrom(o: QmfSynthesis): void { this.v.set(o.v); }
}
