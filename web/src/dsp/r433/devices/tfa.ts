/**
 * TFA Dostmann, and the boards sold under other names that share their frames.
 *
 * TFA do not make most of this: they specify it and someone else builds it, which is why the family has no
 * common frame at all. There is a reversed-bit rain sensor that also ships as an Inovalley, a Manchester
 * thermo-hygro whose only integrity check is a digest it never actually compares, two sensors that arrive
 * inverted, a pool thermometer, a grill probe, a weather station that is a Fine Offset WH1050 underneath, and
 * a modern series that carries a proper CRC-32 and reports its last three readings every time.
 *
 * The WH1050 and the TFA 30.3151 are one board with two radios. Same nine bytes, same CRC, but the keyed
 * version offsets its temperature by forty degrees and counts rain in 0.3 mm steps while the frequency-shifted
 * one uses a sign bit and 0.5 mm steps. Reading one as the other gives a temperature forty degrees out and a
 * rainfall total that is nearly half right, which is exactly the sort of wrong that goes unnoticed.
 *
 * Ported from rtl_433's `src/devices/inovalley-kw9015b.c`, `tfa_30_3196.c`, `tfa_drop_30.3233.c`,
 * `tfa_30_3221.c`, `tfa_marbella.c`, `tfa_14_1504_v2.c`, `fineoffset_wh1050.c` and `tfa_30_390x.c`
 * (GPL-2.0-or-later).
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, lfsrDigest8Reflect, lfsrDigest16, reverse8 } from '../util.js';

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
/** C's `(int16_t)`. */
const s16 = (x: number) => ((x & 0xffff) << 16) >> 16;

/**
 * The Inovalley kw9015b, also sold as the TFA Dostmann 30.3161: rain and temperature.
 *
 * Every byte arrives with its bits in the opposite order, so nothing can be read until it is reversed - and
 * the checksum is a sum of the reversed nibbles, not of the bytes as received.
 */
export const inovalleyKw9015b: RDevice = register({
  num: 37,
  name: 'Inovalley kw9015b, TFA Dostmann 30.3161 rain and temperature sensor',
  what: 'rain gauge and thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 4800,
  resetLimit: 10000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 36);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 36) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];

    const r0 = reverse8(b[0]), r1 = reverse8(b[1]), r2 = reverse8(b[2]), r3 = reverse8(b[3]);
    const sum = (r0 >> 4) + (r0 & 0x0f) + (r1 >> 4) + (r1 & 0x0f)
      + (r2 >> 4) + (r2 & 0x0f) + (r3 >> 4) + (r3 & 0x0f);
    if ((sum & 0x0f) !== (reverse8(b[4]) & 0x0f)) return DECODE_FAIL_MIC;

    const rain = ((r0 & 0xc0) << 4) | ((r1 & 0x06) << 7) | r3;
    ctx.emit({
      model: 'Inovalley-kw9015b',
      id: r0 & 0x0f,
      battery_ok: b[1] >> 7 ? 0 : 1,
      temperature_C: round1((s16((r2 << 8) | (r1 & 0xf0)) >> 4) * 0.1),
      rain_mm: round1(rain * 0.45),
    });
    return 1;
  },
});

/**
 * The TFA 30.3196 outdoor thermo-hygro.
 *
 * Its sixteen-bit digest is computed and then used as the sensor's identity rather than checked against
 * anything - rtl_433 reports the integrity of this one as "missing" for that reason, and so does this. Two
 * bytes that should agree do not exist in the frame, so a reading here is only as trustworthy as the
 * Manchester decode that produced it.
 */
