/**
 * More tire pressure sensors: the aftermarket kits, the motorcycle and truck sensors, and a few makes whose
 * frames differ enough from the mainstream to need their own decoder.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/tpms_schrader_motorcycle.c`, `tpms_gm.c`,
 * `tpms_jansite.c`, `tpms_elantra2012.c`, `tpms_truck.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, xorBytes } from '../util.js';

const PRE_AA_AA_A9 = new Uint8Array([0xaa, 0xaa, 0xa9]);
const hex = (v: number, digits: number) => (v >>> 0).toString(16).padStart(digits, '0');

/** Schrader's motorcycle sensor: on-off keyed rather than frequency shifted, unlike almost every car sensor. */
export const tpmsSchraderMotorcycle: RDevice = register({
  num: 321,
  name: 'Schrader motorcycle TPMS sensor',
  what: 'motorcycle tire pressure sensor',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 122,
  longWidth: 122,
  resetLimit: 375,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const len = bits.bitsPerRow[0];
    let pos = bits.search(0, 0, new Uint8Array([0x7f, 0xf8]), 13);
    if (pos >= len) return DECODE_ABORT_EARLY;
    pos += 13;
    if (len - pos < 56) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, pos, 56);
    if (crc8(b, 7, 0x07, 0xe0)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Schrader-Motorcycle',
      type: 'TPMS',
      id: ((b[0] & 0x03) << 22) | (b[1] << 14) | (b[2] << 6) | (b[3] >> 2),
      pressure_kPa: (((b[3] & 0x03) << 8) | b[4]) * 0.5,
      temperature_C: b[5] - 50,
      mic: 'CRC',
    });
    return 1;
  },
});

/**
 * The aftermarket sensors sold for older General Motors vehicles. A long run of zeroes opens the frame, and
 * the identity is forty bits — wider than most, because these are programmed rather than factory-assigned.
 */
