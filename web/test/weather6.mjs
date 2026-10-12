/**
 * The four long-deferred protocols: Emos TTX201, the Arexx logger, the TFA wind sensor and Hideki.
 *
 * Two of them publish real radio and it is used directly. TTX201 prints a whole bitbuffer — a preamble row,
 * eight repeats and a stray bit — together with the values each repeat is known to decode to, so the entire
 * transmission goes in exactly as recorded. Arexx prints five raw messages, which go in unmodified; they also
 * settle a contradiction in that file, which documents a CRC init of 0xc0 while its code uses 0x00.
 *
 * The other two publish nothing, so their frames are built from the transmit side. TFA's are the interesting
 * ones: its coding is three chained differential transforms plus a G3RUH scrambler, and the builder here runs
 * that chain forwards. It is checked against the decoder's own inverse first — a generator that cannot survive
 * a round trip is not evidence for anything built with it.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** Written from the definitions rather than imported, so building and checking stay independent. */
const rev8 = (x) => { let r = 0; for (let i = 0; i < 8; i++) if ((x >> i) & 1) r |= 0x80 >> i; return r; };
const crc8Ref = (m, n, poly, init) => {
  let r = init;
  for (let i = 0; i < n; i++) { r ^= m[i]; for (let k = 0; k < 8; k++) r = (r & 0x80) ? ((r << 1) ^ poly) & 0xff : (r << 1) & 0xff; }
  return r;
};
const crc8leRef = (m, n, poly, init) => {
  let rem = rev8(init); const p = rev8(poly);
  for (let i = 0; i < n; i++) { rem ^= m[i]; for (let b = 0; b < 8; b++) rem = (rem & 1) ? ((rem >> 1) ^ p) & 0xff : (rem >> 1); }
  return rem & 0xff;
};
const parityRef = (b) => { let n = 0; for (let i = 0; i < 8; i++) if ((b >> i) & 1) n++; return n & 1; };

const hexToBytes = (h) => Uint8Array.from(h.replace(/[^0-9a-fA-F]/g, '').match(/../g).map(x => parseInt(x, 16)));
const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const bitsToBytes = (bits) => { const o = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { if (b) o[i >> 3] |= 0x80 >> (i & 7); }); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const rowsOf = (...arrs) => { const bb = new BitBuffer(); arrs.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); }); return bb; };

console.log('Emos TTX201, Arexx Multilogger, TFA wind and Hideki');

