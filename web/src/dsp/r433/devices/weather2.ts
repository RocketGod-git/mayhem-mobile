/**
 * Eight small weather and garden sensors, most of them a decade or more old.
 *
 * This is the long tail: cheap thermometers, a pool probe, a soil moisture meter, a wind and rain station.
 * They are worth having precisely because they are unglamorous — someone with one of these in the garden will
 * see it appear, and that is the whole point of listening to a band rather than to a device.
 *
 * Their age shows in how little most of them check. The Calibeur has a single parity bit and gets away with it
 * by demanding two identical messages in a row. The Springfield folds its nibbles into one, and then bounds
 * the temperature and moisture because that check is too weak to stand alone. The FT-004B has no check at all
 * and instead sends everything three times, taking whichever value two of the three agree on — which is a
 * genuinely good answer to a noisy band, and rather better than a checksum at recovering rather than merely
 * detecting.
 *
 * Two deviations from rtl_433, both about not damaging anything else:
 *
 *  - Mebus indexes its thirteenth row without ever checking how many rows arrived; upstream's own note admits
 *    the missing validation. That is an out-of-bounds read there and would throw here, so the count is checked
 *    first. On a real transmission nothing changes.
 *  - The FT-004B votes its three copies together and writes the result back over the received bits. Here the
 *    vote goes into a copy instead: identical output, but the shared buffer is left intact for the decoders
 *    that run afterwards.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `mebus.c`, `calibeur.c`, `springfield.c`, `ft004b.c`, `wssensor.c`,
 * `wt0124.c`, `missil_ml0757.c`, `sharp_spc775.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, lfsrDigest8Reflect, reverse8, xorBytes } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Sign-extend a twelve-bit field that sits in the top of a sixteen-bit word, then drop the low nibble. */
const signed12 = (v: number) => ((v & 0xffff) << 16) >> 20;

/** Read a byte that need not be byte-aligned. */
function byteAt(m: Uint8Array, off: number): number {
  const i = off >> 3, s = off & 7;
  if (!s) return m[i] ?? 0;
  return ((((m[i] ?? 0) << 8) | (m[i + 1] ?? 0)) >> (8 - s)) & 0xff;
}

/** The byte sum at full width. `addBytes` masks to a byte, which loses the carry some of these fold back in. */
function sumBytes(m: Uint8Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += m[i];
  return s;
}

// ---------------------------------------------------------------------------
// Mebus 433 (13)
// ---------------------------------------------------------------------------

/**
 * One of the oldest decoders in rtl_433, and it shows.
 *
 * There is no checksum and no length validation whatsoever. What stands in for both is that the same message
 * has to appear at three widely separated points in the transmission — rows one, five and thirteen have to
 * agree on the bytes they share. That is a real guard against noise, if a crude one, and it is why this needs
 * a long enough capture to contain all three.
 */
