/**
 * Wireless M-Bus — the radio link that European utility meters use to report themselves.
 *
 * Water, gas, heat and electricity meters across Europe carry a small 868 MHz transmitter that sends a short
 * telegram every few seconds to minutes. Unlike almost everything else in this app, M-Bus is a layered
 * standard rather than one vendor's frame: a physical layer that differs per mode, a link layer that is the
 * same everywhere, and an application layer of typed consumption records on top.
 *
 * What is decoded here is the link layer — which is the part that identifies the meter. Every telegram names
 * its manufacturer as a three-letter code, its serial number, its version and what kind of meter it is, and
 * every block is closed by its own CRC, so a frame that reports at all is a frame that checked out. The
 * consumption records above that are NOT decoded: they are a large table of unit and scaling codes, and a
 * half-ported version of it would print confident numbers in the wrong units. The payload is reported as hex
 * instead, and the header fields that say whether it is encrypted are reported honestly.
 *
 * The five modes differ only in how the bits arrive. Mode T encodes every byte as twelve bits, three ones in
 * every six, so a corrupted symbol is detectable rather than silently wrong. Mode C sends plain bytes and
 * picks format A or B by a byte after the preamble. Mode S is Manchester-coded. Modes R and F run on
 * frequencies outside the usual allocation, so rtl_433 ships them switched off. Here they still run — this
 * app would rather report a doubtful reading than miss a real one — and are marked as worth a second look.
 *
 * The RADIAN meter at the end is a different animal that happens to live in the same file upstream: a French
 * meter that speaks UART framing over FSK and wraps a complete wired M-Bus telegram inside its payload.
 *
 * Ported from rtl_433's `src/devices/m_bus.c` (GPL-2.0-or-later).
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc16, crc16lsb, extractBytesUart8n2 } from '../util.js';

/** Block 1 is twelve bytes in format A and ten in format B; block 2 tops out at 118. */
const BLOCK1A_SIZE = 12;
const BLOCK1B_SIZE = 10;
const BLOCK2B_SIZE = 118;
/** Enough for the longest telegram either format can carry. */
const BUF_SIZE = 512;

const hex2 = (v: number) => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v: number) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
const hexBytes = (m: Uint8Array, n: number) => {
  let s = '';
  for (let i = 0; i < n && i < m.length; i++) s += m[i].toString(16).padStart(2, '0');
  return s;
};
/** Serial numbers travel as binary-coded decimal, two digits to the byte. */
const bcd2int = (b: number) => (b >> 4) * 10 + (b & 0x0f);

/** Read a byte that need not be byte-aligned. */
function byteAt(m: Uint8Array, off: number): number {
  const i = off >> 3, s = off & 7;
  if (!s) return m[i] ?? 0;
  return ((((m[i] ?? 0) << 8) | (m[i + 1] ?? 0)) >> (8 - s)) & 0xff;
}

/** Three letters packed five bits each, offset from '@'. */
function manufDecode(mField: number): string {
  return String.fromCharCode(
    ((mField >> 10) & 0x1f) + 0x40,
    ((mField >> 5) & 0x1f) + 0x40,
    (mField & 0x1f) + 0x40,
  );
}

/** What the device-type byte says the meter measures. */
function deviceTypeStr(t: number): string {
  switch (t) {
    case 0x00: return 'Other';
    case 0x01: return 'Oil';
    case 0x02: return 'Electricity';
    case 0x03: return 'Gas';
    case 0x04: return 'Heat';
    case 0x05: return 'Steam';
    case 0x06: return 'Warm Water';
    case 0x07: return 'Water';
    case 0x08: return 'Heat Cost Allocator';
    case 0x09: return 'Compressed Air';
    case 0x0a: case 0x0b: return 'Cooling load meter';
    case 0x0c: return 'Heat';
    case 0x0d: return 'Heat/Cooling load meter';
    case 0x0e: return 'Bus/System component';
    case 0x0f: return 'Unknown';
    case 0x15: return 'Hot Water';
    case 0x16: return 'Cold Water';
    case 0x17: return 'Hot/Cold Water meter';
    case 0x18: return 'Pressure';
    case 0x19: return 'A/D Converter';
    case 0x1a: return 'Smoke detector';
    case 0x1b: return 'Room sensor';
    case 0x1c: return 'Gas detector';
    case 0x20: return 'Breaker (electricity)';
    case 0x21: return 'Valve (gas or water)';
    case 0x25: return 'Customer unit (display device)';
    case 0x28: return 'Waste water meter';
    case 0x29: return 'Garbage';
    case 0x2a: return 'Carbon dioxide';
    case 0x31: return 'Communication controller';
    case 0x32: return 'Unidirectional repeater';
    case 0x33: return 'Bidirectional repeater';
    case 0x36: return 'Radio converter (system side)';
    case 0x37: return 'Radio converter (meter side)';
    default: return '';
  }
}

