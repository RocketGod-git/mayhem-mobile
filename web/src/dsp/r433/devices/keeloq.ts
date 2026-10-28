/**
 * Microchip KeeLoq hopping encoders — the chip inside most garage doors, gates and car alarms.
 *
 * What comes out of these is deliberately limited, and it is worth being plain about why. Each press sends a
 * thirty-two bit hopping code encrypted under a key held in the remote and the receiver, and that key is not
 * in the transmission. So a decode gives the serial number, which button was pressed, the battery flag and the
 * repeat counter — the identity of the remote and what it was asked to do — and never anything that would let
 * the door be opened. The hopping code is reported as it arrived because it is the only way to tell one press
 * from a replay of the same press, not because it can be undone.
 *
 * The family is one silicon design wearing several coats. The HCS200 and HCS300 send a plain sixty-six bit
 * frame; the HCS361 adds a two-bit check and turns up at six different bit rates and two codings, which is why
 * it is registered six times over one decoder; the HCS362 does the same trick across on-off keying and
 * Manchester. Two consumer products — a RainPoint rain gauge and a Baldr pool thermometer — put real sensor
 * readings through the same encoder, so they decode here too.
 *
 * A note on the battery bit: the HCS200 sets it when the battery is *low*, and the HCS361 sets it when the
 * battery is *good*. Reading one as the other inverts the warning on every remote in the house.
 *
 * Ported from rtl_433's `src/devices/hcs200.c`, `hcs361.c`, `hcs362.c`, `rainpoint_hcs012arf.c` and
 * `baldr_hcs528arf.c` (GPL-2.0-or-later).
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, reflectBytes, reverse8 } from '../util.js';

const BANDS = [315000000, 433920000];

/** The four button lines arrive in the order S3, S0, S1, S2; this puts them back. */
const buttonNumber = (btn: number) =>
  (btn & 0x08) | ((btn & 0x01) << 2) | (btn & 0x02) | ((btn & 0x04) >> 2);

/** The transmission is least-significant bit first, so each byte is reversed before it means anything. */
const le32 = (b: Uint8Array, i: number) =>
  (((reverse8(b[i + 3]) << 24) | (reverse8(b[i + 2]) << 16) | (reverse8(b[i + 1]) << 8) | reverse8(b[i])) >>> 0);

const hex = (v: number, n: number) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

/** True when the payload is nothing but ones, which is a receiver artifact rather than a remote. */
const allOnes = (b: Uint8Array, from: number, to: number) => {
  for (let i = from; i <= to; i++) if (b[i] !== 0xff) return false;
  return true;
};

// ---- HCS200 / HCS300 -------------------------------------------------------------------------------------

/**
 * The plain sixty-six bit frame, with no check of any kind: a twelve-bit preamble row followed by the data.
 * The only defense against nonsense is the preamble and the all-ones test.
 */
function hcs200Decode(bits: BitBuffer, ctx: DecodeCtx): number {
  if (bits.bitsPerRow[0] !== 12 || bits.bitsPerRow[1] !== 66) return DECODE_ABORT_LENGTH;
  const p = bits.bb[0];
  if (p[0] !== 0xff || (p[1] & 0xf0) !== 0xf0) return DECODE_ABORT_EARLY;

  const b = bits.bb[1];
  if (allOnes(b, 1, 7)) return DECODE_FAIL_SANITY;

  const btn = b[7] & 0x0f;
  ctx.emit({
    model: 'Microchip-HCS200',
    id: hex((reverse8(b[7] & 0xf0) << 24 | reverse8(b[6]) << 16 | reverse8(b[5]) << 8 | reverse8(b[4])) >>> 0, 7),
    battery_ok: (b[8] & 0x80) === 0x80 ? 0 : 1,       // set means low on this part
    button: buttonNumber(btn),
    learn: btn === 0x0f ? 1 : 0,
    repeat: (b[8] & 0x40) === 0x40 ? 1 : 0,
    // The hopping code. Changes every press and cannot be undone without the manufacturer's key.
    encrypted: hex(le32(b, 0), 8),
  });
  return 1;
}

