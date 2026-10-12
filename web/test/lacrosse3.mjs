/**
 * The older LaCrosse consoles and the ELV/Conrad WS7000 range.
 *
 * Every frame is built from the transmit side — nibbles laid out as the sensor sends them, checks computed the
 * way it computes them — and then handed to the decoder. Two of these are worth the trouble on their own: the
 * WS-2310 guards a frame with three independent checks at once, and the WS7000 stuffs a one-bit after every
 * nibble and sends them bit-reversed, so the encoder here has to run both transforms backwards.
 *
 * The variable-length pair get the most attention. Neither the TX31U nor the TX22U says outright how long its
 * frame is — the TX31U carries a count, the TX22U carries nothing and has to be found by trying each possible
 * length until a CRC closes — so both are checked to pick out the right measurements from the right offsets.
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
/** One row from whole bytes, truncated to `bitLen`. */
const row = (bytes, bitLen = bytes.length * 8) => {
  const bb = new BitBuffer();
  for (let i = 0; i < bitLen; i++) bb.addBit((bytes[i >> 3] >> (7 - (i & 7))) & 1);
  return bb;
};
const crc31 = (b, n, at = 0) => U.crc8(Uint8Array.from(b), n, 0x31, 0x00, at);

console.log('LaCrosse WS-2310, WS7000, TX31U, TX22U and WS6868');

// ---- WS-2310 (34): thirteen nibbles, three checks that must all agree ----
{
  // wsId 9 (a WS2310), type 0, sensor 0x12, BCD 515 -> (515 - 300) * 0.1 = 21.5 C.
  // Nibbles 10 and 11 are the ones-complement of 7 and 8; nibble 12 is the running sum.
  const n = [0, 9, 0, 1, 2, 0, 0, 5, 1, 5, 0xa, 0xe, 0];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += n[i];
  n[12] = sum & 0x0f;
  const bytes = [];
  for (let i = 0; i < 13; i += 2) bytes.push(((n[i] << 4) | (n[i + 1] ?? 0)) & 0xff);

  const d = run(dev(34), row(bytes, 52))[0];
  ok(!!d, 'WS-2310 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-WS2310', '  a station id other than 6 is a WS2310');
    eq(d.id, 0x12, '  WS-2310 sensor id');
    eq(d.temperature_C, 21.5, '  WS-2310 temperature carries the three-hundred offset');
  }

  // The same frame as a WS3600 shifts the offset by a hundred: 515 - 400 = 11.5 C.
  const m = [...n]; m[1] = 6;
  let s2 = 0;
  for (let i = 0; i < 12; i++) s2 += m[i];
  m[12] = s2 & 0x0f;
  const b2 = [];
  for (let i = 0; i < 13; i += 2) b2.push(((m[i] << 4) | (m[i + 1] ?? 0)) & 0xff);
  const d2 = run(dev(34), row(b2, 52))[0];
  ok(!!d2, '  the same frame decodes as a WS3600', JSON.stringify(d2));
  if (d2) {
    eq(d2.model, 'LaCrosse-WS3600', '    named from the station id');
    eq(d2.temperature_C, 11.5, '    and offset by four hundred, not three');
  }

  // Break the complement check alone and nothing may be reported.
  const bad = [...bytes]; bad[5] ^= 0x10;
  ok(!run(dev(34), row(bad, 52))[0], '  WS-2310 rejects a broken complement nibble');
}

// ---- WS7000 (124): nibbles sent bit-reversed with a stuffed one after each ----
{
  const reflect4 = (v) => ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3);
  /** A 0x01 preamble byte, then each nibble reversed and followed by its stuffed one-bit. */
  const ws7000Frame = (nib) => {
    const bb = new BitBuffer();
    for (let i = 0; i < 8; i++) bb.addBit((0x01 >> (7 - i)) & 1);
    for (const t of nib) {
      const r = reflect4(t);
      for (let k = 3; k >= 0; k--) bb.addBit((r >> k) & 1);
      bb.addBit(1);
    }
    return bb;
  };

  // Type 0 (thermometer), address 3, 21.5 C as digits 2/1/5. Nibble 5 makes the exclusive-or come to zero,
  // nibble 6 is the sum plus five.
  const t = [0, 3, 5, 1, 2, 0, 0];
  t[5] = t[0] ^ t[1] ^ t[2] ^ t[3] ^ t[4];
  let s = 0;
  for (let i = 0; i < 6; i++) s += t[i];
  t[6] = (s + 5) & 0x0f;

  const d = run(dev(124), ws7000Frame(t))[0];
  ok(!!d, 'WS7000 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-WS700027', '  type 0 is the plain thermometer');
    eq(d.temperature_C, 21.5, '  WS7000 temperature, from reflected nibbles');
    eq(d.channel, 3, '  WS7000 address');
    eq(d.id, 0x03, '  WS7000 id combines type and address');
  }

  // Corrupt a data nibble and both checks should stop it.
  const bad = [...t]; bad[4] = 7;
  ok(!run(dev(124), ws7000Frame(bad))[0], '  WS7000 rejects a frame whose checks no longer hold');
}

