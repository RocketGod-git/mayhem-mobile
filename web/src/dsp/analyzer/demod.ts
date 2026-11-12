/**
 * The Analyzer's demodulator: one captured burst in, bits out, the way a person does it in Universal Radio Hacker.
 *
 * A burst arrives as the same two streams every Devices decoder reads (the envelope and the FM discriminator at the
 * channel rate, see `r433/baseband.ts`). From those this works out, in order:
 *
 *  1. where the burst is: the samples the carrier stands clear of the noise heard before it began;
 *  2. how it is modulated: on-off (OOK), two amplitude levels (ASK) or two frequencies (FSK);
 *  3. where to slice it: the middle between its two levels, as a fraction of the range between them;
 *  4. the length of one symbol: the shortest element, refined over every run that is a whole number of them;
 *  5. the line coding: NRZ (a level per bit), Manchester (a transition per bit), PWM (the width of each mark) or
 *     PPM (the width of each gap);
 *  6. the bits of each frame, frames being split wherever the line rests far longer than any symbol.
 *
 * Every step can be overridden, and the later ones are worked out again from the override. Nothing here keeps
 * state, so the same burst always reads the same way. Twin of core/analyzer/Demod.kt and Demod.swift.
 */

export type Mod = 'OOK' | 'ASK' | 'FSK';
export type Coding = 'NRZ' | 'Manchester' | 'PWM' | 'PPM';
export const MODS: Mod[] = ['OOK', 'ASK', 'FSK'];
export const CODINGS: Coding[] = ['NRZ', 'Manchester', 'PWM', 'PPM'];

/** One run of the sliced line: high or low, for `n` samples. */
export interface Run { hi: boolean; n: number }

/** One frame: where it lies in the burst (samples) and its bits as a string of 0 and 1. */
export interface Frame {
  start: number; end: number; bits: string;
  /** Where each bit lies in the burst: samples [spans[2i], spans[2i+1]) carry bit i. For the trace and its link to the text. */
  spans: Int32Array;
}

/** What the person has set by hand. Anything left out is worked out. */
export interface Overrides {
  mod?: Mod;
  /** The symbol length, in microseconds (for Manchester, the half bit). */
  symUs?: number;
  /** Where to slice, as a fraction of the way from the low level to the high one. */
  thr?: number;
  coding?: Coding;
  /** Read every bit the other way up. */
  invert?: boolean;
  /** Only this part of the burst, in samples. */
  from?: number;
  to?: number;
}

export interface Analysis {
  mod: Mod; modAuto: Mod;
  /** The symbol length in microseconds, and what was measured. */
  symUs: number; symAuto: number;
  thr: number; thrAuto: number;
  coding: Coding; codingAuto: Coding;
  invert: boolean;
  /** The two levels sliced between, in the units of the stream sliced (envelope or discriminator). */
  lo: number; hi: number;
  /** The level the line is cut at, in the same units. */
  cut: number;
  /** The part of the burst read, in samples. */
  from: number; to: number;
  /** The sliced line from `from`, run by run. */
  runs: Run[];
  frames: Frame[];
  /** Bits a second, after the coding. */
  baud: number;
  /** The frequency shift between the two tones in hertz (FSK), or 0. */
  shiftHz: number;
  /** A short account of why it was read this way, for the panel. */
  why: string;
}

/** Discriminator units are radians times this (see Baseband). */
export const FM_SCALE = 10430.378;
/** Above the noise by this much is a carrier (10 dB), and it lets go below 7 dB, as the key slicer does. */
const ON_K = 3.2, OFF_K = 2.2;
/** Less shift than this between the tones (about 4.6 kHz at 250 kHz) is not FSK. */
const MIN_FSK_SPREAD = 1200;
/** A rest this many symbols long ends a frame. */
const GAP_SYMBOLS = 20;
/** Frames shorter than this are fragments, not frames. */
const MIN_FRAME_BITS = 8;

/** The level of the noise in the look-back before the burst: the median of its first 6 ms, past the filter's start. */
export function noiseOf(env: Int16Array, n: number, rate: number): number {
  const a = Math.min(20, n), b = Math.min(n, a + Math.max(16, Math.round(rate * 0.006)));
  if (b <= a) return 1;
  const v = Array.from(env.subarray(a, b)).sort((x, y) => x - y);
  return Math.max(1, v[v.length >> 1]);
}

