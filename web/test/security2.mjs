/**
 * Alarm and life-safety sensors.
 *
 * None of these six ships a capture, so every frame is built from the transmit side — which for this batch
 * means undoing rather a lot on the way out. Cavius needs its CRC appended so the whole frame checks to zero;
 * Kidde needs a differential Manchester encode; Risco needs the payload Gray coded, bit-reversed and then
 * differential Manchester coded, in that order.
 *
 * Risco's state byte is not chosen but searched for: the flags pass through a Gray code and a bit reversal
 * before the decoder reads them, so rather than derive a byte by hand and risk deriving it the same wrong way
 * twice, the test looks for bytes that produce a stated outcome and then checks the decoder reports it.
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
const rowsOf = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
/** Manchester for a decoder that inverts afterwards: the bit, then its complement. */
const mcInv = (bits) => { const out = []; for (const b of bits) out.push(b, b ^ 1); return out; };
/** Differential Manchester: the first half always flips, the bit says whether the level then holds. */
const dmc = (bits, prev = 0) => {
  const out = [];
  for (const b of bits) { const h1 = 1 - prev; const h2 = b ? h1 : 1 - h1; out.push(h1, h2); prev = h2; }
  return out;
};
const grayDecode = (n) => { let p = n; while ((n >>= 1)) p ^= n; return p; };

console.log('Alarm and life-safety sensors');

// ---- Visonic PowerCode (151): a check that runs down the nibbles, not along them ----
{
  const build = (id, flags, repeats = 3, breakCheck = false) => {
    const m = new Uint8Array(5);
    m[0] = (id >> 16) & 0xff; m[1] = (id >> 8) & 0xff; m[2] = id & 0xff;
    m[3] = flags;
    // The check nibble makes every nibble column cancel: c = high ^ low of the running exclusive-or.
    const x = m[0] ^ m[1] ^ m[2] ^ m[3];
    const c = ((x >> 4) ^ (x & 0x0f)) & 0x0f;
    m[4] = ((breakCheck ? c ^ 1 : c) << 4) & 0xff;
    const one = [1, ...bytesToBits(m).slice(0, 36)];
    return rowsOf(new Array(repeats).fill(0).map(() => one));
  };

  const d = run(dev(151), build(0x6f4770, 0x8c))[0];
  ok(!!d, 'Visonic decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Visonic-Powercode', '  Visonic model');
    eq(d.id, '6f4770', '  Visonic id');
    eq(d.tamper, 1, '  Visonic reports its case open');
    eq(d.alarm, 0, '  Visonic reports no alarm');
    eq(d.restore, 1, '  Visonic reports the sensor back to normal');
    eq(d.supervised, 1, '  Visonic reports this as a routine check-in');
    eq(d.battery_ok, 1, '  Visonic battery is healthy');
    eq(d.mic, 'CHECKSUM', '  Visonic reports its check');
  }

  // The magnet moving away sets a different flag, with the same identity.
  const away = run(dev(151), build(0x6f4770, 0xcc))[0];
  if (away) {
    eq(away.id, '6f4770', 'Visonic reports the same sensor when the magnet moves');
    eq(away.alarm, 1, '  and raises the alarm flag');
  }

  // A low battery.
  eq(run(dev(151), build(0x6f4770, 0xac))[0]?.battery_ok, 0, 'Visonic reports a low battery');

  ok(!run(dev(151), build(0x6f4770, 0x8c, 3, true))[0], '  Visonic rejects a frame failing its check');
  // One copy on its own is not enough; it must be said twice.
  ok(!run(dev(151), build(0x6f4770, 0x8c, 1))[0], '  Visonic refuses a frame sent only once');
  // An empty frame is the receiver, not a sensor.
  ok(!run(dev(151), build(0x000000, 0x00))[0], '  Visonic refuses an empty frame');
}

// ---- Yale HSA (210): one message across six packets ----
{
  const packet = (byte, eom) => [0, 1, 0, 1, eom ? 1 : 0, ...bytesToBits([byte])];
  const build = (id, stype, state, event, { badSync = false, badEom = false, badSum = false } = {}) => {
    const m = [(id >> 8) & 0xff, id & 0xff, stype, state, event, 0];
    let sum = 0;
    for (let i = 0; i < 5; i++) sum = (sum + m[i]) & 0xff;
    m[5] = (256 - sum) & 0xff;                     // all six bytes together must come to nothing
    if (badSum) m[5] = (m[5] + 1) & 0xff;
    const rows = m.map((v, i) => packet(v, badEom ? i === 4 : i === 5));
    if (badSync) rows[2][0] = 1;                   // break one packet's opening bits
    return rowsOf(rows);
  };

  const d = run(dev(210), build(0x1234, 0xac, 0x10, 0x01))[0];
  ok(!!d, 'Yale HSA decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Yale-HSA', '  Yale model');
    eq(d.id, '1234', '  Yale id');
    eq(d.stype, 'ac', '  Yale sensor type says a door or window contact');
    eq(d.event, '01', '  Yale event says it was triggered');
    eq(d.mic, 'CHECKSUM', '  Yale reports its check');
  }

  eq(run(dev(210), build(0x1234, 0x15, 0x30, 0x04))[0]?.stype, '15', 'Yale reads a motion detector');
  eq(run(dev(210), build(0x1234, 0x15, 0x30, 0x04))[0]?.event, '04', '  reporting it was tampered with');

  ok(!run(dev(210), build(0x1234, 0xac, 0x10, 0x01, { badSum: true }))[0],
    '  Yale rejects a message whose bytes do not cancel');
  ok(!run(dev(210), build(0x1234, 0xac, 0x10, 0x01, { badSync: true }))[0],
    '  Yale rejects a packet that does not open correctly');
  ok(!run(dev(210), build(0x1234, 0xac, 0x10, 0x01, { badEom: true }))[0],
    '  Yale rejects a message whose end flag is on the wrong packet');
}