/**
 * Mode T's line code: every nibble travels as six bits with exactly three of them set.
 *
 * Anything not in the table is a symbol that cannot legally have been sent, so it is flagged rather than
 * guessed at — the caller reports how many bytes ran clean before the first bad one.
 */
function decode3of6(byte: number): number {
  switch (byte) {
    case 22: return 0x00;
    case 13: return 0x01;
    case 14: return 0x02;
    case 11: return 0x03;
    case 28: return 0x04;
    case 25: return 0x05;
    case 26: return 0x06;
    case 19: return 0x07;
    case 44: return 0x08;
    case 37: return 0x09;
    case 38: return 0x0a;
    case 35: return 0x0b;
    case 52: return 0x0c;
    case 49: return 0x0d;
    case 50: return 0x0e;
    case 41: return 0x0f;
    default: return 0xf0;                          // not a legal symbol
  }
}

/**
 * Walk a row of 3-of-6 symbols into bytes.
 *
 * A bad symbol is taken as a zero nibble rather than abandoning the frame, because the per-block CRC below is
 * the real arbiter — letting it fail gives a better answer than bailing out on the first marginal bit.
 * Returns how many bytes decoded cleanly before the first bad symbol.
 */
function decode3of6Buffer(bits: Uint8Array, bitOffset: number, out: Uint8Array, numBytes: number): number {
  let contiguous = -1;
  const n = Math.min(numBytes, out.length);
  for (let i = 0; i < n; i++) {
    const hi = decode3of6(byteAt(bits, i * 12 + bitOffset) >> 2);
    let lo = decode3of6(byteAt(bits, i * 12 + bitOffset + 6) >> 2);
    if (hi > 0x0f || lo > 0x0f) {
      lo &= 0x0f;
      if (contiguous < 0) contiguous = i;
    }
    out[i] = ((hi << 4) | lo) & 0xff;
  }
  return contiguous < 0 ? n : contiguous;
}

/** Every block carries its own CRC: the M-Bus polynomial, complemented, stored big-endian. */
function crcValid(b: Uint8Array, at: number, n: number): boolean {
  if (n < 0 || at + n + 1 >= b.length) return false;
  const calc = (~crc16(b, n, 0x3d65, 0, at)) & 0xffff;
  const read = ((b[at + n] << 8) | b[at + n + 1]) & 0xffff;
  return calc === read;
}

interface MBusData { length: number; data: Uint8Array }
const newData = (): MBusData => ({ length: 0, data: new Uint8Array(BUF_SIZE) });

interface MBusBlock2 {
  CI: number; AC: number; ST: number; CW: number; plOffset: number;
  ellCi: number; ellCc: number; ellAcc: number; ellSecMode: number;
  knxCtrl: number; src: number; dst: number; lNpci: number; tpci: number; apci: number;
  qdsWalkBy: number;
}
interface MBusBlock1 {
  L: number; C: number; mStr: string;
  aId: number; aVersion: number; aDevType: number;
  knxMode: boolean; knxSn: Uint8Array;
  block2: MBusBlock2;
}
const newBlock2 = (): MBusBlock2 => ({
  CI: 0, AC: 0, ST: 0, CW: 0, plOffset: 0,
  ellCi: 0, ellCc: 0, ellAcc: 0, ellSecMode: 0,
  knxCtrl: 0, src: 0, dst: 0, lNpci: 0, tpci: 0, apci: 0, qdsWalkBy: 0,
});
const newBlock1 = (): MBusBlock1 => ({
  L: 0, C: 0, mStr: '', aId: 0, aVersion: 0, aDevType: 0,
  knxMode: false, knxSn: new Uint8Array(6),
  block2: newBlock2(),
});