// ---- TX31U (240): a counted list of measurements ----
{
  // Two measurements: temperature 21.5, humidity 55. The CRC runs from byte four for as many as were counted.
  const m = [0xaa, 0xaa, 0x2d, 0xd4, 0x05, 0x42, 0x06, 0x15, 0x10, 0x55, 0];
  m[10] = crc31(m, 2 + 2 * 2, 4);
  const d = run(dev(240), row(m))[0];
  ok(!!d, 'TX31U decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-TX31UIT', '  TX31U model');
    eq(d.id, 21, '  TX31U id spans two bytes');
    eq(d.temperature_C, 21.5, '  TX31U temperature is BCD offset by forty');
    eq(d.humidity, 55, '  TX31U humidity is BCD');
    eq(d.battery_ok, 1, '  TX31U battery');
    // No rain gauge was in the list, so no rain field may appear.
    ok(d.rain === undefined, '  TX31U reports no rain when none was sent', String(d.rain));
  }
  const bad = [...m]; bad[7] ^= 0x01;
  ok(!run(dev(240), row(bad))[0], '  TX31U rejects a frame whose CRC no longer holds');
}

// ---- TX22U (323 shifted, 324 keyed): length discovered by trying each until a CRC closes ----
{
  const b = [0x2a, 0x0f, 0x06, 0x15, 0x10, 0x55, 0, 0];
  b[6] = crc31(b, 6);
  const frame = [0xaa, 0xaa, 0x2d, 0xd4, ...b];

  const d = run(dev(323), row(frame))[0];
  ok(!!d, 'TX22U decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-TX22UIT', '  TX22U model');
    eq(d.id, '2a', '  TX22U id');
    eq(d.temperature_C, 21.5, '  TX22U temperature, found at the right quartet');
    eq(d.humidity, 55, '  TX22U humidity');
    ok(d.wind_avg_km_h === undefined, '  TX22U reports no wind when none was sent', String(d.wind_avg_km_h));
  }

  // The keyed variant is the same frame the other way up.
  const inv = frame.map(v => (~v) & 0xff);
  const d2 = run(dev(324), row(inv))[0];
  ok(!!d2, '  the keyed TX22U reads the same frame inverted', JSON.stringify(d2));
  if (d2) eq(d2.temperature_C, 21.5, '    and gets the same temperature');
}

// ---- WS6868 (374 thermo-hygro, 375 wind and rain) ----
{
  const head = [0x0a, 0x0b, 0x0c, 0x16];      // id 0a0b0c, channel 2, counter 3, battery good

  const th = [...head, 0x2d, 0x50, 55, 0];
  th[7] = crc31(th, 7);
  const d = run(dev(374), row([0xd2, 0xaa, 0x2d, 0xd4, ...th]))[0];
  ok(!!d, 'WS6868 TX232TH decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-TX232TH', '  TX232TH model');
    eq(d.id, '0a0b0c', '  TX232TH id');
    eq(d.channel, 2, '  TX232TH channel is reported one-based');
    eq(d.counter, 3, '  TX232TH counter');
    eq(d.temperature_C, 22.5, '  TX232TH temperature carries a five-hundred offset');
    eq(d.humidity, 55, '  TX232TH humidity');
    eq(d.battery_ok, 1, '  TX232TH battery');
  }

  const rw = [...head, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0, 0];
  rw[10] = crc31(rw, 10);
  rw[11] = U.addBytes(Uint8Array.from(rw), 11) & 0xff;
  const d2 = run(dev(375), row([0xd2, 0xaa, 0x2d, 0xd4, ...rw]))[0];
  ok(!!d2, 'WS6868 TX231RW decodes', JSON.stringify(d2));
  if (d2) {
    eq(d2.model, 'LaCrosse-TX231RW', '  TX231RW model');
    eq(d2.id, '0a0b0c', '  TX231RW shares the header layout');
    // Nobody has worked out these six bytes, so they are handed over untouched rather than guessed at.
    eq(d2.data_raw, '112233445566', '  TX231RW passes its undecoded bytes through');
  }
  const bad = [...rw]; bad[5] ^= 0x01;
  ok(!run(dev(375), row([0xd2, 0xaa, 0x2d, 0xd4, ...bad]))[0], '  TX231RW rejects a broken frame');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