export const tfa303196: RDevice = register({
  num: 132,
  name: 'TFA Dostmann 30.3196 temperature and humidity outdoor sensor',
  what: 'outdoor thermometer and hygrometer',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 245,
  longWidth: 0,
  tolerance: 60,
  resetLimit: 22000,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Four repeats are sent; two are demanded. The length is the payload twice over plus the preamble.
    const row = bits.findRepeatedRow(2, 48 * 2 + 12);
    if (row < 0) return DECODE_ABORT_EARLY;

    const start = bits.search(row, 0, new Uint8Array([0x55, 0x56]), 16) + 12;
    if (bits.bitsPerRow[row] - start < 48 * 2) return DECODE_ABORT_LENGTH;

    const out = new BitBuffer();
    bits.manchesterDecode(row, start, out, 48);
    if (out.bitsPerRow[0] < 48) return DECODE_ABORT_LENGTH;
    const b = out.bb[0];

    if (b[0] !== 0xa8) return DECODE_FAIL_SANITY;

    const digest = (b[4] << 8) | b[5];
    const tempRaw = ((b[1] & 0x0f) << 8) | b[2];
    ctx.emit({
      model: 'TFA-303196',
      // Not a check: the digest exclusive-ored with the frame's own two bytes is what identifies the sensor.
      id: lfsrDigest16(b, 4, 0x8810, 0x22d0) ^ digest,
      channel: (b[1] >> 4) + 1,
      battery_ok: b[3] >> 7 ? 0 : 1,
      temperature_C: round1((tempRaw - 400) * 0.1),
      humidity: b[3] & 0x7f,
      mic: 'missing',
    });
    return 1;
  },
});

/** The TFA Drop rain gauge, which arrives inverted and counts in hundredths of an inch. */
export const tfaDrop303233: RDevice = register({
  num: 147,
  name: 'TFA Drop rain gauge 30.3233.01',
  what: 'tipping-bucket rain gauge',
  modulation: Modulation.OOK_PWM,
  shortWidth: 255,
  longWidth: 510,
  gapLimit: 1300,
  resetLimit: 2500,
  syncWidth: 750,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    const row = bits.findRepeatedRow(2, 66);
    if (row < 0 || bits.bitsPerRow[row] > 66 + 16) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];

    // The first nibble is a fixed prefix - stated here already inverted, as the frame is.
    if ((b[0] & 0xf0) !== (0x3 << 4)) return DECODE_ABORT_EARLY;
    if (b[7] !== lfsrDigest8Reflect(b, 7, 0x31, 0xf4)) return DECODE_FAIL_MIC;

    // The counter is offset by ten and allowed to wrap, which is the sensor's own arithmetic, not a fixup.
    const counter = (((b[6] << 8) | b[4]) + 10) & 0xffff;
    ctx.emit({
      model: 'TFA-Drop',
      id: (((b[0] & 0x0f) << 16) | (b[1] << 8) | b[2]).toString(16),
      battery_ok: (b[3] & 0x80) >> 7 ? 0 : 1,
      rain_mm: round1(counter * 0.254),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/** The TFA 30.3221.02 and 30.3249.02 outdoor sensors, which also arrive inverted. */
export const tfa303221: RDevice = register({
  num: 165,
  name: 'TFA Dostmann 30.3221.02 and 30.3249.02 temperature and humidity outdoor sensor',
  what: 'outdoor thermometer and hygrometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 235,
  longWidth: 480,
  resetLimit: 850,
  syncWidth: 836,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(bits.numRows > 4 ? 4 : 2, 40);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 41) return DECODE_ABORT_LENGTH;
    bits.invert();
    const b = bits.bb[row];

    if (b[0] === 0) return DECODE_FAIL_SANITY;
    if (b[4] !== lfsrDigest8Reflect(b, 4, 0x31, 0xf4)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'TFA-303221',
      id: b[0],
      channel: ((b[1] >> 4) & 3) + 1,
      battery_ok: b[1] >> 7 ? 0 : 1,
      temperature_C: round2((((((b[1] & 0x0f) << 8) | b[2])) - 500) * 0.1),
      humidity: b[3],
      sendmode: (b[1] >> 6) & 1,      // the test button, which sends far more often than the sensor normally does
      mic: 'CRC',
    });
    return 1;
  },
});

