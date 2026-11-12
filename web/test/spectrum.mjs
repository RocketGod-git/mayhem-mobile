// Spectrum: RBW / VBW, the FFT's level scale, trace math, marker peak search, channel power, occupied bandwidth,
// ACPR, noise floor, the sweep's stitching and zero span (filter, trigger, pulse measurements), all on synthetic
// signals made here with a fixed PRNG (mulberry32) so every run, and every port, sees the same samples.
import * as S from '../dist/dsp/spectrum/index.js';

let checks = 0, failed = 0;
const ok = (cond, what) => { checks++; if (!cond) { failed++; console.log('  FAIL ' + what); } };
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(rnd) { const u = Math.max(1e-12, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** n samples (float, int8 counts): tones [{f (cycles/sample), a (counts), ph}] plus complex noise of `sigma` per rail. */
function signal(n, tones, sigma, rnd, start = 0) {
  const i = new Float32Array(n), q = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let x = 0, y = 0;
    for (const t of tones) { const p = 2 * Math.PI * t.f * (k + start) + (t.ph ?? 0); x += t.a * Math.cos(p); y += t.a * Math.sin(p); }
    if (sigma) { x += sigma * gauss(rnd); y += sigma * gauss(rnd); }
    i[k] = x; q[k] = y;
  }
  return { i, q };
}
/** The same as signed int8, rounded and clipped (what a radio delivers). */
function int8(sig) {
  const out = new Int8Array(sig.i.length * 2);
  for (let k = 0; k < sig.i.length; k++) { out[2 * k] = Math.max(-128, Math.min(127, Math.round(sig.i[k]))); out[2 * k + 1] = Math.max(-128, Math.min(127, Math.round(sig.q[k]))); }
  return out;
}
const dbfs = (a) => 20 * Math.log10(a / 128);

// ---- RBW ----------------------------------------------------------------------------------------------------
near(S.enbwBins('HANN'), 1.5, 1e-3, 'Hann ENBW is 1.5 bins');
near(S.enbwBins('FLATTOP'), 3.77, 0.01, 'flat-top ENBW is 3.77 bins');
ok(S.fftSizeFor(2e6, 3000, 'HANN') === 1024, 'RBW 3 kHz at 2 Msps picks 1024 points');
near(S.rbwOf(2e6, 1024, 'HANN'), 2929.7, 0.1, 'and reports the RBW it really has');
ok(S.fftSizeFor(2e6, 1, 'HANN') === S.MAX_FFT, 'an RBW finer than the longest FFT is clamped to it');
ok(S.fftSizeFor(2e6, 1e6, 'HANN') === S.MIN_FFT, 'an RBW wider than the shortest FFT is clamped to it');
ok(S.autoRbw(2e6) === 3000, 'auto RBW for a 2 MHz span is 3 kHz');
ok(S.autoRbw(100e6) === 100000, 'auto RBW for a 100 MHz span is 100 kHz');
ok(S.stepBw(3000, 1) === 10000 && S.stepBw(3000, -1) === 1000 && S.stepBw(2900, 1) === 10000, 'RBW steps go 1-3-10');

// A tone's level reads true at a bin center (both windows) and, with the flat top, between bins too.
{
  const n = 1024, a = 100;
  for (const kind of ['HANN', 'FLATTOP']) {
    const e = new S.FftEngine(n, kind, 2e6, 1e9, false);
    const s = signal(n, [{ f: 100 / n, a }], 0, null);
    e.pushFloat(s.i, s.q);
    const t = e.take();
    near(t.live[n / 2 + 100], dbfs(a), 0.01, `${kind}: a tone on a bin center reads its level`);
  }
  const e = new S.FftEngine(n, 'FLATTOP', 2e6, 1e9, false);
  const s = signal(n, [{ f: 100.5 / n, a }], 0, null);
  e.pushFloat(s.i, s.q);
  const t = e.take();
  near(Math.max(t.live[n / 2 + 100], t.live[n / 2 + 101]), dbfs(a), 0.05, 'FLATTOP: a tone between bins still reads its level');
  const h = new S.FftEngine(n, 'HANN', 2e6, 1e9, false);
  h.pushFloat(s.i, s.q);
  const th = h.take();
  near(Math.max(th.live[n / 2 + 100], th.live[n / 2 + 101]) - dbfs(a), -1.42, 0.05, 'HANN: between bins it scallops by 1.42 dB');
}

// Two tones 3 RBW apart are resolved (a deep dip between them); half an RBW apart they are one lump.
{
  const n = 4096, rate = 2e6, kind = 'HANN';
  const rbw = S.rbwOf(rate, n, kind), binHz = rate / n;
  const dip = (sepHz) => {
    const e = new S.FftEngine(n, kind, rate, 1e9, false);
    const f1 = 200 * binHz, f2 = f1 + sepHz;
    const s = signal(n, [{ f: f1 / rate, a: 60 }, { f: f2 / rate, a: 60 }], 0, null);
    e.pushFloat(s.i, s.q);
    const y = e.take().live;
    const b1 = n / 2 + Math.round(f1 / binHz), b2 = n / 2 + Math.round(f2 / binHz);
    let lo = Infinity; for (let k = b1; k <= b2; k++) lo = Math.min(lo, y[k]);
    return Math.min(y[b1], y[b2]) - lo;
  };
  ok(dip(3 * rbw) > 6, `tones 3 RBW apart are resolved (dip ${dip(3 * rbw).toFixed(1)} dB)`);
  ok(dip(0.5 * rbw) < 1, `tones half an RBW apart are not (dip ${dip(0.5 * rbw).toFixed(2)} dB)`);
}

// Noise reads its density: each bin holds total power × RBW / rate.
{
  const n = 2048, rate = 2e6, sigma = 8, rnd = mulberry32(1);
  const e = new S.FftEngine(n, 'HANN', rate, 1e9, false);
  const tr = new S.Trace('AVG', 64);
  for (let f = 0; f < 64; f++) { const s = signal(n, [], sigma, rnd); e.pushFloat(s.i, s.q); const t = e.take(); tr.update(t.live, t.max, t.min, 0, rate / n); }
  const total = 2 * sigma * sigma / (128 * 128);
  const nf = S.noiseFloor(tr.data, e.rbwHz);
  near(nf.floor, 10 * Math.log10(total * e.rbwHz / rate), 0.4, 'noise floor per RBW');
  near(nf.density, 10 * Math.log10(total / rate), 0.4, 'noise density per hertz');
  near(S.noiseAt(tr.data, n / 2, e.rbwHz, 64), 10 * Math.log10(total / rate), 0.6, 'noise density at a marker');
  near(S.channelPower(tr.data, -rate / 2, rate / n, e.rbwHz, 0, rate / 2), 10 * Math.log10(total / 2), 0.4, 'channel power of noise over half the band');
}

// ---- VBW ----------------------------------------------------------------------------------------------------
{
  ok(S.videoAlpha(3000, 1024 / 2e6) > 0.99, 'a VBW equal to the RBW passes every frame');
  near(S.videoAlpha(0, 1), 0, 1e-12, 'a VBW of zero holds');
  const spread = (vbw) => {
    const n = 512, rate = 2e6, rnd = mulberry32(7);
    const e = new S.FftEngine(n, 'HANN', rate, vbw, false);
    const vals = [];
    for (let f = 0; f < 400; f++) { const s = signal(n, [], 8, rnd); e.pushFloat(s.i, s.q); if (f >= 200) vals.push(e.take().live[100]); }
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
  };
  const wide = spread(1e6), narrow = spread(30);
  ok(wide > 4, `with VBW ≥ RBW a noise bin swings by ${wide.toFixed(1)} dB`);
  ok(narrow < wide / 4, `a VBW 200x narrower settles it (${narrow.toFixed(2)} dB)`);
}
// The video filter tracks max and min between takes.
{
  const e = new S.FftEngine(256, 'HANN', 2e6, 1e9, false);
  const loud = signal(256, [{ f: 20 / 256, a: 100 }], 0, null), quiet = signal(256, [{ f: 20 / 256, a: 10 }], 0, null);
  e.pushFloat(loud.i, loud.q); e.pushFloat(quiet.i, quiet.q);
  const t = e.take();
  near(t.max[128 + 20], dbfs(100), 0.05, 'the frame max between takes keeps the loud frame');
  near(t.min[128 + 20], dbfs(10), 0.05, 'the frame min keeps the quiet one');
  near(t.live[128 + 20], dbfs(10), 0.05, 'live is the latest frame');
  ok(t.frames === 2, 'take counts the frames it folded');
}
// The DC patch lays the DC spike on a line.
{
  const p = Float32Array.from([1, 1, 1, 9, 9, 9, 9, 9, 3, 3, 3]);
  S.patchDc(p, 5, 2);
  ok(Math.abs(p[5] - 2) < 1e-6 && p[8] === 3 && p[2] === 1, 'patchDc interpolates across the center bins');
}
// Int8 reads go through the same path as float frames, and the budget skips frames above it.
{
  const rate = 20e6, n = 1024;
  const e = new S.FftEngine(n, 'HANN', rate, 1e9, false);
  ok(e.skip === Math.ceil(rate / S.FFT_BUDGET) - 1, 'frames are skipped above the FFT budget');
  const iq = int8(signal(32768, [{ f: 64 / n, a: 90 }], 0, null));
  const done = e.push(iq);
  ok(done === Math.floor(32768 / (n * (1 + e.skip))) || done === Math.ceil(32768 / (n * (1 + e.skip))), `an int8 read gives its frames (${done})`);
  near(e.take().live[n / 2 + 64], dbfs(90), 0.1, 'and reads the tone level');
}

// ---- traces -------------------------------------------------------------------------------------------------
{
  const f = (vals) => Float32Array.from(vals);
  const live = new S.Trace('LIVE'), mx = new S.Trace('MAX'), mn = new S.Trace('MIN'), av = new S.Trace('AVG', 2), view = new S.Trace('LIVE');
  const frames = [[-50, -40, -30], [-45, -60, -35], [-55, -42, -20]];
  for (const fr of frames) for (const t of [live, mx, mn, av, view]) t.update(f(fr), null, null, 100, 10);
  ok(live.data.join() === '-55,-42,-20', 'LIVE shows the last frame');
  ok(mx.data.join() === '-45,-40,-20', 'MAX HOLD keeps each bin\'s highest');
  ok(mn.data.join() === '-55,-60,-35', 'MIN HOLD keeps each bin\'s lowest');
  // AVG 2: (−50, −45) mean in power, then exponential with weight 1/2
  const p = (d) => 10 ** (d / 10);
  const expect0 = 10 * Math.log10(((p(-50) + p(-45)) / 2 + p(-55)) / 2);
  near(av.data[0], expect0, 1e-3, 'AVG (N) power-averages, running mean then 1/N');
  view.setMode('VIEW');
  view.update(f([0, 0, 0]), null, null, 100, 10);
  ok(view.data.join() === '-55,-42,-20', 'VIEW freezes the trace');
  mx.update(f([-50, -50, -50]), f([-10, -50, -50]), null, 100, 10);
  ok(mx.data[0] === -10, 'MAX HOLD takes the frame max, not just the frame');
  mx.clear(); ok(mx.data === null && mx.count === 0, 'a trace clears');
  mn.update(f([1, 2]), null, null, 100, 10);
  ok(mn.data.length === 2 && mn.count === 1, 'a new bin layout starts the trace over');
  const off = new S.Trace('OFF'); off.update(f([1]), null, null, 0, 1); ok(off.data === null, 'OFF draws nothing');
  ok(S.defaultTraces().map(t => t.mode).join() === 'LIVE,MAX,OFF,OFF', 'four traces: live, max hold, two off');
  const y = f([-10, -80, -80, -80, -20, -20, -20, -20]);
  ok(S.toColumns(y, 2, 'PEAK').join() === '-10,-20', 'PEAK detector keeps the highest bin per column');
  ok(S.toColumns(y, 2, 'SAMPLE').join() === '-80,-20', 'SAMPLE detector takes the middle bin');
  near(S.toColumns(y, 2, 'RMS')[0], 10 * Math.log10((p(-10) + 3 * p(-80)) / 4), 1e-3, 'RMS detector power-averages');
  ok(S.toColumns(f([-1, -2]), 4, 'PEAK').join() === '-1,-1,-2,-2', 'fewer bins than columns repeats them');
}

// ---- markers ------------------------------------------------------------------------------------------------
{
  // a trace with peaks at 100 (-20), 300 (-35), 600 (-10), 800 (-50), a 3 dB ripple everywhere, on a -90 floor
  const n = 1000, rnd = mulberry32(3);
  const y = new Float32Array(n);
  const pk = [[100, -20], [300, -35], [600, -10], [800, -50]];
  for (let i = 0; i < n; i++) {
    let v = -90 + 3 * rnd();
    for (const [c, l] of pk) v = Math.max(v, l - 0.05 * (i - c) ** 2);
    y[i] = v;
  }
  const peaks = S.findPeaks(y);
  ok(peaks.join() === '100,300,600,800', `peaks at the four signals only, not the ripple (${peaks.slice(0, 8).join()})`);
  ok(S.peakSearch(y) === 600, 'PEAK finds the highest');
  ok(S.nextPeak(y, 600) === 100 && S.nextPeak(y, 100) === 300 && S.nextPeak(y, 300) === 800, 'NEXT PEAK walks down in level');
  ok(S.nextPeak(y, 800) === 800, 'NEXT PEAK stays on the lowest');
  ok(S.nextPeakRight(y, 300) === 600 && S.nextPeakLeft(y, 300) === 100, 'NEXT RIGHT / LEFT go to the neighbors');
  ok(S.nextPeakLeft(y, 100) === 100 && S.nextPeakRight(y, 800) === 800, 'and stay put at the ends');
  ok(S.findPeaks(y, 6, -30).join() === '100,600', 'the peak threshold drops peaks under it');
  ok(S.findPeaks(y, 50).join() === '100,300,600', 'a 50 dB excursion drops the peak that rises only 40 dB');
  ok(S.peakSearch(Float32Array.from([1, 2, 3, 4])) === 3, 'with no peak, PEAK takes the highest bin');
  ok(S.findPeaks(Float32Array.from([0, 10, 10, 10, 0])).join() === '1', 'a flat top is one peak');
  // a tone between bins: the parabola finds its frequency to a fraction of a bin
  const nn = 2048, e = new S.FftEngine(nn, 'HANN', 2e6, 1e9, false);
  const s = signal(nn, [{ f: 300.3 / nn, a: 50 }], 0, null);
  e.pushFloat(s.i, s.q);
  const t = e.take().live;
  const i = S.peakSearch(t), r = S.refinePeak(t, i);
  near(i - nn / 2 + r.offset, 300.3, 0.05, 'refinePeak puts the tone within 0.05 bin');
  near(r.level, dbfs(50), 0.6, 'and its level within the scallop');
  ok(S.binOf(1005, 1000, 10, 50) === 1 && S.binOf(-1e9, 0, 1, 10) === 0 && S.binOf(1e9, 0, 1, 10) === 9, 'binOf rounds and clamps');
  ok(S.defaultMarkers().length === 4 && S.defaultMarkers().every(m => !m.on), 'four markers, all off');
}

// ---- channel power, OBW, ACPR -------------------------------------------------------------------------------
{
  const n = 4096, rate = 2e6, binHz = rate / n;
  for (const kind of ['HANN', 'FLATTOP']) {
    const e = new S.FftEngine(n, kind, rate, 1e9, false);
    const s = signal(n, [{ f: 123.37 * binHz / rate, a: 64 }], 0, null);
    e.pushFloat(s.i, s.q);
    const y = e.take().live, f0 = -rate / 2;
    near(S.channelPower(y, f0, binHz, e.rbwHz, 123.37 * binHz, 20 * e.rbwHz), dbfs(64), 0.05, `${kind}: channel power of a tone is the tone`);
  }
  // a flat block of power 100 kHz wide: 99 % OBW is 99 kHz, and its channel power is its total
  const y = new Float32Array(n), f0 = -rate / 2;
  const lo = 200_000, hi = 300_000;
  for (let i = 0; i < n; i++) { const f = f0 + i * binHz; y[i] = f >= lo && f < hi ? -40 : -160; }
  const o = S.occupiedBw(y, f0, binHz, 1.5 * binHz);
  near(o.bw, 99_000, binHz, 'OBW of a flat 100 kHz block is 99 kHz');
  near((o.lo + o.hi) / 2, 250_000 - binHz / 2, binHz, 'centered on the block');
  const inBlock = Math.round(100_000 / binHz);
  near(S.channelPower(y, f0, binHz, 1.5 * binHz, 250_000 - binHz / 2, 100_000), -40 + 10 * Math.log10(inBlock / 1.5), 0.1, 'channel power of the block');
  near(S.occupiedBw(y, f0, binHz, 1.5 * binHz, 90).bw, 90_000, binHz, 'OBW at 90 % is 90 kHz');
  // an FFT'd noise channel: OBW ≈ 99 % of the band it fills
  const rnd = mulberry32(11), e = new S.FftEngine(n, 'HANN', rate, 1e9, false), tr = new S.Trace('AVG', 32);
  const band = 0.25;   // noise filling ±0.125 of the rate: a moving average of white noise is not flat, so use FFT shaping
  for (let k = 0; k < 32; k++) {
    // shape noise in the frequency domain: random phase, flat magnitude inside the band
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let b = 0; b < n; b++) { const fb = (b < n / 2 ? b : b - n) / n; if (Math.abs(fb) < band / 2) { const ph = 2 * Math.PI * rnd(); re[b] = Math.cos(ph); im[b] = Math.sin(ph); } }
    // inverse DFT via conjugate trick using the engine's FFT is not exported; do a direct inverse for this small case
    const xi = new Float32Array(n), xq = new Float32Array(n);
    ifft(re, im); for (let b = 0; b < n; b++) { xi[b] = re[b] * 2000; xq[b] = im[b] * 2000; }
    e.pushFloat(xi, xq); const t = e.take(); tr.update(t.live, null, null, f0, binHz);
  }
  const ob = S.occupiedBw(tr.data, f0, binHz, e.rbwHz);
  near(ob.bw, 0.99 * band * rate, 3 * e.rbwHz, `OBW of a noise channel filling ${band * rate / 1e3} kHz`);
  // ACPR: a main channel tone with neighbors 30 dB down, 100 kHz away
  const ea = new S.FftEngine(n, 'HANN', rate, 1e9, false);
  const sa = signal(n, [{ f: 100 * binHz / rate, a: 100 }, { f: (100 * binHz - 100_000) / rate, a: 100 / 31.62 }, { f: (100 * binHz + 100_000) / rate, a: 100 / 31.62 }], 0, null);
  ea.pushFloat(sa.i, sa.q);
  const ya = ea.take().live;
  const r = S.acpr(ya, f0, binHz, ea.rbwHz, 100 * binHz, 25_000, 100_000);
  near(r.lowerDbc, -30, 0.2, 'ACPR lower neighbor −30 dBc');
  near(r.upperDbc, -30, 0.2, 'ACPR upper neighbor −30 dBc');
  near(r.main, dbfs(100), 0.1, 'ACPR main channel power');
}
function ifft(re, im) {
  // inverse FFT by conjugation, radix-2 in place
  const n = re.length;
  for (let k = 0; k < n; k++) im[k] = -im[k];
  let j = 0;
  for (let i = 1; i < n; i++) { let bit = n >> 1; while (j & bit) { j ^= bit; bit >>= 1; } j |= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const cr = Math.cos(ang * k), ci = Math.sin(ang * k), a = i + k, b = a + len / 2;
      const tr = cr * re[b] - ci * im[b], ti = cr * im[b] + ci * re[b];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let k = 0; k < n; k++) { re[k] /= n; im[k] = -im[k] / n; }
}

