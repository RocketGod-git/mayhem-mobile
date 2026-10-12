/**
 * Telemetry, tire sensors and assorted radios.
 *
 * Steelmate and Telldus are checked against the real captures rtl_433 ships, and those are the strongest
 * evidence in the file: Steelmate's is published alongside the exact bytes it is known to translate to, and
 * Telldus ships two that between them exercise both of that decoder's output branches. The FSL scoreboard also
 * publishes a frame, and reading it turned up a genuine off-by-one in that file's documentation — asserted
 * below rather than quietly worked around.
 *
 * Everything else is built from the transmit side: the bytes are laid out as the sensor would send them, run
 * through whatever line code and whitening it applies, and only then handed to the decoder.
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
/** Several of these need more than one row: a repeated transmission is the only check some of them have. */
const rowsBits = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((r, i) => { if (i) bb.addRow(); for (const v of r) bb.addBit(v); });
  return bb;
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
/** rtl_433 writes its codes as {bits}hexdigits. */
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/ /g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
/** Our Manchester decoder emits the second half of each pair, so a one goes out as 01 and a zero as 10. */
const manchester = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };
const inv = (bits) => bits.map(b => b ^ 1);
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/ /g, '').match(/../g).map(x => parseInt(x, 16)));
const bitsDiffer = (a, b) => a.length !== b.length || a.some((v, i) => v !== b[i]);

console.log('Steelmate, RadioHead, Digitech, Companion, Telldus, ANT+, Shenzhen, Gear Hive and a scoreboard');

// ---- Steelmate (59): the real capture rtl_433 publishes, with its documented translation ----
{
  // {72} 00 00 7f 3c f0 d7 ad 8e fa, documented as translating to 00 00 01 c3 f0 14 4a 8e a0.
  const RAW = '00007f3cf0d7ad8efa';
  const WANT = '000001c3f014 4a8ea0'.replace(/ /g, '');

  // Assert the premise: the translation really is an inversion plus a per-byte bit reversal, and the
  // documented check byte really is the sum of the six before it.
  {
    const raw = hexToBytes(RAW), want = hexToBytes(WANT);
    const t = Uint8Array.from(raw, v => ~v & 0xff);
    U.reflectBytes(t, 9);
    // Upstream's row prints the two sync bytes untranslated, but the code inverts the whole frame, so they
    // really come out 0xff. Nothing reads them, so the difference is presentational — hence bytes two onward.
    ok(t.slice(2).every((v, i) => v === want[i + 2]), 'the Steelmate capture translates to its documented bytes',
      Array.from(t, v => v.toString(16).padStart(2, '0')).join(''));
    eq(t[0], 0xff, '  the sync bytes inverting to 0xff is why the documented row shows them untranslated');
    let s = 0;
    for (let i = 2; i < 8; i++) s += want[i];
    eq(s & 0xff, want[8], '  and those bytes really do sum to the documented check byte');
    ok(s > 0xff, '  the sum overflows a byte, so the mask upstream applies is load-bearing');

    /**
     * That checksum equation is what settles a contradiction in the same comment. Upstream's layout row reads
     * `SS SS AA II II PP TT BB CC`, putting pressure at byte five, which this frame has as 0x14 — and its
     * checksum equation sums exactly bytes two to seven to reach 0xa0, confirming that assignment. But the
     * prose bullet for P illustrates the scale with "0xA0 / 32 = 5 Bar", quoting the *check* byte instead.
     * The bullets for temperature and battery both quote the right bytes, which localizes the error to that
     * one line. The port follows the bits.
     */
    eq(want[5], 0x14, '  the pressure byte in this frame is 0x14, not the 0xa0 the comment illustrates with');
    eq(want[8], 0xa0, '  0xa0 is the check byte, which is what that comment actually quoted');
  }

  const d = run(dev(59), rowBits(bitsFromHex(RAW, 72)))[0];
  ok(!!d, 'Steelmate real capture decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Steelmate', '  Steelmate model');
    eq(d.type, 'TPMS', '  reported as a tire pressure sensor');
    eq(d.id, '0xc3f0', '  Steelmate documented sensor id');
    eq(d.pressure_kPa, 62.5, '  0x14 is twenty thirty-seconds of a bar, which is 62.5 kPa');
    eq(d.temperature_C, 24, '  Steelmate documented temperature');
    eq(d.battery_mV, 2480, '  Steelmate documented battery voltage');
    ok(d.alarm === undefined, '  a normal battery byte raises no leak alarm');
    eq(d.mic, 'CHECKSUM', '  Steelmate reports its check');
  }

  // Build from the transmit side to reach the two alarm values, which no capture covers.
  const build = (bytes) => {
    const b = Uint8Array.from(bytes);
    b[8] = U.addBytes(b, 6, 2);
    // The sensor sends each byte bit-reversed and inverted; undoing that is what the decoder does.
    return rowBits(bytesToBits(Uint8Array.from(b, v => ~U.reverse8(v) & 0xff)));
  };
  // The sync bytes are 0x00 on air, which is 0xff once the frame has been inverted and reversed.
  const base = [0xff, 0xff, 0x01, 0xc3, 0xf0, 0x14, 0x4a, 0x8e, 0x00];

  const fast = run(dev(59), build([...base.slice(0, 7), 0xff, 0]))[0];
  ok(!!fast && fast.alarm === 'fast leak', 'a battery byte of 0xff is a fast leak alarm', JSON.stringify(fast));
  ok(fast && fast.battery_mV === undefined, '  and carries no battery voltage');
  const slow = run(dev(59), build([...base.slice(0, 7), 0xfe, 0]))[0];
  ok(!!slow && slow.alarm === 'slow leak', 'a battery byte of 0xfe is a slow leak alarm', JSON.stringify(slow));
  ok(slow && slow.battery_mV === undefined, '  and carries no battery voltage either');
  ok(!!run(dev(59), build([...base.slice(0, 7), 0xfd, 0]))[0]?.battery_mV,
    '  0xfd is still an ordinary voltage');

  // Corruption has to touch a bit the decoder reads: flip one in the pressure byte.
  {
    const good = bitsFromHex(RAW, 72);
    const bad = [...good]; bad[5 * 8 + 3] ^= 1;
    ok(bitsDiffer(good, bad), '  the corrupted Steelmate frame really does differ');
    ok(!run(dev(59), rowBits(bad))[0], '  Steelmate rejects a frame failing its checksum');
  }

  // Only four row lengths are this sensor; anything else is other traffic.
  ok(!run(dev(59), rowBits(bitsFromHex(RAW, 71)))[0], '  Steelmate ignores a row of the wrong length');
  ok(!!run(dev(59), rowBits(pad(bitsFromHex(RAW, 72), 208)))[0], '  but accepts the triple-length row');
}

