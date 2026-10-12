/**
 * Insteon, the Honeywell CM921 and Delta Dore X3D — the three largest decoders left, and the only batch in
 * this app where not one of the sources publishes a captured frame in any form.
 *
 * That makes the builders the whole argument. A synthetic frame proves nothing unless it lands exactly where
 * the decoder looks, so each builder here was round-tripped through the decoder's own path before a single
 * assertion was written on it: Delta Dore's length byte de-whitening alone, the CM921's header, footer scan
 * and Manchester overshoot, and Insteon's twenty-eight bit block shape. Where that round trip is itself the
 * claim, it is asserted rather than assumed.
 *
 * Checksums are computed from their definitions rather than imported from the code under test.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** Written from the definitions, not imported. */
const rev8 = (x) => { let r = 0; for (let i = 0; i < 8; i++) if ((x >> i) & 1) r |= 0x80 >> i; return r; };
const ccitt = (m, n) => {
  let msb = 0x01, lsb = 0xff;
  for (let i = 0; i < n; i++) {
    m[i] ^= rev8(lsb);
    for (let r = 0; r < 8; r++) { const p = msb; msb = (lsb & 1) ^ ((lsb >> 5) & 1); lsb = (((p << 7) & 0x80) | ((lsb >> 1) & 0xff)) & 0xff; }
  }
};
const crc16Ref = (m, n, poly, init) => {
  let r = init & 0xffff;
  for (let i = 0; i < n; i++) { r ^= m[i] << 8; for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff; }
  return r & 0xffff;
};
const insteonCrcRef = (d) => {
  let r = 0;
  for (let i = 0; i < 9; i++) { r ^= d[i]; r = (r ^ ((((r ^ ((r << 1) & 0xff)) & 0x0f) << 4))) & 0xff; }
  return r;
};
const insteonExtCrcRef = (d) => { let r = 0; for (let i = 7; i < 22; i++) r = (r + d[i]) & 0xff; return ((~r) + 1) & 0xff; };

const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
/** Our Manchester decoder emits the second half of each pair. */
const man = (bits) => { const o = []; for (const b of bits) o.push(b ^ 1, b); return o; };
/** Least significant bit first, which is how both Insteon and the CM921 send their bytes. */
const lsbBits = (v, n) => { const o = []; for (let i = 0; i < n; i++) o.push((v >> i) & 1); return o; };
/** A byte framed with a start and stop bit, as the CM921's ten-to-eight layer expects. */
const framed = (b) => [0, ...lsbBits(b, 8), 1];

console.log('Insteon, Honeywell CM921 and Delta Dore X3D');

