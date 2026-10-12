/**
 * Electricity meters and power monitors, the second batch.
 *
 * Three of these ten are checked against real recorded transmissions rather than frames this test built, which
 * is the strongest evidence available for a port: the EnergyCount 3000 has a capture in its upstream doc
 * comment printed beside the decoded line it produced, the IKEA Sparsnäs has an example packet, and the Revolt
 * ZX-7717 has nine raw rows printed above the message table they decode to. Where upstream states a value for
 * a given frame, that value is asserted here, not one this port computed.
 *
 * The rest are built from the transmit side. Two of them need the frame built backwards through a transform:
 * the Norgo arrives inverted and bit-reversed, so a frame is laid out the way the decoder will finally see it
 * and then run back through both steps to get what goes on the air; and the ESA scrambles its payload with a
 * running key taken from the ciphertext, so the encryption has to be re-derived rather than reused.
 *
 * Several rules here are only worth testing if the frame actually triggers them, so the premise is asserted
 * alongside the outcome: the Revolt NC-5462 frame really does sum to exactly 256, the Norgo impulse count
 * really does exceed 32 bits, and the Marlec heating value really is negative on the wire.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import * as U from '../dist/dsp/r433/util.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import { resetSparsnasSensorId } from '../dist/dsp/r433/devices/energy2.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

const bitOf = (bytes, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1;
/** One row of exactly `total` bits, taken from `bytes` (zero-padded if the row is longer). */
const rowOf = (bytes, total = bytes.length * 8) => {
  const bb = new BitBuffer();
  for (let i = 0; i < total; i++) bb.addBit(i < bytes.length * 8 ? bitOf(bytes, i) : 0);
  return bb;
};
/** Two rows: a short one the lead-in sliced off, then the real message. */
const twoRows = (lead, bytes) => {
  const bb = new BitBuffer();
  for (let i = 0; i < lead; i++) bb.addBit(0);
  bb.addRow();
  for (let i = 0; i < bytes.length * 8; i++) bb.addBit(bitOf(bytes, i));
  return bb;
};
const hexBytes = (s) => s.replace(/\s+/g, '').match(/../g).map(h => parseInt(h, 16));

console.log('Electricity meters and power monitors (second batch)');