// ---- RadioHead ASK (67) and Sensible Living (103) ----
{
  const SYMBOLS = [0x0d, 0x0e, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x23, 0x25, 0x26, 0x29, 0x2a, 0x2c, 0x32, 0x34];
  /** Each nibble becomes a six-bit symbol, and both symbols go out least significant bit first. */
  const encode6 = (v) => { const out = []; for (let i = 0; i < 6; i++) out.push((v >> i) & 1); return out; };
  const encodeByte = (b) => [...encode6(SYMBOLS[b >> 4]), ...encode6(SYMBOLS[b & 0xf])];

  /** Lay out a whole RadioHead frame: length byte, four headers, the body, and a complemented CRC. */
  const frame = (headers, body) => {
    const msgLen = 1 + 4 + body.length + 2;
    const p = new Uint8Array(msgLen);
    p[0] = msgLen;
    p.set(headers, 1);
    p.set(body, 5);
    const crc = ~U.crc16lsb(p, msgLen - 2, 0x8408, 0xffff) & 0xffff;
    p[msgLen - 2] = crc & 0xff;
    p[msgLen - 1] = crc >> 8;
    return p;
  };
  const buildRow = (p, corrupt) => {
    const bits = [...bytesToBits([0x55, 0x55, 0x55, 0x51, 0xcd])];
    for (const b of p) bits.push(...encodeByte(b));
    if (corrupt !== undefined) bits[corrupt] ^= 1;
    return rowBits(pad(bits, bits.length + 16));
  };

  const body = [0x11, 0x22, 0x33, 0x44];
  const p = frame([0x42, 0x07, 0x99, 0x0f], body);
  ok((~U.crc16lsb(p, p.length - 2, 0x8408, 0xffff) & 0xffff) === ((p[p.length - 1] << 8) | p[p.length - 2]),
    'the RadioHead frame carries the CRC its own decoder recomputes');

  const d = run(dev(67), buildRow(p))[0];
  ok(!!d, 'RadioHead ASK decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'RadioHead-ASK', '  RadioHead model');
    eq(d.len, body.length, '  the body length is the frame length less its framing');
    eq(d.to, 0x42, '  RadioHead destination address');
    eq(d.from, 0x07, '  RadioHead source address');
    eq(d.id, 0x99, '  RadioHead message id');
    eq(d.flags, 0x0f, '  RadioHead flags');
    eq(JSON.stringify(d.payload), JSON.stringify(body), '  RadioHead payload comes through intact');
    eq(d.mic, 'CRC', '  RadioHead reports its check');
  }

  // A flipped payload bit must fail the CRC rather than being reported.
  ok(!run(dev(67), buildRow(p, 40 + 12 * 6 + 3))[0], '  RadioHead rejects a frame failing its CRC');

  // Six-bit symbols are three ones and three zeros; anything else is not a legal symbol at all.
  {
    const bits = [...bytesToBits([0x55, 0x55, 0x55, 0x51, 0xcd]), ...encode6(0x3f), ...encode6(SYMBOLS[0])];
    ok(!SYMBOLS.includes(0x3f), '  0x3f is genuinely not in the symbol table');
    ok(!run(dev(67), rowBits(pad(bits, 200)))[0], '  RadioHead rejects a symbol outside its table');
  }
  // The run-in has to be there.
  ok(!run(dev(67), rowBits(pad(encodeByte(0x11), 200)))[0], '  RadioHead needs its run-in');

  // A frame too short to hold headers and a body is framing only, and is not a reading.
  ok(!run(dev(67), buildRow(frame([1, 2, 3, 4], [])))[0], '  RadioHead refuses a frame with no body');

  // Sensible Living: the same wire format, read as named fields.
  {
    const sl = frame([0x1f, 0x02, 0x55, 0x03], [0x07, 0x01, 0x04, 0xd2, 0x01, 0x2c]);
    eq(sl[0], 13, 'the Sensible Living frame is thirteen bytes, enough for every field it reads');
    const s = run(dev(103), buildRow(sl))[0];
    ok(!!s, 'Sensible Living decodes', JSON.stringify(s));
    if (s) {
      eq(s.model, 'SensibleLiving-Moisture', '  Sensible Living model');
      eq(s.house_id, 0x1f, '  house id');
      eq(s.module_id, 0x0255, '  module id spans two bytes');
      eq(s.sensor_type, 0x03, '  sensor type');
      eq(s.sensor_count, 0x07, '  sensor count');
      eq(s.alarms, 0x01, '  alarms');
      eq(s.sensor_value, 0x04d2, '  sensor value spans two bytes');
      eq(s.battery_mV, 0x012c * 10, '  battery is reported in hundredths of a volt and scaled to millivolts');
      eq(s.mic, 'CRC', '  Sensible Living reports its check');
    }
    // Both registrations share one extractor, so a bad CRC must stop this one too.
    ok(!run(dev(103), buildRow(sl, 40 + 12 * 3 + 1))[0], '  Sensible Living rejects a frame failing its CRC');
  }
}

