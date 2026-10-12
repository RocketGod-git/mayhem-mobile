/**
 * Pulse slicers: turning a burst of measured pulses into rows of bits.
 *
 * The front end gives us a list of (mark, space) durations in samples. Each slicer reads that list the way one
 * family of protocols encodes bits into it — pulse width, pulse position, level per bit period, and so on — and
 * fills a bit buffer, calling back at the end of each message so the decoder can look at it.
 *
 * Ported from rtl_433's `src/pulse_slicer.c` (GPL-2.0-or-later, Tommy Vestermark and contributors). The
 * arithmetic is kept identical, including where C truncates toward zero rather than rounding, because the
 * boundary cases are exactly where a sensor at the edge of range is either read or lost.
 */

import { BitBuffer } from './bitbuffer.js';
import { Modulation, type RDevice } from './device.js';

/** A burst as the front end measured it: alternating mark and space durations, in samples. */
export interface PulseData {
  /** Duration of each mark, in samples. */
  pulse: Int32Array;
  /** Duration of the space following each mark, in samples. The last one is however long the burst was quiet. */
  gap: Int32Array;
  numPulses: number;
  sampleRate: number;
  /** True when these came from the frequency discriminator rather than the envelope. */
  fsk: boolean;
}

/** Called at the end of each message: run the decoder, then clear the buffer for the next one. */
export type Account = (bits: BitBuffer) => number;

const INT_MAX = 0x7fffffff;

/** C's `(int)x`: truncation toward zero, which is not the same as `Math.floor` for negatives. */
const trunc = (x: number) => (x < 0 ? Math.ceil(x) : Math.floor(x));

/** The timings converted from microseconds to samples, or null when the sample rate is too low to represent them. */
interface Widths { sShort: number; sLong: number; sReset: number; sGap: number; sSync: number; sTol: number }

function widths(pulses: PulseData, dev: RDevice): Widths | null {
  const spus = pulses.sampleRate / 1e6;
  const w: Widths = {
    sShort: trunc(dev.shortWidth * spus),
    sLong: trunc(dev.longWidth * spus),
    sReset: trunc(dev.resetLimit * spus),
    sGap: trunc((dev.gapLimit ?? 0) * spus),
    sSync: trunc((dev.syncWidth ?? 0) * spus),
    sTol: trunc((dev.tolerance ?? 0) * spus),
  };
  // A timing that rounds away to nothing means this protocol cannot be resolved at the rate we are sampling.
  if ((dev.shortWidth > 0 && w.sShort <= 0)
    || (dev.longWidth > 0 && w.sLong <= 0)
    || (dev.resetLimit > 0 && w.sReset <= 0)
    || ((dev.gapLimit ?? 0) > 0 && w.sGap <= 0)
    || ((dev.syncWidth ?? 0) > 0 && w.sSync <= 0)
    || ((dev.tolerance ?? 0) > 0 && w.sTol <= 0)) return null;
  return w;
}

/**
 * Non-return-to-zero and return-to-zero: the level itself is the bit, held for one bit period.
 *
 * The interesting part is the bit period. A transmitter's clock is only as good as its resonator, so before
 * slicing anything this measures the actual period from a run of alternating bits — a preamble if there is one,
 * otherwise every bit in the burst that already looks right — and slices with that instead of the nominal value.
 * Over a long message the difference between the nominal and the real period is what decides whether the last
 * byte lands in the right place.
 */
