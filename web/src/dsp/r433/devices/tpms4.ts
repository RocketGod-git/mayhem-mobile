/**
 * Eight more tire pressure sensors, this time the factory-fitted ones.
 *
 * Where the Schrader boards in `tpms3.ts` are aftermarket parts sold to fit many cars, these are the sensors a
 * manufacturer specified for its own models — Toyota, Hyundai, Porsche, Renault, Kia, Nissan, the Italian AVE
 * modules, and one aftermarket monitor for caravans and trailers. Almost all of them are FSK, and most hide
 * their frame behind a Manchester code of one kind or another.
 *
 * Three of them use *differential* Manchester, where the bit is carried by whether the level changes in the
 * middle of the symbol rather than by the level itself. That makes the frame immune to a receiver that decides
 * to invert, which is presumably the point, and it means the decoder has to find the clock before it can find
 * any data.
 *
 * Two of them — Hyundai and Renault — invert the whole buffer before searching, which is how rtl_433 does it
 * and how the decoders already in this tree do it. The runner takes its raw snapshot before any of this runs,
 * so the bits as they came off the air still survive for reporting.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `tpms_pmv107j.c`, `tpms_hyundai_vdo.c`, `tpms_porsche.c`,
 * `tpms_ave.c`, `tpms_renault_0435r.c`, `tpms_tyreguard400.c`, `tpms_kia.c`, `tpms_nissan.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { crc8, crc16, xorBytes } from '../util.js';

/** American cars transmit at 315 MHz, European ones at 433.92. */
const BANDS = [315000000, 433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const hexLow = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');

// ---------------------------------------------------------------------------
// Toyota PMV-107J (110)
// ---------------------------------------------------------------------------

/**
 * The Toyota sensor sends its pressure twice, the second copy bit-flipped.
 *
 * That is a stronger guard than the CRC on its own: a frame has to survive the check *and* agree with its own
 * mirror image, which is why this one is trusted despite a short preamble of only six bits.
 */
function pmv107jDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  const startPos = bits.differentialManchesterDecode(row, bitpos, packet, 70);   // 67 bits expected
  if (startPos - bitpos < 67 * 2) return 0;

  const b = new Uint8Array(9);
  b[0] = packet.bb[0][0] >> 6;                     // the first two bits, realigned
  packet.extractBytes(0, 2, b.subarray(1), 64);

  if (crc8(b, 8, 0x13, 0x00) !== b[8]) return 0;

  const pressure1 = b[5];
  const pressure2 = b[6] ^ 0xff;
  if (pressure1 !== pressure2) return 0;           // the two copies must agree

  const id = ((b[0] << 26) | (b[1] << 18) | (b[2] << 10) | (b[3] << 2) | (b[4] >> 6)) >>> 0;
  const status = b[4] & 0x3f;

  ctx.emit({
    model: 'PMV-107J',
    type: 'TPMS',
    id: hexLow(id, 8),
    status,
    battery_ok: (b[4] & 0x20) >> 5 ? 0 : 1,
    counter: (b[4] & 0x18) >> 3,
    rapid_change: (b[4] & 0x02) >> 1,
    failed: (b[4] & 0x01) ? 'FAIL' : 'OK',
    pressure_kPa: round1((pressure1 - 40) * 2.48),
    temperature_C: b[7] - 40,
    mic: 'CRC',
  });
  return 1;
}

