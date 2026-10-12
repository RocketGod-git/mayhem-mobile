/**
 * Seven mid-size stations, two of them checked against radio rtl_433 actually published.
 *
 * NetAtmo ships all four of its message shapes as complete byte rows, and Emax ships two — those go in with a
 * preamble in front and the documented values come out, which is evidence this file had no hand in producing.
 * Every one of those six CRCs and checksums is also recomputed here from its definition rather than imported,
 * so agreement between the frame, the reference and the decoder means three independent things agreed.
 *
 * The other five publish no captures, so their frames are built from the transmit side: lay out the bytes the
 * sensor sends, run the obfuscation or the whitening forwards, and compute the checks the way the sensor
 * does. Where a decoder searches for its preamble, the test asserts where the search lands before asserting
 * anything about the reading — a builder that puts the frame one bit off looks exactly like a broken port.
 *
 * Two upstream disagreements are pinned rather than smoothed over: Omni's header calls byte five a second
 * humidity while its code reports it as a light percentage, and ELV's WS 2000 reads its humidity out of the
 * check nibble for the sensor types whose frames are too short to contain one.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

// ---- checksums, written from their definitions so building and checking stay independent ----
const crc8ref = (m, n, poly, init, at = 0) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[at + i];
    for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff;
  }
  return r;
};
const crc16ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[i] << 8;
    for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff;
  }
  return r & 0xffff;
};
const parityRef = (b) => { let p = 0; for (let i = 0; i < 8; i++) p ^= (b >> i) & 1; return p; };

// ---- bit plumbing ----
const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const bitsToBytes = (bits) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
};
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/[^0-9a-fA-F]/g, '').match(/../g).map(x => parseInt(x, 16)));
const rows = (...arrs) => {
  const bb = new BitBuffer();
  arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
/** Both ELV protocols send the low bit of every field first. */
const pushLsb = (bits, value, n) => { for (let i = 0; i < n; i++) bits.push((value >> i) & 1); };
/** A snapshot of every row, so a decoder that scribbles on the shared buffer is caught. */
const snapshot = (bb) => { const s = []; for (let r = 0; r < bb.numRows; r++) s.push(bb.rowHex(r)); return s.join('|'); };

console.log('ELV, Archos TBH, Emax, NetAtmo, Omni and Elsner Solexa');

// ---------------------------------------------------------------------------
// ELV EM 1000 (6)
// ---------------------------------------------------------------------------
{
  const d = dev(6);
  eq(d.disabled, true, 'EM 1000 is disabled, as it is upstream');

  /*
   * Eighteen preamble bits the decoder never reads, then nine bytes each followed by a set stop bit, low bit
   * of each byte first, then an exclusive-or of those nine bytes.
   */
  const em1000Row = ({ subtype = 1, code = 0x2c, seqno = 5, total = 0x1234, current = 0x0102,
    peak = 0x0304, breakChecksum = false, badStop = -1 } = {}) => {
    const decs = [subtype, code, seqno, total & 0xff, (total >> 8) & 0xff,
      current & 0xff, (current >> 8) & 0xff, peak & 0xff, (peak >> 8) & 0xff];
    let cs = 0;
    for (const v of decs) cs ^= v;
    if (breakChecksum) cs ^= 0xff;
    const bits = [];
    for (let i = 0; i < 17; i++) bits.push(0);
    bits.push(1);                                  // a run of zeros then a one, per the FS20 family
    decs.forEach((v, i) => { pushLsb(bits, v, 8); bits.push(i === badStop ? 0 : 1); });
    pushLsb(bits, cs, 8);
    return bits;
  };

  const good = em1000Row();
  eq(good.length, 107, 'the EM 1000 frame is 18 preamble bits, nine stop-bit bytes and a checksum (premise)');

  const out = run(d, rows(good, good, good));
  eq(out.length, 1, 'EM 1000 decodes three matching repeats');
  eq(out[0]?.id, 0x2c, 'EM 1000 id');
  eq(out[0]?.seq, 5, 'EM 1000 sequence number');
  eq(out[0]?.total, 0x1234, 'EM 1000 total is little endian across two bytes');
  eq(out[0]?.current, 0x0102, 'EM 1000 current');
  eq(out[0]?.peak, 0x0304, 'EM 1000 peak');
  eq(out[0]?.mic, undefined, 'EM 1000 reports no mic, matching upstream, though it does check a checksum');

  // The majority vote: one corrupt repeat out of three is outvoted.
  {
    const bad = em1000Row({ total: 0x9999 });
    ok(bad.join('') !== good.join(''), 'the odd repeat really does differ (premise)');
    eq(run(d, rows(good, bad, good))[0]?.total, 0x1234, 'EM 1000 outvotes a corrupt middle repeat');
    eq(run(d, rows(bad, good, good))[0]?.total, 0x1234, 'and a corrupt first one, since rows one and two agree');
  }

  // Three different values in the same byte is a three-way split, which upstream refuses to guess at.
  {
    const a = em1000Row({ total: 0x1234 });
    const b = em1000Row({ total: 0x5678 });
    const c = em1000Row({ total: 0x9abc });
    eq(run(d, rows(a, b, c)).length, 0, 'EM 1000 gives up when three repeats disagree three ways');
  }

  /*
   * Upstream indexes rows zero through two without checking how many arrived, relying on the C bit buffer
   * having every row allocated and zeroed. Both consequences are asserted so the port stays honest about it.
   */
  {
    const two = run(d, rows(good, good));
    eq(two.length, 1, 'two identical repeats still decode: the absent third row votes as zeroes and loses');
    eq(two[0]?.total, 0x1234, 'and read correctly');

    const bytes = bitsToBytes(good);
    ok(bytes[2] !== 0, 'the frame has non-zero bytes past the preamble (premise)');
    eq(run(d, rows(good)).length, 0, 'a single repeat cannot outvote two zero rows, so the vote collapses');
  }

  eq(run(d, rows(em1000Row({ breakChecksum: true }), em1000Row({ breakChecksum: true }),
    em1000Row({ breakChecksum: true }))).length, 0, 'EM 1000 rejects a bad checksum');

  for (const i of [0, 4, 8]) {
    const r = em1000Row({ badStop: i });
    eq(run(d, rows(r, r, r)).length, 0, `EM 1000 rejects a cleared stop bit after byte ${i}`);
  }

  // Nothing may be written back to the shared buffer.
  {
    const bb = rows(good, good, good);
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb), before, 'EM 1000 leaves the bit buffer untouched');
  }
}

