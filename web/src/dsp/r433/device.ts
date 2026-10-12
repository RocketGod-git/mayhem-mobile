/**
 * What a device decoder is, and what it produces.
 *
 * rtl_433's design is what makes a bulk port tractable: a decoder is not a state machine reading a live signal,
 * it is a pure function from a buffer of bits to a reading. The radio work — finding a burst, measuring its
 * pulses, slicing those into bits — happens once, in code shared by every protocol. Each decoder then declares
 * its timings, gets handed the bits, and either recognizes them or does not. Several hundred of those are a lot
 * of typing but no new signal processing, and every one of them can be tested without a radio.
 *
 * Modeled on rtl_433's `include/r_device.h` (GPL-2.0-or-later).
 */

import type { BitBuffer } from './bitbuffer.js';

/** How the bits are carried. The numbering matches rtl_433 so ported device tables read the same. */
export const enum Modulation {
  OOK_MANCHESTER_ZEROBIT = 3,
  OOK_PCM = 4,                  // also OOK_PULSE_RZ: the slicer tells them apart by short != long
  OOK_PPM = 5,
  OOK_PWM = 6,
  OOK_PIWM_RAW = 8,
  OOK_DMC = 9,
  OOK_PWM_OSV1 = 10,
  OOK_PIWM_DC = 11,
  OOK_NRZS = 12,
  OOK_RZI = 13,
  FSK_PCM = 16,
  FSK_PWM = 17,
  FSK_MANCHESTER_ZEROBIT = 18,
}
/** Anything at or above this is frequency shift keying and needs the discriminator rather than the envelope. */
export const FSK_DEMOD_MIN_VAL = 16;

/**
 * What a decoder returns. A positive number is how many readings it produced; zero or less says why it did not,
 * which is worth keeping separate — "too short to be mine" is normal traffic, while "checksum failed" means a
 * real transmission from this device arrived damaged, and the app can say so.
 */
export const DECODE_FAIL_OTHER = 0;
export const DECODE_ABORT_LENGTH = -1;
export const DECODE_ABORT_EARLY = -2;
export const DECODE_FAIL_MIC = -3;                  // message integrity check: CRC, checksum or parity
export const DECODE_FAIL_SANITY = -4;               // decoded, but the values cannot be real

/** One reading. `model` names the device; everything else is whatever that device reports. */
export interface R433Data {
  model: string;
  [key: string]: unknown;
}

/** Where a decoder sends its readings, and how it reports damage it could see but not repair. */
export interface DecodeCtx {
  emit(d: R433Data): void;
  /** Optional note for the log, for decoders that want to explain a rejection. */
  log?(msg: string): void;
}

export type DecodeFn = (dev: RDevice, bits: BitBuffer, ctx: DecodeCtx) => number;

/**
 * A protocol: its timings in microseconds, and the function that reads its bits.
 *
 * The timings are the same numbers the rtl_433 device tables carry, so a ported decoder can be checked field by
 * field against its source. `shortWidth`/`longWidth` mean different things per modulation — pulse widths for
 * PWM, gap widths for PPM, bit periods for PCM — which is why the slicers, not the devices, interpret them.
 */
export interface RDevice {
  /** Protocol number in rtl_433's own list, kept so a user can look a device up against that project's docs. */
  num: number;
  name: string;
  modulation: Modulation;
  shortWidth: number;
  longWidth: number;
  resetLimit: number;
  gapLimit?: number;
  syncWidth?: number;
  tolerance?: number;
  decode: DecodeFn;
  /** Off by default in rtl_433, usually because it false-triggers on other traffic. Same meaning here. */
  disabled?: boolean;
  /**
   * Order among protocols that can read the same bits. Several of these families differ only by which nibble
   * carries the checksum, so the one with a real check runs first and the looser one only sees what it rejected.
   * Lower runs earlier; the default of zero is fine for anything with a checksum of its own.
   */
  priority?: number;
  /** Which band this is normally heard in, so the app can run only the relevant decoders for the current span. */
  bands?: number[];
  /** One line for the UI: what the thing actually is. */
  what?: string;
}

/** Every decoder, in protocol order. Modules register themselves at import time. */
export const REGISTRY: RDevice[] = [];

export function register(dev: RDevice): RDevice {
  REGISTRY.push(dev);
  return dev;
}

/** Look one up by rtl_433 protocol number. */
export function byNum(num: number): RDevice | undefined {
  return REGISTRY.find(d => d.num === num);
}
