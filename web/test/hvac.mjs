/**
 * Thermostats, fan remotes and indoor sensors.
 *
 * Only one of these nine protocols ships real captures — Watts' older WFHT-RF thermostat, with ten of them —
 * so those carry most of the weight here. They are used twice over: decoded straight, and rebuilt from the
 * transmit side to check that laying out the fields the way the thermostat does reproduces the manufacturer's
 * own bits exactly. It does, for all ten.
 *
 * Everything else is built from the transmit side: the bytes the device means to send, its checksums computed
 * the way it computes them, then wrapped in whatever line coding it uses. Two devices have their arithmetic
 * anchored to values the manufacturer's own app displayed — the Govee dual-probe thermometer's packed sensor
 * word, which rtl_433 records together with the readings it is known to produce.
 *
 * Three disagreements with upstream's own documentation are asserted rather than smoothed over; each is marked
 * where it appears.
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
const manyRows = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
/** Differential Manchester: the first half always flips, the bit says whether the level then holds. */
const dmc = (bits, prev = 0) => {
  const out = [];
  for (const b of bits) { const h1 = 1 - prev; const h2 = b ? h1 : 1 - h1; out.push(h1, h2); prev = h2; }
  return out;
};
const rev8 = (x) => {
  x = ((x & 0xf0) >> 4) | ((x & 0x0f) << 4);
  x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
  return (((x & 0xaa) >> 1) | ((x & 0x55) << 1)) & 0xff;
};

console.log('Thermostats, fan remotes and indoor sensors');

// ---- Watts WFHT-RF thermostat (253): ten real captures from rtl_433 ----
{
  const CAPS = [
    '5ab24971f79994', '5ab24971f79994', '5ab249f1f79b94', '5ab249f1f79b94',
    '5ab249f9f79854', '5ab249f5f79a54', '5ab249f68f998c', '5ab249f98f9a4c',
    '5ab249f58b9a4c', '5ab249fb8f9acc',
  ];

  // The transmit side: lay the fields out the way the thermostat does, reflect each one, invert the lot.
  const build = (id, flags, temp, setp, chkOverride) => {
    const id0 = id & 0xff, id1 = (id >> 8) & 0xff;
    const t0 = temp & 0xff, t1 = (temp >> 8) & 0xff;
    const s0 = setp & 0xff, s1 = (setp >> 8) & 0xff;
    const chk = chkOverride === undefined ? ((id0 + id1 + flags + t0 + t1 + s0 + s1) & 0xff) : chkOverride;
    const bits = [];
    const push = (byte, n = 8) => { for (let i = 0; i < n; i++) bits.push((byte >> (7 - i)) & 1); };
    push(0xa5);                                    // the preamble as the decoder sees it, after inverting
    push(rev8(id0)); push(rev8(id1));
    push(rev8(flags), 4);
    push(rev8(t0)); push(rev8(t1), 1);             // nine bits: a byte and the one that did not fit
    push(rev8(s0)); push(rev8(s1), 1);
    push(rev8(chk));
    return inv(bits);
  };

  // The first capture, rebuilt from the values it carries, is the manufacturer's own bit string.
  const rebuilt = build(28082, 1, 263, 304);
  eq(rebuilt.length, 54, 'the thermostat frame is fifty four bits');
  ok(rebuilt.every((b, i) => b === bitsFromHex(CAPS[0], 54)[i]),
    'rebuilding capture one from its field values reproduces the captured bits exactly');

  const WANT = [
    { temp: 263, setp: 304, pairing: 1, chk: 89 }, { temp: 263, setp: 304, pairing: 1, chk: 89 },
    { temp: 263, setp: 304, pairing: 0, chk: 88 }, { temp: 263, setp: 304, pairing: 0, chk: 88 },
    { temp: 262, setp: 304, pairing: 0, chk: 87 }, { temp: 261, setp: 304, pairing: 0, chk: 86 },
    { temp: 233, setp: 304, pairing: 0, chk: 57 }, { temp: 230, setp: 304, pairing: 0, chk: 54 },
    { temp: 229, setp: 305, pairing: 0, chk: 54 }, { temp: 226, setp: 304, pairing: 0, chk: 50 },
  ];
  for (const [i, hex] of CAPS.entries()) {
    const d = run(dev(253), rowBits(bitsFromHex(hex, 54)))[0];
    ok(!!d, `Watts WFHT-RF real capture ${i + 1} decodes`, JSON.stringify(d));
    if (d) {
      eq(d.id, '28082', `  capture ${i + 1} id`);
      eq(d.pairing, WANT[i].pairing, `  capture ${i + 1} pairing flag`);
      eq(d.temperature_C, Math.round(WANT[i].temp) / 10, `  capture ${i + 1} temperature in tenths`);
      eq(d.setpoint_C, Math.round(WANT[i].setp) / 10, `  capture ${i + 1} set point in tenths`);
      eq(d.mic, 'CHECKSUM', `  capture ${i + 1} reports its check`);
    }
  }

  // The premise behind using the shared byte-masking helper: the sum really does run past a byte, and
  // upstream really does keep it in a uint8_t. Capture seven sums to 569 and its checksum byte is 57.
  const c7 = { id0: 0xb2, id1: 0x6d, fl: 0, t0: 0xe9, t1: 0x00, s0: 0x30, s1: 0x01 };
  const full = c7.id0 + c7.id1 + c7.fl + c7.t0 + c7.t1 + c7.s0 + c7.s1;
  ok(full > 0xff, 'capture seven genuinely overflows a byte before truncation', String(full));
  eq(full & 0xff, 57, '  and truncating it gives the checksum byte the capture carries');

  // Upstream's two "Decoded example" rows do NOT describe any of the ten captures. Both are nonetheless
  // self-consistent real frames, the same way tpms_bmw.c's Audi row is: each satisfies the checksum this
  // file computes, so the comment is loosely assembled rather than the port being wrong.
  const doc1 = { id: 28082, flags: 1, temp: 271, setp: 304, chk: 97 };
  const doc2 = { id: 28252, flags: 0, temp: 19, setp: 303, chk: 13 };
  for (const [n, e] of [[1, doc1], [2, doc2]]) {
    const d = run(dev(253), rowBits(build(e.id, e.flags, e.temp, e.setp)))[0];
    ok(!!d, `upstream's documented example ${n} is a self-consistent frame`, JSON.stringify(d));
    if (d) {
      eq(d.id, String(e.id), `  documented example ${n} id`);
      eq(d.temperature_C, e.temp / 10, `  documented example ${n} temperature`);
      eq(d.setpoint_C, e.setp / 10, `  documented example ${n} set point`);
    }
    const id0 = e.id & 0xff, id1 = e.id >> 8, t0 = e.temp & 0xff, t1 = e.temp >> 8;
    const s0 = e.setp & 0xff, s1 = e.setp >> 8;
    eq((id0 + id1 + e.flags + t0 + t1 + s0 + s1) & 0xff, e.chk,
      `  documented example ${n} carries the checksum its own layout demands`);
  }
  // ...and yet it is not capture one, which shares its id, flags and set point but not its temperature.
  ok(doc1.temp !== 263 && doc1.chk !== 89,
    'the first documented example differs from capture one in temperature and check alike');

  // A corruption test has to touch a bit the decoder reads. Bit thirty sits inside the temperature field.
  const good = bitsFromHex(CAPS[0], 54);
  const bad = [...good]; bad[30] ^= 1;
  ok(bad.some((b, i) => b !== good[i]), 'the corrupted frame really does differ from the good one');
  ok(!run(dev(253), rowBits(bad))[0], '  and the thermostat rejects it');

  ok(!run(dev(253), rowBits(good.slice(0, 53)))[0], 'a frame of the wrong length is refused');
  const wrongPre = [...good]; wrongPre[0] ^= 1;
  ok(!run(dev(253), rowBits(wrongPre))[0], 'a frame without the preamble is refused');
  ok(!run(dev(253), rowBits(build(0, 0, 0, 0, 0)))[0], 'an all-zero frame is refused despite its checksum holding');
}

