/**
 * Six thermometers, four of them checked against radio rtl_433 actually captured.
 *
 * Geevon TX19-1 ships seven real captures, Eurochron two, and Auriol and Vauno one each — those go in raw and
 * the documented values come out, which is evidence this file had no hand in producing. Geevon TX16-3's four
 * example packets are given already decoded, so they are re-inverted and fed back through the line code.
 * Only Ecowitt is built from scratch, and its frames are assembled with a CRC written independently of the
 * one under test, so agreement between the two means something.
 *
 * Two upstream documentation errors are asserted rather than papered over: Vauno's comment states a
 * temperature its own stated bits contradict, and Geevon TX16-3's illustrative row carries a check byte that
 * fails the very check the file describes. Both are pinned so a later reader can see the port is right and
 * the comment is not.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** Written from the CRC definition rather than imported, so building and checking are independent. */
const crc8ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[i];
    for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff;
  }
  return r;
};
const lfsr8ref = (m, n, gen, key) => {
  let sum = 0, k = key;
  for (let b = 0; b < n; b++) {
    const d = m[b];
    for (let i = 7; i >= 0; i--) { if ((d >> i) & 1) sum ^= k; k = (k & 1) ? ((k >> 1) ^ gen) & 0xff : k >> 1; }
  }
  return sum;
};
const lfsr8revRef = (m, n, gen, key) => {
  let sum = 0, k = key;
  for (let b = n - 1; b >= 0; b--) {
    const d = m[b];
    for (let i = 7; i >= 0; i--) { if ((d >> i) & 1) sum ^= k; k = (k & 1) ? ((k >> 1) ^ gen) & 0xff : k >> 1; }
  }
  return sum;
};

/** rtl_433 writes its codes as {bits}hexdigits. */
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/ /g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const bitsToBytes = (bits) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
};
const inv = (bits) => bits.map(b => b ^ 1);
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/ /g, '').match(/../g).map(x => parseInt(x, 16)));
/** One row per bit array. */
const rows = (...arrs) => {
  const bb = new BitBuffer();
  arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};

console.log('Ecowitt, Eurochron, Auriol, Vauno and the two Geevons');

// ---- Ecowitt WH53 (127): no capture is published, so frames are built from the transmit side ----
{
  const d = dev(127);
  // 7 header ones, then model 0x53, id, flags+temp high, temp low, 0xff trailer, CRC.
  const build = ({ id = 0x5a, channel = 0, tempRaw = 600, trailer = 0xff, spare = 0, breakCrc = false } = {}) => {
    const b = new Uint8Array(6);
    b[0] = 0x53;
    b[1] = id;
    b[2] = (channel << 4) | (spare << 2) | ((tempRaw >> 8) & 0x03);
    b[3] = tempRaw & 0xff;
    b[4] = trailer;
    b[5] = crc8ref(b, 5, 0x31, 0x00) ^ (breakCrc ? 0xff : 0x00);
    return rows([1, 1, 1, 1, 1, 1, 1, ...bytesToBits(b)]);
  };

  const out = run(d, build({ id: 0x5a, channel: 0, tempRaw: 600 }));
  eq(out.length, 1, 'Ecowitt decodes a well-formed frame');
  eq(out[0]?.id, 0x5a, 'Ecowitt id');
  eq(out[0]?.channel, 1, 'Ecowitt channel is one-based on the wire value 0');
  eq(out[0]?.temperature_C, 20, 'Ecowitt temperature: raw 600 is 20.0 C');

  eq(run(d, build({ channel: 2, tempRaw: 400 }))[0]?.channel, 3, 'Ecowitt channel 3');
  eq(run(d, build({ tempRaw: 0 }))[0]?.temperature_C, -40, 'Ecowitt bottom of range is -40 C');
  eq(run(d, build({ tempRaw: 1023 }))[0]?.temperature_C, 62.3, 'Ecowitt top of ten bits is 62.3 C');

  // Each rejection, with the premise that it is the stated rule doing the rejecting.
  const ch4 = build({ channel: 3 });
  eq(crc8ref(ch4.bytes(0, 3 + 4, 48), 6, 0x31, 0x00), 0, 'the channel-4 frame is otherwise intact (premise)');
  eq(run(d, ch4).length, 0, 'Ecowitt rejects channel 4: the switch has only three positions');

  const spare = build({ spare: 1 });
  eq(crc8ref(spare.bytes(0, 3 + 4, 48), 6, 0x31, 0x00), 0, 'the spare-bits frame is otherwise intact (premise)');
  eq(run(d, spare).length, 0, 'Ecowitt rejects a frame with the always-zero bits set');

  const trailer = build({ trailer: 0xfe });
  eq(crc8ref(trailer.bytes(0, 3 + 4, 48), 6, 0x31, 0x00), 0, 'the bad-trailer frame is otherwise intact (premise)');
  eq(run(d, trailer).length, 0, 'Ecowitt rejects a frame whose trailer is not 0xff');

  eq(run(d, build({ breakCrc: true })).length, 0, 'Ecowitt rejects a bad CRC');

  // Two rows is not a shape this sensor produces.
  const two = rows([1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1]);
  eq(run(d, two).length, 0, 'Ecowitt wants exactly one row');
}

