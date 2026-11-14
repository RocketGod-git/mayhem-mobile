/**
 * Tesla charge port opener: the button on a Tesla charge cable (and the handle of a Tesla charger) that opens a
 * closed charge port door when the cable is not plugged in.
 *
 * Not an rtl_433 protocol, so it carries a number of its own (1000 and up are this app's). Receive only.
 *
 * The signal is public (fredilarsen/TeslaChargeDoorOpener, recorded from a real cable with an SRX882): plain
 * on-off keying at 400 us per bit, 315 MHz on North American cars and 433.92 MHz elsewhere. One press sends the
 * same message five times, 23 ms apart. A message is a 26-bit 1010 run-in, then three copies of one frame, each
 * after a 3-bit (1.2 ms) silence: a single start bit and 49 Manchester bits (half bit 400 us). The frame is a
 * fixed code with no ID, counter or checksum: every cable sends exactly these bits. That is why the whole frame
 * is matched rather than parsed, and why a match is strong evidence even without a checksum.
 */

import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, Modulation, register, type DecodeCtx, type RDevice } from '../device.js';

/** The 49 Manchester bits of one frame, with a 1-0 half-bit pair read as 1. */
export const TESLA_CHARGE_PORT_CODE = '0010010100101010101001101100111000110110100001100';
const FRAME_BITS = 1 + 2 * TESLA_CHARGE_PORT_CODE.length;   // start bit + Manchester halves

const bitAt = (bits: BitBuffer, row: number, i: number) => (bits.bb[row][i >> 3] >> (7 - (i & 7))) & 1;

/** True when a start bit at `at` is followed by the whole code, every half-bit pair a clean 10 or 01. */
function frameAt(bits: BitBuffer, row: number, at: number): boolean {
  if (bitAt(bits, row, at) !== 1) return false;
  for (let k = 0; k < TESLA_CHARGE_PORT_CODE.length; k++) {
    const a = bitAt(bits, row, at + 1 + 2 * k), b = bitAt(bits, row, at + 2 + 2 * k);
    if (a === b || String(a) !== TESLA_CHARGE_PORT_CODE[k]) return false;
  }
  return true;
}

export const teslaChargePort: RDevice = register({
  num: 1001,
  name: 'Tesla charge port opener',
  what: 'Tesla charge port opener',
  modulation: Modulation.OOK_PCM,
  shortWidth: 400,
  longWidth: 400,
  gapLimit: 1000,                                   // the 1.2 ms silence before each frame starts a new row
  resetLimit: 5000,                                 // the five repeats are 23 ms apart: each is its own message
  bands: [315000000, 433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let frames = 0, longEnough = false;
    for (let r = 0; r < bits.numRows; r++) {
      const n = bits.bitsPerRow[r];
      if (n < FRAME_BITS) continue;
      longEnough = true;
      for (let at = 0; at + FRAME_BITS <= n; at++) if (frameAt(bits, r, at)) { frames++; break; }
    }
    if (!longEnough) return DECODE_ABORT_LENGTH;
    if (frames === 0) return DECODE_ABORT_EARLY;
    ctx.emit({ model: 'Tesla-ChargePort', command: 'open charge port', frames });
    return 1;
  },
});
