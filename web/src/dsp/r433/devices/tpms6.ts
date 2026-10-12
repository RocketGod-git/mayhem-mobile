/**
 * The aftermarket tire pressure sensors — the screw-on caps sold for caravans, trailers and older cars.
 *
 * These finish the family. They are cheap sensors built on a handful of shared chips, and it shows: four of
 * the seven are the same SP372-family part under different brand names, with the same eight-byte frame, the
 * same trick of repeating the first byte at the end as an integrity check, and no CRC worth the name.
 *
 * That shared design has an awkward consequence. On those parts the pressure and temperature offsets are
 * calibrated per physical sensor rather than fixed by the protocol, so a decoder can only report readings for
 * units somebody has already measured against a real gauge. Two units are known for the Jansite TY-468, two
 * for the iMars T240 — and for the iMars, nobody ever recorded a ground-truth reading at all, so it can
 * confirm that a sensor is transmitting and identify it, but cannot honestly say what pressure it read. It
 * reports the raw frame and nothing else, which is the truthful answer rather than a fabricated number.
 *
 * None of these seven ships a test capture in rtl_433, so unlike the previous batches every frame here is
 * built from the transmit side.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `tpms_jansite_solar.c`, `tpms_jansite_ty468.c`,
 * `tpms_jansite_ty588.c`, `tpms_eezrv.c`, `tpms_airpuxem.c`, `tpms_imars_t240.c`, `tpms_sefis_m3.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, crc16 } from '../util.js';

/** American cars transmit at 315 MHz, European ones at 433.92; these aftermarket parts are all 433.92. */
const BANDS = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const hexLow = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');
const hexFrom = (b: Uint8Array, at: number, n: number) => {
  let s = '';
  for (let i = at; i < at + n; i++) s += hexLow(b[i], 2);
  return s;
};

// ---------------------------------------------------------------------------
// Jansite Solar (180)
// ---------------------------------------------------------------------------

/**
 * The one sensor here with a real CRC.
 *
 * Its run-in is not a separate preamble at all: `a6 a6 5a` is exactly what the sync word `dd33` becomes once
 * Manchester coded, so the search pattern and the first two bytes of the frame are the same bits. That is why
 * the decode starts at the run-in rather than past it.
 */
function jansiteSolarDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.manchesterDecode(row, bitpos, packet, 88);
  packet.invert();
  if (packet.bitsPerRow[0] < 88) return DECODE_FAIL_SANITY;

  const b = packet.bb[0];
  if (((b[0] << 8) | b[1]) !== 0xdd33) return DECODE_FAIL_SANITY;
  if ((((b[9] << 8) | b[10]) & 0xffff) !== crc16(b, 7, 0x8005, 0x0000, 2)) return DECODE_FAIL_MIC;

  ctx.emit({
    model: 'Jansite-Solar',
    type: 'TPMS',
    id: hexFrom(b, 2, 3),
    flags: b[5],
    pressure_kPa: Math.round(b[7] * 1.6),
    temperature_C: b[6] - 55,
    code: hexFrom(b, 2, 9),
    mic: 'CRC',
  });
  return 1;
}

export const tpmsJansiteSolar: RDevice = register({
  num: 180,
  name: 'Jansite TPMS Model Solar',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 51,
  longWidth: 51,
  resetLimit: 5000,                                // long enough to merge the three repeats into one row
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xa6, 0xa6, 0x5a]);
    let bitpos = 0, events = 0, ret = 0;
    while ((bitpos = bits.search(0, bitpos, pre, 24)) + 80 <= bits.bitsPerRow[0]) {
      ret = jansiteSolarDecode(bits, ctx, 0, bitpos);
      if (ret > 0) events += ret;
      bitpos += 2;
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// The SP372 family: Jansite TY-468 (355) and iMars T240 (354)
// ---------------------------------------------------------------------------

/**
 * Read the eight-byte frame these chips share, and check the parts of it that are structural.
 *
 * There is no CRC. What there is instead: the last byte repeats the first, the low nibbles of the first two
 * bytes agree, and two bytes are fixed affine functions of the first — so their sum is a constant that
 * identifies the individual sensor unit. That constant is the only thing standing between a real frame and
 * noise, which is why the calibration tables below are keyed on it.
 */
function sp372Frame(bits: BitBuffer): Uint8Array | null {
  if (bits.numRows !== 1) return null;
  const len = bits.bitsPerRow[0];
  const pos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0xaa]), 24);
  if (pos >= len) return null;
  if (len - pos < 160) return null;

  const packet = new BitBuffer();
  bits.manchesterDecode(0, pos + 32, packet, 64);
  packet.invert();
  if (packet.bitsPerRow[0] < 64) return null;

  const b = packet.bb[0];
  if (b[7] !== b[0]) return null;                  // the tail must repeat the head
  if ((b[0] & 0x0f) !== (b[1] & 0x0f)) return null;
  return b;
}

