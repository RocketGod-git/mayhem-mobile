/**
 * Two car keys, a satellite handset, a gate opener and a lighting system.
 *
 * The Megacode frame is not invented: rtl_433 documents a worked example (raw 8DF78A, facility 1, id 48881,
 * button 2) and that is built here from the pulse positions upwards and checked against those values. Because
 * each of its twenty-four bits is a window holding exactly one pulse, building the frame means placing every
 * pulse individually — which is a real test of the window arithmetic rather than of a byte layout.
 *
 * Funkbus is built by writing each field in least-significant-bit-first order and then computing its digest
 * from the transmit side, so the shift-register checksum is exercised in both directions.
 *
 * Four of these six have no integrity check at all. For those the test says which structural property is
 * standing in for one, and checks that breaking it is refused.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
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
/** Several rows in one buffer, which some of these decoders need. */
const rowsOf = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => {
    if (i) bb.addRow();
    for (const v of bits) bb.addBit(v);
  });
  return bb;
};

console.log('Car keys, a satellite handset, a gate opener and a light switch');

// ---- Honda car key (64): two fixed bytes and a length, and nothing else ----
{
  const build = (cmd, id, lead = 0xff, mid = 0xff) => {
    const b = new Uint8Array(49);
    b[0] = lead;
    b[38] = mid;
    b[44] = (id >> 8) & 0xff; b[45] = id & 0xff;
    b[46] = (0xaa + cmd) & 0xff;
    return rowBits(bytesToBits(b).slice(0, 392));
  };

  const d = run(dev(64), build(1, 0x1234))[0];
  ok(!!d, 'Honda car key decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Honda-CarRemote', '  Honda car key model');
    eq(d.id, 0x1234, '  Honda car key id');
    eq(d.code, 'unlock', '  Honda car key button');
    ok(d.mic === undefined, '  Honda car key claims no integrity check, having none');
  }

  eq(run(dev(64), build(0, 0x1234))[0]?.code, 'boot', 'Honda car key reads the boot button');
  eq(run(dev(64), build(2, 0x1234))[0]?.code, 'lock', '  and the lock button');
  // A command outside the three known ones is named as unknown rather than guessed at.
  eq(run(dev(64), build(7, 0x1234))[0]?.code, 'unknown', '  and says so when it does not know');

  // The two fixed bytes are the whole of its integrity.
  ok(!run(dev(64), build(1, 0x1234, 0xfe, 0xff))[0], '  Honda car key refuses a frame missing its first marker');
  ok(!run(dev(64), build(1, 0x1234, 0xff, 0xfe))[0], '  Honda car key refuses a frame missing its second marker');
  ok(dev(64).disabled === true, '  Honda car key is flagged doubtful, having nothing to verify');
}

// ---- Ford car key (93): identified by the shape of the rows in front of it ----
{
  const payload = new Uint8Array([0x03, 0xe0, 0x01, 0xe4, 0xe0, 0x90, 0x52, 0x97, 0x39, 0x60]);
  const good = () => rowsOf([[1], new Array(9).fill(0), [1], bytesToBits(payload).slice(0, 78)]);

  const d = run(dev(93), good())[0];
  ok(!!d, 'Ford car key decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Ford-CarRemote', '  Ford car key model');
    eq(d.id, (0x03 << 16) | (0xe0 << 8) | 0x01, '  Ford car key id');
    eq(d.code, 0x97, '  Ford car key code');
    ok(d.mic === undefined, '  Ford car key claims no integrity check');
  }

  // The run-in is three rows of one, nine and one bits; get any of them wrong and it is not this key.
  ok(!run(dev(93), rowsOf([[1, 1], new Array(9).fill(0), [1], bytesToBits(payload).slice(0, 78)]))[0],
    '  Ford car key refuses a run-in whose first row is the wrong length');
  ok(!run(dev(93), rowsOf([[1], new Array(8).fill(0), [1], bytesToBits(payload).slice(0, 78)]))[0],
    '  Ford car key refuses a run-in whose middle row is the wrong length');
  ok(!run(dev(93), rowsOf([[1], [1, ...new Array(8).fill(0)], [1], bytesToBits(payload).slice(0, 78)]))[0],
    '  Ford car key refuses a run-in whose middle row is not empty');
  ok(dev(93).disabled === true, '  Ford car key is flagged doubtful');
}