// ---- Digitech XC-0324 (120): three copies per transmission, and it counts them ----
{
  const message = (id, temp, hum) => {
    const b = new Uint8Array(6);
    b[0] = 0x5f;                                     // preamble, and part of the message
    b[1] = id;
    b[2] = U.reverse8(temp & 0xff);                  // everything numeric goes out least significant bit first
    b[3] = U.reverse8((temp >> 8) & 0x0f);
    b[4] = U.reverse8(hum);
    b[5] = b[0] ^ b[1] ^ b[2] ^ b[3] ^ b[4];
    return b;
  };
  /** Three repeats separated by two zero bits, which is how the sensor fills its 148-bit transmission. */
  const build = (copies) => {
    const bits = [];
    copies.forEach((c, i) => { if (i) bits.push(0, 0); bits.push(...bytesToBits(c)); });
    return rowBits(bits);
  };

  const m = message(0xa7, 615, 48);                  // 615 tenths above minus forty is 21.5 C
  eq(U.xorBytes(m, 6), 0, 'the Digitech check byte closes the exclusive-or over the message');
  eq(bytesToBits(m).length * 3 + 4, 148, 'three copies and two separators are the documented 148 bits');

  const d = run(dev(120), build([m, m, m]))[0];
  ok(!!d, 'Digitech XC-0324 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Digitech-XC0324', '  Digitech model');
    eq(d.id, 'A7', '  Digitech id is printed as uppercase hex');
    eq(d.temperature_C, 21.5, '  Digitech temperature counts tenths above minus forty');
    eq(d.humidity, 48, '  Digitech humidity');
    eq(d.message_num, 3, '  all three copies were counted');
    eq(d.mic, 'CHECKSUM', '  Digitech reports its check');
  }

  // A damaged copy is dropped but the transmission still reads, with a lower count.
  const bad = Uint8Array.from(m); bad[2] ^= 0x10;
  const d2 = run(dev(120), build([m, bad, m]))[0];
  ok(!!d2, 'a transmission with one bad copy still decodes', JSON.stringify(d2));
  eq(d2?.message_num, 2, '  and reports only the copies that passed');
  eq(d2?.temperature_C, 21.5, '  taking its reading from a good copy');

  ok(run(dev(120), build([bad, bad, bad])).length === 0, '  three bad copies produce no reading at all');
  ok(run(dev(120), rowBits(bytesToBits(m).slice(0, 40))).length === 0, '  a row too short to hold a message is ignored');
}