export const tpmsPmv107j: RDevice = register({
  num: 110,
  name: 'PMV-107J (Toyota) TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 250,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xf8]);            // six bits of a seven-bit run-in
    let bitpos = 0, events = 0, ret = 0;
    while ((bitpos = bits.search(0, bitpos, pre, 6)) + 67 * 2 <= bits.bitsPerRow[0]) {
      ret = pmv107jDecode(bits, ctx, 0, bitpos + 6);
      if (ret > 0) events += ret;
      bitpos += 2;
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Hyundai VDO (186)
// ---------------------------------------------------------------------------

function hyundaiVdoDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.manchesterDecode(row, bitpos, packet, 80);
  if (packet.bitsPerRow[0] < 80) return DECODE_FAIL_SANITY;

  const b = packet.bb[0];
  if (crc8(b, 9, 0x07, 0xaa) !== b[9]) return 0;

  const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
  ctx.emit({
    model: 'Hyundai-VDO',
    type: 'TPMS',
    id: hexLow(id, 8),
    state: b[0],
    flags: b[5] >> 4,
    repeat: b[5] & 0x0f,
    pressure_kPa: Math.round(b[6] * 1.375),
    temperature_C: b[7] - 50,
    maybe_battery: b[8],
    mic: 'CRC',
  });
  return 1;
}

export const tpmsHyundaiVdo: RDevice = register({
  num: 186,
  name: 'Hyundai TPMS (VDO)',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xaa, 0xaa, 0xaa, 0xa9]);
    bits.invert();
    let bitpos = 0, events = 0, ret = 0;
    while ((bitpos = bits.search(0, bitpos, pre, 32)) + 80 <= bits.bitsPerRow[0]) {
      ret = hyundaiVdoDecode(bits, ctx, 0, bitpos + 32);
      if (ret > 0) events += ret;
      bitpos += 2;
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Porsche Boxster and Cayman (203)
// ---------------------------------------------------------------------------

function porscheDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.differentialManchesterDecode(row, bitpos, packet, 80);
  if (packet.bitsPerRow[0] < 80) return 0;

  const b = packet.bb[0];
  // The CRC covers its own bytes, so a good frame checks out to zero.
  if (crc16(b, 10, 0x1021, 0xffff) !== 0) return 0;

  const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  ctx.emit({
    model: 'Porsche',
    type: 'TPMS',
    id: hexLow(id, 8),
    pressure_kPa: Math.floor(b[4] * 5 / 2) - 100,
    temperature_C: b[5] - 40,
    flags: hexLow((b[6] << 8) | b[7], 4),
    mic: 'CRC',
  });
  return 1;
}

export const tpmsPorsche: RDevice = register({
  num: 203,
  name: 'Porsche Boxster/Cayman TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Twenty bits of a thirty-bit run-in, accepted either way up.
    //
    // Differential Manchester carries its data in transitions, so the frame itself reads the same whichever
    // polarity the demodulator settles on — but a preamble search does not. rtl_433 looks for one polarity
    // here and the opposite one for the AVE sensor below, which is the same run-in either way, so the choice
    // upstream is incidental rather than meaningful. The capture that project ships for this sensor is in
    // fact the other way up from the pattern it searches for, and only decodes once both are accepted.
    const patterns = [new Uint8Array([0x33, 0x33, 0x20]), new Uint8Array([0xcc, 0xcc, 0xd0])];
    let events = 0;
    for (const pre of patterns) {
      let bitpos = 0;
      while ((bitpos = bits.search(0, bitpos, pre, 20)) + 100 <= bits.bitsPerRow[0]) {
        events += porscheDecode(bits, ctx, 0, bitpos + 20);
        bitpos += 2;
      }
    }
    return events;
  },
});

// ---------------------------------------------------------------------------
// AVE (208)
// ---------------------------------------------------------------------------

/** Four calibrations, chosen by two bits in the frame — the same reading means four different pressures. */
const AVE_SCALE: { ratio: number; offset: number }[] = [
  { ratio: 2.352, offset: 47.0 },
  { ratio: 2.352, offset: 0.0 },
  { ratio: 5.491, offset: 18.2 },
  { ratio: 5.491, offset: 0.0 },
];

function aveDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.differentialManchesterDecode(row, bitpos, packet, 160);
  // Upstream indexes the decoded packet by the source row; only row zero is ever filled, so any later row
  // reads as empty and bails here exactly as it does upstream.
  if ((packet.bitsPerRow[row] ?? 0) < 64) return DECODE_ABORT_LENGTH;

  const b = packet.bb[row];
  if (crc8(b, 8, 0x31, 0xff) !== 0) return DECODE_FAIL_MIC;

  const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const mode = (b[6] >> 6) & 0x3;
  const batteryRaw = (b[6] >> 3) & 0x7;
  const { ratio, offset } = AVE_SCALE[mode];

  // Only the top two values mean anything; everything below is a healthy cell.
  let batteryPct = 100;
  if (batteryRaw === 6) batteryPct = 75;
  else if (batteryRaw === 7) batteryPct = 25;

  ctx.emit({
    model: 'AVE',
    type: 'TPMS',
    id: hexLow(id, 8),
    mode: `M${mode}`,
    pressure_kPa: round1((b[4] - offset) * ratio),
    temperature_C: b[5] - 50,
    battery_ok: batteryRaw !== 7 ? 1 : 0,
    battery_pct: batteryPct,
    flags: hexLow(b[6] & 0x7, 1),
    mic: 'CRC',
  });
  return 1;
}

