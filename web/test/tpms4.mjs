/**
 * Factory-fitted tire pressure sensors.
 *
 * The Porsche case is the important one: rtl_433 ships two real captures for it along with the bytes they are
 * known to decode to, so those are fed in raw and checked against the documented values. That is the only
 * non-circular evidence available for differential Manchester anywhere in this batch, and it anchors the same
 * decoder path that the Toyota and AVE sensors rely on.
 *
 * The rest are built from the transmit side. Two of them cannot have their frame computed directly:
 *
 *  - Kia carries only five CRC bits, so a frame is valid only when the eight-bit CRC happens to come out with
 *    its low three bits clear. A self-consistent frame has to be searched for, which is what the sensor's own
 *    encoder must do too.
 *  - Nissan's two check bits are built from overlapping shifts of the frame, so the same applies.
 *
 * Where a decoder inverts the whole buffer before searching, the row is built inverted so that what the decoder
 * sees after its own inversion is the frame that was intended.
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
/** rtl_433 writes its test codes as {bits}hexdigits. */
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return bits.slice(0, n);
};
/** Our Manchester decoder emits the second half of each pair, so a bit travels as its complement then itself. */
const manchester = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };
/**
 * Differential Manchester: the first half always flips away from the previous symbol's second half, and the
 * bit is carried by whether the level then holds across the middle.
 */
const dmc = (bits, prev = 0) => {
  const out = [];
  for (const b of bits) {
    const h1 = 1 - prev;
    const h2 = b ? h1 : 1 - h1;
    out.push(h1, h2);
    prev = h2;
  }
  return out;
};
const inv = (bits) => bits.map(b => b ^ 1);
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };

console.log('Factory-fitted tire pressure sensors');

// ---- Porsche (203): two real captures, checked against the bytes rtl_433 documents for them ----
{
  const CAPTURES = [
    { hex: '333333354ab32d334b2d4ab2cab54cb34cb2aab4cd552ccd8', press: 0x62, crc: 'f05f' },
    { hex: '333333354ab32d334b2d4ab2caaab34cb34d554aacd2b2cd8', press: 0x60, crc: '1d37' },
  ];
  for (const [i, cap] of CAPTURES.entries()) {
    const d = run(dev(203), rowBits(bitsFromHex(cap.hex, 193)))[0];
    ok(!!d, `Porsche real capture ${i + 1} decodes`, JSON.stringify(d));
    if (d) {
      eq(d.model, 'Porsche', `  capture ${i + 1} model`);
      eq(d.id, '23d7ad23', `  capture ${i + 1} id matches the documented bytes`);
      eq(d.pressure_kPa, Math.floor(cap.press * 5 / 2) - 100, `  capture ${i + 1} pressure`);
      eq(d.temperature_C, 0x3b - 40, `  capture ${i + 1} temperature`);
      eq(d.flags, 'bb02', `  capture ${i + 1} status word`);
      eq(d.mic, 'CRC', `  capture ${i + 1} reports its check`);
    }
  }

  // Corrupt one bit of the payload and the CRC must reject it.
  const broken = bitsFromHex(CAPTURES[0].hex, 193);
  broken[60] ^= 1;
  ok(!run(dev(203), rowBits(broken))[0], '  Porsche rejects a capture with a flipped bit');
}