// ---- Companion WTR001 (126): fourteen bits, inverted, with the degrees scattered ----
{
  /**
   * Lay the fourteen bits out in transmission order. The whole degrees are sent in the order
   * 12, 7, 6, 11, 10, 9, 8, so each one is placed individually rather than shifted into position.
   */
  const build = (whole, tenth, { fixedBit = 0, badParity = false, repeats = 3 } = {}) => {
    const air = new Array(14).fill(0);
    const tenthRaw = tenth + 0x0a;
    for (let i = 0; i < 5; i++) air[i] = (tenthRaw >> i) & 1;
    air[5] = fixedBit;
    air[12] = (whole >> 6) & 1;
    air[7] = (whole >> 5) & 1;
    air[6] = (whole >> 4) & 1;
    air[11] = (whole >> 3) & 1;
    air[10] = (whole >> 2) & 1;
    air[9] = (whole >> 1) & 1;
    air[8] = whole & 1;
    let x = 0;
    for (let i = 0; i < 13; i++) x ^= air[i];
    air[13] = badParity ? x : x ^ 1;                 // the count of set bits must come out odd
    // The sensor's short pulse is a one and the slicer's convention is the opposite, so the line is inverted.
    const row = inv(air);
    return rowsBits(new Array(repeats).fill(row));
  };

  const d = run(dev(126), build(62, 5))[0];
  ok(!!d, 'Companion WTR001 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Companion-WTR001', '  Companion model');
    eq(d.temperature_C, 21.5, '  62 whole and 5 tenths, offset by forty one');
    eq(d.mic, 'PARITY', '  Companion reports parity as its check');
  }
  eq(run(dev(126), build(11, 0))[0]?.temperature_C, -30, '  the bottom of the published range');
  eq(run(dev(126), build(111, 9))[0]?.temperature_C, 70.9, '  the top of the published range');

  ok(!run(dev(126), build(62, 5, { badParity: true }))[0], '  Companion rejects an even parity');
  ok(!run(dev(126), build(62, 5, { fixedBit: 1 }))[0], '  Companion rejects the fixed bit being set');
  ok(!run(dev(126), build(10, 5))[0], '  Companion rejects a temperature below its published range');
  ok(!run(dev(126), build(112, 5))[0], '  Companion rejects a temperature above its published range');
  ok(!run(dev(126), build(62, 5, { repeats: 2 }))[0], '  Companion needs three matching rows');

  // The fixed-bit gate runs before parity, so this frame must be refused by that gate and not by a bad parity.
  {
    const air = build(62, 5, { fixedBit: 1 });
    const b = air.bytes(0, 0, 14);
    b[0] = ~b[0] & 0xff; b[1] = ~b[1] & 0xfc;
    ok(U.parityBytes(b, 2) === 1, '  and that frame has valid parity, so it is the fixed bit being refused');
  }
}

// ---- Telldus FT0385R (205): both captures rtl_433 publishes ----
{
  const OUTDOOR = 'e1 23 00 0c 17 2b 0b 5a 09 34 00 00 00 00 00 03 00 1b 03 90 12 1b 12 1b 43 6e 4c 92 23 27 49 28 c8 ff fa fa 4b';
  const INDOOR_ONLY = 'e0 73 7f fb fb fb fb fb fb fb ff fb ff fb 3f fb ff fb ff fb ff fb ff fb 47 fb 7b 6c 26 27 0a 27 93 ff fb fb 97';

  for (const [name, hex] of [['outdoor', OUTDOOR], ['indoor-only', INDOOR_ONLY]]) {
    const b = hexToBytes(hex);
    eq(b.length, 37, `the Telldus ${name} capture is 37 bytes`);
    eq(U.crc8(b, 37, 0x31, 0xc0), 0, `  and passes CRC-8 poly 0x31 init 0xc0 over all of them`);
  }

  // The run-in is nine bits and the frame starts on the ninth, so eight bits precede it on the row.
  const build = (hex, flip) => {
    const bits = [...bytesToBits([0x14]), ...bytesToBits(hexToBytes(hex))];
    if (flip !== undefined) bits[8 + flip] ^= 1;
    return pad(bits, 320);
  };

  {
    const d = run(dev(205), rowBits(build(OUTDOOR)))[0];
    ok(!!d, 'Telldus outdoor capture decodes', JSON.stringify(d));
    if (d) {
      eq(d.model, 'Telldus-FT0385R', '  Telldus model');
      eq(d.temperature_F, 47.8, '  outdoor temperature');
      eq(d.humidity, 76, '  outdoor humidity');
      eq(d.temperature_2_F, 77, '  indoor temperature');
      eq(d.humidity_2, 35, '  indoor humidity');
      eq(d.pressure_hPa, 1005.7, '  pressure');
      eq(d.rain_mm, 463.5, '  rain total');
      eq(d.wind_dir_deg, 43, '  wind direction');
      eq(d.wind_avg_m_s, 1.2, '  wind average');
      eq(d.wind_max_m_s, 2.3, '  wind gust');
      eq(d.mic, 'CRC', '  Telldus reports its check');
    }
  }

  {
    const b = hexToBytes(INDOOR_ONLY);
    eq(((b[24] & 0x0f) << 8) | b[25], 0x7fb, 'the second capture carries the no-outdoor-data marker');
    const d = run(dev(205), rowBits(build(INDOOR_ONLY)))[0];
    ok(!!d, 'Telldus indoor-only capture decodes', JSON.stringify(d));
    if (d) {
      // A different transmission from the first capture, so its indoor readings differ from that one's.
      eq(d.temperature_2_F, 73.2, '  its indoor temperature is still reported');
      eq(d.humidity_2, 38, '  and its indoor humidity');
      eq(d.pressure_hPa, 999.4, '  and its pressure');
      ok(d.temperature_F === undefined, '  but no outdoor temperature is invented');
      ok(d.humidity === undefined, '  nor outdoor humidity');
      ok(d.wind_avg_m_s === undefined, '  nor wind');
      ok(d.rain_mm === undefined, '  nor rain');
    }
  }

  {
    const good = build(OUTDOOR), bad = build(OUTDOOR, 100);
    ok(bitsDiffer(good, bad), '  the corrupted Telldus frame really does differ');
    ok(!run(dev(205), rowBits(bad))[0], '  Telldus rejects a frame failing its CRC');
  }
  ok(!run(dev(205), rowsBits([build(OUTDOOR), build(OUTDOOR), build(OUTDOOR)]))[0],
    '  Telldus ignores a buffer of more than two rows');
  ok(!run(dev(205), rowBits(build(OUTDOOR).slice(0, 200)))[0], '  Telldus ignores a row too short to be whole');
}