// ---- Kidde smoke alarm (361): an identity, echoed, and nothing else ----
{
  const build = (id, { breakEcho = false, breakStart = false } = {}) => {
    const refl = U.reverse8(id);
    const echo = breakEcho ? (refl ^ 0x81) : (refl ^ 0x80);
    const msg = [breakStart ? 1 : 0, ...bytesToBits([refl, 0x7f, echo])];
    return rowBits(pad(dmc(msg), 80));
  };

  const d = run(dev(361), build(0x3b))[0];
  ok(!!d, 'Kidde decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Kidde-Smoke', '  Kidde model');
    eq(d.id, '3b', '  Kidde reports the DIP switches somebody set');
    ok(d.mic === undefined, '  Kidde claims no integrity check, having none worth the name');
  }

  // All four of the DIP-switch settings covered by real captures.
  for (const id of [0x00, 0x0f, 0xff, 0x3b]) {
    eq(run(dev(361), build(id))[0]?.id, id.toString(16).padStart(2, '0'), `Kidde reads switches ${id.toString(16)}`);
  }

  ok(!run(dev(361), build(0x3b, { breakEcho: true }))[0], '  Kidde refuses a frame whose echo disagrees');
  ok(!run(dev(361), build(0x3b, { breakStart: true }))[0], '  Kidde refuses a frame without its framing bit');
  ok(dev(361).disabled === true, '  Kidde is flagged doubtful, its echo not being a real check');
}

// ---- Cavius alarms (179): a CRC over identity and message together ----
{
  const build = (netId, senderId, message, { breakCrc = false } = {}) => {
    const b = new Uint8Array(11);
    b[0] = (netId >>> 24) & 0xff; b[1] = (netId >> 16) & 0xff;
    b[2] = (netId >> 8) & 0xff; b[3] = netId & 0xff;
    b[4] = message;
    b[5] = 0xff ^ message;                         // the message byte again, inverted
    b[6] = U.crc8le(b, 6, 0x31, 0x00);             // appending it makes the whole check to zero
    if (breakCrc) b[6] ^= 0x01;
    b[7] = (senderId >>> 24) & 0xff; b[8] = (senderId >> 16) & 0xff;
    b[9] = (senderId >> 8) & 0xff; b[10] = senderId & 0xff;
    return rowBits(pad([...bytesToBits([0x43, 0x61, 0x76, 0x69]), ...mcInv(bytesToBits(b))], 240));
  };

  const d = run(dev(179), build(0x11223344, 0xaabbccdd, 0x20))[0];
  ok(!!d, 'Cavius decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Cavius-Security', '  Cavius model');
    eq(d.id, 0xaabbccdd, '  Cavius reports which detector spoke');
    eq(d.net_id, 0x11223344, '  and which network it belongs to');
    eq(d.text, 'Fire alarm', '  Cavius names the message');
    eq(d.battery_ok, 1, '  Cavius battery is healthy');
    eq(d.mic, 'CRC', '  Cavius reports its check');
  }

  eq(run(dev(179), build(0x11223344, 0xaabbccdd, 0x10))[0]?.text, 'Warning/Water detected',
    'Cavius names a water warning');
  eq(run(dev(179), build(0x11223344, 0xaabbccdd, 0x40))[0]?.text, 'Test alarm', '  and a test');
  eq(run(dev(179), build(0x11223344, 0xaabbccdd, 0x04))[0]?.text, 'Alarm muted', '  and being muted');

  // The battery flag rides alongside the message rather than replacing it.
  const low = run(dev(179), build(0x11223344, 0xaabbccdd, 0x28))[0];
  if (low) {
    eq(low.battery_ok, 0, 'Cavius reports a low battery');
    eq(low.text, 'Fire alarm', '  while still naming the alarm it is raising');
  }

  ok(!run(dev(179), build(0x11223344, 0xaabbccdd, 0x20, { breakCrc: true }))[0],
    '  Cavius rejects a frame failing its CRC');
}