/** The Marbella floating pool thermometer. */
export const tfaMarbella: RDevice = register({
  num: 182,
  name: 'TFA Marbella pool thermometer',
  what: 'floating pool thermometer',
  modulation: Modulation.FSK_PCM,
  shortWidth: 105,
  longWidth: 105,
  resetLimit: 2000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    const start = bits.search(0, 0, new Uint8Array([0xaa, 0x2d, 0xd4]), 24);
    if (start >= n) return DECODE_FAIL_SANITY;
    // The frame is taken from the preamble onward, not from after it: the digest covers bytes three to nine.
    const msg = bits.bytes(0, start, 11 * 8);

    if (msg[9] !== 0xaa) return DECODE_FAIL_SANITY;
    if (lfsrDigest8Reflect(msg, 7, 0x31, 0x31, 3) !== msg[10]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'TFA-Marbella',
      id: ((msg[3] << 16) | (msg[4] << 8) | msg[5]).toString(16).padStart(6, '0'),
      counter: (msg[6] >> 1) & 0x07,
      battery_ok: (msg[6] >> 7) & 1 ? 0 : 1,
      temperature_C: round1((((msg[7] << 4) | (msg[8] >> 4)) - 400) * 0.1),
      mic: 'CRC',
    });
    return 1;
  },
});

/** The 14.1504.V2 grill and meat thermometer. Whole degrees only, and it says when no probe is plugged in. */
export const tfa141504v2: RDevice = register({
  num: 232,
  name: 'TFA Dostmann 14.1504.V2 grill and meat thermometer',
  what: 'barbecue thermometer',
  modulation: Modulation.FSK_PCM,
  shortWidth: 360,
  longWidth: 360,
  resetLimit: 4096,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    let available = bits.bitsPerRow[0];
    if (available < 64) return DECODE_ABORT_EARLY;

    const start = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0x5c]), 24);
    available -= start;
    if (available < 24) return DECODE_ABORT_EARLY;
    if (available < 64 || available > 76) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, start + 24, 40);

    const flags = b[0] >> 4;
    if ((flags & 0x5) === 0x5) return DECODE_FAIL_SANITY;
    if (b[2] !== 0xff) return DECODE_FAIL_SANITY;

    const calc = lfsrDigest16(b, 3, 0x8810, 0x0d42) ^ 0x16eb;
    if (calc !== ((b[3] << 8) + b[4])) return DECODE_FAIL_MIC;

    const rawTemp = ((b[0] & 0x0f) << 6) + (b[1] >> 2);
    const connected = rawTemp !== 0x1c0;         // the value the base station sends when the probe is out
    const data: R433Data = {
      model: 'TFA-141504v2',
      battery_ok: (flags & 0x2) !== 0 ? 1 : 0,
      probe_fail: connected ? 0 : 1,
      mic: 'CRC',
    };
    if (connected) data.temperature_C = rawTemp - 532;
    ctx.emit(data);
    return 1;
  },
});

/**
 * The Fine Offset WH1050 weather station and the TFA 30.3151 built on it.
 *
 * One decoder for both, because the frame is identical and only the radio differs - which is exactly why the
 * scaling has to be chosen from how the frame arrived rather than from which registration was called. The
 * keyed version offsets temperature by forty degrees and counts rain in 0.3 mm steps; the frequency-shifted
 * one carries a sign bit and counts in 0.5 mm.
 *
 * The frequency-shifted version repeats its message six times in a single row with gaps between, so the
 * preamble is searched for repeatedly and every copy that decodes is reported.
 */
