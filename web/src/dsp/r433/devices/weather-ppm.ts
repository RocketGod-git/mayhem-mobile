/**
 * Pulse-position weather sensors: the cheap outdoor thermometers that came with a kitchen display.
 *
 * These are all the same idea under different brands — a fixed short mark, then a gap whose length is the bit —
 * and several of them are the same silicon with a different sticker, which is why some reject a reading the
 * moment a sibling protocol's checksum happens to pass on it.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/nexus.c`, `prologue.c`, `rubicson.c`,
 * `generic_temperature_sensor.c`, `s3318p.c`, `esperanza_ews.c`.
 */

import { BITBUF_COLS, type BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { crc4, crc8 } from '../util.js';

/** Sign-extend the low `bits` of a value, the way C does by casting through int16_t. */
function signed(v: number, bits: number): number {
  const shift = 32 - bits;
  return (v << shift) >> shift;
}

/**
 * Nexus and its many rebadges: 36 bits of id, flags, temperature and optionally humidity.
 *
 * There is no checksum here at all, only a nibble that is always 0xf, so most of this decoder is about not
 * claiming somebody else's transmission. The Rubicson family below has the same layout with a real CRC in the
 * last byte where Nexus puts humidity — so if that CRC passes, this is a Rubicson and we decline it.
 */
export const nexus: RDevice = register({
  num: 19,
  name: 'Nexus, FreeTec NC-7345, NX-3980, Solight TE82S, TFA 30.3209 temperature/humidity sensor',
  what: 'outdoor thermometer, often bundled with a kitchen display',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  gapLimit: 3000,
  resetLimit: 5000,
  priority: 10,                                      // let Rubicson claim its own transmissions first
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(3, 36);
    if (r < 0) return DECODE_ABORT_EARLY;
    const b = bits.bb[r];
    if (bits.bitsPerRow[r] > 37) return DECODE_ABORT_LENGTH;   // 36 bits, sometimes a trailing zero
    if ((b[3] & 0xf0) !== 0xf0) return DECODE_ABORT_EARLY;     // the constant nibble is not 1111

    // All zeroes or all ones is noise that happened to slice cleanly.
    if ((b[0] === 0 && b[2] === 0 && b[3] === 0)
      || (b[0] === 0xff && b[2] === 0xff && b[3] === 0xff)) return DECODE_ABORT_EARLY;
    if ((b[1] & 0x30) === 0x30) return DECODE_ABORT_EARLY;     // channel outside 1-3

    const crcIn = new Uint8Array([b[0], b[1], b[2], b[3] & 0xf0, ((b[3] & 0x0f) << 4) | ((b[4] & 0xf0) >> 4)]);
    if (crc8(crcIn, 5, 0x31, 0x6c) === 0) return DECODE_FAIL_SANITY;  // this is a Rubicson, not a Nexus

    const id = b[0];
    const battery = b[1] & 0x80;
    const test = b[1] & 0x40;
    const channel = ((b[1] & 0x30) >> 4) + 1;
    const tempRaw = signed((b[1] << 12) | (b[2] << 4), 16);
    const tempC = (tempRaw >> 4) * 0.1;
    const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);

    // Humidity above 100 means the last byte was never humidity: another family's checksum landed there.
    if (humidity !== 0 && humidity > 100) return DECODE_FAIL_SANITY;

    const out: Record<string, unknown> = {
      model: humidity === 0 ? 'Nexus-T' : 'Nexus-TH',
      id, channel,
      battery_ok: battery ? 1 : 0,
      temperature_C: Math.round(tempC * 100) / 100,
    };
    if (humidity !== 0) out.humidity = humidity;
    if (test) out.test = 1;
    ctx.emit(out as { model: string });
    return 1;
  },
});

