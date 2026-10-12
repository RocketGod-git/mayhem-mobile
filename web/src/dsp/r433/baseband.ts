/**
 * From raw samples to the two streams the pulse detector reads.
 *
 * The envelope is how loud the signal is, moment to moment — that is the whole signal for a device that keys its
 * carrier on and off. The discriminator output is how far the frequency has moved from center, which is the whole
 * signal for a device that shifts frequency instead. Both are produced for every sample, because until a burst
 * has been examined there is no telling which kind it is.
 *
 * Neither is channelized: the envelope covers whatever slice of spectrum is being listened across, all at once,
 * which is how rtl_433 works and is what lets one receiver hear every device in a band without being told which
 * to expect. These things transmit for a few milliseconds a minute, so two landing on top of each other is rare
 * enough to ignore.
 *
 * How wide that slice is, though, is not free — every megahertz of it brings its own noise. See `decim` below,
 * which is worth about five decibels and is usually the difference between hearing a device and staring at an
 * empty list.
 *
 * Ported from rtl_433's `src/baseband.c` (GPL-2.0-or-later), in floating point rather than fixed.
 */

/** A one-pole low-pass, `butter(1, 0.05)`: about twenty samples to settle, which smooths the envelope's noise. */
const ENV_A1 = 0.85408, ENV_B0 = 0.07296;
/** `butter(1, 0.2)`: five samples, the setting rtl_433 uses with this style of tone detector. */
const FM_A1 = 0.50953, FM_B0 = 0.24524;

/**
 * Arctangent to about one part in ten thousand, which is far finer than the tone detector can use, and several
 * times quicker than the library call — this runs on every sample of a two megahertz stream.
 */
function fastAtan2(y: number, x: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  const a = Math.min(ax, ay) / (Math.max(ax, ay) + 1e-20);
  const s = a * a;
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = 1.57079637 - r;
  if (x < 0) r = 3.14159274 - r;
  return y < 0 ? -r : r;
}

export class Baseband {
  private env = new Int16Array(0);
  private fm = new Int16Array(0);
  // Filter memory, carried across chunks so the boundaries are not audible to the detector.
  private envX = 0; private envY = 0;
  private xr = 0; private xi = 0; private xf = 0; private yf = 0;
  // The decimator's state, likewise carried across chunk boundaries: two integrators and two combs per
  // channel. Averaging groups of samples once leaves a lot of out-of-band noise to fold back in when the rate
  // drops; running the average twice — a triangular weighting rather than a flat one — rejects a good deal
  // more of it for two more additions a sample.
  private i1 = 0; private i2 = 0; private q1 = 0; private q2 = 0;
  private c1i = 0; private c2i = 0; private c1q = 0; private c2q = 0;
  private accN = 0;

  /**
   * How many input samples are averaged into one. Set from the span the app wants to listen across.
   *
   * This is the single biggest thing standing between a weak sensor and a decode. The envelope detector has no
   * idea what frequency anything is on — it sees the loudness of the whole sampled span at once, so every
   * megahertz of that span contributes its own noise. Noise magnitude grows with the square root of bandwidth,
   * which means listening across two megahertz rather than a quarter of one costs about nine decibels of
   * sensitivity for every device in the band.
   *
   * rtl_433 sidesteps this by asking the radio for 250 kHz in the first place. A HackRF cannot go below two
   * megahertz, so the narrowing is done here instead: average groups of samples together and the wanted signal
   * survives while the noise between samples partly cancels. Doing it before the magnitude and the arctangent
   * also divides the work of both by the same factor, so a narrower span is cheaper as well as more sensitive.
   *
   * The cost is coverage: at a quarter of a megahertz only devices within about 125 kHz of the dial are heard.
   * Almost everything on 433.92 sits close enough; a band-wide sweep needs the wider setting.
   *
   * Measured rather than assumed: going from two megahertz to a quarter of one lets the detector find a burst
   * about five decibels fainter. That is short of the nine the bandwidth arithmetic promises, because
   * decimating cannot reject everything that folds back in — `test/r433.mjs` measures it and would notice a
   * regression.
   */
  decim = 1;

