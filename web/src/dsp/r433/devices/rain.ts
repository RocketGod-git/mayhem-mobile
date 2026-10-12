/**
 * Rain gauges, pool thermometers and garden sensors.
 *
 * These are the cheap outdoor end of the 433 MHz weather market, and they are a scrappier family than the
 * thermometers next door. Four of the nine have no integrity check at all worth the name, two of those are
 * shipped switched off by upstream for exactly that reason, and one — Biltema — carries a checksum nobody has
 * ever worked out. What that means in practice is that the structural gates matter more here than usual: with
 * no checksum, the only thing standing between a stray burst and a bogus rainfall reading is a handful of
 * always-zero bits and a demand that the sensor said the same thing several times running.
 *
 * A word on rain totals, because it is the thing most likely to look wrong. Every gauge here reports a
 * free-running tick count from a tipping bucket, not a rate: it climbs all season and wraps when the field
 * runs out. That is reported as sent. Deriving millimeters-per-hour from it needs two readings and a clock,
 * which is the application's job, not the decoder's. Biltema is the exception and not a happy one — it really
 * does try to compute a rate, via arithmetic its own author flagged as guesswork, and that is preserved here
 * unchanged along with the `disabled` mark that warns about it.
 *
 * Two upstream documentation errors turned up while porting and are pinned in the test rather than papered
 * over. The EMOS rain gauge's "after inversion" row disagrees with its own raw capture in two bytes, and only
 * the raw one satisfies the checksum the file describes. The EMOS weather station's decoded example prints
 * every field from the inverted frame except the battery nibble, which it prints uninverted.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `bt_rain.c`, `rainpoint.c`, `atech_ws308.c`, `emos_e6016.c`,
 * `emos_e6016_rain.c`, `rubicson_pool_48942.c`, `baldr_rain.c`, `schou_72543_rain.c`, `baldr_therm.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addBytes, addNibbles, crc8, reflectBytes, xorBytes } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const pad2 = (n: number) => n.toString().padStart(2, '0');

/** Sign-extend the low 16 bits, which is how several of these read a temperature that sits high in a word. */
const int16 = (x: number) => (x << 16) >> 16;

// ---------------------------------------------------------------------------
// Biltema rain gauge (118)
// ---------------------------------------------------------------------------

/**
 * A Swedish hardware-store rain gauge, and the least trustworthy decoder in this file.
 *
 * Upstream ships it disabled and says why: the ninth nibble is a checksum nobody has reverse engineered, so
 * nothing here can tell a real frame from a plausible-looking accident. It was written from a handful of
 * samples against the Springfield decoder, and the comments admit to two unresolved ambiguities — the same
 * three bits of byte one are read both as the top of the rain counter and as the channel, and the author was
 * not sure which reading is right. Both are kept exactly as upstream has them.
 *
 * The rain arithmetic deserves a warning. Rather than report the tick count, the sensor's author tried to undo
 * a wrap: the counter advances by 25 per bucket tip and rolls over at 82 tips, carrying the remainder, and
 * this reconstructs a total from the remainder modulo 25. The result is then scaled to a millimeters-per-hour
 * figure. It is guesswork on top of guesswork and produces implausibly large numbers even for a dry gauge, but
 * changing it would mean disagreeing with the source on a device neither of us can test, so it stands as
 * written. The `disabled` mark is the honest signal here, and it is mirrored from upstream.
 */