// ---- Dish remote 6.3 (101): sixteen bits, said three times over ----
{
  const build = (button, fixedLow = 0x02, fixedHigh = 0xa8, repeats = 4) => {
    const b = [((button << 2) | fixedLow) & 0xff, fixedHigh];
    return rowsOf(new Array(repeats).fill(0).map(() => bytesToBits(b)));
  };

  const d = run(dev(101), build(47))[0];
  ok(!!d, 'Dish remote decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Dish-RC63', '  Dish remote model');
    eq(d.button, 'Select', '  Dish remote names the button');
  }
  eq(run(dev(101), build(61))[0]?.button, 'Dish Power', 'Dish remote reads another button');
  eq(run(dev(101), build(23))[0]?.button, 'Mute/Volume Up/Volume Down', '  and one that shares a code');

  // The fixed bits are the whole of its integrity.
  ok(!run(dev(101), build(47, 0x01))[0], '  Dish remote refuses a frame whose low fixed bits are wrong');
  ok(!run(dev(101), build(47, 0x02, 0xa0))[0], '  Dish remote refuses a frame whose high fixed bits are wrong');
  // It must also arrive at least three times.
  ok(!run(dev(101), build(47, 0x02, 0xa8, 2))[0], '  Dish remote refuses a frame not repeated enough');
  ok(dev(101).disabled === true, '  Dish remote is flagged doubtful');
}

// ---- Megacode (199): twenty-four windows, one pulse each ----
{
  // Bit k occupies the window where floor((i+4)/6) == k. A pulse in the back half of that window is a one.
  // Window zero can only hold a one, which is why the top bit of every real frame is set.
  const build = (raw, tweak) => {
    const bits = new Array(144).fill(0);
    for (let k = 0; k < 24; k++) {
      const one = (raw >> (23 - k)) & 1;
      // A one sits at 6k+1 (back half); a nought at 6k-2 (front half).
      const i = one ? 6 * k + 1 : 6 * k - 2;
      bits[i] = 1;
    }
    if (tweak) tweak(bits);
    return rowsOf([bits, bits]);                   // findRepeatedRow wants it said twice
  };

  // The example rtl_433 documents: raw 8DF78A, facility 1, id 48881, button 2.
  const d = run(dev(199), build(0x8df78a))[0];
  ok(!!d, 'Megacode decodes the documented example', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Megacode-Remote', '  Megacode model');
    eq(d.raw, '8DF78A', '  Megacode recovers the documented raw code');
    eq(d.facility, 1, '  Megacode facility code');
    eq(d.id, 48881, '  Megacode transmitter id');
    eq(d.button, 2, '  Megacode button');
  }

  // Two pulses in one window is not a Megacode frame, however plausible the rest looks.
  ok(!run(dev(199), build(0x8df78a, (bits) => { bits[6 * 5 - 2] = 1; }))[0],
    '  Megacode refuses a window holding two pulses');
  // A window with no pulse likewise.
  ok(!run(dev(199), build(0x8df78a, (bits) => { bits[6 * 7 + 1] = 0; bits[6 * 7 - 2] = 0; }))[0],
    '  Megacode refuses a window holding no pulse at all');
  ok(dev(199).disabled === true, '  Megacode is flagged doubtful, its code being fixed and unchecked');
}

// ---- Funkbus (202): a parity bit and a shift-register nibble ----
{
  // Every field is written least significant bit first, matching how the decoder reads them.
  const setReflect = (bits, start, len, value) => {
    for (let i = 0; i < len; i++) bits[start + i] = (value >> i) & 1;
  };
  // The same digest the sensor computes, written out from the transmit side.
  const digest = (bytes, len) => {
    const fullBytes = len >> 3;
    const bitsLeft = len % 8;
    let x = 0;
    for (let i = 0; i < fullBytes; i++) x ^= bytes[i];
    x = (x ^ (bytes[fullBytes] & ((0xff << (8 - bitsLeft)) & 0xff))) & 0xff;
    const nibble = ((x & 0xf0) >> 4) ^ (x & 0x0f);
    let r = 0;
    if (nibble & 0x8) r ^= 0x8c;
    if (nibble & 0x4) r ^= 0x32;
    if (nibble & 0x2) r ^= 0xc8;
    if (nibble & 0x1) r ^= 0x23;
    r &= 0x0f;
    // The parity of the whole exclusive-or byte becomes the fifth bit.
    let ones = 0;
    for (let i = 0; i < 8; i++) if ((x >> i) & 1) ones++;
    return r | ((ones & 1) << 4);
  };
  const toBytes = (bits) => {
    const out = new Uint8Array(6);
    for (let i = 0; i < 48; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  };
  const reflect4 = (v) => ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3);

  const build = (opts = {}) => {
    const bits = new Array(48).fill(0);
    setReflect(bits, 0, 4, 0x4);                   // type
    setReflect(bits, 4, 4, 0x3);                   // subtype
    setReflect(bits, 8, 20, opts.id ?? 0x1abcd);
    setReflect(bits, 30, 1, opts.batLow ?? 0);
    setReflect(bits, 33, 3, opts.command ?? 5);
    setReflect(bits, 36, 2, opts.group ?? 1);
    setReflect(bits, 39, 2, opts.action ?? 2);
    setReflect(bits, 41, 1, opts.repeat ?? 0);
    setReflect(bits, 42, 1, opts.longpress ?? 1);
    // Bits 0 to 42 are now settled, so the digest over them can be computed and written in.
    const c = digest(toBytes(bits), 43);
    setReflect(bits, 43, 1, c >> 4);
    setReflect(bits, 44, 4, reflect4(c & 0x0f));
    if (opts.tweak) opts.tweak(bits);
    return rowBits(bits);
  };

  const d = run(dev(202), build())[0];
  ok(!!d, 'Funkbus decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Funkbus-Remote', '  Funkbus model');
    eq(d.id, 0x1abcd, '  Funkbus serial number');
    eq(d.command, 5, '  Funkbus button');
    eq(d.group, 1, '  Funkbus channel group');
    eq(d.action, 2, '  Funkbus action');
    eq(d.longpress, 1, '  Funkbus reports the button being held');
    eq(d.repeat, 0, '  Funkbus reports this as a first send');
    eq(d.battery_ok, 1, '  Funkbus battery is healthy');
    eq(d.mic, 'CHECKSUM', '  Funkbus reports its check');
  }

  eq(run(dev(202), build({ batLow: 1 }))[0]?.battery_ok, 0, 'Funkbus reports a low battery');
  eq(run(dev(202), build({ repeat: 1 }))[0]?.repeat, 1, '  and a repeated send');

  // Corrupt a payload bit and the digest must refuse it.
  ok(!run(dev(202), build({ tweak: (bits) => { bits[10] ^= 1; } }))[0],
    '  Funkbus rejects a frame failing its digest');
  // Corrupt the parity bit alone.
  ok(!run(dev(202), build({ tweak: (bits) => { bits[43] ^= 1; } }))[0],
    '  Funkbus rejects a frame whose parity bit is wrong');
  // A packet type that is not the remote's is left alone rather than misread.
  ok(!run(dev(202), build({ tweak: (bits) => { setReflect(bits, 0, 4, 0x5); } }))[0],
    '  Funkbus ignores a packet type that is not a remote');
}

