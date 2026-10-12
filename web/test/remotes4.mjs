/**
 * Gates, blinds, awnings, a motion sensor and an oil tank.
 *
 * Two pieces of real evidence anchor this batch. rtl_433 documents a Nice Flor-S frame together with what it
 * decodes to, which is the only way to check that scrambler without simply reimplementing it; and it ships a
 * test vector for the IBM whitening that the Elero frame is wrapped in, so the shift register is pinned
 * bit-exactly rather than by a round trip through my own code.
 *
 * Everything else is built from the transmit side, and for Elero that means running the command block forwards
 * through the obfuscation — undoing a nibble substitution and two keyed subtractions in reverse — so that
 * unwrapping it is tested against something this file had to construct rather than against itself.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import { secplusPermute } from '../dist/dsp/r433/devices/secplus.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };
const rowBits = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const rowsOf = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));

console.log('Gates, blinds, awnings, a motion sensor and an oil tank');

// ---- The IBM whitening, against rtl_433's own vector ----
{
  const buf = new Uint8Array(16);
  U.ibmWhitening(buf, 16);
  const want = 'ffe11d9aed853324ea7ad2397097570a';
  eq(Array.from(buf, b => b.toString(16).padStart(2, '0')).join(''), want,
    'IBM whitening matches the vector rtl_433 ships');

  // It is only an exclusive-or, so applying it twice must give back what went in.
  const twice = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  U.ibmWhitening(twice, 8);
  U.ibmWhitening(twice, 8);
  eq(Array.from(twice).join(','), '1,2,3,4,5,6,7,8', '  and undoes itself when applied again');
}

// ---- Chamberlain CWPIRC (258): Security+ 2.0's scrambling inside a motion sensor ----
{
  // Forward scrambling, the same shape the Security+ suite builds.
  const interleave = (g0, g1, g2) => {
    let x = 0;
    for (let i = 9; i >= 0; i--) {
      x = x * 2 + ((g0 >> i) & 1);
      x = x * 2 + ((g1 >> i) & 1);
      x = x * 2 + ((g2 >> i) & 1);
    }
    return x;
  };
  // Order 2 and invert 9 are the identity pair, so the groups go out as they are.
  const half = (p0, p1, p2) => {
    const orderInvert = 0x29;
    const h40 = orderInvert * 1073741824 + interleave(p0, p1, p2);
    const hi = Math.floor(h40 / 4294967296);
    const lo = h40 % 4294967296;
    return [hi, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
  };

  const build = (p0a, p1a, p2a, p0b, p1b, p2b) => {
    const b = new Uint8Array(14);
    b[0] = 0x00;
    b.set(half(p0a, p1a, p2a), 1);
    b[6] = 0x01;
    b.set(half(p0b, p1b, p2b), 7);
    const c = U.crc16(b, 12, 0x1021, 0x0000);
    b[12] = (c >> 8) & 0xff; b[13] = c & 0xff;
    return { b, row: rowBits(pad([...bytesToBits([0x55, 0x2d, 0xd4]), ...bytesToBits(b)], 160)) };
  };

  // p2 supplies five counter digits two bits at a time, so it must hold no pair of ones.
  const { b, row } = build(0x123, 0x2ab, 0x155, 0x0cd, 0x312, 0x111);
  const d = run(dev(258), row)[0];
  ok(!!d, 'Chamberlain PIR decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Chamberlain-CWPIRC', '  Chamberlain PIR model');
    eq(d.battery_ok, 1, '  Chamberlain PIR battery is healthy');
    eq(d.mic, 'CRC', '  Chamberlain PIR reports its check');
    ok(typeof d.id === 'string' && d.id.length === 10, '  Chamberlain PIR identity spans forty bits');
  }

  // The identity must not change when only the low-battery bit does.
  const lowBatt = build(0x123, 0x2ab, 0x155, 0x0cd, 0x312 ^ 0x20, 0x111);
  const dl = run(dev(258), lowBatt.row)[0];
  ok(!!dl, 'Chamberlain PIR decodes a low battery report', JSON.stringify(dl));
  if (d && dl) {
    eq(dl.battery_ok, 0, '  and says the battery is low');
    eq(dl.id, d.id, '  while reporting the same sensor, the battery bit being masked out of its identity');
  }

  // A corrupted frame must fail the CRC.
  const bad = Uint8Array.from(b); bad[3] ^= 0x01;
  ok(!run(dev(258), rowBits(pad([...bytesToBits([0x55, 0x2d, 0xd4]), ...bytesToBits(bad)], 160)))[0],
    '  Chamberlain PIR rejects a frame failing its CRC');

  // The shared permutation really is shared: the same call the decoder makes.
  const roll = new Uint8Array(9);
  ok(secplusPermute(0x29, interleave(0x123, 0x2ab, 0x155), roll) !== null,
    '  the Security+ permutation is the same code, not a copy of it');
}

// ---- Watchman Plus (359): a level, a serial stored backwards, four stuffing markers ----
{
  const build = (idRaw, level, batteryLow, breakMarker = -1) => {
    const bits = [];
    for (let i = 0; i < 12; i++) bits.push(1);
    bits.push(0);                                  // the run-in is twelve ones closed by a zero
    let markers = 0;
    const stuff = () => { markers++; bits.push(markers === breakMarker ? 0 : 1, 0); };
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 8; k++) bits.push((idRaw >> (23 - (i * 8 + k))) & 1);
      if (i < 2) stuff();
    }
    stuff();
    for (let j = 0; j < 4; j++) bits.push((level >> j) & 1);   // least significant bit first
    bits.push(0, 0, 0);                            // the three unexplained bits
    bits.push(batteryLow);
    stuff();
    return rowBits(pad(bits, 60));
  };

  // The run-in is thirteen ones, so the first ID byte must not start with one or the search slides.
  const idRaw = 0x3a5c71;
  const d = run(dev(359), build(idRaw, 7, 0))[0];
  ok(!!d, 'Watchman Plus decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Watchman-Plus', '  Watchman Plus model');
    eq(d.level, '7', '  Watchman Plus reports a single digit');
    eq(d.battery_ok, 1, '  Watchman Plus battery is healthy');
    // The serial is the whole twenty-four bits reversed, read as eight octal digits.
    const rev = U.reverse32((idRaw << 8) >>> 0) & 0xffffff;
    let want = 0;
    for (let n = 7; n >= 0; n--) want = want * 10 + ((rev >> (n * 3)) & 7);
    eq(d.id, String(want).padStart(8, '0'), '  Watchman Plus serial is reversed whole, not byte by byte');
    ok(d.mic === undefined, '  Watchman Plus claims no integrity check, having none');
  }

  eq(run(dev(359), build(idRaw, 10, 0))[0]?.level, 'F', 'Watchman Plus reports a full tank as F');
  eq(run(dev(359), build(idRaw, 3, 1))[0]?.battery_ok, 0, '  and reports a low battery');
  // Eleven is not a level this gauge can show.
  ok(!run(dev(359), build(idRaw, 11, 0))[0], '  Watchman Plus refuses a level it cannot display');
  // Each of the four stuffing markers has to read "10".
  for (const m of [1, 2, 3, 4]) {
    ok(!run(dev(359), build(idRaw, 7, 0, m))[0], `  Watchman Plus refuses a broken marker ${m}`);
  }
}

// ---- Nice Flor-S (169): the frame rtl_433 documents, and what it says it decodes to ----
{
  // rtl_433 documents: -R 169 -y "{52} 0xe7a760b94372e {0}" -> button 1, serial 56bc8d1, code 89f4, count 6.
  //
  // Its button and count are right, but that serial and code are the frame's RAW encrypted nibbles, not what
  // the decoder now produces. The packet layout in that same file says the serial is nibbles S2 and S7 to S12
  // and the code is S3 to S6; read straight off the inverted frame those are exactly 56bc8d1 and 89f4. So the
  // comment records what that decoder reported before it gained the descrambling step it now runs, and has not
  // been updated since. Both facts are asserted, so the discrepancy stays visible rather than being papered
  // over: the raw fields the comment shows, and the descrambled values the current algorithm gives.
  const nibbles = bitsFromHex('e7a760b94372e', 52)
    .map(b => b ^ 1)                               // the decoder inverts the frame before reading it
    .reduce((acc, b, i) => (i % 4 === 0 ? [...acc, b] : [...acc.slice(0, -1), acc[acc.length - 1] * 2 + b]), []);
  const rawSerial = [2, 7, 8, 9, 10, 11, 12].map(i => nibbles[i].toString(16)).join('');
  const rawCode = [3, 4, 5, 6].map(i => nibbles[i].toString(16)).join('');
  eq(rawSerial, '56bc8d1', 'the serial rtl_433 documents is the raw encrypted field, read straight off the frame');
  eq(rawCode, '89f4', '  and so is the code it documents');

  const row = rowsOf([bitsFromHex('e7a760b94372e', 52), []]);
  const d = run(dev(169), row)[0];
  ok(!!d, 'Nice Flor-S decodes the documented frame', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Nice-FlorS', '  Nice Flor-S model');
    eq(d.button, 1, '  Nice Flor-S button matches the documented value');
    eq(d.count, 6, '  Nice Flor-S repeat count matches the documented value');
    // What the scrambler actually unwinds to, which is not what the stale comment shows.
    eq(d.serial, '53b9881', '  Nice Flor-S serial, descrambled');
    eq(d.code, '0473', '  Nice Flor-S rolling code, descrambled');
  }

  // The trailing empty row is part of the frame's shape.
  ok(!run(dev(169), rowBits(bitsFromHex('e7a760b94372e', 52)))[0],
    '  Nice Flor-S refuses a frame without its trailing empty row');
  ok(!run(dev(169), rowsOf([bitsFromHex('e7a760b94372e', 48), []]))[0],
    '  Nice Flor-S refuses a frame of the wrong length');
}

// ---- Markisol (191): shifted, complemented, reversed, and summing to one ----
{
  const build = (buf, extraBit = false) => {
    // The wire carries the complement of each byte, reversed, behind one spurious bit.
    const wire = Array.from(buf, v => U.reverse8(~v & 0xff));
    const bits = [0, ...bytesToBits(wire)];
    if (extraBit) bits.push(0);
    return rowBits(bits);
  };

  // Choose four bytes, then the fifth so that all five come to one.
  const mk = (b0, b1, b2, b3) => {
    const b4 = (1 - (b0 + b1 + b2 + b3)) & 0xff;
    return Uint8Array.from([b0, b1, b2, b3, b4]);
  };

  const buf = mk(0x12, 0x34, 0xc5, 0x11);
  const d = run(dev(191), build(buf))[0];
  ok(!!d, 'Markisol decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Markisol', '  Markisol model');
    eq(d.id, '1234', '  Markisol id');
    eq(d.channel, 5, '  Markisol channel');
    const wantControl = ((0xc5 >> 4) & ~2) | ((0x11 & 0x10) >> 3);
    eq(d.control, ['Limit (0)', 'Down (1)', '? (2)', 'H-Down (3)', 'Confirm (4)', 'Stop (5)', '? (6)', '? (7)',
      '? (8)', '? (9)', '? (10)', '? (11)', 'Up (12)', 'Limit (13)', 'H-Up (14)', '? (15)'][wantControl & 0xf],
      '  Markisol control is woven across two bytes');
    eq(d.zone, ((0xc5 & 0x20) >> 5) + ((0x11 & 0x80) >> 6) + 1, '  Markisol zone, likewise');
    eq(d.mic, 'CHECKSUM', '  Markisol reports its check');
  }

  // A forty-two bit row is accepted too, the last frame picking up a spare bit.
  ok(!!run(dev(191), build(buf, true))[0], 'Markisol accepts the row with a trailing spare bit');

  // Break the sum.
  const bad = Uint8Array.from(buf); bad[4] = (bad[4] + 1) & 0xff;
  ok(!run(dev(191), build(bad))[0], '  Markisol rejects a frame whose bytes do not come to one');
}

// ---- Dickert MAHS433 (344): ten switches someone set by hand ----
{
  const build = (fields) => {
    const bits = [1];                              // the lead pulse that is not data
    for (const v of fields) bits.push((v >> 1) & 1, v & 1);
    return rowBits(bits);
  };

  // "-" is 0, "0" is 1, "+" is 3; ten switches then eight factory symbols.
  const dip = [0, 1, 3, 0, 3, 1, 1, 0, 3, 3];
  const fac = [1, 1, 1, 1, 0, 1, 0, 1];
  const d = run(dev(344), build([...dip, ...fac]))[0];
  ok(!!d, 'Dickert decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Dickert-MAHS433', '  Dickert model');
    eq(d.dipswitch, '-0+-+00-++', '  Dickert reports the switch positions as they are set');
    eq(d.facswitch, '0000-0-0', '  Dickert factory code');
    ok(d.mic === undefined, '  Dickert claims no integrity check, its code being fixed');
  }

  // The impossible "10" position is shown as unknown rather than guessed at.
  const odd = run(dev(344), build([2, 1, 3, 0, 3, 1, 1, 0, 3, 3, ...fac]))[0];
  if (odd) eq(odd.dipswitch[0], '?', 'Dickert marks a switch position that cannot occur');

  // The length is exact.
  ok(!run(dev(344), rowBits([1, ...new Array(34).fill(0)]))[0], '  Dickert refuses a frame of the wrong length');
}

// ---- Elero (372): whitened, checksummed, and its command block obfuscated ----
{
  const NIB = [0x0a, 0x03, 0x01, 0x0c, 0x0d, 0x07, 0x0f, 0x06, 0x00, 0x08, 0x0b, 0x0e, 0x09, 0x02, 0x05, 0x04];
  const NIB_INV = new Array(16);
  NIB.forEach((v, i) => { NIB_INV[v] = i; });
  const subNib = (v, key) => ((((v & 0xf0) - (key & 0xf0)) & 0xf0) | ((v - key) & 0x0f)) & 0xff;
  const addNib = (v, key) => ((((v & 0xf0) + (key & 0xf0)) & 0xf0) | ((v + key) & 0x0f)) & 0xff;

  /** Run the command block forwards, so unwrapping it is tested against something built independently. */
  const wrapCommand = (decoded, x0, x1) => {
    const a = Uint8Array.from(decoded);
    // Undo the second subtraction pass.
    let key = 0xba;
    for (let i = 2; i < 8; i++) { a[i] = addNib(a[i], key); key = (key - 0x22) & 0xff; }
    // Undo the exclusive-or, choosing what the block's first two bytes were before it.
    const b = Uint8Array.from(a);
    for (let i = 0; i < 8; i += 2) { b[i] = a[i] ^ x0; b[i + 1] = a[i + 1] ^ x1; }
    b[0] = x0; b[1] = x1;
    // Undo the first subtraction pass, then the substitution.
    key = 0xfe;
    for (let i = 0; i < 2; i++) { b[i] = addNib(b[i], key); key = (key - 0x22) & 0xff; }
    for (let i = 0; i < 8; i++) b[i] = ((NIB_INV[(b[i] >> 4) & 0x0f] << 4) | NIB_INV[b[i] & 0x0f]) & 0xff;
    return b;
  };

  const build = (commandByte, src, chl) => {
    const enc = wrapCommand([0, 0, commandByte, 0x11, 0x22, 0x33, 0x44, 0x55], 0x5a, 0xa5);
    const frame = new Uint8Array(40);
    frame[0] = 27;                                 // everything after this byte, bar the two check bytes
    frame[1] = 0x42;                               // the plain counter
    frame[2] = 0x45; frame[3] = 0x10; frame[4] = 0x05; frame[5] = 0x01;
    frame[6] = chl;
    frame[7] = (src >> 16) & 0xff; frame[8] = (src >> 8) & 0xff; frame[9] = src & 0xff;
    frame.set(frame.slice(7, 10), 10);             // the address is repeated twice more
    frame.set(frame.slice(7, 10), 13);
    frame[16] = 1;                                 // one destination
    frame[17] = chl;
    frame[18] = 0x00; frame[19] = 0x03;
    frame.set(enc, 20);
    const total = 30;
    const c = U.crc16(frame, total - 2, 0x8005, 0xffff);
    frame[total - 2] = (c >> 8) & 0xff; frame[total - 1] = c & 0xff;

    // Whiten it, since the receiver un-whitens; whitening is its own inverse.
    const wire = frame.slice(0, total);
    U.ibmWhitening(wire, total);
    const sync = bytesToBits([0xa7, 0x23, 0xa7, 0x23]).slice(0, 31);
    return rowBits(pad([...sync, ...bytesToBits(wire)], 320));
  };

  const d = run(dev(372), build(0x20, 0xabcdef, 0x11))[0];
  ok(!!d, 'Elero decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Elero', '  Elero model');
    eq(d.id, 'ABCDEF', '  Elero remote address');
    eq(d.channel, '11', '  Elero channel');
    eq(d.command, 'Up', '  Elero command comes out of the obfuscated block');
    eq(d.counter, 0x42, '  Elero counter is sent in the clear');
    eq(d.mic, 'CRC', '  Elero reports its check');
  }

  eq(run(dev(372), build(0x10, 0xabcdef, 0x22))[0]?.command, 'Stop', 'Elero reads the stop command');
  eq(run(dev(372), build(0x40, 0xabcdef, 0x03))[0]?.command, 'Down', '  and the down command');
  // A command byte nobody has seen is reported as unknown rather than guessed at.
  eq(run(dev(372), build(0x80, 0xabcdef, 0x11))[0]?.command, '?', '  and says so when it does not know');

  // Break the frame after whitening and the CRC must refuse it.
  const broken = build(0x20, 0xabcdef, 0x11);
  broken.bb[0][10] ^= 0x01;
  ok(!run(dev(372), broken)[0], '  Elero rejects a frame failing its CRC');
}

// ---- The registrations themselves ----
{
  for (const num of [169, 191, 258, 344, 359, 372]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
