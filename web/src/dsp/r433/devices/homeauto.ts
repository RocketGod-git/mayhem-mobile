/**
 * Home automation: German FS20 switches and radiator valves, RojaFlex roller shutters, and Somfy's
 * io-homecontrol blinds.
 *
 * All three are command protocols rather than sensors — they carry what someone pressed, not what something
 * measured — and all three are two-way systems where the same air interface carries both the remote's command
 * and the motor's reply.
 *
 * FS20 is the awkward one. Every byte is followed by its own parity bit, so nothing is byte aligned and each
 * field has to be lifted out nine bits at a time. Its trailing checksum is not a sum of the frame but a
 * residual: subtract the fields back out and what remains should be the protocol type plus however many
 * repeaters relayed it. Only two type values are documented — six for switches and dimmers, twelve for
 * radiator valves — so the residual has to land in one of two narrow bands, and the gap between them belongs
 * to neither protocol. That check plus per-byte parity is all there is, which is why upstream ships this one
 * switched off: foreign traffic satisfies parity alone often enough to matter.
 *
 * Somfy is the best evidenced of the three. Its file publishes about forty complete packets, and all of the
 * ones checked here verify: the CRC comes out zero and the length byte agrees with the byte count every time.
 * Worth knowing when reading that file, though: its column headings sit one byte to the left of what the code
 * reads. What it prints as a four-byte destination is the control byte followed by a three-byte address, and
 * what it prints as a four-byte source is a three-byte address followed by the command id.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `fs20.c`, `rojaflex.c`, `somfy_iohc.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc16, crc16lsb, extractBytesUart8n1, parity8 } from '../util.js';

const BAND_433 = [433920000];
/** FS20 and Somfy both live in the European 868 MHz band, at slightly different spots. */
const BAND_868 = [868350000];
const BAND_868_9 = [868890000];

const hexOf = (b: Uint8Array, from: number, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += b[from + i].toString(16).padStart(2, '0');
  return s;
};

// ---------------------------------------------------------------------------
// FS20 / FHT (122)
// ---------------------------------------------------------------------------

const FS20_CMD = [
  'off', 'on, 6.25%', 'on, 12.5%', 'on, 18.75%', 'on, 25%', 'on, 31.25%', 'on, 37.5%', 'on, 43.75%',
  'on, 50%', 'on, 56.25%', 'on, 62.5%', 'on, 68.75%', 'on, 75%', 'on, 81.25%', 'on, 87.5%', 'on, 93.75%',
  'on, 100%', 'on, last value', 'toggle on/off', 'dim up', 'dim down', 'dim up/down', 'set timer',
  'status request', 'off, timer', 'on, timer', 'last value, timer', 'reset to default',
  'unused', 'unused', 'unused', 'unused',
];
const FS20_FLAGS = [
  '(none)', 'Extended', 'BiDir', 'Extended | BiDir',
  'Response', 'Response | Extended', 'Response | BiDir', 'Response | Extended | BiDir',
];
const FHT_CMD = [
  'end-of-sync', 'valve open', 'valve close', '? (0x3)', '? (0x4)', '? (0x5)', 'valve open <ext>%', '? (0x7)',
  'offset adjust', '? (0x9)', 'valve de-scale', '? (0x11)', 'sync countdown', '? (0x13)', 'beep', 'pairing?',
];
const FHT_FLAGS = [
  '(none)', 'Extended', 'BS?', 'Extended | BS?', 'Repeat', 'Repeat | Extended', 'Repeat | BS?',
  'Repeat | Extended | BS?',
];

/** One byte and the parity bit that follows it, lifted from an unaligned position. */
function fs20Byte(row: Uint8Array, pos: number): { data: number; bad: boolean } {
  const word = (((row[pos >> 3] << 8) | row[(pos >> 3) + 1]) << (pos & 7)) & 0xffff;
  const data = word >> 8;
  // parity8 gives one for an odd number of bits, which is what the transmitted bit should equal.
  return { data, bad: parity8(data) !== ((word >> 7) & 1) };
}

/** Housecodes and addresses are shown as base-four digits offset by one, the way the DIP switches read. */
function fs20Base4(value: number, digits: number): number {
  let out = 0;
  let v = value;
  for (let i = 0; i < digits; i++) {
    out += ((v % 4) + 1) << (i * 4);
    v = Math.floor(v / 4);
  }
  return out;
}

