/**
 * WEC-2103, the Homelead soil probe, the WallarGe thermometer and two cooking thermometers.
 *
 * Only Homelead publishes radio, and what it publishes is mislabeled: its two example rows are presented as
 * one capture shown raw and inverted, but they are not bit-inverses of each other and carry different sensor
 * ids. Both independently satisfy the device's own checksum, so they are two separate transmissions. Both are
 * asserted here, along with the fact that they are not one frame — so the discrepancy stays visible.
 *
 * The rest are built from the transmit side, with every checksum computed by an implementation written from
 * its definition rather than imported from the code under test. Two upstream defects are pinned rather than
 * corrected: WEC-2103's battery flag, which its own mask and shift make unreachable, and the WallarGe battery
 * field, which upstream only emits when the battery is flat and therefore only ever reports zero.
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
const crc4Ref = (m, n, poly, init) => {
  let rem = (init << 4) & 0xff;
  const p = (poly << 4) & 0xff;
  for (let i = 0; i < n; i++) {
    rem ^= m[i];
    for (let b = 0; b < 8; b++) rem = (rem & 0x80) ? (((rem << 1) ^ p) & 0xff) : ((rem << 1) & 0xff);
  }
  return (rem >> 4) & 0x0f;
};
const parityRef = (b) => { let n = 0; for (let i = 0; i < 8; i++) if ((b >> i) & 1) n++; return n & 1; };

const hexToBytes = (h) => Uint8Array.from(h.replace(/[^0-9a-fA-F]/g, '').match(/../g).map(x => parseInt(x, 16)));
const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const bitsToBytes = (bits) => { const o = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { if (b) o[i >> 3] |= 0x80 >> (i & 7); }); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const rowsOf = (...arrs) => { const bb = new BitBuffer(); arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); }); return bb; };

console.log('WEC-2103, Homelead soil probe, WallarGe, Esun and EN2058');

// ---- WEC-2103 (229): a checksum computed over a deliberately mangled frame ----
{
  const d = dev(229);
  /**
   * The CRC is taken after the checksum nibble is replaced by the low nibble of the last byte, and the result
   * is exclusive-ored with that byte's high nibble. Building a frame means doing the same thing forwards.
   */
  const build = ({ id = 0xf2, flags = 0x0, b2 = 0x6b, b3 = 0x59, b4 = 0x61, breakCrc = false,
                   rows = 6, row2Bits = 42 } = {}) => {
    const mangled = Uint8Array.from([id, flags | ((b4 & 0x0f) << 4), b2, b3]);
    const crc = (crc4Ref(mangled, 4, 3, 0) ^ (b4 >> 4)) & 0x0f;
    const b1 = (((crc ^ (breakCrc ? 0x0f : 0)) << 4) | flags) & 0xff;
    const payload = bytesToBits(Uint8Array.from([id, b1, b2, b3, b4]));
    const junk = new Array(20).fill(0);
    const all = [junk, junk, new Array(row2Bits).fill(0), payload, junk, junk].slice(0, rows);
    return rowsOf(...all);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'WEC-2103 decodes a well-formed transmission');
  eq(out[0]?.id, 0xf2, 'WEC-2103 device id');
  eq(out[0]?.channel, 1, 'WEC-2103 channel');
  eq(out[0]?.temperature_F, 81.7, 'WEC-2103 temperature is Fahrenheit, offset by 900');
  eq(out[0]?.humidity, 96, 'WEC-2103 humidity spans two bytes');
  eq(out[0]?.button, 0, 'WEC-2103 button not pressed');
  eq(out[0]?.mic, 'CRC', 'WEC-2103 reports a CRC');

  eq(run(d, build({ flags: 0x08 }))[0]?.button, 1, 'WEC-2103 reports the transmit button');

  /*
   * The battery defect, pinned rather than fixed. Upstream masks bit two and shifts right by three, which
   * cannot produce a one for any byte value, so a flat battery is never reported. The premise is asserted
   * alongside the outcome: the bit really is set in this frame.
   */
  {
    const withBatteryBit = run(d, build({ flags: 0x04 }));
    eq(withBatteryBit[0]?.flags & 0x04, 0x04, 'the low-battery bit really is set in the frame (premise)');
    eq((0x04 & 0x04) >> 3, 0, 'and upstream\'s mask-and-shift yields zero for it (premise)');
    eq(withBatteryBit[0]?.battery_ok, 1, 'so WEC-2103 reports the battery as fine regardless, as upstream does');
  }

  eq(run(d, build({ breakCrc: true })).length, 0, 'WEC-2103 rejects a bad CRC');
  eq(run(d, build({ rows: 5 })).length, 0, 'WEC-2103 wants exactly six rows');
  eq(run(d, build({ row2Bits: 40 })).length, 0, 'WEC-2103 checks the third row is 42 bits');
}

