/**
 * The TFA family, and the return-to-zero-inverted slicer added for it.
 *
 * Every frame is laid out as the sensor would send it and handed to the decoder. Where a device uses an LFSR
 * digest the test computes it with the same helper rather than by hand — so these prove the *field layout*
 * (byte positions, scaling, offsets, sentinels, bit inversion, variant selection), not the digest algorithm
 * itself. The digests have their own coverage against published vectors in `r433.mjs`.
 *
 * Not covered here: the TFA 30.3196, which would need a synthesized Manchester frame to reach its decoder.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import { pulseSlicerRzi } from '../dist/dsp/r433/slicers.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };
/** One row of the given bytes, truncated to `bitLen` bits, repeated `rows` times. */
const rows = (bytes, bitLen, count = 1) => {
  const bb = new BitBuffer();
  for (let r = 0; r < count; r++) {
    if (r) bb.addRow();
    for (let i = 0; i < bitLen; i++) bb.addBit((bytes[i >> 3] >> (7 - (i & 7))) & 1);
  }
  return bb;
};
const inv = (b) => b.map(v => (~v) & 0xff);

console.log('TFA and the boards that share its frames');

// ---- Inovalley kw9015b / TFA 30.3161 (37): every byte arrives bit-reversed ----
{
  // Chosen so the reversed bytes read: id 5, 21.5 C, rain count 100, checksum nibble 3.
  const d = run(dev(37), rows([0xa0, 0x0e, 0xb0, 0x26, 0xc0], 36, 4))[0];
  ok(!!d, 'kw9015b decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, 5, '  kw9015b id comes from the reversed low nibble');
    eq(d.temperature_C, 21.5, '  kw9015b temperature, reassembled from two reversed bytes');
    eq(d.rain_mm, 45, '  kw9015b rain total at 0.45 mm a tip');
    eq(d.battery_ok, 1, '  kw9015b battery flag is read unreversed, unlike everything else');
  }
  // The checksum is a sum of reversed nibbles; break one and it must not report.
  ok(!run(dev(37), rows([0xa0, 0x0e, 0xb0, 0x26, 0x40], 36, 4))[0], '  kw9015b rejects a bad nibble sum');
}

// ---- TFA Drop rain gauge (147): arrives inverted, counter offset by ten and allowed to wrap ----
{
  const t = [0x3a, 0xbc, 0xde, 0x00, 0x34, 0x00, 0x12, 0];
  t[7] = U.lfsrDigest8Reflect(Uint8Array.from(t), 7, 0x31, 0xf4);
  const d = run(dev(147), rows(inv(t), 66, 3))[0];
  ok(!!d, 'TFA Drop decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, 'abcde', '  Drop id spans the first nibble and two bytes');
    eq(d.battery_ok, 1, '  Drop battery');
    // (0x1234 + 10) * 0.254
    eq(d.rain_mm, 1186.2, '  Drop rain total, counter offset by ten and scaled by 0.254');
  }
}

// ---- TFA 30.3221 (165): also inverted, temperature offset by fifty degrees ----
{
  const t = [0x5a, 0x12, 0xd5, 55, 0];
  t[4] = U.lfsrDigest8Reflect(Uint8Array.from(t), 4, 0x31, 0xf4);
  const d = run(dev(165), rows(inv(t), 40, 3))[0];
  ok(!!d, '30.3221 decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, 0x5a, '  30.3221 id');
    eq(d.temperature_C, 22.5, '  30.3221 temperature carries a five-hundred offset, not four hundred');
    eq(d.humidity, 55, '  30.3221 humidity');
    eq(d.channel, 2, '  30.3221 channel');
    eq(d.sendmode, 0, '  30.3221 test-button flag');
    eq(d.battery_ok, 1, '  30.3221 battery');
  }
}

// ---- TFA Marbella pool thermometer (182): digest covers bytes three to nine of a frame that keeps its preamble ----
{
  const m = [0xaa, 0x2d, 0xd4, 0x0a, 0x0b, 0x0c, 0x06, 0x28, 0x00, 0xaa, 0];
  m[10] = U.lfsrDigest8Reflect(Uint8Array.from(m), 7, 0x31, 0x31, 3);
  const d = run(dev(182), rows([0xaa, 0xaa, ...m], 13 * 8))[0];
  ok(!!d, 'Marbella decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, '0a0b0c', '  Marbella serial');
    eq(d.temperature_C, 24, '  Marbella temperature spans a nibble boundary');
    eq(d.counter, 3, '  Marbella transmission counter');
    eq(d.battery_ok, 1, '  Marbella battery');
  }
}

// ---- TFA 14.1504 V2 grill probe (232): whole degrees, and a value meaning "no probe" ----
{
  const mk = (b0, b1) => {
    const b = [b0, b1, 0xff, 0, 0];
    const mic = U.lfsrDigest16(Uint8Array.from(b), 3, 0x8810, 0x0d42) ^ 0x16eb;
    b[3] = (mic >> 8) & 0xff; b[4] = mic & 0xff;
    return rows([0xaa, 0xaa, 0x5c, ...b], 64);
  };
  const d = run(dev(232), mk(0x2b, 0x20))[0];       // raw 712 -> 712 - 532 = 180 C
  ok(!!d, '14.1504 decodes', JSON.stringify(d));
  if (d) {
    eq(d.temperature_C, 180, '  14.1504 temperature is whole degrees offset by 532');
    eq(d.probe_fail, 0, '  14.1504 reports the probe present');
    eq(d.battery_ok, 1, '  14.1504 battery');
  }
  const none = run(dev(232), mk(0x27, 0x00))[0];    // raw 0x1c0, the "no probe" value
  ok(!!none, '  14.1504 still decodes with no probe fitted', JSON.stringify(none));
  if (none) {
    eq(none.probe_fail, 1, '    and says the probe failed');
    ok(none.temperature_C === undefined, '    without inventing a temperature', String(none.temperature_C));
  }
}