export const fs20: RDevice = register({
  num: 122,
  name: 'FS20 / FHT',
  what: 'home automation switch and radiator valve',
  modulation: Modulation.OOK_PWM,
  shortWidth: 400,
  longWidth: 600,
  resetLimit: 9000,
  bands: BAND_868,
  disabled: true,                                  // mirrors upstream: foreign traffic false-decodes here
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();

    const row = bits.bb[0];
    const rowBits = bits.bitsPerRow[0];
    const preamble = new Uint8Array([0x00, 0x10]);  // eleven zeros and a one, the tail of the run-in

    let hc = 0, address = 0, cmd = 0, ext = 0, sum = 0;
    let found = false;
    let rc: number = DECODE_FAIL_MIC;
    let bitpos = 0;

    // Upstream carries a fast scan that skips ahead a byte at a time; it is an optimization only, and the
    // straightforward search finds the same first match.
    for (;;) {
      const at = bits.search(0, bitpos, preamble, 12);
      if (at >= rowBits) break;
      const start = at + 12;
      if (start + 45 > rowBits) { rc = DECODE_ABORT_LENGTH; break; }

      bitpos = at + 1;
      ext = 0;

      const b0 = fs20Byte(row, start);
      if (b0.bad) continue;
      const b1 = fs20Byte(row, start + 9);
      if (b1.bad) continue;
      const b2 = fs20Byte(row, start + 18);
      if (b2.bad) continue;
      const b3 = fs20Byte(row, start + 27);
      if (b3.bad) continue;
      let b4 = fs20Byte(row, start + 36);
      if (b4.bad) continue;

      hc = (b0.data << 8) | b1.data;
      address = b2.data;
      cmd = b3.data;

      if (cmd & 0x20) {                            // an extended command carries one byte more
        ext = b4.data;
        if (start + 54 > rowBits) { rc = DECODE_ABORT_LENGTH; break; }
        b4 = fs20Byte(row, start + 45);
        if (b4.bad) continue;
      }
      sum = b4.data;
      found = true;
      rc = 1;
      break;
    }
    if (!found) return rc;

    // The checksum is a residual: take the fields back out and what remains is the type plus a hop count.
    let residual = sum;
    residual -= hc >> 8;
    residual -= hc & 0xff;
    residual -= address;
    residual -= cmd;
    residual -= ext;
    residual &= 0xff;

    const isFs20 = residual >= 6 && residual <= 8;
    const isFht = residual >= 0x0c && residual <= 0x0e;
    if (!isFs20 && !isFht) return DECODE_FAIL_SANITY;

    // A valve ends its sync run by sending the final value in the extension byte, so a bare command zero is
    // malformed — and it is one of the easier shapes for foreign traffic to satisfy on parity alone.
    if (isFht && (cmd & 0x0f) === 0x00 && !(cmd & 0x20)) return DECODE_FAIL_SANITY;
    // These four command codes are documented as unused and no real device sends them.
    if (isFs20 && (cmd & 0x1f) >= 0x1c) return DECODE_FAIL_SANITY;
    // A housecode is a user-set DIP pattern; all zeros is what misread foreign data tends to look like.
    if (hc === 0 && address === 0) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: isFs20 ? 'FS20' : 'FHT',
      type: 'Remote',
      housecode: fs20Base4(hc, 8),
      address: fs20Base4(address, 4),
      command: isFs20 ? FS20_CMD[cmd & 0x1f] : FHT_CMD[cmd & 0x0f],
      flags: isFs20 ? FS20_FLAGS[cmd >> 5] : FHT_FLAGS[cmd >> 5],
      ext,
      mic: 'PARITY',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// RojaFlex shutters, remotes and bridge (187)
// ---------------------------------------------------------------------------

const ROJAFLEX_CMD: Record<number, string> = {
  0x0a: 'Stop',
  0x1a: 'Up',
  0x8a: 'Down',
  0x9a: 'Save/Unsave position',                    // five presses of stop; the same code sets and clears it
  0xda: 'Go saved position',
  0xea: 'Request Status',
  0x85: 'Pos. Status 0%',
  0x95: 'Pos. Status 20%',
  0xa5: 'Pos. Status 40%',
  0xb5: 'Pos. Status 60%',
  0xc5: 'Pos. Status 80%',
  0xd5: 'Pos. Status 100%',
};

/**
 * Roller shutters, their remotes, and a bridge that impersonates a remote.
 *
 * The bridge is told apart from a real remote by what it leaves out: it clones the remote's frame but never
 * appends the CRC, so a frame that is two bytes short and claims to be a remote is the bridge talking. That
 * makes the length itself a field, which is why the integrity claim is conditional — a frame with no CRC is
 * reported without one rather than with an unearned badge.
 *
 * Upstream carries a signal-cloning block behind two compile-time flags that are both zero; it generates
 * commands for other bridges and decodes nothing, so it is not ported.
 */
export const rojaflex: RDevice = register({
  num: 187,
  name: 'RojaFlex shutter and remote devices',
  what: 'roller shutter remote',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 102400,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const preamble = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);
    const start = bits.search(0, 0, preamble, 48);
    if (start >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    // Rounded down to a whole number of bit pairs, the way upstream measures it.
    const frameBits = (bits.bitsPerRow[0] - start - 48) & 0xfe;
    if (frameBits < 72 || frameBits > 88) return DECODE_ABORT_LENGTH;

    const msg = bits.bytes(0, start + 48, frameBits);
    const hasCrc = frameBits === 88;
    if (hasCrc && crc16(msg, 9, 0x8005, 0xffff) !== ((msg[9] << 8) | msg[10])) return DECODE_FAIL_MIC;

    // The low nibble of the command byte says what is talking; a remote and the bridge share it, and only
    // the missing CRC separates them.
    const kind = msg[5] & 0x0f;
    const model = kind === 0x5 ? 'RojaFlex-Shutter'
      : kind === 0xa ? (hasCrc ? 'RojaFlex-Remote' : 'RojaFlex-Bridge')
      : 'RojaFlex-Other';

    const out: R433Data = {
      model,
      type: 'Remote',
      id: (msg[1] << 20) | (msg[2] << 12) | (msg[3] << 4) | (msg[4] >> 4),
      channel: msg[4] & 0x0f,                      // zero addresses every shutter at once
      token: (msg[7] << 8) | msg[8],
      cmd_id: msg[5],
      cmd_name: ROJAFLEX_CMD[msg[5]] ?? 'unknown',
      cmd_value: msg[6],
    };
    if (hasCrc) out.mic = 'CRC';
    ctx.emit(out);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Somfy io-homecontrol (189)
// ---------------------------------------------------------------------------

/**
 * Velux and Somfy blinds, shutters and their remotes.
 *
 * Everything after the run-in is UART framed — each byte sent as ten bits with a start and stop bit around it
 * — including the sync word, which is why the pattern searched for is the UART encoding of `ff33` rather than
 * those bytes themselves.
 *
 * The first byte carries both flags and the frame length, and the length is what bounds the CRC: it counts
 * the payload only, so the frame is three bytes longer once the two check bytes and the length byte itself
 * are counted. Every published packet checked against this agrees.
 *
 * A one-way frame ends with a counter and a six-byte authentication code; a two-way one does not, and the
 * payload runs to the end instead. The code is reported as hex rather than interpreted — it is a keyed value
 * this app has no key for, and presenting it as anything else would be inventing meaning.
 */
export const somfyIohc: RDevice = register({
  num: 189,
  name: 'Somfy io-homecontrol',
  what: 'blind and shutter remote',
  modulation: Modulation.FSK_PCM,
  shortWidth: 26,
  longWidth: 26,
  resetLimit: 300,                                 // UART framing gives at most nine zeros in a row
  bands: BAND_868_9,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    // The UART encoding of the ff33 sync word.
    const preamble = new Uint8Array([0x57, 0xfd, 0x99]);
    const offset = bits.search(0, 0, preamble, 24) + 24;
    if (offset >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const b = new Uint8Array(1 + 31 + 2);
    const numBits = Math.min(bits.bitsPerRow[0] - offset, b.length * 10);
    let len = extractBytesUart8n1(bits.bb[0], offset, numBits, b);
    if (len < 11) return DECODE_ABORT_LENGTH;

    const msgLen = b[0] & 0x1f;
    if (len < msgLen + 3) return DECODE_ABORT_LENGTH;
    if (msgLen < 8) return DECODE_ABORT_LENGTH;
    len = msgLen + 3;

    if (crc16lsb(b, len, 0x8408, 0x0000) !== 0) return DECODE_FAIL_MIC;

    const protocolMode = (b[0] & 0x20) >> 5;

    let dataLength = msgLen - 8;
    let payload = '';
    let seqNr = 0;
    let mac = '';
    if (protocolMode === 0 || dataLength < 8) {
      payload = hexOf(b, 9, dataLength);
    }
    else {
      dataLength -= 8;
      payload = hexOf(b, 9, dataLength);
      seqNr = (b[9 + dataLength] << 8) | b[9 + dataLength + 1];
      mac = hexOf(b, 9 + dataLength + 2, 6);
    }

    const out: R433Data = {
      model: 'Somfy-IOHC',
      type: 'Remote',
      // Three bytes, not the four the file's column headings suggest: the byte before is control byte two.
      id: (b[5] << 16) | (b[6] << 8) | b[7],
      dst_id: (b[2] << 16) | (b[3] << 8) | b[4],
      msg_type: b[8],
      msg: payload,
      mode: protocolMode ? 'One-way' : 'Two-way',
      version: b[1] & 0x03,
      flag_end: (b[0] & 0x80) >> 7,
      flag_start: (b[0] & 0x40) >> 6,
      flag_mode: protocolMode,
      flag_beacon: (b[1] & 0x80) >> 7,
      flag_routed: (b[1] & 0x40) >> 6,
      flag_lpm: (b[1] & 0x20) >> 5,
      mic: 'CRC',
    };
    if (protocolMode === 1) {
      out.counter = seqNr;
      out.mac = mac;                               // keyed, and reported as hex rather than interpreted
    }
    ctx.emit(out);
    return 1;
  },
});
