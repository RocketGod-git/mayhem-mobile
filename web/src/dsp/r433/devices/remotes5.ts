/**
 * Car alarms, remote starters, and one alarm keyfob.
 *
 * Three of these four are *fixed code* remotes, and that is the whole story about them. Unlike the KeeLoq parts
 * in `keeloq.ts`, nothing here hops: the same button on the same remote sends the same bits every time, for the
 * life of the car. So a decode gives the real identity and the real button, not an opaque counter — and by the
 * same token anyone who hears one press can repeat it. That is a property of the products, not of this port.
 *
 * The three fixed-code remotes share a habit worth explaining once. Each button has not one code but six or a
 * dozen, and the lists overlap: pressing two buttons together sends a code that appears in *both* buttons'
 * lists. So the lookup deliberately reports every name a code matches, joined with a semicolon, rather than
 * stopping at the first — "Lock; Panic" is not ambiguity, it is two buttons held down at once. A code in no list
 * is reported as "?" rather than guessed at.
 *
 * The 2GIG keyfob is the opposite case: its payload really is encrypted, by a scheme its maker has never
 * documented, and nobody has yet collected two presses of the same button on the same unit to even tell whether
 * it rolls. What can be checked is the frame — a sixteen-bit CRC that upstream confirmed against seven real
 * codes from two physical units — so the bytes are reported as the opaque hex they are, under names that say so.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `astrostart_2000.c`, `compustar_1wg3r.c`, `audiovox_pro_oe3b.c`,
 * `twogig_key2e.c`. None of the four ships a recorded capture, so every frame in the tests is built from the
 * transmit side.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addNibbles, crc16 } from '../util.js';

const hexUp = (v: number, n: number) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

/** A button's name against every code that can produce it, single presses and combinations alike. */
type ButtonMap = readonly (readonly [string, readonly number[]])[];

/**
 * Every button a code names, in table order.
 *
 * A code matches a button at most once — the codes within one button's list are not all distinct upstream, and
 * counting a name twice would read as two presses of the same key.
 */
function buttonNames(map: ButtonMap, code: number): string {
  const hit: string[] = [];
  for (const [name, vals] of map) if (vals.includes(code)) hit.push(name);
  return hit.length ? hit.join('; ') : '?';
}

// ---------------------------------------------------------------------------
// Astrostart 2000 / 3000 remote starter (301)
// ---------------------------------------------------------------------------

/**
 * The codes each of the six buttons sends, alone or paired with another.
 *
 * Six values per button is not six buttons' worth of redundancy: it is the single press plus the five pairings
 * with the other five buttons. That is why the same value turns up under two names — 0x35 is Lock and Panic
 * together, 0x37 is Lock and Start, and so on. Pressing three at once gives a code, but not a distinct one, and
 * 0x3f is the catch-all this remote sends for those.
 */
const ASTROSTART_BUTTONS: ButtonMap = [
  ['Lock',     [0x2b, 0x03, 0x27, 0x0f, 0x35, 0x37]],
  ['Panic',    [0x1f, 0x35, 0x0d, 0x25, 0x15, 0x2d]],
  ['Start',    [0x13, 0x37, 0x2d, 0x33, 0x3d, 0x3b]],
  ['Stop',     [0x2f, 0x0d, 0x33, 0x03, 0x1d, 0x17]],
  ['Trunk',    [0x23, 0x25, 0x3d, 0x1d, 0x27, 0x07]],
  ['Unlock',   [0x0b, 0x15, 0x3b, 0x17, 0x07, 0x0f]],
  ['Multiple', [0x3f]],
];

/**
 * Fifty-two bits: a button byte, its complement, a thirty-two bit serial, and a nibble of checksum.
 *
 * Two independent checks make this one of the better-defended fixed-code remotes here. The button byte is sent
 * twice, once inverted, which catches any single bit that flipped in it; and the serial carries a nibble that is
 * the sum of its own eight nibbles. Neither stops a replay, but together they make a false decode from noise
 * very unlikely, which is why this one is trusted where the other two fixed-code remotes below are not.
 *
 * A remote can be taught a second serial number, held down until it beeps four times, so the same physical fob
 * legitimately appears under two identities.
 */
