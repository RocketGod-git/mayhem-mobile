/**
 * Car remotes and keyfobs.
 *
 * None of these ships a capture in rtl_433, so every frame is laid out from the transmit side.
 *
 * Three of them compare a byte sum against a value wider than a byte — Chrysler against 0xff*5, Siemens
 * against 0xff*12, GM against zero over thirteen bytes. Those are exercised deliberately, because a masked
 * sum can never reach the saturated values and can reach zero by accident, and that is a mistake this project
 * has already made once.
 *
 * Several of these carry no real integrity check at all. Where that is so the test says which structural
 * property is standing in for one — a duplicated button byte, a constant nibble, a button bitmask that has to
 * agree with a multiple-press flag — and checks that breaking it is refused.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
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
const inv = (bits) => bits.map(b => b ^ 1);
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
/** The full-width byte sum, which is what these remotes' sanity tests are written against. */
const rawSum = (m, n, at = 0) => { let s = 0; for (let i = 0; i < n; i++) s += m[at + i]; return s; };
/** Reflect each byte, as the Chrysler frame arrives. */
const reflect = (bytes) => Uint8Array.from(bytes, b => U.reverse8(b));

console.log('Car remotes and keyfobs');

// ---- Chrysler (303): fixed code, reflected and inverted, with a multiple-press flag to agree with ----
{
  // The decoder reflects what it extracts, so the frame is built forwards and reflected on the way out.
  const build = (buttonNibble) => {
    const b = new Uint8Array(6);
    b[0] = 0x12; b[1] = 0x34; b[2] = 0x56; b[3] = 0x78;
    b[4] = (buttonNibble << 4) | (buttonNibble && (buttonNibble & (buttonNibble - 1)) ? 0x4 : 0x0);
    b[5] = rawSum(b, 5) & 0xff;
    // Reflected, then inverted, since the decoder undoes both.
    return rowBits(inv(bytesToBits(reflect(b))));
  };

  const d = run(dev(303), build(0x1))[0];
  ok(!!d, 'Chrysler decodes a single button', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Chrysler-CarRemote', '  Chrysler model');
    eq(d.id, '12345678', '  Chrysler id');
    eq(d.button_str, 'Unlock', '  Chrysler button');
    eq(d.mic, 'CHECKSUM', '  Chrysler reports its check');
  }

  // Two buttons at once, which must also set the multiple-press flag.
  const d2 = run(dev(303), build(0x3))[0];
  ok(!!d2, 'Chrysler decodes two buttons at once', JSON.stringify(d2));
  if (d2) eq(d2.button_str, 'Unlock; Lock', '  and names both of them');

  // A frame naming two buttons without the flag has decoded wrong, however well its sum adds up.
  const inconsistent = (() => {
    const b = new Uint8Array(6);
    b[0] = 0x12; b[1] = 0x34; b[2] = 0x56; b[3] = 0x78;
    b[4] = (0x3 << 4);                             // two buttons, flag deliberately clear
    b[5] = rawSum(b, 5) & 0xff;
    return rowBits(inv(bytesToBits(reflect(b))));
  })();
  ok(!run(dev(303), inconsistent)[0], '  Chrysler refuses two buttons without the multiple-press flag');

  // No button at all is not a press.
  ok(!run(dev(303), build(0x0))[0], '  Chrysler refuses a frame naming no button');

  // An all-ones frame sums to 0xff*5, which only a full-width sum can recognize.
  const saturated = (() => {
    const b = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, rawSum(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), 5) & 0xff]);
    return rowBits(inv(bytesToBits(reflect(b))));
  })();
  eq(rawSum(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), 5), 0xff * 5,
    'an all-ones Chrysler frame really does sum past a byte');
  ok(!run(dev(303), saturated)[0], '  and Chrysler refuses it');
}