// ---- Emos TTX201 (111): the published bitbuffer, entire ----
{
  const d = dev(111);
  const PACKETS = [
    ['07 30 80 00 42 05 3c', 54, 28, 0], ['07 70 80 04 42 05 3c', 54, 29, 1],
    ['07 b0 80 08 42 05 3c', 54, 30, 2], ['07 f0 80 0c 42 05 3c', 54, 31, 3],
    ['08 30 80 10 42 05 3c', 54, 32, 4], ['08 70 80 14 42 05 3c', 54, 33, 5],
    ['08 b0 80 18 42 05 3c', 54, 34, 6], ['08 f0 80 1c 42 05 00', 50, 35, 7],
  ];
  const packetBits = ([hex, n]) => bytesToBits(hexToBytes(hex)).slice(0, n);

  // The whole transmission as rtl_433 recorded it: 17-bit preamble, eight repeats, one stray bit.
  {
    const rows = [new Array(17).fill(0), ...PACKETS.map(packetBits), [0]];
    const out = run(d, rowsOf(...rows));
    eq(out.length, 1, 'TTX201 decodes the published transmission');
    eq(out[0]?.id, 194, 'TTX201 house code');
    eq(out[0]?.channel, 1, 'TTX201 channel');
    eq(out[0]?.battery_ok, 1, 'TTX201 battery');
    eq(out[0]?.temperature_C, 26.4, 'TTX201 temperature, as the file documents it');
    eq(out[0]?.mic, 'CHECKSUM', 'TTX201 reports a checksum');
  }

  // Every repeat carries the same reading and its own checksum; each is checked on its own.
  for (const p of PACKETS) {
    const [hex, n, wantChk, wantIdx] = p;
    const out = run(d, rowsOf(packetBits(p), packetBits(p)));
    eq(out.length, 1, `TTX201 repeat ${wantIdx} decodes alone`);
    eq(out[0]?.temperature_C, 26.4, `repeat ${wantIdx}: same temperature`);
    // The checksum really is the nibble sum the file tabulates, computed here independently.
    const b = bitsToBytes(packetBits(p).slice(2, 58));
    let sum = 0;
    for (let i = 1; i <= 5; i++) sum += (b[i] >> 4) + (b[i] & 0x0f);
    eq(b[0] & 0x3f, wantChk, `repeat ${wantIdx}: checksum field is ${wantChk}`);
    eq(sum, wantChk, `repeat ${wantIdx}: nibble sum agrees`);
    eq(b[3] >> 4, wantIdx, `repeat ${wantIdx}: packet index`);
    eq(b[5], 0x14, `repeat ${wantIdx}: postmark marks a TTX201`);
  }

  // The clock layout, built from the transmit side: a different data type in the same frame.
  {
    const b = new Uint8Array(7);
    b[1] = 0x19;                                   // year 25, CET
    b[2] = 0x50 | 0x0c;                            // data type 5, month 12
    b[3] = (24 << 3) | 0x03;                       // day 24, hour high bits
    b[4] = (0x02 << 6) | 45;                       // hour low bits, minute 45
    b[5] = (30 << 1);                              // second 30
    b[6] = 0xf0;
    let sum = 0;
    for (let i = 1; i <= 5; i++) sum += (b[i] >> 4) + (b[i] & 0x0f);
    b[0] = sum & 0x3f;
    const bits = [0, 0, ...bytesToBits(b)].slice(0, 54);
    const out = run(d, rowsOf(bits, bits));
    eq(out.length, 1, 'TTX201 decodes a clock packet');
    eq(out[0]?.radio_clock, '2025-12-24T14:45:30 CET', 'TTX201 radio clock');
    eq(out[0]?.temperature_C, undefined, 'and reports no temperature for a clock packet');
  }

  // Rejections, each with the premise that the frame is otherwise sound.
  {
    const good = packetBits(PACKETS[0]);
    const bad = [...good]; bad[10] ^= 1;           // inside the checksummed region
    ok(good.join('') !== bad.join(''), 'the corrupted repeat differs within its bits (premise)');
    eq(run(d, rowsOf(bad, bad)).length, 0, 'TTX201 rejects a bad checksum');
  }
  eq(run(d, rowsOf(new Array(54).fill(0), new Array(54).fill(0))).length, 0,
    'TTX201 rejects an all-zero transmission, which would otherwise sum to its own checksum');
  eq(run(d, rowsOf(packetBits(PACKETS[0]))).length, 0, 'TTX201 wants more than one row');
  eq(run(d, rowsOf(...new Array(11).fill(packetBits(PACKETS[0])))).length, 0,
    'TTX201 refuses a burst with too many rows');
  eq(run(d, rowsOf(new Array(40).fill(0), new Array(40).fill(0))).length, 0,
    'TTX201 refuses rows of the wrong length');
}

