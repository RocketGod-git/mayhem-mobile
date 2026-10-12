/**
 * Lighting, fans and switches, plus the two Philips clock-radio thermometers.
 *
 * Only the AJ7010 publishes frames, and it publishes them decoded rather than raw: five binary rows labelled
 * with the temperature and channel each was recorded at. Those go in directly. They also settle something —
 * the conversion that file applies does not reproduce its own labels, which upstream already suspects, so the
 * computed values are asserted alongside the labelled ones rather than either being quietly preferred.
 *
 * The other five publish nothing at all, so every frame is built from the transmit side. Where a device has a
 * checksum the builder computes it from the definition rather than importing the code under test; where a
 * device has none — LightwaveRF has no integrity check whatsoever — the tests lean on its structure instead,
 * since that is genuinely all the decoder has to work with.
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
const crc4Ref = (m, n, poly, init) => {
  let r = (init << 4) & 0xff;
  const p = (poly << 4) & 0xff;
  for (let i = 0; i < n; i++) {
    r ^= m[i];
    for (let b = 0; b < 8; b++) r = (r & 0x80) ? (((r << 1) ^ p) & 0xff) : ((r << 1) & 0xff);
  }
  return (r >> 4) & 0x0f;
};
const crc16Ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[i] << 8; for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff; }
  return r & 0xffff;
};
const reflect4Ref = (x) => ((x & 1) << 3) | ((x & 2) << 1) | ((x & 4) >> 1) | ((x & 8) >> 3);

const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const bitsToBytes = (bits) => { const o = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { if (b) o[i >> 3] |= 0x80 >> (i & 7); }); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const rowsOf = (...arrs) => { const bb = new BitBuffer(); arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); }); return bb; };

console.log('LightwaveRF, Philips AJ3650/AJ7010, GE Color Effects, Quinetic and Martec');

// ---- LightwaveRF (61): expand, strip, then look up ----
{
  const d = dev(61);
  const TABLE = [0xf6, 0xee, 0xed, 0xeb, 0xde, 0xdd, 0xdb, 0xbe,
                 0xbd, 0xbb, 0xb7, 0x7e, 0x7d, 0x7b, 0x77, 0x6f];

  /** Ten nibbles out to a 71-bit row: table lookup, delimiters, then undo the zero-expansion. */
  const build = (nibbles, { badByte = -1, dropDelimiter = -1, bits = null } = {}) => {
    const stuffed = [1];
    nibbles.forEach((n, i) => {
      stuffed.push(i === dropDelimiter ? 0 : 1);
      const byte = i === badByte ? 0xf5 : TABLE[n];   // 0xf5 has two zero bits but is not in the table
      for (let k = 7; k >= 0; k--) stuffed.push((byte >> k) & 1);
    });
    // Each "10" came from a zero, every other "1" from a one.
    const un = [];
    for (let i = 0; i < stuffed.length;) {
      if (stuffed[i] === 1 && stuffed[i + 1] === 0) { un.push(0); i += 2; }
      else { un.push(stuffed[i]); i += 1; }
    }
    return rowOf(inv(bits === null ? un : un.slice(0, bits)));
  };

  const NIBS = [0x3, 0x1, 0xa, 0xb, 0xc, 0x2, 0x5, 0x7, 0x9, 0xf];
  const out = run(d, build(NIBS));
  eq(out.length, 1, 'LightwaveRF decodes a well-formed frame');
  eq(out[0]?.parameter, 0x31, 'LightwaveRF parameter is the first two nibbles');
  eq(out[0]?.subunit, 0xa, 'LightwaveRF subunit');
  eq(out[0]?.command, 0xb, 'LightwaveRF command');
  eq(out[0]?.id, 0xc2579f, 'LightwaveRF id is the last six nibbles');

  // The expansion has to land on exactly 91 bits, which is what makes the length fixed.
  {
    const stuffedLen = 1 + 10 * 9;
    eq(stuffedLen, 91, 'a whole message is 91 bits once expanded (premise)');
    const zeros = TABLE.map(v => { let n = 0; for (let i = 0; i < 8; i++) if (!((v >> i) & 1)) n++; return n; });
    ok(zeros.every(z => z === 2), 'every legal byte has exactly two zero bits (premise)');
  }

  // Rejections. There is no checksum, so the table and the delimiters are the whole defence.
  {
    const badTable = build(NIBS, { badByte: 4 });
    eq(badTable.bitsPerRow[0], 71, 'the bad-byte frame is still the right length (premise)');
    eq(run(d, badTable).length, 0, 'LightwaveRF rejects a byte outside its nibble table');
  }
  eq(run(d, build(NIBS, { dropDelimiter: 3 })).length, 0, 'LightwaveRF rejects a missing delimiter bit');
  eq(run(d, build(NIBS, { bits: 70 })).length, 0, 'LightwaveRF wants exactly 71 bits');
  eq(run(d, rowsOf(inv(new Array(71).fill(1)), inv(new Array(71).fill(1)))).length, 0,
    'LightwaveRF wants a single row');

  eq(d.disabled, true, 'LightwaveRF mirrors upstream\'s disabled flag: it has no integrity check at all');
}

