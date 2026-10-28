/**
 * HD Radio detector, fed from a transmit-side model of the FM hybrid signal.
 *
 * The model is built from the standard's numbers, not from the detector: 2048-point OFDM symbols at 363.373 Hz
 * subcarrier spacing with a 112-sample cyclic prefix (here at twice the reference rate, so 4096 points and a
 * 224-sample prefix, which keeps the spacing), random QPSK on the primary-main subcarriers 356..545 either side,
 * about 20 dB under an analog FM carrier swinging ±75 kHz with a 1 kHz tone, plus Gaussian noise. Everything the
 * detector claims — sidebands over the reference, a cyclic-prefix lock, the carrier error — is checked against a
 * signal that has them, and against ones that do not.
 */
import { HdDetector } from '../dist/dsp/hdradio.js';
import { fft } from '../dist/fft.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };

console.log('HD Radio: sideband detection and cyclic-prefix lock from a transmit-side model');

const RATE = 1_488_375;                       // twice the reference rate: 4096-point symbols keep the 363.373 Hz spacing
const N = 4096, CP = 224, SYM = N + CP;
const rng = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (u) => () => { const a = u() || 1e-12, b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };

/** Complex baseband: analog FM carrier (unit amplitude) with optional OFDM sidebands and noise, as int8 IQ at RATE. */
function hybrid({ symbols = 300, digital = true, dbc = -20, noise = 0.02, cfoHz = 0, seed = 1, amp = 60 } = {}) {
  const u = rng(seed), g = gauss(u);
  const total = symbols * SYM;
  const re = new Float32Array(total), im = new Float32Array(total);
  // analog: FM, 1 kHz tone at ±75 kHz deviation
  let ph = 0;
  for (let k = 0; k < total; k++) { const t = k / RATE; ph += 2 * Math.PI * (75_000 * Math.sin(2 * Math.PI * 1000 * t)) / RATE; re[k] = Math.cos(ph); im[k] = Math.sin(ph); }
  if (digital) {
    // per-subcarrier amplitude so the whole digital signal sits `dbc` under the unit carrier: 380 subcarriers
    const subs = []; for (let k = 356; k <= 545; k++) { subs.push(k); subs.push(-k); }
    const a = Math.sqrt(Math.pow(10, dbc / 10) / subs.length);
    const X = new Float32Array(N), Y = new Float32Array(N);
    for (let s = 0; s < symbols; s++) {
      X.fill(0); Y.fill(0);
      for (const k of subs) { const i = (k + N) % N; const q = Math.floor(u() * 4); X[i] = a * (q & 1 ? -1 : 1); Y[i] = a * (q & 2 ? -1 : 1); }
      // inverse transform via the forward one: conj(fft(conj(X))) is N·ifft(X), whose mean power per sample is
      // the sum of the subcarrier powers (Parseval) — 380 · a², i.e. exactly `dbc` under the unit carrier
      for (let i = 0; i < N; i++) Y[i] = -Y[i];
      fft(X, Y);
      for (let i = 0; i < N; i++) Y[i] = -Y[i];
      const base = s * SYM;
      for (let i = 0; i < CP; i++) { re[base + i] += X[N - CP + i]; im[base + i] += Y[N - CP + i]; }
      for (let i = 0; i < N; i++) { re[base + CP + i] += X[i]; im[base + CP + i] += Y[i]; }
    }
  }
  if (cfoHz) { let p = 0; const w = 2 * Math.PI * cfoHz / RATE; for (let k = 0; k < total; k++) { const c = Math.cos(p), s = Math.sin(p); const r = re[k] * c - im[k] * s; im[k] = re[k] * s + im[k] * c; re[k] = r; p += w; } }
  const iq = new Int8Array(2 * total);
  for (let k = 0; k < total; k++) {
    const r = amp * (re[k] + noise * g()), i = amp * (im[k] + noise * g());
    iq[2 * k] = Math.max(-127, Math.min(127, Math.round(r))); iq[2 * k + 1] = Math.max(-127, Math.min(127, Math.round(i)));
  }
  return iq;
}