// ---- Arexx Multilogger (264): five published raw messages ----
{
  const d = dev(264);
  const PRE = '55555555aa';
  const MSGS = [
    ['f8 71fe fedf f777 5b a4 ff', 7, 0x01018e, { temperature_C: -18.16 }],
    ['f8 71fe fedf f727 80 7f ff', 7, 0x01018e, { temperature_C: -17.36 }],
    ['f8 71fe fedf f6e7 8e 71 ff', 7, 0x01018e, { temperature_C: -16.72 }],
    ['fa 15b2 e90f 6c ff faf7 7b1c e3', 5, 0x4dea, { temperature_C: 18.72 }],
    ['fa 14b2 f90e 51 ff faf7 7b1a e4', 5, 0x4deb, { humidity: 58.1 }],
  ];
  for (const [msg, wantLen, wantId, fields] of MSGS) {
    const out = run(d, rowOf(bytesToBits(hexToBytes(PRE + msg))));
    eq(out.length, 1, `Arexx decodes published message ${msg.slice(0, 11)}`);
    eq(out[0]?.id, wantId, `Arexx id from ${msg.slice(0, 11)}`);
    for (const [k, v] of Object.entries(fields)) eq(out[0]?.[k], v, `Arexx ${k} from ${msg.slice(0, 11)}`);
    eq(out[0]?.mic, 'CRC', 'Arexx reports a CRC');

    // The length byte, and the CRC init this file disagrees with itself about.
    const b = Uint8Array.from(hexToBytes(msg), (v) => (~v) & 0xff);
    eq(b[0], wantLen, `${msg.slice(0, 11)}: message length`);
    eq(crc8leRef(b, wantLen, 0x31, 0x00), b[wantLen], `${msg.slice(0, 11)}: verifies with init 0x00, as the code uses`);
    ok(crc8leRef(b, wantLen, 0x31, 0xc0) !== b[wantLen], `${msg.slice(0, 11)}: does NOT verify with the documented init 0xc0`);
  }

  // A humidity id and a temperature id differ by one bit, and that bit alone picks the conversion.
  {
    const t = MSGS[3], h = MSGS[4];
    eq(t[2] ^ h[2], 1, 'the two five-byte ids differ only in their lowest bit (premise)');
    const tOut = run(d, rowOf(bytesToBits(hexToBytes(PRE + t[0]))))[0];
    const hOut = run(d, rowOf(bytesToBits(hexToBytes(PRE + h[0]))))[0];
    eq(tOut?.humidity, undefined, 'the even id reports no humidity');
    eq(hOut?.temperature_C, undefined, 'the odd id reports no temperature');
  }

  // Rejections.
  {
    const bad = hexToBytes(MSGS[0][0]); bad[7] ^= 0xff;   // corrupt the CRC byte itself
    eq(run(d, rowOf(bytesToBits(Uint8Array.from([...hexToBytes(PRE), ...bad])))).length, 0,
      'Arexx rejects a bad CRC');
  }
  eq(run(d, rowOf(bytesToBits(hexToBytes(PRE + 'f8 71fe')))).length, 0, 'Arexx refuses a burst too short to hold a frame');
  eq(run(d, rowOf(new Array(200).fill(0))).length, 0, 'Arexx refuses an over-long burst');
}

