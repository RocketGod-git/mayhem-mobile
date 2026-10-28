/**
 * What can be said about a transmission nobody recognized.
 *
 * A burst that no protocol claims is not nothing. It was a real carrier, keyed or shifted in a deliberate
 * pattern, and its timings are measured to the sample. Reporting them is the difference between "the band is
 * quiet" and "something transmits here every forty seconds in pulse-position at 2.3 kbit/s, and this receiver
 * does not know it yet" — the second is a lead, and it is the same information rtl_433's own analyzer mode
 * prints when asked to characterize an unknown device.
 *
 * Nothing here guesses at meaning. It measures widths, groups the ones that recur, and names the coding only
 * when the grouping makes it unambiguous. Everything it reports is a measurement or is labeled as a guess.
 */

/** How far apart two widths may be and still count as the same symbol. Twenty per cent is rtl_433's own default. */
const TOL = 0.2;
/** A width has to turn up this often to be a symbol rather than a glitch or a runt at the end of the burst. */
const MIN_SHARE = 0.08;

/** One recurring width, in microseconds, with how many times it occurred. */
export interface Cluster {
  us: number;
  n: number;
}

/** Everything measurable about one unrecognized burst. */
export interface BurstShape {
  /** Frequency-shifted rather than keyed. */
  fsk: boolean;
  /** How many marks the burst contained. */
  pulses: number;
  /** How long the whole thing lasted, in milliseconds. */
  ms: number;
  /** The mark widths that recur, shortest first. */
  mark: Cluster[];
  /** The space widths that recur, shortest first. Excludes the trailing silence that ended the burst. */
  space: Cluster[];
  /**
   * How the bits look to be carried, or an empty string when the widths do not settle it. A guess from the
   * shape alone, never from a decode.
   */
  coding: string;
  /** Symbols per second, from the mean symbol period. Zero when there is nothing to measure it against. */
  rate: number;
  /** Groups repeats of the same transmission together across bursts. */
  key: string;
}

/** Group widths that are within tolerance of each other, keeping only those that recur often enough. */
function cluster(v: Int32Array, n: number, spus: number): Cluster[] {
  if (n <= 0) return [];
  const us: number[] = [];
  for (let i = 0; i < n; i++) us.push(v[i] / spus);
  us.sort((a, b) => a - b);

  const groups: { sum: number; n: number }[] = [];
  let sum = us[0], count = 1;
  for (let i = 1; i < us.length; i++) {
    // Compare against the running mean, so a slow drift across the burst stays one symbol rather than splitting.
    const mean = sum / count;
    if (us[i] - mean <= mean * TOL) { sum += us[i]; count++; }
    else { groups.push({ sum, n: count }); sum = us[i]; count = 1; }
  }
  groups.push({ sum, n: count });

  const floor = Math.max(1, Math.round(us.length * MIN_SHARE));
  return groups.filter(g => g.n >= floor).map(g => ({ us: Math.round(g.sum / g.n), n: g.n }));
}

/**
 * Name the coding from the widths alone.
 *
 * The reasoning is the same one a person does by eye on a scope. One mark width and several space widths means
 * the information is in where the mark falls; the reverse means it is in how long the mark lasts. Two of each,
 * in a two-to-one ratio, is what Manchester and its relatives look like — those are not separable from the
 * timings alone, so they are named together rather than picked between.
 */
function nameCoding(mark: Cluster[], space: Cluster[]): string {
  if (!mark.length) return '';
  if (mark.length === 1 && space.length >= 2) return 'pulse position';
  if (mark.length >= 2 && space.length === 1) return 'pulse width';
  if (mark.length === 1 && space.length === 1) return 'fixed period — a preamble, or every bit the same';
  if (mark.length === 2 && space.length === 2) {
    const mr = mark[1].us / mark[0].us, sr = space[1].us / space[0].us;
    if (mr > 1.6 && mr < 2.5 && sr > 1.6 && sr < 2.5) return 'Manchester or level per bit';
    return 'two widths each way';
  }
  return '';
}

/** Measure one burst. `pulse` and `gap` are in samples, as the detector produces them. */
export function describeBurst(
  p: { pulse: Int32Array; gap: Int32Array; numPulses: number; sampleRate: number; fsk: boolean },
): BurstShape {
  const spus = p.sampleRate / 1e6;
  const n = p.numPulses;
  // The last gap is however long the receiver waited before deciding the burst had ended, which says nothing
  // about the device. Every other gap is real.
  const mark = cluster(p.pulse, n, spus);
  const space = cluster(p.gap, Math.max(0, n - 1), spus);

  let total = 0;
  for (let i = 0; i < n; i++) total += p.pulse[i];
  for (let i = 0; i < n - 1; i++) total += p.gap[i];
  const ms = total / spus / 1000;

  const coding = nameCoding(mark, space);
  // One symbol is a mark and the space after it. Averaged over the burst this is the symbol rate whatever the
  // coding turns out to be; for Manchester it is twice the bit rate, which is why it is reported as symbols.
  const rate = n > 1 ? Math.round(1e6 / (total / spus / (n - 1))) : 0;

  const sig = [
    p.fsk ? 'F' : 'O',
    mark.map(c => Math.round(c.us / 10)).join('.'),
    space.map(c => Math.round(c.us / 10)).join('.'),
    // Repeat counts wander by a pulse or two between transmissions of the same message; bucket them so they
    // group rather than filling the list with near-identical entries.
    Math.round(n / 8),
  ].join('-');

  return { fsk: p.fsk, pulses: n, ms, mark, space, coding, rate, key: sig };
}

/** The one-line reading for an unidentified burst: only measurements, in the order they answer "what was that". */
export function shapeSummary(s: BurstShape): string {
  const parts: string[] = [`${s.pulses} pulses`, `${s.ms < 10 ? s.ms.toFixed(1) : Math.round(s.ms)} ms`];
  if (s.rate) parts.push(`${s.rate >= 1000 ? `${(s.rate / 1000).toFixed(1)}k` : s.rate} sym/s`);
  if (s.mark.length) parts.push(`marks ${s.mark.map(c => c.us).join('/')} µs`);
  if (s.space.length) parts.push(`gaps ${s.space.map(c => c.us).join('/')} µs`);
  return parts.join(' · ');
}
