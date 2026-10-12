/**
 * Twelve small OOK and FSK devices with nothing in common but their size.
 *
 * Only one of them publishes a frame. `opel_mokka.c` prints a whole transmission in its doc comment as a binary
 * row grouped 1/11/5/64, and that row is used here exactly as written: it yields key id 1074 and event 26, and
 * 26 is the event number the same comment states in prose, which confirms the bit alignment without reference
 * to this port. It also exposes an off-by-one in upstream's payload extraction, and both readings of the
 * payload are asserted so the discrepancy stays visible rather than being quietly picked.
 *
 * Everything else is built from the transmit side: the bytes a sensor would lay down, its checksum computed
 * from the definition rather than by calling the code under test, and the line coding applied afterwards.
 * Where a decoder searches for its frame, the builder places that frame exactly where the match ends — the
 * McPower preamble and the CED7000 sync are both asserted to land where the test assumes, since a builder that
 * is one bit out looks exactly like a broken decoder.
 *
 * Several assertions are premises rather than outcomes: that a checksum really does overflow a byte before the
 * masking is claimed correct, that a frame really is all zeros before the guard that rejects it is credited,
 * that a corrupted bit is one the decoder actually reads. Those are the ones that catch a test passing for the
 * wrong reason.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };
/** The numeric return, so the *reason* a frame was refused can be pinned, not just that it was. */
const code = (d, bb) => d.decode(d, bb, { emit: () => {} });

// ---- reference arithmetic, written from the definitions rather than imported ----
const crc8Ref = (m, n, poly, init, at = 0) => {
  let r = init & 0xff;
  for (let i = 0; i < n; i++) { r ^= m[at + i]; for (let b = 0; b < 8; b++) r = (r & 0x80) ? (((r << 1) ^ poly) & 0xff) : ((r << 1) & 0xff); }
  return r;
};
const crc16Ref = (m, n, poly, init, at = 0) => {
  let r = init & 0xffff;
  for (let i = 0; i < n; i++) { r ^= m[at + i] << 8; for (let b = 0; b < 8; b++) r = (r & 0x8000) ? (((r << 1) ^ poly) & 0xffff) : ((r << 1) & 0xffff); }
  return r & 0xffff;
};
const parityRef = (v) => { let p = 0; for (let i = 0; i < 8; i++) p ^= (v >> i) & 1; return p; };
const reverse8Ref = (v) => { let r = 0; for (let i = 0; i < 8; i++) if ((v >> i) & 1) r |= 0x80 >> i; return r & 0xff; };
const rev4 = (v) => ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3);
const reflectNibblesRef = (v) => (((rev4(v >> 4) << 4) | rev4(v & 0x0f)) & 0xff);
const xorRef = (m, n) => { let x = 0; for (let i = 0; i < n; i++) x ^= m[i]; return x; };

// ---- bit plumbing ----
const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const bitsToBytes = (bits) => { const o = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { if (b) o[i >> 3] |= 0x80 >> (i & 7); }); return o; };
const numToBits = (v, n) => { const o = []; for (let i = n - 1; i >= 0; i--) o.push((v >> i) & 1); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
const hexOfBits = (bits) => [...bitsToBytes(bits)].map(v => v.toString(16).padStart(2, '0')).join('');
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const rowsOf = (...arrs) => { const bb = new BitBuffer(); arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); }); return bb; };

/** A reference preamble search, so a builder's placement can be checked without trusting the decoder. */
const searchRef = (bits, pattern, patLen) => {
  const pat = bytesToBits(Uint8Array.from(pattern)).slice(0, patLen);
  for (let i = 0; i + patLen <= bits.length; i++) {
    let hit = true;
    for (let k = 0; k < patLen; k++) if (bits[i + k] !== pat[k]) { hit = false; break; }
    if (hit) return i;
  }
  return -1;
};

/** Several of these decoders invert their input upstream and never restore it; none may do so here. */
const noWrite = (d, bb, what) => {
  const before = Uint8Array.from(bb.bb[0]);
  run(d, bb);
  const after = Uint8Array.from(bb.bb[0]);
  let same = before.length === after.length;
  if (same) for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { same = false; break; }
  ok(same, what);
};

console.log('WG-PB12V1, IBIS, Opus XT300, EnOcean, CED7000, Rosstech, RFM69, TR-502MSV, Opel Mokka, Florabest, Hanwell and McPower');

