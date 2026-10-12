/**
 * Fine Offset, and everything built on their designs — Ecowitt, Ambient Weather, Misol, Alecto, Froggit.
 *
 * One factory in Shenzhen makes the internals of a large share of the consumer weather stations sold anywhere,
 * so the same frames come out under a dozen brand names. The older sensors key the carrier on and off; the whole
 * modern range shifts frequency instead, and shares one arrangement: a run of alternating bits, the sync word
 * `2d d4`, a family-code byte that says which sensor it is, the readings, then a CRC and a byte sum.
 *
 * Because those all look alike until the family code is read, one decoder here reads the length of the burst and
 * hands off to whichever sibling fits — the way rtl_433 does, and for the same reason.
 *
 * Ported from rtl_433's `src/devices/fineoffset.c` (GPL-2.0-or-later).
 */

import type { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, crc8, xorBytes } from '../util.js';

/** The sync word every frequency-keyed sensor in this family leads with, plus the last byte of the preamble. */
const PREAMBLE = new Uint8Array([0xaa, 0x2d, 0xd4]);

const round1 = (x: number) => Math.round(x * 10) / 10;
const hex2 = (v: number) => v.toString(16).padStart(2, '0');

/**
 * The original on-off keyed sensors: WH2, WH2A, WH5, the Telldus/Proove rebadge and the TFA 303225.
 *
 * They differ only in how many bits of preamble they send, so the length of the row and its first byte pick the
 * model, and the payload is read from a different offset in each case.
 */
export const fineoffsetWh2: RDevice = register({
  num: 18,
  name: 'Fine Offset Electronics WH2, WH5, Telldus temperature/humidity/rain sensor',
  what: 'outdoor thermometer, the older on-off keyed generation',
  modulation: Modulation.OOK_PWM,
  shortWidth: 500,                                   // short mark 544 us, long mark 1524 us, fixed 1036 us gap
  longWidth: 1500,
  resetLimit: 1200,                                  // one packet at a time is all we want
  tolerance: 160,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    const row0 = bits.bb[0];
    let b: Uint8Array;
    let model: string;

    if (n === 48 && row0[0] === 0xff) {
      b = bits.bytes(0, 8, 40); model = 'Fineoffset-WH2';
    } else if (n === 55 && row0[0] === 0xfe) {
      b = bits.bytes(0, 7, 48);
      model = b[3] === 0xff ? 'TFA-303225' : 'Fineoffset-WH2A';
    } else if (n === 47 && row0[0] === 0xfe) {
      b = bits.bytes(0, 7, 40); model = 'Fineoffset-WH5';
    } else if (n === 49 && row0[0] === 0xff && (row0[1] & 0x80) === 0x80) {
      b = bits.bytes(0, 9, 40); model = 'Fineoffset-TelldusProove';
    } else {
      return DECODE_ABORT_LENGTH;
    }

    if (b[4] !== crc8(b, 4, 0x31, 0)) return DECODE_FAIL_MIC;
    if (model === 'TFA-303225' && (addBytes(b, 5) & 0xff) !== b[5]) return DECODE_FAIL_MIC;
    if ((b[0] >> 4) !== 4) return DECODE_FAIL_SANITY;   // the type nibble is always four

    let temp = ((b[1] & 0x0f) << 8) | b[2];
    let lowBattery = 0;
    if (model === 'TFA-303225') {
      lowBattery = (temp & 0x800) !== 0 ? 1 : 0;      // this one reuses the sign bit for the battery flag
      temp = (temp & 0x7ff) - 400;
    } else if (model === 'Fineoffset-WH5') {
      temp -= 400;                                    // offset forty degrees rather than signed
    } else if (temp & 0x800) {
      temp = -(temp & 0x7ff);                         // signed magnitude, not two's complement
    }
    const temperature = temp * 0.1;
    if (model === 'Fineoffset-WH5' && (temperature < -40 || temperature > 60)) return DECODE_FAIL_SANITY;

    const humidity = b[3];
    const out: Record<string, unknown> = {
      model,
      id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
      temperature_C: round1(temperature),
      mic: 'CRC',
    };
    if (model === 'TFA-303225') out.battery_ok = lowBattery ? 0 : 1;
    if (humidity !== 0xff) out.humidity = humidity;
    ctx.emit(out as R433Data);
    return 1;
  },
});

