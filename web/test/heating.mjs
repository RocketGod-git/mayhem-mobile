/**
 * Heating, pool and utility devices.
 *
 * Two of these ship real captures and both are used: the Danfoss thermostat's single recorded transmission,
 * and all five of the Mueller water meter's — including the one whose sync word the demodulator ate, which
 * upstream cannot decode either and which is kept here as a rejection case rather than quietly dropped.
 *
 * Everything else is built from the transmit side: the bytes the device sends are laid out, its line coding is
 * applied forwards, and its checksums are computed by implementations written from the definition rather than
 * imported from the code under test.
 *
 * Where a decoder searches for its frame, the frame is deliberately not placed at bit zero, because a builder
 * that lands the payload anywhere other than exactly where the search ends is the single most repeated way to
 * get a false failure out of a correct port.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };
/** The decoder's return code, so "verified then deliberately dropped" can be told from "rejected". */
const ret = (d, bb) => d.decode(d, bb, { emit: () => {} });

const DECODE_ABORT_LENGTH = -1, DECODE_ABORT_EARLY = -2, DECODE_FAIL_MIC = -3, DECODE_FAIL_SANITY = -4;

// ---- reference implementations, written from the definitions rather than imported ----
const crc16Ref = (m, n, poly, init, at = 0) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[at + i] << 8;
    for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff;
  }
  return r & 0xffff;
};
const crc16lsbRef = (m, n, poly, init, at = 0) => {
  let r = init;
  for (let i = 0; i < n; i++) {
    r ^= m[at + i];
    for (let k = 0; k < 8; k++) r = (r & 1) ? ((r >> 1) ^ poly) & 0xffff : (r >> 1);
  }
  return r & 0xffff;
};
const crc8Ref = (m, n, poly, init, at = 0) => {
  let r = init & 0xff;
  for (let i = 0; i < n; i++) {
    r ^= m[at + i];
    for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff;
  }
  return r;
};
const reverse8Ref = (x) => { let r = 0; for (let i = 0; i < 8; i++) if ((x >> i) & 1) r |= 1 << (7 - i); return r; };
const parity8Ref = (x) => { let p = 0; for (let i = 0; i < 8; i++) p ^= (x >> i) & 1; return p; };

// ---- bit plumbing ----
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
const rowsOf = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
const inv = (bits) => bits.map(b => b ^ 1);
/** A snapshot of every row's bytes, for asserting a decoder left the shared buffer alone. */
const snapshot = (bb) => bb.bb.slice(0, Math.max(bb.numRows, 1)).map(r => Array.from(r.subarray(0, 64)).join(','));

console.log('Heating, pool and utility devices');

// ===========================================================================
// Danfoss CFR thermostat (26)
// ===========================================================================
{
  const d = dev(26);

  // The 4b/6b table, inverted so frames can be built the way the thermostat sends them.
  const TO6B = new Map([
    [0xd, 0x0b], [0xe, 0x0d], [0x3, 0x0e], [0x4, 0x13],
    [0xa, 0x15], [0xf, 0x16], [0x9, 0x19], [0x6, 0x1a],
    [0x0, 0x25], [0x7, 0x26], [0x1, 0x29], [0x5, 0x2a],
    [0xc, 0x2c], [0xb, 0x31], [0x2, 0x32], [0x8, 0x34],
  ]);
  const enc6 = (nib) => { const v = TO6B.get(nib); const out = []; for (let i = 5; i >= 0; i--) out.push((v >> i) & 1); return out; };

  /**
   * Lay out the twenty-one nibbles the thermostat sends: the prefix, then ten bytes' worth of payload whose
   * last two bytes are a CRC-16 over the eight before them.
   */
  const danfoss = ({ id = 4382, count = 12, sw = 4, tempInt = 22, tempFrac = 102, setInt = 20, setFrac = 124,
                     preamble = 16, breakCrc = false, prefixNibble = 2, corruptSymbol = -1 } = {}) => {
    const bytes = new Uint8Array(10);
    bytes[0] = prefixNibble;                                  // decoded nibbles #1-#2
    bytes[1] = (id >> 8) & 0xff;
    bytes[2] = id & 0xff;
    bytes[3] = ((count & 0x0f) << 4) | (sw & 0x0f);
    bytes[4] = tempFrac; bytes[5] = tempInt;
    bytes[6] = setFrac;  bytes[7] = setInt;
    const crc = crc16Ref(bytes, 8, 0x1021, 0x0000) ^ (breakCrc ? 0xffff : 0);
    bytes[8] = (crc >> 8) & 0xff;
    bytes[9] = crc & 0xff;

    const nibbles = [0xe];                                    // the prefix nibble the decoder skips
    for (const b of bytes) { nibbles.push(b >> 4); nibbles.push(b & 0x0f); }

    const bits = [];
    for (let i = 0; i < preamble; i++) bits.push(...bytesToBits([0xaa]));
    for (const n of nibbles) bits.push(...enc6(n));
    if (corruptSymbol >= 0) {
      const at = preamble * 8 + corruptSymbol;
      bits[at] ^= 1;
    }
    return { bb: rowOf(bits), bytes, bits };
  };

  // ---- the one real capture upstream ships ----
  {
    const cap = '2a aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa 36 5c a9 a6 93 6c 4d a6 a9 6a 6b 29 4f 19 72 b2';
    const out = run(d, rowOf(fromHex(cap, 255)));
    eq(out.length, 1, 'Danfoss decodes its published capture');
    eq(out[0]?.model, 'Danfoss-CFR', 'Danfoss model');
    eq(out[0]?.id, 4382, 'Danfoss id from the capture');
    eq(out[0]?.switch, 'TIMER', 'Danfoss switch position from the capture');
    eq(out[0]?.temperature_C, 22.4, 'Danfoss measured temperature from the capture');
    eq(out[0]?.setpoint_C, 20.48, 'Danfoss setpoint from the capture');
    eq(out[0]?.mic, 'CRC', 'Danfoss reports a CRC');

    /*
     * The doc comment states the decoded nibbles as "E02 111E C4 6616 7C14 B02C". Those fall straight out of
     * the capture, so unlike several other files in this project the comment and the code agree exactly.
     */
    const built = danfoss({ id: 0x111e, count: 0xc, sw: 4, tempFrac: 0x66, tempInt: 0x16, setFrac: 0x7c, setInt: 0x14 });
    eq([...built.bytes].map(x => x.toString(16).padStart(2, '0')).join(''), '021 11ec46616 7c14b02c'.replace(/ /g, ''),
      'the documented nibble row rebuilds byte for byte, CRC included');
  }

  // ---- built from the transmit side ----
  {
    const out = run(d, danfoss({ id: 0x2222, sw: 2, tempInt: 21, tempFrac: 128, setInt: 19, setFrac: 64 }).bb);
    eq(out.length, 1, 'Danfoss decodes a frame built from the transmit side');
    eq(out[0]?.id, 0x2222, 'Danfoss id');
    eq(out[0]?.switch, 'DAY', 'Danfoss day setting');
    eq(out[0]?.temperature_C, 21.5, 'Danfoss temperature counts the fraction in 256ths');
    eq(out[0]?.setpoint_C, 19.25, 'Danfoss setpoint counts the fraction in 256ths');
  }
  eq(run(d, danfoss({ sw: 8 }).bb)[0]?.switch, 'NIGHT', 'Danfoss night setting');
  eq(run(d, danfoss({ sw: 1 }).bb)[0]?.switch, 'ERROR', 'an unrecognized switch code is named an error, not guessed');

  // ---- rejections ----
  eq(run(d, danfoss({ breakCrc: true }).bb).length, 0, 'Danfoss rejects a bad CRC');
  {
    // The prefix check is separate from the header search. Nibble #2 can be changed to 0xB and still encode to
    // bits the sixteen-bit header search accepts, so this reaches the prefix test with an otherwise valid frame.
    const bad = danfoss({ prefixNibble: 0x0b });
    const good = danfoss({});
    ok(bad.bits.slice(128, 144).join('') === good.bits.slice(128, 144).join(''),
      'the altered prefix still matches the sixteen-bit header (premise)');
    ok(bad.bytes[0] !== 0x02, 'but its first decoded byte is no longer 0x02 (premise)');
    eq(crc16Ref(bad.bytes, 8, 0x1021, 0), (bad.bytes[8] << 8) | bad.bytes[9], 'and its CRC is valid (premise)');
    eq(run(d, bad.bb).length, 0, 'Danfoss rejects a frame whose prefix byte is wrong even when its CRC is good');
  }
  {
    // Corrupt a bit inside a payload symbol: almost every single-bit error leaves a code not in the table.
    const good = danfoss({});
    const bad = danfoss({ corruptSymbol: 40 });
    ok(good.bits.join('') !== bad.bits.join(''), 'the corrupted frame really differs (premise)');
    eq(run(d, bad.bb).length, 0, 'Danfoss rejects a symbol outside the 4b/6b table');
    eq(ret(d, danfoss({ corruptSymbol: 40 }).bb), DECODE_FAIL_SANITY, 'and calls it a decoding error, not a bad checksum');
  }
  eq(run(d, danfoss({ preamble: 10 }).bb).length, 0, 'Danfoss refuses a burst too short to be one of its own');
  eq(run(d, danfoss({ preamble: 24 }).bb).length, 0, 'Danfoss refuses a burst too long to be one of its own');
}

