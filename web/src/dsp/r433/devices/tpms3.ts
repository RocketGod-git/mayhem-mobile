/**
 * Schrader tire pressure sensors — the valve-stem transmitters in a very large share of cars.
 *
 * Five boards, and no two of them agree on anything. The pressures come in three different units and three
 * different scalings; the temperature is Celsius on one, Fahrenheit on another, and absent from a third; and
 * the integrity checks run from a proper CRC down to two bits of parity. What they share is that none carries
 * a family code, so each is told apart by frame length and by whichever check happens to close.
 *
 * The SMD3MA4 and the NIS315G3 are the same board with the pressure scaled differently — a fifth of a pound
 * per step against a quarter. Nothing in the frame distinguishes them, so both are registered and both will
 * claim a matching transmission; a reading from the wrong one is 25 per cent out, which is the price of the
 * manufacturer shipping two calibrations under one frame.
 *
 * The BMW MRXBC5A4 has only a two-bit check, which lets through a quarter of random noise. rtl_433 backs it
 * with bounds on pressure and temperature as an independent second filter, and that is kept here: a tire
 * never actually reaches the chip's own survival range, so the narrower bound is the honest one.
 *
 * Ported from rtl_433's `src/devices/schraeder.c` (GPL-2.0-or-later).
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, crc8 } from '../util.js';

/** American cars transmit at 315 MHz, European ones at 433.92. */
const BANDS = [315000000, 433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const hexUp = (v: number, n: number) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

/** 1 fixed bit, 3 flags, 24 of identity, 8 of pressure, 2 of checksum. */
const SMD3MA4_DATA_BITS = 38;
const SMD3MA4_MIN = 36 / 2 + 2 * SMD3MA4_DATA_BITS;      // 94
const SMD3MA4_MAX = 36 + 2 * SMD3MA4_DATA_BITS + 8;      // 120

/** The plain Schrader: eight bytes behind a four-bit run-in, closed by a CRC. */
export const schrader: RDevice = register({
  num: 60,
  name: 'Schrader TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 120,
  longWidth: 0,
  resetLimit: 480,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 68) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, 4, 64);
    if (b[7] !== crc8(b, 7, 0x07, 0xf0)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Schrader',
      type: 'TPMS',
      id: hexUp(((b[1] & 0x0f) << 24) | (b[2] << 16) | (b[3] << 8) | b[4], 7),
      flags: hexUp(((b[0] & 0x0f) << 4) | (b[1] >> 4), 2).toLowerCase(),
      // Sent in millibar, a step of 25 each; reported as kilopascals like the rest of the app.
      pressure_kPa: round1(b[5] * 25 * 0.1),
      temperature_C: b[6] - 50,
      mic: 'CRC',
    });
    return 1;
  },
});

