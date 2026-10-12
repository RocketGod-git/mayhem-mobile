/**
 * Lighting, ceiling fans and wireless switches, plus two Philips thermometers that came with clock radios.
 *
 * The two Philips sensors are grouped here because they are the same product line rather than the same
 * protocol — they share nothing but a manufacturer and a pair of pulse widths.
 *
 * None of these six publishes a raw capture, which is unusual: every other batch in this app has had at least
 * one frame of real radio to check against. The one exception is the AJ7010, whose file prints five decoded
 * rows in binary with the temperature and channel each was recorded at. Those are used directly, and they turn
 * out to disagree with the conversion the same file applies — which upstream already suspects, marking that
 * line "this is very likely wrong". The formula is reproduced as written and the disagreement pinned, because
 * inventing a better fit from five points would be guessing with extra steps.
 *
 * LightwaveRF is the most heavily coded: the frame is inverted, then every zero bit is expanded to two bits,
 * then a delimiter bit is stripped from the front of each byte, and only then does each byte map through a
 * sixteen-entry table to a single nibble. Every byte in that table has exactly two zero bits, which is what
 * makes the expansion come out to a fixed length and lets a corrupt byte be caught by the table alone.
 *
 * Two of the six ship switched off upstream and are mirrored that way here: LightwaveRF, whose file calls
 * itself a stub for decoding test data, and Quinetic, which needs a receiver tuned to 433.4 MHz at a sample
 * rate this app does not normally use.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `lightwave_rf.c`, `philips_aj3650.c`, `ge_coloreffects.c`,
 * `philips_aj7010.c`, `quinetic.c`, `martec_mplcd.c`.
 */

import { BitBuffer, bitAt } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addNibbles, crc4, crc16, reflect4, xorBytes } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// LightwaveRF (61)
// ---------------------------------------------------------------------------

/**
 * Each transmitted byte stands for one nibble, and only sixteen byte values are legal.
 *
 * Every one of them has exactly two zero bits, which is not decoration: it is what makes the bit-stuffed
 * message a fixed ninety-one bits, and it means a single flipped bit almost always lands outside the table
 * and is caught. Anything not in this list is a decoding error rather than an unknown value.
 */
const LIGHTWAVE_NIBBLE = (() => {
  const table = new Int8Array(256).fill(-1);
  const bytes = [0xf6, 0xee, 0xed, 0xeb, 0xde, 0xdd, 0xdb, 0xbe,
                 0xbd, 0xbb, 0xb7, 0x7e, 0x7d, 0x7b, 0x77, 0x6f];
  bytes.forEach((b, nibble) => { table[b] = nibble; });
  return table;
})();

/**
 * A British lighting and socket system, ported from what upstream itself calls a stub.
 *
 * The pulse train carries seventy-one bits, because the seventy-second is a delimiter whose gap the
 * demodulator reads as the end of the message instead. Turning that back into ten nibbles takes three passes:
 * expand, strip, then look up. Each pass is done into its own buffer rather than by appending rows to the one
 * being decoded, which is how upstream does it — the result is identical and it leaves the shared buffer
 * alone.
 *
 * There is no checksum at all. The only thing standing between this and noise is that all ten bytes have to
 * be found in the nibble table, which is why upstream ships it disabled and why that is mirrored here.
 */