// ---- Eurochron EFTH-800 (152): both documented rows are real ----
{
  const d = dev(152);
  const DATA = bitsFromHex('AB 1F B3 B7 B6 BE 80', 49);   // 48-bit reading plus one spare bit
  const CLOCK = bitsFromHex('2B 1E A9 90 AB D3 83 2A 8', 65);

  // The reading alone.
  const out = run(d, rows(DATA, DATA));
  eq(out.length, 1, 'EFTH-800 decodes its documented capture');
  eq(out[0]?.channel, 6, 'EFTH-800 channel');
  eq(out[0]?.id, 1248, 'EFTH-800 id');
  eq(out[0]?.temperature_C, 19.6, 'EFTH-800 temperature');
  eq(out[0]?.humidity, 49, 'EFTH-800 humidity is BCD');
  eq(out[0]?.battery_ok, 1, 'EFTH-800 battery');
  eq(out[0]?.radio_clock, undefined, 'no clock is reported when no clock packet arrived');

  // With the clock packet, which must not sit in row zero for upstream to read it.
  const withClock = run(d, rows(DATA, CLOCK, CLOCK, DATA));
  eq(withClock.length, 1, 'EFTH-800 still decodes the reading alongside a clock packet');
  eq(withClock[0]?.temperature_C, 19.6, 'the long rows do not disturb the reading');
  eq(withClock[0]?.radio_clock, '2022-12-07T22:47:20', 'EFTH-800 reads the DCF77 clock');

  // The quirk, asserted deliberately: a clock in row zero is passed over because upstream tests `> 0`.
  const rowZero = run(d, rows(CLOCK, CLOCK, DATA, DATA));
  eq(rowZero.length, 1, 'the reading is still found with the clock in row zero');
  eq(rowZero[0]?.radio_clock, undefined, 'a clock in row zero is not read, matching upstream exactly');

  // Silence is all-ones on air, all-zero once inverted.
  const quiet = new Array(49).fill(1);
  eq(run(d, rows(quiet, quiet)).length, 0, 'EFTH-800 rejects an all-ones carrier');

  // A single row is not enough: the check is repetition plus CRC.
  eq(run(d, rows(DATA)).length, 0, 'EFTH-800 needs the packet repeated');

  const broken = [...DATA]; broken[40] ^= 1;
  eq(run(d, rows(broken, broken)).length, 0, 'EFTH-800 rejects a corrupted frame');
}