export function pulseSlicerPcm(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sLong, sReset } = w;
  let sTol = w.sTol;

  // Reciprocals of the bit period, so slicing is a multiply. These are what the measurement below refines.
  let fShort = dev.shortWidth > 0 ? 1 / (dev.shortWidth * (pulses.sampleRate / 1e6)) : 0;
  let fLong = dev.longWidth > 0 ? 1 / (dev.longWidth * (pulses.sampleRate / 1e6)) : 0;

  let events = 0;
  const bits = new BitBuffer();

  const gapLimit = w.sGap ? w.sGap : sReset;
  const maxZeros = trunc(gapLimit / sLong);
  if (sTol <= 0) sTol = trunc(sLong / 4);            // default tolerance is a quarter of a bit period

  let minCount = sShort === sLong ? 12 : 4;
  let preambleLen = 0;

  // Return-to-zero: look for a run of bit-wide toggles and take the period from it.
  for (let n = 0; sShort !== sLong && n < pulses.numPulses; ++n) {
    let swidth = 0, lwidth = 0, count = 0;
    while (n < pulses.numPulses
      && pulses.pulse[n] >= sShort - sTol && pulses.pulse[n] <= sShort + sTol
      && pulses.pulse[n] + pulses.gap[n] >= sLong - sTol
      && pulses.pulse[n] + pulses.gap[n] <= sLong + sTol) {
      swidth += pulses.pulse[n];
      lwidth += pulses.pulse[n] + pulses.gap[n];
      count += 1;
      n++;
    }
    if (count >= minCount) {
      fLong = count / lwidth;
      fShort = count / swidth;
      minCount = count;
      preambleLen = count;
    }
  }
  // No preamble found: average every bit anywhere in the burst that is already close enough.
  let rzsWidth = 0, rzlWidth = 0, rzCount = 0;
  for (let n = 0; preambleLen === 0 && sShort !== sLong && n < pulses.numPulses; ++n) {
    if (pulses.pulse[n] >= sShort - sTol && pulses.pulse[n] <= sShort + sTol
      && pulses.pulse[n] + pulses.gap[n] >= sLong - sTol
      && pulses.pulse[n] + pulses.gap[n] <= sLong + sTol) {
      rzsWidth += pulses.pulse[n];
      rzlWidth += pulses.pulse[n] + pulses.gap[n];
      rzCount += 1;
    }
  }
  if (rzCount > 8) { fLong = rzCount / rzlWidth; fShort = rzCount / rzsWidth; }

  // Non-return-to-zero: the same idea, but a bit is a whole mark-space pair with no gap of its own.
  for (let n = 0; sShort === sLong && n < pulses.numPulses; ++n) {
    let width = 0, count = 0;
    while (n < pulses.numPulses
      && trunc(pulses.pulse[n] * fShort + 0.5) === 1
      && trunc(pulses.gap[n] * fLong + 0.5) === 1) {
      width += pulses.pulse[n] + pulses.gap[n];
      count += 2;
      n++;
    }
    if (count >= minCount) {
      fShort = fLong = count / width;
      minCount = count;
      preambleLen = count;
    }
  }
  let nrzWidth = 0, nrzCount = 0;
  for (let n = 0; preambleLen === 0 && sShort === sLong && n < pulses.numPulses; ++n) {
    if (pulses.pulse[n] >= sShort - sTol && pulses.pulse[n] <= sShort + sTol) { nrzWidth += pulses.pulse[n]; nrzCount += 1; }
    if (pulses.pulse[n] >= 2 * sShort - sTol && pulses.pulse[n] <= 2 * sShort + sTol) { nrzWidth += pulses.pulse[n]; nrzCount += 2; }
    if (pulses.gap[n] >= sLong - sTol && pulses.gap[n] <= sLong + sTol) { nrzWidth += pulses.gap[n]; nrzCount += 1; }
    if (pulses.gap[n] >= 2 * sLong - sTol && pulses.gap[n] <= 2 * sLong + sTol) { nrzWidth += pulses.gap[n]; nrzCount += 2; }
  }
  if (nrzCount > 20) fShort = fLong = nrzCount / nrzWidth;

  for (let n = 0; n < pulses.numPulses; ++n) {
    const highs = trunc(pulses.pulse[n] * fShort + 0.5);
    // For return-to-zero the nominal gap belongs to the bit itself, so take it back off before counting zeros.
    let lows = trunc((pulses.gap[n] + sShort - sLong) * fLong + 0.5);

    for (let i = 0; i < highs; ++i) bits.addBit(1);
    lows = Math.min(lows, maxZeros);                 // do not run off the end of the message into the silence
    for (let i = 0; i < lows; ++i) bits.addBit(0);

    if (sShort !== sLong && Math.abs(pulses.pulse[n] - sShort) > sTol) {
      bits.clear();                                  // a mark of the wrong length: the message is corrupt
    } else if (pulses.gap[n] > gapLimit && pulses.gap[n] <= sReset) {
      bits.addRow();                                 // a gap this long separates messages, not bits
    }

    if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset)
      && (bits.bitsPerRow[0] > 0 || bits.numRows > 1)) {
      events += account(bits);
    }
  }
  return events;
}