// ---- Toyota PMV-107J (110): differential Manchester, and the pressure is sent twice ----
{
  const build = (press) => {
    const b = new Uint8Array(9);
    b[0] = 0b10;                                   // only two bits wide
    b[1] = 0x12; b[2] = 0x34; b[3] = 0x56;
    b[4] = 0x9a;                                   // status nibbles
    b[5] = press;
    b[6] = press ^ 0xff;                           // the mirrored copy
    b[7] = 60;
    b[8] = U.crc8(b, 8, 0x13, 0x00);
    // Two bits of b[0], then the seven bytes and the CRC, as one 66-bit run.
    const payload = [(b[0] >> 1) & 1, b[0] & 1, ...bytesToBits(b.subarray(1, 9))];
    return pad([...bytesToBits([0xf8]).slice(0, 6), ...dmc(pad(payload, 70))], 200);
  };

  const b5 = 100;
  const d = run(dev(110), rowBits(build(b5)))[0];
  ok(!!d, 'PMV-107J decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'PMV-107J', '  PMV-107J model');
    eq(d.id, (((0b10 << 26) | (0x12 << 18) | (0x34 << 10) | (0x56 << 2) | (0x9a >> 6)) >>> 0).toString(16).padStart(8, '0'),
      '  PMV-107J id spans a two-bit field and three bytes');
    eq(d.pressure_kPa, Math.round((b5 - 40) * 2.48 * 10) / 10, '  PMV-107J pressure');
    eq(d.temperature_C, 20, '  PMV-107J temperature is offset by forty');
    eq(d.counter, (0x9a & 0x18) >> 3, '  PMV-107J counter');
    eq(d.failed, 'OK', '  PMV-107J reports a healthy sensor');
    eq(d.mic, 'CRC', '  PMV-107J reports its check');
  }

  // Break the mirrored copy while leaving the CRC valid, and the frame must still be refused.
  const b = new Uint8Array(9);
  b[0] = 0b10; b[1] = 0x12; b[2] = 0x34; b[3] = 0x56; b[4] = 0x9a;
  b[5] = 100; b[6] = 100 ^ 0xfe; b[7] = 60;        // deliberately not the complement
  b[8] = U.crc8(b, 8, 0x13, 0x00);
  const payload = [(b[0] >> 1) & 1, b[0] & 1, ...bytesToBits(b.subarray(1, 9))];
  const row = pad([...bytesToBits([0xf8]).slice(0, 6), ...dmc(pad(payload, 70))], 200);
  ok(!run(dev(110), rowBits(row))[0], '  PMV-107J refuses a frame whose two pressure copies disagree');
}

// ---- Hyundai VDO (186): the whole buffer is inverted before the preamble is looked for ----
{
  const b = new Uint8Array(10);
  b[0] = 0x21;                                     // state
  b[1] = 0xde; b[2] = 0xad; b[3] = 0xbe; b[4] = 0xef;
  b[5] = 0x35;                                     // flags and repeat count
  b[6] = 160; b[7] = 70; b[8] = 0x5c;
  b[9] = U.crc8(b, 9, 0x07, 0xaa);

  const wanted = [...bytesToBits([0xaa, 0xaa, 0xaa, 0xa9]), ...manchester(bytesToBits(b))];
  const d = run(dev(186), rowBits(inv(pad(wanted, 300))))[0];
  ok(!!d, 'Hyundai VDO decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Hyundai-VDO', '  Hyundai model');
    eq(d.id, 'deadbeef', '  Hyundai id');
    eq(d.state, 0x21, '  Hyundai state byte');
    eq(d.flags, 3, '  Hyundai flags are the high nibble');
    eq(d.repeat, 5, '  Hyundai repeat count is the low nibble');
    eq(d.pressure_kPa, Math.round(160 * 1.375), '  Hyundai pressure');
    eq(d.temperature_C, 20, '  Hyundai temperature is offset by fifty');
  }

  const bad = Uint8Array.from(b); bad[3] ^= 0x01;
  const badRow = [...bytesToBits([0xaa, 0xaa, 0xaa, 0xa9]), ...manchester(bytesToBits(bad))];
  ok(!run(dev(186), rowBits(inv(pad(badRow, 300))))[0], '  Hyundai rejects a frame failing its CRC');
}

// ---- Renault 0435R (212): a byte-wise exclusive-or that must come out to zero ----
{
  const b = new Uint8Array(10);
  b[0] = 0xa1; b[1] = 0xb2; b[2] = 0xc3;
  b[3] = 0x40;                                     // flags
  b[4] = 180; b[5] = 70; b[6] = 12; b[7] = 0x00;
  // The last byte is a counter with a flag in its top bit, and it is also what closes the exclusive-or.
  const want = 0x85;                               // flag set, counter of five
  b[7] = 0;
  let x = 0;
  for (let i = 0; i < 8; i++) x ^= b[i];
  b[7] ^= x ^ want;                                // make the running xor land on the counter byte we want
  b[8] = 0;
  let x2 = 0;
  for (let i = 0; i < 8; i++) x2 ^= b[i];
  b[8] = x2;
  ok(U.xorBytes(b, 9) === 0, 'a self-consistent Renault frame exists');

  const wanted = [...bytesToBits([0xaa, 0xa9]), ...manchester(bytesToBits(b))];
  const d = run(dev(212), rowBits(inv(pad(wanted, 320))))[0];
  ok(!!d, 'Renault 0435R decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Renault-0435R', '  Renault model');
    eq(d.id, 'a1b2c3', '  Renault id is three bytes');
    eq(d.pressure_kPa, Math.round((180 / 0.75) * 10) / 10, '  Renault pressure counts three quarters of a kPa');
    eq(d.temperature_C, 20, '  Renault temperature is offset by fifty');
    eq(d.centrifugal_acc, 60, '  Renault reports how hard the wheel throws it outward');
    eq(d.mic, 'CHECKSUM', '  Renault reports its check');
  }

  const bad = Uint8Array.from(b); bad[1] ^= 0x01;
  const badRow = [...bytesToBits([0xaa, 0xa9]), ...manchester(bytesToBits(bad))];
  ok(!run(dev(212), rowBits(inv(pad(badRow, 320))))[0], '  Renault rejects a frame failing its exclusive-or');
}

