/**
 * The LaCrosse "View" LTV range, checked from the transmit side.
 *
 * Every frame here is laid out as the sensor would send it — identity, flags, readings — and its CRC computed
 * the way the sensor computes it, then handed to the decoder. Building the frame from the specification rather
 * than from the decoder is the point: a decoder checked against bytes it produced itself proves nothing.
 *
 * The rain gauge gets the most attention. One board covers the LTV-R1, the LTV-R3 and the LTV-W1 wind sensor,
 * and which is transmitting has to be inferred from where the padding falls and which CRC length closes. Get
 * that wrong and a wind speed is reported as a rainfall total, which is why both variants are tested.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const SYNC = [0xd2, 0xaa, 0x2d, 0xd4];
/** Build one row: some run-in, the sync word, then the payload. */
const frame = (payload, pad = 0) => {
  const bb = new BitBuffer();
  for (const v of [...new Array(pad).fill(0xaa), ...SYNC, ...payload]) {
    for (let i = 7; i >= 0; i--) bb.addBit((v >> i) & 1);
  }
  return bb;
};
/** The CRC these all use: poly 0x31, init 0, placed so that the check over the whole run comes out zero. */
const crcOver = (b, n) => U.crc8(Uint8Array.from(b), n, 0x31, 0x00);
const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out[0]; };

console.log('LaCrosse View LTV range');

// ---- Breeze Pro (166): wind, temperature and humidity, needs at least 264 bit periods ----
{
  const b = [0x12, 0x34, 0x56, 0x06, 0x27, 0x10, 0x37, 0x02, 0x20, 0xb4, 0];
  b[10] = crcOver(b, 10);
  const d = run(dev(166), frame(b, 20));
  ok(!!d, 'Breeze Pro decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-BreezePro', '  Breeze Pro model');
    eq(d.id, '123456', '  Breeze Pro id');
    eq(d.temperature_C, 22.5, '  Breeze Pro temperature carries the forty-degree offset');
    eq(d.humidity, 55, '  Breeze Pro humidity');
    eq(d.wind_avg_km_h, 3.4, '  Breeze Pro wind speed');
    eq(d.wind_dir_deg, 180, '  Breeze Pro bearing');
    eq(d.seq, 3, '  Breeze Pro sequence number');
  }
  // A frame too short to be one must not be read as one.
  ok(!run(dev(166), frame(b, 0)), '  Breeze Pro rejects a frame under 264 bits');
  // And a corrupted reading must fail the CRC rather than arrive as a plausible number.
  const bad = [...b]; bad[4] ^= 0x08;
  ok(!run(dev(166), frame(bad, 20)), '  Breeze Pro rejects a frame whose CRC no longer holds');
}

// ---- WR1 (170): wind and rain, 120 to 156 bits ----
{
  const b = [0xab, 0xcd, 0xef, 0x04, 0x03, 0x21, 0x0e, 0x01, 0x23, 0x45, 0];
  b[10] = crcOver(b, 10);
  const d = run(dev(170), frame(b, 0));
  ok(!!d, 'WR1 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-WR1', '  WR1 model');
    eq(d.id, 'abcdef', '  WR1 id');
    eq(d.wind_avg_km_h, 5, '  WR1 wind speed');
    eq(d.wind_dir_deg, 270, '  WR1 bearing spans the nibble boundary');
    eq(d.seq, 2, '  WR1 sequence number');
  }
}

// ---- TH3 (171): thermo-hygro. Under 280 bits it is a TH3, at or over it a TH2 ----
{
  const b = [0x0a, 0x0b, 0x0c, 0x04, 0x26, 0x70, 0x30, 0];
  b[7] = crcOver(b, 7);
  const d = run(dev(171), frame(b, 10));
  ok(!!d, 'TH3 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-TH3', '  a shorter frame is a TH3');
    eq(d.id, '0a0b0c', '  TH3 id');
    eq(d.temperature_C, 21.5, '  TH3 temperature');
    eq(d.humidity, 48, '  TH3 humidity');
    eq(d.battery_ok, 1, '  TH3 battery');
  }
  // The readings are the only sanity check this frame has, since it carries no family code.
  const hot = [...b]; hot[4] = 0xff; hot[5] = 0xf0; hot[7] = crcOver(hot, 7);
  ok(!run(dev(171), frame(hot, 10)), '  TH3 refuses a temperature outside what a thermometer can mean');
}

// ---- R1 (175): the awkward one — three sensors on one board ----
{
  // An LTV-R1: byte ten empty, and only the eight-byte CRC closes.
  const r1 = [0x01, 0x02, 0x03, 0x06, 0x00, 0xaa, 0x64, 0, 0x11, 0x22, 0x00,
    0, 0, 0, 0, 0, 0, 0, 0, 0];
  r1[7] = crcOver(r1, 7);
  const d = run(dev(175), frame(r1, 0));
  ok(!!d, 'R1 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'LaCrosse-R1', '  a rain gauge is told from a wind sensor by its padding');
    eq(d.id, '010203', '  R1 id');
    eq(d.rain_mm, 25, '  R1 rain total, one byte of which is masked against 0xaa');
    ok(d.wind_avg_km_h === undefined, '  R1 reports no wind speed', String(d.wind_avg_km_h));
  }

  // An LTV-W1 wind sensor: the rain bytes are all padding and the eleven-byte CRC closes.
  const w1 = [0x0a, 0x0b, 0x0c, 0x06, 0xaa, 0xaa, 0xaa, 0x07, 0xba, 0xaa, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0];
  w1[10] = crcOver(w1, 10);
  const d2 = run(dev(175), frame(w1, 0));
  ok(!!d2, 'W1 decodes', JSON.stringify(d2));
  if (d2) {
    eq(d2.model, 'LaCrosse-W1', '  the same board reports as a wind sensor when its rain bytes are padding');
    eq(d2.wind_avg_km_h, 12.3, '  W1 wind speed');
    ok(d2.rain_mm === undefined, '  W1 reports no rainfall — the bytes it would come from are padding',
      String(d2.rain_mm));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
