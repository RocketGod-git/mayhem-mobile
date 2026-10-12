/**
 * Alarm, motion and door/window sensors, plus the meat thermometer and the wildlife tag that came with them.
 *
 * Only two of the nine publish anything captured off the air. SimpliSafe Gen 3 ships five real codes, and all
 * five are used here — their CRC-16 is recomputed by an implementation written from the polynomial rather than
 * imported, because an unverified checksum is the trap that has cost this project time before. The Amazon
 * thermometer ships one decoded byte row, and it turns out to prove more than it looks: its `55 aa aa` "sync
 * pattern" is nothing but the Manchester coding of the frame's own last twelve bits, which is why the decoder
 * steps back exactly seventy-two bits from it. That is asserted directly rather than assumed.
 *
 * Everything else is built from the transmit side: the bytes laid out as the sensor sends them, inverted or
 * Manchester coded as the device does it, with parities and checksums computed here from their definitions.
 *
 * Six of the nine have no checksum at all, so their only integrity check is that the sensor repeated itself.
 * That makes the repeat counts the thing most worth testing, and each one is tested from both sides: the frame
 * decodes at the required count and is refused one copy below it, with the premise asserted so the refusal
 * cannot pass for the wrong reason.
 *
 * Rejections are checked by return code, not merely by silence — a frame refused for a bad parity (-3) and one
 * refused as nonsense (-4) are different claims, and Honeywell's ordering of those two checks is asserted with
 * a frame that would give the other answer if the order were swapped.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
/** Both halves of a decode: what it emitted, and the code it returned saying why it did or did not. */
const run = (d, bb) => { const out = []; const rc = d.decode(d, bb, { emit: x => out.push(x) }); return { out, rc }; };

const ABORT_LENGTH = -1, ABORT_EARLY = -2, FAIL_MIC = -3, FAIL_SANITY = -4;

// ---- Building blocks, written from the definitions rather than imported from the code under test ----
const rev8 = (x) => { let r = 0; for (let i = 0; i < 8; i++) if ((x >> i) & 1) r |= 0x80 >> i; return r; };
const crc16Ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[i] << 8; for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff; }
  return r;
};
const crc8Ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[i]; for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff; }
  return r;
};
/** Parity the plain way — count the set bits — so it shares nothing with the decoder's nibble folding. */
const countBits = (bytes, n = bytes.length) => { let c = 0; for (let i = 0; i < n; i++) for (let k = 0; k < 8; k++) c += (bytes[i] >> k) & 1; return c; };

const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/[^0-9a-fA-F]/g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const bytesToBits = (bytes) => { const bits = []; for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); return bits; };
const hexOf = (b, n = b.length) => [...b.slice(0, n)].map(x => x.toString(16).padStart(2, '0')).join('');
const bytesFromHex = (h) => Uint8Array.from(h.replace(/[^0-9a-fA-F]/g, '').match(/../g).map(x => parseInt(x, 16)));
/** Our Manchester decoder emits the second half of each pair, so a one goes out as (0,1). */
const manchester = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };
const invertBits = (bits) => bits.map(x => x ^ 1);

const rowsOf = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
const rowOf = (bits) => rowsOf([bits]);
const repeat = (bits, n) => rowsOf(Array.from({ length: n }, () => bits));

console.log('Alarm, motion and door/window sensors, a meat thermometer and a wildlife tag');

// ---------------------------------------------------------------------------
// Kerui PIR / contact sensor (68)
// ---------------------------------------------------------------------------
{
  const d = dev(68);

  /** The sensor transmits the complement, so the wanted bytes are laid out and then inverted. */
  const keruiBits = ({ id = 0x9a2b3, cmd = 0xa, tail = [0], rawBytes = null } = {}) => {
    const want = Uint8Array.from([(id >> 12) & 0xff, (id >> 4) & 0xff, ((id & 0x0f) << 4) | cmd]);
    const air = rawBytes ?? Uint8Array.from(want, x => (~x) & 0xff);
    return [...bytesToBits(air), ...tail];
  };
  const buf = (opts, rows = 9) => repeat(keruiBits(opts), rows);

  {
    const { out, rc } = run(d, buf({}));
    eq(rc, 1, 'Kerui decodes a nine-times-repeated frame');
    eq(out[0]?.id, 0x9a2b3, 'Kerui twenty-bit identity');
    eq(out[0]?.cmd, 0xa, 'Kerui raw command nibble');
    eq(out[0]?.state, 'motion', 'Kerui state name');
    eq(out[0]?.motion, 1, 'Kerui reports motion');
    eq(out[0]?.model, 'Kerui-Security', 'Kerui model name');
    ok(!('mic' in out[0]), 'Kerui claims no integrity check, because it has none');
  }

  // The repeat count is the whole defence, so both sides of it are pinned.
  eq(run(d, buf({}, 9)).rc, 1, 'nine copies is enough (premise for the count below)');
  eq(run(d, buf({}, 8)).rc, ABORT_LENGTH, 'Kerui refuses a frame repeated only eight times');
  eq(run(d, buf({}, 8)).out.length, 0, 'and emits nothing when it does');

  // Every documented command, and the single field each one is entitled to report.
  const cmdCase = (cmd, state, field, value) => {
    const { out, rc } = run(d, buf({ cmd }));
    eq(rc, 1, `Kerui decodes command 0x${cmd.toString(16)}`);
    eq(out[0]?.state, state, `Kerui command 0x${cmd.toString(16)} is "${state}"`);
    eq(out[0]?.[field], value, `Kerui command 0x${cmd.toString(16)} sets ${field}=${value}`);
  };
  cmdCase(0xa, 'motion', 'motion', 1);
  cmdCase(0xe, 'open', 'opened', 1);
  cmdCase(0x7, 'close', 'opened', 0);
  cmdCase(0xb, 'tamper', 'tamper', 1);
  cmdCase(0x5, 'water', 'water', 1);
  cmdCase(0xf, 'battery', 'battery_ok', 0);

  // A closed contact must genuinely carry opened=0, not merely omit the field.
  ok('opened' in run(d, buf({ cmd: 0x7 })).out[0], 'Kerui "close" reports opened explicitly rather than omitting it');
  ok(!('motion' in run(d, buf({ cmd: 0xe })).out[0]), 'an "open" frame reports nothing about motion');
  ok(!('water' in run(d, buf({ cmd: 0xa })).out[0]), 'a "motion" frame reports nothing about water');

  // Codes upstream has never seen are refused rather than named.
  for (const cmd of [0x0, 0x1, 0x2, 0x3, 0x4, 0x6, 0x8, 0x9, 0xc, 0xd]) {
    eq(run(d, buf({ cmd })).rc, ABORT_EARLY, `Kerui refuses the undocumented command 0x${cmd.toString(16)}`);
  }

  // All ones on the air, which is all zeroes before the inversion.
  {
    const { out, rc } = run(d, buf({ rawBytes: Uint8Array.from([0, 0, 0]) }));
    eq(rc, FAIL_SANITY, 'Kerui rejects an all-zero payload as nonsense');
    eq(out.length, 0, 'and emits nothing');
  }

  // Length, from both directions.
  eq(run(d, repeat(keruiBits({ tail: [] }), 9)).rc, ABORT_LENGTH, 'Kerui refuses a twenty-four bit row');
  eq(run(d, repeat(keruiBits({ tail: [0, 1] }), 9)).rc, ABORT_LENGTH, 'Kerui refuses a twenty-six bit row');
  eq(run(d, repeat(keruiBits({ tail: [1] }), 9)).rc, 1, 'the twenty-fifth bit is carried but never read (premise)');
  eq(run(d, repeat(keruiBits({ tail: [1] }), 9)).out[0]?.id, 0x9a2b3, 'and does not disturb the identity');
}