// ===========================================================================
// emonTx OpenEnergyMonitor (45)
// ===========================================================================
{
  const d = dev(45);

  /** Three preamble bytes, then the thirty-three byte RF12 packet. */
  const emonPkt = ({ node = 5, ct = [100, -200, 300, 400], vrms = 24000,
                     temps = [250, 3000, 3000, 3000, 3000, 3000], pulse = 0x00012345,
                     len = 0x1a, postamble = 0xaa, breakCrc = false } = {}) => {
    const pkt = new Uint8Array(33);
    pkt[0] = 0x2d; pkt[1] = 0xd2; pkt[2] = node; pkt[3] = len;
    const words = [...ct.map(v => v & 0xffff), vrms, ...temps, pulse & 0xffff, (pulse >>> 16) & 0xffff];
    words.forEach((w, i) => { pkt[4 + i * 2] = w & 0xff; pkt[5 + i * 2] = (w >> 8) & 0xff; });
    const crc = crc16lsbRef(pkt, 0x1d, 0xa001, 0xffff, 1) ^ (breakCrc ? 0xffff : 0);
    pkt[30] = crc & 0xff; pkt[31] = (crc >> 8) & 0xff;
    pkt[32] = postamble;
    return pkt;
  };
  const emonRow = (opts = {}, { inverted = false, copies = 1 } = {}) => {
    const bits = [];
    for (let i = 0; i < copies; i++) bits.push(...bytesToBits([0xaa, 0xaa, 0xaa, ...emonPkt(opts)]));
    return rowOf(inverted ? inv(bits) : bits);
  };

  {
    const out = run(d, emonRow());
    eq(out.length, 1, 'emonTx decodes a well-formed packet');
    eq(out[0]?.model, 'emonTx-Energy', 'emonTx model');
    eq(out[0]?.node, 5, 'emonTx node id');
    eq(out[0]?.ct1, 100, 'emonTx first current transformer');
    eq(out[0]?.ct2, -200, 'emonTx second reads as a signed value');
    eq(out[0]?.ct3, 300, 'emonTx third');
    eq(out[0]?.ct4, 400, 'emonTx fourth');
    eq(out[0]?.batt_Vrms, 240, 'emonTx mains voltage counts hundredths');
    eq(out[0]?.pulse, 0x00012345, 'emonTx pulse counter spans two words');
    eq(out[0]?.temp1_C, 25, 'emonTx reports a connected probe');
    eq(out[0]?.temp2_C, undefined, 'a probe reporting exactly 300.0 C is absent, not a reading');
    eq(out[0]?.temp6_C, undefined, 'and so are the rest');
    eq(out[0]?.mic, 'CRC', 'emonTx reports a CRC');
  }

  // The node field is five bits wide inside a byte that carries other things.
  eq(run(d, emonRow({ node: 0xe5 }))[0]?.node, 5, 'emonTx masks the node id to five bits');

  /*
   * An inverted burst. The run-in alternates, so a twenty-two bit search for 0xaaaaaa still matches an inverted
   * preamble one bit further along -- which is exactly why upstream searches for less than a full preamble and
   * then steps back a bit. The packet header is then found through the inverted pattern.
   */
  {
    const out = run(d, emonRow({}, { inverted: true }));
    eq(out.length, 1, 'emonTx decodes an inverted burst');
    eq(out[0]?.node, 5, 'and reads the same node from it');
    eq(out[0]?.ct1, 100, 'and the same current');
  }

  // Two packets in one burst: this decoder keeps looking after a success.
  eq(run(d, emonRow({}, { copies: 2 })).length, 2, 'emonTx reports both packets in a burst that carries two');

  // ---- rejections ----
  eq(run(d, emonRow({ breakCrc: true })).length, 0, 'emonTx rejects a bad CRC');
  eq(run(d, emonRow({ len: 0x1b })).length, 0, 'emonTx rejects a packet whose length byte is not 0x1a');
  eq(run(d, emonRow({ postamble: 0x00 })).length, 0, 'emonTx rejects a packet with no postamble');
  eq(run(d, rowOf(bytesToBits([0xaa, 0xaa, 0xaa, 0x2d, 0xd2, 0x00]))).length, 0,
    'emonTx refuses a burst too short to hold a packet');
  eq(run(d, rowOf(new Array(400).fill(0))).length, 0, 'emonTx finds nothing in a silent burst');
}