/** The EG53MA4, fitted to Saab, Opel, Vauxhall and Chevrolet. Ten bytes, closed by a byte sum. */
export const schraderEg53ma4: RDevice = register({
  num: 95,
  name: 'Schrader TPMS EG53MA4 (Saab, Opel, Vauxhall, Chevrolet)',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 123,
  longWidth: 0,
  resetLimit: 300,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 120) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, 40, 80);
    // A frame of nothing but zeroes in the payload bytes is a receiver artifact.
    if (!b[1] && !b[2] && !b[4] && !b[5] && !b[7] && !b[8]) return DECODE_FAIL_SANITY;
    if ((addBytes(b, 9) & 0xff) !== b[9]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Schrader-EG53MA4',
      type: 'TPMS',
      id: hexUp((b[4] << 16) | (b[5] << 8) | b[6], 6),
      flags: hexUp(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 8).toLowerCase(),
      pressure_kPa: round1(b[7] * 25 * 0.1),
      // This one reports Fahrenheit on the wire; left in the unit it was sent in.
      temperature_F: b[8],
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/**
 * The SMD3MA4 board, sold under two calibrations.
 *
 * Its check is two bits of a running sum over every pair of bits in the frame, which has to come to one. That
 * is weak, so the all-zero test in front of it is doing real work.
 */
function smd3ma4Decode(bits: BitBuffer, ctx: DecodeCtx, scale: number, model: string): number {
  const n = bits.bitsPerRow[0];
  if (n < SMD3MA4_MIN || n >= SMD3MA4_MAX) return DECODE_ABORT_LENGTH;

  // The run-in ends mid-byte, so the search lands two bits before the payload proper.
  const at = bits.search(0, 0, new Uint8Array([0x55, 0x5e]), 16) + 14;
  if (at + SMD3MA4_DATA_BITS * 2 > n) return DECODE_ABORT_EARLY;

  const decoded = new BitBuffer();
  // A Manchester decode that stops early has hit a coding violation, which is this frame's real check.
  if (bits.manchesterDecode(0, at, decoded, SMD3MA4_DATA_BITS) !== at + SMD3MA4_DATA_BITS * 2) {
    return DECODE_FAIL_MIC;
  }
  decoded.invert();
  const b = decoded.bb[0];
  if (!b[0] && !b[1] && !b[2] && !b[3]) return DECODE_FAIL_SANITY;

  let sum = 0;
  for (let i = 0; i < 5; i++) {
    sum += ((b[i] >> 0) & 0x3) + ((b[i] >> 2) & 0x3) + ((b[i] >> 4) & 0x3) + ((b[i] >> 6) & 0x3);
  }
  if ((sum & 0x3) !== 1) return DECODE_FAIL_MIC;

  const flags = (b[0] & 0x70) >> 4;
  const data: R433Data = {
    model,
    type: 'TPMS',
    id: hexUp(((b[0] & 0x0f) << 20) | (b[1] << 12) | (b[2] << 4) | (b[3] >> 4), 6),
    flags,
    pressure_PSI: round1((((b[3] & 0x0f) << 4) | (b[4] >> 4)) * scale),
    mic: 'PARITY',
  };
  // Three of the eight flag values mean something known; the rest are undocumented.
  if (flags === 0x0) data.learn = 1;
  if (flags === 0x3) data.alarm = 1;
  if (flags === 0x5) data.wakeup = 1;
  ctx.emit(data);
  return 1;
}

export const schraderSmd3ma4: RDevice = register({
  num: 168,
  name: 'Schrader TPMS SMD3MA4 (Subaru)',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_PCM,
  shortWidth: 120,
  longWidth: 120,
  resetLimit: 480,
  bands: BANDS,
  decode: (_dev, bits, ctx) => smd3ma4Decode(bits, ctx, 0.2, 'Schrader-SMD3MA4'),
});

export const schraderNis315g3: RDevice = register({
  num: 352,
  name: 'Schrader TPMS MRXNIS315G3 / 3039 (Infiniti, Nissan, Renault), Redi-Sensor SE10001HP',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_PCM,
  shortWidth: 120,
  longWidth: 120,
  resetLimit: 480,
  bands: BANDS,
  // The same frame as the Subaru board, with a quarter of a pound per step instead of a fifth.
  decode: (_dev, bits, ctx) => smd3ma4Decode(bits, ctx, 0.25, 'Schrader-NIS315G3'),
});

/**
 * The MRXBC5A4, fitted to BMW.
 *
 * Its integrity check is two bits computed from how many ones there are in the payload and how many of those
 * fall at even positions. That rejects only three random frames in four, so the pressure and temperature are
 * bounded as a second, independent filter — a tire in use never approaches the chip's own rated range.
 */
export const schraderMrxbc5a4: RDevice = register({
  num: 328,
  name: 'Schrader TPMS MRXBC5A4 (BMW)',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 123,
  longWidth: 0,
  resetLimit: 800,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 61) return DECODE_ABORT_LENGTH;
    // The wake, sync and start prefix is checked rather than assumed.
    if (bits.search(0, 0, new Uint8Array([0x7f, 0xff]), 16) !== 0) return DECODE_ABORT_EARLY;
    const b = bits.bytes(0, 16, 46);

    const id = ((b[0] & 0x1f) << 19) | (b[1] << 11) | (b[2] << 3) | (b[3] >> 5);
    if (id === 0 || id === 0xffffff) return DECODE_FAIL_SANITY;

    // Two check bits over the thirty-five bit payload: the count of ones, and how many sit at even positions.
    let evenOnes = 0, ones = 0;
    for (let i = 3; i < 38; i++) {
      if ((b[i >> 3] >> (7 - (i % 8))) & 1) {
        ones++;
        if ((i - 3) % 2 === 0) evenOnes++;
      }
    }
    const want = (evenOnes + 2 * ones - 1) & 0x3;
    if (want !== (((b[4] >> 3) & 1) << 1 | ((b[4] >> 2) & 1))) return DECODE_FAIL_MIC;

    const pressure = ((b[3] & 0x1f) << 4) | (b[4] >> 4);
    const tempC = (((b[4] & 0x03) << 5) | (b[5] >> 3)) - 50;
    // The second filter: what a tire can actually be, not what the chip can survive.
    if (pressure > 450 || tempC < -40 || tempC > 85) return DECODE_FAIL_SANITY;

    const flags = (b[0] >> 5) & 0x7;
    ctx.emit({
      model: 'Schrader-MRXBC5A4',
      type: 'TPMS',
      id: hexUp(id, 6),
      flags: flags.toString(16),
      pressure_kPa: round1(pressure),
      temperature_C: round1(tempC),
      sleep: flags === 2 ? 'True' : 'False',
      mic: 'PARITY',
    });
    return 1;
  },
});
