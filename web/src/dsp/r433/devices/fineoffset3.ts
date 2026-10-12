/**
 * The Fine Offset air-quality sensors and the big outdoor arrays, plus the WH1080 that started the line.
 *
 * Everything after the WH1080 shares one arrangement: a run of alternating bits, the sync word `2d d4`, a
 * family-code byte saying which sensor it is, the readings, a CRC-8 and a byte sum. What differs is length and
 * what is packed where, so each is its own registration keyed on that family byte.
 *
 * Two habits of this range are worth stating because both produce confident nonsense if missed. Several fields
 * use an all-ones value to mean "not measured this time" rather than a reading — a WS90 with a still
 * anemometer would otherwise report a 51.1 m/s gust and a 102.3 degree bearing every transmission. And the
 * battery is reported as bars split across two different bytes, where six bars is not a very full battery but
 * the sensor saying it is running from external power.
 *
 * The WH1080 is the odd one out and predates all of it. It ships keyed and frequency-shifted, sends three
 * different message types on one frame, and comes in variants with seven or eight preamble bits — the short
 * ones need the whole buffer shifted a bit before anything reads. Its CRC starts at 0xff because the preamble
 * byte is included rather than skipped.
 *
 * Ported from rtl_433's `src/devices/fineoffset_wh1080.c`, `_wh43.c`, `_wh45.c`, `_wh46.c`, `_ws85.c` and
 * `_ws90.c` (GPL-2.0-or-later).
 */

import type { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, crc8 } from '../util.js';

const BANDS = [433920000, 868300000, 915000000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const hex6 = (v: number) => (v >>> 0).toString(16).padStart(6, '0');
const hex2 = (v: number) => v.toString(16).padStart(2, '0');

/** The tail of the preamble and the sync word the modern range opens with. */
const SYNC24 = new Uint8Array([0xaa, 0x2d, 0xd4]);
/** The big arrays keep one more preamble byte in the pattern they search for. */
const SYNC32 = new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]);

/**
 * Battery as this range reports it: bars packed into two separate bytes, where six means the sensor is on
 * external power rather than on an unusually good battery.
 */
function batteryBars(hi: number, lo: number): { bars: number; level: number; extPower: number } {
  const bars = ((hi & 0x40) >> 4) | ((lo & 0xc0) >> 6);
  return { bars, level: Math.min(bars * 0.2, 1), extPower: bars === 6 ? 1 : 0 };
}

// ---- WH43 air quality ------------------------------------------------------------------------------------