export const astrostart2000: RDevice = register({
  num: 301,
  name: 'Astrostart 2000 Car Remote (-f 372.4M)',
  what: 'car alarm and remote starter',
  modulation: Modulation.OOK_PPM,
  shortWidth: 326,
  longWidth: 526,
  gapLimit: 541,
  resetLimit: 541,
  tolerance: 80,
  bands: [372400000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 52) return DECODE_ABORT_LENGTH;
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const b = bits.bb[0];
    if (b[0] !== (~b[1] & 0xff)) return DECODE_FAIL_MIC;

    // Eight nibbles summed modulo sixteen. Upstream masks after every addition; the running total cannot exceed
    // 120 either way, so the shared helper's byte-wide masking makes no difference here.
    if ((b[6] >> 4) !== (addNibbles(b, 4, 2) & 0x0f)) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Astrostart-2000',
      id: hexUp(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, 8),
      button_code: b[0],
      button_str: buttonNames(ASTROSTART_BUTTONS, b[0]),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Compustar 1WG3R car remote (302)
// ---------------------------------------------------------------------------

/**
 * Four buttons, their pairings, and a long-press form of each.
 *
 * "Long Press" is not a button — holding any combination for two and a half seconds sends a different code, so
 * its list is every combination's held form gathered under one name. Upstream's list repeats several values
 * within itself; since a code names each button at most once that is harmless, and it is left as written rather
 * than tidied, so the table can still be diffed against its source.
 */
const COMPUSTAR_BUTTONS: ButtonMap = [
  ['Lock',       [0x03, 0x05, 0x09, 0x0b, 0x0d, 0x0f, 0x1f, 0x17, 0x13, 0x15, 0x19, 0x1b, 0x1d]],
  ['Panic',      [0x18]],
  ['Start',      [0x09, 0x0a, 0x0c, 0x0b, 0x0e, 0x0d, 0x04, 0x1f, 0x08, 0x19, 0x1a, 0x1c, 0x1b, 0x1e, 0x1d, 0x12]],
  ['Trunk',      [0x05, 0x06, 0x0c, 0x0e, 0x0d, 0x1f, 0x17, 0x02, 0x15, 0x16, 0x1c, 0x1e, 0x1d, 0x08, 0x14]],
  ['Unlock',     [0x03, 0x06, 0x0a, 0x0b, 0x0e, 0x1f, 0x07, 0x17, 0x13, 0x16, 0x1a, 0x1b, 0x1e]],
  ['Long Press', [0x23, 0x31, 0x13, 0x16, 0x17, 0x1a, 0x1b, 0x1e, 0x15, 0x16, 0x1c, 0x1e, 0x1d, 0x08, 0x14,
                  0x08, 0x19, 0x1a, 0x1c, 0x1b, 0x1e, 0x1d, 0x12, 0x13, 0x15, 0x19, 0x1b, 0x1d]],
];

/**
 * Thirty-six bits, and possibly several of them in one burst.
 *
 * This remote has a programming mode that sends a whole sequence of different presses back to back, so unlike
 * almost everything else in this app the decoder walks every row and can report more than one reading from a
 * single transmission. Two things keep that from turning into a flood: five-bit rows of ones are separators
 * between batches rather than data, and a row identical to the last one accepted is a repeat of the same press
 * rather than a second press.
 *
 * The only real check is that the button byte is also sent inverted. The three marker bits above it help, but a
 * fixed code with an eight-bit complement is thin, which is why this is not something to act on.
 *
 * One quirk is carried over deliberately. Upstream tests `b[4] & 1` for the frame's trailing zero bit, but that
 * bit is index 39 while the frame ends at 35 — on a correctly sliced row it is padding and always zero, so the
 * test never fires. Changing it to look at bit 35 would reject frames upstream accepts, so it is left alone.
 */
export const compustar1wg3r: RDevice = register({
  num: 302,
  name: 'Compustar 1WG3R Car Remote',
  what: 'car alarm remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 708,
  longWidth: 1076,
  syncWidth: 1448,
  resetLimit: 1532,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    let previousRow = -1;

    for (let row = 0; row < bits.numRows; row++) {
      const b = bits.bb[row];

      // A batch separator. It ends the run of presses, so the next row cannot be a repeat of anything.
      if (bits.bitsPerRow[row] === 5 && (b[0] & 0xf8) === 0xf8) { previousRow = -1; continue; }

      // Reject short rows before reading b[0..4], rather than letting noise zero-padded into the unread bits
      // reach the complement check and pass it.
      if (bits.bitsPerRow[row] < 35) continue;
      if ((b[2] & 0xe0) !== 0xe0 || (b[4] & 1) !== 0) continue;
      if ((b[0] === 0xff && b[1] === 0xff) || (b[0] === 0x00 && b[1] === 0x00)) continue;

      // The two button bytes start three bits into a byte, so each is stitched from a pair.
      const buttonInverse = ((b[2] << 3) & 0xff) | (b[3] >> 5);
      const button = ((b[3] << 3) & 0xff) | (b[4] >> 5);
      if ((~buttonInverse & 0xff) !== button) continue;

      if (previousRow >= 0 && bits.compareRows(previousRow, row, 35)) continue;
      previousRow = row;

      // The top bit is the remote's secondary mode rather than part of the code, so it is stripped before the
      // lookup and reported alongside. Upstream omits the separator when nothing matched, giving the run-on
      // "?Secondary Mode"; that is reproduced rather than corrected so the two agree byte for byte.
      let names = buttonNames(COMPUSTAR_BUTTONS, button & 0x7f);
      if (button & 0x80) names += names === '?' ? 'Secondary Mode' : '; Secondary Mode';

      ctx.emit({
        model: 'Compustar-1WG3R',
        id: hexUp((b[0] << 8) | b[1], 4),
        button_code: button,
        button_str: names,
        mic: 'CHECKSUM',
      });
      events++;
    }

    return events;
  },
});

// ---------------------------------------------------------------------------
// Audiovox PRO-OE3B car remote (305)
// ---------------------------------------------------------------------------

/** The four button flags, spread every other bit through one byte. */
const AUDIOVOX_BUTTONS = ['Lock', 'Unlock', 'Option', 'Trunk'];

/**
 * Twenty-five bits sent upside down, with no check of any kind.
 *
 * The whole frame is inverted on the wire, and the order in which that matters is the one thing to get right
 * here: upstream tests the button byte *before* inverting the buffer and reads every field *after*, because in C
 * `bytes` aliases the buffer that the inversion rewrites. Doing the sanity test on the inverted byte instead
 * would accept a different set of frames entirely. This port takes the complement of the three bytes it needs
 * rather than rewriting the buffer — the shared buffer is handed to every other decoder afterwards — but keeps
 * the same before-and-after split, which is why the test below reads a raw byte and the fields below it do not.
 *
 * That sanity test is the only defense there is. The button bits sit on the even positions of the byte and the
 * odd positions must be clear before inversion, which rules out most noise; nothing else is checked, so no `mic`
 * is claimed. Upstream gives it a late priority for the same reason, and that is carried over: anything with a
 * real checksum gets first look at the same burst.
 *
 * Multiple buttons can be held together and each sets its own flag independently, so unlike the two remotes
 * above this one names combinations from the bits themselves rather than from a table of codes.
 */
export const audiovoxProOe3b: RDevice = register({
  num: 305,
  name: 'Audiovox PRO-OE3B Car Remote (-f 303.4M)',
  what: 'car alarm remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 445,
  longWidth: 895,
  syncWidth: 1368,
  gapLimit: 1790,
  resetLimit: 1790,
  priority: 10,
  bands: [303400000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 25) return DECODE_ABORT_LENGTH;
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const b = bits.bb[0];
    // Read raw, before the inversion: the odd bits must be clear and the byte must not be every button at once.
    if ((b[2] & 0xaa) || b[2] === 0x55) return DECODE_FAIL_SANITY;

    const id = (((~b[0] & 0xff) << 8) | (~b[1] & 0xff)) & 0xffff;
    if (id === 0 || id === 0xffff) return DECODE_FAIL_SANITY;

    const flags = ~b[2] & 0xff;
    const names: string[] = [];
    let mask = 0x01;
    for (const name of AUDIOVOX_BUTTONS) {
      if (flags & mask) names.push(name);
      mask <<= 2;
    }
    // Unreachable in practice: the raw byte is a subset of 0x55 and not all of it, so its complement always
    // carries at least one flag. Kept because upstream has it and a future loosening of the test above would
    // need it back.
    if (!names.length) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Audiovox-PROOE3B',
      id: hexUp(id, 4),
      button_str: names.join('; '),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// 2GIG-KEY2E-345 encrypted keyfob (370)
// ---------------------------------------------------------------------------

/**
 * A four-button alarm keyfob whose payload nobody has solved.
 *
 * It shares its transport with the plain Honeywell and 2GIG door sensors — the same Manchester coding and the
 * same twenty-four bit run-in — but carries seventy-two bits instead of the usual forty-eight, and forty-eight
 * of those are ciphertext under 2GIG's undocumented "eSeries" scheme. There are not even enough samples to say
 * whether it rolls: no two recordings exist of the same button pressed twice on the same unit.
 *
 * So the two encrypted fields are reported as hex under names that admit what they are, and specifically *not*
 * as an `id` — a rolling value presented as an identifier would make one keyfob look like a new device on every
 * press, which is worse than saying nothing.
 *
 * The frame itself is sound: a sixteen-bit CRC over the seven bytes ahead of it, confirmed upstream against
 * seven real codes from two different units, plus a constant byte in the middle. rtl_433 ships this switched
 * off because the payload is meaningless, and that is mirrored here rather than second-guessed: this table is
 * meant to read as a faithful copy of upstream's, so an entry that differs should differ for a reason visible
 * in the bits, and nothing here is. The flag fits on its own terms anyway — every registered decoder still
 * runs, and all `disabled` does in this app is mark the reading doubtful, which is a fair description of two
 * hex fields nobody has solved.
 *
 * The uncertainty is carried in the field names as well: deliberately not `id`, since a rolling value
 * presented as an identity would make one keyfob look like a new device on every press.
 */
export const twogigKey2e: RDevice = register({
  num: 370,
  name: '2GIG-KEY2E-345 encrypted keyfob',
  what: 'alarm system keyfob',
  disabled: true,                                  // mirrors upstream's table: the payload is unsolved
  modulation: Modulation.OOK_PCM,
  shortWidth: 136,
  longWidth: 136,
  resetLimit: 408,
  bands: [345000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 96) return DECODE_ABORT_LENGTH;
    const rawLen = bits.bitsPerRow[0];

    // The run-in is raw bits, not Manchester pairs, so it is searched for as it sits on the wire.
    const at = bits.search(0, 0, new Uint8Array([0x55, 0x55, 0x56]), 24);
    if (at + 24 >= rawLen) return DECODE_ABORT_EARLY;

    const msg = new BitBuffer();
    bits.manchesterDecode(0, at + 24, msg, 72);
    if (msg.bitsPerRow[0] < 72) return DECODE_ABORT_LENGTH;

    const b = msg.bb[0];
    if (b[4] !== 0x25) return DECODE_ABORT_EARLY;
    if (crc16(b, 7, 0x8005, 0x4c57) !== (((b[7] << 8) | b[8]) & 0xffff)) return DECODE_FAIL_MIC;

    const hx = (v: number) => v.toString(16).padStart(2, '0');
    ctx.emit({
      model: 'TwoGig-KEY2E345',
      encrypted_id: hx(b[0]) + hx(b[1]) + hx(b[2]) + hx(b[3]),
      encrypted_status: hx(b[5]) + hx(b[6]),
      mic: 'CRC',
    });
    return 1;
  },
});
