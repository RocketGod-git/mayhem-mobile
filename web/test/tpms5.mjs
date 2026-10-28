/**
 * The last of the tire pressure sensors.
 *
 * This batch is unusually well evidenced. rtl_433 ships real captures for six of these eight protocols, and for
 * BMW it ships five of them together with the bytes they are known to decode to. Those are used directly:
 * the raw capture goes in, and the documented values come out. Nothing about that is circular.
 *
 * Where a capture is given already decoded rather than as raw radio — BMW Gen2/Gen3, SmarTire — the documented
 * bytes are re-encoded through the line code the sensor uses and fed back in, so the frame content is still
 * the manufacturer's rather than this file's invention. Only Mercedes, Jeep and Honda are built from scratch.
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
/** rtl_433 writes its codes as {bits}hexdigits. */
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
/** Our Manchester decoder emits the second half of each pair. */
const manchester = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };
/** Differential Manchester: the first half always flips, and the bit says whether the level then holds. */
const dmc = (bits, prev = 0) => {
  const out = [];
  for (const b of bits) { const h1 = 1 - prev; const h2 = b ? h1 : 1 - h1; out.push(h1, h2); prev = h2; }
  return out;
};
const inv = (bits) => bits.map(b => b ^ 1);
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map(x => parseInt(x, 16)));

console.log('BMW, Chrysler, Aston Martin, Mercedes, Jeep and Honda');

// ---- BMW Gen4/Gen5 and the Audi alert (252): five real captures from rtl_433 ----
{
  // The two BMW captures, with the bytes that project documents them as decoding to.
  const BMW = [
    { hex: '555554b2aab4b2b552acb4d332accb32b552aaacd334d32ad334', n: 207, want: '0323e136a14a3e016b686b' },
    { hex: '555554b2aab4b2b552acb4d332acb4cab54caaacd4cad32b4b55e', n: 211, want: '0323e136a1343d017468cf' },
  ];
  for (const [i, cap] of BMW.entries()) {
    const d = run(dev(252), rowBits(bitsFromHex(cap.hex, cap.n)))[0];
    ok(!!d, `BMW real capture ${i + 1} decodes`, JSON.stringify(d));
    if (d) {
      const w = hexToBytes(cap.want);
      eq(d.model, 'BMW-GEN5', `  BMW capture ${i + 1} is the eleven byte frame`);
      eq(d.msg, cap.want, `  BMW capture ${i + 1} decodes to the documented bytes`);
      eq(d.id, '23e136a1', `  BMW capture ${i + 1} id`);
      eq(d.brand, 0x03, `  BMW capture ${i + 1} brand is HUF/Beru`);
      eq(d.pressure_kPa, Math.round(w[5] * 2.45 * 10) / 10, `  BMW capture ${i + 1} pressure`);
      eq(d.temperature_C, w[6] - 52, `  BMW capture ${i + 1} temperature is offset by fifty two`);
      eq(d.mic, 'CRC', `  BMW capture ${i + 1} reports its check`);
    }
  }

  // The three Audi pressure alerts: the same protocol, three bytes shorter.
  const AUDI = [
    { hex: '2aaaaa5955555955a5556a65666a56aa65a65999fc', n: 166 },
    { hex: '2aaaaa5955555955a5556a65666a56aa65a65999f8', n: 165 },
    { hex: '5555552caaaaacaad2aab532b3352b5532d32cccfe', n: 167 },
  ];
  // The three captures are one transmission recorded three ways - the last is a bit out of step, its run-in
  // landing at bit seventeen rather than sixteen - and all decode alike.
  //
  // The byte row rtl_433 documents beside these captures, 0020c07457364c23, is NOT what they contain. Both
  // rows pass the same CRC and carry the same sensor id, so that row is a real frame from this sensor, just a
  // different message than the captures record. Both are asserted so the discrepancy stays visible rather
  // than being quietly written out.
  const AUDI_ACTUAL = '0020c074571f4d2a';
  ok(U.crc8(hexToBytes(AUDI_ACTUAL), 8, 0x2f, 0xaa) === 0,
    'the frame the Audi captures actually carry passes the CRC');
  ok(U.crc8(hexToBytes('0020c07457364c23'), 8, 0x2f, 0xaa) === 0,
    'and so does the different frame documented beside them');

  for (const [i, cap] of AUDI.entries()) {
    const d = run(dev(252), rowBits(bitsFromHex(cap.hex, cap.n)))[0];
    ok(!!d, `Audi pressure alert capture ${i + 1} decodes`, JSON.stringify(d));
    if (d) {
      eq(d.model, 'Audi-PressureAlert', `  Audi capture ${i + 1} is the eight byte frame`);
      eq(d.msg, AUDI_ACTUAL, `  Audi capture ${i + 1} decodes to the bytes it actually carries`);
      eq(d.id, '20c07457', `  Audi capture ${i + 1} id`);
      eq(d.brand, 0x00, `  Audi capture ${i + 1} brand`);
      eq(d.pressure_kPa, Math.round(0x1f * 2.45 * 10) / 10, `  Audi capture ${i + 1} pressure`);
      eq(d.temperature_C, 0x4d - 52, `  Audi capture ${i + 1} temperature is offset by fifty two`);
      ok(typeof d.alert === 'string', `  Audi capture ${i + 1} is reported as an alert, not a routine reading`);
      ok(d.flags1 === undefined, `  Audi capture ${i + 1} has no flag bytes to report`);
    }
  }

  const broken = bitsFromHex(BMW[0].hex, 207); broken[80] ^= 1;
  ok(!run(dev(252), rowBits(broken))[0], '  BMW rejects a capture with a flipped bit');
}

