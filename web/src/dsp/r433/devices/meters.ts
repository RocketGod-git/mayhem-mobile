/**
 * Utility meters: the radio modules bolted to electricity, gas and water meters across North America.
 *
 * Itron's ERT family and its successors report on 912–920 MHz, several times a minute, in clear. What comes out
 * is a serial number and a consumption count — a raw register reading rather than kilowatt-hours, because the
 * multiplier lives in the utility's billing system rather than in the meter's transmission. The interval
 * message goes further and carries the last several hours of consumption, one figure per interval, which is a
 * remarkably detailed picture of a household to broadcast unencrypted.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/ert_scm.c`, `scmplus.c`, `ert_idm.c`.
 */

import type { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { crc16 } from '../util.js';

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

/**
 * What the meter measures, from the low nibble of its type byte. The values are not grouped in any order —
 * they accumulated over decades of product lines.
 */
function meterType(ertType: number): string {
  switch (ertType & 0x0f) {
    case 4: case 5: case 7: case 8: return 'Electric';
    case 0: case 1: case 2: case 9: case 12: return 'Gas';
    case 3: case 11: case 13: return 'Water';
    default: return 'unknown';
  }
}

/**
 * The standard consumption message: ninety-six bits, no preamble worth finding.
 *
 * There is no sync word here — the message is identified purely by its CRC coming out right, and the fields are
 * then counted backwards from the end. That works because the CRC is over ten bytes, so a false match is rare.
 */
export const ertScm: RDevice = register({
  num: 149,
  name: 'ERT standard consumption message (SCM)',
  what: 'electricity, gas and water meters',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 30,
  longWidth: 0,
  resetLimit: 64,
  bands: [912600000, 915000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 96) return DECODE_ABORT_LENGTH;
    const b = bits.bb[0];
    if (!b[0] && !b[1] && !b[2] && !b[3]) return DECODE_FAIL_SANITY;
    if (crc16(b, 10, 0x6f63, 0, 2)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'ERT-SCM',
      id: ((b[2] & 0x06) << 23) | (b[7] << 16) | (b[8] << 8) | b[9],
      physical_tamper: (b[3] & 0xc0) >> 6,           // the meter has been moved or opened
      ert_type: (b[3] >> 2) & 0x0f,
      encoder_tamper: b[3] & 0x03,
      // A register reading, not a unit of energy: the multiplier is held by the utility, not the meter.
      consumption_data: (b[4] << 16) | (b[5] << 8) | b[6],
      mic: 'CRC',
    });
    return 1;
  },
});

/** The message that replaced it: a real sync word, a longer serial number and a wider consumption count. */
export const scmPlus: RDevice = register({
  num: 154,
  name: 'Standard consumption message plus (SCMplus)',
  what: 'electricity, gas and water meters, the newer message',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 30,
  longWidth: 0,
  resetLimit: 64,
  bands: [912600000, 915000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH;
    const at = bits.search(0, 0, new Uint8Array([0x16, 0xa3, 0x1e]), 24);
    if (at >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] - at < 128) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, at, 128);
    const crc = crc16(b, 12, 0x1021, 0x0971, 2);
    if (crc !== ((b[14] << 8) | b[15])) return DECODE_FAIL_MIC;

    const endpointId = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;
    ctx.emit({
      model: 'SCMplus',
      id: endpointId,
      ProtocolID: '0x' + hex2(b[2]),
      EndpointType: '0x' + hex2(b[3]),
      EndpointID: endpointId,
      Consumption: ((b[8] << 24) | (b[9] << 16) | (b[10] << 8) | b[11]) >>> 0,
      Tamper: '0x' + hex4((b[12] << 8) | b[13]),
      PacketCRC: '0x' + hex4(crc),
      MeterType: meterType(b[3]),
      mic: 'CRC',
    });
    return 1;
  },
});

/**
 * The interval data message: ninety-two bytes, most of it a history of consumption.
 *
 * A meter sending this is broadcasting the last several hours of a household's electricity use, one reading per
 * interval, with nothing protecting it but a CRC against interference. Two shapes exist — the ordinary one
 * carries forty-seven nine-bit intervals, the net-metering one twenty-seven fourteen-bit intervals to leave
 * room for generation as well as consumption.
 */
