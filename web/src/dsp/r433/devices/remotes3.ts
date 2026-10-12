/**
 * More remotes: two car keys, a satellite handset, a gate opener and a European lighting system.
 *
 * Four of these six carry no integrity check whatsoever, and rtl_433 ships all four switched off for that
 * reason. Here they still run: a frame with nothing to verify cannot be told apart from another device's
 * traffic that happens to land in the same shape, so rather than stay silent the app reports what it heard
 * and marks it as worth a second look. What stands in for a checksum in each case is written down below,
 * because "no check" and "a weak structural check" are different claims and the difference matters when
 * reading them.
 *
 * The two that do check out are worth having. Funkbus closes its frame with a parity bit and a four-bit
 * shift-register digest, and is the lighting system behind several German switch brands; the Code Alarm car
 * remote has no checksum either, but it does have a fixed run-in and a plausibility bound on its payload.
 *
 * The Megacode gate opener is the odd one. Its twenty-four bits are not sent as bits at all: each occupies a
 * six-millisecond window containing exactly one pulse, and which half of the window the pulse falls in is the
 * bit. Anything with two pulses in a window, or none, is not a Megacode frame — counting them is the whole of
 * its integrity, and it is stronger than it sounds.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `hondaremote.c`, `fordremote.c`, `dish_remote_6_3.c`,
 * `megacode.c`, `funkbus.c`, `code_alarm_car_remote.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { parity8, reflect4, xorBytes } from '../util.js';

const hexUp = (v: number, n: number) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

/** The byte sum at full width. `addBytes` masks to a byte, which these saturation tests cannot use. */
function sumBytes(m: Uint8Array, n: number, at = 0): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += m[at + i];
  return s;
}

/** One bit of a row, counting from the most significant bit of the first byte. */
const bitAt = (b: Uint8Array, i: number) => (b[i >> 3] >> (7 - (i & 7))) & 1;

// ---------------------------------------------------------------------------
// Honda car key (64)
// ---------------------------------------------------------------------------

/**
 * A long frame with two fixed bytes in it and nothing else to go on.
 *
 * The rolling code is not decoded — only which button was pressed and the remote's number. With no check at
 * all, the two 0xff bytes and the frame length are the only things separating this from noise, which is why
 * rtl_433 ships it switched off and why its readings here are marked as worth a second look.
 */
export const hondaRemote: RDevice = register({
  num: 64,
  name: 'Honda Car Key',
  what: 'car remote',
  modulation: Modulation.FSK_PWM,
  shortWidth: 250,
  longWidth: 500,
  resetLimit: 2000,
  bands: [315000000, 433920000],
  disabled: true,                                  // no integrity check, and weak sanity checks
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const names = ['boot', 'unlock', 'lock'];
    for (let row = 0; row < bits.numRows; row++) {
      const n = bits.bitsPerRow[row];
      if (n < 385 || n > 394) continue;
      const b = bits.bb[row];
      if (b[0] !== 0xff || b[38] !== 0xff) continue;

      const command = (b[46] - 0xaa) & 0xff;
      ctx.emit({
        model: 'Honda-CarRemote',
        type: 'Remote',
        id: (b[44] << 8) | b[45],
        code: names[command] ?? 'unknown',
      });
      return 1;
    }
    return 0;
  },
});

// ---------------------------------------------------------------------------
// Ford car key (93)
// ---------------------------------------------------------------------------

/**
 * Found by its run-in rather than by anything in the frame.
 *
 * The transmitter sends three tiny rows before the payload — one bit, then nine, then one — and that shape is
 * what identifies it. The field meanings behind it were never confirmed upstream, so they are reported as
 * they were read and no more is claimed for them.
 */
export const fordRemote: RDevice = register({
  num: 93,
  name: 'Ford Car Key',
  what: 'car remote',
  modulation: Modulation.OOK_DMC,
  shortWidth: 250,                                 // half-bit width
  longWidth: 500,
  resetLimit: 4000,
  tolerance: 50,
  bands: [315000000, 433920000],
  disabled: true,                                  // rolling code undecoded, field meanings unconfirmed
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let found = 0;
    for (let i = 3; i < bits.numRows; i++) {
      if (bits.bitsPerRow[i] < 78) continue;
      // The run-in is three rows of one, nine and one bits, the middle one empty.
      if (bits.bitsPerRow[i - 3] !== 1 || bits.bitsPerRow[i - 1] !== 1
        || bits.bitsPerRow[i - 2] !== 9 || bits.bb[i - 2][0] !== 0) continue;

      const b = bits.bb[i];
      ctx.emit({
        model: 'Ford-CarRemote',
        type: 'Remote',
        id: ((b[0] << 16) | (b[1] << 8) | b[2]) >>> 0,
        code: b[7],
      });
      found++;
    }
    return found;
  },
});

// ---------------------------------------------------------------------------
// Dish remote 6.3 (101)
// ---------------------------------------------------------------------------