export const fineoffsetWh43: RDevice = register({
  num: 283,
  name: 'Fine Offset WH43 air quality sensor',
  what: 'particulate sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 2500,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const at = bits.search(0, 0, SYNC24, 24) + 24;
    if (at + 10 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 10 * 8);

    if (b[0] !== 0x43) return DECODE_ABORT_EARLY;
    if (crc8(b, 8, 0x31, 0x00) !== b[8] || (addBytes(b, 9) & 0xff) !== b[9]) return DECODE_FAIL_MIC;

    const batt = batteryBars(b[4], b[6]);
    ctx.emit({
      model: 'Fineoffset-WH43',
      id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
      battery_ok: batt.bars > 1 ? 1 : 0,        // one bar is the sensor saying "low", not "a fifth left"
      battery_pct: Math.round(100 * batt.level),
      ext_power: batt.extPower,
      pm2_5_ug_m3: Math.trunc((((b[4] & 0x3f) << 8) | b[5]) / 10),
      estimated_pm10_0_ug_m3: Math.trunc((((b[6] & 0x3f) << 8) | b[7]) / 10),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---- WH45 air quality with carbon dioxide ----------------------------------------------------------------

export const fineoffsetWh45: RDevice = register({
  num: 219,
  name: 'Fine Offset WH45 air quality sensor',
  what: 'particulate and carbon dioxide sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 2500,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < 170 || n > 240) return DECODE_ABORT_LENGTH;
    const at = bits.search(0, 0, SYNC24, 24) + 24;
    if (at + 15 * 8 > n) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 15 * 8);

    if (b[0] !== 0x45) return DECODE_ABORT_EARLY;
    if (crc8(b, 13, 0x31, 0x00) !== b[13] || (addBytes(b, 14) & 0xff) !== b[14]) return DECODE_FAIL_MIC;

    const batt = batteryBars(b[7], b[9]);
    ctx.emit({
      model: 'Fineoffset-WH45',
      id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
      battery_ok: round1(batt.level),
      ext_power: batt.extPower,
      temperature_C: round1(((((b[4] & 0x07) << 8) | b[5]) - 400) * 0.1),
      humidity: b[6],
      pm2_5_ug_m3: round1(((((b[7] & 0x3f) << 8) | b[8])) * 0.1),
      pm10_ug_m3: round1(((((b[9] & 0x3f) << 8) | b[10])) * 0.1),
      co2_ppm: (b[11] << 8) | b[12],
      mic: 'CRC',
    });
    return 1;
  },
});

// ---- WH46, the WH45 with two more particle sizes ---------------------------------------------------------

export const fineoffsetWh46: RDevice = register({
  num: 262,
  name: 'Fine Offset WH46 air quality sensor',
  what: 'particulate and carbon dioxide sensor, four particle sizes',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 2500,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const at = bits.search(0, 0, SYNC24, 24) + 24;
    if (at + 21 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 21 * 8);

    if (b[0] !== 0x46) return DECODE_ABORT_EARLY;
    if (crc8(b, 19, 0x31, 0x00) !== b[19] || (addBytes(b, 20) & 0xff) !== b[20]) return DECODE_FAIL_MIC;

    const batt = batteryBars(b[7], b[9]);
    const data: R433Data = {
      model: 'Fineoffset-WH46',
      id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
      battery_ok: batt.bars > 1 ? 1 : 0,
      battery_pct: Math.round(100 * batt.level),
      ext_power: batt.extPower,
      temperature_C: round1(((((b[4] & 0x07) << 8) | b[5]) - 400) * 0.1),
      humidity: b[6],
      pm1_ug_m3: round1(((b[13] << 8) | b[14]) * 0.1),
      pm2_5_ug_m3: round1(((((b[7] & 0x3f) << 8) | b[8])) * 0.1),
      pm4_ug_m3: round1(((b[15] << 8) | b[16]) * 0.1),
      pm10_ug_m3: round1(((((b[9] & 0x3f) << 8) | b[10])) * 0.1),
      co2_ppm: (b[11] << 8) | b[12],
      mic: 'CRC',
    };
    // Two bytes nobody has explained; carried across rather than dropped.
    data.unknown1 = (b[17] << 8) | b[18];
    ctx.emit(data);
    return 1;
  },
});

// ---- WS85 and WS90, the big outdoor arrays ---------------------------------------------------------------

/** All-ones means "not measured this time" across most of these fields. */
const NO_WIND = 0x1ff, NO_BYTE = 0xff;

export const fineoffsetWs85: RDevice = register({
  num: 287,
  name: 'Fine Offset WS85 weather station',
  what: 'outdoor array: wind and rain',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 3000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < 168 || n > 500) return DECODE_ABORT_LENGTH;
    const at = bits.search(0, 0, SYNC32, 32) + 32;
    if (at + 32 * 8 > n) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 32 * 8);

    if (b[0] !== 0x85) return DECODE_ABORT_EARLY;
    if (crc8(b, 26, 0x31, 0x00) !== b[26] || (addBytes(b, 27) & 0xff) !== b[27]) return DECODE_FAIL_MIC;

    const flags = b[5];
    const windAvg = ((flags & 0x10) << 4) | b[7];
    const windDir = ((flags & 0x20) << 3) | b[8];
    const windMax = ((flags & 0x40) << 2) | b[9];
    const batteryMv = b[4] * 20;
    const supercap = b[17] & 0x3f;

    const data: R433Data = {
      model: 'Fineoffset-WS85',
      id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
      battery_ok: batteryMv > 2400 ? 1 : 0,
      battery_pct: Math.min(100, batteryMv < 1400 ? 0 : Math.trunc((batteryMv - 1400) / 16)),
      battery_mV: batteryMv,
      flags: hex2(flags),
      rain_mm: round1(((b[15] << 8) | b[16]) * 0.1),
      rain_start: (b[12] & 0x10) >> 4,
      firmware: b[25],
      mic: 'CRC',
    };
    if (windDir !== NO_WIND) data.wind_dir_deg = windDir;
    if (windAvg !== NO_WIND) data.wind_avg_m_s = round1(windAvg * 0.1);
    if (windMax !== NO_WIND) data.wind_max_m_s = round1(windMax * 0.1);
    if (supercap !== NO_BYTE) data.supercap_V = round1(supercap * 0.1);
    ctx.emit(data);
    return 1;
  },
});