// ---- Nidec (304): a Honda remote with no verifiable check, hence flagged doubtful ----
{
  const build = (button, seq, id, security, tail = 16) => {
    const b = new Uint8Array(8);
    b[0] = (seq >> 8) & 0xff; b[1] = seq & 0xff;
    b[2] = (id >> 16) & 0xff; b[3] = (id >> 8) & 0xff; b[4] = id & 0xff;
    b[5] = 0x50 | button;
    b[6] = (security >> 8) & 0xff; b[7] = security & 0xff;
    // The run-in is searched before the frame is inverted, so it goes out the right way up.
    const frame = inv(bytesToBits(b)).slice(0, 48 + tail);
    return rowBits(pad([...bytesToBits([0xff, 0xff, 0xff, 0xf0]).slice(0, 32), ...frame], 128));
  };

  const d = run(dev(304), build(0x3, 0x1234, 0xabcdef, 0x9876))[0];
  ok(!!d, 'Nidec decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Nidec-OUCG8D', '  Nidec model');
    eq(d.id, 'ABCDEF', '  Nidec id');
    eq(d.sequence, 0x1234, '  Nidec sequence');
    eq(d.button_str, 'Lock', '  Nidec button');
    eq(d.security_bits, 16, '  Nidec says how many security bits actually arrived');
    ok(d.mic === undefined, '  Nidec claims no integrity check, because it has none');
  }

  ok(dev(304).disabled === true, '  Nidec is flagged doubtful, having nothing to rule a frame out with');

  // The constant nibble is the closest thing to a check it has.
  const badConst = (() => {
    const b = new Uint8Array([0x12, 0x34, 0xab, 0xcd, 0xef, 0x60 | 0x3, 0x98, 0x76]);
    return rowBits(pad([...bytesToBits([0xff, 0xff, 0xff, 0xf0]).slice(0, 32), ...inv(bytesToBits(b))], 128));
  })();
  ok(!run(dev(304), badConst)[0], '  Nidec refuses a frame whose constant nibble is wrong');

  // A button code nobody has ever seen is refused.
  ok(!run(dev(304), build(0x7, 0x1234, 0xabcdef, 0x9876))[0], '  Nidec refuses an unobserved button code');
}

// ---- MIC 6SC2 (312): sent least significant bit first ----
{
  const build = (button, seq, encrypted) => {
    const b = new Uint8Array(11);
    b[0] = 0x55; b[1] = 0x54;
    b[2] = U.reverse8(encrypted & 0xff);
    b[3] = U.reverse8((encrypted >> 8) & 0xff);
    b[4] = U.reverse8((encrypted >> 16) & 0xff);
    b[5] = U.reverse8((encrypted >>> 24) & 0xff);
    b[6] = U.reverse8(button);
    b[7] = U.reverse8(seq & 0xff);
    b[8] = U.reverse8((seq >> 8) & 0xff);
    b[9] = 0x00;
    // The exclusive-or runs over nine bytes from the third, so the last one closes it.
    b[10] = 0;
    let x = 0;
    for (let i = 2; i < 10; i++) x ^= b[i];
    b[10] = x;
    // Nine bytes starting at index two: b[2..10].
    const bb = new BitBuffer();
    for (const v of bytesToBits(b)) bb.addBit(v);
    bb.addRow();
    for (const v of bytesToBits(b)) bb.addBit(v);  // the remote repeats its frame
    return bb;
  };

  const d = run(dev(312), build(0x1, 0x1234, 0xdeadbeef))[0];
  ok(!!d, 'MIC 6SC2 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'MIC6SC2-CarRemote', '  MIC 6SC2 model');
    eq(d.encrypted, 'DEADBEEF', '  MIC 6SC2 turns its code the right way round');
    eq(d.button_str, 'Unlock', '  MIC 6SC2 button');
    eq(d.sequence, 0x1234, '  MIC 6SC2 sequence');
    eq(d.mic, 'CHECKSUM', '  MIC 6SC2 reports its check');
  }

  // Break the run-in and it is not this remote.
  const badPre = build(0x1, 0x1234, 0xdeadbeef);
  badPre.bb[0][0] = 0x56;
  badPre.bb[1][0] = 0x56;
  ok(!run(dev(312), badPre)[0], '  MIC 6SC2 refuses a frame without its run-in');
}

// ---- GM (313): a nibble sum inside a byte sum, both of which must come to zero ----
{
  const build = (button, id, seq, encrypted) => {
    const b = new Uint8Array(14);
    b[0] = 0xff;                                   // the tail of the wake-up
    b[1] = 0x5a;
    b[3] = (id >>> 24) & 0xff; b[4] = (id >> 16) & 0xff; b[5] = (id >> 8) & 0xff; b[6] = id & 0xff;
    b[7] = (seq >> 16) & 0xff; b[8] = (seq >> 8) & 0xff; b[9] = seq & 0xff;
    b[10] = (encrypted >> 16) & 0xff; b[11] = (encrypted >> 8) & 0xff; b[12] = encrypted & 0xff;
    // The button byte's own two nibbles must sum to a multiple of sixteen.
    for (let hi = 1; hi < 16; hi++) {
      const cand = (hi << 4) | button;
      if ((((cand >> 4) + (cand & 0x0f)) & 0x0f) === 0) { b[2] = cand; break; }
    }
    // The whole payload from byte one must sum to a multiple of two hundred and fifty six.
    b[13] = 0;
    b[13] = (256 - (rawSum(b, 12, 1) & 0xff)) & 0xff;
    return rowBits(pad([...bytesToBits(b)], 113));
  };

  const d = run(dev(313), build(0x1, 0x12345678, 0x9abcde, 0xf01234))[0];
  ok(!!d, 'GM decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'GM-ABO1502T', '  GM model');
    eq(d.id, '5A12345678', '  GM id carries a leading byte of its own');
    eq(d.button_str, 'Unlock', '  GM button');
    eq(d.sequence, 0x9abcde, '  GM sequence');
    eq(d.encrypted, 'F01234', '  GM code');
    eq(d.mic, 'CHECKSUM', '  GM reports its check');
  }

  // Break the outer sum only, leaving the button nibbles intact.
  const badOuter = build(0x1, 0x12345678, 0x9abcde, 0xf01234);
  const bits = [];
  for (let i = 0; i < badOuter.bitsPerRow[0]; i++) bits.push((badOuter.bb[0][i >> 3] >> (7 - (i & 7))) & 1);
  bits[40] ^= 1;
  ok(!run(dev(313), rowBits(bits))[0], '  GM rejects a frame failing its payload sum');

  // A payload of nothing but zeroes sums to zero, which the full-width test is there to catch.
  const zeroes = rowBits(pad(bytesToBits(new Uint8Array([0xff, ...new Array(13).fill(0)])), 113));
  ok(!run(dev(313), zeroes)[0], '  GM refuses an all-zero payload');
}

