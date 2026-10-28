/**
 * Wireless M-Bus and the RADIAN meter.
 *
 * Every frame here is built the way a meter builds one: lay out the link-layer bytes, compute the M-Bus CRC
 * over each block, then push the result through whichever line code that mode uses — 3-of-6 for mode T,
 * Manchester for mode S, plain bytes for C and R, UART 8N2 for RADIAN. The decoder never sees a byte this file
 * did not have to encode first, so a passing assertion means the two directions agree rather than that one
 * function was checked against itself.
 *
 * The 3-of-6 table is written out in the transmit direction on purpose. It is the inverse of the one in the
 * decoder, so a transposed pair would show up as a failure here rather than canceling itself out.
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
const ones = (n) => Array.from({ length: n }, () => 1);

/** The M-Bus block CRC: their polynomial, complemented, carried big-endian. */
const mbusCrc = (b, at, n) => (~U.crc16(Uint8Array.from(b), n, 0x3d65, 0, at)) & 0xffff;
/** Two decimal digits to the byte. */
const bcdOf = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);

console.log('Wireless M-Bus');

// ---- The 8N2 serial framing, against rtl_433's own vector ----
{
  // y0 xD1 y11  y0 x11 y11  y0 x4D y11  y0 xEE y11
  const src = Uint8Array.from([0x45, 0xe8, 0x8d, 0x65, 0x9d, 0xf0]);
  const dst = new Uint8Array(8);
  const n = U.extractBytesUart8n2(src, 0, 44, dst);
  eq(n, 4, '8N2 framing recovers four bytes');
  eq(dst[0], 0xd1, '  8N2 byte 0');
  eq(dst[1], 0x11, '  8N2 byte 1');
  eq(dst[2], 0x4d, '  8N2 byte 2');
  eq(dst[3], 0xee, '  8N2 byte 3');
}

// ---------------------------------------------------------------------------
// Link-layer frame construction, shared by every mode
// ---------------------------------------------------------------------------

/** Kamstrup: K, A, M packed five bits each. */
const MFR_KAM = (11 << 10) | (1 << 5) | 13;
const ID = 12345678;
const VERSION = 0x1b;
const DEVTYPE = 0x07;                              // Water
const CONTROL = 0x44;                              // SND-NR

/** A short transport-layer header: control byte, access number, status, then a configuration word. */
const TPL = [0x7a, 0x2a, 0x00, 0x00, 0x00];

const idBcd = (id) => [
  bcdOf(id % 100),
  bcdOf(Math.floor(id / 100) % 100),
  bcdOf(Math.floor(id / 10000) % 100),
  bcdOf(Math.floor(id / 1000000) % 100),
];

/** Block 1 without its CRC: length, control, manufacturer, address, version, device type. */
const block1Head = (L) => [
  L, CONTROL, MFR_KAM & 0xff, (MFR_KAM >> 8) & 0xff, ...idBcd(ID), VERSION, DEVTYPE,
];

/**
 * Format A as the meter sends it: block 1 and its CRC, then sixteen-byte data blocks each with a CRC.
 * `payload` is everything from the transport-layer control byte onward.
 */
const buildFormatA = (payload) => {
  const L = 9 + payload.length;
  const head = block1Head(L);
  const c = mbusCrc(head, 0, 10);
  const out = [...head, (c >> 8) & 0xff, c & 0xff];
  const nBlocks = Math.floor((L - 9 + 15) / 16);
  for (let n = 0; n < nBlocks; n++) {
    const size = Math.min(L - 9 - n * 16, 16);
    const blk = [];
    for (let i = 0; i < size; i++) blk.push(payload[n * 16 + i] ?? 0);
    const bc = mbusCrc(blk, 0, size);
    out.push(...blk, (bc >> 8) & 0xff, bc & 0xff);
  }
  return out;
};

/** Format B: one CRC over block 1 and 2 together, sitting at the very end. */
const buildFormatB = (payload) => {
  // The length byte counts every byte except itself, and the two CRC bytes are part of that count.
  const L = 10 + payload.length + 2 - 1;
  const out = [...block1Head(L), ...payload];
  while (out.length < L - 1) out.push(0);
  const c = mbusCrc(out, 0, L - 1);
  out.push((c >> 8) & 0xff, c & 0xff);
  return out;
};

// The sixteen payload bytes for format A: a transport header then filler.
const PAYLOAD_A = [...TPL, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb];
const FRAME_A = buildFormatA(PAYLOAD_A);

