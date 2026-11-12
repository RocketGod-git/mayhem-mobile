/**
 * Measuring a burst: the numbers behind what the trace shows.
 *
 * Everything an analyst reads off a waveform by hand, worked out once: every mark and gap with its length; the
 * lengths that recur (the short and long classes a pulse-width or pulse-position code is built from) with their
 * spread and jitter and the thresholds between them; how well the symbol length fits, and how far the edges drift
 * from a clock run at it; the repeats inside one burst, their spacing and how they differ; the levels (how loud the
 * marks and gaps are, how fast the carrier rises and falls, the tones and their deviation). Twin of
 * core/analyzer/Measure.kt and Measure.swift.
 */

import { bitsToHex, FM_SCALE, type Analysis } from './demod.js';

/** One mark or gap inside a frame. */
export interface Pulse {
  /** Which frame, and its place in it. */
  frame: number;
  index: number;
  hi: boolean;
  /** Where it starts (sample) and how long it lasts. */
  start: number;
  n: number;
  us: number;
  /** Which length class it fell in (see `classes`), per level. */
  cls: number;
}

/** A length that recurs among the marks (or the gaps). */
export interface PulseClass {
  hi: boolean;
  count: number;
  mean: number; min: number; max: number;
  /** Standard deviation, µs, and as a share of the mean. */
  sd: number;
  jitterPct: number;
  /** The mean as a number of symbols. */
  symbols: number;
}

export interface PulseTable {
  pulses: Pulse[];
  /** Marks' classes, short to long, then gaps' classes, short to long. */
  marks: PulseClass[];
  spaces: PulseClass[];
  /** The lengths (µs) that split one class from the next: midway between neighbors. */
  markCuts: number[];
  spaceCuts: number[];
}

/** Lengths into classes: sorted, split wherever the next is more than 30% longer than the class's longest so far. */
export function classify(us: number[]): number[][] {
  const s = us.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: number[][] = [];
  let cur: number[] = [], last = -1;
  for (const [v, i] of s) {
    if (cur.length && v > last * 1.3) { out.push(cur); cur = []; }
    cur.push(i); last = v;
  }
  if (cur.length) out.push(cur);
  return out;
}

function stats(us: number[], ids: number[], hi: boolean, symUs: number): PulseClass {
  const v = ids.map(i => us[i]);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let ss = 0; for (const x of v) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / v.length);
  return { hi, count: v.length, mean, min: Math.min(...v), max: Math.max(...v), sd, jitterPct: mean ? sd / mean * 100 : 0, symbols: symUs ? mean / symUs : 0 };
}

/** Every mark and gap inside the frames, and the classes of their lengths. */
export function pulseTable(a: Analysis, rate: number): PulseTable {
  const usPer = 1e6 / rate;
  const pulses: Pulse[] = [];
  let pos = a.from, frame = -1, index = 0;
  const fr = a.frames;
  for (const r of a.runs) {
    // a run is in a frame when it overlaps it (a frame trimmed onto its sync may start part way into a run)
    const f = fr.findIndex(x => pos < x.end && pos + r.n > x.start);
    if (f >= 0) {
      if (f !== frame) { frame = f; index = 0; }
      pulses.push({ frame: f, index: index++, hi: r.hi, start: pos, n: r.n, us: r.n * usPer, cls: 0 });
    }
    pos += r.n;
  }
  const out: PulseTable = { pulses, marks: [], spaces: [], markCuts: [], spaceCuts: [] };
  for (const hi of [true, false]) {
    const idx = pulses.map((p, i) => i).filter(i => pulses[i].hi === hi);
    const us = idx.map(i => pulses[i].us);
    const groups = classify(us);
    const cls = groups.map(g => stats(us, g, hi, a.symUs));
    groups.forEach((g, c) => g.forEach(k => { pulses[idx[k]].cls = c; }));
    const cuts = cls.slice(1).map((c, i) => (cls[i].max + c.min) / 2);
    if (hi) { out.marks = cls; out.markCuts = cuts; } else { out.spaces = cls; out.spaceCuts = cuts; }
  }
  return out;
}

/**
 * How well the symbol length fits: the symbol each run implies (its length over its whole number of symbols) and how
 * much those disagree, as a share of the symbol. Runs over 16 symbols (rests) are left out.
 */
export function symbolFit(a: Analysis, rate: number): { symUs: number; baud: number; errPct: number; runs: number } {
  const usPer = 1e6 / rate, u = a.symUs;
  const est: number[] = [];
  for (const r of a.runs.slice(1, -1)) { const k = Math.round(r.n * usPer / u); if (k >= 1 && k <= 16) est.push(r.n * usPer / k); }
  if (!est.length || !u) return { symUs: u, baud: a.baud, errPct: 0, runs: 0 };
  const m = est.reduce((x, y) => x + y, 0) / est.length;
  let ss = 0; for (const x of est) ss += (x - m) * (x - m);
  return { symUs: m, baud: a.baud, errPct: Math.sqrt(ss / est.length) / m * 100, runs: est.length };
}