// ---------------------------------------------------------------------------
// ELV WS 2000 (7)
// ---------------------------------------------------------------------------
{
  const d = dev(7);
  eq(d.disabled, true, 'WS 2000 is disabled, as it is upstream');

  const WS2000_LENGTHS = [5, 8, 5, 8, 12, 9, 8, 14, 8];

  /*
   * Eleven preamble bits, then four-bit nibbles each followed by a set stop bit, low bit first. The last
   * nibble of the payload is the check, chosen so the exclusive-or over everything comes out zero; a four-bit
   * sum plus five follows it with no stop bit of its own.
   */
  const ws2000Row = ({ type = 1, data = [], badStop = -1, breakCheck = false, breakSum = false } = {}) => {
    const len = WS2000_LENGTHS[type];
    const decs = [type, ...data];
    while (decs.length < len) decs.push(0);
    decs.length = len;                             // decs[0..len-1]; decs[len] is the check nibble
    let x = 0;
    for (const v of decs) x ^= v;
    decs.push(x ^ (breakCheck ? 1 : 0));
    let s = 0;
    for (const v of decs) s += v;
    const sumNib = ((s + 5) & 0x0f) ^ (breakSum ? 1 : 0);
    const bits = [];
    for (let i = 0; i < 10; i++) bits.push(0);
    bits.push(1);
    decs.forEach((v, i) => { pushLsb(bits, v, 4); bits.push(i === badStop ? 0 : 1); });
    pushLsb(bits, sumNib, 4);
    return bits;
  };

  // Type 1, the thermo/hygro sensor: digits, not a scaled count.
  {
    // decs[1] flags, [2] tenths C, [3] units C, [4] tens C, [5] tenths %, [6] units %, [7] tens %
    const row = ws2000Row({ type: 1, data: [3, 4, 3, 2, 7, 6, 5] });
    const out = run(d, rows(row));
    eq(out.length, 1, 'WS 2000 decodes a thermo/hygro frame');
    eq(out[0]?.id, 3, 'WS 2000 id is the low three bits of the flags nibble');
    eq(out[0]?.temperature_C, 23.4, 'WS 2000 temperature is tens, units and tenths as decimal digits');
    eq(out[0]?.humidity, 56.7, 'WS 2000 humidity likewise');
    eq(out[0]?.subtype, 'AS2000/ASH2000/S2000/S2001A/S2001IA/ASH2200/S300IA', 'WS 2000 names the sensor kind');
    eq(out[0]?.pressure_hPa, undefined, 'no pressure from a sensor that has no barometer');
    eq(out[0]?.wind_avg_km_h, undefined, 'and no wind');

    // The sign is a flag bit, so the digits stay positive and the whole reading flips.
    const neg = run(d, rows(ws2000Row({ type: 1, data: [3 | 8, 4, 3, 2, 7, 6, 5] })));
    eq(neg[0]?.temperature_C, -23.4, 'WS 2000 sign bit gives -23.4 C');
    eq(neg[0]?.id, 3, 'and the sign bit does not disturb the id');
    eq(neg[0]?.humidity, 56.7, 'nor the humidity, which has no sign of its own');
  }

  // Type 4 adds a barometer, whose reading is offset by 200 hPa.
  {
    const out = run(d, rows(ws2000Row({ type: 4, data: [1, 0, 1, 2, 5, 4, 3, 3, 1, 8, 0] })));
    eq(out.length, 1, 'WS 2000 decodes a thermo/hygro/baro frame');
    eq(out[0]?.temperature_C, 21, 'WS 2000 temperature from the baro sensor');
    eq(out[0]?.humidity, 34.5, 'WS 2000 humidity from the baro sensor');
    eq(out[0]?.pressure_hPa, 1013, 'WS 2000 pressure is offset by 200 hPa');
    eq(out[0]?.subtype, 'S2001I/S2001ID', 'WS 2000 baro subtype');
  }

  // Type 7, the KS200/KS300 combo, reuses the humidity and temperature positions.
  {
    // decs[1] flags, [2..4] temp, [5..6] humidity, [7..9] wind, [10..12] rain, [13] unknown
    const out = run(d, rows(ws2000Row({ type: 7, data: [2 | 1, 5, 8, 1, 7, 6, 3, 2, 1, 0xa, 0x2, 0x1, 9] })));
    eq(out.length, 1, 'WS 2000 decodes a KS300 combo frame');
    eq(out[0]?.temperature_C, 18.5, 'KS300 temperature');
    eq(out[0]?.humidity, 67, 'KS300 humidity loses its tenths digit');
    eq(out[0]?.wind_avg_km_h, 12.3, 'KS300 wind speed');
    eq(out[0]?.rain_count, 0x12a, 'KS300 rain counter is twelve bits across three nibbles');
    eq(out[0]?.rain_mm, 87.9, 'KS300 rain is 0.295 mm per seesaw tick');
    eq(out[0]?.is_raining, 1, 'KS300 raining flag');
    eq(out[0]?.unknown, 9, 'KS300 keeps its unexplained nibble');
    eq(out[0]?.subtype, 'KS200/KS300', 'KS300 subtype');

    const dry = run(d, rows(ws2000Row({ type: 7, data: [1, 5, 8, 1, 7, 6, 3, 2, 1, 0xa, 0x2, 0x1, 9] })));
    eq(dry[0]?.is_raining, 0, 'KS300 reports when it is not raining');
  }

  /*
   * Types zero through three and five and six have no room for a full humidity, so upstream reads the check
   * nibble and whatever follows it as though it were one. Type zero is the clearest case: its five-nibble
   * payload ends at the check, so the "humidity" is one tenth of that check nibble. Pinned deliberately.
   */
  {
    const data = [3, 4, 3, 2];
    const row = ws2000Row({ type: 0, data });
    const out = run(d, rows(row));
    eq(out.length, 1, 'WS 2000 decodes a bare thermal sensor');
    eq(out[0]?.temperature_C, 23.4, 'its temperature is read correctly');
    let x = 0;
    for (const v of [0, ...data]) x ^= v;
    eq(out[0]?.humidity, Math.round(x * 0.1 * 10) / 10, 'but its humidity is the check nibble, faithfully odd');
    eq(out[0]?.subtype, '!AS3', 'and upstream marks the kind it cannot really decode with a leading bang');
  }

  // A type with a length but no name reports a question mark.
  {
    const out = run(d, rows(ws2000Row({ type: 8, data: [3, 4, 3, 2, 7, 6, 5] })));
    eq(out.length, 1, 'WS 2000 decodes type 8, which has a length');
    eq(out[0]?.subtype, '?', 'but no name, so it reports a question mark');
  }

  /*
   * Types nine and up have a length of zero. That is not a dead end by accident: the payload loop is skipped,
   * so the running exclusive-or is still the type nibble itself, which is non-zero, and the check rejects it.
   */
  for (const type of [9, 12, 15]) {
    const bits = [];
    for (let i = 0; i < 10; i++) bits.push(0);
    bits.push(1);
    pushLsb(bits, type, 4); bits.push(1);
    pushLsb(bits, 0, 4);
    eq(run(d, rows(bits)).length, 0, `WS 2000 rejects type ${type}, whose zero length leaves the check non-zero`);
  }

  // Each check on its own, with the premise that the other one is intact.
  {
    const bad = ws2000Row({ type: 1, data: [3, 4, 3, 2, 7, 6, 5], breakCheck: true });
    eq(run(d, rows(bad)).length, 0, 'WS 2000 rejects a non-zero exclusive-or');

    const badSum = ws2000Row({ type: 1, data: [3, 4, 3, 2, 7, 6, 5], breakSum: true });
    // The check nibble is untouched here, so only the trailing sum can be doing the rejecting.
    const decs = [1, 3, 4, 3, 2, 7, 6, 5];
    const chk = decs.reduce((a, b) => a ^ b, 0);
    eq([...decs, chk].reduce((a, b) => a ^ b, 0), 0,
      'the bad-sum frame\'s exclusive-or check still passes, so only the sum can reject it (premise)');
    eq(run(d, rows(badSum)).length, 0, 'WS 2000 rejects a bad four-bit sum');
  }

  for (const i of [0, 3, 8]) {
    eq(run(d, rows(ws2000Row({ type: 1, data: [3, 4, 3, 2, 7, 6, 5], badStop: i }))).length, 0,
      `WS 2000 rejects a cleared stop bit after nibble ${i}`);
  }

  {
    const bb = rows(ws2000Row({ type: 1, data: [3, 4, 3, 2, 7, 6, 5] }));
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb), before, 'WS 2000 leaves the bit buffer untouched');
  }
}

