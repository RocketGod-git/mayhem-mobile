/**
 * Energy monitors: a solar clamp, a household display, a car battery sensor, and two utility meters.
 *
 * These have almost nothing in common beyond measuring power, which is why they are grouped by what they are
 * for rather than by how they work. Two of them are worth a note.
 *
 * The GEO minim+ is really two protocols behind one registration. The sensor clamp and the display unit send
 * the same framing with different payload lengths — five bytes from the clamp, forty-two from the display —
 * and the length byte in the header is what picks the reader. The display's payload carries a date counted in
 * days from the first of January 2007, which upstream normalizes by handing an over-large day number to
 * `mktime` and letting the C library roll it into a real calendar date. That call also applies the machine's
 * local timezone and daylight saving, which upstream's own comment flags as a hazard; the arithmetic here is
 * done in UTC instead, so the same bits give the same answer on every machine.
 *
 * The Elster meters are the odd ones. They hop across twenty-five channels, so a fixed receiver only ever
 * catches a fraction of what they send, and the preamble collapses to a variable number of bits depending on
 * how the burst was heard. Rather than trust a sync offset, both decoders take the whole row and try every
 * single bit position, treating the first byte as a length and asking whether a CRC-16/X-25 lands where that
 * length says it should. A sixteen-bit check makes a false positive unlikely enough to be worth the search.
 * The two types share that idea and almost nothing else: type-1 is Manchester coded and whitened with 0x55,
 * type-2 is not Manchester coded at all, is whitened with 0xaa, carries a sixteen-bit length, and runs four
 * times faster.
 *
 * Most of what the Elster meters carry is undecoded, and it is reported as raw hex rather than guessed at.
 * Where upstream marks a field speculative, that judgement is kept.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `ecodhome.c`, `geo_minim.c`, `bm5.c`, `elster_power_meter.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, crc16, crc16lsb } from '../util.js';

const BAND_433 = [433920000];
const BAND_868 = [868290000];
/** The Elster meters hop across 902.4-927.6 MHz; a fixed receiver sits in the middle of that. */
const BAND_915 = [915000000];

const round2 = (x: number) => Math.round(x * 100) / 100;
const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hexOf = (b: Uint8Array, from: number, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += hex2(b[from + i]);
  return s;
};

/** One byte read at an arbitrary bit offset, MSB first — rtl_433's `bitrow_get_byte`. */
function bitrowGetByte(row: Uint8Array, pos: number): number {
  return (((row[pos >> 3] << 8) | row[(pos >> 3) + 1]) >> (8 - (pos & 7))) & 0xff;
}

// ---------------------------------------------------------------------------
// EcoDHOME Smart Socket and MCEE Solar monitor (174)
// ---------------------------------------------------------------------------

/**
 * Two devices on one protocol: a clamp that reports what the house is drawing, and a switchable socket.
 *
 * They are told apart by a message type halfway through the frame, and they do not even checksum the same
 * way — the socket sums eleven bytes, the transmitter sums nine and adds a constant. Both comparisons are
 * against a single byte, so narrowing the sum is correct here; for the transmitter it is correct for a subtler
 * reason too, since adding a constant to a sum commutes with taking it modulo 256.
 *
 * The power reading is stored oddly on the transmitter: two bytes that each count up from 0x33 rather than
 * from zero, and wrap. Subtracting the bias inside a byte is what puts them back in order.
 */
