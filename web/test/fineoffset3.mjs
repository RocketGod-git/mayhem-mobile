/**
 * The Fine Offset air-quality sensors, the big outdoor arrays, and the WH1080 pair.
 *
 * Every frame is laid out as the sensor would send it, with its CRC and byte sum computed the way the sensor
 * computes them, then handed to the decoder.
 *
 * Two things here are worth the trouble on their own. The WH1080 ships on two radios that encode temperature
 * completely differently — the keyed one offsets by forty degrees, the shifted one uses sign-and-magnitude —
 * so both are built to mean the same 21.5 C from different bytes, which is the only way to prove each branch
 * is actually taken. And the WS90 uses all-ones across seven fields to mean "not measured", so it is fed a
 * frame with every sensor idle to confirm none of them arrive as numbers.
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
const row = (bytes) => {
  const bb = new BitBuffer();
  for (const v of bytes) for (let i = 7; i >= 0; i--) bb.addBit((v >> i) & 1);
  return bb;
};
const crc31 = (b, n, init = 0x00) => U.crc8(Uint8Array.from(b), n, 0x31, init);
const sum = (b, n) => U.addBytes(Uint8Array.from(b), n) & 0xff;
/** Close a frame that stores its CRC then its byte sum. */
const seal = (b, crcAt, sumAt) => { b[crcAt] = crc31(b, crcAt); b[sumAt] = sum(b, sumAt); return b; };

console.log('Fine Offset air quality, the big arrays, and the WH1080');

// ---- WH43 (283): particulate only, battery reported as bars split across two bytes ----
{
  const b = seal([0x43, 0x0a, 0x0b, 0x0c, 0x40, 125, 0x40, 205, 0, 0], 8, 9);
  const d = run(dev(283), row([0xaa, 0x2d, 0xd4, ...b]))[0];
  ok(!!d, 'WH43 decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, '0a0b0c', '  WH43 id');
    eq(d.pm2_5_ug_m3, 12, '  WH43 fine particulate, truncated from tenths');
    eq(d.estimated_pm10_0_ug_m3, 20, '  WH43 coarse particulate estimate');
    // Bars come from bit 6 of one byte and bits 7-6 of another: 4 | 1 = 5.
    eq(d.battery_pct, 100, '  WH43 battery bars assemble from two separate bytes');
    eq(d.ext_power, 0, '  WH43 is not on external power at five bars');
  }
  // Six bars is the sensor saying it is mains-powered, not that the battery is unusually good.
  const ext = seal([0x43, 0x0a, 0x0b, 0x0c, 0x40, 125, 0x80, 205, 0, 0], 8, 9);
  const e = run(dev(283), row([0xaa, 0x2d, 0xd4, ...ext]))[0];
  ok(e && e.ext_power === 1, '  WH43 reports six bars as external power', JSON.stringify(e));
}

// ---- WH45 (219): adds temperature, humidity and carbon dioxide ----
{
  const b = seal([0x45, 0x0a, 0x0b, 0x0c, 0x02, 0x67, 55, 0x40, 125, 0x40, 205, 0x03, 0x20, 0, 0], 13, 14);
  // Needs at least 170 bits, so the run-in is padded out.
  const d = run(dev(219), row([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x2d, 0xd4, ...b]))[0];
  ok(!!d, 'WH45 decodes', JSON.stringify(d));
  if (d) {
    eq(d.temperature_C, 21.5, '  WH45 temperature carries the forty-degree offset');
    eq(d.humidity, 55, '  WH45 humidity');
    eq(d.pm2_5_ug_m3, 12.5, '  WH45 fine particulate in tenths');
    eq(d.pm10_ug_m3, 20.5, '  WH45 coarse particulate in tenths');
    eq(d.co2_ppm, 800, '  WH45 carbon dioxide');
  }
}

