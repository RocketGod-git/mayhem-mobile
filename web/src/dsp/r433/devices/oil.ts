/**
 * Ultrasonic oil tank monitors: five protocols from one family of sensors, sold under a dozen names.
 *
 * These sit in the neck of a domestic heating oil tank and ping the surface of the oil once or twice an hour,
 * reporting the distance down to it in centimeters. They all descend from the same design and have drifted
 * apart over the years, which is why the family needs five decoders rather than one: the original Watchman
 * frames its 64 bits with a preamble and postamble, the Standard drops the checksum entirely, the Smart adds
 * one back, and the Advanced abandons the whole scheme for a length-prefixed message with a CRC-16.
 *
 * Three of them scan rather than decode once. A burst can hold several frames, so each walks its row looking
 * for further preambles and reports every complete frame it finds — the return value is a count, not a flag.
 *
 * The Standard is the awkward one. It has no integrity check at all: a sixteen-bit id, some flags and a depth,
 * with nothing to confirm any of it. All that stands between it and noise is the preamble match, a structural
 * zero byte, and a range check on the depth, which the sensor's own documentation says tops out near 305 cm
 * even though the field is nine bits wide. It also has to actively refuse its own sibling — the Smart's
 * `55 55 58` run-in contains a valid Standard sync ten bits in, so without a guard the checksumless decoder
 * would happily claim Smart transmissions. That guard is tested here against a real Smart capture.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `oil_watchman.c`, `oil_standard.c`, `oil_watchman_advanced.c`,
 * `oil_smart.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { crc8le, crc16 } from '../util.js';

const BAND_433 = [433920000];
/** The Beckett Rocket TEK377A is the American build and keys on and off at 915 MHz instead. */
const BAND_915 = [915000000];

// ---------------------------------------------------------------------------
// Watchman Sonic / Apollo Ultrasonic / Beckett Rocket (43)
// ---------------------------------------------------------------------------

/**
 * The original, framed by a Si4320 radio: a six-bit run-in, 64 Manchester-coded bits, and a postamble that is
 * simply the last signal level held for two more bit times.
 *
 * That postamble is a real check, not decoration. Which of the two patterns to expect depends on the last data
 * bit, so a frame that decoded to the wrong bits will usually fail to produce the matching tail. It is tested
 * before the checksum because it costs nothing.
 *
 * The temperature is a guess and upstream says so — it falls out of a field that varies inversely with warmth
 * but has never been pinned down, so the raw field goes out alongside the derived value rather than instead
 * of it. No integrity field is claimed even though there is a checksum, matching upstream's own output.
 */
export const oilWatchman: RDevice = register({
  num: 43,
  name: 'Watchman Sonic / Apollo Ultrasonic / Beckett Rocket oil tank monitor',
  what: 'oil tank level monitor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 1000,
  longWidth: 1000,                                 // NRZ: the two widths are the same
  resetLimit: 4000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const preamble = new Uint8Array([0xe0]);       // 111000xx, only the first six bits are stable
    const postamble = new Uint8Array([0x00, 0xc0]);
    let bitpos = 0;
    let events = 0;

    while ((bitpos = bits.search(0, bitpos, preamble, 6)) + 136 <= bits.bitsPerRow[0]) {
      bitpos += 6;

      const databits = new BitBuffer();
      bitpos = bits.manchesterDecode(0, bitpos, databits, 64);
      if (databits.bitsPerRow[0] !== 64) continue;

      const b = databits.bb[0];
      // The tail to expect depends on the level the last data bit left behind.
      if (bits.search(0, bitpos, postamble.subarray(b[7] & 1), 2) !== bitpos) continue;
      if (b[7] !== crc8le(b, 7, 0x31, 0)) continue;

      const flags = b[4];
      const maybetemp = b[5] >> 2;

      // Binding and reading share the same two bytes; the rebind flag says which one arrived.
      let depth = 0;
      let bindingCountdown = 0;
      if (flags & 1) bindingCountdown = b[6];      // counts up from 0x51 while a magnet is held to the sensor
      else depth = ((b[5] & 3) << 8) | b[6];       // zero means the sensor got no echo at all

      ctx.emit({
        model: 'Oil-SonicSmart',
        type: 'Oil',
        id: (((b[0] << 24) >>> 0) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0,
        flags,
        maybetemp,                                 // kept raw: the temperature below is inferred, not read
        temperature_C: (145.0 - 5.0 * maybetemp) / 3.0,
        binding_countdown: bindingCountdown,
        depth_cm: depth,
      });
      events++;
    }
    return events;
  },
});

