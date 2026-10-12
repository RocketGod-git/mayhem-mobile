/** In-place iterative radix-2 FFT (length must be a power of two). Port of core/Dsp.kt. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j |= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = cr * re[b] - ci * im[b];
        const ti = cr * im[b] + ci * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Hann-windowed load of the first min(N, nSamp) signed-int8 IQ samples into re/im, zero padded. */
export function loadIq(iq: Int8Array, nSamp: number, re: Float32Array, im: Float32Array): void {
  const nFft = re.length;
  const n = Math.min(nFft, nSamp);
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1));
    re[k] = iq[2 * k] * w;
    im[k] = iq[2 * k + 1] * w;
  }
  for (let k = n; k < nFft; k++) { re[k] = 0; im[k] = 0; }
}

const windows = new Map<number, Float32Array>();
/** Hann window of length n (cached). */
export function hann(n: number): Float32Array {
  let w = windows.get(n);
  if (!w) { w = new Float32Array(n); for (let k = 0; k < n; k++) w[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1)); windows.set(n, w); }
  return w;
}

/** Windowed load of re.length signed-int8 IQ samples starting at sample index `offset` (caller guarantees range). */
export function loadIqAt(iq: Int8Array, offset: number, re: Float32Array, im: Float32Array, w: Float32Array): void {
  const n = re.length;
  let s = 2 * offset;
  for (let k = 0; k < n; k++, s += 2) { re[k] = iq[s] * w[k]; im[k] = iq[s + 1] * w[k]; }
}

/** Add this frame's fftshifted linear power into acc (length = FFT length, DC in the center). */
export function accumulatePower(re: Float32Array, im: Float32Array, acc: Float32Array): void {
  const n = re.length, h = n >> 1;
  for (let i = 0; i < n; i++) { const s = i < h ? i + h : i - h; acc[i] += re[s] * re[s] + im[s] * im[s]; }
}

/** Averaged power (acc / frames) in dB, peak-downsampled to out.length bins. acc is already fftshifted. */
export function powerDbFrom(acc: Float32Array, frames: number, out: Float32Array): void {
  const n = acc.length, bins = out.length, group = n / bins, inv = 1 / Math.max(1, frames);
  for (let bin = 0; bin < bins; bin++) {
    let peak = 0;
    const base = bin * group;
    for (let j = 0; j < group; j++) { const v = acc[base + j]; if (v > peak) peak = v; }
    out[bin] = 10 * Math.log10(peak * inv + 1e-9);
  }
}

/** fftshifted power in dB, peak-downsampled to out.length bins, DC in the center. */
export function powerDb(re: Float32Array, im: Float32Array, out: Float32Array): void {
  const nFft = re.length, bins = out.length, group = nFft / bins;
  for (let bin = 0; bin < bins; bin++) {
    let peak = 0;
    for (let j = 0; j < group; j++) {
      const idx = bin * group + j;
      const s = (idx + nFft / 2) % nFft;
      const mag = re[s] * re[s] + im[s] * im[s];
      if (mag > peak) peak = mag;
    }
    out[bin] = 10 * Math.log10(peak + 1e-9);
  }
}
