/**
 * The LaCrosse "View" range: the LTV sensors that pair with the phone app rather than a console.
 *
 * These four share one design. Frequency shifted at about 104 microseconds a bit, a preamble ending
 * `d2 aa 2d d4`, then three bytes of identity, a byte of flags carrying a three-bit sequence number, the
 * readings, and a CRC-8 over the whole thing with generator 0x31. Because the frame carries no family code,
 * they are told apart by length and by which CRC length closes — which is also why each one range-checks its
 * own readings before reporting them: with no family byte, a neighbour's frame that happens to pass the CRC
 * would otherwise arrive as a plausible-looking temperature.
 *
 * The rain gauge is the awkward one. One board covers the LTV-R1, the LTV-R3 and the LTV-W1/W2 wind sensor,
 * and which of them is transmitting has to be inferred from where the padding bytes fall and which CRC length
 * comes out clean. Getting that wrong reports a wind speed as a rainfall total.
 *
 * Ported from rtl_433's `src/devices/lacrosse_breezepro.c`, `_wr1.c`, `_th3.c` and `_r1.c`
 * (GPL-2.0-or-later).
 */

import type { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8 } from '../util.js';

/** The tail of the preamble and the sync word the whole View range opens with. */
const SYNC = new Uint8Array([0xd2, 0xaa, 0x2d, 0xd4]);
/** These are sold in both regions and the same board is used on either frequency. */
const BANDS = [433920000, 868300000, 915000000];

const round1 = (x: number) => Math.round(x * 10) / 10;
const hex6 = (v: number) => v.toString(16).padStart(6, '0');

/**
 * The LTV-TH thermo-hygro sensor.
 *
 * Three different CRC initial values are accepted. LaCrosse changed it between production runs and rtl_433
 * takes any of the three, so a sensor bought in a different year still reads.
 */
export const lacrosseTh3: RDevice = register({
  num: 171,
  name: 'LaCrosse View LTV-TH thermo-hygro sensor',
  what: 'outdoor temperature and humidity',
  modulation: Modulation.FSK_PCM,
  shortWidth: 104,
  longWidth: 104,
  resetLimit: 9600,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < 156 || n > 290) return DECODE_ABORT_LENGTH;
    // The only thing separating a TH3 from the older TH2 is how long it talks for.
    const model = n < 280 ? 3 : 2;

    const at = bits.search(0, 0, SYNC, 32);
    if (at >= n) return DECODE_ABORT_EARLY;
    const b = bits.bytes(0, at + 32, 8 * 8);

    if (crc8(b, 8, 0x31, 0x00) !== 0 && crc8(b, 8, 0x31, 0xac) !== 0 && crc8(b, 8, 0x31, 0xb2) !== 0) {
      return DECODE_FAIL_MIC;
    }

    const rawTemp = (b[4] << 4) | ((b[5] & 0xf0) >> 4);
    const humidity = ((b[5] & 0x0f) << 8) | b[6];
    const tempC = (rawTemp - 400) * 0.1;
    // No family code in the frame, so the readings themselves have to be the sanity check.
    if (humidity > 100 || tempC < -50 || tempC > 70) return DECODE_FAIL_SANITY;

    const flags = b[3] & 0x31;
    const retrans = (b[3] & 0x40) >> 6;
    const data: R433Data = {
      model: model === 3 ? 'LaCrosse-TH3' : 'LaCrosse-TH2',
      id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
      battery_ok: (b[3] & 0x80) >> 7 ? 0 : 1,
      seq: (b[3] & 0x0e) >> 1,
      temperature_C: round1(tempC),
      humidity,
      mic: 'CRC',
    };
    if (retrans) data.retransmit = retrans;
    if (flags) data.flags = flags;
    ctx.emit(data);
    return 1;
  },
});

/**
 * The LTV-R1 and LTV-R3 rain gauges and the LTV-W1/W2 wind sensor, which share a board.
 *
 * Which one is transmitting is worked out from the padding: the wind sensor leaves 0xaa across the bytes the
 * rain gauge uses for its second total, and the R3 puts something in byte ten where the R1 leaves zero. The
 * rain counters are stored with one byte exclusive-ored against 0xaa, which is presumably how the padding and
 * the payload were kept distinguishable in the first place.
 */