// ---------------------------------------------------------------------------
// Generic wireless motion sensor (87)
// ---------------------------------------------------------------------------
{
  const d = dev(87);
  const gmBits = (code) => bytesToBits(Uint8Array.from([(code >> 12) & 0xff, (code >> 4) & 0xff, (code & 0x0f) << 4])).slice(0, 20);
  const buf = (code, rows = 3) => repeat(gmBits(code), rows);

  // The codes upstream reports having observed. None is given a meaning here, and that is the point.
  for (const [code, note] of [[0x80042, 'arm'], [0x80002, 'disarm'], [0x80008, 'ping'], [0x800a2, 'motion'],
    [0x800c2, 'motion'], [0x800e2, 'motion']]) {
    const { out, rc } = run(d, buf(code));
    eq(rc, 1, `Generic-Motion decodes the observed ${note} code`);
    eq(out[0]?.code, code.toString(16).padStart(5, '0'), `and reports it raw as ${code.toString(16)}`);
  }
  ok(!('event' in run(d, buf(0x800a2)).out[0]), 'no meaning is invented for an undocumented command set');
  eq(run(d, buf(0x800a2)).out[0]?.model, 'Generic-Motion', 'Generic-Motion model name');

  eq(run(d, buf(0x800a2, 3)).rc, 1, 'three copies is enough (premise)');
  eq(run(d, buf(0x800a2, 2)).rc, ABORT_EARLY, 'Generic-Motion refuses a frame repeated only twice');

  // The two degenerate payloads noise produces most often.
  {
    const zero = gmBits(0x80000);
    const b = Uint8Array.from([0x80, 0x00, 0x00]);
    eq(b[1], 0, 'the rejected frame really does carry a zero second byte (premise)');
    eq(b[2], 0, 'and a zero third byte (premise)');
    eq(run(d, repeat(zero, 3)).rc, ABORT_EARLY, 'Generic-Motion rejects an empty payload');
  }
  {
    const ones = gmBits(0x80fff);
    eq((0x80fff >> 4) & 0xff, 0xff, 'the rejected frame really does carry 0xff (premise)');
    eq((0x80fff & 0x0f) << 4, 0xf0, 'and 0xf0 (premise)');
    eq(run(d, repeat(ones, 3)).rc, ABORT_EARLY, 'Generic-Motion rejects an all-ones payload');
  }

  eq(run(d, repeat(gmBits(0x800a2).slice(0, 19), 3)).rc, ABORT_EARLY, 'Generic-Motion refuses a nineteen bit row');
  eq(run(d, repeat([...gmBits(0x800a2), 0], 3)).rc, ABORT_EARLY, 'Generic-Motion refuses a twenty-one bit row');

  // A burst carrying junk alongside three good copies still yields the reading — the loop walks past the junk.
  {
    const good = gmBits(0x800a2);
    const junk = bitsFromHex('abcd', 19);
    const { out, rc } = run(d, rowsOf([junk, good, good, good]));
    eq(rc, 1, 'Generic-Motion finds three agreeing rows behind a malformed one');
    eq(out[0]?.code, '800a2', 'and reads them correctly');
  }
}