// ---- BMW Gen2/Gen3 (257): documented frames, re-encoded through differential Manchester ----
{
  // Gen3, from the flex decoder output rtl_433 records: {89}1c50f1758545f8020373428
  const gen3 = hexToBytes('1c50f1758545f802037342');
  ok(U.crc16(gen3, 11, 0x1021, 0x0000) === 0, 'the documented BMW Gen3 frame passes its own CRC-16');
  const row3 = rowBits(pad([...bytesToBits([0xcc, 0xcd]), ...dmc(bytesToBits(gen3))], 240));
  const d3 = run(dev(257), row3)[0];
  ok(!!d3, 'BMW Gen3 decodes', JSON.stringify(d3));
  if (d3) {
    eq(d3.model, 'BMW-GEN3', '  Gen3 is the eleven byte frame');
    eq(d3.id, '475066741', '  Gen3 id matches the documented decimal value');
    eq(d3.pressure_kPa, Math.round((0x85 - 43) * 2.5 * 10) / 10, '  Gen3 pressure');
    eq(d3.temperature_C, 0x45 - 40, '  Gen3 temperature is offset by forty');
    eq(d3.flags3, 0x03, '  Gen3 carries a third flag byte');
  }

  // Gen2, one byte shorter and with the CRC one byte earlier: 78 34 a9 7e 90 3c 80 51 6a 6e
  const gen2 = hexToBytes('78 34 a9 7e 90 3c 80 51 6a 6e'.replace(/ /g, ''));
  ok(U.crc16(gen2, 10, 0x1021, 0x0000) === 0, 'the documented BMW Gen2 frame passes its own CRC-16');
  const row2 = rowBits(pad([...bytesToBits([0xcc, 0xcd]), ...dmc(pad(bytesToBits(gen2), 81))], 240));
  const d2 = run(dev(257), row2)[0];
  ok(!!d2, 'BMW Gen2 decodes', JSON.stringify(d2));
  if (d2) {
    eq(d2.model, 'BMW-GEN2', '  Gen2 is told apart by being one byte shorter');
    eq(d2.pressure_kPa, Math.round((0x90 - 43) * 2.5 * 10) / 10, '  Gen2 pressure');
    eq(d2.temperature_C, 0x3c - 40, '  Gen2 temperature');
    ok(d2.flags3 === undefined, '  Gen2 has no third flag byte');
  }
}