// ---- Siemens 5WY72XX (314): six buttons, little endian, closed by an exclusive-or ----
{
  const build = (buttonMask, id, seq, encrypted) => {
    const b = new Uint8Array(12);
    b[0] = id & 0xff; b[1] = (id >> 8) & 0xff; b[2] = (id >> 16) & 0xff; b[3] = (id >>> 24) & 0xff;
    b[4] = buttonMask;
    b[5] = (seq >> 8) & 0xff; b[6] = seq & 0xff;
    b[7] = encrypted & 0xff; b[8] = (encrypted >> 8) & 0xff;
    b[9] = (encrypted >> 16) & 0xff; b[10] = (encrypted >>> 24) & 0xff;
    b[11] = 0;
    let x = 0;
    for (let i = 0; i < 11; i++) x ^= b[i];
    b[11] = x;                                     // the last byte closes the exclusive-or
    return rowBits(pad([...bytesToBits([0x60, 0x01]), ...bytesToBits(b)], 130));
  };

  const d = run(dev(314), build(0x01, 0x12345678, 0xabcd, 0xdeadbeef))[0];
  ok(!!d, 'Siemens decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Siemens-5WY72XX', '  Siemens model');
    eq(d.id, '12345678', '  Siemens id is little endian on the wire');
    eq(d.encrypted, 'DEADBEEF', '  Siemens code, likewise');
    eq(d.button_str, 'Lock', '  Siemens button');
    eq(d.sequence, 0xabcd, '  Siemens sequence');
    eq(d.mic, 'CHECKSUM', '  Siemens reports its check');
  }

  // Three buttons held at once.
  const d3 = run(dev(314), build(0x01 | 0x04 | 0x20, 0x12345678, 0xabcd, 0xdeadbeef))[0];
  ok(!!d3, 'Siemens decodes several buttons at once', JSON.stringify(d3));
  if (d3) eq(d3.button_str, 'Lock; Trunk; Right Door', '  and names each of them');

  // An all-ones payload sums to 0xff*12, which only a full-width sum can recognize.
  const saturated = rowBits(pad([...bytesToBits([0x60, 0x01]), ...bytesToBits(new Uint8Array(12).fill(0xff))], 130));
  eq(rawSum(new Uint8Array(12).fill(0xff), 12), 0xff * 12, 'an all-ones Siemens frame sums well past a byte');
  ok(!run(dev(314), saturated)[0], '  and Siemens refuses it');

  const bad = build(0x01, 0x12345678, 0xabcd, 0xdeadbeef);
  bad.bb[0][4] ^= 0x01;
  ok(!run(dev(314), bad)[0], '  Siemens rejects a frame failing its exclusive-or');
}

// ---- Alps FWB1U545 (315): no checksum, just a button byte sent twice ----
{
  const build = (button, id, seq) => {
    const b = new Uint8Array(10);
    b[0] = 0x55;
    b[1] = (id >>> 24) & 0xff; b[2] = (id >> 16) & 0xff; b[3] = (id >> 8) & 0xff; b[4] = id & 0xff;
    b[5] = (button << 4) | 0x0; b[6] = b[5];       // the duplicate copy is the whole of its integrity
    b[7] = (seq >> 8) & 0xff; b[8] = seq & 0xff;
    return rowBits(bytesToBits(b).slice(0, 76));
  };

  const d = run(dev(315), build(0xe, 0x12345678, 0x00ab))[0];
  ok(!!d, 'Alps decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Alps-FWB1U545', '  Alps model');
    eq(d.id, '12345678', '  Alps id');
    eq(d.button_str, 'Lock', '  Alps button');
    eq(d.sequence, 0x00ab, '  Alps sequence');
    ok(d.mic === undefined, '  Alps claims no integrity check, having none');
  }

  // The two copies of the button byte disagreeing is the only way this frame can be caught out.
  const badCopy = build(0xe, 0x12345678, 0x00ab);
  badCopy.bb[0][6] = 0xc0;
  ok(!run(dev(315), badCopy)[0], '  Alps refuses a frame whose duplicated button byte disagrees');

  // The length is exact.
  const short = rowBits(bytesToBits(new Uint8Array([0x55, 0x12, 0x34, 0x56, 0x78, 0xe0, 0xe0, 0x00, 0xab])).slice(0, 70));
  ok(!run(dev(315), short)[0], '  Alps refuses a frame of the wrong length');
}