/** How long the extended link layer's sub-header is, by its control byte. Negative means this is not one. */
function ellLen(ci: number): number {
  switch (ci) {
    case 0x8c: return 2;
    case 0x8d: return 8;
    case 0x8e: return 10;
    case 0x8f: return 16;
    default: return -1;
  }
}

/**
 * Work out where the payload starts, stepping over whatever optional layers sit in front of it.
 *
 * A telegram may carry an extended link layer, then an authentication layer, then the transport layer that
 * actually says where the records begin. Each names its own length, so they can be skipped without decoding
 * them. When a layer says the payload is encrypted the walk stops there and `plOffset` stays zero, which is
 * how the caller knows it must not try to read records out of it.
 */
function parseCi(b: Uint8Array, at: number, remaining: number, plBase: number, b2: MBusBlock2, depth = 0): void {
  if (remaining < 1 || depth > 4) return;
  b2.CI = b[at] ?? 0;

  const el = ellLen(b2.CI);
  if (el >= 0) {
    if (remaining < 1 + el) return;                // truncated capture, leave plOffset at zero
    b2.ellCi = b2.CI;
    b2.ellCc = b[at + 1] ?? 0;
    b2.ellAcc = b[at + 2] ?? 0;

    if (b2.CI === 0x8d || b2.CI === 0x8f) {
      const snOff = b2.CI === 0x8f ? 11 : 3;       // after M2/A2/VER/TYPE when those are present
      const sn = ((b[at + snOff] ?? 0) | ((b[at + snOff + 1] ?? 0) << 8)
        | ((b[at + snOff + 2] ?? 0) << 16) | ((b[at + snOff + 3] ?? 0) << 24)) >>> 0;
      b2.ellSecMode = (sn >>> 29) & 0x7;
    } else {
      b2.ellSecMode = 0;                           // ELL I and III carry no session number
    }
    if (b2.ellSecMode !== 0) return;               // encrypted, or a mode we do not know: stop here

    // Not encrypted, so the real transport-layer control byte follows this sub-header.
    parseCi(b, at + 1 + el, remaining - 1 - el, plBase + 1 + el, b2, depth + 1);
    return;
  }

  // The authentication and fragmentation layer carries an explicit length, so it can be stepped over whole.
  if (b2.CI === 0x90) {
    if (remaining < 2) return;
    const aflLen = b[at + 1] ?? 0;
    if (remaining < 2 + aflLen) return;
    parseCi(b, at + 2 + aflLen, remaining - 2 - aflLen, plBase + 2 + aflLen, b2, depth + 1);
    return;
  }

  if (b2.CI === 0x7a) {                            // short transport layer
    b2.AC = b[at + 1] ?? 0;
    b2.ST = b[at + 2] ?? 0;
    b2.CW = (((b[at + 4] ?? 0) << 8) | (b[at + 3] ?? 0)) & 0xffff;
    b2.plOffset = plBase + 5;
  } else if (b2.CI === 0x72) {                     // long: the same fields behind an eight-byte address
    b2.AC = b[at + 9] ?? 0;
    b2.ST = b[at + 10] ?? 0;
    b2.CW = (((b[at + 12] ?? 0) << 8) | (b[at + 11] ?? 0)) & 0xffff;
    b2.plOffset = plBase + 13;
  } else if (b2.CI === 0x78) {                     // none at all: records start right after the control byte
    b2.plOffset = plBase + 1;
  }

  // Qundis walk-by reuses that same control byte with a fixed layout of its own.
  if (b2.CI === 0x78 && b[at + 1] === 0x0d && b[at + 2] === 0xff && b[at + 3] === 0x5f && b[at + 4] === 0x35) {
    b2.AC = b[at + 7] ?? 0;
    b2.ST = b[at + 5] ?? 0;
    b2.CW = (((b[at + 9] ?? 0) << 8) | (b[at + 8] ?? 0)) & 0xffff;
    b2.plOffset = plBase + 1;
    b2.qdsWalkBy = 1;
  }
}

