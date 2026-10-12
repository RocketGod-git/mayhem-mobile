/**
 * Ultrasonic oil tank monitors, four of the five checked against radio rtl_433 actually captured.
 *
 * The Advanced ships two captures of the same reading, one with its CRC shifted a bit left and one without,
 * so both halves of that recovery path are exercised by real frames rather than by anything invented here.
 * The Smart ships two captures from two different sensors. The Standard's examples are written as binary
 * rather than hex, which a hex-only search would have missed entirely — they are used directly.
 *
 * Only the original Watchman has nothing published, so its frames are built from the transmit side: the bytes
 * laid out as the sensor sends them, Manchester coded, with the checksum computed by an implementation
 * written from the CRC definition rather than imported from the code under test.
 *
 * One upstream discrepancy is asserted rather than smoothed over: the Smart's first capture does not decode
 * to the bytes printed beside it. Both rows pass the device's own checksum and carry the same sensor id, so
 * they are two different transmissions, and the port is right. That is the same pattern already seen in the
 * BMW and Audi tire pressure captures.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** Written from the definitions, not imported, so building and checking stay independent. */
const rev8 = (x) => { let r = 0; for (let i = 0; i < 8; i++) if ((x >> i) & 1) r |= 0x80 >> i; return r; };
/** rtl_433's crc8le returns the remainder with no final reflection — matching that exactly matters here. */
const crc8leRef = (m, n, poly, init) => {
  let rem = rev8(init);
  const p = rev8(poly);
  for (let i = 0; i < n; i++) {
    rem ^= m[i];
    for (let b = 0; b < 8; b++) rem = (rem & 1) ? ((rem >> 1) ^ p) & 0xff : (rem >> 1);
  }
  return rem & 0xff;
};
const crc16Ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[i] << 8;
    for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff;
  }
  return r;
};

const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/[^0-9a-fA-F]/g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const bitsFromBinary = (s) => [...s.replace(/[^01]/g, '')].map(Number);
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/ /g, '').match(/../g).map(x => parseInt(x, 16)));
/** Our Manchester decoder emits the second half of each pair, so a one is sent as (0,1). */
const manchester = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };

console.log('Oil tank monitors: Watchman, Standard, Advanced and Smart');

