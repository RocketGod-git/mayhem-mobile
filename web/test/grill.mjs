/**
 * Barbecue and food thermometers.
 *
 * Every frame here is built from the transmit side — lay out the bytes the sensor sends, work out its own
 * checks the way it does — except where rtl_433's own sources carry a recorded capture, which four of these
 * nine do. Those recordings are the only evidence in this batch that owes nothing to the port, so they are used
 * in preference to anything synthesized and their stated values are asserted directly.
 *
 * Three of these devices have a rule that only fires on a particular kind of frame — an unplugged probe, a
 * dropped leading bit, an over-range sentinel — and for each of those the test asserts the *premise* as well as
 * the outcome, so that a rule which stopped being reachable would fail here rather than pass vacuously.
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
const bitOf = (bytes, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1;
const bytesToBits = (bytes, count) => {
  const n = count ?? bytes.length * 8;
  const out = [];
  for (let i = 0; i < n; i++) out.push(bitOf(bytes, i));
  return out;
};
/** One row of raw bits. */
const rowBits = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
/** The same bits, `n` times over, as these transmitters repeat themselves. */
const repeatRows = (bits, n) => {
  const bb = new BitBuffer();
  for (let r = 0; r < n; r++) { for (const v of bits) bb.addBit(v); if (r < n - 1) bb.addRow(); }
  return bb;
};
const hexBytes = (s) => s.trim().split(/\s+/).map(v => parseInt(v, 16));

console.log('Barbecue and food thermometers');

// ---- Maverick ET-732/733 (71): Manchester inside Manchester, and no integrity check at all ----
{
  const id = 0x1234, flags = 2, t1 = 532 + 25, t2 = 532 + 110;
  // The digest covers the 24 bits behind the preamble: the flags and both temperatures.
  const chk = Uint8Array.of((flags << 4) | (t1 >> 6), ((t1 & 0x3f) << 2) | (t2 >> 8), t2 & 0xff);
  const digest = U.lfsrDigest16(chk, 3, 0x8810, 0xdd38) ^ id;

  const payload = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) payload.push((v >> i) & 1); };
  push(0xfa8, 12); push(flags, 4); push(t1, 10); push(t2, 10); push(digest, 16);
  eq(payload.length, 52, 'ET-73x payload is 52 bits');

  // On the air each of those goes out as its own inverse followed by itself.
  const line = [];
  for (const v of payload) line.push(v ^ 1, v);
  eq(line.length, 104, '  which is 104 half-bits on the air');

  // The preamble the decoder matches is the still-coded form of 0xfa8, so it falls out of the encoding.
  const enc = rowBits(line);
  eq(enc.bb[0][0], 0x55, '  coded preamble byte one');
  eq(enc.bb[0][1], 0x66, '  coded preamble byte two');
  eq(enc.bb[0][2], 0x6a, '  coded preamble byte three');

  const d = run(dev(71), rowBits(line))[0];
  ok(!!d, 'Maverick ET-73x decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, id, '  the session id is the digest xored back out again');
    eq(d.status, 'default', '  flag value two is the running state');
    eq(d.temperature_1_C, 25, '  food probe, offset by 532');
    eq(d.temperature_2_C, 110, '  pit probe');
    ok(d.mic === undefined, '  and no integrity claim is made, because the device offers none');
  }

  // A pair that does not change level is a coding violation. Assert it really does cut the inner decode
  // short, not just that the frame is refused - otherwise this proves nothing about why.
  const broken = [...line];
  broken[40] = broken[41];
  const mc = new BitBuffer();
  rowBits(broken).manchesterDecode(0, 0, mc, 104);
  ok(mc.bitsPerRow[0] < 52, '  a level that repeats really does stop the inner decode short',
    `${mc.bitsPerRow[0]} bits of 52`);
  ok(!run(dev(71), rowBits(broken))[0], '  and such a frame is refused');
}