function parseBlock2(inp: MBusData, b1: MBusBlock1, block1Size: number, plBase: number): void {
  const b = inp.data;
  if (b1.knxMode) {
    b1.block2.knxCtrl = b[block1Size] ?? 0;
    b1.block2.src = (((b[block1Size + 1] ?? 0) << 8) | (b[block1Size + 2] ?? 0)) & 0xffff;
    b1.block2.dst = (((b[block1Size + 3] ?? 0) << 8) | (b[block1Size + 4] ?? 0)) & 0xffff;
    b1.block2.lNpci = b[block1Size + 5] ?? 0;
    b1.block2.tpci = b[block1Size + 6] ?? 0;
    b1.block2.apci = b[block1Size + 7] ?? 0;
  } else {
    const remaining = inp.length > block1Size ? inp.length - block1Size : 0;
    parseCi(b, block1Size, remaining, plBase, b1.block2);
  }
}

/**
 * Format A: block 1, then as many sixteen-byte data blocks as the length calls for, each closed by a CRC.
 *
 * The CRC bytes are dropped as the blocks are concatenated, so what comes out is the telegram as the meter
 * meant it rather than as it was framed.
 */
function decodeFormatA(inp: MBusData, out: MBusData, b1: MBusBlock1): boolean {
  const d = inp.data;
  b1.L = d[0];
  b1.C = d[1];

  // KNX-RF puts fixed values where the manufacturer would be, and a six-byte serial after it.
  if (d[2] === 0xff && d[3] === 0x03) {
    b1.knxMode = true;
    b1.knxSn.set(d.subarray(4, 10));
  } else {
    b1.mStr = manufDecode(((d[3] << 8) | d[2]) & 0xffff);
    b1.aId = bcd2int(d[7]) * 1000000 + bcd2int(d[6]) * 10000 + bcd2int(d[5]) * 100 + bcd2int(d[4]);
    b1.aVersion = d[8];
    b1.aDevType = d[9];
  }

  out.length = b1.L - 9 + BLOCK1A_SIZE - 2;
  if (!crcValid(d, 0, 10)) return false;

  const numDataBlocks = Math.floor((b1.L - 9 + 15) / 16);
  if (b1.L < 9 || (b1.L - 9) + numDataBlocks * 2 > inp.length - BLOCK1A_SIZE) return false;

  out.data.set(d.subarray(0, BLOCK1A_SIZE - 2), 0);
  for (let n = 0; n < numDataBlocks; n++) {
    const inAt = BLOCK1A_SIZE + n * 18;            // eighteen bytes a block: sixteen of data and two of CRC
    const outAt = n * 16 + BLOCK1A_SIZE - 2;
    const blockSize = Math.min(b1.L - 9 - n * 16, 16) + 2;
    if (blockSize < 2 || outAt + blockSize > BUF_SIZE) return false;
    if (!crcValid(d, inAt, blockSize - 2)) return false;
    out.data.set(d.subarray(inAt, inAt + blockSize), outAt);
  }

  parseBlock2(inp, b1, BLOCK1A_SIZE, BLOCK1A_SIZE - 2);
  return true;
}

/** Format B: one CRC over block 1 and 2 together, and a third block for long telegrams. */
function decodeFormatB(inp: MBusData, out: MBusData, b1: MBusBlock1): boolean {
  const d = inp.data;
  b1.L = d[0];
  b1.C = d[1];
  b1.mStr = manufDecode(((d[3] << 8) | d[2]) & 0xffff);
  b1.aId = bcd2int(d[7]) * 1000000 + bcd2int(d[6]) * 10000 + bcd2int(d[5]) * 100 + bcd2int(d[4]);
  b1.aVersion = d[8];
  b1.aDevType = d[9];

  out.length = b1.L - (9 + 2) + BLOCK1B_SIZE - 2;
  // Here the length byte counts every byte except itself.
  if (b1.L < 12 || b1.L + 1 > inp.length) return false;
  if (!crcValid(d, 0, Math.min(b1.L - 1, (BLOCK1B_SIZE + BLOCK2B_SIZE) - 2))) return false;

  const take = Math.min(b1.L - 11, BLOCK2B_SIZE - 2) + BLOCK1B_SIZE;
  out.data.set(d.subarray(0, Math.max(0, Math.min(take, BUF_SIZE))), 0);

  const L_OFFSET = BLOCK1B_SIZE + BLOCK2B_SIZE - 1;
  if (b1.L > L_OFFSET + 2) {                       // a third block, beyond the two extra CRC bytes
    const n = b1.L - L_OFFSET - 2;
    if (!crcValid(d, BLOCK1B_SIZE + BLOCK2B_SIZE, n)) return false;
    out.data.set(d.subarray(BLOCK2B_SIZE, BLOCK2B_SIZE + n), BLOCK2B_SIZE - 2);
    out.length -= 2;
  }
  out.length += 2;                                 // keep the final CRC, so a decrypting tool can check it

  parseBlock2(inp, b1, BLOCK1B_SIZE, BLOCK1B_SIZE);
  return true;
}

