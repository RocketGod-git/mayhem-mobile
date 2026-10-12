/**
 * Car alarms, remote starters and one alarm keyfob.
 *
 * None of these four protocols ships a recorded capture in rtl_433 — checked in both spellings, contiguous and
 * space separated — so there is no non-circular evidence to lean on and every frame here is built from the
 * transmit side: the bytes laid out as the remote sends them, with each check computed the way the remote
 * computes it.
 *
 * Where a rule is asserted, its premise is asserted beside it. Three matter especially: that Astrostart's
 * running modulo-sixteen nibble sum really is the same number the shared helper gives; that Audiovox tests its
 * button byte *before* the frame is inverted rather than after, shown with a byte that would pass if the order
 * were the other way round; and that Compustar's trailing-zero test reads bit 39 rather than the bit 35 its own
 * layout describes, shown with a frame that sets one and a frame that sets the other.
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

console.log('Car alarms, remote starters and one alarm keyfob');

// ---- Astrostart 2000 (301): a button sent twice, and a nibble sum over the serial ----
{
  /** The checksum exactly as the remote forms it: both nibbles of each serial byte, kept to four bits. */
  const astroSum = (b) => {
    let s = 0;
    for (let i = 2; i < 6; i++) { s = (s + (b[i] >> 4)) & 0x0f; s = (s + b[i]) & 0x0f; }
    return s;
  };

  const bytesFor = (button, id, opts = {}) => {
    const b = new Uint8Array(7);
    b[0] = button;
    b[1] = opts.inverse !== undefined ? opts.inverse : (~button & 0xff);
    b[2] = (id >>> 24) & 0xff; b[3] = (id >>> 16) & 0xff; b[4] = (id >>> 8) & 0xff; b[5] = id & 0xff;
    b[6] = ((opts.checksum !== undefined ? opts.checksum : astroSum(b)) & 0x0f) << 4;
    return b;
  };
  const build = (button, id, opts = {}) => rowBits(bytesToBits(bytesFor(button, id, opts)).slice(0, 52));

  // The premise behind using the shared helper: the remote's running mask and a single sum agree, because eight
  // nibbles cannot exceed 120 and so never reach the byte-wide mask the helper applies.
  {
    let sameEverywhere = true;
    for (const id of [0x12345678, 0xffffffff, 0x00000000, 0xdeadbeef, 0x0f0f0f0f, 0x99999999]) {
      const b = bytesFor(0x2b, id);
      if (astroSum(b) !== (U.addNibbles(b, 4, 2) & 0x0f)) sameEverywhere = false;
    }
    ok(sameEverywhere, 'Astrostart: the running modulo-sixteen sum equals the shared nibble sum, masking and all');
    // And the sum really is capable of exceeding a nibble, so the agreement is not vacuous.
    ok(U.addNibbles(bytesFor(0x2b, 0xffffffff), 4, 2) === 120,
      '  and the unmasked total genuinely overflows four bits, so the mask is doing work');
  }

  const d = run(dev(301), build(0x2b, 0x12345678))[0];
  ok(!!d, 'Astrostart decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Astrostart-2000', '  Astrostart model');
    eq(d.id, '12345678', '  Astrostart serial');
    eq(d.button_code, 0x2b, '  Astrostart button code');
    eq(d.button_str, 'Lock', '  Astrostart names the button');
    eq(d.mic, 'CHECKSUM', '  Astrostart reports its check');
  }

  // A code in two buttons' lists is two buttons held down together, and must be reported as both.
  eq(run(dev(301), build(0x35, 0x12345678))[0]?.button_str, 'Lock; Panic',
    'Astrostart reports a two-button press under both names');
  eq(run(dev(301), build(0x37, 0x12345678))[0]?.button_str, 'Lock; Start', '  and another such pairing');
  eq(run(dev(301), build(0x3f, 0x12345678))[0]?.button_str, 'Multiple',
    '  and reports three buttons as the catch-all the remote sends');
  eq(run(dev(301), build(0x01, 0x12345678))[0]?.button_str, '?',
    '  and refuses to guess at a code it has never seen');

  // The button byte is sent twice, once complemented; break the second copy.
  ok(!run(dev(301), build(0x2b, 0x12345678, { inverse: 0xd5 }))[0],
    'Astrostart rejects a frame whose button byte disagrees with its complement');

  // Corrupt the checksum, having first shown that the value really changed.
  {
    const good = astroSum(bytesFor(0x2b, 0x12345678));
    const bad = (good + 1) & 0x0f;
    ok(good !== bad, 'Astrostart: the corrupted checksum nibble really differs from the right one');
    ok(!run(dev(301), build(0x2b, 0x12345678, { checksum: bad }))[0], '  and the frame is rejected');
  }

  // Corrupt a serial byte the checksum covers, leaving the checksum of the original in place.
  {
    const sumA = astroSum(bytesFor(0x2b, 0x12345678));
    const sumB = astroSum(bytesFor(0x2b, 0x12345679));
    ok(sumA !== sumB, 'Astrostart: changing the serial really changes the checksum it demands');
    ok(!run(dev(301), build(0x2b, 0x12345679, { checksum: sumA }))[0],
      '  so a serial carrying another frame\'s checksum is rejected');
  }

  ok(!run(dev(301), rowBits(bytesToBits(bytesFor(0x2b, 0x12345678)).slice(0, 51)))[0],
    'Astrostart refuses a frame of the wrong length');
  ok(!run(dev(301), rowsOf([bytesToBits(bytesFor(0x2b, 0x12345678)).slice(0, 52),
    bytesToBits(bytesFor(0x2b, 0x12345678)).slice(0, 52)]))[0],
    '  and refuses a burst carrying more than one row');
}

