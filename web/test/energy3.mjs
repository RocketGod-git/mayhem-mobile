/**
 * Energy monitors: EcoDHOME, GEO minim+, the BM5 battery sensor, and the two Elster meters.
 *
 * EcoDHOME is the only one of the five with published radio, and it ships five captures — including one of
 * the same socket message recorded a bit out of alignment, which is used deliberately: it proves the preamble
 * search and the unaligned extraction behind it, since the frame starts at bit 25 rather than a byte boundary.
 *
 * The rest are built from the transmit side, with every checksum computed by an implementation written from
 * the definition rather than imported from the code under test.
 *
 * The Elster frames are placed at a deliberately odd bit offset. Those decoders do not trust a sync position
 * at all -- they try every bit in the row and accept the first that yields a length and a matching CRC -- so a
 * frame sitting at bit zero would not exercise the thing that actually makes them work.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** Written from the definitions, not imported, so building and checking stay independent. */
const crc16Ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[i] << 8;
    for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff;
  }
  return r;
};
/** CRC-16/X-25: reflected, init all ones, complemented at the end. */
const x25Ref = (m, n) => {
  let r = 0xffff;
  for (let i = 0; i < n; i++) {
    r ^= m[i];
    for (let k = 0; k < 8; k++) r = (r & 1) ? ((r >> 1) ^ 0x8408) & 0xffff : (r >> 1);
  }
  return (r ^ 0xffff) & 0xffff;
};