/** Report the meter's identity, the header fields, and the payload as hex. */
function emitMBus(ctx: DecodeCtx, out: MBusData, b1: MBusBlock1, mode: string): number {
  const b2 = b1.block2;
  let data: R433Data;

  if (b1.knxMode) {
    data = {
      model: 'KNX-RF',
      type: 'Meter',
      mode,
      id: hexBytes(b1.knxSn, 6).toUpperCase(),
      sn: hexBytes(b1.knxSn, 6),
      knx_ctrl: hex2(b2.knxCtrl),
      src: hex4(b2.src),
      dst: hex4(b2.dst),
      l_npci: hex2(b2.lNpci),
      tpci: hex2(b2.tpci),
      apci: hex2(b2.apci),
    };
  } else {
    data = {
      model: 'Wireless-MBus',
      type: 'Meter',
      mode,
      manufacturer: b1.mStr,
      id: String(b1.aId),
      version: b1.aVersion,
      device_type: hex2(b1.aDevType),
      device_type_string: deviceTypeStr(b1.aDevType),
      control: hex2(b1.C),
    };
  }

  const n = Math.max(0, Math.min(out.length, BUF_SIZE));
  data.data = hexBytes(out.data, n);

  if (b2.ellCi) {
    data.ell_ci = hex2(b2.ellCi);
    data.ell_cc = hex2(b2.ellCc);
    data.ell_acc = hex2(b2.ellAcc);
  }
  if (b2.CI && b2.CI !== b2.ellCi) {
    data.CI = hex2(b2.CI);
    if (b2.plOffset) {
      data.AC = hex2(b2.AC);
      data.ST = hex2(b2.ST);
      data.CW = hex4(b2.CW);
    }
  }
  if (b2.qdsWalkBy) data.qds_walk_by = 1;

  // The records themselves are not decoded, so say plainly when the reason is that they are locked away.
  if (!b1.knxMode && !b2.plOffset) {
    if (b2.ellCi && b2.ellSecMode) data.payload_encrypted = 1;
  } else if (b2.CW & 0x0500) {
    data.payload_encrypted = 1;
  }

  data.mic = 'CRC';
  ctx.emit(data);
  return 1;
}

const PREAMBLE_T = new Uint8Array([0x54, 0x3d]);
const PREAMBLE_RA = new Uint8Array([0x55, 0x54, 0x76, 0x96]);
const PREAMBLE_F = new Uint8Array([0x55, 0xf6]);
const PREAMBLE_S = new Uint8Array([0x54, 0x76, 0x96]);
const PREAMBLE_T_DN = new Uint8Array([0xaa, 0xab, 0x32]);

/**
 * Modes C and T share a preamble and are told apart by the byte after it.
 *
 * Mode C then names its format with one more byte; anything else is mode T, whose bytes are 3-of-6 coded and
 * always format A.
 */
function modeCtDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  const n = bits.bitsPerRow[0];
  if (n < 32 + 13 * 8 || n > 64 + 256 * 12) return DECODE_ABORT_LENGTH;

  let at = bits.search(0, 0, PREAMBLE_T, 16);
  if (at + 13 * 8 >= n) return DECODE_ABORT_EARLY;
  at += 16;

  const row = bits.bb[0];
  const inp = newData(), out = newData(), b1 = newBlock1();
  let next = byteAt(row, at);
  at += 8;
  let mode: string;

  if (next === 0x54) {
    mode = 'C';
    next = byteAt(row, at);
    at += 8;
    inp.length = Math.min(Math.floor((n - at) / 8), BUF_SIZE);
    if (next === 0xcd) {                           // format A
      bits.extractBytes(0, at, inp.data, inp.length * 8);
      if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY;
    } else if (next === 0x3d) {                    // format B
      bits.extractBytes(0, at, inp.data, inp.length * 8);
      if (!decodeFormatB(inp, out, b1)) return DECODE_FAIL_SANITY;
    } else {
      return DECODE_ABORT_EARLY;                   // a format we do not know
    }
  } else {
    mode = 'T';
    at -= 8;                                       // that byte was payload, not a mode marker
    inp.length = Math.min(Math.floor((n - at) / 12), BUF_SIZE);
    if (decode3of6Buffer(row, at, inp.data, inp.length) < 0) return DECODE_FAIL_SANITY;
    if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY;
  }

  return emitMBus(ctx, out, b1, mode);
}

/** Mode S, Manchester-coded, always format A. Mode T's downlink shares the band and is stepped around. */
function modeSDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  const n = bits.bitsPerRow[0];
  if (n < 32 + 13 * 8 || n > 64 + 256 * 8) return DECODE_ABORT_LENGTH;

  // A downlink telegram is the base station talking, not a meter; recognize it and leave it alone.
  const dn = bits.search(0, 0, PREAMBLE_T_DN, 24);
  if (dn + 24 < n) return DECODE_ABORT_EARLY;

  let at = bits.search(0, 0, PREAMBLE_S, 24);
  at += 24;
  if (at >= n) return DECODE_ABORT_EARLY;

  const packet = new BitBuffer();
  bits.manchesterDecode(0, at, packet, 800);
  const decodedBits = packet.bitsPerRow[0] ?? 0;
  if (decodedBits < BLOCK1A_SIZE * 8) return DECODE_ABORT_LENGTH;

  const inp = newData(), out = newData(), b1 = newBlock1();
  // rtl_433 passes the raw row's bit count here as though it were a byte count. What the sufficiency check in
  // format A actually wants is how many bytes came out of the Manchester decode, which is what is used.
  inp.length = Math.min(decodedBits >> 3, BUF_SIZE);
  packet.extractBytes(0, 0, inp.data, inp.length * 8);

  if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY;
  return emitMBus(ctx, out, b1, 'S');
}

/** Mode R: a longer preamble, plain bytes, format A only. */
function modeRDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  const n = bits.bitsPerRow[0];
  if (n < 32 + 13 * 8 || n > 64 + 256 * 8) return DECODE_ABORT_LENGTH;

  let at = bits.search(0, 0, PREAMBLE_RA, 32);
  if (at + 13 * 8 >= n) return DECODE_ABORT_EARLY;
  at += 32;

  const inp = newData(), out = newData(), b1 = newBlock1();
  inp.length = Math.min(Math.floor((n - at) / 8), BUF_SIZE);
  bits.extractBytes(0, at, inp.data, inp.length * 8);

  if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY;
  return emitMBus(ctx, out, b1, 'R');
}

/**
 * Mode F: recognized, but its payload framing has never been confirmed.
 *
 * rtl_433 has carried this one for years with no sample to check it against, and stops after reading the
 * format byte without reporting anything. Reporting the sighting is more useful than silence — a meter really
 * is transmitting — but with no CRC behind it the claim is kept to what was actually verified: a two-byte
 * preamble and a known format byte, with no `mic`. rtl_433 ships this one switched off, which here marks
 * anything it says as worth a second look rather than silencing it.
 */
function modeFDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  const n = bits.bitsPerRow[0];
  if (n < 32 + 13 * 8 || n > 64 + 256 * 8) return DECODE_ABORT_LENGTH;

  let at = bits.search(0, 0, PREAMBLE_F, 16);
  if (at + 13 * 8 >= n) return DECODE_ABORT_EARLY;
  at += 16;

  const next = byteAt(bits.bb[0], at);
  if (next !== 0x8d && next !== 0x72) return DECODE_ABORT_EARLY;

  ctx.emit({
    model: 'Wireless-MBus',
    type: 'Meter',
    mode: 'F',
    format: next === 0x8d ? 'A' : 'B',
    note: 'preamble and format byte recognized; payload framing unverified upstream',
  });
  return 1;
}

