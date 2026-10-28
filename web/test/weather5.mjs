/**
 * Nine multi-sensor weather stations, three of them checked against radio rtl_433 actually recorded.
 *
 * Cotech 36-7959 ships one raw capture, Vevor a full sample frame, and Bresser's garden set four real frames
 * from three different devices. Those go in as bytes and the documented values come out, which is evidence this
 * port had no hand in producing. The rest — both Holmans, the two disabled Cotech units and Sainlogic — are
 * built from the transmit side: the bytes are laid out the way the sensor lays them out and every check is
 * computed by a routine written here from its definition rather than imported from the code under test.
 *
 * Three upstream problems are asserted rather than papered over.
 *
 * Sainlogic is the substantial one. Upstream's CRC parameters do not validate upstream's own sample frame, and
 * upstream never rejects on the result anyway — it logs and emits, labeled `mic: "CRC"`. Searching the
 * parameter space over that frame turns up exactly one conventional configuration and it is the reflected twin
 * of upstream's guess: CRC-16/MODBUS, poly 0xa001 (0x8005 reversed), init 0xffff, same span, high byte first.
 * Both facts are pinned below so the disagreement stays visible and legible.
 *
 * Holman's PWM build claims in a comment to sign-extend its temperature and then stores the value in an
 * unsigned sixteen-bit variable, which throws the sign away again. A sub-zero reading comes out near 409 C.
 * That is upstream's behavior, it is reproduced here, and the test says so out loud rather than quietly fixing it.
 *
 * Cotech 36-7959's shipped capture carries no usable light reading: its UV byte is 0xfb, past the bound
 * upstream uses to spot an unfitted sensor, so both light fields are dropped. The premise is asserted next to
 * the outcome so the absence reads as deliberate.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

// ---- Check routines, written from their definitions so building and checking stay independent ----
const crc8ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[i]; for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff; }
  return r;
};
const crc16ref = (m, at, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[at + i] << 8; for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff; }
  return r & 0xffff;
};
const crc16lsbRef = (m, at, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[at + i]; for (let k = 0; k < 8; k++) r = (r & 1) ? ((r >> 1) ^ poly) & 0xffff : r >> 1; }
  return r & 0xffff;
};
/** The reflected Galois digest: bits low to high, register shifting up. */
const lfsrReflectRef = (m, n, gen, key) => {
  let sum = 0, k = key & 0xff;
  for (let b = n - 1; b >= 0; b--) {
    const d = m[b];
    for (let i = 0; i < 8; i++) { if ((d >> i) & 1) sum ^= k; k = (k & 0x80) ? ((k << 1) ^ gen) & 0xff : (k << 1) & 0xff; }
  }
  return sum & 0xff;
};
const xorBytesRef = (m, n) => { let s = 0; for (let i = 0; i < n; i++) s ^= m[i]; return s & 0xff; };
/** Holman's PWM checksum: two interleaved xor sums, plus the even sum shifted by each set key bit. */
const xorShiftRef = (m, n, shiftUp) => {
  let r0 = 0; for (let i = 0; i < n; i += 2) r0 ^= m[i];
  let r1 = 0; for (let i = 1; i < n; i += 2) r1 ^= m[i];
  let rx = 0; for (let j = 0; j < 7; j++) if (shiftUp & (1 << j)) rx ^= (r0 << (j + 1)) & 0xff;
  return (r0 ^ r1 ^ rx) & 0xff;
};
const reverse8ref = (x) => { let o = 0; for (let i = 0; i < 8; i++) if (x & (1 << i)) o |= 1 << (7 - i); return o; };

