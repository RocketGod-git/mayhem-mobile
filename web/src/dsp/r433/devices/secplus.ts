/**
 * Chamberlain Security+ garage door openers, versions 1.0 and 2.0.
 *
 * These are the only decoders in this app that remember anything between transmissions, and they have to be.
 * A Security+ remote does not send one packet — it sends two, a few milliseconds apart, and neither half means
 * anything alone. The radio delivers them as separate bursts, so the first half is held until the second
 * arrives and the pair is decoded together. A half left unclaimed is thrown away after eight hundred
 * milliseconds, which is far longer than the gap between two real halves and far shorter than the gap between
 * two button presses, so an abandoned half can never be married to the wrong partner.
 *
 * That cache is the only mutable state in the decoder tree. It lives here rather than in the runner, so
 * nothing else is affected by it, and it is exported for tests to reset and to drive with a fake clock.
 *
 * Both versions carry their payload as base-three digits rather than bits, which is why nothing here looks
 * like a normal frame. Version 1.0 counts the length of each run of ones: one pulse is a nought, two is a one,
 * three is a two, and four is a corrupt frame. Version 2.0 interleaves three ten-bit groups and then inverts
 * and reorders them according to eight bits carried in the packet — so the same payload goes out looking
 * different every time, and the decoder has to undo both permutations before anything can be read.
 *
 * Neither rolling code is decrypted, and neither can be: that is the point of a rolling code. What is
 * reported is the identity behind it — which opener, which button, and the counter's position — none of which
 * would let anyone open a door.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `secplus_v1.c` and `secplus_v2.c`, both in turn based on
 * Clayton Smith's work at https://github.com/argilo/secplus.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { reverse32 } from '../util.js';

/** A half waits this long for its partner: far longer than the real gap, far shorter than two presses. */
const CACHE_MS = 800;

/** The clock, behind a seam so tests can age the cache without waiting. */
export const secplusClock = { now: () => Date.now() };

/** Drop every held half. Tests call this between cases so one cannot leak into the next. */
export function secplusResetCache(): void {
  v1Held = null;
  v2Held1 = null;
  v2Held2 = null;
  v1HeldAt = 0;
  v2HeldAt = 0;
}

// ---------------------------------------------------------------------------
// Security+ 1.0 (178)
// ---------------------------------------------------------------------------

let v1Held: { part: number; digits: Uint8Array } | null = null;
let v1HeldAt = 0;

const V1_PRE_A = new Uint8Array([0x02]);
const V1_PRE_B = new Uint8Array([0x07]);

/**
 * Turn a run of pulses into base-three digits.
 *
 * The wire carries no bits at all: it carries runs of ones separated by zeroes, and how long each run is says
 * which digit it was. A run of four or more cannot legally have been sent, so it ends the frame.
 * Returns the first digit, which says which half of the pair this is.
 */
function v1DecodeHalf(src: Uint8Array, out: Uint8Array): number {
  let n = 0, run = 0;
  for (let i = 0; i < 11; i++) {
    for (let j = 0; j < 8; j++) {
      if ((src[i] << j) & 0x80) {
        run++;
        continue;
      }
      if (run === 0) continue;                     // leading silence
      if (run > 3) return -1;                      // no such digit exists
      out[n++] = run - 1;
      run = 0;
    }
  }
  return out[0];
}

/**
 * Find where the next half starts.
 *
 * There is no preamble to look for. Every half begins with a digit of nought or two, which on the wire are
 * `0001` and `0111`, so the run-in is recognised by those shapes — or, at the very start of a row, by the
 * first byte already looking like one of them.
 */
function v1FindNext(bits: BitBuffer, from: number): number {
  const head = bits.bb[0][0];
  if (from === 0 && ((head & 0xf0) === 0x10 || (head & 0xf0) === 0x70)) return 0;
  if (from === 0 && ((head & 0xe0) === 0xe0 || (head & 0xc0) === 0x80)) return 0;

  const a = bits.search(0, from, V1_PRE_A, 8) + 3;
  const b = bits.search(0, from, V1_PRE_B, 8) + 3;
  return a < b ? a : b;
}