export const tpmsAve: RDevice = register({
  num: 208,
  name: 'AVE TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 400,
  tolerance: 15,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xcc, 0xcc, 0xcc, 0xcd]);  // before the differential Manchester coding
    let events = 0, ret = 0;
    for (let row = 0; row < bits.numRows; row++) {
      let bitpos = 0;
      while ((bitpos = bits.search(0, bitpos, pre, 32)) + 132 <= bits.bitsPerRow[0]) {
        ret = aveDecode(bits, ctx, row, bitpos + 32);
        if (ret > 0) { events += ret; bitpos += 132; }
        bitpos += 31;
      }
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Renault 0435R (212)
// ---------------------------------------------------------------------------

function renault0435rDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.manchesterDecode(row, bitpos, packet, 160);
  if (packet.bitsPerRow[0] < 72) return DECODE_ABORT_EARLY;

  const b = packet.bb[0];
  if (xorBytes(b, 9) !== 0) return DECODE_FAIL_MIC;

  // The last byte is a counter with a flag in its top bit; anything outside that shape is not this sensor.
  const tick = b[8] & 0x7f;
  const hasTick = b[8] >> 7;
  if (b[8] && (!hasTick || tick > 30)) return DECODE_FAIL_SANITY;

  ctx.emit({
    model: 'Renault-0435R',
    type: 'TPMS',
    id: `${hexLow(b[0], 2)}${hexLow(b[1], 2)}${hexLow(b[2], 2)}`,
    flags: hexLow(b[3], 2),
    pressure_kPa: round1(b[4] / 0.75),
    temperature_C: b[5] - 50,
    // This sensor reports how hard the wheel is throwing it outward, which is how it knows the car is moving.
    centrifugal_acc: b[6] * 5,
    has_tick: hasTick,
    tick: tick - 0x80 * (1 - hasTick),
    mic: 'CHECKSUM',
  });
  return 1;
}

