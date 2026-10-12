/**
 * Twelve small OOK and FSK devices that share nothing but their size: a soil probe, a bus beacon, a shot
 * timer, a spa remote, a hot tub controller, a car key, two grill and lab thermometers, a kinetic light
 * switch, a mains socket remote, an EnOcean building-automation telegram, and a bare radio module.
 *
 * They are grouped because none of them is a family. Each is one product with one frame layout, too small to
 * earn a file, and none of them shares a manufacturer or a checksum with any other. The interesting content is
 * therefore per device rather than in anything common, and the comments sit with each one.
 *
 * Only one of the twelve publishes a frame: `opel_mokka.c` prints a complete transmission in its doc comment
 * as a binary row, grouped 1/11/5/64 rather than in bytes. That row is used directly and it settles the
 * alignment — its five type bits read 26, exactly the event number the same comment states. It also exposes a
 * genuine off-by-one in upstream's own payload extraction, described at that decoder.
 *
 * Three ship switched off upstream and are mirrored that way: EnOcean ERP1 (needs a high sample rate), CED7000
 * (no fixed id and no checksum at all), and Hanwell ML4000 (its engineering-unit conversion is unknown, so it
 * reports raw counts). `disabled` here means the same as upstream: the reading is doubtful, not suppressed.
 *
 * Several of these decoders invert the buffer in place upstream and never put it back. That is safe in C
 * because each decoder gets the buffer last, but it is not something to copy: every inversion here is done on
 * a private copy of the row, and the tests assert the shared buffer is untouched.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `wg_pb12v1.c`, `ibis_beacon.c`, `opus_xt300.c`, `enocean_erp1.c`,
 * `ced7000.c`, `rosstech_dcu706.c`, `rfm69_lowpowerlab_moteino.c`, `tr_502msv.c`, `opel_mokka.c`,
 * `florabest.c`, `hanwell_ml4000.c`, `mcpower_kinetic.c`.
 */