/**
 * Fold twenty digit pairs into the rolling counter and the fixed code.
 *
 * The two are interleaved: every other digit belongs to the counter, and the ones between are the fixed code
 * obscured by a running total of everything read so far. Subtracting that total is what recovers them.
 */
function v1Accumulate(digits: Uint8Array, state: { rolling: number; fixed: number }): void {
  let acc = 0;
  for (let i = 0; i < 20; i += 2) {
    const a = digits[1 + i];
    state.rolling = state.rolling * 3 + a;
    acc += a;
    const b = (60 + digits[2 + i] - acc) % 3;
    state.fixed = state.fixed * 3 + b;
    acc += b;
  }
}

export const secplusV1: RDevice = register({
  num: 178,
  name: 'Security+ (Keyfob)',
  what: 'garage door opener',
  modulation: Modulation.OOK_PCM,
  shortWidth: 500,
  longWidth: 500,
  tolerance: 20,
  gapLimit: 15000,
  resetLimit: 80000,
  bands: [310000000, 315000000, 390000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < 84 || n > 130) return DECODE_ABORT_LENGTH;

    let first: Uint8Array | null = null;
    let second: Uint8Array | null = null;
    let at = 0;

    // Only ever one half per burst: the loop stops as soon as it has claimed one.
    while (at < n && !first && !second) {
      at = v1FindNext(bits, at);
      if (at < 0 || at + 84 > n) break;

      const out = new Uint8Array(44);              // a corrupt frame can produce more digits than a good one
      const which = v1DecodeHalf(bits.bytes(0, at, 84), out);
      if (which < 0 || which === 1) {              // a one cannot start a half
        at += 4;
        continue;
      }
      if (which === 0) { first = out.slice(0, 22); at += 88; }
      else if (which === 2) { second = out.slice(0, 22); at += 88; }
    }

    if (!first && !second) return DECODE_ABORT_EARLY;

    // Marry this half to one already waiting, if it is still fresh. Either way the held half is now spent.
    if (v1HeldAt) {
      if (secplusClock.now() - v1HeldAt < CACHE_MS && v1Held) {
        if (second && v1Held.part === 0) first = v1Held.digits;
        else if (first && v1Held.part === 2) second = v1Held.digits;
      }
      v1Held = null;
      v1HeldAt = 0;
    }

    if (!first || !second) {
      v1Held = first ? { part: 0, digits: first } : { part: 2, digits: second as Uint8Array };
      v1HeldAt = secplusClock.now();
      return DECODE_ABORT_EARLY;                   // nothing to say until the other half turns up
    }

    const state = { rolling: 0, fixed: 0 };
    v1Accumulate(first, state);
    v1Accumulate(second, state);
    const rolling = reverse32(state.rolling);
    const fixed = state.fixed;

    // The fixed code is a base-three number with several fields buried in it by division.
    const switchId = fixed % 3;
    const id0 = Math.floor(fixed / 3) % 3;
    const id1 = Math.floor(fixed / 9) % 3;

    const data: R433Data = {
      model: 'Secplus-v1',
      type: 'Remote',
      id0,
      id1,
      switch_id: switchId,
      fixed: String(fixed),
      rolling: String(rolling),
    };

    if (id1 === 0) {
      // A wall-mounted keypad: it reports the code that was typed, not a button.
      const padId = Math.floor(fixed / 27) % 2187;
      const pin = Math.floor(fixed / 59049) % 19683;
      let pinStr = '';
      if (pin >= 0 && pin <= 9999) pinStr = String(pin).padStart(4, '0');
      else if (pin >= 10000 && pin <= 11029) pinStr = 'enter';

      const suffix = Math.floor(fixed / 1162261467) % 3;
      if (suffix === 1) pinStr += '#';
      else if (suffix === 2) pinStr += '*';

      data.id = padId;
      if (padId) data.pad_id = padId;
      if (pin) data.pin = pinStr;
    } else {
      const remoteId = Math.floor(fixed / 27);
      data.id = remoteId;
      if (remoteId) {
        data.remote_id = remoteId;
        data.button_id = switchId === 1 ? 'left' : switchId === 0 ? 'middle' : 'right';
      }
    }

    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Security+ 2.0 (164)
// ---------------------------------------------------------------------------

let v2Held1: { fixed: Uint8Array; roll: Uint8Array } | null = null;
let v2Held2: { fixed: Uint8Array; roll: Uint8Array } | null = null;
let v2HeldAt = 0;

const V2_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0x95, 0x60]);   // twenty-eight bits