// ---- Maverick ET73 (114): the frame recorded in rtl_433's own source ----
{
  const rec = hexBytes('68 00 01 0b 90 fc');
  const d = run(dev(114), repeatRows(bytesToBits(rec, 48), 4))[0];
  ok(!!d, 'Maverick ET73 decodes the capture recorded in rtl_433', JSON.stringify(d));
  if (d) {
    eq(d.id, 104, '  random id');
    eq(d.temperature_1_C, 0, '  probe one reads zero, which is how it says nothing is plugged in');
    eq(d.temperature_2_C, 26.7, '  probe two, room temperature');
  }

  // Built transmit side, with a negative reading so the twelve-bit sign extension is actually exercised.
  const f1 = -50 & 0xfff, f2 = 200 & 0xfff;
  ok(f1 >= 0x800, '  a negative reading really does set the twelve-bit sign bit', `0x${f1.toString(16)}`);
  const b = [0x5a, (f1 >> 4) & 0xff, ((f1 & 0x0f) << 4) | ((f2 >> 8) & 0x0f), f2 & 0xff, 0x00, 0x00];
  const d2 = run(dev(114), repeatRows(bytesToBits(b, 48), 4))[0];
  ok(!!d2, 'Maverick ET73 decodes a frame built transmit side', JSON.stringify(d2));
  if (d2) {
    eq(d2.id, 0x5a, '  id');
    eq(d2.temperature_1_C, -5, '  a negative temperature comes back negative');
    eq(d2.temperature_2_C, 20, '  and the positive one packed beside it is unaffected');
  }
  // Repetition is this device's only integrity check, so it has to be a real one.
  ok(!run(dev(114), repeatRows(bytesToBits(b, 48), 2))[0], '  two matching rows are not enough');
}

// ---- Globaltronics GT-TMBBQ-05 (137): Fahrenheit on the wire, and a parity bit upstream mis-describes ----
{
  // The rows recorded in rtl_433's doc comment, each with the temperature it was labeled with.
  const rec = [
    ['001001001010101010111100110010000', 507],
    ['001001001010011010111100110010111', 499],
    ['001001001110101110111100101010110', 381],
    ['001001001001011010111100101010001', 211],
    ['011100110101010111011001100011000', 81],
  ];
  for (const [s, wantF] of rec) {
    eq(s.length, 33, 'a recorded GT-TMBBQ05 row is 33 bits');
    const d = run(dev(137), repeatRows([...s].map(c => +c), 6))[0];
    ok(!!d, `GT-TMBBQ05 decodes the recorded ${wantF} F row`, JSON.stringify(d));
    if (d) eq(d.temperature_F, wantF, `  and reports ${wantF} F, in the unit the sensor sent`);
  }

  // Upstream calls this "an odd parity bit" and its failure message says the check "should be ODD", but the
  // code demands parity_bytes(...) == 0, which is EVEN parity. Every recorded frame agrees with the code.
  eq(U.parityBytes(Uint8Array.of(0x49, 0x55, 0x79, 0x90 & 0xf0), 4), 0,
    'the recorded frames carry EVEN parity, not the odd parity the comment claims');

  // Built transmit side: the parity bit sits inside the nibble the checksum covers, so the encoder picks a
  // parity bit and then computes the checksum around it, which is what the sensor itself has to do.
  const build = (idHi, idLo, tempF) => {
    const raw = tempF + 90;
    for (const p of [0, 1]) {
      const b = [idHi, raw & 0xff, idLo, 0];
      const hiNib = (((raw >> 8) & 0x03) << 2) | (0 << 1) | p;
      let sum = 0;
      for (let i = 0; i < 3; i++) sum += (b[i] >> 4) + (b[i] & 0x0f);
      sum += hiNib;
      b[3] = (hiNib << 4) | (sum & 0x0f);
      if (U.parityBytes(Uint8Array.of(b[0], b[1], b[2], b[3] & 0xf0), 4) === 0) return b;
    }
    return null;
  };
  const frame = build(0x49, 0x79, 412);
  ok(!!frame, 'a self-consistent GT-TMBBQ05 frame exists');
  if (frame) {
    const bits = [0, ...bytesToBits(frame, 32)];       // the constant leading bit that spoils byte alignment
    const d = run(dev(137), repeatRows(bits, 6))[0];
    ok(!!d, 'GT-TMBBQ05 decodes a frame built transmit side', JSON.stringify(d));
    if (d) {
      eq(d.temperature_F, 412, '  temperature, carried as Fahrenheit plus ninety');
      eq(d.id, (0x49 << 8) | 0x79, '  id, from two bytes that are not adjacent');
    }
    ok(!run(dev(137), repeatRows(bits, 4))[0], '  four matching rows are not enough');

    // Flip the parity bit and recompute the checksum around it. The nibble sum then still holds, so only the
    // parity check can be what rejects this - which is the point of asserting both premises.
    const flipped = [...frame];
    const hiNib = (flipped[3] >> 4) ^ 0x01;
    let sum = 0;
    for (let i = 0; i < 3; i++) sum += (flipped[i] >> 4) + (flipped[i] & 0x0f);
    sum += hiNib;
    flipped[3] = (hiNib << 4) | (sum & 0x0f);
    eq(sum & 0x0f, flipped[3] & 0x0f, '  the parity-flipped frame still satisfies its nibble sum');
    ok(U.parityBytes(Uint8Array.of(flipped[0], flipped[1], flipped[2], flipped[3] & 0xf0), 4) !== 0,
      '  but no longer has even parity');
    ok(!run(dev(137), repeatRows([0, ...bytesToBits(flipped, 32)], 6))[0], '  so it is refused');
  }
}

