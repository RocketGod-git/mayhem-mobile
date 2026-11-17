/**
 * 8VSB receiver for one burst of samples (ATSC A/53 Part 2 Sec 5): pilot lock, resampling to 2 samples per symbol
 * through a root-raised-cosine receive filter, segment and field sync, then a T/2 equalizer (complex in, real out,
 * with a pilot bias tap and decision feedback for long echoes) and the 12-way trellis decoder.
 * The equalizer starts from a least-squares fit on the field sync and segment syncs; its feedback taps start from
 * the echo profile measured on PN511, then both adapt (LMS) on decisions.
 */
import { fft } from '../../fft.js';
import { SEG, FIELD_SEGS, FIELD_SYMS, FIELD_DATA_SYMS, TrellisDecoder } from './fec.js';

export const SR = 4.5e6 / 286 * 684;
const SEG2 = 2 * SEG;
const PN511S = '0000000101111111110010101010111001100110100010001001111000011101011111010011010100111011001110100100010110001111001000010100011111001111010100010100110000110001000001000011111100000101010000001100111111101110101010010110011000110111011110110100101001001110011100010111010000110100111110110001010110111100110110101110110110010110110111001001001011100011100101111010001101011000010011011111000100101011110001100101000010001100000111101111110101101010110010011001000111011100001011010000011011000000100100000001110';
const PN63S = '111001001011011101100110101011111100000100001100010100111101000';
const VSB_MODE_8T = '000010100101111101011010';
export const PN511 = Float32Array.from(PN511S, c => (c === '1' ? 1 : -1));
export const PN63 = Float32Array.from(PN63S, c => (c === '1' ? 1 : -1));
/** Known symbols at the start of a field sync segment (pilot excluded): 728 of them. */
export function fieldSyncSymbols(middleInverted: boolean): Float32Array {
  const out = new Float32Array(728);
  out.set([5, -5, -5, 5]);
  for (let k = 0; k < 511; k++) out[4 + k] = 5 * PN511[k];
  for (let k = 0; k < 63; k++) { out[515 + k] = 5 * PN63[k]; out[578 + k] = (middleInverted ? -5 : 5) * PN63[k]; out[641 + k] = 5 * PN63[k]; }
  for (let k = 0; k < 24; k++) out[704 + k] = VSB_MODE_8T[k] === '1' ? 5 : -5;
  return out;
}

/** Root raised cosine, time in symbols. */
export function rrc(t: number, a: number): number {
  if (Math.abs(t) < 1e-9) return 1 - a + 4 * a / Math.PI;
  if (Math.abs(Math.abs(4 * a * t) - 1) < 1e-9) return a / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)));
  return (Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - (4 * a * t) ** 2));
}
export const ALPHA = 0.1152;

export interface PilotInfo { hz: number; db: number; topDb: number }
/**
 * The pilot near `nominal` (from the tuned center; -Sr/4 when the channel is centered), its offset from where it
 * should be and its level over the data plateau above it; `topDb` is the plateau over the floor below the channel.
 */