// =========================================================================================================
// ESA1000/2000 and GIRA EHZ (117)
// =========================================================================================================
{
  /**
   * Run the payload obfuscation forwards, which is what the sensor does.
   *
   * The key for each byte is the previous *ciphertext* byte plus a constant, so encryption has to be done in
   * order and cannot reuse the decoder's loop. The two trailing bytes are not payload: they carry the running
   * total of the ciphertext plus the constant that identifies the family, which is the whole integrity check.
   */
  const esaEncrypt = (plain, magic, blen) => {
    const c = new Uint8Array(blen);
    let salt = 0x89, crc = 0;
    for (let i = 0; i < blen - 3; i++) {
      c[i] = plain[i] ^ salt;
      crc = (crc + c[i]) & 0xffff;
      salt = (c[i] + 0x24) & 0xff;
    }
    c[blen - 3] = plain[blen - 3] ^ 0xff;
    crc = (crc + c[blen - 3]) & 0xffff;
    const t = (crc + magic) & 0xffff;
    c[blen - 2] = t >> 8;
    c[blen - 1] = t & 0xff;
    return c;
  };

  // The frame length decides where the trailing pair lands, and so which fields are readable. A 160-bit frame
  // leaves payload only up to byte 15, which is exactly where the ELV's divisor sits; the GIRA reads bytes 16
  // and 17 and so only fits in a 176-bit frame. That is why the two lengths exist.
  {
    const p = new Uint8Array(16);
    p[0] = 0x85;                                   // retry flag set, sequence 5
    p[1] = 0x12; p[2] = 0x34;                      // device id
    p[3] = 0x01;                                   // the model marker for the ESAx000WZ
    p[5] = 0x00; p[6] = 0x01; p[7] = 0x23; p[8] = 0x45;   // 74565 impulses since the sender started
    p[9] = 0x00; p[10] = 0x64;                     // 100 impulses this interval
    // The divisor is carried exclusive-ored with a byte of the device id: 1000 ^ 0x12 = 0x03fa.
    p[14] = 0x03; p[15] = 0xfa;

    const cipher = esaEncrypt(p, 0xf00f, 18);
    const d = run(dev(117), rowOf([0xaa, 0xaa, ...cipher], 160))[0];
    ok(!!d, 'ESA decodes', JSON.stringify(d));
    if (d) {
      eq(d.model, 'ESAx000WZ', '  the marker byte picks the model');
      eq(d.id, 0x1234, '  ESA device id');
      eq(d.sequence_id, 5, '  ESA sequence number is seven bits');
      eq(d.is_retry, 1, '  ESA retry flag is the top bit');
      eq(d.impulses, 100, '  ESA impulses this interval');
      eq(d.impulses_total, 74565, '  ESA impulses since the sender started');
      eq(d.impulse_constant, 1000, '  the divisor is unmasked with a byte of the id');
      eq(d.total_kWh, 74.565, '  energy is the count over the divisor');
      eq(d.impulse_kWh, 0.1, '  and so is the interval energy');
    }

    // The other two model markers, which change nothing but the name.
    const p3 = Uint8Array.from(p); p3[3] = 0x03;
    eq(run(dev(117), rowOf([0xaa, 0xaa, ...esaEncrypt(p3, 0xf00f, 18)], 160))[0]?.model,
      'ESA1000Z', '  marker 3 is the ESA1000Z');
    const pX = Uint8Array.from(p); pX[3] = 0x09;
    eq(run(dev(117), rowOf([0xaa, 0xaa, ...esaEncrypt(pX, 0xf00f, 18)], 160))[0]?.model,
      'ESA-unknown', '  an unrecognized marker still reports');

    // One flipped byte destroys the running key and everything after it, so the residue cannot come out right.
    const bad = Uint8Array.from(cipher); bad[4] ^= 0x01;
    ok(!run(dev(117), rowOf([0xaa, 0xaa, ...bad], 160))[0], '  ESA rejects a frame whose residue is wrong');
  }

  {
    const p = new Uint8Array(18);
    p[0] = 0x45;                                   // retry flag set, sequence 5 — six bits here, not seven
    p[1] = 0xab; p[2] = 0xcd;
    p[3] = 0xcc; p[4] = 0x1e;                      // the status word upstream says every GIRA sends
    p[6] = 0x03; p[7] = 0xe8;                      // 1000 W
    p[8] = 0x01; p[9] = 0x86; p[10] = 0xa0;        // 100000 impulses, only 24 bits wide on this one
    p[11] = 0x00; p[12] = 0x0a;
    p[16] = 0x03; p[17] = 0xe8 ^ 0xab;             // the GIRA masks only the low byte of its divisor

    const d = run(dev(117), rowOf([0xaa, 0xaa, ...esaEncrypt(p, 0xee11, 20)], 176))[0];
    ok(!!d, 'GIRA decodes', JSON.stringify(d));
    if (d) {
      eq(d.model, 'Gira-EHZ', '  the residue alone tells the GIRA from the ELV');
      eq(d.id, 0xabcd, '  GIRA device id');
      eq(d.sequence_id, 5, '  GIRA sequence number is only six bits');
      eq(d.is_retry, 1, '  GIRA retry flag moved down one bit to make room');
      eq(d.status, 0xcc1e, '  GIRA status and device type');
      eq(d.power, 1000, '  the GIRA is the only one of the two that sends watts directly');
      eq(d.impulses_total, 100000, '  GIRA impulses total');
      eq(d.impulse_constant, 1000, '  GIRA divisor');
      eq(d.total_kWh, 100, '  GIRA energy total');
      eq(d.impulse_kWh, 0.01, '  GIRA interval energy');
    }
  }

  ok(!run(dev(117), rowOf(new Array(20).fill(0), 152))[0], '  ESA refuses a length it does not send');
}