// ---------------------------------------------------------------------------
// X10 Security (99)
// ---------------------------------------------------------------------------
{
  const d = dev(99);

  /** Lay out the frame the sensor sends and close it with the parity bit that makes the count even. */
  const x10Frame = (id0, code, id1, { breakSanity = false, breakParity = false } = {}) => {
    const b = new Uint8Array(6);
    b[0] = id0;
    b[1] = (id0 ^ 0x0f) ^ (breakSanity ? 0x01 : 0x00);
    b[2] = code;
    b[3] = code ^ 0xff;
    b[4] = id1;
    b[5] = (countBits(b, 5) & 1) ? 0x80 : 0x00;
    if (breakParity) b[5] ^= 0x80;
    return { b, bits: bytesToBits(b).slice(0, 41) };
  };
  /** Row zero is the sync burst the slicer hands over; only row one is read. */
  const buf = (...args) => { const f = x10Frame(...args); return { bb: rowsOf([[1, 1, 1, 1, 1, 1, 1, 1], f.bits]), b: f.b }; };

  const ID0 = 0x67, ID1 = 0x1f;

  {
    const { bb, b } = buf(ID0, 0x00, ID1);
    // The premise, counted rather than folded: the frame really does carry an even number of set bits.
    eq((countBits(b, 5) + ((b[5] >> 7) & 1)) & 1, 0, 'the well-formed frame really has even parity (premise)');
    const { out, rc } = run(d, bb);
    eq(rc, 1, 'X10 Security decodes a well-formed frame');
    eq(out[0]?.id, '671f', 'X10 identity is the two halves at either end of the frame');
    eq(out[0]?.code, '00', 'X10 raw code byte');
    eq(out[0]?.event, 'DOOR/WINDOW OPEN', 'X10 event name');
    eq(out[0]?.delay, 1, 'X10 delay setting: the bit clear means the maximum');
    eq(out[0]?.mic, 'CRC', 'X10 mirrors upstream\'s "CRC" label even though the check is a parity bit');
    ok(!('tamper' in out[0]), 'no tamper is reported when the bit is clear');
    ok(!('battery_ok' in out[0]), 'no battery field is reported when the battery is fine');
  }

  const ev = (code) => run(d, buf(ID0, code, ID1).bb);
  const evCase = (code, event, extra = {}) => {
    const { out, rc } = ev(code);
    eq(rc, 1, `X10 decodes code 0x${code.toString(16)}`);
    eq(out[0]?.event, event, `X10 code 0x${code.toString(16)} is "${event}"`);
    for (const [k, v] of Object.entries(extra)) eq(out[0]?.[k], v, `  and ${k}=${v}`);
  };
  evCase(0x00, 'DOOR/WINDOW OPEN', { delay: 1 });
  evCase(0x04, 'DOOR/WINDOW OPEN');
  evCase(0x40, 'DOOR/WINDOW OPEN', { tamper: 1, delay: 1 });
  evCase(0x44, 'DOOR/WINDOW OPEN', { tamper: 1 });
  evCase(0x80, 'DOOR/WINDOW CLOSED', { delay: 1 });
  evCase(0x84, 'DOOR/WINDOW CLOSED');
  evCase(0xc0, 'DOOR/WINDOW CLOSED', { tamper: 1, delay: 1 });
  evCase(0xc4, 'DOOR/WINDOW CLOSED', { tamper: 1 });
  evCase(0x0c, 'MOTION TRIPPED');
  evCase(0x4c, 'MOTION TRIPPED', { tamper: 1 });
  evCase(0x8c, 'MOTION READY');
  evCase(0xcc, 'MOTION READY', { tamper: 1 });
  evCase(0x06, 'KEY-FOB ARM');
  evCase(0x26, 'KR18 PANIC');
  evCase(0x42, 'KEY-FOB LIGHTS A ON');
  evCase(0x46, 'KEY-FOB LIGHTS B ON');
  evCase(0x82, 'SH624 SEC-REMOTE DISARM');
  evCase(0x86, 'KEY-FOB DISARM');
  evCase(0x88, 'KR15 PANIC');
  evCase(0x98, 'KR15 PANIC-3SECOND');
  evCase(0xc2, 'KEY-FOB LIGHTS A OFF');
  evCase(0xc6, 'KEY-FOB LIGHTS B OFF');

  // The delay bit only means anything on a door or window code, and the tamper bit only on those and motion.
  ok(!('delay' in ev(0x04).out[0]), 'the delay bit set means the minimum, so nothing is reported');
  ok(!('delay' in ev(0x06).out[0]), 'a keyfob code carries no delay setting');
  ok(!('tamper' in ev(0x06).out[0]), 'a keyfob code carries no tamper bit');
  {
    // 0x50 is unknown and has bit 6 set: read as a tamper flag it would falsely report tampering.
    const { out, rc } = ev(0x50);
    eq(rc, 1, 'an unrecognized code still decodes');
    eq(out[0]?.event, 'UNKNOWN', 'and is reported as UNKNOWN rather than guessed at');
    eq(out[0]?.code, '50', 'with the raw code alongside so it can be looked up');
    eq((0x50 & 0x40) >> 6, 1, 'that code really does have bit 6 set (premise)');
    ok(!('tamper' in out[0]), 'yet no tamper is claimed, because bit 6 is not a tamper flag on this code');
  }

  // The battery bit rides in the low bit of the code, below the event lookup.
  {
    const { out } = ev(0x01);
    eq(out[0]?.event, 'DOOR/WINDOW OPEN', 'the battery bit is masked off before the event is looked up');
    eq(out[0]?.battery_ok, 0, 'and a low battery is reported');
    eq(out[0]?.code, '01', 'while the code still shows it');
  }

  // Each rejection, distinguished by which one fired.
  {
    const { bb, b } = buf(ID0, 0x00, ID1, { breakParity: true });
    eq((countBits(b, 5) + ((b[5] >> 7) & 1)) & 1, 1, 'the corrupted frame really has odd parity (premise)');
    const { out, rc } = run(d, bb);
    eq(rc, FAIL_MIC, 'X10 rejects a frame whose parity does not come out even');
    eq(out.length, 0, 'and emits nothing');
  }
  {
    const { bb, b } = buf(ID0, 0x00, ID1, { breakSanity: true });
    ok((b[0] ^ b[1]) !== 0x0f, 'the broken frame really does violate the complement rule (premise)');
    eq(run(d, bb).rc, FAIL_SANITY, 'X10 rejects a frame whose first two bytes do not complement');
  }
  {
    const f = x10Frame(ID0, 0x00, ID1);
    const bad = [...f.bits];
    bad[16] ^= 1;                                    // inside b[2], which the decoder reads
    ok(bad.join('') !== f.bits.join(''), 'the corrupted bits really do differ (premise)');
    eq(run(d, rowsOf([[1, 1, 1, 1, 1, 1, 1, 1], bad])).rc, FAIL_SANITY, 'flipping a code bit breaks the complement rule first');
  }

  {
    const f = x10Frame(ID0, 0x00, ID1);
    eq(run(d, rowOf(f.bits)).rc, ABORT_EARLY, 'X10 needs both rows: one alone is refused');
    eq(run(d, rowsOf([[1], f.bits, f.bits])).rc, ABORT_EARLY, 'and three rows are refused too');
    eq(run(d, rowsOf([[1, 1, 1, 1, 1, 1, 1, 1], f.bits.slice(0, 40)])).rc, ABORT_LENGTH, 'X10 refuses a forty bit message');
  }
}