// ---- TFA 30.3307.02 (367): frames built by running its coding chain forwards ----
{
  const d = dev(367);

  /** The decoder's own chain, transcribed, so the builder below can be checked against it. */
  const decodeChain = (bits) => {
    let lastBit = 0, psk = 0, lastPsk = 0, nrzs = 0, lfsr = 0;
    const out = [];
    for (const bit of bits) {
      if (bit === lastBit) psk = 1 - psk;
      if (psk === lastPsk) nrzs = 1 - nrzs;
      lastBit = bit; lastPsk = psk;
      out.push(nrzs ^ ((lfsr >>> 16) & 1) ^ ((lfsr >>> 11) & 1));
      lfsr = ((lfsr << 1) | nrzs) >>> 0;
    }
    return out;
  };
  /** Its inverse: descrambled bits back out to line bits. */
  const encodeChain = (desc) => {
    let lfsr = 0, psk = 0, lastPsk = 0, bit = 0, lastBit = 0, nrzsPrev = 0, first = true;
    const out = [];
    for (const dbit of desc) {
      const nrzs = dbit ^ ((lfsr >>> 16) & 1) ^ ((lfsr >>> 11) & 1);
      lfsr = ((lfsr << 1) | nrzs) >>> 0;
      const pskSame = first ? (nrzs !== 0) : (nrzs !== nrzsPrev);
      psk = pskSame ? lastPsk : 1 - lastPsk;
      bit = (psk !== lastPsk) ? lastBit : 1 - lastBit;
      out.push(bit);
      lastPsk = psk; lastBit = bit; nrzsPrev = nrzs; first = false;
    }
    return out;
  };

  // The builder is only evidence if it is genuinely the decoder's inverse.
  {
    const want = [];
    for (let i = 0; i < 300; i++) want.push((i * 7 + i * i) % 3 === 0 ? 1 : 0);
    const back = decodeChain(encodeChain(want));
    ok(back.length === want.length && back.every((v, i) => v === want[i]),
      'the frame builder is the exact inverse of the decoder chain (premise)');
  }

  const crc32Ref = (m, from, to, init) => {
    let c = init >>> 0;
    for (let i = from; i < to; i++) {
      c = (c ^ (m[i] << 24)) >>> 0;
      for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? (((c << 1) ^ 0x04c11db7) >>> 0) : ((c << 1) >>> 0);
    }
    return c >>> 0;
  };

  /*
   * The descrambled stream is little-endian within each byte. The shift register fills from bit 31 and the
   * decoder reads bytes back out of its top eight bits, so the oldest of any eight lands in that byte's least
   * significant position — the first bit sent is the LSB. Getting this backwards leaves the coding chain
   * perfectly valid, which is why the round-trip check above still passes; it shows up only as a sync word
   * that is never found.
   */
  const bytesToBitsLsb = (bytes) => { const o = []; for (const b of bytes) for (let i = 0; i < 8; i++) o.push((b >> i) & 1); return o; };

  /** Sync word, then length, six id bytes, payload, and a CRC-32 chosen by sensor type. */
  const tfaFrame = ({ type = 0x0b, id = [0x0b, 0x11, 0x22, 0x33, 0x44, 0x55],
                      dir = 4, speed = 37, gust = 260, age = 12, breakCrc = false } = {}) => {
    const payload = new Uint8Array(27);
    // Three bytes of sequence number, then the most recent reading as a four-byte word.
    const v = ((dir & 0x0f) << 28) | ((speed >> 8) & 1) << 25 | ((gust >> 8) & 1) << 24
      | ((speed & 0xff) << 16) | ((gust & 0xff) << 8) | (age & 0xff);
    payload[3] = (v >>> 24) & 0xff; payload[4] = (v >>> 16) & 0xff;
    payload[5] = (v >>> 8) & 0xff; payload[6] = v & 0xff;

    const plen = 11 + payload.length;
    const rdata = new Uint8Array(plen + 4);
    rdata[4] = plen;
    rdata[5] = type;
    for (let i = 1; i < 6; i++) rdata[5 + i] = id[i];
    rdata.set(payload, 11);
    const crc = crc32Ref(rdata, 4, plen, 0xe7720ae4) ^ (breakCrc ? 0xffffffff : 0);
    rdata[plen] = (crc >>> 24) & 0xff; rdata[plen + 1] = (crc >>> 16) & 0xff;
    rdata[plen + 2] = (crc >>> 8) & 0xff; rdata[plen + 3] = crc & 0xff;

    // The sync word occupies rdata[0..3]; everything from rdata[4] follows it in the descrambled stream.
    const desc = [...bytesToBitsLsb(Uint8Array.from([0x4b, 0x2d, 0xd4, 0x2b])),
                  ...bytesToBitsLsb(rdata.subarray(4))];
    // A little lead-in so the scrambler is running before the sync word arrives.
    return encodeChain([...new Array(64).fill(0), ...desc, ...new Array(16).fill(0)]);
  };

  {
    const out = run(d, rowOf(tfaFrame({})));
    eq(out.length, 1, 'TFA decodes a frame built through its own coding chain');
    eq(out[0]?.id, '0b1122334455', 'TFA device id, type byte first');
    eq(out[0]?.wind_dir_deg, 90, 'TFA wind direction is the nibble times 22.5 degrees');
    eq(out[0]?.wind_avg_m_s, 3.7, 'TFA wind speed in tenths of a metre per second');
    eq(out[0]?.wind_max_m_s, 26, 'TFA gust uses its ninth bit, parked away from the other eight');
    eq(out[0]?.mic, 'CRC', 'TFA reports a CRC');
  }
  // The ninth speed bit, which is the field most easily got wrong.
  {
    const out = run(d, rowOf(tfaFrame({ speed: 300, gust: 5 })));
    eq(out[0]?.wind_avg_m_s, 30, 'TFA speed above 25.5 m/s needs its ninth bit');
    eq(out[0]?.wind_max_m_s, 0.5, 'and the gust is unaffected by it');
  }
  { const out = run(d, rowOf(tfaFrame({ dir: 0 }))); eq(out[0]?.wind_dir_deg, 0, 'TFA direction north'); }
  { const out = run(d, rowOf(tfaFrame({ dir: 8 }))); eq(out[0]?.wind_dir_deg, 180, 'TFA direction south'); }

  eq(run(d, rowOf(tfaFrame({ breakCrc: true }))).length, 0, 'TFA rejects a bad CRC-32');
  // Another WeatherHub sensor type: its CRC init is unknown, so it is left alone rather than guessed at.
  eq(run(d, rowOf(tfaFrame({ type: 0x0c }))).length, 0, 'TFA ignores a sensor type whose CRC init is unknown');
  eq(run(d, rowOf(new Array(400).fill(0))).length, 0, 'TFA finds nothing in a burst with no sync word');
}