export const hcs200: RDevice = register({
  num: 131,
  name: 'Microchip HCS200/HCS300 KeeLoq remote',
  what: 'garage, gate and alarm remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 370,
  longWidth: 772,
  gapLimit: 1500,
  resetLimit: 9000,
  tolerance: 152,
  bands: BANDS,
  decode: (_dev, bits, ctx) => hcs200Decode(bits, ctx),
});

export const hcs200Fsk: RDevice = register({
  num: 218,
  name: 'Microchip HCS200/HCS300 KeeLoq remote, frequency shifted',
  what: 'garage, gate and alarm remote',
  modulation: Modulation.FSK_PWM,
  shortWidth: 370,
  longWidth: 772,
  gapLimit: 1500,
  resetLimit: 9000,
  tolerance: 152,
  bands: BANDS,
  decode: (_dev, bits, ctx) => hcs200Decode(bits, ctx),
});

// ---- HCS361 ----------------------------------------------------------------------------------------------

/**
 * The HCS361, which added a two-bit check over the first sixty-five bits.
 *
 * Two values are accepted: the check as computed, and the check as it would be with the final bit inverted.
 * That second form is how the part signals a low battery, so a frame matching it is still a good frame.
 */
function hcs361Decode(bits: BitBuffer, ctx: DecodeCtx): number {
  if (bits.numRows < 2 || bits.bitsPerRow[1] !== 67) return DECODE_ABORT_LENGTH;
  // The preamble arrives at one of three lengths depending on the coding in use.
  if (bits.bitsPerRow[0] === 6 && bits.bb[0][0] !== 0xfc) return DECODE_FAIL_SANITY;
  if (bits.bitsPerRow[0] === 7 && bits.bb[0][0] !== 0xfe) return DECODE_FAIL_SANITY;
  if (bits.bitsPerRow[0] === 12) {
    const pre = (bits.bb[0][0] << 8) | bits.bb[0][1];
    if (pre !== 0xaaa0 && pre !== 0xfff0) return DECODE_FAIL_SANITY;
  }

  const b = bits.bb[1];
  if (allOnes(b, 0, 7)) return DECODE_FAIL_SANITY;

  let crc = 0, crcBatLow = 0;
  const actual = (b[8] >> 5) & 0x3;
  for (let i = 0; i < 65; i++) {
    const bit = b[i >> 3] >> (7 - (i % 8));          // the low bit is masked off below, as the C does
    const crcBit = ((crc >> 1) ^ bit) & 0x1;
    if (i === 64) {
      const low = ((crc >> 1) ^ ~bit) & 0x1;
      crcBatLow = low | (((low ^ crc) << 1) & 0x2);
    }
    crc = crcBit | (((crcBit ^ crc) << 1) & 0x2);
  }
  if (actual !== crc && actual !== crcBatLow) return DECODE_FAIL_MIC;

  const serial = (reverse8(b[7] & 0xf0) << 24 | reverse8(b[6]) << 16 | reverse8(b[5]) << 8 | reverse8(b[4])) >>> 0;
  if (serial === 0) return DECODE_FAIL_SANITY;

  ctx.emit({
    model: 'Microchip-HCS361',
    id: hex(serial, 8),
    battery_ok: (b[8] & 0x80) === 0x80 ? 1 : 0,       // set means good on this part, unlike the HCS200
    button: buttonNumber(b[7] & 0x0f),
    encrypted: hex(le32(b, 0), 8),
    mic: 'CRC',
  });
  return 1;
}

/** One decoder, six registrations: the part is sold at two bit rates, with and without a sync, and in PIWM. */
const HCS361_VARIANTS: [number, string, Modulation, number, number, number, number, number, number?][] = [
  [306, 'sync, 833 bit/s', Modulation.OOK_PWM, 400, 800, 1200, 7200, 140, 4000],
  [307, 'sync, 1667 bit/s', Modulation.OOK_PWM, 200, 400, 600, 13600, 70, 2000],
  [308, 'no sync, 833 bit/s', Modulation.OOK_PWM, 200, 400, 1200, 6800, 140],
  [309, 'no sync, 1667 bit/s', Modulation.OOK_PWM, 100, 200, 600, 6600, 70],
  [310, 'PIWM, 2500 bit/s', Modulation.OOK_PIWM_DC, 400, 800, 4000, 45600, 140, 4000],
  [311, 'PIWM, 5000 bit/s', Modulation.OOK_PIWM_DC, 200, 400, 2000, 45200, 70, 2000],
];

