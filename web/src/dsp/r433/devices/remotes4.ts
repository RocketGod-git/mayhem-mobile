/**
 * Gates, blinds, awnings, a motion sensor and an oil tank.
 *
 * A mixed batch held together by what these devices are: things around a building that announce themselves
 * when something happens. Two of them are worth calling out.
 *
 * The Chamberlain motion sensor turns out to carry Security+ 2.0's payload scrambling verbatim — the same
 * order and inversion tables, the same interleaving, the same base-three counter — wrapped in an entirely
 * different transport for an entirely different product. That permutation is imported from `secplus.ts`
 * rather than written out again.
 *
 * The Elero blind remote is the most heavily wrapped thing in this app: the whole frame is whitened by a shift
 * register before it is even bits, and the eight command bytes inside are then put through a fixed nibble
 * substitution and two rounds of key subtraction. None of that is a secret — it is obfuscation, reversible by
 * anyone who reads it — but it does mean nothing is legible until several layers come off.
 *
 * Three of these carry no integrity check at all and rtl_433 ships them switched off. Here they still run,
 * with their readings marked as worth a second look; what stands in for a checksum is noted on each.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `chamberlain_cwpirc.c`, `watchman_plus.c`, `nice_flor_s.c`,
 * `markisol.c`, `dickert_mahs.c`, `elero.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { crc16, ibmWhitening, reverse8, reverse32 } from '../util.js';
import { secplusPermute } from './secplus.js';

const hexUp = (v: number, n: number) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
const bitAt = (b: Uint8Array, i: number) => (b[i >> 3] >> (7 - (i & 7))) & 1;

// ---------------------------------------------------------------------------
// Chamberlain CWPIRC motion sensor (258)
// ---------------------------------------------------------------------------

/**
 * A motion sensor that speaks a garage door opener's language.
 *
 * The frame carries two forty-bit halves, each scrambled exactly as Security+ 2.0 scrambles its own — which is
 * how one Chamberlain product's payload encoding ended up inside another. Together they give a forty-bit value
 * that stays fixed for a given sensor and a twenty-eight bit counter that moves every time.
 *
 * One bit of that fixed value is not identity at all: bit five flips when the battery is low, so it is masked
 * out of the reported identifier. Without that, a sensor would appear to be two different sensors depending on
 * how tired its battery was.
 */
function cwpircHalf(b: Uint8Array, at: number, roll: Uint8Array): number | null {
  // Forty bits: two unused, eight of order and inversion, thirty of interleaved payload.
  const orderInvert = ((b[at] & 0x3f) << 2) | (b[at + 1] >> 6);
  const x30 = (((b[at + 1] & 0x3f) << 24) | (b[at + 2] << 16) | (b[at + 3] << 8) | b[at + 4]) >>> 0;
  const g = secplusPermute(orderInvert, x30, roll);
  return g ? (g.p0 << 10) | g.p1 : null;
}

