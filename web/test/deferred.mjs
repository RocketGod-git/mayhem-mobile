/**
 * The last three: the DirecTV remote, the Vivint sensor, and the Silver Spring mesh endpoint.
 *
 * None of the three sources publishes a captured frame in any form, so every frame here is built from the
 * transmit side and each builder was round-tripped through the decoder's own path first. Two of those round
 * trips are themselves asserted, because they carry the weight the missing captures would have carried: the
 * differential run-length coding the remote uses, and the claim that recovering the mesh scrambler seed by
 * brute force is a real integrity check rather than a formality.
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
const crc16Ref = (m, n, poly, init) => {
  let r = init & 0xffff;
  for (let i = 0; i < n; i++) { r ^= m[i] << 8; for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff; }
  return r & 0xffff;
};
const crc32Ref = (d, len) => {
  let c = 0xffffffff;
  for (let i = 0; i < len; i++) { c = (c ^ (d[i] << 24)) >>> 0; for (let b = 0; b < 8; b++) c = (c & 0x80000000) ? (((c << 1) ^ 0x04c11db7) >>> 0) : ((c << 1) >>> 0); }
  return c >>> 0;
};
const scramble = (buf, len, seed) => {
  let reg = seed & 0xff;
  for (let i = 0; i < len; i++) {
    let k = 0;
    for (let b = 0; b < 8; b++) {
      k = ((k << 1) | ((reg >> 7) & 1)) & 0xff;
      let t = reg & 0x8e; t ^= t >> 4; t ^= t >> 2; t ^= t >> 1;
      reg = ((reg << 1) | (t & 1)) & 0xff;
    }
    buf[i] ^= k;
  }
};

const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };

console.log('DirecTV RC66RX, Vivint sensor and Silver Spring mesh');

// ---- DirecTV RC66RX (128): data carried in run lengths, not symbols ----
{
  const d = dev(128);
  /** A sync run, one marker run, then one run per bit — one symbol for a zero, two for a one. */
  const build = ({ nibbles, syncSymbols = 10, level = 0 } = {}) => {
    const logical = [];
    for (const n of nibbles) for (let k = 3; k >= 0; k--) logical.push((n >> k) & 1);
    const out = [];
    let lv = level;
    for (let i = 0; i < syncSymbols; i++) out.push(lv);
    lv ^= 1; out.push(lv);                          // the marker run after a sync is not data
    for (const b of logical) { lv ^= 1; for (let i = 0; i <= b; i++) out.push(lv); }
    lv ^= 1; out.push(lv);                          // a final transition so the last bit is written
    return rowOf(out);
  };
  /** Ten nibbles: a fixed model pair, five of identifier, two of button, then the check. */
  const frame = (id, button) => {
    const n = [0x1, 0x0, (id >> 16) & 0xf, (id >> 12) & 0xf, (id >> 8) & 0xf, (id >> 4) & 0xf, id & 0xf,
               (button >> 4) & 0xf, button & 0xf, 0];
    let s = 0;
    for (let i = 0; i < 9; i++) s += n[i];
    n[9] = s & 0x0f;
    return n;
  };

  {
    const out = run(d, build({ nibbles: frame(507610, 0x25) }));
    eq(out.length, 1, 'DirecTV decodes a button press');
    eq(out[0]?.id, 507610, 'DirecTV device identifier');
    eq(out[0]?.button_id, 0x25, 'DirecTV button code');
    eq(out[0]?.button_name, 'SELECT', 'DirecTV names the button');
    eq(out[0]?.event, 'INITIAL', 'a long run-in marks the first send of a message');
    eq(out[0]?.mic, 'CHECKSUM', 'DirecTV reports a checksum');
  }
  // The same message with a short run-in is a repeat of it.
  eq(run(d, build({ nibbles: frame(507610, 0x25), syncSymbols: 4 }))[0]?.event, 'REPEAT',
    'a short run-in marks a repeat');
  // The coding only looks at transitions, so an inverted signal decodes identically.
  eq(run(d, build({ nibbles: frame(507610, 0x25), level: 1 }))[0]?.id, 507610,
    'DirecTV decodes the same from an inverted signal');

  for (const [code, name] of [[0x10, 'PWR'], [0x21, 'UP'], [0x28, 'GUIDE'], [0xd6, 'SELECT RELEASE']]) {
    eq(run(d, build({ nibbles: frame(1234, code) }))[0]?.button_name, name, `DirecTV names button 0x${code.toString(16)}`);
  }
  eq(run(d, build({ nibbles: frame(1234, 0x99) }))[0]?.button_name, 'unknown',
    'DirecTV does not invent a name for a button it has not seen');

  // Rejections, each against a frame that is otherwise sound.
  {
    const bad = frame(507610, 0x25); bad[9] ^= 0x0f;
    eq(run(d, build({ nibbles: bad })).length, 0, 'DirecTV rejects a bad checksum');
  }
  {
    const bad = frame(507610, 0x25); bad[0] = 0x2;   // the model marker is always 0x10
    let s = 0;
    for (let i = 0; i < 9; i++) s += bad[i];
    bad[9] = s & 0x0f;                                // keep the checksum valid so only the marker rejects it
    eq(run(d, build({ nibbles: bad })).length, 0, 'DirecTV rejects a frame whose model marker is wrong');
  }
  {
    // The identifier field is wider than the printed range allows, so the bound is a real check.
    const big = frame(0xfffff, 0x25);
    let s = 0;
    for (let i = 0; i < 9; i++) s += big[i];
    eq(big[9], s & 0x0f, 'the over-range frame still satisfies its checksum (premise)');
    ok(0xfffff > 999999, 'and 0xfffff really is beyond the printed range (premise)');
    eq(run(d, build({ nibbles: big })).length, 0, 'DirecTV rejects an identifier past its printed range');
  }
  eq(run(d, rowOf(new Array(30).fill(0))).length, 0, 'DirecTV refuses a row too short to hold a message');
  eq(run(d, rowOf(new Array(200).fill(0))).length, 0, 'DirecTV refuses a row longer than the protocol allows');
}

