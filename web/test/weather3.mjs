/**
 * More of the weather tail.
 *
 * None ships a capture, so every frame is laid out from the transmit side. Several need the frame built
 * backwards from how it reads: the Alecto's checksum works on reversed bytes, the TS-FT002 sends every field
 * least significant bit first, and the WS2032 goes out inverted after its run-in is placed.
 *
 * The Alecto is exercised across all three of its message shapes, because which one arrived is decided by
 * bits inside the frame rather than by anything structural — a decoder that reads a wind message as a
 * temperature would look perfectly healthy otherwise.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import { slice } from '../dist/dsp/r433/slicers.js';
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

console.log('Alecto, inFactory, Oregon SL109H, Ambient TX-8300, TS-FT002, Eurochron and WS2032');

// ---- Alecto V1 (16): one frame, four kinds of reading ----
{
  // Its check sums the nibbles of the reversed bytes, then either subtracts from fifteen or adds seven.
  const checkNibble = (b) => {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const t = U.reverse8(b[i]);
      sum += (t & 0x0f) + ((t & 0xf0) >> 4);
    }
    sum = (b[1] & 0x7f) === 0x6c ? sum + 0x07 : 0x0f - sum;
    return U.reverse8((sum & 0x0f) << 4);
  };
  /** Build one 36-bit row, closing it with the checksum the sensor would compute. */
  const frame = (b0, b1, b2, b3) => {
    const b = Uint8Array.from([b0, b1, b2, b3, 0]);
    // The check occupies the high nibble; the low one is always clear, which the decoder also insists on.
    b[4] = (checkNibble(b) << 4) & 0xff;
    return bytesToBits(b).slice(0, 36);
  };
  /** Seven rows, with the payload in rows one and five as the decoder expects. */
  const build = (rowOne, rowFive, { rows = 7, extra = null } = {}) => {
    const all = [new Array(8).fill(0)];
    for (let i = 1; i < rows; i++) {
      all.push(i === 5 ? rowFive : i === 1 ? rowOne : (extra && extra[i]) || rowOne);
    }
    return rowsOf(all);
  };

  // Temperature and humidity: message type is not three, and every row must agree on its first byte.
  // Reversed, b[1] holds the low nibble of the temperature and b[2] the rest; b[3] is humidity as digits.
  const tB1 = U.reverse8(0x21);                    // reversed later by the decoder
  const th = frame(0x5c, tB1, U.reverse8(0x0d), U.reverse8(0x55));
  const d = run(dev(16), build(th, th))[0];
  ok(!!d, 'Alecto temperature decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'AlectoV1-Temperature', '  Alecto reports a temperature message');
    eq(d.humidity, 55, '  Alecto humidity is packed as decimal digits');
    eq(d.mic, 'CHECKSUM', '  Alecto reports its check');
    ok(d.rain_mm === undefined && d.wind_avg_m_s === undefined, '  and carries neither rain nor wind');
  }

  // Rain: message type three with the low nibble reading 0x0c.
  const rain = frame(0x5c, 0x6c, U.reverse8(0x40), U.reverse8(0x01));
  const dr = run(dev(16), build(rain, rain))[0];
  ok(!!dr, 'Alecto rain decodes', JSON.stringify(dr));
  if (dr) {
    eq(dr.model, 'AlectoV1-Rain', '  Alecto reports a rain message');
    eq(dr.rain_mm, Math.round(((0x01 << 8) | 0x40) * 0.25 * 100) / 100, '  Alecto rain counts quarter millimetres');
    ok(dr.temperature_C === undefined, '  and carries no temperature');
  }

  // A frame whose checksum does not close must be refused.
  const bad = [...th];
  bad[32] ^= 1;                                  // the top bit of the checksum, not a structural bit
  ok(!run(dev(16), build(bad, th))[0], '  Alecto rejects a frame failing its checksum');
  // Upstream reads as far as row six without checking there is one.
  ok(!run(dev(16), build(th, th, { rows: 4 }))[0], '  Alecto refuses a capture too short to hold row six');
}