// ---- WH46 (262): the WH45 with two more particle sizes ----
{
  const b = seal([0x46, 0x0a, 0x0b, 0x0c, 0x02, 0x67, 55, 0x40, 125, 0x40, 205,
    0x03, 0x20, 0, 50, 0, 150, 0x12, 0x34, 0, 0], 19, 20);
  const d = run(dev(262), row([0xaa, 0x2d, 0xd4, ...b]))[0];
  ok(!!d, 'WH46 decodes', JSON.stringify(d));
  if (d) {
    eq(d.temperature_C, 21.5, '  WH46 temperature');
    eq(d.pm1_ug_m3, 5, '  WH46 one-micron particulate');
    eq(d.pm2_5_ug_m3, 12.5, '  WH46 fine particulate');
    eq(d.pm4_ug_m3, 15, '  WH46 four-micron particulate');
    eq(d.pm10_ug_m3, 20.5, '  WH46 coarse particulate');
    eq(d.co2_ppm, 800, '  WH46 carbon dioxide');
    eq(d.unknown1, 0x1234, '  WH46 keeps the two bytes nobody has explained');
  }
}

// ---- WS85 (287): wind and rain ----
{
  const b = new Array(32).fill(0);
  b[0] = 0x85; b[1] = 0x0a; b[2] = 0x0b; b[3] = 0x0c;
  b[4] = 130;                       // 2600 mV
  b[5] = 0x00;                      // no wind high bits set
  b[7] = 34; b[8] = 180; b[9] = 68; // 3.4 m/s, 180 deg, 6.8 m/s
  b[15] = 0; b[16] = 123;           // 12.3 mm
  b[17] = 25;                       // 2.5 V supercapacitor
  b[25] = 7;                        // firmware
  seal(b, 26, 27);
  const d = run(dev(287), row([0xaa, 0xaa, 0x2d, 0xd4, ...b]))[0];
  ok(!!d, 'WS85 decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, '0a0b0c', '  WS85 id');
    eq(d.wind_avg_m_s, 3.4, '  WS85 wind speed');
    eq(d.wind_dir_deg, 180, '  WS85 bearing');
    eq(d.wind_max_m_s, 6.8, '  WS85 gust');
    eq(d.rain_mm, 12.3, '  WS85 rain total');
    eq(d.supercap_V, 2.5, '  WS85 supercapacitor voltage');
    eq(d.battery_mV, 2600, '  WS85 battery volts');
    eq(d.battery_ok, 1, '  WS85 calls 2.6 V a good battery');
    eq(d.firmware, 7, '  WS85 firmware version');
  }
}