// ---- Auriol AFT 77 B2 (184): the documented bitbuffer row ----
{
  const d = dev(184);
  const ROW = bitsFromHex('a5 cf 80 20 17 30 0c ac 90', 68);

  const out = run(d, rows(ROW));
  eq(out.length, 1, 'Auriol decodes its documented row');
  eq(out[0]?.id, 248, 'Auriol id');
  eq(out[0]?.temperature_C, 17.3, 'Auriol temperature is three decimal digits scaled by ten');

  // The premise behind using a masked sum: this frame's byte sum really does overflow a byte.
  const ptr = hexToBytes('a5cf802017300cac90');
  const frame = new Uint8Array(8);
  for (let i = 0; i < 8; i++) frame[i] = ((ptr[i] << 4) | (ptr[i + 1] >> 4)) & 0xff;
  let full = 0;
  for (let i = 0; i < 6; i++) full += frame[i];
  ok(full > 0xff, 'Auriol\'s byte sum overflows a byte, so the narrowing is load-bearing (premise)', `sum ${full}`);
  eq(full & 0xff, frame[6], 'and the narrowed sum is what the frame carries');

  /*
   * More readings, built from the transmit side at nibble granularity, because nothing in this frame lines up
   * on a byte until the prefix is dropped. The builder is checked against the real capture first: a generator
   * that cannot reproduce known-good radio is not evidence for anything it produces afterwards.
   */
  {
    const auriolRow = ({ id = 0xf8, flags = 2, negative = false, digits = [1, 7, 3] }) => {
      const n = new Array(17).fill(0);
      n[0] = 0xa; n[1] = 0x5; n[2] = 0xc;          // prefix, then the two fixed nibbles
      n[3] = (id >> 4) & 0x0f; n[4] = id & 0x0f;
      n[5] = 0x0; n[6] = flags;
      n[7] = negative ? 0x8 : 0x0;                 // the sign is bit 3 of this nibble
      n[8] = digits[0]; n[9] = digits[1]; n[10] = digits[2];
      const f = new Uint8Array(8);
      const pack = () => { for (let i = 0; i < 8; i++) f[i] = (n[1 + 2 * i] << 4) | n[2 + 2 * i]; };
      pack();
      let s = 0;
      for (let i = 0; i < 6; i++) s += f[i];
      n[13] = (s >> 4) & 0x0f; n[14] = s & 0x0f;   // the sum, narrowed to a byte as the sensor does
      pack();
      const dig = lfsr8ref(f, 6, 0x83, 0xec);
      n[15] = (dig >> 4) & 0x0f; n[16] = dig & 0x0f;
      const bits = [];
      for (const v of n) for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1);
      return bits;                                 // seventeen nibbles is exactly 68 bits
    };

    const same = auriolRow({ id: 0xf8, flags: 2, negative: false, digits: [1, 7, 3] });
    eq([...bitsToBytes(same)].join(','), [...hexToBytes('a5cf802017300cac90')].join(','),
      'the transmit-side builder reproduces the documented capture exactly');

    const neg = run(d, rows(auriolRow({ negative: true, digits: [1, 7, 3] })));
    eq(neg.length, 1, 'Auriol decodes a negative reading');
    eq(neg[0]?.temperature_C, -17.3, 'Auriol sign nibble gives -17.3 C');

    const hot = run(d, rows(auriolRow({ id: 0x42, digits: [3, 9, 9] })));
    eq(hot.length, 1, 'Auriol decodes a rebuilt frame');
    eq(hot[0]?.id, 0x42, 'Auriol id round-trips');
    eq(hot[0]?.temperature_C, 39.9, 'Auriol reads three decimal digits');
  }

  {
    // The corruption must land inside the 68 bits that are read; a change past them is no test at all.
    const good = bitsFromHex('a5cf802017300cac90', 68);
    const bad = bitsFromHex('a5cf802017300cac80', 68);
    ok(good.join('') !== bad.join(''), 'the corrupted row really does differ within its 68 bits (premise)');
    eq(run(d, rows(bad)).length, 0, 'Auriol rejects a corrupted digest');
  }
  eq(run(d, rows(bitsFromHex('55cf802017300cac90', 68))).length, 0, 'Auriol rejects a frame without its prefix');
  eq(run(d, rows(bitsFromHex('a5cf802017300cac90', 67))).length, 0, 'Auriol wants exactly 68 bits');
}