// ---- TRW (298 and 299): the same real frame, sent on-off keyed and frequency shifted ----
{
  // Sample OOK: 00 01 | 5c 3e 52 85 2e 61 53 4b 0e 52 | 4
  // Sample FSK: 7f ff | 5c 3e 52 85 2e 62 53 4b 0e 68 | 4
  const build = (preamble, body) => {
    // The whole row may not exceed ninety-eight bits, so only two bits of the trailing nibble arrive - which
    // is still enough for the top nibble of the last byte to read as four.
    const bits = [...bytesToBits(preamble), ...bytesToBits(hexToBytes(body)), 0, 1];
    return rowBits(bits.slice(0, 98));
  };

  const ookBody = '5c3e52852e61534b0e52';
  ok(U.crc8(hexToBytes(ookBody), 10, 0x07, 0x00) === 0, 'the documented TRW OOK frame passes its own CRC');
  const dOok = run(dev(298), build([0x00, 0x01], ookBody))[0];
  ok(!!dOok, 'TRW on-off keyed decodes', JSON.stringify(dOok));
  if (dOok) {
    eq(dOok.model, 'TRW', '  TRW model');
    eq(dOok.mode, '5c', '  TRW mode byte');
    eq(dOok.id, '3e52852e', '  TRW id');
    eq(dOok.pressure_PSI, Math.round(0x53 * 0.4 * 10) / 10, '  TRW pressure counts two fifths of a pound');
    eq(dOok.temperature_C, 0x4b - 50, '  TRW temperature is offset by fifty');
    eq(dOok.motion_status, 'Parked', '  TRW reports the car as parked');
    eq(dOok.oem_model, 'OEM', '  TRW reports a genuine part rather than a copy');
  }

  const fskBody = '5c3e52852e62534b0e68';
  ok(U.crc8(hexToBytes(fskBody), 10, 0x07, 0x00) === 0, 'the documented TRW FSK frame passes its own CRC');
  const dFsk = run(dev(299), build([0x7f, 0xff], fskBody))[0];
  ok(!!dFsk, 'TRW frequency shifted decodes', JSON.stringify(dFsk));
  if (dFsk) {
    eq(dFsk.id, dOok?.id, '  the two carry the same sensor id');
    eq(dFsk.seq_num, 0x2, '  TRW sequence number');
  }

  // Each must ignore the other polarity's run-in.
  ok(!run(dev(298), build([0x7f, 0xff], ookBody))[0], '  the on-off keyed decoder ignores the other run-in');
  const bad = ookBody.slice(0, 6) + '00' + ookBody.slice(8);
  ok(!run(dev(298), build([0x00, 0x01], bad))[0], '  TRW rejects a frame failing its CRC');
}

// ---- SmarTire (343): the documented frame, re-encoded through differential Manchester ----
{
  const sample = hexToBytes('283fffff00fa');
  ok(U.crc7(sample, 6, 0x45, 0x6f) === 0, 'the documented SmarTire frame passes its own CRC-7');
  const row = rowBits(pad([...bytesToBits([0x32, 0xb4]), ...dmc(bytesToBits(sample))], 200));
  const d = run(dev(343), row)[0];
  ok(!!d, 'SmarTire decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'SmarTire-AM', '  SmarTire model');
    eq(d.id, String(((0x3f & 0x3f) << 16) | (0xff << 8) | 0xff), '  SmarTire id is twenty-two bits');
    eq(d.pressure_kPa, 0, '  the documented sample is a pressure message');
    ok(d.temperature_C === undefined, '  and so carries no temperature at all');
  }

  // A temperature message: the same frame with the type bits set to one, and its own CRC.
  const t = Uint8Array.from([40 + 25, 0x40 | 0x3f, 0xff, 0xff, 0x00, 0x00]);
  t[5] = 0;
  // crc7 leaves its result in the top seven bits of the last byte.
  t[5] = U.crc7(t, 5, 0x45, 0x6f) << 1;
  const dt = run(dev(343), rowBits(pad([...bytesToBits([0x32, 0xb4]), ...dmc(bytesToBits(t))], 200)))[0];
  ok(!!dt, 'SmarTire decodes a temperature message', JSON.stringify(dt));
  if (dt) {
    eq(dt.temperature_C, 25, '  SmarTire temperature is offset by forty');
    ok(dt.pressure_kPa === undefined, '  and a temperature message carries no pressure');
  }
}