// ---------------------------------------------------------------------------
// SimpliSafe, first generation (102)
// ---------------------------------------------------------------------------
{
  const d = dev(102);
  const ID = [0x41, 0x42, 0x31, 0x32, 0x43];        // "AB12C"

  /**
   * The whole frame is inverted on the air, so the wanted bytes are laid out and then complemented — but only
   * across the bits the row actually carries, which is what the decoder's inversion does too.
   */
  const ssBits = ({ type = 0x88, idCodes = ID, b8 = 0, b9 = 0, b10 = 0, b11 = 0, nbits = 92,
    sync0 = 0xcc, sync1 = 0x5f } = {}) => {
    const post = new Uint8Array(12);
    post[0] = sync0 ^ 0xff; post[1] = sync1 ^ 0xff; post[2] = type;
    for (let k = 0; k < 5; k++) post[3 + k] = rev8(idCodes[k]);
    post[8] = b8; post[9] = b9; post[10] = b10; post[11] = b11;
    return invertBits(bytesToBits(post).slice(0, nbits));
  };
  const buf = (opts, rows = 2) => repeat(ssBits(opts), rows);

  // ---- Sensor messages, the only type with a checksum ----
  const sensor = ({ seq = 0x11, state = 1, badCsum = false, ...rest } = {}, rows = 2) => {
    const csum = (seq + state) & 0xff;
    return buf({ type: 0x88, b8: rev8(seq), b9: rev8(state), b10: rev8(badCsum ? (csum ^ 0xff) : csum), ...rest }, rows);
  };

  {
    const { out, rc } = run(d, sensor({ seq: 0x11, state: 1 }));
    eq(rc, 1, 'SimpliSafe decodes a sensor message');
    eq(out[0]?.model, 'SimpliSafe-Sensor', 'SimpliSafe sensor model name');
    eq(out[0]?.id, 'AB12C', 'SimpliSafe identity reads as text once each byte is turned around');
    eq(out[0]?.seq, 0x11, 'SimpliSafe sequence number, turned around');
    eq(out[0]?.state, 1, 'SimpliSafe state');
    eq(out[0]?.extradata, 'Contact Open', 'SimpliSafe names state 1');
    eq(out[0]?.mic, 'CHECKSUM', 'the sensor message carries a checksum and says so');
  }
  eq(run(d, sensor({ state: 2 })).out[0]?.extradata, 'Contact Closed', 'SimpliSafe names state 2');
  eq(run(d, sensor({ state: 3 })).out[0]?.extradata, 'Alarm Off', 'SimpliSafe names state 3');
  eq(run(d, sensor({ state: 9 })).out[0]?.extradata, '', 'an unnamed state gets no text rather than a guess');
  eq(run(d, sensor({ state: 9 })).out[0]?.state, 9, 'but the raw state is still reported');

  // The sequence number really is bit-reversed here, which matters for the keypad comparison further down.
  {
    const { out } = run(d, sensor({ seq: 0x5c, state: 2 }));
    ok(rev8(0x5c) !== 0x5c, '0x5c is not a bit-reversal palindrome (premise)');
    eq(out[0]?.seq, 0x5c, 'the sensor parser turns the sequence byte around');
  }

  {
    const { out, rc } = run(d, sensor({ badCsum: true }));
    eq(rc, FAIL_MIC, 'SimpliSafe rejects a sensor message whose checksum is wrong');
    eq(out.length, 0, 'and emits nothing');
  }
  // The checksum is a plain sum, so a frame that wraps past 255 still has to add up.
  {
    const { out, rc } = run(d, sensor({ seq: 0xf0, state: 0x20 }));
    eq((0xf0 + 0x20) & 0xff, 0x10, 'that sequence and state really do wrap past a byte (premise)');
    eq(rc, 1, 'SimpliSafe accepts a checksum that wrapped');
    eq(out[0]?.seq, 0xf0, 'and reads the sequence back');
  }

  eq(run(d, sensor({ nbits: 92 })).rc, 1, 'ninety-two bits is the sensor length (premise)');
  eq(run(d, sensor({ nbits: 90 })).rc, ABORT_LENGTH, 'SimpliSafe refuses a ninety bit sensor message');
  eq(run(d, sensor({}, 1)).rc, ABORT_EARLY, 'SimpliSafe needs two agreeing rows');
  eq(run(d, repeat(ssBits({ type: 0x88 }), 1)).rc, ABORT_EARLY, 'a single row is refused before anything is read');
  eq(run(d, sensor({ sync0: 0xcd })).rc, ABORT_EARLY, 'SimpliSafe refuses a frame with the wrong sync word');
  eq(run(d, sensor({ sync1: 0x5e })).rc, ABORT_EARLY, 'both sync bytes are checked');
  eq(run(d, buf({ type: 0x11 })).rc, ABORT_EARLY, 'an unknown message type is refused rather than guessed at');

  // A byte that does not land on a printable character is replaced, not emitted.
  {
    const { out } = run(d, sensor({ idCodes: [0x41, 0x01, 0x31, 0x32, 0x43] }));
    eq(out[0]?.id, 'A?12C', 'an unprintable identity byte becomes a question mark');
  }

  // ---- Keypad PIN entry: no checksum, and the PIN in clear ----
  {
    // The digits arrive low nibble first, so 1234 is packed as 0x21 then 0x43.
    const bb = buf({ type: 0x66, b9: 0x5c, b10: rev8(0x21), b11: rev8(0x43), nbits: 96 });
    const { out, rc } = run(d, bb);
    eq(rc, 1, 'SimpliSafe decodes a keypad PIN entry');
    eq(out[0]?.model, 'SimpliSafe-Keypad', 'SimpliSafe keypad model name');
    eq(out[0]?.extradata, 'Disarm Pin: 1234', 'and reads the disarm PIN, which is sent in clear');
    eq(out[0]?.id, 'AB12C', 'with the same identity as a sensor message');
    ok(!('mic' in out[0]), 'the keypad message claims no integrity check, because it has none');

    /*
     * Upstream's own inconsistency, pinned rather than smoothed over: the sensor parser turns its sequence
     * byte around and this one does not. Both are reported as upstream reports them.
     */
    eq(out[0]?.seq, 0x5c, 'the PIN-entry parser reports the sequence byte unreversed');
    eq(run(d, sensor({ seq: rev8(0x5c) })).out[0]?.seq, rev8(0x5c), 'while the sensor parser reverses its own');
    ok(rev8(0x5c) !== 0x5c, 'so the two really do disagree about the same byte (premise)');
  }
  {
    const { out } = run(d, buf({ type: 0x66, b10: rev8(0x00), b11: rev8(0x00), nbits: 96 }));
    eq(out[0]?.extradata, 'Disarm Pin: 0000', 'an all-zero PIN reads back as four zeroes');
  }
  {
    const { out } = run(d, buf({ type: 0x66, b10: rev8(0x9f), b11: rev8(0xe7), nbits: 96 }));
    eq(out[0]?.extradata, 'Disarm Pin: f97e', 'the digits are hex nibbles, printed exactly as sent');
  }

  // ---- Keypad commands ----
  const keypadCase = (code, text) => {
    const { out, rc } = run(d, buf({ type: 0x44, b9: 0x5c, b10: code }));
    eq(rc, 1, `SimpliSafe decodes keypad command 0x${code.toString(16)}`);
    eq(out[0]?.extradata, text, `keypad 0x${code.toString(16)} is "${text}"`);
  };
  keypadCase(0x6a, 'Arm System - Away');
  keypadCase(0xca, 'Arm System - Home');
  keypadCase(0x3a, 'Arm System - Canceled');
  keypadCase(0x2a, 'Keypad Panic Button');
  keypadCase(0x86, 'Keypad Menu Button');
  keypadCase(0x99, 'Unknown Keypad: 99');
  eq(run(d, buf({ type: 0x44, b9: 0x5c, b10: 0x6a })).out[0]?.seq, 0x5c,
    'the keypad-command parser also reports the sequence byte unreversed');
  eq(run(d, buf({ type: 0x44, b10: 0x6a })).out[0]?.model, 'SimpliSafe-Keypad', 'keypad commands share the keypad model');
}

