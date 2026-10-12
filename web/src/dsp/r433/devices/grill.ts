/**
 * Barbecue and food thermometers: nine boards that share a purpose and almost nothing else.
 *
 * These are the probes people leave in a joint of meat while the lid is down, so the thing they all have to do
 * is carry a temperature a long way through a metal box. Past that they diverge completely — four different
 * codings, temperatures in two different units, and integrity checks running from a proper CRC-16 down to
 * nothing whatsoever.
 *
 * Two of them are worth knowing about before trusting a reading. The Maverick ET-73x and XR-30 have **no
 * integrity check at all**: each carries a sixteen-bit digest, but the decoder exclusive-ors that digest into
 * the session id rather than comparing it against anything, so every frame of the right length and preamble is
 * accepted and a corrupted one simply reports under a different id. That is upstream's design, not an omission
 * here — the digest covers a device serial that is never transmitted, so there is nothing to check it against.
 * Both list a `mic` field they never populate, and this port does not invent one.
 *
 * Three of them report Fahrenheit on the wire (the GT-TMBBQ-05, the RF-T0912, and nothing else), and those are
 * left in the unit the sensor actually sent rather than being quietly converted.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/maverick_et73x.c`, `maverick_et73.c`, `gt_tmbbq05.c`,
 * `burnhardbbq.c`, `maverick_xr30.c`, `gasmate_ba1008.c`, `maverick_xr50.c`, `grill_thermometer.c` and
 * `typhur_sync_gold.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, crc16, lfsrDigest8Reflect, lfsrDigest16, parityBytes } from '../util.js';

const BANDS = [433920000];

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
/** C's `(int16_t)`: several of these read a temperature through a signed sixteen-bit intermediate. */
const s16 = (x: number) => ((x & 0xffff) << 16) >> 16;
const hex = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');

/**
 * A sum of nibbles taken at full width.
 *
 * `util.addNibbles` masks to a byte, which is right for the decoders that compare against one. These compare a
 * *nibble* of a running total, so the total is taken locally and unmasked to keep the two kinds of arithmetic
 * from being confused for one another.
 */
function sumNibbles(b: Uint8Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += (b[i] >> 4) + (b[i] & 0x0f);
  return s;
}

// ---------------------------------------------------------------------------------------------------------
// The Maverick family
// ---------------------------------------------------------------------------------------------------------

/**
 * The Maverick ET-732/733: two probes, sent as Manchester inside Manchester.
 *
 * The radio layer already slices Manchester, and what comes out of it is *another* Manchester-coded stream —
 * 104 half-bits carrying 52 real ones. The twelve-bit preamble is recognized in its still-coded form (0x55666a,
 * which decodes to 0xfa8) because that is cheaper than decoding a frame that was never ours.
 *
 * The digest is not a checksum: it covers a device serial the sensor never transmits, so it can only be turned
 * back into that serial, which is what the id is. It changes whenever the device is reset or the battery is
 * swapped, hence "session".
 */
export const maverickEt73x: RDevice = register({
  num: 71,
  name: 'Maverick ET-732/733 BBQ Sensor',
  what: 'barbecue thermometer, two probes',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 230,
  longWidth: 0,
  resetLimit: 4000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 104) return DECODE_ABORT_LENGTH;

    const raw = bits.bb[0];
    if (raw[0] !== 0x55 || raw[1] !== 0x66 || raw[2] !== 0x6a) return DECODE_ABORT_EARLY;

    const mc = new BitBuffer();
    bits.manchesterDecode(0, 0, mc, 104);
    // A short result means the inner coding broke down partway: some pair repeated a level.
    if (mc.bitsPerRow[0] < 52) return DECODE_FAIL_SANITY;
    const b = mc.bb[0];

    const flags = b[1] & 0x0f;
    const temp1 = (b[2] << 2) | ((b[3] & 0xc0) >> 6);
    const temp2 = ((b[3] & 0x3f) << 4) | ((b[4] & 0xf0) >> 4);
    const digest = ((b[4] & 0x0f) << 12) | (b[5] << 4) | (b[6] >> 4);

    // The 24 bits behind the preamble — the flags and both temperatures — are what the digest was taken over.
    const chk = mc.bytes(0, 12, 24);
    const id = lfsrDigest16(chk, 3, 0x8810, 0xdd38) ^ digest;

    ctx.emit({
      model: 'Maverick-ET73x',
      id,
      status: flags === 2 ? 'default' : flags === 7 ? 'init' : 'unknown',
      temperature_1_C: temp1 - 532,
      temperature_2_C: temp2 - 532,
    });
    return 1;
  },
});