export const btRain: RDevice = register({
  num: 118,
  name: 'Biltema rain gauge',
  what: 'rain gauge',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1940,
  longWidth: 3900,
  gapLimit: 4100,
  resetLimit: 8800,
  bands: BAND_433,
  disabled: true,                                  // no working checksum; upstream ships it off, so do we
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Every transmission but the last is 37 bits; the last drops the trailing bit.
    const row = bits.findRepeatedRow(4, 36);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 36 && bits.bitsPerRow[row] !== 37) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    // An idle all-ones carrier would otherwise decode to a reading, and there is no checksum to catch it.
    if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff) return DECODE_FAIL_SANITY;

    const id      = b[0];
    const battery = b[1] >> 7;
    const channel = ((b[1] & 0x30) >> 4) + 1;
    const button  = (b[1] & 0x08) >> 3;

    // Eleven bits of two's-complement tenths, left-aligned so the sign extension comes for free.
    const tempC = (int16(((b[1] & 0x07) << 13) | (b[2] << 5)) >> 5) * 0.1;

    // These are the same three bits the temperature's high end uses; upstream is unsure and so are we.
    let rain = ((b[1] & 0x07) << 4) | b[3];
    const rest = rain % 25;
    if (rest % 2) rain += Math.floor(rest / 2) * 2048;
    else rain += Math.floor((rest + 1) / 2) * 2048 + 12 * 2048;

    ctx.emit({
      model: 'Biltema-Rain',
      type: 'Weather',
      id,
      channel,
      battery_ok: battery ? 0 : 1,
      transmit: button ? 'MANUAL' : 'AUTO',
      temperature_C: round1(tempC),
      rain_rate_mm_h: round2(rain * 0.052),        // 19.23 mm per bucket tip, per upstream's note
      button,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// RainPoint soil temperature and moisture sensor (195)
// ---------------------------------------------------------------------------

/**
 * A soil probe: a spike with a thermometer and a moisture sensor, reporting from a flower bed.
 *
 * This is the only Manchester-coded device in the file, and it has an oddity upstream calls out — the gap
 * between packets is a steady carrier rather than silence, which is why the whole burst arrives as one very
 * long row instead of the usual repeated short ones. So the decode is a preamble search rather than a repeat
 * count, and there is no repetition check at all: the nibble sum is the only thing vouching for the frame.
 *
 * The preamble search rewinds two bits. That is deliberate and load-bearing: the last two bits of the sync
 * word are also the first Manchester symbol of the data, so consuming the full pattern would eat the leading
 * data bit. The consequence is that the frame's first decoded bit is not free — the sync word fixes it — and
 * a builder that ignores this produces frames the real sensor could never send.
 *
 * Three layers of transformation sit between the air and the bytes: Manchester decoding, then a whole-frame
 * inversion, then a per-byte bit reflection. The sum is checked after all three. Upstream narrows it to eight
 * bits before comparing, so the shared helper's masking is correct here rather than a hazard — twenty nibbles
 * can reach 300 and genuinely do overflow.
 */
export const rainpoint: RDevice = register({
  num: 195,
  name: 'RainPoint soil temperature and moisture sensor',
  what: 'soil temperature and moisture probe',
  modulation: Modulation.OOK_PCM,
  shortWidth: 500,
  longWidth: 500,
  resetLimit: 1500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // One long row, because the inter-packet gap is carrier rather than silence.
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 232 || bits.bitsPerRow[0] > 3000) {
      return DECODE_ABORT_EARLY;
    }

    const pos = bits.search(0, 0, new Uint8Array([0xaa, 0xa9]), 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    // Back up two bits: the sync word's tail is also the first Manchester symbol of the payload.
    const start = pos + 16 - 2;

    const msg = new BitBuffer();
    const end = bits.manchesterDecode(0, start, msg, 12 * 8);
    if (end - start !== 12 * 2 * 8) return DECODE_ABORT_LENGTH;

    msg.invert();
    const b = msg.bb[0];
    reflectBytes(b, 12);

    // Upstream masks before comparing, so the shared (masked) helper is the right one here.
    if (addNibbles(b, 10) !== b[10]) return DECODE_FAIL_MIC;

    // Upstream labels these guesses and marks them for removal; they are carried through unchanged.
    const flags = b[4];
    const chan = flags === 0x9f ? 1 : flags === 0xb1 ? 2 : flags === 0xb7 ? 3 : 0;

    ctx.emit({
      model: 'RainPoint-Soil',
      type: 'Weather',
      id: (b[2] << 8) | b[3],
      channel: chan,
      sync: (b[0] << 8) | b[1],
      flags,
      status: (b[5] << 8) | b[6],
      temperature_C: (b[7] << 24) >> 24,           // whole degrees, signed
      moisture: b[8],
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Atech WS-308 (196)
// ---------------------------------------------------------------------------

/**
 * Undo the sensor's second layer of coding: pulse widths carried inside a return-to-zero line code.
 *
 * The radio side slices this as plain RZ, which yields a run of ones and zeros rather than data bits. The
 * actual bits live in how many ones precede each zero — one for a zero bit, three for a one bit. Anything else
 * is a coding violation and stops the decode where it stands, which is the only structural check this device
 * gets before its parity fold.
 *
 * Returns how many bits were recovered, so the caller can insist on a full 28.
 */
function pwmOfPcmDecode(row: Uint8Array, bitLen: number, out: Uint8Array, outLen: number): number {
  let pos = 0;
  let cnt = 0;
  for (let i = 0; i < bitLen; i++) {
    if (row[i >> 3] & (1 << (7 - (i % 8)))) {
      cnt++;                                       // still counting ones
      continue;
    }
    // A zero closes the symbol: 10 is a zero bit, 1110 a one bit, anything else is a violation.
    if (pos % 8 === 0) out[pos >> 3] = 0;
    if (cnt === 1) pos++;
    else if (cnt === 3) { out[pos >> 3] |= 1 << (7 - (pos % 8)); pos++; }
    else break;
    if (pos >= outLen) break;
    cnt = 0;
  }
  return pos;
}

/**
 * The outdoor sensor for an Atech wireless weather station: a thermometer and nothing else.
 *
 * It transmits a nine-bit run-in as its own row followed by the data row, so the shape of the buffer is part
 * of the identification — exactly two rows, with the payload in the second. That is unusual enough to be worth
 * stating, since almost every other device here looks for a row that repeated.
 *
 * The temperature is three BCD digits rather than a scaled count, with a separate sign bit, so it reads out as
 * decimal hundreds, tens and units. The check is an even parity fold: exclusive-or the first three bytes,
 * fold the last nibble in, and the result must be zero. Upstream also has a sanity test on the fixed id byte,
 * but it is commented out in the source and is left commented out here — enabling it would reject frames
 * upstream accepts.
 */
export const atechWs308: RDevice = register({
  num: 196,
  name: 'Atech-WS308 temperature sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PCM,                  // RZ: the slicer picks that up from short != long
  shortWidth: 1600,
  longWidth: 1832,
  gapLimit: 2500,
  resetLimit: 9000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // A short run-in row and then the data row: anything else is not this sensor.
    if (bits.numRows !== 2) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[1] < 58) return DECODE_ABORT_LENGTH;

    const b = new Uint8Array(4);                   // 28 bits, seven nibbles
    const len = pwmOfPcmDecode(bits.bb[1], bits.bitsPerRow[1], b, 32);
    if (len < 28) return DECODE_ABORT_LENGTH;

    // Even parity across all seven nibbles. The last byte holds only its high nibble, so folding the low
    // nibble of the running xor rather than of the combined value comes to the same thing.
    let chk = xorBytes(b, 3);
    chk = ((chk ^ b[3]) >> 4) ^ (chk & 0x0f);
    if (chk !== 0) return DECODE_FAIL_MIC;

    const tempRaw = ((b[1] & 0x0f) * 100) + ((b[2] >> 4) * 10) + (b[2] & 0x0f);
    const sign = (b[1] & 0x20) ? -1 : 1;
    // The multiply can produce a negative zero for a reading of exactly 0.0 with the sign bit set; adding
    // zero normalizes that so the field never reads as -0.
    const tempC = round1(sign * tempRaw * 0.1) + 0;

    ctx.emit({
      model: 'Atech-WS308',
      type: 'Weather',
      id: b[0],                                    // fixed 0x0c in every frame seen
      temperature_C: tempC,
      mic: 'PARITY',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// EMOS E6016 weather station and E6018 sensor (214)
// ---------------------------------------------------------------------------

/**
 * Two EMOS sensors that share a frame: a full weather station and a plain thermometer.
 *
 * The frame is sent inverted, and the order of operations around that matters. The three-byte model preamble
 * is matched against the raw air bytes, before inversion; everything afterward — checksum, id, readings — is
 * read from the inverted frame. Getting that backwards makes the model check fail on every real transmission.
 *
 * A two-bit variant field separates the two products. The E6018 is the cut-down one: no wind sensor and no
 * DCF77 receiver, so its wind fields are always zero and its clock is a free-running counter seeded at a fixed
 * date that never tracks reality. Reporting either as though it were real would be a lie, so those fields are
 * emitted only for the full station, which is what upstream's conditional output does.
 *
 * The repeat check looks at 112 bits rather than the full 120 because the last byte is a repeat counter that
 * decrements every transmission — the rows are deliberately not identical.
 *
 * The byte sum overflows a byte on real frames (the published capture sums to 1735) but upstream narrows it
 * before comparing, so the shared masked helper is correct here rather than a hazard.
 */
export const emosE6016: RDevice = register({
  num: 214,
  name: 'EMOS E6016 weatherstation with DCF77, EMOS E6018 temperature/humidity sensor',
  what: 'weather station with a radio clock',
  modulation: Modulation.OOK_PWM,
  shortWidth: 280,
  longWidth: 796,
  gapLimit: 3000,
  resetLimit: 850,
  syncWidth: 1836,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Ignore the trailing repeat byte, which differs on purpose from one transmission to the next.
    const row = bits.findRepeatedPrefix(3, 120 - 8);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 120) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    // Matched against the raw air bytes: this check happens before the inversion below.
    if (b[0] !== 0x55 || b[1] !== 0x5a || b[2] !== 0x7c) return DECODE_ABORT_EARLY;

    bits.invert();

    if (addBytes(b, 13) !== b[13]) return DECODE_FAIL_MIC;

    const variant = (b[4] >> 6) & 0x03;            // 2 is the full station, 0 the bare sensor
    const isE6018 = variant !== 2;

    // A 32-bit datetime packed across five bytes. Kept unsigned: the top field would otherwise reach past
    // the sign bit of a 32-bit word and read back negative.
    const dt = (((b[4] & 0x3f) << 26) | (b[5] << 18) | (b[6] << 10) | (b[7] << 2) | (b[8] >> 6)) >>> 0;
    const clock = `${((dt >>> 26) & 0x3f) + 2000}-${pad2((dt >>> 22) & 0x0f)}-${pad2((dt >>> 17) & 0x1f)}`
      + `T${pad2((dt >>> 12) & 0x1f)}:${pad2((dt >>> 6) & 0x3f)}:${pad2(dt & 0x3f)}`;

    const tempC = (int16(((b[8] & 0x0f) << 12) | (b[9] << 4)) >> 4) * 0.1;

    ctx.emit({
      model: isE6018 ? 'EMOS-E6018' : 'EMOS-E6016',
      type: 'Weather',
      id: b[3],
      channel: ((b[8] >> 4) & 0x03) + 1,
      battery_ok: (b[12] >> 2) & 0x01,
      temperature_C: round1(tempC),
      humidity: b[10],
      // Withheld for the E6018, which has neither a wind sensor nor a real clock.
      ...(isE6018 ? {} : {
        wind_avg_m_s: round1(b[11] * 0.295),
        wind_dir_deg: round1((b[12] >> 4) * 22.5),
        radio_clock: clock,
      }),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// EMOS E6016 rain gauge (217)
// ---------------------------------------------------------------------------

/**
 * The rain gauge that pairs with the EMOS station above, and the one whose documentation does not add up.
 *
 * Same inverted line code and the same preamble-then-invert ordering as its sibling, differing in the third
 * model byte — 0x75 rather than 0x7c — which is what keeps the two decoders off each other's frames.
 *
 * Upstream's doc comment prints its capture three ways: raw, "after inversion", and decoded. The raw row and
 * the inverted row disagree in two bytes, and only one of the two can be right, because they give different
 * checksums. The raw capture inverts to a frame whose byte sum is 0x29, exactly the checksum the frame
 * carries; the printed "after inversion" row sums to 0xeb against the same carried 0x29 and fails. So the raw
 * hex is the real transmission and reports no rain, while the inverted row and the "RAIN:2999" in the decoded
 * example come from somewhere else — and 2999 ticks would be 2099 mm, which is not a plausible reading in any
 * case. The port follows the raw capture and the checksum; the test pins both so the disagreement stays
 * visible instead of looking like a porting error.
 */
export const emosE6016Rain: RDevice = register({
  num: 217,
  name: 'EMOS E6016 rain gauge',
  what: 'rain gauge',
  modulation: Modulation.OOK_PWM,
  shortWidth: 300,
  longWidth: 800,
  gapLimit: 1000,
  resetLimit: 2500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 72);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] < 72 || bits.bitsPerRow[row] > 73) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    // Raw air bytes again, before the inversion. 0x75 here is what separates this from the weather station.
    if (b[0] !== 0x55 || b[1] !== 0x5a || b[2] !== 0x75) return DECODE_ABORT_EARLY;

    bits.invert();

    if (addBytes(b, 8) !== b[8]) return DECODE_FAIL_MIC;

    // A free-running bucket count, 0.7 mm per tick. Reported as sent; it wraps at twelve bits.
    const rainRaw = ((b[6] & 0x0f) << 8) | b[7];

    ctx.emit({
      model: 'EMOS-E6016R',
      type: 'Weather',
      id: b[3],
      battery_ok: (b[4] >> 6) ? 1 : 0,
      rain_mm: round1(rainRaw * 0.7),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Rubicson pool thermometer 48942 (222)
// ---------------------------------------------------------------------------

/**
 * A floating pool thermometer, and the best-behaved device in this file: it is the only one with a real CRC.
 *
 * The frame is inverted like the EMOS pair, but unlike them every check runs after the inversion, including
 * the structural ones — so the low nibble of byte three and the whole of byte five must be zero in the
 * inverted frame. Byte five exists only to hold the forty-first bit, which is why demanding it be zero is a
 * meaningful test rather than a formality.
 *
 * The transmission interval encodes the channel: the sensor waits 55 seconds plus its channel number between
 * bursts, so up to eight of them can share the air without colliding forever.
 *
 * The CRC was checked against the row upstream documents before this was written, and it holds — a CRC-8 with
 * polynomial 0x31 over the first four bytes, matching the fifth. That is worth stating because an unenforced
 * or unverified check is no check at all; this one both verifies and rejects.
 */
export const rubicsonPool48942: RDevice = register({
  num: 222,
  name: 'Rubicson Pool Thermometer 48942',
  what: 'pool thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 280,
  longWidth: 480,
  gapLimit: 5000,
  resetLimit: 6000,
  syncWidth: 730,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 41);
    if (row < 0 || bits.bitsPerRow[row] !== 41) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    bits.invert();                                 // everything below reads the inverted frame

    // Always-zero padding: the low nibble after the temperature, and the lone forty-first bit.
    if ((b[3] & 0x0f) || b[5]) return DECODE_ABORT_EARLY;

    // Silence would otherwise satisfy the CRC, so refuse a frame that is mostly nothing.
    if (b[0] === 0 && b[2] === 0 && b[4] === 0) return DECODE_ABORT_EARLY;

    if (crc8(b, 4, 0x31, 0x00) !== b[4]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Rubicson-48942',
      type: 'Weather',
      channel: (b[0] >> 4) + 1,
      id: ((b[0] & 0x0f) << 6) | ((b[1] & 0xfc) >> 2),   // random, reassigned at power-on
      battery_ok: (b[2] >> 7) ? 0 : 1,
      temperature_C: round1(((((b[2] & 0x7f) << 4) | (b[3] >> 4)) - 1024) * 0.1),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Baldr / RainPoint rain gauge (242)
// ---------------------------------------------------------------------------

/**
 * The rain half of a Baldr weather station. Rain only — its temperature comes from a separate sensor that
 * decodes as a Nexus-TH.
 *
 * There is no checksum whatsoever, which drives both of the unusual flags on this registration. It is shipped
 * disabled by upstream, and it is given a priority that makes it run late, so that Rubicson-Temperature — a
 * device with a real check and a frame this one would happily misread — gets first refusal on any burst they
 * could both claim. Both are mirrored exactly rather than reasoned about afresh: the bits do not justify
 * inventing a different order, and a priority that disagrees with upstream would change which device wins on
 * traffic neither of us can test.
 *
 * With no checksum, the only defenses are a demand for three matching rows and a rejection of all-zero and
 * all-ones frames, which is what silence and a stuck carrier look like.
 *
 * The total is twenty bits of thousandths of an inch, free-running. All seven of upstream's published samples
 * decode through this to the millimeter figures printed beside them.
 */
export const baldrRain: RDevice = register({
  num: 242,
  name: 'Baldr / RainPoint rain gauge',
  what: 'rain gauge',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  gapLimit: 3000,
  resetLimit: 5000,
  bands: BAND_433,
  priority: 10,                                    // let Rubicson-Temperature settle a frame first
  disabled: true,                                  // no checksum at all; upstream ships it off
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 36);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 37) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    // Silence and a stuck carrier, neither of which any checksum is here to catch.
    if ((b[0] === 0 && b[2] === 0 && b[3] === 0)
      || (b[0] === 0xff && b[2] === 0xff && b[3] === 0xff)) return DECODE_ABORT_EARLY;

    ctx.emit({
      model: 'Baldr-Rain',
      type: 'Weather',
      id: (b[0] << 4) | (b[1] >> 4),               // 8 or 12 bits; the top nibble may be a model code
      flags: b[1] & 0x0f,
      rain_in: round3(((b[2] << 12) | (b[3] << 4) | (b[4] >> 4)) * 0.001),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Schou 72543 Day rain gauge (250)
// ---------------------------------------------------------------------------

/**
 * A rain gauge with a thermometer, sold across Scandinavia under at least five names.
 *
 * This decoder is where the shared checksum helper had to be set aside. Upstream takes a full-width byte sum,
 * then does two different things with it: it rejects the frame outright if the sum is zero, and it compares
 * only the low eight bits against the carried checksum. The zero test is the problem. This app's `addBytes`
 * narrows to a byte, and a frame whose true sum is a nonzero multiple of 256 would narrow to zero and be
 * thrown out as silence even though it is a perfectly good transmission. Seven bytes reach 1785, so there are
 * six such sums in range and they are ordinary readings, not edge cases. The sum is therefore taken locally at
 * full width, and the test pins a frame that would be lost otherwise.
 *
 * The rain field counts tenths of a millimeter but starts life near the top of its range rather than at zero —
 * a fresh gauge reads 6552.6 mm and counts down toward the wrap. That is reported as sent.
 *
 * Upstream reads the message counter as three bits where its own layout comment describes four incrementing by
 * two, which come to the same sequence; the code's reading is the one ported.
 */
export const schou72543Rain: RDevice = register({
  num: 250,
  name: 'Schou 72543 Day Rain Gauge, Motonet MTX, MarQuant, TFA Dostmann 30.3252.01, ADE WS1907',
  what: 'rain gauge and thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 972,
  longWidth: 2680,
  syncWidth: 7328,
  resetLimit: 2712,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Three rows are sent; two must agree for the reading to be believed.
    if (bits.numRows < 2) return DECODE_ABORT_LENGTH;

    const row = bits.findRepeatedPrefix(2, 64);
    if (row < 0) return DECODE_ABORT_EARLY;

    const b = bits.bb[row];
    const chk = b[7];

    // Full width on purpose: upstream's zero test runs before any narrowing, and a masked sum would
    // discard any frame whose true sum is a nonzero multiple of 256.
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += b[i];

    if (sum === 0) return DECODE_ABORT_EARLY;      // an all-zero row would otherwise check out perfectly
    if (chk !== (sum & 0xff)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Schou-72543',
      type: 'Weather',
      id: (b[0] << 8) | b[1],                      // random, reassigned at every battery change
      temperature_F: round1((((b[6] << 8) | b[5]) - 900) * 0.1),
      rain_mm: round1(((b[4] << 8) | b[3]) * 0.1),
      battery_ok: (b[2] & 0x80) ? 0 : 1,
      msg_counter: (b[2] & 0x0e) >> 1,
      msg_repeat: (b[2] & 0x40) ? 1 : 0,           // set for the four repeats after a battery change
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Baldr E0666TH thermo-hygrometer (284)
// ---------------------------------------------------------------------------

/**
 * The remote sensor for a Baldr solar weather station: temperature, humidity, and a channel switch hidden in
 * the battery compartment.
 *
 * Same line code and the same timings as the Baldr rain gauge above, and no checksum here either — but this
 * one is not disabled upstream, and the reason is visible in the frame. It demands eight matching rows rather
 * than three, and it has an unusually rich set of always-fixed bits to test: a spare bit in byte one, a whole
 * fixed nibble before the humidity, a fixed nibble after it, an entirely zero byte, and seven fixed bits in
 * byte six. Together those are around eighteen bits that must land exactly right, which is a stronger filter
 * than some of the real checksums in this file. The two are told apart by length regardless — 36 bits for the
 * gauge against 64 here — so neither needs a priority to stay off the other's frames.
 *
 * The identifier is split across the two ends of the frame and survives battery changes, which is unusual for
 * this price bracket; most of these sensors reroll their id at power-on.
 *
 * The startup flag drops from one to zero ten to fifteen minutes after power-on, so a reading with it set is
 * from a sensor that has only just woken up and may not have settled.
 */
export const baldrTherm: RDevice = register({
  num: 284,
  name: 'Baldr E0666TH Thermo-Hygrometer',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  gapLimit: 3000,
  resetLimit: 5000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Eight repeats: with no checksum, repetition is doing most of the work.
    const row = bits.findRepeatedRow(8, 64);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 65) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    // The fixed bits, which stand in for the checksum this device does not have.
    if ((b[1] & 0x40) !== 0x00 || (b[3] & 0xf0) !== 0xf0
      || (b[4] & 0x0f) !== 0x00 || b[5] !== 0x00 || (b[6] & 0xf7) !== 0x00) {
      return DECODE_ABORT_EARLY;
    }

    const tempC = (int16((b[1] << 12) | (b[2] << 4)) >> 4) * 0.1;

    ctx.emit({
      model: 'Baldr-E0666TH',
      type: 'Weather',
      id: (b[0] << 8) | b[7],                      // split across the frame, survives battery changes
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: (b[1] & 0x80) ? 1 : 0,
      temperature_C: round1(tempC),
      humidity: ((b[3] << 4) | (b[4] >> 4)) & 0xff,
      startup: (b[6] & 0x08) ? 1 : 0,              // clears ten to fifteen minutes after power-on
    });
    return 1;
  },
});