// ---- Burnhard (177): the frame written out in rtl_433's doc comment, digest and all ----
{
  const rec = hexBytes('1f 22 00 90 52 44 14 25 e5 1e');
  eq(U.lfsrDigest8Reflect(Uint8Array.from(rec), 9, 0x31, 0xf4), 0x1e,
    'the recorded Burnhard frame closes its own digest');

  // Sent inverted; 81 bits, the last of which is a coding artifact rather than data.
  const wire = (bytes, rows) => {
    const bits = bytesToBits(bytes, 80).map(v => v ^ 1);
    bits.push(0);
    return repeatRows(bits, rows);
  };
  const d = run(dev(177), wire(rec, 3))[0];
  ok(!!d, 'Burnhard decodes the recorded frame', JSON.stringify(d));
  if (d) {
    eq(d.id, 31, '  device code');
    eq(d.channel, 2, '  probe number');
    eq(d.setpoint_C, 80, '  target temperature');
    eq(d.temperature_C, 24.1, '  probe reading');
    eq(d.meat, 'chicken', '  which cut is on the probe');
    eq(d.taste, 'well done', '  and how it is wanted');
    eq(d.timer, '90:52', '  the countdown, as packed decimal digits');
    eq(d.temperature_alarm, 0, '  no temperature alarm');
    eq(d.timer_active, 0, '  timer not running');
  }

  // A probe that is not plugged in reads exactly zero, and zero here is not -50 C.
  const un = [...rec];
  un[7] = 0x05; un[8] = 0x00;
  eq(((un[7] & 0xf0) << 4) | un[8], 0, '  the unplugged frame really does carry a zero temperature field');
  un[9] = U.lfsrDigest8Reflect(Uint8Array.from(un), 9, 0x31, 0xf4);
  const d2 = run(dev(177), wire(un, 3))[0];
  ok(!!d2, 'Burnhard decodes a frame with no probe fitted', JSON.stringify(d2));
  if (d2) {
    ok(d2.temperature_C === undefined, '  and reports no temperature rather than -50 C');
    eq(d2.setpoint_C, 80, '  though the target it was set to still comes through');
  }

  const bad = [...rec];
  bad[4] ^= 0x01;
  ok(!run(dev(177), wire(bad, 3))[0], '  Burnhard rejects a frame failing its digest');
}