export const fineoffsetWs90: RDevice = register({
  num: 244,
  name: 'Fine Offset WS90 weather station',
  what: 'outdoor array: wind, rain, temperature, humidity, pressure, light and ultraviolet',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 3000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < 168 || n > 500) return DECODE_ABORT_LENGTH;
    const at = bits.search(0, 0, SYNC32, 32) + 32;
    if (at + 32 * 8 > n) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 32 * 8);

    if (b[0] !== 0x90) return DECODE_ABORT_EARLY;
    // This one runs the CRC over the whole frame and expects zero, rather than comparing a stored byte.
    if (crc8(b, 31, 0x31, 0x00) !== 0 || (addBytes(b, 31) & 0xff) !== b[31]) return DECODE_FAIL_MIC;

    const flags = b[7];
    const lightRaw = (b[4] << 8) | b[5];
    const batteryMv = b[6] * 20;
    const tempRaw = ((flags & 0x03) << 8) | b[8];
    const windAvg = ((flags & 0x10) << 4) | b[10];
    const windDir = ((flags & 0x20) << 3) | b[11];
    const windMax = ((flags & 0x40) << 2) | b[12];
    const pressure = (b[14] << 8) | b[15];
    const supercap = b[21] & 0x3f;

    const data: R433Data = {
      model: 'Fineoffset-WS90',
      id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
      battery_ok: round2(Math.min(100, batteryMv < 1400 ? 0 : Math.trunc((batteryMv - 1400) / 16)) * 0.01),
      battery_mV: batteryMv,
      flags: hex2(flags),
      rain_mm: round1(((b[19] << 8) | b[20]) * 0.1),
      rain_start: (b[16] & 0x10) >> 4,
      firmware: b[29],
      mic: 'CRC',
    };
    if (tempRaw !== 0x3ff) data.temperature_C = round1((tempRaw - 400) * 0.1);
    if (b[9] !== NO_BYTE) data.humidity = b[9];
    if (pressure !== 0x3fff) data.pressure_hPa = pressure;
    if (windDir !== NO_WIND) data.wind_dir_deg = windDir;
    if (windAvg !== NO_WIND) data.wind_avg_m_s = round1(windAvg * 0.1);
    if (windMax !== NO_WIND) data.wind_max_m_s = round1(windMax * 0.1);
    if (b[13] !== NO_BYTE) data.uvi = round1(b[13] * 0.1);
    if (lightRaw !== 0xffff) data.light_lux = lightRaw * 10;
    if (supercap !== NO_BYTE) data.supercap_V = round1(supercap * 0.1);
    ctx.emit(data);
    return 1;
  },
});

// ---- WH1080 / WH3080, the one that started the line ------------------------------------------------------

/** The sixteen compass points this station reports, in degrees. */
const WIND_DIR = [0, 23, 45, 68, 90, 113, 135, 158, 180, 203, 225, 248, 270, 293, 315, 338];

/**
 * One reader for both radios and all three message types.
 *
 * The frame carries no family code, so what it is has to be worked out from its length and from a nibble in
 * the second byte. Variants with a seven-bit preamble need the whole buffer shifted along by one before any
 * of it lines up, and the frequency-shifted version has its preamble byte faked back in so that one CRC over
 * eleven bytes serves both radios.
 */