// ---------------------------------------------------------------------------
// Oil Ultrasonic STANDARD, keyed two ways (81 FSK, 83 ASK)
// ---------------------------------------------------------------------------

/**
 * One frame, read the same way whichever keying carried it.
 *
 * The first thing this does is refuse a Smart packet. The Smart run-in `55 55 58` contains a valid Standard
 * sync word ten bits in, and since this protocol has no checksum it would otherwise accept the fragment and
 * report a wrong depth from a sensor that was working perfectly.
 */
function oilStandardOne(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const smartPreamble = new Uint8Array([0x55, 0x55, 0x58]);
  if (bitpos >= 24 && bits.search(row, bitpos - 24, smartPreamble, 24) === bitpos - 24) return 0;

  const databits = new BitBuffer();
  bits.manchesterDecode(row, bitpos, databits, 41);

  const n = databits.bitsPerRow[0];
  const b = databits.bb[0];
  if (n < 32 || n > 40 || (b[4] & 0xfe) !== 0) return 0;

  const flags = b[2] & 0xf5;                       // ~0x0a: the depth's high bit and the alarm live elsewhere
  const alarm = (b[2] & 0x08) >> 3;

  let depth = 0;
  let bindingCountdown = 0;
  if (flags & 1) {
    bindingCountdown = b[3];                       // counts up from 0x40 while rebinding
  }
  else {
    depth = ((b[2] & 0x02) << 7) | b[3];
    // With no checksum, this range check is doing real work: the field is nine bits but the sensor only
    // reaches about 305 cm, so anything above that is noise the preamble match let through.
    if (depth > 305) return 0;
  }

  ctx.emit({
    model: 'Oil-SonicStd',
    type: 'Oil',
    id: (b[0] << 8) | b[1],
    flags,
    alarm,
    binding_countdown: bindingCountdown,
    depth_cm: depth,
  });
  return 1;
}

/** Both sync words, each scanned across the whole row, because a burst can carry several frames. */
function oilStandardScan(bits: BitBuffer, ctx: DecodeCtx): number {
  let events = 0;
  for (const pattern of [new Uint8Array([0x55, 0x5d]), new Uint8Array([0x55, 0x62])]) {
    let bitpos = 0;
    while ((bitpos = bits.search(0, bitpos, pattern, 16)) + 78 <= bits.bitsPerRow[0]) {
      events += oilStandardOne(bits, ctx, 0, bitpos + 14);
      bitpos += 2;
    }
  }
  return events;
}

/** The European build, frequency shifted. */
export const oilStandard: RDevice = register({
  num: 81,
  name: 'Oil Ultrasonic STANDARD FSK',
  what: 'oil tank level monitor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 500,
  longWidth: 500,
  resetLimit: 2000,
  bands: BAND_433,
  decode: (_dev, bits: BitBuffer, ctx: DecodeCtx) => oilStandardScan(bits, ctx),
});

/** The same frame keyed on and off instead, which is how the American Beckett Rocket sends it. */
export const oilStandardAsk: RDevice = register({
  num: 83,
  name: 'Oil Ultrasonic STANDARD ASK',
  what: 'oil tank level monitor',
  modulation: Modulation.OOK_PCM,
  shortWidth: 500,
  longWidth: 500,
  resetLimit: 2000,
  bands: BAND_915,
  decode: (_dev, bits: BitBuffer, ctx: DecodeCtx) => oilStandardScan(bits, ctx),
});

// ---------------------------------------------------------------------------
// Watchman Sonic Advanced / Plus, Tekelek (234)
// ---------------------------------------------------------------------------

/**
 * The modern one, and the only member of the family with a real message format: a long run-in, a sync word, a
 * length byte, a model code, and a CRC-16 over the lot.
 *
 * It also has a genuine bug in the wild, which upstream works around rather than rejects. Some units emit the
 * CRC shifted one bit left, so the check is tried twice — once as read, and once reassembled from an extra
 * bit captured past the end of the message. Both of the captures rtl_433 ships are the same reading, one with
 * each fault, and the tests here run both paths.
 *
 * The temperature is offset by 0x48 and carried in half degrees, but upstream divides as an integer and so
 * does this, which throws away the half. That is a deliberate match rather than an oversight: reporting a
 * value upstream never produces would make the two disagree on real radio.
 */