/** Per-unit calibration for the two Jansite TY-468 sensors anyone has measured against a real gauge. */
const TY468_UNITS: Record<number, { temp: number; press: number }> = {
  0xfb: { temp: 224, press: 273 },
  0x64: { temp: 153, press: 201 },
};

export const tpmsJansiteTy468: RDevice = register({
  num: 355,
  name: 'Jansite TPMS TY-468-eu2 / KKMOON TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_PCM,
  shortWidth: 50,
  longWidth: 50,
  resetLimit: 200,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const b = sp372Frame(bits);
    if (!b) return DECODE_ABORT_EARLY;

    const unit = TY468_UNITS[(b[3] + b[4]) & 0xff];
    if (!unit) return DECODE_FAIL_MIC;             // a sensor nobody has calibrated, or not this device

    ctx.emit({
      model: 'Jansite-TY468',
      type: 'TPMS',
      temperature_C: unit.temp - ((b[2] + b[5]) & 0xff),
      pressure_kPa: round1((unit.press - ((b[5] + b[6]) & 0xff)) * 2.5),
      code: hexFrom(b, 0, 7),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

export const tpmsImarsT240: RDevice = register({
  num: 354,
  name: 'iMars T240 TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_PCM,
  shortWidth: 50,
  longWidth: 50,
  resetLimit: 200,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const b = sp372Frame(bits);
    if (!b) return DECODE_ABORT_EARLY;

    // The same frame as the Jansite above, but nobody ever recorded what this one's display was showing at
    // the time, so there is nothing to calibrate the pressure and temperature against. Reporting the frame
    // and saying nothing about the readings is the honest answer.
    const checksum = (b[3] + b[4]) & 0xff;
    if (checksum !== 0x41 && checksum !== 0x3c) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'iMars-T240',
      type: 'TPMS',
      code: hexFrom(b, 0, 7),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Jansite TY588-EU2 (362)
// ---------------------------------------------------------------------------

/**
 * A different wire format from the Jansite Solar above despite the name, and again no CRC.
 *
 * Here the two bytes that are affine functions of the first sum to a constant that is the same on every
 * sensor, so unlike its cousins this one's readings are not per-unit — but it pays for that by having no
 * identity at all. What looks like it ought to be a sensor id turns out to vary between transmissions from
 * the same sensor, so the raw frame is reported instead and distinct sensors are told apart by that.
 */
function jansiteTy588Decode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.manchesterDecode(row, bitpos + 44, packet, 64);    // forty-four raw bits of run-in first
  if (packet.bitsPerRow[0] < 64) return DECODE_ABORT_LENGTH;

  const b = packet.bb[0];
  if (b[7] !== b[0]) return DECODE_FAIL_MIC;       // the only integrity check this frame has
  if (((b[3] + b[4]) & 0xff) !== 0x30 || (b[0] & 0x0f) !== (b[1] & 0x0f)) return DECODE_FAIL_SANITY;

  const temperature = ((b[2] + b[5]) & 0xff) - 139;
  const pressureRaw = ((b[5] + b[6]) & 0xff) - 90;
  if (pressureRaw < 0 || temperature < -40 || temperature > 120) return DECODE_FAIL_SANITY;

  ctx.emit({
    model: 'Jansite-TY588',
    type: 'TPMS',
    pressure_kPa: round1(pressureRaw * 2.5),
    temperature_C: temperature,
    code: hexFrom(b, 0, 7),
    mic: 'CHECKSUM',
  });
  return 1;
}

export const tpmsJansiteTy588: RDevice = register({
  num: 362,
  name: 'Jansite TPMS TY588-EU2',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 51,
  longWidth: 51,
  resetLimit: 5000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0x99, 0xaa, 0x5a]);   // the first 24 of 44 run-in bits
    let bitpos = 0, events = 0, ret = 0;
    while ((bitpos = bits.search(0, bitpos, pre, 24)) + 172 <= bits.bitsPerRow[0]) {
      ret = jansiteTy588Decode(bits, ctx, 0, bitpos);
      if (ret > 0) events += ret;
      bitpos += 2;
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// EezTire E618, Carchet and TST-507 (241)
// ---------------------------------------------------------------------------

/**
 * A caravan sensor that changes how often it speaks depending on what the tire is doing.
 *
 * Once every four minutes or so at rest, every fifteen seconds while being pumped up, and once a second when
 * it thinks the tire is going down fast. Its checksum has an oddity worth keeping: when the byte sum runs past
 * a byte, the sensor sets the top bit of the result whether or not it was already set, so the overflow is
 * folded in rather than discarded.
 */
export const tpmsEezrv: RDevice = register({
  num: 241,
  name: 'EezTire E618, Carchet TPMS, TST-507 TPMS',
  what: 'tire pressure sensor: caravan and trailer monitor',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 50,
  longWidth: 50,
  resetLimit: 120,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    bits.invert();
    const pos = bits.search(0, 0, new Uint8Array([0xff, 0xff]), 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    // There is nothing in the payload to anchor against, so the run-in has to be right at the start.
    if (pos > 0) return DECODE_ABORT_EARLY;
    if (pos + 10 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    const cc = bits.bytes(0, pos + 16, 8);
    const b = bits.bytes(0, pos + 24, 56);

    // Our addBytes masks to a byte, unlike rtl_433 add_bytes; this sensor needs the overflow itself as
    // information, so the sum is taken here at full width.
    let computed = 0;
    for (let i = 0; i < 7; i++) computed += b[i];
    if (computed > 0xff) computed |= 0x80;         // the overflow is folded back in, not dropped
    if ((computed & 0xff) !== cc[0]) return DECODE_FAIL_MIC;

    const flags1 = b[5];
    const flags2 = b[6];
    const inflating = (flags1 & 0x20) >> 5;
    const data: R433Data = {
      model: 'EezTire-E618',
      type: 'TPMS',
      id: hexFrom(b, 0, 3),
      battery_ok: flags1 >> 7 ? 0 : 1,             // set below about 3.15 volts, and it dies at 3.10
      pressure_kPa: Math.round((((flags2 & 0x01) << 8) + b[3]) * 2.5),
      temperature_C: b[4] - 50,
      flags: `${hexLow(flags1, 2)}${hexLow(flags2, 2)}`,
      fast_leak: (flags1 & 0x10) && !inflating ? 1 : 0,
      inflate: inflating,
      mic: 'CHECKSUM',
    };
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Airpuxem TYH11_EU6_ZQ (295)
// ---------------------------------------------------------------------------

/**
 * This one sends its checksum twice, one copy straight after the other.
 *
 * The pressure is also split oddly: its two most significant bits are not next to the rest of it but hidden
 * among the flags, one in each nibble of the byte that carries them.
 */
function airpuxemDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const dec = new BitBuffer();
  bits.manchesterDecode(row, bitpos, dec, 354);
  // Four bits of header, sixty-four of payload, then the checksum twice over.
  if (dec.bitsPerRow[0] < 84) return DECODE_FAIL_SANITY;

  const b = dec.bb[0];
  if ((b[0] >> 4) !== 0x5) return DECODE_FAIL_SANITY;

  const payload = dec.bytes(0, 4, 64);
  const crcs = dec.bytes(0, 4 + 64, 16);
  if (crcs[0] !== crc8(payload, 8, 0x2f, 0xaa)) return DECODE_FAIL_MIC;

  const f = dec.bytes(0, 4, 80);
  const id = ((f[0] << 24) | (f[1] << 16) | (f[2] << 8) | f[3]) >>> 0;
  // The two high bits of the pressure sit at bit seven and bit three of the flags byte.
  const pressure = (f[5] | (((f[4] >> 7) & 1) << 8) | (((f[4] >> 3) & 1) << 9)) - 100;

  ctx.emit({
    model: 'Airpuxem-TYH11EU6ZQ',
    type: 'TPMS',
    id: hexLow(id, 8),
    position: f[4] & 0x07,                         // which wheel the sensor believes it is on
    flags: (f[4] >> 4) & 0x07,
    pressure_kPa: pressure,
    temperature_C: (f[6] << 24) >> 24,             // signed, so it can report below freezing
    battery_V: round1(f[7] * 0.02),
    code: hexFrom(b, 0, 11),
    mic: 'CRC',
  });
  return 1;
}

export const tpmsAirpuxem: RDevice = register({
  num: 295,
  name: 'Airpuxem TPMS TYH11_EU6_ZQ',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xaa, 0xaa, 0xa9]);   // once inverted
    bits.invert();
    let events = 0, ret = 0;
    for (let row = 0; row < bits.numRows; row++) {
      let bitpos = 0;
      while ((bitpos = bits.search(row, bitpos, pre, 24)) + 80 <= bits.bitsPerRow[row]) {
        ret = airpuxemDecode(bits, ctx, row, bitpos + 24);
        if (ret > 0) events += ret;
        bitpos += 2;
      }
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Sefis M3, Careud and Sykik SRTP300 (378)
// ---------------------------------------------------------------------------

/** The pressure's top two bits are not stored in order: these four codes mean pages nought to three. */
const SEFIS_PAGE: Record<number, number> = { 7: 0, 4: 1, 5: 2, 2: 3 };

/**
 * A frame that arrives bit-inverted, with the pressure spread across a deliberately scrambled page number.
 *
 * The page bits are not a plain two-bit field — the four values that appear are 7, 4, 5 and 2, standing for
 * nought through three in that order, which is only knowable from having watched a real sensor deflate. Any
 * other value means this is not a pressure reading, and the frame is reported without one rather than with a
 * made-up figure.
 */
export const tpmsSefisM3: RDevice = register({
  num: 378,
  name: 'Sefis M3 / Careud / Sykik SRTP300 TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 5000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    // The sync word as it arrives, before the Manchester decode inverts it into 0x5a9d.
    const sync = new Uint8Array([0x66, 0x99, 0x96, 0xa6]);
    let pos = bits.search(0, 0, sync, 32);
    if (pos === bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    if (pos + 32 + 72 * 2 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;
    pos += 32;

    const packet = new BitBuffer();
    bits.manchesterDecode(0, pos, packet, 72);
    if (packet.bitsPerRow[0] < 72) return DECODE_ABORT_LENGTH;

    const b = new Uint8Array(9);
    for (let i = 0; i < 9; i++) b[i] = packet.bb[0][i] ^ 0xff;

    if (crc16(b, 7, 0x1021, 0x0000) !== (((b[7] << 8) | b[8]) & 0xffff)) return DECODE_FAIL_MIC;

    const data: R433Data = {
      model: 'Sefis-M3',
      type: 'TPMS',
      temperature_C: 14 + (((b[2] + b[5]) & 0xff) & 0x0f),
      code: hexFrom(b, 0, 7),
      mic: 'CRC',
    };

    const page = SEFIS_PAGE[b[4] >> 5];
    if (page !== undefined) {
      const code = (page << 13) | ((b[4] & 0x1f) << 8) | b[5];
      data.pressure_kPa = Math.max(0, Math.round((code - 0x0e00) / 102.4));
    }
    ctx.emit(data);
    return 1;
  },
});