// ---- Homelead HG9901 (280): the two published rows, which are not one frame ----
{
  const d = dev(280);
  // Given as the bytes the decoder works with, after it turns the frame over.
  const FRAME_A = 'aa551172251 7b030'.replace(/ /g, '');   // the row the file labels "raw", inverted
  const FRAME_B = 'aa5513fd00163080';                       // the row the file labels "inverted"

  const wire = (hex) => [...inv(bytesToBits(hexToBytes(hex))), 0];   // 65th bit is unread padding

  {
    const out = run(d, rowOf(wire(FRAME_A)));
    eq(out.length, 1, 'Homelead decodes the first published row');
    eq(out[0]?.id, '1172', 'Homelead sensor id');
    eq(out[0]?.moisture, 37, 'Homelead soil moisture');
    eq(out[0]?.temperature_C, 23, 'Homelead temperature');
    eq(out[0]?.battery_pct, 100, 'Homelead battery percentage');
    eq(out[0]?.battery_ok, 1, 'Homelead battery is above its low mark');
    eq(out[0]?.sequence, 2, 'Homelead transmit-interval sequence');
    eq(out[0]?.light_lvl, 0, 'Homelead light level');
    eq(out[0]?.light_lux, 60, 'Homelead light level maps to an estimated lux figure');
  }
  {
    const out = run(d, rowOf(wire(FRAME_B)));
    eq(out.length, 1, 'Homelead decodes the second published row');
    eq(out[0]?.id, '13FD', 'the second row carries a different sensor id');
    eq(out[0]?.moisture, 0, 'Homelead soil moisture, second row');
    eq(out[0]?.temperature_C, 22, 'Homelead temperature, second row');
    eq(out[0]?.sequence, 0, 'Homelead sequence, second row');
  }

  /*
   * The file presents these as one capture shown raw and inverted. They are not: inverting the first does not
   * give the second, and the two carry different sensor ids. Both satisfy the device's own nibble checksum
   * independently, so both are real frames from different sensors and the labels are simply wrong.
   */
  {
    const a = hexToBytes(FRAME_A), b = hexToBytes(FRAME_B);
    ok(a[2] !== b[2] || a[3] !== b[3], 'the two rows carry different sensor ids (premise)');
    const sum = (x) => { let s = 0; for (let i = 0; i < 7; i++) s += (x[i] >> 4) + (x[i] & 0x0f); return s & 0x0f; };
    eq(sum(a), (a[7] & 0xf0) >> 4, 'the first row satisfies the checksum on its own');
    eq(sum(b), (b[7] & 0xf0) >> 4, 'and so does the second — they are two transmissions, not one');
  }

  // Rejections.
  {
    const bad = hexToBytes(FRAME_A); bad[4] ^= 0x10;   // change the moisture, breaking the nibble sum
    eq(run(d, rowOf([...inv(bytesToBits(bad)), 0])).length, 0, 'Homelead rejects a bad checksum');
  }
  eq(run(d, rowOf(inv(bytesToBits(hexToBytes(FRAME_A))).slice(0, 60))).length, 0,
    'Homelead refuses a row too short to hold a frame');
}