/**
 * The clock a receiver would run: from each frame's first edge, a tick every symbol. For each edge in the frame, how
 * far it lands from the nearest tick, as a share of a symbol; the worst of these is the drift.
 */
export function clockDrift(a: Analysis, rate: number): { frame: number; start: number; u: number; worstPct: number; meanPct: number }[] {
  const u = a.symUs * rate / 1e6;
  if (!u) return [];
  const out: { frame: number; start: number; u: number; worstPct: number; meanPct: number }[] = [];
  a.frames.forEach((f, fi) => {
    let pos = a.from, worst = 0, sum = 0, n = 0;
    const start = f.spans.length ? f.spans[0] : f.start;
    for (const r of a.runs) {
      if (pos > start && pos < f.end) { const k = (pos - start) / u, e = Math.abs(k - Math.round(k)); worst = Math.max(worst, e); sum += e; n++; }
      pos += r.n;
    }
    out.push({ frame: fi, start, u, worstPct: worst * 100, meanPct: n ? sum / n * 100 : 0 });
  });
  return out;
}

/** The repeats inside a burst: when each starts and ends, the gap before it, the time from the last one's start, and where it differs from the first. */
export interface FrameSeg {
  index: number;
  startMs: number; endMs: number;
  gapMs: number; intervalMs: number;
  bits: number;
  hex: string;
  /** Bit positions that differ from the first frame (compared over the shorter of the two). */
  diff: number[];
}

export function frameSegments(a: Analysis, rate: number): FrameSeg[] {
  const ms = (s: number) => s / rate * 1000;
  const f0 = a.frames[0]?.bits ?? '';
  return a.frames.map((f, i) => {
    const prev = a.frames[i - 1];
    const diff: number[] = [];
    for (let k = 0; k < Math.min(f0.length, f.bits.length); k++) if (f.bits[k] !== f0[k]) diff.push(k);
    return {
      index: i, startMs: ms(f.start), endMs: ms(f.end), gapMs: prev ? ms(f.start - prev.end) : 0, intervalMs: prev ? ms(f.start - prev.start) : 0,
      bits: f.bits.length, hex: bitsToHex(f.bits), diff,
    };
  });
}

/** Levels: how loud, how fast, and on what frequencies. */
export interface Levels {
  /** Mean envelope over the marks and over the gaps (well inside each), dBFS, and the difference. */
  markDbfs: number; spaceDbfs: number; depthDb: number;
  /** 10% → 90% of the way up (and back down) at the marks' edges, µs, averaged. */
  riseUs: number; fallUs: number;
  /** For FSK: the two tones and their middle, Hz from the channel center, and the deviation (half the shift). */
  toneLoHz: number; toneHiHz: number; centerHz: number; deviationHz: number;
  /** For OOK/ASK: the carrier's own offset from the channel center, Hz, measured inside the marks. */
  carrierHz: number;
  /** The discriminator inside the carrier, binned by 2 kHz from −60 to +60 kHz: the tones as two peaks. */
  toneHist: number[];
  /** ASK: the two amplitude levels, dBFS. */
  askLoDbfs: number; askHiDbfs: number;
}

const ENV_FULL = 16384;
const dbfs = (v: number) => 20 * Math.log10(Math.max(1, v) / ENV_FULL);