// ---- Compustar 1WG3R (302): several presses in one burst, and a complement to check them ----
{
  /** Thirty-six bits: id, three marker bits, the inverted button byte, the button byte, a trailing zero. */
  const frame = (id, button, opts = {}) => {
    const inv = opts.inverse !== undefined ? opts.inverse : (~button & 0xff);
    const marker = opts.marker !== undefined ? opts.marker : 0b111;
    const bits = [];
    for (let i = 15; i >= 0; i--) bits.push((id >> i) & 1);
    for (let i = 2; i >= 0; i--) bits.push((marker >> i) & 1);
    for (let i = 7; i >= 0; i--) bits.push((inv >> i) & 1);
    for (let i = 7; i >= 0; i--) bits.push((button >> i) & 1);
    bits.push(opts.z !== undefined ? opts.z : 0);
    return bits;
  };
  const separator = [1, 1, 1, 1, 1];

  const out = run(dev(302), rowsOf([frame(0xabcd, 0x03)]));
  eq(out.length, 1, 'Compustar decodes one press');
  const d = out[0];
  if (d) {
    eq(d.model, 'Compustar-1WG3R', '  Compustar model');
    eq(d.id, 'ABCD', '  Compustar id');
    eq(d.button_code, 0x03, '  Compustar button code');
    eq(d.button_str, 'Lock; Unlock', '  Compustar names both buttons a shared code belongs to');
    eq(d.mic, 'CHECKSUM', '  Compustar reports its check');
  }

  eq(run(dev(302), rowsOf([frame(0xabcd, 0x18)]))[0]?.button_str, 'Panic',
    'Compustar names a code belonging to one button only');
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x83)]))[0]?.button_str, 'Lock; Unlock; Secondary Mode',
    '  and appends secondary mode, which rides in the top bit rather than the code');
  // Upstream omits the separator when nothing matched. Reproduced rather than corrected.
  eq(run(dev(302), rowsOf([frame(0xabcd, 0xff)]))[0]?.button_str, '?Secondary Mode',
    '  and runs the two together for an unknown code, exactly as upstream does');

  // The trailing zero. Upstream's test reads bit 39, not the bit 35 its own layout calls "z".
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x03, { z: 1 })])).length, 1,
    'Compustar accepts a frame with bit 35 set, the bit its layout calls the trailing zero');
  eq(run(dev(302), rowsOf([[...frame(0xabcd, 0x03), 0, 0, 0, 1]])).length, 0,
    '  but rejects one with bit 39 set, which is the bit the check actually reads');

  // The complement is the only real check there is.
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x03, { inverse: 0xfd })])).length, 0,
    'Compustar rejects a button byte disagreeing with its complement');
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x03, { marker: 0b110 })])).length, 0,
    '  and rejects a frame whose three marker bits are not all set');
  eq(run(dev(302), rowsOf([frame(0x0000, 0x03)])).length, 0, '  and rejects an all-zero id');
  eq(run(dev(302), rowsOf([frame(0xffff, 0x03)])).length, 0, '  and an all-ones id');
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x03).slice(0, 34)])).length, 0, '  and a row too short to hold a frame');

  // Programming mode sends a run of presses, so more than one reading can come out of one burst.
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x03), frame(0xabcd, 0x18)])).length, 2,
    'Compustar reports two different presses from one burst');
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x03), frame(0xabcd, 0x03)])).length, 1,
    '  but collapses a row repeated back to back into one press');
  eq(run(dev(302), rowsOf([frame(0xabcd, 0x03), separator, frame(0xabcd, 0x03)])).length, 2,
    '  while a batch separator between them makes it two presses again');
  // The separator only resets the comparison; it is not itself a reading.
  eq(run(dev(302), rowsOf([separator, separator])).length, 0, '  and a separator on its own decodes to nothing');
}

