/**
 * Car remotes and keyfobs — the button you press in a car park.
 *
 * These are not sensors, and what they report is deliberately limited. Almost all of them are rolling-code
 * transmitters: a counter that goes up by one each press, and a block of ciphertext that only the car can
 * check. That ciphertext is reported as an opaque hex string because that is genuinely all it is from the
 * outside — nothing here can tell whether a code is valid, and nothing here can produce one. What is useful
 * is the rest: which remote it was, which button, and how far its counter has moved.
 *
 * Two of them are the same physical Honda remote read two different ways. Continental's decoder treats the
 * frame as a manufacturer's payload with an exclusive-or check; the Honda keyfob decoder reads the same air
 * with a proper CRC and a different field layout. Both are registered because rtl_433 registers both, and
 * either may be the one that matches a given capture.
 *
 * Three of these — Chrysler, GM and Siemens — compare a byte sum against a value wider than a byte, either
 * against zero or against a saturated all-ones frame. Those comparisons need the sum at full width, so it is
 * taken locally here rather than through `addBytes`, which masks to a byte.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `chrysler_car_remote.c`, `nidec_car_remote.c`,
 * `mic6sc2_car_remote.c`, `gm_car_remote.c`, `siemens_5wy72xx.c`, `alps_fwb1u545.c`,
 * `continental_car_remote.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addNibbles, crc8, reflectBytes, reverse8, xorBytes } from '../util.js';

/** American car remotes sit just below the 315 MHz band; the Honda parts also have a European 433 version. */
const BAND_315 = [315000000];
const BAND_BOTH = [315000000, 433920000];

const hexUp = (v: number, n: number) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

/**
 * The byte sum at full width.
 *
 * `addBytes` in util masks to a byte, which is right for a checksum compared against one byte but wrong for
 * the sanity tests below — they compare against zero or against an all-ones frame, and a masked sum can never
 * reach the latter and can reach the former by accident.
 */
function sumBytes(m: Uint8Array, n: number, at = 0): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += m[at + i];
  return s;
}

/** Join the buttons a bitmask says were held down. */
function buttonsFrom(mask: number, names: string[]): string[] {
  const held: string[] = [];
  for (let i = 0; i < names.length; i++) if (mask & (1 << i)) held.push(names[i]);
  return held;
}

// ---------------------------------------------------------------------------
// Chrysler (303)
// ---------------------------------------------------------------------------

/**
 * A fixed-code remote, so the same bits go out every time that button is pressed.
 *
 * It can report more than one button at once, and says so with a bit of its own — which is worth checking
 * against the button bits themselves, since a frame claiming two buttons without that flag, or one button
 * with it, has decoded wrong however well its sum adds up.
 */
export const chryslerCarRemote: RDevice = register({
  num: 303,
  name: 'Chrysler Car Remote',
  what: 'car remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 350,
  longWidth: 700,
  resetLimit: 350 * 50,
  syncWidth: 350 * 21,
  gapLimit: 350 * 12,
  tolerance: 100,
  bands: BAND_315,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    bits.invert();
    for (let row = 0; row < bits.numRows; row++) {
      let offset: number;
      if (bits.bitsPerRow[row] >= 49) offset = 49;
      else if (bits.bitsPerRow[row] === 48) offset = 48;
      else continue;

      const b = bits.bytes(row, bits.bitsPerRow[row] - offset, 48);
      reflectBytes(b, 6);

      const sum = sumBytes(b, 5);
      if ((sum & 0xff) !== b[5]) continue;
      // All zeroes or all ones is the receiver, not a remote. Both need the sum at full width.
      if (sum === 0 || sum === 0xff * 5) continue;

      const button = b[4] >> 4;
      const multiPress = (b[4] & 0x4) !== 0;
      const held = buttonsFrom(button, ['Unlock', 'Lock', 'Panic']);
      // The multiple-button flag has to agree with how many buttons the code names.
      if (!held.length || (held.length > 1 && !multiPress) || (held.length === 1 && multiPress)) continue;

      ctx.emit({
        model: 'Chrysler-CarRemote',
        type: 'Remote',
        id: hexUp(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 8),
        button_code: button,
        button_str: held.join('; '),
        mic: 'CHECKSUM',
      });
      events++;
    }
    return events;
  },
});