// ---- Philips AJ3650 (94): three copies and a majority vote ----
{
  const d = dev(94);
  /** Lays the same packet down three times, the middle one four bits out of step, then inverts. */
  const build = (pkt, { corrupt = [] } = {}) => {
    const copies = [Uint8Array.from(pkt), Uint8Array.from(pkt), Uint8Array.from(pkt)];
    for (const [which, index, mask] of corrupt) copies[which][index] ^= mask;
    const bb = new Uint8Array(14);
    bb[0] = 0x00;
    bb.set(copies[0], 1);
    const m = copies[1];
    bb[5] = m[0] >> 4;
    bb[6] = ((m[0] & 0x0f) << 4) | (m[1] >> 4);
    bb[7] = ((m[1] & 0x0f) << 4) | (m[2] >> 4);
    bb[8] = ((m[2] & 0x0f) << 4) | (m[3] >> 4);
    bb[9] = (m[3] & 0x0f) << 4;
    bb.set(copies[2], 10);
    return rowOf(inv(bytesToBits(bb)));
  };
  /** Finds the check nibble that makes the CRC come out zero. */
  const seal = (b0, b1, b2, b3) => {
    const p = Uint8Array.from([b0, b1, b2, b3]);
    for (let s = 0; s < 16; s++) { p[3] = (b3 & 0xf0) | s; if (crc4Ref(p, 4, 0x9, 1) === 0) return p; }
    throw new Error('no valid check nibble');
  };

  const pkt = seal(0x12, 0x8a, 0x40, 0x40);
  eq(crc4Ref(pkt, 4, 0x9, 1), 0, 'the built packet satisfies its own CRC (premise)');

  const out = run(d, build(pkt));
  eq(out.length, 1, 'AJ3650 decodes a well-formed burst');
  eq(out[0]?.channel, 1, 'AJ3650 maps wire channel 2 to channel 1');
  eq(out[0]?.temperature_C, 5.3, 'AJ3650 temperature');
  eq(out[0]?.battery_ok, 0, 'AJ3650 reports a flat battery');

  // The channel map is not the identity, and two wire values mean "unknown".
  for (const [wire, want] of [[0, 2], [2, 1], [4, 3], [1, 0], [3, 0]]) {
    const p = seal(0x10 | wire, 0x8a, 0x40, 0x00);
    eq(run(d, build(p))[0]?.channel, want, `AJ3650 wire channel ${wire} reports as ${want}`);
  }

  /*
   * The majority vote, which is the whole point of sending three copies. One damaged copy must not cost the
   * reading -- and the premise matters: the damage has to be real, and the same damage in two copies has to
   * actually break the frame, or the test would prove nothing.
   */
  {
    const oneBad = run(d, build(pkt, { corrupt: [[1, 1, 0xff]] }));
    eq(oneBad.length, 1, 'AJ3650 still decodes with one copy corrupted');
    eq(oneBad[0]?.temperature_C, 5.3, 'and the voted reading is unchanged');

    const twoBad = run(d, build(pkt, { corrupt: [[0, 1, 0xff], [1, 1, 0xff]] }));
    eq(twoBad.length, 0, 'but two copies corrupted the same way outvote the third and fail the CRC');
  }

  eq(run(d, rowOf(inv(bytesToBits(new Uint8Array(14))))).length, 0, 'AJ3650 rejects an empty burst');
  eq(run(d, rowOf(inv(bytesToBits(new Uint8Array(13))))).length, 0, 'AJ3650 wants exactly 112 bits');
}

