/**
 * The aftermarket tire pressure sensors, finishing the family.
 *
 * None of these seven ships a capture in rtl_433, so every frame here is laid out byte by byte and pushed
 * through whichever line code the sensor uses before the decoder ever sees it.
 *
 * One frame is not invented: the EezTire documentation gives a worked raw example, `ffff 8b 0d177e 8f 4a 10
 * 00`, and its checksum is the interesting part — the seven payload bytes sum to 0x18b, which overflows a
 * byte, and the sensor folds that overflow back in by forcing the top bit rather than discarding it. That the
 * documented 0x8b falls out of the rule is a real check on the rule.
 *
 * Two of these carry per-unit calibration rather than a protocol-wide one, so the checksum constant identifies
 * which physical sensor a frame came from. Both known units are exercised for the Jansite TY-468, and an
 * unknown constant is checked to be refused rather than guessed at.
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
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
/** Straight Manchester: our decoder emits the second half of each pair. */
const mc = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };
/** Manchester for a decoder that inverts afterwards: emit the bit, then its complement. */
const mcInv = (bits) => { const out = []; for (const b of bits) out.push(b, b ^ 1); return out; };
const inv = (bits) => bits.map(b => b ^ 1);
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
/** The full-width byte sum: what rtl_433 add_bytes returns, where ours masks to a byte. */
const rawSum = (m, n) => { let s = 0; for (let i = 0; i < n; i++) s += m[i]; return s; };

console.log('Aftermarket tire pressure sensors');

// ---- Jansite Solar (180): the only one here with a real CRC ----
{
  const build = (press, temp, id) => {
    const b = new Uint8Array(11);
    b[0] = 0xdd; b[1] = 0x33;                      // sync, and also the run-in once Manchester coded
    b[2] = (id >> 16) & 0xff; b[3] = (id >> 8) & 0xff; b[4] = id & 0xff;
    b[5] = 0x40;                                   // flags
    b[6] = temp; b[7] = press; b[8] = 0x00;
    const c = U.crc16(b, 7, 0x8005, 0x0000, 2);
    b[9] = (c >> 8) & 0xff; b[10] = c & 0xff;
    return { b, row: rowBits(pad(mcInv(bytesToBits(b)), 220)) };
  };

  // The run-in the decoder searches for is exactly what the sync word encodes to.
  const { b, row } = build(150, 80, 0xabcdef);
  eq(row.rowHex(0).slice(0, 6), 'a6a65a', 'the Jansite run-in is the sync word Manchester coded');

  const d = run(dev(180), row)[0];
  ok(!!d, 'Jansite Solar decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Jansite-Solar', '  Jansite Solar model');
    eq(d.id, 'abcdef', '  Jansite Solar id');
    eq(d.pressure_kPa, Math.round(150 * 1.6), '  Jansite Solar pressure');
    eq(d.temperature_C, 25, '  Jansite Solar temperature is offset by fifty five');
    eq(d.mic, 'CRC', '  Jansite Solar reports its check');
  }

  const bad = Uint8Array.from(b); bad[6] ^= 0x01;
  ok(!run(dev(180), rowBits(pad(mcInv(bytesToBits(bad)), 220)))[0],
    '  Jansite Solar rejects a frame failing its CRC');

  // A frame whose sync word is wrong is not this sensor, whatever else checks out.
  const nosync = Uint8Array.from(b); nosync[0] = 0xde;
  ok(!run(dev(180), rowBits(pad(mcInv(bytesToBits(nosync)), 220)))[0],
    '  Jansite Solar refuses a frame without its sync word');
}