// ---- inFactory (91): a CRC over a frame rearranged first ----
{
  const build = (id, tempF, humidity, channel, { battLow = 0, button = 0, breakCrc = false, bits = 40 } = {}) => {
    const b = new Uint8Array(6);
    b[0] = id;
    const raw = Math.round(tempF * 10) + 900;
    b[2] = (raw >> 4) & 0xff;
    b[3] = ((raw & 0x0f) << 4) | (Math.floor(humidity / 10) & 0x0f);
    b[4] = ((humidity % 10) << 4) | (channel & 0x03);
    b[1] = (button << 3) | (battLow << 2);
    // The channel bits stand in for the check while the CRC is taken.
    const msg = Uint8Array.from([b[0], (b[1] & 0x0f) | ((b[4] & 0x0f) << 4), b[2], b[3], b[4]]);
    const crc = (U.crc4(msg, 4, 0x13, 0) ^ (msg[4] >> 4)) & 0x0f;
    b[1] |= (breakCrc ? (crc ^ 1) : crc) << 4;
    return rowBits(pad(bytesToBits(b).slice(0, 40), bits));
  };

  const d = run(dev(91), build(0x0f, 68.4, 57, 1))[0];
  ok(!!d, 'inFactory decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'inFactory-TH', '  inFactory model');
    eq(d.id, 0x0f, '  inFactory id');
    eq(d.channel, 1, '  inFactory channel');
    eq(d.temperature_F, 68.4, '  inFactory reports Fahrenheit, as it sends it');
    eq(d.humidity, 57, '  inFactory humidity');
    eq(d.mic, 'CRC', '  inFactory reports its check');
  }

  // Some variants are sliced a bit or two longer.
  ok(!!run(dev(91), build(0x0f, 68.4, 57, 1, { bits: 42 }))[0], 'inFactory accepts a longer sliced row');
  eq(run(dev(91), build(0x0f, 68.4, 57, 1, { battLow: 1 }))[0]?.battery_ok, 0, '  and reports a low battery');
  ok(!run(dev(91), build(0x0f, 68.4, 57, 1, { breakCrc: true }))[0], '  inFactory rejects a frame failing its CRC');
  // Channel zero is not a channel.
  ok(!run(dev(91), build(0x0f, 68.4, 57, 0))[0], '  inFactory refuses a frame with no channel');
  // A reading outside what the family can measure is not a reading.
  ok(!run(dev(91), build(0x0f, 200.0, 57, 1))[0], '  inFactory refuses a temperature beyond its range');
}

// ---- Oregon SL109H (54): four bits of check, then bounds ----
{
  const build = (temp, humidity, id, channelCode, { breakChk = false, repeats = 3 } = {}) => {
    // Laid out as the sensor sends it: four bits of check, two of channel, then the fields.
    const t = Math.round(temp * 10) & 0xfff;
    const body = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) body.push((v >> i) & 1); };
    push(channelCode & 0x03, 2);
    push(Math.floor(humidity / 10) & 0x0f, 4);
    push(humidity % 10, 4);
    push(t, 12);
    push(0x02, 4);                                 // status
    push(id & 0xff, 8);
    const withChk = (c) => [...bytesToBits([(c << 4) & 0xff]).slice(0, 4), ...body];

    // The check is taken over the payload read from bit two, with that byte's top two bits masked off - and
    // those two bits are the low half of the check itself, so what it covers does not depend on its own value.
    const b = new Uint8Array(5);
    const probe = withChk(0);
    for (let i = 0; i < 36; i++) if (probe[2 + i]) b[i >> 3] |= 0x80 >> (i & 7);
    b[0] &= 0x3f;
    let chk = U.addNibbles(b, 5) & 0x0f;
    if (breakChk) chk ^= 1;

    const row = withChk(chk);
    return rowsOf(new Array(repeats).fill(0).map(() => row));
  };

  const d = run(dev(54), build(21.5, 47, 0x35, 1))[0];
  ok(!!d, 'Oregon SL109H decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Oregon-SL109H', '  SL109H model');
    eq(d.temperature_C, 21.5, '  SL109H temperature');
    eq(d.humidity, 47, '  SL109H humidity');
    eq(d.channel, 1, '  SL109H channel');
    eq(d.mic, 'CHECKSUM', '  SL109H reports its check');
  }

  eq(run(dev(54), build(21.5, 47, 0x35, 0))[0]?.channel, 3, 'SL109H reads channel code nought as channel three');
  ok(!run(dev(54), build(21.5, 47, 0x35, 3))[0], '  and refuses the code that means nothing');
  ok(!run(dev(54), build(21.5, 47, 0x35, 1, { breakChk: true }))[0], '  SL109H rejects a frame failing its check');
  ok(!run(dev(54), build(21.5, 47, 0x35, 1, { repeats: 1 }))[0], '  SL109H refuses a frame sent only once');
  // Its check is four bits, so the temperature is bounded as well.
  ok(!run(dev(54), build(85.0, 47, 0x35, 1))[0], '  SL109H refuses a temperature beyond the sensor range');
}