/** The Agimex Rosenborg 66796, which is the WH5 frame with a different badge and no offset on the temperature. */
export const fineoffsetWh5rb: RDevice = register({
  num: 356,
  name: 'Agimex Rosenborg 66796 temperature/humidity sensor',
  what: 'outdoor thermometer sold in Denmark; shares a frame with the WH5',
  modulation: Modulation.OOK_PWM,
  shortWidth: 500,
  longWidth: 1500,
  resetLimit: 1200,
  tolerance: 160,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 47 || bits.bb[0][0] !== 0xfe) return DECODE_ABORT_EARLY;
    const b = bits.bytes(0, 7, 40);
    if (b[4] !== crc8(b, 4, 0x31, 0)) return DECODE_FAIL_MIC;
    if ((b[0] >> 4) !== 4) return DECODE_FAIL_SANITY;

    let temp = ((b[1] & 0x0f) << 8) | b[2];
    if (temp & 0x800) temp = -(temp & 0x7ff);
    const out: Record<string, unknown> = {
      model: 'Rosenborg-66796',
      id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
      temperature_C: round1(temp * 0.1),
      mic: 'CRC',
    };
    if (b[3] !== 0xff) out.humidity = b[3];
    ctx.emit(out as R433Data);
    return 1;
  },
});

/** Where in the row the payload starts, or -1 when the sync word is not there. */
function payloadStart(bits: BitBuffer): number {
  const at = bits.search(0, 0, PREAMBLE, 24) + 24;
  return at;
}

/**
 * The WH24, WH65, WS69 and HP1000 outdoor arrays: wind, rain, light, ultraviolet, temperature and humidity in
 * one seventeen-byte frame, with three more bytes of pressure on the newest of them.
 *
 * Which model it is comes from how long the burst was and how much postamble followed the payload, because
 * nothing in the frame itself says — the family code is 0x24 for all of them.
 */
