/**
 * Remote controls: gates, garage doors, blinds, and the generic keyfobs that open most of them.
 *
 * These divide sharply. The EV1527-style remotes at the top of this file send a fixed code every time — press
 * the button, the same bits go out, forever — which is why they are trivially replayed and why the industry
 * moved on. Somfy's RTS at the bottom sends a counter that advances with every press, so a recorded
 * transmission is stale the moment it is used; what is decoded here is which button and what the counter
 * stands at, not anything that would let you operate the blind.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/generic_remote.c`, `intertechno.c`, `proove.c`,
 * `cardin.c`, `somfy_rts.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { xorBytes } from '../util.js';

const hex2 = (v: number) => v.toString(16).padStart(2, '0');

/**
 * The generic SC226x and EV1527 remote, which is inside an enormous number of cheap doorbells, gate openers
 * and alarm sensors.
 *
 * Its twenty-four bits are usually set by solder bridges or a bank of switches, and each pair of bits is one
 * physical position: soldered low, soldered high, or left floating. The tri-state string reports that directly,
 * because it is what you would read off the board.
 */
export const genericRemote: RDevice = register({
  num: 30,
  name: 'Generic remote SC226x EV1527',
  what: 'cheap doorbells, gate openers and alarm sensors',
  modulation: Modulation.OOK_PWM,
  shortWidth: 464,
  longWidth: 1404,
  resetLimit: 1800,
  tolerance: 200,
  bands: [433920000, 315000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const b = bits.bb[0];
    for (let i = 0; i < 3; i++) b[i] = ~b[i];

    if (bits.bitsPerRow[0] !== 25
      || (b[3] & 0x80) === 0                         // the closing bit is always set
      || (b[0] === 0 && b[1] === 0)                  // an all-zero identity is not issued
      || b[2] === 0) return DECODE_ABORT_LENGTH;

    const full = (b[0] << 16) | (b[1] << 8) | b[2];
    let tristate = '';
    for (let i = 22; i >= 0; i -= 2) {
      // 00 is a link to ground, 11 a link to supply, 01 nothing at all. 10 is invalid on the SC226x but
      // legitimate on the EV1527, so it gets its own symbol rather than being rejected.
      tristate += ['0', 'Z', 'X', '1'][(full >> i) & 0x03];
    }

    ctx.emit({
      model: 'Generic-Remote',
      id: (b[0] << 8) | b[1],
      cmd: b[2],
      tristate,
    });
    return 1;
  },
});

/**
 * Intertechno's mains switches. Off by default, as in rtl_433 — there is no checksum, and the frame is loose
 * enough to catch other traffic.
 */
export const intertechno: RDevice = register({
  num: 14,
  name: 'Intertechno 433',
  what: 'mains switches and remotes',
  modulation: Modulation.OOK_PPM,
  shortWidth: 330,
  longWidth: 1400,
  gapLimit: 1700,
  resetLimit: 10000,
  disabled: true,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bb[0][0] !== 0 || (bits.bb[1][0] !== 0x56 && bits.bb[1][0] !== 0x69)) return DECODE_ABORT_EARLY;
    const b = bits.bb[1];
    let id = '';
    for (let i = 0; i < 5; i++) id += hex2(b[i]);
    ctx.emit({
      model: 'Intertechno-Remote',
      id,
      slave: b[7] & 0x0f,
      master: (b[7] & 0xf0) >> 4,
      command: b[6] & 0x07,
    });
    return 1;
  },
});

/** Proove, Nexa and KlikAanKlikUit mains switches — the same design under three names across Scandinavia. */
export const proove: RDevice = register({
  num: 51,
  name: 'Proove / Nexa / KlikAanKlikUit wireless switch',
  what: 'mains switches and remotes',
  modulation: Modulation.OOK_PPM,
  shortWidth: 270,
  longWidth: 1300,
  syncWidth: 2650,
  gapLimit: 1500,
  resetLimit: 2800,
  tolerance: 200,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Exactly one sync mark must precede the data, which is most of what tells this apart from its neighbours.
    if (bits.syncsBeforeRow[0] !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 64) return DECODE_ABORT_LENGTH;

    const databits = new BitBuffer();
    bits.manchesterDecode(0, 0, databits, 80);
    if (databits.bitsPerRow[0] < 32) return DECODE_ABORT_LENGTH;   // 32, or 36 when a dimmer level follows
    databits.invert();

    const b = databits.bb[0];
    ctx.emit({
      model: 'Proove-Security',
      id: ((b[0] << 18) | (b[1] << 10) | (b[2] << 2) | (b[3] >> 6)) >>> 0,
      channel: ((b[3] >> 2) & 0x03) ^ 0x03,          // both of these are stored inverted
      state: ((b[3] >> 4) & 1) ? 'ON' : 'OFF',
      unit: (b[3] & 0x03) ^ 0x03,
      group: (b[3] >> 5) & 1,
    });
    return 1;
  },
});

/**
 * Cardin's gate remote. There is no identity as such — the pairing is a bank of nine physical switches, and
 * each is reported as up, down, or not fitted, which is exactly what you would see inside the handset.
 */