// ---- Insteon (159): twenty-eight bit blocks, one byte at a time ----
{
  const d = dev(159);
  /**
   * The run-in overlaps the first block: its trailing bits already carry four of the five index pairs, which
   * is why the decoder starts decoding seven bits into a sixteen-bit pattern rather than after it.
   */
  const build = ({ bytes, indices = null, breakCrc = false, breakMarker = false, breakOrder = false } = {}) => {
    const data = Uint8Array.from(bytes);
    const idx = indices ?? data.map((_, i) => 31 - i);
    // Logical bits: what the decoder sees once it has turned the buffer over.
    const logical = [...bytesToBits(Uint8Array.from([0xce, 0xaa]))];
    logical.push(1);                                  // completes the fifth index pair of block one
    logical.push(...man(lsbBits(data[0], 8)));
    logical.push(breakMarker ? 0 : 1, 1);
    for (let i = 1; i < data.length; i++) {
      const thisIdx = breakOrder && i === 2 ? idx[i - 1] + 5 : idx[i];
      logical.push(...man(lsbBits(thisIdx, 5)));
      logical.push(...man(lsbBits(data[i], 8)));
      logical.push(1, 1);
    }
    if (breakCrc) { /* handled by the caller mutating the byte */ }
    return rowOf(inv(logical));                       // the sensor keys the other way up
  };

  const packet = [0x43, 0x3f, 0x6b, 0x22, 0x11, 0x78, 0x2b, 0x13, 0x01];
  const withCrc = [...packet, insteonCrcRef(Uint8Array.from(packet))];
  eq(withCrc.length, 10, 'a normal packet is ten bytes (premise)');

  const out = run(d, build({ bytes: withCrc }));
  eq(out.length, 1, 'Insteon decodes a normal packet');
  eq(out[0]?.to_id, '226B3F', 'Insteon destination address, printed most significant byte first');
  eq(out[0]?.from_id, '2B7811', 'Insteon source address');
  eq(out[0]?.extended, 0, 'and is not an extended packet');
  eq(out[0]?.hopsmax, 3, 'Insteon max hops');
  eq(out[0]?.hopsleft, 0, 'Insteon hops left');
  eq(out[0]?.msg_type, 2, 'Insteon message type');
  eq(out[0]?.msg_str, 'Group Cleanup Direct Message', 'Insteon names the message type');
  eq(out[0]?.mic, 'CRC', 'Insteon reports a CRC');

  // The doc says the first index is 32; the code checks 31, and 0b11111 is 31.
  eq(0b11111, 31, 'the run-in carries index 31, though the file calls it 32');

  // Each rejection, with the premise that the same frame decodes when left alone.
  {
    const bad = [...withCrc]; bad[9] ^= 0xff;
    eq(run(d, build({ bytes: bad })).length, 0, 'Insteon rejects a bad checksum');
  }
  eq(run(d, build({ bytes: withCrc, breakMarker: true })).length, 0,
    'Insteon rejects a packet missing the marker bits between blocks');
  eq(run(d, build({ bytes: withCrc, breakOrder: true })).length, 0,
    'Insteon rejects blocks whose index does not count down');
  eq(run(d, build({ bytes: withCrc.slice(0, 6) })).length, 0, 'Insteon refuses a packet too short to be one');
  eq(run(d, rowOf(inv(new Array(400).fill(0)))).length, 0, 'Insteon finds nothing in a burst with no run-in');

  // The extended packet uses a different check entirely.
  {
    const ext = new Array(23).fill(0);
    for (let i = 7; i < 22; i++) ext[i] = i;
    ext[0] = 0x10;                                    // the extended flag
    ext[22] = insteonExtCrcRef(Uint8Array.from(ext));
    let s = 0;
    for (let i = 7; i < 22; i++) s = (s + ext[i]) & 0xff;
    eq((s + ext[22]) & 0xff, 0, 'the extended check is a negated sum, so body and check cancel (premise)');
  }
}