export function findPilot(re: Float32Array, im: Float32Array, rate: number, searchHz = 30_000, nominal = -SR / 4): PilotInfo | null {
  const N = 16384, n = re.length;
  if (n < N) return null;
  const acc = new Float64Array(N), fr = new Float32Array(N), fi = new Float32Array(N), w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const frames = Math.min(24, Math.floor(n / N)), step = Math.floor((n - N) / Math.max(1, frames - 1));
  for (let f = 0; f < frames; f++) {
    const o = f * step;
    for (let i = 0; i < N; i++) { fr[i] = re[o + i] * w[i]; fi[i] = im[o + i] * w[i]; }
    fft(fr, fi);
    for (let i = 0; i < N; i++) acc[i] += fr[i] * fr[i] + fi[i] * fi[i];
  }
  const bin = (hz: number) => ((Math.round(hz / rate * N) % N) + N) % N;
  const nom = nominal, lo = Math.round((nom - searchHz) / rate * N), hi = Math.round((nom + searchHz) / rate * N);
  let best = lo, bv = -1;
  for (let k = lo; k <= hi; k++) { const v = acc[((k % N) + N) % N]; if (v > bv) { bv = v; best = k; } }
  if (bv <= 0) return null;
  const at = (k: number) => acc[((k % N) + N) % N];
  const a = Math.log(at(best - 1) + 1e-12), b = Math.log(at(best) + 1e-12), c = Math.log(at(best + 1) + 1e-12);
  const den = a - 2 * b + c, d = den !== 0 ? 0.5 * (a - c) / den : 0;
  const hz = (best + d) * rate / N;
  // the data plateau: median level 0.8-5.5 MHz into the channel (relative to the pilot), the floor outside it
  const plateau: number[] = [], outside: number[] = [];
  const edge = rate / 2 - 150_000;
  for (let f = hz + 300_000; f < hz + 5_500_000 && f < edge; f += rate / N * 7) plateau.push(at(bin(f)));
  for (let f = hz - 450_000; f > -edge && f > hz - 900_000; f -= rate / N * 3) outside.push(at(bin(f)));
  plateau.sort((x, y) => x - y);
  outside.sort((x, y) => x - y);
  const med = plateau[plateau.length >> 1] || 1e-12;
  const pk = at(best - 1) + at(best) + at(best + 1);
  const db = 10 * Math.log10(pk / med);
  const topDb = outside.length > 4 ? 10 * Math.log10(med / (outside[outside.length >> 1] || 1e-12)) : NaN;
  return { hz: hz - nom, db, topDb };
}

/** Halves the rate with a 31-tap half-band low pass (16 and 20 MS/s spans to 8 and 10). */
function halve(re: Float32Array, im: Float32Array): [Float32Array, Float32Array] {
  const L = 31, h = new Float32Array(L), c = (L - 1) / 2;
  let s = 0;
  for (let k = 0; k < L; k++) { const t = k - c; const v = t === 0 ? 0.5 : Math.sin(Math.PI * t / 2) / (Math.PI * t); const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * k / (L - 1)) + 0.08 * Math.cos(4 * Math.PI * k / (L - 1)); h[k] = v * w; s += h[k]; }
  for (let k = 0; k < L; k++) h[k] /= s;
  const n = Math.floor((re.length - L) / 2), or = new Float32Array(n), oi = new Float32Array(n);
  for (let m = 0; m < n; m++) {
    let ar = 0, ai = 0; const o = 2 * m;
    for (let k = 0; k < L; k++) { const v = h[k]; if (v === 0) continue; ar += v * re[o + k]; ai += v * im[o + k]; }
    or[m] = ar; oi[m] = ai;
  }
  return [or, oi];
}

/** Receive-filter kernel for the band center at DC (RRC of rate Sr/2), sampled per input sample at NP phases. */
const NP = 256;
const kernels = new Map<number, { K: number; tab: Float32Array }>();
function kernelFor(rate: number): { K: number; tab: Float32Array } {
  const key = Math.round(rate);
  const have = kernels.get(key); if (have) return have;
  const span = 6, Tp = 2 / SR, half = Math.ceil(span * Tp * rate), K = 2 * half;
  const tab = new Float32Array(NP * K);
  for (let p = 0; p < NP; p++) {
    const frac = p / NP; let s = 0;
    for (let k = 0; k < K; k++) {
      const t = frac + half - 1 - k, ts = t / rate, u = ts / Tp;
      const w = Math.abs(t) >= half ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t / half);
      const v = rrc(u, ALPHA) * w; tab[p * K + k] = v; s += v;
    }
    for (let k = 0; k < K; k++) tab[p * K + k] /= s;
  }
  const r = { K, tab }; kernels.set(key, r); return r;
}