// ---- Cavius door sensor (368): a different protocol under the same name ----
{
  const build = (id, state, counter, { breakCrc = false } = {}) => {
    const b = new Uint8Array(9);
    b[0] = counter;
    for (let i = 0; i < 6; i++) b[1 + i] = (id[i]) & 0xff;
    b[7] = state;
    b[8] = U.crc8(b, 8, 0x07, 0x00);
    if (breakCrc) b[8] ^= 0x01;
    const pre = [0xaa, 0xaa, 0xaa, 0xd3, 0x15, 0x27];
    return rowBits(pad([...bytesToBits(pre), ...bytesToBits(b)], 160));
  };

  const id = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab];
  const d = run(dev(368), build(id, 0x25, 0x07))[0];
  ok(!!d, 'Cavius door sensor decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Cavius-Door', '  Cavius door model');
    eq(d.id, '0123456789ab', '  Cavius door identity is six bytes, not four');
    eq(d.state, 'open', '  Cavius door reports it is open');
    eq(d.counter, 7, '  Cavius door counter');
    eq(d.mic, 'CRC', '  Cavius door reports its check');
  }

  eq(run(dev(368), build(id, 0x24, 0x08))[0]?.state, 'closed', 'Cavius door reports it closed');
  // Anything but those two states means this was not one of these sensors.
  ok(!run(dev(368), build(id, 0x26, 0x07))[0], '  Cavius door refuses a state it does not have');
  ok(!run(dev(368), build(id, 0x25, 0x07, { breakCrc: true }))[0],
    '  Cavius door rejects a frame failing its CRC');
}

// ---- Risco Agility (266): Gray coded, bit reversed, then differential Manchester ----
{
  // The state flags are read after a bit reversal and a Gray decode, so the byte that produces a wanted
  // outcome is searched for rather than derived - deriving it by hand risks deriving it wrong the same way
  // the assertion would.
  const outcomeOf = (raw) => {
    const r = U.reverse8(raw);
    const state = grayDecode(r & 0x0f);
    return {
      tamper: (state & 0x04) >> 2,
      motion: (state & 0x02) >> 1,
      lowBatt: (grayDecode((r & 0xf0) >> 4) & 0x08) >> 3,
    };
  };
  const findByte = (want) => {
    for (let v = 0; v < 256; v++) {
      const o = outcomeOf(v);
      if (o.tamper === want.tamper && o.motion === want.motion && o.lowBatt === want.lowBatt) return v;
    }
    return -1;
  };

  const build = (stateByte, { breakCrc = false, badType = false } = {}) => {
    const b = new Uint8Array(16);
    b[0] = badType ? 0xfe : 0xff; b[1] = badType ? 0xf8 : 0x60;
    b[2] = 0x01; b[3] = 0xe1;
    b[4] = 0x9c; b[5] = 0xb6;                      // the counter, Gray coded
    b[6] = 0x01; b[7] = 0x74; b[8] = 0xfe;         // identity
    b[9] = 0x28; b[10] = 0x0c;
    b[11] = 0x60;
    b[12] = stateByte;
    b[13] = 0x00;
    const c = U.crc16(b, 14, 0x8005, 0x8181);
    b[14] = (c >> 8) & 0xff; b[15] = c & 0xff;
    if (breakCrc) b[15] ^= 0x01;
    return rowBits(pad([...bytesToBits([0x55, 0x5a]), ...dmc(bytesToBits(b))], 320));
  };

  const motionByte = findByte({ tamper: 0, motion: 1, lowBatt: 0 });
  const tamperByte = findByte({ tamper: 1, motion: 0, lowBatt: 0 });
  const battByte = findByte({ tamper: 0, motion: 0, lowBatt: 1 });
  ok(motionByte >= 0 && tamperByte >= 0 && battByte >= 0,
    'state bytes exist for motion, tamper and a low battery');

  const d = run(dev(266), build(motionByte))[0];
  ok(!!d, 'Risco decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Risco-RWX95P', '  Risco model');
    eq(d.motion, 1, '  Risco reports movement');
    ok(d.tamper === undefined, '  and does not claim its case was opened');
    eq(d.battery_ok, 1, '  Risco battery is healthy');
    eq(d.id, (0x01 << 16) | (0x74 << 8) | 0xfe, '  Risco identity, read before the reversal');
    eq(d.mic, 'CRC', '  Risco reports its check');
  }

  const t = run(dev(266), build(tamperByte))[0];
  if (t) {
    eq(t.tamper, 1, 'Risco reports its case being opened');
    ok(t.motion === undefined, '  without also claiming movement');
  }
  eq(run(dev(266), build(battByte))[0]?.battery_ok, 0, 'Risco reports a low battery');

  ok(!run(dev(266), build(motionByte, { breakCrc: true }))[0], '  Risco rejects a frame failing its CRC');
  // The longer frame this family also sends is deliberately left alone.
  ok(!run(dev(266), build(motionByte, { badType: true }))[0],
    '  Risco leaves alone the longer message nobody has decoded');
}

// ---- The registrations themselves ----
{
  for (const num of [151, 179, 210, 266, 361, 368]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