export const ecodhome: RDevice = register({
  num: 174,
  name: 'EcoDHOME Smart Socket and MCEE Solar monitor',
  what: 'household energy monitor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 250,
  longWidth: 250,
  resetLimit: 6000,
  // Upstream records no frequency for this one, so none is claimed here.
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH;

    let start = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]), 32);
    start += 32;
    if (start >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    if (start + 12 * 8 >= bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    const msg = bits.bytes(0, start, 13 * 8);
    const id = ((((msg[0] << 24) >>> 0) | (msg[1] << 16) | (msg[2] << 8) | msg[3]) >>> 0);
    const mType = (msg[4] << 8) | msg[5];

    if (mType === 0x7700) {
      if (addBytes(msg, 11) !== msg[11]) return DECODE_FAIL_MIC;
      if (msg[10] !== 0x53) return DECODE_FAIL_SANITY;

      const subtype = (msg[6] << 8) | msg[7];
      const out: R433Data = {
        model: 'EcoDHOME-SmartSocket',
        type: 'Energy',
        id,
        message_type: mType,
        message_subtype: subtype,
        raw: (msg[8] << 8) | msg[9],
        mic: 'CHECKSUM',
      };
      // Only one subtype is known to carry a power value; the rest are unread.
      if (subtype === 0x414b) out.power_W = (msg[9] << 8) | msg[8];
      ctx.emit(out);
      return 1;
    }

    // The transmitter's sum is over nine bytes plus a fixed 0x35.
    if (((addBytes(msg, 9) + 0x35) & 0xff) !== msg[9]) return DECODE_FAIL_MIC;
    if (msg[10] !== 0x55) return DECODE_FAIL_SANITY;
    if (msg[11] !== 0x00) return DECODE_FAIL_SANITY;

    const out: R433Data = {
      model: 'EcoDHOME-Transmitter',
      type: 'Energy',
      id,
      message_type: mType,
      raw: (((msg[6] << 16) | (msg[7] << 8) | msg[8]) >>> 0),
      mic: 'CHECKSUM',
    };
    // Both halves count up from 0x33 and wrap, so the bias comes off inside a byte.
    if (mType === 0x3eb3) out.power_W = ((((msg[7] - 0x33) & 0xff) << 8) | ((msg[6] - 0x33) & 0xff));
    ctx.emit(out);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// GEO minim+ energy monitor (224)
// ---------------------------------------------------------------------------

/** The clamp: instantaneous apparent power and how long the sensor has been awake. */
function geoMinimCt(ctx: DecodeCtx, buf: Uint8Array, len: number): number {
  if (buf[3] !== 5) return DECODE_ABORT_LENGTH;
  if (len !== 11) return DECODE_ABORT_LENGTH;

  // Apparent power in tens of VA, with a spare bit worth five more.
  let va = 10 * (buf[5] + ((buf[4] & 0x0f) << 8));
  if (buf[4] & 0x40) va += 5;

  const out: R433Data = {
    model: 'GEO-minimCT',
    type: 'Energy',
    id: (hex2(buf[0]) + hex2(buf[1]) + hex2(buf[2])).toUpperCase(),
    power_VA: va,
    // The code counts eight-second intervals; the format string in the same file says nine.
    uptime_s: 8 * (((buf[6] << 16) + (buf[7] << 8) + buf[8]) >>> 0),
    mic: 'CRC',
  };
  const flags4 = buf[4] & 0xb0;                    // ~0x4f
  if (flags4 !== 0x30) out.flags4 = flags4;        // 0x30 is the resting value; anything else is worth saying
  ctx.emit(out);
  return 1;
}

/** The display: real power, energy over the last quarter hour, and its own clock. */
function geoMinimDisplay(ctx: DecodeCtx, buf: Uint8Array, len: number): number {
  if (buf[3] !== 42) return DECODE_ABORT_LENGTH;
  if (len !== 48) return DECODE_ABORT_LENGTH;

  // Upstream checks several fixed regions here but only logs when they disagree -- its own rejections are
  // commented out -- so nothing structural is enforced.

  const watts = 5 * (buf[4] + ((buf[5] & 0x7f) << 8));
  const wh = buf[14] + ((buf[15] & 0x07) << 8);

  // Days since 1 January 2007. Rolling that into a calendar date is done in UTC so the result does not
  // depend on the machine's timezone, which is the hazard upstream's own comment warns about.
  const days = buf[30] + (buf[31] << 8);
  const when = new Date(Date.UTC(2007, 0, 1 + days));
  const hour = buf[32] & 0x1f;
  const min = buf[33] & 0x3f;
  const clock = `${when.getUTCFullYear()}-${hex10(when.getUTCMonth() + 1)}-${hex10(when.getUTCDate())}`
    + ` ${hex10(hour)}:${hex10(min)}`;

  const out: R433Data = {
    model: 'GEO-minimDP',
    type: 'Energy',
    id: (hex2(buf[0]) + hex2(buf[1]) + hex2(buf[2])).toUpperCase(),
    power_W: watts,
    energy_kWh: wh * 0.001,
    clock,
    mic: 'CRC',
  };
  const flags5 = buf[5] & 0x80;
  if (flags5 !== 0) out.flags5 = flags5;
  const flags15 = buf[15] & 0xf8;
  if (flags15 !== 0x40) out.flags15 = flags15;
  ctx.emit(out);
  return 1;
}

/** Zero-padded decimal, for the clock. */
function hex10(n: number): string {
  return n.toString().padStart(2, '0');
}

export const geoMinim: RDevice = register({
  num: 224,
  name: 'GEO minim+ energy monitor',
  what: 'household energy monitor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 24,
  longWidth: 24,
  resetLimit: 3000,
  bands: BAND_868,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_LENGTH;

    // The run-in settles either way up, so both are tried.
    let bitpos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0x7b, 0xb9]), 32) + 32;
    if (bitpos >= bits.bitsPerRow[0]) {
      bitpos = bits.search(0, 0, new Uint8Array([0x55, 0x55, 0x7b, 0xb9]), 32) + 32;
    }
    if (bitpos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    let avail = bits.bitsPerRow[0];
    if (bitpos + 32 >= avail) return DECODE_ABORT_LENGTH;
    avail -= bitpos;

    const buf = new Uint8Array(128);
    bits.extractBytes(0, bitpos, buf, 32);

    const dataLength = buf[3];
    if (dataLength !== 0x2a && dataLength !== 0x05) return DECODE_ABORT_EARLY;

    let bytes = (avail / 8) | 0;
    if (bytes > 128) bytes = 128;

    const crcLen = 4 + buf[3];
    if (crcLen + 2 > bytes) return DECODE_FAIL_SANITY;

    const rest = bits.bytes(0, bitpos + 32, (bytes - 4) * 8);
    buf.set(rest.subarray(0, bytes - 4), 4);

    if (crc16(buf, crcLen, 0x8005, 0) !== ((buf[crcLen] << 8) | buf[crcLen + 1])) return DECODE_FAIL_MIC;

    if (dataLength === 0x2a) return geoMinimDisplay(ctx, buf, bytes);
    return geoMinimCt(ctx, buf, bytes);
  },
});