// ---- Vauno EN8822C (230): the documented sample ----
{
  const d = dev(230);
  const ROW = bitsFromHex('af 0f a2 7c 01 c0', 42);

  const out = run(d, rows(ROW, ROW, ROW, ROW));
  eq(out.length, 1, 'Vauno decodes its documented sample');
  eq(out[0]?.id, 175, 'Vauno id matches the comment');
  eq(out[0]?.humidity, 62, 'Vauno humidity matches the comment');
  eq(out[0]?.channel, 1, 'Vauno channel is one-based; the comment quotes the raw field as 0');
  // The comment says -9.3, but its own stated bits 1111 10100010 are -94, and the code agrees with -9.4.
  eq(out[0]?.temperature_C, -9.4, 'Vauno temperature follows the bits, not the comment\'s -9.3');
  {
    const b = hexToBytes('af0fa27c01c0');
    const twelve = ((b[1] & 0x0f) << 8) | b[2];
    eq(twelve, 0xfa2, 'the comment\'s own binary is 0xfa2 (premise)');
    eq((twelve << 20) >> 20, -94, 'which as a signed twelve-bit value is -94, not -93');
  }

  eq(run(d, rows(ROW, ROW, ROW)).length, 0, 'Vauno needs four matching rows');

  // The all-zero guard, and the premise that such a row would otherwise check out.
  const zero = new Array(42).fill(0);
  {
    const b = new Uint8Array(6);
    const chk = ((b[4] & 0x0f) << 2) | (b[5] >> 6);
    let nib = 0;
    for (let i = 0; i < 4; i++) nib += (b[i] >> 4) + (b[i] & 0x0f);
    eq((nib + (b[4] >> 4)) & 0x3f, chk, 'an all-zero row satisfies the checksum (premise)');
  }
  eq(run(d, rows(zero, zero, zero, zero)).length, 0, 'Vauno throws out the all-zero row anyway');

  const bad = [...ROW]; bad[3] ^= 1;
  eq(run(d, rows(bad, bad, bad, bad)).length, 0, 'Vauno rejects a bad checksum');
}

// ---- Geevon TX19-1 (291): seven real captures ----
{
  const d = dev(291);
  const CAPS = [
    ['75ffd0cfae55aa554c8', 138, 1, 25.5, 81],
    ['75ffd20fac55aa55978', 138, 1, 23.5, 83],
    ['75ffd28fa955aa551e8', 138, 1, 22.7, 86],
    ['75ffd31fa755aa55538', 138, 1, 21.8, 88],
    ['75ffd32fa455aa552e8', 138, 1, 21.7, 91],
    ['75ffd2efa555aa55908', 138, 1, 22.1, 90],
    ['75ffd2cfa555aa55688', 138, 1, 22.3, 90],
  ];
  for (const [hex, id, ch, tc, hum] of CAPS) {
    const row = bitsFromHex(hex, 73);
    const out = run(d, rows(row, row, row));
    eq(out.length, 1, `TX19 decodes capture ${hex}`);
    eq(out[0]?.id, id, `TX19 id from ${hex}`);
    eq(out[0]?.channel, ch, `TX19 channel from ${hex}`);
    eq(out[0]?.temperature_C, tc, `TX19 temperature from ${hex}`);
    eq(out[0]?.humidity, hum, `TX19 humidity from ${hex}`);
    eq(out[0]?.battery_ok, 1, `TX19 battery from ${hex}`);
  }

  // The first capture is the one the file documents in full.
  const b = bitsToBytes(inv(bitsFromHex(CAPS[0][0], 73)));
  eq(b[5], 0xaa, 'TX19 fixed byte 5'); eq(b[6], 0x55, 'TX19 fixed byte 6'); eq(b[7], 0xaa, 'TX19 fixed byte 7');
  eq(lfsr8revRef(b, 8, 0x98, 0x25), b[8], 'TX19 digest, computed independently, matches the frame');

  // TX16's CRC does not accept these, so that direction is unambiguous.
  for (const [hex] of CAPS) {
    const row = bitsToBytes(inv(bitsFromHex(hex, 73)));
    ok(crc8ref(row, 9, 0x31, 0x7b) !== 0, `TX16's CRC rejects TX19 capture ${hex}`);
    eq(run(dev(261), rows(bitsFromHex(hex, 73), bitsFromHex(hex, 73), bitsFromHex(hex, 73))).length, 0,
      `and the TX16 decoder produces nothing for ${hex}`);
  }

  const three = bitsFromHex(CAPS[0][0], 73);
  eq(run(d, rows(three, three)).length, 0, 'TX19 needs three matching rows');
  const short = bitsFromHex(CAPS[0][0], 72);
  eq(run(d, rows(short, short, short)).length, 0, 'TX19 wants exactly 73 bits');
  const broken = [...three]; broken[20] ^= 1;
  eq(run(d, rows(broken, broken, broken)).length, 0, 'TX19 rejects a corrupted frame');
}

