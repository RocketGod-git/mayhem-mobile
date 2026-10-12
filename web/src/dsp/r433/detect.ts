/**
 * Finding transmissions in the noise, and measuring them.
 *
 * This is the front end the whole rtl_433 port stands on. It watches the envelope of the signal, keeps a running
 * estimate of what silence and what a carrier look like right now, and when the envelope crosses between them it
 * records how long each mark and space lasted. The result is a burst: a list of durations, which the slicers turn
 * into bits and the decoders turn into readings.
 *
 * It does two jobs at once. Most of these devices key the carrier on and off, so the envelope is the signal. But
 * a good number shift the frequency instead, holding the carrier up throughout — to the envelope that looks like
 * one very long mark. So while the first mark is running, a second detector watches the frequency discriminator
 * and measures the shifts there; if it finds enough of them before the carrier drops, the burst is reported as
 * frequency shift keying instead, with the discriminator's timings rather than the envelope's.
 *
 * Ported from rtl_433's `src/pulse_detect.c` and `src/pulse_detect_fsk.c` (GPL-2.0-or-later, Tommy Vestermark
 * and Christian W. Zuckschwerdt).
 */

import type { PulseData } from './slicers.js';

export const PD_MAX_PULSES = 1200;                   // stop and report rather than grow without bound
export const PD_MIN_PULSES = 16;                     // fewer shifts than this is not a frequency-keyed burst
export const PD_MIN_PULSE_SAMPLES = 10;              // anything shorter is a glitch, not a mark
export const PD_MIN_GAP_MS = 10;
export const PD_MAX_GAP_MS = 100;
export const PD_MAX_GAP_RATIO = 10;                  // a gap this many times the longest mark ends the burst

const OOK_MAX_HIGH_LEVEL = 16384;                    // 0 dB, full scale
const OOK_EST_HIGH_RATIO = 64;                       // how slowly the carrier-level estimate moves
const OOK_EST_LOW_RATIO = 1024;                      // how slowly the noise-level estimate moves — very slowly
const FSK_EST_SLOW = 64;

/**
 * Levels, in the same units the envelope arrives in: full scale is 16384.
 *
 * rtl_433 puts the minimum carrier level twelve decibels below full scale, because an rtl-sdr runs its own
 * automatic gain and delivers a signal that fills most of the range. A HackRF does not: the operator sets the
 * gain, and on a quiet antenna the whole scene can sit near the bottom of the range — a busy street corner
 * measured at a magnitude of only a few hundred out of sixteen thousand. rtl_433's fixed floor would then ask
 * for a burst thirteen decibels above that on top of the nine-decibel ratio below, so nothing but a transmitter
 * pressed against the antenna ever triggers. So the floor here is much lower, which lets the ratio to the
 * measured noise do the deciding — a burst is a carrier when it stands nine decibels above whatever the noise
 * happens to be, wherever in the range that noise sits.
 */
const OOK_MIN_HIGH_LEVEL = 600;                      // ≈ −28 dB; only a backstop, so the noise ratio governs
const OOK_HIGH_LOW_RATIO = 3;                        // 9 dB above the noise floor is the default carrier level

/** What came out of the detector. */
export const enum PulseKind { None = 0, OOK = 1, FSK = 2 }

const enum OokState { Idle, Pulse, GapStart, Gap }
const enum FskState { Init, High, Low, Error }

/** A burst under construction. */
function emptyPulses(sampleRate: number, fsk: boolean): PulseData {
  return {
    pulse: new Int32Array(PD_MAX_PULSES + 1),
    gap: new Int32Array(PD_MAX_PULSES + 1),
    numPulses: 0,
    sampleRate,
    fsk,
  };
}

function clearPulses(p: PulseData): void {
  p.pulse.fill(0);
  p.gap.fill(0);
  p.numPulses = 0;
}

/** Drop the oldest half of a full buffer rather than lose the transmission still arriving. */
function shiftPulses(p: PulseData): void {
  const offs = PD_MAX_PULSES >> 1;
  p.pulse.copyWithin(0, offs);
  p.gap.copyWithin(0, offs);
  p.numPulses -= offs;
}

/**
 * The frequency-shift half: a min/max tracker that finds the midpoint between the two tones and times the
 * crossings. The trackers decay toward each other by ten counts a sample so the midpoint follows a drifting
 * transmitter instead of being pinned by one early outlier.
 */
class FskDetect {
  varMax = -32768;
  varMin = 32767;
  state = FskState.Init;
  pulseLength = 0;
  f1Est = 0;
  f2Est = 0;
  skipSamples = 40;                                  // let the trackers converge before believing them

  reset(): void {
    this.varMax = -32768; this.varMin = 32767;
    this.state = FskState.Init; this.pulseLength = 0;
    this.f1Est = 0; this.f2Est = 0; this.skipSamples = 40;
  }