// ---- WallarGe CLTX001 (292): a byte sum and an inverted parity byte ----
{
  const d = dev(292);
  const build = ({ id = 0x1234, channel = 0, temp = 235, batteryLow = 0, testMode = 0,
                   breakSum = false, breakParity = false, spareBits = 0, bits = 56 } = {}) => {
    const b = new Uint8Array(7);
    b[0] = (id >> 8) & 0xff; b[1] = id & 0xff;
    b[2] = 0x00;
    b[3] = (batteryLow << 7) | (testMode << 6) | ((channel & 3) << 4) | ((temp >> 8) & 0x0f);
    b[4] = temp & 0xff;
    let parity = 0;
    for (let i = 0; i < 5; i++) parity |= (1 - parityRef(b[i])) << (7 - i);
    b[5] = (parity | (spareBits & 0x07)) ^ (breakParity ? 0x80 : 0);
    let s = 0;
    for (let i = 0; i < 5; i++) s += b[i];
    b[6] = (s & 0xff) ^ (breakSum ? 0xff : 0);
    return rowOf(inv(bytesToBits(b)).slice(0, bits));    // the sensor keys the other way up
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'WallarGe decodes a well-formed frame');
  eq(out[0]?.id, 0x1234, 'WallarGe sensor id');
  eq(out[0]?.channel, 1, 'WallarGe channel is reported one-based');
  eq(out[0]?.temperature_C, 23.5, 'WallarGe temperature');
  eq(out[0]?.battery_ok, undefined, 'no battery field is claimed while the battery is fine');
  eq(out[0]?.test, undefined, 'and no test field while test mode is off');

  eq(run(d, build({ channel: 2 }))[0]?.channel, 3, 'WallarGe channel 3');
  eq(run(d, build({ temp: 4046 }))[0]?.temperature_C, -5, 'WallarGe sign-extends a negative temperature');
  eq(run(d, build({ batteryLow: 1 }))[0]?.battery_ok, 0, 'WallarGe reports the battery only when it is flat');
  eq(run(d, build({ testMode: 1 }))[0]?.test, 1, 'WallarGe reports test mode when it is on');

  eq(run(d, build({ breakSum: true })).length, 0, 'WallarGe rejects a bad byte sum');
  eq(run(d, build({ breakParity: true })).length, 0, 'WallarGe rejects a bad parity byte');
  // The three spare bits of the parity byte have to be zero, even with everything else intact.
  {
    const spare = build({ spareBits: 0x01 });
    eq(run(d, spare).length, 0, 'WallarGe rejects a parity byte whose spare bits are set');
  }
  eq(run(d, build({ bits: 48 })).length, 0, 'WallarGe ignores a row that is not 56 bits');
}

// ---- Esun EN2053 (341): a check byte holding a sum and four parity flags ----
{
  const d = dev(341);
  const build = ({ temp1 = 225, temp2 = 160, head = 0xc0, breakChk = false } = {}) => {
    const b = new Uint8Array(5);
    b[0] = head;
    b[1] = (temp1 >> 4) & 0xff;
    b[2] = ((temp1 & 0x0f) << 4) | ((temp2 >> 8) & 0x0f);
    b[3] = temp2 & 0xff;
    let chk = (b[0] + b[1] + b[2] + b[3]) & 0x07;
    for (let i = 0; i < 4; i++) chk |= (1 ^ parityRef(b[i])) << (4 + i);
    b[4] = chk ^ (breakChk ? 0xff : 0);
    const bits = bytesToBits(b);
    return rowsOf(bits, bits);                     // two matching repeats is the bar
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'Esun decodes a two-probe frame');
  eq(out[0]?.temperature_1_F, 225, 'Esun probe one, in Fahrenheit');
  eq(out[0]?.temperature_2_F, 160, 'Esun probe two');
  eq(out[0]?.mic, 'CHECKSUM', 'Esun reports a checksum');

  // A probe that is not plugged in reads a sentinel, and that channel is simply not reported.
  {
    const one = run(d, build({ temp1: 0xfd6 }));
    eq(one[0]?.temperature_1_F, undefined, 'Esun does not report a disconnected probe');
    eq(one[0]?.temperature_2_F, 160, 'while the other probe still reads');
    const both = run(d, build({ temp1: 0xfd6, temp2: 0xfd6 }));
    eq(both.length, 1, 'Esun still reports a frame with both probes unplugged');
    eq(both[0]?.temperature_1_F, undefined, 'with neither temperature claimed');
    eq(both[0]?.temperature_2_F, undefined, 'nor the second');
  }

  eq(run(d, build({ breakChk: true })).length, 0, 'Esun rejects a bad check byte');
  eq(run(d, build({ head: 0xc1 })).length, 0, 'Esun rejects a frame without its fixed leading byte');
  {
    const bits = bytesToBits(hexToBytes('c00e10a000'));
    eq(run(d, rowsOf(bits)).length, 0, 'Esun needs the frame repeated');
  }
}