// ---- Geevon TX16-3 (261): four documented packets, given already decoded ----
{
  const d = dev(261);
  const PACKETS = [
    ['f4002ac039aa55aa11', 244, 18.4, 57],
    ['f4002ab039aa55aa54', 244, 18.3, 57],
    ['f4002aa039aa55aa28', 244, 18.2, 57],
    ['f4002a9039aa55aaac', 244, 18.1, 57],
  ];
  // Given decoded, so they go back through the line code: invert, then add the spare 73rd bit.
  const wire = (hex) => [...inv(bytesToBits(hexToBytes(hex))), 1];

  for (const [hex, id, tc, hum] of PACKETS) {
    const row = wire(hex);
    const out = run(d, rows(row, row, row));
    eq(out.length, 1, `TX16 decodes packet ${hex}`);
    eq(out[0]?.id, id, `TX16 id from ${hex}`);
    eq(out[0]?.temperature_C, tc, `TX16 temperature from ${hex}`);
    eq(out[0]?.humidity, hum, `TX16 humidity from ${hex}`);
    eq(crc8ref(hexToBytes(hex), 9, 0x31, 0x7b), 0, `TX16 CRC over ${hex} is zero, computed independently`);
  }

  /*
   * The overlap, asserted rather than hidden. These two checks are different functions — random messages
   * demand different check bytes — but both are affine over the message, so where they agree they agree
   * across a whole coset. Every one of upstream's four TX16 examples falls in it, which means the TX19
   * decoder claims them too. Registering both without a priority is what upstream does, and this records
   * the consequence so a doubled reading is recognized rather than investigated.
   */
  for (const [hex] of PACKETS) {
    const b = hexToBytes(hex);
    eq(lfsr8revRef(b, 8, 0x98, 0x25), b[8], `TX19's digest also accepts TX16 packet ${hex} (known overlap)`);
    const row = wire(hex);
    eq(run(dev(291), rows(row, row, row)).length, 1, `so the TX19 decoder also reports ${hex}`);
  }

  /*
   * The file's illustrative layout row is not a valid frame: its fields read exactly as documented — channel 1,
   * 17.0 C, 43% — but its check byte fails the CRC the same file describes. The port is right; the row is not.
   */
  {
    const row = hexToBytes('870029e02baa55aae8');
    eq((((row[2] << 4) | (row[3] >> 4)) - 500) / 10, 17, 'the documented row does read 17.0 C as stated');
    eq(row[4], 43, 'and 43% humidity as stated');
    eq(((row[1] & 0x30) >> 4) + 1, 1, 'and channel 1 as stated');
    ok(crc8ref(row, 9, 0x31, 0x7b) !== 0, 'but its check byte fails its own CRC (upstream documentation error)');
    const w = [...inv(bytesToBits(row)), 1];
    eq(run(d, rows(w, w, w)).length, 0, 'so the decoder correctly refuses it');
  }

  // Battery and channel, built from the transmit side.
  for (const [chWire, chOut] of [[0, 1], [1, 2], [2, 3]]) {
    const b = Uint8Array.from([0x87, (chWire << 4), 0x2a, 0xc0, 0x39, 0xaa, 0x55, 0xaa, 0]);
    b[8] = crc8ref(b, 8, 0x31, 0x7b);
    const w = [...inv(bytesToBits(b)), 1];
    eq(run(d, rows(w, w, w))[0]?.channel, chOut, `TX16 wire channel ${chWire} reports as ${chOut}`);
  }
  {
    const b = Uint8Array.from([0x87, 0x80, 0x2a, 0xc0, 0x39, 0xaa, 0x55, 0xaa, 0]);
    b[8] = crc8ref(b, 8, 0x31, 0x7b);
    const w = [...inv(bytesToBits(b)), 1];
    eq(run(d, rows(w, w, w))[0]?.battery_ok, 0, 'TX16 reports a low battery');
  }
  {
    const b = Uint8Array.from([0x87, 0x00, 0x2a, 0xc0, 0x39, 0xaa, 0x55, 0xab, 0]);
    b[8] = crc8ref(b, 8, 0x31, 0x7b);
    const w = [...inv(bytesToBits(b)), 1];
    eq(crc8ref(b, 9, 0x31, 0x7b), 0, 'the wrong-fixed-byte frame has a valid CRC (premise)');
    eq(run(d, rows(w, w, w)).length, 0, 'TX16 still rejects it on the fixed bytes');
  }
}

// ---- The registrations themselves ----
{
  for (const num of [127, 152, 184, 230, 261, 291]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