// ---- Mercedes-Benz Sprinter (365) ----
{
  const build = (state, press, temp) => {
    const b = new Uint8Array(10);
    b[0] = state;
    b[1] = 0xa1; b[2] = 0xb2; b[3] = 0xc3; b[4] = 0xd4;
    b[5] = press; b[6] = temp;
    b[7] = (0x02 << 5) | 9;                        // flags and a message counter
    b[8] = 0xe9;
    b[9] = U.crc8(b, 9, 0x2f, 0xaa);
    return rowBits(pad([...bytesToBits([0x00, 0x20]).slice(0, 12), ...bytesToBits(b)], 120));
  };

  const d = run(dev(365), build(0x83, 96, 71))[0];
  ok(!!d, 'Mercedes Sprinter decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'MercedesBenz-Sprinter', '  Sprinter model');
    eq(d.id, 'a1b2c3d4', '  Sprinter id');
    eq(d.pressure_PSI, Math.round(96 / 2.75 * 10) / 10, '  Sprinter pressure');
    eq(d.temperature_C, 20, '  Sprinter temperature is offset by fifty one');
    eq(d.counter, 9, '  Sprinter message counter');
    eq(d.flags1, 2, '  Sprinter flags sit above the counter');
  }

  ok(!!run(dev(365), build(0xa3, 96, 71))[0], '  Sprinter accepts the moving state byte too');
  // Any other first byte is not this sensor, even with a valid CRC.
  ok(!run(dev(365), build(0x84, 96, 71))[0], '  Sprinter refuses an unknown state byte despite a good CRC');
}

// ---- Jeep (380) ----
{
  const build = (press, temp) => {
    const b = new Uint8Array(10);
    b[0] = 0x5a;                                   // state, deliberately outside the checksum
    b[1] = 0xde; b[2] = 0xad; b[3] = 0xbe; b[4] = 0xef;
    b[5] = 0x37; b[6] = press; b[7] = temp; b[8] = 0x44;
    let x = 0;
    for (let i = 1; i <= 8; i++) x ^= b[i];
    b[9] = x;                                      // closes the exclusive-or over bytes one to nine
    const wanted = [...bytesToBits([0xaa, 0xa9]), ...manchester(bytesToBits(b))];
    return rowBits(inv(pad(wanted, 400)));
  };

  const d = run(dev(380), build(80, 70))[0];
  ok(!!d, 'Jeep decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Jeep', '  Jeep model');
    eq(d.id, 'deadbeef', '  Jeep id');
    eq(d.state, '5a', '  Jeep state byte, which its checksum does not cover');
    eq(d.pressure_kPa, Math.round(80 * 2.728), '  Jeep pressure');
    eq(d.temperature_C, 20, '  Jeep temperature is offset by fifty');
    eq(d.flags, 3, '  Jeep flags');
    eq(d.repeat, 7, '  Jeep repeat counter');
  }

  ok(dev(380).disabled === true, '  Jeep is flagged doubtful, sharing its frame with the Citroen sensor');
  // A frame with no pressure or no temperature is a receiver artifact, not a reading.
  ok(!run(dev(380), build(0, 70))[0], '  Jeep refuses a frame reporting no pressure at all');
  ok(!run(dev(380), build(80, 0))[0], '  Jeep refuses a frame reporting no temperature at all');
}

// ---- Honda (381) ----
{
  const build = (press) => {
    const b = new Uint8Array(8);
    b[0] = press; b[1] = 85;
    b[2] = 0x12; b[3] = 0x34; b[4] = 0x56; b[5] = 0x78;
    b[6] = 0xe1;
    b[7] = U.crc8(b, 7, 0x07, 0x00);
    // The marker is not part of the Manchester run, so it goes on the row as raw bits.
    return rowBits(pad([...bitsFromHex('dae354').slice(0, 23), ...manchester(bytesToBits(b))], 200));
  };

  const d = run(dev(381), build(165))[0];
  ok(!!d, 'Honda decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Honda-TRW', '  Honda model');
    eq(d.id, '12345678', '  Honda id');
    eq(d.pressure_PSI, Math.round(165 * 0.2 * 10) / 10, '  Honda pressure counts a fifth of a pound');
    eq(d.temperature_C, 35, '  Honda temperature is offset by fifty');
    eq(d.flags, 'e1', '  Honda flags');
  }

  // A pressure in this band belongs to a different TRW board, so this decoder stands aside.
  ok(!run(dev(381), build(30))[0], '  Honda stands aside for the pressure range that is not its own');
  ok(!!run(dev(381), build(0))[0], '  but a reading of exactly zero is still its own');

  // The marker has to be at the very start of the row.
  const shifted = rowBits(pad([0, 0, ...bitsFromHex('dae354').slice(0, 23)], 200));
  ok(!run(dev(381), shifted)[0], '  Honda refuses a marker that is not at the row start');
}

// ---- The registrations themselves ----
{
  for (const num of [252, 257, 298, 299, 343, 365, 380, 381]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