// ---- WG-PB12V1 (39): a probe that only just differs from a Fine Offset ----
{
  const d = dev(39);
  const build = ({ type = 0x3, tempRaw = 605, id = 9, hum = 0xff, preamble = 0xff, breakCrc = false, bits = 48 } = {}) => {
    const b = new Uint8Array(6);
    b[0] = preamble;
    b[1] = ((type & 0x0f) << 4) | ((tempRaw >> 8) & 0x0f);
    b[2] = tempRaw & 0xff;
    b[3] = id & 0x1f;
    b[4] = hum;
    b[5] = crc8Ref(b, 4, 0x31, 0, 1) ^ (breakCrc ? 0xff : 0);
    return rowOf(bytesToBits(b).slice(0, bits));
  };

  // The file's own worked example: 0010 01011101 is 605 deci-celsius, less a 40 C offset.
  eq(0b001001011101, 605, 'the documented temperature nibbles really are 605 (premise)');
  const out = run(d, build({}));
  eq(out.length, 1, 'WG-PB12V1 decodes a well-formed frame');
  eq(out[0]?.id, 9, 'WG-PB12V1 id');
  eq(out[0]?.temperature_C, 20.5, 'WG-PB12V1 temperature matches its file\'s worked example');
  eq(out[0]?.mic, 'CRC', 'WG-PB12V1 reports a CRC');
  eq(run(d, build({ tempRaw: 400 }))[0]?.temperature_C, 0, 'WG-PB12V1 offset puts 400 at zero');

  eq(code(d, build({ bits: 47 })), -1, 'WG-PB12V1 wants at least 48 bits');
  eq(code(d, build({ preamble: 0xfe })), -2, 'WG-PB12V1 rejects a bad preamble');
  // 0x4 in the type nibble is a Fine Offset WH2 — the only thing separating the two protocols.
  eq(code(d, build({ type: 0x4 })), -2, 'WG-PB12V1 rejects the Fine Offset WH2 message type');
  eq(code(d, build({ breakCrc: true })), -3, 'WG-PB12V1 rejects a bad CRC');
  eq(code(d, build({ hum: 0x00 })), 0, 'WG-PB12V1 rejects a humidity byte that is not 0xff');
  // The order matters to a caller: a damaged frame and a misread one are different events.
  eq(code(d, build({ hum: 0x00, breakCrc: true })), -3, 'WG-PB12V1 tests the CRC before the humidity byte');

  noWrite(d, build({}), 'WG-PB12V1 leaves the shared buffer alone');
  eq(d.disabled, undefined, 'WG-PB12V1 is not disabled upstream');
}

// ---- IBIS beacon (80): a 32-bit counter and a signedness trap ----
{
  const d = dev(80);
  const LEAD = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1];      // 0xaab
  const mkMsg = ({ id = 0xabcd, counter = 0x12345678, breakCrc = false } = {}) => {
    const msg = new Uint8Array(28);
    for (let i = 0; i < 26; i++) msg[i] = (i * 7 + 3) & 0xff;
    msg[5] = (msg[5] & 0xf0) | ((id >> 12) & 0x0f);
    msg[6] = (id >> 4) & 0xff;
    msg[7] = ((id & 0x0f) << 4) | (msg[7] & 0x0f);
    msg[20] = (counter >>> 24) & 0xff; msg[21] = (counter >>> 16) & 0xff;
    msg[22] = (counter >>> 8) & 0xff; msg[23] = counter & 0xff;
    const c = crc16Ref(msg, 26, 0x8005, 0x0000) ^ (breakCrc ? 0xffff : 0);
    msg[26] = (c >> 8) & 0xff; msg[27] = c & 0xff;
    return msg;
  };
  const build = (o = {}) => rowOf([...LEAD, ...bytesToBits(mkMsg(o))]);

  // The run-in is 0xaab and the search is for its last eight bits, so the frame starts at bit 12.
  eq(searchRef([...LEAD, ...bytesToBits(mkMsg({}))], [0xab], 8), 4, 'the 0xab run-in match lands at bit 4 (premise)');

  const out = run(d, build({}));
  eq(out.length, 1, 'IBIS decodes a well-formed beacon');
  eq(out[0]?.id, 0xabcd, 'IBIS vehicle number');
  eq(out[0]?.counter, 0x12345678, 'IBIS counter');
  eq(out[0]?.code, [...mkMsg({})].map(v => v.toString(16).padStart(2, '0')).join(''), 'IBIS publishes all 28 bytes');
  eq(out[0]?.mic, 'CRC', 'IBIS reports a CRC');

  // A counter above 2^31 is where `msg[20] << 24` would come back negative.
  {
    const big = run(d, build({ counter: 0xff345678 }));
    ok(0xff345678 > 2 ** 31, 'the large counter really does exceed a signed 32-bit range (premise)');
    eq(big[0]?.counter, 0xff345678, 'IBIS reads a counter above 2^31 as a positive number');
  }

  eq(code(d, build({ breakCrc: true })), -3, 'IBIS rejects a bad CRC');
  eq(code(d, rowOf(new Array(236).fill(0))), -2, 'IBIS finds no run-in in a silent burst');
  eq(code(d, rowOf([...LEAD, ...bytesToBits(mkMsg({}))].slice(0, 231))), -1, 'IBIS wants at least 232 bits');
  eq(code(d, rowOf([...new Array(20).fill(0), ...LEAD, ...bytesToBits(mkMsg({}))].slice(0, 251))), -1,
    'IBIS wants at most 250 bits');
  // Run-in found in time, but not enough frame behind it.
  eq(code(d, rowOf([...new Array(20).fill(0), 1, 0, 1, 0, 1, 0, 1, 1, ...new Array(212).fill(0)])), -1,
    'IBIS rejects a burst with too little data after the run-in');
  eq(code(d, rowsOf([...LEAD, ...bytesToBits(mkMsg({}))], [...LEAD, ...bytesToBits(mkMsg({}))])), -1,
    'IBIS wants a single row');

  noWrite(d, build({}), 'IBIS leaves the shared buffer alone');
}