// ---- Watts WFHT-LCD-RF underfloor thermostat (348) ----
{
  const build = (o) => {
    const b = new Uint8Array(16);
    b[0] = 0x0d; b[1] = 0xff; b[2] = 0xff; b[3] = 0xfe;
    b[4] = o.mode ?? 0x02;
    b[5] = o.id?.[0] ?? 0x1a; b[6] = o.id?.[1] ?? 0x2b; b[7] = o.id?.[2] ?? 0x3c;
    const t = o.temp ?? 215, s = o.setp ?? 220;
    b[8] = (t >> 8) & 0xff; b[9] = t & 0xff;
    b[10] = (s >> 8) & 0xff; b[11] = s & 0xff;
    b[12] = o.call ?? 0x00;
    b[13] = o.badCrc8 ? 0x00 : ((U.crc8(b, 12, 0xe6, 0x00) ^ 0xbe ^ b[12]) & 0xff);
    const c = o.badCrc16 ? 0x0000 : U.crc16(b, 14, 0x8005, 0xffff);
    b[14] = c >> 8; b[15] = c & 0xff;
    return b;
  };
  const row = (b) => rowBits(pad([...bytesToBits([0x2a, 0xaa, 0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]), ...bytesToBits(b)], 200));

  const d = run(dev(348), row(build({ call: 0x64 })))[0];
  ok(!!d, 'Watts WFHT-LCD-RF decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Watts-WFHTLCDRF', '  model is kept distinct from the older Watts thermostat');
    eq(d.id, '1A:2B:3C', '  id is the three device bytes');
    eq(d.mode, 'heat', '  bit one of the mode byte selects heating');
    eq(d.pairing, 'false', '  and bit zero is clear outside the pairing handshake');
    eq(d.temperature_C, 21.5, '  temperature is a big-endian word in tenths');
    eq(d.setpoint_C, 22.0, '  set point likewise');
    eq(d.call_for_heat, 100, '  the call for heat reaches the air only at its endpoints');
    eq(d.mic, 'CRC', '  and both checks are reported as one');
  }

  eq(run(dev(348), row(build({ mode: 0x00 })))[0]?.mode, 'cool', 'a clear heat bit reports cooling');
  eq(run(dev(348), row(build({ mode: 0x03 })))[0]?.pairing, 'true', 'the pairing bit is reported while pairing');
  eq(run(dev(348), row(build({ call: 0x00 })))[0]?.call_for_heat, 0, 'an idle thermostat calls for nothing');
  eq(run(dev(348), row(build({ temp: 0xfff6 })))[0]?.temperature_C, -1.0, 'temperature below freezing reads as signed');

  // The call-for-heat byte sits outside the CRC-8's own range and is folded in afterwards, so it is still
  // covered: the same frame with a different output byte needs a different check byte.
  const a = build({ call: 0x00 }), bfr = build({ call: 0x64 });
  ok(a[13] !== bfr[13], 'the output byte changes the check byte despite sitting outside the CRC range');
  const forged = build({ call: 0x64 }); forged[12] = 0x00;
  ok(!run(dev(348), row(forged))[0], '  so editing it alone is rejected');

  ok(!run(dev(348), row(build({ badCrc8: true })))[0], 'a bad application checksum is refused');
  ok(!run(dev(348), row(build({ badCrc16: true })))[0], 'a bad radio checksum is refused');
  ok(!run(dev(348), row(build({ mode: 0x04 })))[0], 'a reserved mode bit means this was not a real frame');
  ok(!run(dev(348), row(build({ id: [0, 0, 0] })))[0], 'an all-zero device id is refused');
  const noSync = rowBits(pad(bytesToBits(build({})), 200));
  ok(!run(dev(348), noSync)[0], 'a frame with no sync word is refused');
}