// ===========================================================================
// Vaillant calorMatic VRT340f (77)
// ===========================================================================
{
  const d = dev(77);

  /**
   * Build a frame the way the control sends it: least significant bit first within each byte, then a zero
   * stuffed in after every five consecutive ones.
   */
  const stuff = (bits) => {
    const out = [];
    let ones = 0;
    for (const b of bits) {
      out.push(b);
      if (b === 1) {
        ones++;
        if (ones === 5) { out.push(0); ones = 0; }   // the inserted bit the receiver must drop
      } else ones = 0;
    }
    return out;
  };
  /** `bytes` are what the decoder should see after it has put the bit order back. */
  const vaillantRow = (bytes) => {
    const wire = bytes.map((v, i) => (i < bytes.length - 1 ? reverse8Ref(v) : v));
    return rowOf(stuff(bytesToBits(wire)));
  };
  /** Two's complement across sixteen bits of a full-width sum. */
  const vaillantSum = (b, from, to) => { let s = 0; for (let i = from; i <= to; i++) s += b[i]; return s; };
  const normalFrame = ({ id = 0x6df6, water = 0x80, heat = 0xb4, battery = 0x00, sync = [0x00, 0x00, 0x7e],
                         breakSum = false } = {}) => {
    const b = new Array(16).fill(0);
    b[0] = sync[0]; b[1] = sync[1]; b[2] = sync[2];
    b[3] = (id >> 8) & 0xff; b[4] = id & 0xff;
    b[5] = 0x00; b[6] = 0x20; b[7] = 0x00;           // constant in every observed frame
    b[8] = 0x00;                                     // repeat indicator
    b[9] = water; b[10] = heat; b[11] = battery;
    const chk = (-vaillantSum(b, 3, 11) & 0xffff) ^ (breakSum ? 0xffff : 0);
    b[12] = (chk >> 8) & 0xff; b[13] = chk & 0xff;
    b[14] = 0xff; b[15] = 0x00;                      // epilogue
    return b;
  };

  // ---- the frame upstream documents, byte for byte ----
  {
    const b = normalFrame();
    eq(b.slice(0, 16).map(v => v.toString(16).padStart(2, '0')).join(''), '00007e6df6002000008 0b400fd49ff00'.replace(/ /g, ''),
      "the documented frame's checksum falls straight out of the rule the file states");

    /*
     * The trap this batch was warned about, made explicit. The sum of bytes 3 to 11 is 695, which does not fit
     * in a byte. Narrowing it first -- which is what the shared addBytes helper does -- gives 0xb7, and 0xb7
     * plus the carried 0xfd49 is not zero. Only the full-width sum closes the ring.
     */
    const full = vaillantSum(b, 3, 11);
    ok(full > 0xff, 'the Vaillant checksum sum really does overflow a byte (premise)', `sum ${full}`);
    eq((full + ((b[12] << 8) | b[13])) & 0xffff, 0, 'the full-width sum and the carried value add to zero');
    ok((((full & 0xff) + ((b[12] << 8) | b[13])) & 0xffff) !== 0,
      'and a byte-narrowed sum would not (premise for taking it locally)');

    const out = run(d, vaillantRow(b));
    eq(out.length, 1, 'Vaillant decodes the documented frame');
    eq(out[0]?.model, 'Vaillant-VRT340f', 'Vaillant model');
    eq(out[0]?.id, 0x6df6, 'Vaillant device id');
    eq(out[0]?.heating, 'ON (2-point)', 'Vaillant two-point heating mode');
    eq(out[0]?.heating_temp, 52, 'Vaillant heating water temperature');
    eq(out[0]?.water, 'ON', 'Vaillant pre-heated water is on when the bit is clear');
    eq(out[0]?.battery_ok, 1, 'Vaillant battery is good');
  }

  // The stuffing has to be doing something, or the test proves nothing about it.
  {
    const b = normalFrame();
    const wire = b.map((v, i) => (i < 15 ? reverse8Ref(v) : v));
    const plain = bytesToBits(wire);
    ok(stuff(plain).length > plain.length, 'the frame really needs stuffing bits (premise)',
      `${plain.length} -> ${stuff(plain).length}`);
  }

  eq(run(d, vaillantRow(normalFrame({ heat: 0x00 })))[0]?.heating, 'OFF', 'Vaillant heating off');
  eq(run(d, vaillantRow(normalFrame({ heat: 0x2d })))[0]?.heating, 'ON (analogue)', 'Vaillant analogue heating mode');
  eq(run(d, vaillantRow(normalFrame({ heat: 0x2d })))[0]?.heating_temp, 45, 'Vaillant analog target temperature');
  eq(run(d, vaillantRow(normalFrame({ water: 0x88 })))[0]?.water, 'off', 'Vaillant pre-heated water off');
  eq(run(d, vaillantRow(normalFrame({ battery: 0x01 })))[0]?.battery_ok, 0, 'Vaillant low battery');

  /*
   * Bit seven alone chooses two-point control. Every value used above happens to read the same way whether the
   * mode is taken from bit seven or from bit six, so none of them can tell those apart -- 0x40 can, because it
   * has bit six set and bit seven clear and is therefore still an analog target.
   */
  eq(run(d, vaillantRow(normalFrame({ heat: 0x40 })))[0]?.heating, 'ON (analogue)',
    'Vaillant takes the heating mode from bit seven alone, not from bit six');
  eq(run(d, vaillantRow(normalFrame({ heat: 0x40 })))[0]?.heating_temp, 64,
    'and reads the rest of the byte as the target temperature');
  eq(run(d, vaillantRow(normalFrame({ heat: 0x80 })))[0]?.heating, 'ON (2-point)',
    'Vaillant two-point control with a zero target is still on, not off');
  eq(run(d, vaillantRow(normalFrame({ heat: 0x80 })))[0]?.heating_temp, 0, 'and reports that zero target');

  // ---- the longer pairing frame ----
  {
    const b = new Array(21).fill(0);
    b[0] = 0x00; b[1] = 0x00; b[2] = 0x7e;
    b[11] = 0x12; b[12] = 0x34;
    let s = 0; for (let i = 3; i <= 16; i++) s += b[i];
    const chk = -s & 0xffff;
    b[17] = (chk >> 8) & 0xff; b[18] = chk & 0xff;
    const out = run(d, vaillantRow(b));
    eq(out.length, 1, 'Vaillant decodes the longer pairing frame');
    eq(out[0]?.id, 0x1234, 'and reads its device id from a different offset');
    eq(out[0]?.heating, undefined, 'without claiming a heating mode it does not carry');
  }

  // ---- rejections ----
  eq(run(d, vaillantRow(normalFrame({ breakSum: true }))).length, 0, 'Vaillant rejects a bad checksum');
  eq(ret(d, vaillantRow(normalFrame({ sync: [0x00, 0x00, 0x7f] }))), DECODE_FAIL_SANITY,
    'Vaillant rejects a frame with the wrong sync bytes');
  eq(run(d, rowOf(new Array(100).fill(1))).length, 0, 'Vaillant refuses a burst shorter than a frame');
  {
    // A frame of a length that is neither of the two it knows.
    const b = new Array(18).fill(0);
    b[0] = 0x00; b[1] = 0x00; b[2] = 0x7e;
    eq(ret(d, vaillantRow(b)), DECODE_ABORT_LENGTH, 'Vaillant refuses a frame of an unrecognized length');
  }

  // The shared buffer is only ever read: the de-stuffing goes into a buffer of the decoder's own.
  {
    const bb = vaillantRow(normalFrame());
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb).join('|'), before.join('|'), 'Vaillant leaves the shared bit buffer untouched');
  }
}