const expectIdentity = (d, mode, what) => {
  eq(d.model, 'Wireless-MBus', `  ${what} model`);
  eq(d.mode, mode, `  ${what} mode`);
  eq(d.manufacturer, 'KAM', `  ${what} manufacturer unpacks to three letters`);
  eq(d.id, '12345678', `  ${what} serial is binary-coded decimal`);
  eq(d.version, VERSION, `  ${what} version`);
  eq(d.device_type, '07', `  ${what} device type`);
  eq(d.device_type_string, 'Water', `  ${what} device type reads as words`);
  eq(d.mic, 'CRC', `  ${what} reports its check`);
};

// ---- Mode C, format A ----
{
  const bits = [...bytesToBits([0x54, 0x3d, 0x54, 0xcd]), ...bytesToBits(FRAME_A)];
  const d = run(dev(104), rowBits(bits))[0];
  ok(!!d, 'Mode C format A decodes', JSON.stringify(d));
  if (d) {
    expectIdentity(d, 'C', 'Mode C/A');
    eq(d.control, '44', '  Mode C/A control byte');
    eq(d.CI, '7A', '  Mode C/A finds the short transport layer');
    eq(d.AC, '2A', '  Mode C/A access number');
    eq(d.ST, '00', '  Mode C/A status');
    eq(d.CW, '0000', '  Mode C/A configuration word');
    ok(d.payload_encrypted === undefined, '  Mode C/A is not flagged encrypted');
  }

  // Break block 1's CRC.
  const bad1 = [...FRAME_A]; bad1[5] ^= 0x01;
  ok(!run(dev(104), rowBits([...bytesToBits([0x54, 0x3d, 0x54, 0xcd]), ...bytesToBits(bad1)]))[0],
    '  Mode C/A rejects a frame failing block 1 CRC');
  // Break a data block's CRC, which block 1's own CRC cannot see.
  const bad2 = [...FRAME_A]; bad2[14] ^= 0x01;
  ok(!run(dev(104), rowBits([...bytesToBits([0x54, 0x3d, 0x54, 0xcd]), ...bytesToBits(bad2)]))[0],
    '  Mode C/A rejects a frame failing a data block CRC');
}

// ---- Mode C, format B ----
{
  const payload = [0x7a, 0x2a, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33];
  const frame = buildFormatB(payload);
  const bits = [...bytesToBits([0x54, 0x3d, 0x54, 0x3d]), ...bytesToBits(frame)];
  const d = run(dev(104), rowBits(bits))[0];
  ok(!!d, 'Mode C format B decodes', JSON.stringify(d));
  if (d) {
    expectIdentity(d, 'C', 'Mode C/B');
    eq(d.CI, '7A', '  Mode C/B finds the short transport layer');
    eq(d.AC, '2A', '  Mode C/B access number');
  }
  const bad = [...frame]; bad[6] ^= 0x01;
  ok(!run(dev(104), rowBits([...bytesToBits([0x54, 0x3d, 0x54, 0x3d]), ...bytesToBits(bad)]))[0],
    '  Mode C/B rejects a frame failing its CRC');
}

// ---- Mode T: the same frame, every nibble sent as six bits with three of them set ----
{
  // The transmit direction of the 3-of-6 table, nibble to symbol.
  const SYM = [22, 13, 14, 11, 28, 25, 26, 19, 44, 37, 38, 35, 52, 49, 50, 41];
  const encode3of6 = (bytes) => {
    const bits = [];
    for (const b of bytes) {
      for (const nib of [b >> 4, b & 0x0f]) {
        const s = SYM[nib];
        for (let i = 5; i >= 0; i--) bits.push((s >> i) & 1);
      }
    }
    return bits;
  };

  ok(SYM.every(s => ((s >> 0 & 1) + (s >> 1 & 1) + (s >> 2 & 1) + (s >> 3 & 1) + (s >> 4 & 1) + (s >> 5 & 1)) === 3),
    'every 3-of-6 symbol really has three bits set');

  const bits = [...bytesToBits([0x54, 0x3d]), ...encode3of6(FRAME_A)];
  const d = run(dev(104), rowBits(bits))[0];
  ok(!!d, 'Mode T decodes through the 3-of-6 line code', JSON.stringify(d));
  if (d) {
    expectIdentity(d, 'T', 'Mode T');
    eq(d.CI, '7A', '  Mode T finds the short transport layer');
  }

  // A symbol that cannot legally have been sent: six ones. The nibble is taken as zero and the CRC catches it.
  const broken = [...bits];
  for (let i = 0; i < 6; i++) broken[16 + 12 + i] = 1;
  ok(!run(dev(104), rowBits(broken))[0], '  Mode T rejects a frame carrying an illegal symbol');

  // The downlink protocol shares the callback, so it must read the same frame identically.
  const d2 = run(dev(238), rowBits(bits))[0];
  ok(!!d2, 'Mode T downlink shares the decoder', JSON.stringify(d2));
  if (d2) eq(d2.id, '12345678', '  downlink reads the same serial');
}