// ---- GE Color Effects (98): a zero is two bits, a one is four ----
{
  const d = dev(98);
  const build = ({ id = 0x21, command = 0xaa, preamble = [0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xff, 0x00],
                   lastBit = 0, leadTwo = 0, shortBy = 0 } = {}) => {
    const frame = [(leadTwo >> 1) & 1, leadTwo & 1];
    for (let i = 5; i >= 0; i--) frame.push((id >> i) & 1);   // six-bit address
    for (let i = 7; i >= 0; i--) frame.push((command >> i) & 1);
    frame.push(lastBit);
    const encoded = [];
    for (const b of frame) { if (b) encoded.push(1, 1, 0, 0); else encoded.push(1, 0); }
    const pre = bytesToBits(Uint8Array.from(preamble));
    return rowOf([...pre.slice(0, pre.length - shortBy), ...encoded, 0, 0, 0, 0]);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'GE Color Effects decodes a well-formed frame');
  eq(out[0]?.id, 0x21, 'GE address');
  eq(out[0]?.command, 'on', 'GE names the on command');
  eq(run(d, build({ command: 0x55 }))[0]?.command, 'off', 'GE names the off command');
  eq(run(d, build({ command: 0x5a }))[0]?.command, 'change', 'GE names the change command');
  // A code with no known meaning is reported as itself rather than under an invented name.
  eq(run(d, build({ command: 0x3c }))[0]?.command, '0x3c', 'GE reports an unknown command as its raw code');

  /*
   * A sliced-short sync pulse means the demodulator hands over one or two fewer run-in bits — not that the
   * same full run-in gets matched by a shorter pattern. The frame has to begin exactly where the match ends,
   * so each case is built by trimming the run-in itself. Between them these cover all four pattern lengths
   * the decoder carries; keeping the run-in intact and merely shortening the search would leave the frame
   * starting a bit late and prove nothing.
   */
  const FE = [0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xfe, 0x00];
  eq(run(d, build({ shortBy: 1 })).length, 1, 'GE accepts a run-in one bit short');
  eq(run(d, build({ preamble: FE })).length, 0, 'a full-length run-in with a short-sliced sync does not line up');
  eq(run(d, build({ preamble: FE, shortBy: 1 })).length, 1, 'GE accepts a short-sliced sync one bit short');
  eq(run(d, build({ preamble: FE, shortBy: 2 })).length, 1, 'GE accepts a short-sliced sync two bits short');
  eq(run(d, build({ preamble: FE, shortBy: 1 }))[0]?.id, 0x21, 'and reads the same address from it');

  eq(run(d, build({ leadTwo: 0x2 })).length, 0, 'GE rejects a frame not opening with two zero bits');
  eq(run(d, build({ lastBit: 1 })).length, 0, 'GE rejects a frame not closing with a zero bit');
  eq(run(d, rowOf(new Array(200).fill(0))).length, 0, 'GE finds nothing in a burst with no run-in');
}