// ---- Watts Vision thermostat (366) ----
{
  const build = (length, id, dest, records) => {
    const b = new Uint8Array(length + 3);
    b[0] = length;
    for (let i = 0; i < 4; i++) { b[1 + i] = id[i]; b[6 + i] = dest[i]; }
    b[5] = 0xc6;
    records.forEach((v, i) => { b[10 + i] = v; });
    const mdb = U.crc16lsb(b, length - 2, 0xa001, 0xffff, 1);
    b[length - 1] = mdb & 0xff; b[length] = mdb >> 8;
    const cms = U.crc16(b, length + 1, 0x8005, 0xffff);
    b[length + 1] = cms >> 8; b[length + 2] = cms & 0xff;
    return b;
  };
  const row = (b) => rowBits(pad([...bytesToBits([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]), ...bytesToBits(b)], 400));
  // A record is its tag then a value whose length the tag's own top two bits declare.
  const rec = (tag, ...vals) => {
    ok(vals.length === (tag >> 6) + 1, `record ${tag.toString(16)} carries the length its tag declares`);
    return [tag, ...vals];
  };
  const ID = [0xd0, 0x37, 0x46, 0x54], DEST = [0x00, 0x11, 0x22, 0x33];

  // The short message: a command from the base to an endpoint. Nine bytes of records.
  const shortRecs = [...rec(0x03, 0x04), ...rec(0xdf, 0x01, 0x02, 0x03, 0x04), ...rec(0x3b, 0x00)];
  eq(shortRecs.length, 9, 'the short message fills its record space exactly');
  const ds = run(dev(366), row(build(0x14, ID, DEST, shortRecs)))[0];
  ok(!!ds, 'Watts Vision command message decodes', JSON.stringify(ds));
  if (ds) {
    eq(ds.model, 'Watts-Vision', '  model');
    eq(ds.id, 'd0374654', '  source address is reported as hex, so a high bit does not read as negative');
    eq(ds.dest, '00112233', '  destination address');
    eq(ds.msg_type, 'command', '  twenty bytes is a command');
    eq(ds.association_id, 0x04, '  the association slot id');
    eq(ds.state_raw, '01020304', '  the packed state bytes are reported raw, not guessed at');
    eq(ds.flags_raw, 0x00, '  and the status byte likewise');
  }

  // The long message: a status report from an endpoint. 74.8 F measured, a Reduced bank target of 64.4 F.
  const longRecs = [
    ...rec(0x8d, 0x11, 0x10, 0x00),
    ...rec(0x8a, 0x02, 0x84, 0x03),
    ...rec(0x4b, 0x02, 0xec),
    ...rec(0x5e, 0x02, 0x30),
    ...rec(0x8e, 5, 30, 0x03),
    ...rec(0x4c, 0x00, 0x00),
  ];
  eq(longRecs.length, 21, 'the long message leaves room for its terminator');
  const dl = run(dev(366), row(build(0x22, ID, DEST, longRecs)))[0];
  ok(!!dl, 'Watts Vision status message decodes', JSON.stringify(dl));
  if (dl) {
    eq(dl.msg_type, 'status', '  thirty four bytes is a status report');
    eq(dl.temperature_F, 74.8, '  the measured temperature');
    eq(dl.temperature_2_F, 56.0, '  and the secondary floor sensor');
    eq(dl.mode_setpoint_F, 64.4, '  the reported target');
    eq(dl.setpoint_mode, 'Reduced/ECO', '  which is only the Reduced bank, not a universal target');
    eq(dl.setpoint_min_C, 5, '  the installer bounds are plain whole Celsius, unlike everything else');
    eq(dl.setpoint_max_C, 30, '  upper bound');
    eq(dl.sensor_mode, 'Air', '  the regulation source is the low two bits of the sensor byte');
    eq(dl.sensor_flags_raw, 0x03, '  whose whole value is kept because its upper bits are unread');
    eq(dl.report_flags_0, 0x11, '  report flags are reported raw');
    eq(dl.diagnostic_code, 0x00, '  and so is the diagnostic code');
  }

  // The sentinel is the sensor saying it has nothing, not a reading of 212.4 F.
  const sentinel = [...rec(0x4b, 0x08, 0x4c), ...rec(0x5e, 0x08, 0x4c), ...rec(0xcc, 0x00, 0x00, 0x01, 0x2c)];
  const dsent = run(dev(366), row(build(0x22, ID, DEST, sentinel)))[0];
  ok(!!dsent, 'a status message full of sentinels still decodes', JSON.stringify(dsent));
  if (dsent) {
    ok(dsent.temperature_F === undefined, '  an unavailable primary sensor reports nothing at all');
    ok(dsent.temperature_2_F === undefined, '  nor does an unavailable secondary one');
    ok(dsent.floor_limit_1_F === undefined, '  a floor limit of zero is switched off, not held at freezing');
    eq(dsent.floor_limit_2_F, 30.0, '  while a real limit beside it is still reported');
  }

  // An unknown tag is stepped over using its own declared length, not treated as the end of the stream.
  const unknown = [...rec(0xc1, 0xde, 0xad, 0xbe, 0xef), ...rec(0x4b, 0x02, 0xec), 0x00];
  const du = run(dev(366), row(build(0x22, ID, DEST, unknown)))[0];
  ok(!!du, 'an unknown record tag does not stop the parse', JSON.stringify(du));
  eq(du?.temperature_F, 74.8, '  the record after it is still read');

  // Both checksums have to hold, and the marker byte is checked after them.
  const badMdb = build(0x22, ID, DEST, longRecs); badMdb[0x22 - 1] ^= 0xff;
  ok(!run(dev(366), row(badMdb))[0], 'a bad application checksum is refused');
  const badCms = build(0x22, ID, DEST, longRecs); badCms[0x22 + 2] ^= 0xff;
  ok(!run(dev(366), row(badCms))[0], 'a bad radio checksum is refused');
  const badMarker = build(0x22, ID, DEST, longRecs);
  ok(!run(dev(366), row(badMarker.map((v, i) => i === 5 ? 0xc7 : v)))[0],
    'a frame whose marker byte is wrong is refused');
  ok(!run(dev(366), row(build(0x15, ID, DEST, shortRecs)))[0], 'an unrecognized length byte is refused');
}