  step(fm: number, out: PulseData): void {
    if (this.skipSamples === 0) {
      if (fm > this.varMax) this.varMax = fm;
      if (fm < this.varMin) this.varMin = fm;
      const mid = ((this.varMax + this.varMin) / 2) | 0;
      if (fm > mid) this.varMax -= 10;
      if (fm < mid) this.varMin += 10;

      this.pulseLength += 1;
      switch (this.state) {
        case FskState.Init:
          // On the first sample the trackers have nothing to compare against, so the midpoint is the sample
          // itself and this always falls to the low side. That merges the first tone run into the second, and
          // is why every protocol in this family searches for a sync word rather than counting from the start.
          this.state = fm > mid ? FskState.High : FskState.Low;
          break;
        case FskState.High:
          if (fm < mid) {
            this.state = FskState.Low;
            out.pulse[out.numPulses] = this.pulseLength;
            this.pulseLength = 0;
          }
          this.f2Est += ((fm / FSK_EST_SLOW) | 0) - ((this.f2Est / FSK_EST_SLOW) | 0);
          break;
        case FskState.Low:
          if (fm > mid) {
            this.state = FskState.High;
            out.gap[out.numPulses] = this.pulseLength;
            out.numPulses += 1;
            this.pulseLength = 0;
            if (out.numPulses >= PD_MAX_PULSES) shiftPulses(out);
          }
          this.f1Est += ((fm / FSK_EST_SLOW) | 0) - ((this.f1Est / FSK_EST_SLOW) | 0);
          break;
        default:
          break;
      }
    }
    if (this.skipSamples > 0) this.skipSamples -= 1;
  }
}

/** Called once per detected burst. The buffer handed over is reused, so read it before returning. */
export type BurstFn = (kind: PulseKind, pulses: PulseData) => void;

export class PulseDetect {
  private ookState = OokState.Idle;
  private pulseLength = 0;
  private maxPulse = 0;
  private leadIn = 0;                                // wait for the noise estimate to settle before triggering
  private lowEstimate = 0;
  private highEstimate = 0;
  private readonly fsk = new FskDetect();
  private readonly ook: PulseData;
  private readonly fskPulses: PulseData;

  constructor(private sampleRate: number) {
    this.ook = emptyPulses(sampleRate, false);
    this.fskPulses = emptyPulses(sampleRate, true);
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.ook.sampleRate = rate;
    this.fskPulses.sampleRate = rate;
  }

  reset(): void {
    this.ookState = OokState.Idle;
    this.pulseLength = 0; this.maxPulse = 0; this.leadIn = 0;
    this.lowEstimate = 0; this.highEstimate = 0;
    this.fsk.reset();
    clearPulses(this.ook); clearPulses(this.fskPulses);
  }