// ---- calibration and span plans -----------------------------------------------------------------------------
{
  const g = { kind: 'hackrf', pro: false, lna: 32, vga: 20, amp: true, tunerDb: NaN };
  near(S.dbmOffset(g).offset, -10 - 66, 1e-9, 'HackRF dBm offset follows LNA + VGA + amp');
  near(S.dbmOffset({ ...g, pro: true }).offset - S.dbmOffset(g).offset, S.HACKRF_PRO_DB, 1e-9, 'a Pro is offset by its own figure at the same settings');
  near(S.dbmOffset(g, 3).offset - S.dbmOffset(g).offset, 3, 1e-9, 'the CAL trim adds');
  near(S.dbmOffset({ kind: 'rtlsdr', pro: false, lna: 0, vga: 0, amp: false, tunerDb: 29.7 }).offset, -5 - 29.7, 1e-9, 'RTL-SDR offset follows the tuner gain');
  ok(!S.dbmOffset({ kind: 'rtlsdr', pro: false, lna: 0, vga: 0, amp: false, tunerDb: NaN }).ok, 'the tuner AGC leaves the scale uncalibrated');
  const rates = [20e6, 10e6, 8e6, 4e6, 2e6];
  const p1 = S.planSpan(433.42e6, 434.42e6, rates);
  ok(p1.kind === 'FFT' && p1.rate === 4e6 && !p1.dcPatch && p1.tuneHz === 433.92e6 + 1e6, 'a 1 MHz span sits off DC at 4 Msps');
  const p2 = S.planSpan(430e6, 440e6, rates);
  ok(p2.kind === 'FFT' && p2.rate === 20e6 && p2.dcPatch, '10 MHz spans centered at 20 Msps with DC patched');
  const p3 = S.planSpan(400e6, 500e6, rates);
  ok(p3.kind === 'SWEEP' && p3.sliceRate === 20e6, '100 MHz sweeps in 20 MHz slices');
  const p4 = S.planSpan(100e6, 100.3e6, [2.4e6, 2.048e6, 1.024e6]);
  ok(p4.kind === 'FFT' && p4.rate === 1.024e6, 'an RTL-SDR takes the smallest rate that fits');
  ok(S.parseHz('433.92M') === 433.92e6 && S.parseHz('100k') === 1e5 && S.parseHz('2.4G') === 2.4e9 && S.parseHz('915') === 915e6 && S.parseHz('915000000') === 915e6 && S.parseHz('x') === null, 'parseHz reads units');
  ok(S.fmtHz(433.92e6) === '433.92 MHz' && S.fmtHz(12500) === '12.5 kHz', `fmtHz prints like a bench (${S.fmtHz(433.92e6)}, ${S.fmtHz(12500)})`);
  ok(S.fmtSec(0.00125) === '1.250 ms' && S.fmtSec(830e-6) === '830.00 µs', 'fmtSec prints like a scope');
}