function wh24Decode(bits: BitBuffer, ctx: DecodeCtx): number {
  const n = bits.bitsPerRow[0];
  if (n < 190 || n > 268) return DECODE_ABORT_LENGTH;

  const at = payloadStart(bits);
  if (at + 17 * 8 > n) return DECODE_ABORT_LENGTH;

  let model: string;
  if (n - at - 17 * 8 < 8) model = at < 61 ? 'Fineoffset-WH24' : 'Fineoffset-WH65B';
  else model = 'Fineoffset-WH65B';
  if (n > 215) model = 'Fineoffset-WS69';            // the WS69 runs to about 260 bits

  const b = bits.bytes(0, at, 25 * 8);
  if (b[0] !== 0x24) return DECODE_FAIL_SANITY;      // family code
  if (crc8(b, 16, 0x31, 0x00) !== 0 || addBytes(b, 16) !== b[16]) return DECODE_FAIL_MIC;

  // The WS69's pressure module is a separate board; when it is absent the field reads all ones.
  let pressureHpa = -1;
  if (model === 'Fineoffset-WS69') {
    const raw = (b[17] << 16) | (b[18] << 8) | b[19];
    if (crc8(b, 24, 0x31, 0x00) === 0 && addBytes(b, 24) === b[24] && raw < 0x01ffff) {
      pressureHpa = raw * 0.01;
    }
  }

  // The WH24's anemometer and rain gauge are geared differently from the WH65's.
  const wh24 = model === 'Fineoffset-WH24';
  const windFactor = wh24 ? 1.12 : 0.51;
  const rainPerTip = wh24 ? 0.3 : 0.254;

  const windDir = b[2] | ((b[3] & 0x80) << 1);
  const tempRaw = ((b[3] & 0x07) << 8) | b[4];
  const humidity = b[5];
  const windRaw = b[6] | ((b[3] & 0x10) << 4);
  const gustRaw = b[7];
  const uvRaw = (b[10] << 8) | b[11];
  const lightRaw = (b[12] << 16) | (b[13] << 8) | b[14];

  // The index is a set of thresholds on the raw reading, not a scale factor.
  const UVI_UPPER = [432, 851, 1210, 1570, 2017, 2450, 2761, 3100, 3512, 3918, 4277, 4650, 5029];
  let uvIndex = 0;
  while (uvIndex < 13 && UVI_UPPER[uvIndex] < uvRaw) uvIndex++;

  const out: Record<string, unknown> = {
    model,
    id: b[1],
    battery_ok: ((b[3] & 0x08) >> 3) ? 0 : 1,
    rain_mm: round1(((b[8] << 8) | b[9]) * rainPerTip),
    mic: 'CRC',
  };
  // Every field has an all-ones value meaning "not fitted" or "not read this time".
  if (tempRaw !== 0x7ff) out.temperature_C = round1((tempRaw - 400) * 0.1);
  if (humidity !== 0xff) out.humidity = humidity;
  if (pressureHpa >= 0) out.pressure_hPa = Math.round(pressureHpa * 100) / 100;
  if (windDir !== 0x1ff) out.wind_dir_deg = windDir;
  if (windRaw !== 0x1ff) out.wind_avg_m_s = round1(windRaw * 0.125 * windFactor);
  if (gustRaw !== 0xff) out.wind_max_m_s = round1(gustRaw * windFactor);
  if (uvRaw !== 0xffff) { out.uv = uvRaw; out.uvi = uvIndex; }
  if (lightRaw !== 0xffffff) out.light_lux = round1(lightRaw * 0.1);
  ctx.emit(out as R433Data);
  return 1;
}

/**
 * The WH0290 air quality monitor, sold as the Ecowitt WH41 and the Ambient Weather PM25.
 *
 * It reports two figures. The first is a real measurement of particles under 2.5 microns. The second is labelled
 * PM10 by the sensor but is not measured: the Honeywell module inside derives it from the first by a rule the
 * datasheet never states, and Ecowitt's own displays do not show it. It is reported here as an estimate.
 */