const fromHex = (h, n) => {
  const b = [];
  for (const c of h.replace(/[^0-9a-fA-F]/g, '')) { const v = parseInt(c, 16); for (let i = 3; i >= 0; i--) b.push((v >> i) & 1); }
  return n === undefined ? b : b.slice(0, n);
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const inv = (bits) => bits.map(b => b ^ 1);

console.log('EcoDHOME, GEO minim+, BM5 and the Elster meters');

// ---- EcoDHOME (174): five real captures ----
{
  const d = dev(174);
  const TX = [
    ['aaaaaa 2dd4 8c74 d4b9 3eb3 223844 51 550000', 144, 0x8c74d4b9, 0x3eb3, 1519, 0x223844],
    ['aaaaaa 2dd4 8c74 d4b9 3eb3 c53344 ef 550000', 144, 0x8c74d4b9, 0x3eb3, 146, 0xc53344],
  ];
  for (const [cap, n, id, mt, pw, raw] of TX) {
    const out = run(d, rowOf(fromHex(cap, n)));
    eq(out.length, 1, `EcoDHOME decodes transmitter capture ${cap.slice(12, 24)}`);
    eq(out[0]?.model, 'EcoDHOME-Transmitter', 'reported as the transmitter');
    eq(out[0]?.id, id, 'EcoDHOME transmitter id');
    eq(out[0]?.message_type, mt, 'EcoDHOME message type');
    eq(out[0]?.power_W, pw, 'EcoDHOME power, with the 0x33 bias removed inside a byte');
    eq(out[0]?.raw, raw, 'EcoDHOME raw field');
  }

  // The third transmitter capture is a status message, not a reading, so no power is claimed.
  {
    const out = run(d, rowOf(fromHex('aaaaaa 2dd4 8c76 d4b9 71b3 863363 04 550000', 144)));
    eq(out.length, 1, 'EcoDHOME decodes the 71b3 status capture');
    eq(out[0]?.message_type, 0x71b3, 'EcoDHOME status message type');
    eq(out[0]?.power_W, undefined, 'and reports no power for a message type that does not carry one');
    eq(out[0]?.id, 0x8c76d4b9, 'EcoDHOME id from the status capture');
  }

  // The socket, and the same message recorded a bit out of alignment.
  const SOCKET = '55a8 aaaaaa 2dd4 5231 5c6a 7700 565a 7f00 53 42 4';
  const SHIFTED = '2ad455555516ea2918ae353b802b2d3f8029a12';
  for (const [tag, cap, n] of [['aligned', SOCKET, 154], ['bit-shifted', SHIFTED, 155]]) {
    const out = run(d, rowOf(fromHex(cap, n)));
    eq(out.length, 1, `EcoDHOME decodes the ${tag} socket capture`);
    eq(out[0]?.model, 'EcoDHOME-SmartSocket', `${tag}: reported as the socket`);
    eq(out[0]?.id, 0x52315c6a, `${tag}: socket id`);
    eq(out[0]?.message_type, 0x7700, `${tag}: socket message type`);
    eq(out[0]?.message_subtype, 0x565a, `${tag}: socket subtype`);
    eq(out[0]?.power_W, undefined, `${tag}: no power claimed for a subtype that does not carry one`);
  }

  /*
   * The premise behind narrowing both sums. The socket's really does overflow a byte, so the mask is doing
   * work rather than being incidental; the transmitter's adds a constant afterwards, and taking the sum
   * modulo 256 before or after that addition gives the same answer -- which is why the shared helper is safe
   * here even though it narrows earlier than upstream does.
   */
  {
    const msg = Uint8Array.from([0x52, 0x31, 0x5c, 0x6a, 0x77, 0x00, 0x56, 0x5a, 0x7f, 0x00, 0x53]);
    let full = 0;
    for (let i = 0; i < 11; i++) full += msg[i];
    ok(full > 0xff, 'the socket checksum sum overflows a byte (premise)', `sum ${full}`);
    eq(full & 0xff, 0x42, 'and narrowing it gives the byte the frame carries');

    const tx = Uint8Array.from([0x8c, 0x74, 0xd4, 0xb9, 0x3e, 0xb3, 0x22, 0x38, 0x44]);
    let t = 0;
    for (let i = 0; i < 9; i++) t += tx[i];
    ok(t > 0xff, 'the transmitter sum also overflows (premise)', `sum ${t}`);
    eq(((t & 0xff) + 0x35) & 0xff, (t + 0x35) & 0xff, 'narrowing before or after adding 0x35 is the same');
    eq((t + 0x35) & 0xff, 0x51, 'and matches the byte the frame carries');
  }

  // Rejections.
  eq(run(d, rowOf(fromHex('aaaaaa 2dd4 8c74 d4b9 3eb3 223844 52 550000', 144))).length, 0,
    'EcoDHOME rejects a bad transmitter checksum');
  eq(run(d, rowOf(fromHex('aaaaaa 2dd4 8c74 d4b9 3eb3 223844 51 560000', 144))).length, 0,
    'EcoDHOME rejects a wrong stop byte');
  eq(run(d, rowOf(fromHex('aaaaaa 2dd4 8c74', 64))).length, 0, 'EcoDHOME refuses a burst too short to hold a frame');
}

// ---- GEO minim+ (224): built from the transmit side ----
{
  const d = dev(224);
  /** preamble + sync, then header (id, length), payload, and a CRC-16 over everything before it. */
  const minim = (idBytes, payload, { sync = [0xaa, 0xaa, 0x7b, 0xb9], breakCrc = false } = {}) => {
    const body = new Uint8Array(4 + payload.length + 2);
    body[0] = idBytes[0]; body[1] = idBytes[1]; body[2] = idBytes[2];
    body[3] = payload.length;
    body.set(payload, 4);
    const crcLen = 4 + payload.length;
    const crc = crc16Ref(body, crcLen, 0x8005, 0) ^ (breakCrc ? 0xffff : 0);
    body[crcLen] = (crc >> 8) & 0xff;
    body[crcLen + 1] = crc & 0xff;
    return rowOf([...bytesToBits(sync), ...bytesToBits(body)]);
  };

  // The current clamp: five payload bytes.
  {
    const p = new Uint8Array([0x31, 0x2c, 0x00, 0x01, 0x00]);   // flags/VA high, VA low, uptime x3
    const out = run(d, minim([0x3f, 0x06, 0x29], p));
    eq(out.length, 1, 'GEO minim+ decodes a clamp packet');
    eq(out[0]?.model, 'GEO-minimCT', 'reported as the clamp');
    eq(out[0]?.id, '3F0629', 'GEO clamp id is the three header bytes in hex');
    eq(out[0]?.power_VA, 3000, 'GEO clamp apparent power');
    eq(out[0]?.uptime_s, 2048, 'GEO clamp uptime counts eight-second intervals');
    eq(out[0]?.flags4, undefined, 'the resting flag value is not reported');
  }
  // The spare bit worth five VA, and a flag value worth reporting.
  {
    const out = run(d, minim([0x3f, 0x06, 0x29], new Uint8Array([0x71, 0x2c, 0x00, 0x00, 0x01])));
    eq(out[0]?.power_VA, 3005, 'GEO clamp adds five VA for the spare bit');
    eq(out[0]?.uptime_s, 8, 'GEO clamp uptime of one interval');
  }
  {
    const out = run(d, minim([0x01, 0x02, 0x03], new Uint8Array([0x81, 0x00, 0x00, 0x00, 0x00])));
    eq(out[0]?.flags4, 0x80, 'an unexpected flag value is reported');
  }

  // The display: forty-two payload bytes, including its own clock.
  {
    const p = new Uint8Array(42);
    p[0] = 60; p[1] = 0;                     // buf[4],buf[5] -> 300 W
    p[10] = 8; p[11] = 0x40;                 // buf[14],buf[15] -> 8 Wh, resting flags
    p[26] = 31; p[27] = 0;                   // buf[30],buf[31] -> 31 days after 1 Jan 2007
    p[28] = 14; p[29] = 30;                  // buf[32],buf[33] -> 14:30
    const out = run(d, minim([0xea, 0x01, 0x35], p));
    eq(out.length, 1, 'GEO minim+ decodes a display packet');
    eq(out[0]?.model, 'GEO-minimDP', 'reported as the display');
    eq(out[0]?.power_W, 300, 'GEO display real power');
    eq(out[0]?.energy_kWh, 0.008, 'GEO display energy over the last quarter hour');
    // Day zero is 1 January 2007, so day 31 is the first of February -- January having 31 days.
    eq(out[0]?.clock, '2007-02-01 14:30', 'GEO display clock, rolled into a real date');
    eq(out[0]?.flags15, undefined, 'the resting flag value is not reported');
  }
  // A whole year, which 2007 not being a leap year makes exactly 365 days.
  {
    const p = new Uint8Array(42);
    p[26] = 365 & 0xff; p[27] = 365 >> 8;
    p[28] = 0; p[29] = 0;
    eq(run(d, minim([0xea, 0x01, 0x35], p))[0]?.clock, '2008-01-01 00:00',
      'GEO display clock rolls a full year correctly');
  }

  // Rejections.
  eq(run(d, minim([0x3f, 0x06, 0x29], new Uint8Array([0x31, 0x2c, 0x00, 0x01, 0x00]), { breakCrc: true })).length, 0,
    'GEO minim+ rejects a bad CRC');
  eq(run(d, minim([0x3f, 0x06, 0x29], new Uint8Array(7))).length, 0,
    'GEO minim+ rejects an unrecognized payload length');
  // The alternate run-in polarity is accepted.
  {
    const out = run(d, minim([0x3f, 0x06, 0x29], new Uint8Array([0x31, 0x2c, 0x00, 0x01, 0x00]),
      { sync: [0x55, 0x55, 0x7b, 0xb9] }));
    eq(out.length, 1, 'GEO minim+ accepts the other run-in polarity');
    eq(out[0]?.power_VA, 3000, 'and reads the same values from it');
  }
}

// ---- BM5-v2 (285): built from the transmit side, and sent inverted ----
{
  const d = dev(285);
  const build = ({ id = 0xabcdef, soh = 95, soc = 80, temp = 23, negTemp = false,
                   volt = 20160, start = 15360, charging = 0, cranking = 0, breakSum = false, bits = 88 } = {}) => {
    const b = new Uint8Array(11);
    b[0] = (id >> 16) & 0xff; b[1] = (id >> 8) & 0xff; b[2] = id & 0xff;
    b[3] = ((soh & 0x7f) << 1) | charging;
    b[4] = ((soc & 0x7f) << 1) | cranking;
    b[5] = ((temp & 0x7f) << 1) | (negTemp ? 1 : 0);
    b[6] = volt & 0xff; b[7] = (volt >> 8) & 0xff;
    b[8] = start & 0xff; b[9] = (start >> 8) & 0xff;
    let s = 0;
    for (let i = 0; i < 10; i++) s += b[i];
    b[10] = (s & 0xff) ^ (breakSum ? 0xff : 0);
    return rowOf(inv(bytesToBits(b)).slice(0, bits));   // the sensor sends the inverse
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'BM5 decodes a well-formed frame');
  eq(out[0]?.id, 0xabcdef, 'BM5 id');
  eq(out[0]?.health_pct, 95, 'BM5 state of health');
  eq(out[0]?.charge_pct, 80, 'BM5 state of charge');
  eq(out[0]?.temperature_C, 23, 'BM5 temperature');
  eq(out[0]?.battery_V, 12.6, 'BM5 battery voltage counts 1/1600 V');
  eq(out[0]?.starting_V, 9.6, 'BM5 starting voltage');
  eq(out[0]?.charging_error, 0, 'BM5 charging flag');
  eq(out[0]?.cranking_error, 0, 'BM5 cranking flag');

  eq(run(d, build({ negTemp: true, temp: 5 }))[0]?.temperature_C, -5, 'BM5 reads a negative temperature');
  eq(run(d, build({ charging: 1, cranking: 1 }))[0]?.charging_error, 1, 'BM5 reports a charging fault');
  eq(run(d, build({ charging: 1, cranking: 1 }))[0]?.cranking_error, 1, 'BM5 reports a cranking fault');

  // Rejections, each with the premise that the frame is otherwise sound.
  eq(run(d, build({ breakSum: true })).length, 0, 'BM5 rejects a bad checksum');
  eq(run(d, build({ bits: 80 })).length, 0, 'BM5 wants exactly 88 bits');
  {
    const zeroVolt = build({ volt: 0 });
    eq(run(d, zeroVolt).length, 0, 'BM5 rejects a frame claiming 0.0 V');
  }
  {
    // 127 is representable in the seven-bit field but cannot be a percentage.
    const wild = build({ soh: 127 });
    eq(run(d, wild).length, 0, 'BM5 rejects a state of health above 100');
    eq(run(d, build({ soc: 120 })).length, 0, 'BM5 rejects a state of charge above 100');
  }
  {
    const overVolt = build({ volt: 40000 });   // 25 V, past anything a 12 V battery does
    eq(run(d, overVolt).length, 0, 'BM5 rejects an implausible voltage');
  }
}

// ---- Elster type-1 (338): frames placed at an odd bit offset ----
{
  const d = dev(338);
  /** Whitened with 0x55, length self-inclusive, CRC-16/X-25 little-endian past the end. */
  const elster1 = (body, len, { offset = 5, whiten = 0x55, breakCrc = false } = {}) => {
    const buf = new Uint8Array(len + 2);
    buf.set(body.subarray(0, len));
    buf[0] = len;
    const crc = x25Ref(buf, len) ^ (breakCrc ? 0xffff : 0);
    buf[len] = crc & 0xff;
    buf[len + 1] = (crc >> 8) & 0xff;
    const wire = Uint8Array.from(buf, (v) => v ^ whiten);
    return rowOf([...new Array(offset).fill(0), ...bytesToBits(wire)]);
  };

  // A beacon: the one frame shape upstream names.
  {
    const body = new Uint8Array(40);
    body[1] = 0x08;                                   // flags
    body[2] = 0x01; body[3] = 0x02; body[4] = 0x03; body[5] = 0x04;   // src
    // dst stays zero, which is what makes it a beacon
    const out = run(d, elster1(body, 40));
    eq(out.length, 1, 'Elster type-1 finds a frame that does not start at bit zero');
    eq(out[0]?.id, '16909060', 'Elster meter id is reported as a decimal string');
    eq(out[0]?.dst, '0', 'Elster beacon has no collector');
    eq(out[0]?.flags, 0x08, 'Elster beacon flags');
    eq(out[0]?.frame_type, 'beacon', 'Elster recognizes the beacon shape');
    eq(out[0]?.mic, 'CRC', 'Elster reports a CRC');
  }

  // A plain report is not a beacon, even at the same length.
  {
    const body = new Uint8Array(40);
    body[1] = 0x00;
    body[2] = 0x01; body[3] = 0x02; body[4] = 0x03; body[5] = 0x04;
    body[9] = 0x07;                                   // nonzero dst
    const out = run(d, elster1(body, 40));
    eq(out[0]?.frame_type, undefined, 'a frame with a collector is not called a beacon');
    eq(out[0]?.dst, '7', 'Elster collector id');
  }

  // The hourly-usage sub-command.
  {
    const len = 80;
    const body = new Uint8Array(len);
    body[2] = 0x01; body[3] = 0x02; body[4] = 0x03; body[5] = 0x04;
    body[16] = 0x33;                                  // the sub-command length that gates this path
    body[18] = 0xce;                                  // cmd[1]: the command id
    body[19] = 42;                                    // cmd[2]: counter
    body[22] = 0x01; body[23] = 0x10;                 // cmd[5],cmd[6]: current hour
    body[24] = 0x01; body[25] = 0x00;                 // cmd[7],cmd[8]: last hour
    body[26] = 3;                                     // cmd[9]: three readings follow
    body[27] = 0; body[28] = 100;                     // 1.00
    body[29] = 0; body[30] = 200;                     // 2.00
    body[31] = 0; body[32] = 244;                     // 2.44
    const out = run(d, elster1(body, len));
    eq(out.length, 1, 'Elster type-1 decodes a report carrying hourly usage');
    eq(out[0]?.ctr, 42, 'Elster sub-command counter');
    eq(out[0]?.cur_hour, 0x0110, 'Elster current hour');
    eq(out[0]?.last_hour, 0x0100, 'Elster last hour');
    eq(out[0]?.hourly_kWh, '1.00,2.00,2.44', 'Elster hourly readings, scaled by a hundredth');
  }

  // Mesh traffic carries no usage sub-command, and is not searched for one.
  {
    const len = 80;
    const body = new Uint8Array(len);
    body[2] = 0x81;                                   // top bit set: a mesh-routing frame
    body[16] = 0x33;
    body[18] = 0xce;
    body[26] = 3;
    const out = run(d, elster1(body, len));
    eq(out.length, 1, 'Elster type-1 still reports a mesh frame');
    eq(out[0]?.hourly_kWh, undefined, 'but does not read a usage sub-command out of one');
  }

  eq(run(d, elster1(new Uint8Array(40), 40, { breakCrc: true })).length, 0,
    'Elster type-1 rejects a frame whose CRC does not land');
  eq(run(d, rowOf(new Array(400).fill(0))).length, 0, 'Elster type-1 finds nothing in an empty burst');
}

// ---- Elster type-2 (373): a different whitening, a wider length ----
{
  const d = dev(373);
  const elster2 = (body, len, { offset = 3, breakCrc = false } = {}) => {
    const buf = new Uint8Array(len + 2);
    buf.set(body.subarray(0, len));
    buf[0] = (len >> 8) & 0xff;
    buf[1] = len & 0xff;
    const crc = x25Ref(buf, len) ^ (breakCrc ? 0xffff : 0);
    buf[len] = crc & 0xff;
    buf[len + 1] = (crc >> 8) & 0xff;
    const wire = Uint8Array.from(buf, (v) => v ^ 0xaa);
    return rowOf([...new Array(offset).fill(0), ...bytesToBits(wire)]);
  };

  // A neighbor table: a record count, then that many twenty-byte records.
  for (const [msgClass, recStart] of [[0x57, 30], [0x7f, 29]]) {
    const len = recStart + 2 * 20;
    const body = new Uint8Array(len);
    body[3] = 0x01; body[4] = 0x02; body[5] = 0x03; body[6] = 0x04;   // src
    body[7] = 0x00; body[8] = 0x00; body[9] = 0x00; body[10] = 0x09;  // dst
    body[16] = msgClass;
    body[28] = 2;                                                     // two records
    body[recStart] = 0xaa; body[recStart + 1] = 0xbb; body[recStart + 2] = 0xcc; body[recStart + 3] = 0xdd;
    body[recStart + 20] = 0x11; body[recStart + 21] = 0x22; body[recStart + 22] = 0x33; body[recStart + 23] = 0x44;
    const out = run(d, elster2(body, len));
    eq(out.length, 1, `Elster type-2 decodes a 0x${msgClass.toString(16)} neighbor table`);
    eq(out[0]?.id, '16909060', `type-2 0x${msgClass.toString(16)}: meter id`);
    eq(out[0]?.dst, '9', `type-2 0x${msgClass.toString(16)}: collector id`);
    eq(out[0]?.msg, msgClass.toString(16), `type-2 0x${msgClass.toString(16)}: message class`);
    eq(out[0]?.mesh, 0, `type-2 0x${msgClass.toString(16)}: not a mesh frame`);
    eq(out[0]?.nbr_ids, 'aabbccdd,11223344', `type-2 0x${msgClass.toString(16)}: neighbor addresses`);
  }

  // The two classes really do start their records a byte apart -- reading one with the other's offset
  // would give different addresses, which is why they are treated as separate layouts.
  {
    const len = 70;
    const body = new Uint8Array(len);
    body[3] = 0x01; body[16] = 0x57; body[28] = 1;
    body[29] = 0x99; body[30] = 0xaa; body[31] = 0xbb; body[32] = 0xcc; body[33] = 0xdd;
    const out = run(d, elster2(body, len));
    eq(out[0]?.nbr_ids, 'aabbccdd', '0x57 reads its records from byte 30, not 29 (premise)');
  }

  // A mesh frame: the message class byte does not mean the same thing, so it is not read.
  {
    const len = 40;
    const body = new Uint8Array(len);
    body[3] = 0x81;                                   // top bit set
    body[16] = 0x57;
    const out = run(d, elster2(body, len));
    eq(out.length, 1, 'Elster type-2 reports a mesh frame');
    eq(out[0]?.mesh, 1, 'and marks it as mesh');
    eq(out[0]?.msg, undefined, 'without reading a message class from it');
    eq(out[0]?.nbr_ids, undefined, 'and without inventing a neighbor table');
  }

  // An encrypted body is reported as raw hex rather than guessed at.
  {
    const len = 40;
    const body = new Uint8Array(len);
    body[3] = 0x01; body[16] = 0x56;                  // 0x56 marks an AES-encrypted body
    const out = run(d, elster2(body, len));
    eq(out[0]?.msg, '56', 'Elster type-2 names the encrypted message class');
    eq(out[0]?.nbr_ids, undefined, 'and reads no neighbor table out of ciphertext');
    ok(typeof out[0]?.data_raw === 'string' && out[0].data_raw.length === (len - 12) * 2,
      'the whole undecoded body goes out as hex');
  }

  eq(run(d, elster2(new Uint8Array(40), 40, { breakCrc: true })).length, 0,
    'Elster type-2 rejects a frame whose CRC does not land');

  // The two whitenings are genuinely different: a type-1 frame must not read as type-2.
  {
    const body = new Uint8Array(40);
    body[1] = 0x08; body[2] = 0x01;
    eq(run(d, (() => {
      const buf = new Uint8Array(42);
      buf.set(body.subarray(0, 40)); buf[0] = 40;
      const crc = x25Ref(buf, 40);
      buf[40] = crc & 0xff; buf[41] = (crc >> 8) & 0xff;
      return rowOf([...new Array(5).fill(0), ...bytesToBits(Uint8Array.from(buf, v => v ^ 0x55))]);
    })()).length, 0, 'a type-1 frame does not decode as type-2');
  }
}

// ---- The registrations themselves ----
{
  for (const num of [174, 224, 285, 338, 373]) {
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
