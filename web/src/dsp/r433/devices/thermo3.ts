/**
 * Nine more thermometers and hygrometers, from meat probes to a four-part weather station.
 *
 * Most of this batch came with unusually good evidence. Rubicson ships nineteen captures, Bresser
 * twenty-four annotated bit rows, Thermor A6N six sample frames, and Thermor DG950 one full off-air
 * recording — all of which check out arithmetically, so these ports are pinned to radio rather than to
 * their own reasoning. Klimalogg, Inkbird, Acurite and Auriol publish nothing usable, and their tests are
 * built from the transmit side instead.
 *
 * Two upstream defects survive into this file deliberately, both pinned in the test rather than quietly
 * repaired. Rubicson's temperature loses its magnitude whenever the sign bit is set — a C precedence
 * accident, described at that decoder. Inkbird's documented sample row fails the very CRC it documents,
 * although the CRC's own parameters are provably right. Neither is invented here.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `rubicson_48659.c`, `klimalogg.c`, `inkbird_ith20r.c`,
 * `acurite_01185m.c`, `thermor.c`, `bresser_st1005h.c`, `oria_wa150km.c`, `thermor_a6n_132tx.c`,
 * `auriol_hg04641a.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addBytes, addNibbles, crc8, crc16lsb, parity8, reflect4, reflectBytes } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Sum of bytes at full width, without the byte narrowing the shared `addBytes` applies.
 *
 * Only one decoder here needs it, and it needs it for a specific reason: Acurite compares the low byte of
 * the sum against the frame's checksum, but then tests the *whole* sum against zero to throw out a row of
 * fifty-six zeros. A narrowed sum would make that second test fire on any frame summing to exactly 0x100,
 * which is a real frame with a checksum of zero, not silence.
 */
function sumBytesWide(m: Uint8Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += m[i];
  return s;
}

// ---------------------------------------------------------------------------
// Rubicson 48659 meat thermometer (133)
// ---------------------------------------------------------------------------

/**
 * A barbecue probe that reports in Fahrenheit and repeats itself relentlessly — twenty-five copies of the
 * same four bytes is normal, which is why ten matching rows are demanded before anything is believed.
 *
 * The checksum is unusual only in being stated backwards: the first three bytes summed, minus the fourth,
 * must come to 0xa6. Upstream stores that in a `uint8_t` before comparing, so the narrowing the shared
 * `addBytes` helper does is exactly right here rather than the hazard it is elsewhere. All nineteen
 * captures in the source file satisfy it.
 *
 * The temperature is where this decoder is wrong, and knowingly so. The layout documents a sign bit and
 * ten bits of magnitude, and the captures bear that out — the five sub-zero recordings all set the bit,
 * and negating their magnitude reproduces the Celsius readings written beside them. But the C reads
 * `sign ? -1 : 1 * magnitude`, and `*` binds tighter than `?:`, so the whole negative branch is the bare
 * constant -1: every reading below freezing is reported as -1 °F regardless of what the sensor sent. That
 * is reproduced here rather than silently corrected, because a decoder that quietly disagrees with its
 * source is worse than one that is faithfully broken, and the test spells out both the value upstream
 * produces and the value the bits actually carry.
 */