// ---------------------------------------------------------------------------
// BM5-v2 12 V automotive battery monitor (285)
// ---------------------------------------------------------------------------

/**
 * A battery sensor that clamps to a car's terminals and reports voltage, charge and health.
 *
 * It keys the opposite way round from everything else on this modulation — a zero is the short pulse and a one
 * the long one — so the whole buffer is turned over before anything is read.
 *
 * Both voltages are sixteen-bit little-endian counts of 1/1600 V. Upstream rounds them to two places rather
 * than truncating as the sensor's own display does, on the grounds that rounding is closer to the truth, and
 * that choice is kept here.
 */
export const bm5: RDevice = register({
  num: 285,
  name: 'bm5-v2 12V Battery Monitor',
  what: 'car battery monitor',
  modulation: Modulation.OOK_PWM,
  shortWidth: 225,
  longWidth: 675,
  resetLimit: 6000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();                                 // this sensor sends the inverse of what the slicer expects

    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 88) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, 0, 88);
    if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[10] === 0) return DECODE_FAIL_MIC;
    if (b[6] === 0 && b[7] === 0) return DECODE_FAIL_SANITY;   // a battery at 0.0 V is not a reading
    if (addBytes(b, 10) !== b[10]) return DECODE_FAIL_MIC;

    const soh = b[3] >> 1;
    const soc = b[4] >> 1;
    let temp = b[5] >> 1;
    if (b[5] & 0x01) temp = -temp;

    const batteryV = ((b[7] << 8) | b[6]) * 0.000625;
    const startingV = ((b[9] << 8) | b[8]) * 0.000625;

    // The percentages are seven bits wide but only ever mean 0-100, and this is a 12 V lead-acid monitor, so
    // a voltage far outside that range is what an eight-bit checksum let through rather than a real reading.
    if (soh > 100 || soc > 100 || batteryV < 0 || batteryV > 20 || startingV < 0 || startingV > 20) {
      return DECODE_FAIL_SANITY;
    }

    ctx.emit({
      model: 'BM5-v2',
      type: 'Energy',
      id: (b[0] << 16) | (b[1] << 8) | b[2],
      health_pct: soh,
      cranking_error: b[4] & 0x01,
      charge_pct: soc,
      charging_error: b[3] & 0x01,
      temperature_C: temp,
      battery_V: round2(batteryV),
      starting_V: round2(startingV),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Elster / Honeywell R2S / REXU power meters (338 type-1, 373 type-2)
// ---------------------------------------------------------------------------

const ELSTER_MIN_LEN = 9;
const ELSTER_MAX_LEN = 200;
const ELSTER2_MIN_LEN = 12;
const ELSTER2_NBR_MAX = 8;

/** CRC-16/X-25: reflected, initialized to all ones, and complemented at the end. */
function x25(buf: Uint8Array, n: number): number {
  return (crc16lsb(buf, n, 0x8408, 0xffff) ^ 0xffff) & 0xffff;
}

/**
 * Type-1 frames: Manchester coded, whitened with a repeating 0x55, with a self-inclusive length byte.
 *
 * The search over every bit position is upstream's design, not an accident of porting: these meters hop
 * frequencies and the run-in is never the same length twice, so there is no offset worth trusting. What makes
 * it safe is that a candidate must produce a length in range *and* a matching sixteen-bit CRC at exactly the
 * distance that length implies.
 */
export const elsterPowerMeter: RDevice = register({
  num: 338,
  name: 'Elster/Honeywell R2S/REXU power meter',
  what: 'electricity meter',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 28,
  longWidth: 28,
  resetLimit: 3000,
  bands: BAND_915,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];
    if (rowBits < (ELSTER_MIN_LEN + 2) * 8) return DECODE_ABORT_LENGTH;

    const row = bits.bb[0];
    const buf = new Uint8Array(ELSTER_MAX_LEN + 2);
    let len = 0;
    let found = -1;

    for (let pos = 0; pos + (ELSTER_MIN_LEN + 2) * 8 <= rowBits; pos++) {
      const candLen = bitrowGetByte(row, pos) ^ 0x55;
      if (candLen < ELSTER_MIN_LEN || candLen > ELSTER_MAX_LEN) continue;
      if (pos + (candLen + 2) * 8 > rowBits) continue;

      for (let i = 0; i < candLen + 2; i++) buf[i] = bitrowGetByte(row, pos + i * 8) ^ 0x55;
      if (x25(buf, candLen) === (buf[candLen] | (buf[candLen + 1] << 8))) {
        found = pos;
        len = candLen;
        break;
      }
    }
    if (found < 0) return DECODE_FAIL_MIC;

    const flags = buf[1];
    const src = ((((buf[2] << 24) >>> 0) | (buf[3] << 16) | (buf[4] << 8) | buf[5]) >>> 0);
    const dst = ((((buf[6] << 24) >>> 0) | (buf[7] << 16) | (buf[8] << 8) | buf[9]) >>> 0);

    const out: R433Data = {
      model: 'Elster-PowerMeter',
      type: 'Energy',
      // Decimal strings: this is what the meter prints on its label as the LAN ID.
      id: String(src),
      dst: String(dst),
      flags,
      data_raw: hexOf(buf, 10, len - 10),
      mic: 'CRC',
    };
    if (len === 40 && flags === 0x08 && dst === 0) out.frame_type = 'beacon';

    // An optional hourly-usage sub-command, sent only by plain meter reports and not by mesh traffic.
    if (src < 0x80000000 && len - 1 > 15) {
      const cmdLen = buf[16];
      if (cmdLen === 0x33 && len - 1 >= 16 + cmdLen) {
        const cmd = buf.subarray(17);
        if (cmd[1] === 0xce && cmdLen >= 10) {
          out.ctr = cmd[2];
          out.cur_hour = (cmd[5] << 8) | cmd[6];
          out.last_hour = (cmd[7] << 8) | cmd[8];
          let n = cmd[9];
          if (n > 17) n = 17;
          const readings: string[] = [];
          for (let h = 0; h < n && cmdLen >= 10 + 2 * (h + 1); h++) {
            readings.push((((cmd[10 + 2 * h] << 8) | cmd[10 + 2 * h + 1]) * 0.01).toFixed(2));
          }
          out.hourly_kWh = readings.join(',');
        }
        // Upstream marks this one unconfirmed even against its own reference dissector; kept as such.
        if (cmd[1] === 0xce && cmdLen >= 47) {
          out.reading_kWh = (((cmd[44] << 16) | (cmd[45] << 8) | cmd[46]) >>> 0);
        }
      }
    }

    ctx.emit(out);
    return 1;
  },
});

