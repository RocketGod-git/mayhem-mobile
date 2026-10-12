/**
 * The last of the tire pressure sensors: German saloons, Chrysler, Aston Martin and a Sprinter van.
 *
 * These are the awkward ones. Three of them carry two different frame lengths down the same protocol and work
 * out which they are looking at from how many bits survived the decode — BMW's Gen4/Gen5 sensor shares its
 * wire format with an Audi pressure alert that is three bytes shorter, and the Gen2/Gen3 sensor tells its two
 * generations apart the same way. The TRW sensor fitted to Chryslers transmits the identical frame twice over,
 * once on-off keyed and once frequency shifted, so it is registered twice and told apart only by its run-in.
 *
 * Two of them overlap with sensors already in this app and say so honestly. The Jeep sensor is the same frame
 * as the Citroen one already registered, distinguishable by nothing in the bits at all — upstream leaves it off
 * by default rather than have two decoders claim every transmission, and so does this. The Honda sensor guards
 * against a different TRW board by refusing a pressure too low for a tire to be holding at all.
 *
 * Six of the eight are checked against real captures that rtl_433 ships, which is unusually good evidence: BMW
 * alone provides five, together with the bytes they are known to decode to.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `tpms_bmw.c`, `tpms_bmw_g3.c`, `tpms_trw.c`, `tpms_smartire.c`,
 * `tpms_mercedes_benz.c`, `tpms_jeep.c`, `tpms_honda.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc7, crc8, crc16 } from '../util.js';

/** American cars transmit at 315 MHz, European ones at 433.92. */
const BANDS = [315000000, 433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const hexLow = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');
const hexOf = (b: Uint8Array, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += hexLow(b[i], 2);
  return s;
};

// ---------------------------------------------------------------------------
// BMW Gen4/Gen5, and the Audi pressure alert that shares its wire format (252)
// ---------------------------------------------------------------------------

/**
 * One protocol, two frame lengths, and five brands of sensor inside it.
 *
 * The first byte names the maker — Beru, Schrader, Continental or Audi — and the frame is eleven bytes for a
 * BMW sensor or eight for an Audi pressure alert, which is a warning rather than a routine reading. Which one
 * arrived is worked out from how much survived the Manchester decode, so a truncated BMW frame could in
 * principle be read as a whole Audi one; the CRC over the shorter length is what stops that.
 */
export const tpmsBmw: RDevice = register({
  num: 252,
  name: 'BMW Gen4-Gen5 TPMS and Audi TPMS Pressure Alert (HUF/Beru, Continental, Schrader/Sensata, Audi)',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 25,
  longWidth: 25,
  resetLimit: 100,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const pre = new Uint8Array([0xaa, 0x59]);
    const pos = bits.search(0, 0, pre, 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    let lenMsg = 11;                               // eleven for BMW, eight for the Audi alert
    const decoded = new BitBuffer();
    bits.manchesterDecode(0, pos + 16, decoded, lenMsg * 8);
    if (decoded.bitsPerRow[0] < 88) {
      if (decoded.bitsPerRow[0] >= 64) lenMsg = 8;
      else return DECODE_ABORT_LENGTH;
    }
    decoded.invert();                              // Manchester zero-bit convention
    const b = decoded.bb[0];
    if (crc8(b, lenMsg, 0x2f, 0xaa) !== 0) return DECODE_FAIL_MIC;

    const data: R433Data = {
      model: lenMsg === 11 ? 'BMW-GEN5' : 'Audi-PressureAlert',
      type: 'TPMS',
      // 0x00 Audi alert, 0x03 HUF/Beru, 0x23 Schrader/Sensata, 0x80 Continental, 0x88 Audi.
      brand: b[0],
      id: hexOf(b.subarray(1), 4),
      pressure_kPa: round1(b[5] * 2.45),
      temperature_C: b[6] - 52,
      msg: hexOf(b, lenMsg),
      mic: 'CRC',
    };
    if (lenMsg === 11) {
      data.flags1 = b[7];                          // warning bits: battery, deflating fast
      data.flags2 = b[8];                          // sequence number, not yet confirmed
      data.flags3 = b[9];                          // target nominal pressure on the Beru sensor
    } else {
      data.alert = 'Alert Pressure increase/decrease !';
    }
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// BMW Gen2 and Gen3 (257)
// ---------------------------------------------------------------------------

/** The older BMW sensor: differential Manchester, and one byte longer on the third generation. */
export const tpmsBmwG3: RDevice = register({
  num: 257,
  name: 'BMW Gen2 and Gen3 TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 160,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const pre = new Uint8Array([0xcc, 0xcd]);
    const pos = bits.search(0, 0, pre, 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const decoded = new BitBuffer();
    bits.differentialManchesterDecode(0, pos + 16, decoded, 88);
    const msgLen = decoded.bitsPerRow[0] ?? 0;
    // Eighty-one bits is the second generation, eighty-nine the third; the CRC covers one byte fewer.
    const isGen2 = msgLen >= 80 && msgLen < 88 ? 1 : 0;
    if (msgLen < 80) return DECODE_ABORT_LENGTH;

    const b = decoded.bb[0];
    if (crc16(b, 11 - isGen2, 0x1021, 0x0000) !== 0) return DECODE_FAIL_MIC;

    const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const data: R433Data = {
      model: isGen2 ? 'BMW-GEN2' : 'BMW-GEN3',
      type: 'TPMS',
      id: String(id),
      pressure_kPa: round1((b[4] - 43) * 2.5),
      temperature_C: b[5] - 40,
      flags1: b[6],
      flags2: b[7],
      msg: hexOf(b, isGen2 ? 10 : 11),
      mic: 'CRC',
    };
    if (!isGen2) data.flags3 = b[8];               // the third generation carries one flag byte more
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// TRW, fitted to Chryslers (298 on-off keyed, 299 frequency shifted)
// ---------------------------------------------------------------------------

/**
 * The same frame, sent twice: once on-off keyed and once frequency shifted.
 *
 * Only the run-in differs, so the two registrations share everything below and are told apart by which pattern
 * they look for. The trailing nibble says whether the sensor is a genuine part or a copy of one.
 */
function trwDecode(bits: BitBuffer, ctx: DecodeCtx, fsk: boolean): number {
  if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
  const msgLen = bits.bitsPerRow[0];
  if (msgLen > 98) return DECODE_ABORT_LENGTH;

  const pre = fsk ? new Uint8Array([0x7f, 0xff]) : new Uint8Array([0x00, 0x01]);
  let pos = bits.search(0, 0, pre, 16);
  if (pos >= msgLen) return DECODE_ABORT_EARLY;
  if (pos + 8 * 11 > msgLen) return DECODE_ABORT_LENGTH;
  pos += 16;
  if (msgLen - pos < 81) return DECODE_ABORT_LENGTH;

  const b = bits.bytes(0, pos, 88);
  if (crc8(b, 10, 0x07, 0x00) !== 0) return DECODE_FAIL_MIC;

  const flags = (b[5] & 0xf0) >> 4;
  const motion = b[8];
  const oem = (b[10] & 0xf0) >> 4;

  const data: R433Data = {
    model: 'TRW',
    type: 'TPMS',
    mode: hexLow(b[0], 2),                         // 0x5c, 0x5d or 0x5e
    id: hexOf(b.subarray(1), 4),
    flags: hexLow(flags, 1),
    seq_num: b[5] & 0x0f,
    pressure_PSI: round1(b[6] * 0.4),
    temperature_C: b[7] - 50,
    motion_flags: hexLow(motion, 2),
    motion_status: motion === 0x0e ? 'Parked' : 'Moving',
    mic: 'CRC',
  };
  if (flags === 0x6 || flags === 0x9) data.alert = 'Pressure increase/decrease !';
  if (oem === 0x4) data.oem_model = 'OEM';
  else if (oem === 0x0) data.oem_model = 'Clone';
  ctx.emit(data);
  return 1;
}

export const tpmsTrwOok: RDevice = register({
  num: 298,
  name: 'TRW TPMS OOK OEM and Clone models',
  what: 'tire pressure sensor: Chrysler',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: BANDS,
  decode: (_dev, bits, ctx) => trwDecode(bits, ctx, false),
});

export const tpmsTrwFsk: RDevice = register({
  num: 299,
  name: 'TRW TPMS FSK OEM and Clone models',
  what: 'tire pressure sensor: Chrysler',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: BANDS,
  decode: (_dev, bits, ctx) => trwDecode(bits, ctx, true),
});

// ---------------------------------------------------------------------------
// SmarTire, fitted to Aston Martins (343)
// ---------------------------------------------------------------------------

/**
 * This sensor cannot say pressure and temperature in the same breath.
 *
 * Two bits pick which one the reading is, and the sensor alternates: five pressure messages, then five
 * temperature messages. So a single transmission only ever half-describes the tire, and the app will show
 * whichever arrived. Anything other than those two message types is not this sensor at all.
 */
export const tpmsSmartire: RDevice = register({
  num: 343,
  name: 'SmarTire TPMS sensor, Aston Martin/Vantage DB9 protocol',
  what: 'tire pressure sensor',
  modulation: Modulation.OOK_PCM,
  shortWidth: 167,
  longWidth: 167,
  resetLimit: 1000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const pre = new Uint8Array([0x32, 0xb4]);
    const pos = bits.search(0, 0, pre, 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const decoded = new BitBuffer();
    bits.differentialManchesterDecode(0, pos + 16, decoded, 6 * 8);
    // The last bit never arrives, so six bytes less one is the whole message.
    if ((decoded.bitsPerRow[0] ?? 0) < 6 * 8 - 1) return DECODE_ABORT_LENGTH;

    const b = decoded.bb[0];
    if (crc7(b, 6, 0x45, 0x6f) !== 0) return DECODE_FAIL_MIC;

    const msgType = (b[1] & 0xc0) >> 6;
    const value = b[0] - 40;
    const data: R433Data = {
      model: 'SmarTire-AM',
      type: 'TPMS',
      id: String(((b[1] & 0x3f) << 16) | (b[2] << 8) | b[3]),
      flags: b[4] & 0x7f,
      mic: 'CRC',
    };
    if (msgType === 0) data.pressure_kPa = round1(value * 2.5);
    else if (msgType === 1) data.temperature_C = value;
    else return DECODE_ABORT_EARLY;
    if ((b[4] & 0x80) >> 7) data.inflate = 1;      // the tire is being pumped up right now
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Mercedes-Benz Sprinter (365)
// ---------------------------------------------------------------------------

export const tpmsMercedesBenz: RDevice = register({
  num: 365,
  name: 'Mercedes Benz Sprinter 4500 TPMS sensor',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 25,
  longWidth: 25,
  resetLimit: 2000,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const pre = new Uint8Array([0x00, 0x20]);      // twelve bits
    const pos = bits.search(0, 0, pre, 12);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] < 80) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, pos + 12, 80);
    if (crc8(b, 10, 0x2f, 0xaa) !== 0) return DECODE_FAIL_MIC;
    // Only two values of the first byte have ever been seen: parked, and moving.
    if (b[0] !== 0x83 && b[0] !== 0xa3) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'MercedesBenz-Sprinter',
      type: 'TPMS',
      id: hexOf(b.subarray(1), 4),
      pressure_PSI: round1(b[5] / 2.75),
      temperature_C: b[6] - 51,
      counter: b[7] & 0x1f,
      flags1: b[7] >> 5,
      flags2: b[8],
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Jeep (380)
// ---------------------------------------------------------------------------

function jeepDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.manchesterDecode(row, bitpos, packet, 88);
  if (packet.bitsPerRow[0] < 80) return DECODE_FAIL_SANITY;

  const b = packet.bb[0];
  // A tire at no pressure and no temperature at once is a receiver artefact rather than a reading.
  if (b[6] === 0 || b[7] === 0) return DECODE_ABORT_EARLY;

  let chk = 0;
  for (let i = 1; i <= 9; i++) chk ^= b[i];
  if (chk !== 0) return DECODE_FAIL_MIC;

  const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
  ctx.emit({
    model: 'Jeep',
    type: 'TPMS',
    id: hexLow(id, 8),
    state: hexLow(b[0], 2),                        // not covered by the checksum
    flags: b[5] >> 4,
    repeat: b[5] & 0x0f,
    pressure_kPa: Math.round(b[6] * 2.728),
    temperature_C: b[7] - 50,
    maybe_battery: b[8],
    mic: 'CHECKSUM',
  });
  return 1;
}

export const tpmsJeep: RDevice = register({
  num: 380,
  name: 'Jeep TPMS',
  what: 'tire pressure sensor: Grand Cherokee',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: BANDS,
  // The same bits on the air as the Citroen sensor already registered at 82, with nothing to tell them apart;
  // this one reports exactly double that one's pressure. Left off so both cannot claim every transmission.
  disabled: true,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xaa, 0xa9]);      // 55 55 55 56 once inverted
    bits.invert();
    let bitpos = 0, events = 0, ret = 0;
    while ((bitpos = bits.search(0, bitpos, pre, 16)) + 178 <= bits.bitsPerRow[0]) {
      ret = jeepDecode(bits, ctx, 0, bitpos + 16);
      if (ret > 0) events += ret;
      bitpos += 2;
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Honda (381)
// ---------------------------------------------------------------------------

/**
 * Honda's sensor starts every frame with a deliberate coding violation.
 *
 * The twenty-three bits before the payload end mid-pair on a transition a Manchester decoder cannot produce
 * on its own, which makes them unmistakable as a start marker — it has to sit at the very beginning of the
 * row rather than being searched for. The pressure bound at the end is not a sanity check on the sensor but a
 * way of standing aside for a different TRW board whose frames can otherwise fit this same shape.
 */
export const tpmsHonda: RDevice = register({
  num: 381,
  name: 'Honda (TRW PPA-GF33) TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 50,
  longWidth: 50,
  resetLimit: 200,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const marker = new Uint8Array([0xda, 0xe3, 0x54]);   // twenty-three bits, and only at the row's start
    if (bits.search(0, 0, marker, 23) !== 0) return DECODE_ABORT_EARLY;
    if (23 + 128 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    const packet = new BitBuffer();
    bits.manchesterDecode(0, 23, packet, 64);
    if (packet.bitsPerRow[0] < 64) return DECODE_ABORT_LENGTH;

    const b = packet.bb[0];
    if (crc8(b, 7, 0x07, 0x00) !== b[7]) return DECODE_FAIL_MIC;

    // A reading in this range belongs to a different TRW board, not to a tire this sensor is watching.
    if (b[0] > 0 && b[0] < 50) return DECODE_ABORT_EARLY;

    const id = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
    ctx.emit({
      model: 'Honda-TRW',
      type: 'TPMS',
      id: hexLow(id, 8),
      pressure_PSI: round1(b[0] * 0.2),
      temperature_C: b[1] - 50,
      flags: hexLow(b[6], 2),
      mic: 'CRC',
    });
    return 1;
  },
});