// ===========================================================================
// Clipsal CMR113 cent-a-meter (193)
// ===========================================================================
{
  const d = dev(193);

  /**
   * Turn the real bitstream back into what the demodulator would have handed over: `00` holds the current
   * output bit, `011` flips it, and one leading bit sits outside both patterns.
   */
  const encodeCmr = (outBits) => {
    const raw = [1];
    let cur = 0;
    for (const b of outBits) {
      if (b === cur) raw.push(0, 0);
      else { cur = 1 - cur; raw.push(0, 1, 1); }
    }
    return raw;
  };
  /** The eighty-three bit payload: eleven forced ones, three ten-bit currents, and filler. */
  const cmrPayload = (currents) => {
    const p = new Array(83).fill(0);
    for (let i = 0; i < 11; i++) p[i] = 1;
    currents.forEach((v, i) => { for (let k = 0; k < 10; k++) p[36 + i * 10 + k] = (v >> k) & 1; });
    for (let i = 66; i < 83; i++) p[i] = (i - 66) % 2;      // filler that keeps the burst a realistic length
    return p;
  };
  const cmrRow = (currents, { corruptSecondCopyAt = -1, illegalAt = -1 } = {}) => {
    const p = cmrPayload(currents);
    const second = p.slice();
    if (corruptSecondCopyAt >= 0) second[corruptSecondCopyAt] ^= 1;
    /*
     * Three more bits after the second copy. The decoder's loop needs three bits in hand to read a pattern, so
     * it always leaves the last one unread -- a real burst carries trailing bits and so must this one, or the
     * hundred and sixty-eighth output bit never arrives. They repeat the last bit so they add no transitions.
     */
    const outBits = [...p, 0, 0, ...second, second[82], second[82], second[82]];
    const raw = encodeCmr(outBits);
    if (illegalAt >= 0) raw[illegalAt] ^= 1;
    return { bb: rowOf(raw), raw, p, second };
  };

  {
    const built = cmrRow([123, 456, 789]);
    // The header the decoder demands falls out of the encoding rather than being pasted on.
    const head = built.raw.slice(0, 24).join('');
    eq(head, bytesToBits([0xb0, 0x00, 0x00]).join(''), 'the encoding itself produces the 0xb00000 header (premise)');
    ok(built.raw.length >= 350 && built.raw.length <= 450,
      'the built burst lands inside the length window the decoder accepts (premise)', `${built.raw.length} bits`);

    const out = run(d, built.bb);
    eq(out.length, 1, 'Clipsal decodes a well-formed burst');
    eq(out[0]?.model, 'Clipsal-CMR113', 'Clipsal model');
    eq(out[0]?.current_1_A, 12.3, 'Clipsal first phase, in tenths of an amp');
    eq(out[0]?.current_2_A, 45.6, 'Clipsal second phase');
    eq(out[0]?.current_3_A, 78.9, 'Clipsal third phase');
    eq(out[0]?.mic, undefined, 'Clipsal claims no checksum, because it has none');
  }
  {
    // The tenth bit of each current has to be read, or anything above 25.5 A comes out wrong.
    const out = run(d, cmrRow([1023, 0, 512]).bb);
    eq(out[0]?.current_1_A, 102.3, 'Clipsal reads all ten bits of a current');
    eq(out[0]?.current_2_A, 0, 'Clipsal reads a zero current');
    eq(out[0]?.current_3_A, 51.2, 'Clipsal reads the top bit of a current');
  }

  // ---- rejections ----
  {
    const built = cmrRow([123, 456, 789], { corruptSecondCopyAt: 40 });
    ok(built.p[40] !== built.second[40], 'the two copies really do differ (premise)');
    eq(run(d, built.bb).length, 0, 'Clipsal rejects a burst whose two copies disagree');
    eq(ret(d, cmrRow([123, 456, 789], { corruptSecondCopyAt: 40 }).bb), DECODE_FAIL_MIC,
      'and treats the repeat comparison as its integrity check');
  }
  {
    // Flip a bit early enough to break the header without shortening the burst.
    const built = cmrRow([123, 456, 789]);
    const raw = built.raw.slice();
    raw[0] ^= 1;
    eq(run(d, rowOf(raw)).length, 0, 'Clipsal rejects a burst that does not start with its header');
  }
  eq(run(d, rowOf(new Array(360).fill(0))).length, 0, 'Clipsal finds nothing in a silent burst');
  eq(run(d, rowOf(encodeCmr(new Array(50).fill(0)))).length, 0, 'Clipsal refuses a burst too short to be one of its own');

  // The shared buffer is only read; the rebuilt stream goes into a buffer of the decoder's own.
  {
    const bb = cmrRow([123, 456, 789]).bb;
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb).join('|'), before.join('|'), 'Clipsal leaves the shared bit buffer untouched');
  }
}