// ---------------------------------------------------------------------------
// Archos TBH (144)
// ---------------------------------------------------------------------------
{
  const d = dev(144);
  const INFO = hexToBytes('19f828306d0c945422f237c966a39757');
  const PATTERN = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);

  /** Chain the payload forward: the sensor's own obfuscation, run in the transmit direction. */
  const tbhFrame = (payload) => {
    const len = payload.length;
    const frame = new Uint8Array(len + 3);
    frame[0] = len;
    frame[1] = payload[0] ^ INFO[0];
    for (let i = 1; i < len; i++) frame[i + 1] = payload[i] ^ frame[i] ^ INFO[i % 16];
    const c = crc16ref(frame, len + 1, 0x8005, 0xffff);
    frame[len + 1] = c >> 8;
    frame[len + 2] = c & 0xff;
    return frame;
  };
  const tbhRow = (payload, { lead = 2, frameOverride = null } = {}) => {
    const pre = new Uint8Array(lead).fill(0xaa);
    return [...bytesToBits(pre), ...bytesToBits(PATTERN), ...bytesToBits(frameOverride ?? tbhFrame(payload))];
  };

  /*
   * Where the search lands, before anything else. The pattern begins with the same 0xaa the run-in is made
   * of, so the match starts two bytes in and the frame begins exactly 48 bits later.
   */
  {
    const bb = rows(tbhRow(Uint8Array.from([1, 2, 3, 4, 2, 0, 0, 50])));
    const found = bb.search(0, 0, PATTERN, 48);
    eq(found, 16, 'the preamble match starts after the two extra run-in bytes (premise)');
    eq(found + 48, 64, 'so the length byte sits exactly where the builder put it (premise)');
  }

  // Type 2: temperature and humidity, in tenths of a kelvin.
  {
    const p = new Uint8Array(8);
    p[0] = 0x78; p[1] = 0x56; p[2] = 0x34; p[3] = 0x12;   // id, little endian
    p[4] = 2;
    const raw = 2732 + 215;                        // 21.5 C
    p[5] = raw & 0xff; p[6] = raw >> 8;
    p[7] = 62;
    const out = run(d, rows(tbhRow(p)));
    eq(out.length, 1, 'Archos decodes a weather frame');
    eq(out[0]?.id, 0x12345678, 'Archos id is little endian across four payload bytes');
    eq(out[0]?.temperature_C, 21.5, 'Archos temperature is tenths of a kelvin offset to freezing');
    eq(out[0]?.humidity, 62, 'Archos humidity');
    eq(out[0]?.mic, 'CRC', 'Archos reports a CRC');

    // Below freezing, which the kelvin offset reaches on its own.
    const cold = new Uint8Array(p);
    const coldRaw = 2732 - 127;                    // -12.7 C
    cold[5] = coldRaw & 0xff; cold[6] = coldRaw >> 8;
    eq(run(d, rows(tbhRow(cold)))[0]?.temperature_C, -12.7, 'Archos reads a temperature below freezing');

    // And an id whose top bit is set, which must not come back negative.
    const high = new Uint8Array(p);
    high[3] = 0xff;
    eq(run(d, rows(tbhRow(high)))[0]?.id, 0xff345678, 'Archos id stays unsigned with its top bit set');
  }

  // Type 1: the power index, with a second CRC inside the payload.
  {
    const build = ({ idx = 0x0abcde, ts = 0x001234, maxPower = 0x1f40, breakInner = false } = {}) => {
      const p = new Uint8Array(15);
      p[0] = 0x11; p[1] = 0x22; p[2] = 0x33; p[3] = 0x44;
      p[4] = 1;                                    // type, replaced by a length before the inner CRC
      p[5] = 3;                                    // version
      p[6] = (idx >> 16) & 0xff; p[7] = (idx >> 8) & 0xff; p[8] = idx & 0xff;
      p[9] = (ts >> 16) & 0xff; p[10] = (ts >> 8) & 0xff; p[11] = ts & 0xff;
      p[12] = maxPower >> 8; p[13] = maxPower & 0xff;
      const withLen = new Uint8Array(p);
      withLen[4] = p.length - 4;
      p[14] = crc8ref(withLen, p.length - 5, 0x07, 0x00, 4) ^ (breakInner ? 0xff : 0);
      return p;
    };

    const out = run(d, rows(tbhRow(build())));
    eq(out.length, 1, 'Archos decodes a power-index frame');
    eq(out[0]?.id, 0x44332211, 'Archos power-frame id');
    eq(out[0]?.power_idx, 0x0abcde, 'Archos power index is three bytes big endian');
    eq(out[0]?.power_max, 0x1f40, 'Archos maximum power');
    eq(out[0]?.timestamp, 0x1234 >> 3, 'Archos timestamp counts eighths of a second and is divided down');
    eq(out[0]?.temperature_C, undefined, 'a power frame carries no temperature');

    const broken = rows(tbhRow(build({ breakInner: true })));
    eq(run(d, broken).length, 0, 'Archos rejects a bad inner CRC even though the outer one passes');
  }

  // Types 3 and 4 are battery reports.
  {
    const p = new Uint8Array(8);
    p[0] = 1; p[4] = 3; p[5] = 87;
    const out = run(d, rows(tbhRow(p)));
    eq(out.length, 1, 'Archos decodes a battery-level frame');
    eq(out[0]?.battery_ok, 0.87, 'Archos battery level is a percentage scaled to a fraction');

    const low = new Uint8Array(8);
    low[0] = 1; low[4] = 4;
    eq(run(d, rows(tbhRow(low)))[0]?.battery_ok, 0, 'Archos battery-low frame reports a flat zero');
  }

  // An unknown type decodes cleanly and is then thrown out for being meaningless.
  {
    const p = new Uint8Array(8);
    p[4] = 9;
    eq(run(d, rows(tbhRow(p))).length, 0, 'Archos refuses a frame type it does not know');
  }

  // The outer CRC, corrupted inside the bits the decoder actually reads.
  {
    const p = new Uint8Array(8);
    p[0] = 5; p[4] = 2; p[5] = 0xac; p[6] = 0x0b; p[7] = 50;
    const frame = tbhFrame(p);
    const bent = new Uint8Array(frame);
    bent[frame.length - 1] ^= 0x01;
    ok(bent.join(',') !== frame.join(','), 'the corrupted frame really does differ (premise)');
    eq(run(d, rows(tbhRow(p, { frameOverride: bent }))).length, 0, 'Archos rejects a bad outer CRC');
  }

  // The length cap, and the shape checks.
  {
    const big = new Uint8Array(61);
    big[4] = 2;
    const frame = tbhFrame(big);
    eq(frame[0], 61, 'the oversized frame really does declare 61 bytes (premise)');
    eq(run(d, rows(tbhRow(big))).length, 0, 'Archos rejects a length above sixty');

    const p = new Uint8Array(8);
    p[4] = 2;
    const one = tbhRow(p);
    eq(run(d, rows(one, one)).length, 0, 'Archos wants exactly one row');

    const noPre = bytesToBits(tbhFrame(p));
    const bb = rows(noPre);
    eq(bb.search(0, 0, PATTERN, 48), bb.bitsPerRow[0], 'a frame with no run-in contains no preamble (premise)');
    eq(run(d, rows(noPre)).length, 0, 'Archos rejects a frame with no preamble');

    eq(run(d, rows(bytesToBits(new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91, 0x02, 0x00])))).length, 0,
      'Archos rejects a row too short to hold a frame');
  }

  {
    const p = new Uint8Array(8);
    p[4] = 2; p[5] = 0xac; p[6] = 0x0b; p[7] = 50;
    const bb = rows(tbhRow(p));
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb), before, 'Archos leaves the bit buffer untouched');
  }
}