// ---- Ambient Weather TX-8300 (112): everything twice, then a checksum ----
{
  const chk = (b) => {
    let x = 0, y = 0;
    for (let i = 0; i < 4; i++) {
      x += (b[i] & 0x0f) + ((b[i] & 0xf0) >> 4);
      y += (b[i] & 0x05) + ((b[i] & 0x50) >> 4);
    }
    return ((((~x & 0x0f) << 4) | (~y & 0x0f)) & 0xff);
  };
  const build = (temp, humidity, id, channel, { minus = 0, breakCopy = false, breakChk = false } = {}) => {
    const b = new Uint8Array(9);
    const whole = Math.floor(Math.abs(temp));
    const tenth = Math.round((Math.abs(temp) - whole) * 10);
    b[0] = ((Math.floor(humidity / 10) & 0x0f) << 4) | (humidity % 10);
    b[1] = ((channel & 0x03) << 4) | (minus << 3) | ((id >> 4) & 0x07);
    b[2] = ((id & 0x0f) << 4) | (Math.floor(whole / 10) & 0x0f);
    b[3] = ((whole % 10) << 4) | tenth;
    for (let i = 0; i < 4; i++) b[4 + i] = b[i] ^ 0xff;   // the second copy, inverted
    if (breakCopy) b[5] ^= 0x01;
    b[8] = chk(b) ^ (breakChk ? 0x01 : 0);
    return rowBits([0, 0, ...bytesToBits(b)]);     // two bits of run-in
  };

  const d = run(dev(112), build(23.4, 57, 0x2b, 1))[0];
  ok(!!d, 'Ambient TX-8300 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'AmbientWeather-TX8300', '  TX-8300 model');
    eq(d.temperature_C, 23.4, '  TX-8300 temperature');
    eq(d.humidity, 57, '  TX-8300 humidity');
    eq(d.channel, 1, '  TX-8300 channel');
    eq(d.mic, 'CHECKSUM', '  TX-8300 reports its check');
  }

  eq(run(dev(112), build(5.2, 57, 0x2b, 1, { minus: 1 }))[0]?.temperature_C, -5.2,
    'TX-8300 reads below freezing from its sign bit');
  ok(!run(dev(112), build(23.4, 57, 0x2b, 1, { breakCopy: true }))[0],
    '  TX-8300 rejects a frame whose two copies disagree');
  ok(!run(dev(112), build(23.4, 57, 0x2b, 1, { breakChk: true }))[0],
    '  TX-8300 rejects a frame failing its checksum');
}

// ---- TS-FT002 (125): every field sent backwards ----
{
  const build = (id, depth, temp, transmitNibble, { breakXor = false, bits = 72 } = {}) => {
    // Lay the frame out as it reads, then reflect it, since that is how it goes on the air.
    const r = new Uint8Array(9);
    r[0] = 0xfa;
    r[1] = id;
    r[2] = 0x11;
    r[3] = (depth >> 4) & 0xff;
    r[4] = (0x0 << 4) | (depth & 0x0f);
    const t = Math.round(temp * 10) + 400;
    r[5] = ((transmitNibble & 0x0f) << 4) | (t & 0x0f);
    r[6] = (t >> 4) & 0xff;
    r[7] = 0x00;
    U.reflectBytes(r, 8);                          // the check byte is not reflected
    r[8] = (r[0] ^ r[1] ^ r[2] ^ r[3] ^ r[4] ^ r[5] ^ r[6] ^ r[7]) & 0xff;
    if (breakXor) r[8] ^= 0x01;
    const all = bytesToBits(r);
    if (bits === 72) return rowBits(all);
    // The shorter slicings drop a bit or two from the front of the run-in.
    return rowBits(all.slice(72 - bits));
  };

  const d = run(dev(125), build(0x37, 125, 21.5, 0x00))[0];
  ok(!!d, 'TS-FT002 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'TS-FT002', '  TS-FT002 model');
    eq(d.id, 0x37, '  TS-FT002 id');
    eq(d.depth_cm, 125, '  TS-FT002 depth in centimetres');
    eq(d.temperature_C, 21.5, '  TS-FT002 temperature');
    eq(d.transmit_s, 180, '  TS-FT002 says how often it speaks');
    eq(d.mic, 'CHECKSUM', '  TS-FT002 reports its check');
  }

  eq(run(dev(125), build(0x37, 125, 21.5, 0x08))[0]?.transmit_s, 30, 'TS-FT002 reads its faster interval');
  eq(run(dev(125), build(0x37, 125, 21.5, 0x07))[0]?.transmit_s, 5, '  and its fastest');
  ok(!run(dev(125), build(0x37, 125, 21.5, 0x00, { breakXor: true }))[0],
    '  TS-FT002 rejects a frame failing its exclusive-or');
}