// ---- Maverick XR-30 (220): the same payload as the ET-73x, moved to frequency keying ----
{
  const id = 0x2f19, flags = 0, t1 = 532 + 30, t2 = 532 + 95;
  const data = [(flags << 4) | (t1 >> 6), ((t1 & 0x3f) << 2) | (t2 >> 8), t2 & 0xff, 0, 0];
  const digest = U.lfsrDigest16(Uint8Array.from(data), 3, 0x8810, 0x0d42) ^ id;
  data[3] = (digest >> 8) & 0xff;
  data[4] = digest & 0xff;

  const full = [0xaa, 0xaa, 0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91, ...data];
  eq(full.length, 13, 'the XR-30 frame is thirteen bytes');
  const line = bytesToBits(full, 104);

  const d = run(dev(220), rowBits(line))[0];
  ok(!!d, 'Maverick XR-30 decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, id, '  session id');
    eq(d.status, 'default', '  flag value zero is the running state on this one, not two');
    eq(d.temperature_1_C, 30, '  first probe');
    eq(d.temperature_2_C, 95, '  second probe');
  }

  // The leading bit of the run-in is sometimes lost, which shifts everything by one.
  const shifted = [...line.slice(1), 0];
  const sb = rowBits(shifted);
  eq(sb.bb[0][0], 0x55, '  a frame that lost its leading bit really does begin 0x55, not 0xaa');
  eq(sb.bitsPerRow[0], 104, '  and is still 104 bits long');
  const d2 = run(dev(220), rowBits(shifted))[0];
  ok(!!d2, 'Maverick XR-30 decodes the frame that lost its leading bit', JSON.stringify(d2));
  if (d2) {
    eq(d2.id, id, '  same session id from the realigned frame');
    eq(d2.temperature_1_C, 30, '  and the same reading');
  }

  // Neither alignment: nothing to realign against, so it cannot be ours.
  const junk = [...line];
  junk[0] ^= 1; junk[2] ^= 1;
  ok(!run(dev(220), rowBits(junk))[0], '  a frame starting with neither 0xaa nor 0x55 is refused');
}

// ---- Gasmate BA1008 (236): all six rows recorded in rtl_433's doc comment ----
{
  const rec = [['f4040bfb', -4], ['f4060bf9', -6], ['f4100bef', -10],
    ['f0030ffc', 3], ['f0230fdc', 23], ['f0310fce', 31]];
  for (const [s, wantC] of rec) {
    const b = [0, 1, 2, 3].map(i => parseInt(s.slice(i * 2, i * 2 + 2), 16));
    const d = run(dev(236), rowBits(bytesToBits(b, 32)))[0];
    ok(!!d, `Gasmate BA1008 decodes the recorded ${wantC} C row`, JSON.stringify(d));
    if (d) eq(d.temperature_C, wantC, `  reporting ${wantC} C, sign and decimal digits both`);
  }

  // The check is a constant rather than a computed value: the sixteen nibbles always end in 0x0c.
  const base = [0xf0, 0x23, 0x0f, 0xdc];
  let s = 0;
  for (const v of base) s += (v >> 4) + (v & 0x0f);
  eq(s & 0x0f, 0x0c, 'a valid Gasmate frame sums its nibbles to something ending 0x0c');

  const badSum = [0xf0, 0x23, 0x0e, 0xdc];
  ok(!run(dev(236), rowBits(bytesToBits(badSum, 32)))[0], '  a frame failing that sum is refused');

  // The fixed nibble and the flag bit beside it are checked, which is most of what keeps other traffic out.
  const badModel = [0xf8, 0x23, 0x0f, 0xd4];
  ok(!run(dev(236), rowBits(bytesToBits(badModel, 32)))[0], '  and so is one with the wrong fixed nibble');
}