// ---- ANT and ANT+ (216) ----
{
  const build = (netKey, { filler = null, payload = [1, 2, 3, 4, 5, 6, 7, 8], breakCrc = false } = {}) => {
    const b = new Uint8Array(17);
    b[0] = netKey & 0xff; b[1] = netKey >> 8;        // least significant byte first
    b[2] = 0x34; b[3] = 0x12;                        // device number, likewise
    b[4] = 0x78;                                     // device type
    b[5] = 0x05;                                     // transmission type
    b[6] = 10;                                       // payload length including the CRC, always ten
    b.set(payload, 7);
    const crc = U.crc16(b, 15, 0x1021, 0xffff);
    b[15] = crc >> 8; b[16] = crc & 0xff;
    if (breakCrc) b[16] ^= 1;
    const bits = [...bytesToBits([0xaa])];
    if (filler !== null) bits.push(filler);
    bits.push(...bytesToBits(b));
    return { row: rowBits(bits), b };
  };

  {
    const { b } = build(0xc5a6);
    eq(U.crc16(b, 17, 0x1021, 0xffff), 0, 'an ANT frame including its own CRC bytes checks to zero');
  }

  const d = run(dev(216), build(0xc5a6).row)[0];
  ok(!!d, 'ANT+ decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Garmin-ANT', '  ANT model');
    eq(d.network, 'ANT+', '  the published network key marks this as the managed ANT+ network');
    eq(d.channel, '0xc5a6', '  ANT network key');
    eq(d.id, '0x1234', '  ANT device number');
    eq(d.device_type, 0x78, '  ANT device type');
    eq(d.tx_type, 0x05, '  ANT transmission type');
    eq(d.payload, '01 02 03 04 05 06 07 08', '  ANT payload is printed the way ANT tools print it');
    eq(d.mic, 'CRC', '  ANT reports its check');
  }
  eq(run(dev(216), build(0x255b).row)[0]?.network, 'ANT', 'any other network key is a private ANT network');

  // The other run-in leaves the frame one bit further along, and the decoder finds it on its second attempt.
  {
    const { row, b } = build(0xc5a6, { filler: 1 });
    const firstTry = row.bytes(0, 8, 17 * 8);
    ok(U.crc16(firstTry, 17, 0x1021, 0xffff) !== 0, '  the first alignment genuinely fails, so the retry is real');
    const shifted = run(dev(216), row)[0];
    ok(!!shifted, '  ANT decodes a frame that needs the one-bit retry', JSON.stringify(shifted));
    eq(shifted?.channel, '0xc5a6', '  and reads the same network key from it');
    eq(U.crc16(b, 17, 0x1021, 0xffff), 0, '  the retried frame is the same bytes');
  }

  ok(!run(dev(216), build(0xc5a6, { breakCrc: true }).row)[0], '  ANT rejects a frame failing its CRC');
  // A message lasts under 150 microseconds; anything outside that window is not ANT.
  ok(!run(dev(216), rowBits(pad([], 119)))[0], '  ANT ignores a row too short to be a message');
  ok(!run(dev(216), rowBits(pad(bytesToBits(build(0xc5a6).b), 260)))[0], '  ANT ignores a row too long to be one');
}