export const mBusModeCT: RDevice = register({
  num: 104,
  name: 'Wireless M-Bus, Mode C&T, 100kbps',
  what: 'utility meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 10,                                  // 100 kb/s, NRZ, so bit width is pulse width
  longWidth: 10,
  resetLimit: 500,
  bands: [868950000],
  decode: (_dev, bits, ctx) => modeCtDecode(bits, ctx),
});

export const mBusModeS: RDevice = register({
  num: 105,
  name: 'Wireless M-Bus, Mode S, 32.768kbps',
  what: 'utility meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 1000 / 32.768,                       // about 31 us a bit
  longWidth: 1000 / 32.768,
  resetLimit: (1000 / 32.768) * 9,
  bands: [868300000],
  decode: (_dev, bits, ctx) => modeSDecode(bits, ctx),
});

export const mBusModeR: RDevice = register({
  num: 106,
  name: 'Wireless M-Bus, Mode R, 4.8kbps',
  what: 'utility meter',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 1000 / 4.8 / 2,                      // clock half period, about 104 us
  longWidth: 0,
  resetLimit: (1000 / 4.8) * 1.5,
  bands: [868330000],
  disabled: true,                                  // runs on a non-standard frequency
  decode: (_dev, bits, ctx) => modeRDecode(bits, ctx),
});

export const mBusModeF: RDevice = register({
  num: 107,
  name: 'Wireless M-Bus, Mode F, 2.4kbps',
  what: 'utility meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 1000 / 2.4,                          // about 417 us
  longWidth: 1000 / 2.4,
  resetLimit: 5000,
  bands: [433820000],
  disabled: true,                                  // non-standard frequency, and never confirmed on air
  decode: (_dev, bits, ctx) => modeFDecode(bits, ctx),
});

export const mBusModeCTDownlink: RDevice = register({
  num: 238,
  name: 'Wireless M-Bus, Mode T, 32.768kbps (downlink)',
  what: 'utility meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 1000 / 32.768,
  longWidth: 1000 / 32.768,
  resetLimit: (1000 / 32.768) * 9,
  bands: [868300000],
  decode: (_dev, bits, ctx) => modeCtDecode(bits, ctx),
});

// ---------------------------------------------------------------------------
// RADIAN / RADIAN0 meter
// ---------------------------------------------------------------------------

const RADIAN_MAX_FRAME_BYTES = 256;
const RADIAN_MIN_FRAME_BYTES = 6;
/** The sync tail: a run of lows then idle highs, which the UART framing then walks off. */
const RADIAN_SYNC = new Uint8Array([0x0f, 0xff, 0xff, 0xff, 0xf0]);

function radianControlString(control: number): string {
  switch (control) {
    case 0x06: return 'ack';
    case 0x10: return 'request';
    case 0x11: return 'response';
    default: return 'unknown';
  }
}

/**
 * Find the wired M-Bus telegram inside a RADIAN body.
 *
 * It is framed START, length, length again, START, then the telegram and a checksum and a stop byte. Those
 * repeated and self-checking markers are what it is found by, rather than trusting a fixed offset.
 * Returns where the control byte sits and how many bytes the telegram declares.
 */
function radianFindWmbusFrame(body: Uint8Array, bodyLen: number): { at: number; len: number } | null {
  for (let i = 0; i + 4 <= bodyLen; i++) {
    if (body[i] !== 0x68 || body[i + 3] !== 0x68 || body[i + 1] !== body[i + 2]) continue;
    const wlen = body[i + 1];
    if (i + 4 + wlen + 2 > bodyLen) continue;      // its own length runs off the end
    const at = i + 4;
    let sum = 0;
    for (let j = 0; j < wlen; j++) sum = (sum + body[at + j]) & 0xff;
    if (sum !== body[at + wlen] || body[at + wlen + 1] !== 0x16) continue;
    return { at, len: wlen };
  }
  return null;
}

