/**
 * The Microchip KeeLoq hopping encoders.
 *
 * These have no payload to sanity-check — a hopping code is meant to look like noise — so what can be proved
 * is the frame layout, the button reordering, the two-bit checks, and the one thing most likely to be got
 * wrong: the battery bit means opposite things on the HCS200 and the HCS361.
 *
 * Where a device has a check, the test computes it with the decoder's own algorithm and then also corrupts a
 * payload byte to confirm the check is actually consulted. That second half is what makes it worth running:
 * a checksum that is computed and ignored would pass the first assertion and fail the second.
 *
 * Not covered here: the RainPoint HCS012ARF, the Baldr HCS528ARF and the HCS362 in Manchester. All three
 * reach their payload through a Manchester decode, so testing them needs a Manchester-encoded source row —
 * three transforms run backwards — and a guess at our encoder's convention. Left untested rather than faked.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** A preamble row and a data row, each truncated to its own bit count. */
const twoRows = (pre, preBits, data, dataBits) => {
  const bb = new BitBuffer();
  for (let i = 0; i < preBits; i++) bb.addBit((pre[i >> 3] >> (7 - (i & 7))) & 1);
  bb.addRow();
  for (let i = 0; i < dataBits; i++) bb.addBit((data[i >> 3] >> (7 - (i & 7))) & 1);
  return bb;
};
const bitAt = (b, i) => (b[i >> 3] >> (7 - (i % 8))) & 1;

console.log('Microchip KeeLoq hopping encoders');

// ---- HCS200 / HCS300 (131 keyed, 218 shifted): no check at all, so layout is all there is ----
{
  // Reversed bytes give encrypted 04030201 and serial 8000000; button nibble 1 must come out as 4.
  const b = [0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x11, 0x40];
  const bb = () => twoRows([0xff, 0xf0], 12, b, 66);

  for (const [num, how] of [[131, 'keyed'], [218, 'frequency shifted']]) {
    const d = run(dev(num), bb())[0];
    ok(!!d, `HCS200 decodes (${how})`, JSON.stringify(d));
    if (d) {
      eq(d.model, 'Microchip-HCS200', `  HCS200 model (${how})`);
      eq(d.id, '8000000', `  HCS200 serial, assembled from reversed bytes (${how})`);
      eq(d.encrypted, '04030201', `  HCS200 hopping code is reported as it arrived (${how})`);
      // The four button lines arrive as S3, S0, S1, S2 — nibble 1 is S0, which is button 4.
      eq(d.button, 4, `  HCS200 button lines are put back in order (${how})`);
      eq(d.repeat, 1, `  HCS200 repeat flag (${how})`);
      // On this part the bit means "low", and it is clear here.
      eq(d.battery_ok, 1, `  HCS200 battery bit set means low, so clear means good (${how})`);
    }
  }

  // The all-ones payload is a receiver artefact, not a remote.
  ok(!run(dev(131), twoRows([0xff, 0xf0], 12, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00], 66))[0],
    '  HCS200 rejects an all-ones payload');
  // A frame whose preamble is not there at all.
  ok(!run(dev(131), twoRows([0x00, 0x00], 12, b, 66))[0], '  HCS200 rejects a missing preamble');
  // The learn-mode nibble.
  const learn = [...b]; learn[7] = 0x1f;
  eq(run(dev(131), twoRows([0xff, 0xf0], 12, learn, 66))[0].learn, 1, '  HCS200 reports learn mode');
}