// ---- Shenzhen Wale WL-TH6R (319) ----
{
  const build = (
    { id = 0x0a1b2c, tempRaw = 235, hum = 47, batt = 88, counter = 0x11, pairing = 0, rows = 2, breakMic = false } = {},
  ) => {
    const p = new Uint8Array(7);
    p[0] = (id >> 16) & 0xff; p[1] = (id >> 8) & 0xff; p[2] = id & 0xff;
    const t = tempRaw < 0 ? tempRaw + 0x10000 : tempRaw;
    p[3] = (t >> 8) & 0xff; p[4] = t & 0xff;
    p[5] = hum; p[6] = batt;

    const w7 = (pairing << 7) | counter;
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += p[i];         // full width, because the carry is folded into the check
    let mic = 0xa5 ^ U.xorBytes(p, 7) ^ (sum & 0xff) ^ (sum >> 8);
    if (breakMic) mic ^= 1;

    const w = new Uint8Array(9);
    for (let i = 0; i < 7; i++) w[i] = p[i] ^ w7;    // whitened with the byte sent alongside them
    w[7] = w7; w[8] = mic;
    // The line is inverted on top of the whitening.
    const row = bytesToBits(Uint8Array.from(w, v => ~v & 0xff));
    return { buf: rowsBits(new Array(rows).fill(row)), sum };
  };

  // Assert the premise the shared helper would break: the sum overflows a byte, so its carry is a real term.
  {
    const { sum } = build();
    ok(sum > 0xff, 'the Shenzhen payload sum overflows a byte, so the carry term is not zero', String(sum));
    const p = Uint8Array.from([0x0a, 0x1b, 0x2c, 0x00, 0xeb, 47, 88]);
    const full = 0xa5 ^ U.xorBytes(p, 7) ^ (sum & 0xff) ^ (sum >> 8);
    const masked = 0xa5 ^ U.xorBytes(p, 7) ^ U.addBytes(p, 7) ^ (U.addBytes(p, 7) >> 8);
    ok(full !== masked, '  and a masked sum would compute a different check byte', `${full} vs ${masked}`);
  }

  const d = run(dev(319), build().buf)[0];
  ok(!!d, 'Shenzhen WL-TH6R decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'WL-TH6R', '  Shenzhen model');
    eq(d.id, '0A1B2C', '  the id is printed as uppercase hex, matching what the base station reports');
    eq(d.temperature_C, 23.5, '  temperature counts tenths of a degree');
    eq(d.humidity, 47, '  humidity');
    eq(d.battery_pct, 88, '  battery percentage');
    eq(d.cycle, 0x11, '  measurement cycle counter');
    ok(d.battery_ok === undefined, '  a healthy battery reports no low-battery flag at all');
    ok(d.pairing === undefined, '  and a sensor not pairing reports no pairing flag');
    eq(d.mic, 'CHECKSUM', '  Shenzhen reports its check');
  }

  eq(run(dev(319), build({ tempRaw: -155 }).buf)[0]?.temperature_C, -15.5, 'temperature is signed');
  eq(run(dev(319), build({ batt: 12 }).buf)[0]?.battery_ok, 0, 'a battery under twenty percent is flagged low');
  eq(run(dev(319), build({ batt: 20 }).buf)[0]?.battery_ok, undefined, '  and exactly twenty percent is not');
  eq(run(dev(319), build({ pairing: 1, counter: 0x11 }).buf)[0]?.pairing, 1, 'the pairing bit is reported when set');
  eq(run(dev(319), build({ counter: 0x40 }).buf)[0]?.cycle, 0x40, 'the counter is pinned at its wrap value');
  eq(run(dev(319), build({ counter: 0x7f }).buf)[0]?.cycle, 0x40, '  including when uninitialized bits push it past');

  ok(!run(dev(319), build({ breakMic: true }).buf)[0], '  Shenzhen rejects a bad check byte');
  ok(!run(dev(319), build({ rows: 1 }).buf)[0], '  Shenzhen needs the row to have arrived twice');
  ok(!run(dev(319), build({ tempRaw: 650 }).buf)[0], '  Shenzhen rejects a temperature above its range');
  ok(!run(dev(319), build({ tempRaw: -250 }).buf)[0], '  Shenzhen rejects a temperature below its range');
  ok(!run(dev(319), build({ hum: 200 }).buf)[0], '  Shenzhen rejects an impossible humidity');

  // Upstream unwhitens in the shared buffer; this port must leave the caller's bits exactly as it found them.
  {
    const { buf } = build();
    const before = buf.rowHex(0);
    run(dev(319), buf);
    eq(buf.rowHex(0), before, '  Shenzhen leaves the shared bit buffer untouched');
  }
}