function wh1080Decode(bits: BitBuffer, ctx: DecodeCtx, fsk: boolean): number {
  if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
  const n = bits.bitsPerRow[0];

  let br: Uint8Array;
  let sensMsg = 10;          // 10 = weather or clock, 7 = the WH3080's light head
  let shortPreamble = false;

  if (fsk) {
    const at = bits.search(0, 0, SYNC24, 24) + 24;
    if (at + 11 * 8 > n) return DECODE_ABORT_LENGTH;
    // Taken one byte early so the keyed frame's 0xff preamble can be faked in and one CRC serve both.
    br = bits.bytes(0, at - 8, 11 * 8);
    br[0] = 0xff;
  } else if (n >= 88 && n < 100) {
    br = bits.bytes(0, 0, 11 * 8);
  } else if (n === 87) {
    shortPreamble = true;
    br = new Uint8Array(11);
    br.set(bits.bytes(0, 7, 10 * 8), 1);
    br[0] = (bits.bb[0][0] >> 1) | 0x80;
  } else if (n === 64) {
    sensMsg = 7;
    br = bits.bytes(0, 0, 8 * 8);
  } else if (n === 63) {
    shortPreamble = true;
    sensMsg = 7;
    br = new Uint8Array(8);
    br.set(bits.bytes(0, 7, 7 * 8), 1);
    br[0] = (bits.bb[0][0] >> 1) | 0x80;
  } else {
    return DECODE_ABORT_LENGTH;
  }

  if (br[0] !== 0xff) return DECODE_FAIL_SANITY;
  // The preamble byte is inside the CRC, which is why it starts at 0xff rather than zero.
  if (crc8(br, sensMsg === 10 ? 11 : 8, 0x31, 0xff)) return DECODE_FAIL_MIC;

  const top = br[1] >> 4;
  const msgType = top === 0x0a ? 0 : top === 0x0b ? 1 : top === 0x07 ? 2 : -1;
  if (msgType < 0) return DECODE_FAIL_SANITY;

  const id = ((br[1] << 4) & 0xf0) | (br[2] >> 4);
  const two = (v: number) => ((v & 0xf0) >> 4) * 10 + (v & 0x0f);

  if (msgType === 0) {
    let tempC: number;
    if (fsk) {
      let raw = ((br[2] & 0x0f) << 8) | br[3];
      // Sign and magnitude, not two's complement.
      if (raw & 0x800) raw = -(raw & 0x7ff);
      tempC = raw * 0.1;
    } else {
      tempC = ((((br[2] & 0x03) << 8) | br[3]) - 400) * 0.1;
    }
    ctx.emit({
      model: 'Fineoffset-WHx080',
      subtype: msgType,
      id,
      battery_ok: (br[9] >> 4) === 1 ? 0 : 1,
      temperature_C: round1(tempC),
      humidity: br[4],
      wind_dir_deg: WIND_DIR[br[9] & 0x0f],
      wind_avg_km_h: round2(br[5] * 0.34 * 3.6),
      wind_max_km_h: round2(br[6] * 0.34 * 3.6),
      rain_mm: round1((((br[7] & 0x0f) << 8) | br[8]) * 0.3),
      mic: 'CRC',
    });
    return 1;
  }

  if (msgType === 1) {
    const clock = `${2000 + two(br[6])}-${String(((br[7] & 0x10) >> 4) * 10 + (br[7] & 0x0f)).padStart(2, '0')}`
      + `-${String(two(br[8])).padStart(2, '0')}T${String(((br[3] & 0x30) >> 4) * 10 + (br[3] & 0x0f)).padStart(2, '0')}`
      + `:${String(two(br[4])).padStart(2, '0')}:${String(two(br[5])).padStart(2, '0')}`;
    ctx.emit({
      model: 'Fineoffset-WHx080',
      subtype: msgType,
      id,
      // Which national time signal the station is locked to.
      signal: (br[2] & 0x0f) === 10 ? 'DCF77' : 'WWVB/MSF',
      radio_clock: clock,
      mic: 'CRC',
    });
    return 1;
  }

  const light = (br[4] << 16) | (br[5] << 8) | br[6];
  ctx.emit({
    model: 'Fineoffset-WHx080',
    subtype: msgType,
    uv_sensor_id: id,
    uv_status: br[3] === 85 ? 'OK' : 'ERROR',
    uv_index: br[2] & 0x0f,
    lux: round1(light * 0.1),
    // The two preamble lengths came with different light-head calibrations.
    wm: round2(light / (shortPreamble ? 1265.8 : 6830.0)),
    mic: 'CRC',
  });
  return 1;
}

export const fineoffsetWh1080: RDevice = register({
  num: 32,
  name: 'Fine Offset WH1080/WH3080 weather station',
  what: 'outdoor array with an optional light and ultraviolet head',
  modulation: Modulation.OOK_PWM,
  shortWidth: 544,
  longWidth: 1524,
  resetLimit: 2800,
  bands: [433920000],
  decode: (_dev, bits, ctx) => wh1080Decode(bits, ctx, false),
});

export const fineoffsetWh1080Fsk: RDevice = register({
  num: 155,
  name: 'Fine Offset WH1080/WH3080 weather station, frequency shifted',
  what: 'outdoor array with an optional light and ultraviolet head',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 5800,
  bands: [433920000, 868300000],
  decode: (_dev, bits, ctx) => wh1080Decode(bits, ctx, true),
});