export interface BurstState {
  /** Sample clock correction learned on this channel (fraction, +1e-6 = 1 ppm more samples per symbol). */
  eps: number;
  pilotHz: number;
  /** Feedback delays that carried echoes on this channel last time (null: search them all). */
  act?: number[] | null;
  bursts?: number;
}
export interface FieldOut { bytes: Uint8Array; snrDb: number; inverted: boolean; rho: number }
export interface BurstResult {
  ok: boolean; reason: string;
  pilot: PilotInfo | null;
  fields: FieldOut[];
  /** Field syncs found, segment syncs strength (peak over mean). */
  syncs: number; segPeak: number;
  snrDb: number; sliceSnrDb: number;
  /** Equalizer output histogram over -10.5..+10.5 in 168 bins, and a strip of output values for the eye. */
  hist: Uint32Array; eye: Float32Array;
  /** Echo profile from PN511: magnitude (dB re the main path) per half symbol from -32 to +704 symbols. */
  echo: Float32Array; echoStart: number;
  /** Feedback and forward taps as they ended. */
  dfe: Float32Array; ffe: Float32Array;
  eps: number; cpuMs: number; symbols: number;
  /** Milliseconds per stage. */
  profile?: Record<string, number>;
}

const PRE = 8, POST = 20, NFF = 2 * (PRE + POST) + 1, ECHO_PRE = 32, ECHO_POST = 704;

