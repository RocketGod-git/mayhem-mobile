/**
 * Whether a channel's demodulated audio carries a voice, block by block: what makes an open channel a transmission
 * (talk time, the log, the time machine, the scan staying) rather than a steady carrier.
 *
 * FM (Repeaters): the discriminator in blocks of [SPEECH_N] samples (about 85 ms at 24 kS/s), each one's spectrum
 * turned back up by the down-converter's own response. Noise out of an FM discriminator rises with frequency, so the
 * band above any voice (5 to 8 kHz) is the block's own noise reference:
 *  - a voice, or a digital voice (P25, DMR), puts its power into 400 to 3000 Hz, [SPEECH_DB] (6 dB) and more over the
 *    noise band a Hz. A carrier with nothing on it measures under 0 dB, quieted (its noise rising with frequency) or not
 *    (the noise about flat), and so does a sub-audible tone, which sits under 400 Hz;
 *  - a CW ID is a tone keyed on and off: a bin [TONE_DB] (20 dB) over the median of 400 to 3000 Hz, counted while the
 *    last two seconds also hold a block without it. A tone that never goes off (a whistle) is not keyed.
 * Measured on real air (fixtures/hamplus/air), each threshold about 6 dB clear of both sides: the office's 420.000
 * and 29.552 / 29.520 carriers read -9 to +0.1 dB with no bin over 13.1 dB; home's WB6NXP, K7FYS and P25 voice reach
 * 19 to 37 dB, and K6VGP's CW ID 26 to 41 dB over the median while its band ratio stays near 0 dB.
 */
import { fft, hann } from '../../fft.js';

/** Samples a block, the band ratio and the keyed tone a block needs, and how long a tone must have been off. */
export const SPEECH_N = 2048, SPEECH_DB = 6, TONE_DB = 20, KEYED_BLOCKS = 24;
/** Speech blocks, within the last [SPEECH_RECENT], before an open channel is a transmission (a quarter second of voice). */
export const SPEECH_MIN = 3, SPEECH_RECENT = 16;
/** A transmission without speech this long while its carrier stays on ends at its last speech: the rest is steady. */
export const SPEECH_LAPSE_MS = 10_000;
/** How much of each block's measure is kept for the tests and the card. */
const KEEP = 2_000;

/** The count every speech meter keeps: blocks heard, those that carried a voice, and when. */
export class SpeechCount {
  blocks = 0; speech = 0;
  /** Speech blocks among the last [SPEECH_RECENT]: a voice is [SPEECH_MIN] of them, so a stray block is not. */
  recent = 0;
  /** Milliseconds into the channel (its demodulator's time) the first speech of the last run of [SPEECH_MIN] began,
   *  and the last speech block ended; -1 before any. */
  firstMs = -1; lastMs = -1;
  /** Each block's measure (dB) and whether it counted, the last [KEEP] of them. */
  readonly db: number[] = []; readonly hit: boolean[] = [];
  private readonly ring: number[] = [];
  protected mark(db: number, speech: boolean, endMs: number): void {
    this.blocks++;
    this.ring.push(speech ? endMs : -1); if (this.ring.length > SPEECH_RECENT) this.ring.shift();
    this.recent = this.ring.filter(x => x >= 0).length;
    if (speech) { this.speech++; this.lastMs = endMs; if (this.firstMs < 0 && this.recent >= SPEECH_MIN) this.firstMs = this.ring.find(x => x >= 0)!; }
    this.db.push(Math.round(db * 10) / 10); this.hit.push(speech);
    if (this.db.length > KEEP) { this.db.shift(); this.hit.shift(); }
  }
  /** A voice was heard: [SPEECH_MIN] speech blocks within [SPEECH_RECENT]. */
  get heard(): boolean { return this.firstMs >= 0; }
}