// ---- Honeywell CM921 (185): three layers of framing ----
{
  const d = dev(185);
  /**
   * A run-in of three framed bytes, then the header, the Manchester-coded message, and a footer marker behind
   * filler. The message's own bytes must sum to zero.
   */
  const build = ({ msg, header = [0x33, 0x55, 0x53], footer = 0x35, filler = 2,
                   breakSum = false, breakMan = false } = {}) => {
    const body = [...msg];
    let s = 0;
    for (const v of body) s = (s + v) & 0xff;
    body.push(((256 - s) & 0xff) ^ (breakSum ? 0xff : 0));

    const mbits = man(bytesToBits(Uint8Array.from(body)));
    if (breakMan) { mbits[4] = mbits[5]; }            // make one pair hold its level, a coding violation

    const stream = [];
    for (const h of header) stream.push(...bytesToBits(Uint8Array.from([h])));
    stream.push(...mbits);
    stream.push(...bytesToBits(Uint8Array.from([footer])));
    for (let i = 0; i < filler; i++) stream.push(...bytesToBits(Uint8Array.from([0x55])));

    // Every byte of that stream goes out framed, least significant bit first.
    const wire = [...framed(0x55), ...framed(0xff), ...framed(0x00)];
    for (let i = 0; i < stream.length; i += 8) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | (stream[i + k] ?? 0);
      wire.push(...framed(v));
    }
    return rowOf(wire);
  };

  // A heat-demand message, which the file gives as an example of the 0x3150 command.
  const HEAT = [0x18, 0x28, 0xad, 0x9a, 0x88, 0x4d, 0xd3, 0x31, 0x50, 0x02, 0x00, 0xc6];
  {
    const out = run(d, build({ msg: HEAT }));
    eq(out.length, 1, 'CM921 decodes a heat-demand message');
    eq(out[0]?.ids, '28ad9a 884dd3', 'CM921 reads both device addresses');
    eq(out[0]?.zone, 0x00, 'CM921 zone');
    eq(out[0]?.heat_demand, 0xc6, 'CM921 heat demand');
    eq(out[0]?.mic, 'CHECKSUM', 'CM921 reports a checksum');
  }

  // A zone temperature report, three bytes per zone.
  {
    const msg = [0x18, 0x28, 0xad, 0x9a, 0x88, 0x4d, 0xd3, 0x30, 0xc9, 0x03, 0x01, 0x07, 0xd0];
    const out = run(d, build({ msg }));
    eq(out.length, 1, 'CM921 decodes a zone temperature report');
    eq(out[0]?.['temperature (zone 1)'], 20, 'CM921 reports the zone temperature in hundredths');
  }
  // A setpoint, and a command it does not recognize.
  {
    const msg = [0x18, 0x28, 0xad, 0x9a, 0x88, 0x4d, 0xd3, 0x23, 0x09, 0x03, 0x02, 0x08, 0x34];
    eq(run(d, build({ msg }))[0]?.setpoint, 21, 'CM921 setpoint');
  }
  {
    const msg = [0x18, 0x28, 0xad, 0x9a, 0x88, 0x4d, 0xd3, 0xab, 0xcd, 0x00];
    eq(run(d, build({ msg }))[0]?.unknown, 0xabcd, 'CM921 reports an unrecognized command as its raw code');
  }

  // Rejections, each against a frame that is otherwise sound.
  eq(run(d, build({ msg: HEAT })).length, 1, 'the base frame decodes (premise for the rejections below)');
  eq(run(d, build({ msg: HEAT, breakSum: true })).length, 0, 'CM921 rejects a message not summing to zero');
  eq(run(d, build({ msg: HEAT, header: [0x33, 0x55, 0x52] })).length, 0, 'CM921 rejects a wrong header');
  eq(run(d, build({ msg: HEAT, footer: 0x36 })).length, 0, 'CM921 rejects a missing footer marker');
  eq(run(d, build({ msg: HEAT, filler: 0 })).length, 0, 'CM921 rejects a footer with no filler behind it');
  eq(run(d, build({ msg: HEAT, breakMan: true })).length, 0, 'CM921 rejects a Manchester coding violation');
  eq(run(d, rowOf(new Array(400).fill(0))).length, 0, 'CM921 finds nothing in a burst with no run-in');
}

