/**
 * Six more thermometers, and one pair that cannot always be told apart.
 *
 * The interesting one here is Geevon. The TX16-3 and the TX19-1 send byte-for-byte the same frame — same
 * length, same field layout, same three fixed bytes — and differ only in how the last byte is computed: the
 * TX16 carries a CRC-8, the TX19 a Galois digest. Those are genuinely different functions, but both are affine
 * over the message, so the set of frames they agree on is not scattered at random — it is a whole coset. About
 * one realistic frame in a hundred satisfies both checks, and, awkwardly, all four packets rtl_433 prints as
 * TX16 examples fall inside it. Neither decoder can be given priority on the evidence, and upstream registers
 * both without one, so this does too: an ambiguous frame is reported twice, once under each name. The test
 * pins that overlap in place so it reads as a known property rather than a surprise.
 *
 * Eurochron is the other one worth a note. It interleaves a second, longer packet carrying a radio clock, and
 * reads the time out of it when it arrives. Upstream tests that row index with `> 0` rather than `>= 0`, so a
 * clock landing in the very first row is silently passed over; that is preserved here, quirk and all, because
 * a decoder that quietly disagrees with its source is worse than one that is faithfully odd.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `ecowitt.c`, `efth800.c`, `auriol_aft77b2.c`, `vauno_en8822c.c`,
 * `geevon.c`, `geevon_tx19.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addBytes, addNibbles, crc8, lfsrDigest8, lfsrDigest8Reverse } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const pad2 = (n: number) => n.toString().padStart(2, '0');

// ---------------------------------------------------------------------------
// Ecowitt WH53 / WH0280 / WH0281A (127)
// ---------------------------------------------------------------------------

/**
 * A bare outdoor thermometer: an id that changes whenever the batteries come out, a channel switch with three
 * positions, and a temperature.
 *
 * The run-in is nominally seven one-bits followed by the model byte, but the leading ones are not reliable on
 * air, so only the last four of them are searched for along with the model — twelve bits in all. Everything
 * from the model byte onward is covered by the CRC, which is why the search result is advanced by exactly four
 * bits: that lands on the model byte rather than past it.
 *
 * Two fields are checked for being zero even though nothing is known to live in them. They may well be the
 * high bits of a wider temperature field, but the sensor is only rated to 60 °C and ten bits already reach
 * past that, so treating them as a structural check costs nothing real.
 */
