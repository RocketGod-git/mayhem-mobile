/**
 * Nine rain gauges, pool and garden sensors — seven of them checked against radio rtl_433 actually captured.
 *
 * Baldr's thermo-hygrometer ships nine real captures and its rain gauge seven, EMOS one each, Atech one, and
 * Rubicson and RainPoint one apiece as documented byte rows. Those go in as bits and the documented values
 * come out, which is evidence this file had no hand in producing. Only Biltema has no published sample at all,
 * so its frames are built from the transmit side.
 *
 * Three things here are worth more than the usual round-trip assertions:
 *
 * The Schou gauge is the reason this batch could not use the shared byte-sum helper. Upstream tests its sum
 * for zero at full width and only then narrows it, so a frame whose true sum is a nonzero multiple of 256
 * would be discarded as silence by a masked helper. A frame summing to exactly 512 is built here and must
 * decode, with the premise — that its masked sum really is zero — asserted alongside.
 *
 * Two upstream documentation errors are pinned rather than papered over. The EMOS rain gauge prints its
 * capture raw, inverted and decoded, and the inverted row disagrees with the raw one in two bytes; only the
 * raw one satisfies the file's own checksum, so that is the frame the port follows. The EMOS weather station's
 * decoded example prints every field from the inverted frame except the battery nibble, which it prints
 * uninverted. Both are asserted from both sides so a later reader can see the port is right.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** Written from the CRC definition rather than imported, so building and checking stay independent. */
const crc8ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[i];
    for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff;
  }
  return r;
};
const addBytesFull = (m, n) => { let s = 0; for (let i = 0; i < n; i++) s += m[i]; return s; };
const addNibblesFull = (m, n) => { let s = 0; for (let i = 0; i < n; i++) s += (m[i] >> 4) + (m[i] & 0x0f); return s; };
const reverse8ref = (x) => { let r = 0; for (let i = 0; i < 8; i++) if (x & (1 << i)) r |= 0x80 >> i; return r; };