// ---------------------------------------------------------------------------
// Honeywell ActivLink (115 OOK, 116 FSK)
// ---------------------------------------------------------------------------
{
  const OOK = dev(115), FSK = dev(116);

  const hwFrame = ({ id = 0x9a2b3, type = 0x2, alert = 0, b5 = 0x00, breakParity = false, post = null } = {}) => {
    let p;
    if (post) { p = Uint8Array.from(post); }
    else {
      p = new Uint8Array(6);
      p[0] = (id >> 12) & 0xff;
      p[1] = (id >> 4) & 0xff;
      p[2] = (id & 0x0f) << 4;
      p[3] = (type & 0x07) << 4;
      p[4] = alert & 0x03;
      p[5] = b5 & 0xfe;
      p[5] |= countBits(p, 6) & 1;                   // bit zero makes the count of set bits even
    }
    if (breakParity) p[5] ^= 0x01;
    return { post: p, bits: invertBits(bytesToBits(p)) };
  };
  const buf = (opts, rows = 4) => repeat(hwFrame(opts).bits, rows);

  {
    const f = hwFrame({});
    eq(countBits(f.post, 6) & 1, 0, 'the well-formed frame really has an even number of set bits (premise)');
    const { out, rc } = run(OOK, buf({}));
    eq(rc, 1, 'ActivLink decodes a four-times-repeated frame');
    eq(out[0]?.model, 'Honeywell-ActivLink', 'ActivLink model name');
    eq(out[0]?.id, 0x9a2b3, 'ActivLink twenty-bit identity');
    eq(out[0]?.subtype, 'Doorbell', 'ActivLink device class');
    eq(out[0]?.alert, 'Normal', 'ActivLink alert level');
    eq(out[0]?.battery_ok, 1, 'ActivLink battery');
    eq(out[0]?.mic, 'PARITY', 'ActivLink integrity check is a parity bit and says so');
  }

  // The device class decides how the rest of the frame reads, so each one is checked.
  eq(run(OOK, buf({ type: 0x1 })).out[0]?.subtype, 'PIR-Motion', 'class 1 is a motion sensor');
  eq(run(OOK, buf({ type: 0x2 })).out[0]?.subtype, 'Doorbell', 'class 2 is a doorbell');
  eq(run(OOK, buf({ type: 0x5 })).out[0]?.subtype, 'Contact', 'class 5 is a door contact');
  for (const t of [0x0, 0x3, 0x4, 0x6, 0x7]) {
    eq(run(OOK, buf({ type: t })).out[0]?.subtype, 'Unknown', `class ${t} is not named`);
  }

  /*
   * The one bit with two jobs. On a doorbell it is the secret knock; on a contact sensor the same bit means
   * the case has been opened. Both readings of the identical bit are asserted, which is the only way to show
   * the class is really deciding it.
   */
  {
    const bell = run(OOK, buf({ type: 0x2, b5: 0x10 })).out[0];
    const contact = run(OOK, buf({ type: 0x5, b5: 0x10 })).out[0];
    eq(bell?.secret_knock, 1, 'on a doorbell the shared bit is the secret knock');
    eq(bell?.tampered, 0, 'and nothing is claimed about tampering');
    eq(contact?.secret_knock, 0, 'on a contact sensor the same bit is not a secret knock');
    eq(contact?.tampered, 1, 'it means the case has been opened');
    eq(run(OOK, buf({ type: 0x2, b5: 0x00 })).out[0]?.secret_knock, 0, 'the bit clear means no secret knock');
    eq(run(OOK, buf({ type: 0x5, b5: 0x00 })).out[0]?.tampered, 0, 'and no tampering');
  }

  // Open and closed are two bits, so the frame can say "neither", and that is reported rather than forced.
  eq(run(OOK, buf({ b5: 0x20 })).out[0]?.open, 1, 'opened alone reads as open');
  eq(run(OOK, buf({ b5: 0x40 })).out[0]?.open, 0, 'closed alone reads as closed');
  eq(run(OOK, buf({ b5: 0x60 })).out[0]?.open, -1, 'both bits set means the state is unknown, not open');
  eq(run(OOK, buf({ b5: 0x00 })).out[0]?.open, -1, 'and neither bit set likewise');

  for (const [a, name] of [[0, 'Normal'], [1, 'High'], [2, 'High'], [3, 'Full']]) {
    eq(run(OOK, buf({ alert: a })).out[0]?.alert, name, `alert ${a} is "${name}"`);
  }
  eq(run(OOK, buf({ b5: 0x02 })).out[0]?.battery_ok, 0, 'the low-battery bit is reported inverted');
  eq(run(OOK, buf({ b5: 0x08 })).out[0]?.relay, 1, 'the relay bit marks a retransmission');
  eq(run(OOK, buf({ b5: 0x00 })).out[0]?.relay, 0, 'and is clear otherwise');

  {
    const f = hwFrame({ breakParity: true });
    eq(countBits(f.post, 6) & 1, 1, 'the corrupted frame really has odd parity (premise)');
    const { out, rc } = run(OOK, buf({ breakParity: true }));
    eq(rc, FAIL_MIC, 'ActivLink rejects a frame whose parity is odd');
    eq(out.length, 0, 'and emits nothing');
  }

  /*
   * Upstream tests the blank-frame sanity rule before it enforces the parity, so a blank frame is reported as
   * nonsense rather than as a failed check. This frame has odd parity on purpose: if the two checks ran the
   * other way round the answer would be -3, so the code below pins the ordering, not just the outcome.
   */
  {
    const blank = hwFrame({ post: [0x00, 0x01, 0x00, 0x00, 0x00, 0x00] });
    eq(countBits(blank.post, 6) & 1, 1, 'the blank frame really has odd parity too (premise)');
    eq(run(OOK, repeat(blank.bits, 4)).rc, FAIL_SANITY, 'ActivLink calls a blank frame nonsense, not a parity failure');
  }
  {
    const full = hwFrame({ post: [0xff, 0x00, 0xff, 0x00, 0xff, 0xff] });
    eq(run(OOK, repeat(full.bits, 4)).rc, FAIL_SANITY, 'and an all-ones frame likewise');
  }
  // A frame that is blank only in the bytes the rule does not look at must still decode.
  {
    const partial = hwFrame({ id: 0x00003, type: 0x2, alert: 0, b5: 0x20 });
    eq(run(OOK, repeat(partial.bits, 4)).rc, 1, 'the sanity rule looks at bytes 0, 2, 4 and 5 only (premise)');
  }

  eq(run(OOK, buf({}, 4)).rc, 1, 'four copies is enough (premise)');
  eq(run(OOK, buf({}, 3)).rc, ABORT_EARLY, 'ActivLink refuses a frame repeated only three times');
  {
    const f = hwFrame({});
    eq(run(OOK, repeat([...f.bits, 0], 4)).rc, ABORT_LENGTH, 'ActivLink refuses a forty-nine bit row');
    eq(run(OOK, repeat(f.bits.slice(0, 47), 4)).rc, ABORT_EARLY, 'and a forty-seven bit row never reaches the length test');
  }

  // The two registrations share one decoder and must agree exactly.
  {
    const a = run(OOK, buf({ type: 0x5, b5: 0x30, alert: 3 })).out[0];
    const b = run(FSK, buf({ type: 0x5, b5: 0x30, alert: 3 })).out[0];
    eq(JSON.stringify(a), JSON.stringify(b), 'the OOK and FSK ActivLink decoders produce identical readings');
    eq(OOK.modulation, 6, 'protocol 115 is keyed on and off');
    eq(FSK.modulation, 17, 'protocol 116 is frequency shifted');
    eq(OOK.shortWidth, 175, 'ActivLink OOK short width');
    eq(OOK.longWidth, 340, 'ActivLink OOK long width');
    eq(OOK.resetLimit, 5000, 'ActivLink OOK reset limit');
    eq(FSK.shortWidth, 160, 'ActivLink FSK short width');
    eq(FSK.longWidth, 320, 'ActivLink FSK long width');
    eq(FSK.resetLimit, 560, 'ActivLink FSK reset limit');
    eq(OOK.syncWidth, 500, 'both carry a sync width of 500');
    eq(FSK.syncWidth, 500, 'both carry a sync width of 500');
  }
}