/** Demodulates one burst (signed int8 IQ at `rate`, tuned to the channel center) to trellis-decoded field bytes. */
export function demodBurst(iq: Int8Array, rate: number, st: BurstState): BurstResult {
  const t0 = performance.now();
  const res: BurstResult = { ok: false, reason: '', pilot: null, fields: [], syncs: 0, segPeak: 0, snrDb: NaN, sliceSnrDb: NaN, hist: new Uint32Array(168), eye: new Float32Array(0), echo: new Float32Array(0), echoStart: -ECHO_PRE, dfe: new Float32Array(0), ffe: new Float32Array(0), eps: st.eps, cpuMs: 0, symbols: 0 };
  let n = iq.length >> 1;
  let re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) { re[i] = iq[2 * i] + 0.5; im[i] = iq[2 * i + 1] + 0.5; }
  let R = rate;
  while (R > 12_500_000) { [re, im] = halve(re, im); R /= 2; n = re.length; }
  if (R < 6_400_000) { res.reason = 'rate too low to hold the channel'; return done(); }
  const pilot = findPilot(re, im, R);
  res.pilot = pilot;
  const T: number[] = [performance.now()];
  if (!pilot || pilot.db < 6) { res.reason = 'no pilot'; return done(); }

  st.pilotHz = pilot.hz;

  // pilot phase at ~100 kHz: mix the pilot to DC, average blocks, low pass both ways
  const D = Math.max(8, Math.round(R / 100_000)), nb = Math.floor(n / D);
  const pr = new Float64Array(nb), pi = new Float64Array(nb);
  const fp = -SR / 4 + pilot.hz, w = -2 * Math.PI * fp / R;
  {
    let cr = 1, ci = 0; const dr = Math.cos(w), di = Math.sin(w);
    for (let b = 0; b < nb; b++) {
      let ar = 0, ai = 0;
      for (let k = 0; k < D; k++) {
        const i = b * D + k, x = re[i], y = im[i];
        ar += x * cr - y * ci; ai += x * ci + y * cr;
        const t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t;
      }
      const g = 1 / Math.hypot(cr, ci); cr *= g; ci *= g;
      pr[b] = ar; pi[b] = ai;
    }
    const a = Math.exp(-2 * Math.PI * 2_000 / (R / D));
    for (let pass = 0; pass < 2; pass++) {
      let sr = pr[0], si = pi[0];
      for (let b = 0; b < nb; b++) { sr = a * sr + (1 - a) * pr[b]; si = a * si + (1 - a) * pi[b]; pr[b] = sr; pi[b] = si; }
      sr = pr[nb - 1]; si = pi[nb - 1];
      for (let b = nb - 1; b >= 0; b--) { sr = a * sr + (1 - a) * pr[b]; si = a * si + (1 - a) * pi[b]; pr[b] = sr; pi[b] = si; }
    }
  }
  const ph = new Float64Array(nb);
  for (let b = 0; b < nb; b++) { let p = Math.atan2(pi[b], pr[b]); if (b > 0) { const d = p - ph[b - 1]; p -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); } ph[b] = p; }
  // band center to DC: rotate by the pilot's frequency + Sr/4 and its tracked phase, block by block
  {
    const w0 = -2 * Math.PI * (fp + SR / 4) / R;
    let cr = 1, ci = 0, base = 0;
    for (let b = 0; b < nb; b++) {
      const p0 = ph[b], p1 = b + 1 < nb ? ph[b + 1] : ph[b];
      const th0 = w0 * (b * D + D / 2) - p0, dth = w0 - (p1 - p0) / D;
      cr = Math.cos(th0 - dth * (D / 2)); ci = Math.sin(th0 - dth * (D / 2));
      const dr = Math.cos(dth), di = Math.sin(dth);
      base = b * D;
      for (let k = 0; k < D; k++) {
        const i = base + k, x = re[i], y = im[i];
        re[i] = x * cr - y * ci; im[i] = x * ci + y * cr;
        const t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t;
      }
    }
    for (let i = nb * D; i < n; i++) { re[i] = 0; im[i] = 0; }
  }

  // resample to 2 samples per symbol, the sample clock corrected by eps; re-done once when the segment syncs drift.
  // The segment sync is followed block by block: a jump means samples were lost, and the burst ends there.
  let zr = new Float32Array(0), zi = new Float32Array(0), seg = { pos: 0, peak: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    [zr, zi] = resample(re, im, nb * D, R, st.eps);
    const blk = 32 * SEG2;
    if (zr.length < 3 * blk) { res.reason = 'burst too short'; return done(); }
    const nbk = Math.floor((zr.length - 8) / blk), pos = new Float64Array(nbk), pk = new Float64Array(nbk);
    for (let i = 0; i < nbk; i++) { const g = segSync(zr, i * blk, blk); pos[i] = g.pos; pk[i] = g.peak; }
    // the longest run of blocks whose sync holds still (within 1.5 samples block to block)
    let bestA = 0, bestB = 0;
    for (let a = 0; a < nbk;) {
      if (pk[a] < 4) { a++; continue; }
      let b = a + 1, last = pos[a];
      while (b < nbk && pk[b] >= 4) { let p = pos[b]; p -= SEG2 * Math.round((p - last) / SEG2); if (Math.abs(p - last) > 1.5) break; pos[b] = p; last = p; b++; }
      if (b - a > bestB - bestA) { bestA = a; bestB = b; }
      a = b;
    }
    let peak = Infinity;
    for (let i = bestA; i < bestB; i++) peak = Math.min(peak, pk[i]);
    res.segPeak = Number.isFinite(peak) ? peak : 0;
    if (bestB - bestA < 3) { res.reason = 'no segment sync'; return done(); }
    if (bestA > 0 || bestB < nbk) { zr = zr.subarray(bestA * blk, bestB * blk); zi = zi.subarray(bestA * blk, bestB * blk); }
    seg = { pos: ((pos[bestA] - bestA * blk) % SEG2 + SEG2) % SEG2, peak };
    const end = bestB - bestA; for (let i = 0; i < end; i++) pos[i] = pos[bestA + i];
    const drift = pos[end - 1] - pos[0], span = (end - 1) * blk;
    if (Math.abs(drift) < 0.3 || attempt === 1 || Math.abs(drift / span) > 40e-6) break;
    st.eps += drift / span;
  }
  res.eps = st.eps;
  T.push(performance.now());
  // energy normalization
  {
    let s = 0; const m = Math.min(zr.length, 400_000);
    for (let i = 0; i < m; i++) s += zr[i] * zr[i];
    const g = Math.sqrt(22.6 / (s / m));
    for (let i = 0; i < zr.length; i++) { zr[i] *= g; zi[i] *= g; }
  }
  const c0 = ((Math.round(seg.pos) % SEG2) + SEG2) % SEG2;
  // field syncs: PN511 after the segment sync, on the on-symbol samples
  const nSeg = Math.floor((zr.length - c0 - 2 * 520) / SEG2);
  const rho = new Float32Array(Math.max(0, nSeg));
  for (let s = 0; s < nSeg; s++) {
    const o = c0 + s * SEG2 + 8;
    let c = 0, e = 0;
    for (let k = 0; k < 511; k++) { const v = zr[o + 2 * k]; c += v * PN511[k]; e += v * v; }
    rho[s] = c / Math.sqrt(e * 511 + 1e-9);
  }
  let first = -1;
  for (let s = 0; s < nSeg; s++) if (rho[s] > 0.45 && (s === 0 || rho[s] >= rho[s - 1]) && (s + 1 >= nSeg || rho[s] >= rho[s + 1])) { if (c0 + s * SEG2 >= 2 * POST + 4) { first = s; break; } }
  if (first < 0) { res.reason = 'no field sync'; return done(); }
  const syncs: number[] = [];
  for (let s = first; s < nSeg; s += FIELD_SEGS) syncs.push(s);
  res.syncs = syncs.filter(s => rho[s] > 0.45).length;
  // a field sync found off the 313-segment grid means samples were lost: stop the burst there
  for (let s = first + 1; s < nSeg; s++) if (rho[s] > 0.6 && (s - first) % FIELD_SEGS !== 0) { while (syncs.length && syncs[syncs.length - 1] >= s - FIELD_SEGS + 1) syncs.pop(); break; }
  const start = c0 + first * SEG2;
  const avail = Math.floor((zr.length - start - 2 * PRE - 2) / 2);
  const nFields = Math.min(syncs.length, Math.floor(avail / FIELD_SYMS));
  if (nFields < 1) { res.reason = 'no whole field'; return done(); }
  res.echo = echoProfile(zr, zi, syncs.slice(0, Math.min(4, nFields)).map(s => c0 + s * SEG2));
  T.push(performance.now());
  const inv = syncs.slice(0, nFields).map(s => {
    const o = c0 + s * SEG2 + 8 + 2 * 511; let a = 0, b = 0;
    for (let k = 0; k < 63; k++) { a += zr[o + 2 * k] * PN63[k]; b += zr[o + 2 * (63 + k)] * PN63[k]; }
    return a * b < 0;
  });
  const ydata = new Float32Array(FIELD_DATA_SYMS);
  const full = !st.act || ((st.bursts ?? 0) % 20) === 0;
  st.bursts = (st.bursts ?? 0) + 1;
  const eq = new Equalizer(zr, zi, start, res.echo, nFields * FIELD_SYMS, full ? null : st.act!);
  eq.train(fieldSyncSymbols(inv[0]));
  // the first field twice: once to converge (faster steps), then for real
  T.push(performance.now());
  eq.gear(4);
  eq.runField(0, fieldSyncSymbols(inv[0]), ydata);
  eq.prune();
  st.act = eq.active();
  // after a search over every delay the pruned set converges once more before it counts
  if (full) { eq.restart(); eq.train(fieldSyncSymbols(inv[0])); eq.gear(4); eq.runField(0, fieldSyncSymbols(inv[0]), ydata); }
  eq.gear(1);
  const trellis = new TrellisDecoder();
  let errT = 0, nT = 0, errS = 0, tEq = 0, tTr = 0;
  const eye: number[] = [];
  for (let f = 0; f < nFields; f++) {
    const q0 = performance.now();
    eq.runField(f, fieldSyncSymbols(inv[f]), ydata);
    tEq += performance.now() - q0;
    const q1 = performance.now();
    const bytes = trellis.field(ydata);
    tTr += performance.now() - q1;
    let e = 0, es = 0;
    const lv = trellis.levels;
    for (let i = 0; i < FIELD_DATA_SYMS; i++) {
      const y = ydata[i], d = y - lv[i]; e += d * d;
      const sl = Math.max(-7, Math.min(7, 2 * Math.floor(y / 2) + 1)), ds = y - sl; es += ds * ds;
      const h = Math.floor((y + 10.5) * 8); if (h >= 0 && h < 168) res.hist[h]++;
    }
    if (f === nFields - 1) for (let i = 0; i < 3000; i++) eye.push(ydata[(i * 79) % FIELD_DATA_SYMS]);
    errT += e; errS += es; nT += FIELD_DATA_SYMS;
    res.fields.push({ bytes, snrDb: 10 * Math.log10(21 / (e / FIELD_DATA_SYMS)), inverted: inv[f], rho: rho[syncs[f]] });
  }
  res.snrDb = 10 * Math.log10(21 / (errT / nT));
  res.sliceSnrDb = 10 * Math.log10(21 / (errS / nT));
  res.eye = Float32Array.from(eye);
  res.dfe = eq.dfeTaps(); res.ffe = eq.ffeTaps();
  res.symbols = nFields * FIELD_SYMS;
  res.profile = { front: T[1] - T[0], sync: T[2] - T[1], train: T[3] - T[2], eq: tEq, trellis: tTr, nd: eq.feedback };
  res.ok = true;
  return done();

  function done(): BurstResult { res.cpuMs = performance.now() - t0; return res; }
}