// ---- Continental (316) and the Honda keyfob (327): one remote, two readings ----
{
  const buildContinental = (button, id, seq, encrypted) => {
    const b = new Uint8Array(14);
    b[0] = (id >>> 24) & 0xff; b[1] = (id >> 16) & 0xff; b[2] = (id >> 8) & 0xff; b[3] = id & 0xff;
    b[4] = 0x11;
    b[5] = (button << 4) | 0x2;
    b[6] = (seq >> 16) & 0xff; b[7] = (seq >> 8) & 0xff; b[8] = seq & 0xff;
    b[9] = (encrypted >>> 24) & 0xff; b[10] = (encrypted >> 16) & 0xff;
    b[11] = (encrypted >> 8) & 0xff; b[12] = encrypted & 0xff;
    b[13] = 0;
    let x = 0;
    for (let i = 0; i < 13; i++) x ^= b[i];
    b[13] = x;
    return rowBits(pad([...bytesToBits([0xf0, 0xf0, 0x60]).slice(0, 20), ...bytesToBits(b)], 140));
  };

  const d = run(dev(316), buildContinental(0x3, 0x12345678, 0x00abcd, 0xdeadbeef))[0];
  ok(!!d, 'Continental decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Continental-KR5V2X', '  Continental model');
    eq(d.id, '12345678', '  Continental id');
    eq(d.button_str, 'Unlock', '  Continental button');
    eq(d.sequence, 0x00abcd, '  Continental sequence');
    eq(d.encrypted, 'DEADBEEF', '  Continental code');
    eq(d.mic, 'CHECKSUM', '  Continental reports its check');
  }

  const bad = buildContinental(0x3, 0x12345678, 0x00abcd, 0xdeadbeef);
  bad.bb[0][5] ^= 0x01;
  ok(!run(dev(316), bad)[0], '  Continental rejects a frame failing its exclusive-or');

  // The Honda keyfob reading of the same air: a manufacturer code, then fields behind a real CRC.
  const buildHonda = (event, id, counter, code) => {
    const b = new Uint8Array(15);
    b[0] = 0x62;                                   // the third byte of the manufacturer code is checked too
    b[1] = 0x08;                                   // packet index
    b[2] = (id >>> 24) & 0xff; b[3] = (id >> 16) & 0xff; b[4] = (id >> 8) & 0xff; b[5] = id & 0xff;
    b[6] = event;
    b[7] = (counter >> 16) & 0xff; b[8] = (counter >> 8) & 0xff; b[9] = counter & 0xff;
    b[10] = (code >>> 24) & 0xff; b[11] = (code >> 16) & 0xff;
    b[12] = (code >> 8) & 0xff; b[13] = code & 0xff;
    b[14] = U.crc8(b, 14, 0x2f, 0x00);
    // The decoder skips the first two bytes of the manufacturer code, so they lead the row.
    return rowBits(pad([...bytesToBits([0xec, 0x0f]), ...bytesToBits(b)], 160));
  };

  const h = run(dev(327), buildHonda(0x22, 0x12345678, 0x00abcd, 0xdeadbeef))[0];
  ok(!!h, 'Honda keyfob decodes', JSON.stringify(h));
  if (h) {
    eq(h.model, 'Honda-KR5V2X1X', '  Honda keyfob model');
    eq(h.id, '12345678', '  Honda keyfob id');
    eq(h.event, 'Unlock', '  Honda keyfob event');
    eq(h.counter, '00abcd', '  Honda keyfob counter');
    eq(h.code, 'deadbeef', '  Honda keyfob rolling code');
    eq(h.mic, 'CRC', '  Honda keyfob reports a real CRC, unlike the Continental reading');
  }

  const badH = buildHonda(0x22, 0x12345678, 0x00abcd, 0xdeadbeef);
  badH.bb[0][6] ^= 0x01;
  ok(!run(dev(327), badH)[0], '  Honda keyfob rejects a frame failing its CRC');
}

// ---- The registrations themselves ----
{
  for (const num of [303, 304, 312, 313, 314, 315, 316, 327]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