/** Which of the three groups to turn upside down, chosen by four bits in the packet. */
const V2_INVERT: Record<number, [boolean, boolean, boolean]> = {
  0x0: [true, true, false],
  0x1: [false, true, false],
  0x2: [false, false, true],
  0x4: [true, true, true],
  0x5: [true, false, true],
  0x6: [false, true, true],
  0x8: [true, false, false],
  0x9: [false, false, false],
  0xa: [true, false, true],
};

/** Which order the three groups arrived in, chosen by another four bits. */
const V2_ORDER: Record<number, [number, number, number]> = {
  0x0: [0, 2, 1],
  0x1: [2, 0, 1],
  0x2: [0, 1, 2],
  0x4: [1, 2, 0],
  0x5: [1, 0, 2],
  0x6: [2, 1, 0],
  0x8: [1, 2, 0],
  0x9: [2, 1, 0],
  0xa: [0, 1, 2],
};

/**
 * Undo one half's scrambling.
 *
 * Thirty bits arrive with three ten-bit groups interleaved a bit at a time. Eight further bits say which of
 * the groups were sent inverted and what order they were put in — so the same payload looks different on
 * every press. Both permutations are undone here, and anything naming a combination that does not exist is
 * refused rather than guessed at.
 *
 * Returns the twenty fixed bits packed into three bytes, or null if the packet does not make sense.
 */
/**
 * Undo the group scrambling, given the indicator byte and the thirty interleaved bits.
 *
 * Returns the three ten-bit groups the right way up and in the right order, and fills in the nine base-three
 * counter digits. Null means the packet named a combination this protocol never sends, or produced a digit
 * that does not exist in base three.
 *
 * Chamberlain reuses this exact permutation, bit for bit, inside an unrelated motion sensor, so it is shared
 * from here rather than written out a second time — those twenty cases are the easiest thing in this protocol
 * to transcribe wrongly, and a single transposed entry would still pass every structural check.
 */
export function secplusPermute(orderInvert: number, x30: number, roll: Uint8Array):
  { p0: number; p1: number; p2: number } | null {
  const inv = V2_INVERT[orderInvert & 0x0f];
  const ord = V2_ORDER[orderInvert >> 4];
  if (!inv || !ord) return null;

  // Three groups, interleaved one bit at a time, least significant first.
  let x = x30 >>> 0;
  let p0 = 0, p1 = 0, p2 = 0;
  for (let i = 0; i < 10; i++) {
    p2 ^= (x & 1) << i; x >>>= 1;
    p1 ^= (x & 1) << i; x >>>= 1;
    p0 ^= (x & 1) << i; x >>>= 1;
  }
  if (inv[0]) p0 = ~p0 & 0x3ff;
  if (inv[1]) p1 = ~p1 & 0x3ff;
  if (inv[2]) p2 = ~p2 & 0x3ff;

  const groups = [p0, p1, p2];
  p0 = groups[ord.indexOf(0)];
  p1 = groups[ord.indexOf(1)];
  p2 = groups[ord.indexOf(2)];

  // The counter's digits: four from the indicator byte, five more from the third group.
  let k = 0;
  for (let i = 6; i >= 0; i -= 2) roll[k++] = (orderInvert >> i) & 0x03;
  for (let i = 8; i >= 0; i -= 2) roll[k++] = (p2 >> i) & 0x03;
  for (let i = 0; i < 9; i++) if (roll[i] === 3) return null;

  return { p0, p1, p2 };
}