// ===========================================================================
// SmartFire Proflame 2 remote (207)
// ===========================================================================
{
  const d = dev(207);

  /**
   * One word: the `1110` sync and guard, then eleven Manchester pairs.
   *
   * The remote uses the opposite Manchester convention from the shared decoder, which works out such that a
   * logical bit L goes on the air as the pair (L, not L).
   */
  const proflameWord = (data, f, { badSync = false, badPad = false, badPar = false, badEnd = false,
                                   badManchester = false } = {}) => {
    const pad = (f === 0 ? 1 : 0) ^ (badPad ? 1 : 0);
    const end = 1 ^ (badEnd ? 1 : 0);
    const par = parity8Ref(data) ^ (f === 0 ? 1 : 0) ^ (badPar ? 1 : 0);
    const logical = [];
    for (let i = 7; i >= 0; i--) logical.push((data >> i) & 1);
    logical.push(pad, par, end);

    const bits = badSync ? [1, 1, 0, 0] : [1, 1, 1, 0];
    logical.forEach((L, i) => {
      if (badManchester && i === 3) bits.push(L, L);          // a pair with no transition stops the decode
      else bits.push(L, L ^ 1);
    });
    return bits;
  };
  const proflameRow = (payload, opts = {}, { words = 7 } = {}) => {
    const bits = [];
    for (let f = 0; f < words; f++) bits.push(...proflameWord(payload[f], f, opts.word === f ? opts : {}));
    return bits;
  };

  const PAY = [0xab, 0xcd, 0xef, 0x93, 0xb5, 0x11, 0x22];

  {
    const bits = proflameRow(PAY);
    eq(bits.length, 182, 'a Proflame frame is 182 bits on the air (premise)');
    const out = run(d, rowOf(bits));
    eq(out.length, 1, 'Proflame decodes a well-formed frame');
    eq(out[0]?.model, 'Proflame2-Remote', 'Proflame model');
    eq(out[0]?.id, 0xabcdef, 'Proflame remote serial');
    eq(out[0]?.cmd1, 0x93, 'Proflame first command byte, reported raw');
    eq(out[0]?.cmd2, 0xb5, 'Proflame second command byte, reported raw');
    eq(out[0]?.err1, 0x11, 'Proflame first error-detection byte');
    eq(out[0]?.err2, 0x22, 'Proflame second error-detection byte');
    // 0x93 is 1001 0011: pilot set, light 1, thermostat set, power set.
    eq(out[0]?.pilot, 1, 'Proflame pilot flag');
    eq(out[0]?.light, 1, 'Proflame light level');
    eq(out[0]?.thermostat, 1, 'Proflame thermostat flag');
    eq(out[0]?.power, 1, 'Proflame power flag');
    // 0xb5 is 1011 0101: front set, fan 3, aux clear, flame 5.
    eq(out[0]?.front, 1, 'Proflame front flag');
    eq(out[0]?.fan, 3, 'Proflame fan level');
    eq(out[0]?.aux, 0, 'Proflame aux flag');
    eq(out[0]?.flame, 5, 'Proflame flame level');
    eq(out[0]?.mic, 'CHECKSUM', 'Proflame reports a checksum');
  }

  // A frame is only accepted whole: every word carries its own guards and parity.
  eq(run(d, rowOf(proflameRow(PAY, { word: 3, badSync: true }))).length, 0, 'Proflame rejects a word with a bad sync');
  eq(run(d, rowOf(proflameRow(PAY, { word: 3, badPar: true }))).length, 0, 'Proflame rejects a word with bad parity');
  eq(run(d, rowOf(proflameRow(PAY, { word: 3, badEnd: true }))).length, 0, 'Proflame rejects a word with no end guard');
  eq(run(d, rowOf(proflameRow(PAY, { word: 3, badManchester: true }))).length, 0,
    'Proflame rejects a word with a Manchester coding violation');
  eq(run(d, rowOf(proflameRow(PAY, { word: 3, badPad: true }))).length, 0,
    'Proflame rejects a later word carrying the first word\'s padding bit');
  eq(run(d, rowOf(proflameRow(PAY, { word: 0, badPad: true }))).length, 0,
    'Proflame rejects a first word missing its padding bit');
  eq(run(d, rowOf(proflameRow(PAY, {}, { words: 6 }))).length, 0, 'Proflame refuses a frame of only six words');

  // The decoder walks every row, so a good frame behind a bad one is still found.
  {
    const out = run(d, rowsOf([proflameRow(PAY, { word: 2, badPar: true }), proflameRow(PAY)]));
    eq(out.length, 1, 'Proflame finds a good frame in a later row');
    eq(out[0]?.id, 0xabcdef, 'and reads it correctly');
  }
}

// ===========================================================================
// SRSmith pool light remote SRS-2C-TX (227)
// ===========================================================================
{
  const d = dev(227);

  const srsmith = ({ pin = 0x5a, button = 0x0d, unknown = 0x01fffff5, size = 0x07,
                     subParity = null, preambleBytes = 1, breakCrc = false } = {}) => {
    const b = new Uint8Array(10);
    b[0] = size;
    b[1] = (unknown >>> 24) & 0xff; b[2] = (unknown >>> 16) & 0xff;
    b[3] = (unknown >>> 8) & 0xff; b[4] = unknown & 0xff;
    b[5] = pin;
    b[6] = button;
    b[7] = subParity === null ? crc8Ref(b, 6, 1, 1, 1) : subParity;
    const crc = crc16Ref(b, 8, 0x8005, 0xffff) ^ (breakCrc ? 0xffff : 0);
    b[8] = (crc >> 8) & 0xff; b[9] = crc & 0xff;
    const pre = new Array(preambleBytes).fill(0xaa);
    return { bb: rowOf(bytesToBits([...pre, 0xd3, 0x91, 0xd3, 0x91, ...b])), b };
  };

  {
    const built = srsmith({});
    eq(built.bb.bitsPerRow[0], 120, 'the shortest accepted burst is exactly 120 bits (premise)');
    const out = run(d, built.bb);
    eq(out.length, 1, 'SRSmith decodes a well-formed frame');
    eq(out[0]?.model, 'SRSmith-SRS2CTX', 'SRSmith model');
    eq(out[0]?.id, reverse8Ref((~0x5a) & 0xff), 'SRSmith id is the pin byte inverted and bit-reversed');
    eq(out[0]?.button_press, 0x0d, 'SRSmith button code');
    eq(out[0]?.button_press_name, 'On/Off Channel 1', 'SRSmith button name');
    eq(out[0]?.unknown, 0x01fffff5, 'SRSmith reports the unexplained field as it arrived');
    eq(out[0]?.mic, 'CRC', 'SRSmith reports a CRC');
  }

  // More run-in shifts where the search lands, which is the point of searching rather than assuming.
  {
    const built = srsmith({ preambleBytes: 2 });
    eq(built.bb.bitsPerRow[0], 128, 'a longer run-in makes a longer burst (premise)');
    eq(run(d, built.bb)[0]?.button_press, 0x0d, 'SRSmith finds its frame behind a longer run-in');
  }

  for (const [code, name] of [[0x0d, 'On/Off Channel 1'], [0x1f, 'On/Off Channel 2'],
                              [0x07, 'Color Sync'], [0x0b, 'ON/OFF Control - M'], [0x42, 'Unknown']]) {
    eq(run(d, srsmith({ button: code }).bb)[0]?.button_press_name, name, `SRSmith names button 0x${code.toString(16)}`);
  }

  /*
   * The inner CRC-8 is computed upstream, logged, and never compared. Nothing has ever forced its parameters to
   * be right and no capture is published to settle them, so this port neither enforces nor reports it. A frame
   * carrying a deliberately wrong one still decodes, which is upstream's behavior exactly.
   */
  {
    const built = srsmith({ subParity: 0x00 });
    ok(crc8Ref(built.b, 6, 1, 1, 1) !== built.b[7], 'the inner CRC-8 really is wrong in this frame (premise)');
    eq(run(d, built.bb).length, 1, 'SRSmith still decodes it, because that check is never enforced');
    eq(run(d, built.bb)[0]?.sub_parity, undefined, 'and the unenforced value is not reported as an integrity result');
  }

  // ---- rejections ----
  eq(run(d, srsmith({ breakCrc: true }).bb).length, 0, 'SRSmith rejects a bad CRC-16');
  eq(run(d, srsmith({ preambleBytes: 5 }).bb).length, 0, 'SRSmith refuses a burst longer than it ever sends');
  eq(run(d, rowOf(bytesToBits([0xaa, 0xd3, 0x91, 0xd3, 0x91, 1, 2, 3, 4, 5]))).length, 0,
    'SRSmith refuses a burst too short to hold a frame');
  eq(ret(d, rowsOf([bytesToBits(new Array(16).fill(0xaa)), bytesToBits(new Array(16).fill(0xaa))])), DECODE_ABORT_EARLY,
    'SRSmith wants a single row');
}