  reset(): void {
    this.envX = 0; this.envY = 0;
    this.xr = 0; this.xi = 0; this.xf = 0; this.yf = 0;
    this.i1 = 0; this.i2 = 0; this.q1 = 0; this.q2 = 0;
    this.c1i = 0; this.c2i = 0; this.c1q = 0; this.c2q = 0;
    this.accN = 0;
  }

  /**
   * Convert one chunk. Returns the two streams and how many samples they hold; both are reused between calls,
   * so read them before calling again. With decimation the count is smaller than the chunk it came from.
   */
  process(iq: Int8Array): { env: Int16Array; fm: Int16Array; n: number } {
    const total = iq.length >> 1;
    const decim = this.decim < 1 ? 1 : this.decim | 0;
    const cap = Math.ceil((total + decim) / decim);
    if (this.env.length < cap) { this.env = new Int16Array(cap); this.fm = new Int16Array(cap); }
    const env = this.env, fm = this.fm;

    let ex = this.envX, ey = this.envY;
    let x1r = this.xr, x1i = this.xi, x1f = this.xf, y1f = this.yf;
    let i1 = this.i1, i2 = this.i2, q1 = this.q1, q2 = this.q2;
    let c1i = this.c1i, c2i = this.c2i, c1q = this.c1q, c2q = this.c2q;
    let accN = this.accN;
    const gain = decim * decim;
    let n = 0;

    for (let s = 0; s < total; s++) {
      // Integrate every sample; take a difference of differences once per output. The signal adds coherently
      // through the integrators, the noise does not, which is where the sensitivity comes from. At a
      // decimation of one this reduces exactly to a pass-through, so there is no second code path to keep
      // honest — and no branch to make the hot loop guess about its own types.
      //
      // Everything here is deliberately kept to thirty-two-bit integers. The integrators are running sums and
      // would otherwise grow without bound; in floating point that quietly loses precision after a few minutes
      // of listening. Allowed to wrap instead, the differences that follow come out exact, because eight-bit
      // samples through two stages need only fourteen bits of headroom.
      i1 = (i1 + iq[2 * s]) | 0; i2 = (i2 + i1) | 0;
      q1 = (q1 + iq[2 * s + 1]) | 0; q2 = (q2 + q1) | 0;
      if (++accN < decim) continue;
      accN = 0;
      const d1i = (i2 - c1i) | 0; c1i = i2;
      const d2i = (d1i - c2i) | 0; c2i = d1i;
      const d1q = (q2 - c1q) | 0; c1q = q2;
      const d2q = (d1q - c2q) | 0; c2q = d1q;
      const ir = d2i / gain, ii = d2q / gain;

      const i = n++;

      // Magnitude without a square root: 122/128 of the larger component plus 51/128 of the smaller is within
      // four per cent of the true value everywhere, and full scale lands on 16384 as the detector expects.
      const ax = ir < 0 ? -ir : ir, ay = ii < 0 ? -ii : ii;
      const mag = ax > ay ? 122 * ax + 51 * ay : 122 * ay + 51 * ax;
      ey = ENV_A1 * ey + ENV_B0 * (mag + ex);
      ex = mag;
      env[i] = ey > 32767 ? 32767 : ey;

      // Frequency is the angle this sample turned through relative to the last one, which is the argument of
      // the current sample times the conjugate of the previous.
      const pr = ir * x1r + ii * x1i;
      const pi = ii * x1r - ir * x1i;
      const x0f = fastAtan2(pi, pr) * 10430.378;      // radians to a signed sixteen-bit scale
      y1f = FM_A1 * y1f + FM_B0 * (x0f + x1f);
      x1f = x0f;
      x1r = ir; x1i = ii;
      fm[i] = y1f > 32767 ? 32767 : y1f < -32768 ? -32768 : y1f;
    }

    this.envX = ex; this.envY = ey;
    this.xr = x1r; this.xi = x1i; this.xf = x1f; this.yf = y1f;
    this.i1 = i1; this.i2 = i2; this.q1 = q1; this.q2 = q2;
    this.c1i = c1i; this.c2i = c2i; this.c1q = c1q; this.c2q = c2q;
    this.accN = accN;
    return { env, fm, n };
  }
}