/** 2-sps resampling through the receive filter; the band center is at DC on input and the pilot at DC on output. */
export function resample(re: Float32Array, im: Float32Array, n: number, R: number, eps: number): [Float32Array, Float32Array] {
  const { K, tab } = kernelFor(R), half = K / 2;
  const step = R / (2 * SR) * (1 + eps);
  const m = Math.floor((n - K - 2) / step) - 1;
  const zr = new Float32Array(Math.max(0, m)), zi = new Float32Array(Math.max(0, m));
  const wph = Math.PI / 4 * (1 + eps);
  let tau = half + 1;
  const ph0 = 2 * Math.PI * (SR / 4) * tau / R;
  let cr = Math.cos(ph0), ci = Math.sin(ph0); const dr = Math.cos(wph), di = Math.sin(wph);
  for (let j = 0; j < m; j++, tau += step) {
    let n0 = Math.floor(tau), p = Math.round((tau - n0) * NP);
    if (p === NP) { p = 0; n0++; }
    const base = n0 - half + 1, o = p * K;
    let ar = 0, ai = 0;
    for (let k = 0; k < K; k++) { const h = tab[o + k]; ar += h * re[base + k]; ai += h * im[base + k]; }
    zr[j] = ar * cr - ai * ci; zi[j] = ar * ci + ai * cr;
    const t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t;
    if ((j & 1023) === 1023) { const g = 1 / Math.hypot(cr, ci); cr *= g; ci *= g; }
  }
  return [zr, zi];
}