/** FM: the discriminator's voice band against the noise above it, and keyed tones. */
export class FmSpeech extends SpeechCount {
  private readonly buf = new Float32Array(SPEECH_N); private n = 0; private samples = 0;
  private readonly win = hann(SPEECH_N); private readonly re = new Float32Array(SPEECH_N); private readonly im = new Float32Array(SPEECH_N);
  private readonly v0: number; private readonly v1: number; private readonly n0: number; private readonly n1: number;
  /** Each bin's correction for the down-converter's response (1 over its power gain). */
  private readonly gain: Float32Array;
  private readonly tones: boolean[] = [];
  /** The tone level (dB over the median) of each block, the last [KEEP]. */
  readonly tone: number[] = [];
  constructor(private readonly fs: number, powerGain: (hz: number) => number) {
    super();
    const bh = fs / SPEECH_N;
    this.v0 = Math.round(400 / bh); this.v1 = Math.round(3_000 / bh); this.n0 = Math.round(5_000 / bh); this.n1 = Math.min(SPEECH_N / 2 - 1, Math.round(8_000 / bh));
    this.gain = new Float32Array(this.n1 + 1);
    for (let k = 0; k <= this.n1; k++) this.gain[k] = 1 / Math.max(1e-4, powerGain(k * bh));
  }
  push(x: Float32Array, m: number): void {
    for (let i = 0; i < m; i++) { this.buf[this.n++] = x[i]; if (this.n >= SPEECH_N) { this.samples += SPEECH_N; this.block(); this.n = 0; } }
  }
  private block(): void {
    const re = this.re, im = this.im;
    for (let k = 0; k < SPEECH_N; k++) { re[k] = this.buf[k] * this.win[k]; im[k] = 0; }
    fft(re, im);
    let v = 0, nz = 0, pk = 0; const band: number[] = [];
    for (let k = this.v0; k <= this.v1; k++) { const p = re[k] * re[k] + im[k] * im[k]; band.push(p); if (p > pk) pk = p; v += p * this.gain[k]; }
    for (let k = this.n0; k <= this.n1; k++) nz += (re[k] * re[k] + im[k] * im[k]) * this.gain[k];
    v /= this.v1 - this.v0 + 1; nz /= this.n1 - this.n0 + 1;
    band.sort((a, b) => a - b);
    const ratio = 10 * Math.log10((v + 1e-20) / (nz + 1e-20)), toneDb = 10 * Math.log10((pk + 1e-20) / (band[band.length >> 1] + 1e-20));
    const tone = toneDb >= TONE_DB, keyed = tone && this.tones.some(t => !t);
    this.tones.push(tone); if (this.tones.length > KEYED_BLOCKS) this.tones.shift();
    this.tone.push(Math.round(toneDb * 10) / 10); if (this.tone.length > KEEP) this.tone.shift();
    this.mark(ratio, ratio >= SPEECH_DB || keyed, this.samples * 1000 / this.fs);
  }
}

/**
 * CB's voice, a block of [len] samples (64 ms at 16 kS/s) at a time, against a reference only noise moves:
 *  - a carrier held (AM, or FM): the audio in line with the carrier against the floor (the quietest fifth over the
 *    last ten seconds) of the part at right angles to it. Noise puts the same power in both, so a carrier with nothing
 *    on it never stands over that floor; a voice does, AM or FM, and still does when the carrier followed is a
 *    neighbor's (both parts then carry it);
 *  - no carrier, single sideband: the side heard against the other side, the same block.
 * A block is a voice [thrDb] (6 dB) over its reference. Noise alone reads within a dB of 0 (a steady carrier, a carrier
 * that wanders, a comb line); home's real AM talkers read 5 to 12 dB through half their blocks and more, and its LSB
 * talker 7 dB at the median (fixtures/cb/real).
 */
export class RatioSpeech extends SpeechCount {
  private fa = 0; private fb = 0; private fn = 0; private sa = 0; private sb = 0; private sn = 0; private n = 0; private samples = 0;
  private readonly hist: number[] = [];
  constructor(private readonly fs: number, readonly thrDb = SPEECH_DB, private readonly len = SPEECH_N / 2) { super(); }
  /** One sample: its power in the voice and in its reference, judged against the reference's floor over time
   *  ([kind] 1, a carrier held) or the same block (2, a sideband); 0 where there is nothing to measure. */
  push(voice: number, ref: number, kind: 0 | 1 | 2): void {
    this.samples++;
    if (kind === 1) { this.fa += voice; this.fb += ref; this.fn++; } else if (kind === 2) { this.sa += voice; this.sb += ref; this.sn++; }
    if (++this.n < this.len) return;
    let db = -99;
    if (this.fn * 2 >= this.len) {
      const a = this.fa / this.fn, b = this.fb / this.fn;
      this.hist.push(b); if (this.hist.length > FLOOR_BLOCKS) this.hist.shift();
      if (this.hist.length >= FLOOR_MIN) { const f = [...this.hist].sort((x, y) => x - y)[Math.floor(this.hist.length / 5)]; db = 10 * Math.log10((a + 1e-30) / (f + 1e-30)); }
    } else if (this.sn * 2 >= this.len) db = 10 * Math.log10((this.sa + 1e-30) / (this.sb + 1e-30));
    this.mark(db, db >= this.thrDb, this.samples * 1000 / this.fs);
    this.fa = 0; this.fb = 0; this.fn = 0; this.sa = 0; this.sb = 0; this.sn = 0; this.n = 0;
  }
}
/** The carrier's reference floor: over this many blocks (about ten seconds), once it has this many (half a second). */
export const FLOOR_BLOCKS = 160, FLOOR_MIN = 8;
