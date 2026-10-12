/**
 * Eight small weather and garden sensors.
 *
 * None ships a capture, so every frame is laid out from the transmit side. Three are worth a note:
 *
 *  - The WT0124's sum folds its own carry back in, so its four bytes are chosen to add past 255 on purpose.
 *    A sum masked to a byte along the way would lose that carry and the check would never match, which is a
 *    mistake this project has already made once elsewhere.
 *  - The Calibeur scatters every field a bit at a time across three bytes, so its frame is built by placing
 *    each bit where the decoder reads it from rather than by writing bytes. Its parity is then repaired using
 *    one of the three bits the format does not use.
 *  - The FT-004B has no checksum and instead says everything three times. The test feeds it three copies with
 *    a bit corrupted in different places, so the majority vote has to actually recover the value rather than
 *    merely notice the damage.
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
const rowsOf = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const inv = (bits) => bits.map(b => b ^ 1);
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
const rawSum = (m, n) => { let s = 0; for (let i = 0; i < n; i++) s += m[i]; return s; };

console.log('Small weather and garden sensors');

// ---- Mebus 433 (13): the same message has to appear in three widely separated rows ----
{
  const build = ({ breakRow5 = false, breakRow12 = false, rows = 13 } = {}) => {
    const r = [0x6a, 0x91, 0x2c, 0xf3, 0x7a];
    const payload = bytesToBits(r);
    const five = breakRow5 ? bytesToBits([...r.slice(0, 3), r[3] ^ 0x01, r[4]]) : payload;
    const twelve = breakRow12 ? bytesToBits([...r.slice(0, 4), r[4] ^ 0x01]) : payload;
    const all = [new Array(8).fill(0)];            // row zero opens with a zero byte
    for (let i = 1; i < rows; i++) {
      all.push(i === 5 ? five : i === 12 ? twelve : payload);
    }
    return rowsOf(all);
  };

  const d = run(dev(13), build())[0];
  ok(!!d, 'Mebus decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Mebus-433', '  Mebus model');
    eq(d.id, 0x0a, '  Mebus address');
    eq(d.channel, 2, '  Mebus channel');
    eq(d.battery_ok, 1, '  Mebus battery is healthy');
    eq(d.temperature_C, 30, '  Mebus temperature');
    eq(d.humidity, 55, '  Mebus humidity');
    ok(d.mic === undefined, '  Mebus claims no integrity check, having none');
  }

  // The agreement between rows one, five and thirteen is the whole of its integrity.
  ok(!run(dev(13), build({ breakRow5: true }))[0], '  Mebus refuses a frame where row five disagrees');
  ok(!run(dev(13), build({ breakRow12: true }))[0], '  Mebus refuses a frame where row thirteen disagrees');
  // Upstream reads row twelve without checking there is one; a short capture must not reach that far.
  ok(!run(dev(13), build({ rows: 8 }))[0], '  Mebus refuses a capture too short to hold row thirteen');
  ok(dev(13).disabled === true, '  Mebus is flagged doubtful');
}

// ---- Calibeur RF-104 (21): every field scattered a bit at a time ----
{
  // Place each bit where the decoder reads it from, rather than writing bytes and hoping.
  const build = ({ packed, whole, humidity, repeat = true, spare = 0 }) => {
    const b = [0, 0, 0];
    const put = (byte, bit, v) => { if (v) b[byte] |= 1 << bit; };
    put(0, 7, packed & 1); put(0, 6, (packed >> 1) & 1); put(0, 5, (packed >> 2) & 1);
    put(0, 4, (packed >> 3) & 1); put(0, 3, (packed >> 4) & 1); put(0, 2, (packed >> 5) & 1);
    put(0, 1, (whole >> 4) & 1); put(0, 0, (whole >> 5) & 1);
    put(1, 7, whole & 1); put(1, 6, (whole >> 1) & 1); put(1, 5, (whole >> 2) & 1);
    put(1, 4, (whole >> 3) & 1); put(1, 3, (whole >> 6) & 1);
    put(1, 2, spare);                              // one of the bits the format does not use
    put(1, 1, (humidity >> 5) & 1); put(1, 0, (humidity >> 6) & 1);
    put(2, 7, humidity & 1); put(2, 6, (humidity >> 1) & 1); put(2, 5, (humidity >> 2) & 1);
    put(2, 4, (humidity >> 3) & 1); put(2, 3, (humidity >> 4) & 1);

    // The decoder inverts before reading, so the frame goes on the air the other way up.
    const wanted = bytesToBits(b).slice(0, 21);
    const row = inv(wanted);
    return rowsOf([[], row, repeat ? row : inv(bytesToBits([b[0] ^ 0xff, b[1], b[2]]).slice(0, 21))]);
  };

  // The number of ones must be odd; the spare bit is used to make it so.
  const fields = { packed: 23, whole: 62, humidity: 47 };
  let spare = 0;
  for (const s of [0, 1]) {
    const b = [0, 0, 0];
    const put = (byte, bit, v) => { if (v) b[byte] |= 1 << bit; };
    put(0, 7, fields.packed & 1); put(0, 6, (fields.packed >> 1) & 1); put(0, 5, (fields.packed >> 2) & 1);
    put(0, 4, (fields.packed >> 3) & 1); put(0, 3, (fields.packed >> 4) & 1); put(0, 2, (fields.packed >> 5) & 1);
    put(0, 1, (fields.whole >> 4) & 1); put(0, 0, (fields.whole >> 5) & 1);
    put(1, 7, fields.whole & 1); put(1, 6, (fields.whole >> 1) & 1); put(1, 5, (fields.whole >> 2) & 1);
    put(1, 4, (fields.whole >> 3) & 1); put(1, 3, (fields.whole >> 6) & 1);
    put(1, 2, s);
    put(1, 1, (fields.humidity >> 5) & 1); put(1, 0, (fields.humidity >> 6) & 1);
    put(2, 7, fields.humidity & 1); put(2, 6, (fields.humidity >> 1) & 1); put(2, 5, (fields.humidity >> 2) & 1);
    put(2, 4, (fields.humidity >> 3) & 1); put(2, 3, (fields.humidity >> 4) & 1);
    if (U.crc8(Uint8Array.from(b), 3, 0x80, 0) !== 0) { spare = s; break; }
  }

  const d = run(dev(21), build({ ...fields, spare }))[0];
  ok(!!d, 'Calibeur decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Calibeur-RF104', '  Calibeur model');
    eq(d.id, Math.floor(23 / 10), '  Calibeur channel is carried in the tenths digit');
    eq(d.temperature_C, Math.round(((23 % 10) * 0.1 + 62 - 41) * 10) / 10, '  Calibeur temperature');
    eq(d.humidity, 47, '  Calibeur humidity');
    eq(d.mic, 'CRC', '  Calibeur reports its check');
  }

  // Two messages must agree before it will speak.
  ok(!run(dev(21), build({ ...fields, spare, repeat: false }))[0],
    '  Calibeur refuses a frame the next message does not confirm');
  // Flipping the spare bit turns the parity even, which must be refused.
  ok(!run(dev(21), build({ ...fields, spare: spare ^ 1 }))[0], '  Calibeur refuses a frame of even parity');
}

// ---- Springfield soil probe (53): a nibble of check, then bounds ----
{
  const build = (temp, moisture, { breakChk = false, channel = 1, battLow = 0, button = 0 } = {}) => {
    const b = new Uint8Array(5);
    b[0] = 0x5c;
    const t = Math.round(temp * 10) & 0xfff;
    b[1] = (battLow << 7) | (button << 6) | ((channel - 1) << 4) | ((t >> 8) & 0x0f);
    b[2] = t & 0xff;
    b[3] = (moisture / 10) << 4;
    // The four bytes fold to a single nibble that must come to nothing.
    let x = b[0] ^ b[1] ^ b[2] ^ b[3];
    const fold = ((x >> 4) ^ (x & 0x0f)) & 0x0f;
    b[3] |= breakChk ? (fold ^ 1) : fold;
    const row = bytesToBits(b).slice(0, 36);
    return rowsOf([row, row, row, row]);
  };

  const d = run(dev(53), build(21.5, 40))[0];
  ok(!!d, 'Springfield decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Springfield-Soil', '  Springfield model');
    eq(d.id, 0x5c, '  Springfield id');
    eq(d.temperature_C, 21.5, '  Springfield temperature');
    eq(d.moisture, 40, '  Springfield moisture');
    eq(d.battery_ok, 1, '  Springfield battery is healthy');
    eq(d.mic, 'CHECKSUM', '  Springfield reports its check');
  }

  eq(run(dev(53), build(-5.5, 20))[0]?.temperature_C, -5.5, 'Springfield reads below freezing');
  eq(run(dev(53), build(21.5, 40, { battLow: 1 }))[0]?.battery_ok, 0, '  and reports a low battery');
  ok(!run(dev(53), build(21.5, 40, { breakChk: true }))[0], '  Springfield rejects a frame failing its fold');
  // Its check is weak, so what the probe can measure bounds it as well.
  ok(!run(dev(53), build(95.0, 40))[0], '  Springfield refuses a temperature the probe cannot reach');
}

// ---- FT-004B (92): no checksum, three copies, majority wins ----
{
  const build = (tempRaw, { corrupt = [] } = {}) => {
    const msg = new Uint8Array(6);
    msg[0] = 0xf4;
    msg[1] = 0x3c; msg[2] = 0x91;
    msg[3] = tempRaw & 0xff;
    msg[4] = (tempRaw >> 8) & 0x07;
    msg[5] = 0x00;
    // The sensor reverses each byte on the way out and sends the lot three times over.
    const one = bytesToBits(Uint8Array.from(msg, v => U.reverse8(v))).slice(0, 46);
    const copies = [0, 1, 2].map(i => {
      const c = [...one];
      if (corrupt.includes(i)) c[26] ^= 1;         // damage a bit that actually feeds the temperature
      return c;
    });
    return rowBits(pad([...copies[0], ...copies[1], ...copies[2]], 137));
  };

  const raw = 1200;                                // 1200 * 0.05 - 40 = 20 C
  const d = run(dev(92), build(raw))[0];
  ok(!!d, 'FT-004B decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'FT-004B', '  FT-004B model');
    eq(d.temperature_C, 20, '  FT-004B temperature');
    ok(d.mic === undefined, '  FT-004B claims no integrity check, having none');
  }

  // One damaged copy must be outvoted rather than merely noticed.
  eq(run(dev(92), build(raw, { corrupt: [1] }))[0]?.temperature_C, 20,
    'FT-004B recovers a bit that arrived wrong in one copy');
  eq(run(dev(92), build(raw, { corrupt: [2] }))[0]?.temperature_C, 20, '  whichever copy was damaged');
  // Two copies damaged the same way outvote the good one, which is the honest limit of the scheme.
  const outvoted = run(dev(92), build(raw, { corrupt: [0, 1] }))[0];
  ok(!outvoted || outvoted.temperature_C !== 20, '  but two matching errors will outvote the truth');
}

// ---- Hyundai WS SENZOR (108): twenty-four bits said many times ----
{
  const build = (temp, id, { channel = 1, battOk = 1, startup = 0, repeats = 5 } = {}) => {
    const t = Math.round(temp * 10) & 0xfff;
    const b = Uint8Array.from([(t >> 4) & 0xff, ((t & 0x0f) << 4) | (battOk << 3) | (startup << 2) | (channel - 1), id]);
    const row = bytesToBits(b);
    return rowsOf(new Array(repeats).fill(0).map(() => row));
  };

  const d = run(dev(108), build(23.4, 0x7b))[0];
  ok(!!d, 'Hyundai WS decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Hyundai-WS', '  Hyundai WS model');
    eq(d.id, 0x7b, '  Hyundai WS id');
    eq(d.temperature_C, 23.4, '  Hyundai WS temperature');
    eq(d.battery_ok, 1, '  Hyundai WS battery is healthy');
  }

  eq(run(dev(108), build(-7.2, 0x7b))[0]?.temperature_C, -7.2, 'Hyundai WS reads below freezing');
  eq(run(dev(108), build(23.4, 0x7b, { battOk: 0 }))[0]?.battery_ok, 0, '  and reports a low battery');
  // Four agreeing copies are the minimum.
  ok(!run(dev(108), build(23.4, 0x7b, { repeats: 3 }))[0], '  Hyundai WS refuses too few repeats');
}

// ---- WT0124 pool thermometer (109): a sum that folds its own carry back in ----
{
  const build = ({ breakXor = false, breakSum = false } = {}) => {
    const b = new Uint8Array(7);
    b[0] = 0x5a; b[1] = 0x39; b[2] = 0x9a; b[3] = 0x90;
    b[4] = (b[0] ^ b[1] ^ b[2] ^ b[3]) & 0xff;
    if (breakXor) b[4] ^= 0x01;
    let sum = rawSum(b, 4);
    sum += sum >> 8;                               // the carry out of the top byte comes back in
    sum += b[4];                                   // and this addition carries nowhere
    b[5] = sum & 0xff;
    if (breakSum) b[5] ^= 0x01;
    const row = bytesToBits(b).slice(0, 49);
    return rowsOf([[0, 0, 0, 0], row]);            // row zero holds the run-in
  };

  // The point of the whole exercise: these four bytes really do add past a byte.
  ok(rawSum(Uint8Array.from([0x5a, 0x39, 0x9a, 0x90]), 4) > 0xff,
    'the WT0124 frame sums past a byte, so the carry fold matters');

  const d = run(dev(109), build())[0];
  ok(!!d, 'WT0124 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'WT0124-Pool', '  WT0124 model');
    eq(d.id, 0xa9, '  WT0124 id, picked afresh at power on');
    eq(d.temperature_C, 1, '  WT0124 temperature');
    eq(d.channel, 1, '  WT0124 channel');
    eq(d.mic, 'CHECKSUM', '  WT0124 reports its check');
  }

  ok(!run(dev(109), build({ breakXor: true }))[0], '  WT0124 rejects a frame failing its exclusive-or');
  ok(!run(dev(109), build({ breakSum: true }))[0], '  WT0124 rejects a frame failing its sum');
}

// ---- Missil ML0757 (157): temperature and weather alternate ----
{
  const build = (rwp, f12, f8, { battLow = 0, repeats = 6, breakTail = false } = {}) => {
    const b = new Uint8Array(5);
    b[0] = 0x4d;
    b[1] = (battLow << 7) | (rwp ? 0x04 : 0);
    b[2] = (f12 >> 4) & 0xff;
    b[3] = ((f12 & 0x0f) << 4) | ((f8 >> 4) & 0x0f);
    b[4] = ((f8 & 0x0f) << 4) | (breakTail ? 0x0e : 0x0f);
    const row = bytesToBits(b);
    return rowsOf([[], ...new Array(repeats).fill(0).map(() => row)]);
  };

  const t = run(dev(157), build(false, 213, 0x00))[0];
  ok(!!t, 'Missil decodes a temperature message', JSON.stringify(t));
  if (t) {
    eq(t.model, 'Missil-ML0757', '  Missil model');
    eq(t.id, 0x4d, '  Missil id');
    eq(t.temperature_C, 21.3, '  Missil temperature');
    ok(t.rain_mm === undefined, '  and carries no rainfall at all');
  }

  const w = run(dev(157), build(true, 100, 0x40))[0];
  ok(!!w, 'Missil decodes a rain and wind message', JSON.stringify(w));
  if (w) {
    eq(w.rain_mm, Math.round(100 * 0.45 * 100) / 100, '  Missil rainfall counts in steps of 0.45mm');
    eq(w.wind_avg_km_h, Math.round((0x40 + 2) * 1.4 * 100) / 100, '  Missil wind speed');
    ok(w.temperature_C === undefined, '  and carries no temperature');
  }

  // The three fixed points on that odd wind scale.
  eq(run(dev(157), build(true, 0, 0x00))[0]?.wind_avg_km_h, 0, 'Missil reads a still day as nought');
  eq(run(dev(157), build(true, 0, 0x80))[0]?.wind_avg_km_h, 1.4, '  and its two fixed steps');
  eq(run(dev(157), build(true, 0, 0xc0))[0]?.wind_avg_km_h, 2.8, '  the second of them too');

  // A negative temperature.
  eq(run(dev(157), build(false, 0x1000 - 55, 0x00))[0]?.temperature_C, -5.5, 'Missil reads below freezing');
  eq(run(dev(157), build(false, 213, 0x00, { battLow: 1 }))[0]?.battery_ok, 0, '  and a low battery');

  ok(!run(dev(157), build(false, 213, 0x00, { breakTail: true }))[0],
    '  Missil refuses a frame whose tail is not four ones');
  ok(!run(dev(157), build(false, 213, 0x00, { repeats: 3 }))[0], '  Missil refuses too few repeats');
}

// ---- Sharp SPC775 (158): the only one here with a real digest ----
{
  const build = (temp, humidity, id, { battLow = 0, breakChk = false, repeats = 3 } = {}) => {
    const b = new Uint8Array(6);
    b[0] = 0xa5;
    b[1] = id;
    const t = Math.round(temp * 10) & 0xfff;
    b[2] = (battLow << 7) | ((t >> 8) & 0x0f);
    b[3] = t & 0xff;
    b[4] = humidity;
    // The digest is taken over the exclusive-or of everything before it, not the bytes themselves.
    const folded = Uint8Array.from([U.xorBytes(b, 5)]);
    b[5] = U.lfsrDigest8Reflect(folded, 1, 0x31, 0x31);
    if (breakChk) b[5] ^= 0x01;
    // The decoder inverts before looking, so it goes out the other way up.
    const row = inv(bytesToBits(b));
    return rowsOf(new Array(repeats).fill(0).map(() => row));
  };

  const d = run(dev(158), build(18.6, 55, 0x42))[0];
  ok(!!d, 'Sharp SPC775 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Sharp-SPC775', '  Sharp model');
    eq(d.id, 0x42, '  Sharp id');
    eq(d.temperature_C, 18.6, '  Sharp temperature');
    eq(d.humidity, 55, '  Sharp humidity');
    eq(d.battery_ok, 1, '  Sharp battery is healthy');
    eq(d.mic, 'CRC', '  Sharp reports its check');
  }

  eq(run(dev(158), build(-3.4, 55, 0x42))[0]?.temperature_C, -3.4, 'Sharp reads below freezing');
  eq(run(dev(158), build(18.6, 55, 0x42, { battLow: 1 }))[0]?.battery_ok, 0, '  and a low battery');
  ok(!run(dev(158), build(18.6, 55, 0x42, { breakChk: true }))[0], '  Sharp rejects a frame failing its digest');
  // A humidity above a hundred is not a reading.
  ok(!run(dev(158), build(18.6, 120, 0x42))[0], '  Sharp refuses an impossible humidity');
  ok(!run(dev(158), build(18.6, 55, 0x42, { repeats: 1 }))[0], '  Sharp refuses a frame sent only once');
}

// ---- The registrations themselves ----
{
  for (const num of [13, 21, 53, 92, 108, 109, 157, 158]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