// ---- Hideki TS04 (42): built from the transmit side, bit-stuffed and inverted ----
{
  const d = dev(42);
  /**
   * Fields go in logical order, get reflected back to wire order, gain an XOR byte and a CRC byte, then every
   * byte is followed by its parity bit. The run-in is sent the right way up and everything after it inverted.
   */
  const hideki = (logical, { breakCrc = false, breakParity = -1, breakXor = false } = {}) => {
    const n = logical.length + 2;
    const packet = new Uint8Array(n);
    packet.set(logical, 0);
    for (let i = 0; i < logical.length; i++) packet[i] = rev8(packet[i]);   // undo the decoder's reflect
    let x = 0;
    for (let i = 0; i < n - 2; i++) x ^= packet[i];
    packet[n - 2] = x ^ (breakXor ? 0xff : 0);
    packet[n - 1] = crc8Ref(packet, n - 1, 0x07, 0x00) ^ (breakCrc ? 0xff : 0);

    const stuffed = [];
    for (let i = 0; i < n; i++) {
      const byte = packet[i];
      for (let k = 7; k >= 0; k--) stuffed.push((byte >> k) & 1);
      stuffed.push(parityRef(byte) ^ (i === breakParity ? 1 : 0));
    }
    return [0, 0, 0, 0, 0, 1, 1, 0, 1, ...inv(stuffed)];
  };

  // A thermometer and hygrometer: ten bytes unstuffed, so eight of payload plus the two checks.
  {
    // packet[1] carries the length, packet[0] the channel and rolling code, packet[3..5] the reading.
    const logical = new Uint8Array(7);
    logical[0] = (1 << 5) | 0x0a;                  // channel 1, rolling code 10
    logical[1] = (7 << 1);                         // length field: unstuffed length less two
    logical[2] = 0x1e;
    logical[3] = 0x35;                             // tens and units of a degree
    logical[4] = 0x80 | 0x40 | 0x02;               // positive, battery ok, hundreds digit
    logical[5] = 0x47;                             // 47 % relative humidity
    const out = run(d, rowOf(hideki(logical)));
    eq(out.length, 1, 'Hideki decodes a TS04 frame');
    eq(out[0]?.model, 'Hideki-TS04', 'reported as the TS04');
    eq(out[0]?.id, 10, 'Hideki rolling code');
    eq(out[0]?.channel, 1, 'Hideki channel');
    eq(out[0]?.battery_ok, 1, 'Hideki battery');
    eq(out[0]?.temperature_C, 23.5, 'Hideki temperature is three decimal digits');
    eq(out[0]?.humidity, 47, 'Hideki humidity is two decimal digits');

    // Each rejection, with the premise that this same frame decodes when left alone.
    eq(run(d, rowOf(hideki(logical, { breakCrc: true }))).length, 0, 'Hideki rejects a bad CRC');
    eq(run(d, rowOf(hideki(logical, { breakXor: true }))).length, 0, 'Hideki rejects a bad XOR check');
    eq(run(d, rowOf(hideki(logical, { breakParity: 3 }))).length, 0, 'Hideki rejects a stuffing parity error');
  }

  // A negative temperature: the sign is the top bit of the same byte that holds the hundreds digit.
  {
    const logical = new Uint8Array(7);
    logical[0] = (2 << 5) | 0x03;
    logical[1] = (7 << 1);
    logical[2] = 0x1e;
    logical[3] = 0x71;
    logical[4] = 0x40 | 0x01;                      // sign bit clear -> negative
    logical[5] = 0x30;
    const out = run(d, rowOf(hideki(logical)));
    eq(out[0]?.temperature_C, -17.1, 'Hideki reads a negative temperature');
    eq(out[0]?.channel, 2, 'Hideki channel 2');
  }

  // The length field has to agree with how many bytes actually arrived.
  {
    const logical = new Uint8Array(7);
    logical[0] = (1 << 5) | 0x01;
    logical[1] = (6 << 1);                         // claims one byte fewer than were sent
    logical[2] = 0x1e;
    logical[4] = 0x80 | 0x40;
    eq(run(d, rowOf(hideki(logical))).length, 0, 'Hideki rejects a length field that disagrees with the frame');
  }

  // A frame with no run-in at all.
  eq(run(d, rowOf(new Array(90).fill(0))).length, 0, 'Hideki refuses a burst with no run-in');
}

// ---- The registrations themselves ----
{
  for (const num of [42, 111, 264, 367]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
  // This is the tree's only user of return-to-zero inverted coding, so its slicer case matters especially.
  eq(dev(367).modulation, 13, 'the TFA wind sensor is registered as RZI');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