export const cardin: RDevice = register({
  num: 17,
  name: 'Cardin S466-TX2',
  what: 'gate and garage door remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 730,
  longWidth: 1400,
  syncWidth: 6150,
  gapLimit: 1600,
  resetLimit: 32000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 24) return DECODE_ABORT_LENGTH;
    const b = bits.bb[0];

    const cmd = b[2] & 0x3f;
    if (cmd !== 0x03 && cmd !== 0x09 && cmd !== 0x0c && cmd !== 0x06) return DECODE_ABORT_EARLY;

    // Each of the nine switches is sent as two bits, in two different bytes, and not in any tidy order. The
    // second bit can only be set when the first is, so any other combination means the frame is damaged.
    // Each entry is: byte and mask of the "fitted" bit, then byte and mask of the "up" bit.
    const SWITCHES: [number, number, number, number][] = [
      [0, 0x08, 1, 0x08], [0, 0x10, 1, 0x10], [0, 0x20, 1, 0x20],
      [0, 0x40, 1, 0x40], [0, 0x80, 1, 0x80], [2, 0x80, 2, 0x40],
      [0, 0x01, 1, 0x01], [0, 0x02, 1, 0x02], [0, 0x04, 1, 0x04],
    ];
    for (const [fb, fm, sb, sm] of SWITCHES) {
      if ((b[fb] & fm) === 0 && (b[sb] & sm) !== 0) return DECODE_ABORT_EARLY;
    }

    // '-' not fitted, 'o' fitted and down, '+' fitted and up.
    let dip = '';
    for (const [fb, fm, sb, sm] of SWITCHES) {
      dip += (b[fb] & fm) === 0 ? '-' : (b[sb] & sm) ? '+' : 'o';
    }

    ctx.emit({
      model: 'Cardin-S466',
      dipswitch: dip,
      rbutton: ['11R', '10R', '01R', '00L?'][((cmd & 0x0f) / 3 | 0) - 1],
    });
    return 1;
  },
});

/** What each Somfy control code means. */
const SOMFY_CONTROL = [
  '? (0)', 'My (1)', 'Up (2)', 'My + Up (3)', 'Down (4)', 'My + Down (5)', 'Up + Down (6)',
  'My + Up + Down (7)', 'Prog (8)', 'Sun + Flag (9)', 'Flag (10)', '? (11)', '? (12)', '? (13)', '? (14)', '? (15)',
];
const SOMFY_SEED = [
  '? (0)', '? (1)', '? (2)', '? (3)', '? (4)', 'Stop (5)', 'Up (6)', '? (7)',
  'Down (8)', '? (9)', '? (10)', '? (11)', 'Prog (12)', '? (13)', '? (14)', '? (15)',
];

/**
 * Somfy RTS — the awnings, blinds and shutters.
 *
 * Unlike everything above it, this is not a fixed code. The payload is obscured by chaining each byte against
 * the one before it, and it carries a counter that advances with every button press, so a recorded frame is
 * useless the moment the real remote is used again. What comes out here is which button was pressed and where
 * the counter stands.
 *
 * The preamble comes in three lengths depending on whether this is the first transmission or a repeat, and the
 * repeats are marked, which is worth knowing: a burst of them means someone is holding the button down.
 */
export const somfyRts: RDevice = register({
  num: 167,
  name: 'Somfy RTS',
  what: 'awning, blind and shutter remotes',
  modulation: Modulation.OOK_PCM,
  shortWidth: 604,
  longWidth: 604,
  gapLimit: 3000,
  resetLimit: 10000,
  tolerance: 20,
  bands: [433420000, 433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const LONG = new Uint8Array([0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0x00]);
    const RATE = new Uint8Array([0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xfe, 0x00]);
    const SHORT = new Uint8Array([0xf0, 0xf0, 0xff, 0x00]);

    let retransmission = 0;
    let decodeRow = -1;
    let bitpos = 0;

    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] > 170) {
        retransmission = 1;
        bitpos = bits.search(row, 0, LONG, 49) + 49;
        if (bitpos + 112 > bits.bitsPerRow[row]) bitpos = bits.search(row, 0, RATE, 48) + 48;
        if (bitpos + 112 <= bits.bitsPerRow[row]) { decodeRow = row; break; }
      } else if (bits.bitsPerRow[row] > 130) {
        retransmission = 0;
        bitpos = bits.search(row, 0, SHORT, 25) + 25;
        if (bitpos + 112 <= bits.bitsPerRow[row]) { decodeRow = row; break; }
      }
    }
    if (decodeRow < 0) return DECODE_ABORT_EARLY;
    if (bitpos + 112 > bits.bitsPerRow[decodeRow]) return DECODE_ABORT_LENGTH;

    const decoded = new BitBuffer();
    bits.manchesterDecode(decodeRow, bitpos, decoded, 80);
    if (decoded.numRows === 0 || decoded.bitsPerRow[0] < 56) return DECODE_ABORT_LENGTH;

    // Undo the chaining: each byte was masked with the one before it.
    const b = decoded.bb[0];
    for (let i = 6; i > 0; i--) b[i] ^= b[i - 1];

    let chk = xorBytes(b, 7);
    chk = (chk & 0x0f) ^ (chk >> 4);                 // fold to a nibble; it must come out zero
    if (chk !== 0) return DECODE_FAIL_MIC;

    const seed = b[0];
    const control = (b[1] & 0xf0) >> 4;
    ctx.emit({
      model: 'Somfy-RTS',
      id: (b[6] << 16) | (b[5] << 8) | b[4],
      // Control 15 means the button is coded into the seed byte instead.
      control: control === 0x0f ? SOMFY_SEED[seed & 0x0f] : SOMFY_CONTROL[control],
      counter: (b[2] << 8) | b[3],                   // advances every press, which is what stops a replay
      retransmission,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});