// ===========================================================================
// Flowis water meter (237)
// ===========================================================================
{
  const d = dev(237);

  const flowis = ({ type = 1, id = 0x12345678, volume = 123456, alarm = 0, backflow = 0,
                    len = 0x15, breakCrc = false, truncate = 0 } = {}) => {
    const frame = new Uint8Array(len + 3);
    frame[0] = len;
    frame[1] = type;
    frame[2] = id & 0xff; frame[3] = (id >>> 8) & 0xff;
    frame[4] = (id >>> 16) & 0xff; frame[5] = (id >>> 24) & 0xff;
    // 2025-09-10T14:30:45, packed across four bytes on no particular boundary.
    frame[7] = 0xad; frame[8] = 0xe7; frame[9] = 0x54; frame[10] = 0x66;
    frame[11] = volume & 0xff; frame[12] = (volume >> 8) & 0xff; frame[13] = (volume >> 16) & 0xff;
    frame[14] = backflow; frame[15] = alarm;
    const crc = crc16Ref(frame, len + 1, 0x8005, 0xffff) ^ (breakCrc ? 0xffff : 0);
    frame[len + 1] = (crc >> 8) & 0xff; frame[len + 2] = crc & 0xff;
    const bits = bytesToBits([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91, ...frame]);
    return rowOf(truncate ? bits.slice(0, bits.length - truncate) : bits);
  };

  {
    const out = run(d, flowis({}));
    eq(out.length, 1, 'Flowis decodes a type-1 message');
    eq(out[0]?.model, 'Flowis', 'Flowis model');
    eq(out[0]?.id, 0x12345678, 'Flowis meter id, sent least significant byte first');
    eq(out[0]?.msg_type, 1, 'Flowis message type');
    eq(out[0]?.volume_m3, 123.456, 'Flowis volume counts liters');
    eq(out[0]?.device_time, '2025-09-10T14:30:45', 'Flowis unpacks its bit-packed timestamp');
    eq(out[0]?.alarm, 0, 'Flowis alarm byte');
    eq(out[0]?.backflow, 0, 'Flowis backflow byte');
    eq(out[0]?.mic, 'CRC', 'Flowis reports a CRC');
  }
  eq(run(d, flowis({ alarm: 0x04, backflow: 0x02 }))[0]?.alarm, 0x04, 'Flowis reports a raised alarm');
  eq(run(d, flowis({ alarm: 0x04, backflow: 0x02 }))[0]?.backflow, 0x02, 'Flowis reports backflow');
  eq(run(d, flowis({ volume: 0 }))[0]?.volume_m3, 0, 'Flowis reports a zero volume');

  /*
   * A type-2 message shares the framing and passes the same CRC, and is still not reported: its payload layout
   * is not known, so reading type-1 fields out of it would be an invention. The return code separates
   * "validated then declined" from "rejected".
   */
  {
    eq(run(d, flowis({ type: 2 })).length, 0, 'Flowis reports nothing for a type-2 message');
    eq(ret(d, flowis({ type: 2 })), DECODE_ABORT_EARLY, 'and declines it rather than failing its check');
    eq(ret(d, flowis({ type: 2, breakCrc: true })), DECODE_FAIL_MIC,
      'while a type-2 message with a bad CRC fails the check instead (premise: the CRC was good above)');
  }

  // ---- rejections ----
  eq(run(d, flowis({ breakCrc: true })).length, 0, 'Flowis rejects a bad CRC');
  eq(ret(d, flowis({ truncate: 32 })), DECODE_ABORT_LENGTH,
    'Flowis refuses a burst whose length byte promises more than the row holds');
  eq(run(d, rowOf(bytesToBits([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]))).length, 0,
    'Flowis finds nothing without its sync word');
}