// ---- Vivint door and window sensor (342) ----
{
  const d = dev(342);
  const build = ({ evt = 0x7a, counter = 0x0123, flags = 0x9c, id = 0x0137beda, top = 0x5,
                   breakCrc = false, bits = null } = {}) => {
    const b = new Uint8Array(10);
    b[0] = evt; b[1] = (counter >> 8) & 0xff; b[2] = counter & 0xff; b[3] = flags;
    b[4] = (id >>> 24) & 0xff; b[5] = (id >>> 16) & 0xff; b[6] = (id >>> 8) & 0xff; b[7] = id & 0xff;
    if (evt === 0xd0) {
      const c = crc16Ref(b, 8, 0x8050, 0) ^ (breakCrc ? 0xffff : 0);
      b[8] = (c >> 8) & 0xff; b[9] = c & 0xff;
    }
    else {
      b[8] = (top << 4) & 0xf0;
      const check12 = (crc16Ref(b, 9, 0x8050, 0) >> 4) ^ (breakCrc ? 0xfff : 0);
      b[8] = ((top << 4) & 0xf0) | ((check12 >> 8) & 0x0f);
      b[9] = check12 & 0xff;
    }
    // Eleven ones and a zero lead the frame; the sensor keys all of it the other way up.
    const logical = [...new Array(11).fill(1), 0, ...bytesToBits(b)];
    return rowOf(inv(bits === null ? logical : logical.slice(0, bits)));
  };

  {
    const out = run(d, build({}));
    eq(out.length, 1, 'Vivint decodes an ordinary frame');
    eq(out[0]?.id, '0019-0507610', 'Vivint prints the identifier as it appears on the sensor');
    eq(out[0]?.counter, 0x0123, 'Vivint transmission counter');
    eq(out[0]?.flags, 0x9c, 'Vivint status byte, reported as sent');
    eq(out[0]?.event_type, 0x7a, 'Vivint frame subtype');
    eq(out[0]?.mic, 'CRC', 'Vivint reports a CRC');
    // The status byte is encrypted under a seed that never goes over the air and cannot be supplied here.
    eq(out[0]?.state, undefined, 'Vivint claims no door state without the per-device seed');
    eq(out[0]?.contact_open, undefined, 'nor a contact reading');
    ok(out[0]?.data?.startsWith('7a01239c0137beda'),
      'and reports the payload as hex instead, carrying the frame exactly as sent');
    eq(out[0]?.data?.length, 20, 'covering all ten bytes of it');
  }
  // A startup beacon uses a plain checksum over the same bytes.
  {
    const out = run(d, build({ evt: 0xd0, counter: 0x0005, flags: 0x00 }));
    eq(out.length, 1, 'Vivint decodes a startup beacon');
    eq(out[0]?.event_type, 0xd0, 'and reports its subtype');
  }
  // The two schemes are genuinely different: a beacon checksum on an ordinary frame must not pass.
  {
    const b = new Uint8Array(10);
    b[0] = 0x7a; b[1] = 0x01; b[2] = 0x23; b[3] = 0x9c;
    b[4] = 0x01; b[5] = 0x37; b[6] = 0xbe; b[7] = 0xda;
    const plain = crc16Ref(b, 8, 0x8050, 0);
    b[8] = (plain >> 8) & 0xff; b[9] = plain & 0xff;
    const t = Uint8Array.from(b); t[8] = b[8] & 0xf0;
    ok((crc16Ref(t, 9, 0x8050, 0) >> 4) !== (((b[8] & 0x0f) << 8) | b[9]),
      'a plain checksum does not satisfy the packed twelve-bit check (premise)');
    const logical = [...new Array(11).fill(1), 0, ...bytesToBits(b)];
    eq(run(d, rowOf(inv(logical))).length, 0, 'so Vivint rejects it when the subtype calls for the packed one');
  }

  eq(run(d, build({ breakCrc: true })).length, 0, 'Vivint rejects a bad checksum');
  eq(run(d, build({ id: 0 })).length, 0, 'Vivint rejects an all-zero identifier');
  eq(run(d, build({ id: 0xffffffff })).length, 0, 'Vivint rejects an all-ones identifier');
  eq(run(d, build({ bits: 40 })).length, 0, 'Vivint refuses a frame too short to hold a message');
}