/** The Nexus sauna probe: channel 4, sixteen-bit temperature, no humidity. */
export const nexusSauna: RDevice = register({
  num: 279,
  name: 'Nexus, CRX, Prego sauna temperature sensor',
  what: 'sauna probe, reads far above room temperature',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  gapLimit: 3000,
  resetLimit: 5000,
  priority: 10,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(3, 36);
    if (r < 0) return DECODE_ABORT_EARLY;
    const b = bits.bb[r];
    if (bits.bitsPerRow[r] > 37) return DECODE_ABORT_LENGTH;
    if ((b[1] & 0x0f) !== 0x0f) return DECODE_ABORT_EARLY;
    if (b[0] === 0 || (b[4] & 0x10) !== 0x10
      || (b[0] === 0xff && b[2] === 0xff && b[3] === 0xff)) return DECODE_ABORT_EARLY;
    if ((b[1] & 0x30) !== 0x30) return DECODE_ABORT_EARLY;     // this one is always channel 4

    const test = b[1] & 0x40;
    const out: Record<string, unknown> = {
      model: 'Nexus-Sauna',
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: (b[1] & 0x80) ? 1 : 0,
      temperature_C: Math.round(signed((b[2] << 8) | b[3], 16) * 10) / 100,
    };
    if (test) out.test = 1;
    ctx.emit(out as { model: string });
    return 1;
  },
});

/**
 * Prologue and its rebadges. Same nine-nibble shape as Nexus but with a type nibble instead of a constant, and
 * humidity reported as 0xcc when the sensor has none.
 */
export const prologue: RDevice = register({
  num: 3,
  name: 'Prologue, FreeTec NC-7104, NC-7159-675 temperature sensor',
  what: 'outdoor thermometer, sometimes with humidity',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 7000,
  resetLimit: 10000,
  priority: 10,                                      // Alecto collides with this; its checksum decides
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Alecto and Auriol v2 lead with eight sync bits; seeing those means this is not ours.
    if (bits.bitsPerRow[0] <= 8 && bits.bitsPerRow[0] !== 0) return DECODE_ABORT_EARLY;

    const r = bits.findRepeatedRow(4, 36);           // three repeats is not enough to tell it from Alecto
    if (r < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[r] > 37) return DECODE_ABORT_LENGTH;
    const b = bits.bb[r];
    if ((b[0] & 0xf0) !== 0x90 && (b[0] & 0xf0) !== 0x50) return DECODE_FAIL_SANITY;

    const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
    const out: Record<string, unknown> = {
      model: 'Prologue-TH',
      subtype: b[0] >> 4,
      id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
      channel: (b[1] & 0x03) + 1,
      battery_ok: (b[1] & 0x08) ? 1 : 0,
      temperature_C: Math.round((signed((b[2] << 8) | (b[3] & 0xf0), 16) >> 4) * 10) / 100,
      button: (b[1] & 0x04) >> 2,
    };
    if (humidity !== 0xcc) out.humidity = humidity;  // 0xcc means the sensor has no humidity element
    ctx.emit(out as { model: string });
    return 1;
  },
});

/**
 * Rubicson and relatives. Identical in layout to Nexus except that the final byte is a real CRC, which is why
 * this one runs first and why Nexus stands down when this CRC passes.
 */
export const rubicson: RDevice = register({
  num: 2,
  name: 'Rubicson, TFA 30.3197 or InFactory PT-310 temperature sensor',
  what: 'outdoor or pool thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,                                  // gaps: short 976 us, long 1940 us, sync 4000 us
  longWidth: 2000,                                   // marks: 500 us, the first in each burst 388 us
  gapLimit: 3000,
  resetLimit: 4800,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(3, 36);
    if (r < 0) return DECODE_ABORT_EARLY;
    const b = bits.bb[r];
    // The InFactory pool version sends 38 bits, and 37 on its last repeat.
    if (bits.bitsPerRow[r] < 36 || bits.bitsPerRow[r] > 38) return DECODE_ABORT_LENGTH;
    if ((b[3] & 0xf0) !== 0xf0) return DECODE_ABORT_EARLY;

    const tmp = new Uint8Array([b[0], b[1], b[2], b[3] & 0xf0, ((b[3] & 0x0f) << 4) | ((b[4] & 0xf0) >> 4)]);
    if (crc8(tmp, 5, 0x31, 0x6c) !== 0) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Rubicson-Temperature',
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: (b[1] & 0x80) ? 1 : 0,
      temperature_C: Math.round((signed((b[1] << 12) | (b[2] << 4), 16) >> 4) * 10) / 100,
      mic: 'CRC',
    });
    return 1;
  },
});