export function levels(a: Analysis, env: Int16Array, fm: Int16Array, rate: number): Levels {
  const toHz = (v: number) => v / FM_SCALE * rate / (2 * Math.PI);
  const margin = Math.max(2, Math.round(rate * 16e-6));
  let mS = 0, mN = 0, sS = 0, sN = 0, fS = 0, fN = 0;
  const hist = new Array<number>(61).fill(0);
  let pos = a.from;
  const rises: number[] = [], falls: number[] = [];
  let peak = 0;
  for (const r of a.runs) {
    for (let i = pos + margin; i < pos + r.n - margin; i++) {
      if (r.hi || a.mod === 'FSK') {
        mS += env[i]; mN++;
        fS += fm[i]; fN++;
        const k = Math.round(toHz(fm[i]) / 2000) + 30;
        if (k >= 0 && k <= 60) hist[k]++;
        if (env[i] > peak) peak = env[i];
      } else { sS += env[i]; sN++; }
    }
    pos += r.n;
  }
  const markMean = mN ? mS / mN : 0, spaceMean = sN ? sS / sN : 1;
  // rise and fall at each edge of the carrier (OOK and ASK): from the level before to the level after
  if (a.mod !== 'FSK') {
    pos = a.from;
    for (const r of a.runs) {
      const lo = spaceMean, hi = markMean, t10 = lo + 0.1 * (hi - lo), t90 = lo + 0.9 * (hi - lo);
      const w = Math.min(r.n, Math.round(rate * 200e-6));
      if (r.hi) {
        let i10 = -1, i90 = -1;
        for (let i = Math.max(0, pos - w); i < pos + w && i < env.length; i++) { if (i10 < 0 && env[i] >= t10) i10 = i; if (i10 >= 0 && env[i] >= t90) { i90 = i; break; } }
        if (i10 >= 0 && i90 > i10) rises.push((i90 - i10) / rate * 1e6);
      } else if (pos > a.from) {
        let i90 = -1, i10 = -1;
        for (let i = Math.max(0, pos - w); i < pos + w && i < env.length; i++) { if (i90 < 0 && env[i] <= t90) i90 = i; if (i90 >= 0 && env[i] <= t10) { i10 = i; break; } }
        if (i90 >= 0 && i10 > i90) falls.push((i10 - i90) / rate * 1e6);
      }
      pos += r.n;
    }
  }
  const avg = (v: number[]) => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0);
  const fsk = a.mod === 'FSK';
  const loHz = fsk ? toHz(a.lo) : 0, hiHz = fsk ? toHz(a.hi) : 0;
  return {
    markDbfs: dbfs(markMean), spaceDbfs: dbfs(spaceMean), depthDb: dbfs(markMean) - dbfs(spaceMean),
    riseUs: avg(rises), fallUs: avg(falls),
    toneLoHz: loHz, toneHiHz: hiHz, centerHz: fsk ? (loHz + hiHz) / 2 : 0, deviationHz: fsk ? Math.abs(hiHz - loHz) / 2 : 0,
    carrierHz: !fsk && fN ? toHz(fS / fN) : 0,
    toneHist: hist,
    askLoDbfs: a.mod === 'ASK' ? dbfs(a.lo) : 0, askHiDbfs: a.mod === 'ASK' ? dbfs(a.hi) : 0,
  };
}

/**
 * The eye: two symbols of the sliced signal at every tick of each frame's clock, laid over each other. Returns the
 * sample each trace starts at (half a symbol before its tick) and the trace length; the caller draws them.
 */
export function eyeStarts(a: Analysis, rate: number): { starts: number[]; len: number } {
  const u = a.symUs * rate / 1e6;
  if (!u) return { starts: [], len: 0 };
  const starts: number[] = [];
  for (const f of a.frames) {
    const s0 = f.spans.length ? f.spans[0] : f.start;
    for (let t = s0; t + 1.5 * u <= f.end; t += u) starts.push(Math.round(t - u / 2));
  }
  return { starts, len: Math.round(2 * u) };
}

/** Text for the clipboard and files. */
export function pulseCsv(t: PulseTable): string {
  const rows = ['frame,index,level,start_sample,samples,us,class'];
  for (const p of t.pulses) rows.push(`${p.frame + 1},${p.index},${p.hi ? 'mark' : 'gap'},${p.start},${p.n},${p.us.toFixed(1)},${p.hi ? 'M' : 'G'}${p.cls + 1}`);
  return rows.join('\n');
}
export function classCsv(t: PulseTable): string {
  const rows = ['class,level,count,mean_us,min_us,max_us,sd_us,jitter_pct,symbols'];
  const add = (c: PulseClass, i: number) => rows.push(`${c.hi ? 'M' : 'G'}${i + 1},${c.hi ? 'mark' : 'gap'},${c.count},${c.mean.toFixed(1)},${c.min.toFixed(1)},${c.max.toFixed(1)},${c.sd.toFixed(1)},${c.jitterPct.toFixed(1)},${c.symbols.toFixed(2)}`);
  t.marks.forEach(add); t.spaces.forEach(add);
  return rows.join('\n');
}
export function framesCsv(f: FrameSeg[]): string {
  const rows = ['frame,start_ms,end_ms,gap_ms,interval_ms,bits,hex,differs_from_frame_1_at'];
  for (const s of f) rows.push(`${s.index + 1},${s.startMs.toFixed(3)},${s.endMs.toFixed(3)},${s.gapMs.toFixed(3)},${s.intervalMs.toFixed(3)},${s.bits},${s.hex},${s.diff.join(' ')}`);
  return rows.join('\n');
}
/** The samples of [from, to): time, I, Q, envelope, discriminator in Hz. */
export function samplesCsv(iq: Int8Array, env: Int16Array, fm: Int16Array, rate: number, from: number, to: number): string {
  const rows = ['sample,t_us,i,q,envelope,freq_hz'];
  for (let i = from; i < to; i++) rows.push(`${i},${(i / rate * 1e6).toFixed(1)},${iq[2 * i]},${iq[2 * i + 1]},${env[i]},${(fm[i] / FM_SCALE * rate / (2 * Math.PI)).toFixed(0)}`);
  return rows.join('\n');
}
/** One file for a selection: its samples, pulses, classes and frames, each section under a `# name` line. */
export function selectionCsv(parts: { samples: string; pulses: string; classes: string; frames: string }): string {
  return `# samples\n${parts.samples}\n\n# pulses\n${parts.pulses}\n\n# classes\n${parts.classes}\n\n# frames\n${parts.frames}\n`;
}