/** Segment sync (+5 -5 -5 +5) folded over a block: its position mod 1664 samples and peak over mean. */
export function segSync(z: Float32Array, from: number, len: number): { pos: number; peak: number } {
  const acc = new Float64Array(SEG2), segs = Math.floor(len / SEG2);
  for (let s = 0; s < segs; s++) {
    const o = from + s * SEG2;
    for (let k = 0; k < SEG2; k++) { const i = o + k; acc[k] += z[i] - z[i + 2] - z[i + 4] + z[i + 6]; }
  }
  let best = 0, mean = 0;
  for (let k = 0; k < SEG2; k++) { mean += Math.abs(acc[k]); if (acc[k] > acc[best]) best = k; }
  mean /= SEG2;
  const a = acc[(best + SEG2 - 1) % SEG2], b = acc[best], c = acc[(best + 1) % SEG2], den = a - 2 * b + c;
  const d = den !== 0 ? 0.5 * (a - c) / den : 0;
  return { pos: ((from + best + d) % SEG2 + SEG2) % SEG2, peak: b / (mean + 1e-9) };
}

/** Channel echo profile from the PN511 of each field sync: |h| per half symbol, dB re the strongest path. */
function echoProfile(zr: Float32Array, zi: Float32Array, at: number[]): Float32Array {
  const n = 2 * (ECHO_PRE + ECHO_POST), out = new Float32Array(n), pw = new Float64Array(n);
  for (const s of at) {
    const o = s + 8;
    for (let d = 0; d < n; d++) {
      const off = o + d - 2 * ECHO_PRE;
      if (off < 0 || off + 1022 >= zr.length) continue;
      let a = 0, b = 0;
      for (let k = 0; k < 511; k++) { const p = PN511[k]; a += p * zr[off + 2 * k]; b += p * zi[off + 2 * k]; }
      pw[d] += a * a + b * b;
    }
  }
  let mx = 1e-12;
  for (let d = 0; d < n; d++) if (pw[d] > mx) mx = pw[d];
  for (let d = 0; d < n; d++) out[d] = 10 * Math.log10(pw[d] / mx + 1e-9);
  return out;
}