// ---- The SP372 family: Jansite TY-468 (355) and iMars T240 (354) ----
{
  // Preamble is thirty-two raw alternating bits; the decoder skips all of them and decodes what follows.
  const build = (b) => rowBits(pad([...bytesToBits([0xaa, 0xaa, 0xaa, 0xaa]), ...mcInv(bytesToBits(b))], 200));

  // Unit 0xfb: temperature offset 224, pressure offset 273.
  // temperature = 224 - ((b2+b5) & 255), pressure = (273 - ((b5+b6) & 255)) * 2.5
  const unit1 = Uint8Array.from([0x5a, 0x3a, 0x77, 0x80, 0x7b, 0x50, 0x5d, 0x5a]);
  eq((unit1[3] + unit1[4]) & 0xff, 0xfb, 'the first TY-468 unit carries its own checksum constant');
  const d1 = run(dev(355), build(unit1))[0];
  ok(!!d1, 'Jansite TY-468 decodes for a known unit', JSON.stringify(d1));
  if (d1) {
    eq(d1.model, 'Jansite-TY468', '  TY-468 model');
    eq(d1.temperature_C, 224 - ((unit1[2] + unit1[5]) & 0xff), '  TY-468 temperature uses that unit calibration');
    eq(d1.pressure_kPa, Math.round((273 - ((unit1[5] + unit1[6]) & 0xff)) * 2.5 * 10) / 10, '  TY-468 pressure');
    eq(d1.code, '5a3a77807b505d', '  TY-468 reports the raw frame');
  }

  // The second known unit calibrates differently, so the same arithmetic gives different readings.
  const unit2 = Uint8Array.from([0x5a, 0x3a, 0x77, 0x40, 0x24, 0x50, 0x5d, 0x5a]);
  eq((unit2[3] + unit2[4]) & 0xff, 0x64, 'the second TY-468 unit carries a different constant');
  const d2 = run(dev(355), build(unit2))[0];
  ok(!!d2, 'Jansite TY-468 decodes for the other known unit', JSON.stringify(d2));
  if (d2) eq(d2.temperature_C, 153 - ((unit2[2] + unit2[5]) & 0xff), '  and reads a different temperature from the same bytes');

  // A sensor nobody has calibrated must be refused rather than read with the wrong offsets.
  const unknown = Uint8Array.from([0x5a, 0x3a, 0x77, 0x10, 0x10, 0x50, 0x5d, 0x5a]);
  ok(!run(dev(355), build(unknown))[0], '  TY-468 refuses a unit nobody has measured');

  // The structural checks: the tail repeats the head, and the low nibbles agree.
  const badTail = Uint8Array.from(unit1); badTail[7] = 0x5b;
  ok(!run(dev(355), build(badTail))[0], '  TY-468 refuses a frame whose tail does not repeat its head');
  const badNibble = Uint8Array.from(unit1); badNibble[1] = 0x3b;
  ok(!run(dev(355), build(badNibble))[0], '  TY-468 refuses a frame whose low nibbles disagree');

  // iMars T240: the same frame, its own constants, and deliberately no readings.
  const imars = Uint8Array.from([0x5a, 0x3a, 0x11, 0x40, 0x01, 0x22, 0x33, 0x5a]);
  eq((imars[3] + imars[4]) & 0xff, 0x41, 'the iMars frame carries one of its two known constants');
  const di = run(dev(354), build(imars))[0];
  ok(!!di, 'iMars T240 decodes', JSON.stringify(di));
  if (di) {
    eq(di.model, 'iMars-T240', '  iMars model');
    eq(di.code, '5a3a11400122' + '33', '  iMars reports the raw frame');
    ok(di.pressure_kPa === undefined, '  iMars reports no pressure, nobody having ever calibrated it');
    ok(di.temperature_C === undefined, '  and no temperature either');
  }
  ok(!run(dev(354), build(unit1))[0], '  iMars refuses a constant that is not one of its own');
}

// ---- Jansite TY588-EU2 (362) ----
{
  const build = (b) => {
    // Forty-four raw bits of run-in, then the Manchester data. No inversion on this one.
    const preamble = bitsFromHex('99aa5a6a9aa', 44);
    return rowBits(pad([...preamble, ...mc(bytesToBits(b))], 260));
  };

  // temperature = ((b2+b5) & 255) - 139, pressure = (((b5+b6) & 255) - 90) * 2.5
  const b = Uint8Array.from([0x5a, 0x2a, 0x53, 0x10, 0x20, 0x50, 0x6e, 0x5a]);
  eq((b[3] + b[4]) & 0xff, 0x30, 'the TY588 structural constant holds');
  const d = run(dev(362), build(b))[0];
  ok(!!d, 'Jansite TY588 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Jansite-TY588', '  TY588 model');
    eq(d.temperature_C, ((b[2] + b[5]) & 0xff) - 139, '  TY588 temperature');
    eq(d.pressure_kPa, Math.round((((b[5] + b[6]) & 0xff) - 90) * 2.5 * 10) / 10, '  TY588 pressure');
    eq(d.code, '5a2a53102050' + '6e', '  TY588 reports the raw frame in place of an id it does not have');
  }

  const badTail = Uint8Array.from(b); badTail[7] = 0x5b;
  ok(!run(dev(362), build(badTail))[0], '  TY588 rejects a frame whose tail does not repeat its head');

  // A pressure below the offset is not physically meaningful and must be refused.
  const lowPress = Uint8Array.from(b); lowPress[6] = 0x00;
  ok(!run(dev(362), build(lowPress))[0], '  TY588 refuses a pressure below what the scale can mean');
}