// =========================================================================================================
// IKEA Sparsnas (130) — upstream's own example packet
// =========================================================================================================
{
  // From the doc comment: "Example packet: 0x11a15f070ea2dfefe6d5fdd20547e6340ae7be61".
  const packet = hexBytes('11a15f070ea2dfefe6d5fdd20547e6340ae7be61');
  eq(packet.length, 20, 'the Sparsnas example packet is twenty bytes');
  // Independently: the last two bytes really are the CRC the decoder will check.
  eq(U.crc16(Uint8Array.from(packet), 18, 0x8005, 0xffff), (packet[18] << 8) | packet[19],
    '  and its trailing CRC checks out before any decoding');

  resetSparsnasSensorId();
  const d = run(dev(130), rowOf([0xaa, 0xaa, 0xd2, 0x01, ...packet]))[0];
  ok(!!d, 'Sparsnas decodes', JSON.stringify(d));
  if (d) {
    // The strongest check in this file. The sender's serial is not in the frame in the clear — it is recovered
    // by finding the one value that decrypts the payload to itself. The doc comment says a sticker reading
    // "400 617 633" gives sender id 617633, and that is what falls out, from a frame that knows nothing.
    eq(d.id, 617633, '  the serial brute-forces to the one its own documentation names');
    eq(d.sequence, 1375, '  Sparsnas sequence number');
    eq(d.effect, 1158, '  Sparsnas effect');
    eq(d.pulses, 3577564, '  Sparsnas pulse count');
    eq(d.cumulative_kWh, 3577.564, '  energy is the pulse count over a divisor this sensor never sends');
    eq(d.pulses_per_kWh, 1000, '  so the divisor is a compiled-in assumption, reported alongside');
    eq(d.battery_ok, 1, '  the battery field is a level, not a flag');
    eq(d.mode, 1, '  Sparsnas mode');
  }

  // The two bytes the sender never varies are what confirm the key was right, and they hold here.
  resetSparsnasSensorId();
  const broken = [...packet]; broken[19] ^= 0x01;
  ok(!run(dev(130), rowOf([0xaa, 0xaa, 0xd2, 0x01, ...broken]))[0],
    '  Sparsnas rejects a frame failing its CRC');

  // No run-in, no decode: the search has to actually find the sync word.
  resetSparsnasSensorId();
  ok(!run(dev(130), rowOf([0x00, 0x00, 0x00, 0x00, ...packet]))[0],
    '  Sparsnas refuses a frame with no sync word');
  resetSparsnasSensorId();
}

// =========================================================================================================
// ESIC EMT7110 (136)
// =========================================================================================================
{
  const b = [0x12, 0x34, 0x56, 0x78, 0xc0, 0xc8, 0x01, 0xf4, 0xcc, 0x04, 0xd2, 0x00];
  // Every byte including the check byte comes to a multiple of 256.
  let s = 0; for (let i = 0; i < 11; i++) s += b[i];
  b[11] = (0x100 - (s & 0xff)) & 0xff;

  const d = run(dev(136), rowOf([0xaa, 0xaa, 0x2d, 0xd4, ...b]))[0];
  ok(!!d, 'EMT7110 decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, '12345678', '  EMT7110 id is a full four bytes');
    eq(d.power_W, 100, '  power is half a watt per step');
    eq(d.current_A, 0.5, '  current is sent in milliamps');
    eq(d.voltage_V, 230, '  voltage is half a volt per step above 128');
    eq(d.energy_kWh, 12.34, '  energy is ten watt-hours per step');
    eq(d.pairing, 1, '  the top two bits of the power field are flags');
    eq(d.connected, 1, '  EMT7110 connected flag');
  }
  // The voltage scaling cannot express anything below 128 V at all: byte zero is already 128 V.
  const low = [...b]; low[8] = 0x00; low[11] = (b[11] + 0xcc) & 0xff;
  eq(run(dev(136), rowOf([0xaa, 0xaa, 0x2d, 0xd4, ...low]))[0]?.voltage_V, 128,
    '  a zero voltage byte still means 128 V, which is the scale bottoming out');

  const bad = [...b]; bad[2] ^= 0x01;
  ok(!run(dev(136), rowOf([0xaa, 0xaa, 0x2d, 0xd4, ...bad]))[0], '  EMT7110 rejects a bad sum');
}

