/** SBR frequency band tables (ISO/IEC 14496-3 4.6.18.3) at the 44.1 kHz SBR rate used by HDC. */

export interface SbrHeader {
  ampRes: number; startFreq: number; stopFreq: number; xoverBand: number;
  freqScale: number; alterScale: number; noiseBands: number;
  limiterBands: number; limiterGains: number; interpolFreq: number; smoothingMode: number;
}

export interface SbrTables {
  k0: number; k2: number; kx: number; m: number;
  master: number[]; high: number[]; low: number[]; noise: number[];
  nHigh: number; nLow: number; nQ: number;
  patchStart: number[]; patchCount: number[];
  lim: number[];
}

const FS = 44100;
const START_MIN = Math.floor(4000 * 128 / FS + 0.5);
const STOP_MIN = Math.floor(8000 * 128 / FS + 0.5);
const START_OFFSET = [-4, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 16, 20];
const round = (x: number) => Math.floor(x + 0.5);

export function startChannel(startFreq: number): number { return START_MIN + START_OFFSET[startFreq]; }

export function stopChannel(stopFreq: number, k0: number): number {
  if (stopFreq === 15) return Math.min(64, 3 * k0);
  if (stopFreq === 14) return Math.min(64, 2 * k0);
  const t: number[] = [];
  for (let i = 0; i <= 13; i++) t.push(round(STOP_MIN * Math.pow(64 / STOP_MIN, i / 13)));
  const dk = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
  let k2 = STOP_MIN;
  for (let i = 0; i < stopFreq; i++) k2 += dk[i];
  return Math.min(64, k2);
}

function bandDeltas(a: number, b: number, n: number): number[] {
  const d: number[] = [];
  for (let k = 0; k < n; k++) d.push(round(a * Math.pow(b / a, (k + 1) / n)) - round(a * Math.pow(b / a, k / n)));
  return d.sort((x, y) => x - y);
}

export function masterTable(k0: number, k2: number, freqScale: number, alterScale: number): number[] | null {
  if (k2 <= k0) return null;
  if (freqScale === 0) {
    const dk = alterScale ? 2 : 1;
    const n = alterScale ? 2 * round((k2 - k0) / 4) : 2 * Math.floor((k2 - k0) / 2);
    if (n <= 0) return null;
    const vDk = new Array<number>(n).fill(dk);
    let diff = k2 - (k0 + n * dk);
    if (diff) {
      const incr = diff > 0 ? -1 : 1;
      let k = diff > 0 ? n - 1 : 0;
      while (diff !== 0 && k >= 0 && k < n) { vDk[k] -= incr; k += incr; diff += incr; }
    }
    const f = [k0];
    for (let k = 0; k < n; k++) { if (vDk[k] <= 0) return null; f.push(f[k] + vDk[k]); }
    return f;
  }
  const bands = [12, 10, 8][freqScale - 1];
  const two = k2 / k0 > 2.2449;
  const k1 = two ? 2 * k0 : k2;
  const n0 = 2 * round(bands * Math.log2(k1 / k0) / 2);
  if (n0 <= 0) return null;
  const d0 = bandDeltas(k0, k1, n0);
  if (d0[0] <= 0) return null;
  const f = [k0];
  for (const d of d0) f.push(f[f.length - 1] + d);
  if (!two) return f;
  const warp = alterScale ? 1.3 : 1.0;
  const n1 = 2 * round(bands * Math.log2(k2 / k1) / (2 * warp));
  if (n1 <= 0) return null;
  const d1 = bandDeltas(k1, k2, n1);
  if (d1[0] < d0[n0 - 1]) {
    const change = d0[n0 - 1] - d1[0];
    d1[0] = d0[n0 - 1];
    d1[n1 - 1] -= change;
    d1.sort((x, y) => x - y);
  }
  if (d1[0] <= 0) return null;
  for (const d of d1) f.push(f[f.length - 1] + d);
  return f;
}