/** Pulse position: every mark is the same, and the gap after it says whether the bit was a one. */
export function pulseSlicerPpm(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sLong, sReset, sGap, sSync, sTol } = w;

  let events = 0;
  const bits = new BitBuffer();

  // Bounds are exclusive at both ends, matching the reference.
  let zeroL: number, zeroU: number, oneL: number, oneU: number, syncL = 0, syncU = 0;
  if (sTol > 0) {
    zeroL = sShort - sTol; zeroU = sShort + sTol;
    oneL = sLong - sTol; oneU = sLong + sTol;
    if (sSync > 0) { syncL = sSync - sTol; syncU = sSync + sTol; }
  } else {
    zeroL = 0;
    zeroU = trunc((sShort + sLong) / 2) + 1;
    oneL = zeroU - 1;
    oneU = sGap ? sGap : sReset;
  }

  for (let n = 0; n < pulses.numPulses; ++n) {
    if (pulses.gap[n] > zeroL && pulses.gap[n] < zeroU) bits.addBit(0);
    else if (pulses.gap[n] > oneL && pulses.gap[n] < oneU) bits.addBit(1);
    else if (pulses.gap[n] > syncL && pulses.gap[n] < syncU) bits.addSync();
    else if (pulses.gap[n] < sReset) bits.addRow();

    if ((n === pulses.numPulses - 1 || pulses.gap[n] >= sReset)
      && (bits.bitsPerRow[0] > 0 || bits.numRows > 1)) {
      events += account(bits);
    }
  }
  return events;
}

/**
 * Pulse width: the gaps are all the same and the length of the mark is the bit. A short mark is a one.
 *
 * A sync pulse can be shorter than both, between them, or longer than both, and each case moves the decision
 * boundaries somewhere different — hence the four-way split below rather than one set of thresholds.
 */
export function pulseSlicerPwm(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sLong, sReset, sGap, sSync, sTol } = w;

  let events = 0;
  const bits = new BitBuffer();

  let oneL: number, oneU: number, zeroL: number, zeroU: number, syncL = 0, syncU = 0;
  if (sTol > 0) {
    // Explicit tolerance: accept only marks close to a named width, reject everything else.
    oneL = sShort - sTol; oneU = sShort + sTol;
    zeroL = sLong - sTol; zeroU = sLong + sTol;
    if (sSync > 0) { syncL = sSync - sTol; syncU = sSync + sTol; }
  } else if (sSync <= 0) {
    // No sync: split the difference between short and long.
    oneL = 0; oneU = trunc((sShort + sLong) / 2) + 1;
    zeroL = oneU - 1; zeroU = INT_MAX;
  } else if (sSync < sShort) {
    // sync, then one, then zero.
    syncL = 0; syncU = trunc((sSync + sShort) / 2) + 1;
    oneL = syncU - 1; oneU = trunc((sShort + sLong) / 2) + 1;
    zeroL = oneU - 1; zeroU = INT_MAX;
  } else if (sSync < sLong) {
    // one, then sync, then zero.
    oneL = 0; oneU = trunc((sShort + sSync) / 2) + 1;
    syncL = oneU - 1; syncU = trunc((sSync + sLong) / 2) + 1;
    zeroL = syncU - 1; zeroU = INT_MAX;
  } else {
    // one, then zero, then sync.
    oneL = 0; oneU = trunc((sShort + sLong) / 2) + 1;
    zeroL = oneU - 1; zeroU = trunc((sLong + sSync) / 2) + 1;
    syncL = zeroU - 1; syncU = INT_MAX;
  }

  for (let n = 0; n < pulses.numPulses; ++n) {
    const p = pulses.pulse[n];
    if (p > oneL && p < oneU) bits.addBit(1);
    else if (p > zeroL && p < zeroU) bits.addBit(0);
    else if (p > syncL && p < syncU) bits.addSync();
    else if (p <= oneL) { /* a spurious short mark: ignore it rather than break the row */ }
    else bits.addRow();                              // outside every window: start again

    if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset) && bits.numRows > 0) {
      events += account(bits);
    } else if (sGap > 0 && pulses.gap[n] > sGap && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) {
      bits.addRow();                                 // next repeat of the same message
    }
  }
  return events;
}