// ---- Silver Spring Networks mesh endpoint (383) ----
{
  const d = dev(383);
  const SYNC = bytesToBits(Uint8Array.from([0xaa, 0xaa, 0x18, 0xbf]));

  /**
   * The frame begins on the last bit of the sync and is the complement of what was matched, so the row is
   * the sync less its final bit followed by the complement of the frame. That works only because the first
   * frame byte's top bit is clear, which the channel number satisfies.
   */
  const build = ({ psdu, channel = 42, seed = 0x5a, damage = -1, reserved = 0 } = {}) => {
    const psduLen = psdu.length;
    const body = new Uint8Array(psduLen + 4);
    body.set(psdu, 0);
    const c = crc32Ref(body, psduLen);
    body[psduLen] = (c >>> 24) & 0xff; body[psduLen + 1] = (c >>> 16) & 0xff;
    body[psduLen + 2] = (c >>> 8) & 0xff; body[psduLen + 3] = c & 0xff;
    scramble(body, body.length, seed);

    const frame = new Uint8Array(3 + body.length);
    frame[0] = channel;
    frame[1] = (((psduLen >> 8) & 0x07) | (reserved & 0xf8)) & 0xff;
    frame[2] = psduLen & 0xff;
    frame.set(body, 3);
    if (damage >= 0) frame[damage] ^= 0x01;

    return rowOf([...SYNC.slice(0, 31), ...inv(bytesToBits(frame))]);
  };

  /*
   * Destination and source addresses, then a link-info record and a reception-strength one.
   *
   * A record's type is split across both header bytes — `type = (h0 << 1) | (h1 >> 7)` with the length in the
   * low seven bits of h1 — unless h0's top bit is set, which selects a wider layout instead. So `01 02` is
   * type 2 carrying two bytes, while `02 02` would be type 4. Assembling those by eye is what made three of
   * these read as the wrong record on the first run.
   */
  eq(((0x01 << 1) | (0x02 >> 7)) & 0x1ff, 2, 'a header of 01 02 is record type 2 (premise)');
  eq(((0x02 << 1) | (0x02 >> 7)) & 0x1ff, 4, 'while 02 02 is record type 4 (premise)');

  const PSDU = [0x03,
    0x00, 0x13, 0x50, 0xff, 0xfe, 0x11, 0x22, 0x33,
    0x00, 0x07, 0x81, 0xff, 0xfe, 0x44, 0x55, 0x66,
    0x01, 0x02, 0x12, 0x34,
    0x04, 0x81, 0xb0];

  {
    const out = run(d, build({ psdu: PSDU }));
    eq(out.length, 1, 'Silver Spring decodes a frame');
    eq(out[0]?.channel, 42, 'Silver Spring hop channel');
    eq(out[0]?.seed, 0x5a, 'and recovers the scrambler seed it was sent with');
    eq(out[0]?.len, PSDU.length, 'Silver Spring payload length');
    eq(out[0]?.dst_id, '001350fffe112233', 'Silver Spring destination address');
    eq(out[0]?.src_id, '000781fffe445566', 'Silver Spring source address');
    eq(out[0]?.link, 'poll', 'Silver Spring link role, from the control byte');
    eq(out[0]?.rssi, -80, 'Silver Spring reception strength, read as a signed byte');
    eq(out[0]?.tlvs, 'D2/2 D9/1', 'Silver Spring lists the records it walked, by type and length');
    eq(out[0]?.mic, 'CRC', 'Silver Spring reports a CRC');
    ok(typeof out[0]?.data === 'string' && out[0].data.length === PSDU.length * 2,
      'and the whole payload goes out as hex, so nothing is lost to the parsing left undone');
  }

  /*
   * The seed is not transmitted, so the decoder tries all 255. That is only an integrity check if a wrong
   * seed cannot pass — on a built frame exactly one does, and after a single flipped bit none does at all.
   */
  {
    const body = new Uint8Array(PSDU.length + 4);
    body.set(PSDU, 0);
    const c = crc32Ref(body, PSDU.length);
    body[PSDU.length] = (c >>> 24) & 0xff; body[PSDU.length + 1] = (c >>> 16) & 0xff;
    body[PSDU.length + 2] = (c >>> 8) & 0xff; body[PSDU.length + 3] = c & 0xff;
    const wire = Uint8Array.from(body);
    scramble(wire, wire.length, 0x5a);
    let hits = 0;
    for (let s = 1; s < 256; s++) {
      const t = Uint8Array.from(wire);
      scramble(t, t.length, s);
      const fcs = (((t[PSDU.length] << 24) >>> 0) | (t[PSDU.length + 1] << 16) | (t[PSDU.length + 2] << 8) | t[PSDU.length + 3]) >>> 0;
      if (crc32Ref(t, PSDU.length) === fcs) hits++;
    }
    eq(hits, 1, 'exactly one seed of 255 satisfies the checksum (premise)');
    eq(run(d, build({ psdu: PSDU, damage: 6 })).length, 0, 'and a single damaged byte leaves none, so the frame is refused');
  }

  // Both keying polarities occur, and the decoder is expected to cope with either.
  {
    const normal = build({ psdu: PSDU });
    const flipped = rowOf(inv(Array.from({ length: normal.bitsPerRow[0] },
      (_, i) => (normal.bb[0][i >> 3] >> (7 - (i & 7))) & 1)));
    eq(run(d, flipped).length, 1, 'Silver Spring decodes an inverted signal too');
    eq(run(d, flipped)[0]?.seed, 0x5a, 'and recovers the same seed from it');
  }

  // The link role comes from the control byte and which records turned up.
  for (const [fctrl, tail, want] of [
    [0x02, [0x01, 0x02, 0x12, 0x34], 'broadcast'],   // control byte alone decides this one
    [0x01, [0x01, 0x02, 0x12, 0x34], 'poll_ack'],    // type 2 only
    [0x01, [0x04, 0x81, 0xb0], 'data_ack'],          // type 9 only
    [0x01, [0x80, 0x02, 0x00, 0x01], 'data'],        // the wider layout, which any payload record uses
  ]) {
    const p = [fctrl];
    if (fctrl & 0x01) p.push(0x00, 0x13, 0x50, 0xff, 0xfe, 0x11, 0x22, 0x33);
    if (fctrl & 0x02) p.push(0x00, 0x07, 0x81, 0xff, 0xfe, 0x44, 0x55, 0x66);
    p.push(...tail);
    eq(run(d, build({ psdu: p }))[0]?.link, want, `control byte ${fctrl} with those records reads as ${want}`);
  }

  // Rejections.
  eq(run(d, build({ psdu: PSDU, reserved: 0x08 })).length, 0,
    'Silver Spring rejects a header whose reserved bits are set');
  eq(run(d, rowOf(new Array(400).fill(0))).length, 0, 'Silver Spring finds nothing without its sync word');
  eq(run(d, rowOf(SYNC)).length, 0, 'Silver Spring refuses a sync with no frame behind it');
}

// ---- The registrations themselves ----
{
  for (const num of [128, 342, 383]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