/**
 * Type-2 frames: no Manchester coding, whitened with 0xaa, a sixteen-bit length, four times the bit rate.
 *
 * The length means something different here too — it counts from its own first byte through the last data
 * byte and excludes the check, where type-1's length included itself and the check sat beyond it.
 *
 * Most bodies are encrypted under a per-meter key and are reported as raw hex. The two cleartext classes are
 * neighbour tables, and even there only each record's leading address is read: the remaining sixteen bytes of
 * every record are of unconfirmed meaning and go out with the rest of the raw data rather than being named.
 */
export const elsterPowerMeter2: RDevice = register({
  num: 373,
  name: 'Elster/Honeywell R2S/REXU power meter, type-2 frames',
  what: 'electricity meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 7,
  longWidth: 7,
  resetLimit: 4000,
  bands: BAND_915,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];
    if (rowBits < (ELSTER2_MIN_LEN + 2) * 8) return DECODE_ABORT_LENGTH;

    const row = bits.bb[0];
    const buf = new Uint8Array(ELSTER_MAX_LEN + 2);
    let len = 0;
    let found = -1;

    for (let pos = 0; pos + (ELSTER2_MIN_LEN + 2) * 8 <= rowBits; pos++) {
      const candLen = ((bitrowGetByte(row, pos) ^ 0xaa) << 8) | (bitrowGetByte(row, pos + 8) ^ 0xaa);
      if (candLen < ELSTER2_MIN_LEN || candLen > ELSTER_MAX_LEN) continue;
      if (pos + (candLen + 2) * 8 > rowBits) continue;

      for (let i = 0; i < candLen + 2; i++) buf[i] = bitrowGetByte(row, pos + i * 8) ^ 0xaa;
      // The check covers the length field itself, so it runs over exactly `candLen` bytes.
      if (x25(buf, candLen) === (buf[candLen] | (buf[candLen + 1] << 8))) {
        found = pos;
        len = candLen;
        break;
      }
    }
    if (found < 0) return DECODE_FAIL_MIC;

    const src = ((((buf[3] << 24) >>> 0) | (buf[4] << 16) | (buf[5] << 8) | buf[6]) >>> 0);
    const dst = ((((buf[7] << 24) >>> 0) | (buf[8] << 16) | (buf[9] << 8) | buf[10]) >>> 0);
    const isMesh = src >= 0x80000000;

    let msg = -1;
    if (!isMesh && len > 16) msg = buf[16];

    const out: R433Data = {
      model: 'Elster-PowerMeter2',
      type: 'Energy',
      id: String(src),
      dst: String(dst),
      mesh: isMesh ? 1 : 0,
      data_raw: hexOf(buf, 12, len - 12),
      mic: 'CRC',
    };
    if (msg >= 0) out.msg = hex2(msg);

    // The two cleartext classes start their records a byte apart, which is confirmed against real captures
    // of both and still unexplained.
    if ((msg === 0x57 || msg === 0x7f) && len > 30) {
      const n = buf[28];
      const recStart = (msg === 0x57) ? 30 : 29;
      if (n > 0 && n <= ELSTER2_NBR_MAX && recStart + n * 20 <= len) {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) ids.push(hexOf(buf, recStart + i * 20, 4));
        out.nbr_ids = ids.join(',');
      }
    }

    ctx.emit(out);
    return 1;
  },
});