// ---------------------------------------------------------------------------
// Emax W6 (215) — two published captures
// ---------------------------------------------------------------------------
{
  const d = dev(215);
  const PATTERN = new Uint8Array([0xaa, 0xaa, 0xca, 0xca, 0x54]);

  // Straight from the source's "Raw data sample" blocks, run-in included.
  const TEMPHUM = hexToBytes('FFFFAAAAAAAAAACACA54' + 'AAA16E95A6BAA53B' + 'AA'.repeat(23) + 'D4' + 'AA00');
  const STATION = hexToBytes('ffff8000aaaaaaaaaacaca54'
    + 'aa04594106 1f420101018101160101010405060708091011121314151617 9dad9e');

  // Both captures really do satisfy the checksum, computed here rather than imported.
  for (const [name, full, lead] of [['temp/hum', TEMPHUM, 10], ['station', STATION, 12]]) {
    const b = full.subarray(lead);
    let sum = 0;
    for (let i = 0; i < 31; i++) sum += b[i];
    ok(sum > 0xff, `the ${name} capture's byte sum overflows a byte, so narrowing is load-bearing (premise)`, `sum ${sum}`);
    eq(sum & 0xff, b[31], `and the narrowed sum is the checksum the ${name} capture carries`);

    const bb = rows(bytesToBits(full));
    eq(bb.search(0, 0, PATTERN, 40) + 40, lead * 8, `the ${name} capture's data starts where the search ends (premise)`);
  }

  {
    const out = run(d, rows(bytesToBits(TEMPHUM)));
    eq(out.length, 1, 'Emax decodes its published thermometer capture');
    eq(out[0]?.model, 'Altronics-X7064', 'subtype 1 is the Fahrenheit thermometer');
    eq(out[0]?.id, 0x6e9, 'Emax id matches the documented 6e9');
    eq(out[0]?.channel, 1, 'Emax channel matches the documented 1');
    eq(out[0]?.temperature_F, 81.7, 'Emax temperature: the documented raw 6b5 is 81.7 F');
    eq(out[0]?.humidity, 59, 'Emax humidity matches the documented 059');
    eq(out[0]?.battery_ok, 1, 'Emax battery, from the documented flags 0101');
    eq(out[0]?.pairing, 1, 'and the pairing bit those flags also set');
    eq(out[0]?.temperature_C, undefined, 'the Fahrenheit variant reports no Celsius');
  }

  {
    const out = run(d, rows(bytesToBits(STATION)));
    eq(out.length, 1, 'Emax decodes its published weather-station capture');
    eq(out[0]?.model, 'Emax-W6', 'a station tail of 0x17 with tag zero is the W6');
    eq(out[0]?.id, 0x594, 'station id matches the documented 594');
    eq(out[0]?.channel, 4, 'station channel is 4, as the layout says it always is');
    eq(out[0]?.temperature_F, 66.7, 'station temperature: the documented raw 61f is 66.7 F');
    eq(out[0]?.humidity, 66, 'station humidity matches the documented 66%');
    eq(out[0]?.wind_avg_km_h, 0, 'station wind speed, with the stored-plus-one undone');
    eq(out[0]?.wind_dir_deg, 128, 'station wind direction matches the documented 128 degrees');
    eq(out[0]?.rain_mm, 4.2, 'station rainfall matches the documented 4.2 mm');
    eq(out[0]?.uvi, 0, 'station UV index');
    eq(out[0]?.light_lux, 0, 'station light level');
    eq(out[0]?.pairing, undefined, 'the documented flags 0001 leave the pairing bit clear');
  }

  /** Build a 32-byte message and wrap it in a run-in the searcher has to work for. */
  const emaxBytes = (fill) => {
    const b = new Uint8Array(32).fill(0xaa);
    fill(b);
    let sum = 0;
    for (let i = 0; i < 31; i++) sum += b[i];
    const kind = (b[1] & 0xf0) >> 4;
    b[31] = (kind !== 0 && (b[3] & 3) === 3) ? ((sum - 0x9a) & 0xff) : (sum & 0xff);
    return b;
  };
  const emaxRow = (...msgs) => {
    const out = [];
    for (const m of msgs) out.push(...bytesToBits(hexToBytes('aaaaaaaaaacaca54')), ...bytesToBits(m));
    return out;
  };

  // The Celsius thermometer, whose checksum carries an offset.
  {
    const b = emaxBytes((b) => {
      b[1] = 0xa2; b[2] = 0x1f; b[3] = 0x33;       // kind A, channel 2, id 1f3, subtype 3
      b[4] = 0xa2; b[5] = 0xb0; b[6] = 0xa5;       // raw 0x2b5 = 693
      b[7] = 44;
    });
    let plain = 0;
    for (let i = 0; i < 31; i++) plain += b[i];
    ok((plain & 0xff) !== b[31], 'the X7064A checksum really does differ from the plain sum (premise)');
    eq((plain - 0x9a) & 0xff, b[31], 'and it is the plain sum less 0x9a');

    const out = run(d, rows(emaxRow(b)));
    eq(out.length, 1, 'Emax decodes the Celsius thermometer');
    eq(out[0]?.model, 'Altronics-X7064A', 'subtype 3 is the Celsius variant');
    eq(out[0]?.temperature_C, 19.3, 'X7064A temperature is Celsius offset by 500');
    eq(out[0]?.temperature_F, undefined, 'and it reports no Fahrenheit');
    eq(out[0]?.channel, 2, 'X7064A channel');
    eq(out[0]?.humidity, 44, 'X7064A humidity');
  }

  // A thermometer claiming a subtype upstream has no name for.
  {
    const b = emaxBytes((b) => { b[1] = 0xa1; b[2] = 0x10; b[3] = 0x00; b[4] = 0xa0; b[5] = 0xb0; b[6] = 0xa0; b[7] = 50; });
    const out = run(d, rows(emaxRow(b)));
    eq(out.length, 1, 'Emax still decodes a thermometer with an unnamed subtype');
    eq(out[0]?.model, 'Emax-unknown', 'upstream would emit no model at all; this app names it instead');
    eq(out[0]?.temperature_F, undefined, 'and reports neither temperature scale');
    eq(out[0]?.temperature_C, undefined, 'in either unit');
    eq(out[0]?.humidity, 50, 'while still reporting what it can');
  }

  /** The rain and wind station, whose three variants differ only in their tail. */
  const stationBytes = ({ tail = 0x17, b13 = 0x01, b14 = 0x01, b15 = 0x01, b16 = 0x01, tempRaw = 1567 } = {}) =>
    emaxBytes((b) => {
      b[1] = 0x04; b[2] = 0x59; b[3] = 0x41;
      b[4] = (tempRaw >> 8) & 0x0f; b[5] = tempRaw & 0xff;
      b[6] = 66;
      b[7] = 0x02; b[8] = 0x02;                    // wind raw 0x0101
      b[9] = 0x01; b[10] = 0x81;                   // direction 128
      b[11] = 0x01; b[12] = 0x16;                  // rain raw 0x15
      b[13] = b13; b[14] = b14; b[15] = b15; b[16] = b16;
      for (let i = 17; i < 30; i++) b[i] = i - 13;
      b[29] = tail;
      b[30] = 0x9d;
    });

  {
    const out = run(d, rows(emaxRow(stationBytes({ tail: 0x17, b13: 0x0a, b14: 0x81, b15: 0x02 }))));
    eq(out.length, 1, 'Emax decodes a W6 station with real light data');
    eq(out[0]?.model, 'Emax-W6', 'tag zero keeps the W6 name');
    eq(out[0]?.uvi, 9, 'W6 UV index, with the stored-plus-one undone');
    eq(out[0]?.light_lux, 10, 'W6 light: the top bit of the first byte multiplies the rest by ten');
    eq(out[0]?.wind_avg_km_h, 51.4, 'W6 wind speed at 0.2 km/h a count');
  }

  {
    const out = run(d, rows(emaxRow(stationBytes({ tail: 0x17, b13: 0xc1 }))));
    eq(out.length, 1, 'Emax decodes the IMETEO variant');
    eq(out[0]?.model, 'IMETEO-X6', 'a tag of three renames the station');
    eq(out[0]?.uvi, undefined, 'and withholds the UV index it does not measure');
    eq(out[0]?.light_lux, undefined, 'and the light level');
    eq(out[0]?.temperature_F, 66.7, 'while still reporting the rest');
  }

  {
    const out = run(d, rows(emaxRow(stationBytes({ tail: 0x16, b14: 0x01, b15: 0x01, b16: 0x60 }))));
    eq(out.length, 1, 'Emax decodes the EM3551H');
    eq(out[0]?.model, 'Emax-EM3551H', 'a 0x16 tail with the fixed placeholder is the gust-only variant');
    eq(out[0]?.wind_max_km_h, 64, 'EM3551H gust');
    eq(out[0]?.light_lux, undefined, 'and it has no light sensor');
    eq(out[0]?.temperature_F, 66.7, 'EM3551H reports Fahrenheit');
  }

  {
    const out = run(d, rows(emaxRow(stationBytes({ tail: 0x16, b14: 0x81, b15: 0x02, b16: 0x60, b13: 0x0a }))));
    eq(out.length, 1, 'Emax decodes the LaCrosse WS6262');
    eq(out[0]?.model, 'Lacrosse-WS6262', 'the same tail with real light data is the LaCrosse');
    eq(out[0]?.temperature_C, 106.7, 'and this one alone reports Celsius from the station layout');
    eq(out[0]?.temperature_F, undefined, 'not Fahrenheit');
    eq(out[0]?.wind_max_km_h, 64, 'WS6262 gust');
    eq(out[0]?.uvi, 9, 'WS6262 UV index');
    eq(out[0]?.light_lux, 10, 'WS6262 light level');
  }

  // A station tail matching none of the three keeps the search going and reports nothing.
  eq(run(d, rows(emaxRow(stationBytes({ tail: 0x99 })))).length, 0,
    'Emax reports nothing for a station tail it does not recognize');

  /*
   * The loop is the point of this decoder: one row carries several repeats, and a repeat that fails its
   * checksum must not end the search.
   */
  {
    const good = stationBytes({ tail: 0x17, b13: 0x0a, b14: 0x81, b15: 0x02 });
    const bad = new Uint8Array(good);
    bad[31] ^= 0xff;
    let sum = 0;
    for (let i = 0; i < 31; i++) sum += bad[i];
    ok((sum & 0xff) !== bad[31], 'the leading repeat really does fail its checksum (premise)');

    const out = run(d, rows(emaxRow(bad, good)));
    eq(out.length, 1, 'Emax walks past a corrupt repeat and decodes the next one');
    eq(out[0]?.uvi, 9, 'and reads it correctly');

    eq(run(d, rows(emaxRow(bad, bad))).length, 0, 'while a row of nothing but bad repeats yields nothing');
  }

  {
    const one = emaxRow(stationBytes());
    eq(run(d, rows(one, one)).length, 0, 'Emax wants exactly one row');
    eq(run(d, rows(bytesToBits(hexToBytes('aaaaaaaaaacaca54')))).length, 0, 'Emax rejects a run-in with no message');

    const bb = rows(emaxRow(stationBytes({ tail: 0x17, b13: 0x0a, b14: 0x81, b15: 0x02 })));
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb), before, 'Emax leaves the bit buffer untouched');
  }
}