/**
 * Manchester with a hardcoded leading zero, the coding Oregon Scientific and much else use.
 *
 * The bit is in the direction of the transition at the middle of each period: falling is a one, rising a zero.
 * Rather than tracking a clock, this counts time since the last recorded bit and calls anything longer than one
 * and a half short-widths a data edge — which is the same decision, made without needing to stay in phase.
 */
export function pulseSlicerManchesterZerobit(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sReset, sTol } = w;

  let events = 0;
  let timeSinceLast = 0;
  const bits = new BitBuffer();

  bits.addBit(0);                                    // the first rising edge always counts as a zero

  for (let n = 0; n < pulses.numPulses; ++n) {
    if (sTol > 0
      && (pulses.pulse[n] < sShort - sTol || pulses.pulse[n] > sShort * 2 + sTol
        || pulses.gap[n] < sShort - sTol || pulses.gap[n] > sShort * 2 + sTol)) {
      if (pulses.pulse[n] > sShort * 1.5 && pulses.pulse[n] <= sShort * 2 + sTol) {
        bits.addBit(1);                              // a long final mark carries one more one before the break
      }
      bits.addRow();
      bits.addBit(0);
      timeSinceLast = 0;
    } else if (pulses.pulse[n] + timeSinceLast > sShort * 1.5) {
      bits.addBit(1);                                // falling edge, far enough from the last bit to be a data edge
      timeSinceLast = 0;
    } else {
      timeSinceLast += pulses.pulse[n];
    }

    if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset) && bits.numRows > 0) {
      events += account(bits);
      bits.addBit(0);
      timeSinceLast = 0;
    } else if (pulses.gap[n] + timeSinceLast > sShort * 1.5) {
      bits.addBit(0);                                // rising edge
      timeSinceLast = 0;
    } else {
      timeSinceLast += pulses.gap[n];
    }
  }
  return events;
}

/** Marks and spaces read as one alternating stream, which is what the level-per-bit codings need. */
function symbolAt(pulses: PulseData, n: number): number {
  return n % 2 === 0 ? pulses.pulse[n >> 1] : pulses.gap[n >> 1];
}

/**
 * Differential Manchester: a one is half a period at each level, a zero is a whole period at one level.
 * So a short symbol is a one and must be followed by its partner; a long symbol is a zero on its own.
 */
export function pulseSlicerDmc(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sLong, sReset, sTol } = w;

  const bits = new BitBuffer();
  let events = 0;
  const total = pulses.numPulses * 2;

  for (let n = 0; n < total; ++n) {
    let symbol = symbolAt(pulses, n);

    if (Math.abs(symbol - sShort) < sTol) {
      bits.addBit(1);
      symbol = n + 1 < total ? symbolAt(pulses, ++n) : 0;
      if (Math.abs(symbol - sShort) > sTol) {
        if (symbol >= sReset - sTol) n--;            // end of message: there is no partner half to consume
        else if (bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) bits.addRow();
      }
    } else if (Math.abs(symbol - sLong) < sTol) {
      bits.addBit(0);
    } else if (symbol >= sReset - sTol && bits.numRows > 0) {
      events += account(bits);
    }
  }
  return events;
}