// ---- Bit plumbing ----
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/ /g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const bytesToBits = (bytes) => { const bits = []; for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); return bits; };
const bitsToBytes = (bits) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
};
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/ /g, '').match(/../g).map(x => parseInt(x, 16)));
const inv = (bits) => bits.map(b => b ^ 1);
const rows = (...arrs) => {
  const bb = new BitBuffer();
  arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
/** One byte as 8N1 on the wire: a start bit, the byte least significant bit first, then a stop bit. */
const uartBits = (v) => [0, ...bytesToBits([reverse8ref(v)]), 1];

console.log('Holman, Cotech, Vevor, Sainlogic and the Bresser garden set');

// ---- AOK / Holman WS5029 PCM (134): built from the transmit side ----
{
  const d = dev(134);
  /** Six lead-in bytes, the three-byte header, then the payload, trimmed to an exact bit count. */
  const build = (payload, totalBits) => {
    const head = [0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x98, 0xf3, 0xa5];
    const all = bytesToBits(Uint8Array.from([...head, ...payload]));
    while (all.length < totalBits) all.push(0);
    return all.slice(0, totalBits);
  };
  /** b[12] is the payload's xor folded through the reflected Galois digest. */
  const seal = (p) => { const b = Uint8Array.from(p); b[12] = lfsrReflectRef(Uint8Array.of(xorBytesRef(b, 12)), 1, 0x00, 0x31); return b; };

  // The build with no light sensor: a short frame whose light field reads zero.
  const plain = seal([0x12, 0x34, 0x0d, 0x74, 0x10, 0x64, 0x0c, 0x40, 0, 0, 0, 0, 0, 0, 0, 0]);
  const out = run(d, rows(build(plain, 196)));
  eq(out.length, 1, 'Holman WS5029 PCM decodes a well-formed short frame');
  eq(out[0]?.model, 'Holman-WS5029', 'the short frame is the build without a light sensor');
  eq(out[0]?.id, 0x1234, 'Holman PCM id');
  eq(out[0]?.temperature_C, 21.5, 'Holman PCM temperature');
  eq(out[0]?.humidity, 65, 'Holman PCM humidity spans two bytes');
  eq(out[0]?.rain_mm, 79, 'Holman PCM rain counts in units of 0.79 mm');
  eq(out[0]?.wind_avg_km_h, 12, 'Holman PCM wind');
  eq(out[0]?.wind_dir_deg, 90, 'Holman PCM wind direction is one of sixteen points');
  eq(out[0]?.light_lux, undefined, 'the short build reports no light');

  // This one really does sign-extend: an `int` holds it, unlike the PWM sibling below.
  const cold = seal([0x12, 0x34, 0xf9, 0xc4, 0x10, 0x64, 0x0c, 0x40, 0, 0, 0, 0, 0, 0, 0, 0]);
  const coldOut = run(d, rows(build(cold, 196)));
  eq((((0xf9 << 8) | 0xc0) << 16) >> 16, -1600, 'the cold frame\'s raw field is -1600 once sign-extended (premise)');
  eq(coldOut[0]?.temperature_C, -10, 'Holman PCM reads a sub-zero temperature correctly, unlike the PWM build');

  // The build with the light sensor: a longer frame, which is what selects the other branch.
  const uv = seal([0x12, 0x34, 0x0d, 0x74, 0x10, 0x64, 0x0c, 0x43, 0x9a, 0x05, 0x40, 0x2a, 0, 0, 0, 0, 0, 0]);
  const uvOut = run(d, rows(build(uv, 218)));
  eq(uvOut.length, 1, 'Holman PCM decodes the longer frame');
  eq(uvOut[0]?.model, 'AOK-5056', 'the longer frame is the build with a light sensor');
  eq(uvOut[0]?.rain_mm, 100, 'the AOK counts rain in whole millimeters, not units of 0.79');
  eq(uvOut[0]?.uvi, 7, 'AOK UV index is split across two bytes');
  eq(uvOut[0]?.light_lux, 26645, 'AOK light reading spans three bytes');
  eq(uvOut[0]?.counter, 42, 'AOK message counter');
  eq(uvOut[0]?.battery_ok, 1, 'AOK battery');

  // Rejections, each with the premise that the stated rule is what does the rejecting.
  const bad = Uint8Array.from(plain); bad[12] ^= 0xff;
  eq(run(d, rows(build(bad, 196))).length, 0, 'Holman PCM rejects a bad digest');
  eq(run(d, rows(build(plain, 180))).length, 0, 'Holman PCM rejects a frame under 192 bits');
  eq(run(d, rows(build(plain, 196), build(plain, 196))).length, 0, 'Holman PCM wants exactly one row');
  {
    // Past 220 bits neither branch claims it, even though the digest is perfectly good.
    const longRow = build(plain, 240);
    eq(lfsrReflectRef(Uint8Array.of(xorBytesRef(plain, 12)), 1, 0x00, 0x31), plain[12], 'the over-long frame still has a valid digest (premise)');
    eq(run(d, rows(longRow)).length, 0, 'Holman PCM reports nothing for a frame longer than either build');
  }
}

// ---- Holman WS5029 PWM (143) and its OOK twin (340) ----
{
  /** The frame the sensor means, before the line inverts it. */
  const frame = ({ id = 0x5a, batteryLow = 0, tempHi = 0x0, tempLo = 0xea, hum = 55, rain = 0x123, wind = 0x2c, dir = 6 } = {}) => {
    const b = new Uint8Array(12);
    b[0] = 0xaa; b[1] = 0xa5; b[2] = 0x98;
    b[3] = id;
    b[4] = (batteryLow << 7) | (tempHi & 0x0f);
    b[5] = tempLo;
    b[6] = hum;
    b[7] = (rain >> 4) & 0xff;
    b[8] = ((rain & 0x0f) << 4) | ((wind >> 4) & 0x0f);
    b[9] = ((wind & 0x0f) << 4) | (dir & 0x0f);
    b[10] = xorShiftRef(b, 10, 0x18);
    b[11] = 0x00;
    return b;
  };
  const wire = (b) => inv(bytesToBits(b));          // 96 bits, inverted on air

  for (const num of [143, 340]) {
    const d = dev(num);
    const b = frame();
    const w = wire(b);
    const out = run(d, rows(w, w, w));
    eq(out.length, 1, `Holman PWM (${num}) decodes a well-formed frame`);
    eq(out[0]?.id, 0x5a, `Holman PWM (${num}) id`);
    eq(out[0]?.temperature_C, 23.4, `Holman PWM (${num}) temperature`);
    eq(out[0]?.humidity, 55, `Holman PWM (${num}) humidity`);
    eq(out[0]?.rain_mm, round1ref(0x123 * 0.79), `Holman PWM (${num}) rain`);
    eq(out[0]?.wind_avg_km_h, 0x2c, `Holman PWM (${num}) wind`);
    eq(out[0]?.wind_dir_deg, 135, `Holman PWM (${num}) direction is truncated, not rounded`);
    eq(out[0]?.battery_ok, 1, `Holman PWM (${num}) battery`);

    eq(run(d, rows(w, w)).length, 0, `Holman PWM (${num}) needs three matching rows`);
    const short = w.slice(0, 95);
    eq(run(d, rows(short, short, short)).length, 0, `Holman PWM (${num}) wants exactly 96 bits`);
  }

  const d = dev(143);
  // The preamble is checked before the buffer is flipped, against its inverted form.
  {
    const b = frame(); b[0] = 0xab;                 // 0xab inverted is 0x54, not the 0x55 it looks for
    const w = wire(b);
    eq(run(d, rows(w, w, w)).length, 0, 'Holman PWM rejects a frame whose preamble is wrong');
  }
  {
    const b = frame(); b[10] ^= 0xff;
    const w = wire(b);
    eq(run(d, rows(w, w, w)).length, 0, 'Holman PWM rejects a bad checksum');
  }

  /*
   * The documented-but-untrue sign extension. Upstream casts to int16_t and then stores the result in a
   * uint16_t, so the sign is gone before the shift that was meant to preserve it. The premise below shows the
   * field genuinely reads as a sub-zero temperature when signed; the outcome shows what upstream actually
   * reports for it. Reproduced deliberately — see the note in weather5.ts.
   */
  {
    const raw = (0xf << 12) | (0xf6 << 4);          // 0xff60
    eq((raw << 16) >> 16, -160, 'the cold PWM field is -160 when sign-extended, i.e. -16.0 C (premise)');
    eq(raw >> 4, 4086, 'but read unsigned it is 4086, i.e. 408.6 C');
    const b = frame({ tempHi: 0xf, tempLo: 0xf6 });
    const w = wire(b);
    eq(run(d, rows(w, w, w))[0]?.temperature_C, 408.6,
      'Holman PWM reports 408.6 C for a sub-zero reading, matching upstream\'s unsigned variable exactly');
  }
}
function round1ref(x) { return Math.round(x * 10) / 10; }

// ---- Cotech 36-7959 (153): the one shipped capture ----
{
  const d = dev(153);
  const PAYLOAD = 'c6880000e80000846d20fffbfb39';   // {112}, the bits behind the run-in
  const row = [...bitsFromHex('0140', 12), ...bitsFromHex(PAYLOAD, 112)];

  const b = hexToBytes(PAYLOAD);
  eq(crc8ref(b, 14, 0x31, 0xc0), 0, 'the capture satisfies its CRC, computed independently');

  const out = run(d, rows(row));
  eq(out.length, 1, 'Cotech 36-7959 decodes its documented capture');
  eq(out[0]?.id, 104, 'Cotech 36-7959 id');
  eq(out[0]?.battery_ok, 0, 'Cotech 36-7959 reports a low battery in this capture');
  eq(out[0]?.temperature_F, 73.3, 'Cotech 36-7959 temperature is Fahrenheit, offset 400');
  eq(out[0]?.humidity, 32, 'Cotech 36-7959 humidity');
  eq(out[0]?.rain_mm, 0, 'Cotech 36-7959 rain');
  eq(out[0]?.wind_dir_deg, 232, 'Cotech 36-7959 wind direction');
  eq(out[0]?.wind_avg_m_s, 0, 'Cotech 36-7959 wind average');
  eq(out[0]?.wind_max_m_s, 0, 'Cotech 36-7959 gust');

  /*
   * This capture comes from a unit with no light sensor, which reports all ones rather than zero. The premise
   * is that the raw light value really is the all-ones pattern and the UV byte really is past the bound; the
   * outcome is that both fields are withheld instead of reporting a blazing day.
   */
  eq(b[12], 0xfb, 'the capture\'s UV byte is 0xfb (premise)');
  ok(b[12] > 150, 'which is past the bound upstream uses to spot an unfitted sensor (premise)');
  eq((b[10] << 8) | b[11] | ((b[7] & 0x80) << 9), 0x1fffb, 'and the light field would read 0x1fffb (premise)');
  eq(out[0]?.light_lux, undefined, 'so no light reading is reported');
  eq(out[0]?.uvi, undefined, 'and no UV index either');

  // A frame from a unit that does have the sensor, built from the transmit side.
  {
    const lit = hexToBytes(PAYLOAD);
    lit[7] = 0x04; lit[10] = 0x12; lit[11] = 0x34; lit[12] = 0x37;   // UV 5.5, a real lux figure
    lit[13] = crc8ref(lit, 13, 0x31, 0xc0);
    const r = [...bitsFromHex('0140', 12), ...bytesToBits(lit)];
    const o = run(d, rows(r));
    eq(o.length, 1, 'Cotech 36-7959 decodes a frame from a unit with a light sensor');
    eq(o[0]?.light_lux, 0x1234, 'and reports its light reading');
    eq(o[0]?.uvi, 5.5, 'and its UV index, scaled by ten');
  }

  // The corruption must land inside the bits the decoder reads.
  {
    const good = bitsFromHex(PAYLOAD, 112);
    const badBytes = hexToBytes(PAYLOAD); badBytes[4] ^= 0x01;
    const bad = bytesToBits(badBytes);
    ok(good.join('') !== bad.join(''), 'the corrupted payload really does differ (premise)');
    eq(run(d, rows([...bitsFromHex('0140', 12), ...bad])).length, 0, 'Cotech 36-7959 rejects a bad CRC');
  }
  eq(run(d, rows(row, row, row)).length, 0, 'Cotech 36-7959 accepts at most two rows');
  eq(run(d, rows(bitsFromHex(PAYLOAD, 100))).length, 0, 'Cotech 36-7959 rejects a row too short to hold a frame');
}

// ---- Cotech FT0203 (369): built from the transmit side ----
{
  const d = dev(369);
  ok(d.disabled === true, 'FT0203 is marked doubtful: upstream never confirmed it against a capture');

  const build = ({ id = 300, battery = 1, avg = 55, gust = 78, dir = 180 } = {}) => {
    const b = new Uint8Array(9);
    b[0] = 0x14;
    b[1] = (id >> 3) & 0xff;
    b[2] = ((id & 0x07) << 5) | (battery << 4)
      | (((dir >> 8) & 1) << 2) | (((gust >> 8) & 1) << 1) | ((avg >> 8) & 1);
    b[3] = avg & 0xff; b[4] = gust & 0xff; b[5] = dir & 0xff;
    b[6] = 0xff; b[7] = 0xff;
    b[8] = crc8ref(b, 8, 0x31, 0xc0);
    return b;
  };

  const b = build();
  eq(crc8ref(b, 9, 0x31, 0xc0), 0, 'appending the CRC makes the whole frame check to zero (premise)');
  const out = run(d, rows(bytesToBits(b)));
  eq(out.length, 1, 'FT0203 decodes a well-formed frame');
  eq(out[0]?.id, 300, 'FT0203 id spans eleven bits');
  eq(out[0]?.battery_ok, 1, 'FT0203 battery bit is one for healthy, the opposite of its 36-7959 sibling');
  eq(out[0]?.wind_avg_m_s, 5.5, 'FT0203 wind average');
  eq(out[0]?.wind_max_m_s, 7.8, 'FT0203 gust');
  eq(out[0]?.wind_dir_deg, 180, 'FT0203 wind direction');

  eq(run(d, rows(bytesToBits(build({ battery: 0 }))))[0]?.battery_ok, 0, 'FT0203 reports a low battery');
  eq(run(d, rows(bytesToBits(build({ dir: 300 }))))[0]?.wind_dir_deg, 300, 'FT0203 direction uses its ninth bit');

  // It searches every bit offset, so a frame behind arbitrary junk is still found.
  eq(run(d, rows([1, 0, 1, 1, 0, ...bytesToBits(b)]))[0]?.id, 300, 'FT0203 finds a frame at a shifted offset');

  {
    const bad = build(); bad[3] ^= 0x01;            // inside the CRC's range, and not the sync or the 0xffff
    ok(crc8ref(bad, 9, 0x31, 0xc0) !== 0, 'the corrupted frame really does fail the CRC (premise)');
    eq(run(d, rows(bytesToBits(bad))).length, 0, 'FT0203 rejects a bad CRC');
  }
  {
    const bad = build(); bad[6] = 0xfe; bad[8] = crc8ref(bad, 8, 0x31, 0xc0);
    eq(crc8ref(bad, 9, 0x31, 0xc0), 0, 'the wrong-constant frame has a valid CRC (premise)');
    eq(run(d, rows(bytesToBits(bad))).length, 0, 'FT0203 still rejects it on the fixed 0xffff');
  }
}

// ---- Cotech 36-7900 rain gauge (382): built from the transmit side ----
{
  const d = dev(382);
  ok(d.disabled === true, 'the 36-7900 is marked doubtful: it has no computed check at all');

  const build = ({ tempRaw = 185, rain = 1234, reserved = [0, 0, 0] } = {}) => {
    const b = new Uint8Array(8);
    b[0] = 0xab;
    b[1] = 0x80 | ((tempRaw >> 8) & 0x0f);
    b[2] = tempRaw & 0xff;
    b[3] = reserved[0]; b[4] = reserved[1]; b[5] = reserved[2];
    b[6] = (rain >> 4) & 0xff;
    b[7] = (rain & 0x0f) << 4;
    return bytesToBits(b).slice(0, 60);             // sixty bits, so the last nibble is dropped
  };

  const r = build();
  const out = run(d, rows(r, r, r, r, r, r, r, r));
  eq(out.length, 1, 'the 36-7900 decodes a well-formed frame repeated eight times');
  eq(out[0]?.id, 0xab80, 'the 36-7900 marker doubles as an id');
  eq(out[0]?.temperature_C, 18.5, 'the 36-7900 temperature');
  eq(out[0]?.rain_raw, 1234, 'the 36-7900 rain stays a raw count, since no mm-per-tip was ever measured');
  eq(out[0]?.rain_mm, undefined, 'and is deliberately not converted to millimeters');

  {
    const cold = build({ tempRaw: 0xfff });          // twelve bits, so this is -1
    const o = run(d, rows(cold, cold, cold, cold, cold, cold, cold, cold));
    eq(o[0]?.temperature_C, -0.1, 'the 36-7900 temperature is signed across twelve bits');
  }

  eq(run(d, rows(r, r, r, r, r, r, r)).length, 0, 'the 36-7900 needs eight matching rows');
  {
    // The reserved span is the only thing standing in for a checksum, so it has to be load-bearing.
    const noisy = build({ reserved: [0, 0x01, 0] });
    eq(run(d, rows(noisy, noisy, noisy, noisy, noisy, noisy, noisy, noisy)).length, 0,
      'the 36-7900 rejects a frame whose always-zero span is not zero');
  }
  {
    const wrongMarker = build(); wrongMarker[0] ^= 1;
    eq(run(d, rows(...new Array(8).fill(wrongMarker))).length, 0, 'the 36-7900 rejects a frame without its marker');
  }
}

// ---- Vevor 7-in-1 (263): the documented sample frame ----
{
  const d = dev(263);
  const SAMPLE = 'AA00f8f79d02e332010e03020b013802397a86e087';
  const b = hexToBytes(SAMPLE);

  /*
   * The premise behind trusting the shared masked helper here: this frame's byte sum genuinely overflows a
   * byte, and it is the narrowed sum that the frame carries. Upstream narrows it explicitly, so masking is
   * correct rather than the hazard it has been in other decoders.
   */
  let full = 0; for (let i = 0; i < 19; i++) full += b[i];
  eq(full, 1504, 'the sample frame\'s byte sum is 1504 (premise)');
  ok(full > 0xff, 'which overflows a byte, so the narrowing is load-bearing (premise)');
  eq(full & 0xff, b[19], 'and the narrowed sum is what the frame carries');

  // The run-in, the frame, then padding: the decoder wants a whole message length behind the run-in.
  const row = [...bytesToBits(hexToBytes('aaaacaca54')), ...bytesToBits(b)];
  while (row.length < 264) row.push(0);

  const out = run(d, rows(row));
  eq(out.length, 1, 'Vevor decodes its documented sample frame');
  eq(out[0]?.id, 0xf8f7, 'Vevor id');
  eq(out[0]?.channel, 0, 'Vevor channel');
  eq(out[0]?.battery_ok, 0, 'Vevor reports a low battery in this frame');
  eq(out[0]?.temperature_C, 23.9, 'Vevor temperature, offset 500');
  eq(out[0]?.humidity, 50, 'Vevor humidity');
  eq(out[0]?.wind_avg_km_h, 1.6, 'Vevor wind average, once the constant 257 comes off');
  eq(out[0]?.wind_max_km_h, 2.4, 'Vevor gust');
  eq(out[0]?.wind_dir_deg, 266, 'Vevor wind direction, likewise offset by 257');
  eq(out[0]?.rain_mm, 12.8, 'Vevor rain');
  eq(out[0]?.uvi, 1, 'Vevor UV index, offset by one');
  eq(out[0]?.light_lux, 14457, 'Vevor light reading');

  // The light field's top bit is a times-ten flag, which is how it reaches past 32767.
  {
    const bright = hexToBytes(SAMPLE);
    bright[16] = 0xc0; bright[17] = 0x01;           // 0xc001 - 257 has its top bit set
    let s = 0; for (let i = 0; i < 19; i++) s += bright[i];
    bright[19] = s & 0xff;
    const r = [...bytesToBits(hexToBytes('aaaacaca54')), ...bytesToBits(bright)];
    while (r.length < 264) r.push(0);
    const raw = ((0xc0 << 8) | 0x01) - 257;
    ok((raw & 0x8000) >> 15 === 1, 'the bright frame\'s light value has its flag bit set (premise)');
    eq(run(d, rows(r))[0]?.light_lux, (raw & 0x7fff) * 10, 'Vevor multiplies by ten when the flag is set');
  }

  {
    const bad = hexToBytes(SAMPLE); bad[19] ^= 0xff;
    const r = [...bytesToBits(hexToBytes('aaaacaca54')), ...bytesToBits(bad)];
    while (r.length < 264) r.push(0);
    eq(run(d, rows(r)).length, 0, 'Vevor rejects a bad checksum');
  }
  eq(run(d, rows(row, row)).length, 0, 'Vevor wants exactly one row');
  {
    const short = row.slice(0, 200);
    eq(run(d, rows(short)).length, 0, 'Vevor needs a whole message length behind the run-in');
  }
}

// ---- Sainlogic SA8 (293): the documented sample frame, and upstream's broken CRC ----
{
  const d = dev(293);
  const SAMPLE = '465424cdab260cd0bdc37539e339e3e844f3006f003d0000000000b4007e00410053000000f110171d';
  const b = hexToBytes(SAMPLE);
  eq(b.length, 41, 'the sample frame is 41 bytes');

  /*
   * The heart of this file's disagreement with upstream, asserted from both directions.
   *
   * Upstream computes an unreflected CRC-16 with poly 0x8005 and compares it against the frame's last two
   * bytes read low-first. That produces 0x59b4 against a stored 0x1d17 — no match, on upstream's own sample.
   * Its comment ("crc checksum here when guessed") says the parameters were never confirmed, and the code
   * never rejects on the result, which is the only reason the decoder works at all.
   *
   * Exactly one conventional configuration validates the frame, and it is the reflected twin of that guess:
   * CRC-16/MODBUS, poly 0xa001 which is 0x8005 reversed, init 0xffff, the same 36 bytes, high byte first.
   */
  eq(crc16ref(b, 3, 36, 0x8005, 0xffff), 0x59b4, 'upstream\'s own parameters give 0x59b4');
  eq((b[40] << 8) | b[39], 0x1d17, 'and it compares that against 0x1d17, so it never matches');
  eq(crc16lsbRef(b, 3, 36, 0xa001, 0xffff), 0x171d, 'the reflected form gives 0x171d');
  eq((b[39] << 8) | b[40], 0x171d, 'which is exactly what the frame stores, high byte first');

  /** The payload rides as 8N1 serial behind a two-byte run-in. */
  const wireOf = (bytes) => {
    const bits = bytesToBits(hexToBytes('fc95'));
    for (const v of bytes) bits.push(...uartBits(v));
    return bits;
  };

  const out = run(d, rows(wireOf(b)));
  eq(out.length, 1, 'Sainlogic decodes its documented sample frame');
  eq(out[0]?.id, 'abcd0c26bdd0', 'Sainlogic id is six bytes stored as three little-endian pairs');
  eq(out[0]?.counter, 17640, 'Sainlogic message counter');
  eq(out[0]?.temperature_C, 11.1, 'Sainlogic temperature');
  eq(out[0]?.humidity, 61, 'Sainlogic humidity');
  eq(out[0]?.wind_avg_km_h, 4.5, 'Sainlogic wind average');
  eq(out[0]?.wind_max_km_h, 6.5, 'Sainlogic gust');
  eq(out[0]?.wind_dir_deg, 65, 'Sainlogic wind direction');
  eq(out[0]?.rain_mm, 35.6, 'Sainlogic rain');
  eq(out[0]?.battery_ok, 1, 'Sainlogic battery flag');
  eq(out[0]?.crc_ok, 1, 'the working CRC verifies the sample frame');
  eq(out[0]?.mic, 'CRC', 'so this reading is allowed to claim a verified check');

  /*
   * A damaged frame. Upstream would emit it labeled `mic: "CRC"` regardless, because it never rejects and
   * never looks at the outcome. This port emits it too — declining to reject is upstream's behavior and
   * dropping frames would be the bigger change — but withholds the badge it did not earn.
   */
  {
    const bad = hexToBytes(SAMPLE); bad[19] ^= 0x01;   // the temperature, well inside the CRC's span
    ok(crc16lsbRef(bad, 3, 36, 0xa001, 0xffff) !== ((bad[39] << 8) | bad[40]),
      'the damaged frame really does fail the working CRC (premise)');
    const o = run(d, rows(wireOf(bad)));
    eq(o.length, 1, 'Sainlogic still emits a frame that fails its CRC, as upstream does');
    eq(o[0]?.crc_ok, 0, 'but records that the check failed');
    eq(o[0]?.mic, undefined, 'and withholds the integrity badge');
    eq(o[0]?.temperature_C, 11, 'the damaged reading is reported as it arrived: 0x6f became 0x6e, so 11.1 became 11.0');
  }

  eq(run(d, rows(wireOf(b), wireOf(b))).length, 0, 'Sainlogic wants exactly one row');
  eq(run(d, rows(wireOf(b.slice(0, 30)))).length, 0, 'Sainlogic rejects a frame short of 41 bytes');
  eq(run(d, rows(bytesToBits(b))).length, 0, 'Sainlogic finds nothing without its run-in');
}

// ---- Bresser SmartHome Garden (384): four real frames from three devices ----
{
  const d = dev(384);
  /** Pad a documented frame to its fixed 33 bytes: header, payload at b[11], CRC at b[31]. */
  const pad = (head, payload, tail) => {
    const b = new Uint8Array(33);
    b.set(hexToBytes(head), 0);
    if (payload) b.set(hexToBytes(payload), 11);
    b.set(hexToBytes(tail), 31);
    return b;
  };
  /** Four lead-in bytes, the sync word, then the frame. */
  const wireOf = (b) => bytesToBits(Uint8Array.from([0xaa, 0xaa, 0xaa, 0xaa, 0xf3, 0xe9, 0x10, 0x5e, 0x51, ...b]));

  const SOIL = pad('9c0d001fb50500470f0909', '0e060008882f859402', '12c5');
  const RELAY = pad('c20e00019c0d001f230a09', '06061708882f859402', '5ac0');
  const ACK = pad('9c0d001fc20e0001238a01', '00', '39d0');
  const WATER = pad('c20e00019c0d001f17040e', '060101adaee4192105000000 3c00', 'd8e0');

  for (const [name, f] of [['soil 0x09', SOIL], ['relay 0x0a', RELAY], ['ack 0x8a', ACK], ['watering 0x04', WATER]]) {
    eq(crc16ref(f, 0, 33, 0x1021, 0xd636), 0, `the ${name} frame satisfies its CRC, computed independently`);
  }

  // The soil probe's own reading, sent to the valve.
  {
    const o = run(d, rows(wireOf(SOIL)));
    eq(o.length, 1, 'the garden set decodes the soil probe frame');
    eq(o[0]?.model, 'Bresser-SoilMoisture', 'the model comes from the sender\'s class byte, not the message type');
    eq(o[0]?.msg_name, 'Soil telemetry', 'soil telemetry');
    eq(o[0]?.id, 0x470005b5, 'soil probe source id');
    eq(o[0]?.station_id, 0x1f000d9c, 'addressed to its paired valve');
    eq(o[0]?.msg_counter, 15, 'message counter');
    eq(o[0]?.moisture, 47, 'soil moisture, as the upstream comment states');
    eq(o[0]?.temperature_F, 66, 'soil temperature in Fahrenheit, as the upstream comment states');
    eq(o[0]?.battery_ok, 1, 'soil probe battery');
    eq(o[0]?.battery_level, 8, 'soil probe battery level');
    eq(o[0]?.soil_rssi, undefined, 'the probe\'s own frame carries no signal strength; only the relay adds it');
    eq(o[0]?.mic, 'CRC', 'the garden set has a real CRC');
  }
  // The valve relaying that same reading, with the signal strength it measured inserted.
  {
    const o = run(d, rows(wireOf(RELAY)));
    eq(o[0]?.model, 'Bresser-WaterTimer', 'the relay is reported as the valve, since the valve sent it');
    eq(o[0]?.msg_name, 'Relay telemetry', 'relay telemetry');
    eq(o[0]?.id, 0x1f000d9c, 'valve source id');
    eq(o[0]?.station_id, 0x01000ec2, 'addressed to the gateway');
    eq(o[0]?.soil_rssi, 0x17, 'the relay inserts the probe\'s signal strength');
    eq(o[0]?.moisture, 47, 'and forwards the same moisture reading');
    eq(o[0]?.temperature_F, 66, 'and the same temperature');
  }
  // The gateway's empty acknowledgement of that relay.
  {
    const o = run(d, rows(wireOf(ACK)));
    eq(o[0]?.model, 'Bresser-Gateway', 'the acknowledgement is reported as the gateway');
    eq(o[0]?.msg_name, 'Acknowledgement', 'an empty acknowledgement');
    eq(o[0]?.msg_type, 0x8a, 'its type is the acked type with bit seven set');
    eq(o[0]?.acknowledgement, 1, 'and it is flagged as a reply');
    eq(o[0]?.msg_counter, 35, 'echoing the counter of the message it acks');
  }
  // A watering run that actually delivered water.
  {
    const o = run(d, rows(wireOf(WATER)));
    eq(o[0]?.model, 'Bresser-WaterTimer', 'the watering event comes from the valve');
    eq(o[0]?.msg_name, 'Watering', 'a watering event');
    eq(o[0]?.trigger, 0x21, 'trigger 0x21 is a manual, normal run, as the upstream comment states');
    eq(o[0]?.duration_s, 60, 'and it ran for 60 seconds, as the upstream comment states');
    eq(o[0]?.programme, 0xadae, 'the programme id is read big-endian so its hex reads as sent');
    eq(o[0]?.cycle_counter, 6628, 'the cycle counter is little-endian, unlike the programme id');
  }

  // The class byte decides the model, including its fallback.
  {
    const roles = [[0x47, 'Bresser-SoilMoisture'], [0x1f, 'Bresser-WaterTimer'], [0x01, 'Bresser-Gateway'], [0x99, 'Bresser-Garden']];
    for (const [cls, model] of roles) {
      const f = Uint8Array.from(SOIL);
      f[7] = cls;
      const c = crc16ref(f, 0, 31, 0x1021, 0xd636);
      f[31] = c >> 8; f[32] = c & 0xff;
      eq(crc16ref(f, 0, 33, 0x1021, 0xd636), 0, `the resealed 0x${cls.toString(16)} frame checks out (premise)`);
      eq(run(d, rows(wireOf(f)))[0]?.model, model, `class byte 0x${cls.toString(16)} reports as ${model}`);
    }
  }

  // A declared payload longer than the frame can hold is refused, however good the CRC is.
  {
    const f = Uint8Array.from(SOIL);
    f[10] = 21;                                     // the payload only runs b[11]..b[30]
    const c = crc16ref(f, 0, 31, 0x1021, 0xd636);
    f[31] = c >> 8; f[32] = c & 0xff;
    eq(crc16ref(f, 0, 33, 0x1021, 0xd636), 0, 'the over-long frame has a perfectly valid CRC (premise)');
    eq(run(d, rows(wireOf(f))).length, 0, 'but the garden set refuses a payload length past the frame');
  }

  // An unmapped type is still reported, with its payload raw rather than guessed at.
  {
    const f = Uint8Array.from(SOIL);
    f[9] = 0x77;                                    // no branch claims this
    const c = crc16ref(f, 0, 31, 0x1021, 0xd636);
    f[31] = c >> 8; f[32] = c & 0xff;
    const o = run(d, rows(wireOf(f)));
    eq(o.length, 1, 'an unrecognized message type is still reported');
    eq(o[0]?.msg_name, 'Unknown msg', 'and labeled as unknown');
    eq(o[0]?.msg, '0e060008882f859402', 'with its payload emitted as raw hex');
  }

  // The corruption must land inside the bytes the CRC covers.
  {
    const bad = Uint8Array.from(SOIL);
    bad[16] ^= 0x01;                                // the moisture byte, well inside the CRC's span
    ok(crc16ref(bad, 0, 33, 0x1021, 0xd636) !== 0, 'the damaged frame really does fail its CRC (premise)');
    eq(run(d, rows(wireOf(bad))).length, 0, 'the garden set rejects a damaged frame');
  }
  eq(run(d, rows(wireOf(SOIL), wireOf(SOIL))).length, 0, 'the garden set wants exactly one row');
  eq(run(d, rows(bytesToBits(SOIL))).length, 0, 'the garden set finds nothing without its sync word');
  {
    const shortRow = wireOf(SOIL).slice(0, 72 + 200);
    eq(run(d, rows(shortRow)).length, 0, 'the garden set needs a whole 33-byte frame behind the sync word');
  }
}

// ---- The registrations themselves ----
{
  for (const num of [134, 143, 153, 263, 293, 340, 369, 382, 384]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
