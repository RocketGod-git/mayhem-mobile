/**
 * More of the weather tail: an Alecto family, two Oregon-lineage sensors, a tank gauge and a wind station.
 *
 * The Alecto is the interesting one here. It is not a sensor but a family of them sharing one frame, and which
 * kind of reading arrived is decided by two bits plus the shape of the bytes after them — temperature and
 * humidity, or rainfall, or wind speed, or wind direction and gust. The wind readings are stitched together
 * from two rows several apart in the same transmission, which is why this decoder reaches so far into the
 * capture and why it has to be careful about how much of one arrived.
 *
 * Three of these check themselves in ways worth noticing. The Ambient Weather sends its four payload bytes
 * twice, the second copy inverted, and then a Fletcher-style checksum on top — belt and braces for a sensor
 * that costs almost nothing. The TS-FT002 tank gauge sends every field backwards, so the whole frame is
 * reflected before anything can be read. And the WS2032 carries both a byte sum and a CRC, which between them
 * make it the most trustworthy thing in this file.
 *
 * Two deviations, both about not breaking on a short capture or a masked sum:
 *
 *  - Alecto reads rows one through six, and up to row nine on its wind path, without ever checking how many
 *    rows arrived. Those counts are checked here first.
 *  - WS2032 tests whether its twelve-byte sum is zero before comparing it, and `addBytes` masks to a byte, so
 *    a true sum of exactly 256 would read as zero and be thrown away. The sum is taken at full width.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `alecto.c`, `infactory.c`, `oregon_scientific_sl109h.c`,
 * `ambientweather_tx8300.c`, `ts_ft002.c`, `eurochron.c`, `ws2032.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addNibbles, crc4, crc8, reflectBytes, reverse8, xorBytes } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
/** Sign-extend a twelve-bit field sitting in the top of a sixteen-bit word, then drop the low nibble. */
const signed12 = (v: number) => ((v & 0xffff) << 16) >> 20;
/** Two decimal digits packed one to a nibble. */
const fromBcd = (x: number) => ((x & 0xf0) >> 4) * 10 + (x & 0x0f);

/** The byte sum at full width. `addBytes` masks to a byte, which some of these compare against zero. */
function sumBytes(m: Uint8Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += m[i];
  return s;
}

// ---------------------------------------------------------------------------
// Alecto V1 family (16)
// ---------------------------------------------------------------------------

/**
 * Alecto's check sums the nibbles of the first four bytes, backwards, and then either subtracts the total from
 * fifteen or adds seven to it — which of the two depends on a value in the frame itself.
 */
function alectoChecksum(b: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const t = reverse8(b[i]);
    sum += (t & 0x0f) + ((t & 0xf0) >> 4);
  }
  sum = (b[1] & 0x7f) === 0x6c ? sum + 0x07 : 0x0f - sum;
  return reverse8((sum & 0x0f) << 4) === (b[4] >> 4);
}