// =========================================================================================================
// Norgo NGE101 (139)
// =========================================================================================================
{
  const TAPS = [0x4880, 0, 0, 0, 0, 0, 0, 0, 0x2080, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000];
  const nextMask = (mask) => {
    let n = mask >> 1;
    for (let i = 0; i < 15; i++) if (mask & (1 << i)) n ^= TAPS[i];
    return n & 0xffff;
  };
  const checksum = (f, datalen) => {
    let mask = 0x0001, chks = 0;
    for (let i = datalen - 1; i > 7; i--) {
      mask = nextMask(mask);
      if ((f[(i / 8) | 0] >> (i % 8)) & 1) chks ^= mask;
    }
    return (chks >> 8) & 0xff;
  };

  /**
   * Turn the bytes the decoder will finally see back into what goes on the air.
   *
   * The decoder inverts the whole row and then reverses the bits of every byte, so building a frame means
   * undoing both, in the other order. The lead byte is fixed on the wire rather than in the final view.
   */
  const toWire = (final, nBytes, xorLast) => {
    const w = new Array(nBytes).fill(0);
    w[0] = ~0xfa & 0xff;
    for (let i = 1; i < nBytes; i++) w[i] = (~U.reverse8(final[i])) & 0xff;
    // One byte is spare so the exclusive-or across the body can be made to come to all ones.
    let x = 0xff;
    for (let i = 1; i <= xorLast; i++) if (i !== xorLast) x ^= w[i];
    w[xorLast] = x;
    return w;
  };

  // ---- the 56-bit message: the gap between the last two meter flashes ----
  {
    const f = new Array(7).fill(0);
    f[1] = 0xa4;                                    // id low nibble a, channel 3, and a clear bit 0 for this type
    f[2] = 0x55;                                    // id high nibble 5, plus the bottom nibble of the gap
    f[3] = 0x34;
    f[4] = 0x12;
    f[6] = checksum(f, 5 * 8);                      // covers bytes 1 to 4 only, so it can be filled in last
    const w = toWire(f, 7, 5);
    // The spare byte is chosen for the exclusive-or, so confirm the rule it exists to satisfy really holds.
    eq(U.xorBytes(Uint8Array.from(w), 5, 1), 0xff, 'the Norgo body really does exclusive-or to all ones');

    const d = run(dev(139), rowOf(w, 56))[0];
    ok(!!d, 'Norgo gap message decodes', JSON.stringify(d));
    if (d) {
      eq(d.id, 0x5a, '  the Norgo id is split across two bytes, low nibble first');
      eq(d.channel, 3, '  Norgo channel is counted from one');
      eq(d.gap, 0x12345, '  the gap is nineteen bits in 1/1024 of a second');
      ok(d.impulses === undefined, '  the gap message carries no impulse count');
    }

    const bad = [...w]; bad[3] ^= 0x02;
    ok(!run(dev(139), rowOf(bad, 56))[0], '  Norgo rejects a frame failing its exclusive-or');

    // Break the shift-register check while keeping the exclusive-or intact, so it is the checksum being tested.
    const f2 = [...f]; f2[6] ^= 0x01;
    ok(!run(dev(139), rowOf(toWire(f2, 7, 5), 56))[0], '  Norgo rejects a frame failing its shift-register check');

    const noPre = [...w]; noPre[0] = 0x00;
    ok(!run(dev(139), rowOf(noPre, 56))[0], '  Norgo refuses a frame with the wrong lead byte');
  }

  // ---- the 72-bit message: the running impulse count, which is wider than the field reporting it ----
  {
    // Thirty-four bits of counter. Upstream reports the low thirty-two, so a value that genuinely overflows is
    // the only kind that tests the truncation — a value that fits would pass whether the rule existed or not.
    const FULL = 0x3abcd1234;
    ok(FULL > 0xffffffff, 'the Norgo impulse count under test really does overflow thirty-two bits');
    const f = new Array(9).fill(0);
    f[1] = 0xa5;                                    // same id and channel, bit 0 set for this message type
    f[2] = ((FULL & 0xf) << 4) | 0x5;
    f[3] = Math.floor(FULL / 0x10) & 0xff;
    f[4] = Math.floor(FULL / 0x1000) & 0xff;
    f[5] = Math.floor(FULL / 0x100000) & 0xff;
    f[6] = 0x40 | (Math.floor(FULL / 0x10000000) & 0x3f);    // plus the low-battery bit
    f[8] = checksum(f, 7 * 8);
    const w = toWire(f, 9, 7);
    eq(U.xorBytes(Uint8Array.from(w), 7, 1), 0xff, '  and the 72-bit body exclusive-ors to all ones too');

    const d = run(dev(139), rowOf(w, 72))[0];
    ok(!!d, 'Norgo impulse message decodes', JSON.stringify(d));
    if (d) {
      eq(d.id, 0x5a, '  the same id reads out of the longer message');
      eq(d.channel, 3, '  and the same channel');
      eq(d.impulses, FULL % 0x100000000, '  the count is reported truncated to thirty-two bits');
      eq(d.battery_ok, 0, '  the low-battery bit is reported the other way up');
      ok(d.gap === undefined, '  the impulse message carries no gap');
    }
  }
}