// ---------------------------------------------------------------------------
// Amazon Basics meat thermometer (181)
// ---------------------------------------------------------------------------
{
  const d = dev(181);
  const SYNC = new Uint8Array([0x55, 0xaa, 0xaa]);
  /** The sensor sends the complement of these bytes, Manchester coded. */
  const abmtBits = (bytes) => manchester(bytesToBits(Uint8Array.from(bytes, x => (~x) & 0xff)));
  const DOC = [0xe4, 0x00, 0xa3, 0x01, 0x40, 0xff];  // the one row upstream publishes

  /*
   * The premise the whole decoder rests on. `55 aa aa` is not a sync word the sensor prepends — it is what the
   * frame's own constant tail (four ones then eight zeroes, before inversion) looks like once Manchester
   * coded. That is why the decoder finds it and steps back seventy-two bits rather than forward.
   */
  {
    const bits = abmtBits(DOC);
    eq(bits.length, 96, 'the frame is ninety-six coded bits');
    eq(rowOf(bits).search(0, 0, SYNC, 24), 72, 'the "sync pattern" sits at bit 72 — it is the frame\'s own tail');
    eq(DOC[5], 0xff, 'the last byte is constant (premise)');
    eq(DOC[4] & 0x0f, 0x00, 'and the low nibble of the one before it (premise)');
  }

  {
    const { out, rc } = run(d, repeat(abmtBits(DOC), 4));
    eq(rc, 1, 'the thermometer decodes the row upstream publishes');
    eq(out[0]?.model, 'Basics-Meat', 'thermometer model name');
    eq(out[0]?.id, 228, 'thermometer identity, picked afresh at power-on');
    eq(out[0]?.temperature_C, 14, 'thermometer temperature from the published row');
    ok(!('mic' in out[0]), 'the thermometer claims no integrity check, because it has none');
  }

  // Three BCD digits across a byte and a half, so a reading needing all three is checked.
  {
    const { out } = run(d, repeat(abmtBits([0x7b, 0x00, 0xa3, 0x18, 0x70, 0xff]), 4));
    eq(out[0]?.id, 0x7b, 'a different power-on identity');
    eq(out[0]?.temperature_C, 187, 'a three-digit temperature uses both bytes');
  }
  eq(run(d, repeat(abmtBits([0x01, 0x00, 0xa3, 0x00, 0x00, 0xff]), 4)).out[0]?.temperature_C, 0,
    'a zero reading decodes as zero');
  eq(run(d, repeat(abmtBits([0x01, 0x00, 0xa3, 0x09, 0x90, 0xff]), 4)).out[0]?.temperature_C, 99,
    'the highest two-digit reading');

  eq(run(d, repeat(abmtBits(DOC), 4)).rc, 1, 'four copies is enough (premise)');
  eq(run(d, repeat(abmtBits(DOC), 3)).rc, ABORT_EARLY, 'the thermometer refuses a frame repeated only three times');

  // A match too early in the row leaves no frame in front of it.
  {
    const early = [...bitsFromHex('55aaaa'), ...abmtBits(DOC).slice(0, 72)];
    eq(early.length, 96, 'the early-sync row is the same length as a good one (premise)');
    eq(rowOf(early).search(0, 0, SYNC, 24), 0, 'and its sync really does sit at bit 0 (premise)');
    eq(run(d, repeat(early, 4)).rc, FAIL_SANITY, 'the thermometer refuses a sync with no frame in front of it');
  }
  {
    const none = Array(96).fill(0);
    eq(rowOf(none).search(0, 0, SYNC, 24), 96, 'a blank row contains no sync at all (premise)');
    eq(run(d, repeat(none, 4)).rc, FAIL_SANITY, 'and a row with no sync is refused');
  }
  {
    const long = [...abmtBits(DOC), ...Array(30).fill(0)];
    eq(long.length, 126, 'the over-long row really is longer than 120 bits (premise)');
    eq(run(d, repeat(long, 4)).rc, ABORT_LENGTH, 'the thermometer refuses a row longer than 120 bits');
  }
  {
    const short = abmtBits(DOC).slice(0, 89);
    eq(run(d, repeat(short, 4)).rc, ABORT_EARLY, 'and one shorter than the ninety it needs to repeat');
  }
}