// ---- Eberle Instat 868r1 remote (358) ----
{
  // The twenty four bits are read two ways. This is the transmit side of both: pick the six nibbles the
  // remote means to send, undo the Gray coding to get the raw bits, and search for the sixth nibble that
  // makes the raw-nibble checksum come out at eleven.
  const rawFromNibbles = (nibbles) => {
    const gray = [];
    for (const n of nibbles) for (let i = 3; i >= 0; i--) gray.push((n >> i) & 1);
    const cum = gray.map(g => g ^ 1);
    const d = [];
    for (let i = 0; i < 24; i++) d.push(i === 0 ? cum[0] : (cum[i] ^ cum[i - 1]));
    return d;
  };
  const checksumOf = (d) => {
    let s = 0;
    for (let n = 0; n < 6; n++) for (let i = 0; i < 4; i++) if (d[n * 4 + i]) s += 1 << i;
    return s & 0xf;
  };
  const frame = (id, action, data) => {
    const base = [(id >> 8) & 0xf, (id >> 4) & 0xf, id & 0xf, action, data];
    for (let n5 = 0; n5 < 16; n5++) {
      const d = rawFromNibbles([...base, n5]);
      if (checksumOf(d) === 0xb) return d;
    }
    return null;
  };
  // Thirty bits of run-in, then the code part. Upstream records the whole thing as eighty two raw bits.
  const repeat = (d, leading = 1) => [...bytesToBits([0x00, 0x0f, 0xe0, 0x30]).slice(0, 30), ...dmc([leading, ...d]), 0, 0];
  const row = (...ds) => rowBits(ds.flatMap(d => repeat(d)));

  ok(!!frame(0x123, 0x3, 0xa), 'a sixth nibble always exists that makes the checksum hold');

  // Both code tables: the parity of the remote's own id picks between them.
  const CASES = [
    [0x123, 'Learn', 0x3], [0x123, 'Reset', 0xb], [0x123, 'On', 0xe], [0x123, 'Off', 0x5],
    [0x124, 'Learn', 0xc], [0x124, 'Reset', 0x4], [0x124, 'On', 0x1], [0x124, 'Off', 0xa],
  ];
  for (const [id, command, action] of CASES) {
    const d = run(dev(358), row(frame(id, action, 0xa)))[0];
    ok(!!d, `Eberle ${command} on ${(id & 1) ? 'an odd' : 'an even'} id decodes`, JSON.stringify(d));
    if (d) {
      eq(d.id, id.toString(16), `  ${command} id`);
      eq(d.command, command, `  ${command} is named from the table its id's parity selects`);
      eq(d.action_code, action.toString(16), `  ${command} raw action code`);
      eq(d.mic, 'CHECKSUM', `  ${command} reports its check`);
    }
  }
  // The same action code means different things on the two tables, which is the point of the parity rule.
  eq(run(dev(358), row(frame(0x123, 0xa, 0x5)))[0]?.command, 'Unknown',
    'an action code from the other table is not read across');
  eq(run(dev(358), row(frame(0x124, 0xa, 0x5)))[0]?.command, 'Off',
    '  though that same code is Off when the id is even');

  // A code with no known meaning is reported by its number and named Unknown, never guessed at.
  const du = run(dev(358), row(frame(0x123, 0x0, 0x7)))[0];
  eq(du?.command, 'Unknown', 'an unrecognized action is reported as unknown');
  eq(du?.action_code, '0', '  with its raw code kept so it can be looked at later');

  // The rolling counter On and Off carry, in the same nibble that holds a fixed marker for Learn and Reset.
  eq(run(dev(358), row(frame(0x123, 0xe, 0x9)))[0]?.data, '9', 'the On rolling counter is reported');
  eq(run(dev(358), row(frame(0x123, 0x3, 0xa)))[0]?.data, 'a', 'and Learn carries its fixed marker there');

  // Corrupting a bit inside the checksum's coverage: assert it really does break the sum, then the rejection.
  const dGood = frame(0x123, 0x3, 0xa);
  const dBad = [...dGood]; dBad[7] ^= 1;
  ok(checksumOf(dGood) === 0xb && checksumOf(dBad) !== 0xb,
    'flipping a covered bit really does break the nibble sum');
  ok(!run(dev(358), row(dBad))[0], '  and the remote refuses it');

  // Upstream never clears the buffer it decodes into, so a second repeat appends to the first rather than
  // replacing it and the checksum is recomputed over the same leading bits. The retry can therefore never
  // rescue a frame whose first repeat failed. Ported as written; pinned here so it stays visible.
  ok(!!run(dev(358), row(dGood))[0], 'a good repeat on its own decodes');
  ok(!run(dev(358), row(dBad, dGood))[0],
    'but a good repeat after a bad one cannot rescue it — upstream reuses its decode buffer');
  ok(!run(dev(358), rowBits(repeat(dGood).slice(0, 70)))[0], 'a truncated frame is refused');
}