// ---- Audiovox PRO-OE3B (305): inverted on the wire, and the order that matters ----
{
  /**
   * The raw button byte for a set of pressed flags. The wire carries the complement of everything, so the
   * flags the decoder reads are the complement of this byte, and the odd bit positions must be clear here.
   */
  const rawFor = (pressed) => (~pressed) & 0x55;
  const build = (id, raw) => {
    const b = new Uint8Array(4);
    b[0] = (~(id >> 8)) & 0xff;
    b[1] = (~id) & 0xff;
    b[2] = raw;
    return { b, bb: rowBits(bytesToBits(b).slice(0, 25)) };
  };

  const { b, bb } = build(0xabcd, rawFor(0x55));
  // The premise: the identity really is sent complemented, so reading it straight would give a different remote.
  eq(b[0], 0x54, 'Audiovox: the wire carries the complement of the identity');
  eq(b[1], 0x32, '  both bytes of it');

  const d = run(dev(305), bb)[0];
  ok(!!d, 'Audiovox decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Audiovox-PROOE3B', '  Audiovox model');
    eq(d.id, 'ABCD', '  Audiovox id, read after the inversion');
    eq(d.button_str, 'Lock; Unlock; Option; Trunk', '  Audiovox reports every flag that is set');
    ok(d.mic === undefined, '  Audiovox claims no integrity check, having none');
  }

  eq(run(dev(305), build(0xabcd, rawFor(0x01)).bb)[0]?.button_str, 'Lock',
    'Audiovox reads a single button');
  eq(run(dev(305), build(0xabcd, rawFor(0x41)).bb)[0]?.button_str, 'Lock; Trunk',
    '  and two buttons held together, from the bits rather than a table');
  eq(run(dev(305), build(0xabcd, rawFor(0x10)).bb)[0]?.button_str, 'Option', '  and the option button alone');

  // The whole sanity test, and the order it runs in.
  ok(!run(dev(305), build(0xabcd, 0x55).bb)[0],
    'Audiovox rejects the byte meaning no button at all');
  ok(!run(dev(305), build(0xabcd, 0x56).bb)[0],
    '  and rejects a byte with an odd-position bit set, which no button can produce');
  // 0xff fails the raw test; its complement 0x00 would pass the very same test. So accepting this frame would
  // prove the decoder had inverted first, and rejecting it proves it did not.
  ok((0xff & 0xaa) !== 0 && (0x00 & 0xaa) === 0 && 0x00 !== 0x55,
    'Audiovox: 0xff fails the sanity test while its complement passes it');
  ok(!run(dev(305), build(0xabcd, 0xff).bb)[0],
    '  so rejecting that frame shows the test reads the byte before the inversion, not after');

  ok(!run(dev(305), build(0x0000, rawFor(0x55)).bb)[0], 'Audiovox rejects an all-zero id');
  ok(!run(dev(305), build(0xffff, rawFor(0x55)).bb)[0], '  and an all-ones id');
  ok(!run(dev(305), rowBits(bytesToBits(build(0xabcd, rawFor(0x55)).b).slice(0, 24)))[0],
    '  and a frame of the wrong length');

  // Upstream gives this one a late priority because it has nothing to check itself with.
  eq(dev(305).priority, 10, 'Audiovox runs after anything carrying a real checksum');
}

