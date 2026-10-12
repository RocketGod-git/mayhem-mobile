/**
 * LaCrosse, and the TFA Dostmann and Conrad sensors built to the same designs.
 *
 * Two quite different generations sit side by side here. The older TX line keys the carrier on and off and
 * carries its digits as binary-coded decimal with a nibble checksum; the "IT+" line that replaced it shifts
 * frequency instead, leads with a sync word, and ends in a real CRC. The newer TX141 family went back to on-off
 * keying but kept a proper check, and packs several different sensors — thermometer, rain gauge, anemometer —
 * behind one frame whose length tells you which one is talking.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/lacrosse.c`, `lacrosse_tx35.c`, `lacrosse_tx34.c`,
 * `lacrosse_tx141x.c`.
 */

import type { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { crc8, lfsrDigest8Reflect } from '../util.js';

const hex = (v: number, digits: number) => (v >>> 0).toString(16).padStart(digits, '0');

/**
 * The original TX line: forty-four bits in eleven nibbles, digits carried as decimal rather than binary.
 *
 * Temperature and humidity go out as separate messages, distinguished by a type nibble, and each value is sent
 * twice — once with a decimal place and once without — which the decoder checks against itself. That, a nibble
 * sum and one parity bit are the whole of the error checking, which is why the redundant copy matters.
 */
export const lacrosseTx: RDevice = register({
  num: 8,
  name: 'LaCrosse TX temperature / humidity sensor',
  what: 'outdoor sensor: TX-3, TX-4, TX-6U, TX-7U, TFA 30.3120.90',
  modulation: Modulation.OOK_PWM,
  shortWidth: 550,                                   // a 550 us mark then 1000 us of gap is a one
  longWidth: 1400,                                   // a 1400 us mark then 1000 us of gap is a zero
  gapLimit: 3000,
  resetLimit: 8000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    let result = 0;
    for (let row = 0; row < bits.numRows; row++) {
      const p = bits.bb[row];
      if (bits.bitsPerRow[row] !== 44) { result = DECODE_ABORT_LENGTH; continue; }
      if (p[0] !== 0x0a) { result = DECODE_ABORT_EARLY; continue; }

      // Unpack to nibbles, adding up the parity over the three value nibbles as we go.
      const n = new Uint8Array(11);
      let parity = 0;
      for (let i = 0; i < 44; i++) {
        const bit = (p[i >> 3] & (1 << (7 - (i % 8)))) ? 1 : 0;
        const nib = (i / 4) | 0;
        n[nib] |= bit << (3 - (i % 4));
        if (nib > 4 && nib < 8) parity += bit;
      }
      parity += n[4] & 0x01;

      let checksum = 0;
      for (let i = 0; i < 10; i++) checksum = (checksum + n[i]) & 0x0f;
      if (checksum !== n[10] || parity % 2 !== 0) { result = DECODE_FAIL_MIC; continue; }

      const type = n[2];
      const id = (n[3] << 3) + (n[4] >> 1);
      const raw = (n[5] << 8) | (n[6] << 4) | n[7];
      const value = n[5] * 10 + n[6] + n[7] * 0.1;
      // The same reading is sent again without its decimal place. If the two disagree, one of them is wrong.
      if (n[5] !== n[8] || n[6] !== n[9]) { result = DECODE_FAIL_SANITY; continue; }

      if (type === 0x00) {
        ctx.emit({
          model: 'LaCrosse-TX',
          id,
          temperature_C: Math.round((value - 50) * 10) / 10,
          mic: 'PARITY',
        });
        events++;
      } else if (type === 0x0e) {
        const out: Record<string, unknown> = { model: 'LaCrosse-TX', id, mic: 'PARITY' };
        if (raw !== 0xff) out.humidity = Math.round(value * 10) / 10;
        ctx.emit(out as { model: string });
        events++;
      }
    }
    return events ? events : result;
  },
});

/**
 * The "IT+" frame the whole modern LaCrosse range shares: a sync word, a model nibble, a six-bit identity that
 * is picked at random when the batteries go in, the reading, and a CRC.
 *
 * The preamble varies — some sensors send a long run of alternating bits, some barely any — so the search starts
 * at the sync word rather than counting from the front.
 */
