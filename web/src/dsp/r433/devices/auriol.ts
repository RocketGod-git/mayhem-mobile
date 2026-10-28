/**
 * Auriol — the Lidl house brand — and the Govee leak and contact sensors.
 *
 * Auriol sells a new thermometer most years and none of them share a frame, so these are four unrelated
 * decoders that happen to carry the same badge. Govee is here because its leak detector went through a hardware
 * revision that changed the check from a folded parity to a real CRC, and both are still in circulation.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/auriol_afw2a1.c`, `auriol_hg02832.c`, `auriol_ahfl.c`,
 * `auriol_4ld5661.c`, `govee.c`.
 */

import type { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, crc16, xorBytes } from '../util.js';

const round1 = (x: number) => Math.round(x * 10) / 10;
const hex2 = (v: number) => v.toString(16).padStart(2, '0');

/** Sign-extend the low `bits` of a value. */
function signed(v: number, bits: number): number {
  const shift = 32 - bits;
  return (v << shift) >> shift;
}

/** The AFW2A1: no checksum at all, so it insists on twelve identical copies before believing anything. */
export const auriolAfw2a1: RDevice = register({
  num: 146,
  name: 'Auriol AFW2A1 temperature/humidity sensor',
  what: 'outdoor thermometer sold by Lidl',
  modulation: Modulation.OOK_PPM,
  shortWidth: 576,
  longWidth: 1536,
  gapLimit: 2012,
  resetLimit: 3954,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(12, 36);
    if (row < 0) return DECODE_ABORT_EARLY;
    const b = bits.bb[row];

    if ((b[3] >> 4) !== 0xa) return DECODE_FAIL_SANITY;    // a constant nibble, the only fixed marker there is
    const tempC = (signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4) * 0.1;
    const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
    if (humidity > 100 || tempC < -51.1 || tempC > 76.7) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Auriol-AFW2A1',
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: b[1] >> 7,
      button: (b[1] & 0x40) >> 6,
      temperature_C: round1(tempC),
      humidity,
    });
    return 1;
  },
});

/**
 * The HG02832, also sold as the Rubicson 48957. Its check is unusual: the four payload bytes are folded
 * together with exclusive-or first, and a CRC is taken of that single byte.
 */
export const auriolHg02832: RDevice = register({
  num: 141,
  name: 'Auriol HG02832, HG05124A-DCF, Rubicson 48957 temperature/humidity sensor',
  what: 'outdoor thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 252,
  longWidth: 612,
  syncWidth: 860,
  gapLimit: 750,
  resetLimit: 62990,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 2) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 1 || bits.bitsPerRow[1] !== 40) return DECODE_ABORT_LENGTH;
    bits.invert();

    const b = bits.bb[1];
    const folded = new Uint8Array([b[0] ^ b[1] ^ b[2] ^ b[3]]);
    if ((crc8(folded, 1, 0x31, 0x53) ^ b[4]) !== 0) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Auriol-HG02832',
      id: b[0],
      channel: ((b[2] & 0x30) >> 4) + 1,
      battery_ok: (b[2] >> 7) ? 0 : 1,
      temperature_C: round1((signed(((b[2] & 0x0f) << 12) | (b[3] << 4), 16) >> 4) * 0.1),
      humidity: b[1],
      button: (b[2] & 0x40) >> 6,
      mic: 'CRC',
    });
    return 1;
  },
});

/** The AHFL, with a six-bit sum of nibbles split across two bytes. */
export const auriolAhfl: RDevice = register({
  num: 183,
  name: 'Auriol AHFL temperature/humidity sensor',
  what: 'outdoor thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2100,
  longWidth: 4150,
  gapLimit: 4248,
  resetLimit: 9150,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 42);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 42) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];

    if ((b[4] & 0xf0) !== 0x40 || (b[3] & 0x01) !== 0x00) return DECODE_FAIL_SANITY;

    let sum = 0;
    for (let i = 0; i < 4; i++) sum += (b[i] & 0x0f) + (b[i] >> 4);
    sum += b[4] >> 4;
    if ((sum & 0x3f) !== (((b[4] & 0x0f) << 2) | ((b[5] & 0xc0) >> 6))) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Auriol-AHFL',
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: b[1] >> 7,
      button: (b[1] & 0x40) >> 6,
      temperature_C: round1((signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4) * 0.1),
      humidity: b[3] >> 1,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/**
 * The 4-LD5661 rain gauge. Off by default, as in rtl_433: no sync word, no fixed identity and no checksum, so
 * it would claim a good deal of other traffic.
 *
 * The rain figure here deliberately disagrees with the display the sensor is sold with. That display multiplies
 * bucket tips by 0.3 mm; measuring the bucket and the funnel gives almost exactly 1 mm a tip, so that is used.
 * The raw tip count is reported alongside so the other convention can be recovered.
 */
