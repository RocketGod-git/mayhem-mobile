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
}

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
  // HAM is an HF app before it is anything else - SSB, CW and the FT8 watering hole at 14.074 all live below
  // where a dongle's tuner starts. It still works on two meters, but calling that "HAM" would be a stretch.
  ham: { freqHz: 14_074_000 },
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