// ---- Eurochron (129): nothing but a length and a nibble of zeroes ----
{
  const build = (temp, humidity, id, { battLow = 0, button = 0, breakNibble = false, repeats = 4 } = {}) => {
    const b = new Uint8Array(5);
    b[0] = id;
    b[1] = (battLow << 7) | (button << 4) | (breakNibble ? 0x01 : 0x00);
    b[2] = humidity;
    const t = Math.round(temp * 10) & 0xfff;
    b[3] = (t >> 4) & 0xff;
    b[4] = (t & 0x0f) << 4;
    const row = bytesToBits(b).slice(0, 36);
    return rowsOf(new Array(repeats).fill(0).map(() => row));
  };

  const d = run(dev(129), build(19.3, 62, 0x88))[0];
  ok(!!d, 'Eurochron decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Eurochron-TH', '  Eurochron model');
    eq(d.id, 0x88, '  Eurochron id');
    eq(d.temperature_C, 19.3, '  Eurochron temperature');
    eq(d.humidity, 62, '  Eurochron humidity');
    ok(d.mic === undefined, '  Eurochron claims no integrity check, having none');
  }

  eq(run(dev(129), build(-4.7, 62, 0x88))[0]?.temperature_C, -4.7, 'Eurochron reads below freezing');
  ok(!run(dev(129), build(19.3, 62, 0x88, { breakNibble: true }))[0],
    '  Eurochron refuses a frame whose fixed nibble is not clear');
  ok(!run(dev(129), build(19.3, 62, 0x88, { repeats: 2 }))[0], '  Eurochron refuses too few repeats');
  ok(dev(129).disabled === true, '  Eurochron is flagged doubtful');
}

// ---- WS2032 (145): a sum and a CRC, and the run-in found before the inversion ----
{
  const build = (temp, humidity, { breakSum = false, breakCrc = false, repeats = 3 } = {}) => {
    const b = new Uint8Array(14);
    b[0] = 0xf5;                                   // the run-in, which reads 0x0a once inverted
    b[1] = 0x12; b[2] = 0x34;
    b[3] = 0x40;                                   // flags, low bit clear for a healthy battery
    const magnitude = Math.round(Math.abs(temp) * 10);
    b[4] = (0x04 << 4) | (temp < 0 ? 0x08 : 0) | ((magnitude >> 8) & 0x07);
    b[5] = magnitude & 0xff;
    b[6] = humidity;
    b[7] = 0x20; b[8] = 0x30;
    b[9] = 0x00; b[10] = 0x01; b[11] = 0x40;
    b[12] = rawSum(b, 12) & 0xff;
    if (breakSum) b[12] ^= 0x01;
    b[13] = U.crc8(b, 13, 0x31, 0x00);
    if (breakCrc) b[13] ^= 0x01;
    // It goes on the air inverted; the decoder finds the run-in first and turns it over afterwards.
    const row = inv(bytesToBits(b));
    return rowsOf(new Array(repeats).fill(0).map(() => row));
  };

  const d = run(dev(145), build(18.7, 55))[0];
  ok(!!d, 'WS2032 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'WS2032', '  WS2032 model');
    eq(d.id, '1234', '  WS2032 station id');
    eq(d.temperature_C, 18.7, '  WS2032 temperature');
    eq(d.humidity, 55, '  WS2032 humidity');
    eq(d.battery_ok, 1, '  WS2032 battery is healthy');
    eq(d.wind_dir_deg, Math.round(4 * 22.5 * 10) / 10, '  WS2032 wind direction in sixteenths');
    eq(d.mic, 'CRC', '  WS2032 reports its check');
  }

  // A magnitude and a sign bit, not a negative number.
  eq(run(dev(145), build(-6.3, 55))[0]?.temperature_C, -6.3, 'WS2032 reads below freezing from its sign bit');
  ok(!run(dev(145), build(18.7, 55, { breakSum: true }))[0], '  WS2032 rejects a frame failing its sum');
  ok(!run(dev(145), build(18.7, 55, { breakCrc: true }))[0], '  WS2032 rejects a frame failing its CRC');
  ok(!run(dev(145), build(18.7, 55, { repeats: 1 }))[0], '  WS2032 refuses a frame sent only once');
}