function wh1050Decode(bits: BitBuffer, ctx: DecodeCtx, at: number, fsk: boolean): number {
  const br = bits.bytes(0, at, 9 * 8);
  if (crc8(br, 9, 0x31, 0x00)) return 0;

  const msgType = br[0] >> 4;
  const model = fsk ? 'TFA-303151' : 'Fineoffset-WH1050';
  const id = ((br[0] << 4) & 0xf0) | (br[1] >> 4);
  const batteryOk = br[1] & 0x04 ? 0 : 1;

  if (msgType === 5) {
    const tempRaw = ((br[1] & 0x03) << 8) | br[2];
    const rainRaw = (br[6] << 8) | br[7];
    let temperature: number, rain: number;
    if (fsk) {
      temperature = tempRaw * 0.1;
      if ((br[1] & 0x08) >> 3) temperature = -temperature;   // a sign bit the keyed version does not have
      rain = rainRaw * 0.5;
    } else {
      temperature = (tempRaw - 400) * 0.1;
      rain = rainRaw * 0.3;
    }
    ctx.emit({
      model,
      id: id.toString(16).padStart(2, '0').toUpperCase(),
      msg_type: msgType,
      battery_ok: batteryOk,
      temperature_C: round1(temperature),
      humidity: br[3],
      wind_avg_km_h: round2(br[4] * 0.34 * 3.6),
      wind_max_km_h: round2(br[5] * 0.34 * 3.6),
      rain_mm: round1(rain),
      mic: 'CRC',
    });
    return 1;
  }
  if (msgType === 6) {
    // The station also broadcasts the time it picked up from a radio clock.
    const two = (v: number) => ((v & 0xf0) >> 4) * 10 + (v & 0x0f);
    const clock = `${2000 + two(br[5])}-${String(((br[6] & 0x10) >> 4) * 10 + (br[6] & 0x0f)).padStart(2, '0')}`
      + `-${String(two(br[7])).padStart(2, '0')}T${String(((br[2] & 0x30) >> 4) * 10 + (br[2] & 0x0f)).padStart(2, '0')}`
      + `:${String(two(br[3])).padStart(2, '0')}:${String(two(br[4])).padStart(2, '0')}`;
    ctx.emit({
      model,
      id: id.toString(16).padStart(2, '0').toUpperCase(),
      msg_type: msgType,
      battery_ok: batteryOk,
      radio_clock: clock,
      mic: 'CRC',
    });
    return 1;
  }
  return 0;
}

/** Both radios run the same reader; which one it is comes out of the length and the preamble byte. */
function wh1050Common(bits: BitBuffer, ctx: DecodeCtx): number {
  if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
  const n = bits.bitsPerRow[0];
  const first = bits.bb[0][0];

  // The Digitech XC0346 sends only seven leading ones instead of eight, so both lengths are accepted.
  if (n === 79 && first === 0xfe) return wh1050Decode(bits, ctx, 7, false);
  if (n === 80 && first === 0xff) return wh1050Decode(bits, ctx, 8, false);
  if (n > 112 && n < 760) {
    const sync = new Uint8Array([0xaa, 0x2d, 0xd4]);
    let events = 0;
    let at = 0;
    // Six copies in one row, separated by gaps: take every one that decodes.
    for (;;) {
      at = bits.search(0, at, sync, 24);
      if (at + 24 + 72 > n) break;
      events += wh1050Decode(bits, ctx, at + 24, true);
      at += 123;
    }
    return events;
  }
  return DECODE_ABORT_LENGTH;
}

export const fineoffsetWh1050: RDevice = register({
  num: 69,
  name: 'Fine Offset WH1050 weather station',
  what: 'outdoor array: wind, rain, temperature and humidity',
  modulation: Modulation.OOK_PWM,
  shortWidth: 544,
  longWidth: 1524,
  resetLimit: 10520,
  bands: [433920000],
  decode: (_dev, bits, ctx) => wh1050Common(bits, ctx),
});

export const tfa303151: RDevice = register({
  num: 246,
  name: 'TFA 30.3151 weather station',
  what: 'outdoor array: wind, rain, temperature and humidity',
  modulation: Modulation.FSK_PCM,
  shortWidth: 60,
  longWidth: 60,
  resetLimit: 2500,
  bands: [868300000],
  decode: (_dev, bits, ctx) => wh1050Common(bits, ctx),
});