// ---- sweep: slices stitched across a span wider than the radio ---------------------------------------------
{
  const sliceRate = 8e6, start = 400e6, stop = 440e6, toneHz = 427.123e6, a = 60;
  const ev = [];
  const cfg = { mode: 'SWEEP', tuneHz: 0, startHz: start, stopHz: stop, rbwHz: 30_000, window: 'HANN', vbwHz: 1e9, dcPatch: true, sliceRate, zs: null };
  const sp = new S.SpectrumProcessor(cfg, (m) => ev.push(m));
  sp.reset(sliceRate);
  let tuned = start, k = 0, rows = 0, last = null;
  for (let reads = 0; reads < 3000 && rows < 2; reads++) {
    for (const m of ev.splice(0)) {
      if (m.type === 'tune') { tuned = m.hz; sp.tuned(); }
      if (m.type === 'spframe' && m.step === m.steps) { rows++; last = m; }
    }
    const off = (toneHz - tuned) / sliceRate;
    const tones = Math.abs(off) < 0.5 ? [{ f: off, a }] : [];
    const s = signal(32768, tones, 1, mulberry32(100 + reads), k);
    k += 32768;
    sp.onIq(int8(s), sliceRate);
  }
  ok(rows >= 2, `the sweep completes passes (${rows})`);
  if (last) {
    const y = last.live, i = S.peakSearch(y), r = S.refinePeak(y, i);
    const f = last.f0 + (i + r.offset) * last.binHz;
    near(f, toneHz, last.binHz, 'a tone in a sweep lands at its frequency');
    near(r.level, dbfs(a), 1.6, 'at its level');
    near(last.f0 + y.length * last.binHz, stop, last.binHz * (S.sweepKeep(last.n)), 'the row covers the span');
    near(last.rbw / S.rbwOf(sliceRate, last.n, 'HANN'), 1, 1e-5, 'and reports its RBW');
  }
  ok(S.sweepFft(0, 6e9, 20e6, 100, 'HANN') < 65536 && Math.ceil(6e9 / (20e6 / S.sweepFft(0, 6e9, 20e6, 100, 'HANN'))) <= S.MAX_ROW_BINS, 'a very wide sweep widens its RBW to fit the row');
}