// ---- Oregon Scientific V1 (50): the decoder, and the slicer written for it ----
{
  // The decoder, fed bits directly like every other test here.
  const build = (id, channel, temp, { battLow = 0, breakChk = false } = {}) => {
    const neg = temp < 0 ? 1 : 0;
    const mag = Math.abs(temp);
    const tens = Math.floor(mag / 10);
    const ones = Math.floor(mag) % 10;
    const tenths = Math.round((mag - Math.floor(mag)) * 10);
    // Nibbles as the sensor lays them out, before each byte is reversed for the air.
    const nib = [id & 0x0f, ((channel - 1) & 0x03) << 2, tenths, ones, tens, (battLow << 3) | (neg << 1), 0, 0];
    let rawCs = 0;
    for (let i = 0; i < 3; i++) rawCs += nib[i * 2] + 16 * nib[i * 2 + 1];
    const chk = ((rawCs & 0xff) + (rawCs >> 8)) & 0xff;
    nib[6] = (breakChk ? chk ^ 1 : chk) & 0x0f;
    nib[7] = ((breakChk ? chk ^ 1 : chk) >> 4) & 0x0f;
    const bytes = Uint8Array.from([0, 1, 2, 3].map(i => U.reverse8(((nib[i * 2 + 1] << 4) | nib[i * 2]) & 0xff)));
    return rowBits(bytesToBits(bytes));
  };

  const d = run(dev(50), build(0xa, 1, 21.5))[0];
  ok(!!d, 'Oregon V1 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Oregon-v1', '  Oregon V1 model');
    eq(d.id, 0xa, '  Oregon V1 id');
    eq(d.channel, 1, '  Oregon V1 channel');
    eq(d.temperature_C, 21.5, '  Oregon V1 temperature, three decimal digits and a sign');
    eq(d.battery_ok, 1, '  Oregon V1 battery is healthy');
    eq(d.mic, 'CHECKSUM', '  Oregon V1 reports its check');
  }

  eq(run(dev(50), build(0xa, 1, -7.3))[0]?.temperature_C, -7.3, 'Oregon V1 reads below freezing from its sign bit');
  eq(run(dev(50), build(0xa, 2, 21.5, { battLow: 1 }))[0]?.battery_ok, 0, '  and reports a low battery');
  ok(!run(dev(50), build(0xa, 1, 21.5, { breakChk: true }))[0], '  Oregon V1 rejects a frame failing its checksum');

  // The slicer, which works on pulses rather than bits - the only test here that does.
  const bit = 1465, half = bit;                    // shortWidth is the half-bit width
  const pulseTrain = (dataBits) => {
    const pulse = [], gap = [];
    for (let i = 0; i < 12; i++) { pulse.push(half); gap.push(half); }
    gap[11] = half * 2;                            // the preamble ends on a longer space
    pulse.push(half * 5); gap.push(half * 5);      // the sync, both halves far longer than a bit
    // Manchester half-periods: a one is a long mark, a zero a long space, in the slicer's counting.
    for (const b of dataBits) { pulse.push(b ? half * 2 : half); gap.push(b ? half : half * 2); }
    gap[gap.length - 1] = 20000;                   // past the reset limit, ending the message
    return { pulse: Int32Array.from(pulse), gap: Int32Array.from(gap), numPulses: pulse.length, sampleRate: 1e6, fsk: false };
  };

  let sliced = null;
  const events = slice(pulseTrain([1, 0, 1, 1, 0, 0, 1, 0]), dev(50), (bb) => {
    sliced = bb.rowHex(0);
    bb.clear();
    return 0;
  });
  ok(sliced !== null, 'the OSv1 slicer produces a message from a pulse train', String(events));

  // A burst that does not open with exactly twelve preamble pulses is not OSv1 at all.
  const short = pulseTrain([1, 0, 1, 0]);
  short.pulse[3] = 10;                             // too short to count as a preamble pulse
  let ranShort = false;
  slice(short, dev(50), () => { ranShort = true; return 0; });
  ok(!ranShort, '  and refuses a burst whose preamble is wrong');
}

// ---- The registrations themselves ----
{
  for (const num of [16, 50, 54, 91, 112, 125, 129, 145]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  // Every modulation in use must be one the slicer actually implements, or the decoder can never be fed.
  // Ten is the OSv1 coding, added alongside Oregon Scientific V1 - before that it was in the enum with no
  // slicer behind it, which is exactly what this assertion exists to catch.
  //
  // This is every case in slice(), which is now all thirteen of rtl_433's codings. Eight is level-shift-raw:
  // nothing registered uses it yet, but the slicer does support it, and leaving it out would have this
  // assertion accuse a perfectly good decoder of being dead the day one arrives.
  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