function run(iq, offsetHz = 0) {
  const reports = [];
  const det = new HdDetector(r => reports.push(r));
  const chunk = 65536;
  for (let at = 0; at + 2 <= iq.length; at += chunk) det.push(iq.subarray(at, Math.min(iq.length, at + chunk)), Math.min(chunk, iq.length - at) >> 1, RATE, offsetHz);
  return reports;
}
const last = (rs) => rs[rs.length - 1];
const fmt = (r) => `snr ${r.snrDb.toFixed(1)} dB · lock ${r.lock.toFixed(2)} (lo ${r.lockLo.toFixed(2)} hi ${r.lockHi.toFixed(2)}) · cfo ${r.cfoHz.toFixed(0)} Hz · analog ${r.analogDb.toFixed(1)} sb ${r.sbLoDb.toFixed(1)}/${r.sbHiDb.toFixed(1)} ref ${r.refDb.toFixed(1)} · ${r.symbols} sym`;

// ---- A hybrid station ----
{
  const rs = run(hybrid());
  ok(rs.length >= 1, 'the detector reported', `${rs.length} reports`);
  const r = last(rs);
  ok(r.present, 'a hybrid station is detected', fmt(r));
  ok(r.snrDb > 10, 'its sidebands stand well over the reference noise', fmt(r));
  ok(r.lock > 1.5, 'the cyclic prefix locks', fmt(r));
  ok(r.lockLo > 1.3 && r.lockHi > 1.3, 'both sidebands lock', fmt(r));
  ok(Math.abs(r.cfoHz) < 40, 'no carrier error is measured on a centered station', fmt(r));
  ok(r.analogDb > r.sbHiDb + 10, 'the analog carrier is the strongest thing there (premise)', fmt(r));
  ok(r.symbols > 100, 'a few hundred symbols were folded', fmt(r));
}

// ---- Analog only: the same carrier with no sidebands ----
{
  const r = last(run(hybrid({ digital: false, seed: 2 })));
  ok(!r.present, 'an analog-only station is not called HD', fmt(r));
  ok(r.lock < 1.3, 'nothing locks without sidebands', fmt(r));
  ok(r.snrDb < 3, 'sideband region sits at the reference noise', fmt(r));
}

// ---- Noise only ----
{
  const u = rng(9), g = gauss(u), total = 300 * SYM, iq = new Int8Array(2 * total);
  for (let k = 0; k < 2 * total; k++) iq[k] = Math.max(-127, Math.min(127, Math.round(6 * g())));
  const r = last(run(iq));
  ok(!r.present, 'noise alone is not called HD', fmt(r));
  ok(r.lock < 1.3, 'noise folds flat', fmt(r));
}

// ---- Carrier error and an off-center channel ----
{
  const r = last(run(hybrid({ cfoHz: 120, seed: 3 })));
  ok(r.present, 'a station 120 Hz off is still detected', fmt(r));
  ok(Math.abs(r.cfoHz - 120) < 40, 'and its carrier error is measured', fmt(r));
  // The prefix resolves the error only modulo one subcarrier spacing (363.4 Hz): 250 Hz reads as 250 − 363.
  const w = last(run(hybrid({ cfoHz: 250, seed: 7 })));
  ok(Math.abs(w.cfoHz - (250 - 744187.5 / 2048)) < 40, 'an error past half a spacing wraps: the prefix can only tell the fractional part', fmt(w));
  // The same station sitting 300 kHz above the span center, with the offset told to the detector.
  const iq = hybrid({ seed: 4 });
  const shifted = new Int8Array(iq.length);
  let p = 0; const wo = 2 * Math.PI * 300_000 / RATE;
  for (let k = 0; k < iq.length / 2; k++) { const c = Math.cos(p), s = Math.sin(p); shifted[2 * k] = Math.round(iq[2 * k] * c - iq[2 * k + 1] * s); shifted[2 * k + 1] = Math.round(iq[2 * k] * s + iq[2 * k + 1] * c); p += wo; }
  const o = last(run(shifted, 300_000));
  ok(o.present, 'a station 300 kHz up the span is detected when the offset is given', fmt(o));
  ok(Math.abs(o.cfoHz) < 60, 'with no spurious carrier error', fmt(o));
}

// ---- Weak digital: sidebands 30 dB down, more noise ----
{
  const r = last(run(hybrid({ dbc: -30, noise: 0.05, seed: 5 })));
  ok(r.lock > 1.2 || r.snrDb > 3, 'a weak digital signal still shows something', fmt(r));
}

// ---- Reset ----
{
  const det = new HdDetector(() => {});
  const iq = hybrid({ symbols: 120, seed: 6 });
  det.push(iq, iq.length >> 1, RATE, 0);
  det.reset();
  ok(det.state === null, 'reset forgets the last report');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