/**
 * The plain Maverick ET-73, which shares the ThermoPro TP12's frame.
 *
 * Six bytes, of which only the first four mean anything known; the last two are unexplained and are not a
 * checksum, so repetition is the entire integrity check.
 */
export const maverickEt73: RDevice = register({
  num: 114,
  name: 'Maverick ET73',
  what: 'barbecue thermometer, two probes',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1050,
  longWidth: 2050,
  gapLimit: 2200,
  resetLimit: 4400,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 48);
    if (row < 0) return DECODE_ABORT_EARLY;
    const b = bits.bb[row];

    if ((!b[0] && !b[1] && !b[2] && !b[3])
      || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff)) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 48) return DECODE_ABORT_LENGTH;

    // Twelve bits each, two's complement. Left-aligning into sixteen bits and shifting back down is how the
    // sign gets extended without a special case for negatives.
    ctx.emit({
      model: 'Maverick-ET73',
      id: b[0],
      temperature_1_C: round1((s16((b[1] << 8) | (b[2] & 0xf0)) >> 4) * 0.1),
      temperature_2_C: round1((s16(((b[2] & 0x0f) << 12) | (b[3] << 4)) >> 4) * 0.1),
    });
    return 1;
  },
});

/**
 * The Maverick XR-30, the ET-73x moved onto frequency shift keying.
 *
 * The payload is identical in shape to the ET-73x — flags, two ten-bit temperatures, a session digest — but it
 * now rides behind a long run of alternating bits and a repeated sync word instead of an inner Manchester layer.
 *
 * The leading bit of that run is sometimes lost in reception, which shifts everything by one and turns the
 * first byte from 0xaa into 0x55. Rather than search for the sync word, the decoder reads the first byte to
 * decide which of the two alignments it is looking at, and extracts from bit seven or bit eight accordingly.
 */
export const maverickXr30: RDevice = register({
  num: 220,
  name: 'Maverick XR-30 BBQ Sensor',
  what: 'barbecue thermometer, two probes',
  modulation: Modulation.FSK_PCM,
  shortWidth: 360,
  longWidth: 360,
  resetLimit: 4096,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 104) return DECODE_ABORT_LENGTH;

    let b: Uint8Array;
    if (bits.bb[0][0] === 0x55) b = bits.bytes(0, 7, 12 * 8);        // leading bit dropped
    else if (bits.bb[0][0] === 0xaa) b = bits.bytes(0, 8, 12 * 8);   // received intact
    else return DECODE_ABORT_EARLY;

    if (b[0] !== 0xaa || b[1] !== 0xaa || b[2] !== 0xaa
      || b[3] !== 0xd3 || b[4] !== 0x91 || b[5] !== 0xd3 || b[6] !== 0x91) return DECODE_ABORT_EARLY;

    const flags = (b[7] & 0xf0) >> 4;
    const temp1 = ((b[7] & 0x0f) << 6) | ((b[8] & 0xfc) >> 2);
    const temp2 = ((b[8] & 0x03) << 8) | b[9];
    const digest = (b[10] << 8) | b[11];

    const id = lfsrDigest16(b, 3, 0x8810, 0x0d42, 7) ^ digest;

    ctx.emit({
      model: 'Maverick-XR30',
      id,
      status: flags === 0 ? 'default' : flags === 5 ? 'init' : 'unknown',
      temperature_1_C: temp1 - 532,
      temperature_2_C: temp2 - 532,
    });
    return 1;
  },
});

/** The sync word the XR-50 shares with the modern ThermoPro generation. */
const XR50_SYNC = new Uint8Array([0xd2, 0xaa, 0x2d, 0xd4]);