import { BitBuffer, bitAt } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addBytes, crc8, crc16, parity8, reflectNibbles, reverse8, xorBytes } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Bytes as lower-case hex, the form rtl_433 prints a raw code in. */
function hexOf(m: Uint8Array, n = m.length): string {
  let s = '';
  for (let i = 0; i < n; i++) s += m[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * A private copy of one row, so a decoder that has to invert its input never touches the shared buffer.
 *
 * Upstream calls `bitbuffer_invert` on the buffer every other decoder is about to be handed, and never
 * restores it. Copying costs one pass over a row and removes the whole class of problem.
 */
function copyRow(bits: BitBuffer, row: number): BitBuffer {
  const out = new BitBuffer();
  const src = bits.bb[row];
  const n = bits.bitsPerRow[row];
  for (let i = 0; i < n; i++) out.addBit(bitAt(src, i));
  return out;
}

/** One byte read at an arbitrary bit offset, as rtl_433's `bitrow_get_byte` does it. */
function bitrowGetByte(row: Uint8Array, bitIdx: number): number {
  const at = bitIdx >> 3;
  const sh = bitIdx & 7;
  return ((row[at] << sh) | (sh ? row[at + 1] >> (8 - sh) : 0)) & 0xff;
}

// ---------------------------------------------------------------------------
// WG-PB12V1 temperature probe (39)
// ---------------------------------------------------------------------------

/**
 * A generic probe whose frame is close enough to a Fine Offset WH2 that its own file admits it cannot tell
 * them apart — the two differ only in the message-type nibble, 0x3 here against 0x4 there.
 *
 * The humidity byte is not a reading: this probe has no hygrometer and pins the field to 0xff, so a byte that
 * is anything else means the frame was misread. That test runs *after* the CRC, which is the order upstream
 * uses and which the tests pin, because the two rejections mean different things to a caller.
 */
export const wgPb12v1: RDevice = register({
  num: 39,
  name: 'WG-PB12V1 Temperature Sensor',
  what: 'temperature probe',
  modulation: Modulation.OOK_PWM,
  shortWidth: 564,
  longWidth: 1476,
  resetLimit: 2500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] < 48) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    if (b[0] !== 0xff) return DECODE_ABORT_EARLY;             // preamble
    if ((b[1] & 0xf0) !== 0x30) return DECODE_ABORT_EARLY;    // message type
    if (b[5] !== crc8(b, 4, 0x31, 0, 1)) return DECODE_FAIL_MIC;
    if (b[4] !== 0xff) return DECODE_FAIL_OTHER;              // humidity is not wired up on this probe

    // The id is redrawn every time the batteries come out, so it identifies a session, not a probe.
    const id = b[3] & 0x1f;
    const tempRaw = ((b[1] & 0x0f) << 8) | b[2];

    ctx.emit({
      model: 'WG-PB12V1',
      type: 'Weather',
      id,
      temperature_C: round1((tempRaw - 400) * 0.1),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// IBIS vehicle beacon (80)
// ---------------------------------------------------------------------------

const IBIS_PREAMBLE = new Uint8Array([0xab]);

/**
 * The beacon a bus or tram sends to the stop it is pulling into, part of the German IBIS fleet system.
 *
 * Only two of its twenty-eight bytes are interpreted — the vehicle number and a counter that upstream believes
 * tracks door openings — so the whole frame also goes out as hex. That is deliberate: naming a field nobody has
 * confirmed would be worse than publishing the bytes and letting someone who has the fleet documentation read
 * them.
 *
 * The counter is a full thirty-two bits, which is the one arithmetic trap in this file: shifting a byte left by
 * twenty-four in JavaScript produces a negative number, so the top byte is scaled by multiplication instead.
 */
export const ibisBeacon: RDevice = register({
  num: 80,
  name: 'IBIS beacon',
  what: 'public transport vehicle beacon',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 30,
  longWidth: 0,
  resetLimit: 100,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // 224 bits of data behind a 12-bit run-in, give or take the last pulse.
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 232 || bits.bitsPerRow[0] > 250) return DECODE_ABORT_LENGTH;

    // The run-in is 0xaab; searching for its last eight bits finds the frame whatever the demodulator made of
    // the leading alternations. A miss returns the row length, which this same test catches.
    const pos = bits.search(0, 0, IBIS_PREAMBLE, 8);
    if (pos > 26) return DECODE_ABORT_EARLY;

    const start = pos + 8;
    if (bits.bitsPerRow[0] - start < 224) return DECODE_ABORT_LENGTH;

    const msg = bits.bytes(0, start, 224);                    // 28 bytes, the trailing pulse cut off
    if (((msg[26] << 8) | msg[27]) !== crc16(msg, 26, 0x8005, 0x0000)) return DECODE_FAIL_MIC;

    const id = ((msg[5] & 0x0f) << 12) | (msg[6] << 4) | ((msg[7] & 0xf0) >> 4);
    // Scaled rather than shifted: `msg[20] << 24` would come back signed.
    const counter = msg[20] * 0x1000000 + (msg[21] << 16) + (msg[22] << 8) + msg[23];

    ctx.emit({
      model: 'IBIS-Beacon',
      type: 'Transit',
      id,
      counter,
      code: hexOf(msg, 28),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Opus/Imagintronix XT300 soil moisture (121)
// ---------------------------------------------------------------------------

/**
 * A garden soil probe, and the loosest checksum in this file.
 *
 * Two of upstream's tests are reproduced exactly as written rather than as they read, and both are pinned by
 * the tests because either could be mistaken for a porting slip:
 *
 * The early-abort combines the preamble and the channel byte with `&&`, so a frame whose preamble is *wrong*
 * is only thrown out when its channel byte also looks right — which means a bad preamble alone still reaches
 * the checksum. Reading that as `||` would be the obvious intent, and would change which frames decode.
 *
 * The checksum is skipped entirely when the sum happens to be zero: `chk != 0 && chk != b[5]`. A frame whose
 * four covered bytes sum to a multiple of 256 is accepted with any check byte at all. Both are upstream's, and
 * the sanity limits on temperature and moisture are what actually keeps the noise out.
 */
export const opusXt300: RDevice = register({
  num: 121,
  name: 'Opus/Imagintronix XT300 Soil Moisture',
  what: 'soil moisture and temperature probe',
  modulation: Modulation.OOK_PWM,
  shortWidth: 544,
  longWidth: 932,
  gapLimit: 10000,
  resetLimit: 31000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let ret = 0;
    let failCode = 0;

    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] !== 48) { failCode = DECODE_ABORT_LENGTH; continue; }

      const b = bits.bb[row];
      if (!b[0] && !b[1] && !b[2] && !b[3]) { failCode = DECODE_FAIL_SANITY; continue; }
      // Upstream's `&&`, kept as written: see the note above.
      if (b[0] !== 0xff && ((b[1] | 0x1) & 0xfd) === 0x55) { failCode = DECODE_ABORT_EARLY; continue; }

      // Upstream masks this sum to a byte itself, so the masked helper is the right one here.
      const chk = addBytes(b, 4, 1);
      if (chk !== 0 && chk !== b[5]) { failCode = DECODE_FAIL_MIC; continue; }

      const channel = b[1] & 0x03;
      const temp = b[3] - 40;
      const moisture = b[2];

      // The advertised range is -40 to +65 C; these bounds mostly reject boiling water and impossible soil.
      if (temp > 100 || moisture > 101) { failCode = DECODE_FAIL_SANITY; continue; }

      ctx.emit({
        model: 'Opus-XT300',
        type: 'Weather',
        channel,
        temperature_C: temp,
        moisture,
        mic: 'CHECKSUM',
      });
      ret++;
    }
    return ret > 0 ? ret : failCode;
  },
});

// ---------------------------------------------------------------------------
// EnOcean ERP1 (198)
// ---------------------------------------------------------------------------

const ENOCEAN_PREAMBLE = new Uint8Array([0x55, 0x20]);

/**
 * Twelve bits on air carry eight bits of telegram, plus two complement checks and a two-bit continuation code.
 *
 * The continuation code is what ends the telegram: the loop keeps taking groups only while it reads exactly
 * one, so a short telegram is terminated by its sender rather than by a length field. That is the property
 * worth testing, and the tests do it by putting valid-looking groups *after* a terminator and checking they are
 * ignored.
 *
 * The group decoder returns either a two-bit code or a negative error, and upstream stores that in a `uint8_t`
 * — so an error becomes 0xff or 0xfc and stops the loop by failing the `== 1` test rather than by being
 * checked. Masking to a byte here reproduces that exactly. Note also that a group appends its bits to the
 * output *before* it discovers a broken complement pair, so a damaged telegram ends up a few bits long rather
 * than empty; the CRC is what then rejects it.
 */
function decode8of12(b: Uint8Array, pos: number, end: number, out: BitBuffer): number {
  if (pos + 12 > end) return DECODE_ABORT_LENGTH;

  out.addBit(bitAt(b, pos + 0));
  out.addBit(bitAt(b, pos + 1));
  const b2 = bitAt(b, pos + 2);
  out.addBit(b2);
  if (b2 !== (bitAt(b, pos + 3) ? 0 : 1)) return DECODE_FAIL_SANITY;

  out.addBit(bitAt(b, pos + 4));
  out.addBit(bitAt(b, pos + 5));
  const b6 = bitAt(b, pos + 6);
  out.addBit(b6);
  if (b6 !== (bitAt(b, pos + 7) ? 0 : 1)) return DECODE_FAIL_SANITY;

  out.addBit(bitAt(b, pos + 8));
  out.addBit(bitAt(b, pos + 9));

  return (bitAt(b, pos + 10) << 1) | bitAt(b, pos + 11);
}

/**
 * The building-automation radio behind most European wireless light switches and window contacts.
 *
 * The telegram itself is not interpreted — EnOcean profiles are a specification of their own, and which one
 * applies depends on a pairing the receiver did — so this reports the bytes and their CRC and stops there.
 *
 * Upstream ships it disabled because 125 kbps at 868 MHz needs a higher sample rate than a scanner normally
 * runs, and that is mirrored.
 */
export const enoceanErp1: RDevice = register({
  num: 198,
  name: 'EnOcean ERP1',
  what: 'building automation telegram',
  modulation: Modulation.OOK_PCM,
  shortWidth: 8,
  longWidth: 8,
  syncWidth: 0,
  tolerance: 1,
  resetLimit: 800,
  bands: [868300000],
  disabled: true,                                  // mirrors upstream: needs a high sample rate
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    // The line is inverted; invert a copy so the buffer the next decoder sees is unchanged.
    const row = copyRow(bits, 0);
    row.invert();

    const start = row.search(0, 0, ENOCEAN_PREAMBLE, 11);
    if (start >= row.bitsPerRow[0]) return DECODE_FAIL_SANITY;

    let pos = start + 11;
    const end = start + (row.bitsPerRow[0] - start);

    const out = new BitBuffer();
    let more = 0x01;
    do {
      more = decode8of12(row.bb[0], pos, end, out) & 0xff;   // a negative error wraps to a non-1 byte
      pos += 12;
    } while (pos < end && more === 0x01);

    if (out.bitsPerRow[0] < 16) return DECODE_ABORT_LENGTH;

    const nb = (out.bitsPerRow[0] - 1) >> 3;                 // every byte but the last one
    if (crc8(out.bb[0], nb, 0x07, 0x00) !== bitrowGetByte(out.bb[0], out.bitsPerRow[0] - 8)) {
      return DECODE_FAIL_MIC;
    }

    ctx.emit({
      model: 'EnOcean-ERP1',
      type: 'Automation',
      telegram: hexOf(out.bb[0], (out.bitsPerRow[0] + 7) >> 3),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// CED7000 shot timer (233)
// ---------------------------------------------------------------------------

const CED7000_SYNC = new Uint8Array([0xaa, 0x4d, 0x5e]);
const CED7000_DATA_BITS = 169;
const CED7000_TOTAL_BITS = 201;

/**
 * A competition shooting timer that broadcasts the running score to a spectator display.
 *
 * Everything is decimal on the wire: each nibble is one digit, reflected, so the times come back by reading
 * digits out rather than by scaling an integer. The two times are not laid out the same way — the final time
 * takes its hundreds digit from the high nibble of byte five while the split time takes its hundreds from the
 * *low* nibble of byte seven — which looks like a transcription error but is upstream's, and is what its own
 * layout comment describes.
 *
 * The only integrity check is where the Manchester decode stops. There is no checksum, so the frame is trusted
 * only if decoding runs to exactly one bit past a 201-bit row — 202 — which is what upstream's
 * `NUM_BITS_TOTAL + 1` means: the last pair's second half is the zero padding beyond the row. Nothing else
 * about the payload is verified, which is why upstream ships this disabled and why that is mirrored.
 */
export const ced7000: RDevice = register({
  num: 233,
  name: 'CED7000 Shot Timer',
  what: 'shooting timer',
  modulation: Modulation.FSK_PCM,
  shortWidth: 1300,
  longWidth: 1300,
  gapLimit: 3500,
  resetLimit: 9000,
  disabled: true,                                  // mirrors upstream: no fixed id and no checksum
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 6 * 16 + 3 * 8);
    if (row < 0) return DECODE_ABORT_EARLY;

    // The sync is searched the right way up, and only then is the copy inverted for decoding.
    const bitpos = bits.search(row, 0, CED7000_SYNC, 24) + 24;
    if (bitpos >= bits.bitsPerRow[row]) return DECODE_ABORT_EARLY;

    const inv = copyRow(bits, row);
    inv.invert();

    const decoded = new BitBuffer();
    const ret = inv.manchesterDecode(0, bitpos, decoded, CED7000_DATA_BITS);
    if (ret !== CED7000_TOTAL_BITS + 1) return DECODE_FAIL_MIC;

    // Upstream reflects `ret / 8` bytes, which reaches past what was decoded into zeros; harmless, and copied
    // so the reflection never touches the decode buffer twice.
    const n = (ret / 8) | 0;
    const b = new Uint8Array(n);
    b.set(decoded.bb[0].subarray(0, n));
    reflectNibbles(b, n);

    const id = (b[1] & 0xf) * 1000 + (b[1] >> 4) * 100 + (b[0] & 0xf) * 10 + (b[0] >> 4);
    const count = (b[2] & 0xf) * 10 + (b[2] >> 4);
    const final = (b[5] >> 4) * 100 + (b[4] & 0xf) * 10 + (b[4] >> 4) + (b[3] & 0xf) * 0.1 + (b[3] >> 4) * 0.01;
    const split = (b[7] & 0xf) * 100 + (b[7] >> 4) * 10 + (b[6] & 0xf) + (b[6] >> 4) * 0.1 + (b[5] & 0xf) * 0.01;

    ctx.emit({
      model: 'CED7000',
      type: 'Timer',
      id: String(id).padStart(4, '0'),
      count,
      final: round2(final),
      split: round2(split),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Rosstech DCU-706 spa control (265)
// ---------------------------------------------------------------------------

const ROSSTECH_DATA = new Uint8Array([0xdd, 0x40]);
const ROSSTECH_BOND = new Uint8Array([0xcd, 0x00]);

/**
 * Bytes carried as 8o1 serial: a start bit, eight data bits, an odd parity bit, and a stop bit.
 *
 * This is not the 8n1 or 8n2 helper in `util.ts` and differs from both in two ways worth stating, because
 * either would silently produce plausible garbage. The framing is inverted from the usual convention — the
 * start bit is a one and the stop bit a zero — and the data byte is **not** bit-reversed on the way out, where
 * both shared helpers reverse theirs.
 *
 * The parity argument is masked to a byte before the check. In C the value is passed to a `uint8_t` parameter
 * and truncated on the way in; the wide value that comes out of the shift here would give a different answer.
 */
function extractBytesUart8o1(m: Uint8Array, offsetBits: number, numBits: number, dst: Uint8Array): number {
  let ret = 0, off = offsetBits, n = numBits;
  while (n >= 11) {
    const startb = m[off >> 3] >> (7 - (off % 8));
    off += 1;
    let datab = m[off >> 3];
    if (off % 8) datab = ((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (8 - (off % 8));
    off += 8;
    const parityb = m[off >> 3] >> (7 - (off % 8));
    off += 1;
    const stopb = m[off >> 3] >> (7 - (off % 8));
    off += 1;

    if ((startb & 1) !== 1) break;                 // start-bit error
    if ((parityb & 1) !== parity8(datab & 0xff)) break;
    if ((stopb & 1) !== 0) break;                  // stop-bit error

    dst[ret++] = datab & 0xff;
    n -= 11;
    if (ret >= dst.length) break;
  }
  return ret;
}

/**
 * The handset for a Sundance or Jacuzzi hot tub, reporting the water temperature in Fahrenheit.
 *
 * Two different transmissions carry it: a plain data frame and the bonding frame a handset sends while pairing.
 * Both are looked for, and which one arrived is reported rather than hidden, since a bond frame appearing on
 * its own says someone is pressing buttons on the tub.
 *
 * The two preambles are not arbitrary constants — each is the 8o1 encoding of its own message-type byte, 0xba
 * for data and 0x9a for bond, which is why an eleven-bit search finds a frame that starts at its first bit.
 * The tests assert that relationship rather than just the byte values.
 */
export const rosstechDcu706: RDevice = register({
  num: 265,
  name: 'Rosstech Digital Control Unit DCU-706/Sundance/Jacuzzi',
  what: 'hot tub control panel',
  modulation: Modulation.OOK_PCM,
  shortWidth: 200,
  longWidth: 200,
  resetLimit: 2000,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 55 || bits.bitsPerRow[0] > 300) return DECODE_ABORT_EARLY;

    let startPos = bits.search(0, 0, ROSSTECH_DATA, 11);
    if (startPos === bits.bitsPerRow[0]) {
      startPos = bits.search(0, 0, ROSSTECH_BOND, 11);
      if (startPos === bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;
    }
    if (startPos + 55 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    const msg = bits.bytes(0, startPos, 56);
    const b = new Uint8Array(5);
    if (extractBytesUart8o1(msg, 0, 55, b) !== 5) return DECODE_ABORT_LENGTH;

    const msgType = b[0];
    const id = (b[1] << 8) | b[2];
    const tempF = b[3];

    if ((0xff ^ xorBytes(b, 4)) !== b[4]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Rosstech-Spa',
      type: 'Thermostat',
      id: id.toString(16).padStart(4, '0'),
      msg_type: msgType === 0xba ? 'Data' : 'Bond',
      temperature_F: tempF,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// RFM69 on a LowPowerLab Moteino (318)
// ---------------------------------------------------------------------------

const RFM69_SYNC = new Uint8Array([0x2d]);
const RFM69_LENGTH_POS = 5;
const RFM69_DST_ID_POS = 6;
const RFM69_SRC_ID_POS = 7;
const RFM69_DATA_START_POS = 9;
const RFM69_HEADER_LENGTH = 6;
const RFM69_MAX_LENGTH = 65;

/**
 * Not a product but a radio module: whatever an Arduino sketch chose to broadcast, in the LowPowerLab library's
 * default framing, with encryption switched off.
 *
 * Because the payload is a sketch's own bytes, it is reported as text rather than interpreted. Upstream reports
 * it only when the sender address is 2 — the gateway id in its example sketch — and returns nothing otherwise;
 * that is a hard-coded property of the sample rather than of the protocol, and it is mirrored so the two agree
 * on real traffic, but it is the reason this decoder stays quiet on most Moteino networks.
 *
 * Two upstream details are deliberately not reproduced. Its buffers overrun at the largest legal length: a
 * 65-byte payload writes 66 bytes into a 65-byte array and reads two bytes past a 72-byte one. The buffers
 * here are sized so those reads land on zeros instead of undefined behavior, which only changes what happens
 * in a case that has no defined result upstream. Its `data_make` also passes the two integer ids as
 * `DATA_STRING`, which is a straightforward bug; they go out as numbers here.
 */
export const rfm69LowpowerlabMoteino: RDevice = register({
  num: 318,
  name: 'RFM69 LowPowerLab Moteino board (-s 1000k)',
  what: 'hobby radio module',
  modulation: Modulation.FSK_PCM,
  shortWidth: 18,
  longWidth: 18,
  resetLimit: 400,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The sync word is 0x2d64 behind a run of 0xaa, so a hit lands three bytes into the buffer.
    const posn = bits.search(0, 0, RFM69_SYNC, 8);
    if (posn < 24 || posn > 28) return DECODE_ABORT_EARLY;

    const message = new Uint8Array(RFM69_MAX_LENGTH + 9);
    bits.extractBytes(0, posn - 24, message, RFM69_MAX_LENGTH * 8);

    const payloadLen = message[RFM69_LENGTH_POS];
    if (payloadLen > RFM69_MAX_LENGTH) return DECODE_ABORT_LENGTH;

    // The length byte is inside the CRC, so the payload is read from it rather than from the data.
    const payload = new Uint8Array(RFM69_MAX_LENGTH + 2);
    bits.extractBytes(0, posn + 16, payload, (payloadLen + 1) * 8);

    const crc = ~crc16(payload, payloadLen + 1, 0x1021, 0x1d0f) & 0xffff;
    if (((crc >> 8) !== message[RFM69_HEADER_LENGTH + payloadLen])
      || ((crc & 0x00ff) !== message[RFM69_HEADER_LENGTH + payloadLen + 1])) {
      return DECODE_FAIL_MIC;
    }

    // Upstream only reports the gateway's own address and leaves the other branch empty.
    if (message[RFM69_SRC_ID_POS] !== 0x02) return DECODE_FAIL_OTHER;

    message[RFM69_HEADER_LENGTH + payloadLen] = 0x00;         // terminate the text at the checksum

    let msg = '';
    for (let i = 0; i < 30; i++) {
      const c = message[RFM69_DATA_START_POS + i];
      if (c === 0) break;
      msg += String.fromCharCode(c);
    }

    ctx.emit({
      model: 'Moteino-RFM69',
      type: 'Telemetry',
      id: message[RFM69_DST_ID_POS],
      gateway_id: message[RFM69_SRC_ID_POS],
      msg,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// TR-502MSV socket remote (332)
// ---------------------------------------------------------------------------

const TR502_COMMANDS = ['OFF', 'BRIGHT', 'ON', 'DIM'];
const TR502_SOCKETS = ['1', '3', '2', '4', 'ALL'];

/**
 * A four-socket mains remote whose socket numbering is bit-reversed on the wire.
 *
 * The three socket bits are transmitted least significant first, so socket 2 goes out as 100 and socket 3 as
 * 010 — which is why the lookup is indexed by the halved value and why the table reads 1, 3, 2, 4 rather than
 * in order. Only even codes and the all-sockets code 111 exist; an odd code is a misread rather than a fifth
 * socket, and is rejected.
 *
 * The checksum is two bits over five, which is weak enough that the reserved bit and the socket encoding do
 * most of the real filtering.
 */
export const tr502msv: RDevice = register({
  num: 332,
  name: 'TR-502MSV remote smart socket controller',
  what: 'mains socket remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 740,
  longWidth: 1400,
  tolerance: 70,
  resetLimit: 84000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] !== 21) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    if ((b[0] & 0x80) === 0) return DECODE_ABORT_EARLY;       // leading one
    if ((b[2] & 0x20) !== 0) return DECODE_FAIL_SANITY;       // reserved bit

    const deviceId = ((b[0] & 0x7f) << 5) | (b[1] >> 3);
    const socketId = b[1] & 0x07;
    const onOff = (b[2] & 0x80) >> 7;
    const command = (b[2] & 0x40) >> 6;
    const chk1 = (b[2] & 0x10) >> 4;
    const chk0 = (b[2] & 0x08) >> 3;

    const s2 = (socketId >> 2) & 1;
    const s1 = (socketId >> 1) & 1;
    const s0 = socketId & 1;
    if (chk1 !== (command ^ s2 ^ s0) || chk0 !== (onOff ^ s1)) return DECODE_FAIL_MIC;

    let socket: string;
    if (socketId % 2 === 0) socket = TR502_SOCKETS[socketId >> 1];
    else if (socketId === 0x7) socket = TR502_SOCKETS[4];
    else return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'TR-502MSV',
      type: 'Remote',
      id: deviceId,
      socket_id: socket,
      command: TR502_COMMANDS[(onOff << 1) | command],
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Opel Mokka car key (333)
// ---------------------------------------------------------------------------

/**
 * A car key that sends its payload twice in one burst and uses the repeat as its only integrity check.
 *
 * This is the one device in the file with a published frame, and it settles the layout: the eighty-nine zeros
 * of run-in are followed by a start bit, eleven bits of key id, five of packet type and sixty-four of encrypted
 * payload, then an end bit, fifteen zeros, and the whole thing again. The documented row's type field reads 26,
 * exactly the event number its own comment quotes, which confirms the alignment independently of this port.
 *
 * The payload is not decrypted and no meaning is attached to the event number — lock and unlock both send 26,
 * so calling either one of them would be an invention.
 *
 * **Upstream's payload extraction is off by one against its own layout.** The type field ends at bit 105, so
 * the payload runs 106..169, but the code reads sixty-four bits from bit 107 — dropping the payload's first bit
 * and taking the end bit instead. The two id reads and the event read agree with the layout exactly, which is
 * what localizes the disagreement to this one line. It is reproduced as upstream has it, so the two projects
 * report the same string for the same transmission, and the test pins both the value upstream produces and the
 * one the layout implies.
 */
export const opelMokka: RDevice = register({
  num: 333,
  name: 'Opel Mokka Car Key',
  what: 'car key fob',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 1000,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let found = 0;

    for (let i = 0; i < bits.numRows; i++) {
      if (bits.bitsPerRow[i] !== 268) continue;

      const b = bits.bb[i];
      let leadIn = 0;
      for (let k = 0; k <= 10; k++) leadIn |= b[k];
      if (leadIn) continue;                                   // the run-in must be silent

      const idAt = (at: number): number => {
        const t = bits.bytes(i, at, 11);
        return (t[0] << 3) | (t[1] >> 5);
      };

      const keyId = idAt(90);
      if (keyId !== idAt(90 + 12 * 8 + 1)) continue;          // the second copy must agree

      // An all-zero burst satisfies the repeat check trivially; a real fob's id is never zero.
      if (keyId === 0) continue;

      const eventType = ((b[12] & 0x07) << 2) | ((b[13] & 0xc0) >> 6);

      ctx.emit({
        model: 'Opel-Mokka',
        type: 'Remote',
        id: keyId,
        event: eventType,
        code: hexOf(bits.bytes(i, 90 + 17, 64), 8),
      });
      found++;
    }
    return found;
  },
});

// ---------------------------------------------------------------------------
// Florabest FB-TH-1 grill thermometer (339)
// ---------------------------------------------------------------------------

/**
 * A Lidl barbecue thermometer, reverse engineered from captures rather than from a datasheet.
 *
 * Only the first byte of the sixteen-bit id is checked, because a single unit was ever tested and it is not
 * known whether the id identifies the device or the model — so 0x49 is treated as a model marker and the whole
 * sixteen bits are still reported. The temperature scaling is empirical and its own file says so.
 *
 * The integrity check is a single parity bit taken over the whole frame including itself, which must come out
 * odd. That is one bit of protection over thirty, so the repeat requirement of three matching rows is doing at
 * least as much work as the parity is.
 *
 * Upstream's all-zero guard sits *after* the test for 0x49 and can therefore never fire; it is kept so the two
 * files read the same, and the tests record that it is unreachable rather than pretending it is a rule.
 */
export const florabest: RDevice = register({
  num: 339,
  name: 'Florabest FB-TH-1 BBQ Thermometer',
  what: 'grill thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 6000,
  resetLimit: 11000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 30);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 30) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    if (b[0] !== 0x49) return DECODE_FAIL_SANITY;
    // Unreachable after the test above; kept to match upstream line for line.
    if (!b[0] && !b[1] && !b[2] && !b[3]) return DECODE_ABORT_EARLY;

    let parity = 0;
    for (let i = 0; i < 30; i++) parity ^= bitAt(b, i);
    if (parity !== 1) return DECODE_FAIL_MIC;

    const id = (b[0] << 8) | b[1];
    const tempRaw = (b[2] << 5) | (b[3] >> 3);

    ctx.emit({
      model: 'Florabest-FBTH1',
      type: 'Weather',
      id: id.toString(16).padStart(4, '0'),
      temperature_F: round1(tempRaw * 0.1 - 90.0),
      mic: 'PARITY',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Hanwell ML/RL4000 radiologger (371)
// ---------------------------------------------------------------------------

/**
 * A laboratory and cold-chain logger that reports two twelve-bit counts and no engineering units.
 *
 * The conversion from count to temperature and humidity lives in the Hanwell base station and is calibrated per
 * transmitter, so there is no formula to apply. Reporting the raw counts is the honest answer, and it is why
 * upstream ships this disabled — the reading is real but not yet in degrees. That flag is mirrored.
 *
 * The frame is inverted and each byte arrives least significant bit first, so both have to be undone before the
 * additive checksum agrees. Only the last row is looked at: the preamble and sync leave earlier partial rows
 * behind that the demodulator could not fully suppress.
 */
export const hanwellMl4000: RDevice = register({
  num: 371,
  name: 'Hanwell ML/RL4000-series Radiologger temperature/humidity sensor',
  what: 'laboratory temperature and humidity logger',
  modulation: Modulation.FSK_PWM,
  shortWidth: 1000,
  longWidth: 2000,
  syncWidth: 3000,
  resetLimit: 10000,
  bands: [434075000],
  disabled: true,                                  // mirrors upstream: engineering units unknown
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;

    const row = bits.numRows - 1;
    if (bits.bitsPerRow[row] !== 40) return DECODE_ABORT_LENGTH;

    // Copy first: the inversion belongs to this decoder, not to the buffer everyone shares.
    const b = bits.bytes(row, 0, 40);
    for (let i = 0; i < 5; i++) b[i] = reverse8(b[i] ^ 0xff);

    if (addBytes(b, 4) !== b[4]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Hanwell-ML4000',
      type: 'Weather',
      id: b[0],
      temperature_raw: (b[2] << 4) | (b[3] & 0x0f),
      humidity_raw: (b[1] << 4) | (b[3] >> 4),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// McPower kinetic wall switch (376)
// ---------------------------------------------------------------------------

const MCPOWER_PREAMBLE = new Uint8Array([0xaa, 0xaa]);

/**
 * A battery-less light switch: pressing the rocker generates the power that sends the frame.
 *
 * That is why the same frame repeats for as long as the harvested energy lasts, and why a repeat can arrive
 * with both button bits clear — the switch is still transmitting after the rocker has been let go. Those
 * button-less repeats are reported as they are rather than being treated as a third button.
 *
 * The flags byte has been 0x40 in every sample anyone has captured and its meaning is unknown, so it goes out
 * as a raw value. No capture was ever attached to the issue this came from — only demodulated hex — so unlike
 * most devices here there is no recording to check the CRC against; it is enforced, which at least means
 * upstream would reject every frame if its parameters were wrong.
 */
export const mcpowerKinetic: RDevice = register({
  num: 376,
  name: 'McPower Kinetic battery-less wall switch',
  what: 'kinetic wall switch',
  modulation: Modulation.FSK_PCM,
  shortWidth: 10,
  longWidth: 10,
  resetLimit: 300,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    let pos = bits.search(0, 0, MCPOWER_PREAMBLE, 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    pos += 16;

    if (bits.bitsPerRow[0] - pos < 48) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, pos, 48);
    if (crc16(b, 4, 0x1021, 0xaa55) !== ((b[4] << 8) | b[5])) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'McPower-Kinetic',
      type: 'Remote',
      id: ((b[0] << 8) | b[1]).toString(16).padStart(4, '0'),
      button_left: (b[2] >> 6) & 1,
      button_right: (b[2] >> 5) & 1,
      counter: b[2] & 0xf,
      flags: b[3].toString(16).padStart(2, '0'),
      mic: 'CRC',
    });
    return 1;
  },
});