// ---- Maverick XR-50 (281): the sample rows recorded upstream, all of which close their own CRC ----
{
  const SAMPLES = [
    '34 08 d2 e1 6a e6 09 d2 f1 6a e6 0e c2 e4 4b a1 f4 c2 dc 4c 41 f4 04',
    '08 06 f0 00 41 a1 f4 f0 00 91 a4 10 f0 00 5a a1 f4 f0 00 a5 06 72 6a',
    '08 06 f0 00 41 a3 e8 f0 00 41 a3 e8 f0 00 41 a3 e8 f0 00 41 a3 e8 16',
  ];
  // A little run-in, then the sync word, then the payload.
  const frame = (bytes) => rowBits(bytesToBits([0xaa, 0xaa, 0xd2, 0xaa, 0x2d, 0xd4, ...bytes]));

  for (const s of SAMPLES) {
    const b = hexBytes(s);
    eq(b.length, 23, 'a recorded XR-50 sample is 23 bytes');
    eq(U.crc8(Uint8Array.from(b), 23, 0x31, 0x00), 0, '  and folds its own CRC down to zero');
    ok(!!run(dev(281), frame(b))[0], '  and decodes');
  }

  {
    const b = hexBytes(SAMPLES[0]);
    const d = run(dev(281), frame(b))[0];
    ok(!!d, 'Maverick XR-50 decodes the four-probe sample', JSON.stringify(d));
    if (d) {
      eq(d.id, '3408', '  station id');
      eq(d.probe_1_flags, 'd', '  probe one is reading below its low target');
      eq(d.temperature_1_C, 23.7, '  probe one temperature');
      eq(d.setpoint_high_1_C, 121, '  probe one high target');
      eq(d.setpoint_low_1_C, 104.5, '  probe one low target');
      eq(d.temperature_4_C, 23.2, '  and the fourth probe, read by the same loop');
    }
  }

  {
    // A socket with nothing in it reports flags 0xf and a zero temperature field; zero means "no probe"
    // here rather than freezing point, so nothing is reported for it.
    const b = hexBytes(SAMPLES[2]);
    eq(((b[2] & 0x0f) << 8) | b[3], 0, '  the empty-socket sample really does carry a zero temperature field');
    eq((b[2] & 0xf0) >> 4, 0xf, '  and flags of 0xf');
    const d = run(dev(281), frame(b))[0];
    ok(!!d, 'Maverick XR-50 decodes a frame with no probes fitted', JSON.stringify(d));
    if (d) {
      ok(d.temperature_1_C === undefined, '  reporting no temperature for the empty socket');
      eq(d.setpoint_high_1_C, 55, '  though its targets still come through');
      eq(d.setpoint_low_1_C, 50, '  both of them');
    }
  }

  const bad = hexBytes(SAMPLES[0]);
  bad[5] ^= 0x01;
  ok(!run(dev(281), frame(bad))[0], '  XR-50 rejects a frame failing its CRC');
}

// ---- RF-T0912 (331): three bytes, an eight-bit sum, and an over-range sentinel ----
{
  const mk = (v) => { const hi = (v >> 8) & 0xff, lo = v & 0xff; return [hi, lo, (hi + lo) & 0xff]; };
  // Sent inverted.
  const wire = (bytes, rows) => repeatRows(bytesToBits(bytes, 24).map(v => v ^ 1), rows);

  {
    const b = mk(350);
    eq(b[2], (b[0] + b[1]) & 0xff, 'the RF-T0912 check is just the sum of its two temperature bytes');
    const d = run(dev(331), wire(b, 4))[0];
    ok(!!d, 'RF-T0912 decodes', JSON.stringify(d));
    if (d) {
      eq(d.temperature_F, 350, '  temperature, in Fahrenheit as the probe sends it');
      eq(d.overload, 0, '  and not over range');
    }
  }

  // The same value has to arrive twice before it is believed.
  ok(!run(dev(331), wire(mk(350), 1))[0], '  a single row is refused');

  {
    // -1029 is the probe saying it is over range, not a reading.
    const b = mk(-1029 & 0xffff);
    eq(b[0], 0xfb, '  the over-range sentinel really is 0xfbfb on the wire');
    eq((((b[0] << 8) | b[1]) << 16) >> 16, -1029, '  and sign-extends to exactly -1029');
    const d = run(dev(331), wire(b, 4))[0];
    ok(!!d, 'RF-T0912 decodes the over-range frame', JSON.stringify(d));
    if (d) {
      eq(d.overload, 1, '  reported as an overload');
      ok(d.temperature_F === undefined, '  with no temperature attached to it');
    }
  }

  // A zero checksum is excluded, so empty rows can never agree with one another.
  ok(!run(dev(331), wire([0, 0, 0], 6))[0], '  rows of zeroes are not mistaken for a reading');
}