/**
 * Pulse interval width, raw: the level flips for every bit, and the interval says how many of that bit there are.
 * A run of like bits therefore shows up as one long interval rather than several short ones.
 */
export function pulseSlicerPiwmRaw(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sLong, sReset, sTol } = w;
  const fShort = dev.shortWidth > 0 ? 1 / (dev.shortWidth * (pulses.sampleRate / 1e6)) : 0;

  const bits = new BitBuffer();
  let events = 0;
  const total = pulses.numPulses * 2;

  for (let n = 0; n < total; ++n) {
    const symbol = symbolAt(pulses, n);
    let count = trunc(symbol * fShort + 0.5);
    if (symbol > sLong) {
      bits.addRow();
    } else if (Math.abs(symbol - count * sShort) < sTol) {
      for (; count > 0; --count) bits.addBit(1 - (n % 2));
    } else if (symbol < sReset && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) {
      bits.addRow();
    }

    if ((n === total - 1 || symbol > sReset) && bits.numRows > 0) {
      events += account(bits);
    }
  }
  return events;
}

/** Pulse interval width with a distinct clock: a short interval is a one, a long one a zero, level ignored. */
export function pulseSlicerPiwmDc(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sLong, sReset, sTol } = w;

  const bits = new BitBuffer();
  let events = 0;
  const total = pulses.numPulses * 2;

  for (let n = 0; n < total; ++n) {
    const symbol = symbolAt(pulses, n);
    if (Math.abs(symbol - sShort) < sTol) bits.addBit(1);
    else if (Math.abs(symbol - sLong) < sTol) bits.addBit(0);
    else if (symbol < sReset && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) bits.addRow();

    if ((n === total - 1 || symbol > sReset) && bits.numRows > 0) {
      events += account(bits);
    }
  }
  return events;
}

/** NRZ-S: the mark length counts ones, and every mark is closed by a zero. */
export function pulseSlicerNrzs(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort: limit, sReset } = w;

  let events = 0;
  const bits = new BitBuffer();

  for (let n = 0; n < pulses.numPulses; ++n) {
    if (pulses.pulse[n] > limit) {
      for (let i = 0; i < trunc(pulses.pulse[n] / limit); i++) bits.addBit(1);
      bits.addBit(0);
    } else if (pulses.pulse[n] < limit) {
      bits.addBit(0);
    }
    if (n === pulses.numPulses - 1 || pulses.gap[n] >= sReset) events += account(bits);
  }
  return events;
}

/**
 * Return to zero, inverted: the carrier sits high, and a brief dip marks a zero.
 *
 * The line is high by default, so a run of ones is simply a long high period and is counted by dividing that
 * length by the bit period. A zero is the short dip. That makes the first pulse of a message a special case -
 * there is no preceding dip to measure from, so its run is counted from its own start rather than from a
 * baseline, which is what `atStart` tracks.
 *
 * Ported from rtl_433's `pulse_slicer_rzi` (GPL-2.0-or-later).
 */
export function pulseSlicerRzi(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sLong, sReset } = w;
  // The tail of high that belongs to a zero's own bit period, and so is not part of the ones that follow it.
  const sBase = sLong - sShort;
  const half = trunc(sLong / 2);

  let events = 0;
  const bits = new BitBuffer();
  let atStart = true;

  for (let n = 0; n < pulses.numPulses; ++n) {
    const high = pulses.pulse[n];
    let ones = atStart ? trunc((high + half) / sLong) : trunc((high - sBase + half) / sLong);
    atStart = false;
    if (ones < 0) ones = 0;
    for (let k = 0; k < ones; ++k) bits.addBit(1);

    if (pulses.gap[n] > sReset || n === pulses.numPulses - 1) {
      if (bits.bitsPerRow[0] > 0) events += account(bits);
      atStart = true;
      continue;
    }
    // Any gap short of the reset limit is this coding's only kind of gap: the dip marking a zero.
    bits.addBit(0);
  }
  return events;
}