export const oilWatchmanAdvanced: RDevice = register({
  num: 234,
  name: 'Watchman Sonic Advanced / Plus, Tekelek',
  what: 'oil tank level monitor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 500,
  longWidth: 500,
  resetLimit: 12500,                               // long enough to ride out 24 zero bits in a row
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const preamble = new Uint8Array([0xaa, 0xaa, 0xaa, 0x2d, 0xd4, 0x0e]);
    let bitpos = 0;
    let events = 0;

    while ((bitpos = bits.search(0, bitpos, preamble, 48)) + 129 <= bits.bitsPerRow[0]) {
      bitpos += 40;                                // step over preamble and sync, landing on the length byte

      // One bit past the message, kept so a shifted CRC can be put back together.
      const msg = bits.bytes(0, bitpos, 137);
      bitpos += 136;

      const crcCalc = crc16(msg, 15, 0x8005, 0);
      const crcRead = (msg[15] << 8) | msg[16];
      if (crcCalc !== crcRead) {
        const crcShifted = ((msg[15] << 9) | (msg[16] << 1) | (msg[17] >> 7)) & 0xffff;
        if (crcCalc !== crcShifted) return DECODE_FAIL_MIC;
      }

      const mcode = (msg[1] << 8) | msg[2];
      if (mcode !== 0x0401 && mcode !== 0x0106 && mcode !== 0x0101) return DECODE_FAIL_SANITY;

      ctx.emit({
        model: 'Oil-SonicAdv',
        type: 'Oil',
        id: (msg[3] << 16) | (msg[4] << 8) | msg[5],   // the serial printed on the sensor's label
        version: `${msg[11] & 0x0f}.${msg[12] & 0x0f}.${msg[13] & 0x0f}.${msg[14] & 0x0f}`,
        temperature_C: Math.trunc((msg[7] - 0x48) / 2),
        depth_cm: ((msg[9] & 0x0f) << 8) | msg[10],
        status: msg[6],
        mic: 'CRC',
      });
      events++;
    }
    return events;
  },
});

// ---------------------------------------------------------------------------
// Oil Ultrasonic SMART (235)
// ---------------------------------------------------------------------------

/**
 * The Standard's frame with a checksum bolted on, which is what lets it be trusted where the Standard cannot.
 *
 * Most of the first status byte is still guesswork, and upstream's field names say as much. Two pairs of bits
 * appear to work against each other — a reading is only believed to be warm enough when the two temperature
 * bits differ — so they are reported as upstream reads them rather than reinterpreted here.
 */
function oilSmartOne(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const databits = new BitBuffer();
  bits.manchesterDecode(row, bitpos, databits, 64);
  if (databits.bitsPerRow[0] < 64) return 0;

  const b = databits.bb[0];
  if (crc8le(b, 8, 0x31, 0x00) !== 0) return 0;

  // The two temperature bits agreeing is what marks the sensor as too cold to take a reading.
  const tempOk = ((b[4] & 0x10) === (b[4] & 0x20)) ? 0 : 1;

  ctx.emit({
    model: 'Oil-Ultrasonic',
    type: 'Oil',
    id: (((b[0] << 24) >>> 0) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0,
    depth_cm: ((b[5] & 0x01) << 8) + b[6],       // zero means no echo came back
    txstatus: (b[4] & 0x40) ? 'Rapid' : 'Normal',
    temp_ok: tempOk,
    battery_ok: (b[4] & 0x04) >> 2,
    sensor: b[4] & 0x03,
    counter: (b[5] & 0xf0) >> 4,                 // walks up and down across a day, probably for usage stats
    unknown: (b[5] & 0x0d) >> 1,
    mic: 'CRC',
  });
  return 1;
}

export const oilSmart: RDevice = register({
  num: 235,
  name: 'Oil Ultrasonic SMART FSK',
  what: 'oil tank level monitor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 500,
  longWidth: 500,
  gapLimit: 2000,
  resetLimit: 9000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const preamble = new Uint8Array([0x55, 0x58]);
    let bitpos = 0;
    let events = 0;
    while ((bitpos = bits.search(0, bitpos, preamble, 16)) + 128 <= bits.bitsPerRow[0]) {
      events += oilSmartOne(bits, ctx, 0, bitpos + 16);
      bitpos += 2;
    }
    return events;
  },
});