// ---------------------------------------------------------------------------
// NetAtmo (336) — all four published messages
// ---------------------------------------------------------------------------
{
  const d = dev(336);
  const PATTERN = new Uint8Array([0xaa, 0xaa, 0xe7, 0x12]);
  const netatmoRow = (frame, lead = 2) => [
    ...bytesToBits(new Uint8Array(lead).fill(0xaa)), ...bytesToBits(PATTERN), ...bytesToBits(frame),
  ];

  const MSGS = {
    status: hexToBytes('06 01 5a 91 02 7d ad e5 2a'),
    reading: hexToBytes('19 01 5a 91 02 7d ad 57 0d 00 00 00 00 00 00 00 00 35 00 00 00 00 76 00 01 58 69 3c'),
    wind: hexToBytes('31015a910300bf161800000000000000001b000000000000022900e4ffd2fff0ff'
      + '118e1f2a008e1f2a0067ae2900c4af2900a152'),
    base: hexToBytes('08 00 5A 90 7E 02 B0 03 B1 80 03'),
  };

  // Every published CRC recomputed from its definition before any of them is used as evidence.
  for (const [name, m] of Object.entries(MSGS)) {
    const len = m[0];
    eq(m.length, len + 3, `the ${name} message is its length byte plus payload plus a two-byte CRC (premise)`);
    eq(crc16ref(m, len + 1, 0x8005, 0xffff), (m[len + 1] << 8) | m[len + 2],
      `the published ${name} message satisfies its own CRC-16`);
  }

  {
    const bb = rows(netatmoRow(MSGS.status));
    eq(bb.search(0, 0, PATTERN, 32) + 32, 48, 'the length byte sits exactly where the search ends (premise)');
  }

  {
    const out = run(d, rows(netatmoRow(MSGS.status)));
    eq(out.length, 1, 'NetAtmo decodes the published keep-alive');
    eq(out[0]?.model, 'NetAtmo-TH', 'a six-byte message is the thermometer checking in');
    eq(out[0]?.id, 0x015a9102, 'keep-alive id');
    eq(out[0]?.signal_dB, -83, 'keep-alive signal strength matches the documented -83 dB');
    eq(out[0]?.temperature_C, undefined, 'a keep-alive carries no reading');
  }

  {
    const out = run(d, rows(netatmoRow(MSGS.reading)));
    eq(out.length, 1, 'NetAtmo decodes the published reading');
    eq(out[0]?.model, 'NetAtmo-TH', 'a 0x19 message is a full thermometer reading');
    eq(out[0]?.id, 0x015a9102, 'reading id, the same module as the keep-alive');
    eq(out[0]?.battery_mV, 6830, 'battery matches the documented 6830 mV, counted in half millivolts');
    eq(out[0]?.signal_dB, -83, 'reading signal strength');
    eq(out[0]?.temperature_C, 11.8, 'temperature matches the documented 11.8 C');
    eq(out[0]?.humidity, 88, 'humidity matches the documented 88%');
  }

  {
    const out = run(d, rows(netatmoRow(MSGS.wind)));
    eq(out.length, 1, 'NetAtmo decodes the published wind report');
    eq(out[0]?.model, 'NetAtmo-Wind', 'a 0x31 message is the anemometer');
    eq(out[0]?.id, 0x015a9103, 'anemometer id differs from the thermometer in its last byte');
    eq(out[0]?.battery_mV, 6166, 'anemometer battery matches the documented 6166 mV, in whole millivolts');
    eq(out[0]?.signal_dB, -65, 'anemometer signal strength matches the documented -65 dB');
    eq(out[0]?.raw_a_315, 41, 'first raw axis reading');
    eq(out[0]?.raw_b_315, -28, 'second raw axis reading, negative and little endian');
    eq(out[0]?.raw_c_045, -46, 'third raw axis reading');
    eq(out[0]?.raw_d_045, -16, 'fourth raw axis reading');
    eq(out[0]?.wind_spd_km_h, 3.2, 'wind speed is the magnitude of the two summed diagonals');
    eq(out[0]?.wind_dir_deg, 236, 'wind direction is their angle, offset by 315 degrees and wrapped');
    // The direction is a truncation, so a reading near a whole degree could round either way; this is not one.
    const exact = Math.atan2(-62, 13) / Math.PI * 180 + 315;
    ok(Math.abs(exact - Math.round(exact)) > 0.1, 'this direction is not near an integer boundary (premise)', `${exact}`);
  }

  {
    const out = run(d, rows(netatmoRow(MSGS.base)));
    eq(out.length, 1, 'NetAtmo decodes the base station\'s own request');
    eq(out[0]?.model, 'NetAtmo-THW', 'an unrecognized length falls back to the generic name');
    eq(out[0]?.id, 0x005a907e, 'base station id');
    eq(out[0]?.signal_dB, -80, 'base station signal strength matches the documented -80 dB');
    eq(out[0]?.battery_mV, undefined, 'and nothing is guessed at from a message shape it does not know');
  }

  // A negative temperature, built by editing the published reading and recomputing its CRC.
  {
    const m = new Uint8Array(MSGS.reading);
    const raw = -53;                               // -5.3 C
    m[22] = raw & 0xff; m[23] = (raw >> 8) & 0xff;
    const c = crc16ref(m, m[0] + 1, 0x8005, 0xffff);
    m[m[0] + 1] = c >> 8; m[m[0] + 2] = c & 0xff;
    const out = run(d, rows(netatmoRow(m)));
    eq(out.length, 1, 'the rebuilt reading still passes its CRC');
    eq(out[0]?.temperature_C, -5.3, 'NetAtmo sign-extends a negative temperature');
    eq(out[0]?.humidity, 88, 'and the rest of the frame is undisturbed');
  }

  // A signal strength of 0x88, which the source says means the module heard nothing.
  {
    const m = new Uint8Array(MSGS.status);
    m[6] = 0x88;
    const c = crc16ref(m, m[0] + 1, 0x8005, 0xffff);
    m[m[0] + 1] = c >> 8; m[m[0] + 2] = c & 0xff;
    eq(run(d, rows(netatmoRow(m)))[0]?.signal_dB, -120, 'NetAtmo reads the no-signal marker as a signed byte');
  }

  {
    const m = new Uint8Array(MSGS.reading);
    m[10] ^= 0x01;
    ok(crc16ref(m, m[0] + 1, 0x8005, 0xffff) !== ((m[m[0] + 1] << 8) | m[m[0] + 2]),
      'the corrupted reading really does fail its CRC (premise)');
    eq(run(d, rows(netatmoRow(m))).length, 0, 'NetAtmo rejects a bad CRC');

    const one = netatmoRow(MSGS.status);
    eq(run(d, rows(one, one)).length, 0, 'NetAtmo wants exactly one row');

    const noSync = bytesToBits(MSGS.status);
    const bb = rows(noSync);
    eq(bb.search(0, 0, PATTERN, 32), bb.bitsPerRow[0], 'a bare message contains no sync word (premise)');
    eq(run(d, rows(noSync)).length, 0, 'NetAtmo rejects a message with no sync word');

    // A sync word with a length the row cannot possibly hold reads as zeroes and fails the check.
    eq(run(d, rows([...bytesToBits(PATTERN), ...bytesToBits(hexToBytes('31 01 02'))])).length, 0,
      'NetAtmo rejects a truncated message');
  }

  {
    const bb = rows(netatmoRow(MSGS.wind));
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb), before, 'NetAtmo leaves the bit buffer untouched');
  }
}