// ---- Watchman Sonic (43): nothing is published, so frames are built from the transmit side ----
{
  const d = dev(43);
  const build = ({ id = 0x12345678, flags = 0x00, maybetemp = 20, depth = 137, countdown = 0x51, breakCrc = false, badTail = false } = {}) => {
    const b = new Uint8Array(8);
    b[0] = (id >>> 24) & 0xff; b[1] = (id >>> 16) & 0xff; b[2] = (id >>> 8) & 0xff; b[3] = id & 0xff;
    b[4] = flags;
    const low = (flags & 1) ? countdown : (depth & 0xff);
    b[5] = ((maybetemp & 0x3f) << 2) | ((flags & 1) ? 0 : ((depth >> 8) & 3));
    b[6] = low;
    b[7] = crc8leRef(b, 7, 0x31, 0) ^ (breakCrc ? 0xff : 0x00);
    const last = b[7] & 1;
    const tail = badTail ? [last ^ 1, last ^ 1] : [last, last];
    return rowOf([1, 1, 1, 0, 0, 0, ...manchester(bytesToBits(b)), ...tail]);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Watchman decodes a well-formed frame');
  eq(out[0]?.id, 0x12345678, 'Watchman 32-bit unit id');
  eq(out[0]?.depth_cm, 137, 'Watchman depth');
  eq(out[0]?.maybetemp, 20, 'Watchman raw temperature field is reported as read');
  eq(out[0]?.temperature_C, (145 - 5 * 20) / 3, 'Watchman inferred temperature');
  eq(out[0]?.binding_countdown, 0, 'no binding countdown outside rebind');

  // A depth needing its two high bits, to prove they are actually read.
  eq(run(d, build({ depth: 900 }))[0]?.depth_cm, 900, 'Watchman depth uses the two high bits in b[5]');
  eq(run(d, build({ depth: 0 }))[0]?.depth_cm, 0, 'Watchman reports zero depth: no echo returned');

  // Rebinding swaps the meaning of the same byte.
  const bind = run(d, build({ flags: 0x01, countdown: 0x55 }));
  eq(bind[0]?.binding_countdown, 0x55, 'Watchman reports the binding countdown while rebinding');
  eq(bind[0]?.depth_cm, 0, 'and reports no depth while rebinding');
  eq(bind[0]?.flags, 0x01, 'Watchman flags');

  // Each rejection, with the premise that the frame is otherwise sound.
  {
    const good = build({});
    eq(run(d, good).length, 1, 'the frame used for the tail test decodes when its tail is right (premise)');
    eq(run(d, build({ badTail: true })).length, 0, 'Watchman rejects a frame whose postamble does not match its last bit');
  }
  eq(run(d, build({ breakCrc: true })).length, 0, 'Watchman rejects a bad checksum');
  eq(run(d, rowOf([1, 1, 1, 0, 0, 0])).length, 0, 'Watchman ignores a run-in with no frame behind it');
}

// ---- Oil Ultrasonic STANDARD (81 FSK, 83 ASK): the two documented example packets ----
{
  // Written as binary in the source, not hex. Both sync words appear, one per example.
  const EX1 = '010101 01010101 01010111 01101001 10011010 10101001 10100101 10011010 01101010 10011001 10011010 0000';
  const EX2 = '010101 01010101 01011000 10011010 01010110 01101010 10101010 10100101 01101010 10100110 10101001 1111';

  for (const num of [81, 83]) {
    const d = dev(num);
    const a = run(d, rowOf(bitsFromBinary(EX1)));
    eq(a.length, 1, `Standard ${num} decodes its first documented example`);
    eq(a[0]?.id, 0x9413, `Standard ${num} id from example 1`);
    eq(a[0]?.depth_cm, 84, `Standard ${num} depth from example 1`);
    eq(a[0]?.alarm, 1, `Standard ${num} alarm flag from example 1`);
    eq(a[0]?.flags, 0x40, `Standard ${num} flags from example 1`);

    const b = run(d, rowOf(bitsFromBinary(EX2)));
    eq(b.length, 1, `Standard ${num} decodes its second documented example`);
    eq(b[0]?.id, 0x4e80, `Standard ${num} id from example 2`);
    eq(b[0]?.depth_cm, 33, `Standard ${num} depth from example 2`);
  }

  const d = dev(81);
  eq(d.modulation, 16, 'Standard FSK is registered as FSK PCM');
  eq(dev(83).modulation, 4, 'Standard ASK is registered as OOK PCM');
  ok(dev(83).bands?.[0] === 915000000, 'the ASK build is a 915 MHz device');

  /*
   * The guard that stops this checksumless decoder claiming its sibling's traffic. The premise matters as much
   * as the outcome: a Standard sync word really is present inside the Smart run-in, so the rejection below is
   * the guard doing work rather than the frame simply not matching.
   */
  {
    const smart = bitsFromHex('555558 9999 996a 6559aaa99996a55696a9a5963c', 158);
    const bb = rowOf(smart);
    const found = bb.search(0, 0, new Uint8Array([0x55, 0x62]), 16);
    eq(found, 10, 'a Standard sync word really does occur inside the Smart run-in (premise)');
    eq(run(d, rowOf(smart)).length, 0, 'and the Standard decoder refuses the Smart capture anyway');
    // The Smart decoder, meanwhile, reads it happily.
    eq(run(dev(235), rowOf(smart)).length, 1, 'while the Smart decoder reads that same capture');
  }

  /*
   * The depth range check, built from the transmit side. The 0x555D sync only completes if the first payload
   * bit is a one, because the last two bits of that sync word are themselves the first Manchester pair -- so
   * the frame is laid out as fourteen bits of preamble, the coded payload, then a coding violation to end it.
   */
  {
    const stdRow = (b0, b1, b2, b3) => {
      const payload = bytesToBits(Uint8Array.from([b0, b1, b2, b3]));
      return rowOf([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, ...manchester(payload), 0, 0, 0, 0]);
    };
    // 300 cm needs the high bit in b[2], so this exercises the same path the over-range frame uses.
    const inRange = run(d, stdRow(0x94, 0x13, 0x4a, 0x2c));
    eq(inRange.length, 1, 'a 300 cm frame decodes (premise for the range check)');
    eq(inRange[0]?.depth_cm, 300, 'and reads 300 cm, using the high bit in b[2]');

    const tooDeep = stdRow(0x94, 0x13, 0x4a, 0x90);
    eq(((0x4a & 0x02) << 7) | 0x90, 400, 'the over-range frame really does encode 400 cm (premise)');
    eq(run(d, tooDeep).length, 0, 'Standard rejects a depth beyond the sensor\'s reach');
  }
}

// ---- Watchman Sonic Advanced (234): two real captures, one per CRC path ----
{
  const d = dev(234);
  const SHIFTED = 'aaaaaaaaaa 2dd4 0e 040153b5cb906389806701070300 3b308';
  const PLAIN   = 'aaaaaaaaaa 2dd4 0e 040153b5cb906389806701070300 7661';

  for (const [tag, cap] of [['shifted', SHIFTED], ['unshifted', PLAIN]]) {
    const out = run(d, rowOf(bitsFromHex(cap, 194)));
    eq(out.length, 1, `Advanced decodes its ${tag} capture`);
    eq(out[0]?.id, 5486027, `Advanced serial from the ${tag} capture`);
    eq(out[0]?.depth_cm, 103, `Advanced depth from the ${tag} capture`);
    eq(out[0]?.temperature_C, 13, `Advanced temperature from the ${tag} capture`);
    eq(out[0]?.version, '1.7.3.0', `Advanced version from the ${tag} capture`);
    eq(out[0]?.status, 0x90, `Advanced status from the ${tag} capture`);
  }

  /*
   * The premise behind having two CRC paths at all: these captures are the same reading, and the first really
   * does carry its CRC shifted one bit left. Computed here rather than taken on trust.
   */
  {
    const body = hexToBytes('0e040153b5cb906389806701070300');
    const calc = crc16Ref(body, 15, 0x8005, 0);
    eq(calc, 0x7661, 'the CRC-16 over the body computes independently to 0x7661');
    eq((0x3b30 << 1) | 1, 0x7661, 'and the shifted capture carries that same value one bit left');
    ok(0x3b30 !== calc, 'so the shifted capture fails the straightforward check first (premise)');
  }

  // A frame whose CRC is wrong both ways.
  eq(run(d, rowOf(bitsFromHex('aaaaaaaaaa 2dd4 0e 040153b5cb906389806701070300 1234', 194))).length, 0,
    'Advanced rejects a CRC that fails both shifted and unshifted');

  // An unknown model code, with a CRC that genuinely passes so the sanity rule is what rejects it.
  {
    const body = hexToBytes('0e099953b5cb906389806701070300');
    const crc = crc16Ref(body, 15, 0x8005, 0);
    const hex = 'aaaaaaaaaa2dd4' + '0e' + '099953b5cb906389806701070300' + crc.toString(16).padStart(4, '0') + '0';
    const bits = bitsFromHex(hex, 194);
    const bb = rowOf(bits);
    // Rebuild what the decoder will see, to confirm the CRC really is good before asserting the rejection.
    const msg = bb.bytes(0, bb.search(0, 0, new Uint8Array([0xaa, 0xaa, 0xaa, 0x2d, 0xd4, 0x0e]), 48) + 40, 137);
    eq(crc16Ref(msg, 15, 0x8005, 0), (msg[15] << 8) | msg[16], 'the unknown-model frame has a valid CRC (premise)');
    eq(run(d, rowOf(bits)).length, 0, 'Advanced rejects an unrecognized model code');
  }
}

// ---- Oil Ultrasonic SMART (235): two real captures from two sensors ----
{
  const d = dev(235);
  const ORIGINAL = '555558 9999 996a 6559aaa99996a55696a9a5963c';
  const HAVOC    = '555558 a955 5569 5a9aaa56a996966aa69596a63c';

  const a = run(d, rowOf(bitsFromHex(ORIGINAL, 158)));
  eq(a.length, 1, 'Smart decodes the original capture');
  eq(a[0]?.id, 0x5558bd01, 'Smart 32-bit id from the original capture');
  eq(a[0]?.depth_cm, 97, 'Smart depth from the original capture');
  eq(a[0]?.txstatus, 'Rapid', 'Smart transmit status from the original capture');
  eq(a[0]?.battery_ok, 1, 'Smart battery from the original capture');

  const h = run(d, rowOf(bitsFromHex(HAVOC, 158)));
  eq(h.length, 1, 'Smart decodes the second sensor\'s capture');
  eq(h[0]?.id, 0x1ff9c40e, 'Smart id matches the bytes documented for that capture');
  eq(h[0]?.depth_cm, 39, 'Smart depth from the second capture');
  eq(h[0]?.txstatus, 'Normal', 'Smart transmit status from the second capture');

  /*
   * The discrepancy, pinned. The second capture decodes to exactly the bytes printed beside it; the first does
   * not. Both rows pass the device's own checksum and carry the same id and status byte, so both are real
   * frames from that sensor at different moments -- the comment pairs a capture with a row from another
   * transmission, as `tpms_bmw.c` does. Neither the decode nor this file needs changing for that.
   */
  {
    const decoded = hexToBytes('5558bd01563e6136');   // what the capture actually carries
    const printed = hexToBytes('5558bd0156420497');   // what the comment prints beside it
    eq(crc8leRef(decoded, 8, 0x31, 0), 0, 'the bytes the first capture decodes to pass the checksum');
    eq(crc8leRef(printed, 8, 0x31, 0), 0, 'and so do the bytes printed beside it -- both are real frames');
    ok(decoded[5] !== printed[5] || decoded[6] !== printed[6], 'they differ only past the status byte (premise)');
    eq(decoded[0], printed[0], 'same sensor id, byte 0');
    eq(decoded[3], printed[3], 'same sensor id, byte 3');
    eq(decoded[4], printed[4], 'same status byte');
    eq(((printed[5] & 0x01) << 8) + printed[6], 4, 'the printed row is a 4 cm reading');
    eq(((decoded[5] & 0x01) << 8) + decoded[6], 97, 'the captured row is a 97 cm reading');
  }

  // A corrupted frame, corrupting a bit the decoder actually reads.
  {
    const good = bitsFromHex(ORIGINAL, 158);
    const bad = [...good];
    bad[40] ^= 1;                                    // inside the Manchester payload, not past the row
    ok(good.join('') !== bad.join(''), 'the corrupted capture really does differ within its bits (premise)');
    eq(run(d, rowOf(bad)).length, 0, 'Smart rejects a corrupted frame');
  }
}

// ---- The registrations themselves ----
{
  for (const num of [43, 81, 83, 234, 235]) {
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