/**
 * Where the carrier is up, sample by sample, with the key slicer's hysteresis: 10 dB over the noise to rise and
 * 7 dB to fall. Never less than 22 dB under the burst's own peak, so a strong neighbor leaking into the channel
 * through the decimator's skirts does not read as this burst carrying on.
 */
export function carrierOf(env: Int16Array, n: number, noise: number): Uint8Array {
  let peak = 0;
  for (let i = 0; i < n; i++) if (env[i] > peak) peak = env[i];
  const rise = Math.max(noise * ON_K, peak * 0.08), fall = Math.max(noise * OFF_K, peak * 0.055);
  const on = new Uint8Array(n);
  let up = false;
  for (let i = 0; i < n; i++) {
    const e = env[i];
    if (!up && e > rise) up = true; else if (up && e < fall) up = false;
    on[i] = up ? 1 : 0;
  }
  return on;
}

/** Two-means on a set of values: the two centers, the share in the upper one, and the spread within them. */
export function twoMeans(v: ArrayLike<number>, count = v.length): { a: number; b: number; share: number; sd: number } {
  if (!count) return { a: 0, b: 0, share: 0, sd: 0 };
  // started from the 5th and 95th percentiles: from the extremes, one stray spike can claim a center to itself
  const sorted = Float64Array.from({ length: count }, (_, i) => v[i]).sort();
  let a = sorted[Math.floor(count * 0.05)], b = sorted[Math.min(count - 1, Math.floor(count * 0.95))];
  for (let it = 0; it < 12; it++) {
    const t = (a + b) / 2;
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let i = 0; i < count; i++) { const x = v[i]; if (x > t) { sb += x; nb++; } else { sa += x; na++; } }
    const a2 = na ? sa / na : a, b2 = nb ? sb / nb : b;
    if (a2 === a && b2 === b) break;
    a = a2; b = b2;
  }
  const t = (a + b) / 2;
  let ss = 0, nb = 0;
  for (let i = 0; i < count; i++) { const x = v[i]; const c = x > t ? b : a; if (x > t) nb++; ss += (x - c) * (x - c); }
  return { a, b, share: nb / count, sd: Math.sqrt(ss / count) };
}

/** Runs of one level shorter than `min` samples are glitches: they are folded into the runs around them. */
export function deglitch(runs: Run[], min: number): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.n < min && out.length) { out[out.length - 1].n += r.n; continue; }
    if (out.length && out[out.length - 1].hi === r.hi) out[out.length - 1].n += r.n;
    else out.push({ hi: r.hi, n: r.n });
  }
  return out;
}

/** The line cut at `cut` with a little hysteresis, as runs. Where the carrier is down (FSK), the line is low. */
export function sliceRuns(sig: ArrayLike<number>, from: number, to: number, cut: number, hyst: number, gate: Uint8Array | null): Run[] {
  const runs: Run[] = [];
  let lvl = false, n = 0;
  for (let i = from; i < to; i++) {
    const x = sig[i];
    let l: boolean = lvl;
    if (gate && !gate[i]) l = false;
    else if (x > cut + hyst) l = true;
    else if (x < cut - hyst) l = false;
    if (l === lvl) n++;
    else { if (n) runs.push({ hi: lvl, n }); lvl = l; n = 1; }
  }
  if (n) runs.push({ hi: lvl, n });
  return runs;
}

/**
 * The symbol length in samples: the mean of the shortest runs, then refined over every run that is a whole number
 * of symbols (up to 16), so a hundred runs vote rather than the one shortest.
 */
export function symbolOf(runs: Run[]): number {
  const inner = runs.slice(1, -1).map(r => r.n).filter(n => n > 0);
  if (!inner.length) return runs.length ? runs[0].n : 1;
  const s = inner.slice().sort((x, y) => x - y);
  // the lengths that recur: runs within 20% of each other, each group at least 5% of all of them; the symbol is one
  // of these or a half or third of one
  const cands: number[] = [];
  for (let i = 0; i < s.length;) {
    let j = i, sum = 0;
    while (j < s.length && s[j] <= s[i] * 1.2) { sum += s[j]; j++; }
    if (j - i >= Math.max(2, s.length * 0.05)) { const c = sum / (j - i); cands.push(c, c / 2, c / 3); }
    i = j;
  }
  if (!cands.length) cands.push(s[s.length >> 1]);
  // The longest symbol that the frame is a whole number of (any shorter one would fit it too). Measured as the
  // longest unbroken stretch of runs that fit, so noise before the preamble, which fits nothing for long, has no say.
  const fits = cands.map(c => (c >= 1 ? stretchOf(inner, c) : 0));
  const most = Math.max(...fits);
  let u = 0;
  for (let i = 0; i < cands.length; i++) if (fits[i] >= most * 0.8 && cands[i] > u) u = cands[i];
  for (let it = 0; it < 3; it++) {
    let sr = 0, sk = 0;
    for (const n of inner) { const x = n / u, k = Math.round(x); if (k >= 1 && k <= 16 && Math.abs(x - k) < 0.25 + 0.03 * k) { sr += n; sk += k; } }
    if (sk) u = sr / sk;
  }
  return u;
}

