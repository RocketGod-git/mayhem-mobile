/**
 * Verification for the rtl_433 runtime.
 *
 * Four layers, weakest assumption first:
 *   1. checksums against published check values, which owe nothing to rtl_433;
 *   2. bit buffer operations against naive reimplementations written here;
 *   3. slicers against a transmitter written from the coding rules, bits in and the same bits out;
 *   4. the whole chain — synthesised radio envelope, pulse detector, slicer, decoder — against a frame built
 *      transmit-side with its real checksum, checking the readings come back as sent.
 *
 * Run with `npm run build && npm test` from the web directory: it loads the compiled output.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { pulseSlicerPpm, pulseSlicerPwm, pulseSlicerPcm, pulseSlicerManchesterZerobit } from '../dist/dsp/r433/slicers.js';
import { PulseDetect } from '../dist/dsp/r433/detect.js';
import { Baseband } from '../dist/dsp/r433/baseband.js';
import { R433 } from '../dist/dsp/r433/runner.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/weather-ppm.js';
import '../dist/dsp/r433/devices/tpms.js';
import '../dist/dsp/r433/devices/fineoffset2.js';
import '../dist/dsp/r433/devices/lacrosse.js';
import '../dist/dsp/r433/devices/acurite.js';
import '../dist/dsp/r433/devices/fineoffset.js';
import '../dist/dsp/r433/devices/oregon.js';
import '../dist/dsp/r433/devices/bresser.js';
import '../dist/dsp/r433/devices/security.js';
import '../dist/dsp/r433/devices/weather-more.js';

let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL  ${what}${extra ? '  ' + extra : ''}`); }
};
const eq = (got, want, what) => ok(got === want, what, `got ${got}, want ${want}`);
const hx = v => '0x' + v.toString(16).padStart(2, '0');

const CHECK = new Uint8Array([...'123456789'].map(c => c.charCodeAt(0)));

console.log('checksums against published check values');
eq(U.crc8(CHECK, 9, 0x31, 0xff), 0xf7, 'CRC-8/NRSC-5');
eq(U.crc8(CHECK, 9, 0x07, 0x00), 0xf4, 'CRC-8/SMBUS');
eq(U.crc8(CHECK, 9, 0x1d, 0xfd), 0x7e, 'CRC-8/I-432-1 pre-xor');
eq(U.crc8le(CHECK, 9, 0x07, 0xff), 0xd0, 'CRC-8/ROHC');
eq(U.crc16(CHECK, 9, 0x1021, 0xffff), 0x29b1, 'CRC-16/IBM-3740');
eq(U.crc16(CHECK, 9, 0x8005, 0x0000), 0xfee8, 'CRC-16/UMTS');
eq(U.crc16(CHECK, 9, 0x1021, 0x1d0f), 0xe5cc, 'CRC-16/AUG-CCITT');
eq(U.crc16lsb(CHECK, 9, 0x8408, 0xffff) ^ 0xffff, 0x906e, 'CRC-16/X-25');
eq(U.crc16lsb(CHECK, 9, 0xa001, 0xffff), 0x4b37, 'CRC-16/ARC reflected');

console.log('bit helpers');
eq(U.reverse8(0x01), 0x80, 'reverse8 low bit to high');
eq(U.reverse8(0xf0), 0x0f, 'reverse8 nibble swap');
eq(U.reflect4(0x12), 0x84, 'reflect4');
eq(U.parity8(0x00), 0, 'parity of zero');
eq(U.parity8(0x07), 1, 'parity of three bits');
eq(U.parity8(0xff), 0, 'parity of eight bits');
eq(U.addBytes(new Uint8Array([200, 100]), 2), 44, 'addBytes wraps at 256');
eq(U.addNibbles(new Uint8Array([0xff, 0x01]), 2), 31, 'addNibbles');
eq(U.xorBytes(new Uint8Array([0xf0, 0x0f]), 2), 0xff, 'xorBytes');
// crc4/crc7 have no published vectors; check they degenerate correctly on a zero message with a known init.
eq(U.crc4(new Uint8Array([0x00]), 1, 0x3, 0x0), 0x0, 'crc4 of zero is zero');
eq(U.crc7(new Uint8Array([0x00]), 1, 0x09, 0x00), 0x00, 'crc7 of zero is zero');

console.log('bit buffer against naive reimplementations');
{
  // A random row, read back bit by bit two ways.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
  const bb = new BitBuffer();
  const truth = [];
  for (let i = 0; i < 300; i++) { const b = rnd() & 1; truth.push(b); bb.addBit(b); }
  eq(bb.bitsPerRow[0], 300, 'row length after 300 addBit');
  let same = true;
  for (let i = 0; i < 300; i++) if (((bb.bb[0][i >> 3] >> (7 - (i & 7))) & 1) !== truth[i]) same = false;
  ok(same, 'bits land where they were put');

  // extractBytes at every offset, against a bit-by-bit copy.
  let allOk = true;
  for (let pos = 0; pos < 40; pos++) {
    for (const len of [1, 7, 8, 9, 16, 33, 64]) {
      const got = bb.bytes(0, pos, len);
      const want = new Uint8Array((len + 7) >> 3);
      for (let i = 0; i < len; i++) if (truth[pos + i]) want[i >> 3] |= 0x80 >> (i & 7);
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { allOk = false; }
    }
  }
  ok(allOk, 'extractBytes matches a bit-by-bit copy at every offset');

  // search, against a naive scan.
  const pat = new Uint8Array([0b10110100]);
  const naive = (start, n) => {
    for (let i = start; i + n <= 300; i++) {
      let m = true;
      for (let j = 0; j < n; j++) if (truth[i + j] !== ((pat[j >> 3] >> (7 - (j & 7))) & 1)) { m = false; break; }
      if (m) return i;
    }
    return 300;
  };
  let searchOk = true;
  for (const n of [4, 6, 8]) if (bb.search(0, 0, pat, n) !== naive(0, n)) searchOk = false;
  ok(searchOk, 'search finds the same position as a naive scan');

  // invert twice is the identity.
  const before = bb.rowHex(0);
  bb.invert(); bb.invert();
  eq(bb.rowHex(0), before, 'invert is its own inverse');
}
{
  // The {n}hex notation rtl_433 writes its test codes in.
  const p = BitBuffer.parse('{42}0053e5690200');
  eq(p.numRows, 1, 'parse one row');
  eq(p.bitsPerRow[0], 42, 'parse keeps the stated width');
  eq(p.rowHex(0), '0053e56902' + '00', 'parse keeps the bytes');
  // A '/' and a '{' each start a row, so '{8}ff/{8}00' really is three rows; two rows is '{8}ff{8}00'.
  const two = BitBuffer.parse('{8}ff{8}00');
  eq(two.numRows, 2, 'parse two rows');
  eq(two.bb[1][0], 0x00, 'second row content');
}
{
  // Manchester: encode, then decode, and get the same bits.
  const src = [1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1];
  const line = new BitBuffer();
  for (const b of src) { line.addBit(b ? 0 : 1); line.addBit(b ? 1 : 0); }
  const out = new BitBuffer();
  line.manchesterDecode(0, 0, out, 0);
  eq(out.bitsPerRow[0], src.length, 'manchester decode length');
  let m = true;
  for (let i = 0; i < src.length; i++) if (((out.bb[0][i >> 3] >> (7 - (i & 7))) & 1) !== src[i]) m = false;
  ok(m, 'manchester round trip');
}

console.log('slicers against a transmitter written from the coding rules');

/** Build pulse data from a list of (mark, space) durations in microseconds. */
function makePulses(pairs, rate) {
  const n = pairs.length;
  const pulse = new Int32Array(n + 1), gap = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    pulse[i] = Math.round(pairs[i][0] * rate / 1e6);
    gap[i] = Math.round(pairs[i][1] * rate / 1e6);
  }
  return { pulse, gap, numPulses: n, sampleRate: rate, fsk: false };
}
const RATE = 1_000_000;