export const auriol4ld5661: RDevice = register({
  num: 200,
  name: 'Auriol 4-LD5661/4-LD5972/4-LD6313, Sempre 4-AH0423-4 temperature/rain sensor',
  what: 'rain gauge with a thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  syncWidth: 2500,
  gapLimit: 2500,
  resetLimit: 4000,
  disabled: true,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let ret = 0;
    for (let i = 0; i < bits.numRows; i++) {
      if (bits.bitsPerRow[i] !== 52) { ret = DECODE_ABORT_LENGTH; continue; }
      const b = bits.bb[i];
      if (b[3] !== 0xf0 || (b[1] & 0x40) !== 0) { ret = DECODE_FAIL_MIC; continue; }

      const tips = (b[4] << 12) | (b[5] << 4) | (b[6] >> 4);
      ctx.emit({
        model: 'Auriol-4LD5661',
        id: b[0],
        battery_ok: b[1] >> 7,
        temperature_C: round1((signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4) * 0.1),
        rain_mm: tips,                               // one millimeter a tip, from the bucket and funnel sizes
        rain: tips,
      });
      return 1;
    }
    return ret;
  },
});

/**
 * Govee's water leak detector and door contact, in their original form.
 *
 * The event code is what matters and it is not a bitfield — particular values mean particular things, and the
 * check is a nibble of parity folded out of the payload.
 */
export const govee: RDevice = register({
  num: 192,
  name: 'Govee water leak detector H5054, door contact sensor B5023',
  what: 'water leak detector and door contact',
  modulation: Modulation.OOK_PWM,
  shortWidth: 440,
  longWidth: 940,
  gapLimit: 900,
  resetLimit: 9000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 3) return DECODE_ABORT_EARLY;
    const r = bits.findRepeatedRow(3, 48);
    if (r < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[r] > 48) return DECODE_ABORT_LENGTH;

    const b = bits.bb[r];
    let code = '';
    for (let i = 0; i < 6; i++) code += hex2(b[i]);
    bits.invert();

    const id = (b[0] << 8) | b[1];
    if (id === 0xffff || b[5] === 0) return DECODE_ABORT_EARLY;

    const eventType = b[2] & 0x0f;
    let event = (b[2] << 8) | b[3];
    if (event === 0xffff) return DECODE_ABORT_EARLY;

    // The check is four bits, sitting inside a byte of markers: 101PPPP1.
    const parity = (b[5] >> 1) & 0x0f;
    let chk = xorBytes(b, 5);
    chk = (chk >> 4) ^ (chk & 0x0f);
    if (chk !== parity) return DECODE_FAIL_MIC;

    const battery = eventType === 0xc ? b[3] : 0;
    event &= 0x0fff;

    let model = 'Govee-Water';
    let eventStr: string;
    let wet = -1;
    if (event === 0xafa) { eventStr = 'Button Press'; wet = 0; }
    else if (event === 0xbfb) { eventStr = 'Water Leak'; wet = 1; }
    else if (eventType === 0xc) eventStr = 'Battery Report';
    else if (event === 0xdfd) eventStr = 'Heartbeat';
    else if (event === 0xe7f) { model = 'Govee-Contact'; eventStr = 'Open'; }
    else eventStr = 'Unknown';

    const out: Record<string, unknown> = { model, id, event: eventStr, code, mic: 'PARITY' };
    if (battery) { out.battery_ok = Math.round(battery) / 100; out.battery_mV = 1800 + 12 * battery; }
    if (wet >= 0) out.detect_wet = wet;
    ctx.emit(out as R433Data);
    return 1;
  },
});

/** The 2021 revision of the same detector, which replaced the folded parity with a proper CRC. */
export const goveeH5054: RDevice = register({
  num: 231,
  name: 'Govee water leak detector H5054',
  what: 'water leak detector, the later hardware',
  modulation: Modulation.OOK_PWM,
  shortWidth: 440,
  longWidth: 940,
  gapLimit: 900,
  resetLimit: 9000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 3) return DECODE_ABORT_EARLY;
    const r = bits.findRepeatedRow(3, 48);
    if (r < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[r] > 48) return DECODE_ABORT_LENGTH;
    bits.invert();

    const b = bits.bb[r];
    let code = '';
    for (let i = 0; i < 6; i++) code += hex2(b[i]);
    if (crc16(b, 6, 0x1021, 0x1d0f) !== 0) return DECODE_FAIL_MIC;

    const event = b[2] & 0x0f;
    const eventData = b[3];
    let eventStr: string;
    let wet = -1, leakNum = -1, battery = -1;
    if (event === 0x0) { eventStr = 'Button Press'; wet = 0; }
    else if (event === 0x1) { eventStr = 'Battery Report'; battery = eventData; }
    else if (event === 0x2) { eventStr = 'Water Leak'; wet = 1; leakNum = eventData; }
    else eventStr = 'Unknown';

    const out: Record<string, unknown> = {
      model: 'Govee-Water',
      id: (b[0] << 8) | b[1],
      event: eventStr,
      code,
      mic: 'CRC',
    };
    if (battery >= 0) { out.battery_ok = battery / 100; out.battery_mV = 1800 + 12 * battery; }
    if (wet >= 0) out.detect_wet = wet;
    if (leakNum >= 0) out.leak_num = leakNum;
    ctx.emit(out as R433Data);
    return 1;
  },
});