export const hcs361: RDevice[] = HCS361_VARIANTS.map(([num, how, mod, s, l, gap, reset, tol, sync]) => register({
  num,
  name: `Microchip HCS361 KeeLoq remote (${how})`,
  what: 'garage, gate and alarm remote',
  modulation: mod,
  shortWidth: s,
  longWidth: l,
  gapLimit: gap,
  resetLimit: reset,
  tolerance: tol,
  ...(sync ? { syncWidth: sync } : {}),
  bands: BANDS,
  decode: (_dev, bits, ctx) => hcs361Decode(bits, ctx),
}));

// ---- HCS362 ----------------------------------------------------------------------------------------------

/** A two-bit check run over the first sixty-five bits, with its own little shift register. */
function hcs362Crc(b: Uint8Array): number {
  let crc0 = 0, crc1 = 0;
  for (let n = 0; n < 65; n++) {
    const d = (b[n >> 3] >> (7 - (n % 8))) & 1;
    const next1 = crc0 ^ d;
    const next0 = crc0 ^ d ^ crc1;
    crc0 = next0;
    crc1 = next1;
  }
  return (crc1 << 1) | crc0;
}

/**
 * The HCS362, which ships both on-off keyed and Manchester coded.
 *
 * Which one arrived decides how the payload is reached, so the decoder reads the modulation it was registered
 * with rather than guessing from the frame.
 */
function hcs362Decode(dev: RDevice, bits: BitBuffer, ctx: DecodeCtx): number {
  let b: Uint8Array;

  if (dev.modulation === Modulation.OOK_PCM) {
    const n0 = bits.bitsPerRow[0];
    if (n0 < 12 * 2 - 8 || n0 > 12 * 2 + 8) return DECODE_ABORT_LENGTH;
    const p = bits.bb[0];
    if (p[0] !== 0xaa || p[1] !== 0xaa || p[2] !== 0xaa) return DECODE_ABORT_EARLY;

    const n1 = bits.bitsPerRow[1];
    if (n1 < 71 * 2 || n1 > 72 * 2 + 4) return DECODE_ABORT_LENGTH;
    if ((bits.bb[1][0] & 0xc0) !== 0x80) return DECODE_ABORT_EARLY;

    const msg = new BitBuffer();
    const len = bits.manchesterDecode(1, 2, msg, 72);
    if (len < 69 + 1) return DECODE_ABORT_LENGTH;
    msg.invert();                                    // G. E. Thomas convention, not IEEE 802.3
    b = msg.bb[0];
  } else {
    if (bits.bitsPerRow[0] !== 12 || bits.bitsPerRow[1] !== 69) return DECODE_ABORT_LENGTH;
    const p = bits.bb[0];
    if (p[0] !== 0xff || (p[1] & 0xf0) !== 0xf0) return DECODE_ABORT_EARLY;
    b = bits.bb[1];
  }

  if (allOnes(b, 1, 7)) return DECODE_FAIL_SANITY;
  const actual = ((b[8] >> 6) & 1) | (((b[8] >> 5) & 1) << 1);
  if (actual !== hcs362Crc(b)) return DECODE_FAIL_MIC;

  ctx.emit({
    model: 'Microchip-HCS362',
    id: hex((reverse8(b[7] & 0xf0) << 24 | reverse8(b[6]) << 16 | reverse8(b[5]) << 8 | reverse8(b[4])) >>> 0, 7),
    battery_ok: (b[8] & 0x80) === 0x80 ? 0 : 1,
    button: buttonNumber(b[7] & 0x0f),
    repeat: ((b[8] >> 4) & 1) | (((b[8] >> 3) & 1) << 1),
    encrypted: hex(le32(b, 0), 8),
    mic: 'CRC',
  });
  return 1;
}