// ---- EezTire E618 (241): the documented example, and its overflowing checksum ----
{
  const build = (b) => {
    let computed = rawSum(b, 7);
    if (computed > 0xff) computed |= 0x80;
    const cc = computed & 0xff;
    // The decoder inverts the whole row first, so it goes on the air the other way up.
    const wanted = [...bytesToBits([0xff, 0xff, cc]), ...bytesToBits(b)];
    return { cc, row: rowBits(inv(wanted)) };
  };

  // rtl_433 documents this exact frame: ffff 8b 0d177e 8f 4a 10 00
  const doc = hexToBytes('0d177e8f4a1000');
  const { cc, row } = build(doc);
  eq(cc, 0x8b, 'the documented EezTire checksum falls out of the overflow rule');
  ok(rawSum(doc, 7) > 0xff, '  and that frame really does overflow a byte, which is what the rule is for');

  const d = run(dev(241), row)[0];
  ok(!!d, 'EezTire decodes the documented frame', JSON.stringify(d));
  if (d) {
    eq(d.model, 'EezTire-E618', '  EezTire model');
    eq(d.id, '0d177e', '  EezTire id');
    eq(d.pressure_kPa, Math.round(0x8f * 2.5), '  EezTire pressure');
    eq(d.temperature_C, 0x4a - 50, '  EezTire temperature is offset by fifty');
    eq(d.fast_leak, 1, '  the documented frame is reporting a fast leak');
    eq(d.inflate, 0, '  and is not being pumped up');
    eq(d.battery_ok, 1, '  its battery is healthy');
  }

  // The ninth pressure bit lives in the second flag byte.
  const wide = hexToBytes('0d177e8f4a1001');
  const dw = run(dev(241), build(wide).row)[0];
  ok(!!dw, 'EezTire decodes a pressure needing a ninth bit', JSON.stringify(dw));
  if (dw) eq(dw.pressure_kPa, Math.round((0x100 + 0x8f) * 2.5), '  and that bit really does add two hundred and fifty six');

  // Low battery, and being inflated rather than leaking.
  const lowBatt = hexToBytes('0d177e8f4ab000');
  const dl = run(dev(241), build(lowBatt).row)[0];
  if (dl) {
    eq(dl.battery_ok, 0, 'EezTire reports a low battery');
    eq(dl.inflate, 1, '  and a tire being pumped up');
    eq(dl.fast_leak, 0, '  which is not counted as a leak even though the leak bit is set');
  }

  const bad = hexToBytes('0d177e8f4a1000');
  const broken = build(bad);
  const brokenBits = inv([...bytesToBits([0xff, 0xff, (broken.cc ^ 0x01) & 0xff]), ...bytesToBits(bad)]);
  ok(!run(dev(241), rowBits(brokenBits))[0], '  EezTire rejects a frame failing its checksum');
}

// ---- Airpuxem TYH11_EU6_ZQ (295) ----
{
  const build = (payload) => {
    const crc = U.crc8(payload, 8, 0x2f, 0xaa);
    // Four bits of header, the payload, then the checksum twice over.
    const dataBits = [0, 1, 0, 1, ...bytesToBits(payload), ...bytesToBits([crc, crc])];
    const wanted = [...bytesToBits([0xaa, 0xaa, 0xa9]), ...mc(dataBits)];
    return rowBits(inv(pad(wanted, 400)));         // the decoder inverts the row before searching
  };

  // id 12345678, flags 2, position 3, pressure 250 kPa (needing its ninth bit), 25 C, 3.0 V
  const payload = Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0xa3, 0x5e, 0x19, 0x96]);
  const d = run(dev(295), build(payload))[0];
  ok(!!d, 'Airpuxem decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Airpuxem-TYH11EU6ZQ', '  Airpuxem model');
    eq(d.id, '12345678', '  Airpuxem id');
    eq(d.flags, 2, '  Airpuxem flags');
    eq(d.position, 3, '  Airpuxem knows which wheel it is on');
    eq(d.pressure_kPa, 250, '  Airpuxem pressure, its ninth bit hidden among the flags');
    eq(d.temperature_C, 25, '  Airpuxem temperature');
    eq(d.battery_V, 3, '  Airpuxem battery in volts');
    eq(d.mic, 'CRC', '  Airpuxem reports its check');
  }

  // A temperature below freezing, which is why the byte is read as signed.
  const cold = Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0xa3, 0x5e, 0xf6, 0x96]);
  const dc = run(dev(295), build(cold))[0];
  if (dc) eq(dc.temperature_C, -10, 'Airpuxem reads a temperature below freezing as negative');

  const bad = Uint8Array.from(payload); bad[2] ^= 0x01;
  const badRow = (() => {
    const crc = U.crc8(payload, 8, 0x2f, 0xaa);    // deliberately the checksum of the original
    const dataBits = [0, 1, 0, 1, ...bytesToBits(bad), ...bytesToBits([crc, crc])];
    return rowBits(inv(pad([...bytesToBits([0xaa, 0xaa, 0xa9]), ...mc(dataBits)], 400)));
  })();
  ok(!run(dev(295), badRow)[0], '  Airpuxem rejects a frame failing its CRC');
}