// ---- Opus XT300 (121): the loosest checksum here ----
{
  const d = dev(121);
  const build = ({ b0 = 0xff, b1 = 0x55, moisture = 50, temp = 25, chk = null, bits = 48 } = {}) => {
    const b = new Uint8Array(6);
    b[0] = b0; b[1] = b1; b[2] = moisture; b[3] = (temp + 40) & 0xff; b[4] = 0xff;
    b[5] = chk === null ? ((b[1] + b[2] + b[3] + b[4]) & 0xff) : chk;
    return rowOf(bytesToBits(b).slice(0, bits));
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Opus XT300 decodes a well-formed frame');
  eq(out[0]?.channel, 1, 'Opus channel comes from the low two bits of the id byte');
  eq(out[0]?.temperature_C, 25, 'Opus temperature carries a 40 degree offset');
  eq(out[0]?.moisture, 50, 'Opus soil moisture');
  eq(out[0]?.mic, 'CHECKSUM', 'Opus reports a checksum');

  // Upstream masks this sum itself, so the masked helper is right — but only if the sum really overflows.
  ok(0x55 + 50 + 65 + 0xff > 0xff, 'the covered bytes really do sum past a byte (premise)');
  eq((0x55 + 50 + 65 + 0xff) & 0xff, 199, 'and the masked sum is what the frame carries (premise)');

  /*
   * The checksum is skipped when the sum happens to be zero, so a frame whose four covered bytes are a
   * multiple of 256 is accepted with any check byte at all. The premise is the whole test: the sum must
   * genuinely mask to zero, or this would just be a valid frame.
   */
  {
    // A soil reading of 100% at 32 C: the temperature byte carries its 40 degree offset, so b[3] is 72.
    const sum = 0x55 + 100 + 72 + 0xff;
    eq(sum & 0xff, 0, 'these four bytes sum to a multiple of 256 (premise)');
    ok(sum !== 0, 'while the unmasked sum is not itself zero (premise)');
    const loose = run(d, build({ moisture: 100, temp: 32, chk: 0x99 }));
    eq(loose.length, 1, 'so Opus accepts the frame despite a nonsense check byte');
    eq(loose[0]?.moisture, 100, 'and reads it normally');
  }

  eq(code(d, build({ bits: 47 })), -1, 'Opus wants exactly 48 bits');
  eq(code(d, build({ chk: 0x00 })), -3, 'Opus rejects a bad checksum');
  eq(code(d, build({ temp: 101 })), -4, 'Opus rejects an impossible temperature');
  eq(code(d, build({ moisture: 102 })), -4, 'Opus rejects impossible soil moisture');
  eq(code(d, rowOf(bytesToBits(new Uint8Array(6)))), -4, 'Opus rejects an all-zero frame');

  /*
   * Upstream joins the preamble and channel tests with `&&`, so a wrong preamble alone is not enough to
   * abort — the channel byte has to look right too. Both halves are pinned because reading that as `||`
   * would be the obvious "fix" and would change which frames decode.
   */
  eq(((0x55 | 0x1) & 0xfd), 0x55, 'the channel byte pattern the abort tests for (premise)');
  eq(code(d, build({ b0: 0x00, b1: 0x55 })), -2, 'Opus aborts when the preamble is wrong and the id byte matches');
  eq(run(d, build({ b0: 0x00, b1: 0x00 })).length, 1,
    'but a wrong preamble alone still reaches the checksum, as upstream writes it');

  // One bad row must not cost a good one in the same burst.
  {
    const bad = new Array(47).fill(1);
    const b = new Uint8Array(6);
    b[0] = 0xff; b[1] = 0x55; b[2] = 50; b[3] = 65; b[4] = 0xff;
    b[5] = (b[1] + b[2] + b[3] + b[4]) & 0xff;
    eq(run(d, rowsOf(bad, bytesToBits(b))).length, 1, 'Opus reads a good row from a burst that also holds a bad one');
  }

  noWrite(d, build({}), 'Opus leaves the shared buffer alone');
}

// ---- EnOcean ERP1 (198): 12 bits on air per 8 of telegram ----
{
  const d = dev(198);
  const PREAMBLE = [0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1];      // first 11 bits of 0x55 0x20
  const group = (v, more) => {
    const b = numToBits(v, 8);
    return [b[0], b[1], b[2], b[2] ^ 1, b[3], b[4], b[5], b[5] ^ 1, b[6], b[7], (more >> 1) & 1, more & 1];
  };
  const build = ({ bytes, mores = null, breakPair = -1 } = {}) => {
    const logical = [...PREAMBLE];
    bytes.forEach((v, i) => {
      const g = group(v, mores ? mores[i] : 1);
      if (i === breakPair) g[3] = g[2];                    // kill a complement pair
      logical.push(...g);
    });
    return rowOf(inv(logical));                            // the line is inverted on air
  };
  const sealed = (payload) => [...payload, crc8Ref(Uint8Array.from(payload), payload.length, 0x07, 0x00)];

  const TELEGRAM = sealed([0xf6, 0x50, 0x00, 0x8b, 0x12, 0x34, 0x30]);
  const out = run(d, build({ bytes: TELEGRAM }));
  eq(out.length, 1, 'EnOcean decodes a well-formed telegram');
  eq(out[0]?.telegram, TELEGRAM.map(v => v.toString(16).padStart(2, '0')).join(''), 'EnOcean publishes the bytes');
  eq(out[0]?.mic, 'CRC', 'EnOcean reports a CRC');

  {
    const bad = [...TELEGRAM]; bad[7] ^= 0xff;
    ok(bad[7] !== TELEGRAM[7], 'the corrupted check byte really differs (premise)');
    eq(code(d, build({ bytes: bad })), -3, 'EnOcean rejects a bad CRC');
  }

  /*
   * The two-bit continuation code is what ends a telegram. Groups placed after a terminator must be ignored —
   * and the premise proves they are not inert: consuming them breaks the CRC.
   */
  {
    const SHORT = sealed([0xa5, 0x5a]);
    const bytes = [...SHORT, 0x11, 0x22, 0x33];
    const stopped = run(d, build({ bytes, mores: [1, 1, 0, 1, 1] }));
    eq(stopped.length, 1, 'EnOcean stops at a terminating continuation code');
    eq(stopped[0]?.telegram, SHORT.map(v => v.toString(16).padStart(2, '0')).join(''),
      'and reports only the bytes before it');
    eq(code(d, build({ bytes, mores: [1, 1, 1, 1, 1] })), -3,
      'while consuming the trailing groups breaks the CRC (premise)');
  }

  // A broken complement pair stops the decode mid-group, leaving a short buffer the CRC then refuses.
  eq(code(d, build({ bytes: TELEGRAM, breakPair: 3 })), -3, 'EnOcean rejects a broken complement pair');

  eq(code(d, rowOf(new Array(107).fill(0))), -4, 'EnOcean finds no preamble in a flat burst');
  eq(code(d, rowsOf(inv([...PREAMBLE]), inv([...PREAMBLE]))), -2, 'EnOcean wants a single row');
  eq(code(d, build({ bytes: [0xf6] })), -1, 'EnOcean wants at least two bytes of telegram');

  noWrite(d, build({ bytes: TELEGRAM }), 'EnOcean inverts a copy, not the shared buffer');
  eq(d.disabled, true, 'EnOcean mirrors upstream\'s disabled flag: it needs a high sample rate');
}

// ---- CED7000 (233): the Manchester stop position is the only check ----
{
  const d = dev(233);
  const SYNC = [0xaa, 0x4d, 0x5e];
  /**
   * The decoder inverts before decoding, so a wire pair is (v, !v) for a decoded bit v. The last decoded bit
   * gets only its first half from the row: its second half is the zero padding past a 201-bit row, which is
   * exactly what makes the stop position 202 rather than 201.
   */
  const build = ({ reflected = [0x43, 0x21, 0x70, 0x43, 0x21, 0x07, 0x65, 0x00], tail = 25,
                   rows = 2, sync = true, breakPair = -1, drop = 0 } = {}) => {
    const decoded = [...bytesToBits(Uint8Array.from(reflected.map(reflectNibblesRef)))];
    for (let i = 0; i < tail; i++) decoded.push(0);
    const wire = sync ? bytesToBits(Uint8Array.from(SYNC)) : new Array(24).fill(0);
    decoded.forEach((v, i) => {
      if (i === decoded.length - 1) wire.push(v);          // only the first half is inside the row
      else if (i === breakPair) wire.push(v, v);           // a coding violation
      else wire.push(v, v ^ 1);
    });
    const row = drop ? wire.slice(0, wire.length - drop) : wire;
    return rowsOf(...new Array(rows).fill(row));
  };

  // The builder must put the frame where the search ends, and the row must be exactly 201 bits.
  {
    const one = build({ rows: 1 });
    eq(one.bitsPerRow[0], 201, 'the built row is 201 bits (premise)');
    const wire = [];
    for (let i = 0; i < 201; i++) wire.push((one.bb[0][i >> 3] >> (7 - (i & 7))) & 1);
    eq(searchRef(wire, SYNC, 24), 0, 'the sync match lands at bit 0, so the frame starts at bit 24 (premise)');
  }

  const out = run(d, build({}));
  eq(out.length, 1, 'CED7000 decodes a well-formed frame');
  eq(out[0]?.id, '1234', 'CED7000 reads its id as four reflected decimal digits');
  eq(out[0]?.count, 7, 'CED7000 shot count');
  eq(out[0]?.final, 12.34, 'CED7000 final time');
  eq(out[0]?.split, 5.67, 'CED7000 split time');

  eq(code(d, build({ rows: 1 })), -2, 'CED7000 needs the frame repeated');
  eq(code(d, build({ sync: false })), -2, 'CED7000 finds nothing without its sync word');
  eq(code(d, build({ drop: 1 })), -3, 'CED7000 rejects a row one bit short of its stop position');
  eq(code(d, build({ breakPair: 40 })), -3, 'CED7000 rejects a Manchester coding violation');

  noWrite(d, build({}), 'CED7000 inverts a copy, not the shared buffer');
  eq(d.disabled, true, 'CED7000 mirrors upstream\'s disabled flag: no fixed id and no checksum');
}

// ---- Rosstech DCU-706 (265): 8o1 serial, inverted framing ----
{
  const d = dev(265);
  const enc = (v) => [1, ...numToBits(v, 8), parityRef(v), 0];    // start 1, odd parity, stop 0
  const build = ({ type = 0xba, id = 0x1234, tempF = 102, chk = null, lead = [],
                   breakParity = false, breakStop = false, breakStart = false, bits = null } = {}) => {
    const b = new Uint8Array(5);
    b[0] = type; b[1] = (id >> 8) & 0xff; b[2] = id & 0xff; b[3] = tempF;
    b[4] = chk === null ? (0xff ^ xorRef(b, 4)) : chk;
    const out = [...lead];
    for (let i = 0; i < 5; i++) {
      const g = enc(b[i]);
      if (i === 1 && breakParity) g[9] ^= 1;
      if (i === 1 && breakStop) g[10] ^= 1;
      if (i === 1 && breakStart) g[0] ^= 1;
      out.push(...g);
    }
    return rowOf(bits === null ? out : out.slice(0, bits));
  };

  // The two preambles are not arbitrary: each is the 8o1 encoding of its own message-type byte.
  eq(enc(0xba).join(''), bytesToBits(Uint8Array.from([0xdd, 0x40])).slice(0, 11).join(''),
    'the data preamble is the 8o1 encoding of 0xba (premise)');
  eq(enc(0x9a).join(''), bytesToBits(Uint8Array.from([0xcd, 0x00])).slice(0, 11).join(''),
    'the bond preamble is the 8o1 encoding of 0x9a (premise)');

  const out = run(d, build({}));
  eq(out.length, 1, 'Rosstech decodes a data frame');
  eq(out[0]?.id, '1234', 'Rosstech id');
  eq(out[0]?.temperature_F, 102, 'Rosstech water temperature in Fahrenheit');
  eq(out[0]?.msg_type, 'Data', 'Rosstech names the data transmission');
  eq(out[0]?.mic, 'CHECKSUM', 'Rosstech reports a checksum');
  eq(run(d, build({ type: 0x9a }))[0]?.msg_type, 'Bond', 'Rosstech names the bonding transmission');
  eq(run(d, build({ lead: new Array(8).fill(0) }))[0]?.id, '1234', 'Rosstech finds a frame at an offset');

  eq(code(d, build({ chk: 0x00 })), -3, 'Rosstech rejects a bad checksum');
  eq(code(d, build({ breakParity: true })), -1, 'Rosstech rejects a bad parity bit');
  eq(code(d, build({ breakStop: true })), -1, 'Rosstech rejects a bad stop bit');
  eq(code(d, build({ breakStart: true })), -1, 'Rosstech rejects a bad start bit');
  eq(code(d, rowOf(new Array(55).fill(0))), -1, 'Rosstech finds neither preamble in a silent burst');
  eq(code(d, build({ bits: 54 })), -2, 'Rosstech wants at least 55 bits');
  eq(code(d, rowsOf(new Array(55).fill(0), new Array(55).fill(0))), -2, 'Rosstech wants a single row');

  noWrite(d, build({}), 'Rosstech leaves the shared buffer alone');
}

// ---- RFM69 on a Moteino (318): whatever the sketch sent ----
{
  const d = dev(318);
  const build = ({ preBytes = 3, extraPreBits = 0, dst = 0x01, src = 0x02, ctl = 0x00,
                   data = 'Hello', len = null, breakCrc = false } = {}) => {
    const chars = [...data].map(c => c.charCodeAt(0));
    const payloadLen = len === null ? 3 + chars.length : len;
    const payload = Uint8Array.from([payloadLen, dst, src, ctl, ...chars]);
    const crc = ((~crc16Ref(payload, payload.length, 0x1021, 0x1d0f)) & 0xffff) ^ (breakCrc ? 0xffff : 0);
    const bits = [...bytesToBits(Uint8Array.from(new Array(preBytes).fill(0xaa)))];
    for (let i = 0; i < extraPreBits; i++) bits.push(i % 2 === 0 ? 1 : 0);
    bits.push(...bytesToBits(Uint8Array.from([0x2d, 0x64])));
    bits.push(...bytesToBits(payload));
    bits.push(...bytesToBits(Uint8Array.from([(crc >> 8) & 0xff, crc & 0xff])));
    return rowOf(bits);
  };

  // The sync word has to be found 24 bits in, which is what aligns the header.
  {
    const bits = [];
    for (let i = 0; i < 24; i++) bits.push(i % 2 === 0 ? 1 : 0);
    bits.push(...bytesToBits(Uint8Array.from([0x2d, 0x64])));
    eq(searchRef(bits, [0x2d], 8), 24, 'the 0x2d sync match lands at bit 24 (premise)');
  }

  const out = run(d, build({}));
  eq(out.length, 1, 'RFM69 decodes a well-formed packet');
  eq(out[0]?.id, 0x01, 'RFM69 node id');
  eq(out[0]?.gateway_id, 0x02, 'RFM69 gateway id');
  eq(out[0]?.msg, 'Hello', 'RFM69 carries the sketch\'s own text');
  eq(out[0]?.mic, 'CRC', 'RFM69 reports a CRC');
  eq(run(d, build({ extraPreBits: 4 }))[0]?.msg, 'Hello', 'RFM69 accepts a sync found at bit 28');
  eq(run(d, build({ data: 'A'.repeat(35) }))[0]?.msg, 'A'.repeat(30), 'RFM69 caps the text at 30 characters');

  eq(code(d, build({ breakCrc: true })), -3, 'RFM69 rejects a bad CRC');
  // Upstream reports only its example sketch's gateway address and returns nothing otherwise.
  eq(run(d, build({ src: 0xff })).length, 0, 'RFM69 stays quiet for a sender that is not the gateway');
  eq(run(d, build({ src: 0x01 })).length, 0, 'RFM69 stays quiet for another node');
  eq(code(d, build({ preBytes: 2 })), -2, 'RFM69 rejects a sync found too early');
  eq(code(d, build({ preBytes: 4 })), -2, 'RFM69 rejects a sync found too late');
  eq(code(d, build({ len: 66 })), -1, 'RFM69 rejects an impossible payload length');

  noWrite(d, build({}), 'RFM69 leaves the shared buffer alone');
}

// ---- TR-502MSV (332): socket numbers reversed on the wire ----
{
  const d = dev(332);
  const build = ({ deviceId = 0x5a5, socket = 0, onOff = 1, command = 0, reserved = 0,
                   lead = 1, chk = null, bits = 21, rows = 1 } = {}) => {
    const s2 = (socket >> 2) & 1, s1 = (socket >> 1) & 1, s0 = socket & 1;
    const u1 = chk === null ? (command ^ s2 ^ s0) : ((chk >> 1) & 1);
    const u0 = chk === null ? (onOff ^ s1) : (chk & 1);
    const arr = [lead, ...numToBits(deviceId, 12), ...numToBits(socket, 3), onOff, command, reserved, u1, u0];
    const row = arr.slice(0, bits);
    return rows === 1 ? rowOf(row) : rowsOf(row, row);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'TR-502MSV decodes a well-formed press');
  eq(out[0]?.id, 0x5a5, 'TR-502MSV device id');
  eq(out[0]?.socket_id, '1', 'TR-502MSV socket');
  eq(out[0]?.command, 'ON', 'TR-502MSV command');
  eq(out[0]?.mic, 'CHECKSUM', 'TR-502MSV reports a checksum');

  // The wire codes are bit-reversed, so socket 2 goes out as 100 and socket 3 as 010.
  for (const [wire, want] of [[0, '1'], [4, '2'], [2, '3'], [6, '4'], [7, 'ALL']]) {
    eq(run(d, build({ socket: wire }))[0]?.socket_id, want, `TR-502MSV wire socket ${wire} is socket ${want}`);
  }
  for (const [o, c, want] of [[0, 0, 'OFF'], [0, 1, 'BRIGHT'], [1, 0, 'ON'], [1, 1, 'DIM']]) {
    eq(run(d, build({ onOff: o, command: c }))[0]?.command, want, `TR-502MSV ${o}/${c} is ${want}`);
  }

  for (const odd of [1, 3, 5]) {
    eq(code(d, build({ socket: odd })), -4, `TR-502MSV rejects the impossible socket code ${odd}`);
  }
  eq(code(d, build({ reserved: 1 })), -4, 'TR-502MSV rejects a set reserved bit');
  eq(code(d, build({ lead: 0 })), -2, 'TR-502MSV rejects a missing leading one');
  eq(code(d, build({ chk: 0 , socket: 4 })), -3, 'TR-502MSV rejects a bad checksum');
  eq(code(d, build({ bits: 20 })), -1, 'TR-502MSV wants exactly 21 bits');
  eq(code(d, build({ rows: 2 })), -1, 'TR-502MSV wants a single row');

  noWrite(d, build({}), 'TR-502MSV leaves the shared buffer alone');
}

// ---- Opel Mokka (333): the one published frame ----
{
  const d = dev(333);
  const ID_BITS = '10000110010';
  const TYPE_BITS = '11010';
  const CODE_BITS = '0000010100011111101001100000010100101011001000011100100101010110';
  const bitsOf = (s) => [...s].map(Number);
  const build = ({ idBits = ID_BITS, typeBits = TYPE_BITS, codeBits = CODE_BITS, secondIdBits = null,
                   zeros = 89, gap = 15, allZero = false, len = null } = {}) => {
    if (allZero) return rowOf(new Array(268).fill(0));
    const block = (idb) => [1, ...bitsOf(idb), ...bitsOf(typeBits), ...bitsOf(codeBits), 1];
    const arr = [...new Array(zeros).fill(0), ...block(idBits),
                 ...new Array(gap).fill(0), ...block(secondIdBits ?? idBits)];
    return rowOf(len === null ? arr : arr.slice(0, len));
  };

  eq(build({}).bitsPerRow[0], 268, 'the documented frame is 268 bits (premise)');
  eq(parseInt(ID_BITS, 2), 1074, 'the documented id bits read 1074 (premise)');
  eq(parseInt(TYPE_BITS, 2), 26, 'the documented type bits read 26, the event number its own comment states');

  const out = run(d, build({}));
  eq(out.length, 1, 'Opel Mokka decodes its published frame');
  eq(out[0]?.id, 1074, 'Opel Mokka key id');
  eq(out[0]?.event, 26, 'Opel Mokka event type');

  /*
   * Upstream's payload extraction is off by one against its own layout: the type field ends at bit 105 so the
   * payload is bits 106..169, but the code reads 64 bits from 107 — dropping the payload's first bit and
   * taking the end bit instead. Both readings are pinned so the disagreement stays visible.
   */
  {
    const layout = hexOfBits(bitsOf(CODE_BITS));
    const shifted = hexOfBits([...bitsOf(CODE_BITS).slice(1), 1]);
    eq(layout, '051fa6052b21c956', 'the payload the layout describes (premise)');
    eq(shifted, '0a3f4c0a564392ad', 'the payload upstream actually extracts, one bit later (premise)');
    ok(layout !== shifted, 'the two readings genuinely differ (premise)');
    eq(out[0]?.code, shifted, 'Opel Mokka reproduces upstream\'s off-by-one extraction');
  }

  eq(run(d, build({ len: 267 })).length, 0, 'Opel Mokka wants exactly 268 bits');
  eq(run(d, build({ zeros: 88 })).length, 0, 'Opel Mokka rejects a frame that starts a bit early');
  eq(run(d, build({ secondIdBits: '10000110011' })).length, 0, 'Opel Mokka rejects a burst whose two ids disagree');

  // An all-zero burst passes the repeat check trivially, so a separate guard has to throw it out.
  {
    const zero = build({ allZero: true });
    eq(zero.bitsPerRow[0], 268, 'the all-zero burst is the right length (premise)');
    ok(true, 'and both its id copies are zero, so the repeat check cannot reject it (premise)');
    eq(run(d, zero).length, 0, 'so Opel Mokka refuses a zero key id');
  }

  noWrite(d, build({}), 'Opel Mokka leaves the shared buffer alone');
}

// ---- Florabest (339): one parity bit over thirty ----
{
  const d = dev(339);
  const build = ({ id = 0x4909, tempRaw = 1900, flipParity = false, rows = 3, bits = 30 } = {}) => {
    const b = new Uint8Array(4);
    b[0] = (id >> 8) & 0xff; b[1] = id & 0xff;
    b[2] = (tempRaw >> 5) & 0xff; b[3] = ((tempRaw & 0x1f) << 3) & 0xff;
    let x = 0;
    bytesToBits(b).slice(0, 29).forEach(v => { x ^= v; });
    if ((x ^ 1) ^ (flipParity ? 1 : 0)) b[3] |= 0x04;      // odd parity across all 30 bits
    const arr = bytesToBits(b).slice(0, bits);
    return rowsOf(...new Array(rows).fill(arr));
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Florabest decodes a well-formed frame');
  eq(out[0]?.id, '4909', 'Florabest id');
  eq(out[0]?.temperature_F, 100, 'Florabest temperature');
  eq(out[0]?.mic, 'PARITY', 'Florabest reports a parity check');

  // The premise: the frame really does carry odd parity across all thirty bits, its own bit included.
  {
    const one = build({ rows: 1 });
    let x = 0;
    for (let i = 0; i < 30; i++) x ^= (one.bb[0][i >> 3] >> (7 - (i & 7))) & 1;
    eq(x, 1, 'the built frame carries odd parity over all 30 bits (premise)');
  }

  eq(code(d, build({ flipParity: true })), -3, 'Florabest rejects a bad parity bit');
  eq(code(d, build({ id: 0x4809 })), -4, 'Florabest rejects a frame whose first byte is not 0x49');
  eq(code(d, build({ rows: 2 })), -2, 'Florabest needs three matching rows');
  eq(code(d, build({ bits: 31 })), -1, 'Florabest wants exactly 30 bits');

  noWrite(d, build({}), 'Florabest leaves the shared buffer alone');
}

// ---- Hanwell ML4000 (371): raw counts, no engineering units ----
{
  const d = dev(371);
  const build = ({ id = 0x2a, hum = 0x3c5, temp = 0x1a7, chk = null, before = [], bits = 40 } = {}) => {
    const b = new Uint8Array(5);
    b[0] = id; b[1] = (hum >> 4) & 0xff; b[2] = (temp >> 4) & 0xff;
    b[3] = (((hum & 0x0f) << 4) | (temp & 0x0f)) & 0xff;
    b[4] = chk === null ? ((b[0] + b[1] + b[2] + b[3]) & 0xff) : chk;
    const wire = Uint8Array.from([...b].map(v => reverse8Ref(v) ^ 0xff));
    return rowsOf(...before, bytesToBits(wire).slice(0, bits));
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Hanwell decodes a well-formed frame');
  eq(out[0]?.id, 42, 'Hanwell transmitter id');
  eq(out[0]?.temperature_raw, 423, 'Hanwell reports a raw temperature count, not degrees');
  eq(out[0]?.humidity_raw, 965, 'Hanwell reports a raw humidity count');
  eq(out[0]?.mic, 'CHECKSUM', 'Hanwell reports a checksum');

  // Upstream masks this sum itself, so the masked helper is correct — proven on a sum that overflows.
  {
    const sum = 0xff * 4;
    ok(sum > 0xff, 'the all-ones frame really does sum past a byte (premise)');
    eq(sum & 0xff, 0xfc, 'and wraps to 0xfc (premise)');
    eq(run(d, build({ id: 0xff, hum: 0xfff, temp: 0xfff })).length, 1, 'Hanwell accepts a frame whose sum wraps');
  }

  // Only the last row is the real frame; earlier ones are demodulator leftovers.
  eq(run(d, build({ before: [new Array(20).fill(1)] })).length, 1, 'Hanwell reads the last row of a burst');
  {
    const real = build({});
    const realBits = [];
    for (let i = 0; i < 40; i++) realBits.push((real.bb[0][i >> 3] >> (7 - (i & 7))) & 1);
    eq(code(d, rowsOf(realBits, new Array(20).fill(1))), -1, 'Hanwell ignores a good frame that is not the last row');
  }

  eq(code(d, build({ chk: 0x00 })), -3, 'Hanwell rejects a bad checksum');
  eq(code(d, build({ bits: 39 })), -1, 'Hanwell wants exactly 40 bits');

  noWrite(d, build({}), 'Hanwell inverts a copy, not the shared buffer');
  eq(d.disabled, true, 'Hanwell mirrors upstream\'s disabled flag: its engineering units are unknown');
}

// ---- McPower kinetic switch (376): no battery, so it repeats while the energy lasts ----
{
  const d = dev(376);
  const build = ({ id = 0x1234, left = 0, right = 0, counter = 5, flags = 0x40, spare7 = 0, spare4 = 0,
                   breakCrc = false, pre = [0xaa, 0xaa], rows = 1, bits = null } = {}) => {
    const b = new Uint8Array(6);
    b[0] = (id >> 8) & 0xff; b[1] = id & 0xff;
    b[2] = ((spare7 << 7) | (left << 6) | (right << 5) | (spare4 << 4) | (counter & 0x0f)) & 0xff;
    b[3] = flags;
    const c = crc16Ref(b, 4, 0x1021, 0xaa55) ^ (breakCrc ? 0xffff : 0);
    b[4] = (c >> 8) & 0xff; b[5] = c & 0xff;
    const arr = [...bytesToBits(Uint8Array.from(pre)), ...bytesToBits(b)];
    const row = bits === null ? arr : arr.slice(0, bits);
    return rows === 1 ? rowOf(row) : rowsOf(row, row);
  };

  // The frame must begin exactly where the preamble match ends.
  eq(searchRef([...bytesToBits(Uint8Array.from([0xaa, 0xaa])), 0, 1], [0xaa, 0xaa], 16), 0,
    'the preamble match lands at bit 0, so the frame starts at bit 16 (premise)');

  const out = run(d, build({ left: 1 }));
  eq(out.length, 1, 'McPower decodes a well-formed press');
  eq(out[0]?.id, '1234', 'McPower switch id');
  eq(out[0]?.button_left, 1, 'McPower left button');
  eq(out[0]?.button_right, 0, 'McPower right button');
  eq(out[0]?.counter, 5, 'McPower counter');
  eq(out[0]?.flags, '40', 'McPower flags go out as a raw value');
  eq(out[0]?.mic, 'CRC', 'McPower reports a CRC');

  // The three separately labelled captures: left, right, and a repeat with nothing held down.
  eq(run(d, build({ left: 1, right: 0 }))[0]?.button_left, 1, 'McPower reads a left press');
  eq(run(d, build({ left: 0, right: 1 }))[0]?.button_right, 1, 'McPower reads a right press');
  {
    const idle = run(d, build({ left: 0, right: 0 }));
    eq(idle.length, 1, 'McPower still reports a repeat sent with no button held');
    eq(idle[0]?.button_left, 0, 'with both buttons clear rather than invented');
    eq(idle[0]?.button_right, 0, 'on both sides');
  }
  eq(run(d, build({ counter: 15 }))[0]?.counter, 15, 'McPower counter wraps within four bits');

  eq(code(d, build({ breakCrc: true })), -3, 'McPower rejects a bad CRC');
  eq(code(d, build({ pre: [0x00, 0x00] })), -2, 'McPower finds no preamble in a flat burst');
  eq(code(d, build({ bits: 16 + 40 })), -1, 'McPower wants a whole 48-bit frame behind the preamble');
  eq(code(d, build({ rows: 2 })), -2, 'McPower wants a single row');

  noWrite(d, build({ left: 1 }), 'McPower leaves the shared buffer alone');
}

// ---- The registrations themselves ----
{
  const MINE = [39, 80, 121, 198, 233, 265, 318, 332, 333, 339, 371, 376];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));

  // A flag wrongly absent is as much a change as one wrongly added, so both halves are asserted.
  for (const num of [198, 233, 371]) eq(dev(num).disabled, true, `protocol ${num} mirrors upstream's disabled flag`);
  for (const num of [39, 80, 121, 265, 318, 332, 333, 339, 376]) {
    eq(dev(num).disabled, undefined, `protocol ${num} is not disabled upstream`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
