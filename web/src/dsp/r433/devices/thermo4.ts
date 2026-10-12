/**
 * Five sensors that measure something and say so: a temperature and humidity puck, a soil probe, an outdoor
 * thermometer, and two cooking thermometers with probes on leads.
 *
 * They are grouped by what they are for rather than how they work, because they share almost nothing. Three
 * of them are worth a note.
 *
 * The WEC-2103 has a checksum that is mangled on purpose: the CRC is computed over a frame with one nibble
 * swapped out for another taken from further along, and then exclusive-ored with a third. None of that is
 * reconstruction on this side — it is what the sensor does, and it is why a straight CRC over the frame never
 * matches. It also carries an upstream defect that is preserved here and described where it occurs.
 *
 * The Homelead soil probe is the only one of the five with published radio, and its two example rows are
 * labelled as one capture shown raw and inverted. They are not: they are two different transmissions from two
 * different sensors, and both independently satisfy the device's own checksum. The tests assert both.
 *
 * The WallarGe thermometer checks itself twice over — a byte sum and a parity byte whose bits are the
 * *inverse* of the usual convention, with three bits that must be zero. Upstream reports a battery field only
 * when the battery is low, so the field appears exclusively with the value zero; that is odd but faithful.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `wec2103.c`, `homelead_hg9901.c`, `wallarge_cltx001.c`,
 * `esun_en2053.c`, `en2058.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, addNibbles, crc4, parity8 } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// WEC-2103 temperature and humidity sensor (229)
// ---------------------------------------------------------------------------

/**
 * A supermarket weather-station sensor, close kin to the Prologue and Esperanza boards.
 *
 * Its checksum is deliberately awkward. The four-bit CRC is not computed over the frame as sent: the nibble
 * holding the CRC is first replaced by the low nibble of the last byte, and the result is then exclusive-ored
 * with that byte's high nibble. Reproducing that exactly is the whole difficulty of this decoder.
 *
 * The battery field is a defect kept for faithfulness. Upstream masks bit two and then shifts right by three,
 * which cannot yield anything but zero for any byte, so a low battery is never reported. The intended shift
 * was plainly two. The behaviour is preserved and pinned by a test rather than quietly corrected, because a
 * decoder that disagrees with its source is harder to audit than one that is faithfully wrong.
 */