function wh0290Decode(bits: BitBuffer, ctx: DecodeCtx): number {
  const at = payloadStart(bits);
  if (at + 64 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;
  const b = bits.bytes(0, at, 64);

  if (crc8(b, 6, 0x31, 0x00) !== b[6] || (addBytes(b, 7) & 0xff) !== b[7]) return DECODE_FAIL_MIC;

  // Battery is five bars, split across two bytes.
  const bars = ((b[2] & 0x40) >> 4) | ((b[4] & 0xc0) >> 6);
  ctx.emit({
    model: 'Fineoffset-WH0290',
    id: b[1],
    battery_ok: round1(bars * 0.2),
    pm2_5_ug_m3: (((b[2] & 0x3f) << 8) | b[3]) / 10 | 0,
    estimated_pm10_0_ug_m3: (((b[4] & 0x3f) << 8) | b[5]) / 10 | 0,
    family: b[0],
    unknown1: (b[2] & 0x80) ? 1 : 0,
    mic: 'CRC',
  });
  return 1;
}

/**
 * The indoor console sensors — WH25, WH32, WH32B, WN32B — and the front door to the whole frequency-keyed
 * family. The length of the burst decides which decoder gets it, so this one entry covers everything from a
 * desk thermometer to a full outdoor array.
 */
export const fineoffsetWh25: RDevice = register({
  num: 78,
  name: 'Fine Offset WH25, WH32, WH32B, WN32B, WH24, WH65, WS69, HP1000, Misol WS2320 temperature/humidity/pressure sensor',
  what: 'indoor console sensors and outdoor weather arrays',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 20000,                                 // the burst opens with a gap of about 19 ms
  bands: [433920000, 868300000, 915000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    let type = 25;
    if (n < 160) return wh0290Decode(bits, ctx);
    if (n < 190) type = 32;                          // the newer WN32B
    else if (n < 440) return wh24Decode(bits, ctx);  // nominal for the WH25 is about 488 bit periods
    if (n > 510) type = 32;                          // the WH32B sends two packets in one transmission

    const at = payloadStart(bits);
    if (at + 64 > n) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 64);

    const msgType = b[0] & 0xf0;
    if (type === 32 && msgType === 0xd0) type = 31;
    else if (msgType !== 0xe0) {
      if (b[0] === 0x41) return wh0290Decode(bits, ctx);
      return DECODE_ABORT_EARLY;
    }

    if (((addBytes(b, 6) & 0xff) - b[6]) & 0xff) return DECODE_FAIL_MIC;
    // The second check is an exclusive-or with its nibbles swapped. The WH32 variants leave it out.
    const bitsum = xorBytes(b, 6);
    if (type === 25 && (((bitsum & 0x0f) << 4) | (bitsum >> 4)) !== b[7]) return DECODE_FAIL_MIC;

    const tempRaw = ((b[1] & 0x03) << 8) | b[2];
    const pressureRaw = (b[4] << 8) | b[5];
    const out: Record<string, unknown> = {
      model: type === 31 ? 'Fineoffset-WH32' : type === 32 ? 'Fineoffset-WH32B' : 'Fineoffset-WH25',
      id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
      battery_ok: ((b[1] & 0x08) >> 3) ? 0 : 1,
      temperature_C: round1((tempRaw - 400) * 0.1),
      humidity: b[3],
      mic: 'CRC',
    };
    if (pressureRaw !== 0xffff) out.pressure_hPa = round1(pressureRaw * 0.1);
    ctx.emit(out as R433Data);
    return 1;
  },
});

/**
 * The WH51 soil moisture probe, and the WN31 thermometer that shares its frame.
 *
 * It reports both a moisture percentage of its own working out and the raw reading behind it, because the
 * conversion assumes a particular soil and the raw value lets you calibrate for your own.
 */
export const fineoffsetWh51: RDevice = register({
  num: 142,
  name: 'Fine Offset / Ecowitt WH51, WN31, SwitchDoc Labs SM23 soil moisture sensor',
  what: 'soil moisture probe',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 5000,
  bands: [433920000, 915000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 120) return DECODE_ABORT_LENGTH;
    const at = payloadStart(bits);
    if (at + 14 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 14 * 8);

    if (b[0] !== 0x51) return DECODE_ABORT_EARLY;
    if ((addBytes(b, 13) & 0xff) !== b[13]) return DECODE_FAIL_MIC;
    if (crc8(b, 12, 0x31, 0) !== b[12]) return DECODE_FAIL_MIC;

    // Battery voltage in tenths of a volt. It runs on one alkaline cell and reads badly below about 1.3 V,
    // which is well before the cell is flat, so the useful thresholds are tighter than they look.
    const mvBits = b[4] & 0x1f;
    const level = mvBits >= 16 ? 1.0 : mvBits === 15 ? 0.9 : mvBits === 14 ? 0.5 : mvBits === 13 ? 0.1 : 0.0;

    ctx.emit({
      model: 'Fineoffset-WH51',
      id: hex2(b[1]) + hex2(b[2]) + hex2(b[3]),
      battery_ok: level,
      battery_mV: mvBits * 100,
      moisture: b[6],
      // Set when the reading has just changed; the sensor then reports every ten seconds instead of every 70.
      boost: (b[4] & 0xe0) >> 5,
      ad_raw: ((b[7] & 0x01) << 8) | b[8],
      mic: 'CRC',
    });
    return 1;
  },
});