// =========================================================================================================
// Marlec Solar iBoost+ (188)
// =========================================================================================================
{
  const LEN = 37;
  const build = (fill) => {
    const frame = new Uint8Array(108);
    frame[0] = LEN;
    fill(frame);
    const crc = U.crc16(frame, LEN + 1, 0x8005, 0xffff);
    frame[LEN + 1] = crc >> 8;
    frame[LEN + 2] = crc & 0xff;
    return [0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91, ...frame.subarray(0, LEN + 3)];
  };

  const HEATING_RAW = 0xff06;                      // -250 as a signed sixteen-bit value
  ok(HEATING_RAW >= 0x8000, 'the Marlec heating value under test really is negative on the wire');

  const row = build(f => {
    f[3] = 0x22;                                   // the frame type that marks a reading
    f[6] = 30; f[7] = 0; f[8] = 1; f[13] = 0;
    f[17] = HEATING_RAW & 0xff; f[18] = HEATING_RAW >> 8;
    f[19] = 0xd2; f[20] = 0x04;                    // 1234, little endian like everything here
    f[25] = 0xcc;                                  // this frame's saving covers the last seven days
    f[26] = 0xd5; f[27] = 0xdd;                    // 56789
  });

  const d = run(dev(188), rowOf(row))[0];
  ok(!!d, 'Marlec decodes', JSON.stringify(d));
  if (d) {
    eq(d.boost_time, 30, '  minutes of boost still to run');
    eq(d.tank_hot, 1, '  Marlec tank flag');
    eq(d.heating, -250, '  the heating figure is signed: the immersion can draw from the grid instead');
    eq(d.import_val, 1234, '  Marlec import value');
    eq(d.saved_last_7, 56789, '  a marker byte says which period the saving covers');
    ok(d.saved_today === undefined, '  and only that one period is reported');
    eq(d.raw.length, LEN * 2, '  the whole payload is kept as hex, since most of it is undocumented');
  }

  // Each marker names a different period, and nothing else about the frame changes.
  for (const [marker, field] of [[0xca, 'saved_today'], [0xcb, 'saved_yesterday'], [0xcd, 'saved_last_28'], [0xce, 'saved_total']]) {
    const r = build(f => { f[3] = 0x22; f[25] = marker; f[26] = 0x2a; });
    eq(run(dev(188), rowOf(r))[0]?.[field], 42, `  marker ${marker.toString(16)} is ${field}`);
  }

  // A frame of some other type still reports, but nothing is read out of it: the layout only holds for 0x22.
  const other = run(dev(188), rowOf(build(f => { f[3] = 0x11; f[6] = 30; })))[0];
  ok(!!other, 'a non-reading Marlec frame still reports', JSON.stringify(other));
  ok(other && other.boost_time === undefined, '  but carries none of the decoded fields');
  ok(other && typeof other.raw === 'string', '  only the raw payload');

  const bad = [...row]; bad[6 + 10] ^= 0x01;
  ok(!run(dev(188), rowOf(bad))[0], '  Marlec rejects a frame failing its CRC');

  // Runs after Watts-Vision, which shares this CRC over overlapping bytes and would otherwise collide.
  eq(dev(188).priority, 10, '  Marlec is ordered to run after the decoder it collides with');
}

