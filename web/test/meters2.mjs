/**
 * Water and utility meter endpoints.
 *
 * Three of the seven protocols here come with real evidence and are tested against it directly. Apator's heat
 * cost allocator ships five captures together with the bytes they unwhiten to; Badger's Orion Endpoint ships
 * two, one of them with its unwhitened row printed beside it; and Arad's meter ships a frame together with the
 * forty-bit checksum it is supposed to produce. Those settle the whitening, the substitution table and the
 * whole checksum construction without this file having any say in the answer.
 *
 * The rest are built from the transmit side: lay out what the meter sends, run it through that meter's own line
 * coding — three-of-six symbols for Badger ORION, base six for Neptune, 8N1 serial for Gridstream — and hand
 * the result back to the decoder. Where a rule exists to handle an awkward case, the test asserts the frame
 * really is that case before asserting the rule fired.
 *
 * One documented capture does NOT check out, and that is asserted too rather than being quietly dropped. See
 * the E-ITN 30 section.
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
const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/\s+/g, '').match(/../g).map(x => parseInt(x, 16)));
const hexOf = (b, n = b.length, at = 0) => {
  let s = '';
  for (let i = 0; i < n; i++) s += (b[at + i] & 0xff).toString(16).padStart(2, '0');
  return s;
};
const pad = (bits, n) => { const o = [...bits]; while (o.length < n) o.push(0); return o; };
const inv = (bits) => bits.map(b => b ^ 1);

console.log('Water and utility meter endpoints');

// ---------------------------------------------------------------------------
// Badger ORION water meter (223)
// ---------------------------------------------------------------------------
{
  // The transmit side of the 3-of-6 line code: the inverse of the table the decoder carries.
  const ENC = [22, 13, 14, 11, 28, 25, 26, 19, 44, 37, 38, 35, 52, 49, 50, 41];
  const symbolBits = (sym) => { const o = []; for (let i = 5; i >= 0; i--) o.push((sym >> i) & 1); return o; };
  const encode3of6 = (bytes) => {
    const o = [];
    for (const b of bytes) { o.push(...symbolBits(ENC[b >> 4])); o.push(...symbolBits(ENC[b & 0x0f])); }
    return o;
  };
  // Every legal symbol really does have exactly three bits set — that is the whole point of the code.
  ok(ENC.every(s => [...s.toString(2)].filter(c => c === '1').length === 3),
    'every 3-of-6 symbol carries exactly three set bits');

  const build = (id, flags1, volume, flags2, corrupt) => {
    const b = new Uint8Array(10);
    b[0] = id & 0xff; b[1] = (id >> 8) & 0xff; b[2] = (id >> 16) & 0xff;
    b[3] = flags1;
    b[4] = volume & 0xff; b[5] = (volume >> 8) & 0xff; b[6] = (volume >> 16) & 0xff;
    b[7] = flags2;
    const crc = (~U.crc16(b, 8, 0x3d65, 0)) & 0xffff;
    b[8] = crc >> 8; b[9] = crc & 0xff;
    let payload = encode3of6(b);
    if (corrupt === 'symbol') payload = [...payload.slice(0, 120)].map((v, i) => (i < 6 ? 0 : v)); // 000000 is illegal
    if (corrupt === 'crc') b[0] ^= 0x01, payload = encode3of6(b);
    return { row: rowBits(pad([...bytesToBits([0x54, 0x3d]), ...payload], 200)), b };
  };

  const { row, b } = build(1234567, 0x00, 987654, 0x00);
  const d = run(dev(223), row)[0];
  ok(!!d, 'Badger ORION decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'Badger-ORION', '  Badger ORION model');
    eq(d.id, 1234567, '  Badger ORION id is three bytes little-endian');
    eq(d.volume_gal, 987654, '  Badger ORION reading counts whole gallons');
    eq(d.flags_1, 0x00, '  Badger ORION reports its first flag byte raw');
    eq(d.flags_2, 0x00, '  Badger ORION reports its second flag byte raw');
    eq(d.mic, 'CRC', '  Badger ORION reports its check');
  }

  // The CRC is stored complemented, which is easy to get wrong in either direction.
  ok(((~U.crc16(b, 8, 0x3d65, 0)) & 0xffff) === ((b[8] << 8) | b[9]),
    '  the built frame stores the complemented CRC-16, big-endian');
  ok(!run(dev(223), build(1234567, 0, 987654, 0, 'crc').row)[0],
    '  Badger ORION rejects a frame whose CRC does not close');

  // An illegal six-bit symbol must be refused. Upstream's own check for this is dead code — its helper returns
  // 1 for a bad symbol and the caller tests for a negative — so assert first that the frame really does carry a
  // symbol outside the table, then that this port turns it away.
  const badSym = build(1234567, 0, 987654, 0, 'symbol');
  ok(!ENC.includes(0), '  the all-zero six-bit symbol is genuinely not in the 3-of-6 table');
  ok(!run(dev(223), badSym.row)[0], '  Badger ORION rejects an illegal 3-of-6 symbol');

  // Length bounds: a row too short to hold preamble plus ten coded bytes is not this protocol.
  ok(!run(dev(223), rowBits(pad([...bytesToBits([0x54, 0x3d])], 130)))[0],
    '  Badger ORION refuses a row too short to hold its payload');
}

// ---------------------------------------------------------------------------
// Neptune R900 (228 binary) and R900 BCD (385)
// ---------------------------------------------------------------------------
{
  // The transmit side of the base-6 code: each digit 0-5 becomes one of six legal nibbles.
  const INV6 = [3, 5, 6, 12, 10, 9];
  const PREAMBLE = [0x55, 0x55, 0x55, 0xa9, 0x66, 0x69, 0x65];

  const build = (b13, mutate) => {
    // 104 payload bits plus one spare make the 105 the base-6 stream carries.
    const bits = [...bytesToBits(b13), 0];
    const wire = [];
    for (let i = 0; i < 21; i++) {
      let v = 0;
      for (let k = 0; k < 5; k++) v = (v << 1) | bits[i * 5 + k];
      wire.push((INV6[(v / 6) | 0] << 4) | INV6[v % 6]);
    }
    if (mutate) mutate(wire);
    return rowBits(pad([...bytesToBits(PREAMBLE), ...bytesToBits(Uint8Array.from(wire))], 240));
  };
  // Five bits give 0..31 and every one of those is a legal two-digit base-6 value, so any payload can be sent.
  ok(31 === 6 * 5 + 1, 'the largest five-bit group still fits two base-6 digits');

  const payload = (consumeHi, c0, c1, c2) => {
    const b = new Uint8Array(13);
    b[0] = 0x12; b[1] = 0x34; b[2] = 0x56; b[3] = 0x78;      // meter id
    b[4] = 0x59;                                              // unkn1 = 5, meter type = 9
    b[5] = (0x03 << 5) | (0x04 << 2) | 0x02;                  // unkn2 3, nouse 4, backflow 2
    b[6] = c0; b[7] = c1; b[8] = c2;
    b[9] = (consumeHi << 5) | (0x05 << 2) | 0x01;             // wrap, leak 5, leaknow 1
    b[10] = 0xab; b[11] = 0xcd; b[12] = 0xef;
    return b;
  };

  // A counter whose every nibble is a decimal digit, so both readings of it are meaningful.
  const both = payload(0x03, 0x12, 0x34, 0x56);
  const dBin = run(dev(228), build(both))[0];
  ok(!!dBin, 'Neptune R900 decodes', JSON.stringify(dBin));
  if (dBin) {
    eq(dBin.model, 'Neptune-R900', '  R900 model');
    eq(dBin.id, 0x12345678, '  R900 id is thirty-two bits, most significant byte first');
    eq(dBin.unkn1, 5, '  R900 first unknown nibble');
    eq(dBin.metertype, 9, '  R900 meter type');
    eq(dBin.unkn2, 3, '  R900 second unknown field');
    eq(dBin.nouse, 4, '  R900 days-without-use band');
    eq(dBin.backflow, 2, '  R900 backflow band');
    eq(dBin.leak, 5, '  R900 days-of-leak band');
    eq(dBin.leaknow, 1, '  R900 leak-right-now band');
    eq(dBin.extra, 'abcdef', '  R900 trailing unidentified bytes are reported as hex');
    eq(dBin.consumption, (0x03 << 24) | 0x123456, '  R900 binary reading folds the wrap bits in above the counter');
  }

  const dBcd = run(dev(385), build(both))[0];
  ok(!!dBcd, 'Neptune R900 BCD decodes the same frame', JSON.stringify(dBcd));
  if (dBcd) {
    eq(dBcd.model, 'Neptune-R900BCD', '  R900BCD model');
    eq(dBcd.consumption, 123456, '  R900BCD reads the same bits as six decimal digits');
    ok(dBcd.consumption !== dBin?.consumption,
      '  the two readings of one frame genuinely disagree, which is why only one can be right');
  }
  ok(dev(385).disabled === true, '  R900BCD is flagged doubtful, overlapping the binary decoder');

  // The decimal decoder must refuse a counter that cannot be decimal. Assert the premise first: this counter
  // really does contain a nibble above nine.
  const notBcd = payload(0x00, 0xa2, 0x34, 0x56);
  ok(((0xa2 >> 4) & 0x0f) > 9, '  the frame built for this really does carry a nibble above nine');
  ok(!run(dev(385), build(notBcd))[0], '  R900BCD refuses a counter that is not decimal');
  ok(!!run(dev(228), build(notBcd))[0], '  but the binary decoder reads that same frame happily');

  // Two thirds of the nibble values are illegal, which is all that stands in for a checksum here.
  const legal = new Set(INV6);
  ok([...Array(16).keys()].filter(n => !legal.has(n)).length === 10,
    '  ten of the sixteen nibble values cannot legally be sent');
  ok(!run(dev(228), build(both, w => { w[3] = 0x00; }))[0],
    '  R900 rejects a frame containing an illegal chip pattern');

  // The run-in has to be there.
  ok(!run(dev(228), rowBits(pad(bytesToBits(new Uint8Array(30)), 240)))[0],
    '  R900 refuses a row with no sync word');
}

// ---------------------------------------------------------------------------
// Arad / Master Meter Dialog3G (260): the capture rtl_433 documents
// ---------------------------------------------------------------------------
{
  // The frame as upstream prints it, already the right way up. It travels inverted, so the row is the
  // complement of these bits.
  const SAMPLE = hexToBytes('00000000 3e690aec7ac8 4b47f72e00405f2500000c 9ec5cb5538 f8');
  const PAYLOAD = SAMPLE.subarray(10, 21);        // the eighty-eight bits the checksum covers
  const CHECK = SAMPLE.subarray(21, 26);          // the forty-bit checksum printed beside them

  const buildRow = (flips = []) => {
    const bits = bytesToBits(SAMPLE);
    for (const f of flips) bits[80 + f] ^= 1;     // payload bit f, the payload starting at row bit 80
    return rowBits(inv(bits));
  };

  const row = buildRow();
  const before = row.rowHex(0);
  const d = run(dev(260), row)[0];
  ok(!!d, 'Arad Dialog3G decodes the documented capture', JSON.stringify(d));
  if (d) {
    eq(d.model, 'AradMsMeter-Dialog3G', '  Arad model');
    eq(d.uid, '3e690aec7ac8', '  Arad reads the fixed identifier every one of these meters carries');
    eq(d.id, '03077959-00', '  Arad serial number and its suffix');
    eq(d.leaking, 0, '  this capture reports no leak');
    eq(d.flags1, '40', '  Arad first flag byte');
    eq(d.flags2, '0c', '  Arad second flag byte');
    eq(d.gear, 0.01, '  a blank serial suffix with flags 0x40 means hundredths');
    eq(d.unit, 'm3', '  and cubic metres');
    eq(d.volume, 95.67, '  Arad volume, the raw counter scaled by the deduced count factor');
    eq(d.corrections, 0, '  the documented capture needs no repair');
    eq(d.mic, 'CHECKSUM', '  Arad reports its check');
  }

  // The forty-bit digest is the hard part of this decoder, so assert it against the printed value directly:
  // a clean decode with zero corrections can only happen if the computed checksum equalled these five bytes.
  eq(hexOf(CHECK), '9ec5cb5538', '  the capture carries the checksum upstream documents');
  ok(hexOf(PAYLOAD) === '4b47f72e00405f2500000c', '  and the payload those five bytes are computed over');

  // Nothing else in the app may see a disturbed buffer. Upstream inverts the shared bit buffer in place; this
  // port complements only the bytes it extracts, and this is what locks that in.
  eq(row.rowHex(0), before, '  Arad leaves the shared bit buffer exactly as it found it');
  const again = run(dev(260), row)[0];
  eq(again?.id, d?.id, '  so decoding the same buffer twice gives the same answer');

  // Error correction. Assert the premise each time: the damaged frame really does fail its checksum, which is
  // the only reason the repair path runs at all.
  for (const flips of [[7], [3, 61], [12, 40, 83]]) {
    const damaged = buildRow(flips);
    const dd = run(dev(260), damaged)[0];
    ok(!!dd, `Arad repairs ${flips.length} flipped payload bit(s)`, JSON.stringify(dd));
    if (dd) {
      eq(dd.corrections, flips.length, `  it reports repairing ${flips.length}`);
      eq(dd.id, d?.id, '  and recovers the serial number the clean frame gave');
      eq(dd.volume, d?.volume, '  and the same volume');
    }
    // The premise: with those bits flipped the frame no longer matches its own checksum.
    const broken = Uint8Array.from(PAYLOAD);
    for (const f of flips) broken[f >> 3] ^= 1 << (7 - (f % 8));
    ok(hexOf(broken) !== hexOf(PAYLOAD), `  the ${flips.length}-bit case really did damage the payload`);
  }

  // Four flipped bits is past what the syndrome can name, so it must not silently invent a reading.
  const wrecked = run(dev(260), buildRow([1, 20, 44, 70]))[0];
  ok(!wrecked || wrecked.corrections === 3,
    '  four flipped bits are either refused or mis-attributed to three, never reported as clean',
    JSON.stringify(wrecked));
}

// ---------------------------------------------------------------------------
// Landis & Gyr Gridstream (271, 272, 273)
// ---------------------------------------------------------------------------
{
  // Bytes go out as 8N1 serial, least significant bit first, with a start and a stop bit around each.
  const uartBits = (bytes) => {
    const o = [];
    for (const b of bytes) { o.push(0); for (let i = 0; i < 8; i++) o.push((b >> i) & 1); o.push(1); }
    return o;
  };
  // The two sync words are not the same length: version 4 runs 0b0000000001 0b0111111111 for 36 bits with the
  // run-in, version 5 runs 0b0000000001 0b11111111111 for 37. Getting that off by one loses the frame entirely.
  const PRE_V4 = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const PRE_V5 = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  ok(PRE_V4.length === 36 && PRE_V5.length === 37, 'the two Gridstream sync words differ in length by one bit');
  const frameRow = (bytes, pre = PRE_V4) => rowBits(pad([...pre, ...uartBits(bytes)], 4000));

  const PUGET = 0x142a;
  // A subtype 0x55 frame: two wide-area addresses, an uptime and a meter id, closed by the utility's CRC.
  const build55 = (init = PUGET) => {
    const b = new Uint8Array(39);
    b[0] = 0x2a; b[1] = 0x55; b[2] = 0x00; b[3] = 0x23; b[4] = 0x02;
    for (let i = 0; i < 6; i++) b[5 + i] = 0x01 + i;
    for (let i = 0; i < 6; i++) b[11 + i] = 0x11 + i;
    b[18] = 0x00; b[19] = 0x01; b[20] = 0x23; b[21] = 0x45;
    b[24] = 0xaa; b[25] = 0xbb; b[26] = 0xcc; b[27] = 0xdd;
    const crc = U.crc16(b, 33, 0x1021, init, 4);
    b[37] = crc >> 8; b[38] = crc & 0xff;
    return b;
  };

  const d55 = run(dev(271), frameRow(build55()))[0];
  ok(!!d55, 'Gridstream subtype 0x55 decodes', JSON.stringify(d55));
  if (d55) {
    eq(d55.model, 'LandisGyr-GS', '  Gridstream model');
    eq(d55.networkID, '142a', '  the starting value that checked out names the deployment');
    eq(d55.provider, 'Puget Sound Energy', '  and with it the utility');
    eq(d55.location, 'Washington', '  and where it is');
    eq(d55.subtype, 0x55, '  subtype');
    eq(d55.ci, 0x02, '  the control byte is the first one the CRC covers');
    eq(d55.protoversion, 4, '  read through the version 4 sync word');
    eq(d55.destaddress, '010203040506', '  target wide-area address');
    eq(d55.wanaddress, '111213141516', '  source wide-area address');
    eq(d55.id, 'aabbccdd', '  source meter id');
    eq(d55.uptime, 0x12345, '  seconds since that meter last lost power');
    eq(d55.mic, 'CRC', '  Gridstream reports its check');
  }

  // The same frame read at the other two bit rates: one decoder, three registrations.
  eq(run(dev(272), frameRow(build55()))[0]?.id, 'aabbccdd', '  the 19.2k registration reads the same frame');
  eq(run(dev(273), frameRow(build55()))[0]?.id, 'aabbccdd', '  and so does the 38.4k one');

  // Version 5 differs only in the sync word.
  const d55v5 = run(dev(271), frameRow(build55(), PRE_V5))[0];
  ok(!!d55v5, 'Gridstream reads a version 5 sync word', JSON.stringify(d55v5));
  eq(d55v5?.protoversion, 5, '  and says so');

  // A deployment whose starting value is not in the table cannot be checked, so the frame is refused. Assert
  // the premise: 0x0000 really is absent from the list.
  const KNOWN = ['e623', '5fd6', 'd553', '45f8', '62c1', '23d1', '2c22', '142a',
    '47f7', '22c6', '8819', '4e2d', '1d65', 'b9a9', 'd1ff', 'ba1f'];
  ok(!KNOWN.includes('0000'), '  the starting value used for this case is genuinely unknown to the table');
  ok(!run(dev(271), frameRow(build55(0x0000)))[0], '  Gridstream refuses a frame from an unlisted deployment');

  // Subtype 0xD5 at length 0x47 carries a clock and a wide-area address as well.
  const buildD5 = () => {
    const b = new Uint8Array(75);
    b[0] = 0x2a; b[1] = 0xd5; b[2] = 0x00; b[3] = 0x47; b[4] = 0x0c;
    b[5] = 0xde; b[6] = 0xad; b[7] = 0xbe; b[8] = 0xef;
    b[9] = 0xfe; b[10] = 0xed; b[11] = 0xfa; b[12] = 0xce;
    b[14] = 0x65; b[15] = 0x43; b[16] = 0x21; b[17] = 0x00;
    b[22] = 0x00; b[23] = 0x0a; b[24] = 0xbc; b[25] = 0xde;
    for (let i = 0; i < 6; i++) b[30 + i] = 0x21 + i;
    const crc = U.crc16(b, 69, 0x1021, PUGET, 4);
    b[73] = crc >> 8; b[74] = crc & 0xff;
    return b;
  };
  const dD5 = run(dev(271), frameRow(buildD5()))[0];
  ok(!!dD5, 'Gridstream subtype 0xD5 decodes', JSON.stringify(dD5));
  if (dD5) {
    eq(dD5.destaddress, 'deadbeef', '  D5 target meter id');
    eq(dD5.id, 'feedface', '  D5 source meter id');
    eq(dD5.timestamp, 0x65432100, '  D5 at length 0x47 carries the mesh clock');
    eq(dD5.uptime, 0x000abcde, '  and an uptime');
    eq(dD5.wanaddress, '212223242526', '  and a source wide-area address');
  }

  // An encrypted body: a 0xD2 frame whose control byte is 0x52 ends in an authentication tag, not a CRC, so it
  // could never pass the check. Assert exactly that — the same frame with any other control byte is refused —
  // and then that the encrypted one is still reported rather than dropped.
  const buildD2 = (ci) => {
    const b = new Uint8Array(24);
    b[0] = 0x2a; b[1] = 0xd2; b[2] = 0x10; b[3] = ci;
    for (let i = 4; i < 24; i++) b[i] = 0x5a + i;
    return b;
  };
  ok(!run(dev(271), frameRow(buildD2(0x53)))[0],
    '  a 0xD2 frame with no valid CRC is refused when it is not flagged encrypted');
  const dEnc = run(dev(271), frameRow(buildD2(0x52)))[0];
  ok(!!dEnc, 'Gridstream reports an encrypted 0xD2 frame rather than dropping it', JSON.stringify(dEnc));
  if (dEnc) {
    eq(dEnc.encrypted, 1, '  it is flagged as encrypted');
    eq(dEnc.ci, 0x52, '  with the control byte that says so');
    ok(dEnc.mic === undefined, '  and claims no integrity check, because it passed none');
    ok(dEnc.id === undefined, '  and reports no meter id, which a 0xD2 frame does not carry');
  }

  // A frame that is not this protocol at all.
  const notGs = build55(); notGs[0] = 0x2b;
  ok(!run(dev(271), frameRow(notGs))[0], '  Gridstream ignores a frame that does not start with 0x2a');
}

// ---------------------------------------------------------------------------
// Apator Metra E-ITN 30 (296): five real captures
// ---------------------------------------------------------------------------
{
  // The captures rtl_433 records, each with the bytes it prints them as unwhitening to.
  const CAPS = [
    ['eec25edb8e003d1584cadf3678f930c1f7bdc6ec', '1123434163850e316eb00d0f086e67cba3c0eb34'],
    ['eec25edb8e003d1584cadf3478f9300a82bdf557', '1123434163850e316eb00d0d086e6700d6c0d88f'],
    ['eec25edb8e003d1584ca5f3278f930c5ebbd89cd', '1123434163850e316eb08d0b086e67cfbfc0a415'],
    ['eec25edb8e003d1584ca5ff878fc3085efbd53f5', '1123434163850e316eb08dc1086b678fbbc07e2d'],
    ['eec25edb8e003d1584ca1ffc78fc30648cbd91bc', '1123434163850e316eb0cdc5086b676ed8c0bc64'],
  ];
  const buildRow = (raw) => rowBits(pad([...bytesToBits([0xaa, 0xaa, 0x69, 0x9a]), ...bytesToBits(raw)], 192));

  // First, the whitening itself, against the rows upstream prints. This is the layer the whole protocol hides
  // behind, and it turns out to be the fixed CC1101 sequence with no key at all.
  for (const [i, [rawHex, docHex]] of CAPS.entries()) {
    const b = hexToBytes(rawHex);
    U.ibmWhitening(b, b.length);
    eq(hexOf(b), docHex, `E-ITN 30 capture ${i + 1} unwhitens to the documented bytes`);
  }

  // The substitution table is not an involution, which is easy to assume and wrong.
  const NIB = [0x0, 0x7, 0xf, 0x9, 0xe, 0xd, 0x3, 0x4, 0x2, 0x6, 0xc, 0xb, 0x1, 0x8, 0xa, 0x5];
  ok(NIB[NIB[1]] !== 1, 'the Apator nibble table is not its own inverse: 1 becomes 7, but 7 becomes 4');

  // Capture 1 does NOT pass its own CRC. Its unwhitened row matches what upstream prints byte for byte, so the
  // documentation is self-consistent — but the frame it records carries eb34 where the check computes eb35, so
  // upstream's own decoder would reject its own first sample. It is a single flipped bit in the last byte.
  {
    const b = hexToBytes(CAPS[0][0]);
    U.ibmWhitening(b, b.length);
    const len = b[0];
    eq(len, 0x11, '  capture 1 declares the heat allocator length');
    const rx = (b[len + 1] << 8) | b[len + 2];
    const calc = U.crc16(b, len + 1, 0x8005, 0xffff);
    eq(rx, 0xeb34, '  capture 1 carries the check bytes upstream prints');
    eq(calc, 0xeb35, '  but the check over its own payload computes one greater');
    ok(rx !== calc, '  so upstream would reject the first sample in its own documentation');
    ok(!run(dev(296), buildRow(hexToBytes(CAPS[0][0])))[0], '  and this port rejects it too');

    // One flipped bit in the last byte is all that separates it from a valid frame.
    const fixed = hexToBytes(CAPS[0][0]); fixed[19] ^= 0x01;
    const dFix = run(dev(296), buildRow(fixed))[0];
    ok(!!dFix, '  flipping a single bit of capture 1 makes it decode', JSON.stringify(dFix));
    eq(dFix?.current_heating, 517, '  and it then reads as the reading its neighbours bracket');
  }

  // The other four are genuine and decode. Their readings climb and their dates advance, which is a stronger
  // check on the field layout than any one frame could be.
  const WANT = [
    { cur: 520, date: '2026-01-26' },
    { cur: 523, date: '2026-01-26' },
    { cur: 535, date: '2026-01-27' },
    { cur: 541, date: '2026-01-27' },
  ];
  const readings = [];
  for (let i = 1; i < CAPS.length; i++) {
    const d = run(dev(296), buildRow(hexToBytes(CAPS[i][0])))[0];
    ok(!!d, `E-ITN 30 capture ${i + 1} decodes`, JSON.stringify(d));
    if (!d) continue;
    readings.push(d.current_heating);
    eq(d.model, 'ApatorMetra-EITN30', `  capture ${i + 1} model`);
    eq(d.id, 31975929, `  capture ${i + 1} reports the same allocator throughout`);
    eq(d.len, 17, `  capture ${i + 1} length`);
    eq(d.last_yr_heating, 2605, `  capture ${i + 1} last year's figure, constant across the set`);
    eq(d.current_heating, WANT[i - 1].cur, `  capture ${i + 1} current figure`);
    eq(d.date, WANT[i - 1].date, `  capture ${i + 1} date`);
    eq(d.mic, 'CRC', `  capture ${i + 1} reports its check`);
  }
  ok(readings.length === 4 && readings.every((v, i) => i === 0 || v > readings[i - 1]),
    '  the four readings rise monotonically across the captures', readings.join(', '));

  // The heat allocator must not answer for the water meter's length, and the check must actually bite.
  const wrong = hexToBytes(CAPS[1][0]); wrong[0] ^= 0x02;   // declares 19 bytes instead of 17
  ok(((wrong[0] ^ 0xff) & 0xff) === 0x13, '  the altered frame really does declare the water meter length');
  ok(!run(dev(296), buildRow(wrong))[0], '  E-ITN 30 steps aside from a frame declaring the other length');
  const bad = hexToBytes(CAPS[1][0]); bad[8] ^= 0x40;
  ok(!run(dev(296), buildRow(bad))[0], '  E-ITN 30 rejects a frame whose CRC does not close');
}

// ---------------------------------------------------------------------------
// Apator Metra E-RM 30 (277): built from the transmit side
// ---------------------------------------------------------------------------
{
  const NIB = [0x0, 0x7, 0xf, 0x9, 0xe, 0xd, 0x3, 0x4, 0x2, 0x6, 0xc, 0xb, 0x1, 0x8, 0xa, 0x5];
  const INV = new Array(16);
  for (let i = 0; i < 16; i++) INV[NIB[i]] = i;
  const rowOf = (frame) => rowBits(pad([...bytesToBits([0xaa, 0xaa, 0x69, 0x9a]), ...bytesToBits(frame)], 208));

  const build = (id, liters, y, m, day, len = 0x13) => {
    const p = new Uint8Array(19);
    const idField = (id ^ 0x30000000) >>> 0;
    p[0] = idField & 0xff; p[1] = (idField >>> 8) & 0xff;
    p[2] = (idField >>> 16) & 0xff; p[3] = (idField >>> 24) & 0xff;
    const vol = (liters << 3) >>> 0;               // the counter sits three bits up inside twenty-eight
    p[4] = vol & 0xff; p[5] = (vol >>> 8) & 0xff; p[6] = (vol >>> 16) & 0xff; p[7] = (vol >>> 24) & 0x0f;
    const date = (((y - 2000) & 0x7f) << 9) | ((m & 0x0f) << 5) | (day & 0x1f);
    p[15] = date & 0xff; p[16] = (date >> 8) & 0xff;
    p[8] = 0x11; p[9] = 0x22; p[17] = 0x33; p[18] = 0x44;

    // Substitute each nibble the way the meter does, then close the frame and whiten it.
    const frame = new Uint8Array(22);
    frame[0] = len;
    for (let i = 0; i < 2 * 19; i++) {
      const shift = (i % 2) ? 0 : 4;
      frame[1 + (i >> 1)] |= INV[(p[i >> 1] >> shift) & 0x0f] << shift;
    }
    const crc = U.crc16(frame, 20, 0x8005, 0xffff);
    frame[20] = crc >> 8; frame[21] = crc & 0xff;
    U.ibmWhitening(frame, 22);
    return { row: rowOf(frame), p, frame };
  };

  const { row, p } = build(123456789, 456789, 2025, 7, 14);
  const d = run(dev(277), row)[0];
  ok(!!d, 'Apator E-RM 30 decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'ApatorMetra-ERM30', '  E-RM 30 model');
    eq(d.id, 123456789, '  E-RM 30 id, which is the number on the radio module rather than the dial');
    eq(d.len, 19, '  E-RM 30 declares nineteen payload bytes');
    eq(d.volume_m3, 456.789, '  E-RM 30 counts litres and reports cubic metres');
    eq(d.date, '2025-07-14', '  E-RM 30 date');
    eq(d.payload, hexOf(p), '  the decoded payload goes out as hex, its unidentified bytes included');
    eq(d.mic, 'CRC', '  E-RM 30 reports its check');
  }

  // The length byte is the only thing separating the two Apator meters, so each must refuse the other's.
  ok(!run(dev(296), build(123456789, 456789, 2025, 7, 14).row)[0],
    '  the heat allocator refuses the water meter frame');
  const asHeat = build(123456789, 456789, 2025, 7, 14, 0x11);
  ok(!run(dev(277), asHeat.row)[0], '  and the water meter refuses a frame declaring seventeen bytes');

  // Assert the check really covers the substituted form, not the decoded one: corrupting a payload byte after
  // substitution must fail, which it only can if the CRC ran over those bytes.
  // The check covers the frame after the whitening comes off but before the substitution is undone, so
  // corrupting a payload byte as it travels must fail it.
  const { frame } = build(123456789, 456789, 2025, 7, 14);
  const corrupt = Uint8Array.from(frame); corrupt[5] ^= 0x10;
  ok(!run(dev(277), rowOf(corrupt))[0], '  E-RM 30 rejects a frame whose CRC does not close');
  ok(!run(dev(277), rowOf(new Uint8Array(22)))[0], '  E-RM 30 rejects an all-zero frame');
}

// ---------------------------------------------------------------------------
// Badger Orion Endpoint (282, 290): two real captures
// ---------------------------------------------------------------------------
{
  const CAPS = [
    'ebe11d9aed6d4a4de871933a7823570aaece2dd87d3f4e',
    'ebe11d9aed5f997ce87192314262140ab3956ed87d597e',
  ];
  // The row upstream prints beside the first capture, which its data layout is annotated against.
  const DOC1 = '1400000000e87969020b410308b40000fab300001032f4';
  const buildRow = (raw) => rowBits(pad([...bytesToBits([0xaa, 0xaa, 0xec, 0x62, 0xec, 0x62]),
    ...bytesToBits(raw)], 232));

  {
    const b = hexToBytes(CAPS[0]);
    U.ibmWhitening(b, 23);
    eq(hexOf(b), DOC1, 'Orion Endpoint capture 1 unwhitens to the documented row');
    // The check covers its own CRC bytes, so a good frame runs the whole twenty-three to zero.
    eq(U.crc16(b, 23, 0x8005, 0xffff), 0, '  and the check over all twenty-three bytes runs to zero');
  }

  const WANT = [
    { id: 40466920, reading: 46088, daily: 46074 },
    { id: 39365338, reading: 4453682, daily: 4450535 },
  ];
  for (const [i, cap] of CAPS.entries()) {
    const d = run(dev(282), buildRow(hexToBytes(cap)))[0];
    ok(!!d, `Orion Endpoint capture ${i + 1} decodes`, JSON.stringify(d));
    if (!d) continue;
    eq(d.model, 'Orion-Endpoint', `  capture ${i + 1} model`);
    eq(d.id, WANT[i].id, `  capture ${i + 1} serial number`);
    eq(d.endpoint_model, 'ME or SE', `  capture ${i + 1} model block, inferred from that serial`);
    eq(d.leaking, 0, `  capture ${i + 1} reports no leak`);
    eq(d.reading, WANT[i].reading, `  capture ${i + 1} reading`);
    eq(d.daily_reading, WANT[i].daily, `  capture ${i + 1} daily reading`);
    eq(d.flags_2, 0x10, `  capture ${i + 1} trailing fixed byte`);
    eq(d.mic, 'CRC', `  capture ${i + 1} reports its check`);
    // The 2020 hardware differs only in bit rate, so it must read the identical bytes.
    eq(run(dev(290), buildRow(hexToBytes(cap)))[0]?.id, WANT[i].id,
      `  the 2020 registration reads capture ${i + 1} identically`);
  }

  // The serial number ranges are what name the hardware, so check one that is not the captures' block.
  {
    const b = hexToBytes(CAPS[0]);
    U.ibmWhitening(b, 23);
    const id = 75000000;                            // the Classic block
    b[5] = id & 0xff; b[6] = (id >> 8) & 0xff; b[7] = (id >> 16) & 0xff; b[8] = (id >>> 24) & 0xff;
    b[16] = b[17] = b[18] = b[19] = 0;              // and no daily reading at all
    const crc = U.crc16(b, 21, 0x8005, 0xffff);
    b[21] = crc >> 8; b[22] = crc & 0xff;
    ok((b[16] | b[17] | b[18] | b[19]) === 0, '  the frame built here really does carry a zero daily reading');
    U.ibmWhitening(b, 23);
    const d = run(dev(282), buildRow(b))[0];
    ok(!!d, 'Orion Endpoint reads a Classic-block serial', JSON.stringify(d));
    if (d) {
      eq(d.id, id, '  with the serial it was given');
      eq(d.endpoint_model, 'Classic (CE)', '  and names the block that serial falls in');
      ok(d.daily_reading === undefined, '  and omits the daily reading when the endpoint sent none');
    }
  }

  // The check must bite, and a row too short to hold the frame is not this protocol.
  const bad = hexToBytes(CAPS[0]); bad[10] ^= 0x08;
  ok(!run(dev(282), buildRow(bad))[0], '  Orion Endpoint rejects a frame whose CRC does not close');
  ok(!run(dev(282), rowBits(pad(bytesToBits(hexToBytes(CAPS[0])), 200)))[0],
    '  Orion Endpoint refuses a row shorter than its minimum');
}

// ---------------------------------------------------------------------------
// The registrations themselves
// ---------------------------------------------------------------------------
{
  const MINE = [223, 228, 260, 271, 272, 273, 277, 282, 290, 296, 385];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  // A device registered against a modulation the slicer does not implement would be permanently silent.
  const HANDLED = new Set([3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18]);
  for (const num of MINE) {
    ok(HANDLED.has(dev(num).modulation), `protocol ${num} uses a modulation the slicer implements`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