/** The longest unbroken stretch of runs that are close to a whole number (1..16) of symbols `u`; rests are skipped. */
function stretchOf(runs: number[], u: number): number {
  let best = 0, cur = 0;
  for (const n of runs) {
    const x = n / u, k = Math.round(x);
    if (k > 16) continue;
    if (k >= 1 && Math.abs(x - k) < 0.25 + 0.03 * k) { cur++; if (cur > best) best = cur; } else cur = 0;
  }
  return best;
}

/** Split the runs into frames wherever the line rests `gap` samples or more. Each frame starts on a high run. */
export function framesOf(runs: Run[], gap: number): { start: number; runs: Run[] }[] {
  const out: { start: number; runs: Run[] }[] = [];
  let cur: Run[] = [], at = 0, start = 0;
  for (const r of runs) {
    if (r.n >= gap) { if (cur.length) out.push({ start, runs: cur }); cur = []; at += r.n; continue; }
    if (!cur.length) { if (!r.hi) { at += r.n; continue; } start = at; }
    cur.push(r); at += r.n;
  }
  if (cur.length) out.push({ start, runs: cur });
  // a frame ends on its last mark: a short low after it is the carrier dying away, not a symbol
  for (const f of out) while (f.runs.length && !f.runs[f.runs.length - 1].hi) f.runs.pop();
  return out;
}

/** How each mark and the gap after it measure, for telling the pulse codings apart. */
function pairStats(frames: { runs: Run[] }[]): { marks: number[]; spaces: number[]; periods: number[] } {
  const marks: number[] = [], spaces: number[] = [], periods: number[] = [];
  for (const f of frames) {
    const r = f.runs;
    for (let i = 0; i < r.length; i++) {
      if (!r[i].hi) continue;
      marks.push(r[i].n);
      if (i + 1 < r.length) { spaces.push(r[i + 1].n); periods.push(r[i].n + r[i + 1].n); }
    }
  }
  return { marks, spaces, periods };
}

const cv = (v: number[]) => { if (v.length < 2) return 1; const m = v.reduce((a, b) => a + b, 0) / v.length; let s = 0; for (const x of v) s += (x - m) * (x - m); return Math.sqrt(s / v.length) / m; };
/** Two widths, each at least 15% of the whole, the longer at least 1.5 times the shorter. */
const twoWidths = (v: number[]) => { if (v.length < 4) return false; const t = twoMeans(v); return t.b >= t.a * 1.5 && t.share >= 0.15 && t.share <= 0.85; };

/** Which line coding fits the runs, measured against symbol `u` (samples). */
export function codingOf(frames: { runs: Run[] }[], u: number): Coding {
  const { marks, spaces, periods } = pairStats(frames);
  if (twoWidths(marks) && cv(periods) < 0.15) return 'PWM';
  let one = 0, two = 0, all = 0;
  for (const f of frames) for (const r of f.runs) { const k = Math.round(r.n / u); all++; if (k <= 1) one++; else if (k === 2) two++; }
  // (a frame that is mostly preamble is nearly all double runs: a couple of single ones are enough)
  if (all >= 8 && (one + two) / all >= 0.95 && two / all >= 0.08 && one >= 2) return 'Manchester';
  if (marks.length >= 4 && cv(marks) < 0.2 && twoWidths(spaces)) return 'PPM';
  return 'NRZ';
}

/** The bits of one frame. */
export function decodeFrame(runs: Run[], coding: Coding, u: number, marks: { a: number; b: number }, spaces: { a: number; b: number }): string {
  return decodeSpans(runs, 0, coding, u, marks, spaces).bits;
}