// ===========================================================================
// Celsia CZC1 thermostat (243)
// ===========================================================================
{
  const d = dev(243);

  const SYMBOL = { 0: 0x55, 1: 0x5a, 2: 0xa5, 3: 0xaa };
  /** Each pair of data bits becomes one byte on the air. */
  const symbolize = (bytes) => {
    const out = [];
    for (const b of bytes) for (let s = 6; s >= 0; s -= 2) out.push(SYMBOL[(b >> s) & 3]);
    return out;
  };
  const celsia = ({ id = 0x1234, command = true, heat = 200, breakCrc = false, typeByte = null,
                    junkByte = false, terminator = true } = {}) => {
    const data = command
      ? [(id >> 8) & 0xff, id & 0xff, typeByte === null ? 0xf0 : typeByte, reverse8Ref(heat)]
      : [(id >> 8) & 0xff, id & 0xff, typeByte === null ? 0x00 : typeByte];
    const crc = crc8Ref(Uint8Array.from(data), data.length, 0x31, 0xd7) ^ (breakCrc ? 0xff : 0);
    const full = [...data, crc];
    const syms = symbolize(full);
    if (junkByte) syms.splice(4, 0, 0x00);          // not one of the five recognized bytes
    const wire = [0xcc, 0xcc, 0xcc, 0xcc, 0x55, 0x55, 0x55, 0x55, ...syms];
    if (terminator) wire.push(0xf0);
    return { bb: rowOf(bytesToBits(wire)), full };
  };

  {
    const built = celsia({});
    /*
     * The CRC is run over eight bytes even though a command packet is five. That is safe rather than lucky:
     * once the register reaches zero, feeding it zero bytes leaves it at zero, so extending the run past the
     * real data changes nothing. Both halves are asserted here rather than assumed.
     */
    const five = Uint8Array.from(built.full);
    const eight = new Uint8Array(8); eight.set(five);
    eq(crc8Ref(five, 5, 0x31, 0xd7), 0, 'a command packet checks out over its own five bytes (premise)');
    eq(crc8Ref(eight, 8, 0x31, 0xd7), 0, 'and still checks out over the eight the decoder actually runs');

    const out = run(d, built.bb);
    eq(out.length, 1, 'Celsia decodes a command packet');
    eq(out[0]?.model, 'Celsia-CZC1', 'Celsia model');
    eq(out[0]?.id, 0x1234, 'Celsia thermostat id');
    eq(out[0]?.heat, 200, 'Celsia heating level, sent bit-reversed');
    eq(out[0]?.mic, 'CRC', 'Celsia reports a CRC');
  }
  eq(run(d, celsia({ heat: 0 }).bb)[0]?.heat, 0, 'Celsia reads a zero heating level');
  eq(run(d, celsia({ heat: 255 }).bb)[0]?.heat, 255, 'Celsia reads a full heating level');

  // A pairing packet is one byte shorter and carries no heating level at all.
  {
    const built = celsia({ command: false });
    const four = Uint8Array.from(built.full);
    const eight = new Uint8Array(8); eight.set(four);
    eq(crc8Ref(eight, 8, 0x31, 0xd7), 0, 'a pairing packet also checks out over eight bytes (premise)');
    const out = run(d, built.bb);
    eq(out.length, 1, 'Celsia decodes a pairing packet');
    eq(out[0]?.id, 0x1234, 'Celsia pairing id');
    eq(out[0]?.heat, undefined, 'a pairing packet carries no heating level, and none is invented');
  }

  // An unrecognized symbol byte is skipped rather than treated as an error.
  {
    ok(![0x55, 0x5a, 0xa5, 0xaa, 0xf0].includes(0x00), 'the junk byte really is unrecognized (premise)');
    const out = run(d, celsia({ junkByte: true }).bb);
    eq(out.length, 1, 'Celsia skips a symbol byte it does not recognize');
    eq(out[0]?.heat, 200, 'and reads the same value around it');
  }

  // ---- rejections ----
  eq(run(d, celsia({ breakCrc: true }).bb).length, 0, 'Celsia rejects a bad CRC');
  {
    // A packet type that is neither of the two known, with a CRC that is otherwise good.
    const built = celsia({ typeByte: 0x33 });
    eq(crc8Ref(Uint8Array.from(built.full), 5, 0x31, 0xd7), 0, 'the odd-typed packet has a valid CRC (premise)');
    eq(run(d, built.bb).length, 0, 'Celsia rejects a packet type it does not know');
  }
  eq(run(d, rowOf(bytesToBits(new Array(30).fill(0x55)))).length, 0, 'Celsia finds nothing without its run-in');
  eq(run(d, rowOf(bytesToBits([0xcc, 0xcc, 0xcc, 0xcc, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55]))).length, 0,
    'Celsia refuses a burst too short to hold a packet');

  // The symbols are rebuilt into a buffer of the decoder's own.
  {
    const bb = celsia({}).bb;
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb).join('|'), before.join('|'), 'Celsia leaves the shared bit buffer untouched');
  }
}

// ===========================================================================
// Mueller Hot Rod water meter (255)
// ===========================================================================
{
  const d = dev(255);

  // ---- all five published captures ----
  {
    const CAPS = [
      [136, 'ffffffffffd62002884cc2c092f1201f80', 497890],
      [135, 'fff555555fd62002884cc2c092f1201f80', 497890],
      [135, 'ffeaaaaabfac40051099858125e2403f00', 497890],
      [134, '000002aabfac40051099858125e54015c0', 497950],
    ];
    for (const [n, hex, volume] of CAPS) {
      const out = run(d, rowOf(fromHex(hex, n)));
      eq(out.length, 1, `Mueller decodes its {${n}} capture ${hex.slice(0, 10)}`);
      eq(out[0]?.model, 'Mueller-HotRod', 'Mueller model');
      eq(out[0]?.id, '14426616', 'Mueller meter id, the same unit in every capture');
      eq(out[0]?.volume_gal, volume, 'Mueller cumulative volume in gallons');
      eq(out[0]?.flag, 0, 'Mueller flag nibble, reported raw because its meaning is unconfirmed');
      eq(out[0]?.mic, 'CRC', 'Mueller reports a CRC');
    }

    /*
     * The fifth capture is the same transmission as the fourth with its sync word eaten by the demodulator --
     * upstream's own note says the run-in is unstable under GFSK. It cannot decode upstream either, so it is
     * kept here as the rejection it is rather than dropped from the evidence.
     */
    const lost = '00000000000040051099858125e54015c0';
    const kept = '000002aabfac40051099858125e54015c0';
    eq(lost.slice(12), kept.slice(12), 'the fifth capture carries the same payload as the fourth (premise)');
    ok(lost.slice(0, 12) !== kept.slice(0, 12), 'and differs only where the sync word should be (premise)');
    eq(run(d, rowOf(fromHex(lost, 134))).length, 0, 'Mueller cannot decode the capture whose sync word was lost');
  }

  // ---- built from the transmit side ----
  {
    const mueller = ({ id = [0xde, 0xad, 0xbe, 0xef], volume = 1234567, flag = 3, breakCrc = false } = {}) => {
      const b = new Uint8Array(9);
      b.set(id, 0);
      const digits = String(volume).padStart(7, '0').split('').map(Number);
      b[4] = (digits[0] << 4) | digits[1];
      b[5] = (digits[2] << 4) | digits[3];
      b[6] = (digits[4] << 4) | digits[5];
      b[7] = (digits[6] << 4) | flag;
      b[8] = (crc8Ref(b, 8, 0x07, 0x00) ^ 0x55) ^ (breakCrc ? 0xff : 0);
      return rowOf(bytesToBits([0xaa, 0xaa, 0xfe, 0xb1, 0x00, ...b]));
    };

    const out = run(d, mueller({}));
    eq(out.length, 1, 'Mueller decodes a frame built from the transmit side');
    eq(out[0]?.id, 'deadbeef', 'Mueller id is the four address bytes as hex');
    eq(out[0]?.volume_gal, 1234567, 'Mueller reads seven BCD nibbles of gallons');
    eq(out[0]?.flag, 3, 'Mueller reports the flag nibble beside them');
    eq(run(d, mueller({ volume: 0 }))[0]?.volume_gal, 0, 'Mueller reads a brand-new meter');
    eq(run(d, mueller({ volume: 9999999 }))[0]?.volume_gal, 9999999, 'Mueller reads a meter about to roll over');
    eq(run(d, mueller({ breakCrc: true })).length, 0, 'Mueller rejects a bad CRC');
    eq(ret(d, mueller({ breakCrc: true })), DECODE_FAIL_MIC, 'and says so, where upstream returns a bare zero');
  }

  eq(run(d, rowOf(new Array(200).fill(0))).length, 0, 'Mueller finds nothing in a silent burst');
  eq(run(d, rowOf(bytesToBits([0xfe, 0xb1, 0x00, 1, 2, 3]))).length, 0,
    'Mueller refuses a burst too short to hold a message');
}