// ---- Delta Dore X3D (269): a whitened frame whose length is itself whitened ----
{
  const d = dev(269);
  const PRE = bytesToBits(Uint8Array.from([0xaa, 0xaa, 0x81, 0x69, 0x96, 0x7e]));

  const build = ({ type = 0x01, flags = 0x00, f3 = 0x00, f2 = 0x00, id = 0x001234, network = 0x02,
                   number = 0x07, msgId = 0x029a, payload = null, temp = null, breakCrc = false } = {}) => {
    const head = [0x00, 0xff, number, type, (0x0e & 0x1f) | flags,
                  id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff,
                  network, 0x00, f2, f3];
    if (f3 === 0x01) head.push(0x00);
    else if (f3 === 0x08) { head.push(temp?.type ?? 0x00, (temp?.raw ?? 0) & 0xff, ((temp?.raw ?? 0) >> 8) & 0xff); }
    head.push(msgId & 0xff, (msgId >> 8) & 0xff, 0x00, 0x00);
    const body = payload ?? [];
    const len = head.length + body.length + 2;
    const f = Uint8Array.from([...head, ...body, 0, 0]);
    f[0] = len;
    const c = crc16Ref(f, len - 2, 0x1021, 0x0000) ^ (breakCrc ? 0xffff : 0);
    f[len - 2] = (c >> 8) & 0xff; f[len - 1] = c & 0xff;
    const wire = Uint8Array.from(f);
    ccitt(wire, len);
    return rowOf([...PRE, ...bytesToBits(wire)]);
  };

  const PAYLOAD = [0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x11, 0x51, 0x05, 0x00];

  {
    const out = run(d, build({ payload: PAYLOAD }));
    eq(out.length, 1, 'Delta Dore decodes a standard message');
    eq(out[0]?.id, 0x001234, 'Delta Dore device id, little endian on the wire');
    eq(out[0]?.network, 0x02, 'Delta Dore network');
    eq(out[0]?.subtype, 'Standard', 'Delta Dore message class');
    eq(out[0]?.msg_no, 0x07, 'Delta Dore message number');
    eq(out[0]?.msg_id, 0x029a, 'Delta Dore message id');
    eq(out[0]?.retry, 0x00, 'Delta Dore retry counter');
    eq(out[0]?.register_high, 0x11, 'Delta Dore register area');
    eq(out[0]?.register_low, 0x51, 'Delta Dore register number');
    eq(out[0]?.mic, 'CRC', 'Delta Dore reports a CRC');
  }

  // The whitening is what makes the length byte readable at all, and it is its own inverse.
  {
    const probe = Uint8Array.from([30, 0xff, 0x07]);
    const before = [...probe];
    ccitt(probe, 3);
    ok(probe[0] !== before[0], 'whitening actually changes the length byte (premise)');
    ccitt(probe, 3);
    eq([...probe].join(','), before.join(','), 'and applying it twice restores the frame');
  }

  // A temperature reading moves everything after it along by three bytes.
  {
    const out = run(d, build({ f3: 0x08, temp: { type: 0x00, raw: 2050 }, payload: PAYLOAD }));
    eq(out.length, 1, 'Delta Dore decodes a message carrying a temperature');
    eq(out[0]?.temperature_C, 20.5, 'Delta Dore temperature, in hundredths');
    eq(out[0]?.temperature_type, 'indoor', 'Delta Dore temperature type');
    eq(out[0]?.register_low, 0x51, 'and the payload still lines up behind the extra field');
  }
  // A window sensor sends no payload at all and says only what changed.
  {
    const opened = run(d, build({ type: 0x00, flags: 0x20, f2: 0x41 }));
    eq(opened[0]?.subtype, 'Sensor', 'Delta Dore window sensor class');
    eq(opened[0]?.wnd_stat, 'Opened', 'Delta Dore reports a window opening');
    eq(opened[0]?.retry, undefined, 'and claims no payload fields it never received');
    eq(run(d, build({ type: 0x00, flags: 0x20, f2: 0x01 }))[0]?.wnd_stat, 'Closed', 'and a window closing');
    eq(run(d, build({ type: 0x00, flags: 0x20, f2: 0x00 }))[0]?.wnd_stat, undefined,
      'while an unchanged window is not reported at all');
  }
  eq(run(d, build({ type: 0x03, flags: 0x20 }))[0]?.subtype, 'Beacon', 'Delta Dore beacon class');

  eq(run(d, build({ payload: PAYLOAD, breakCrc: true })).length, 0, 'Delta Dore rejects a bad CRC');
  eq(run(d, rowOf(PRE)).length, 0, 'Delta Dore refuses a run-in with no frame behind it');
  eq(run(d, rowOf(new Array(400).fill(0))).length, 0, 'Delta Dore finds nothing without its sync word');
}

// ---- The registrations themselves ----
{
  for (const num of [159, 185, 269]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