export const alectoV1: RDevice = register({
  num: 16,
  name: 'AlectoV1 Weather Sensor (Alecto WS3500 WS4500 Ventus W155/W044 Oregon)',
  what: 'weather station: temperature, humidity, rain and wind',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 7000,
  resetLimit: 10000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Upstream reaches into rows one through six without asking how many arrived.
    if (bits.numRows < 7) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[1] !== 36) return DECODE_ABORT_LENGTH;

    const bb = bits.bb;
    if (bb[1][0] !== bb[5][0] || bb[2][0] !== bb[6][0]
      || (bb[1][4] & 0x0f) !== 0 || (bb[5][4] & 0x0f) !== 0
      || bb[5][0] === 0 || bb[5][1] === 0) return DECODE_ABORT_EARLY;
    if (!alectoChecksum(bb[1]) || !alectoChecksum(bb[5])) return DECODE_FAIL_MIC;

    const b = bb[1];
    const batteryOk = (b[1] & 0x80) >> 7 ? 0 : 1;
    const msgType = (b[1] & 0x60) >> 5;
    const isRain = (b[1] & 0x0f) === 0x0c;
    const common = {
      id: reverse8(b[0]),
      channel: (b[0] & 0x0c) >> 2,
      battery_ok: batteryOk,
      mic: 'CHECKSUM',
    };

    if (msgType === 0x3 && !isRain) {
      // Wind. Speed comes from one row and the gust and direction from another, four rows further on.
      let skip = -1;
      if ((b[1] & 0x0e) === 0x08 && b[2] === 0) skip = 0;
      else if ((b[1] & 0x0e) === 0x0e) skip = 4;
      if (skip < 0) return DECODE_FAIL_SANITY;
      // With a skip of four this reaches row nine, which upstream never checks for.
      if (bits.numRows < 6 + skip) return DECODE_ABORT_EARLY;

      const gustRow = bb[5 + skip];
      ctx.emit({
        model: 'AlectoV1-Wind',
        type: 'Weather',
        ...common,
        wind_avg_m_s: round2(reverse8(bb[1 + skip][3]) * 0.2),
        wind_max_m_s: round2(reverse8(gustRow[3]) * 0.2),
        wind_dir_deg: (reverse8(gustRow[2]) << 1) | (gustRow[1] & 0x01),
      });
      return 1;
    }

    if (msgType === 0x3 && isRain) {
      ctx.emit({
        model: 'AlectoV1-Rain',
        type: 'Weather',
        ...common,
        rain_mm: round2(((reverse8(b[3]) << 8) | reverse8(b[2])) * 0.25),
      });
      return 1;
    }

    // Temperature and humidity, which the sensor repeats across every row of the transmission.
    if (msgType !== 0x3
      && bb[2][0] === bb[3][0] && bb[3][0] === bb[4][0]
      && bb[4][0] === bb[5][0] && bb[5][0] === bb[6][0]
      && (bb[3][4] & 0x0f) === 0 && (bb[5][4] & 0x0f) === 0) {
      const humidity = fromBcd(reverse8(b[3]));
      // The Prologue sensor is also thirty-six bits and is sometimes mistaken for this one.
      if (humidity > 100) return DECODE_FAIL_SANITY;

      ctx.emit({
        model: 'AlectoV1-Temperature',
        type: 'Weather',
        ...common,
        temperature_C: round2(signed12((reverse8(b[1]) & 0xf0) | (reverse8(b[2]) << 8)) * 0.1),
        humidity,
      });
      return 1;
    }
    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// inFactory outdoor sensor (91)
// ---------------------------------------------------------------------------

/**
 * A four-bit CRC computed over a frame that has been rearranged first.
 *
 * The channel number is copied into the position the check itself occupies before the CRC is taken, and the
 * last nibble is then exclusive-ored in on its own rather than being fed through the polynomial. Neither step
 * is discoverable from the frame — it has to be known.
 */
export const infactory: RDevice = register({
  num: 91,
  name: 'inFactory, nor-tec, FreeTec NC-3982-913 temperature humidity sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  syncWidth: 500,
  shortWidth: 2000,
  longWidth: 4000,
  resetLimit: 5000,
  tolerance: 750,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n !== 40 && n !== 41 && n !== 42) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    const channel = b[4] & 0x03;
    if (!channel) return DECODE_ABORT_EARLY;

    // The channel bits stand in for the check while the CRC is taken over the frame.
    const msg = Uint8Array.from([b[0], (b[1] & 0x0f) | ((b[4] & 0x0f) << 4), b[2], b[3], b[4]]);
    const crc = crc4(msg, 4, 0x13, 0) ^ (msg[4] >> 4);
    if (crc !== (b[1] >> 4)) return DECODE_FAIL_MIC;

    const humidity = (b[3] & 0x0f) * 10 + (b[4] >> 4);   // packed as digits, with 'A0' meaning a hundred
    if (humidity > 100) return DECODE_FAIL_SANITY;
    // This family is rated to seventy degrees at the widest; outside that it cannot be a reading.
    const tempF = round2((((b[2] << 4) | (b[3] >> 4)) - 900) * 0.1);
    if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'inFactory-TH',
      type: 'Weather',
      id: b[0],
      channel,
      battery_ok: (b[1] >> 2) & 1 ? 0 : 1,
      button: (b[1] >> 3) & 1,
      temperature_F: tempF,                        // this one reports Fahrenheit on the wire
      humidity,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Oregon Scientific SL109H (54)
// ---------------------------------------------------------------------------

/**
 * Four bits of check, which is little enough that everything else has to be bounded too.
 *
 * A Bresser sensor sends rows of exactly the same length with a completely different meaning, so a frame that
 * passes this check may still belong to the other one. Hence the repeat requirement, the rejection of digits
 * that cannot be decimal, and the temperature bound.
 */
export const oregonSl109h: RDevice = register({
  num: 54,
  name: 'Oregon Scientific SL109H Remote Thermal Hygro Sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 5000,
  resetLimit: 10000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The row length must be exact: a longer one belongs to a different sensor entirely.
    const row = bits.findRepeatedRow(2, 38);
    if (row < 0 || bits.bitsPerRow[row] !== 38) return DECODE_ABORT_LENGTH;

    const msg = bits.bb[row];
    if (!msg[0] && !msg[1] && !msg[2] && !msg[3]) return DECODE_FAIL_SANITY;
    const chk = msg[0] >> 4;

    const b = bits.bytes(row, 2, 36);              // realign so the channel sits on a nibble
    b[0] &= 0x3f;
    if (chk === 0 && !b[0] && !b[1] && !b[2]) return DECODE_FAIL_SANITY;
    if ((addNibbles(b, 5) & 0x0f) !== chk) return DECODE_FAIL_MIC;

    const channelCode = b[0] >> 4;
    if (channelCode === 3) return DECODE_FAIL_SANITY;

    // The humidity is decimal digits, so a nibble above nine is not a reading.
    const tens = b[0] & 0x0f, ones = b[1] >> 4;
    if (tens > 9 || ones > 9) return DECODE_FAIL_SANITY;

    const tempC = round1(signed12(((b[1] & 0x0f) << 12) | (b[2] << 4)) * 0.1);
    if (tempC < -20 || tempC > 60) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Oregon-SL109H',
      type: 'Weather',
      id: ((b[3] & 0x0f) << 4) | (b[4] >> 4),      // changes when the battery does
      channel: channelCode ? channelCode : 3,
      temperature_C: tempC,
      humidity: tens * 10 + ones,
      status: b[3] >> 4,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Ambient Weather TX-8300 (112)
// ---------------------------------------------------------------------------

/** Two checks over the four payload nibbles, one counting every bit and one only alternate bits. */
function tx8300Checksum(b: Uint8Array): number {
  let x = 0, y = 0;
  for (let i = 0; i < 4; i++) {
    x += (b[i] & 0x0f) + ((b[i] & 0xf0) >> 4);
    y += (b[i] & 0x05) + ((b[i] & 0x50) >> 4);
  }
  return (((~x & 0x0f) << 4) | (~y & 0x0f)) & 0xff;
}

/**
 * Belt and braces on a sensor that costs almost nothing: the payload is sent twice, the second copy inverted,
 * and a checksum covers it as well.
 *
 * The very first bit of the frame is often mangled by the demodulator, so it is recovered from the inverted
 * copy before the two are compared — which is the only reason the comparison can be exact.
 */
export const ambientWeatherTx8300: RDevice = register({
  num: 112,
  name: 'Ambient Weather TX-8300 Temperature/Humidity Sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 6500,
  resetLimit: 8000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 74) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, 2, 72);                // two bits of run-in, then nine bytes
    for (let i = 4; i < 8; i++) b[i] ^= 0xff;      // turn the second copy back over
    b[0] = (b[0] & 0x7f) | (b[4] & 0x80);          // the first bit, recovered from that copy

    if (b[0] !== b[4] || b[1] !== b[5] || b[2] !== b[6] || b[3] !== b[7]) return DECODE_FAIL_MIC;
    if ((tx8300Checksum(b) ^ b[8]) !== 0) return DECODE_FAIL_MIC;

    const temp = (b[2] & 0x0f) * 10 + ((b[3] & 0xf0) >> 4) + (b[3] & 0x0f) * 0.1;
    const tens = (b[0] & 0xf0) >> 4, ones = b[0] & 0x0f;

    const data: R433Data = {
      model: 'AmbientWeather-TX8300',
      type: 'Weather',
      id: ((b[1] & 0x07) << 4) | ((b[2] & 0xf0) >> 4),
      channel: (b[1] & 0x30) >> 4,
      battery: (b[1] & 0xc0) >> 6,                 // which bit means what is not known
      temperature_C: round1((b[1] & 0x08) >> 3 ? -temp : temp),
      mic: 'CHECKSUM',
    };
    // A humidity that is not two decimal digits means the sensor had nothing to report.
    if (tens <= 9 && ones <= 9) data.humidity = tens * 10 + ones;
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// TS-FT002 tank level gauge (125)
// ---------------------------------------------------------------------------

/**
 * An ultrasonic gauge for a water tank, which sends everything backwards.
 *
 * Bits go out least significant first, so the whole frame is reflected before any of it means anything — and
 * that reflection also reverses the nibbles, which is why the depth and temperature are assembled from pieces
 * that look out of order.
 *
 * It arrives at one of three lengths depending on how much of the run-in the demodulator kept, so the frame is
 * realigned from whichever it was.
 */
export const tsFt002: RDevice = register({
  num: 125,
  name: 'TS-FT002 Wireless Ultrasonic Tank Liquid Level Meter With Temperature Sensor',
  what: 'tank level gauge with a thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 464,
  longWidth: 948,
  gapLimit: 1200,
  resetLimit: 2000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    const b = new Uint8Array(9);
    if (n === 72) {
      bits.extractBytes(0, 0, b, 72);
    } else if (n === 71) {
      bits.extractBytes(0, 7, b.subarray(1), 64);
      b[0] = bits.bb[0][0] >> 1;
    } else if (n === 70) {
      bits.extractBytes(0, 6, b.subarray(1), 64);
      b[0] = (bits.bb[0][0] >> 2) | 0x80;
    } else {
      return DECODE_ABORT_LENGTH;
    }

    if (xorBytes(b, 9) !== 0) return DECODE_FAIL_MIC;
    reflectBytes(b, 8);                            // eight, not nine: the check byte stays as it was
    if (b[2] !== 0x11) return DECODE_FAIL_SANITY;  // the only message type it sends

    // How often it speaks is itself encoded, in three ranges rather than as a number.
    const t = b[5] >> 4;
    const transmit = (t & 0x07) === 0x07 ? 5 : (t & 0x08) === 0x08 ? 30 : t === 0 ? 180 : 0;

    ctx.emit({
      model: 'TS-FT002',
      type: 'Weather',
      id: b[1],
      depth_cm: (b[3] << 4) | (b[4] & 0x0f),       // 0x5dc means it could not get a reading
      temperature_C: round1((((b[6] << 4) | (b[5] & 0x0f)) - 400) * 0.1),
      transmit_s: transmit,
      flags: b[4] >> 4,                            // thought to be the battery, not confirmed
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Eurochron (129)
// ---------------------------------------------------------------------------

/**
 * Nothing identifies this sensor but its length and a nibble of zeroes.
 *
 * There is no checksum of any kind, so a frame of the right length with the right nibble clear is taken as
 * genuine. That is thin enough that rtl_433 ships it switched off; here it runs with its readings marked as
 * worth a second look.
 */
export const eurochron: RDevice = register({
  num: 129,
  name: 'Eurochron temperature and humidity sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1016,
  longWidth: 2024,
  gapLimit: 2100,
  resetLimit: 8200,
  bands: BAND_433,
  disabled: true,                                  // no checksum: length and a zero nibble are all there is
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 36);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 36) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    if (b[1] & 0x0f) return DECODE_FAIL_SANITY;    // this nibble is always clear on a real frame

    ctx.emit({
      model: 'Eurochron-TH',
      type: 'Weather',
      id: b[0],                                    // picked afresh at every battery change
      battery_ok: b[1] >> 7 ? 0 : 1,
      temperature_C: round1(signed12((b[3] << 8) | (b[4] & 0xf0)) * 0.1),
      humidity: b[2],
      button: (b[1] & 0x10) >> 4,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// WS2032 weather station (145)
// ---------------------------------------------------------------------------

/**
 * The most thoroughly checked thing in this file: a byte sum and a CRC over the same frame.
 *
 * Its temperature is not stored as a negative number but as a magnitude with a separate sign bit, which is
 * worth knowing because it means the value cannot simply be sign-extended like the others here.
 *
 * The run-in is searched for before the frame is turned the right way up and the bytes are read after — an
 * order that looks odd and has to be kept, since the pattern only matches the way it arrives.
 */
export const ws2032: RDevice = register({
  num: 145,
  name: 'WS2032 weather station',
  what: 'weather station: temperature, humidity, wind and rain',
  modulation: Modulation.OOK_PWM,
  shortWidth: 500,
  longWidth: 1000,
  gapLimit: 750,
  resetLimit: 4000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 14 * 8);
    if (row < 0) return DECODE_ABORT_EARLY;

    // Searched before the inversion, read after it.
    const offset = bits.search(row, 0, new Uint8Array([0x0a]), 8);
    if (offset + 14 * 8 > bits.bitsPerRow[row]) return DECODE_ABORT_LENGTH;
    bits.invert();
    const b = bits.bytes(row, offset, 14 * 8);

    const sum = sumBytes(b, 12);                   // full width: an all-zero frame must be told from a wrap
    if (sum === 0) return DECODE_FAIL_SANITY;
    if ((sum & 0xff) !== b[12]) return DECODE_FAIL_MIC;
    if (crc8(b, 14, 0x31, 0x00) !== 0) return DECODE_FAIL_MIC;

    // A magnitude and a sign bit, not a negative number.
    const magnitude = ((b[4] & 0x07) << 8) | b[5];
    ctx.emit({
      model: 'WS2032',
      type: 'Weather',
      id: ((b[1] << 8) | b[2]).toString(16).toUpperCase().padStart(4, '0'),
      battery_ok: b[3] & 0x01 ? 0 : 1,
      temperature_C: round1((b[4] & 0x08 ? -1 : 1) * magnitude * 0.1),
      humidity: b[6],
      wind_dir_deg: round1((b[4] >> 4) * 22.5),
      wind_avg_km_h: round1(b[7] * 0.43 * 3.6),
      wind_max_km_h: round1(b[8] * 0.43 * 3.6),
      rain: (b[9] << 16) | (b[10] << 8) | b[11],   // a raw count of bucket tips
      flags: (b[3] & 0xfe).toString(16).padStart(2, '0'),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Oregon Scientific V1 (50)
// ---------------------------------------------------------------------------

/**
 * The oldest Oregon Scientific coding, and the only device here needing a slicer of its own.
 *
 * Its temperature is not a binary number but three decimal digits, one to a nibble, with a separate sign bit —
 * so a reading is assembled by multiplication rather than by shifting.
 *
 * Two different checksum folds are accepted. The first is the ordinary end-around carry the format documents.
 * The second was found on emitters where that one does not hold, but upstream has only ever verified it
 * against a single weak-signal capture from a distant sensor, so it is carried across as it stands rather than
 * presented as settled. Either passing is enough, and a checksum of zero is rejected outright to keep the
 * looser of the two from claiming noise.
 */
export const oregonV1: RDevice = register({
  num: 50,
  name: 'OSv1 Temperature Sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PWM_OSV1,
  shortWidth: 1465,                                // nominal half-bit
  longWidth: 0,
  syncWidth: 5780,
  gapLimit: 3500,
  resetLimit: 14000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] !== 32) continue;
      const b = bits.bb[row];
      if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff) continue;

      // Every byte arrives reversed, and each is read as two decimal digits.
      const nib: number[] = [];
      let rawCs = 0;
      for (let i = 0; i < 4; i++) {
        const v = reverse8(b[i]);
        nib[i * 2] = v & 0x0f;
        nib[i * 2 + 1] = v >> 4;
        if (i < 3) rawCs += nib[i * 2] + 16 * nib[i * 2 + 1];
      }

      const checksum = nib[6] + (nib[7] << 4);
      const fold = (rawCs & 0xff) + (rawCs >> 8);   // the documented end-around carry
      const alt = (rawCs > 0x180 ? rawCs + 1 : rawCs) & 0xff;
      if (!checksum || (checksum !== fold && checksum !== alt)) continue;

      // Three decimal digits and a sign bit, not a binary temperature.
      const magnitude = nib[2] * 0.1 + nib[3] + nib[4] * 10;
      ctx.emit({
        model: 'Oregon-v1',
        type: 'Weather',
        id: nib[0],
        channel: ((nib[1] >> 2) & 0x03) + 1,
        battery_ok: (nib[5] >> 3) & 0x01 ? 0 : 1,
        temperature_C: round1((nib[5] >> 1) & 0x01 ? -magnitude : magnitude),
        mic: 'CHECKSUM',
      });
      events++;
    }
    return events;
  },
});
