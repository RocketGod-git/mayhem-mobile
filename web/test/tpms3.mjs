/**
 * Schrader tire pressure sensors.
 *
 * Five boards that agree on nothing, so each frame is built from its own specification and handed to the
 * decoder. Two are worth the trouble on their own.
 *
 * The SMD3MA4 needs its frame built backwards through a Manchester encode: each payload bit becomes a pair,
 * and because the decoder inverts afterwards the pair is the bit followed by its complement. The first pair
 * is not free at all — it is the last two bits of the preamble, which is why the frame's leading bit is
 * always one.
 *
 * The BMW MRXBC5A4's two check bits sit inside the range they are computed over, so they cannot be worked out
 * directly. The test searches for a self-consistent frame instead, which is what the sensor's own encoder has
 * to do.
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
/** A row of raw bits. */
const rowBits = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
/** `lead` bits of run-in, then the given bytes. */
const withLead = (lead, bytes, total) => {
  const bits = [];
  for (let i = 0; i < lead; i++) bits.push(0);
  for (let i = 0; i < bytes.length * 8; i++) bits.push(bitOf(bytes, i));
  while (bits.length < total) bits.push(0);
  return rowBits(bits.slice(0, total));
};

console.log('Schrader tire pressure sensors');

// ---- Schrader (60): eight bytes behind a four-bit run-in, closed by a CRC ----
{
  const b = [0x0a, 0x51, 0x23, 0x45, 0x67, 100, 70, 0];
  b[7] = U.crc8(Uint8Array.from(b), 7, 0x07, 0xf0);
  const d = run(dev(60), withLead(4, b, 68))[0];
  ok(!!d, 'Schrader decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, '1234567', '  Schrader id spans a nibble and three bytes');
    eq(d.flags, 'a5', '  Schrader flags span two bytes');
    eq(d.pressure_kPa, 250, '  Schrader pressure is millibar in steps of 25');
    eq(d.temperature_C, 20, '  Schrader temperature is offset by fifty');
  }
  const bad = [...b]; bad[3] ^= 0x01;
  ok(!run(dev(60), withLead(4, bad, 68))[0], '  Schrader rejects a frame failing its CRC');
}

// ---- EG53MA4 (95): ten bytes behind a forty-bit run-in, closed by a byte sum ----
{
  const b = [0x11, 0x22, 0x33, 0x44, 0x0a, 0x0b, 0x0c, 100, 75, 0];
  b[9] = U.addBytes(Uint8Array.from(b), 9) & 0xff;
  const d = run(dev(95), withLead(40, b, 120))[0];
  ok(!!d, 'EG53MA4 decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, '0A0B0C', '  EG53MA4 id');
    eq(d.flags, '11223344', '  EG53MA4 carries four bytes of flags');
    eq(d.pressure_kPa, 250, '  EG53MA4 pressure');
    // This board reports Fahrenheit on the wire and is left in that unit.
    eq(d.temperature_F, 75, '  EG53MA4 temperature stays in Fahrenheit');
  }
  const bad = [...b]; bad[6] ^= 0x01;
  ok(!run(dev(95), withLead(40, bad, 120))[0], '  EG53MA4 rejects a frame failing its sum');
}

// ---- SMD3MA4 (168) and NIS315G3 (352): one frame, two pressure scalings ----
{
  // Payload bytes, 38 bits used: fixed 1, flags 101, id 0ABCDE, pressure 150, then two check bits.
  // The two check bits are chosen so the running sum of every bit-pair comes to one modulo four.
  const payload = [0xd0, 0xab, 0xcd, 0xe9, 0x68];
  const t = [];
  for (let i = 0; i < 38; i++) t.push(bitOf(payload, i));

  // Preamble 0x55 0x5e; its last two bits are already the first Manchester pair, giving the fixed one-bit.
  const bits = [];
  for (let i = 0; i < 16; i++) bits.push(bitOf([0x55, 0x5e], i));
  // Every later bit becomes itself followed by its complement, which survives the decoder's inversion.
  for (let i = 1; i < 38; i++) { bits.push(t[i]); bits.push(t[i] ^ 1); }
  while (bits.length < 96) bits.push(0);

  const d = run(dev(168), rowBits(bits))[0];
  ok(!!d, 'SMD3MA4 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Schrader-SMD3MA4', '  SMD3MA4 model');
    eq(d.id, '0ABCDE', '  SMD3MA4 id');
    eq(d.flags, 5, '  SMD3MA4 flags');
    eq(d.wakeup, 1, '  flag value five is a wake-up');
    eq(d.pressure_PSI, 30, '  SMD3MA4 counts a fifth of a pound per step');
  }

  // The same bits on the other calibration: a quarter of a pound per step, so 25 per cent higher.
  const d2 = run(dev(352), rowBits(bits))[0];
  ok(!!d2, 'NIS315G3 decodes the same frame', JSON.stringify(d2));
  if (d2) {
    eq(d2.model, 'Schrader-NIS315G3', '  NIS315G3 model');
    eq(d2.pressure_PSI, 37.5, '  NIS315G3 counts a quarter of a pound per step');
  }

  // Break the bit-pair sum and neither may report.
  const bad = [...bits];
  bad[20] ^= 1; bad[21] ^= 1;      // flip a whole pair, so the coding stays valid but the sum does not
  ok(!run(dev(168), rowBits(bad))[0], '  SMD3MA4 rejects a frame failing its bit-pair sum');
}