// ---------------------------------------------------------------------------
// SimpliSafe Gen 3 (209): five real captures
// ---------------------------------------------------------------------------
{
  const d = dev(209);
  const EX = [
    '55555554985a8ef0b01004fa89af407800c32b888bff61098d3627bdd5d369ca1800000000',
    'd55555552616a3bc2c04013ea26bd01e0030cae222ffd842634d89ef7574da728600000000',
    'd55555552616a3bc2c04013ea26bd21e0103b1a07f861673b5d1c531fa0bcd269c00000000',
    '55555554985a8ef0b01004fa89af4878040ec681fe1859ced74714c7e82f349a7000000000',
    '55555554985a8ef0b01004fa89af4878040ec681fe1859ced74714c7e82f349a7000000000',
  ];

  const readings = EX.map(h => run(d, rowOf(bitsFromHex(h))));
  readings.forEach((r, i) => {
    eq(r.rc, 1, `SimpliSafe Gen 3 decodes published capture #${i}`);
    eq(r.out[0]?.model, 'SimpliSafe-Gen3', `capture #${i} model name`);
    eq(r.out[0]?.id, '009f5135', `capture #${i} comes from the same system`);
    eq(r.out[0]?.msg_type, '02', `capture #${i} is a sensor message`);
    eq(r.out[0]?.mic, 'CRC', `capture #${i} carries a CRC`);
  });

  eq(readings[0].out[0]?.ctr, '000fe8', 'capture #0 counter');
  eq(readings[0].out[0]?.cmac, '18657111', 'capture #0 authentication tag');
  eq(readings[0].out[0]?.encr, '7fec2131a6c4f7baba6d', 'capture #0 encrypted body, ten bytes for a length of 22');
  eq(readings[2].out[0]?.ctr, '000fe9', 'capture #2 counter has advanced by one');
  eq(readings[2].out[0]?.cmac, '81d8d03f', 'capture #2 authentication tag');
  eq(readings[2].out[0]?.encr, 'c30b39dae8e298fd05e6', 'capture #2 encrypted body');

  // The five captures are three transmissions caught at different bit alignments.
  ok(EX[0] !== EX[1], 'captures #0 and #1 are different bit strings (premise)');
  eq(JSON.stringify(readings[0].out[0]), JSON.stringify(readings[1].out[0]),
    'yet they decode to the same reading — the same message caught one bit over');
  eq(JSON.stringify(readings[2].out[0]), JSON.stringify(readings[3].out[0]),
    'as do captures #2 and #3');

  /*
   * The CRC recomputed here rather than taken on trust. It is enforced upstream, but a check nothing forces to
   * be right has shipped wrong before, so the parameters are confirmed against a real frame.
   */
  {
    const msg = bytesFromHex('1602009f5135e80f00186571117fec2131a6c4f7baba6d39430000');
    eq(msg[0], 0x16, 'the message declares a length of 22 (premise)');
    eq(crc16Ref(msg, 25, 0x8005, 0xffff), 0, 'CRC-16 poly 0x8005 init 0xffff over 25 bytes comes out zero');
    eq(crc16Ref(msg, 23, 0x8005, 0xffff), (msg[23] << 8) | msg[24], 'and over the 23 message bytes gives the two the frame carries');
  }

  // Corrupting a bit the decoder genuinely reads.
  {
    const good = bitsFromHex(EX[0]);
    const bad = [...good];
    bad[100] ^= 1;                                   // inside the message body, well before the row ends
    ok(good.join('') !== bad.join(''), 'the corrupted capture really does differ (premise)');
    eq(run(d, rowOf(good)).rc, 1, 'the untouched capture decodes (premise)');
    const { out, rc } = run(d, rowOf(bad));
    eq(rc, FAIL_MIC, 'SimpliSafe Gen 3 rejects a frame whose CRC fails');
    eq(out.length, 0, 'and emits nothing');
  }

  /*
   * The length byte is validated before the CRC, because it decides how many bytes the CRC covers. A frame
   * with an unknown length is refused early (-2), not as a checksum failure (-3), and the difference is the
   * assertion.
   */
  {
    const b = bytesFromHex('1702009f5135e80f00186571117fec2131a6c4f7baba6d39430000');
    const row = bitsFromHex('930b51de' + hexOf(b));
    eq(b[0], 0x17, 'the frame declares an unknown length of 23 (premise)');
    eq(run(d, rowOf(row)).rc, ABORT_EARLY, 'an unknown length byte is refused before the CRC is even computed');
  }

  /*
   * A shorter message type built from the transmit side, because every published capture is a `16 02` sensor
   * message even though the file documents an arm (`15 01`) and a disarm (`18 01`) as well.
   */
  {
    const b = new Uint8Array(24);
    b.set(bytesFromHex('150100abcdef112233445566778899aabbccddeeff'), 0);
    const crc = crc16Ref(b, 22, 0x8005, 0xffff);
    b[22] = crc >> 8; b[23] = crc & 0xff;
    eq(crc16Ref(b, 24, 0x8005, 0xffff), 0, 'the built frame checks out against its own CRC (premise)');

    const { out, rc } = run(d, rowOf(bitsFromHex('930b51de' + hexOf(b))));
    eq(rc, 1, 'a length-21 arming message decodes');
    eq(out[0]?.msg_type, '01', 'and is reported as message type 01');
    eq(out[0]?.encr.length, 18, 'with a nine-byte body, three shorter than a sensor message');
    eq(out[0]?.id, '00abcdef', 'and its identity read from the same place');
  }
  {
    const b = new Uint8Array(27);
    b.set(bytesFromHex('180100abcdef112233445566778899aabbccddeeff00112233'), 0);
    const crc = crc16Ref(b, 25, 0x8005, 0xffff);
    b[25] = crc >> 8; b[26] = crc & 0xff;
    const { out, rc } = run(d, rowOf(bitsFromHex('930b51de' + hexOf(b))));
    eq(rc, 1, 'a length-24 disarming message decodes');
    eq(out[0]?.encr.length, 24, 'with the longest body, twelve bytes');
  }

  eq(run(d, rowOf(bitsFromHex('55555555555555555555555555555555555555555555555555555555'))).rc, ABORT_EARLY,
    'a row with no preamble is refused');
  eq(run(d, rowOf(bitsFromHex('930b51de160200'))).rc, ABORT_LENGTH,
    'a row too short to hold a message is refused on length');
}