// ===========================================================================
// Oregon Scientific WMR500 (363)
// ===========================================================================
{
  const d = dev(363);

  /**
   * The message, then the whole burst complemented.
   *
   * Upstream inverts the shared buffer and searches for 0x552c6e2c6e; this port searches for the complement of
   * that pattern instead and complements the bytes it extracts, which is the same operation without touching
   * the buffer. The complement is 0xaad391d391 -- the ordinary CC110x sync word.
   */
  const wmr500 = ({ len = 25, id = 0x2b7f, tempRaw = 179, humRaw = 149, type = 0x41,
                    breakCrc = false, shorten = 0 } = {}) => {
    const total = len === 14 ? 17 : 28;
    const b = new Uint8Array(total);
    b[0] = len; b[1] = 0xfe; b[2] = type;
    b[3] = 0x25; b[4] = 0x1d; b[5] = 0xf9; b[6] = 0xdd; b[7] = 0xdf;
    b[8] = (id >> 8) & 0xff; b[9] = id & 0xff;
    b[11] = 0xc6; b[13] = 0x4f;
    if (len === 25) { b[14] = tempRaw; b[16] = humRaw; }
    const init = len === 14 ? 0x4ed0 : 0x1a4c;
    const crc = crc16Ref(b, total - 2, 0x8005, init) ^ (breakCrc ? 0xffff : 0);
    b[total - 2] = (crc >> 8) & 0xff; b[total - 1] = crc & 0xff;
    const wire = [0x55, 0x2c, 0x6e, 0x2c, 0x6e, ...b];
    const bits = inv(bytesToBits(wire));
    return rowOf(shorten ? bits.slice(0, bits.length - shorten) : bits);
  };

  {
    const out = run(d, wmr500({}));
    eq(out.length, 1, 'WMR500 decodes a long message');
    eq(out[0]?.model, 'Oregon-WMR500', 'WMR500 model');
    eq(out[0]?.id, 0x2b7f, 'WMR500 device id');
    eq(out[0]?.humidity, 59, 'WMR500 humidity, the one field fitted exactly to real readings');
    eq(out[0]?.temperature_C, 7, 'WMR500 temperature, from upstream two-point fit');
    eq(out[0]?.temperature_raw, 179, 'and the byte it came from, so the estimate can be checked later');
    eq(out[0]?.mic, 'CRC', 'WMR500 reports a CRC');
  }
  eq(run(d, wmr500({ humRaw: 159 }))[0]?.humidity, 49, 'WMR500 reads the other end of the reference session');

  /*
   * The short message passes its own CRC -- a different init from the long one -- and is then deliberately
   * dropped, because its payload is believed to be wind but has never been confirmed. The return code is what
   * separates that from a rejection; both produce no reading.
   */
  {
    eq(run(d, wmr500({ len: 14 })).length, 0, 'WMR500 reports nothing for a short message');
    eq(ret(d, wmr500({ len: 14 })), DECODE_ABORT_EARLY, 'having verified it and declined to guess at its payload');
    eq(ret(d, wmr500({ len: 14, breakCrc: true })), DECODE_FAIL_MIC,
      'while a short message with a bad CRC fails its check (premise: the CRC above really was good)');
  }

  // ---- rejections ----
  eq(run(d, wmr500({ breakCrc: true })).length, 0, 'WMR500 rejects a bad CRC');
  eq(ret(d, wmr500({ len: 20 })), DECODE_ABORT_EARLY, 'WMR500 refuses a length it does not know');
  eq(ret(d, wmr500({ humRaw: 100 })), DECODE_FAIL_SANITY, 'WMR500 rejects a humidity outside 0-100');
  eq(ret(d, wmr500({ shorten: 64 })), DECODE_ABORT_LENGTH, 'WMR500 refuses a burst cut short of its message');
  eq(run(d, rowOf(new Array(300).fill(0))).length, 0, 'WMR500 finds nothing in a silent burst');

  // The buffer upstream would have inverted is left exactly as it arrived.
  {
    const bb = wmr500({});
    const before = snapshot(bb);
    run(d, bb);
    eq(snapshot(bb).join('|'), before.join('|'), 'WMR500 leaves the shared bit buffer untouched');
  }

  // The pool remote searches the very same forty-bit sync word, so the two must not claim each other's frames.
  {
    eq(run(dev(227), wmr500({})).length, 0, 'a WMR500 burst does not decode as the pool remote');
    const srs = rowOf(bytesToBits([0xaa, 0xd3, 0x91, 0xd3, 0x91, 7, 1, 255, 255, 245, 0x5a, 0x0d, 0x00, 0x00, 0x00]));
    eq(run(d, srs).length, 0, 'and a pool remote burst does not decode as a WMR500');
  }
}

// ===========================================================================
// The registrations themselves
// ===========================================================================
{
  const MINE = [26, 45, 77, 193, 207, 227, 237, 243, 255, 363];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));

  /*
   * None of these ten carries `.disabled` upstream, so none may carry it here. Asserting both halves means
   * checking that the flag is absent on all ten and that the assertion could see it if it were not.
   */
  const wronglyDisabled = MINE.filter(n => dev(n).disabled);
  ok(wronglyDisabled.length === 0, 'none of these ten is disabled, matching upstream', wronglyDisabled.join(', '));
  const someoneIsDisabled = REGISTRY.some(d => d.disabled === true);
  ok(someoneIsDisabled, 'the disabled flag is readable on this registry, so the check above is not vacuous');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