export function buildTables(h: SbrHeader): SbrTables | null {
  const k0 = startChannel(h.startFreq), k2 = stopChannel(h.stopFreq, k0);
  if (k2 - k0 > 45) return null;
  const master = masterTable(k0, k2, h.freqScale, h.alterScale);
  if (!master || master.length - 1 > 64) return null;
  const nMaster = master.length - 1;
  if (h.xoverBand >= nMaster) return null;
  const nHigh = nMaster - h.xoverBand, nLow = (nHigh + 1) >> 1;
  const high = master.slice(h.xoverBand);
  const kx = high[0], m = high[nHigh] - kx;
  if (kx > 32 || kx + m > 64 || m <= 0) return null;
  const odd = nHigh & 1, low = [high[0]];
  for (let k = 1; k <= nLow; k++) low.push(high[2 * k - odd]);
  const nQ = Math.max(1, round(h.noiseBands * Math.log2(k2 / kx)));
  if (nQ > 5) return null;
  const noise = [low[0]];
  let i = 0;
  for (let k = 1; k <= nQ; k++) { i += Math.floor((nLow - i) / (nQ + 1 - k)); noise.push(low[i]); }
  const t: SbrTables = { k0, k2, kx, m, master, high, low, noise, nHigh, nLow, nQ, patchStart: [], patchCount: [], lim: [] };
  if (!patches(t)) return null;
  t.lim = limiterTable(t, h.limiterBands);
  return t;
}

function patches(t: SbrTables): boolean {
  const { k0, kx, m, master } = t, nMaster = master.length - 1;
  const goal = round(2.048e6 / FS);
  let msb = k0, usb = kx, k = nMaster, sb = 0, guard = 0;
  if (goal < kx + m) { k = 0; while (master[k] < goal) k++; }
  t.patchStart = []; t.patchCount = [];
  do {
    if (++guard > 16) return false;
    let j = k + 1, odd = 0;
    do { j--; sb = master[j]; odd = (sb - 2 + k0) & 1; } while (j > 0 && sb > k0 - 1 + msb - odd);
    const n = Math.max(sb - usb, 0);
    if (n > 0) {
      if (t.patchCount.length >= 6) return false;
      t.patchCount.push(n); t.patchStart.push(k0 - odd - n);
      usb = sb; msb = sb;
    } else msb = kx;
    if (master[k] - sb < 3) k = nMaster;
  } while (sb !== kx + m);
  if (t.patchCount.length > 1 && t.patchCount[t.patchCount.length - 1] < 3) { t.patchCount.pop(); t.patchStart.pop(); }
  if (!t.patchCount.length) return false;
  for (let i = 0; i < t.patchStart.length; i++) if (t.patchStart[i] < 0) return false;
  return true;
}

/** Limiter band borders (absolute QMF bands) for bs_limiter_bands. */
export function limiterTable(t: SbrTables, limiterBands: number): number[] {
  if (limiterBands === 0) return [t.low[0], t.low[t.nLow]];
  const per = [1.2, 2, 3][limiterBands - 1];
  const borders = [t.kx];
  for (const n of t.patchCount) borders.push(borders[borders.length - 1] + n);
  const lim = [...t.low, ...borders.slice(1, -1)].sort((a, b) => a - b);
  const isBorder = (v: number) => borders.includes(v);
  let k = 1;
  while (k < lim.length) {
    const oct = lim[k - 1] ? Math.log2(lim[k] / lim[k - 1]) : 0;
    if (oct * per < 0.49) {
      if (lim[k] === lim[k - 1]) { lim.splice(k, 1); continue; }
      if (isBorder(lim[k])) {
        if (isBorder(lim[k - 1])) { k++; continue; }
        lim.splice(k - 1, 1); continue;
      }
      lim.splice(k, 1); continue;
    }
    k++;
  }
  return lim;
}
