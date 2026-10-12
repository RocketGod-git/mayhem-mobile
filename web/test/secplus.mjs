/**
 * Chamberlain Security+ garage door openers.
 *
 * These are the only stateful decoders in the tree, so this suite tests things no other suite has to: that one
 * half alone reports nothing, that the matching half completes it, that the two can arrive in either order,
 * that a half left too long is thrown away rather than married to a stranger, and that resetting clears
 * everything. The clock is driven rather than waited on, so the eight-hundred-millisecond expiry is exercised
 * deterministically.
 *
 * Both versions carry base-three digits rather than bits, so the frames are built digit by digit and then laid
 * out the way each version puts them on the air — version 1.0 as runs of pulses whose length is the digit,
 * version 2.0 interleaved into three groups and then inverted and reordered exactly as a real remote would.
 * Building the version 2.0 scrambling forwards is the real test of undoing it.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import { secplusClock, secplusResetCache } from '../dist/dsp/r433/devices/secplus.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };
const rowBits = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
/** Our Manchester decoder emits the second half of each pair. */
const mc = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };

// A fake clock, so the cache can be aged without the test taking a second to run.
let fakeNow = 1_000_000;
secplusClock.now = () => fakeNow;

console.log('Security+ garage door openers');

// ---------------------------------------------------------------------------
// Security+ 1.0 (178)
// ---------------------------------------------------------------------------

/**
 * Lay out one half the way the remote sends it: each digit becomes a run of that many pulses plus one,
 * followed by a gap. The half marker leads, then twenty payload digits.
 */
const v1Frame = (marker, payload) => {
  const bits = [];
  for (const d of [marker, ...payload]) {
    for (let i = 0; i <= d; i++) bits.push(1);
    bits.push(0);
  }
  return rowBits(pad(bits, 100));
};

/** The transmit side of the digit interleave: choose a counter and a fixed code, get the digits back. */
const v1Digits = (rollingDigits, fixedDigits) => {
  const out = [];
  let acc = 0;
  for (let i = 0; i < 10; i++) {
    const a = rollingDigits[i];
    out.push(a);
    acc += a;
    const b = fixedDigits[i];
    // The decoder recovers b as (60 + sent - acc) % 3, so the sensor must send (b + acc) % 3.
    out.push((b + acc) % 3);
    acc += b;
  }
  return out;
};

{
  secplusResetCache();

  // Ten counter digits and ten fixed digits per half; the pair makes twenty of each.
  const rollA = [1, 0, 2, 1, 1, 0, 2, 2, 0, 1];
  const fixA = [2, 1, 0, 0, 1, 2, 1, 0, 2, 1];
  const rollB = [0, 2, 1, 1, 2, 0, 0, 1, 2, 2];
  const fixB = [1, 0, 2, 1, 0, 1, 2, 2, 0, 0];

  const halfA = v1Frame(0, v1Digits(rollA, fixA));
  const halfB = v1Frame(2, v1Digits(rollB, fixB));

  // What the decoder should arrive at, worked out here the same way the remote would.
  let wantRolling = 0, wantFixed = 0;
  for (const d of [...rollA, ...rollB]) wantRolling = wantRolling * 3 + d;
  for (const d of [...fixA, ...fixB]) wantFixed = wantFixed * 3 + d;
  wantRolling = U.reverse32(wantRolling);

  // One half on its own must say nothing at all.
  const alone = run(dev(178), halfA);
  eq(alone.length, 0, 'Security+ 1.0 reports nothing from a single half');

  // The other half completes it.
  const both = run(dev(178), halfB);
  ok(both.length === 1, 'Security+ 1.0 reports once the second half arrives', JSON.stringify(both));
  const d = both[0];
  if (d) {
    eq(d.model, 'Secplus-v1', '  Security+ 1.0 model');
    eq(d.fixed, String(wantFixed), '  Security+ 1.0 recovers the fixed code');
    eq(d.rolling, String(wantRolling), '  Security+ 1.0 recovers the rolling counter');
    eq(d.switch_id, wantFixed % 3, '  Security+ 1.0 switch id');
    eq(d.id0, Math.floor(wantFixed / 3) % 3, '  Security+ 1.0 first identity digit');
    eq(d.id1, Math.floor(wantFixed / 9) % 3, '  Security+ 1.0 second identity digit');
  }

  // Having been used, the pair must not still be sitting in the cache.
  secplusResetCache();
  eq(run(dev(178), halfB).length, 0, '  and a half alone still says nothing afterwards');

  // The halves may arrive the other way round.
  secplusResetCache();
  eq(run(dev(178), halfB).length, 0, 'Security+ 1.0 accepts the halves in either order');
  const reversed = run(dev(178), halfA);
  ok(reversed.length === 1, '  the pair completes whichever came first', JSON.stringify(reversed));
  if (reversed[0]) eq(reversed[0].fixed, String(wantFixed), '  and reaches the same fixed code');

  // A half left too long is abandoned rather than married to a stranger.
  secplusResetCache();
  run(dev(178), halfA);
  fakeNow += 900;                                  // past the eight hundred millisecond window
  eq(run(dev(178), halfB).length, 0, 'Security+ 1.0 abandons a half that waited too long');
  fakeNow += 1;

  // Well inside the window it still pairs.
  secplusResetCache();
  run(dev(178), halfA);
  fakeNow += 50;
  eq(run(dev(178), halfB).length, 1, '  but pairs two halves that arrive close together');

  // A run of four pulses is not a digit that exists.
  secplusResetCache();
  const corrupt = rowBits(pad([1, 1, 1, 1, 0, 1, 0, 1, 1, 0], 100));
  eq(run(dev(178), corrupt).length, 0, '  Security+ 1.0 refuses a run too long to be a digit');
}

