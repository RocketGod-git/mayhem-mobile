/**
 * What the app needs from a radio, so it can drive more than one.
 *
 * A HackRF and an RTL-SDR are not interchangeable and pretending otherwise would only move the surprise from
 * connect time to the middle of a session. They differ in what they can tune, how fast they can sample, how
 * their gain is arranged, and whether they can transmit at all. So each one declares its limits and the app
 * asks, rather than trying something and reading the wreckage afterwards.
 */

export type RadioKind = 'hackrf' | 'rtlsdr';

/** The envelope a radio will work inside. Everything here is hardware, not preference. */
export interface RadioLimits {
  minHz: number;
  maxHz: number;
  /** Sample rates the part will accept, as inclusive ranges in hertz. */
  rates: [number, number][];
  canTransmit: boolean;
  /**
   * The widest span the views open at on their own: clean across its whole width and with no dropped buffers. An
   * app that needs more can still ask for any rate in [rates].
   */
  cleanRate?: number;
}

/** The widest rate a view should open at on this radio (see [RadioLimits.cleanRate]). */
export function cleanWidest(r: RadioLimits): number {
  const widest = Math.max(...r.rates.map(([, hi]) => hi));
  return Math.min(widest, r.cleanRate ?? widest);
}

/** Where samples and news about the radio go. Both drivers emit signed eight-bit IQ, whatever the wire carries. */
export interface RadioEvents {
  onIq: (buf: Int8Array) => void;
  onLog: (line: string) => void;
  onStatus: (line: string) => void;
}

export interface Radio {
  readonly kind: RadioKind;
  /** What to call it on screen, once bring-up has found out what it actually is. */
  readonly label: string;
  readonly limits: RadioLimits;
  targetFreqHz: number;
  targetRateHz: number;
  running: boolean;
  open(): Promise<void>;
  run(): Promise<void>;
  stop(): void;
  /**
   * Gain, in the three terms the interface offers. A radio that has fewer knobs than this maps them onto what
   * it does have and says so in its own control panel, rather than silently ignoring one.
   */
  setGain(lnaDb: number, vgaDb: number, amp: boolean): void;
  /** Which knobs this radio really has, for the RADIO panel. Only what bring-up has found is listed. */
  readonly caps: RadioCaps;
}

/**
 * The settings a radio can take beyond frequency, one flag per control on the RADIO panel. A control whose flag
 * is false is not drawn at all: a switch that moves and changes nothing is worse than no switch.
 */
export interface RadioCaps {
  /** A HackRF's two receive stages: LNA 0-40 dB in 8s and VGA 0-62 dB in 2s. */
  stagedGain: boolean;
  /** An RTL-SDR's single tuner gain, 0-48.8 dB. */
  tunerGain: boolean;
  /** The HackRF's +14 dB front-end amplifier. */
  amp: boolean;
  /** DC on the antenna port for an inline LNA: HackRF antenna power (3.3 V), RTL-SDR Blog bias tee (4.5 V). */
  biasT: boolean;
  /** Volts the bias tee puts out, for the warning. */
  biasVolts: number;
  /** The R82xx tuner's own automatic gain. */
  tunerAgc: boolean;
  /** The RTL2832U's digital AGC. */
  rtlAgc: boolean;
  /** Crystal correction in parts per million. */
  ppm: boolean;
  /** HF by direct sampling of the ADC's Q branch (R820T/R820T2 only). */
  directSampling: boolean;
  /** The MAX2837's baseband filter bandwidths, in hertz; empty when the radio has no choice. */
  bbFilters: number[];
}

/** Sample rates worth offering by hand, highest first; each radio shows the ones it accepts. */
export const RATE_CHOICES = [20_000_000, 16_000_000, 12_500_000, 10_000_000, 8_000_000, 4_000_000, 3_200_000, 2_800_000,
  2_400_000, 2_048_000, 2_000_000, 1_800_000, 1_400_000, 1_024_000, 250_000];

/** Whether a radio will tune here at all. */
export function canTune(r: RadioLimits, hz: number): boolean {
  return hz >= r.minHz && hz <= r.maxHz;
}

/** Whether a radio will sample at this rate. */
export function canSample(r: RadioLimits, hz: number): boolean {
  return r.rates.some(([lo, hi]) => hz >= lo && hz <= hi);
}

/** The nearest rate the radio will actually accept, for clamping rather than refusing. */
export function nearestRate(r: RadioLimits, hz: number): number {
  if (canSample(r, hz)) return hz;
  let best = r.rates[0][0], bestD = Infinity;
  for (const [lo, hi] of r.rates) {
    for (const cand of [lo, hi]) {
      const d = Math.abs(cand - hz);
      if (d < bestD) { bestD = d; best = cand; }
    }
  }
  return best;
}

/**
 * The one thing about an app that a radio has to be able to do.
 *
 * Not everything an app touches - most of them tune around and change rate as you use them, and a radio that
 * cannot follow every corner is still worth having. This is the requirement without which the app is pointless:
 * the band it exists to listen to, or the fact that it transmits at all.
 */
export interface AppNeeds {
  freqHz?: number;
  rateHz?: number;
  tx?: boolean;
}

/**
 * Which apps ask for something a radio might not have. Anything not listed here works on any radio the app
 * supports, and listing an app costs it nothing on hardware that can do the job.
 *
 * Kept here rather than beside the app list so it can be checked against each radio's limits without a browser.
 */
export const APP_NEEDS: Record<string, AppNeeds> = {
  // HAM is not here: HF sits below where a dongle's tuner starts, but two meters and 70 cm do not, so on a
  // dongle HAM opens on 146.520 instead of being dimmed (hamOpen in main.ts).
  // Bluetooth advertising sits at 2.4 GHz, well past the top of an R82xx.
  btle: { freqHz: 2_402_000_000 },
  transmit: { tx: true },
};

/** Why an app is not worth opening on this radio, or an empty string when it is. */
export function blockedBecause(n: AppNeeds | undefined, lim: RadioLimits): string {
  if (!n) return '';
  if (n.tx && !lim.canTransmit) return 'this radio receives only';
  if (n.freqHz !== undefined && !canTune(lim, n.freqHz)) {
    return `it lives at ${(n.freqHz / 1e6).toFixed(3)} MHz, outside this radio's ${(lim.minHz / 1e6).toFixed(0)}–${(lim.maxHz / 1e6).toFixed(0)} MHz`;
  }
  if (n.rateHz !== undefined && !canSample(lim, n.rateHz)) {
    const top = Math.max(...lim.rates.map(([, hi]) => hi));
    return `it needs ${(n.rateHz / 1e6).toFixed(2)} Msps, above this radio's ${(top / 1e6).toFixed(1)}`;
  }
  return '';
}

/** Why an app will not work on this radio, or an empty string when it will. */
export function whyNot(r: RadioLimits, freqHz: number, rateHz: number): string {
  if (!canTune(r, freqHz)) {
    return `needs ${(freqHz / 1e6).toFixed(3)} MHz, outside this radio's ${(r.minHz / 1e6).toFixed(0)}–${(r.maxHz / 1e6).toFixed(0)} MHz`;
  }
  if (!canSample(r, rateHz)) {
    const top = Math.max(...r.rates.map(([, hi]) => hi));
    return `needs ${(rateHz / 1e6).toFixed(3)} Msps, above this radio's ${(top / 1e6).toFixed(1)} Msps`;
  }
  return '';
}