/** The equalizer: FFE on the complex 2-sps samples (real output), a bias tap and a decision-feedback section. */
class Equalizer {
  private readonly a = new Float32Array(NFF); private readonly b = new Float32Array(NFF); private bias = 1.25;
  private readonly f: Float32Array; private readonly nd = ECHO_POST;
  /** The feedback delays in use (a sparse set around the echoes). */
  private act: Int32Array;
  /** Decisions (or known symbols) by symbol index, offset by nd + 1. */
  private readonly dec: Int8Array;
  private mu: number; private muF = 0; private readonly mu0: number; private muF0 = 0;
  constructor(private readonly zr: Float32Array, private readonly zi: Float32Array, private readonly start: number, echo: Float32Array, total: number, known: number[] | null) {
    this.f = new Float32Array(this.nd + 1);
    this.dec = new Int8Array(total + this.nd + 2);
    this.mu = this.mu0 = 0.004 / (NFF * 22);
    // feedback delays to start with: wherever the PN511 echo profile stands 7 dB over its own floor
    const tail: number[] = [];
    for (let d = 2 * (ECHO_PRE + 40); d < echo.length; d++) tail.push(echo[d]);
    tail.sort((x, y) => x - y);
    const floor = tail.length ? tail[tail.length >> 1] : -30, want = new Uint8Array(this.nd + 1);
    for (let d = 1; d <= 24; d++) want[d] = 1;
    if (known) for (const d of known) want[d] = 1; else want.fill(1, 1);
    for (let i = 2 * ECHO_PRE; i < echo.length; i++) if (echo[i] > floor + 6) { const c = Math.round((i - 2 * ECHO_PRE) / 2); for (let d = c - 6; d <= c + 6; d++) if (d >= 1 && d <= this.nd) want[d] = 1; }
    this.act = this.use(want);
  }
  private use(want: Uint8Array): Int32Array {
    const a: number[] = [];
    for (let d = 1; d <= this.nd; d++) if (want[d]) a.push(d); else this.f[d] = 0;
    this.muF = this.muF0 = 0.03 / (21 * Math.max(16, a.length));
    return Int32Array.from(a);
  }
  /** After convergence: keep the feedback taps that matter, with a few neighbors each. */
  prune(): void {
    const mags = Array.from(this.act, d => Math.abs(this.f[d])).sort((x, y) => x - y);
    const thr = Math.max(0.012, 4 * (mags[mags.length >> 1] ?? 0)), want = new Uint8Array(this.nd + 1);
    for (let d = 1; d <= 20; d++) want[d] = 1;
    for (const d of this.act) if (Math.abs(this.f[d]) > thr) for (let k = d - 8; k <= d + 8; k++) if (k >= 1 && k <= this.nd) want[k] = 1;
    this.act = this.use(want);
  }
  get feedback(): number { return this.act.length; }
  /** Feedback taps back to zero (the forward taps keep what they learned). */
  restart(): void { this.f.fill(0); }
  active(): number[] { return Array.from(this.act); }
  /** Step sizes as a multiple of the tracking ones. */
  gear(x: number): void { this.mu = this.mu0 * x; this.muF = this.muF0 * x; }
  ffeTaps(): Float32Array { const o = new Float32Array(NFF); for (let j = 0; j < NFF; j++) o[j] = Math.hypot(this.a[j], this.b[j]); return o; }
  dfeTaps(): Float32Array { return this.f.slice(1); }
  /** Least squares on the known symbols of the first field (field sync and every segment sync). */
  train(fs: Float32Array): void {
    const rows: number[] = [], dv: number[] = [];
    for (let k = 0; k < FIELD_SYMS; k++) {
      if (k < 728) { rows.push(k); dv.push(fs[k]); }
      else if (k >= SEG && k % SEG < 4) { rows.push(k); dv.push(k % SEG === 0 || k % SEG === 3 ? 5 : -5); }
    }
    const P = 2 * NFF + 1, A = new Float64Array(P * P), rhs = new Float64Array(P), x = new Float64Array(P);
    for (let r = 0; r < rows.length; r++) {
      const c = this.start + 2 * rows[r] + 2 * PRE;
      for (let j = 0; j < NFF; j++) { x[j] = this.zr[c - j]; x[NFF + j] = this.zi[c - j]; }
      x[P - 1] = 1;
      for (let p = 0; p < P; p++) { const xp = x[p]; rhs[p] += xp * dv[r]; const o = p * P; for (let q = p; q < P; q++) A[o + q] += xp * x[q]; }
    }
    let tr = 0;
    for (let p = 0; p < P; p++) { for (let q = 0; q < p; q++) A[p * P + q] = A[q * P + p]; tr += A[p * P + p]; }
    for (let p = 0; p < P; p++) A[p * P + p] += 1e-3 * tr / P;
    const sol = solve(A, rhs, P);
    if (!sol) return;
    for (let j = 0; j < NFF; j++) { this.a[j] = sol[j]; this.b[j] = sol[NFF + j]; }
    this.bias = sol[P - 1];
  }
  /** Equalizes field f (symbols from its field sync), writing its 312 x 828 data symbols into `out`. */
  runField(f: number, fs: Float32Array, out: Float32Array): void {
    const zr = this.zr, zi = this.zi, a = this.a, b = this.b, fb = this.f, act = this.act, na = act.length, dec = this.dec, off = this.nd + 1;
    const mu = this.mu, muF = this.muF, k0 = f * FIELD_SYMS;
    let o = 0;
    for (let p = 0; p < FIELD_SYMS; p++) {
      const k = k0 + p, c = this.start + 2 * k + 2 * PRE, q = k + off;
      let y = this.bias;
      for (let j = 0; j < NFF; j++) y += a[j] * zr[c - j] + b[j] * zi[c - j];
      for (let t = 0; t < na; t++) { const d = act[t]; y -= fb[d] * dec[q - d]; }
      let want: number;
      const seg = (p / SEG) | 0, sp = p - seg * SEG;
      if (p < 728) want = fs[p];
      else if (seg > 0 && sp < 4) want = sp === 0 || sp === 3 ? 5 : -5;
      else { want = 2 * Math.floor(y / 2) + 1; if (want > 7) want = 7; else if (want < -7) want = -7; }
      if (seg > 0 && sp >= 4) out[o++] = y;
      dec[q] = want;
      const e = want - y, me = mu * e;
      for (let j = 0; j < NFF; j++) { a[j] += me * zr[c - j]; b[j] += me * zi[c - j]; }
      this.bias += 0.0005 * e;
      if ((p & 1) === 0) { const mf = muF * e; for (let t = 0; t < na; t++) { const d = act[t]; fb[d] -= mf * dec[q - d]; } }
    }
  }
}

function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  // Cholesky
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0) return null; L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