// ---- Typhur Sync Gold (377): five points down one probe, everything little-endian ----
{
  const b = new Array(24).fill(0);
  b[0] = 0x0a; b[1] = 0x1b; b[2] = 0x2c;
  b[4] = 0x08;                                          // seated in its charging base
  const put = (at, v) => { b[at] = v & 0xff; b[at + 1] = (v >> 8) & 0xff; };
  [6512, 6480, 6455, 6390, 6301].forEach((v, i) => put(6 + i * 2, v));
  put(16, 1043);                                        // ambient, tenths
  put(18, 412);                                         // battery, hundredths of a volt
  put(20, 1234);                                        // transmission counter
  const crc = U.crc16(Uint8Array.from(b), 22, 0x8005, 0x0000);
  b[22] = (crc >> 8) & 0xff;
  b[23] = crc & 0xff;

  // Little-endian is the whole point here, so make sure the two bytes of a reading actually differ - a
  // big-endian misreading of equal bytes would pass unnoticed.
  ok(b[6] !== b[7], 'a Typhur probe reading is built from two differing bytes');

  const line = bytesToBits([0xaa, 0xaa, 0xaa, 0x57, 0x54, ...b]);
  const d = run(dev(377), rowBits(line))[0];
  ok(!!d, 'Typhur Sync Gold decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, '0a1b2c', '  id, the one field read the other way round');
    eq(d.in_base, 1, '  seated in its base');
    eq(d.temperature_1_C, 65.12, '  the first point down the probe, in hundredths');
    eq(d.temperature_5_C, 63.01, '  and the fifth');
    eq(d.ambient_C, 104.3, '  ambient, in tenths - a coarser sensor than the five');
    eq(d.battery_V, 4.12, '  battery volts');
    eq(d.counter, 1234, '  transmission counter');
  }

  const bad = [...line];
  bad[24 + 16 + 40] ^= 1;
  ok(!run(dev(377), rowBits(bad))[0], '  a frame failing its CRC-16 is refused');
}

// ---- Registry invariants ----
console.log('registry invariants');
{
  const MINE = [71, 114, 137, 177, 220, 236, 281, 331, 377];
  // The modulations `slice()` actually implements. A device registered against anything else would appear in
  // the protocol list and then be fed no bits at all, silently, forever.
  const HANDLED = new Set([3, 4, 5, 6, 8, 9, 11, 12, 13, 16, 17, 18]);
  for (const n of MINE) {
    const d = dev(n);
    ok(!!d, `protocol ${n} is registered`);
    if (d) ok(HANDLED.has(d.modulation), `  and protocol ${n} uses a modulation the slicer implements`,
      `modulation ${d.modulation}`);
  }

  const seen = new Map();
  let dup = '';
  for (const d of REGISTRY) {
    if (seen.has(d.num)) dup = `${d.num}: ${seen.get(d.num)} and ${d.name}`;
    seen.set(d.num, d.name);
  }
  ok(!dup, 'no two registered devices claim the same rtl_433 protocol number', dup);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