/**
 * The bits of one frame and where each one lies: the frame's first run starts at sample `at`. NRZ splits each run
 * into its whole symbols; a Manchester bit is its two halves; a pulse-width or pulse-position bit runs from its
 * mark to the start of the next.
 */
export function decodeSpans(runs: Run[], at: number, coding: Coding, u: number, marks: { a: number; b: number }, spaces: { a: number; b: number }): { bits: string; spans: number[] } {
  let bits = '';
  const spans: number[] = [];
  if (coding === 'NRZ' || coding === 'Manchester') {
    let half = '';
    const hs: number[] = [];
    let pos = at;
    for (const r of runs) {
      const k = Math.max(1, Math.round(r.n / u));
      for (let j = 0; j < k; j++) { half += r.hi ? '1' : '0'; hs.push(Math.round(pos + j * r.n / k), Math.round(pos + (j + 1) * r.n / k)); }
      pos += r.n;
    }
    if (coding === 'NRZ') return { bits: half, spans: hs };
    // Pairs of half bits: high then low is 1, low then high is 0. Which half bit a pair starts on (the phase) is the
    // one that makes more of the frame's pairs valid: a run of equal bits reads validly on both phases, and read on
    // the wrong one it comes out inverted, so picking it from the start (as a greedy reader does) can get a whole
    // copy wrong. A pair that is neither is skipped; the phase only moves when the other phase reads cleanly for
    // the next four pairs and this one does not, a real half-bit slip.
    const ok = (i: number) => i + 1 < half.length && half[i] !== half[i + 1];
    let v0 = 0, v1 = 0;
    for (let i = 0; i + 1 < half.length; i += 2) { if (ok(i)) v0++; if (ok(i + 1)) v1++; }
    const clean = (i: number) => { let n = 0; for (let k = 0; k < 4; k++) if (ok(i + 2 * k)) n++; return n; };
    for (let i = v1 > v0 ? 1 : 0; i + 1 < half.length;) {
      if (ok(i)) { bits += half[i] === '1' ? '1' : '0'; spans.push(hs[2 * i], hs[2 * i + 3]); i += 2; continue; }
      if (clean(i + 1) === 4 && clean(i) < 3) i += 1; else i += 2;
    }
    return { bits, spans };
  }
  const starts: number[] = [];
  let pos = at;
  for (const r of runs) { starts.push(pos); pos += r.n; }
  if (coding === 'PWM') {
    const mid = (marks.a + marks.b) / 2;
    for (let i = 0; i < runs.length; i++) {
      if (!runs[i].hi) continue;
      bits += runs[i].n > mid ? '1' : '0';
      spans.push(starts[i], i + 1 < runs.length ? starts[i + 1] + runs[i + 1].n : starts[i] + runs[i].n);
    }
    return { bits, spans };
  }
  // PPM: the gap after each mark, the last mark ending the frame
  const mid = (spaces.a + spaces.b) / 2;
  for (let i = 0; i + 1 < runs.length; i++) {
    if (!runs[i].hi) continue;
    bits += runs[i + 1].n > mid ? '1' : '0';
    spans.push(starts[i], starts[i + 1] + runs[i + 1].n);
  }
  return { bits, spans };
}

/**
 * How many leading bits to drop so a frame's sync word starts on a byte boundary: when the frame opens with a
 * training run (1010…, at least 16 bits, starting in its first 8), the sync is taken to start at the bit that breaks
 * the run (…10101 1101…: the Land Rover's D3 starts at the repeated 1, as align() reads it), and the bits before it are trimmed
 * to a whole number of bytes. Frames without one are left alone.
 */
export function syncTrim(bits: string): number {
  for (let s = 0; s < 8 && s < bits.length; s++) {
    let e = s + 1;
    while (e < bits.length && bits[e] !== bits[e - 1]) e++;
    if (e - s < 16 || e >= bits.length) continue;
    return e % 8;
  }
  return 0;
}