// ---- TyreGuard 400 (225): the only on-off keyed one, and its sync word is inside the checked range ----
{
  const b = new Uint8Array(11);
  b[0] = 0xfd; b[1] = 0x5f; b[2] = 0xd5;           // the sync word, which the CRC also covers
  b[3] = 0xf0 | 0x0a;                              // sync nibble, then the top of the id
  b[4] = 0xbc; b[5] = 0xde; b[6] = 0xf1;
  b[7] = 200;                                      // pressure, low byte
  b[8] = 65;                                       // temperature
  b[9] = 0x18;                                     // flags: acknowledging a leak
  b[10] = U.crc8(b, 10, 0x31, 0xdd);

  const d = run(dev(225), rowBits(pad(bytesToBits(b), 120)))[0];
  ok(!!d, 'TyreGuard 400 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'TyreGuard400', '  TyreGuard model');
    eq(d.id, 'abcdef1', '  TyreGuard id is twenty-eight bits');
    eq(d.pressure_kPa, 200 | ((0x18 & 0x70) << 4), '  TyreGuard pressure reaches past a single byte');
    eq(d.temperature_C, 25, '  TyreGuard temperature is offset by forty');
    eq(d.ack_leaking, 8, '  TyreGuard acknowledges a leak');
    eq(d.mic, 'CRC', '  TyreGuard reports its check');
  }

  const bad = Uint8Array.from(b); bad[5] ^= 0x01;
  ok(!run(dev(225), rowBits(pad(bytesToBits(bad), 120)))[0], '  TyreGuard rejects a frame failing its CRC');
}

// ---- Kia (226): only five CRC bits, so a valid frame has to be searched for ----
{
  let b = null;
  for (let fill = 0; fill < 256 && !b; fill++) {
    const t = new Uint8Array(9);
    t[0] = 0xf6;                                   // unknown nibble, then the top of the pressure
    t[1] = 0x4a;                                   // rest of pressure, top of temperature
    t[2] = 0x60 | 0x0a;
    t[3] = 0xbc; t[4] = 0xde; t[5] = 0xf1; t[6] = 0x20;
    t[7] = fill;
    const c = U.crc8(t, 8, 0x07, 0x76);
    if ((c & 0x07) === 0) { t[8] = c; b = t; }     // the low three bits must be clear or nothing can validate
  }
  ok(!!b, 'a Kia frame whose five-bit CRC can be represented exists');

  if (b) {
    const wanted = [...bytesToBits([0xed, 0x71]), ...manchester(bytesToBits(b))];
    const d = run(dev(226), rowBits(pad(wanted, 320)))[0];
    ok(!!d, 'Kia decodes', JSON.stringify(d));
    if (d) {
      eq(d.model, 'Kia', '  Kia model');
      eq(d.pressure_PSI, Math.round((((0xf6 << 4) | (0x4a >> 4)) & 0xff) / 5 * 10) / 10, '  Kia pressure is a fifth of a pound per step');
      eq(d.temperature_C, (((0x4a << 4) | (0x6a >> 4)) & 0xff) - 50, '  Kia temperature is offset by fifty');
      eq(d.mic, 'CRC', '  Kia reports its check');
      ok(typeof d.raw === 'string' && d.raw.length === 18, '  Kia keeps the whole frame, its readings being known to drift');
    }

    const bad = Uint8Array.from(b); bad[4] ^= 0x01;
    const badRow = [...bytesToBits([0xed, 0x71]), ...manchester(bytesToBits(bad))];
    ok(!run(dev(226), rowBits(pad(badRow, 320)))[0], '  Kia rejects a frame failing its CRC');
  }
}