// ---- EN2058 (346): nine repeats run together in one long row ----
{
  const d = dev(346);
  const build = ({ id = 0x0a1b2c, temps = [72.5, 165.0, 32.0, 200.0], seq = 0x08,
                   breakChk = false, repeats = 1, truncate = 0 } = {}) => {
    const one = () => {
      const pre = bytesToBits(Uint8Array.from([0xff, 0xfe, 0x00, 0x00])).slice(0, 30);
      const filler = Uint8Array.from([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xca, 0xca]);
      const idB = Uint8Array.from([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
      const tempB = new Uint8Array(8);
      temps.forEach((t, i) => {
        const raw = Math.round(t * 10) + 900;
        tempB[i * 2] = (raw >> 8) & 0xff; tempB[i * 2 + 1] = raw & 0xff;
      });
      let s = 0x56;
      for (const v of idB) s += v;
      for (const v of tempB) s += v;
      const chk = (s & 0xff) ^ (breakChk ? 0xff : 0);
      const tail = new Uint8Array(18);
      for (let i = 0; i < 18; i++) tail[i] = i;
      return [...pre, ...bytesToBits(filler), ...bytesToBits(idB), ...bytesToBits(tempB),
              ...bytesToBits(Uint8Array.from([0xaa, chk])), ...bytesToBits(tail),
              ...bytesToBits(Uint8Array.from([seq, seq]))];
    };
    let all = [];
    for (let i = 0; i < repeats; i++) all = all.concat(one());
    return rowOf(truncate ? all.slice(0, all.length - truncate) : all);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'EN2058 decodes a repeat out of one long row');
  eq(out[0]?.id, 0x0a1b2c, 'EN2058 device id');
  eq(out[0]?.temperature1_F, 72.5, 'EN2058 probe one');
  eq(out[0]?.temperature2_F, 165, 'EN2058 probe two');
  eq(out[0]?.temperature3_F, 32, 'EN2058 probe three');
  eq(out[0]?.temperature4_F, 200, 'EN2058 probe four');
  eq(out[0]?.sequence, 0x08, 'EN2058 sequence counter');
  eq(out[0]?.mic, 'CHECKSUM', 'EN2058 reports a checksum');

  // Because the repeats run together, a spoiled one costs nothing if a later one survives.
  eq(run(d, build({ breakChk: true })).length, 0, 'EN2058 rejects a repeat whose checksum fails');
  eq(run(d, build({ repeats: 2 })).length, 1, 'EN2058 reports one reading from two identical repeats');

  // A repeat cut short before its counter still yields a reading, without inventing one.
  {
    const short = run(d, build({ truncate: 40 }));
    eq(short.length, 1, 'EN2058 still decodes a repeat truncated past its reading');
    eq(short[0]?.sequence, undefined, 'and claims no sequence counter it did not receive');
    eq(short[0]?.temperature1_F, 72.5, 'while the reading itself is unaffected');
  }

  eq(run(d, rowOf(new Array(160).fill(0))).length, 0, 'EN2058 refuses a burst too short to hold a frame');
  eq(run(d, rowOf(new Array(400).fill(0))).length, 0, 'EN2058 finds nothing in a burst with no run-in');
}

// ---- The registrations themselves ----
{
  for (const num of [229, 280, 292, 341, 346]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