export const hcs362Pwm: RDevice = register({
  num: 329,
  name: 'Microchip HCS362 KeeLoq remote, pulse width',
  what: 'garage, gate and alarm remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 200,
  longWidth: 400,
  gapLimit: 550,
  resetLimit: 900,
  tolerance: 50,
  bands: BANDS,
  decode: (dev, bits, ctx) => hcs362Decode(dev, bits, ctx),
});

export const hcs362Mc: RDevice = register({
  num: 330,
  name: 'Microchip HCS362 KeeLoq remote, Manchester',
  what: 'garage, gate and alarm remote',
  modulation: Modulation.OOK_PCM,
  shortWidth: 214,
  longWidth: 214,
  gapLimit: 600,
  resetLimit: 900,
  tolerance: 50,
  bands: BANDS,
  decode: (dev, bits, ctx) => hcs362Decode(dev, bits, ctx),
});

// ---- consumer boards built on the same encoder ------------------------------------------------------------

/**
 * The RainPoint HCS012ARF rain gauge.
 *
 * Manchester over the whole row, inverted, then every byte reflected before anything can be read — three
 * transformations before the first field. The header 0xa5 is what confirms all three were needed.
 */
export const rainpointHcs012arf: RDevice = register({
  num: 276,
  name: 'RainPoint HCS012ARF rain gauge',
  what: 'tipping-bucket rain gauge',
  modulation: Modulation.OOK_PCM,
  shortWidth: 320,
  longWidth: 320,
  gapLimit: 700,
  resetLimit: 1000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(4, 163);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 163) return DECODE_ABORT_LENGTH;

    const msg = new BitBuffer();
    bits.manchesterDecode(row, 0, msg, 10 * 2 * 8);
    msg.invert();
    const b = msg.bb[0];
    reflectBytes(b, 10);

    if (b[0] !== 0xa5) return DECODE_ABORT_EARLY;
    if ((addBytes(b, 8, 1) & 0xff) !== b[9]) return DECODE_FAIL_MIC;   // the header is not in the sum

    ctx.emit({
      model: 'RainPoint-HCS012ARF',
      id: ((b[4] << 24) | (b[3] << 16) | (b[2] << 8) | b[1]) >>> 0,
      flags1: (b[5] >> 2).toString(16).padStart(2, '0'),
      flags2: b[6].toString(16).padStart(2, '0'),
      battery_ok: (b[5] & 0x02) >> 1 ? 0 : 1,
      rain_mm: Math.round(((b[8] << 8) | b[7]) * 0.1 * 10) / 10,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/** The Baldr HCS528ARF pool thermometer, on the same board and reporting in Fahrenheit. */
export const baldrHcs528arf: RDevice = register({
  num: 360,
  name: 'Baldr HCS528ARF pool thermometer',
  what: 'floating pool thermometer',
  modulation: Modulation.OOK_PCM,
  shortWidth: 320,
  longWidth: 320,
  gapLimit: 700,
  resetLimit: 1000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(4, 179);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 179) return DECODE_ABORT_LENGTH;

    const msg = new BitBuffer();
    bits.manchesterDecode(row, 0, msg, 11 * 2 * 8);
    msg.invert();
    const b = msg.bb[0];
    reflectBytes(b, 11);

    if (b[0] !== 0xa5) return DECODE_ABORT_EARLY;
    if ((addBytes(b, 9, 1) & 0xff) !== b[10]) return DECODE_FAIL_MIC;

    const data: R433Data = {
      model: 'Baldr-HCS528ARF',
      id: hex(((b[4] << 24) | (b[3] << 16) | (b[2] << 8) | b[1]) >>> 0, 8).toLowerCase(),
      battery_ok: (b[5] & 0x02) >> 1 ? 0 : 1,
      // This one reports Fahrenheit on the wire; it is left in the unit it was sent in.
      temperature_F: Math.round((((b[8] & 0x0f) << 8) | b[7]) * 0.1 * 10) / 10,
      mic: 'CHECKSUM',
    };
    ctx.emit(data);
    return 1;
  },
});