// ---- WH1050 (69) and TFA 30.3151 (246): one frame, two scalings ----
{
  // Identical payload both ways. Keyed: offset forty degrees, rain in 0.3 mm. Shifted: sign bit, rain in 0.5.
  const br = [0x5a, 0x02, 0x67, 55, 20, 30, 0x00, 100, 0];
  br[8] = U.crc8(Uint8Array.from(br), 8, 0x31, 0x00);

  const ook = run(dev(69), rows([0xff, ...br], 80))[0];
  ok(!!ook, 'WH1050 decodes on the keyed radio', JSON.stringify(ook));
  if (ook) {
    eq(ook.model, 'Fineoffset-WH1050', '  WH1050 model');
    eq(ook.temperature_C, 21.5, '  WH1050 temperature carries the forty-degree offset');
    eq(ook.rain_mm, 30, '  WH1050 rain counts in 0.3 mm');
    eq(ook.humidity, 55, '  WH1050 humidity');
  }

  const fsk = run(dev(246), rows([0xaa, 0xaa, 0xaa, 0xaa, 0x2d, 0xd4, ...br], 15 * 8))[0];
  ok(!!fsk, 'the same bytes decode on the shifted radio', JSON.stringify(fsk));
  if (fsk) {
    eq(fsk.model, 'TFA-303151', '  30.3151 model');
    // The whole point: same bytes, different scaling. Reading one as the other is forty degrees out.
    eq(fsk.temperature_C, 61.5, '  30.3151 has no forty-degree offset');
    eq(fsk.rain_mm, 50, '  30.3151 rain counts in 0.5 mm');
  }
}

// ---- TFA 30.390X (347): five models on one frame, chosen by a byte and a length ----
{
  const b = new Array(28).fill(0);
  b[0] = 0x4b; b[1] = 0x2d; b[2] = 0xd4; b[3] = 0x2b;
  b[4] = 24;                                   // frame length, which must match the variant
  b[5] = 0xa5; b[6] = 0x11; b[7] = 0x22; b[8] = 0x33;
  b[9] = 0x00;                                 // battery ok, no manual transmit
  b[10] = 0x34; b[11] = 0x12;                  // sequence 0x1234, little-endian
  b[12] = 0xd7; b[13] = 0x00;                  // 21.5 C
  b[16] = 0xce; b[17] = 0x07;                  // -5.0 C, eleven-bit two's complement
  b[20] = 0x00; b[21] = 0x00;                  // 0.0 C
  let crc = 0xffffffff;
  for (let k = 4; k < 24; k++) {
    crc ^= b[k];
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  b[24] = crc & 0xff; b[25] = (crc >> 8) & 0xff; b[26] = (crc >> 16) & 0xff; b[27] = (crc >>> 24) & 0xff;

  const d = run(dev(347), rows(b, 28 * 8))[0];
  ok(!!d, '30.390X decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'TFA-303901', '  the variant byte and the length together pick the model');
    eq(d.id, 'A5112233', '  30.390X id');
    eq(d.temperature_C, 21.5, '  30.390X current temperature');
    eq(d.temperature_C_last, '21.5, -5, 0', '  30.390X reports its last three, sign-extended from eleven bits');
    eq(d.seq_number, 0x1234, '  30.390X sequence number');
    eq(d.battery_ok, 1, '  30.390X battery');
  }
  // A length that does not match the variant is a frame we have misread, not a model we do not know.
  const wrongLen = [...b]; wrongLen[4] = 30;
  ok(!run(dev(347), rows(wrongLen, 28 * 8))[0], '  30.390X rejects a length its variant cannot have');
}

// ---- the return-to-zero-inverted slicer, which nothing in the port implemented before ----
{
  // The line sits high; a dip marks a zero and a long high run counts ones. With a 167 us bit period and a
  // 30 us dip, the tail of high belonging to a zero's own period is 137 us — so a following one-bit shows up
  // as a 304 us high, not a 167 us one.
  const d = { shortWidth: 30, longWidth: 167, resetLimit: 500 };
  const pulses = {
    pulse: Int32Array.from([167, 304, 137]),
    gap: Int32Array.from([30, 30, 9999]),
    numPulses: 3,
    sampleRate: 1e6,
    fsk: false,
  };
  let n = 0, first = 0;
  pulseSlicerRzi(pulses, d, (bits) => { n = bits.bitsPerRow[0]; first = bits.bb[0][0]; bits.clear(); return 1; });
  // Four bits, 1010: a one, the dip closing it, a one, and the dip after that.
  eq(n, 4, 'the RZI slicer emits one bit per element');
  eq(first >> 4, 0b1010, 'the RZI slicer reads a high run as ones and a dip as a zero');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