export const lacrosseR1: RDevice = register({
  num: 175,
  name: 'LaCrosse View LTV-R1, LTV-R3 rain gauge and LTV-W1/W2 wind sensor',
  what: 'rain gauge or wind sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 104,
  longWidth: 104,
  resetLimit: 9600,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY;
    const n = bits.bitsPerRow[0];
    // The shorter limit lets in the LTV-R3 and the TFA 30.3802.02, which uses a shorter preamble at 868 MHz.
    if (n < 170 || n > 272) return DECODE_ABORT_LENGTH;

    const at = bits.search(0, 0, SYNC, 32);
    if (at >= n) return DECODE_ABORT_EARLY;
    const b = bits.bytes(0, at + 32, 20 * 8);

    let rev = 1;
    let chk = crc8(b, 11, 0x31, 0x00);
    if (chk === 0 && b[4] === 0xaa && b[5] === 0xaa && b[6] === 0xaa && (b[8] & 0x0f) === 0x0a && b[9] === 0xaa) {
      rev = 9;                                       // the wind sensor: its rain bytes are all padding
    } else if (chk === 0 && b[10] !== 0) {
      rev = 3;                                       // the R3, which carries a second total
    } else {
      chk = crc8(b, 8, 0x31, 0x00);
      // Byte ten must be empty as well, or this is a shorter frame that happened to agree with the CRC.
      if (b[10] !== 0 || chk !== 0) return DECODE_FAIL_MIC;
    }

    const data: R433Data = {
      model: rev === 1 ? 'LaCrosse-R1' : rev === 3 ? 'LaCrosse-R3' : 'LaCrosse-W1',
      id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
      battery_ok: (b[3] & 0x80) >> 7 ? 0 : 1,
      seq: (b[3] & 0x0e) >> 1,
      mic: 'CRC',
    };
    const startup = (b[3] & 0x40) >> 6;
    const flags = b[3] & 0x31;
    if (startup) data.startup = startup;
    if (flags) data.flags = flags;

    if (rev !== 9) {
      data.rain_mm = Math.round((((b[5] ^ 0xaa) << 16) | (b[4] << 8) | b[6]) * 0.25 * 100) / 100;
    }
    if (rev === 3) {
      data.rain2_mm = Math.round((((b[8] ^ 0xaa) << 16) | (b[7] << 8) | b[9]) * 0.25 * 100) / 100;
    }
    if (rev === 9) {
      data.wind_avg_km_h = round1(((b[7] << 4) | (b[8] >> 4)) * 0.1);
    }
    ctx.emit(data);
    return 1;
  },
});

/** The LTV-WR1, which reports wind and rain together. */
export const lacrosseWr1: RDevice = register({
  num: 170,
  name: 'LaCrosse View LTV-WR1 multi sensor',
  what: 'wind and rain sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 104,
  longWidth: 104,
  resetLimit: 9600,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < 120 || n > 156) return DECODE_ABORT_LENGTH;
    const at = bits.search(0, 0, SYNC, 32);
    if (at >= n) return DECODE_ABORT_EARLY;
    const b = bits.bytes(0, at + 32, 11 * 8);

    if (crc8(b, 11, 0x31, 0x00)) return DECODE_FAIL_MIC;

    const rawWind = (b[4] << 4) | ((b[5] & 0xf0) >> 4);
    const direction = ((b[5] & 0x0f) << 8) | b[6];
    const speed = rawWind * 0.1;
    if (speed > 200 || direction > 360) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'LaCrosse-WR1',
      id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
      seq: (b[3] & 0x0e) >> 1,
      flags: b[3] & 0xf1,
      wind_avg_km_h: round1(speed),
      wind_dir_deg: direction,
      // Two rain counters nobody has worked out the scaling for, so they are reported as they arrive.
      rain1: ((b[7] << 4) | ((b[8] & 0xf0) >> 4)).toString(16).padStart(3, '0'),
      rain2: (((b[8] & 0x0f) << 8) | b[9]).toString(16).padStart(3, '0'),
      mic: 'CRC',
    });
    return 1;
  },
});

/** The Breeze Pro, an anemometer that also carries temperature and humidity. */
export const lacrosseBreezePro: RDevice = register({
  num: 166,
  name: 'LaCrosse View LTV-WSDTH01 Breeze Pro wind sensor',
  what: 'wind, temperature and humidity',
  modulation: Modulation.FSK_PCM,
  shortWidth: 107,
  longWidth: 107,
  resetLimit: 5900,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < 264) return DECODE_ABORT_LENGTH;
    const at = bits.search(0, 0, SYNC, 32);
    if (at >= n) return DECODE_ABORT_EARLY;
    const b = bits.bytes(0, at + 32, 11 * 8);

    if (crc8(b, 11, 0x31, 0x00)) return DECODE_FAIL_MIC;

    const tempC = (((b[4] << 4) | ((b[5] & 0xf0) >> 4)) - 400) * 0.1;
    const humidity = ((b[5] & 0x0f) << 8) | b[6];
    const speed = ((b[7] << 4) | ((b[8] & 0xf0) >> 4)) * 0.1;
    const direction = ((b[8] & 0x0f) << 8) | b[9];
    if (humidity > 100 || tempC < -40 || tempC > 70 || direction > 360 || speed > 200) {
      return DECODE_FAIL_SANITY;
    }

    ctx.emit({
      model: 'LaCrosse-BreezePro',
      id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
      seq: (b[3] & 0x0e) >> 1,
      flags: b[3] & 0xf1,
      temperature_C: round1(tempC),
      humidity,
      wind_avg_km_h: round1(speed),
      wind_dir_deg: direction,
      mic: 'CRC',
    });
    return 1;
  },
});