// ---------------------------------------------------------------------------
// Omni multisensor (337)
// ---------------------------------------------------------------------------
{
  const d = dev(337);

  const omniRow = ({ fmt = 0, id = 3, bytes = [], breakCrc = false, extraBits = 0 } = {}) => {
    const b = new Uint8Array(10);
    b[0] = (fmt << 4) | id;
    for (let i = 0; i < 8; i++) b[1 + i] = bytes[i] ?? 0;
    b[9] = crc8ref(b, 9, 0x97, 0xaa) ^ (breakCrc ? 0xff : 0);
    const bits = bytesToBits(b);
    for (let i = 0; i < extraBits; i++) bits.push(0);
    return bits;
  };
  /** Twelve bits of signed tenths, laid out high in a sixteen-bit word the way the sketch packs them. */
  const temp12 = (tenths) => (tenths & 0x0fff) << 4;

  // Format zero: core temperature and supply voltage.
  {
    const t = temp12(235);                         // 23.5 C
    const row = omniRow({ fmt: 0, id: 7, bytes: [t >> 8, t & 0xff, 0, 0, 0, 0, 0, 30] });
    const out = run(d, rows(row, row));
    eq(out.length, 1, 'Omni decodes a format-zero frame');
    eq(out[0]?.id, 7, 'Omni id is the low nibble of the first byte');
    eq(out[0]?.channel, 0, 'Omni reports the format field as the channel, as upstream does');
    eq(out[0]?.temperature_C, 23.5, 'Omni core temperature');
    eq(out[0]?.voltage_V, 3.3, 'Omni supply voltage is hundredths above three volts');
    eq(out[0]?.payload, '0eb000000000001e', 'Omni format zero also reports its eight payload bytes as hex');
    eq(out[0]?.pressure_hPa, undefined, 'format zero has no barometer');
  }

  // A negative core temperature, which is where the sign extension earns its keep.
  {
    const t = temp12(-50);                         // -5.0 C
    const row = omniRow({ fmt: 0, bytes: [t >> 8, t & 0xff, 0, 0, 0, 0, 0, 55] });
    const out = run(d, rows(row, row));
    eq(out[0]?.temperature_C, -5, 'Omni sign-extends a negative core temperature');
    eq(out[0]?.voltage_V, 3.55, 'and reads the voltage alongside it');
  }

  // Format one: the environmental sensor, with two temperatures packed against each other.
  {
    const t1 = temp12(212);                        // 21.2 C indoor
    const t2raw = -34 & 0x0fff;                    // -3.4 C outdoor
    const press = 10132;                           // 1013.2 hPa
    const b1 = t1 >> 8, b2 = ((t1 >> 4) & 0x0f) << 4 | ((t2raw >> 8) & 0x0f), b3 = t2raw & 0xff;
    const row = omniRow({ fmt: 1, id: 2, bytes: [b1, b2, b3, 47, 63, press >> 8, press & 0xff, 45] });
    const out = run(d, rows(row, row));
    eq(out.length, 1, 'Omni decodes a format-one frame');
    eq(out[0]?.channel, 1, 'Omni format one reports as channel one');
    eq(out[0]?.temperature_C, 21.2, 'Omni indoor temperature');
    eq(out[0]?.temperature_2_C, -3.4, 'Omni outdoor temperature, negative and sharing a byte with the indoor one');
    eq(out[0]?.humidity, 47, 'Omni humidity');
    // Upstream's own header calls this byte a second humidity; its code calls it a light percentage.
    eq(out[0]?.light_pct, 63, 'Omni reports byte five as a light percentage, following the code');
    eq(out[0]?.humidity_2, undefined, 'not as the second humidity the file header describes');
    eq(out[0]?.pressure_hPa, 1013.2, 'Omni barometric pressure');
    eq(out[0]?.voltage_V, 3.45, 'Omni format-one supply voltage');
    eq(out[0]?.payload, undefined, 'a recognized format reports fields rather than raw hex');
  }

  // An unrecognized format still reports what it can.
  {
    const row = omniRow({ fmt: 5, id: 1, bytes: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88] });
    const out = run(d, rows(row, row));
    eq(out.length, 1, 'Omni decodes an unknown format');
    eq(out[0]?.channel, 5, 'and names the format');
    eq(out[0]?.payload, '1122334455667788', 'reporting the payload as raw hex');
    eq(out[0]?.temperature_C, undefined, 'without pretending to know what any of it means');
    eq(out[0]?.voltage_V, undefined, 'including the voltage, whose position it cannot assume');
  }

  // Repetition, length and the checksum.
  {
    const row = omniRow({ fmt: 0, bytes: [0x0e, 0xb0, 0, 0, 0, 0, 0, 30] });
    eq(run(d, rows(row)).length, 0, 'Omni needs the packet repeated');
    eq(run(d, rows(row, row, row)).length, 1, 'three repeats are fine too');

    const pad2 = omniRow({ fmt: 0, bytes: [0x0e, 0xb0, 0, 0, 0, 0, 0, 30], extraBits: 2 });
    eq(pad2.length, 82, 'the padded row really is 82 bits (premise)');
    eq(run(d, rows(pad2, pad2)).length, 1, 'Omni accepts a row of 82 bits');

    const pad3 = omniRow({ fmt: 0, bytes: [0x0e, 0xb0, 0, 0, 0, 0, 0, 30], extraBits: 3 });
    eq(run(d, rows(pad3, pad3)).length, 0, 'but not 83');

    const short = bytesToBits(new Uint8Array(9));
    eq(run(d, rows(short, short)).length, 0, 'nor a row too short to hold the frame');

    const bad = omniRow({ fmt: 0, bytes: [0x0e, 0xb0, 0, 0, 0, 0, 0, 30], breakCrc: true });
    eq(run(d, rows(bad, bad)).length, 0, 'Omni rejects a bad CRC-8');

    // The seed is a convention the source invites owners to change, so a different one must not decode.
    const b = new Uint8Array(10);
    b[0] = 0x03; b[1] = 0x0e; b[2] = 0xb0; b[8] = 30;
    b[9] = crc8ref(b, 9, 0x97, 0x00);
    ok(b[9] !== crc8ref(b, 9, 0x97, 0xaa), 'the two seeds really do give different check bytes (premise)');
    const other = bytesToBits(b);
    eq(run(d, rows(other, other)).length, 0, 'a unit built with a different CRC seed does not decode here');
  }

  {
    const row = omniRow({ fmt: 0, bytes: [0x0e, 0xb0, 0, 0, 0, 0, 0, 30] });
    const bb = rows(row, row);
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb), before, 'Omni leaves the bit buffer untouched');
  }
}