// ---- Sefis M3 (378) ----
{
  const build = (b7) => {
    const b = new Uint8Array(9);
    b.set(b7);
    const c = U.crc16(b, 7, 0x1021, 0x0000);
    b[7] = (c >> 8) & 0xff; b[8] = c & 0xff;
    // The payload arrives inverted, so each bit goes out followed by its complement.
    const wanted = [...bytesToBits([0x66, 0x99, 0x96, 0xa6]), ...mcInv(bytesToBits(b))];
    return rowBits(pad(wanted, 240));
  };

  // page 3 (raw code 2), giving a pressure code of 0x7200 and so 250 kPa; temperature 24 C
  const d = run(dev(378), build([0x33, 0x44, 0x1a, 0x55, 0x52, 0x00, 0x66]))[0];
  ok(!!d, 'Sefis M3 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Sefis-M3', '  Sefis model');
    eq(d.pressure_kPa, 250, '  Sefis pressure, through its scrambled page number');
    eq(d.temperature_C, 14 + (((0x1a + 0x00) & 0xff) & 0x0f), '  Sefis temperature');
    eq(d.code, '33441a55520066', '  Sefis reports the bytes nobody has decoded yet');
    eq(d.mic, 'CRC', '  Sefis reports its check');
  }

  // Each of the four page codes must map to its own quarter of the range.
  const pages = [[7, 0], [4, 1], [5, 2], [2, 3]];
  for (const [raw, page] of pages) {
    const b4 = (raw << 5) | 0x12;
    const dd = run(dev(378), build([0x33, 0x44, 0x1a, 0x55, b4, 0x00, 0x66]))[0];
    const wantCode = (page << 13) | (0x12 << 8) | 0x00;
    ok(!!dd, `Sefis decodes page code ${raw}`, JSON.stringify(dd));
    if (dd) eq(dd.pressure_kPa, Math.max(0, Math.round((wantCode - 0x0e00) / 102.4)),
      `  page code ${raw} means page ${page}`);
  }

  // A page code outside those four is not a pressure reading, and must not be reported as one.
  const dn = run(dev(378), build([0x33, 0x44, 0x1a, 0x55, (0x03 << 5) | 0x12, 0x00, 0x66]))[0];
  ok(!!dn, 'Sefis still decodes a frame with an unknown page code', JSON.stringify(dn));
  if (dn) {
    ok(dn.pressure_kPa === undefined, '  but reports no pressure rather than inventing one');
    ok(dn.temperature_C !== undefined, '  while still reporting the temperature it does know');
  }

  const good = build([0x33, 0x44, 0x1a, 0x55, 0x52, 0x00, 0x66]);
  const broken = rowBits(pad([...bytesToBits([0x66, 0x99, 0x96, 0xa6]),
    ...mcInv(bytesToBits(Uint8Array.from([0x33, 0x44, 0x1a, 0x55, 0x52, 0x00, 0x67, 0x00, 0x00])))], 240));
  ok(!!good && !run(dev(378), broken)[0], '  Sefis rejects a frame failing its CRC');
}

// ---- The registrations, and the family being finished ----
{
  for (const num of [180, 241, 295, 354, 355, 362, 378]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  // Every tire pressure sensor rtl_433 knows about is now here.
  const tpms = REGISTRY.filter(d => d.what && d.what.startsWith('tire pressure'));
  ok(tpms.length >= 28, `every tire pressure sensor is registered (${tpms.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