/** A no-name 24-bit thermometer with no checksum, identified only by sending exactly ten identical frames. */
export const genericTemperature: RDevice = register({
  num: 38,
  name: 'Generic temperature sensor 1',
  what: 'unbranded thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 4800,
  resetLimit: 10000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    for (let i = 1; i < 10; i++) if (bits.bitsPerRow[i] !== 24) return DECODE_ABORT_LENGTH;
    const b = bits.bb[1];
    if ((b[0] === 0 && b[1] === 0 && b[2] === 0)
      || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff)) return DECODE_ABORT_EARLY;

    ctx.emit({
      model: 'Generic-Temperature',
      id: b[0],
      battery_ok: (b[1] & 0xc0) >> 6,
      temperature_C: Math.round((signed(((b[1] & 0x3f) << 10) | (b[2] << 2), 16) >> 4) * 10) / 100,
    });
    return 1;
  },
});

/**
 * The Conrad S3318P family: 42 bits with two leading zeroes, a four-bit CRC, and temperature reported in
 * Fahrenheit offset by ninety degrees with its nibbles in a scrambled order.
 */
export const s3318p: RDevice = register({
  num: 47,
  name: 'Conrad S3318P, FreeTec NC-5849-913 temperature humidity sensor, ORIA WA50 ST389 temperature sensor',
  what: 'outdoor temperature and humidity sensor',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1900,
  longWidth: 3800,
  gapLimit: 4400,
  resetLimit: 9400,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Two empty leading rows means two sync marks, which is the Esperanza variant below, not this one.
    if (bits.bitsPerRow[0] === 0 && bits.bitsPerRow[1] === 0) return DECODE_ABORT_EARLY;

    const r = bits.findRepeatedRow(4, 42);           // six repeats are sent; insist on four
    if (r < 0 || bits.bitsPerRow[r] !== 42) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(r, 2, 40);                  // drop the two leading zeroes and realign
    if (!b[0] && !b[1] && !b[2] && !b[3]) return DECODE_FAIL_SANITY;

    if ((crc4(b, 4, 0x3, 0x0) ^ (b[4] >> 4)) !== (b[4] & 0x0f)) return DECODE_FAIL_MIC;

    const humidity = ((b[3] & 0x0f) << 4) | ((b[3] & 0xf0) >> 4);
    const tempRaw = ((b[2] & 0x0f) << 8) | (b[2] & 0xf0) | (b[1] & 0x0f);
    const out: Record<string, unknown> = {
      model: 'Conrad-S3318P',
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: (b[4] & 0x40) ? 0 : 1,
      temperature_F: Math.round((tempRaw - 900) * 10) / 100,
      button: b[4] >> 7,
      mic: 'CRC',
    };
    if (humidity !== 0) out.humidity = humidity;
    ctx.emit(out as { model: string });
    return 1;
  },
});

/** The Esperanza EWS: the same frame as the Conrad above, but preceded by two sync marks. */
export const esperanzaEws: RDevice = register({
  num: 35,
  name: 'Esperanza EWS',
  what: 'outdoor temperature and humidity sensor',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 4400,
  resetLimit: 9400,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 0 || bits.bitsPerRow[1] !== 0) return DECODE_FAIL_SANITY;
    if (bits.numRows !== 14) return DECODE_ABORT_LENGTH;

    // Rows alternate empty and full; every full one must agree byte for byte with the one two along.
    for (let row = 2; row < bits.numRows - 3; row += 2) {
      if (bits.bitsPerRow[row] !== 42) return DECODE_FAIL_SANITY;
      const a = bits.bb[row], c = bits.bb[row + 2];
      for (let i = 0; i < BITBUF_COLS; i++) if (a[i] !== c[i]) return DECODE_FAIL_SANITY;
    }

    const b = bits.bytes(2, 2, 40);
    if ((crc4(b, 4, 0x3, 0x0) ^ (b[4] >> 4)) !== (b[4] & 0x0f)) return DECODE_FAIL_MIC;

    const tempRaw = ((b[2] & 0x0f) << 8) | (b[2] & 0xf0) | (b[1] & 0x0f);
    ctx.emit({
      model: 'Esperanza-EWS',
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: (b[4] & 0x40) === 0x40 ? 0 : 1,
      temperature_F: Math.round((tempRaw - 900) * 10) / 100,
      humidity: ((b[3] & 0x0f) << 4) | ((b[3] & 0xf0) >> 4),
      mic: 'CRC',
    });
    return 1;
  },
});