// ---------------------------------------------------------------------------
// Elsner Solexa 230V (364)
// ---------------------------------------------------------------------------
{
  const d = dev(364);

  const spread = (x, k) => { let v = (x << k) & 0xff; if (x & 1) v |= ((1 << k) - 1) & 0xff; return v; };
  const step = (prev, base, oldBit, newBit) => (spread(prev, 1) + base + newBit - oldBit) & 0xff;
  const lagRef = (input, n, lags) => {
    const out = new Uint8Array(n);
    const bit = (i) => (input[i >> 3] >> (7 - (i % 8))) & 1;
    for (let i = 0; i < n * 8; i++) {
      let v = bit(i);
      for (const l of lags) if (i - l >= 0) v ^= bit(i - l);
      out[i >> 3] |= v << (7 - (i % 8));
    }
    return out;
  };
  const descramble = (b, n) => lagRef(b, n, [5, 7]);
  const lag7 = (b, n) => lagRef(b, n, [7]);

  // The header is a constant, and the whitening turns it into the marker the decoder reports as an id.
  {
    const p = descramble(hexToBytes('cead93ba'), 4);
    eq([...p].map(x => x.toString(16).padStart(2, '0')).join(''), 'c945a400',
      'the constant on-air header descrambles to the documented marker');
  }

  /*
   * Build a frame from the transmit side. The first eleven payload bytes are an arithmetic expansion of one
   * rolling byte, so most of them are computed rather than chosen; the two selector bits are then steered by
   * flipping a single unchecked bit each, and the command token is written as a difference from what the
   * expansion predicts.
   */
  const elsnerFrame = ({ rp0 = 0x5a, counter = 7, family1 = 1, branch1 = 0, token = 0xcc00,
    breakParam = false, breakCrc = false } = {}) => {
    const b = new Uint8Array(38);
    b.set(hexToBytes('cead93ba'), 0);
    b[4] = rp0;                                            // p0, the rolling state
    b[5] = (spread(rp0, 1) + counter) & 0xff;              // p1 carries the transmission counter
    b[6] = (spread(rp0, 2) + 0x22) & 0xff;                 // p2, a family offset the decoder does not check
    b[7] = ((spread(rp0, 3) + 0x48) & 0xff) ^ (breakParam ? 0x01 : 0);
    b[8] = (spread(rp0, 4) + 0xd0) & 0xff;
    b[9] = (spread(rp0, 5) + 0xa0) & 0xff;
    for (let i = 10; i < 36; i++) b[i] = (i * 7 + 0x30) & 0xff;

    // Steer family1, which is bit four of byte three of the seven-bit lag over the payload.
    if (((lag7(b, 36)[7] >> 4) & 1) !== family1) b[6] ^= 0x08;
    // Steer branch1, likewise bit two of payload byte seventeen.
    if (((lag7(b, 36)[21] >> 2) & 1) !== branch1) b[20] ^= 0x02;

    const l12 = parityRef(rp0 & 0xf9), l13 = parityRef(rp0 & 0xfd), l14 = 1 ^ parityRef(rp0 & 0xff);
    const l17 = parityRef(rp0 & 0xfe), l18 = 1 ^ parityRef(rp0 & 0xff), l19 = parityRef(rp0 & 0xfe);
    if (!branch1) {
      const e0 = step(b[16], 0x6a, l12, l13);
      const e1 = step(e0, 0x30, l13, l14);
      b[17] = (e0 + (token >> 8)) & 0xff;
      b[18] = (e1 + (token & 0xff)) & 0xff;
    }
    else {
      const e0 = step(b[21], 0x30, l17, l18);
      const e1 = step(e0, 0x30, l18, l19);
      b[22] = (e0 + (token >> 8)) & 0xff;
      b[23] = (e1 + (token & 0xff)) & 0xff;
    }

    const c = crc16ref(b, 36, 0x1021, 0x68b3) ^ (breakCrc ? 0xffff : 0);
    b[36] = c >> 8; b[37] = c & 0xff;
    return b;
  };
  const elsnerRow = (frame, lead = 2) => [
    ...bytesToBits(new Uint8Array(lead).fill(0xaa)), ...bytesToBits(new Uint8Array([0x0a])), ...bytesToBits(frame),
  ];

  // Where the anchor search lands. Four zeros in a row cannot occur in the alternating run-in.
  {
    const bb = rows(elsnerRow(elsnerFrame()));
    eq(bb.search(0, 0, new Uint8Array([0x0a]), 8) + 8, 24,
      'the frame starts exactly where the anchor search ends (premise)');
    eq(bb.bitsPerRow[0] - 24, 38 * 8, 'and the row holds exactly the 38 bytes the decoder wants (premise)');
  }

  {
    const f = elsnerFrame({ rp0: 0x5a, counter: 7, family1: 1, branch1: 0, token: 0xcc00 });
    // The selectors really did land where the builder aimed them.
    eq((lag7(f, 36)[7] >> 4) & 1, 1, 'the built frame really does read as the confirmed family (premise)');
    eq((lag7(f, 36)[21] >> 2) & 1, 0, 'and as branch zero (premise)');

    const out = run(d, rows(elsnerRow(f)));
    eq(out.length, 1, 'Elsner decodes a well-formed telegram');
    eq(out[0]?.id, 'c945a400', 'Elsner reports the descrambled constant marker as its id');
    eq(out[0]?.rolling, '5a', 'Elsner reports the rolling state');
    eq(out[0]?.counter, 7, 'Elsner recovers the counter as an offset from the expansion');
    eq(out[0]?.command, 'close', 'Elsner reads the command token');
    eq(out[0]?.mic, 'CRC', 'Elsner claims a CRC');
    eq(out[0]?.data?.length, 64, 'Elsner reports the descrambled payload as 32 bytes of hex');
  }

  // Every token in the table, on both branches.
  {
    const TOKENS = [[0xcc00, 'close'], [0xbb00, 'open'], [0xbd00, 'stop_or_release'],
      [0x00ef, 'automode_a'], [0x00e3, 'automode_b'], [0xaac0, 'filler'], [0xa9c0, 'automode_companion']];
    for (const branch1 of [0, 1]) {
      for (const [token, name] of TOKENS) {
        const out = run(d, rows(elsnerRow(elsnerFrame({ branch1, token }))));
        eq(out[0]?.command, name, `Elsner reads token ${token.toString(16)} as ${name} on branch ${branch1}`);
      }
    }
    // A value outside the table is reported as no command rather than guessed at.
    const out = run(d, rows(elsnerRow(elsnerFrame({ token: 0x1234 }))));
    eq(out.length, 1, 'an unrecognized token still yields a reading');
    eq(out[0]?.command, undefined, 'but no command');
    eq(out[0]?.rolling, '5a', 'and the rolling state is still reported');
  }

  // The counter, across several rolling states and around the wrap.
  {
    for (const [rp0, counter] of [[0x00, 0], [0x01, 200], [0xff, 255], [0x80, 1], [0x5a, 128]]) {
      const out = run(d, rows(elsnerRow(elsnerFrame({ rp0, counter }))));
      eq(out[0]?.counter, counter, `Elsner recovers counter ${counter} at rolling state ${rp0.toString(16)}`);
      eq(out[0]?.rolling, rp0.toString(16).padStart(2, '0'), `and reports rolling state ${rp0.toString(16)}`);
    }
  }

  // A telegram from the other population carries no confirmed command.
  {
    const f = elsnerFrame({ family1: 0, token: 0xcc00 });
    eq((lag7(f, 36)[7] >> 4) & 1, 0, 'the frame really does read as the other family (premise)');
    const out = run(d, rows(elsnerRow(f)));
    eq(out.length, 1, 'Elsner still reports a telegram from the unconfirmed family');
    eq(out[0]?.command, undefined, 'without claiming to know its command');
    eq(out[0]?.rolling, '5a', 'while still reporting the rolling state');
    eq(out[0]?.counter, 7, 'and the counter');
  }

  // When the expansion does not hold, the CRC still vouches for the frame but nothing is inferred from it.
  {
    const f = elsnerFrame({ breakParam: true });
    eq(crc16ref(f, 36, 0x1021, 0x68b3), (f[36] << 8) | f[37], 'the broken-model frame still passes its CRC (premise)');
    const out = run(d, rows(elsnerRow(f)));
    eq(out.length, 1, 'Elsner still reports a frame whose rolling-state model fails');
    eq(out[0]?.rolling, undefined, 'but withholds the rolling state');
    eq(out[0]?.counter, undefined, 'and the counter');
    eq(out[0]?.command, undefined, 'and the command, which depends on the same expansion');
    eq(out[0]?.id, 'c945a400', 'while still reporting the id and the payload');
    eq(out[0]?.mic, 'CRC', 'and still claiming the CRC that passed');
  }

  // Each of the three identities on its own.
  for (const [idx, which] of [[7, 'p3'], [8, 'p4'], [9, 'p5']]) {
    const f = elsnerFrame({});
    f[idx] ^= 0x10;
    const c = crc16ref(f, 36, 0x1021, 0x68b3);
    f[36] = c >> 8; f[37] = c & 0xff;
    const out = run(d, rows(elsnerRow(f)));
    eq(out.length, 1, `a frame with a broken ${which} identity still decodes`);
    eq(out[0]?.rolling, undefined, `but ${which} alone is enough to withhold the rolling state`);
  }

  // The CRC is the gate.
  {
    eq(run(d, rows(elsnerRow(elsnerFrame({ breakCrc: true })))).length, 0, 'Elsner rejects a bad CRC');

    const f = elsnerFrame({});
    const bent = new Uint8Array(f);
    bent[25] ^= 0x01;                              // inside the 36 bytes the CRC covers
    ok(crc16ref(bent, 36, 0x1021, 0x68b3) !== ((bent[36] << 8) | bent[37]),
      'the corrupted payload really does fail the CRC (premise)');
    eq(run(d, rows(elsnerRow(bent))).length, 0, 'Elsner rejects a corrupted payload byte');
  }

  // Shape checks.
  {
    const one = elsnerRow(elsnerFrame());
    eq(run(d, rows(one, one)).length, 0, 'Elsner wants exactly one row');

    const short = one.slice(0, one.length - 8);
    eq(run(d, rows(short)).length, 0, 'Elsner rejects a row a byte short of a frame');

    // A row with no anchor byte at all: an unbroken run of ones never contains four zeros.
    const noAnchor = new Array(400).fill(1);
    const bb = rows(noAnchor);
    eq(bb.search(0, 0, new Uint8Array([0x0a]), 8), bb.bitsPerRow[0], 'the anchorless row contains no anchor (premise)');
    eq(run(d, rows(noAnchor)).length, 0, 'Elsner rejects a row with no anchor byte');
  }

  {
    const bb = rows(elsnerRow(elsnerFrame()));
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb), before, 'Elsner leaves the bit buffer untouched');
  }
}

// ---------------------------------------------------------------------------
// The registrations themselves
// ---------------------------------------------------------------------------
{
  for (const num of [6, 7, 144, 215, 336, 337, 364]) ok(!!dev(num), `protocol ${num} is registered`);

  // Upstream marks only the two ELV protocols as off by default; mirror it exactly, both halves.
  for (const num of [6, 7]) eq(dev(num).disabled, true, `protocol ${num} is disabled, as upstream has it`);
  for (const num of [144, 215, 336, 337, 364]) {
    eq(!!dev(num).disabled, false, `protocol ${num} is enabled, as upstream has it`);
  }
  // Nothing in this batch overlaps another protocol's bits, so none of them claims a priority.
  for (const num of [6, 7, 144, 215, 336, 337, 364]) {
    eq(dev(num).priority, undefined, `protocol ${num} claims no priority, matching upstream`);
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