/** Bits as hex, four to a digit, the last digit padded with zeros on the right. */
export function bitsToHex(bits: string): string {
  let out = '';
  for (let i = 0; i < bits.length; i += 4) out += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16).toUpperCase();
  return out;
}
/** Bits as text, eight to a character; anything unprintable shows as a dot. */
export function bitsToAscii(bits: string): string {
  let out = '';
  for (let i = 0; i + 8 <= bits.length; i += 8) { const c = parseInt(bits.slice(i, i + 8), 2); out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.'; }
  return out;
}

/** The burst's signal to read for a modulation: the envelope, or the discriminator. */
export const signalOf = (mod: Mod, env: Int16Array, fm: Int16Array): Int16Array => (mod === 'FSK' ? fm : env);

/**
 * Read one burst. `rate` is the stream's sample rate; `n` how many samples it holds.
 */
export function analyze(env: Int16Array, fm: Int16Array, n: number, rate: number, o: Overrides = {}): Analysis {
  const usPer = 1e6 / rate;
  const noise = noiseOf(env, n, rate);
  const on = carrierOf(env, n, noise);
  let from = 0, to = n;
  while (from < n && !on[from]) from++;
  while (to > from && !on[to - 1]) to--;
  if (o.from !== undefined) from = Math.max(0, Math.min(n, Math.round(o.from)));
  if (o.to !== undefined) to = Math.max(from, Math.min(n, Math.round(o.to)));
  const empty: Analysis = {
    mod: o.mod ?? 'OOK', modAuto: 'OOK', symUs: o.symUs ?? 0, symAuto: 0, thr: o.thr ?? 0.5, thrAuto: 0.5,
    coding: o.coding ?? 'NRZ', codingAuto: 'NRZ', invert: !!o.invert, lo: 0, hi: 0, cut: 0, from, to, runs: [], frames: [], baud: 0, shiftHz: 0,
    why: 'no carrier above the noise',
  };
  if (to - from < 8) return empty;

  // the envelope and the discriminator, measured where the carrier is up; the discriminator away from the edges of
  // each mark, where it swings in from the noise
  const envOn: number[] = [], fmOn: number[] = [];
  let offN = 0, edges = 0;
  for (let i = from; i < to; i++) {
    if (!on[i]) { offN++; continue; }
    envOn.push(env[i]);
    if (i > 0 && !on[i - 1]) edges++;
    let inner = true;
    for (let d = -4; d <= 4 && inner; d++) { const j = i + d; if (j < from || j >= to || !on[j]) inner = false; }
    if (inner) fmOn.push(fm[i]);
  }
  const span = to - from;
  const offFrac = offN / span;
  const envT = twoMeans(envOn), fmT = twoMeans(fmOn);
  const fmSpread = fmT.b - fmT.a;
  const fskLike = fmOn.length >= 32 && fmSpread > MIN_FSK_SPREAD && fmSpread > 2 * fmT.sd && fmT.share > 0.1 && fmT.share < 0.9;
  const askLike = envOn.length >= 32 && envT.a > 0 && envT.a / envT.b > 0.15 && envT.a / envT.b < 0.75 && (envT.b - envT.a) > 3 * envT.sd && envT.share > 0.1 && envT.share < 0.9;
  const ookLike = offFrac >= 0.1 && edges >= 3;
  // FSK switches tones far more often than the carrier stops; an OOK burst does the opposite
  let fmEdges = 0;
  if (fskLike) { const t = (fmT.a + fmT.b) / 2; let l = fm[from] > t; for (let i = from; i < to; i++) { if (!on[i]) continue; const x = fm[i] > t; if (x !== l) { fmEdges++; l = x; } } }
  let modAuto: Mod = 'OOK', why = '';
  if (fskLike && fmEdges > 2 * edges + 4) { modAuto = 'FSK'; why = `two tones ${((fmSpread / FM_SCALE) * rate / (2 * Math.PI) / 1e3).toFixed(1)} kHz apart`; }
  else if (ookLike) { modAuto = 'OOK'; why = `carrier keyed on and off (${Math.round(offFrac * 100)}% off)`; }
  else if (askLike) { modAuto = 'ASK'; why = `two levels, the lower ${Math.round(envT.a / envT.b * 100)}% of the upper`; }
  else if (fskLike) { modAuto = 'FSK'; why = 'two tones'; }
  else why = 'a plain carrier: nothing keyed';
  const mod = o.mod ?? modAuto;

  // the two levels to slice between, and where
  const sig = signalOf(mod, env, fm);
  let lo: number, hi: number;
  if (mod === 'FSK') { lo = fmT.a; hi = fmT.b; }
  else if (mod === 'ASK') { lo = envT.a; hi = envT.b; }
  else { lo = noise; hi = envOn.length ? envOn.reduce((a, b) => a + b, 0) / envOn.length : noise * ON_K; if (envT.share < 0.9 && askLike) hi = envT.b; }
  if (hi <= lo) hi = lo + 1;
  const thrAuto = mod === 'OOK' ? Math.min(0.5, Math.max(0.15, (noise * ON_K - lo) / (hi - lo))) : 0.5;
  const thr = o.thr ?? thrAuto;
  const cut = lo + thr * (hi - lo);
  // FSK noise rides around the middle of the two tones, so it gets the key slicer's wider band; an OOK cut sits
  // near the noise, and a band that wide would reach below it
  const hyst = (hi - lo) * (mod === 'FSK' ? 0.12 : 0.08);
  const minRun = Math.max(2, Math.round(12 / usPer));
  const runs = deglitch(sliceRuns(sig, from, to, cut, hyst, mod === 'FSK' ? on : null), minRun);

  // symbol, frames and coding
  const uAuto = symbolOf(runs);
  const symAuto = uAuto * usPer;
  const u = o.symUs ? o.symUs / usPer : uAuto;
  const frames0 = framesOf(runs, Math.max(u * GAP_SYMBOLS, 12));
  const codingAuto = frames0.length ? codingOf(frames0, u) : 'NRZ';
  const coding = o.coding ?? codingAuto;
  const ps = pairStats(frames0);
  const mk = twoMeans(ps.marks), sp = twoMeans(ps.spaces);
  const frames: Frame[] = [];
  for (const f of frames0) {
    const d = decodeSpans(f.runs, from + f.start, coding, u, mk, sp);
    let bits = d.bits;
    if (o.invert) bits = bits.replace(/[01]/g, c => (c === '0' ? '1' : '0'));
    // copies of one frame often carry a few more or fewer training bits; trimmed so the sync starts on a byte,
    // every copy reads as the same hex
    const cut = syncTrim(bits);
    bits = bits.slice(cut);
    if (bits.length < MIN_FRAME_BITS) continue;
    const len = f.runs.reduce((a, r) => a + r.n, 0);
    const spans = Int32Array.from(d.spans.slice(2 * cut));
    frames.push({ start: spans.length ? spans[0] : from + f.start, end: from + f.start + len, bits, spans });
  }
  const period = ps.periods.length ? ps.periods.slice().sort((a, b) => a - b)[ps.periods.length >> 1] : 2 * u;
  const baud = coding === 'Manchester' ? rate / (2 * u) : coding === 'NRZ' ? rate / u : rate / period;
  const shiftHz = mod === 'FSK' ? Math.abs(hi - lo) / FM_SCALE * rate / (2 * Math.PI) : 0;
  return { mod, modAuto, symUs: u * usPer, symAuto, thr, thrAuto, coding, codingAuto, invert: !!o.invert, lo, hi, cut, from, to, runs, frames, baud, shiftHz, why };
}

/**
 * The burst as levels and durations in microseconds, signed the way a Flipper RAW file is (positive high), from
 * the first mark to the last.
 */
export function pulsesUs(a: Analysis, rate: number): number[] {
  const usPer = 1e6 / rate, out: number[] = [];
  let started = false;
  for (const r of a.runs) {
    if (!started && !r.hi) continue;
    started = true;
    const us = Math.max(1, Math.round(r.n * usPer));
    out.push(r.hi ? us : -us);
  }
  while (out.length && out[out.length - 1] < 0) out.pop();
  return out;
}

/**
 * How long the marks and the gaps last, as URH draws it: run lengths in microseconds, binned. Bins are `binUs`
 * wide up to `maxUs`; anything longer goes in the last. The frame-ending rests are left out.
 */
export function histogram(a: Analysis, rate: number, bins = 48): { binUs: number; marks: number[]; spaces: number[] } {
  const usPer = 1e6 / rate;
  const inner = a.runs.slice(1, -1).filter(r => r.n * usPer < a.symUs * GAP_SYMBOLS);
  const maxUs = Math.max(a.symUs * 6, ...inner.map(r => r.n * usPer)) * 1.02;
  const binUs = maxUs / bins;
  const marks = new Array<number>(bins).fill(0), spaces = new Array<number>(bins).fill(0);
  for (const r of inner) { const i = Math.min(bins - 1, Math.floor(r.n * usPer / binUs)); (r.hi ? marks : spaces)[i]++; }
  return { binUs, marks, spaces };
}