// ---- Philips AJ7010 (135): five published rows ----
{
  const d = dev(135);
  // Given decoded, so they go back through the inversion the decoder applies.
  const ROWS = [
    ['00 45 22 29 4e', 2, 20.6, '21.1'],
    ['00 5a 7c 29 0f', 1, 20.9, '21.4'],
    ['00 5a 05 26 79', 1, 18.4, '17'],
    ['00 45 1e 26 7d', 2, 18.4, '17'],
    ['00 36 e3 25 f0', 3, 18.3, '17'],
  ];
  const bytesOf = (h) => Uint8Array.from(h.replace(/ /g, '').match(/../g).map(x => parseInt(x, 16)));

  for (const [hex, wantCh, wantTemp, label] of ROWS) {
    const b = bytesOf(hex);
    const out = run(d, rowOf(inv(bytesToBits(b))));
    eq(out.length, 1, `AJ7010 decodes published row ${hex}`);
    eq(out[0]?.channel, wantCh, `AJ7010 channel from ${hex}, matching its own label`);
    eq(out[0]?.temperature_C, wantTemp, `AJ7010 temperature from ${hex}`);
    // The published label disagrees with what this file's own conversion produces.
    ok(Math.abs(out[0].temperature_C - parseFloat(label)) > 0.3,
      `AJ7010 row ${hex} is labelled ${label} C but its own formula gives ${wantTemp} C`);
    // Every published row passes on the first of the two alternative sums.
    let x = 0;
    for (let i = 0; i < 5; i++) x ^= b[i];
    eq(x, 0, `${hex}: the five-byte sum is the check that carries it`);
  }

  // The second sum is a genuine alternative, not dead code: a frame failing the first can still pass on it.
  {
    const b = bytesOf('00 45 22 29 4e');
    let x3 = 0;
    for (let i = 0; i < 3; i++) x3 ^= b[i];
    b[4] = x3;                                      // makes the three-byte alternative come out zero
    let x5 = 0;
    for (let i = 0; i < 5; i++) x5 ^= b[i];
    ok(x5 !== 0, 'the five-byte sum fails on this frame (premise)');
    eq(x3 ^ b[4], 0, 'while the three-byte alternative holds (premise)');
    eq(run(d, rowOf(inv(bytesToBits(b)))).length, 1, 'so AJ7010 accepts it on the alternative sum');
  }

  eq(run(d, rowOf(inv(bytesToBits(bytesOf('01 45 22 29 4e'))))).length, 0,
    'AJ7010 rejects a frame whose leading byte is not zero');
  eq(run(d, rowOf(new Array(40).fill(0))).length, 0, 'AJ7010 rejects an all-ones carrier');
  eq(run(d, rowOf(inv(bytesToBits(bytesOf('00 45 22 29 4f'))))).length, 0, 'AJ7010 rejects a frame failing both sums');
}