export const wec2103: RDevice = register({
  num: 229,
  name: 'WEC-2103 temperature/humidity sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1900,
  longWidth: 3800,
  gapLimit: 4400,
  resetLimit: 9400,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The transmission has a fixed shape, and the reading is always in the fourth row.
    if (bits.numRows !== 6 || bits.bitsPerRow[2] !== 42) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(3, 0, 40);
    const crcReceived = b[1] >> 4;
    b[1] = (b[1] & 0x0f) | ((b[4] & 0x0f) << 4);   // the CRC nibble is stood in for before the check
    const crcCalculated = crc4(b, 4, 3, 0) ^ (b[4] >> 4);
    if (crcCalculated !== crcReceived) return DECODE_FAIL_MIC;

    const tempRaw = (b[2] << 4) | ((b[3] & 0xf0) >> 4);

    ctx.emit({
      model: 'WEC-2103',
      type: 'Weather',
      id: b[0],
      channel: b[4] & 0x0f,
      // Always one: upstream's mask and shift cannot agree, so a flat battery is never reported.
      battery_ok: ((b[1] & 0x04) >> 3) ? 0 : 1,
      button: (b[1] & 0x08) >> 3,
      temperature_F: round2((tempRaw - 900) * 0.1),
      humidity: (b[3] & 0x0f) * 10 + ((b[4] & 0xf0) >> 4),
      flags: b[1] & 0x0f,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Homelead HG9901 soil moisture, temperature and light sensor (280)
// ---------------------------------------------------------------------------

/** Rough lux figures for the nine light steps the sensor reports; anything above eight is undefined. */
const HOMELEAD_LUX = [60, 200, 400, 600, 1000, 1500, 2800, 4500, 10000, -1, -1, -1, -1, -1, -1, -1];

/**
 * A garden spike sold under a dozen names, reporting soil moisture, temperature and how bright it is.
 *
 * The run-in is searched before the frame is turned over and read after, which is why the pattern looked for
 * is the inverse of what ends up in the bytes. Its checksum is a four-bit nibble sum, which is weak enough
 * that the sensor itself is documented to skip a transmission when a changed reading happens to collide.
 *
 * Upstream turns the buffer back over on the way out, under a comment marking it a debugging workaround for
 * an unrelated accounting bug. That is not carried across: every decoder here is handed a freshly sliced
 * buffer that is cleared afterwards, so the re-inversion would have no observable effect either way.
 */
export const homeleadHg9901: RDevice = register({
  num: 280,
  name: 'Homelead HG9901 (Geevon, Dr.Meter, Royal Gardineer) soil moisture/temp/light level sensor',
  what: 'soil moisture, temperature and light sensor',
  modulation: Modulation.OOK_PWM,
  shortWidth: 432,
  longWidth: 1228,
  gapLimit: 2000,
  resetLimit: 4500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(1, 65);       // a dozen repeats are sent; one is enough
    if (row < 0) return DECODE_ABORT_EARLY;

    const rowLen = bits.bitsPerRow[row];
    if (rowLen > 65 + 8) return DECODE_ABORT_EARLY;

    // Searched the way it arrives, read the way it ends up.
    const pos = bits.search(row, 0, new Uint8Array([0x55, 0xaa]), 16);
    if (pos + 65 > rowLen) return DECODE_ABORT_LENGTH;

    bits.invert();
    const b = bits.bb[row];

    // Fourteen nibbles, so at most 210 — under the byte the shared helper narrows to.
    if ((addNibbles(b, 7) & 0x0f) !== ((b[7] & 0xf0) >> 4)) return DECODE_FAIL_MIC;

    const temperature = (b[5] & 0x80) ? -(b[5] & 0x7f) : (b[5] & 0x7f);
    const battery = (b[6] & 0x30) >> 4;
    const light = b[6] & 0x0f;

    ctx.emit({
      model: 'Homelead-HG9901',
      type: 'Weather',
      id: ((b[2] << 8) | b[3]).toString(16).padStart(4, '0').toUpperCase(),
      battery_ok: battery > 1 ? 1 : 0,             // level one is the sensor's own "low" mark
      battery_pct: Math.trunc(100 * battery / 3),
      temperature_C: temperature,
      moisture: b[4],
      light_lvl: light,
      light_lux: HOMELEAD_LUX[light],
      sequence: (b[6] & 0xc0) >> 6,                // which of the four transmit intervals it is using
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// WallarGe CLTX001 outdoor temperature sensor (292)
// ---------------------------------------------------------------------------

/**
 * An outdoor thermometer that pairs with a range of clocks, and checks itself twice.
 *
 * Its line coding is the other way up from what the slicer produces, so each candidate row is turned over in
 * place before anything is read. Then a byte sum has to match, and a parity byte has to agree with all five
 * data bytes — but inverted from the usual sense, a set bit meaning an *even* number of ones. Three bits of
 * that byte must also be zero, which the paired clock apparently insists on too.
 *
 * The battery field only appears when the battery is low, so in practice it is only ever reported as zero.
 * That is upstream's shape and it is kept, since inventing a cheerful "battery fine" for every frame would be
 * claiming something the sensor never actually said.
 */
export const wallargeCltx001: RDevice = register({
  num: 292,
  name: 'WallarGe CLTX001 Outdoor Temperature Sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 250,
  longWidth: 500,
  tolerance: 75,
  gapLimit: 650,
  resetLimit: 1250,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let result: number = DECODE_ABORT_LENGTH;

    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] !== 56) continue;   // partial rows are left alone

      const b = bits.bb[row];
      for (let i = 0; i < 7; i++) b[i] = (~b[i]) & 0xff;

      if (b[6] !== (addBytes(b, 5) & 0xff)) { result = DECODE_FAIL_MIC; continue; }

      const parityByte = b[5];
      let parityValid = true;
      if (parityByte & 0x07) {
        parityValid = false;                       // the low three bits are always zero on a real frame
      }
      else {
        for (let i = 0; i < 5; i++) {
          // The protocol's bit is the inverse of odd parity, so agreement is a failure.
          if (parity8(b[i]) === ((parityByte >> (7 - i)) & 1)) { parityValid = false; break; }
        }
      }
      if (!parityValid) { result = DECODE_FAIL_MIC; continue; }

      const batteryLow = (b[3] & 0x80) >> 7;
      const testMode = (b[3] & 0x40) >> 6;
      const tempRaw = ((((b[3] & 0x0f) << 12) | (b[4] << 4)) << 16) >> 16;

      const out: R433Data = {
        model: 'WallarGe-CLTX001',
        type: 'Weather',
        id: (b[0] << 8) | b[1],
        channel: ((b[3] & 0x30) >> 4) + 1,         // three channels, though a fourth appears mid-change
        temperature_C: round1((tempRaw >> 4) * 0.1),
        mic: 'CHECKSUM',                           // strictly a checksum and a parity byte
      };
      if (batteryLow) out.battery_ok = 0;
      if (testMode) out.test = testMode;
      ctx.emit(out);

      result = 1;
      break;
    }
    return result;
  },
});

// ---------------------------------------------------------------------------
// Esun EN2053 two-channel barbecue thermometer (341)
// ---------------------------------------------------------------------------

/**
 * A two-probe cooking thermometer whose check byte carries two different things at once.
 *
 * Its low three bits are the frame's byte sum taken modulo eight, and its top four are one parity flag per
 * data byte — set when that byte holds an *even* number of ones. Both halves have to agree.
 *
 * A probe that is not plugged in reads a fixed sentinel rather than a temperature, so that channel is simply
 * not reported. Everything is in Fahrenheit regardless of what the display is set to.
 */
export const esunEn2053: RDevice = register({
  num: 341,
  name: 'Esun EN2053 two-channel BBQ thermometer',
  what: 'barbecue thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1024,
  longWidth: 2000,
  gapLimit: 3000,
  resetLimit: 7500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 40);       // nine repeats are sent; two matching is the bar
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 40) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    if (b[0] !== 0xc0) return DECODE_FAIL_SANITY;

    // Narrowing the sum to three bits makes the byte mask irrelevant here.
    let chk = (b[0] + b[1] + b[2] + b[3]) & 0x07;
    for (let i = 0; i < 4; i++) chk |= (1 ^ parity8(b[i])) << (4 + i);
    if (chk !== b[4]) return DECODE_FAIL_MIC;

    const temp1 = (b[1] << 4) | (b[2] >> 4);
    const temp2 = ((b[2] & 0x0f) << 8) | b[3];

    const out: R433Data = { model: 'Esun-EN2053', type: 'Weather', mic: 'CHECKSUM' };
    if (temp1 !== 0xfd6) out.temperature_1_F = temp1;   // 0xfd6 marks a probe that is not plugged in
    if (temp2 !== 0xfd6) out.temperature_2_F = temp2;
    ctx.emit(out);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// EN2058 four-probe temperature sensor (346)
// ---------------------------------------------------------------------------

/**
 * Four cooking probes on one transmitter, sent nine times over with no gap between repeats.
 *
 * Because the repeats run together, they are not separate rows — the decoder walks a single long row looking
 * for the next run-in each time, so a repeat spoiled in the air costs nothing as long as a later one survives.
 * That is also why the checksum failing moves on to the next repeat rather than rejecting the burst.
 *
 * The sum that checks a repeat runs over the identifier and the temperatures together with a fixed constant.
 * It is narrowed to a byte at the end, and narrowing the parts first gives the same answer, so the shared
 * helper is the right one here.
 */
export const en2058: RDevice = register({
  num: 346,
  name: 'EN2058 four probe temperature sensor',
  what: 'barbecue thermometer',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 4000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 174) return DECODE_ABORT_LENGTH;

    const preamble = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
    let offset = 0;

    for (let i = 0; i < 9; i++) {
      offset = bits.search(0, offset, preamble, 30);
      if (offset >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
      offset += 30;

      const idBytes = bits.bytes(0, offset + 56, 24);
      const dataBytes = bits.bytes(0, offset + 80, 80);
      const checksum = (0x56 + addBytes(idBytes, 3) + addBytes(dataBytes, 8)) & 0xff;
      if (checksum !== dataBytes[9]) continue;     // try the next repeat instead of giving up

      const probe = (n: number) => round1((((dataBytes[n * 2] << 8) | dataBytes[n * 2 + 1]) - 900) / 10);

      const out: R433Data = {
        model: 'EN2058',
        type: 'Weather',
        id: (idBytes[0] << 16) | (idBytes[1] << 8) | idBytes[2],
        temperature1_F: probe(0),
        temperature2_F: probe(1),
        temperature3_F: probe(2),
        temperature4_F: probe(3),
        mic: 'CHECKSUM',
      };
      // The counter sits well past the reading, so a repeat cut short simply does not carry one.
      if (offset + 320 <= bits.bitsPerRow[0]) out.sequence = bits.bytes(0, offset + 304, 16)[0];
      ctx.emit(out);
      return 1;
    }
    return DECODE_FAIL_MIC;
  },
});