function decodeItPlus(bits: BitBuffer, ctx: DecodeCtx, model: 29 | 35): number {
  const preamble = new Uint8Array([0xa2, 0xdd, 0x49]);
  let events = 0;
  for (let row = 0; row < bits.numRows; row++) {
    const start = bits.search(row, 0, preamble, 24);
    if (start >= bits.bitsPerRow[row]) continue;

    const b = bits.bytes(row, start + 20, 40);
    if (b[4] !== crc8(b, 4, 0x31, 0x00)) continue;

    let id = ((b[0] & 0x0f) << 2) | (b[1] >> 6);
    const tempC = 10 * (b[1] & 0x0f) + ((b[2] >> 4) & 0x0f) + 0.1 * (b[2] & 0x0f) - 40;
    const humidity = b[3] & 0x7f;

    const out: Record<string, unknown> = {
      model: model === 29 ? 'LaCrosse-TX29IT' : 'LaCrosse-TX35DTHIT',
      id: 0,
      battery_ok: (b[3] >> 7) ? 0 : 1,
      newbattery: (b[1] >> 5) & 1,
      temperature_C: Math.round(tempC * 10) / 10,
      mic: 'CRC',
    };
    // 0x6a says the sensor has no humidity element; 0x7d says this reading came from the second probe, which
    // is given its own identity so the two channels do not overwrite each other.
    if (humidity === 0x6a || humidity === 0x7d) {
      if (humidity === 0x7d) id += 0x40;
    } else {
      out.humidity = humidity;
    }
    out.id = id;
    ctx.emit(out as { model: string });
    events++;
  }
  return events;
}

export const lacrosseTx29: RDevice = register({
  num: 76,
  name: 'LaCrosse TX29IT, TFA Dostmann 30.3159.IT temperature sensor',
  what: 'outdoor thermometer on the 868 MHz band',
  modulation: Modulation.FSK_PCM,
  shortWidth: 55,
  longWidth: 55,
  resetLimit: 4000,
  bands: [868300000],
  decode: (_d, bits, ctx) => decodeItPlus(bits, ctx, 29),
});

export const lacrosseTx35: RDevice = register({
  num: 75,
  name: 'LaCrosse TX35DTH-IT, TFA Dostmann 30.3155 temperature/humidity sensor',
  what: 'outdoor temperature and humidity sensor on the 868 MHz band',
  modulation: Modulation.FSK_PCM,
  shortWidth: 105,
  longWidth: 105,
  resetLimit: 4000,
  bands: [868300000],
  decode: (_d, bits, ctx) => decodeItPlus(bits, ctx, 35),
});

/** The rain gauge of the same family: the reading is a running count of bucket tips, each worth 0.222 mm. */
export const lacrosseTx34: RDevice = register({
  num: 206,
  name: 'LaCrosse TX34-IT rain gauge',
  what: 'tipping-bucket rain gauge',
  modulation: Modulation.FSK_PCM,
  shortWidth: 58,
  longWidth: 58,
  resetLimit: 4000,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const preamble = new Uint8Array([0xa2, 0xdd, 0x40]);
    let events = 0;
    for (let row = 0; row < bits.numRows; row++) {
      const start = bits.search(row, 0, preamble, 20) + 20;
      if (start + 40 > bits.bitsPerRow[row]) continue;

      const b = bits.bytes(row, start, 40);
      if (b[4] !== crc8(b, 4, 0x31, 0x00)) continue;
      if (((b[0] & 0xf0) >> 4) !== 5) continue;      // model nibble 5 is the rain gauge

      const ticks = (b[2] << 8) | b[3];
      ctx.emit({
        model: 'LaCrosse-TX34IT',
        id: ((b[0] & 0x0f) << 2) | (b[1] >> 6),
        battery_ok: (b[1] & 0x10) ? 0 : 1,
        newbattery: (b[1] & 0x20) >> 5,
        rain_mm: Math.round(ticks * 0.222 * 10) / 10,
        rain_raw: ticks,
        mic: 'CRC',
      });
      events++;
    }
    return events;
  },
});

const TX141B = 32, TX141 = 37, TX141TH = 40, TX141BV3 = 33, TX141W = 65;

/**
 * The TX141 family, back on on-off keying: four long marks as a preamble, then forty pulses whose width is the
 * bit. Which sensor is talking is decided by how many bits arrived, so most of this is length arithmetic.
 *
 * The thermometer's check is not a CRC but a shift-register digest, the kind several makers use; the wind and
 * temperature station that shares the frame uses a real CRC over eight bytes instead.
 */