/** Read every row out of a slicer run. */
function sliceRows(fn, pulses, dev) {
  const rows = [];
  fn(pulses, dev, bits => {
    for (let r = 0; r < bits.numRows; r++) if (bits.bitsPerRow[r]) rows.push({ n: bits.bitsPerRow[r], hex: bits.rowHex(r) });
    return 1;
  });
  return rows;
}

{
  // Pulse position, Nexus timings: a 500 us mark, then 1000 us for a zero or 2000 us for a one.
  const dev = { shortWidth: 1000, longWidth: 2000, gapLimit: 3000, resetLimit: 5000 };
  const msg = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1];
  const pairs = msg.map(b => [500, b ? 2000 : 1000]);
  pairs.push([500, 6000]);                           // the silence that ends the burst
  const rows = sliceRows(pulseSlicerPpm, makePulses(pairs, RATE), dev);
  eq(rows.length, 1, 'ppm produced one row');
  eq(rows[0].n, msg.length, 'ppm bit count');
  const want = msg.reduce((s, b, i) => s + (b << (7 - (i & 7))) * 0 + 0, 0);
  let hex = '';
  for (let i = 0; i < msg.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8 && i + j < msg.length; j++) v |= msg[i + j] << (7 - j);
    hex += v.toString(16).padStart(2, '0');
  }
  eq(rows[0].hex, hex, 'ppm bits round trip');
}
{
  // Pulse width: short mark is a one, long mark is a zero, equal spaces.
  const dev = { shortWidth: 400, longWidth: 800, gapLimit: 1200, resetLimit: 4000 };
  const msg = [1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0];
  const pairs = msg.map(b => [b ? 400 : 800, 400]);
  pairs.push([400, 5000]);
  const rows = sliceRows(pulseSlicerPwm, makePulses(pairs, RATE), dev);
  eq(rows.length, 1, 'pwm produced one row');
  eq(rows[0].n, msg.length + 1, 'pwm bit count including the closing mark');
}
{
  // Non-return-to-zero: the level is the bit, one bit period each, no gap of its own.
  const dev = { shortWidth: 100, longWidth: 100, resetLimit: 3000 };
  const msg = [1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1];
  // Collapse runs of like bits into marks and spaces.
  const pairs = [];
  let i = 0;
  while (i < msg.length) {
    let ones = 0; while (i < msg.length && msg[i] === 1) { ones++; i++; }
    let zeros = 0; while (i < msg.length && msg[i] === 0) { zeros++; i++; }
    if (ones || zeros) pairs.push([ones * 100, zeros * 100]);
  }
  pairs[pairs.length - 1][1] += 4000;                // trailing silence
  const rows = sliceRows(pulseSlicerPcm, makePulses(pairs, RATE), dev);
  ok(rows.length >= 1, 'pcm produced a row');
  if (rows.length) {
    let hex = '';
    for (let k = 0; k < msg.length; k += 8) {
      let v = 0;
      for (let j = 0; j < 8 && k + j < msg.length; j++) v |= msg[k + j] << (7 - j);
      hex += v.toString(16).padStart(2, '0');
    }
    ok(rows[0].hex.startsWith(hex.slice(0, 2)), 'pcm first byte round trips', `${rows[0].hex} vs ${hex}`);
  }
}

console.log('whole chain: envelope in, reading out');
{
  // Build a real Rubicson frame from the transmit side, checksum and all.
  const id = 0x5a, channel = 2, batteryOk = 1, tempC = -3.4;
  const t = Math.round(tempC * 10) & 0xfff;          // 12 bit, two's complement
  const b = new Uint8Array(5);
  b[0] = id;
  b[1] = (batteryOk << 7) | ((channel - 1) << 4) | ((t >> 8) & 0x0f);
  b[2] = t & 0xff;
  b[3] = 0xf0;
  const crcIn = new Uint8Array([b[0], b[1], b[2], b[3] & 0xf0, 0]);
  // The checksum covers the frame with its own nibbles zeroed, and lands in the last twelve bits.
  let crc = 0;
  for (let cand = 0; cand < 256; cand++) {
    crcIn[4] = cand << 0;
    const test = new Uint8Array([b[0], b[1], b[2], 0xf0, cand]);
    if (U.crc8(test, 5, 0x31, 0x6c) === 0) { crc = cand; break; }
  }
  b[3] = 0xf0 | (crc >> 4);
  b[4] = (crc & 0x0f) << 4;

  const frameBits = [];
  for (let i = 0; i < 36; i++) frameBits.push((b[i >> 3] >> (7 - (i & 7))) & 1);

  // Now turn that into a radio envelope: 500 us marks, gaps of 1000 or 2000 us, twelve repeats.
  const rate = 1_000_000;
  const env = [];
  const push = (level, us) => { for (let k = 0; k < Math.round(us * rate / 1e6); k++) env.push(level); };
  push(0, 20000);                                    // quiet, so the noise estimate settles
  for (let rep = 0; rep < 12; rep++) {
    for (const bit of frameBits) { push(9000, 500); push(60, bit ? 2000 : 1000); }
    push(9000, 500);
    push(60, 4000);                                  // the sync gap between repeats, inside the reset limit
                                                     // so all twelve land in one buffer and can be compared
  }
  push(60, 60000);                                   // long silence to close the burst

  const envArr = Int16Array.from(env);
  const fmArr = new Int16Array(envArr.length);       // no frequency content: this is on/off keying

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  det.process(envArr, fmArr, envArr.length, (kind, pulses) => {
    for (const res of radio.run(kind, pulses)) heard.push(res.data);
  });
  det.flush((kind, pulses) => {
    for (const res of radio.run(kind, pulses)) heard.push(res.data);
  });

  const rub = heard.find(d => d.model === 'Rubicson-Temperature');
  ok(!!rub, 'the Rubicson frame was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (rub) {
    eq(rub.id, id, 'id survived the whole chain');
    eq(rub.channel, channel, 'channel survived');
    eq(rub.battery_ok, batteryOk, 'battery flag survived');
    eq(rub.temperature_C, tempC, 'temperature survived');
    // Every reading carries the frame it came from, in the notation rtl_433 writes its own test codes in.
    eq(rub.protocol, 2, 'the rtl_433 protocol number is reported');
    ok(typeof rub.raw === 'string' && rub.raw.startsWith('{36}'), 'the raw frame is attached', String(rub.raw));
    let wantHex = '';
    for (let i = 0; i < 5; i++) wantHex += b[i].toString(16).padStart(2, '0');
    ok(rub.raw.split('/')[0] === `{36}${wantHex}`, 'the raw frame is the bytes that were transmitted',
      `${rub.raw.split('/')[0]} vs {36}${wantHex}`);
  }
}