  /**
   * Feed one block. `env` is the envelope with full scale at 16384; `fm` is the discriminator output, signed,
   * with full deviation near ±32767. Each completed burst is handed to `onBurst`.
   */
  process(env: Int16Array, fm: Int16Array, len: number, onBurst: BurstFn): void {
    const samplesPerMs = (this.sampleRate / 1000) | 0;
    let eopOnSpurious = false;
    if (this.highEstimate < OOK_MIN_HIGH_LEVEL) this.highEstimate = OOK_MIN_HIGH_LEVEL;

    let n = 0;
    while (n < len) {
      const amp = env[n];
      const threshold = ((this.lowEstimate + Math.min(this.highEstimate, OOK_MAX_HIGH_LEVEL)) / 2) | 0;
      const hysteresis = (threshold / 8) | 0;

      switch (this.ookState) {
        case OokState.Idle:
          if (amp > threshold + hysteresis && this.leadIn > OOK_EST_LOW_RATIO) {
            clearPulses(this.ook); clearPulses(this.fskPulses);
            this.pulseLength = 0; this.maxPulse = 0;
            this.fsk.reset();
            this.ookState = OokState.Pulse;
          } else {
            // Track the noise floor, and set the carrier level as a fixed ratio above it.
            const delta = amp - this.lowEstimate;
            this.lowEstimate += (delta / OOK_EST_LOW_RATIO) | 0;
            this.lowEstimate += delta > 0 ? 1 : -1;   // nudge, since the estimate has no fractional part
            this.highEstimate = Math.max(OOK_HIGH_LOW_RATIO * this.lowEstimate, OOK_MIN_HIGH_LEVEL);
            if (this.leadIn <= OOK_EST_LOW_RATIO) this.leadIn += 1;
          }
          break;

        case OokState.Pulse:
          this.pulseLength += 1;
          if (amp < threshold - hysteresis) {
            if (this.pulseLength < PD_MIN_PULSE_SAMPLES) {
              // Too short to be real. If it was the only thing we had, forget it; otherwise close the burst.
              if (this.ook.numPulses <= 1) this.ookState = OokState.Idle;
              else { eopOnSpurious = true; this.ookState = OokState.Gap; }
            } else {
              this.ook.pulse[this.ook.numPulses] = this.pulseLength;
              if (this.pulseLength > this.maxPulse) this.maxPulse = this.pulseLength;
              this.pulseLength = 0;
              this.ookState = OokState.GapStart;
            }
          } else {
            this.highEstimate += ((amp / OOK_EST_HIGH_RATIO) | 0) - ((this.highEstimate / OOK_EST_HIGH_RATIO) | 0);
            if (this.highEstimate < OOK_MIN_HIGH_LEVEL) this.highEstimate = OOK_MIN_HIGH_LEVEL;
          }
          if (this.ook.numPulses === 0) this.fsk.step(fm[n], this.fskPulses);
          break;

        case OokState.GapStart:
          this.pulseLength += 1;
          if (amp > threshold + hysteresis) {
            // The carrier came back straight away: that dip was noise, not a real space.
            this.pulseLength += this.ook.pulse[this.ook.numPulses];
            this.ookState = OokState.Pulse;
          } else if (this.pulseLength >= PD_MIN_PULSE_SAMPLES) {
            this.ookState = OokState.Gap;
            if (this.fskPulses.numPulses > PD_MIN_PULSES) {
              // The frequency detector found a real signal inside what the envelope called one long mark.
              this.ookState = OokState.Idle;
              onBurst(PulseKind.FSK, this.fskPulses);
              eopOnSpurious = false;
              continue;                              // re-read this sample with the state now reset
            }
          }
          if (this.ook.numPulses === 0) this.fsk.step(fm[n], this.fskPulses);
          break;

        case OokState.Gap:
          this.pulseLength += 1;
          if (amp > threshold + hysteresis) {
            this.ook.gap[this.ook.numPulses] = this.pulseLength;
            this.ook.numPulses += 1;
            if (this.ook.numPulses >= PD_MAX_PULSES) {
              this.ookState = OokState.Idle;
              onBurst(PulseKind.OOK, this.ook);
              eopOnSpurious = false;
              continue;
            }
            this.pulseLength = 0;
            this.ookState = OokState.Pulse;
          }
          // The burst is over once the silence is long both in absolute terms and next to the marks we saw.
          if (eopOnSpurious
            || (this.pulseLength > PD_MAX_GAP_RATIO * this.maxPulse && this.pulseLength > PD_MIN_GAP_MS * samplesPerMs)
            || this.pulseLength > PD_MAX_GAP_MS * samplesPerMs) {
            this.ook.gap[this.ook.numPulses] = this.pulseLength;
            this.ook.numPulses += 1;
            this.ookState = OokState.Idle;
            onBurst(PulseKind.OOK, this.ook);
            eopOnSpurious = false;
            continue;
          }
          break;
      }
      n += 1;
    }
  }

  /** Close whatever is in flight, at the end of a recording or when retuning. */
  /**
   * The levels the trigger is working with right now, so the interface can show why it is or is not firing:
   * the noise floor it has settled on, and the magnitude a burst has to exceed to count as a carrier.
   */
  levels(): { noise: number; trigger: number } {
    const threshold = ((this.lowEstimate + Math.min(this.highEstimate, OOK_MAX_HIGH_LEVEL)) / 2) | 0;
    return { noise: this.lowEstimate | 0, trigger: (threshold + ((threshold / 8) | 0)) | 0 };
  }

  flush(onBurst: BurstFn): void {
    if (this.ookState === OokState.Idle) return;
    if (this.ookState === OokState.Pulse) {
      if (this.pulseLength < PD_MIN_PULSE_SAMPLES) {
        if (this.ook.numPulses <= 1) { this.ookState = OokState.Idle; return; }
        this.ookState = OokState.Gap;
      } else {
        this.ook.pulse[this.ook.numPulses] = this.pulseLength;
        if (this.pulseLength > this.maxPulse) this.maxPulse = this.pulseLength;
        this.pulseLength = 0;
        this.ookState = OokState.GapStart;
      }
    }
    if (this.ookState === OokState.GapStart) {
      this.ookState = OokState.Gap;
      if (this.fskPulses.numPulses > PD_MIN_PULSES) {
        this.ookState = OokState.Idle;
        onBurst(PulseKind.FSK, this.fskPulses);
        return;
      }
    }
    if (this.ookState === OokState.Gap) {
      this.ook.gap[this.ook.numPulses] = this.pulseLength;
      this.ook.numPulses += 1;
      this.ookState = OokState.Idle;
      onBurst(PulseKind.OOK, this.ook);
    }
  }
}