/** The reflected CRC-32 the 30.390X series uses - the ordinary one, generator 0xedb88320. */
function crc32(m: Uint8Array, at: number, n: number): number {
  let crc = 0xffffffff;
  for (let k = 0; k < n; k++) {
    crc ^= m[at + k];
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Sign-extend the low `bits` of a value, which is how this series stores its temperatures. */
const signedLow = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);

/**
 * The 30.390X series: five models on one frame, told apart by a byte of identity.
 *
 * Each reports its last three readings rather than just the current one, so a console that missed a
 * transmission can still fill in its graph. The current value is the first of the three.
 */
export const tfa30390x: RDevice = register({
  num: 347,
  name: 'TFA Dostmann 30.390X temperature and humidity series',
  what: 'outdoor sensors: 30.3901, 30.3902, 30.3905, 30.3906 and 30.3908',
  modulation: Modulation.FSK_PCM,
  shortWidth: 61,
  longWidth: 61,
  tolerance: 5,
  resetLimit: 3500,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    const at = bits.search(0, 0, new Uint8Array([0x4b, 0x2d, 0xd4, 0x2b]), 32);
    if (at + 32 + 8 > n) return DECODE_ABORT_LENGTH;

    const lenByte = bits.bytes(0, at + 32, 8)[0];
    if (lenByte !== 24 && lenByte !== 30 && lenByte !== 36) return DECODE_ABORT_LENGTH;
    if (at + 32 + lenByte * 8 > n) return DECODE_ABORT_LENGTH;

    // The sync word is kept in the buffer, so the length byte lands at index four.
    const b = bits.bytes(0, at, 32 + lenByte * 8);
    const want = ((b[lenByte + 3] << 24) | (b[lenByte + 2] << 16) | (b[lenByte + 1] << 8) | b[lenByte]) >>> 0;
    if (crc32(b, 4, lenByte - 4) !== want) return DECODE_FAIL_MIC;
    if (!b[5] && !b[6] && !b[7] && !b[8]) return DECODE_FAIL_SANITY;

    const id = [b[5], b[6], b[7], b[8]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    const base: R433Data = {
      model: '',
      id,
      battery_ok: b[9] & 0x08 ? 0 : 1,
      manual_transmit: (b[9] & 0x02) >> 1,
      seq_number: b[10] | (b[11] << 8),
      mic: 'CRC',
    };
    const at16 = (i: number) => b[i] | (b[i + 1] << 8);

    const variant = b[5];
    if (variant === 0xa0 || variant === 0xa6) {
      if (lenByte !== 30) return DECODE_FAIL_SANITY;
      const t = [0, 1, 2].map(k => round1(signedLow(at16(12 + k * 6), 11) * 0.1));
      const h = [0, 1, 2].map(k => round1(at16(14 + k * 6) * 0.1));
      ctx.emit({ ...base, model: variant === 0xa0 ? 'TFA-303908' : 'TFA-303906',
        temperature_C: t[0], temperature_C_last: t.join(', '), humidity: h[0], humidity_last: h.join(', ') });
      return 1;
    }
    if (variant === 0xa3) {
      if (lenByte !== 30) return DECODE_FAIL_SANITY;
      const t = [0, 1, 2].map(k => round1(signedLow(at16(12 + k * 6), 11) * 0.1));
      const e = [0, 1, 2].map(k => round1(signedLow(at16(14 + k * 6), 11) * 0.1));
      ctx.emit({ ...base, model: 'TFA-303902',
        temperature_C: t[0], temperature_C_last: t.join(', '),
        temperature_C_ext: e[0], temperature_C_ext_last: e.join(', ') });
      return 1;
    }
    if (variant === 0xa4) {
      if (lenByte !== 36) return DECODE_FAIL_SANITY;
      const t = [0, 1, 2].map(k => round1(signedLow(at16(12 + k * 8), 12) * 0.1));
      const h = [0, 1, 2].map(k => round1(at16(14 + k * 8) * 0.1));
      const e = [0, 1, 2].map(k => round1(signedLow(at16(16 + k * 8), 12) * 0.1));
      ctx.emit({ ...base, model: 'TFA-303905',
        temperature_C: t[0], temperature_C_last: t.join(', '), humidity: h[0], humidity_last: h.join(', '),
        temperature_C_ext: e[0], temperature_C_ext_last: e.join(', ') });
      return 1;
    }
    if (variant === 0xa5) {
      if (lenByte !== 24) return DECODE_FAIL_SANITY;
      const t = [0, 1, 2].map(k => round1(signedLow(at16(12 + k * 4), 11) * 0.1));
      ctx.emit({ ...base, model: 'TFA-303901', temperature_C: t[0], temperature_C_last: t.join(', ') });
      return 1;
    }
    return DECODE_FAIL_SANITY;
  },
});