export const lacrosseTx141x: RDevice = register({
  num: 73,
  name: 'LaCrosse TX141-Bv2, TX141TH-Bv2, TX141-Bv3, TX141W, TX145wsdth, (TFA, ORIA) sensor',
  what: 'outdoor thermometer, or a wind and temperature station',
  modulation: Modulation.OOK_PWM,
  shortWidth: 208,                                   // a short mark is 208 us with a 417 us gap
  longWidth: 417,                                    // a long mark is 417 us with a 208 us gap
  syncWidth: 833,
  gapLimit: 625,
  resetLimit: 1700,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    let r = bits.findRepeatedRow(bits.numRows > 5 ? 5 : 3, 32);
    if (r < 0) r = bits.findRepeatedRow(2, 64);
    if (r < 0 && bits.numRows <= 4) {
      // Too few repeats to trust on their own, so accept a single row whose digest checks out.
      for (let row = 0; row < bits.numRows; row++) {
        if ((bits.bitsPerRow[row] === 40 || bits.bitsPerRow[row] === 41)
          && lfsrDigest8Reflect(bits.bb[row], 4, 0x31, 0xf4) === bits.bb[row][4]) { r = row; break; }
      }
    }
    if (r < 0) return DECODE_ABORT_LENGTH;

    const n = bits.bitsPerRow[r];
    let device: number;
    if (n >= 64) device = TX141W;
    else if (n > 41) return DECODE_ABORT_LENGTH;
    else if (n >= 41) {
      if (bits.numRows > 12) return DECODE_ABORT_LENGTH;   // this length also fits a GT-WT03
      device = TX141TH;
    }
    else if (n >= 40) device = TX141TH;
    else if (n >= 37) device = TX141;
    else if (n === 32) device = TX141B;
    else device = TX141BV3;

    const b = bits.bb[r];

    if (device === TX141W) {
      if ((b[0] >> 3) !== 0x01) return DECODE_ABORT_EARLY;
      if (crc8(b, 8, 0x31, 0x00)) return DECODE_FAIL_MIC;

      const id = ((b[0] & 0x07) << 16) | (b[1] << 8) | b[2];
      const channel = (b[3] & 0x30) >> 4;
      const type = b[3] & 0x0f;
      const raw = (b[4] << 4) | (b[5] >> 4);
      const second = ((b[5] & 0x0f) << 8) | b[6];
      const common = {
        model: 'LaCrosse-TX141W',
        id: hex(id, 5),
        channel: hex(channel, 1),
        battery_ok: (b[3] >> 7) ? 0 : 1,
        test: (b[3] & 0x40) >> 6,
        mic: 'CRC',
      };
      if (type === 1) {
        ctx.emit({ ...common, temperature_C: Math.round((raw - 500) * 10) / 100, humidity: second });
      } else if (type === 2) {
        // The same two fields carry wind speed and direction instead.
        ctx.emit({ ...common, wind_avg_km_h: Math.round(raw) / 10, wind_dir_deg: second });
      } else {
        return DECODE_FAIL_OTHER;
      }
      return 1;
    }

    const id = b[0];
    // The battery flag runs the other way round on the temperature-only versions.
    const batteryLow = device === TX141TH ? (b[1] >> 7) : (b[1] >> 7) ? 0 : 1;
    const test = (b[1] & 0x40) >> 6;
    const channel = (b[1] & 0x30) >> 4;
    const tempC = Math.round(((((b[1] & 0x0f) << 8) | b[2]) - 500) * 10) / 100;
    const humidity = device === TX141TH ? b[3] : 0;

    if (id === 0 || (device === TX141TH && (humidity === 0 || humidity > 100))
      || tempC < -40 || tempC > 140) return DECODE_FAIL_SANITY;

    const base = {
      id: hex(id, 2),
      battery_ok: batteryLow ? 0 : 1,
      temperature_C: tempC,
      test: test ? 'Yes' : 'No',
    };
    if (device === TX141B) {
      ctx.emit({ model: 'LaCrosse-TX141B', ...base });
    } else if (device === TX141) {
      ctx.emit({ model: 'LaCrosse-TX141Bv2', channel, ...base });
    } else if (device === TX141BV3) {
      ctx.emit({ model: 'LaCrosse-TX141Bv3', channel, ...base });
    } else {
      if (lfsrDigest8Reflect(b, 4, 0x31, 0xf4) !== b[4]) return DECODE_FAIL_MIC;
      ctx.emit({ model: 'LaCrosse-TX141THBv2', channel, ...base, humidity, mic: 'CRC' });
    }
    return 1;
  },
});