// =========================================================================================================
// Revolt NC-5462 (239)
// =========================================================================================================
{
  // The frame arrives inverted, so what goes on the air is the complement of what the decoder reads.
  const wire = (b) => b.map(v => (~v) & 0xff);

  {
    const b = [0x12, 0x34, 0xe6, 0x00, 0x96, 0x32, 0x0d, 0x80, 0x5f, 0x04, 0xd2, 0x00, 0x00];
    let s = 0; for (let i = 0; i < 11; i++) s += b[i];
    b[11] = s & 0xff;

    const d = run(dev(239), rowOf(wire(b), 104))[0];
    ok(!!d, 'NC-5462 decodes', JSON.stringify(d));
    if (d) {
      eq(d.id, 0x1234, '  NC-5462 house code');
      eq(d.voltage_V, 230, '  voltage is whole volts');
      eq(d.current_A, 1.5, '  current is hundredths of an amp');
      eq(d.frequency_Hz, 50, '  NC-5462 frequency');
      eq(d.power_W, 345.6, '  power is tenths of a watt');
      eq(d.power_factor_VA, 0.95, '  NC-5462 power factor');
      eq(d.energy_kWh, 12.34, '  energy is hundredths of a kilowatt-hour');
      eq(d.button, 0, '  the top bit of the id says the button was pressed');
    }

    const pressed = [...b]; pressed[0] |= 0x80; pressed[11] = (s + 0x80) & 0xff;
    const p = run(dev(239), rowOf(wire(pressed), 104))[0];
    eq(p?.button, 1, '  pressing the button sets that bit and keeps the id');
    eq(p?.id, 0x1234, '  and the id reads the same either way');

    const bad = [...b]; bad[4] ^= 0x01;
    ok(!run(dev(239), rowOf(wire(bad), 104))[0], '  NC-5462 rejects a frame failing its sum');
  }

  // The reason the sum has to be taken at full width. This frame's eleven bytes come to exactly 256, so the
  // low byte is zero and the check byte is zero — a sum masked to a byte would be indistinguishable from the
  // empty frame the sanity rule exists to throw away, and this reading would be silently lost.
  {
    const b = [0x00, 0x06, 0xc8, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    let s = 0; for (let i = 0; i < 11; i++) s += b[i];
    eq(s, 256, 'the NC-5462 overflow frame really does sum to exactly 256');
    eq(s & 0xff, 0, '  which a byte-wide sum would report as zero');
    eq(b[11], s & 0xff, '  and its check byte is zero, so the checksum itself still agrees');

    const d = run(dev(239), rowOf(wire(b), 104))[0];
    ok(!!d, '  and it still decodes, because the sum is taken unmasked', JSON.stringify(d));
    if (d) {
      eq(d.id, 6, '  NC-5462 id survives the overflow frame');
      eq(d.voltage_V, 200, '  as does the voltage');
    }
  }

  // The frame the sanity rule is actually for: nothing at all.
  {
    const b = new Array(13).fill(0x00);
    ok(!run(dev(239), rowOf(wire(b), 104))[0], '  NC-5462 refuses a frame that is genuinely all zeroes');
  }
}

// =========================================================================================================
// Revolt ZX-7717 (274) — upstream's own raw captures
// =========================================================================================================
{
  // Each of these is a row printed under "Raw data" in the upstream doc comment, with the message table it
  // decodes to printed below. The sync byte leads, and every byte after it arrives bit-reversed.
  const cap = (hex) => rowOf(hexBytes(hex));
  const decoded = (hex) => run(dev(274), cap(hex))[0];

  {
    const d = decoded('2ab0abe05a15603a7d007b104f00c7');
    ok(!!d, 'ZX-7717 decodes a real capture', JSON.stringify(d));
    if (d) {
      // Upstream's "Data layout" section documents this exact frame as current 0.190, voltage 227.0,
      // power 24.2 — those numbers are its, not this port's.
      eq(d.id, 2005, '  ZX-7717 id, little endian behind the reversal');
      eq(d.version, 90, '  ZX-7717 version');
      eq(d.current_A, 0.19, '  current matches the value upstream documents for this frame');
      eq(d.voltage_V, 227, '  and so does the voltage');
      eq(d.power_W, 24.2, '  and the power');
      ok(d.energy_kWh === undefined, '  a power frame carries no energy total');
    }
  }

  // Every raw row upstream prints decodes cleanly, which is a check on the framing and the reflection at once.
  const ALL = [
    '2ab0abe05a15603a14005710840011', '2ab0abe05a15603a13005710df0040',
    '2ab0abe05a15603ae2c0e710ca20bb', '2ab0abe05a15603a1ac0e710c12078',
    '2ab0abe05a15603a7d007b104f00c7', '2a88abe05a950026b880603af5c05710d9a018',
    '2a48abe05a950026b880e000000040000000003e', '2ab0abe05a15603a6ec0b7103f20dd',
    '2a70abe05a05e08000001c80000000a4',
  ];
  let all = 0;
  for (const h of ALL) if (decoded(h)) all++;
  eq(all, ALL.length, 'all nine of the raw captures upstream prints decode');
  for (const h of ALL) eq(decoded(h)?.id, 2005, `  and all report the same sender (${h.slice(0, 8)}…)`);

  {
    // The coldstart power frame, which wedges six extra bytes in ahead of the payload. Upstream documents this
    // one as current 0.943, voltage 228.2, power 143.5.
    const d = decoded('2a88abe05a950026b880603af5c05710d9a018');
    ok(!!d, 'ZX-7717 decodes a coldstart power frame', JSON.stringify(d));
    eq(d?.current_A, 0.943, '  coldstart current matches upstream');
    eq(d?.voltage_V, 228.2, '  coldstart voltage matches upstream');
    eq(d?.power_W, 143.5, '  coldstart power matches upstream');
  }

  {
    const d = decoded('2a70abe05a05e08000001c80000000a4');
    ok(!!d, 'ZX-7717 decodes an energy frame', JSON.stringify(d));
    eq(d?.energy_kWh, 0.01, '  energy frames report a running total instead');
    ok(d && d.current_A === undefined, '  and carry no live measurements');
  }

  // Two more frames from the worked examples in the doc comment, built by reflecting the bytes it lists.
  const fromBytes = (bytes) => rowOf([0x2a, ...bytes.map(U.reverse8)]);
  {
    // "0d 7e05 5a 68 06 5c 2100 e108 0700 c5", documented as id 1406, current 0.033, voltage 227.3, power 0.7.
    const d = run(dev(274), fromBytes(hexBytes('0d7e055a68065c2100e1080700c5')))[0];
    ok(!!d, 'ZX-7717 decodes the doc comment worked example', JSON.stringify(d));
    eq(d?.id, 1406, '  a different sender, exactly as the example says');
    eq(d?.current_A, 0.033, '  worked example current');
    eq(d?.voltage_V, 227.3, '  worked example voltage');
    eq(d?.power_W, 0.7, '  worked example power');
  }
  {
    // "0e d507 5a a0 07 030000 a503 020000 98", documented as energy 0.03 kWh. Its own field breakdown labels
    // the id as 7e05, which is not what the hex says — the hex is d507, and 0x07d5 is 2005. The checksum
    // proves the hex is the real frame, so the label is what is wrong.
    const d = run(dev(274), fromBytes(hexBytes('0ed5075aa007030000a50302000098')))[0];
    ok(!!d, 'ZX-7717 decodes the doc comment energy example', JSON.stringify(d));
    eq(d?.energy_kWh, 0.03, '  which reports the energy its breakdown states');
    eq(d?.id, 2005, '  but the id its breakdown states is a copy-paste slip; the frame says 2005');
  }

  const broken = hexBytes('2ab0abe05a15603a7d007b104f00c7'); broken[5] ^= 0x01;
  ok(!run(dev(274), rowOf(broken))[0], '  ZX-7717 rejects a frame failing its sum');
}

// =========================================================================================================
// Voltcraft EnergyCount 3000 (289) — upstream's own capture, with the line it printed beside it
// =========================================================================================================
{
  const CODE = '{550}d4018c7e67bf2e4b15f2b3b404fc2bdace27e30ba759a5be0edcbff0f5e2b070f59d89ec545'
    + '9cef2a6cddb6adf8c4e487546309633d08e4a092fba1d16749519e5de63c5c0';
  const bits = BitBuffer.parse(CODE);
  eq(bits.bitsPerRow[0], 550, 'the EnergyCount capture is the length it claims');

  const d = run(dev(289), bits)[0];
  ok(!!d, 'EnergyCount 3000 decodes its recorded capture', JSON.stringify(d));
  if (d) {
    // Every one of these is copied from the decoded line rtl_433 printed above the capture, not computed here.
    eq(d.id, 'bb9b', '  id matches the line upstream printed for this capture');
    eq(d.power, 90.2, '  power matches');
    eq(d.power_max, 186.5, '  peak power matches');
    eq(d.energy, 754.518, '  energy matches');
    eq(d.energy2, 1.86, '  the second energy figure matches');
    eq(d.time_total, 64942080, '  running time matches');
    eq(d.time_on, 57501776, '  time under load matches');
    eq(d.reset_counter, 4, '  reset count matches');
    eq(d.flags, 8, '  flags match');
  }

  // The link layer is what finds the frame, so damage late in the burst has to be caught by the CRC.
  const mangled = BitBuffer.parse(CODE);
  mangled.bb[0][60] ^= 0x01;
  ok(!run(dev(289), mangled)[0], '  and rejects the same capture with a bit flipped in it');

  // Nothing but zeroes is a long run of one level, which the descrambler turns into noise, not a frame.
  const quiet = new BitBuffer();
  for (let i = 0; i < 550; i++) quiet.addBit(0);
  ok(!run(dev(289), quiet)[0], '  a silent burst produces no reading');
}

// =========================================================================================================
// RFXMeter / RFXPwr (334)
// =========================================================================================================
{
  const b = [0x2c, 0x2c ^ 0xf0, 0x01, 0x02, 0x03, 0x02];
  // Every nibble, the check included, comes to all ones in the bottom nibble.
  eq(U.addNibbles(Uint8Array.from(b), 6) & 0x0f, 0x0f, 'the RFXMeter frame really does satisfy its nibble sum');

  const d = run(dev(334), rowOf(b, 48))[0];
  ok(!!d, 'RFXMeter decodes', JSON.stringify(d));
  if (d) {
    eq(d.id, 0x2c, '  RFXMeter address');
    eq(d.msg_type, 0, '  message type zero is an ordinary counter reading');
    eq(d.msg_value, 0x030102, '  the three counter bytes are reassembled out of order');
  }

  // The lead-in sometimes slices off as a row of its own, and the message is then the second row.
  const d2 = run(dev(334), twoRows(6, b))[0];
  ok(!!d2, '  RFXMeter reads the last row when the lead-in slices off as its own');
  eq(d2?.id, 0x2c, '  and gets the same reading from it');

  // A configuration frame rather than a counter reading. Only the type and the raw value are reported,
  // because what the value means changes completely with the type.
  const cfg = [0x2c, 0x2c ^ 0xf0, 0x00, 0x00, 0x04, 0x10];
  cfg[5] = (0x1 << 4) | ((0x0f - ((U.addNibbles(Uint8Array.from(cfg), 6) - (cfg[5] & 0x0f)) & 0x0f)) & 0x0f);
  const c = run(dev(334), rowOf(cfg, 48))[0];
  ok(!!c, '  RFXMeter decodes a configuration frame', JSON.stringify(c));
  eq(c?.msg_type, 1, '  message type one is a new reporting interval');

  // Upstream's comment says the second address byte has "the nibbles complemented", plural. Its code flips
  // only the high nibble, and a receiver has to agree with the code — so a frame built the way the comment
  // describes is refused. Asserted so the disagreement stays visible rather than being quietly resolved.
  const docStyle = [0x2c, 0x2c ^ 0xff, 0x01, 0x02, 0x03, 0x00];
  docStyle[5] = (0x0f - ((U.addNibbles(Uint8Array.from(docStyle), 6)) & 0x0f)) & 0x0f;
  ok(!run(dev(334), rowOf(docStyle, 48))[0],
    '  a frame with both address nibbles complemented, as the comment describes, is refused by the code');

  const bad = [...b]; bad[2] = 0x11;
  ok(!run(dev(334), rowOf(bad, 48))[0], '  RFXMeter rejects a frame failing its nibble sum');
  ok(!run(dev(334), rowOf(b, 40))[0], '  RFXMeter refuses a row that is not forty-eight bits');
}

// =========================================================================================================
// Eco-Eye (351)
// =========================================================================================================
{
  // Upstream's worked example: a transmitter whose own serial console printed "0129,0031" for this reading.
  const msg = [0x00, 0x1f, 0x00, 0x81, 0x00];
  msg[4] = (msg[0] + msg[1] + msg[2] + msg[3]) & 0xff;

  const d = run(dev(351), rowOf([0xaa, 0x2d, 0xd4, ...msg]))[0];
  ok(!!d, 'Eco-Eye decodes', JSON.stringify(d));
  if (d) {
    eq(d.current_used_A, 1.29, '  grid current matches the console reading upstream quotes');
    eq(d.current_pv_A, 0.31, '  and so does the solar current');
    ok(d.id === undefined, '  the Eco-Eye carries no identity at all');
  }

  // The case its long reset limit exists for: a quiet house puts forty consecutive zero bits on the air. That
  // is a legitimate reading here — unlike the Revolt, this one has no rule against an empty payload.
  const quiet = [0x00, 0x00, 0x00, 0x00, 0x00];
  const q = run(dev(351), rowOf([0xaa, 0x2d, 0xd4, ...quiet]))[0];
  ok(!!q, '  an all-zero payload is a valid reading, not a rejected one', JSON.stringify(q));
  eq(q?.current_used_A, 0, '  reporting no draw');
  eq(q?.current_pv_A, 0, '  and no generation');

  const bad = [...msg]; bad[1] ^= 0x01;
  ok(!run(dev(351), rowOf([0xaa, 0x2d, 0xd4, ...bad]))[0], '  Eco-Eye rejects a bad sum');
  ok(!run(dev(351), rowOf([0x00, 0x00, 0x00, ...msg]))[0], '  and refuses a frame with no sync word');
}

// =========================================================================================================
// Registration
// =========================================================================================================
{
  const NUMS = [117, 130, 136, 139, 188, 239, 274, 289, 334, 351];
  for (const n of NUMS) ok(!!dev(n), `protocol ${n} is registered`);

  // A modulation with no slicer behind it would leave a device in the list and permanently silent.
  const HANDLED = new Set([3, 4, 5, 6, 8, 9, 11, 12, 13, 16, 17, 18]);
  for (const n of NUMS) {
    ok(HANDLED.has(dev(n).modulation), `  protocol ${n} uses a modulation the slicer implements`);
  }

  // Two devices sharing a number would make one of them unreachable by number.
  const seen = new Map();
  let dupes = 0;
  for (const d of REGISTRY) {
    if (seen.has(d.num)) { dupes++; console.log(`  duplicate protocol ${d.num}: ${seen.get(d.num)} / ${d.name}`); }
    seen.set(d.num, d.name);
  }
  eq(dupes, 0, 'no two registered devices share a protocol number');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