/**
 * The Maverick XR-50: four probes, each with its own temperature and a high and low target.
 *
 * Every probe occupies five bytes in the same layout, so the four are read in a loop rather than written out
 * four times. A socket with nothing plugged into it reports flags 0xf and a temperature of zero, and a zero
 * there means "no probe" rather than freezing point, so that reading is left out entirely.
 *
 * The length test looks unbalanced — it demands 184 bits from the start of the sync word but then extracts 184
 * bits from *after* it, so a frame 32 bits short of complete is still read. That is upstream's own arithmetic,
 * kept because those frames fail the CRC a moment later anyway, and because our rows carry slack past their end
 * so the over-read sees zeroes rather than running off.
 */
export const maverickXr50: RDevice = register({
  num: 281,
  name: 'Maverick XR-50 BBQ Sensor',
  what: 'barbecue thermometer, four probes with targets',
  modulation: Modulation.FSK_PCM,
  shortWidth: 107,
  longWidth: 107,
  resetLimit: 2200,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY;
    const n = bits.bitsPerRow[0];

    const at = bits.search(0, 0, XR50_SYNC, 32);
    if (at >= n) return DECODE_ABORT_LENGTH;
    if (n - at < 184) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, at + 32, 23 * 8);
    // The CRC covers its own byte, so a good frame folds down to zero.
    if (crc8(b, 23, 0x31, 0x00)) return DECODE_FAIL_MIC;

    const data: R433Data = {
      model: 'Maverick-XR50',
      id: hex((b[0] << 8) | b[1], 4),
      mic: 'CRC',
    };
    for (let p = 0; p < 4; p++) {
      const o = 2 + p * 5;
      const tempRaw = ((b[o] & 0x0f) << 8) | b[o + 1];
      data[`probe_${p + 1}_flags`] = hex((b[o] & 0xf0) >> 4, 1);
      if (tempRaw !== 0) data[`temperature_${p + 1}_C`] = round1((tempRaw - 500) * 0.1);
      data[`setpoint_high_${p + 1}_C`] = round1((((b[o + 2] << 4) | ((b[o + 3] & 0xf0) >> 4)) - 500) * 0.1);
      data[`setpoint_low_${p + 1}_C`] = round1(((((b[o + 3] & 0x0f) << 8) | b[o + 4]) - 500) * 0.1);
    }
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------------------------------------

/**
 * The Globaltronics Quigg GT-TMBBQ-05, sold by Aldi in Germany. One probe, no channel, no configuration.
 *
 * The frame is 33 bits, and the leading one is a constant zero whose only purpose is to spoil the byte
 * alignment, so it is dropped before anything else happens.
 *
 * Its two checks disagree with upstream's own description. The doc comment calls the bit at 0x10 "an odd parity
 * bit" and the failure message says the check "should be ODD", but the code demands `parity_bytes(...) == 0` —
 * that is **even** parity, over the first 28 bits (three whole bytes plus the high nibble of the fourth, which
 * is where the parity bit itself lives). All eleven frames recorded in that comment have even parity, so the
 * code is right and the prose around it is wrong.
 *
 * The temperature is Fahrenheit with 90 added, and is reported in Fahrenheit rather than converted.
 */
export const gtTmbbq05: RDevice = register({
  num: 137,
  name: 'Globaltronics QUIGG GT-TMBBQ-05',
  what: 'barbecue thermometer, one probe',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 4200,
  resetLimit: 9100,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(5, 33);
    if (r < 0 || bits.bitsPerRow[r] !== 33) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(r, 1, 32);                    // drop the constant leading bit
    if (!b[0] && !b[1] && !b[2] && !b[3]) return DECODE_FAIL_SANITY;

    // Even parity across everything up to and including the parity bit itself.
    if (parityBytes(Uint8Array.of(b[0], b[1], b[2], b[3] & 0xf0), 4)) return DECODE_FAIL_MIC;

    const sum = sumNibbles(b, 3) + (b[3] >> 4);
    if ((sum & 0x0f) !== (b[3] & 0x0f)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'GT-TMBBQ05',
      id: (b[0] << 8) | b[2],
      // Ten bits split across the frame: the low eight in byte one, the top two in the last byte.
      temperature_F: (((b[3] & 0xc0) << 2) | b[1]) - 90,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

const BURNHARD_MEAT = ['free', 'beef', 'veal', 'pork', 'chicken', 'lamb', 'fish', 'ham'];
const BURNHARD_TASTE = ['rare', 'medium rare', 'medium', 'medium well', 'well done'];

/**
 * The Burnhard barbecue thermometer, which reports rather more than a temperature.
 *
 * As well as the probe reading and its target it carries a countdown timer, which cut of meat is on the probe
 * and how well done it is wanted — the base station's whole user interface, put on the air.
 *
 * The frame is sent inverted, and the last of its 81 bits is a coding artefact rather than data. A probe that
 * is not plugged in reads exactly zero, which would otherwise be reported as -50 °C, so that case is dropped.
 *
 * Every row carries the same message, so the first one that passes its digest wins; the reason for reporting
 * the *last* failure rather than the first is that it says why nothing was accepted.
 */
export const burnhardbbq: RDevice = register({
  num: 177,
  name: 'Burnhard BBQ thermometer',
  what: 'barbecue thermometer with a timer and a target',
  modulation: Modulation.OOK_PWM,
  shortWidth: 240,
  longWidth: 484,
  syncWidth: 840,
  resetLimit: 848,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();

    let ret: number = DECODE_FAIL_OTHER;
    for (let i = 0; i < bits.numRows; i++) {
      const n = bits.bitsPerRow[i];
      if (n < 80 || n > 81) { ret = DECODE_ABORT_LENGTH; continue; }
      const b = bits.bb[i];

      if (b[0] === 0 && b[9] === 0) { ret = DECODE_ABORT_EARLY; continue; }
      if (lfsrDigest8Reflect(b, 9, 0x31, 0xf4) !== b[9]) { ret = DECODE_FAIL_MIC; continue; }

      const setpointRaw = ((b[7] & 0x0f) << 8) | b[6];
      const tempRaw = ((b[7] & 0xf0) << 4) | b[8];
      const meat = BURNHARD_MEAT[b[5] >> 4] ?? '';
      const taste = BURNHARD_TASTE[b[5] & 0x0f] ?? '';

      const data: R433Data = {
        model: 'BurnhardBBQ',
        id: b[0],
        channel: b[1] & 0x07,
        setpoint_C: round1((setpointRaw - 500) * 0.1),
        temperature_alarm: b[1] & 0x80 ? 1 : 0,
        // Minutes and seconds, each as two decimal digits packed into a byte.
        timer: `${hex(b[3], 2)}:${hex(b[4] & 0x7f, 2)}`,
        timer_active: b[1] & 0x10 ? 1 : 0,
        timer_alarm: b[1] & 0x40 ? 1 : 0,
      };
      if (tempRaw !== 0) data.temperature_C = round1((tempRaw - 500) * 0.1);
      if (meat) data.meat = meat;
      if (taste) data.taste = taste;
      ctx.emit(data);
      return 1;
    }
    return ret;
  },
});

/**
 * The Gasmate BA1008 meat thermometer.
 *
 * Four bytes, and remarkably little in them: no identity, no channel, and twelve bits nobody has explained. The
 * temperature is three decimal digits and a sign, and the check is that the sixteen nibbles of the frame add up
 * to something ending in 0x0c — a constant rather than a computed value, which is as weak as it sounds and is
 * why the fixed 0xf preamble nibble is checked as well.
 */
export const gasmateBa1008: RDevice = register({
  num: 236,
  name: 'Gasmate BA1008 meat thermometer',
  what: 'meat thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 536,
  longWidth: 1668,
  resetLimit: 2000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_LENGTH;
    if (bits.bitsPerRow[0] !== 32) return DECODE_ABORT_LENGTH;
    const b = bits.bb[0];

    // The fixed nibble, and the unexplained flag bit beside it, which is always clear.
    if ((b[0] & 0xf8) !== 0xf0) return DECODE_ABORT_EARLY;
    if ((sumNibbles(b, 4) & 0x0f) !== 0x0c) return DECODE_FAIL_MIC;

    const raw = (b[0] & 0x03) * 100 + ((b[1] & 0xf0) >> 4) * 10 + (b[1] & 0x0f);
    ctx.emit({
      model: 'Gasmate-BA1008',
      temperature_C: (b[0] & 0x04) >> 2 ? -raw : raw,
      unknown_1: hex((b[2] << 4) | (b[3] >> 4), 3),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/**
 * An unbranded grill thermometer, known only by its FCC identifier: the RF-T0912.
 *
 * There is no model or maker in the frame, and no identity either — just a temperature and a sum of its two
 * bytes, repeated ten times. Three bytes with an eight-bit check is thin enough that a good many other
 * transmissions would satisfy it, which is why this runs at a lowered priority and why it insists on seeing the
 * same value twice before believing it.
 *
 * The temperature is Fahrenheit and signed, and one particular value is not a temperature at all: -1029 is the
 * probe reporting that it is over range, so that is passed on as an overload rather than as a reading.
 */
export const grillThermometer: RDevice = register({
  num: 331,
  name: 'RF-T0912 Grill Thermometer',
  what: 'grill thermometer with a probe',
  modulation: Modulation.OOK_PWM,
  shortWidth: 252,
  longWidth: 736,
  gapLimit: 5000,
  resetLimit: 8068,
  syncWidth: 980,
  priority: 10,                                        // thin frame, easily claimed by accident
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();

    let tempF = 0;
    let repeats = 0;
    for (let row = 0; row < bits.numRows; row++) {
      const r = bits.bb[row];
      const checksum = (r[0] + r[1]) & 0xff;
      // A zero checksum means an empty row, not a reading, so it never counts as a repeat.
      if (bits.bitsPerRow[row] !== 24 || checksum !== r[2] || checksum === 0) continue;

      const value = s16((r[0] << 8) | r[1]);
      if (tempF !== value) { tempF = value; repeats = 0; }
      else repeats++;
    }
    if (repeats < 1) return DECODE_ABORT_EARLY;

    const overload = tempF === -1029 ? 1 : 0;
    const data: R433Data = { model: 'RF-T0912', overload, mic: 'CHECKSUM' };
    if (!overload) data.temperature_F = tempF;
    ctx.emit(data);
    return 1;
  },
});

/** Two bytes of sync, all this one gets in the way of a preamble marker. */
const TYPHUR_SYNC = new Uint8Array([0x57, 0x54]);

/**
 * The Typhur Sync Gold, a wireless probe with five sensors down its length.
 *
 * The five readings are not five probes but five points along one — a spit through a joint of meat measures the
 * gradient from the surface to the middle — plus a separate, coarser ambient sensor reading the air around it.
 * The five fine readings come in hundredths of a degree, the ambient one in tenths.
 *
 * Everything multi-byte here is little-endian, which is unusual in this collection: the identifier is the one
 * field read the other way round.
 *
 * This is the best-checked device in the file — a real CRC-16 over the whole payload — and upstream records
 * that it was verified against nineteen captures from two physical probes rather than a single sample.
 */
export const typhurSyncGold: RDevice = register({
  num: 377,
  name: 'Typhur Sync Gold meat thermometer probe',
  what: 'wireless meat probe, five points and ambient',
  modulation: Modulation.FSK_PCM,
  shortWidth: 13,
  longWidth: 13,
  resetLimit: 3000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    for (let row = 0; row < bits.numRows; row++) {
      const n = bits.bitsPerRow[row];
      let pos = bits.search(row, 0, TYPHUR_SYNC, 16);
      if (pos >= n) continue;
      pos += 16;
      if (n - pos < 24 * 8) continue;

      const b = bits.bytes(row, pos, 24 * 8);
      if (crc16(b, 22, 0x8005, 0x0000) !== ((b[22] << 8) | b[23])) continue;

      const le = (at: number) => b[at] | (b[at + 1] << 8);
      const data: R433Data = {
        model: 'Typhur-SyncGold',
        id: hex((b[0] << 16) | (b[1] << 8) | b[2], 6),
        in_base: (b[4] & 0x08) !== 0 ? 1 : 0,
        counter: le(20),
        battery_V: round2(le(18) * 0.01),
        ambient_C: round1(le(16) * 0.1),
        mic: 'CRC',
      };
      for (let i = 0; i < 5; i++) data[`temperature_${i + 1}_C`] = round2(le(6 + i * 2) * 0.01);
      ctx.emit(data);
      return 1;
    }
    return DECODE_FAIL_MIC;
  },
});