// ---- Mode S: Manchester-coded ----
{
  // The decoder emits the second bit of each pair, so a payload bit travels as its complement then itself.
  const manchester = (bits) => { const out = []; for (const b of bits) { out.push(b ^ 1, b); } return out; };
  const bits = [...bytesToBits([0x54, 0x76, 0x96]), ...manchester(bytesToBits(FRAME_A))];
  const d = run(dev(105), rowBits(bits))[0];
  ok(!!d, 'Mode S decodes through Manchester', JSON.stringify(d));
  if (d) {
    expectIdentity(d, 'S', 'Mode S');
    eq(d.AC, '2A', '  Mode S access number');
  }

  // A pair that does not change level is a coding violation and stops the decode short.
  const broken = [...bits];
  broken[24 + 40] = broken[24 + 41];
  ok(!run(dev(105), rowBits(broken))[0], '  Mode S rejects a Manchester coding violation');
}

// ---- Mode R: a longer preamble, plain bytes ----
{
  const bits = [...bytesToBits([0x55, 0x54, 0x76, 0x96]), ...bytesToBits(FRAME_A)];
  const d = run(dev(106), rowBits(bits))[0];
  ok(!!d, 'Mode R decodes', JSON.stringify(d));
  if (d) expectIdentity(d, 'R', 'Mode R');

  ok(dev(106).disabled === true, '  Mode R is flagged doubtful, being on a non-standard frequency');

  const bad = [...FRAME_A]; bad[2] ^= 0x01;
  ok(!run(dev(106), rowBits([...bytesToBits([0x55, 0x54, 0x76, 0x96]), ...bytesToBits(bad)]))[0],
    '  Mode R rejects a frame failing its CRC');
}

// ---- Mode F: recognized only as far as its format byte ----
{
  const bits = [...bytesToBits([0x55, 0xf6, 0x8d]), ...ones(0), ...Array.from({ length: 120 }, () => 0)];
  const d = run(dev(107), rowBits(bits))[0];
  ok(!!d, 'Mode F reports a sighting', JSON.stringify(d));
  if (d) {
    eq(d.mode, 'F', '  Mode F mode');
    eq(d.format, 'A', '  Mode F reads the format byte');
    ok(d.mic === undefined, '  Mode F claims no integrity check, because it has none');
  }
  const bitsB = [...bytesToBits([0x55, 0xf6, 0x72]), ...Array.from({ length: 120 }, () => 0)];
  eq(run(dev(107), rowBits(bitsB))[0]?.format, 'B', '  Mode F reads the other format byte');
  // An unknown format byte is not reported at all.
  const bitsX = [...bytesToBits([0x55, 0xf6, 0x99]), ...Array.from({ length: 120 }, () => 0)];
  ok(!run(dev(107), rowBits(bitsX))[0], '  Mode F says nothing about a format it does not know');
  ok(dev(107).disabled === true, '  Mode F is flagged doubtful');
}

// ---- Transport layers: what the header says about the payload ----
{
  // A long transport layer puts an eight-byte secondary address ahead of the same fields.
  const longTpl = [0x72, 1, 2, 3, 4, 5, 6, 7, 8, 0x5b, 0x11, 0x00, 0x00, 0x99, 0x88];
  const d = run(dev(104), rowBits([...bytesToBits([0x54, 0x3d, 0x54, 0xcd]), ...bytesToBits(buildFormatA(longTpl))]))[0];
  ok(!!d, 'a long transport layer decodes', JSON.stringify(d));
  if (d) {
    eq(d.CI, '72', '  long transport layer control byte');
    eq(d.AC, '5B', '  long transport layer access number sits nine bytes in');
    eq(d.ST, '11', '  long transport layer status');
  }

  // Bits 8 and 10 of the configuration word mean the records are encrypted.
  const encTpl = [0x7a, 0x2a, 0x00, 0x00, 0x05, 0x11, 0x22];
  const e = run(dev(104), rowBits([...bytesToBits([0x54, 0x3d, 0x54, 0xcd]), ...bytesToBits(buildFormatA(encTpl))]))[0];
  ok(!!e, 'an encrypted telegram still decodes its header', JSON.stringify(e));
  if (e) {
    eq(e.CW, '0500', '  the configuration word is reported');
    eq(e.payload_encrypted, 1, '  and the payload is flagged encrypted rather than guessed at');
  }
}