export const tpmsGm: RDevice = register({
  num: 275,
  name: 'GM aftermarket TPMS',
  what: 'aftermarket tire pressure sensors for older GM vehicles',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 120,
  longWidth: 0,
  resetLimit: 15600,
  bands: [315000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 130) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, 0, 130);
    for (let i = 0; i < 6; i++) if (b[i] !== 0x00) return DECODE_ABORT_EARLY;

    let sum = 0;
    let allZero = true;
    for (let i = 6; i < 15; i++) { sum += b[i]; allZero &&= b[i] === 0; }
    if ((sum & 0xff) !== b[15]) return DECODE_FAIL_MIC;
    if (allZero && b[15] === 0) return DECODE_FAIL_SANITY;

    const flags = (b[6] << 8) | b[7];
    ctx.emit({
      model: 'GM-Aftermarket',
      type: 'TPMS',
      // Forty bits of identity, so it is built with arithmetic rather than shifts.
      id: b[8] * 2 ** 32 + b[9] * 2 ** 24 + (b[10] << 16) + (b[11] << 8) + b[12],
      flags,
      // All three of these bits clear means the sensor is waiting to be taught to a vehicle.
      learn_mode: (((flags >> 8) & 1) === 0 && ((flags >> 1) & 1) === 0 && (flags & 1) === 0) ? 1 : 0,
      battery_ok: ((flags >> 5) & 1) ? 0 : 1,
      pressure_kPa: Math.round(b[13] * 2.75 * 100) / 100,
      temperature_C: b[14] - 60,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/**
 * Jansite's TY02S. Registered but off by default, as in rtl_433: nobody has worked out what the last byte is,
 * so there is no way to reject a damaged frame and the readings cannot be trusted.
 */
export const tpmsJansite: RDevice = register({
  num: 123,
  name: 'Jansite TPMS model TY02S',
  what: 'aftermarket tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  disabled: true,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    let events = 0;
    let bitpos = 0;
    while ((bitpos = bits.search(0, bitpos, PRE_AA_AA_A9, 24)) + 80 <= bits.bitsPerRow[0]) {
      const packet = new BitBuffer();
      bits.manchesterDecode(0, bitpos + 24, packet, 56);
      if (packet.bitsPerRow[0] >= 56) {
        const b = packet.bb[0];
        let code = '';
        for (let i = 0; i < 7; i++) code += hex(b[i], 2);
        ctx.emit({
          model: 'Jansite',
          type: 'TPMS',
          id: hex((b[0] << 20) | (b[1] << 12) | (b[2] << 4) | (b[3] >> 4), 7),
          flags: b[3] & 0x0f,
          pressure_kPa: Math.round(b[4] * 1.7 * 10) / 10,
          temperature_C: b[5] - 50,
          code,
        });
        events++;
      }
      bitpos += 2;
    }
    return events;
  },
});

/** The Hyundai Elantra of 2012 and its relatives: eight bytes with a CRC covering the lot. */
export const tpmsElantra2012: RDevice = register({
  num: 140,
  name: 'Elantra 2012 TPMS',
  what: 'tire pressure sensor: Hyundai and Kia',
  modulation: Modulation.FSK_PCM,
  shortWidth: 49,
  longWidth: 49,
  resetLimit: 200,
  bands: [433920000, 315000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const preamble = new Uint8Array([0x71, 0x55]);
    let events = 0;
    for (let row = 0; row < bits.numRows; row++) {
      let bitpos = 0;
      while ((bitpos = bits.search(row, bitpos, preamble, 16)) + 128 <= bits.bitsPerRow[row]) {
        const packet = new BitBuffer();
        bits.manchesterDecode(row, bitpos + 16, packet, 64);
        if (packet.bitsPerRow[0] >= 64) {
          const b = packet.bb[0];
          if (crc8(b, 8, 0x07, 0x00) === 0) {
            ctx.emit({
              model: 'Elantra2012',
              type: 'TPMS',
              id: hex(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, 8),
              pressure_kPa: b[0] + 60,
              temperature_C: b[1] - 50,
              battery_ok: ((b[6] & 0x02) >> 1) ? 0 : 1,
              triggered: b[6] & 0x01,                // woken by the workshop's low-frequency tool
              storage: (b[6] & 0x04) >> 2,           // shipped in a box rather than fitted to a wheel
              flags: hex(b[6], 1),
              mic: 'CRC',
            });
            events++;
          }
        }
        bitpos += 15;
      }
    }
    return events;
  },
});

/**
 * The solar-powered sensors fitted to trucks and trailers, where a wheel position is reported alongside the
 * reading because a rig has far more than four.
 */
export const tpmsTruck: RDevice = register({
  num: 201,
  name: 'Unbranded solar TPMS for trucks',
  what: 'truck and trailer tire pressure sensors',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    let events = 0;
    let bitpos = 0;
    while ((bitpos = bits.search(0, bitpos, PRE_AA_AA_A9, 24)) + 160 <= bits.bitsPerRow[0]) {
      const packet = new BitBuffer();
      bits.manchesterDecode(0, bitpos + 24, packet, 76);
      if (packet.bitsPerRow[0] >= 76) {
        const b = packet.bytes(0, 4, 72);            // four bits of leader before the payload proper
        if (b[0] || b[1] || b[2] || b[3]) {
          if (xorBytes(b, 9) === 0) {
            const flags = b[5] >> 4;
            const out: Record<string, unknown> = {
              model: 'Truck',
              type: 'TPMS',
              id: hex(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 8),
              wheel: b[4],
              pressure_kPa: ((b[5] & 0x0f) << 8) | b[6],
              temperature_C: b[7],
              battery_ok: (flags & 0x3) === 0x3 ? 1 : 0,
              flags,
              mic: 'CHECKSUM',
            };
            if ((flags & 0x4) === 0x4) out.pressure_alert = 1;
            ctx.emit(out as R433Data);
            events++;
          }
        }
      }
      bitpos += 2;
    }
    return events;
  },
});