// ---- WS90 (244): everything, and it runs its CRC over the whole frame expecting zero ----
{
  const mk = (fill) => {
    const b = new Array(32).fill(0);
    b[0] = 0x90; b[1] = 0x0a; b[2] = 0x0b; b[3] = 0x0c;
    fill(b);
    b[30] = crc31(b, 30);            // so the CRC over 31 bytes comes to zero
    b[31] = sum(b, 31);
    return row([0xaa, 0xaa, 0x2d, 0xd4, ...b]);
  };

  const d = run(dev(244), mk((b) => {
    b[4] = 1; b[5] = 0;              // light 256 -> 2560 lux
    b[6] = 130;                      // 2600 mV
    b[7] = 0x02; b[8] = 0x71;        // 22.5 C
    b[9] = 55;                       // humidity
    b[10] = 34; b[11] = 180; b[12] = 68;
    b[13] = 30;                      // UV index 3.0
    b[14] = 0x03; b[15] = 0xf5;      // 1013 hPa
    b[19] = 0; b[20] = 123;          // 12.3 mm
    b[21] = 25;                      // 2.5 V
    b[29] = 9;                       // firmware
  }))[0];
  ok(!!d, 'WS90 decodes', JSON.stringify(d));
  if (d) {
    eq(d.temperature_C, 22.5, '  WS90 temperature');
    eq(d.humidity, 55, '  WS90 humidity');
    eq(d.pressure_hPa, 1013, '  WS90 pressure');
    eq(d.wind_avg_m_s, 3.4, '  WS90 wind speed');
    eq(d.wind_dir_deg, 180, '  WS90 bearing');
    eq(d.wind_max_m_s, 6.8, '  WS90 gust');
    eq(d.uvi, 3, '  WS90 ultraviolet index');
    eq(d.light_lux, 2560, '  WS90 light');
    eq(d.rain_mm, 12.3, '  WS90 rain total');
    eq(d.firmware, 9, '  WS90 firmware version');
  }

  // Every sensor idle at once: the frame still decodes and not one sentinel reaches the reading.
  const idle = run(dev(244), mk((b) => {
    b[4] = 0xff; b[5] = 0xff;        // light
    b[6] = 130;
    b[7] = 0x73; b[8] = 0xff;        // temperature, and the three wind high bits
    b[9] = 0xff; b[10] = 0xff; b[11] = 0xff; b[12] = 0xff; b[13] = 0xff;
    b[14] = 0x3f; b[15] = 0xff;      // pressure
  }))[0];
  ok(!!idle, '  WS90 with nothing measured still decodes', JSON.stringify(idle));
  if (idle) {
    for (const f of ['temperature_C', 'humidity', 'pressure_hPa', 'wind_avg_m_s',
      'wind_max_m_s', 'wind_dir_deg', 'uvi', 'light_lux']) {
      ok(idle[f] === undefined, `    WS90 reports no ${f} rather than a sentinel`, String(idle[f]));
    }
  }
}

// ---- WH1080 (32 keyed, 155 shifted): one frame, two ways of writing a temperature ----
{
  // Keyed: ten bits offset by forty degrees. 615 - 400 = 21.5.
  const ook = [0xff, 0xa5, 0x32, 0x67, 55, 20, 30, 0x00, 100, 0x04, 0];
  ook[10] = crc31(ook, 10, 0xff);   // the preamble byte is inside the CRC, so it starts at 0xff
  const d = run(dev(32), row(ook))[0];
  ok(!!d, 'WH1080 decodes on the keyed radio', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Fineoffset-WHx080', '  WH1080 model');
    eq(d.id, 0x53, '  WH1080 id spans two bytes');
    eq(d.temperature_C, 21.5, '  keyed temperature carries the forty-degree offset');
    eq(d.humidity, 55, '  WH1080 humidity');
    eq(d.wind_dir_deg, 90, '  WH1080 bearing comes from a sixteen-point table');
    eq(d.rain_mm, 30, '  WH1080 rain total');
    eq(d.battery_ok, 1, '  WH1080 battery');
  }

  // Shifted: sign and magnitude, no offset. 215 tenths = the same 21.5 C from different bytes.
  const br = [0xff, 0xa5, 0x30, 0xd7, 55, 20, 30, 0x00, 100, 0x04, 0];
  br[10] = crc31(br, 10, 0xff);
  const frame = [0xaa, 0xaa, 0xaa, 0x2d, 0xd4, ...br.slice(1), 0x00];
  const f = run(dev(155), row(frame))[0];
  ok(!!f, 'WH1080 decodes on the shifted radio', JSON.stringify(f));
  if (f) {
    eq(f.temperature_C, 21.5, '  shifted temperature is sign-and-magnitude with no offset');
    eq(f.humidity, 55, '  shifted humidity');
  }

  // And the sign bit really is a sign bit, not the top of a wider number.
  const neg = [0xff, 0xa5, 0x38, 0xd7, 55, 20, 30, 0x00, 100, 0x04, 0];
  neg[10] = crc31(neg, 10, 0xff);
  const n = run(dev(155), row([0xaa, 0xaa, 0xaa, 0x2d, 0xd4, ...neg.slice(1), 0x00]))[0];
  ok(n && n.temperature_C === -21.5, '  shifted temperature goes negative on the sign bit',
    JSON.stringify(n && n.temperature_C));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