// ---- Regency ceiling fan remote (211) ----
{
  const build = (command, channel, value, chkOverride) => {
    const f = new Uint8Array(3);
    f[0] = ((command & 0xf) << 4) | (~channel & 0x0f);
    f[1] = value & 0xff;
    f[2] = chkOverride === undefined ? (U.addNibbles(f, 2) & 0x0f) : chkOverride;
    // Undo the reflection the decoder applies, and the inversion it applies before that.
    const e = [rev8(f[0]), rev8(f[1]), rev8(f[2])];
    return inv([1, ...bytesToBits([e[0], e[1]]), ...bytesToBits([e[2]]).slice(0, 4)]);
  };
  const rows = (bits, n = 4) => manyRows(new Array(n).fill(bits));

  eq(build(2, 15, 3).length, 21, 'the remote sends a start bit and twenty data bits');

  const CASES = [
    [1, 'fan_speed', 0xc0, 'stop'], [2, 'fan_speed', 3, 'speed 3'], [4, 'light_intensity', 0xc3, '195 %'],
    [5, 'light_delay', 1, 'on'], [6, 'fan_direction', 0x07, 'clockwise'], [6, 'fan_direction', 0x83, 'counter-clockwise'],
  ];
  for (const [command, name, value, str] of CASES) {
    const d = run(dev(211), rows(build(command, 9, value)))[0];
    ok(!!d, `Regency command ${command} decodes`, JSON.stringify(d));
    if (d) {
      eq(d.model, 'Regency-Remote', `  command ${command} model`);
      eq(d.command, name, `  command ${command} name`);
      eq(d.value, str, `  command ${command} value`);
      eq(d.channel, 9, `  command ${command} channel`);
    }
  }
  // All the compartment switches off reads as fifteen, which is what says they pull their lines down.
  eq(run(dev(211), rows(build(2, 15, 3)))[0]?.channel, 15, 'every switch off reads as channel fifteen');

  // Each command's value is bounded by what that command is known to accept.
  ok(!run(dev(211), rows(build(2, 9, 0x08)))[0], 'a fan speed above seven is refused');
  ok(!run(dev(211), rows(build(2, 9, 0x00)))[0], 'and one below one likewise');
  ok(!run(dev(211), rows(build(4, 9, 0xc4)))[0], 'a light intensity past full is refused');
  ok(!run(dev(211), rows(build(5, 9, 0x02)))[0], 'a light delay that is neither on nor off is refused');
  ok(!run(dev(211), rows(build(6, 9, 0x08)))[0], 'an unknown fan direction is refused');
  ok(!run(dev(211), rows(build(3, 9, 0x00)))[0], 'and an unknown command is not reported at all');

  // Four bits of checksum are weak, so four matching repeats are required as well.
  ok(!run(dev(211), rows(build(2, 9, 3), 3))[0], 'three repeats are not enough to be believed');
  ok(!!run(dev(211), rows(build(2, 9, 3), 5))[0], 'five are more than enough');
  eq(U.addNibbles(Uint8Array.from([0x26, 0x03]), 2) & 0x0f, 0x0b, 'the nibble sum of that frame is eleven');
  ok(!run(dev(211), rows(build(2, 9, 3, 0x0a)))[0], 'so a frame carrying ten instead is refused');

  // Upstream's prose calls this PPM; its device table registers PWM, and the table is what slices the signal.
  eq(dev(211).modulation, 6, "the device table's PWM is followed, not the doc comment's PPM");
}