// ---- FFT mode: the processor crops the span and paces the screen --------------------------------------------
{
  const rate = 4e6, ev = [];
  const plan = S.planSpan(433.42e6, 434.42e6, [rate]);
  const cfg = { mode: 'FFT', tuneHz: plan.tuneHz, startHz: 433.42e6, stopHz: 434.42e6, rbwHz: 3000, window: 'HANN', vbwHz: 1e9, dcPatch: plan.dcPatch, sliceRate: 0, zs: null };
  const sp = new S.SpectrumProcessor(cfg, (m) => ev.push(m));
  sp.reset(rate);
  const off = (433.92e6 - plan.tuneHz) / rate;
  for (let r = 0; r < 10; r++) sp.onIq(int8(signal(32768, [{ f: off, a: 50 }], 1, mulberry32(r), r * 32768)), rate);
  const fr = ev.filter(m => m.type === 'spframe');
  ok(fr.length >= 2 && fr.length <= 4, `about 30 frames a second reach the screen (${fr.length} for 82 ms)`);
  const m = fr[fr.length - 1];
  ok(m.f0 >= 433.42e6 && m.f0 + m.live.length * m.binHz <= 434.42e6 + m.binHz, 'the frame holds only the span');
  const i = S.peakSearch(m.live);
  near(m.f0 + i * m.binHz, 433.92e6, m.binHz, 'and the tone is where it belongs');
}