// ---- Nissan (248): two check bits built from overlapping shifts, so again a search ----
{
  const checksum = (b) => {
    let chk = 0;
    for (let i = 0; i < 4; i++) {
      chk = (chk + (b[i] >> 7)) & 0xff;
      chk = (chk + (b[i] >> 5)) & 0xff;
      chk = (chk + (b[i] >> 3)) & 0xff;
      chk = (chk + (b[i] >> 1)) & 0xff;
      chk = (chk + ((b[i] << 1) & 0xff)) & 0xff;
    }
    chk = (chk + (b[4] >> 7)) & 0xff;
    chk = (chk + (b[4] >> 5)) & 0xff;
    chk = (chk + (b[4] >> 3)) & 0xff;
    return ~chk & 0x03;
  };

  let b = null;
  for (let low = 0; low < 32 && !b; low++) {
    const t = Uint8Array.from([0x41, 0x23, 0x45, 0x67, 0x80 | low]);
    if (checksum(t) === 0) b = t;
  }
  ok(!!b, 'a self-consistent Nissan frame exists');

  if (b) {
    // The decoder inverts what it decodes, so the payload goes on the air the other way up.
    const wanted = [...bytesToBits([0xf5, 0x55, 0x55, 0x55, 0xe0]).slice(0, 36), ...manchester(inv(bytesToBits(b)))];
    const d = run(dev(248), rowBits(pad(wanted, 240)))[0];
    ok(!!d, 'Nissan decodes', JSON.stringify(d));
    if (d) {
      eq(d.model, 'Nissan', '  Nissan model');
      eq(d.mode, b[0] >> 5, '  Nissan mode');
      eq(d.id, ((((b[0] & 0x1f) << 19) | (b[1] << 11) | (b[2] << 3) | (b[3] >> 5)) >>> 0).toString(16).padStart(6, '0'),
        '  Nissan id spans four bytes');
      eq(d.pressure_PSI, Math.round((((((b[3] & 0x1f) << 3) | (b[4] >> 5)) / 4) - 3) * 10) / 10,
        '  Nissan pressure is a quarter of a pound per step, offset by three');
      eq(d.mic, 'CHECKSUM', '  Nissan reports its check');
    }

    const bad = Uint8Array.from(b); bad[1] ^= 0x02;
    const badRow = [...bytesToBits([0xf5, 0x55, 0x55, 0x55, 0xe0]).slice(0, 36), ...manchester(inv(bytesToBits(bad)))];
    ok(!run(dev(248), rowBits(pad(badRow, 240)))[0], '  Nissan rejects a frame failing its check bits');
  }
}

// ---- AVE (208): four calibrations chosen by two bits, so one reading means four pressures ----
{
  const build = (mode, batteryRaw) => {
    const b = new Uint8Array(9);
    b[0] = 0x0a; b[1] = 0xbc; b[2] = 0xde; b[3] = 0xf2;
    b[4] = 120;                                    // pressure
    b[5] = 75;                                     // temperature
    b[6] = (mode << 6) | (batteryRaw << 3) | 0x2;
    b[7] = U.crc8(b, 7, 0x31, 0xff);
    return rowBits(pad([...bytesToBits([0xcc, 0xcc, 0xcc, 0xcd]), ...dmc(pad(bytesToBits(b.subarray(0, 8)), 72))], 320));
  };

  const SCALE = [{ r: 2.352, o: 47.0 }, { r: 2.352, o: 0.0 }, { r: 5.491, o: 18.2 }, { r: 5.491, o: 0.0 }];
  for (const mode of [0, 1, 2, 3]) {
    const d = run(dev(208), build(mode, 0))[0];
    ok(!!d, `AVE decodes in mode ${mode}`, JSON.stringify(d));
    if (d) {
      eq(d.mode, `M${mode}`, `  AVE mode ${mode} is reported`);
      eq(d.pressure_kPa, Math.round((120 - SCALE[mode].o) * SCALE[mode].r * 10) / 10,
        `  AVE mode ${mode} pressure uses its own calibration`);
      eq(d.temperature_C, 25, `  AVE mode ${mode} temperature is offset by fifty`);
    }
  }

  // The battery field only means anything at its top two values.
  eq(run(dev(208), build(1, 7))[0]?.battery_pct, 25, 'AVE reports a low battery');
  eq(run(dev(208), build(1, 7))[0]?.battery_ok, 0, '  and marks it as not ok');
  eq(run(dev(208), build(1, 6))[0]?.battery_pct, 75, 'AVE reports a battery that is no longer full');
  eq(run(dev(208), build(1, 2))[0]?.battery_pct, 100, 'AVE treats anything lower as a healthy cell');
}

// ---- The registrations themselves ----
{
  for (const num of [110, 186, 203, 208, 212, 225, 226, 248]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