console.log('whole chain, frequency keyed: a tire sensor built transmit side');
{
  // A Toyota frame: four bytes of serial, then pressure, temperature, and the pressure again inverted.
  const id = 0x1234abcd, psi = 32.25, tempC = 21;
  const pressure = Math.round((psi + 7) / 0.25);     // quarter of a PSI, offset seven
  const temp = tempC + 40;
  const b = new Uint8Array(9);
  b[0] = (id >>> 24) & 0xff; b[1] = (id >>> 16) & 0xff; b[2] = (id >>> 8) & 0xff; b[3] = id & 0xff;
  b[4] = (pressure >> 1) & 0x7f;                     // status bit clear
  b[5] = ((pressure & 1) << 7) | ((temp >> 1) & 0x7f);
  b[6] = ((temp & 1) << 7);                          // rest of the status nibble left at zero
  b[7] = pressure ^ 0xff;
  b[8] = U.crc8(b, 8, 0x07, 0x80);

  const data = [];
  for (let i = 0; i < 72; i++) data.push((b[i >> 3] >> (7 - (i & 7))) & 1);

  // Differential Manchester: the first half of every symbol always flips, and the second half flips again
  // only for a zero. So a one holds its level across the middle of the bit and a zero does not.
  const line = [];
  for (let i = 0; i < 12; i++) line.push(i % 2 === 0 ? 1 : 0);   // preamble: alternating bits
  for (const s of [0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1]) line.push(s);   // the sync word
  let prev = line[line.length - 1];
  for (const bit of data) {
    const first = prev ^ 1;
    const second = bit ? first : (first ^ 1);
    line.push(first, second);
    prev = second;
  }
  line.push(0, 1, 0);                                // trailer

  // Put that on the air: the carrier stays up throughout and the frequency shifts, which is what makes this
  // one long mark to the envelope detector and a real signal only to the discriminator.
  const rate = 1_000_000;
  const perBit = Math.round(52 * rate / 1e6);
  const env = [], fm = [];
  const quiet = n => { for (let k = 0; k < n; k++) { env.push(60); fm.push(0); } };
  quiet(20000);                                      // let the noise estimate settle
  for (const bit of line) {
    for (let k = 0; k < perBit; k++) { env.push(9000); fm.push(bit ? 6000 : -6000); }
  }
  quiet(60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const t = heard.find(d => d.model === 'Toyota');
  ok(!!t, 'the Toyota frame was heard end to end', JSON.stringify(heard.slice(0, 3)));
  ok(radio.stats.fsk > 0, 'the burst was recognized as frequency keyed, not on-off keyed');
  if (t) {
    eq(t.id, '1234abcd', 'serial number survived the whole chain');
    eq(t.pressure_PSI, psi, 'pressure survived');
    eq(t.temperature_C, tempC, 'temperature survived');
  }
}

console.log('whole chain: pulse width with a sync pulse');
{
  // A LaCrosse TX141TH-Bv2: five bytes, the last of them a shift-register digest rather than a CRC.
  const id = 0x9c, channel = 1, tempC = 18.4, humidity = 63;
  const b = new Uint8Array(5);
  b[0] = id;
  const raw = Math.round(tempC * 10) + 500;
  b[1] = (0 << 7) | (0 << 6) | (channel << 4) | ((raw >> 8) & 0x0f);   // battery good, not a test frame
  b[2] = raw & 0xff;
  b[3] = humidity;
  b[4] = U.lfsrDigest8Reflect(b, 4, 0x31, 0xf4);

  const data = [];
  for (let i = 0; i < 40; i++) data.push((b[i >> 3] >> (7 - (i & 7))) & 1);

  const rate = 1_000_000;
  const env = [], fm = [];
  const at = (level, us) => { const n = Math.round(us * rate / 1e6); for (let k = 0; k < n; k++) { env.push(level); fm.push(0); } };
  at(60, 20000);
  for (let rep = 0; rep < 12; rep++) {
    for (let s = 0; s < 4; s++) { at(9000, 833); at(60, 833); }        // four long marks announce the packet
    // The decoder inverts before reading, so a one goes out as the long mark and a zero as the short one.
    for (const bit of data) {
      if (bit) { at(9000, 417); at(60, 208); }
      else { at(9000, 208); at(60, 417); }
    }
  }
  at(60, 60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const th = heard.find(d => d.model === 'LaCrosse-TX141THBv2');
  ok(!!th, 'the LaCrosse thermometer was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (th) {
    eq(th.id, '9c', 'sensor id survived the sync-pulse path');
    eq(th.channel, channel, 'channel survived');
    eq(th.temperature_C, tempC, 'temperature survived');
    eq(th.humidity, humidity, 'humidity survived');
  }
}

console.log('whole chain: frequency keying onto a sync word');
{
  // A LaCrosse TX35: no repeat counting at all, just a sync word and a CRC.
  const id = 37, tempC = -6.3, humidity = 82;
  const t10 = Math.round((tempC + 40) * 10);         // offset forty, then carried as decimal digits
  const digits = [Math.floor(t10 / 100), Math.floor(t10 / 10) % 10, t10 % 10];
  const b = new Uint8Array(5);
  b[0] = (9 << 4) | ((id >> 2) & 0x0f);              // model nine is a thermometer
  b[1] = ((id & 0x03) << 6) | (0 << 5) | (0 << 4) | digits[0];
  b[2] = (digits[1] << 4) | digits[2];
  b[3] = (0 << 7) | humidity;                        // battery good
  b[4] = U.crc8(b, 4, 0x31, 0x00);

  const line = [];
  for (let i = 0; i < 24; i++) line.push(i % 2 === 0 ? 1 : 0);         // preamble
  for (const v of [0x2d, 0xd4]) for (let i = 7; i >= 0; i--) line.push((v >> i) & 1);
  for (let i = 0; i < 40; i++) line.push((b[i >> 3] >> (7 - (i & 7))) & 1);
  // A trailing edge, as a real sensor has. It matters: the frequency detector cannot classify its very first
  // tone run - there is nothing yet to compare it against - so every burst effectively starts a bit late and
  // the last bits would otherwise fall off the end. This is why these protocols hunt for a sync word.
  for (let i = 0; i < 8; i++) line.push(i % 2);

  const rate = 1_000_000;
  const perBit = Math.round(105 * rate / 1e6);       // the TX35 runs at half the TX29's rate
  const env = [], fm = [];
  const quiet = n => { for (let k = 0; k < n; k++) { env.push(60); fm.push(0); } };
  quiet(20000);
  for (const bit of line) for (let k = 0; k < perBit; k++) { env.push(9000); fm.push(bit ? 6000 : -6000); }
  quiet(60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const tx = heard.find(d => d.model === 'LaCrosse-TX35DTHIT');
  ok(!!tx, 'the LaCrosse IT+ sensor was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (tx) {
    eq(tx.id, id, 'sensor id survived the sync-word path');
    eq(tx.temperature_C, tempC, 'a negative temperature survived');
    eq(tx.humidity, humidity, 'humidity survived');
  }
}

console.log('whole chain: an Acurite Tower, checksum and parity');
{
  // Seven bytes: channel and id, then a byte of flags, humidity, and temperature across two bytes. Every data
  // byte carries even parity in its top bit, and the last byte is the sum of the rest.
  const id = 0x0abc, humidity = 47, tempC = 23.7;
  const tempRaw = Math.round((tempC + 100) * 10);    // offset a hundred degrees, then tenths
  const bb = new Uint8Array(7);
  bb[0] = 0xc0 | ((id >> 8) & 0x3f);                 // channel A
  bb[1] = id & 0xff;
  bb[2] = 0x40 | 0x04;                               // battery good, message type 4: the Tower sensor
  bb[3] = humidity;
  bb[4] = (tempRaw >> 7) & 0x7f;
  bb[5] = tempRaw & 0x7f;
  for (let i = 2; i <= 5; i++) if (U.parity8(bb[i])) bb[i] |= 0x80;
  bb[6] = U.addBytes(bb, 6);

  const data = [];
  for (let i = 0; i < 56; i++) data.push((bb[i >> 3] >> (7 - (i & 7))) & 1);

  const rate = 1_000_000;
  const env = [], fm = [];
  const at = (level, us) => { const n = Math.round(us * rate / 1e6); for (let k = 0; k < n; k++) { env.push(level); fm.push(0); } };
  at(60, 20000);
  for (let rep = 0; rep < 3; rep++) {
    for (let s = 0; s < 4; s++) { at(9000, 620); at(60, 596); }        // four sync marks open each packet
    // Inverted on the wire, so a one is the short mark and a zero the long one.
    for (const bit of data) {
      if (bit) { at(9000, 408); at(60, 204); }
      else { at(9000, 220); at(60, 392); }
    }
    at(60, 2192);                                    // the gap between repeats
  }
  at(60, 60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const tw = heard.find(d => d.model === 'Acurite-Tower');
  ok(!!tw, 'the Acurite Tower was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (tw) {
    eq(tw.id, id, 'sensor id survived');
    eq(tw.channel, 'A', 'channel survived');
    eq(tw.temperature_C, tempC, 'temperature survived');
    eq(tw.humidity, humidity, 'humidity survived');
    eq(tw.battery_ok, 1, 'battery flag survived');
  }
}

console.log('whole chain: a Fine Offset console sensor');
{
  // Eight bytes behind the sync word: id, temperature, humidity, pressure, then a sum and an exclusive-or
  // with its nibbles swapped.
  const id = 0x9a, tempC = 22.6, humidity = 40, pressureHpa = 1001.7;
  const tempRaw = Math.round(tempC * 10) + 400;      // offset forty degrees
  const pRaw = Math.round(pressureHpa * 10);
  const b = new Uint8Array(8);
  b[0] = 0xe0 | (id >> 4);                           // 0xe is the newer model code
  b[1] = ((id & 0x0f) << 4) | ((tempRaw >> 8) & 0x03);
  b[2] = tempRaw & 0xff;
  b[3] = humidity;
  b[4] = pRaw >> 8;
  b[5] = pRaw & 0xff;
  b[6] = U.addBytes(b, 6);
  const x = U.xorBytes(b, 6);
  b[7] = ((x & 0x0f) << 4) | (x >> 4);

  const line = [];
  for (let i = 0; i < 380; i++) line.push(i % 2 === 0 ? 1 : 0);       // this sensor sends a long preamble
  for (const v of [0x2d, 0xd4]) for (let i = 7; i >= 0; i--) line.push((v >> i) & 1);
  for (let i = 0; i < 64; i++) line.push((b[i >> 3] >> (7 - (i & 7))) & 1);
  for (let i = 0; i < 8; i++) line.push(i % 2);      // trailing edge

  const rate = 1_000_000;
  const perBit = 58;
  const env = [], fm = [];
  const quiet = n => { for (let k = 0; k < n; k++) { env.push(60); fm.push(0); } };
  quiet(20000);
  for (const bit of line) for (let k = 0; k < perBit; k++) { env.push(9000); fm.push(bit ? 6000 : -6000); }
  quiet(60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const wh = heard.find(d => d.model === 'Fineoffset-WH25');
  ok(!!wh, 'the Fine Offset console sensor was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (wh) {
    eq(wh.id, id, 'sensor id survived');
    eq(wh.temperature_C, tempC, 'temperature survived');
    eq(wh.humidity, humidity, 'humidity survived');
    eq(wh.pressure_hPa, pressureHpa, 'pressure survived');
  }
}

console.log('whole chain: Manchester, with an Oregon Scientific thermometer');
{
  // An Oregon THGR810. Its digits are decimal, its check is a sum of nibbles, and every byte goes out with its
  // nibbles the other way round, so the frame is built in the decoder's order and swapped on the way to the air.
  const deviceId = 0xb4, channel = 1, tempC = 21.7, humidity = 55;
  const m = new Uint8Array(9);
  m[0] = 0xf8; m[1] = 0x24;                          // the model code
  m[2] = (channel << 4) | (deviceId & 0x0f);
  m[3] = deviceId & 0xf0;                            // battery flag clear: good
  const t10 = Math.round(tempC * 10);
  m[4] = ((t10 % 10) << 4) | (Math.floor(t10 / 10) % 10);
  m[5] = Math.floor(t10 / 100) << 4;
  m[6] = ((humidity % 10) << 4) | Math.floor(humidity / 10);
  // The check sits across two bytes at nibble fifteen: low half in byte seven, high half in byte eight.
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (m[i] >> 4) + (m[i] & 0x0f);
  m[7] = sum & 0x0f;
  m[8] = sum & 0xf0;

  // On the air each byte has the bits inside each of its nibbles reversed - which is not the same as swapping
  // the two nibbles over, and is the mistake to make here.
  const wire = [...m].map(U.reflect4);

  const line = [];
  // A run of like symbols is phase-ambiguous in Manchester, so a preamble of them reads back as a run of zeros
  // whichever way it was sent. That is what the decoder looks for, and why it accepts both polarities.
  for (let i = 0; i < 24; i++) line.push(1);         // preamble
  for (const b of [0, 1, 0, 1]) line.push(b);        // sync
  for (let i = 0; i < wire.length * 8; i++) line.push((wire[i >> 3] >> (7 - (i & 7))) & 1);

  // Manchester: a one is high then low, a zero is low then high. Where two bits agree the level flips at the
  // boundary between them, which is what tells the two kinds of edge apart.
  const rate = 1_000_000, half = 488;
  const env = [], fm = [];
  const at = (level, us) => { const n = Math.round(us * rate / 1e6); for (let k = 0; k < n; k++) { env.push(level); fm.push(0); } };
  at(60, 20000);
  for (const b of line) { at(b ? 9000 : 60, half); at(b ? 60 : 9000, half); }
  at(60, 60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const os = heard.find(d => d.model === 'Oregon-THGR810');
  ok(!!os, 'the Oregon thermometer was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (os) {
    eq(os.id, deviceId, 'house code survived the Manchester path');
    eq(os.channel, channel, 'channel survived');
    eq(os.temperature_C, tempC, 'temperature survived');
    eq(os.humidity, humidity, 'humidity survived');
  }
}

console.log('whole chain: a Bresser mast, checked against its own complement');
{
  // Twenty-six bytes: thirteen of readings, preceded by thirteen that are their exact complement. A single
  // bit flipped anywhere breaks that relationship, which is a stronger check than most of these sensors carry.
  const id = 0x2a, tempC = 18.3, humidity = 62, windAvg = 3.4, gust = 5.1, dirIdx = 6, rain = 12.7;
  const m = new Uint8Array(26);
  const t = Math.round(tempC * 10), w = Math.round(windAvg * 10), g = Math.round(gust * 10), r = Math.round(rain * 10);
  m[13] = 0x00;
  m[14] = id;
  m[15] = 0x00;                                      // sensor type: an ordinary mast
  m[16] = g & 0xff;                                  // gust is plain binary, its top nibble out of sequence
  m[17] = (dirIdx << 4) | ((g >> 8) & 0x0f);
  m[18] = (Math.floor(w / 10) % 10 << 4) | (w % 10); // wind average is decimal digits
  m[19] = Math.floor(w / 100);
  m[20] = (Math.floor(t / 10) % 10 << 4) | (t % 10);
  m[21] = Math.floor(t / 100);
  m[22] = (Math.floor(humidity / 10) << 4) | (humidity % 10);
  m[23] = (Math.floor(r / 10) % 10 << 4) | (r % 10);
  m[24] = (Math.floor(r / 1000) << 4) | (Math.floor(r / 100) % 10);
  m[25] = 0x00;                                      // battery good, temperature positive
  for (let i = 0; i < 13; i++) m[i] = ~m[i + 13] & 0xff;

  const line = [];
  for (let i = 0; i < 8; i++) for (let k = 7; k >= 0; k--) line.push((0xaa >> k) & 1);
  for (const v of [0x2d, 0xd4]) for (let k = 7; k >= 0; k--) line.push((v >> k) & 1);
  for (let i = 0; i < m.length * 8; i++) line.push((m[i >> 3] >> (7 - (i & 7))) & 1);
  for (let i = 0; i < 8; i++) line.push(i % 2);

  const rate = 1_000_000, perBit = 124;
  const env = [], fm = [];
  const quiet = n => { for (let k = 0; k < n; k++) { env.push(60); fm.push(0); } };
  quiet(20000);
  for (const bit of line) for (let k = 0; k < perBit; k++) { env.push(9000); fm.push(bit ? 6000 : -6000); }
  quiet(80000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const br = heard.find(d => d.model === 'Bresser-5in1');
  ok(!!br, 'the Bresser mast was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (br) {
    eq(br.id, id, 'station id survived');
    eq(br.temperature_C, tempC, 'temperature survived');
    eq(br.humidity, humidity, 'humidity survived');
    eq(br.wind_avg_m_s, windAvg, 'wind speed survived');
    eq(br.wind_max_m_s, gust, 'gust survived');
    eq(br.wind_dir_deg, dirIdx * 22.5, 'wind direction survived');
    eq(br.rain_mm, rain, 'rainfall survived');
  }
}

console.log('whole chain: a Honeywell door sensor');
{
  // Six bytes behind a Manchester layer: channel and serial number, an event byte, then a CRC. Which CRC
  // polynomial applies depends on the channel, because two generations of these share the air.
  const channel = 0x8, id = 0x1a2b3;
  const b = new Uint8Array(6);
  b[0] = (channel << 4) | ((id >> 16) & 0x0f);
  b[1] = (id >> 8) & 0xff;
  b[2] = id & 0xff;
  b[3] = 0x80 | 0x04;                                // contact open, and this is a heartbeat transmission
  const crc = U.crc16(b, 4, 0x8005, 0);
  b[4] = crc >> 8;
  b[5] = crc & 0xff;

  const line = [];
  for (let i = 0; i < 6; i++) for (let k = 7; k >= 0; k--) line.push((0x55 >> k) & 1);
  for (let k = 7; k >= 0; k--) line.push((0x56 >> k) & 1);
  // Manchester on top: each data bit goes out as its own inverse followed by itself.
  for (let i = 0; i < 48; i++) { const d = (b[i >> 3] >> (7 - (i & 7))) & 1; line.push(d ^ 1, d); }
  line.push(1);                                      // a closing mark, so the last pair is complete

  const rate = 1_000_000, perBit = 136;
  const env = [], fm = [];
  const at = (level, us) => { const n = Math.round(us * rate / 1e6); for (let k = 0; k < n; k++) { env.push(level); fm.push(0); } };
  at(60, 20000);
  for (const bit of line) at(bit ? 9000 : 60, perBit);
  at(60, 60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const hw = heard.find(d => d.model === 'Honeywell-Security');
  ok(!!hw, 'the Honeywell door sensor was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (hw) {
    eq(hw.id, id, 'serial number survived');
    eq(hw.channel, channel, 'channel survived');
    eq(hw.state, 'open', 'the door reads as open');
    eq(hw.heartbeat, 1, 'the heartbeat flag survived');
    eq(hw.battery_ok, 1, 'battery flag survived');
  }
}

console.log('whole chain: differential Manchester, with a WT450');
{
  // The bit here is whether the level held across the middle of its period, not which way it moved: a one is
  // a whole period at one level, a zero is half a period at each. This is the only coding in the port that
  // works that way, and the only device that uses it.
  const house = 0x5, channel = 2, tempC = 21.5, humidity = 46, seq = 1;
  const b = new Uint8Array(5);
  b[0] = (0xc << 4) | house;
  const whole = Math.floor(tempC) + 50;              // whole degrees, offset fifty
  const frac = Math.round((tempC - Math.floor(tempC)) * 16);   // and the rest in sixteenths
  b[1] = ((channel - 1) << 6) | ((humidity >> 4) & 0x07);
  b[2] = ((humidity & 0x0f) << 4) | ((whole >> 4) & 0x0f);
  b[3] = ((whole & 0x0f) << 4) | frac;
  // Two parity bits, folded out of the whole frame. They live in bits 4 and 5 of the last byte: only
  // thirty-six bits are transmitted, so that byte's low nibble never goes on the air at all.
  for (let p = 0; p < 4; p++) {
    b[4] = (seq << 6) | (p << 4);
    let x = U.xorBytes(b, 5);
    x ^= x >> 4; x ^= x >> 2;
    if ((x & 0x03) === 0) break;
  }

  const data = [];
  for (let i = 0; i < 36; i++) data.push((b[i >> 3] >> (7 - (i & 7))) & 1);

  // Encode: a one flips at the halfway point, a zero holds the level for the whole period. Either way the
  // level flips at the start of every bit, which is the clock the decoder locks to.
  const rate = 1_000_000, half = 976;
  const env = [], fm = [];
  const at = (level, us) => { const n = Math.round(us * rate / 1e6); for (let k = 0; k < n; k++) { env.push(level); fm.push(0); } };
  at(60, 20000);
  // Start low so the first flip raises the carrier: an on-off keyed burst has to open with a mark, or the
  // detector never sees its first half-symbol.
  let level = 0;
  for (const bit of data) {
    level ^= 1;                                      // the clock transition at the start of every bit
    if (bit) { at(level ? 9000 : 60, half); level ^= 1; at(level ? 9000 : 60, half); }
    else { at(level ? 9000 : 60, half * 2); }
  }
  at(60, 60000);

  const det = new PulseDetect(rate);
  const radio = new R433();
  const heard = [];
  const sink = (kind, pulses) => { for (const res of radio.run(kind, pulses)) heard.push(res.data); };
  det.process(Int16Array.from(env), Int16Array.from(fm), env.length, sink);
  det.flush(sink);

  const wt = heard.find(d => d.model === 'WT450-TH');
  ok(!!wt, 'the WT450 was heard end to end', JSON.stringify(heard.slice(0, 3)));
  if (wt) {
    eq(wt.id, house, 'house code survived differential Manchester');
    eq(wt.channel, channel, 'channel survived');
    eq(wt.temperature_C, tempC, 'temperature survived, sixteenths and all');
    eq(wt.humidity, humidity, 'humidity survived');
  }
}

console.log('sensitivity: what listening narrower actually buys');
{
  // Build a hundred milliseconds of two-megahertz samples: noise everywhere, and a keyed burst on a carrier
  // thirty kilohertz off the dial. Then ask, for each span, how faint that burst can get before the detector
  // stops finding it. The answer is the whole reason the span control exists.
  const RATE = 2_000_000;
  const build = (amp) => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 6;   // roughly six counts of noise, either sign
    const n = RATE / 10;
    const iq = new Int8Array(n * 2);
    const clamp = v => v > 127 ? 127 : v < -128 ? -128 : v | 0;
    const markUs = 500, gapUs = 1000;
    const startUs = 20000;                            // quiet first, so the noise estimate settles
    for (let i = 0; i < n; i++) {
      const us = i / (RATE / 1e6);
      let on = false;
      if (us >= startUs) {
        const into = us - startUs;
        const period = markUs + gapUs;
        if (into < 30 * period) on = (into % period) < markUs;
      }
      const ph = 2 * Math.PI * 30_000 * (i / RATE);   // the carrier, thirty kilohertz up
      iq[2 * i] = clamp((on ? amp * Math.cos(ph) : 0) + gauss());
      iq[2 * i + 1] = clamp((on ? amp * Math.sin(ph) : 0) + gauss());
    }
    return iq;
  };

  // Count only bursts that look like the transmission we sent - thirty marks. Noise on its own trips the
  // detector now and then and produces a burst of two or three pulses; counting those as a find would make
  // any threshold look infinitely sensitive.
  const heardAt = (iq, span) => {
    const bb = new Baseband();
    let decim = 1;
    while (RATE / (decim * 2) >= span) decim *= 2;
    bb.decim = decim;
    const det = new PulseDetect(Math.round(RATE / decim));
    let real = 0;
    const CHUNK = 65536 * 2;
    const look = (_kind, p) => { if (p.numPulses >= 20) real++; };
    for (let off = 0; off < iq.length; off += CHUNK) {
      const { env, fm, n } = bb.process(iq.subarray(off, Math.min(off + CHUNK, iq.length)));
      det.process(env, fm, n, look);
    }
    det.flush(look);
    return real;
  };

  // Noise alone must not look like a transmission, or the measurement below means nothing.
  eq(heardAt(build(0), 2_000_000), 0, 'noise alone is not mistaken for a transmission across 2 MHz');
  eq(heardAt(build(0), 250_000), 0, 'nor across 250 kHz');

  // The faintest burst each span can still find.
  const floorFor = (span) => {
    let last = 64;
    for (const amp of [64, 57, 51, 45, 40, 36, 32, 29, 26, 23, 20, 18, 16, 14, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) {
      if (heardAt(build(amp), span) === 0) return last;
      last = amp;
    }
    return last;
  };
  const wide = floorFor(2_000_000);
  const narrow = floorFor(250_000);
  const gained = 20 * Math.log10(wide / narrow);
  console.log(`    faintest burst found across 2 MHz: ${wide} counts; across 250 kHz: ${narrow} counts`);
  console.log(`    narrowing the span is worth ${gained.toFixed(1)} dB`);
  ok(narrow < wide, 'listening narrower finds fainter bursts', `${narrow} vs ${wide}`);
  // Measured at about five decibels. Short of the nine the bandwidth arithmetic promises, because decimating
  // cannot reject everything that folds back in; still the difference between hearing a sensor and not.
  ok(gained >= 4, 'and by a worthwhile margin, not a rounding error', `${gained.toFixed(1)} dB`);
}

console.log('a recorded frame from the rtl_433 sources');
{
  // Esperanza EWS, from the example in src/devices/esperanza_ews.c: fourteen rows, alternating empty.
  const bb = new BitBuffer();
  const src = BitBuffer.parse('{42}0053e5690200');
  for (let row = 0; row < 14; row++) {
    if (row % 2 === 1) {
      for (let i = 0; i < 42; i++) bb.addBit((src.bb[0][i >> 3] >> (7 - (i & 7))) & 1);
    }
    if (row < 13) bb.addRow();
  }
  // The example has data on the even rows with empty rows between, starting at row 2.
  const bb2 = new BitBuffer();
  for (let row = 0; row < 14; row++) {
    if (row >= 2 && row % 2 === 0) {
      for (let i = 0; i < 42; i++) bb2.addBit((src.bb[0][i >> 3] >> (7 - (i & 7))) & 1);
    }
    if (row < 13) bb2.addRow();
  }
  eq(bb2.numRows, 14, 'fourteen rows built');
  const dev = REGISTRY.find(d => d.name === 'Esperanza EWS');
  const got = [];
  const n = dev.decode(dev, bb2, { emit: d => got.push(d) });
  ok(n === 1, 'the recorded Esperanza frame decoded', `returned ${n}`);
  if (got.length) {
    eq(got[0].humidity, 74, 'humidity matches the value recorded in the rtl_433 source');
    eq(got[0].channel, 1, 'channel matches the value recorded in the rtl_433 source');
    console.log('    decoded:', JSON.stringify(got[0]));
  }
}


console.log('the whole chain from real samples: IQ, decimator, detector, every protocol');
{
  // Every other end-to-end test above hands the detector an envelope built by hand. The app never does that:
  // it gets eight-bit IQ at two megasamples, decimates it to the span the user picked, and only then detects.
  // That is three stages nothing was covering, and it is where a sensor that works on the bench stops working
  // on the air. This sends a Rubicson on a carrier thirty kilohertz off the dial and asks for it back.
  const RATE = 2_000_000;

  const symbols = [];                                 // [on, microseconds] pairs
  {
    const b = new Uint8Array(5);
    const id = 155, channel = 2, tempC = 5.4;
    b[0] = id;
    const t = Math.round(tempC * 10);
    b[1] = 0x80 | ((channel - 1) << 4) | ((t >> 8) & 0x0f);
    b[2] = t & 0xff;
    let crc = 0;
    for (let cand = 0; cand < 256; cand++) {
      if (U.crc8(new Uint8Array([b[0], b[1], b[2], 0xf0, cand]), 5, 0x31, 0x6c) === 0) { crc = cand; break; }
    }
    b[3] = 0xf0 | (crc >> 4);
    b[4] = (crc & 0x0f) << 4;
    for (let rep = 0; rep < 12; rep++) {
      for (let i = 0; i < 36; i++) symbols.push([1, 500], [0, ((b[i >> 3] >> (7 - (i & 7))) & 1) ? 2000 : 1000]);
      symbols.push([1, 500], [0, 4000]);
    }
  }

  const makeIq = (amp) => {
    const spus = RATE / 1e6;
    let totalUs = 20000 + 60000;
    for (const [, us] of symbols) totalUs += us;
    const n = Math.round(totalUs * spus);
    const iq = new Int8Array(n * 2);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 6;
    const clamp = v => (v > 127 ? 127 : v < -128 ? -128 : v | 0);
    const on = new Int8Array(n);
    let at = Math.round(20000 * spus);
    for (const [lvl, us] of symbols) {
      const len = Math.round(us * spus);
      for (let k = 0; k < len && at + k < n; k++) on[at + k] = lvl;
      at += len;
    }
    let ph = 0;
    for (let i = 0; i < n; i++) {
      ph += 2 * Math.PI * 30_000 / RATE;              // the carrier, thirty kilohertz off center
      iq[2 * i] = clamp((on[i] ? amp * Math.cos(ph) : 0) + gauss());
      iq[2 * i + 1] = clamp((on[i] ? amp * Math.sin(ph) : 0) + gauss());
    }
    return iq;
  };

  const receive = (iq, span) => {
    const bb = new Baseband();
    let decim = 1;
    while (RATE / (decim * 2) >= span) decim *= 2;
    bb.decim = decim;
    const det = new PulseDetect(Math.round(RATE / decim));
    const radio = new R433();
    const heard = [];
    const sink = (kind, p) => { for (const r of radio.run(kind, p)) heard.push(r.data); };
    const CHUNK = 65536 * 2;
    for (let off = 0; off < iq.length; off += CHUNK) {
      const { env, fm, n } = bb.process(iq.subarray(off, Math.min(off + CHUNK, iq.length)));
      det.process(env, fm, n, sink);
    }
    det.flush(sink);
    return { heard, stats: radio.stats };
  };

  const iq = makeIq(60);
  for (const span of [250_000, 500_000, 1_000_000]) {
    const { heard } = receive(iq, span);
    const rub = heard.find(d => d.model === 'Rubicson-Temperature');
    ok(!!rub, `a Rubicson comes back through the whole radio chain across ${span / 1000} kHz`,
      JSON.stringify([...new Set(heard.map(d => d.model))]));
    if (rub) eq(rub.temperature_C, 5.4, `  and its temperature survived at ${span / 1000} kHz`);
  }

  // The near-miss tally is the app's main diagnostic when a list stays empty, so make sure it exists and is
  // empty when everything decoded cleanly rather than quietly always being blank.
  const { stats } = receive(iq, 250_000);
  ok(stats.near && typeof stats.near === 'object', 'the near-miss tally is reported');
  eq(Object.keys(stats.near).length, 0, 'a clean decode leaves no near misses behind');
}

console.log('the rest of the Fine Offset range: soil, leak, lightning, probe, WS80');
{
  // Each of these is built from the transmit side - lay out the bytes the sensor would send, work out its own
  // checksums the way it does, wrap it in the preamble and sync word - then handed to the receiver. Building
  // the frame from the specification rather than from the decoder is the whole point: a decoder checked
  // against bytes produced by itself proves nothing.
  const PRE = [0xaa, 0xaa, 0xaa, 0x2d, 0xd4];
  const frame = (payload) => {
    const bytes = [...PRE, ...payload];
    const bb = new BitBuffer();
    for (const v of bytes) for (let i = 7; i >= 0; i--) bb.addBit((v >> i) & 1);
    return bb;
  };
  const crc = (b, n) => U.crc8(Uint8Array.from(b), n, 0x31, 0x00);
  const sum = (b, n) => U.addBytes(Uint8Array.from(b), n) & 0xff;
  const run = (dev, bb) => {
    const out = [];
    dev.decode(dev, bb, { emit: d => out.push(d) });
    return out[0];
  };

  // ---- WH55 water leak: family 0x55, CRC over nine bytes, id in bytes 2-3 ----
  {
    const b = [0x55, 0x20, 0x12, 0x34, 0x05, 0x01, 0x2c, 0xc0, 0];
    b[8] = crc(b, 8);                                   // CRC covers 0..8 and must come out zero
    // crc8 over 9 bytes == 0 means byte 8 is the remainder of the first eight
    const dev = REGISTRY.find(d => d.num === 251);
    const d = run(dev, frame([...b, 0, 0, 0]));
    ok(!!d, 'WH55 decodes', JSON.stringify(d));
    if (d) {
      eq(d.channel, 3, '  WH55 channel comes from the high nibble');
      eq(d.id, '01234', '  WH55 id');
      eq(Math.round(d.battery_ok * 100), 100, '  WH55 battery is five steps of a fifth');
      eq(d.raw_value, 300, '  WH55 raw probe reading');
      eq(d.alarm, 1, '  WH55 alarm bit');
      eq(d.sensitivity, 1, '  WH55 sensitivity bit');
    }
  }

  // ---- WN34 probe thermometer: CRC then a byte sum, forty-degree offset except on the D ----
  for (const [family, sub, wantModel, wantTemp] of [
    [0x34, 0, 'Fineoffset-WN34', 21.5], [0x34, 4, 'Fineoffset-WN34D', 61.5], [0x38, 0, 'Fineoffset-WN38', 21.5],
  ]) {
    const t10 = Math.round((wantTemp + (sub === 4 ? 0 : 40)) * 10);   // what the sensor puts on the wire
    const b = [family, 0xab, 0xcd, 0xef, (sub << 4) | ((t10 >> 8) & 0x0f), t10 & 0xff, 0x48, 0, 0];
    b[7] = crc(b, 7);
    b[8] = sum(b, 8);
    const dev = REGISTRY.find(d => d.num === 221);
    const d = run(dev, frame(b));
    ok(!!d, `WN34 family ${family.toString(16)} sub ${sub} decodes`, JSON.stringify(d));
    if (d) {
      eq(d.model, wantModel, `  ${wantModel} is named from the family and sub-type`);
      eq(d.temperature_C, wantTemp, `  ${wantModel} temperature`);
      eq(d.battery_mV, 0x48 * 20, `  ${wantModel} battery volts`);
      eq(d.id, 'abcdef', `  ${wantModel} id`);
    }
  }

  // ---- WH52 soil probe: CRC over 22, then a sum over 23 ----
  {
    const b = new Array(24).fill(0);
    b[0] = 0xa2; b[1] = 0x11; b[2] = 0x22; b[3] = 0x33;
    const t10 = Math.round((18.5 + 40) * 10);
    b[4] = (2 << 5) | ((t10 >> 8) & 0x1f); b[5] = t10 & 0xff;
    b[6] = 42;                                          // moisture per cent
    b[8] = 0x00; b[9] = 0x10; b[10] = 0x00;             // conductivity raw 4096
    b[20] = 75;                                         // 1.5 V
    b[22] = crc(b, 22);
    b[23] = sum(b, 23);
    const dev = REGISTRY.find(d => d.num === 353);
    const d = run(dev, frame(b));
    ok(!!d, 'WH52 decodes', JSON.stringify(d));
    if (d) {
      eq(d.id, '112233', '  WH52 id');
      eq(d.temperature_C, 18.5, '  WH52 temperature carries the forty-degree offset');
      eq(d.moisture, 42, '  WH52 moisture');
      eq(d.conductivity_uS_cm, 160, '  WH52 conductivity');
      eq(d.battery_mV, 1500, '  WH52 battery volts');
      eq(d.boost, 2, '  WH52 transmission boost');
    }
  }

  // ---- WH31L lightning: CRC over eight, then byte 8 is the sum of the first eight ----
  {
    const b = [0x57, 0x8a, 0xbc, 0xde, 0x04, 0x00, 0, 0, 0];
    b[5] = 12;                                          // distance is the whole low six bits, so nothing else may sit there
    b[6] = 7;                                           // strike count
    b[7] = crc(b, 7);                                   // so that crc8 over eight comes out zero
    b[8] = sum(b, 8);
    const dev = REGISTRY.find(d => d.num === 190);
    const d = run(dev, frame(b));
    ok(!!d, 'WH31L decodes', JSON.stringify(d));
    if (d) {
      eq(d.state, 'strike', '  WH31L reads the state, not just the count');
      eq(d.storm_dist, 12, '  WH31L storm distance');
      eq(d.strike_count, 7, '  WH31L strike count');
      eq(d.id, 0xabcde, '  WH31L id');
    }
    // A distance of 63 means "heard it, could not place it" and must not be reported as sixty-three kilometres.
    const b2 = [...b]; b2[5] = 63; b2[7] = crc(b2, 7); b2[8] = sum(b2, 8);
    const d2 = run(dev, frame(b2));
    ok(d2 && d2.storm_dist === undefined, '  WH31L leaves an unplaceable strike without a distance', JSON.stringify(d2));
  }

  // ---- WS80 array: sentinels must stay off the screen ----
  {
    const b = new Array(18).fill(0);
    b[0] = 0x80; b[1] = 0x0a; b[2] = 0x0b; b[3] = 0x0c;
    b[4] = 0x01; b[5] = 0x00;                           // light 256 -> 2560 lux
    b[6] = 70;                                          // 1.4 V
    const t = Math.round(22.5 * 10) + 400;              // temperature is offset by forty degrees
    b[8] = t & 0xff;
    b[9] = 55;                                          // humidity
    b[10] = 34;                                         // wind average 3.4 m/s
    b[11] = 180;                                        // bearing
    b[12] = 68;                                         // gust 6.8 m/s
    b[13] = 30;                                         // UV index 3.0
    b[14] = 0x3f; b[15] = 0xff;                         // the "unknown" sentinel
    b[7] = (t >> 8) & 0x03;                             // flags carry the top bits
    b[16] = crc(b, 16);
    b[17] = sum(b, 17);
    const dev = REGISTRY.find(d => d.num === 213);
    // pad the row out to the length the decoder insists on
    const bb = frame(b);
    while (bb.bitsPerRow[0] < 180) bb.addBit(0);
    const d = run(dev, bb);
    ok(!!d, 'WS80 decodes', JSON.stringify(d));
    if (d) {
      eq(d.temperature_C, 22.5, '  WS80 temperature');
      eq(d.humidity, 55, '  WS80 humidity');
      eq(d.wind_avg_m_s, 3.4, '  WS80 wind average');
      eq(d.wind_max_m_s, 6.8, '  WS80 gust');
      eq(d.wind_dir_deg, 180, '  WS80 bearing');
      eq(d.uvi, 3, '  WS80 ultraviolet index');
      eq(d.light_lux, 2560, '  WS80 light');
      ok(d.unknown1 === undefined, '  WS80 drops the unknown field when it is all ones');
    }

    // Every sentinel at once: the frame still decodes, and none of them reach the reading.
    const q = [...b];
    q[7] = 0x73; q[8] = 0xff; q[9] = 0xff; q[10] = 0xff; q[11] = 0xff; q[12] = 0xff; q[13] = 0xff;
    q[4] = 0xff; q[5] = 0xff;
    q[16] = crc(q, 16); q[17] = sum(q, 17);
    const bb2 = frame(q);
    while (bb2.bitsPerRow[0] < 180) bb2.addBit(0);
    const d2 = run(dev, bb2);
    ok(!!d2, '  WS80 with nothing measured still decodes', JSON.stringify(d2));
    if (d2) {
      for (const f of ['temperature_C', 'humidity', 'wind_avg_m_s', 'wind_max_m_s', 'wind_dir_deg', 'uvi', 'light_lux']) {
        ok(d2[f] === undefined, `    WS80 reports no ${f} rather than a sentinel`, String(d2[f]));
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