// ---- KNX-RF, which reuses the same framing with fixed values where the manufacturer would be ----
{
  const L = 9 + 8;
  const head = [L, CONTROL, 0xff, 0x03, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6];
  const c = mbusCrc(head, 0, 10);
  const payload = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
  const bc = mbusCrc(payload, 0, 8);
  const frame = [...head, (c >> 8) & 0xff, c & 0xff, ...payload, (bc >> 8) & 0xff, bc & 0xff];
  const d = run(dev(104), rowBits([...bytesToBits([0x54, 0x3d, 0x54, 0xcd]), ...bytesToBits(frame)]))[0];
  ok(!!d, 'KNX-RF decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'KNX-RF', '  KNX-RF is reported as itself, not as a meter');
    eq(d.sn, 'a1b2c3d4e5f6', '  KNX-RF serial');
    eq(d.knx_ctrl, '11', '  KNX-RF control byte');
  }
}

console.log('\nRADIAN meter');

// ---- RADIAN: UART 8N2 over FSK, wrapping a wired M-Bus telegram ----
{
  /** Start bit low, eight data bits least significant first, then two stop bits high. */
  const uart8n2 = (bytes) => {
    const bits = [];
    for (const b of bytes) {
      bits.push(0);
      for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
      bits.push(1, 1);
    }
    return bits;
  };

  // The wired telegram: control, address, then a long transport layer.
  const wired = [0x08, 0x01, 0x72, 1, 2, 3, 4, 5, 6, 7, 8, 0x33, 0x44, 0x55, 0x66, 0x77];
  const sum = wired.reduce((a, b) => (a + b) & 0xff, 0);
  const body = [0x68, wired.length, wired.length, 0x68, ...wired, sum, 0x16];

  const RX = [0xab, 0xcd, 0xef, 0x01, 0x23];
  const TX = [0x9a, 0xbc, 0xde, 0xf0, 0x12];
  const declared = 12 + body.length + 2;
  const frame = [declared, 0x11, ...RX, ...TX, ...body, 0, 0];
  const crc = U.crc16lsb(Uint8Array.from(frame), declared - 2, 0x8408, 0x0000);
  frame[declared - 2] = crc & 0xff;
  frame[declared - 1] = (crc >> 8) & 0xff;

  // Four lows then thirty-two idle highs is the sync tail the decoder looks for.
  const sync = [0, 0, 0, 0, ...ones(32)];
  const row = [...ones(8), ...sync, ...uart8n2(frame)];

  const d = run(dev(379), rowBits(row))[0];
  ok(!!d, 'RADIAN decodes', JSON.stringify(d));
  if (d) {
    eq(d.model, 'RADIAN', '  RADIAN model');
    eq(d.len, declared, '  RADIAN declared length');
    eq(d.control, '11', '  RADIAN control byte');
    eq(d.control_string, 'response', '  RADIAN control byte reads as a word');
    eq(d.header_variant, 'compact', '  RADIAN picks the compact header');
    eq(d.receiver_id, 'abcdef0123', '  RADIAN receiver');
    eq(d.sender_id, '9abcdef012', '  RADIAN sender');
    eq(d.id, '9abcdef012', '  RADIAN is identified by its sender');
    eq(d.body_len, body.length, '  RADIAN body length');
    eq(d.mic, 'CRC', '  RADIAN reports its check');
    // The wired telegram inside the body is found by its own markers and its header read.
    eq(d.wmbus_ci, '72', '  the wired telegram inside is found and its transport layer read');
    eq(d.wmbus_ac, '33', '  wired access number');
    eq(d.wmbus_st, '44', '  wired status');
    eq(d.wmbus_cw, '6655', '  wired configuration word is little-endian, two bytes past the status');
  }

  // A corrupted body must fail the frame CRC.
  const bad = [...frame]; bad[20] ^= 0x01;
  ok(!run(dev(379), rowBits([...ones(8), ...sync, ...uart8n2(bad)]))[0],
    '  RADIAN rejects a frame failing its CRC');

  // A missing stop bit breaks the UART framing before the CRC is ever reached.
  const short = [...ones(8), ...sync, ...uart8n2(frame)];
  short[8 + 36 + 9] = 0;                           // the first stop bit of the first byte
  ok(!run(dev(379), rowBits(short))[0], '  RADIAN rejects a frame with broken serial framing');
}

// ---- The registrations themselves ----
{
  for (const num of [104, 105, 106, 107, 238, 379]) {
    ok(!!dev(num), `protocol ${num} is registered`);
  }
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