// ---- Quinetic (270): a kinetic switch with no battery ----
{
  const d = dev(270);
  const build = ({ id = 0x1234, action = 0x02, breakCrc = false, lead = 64 } = {}) => {
    const b = new Uint8Array(5);
    b[0] = (id >> 8) & 0xff; b[1] = id & 0xff; b[2] = action;
    const c = crc16Ref(b, 3, 0x1021, 0x1d0f) ^ (breakCrc ? 0xffff : 0);
    b[3] = (c >> 8) & 0xff; b[4] = c & 0xff;
    return rowOf([...new Array(lead).fill(0), ...bytesToBits(Uint8Array.from([0xa4, 0x23])), ...bytesToBits(b)]);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Quinetic decodes a button press');
  eq(out[0]?.id, '1234', 'Quinetic switch id');
  eq(out[0]?.channel, 2, 'Quinetic reports which button was pressed');
  eq(out[0]?.mic, 'CRC', 'Quinetic reports a CRC');

  for (const n of [1, 2, 3]) eq(run(d, build({ action: n }))[0]?.channel, n, `Quinetic button ${n}`);

  // A release says only that something was let go, so it is dropped rather than reported as button 192.
  {
    const release = build({ action: 192 });
    const b = new Uint8Array(5);
    b[0] = 0x12; b[1] = 0x34; b[2] = 192;
    const c = crc16Ref(b, 3, 0x1021, 0x1d0f);
    b[3] = (c >> 8) & 0xff; b[4] = c & 0xff;
    eq(crc16Ref(b, 5, 0x1021, 0x1d0f), 0, 'the release frame is perfectly valid (premise)');
    eq(run(d, release).length, 0, 'but Quinetic drops it, having no button number to report');
  }

  eq(run(d, build({ breakCrc: true })).length, 0, 'Quinetic rejects a bad CRC');
  eq(run(d, build({ lead: 8 })).length, 0, 'Quinetic refuses a burst too short to hold a frame');
  eq(d.disabled, true, 'Quinetic mirrors upstream\'s disabled flag: it needs a differently tuned receiver');
}

// ---- Martec MPLCD (335): 22 bits, read from the second ----
{
  const d = dev(335);
  const build = ({ channel = 5, wireDimmer = 10, speed = 1, breakChk = false, allZero = false, bits = 22 } = {}) => {
    const bytes = new Uint8Array(3);
    if (allZero) {
      bytes[0] = 0; bytes[1] = 0;
    }
    else {
      // The channel is stored reflected and inverted, so it is put back the same way round.
      const nib = (~reflect4Ref(channel)) & 0x0f;
      bytes[0] = ((nib << 1) | ((wireDimmer >> 6) & 1)) & 0xff;
      bytes[1] = (((wireDimmer & 0x3f) << 2) | (speed & 3)) & 0xff;
    }
    let sum = 0;
    for (let i = 0; i < 2; i++) sum += (bytes[i] >> 4) + (bytes[i] & 0x0f);
    bytes[2] = ((sum & 0x0f) ^ (breakChk ? 0x0f : 0)) << 3;
    const row = [1, ...bytesToBits(bytes).slice(0, 21)].slice(0, bits);
    return rowsOf(row, row);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Martec decodes a well-formed frame');
  eq(out[0]?.id, 5, 'Martec channel id survives the reflect and invert');
  eq(out[0]?.dimmer, 32, 'Martec dimmer is turned the right way up');
  eq(out[0]?.speed, 'high', 'Martec fan speed');
  eq(out[0]?.mic, 'CHECKSUM', 'Martec reports a checksum');

  for (const [n, name] of [[0, 'off'], [1, 'high'], [2, 'medium'], [3, 'low']]) {
    eq(run(d, build({ speed: n }))[0]?.speed, name, `Martec speed ${n} is ${name}`);
  }
  eq(run(d, build({ wireDimmer: 1 }))[0]?.dimmer, 41, 'Martec wire value 1 is full brightness');
  eq(run(d, build({ wireDimmer: 0 }))[0]?.dimmer, 0, 'Martec wire value 0 is off');
  eq(run(d, build({ channel: 12 }))[0]?.id, 12, 'Martec channel round-trips');

  /*
   * A four-bit checksum accepts an empty payload as readily as a real one, which is why there is a separate
   * guard. The premise is the point: the all-zero frame really does satisfy the checksum.
   */
  {
    const zero = build({ allZero: true });
    eq(0 & 0x0f, 0, 'an all-zero payload sums to zero, which is its own checksum (premise)');
    eq(run(d, zero).length, 0, 'so Martec throws it out on a separate sanity check');
  }

  eq(run(d, build({ breakChk: true })).length, 0, 'Martec rejects a bad checksum');
  {
    const single = [1, ...bytesToBits(Uint8Array.from([0x5a, 0x29, 0x40])).slice(0, 21)];
    eq(run(d, rowsOf(single)).length, 0, 'Martec needs the frame repeated');
  }
}

// ---- The registrations themselves ----
{
  for (const num of [61, 94, 98, 135, 270, 335]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