function v2DecodeHalf(packet: BitBuffer, roll: Uint8Array): Uint8Array | null {
  const head = packet.bytes(0, 4, 8);              // the order and inversion indicators
  const raw = packet.bytes(0, 12, 30);
  const x = (((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0) >>> 2;

  const g = secplusPermute(head[0], x, roll);
  if (!g) return null;

  const fixed = new Uint8Array(3);
  let bi = 0;
  const put = (v: number) => { if (v) fixed[bi >> 3] |= 0x80 >> (bi & 7); bi++; };
  for (let i = 9; i >= 0; i--) put((g.p0 >> i) & 1);
  for (let i = 9; i >= 0; i--) put((g.p1 >> i) & 1);
  return fixed;
}

export const secplusV2: RDevice = register({
  num: 164,
  name: 'Security+ 2.0 (Keyfob)',
  what: 'garage door opener',
  modulation: Modulation.OOK_PCM,
  shortWidth: 250,
  longWidth: 250,
  tolerance: 50,
  gapLimit: 1500,
  resetLimit: 9000,
  bands: [310000000, 315000000, 390000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let half1: { fixed: Uint8Array; roll: Uint8Array } | null = null;
    let half2: { fixed: Uint8Array; roll: Uint8Array } | null = null;

    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] < 110) continue;
      const at = bits.search(row, 0, V2_PREAMBLE, 28);
      if (at >= bits.bitsPerRow[row]) break;

      const packet = new BitBuffer();
      bits.manchesterDecode(row, at + 26, packet, 80);
      if (packet.bitsPerRow[0] < 42) continue;

      // The first, third and fourth bits are always clear; the second says which half this is.
      const head = packet.bb[0][0];
      if (head & 0xb0) continue;

      const roll = new Uint8Array(16);
      const fixed = v2DecodeHalf(packet, roll);
      if (!fixed) continue;

      if (head & 0xc0) half2 = { fixed, roll };
      else half1 = { fixed, roll };
      if (half1 && half2) break;
    }

    if (!half1 && !half2) return DECODE_ABORT_EARLY;

    if (!half1 || !half2) {
      // Marry this half to one already waiting, if it is still fresh.
      const fresh = v2HeldAt && secplusClock.now() - v2HeldAt < CACHE_MS;
      if (half1) v2Held1 = half1; else v2Held2 = half2;
      v2HeldAt = secplusClock.now();

      if (fresh && v2Held1 && v2Held2) {
        half1 = v2Held1;
        half2 = v2Held2;
        v2Held1 = null;
        v2Held2 = null;
        v2HeldAt = 0;
      } else {
        if (!fresh) {                              // whatever was waiting is too old to trust
          if (half1) v2Held2 = null; else v2Held1 = null;
        }
        return DECODE_ABORT_EARLY;
      }
    } else {
      v2Held1 = null;
      v2Held2 = null;
      v2HeldAt = 0;
    }

    // The counter's digits come from the two halves alternately, and not in the order they arrived.
    const digits: number[] = [half2.roll[8], half1.roll[8]];
    for (let i = 4; i < 8; i++) digits.push(half2.roll[i]);
    for (let i = 4; i < 8; i++) digits.push(half1.roll[i]);
    for (let i = 0; i < 4; i++) digits.push(half2.roll[i]);
    for (let i = 0; i < 4; i++) digits.push(half1.roll[i]);

    let rollingTemp = 0;
    for (let i = 0; i < 18; i++) rollingTemp = rollingTemp * 3 + digits[i];
    if (rollingTemp >= 0x10000000) return DECODE_FAIL_SANITY;   // twenty-eight bits is all it can be
    const rolling = reverse32(rollingTemp) >>> 4;

    // Forty bits across the two halves, so this is built by arithmetic: JavaScript's bitwise operators would
    // truncate it to thirty-two. The first half's last byte is masked to its top nibble, which is the only
    // part of it that is real, so the two halves cannot overlap and adding is exactly the intended exclusive-or.
    const f1 = half1.fixed, f2 = half2.fixed;
    const fixedTotal = f1[0] * 4294967296 + f1[1] * 16777216 + (f1[2] & 0xf0) * 65536
      + f2[0] * 4096 + f2[1] * 16 + ((f2[2] >> 4) & 0x0f);

    ctx.emit({
      model: 'Secplus-v2',
      type: 'Remote',
      id: fixedTotal % 4294967296,
      button_id: Math.floor(fixedTotal / 4294967296),
      remote_id: fixedTotal % 4294967296,
      fixed: String(fixedTotal),
      rolling: String(rolling),
    });
    return 1;
  },
});