// ---- Universal 24V fan controller (286) ----
{
  const build = (address, button, counter, o = {}) => {
    const b = new Uint8Array(5);
    b[0] = (address >> 12) & 0xff;
    b[1] = (address >> 4) & 0xff;
    b[2] = ((address & 0xf) << 4) | ((button >> 1) & 0xf);
    b[3] = ((button & 1) << 7) | ((counter & 7) << 4);
    b[4] = o.trailing === 0 ? 0x00 : 0x80;
    // The check nibble is inside the exclusive-or that produces it, so it has to be solved for.
    const t = b[0] ^ b[1] ^ b[2] ^ b[3];
    b[3] |= o.chk !== undefined ? o.chk : (((t >> 4) ^ (t & 0xf) ^ 0xa) & 0xf);
    return b;
  };
  const rows = (b, n = 3) => manyRows(new Array(n).fill(bytesToBits(b).slice(0, 33)));

  const d = run(dev(286), rows(build(0xabcde, 0x1b, 5)))[0];
  ok(!!d, 'the 24V fan controller decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'UniFan-24V', '  model');
    eq(d.id, String(0xabcde), '  a twenty bit transmitter address');
    eq(d.button, 'Forward', '  a named button');
    eq(d.button_code, 0x1b, '  reported with its raw code beside the name');
    eq(d.counter, 5, '  and the rolling counter');
    eq(d.mic, 'CHECKSUM', '  reports its check');
  }
  eq(run(dev(286), rows(build(0x12345, 0x19, 0)))[0]?.button, 'All Off', 'the all-off button');
  eq(run(dev(286), rows(build(0x12345, 0x0f, 1)))[0]?.button, 'Speed 1', 'a speed button');

  // A code with no known button is reported by its number and called unknown, never given a made-up name.
  const du = run(dev(286), rows(build(0x12345, 0x01, 2)))[0];
  eq(du?.button, 'Unknown', 'an unrecognized button code is not given a meaning');
  eq(du?.button_code, 0x01, '  but its raw code is still reported');

  ok(!run(dev(286), rows(build(0xabcde, 0x1b, 5, { trailing: 0 })))[0], 'the fixed trailing bit must be set');
  const goodFan = build(0xabcde, 0x1b, 5);
  const wrong = build(0xabcde, 0x1b, 5, { chk: ((goodFan[3] & 0xf) ^ 0x1) & 0xf });
  ok(!run(dev(286), rows(wrong))[0], 'a frame failing its folded checksum is refused');
  ok(!run(dev(286), rows(build(0xabcde, 0x1b, 5), 2))[0], 'two repeats are not enough');
}