// ---- HCS361 (306): a two-bit check, and a battery bit that means the opposite of the HCS200's ----
{
  const mk = (payload) => {
    const b = [...payload];
    b[8] = 0x80;                       // battery good on this part — and part of the checked bits
    let crc = 0;
    for (let i = 0; i < 65; i++) {
      const bit = b[i >> 3] >> (7 - (i % 8));
      const crcBit = ((crc >> 1) ^ bit) & 0x1;
      crc = crcBit | (((crcBit ^ crc) << 1) & 0x2);
    }
    b[8] = 0x80 | (crc << 5);
    return twoRows([0xff, 0xf0], 12, b, 67);
  };

  const d = run(dev(306), mk([0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x11, 0]))[0];
  ok(!!d, 'HCS361 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Microchip-HCS361', '  HCS361 model');
    eq(d.encrypted, '04030201', '  HCS361 hopping code');
    eq(d.id, '08000000', '  HCS361 serial is eight digits, not the HCS200\'s seven');
    eq(d.button, 4, '  HCS361 button lines are put back in order');
    // The inversion trap: set means GOOD here, the reverse of the HCS200.
    eq(d.battery_ok, 1, '  HCS361 battery bit set means good, unlike the HCS200');
  }

  // The check must actually be consulted: corrupt a payload byte, leaving the stored check alone.
  const good = mk([0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x11, 0]);
  const bad = new BitBuffer();
  for (let i = 0; i < 12; i++) bad.addBit(bitAt([0xff, 0xf0], i));
  bad.addRow();
  for (let i = 0; i < 67; i++) bad.addBit(i === 3 ? 1 - bitAt(good.bb[1], i) : bitAt(good.bb[1], i));
  ok(!run(dev(306), bad)[0], '  HCS361 rejects a frame whose check no longer holds');

  // All six registrations are the same decoder at different bit rates; each should read the same frame.
  for (const num of [307, 308, 309, 310, 311]) {
    ok(!!run(dev(num), mk([0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x11, 0]))[0],
      `  HCS361 variant ${num} shares the decoder`);
  }
  // A serial of zero is not a remote.
  ok(!run(dev(306), mk([0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x01, 0]))[0],
    '  HCS361 rejects an all-zero serial');
}

// ---- HCS362 keyed (329): its own two-bit check, stored bit-swapped ----
{
  const mk = (payload, batteryLow = false) => {
    const b = [...payload];
    b[8] = batteryLow ? 0x80 : 0x00;
    let crc0 = 0, crc1 = 0;
    for (let n = 0; n < 65; n++) {
      const d0 = (b[n >> 3] >> (7 - (n % 8))) & 1;
      const n1 = crc0 ^ d0;
      const n0 = crc0 ^ d0 ^ crc1;
      crc0 = n0; crc1 = n1;
    }
    const crc = (crc1 << 1) | crc0;
    // Stored with its bits the other way round: bit 6 is the low bit, bit 5 the high one.
    b[8] |= ((crc & 1) << 6) | (((crc >> 1) & 1) << 5);
    return twoRows([0xff, 0xf0], 12, b, 69);
  };

  const d = run(dev(329), mk([0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x11, 0]))[0];
  ok(!!d, 'HCS362 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Microchip-HCS362', '  HCS362 model');
    eq(d.encrypted, '04030201', '  HCS362 hopping code');
    eq(d.id, '8000000', '  HCS362 serial');
    eq(d.button, 4, '  HCS362 button lines are put back in order');
    eq(d.battery_ok, 1, '  HCS362 battery bit set means low, as on the HCS200');
  }

  const low = run(dev(329), mk([0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x11, 0], true))[0];
  ok(!!low, '  HCS362 decodes with the battery flag set', JSON.stringify(low));
  if (low) eq(low.battery_ok, 0, '    and reports the battery as low');

  // Corrupt a payload byte and the check must catch it.
  const good = mk([0x80, 0x40, 0xc0, 0x20, 0x00, 0x00, 0x00, 0x11, 0]);
  const bad = new BitBuffer();
  for (let i = 0; i < 12; i++) bad.addBit(bitAt([0xff, 0xf0], i));
  bad.addRow();
  for (let i = 0; i < 69; i++) bad.addBit(i === 5 ? 1 - bitAt(good.bb[1], i) : bitAt(good.bb[1], i));
  ok(!run(dev(329), bad)[0], '  HCS362 rejects a frame whose check no longer holds');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