// ---- Gear Hive (322) ----
{
  const build = (
    { id = 0x4d3c2b, counter = 0x123, cls = 2, press = 0xf0, temp = 26, tail = 0x77, breakSix = false, breakSeven = false } = {},
  ) => {
    const tempBits = temp - 21;
    const p = new Uint8Array(9);
    p[0] = counter & 0xff;
    p[1] = ((counter >> 8) << 4) | cls;
    p[2] = (id >> 16) & 0xff; p[3] = (id >> 8) & 0xff; p[4] = id & 0xff;
    p[5] = press;
    p[6] = 0x20 | ((tempBits >> 2) & 0x03);          // fixed pattern, plus the top two temperature bits
    p[7] = ((tempBits & 0x03) << 6) | 0x35;          // fixed pattern, plus the bottom two
    p[8] = tail;                                     // labelled a checksum upstream, but never read
    if (breakSix) p[6] ^= 0x04;
    if (breakSeven) p[7] ^= 0x01;

    // Each byte on air is the running exclusive-or of the one before it, seeded from the sync word's low byte.
    const raw = new Uint8Array(9);
    raw[0] = p[0] ^ 0x94;
    for (let i = 1; i < 9; i++) raw[i] = raw[i - 1] ^ p[i];
    return rowBits([...bytesToBits([0x25, 0x94]), ...bytesToBits(raw)]);
  };

  const d = run(dev(322), build())[0];
  ok(!!d, 'Gear Hive decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Gear-Hive', '  Gear Hive model');
    eq(d.type, 'TPMS', '  reported as a tire pressure sensor');
    eq(d.id, '4d3c2b', '  Gear Hive sensor id');
    eq(d.counter, 0x123, '  the rolling counter spans a byte and a nibble');
    eq(d.temperature_C, 26, '  temperature is four bits offset by twenty one');
    // The zero point moves with the sensor class, so the raw byte is not scaled directly: class two bases at
    // 208, and 0xf0 is thirty-two counts above that, which reads as a plausible 200 kPa.
    eq(d.pressure_kPa, 200, '  pressure counts in sixteenths of a bar from a class-dependent base');
    eq(d.mic, 'CHECKSUM', '  Gear Hive claims a checksum, as upstream does');
  }

  // The class changes the pressure zero point, so the same raw byte reads differently.
  ok(run(dev(322), build({ cls: 3 }))[0]?.pressure_kPa !== d?.pressure_kPa,
    '  a different sensor class moves the pressure base');
  ok(0xf0 > ((80 + 2 * 64) & 0xff), '  and the reading above sits above its base, so it is not a wrapped one');
  // Below the base the subtraction wraps rather than going negative, which is what the modulo is there for.
  eq(run(dev(322), build({ press: 0xc0 }))[0]?.pressure_kPa, 1500, '  a byte below the base wraps modulo 256');

  ok(!run(dev(322), build({ breakSix: true }))[0], '  Gear Hive rejects a broken fixed pattern in byte six');
  ok(!run(dev(322), build({ breakSeven: true }))[0], '  Gear Hive rejects a broken fixed pattern in byte seven');

  /**
   * The last byte is called a checksum but is never read, so nothing about the frame forces it to be right.
   * Asserting that here keeps the gap recorded rather than implied by the `mic` field alone.
   */
  {
    const a = run(dev(322), build({ tail: 0x77 }))[0];
    const b = run(dev(322), build({ tail: 0x00 }))[0];
    ok(!!a && !!b, '  a frame decodes whatever its last byte holds');
    eq(JSON.stringify(a), JSON.stringify(b), '  the "checksum" byte is not verified and changes nothing');
  }

  // A flipped bit on air corrupts the byte it lands in and every byte after it, which is the chain's premise.
  {
    const good = build(), bad = build();
    const flipped = bad.bytes(0, 16, 72);
    flipped[2] ^= 0x08;
    ok(bitsDiffer(Array.from(good.bytes(0, 16, 72)), Array.from(flipped)), '  the corrupted chain really does differ');
    const p = new Uint8Array(9);
    p[0] = flipped[0] ^ 0x94;
    for (let i = 1; i < 9; i++) p[i] = flipped[i] ^ flipped[i - 1];
    const clean = build().bytes(0, 16, 72);
    const q = new Uint8Array(9);
    q[0] = clean[0] ^ 0x94;
    for (let i = 1; i < 9; i++) q[i] = clean[i] ^ clean[i - 1];
    ok(p[2] !== q[2] && p[3] !== q[3], '  one flipped bit corrupts two decoded bytes, as the running xor implies');
  }

  ok(!run(dev(322), rowBits(bytesToBits([0x25, 0x94, 0x00])))[0], '  Gear Hive ignores a row too short to hold a payload');
}