/** rtl_433 writes its codes as {bits}hexdigits. */
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/ /g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const bitsToBytes = (bits) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
};
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/ /g, '').match(/../g).map(x => parseInt(x, 16)));
const inv = (bits) => bits.map(b => b ^ 1);
/** One row per bit array. */
const rows = (...arrs) => {
  const bb = new BitBuffer();
  arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
/** The same bit array repeated, which is how every one of these sensors actually transmits. */
const rep = (bits, n) => rows(...new Array(n).fill(bits));

console.log('Rain gauges, pool and garden sensors');

// ---------------------------------------------------------------------------
// Biltema rain gauge (118) — no published capture, so everything is built transmit-side
// ---------------------------------------------------------------------------
{
  const d = dev(118);

  /*
   * The three low bits of byte one are read twice by upstream: once as the top of the temperature and once as
   * the top of the rain counter. The builder therefore takes the temperature and the low rain byte, and the
   * coupling is asserted below rather than hidden.
   */
  const build = ({ tempTenths = 201, rainLow = 0, channel = 0, battery = 0, button = 0, id = 0x5a, bits = 36 } = {}) => {
    const v = tempTenths & 0x7ff;                  // eleven bits, two's complement
    const b = new Uint8Array(5);
    b[0] = id;
    b[1] = (battery << 7) | (channel << 4) | (button << 3) | ((v >> 8) & 0x07);
    b[2] = v & 0xff;
    b[3] = rainLow;
    b[4] = 0x00;                                   // the checksum nibble nobody has worked out
    return bytesToBits(b).slice(0, bits);
  };

  const out = run(d, rep(build({ tempTenths: 201, rainLow: 0 }), 4));
  eq(out.length, 1, 'Biltema decodes a well-formed frame');
  eq(out[0]?.id, 0x5a, 'Biltema id');
  eq(out[0]?.channel, 1, 'Biltema channel is one-based on the wire value 0');
  eq(out[0]?.temperature_C, 20.1, 'Biltema temperature');
  eq(out[0]?.battery_ok, 1, 'Biltema battery');
  eq(out[0]?.transmit, 'AUTO', 'Biltema reports an automatic transmission');
  eq(out[0]?.button, 0, 'Biltema button');

  eq(run(d, rep(build({ battery: 1 }), 4))[0]?.battery_ok, 0, 'Biltema reports a low battery');
  eq(run(d, rep(build({ button: 1 }), 4))[0]?.transmit, 'MANUAL', 'Biltema reports a button press');
  eq(run(d, rep(build({ button: 1 }), 4))[0]?.button, 1, 'Biltema button field follows the same bit');
  eq(run(d, rep(build({ channel: 2 }), 4))[0]?.channel, 3, 'Biltema channel 3');
  eq(run(d, rep(build({ bits: 37 }), 4)).length, 1, 'Biltema accepts the 37-bit form too');

  /*
   * The rain arithmetic. Upstream splits on whether the count modulo 25 is odd, and the two branches differ by
   * a constant twelve blocks of 2048 — which is why a dry gauge reports an enormous rate. The premise (which
   * branch each value takes) is asserted next to the result, so a change to the split fails visibly.
   */
  for (const [rainLow, rest, odd, want] of [
    [0, 0, false, 1277.95],
    [1, 1, true, 0.05],
    [2, 2, false, 1384.55],
    [3, 3, true, 106.65],
    [25, 0, false, 1279.25],
  ]) {
    eq(rainLow % 25, rest, `Biltema rain ${rainLow}: remainder is ${rest} (premise)`);
    eq((rest % 2) === 1, odd, `Biltema rain ${rainLow}: takes the ${odd ? 'odd' : 'even'} branch (premise)`);
    eq(run(d, rep(build({ rainLow }), 4))[0]?.rain_rate_mm_h, want, `Biltema rain rate for low byte ${rainLow}`);
  }

  /*
   * The documented ambiguity, asserted so it stays visible: a negative temperature sets the three shared bits,
   * which necessarily moves the rain counter as well. Upstream flags this and does not resolve it.
   */
  {
    const warm = run(d, rep(build({ tempTenths: 201, rainLow: 7 }), 4));
    const cold = run(d, rep(build({ tempTenths: -50, rainLow: 7 }), 4));
    eq(cold[0]?.temperature_C, -5, 'Biltema decodes a negative temperature');
    ok((-50 & 0x7ff) >> 8 !== (201 & 0x7ff) >> 8, 'the two readings differ in the shared high bits (premise)');
    ok(warm[0]?.rain_rate_mm_h !== cold[0]?.rain_rate_mm_h,
      'so the rain field moves with the temperature — upstream\'s unresolved ambiguity, asserted not hidden');
  }

  // The all-ones guard, and the premise that only all four bytes trip it.
  eq(run(d, rows(...new Array(4).fill(bitsFromHex('ffffffff00', 36)))).length, 0,
    'Biltema rejects an all-ones carrier');
  eq(run(d, rows(...new Array(4).fill(bitsFromHex('fffffffe00', 36)))).length, 1,
    'but a frame differing in only the fourth byte still decodes (premise: the guard needs all four)');

  eq(run(d, rep(build({}), 3)).length, 0, 'Biltema needs four matching rows');
  eq(run(d, rep(build({ bits: 35 }), 4)).length, 0, 'Biltema rejects a 35-bit row');
  eq(run(d, rep(bytesToBits(new Uint8Array(5)).slice(0, 38), 4)).length, 0, 'Biltema rejects a 38-bit row');
}

// ---------------------------------------------------------------------------
// RainPoint soil sensor (195) — the documented example, put back on the air
// ---------------------------------------------------------------------------
{
  const d = dev(195);

  /*
   * Three transformations sit between the air and the bytes, so the builder undoes all three: reflect each
   * byte, invert, then Manchester-encode. The sync word's last two bits are the first Manchester symbol, so
   * the frame's leading data bit is not free — that is asserted rather than assumed.
   */
  const build = (bytes12, { runIn = 4, breakPair = -1 } = {}) => {
    const m = Uint8Array.from(bytes12, v => (~reverse8ref(v)) & 0xff);
    const mBits = bytesToBits(m);                  // 96 bits, as the Manchester decoder will emit them
    eq(mBits[0], 1, 'the sync word forces the first payload bit to one (premise)');

    const out = [];
    for (let i = 0; i < runIn; i++) out.push(1, 0, 1, 0, 1, 0, 1, 0);
    out.push(...bytesToBits(Uint8Array.from([0xaa, 0xa9])));   // its tail doubles as symbol zero
    for (let i = 1; i < 96; i++) {
      if (i === breakPair) out.push(mBits[i], mBits[i]);        // a level that fails to change: a coding error
      else out.push(1 - mBits[i], mBits[i]);
    }
    return out;
  };

  const DOC = hexToBytes('AA81F703B104001208005115');
  eq(addNibblesFull(DOC, 10) & 0xff, DOC[10], 'the documented example satisfies its own nibble sum');
  eq(addNibblesFull(DOC, 10) > 0xff, false, 'this particular frame does not overflow a byte (premise)');

  const row = build(DOC);
  eq(row.length, 238, 'the built row is 238 bits, above the 232-bit floor');
  const out = run(d, rows(row));
  eq(out.length, 1, 'RainPoint decodes its documented example');
  eq(out[0]?.id, 0xf703, 'RainPoint id');
  eq(out[0]?.sync, 0xaa81, 'RainPoint sync word');
  eq(out[0]?.flags, 0xb1, 'RainPoint flags');
  eq(out[0]?.channel, 2, 'RainPoint flags 0xb1 is channel 2, as documented');
  eq(out[0]?.status, 0x0400, 'RainPoint status');
  eq(out[0]?.temperature_C, 18, 'RainPoint temperature is whole degrees');
  eq(out[0]?.moisture, 8, 'RainPoint moisture');
  eq(out[0]?.mic, 'CHECKSUM', 'RainPoint claims a checksum');

  // The other two documented channel codes, and an unrecognized one.
  for (const [flags, chan] of [[0x9f, 1], [0xb1, 2], [0xb7, 3], [0x42, 0]]) {
    const b = Uint8Array.from(DOC);
    b[4] = flags;
    b[10] = addNibblesFull(b, 10) & 0xff;
    eq(run(d, rows(build(b)))[0]?.channel, chan, `RainPoint flags 0x${flags.toString(16)} gives channel ${chan}`);
  }

  // A negative soil temperature, which the signed byte allows.
  {
    const b = Uint8Array.from(DOC);
    b[7] = 0xf6;
    b[10] = addNibblesFull(b, 10) & 0xff;
    eq(run(d, rows(build(b)))[0]?.temperature_C, -10, 'RainPoint reads a negative temperature');
  }

  /*
   * A frame whose nibble sum overflows a byte, proving the narrowing matches upstream. Note the first byte
   * has to be even: the sync word fixes the leading payload bit, and after the reflect-and-invert that bit is
   * the low bit of byte zero. An all-0xff frame is therefore one this sensor physically cannot send.
   */
  {
    const b = hexToBytes('FEFFFFFFFFFFFFFFFFFF0015');
    ok(b[0] % 2 === 0, 'the frame starts with an even byte, as the sync word requires (premise)');
    const s = addNibblesFull(b, 10);
    ok(s > 0xff, 'this frame\'s nibble sum overflows a byte (premise)', `sum ${s}`);
    b[10] = s & 0xff;
    const o = run(d, rows(build(b)));
    eq(o.length, 1, 'RainPoint accepts it with the narrowed sum, as upstream does');
    eq(o[0]?.moisture, 255, 'and reads the saturated moisture value out of it');
  }

  {
    const b = Uint8Array.from(DOC);
    b[10] ^= 0xff;
    eq(run(d, rows(build(b))).length, 0, 'RainPoint rejects a bad checksum');
  }
  eq(run(d, rows(build(DOC, { runIn: 1 }))).length, 0, 'RainPoint rejects a row below 232 bits');
  eq(run(d, rows(build(DOC), build(DOC))).length, 0, 'RainPoint wants exactly one row');
  eq(run(d, rows(new Array(300).fill(0))).length, 0, 'RainPoint rejects a row with no sync word');
  {
    const broken = build(DOC, { breakPair: 40 });
    const good = build(DOC);
    ok(broken.join('') !== good.join(''), 'the coding-violation row really does differ (premise)');
    eq(run(d, rows(broken)).length, 0, 'RainPoint rejects a Manchester coding violation');
  }
}

// ---------------------------------------------------------------------------
// Atech WS-308 (196) — the published two-row capture
// ---------------------------------------------------------------------------
{
  const d = dev(196);
  const RUNIN = bitsFromHex('ff0', 9);
  const DATA = bitsFromHex('aaeeaaaabbaabaaaec', 71);

  const out = run(d, rows(RUNIN, DATA));
  eq(out.length, 1, 'Atech decodes its documented capture');
  eq(out[0]?.id, 12, 'Atech id is the fixed 0x0c');
  eq(out[0]?.temperature_C, 18.4, 'Atech temperature, as the comment states');
  eq(out[0]?.mic, 'PARITY', 'Atech claims parity');

  /*
   * Built from the transmit side: three BCD digits, a sign bit, and a parity nibble chosen so the fold comes
   * out zero. The builder is checked against the real capture first — a generator that cannot reproduce
   * known-good radio is not evidence for anything it produces afterwards.
   */
  const build = ({ id = 0x0c, negative = false, digits = [1, 8, 4], breakParity = false } = {}) => {
    const b = new Uint8Array(4);
    b[0] = id;
    b[1] = (negative ? 0x20 : 0x00) | (digits[0] & 0x0f);
    b[2] = (digits[1] << 4) | digits[2];
    const x = b[0] ^ b[1] ^ b[2];
    b[3] = (((x >> 4) ^ (x & 0x0f)) << 4) & 0xf0;  // the nibble that zeroes the fold
    if (breakParity) b[3] ^= 0x10;
    const payload = bytesToBits(b).slice(0, 28);
    const line = [];
    for (const bit of payload) line.push(...(bit ? [1, 1, 1, 0] : [1, 0]));
    line.push(1, 1, 0);                            // the truncated tail the real sensor sends
    return line;
  };

  eq(bitsToBytes(build({})).join(','), bitsToBytes(DATA).join(','),
    'the transmit-side builder reproduces the documented capture exactly');

  eq(run(d, rows(RUNIN, build({ negative: true, digits: [1, 8, 4] })))[0]?.temperature_C, -18.4,
    'Atech sign bit gives a negative reading');
  eq(run(d, rows(RUNIN, build({ digits: [3, 9, 9] })))[0]?.temperature_C, 39.9, 'Atech reads three BCD digits');
  eq(run(d, rows(RUNIN, build({ negative: true, digits: [0, 0, 0] })))[0]?.temperature_C, 0,
    'a negative zero reading is normalized to plain zero');

  eq(run(d, rows(RUNIN, build({ breakParity: true }))).length, 0, 'Atech rejects a bad parity fold');
  eq(run(d, rows(DATA)).length, 0, 'Atech wants exactly two rows, not one');
  eq(run(d, rows(RUNIN, DATA, DATA)).length, 0, 'Atech wants exactly two rows, not three');
  eq(run(d, rows(RUNIN, DATA.slice(0, 57))).length, 0, 'Atech rejects a second row below 58 bits');
  {
    // A coding violation partway through leaves fewer than 28 bits recovered.
    const bad = [...DATA];
    bad[0] = 0; bad[1] = 0;                        // "00" is neither 10 nor 1110
    eq(run(d, rows(RUNIN, bad)).length, 0, 'Atech rejects a line-coding violation');
  }
  // Upstream's fixed-id sanity test is commented out in the source; it must stay that way.
  eq(run(d, rows(RUNIN, build({ id: 0x33 })))[0]?.id, 0x33,
    'a frame with an unexpected id byte is still accepted, matching upstream\'s commented-out check');
}

// ---------------------------------------------------------------------------
// EMOS E6016 weather station (214) — the published 120-bit capture
// ---------------------------------------------------------------------------
{
  const d = dev(214);
  const RAW = ['ff', 'fe', 'fd'].map(t => bitsFromHex('555a7c006aa560e73f36daff5d38' + t, 120));

  const out = run(d, rows(...RAW));
  eq(out.length, 1, 'EMOS E6016 decodes its documented capture');
  eq(out[0]?.model, 'EMOS-E6016', 'the capture is the full weather station');
  eq(out[0]?.id, 255, 'EMOS id');
  eq(out[0]?.channel, 1, 'EMOS channel');
  eq(out[0]?.temperature_C, 20.1, 'EMOS temperature');
  eq(out[0]?.humidity, 37, 'EMOS humidity');
  eq(out[0]?.wind_avg_m_s, 0, 'EMOS wind speed');
  eq(out[0]?.wind_dir_deg, 225, 'EMOS wind direction');
  eq(out[0]?.radio_clock, '2021-05-21T07:49:35', 'EMOS DCF77 clock, exactly as documented');
  eq(out[0]?.mic, 'CHECKSUM', 'EMOS claims a checksum');

  const LOGICAL = Uint8Array.from(hexToBytes('555a7c006aa560e73f36daff5d38ff'), v => (~v) & 0xff);
  {
    // The premise for using the masked helper: the sum genuinely overflows, and upstream narrows it.
    const s = addBytesFull(LOGICAL, 13);
    ok(s > 0xff, 'the EMOS byte sum overflows a byte (premise)', `sum ${s}`);
    eq(s & 0xff, LOGICAL[13], 'and the narrowed sum is what the frame carries');
  }
  {
    /*
     * The documentation error. Upstream's "Decoded example" prints BAT:1101, but the inverted frame's flags
     * nibble is 0010 — 1101 is that same nibble read off the raw, uninverted capture. Every other field in
     * that example line is from the inverted frame, so one field was transcribed from the wrong side.
     */
    const raw = hexToBytes('555a7c006aa560e73f36daff5d38ff');
    eq(LOGICAL[12] & 0x0f, 0b0010, 'the inverted flags nibble is 0010');
    eq(raw[12] & 0x0f, 0b1101, 'and the raw uninverted nibble is 1101, which is what the comment prints');
    eq(out[0]?.battery_ok, 0, 'the battery bit of the inverted nibble is clear, so the port reports not-ok');
  }

  /*
   * The E6018: same frame, variant field zero. It has no wind sensor and no real clock, so those fields are
   * withheld rather than reported as zero.
   */
  const build = ({ variant = 2, hum = 37, tempTenths = 201, wind = 0, dir = 10, flags = 0x2, id = 0xff,
    model = [0x55, 0x5a, 0x7c], repeat = 0xff, len = 120, breakSum = false } = {}) => {
    const g = new Uint8Array(15);                  // the logical (inverted) frame
    g[0] = ~model[0] & 0xff; g[1] = ~model[1] & 0xff; g[2] = ~model[2] & 0xff;
    g[3] = id;
    g[4] = (variant << 6) | 0x15;
    g[5] = 0x5a; g[6] = 0x9f; g[7] = 0x18;
    const v = tempTenths & 0xfff;
    g[8] = ((0 & 0x03) << 4) | ((v >> 8) & 0x0f);
    g[9] = v & 0xff;
    g[10] = hum;
    g[11] = wind;
    g[12] = (dir << 4) | flags;
    g[13] = (addBytesFull(g, 13) & 0xff) ^ (breakSum ? 0xff : 0x00);
    g[14] = repeat;
    return bytesToBits(Uint8Array.from(g, x => (~x) & 0xff)).slice(0, len);
  };

  {
    const o = run(d, rows(build({ variant: 2, repeat: 0xff }), build({ variant: 2, repeat: 0xfe }), build({ variant: 2, repeat: 0xfd })));
    eq(o.length, 1, 'the builder produces a decodable station frame');
    eq(o[0]?.model, 'EMOS-E6016', 'variant 2 is the weather station');
    eq(o[0]?.temperature_C, 20.1, 'builder temperature round-trips');
  }
  {
    const o = run(d, rows(build({ variant: 0, repeat: 0xff }), build({ variant: 0, repeat: 0xfe }), build({ variant: 0, repeat: 0xfd })));
    eq(o.length, 1, 'the E6018 variant decodes');
    eq(o[0]?.model, 'EMOS-E6018', 'variant 0 is the bare sensor');
    eq(o[0]?.temperature_C, 20.1, 'the E6018 still reports temperature');
    eq(o[0]?.humidity, 37, 'and humidity');
    eq(o[0]?.wind_avg_m_s, undefined, 'but no wind speed: it has no wind sensor');
    eq(o[0]?.wind_dir_deg, undefined, 'and no wind direction');
    eq(o[0]?.radio_clock, undefined, 'and no clock: its counter is seeded at a fixed date and never tracks reality');
  }
  eq(run(d, rows(build({ flags: 0x6, repeat: 0xff }), build({ flags: 0x6, repeat: 0xfe }), build({ flags: 0x6, repeat: 0xfd })))[0]?.battery_ok, 1,
    'EMOS reports a good battery when the flag bit is set');
  // Ten ticks times 0.295 lands a hair under 2.95 in binary floating point, so it rounds down, not up.
  eq(run(d, rows(build({ wind: 10, repeat: 0xff }), build({ wind: 10, repeat: 0xfe }), build({ wind: 10, repeat: 0xfd })))[0]?.wind_avg_m_s, 2.9,
    'EMOS wind speed is scaled by 0.295');
  eq(run(d, rows(build({ wind: 20, repeat: 0xff }), build({ wind: 20, repeat: 0xfe }), build({ wind: 20, repeat: 0xfd })))[0]?.wind_avg_m_s, 5.9,
    'EMOS wind speed at twenty ticks');
  eq(run(d, rows(build({ tempTenths: -55, repeat: 0xff }), build({ tempTenths: -55, repeat: 0xfe }), build({ tempTenths: -55, repeat: 0xfd })))[0]?.temperature_C, -5.5,
    'EMOS decodes a negative temperature');

  eq(run(d, rows(RAW[0], RAW[1])).length, 0, 'EMOS needs three matching rows');
  eq(run(d, rows(...RAW.map(r => r.slice(0, 119)))).length, 0, 'EMOS wants exactly 120 bits');
  eq(run(d, rows(build({ breakSum: true }), build({ breakSum: true, repeat: 0xfe }), build({ breakSum: true, repeat: 0xfd }))).length, 0,
    'EMOS rejects a bad checksum');
  {
    const bad = [build({ model: [0x55, 0x5a, 0x7d], repeat: 0xff }), build({ model: [0x55, 0x5a, 0x7d], repeat: 0xfe }), build({ model: [0x55, 0x5a, 0x7d], repeat: 0xfd })];
    eq(run(d, rows(...bad)).length, 0, 'EMOS rejects a frame whose model preamble is wrong');
  }
}

// ---------------------------------------------------------------------------
// EMOS E6016 rain gauge (217) — the published capture, and its contradictory doc row
// ---------------------------------------------------------------------------
{
  const d = dev(217);
  const RAW = bitsFromHex('555a75cb13cfffffd60', 73);

  const out = run(d, rep(RAW, 3));
  eq(out.length, 1, 'EMOS rain gauge decodes its documented raw capture');
  eq(out[0]?.model, 'EMOS-E6016R', 'EMOS rain model');
  eq(out[0]?.id, 0x34, 'EMOS rain id, as the decoded example states');
  eq(out[0]?.battery_ok, 1, 'EMOS rain battery');
  eq(out[0]?.rain_mm, 0, 'the raw capture reports no rain');
  eq(out[0]?.mic, 'CHECKSUM', 'EMOS rain claims a checksum');

  /*
   * The documentation error, from both sides. Upstream prints the capture raw, "after inversion" and decoded.
   * The raw row inverts to bytes ending 00 00, the printed inverted row has 0b b7 in those positions, and the
   * decoded example's RAIN:2999 follows the latter. Only one of the two satisfies the checksum the file
   * itself describes, and it is the raw capture — so that is the frame this port follows.
   */
  {
    const fromRaw = Uint8Array.from(hexToBytes('555a75cb13cfffffd6'), v => (~v) & 0xff);
    const fromDoc = hexToBytes('aaa58a34ec300bb729');
    eq(fromRaw[8], 0x29, 'both candidate rows carry the same checksum byte');
    eq(fromDoc[8], 0x29, 'both candidate rows carry the same checksum byte');
    eq(addBytesFull(fromRaw, 8) & 0xff, 0x29, 'the raw capture, inverted, sums to the checksum it carries');
    ok((addBytesFull(fromDoc, 8) & 0xff) !== 0x29,
      'the printed "after inversion" row does not (upstream documentation error)',
      `sums to 0x${(addBytesFull(fromDoc, 8) & 0xff).toString(16)}`);
    eq(((fromRaw[6] & 0x0f) << 8) | fromRaw[7], 0, 'so the real reading is zero rain');
    eq(((fromDoc[6] & 0x0f) << 8) | fromDoc[7], 2999, 'and the comment\'s 2999 comes from the invalid row');
    ok(2999 * 0.7 > 2000, 'which would be over two meters of rain in any case', `${(2999 * 0.7).toFixed(1)} mm`);
  }

  const build = ({ id = 0x34, batt = 3, rain = 0, model = [0x55, 0x5a, 0x75], len = 73, breakSum = false } = {}) => {
    const g = new Uint8Array(9);
    g[0] = ~model[0] & 0xff; g[1] = ~model[1] & 0xff; g[2] = ~model[2] & 0xff;
    g[3] = id;
    g[4] = (batt << 6) | 0x2c;
    g[5] = 0x30;
    g[6] = (rain >> 8) & 0x0f;
    g[7] = rain & 0xff;
    g[8] = (addBytesFull(g, 8) & 0xff) ^ (breakSum ? 0xff : 0x00);
    // Nine bytes is only 72 bits; the real frame carries a trailing zero bit, so pad rather than truncate.
    const bits = bytesToBits(Uint8Array.from(g, x => (~x) & 0xff));
    while (bits.length < len) bits.push(0);
    return bits.slice(0, len);
  };

  eq(bitsToBytes(build({})).join(','), bitsToBytes(RAW).join(','),
    'the transmit-side builder reproduces the raw capture exactly');
  eq(run(d, rep(build({ rain: 100 }), 3))[0]?.rain_mm, 70, 'EMOS rain is 0.7 mm per tick');
  eq(run(d, rep(build({ rain: 4095 }), 3))[0]?.rain_mm, 2866.5, 'the twelve-bit counter tops out at 2866.5 mm');
  eq(run(d, rep(build({ batt: 0 }), 3))[0]?.battery_ok, 0, 'EMOS rain reports a flat battery');

  eq(run(d, rep(build({ breakSum: true }), 3)).length, 0, 'EMOS rain rejects a bad checksum');
  eq(run(d, rep(build({}), 2)).length, 0, 'EMOS rain needs three matching rows');
  eq(run(d, rep(build({ len: 71 }), 3)).length, 0, 'EMOS rain rejects a 71-bit row');
  eq(run(d, rep(build({ len: 74 }), 3)).length, 0, 'EMOS rain rejects a 74-bit row');

  // The two EMOS decoders are kept apart by the third model byte, in both directions.
  eq(run(d, rep(build({ model: [0x55, 0x5a, 0x7c] }), 3)).length, 0,
    'the rain gauge refuses a frame carrying the weather station\'s preamble');
  eq(run(dev(214), rep(RAW, 3)).length, 0, 'and the weather station refuses the rain gauge\'s capture');
}

// ---------------------------------------------------------------------------
// Rubicson pool thermometer 48942 (222) — the documented binary row
// ---------------------------------------------------------------------------
{
  const d = dev(222);
  const DOC = hexToBytes('71ba4e60ba');            // as printed: the frame after inversion

  eq(crc8ref(DOC, 4, 0x31, 0x00), DOC[4],
    'the documented row satisfies a CRC-8 poly 0x31 init 0x00, computed independently');
  eq(DOC[1] & 0x03, 0b10, 'and carries the constant 10 bits the layout describes');

  /** The decoder inverts, so the air carries the complement of the documented row. */
  const onAir = (bytes, { bit41 = 0 } = {}) => inv([...bytesToBits(bytes).slice(0, 40), bit41]);

  const out = run(d, rep(onAir(DOC), 2));
  eq(out.length, 1, 'Rubicson decodes its documented row');
  eq(out[0]?.channel, 8, 'Rubicson channel');
  eq(out[0]?.id, 110, 'Rubicson random power-on id');
  eq(out[0]?.temperature_C, 23, 'Rubicson temperature');
  eq(out[0]?.battery_ok, 1, 'Rubicson battery');
  eq(out[0]?.mic, 'CRC', 'Rubicson claims a CRC');

  const build = ({ channel = 7, id = 110, battLow = 0, tempTenths = 230, pad = 0, bit41 = 0, breakCrc = false } = {}) => {
    const b = new Uint8Array(5);
    const t = tempTenths + 1024;
    b[0] = (channel << 4) | ((id >> 6) & 0x0f);
    b[1] = ((id & 0x3f) << 2) | 0b10;
    b[2] = (battLow << 7) | ((t >> 4) & 0x7f);
    b[3] = ((t & 0x0f) << 4) | (pad & 0x0f);
    b[4] = crc8ref(b, 4, 0x31, 0x00) ^ (breakCrc ? 0xff : 0x00);
    return onAir(b, { bit41 });
  };

  eq(bitsToBytes(build({})).join(','), bitsToBytes(onAir(DOC)).join(','),
    'the transmit-side builder reproduces the documented row exactly');
  eq(run(d, rep(build({ channel: 0 }), 2))[0]?.channel, 1, 'Rubicson channel is one-based');
  eq(run(d, rep(build({ battLow: 1 }), 2))[0]?.battery_ok, 0, 'Rubicson reports a low battery');
  eq(run(d, rep(build({ tempTenths: -80 }), 2))[0]?.temperature_C, -8, 'Rubicson decodes a negative temperature');
  eq(run(d, rep(build({ breakCrc: true }), 2)).length, 0, 'Rubicson rejects a bad CRC');

  // Each structural gate, with the premise that the CRC is not what refuses the frame.
  {
    const b = hexToBytes('71ba4e6100');
    b[4] = crc8ref(b, 4, 0x31, 0x00);
    eq(crc8ref(b, 4, 0x31, 0x00), b[4], 'the nonzero-pad frame has a valid CRC (premise)');
    eq(run(d, rep(onAir(b), 2)).length, 0, 'Rubicson still rejects it: the pad nibble must be zero');
  }
  {
    eq(crc8ref(DOC, 4, 0x31, 0x00), DOC[4], 'the frame is otherwise intact (premise)');
    eq(run(d, rep(onAir(DOC, { bit41: 1 }), 2)).length, 0,
      'Rubicson rejects a set forty-first bit, which must be zero after inversion');
  }
  {
    // Silence inverts to an all-zero frame that satisfies the CRC perfectly; only the guard refuses it.
    const zero = new Uint8Array(5);
    eq(crc8ref(zero, 4, 0x31, 0x00), zero[4], 'an all-zero frame satisfies the CRC (premise)');
    eq(zero[3] & 0x0f, 0, 'and its pad nibble is zero (premise)');
    eq(run(d, rep(onAir(zero), 2)).length, 0, 'Rubicson throws out the all-zero frame anyway');
  }

  eq(run(d, rows(onAir(DOC))).length, 0, 'Rubicson needs two matching rows');
  eq(run(d, rep(inv(bytesToBits(DOC).slice(0, 40)), 2)).length, 0, 'Rubicson wants exactly 41 bits, not 40');
  eq(run(d, rep(inv([...bytesToBits(DOC).slice(0, 40), 0, 0]), 2)).length, 0, 'Rubicson rejects 42 bits');
}

// ---------------------------------------------------------------------------
// Baldr / RainPoint rain gauge (242) — seven published captures
// ---------------------------------------------------------------------------
{
  const d = dev(242);
  // hex, flags, rain in inches, and the millimeter figure upstream prints beside it
  const CAPS = [
    ['75b000000', 0, 0, '0 mm'],
    ['75b000027', 0, 0.039, '0.9 mm'],
    ['75b000050', 0, 0.08, '2.0 mm'],
    ['75b8000cf', 8, 0.207, '5.2 mm'],
    ['75b80017a', 8, 0.378, '9.6 mm'],
    ['75b800224', 8, 0.548, '13.9 mm'],
    ['75b8002a3', 8, 0.675, '17.1 mm'],
  ];
  for (const [hex, flags, rainIn, mm] of CAPS) {
    const row = bitsFromHex(hex, 36);
    const out = run(d, rep(row, 3));
    eq(out.length, 1, `Baldr rain decodes capture ${hex}`);
    eq(out[0]?.id, 0x75b, `Baldr rain id from ${hex}`);
    eq(out[0]?.flags, flags, `Baldr rain flags from ${hex}`);
    eq(out[0]?.rain_in, rainIn, `Baldr rain total from ${hex}`);
    ok(Math.abs(rainIn * 25.4 - parseFloat(mm)) < 0.1,
      `and ${rainIn} in agrees with the ${mm} upstream prints beside it`);
    eq(out[0]?.mic, undefined, `Baldr rain claims no integrity check for ${hex}`);
  }

  // The registration flags are the interesting part of this device, so they are asserted directly.
  eq(d.disabled, true, 'Baldr rain is disabled, as upstream ships it: it has no checksum at all');
  eq(d.priority, 10, 'and carries upstream\'s priority so Rubicson-Temperature settles a frame first');

  eq(run(d, rep(bitsFromHex('75b000000', 37), 3)).length, 1, 'Baldr rain accepts the 37-bit form');
  eq(run(d, rep(bitsFromHex('75b0000000', 38), 3)).length, 0, 'Baldr rain rejects 38 bits');
  eq(run(d, rep(bitsFromHex('75b000000', 36), 2)).length, 0, 'Baldr rain needs three matching rows');

  // The two false-positive guards, each with the premise that a near miss still decodes.
  eq(run(d, rep(bitsFromHex('00b000000', 36), 3)).length, 0, 'Baldr rain rejects an all-zero frame');
  eq(run(d, rep(bitsFromHex('00b000010', 36), 3)).length, 1,
    'but a frame differing in only byte three decodes (premise: the guard needs all three zero)');
  eq(run(d, rep(bitsFromHex('ffbfffff0', 36), 3)).length, 0, 'Baldr rain rejects an all-ones frame');
  eq(run(d, rep(bitsFromHex('ffbffffe0', 36), 3)).length, 1,
    'but a frame differing in only byte three decodes (premise: the guard needs all three set)');
}

// ---------------------------------------------------------------------------
// Schou 72543 (250) — the documented codes, and the frame a masked sum would lose
// ---------------------------------------------------------------------------
{
  const d = dev(250);
  const R65 = bitsFromHex('a1f88cf6ff3506550', 65);
  const R70 = bitsFromHex('a1f88cf6ff3506557c', 70);

  const out = run(d, rows(R65, R70));
  eq(out.length, 1, 'Schou decodes its documented codes');
  eq(out[0]?.id, 41464, 'Schou id');
  eq(out[0]?.battery_ok, 0, 'Schou battery, low in this sample');
  eq(out[0]?.msg_repeat, 0, 'Schou repeat flag');
  eq(out[0]?.msg_counter, 6, 'Schou message counter');
  eq(out[0]?.rain_mm, 6552.6, 'Schou rain, which a fresh gauge starts near the top of its range');
  eq(out[0]?.temperature_F, 68.9, 'Schou temperature in Fahrenheit');
  eq(out[0]?.mic, 'CHECKSUM', 'Schou claims a checksum');
  {
    const b = hexToBytes('a1f88cf6ff350655');
    eq(addBytesFull(b, 7), 0x455, 'the documented sum is 0x455, exactly as the comment works through');
    eq(addBytesFull(b, 7) & 0xff, b[7], 'and its low byte is the carried checksum');
  }

  const build = ({ bytes, breakSum = false, len = 65 }) => {
    const b = Uint8Array.from(bytes);
    b[7] = (addBytesFull(b, 7) & 0xff) ^ (breakSum ? 0xff : 0x00);
    return bytesToBits(b).slice(0, len);
  };

  /*
   * The reason this decoder takes its sum locally at full width. Upstream tests `sum == 0` before narrowing,
   * so a frame whose true sum is a nonzero multiple of 256 is a perfectly good transmission — but a masked
   * helper would see zero and discard it as silence. This frame sums to exactly 512.
   */
  {
    const b = hexToBytes('A02E0CE80335 0600');
    const s = addBytesFull(b, 7);
    eq(s, 512, 'this frame\'s true byte sum is 512 (premise)');
    eq(s & 0xff, 0, 'which narrows to zero — what a masked helper would test against (premise)');
    ok(s !== 0, 'while the full-width sum is plainly not zero (premise)');
    eq(b[7], 0, 'so the frame legitimately carries a zero checksum');
    const row = bytesToBits(b).slice(0, 65);
    const o = run(d, rows(row, row));
    eq(o.length, 1, 'and the decoder accepts it: a masked sum here would have thrown away a real reading');
    eq(o[0]?.id, 41006, 'the recovered id');
    eq(o[0]?.rain_mm, 100, 'the recovered rain total');
    eq(o[0]?.temperature_F, 68.9, 'the recovered temperature');
    eq(o[0]?.msg_counter, 6, 'the recovered counter');
  }

  // The genuine all-zero row, which the checksum alone would happily accept.
  {
    const zero = new Array(65).fill(0);
    const b = new Uint8Array(8);
    eq(addBytesFull(b, 7) & 0xff, b[7], 'an all-zero row satisfies the checksum (premise)');
    eq(addBytesFull(b, 7), 0, 'and its full sum really is zero, unlike the frame above (premise)');
    eq(run(d, rows(zero, zero)).length, 0, 'Schou throws out the all-zero row');
  }

  eq(run(d, rows(build({ bytes: hexToBytes('a1f88cf6ff350600'), breakSum: true }),
    build({ bytes: hexToBytes('a1f88cf6ff350600'), breakSum: true }))).length, 0, 'Schou rejects a bad checksum');
  eq(run(d, rows(R65)).length, 0, 'Schou needs two rows');
  {
    const other = bitsFromHex('b1f88cf6ff3506550', 65);
    eq(run(d, rows(R65, other)).length, 0, 'Schou rejects rows that disagree in their first 64 bits');
  }
  {
    const b = hexToBytes('a1f8ccf6ff350600');
    const row = build({ bytes: b });
    const o = run(d, rows(row, row));
    eq(o[0]?.msg_repeat, 1, 'Schou reports the repeat flag after a battery change');
    eq(o[0]?.battery_ok, 0, 'and a low battery alongside it');
  }
  {
    const b = hexToBytes('a1f80cf6ff350600');
    const row = build({ bytes: b });
    eq(run(d, rows(row, row))[0]?.battery_ok, 1, 'Schou reports a good battery when the flag is clear');
  }
}

// ---------------------------------------------------------------------------
// Baldr E0666TH (284) — nine published captures across three sensors
// ---------------------------------------------------------------------------
{
  const d = dev(284);
  // hex, id, channel, battery_ok, temperature, humidity, startup — the bracketed values upstream prints
  const CAPS = [
    ['60811bf2c0000800', 24576, 1, 1, 28.3, 44, 1],
    ['60811df380000800', 24576, 1, 1, 28.5, 56, 1],
    ['609124f2d0000800', 24576, 2, 1, 29.2, 45, 1],
    ['609121f2c0000000', 24576, 2, 1, 28.9, 44, 0],
    ['86811ef2d000080e', 34318, 1, 1, 28.6, 45, 1],
    ['868120f2c000080e', 34318, 1, 1, 28.8, 44, 1],
    ['860121f2c000080e', 34318, 1, 0, 28.9, 44, 1],
    ['9c211af2d0000812', 39954, 3, 0, 28.2, 45, 1],
    ['9ca11df2e0000812', 39954, 3, 1, 28.5, 46, 1],
  ];
  for (const [hex, id, ch, bat, tc, hum, start] of CAPS) {
    const row = bitsFromHex(hex, 64);
    const out = run(d, rep(row, 8));
    eq(out.length, 1, `Baldr therm decodes capture ${hex}`);
    eq(out[0]?.id, id, `Baldr therm id from ${hex}`);
    eq(out[0]?.channel, ch, `Baldr therm channel from ${hex}`);
    eq(out[0]?.battery_ok, bat, `Baldr therm battery from ${hex}`);
    eq(out[0]?.temperature_C, tc, `Baldr therm temperature from ${hex}`);
    eq(out[0]?.humidity, hum, `Baldr therm humidity from ${hex}`);
    eq(out[0]?.startup, start, `Baldr therm startup flag from ${hex}`);
  }
  // The captures cover all three channel positions and both battery states, which is worth stating.
  eq(new Set(CAPS.map(c => c[2])).size, 3, 'the captures exercise all three channel positions');
  eq(new Set(CAPS.map(c => c[3])).size, 2, 'and both battery states');
  eq(d.disabled, undefined, 'Baldr therm is NOT disabled upstream, unlike its rain sibling');

  eq(run(d, rep(bitsFromHex('60811bf2c0000800', 65), 8)).length, 1, 'Baldr therm accepts the 65-bit form');
  eq(run(d, rep(bitsFromHex('60811bf2c00008000', 66), 8)).length, 0, 'Baldr therm rejects 66 bits');
  eq(run(d, rep(bitsFromHex('60811bf2c0000800', 64), 7)).length, 0, 'Baldr therm needs eight matching rows');

  /*
   * Every fixed-bit gate in turn. With no checksum these are the whole defense, so each is broken on its own
   * and the premise — that the other four still hold, leaving this gate as the only thing refusing the frame —
   * is asserted alongside.
   */
  const gates = (b) => [
    (b[1] & 0x40) === 0x00,
    (b[3] & 0xf0) === 0xf0,
    (b[4] & 0x0f) === 0x00,
    b[5] === 0x00,
    (b[6] & 0xf7) === 0x00,
  ];
  const BASE = hexToBytes('60811bf2c0000800');
  eq(gates(BASE).filter(Boolean).length, 5, 'the base capture passes all five fixed-bit gates (premise)');
  for (const [idx, name, mutate] of [
    [0, 'the spare bit in byte one', b => { b[1] |= 0x40; }],
    [1, 'the fixed nibble before the humidity', b => { b[3] &= 0x0f; }],
    [2, 'the fixed nibble after the humidity', b => { b[4] |= 0x01; }],
    [3, 'the always-zero byte five', b => { b[5] = 0x01; }],
    [4, 'the fixed bits of byte six', b => { b[6] |= 0x01; }],
  ]) {
    const b = Uint8Array.from(BASE);
    mutate(b);
    const g = gates(b);
    eq(g[idx], false, `breaking ${name} trips its own gate (premise)`);
    eq(g.filter(Boolean).length, 4, `and leaves the other four gates satisfied (premise)`);
    eq(run(d, rep(bytesToBits(b).slice(0, 64), 8)).length, 0, `Baldr therm rejects a frame breaking ${name}`);
  }

  // A negative temperature, built transmit-side, since every capture is a warm summer day.
  {
    const b = Uint8Array.from(BASE);
    const v = (-83) & 0xfff;
    b[1] = (b[1] & 0xf0) | ((v >> 8) & 0x0f);
    b[2] = v & 0xff;
    eq(gates(b).filter(Boolean).length, 5, 'the cold frame still passes every gate (premise)');
    eq(run(d, rep(bytesToBits(b).slice(0, 64), 8))[0]?.temperature_C, -8.3,
      'Baldr therm decodes a negative temperature');
  }

  // The two Baldr devices share timings and line code exactly, and are separated only by length.
  eq(run(dev(242), rep(bitsFromHex('60811bf2c0000800', 64), 8)).length, 0,
    'the Baldr rain gauge refuses a 64-bit thermo-hygrometer frame');
  eq(run(d, rep(bitsFromHex('75b8000cf', 36), 8)).length, 0,
    'and the thermo-hygrometer refuses a 36-bit rain frame');
}

// ---------------------------------------------------------------------------
// The registrations themselves
// ---------------------------------------------------------------------------
{
  const MINE = [118, 195, 196, 214, 217, 222, 242, 250, 284];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));

  // `disabled` marks a reading doubtful here rather than switching the decoder off, so it must mirror upstream.
  const disabled = MINE.filter(n => dev(n).disabled === true);
  eq(disabled.join(','), '118,242', 'exactly the two checksum-less decoders upstream disables are marked here');
  const prioritized = MINE.filter(n => dev(n).priority !== undefined);
  eq(prioritized.join(','), '242', 'and only the Baldr rain gauge carries a priority, as upstream has it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