export const tpmsRenault0435r: RDevice = register({
  num: 212,
  name: 'Renault 0435R TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xaa, 0xa9]);      // 55 55 55 56 once inverted
    bits.invert();
    let events = 0, ret = 0;
    for (let row = 0; row < bits.numRows; row++) {
      let bitpos = 0;
      while ((bitpos = bits.search(row, bitpos, pre, 16)) + 160 <= bits.bitsPerRow[row]) {
        ret = renault0435rDecode(bits, ctx, row, bitpos + 16);
        if (ret > 0) events += ret;
        bitpos += 15;
      }
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// TyreGuard 400 (225)
// ---------------------------------------------------------------------------

const TYREGUARD400_BITS = 88;

/** The only OOK sensor here, and an aftermarket one: a caravan and trailer monitor rather than a fitted part. */
function tyreguard400Decode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const b = bits.bytes(row, bitpos, TYREGUARD400_BITS);
  // The sync word is inside the checked range, so a good frame checks out to zero.
  if (crc8(b, 11, 0x31, 0xdd) !== 0) return DECODE_FAIL_MIC;

  const flags = b[9];
  const id = (((b[3] & 0x0f) << 24) | (b[4] << 16) | (b[5] << 8) | b[6]) >>> 0;

  ctx.emit({
    model: 'TyreGuard400',
    type: 'TPMS',
    id: hexLow(id, 7),
    // The top bits of the flag byte are the pressure's high bits, so it reaches past a single byte.
    pressure_kPa: b[7] | ((flags & 0x70) << 4),
    temperature_C: b[8] - 40,
    peering_request: flags & 0x3,
    leaking: flags & 0x3,
    ack_leaking: flags & 0x8,
    mic: 'CRC',
  });
  return 1;
}

export const tpmsTyreguard400: RDevice = register({
  num: 225,
  name: 'TyreGuard 400 TPMS',
  what: 'tire pressure sensor: caravan and trailer monitor',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 100,
  longWidth: 100,
  gapLimit: 0,
  resetLimit: 500,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const sync = new Uint8Array([0xfd, 0x5f, 0xd5, 0xf0]);  // 28 bits, shifted so the payload lands on a byte
    let events = 0, ret = 0;
    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] < TYREGUARD400_BITS) continue;
      let bitpos = 0;
      while ((bitpos = bits.search(row, bitpos, sync, 28)) + TYREGUARD400_BITS <= bits.bitsPerRow[row]) {
        ret = tyreguard400Decode(bits, ctx, row, bitpos);   // the sync word is part of the checked frame
        if (ret > 0) events += ret;
        bitpos += TYREGUARD400_BITS;
      }
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Kia (226)
// ---------------------------------------------------------------------------

/**
 * Kia Rio and several Hyundai models.
 *
 * The frame is 154 bits, which is not a whole number of bytes, so the last three bits of the checked range fall
 * off the end of the transmission and are treated as zero — the sensor computes its CRC that way too.
 */
function kiaDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  const startPos = bits.manchesterDecode(row, bitpos, packet, 154 - 16);
  if (startPos - bitpos < 154 - 16) return DECODE_ABORT_LENGTH;

  const b = packet.bb[0];
  const crc = b[8] & ~0x07;
  if (crc8(b, 8, 0x07, 0x76) !== crc) return DECODE_FAIL_MIC;

  const pressure = ((b[0] << 4) | (b[1] >> 4)) & 0xff;
  const temperature = ((b[1] << 4) | (b[2] >> 4)) & 0xff;
  const id = ((b[2] << 28) | (b[3] << 20) | (b[4] << 12) | (b[5] << 4) | (b[6] >> 4)) >>> 0;

  let raw = '';
  for (let i = 0; i < 9; i++) raw += hexLow(b[i], 2);

  ctx.emit({
    model: 'Kia',
    type: 'TPMS',
    id: hexLow(id, 8),
    unknown1: hexLow(b[0] >> 4, 2),
    // Upstream holds this in a single byte, so the high half is dropped; kept the same way rather than
    // silently reporting a wider value than that project does.
    unknown2: hexLow(((b[6] << 8) | b[7]) & 0xff, 3),
    pressure_PSI: round1(pressure / 5),
    temperature_C: temperature - 50,
    // The manufacturer's own sensors are known to report outliers even on a good CRC, so the frame is kept.
    raw,
    mic: 'CRC',
  });
  return 1;
}

export const tpmsKia: RDevice = register({
  num: 226,
  name: 'Kia TPMS',
  what: 'tire pressure sensor: Kia Rio and some Hyundai',
  modulation: Modulation.FSK_PCM,
  shortWidth: 50,
  longWidth: 50,
  resetLimit: 200,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xed, 0x71]);
    let bitpos = 0, events = 0, ret = 0;
    while ((bitpos = bits.search(0, bitpos, pre, 16)) + 154 <= bits.bitsPerRow[0]) {
      ret = kiaDecode(bits, ctx, 0, bitpos + 16);
      if (ret > 0) events += ret;
      bitpos += 2;
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Nissan (248)
// ---------------------------------------------------------------------------

/**
 * Nissan's check is two bits, built by adding up overlapping shifts of each byte.
 *
 * Every byte is folded in five times at different offsets, so each bit of the frame lands in the sum more than
 * once — which is what makes two bits worth having at all.
 */
function nissanChecksum(b: Uint8Array): number {
  let chk = 0;
  for (let i = 0; i < 4; i++) {
    chk = (chk + (b[i] >> 7)) & 0xff;
    chk = (chk + (b[i] >> 5)) & 0xff;
    chk = (chk + (b[i] >> 3)) & 0xff;
    chk = (chk + (b[i] >> 1)) & 0xff;
    chk = (chk + ((b[i] << 1) & 0xff)) & 0xff;
  }
  chk = (chk + (b[4] >> 7)) & 0xff;
  chk = (chk + (b[4] >> 5)) & 0xff;
  chk = (chk + (b[4] >> 3)) & 0xff;
  return ~chk & 0x03;
}

function nissanDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const packet = new BitBuffer();
  bits.manchesterDecode(row, bitpos, packet, 113);
  if (packet.bitsPerRow[0] < 37) return DECODE_FAIL_SANITY;
  packet.invert();                                 // G. E. Thomas convention, not IEEE 802.3

  const b = packet.bb[0];
  if (nissanChecksum(b) !== 0) return DECODE_FAIL_MIC;

  const id = (((b[0] & 0x1f) << 19) | (b[1] << 11) | (b[2] << 3) | (b[3] >> 5)) >>> 0;
  const pressureRaw = ((b[3] & 0x1f) << 3) | (b[4] >> 5);

  ctx.emit({
    model: 'Nissan',
    type: 'TPMS',
    id: hexLow(id, 6),
    mode: b[0] >> 5,
    pressure_PSI: round1(pressureRaw / 4 - 3),
    unknown: (b[4] & 0x1f) >> 3,
    mic: 'CHECKSUM',
  });
  return 1;
}

export const tpmsNissan: RDevice = register({
  num: 248,
  name: 'Nissan TPMS',
  what: 'tire pressure sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 120,
  longWidth: 120,
  resetLimit: 250,
  bands: BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xf5, 0x55, 0x55, 0x55, 0xe0]);  // 36 bits
    let bitpos = 0, events = 0, ret = 0;
    while ((bitpos = bits.search(0, bitpos, pre, 36)) + 77 <= bits.bitsPerRow[0]) {
      ret = nissanDecode(bits, ctx, 0, bitpos + 36);
      if (ret > 0) events += ret;
      bitpos += 1;
    }
    return events > 0 ? events : ret;
  },
});