export const rubicson48659: RDevice = register({
  num: 133,
  name: 'Rubicson 48659 Thermometer',
  what: 'meat thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 940,
  longWidth: 1900,
  gapLimit: 2000,
  resetLimit: 4000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(10, 32);
    if (row < 0) return DECODE_ABORT_EARLY;

    // Upstream re-checks the width even though the search already guaranteed 32; kept, since it is what
    // rules out the 34-bit rows a marginal capture produces.
    if (bits.bitsPerRow[row] > 33 || bits.bitsPerRow[row] < 10) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];

    if (((addBytes(b, 3) - b[3]) & 0xff) !== 0xa6) return DECODE_FAIL_MIC;

    // The precedence bug, reproduced exactly: the negative branch is the constant, not the negation.
    const tempF = ((b[1] & 0x04) >> 2) ? -1 : 1 * (((b[1] & 0x03) << 8) | b[2]);

    ctx.emit({
      model: 'Rubicson-48659',
      type: 'Weather',
      id: b[0],
      temperature_F: round1(tempF),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Klimalogg Pro / 30.3180.IT (150)
// ---------------------------------------------------------------------------

/**
 * A logging thermometer whose whole transmission, sync word included, goes out bit-reflected.
 *
 * That reflection is why the preamble searched for is 0xb4 0x2b rather than the 0x2d 0xd4 the protocol
 * documents — the same two bytes seen the way they arrive. It also explains the odd order of the checks
 * below: the fixed 0x56 type byte is tested first, while the payload is still reflected, so it is compared
 * against 0x6a. Only once that cheap gate passes is the buffer turned the right way round and the CRC run.
 *
 * The humidity has a reserved value. 0x6a means the sensor is saturated or has nothing to report, and
 * upstream turns that into a flat 100%, which is a lossy but deliberate choice worth keeping identical.
 *
 * Upstream ships this one disabled, and so does this file. That flag does not switch the decoder off here;
 * it marks readings from it as doubtful, which is the right label for a protocol whose own source warns
 * that rtl_433's generic demodulator struggles with the signal.
 */
export const klimalogg: RDevice = register({
  num: 150,
  name: 'Klimalogg',
  what: 'logging thermometer and hygrometer',
  modulation: Modulation.OOK_NRZS,
  shortWidth: 26,
  longWidth: 0,
  gapLimit: 0,
  resetLimit: 1000,
  disabled: true,                                    // mirrors upstream's own flag
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 11 * 8) return DECODE_ABORT_LENGTH;

    const at = bits.search(0, 0, new Uint8Array([0xb4, 0x2b]), 16) + 16;
    // A miss returns the row length, so this same test also catches "no preamble at all".
    if (at + 9 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, at, 9 * 8);
    if (b[7] !== 0x6a) return DECODE_FAIL_SANITY;    // 0x56 as it arrives, still reflected

    reflectBytes(b, 9);
    if (crc8(b, 9, 0x31, 0x00) !== 0) return DECODE_FAIL_MIC;

    // Three BCD digits with a 40 °C offset, which is what lets the sensor cover -40 to +60 unsigned.
    const tempRaw = (b[2] & 0x0f) * 100 + (b[3] >> 4) * 10 + (b[3] & 0x0f);
    let humidity = b[4] & 0x7f;
    if (humidity === 0x6a) humidity = 100;           // the sensor's "saturated or unknown" code

    ctx.emit({
      model: 'Klimalogg-Pro',
      type: 'Weather',
      id: ((b[0] & 0x7f) << 8) | b[1],
      battery_ok: (b[5] & 0x80) ? 0 : 1,
      temperature_C: round1((tempRaw - 400) * 0.1),
      humidity,
      sequence_nr: (b[6] & 0xf0) >> 4,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Inkbird ITH-20R (194)
// ---------------------------------------------------------------------------

/**
 * A data logger with an optional second probe, sent as FSK behind fourteen thousand sync bits.
 *
 * Everything here is little-endian, which is unusual for this corpus and easy to read past: the
 * temperature, the second probe, the humidity and the CRC itself all put their low byte first.
 *
 * The CRC is a reflected CRC-16 with a non-standard starting value, and it is worth saying why this port
 * trusts it, because the file's own sample row does not satisfy it. The parameters are checkable
 * independently — the source states `check=0x3583`, the value the algorithm gives for the digits one
 * through nine, and running the polynomial and initial value quoted here over that string reproduces
 * 0x3583 exactly. So the arithmetic is right and the sample is not: its "Sample" column is a per-field
 * illustration assembled from more than one transmission, which the file half admits by describing a
 * temperature of 0xD200 in prose while listing 0xD600 in the column beside it. The test pins both facts.
 *
 * `battery_ok` carries a fraction rather than a flag here. That is upstream's choice — the sensor reports
 * a percentage, and the field is emitted as hundredths — and it is kept so the two agree field for field.
 */
export const inkbirdIth20r: RDevice = register({
  num: 194,
  name: 'Inkbird ITH-20R temperature humidity sensor',
  what: 'logging thermometer and hygrometer with a second probe',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 4000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 187) return DECODE_ABORT_LENGTH;

    const pos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0xaa, 0x2d, 0xd4]), 40);
    if (pos === bits.bitsPerRow[0]) return DECODE_FAIL_SANITY;

    const start = pos + 40;
    let len = bits.bitsPerRow[0] - start;
    if (((len + 7) / 8 | 0) < 19) return DECODE_ABORT_LENGTH;
    if (len > 19 * 8) len = 19 * 8;                  // anything past the message is noise

    // Nineteen bytes always, so the last byte reads as zero rather than as whatever C left on the stack.
    const msg = new Uint8Array(19);
    bits.extractBytes(0, start, msg, len);

    if (crc16lsb(msg, 16, 0xa001, 0x86f4) !== ((msg[17] << 8) | msg[16])) return DECODE_FAIL_MIC;

    const temperature = (((msg[11] << 8 | msg[10]) << 16) >> 16) * 0.1;
    const temperature2 = (((msg[13] << 8 | msg[12]) << 16) >> 16) * 0.1;

    ctx.emit({
      model: 'Inkbird-ITH20R',
      type: 'Weather',
      id: (msg[9] << 8) | msg[8],
      battery_ok: round2(msg[7] * 0.01),             // a level, not a flag — upstream's own field shape
      sensor_num: msg[4],                            // 2 once an external probe is plugged in
      temperature_C: round1(temperature),
      temperature_2_C: round1(temperature2),         // reads 130.0 when no second probe is attached
      humidity: round1(((msg[15] << 8) | msg[14]) * 0.1),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Acurite 01185M grill and meat thermometer (197)
// ---------------------------------------------------------------------------

/**
 * A two-probe barbecue thermometer: one reading for the meat, one for the grill around it.
 *
 * The line coding is doubly turned around — inverted, then reflected byte by byte — and the reflection
 * happens in place, on the buffer itself, exactly as upstream does it. That matters for a row that then
 * fails its checksum: the row stays reflected, and any decoder that runs afterwards sees it that way.
 * Faithfulness wins over tidiness here, because that is the behavior every other rtl_433 decoder is
 * calibrated against.
 *
 * The checksum is a plain sum with carry, and the sum is deliberately taken at full width. Upstream
 * narrows it only for the comparison against the frame's own byte, then tests the unnarrowed value
 * against zero to reject a row of fifty-six zeros — which would otherwise decode as a perfectly
 * self-consistent frame reading an id of zero, a channel of zero and a checksum of zero.
 *
 * Both probes can report out-of-range sentinels rather than temperatures: 7000 means the probe is
 * unplugged and 200 means it has failed, and the display shows E1 and E2 for those. Upstream emits each
 * temperature only when it is inside the range, so a frame can legitimately arrive with one probe
 * reporting and the other absent, and this does the same.
 */
export const acurite01185m: RDevice = register({
  num: 197,
  name: 'Acurite Grill/Meat Thermometer 01185M',
  what: 'grill and meat thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 840,
  longWidth: 2070,
  syncWidth: 6600,
  gapLimit: 3000,
  resetLimit: 6000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let result = 0;
    bits.invert();

    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] !== 56) { result = DECODE_ABORT_LENGTH; continue; }

      const b = bits.bb[row];
      reflectBytes(b, 7);                            // in place, as upstream does

      const sum = sumBytesWide(b, 6);
      if ((sum & 0xff) !== b[6]) { result = DECODE_FAIL_MIC; continue; }
      // Fifty-six zeros pass the checksum, so the full-width sum is what rules them out.
      if (sum === 0) return DECODE_FAIL_SANITY;

      const temp1Raw = (b[2] << 8) | b[3];
      const temp2Raw = (b[4] << 8) | b[5];
      const temp1Ok = temp1Raw > 200 && temp1Raw < 7000;
      const temp2Ok = temp2Raw > 200 && temp2Raw < 7000;

      ctx.emit({
        model: 'Acurite-01185M',
        type: 'Weather',
        id: b[0],
        // Not a switch on the case: the channel is picked by the sensor, and only 3, 6, 12 and 15 are seen.
        channel: b[1] & 0x0f,
        battery_ok: (b[1] >> 7) ? 0 : 1,
        ...(temp1Ok ? { temperature_1_F: round1((temp1Raw - 900) * 0.1) } : {}),
        ...(temp2Ok ? { temperature_2_F: round1((temp2Raw - 900) * 0.1) } : {}),
        mic: 'CHECKSUM',
      });
      return 1;
    }

    return result;
  },
});

// ---------------------------------------------------------------------------
// Thermor DG950 weather station (254)
// ---------------------------------------------------------------------------

/** Sixteen compass points, in the order the sensor's own four-bit code numbers them. */
const DG950_WIND_DIR = [157, 45, 135, 67, 180, 22, 112, 90, 225, 337, 247, 315, 202, 0, 270, 292];

/**
 * A four-part weather station — thermometer, wind vane, anemometer and rain gauge — that sends its whole
 * state as thirteen separate nine-bit bursts rather than one frame.
 *
 * Each burst is a start bit that must be zero followed by one reflected byte, so the demodulator hands
 * this decoder thirteen rows and the first thing it does is stitch them back into thirteen bytes. Getting
 * a row count of exactly thirteen is itself most of the framing check.
 *
 * Almost every field is sent inverted, and almost every field carries its own confirmation, which is what
 * makes a station this loosely framed trustworthy at all: the temperature's two halves are summed and
 * compared against a third byte, the rain count appears twice with an offset of seven between the copies,
 * the wind direction is sent twice identically, and the three wind-speed bytes are summed into a fourth.
 * A frame that satisfies all four of those is not an accident. The single capture the source ships
 * satisfies every one of them, which is what this port is pinned to.
 *
 * The temperature check is transcribed rather than tidied. Upstream adds one to a sum it has already
 * narrowed to a byte and compares that against a byte, so a sum of 0xff demands a check byte of 0x100 and
 * can never match. That is a real, if rare, blind spot, and it is kept.
 *
 * There is also a pairing broadcast, sent when the display is learning a sensor: the id byte goes to 0xff
 * and most of the rest of the frame repeats one value. It carries no reading, only the new id.
 */
export const thermorDg950: RDevice = register({
  num: 254,
  name: 'Thermor DG950 weather station',
  what: 'weather station with wind and rain sensors',
  modulation: Modulation.OOK_PWM,
  shortWidth: 680,
  longWidth: 2100,
  syncWidth: 1438,
  gapLimit: 3000,
  resetLimit: 8000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 13) return DECODE_ABORT_EARLY;

    const b = new Uint8Array(13);
    for (let row = 0; row < 13; row++) {
      if (bits.bitsPerRow[row] !== 9) return DECODE_ABORT_EARLY;
      if ((bits.bb[row][0] & 0x80) !== 0) return DECODE_ABORT_EARLY;   // the start bit must be zero
      b[row] = bits.bytes(row, 1, 8)[0];             // the eight bits after it
    }
    reflectBytes(b, 13);

    // The learning broadcast: id byte all ones, and one value repeated through most of the frame.
    if (b[0] === 0xff && b[1] === b[2] && b[1] === b[4] && b[1] === b[5]
      && b[1] === b[6] && b[1] === b[7] && b[1] === b[8] && b[1] === b[10]) {
      ctx.emit({
        model: 'Thermor-DG950',
        type: 'Weather',
        id: ~b[1] & 0xff,
        pairing: 1,
        mic: 'CHECKSUM',
      });
      return 1;
    }

    // Temperature: an integer part and a decimal part, each with its own offset, summed into a check byte.
    // The `+ 1` sits outside the narrowing upstream applied, so a sum of 0xff can never be confirmed.
    const tempChk = (b[1] + b[10]) & 0xff;
    if (tempChk + 1 !== b[3]) return DECODE_ABORT_EARLY;
    const tempC = (b[1] - 195) + (b[10] - 245) * 0.1;

    // Rain arrives twice, the second copy offset by seven.
    const rainRate = ~b[2] & 0xff;
    if (rainRate !== (~b[12] & 0xff) - 7) return DECODE_ABORT_EARLY;

    // Wind direction is present only when neither of its two copies is all ones, and they must agree.
    let windDir = -1;
    if (b[4] !== 0xff && b[5] !== 0xff) {
      if (b[4] !== b[5]) return DECODE_ABORT_EARLY;
      windDir = DG950_WIND_DIR[b[4] & 0x0f];
    }

    // Three wind bytes summed into a fourth, all of them inverted. The sum is taken on the C
    // complements rather than on `255 - x`, which agrees to the byte and keeps the transcription honest.
    const windChk = (~b[6] + ~b[7] + ~b[8]) & 0xff;
    if (windChk !== (~b[9] & 0xff)) return DECODE_ABORT_EARLY;

    let windKmh = -1;
    if (b[8] !== 0xff) {
      const speedRaw = (~b[6] & 0xff) | ((~b[7] & 0xff) << 8);
      const coef = ~b[8] & 0xff;
      // The cups are less linear at low speed, so a fitted slope is used below one full byte of count.
      const ratio = speedRaw < 256 ? (speedRaw * -0.0001746) + 0.155 : 0.11;
      windKmh = ratio * (speedRaw - coef + 45);
      if (windKmh < 0) windKmh = 0;
    }

    ctx.emit({
      model: 'Thermor-DG950',
      type: 'Weather',
      id: ~b[0] & 0xff,
      temperature_C: round1(tempC),
      rain_rate_mm_h: round1(rainRate * 0.1),
      ...(windDir >= 0 ? { wind_dir_deg: windDir } : {}),
      ...(windKmh >= 0 ? { wind_avg_km_h: round1(windKmh) } : {}),
      pairing: 0,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Bresser / Explore Scientific ST1005H (268)
// ---------------------------------------------------------------------------

/**
 * A three-channel thermometer and hygrometer sold as a Bresser with an Explore Scientific sticker under
 * the badge. A different sensor shares that same product name and is handled elsewhere entirely.
 *
 * The frame is thirty-eight bits, which is to say nothing is byte aligned: a mandatory zero bit comes
 * first, and everything after it is read from a copy shifted one bit left. The checksum is six bits, the
 * sum of the payload's nibbles, and the payload's last bit is part of it — hence the mask that clears
 * that bit before summing, so the sum does not include a fragment of its own answer.
 *
 * The nibble sum tops out at 120 over four bytes, comfortably inside a byte, so the shared helper's
 * narrowing cannot reach this decoder. The separate rejection of a zero sum is what keeps a silent
 * channel from decoding, since all-zero satisfies the checksum trivially.
 *
 * The temperature is signed twelve bits, and upstream extracts the sign by parking those bits at the top
 * of a sixteen-bit integer and shifting back down — the shift, not a comparison, is what extends the sign.
 * Reproduced literally; the test checks a sub-zero reading against a documented one.
 *
 * The same thirty-eight-bit shape is used by an Oregon Scientific hygrometer with a completely different
 * layout, and upstream notes that either decoder can occasionally claim the other's traffic. No priority
 * is set, because upstream sets none and nothing in the bits justifies inventing one.
 */
export const bresserSt1005h: RDevice = register({
  num: 268,
  name: 'Bresser Thermo-/Hygro-Sensor Explore Scientific ST1005H',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2500,
  longWidth: 4500,
  gapLimit: 4500,
  resetLimit: 10000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(3, 38);
    if (r < 0 || bits.bitsPerRow[r] > 38) return DECODE_ABORT_LENGTH;
    const b = bits.bb[r];

    if ((b[0] & 0x80) !== 0) return DECODE_FAIL_SANITY;   // the leading bit is always zero

    const msg = bits.bytes(r, 1, 32);
    msg[3] &= 0xfe;                                  // that last bit belongs to the checksum, not the payload

    const chk = b[4] >> 2;
    const sum = addNibbles(msg, 4);
    if (sum === 0) return DECODE_ABORT_EARLY;        // silence would otherwise check out perfectly
    if (chk !== (sum & 0x3f)) return DECODE_FAIL_MIC;

    // Twelve signed bits, top-aligned in sixteen so the shift back down extends the sign.
    const tempRaw = ((((msg[1] & 0x0f) << 12) | (msg[2] << 4)) << 16) >> 16;
    const tempC = (tempRaw >> 4) * 0.1;
    const channel = ((msg[1] >> 4) & 0x03) + 1;
    const humidity = msg[3] >> 1;                    // the display shows "HH" above 95

    if (channel >= 4 || humidity > 110 || tempC < -30 || tempC > 160) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Bresser-ST1005H',
      type: 'Weather',
      id: msg[0],
      channel,
      battery_ok: (msg[1] >> 7) ? 0 : 1,
      button: (msg[1] >> 6) & 0x01,                  // the TX button in the battery compartment
      temperature_C: round1(tempC),
      humidity,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Oria WA150KM freezer and fridge thermometer (288)
// ---------------------------------------------------------------------------

/** One four-bit nibble of a byte array, counting from the high nibble of byte zero. */
const oriaNibble = (m: Uint8Array, k: number) => (k % 2 === 0) ? (m[k >> 1] >> 4) & 0x0f : m[k >> 1] & 0x0f;

/**
 * A fridge and freezer probe that sends its temperature as decimal digits with a separate sign bit.
 *
 * The line coding is Manchester in the G. E. Thomas convention, which is the opposite polarity from the
 * one the shared decoder implements, so the buffer is inverted first and the standard routine then reads
 * it correctly. Two structural checks run before that, both on the raw pre-Manchester bits: a warm-up of
 * 0xaa bytes at the front, and 0x69 at the back. That trailing byte is not arbitrary — it is the low
 * nibble of the frame's fixed 0x65 terminator seen through the line code, which is a useful thing to know
 * when building a frame by hand.
 *
 * The checksum is an Oregon Scientific style nibble sum, and it runs on the buffer *before* the per-byte
 * reflection, with every nibble individually reflected as it is added. That is a roundabout way of saying
 * it is the sum of the decoded frame's own nibbles, which is how the test computes it independently.
 *
 * The priority of ten is upstream's, and it is there to let an Oregon Scientific THGR810 claim its own
 * transmissions before this decoder gets a look at them.
 */
export const oriaWa150km: RDevice = register({
  num: 288,
  name: 'Oria WA150KM freezer and fridge thermometer',
  what: 'freezer and fridge thermometer',
  modulation: Modulation.OOK_PCM,
  shortWidth: 490,
  longWidth: 490,
  gapLimit: 1500,
  resetLimit: 4000,
  priority: 10,                                      // let the Oregon THGR810 claim its own frames first
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const BITLEN = 227;

    let r = -1;
    for (let i = 0; i < bits.numRows; i++) if (bits.bitsPerRow[i] === BITLEN) { r = i; break; }
    if (r < 0) return DECODE_ABORT_LENGTH;

    // Both of these read the raw line, before Manchester decoding turns it into the frame.
    const raw = bits.bb[r];
    if (raw[0] !== 0xaa || raw[1] !== 0xaa || raw[2] !== 0xaa) return DECODE_ABORT_EARLY;
    if (raw[(BITLEN / 8 | 0) - 1] !== 0x69) return DECODE_ABORT_EARLY;

    bits.invert();                                   // G. E. Thomas is the inverse of the shared convention
    const mc = new BitBuffer();
    bits.manchesterDecode(r, 0, mc, BITLEN);

    // Fifteen reflected nibbles summed, against two more read as a byte low-nibble first.
    const m = mc.bb[0];
    let sum = 0;
    for (let i = 0; i < 15; i++) sum += reflect4(oriaNibble(m, 7 + i));
    const chkRecv = reflect4(oriaNibble(m, 22)) | (reflect4(oriaNibble(m, 23)) << 4);
    if ((sum & 0xff) !== chkRecv) return DECODE_FAIL_MIC;

    reflectBytes(m, (mc.bitsPerRow[0] + 7) >> 3);
    const b = m;

    // Two BCD digits for the whole part, one nibble for the tenth, and a sign bit off to the side.
    let temperature = ((b[8] >> 4) & 0x0f) * 10 + (b[8] & 0x0f) + ((b[7] >> 4) & 0x0f) * 0.1;
    if (b[9] & 0x08) temperature = -temperature;

    ctx.emit({
      model: 'Oria-WA150KM',
      type: 'Weather',
      id: b[6],
      channel: ((b[5] >> 4) & 0x0f) + 1,
      temperature_C: round1(temperature),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Thermor A6N 132TX (325)
// ---------------------------------------------------------------------------

/**
 * A plain thermometer with a checksum that changes shape depending on which sensor sent it.
 *
 * The low nibble is ordinary — the low nibbles of the three payload bytes, summed. The high nibble is not:
 * on an id of 4 it collapses to a single bit, the parity of the high-nibble sum plus the carry out of the
 * low one, with the three bits above it held at zero. On the other ids seen, 3 and 5, it is a parity bit
 * over selected fields sitting on top of a three-bit value that folds in that same carry.
 *
 * That is a strange rule and it would be easy to suspect the reverse engineering behind it, except that
 * all six sample frames the source publishes satisfy it exactly, across both variants and three different
 * ids. The test runs every one of them.
 *
 * The temperature is unsigned — this sensor has no way to express a reading below zero — and anything
 * above 250 °C is thrown out before the checksum is even considered.
 */
export const thermorA6n132tx: RDevice = register({
  num: 325,
  name: 'Thermor A6N 132TX temperature sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  gapLimit: 2000,
  resetLimit: 4000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 5) return DECODE_ABORT_LENGTH;

    const row = bits.findRepeatedRow(5, 32);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 32) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];

    const tempRaw = (b[1] << 8) | b[2];
    if (tempRaw > 2500) return DECODE_FAIL_SANITY;   // no reading above 250 C is real

    const loSum = (b[0] & 0x0f) + (b[1] & 0x0f) + (b[2] & 0x0f);
    const overflow = loSum >> 4;
    if ((loSum & 0x0f) !== (b[3] & 0x0f)) return DECODE_FAIL_MIC;

    const id = (b[0] >> 4) & 0x0f;
    const hiSum = (b[0] >> 4) + (b[1] >> 4) + (b[2] >> 4);
    const chkHi = b[3] >> 4;

    if (id === 4) {
      // One bit of answer, three bits of zero above it.
      if (chkHi !== ((hiSum + overflow) & 1)) return DECODE_FAIL_MIC;
    }
    else {
      const msb = parity8(b[0] & 0x0f) ^ parity8(b[1] & 0x0f) ^ parity8(b[2]);
      const low = (2 + (hiSum & 1)) ^ overflow;
      if (chkHi !== ((msb << 3) | low)) return DECODE_FAIL_MIC;
    }

    ctx.emit({
      model: 'Thermor-A6N132TX',
      type: 'Weather',
      id,
      channel: (b[0] >> 2) & 0x03,
      temperature_C: round1(tempRaw * 0.1),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Auriol HG04641A (357)
// ---------------------------------------------------------------------------

/**
 * A Lidl temperature station whose only integrity check is four bits wide.
 *
 * Four bits is not enough to keep other people's weather sensors out — upstream measured two dozen false
 * positives against its own test corpus — so two sanity checks carry most of the weight instead. The
 * flags nibble has one bit always set and two always clear in every capture anyone has recorded, and the
 * temperature is held to a range no real reading approaches. Upstream is candid that these are
 * mitigations rather than a fix, and that a channel nobody has tested could in principle be turned away
 * by the flags check. Both are kept exactly as written; neither is tightened or loosened here.
 *
 * The frame is thirty-six bits, nine nibbles, so the fifth byte carries only its top half and is shifted
 * down before use. The temperature is signed twelve bits, extended the same top-aligned way the Bresser
 * above uses, and the test checks a freezer reading rather than trusting the shift by eye.
 */
export const auriolHg04641a: RDevice = register({
  num: 357,
  name: 'Auriol HG04641A temperature station',
  what: 'thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 980,
  longWidth: 1976,
  gapLimit: 2500,
  resetLimit: 5000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 36);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] < 36) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(row, 0, 36);
    b[4] >>= 4;                                      // only the top nibble of the fifth byte is real

    const sum = addNibbles(b, 4);                    // eight nibbles, so at most 120 — no narrowing risk
    if ((sum & 0x0f) !== b[4]) return DECODE_FAIL_MIC;

    const flags = b[2] >> 4;
    // Bit 0 is set and bits 1-2 clear in every recorded capture; a free extra check on a very narrow CRC.
    if ((flags & 0x06) !== 0 || !(flags & 0x01)) return DECODE_FAIL_SANITY;

    const tempRaw = ((((b[2] & 0x0f) << 12) | (b[3] << 4)) << 16) >> 16;
    const tempDecic = tempRaw >> 4;                  // signed, in tenths of a degree
    if (tempDecic < -400 || tempDecic > 600) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Auriol-HG04641A',
      type: 'Weather',
      id: (b[0] << 8) | b[1],
      battery_ok: (flags & 0x08) ? 0 : 1,
      temperature_C: round1(tempDecic * 0.1),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});