/** Sixty-four buttons, most of which the remote never sends. */
const DISH_BUTTONS = [
  'Undefined', 'Undefined', 'Swap', 'Undefined', 'Position', 'PIP', 'DVR', 'Undefined',
  'Skip Forward', 'Skip Backward', 'Undefined', 'Dish Button', 'Undefined', 'Forward', 'Backward', 'TV Power',
  'Reset', 'Undefined', 'Undefined', 'Undefined', 'Undefined', 'Undefined', 'SAT',
  'Mute/Volume Up/Volume Down',
  'Undefined', '#/Search', '*/Format', 'Undefined', 'Undefined', 'Undefined', 'Stop', 'Pause',
  'Record', 'Channel Down', 'Undefined', 'Left', 'Recall', 'Channel Up', 'Undefined', 'Right',
  'TV/Video', 'View/Live TV', 'Undefined', 'Guide', 'Undefined', 'Cancel', 'Digit 0', 'Select',
  'Page Up', 'Digit 9', 'Digit 8', 'Digit 7', 'Menu', 'Digit 6', 'Digit 5', 'Digit 4',
  'Page Down', 'Digit 3', 'Digit 2', 'Digit 1', 'Play', 'Dish Power', 'Undefined', 'Info',
];

/**
 * A satellite handset, and the only thing here that is not about a vehicle or a gate.
 *
 * Sixteen bits, six of which are the button and the rest fixed. Those fixed bits are all the integrity it
 * has, so the frame must also arrive at least three times over before it is believed.
 */