/** The Alecto WS-1200 rain and temperature unit, in its two hardware revisions and its clock frame. */
function alectoWs1200(bits: BitBuffer, ctx: DecodeCtx, version: 1 | 2): number {
  const n = bits.bitsPerRow[0];
  const row0 = bits.bb[0];
  const want = version === 1 ? 63 : 95;
  if (n !== want || (row0[0] >> 1) !== 0x7f) return DECODE_ABORT_LENGTH;

  if (version === 2 && (row0[1] >> 5) !== 0x3) {
    // The same length also carries a radio clock frame, which is worth reading rather than discarding.
    if ((row0[1] >> 1) !== 0x52) return DECODE_ABORT_LENGTH;
    const c = bits.bytes(0, 7, 88);
    if (crc8(c, 10, 0x31, 0) || ((addBytes(c, 10) - c[10]) & 0xff)) return DECODE_FAIL_MIC;
    // Every field is already in decimal digits, so it is printed rather than converted.
    const two = (v: number) => v.toString(16).padStart(2, '0');
    ctx.emit({
      model: 'Alecto-WS1200v2',
      id: c[1],
      battery_ok: ((c[2] >> 7) & 1) ? 0 : 1,
      radio_clock: `${(c[4] + 0x2000).toString(16)}-${two(c[5])}-${two(c[6])}T${two(c[7])}:${two(c[8])}:${two(c[9])}`,
      mic: 'CRC',
    });
    return 1;
  }
  if (version === 1 && (row0[1] >> 5) !== 0x3) return DECODE_ABORT_LENGTH;

  const b = bits.bytes(0, 7, version === 1 ? 56 : 88);
  if (crc8(b, 7, 0x31, 0)) return DECODE_FAIL_MIC;
  if (version === 2 && ((addBytes(b, 7) - b[7]) & 0xff)) return DECODE_FAIL_MIC;

  ctx.emit({
    model: version === 1 ? 'Alecto-WS1200v1' : 'Alecto-WS1200v2',
    id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
    battery_ok: ((b[1] >> 3) & 1) ? 0 : 1,
    temperature_C: round1(((((b[1] & 0x07) << 8) | b[2]) - 400) * 0.1),
    rain_mm: round1(((b[4] << 8) | b[3]) * 0.3),     // little-endian tip counter, 0.3 mm a tip
    mic: 'CRC',
  });
  return 1;
}

/** The WH0530 rain and temperature unit, and the two Alecto revisions that share its air. */
export const fineoffsetWh0530: RDevice = register({
  num: 79,
  name: 'Fine Offset Electronics WH0530 temperature/rain sensor',
  what: 'rain gauge with a thermometer; also the Alecto WS-1200',
  modulation: Modulation.OOK_PWM,
  shortWidth: 504,
  longWidth: 1480,
  resetLimit: 1200,
  tolerance: 160,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n === 63) return alectoWs1200(bits, ctx, 1);
    if (n === 95) return alectoWs1200(bits, ctx, 2);
    if (n !== 71) return DECODE_ABORT_LENGTH;        // an exact length, to keep look-alikes out

    const row0 = bits.bb[0];
    if ((row0[0] >> 1) !== 0x7f || (row0[1] >> 5) !== 0x3) return DECODE_ABORT_EARLY;

    const b = bits.bytes(0, 7, 64);
    if (crc8(b, 7, 0x31, 0) || ((addBytes(b, 7) - b[7]) & 0xff)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Fineoffset-WH0530',
      id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
      battery_ok: ((b[1] >> 3) & 1) ? 0 : 1,
      temperature_C: round1(((((b[1] & 0x07) << 8) | b[2]) - 400) * 0.1),
      rain_mm: round1(((b[4] << 8) | b[3]) * 0.3),
      mic: 'CRC',
    });
    return 1;
  },
});