// ---- FSL cricket scoreboard (345) ----
{
  /**
   * rtl_433 publishes one block for this device, and it does not read the way that file says it does.
   *
   * The file states the sync is three bits and the Manchester data begins immediately after, but decoding the
   * published block from bit three hits a coding violation two bits in. Decoding it from bit *two* gives
   * exactly the bytes the same comment documents. The block as printed is missing one leading sync bit; the
   * decoder follows the code, which is self-consistent, and the discrepancy is asserted here so it stays seen.
   */
  const PUBLISHED = '111010010110011001101001100101010110101001101010011010101010101010101000';
  {
    const bits = [...PUBLISHED].map(Number);
    const decodeFrom = (start) => {
      const out = [];
      let i = start;
      while (i + 1 < bits.length) { const a = bits[i++], b = bits[i++]; if (a === b) break; out.push(b); }
      return out;
    };
    eq(PUBLISHED.length, 72, 'the published block is 72 bits, as its own comment says');
    ok(decodeFrom(3).length < 32, '  decoding it where the comment says to hits a coding violation');
    const two = decodeFrom(2);
    ok(two.length >= 32, '  decoding it one bit earlier runs clean');
    let hex = '';
    for (let i = 0; i + 7 < 32; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | two[i + j]; hex += v.toString(16).padStart(2, '0'); }
    eq(hex, '352f1100', '  and gives exactly the bytes the same comment documents');
  }

  /** Build a block the way the code frames it: three sync ones, 33 Manchester bits, three zeros. */
  const block = (field, hundreds, tens, units, { markers = [3, 2, 1, 0], sync = [1, 1, 1] } = {}) => {
    const b = [
      (markers[0] << 4) | field, (markers[1] << 4) | hundreds,
      (markers[2] << 4) | tens, (markers[3] << 4) | units,
    ];
    return [...sync, ...manchester([...bytesToBits(Uint8Array.from(b)), 0]), 0, 0, 0];
  };
  const build = (blocks) => {
    const preamble = [];
    for (let i = 0; i < 19; i++) preamble.push(1, 0);  // 38 alternating bits
    const bits = [...preamble];
    for (const bl of blocks) bits.push(...bl);
    return rowBits(bits);
  };

  {
    const one = block(5, 0xf, 1, 0);
    eq(one.length, 72, 'a rebuilt block is 72 bits, matching the documented block length');
    const row = build(new Array(10).fill(one));
    eq(row.bitsPerRow[0], 38 + 720, 'a transmission is a 38-bit run-in and ten 72-bit blocks');

    const d = run(dev(345), row)[0];
    ok(!!d, 'FSL scoreboard decodes', JSON.stringify(d));
    if (d) {
      eq(d.model, 'FSL-Scoreboard', '  FSL model');
      eq(d.id, 5, '  the field being set');
      eq(d.value, 10, '  a blank hundreds digit contributes nothing, so this reads as ten');
    }
  }

  eq(run(dev(345), build(new Array(10).fill(block(3, 2, 4, 7))))[0]?.value, 247, 'three digits read as a whole number');
  eq(run(dev(345), build(new Array(10).fill(block(1, 0xf, 0xf, 6))))[0]?.value, 6, 'two blank digits leave a single unit');

  // The position markers are the only integrity this protocol has, so all four must be right.
  for (const [i, name] of [[0, 'three'], [1, 'two'], [2, 'one'], [3, 'zero']].entries()) {
    const markers = [3, 2, 1, 0];
    markers[i] = 0xa;
    ok(!run(dev(345), build(new Array(10).fill(block(5, 0xf, 1, 0, { markers }))))[0],
      `  FSL rejects a transmission whose position marker ${name[1]} is wrong`);
  }

  // One damaged block is survivable; ten are not.
  {
    const good = block(5, 0xf, 1, 0);
    const bad = block(5, 0xf, 1, 0, { markers: [3, 2, 1, 9] });
    const d = run(dev(345), build([bad, ...new Array(9).fill(good)]))[0];
    ok(!!d, '  FSL falls through to a later block when the first is damaged');
    eq(d?.value, 10, '  and reads the same value from it');
  }
  ok(!run(dev(345), build(new Array(10).fill(block(5, 0xf, 1, 0, { sync: [1, 0, 1] }))))[0],
    '  FSL skips a block without its sync ones');
  ok(!run(dev(345), build([block(5, 0xf, 1, 0)]))[0], '  FSL ignores a transmission too short to be one');
}

// ---- The registrations themselves ----
{
  const MINE = [59, 67, 103, 120, 126, 205, 216, 319, 322, 345];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  // Every modulation used here must actually have a slicer behind it, or the device would never see a bit.
  const HANDLED = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  for (const num of MINE) {
    ok(HANDLED.has(dev(num).modulation), `protocol ${num}'s modulation has a slicer`, String(dev(num).modulation));
  }

  // `disabled` is mirrored from upstream exactly, so assert both halves of it.
  eq(dev(216).disabled, true, 'ANT is off by default, as upstream has it: it needs a far higher sampling rate');
  for (const num of MINE.filter(n => n !== 216)) {
    ok(!dev(num).disabled, `  protocol ${num} is enabled, as upstream has it`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