/**
 * Oregon Scientific's first-generation coding, which is Manchester on an unusual clock.
 *
 * It insists on exactly twelve preamble pulses followed by a sync far longer than a half-bit, and only then
 * does data start — so a burst that does not open that way is rejected outright rather than searched. The
 * awkward part is that the sync gap is itself long enough to carry the first data bit whenever that bit is a
 * zero, so it has to be examined before the loop proper begins.
 *
 * Bits are counted rather than clocked: `manbit` flips on every half-period seen, and a bit is recorded only
 * on alternate flips, with an extra flip whenever a mark or space runs longer than one and a half half-bits.
 * That is the same decision a clocked decoder makes, without needing to stay in phase.
 */
export function pulseSlicerOsv1(pulses: PulseData, dev: RDevice, account: Account): number {
  const w = widths(pulses, dev);
  if (!w) return 0;
  const { sShort, sReset } = w;

  const halfbitMin = trunc(sShort / 2);
  const halfbitMax = trunc((sShort * 3) / 2);
  const syncMin = 2 * halfbitMax;

  let events = 0;
  let manbit = 0;
  const bits = new BitBuffer();

  // Preamble: twelve pulses, each with a mark and a space of at least half a bit, ending on a longer space.
  let n = 0;
  let preamble = 0;
  for (; n < pulses.numPulses; ++n) {
    if (pulses.pulse[n] > halfbitMin && pulses.gap[n] > halfbitMin) {
      preamble++;
      if (pulses.gap[n] > halfbitMax) break;
    } else {
      return events;
    }
  }
  if (preamble !== 12) return events;

  // Sync: both halves far longer than a bit.
  ++n;
  if (n >= pulses.numPulses || pulses.pulse[n] < syncMin || pulses.gap[n] < syncMin) return events;

  // The sync gap doubles as the first data bit when that bit is a zero.
  if (pulses.gap[n] > pulses.pulse[n]) {
    manbit ^= 1;
    if (manbit) bits.addBit(0);
  }

  for (n++; n < pulses.numPulses; ++n) {
    manbit ^= 1;
    if (manbit) bits.addBit(1);
    if (pulses.pulse[n] > halfbitMax) {
      manbit ^= 1;
      if (manbit) bits.addBit(1);
    }

    if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset) && bits.numRows > 0) {
      events += account(bits);
      return events;
    }

    manbit ^= 1;
    if (manbit) bits.addBit(0);
    if (pulses.gap[n] > halfbitMax) {
      manbit ^= 1;
      if (manbit) bits.addBit(0);
    }
  }
  return events;
}

/** Run the slicer this protocol asks for. */
export function slice(pulses: PulseData, dev: RDevice, account: Account): number {
  switch (dev.modulation) {
    case Modulation.OOK_PCM:
    case Modulation.FSK_PCM:
      return pulseSlicerPcm(pulses, dev, account);
    case Modulation.OOK_PPM:
      return pulseSlicerPpm(pulses, dev, account);
    case Modulation.OOK_PWM:
    case Modulation.FSK_PWM:
      return pulseSlicerPwm(pulses, dev, account);
    case Modulation.OOK_MANCHESTER_ZEROBIT:
    case Modulation.FSK_MANCHESTER_ZEROBIT:
      return pulseSlicerManchesterZerobit(pulses, dev, account);
    case Modulation.OOK_DMC:
      return pulseSlicerDmc(pulses, dev, account);
    case Modulation.OOK_PIWM_RAW:
      return pulseSlicerPiwmRaw(pulses, dev, account);
    case Modulation.OOK_PIWM_DC:
      return pulseSlicerPiwmDc(pulses, dev, account);
    case Modulation.OOK_NRZS:
      return pulseSlicerNrzs(pulses, dev, account);
    case Modulation.OOK_RZI:
      return pulseSlicerRzi(pulses, dev, account);
    case Modulation.OOK_PWM_OSV1:
      return pulseSlicerOsv1(pulses, dev, account);
    default:
      return 0;
  }
}