// ---------------------------------------------------------------------------
// Nidec (304)
// ---------------------------------------------------------------------------

/**
 * A Honda remote whose last field almost never arrives whole.
 *
 * The sixteen bits at the end are a keyed rolling-code authenticator, not a checksum — nobody has found a
 * polynomial that reproduces them, and they cannot be derived from the wire. Worse, the demodulator usually
 * cuts the frame short before all sixteen have arrived, so the tail is padding rather than signal. How many
 * bits were genuinely received is reported alongside, and anything past that count should be read as nothing.
 *
 * With no verifiable check of any kind, rtl_433 ships this one switched off, because it cannot rule out a
 * frame that is not from this remote at all. Here it still runs, with its readings marked as worth a second
 * look.
 */
export const nidecCarRemote: RDevice = register({
  num: 304,
  name: 'Nidec Car Remote',
  what: 'car remote',
  modulation: Modulation.FSK_PWM,
  shortWidth: 250,
  longWidth: 500,
  resetLimit: 1000,
  bands: BAND_315,
  disabled: true,                                  // nothing here can rule out an unwanted frame
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH;

    const pattern = new Uint8Array([0xff, 0xff, 0xff, 0xf0]);
    const offset = bits.search(0, 0, pattern, 32) + 32;
    if (bits.bitsPerRow[0] - offset < 56) return DECODE_ABORT_EARLY;

    // Only this many of the trailing sixteen bits were actually captured; the rest is zero padding.
    let securityBits = bits.bitsPerRow[0] - offset - 48;
    if (securityBits > 16) securityBits = 16;

    bits.invert();                                 // the run-in is searched before the frame is turned over
    const b = bits.bytes(0, offset, 64);

    const sequence = (b[0] << 8) | b[1];
    const id = ((b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    const button = b[5] & 0x0f;
    const security = ((b[6] << 8) | b[7]) & 0xffff;

    // The high nibble is a constant on every real remote seen so far.
    if ((b[5] & 0xf0) !== 0x50) return DECODE_FAIL_SANITY;
    if (!id || !sequence || id === 0xffffff || sequence === 0xffff || !security || security === 0xffff) {
      return DECODE_FAIL_SANITY;
    }
    // Only five button codes have ever been observed.
    if (button !== 0x3 && button !== 0x4 && button !== 0x5 && button !== 0x6 && button !== 0xf) {
      return DECODE_FAIL_SANITY;
    }

    const names: Record<number, string> = {
      0x3: 'Lock', 0x4: 'Unlock', 0x5: 'Trunk/Panic Short Press',
      0x6: 'Panic Long Press', 0xf: 'Trunk Long Press',
    };
    ctx.emit({
      model: 'Nidec-OUCG8D',
      type: 'Remote',
      id: hexUp(id, 6),
      security: hexUp(security, 4),
      security_bits: securityBits,
      sequence,
      button_code: button,
      button_str: names[button] ?? '?',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// MIC 6SC2 (312)
// ---------------------------------------------------------------------------

/** Sent least significant bit first, so every field has to be turned around byte by byte. */
export const sixScTwoCarRemote: RDevice = register({
  num: 312,
  name: 'MIC 6SC2 Car Remote',
  what: 'car remote',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 250,
  longWidth: 0,
  resetLimit: 10000,
  bands: BAND_315,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(1, 48);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 88) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    if (b[0] !== 0x55 || b[1] !== 0x54) return DECODE_FAIL_SANITY;
    if (xorBytes(b, 9, 2) !== 0) return DECODE_FAIL_MIC;

    const encrypted = ((reverse8(b[5]) << 24) | (reverse8(b[4]) << 16)
      | (reverse8(b[3]) << 8) | reverse8(b[2])) >>> 0;
    const button = reverse8(b[6]) & 0x0f;
    const names: Record<number, string> = { 0x1: 'Unlock', 0x2: 'Lock', 0x3: 'Trunk', 0x4: 'Panic' };

    ctx.emit({
      model: 'MIC6SC2-CarRemote',
      type: 'Remote',
      encrypted: hexUp(encrypted, 8),
      button_code: button,
      button_str: names[button] ?? '?',
      sequence: (reverse8(b[8]) << 8) | reverse8(b[7]),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// General Motors (313)
// ---------------------------------------------------------------------------

/**
 * Two checks, one nested inside the other: the button code carries its own nibble sum, and the whole payload
 * carries a byte sum, both of which have to come out to zero.
 *
 * The wake-up burst in front of the frame can be cut off anywhere, so the payload is taken from the end
 * backwards rather than by searching for a run-in.
 */
export const gmCarRemote: RDevice = register({
  num: 313,
  name: 'GM ABO1502T Car Remote',
  what: 'car remote',
  modulation: Modulation.OOK_PPM,
  shortWidth: 300,
  longWidth: 500,
  resetLimit: 20000,
  bands: BAND_315,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 113 || bits.numRows > 1) return DECODE_ABORT_LENGTH;

    // The wake-up may be truncated, so measure back from the end of what arrived.
    const b = bits.bytes(0, bits.bitsPerRow[0] - 113, 112);
    if (b[0] !== 0xff) return DECODE_FAIL_SANITY;  // one byte of the wake-up must still be there

    const buttonChecksum = addNibbles(b, 1, 2);    // at most thirty, so a masked sum is exact
    if (buttonChecksum === 0 || (buttonChecksum & 0x0f) !== 0) return DECODE_FAIL_MIC;

    const fullChecksum = sumBytes(b, 13, 1);       // full width: the zero test would otherwise misfire
    if (fullChecksum === 0 || (fullChecksum & 0xff) !== 0) return DECODE_FAIL_MIC;

    const button = b[2] & 0x07;
    const id = ((b[3] << 24) | (b[4] << 16) | (b[5] << 8) | b[6]) >>> 0;
    const names: Record<number, string> = { 0x1: 'Unlock', 0x2: 'Lock', 0x3: 'Trunk', 0x4: 'Panic' };

    ctx.emit({
      model: 'GM-ABO1502T',
      type: 'Remote',
      id: `${hexUp(b[1], 2)}${hexUp(id, 8)}`,
      encrypted: hexUp(((b[10] << 16) | (b[11] << 8) | b[12]) >>> 0, 6),
      button_code: button,
      button_str: names[button] ?? '?',
      sequence: (b[7] << 16) | (b[8] << 8) | b[9],
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Siemens 5WY72XX (314)
// ---------------------------------------------------------------------------

/** Six buttons, any combination of which can be held at once, and everything little endian. */
export const siemens5wy72xxCarRemote: RDevice = register({
  num: 314,
  name: 'Siemens 5WY72XX Car Remote',
  what: 'car remote',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 220,
  longWidth: 0,
  resetLimit: 10000,
  bands: BAND_315,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 113 || bits.numRows > 1) return DECODE_ABORT_LENGTH;

    const offset = bits.search(0, 0, new Uint8Array([0x60, 0x01]), 16) + 16;
    const b = bits.bytes(0, offset, 96);

    // An all-zero or all-ones frame is the receiver rather than a remote; both need the full-width sum.
    const sum = sumBytes(b, 12);
    if (sum === 0 || sum === 0xff * 12) return DECODE_FAIL_SANITY;
    if (xorBytes(b, 12) !== 0) return DECODE_FAIL_MIC;

    const held = buttonsFrom(b[4], ['Lock', 'Unlock', 'Trunk', 'Panic', 'Left Door', 'Right Door']);
    ctx.emit({
      model: 'Siemens-5WY72XX',
      type: 'Remote',
      id: `${hexUp(b[3], 2)}${hexUp(b[2], 2)}${hexUp(b[1], 2)}${hexUp(b[0], 2)}`,
      encrypted: `${hexUp(b[10], 2)}${hexUp(b[9], 2)}${hexUp(b[8], 2)}${hexUp(b[7], 2)}`,
      button_code: b[4],
      button_str: held.join('; '),
      sequence: (b[5] << 8) | b[6],
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Alps FWB1U545 (315)
// ---------------------------------------------------------------------------

/**
 * A fixed-code Honda remote with no checksum at all.
 *
 * What stands in for one is that the button byte is sent twice, so a frame whose two copies disagree is
 * thrown away. That plus an exact length and a fixed run-in byte is the whole of its integrity, which is why
 * no `mic` is claimed.
 */
export const alpsFwb1u545CarRemote: RDevice = register({
  num: 315,
  name: 'Alps FWB1U545 Car Remote',
  what: 'car remote',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 500,
  longWidth: 0,
  resetLimit: 1500,
  bands: BAND_BOTH,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 76 || bits.numRows > 1) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    // The run-in, and the button byte's own duplicate copy.
    if (b[0] !== 0x55 || b[5] !== b[6]) return DECODE_FAIL_SANITY;

    const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    if (id === 0 || id === 0xffffffff) return DECODE_FAIL_SANITY;

    const button = b[5] >> 4;
    const names: Record<number, string> = {
      0xe: 'Lock', 0xc: 'Panic', 0x5: 'Panic Held', 0x1: 'Unlock',
    };
    ctx.emit({
      model: 'Alps-FWB1U545',
      type: 'Remote',
      id: hexUp(id, 8),
      button_code: button,
      button_str: names[button] ?? '?',
      sequence: (b[7] << 8) | b[8],
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Continental (316) and the Honda keyfob (327) — the same remote, read two ways
// ---------------------------------------------------------------------------

export const continentalCarRemote: RDevice = register({
  num: 316,
  name: 'Continental KR5V2X Car Remote',
  what: 'car remote',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 100,
  longWidth: 200,
  resetLimit: 1500,
  bands: BAND_315,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] < 132) return DECODE_ABORT_LENGTH;

    // The last twenty bits of a longer wake-up sequence.
    const offset = bits.search(0, 0, new Uint8Array([0xf0, 0xf0, 0x60]), 20) + 20;
    if (bits.bitsPerRow[0] - offset < 112) return DECODE_ABORT_EARLY;

    const b = bits.bytes(0, offset, 112);
    const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const button = b[5] >> 4;
    const sequence = (b[6] << 16) | (b[7] << 8) | b[8];
    const encrypted = ((b[9] << 24) | (b[10] << 16) | (b[11] << 8) | b[12]) >>> 0;

    if (!id || !button || !sequence
      || id === 0xfffffff || encrypted === 0xfffffff || sequence === 0xffffff) {
      return DECODE_FAIL_SANITY;
    }
    if (xorBytes(b, 14) !== 0) return DECODE_FAIL_MIC;

    const names: Record<number, string> = {
      0x1: 'Lock', 0x3: 'Unlock', 0x9: 'Trunk Long Press',
      0xa: 'Trunk/Panic Short Press', 0xb: 'Panic Long Press',
    };
    ctx.emit({
      model: 'Continental-KR5V2X',
      type: 'Remote',
      id: hexUp(id, 8),
      encrypted: hexUp(encrypted, 8),
      sequence,
      button_code: button,
      button_str: names[button] ?? '?',
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/**
 * The same physical Honda remote as above, read as the manufacturer lays it out.
 *
 * Where the Continental decoder treats the frame as an opaque payload closed by an exclusive-or, this one
 * finds Honda's manufacturer code, skips the first two bytes of it, and reads the fields behind a proper CRC.
 * A button press sends the packet twice, which is what the index byte counts.
 */
export const hondaKeyfob: RDevice = register({
  num: 327,
  name: 'Honda Keyfob KR5V2X/1X',
  what: 'car remote',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 60,
  longWidth: 120,
  resetLimit: 1500,
  bands: BAND_BOTH,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows > 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] < 150 || bits.bitsPerRow[0] > 184) return DECODE_ABORT_LENGTH;

    const preamble = new Uint8Array([0xec, 0x0f, 0x62]);   // Honda's manufacturer code
    const at = bits.search(0, 0, preamble, 24);
    if (at + 16 + 120 > bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    // Skip only the first two bytes of the manufacturer code; the third is part of the checked frame.
    const b = bits.bytes(0, at + 16, 120);
    if (crc8(b, 14, 0x2f, 0x00) !== b[14]) return DECODE_FAIL_MIC;

    const names: Record<number, string> = {
      0x21: 'Lock', 0x22: 'Unlock', 0x24: 'Trunk', 0x27: 'Emergency', 0x2d: 'RemoteStart',
    };
    const data: R433Data = {
      model: 'Honda-KR5V2X1X',
      type: 'Remote',
      id: hexUp(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, 8).toLowerCase(),
      event: names[b[6]] ?? '?',
      counter: hexUp((b[7] << 16) | (b[8] << 8) | b[9], 6).toLowerCase(),
      code: hexUp(((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) >>> 0, 8).toLowerCase(),
      mic: 'CRC',
    };
    ctx.emit(data);
    return 1;
  },
});