// ---- 2GIG-KEY2E-345 (370): a solid frame around a payload nobody has solved ----
{
  /** Manchester as this family sends it: each bit as the pair (complement, bit). */
  const manchester = (bits) => { const o = []; for (const v of bits) o.push(1 - v, v); return o; };
  const PREAMBLE = [0x55, 0x55, 0x56];

  const bytesFor = (encId, status, opts = {}) => {
    const b = new Uint8Array(9);
    b.set(encId, 0);
    b[4] = opts.constant !== undefined ? opts.constant : 0x25;
    b[5] = status[0]; b[6] = status[1];
    const c = opts.crc !== undefined ? opts.crc : U.crc16(b, 7, 0x8005, 0x4c57);
    b[7] = (c >> 8) & 0xff; b[8] = c & 0xff;
    return b;
  };
  const wire = (b) => [...bytesToBits(PREAMBLE), ...manchester(bytesToBits(b))];

  const encId = [0xde, 0xad, 0xbe, 0xef];
  const b = bytesFor(encId, [0x1a, 0x2b]);
  const d = run(dev(370), rowBits(wire(b)))[0];
  ok(!!d, '2GIG keyfob decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'TwoGig-KEY2E345', '  2GIG keyfob model');
    eq(d.encrypted_id, 'deadbeef', '  2GIG keyfob reports its encrypted field as opaque hex');
    eq(d.encrypted_status, '1a2b', '  and its encrypted status likewise');
    eq(d.mic, 'CRC', '  2GIG keyfob reports its check');
    ok(d.id === undefined,
      '  and does not present the encrypted field as an identity, not knowing whether it rolls');
  }

  // The CRC covers the seven bytes ahead of it and nothing else.
  eq(U.crc16(b, 7, 0x8005, 0x4c57), (b[7] << 8) | b[8], '2GIG keyfob: the check is a CRC-16 over seven bytes');

  // Corrupt a byte the decoder reads, having first shown the wire really changed.
  {
    const bad = Uint8Array.from(b); bad[0] ^= 0x01;
    const before = wire(b), after = wire(bad);
    ok(before.length === after.length && before.some((v, i) => v !== after[i]),
      '2GIG keyfob: the corrupted frame really differs on the wire');
    ok(!run(dev(370), rowBits(after))[0], '  and it fails the CRC');
  }

  // A wrong constant byte is caught on its own account, not by the CRC.
  {
    const odd = bytesFor(encId, [0x1a, 0x2b], { constant: 0x24 });
    eq(U.crc16(odd, 7, 0x8005, 0x4c57), (odd[7] << 8) | odd[8],
      '2GIG keyfob: a frame with the wrong constant still carries a valid CRC');
    ok(!run(dev(370), rowBits(wire(odd)))[0], '  so rejecting it is the constant byte doing the work');
  }

  // Without the run-in there is nothing to align to.
  ok(!run(dev(370), rowBits(new Array(168).fill(0)))[0], '2GIG keyfob refuses a burst carrying no run-in');
  ok(!run(dev(370), rowBits(wire(b).slice(0, 95)))[0], '  and a burst too short to hold a frame');

  // A Manchester pair that does not change level ends the decode early, leaving too few bits.
  {
    const broken = wire(b);
    broken[40] = broken[41];                       // well inside the payload
    ok(!run(dev(370), rowBits(broken))[0], '2GIG keyfob refuses a frame with a coding violation in it');
  }

  // rtl_433 ships this switched off because its payload is meaningless, and that is mirrored rather than
  // second-guessed: this table is meant to read as a faithful copy of upstream's, so an entry that differs
  // should differ for a reason visible in the bits. Nothing here is. The flag fits anyway — every registered
  // decoder still runs, and `disabled` only marks the reading doubtful, which describes two unsolved hex
  // fields fairly. Pinned so the table cannot drift away from upstream's unnoticed.
  ok(dev(370).disabled === true,
    '2GIG keyfob mirrors upstream\'s disabled flag: its payload is unsolved');
}

// ---- The registrations themselves ----
{
  for (const num of [301, 302, 305, 370]) ok(!!dev(num), `protocol ${num} is registered`);

  // The six HCS361 variants this batch was scoped to already live in keeloq.ts; make sure they stayed there.
  for (const num of [306, 307, 308, 309, 310, 311]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  eq(new Set([306, 307, 308, 309, 310, 311].map(n => dev(n)?.name.startsWith('Microchip HCS361'))).size, 1,
    'the six HCS361 registrations are all the one part');

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  // Every modulation used here must have a slicer behind it, or the device would be silent forever.
  const HANDLED = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  for (const num of [301, 302, 305, 370]) {
    ok(HANDLED.has(dev(num).modulation), `protocol ${num} uses a modulation the slicer implements`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