// ---------------------------------------------------------------------------
// CTT LifeTag / PowerTag / HybridTag (320)
// ---------------------------------------------------------------------------
{
  const d = dev(320);
  const DOC_ID = Uint8Array.from([0x78, 0x55, 0x4c, 0x33]);

  const cttBits = (idBytes, { badCrc = false, preamble = 'aaaaaa', tail = '' } = {}) => {
    const crc = crc8Ref(idBytes, 4, 0x07, 0x00) ^ (badCrc ? 0xff : 0x00);
    return bitsFromHex(preamble + 'd391' + hexOf(idBytes) + crc.toString(16).padStart(2, '0') + tail);
  };

  // The documented frame, with its CRC confirmed independently first.
  eq(crc8Ref(DOC_ID, 4, 0x07, 0x00), 0x58, 'SMBus CRC-8 over 78 55 4c 33 is the 0x58 the documented frame carries');
  {
    const { out, rc } = run(d, rowOf(cttBits(DOC_ID)));
    eq(rc, 1, 'the tag decodes its documented frame');
    eq(out[0]?.model, 'CTT-Tag', 'CTT model name');
    eq(out[0]?.id, 0x78554c33, 'CTT tag identifier');
    eq(out[0]?.valid_motus, 1, 'every byte is in the Motus dictionary, so the tag is registered');
    eq(out[0]?.mic, 'CRC', 'CTT integrity check');
  }

  // A tag whose bytes are not all from the dictionary is still a good decode, just not a Motus tag.
  {
    const other = Uint8Array.from([0x78, 0x55, 0x4c, 0x01]);
    ok(!([0x00, 0x07, 0x19, 0x1e, 0x2a, 0x2d, 0x33, 0x34, 0x4b, 0x4c, 0x52, 0x55, 0x61, 0x66, 0x78, 0x7f,
      0x80, 0x87, 0x99, 0x9e, 0xaa, 0xad, 0xb3, 0xb4, 0xcb, 0xcc, 0xd2, 0xd5, 0xe1, 0xe6, 0xf8, 0xff].includes(0x01)),
      '0x01 is not a Motus code (premise)');
    const { out, rc } = run(d, rowOf(cttBits(other)));
    eq(rc, 1, 'a non-Motus tag still decodes');
    eq(out[0]?.valid_motus, 0, 'and is marked as not registered rather than rejected');
    eq(out[0]?.id, 0x78554c01, 'with its identifier read the same way');
  }

  // The return code carries information: which of "nothing here" and "something broken" happened.
  {
    const { out, rc } = run(d, rowOf(cttBits(DOC_ID, { badCrc: true })));
    eq(rc, FAIL_MIC, 'a frame with a bad CRC is reported as damaged, not as absent');
    eq(out.length, 0, 'and nothing is emitted from it');
  }
  {
    const good = cttBits(DOC_ID);
    const { out, rc } = run(d, rowsOf([good, good]));
    eq(rc, 2, 'two beeps in one burst give two readings');
    eq(out.length, 2, 'and both are emitted');
  }
  {
    // A damaged frame alongside a good one: the good one wins and the count is what is returned.
    const { out, rc } = run(d, rowsOf([cttBits(DOC_ID, { badCrc: true }), cttBits(DOC_ID)]));
    eq(rc, 1, 'one good beep outranks a damaged one in the same burst');
    eq(out.length, 1, 'and only the good one is reported');
  }
  {
    const short = bitsFromHex('d39178554c3358').slice(0, 55);
    ok(short.length < 56, 'the short row really is under the 56-bit minimum (premise)');
    eq(run(d, rowOf(short)).rc, 0, 'a row too short to hold a frame is passed over silently');
  }
  {
    const noSync = bitsFromHex('aaaaaaaaaaaaaaaaaaaa');
    eq(rowOf(noSync).search(0, 0, new Uint8Array([0xd3, 0x91]), 16), noSync.length,
      'a run of 0xaa really contains no sync word (premise)');
    eq(run(d, rowOf(noSync)).rc, 0, 'and a row without one is passed over silently');
  }
  {
    // Sync present, but too near the end for the payload that should follow it.
    const truncated = bitsFromHex('aaaaaaaad3911122');
    ok(truncated.length >= 56, 'the truncated row is long enough to be considered (premise)');
    eq(rowOf(truncated).search(0, 0, new Uint8Array([0xd3, 0x91]), 16), 32, 'and its sync really is found (premise)');
    eq(run(d, rowOf(truncated)).rc, 0, 'but a frame cut off after its sync is passed over');
  }
}

// ---------------------------------------------------------------------------
// The registrations themselves
// ---------------------------------------------------------------------------
{
  const MINE = [68, 87, 99, 102, 115, 116, 181, 209, 320];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));

  /*
   * None of these nine is switched off upstream, and that is a fact worth holding: the flag marks a reading as
   * doubtful in this app, so adding one where rtl_433 has none would quietly discredit a working sensor, and
   * dropping one where rtl_433 has it would do the reverse.
   */
  for (const num of MINE) ok(!dev(num).disabled, `protocol ${num} is enabled, as it is upstream`);

  // Timings, spot-checked against the rtl_433 device tables.
  eq(dev(68).modulation, 6, 'Kerui is pulse width keyed on and off');
  eq(dev(68).tolerance, 160, 'Kerui timing tolerance');
  eq(dev(87).longWidth, (1332 + 1784) / 2, 'Generic-Motion averages its two long widths');
  eq(dev(87).syncWidth, 1784 + 670, 'Generic-Motion sync width');
  eq(dev(99).modulation, 5, 'X10 Security is pulse position keyed');
  eq(dev(102).modulation, 11, 'SimpliSafe uses the clocked level coding');
  eq(dev(181).modulation, 4, 'the thermometer is a plain level-per-bit protocol');
  eq(dev(209).modulation, 16, 'SimpliSafe Gen 3 is frequency shifted');
  eq(dev(209).shortWidth, 208, 'SimpliSafe Gen 3 runs at 4800 baud');
  eq(dev(320).modulation, 16, 'the CTT tag is frequency shifted');
  eq(dev(320).shortWidth, 40, 'the CTT tag runs at 25 kbps');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