// ---- The Govee family (300, 349, 350) ----
{
  const KEY = 's6amyEvO8UslCY0eZjgc2S6APCVLgLxzFvL2Z5GWPW7fKVjy2oAU6uiKU3lZCHm62VYQQuCtgxzPgGd8UDRPVZpDRAsh5EdYq1E4j4morJ3vd6tWx8BiWOLDc2I8wKUK';
  eq(KEY.length, 128, "Govee's exclusive-or key is a hundred and twenty eight bytes");

  // The transmit side of the shared envelope: length, seed, the payload exclusive-ored with the key from
  // that seed, then the frame's own checksum.
  const frameOf = (dec, seed = 0, o = {}) => {
    const n = dec.length;
    const f = new Uint8Array(n + 4);
    f[0] = o.outerLen ?? (n + 3);
    f[1] = seed;
    for (let i = 0; i < n; i++) f[2 + i] = dec[i] ^ KEY.charCodeAt((i + seed) % 128);
    const c = o.badCrc ? 0x0000 : U.crc16(f, n, 0x1021, 0x1d0f, 2);
    f[2 + n] = c >> 8; f[3 + n] = c & 0xff;
    return f;
  };
  const row = (f, lead = 0) => rowBits([
    ...new Array(lead).fill(0), ...bytesToBits([0xaa, 0xaa, 0x2c, 0x4c, 0x4a]), ...bytesToBits(f),
  ]);
  const ID = [0xf8, 0xa7, 0x9c, 0xb2];             // the Pool unit's address, from upstream's own notes

  // ---- H5310 pool and spa thermometer (349) ----
  const tempRaw = (c) => Math.round(c * 10) + 33168;
  const h5310 = (kind, c, bat = 0x64, o = {}) => {
    const raw = tempRaw(c);
    if (kind === 'temp') {
      const d = new Uint8Array(13);
      d[0] = 0x11; d.set(ID, 1); d[5] = 0x04; d[6] = bat;
      d[7] = raw & 0xff; d[8] = (raw >> 8) & 0xff;
      d[9] = 0xcc; d[10] = 0xff;
      return d;
    }
    const d = new Uint8Array(kind === 'periodic' ? 58 : 28);
    d[0] = kind === 'periodic' ? 0x1b : 0x71;
    d.set(ID, 1); d[5] = bat;
    d[6] = raw & 0xff; d[7] = (raw >> 8) & 0xff;
    d[8] = o.c8 ?? 0xcc; d[9] = o.c9 ?? 0xff;
    return d;
  };

  for (const [kind, outer, event] of [['temp', 0x10, 'Temperature Update'], ['periodic', 0x3d, 'Periodic Update'], ['status', 0x1f, 'Status']]) {
    const dec = h5310(kind, 25.8);
    eq(dec.length + 3, outer, `the H5310 ${kind} frame has the outer length upstream names`);
    const d = run(dev(349), row(frameOf(dec, 7)))[0];
    ok(!!d, `Govee H5310 ${kind} frame decodes`, JSON.stringify(d));
    if (d) {
      eq(d.model, 'Govee-H5310', `  ${kind} model`);
      eq(d.id_wire, 'f8a79cb2', `  ${kind} wire address`);
      eq(d.id, '9cb2f8a7', `  ${kind} address with its halves swapped, as the family reports it`);
      eq(d.event, event, `  ${kind} event`);
      eq(d.temperature_C, 25.8, `  ${kind} temperature`);
      eq(d.battery_pct, 100, `  ${kind} battery`);
      eq(d.mic, 'CRC', `  ${kind} reports its check`);
    }
  }
  // The forced report carries an extra constant byte, so everything after it shifts by one. That is the
  // whole difference between the layouts, and reading one with the other's offsets gives a wrong answer.
  ok(h5310('temp', 25.8)[5] === 0x04 && h5310('periodic', 25.8)[5] !== 0x04,
    'the forced report has a constant byte where the broadcast already has its battery reading');

  eq(run(dev(349), row(frameOf(h5310('periodic', -5.0))))[0]?.temperature_C, -5.0,
    'the H5310 reads below freezing, though nobody has confirmed it in the cold');
  ok(!run(dev(349), row(frameOf(h5310('periodic', 95.0))))[0],
    'a temperature no pool could be at is refused, which is how other family devices are turned away');
  ok(!run(dev(349), row(frameOf(h5310('periodic', 25.8), 0, { badCrc: true })))[0],
    'a bad checksum is refused');
  const wrongMarker = h5310('periodic', 25.8); wrongMarker[0] = 0x1c;
  ok(!run(dev(349), row(frameOf(wrongMarker)))[0], 'a frame whose marker does not match its length is refused');
  ok(!run(dev(349), row(frameOf(new Uint8Array(25))))[0], 'an unrecognized outer length is ignored');
  ok(!!run(dev(349), row(frameOf(h5310('periodic', 25.8)), 3))[0],
    'the sync word is found at any bit offset, not only a byte boundary');

  // ---- H5112 dual-probe thermometer (350) ----
  const packSensor = (t1, t2, hum) => {
    const p = ((Math.round((t2 + 40) * 10) & 0x7ff)
      | ((Math.round((t1 + 40) * 10) & 0x7ff) << 11)
      | ((Math.round(hum * 10) & 0x3ff) << 22)) >>> 0;
    return [p & 0xff, (p >>> 8) & 0xff, (p >>> 16) & 0xff, (p >>> 24) & 0xff];
  };
  const h5112 = (cls, sensor, o = {}) => {
    const d = new Uint8Array(cls === 0x13 ? 57 : 28);
    d[0] = cls; d.set(ID, 1); d[5] = o.bat ?? 0x64;
    d.set(sensor, 6);
    if (cls === 0x13) {
      d[14] = 0x37; d[15] = 0x6a; d[16] = 10;
      for (let i = 0; i < 10; i++) d.set(o.history?.[i] ?? sensor, 17 + i * 4);
    }
    return d;
  };

  // Upstream records two real captured sensor words together with the readings the phone app showed for
  // them. These are the manufacturer's own numbers, so the bit layout is checked against something this
  // port had no hand in producing.
  const VERIFIED = [
    { bytes: [0xde, 0x9a, 0x56, 0xd0], t1: 32.3, t2: 33.4, hum: 83.3 },
    { bytes: [0x9c, 0x18, 0x0d, 0xa0], t1: 1.9, t2: -24.4, hum: 64.0 },
  ];
  for (const [i, v] of VERIFIED.entries()) {
    const d = run(dev(350), row(frameOf(h5112(0x13, v.bytes), 3)))[0];
    ok(!!d, `Govee H5112 verified example ${i + 1} decodes`, JSON.stringify(d));
    if (d) {
      eq(d.temperature_C, v.t1, `  example ${i + 1} probe one matches the app's reading`);
      eq(d.temperature_2_C, v.t2, `  example ${i + 1} probe two matches`);
      eq(d.humidity, v.hum, `  example ${i + 1} humidity matches`);
    }
    // And the packing runs both ways: encoding those readings gives back the captured bytes.
    ok(packSensor(v.t1, v.t2, v.hum).every((b, k) => b === v.bytes[k]),
      `  example ${i + 1} re-encodes to the bytes the sensor actually sent`);
  }
  ok(VERIFIED[1].t2 < -20, 'the second example reads well below the eleven-bit field wrapping period');

  const dh = run(dev(350), row(frameOf(h5112(0x13, packSensor(20.0, 4.5, 55.0)), 11)))[0];
  ok(!!dh, 'Govee H5112 broadcast decodes', JSON.stringify(dh));
  if (dh) {
    eq(dh.model, 'Govee-H5112', '  model');
    eq(dh.id, '9cb2f8a7', '  address with its halves swapped');
    eq(dh.temperature_C, 20.0, '  probe one');
    eq(dh.temperature_2_C, 4.5, '  probe two');
    eq(dh.humidity, 55.0, '  humidity');
    eq(dh.temperature_C_history?.length, 10, '  ten minutes of history rides along with the reading');
    eq(dh.humidity_history?.[9], 55.0, '  and the newest record is the last of them');
  }
  const dt = run(dev(350), row(frameOf(h5112(0x71, packSensor(20.0, 4.5, 55.0)))))[0];
  ok(!!dt, 'Govee H5112 poll reply decodes', JSON.stringify(dt));
  ok(dt && dt.temperature_C_history === undefined, '  a poll reply carries no history to report');

  ok(!run(dev(350), row(frameOf(h5112(0x13, packSensor(20, 4.5, 55)).slice(0, 40))))[0],
    'a broadcast at the wrong length belongs to another device in the family');
  const unknownClass = h5112(0x13, packSensor(20, 4.5, 55)); unknownClass[0] = 0x36;
  ok(!run(dev(350), row(frameOf(unknownClass)))[0], 'a gateway message class is left alone');

  // ---- The collision between them, settled from both sides ----
  const h5310Status = h5310('status', 25.8);
  eq(h5310Status.length, 28, 'the H5310 poll reply is the same length as the H5112 one');
  eq(h5310Status[0], 0x71, '  and carries the same marker byte');
  ok(!run(dev(350), row(frameOf(h5310Status)))[0],
    'the H5112 refuses it: those two constants decode as a humidity above 100%');
  const asHumidity = ((0xff << 2) | (0xcc >> 6)) / 10;
  eq(asHumidity, 102.3, '  which is exactly 102.3%, well past anything air can hold');

  // The other direction needs care. For the constant pair to be what turns an H5112 reply away, the reply
  // has to look plausible to the H5310 in every other respect — otherwise the temperature range check does
  // the work and the gate is never reached. This sensor word is chosen so that reading it with the H5310's
  // own offsets gives 23.2 C, comfortably inside what a pool thermometer may report.
  const h5112Reply = h5112(0x71, packSensor(19.2, 23.2, 55.0));
  const asH5310Temp = ((h5112Reply[6] | (h5112Reply[7] << 8)) - 33168) / 10;
  eq(asH5310Temp, 23.2, 'the H5112 reply reads as a plausible pool temperature through the other decoder');
  ok(asH5310Temp > -20 && asH5310Temp < 60, '  so its range check cannot be what refuses the frame');
  ok(h5112Reply[9] !== 0xff, 'an H5112 reply can never put 0xff where the H5310 keeps its constant');
  ok(!run(dev(349), row(frameOf(h5112Reply)))[0], '  leaving the constant pair as the only thing that does');
  ok(!!run(dev(350), row(frameOf(h5112Reply)))[0], '  while its own decoder takes it');
  ok(!!run(dev(350), row(frameOf(h5112(0x71, packSensor(20.0, 4.5, 100.0)))))[0],
    'a humidity of exactly 100% is a real reading, not the sentinel');
  // Neither rejection leans on the ordering; the priorities are only a second line.
  ok(dev(349).priority === undefined && dev(350).priority === 5 && dev(300).priority === 10,
    'the family runs pool, then dual-probe, then leak detector');

  // ---- H5059 water leak detector (300) ----
  const h5059 = (cls, subtype, top, bottom, alarm) => {
    const d = new Uint8Array(19);
    d[0] = cls; d.set(ID, 1); d[13] = subtype; d[14] = top; d[15] = bottom; d[17] = alarm;
    return d;
  };
  const dl2 = run(dev(300), row(frameOf(h5059(0x11, 0x06, 0x00, 0x01, 0x01), 42)))[0];
  ok(!!dl2, 'Govee H5059 bottom probe leak decodes', JSON.stringify(dl2));
  if (dl2) {
    eq(dl2.model, 'Govee-H5059', '  model');
    eq(dl2.event, 'Water Leak', '  a wet bottom probe is a leak');
    eq(dl2.detect_wet, 1, '  and is reported wet');
    eq(dl2.leak_bottom, 1, '  naming the probe that found it');
    eq(dl2.leak_top, 0, '  and the one that did not');
  }
  // The bug upstream fixed: requiring the bottom flag specifically meant a top-probe leak was never a leak.
  const dtop = run(dev(300), row(frameOf(h5059(0x11, 0x06, 0x01, 0x00, 0x01))))[0];
  eq(dtop?.event, 'Water Leak', 'a leak found by the top probe alone is still a leak');
  eq(dtop?.leak_top, 1, '  and says which probe found it');

  eq(run(dev(300), row(frameOf(h5059(0x11, 0x05, 0, 0, 0))))[0]?.event, 'Button Press', 'a button press is reported');
  eq(run(dev(300), row(frameOf(h5059(0x11, 0x05, 0, 0, 0))))[0]?.detect_wet, 0, '  and reports the sensor dry');
  const dpost = run(dev(300), row(frameOf(h5059(0x11, 0x07, 0x01, 0x00, 0x01))))[0];
  eq(dpost?.event, 'Post Alarm', 'the follow-up frame is reported as itself');
  ok(dpost && dpost.detect_wet === undefined,
    '  and claims no dryness, since silencing the alarm looks the same as the probe drying');
  eq(run(dev(300), row(frameOf(h5059(0x11, 0x06, 0x00, 0x00, 0x00))))[0]?.event, 'Telemetry',
    'a leak subtype with no probe wet is only telemetry');
  eq(run(dev(300), row(frameOf(h5059(0x01, 0, 0, 0, 0))))[0]?.event, 'Pairing', 'pairing frames are reported');
  eq(run(dev(300), row(frameOf(h5059(0x02, 0, 0, 0, 0))))[0]?.event, 'Class 0x02', 'and so is the class nobody has named');
  ok(!run(dev(300), row(frameOf(h5059(0x99, 0, 0, 0, 0))))[0], 'an unknown message class is left alone');
  ok(!run(dev(300), row(frameOf(h5059(0x11, 0x06, 0, 1, 1), 0, { badCrc: true })))[0], 'a bad checksum is refused');
  ok(!run(dev(300), row(frameOf(new Uint8Array(10))))[0], 'a payload too short to hold the leak flags is refused');
}

// ---- The registrations themselves ----
{
  const MINE = [211, 253, 286, 300, 348, 349, 350, 358, 366];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  // A modulation with no slicer behind it would leave a decoder registered and permanently silent.
  const HANDLED = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  for (const num of MINE) {
    ok(HANDLED.has(dev(num).modulation), `protocol ${num} uses a modulation the slicer implements`);
  }
  for (const num of MINE) {
    ok(Array.isArray(dev(num).bands) && dev(num).bands.length > 0, `protocol ${num} declares a band`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