function idmDecode(bits: BitBuffer, ctx: DecodeCtx, net: boolean): number {
  if (bits.bitsPerRow[0] < 720) return DECODE_ABORT_LENGTH;
  const at = bits.search(0, 0, new Uint8Array([0x16, 0xa3, 0x1c]), 24);
  if (at >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
  if (bits.bitsPerRow[0] - at < 720) return DECODE_ABORT_LENGTH;

  const b = bits.bytes(0, at, 720);
  const packetCrc = (b[88] << 8) | b[89];
  if (crc16(b, 86, 0x1021, 0xd895, 2) !== packetCrc) return DECODE_FAIL_MIC;

  const run = (from: number, count: number) => {
    let s = '0x';
    for (let i = 0; i < count; i++) s += hex2(b[from + i]);
    return s;
  };

  const ertType = b[6];
  const serial = ((b[7] << 24) | (b[8] << 16) | (b[9] << 8) | b[10]) >>> 0;
  const common: Record<string, unknown> = {
    id: serial,
    PacketTypeID: '0x' + hex2(b[2]),
    PacketLength: b[3],
    ApplicationVersion: b[5],
    ERTType: '0x' + hex2(ertType),
    ERTSerialNumber: serial,
    ConsumptionIntervalCount: b[11],
    ModuleProgrammingState: b[12],
    TamperCounters: run(13, 6),
    TransmitTimeOffset: (b[84] << 8) | b[85],
    MeterIdCRC: (b[86] << 8) | b[87],
    PacketCRC: packetCrc,
    MeterType: meterType(ertType),
    mic: 'CRC',
  };

  const intervals: number[] = [];
  if (net) {
    // Twenty-seven readings of fourteen bits each, so they do not sit on byte boundaries.
    let pos = at + 36 * 8;
    for (let j = 0; j < 27; j++) {
      const buf = bits.bytes(0, pos, 14);
      intervals.push((buf[0] << 6) | (buf[1] >> 2));
      pos += 14;
    }
    ctx.emit({
      model: 'NETIDM', ...common,
      Unknown_field_1: run(19, 7),
      LastGenerationCount: ((b[26] << 16) | (b[27] << 8) | b[28]) >>> 0,
      Unknown_field_2: run(29, 3),
      LastConsumptionNet: ((b[32] << 24) | (b[33] << 16) | (b[34] << 8) | b[35]) >>> 0,
      DifferentialConsumptionIntervals: intervals,
    });
  } else {
    // Forty-seven readings of nine bits each.
    let pos = at + 31 * 8;
    for (let j = 0; j < 47; j++) {
      const buf = bits.bytes(0, pos, 9);
      intervals.push((buf[0] << 1) | (buf[1] >> 7));
      pos += 9;
    }
    ctx.emit({
      model: 'IDM', ...common,
      AsynchronousCounters: (b[19] << 8) | b[20],
      PowerOutageFlags: run(21, 6),
      LastConsumptionCount: ((b[27] << 24) | (b[28] << 16) | (b[29] << 8) | b[30]) >>> 0,
      DifferentialConsumptionIntervals: intervals,
    });
  }
  return 1;
}

export const ertIdm: RDevice = register({
  num: 160,
  name: 'ERT interval data message (IDM)',
  what: 'meters reporting several hours of consumption history at a time',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 30,
  longWidth: 0,
  gapLimit: 20000,
  resetLimit: 20000,
  bands: [912600000, 915000000],
  decode: (_d, bits, ctx) => idmDecode(bits, ctx, false),
});

export const ertNetIdm: RDevice = register({
  num: 161,
  name: 'ERT interval data message (IDM) for net meters',
  what: 'meters that measure generation as well as consumption',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 30,
  longWidth: 0,
  gapLimit: 20000,
  resetLimit: 20000,
  bands: [912600000, 915000000],
  decode: (_d, bits, ctx) => idmDecode(bits, ctx, true),
});