function radianDecodeRow(bits: BitBuffer, ctx: DecodeCtx, row: number): number {
  const rowBits = bits.bitsPerRow[row];
  let pos = bits.search(row, 0, RADIAN_SYNC, 36);
  if (pos >= rowBits) return DECODE_ABORT_EARLY;
  pos += 36;
  if (pos >= rowBits) return DECODE_ABORT_LENGTH;

  const frame = new Uint8Array(RADIAN_MAX_FRAME_BYTES);
  const maxBits = Math.min(rowBits - pos, RADIAN_MAX_FRAME_BYTES * 11);
  const frameLen = extractBytesUart8n2(bits.bb[row], pos, maxBits, frame);
  if (frameLen < RADIAN_MIN_FRAME_BYTES) return DECODE_ABORT_LENGTH;

  const declared = frame[0];
  if (declared < RADIAN_MIN_FRAME_BYTES || declared > RADIAN_MAX_FRAME_BYTES) return DECODE_FAIL_SANITY;
  if (frameLen < declared) return DECODE_ABORT_LENGTH;

  const crcRx = (frame[declared - 2] | (frame[declared - 1] << 8)) & 0xffff;
  if (crc16lsb(frame, declared - 2, 0x8408, 0x0000) !== crcRx) return DECODE_FAIL_MIC;

  const control = frame[1];

  // Two header layouts are known. The compact one is what the only captured sample uses; the spaced one comes
  // from the recovered notes and puts a zero byte before each address.
  let addrOff = 2, bodyOff = 12, spaced = 0;
  if (declared >= 18 && frame[2] === 0x00 && frame[8] === 0x00 && frame[14] === 0x00) {
    addrOff = 3; bodyOff = 15; spaced = 1;
  }
  if (bodyOff + 2 > declared) return DECODE_FAIL_SANITY;
  const bodyLen = declared - bodyOff - 2;

  const senderId = hexBytes(frame.subarray(addrOff + 5 + spaced, addrOff + 10 + spaced), 5);
  const data: R433Data = {
    model: 'RADIAN',
    type: 'Meter',
    id: senderId,
    len: declared,
    control: hex2(control),
    control_string: radianControlString(control),
    header_variant: spaced ? 'spaced' : 'compact',
    receiver_id: hexBytes(frame.subarray(addrOff, addrOff + 5), 5),
    sender_id: senderId,
    body_len: bodyLen,
    body: hexBytes(frame.subarray(bodyOff, bodyOff + bodyLen), bodyLen),
    crc: hex4(crcRx),
    data: hexBytes(frame, declared),
  };

  // The body wraps a whole wired M-Bus telegram, so its header is read with the same code the radio modes use.
  const wm = radianFindWmbusFrame(frame.subarray(bodyOff, bodyOff + bodyLen), bodyLen);
  if (wm) {
    const b2 = newBlock2();
    const wired = frame.subarray(bodyOff + wm.at, bodyOff + wm.at + wm.len);
    parseCi(wired, 2, wm.len > 2 ? wm.len - 2 : 0, 2, b2);   // the telegram runs C, A, CI, then records
    if (b2.CI) data.wmbus_ci = hex2(b2.CI);
    if (b2.plOffset) {
      data.wmbus_ac = hex2(b2.AC);
      data.wmbus_st = hex2(b2.ST);
      data.wmbus_cw = hex4(b2.CW);
    }
  }

  data.mic = 'CRC';
  ctx.emit(data);
  return 1;
}

export const radian: RDevice = register({
  num: 379,
  name: 'RADIAN/RADIAN0 meter',
  what: 'utility meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 416,                                 // 2400 baud
  longWidth: 416,
  resetLimit: 20000,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0, aborts = 0, fails = 0;
    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] < 36 + RADIAN_MIN_FRAME_BYTES * 11) { aborts++; continue; }
      const ret = radianDecodeRow(bits, ctx, row);
      if (ret > 0) events += ret;
      else if (ret === DECODE_FAIL_MIC || ret === DECODE_FAIL_SANITY) fails++;
      else aborts++;
    }
    if (events) return events;
    if (fails) return DECODE_FAIL_MIC;
    if (aborts) return DECODE_ABORT_EARLY;
    return DECODE_ABORT_LENGTH;
  },
});