// ---- zero span ----------------------------------------------------------------------------------------------
{
  const h = S.designLowpass(0.05, 63);
  near(h.reduce((a, b) => a + b, 0), 1, 1e-6, 'the zero-span filter has unity gain at DC');
  const p = S.zsPlan(2e6, 10_000);
  ok(p.d1 === 12 && p.outRate >= 40_000 && p.outRate < 80_000, `zero-span plan for 10 kHz at 2 Msps (d1 ${p.d1}, out ${p.outRate})`);
  near(S.zsMaxBw(2e6), 720_000, 1, 'the widest filter at 2 Msps');
}
/** A pulsed carrier at offset `off` Hz: on for `onS`, period `perS`, starting `lead` seconds in. */
function pulsed(rate, secs, off, a, onS, perS, lead, rnd, noise = 0.5) {
  const n = Math.round(rate * secs), i = new Float32Array(n), q = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = k / rate, on = t >= lead && ((t - lead) % perS) < onS;
    const ph = 2 * Math.PI * off * t;
    i[k] = (on ? a * Math.cos(ph) : 0) + noise * gauss(rnd); q[k] = (on ? a * Math.sin(ph) : 0) + noise * gauss(rnd);
  }
  return { i, q };
}
{
  const rate = 2e6, off = 400_000, bw = 100_000;
  const zcfg = { offsetHz: off, bwHz: bw, sweepSec: 0.02, trigger: 'RISE', single: false, levelDb: -30, pre: 0.25 };
  const caps = [];
  const z = new S.ZeroSpan(rate, zcfg, c => caps.push(c));
  const s = pulsed(rate, 0.06, off, 60, 0.001, 0.004, 0.0105, mulberry32(5));
  z.pushFloat(s.i, s.q);
  ok(caps.length >= 1, `RISE triggers on the pulses (${caps.length} captures)`);
  const c = caps[0];
  ok(c && !c.roll && Math.abs(c.trig - 0.25 * c.amp.length) <= 1, 'the trigger sits 25 % into the window (pre-trigger)');
  if (c) {
    ok(c.amp[c.trig - 2] < -30 && c.amp[c.trig + 3] > -30, 'the amplitude crosses the level at the trigger');
    near(Math.max(...c.amp), dbfs(60), 0.5, 'the pulse reads its level through the filter');
    const st = S.pulseStats(c.amp, c.rate);
    ok(st !== null, 'the window holds pulses');
    if (st) {
      near(st.width, 0.001, 0.00003, 'pulse width 1 ms');
      near(st.period, 0.004, 0.00003, 'period 4 ms');
      near(st.duty, 0.25, 0.01, 'duty cycle 25 %');
      ok(st.rise > 0 && st.rise < 2 / bw, `rise time ${(st.rise * 1e6).toFixed(1)} µs, set by the 100 kHz filter`);
      ok(st.fall > 0 && st.fall < 2 / bw, 'fall time likewise');
      near(st.top, dbfs(60), 0.5, 'the top level');
      ok(st.pulses >= 4, `every complete pulse counted (${st.pulses})`);
    }
  }
  // FALL triggers on the falling edge
  const caps2 = []; const z2 = new S.ZeroSpan(rate, { ...zcfg, trigger: 'FALL' }, cc => caps2.push(cc));
  z2.pushFloat(s.i, s.q);
  const c2 = caps2[0];
  ok(c2 && c2.amp[c2.trig - 3] > -30 && c2.amp[c2.trig + 2] < -30, 'FALL triggers on the falling edge');
  // SINGLE takes one capture and waits to be armed again
  const caps3 = [], done3 = []; const z3 = new S.ZeroSpan(rate, { ...zcfg, single: true }, cc => { caps3.push(cc); done3.push(z3.done); });
  z3.pushFloat(s.i, s.q);
  ok(caps3.length === 1 && z3.done, 'SINGLE takes one capture');
  ok(done3[0] === true, 'and is already done when its capture goes out (the screen shows DONE, not ARMED)');
  z3.rearm(); z3.pushFloat(s.i, s.q);
  ok(caps3.length === 2, 'and one more once re-armed');
  // FREE rolls: windows come at least 20 times a second of signal, without waiting for a trigger
  const caps4 = []; const z4 = new S.ZeroSpan(rate, { ...zcfg, trigger: 'FREE' }, cc => caps4.push(cc));
  const quiet = pulsed(rate, 0.2, off, 0, 0, 1, 1, mulberry32(9));
  z4.pushFloat(quiet.i, quiet.q);
  ok(caps4.length >= 4 && caps4.every(cc => cc.roll && cc.trig === -1), `FREE rolls without a trigger (${caps4.length})`);
  // no trigger on a quiet channel
  const caps5 = []; const z5 = new S.ZeroSpan(rate, zcfg, cc => caps5.push(cc));
  z5.pushFloat(quiet.i, quiet.q);
  ok(caps5.length === 0, 'RISE waits on a quiet channel');
  // instantaneous frequency: a carrier 12 kHz above the channel reads +12 kHz
  const caps6 = []; const z6 = new S.ZeroSpan(rate, { ...zcfg, trigger: 'FREE', sweepSec: 0.005 }, cc => caps6.push(cc));
  const fm = pulsed(rate, 0.02, off + 12_000, 50, 1, 1, 0, mulberry32(4));
  z6.pushFloat(fm.i, fm.q);
  const lastFm = caps6[caps6.length - 1].fm;
  const sortedFm = Float32Array.from(lastFm).sort();
  near(sortedFm[sortedFm.length >> 1], 12_000, 50, 'instantaneous frequency of an offset carrier');
  // phase advances by 360° per 1 / 12 kHz
  const ph = caps6[caps6.length - 1].ph, prate = caps6[caps6.length - 1].rate;
  let unwrapped = 0;
  for (let k = 1; k < ph.length; k++) { let d = ph[k] - ph[k - 1]; if (d > 180) d -= 360; if (d < -180) d += 360; unwrapped += d; }
  near(unwrapped / ((ph.length - 1) / prate) / 360, 12_000, 50, 'phase turns at the offset frequency');
  ok(S.pulseStats(new Float32Array(100).fill(-40), 1e5) === null, 'a steady trace has no pulses');
  {
    // a steady carrier in noise with a few fading dips: 6 dB between its noise peaks and its dips is not a pulse train
    const rnd = mulberry32(21), y = new Float32Array(4000);
    for (let k = 0; k < y.length; k++) y[k] = -60 + 3 * gauss(rnd) - (k % 97 === 0 ? 25 : 0);
    ok(S.pulseStats(y, 1e5) === null, 'a noisy steady carrier with fading dips has no pulses');
  }
  {
    // the envelope of noise alone fades deeply and often, but it is not a pulse train
    const rnd = mulberry32(22), y = new Float32Array(20000);
    for (let k = 0; k < y.length; k++) { const a = 5 * gauss(rnd), b = 5 * gauss(rnd); y[k] = 10 * Math.log10((a * a + b * b) / (128 * 128) + 1e-20); }
    ok(S.pulseStats(y, 1e6) === null && S.twoLevels(y) === null, 'noise alone has no pulses');
    // a weak pulse train only 15 dB over that same noise still reads
    const rp = mulberry32(23), yp = new Float32Array(20000);
    for (let k = 0; k < yp.length; k++) { const on = (k % 400) < 100, a = 5 * gauss(rp) + (on ? 28 : 0), b = 5 * gauss(rp); yp[k] = 10 * Math.log10((a * a + b * b) / (128 * 128) + 1e-20); }
    const sp = S.pulseStats(yp, 1e6);
    ok(sp !== null && Math.abs(sp.period - 400e-6) < 5e-6 && Math.abs(sp.duty - 0.25) < 0.03, `a pulse train 15 dB over the noise reads (${sp && (sp.period * 1e6).toFixed(1)} µs, ${sp && sp.duty.toFixed(3)})`);
  }
  ok(S.fmtSec(0) === '0 s', 'zero time prints as 0 s');
  ok(S.autoLevel(Float32Array.from([-90, -88, -89, -40, -91])) === -77, 'AUTO LEVEL sits 12 dB over the median');
  // long windows are reduced for the screen with the amplitude peak-held
  const big = []; const zb = new S.ZeroSpan(rate, { ...zcfg, bwHz: 300_000, sweepSec: 0.2, trigger: 'FREE' }, cc => big.push(cc));
  ok(zb.window <= S.ZS_MAX_POINTS, 'a window is capped');
  zb.pushFloat(quiet.i, quiet.q);
  ok(big.length > 0 && big[big.length - 1].amp.length <= S.ZS_SHOW_POINTS, 'and reduced for the screen');
}

// ---- persistence --------------------------------------------------------------------------------------------
{
  const p = new S.Persistence(4, 10, 0.5);
  p.add(Float32Array.from([-10, -10, -50, -95]), 0, 100);
  p.add(Float32Array.from([-10, -10, -50, -95]), 0, 100);
  ok(p.hits[1 * 4 + 0] === 1.5 && p.hits[5 * 4 + 2] === 1.5 && p.hits[9 * 4 + 3] === 1.5, 'persistence drops hits where the trace is, old ones fading');
  const pc = new S.Persistence(3, 10, 1);
  pc.addColumns(Float32Array.from([-15, -55, -55]), 0, 100);
  ok(pc.hits[1 * 3 + 0] === 1 && pc.hits[5 * 3 + 1] === 1 && Math.abs(pc.hits[3 * 3 + 1] - 0.35) < 1e-6 && Math.abs(pc.hits[1 * 3 + 1] - 0.35) < 1e-6 && pc.hits[5 * 3 + 2] === 1, 'addColumns joins a column to the last with a run');
  const lv = p.level(); ok(Math.abs(lv[4] - 1) < 1e-6 && lv[0] === 0, 'brightness is scaled to the busiest cell');
}

console.log(`spectrum: ${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