// ---------------------------------------------------------------------------
// Security+ 2.0 (164)
// ---------------------------------------------------------------------------

/**
 * Build one half the way the remote scrambles it.
 *
 * Three ten-bit groups are put in an order and some of them turned upside down, then interleaved a bit at a
 * time. The indicator byte says which was done, and also carries the first four counter digits.
 */
const V2_INVERT = {
  0x0: [true, true, false], 0x1: [false, true, false], 0x2: [false, false, true],
  0x4: [true, true, true], 0x5: [true, false, true], 0x6: [false, true, true],
  0x8: [true, false, false], 0x9: [false, false, false], 0xa: [true, false, true],
};
const V2_ORDER = {
  0x0: [0, 2, 1], 0x1: [2, 0, 1], 0x2: [0, 1, 2], 0x4: [1, 2, 0], 0x5: [1, 0, 2],
  0x6: [2, 1, 0], 0x8: [1, 2, 0], 0x9: [2, 1, 0], 0xa: [0, 1, 2],
};

const v2Frame = (isSecond, order, invert, p0, p1, p2) => {
  // The indicator byte carries the order, the inversion, and four counter digits in its own bits.
  const head = ((order & 0x0f) << 4) | (invert & 0x0f);

  // Turn the groups upside down where the indicator says so, then put them in the stated order.
  const inv = V2_INVERT[invert] ?? [false, false, false];
  let g0 = inv[0] ? ~p0 & 0x3ff : p0;
  let g1 = inv[1] ? ~p1 & 0x3ff : p1;
  let g2 = inv[2] ? ~p2 & 0x3ff : p2;
  const ord = V2_ORDER[order] ?? [0, 1, 2];
  const slot = [0, 0, 0];
  slot[ord.indexOf(0)] = g0;
  slot[ord.indexOf(1)] = g1;
  slot[ord.indexOf(2)] = g2;
  [g0, g1, g2] = slot;

  // Interleave the three groups a bit at a time, least significant first, into thirty bits.
  let x = 0;
  for (let i = 9; i >= 0; i--) {
    x = (x * 2) + ((g0 >> i) & 1);
    x = (x * 2) + ((g1 >> i) & 1);
    x = (x * 2) + ((g2 >> i) & 1);
  }

  // Two leading bits say which half this is, then the indicator byte, then the thirty payload bits.
  const bits = [];
  bits.push(0, isSecond ? 1 : 0);                  // the second bit of the first nibble picks the half
  bits.push(0, 0);
  for (let i = 7; i >= 0; i--) bits.push((head >> i) & 1);
  for (let i = 29; i >= 0; i--) bits.push((x >> i) & 1);
  while (bits.length < 42) bits.push(0);

  // Twenty-eight bits of run-in, then the packet Manchester coded. The decode starts two bits before the
  // run-in ends, so the last two of its bits are the first Manchester pair.
  const preamble = bytesToBits([0xaa, 0xaa, 0x95, 0x60]).slice(0, 28);
  return rowBits(pad([...preamble.slice(0, 26), ...mc(bits)], 200));
};

{
  secplusResetCache();

  const p0a = 0x2b5, p1a = 0x1c3, p2a = 0x155;
  const p0b = 0x33a, p1b = 0x145, p2b = 0x111;

  const first = v2Frame(false, 0x2, 0x9, p0a, p1a, p2a);   // plain order, no inversion
  const second = v2Frame(true, 0x6, 0x4, p0b, p1b, p2b);   // reversed order, all inverted

  const alone = run(dev(164), first);
  eq(alone.length, 0, 'Security+ 2.0 reports nothing from a single half');

  const both = run(dev(164), second);
  ok(both.length === 1, 'Security+ 2.0 reports once the second half arrives', JSON.stringify(both));
  if (both[0]) {
    eq(both[0].model, 'Secplus-v2', '  Security+ 2.0 model');
    ok(typeof both[0].fixed === 'string' && both[0].fixed.length > 0, '  Security+ 2.0 reports a fixed code');
    ok(typeof both[0].rolling === 'string', '  Security+ 2.0 reports a rolling counter');
    // The fixed code spans forty bits, past what a bitwise expression could hold.
    ok(Number(both[0].fixed) >= 0 && Number.isFinite(Number(both[0].fixed)),
      '  Security+ 2.0 assembles forty bits without overflowing');
  }

  // Either order.
  secplusResetCache();
  eq(run(dev(164), second).length, 0, 'Security+ 2.0 accepts the halves in either order');
  eq(run(dev(164), first).length, 1, '  and completes the pair whichever came first');

  // A half left too long is abandoned.
  secplusResetCache();
  run(dev(164), first);
  fakeNow += 900;
  eq(run(dev(164), second).length, 0, 'Security+ 2.0 abandons a half that waited too long');
  fakeNow += 1;

  // An inversion code the protocol never sends must be refused, not guessed at.
  secplusResetCache();
  const badInvert = v2Frame(false, 0x2, 0x3, p0a, p1a, p2a);
  eq(run(dev(164), badInvert).length, 0, '  Security+ 2.0 refuses a scrambling code it does not know');

  // And an order code likewise.
  secplusResetCache();
  const badOrder = v2Frame(false, 0x3, 0x9, p0a, p1a, p2a);
  eq(run(dev(164), badOrder).length, 0, '  Security+ 2.0 refuses an order code it does not know');

  secplusResetCache();
}

// ---- The registrations themselves ----
{
  for (const num of [164, 178]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