// ---- MRXBC5A4 (328): a two-bit check that is part of its own input ----
{
  // id 0ABCDE, flags 1, pressure 250 kPa. The check bits sit inside the range they cover, so a
  // self-consistent frame is searched for rather than computed - which is what the sensor must do too.
  // The pressure's low nibble is varied to find a frame the check agrees with: it sits at bit indices 32-35,
  // inside the covered range. The temperature does not - it begins at index 38 - so varying that could never
  // have changed the outcome.
  const build = (c1, c2, pressLow, tempField) => {
    const b = [0x21, 0x57, 0x9b, 0xcf, 0, 0];
    b[4] = ((pressLow & 0x0f) << 4) | (c1 << 3) | (c2 << 2) | ((tempField >> 5) & 0x03);
    b[5] = (tempField & 0x1f) << 3;
    return b;
  };
  const checkHolds = (b) => {
    let evenOnes = 0, ones = 0;
    for (let i = 3; i < 38; i++) {
      if ((b[i >> 3] >> (7 - (i % 8))) & 1) { ones++; if ((i - 3) % 2 === 0) evenOnes++; }
    }
    const want = (evenOnes + 2 * ones - 1) & 0x3;
    return want === ((((b[4] >> 3) & 1) << 1) | ((b[4] >> 2) & 1));
  };

  let frame = null, wantPressure = 0;
  const TEMP_FIELD = 70;                                       // 70 on the wire is 20 C
  outer:
  for (let pressLow = 0; pressLow < 16; pressLow++) {
    for (let c1 = 0; c1 < 2; c1++) {
      for (let c2 = 0; c2 < 2; c2++) {
        const b = build(c1, c2, pressLow, TEMP_FIELD);
        if (checkHolds(b)) { frame = b; wantPressure = 240 + pressLow; break outer; }
      }
    }
  }
  ok(!!frame, 'a self-consistent MRXBC5A4 frame exists');

  if (frame) {
    // Sixteen bits of wake, sync and start, then the payload; sixty-one bits in all.
    const d = run(dev(328), withLead(0, [0x7f, 0xff, ...frame], 61))[0];
    ok(!!d, 'MRXBC5A4 decodes', JSON.stringify(d));
    if (d) {
      eq(d.model, 'Schrader-MRXBC5A4', '  MRXBC5A4 model');
      eq(d.id, '0ABCDE', '  MRXBC5A4 id spans four bytes');
      eq(d.pressure_kPa, wantPressure, '  MRXBC5A4 pressure is already kilopascals');
      eq(d.temperature_C, 20, '  MRXBC5A4 temperature is offset by fifty');
      eq(d.flags, '1', '  MRXBC5A4 flags');
    }

    // The prefix is verified rather than assumed, so a frame without it must be refused.
    ok(!run(dev(328), withLead(0, [0x00, 0x00, ...frame], 61))[0],
      '  MRXBC5A4 refuses a frame with no wake-and-sync prefix');

    // An implausible pressure is rejected even when the two check bits happen to agree.
    let wild = null;
    for (let c1 = 0; c1 < 2 && !wild; c1++) {
      for (let c2 = 0; c2 < 2; c2++) {
        const b = [0x21, 0x57, 0x9b, 0xff, 0xf0 | (c1 << 3) | (c2 << 2), 0x30];
        if (checkHolds(b)) { wild = b; break; }
      }
    }
    if (wild) {
      ok(!run(dev(328), withLead(0, [0x7f, 0xff, ...wild], 61))[0],
        '  MRXBC5A4 rejects a pressure no tire could hold, even with the check bits agreeing');
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