export const dishRemote63: RDevice = register({
  num: 101,
  name: 'Dish remote 6.3',
  what: 'satellite remote',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1692,
  longWidth: 2812,
  gapLimit: 4500,
  resetLimit: 9000,
  disabled: true,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(3, 16);         // it has to be said three times over
    if (r < 0 || bits.bitsPerRow[r] > 16) return DECODE_ABORT_LENGTH;

    const b = bits.bb[r];
    // The fixed bits, which are the whole of its integrity.
    if ((b[0] & 0x03) !== 0x02 || (b[1] & 0xe8) !== 0xa8) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Dish-RC63',
      type: 'Remote',
      button: DISH_BUTTONS[b[0] >> 2],
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Linear Megacode gate and garage remotes (199)
// ---------------------------------------------------------------------------

/**
 * Twenty-four windows, each holding exactly one pulse.
 *
 * Every bit gets a six-millisecond window with a single one-millisecond pulse somewhere in it, and which half
 * the pulse lands in says whether the bit is a nought or a one. A window with two pulses, or with none, means
 * this was never a Megacode frame — so counting them to exactly twenty-four is a real check, even though the
 * code itself is fixed and carries no checksum of its own.
 */
export const megacode: RDevice = register({
  num: 199,
  name: 'Linear Megacode Garage/Gate Remotes',
  what: 'gate and garage remote',
  modulation: Modulation.OOK_PCM,
  shortWidth: 1000,
  longWidth: 1000,
  gapLimit: 9000,
  resetLimit: 20000,
  bands: [318000000],
  disabled: true,                                  // a fixed code with no checksum of its own
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(1, 144);
    if (row < 0) return DECODE_ABORT_LENGTH;
    const l = bits.bitsPerRow[row];
    if (l < 136 || l > 148) return DECODE_ABORT_LENGTH;

    let raw = 0, pulses = 0;
    const b = bits.bb[row];
    for (let i = 0; i < l; i++) {
      if (((b[i >> 3] << (i % 8)) & 0x80) !== 0) {
        // A pulse in the back half of its window means a one.
        if ((i + 4) % 6 > 2) raw |= 0x800000 >>> (((i + 4) / 6) | 0);
        pulses++;
      }
    }
    // Exactly one pulse per window, twenty-four windows. Anything else is not this remote.
    if (pulses !== 24) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Megacode-Remote',
      type: 'Remote',
      id: (raw >> 3) & 0xffff,
      raw: hexUp(raw, 6),
      facility: (raw >> 19) & 0x0f,
      button: raw & 0x07,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Funkbus / Instafunk (202)
// ---------------------------------------------------------------------------

/** Read a run of bits least significant first, which is how this protocol lays out every field. */
function getBitsReflect(b: Uint8Array, start: number, len: number): number {
  let result = 0, mask = 1;
  for (let i = start; i < start + len; i++, mask <<= 1) {
    if (bitAt(b, i)) result |= mask;
  }
  return result >>> 0;
}

/**
 * Funkbus closes its frame with a nibble from a shift register and one parity bit.
 *
 * The exclusive-or of every payload byte is folded down to a nibble, and each of that nibble's four bits
 * selects a fixed pattern to mix in — the same 0x8C mask shifted along twice each step. The parity of the
 * whole exclusive-or byte becomes the fifth bit.
 */
function funkbusChecksum(b: Uint8Array, len: number): number {
  const fullBytes = len >> 3;
  const bitsLeft = len % 8;
  let xorByte = xorBytes(b, fullBytes);
  // Mask off the bits of the last, partial byte that are not part of the frame.
  const mask = (0xff << (8 - bitsLeft)) & 0xff;
  xorByte = (xorByte ^ (b[fullBytes] & mask)) & 0xff;

  const nibble = ((xorByte & 0xf0) >> 4) ^ (xorByte & 0x0f);
  let result = 0;
  if (nibble & 0x8) result ^= 0x8c;
  if (nibble & 0x4) result ^= 0x32;
  if (nibble & 0x2) result ^= 0xc8;
  if (nibble & 0x1) result ^= 0x23;
  result &= 0x0f;
  result |= parity8(xorByte) << 4;
  return result;
}

/**
 * The lighting system behind Berker, Gira and Jung switches, made by Insta.
 *
 * Unlike everything else in this file it is not a vehicle remote at all — it is a wall switch talking to a
 * dimmer, and it says which of three channel groups it belongs to, whether the button was held down, and
 * whether this is a repeat of a press already sent.
 */
export const funkbusRemote: RDevice = register({
  num: 202,
  name: 'Funkbus / Instafunk (Berker, Gira, Jung)',
  what: 'light switch remote',
  modulation: Modulation.OOK_DMC,
  shortWidth: 500,
  longWidth: 1000,
  resetLimit: 2000,
  gapLimit: 1500,
  syncWidth: 4000,
  tolerance: 300,
  bands: [433420000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] < 48) return DECODE_ABORT_LENGTH;
      const b = bits.bb[row];

      // Only the remote's own packet type is handled; the system carries several others.
      if (getBitsReflect(b, 0, 4) !== 0x4 || getBitsReflect(b, 4, 4) !== 0x3) return DECODE_ABORT_EARLY;

      const parity = getBitsReflect(b, 43, 1);
      const check = getBitsReflect(b, 44, 4);
      const checksum = funkbusChecksum(b, 43);
      if (check !== reflect4(checksum & 0x0f) || parity !== (checksum >> 4)) return DECODE_FAIL_MIC;

      ctx.emit({
        model: 'Funkbus-Remote',
        type: 'Remote',
        id: getBitsReflect(b, 8, 20),
        battery_ok: getBitsReflect(b, 30, 1) ? 0 : 1,
        command: getBitsReflect(b, 33, 3),         // which button on the remote
        group: getBitsReflect(b, 36, 2),           // channel group A to C, or a light scene
        action: getBitsReflect(b, 39, 2),          // stop, off, on, scene
        repeat: getBitsReflect(b, 41, 1),          // set when this is not the first send
        longpress: getBitsReflect(b, 42, 1),       // held down, for dimming or learning a scene
        mic: 'CHECKSUM',
      });
      events++;
    }
    return events;
  },
});

// ---------------------------------------------------------------------------
// Code Alarm FRDPC2002 (317)
// ---------------------------------------------------------------------------

/** Several buttons share a code, so one value can legitimately name two of them. */
const CODE_ALARM_BUTTONS: { name: string; vals: number[] }[] = [
  { name: 'Multiple', vals: [0x7] },
  { name: 'Lock', vals: [0x6, 0x4] },
  { name: 'Panic', vals: [0x1, 0x3] },
  { name: 'Start', vals: [0x0, 0x3] },
  { name: 'Unlock', vals: [0x5, 0x4] },
];

/**
 * The identifier here is not sent directly — it is recovered by folding the rolling code against itself.
 *
 * Each byte of the thirty-six bit code is exclusive-ored with the next to give twenty-four bits that stay the
 * same from press to press, which is what makes one remote distinguishable from another even though the code
 * itself changes every time.
 */
export const codeAlarmFrdpc2000CarRemote: RDevice = register({
  num: 317,
  name: 'Code Alarm FRDPC2002 Car Remote',
  what: 'car remote',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 550,
  longWidth: 1100,
  resetLimit: 1600,
  tolerance: 100,
  bands: [315000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 60) return DECODE_ABORT_LENGTH;
    if (bits.bb[0][0] !== 0x00 || bits.bb[0][1] !== 0x00) return DECODE_FAIL_SANITY;

    const b = bits.bytes(0, 19, 40);
    // Empty or saturated is the receiver, not a remote. Both need the sum at full width.
    const sum = sumBytes(b, 5);
    if (sum === 0 || sum >= 0xff * 5) return DECODE_FAIL_SANITY;

    const code = bits.bytes(0, 23, 36);            // the manual ties a thirty-six bit rolling code to this part
    const id = (((code[0] ^ code[1]) << 16) | ((code[1] ^ code[2]) << 8) | (code[2] ^ code[3])) >>> 0;

    const button = b[0] >> 4;
    const held: string[] = [];
    for (const entry of CODE_ALARM_BUTTONS) {
      if (entry.vals.includes(button)) held.push(entry.name);
    }

    let data = '';
    for (let i = 0; i < 5; i++) data += hexUp(b[i], 2);

    ctx.emit({
      model: 'CodeAlarm-FRDPC2002',
      type: 'Remote',
      id: hexUp(id, 6),
      button_code: button,
      button_str: held.length ? held.join('; ') : '?',
      data,
    });
    return 1;
  },
});
