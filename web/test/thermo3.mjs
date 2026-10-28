/**
 * Nine thermometers, five of them checked against evidence rtl_433 published rather than against this port.
 *
 * Rubicson ships nineteen captures, Bresser twenty-four annotated bit rows, Thermor A6N six sample frames,
 * Thermor DG950 one complete off-air recording, and Inkbird one sample byte row. Those go in as they were
 * written and the documented readings come out. Klimalogg, Acurite, Oria and Auriol publish nothing usable,
 * so their frames are built from the transmit side — laid out the way the sensor lays them out, with every
 * checksum computed by a reference written here rather than imported, so agreement between the two means
 * something.
 *
 * Three upstream defects are asserted rather than papered over:
 *
 * - Rubicson loses the magnitude of every sub-zero reading to a C precedence accident. The captures prove
 *   the sign bit means "negate", and the test states both what upstream produces and what the bits carry.
 * - Inkbird's sample byte row fails the CRC that same file documents, even though the CRC's parameters are
 *   provably correct against the published check value. One byte explains it, and the file's own prose says
 *   which byte and why.
 * - Oria's layout comment puts the sign at bit 4 while its code reads bit 3. The code is what ships.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

// ---- Reference arithmetic, written from the definitions rather than imported ----
const rev8ref = (x) => { let r = 0; for (let i = 0; i < 8; i++) if ((x >> i) & 1) r |= 0x80 >> i; return r; };
const refl4ref = (n) => ((n & 1) << 3) | ((n & 2) << 1) | ((n & 4) >> 1) | ((n & 8) >> 3);
const crc8ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[i]; for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff; }
  return r;
};
const crc16lsbRef = (m, n, poly, init) => {
  let r = init & 0xffff;
  for (let i = 0; i < n; i++) { r ^= m[i]; for (let k = 0; k < 8; k++) r = (r & 1) ? ((r >> 1) ^ poly) & 0xffff : (r >> 1); }
  return r & 0xffff;
};
const parityRef = (x) => { let p = 0; for (let i = 0; i < 8; i++) p ^= (x >> i) & 1; return p; };

// ---- Frame plumbing ----
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/[^0-9a-fA-F]/g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const bytesToBits = (bytes) => { const b = []; for (const v of bytes) for (let i = 7; i >= 0; i--) b.push((v >> i) & 1); return b; };
const bitsToBytes = (bits) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
};
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/[^0-9a-fA-F]/g, '').match(/../g).map(x => parseInt(x, 16)));
const binToBits = (s) => s.replace(/[^01]/g, '').split('').map(Number);
/** One row per bit array. */
const rows = (...arrs) => {
  const bb = new BitBuffer();
  arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
const rep = (bits, n) => rows(...new Array(n).fill(bits));

console.log('Rubicson, Klimalogg, Inkbird, Acurite, Thermor DG950, Bresser, Oria, Thermor A6N and Auriol');

// ===========================================================================
// Rubicson 48659 (133): nineteen documented captures
// ===========================================================================
{
  const d = dev(133);
  // hex, the Celsius reading written beside it in the source
  const CAPS = [
    ['01 08 71 d4', 45], ['01 50 7a 25', 50], ['01 60 7c 37', 51], ['01 00 80 db', 53],
    ['23 60 dc b9', 104], ['23 19 13 a9', 135], ['23 79 3f 35', 159],
    ['cc 38 67 c5', 39], ['f0 18 43 a5', 19], ['0b 68 4d 1a', 25], ['d2 60 4c d8', 24],
    ['1a 70 0e f2', -10], ['1a 18 03 8f', -16],
  ];

  for (const [hex, docC] of CAPS) {
    const b = hexToBytes(hex);
    // The premise: this really is a frame the sensor's own checksum accepts.
    eq((b[0] + b[1] + b[2] - b[3]) & 0xff, 0xa6, `Rubicson ${hex} satisfies its checksum, computed independently`);
    eq((b[1] & 0x04) >> 2, 0, `Rubicson ${hex} is a positive reading (premise)`);

    const out = run(d, rep(bitsFromHex(hex, 32), 10));
    eq(out.length, 1, `Rubicson decodes capture ${hex}`);
    eq(out[0]?.id, b[0], `Rubicson id from ${hex}`);
    const mag = ((b[1] & 0x03) << 8) | b[2];
    eq(out[0]?.temperature_F, mag, `Rubicson temperature from ${hex} is ${mag} F`);
    // The source annotates each capture in Celsius; the wire is Fahrenheit.
    eq(Math.round((mag - 32) * 5 / 9), docC, `Rubicson ${hex} converts to the documented ${docC} C`);
  }

  /*
   * Two of the source's annotations do not survive that conversion — 259 F is 126.1 C beside a written 128,
   * and 279 F is 137.2 C beside a written 138. Both frames pass the checksum, so both are real transmissions;
   * the annotation column is loosely assembled, in the same way this corpus's comments often are.
   */
  for (const [hex, docC, realC] of [['23 19 03 99', 128, 126.1], ['23 39 17 cd', 138, 137.2]]) {
    const b = hexToBytes(hex);
    eq((b[0] + b[1] + b[2] - b[3]) & 0xff, 0xa6, `Rubicson ${hex} is a valid frame (premise)`);
    const mag = ((b[1] & 0x03) << 8) | b[2];
    eq(Math.round((mag - 32) * 50 / 9) / 10, realC, `Rubicson ${hex} is really ${realC} C`);
    ok(Math.round((mag - 32) * 5 / 9) !== docC, `and not the ${docC} C written beside it (upstream annotation error)`);
    eq(run(d, rep(bitsFromHex(hex, 32), 10))[0]?.temperature_F, mag, `Rubicson still reports ${mag} F for ${hex}`);
  }

  /*
   * The precedence bug. Upstream writes `sign ? -1 : 1 * magnitude`, and `*` binds tighter than `?:`, so the
   * negative branch is the bare constant. Every sub-zero capture therefore reports -1 F whatever was sent.
   */
  const NEG = [
    ['1a 9c 03 13', 3, -19], ['1a b4 06 2e', 6, -22], ['1a d4 0a 52', 10, -23], ['1a e4 0c 64', 12, -24],
  ];
  for (const [hex, mag, docC] of NEG) {
    const b = hexToBytes(hex);
    eq((b[0] + b[1] + b[2] - b[3]) & 0xff, 0xa6, `Rubicson ${hex} is a valid frame (premise)`);
    eq((b[1] & 0x04) >> 2, 1, `Rubicson ${hex} has the sign bit set (premise)`);
    eq(((b[1] & 0x03) << 8) | b[2], mag, `Rubicson ${hex} carries a magnitude of ${mag} (premise)`);
    // The bits say -mag F, and that lands on the Celsius reading the source wrote beside the capture.
    ok(Math.abs(Math.round((-mag - 32) * 5 / 9) - docC) <= 1,
      `Rubicson ${hex}: negating the magnitude gives the documented ${docC} C`, `got ${Math.round((-mag - 32) * 5 / 9)}`);
    ok(mag !== 1, `${hex} is a capture where the bug is visible (premise)`);
    eq(run(d, rep(bitsFromHex(hex, 32), 10))[0]?.temperature_F, -1,
      `but upstream reports a flat -1 F for ${hex}, and so does this port`);
  }
  {
    // The one sub-zero capture where the bug hides, because the magnitude happens to be 1 already.
    const hex = '1a 8c 01 01';
    eq(((hexToBytes(hex)[1] & 0x03) << 8) | hexToBytes(hex)[2], 1, `${hex} carries a magnitude of exactly 1 (premise)`);
    eq(run(d, rep(bitsFromHex(hex, 32), 10))[0]?.temperature_F, -1, `so ${hex} reads -1 F either way`);
  }

  // Rejections.
  {
    const good = bitsFromHex('01 50 7a 25', 32);
    const bad = [...good]; bad[31] ^= 1;              // inside the checksum byte, which the decoder reads
    ok(good.join('') !== bad.join(''), 'the corrupted Rubicson row really differs (premise)');
    const b = bitsToBytes(bad);
    ok(((b[0] + b[1] + b[2] - b[3]) & 0xff) !== 0xa6, 'and the corruption breaks the checksum (premise)');
    eq(run(d, rep(bad, 10)).length, 0, 'Rubicson rejects a bad checksum');
    eq(run(d, rep(good, 9)).length, 0, 'Rubicson wants ten matching rows, not nine');
    eq(run(d, rep(good, 10)).length, 1, 'and ten is enough (premise for the line above)');
  }
}

// ===========================================================================
// Klimalogg Pro (150): built from the transmit side
// ===========================================================================
{
  const d = dev(150);
  eq(d.disabled, true, 'Klimalogg is marked doubtful, mirroring upstream\'s own disabled flag');

  /**
   * Nine payload bytes as the protocol lays them out, then the whole thing — sync word included — reflected,
   * which is what this sensor actually puts on the air.
   */
  const build = ({ id = 0x1234, tempRaw = 615, humidity = 55, battLow = 0, seq = 3,
    type = 0x56, breakCrc = false, lead = 8 } = {}) => {
    const D = new Uint8Array(9);
    D[0] = (id >> 8) & 0x7f;
    D[1] = id & 0xff;
    D[2] = 0x80 | ((tempRaw / 100 | 0) & 0x0f);       // high nibble is the learning sequence, fixed at 8
    D[3] = (((tempRaw / 10 | 0) % 10) << 4) | (tempRaw % 10);
    D[4] = humidity;
    D[5] = battLow ? 0x80 : 0x00;
    D[6] = (seq << 4);
    D[7] = type;
    D[8] = crc8ref(D, 8, 0x31, 0x00) ^ (breakCrc ? 0xff : 0x00);

    const wire = Uint8Array.from([0xb4, 0x2b, ...[...D].map(rev8ref)]);
    return rows([...new Array(lead).fill(0), ...bytesToBits(wire)]);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Klimalogg decodes a well-formed frame');
  eq(out[0]?.id, 0x1234, 'Klimalogg id');
  eq(out[0]?.temperature_C, 21.5, 'Klimalogg temperature is BCD with a 40 C offset: 615 is 21.5 C');
  eq(out[0]?.humidity, 55, 'Klimalogg humidity');
  eq(out[0]?.battery_ok, 1, 'Klimalogg battery');
  eq(out[0]?.sequence_nr, 3, 'Klimalogg sequence number');
  eq(out[0]?.mic, 'CRC', 'Klimalogg claims a CRC');

  eq(run(d, build({ tempRaw: 250 }))[0]?.temperature_C, -15, 'Klimalogg reads below zero via the offset');
  eq(run(d, build({ tempRaw: 0 }))[0]?.temperature_C, -40, 'Klimalogg bottom of range');
  eq(run(d, build({ tempRaw: 1000 }))[0]?.temperature_C, 60, 'Klimalogg top of range');
  eq(run(d, build({ battLow: 1 }))[0]?.battery_ok, 0, 'Klimalogg reports a low battery');
  eq(run(d, build({ lead: 0 }))[0]?.id, 0x1234, 'Klimalogg finds a preamble sitting at bit zero');
  eq(run(d, build({ lead: 37 }))[0]?.id, 0x1234, 'Klimalogg finds a preamble at an odd bit offset');

  // The saturated-humidity code, and the premise that it really is the code and not an ordinary reading.
  {
    const sat = run(d, build({ humidity: 0x6a }));
    eq(0x6a, 106, 'the saturation code is 0x6a (premise)');
    eq(sat[0]?.humidity, 100, 'Klimalogg turns the saturation code into a flat 100%');
    eq(run(d, build({ humidity: 100 }))[0]?.humidity, 100, 'an ordinary 100% reads the same way');
  }

  // The type byte is checked before the buffer is turned round, against 0x56 reflected.
  eq(rev8ref(0x56), 0x6a, 'reflecting the type byte 0x56 gives 0x6a, which is what the gate tests (premise)');
  {
    const wrongType = build({ type: 0x57 });
    eq(run(d, wrongType).length, 0, 'Klimalogg rejects a frame whose type byte is not 0x56');
    // and that rejection is the type gate, not the CRC: the CRC over that frame is still sound.
    const D = new Uint8Array(9);
    D[0] = 0x12; D[1] = 0x34; D[2] = 0x86; D[3] = 0x15; D[4] = 55; D[5] = 0; D[6] = 0x30; D[7] = 0x57;
    D[8] = crc8ref(D, 8, 0x31, 0x00);
    eq(crc8ref(D, 9, 0x31, 0x00), 0, 'the wrong-type frame carries a valid CRC (premise)');
  }

  eq(run(d, build({ breakCrc: true })).length, 0, 'Klimalogg rejects a bad CRC');
  eq(run(d, rows(new Array(40).fill(1))).length, 0, 'Klimalogg rejects a row too short to hold a message');
  eq(run(d, rows([...new Array(88).fill(0)])).length, 0, 'Klimalogg rejects a row with no preamble in it');
}

// ===========================================================================
// Inkbird ITH-20R (194): the documented sample, and what is wrong with it
// ===========================================================================
{
  const d = dev(194);
  const POLY = 0xa001, INIT = 0x86f4;

  /*
   * First, the parameters. The source states check=0x3583 — the value this CRC gives for the digits one
   * through nine — and the polynomial and initial value it quotes reproduce that exactly. So the arithmetic
   * this decoder relies on is confirmed independently of any frame.
   */
  eq(crc16lsbRef(Uint8Array.from('123456789', c => c.charCodeAt(0)), 9, POLY, INIT), 0x3583,
    'the Inkbird CRC parameters reproduce the published check value 0x3583');

  /*
   * Now the sample row. It does not satisfy that CRC. Exactly one byte explains it, and the file's own prose
   * names it: byte 4 "changes from 1 to 2 if external sensor present", and this sample's external probe reads
   * 24.4 C rather than the 130.0 C the file gives as the not-connected value. So the frame the CRC was taken
   * over had an external probe attached and byte 4 set to 2, while the sample column lists the ordinary 1.
   */
  const SAMPLE = hexToBytes('D3 91 0F 00 01 03 01 58 A2 21 D6 00 F4 00 D3 01 38 FB 00');
  const carried = (SAMPLE[17] << 8) | SAMPLE[16];
  eq(carried, 0xfb38, 'the sample carries 0xfb38 as its CRC (premise)');
  ok(crc16lsbRef(SAMPLE, 16, POLY, INIT) !== carried,
    'the documented Inkbird sample fails its own CRC (upstream documentation error)',
    `computes ${crc16lsbRef(SAMPLE, 16, POLY, INIT).toString(16)}`);
  const FIXED = Uint8Array.from(SAMPLE); FIXED[4] = 0x02;
  eq(crc16lsbRef(FIXED, 16, POLY, INIT), carried, 'setting byte 4 to 2 makes the sample check out exactly');
  eq((((SAMPLE[13] << 8 | SAMPLE[12]) << 16) >> 16), 244, 'and the sample\'s external probe reads 244 (premise)');
  ok((((SAMPLE[13] << 8 | SAMPLE[12]) << 16) >> 16) !== 1300,
    'which is not the documented 0x1405 not-connected value, so a probe really was attached (premise)');

  /** Two 0xaa bytes of run-in ahead of the searched preamble, then the nineteen-byte message. */
  const build = (msg, { pre = 2 } = {}) => rows([
    ...bytesToBits(new Uint8Array(pre).fill(0xaa)),
    ...bytesToBits(hexToBytes('aa aa aa 2d d4')),
    ...bytesToBits(msg),
  ]);
  const frame = ({ base = FIXED, temp, temp2, hum, id, num, batt } = {}) => {
    const m = Uint8Array.from(base);
    if (num !== undefined) m[4] = num;
    if (batt !== undefined) m[7] = batt;
    if (id !== undefined) { m[8] = id & 0xff; m[9] = (id >> 8) & 0xff; }
    if (temp !== undefined) { m[10] = temp & 0xff; m[11] = (temp >> 8) & 0xff; }
    if (temp2 !== undefined) { m[12] = temp2 & 0xff; m[13] = (temp2 >> 8) & 0xff; }
    if (hum !== undefined) { m[14] = hum & 0xff; m[15] = (hum >> 8) & 0xff; }
    const c = crc16lsbRef(m, 16, POLY, INIT);
    m[16] = c & 0xff; m[17] = (c >> 8) & 0xff;
    return m;
  };

  const out = run(d, build(FIXED));
  eq(out.length, 1, 'Inkbird decodes the repaired sample row');
  eq(out[0]?.id, 8610, 'Inkbird id, little-endian');
  eq(out[0]?.sensor_num, 2, 'Inkbird sensor number says an external probe is attached');
  eq(out[0]?.battery_ok, 0.88, 'Inkbird battery is a level, not a flag — 0x58 is 88%');
  eq(out[0]?.temperature_C, 21.4, 'Inkbird temperature is little-endian tenths');
  eq(out[0]?.temperature_2_C, 24.4, 'Inkbird second probe');
  eq(out[0]?.humidity, 46.7, 'Inkbird humidity is tenths of a percent');
  eq(out[0]?.mic, 'CRC', 'Inkbird claims a CRC');

  eq(run(d, build(frame({ temp: 0xffcb & 0xffff })))[0]?.temperature_C, -5.3,
    'Inkbird sign-extends a sixteen-bit negative temperature');
  eq(run(d, build(frame({ temp: -200 & 0xffff })))[0]?.temperature_C, -20, 'Inkbird reads -20.0 C');
  eq(run(d, build(frame({ temp2: 0x0514, num: 1 })))[0]?.temperature_2_C, 130,
    'Inkbird reports the documented 130.0 C when no second probe is connected');

  // Rejections.
  {
    const good = build(FIXED);
    eq(run(d, good).length, 1, 'the intact frame decodes (premise)');
    const bad = Uint8Array.from(FIXED); bad[10] ^= 0x01;   // inside the CRC's range, and read as temperature
    ok(crc16lsbRef(bad, 16, POLY, INIT) !== ((bad[17] << 8) | bad[16]), 'the corrupted frame fails the CRC (premise)');
    eq(run(d, build(bad)).length, 0, 'Inkbird rejects a bad CRC');
  }
  {
    const bits = [...bytesToBits(hexToBytes('aa aa aa 2d d4')), ...bytesToBits(FIXED)];
    eq(run(d, rows(bits, bits)).length, 0, 'Inkbird wants exactly one row');
    eq(run(d, rows(bits.slice(0, 180))).length, 0, 'Inkbird rejects a row shorter than 187 bits');
    // A long row with no preamble anywhere in it.
    eq(run(d, rows(new Array(240).fill(0))).length, 0, 'Inkbird rejects a row with no sync word');
  }
  {
    // Long enough overall, but not enough message after the preamble.
    const short = [...bytesToBits(hexToBytes('aa aa aa aa aa aa aa aa 2d d4')), ...bytesToBits(FIXED.slice(0, 17))];
    ok(short.length >= 187, 'the truncated frame is still long enough to be considered (premise)', `${short.length} bits`);
    eq(run(d, rows(short)).length, 0, 'Inkbird rejects a message truncated after the preamble');
  }
}

// ===========================================================================
// Acurite 01185M (197): built from the transmit side
// ===========================================================================
{
  const d = dev(197);

  /** Seven bytes, reflected and then inverted, which is the order the decoder undoes them in. */
  const wire = (D) => bytesToBits(Uint8Array.from([...D].map(v => ~rev8ref(v) & 0xff)));
  const build = ({ id = 0x5a, battLow = 0, channel = 6, t1 = 1430, t2 = 2250, breakChk = false, trim = 0 } = {}) => {
    const D = new Uint8Array(7);
    D[0] = id;
    D[1] = (battLow << 7) | channel;
    D[2] = (t1 >> 8) & 0xff; D[3] = t1 & 0xff;
    D[4] = (t2 >> 8) & 0xff; D[5] = t2 & 0xff;
    let s = 0; for (let i = 0; i < 6; i++) s += D[i];
    D[6] = (s & 0xff) ^ (breakChk ? 0xff : 0x00);
    const bits = wire(D);
    return rows(trim ? bits.slice(0, 56 - trim) : bits);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Acurite 01185M decodes a well-formed frame');
  eq(out[0]?.id, 0x5a, 'Acurite id');
  eq(out[0]?.channel, 6, 'Acurite channel, one of the four values the sensor picks for itself');
  eq(out[0]?.battery_ok, 1, 'Acurite battery');
  eq(out[0]?.temperature_1_F, 53, 'Acurite meat probe: raw 1430 is 53.0 F');
  eq(out[0]?.temperature_2_F, 135, 'Acurite grill probe: raw 2250 is 135.0 F');
  eq(run(d, build({ battLow: 1 }))[0]?.battery_ok, 0, 'Acurite reports a low battery');
  eq(run(d, build({ channel: 15 }))[0]?.channel, 15, 'Acurite channel 15');

  // The two error sentinels, each of which suppresses only its own probe.
  {
    const unplugged = run(d, build({ t1: 7000 }));
    eq(unplugged.length, 1, 'Acurite still reports when a probe is unplugged');
    eq(unplugged[0]?.temperature_1_F, undefined, 'the unplugged probe (raw 7000, the E1 code) reports nothing');
    eq(unplugged[0]?.temperature_2_F, 135, 'while the other probe still reads');

    const faulty = run(d, build({ t2: 200 }));
    eq(faulty[0]?.temperature_2_F, undefined, 'the failed probe (raw 200, the E2 code) reports nothing');
    eq(faulty[0]?.temperature_1_F, 53, 'while the other probe still reads');

    // Both bounds are exclusive, so the sentinel values themselves are the first thing outside the range.
    eq(run(d, build({ t1: 200 }))[0]?.temperature_1_F, undefined, 'raw 200 exactly is the E2 code, not a reading');
    eq(run(d, build({ t1: 201 }))[0]?.temperature_1_F, -69.9, 'while raw 201 is the coldest reading there is');
    eq(run(d, build({ t1: 7000 }))[0]?.temperature_1_F, undefined, 'raw 7000 exactly is the E1 code');
    eq(run(d, build({ t1: 6999 }))[0]?.temperature_1_F, 609.9, 'while raw 6999 is the hottest');
    eq(run(d, build({ t2: 201 }))[0]?.temperature_2_F, -69.9, 'the grill probe uses the same bounds');
    eq(run(d, build({ t2: 6999 }))[0]?.temperature_2_F, 609.9, 'at both ends');
  }

  /*
   * The full-width sum, which is the whole reason this decoder does not use the shared byte-narrowing helper.
   * These six bytes sum to exactly 0x100, so the narrowed sum is zero — and a narrowed sum would make the
   * all-zeros guard fire on a frame that is nothing of the kind.
   */
  {
    const D = Uint8Array.from([0x04, 0x00, 0x00, 0xe8, 0x00, 0x14, 0x00]);
    let s = 0; for (let i = 0; i < 6; i++) s += D[i];
    eq(s, 256, 'this frame\'s bytes sum to exactly 0x100 (premise)');
    eq(s & 0xff, D[6], 'and the narrowed sum is the checksum it carries (premise)');
    ok(s !== 0, 'while the full-width sum is plainly not zero (premise)');
    const out2 = run(d, rows(wire(D)));
    eq(out2.length, 1, 'Acurite decodes it, which a narrowed sum would have refused as silence');
    eq(out2[0]?.temperature_1_F, -66.8, 'and reads its probe correctly');
  }

  // Fifty-six zeros: a self-consistent frame on paper, thrown out by the zero-sum guard.
  {
    const zeros = new Array(56).fill(0);
    const D = new Uint8Array(7);
    let s = 0; for (let i = 0; i < 6; i++) s += D[i];
    eq(s & 0xff, D[6], 'an all-zero frame satisfies the checksum (premise)');
    // On the air that frame is all ones, since the decoder inverts before reading.
    eq(run(d, rows(new Array(56).fill(1))).length, 0, 'Acurite throws out a row of fifty-six zeros anyway');
    eq(run(d, rows(zeros)).length, 0, 'and a row of fifty-six ones is not a frame either');
  }

  eq(run(d, build({ breakChk: true })).length, 0, 'Acurite rejects a bad checksum');
  eq(run(d, build({ trim: 1 })).length, 0, 'Acurite wants exactly 56 bits');
  {
    // It scans every row and reports the first that works, rather than giving up on the first that does not.
    const bad = build({ breakChk: true }).bb[0];
    const badBits = bytesToBits(bad.slice(0, 7));
    const goodBits = wire(Uint8Array.from([0x5a, 0x06, 0x05, 0x96, 0x08, 0xca, (0x5a + 0x06 + 0x05 + 0x96 + 0x08 + 0xca) & 0xff]));
    eq(run(d, rows(new Array(30).fill(0), goodBits)).length, 1, 'Acurite skips a short row and reads the next');
    ok(badBits.length === 56, 'the rejected row is full length (premise)');
  }
}

// ===========================================================================
// Thermor DG950 (254): the one complete off-air capture
// ===========================================================================
{
  const d = dev(254);
  const CAPTURE = '0000000000000000000000000c3adfe6b1f0f92eff258f4fe1f0f8';
  const capBits = bitsFromHex(CAPTURE);

  /*
   * The station sends thirteen separate nine-bit bursts after 96 sync pulses. The recording holds all of it
   * end to end, and the source separately prints the same thirteen bursts as the flex decoder splits them —
   * so the two forms can be checked against each other before either is fed to the decoder.
   */
  const FLEX = ['0c0', '758', '7f8', '358', '1f0', '1f0', '4b8', '7f8', '258', '1e8', '3f8', '0f8', '0f8'];
  const rowsFromCapture = FLEX.map((_, i) => capBits.slice(96 + i * 9, 96 + i * 9 + 9));
  FLEX.forEach((hex, i) => {
    eq(rowsFromCapture[i].join(''), bitsFromHex(hex, 9).join(''),
      `DG950 burst ${i} of the recording matches the flex decoder's ${hex}`);
    eq(rowsFromCapture[i][0], 0, `DG950 burst ${i} begins with the mandatory zero start bit`);
  });
  eq(capBits.slice(0, 96).some(b => b), false, 'the recording opens with 96 sync bits (premise)');

  // The reflected bytes the decoder works from, and each of the four checks the frame carries.
  const B = Uint8Array.from(rowsFromCapture.map(r => rev8ref(bitsToBytes(r.slice(1))[0])));
  eq([...B].map(x => x.toString(16).padStart(2, '0')).join(' '),
    '18 d7 ff d6 7c 7c e9 ff d2 bc fe f8 f8', 'DG950 reflected frame');
  eq(((B[1] + B[10]) & 0xff) + 1, B[3], 'DG950 temperature check byte, computed independently');
  eq(~B[2] & 0xff, (~B[12] & 0xff) - 7, 'DG950 rain count agrees with its offset copy');
  eq(B[4], B[5], 'DG950 sends its wind direction twice');
  eq((~B[6] + ~B[7] + ~B[8]) & 0xff, ~B[9] & 0xff, 'DG950 wind speed check byte');

  const out = run(d, rows(...rowsFromCapture));
  eq(out.length, 1, 'DG950 decodes its recording');
  eq(out[0]?.id, 231, 'DG950 id');
  eq(out[0]?.temperature_C, 20.9, 'DG950 temperature is an integer and a decimal part, each with its own offset');
  eq(out[0]?.rain_rate_mm_h, 0, 'DG950 rain rate');
  eq(out[0]?.wind_dir_deg, 202, 'DG950 wind direction through its own sixteen-point table');
  eq(out[0]?.wind_avg_km_h, 3.3, 'DG950 wind speed');
  eq(out[0]?.pairing, 0, 'DG950 marks this as an ordinary reading');
  eq(out[0]?.mic, 'CHECKSUM', 'DG950 claims a checksum');

  /** Thirteen bursts built from thirteen reflected bytes, with the checks filled in. */
  const seal = (b) => {
    b[3] = (((b[1] + b[10]) & 0xff) + 1) & 0xff;
    b[12] = ~(((~b[2] & 0xff) + 7) & 0xff) & 0xff;
    b[9] = ~((~b[6] + ~b[7] + ~b[8]) & 0xff) & 0xff;
    return b;
  };
  const emit = (b) => rows(...[...b].map(v => [0, ...bytesToBits([rev8ref(v)])]));

  // A rebuilt frame, checked against the recording first: a builder that cannot reproduce known-good radio
  // is no evidence for anything it produces afterwards.
  eq(run(d, emit(seal(Uint8Array.from(B))))[0]?.temperature_C, 20.9, 'the transmit-side builder reproduces the recording');

  {
    const b = seal(Uint8Array.from([0xe7, 195 - 12, 0xff, 0, 0x7e, 0x7e, 0xf0, 0xff, 0xd2, 0, 245 + 5, 0, 0]));
    const out2 = run(d, emit(b));
    eq(out2.length, 1, 'DG950 decodes a rebuilt frame');
    eq(out2[0]?.temperature_C, -11.5, 'DG950 reads below zero: an integer part of -12 plus half a degree');
    eq(out2[0]?.wind_dir_deg, 270, 'DG950 wind direction from a rebuilt frame');
  }

  /*
   * Every entry of the sixteen-point table. The codes are not in compass order and the table is hand
   * transcribed, so a single wrong constant would otherwise sit there unnoticed. Code 13 is due north,
   * which also proves a direction of zero degrees is reported rather than mistaken for "absent".
   */
  {
    const TABLE = [157, 45, 135, 67, 180, 22, 112, 90, 225, 337, 247, 315, 202, 0, 270, 292];
    TABLE.forEach((deg, code) => {
      const b = seal(Uint8Array.from([0xe7, 215, 0xff, 0, 0x70 | code, 0x70 | code, 0xe9, 0xff, 0xd2, 0, 254, 0, 0]));
      eq(run(d, emit(b))[0]?.wind_dir_deg, deg, `DG950 direction code ${code} reads ${deg} degrees`);
    });
  }

  // The pairing broadcast, which carries a new id and nothing else.
  {
    const b = new Uint8Array(13);
    b[0] = 0xff;
    for (const i of [1, 2, 4, 5, 6, 7, 8, 10]) b[i] = 0xe7;
    const out2 = run(d, emit(b));
    eq(out2.length, 1, 'DG950 recognizes a pairing broadcast');
    eq(out2[0]?.pairing, 1, 'and marks it as pairing');
    eq(out2[0]?.id, 0x18, 'and reports the new id');
    eq(out2[0]?.temperature_C, undefined, 'a pairing broadcast carries no reading');
  }

  // Wind and direction are each optional, signaled by an all-ones field.
  {
    const b = seal(Uint8Array.from([0xe7, 215, 0xff, 0, 0xff, 0xff, 0xe9, 0xff, 0xd2, 0, 254, 0, 0]));
    const out2 = run(d, emit(b));
    eq(out2.length, 1, 'DG950 decodes with no wind direction');
    eq(out2[0]?.wind_dir_deg, undefined, 'an all-ones direction field means the vane has nothing to say');
    eq(out2[0]?.wind_avg_km_h, 3.3, 'while the anemometer still reports');
  }
  {
    const b = seal(Uint8Array.from([0xe7, 215, 0xff, 0, 0x7c, 0x7c, 0xe9, 0xff, 0xff, 0, 254, 0, 0]));
    const out2 = run(d, emit(b));
    eq(out2.length, 1, 'DG950 decodes with no wind speed');
    eq(out2[0]?.wind_avg_km_h, undefined, 'an all-ones coefficient byte means no speed is reported');
    eq(out2[0]?.wind_dir_deg, 202, 'while the vane still reports');
  }

  /*
   * The blind spot in the temperature check, kept because upstream has it: the sum is narrowed to a byte and
   * then one is added, so a sum of 0xff demands a check byte of 0x100 and no frame can ever satisfy it.
   */
  {
    const b = Uint8Array.from([0xe7, 0x01, 0xff, 0, 0x7c, 0x7c, 0xe9, 0xff, 0xd2, 0, 0xfe, 0, 0]);
    eq((b[1] + b[10]) & 0xff, 0xff, 'this frame\'s temperature sum narrows to 0xff (premise)');
    seal(b);
    eq(b[3], 0x00, 'so the check byte wraps to zero (premise)');
    eq(run(d, emit(b)).length, 0, 'and DG950 can never confirm it, exactly as upstream cannot');
  }

  // Rejections, one per check.
  {
    const base = () => seal(Uint8Array.from(B));
    const bust = (i, v) => { const b = base(); b[i] = v; return b; };
    eq(run(d, emit(bust(3, (B[3] + 1) & 0xff))).length, 0, 'DG950 rejects a broken temperature check');
    eq(run(d, emit(bust(12, (B[12] ^ 0x01)))).length, 0, 'DG950 rejects a rain count that disagrees with its copy');
    eq(run(d, emit(bust(5, 0x7d))).length, 0, 'DG950 rejects a wind direction whose two copies differ');
    eq(run(d, emit(bust(9, (B[9] ^ 0x01)))).length, 0, 'DG950 rejects a broken wind check');

    const twelve = [...B].slice(0, 12).map(v => [0, ...bytesToBits([rev8ref(v)])]);
    eq(run(d, rows(...twelve)).length, 0, 'DG950 wants exactly thirteen bursts');

    const short = [...B].map(v => [0, ...bytesToBits([rev8ref(v)])]);
    short[4] = short[4].slice(0, 8);
    eq(run(d, rows(...short)).length, 0, 'DG950 wants every burst to be nine bits');

    const started = [...B].map(v => [0, ...bytesToBits([rev8ref(v)])]);
    started[2] = [1, ...started[2].slice(1)];
    eq(run(d, rows(...started)).length, 0, 'DG950 rejects a burst whose start bit is not zero');
  }
}

// ===========================================================================
// Bresser ST1005H (268): the documented bit rows
// ===========================================================================
{
  const d = dev(268);
  // The source prints each row already grouped, with the reading its display showed beside it.
  const ROWS = [
    ['0 01111101 0 0 00 000010110001 1000110 110100', 125, 1, 0, 17.7, 70],
    ['0 01111101 0 1 00 000010110011 1001001 110001', 125, 1, 1, 17.9, 73],
    ['0 01101010 0 0 00 000011000101 1101110 111010', 106, 1, 0, 19.7, 110],
    ['0 01101010 0 0 00 000011010011 1011111 111001', 106, 1, 0, 21.1, 95],
    ['0 11000010 0 1 00 111101011100 1010011 000010', 194, 1, 1, -16.4, 83],
    ['0 11000010 0 1 00 111101110100 1001110 000001', 194, 1, 1, -14.0, 78],
    ['0 11000010 0 1 00 111110100010 1101110 000110', 194, 1, 1, -9.4, 110],
    ['0 11000010 0 1 00 000000001101 1011101 110100', 194, 1, 1, 1.3, 93],
    ['0 11110000 0 0 00 000010011100 1010010 110010', 240, 1, 0, 15.6, 82],
    ['0 11110000 0 1 01 000010011100 1010010 110111', 240, 2, 1, 15.6, 82],
    ['0 11110000 0 1 10 000010011100 1010010 111000', 240, 3, 1, 15.6, 82],
    ['0 01101010 0 1 00 000010101011 1000110 111101', 106, 1, 1, 17.1, 70],
    ['0 11000010 0 0 00 000001010010 1101110 101110', 194, 1, 0, 8.2, 110],
  ];

  for (const [bin, id, ch, btn, tc, hum] of ROWS) {
    const bits = binToBits(bin);
    eq(bits.length, 38, `Bresser row for ${tc} C is 38 bits (premise)`);

    // The checksum, computed here from the layout rather than taken from the decoder.
    const row = bitsToBytes(bits);
    const msg = bitsToBytes(bits.slice(1, 33)); msg[3] &= 0xfe;
    let s = 0; for (let i = 0; i < 4; i++) s += (msg[i] >> 4) + (msg[i] & 0x0f);
    eq(row[4] >> 2, s & 0x3f, `Bresser ${tc} C row satisfies its own six-bit nibble sum`);

    const out = run(d, rep(bits, 3));
    eq(out.length, 1, `Bresser decodes the ${tc} C row`);
    eq(out[0]?.id, id, `Bresser id from the ${tc} C row`);
    eq(out[0]?.channel, ch, `Bresser channel from the ${tc} C row`);
    eq(out[0]?.button, btn, `Bresser button flag from the ${tc} C row`);
    eq(out[0]?.temperature_C, tc, `Bresser temperature ${tc} C, as the display showed it`);
    eq(out[0]?.humidity, hum, `Bresser humidity from the ${tc} C row`);
    eq(out[0]?.battery_ok, 1, `Bresser battery from the ${tc} C row`);
  }

  // The three rows the display showed as "HH" all carry 110, which is the sensor's over-range value.
  ok(ROWS.filter(r => r[5] === 110).length === 3, 'three documented rows read above the display\'s 95% limit (premise)');

  // The sign really does come from the top-aligned shift, not from a comparison.
  {
    const bits = binToBits(ROWS[4][0]);
    const msg = bitsToBytes(bits.slice(1, 33)); msg[3] &= 0xfe;
    const twelve = ((msg[1] & 0x0f) << 8) | msg[2];
    eq(twelve, 0xf5c, 'the -16.4 C row carries 0xf5c as twelve bits (premise)');
    eq((twelve << 20) >> 20, -164, 'which as a signed twelve-bit value is -164');
  }

  // Rejections.
  {
    const good = binToBits(ROWS[0][0]);
    eq(run(d, rep(good, 3)).length, 1, 'the intact row decodes (premise)');
    eq(run(d, rep(good, 2)).length, 0, 'Bresser wants three matching rows');

    const lead = [1, ...good.slice(1)];
    eq(run(d, rep(lead, 3)).length, 0, 'Bresser rejects a row whose leading bit is not zero');

    const bad = [...good]; bad[36] ^= 1;               // inside the six checksum bits
    ok(good.join('') !== bad.join(''), 'the corrupted row really differs (premise)');
    eq(run(d, rep(bad, 3)).length, 0, 'Bresser rejects a bad checksum');

    const zeros = new Array(38).fill(0);
    eq(0 & 0x3f, 0, 'an all-zero row satisfies the checksum trivially (premise)');
    eq(run(d, rep(zeros, 3)).length, 0, 'Bresser throws out the all-zero row anyway');

    eq(run(d, rep([...good, 0], 3)).length, 0, 'Bresser rejects a 39-bit row');
  }

  /** Build a row from the transmit side so the sanity limits can be probed. */
  const build = ({ id = 125, battLow = 0, button = 0, channel = 0, tempDecic = 177, humidity = 70 } = {}) => {
    const bits = [0,
      ...bytesToBits([id]),
      battLow, button, (channel >> 1) & 1, channel & 1,
      ...Array.from({ length: 12 }, (_, i) => (tempDecic >> (11 - i)) & 1),
      ...Array.from({ length: 7 }, (_, i) => (humidity >> (6 - i)) & 1),
    ];
    const msg = bitsToBytes([...bits.slice(1), 0]); msg[3] &= 0xfe;
    let s = 0; for (let i = 0; i < 4; i++) s += (msg[i] >> 4) + (msg[i] & 0x0f);
    const chk = s & 0x3f;
    return [...bits, ...Array.from({ length: 6 }, (_, i) => (chk >> (5 - i)) & 1)];
  };
  eq(run(d, rep(build({}), 3))[0]?.temperature_C, 17.7, 'the transmit-side builder reproduces a documented reading');
  eq(run(d, rep(build({ battLow: 1 }), 3))[0]?.battery_ok, 0, 'Bresser reports a low battery');
  {
    const hot = build({ humidity: 127 });
    const row = bitsToBytes(hot);
    const msg = bitsToBytes(hot.slice(1, 33)); msg[3] &= 0xfe;
    let s = 0; for (let i = 0; i < 4; i++) s += (msg[i] >> 4) + (msg[i] & 0x0f);
    eq(row[4] >> 2, s & 0x3f, 'the impossible-humidity frame has a valid checksum (premise)');
    eq(run(d, rep(hot, 3)).length, 0, 'Bresser rejects a humidity above 110 on sanity');
  }
  {
    const cold = build({ tempDecic: -400 & 0xfff });
    eq(run(d, rep(cold, 3)).length, 0, 'Bresser rejects -40.0 C, below the range it is rated for');
    eq(run(d, rep(build({ tempDecic: -300 & 0xfff }), 3))[0]?.temperature_C, -30,
      'while -30.0 C, the edge of that range, still reads');
  }
}

// ===========================================================================
// Oria WA150KM (288): built from the transmit side
// ===========================================================================
{
  const d = dev(288);
  eq(d.priority, 10, 'Oria runs after the Oregon THGR810, as upstream orders it');

  const nib = (m, k) => (k % 2 === 0) ? (m[k >> 1] >> 4) & 0x0f : m[k >> 1] & 0x0f;

  /**
   * Fourteen decoded bytes, turned back into the 227-bit line the sensor puts on the air: reflect each byte,
   * take the checksum over that reflected form the way the sensor does, then Manchester-encode in the
   * G. E. Thomas convention the decoder inverts to reach.
   */
  const build = ({ channel = 0, id = 0x5a, tenths = 3, whole = 21, negative = false,
    msgType = 0xfa20, spare = 0x00, breakChk = false, tail = 0, bits: bitCount = 227 } = {}) => {
    const D = new Uint8Array(14);
    D[0] = D[1] = D[2] = 0xff;
    D[3] = (msgType >> 8) & 0xff;
    D[4] = msgType & 0xff;
    D[5] = (channel << 4);
    D[6] = id;
    D[7] = (tenths << 4);
    D[8] = ((whole / 10 | 0) << 4) | (whole % 10);    // BCD
    D[9] = negative ? 0x08 : 0x00;
    D[10] = 0x00;
    D[12] = spare;
    D[13] = 0x65;

    const P = Uint8Array.from([...D].map(rev8ref));
    let s = 0; for (let i = 0; i < 15; i++) s += refl4ref(nib(P, 7 + i));
    const chk = (s & 0xff) ^ (breakChk ? 0xff : 0x00);
    P[11] = rev8ref(chk);                             // the nibble-reflected form the frame carries

    // Each payload bit becomes a pair; the decoder inverts before reading, so the pair goes out (v, ~v).
    const line = [];
    for (const v of [...bytesToBits(P), tail & 1]) { line.push(v); line.push(v ^ 1); }
    line.push(1);                                     // the odd bit that stops the Manchester run
    return { bb: rows(line.slice(0, bitCount)), D, P, chk };
  };

  {
    const { bb, P, chk } = build({});
    const raw = bb.bb[0];
    eq(bb.bitsPerRow[0], 227, 'the built line is 227 bits (premise)');
    eq(raw[0], 0xaa, 'and opens with the 0xaa warm-up the decoder checks (premise)');
    eq(raw[1], 0xaa, 'second warm-up byte');
    eq(raw[2], 0xaa, 'third warm-up byte');
    eq(raw[27], 0x69, 'and ends with 0x69 — which is the fixed 0x65 terminator seen through the line code');
    eq(P[11], rev8ref(chk), 'the checksum sits in byte 11 of the pre-reflected frame (premise)');
  }
  {
    // The checksum stated on the decoded side: the high nibble of byte 3 plus every nibble of bytes 4 to 10.
    const { D, chk } = build({});
    let alt = D[3] >> 4;
    for (let i = 4; i <= 10; i++) alt += (D[i] >> 4) + (D[i] & 0x0f);
    eq(alt & 0xff, chk, 'the pre-reflected nibble sum equals the decoded frame\'s own nibble sum');
  }

  const out = run(d, build({}).bb);
  eq(out.length, 1, 'Oria decodes a well-formed frame');
  eq(out[0]?.id, 0x5a, 'Oria id');
  eq(out[0]?.channel, 1, 'Oria channel is the wire nibble plus one');
  eq(out[0]?.temperature_C, 21.3, 'Oria temperature is two BCD digits plus a tenths nibble');
  eq(out[0]?.mic, 'CHECKSUM', 'Oria claims a checksum');

  eq(run(d, build({ channel: 2 }).bb)[0]?.channel, 3, 'Oria channel 3');
  eq(run(d, build({ whole: 4, tenths: 7 }).bb)[0]?.temperature_C, 4.7, 'Oria reads a single-digit temperature');
  eq(run(d, build({ whole: 18, tenths: 2, negative: true }).bb)[0]?.temperature_C, -18.2,
    'Oria negates on its sign bit rather than by two\'s complement');
  eq(run(d, build({ msgType: 0xfa28 }).bb)[0]?.id, 0x5a, 'Oria ignores the alternating message type');

  /*
   * The layout comment places the sign at "bit 4" while the code tests 0x08, which is bit 3. The code is what
   * ships, and both halves of that are worth pinning.
   */
  {
    const bit4 = build({ whole: 18, tenths: 2 });
    bit4.D[9] = 0x10;                                  // what the comment's wording would suggest
    const P = Uint8Array.from([...bit4.D].map(rev8ref));
    let s = 0; for (let i = 0; i < 15; i++) s += refl4ref(nib(P, 7 + i));
    P[11] = rev8ref(s & 0xff);
    const line = [];
    for (const v of [...bytesToBits(P), 0]) { line.push(v); line.push(v ^ 1); }
    line.push(1);
    eq(run(d, rows(line.slice(0, 227)))[0]?.temperature_C, 18.2,
      'setting 0x10 does not negate: the code reads 0x08, whatever the layout comment says');
  }

  // Rejections, and the shape of the checksum's reach.
  {
    eq(run(d, build({ breakChk: true }).bb).length, 0, 'Oria rejects a bad checksum');
    eq(run(d, build({ bits: 226 }).bb).length, 0, 'Oria wants exactly 227 bits');

    // A byte inside the covered range breaks it; one outside does not. That is the premise of the range.
    const inside = build({ id: 0x5b });
    eq(run(d, inside.bb).length, 1, 'a different id is still a valid frame (premise)');
    const tampered = build({});
    tampered.bb.bb[0][14] ^= 0x0c;                     // lands in the id, which the checksum covers
    eq(run(d, tampered.bb).length, 0, 'Oria rejects a frame whose covered bytes were altered');
    eq(run(d, build({ spare: 0x5a }).bb)[0]?.temperature_C, 21.3,
      'while byte 12, outside the checksum\'s reach, changes nothing — as upstream describes');

    const warm = build({});
    warm.bb.bb[0][1] = 0x55;
    eq(run(d, warm.bb).length, 0, 'Oria rejects a frame without its 0xaa warm-up');
    const term = build({});
    term.bb.bb[0][27] = 0x96;
    eq(run(d, term.bb).length, 0, 'Oria rejects a frame without its 0x69 terminator');
  }
}

// ===========================================================================
// Thermor A6N 132TX (325): the six documented samples
// ===========================================================================
{
  const d = dev(325);
  const SAMPLES = [
    ['3c 01 7f 3c', 3, 3, 38.3], ['3c 01 88 a5', 3, 3, 39.2], ['3c 01 90 ad', 3, 3, 40.0],
    ['50 01 0c bd', 5, 0, 26.8], ['50 02 03 b5', 5, 0, 51.5], ['4c 01 7f 0c', 4, 3, 38.3],
  ];

  /** The two-part checksum, written out from the source's own prose rather than from the port. */
  const chkRef = (b) => {
    const lo = (b[0] & 0x0f) + (b[1] & 0x0f) + (b[2] & 0x0f);
    const hiSum = (b[0] >> 4) + (b[1] >> 4) + (b[2] >> 4);
    const id = (b[0] >> 4) & 0x0f;
    const hi = id === 4
      ? ((hiSum + (lo >> 4)) & 1)
      : (((parityRef(b[0] & 0x0f) ^ parityRef(b[1] & 0x0f) ^ parityRef(b[2])) << 3) | ((2 + (hiSum & 1)) ^ (lo >> 4)));
    return ((hi << 4) | (lo & 0x0f)) & 0xff;
  };

  for (const [hex, id, ch, tc] of SAMPLES) {
    const b = hexToBytes(hex);
    eq(chkRef(b), b[3], `A6N sample ${hex} satisfies the checksum described in its own file`);

    const out = run(d, rep(bitsFromHex(hex, 32), 5));
    eq(out.length, 1, `A6N decodes sample ${hex}`);
    eq(out[0]?.id, id, `A6N id from ${hex}`);
    eq(out[0]?.channel, ch, `A6N channel from ${hex}`);
    eq(out[0]?.temperature_C, tc, `A6N temperature ${tc} C from ${hex}`);
    eq(out[0]?.mic, 'CHECKSUM', `A6N claims a checksum for ${hex}`);
  }

  // Both checksum shapes are exercised by real samples, which is what makes the split rule believable.
  ok(SAMPLES.some(s => s[1] === 4) && SAMPLES.some(s => s[1] !== 4),
    'the samples cover both the id-4 checksum and the other one (premise)');

  // Rejections.
  {
    const good = bitsFromHex('3c 01 7f 3c', 32);
    eq(run(d, rep(good, 5)).length, 1, 'the intact frame decodes (premise)');
    eq(run(d, rep(good, 4)).length, 0, 'A6N wants five matching rows');
    eq(run(d, rep(bitsFromHex('3c 01 7f 3c', 31), 5)).length, 0, 'A6N wants exactly 32 bits');

    const loBad = hexToBytes('3c 01 7f 3d');
    ok((loBad[3] & 0x0f) !== (((loBad[0] & 0xf) + (loBad[1] & 0xf) + (loBad[2] & 0xf)) & 0x0f),
      'the altered frame breaks the low nibble of the checksum (premise)');
    eq(run(d, rep(bitsFromHex('3c 01 7f 3d', 32), 5)).length, 0, 'A6N rejects a bad low nibble');

    const hiBad = hexToBytes('3c 01 7f 4c');
    eq(hiBad[3] & 0x0f, 0x0c, 'the altered frame keeps a valid low nibble (premise)');
    ok(chkRef(hiBad) !== hiBad[3], 'and breaks the high one (premise)');
    eq(run(d, rep(bitsFromHex('3c 01 7f 4c', 32), 5)).length, 0, 'A6N rejects a bad high nibble');

    // On id 4 the high nibble is a single bit, so anything in the three bits above it is wrong.
    const id4 = hexToBytes('4c 01 7f 8c');
    eq(id4[3] & 0x0f, 0x0c, 'the id-4 frame keeps a valid low nibble (premise)');
    eq(id4[3] >> 4, 0x08, 'and sets a bit that must always be zero (premise)');
    eq(run(d, rep(bitsFromHex('4c 01 7f 8c', 32), 5)).length, 0, 'A6N rejects a set bit above the id-4 answer bit');

    // Sanity runs before the checksum, so an absurd temperature never reaches it.
    const hot = new Uint8Array([0x30, 0x27, 0x11, 0x00]);
    hot[3] = chkRef(hot);
    eq((hot[1] << 8) | hot[2], 0x2711, 'the over-range frame reads 10001 (premise)');
    ok(((hot[1] << 8) | hot[2]) > 2500, 'which is past the sensor\'s 250 C limit (premise)');
    eq(chkRef(hot), hot[3], 'and it carries a valid checksum (premise)');
    eq(run(d, rep(bytesToBits(hot), 5)).length, 0, 'A6N rejects it on temperature range anyway');
  }
}

// ===========================================================================
// Auriol HG04641A (357): built from the transmit side
// ===========================================================================
{
  const d = dev(357);

  /** Nine nibbles: two bytes of id, a flags nibble, three nibbles of signed temperature, a nibble of sum. */
  const build = ({ id = 0x8c41, flags = 0x1, tempDecic = 213, breakChk = false, bits: n = 36 } = {}) => {
    const b = new Uint8Array(5);
    b[0] = (id >> 8) & 0xff;
    b[1] = id & 0xff;
    b[2] = ((flags & 0x0f) << 4) | ((tempDecic >> 8) & 0x0f);
    b[3] = tempDecic & 0xff;
    let s = 0; for (let i = 0; i < 4; i++) s += (b[i] >> 4) + (b[i] & 0x0f);
    b[4] = (((s & 0x0f) ^ (breakChk ? 0x0f : 0x00)) << 4);
    return bytesToBits(b).slice(0, n);
  };

  const out = run(d, rep(build({}), 3));
  eq(out.length, 1, 'Auriol decodes a well-formed frame');
  eq(out[0]?.id, 0x8c41, 'Auriol id');
  eq(out[0]?.battery_ok, 1, 'Auriol battery');
  eq(out[0]?.temperature_C, 21.3, 'Auriol temperature');
  eq(out[0]?.mic, 'CHECKSUM', 'Auriol claims a checksum');

  // The freezer reading the source says its sign handling was confirmed against.
  eq(run(d, rep(build({ tempDecic: -141 & 0xfff }), 3))[0]?.temperature_C, -14.1,
    'Auriol reads the documented -14.1 C freezer test, so the top-aligned sign extension holds');
  eq(run(d, rep(build({ tempDecic: -1 & 0xfff }), 3))[0]?.temperature_C, -0.1, 'Auriol reads just below zero');
  eq(run(d, rep(build({ tempDecic: 0 }), 3))[0]?.temperature_C, 0, 'Auriol reads exactly zero');
  eq(run(d, rep(build({ flags: 0x9 }), 3))[0]?.battery_ok, 0, 'Auriol reports a low battery on flag bit 3');

  // Two full rows plus a truncated third, which is what the source says the sensor actually sends.
  {
    const full = build({});
    eq(run(d, rows(full, full, full.slice(0, 35))).length, 1,
      'Auriol still decodes when the last repeat is one bit short, as its source describes');
    eq(run(d, rows(full, full.slice(0, 35))).length, 0, 'but two rows must actually match');
  }

  // Rejections.
  {
    eq(run(d, rep(build({ breakChk: true }), 3)).length, 0, 'Auriol rejects a bad checksum');
    eq(run(d, rows(build({}))).length, 0, 'Auriol wants the frame repeated');
    eq(run(d, rep(build({ bits: 35 }), 3)).length, 0, 'Auriol wants at least 36 bits');

    // The flags gate, with the premise that the checksum is not what is doing the rejecting.
    for (const [flags, why] of [[0x3, 'bit 1 set'], [0x5, 'bit 2 set'], [0x0, 'bit 0 clear'], [0x8, 'bit 0 clear, battery low']]) {
      const bits = build({ flags });
      const b = bitsToBytes(bits);
      let s = 0; for (let i = 0; i < 4; i++) s += (b[i] >> 4) + (b[i] & 0x0f);
      eq(s & 0x0f, b[4] >> 4, `the ${why} frame carries a valid checksum (premise)`);
      eq(run(d, rep(bits, 3)).length, 0, `Auriol rejects a flags nibble with ${why}`);
    }

    // The temperature range, likewise reached only after a valid checksum.
    for (const [decic, why] of [[-500, 'below -40 C'], [700, 'above 60 C']]) {
      const bits = build({ tempDecic: decic & 0xfff });
      const b = bitsToBytes(bits);
      let s = 0; for (let i = 0; i < 4; i++) s += (b[i] >> 4) + (b[i] & 0x0f);
      eq(s & 0x0f, b[4] >> 4, `the ${why} frame carries a valid checksum (premise)`);
      eq(run(d, rep(bits, 3)).length, 0, `Auriol rejects a reading ${why}`);
    }
    eq(run(d, rep(build({ tempDecic: -400 & 0xfff }), 3))[0]?.temperature_C, -40,
      'while -40.0 C, the edge of the accepted range, still reads');
    eq(run(d, rep(build({ tempDecic: 600 }), 3))[0]?.temperature_C, 60, 'and so does 60.0 C at the other end');
  }
}

// ===========================================================================
// The registrations themselves
// ===========================================================================
{
  for (const num of [133, 150, 194, 197, 254, 268, 288, 325, 357]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));

  // Only Klimalogg is flagged doubtful in this batch, and only because upstream flags it.
  const mine = [133, 150, 194, 197, 254, 268, 288, 325, 357].map(dev);
  eq(mine.filter(d => d.disabled).map(d => d.num).join(','), '150', 'exactly one of the nine mirrors a disabled flag');
  eq(mine.filter(d => d.priority).map(d => d.num).join(','), '288', 'and exactly one carries a priority');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