export const chamberlainCwpirc: RDevice = register({
  num: 258,
  name: 'Chamberlain CWPIRC PIR Sensor',
  what: 'motion sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 25,
  longWidth: 25,
  resetLimit: 500,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];
    if (n < 136) return DECODE_ABORT_LENGTH;

    const at = bits.search(0, 0, new Uint8Array([0x55, 0x2d, 0xd4]), 24);
    if (at >= n) return DECODE_ABORT_EARLY;

    // The demodulator sometimes lands the run-in a bit or two early, so nearby offsets are tried and the CRC
    // decides which one was right.
    let b: Uint8Array | null = null;
    for (let shift = 0; shift <= 4; shift++) {
      const pos = at + 24 + shift;
      if (pos + 112 > n) break;
      const c = bits.bytes(0, pos, 112);
      if (c[0] !== 0x00 || c[6] !== 0x01) continue;   // the two halves are numbered
      if (crc16(c, 14, 0x1021, 0x0000) !== 0) continue;
      b = c;
      break;
    }
    if (!b) return DECODE_FAIL_MIC;

    const roll0 = new Uint8Array(9), roll1 = new Uint8Array(9);
    const fixed0 = cwpircHalf(b, 1, roll0);
    const fixed1 = cwpircHalf(b, 7, roll1);
    if (fixed0 === null || fixed1 === null) return DECODE_FAIL_SANITY;

    // Forty bits across the two halves, so this is arithmetic rather than a shift.
    const batteryLow = (fixed1 & 0x20) !== 0;
    const id = fixed0 * 1048576 + (fixed1 & ~0x20);

    const digits: number[] = [roll1[8], roll0[8]];
    for (let i = 4; i < 8; i++) digits.push(roll1[i]);
    for (let i = 4; i < 8; i++) digits.push(roll0[i]);
    for (let i = 0; i < 4; i++) digits.push(roll1[i]);
    for (let i = 0; i < 4; i++) digits.push(roll0[i]);

    let temp = 0;
    for (let i = 0; i < 18; i++) temp = temp * 3 + digits[i];

    ctx.emit({
      model: 'Chamberlain-CWPIRC',
      type: 'Motion',
      id: id.toString(16).padStart(10, '0'),
      battery_ok: batteryLow ? 0 : 1,
      rolling: reverse32(temp) >>> 4,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Kingspan Watchman Plus oil tank monitor (359)
// ---------------------------------------------------------------------------

/**
 * An oil tank gauge that reports a single digit, not a depth.
 *
 * The older probe-based Watchman shows nought to nine or "F" for full, and that is all it transmits. Its
 * serial number is stored backwards across the whole twenty-four bits — not byte by byte — and then read as
 * eight octal digits, which is what makes the number printed on the case come back out.
 *
 * There is no checksum. Four two-bit markers are woven through the frame and all four must read "10", which
 * together with the run-in and a plausible level is the whole of its integrity — so no `mic` is claimed.
 *
 * The pulse widths below are upstream's best estimate: its bit-level decoding is confirmed against eighteen
 * real messages from three devices, but nobody has yet got a raw capture through a pulse slicer cleanly.
 */
export const watchmanPlus: RDevice = register({
  num: 359,
  name: 'Kingspan/Watchman Plus (Niveau) oil tank monitor',
  what: 'oil tank level monitor',
  modulation: Modulation.OOK_PWM,
  shortWidth: 3299,
  longWidth: 4107,
  resetLimit: 5000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 13 + 40) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    const rowLen = bits.bitsPerRow[0];
    const pre = new Uint8Array([0xff, 0xf0]);      // thirteen bits
    let from = 0;

    while (from + 13 + 40 <= rowLen) {
      const match = bits.search(0, from, pre, 13);
      if (match + 13 + 40 > rowLen) break;
      let pos = match + 13;
      from = match + 1;                            // on failure, try the next overlapping match

      let stuffOk = true;
      let idRaw = 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 8; j++) idRaw = ((idRaw << 1) | bitAt(b, pos++)) >>> 0;
        if (i < 2) {
          const s0 = bitAt(b, pos++), s1 = bitAt(b, pos++);
          stuffOk &&= s0 === 1 && s1 === 0;
        }
      }
      const m0 = bitAt(b, pos++), m1 = bitAt(b, pos++);
      stuffOk &&= m0 === 1 && m1 === 0;

      let level = 0;
      for (let j = 0; j < 4; j++) level |= bitAt(b, pos++) << j;   // least significant bit first
      pos += 3;                                    // three bits nobody has explained
      const batteryLow = bitAt(b, pos++);
      const m2 = bitAt(b, pos++), m3 = bitAt(b, pos++);
      stuffOk &&= m2 === 1 && m3 === 0;

      if (!stuffOk || level > 10) continue;

      // The whole twenty-four bits are reversed together, then read as eight octal digits.
      const idRev = reverse32((idRaw << 8) >>> 0) & 0xffffff;
      let idVal = 0;
      for (let n = 7; n >= 0; n--) idVal = idVal * 10 + ((idRev >> (n * 3)) & 0x07);

      ctx.emit({
        model: 'Watchman-Plus',
        type: 'Meter',
        id: String(idVal).padStart(8, '0'),        // the case shows its leading zeroes, so keep them
        level: level <= 9 ? String(level) : 'F',
        battery_ok: batteryLow ? 0 : 1,
      });
      return 1;
    }
    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// Nice Flor-S gate remote (169)
// ---------------------------------------------------------------------------

/** The substitution table the Nice scrambler walks, two passes per frame. */
const NICE_LEAF = [
  25, 5, 63, 97, 203, 109, 69, 10, 3, 7, 64, 5, 71, 134, 180, 74,
  41, 158, 102, 199, 93, 118, 175, 101, 60, 77, 143, 174, 103, 148, 29, 85,
];

/**
 * Unwind the Nice scrambler.
 *
 * Six bytes are shuffled, complemented, and then twice run through a table-driven exclusive-or whose key
 * depends on the byte being transformed — so the serial number and the rolling code come out together, and
 * neither can be read without doing the whole thing. Works in place; the caller reads the serial out of the
 * array afterwards and the code from the return value.
 */
function niceUnscramble(p: Uint8Array): number {
  let k = ~p[4] & 0xff;
  p[5] = ~p[5] & 0xff;
  p[4] = ~p[2] & 0xff;
  p[2] = ~p[0] & 0xff;
  p[0] = k;
  k = ~p[3] & 0xff;
  p[3] = ~p[1] & 0xff;
  p[1] = k;

  const xorTail = (key: number) => { for (let i = 1; i < 6; i++) p[i] = (p[i] ^ key) & 0xff; };

  for (let y = 0; y < 2; y++) {
    k = (NICE_LEAF[p[0] >> 3] + 0x25) & 0xff;
    xorTail(k);
    p[5] &= 0x0f;
    p[0] = (p[0] ^ (k & 0x07)) & 0xff;
    k = NICE_LEAF[p[0] & 0x1f];
    xorTail(k);
    p[5] &= 0x0f;
    p[0] = (p[0] ^ (k & 0xe0)) & 0xff;
    if (y === 0) { const t = p[0]; p[0] = p[1]; p[1] = t; }
  }
  return ((p[1] << 8) | p[0]) & 0xffff;
}

export const niceFlorS: RDevice = register({
  num: 169,
  name: 'Nice Flor-s remote control for gates',
  what: 'gate remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 500,
  longWidth: 1000,
  syncWidth: 1500,
  gapLimit: 2000,
  resetLimit: 5000,
  tolerance: 100,
  bands: [433920000],
  disabled: true,                                  // no checksum: the frame shape is all there is
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The transmitter leaves a trailing empty row, which is part of how the frame is recognized.
    if (bits.numRows !== 2 || bits.bitsPerRow[1] !== 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 52 && bits.bitsPerRow[0] !== 72) return DECODE_ABORT_LENGTH;

    bits.invert();
    const b = bits.bb[0];

    // Thirteen nibbles, realigned so the scrambled block sits on byte boundaries.
    const t = new Uint8Array(7);
    t[0] = (b[0] >> 4) & 0x0f;
    for (let i = 0; i < 6; i++) t[i + 1] = ((b[i] << 4) & 0xf0) | ((b[i + 1] >> 4) & 0x0f);

    const p = new Uint8Array(7);
    p[5] = t[1] & 0x0f;
    p[4] = t[2];
    p[3] = t[3];
    p[2] = t[4];
    p[1] = t[5];
    p[0] = t[6];

    const code = niceUnscramble(p);
    const serial = (((p[5] << 24) | (p[4] << 16) | (p[3] << 8) | p[2]) >>> 0) & 0xfffffff;
    const button = t[0] & 0x0f;

    ctx.emit({
      model: 'Nice-FlorS',
      type: 'Remote',
      button,
      serial: hexUp(serial, 7).toLowerCase(),
      code: hexUp(code, 4).toLowerCase(),
      // The repeat counter is hidden behind the button number, which is how a replay is spotted.
      count: ((t[1] >> 4) & 0x0f) ^ (t[0] & 0x0f) ^ 0x0f,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Markisol curtain remote (191)
// ---------------------------------------------------------------------------

const MARKISOL_CONTROL = [
  'Limit (0)', 'Down (1)', '? (2)', 'H-Down (3)', 'Confirm (4)', 'Stop (5)', '? (6)', '? (7)',
  '? (8)', '? (9)', '? (10)', '? (11)', 'Up (12)', 'Limit (13)', 'H-Up (14)', '? (15)',
];

/**
 * A curtain remote whose frame arrives one bit late.
 *
 * The slicer reads the frame marker as though it were a data bit, so every byte is a bit out of step and the
 * whole thing is shifted back before anything can be read. The bytes are then complemented and reversed, and
 * what makes it check out is that all five sum to one.
 *
 * The channel, zone and control are interleaved rather than laid out in order — two of the control's four bits
 * and one of the zone's two live in a different byte from the rest.
 */
export const markisol: RDevice = register({
  num: 191,
  name: 'Markisol, E-Motion, BOFU, Rollerhouse, BF-30x, BF-415 curtain remote',
  what: 'curtain and blind remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 368,
  longWidth: 704,
  syncWidth: 5628,
  gapLimit: 2000,
  resetLimit: 2000,
  bands: [433920000],
  disabled: true,                                  // claims other makers' traffic rather often
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const buf = new Uint8Array(5);
    let sum = 0;
    let found = false;

    for (let i = 0; i < bits.numRows; i++) {
      if (bits.bitsPerRow[i] !== 41 && bits.bitsPerRow[i] !== 42) continue;
      const b = bits.bb[i];
      sum = 0;
      for (let j = 0; j < 5; j++) {
        // Shift the stream by one to drop the marker the slicer mistook for a bit.
        buf[j] = ~reverse8(((b[j] << 1) + (b[j + 1] >> 7)) & 0xff) & 0xff;
        sum = (sum + buf[j]) & 0xff;
      }
      found = true;
      break;
    }
    if (!found) return DECODE_ABORT_EARLY;
    if (sum !== 1) return DECODE_FAIL_MIC;         // every byte together must come to one

    const control = ((buf[2] >> 4) & ~2) | ((buf[3] & 0x10) >> 3);
    ctx.emit({
      model: 'Markisol',
      type: 'Remote',
      id: hexUp((buf[0] << 8) | buf[1], 4),
      control: MARKISOL_CONTROL[control & 0x0f],
      channel: buf[2] & 0x0f,
      zone: ((buf[2] & 0x20) >> 5) + ((buf[3] & 0x80) >> 6) + 1,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Dickert MAHS433 garage remote (344)
// ---------------------------------------------------------------------------

/** Each switch position as it reads on the wire; "10" never occurs on a real remote. */
const DICKERT_STATE = ['-', '0', '?', '+'];

/**
 * A garage remote with ten physical switches inside it.
 *
 * There is no identity chip and no rolling code — whoever installed it opened the case and set ten three-way
 * switches, and those settings *are* the code. Reporting them as the positions they are set to is more useful
 * than a number, because that is what someone would read off the hardware.
 *
 * Each logical bit is sent as three symbols starting with a gap, which is why the frame carries one extra
 * pulse at the front that is not data.
 */
export const dickertPwm: RDevice = register({
  num: 344,
  name: 'Dickert MAHS433-01 garage door remote control',
  what: 'garage remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 362,
  longWidth: 770,
  gapLimit: 1064,
  resetLimit: 12000,
  bands: [433920000],
  disabled: true,                                  // a fixed code with nothing to check it against
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 37) return DECODE_ABORT_LENGTH;   // thirty-six bits and a lead pulse

    const b = bits.bytes(0, 1, 36);
    let dip = '', fac = '';
    for (let field = 0; field < 18; field++) {
      const v = (b[field >> 2] >> (2 * (3 - (field % 4)))) & 0x03;
      if (field < 10) dip += DICKERT_STATE[v];
      else fac += DICKERT_STATE[v];
    }

    ctx.emit({
      model: 'Dickert-MAHS433',
      type: 'Remote',
      id: ((b[0] << 12) | (b[1] << 4) | (b[2] >> 4)) >>> 0,
      dipswitch: dip,
      facswitch: fac,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Elero blinds and awnings (372)
// ---------------------------------------------------------------------------

/** The substitution the command block is put through, and which undoes it. */
const ELERO_NIBBLE = [
  0x0a, 0x03, 0x01, 0x0c, 0x0d, 0x07, 0x0f, 0x06,
  0x00, 0x08, 0x0b, 0x0e, 0x09, 0x02, 0x05, 0x04,
];

/**
 * Unwrap the eight command bytes.
 *
 * This is obfuscation rather than encryption: a fixed nibble substitution, two nibble-wise subtractions with a
 * key that walks down in steps, and an exclusive-or in between using the block's own first two bytes. Nothing
 * about it is secret, and it is entirely reversible — which is how anyone worked out that one byte of the
 * result says up, stop or down.
 */
function eleroUnwrap(m: Uint8Array): void {
  for (let i = 0; i < 8; i++) m[i] = ((ELERO_NIBBLE[(m[i] >> 4) & 0x0f] << 4) | ELERO_NIBBLE[m[i] & 0x0f]) & 0xff;

  let key = 0xfe;
  for (let i = 0; i < 2; i++) {
    m[i] = (((m[i] & 0xf0) - (key & 0xf0)) & 0xf0) | ((m[i] - key) & 0x0f);
    key = (key - 0x22) & 0xff;
  }

  const x0 = m[0], x1 = m[1];
  for (let i = 0; i < 8; i += 2) {
    m[i] ^= x0;
    m[i + 1] ^= x1;
  }

  key = 0xba;
  for (let i = 2; i < 8; i++) {
    m[i] = (((m[i] & 0xf0) - (key & 0xf0)) & 0xf0) | ((m[i] - key) & 0x0f);
    key = (key - 0x22) & 0xff;
  }
}

export const elero: RDevice = register({
  num: 372,
  name: 'Elero bidirectional blinds/awning remote (Silent Gliss and others)',
  what: 'blind and awning remote',
  modulation: Modulation.FSK_PCM,
  shortWidth: 13,                                  // 75 kbps
  longWidth: 13,
  resetLimit: 4000,
  bands: [868000000, 915000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    // Only the first thirty-one bits of the printed sync word are really sync; the next bit is already data.
    const sync = new Uint8Array([0xa7, 0x23, 0xa7, 0x23]);
    let at = bits.search(0, 0, sync, 31);
    if (at === bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    at += 31;

    const availBits = bits.bitsPerRow[0] - at;
    if (availBits < 8) return DECODE_ABORT_LENGTH;
    const availBytes = Math.min(availBits >> 3, 40);

    const frame = new Uint8Array(40);
    bits.extractBytes(0, at, frame, availBytes * 8);
    ibmWhitening(frame, availBytes);

    const total = frame[0] + 3;                    // the length byte, its bytes, then a two-byte check
    if (total > 40 || availBytes < total) return DECODE_ABORT_LENGTH;
    if (crc16(frame, total - 2, 0x8005, 0xffff) !== (((frame[total - 2] << 8) | frame[total - 1]) & 0xffff)) {
      return DECODE_FAIL_MIC;
    }

    const ndst = frame[16];
    if (17 + ndst + 2 + 8 + 2 > total) return DECODE_FAIL_SANITY;   // the destination list does not fit

    let channel = '';
    for (let i = 0; i < ndst; i++) channel += hexUp(frame[17 + i], 2);

    const enc = frame.slice(17 + ndst + 2, 17 + ndst + 10);
    eleroUnwrap(enc);
    const command = enc[2] === 0x20 ? 'Up' : enc[2] === 0x10 ? 'Stop' : enc[2] === 0x40 ? 'Down' : '?';

    ctx.emit({
      model: 'Elero',
      type: 'Remote',
      id: hexUp(((frame[7] << 16) | (frame[8] << 8) | frame[9]) >>> 0, 6),
      channel,
      command,
      counter: frame[1],                           // plain, and steps by one every press
      mic: 'CRC',
    });
    return 1;
  },
});