export const lightwaveRf: RDevice = register({
  num: 61,
  name: 'LightwaveRF',
  what: 'lighting and socket remote',
  modulation: Modulation.OOK_PPM,
  shortWidth: 250,
  longWidth: 1250,
  resetLimit: 1500,
  bands: BAND_433,
  disabled: true,                                  // mirrors upstream: a stub with no integrity check
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 71 || bits.numRows !== 1) return DECODE_ABORT_LENGTH;

    bits.invert();                                 // the line coding is the other way up

    // Every zero becomes "10", so twenty zeros grow the message from seventy-one bits to ninety-one.
    const stuffed = new BitBuffer();
    for (let n = 0; n < bits.bitsPerRow[0]; n++) {
      if (bitAt(bits.bb[0], n)) {
        stuffed.addBit(1);
      }
      else {
        stuffed.addBit(1);
        stuffed.addBit(0);
      }
    }
    if (stuffed.bitsPerRow[0] !== 91) return DECODE_ABORT_LENGTH;

    // A delimiter bit leads the message and each of the ten bytes; all of them must be set.
    let idx = 0;
    if (!bitAt(stuffed.bb[0], idx++)) return DECODE_ABORT_EARLY;

    const stripped = new BitBuffer();
    for (let n = 0; n < 10; n++) {
      if (!bitAt(stuffed.bb[0], idx++)) return DECODE_ABORT_EARLY;
      for (let m = 0; m < 8; m++) stripped.addBit(bitAt(stuffed.bb[0], idx++));
    }
    // The closing delimiter is the bit the demodulator never gave us, so it is not checked.

    const nibbles = new BitBuffer();
    for (let n = 0; n < 10; n++) {
      const nibble = LIGHTWAVE_NIBBLE[stripped.bb[0][n]];
      if (nibble < 0) return DECODE_FAIL_SANITY;
      for (let m = 0; m < 4; m++) nibbles.addBit((nibble >> (3 - m)) & 1);
    }

    const b = nibbles.bb[0];
    ctx.emit({
      model: 'Lightwave-RF',
      type: 'Remote',
      id: (b[2] << 16) | (b[3] << 8) | b[4],
      subunit: (b[1] & 0xf0) >> 4,
      command: b[1] & 0x0f,
      parameter: b[0],
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Philips AJ3650 outdoor temperature sensor (94)
// ---------------------------------------------------------------------------

/** Wire channel values are not the numbers on the case; anything unrecognized reads as zero. */
const PHILIPS_CHANNEL = [2, 0, 1, 0, 3];

/**
 * A clock-radio thermometer that sends its reading three times in one burst and lets the receiver vote.
 *
 * The three copies are not aligned the same way — the middle one sits four bits out of step with the other
 * two — so each has to be reassembled before they can be compared. The decoder then takes each byte by
 * majority across the three, which means a burst can survive damage in any one copy. That is the interesting
 * property here, and the tests exercise it directly by corrupting one copy and expecting a reading anyway.
 *
 * The CRC is a non-standard four-bit one computed over the frame including its own check nibble, so a valid
 * frame is the one where it comes out zero.
 */
export const philipsAj3650: RDevice = register({
  num: 94,
  name: 'Philips outdoor temperature sensor (type AJ3650)',
  what: 'thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 2000,
  longWidth: 6000,
  resetLimit: 30000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();

    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 112) return DECODE_ABORT_LENGTH;

    const bb = bits.bb[0];
    if ((bb[0] >> 4) !== 0x0) return DECODE_ABORT_EARLY;

    // Three copies, the middle one offset by half a byte, combined bit by bit on a majority.
    const packet = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      const a = bb[i + 1];
      const b = ((bb[i + 5] << 4) | ((bb[i + 6] >> 4) & 0x0f)) & 0xff;
      const c = bb[i + 10];
      packet[i] = (a & b) | (b & c) | (a & c);
    }

    if (crc4(packet, 4, 0x9, 1) !== 0) return DECODE_FAIL_MIC;

    const wire = packet[0] & 0x0f;
    const tempRaw = (packet[1] << 2) | (packet[2] >> 6);

    ctx.emit({
      model: 'Philips-Temperature',
      type: 'Weather',
      channel: wire >= PHILIPS_CHANNEL.length ? 0 : PHILIPS_CHANNEL[wire],
      battery_ok: (packet[3] & 0x40) ? 0 : 1,
      temperature_C: round1((tempRaw - 500) * 0.1),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// GE Color Effects remote (98)
// ---------------------------------------------------------------------------

/**
 * A line code where a zero is two bits and a one is four, decoded until something illegal appears.
 *
 * Returning early on anything else is what bounds the frame: there is no length field, so the decode simply
 * runs until the pattern breaks and the caller checks it stopped at seventeen bits.
 */
function geDecodeBits(bits: BitBuffer, start: number, out: BitBuffer): void {
  const row = bits.bb[0];
  const len = bits.bitsPerRow[0];
  let ipos = start;

  while (ipos < len) {
    const first = bitAt(row, ipos++);
    const second = bitAt(row, ipos++);
    if (first === 1 && second === 0) {
      out.addBit(0);
    }
    else if (first === 1 && second === 1) {
      if (bitAt(row, ipos++) === 0 && bitAt(row, ipos++) === 0) out.addBit(1);
      else break;
    }
    else {
      break;
    }
  }
}

/** One frame: two zero bits, a six-bit address, a command byte, and a closing zero. */
function geFrame(bits: BitBuffer, start: number, ctx: DecodeCtx): number {
  const packet = new BitBuffer();
  geDecodeBits(bits, start, packet);

  if (packet.bitsPerRow[0] !== 17) return DECODE_ABORT_LENGTH;

  const b = packet.bb[0];
  if (b[0] & 0xc0) return DECODE_FAIL_SANITY;      // the frame opens with two zeros
  if (b[2] & 0x80) return DECODE_FAIL_SANITY;      // and closes with one

  const command = b[1];
  const named = command === 0x5a ? 'change' : command === 0xaa ? 'on' : command === 0x55 ? 'off' : null;

  ctx.emit({
    model: 'GE-ColorEffects',
    type: 'Remote',
    id: b[0],                                      // the two leading zeros make the whole byte the address
    // A code with no known meaning goes out as itself rather than under an invented name.
    command: named ?? `0x${command.toString(16)}`,
  });
  return 1;
}

export const geColoreffects: RDevice = register({
  num: 98,
  name: 'GE Color Effects',
  what: 'Christmas light remote',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 450,
  // Upstream records no frequency for this one, so none is claimed here.
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The run-in can be sliced a bit short, so four lengths of two patterns are tried in turn.
    const patterns: Array<[Uint8Array, number]> = [
      [new Uint8Array([0xcc, 0xff, 0x00]), 24],
      [new Uint8Array([0xcc, 0xff, 0x00]), 23],
      [new Uint8Array([0xcc, 0xfe, 0x00]), 23],
      [new Uint8Array([0xcc, 0xfe, 0x00]), 22],
    ];

    let bitpos = 0;
    let events = 0;
    let ret = 0;

    for (;;) {
      let found = -1;
      for (const [pattern, len] of patterns) {
        const at = bits.search(0, bitpos, pattern, len) + len;
        if (at + 33 <= bits.bitsPerRow[0]) { found = at; break; }
      }
      if (found < 0) break;

      bitpos = found;
      ret = geFrame(bits, bitpos, ctx);
      if (ret > 0) events += ret;
      bitpos++;
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Philips AJ7010 outdoor temperature sensor (135)
// ---------------------------------------------------------------------------

/**
 * The other Philips sensor, and the only device in this file with published frames.
 *
 * Its integrity check is unusual: two different sums are computed and the frame is rejected only when *both*
 * fail, because some transmissions cover the last byte and some do not. All five of the rows its file prints
 * pass on the first of those, so the second never fires on the published evidence.
 *
 * The temperature conversion is upstream's, including its doubt. Against the five labelled rows it reads low
 * by roughly half a degree at the top of the range and a degree at the bottom, which is why that file marks
 * the line as very likely wrong. It is reproduced unchanged: five points are not enough to fit a better curve,
 * and quietly substituting one would put this app and its source in disagreement on real radio.
 */
export const philipsAj7010: RDevice = register({
  num: 135,
  name: 'Philips outdoor temperature sensor (type AJ7010)',
  what: 'thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 2000,
  longWidth: 6000,
  syncWidth: 1000,
  resetLimit: 30000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();

    if (bits.numRows !== 1) return DECODE_ABORT_LENGTH;
    if (bits.bitsPerRow[0] !== 40) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    // All ones on air, which is what silence looks like once inverted.
    if (!b[0] && !b[2] && !b[3] && !b[4]) return DECODE_FAIL_SANITY;
    if (b[0] !== 0x00) return DECODE_FAIL_SANITY;

    // Two alternative sums; only failing both rejects the frame.
    if (xorBytes(b, 5) && (xorBytes(b, 3) ^ b[4])) return DECODE_FAIL_MIC;

    const channel = b[1] === 0x36 ? 3 : b[1] === 0x45 ? 2 : b[1] === 0x5a ? 1 : 0;
    const tempRaw = ((b[3] & 0x3f) << 8) | b[2];

    ctx.emit({
      model: 'Philips-AJ7010',
      type: 'Weather',
      channel,
      temperature_C: round1(tempRaw / 353.0 - 9.2),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Quinetic switches and sensors (270)
// ---------------------------------------------------------------------------

/**
 * Kinetic wall switches: pressing one generates its own power, so there is no battery and no battery field.
 *
 * A press and a release both transmit, and the release carries no button number — so it is recognized and
 * dropped rather than reported as a press of button 192.
 *
 * Upstream ships this disabled because it needs a receiver tuned to 433.4 MHz at a sample rate this app does
 * not normally run, and that flag is mirrored. The frequency it does document is recorded here so the band
 * filter has something honest to work with.
 */
export const quinetic: RDevice = register({
  num: 270,
  name: 'Quinetic',
  what: 'kinetic wall switch',
  modulation: Modulation.FSK_PCM,
  shortWidth: 10,
  longWidth: 10,
  resetLimit: 120,
  tolerance: 1,
  bands: [433300000],
  disabled: true,                                  // mirrors upstream: needs 433.4 MHz at a higher sample rate
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 110 || bits.bitsPerRow[0] > 140) return DECODE_ABORT_LENGTH;

    const pos = bits.search(0, 0, new Uint8Array([0xa4, 0x23]), 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const b = bits.bytes(0, pos + 16, 40);
    if (crc16(b, 5, 0x1021, 0x1d0f) !== 0) return DECODE_FAIL_MIC;

    // A release says only that something was let go, not which button it was.
    if (b[2] === 192) return DECODE_ABORT_EARLY;

    ctx.emit({
      model: 'Quinetic',
      type: 'Remote',
      id: ((b[0] << 8) | b[1]).toString(16).padStart(4, '0'),
      channel: b[2],
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Martec MPLCD ceiling fan remote (335)
// ---------------------------------------------------------------------------

const MARTEC_SPEED = ['off', 'high', 'medium', 'low'];

/**
 * A ceiling fan remote that keeps the fan's state itself and sends the whole setting on every press.
 *
 * The frame is twenty-two bits, which is neither a whole number of bytes nor aligned to one — reading it from
 * the second bit is what puts the checksum's four nibbles on boundaries. That checksum is only four bits wide
 * and an all-zero payload satisfies it trivially, so a separate guard throws that case out; no real button
 * press produces it.
 *
 * The dimmer is stored upside down, one being full brightness and forty-one the dimmest, so it is turned back
 * the right way round with zero left meaning off.
 */
export const martecMplcd: RDevice = register({
  num: 335,
  name: 'Martec MPLCD Ceiling Fan Remote',
  what: 'ceiling fan remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 292,
  longWidth: 648,
  gapLimit: 850,
  resetLimit: 12000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 22);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 22) return DECODE_ABORT_LENGTH;

    // Skipping the first bit is what byte-aligns the four nibbles the checksum covers.
    const bytes = bits.bytes(row, 1, 21);

    if ((addNibbles(bytes, 2) & 0x0f) !== ((bytes[2] >> 3) & 0x0f)) return DECODE_FAIL_MIC;
    // Four bits of checksum accept an empty payload as readily as a real one; no remote sends that.
    if (bytes[0] === 0 && bytes[1] === 0) return DECODE_FAIL_SANITY;

    let dimmer = ((bytes[0] & 0x01) << 6) + ((bytes[1] >> 2) & 0x3f);
    if (dimmer > 0) dimmer = 42 - dimmer;          // one is brightest on the wire, so turn it around

    ctx.emit({
      model: 'Martec-MPLCD',
      type: 'Remote',
      id: reflect4(((~bytes[0]) >> 1) & 0x0f),
      dimmer,
      speed: MARTEC_SPEED[bytes[1] & 0x03],
      mic: 'CHECKSUM',
    });
    return 1;
  },
});