// ---- Code Alarm FRDPC2002 (317): an identity folded out of the rolling code ----
{
  const build = (payload, lead = [0x00, 0x00]) => {
    const bits = new Array(60).fill(0);
    // The run-in occupies the first sixteen bits; the payload starts at bit nineteen.
    const leadBits = bytesToBits(lead);
    for (let i = 0; i < 16; i++) bits[i] = leadBits[i];
    const payloadBits = bytesToBits(payload);
    for (let i = 0; i < 40; i++) bits[19 + i] = payloadBits[i];
    return { bits, bb: rowBits(bits) };
  };

  const payload = Uint8Array.from([0x60, 0x12, 0x34, 0x56, 0x78]);
  const { bits, bb } = build(payload);

  // The identity is the rolling code folded against itself, so work it out from the bits independently.
  const codeBytes = new Uint8Array(5);
  for (let i = 0; i < 36; i++) if (bits[23 + i]) codeBytes[i >> 3] |= 0x80 >> (i & 7);
  const wantId = (((codeBytes[0] ^ codeBytes[1]) << 16)
    | ((codeBytes[1] ^ codeBytes[2]) << 8) | (codeBytes[2] ^ codeBytes[3])) >>> 0;

  const d = run(dev(317), bb)[0];
  ok(!!d, 'Code Alarm decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'CodeAlarm-FRDPC2002', '  Code Alarm model');
    eq(d.id, wantId.toString(16).toUpperCase().padStart(6, '0'),
      '  Code Alarm folds its rolling code into a stable identity');
    eq(d.button_code, 6, '  Code Alarm button code');
    eq(d.button_str, 'Lock', '  Code Alarm button');
    eq(d.data, '6012345678', '  Code Alarm reports the payload it read');
  }

  // One code can legitimately name two buttons.
  const twoNames = run(dev(317), build(Uint8Array.from([0x30, 0x12, 0x34, 0x56, 0x78])).bb)[0];
  ok(!!twoNames, 'Code Alarm decodes a code shared by two buttons', JSON.stringify(twoNames));
  if (twoNames) eq(twoNames.button_str, 'Panic; Start', '  and names both of them');

  // A code in none of the tables is reported as unknown rather than guessed.
  const unknown = run(dev(317), build(Uint8Array.from([0x20, 0x12, 0x34, 0x56, 0x78])).bb)[0];
  if (unknown) eq(unknown.button_str, '?', 'Code Alarm says so when a button code means nothing to it');

  // The run-in must be there.
  ok(!run(dev(317), build(payload, [0x01, 0x00]).bb)[0], '  Code Alarm refuses a frame without its run-in');

  // An empty payload, and a saturated one that only a full-width sum can recognize.
  ok(!run(dev(317), build(Uint8Array.from([0, 0, 0, 0, 0])).bb)[0],
    '  Code Alarm refuses an empty payload');
  const saturated = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]);
  let rawSum = 0;
  for (const v of saturated) rawSum += v;
  eq(rawSum, 0xff * 5, 'a saturated Code Alarm payload sums well past a byte');
  ok(!run(dev(317), build(saturated).bb)[0], '  and Code Alarm refuses it');
}

// ---- The registrations themselves ----
{
  for (const num of [64, 93, 101, 199, 202, 317]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