export const ecowitt: RDevice = register({
  num: 127,
  name: 'Ecowitt Wireless Outdoor Thermometer WH53/WH0280/WH0281A',
  what: 'thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 500,
  longWidth: 1480,
  gapLimit: 1500,
  resetLimit: 2000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_LENGTH;

    const pos = bits.search(0, 0, new Uint8Array([0xf5, 0x30]), 12);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] - pos < 52) return DECODE_ABORT_EARLY;

    // Skip the four header bits of the match but keep the model byte, which the CRC covers.
    const b = bits.bytes(0, pos + 4, 6 * 8);
    if (crc8(b, 6, 0x31, 0x00) !== 0) return DECODE_FAIL_MIC;

    const channel = (b[2] >> 4) + 1;               // wire is zero-based, the switch on the case is not
    if (channel > 3) return DECODE_FAIL_SANITY;    // the switch only has three positions
    if ((b[2] & 0x0c) !== 0) return DECODE_ABORT_EARLY;

    const tempRaw = ((b[2] & 0x03) << 8) | b[3];
    if (b[4] !== 0xff) return DECODE_ABORT_EARLY;

    ctx.emit({
      model: 'Ecowitt-WH53',
      type: 'Weather',
      id: b[1],
      channel,
      temperature_C: round1((tempRaw - 400) * 0.1),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Eurochron EFTH-800 (152)
// ---------------------------------------------------------------------------

/**
 * A thermometer and hygrometer that also relays the time.
 *
 * Two packet lengths share the air: a 48-bit reading and a 65-bit frame carrying a DCF77 clock. The clock is
 * read first, while the long rows are still intact, and then every row longer than 49 bits is struck out so
 * the reading search cannot pick one up by mistake.
 *
 * The humidity is BCD but the temperature is not — it is a signed ten-bit value sitting high in a sixteen-bit
 * word, which is how upstream gets its sign extension for free, and the shift back down is what scales it.
 */
export const eurochronEfth800: RDevice = register({
  num: 152,
  name: 'Eurochron EFTH-800 temperature and humidity sensor',
  what: 'thermometer and hygrometer with a radio clock',
  modulation: Modulation.OOK_PWM,
  shortWidth: 250,
  longWidth: 500,
  syncWidth: 750,
  gapLimit: 900,
  resetLimit: 5500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();

    // The clock packet, if one arrived. Upstream tests `> 0`, so a clock in row zero is passed over; kept.
    let radioClock = '';
    const clockRow = bits.findRepeatedRow(2, 65);
    if (clockRow > 0) {
      const c = bits.bb[clockRow];
      if (crc8(c, 8, 0x31, 0x00) === 0) {
        const hour = c[2] & 0x1f;                  // bits above the hour may hold DST or timezone
        const min  = c[3] & 0x3f;
        const sec  = c[4] & 0x3f;
        const year = c[5] >> 1;
        const day  = ((c[5] & 0x01) << 4) | ((c[6] & 0xf0) >> 4);
        const mth  = c[6] & 0x0f;
        radioClock = `${year + 2000}-${pad2(mth)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:${pad2(sec)}`;
      }
    }

    // Strike out the long rows so only readings remain to be found.
    for (let r = 0; r < bits.numRows; r++) {
      if (bits.bitsPerRow[r] > 49) bits.bitsPerRow[r] = 0;
    }

    const row = bits.findRepeatedRow(2, 48);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 49) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    // All-ones on air, which is what silence looks like once inverted.
    if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[4] === 0x00) return DECODE_FAIL_SANITY;
    if (crc8(b, 6, 0x31, 0x00) !== 0) return DECODE_FAIL_MIC;

    const tempRaw = (((((b[2] & 0x3f) << 10) << 16) >> 16) | ((b[3] & 0xf0) << 2)) >> 6;

    ctx.emit({
      model: 'Eurochron-EFTH800',
      type: 'Weather',
      id: ((b[0] & 0x0f) << 8) | b[1],
      channel: ((b[0] & 0x70) >> 4) + 1,
      battery_ok: (b[2] >> 7) ? 0 : 1,
      temperature_C: round1(tempRaw * 0.1),
      humidity: (b[4] >> 4) * 10 + (b[4] & 0x0f),  // BCD, unlike the temperature
      mic: 'CRC',
      ...(radioClock ? { radio_clock: radioClock } : {}),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Auriol AFT 77 B2 (184)
// ---------------------------------------------------------------------------

/**
 * A Lidl thermometer that sends its temperature as decimal digits rather than a scaled count.
 *
 * The frame is 68 bits — seventeen nibbles — so nothing is byte aligned until the four-bit prefix is shifted
 * off, which is what the realignment loop does. Both checks are then computed over the aligned bytes while
 * the temperature is read from the original unaligned row, because its digits sit on nibble boundaries there.
 *
 * The byte sum genuinely overflows a byte on real frames, and upstream narrows it to eight bits before
 * comparing, so the masked sum this app's helper returns is the correct one here rather than a hazard.
 * Its hand-rolled Galois routine is `lfsr_digest8` exactly — same forward byte order, same MSB-first bit
 * traversal, same right-rolling key — so the shared helper stands in for it.
 */
export const auriolAft77b2: RDevice = register({
  num: 184,
  name: 'Auriol AFT 77 B2 temperature sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 500,
  longWidth: 920,
  gapLimit: 1104,
  resetLimit: 2275,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let row = -1;
    for (let r = 0; r < bits.numRows; r++) {
      if (bits.bitsPerRow[r] === 68) { row = r; break; }
    }
    if (row < 0) return DECODE_ABORT_EARLY;

    const ptr = bits.bb[row];
    if (ptr[0] !== 0xa5) return DECODE_ABORT_EARLY;

    // Drop the four-bit prefix so the checks have whole bytes to work on.
    const frame = new Uint8Array(8);
    for (let i = 0; i < 8; i++) frame[i] = ((ptr[i] << 4) | (ptr[i + 1] >> 4)) & 0xff;

    if (addBytes(frame, 6) !== frame[6]) return DECODE_FAIL_MIC;
    if (lfsrDigest8(frame, 6, 0x83, 0xec) !== frame[7]) return DECODE_FAIL_MIC;

    // Three decimal digits, read from the unaligned row where they land on nibble boundaries.
    let tempRaw = (ptr[4] >> 4) * 100 + (ptr[4] & 0x0f) * 10 + (ptr[5] >> 4);
    if ((ptr[3] & 0x08) !== 0) tempRaw = -tempRaw;

    ctx.emit({
      model: 'Auriol-AFT77B2',
      type: 'Weather',
      id: frame[1],
      temperature_C: round2(tempRaw * 0.1),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Vauno EN8822C (230)
// ---------------------------------------------------------------------------

/**
 * The same board as the Esperanza EWS and the s3318p, sold under several names.
 *
 * Its check is a six-bit nibble sum split across the last two bytes. The sum runs over four whole bytes plus
 * one further nibble, which tops out at 135 — below the byte this app's `addNibbles` narrows to, so the
 * masking that has bitten other decoders cannot reach this one. An all-zero row sums to zero and is thrown
 * out before the comparison, since it would otherwise check out perfectly.
 */
export const vaunoEn8822c: RDevice = register({
  num: 230,
  name: 'Vauno EN8822C',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  tolerance: 500,
  gapLimit: 5000,
  resetLimit: 9500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedPrefix(4, 42);
    if (row < 0) return DECODE_ABORT_EARLY;

    const b = bits.bb[row];
    const chk = ((b[4] & 0x0f) << 2) | (b[5] >> 6);
    const sum = addNibbles(b, 4) + (b[4] >> 4);
    if (sum === 0) return DECODE_ABORT_EARLY;      // silence sums to zero and would otherwise pass
    if ((sum & 0x3f) !== chk) return DECODE_FAIL_MIC;

    const tempRaw = ((((b[1] & 0x0f) << 12) | (b[2] << 4)) << 16) >> 16;

    ctx.emit({
      model: 'Vauno-EN8822C',
      type: 'Weather',
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: ((b[4] & 0x10) >> 4) ? 0 : 1,
      temperature_C: round1((tempRaw >> 4) * 0.1),
      humidity: b[3] >> 1,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Geevon TX16-3 (261) and TX19-1 (291)
// ---------------------------------------------------------------------------

/**
 * Everything the two Geevon sensors share, which is everything but the last byte.
 *
 * `verify` is the only difference between them. Both frames are 73 bits — 72 of payload and one left over —
 * sent inverted, repeated several times, with three fixed bytes two thirds of the way in that serve as a
 * cheap structural check before either integrity check runs.
 */
function geevonDecode(
  bits: BitBuffer,
  ctx: DecodeCtx,
  model: string,
  verify: (b: Uint8Array) => boolean,
): number {
  bits.invert();

  const row = bits.findRepeatedPrefix(bits.numRows > 5 ? 5 : 3, 72);
  if (row < 0) return DECODE_ABORT_LENGTH;
  if (bits.bitsPerRow[row] !== 73) return DECODE_ABORT_LENGTH;

  const b = bits.bb[row];
  if (b[5] !== 0xaa || b[6] !== 0x55 || b[7] !== 0xaa) return DECODE_FAIL_MIC;
  if (!verify(b)) return DECODE_FAIL_MIC;

  ctx.emit({
    model,
    type: 'Weather',
    id: b[0],
    battery_ok: (b[1] >> 7) ? 0 : 1,
    channel: ((b[1] & 0x30) >> 4) + 1,
    temperature_C: round1((((b[2] << 4) | (b[3] >> 4)) - 500) * 0.1),
    humidity: b[4],
    mic: 'CRC',
  });
  return 1;
}

/** The CRC-8 sibling. Its check runs over all nine bytes and must come out zero. */
export const geevonTx16: RDevice = register({
  num: 261,
  name: 'Geevon TX16-3 outdoor sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 250,
  longWidth: 500,
  syncWidth: 750,
  gapLimit: 625,
  resetLimit: 1700,
  bands: BAND_433,
  decode: (_dev, bits: BitBuffer, ctx: DecodeCtx) =>
    geevonDecode(bits, ctx, 'Geevon-TX163', b => crc8(b, 9, 0x31, 0x7b) === 0),
});

/**
 * The Galois-digest sibling. Its check runs over the first eight bytes and must equal the ninth.
 *
 * This is the decoder with the wider reach of the two: on frames where the two checks coincide it will claim
 * a TX16-3 transmission as well as its own. That is a property of the protocols, not of this port.
 */
export const geevonTx19: RDevice = register({
  num: 291,
  name: 'Geevon TX19-1 outdoor sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 250,
  longWidth: 500,
  syncWidth: 750,
  gapLimit: 625,
  resetLimit: 1700,
  bands: BAND_433,
  decode: (_dev, bits: BitBuffer, ctx: DecodeCtx) =>
    geevonDecode(bits, ctx, 'Geevon-TX191', b => lfsrDigest8Reverse(b, 8, 0x98, 0x25) === b[8]),
});