export const mebus433: RDevice = register({
  num: 13,
  name: 'Mebus 433',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 800,                                 // guessed upstream: no samples were ever available
  longWidth: 1600,
  gapLimit: 2400,
  resetLimit: 6000,
  bands: BAND_433,
  disabled: true,                                  // no checksum and no length checks worth the name
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Upstream reads row twelve without ever asking how many arrived.
    if (bits.numRows < 13) return DECODE_ABORT_EARLY;
    const b = bits.bb;
    if (b[0][0] !== 0 || !b[1][4] || !(b[1][0] & 0x60)
      || b[1][3] !== b[5][3] || b[1][4] !== b[12][4]) return DECODE_ABORT_EARLY;

    const r = b[1];
    ctx.emit({
      model: 'Mebus-433',
      type: 'Weather',
      id: r[0] & 0x1f,
      channel: ((r[1] & 0x30) >> 4) + 1,
      battery_ok: r[1] & 0x80 ? 1 : 0,
      unknown1: (r[1] & 0x40) >> 6,
      unknown2: (r[3] & 0xf0) >> 4,
      temperature_C: round2(signed12((r[1] << 12) | (r[2] << 4)) * 0.1),
      humidity: (((((r[3] << 4) | (r[4] >> 4)) & 0xff) << 24) >> 24),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Calibeur RF-104 (21)
// ---------------------------------------------------------------------------

/**
 * A thermometer that hides its channel number inside the temperature.
 *
 * The tenths digit is not a tenth at all: it is the channel multiplied by ten and added to the real fraction,
 * so the two have to be pulled apart by division. That is also why only three of these can be told apart —
 * there is nowhere else for an identity to live.
 *
 * Its only check is a single parity bit, which is why it also insists on two identical messages in a row.
 */
export const calibeurRf104: RDevice = register({
  num: 21,
  name: 'Calibeur RF-104 Sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 760,
  longWidth: 2240,
  resetLimit: 3200,
  syncWidth: 1560,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 3) return DECODE_ABORT_EARLY;   // row zero is empty, left by the start bit
    const b = bits.bb[1], b2 = bits.bb[2];

    if ((!b[0] && !b[1] && !b[2]) || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff)) {
      return DECODE_FAIL_SANITY;
    }
    bits.invert();
    if (bits.bitsPerRow[1] !== 21) return DECODE_ABORT_LENGTH;
    // The number of ones must be odd, so a zero result means it is not.
    if (crc8(b, 3, 0x80, 0) === 0) return DECODE_FAIL_MIC;
    if (b[0] !== b2[0] || b[1] !== b2[1] || b[2] !== b2[2]) return DECODE_FAIL_SANITY;

    // Every field is scattered a bit at a time rather than laid out in order.
    const scatter = (...parts: number[]) => parts.reduce((a, v) => a | v, 0) & 0xff;
    const packed = scatter(
      (b[0] & 0x80) >> 7, (b[0] & 0x40) >> 5, (b[0] & 0x20) >> 3,
      (b[0] & 0x10) >> 1, (b[0] & 0x08) << 1, (b[0] & 0x04) << 3);
    const whole = scatter(
      (b[0] & 0x02) << 3, (b[0] & 0x01) << 5, (b[1] & 0x80) >> 7, (b[1] & 0x40) >> 5,
      (b[1] & 0x20) >> 3, (b[1] & 0x10) >> 1, (b[1] & 0x08) << 3);
    const humidity = scatter(
      (b[1] & 0x02) << 4, (b[1] & 0x01) << 6, (b[2] & 0x80) >> 7, (b[2] & 0x40) >> 5,
      (b[2] & 0x20) >> 3, (b[2] & 0x10) >> 1, (b[2] & 0x08) << 1);

    ctx.emit({
      model: 'Calibeur-RF104',
      type: 'Weather',
      id: Math.floor(packed / 10),                 // the channel, carried in the tenths digit
      temperature_C: round1((packed % 10) * 0.1 + whole - 41),
      humidity,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Springfield soil moisture (53)
// ---------------------------------------------------------------------------

/**
 * A soil probe that reads as a false Alecto unless something rules it out.
 *
 * The two protocols overlap, so this one runs after Alecto and only sees what that decoder rejected. Its own
 * check folds four bytes down to a single nibble, which is weak enough that the temperature and moisture are
 * then bounded to what the probe can actually measure.
 */
export const springfield: RDevice = register({
  num: 53,
  name: 'Springfield Temperature and Soil Moisture',
  what: 'soil moisture and temperature probe',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 5000,
  resetLimit: 9200,
  priority: 10,                                    // let Alecto claim it first if its checksum holds
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 36);
    if (row < 0) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[row];
    if (n !== 36 && n !== 37) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    const raw = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    if (raw === 0xffffffff || raw === 0) return DECODE_ABORT_EARLY;

    let chk = xorBytes(b, 4);
    chk = (chk >> 4) ^ (chk & 0x0f);               // fold the whole thing into one nibble
    if (chk !== 0) return DECODE_FAIL_MIC;

    const tempC = round1(signed12(((b[1] & 0x0f) << 12) | (b[2] << 4)) * 0.1);
    const moisture = (b[3] >> 4) * 10;             // the display shows nought to ten
    // The check is too weak to stand alone, so what the probe can actually read bounds it.
    if (tempC < -30 || tempC > 70) return DECODE_FAIL_SANITY;
    if (moisture > 100) return DECODE_FAIL_SANITY;

    const button = (b[1] >> 6) & 1;
    ctx.emit({
      model: 'Springfield-Soil',
      type: 'Weather',
      id: b[0],
      channel: ((b[1] >> 4) & 0x03) + 1,
      battery_ok: (b[1] >> 7) & 1 ? 0 : 1,
      temperature_C: tempC,
      moisture,
      button,                                      // set when somebody pressed the button on the probe
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// FT-004-B thermometer (92)
// ---------------------------------------------------------------------------

/**
 * No checksum at all, and a better answer than one: it says everything three times.
 *
 * The three copies arrive back to back in a single burst, and each bit is taken as whichever value two of the
 * three agree on. That recovers from interference rather than merely noticing it, which is more than most of
 * the sensors here manage. A fixed type byte is all that then has to match.
 */
export const ft004b: RDevice = register({
  num: 92,
  name: 'FT-004-B Temperature Sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1956,
  longWidth: 3900,
  gapLimit: 4000,
  resetLimit: 4000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n !== 137 && n !== 138) return DECODE_ABORT_LENGTH;

    // Take the majority of the three copies. Upstream writes this back over the received bits; here it goes
    // into a copy, so the buffer the later decoders see is untouched.
    const src = bits.bb[0];
    const msg = new Uint8Array(6);                 // forty-six bits, rounded up
    for (let i = 0; i < 6; i++) {
      const a = byteAt(src, i * 8);
      const b = byteAt(src, i * 8 + 46);
      const c = byteAt(src, i * 8 + 46 * 2);
      msg[i] = reverse8((a & b) | (b & c) | (a & c));
    }
    if (msg[0] !== 0xf4) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'FT-004B',
      type: 'Weather',
      temperature_C: round1((((msg[4] & 0x07) << 8) | msg[3]) * 0.05 - 40),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Hyundai WS SENZOR (108)
// ---------------------------------------------------------------------------

/** Twenty-four bits said twenty-three times over, which is the whole of its integrity. */
export const wssensor: RDevice = register({
  num: 108,
  name: 'Hyundai WS SENZOR Remote Temperature Sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  gapLimit: 2400,
  resetLimit: 4400,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(4, 23);         // sent twenty-three times; four agreeing will do
    if (r < 0 || bits.bitsPerRow[r] !== 24) return DECODE_ABORT_LENGTH;

    const b = bits.bb[r];
    if ((!b[0] && !b[1] && !b[2]) || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff)) {
      return DECODE_FAIL_SANITY;
    }

    ctx.emit({
      model: 'Hyundai-WS',
      type: 'Weather',
      id: b[2],
      channel: (b[1] & 0x03) + 1,
      battery_ok: (b[1] & 0x08) >> 3 ? 1 : 0,
      temperature_C: round2(signed12((b[0] << 8) | (b[1] & 0xf0)) * 0.1),
      button: (b[1] & 0x04) >> 2,                  // set when the battery went in or the button was pressed
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// WT0124 pool thermometer (109)
// ---------------------------------------------------------------------------

/**
 * A pool probe with two checks, one of which folds its own carry back in.
 *
 * The sum is taken across four bytes at full width, the carry out of the top byte is added back, and only then
 * is the fifth byte added without a further carry. That last asymmetry is deliberate on the sensor's part and
 * has to be reproduced exactly — a sum masked to a byte along the way would lose the carry and never match.
 */
export const wt1024: RDevice = register({
  num: 109,
  name: 'WT0124 Pool Thermometer',
  what: 'pool thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 680,
  longWidth: 1850,
  resetLimit: 30000,
  gapLimit: 4000,
  syncWidth: 10000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 2) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[1] !== 49) return DECODE_ABORT_LENGTH;

    const b = bits.bb[1];                          // the row after the run-in
    if ((b[0] >> 4) !== 0x5) return DECODE_ABORT_EARLY;
    if (xorBytes(b, 4) !== b[4]) return DECODE_FAIL_MIC;

    let sum = sumBytes(b, 4);                      // full width: the carry is folded back below
    sum += sum >> 8;
    sum += b[4];                                   // and this one carries nowhere
    if ((sum & 0xff) !== b[5]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'WT0124-Pool',
      type: 'Weather',
      id: ((b[0] & 0x0f) << 4) | (b[1] & 0x0f),    // picked afresh every time it is powered up
      channel: (b[3] >> 4) & 0x03,
      temperature_C: round1(((((b[1] & 0x0f) << 8) | b[2]) - 0x990) * 0.1),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Missil ML0757 weather station (157)
// ---------------------------------------------------------------------------

/**
 * A station that cannot say everything at once, so it alternates.
 *
 * One flag bit decides whether the two data fields mean temperature or rain and wind, and the sensor sends the
 * two kinds of message in turn about half a minute apart. So a single transmission only ever half-describes
 * the weather, and only the fields it actually carried are reported.
 *
 * Its wind scale is genuinely strange — nought, then a jump, then a linear run — but it is what the display
 * shows, so it is what is reported.
 */
export const missilMl0757: RDevice = register({
  num: 157,
  name: 'Missil ML0757 weather station',
  what: 'weather station: temperature, wind and rain',
  modulation: Modulation.OOK_PPM,
  shortWidth: 975,
  longWidth: 1950,
  gapLimit: 2500,
  resetLimit: 4500,
  tolerance: 100,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(5, 40);         // sent nine times; five agreeing will do
    if (r < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] > 0) return DECODE_ABORT_EARLY;   // a message always opens with an empty row
    if (bits.bitsPerRow[r] > 40) return DECODE_ABORT_LENGTH;

    const b = bits.bb[r];
    if ((b[4] & 0x0f) !== 0x0f) return DECODE_ABORT_EARLY;   // the tail is always four ones

    const f12 = ((b[2] << 4) | (b[3] >> 4)) & 0xfff;
    const f8 = (((b[3] & 0x0f) << 4) | (b[4] >> 4)) & 0xff;

    const data: R433Data = {
      model: 'Missil-ML0757',
      type: 'Weather',
      id: b[0],
      battery_ok: b[1] & 0x80 ? 0 : 1,
    };
    if (b[1] & 0x04) {
      data.rain_mm = round2(f12 * 0.45);
      // Nought, then two fixed steps, then a straight line. Odd, but it is what the display agrees with.
      data.wind_avg_km_h = f8 === 0x00 ? 0 : f8 === 0x80 ? 1.4 : f8 === 0xc0 ? 2.8 : round2((f8 + 2) * 1.4);
    } else {
      data.temperature_C = round2(f12 & 0x800 ? (0x1000 - f12) * -0.1 : f12 * 0.1);
    }
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Sharp SPC775 (158)
// ---------------------------------------------------------------------------

/** The only one here on the American band, and the only one with a real digest. */
export const sharpSpc775: RDevice = register({
  num: 158,
  name: 'Sharp SPC775 weather station',
  what: 'thermometer and hygrometer',
  modulation: Modulation.FSK_PWM,
  shortWidth: 225,
  longWidth: 425,
  gapLimit: 2900,
  resetLimit: 10000,
  bands: [915000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    const r = bits.findRepeatedRow(2, 48);         // sent three times; two agreeing will do
    if (r < 0) return DECODE_ABORT_EARLY;

    const pos = bits.search(r, 0, new Uint8Array([0xa5]), 8);
    if (pos + 6 * 8 > bits.bitsPerRow[r]) return DECODE_FAIL_SANITY;
    const b = bits.bytes(r, pos, 6 * 8);

    // The check is a digest of the exclusive-or of everything before it, not of the bytes themselves.
    const folded = Uint8Array.from([xorBytes(b, 5)]);
    if (lfsrDigest8Reflect(folded, 1, 0x31, 0x31) !== b[5]) return DECODE_FAIL_MIC;

    const humidity = b[4];
    if (humidity > 100) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Sharp-SPC775',
      type: 'Weather',
      id: b[1],                                    // picked afresh every time it is powered up
      battery_ok: b[2] & 0x80 ? 0 : 1,
      temperature_C: round1(signed12(((b[2] & 0x0f) << 12) | (b[3] << 4)) * 0.1),
      humidity,
      mic: 'CRC',
    });
    return 1;
  },
});
