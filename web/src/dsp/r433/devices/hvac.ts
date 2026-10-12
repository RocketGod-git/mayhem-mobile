/**
 * Thermostats, ceiling fan remotes, and the indoor sensors that live alongside them.
 *
 * What separates this batch from the weather sensors is that most of these devices are talking to something
 * rather than announcing themselves to anybody listening. A thermostat tells a boiler what it wants; a fan
 * remote tells a fan what to do; a gateway polls a Govee sensor and the sensor answers. That has two
 * consequences worth stating plainly. The first is that a command code with no known meaning is left as a
 * number here rather than guessed at, because a wrong label on a control message reads as fact and a raw code
 * reads as what it is. The second is that several of these carry a rolling counter, and none of it is treated
 * as a secret: the counters are reported because knowing a button was pressed twice is useful, and none of
 * them are a security measure that reporting would weaken.
 *
 * The three Govee sensors are one protocol family wearing three badges, and they overlap on purpose. All three
 * share a sync word, a 128-byte exclusive-or key that the manufacturer built into the firmware, and the same
 * frame envelope, so the interesting work is not decoding any one of them but keeping them from claiming each
 * other's frames. Upstream solved that structurally rather than by ordering — the pool thermometer demands two
 * constant bytes where the dual-probe thermometer packs its humidity, and the dual-probe one refuses any frame
 * whose humidity comes out above what air can hold, which is exactly what those two constants decode to. The
 * priorities are ported as well, but they are the belt and not the braces.
 *
 * Evidence is thin here, which is worth saying up front. Only Watts' older WFHT-RF thermostat ships real
 * captures, and all ten of them decode cleanly; everything else is built from the transmit side. Where a
 * device's own documentation could be checked against its own code, it was, and two disagreements are recorded
 * below and in `test/hvac.mjs`.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `watts_thermostat.c`, `watts_vision.c`, `watts_wfht_rf.c`,
 * `eberle_instat868r1.c`, `regency_fan.c`, `universalfanctrl.c`, `govee_h5059.c`, `govee_h5310.c`,
 * `govee_h5112.c`.
 */

import { BitBuffer, bitAt } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, addNibbles, crc8, crc16, crc16lsb, reflectBytes, xorBytes } from '../util.js';

const round1 = (x: number) => Math.round(x * 10) / 10;
const hexLow = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');

// ---------------------------------------------------------------------------
// Watts WFHT-RF thermostat (253)
// ---------------------------------------------------------------------------

/**
 * A French thermostat that says everything backwards.
 *
 * The bits arrive inverted and every field is also bit-reversed within its own bytes, which is why the port
 * reflects each field separately rather than the frame as a whole: the temperature and the set-point are nine
 * bits each and straddle byte boundaries, so there is no whole-frame reflection that would put them right.
 *
 * The checksum is the sum of those reflected field bytes, taken as a byte. That truncation is not incidental —
 * six of the ten captures rtl_433 ships sum past 255, one of them to 569 — but upstream stores the running
 * total in a `uint8_t`, so the masking the shared helper already does is the correct behavior rather than the
 * trap it usually is.
 *
 * The only flag ever identified is the pairing bit. The rest are reported as a number because nobody knows.
 */
export const wattsThermostat: RDevice = register({
  num: 253,
  name: 'Watts WFHT-RF Thermostat',
  what: 'room thermostat',
  modulation: Modulation.OOK_PWM,
  shortWidth: 260,
  longWidth: 600,
  syncWidth: 6000,
  resetLimit: 900,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    bits.invert();
    // Exactly fifty-four bits: this thermostat has one message and it is always this long.
    if (bits.bitsPerRow[0] !== 54) return DECODE_ABORT_LENGTH;
    if (bits.bytes(0, 0, 8)[0] !== 0xa5) return DECODE_ABORT_EARLY;

    const idRaw = bits.bytes(0, 8, 16);
    reflectBytes(idRaw, 2);
    const id = (idRaw[1] << 8) | idRaw[0];

    const flags = bits.bytes(0, 24, 4);
    reflectBytes(flags, 1);

    const tempRaw = bits.bytes(0, 28, 9);
    reflectBytes(tempRaw, 2);
    const temp = (tempRaw[1] << 8) | tempRaw[0];

    const setpRaw = bits.bytes(0, 37, 9);
    reflectBytes(setpRaw, 2);
    const setp = (setpRaw[1] << 8) | setpRaw[0];

    const chk = bits.bytes(0, 46, 8);
    reflectBytes(chk, 1);
    const sum = (addBytes(idRaw, 2) + addBytes(flags, 1) + addBytes(tempRaw, 2) + addBytes(setpRaw, 2)) & 0xff;
    if (chk[0] !== sum) return DECODE_FAIL_MIC;

    // An all-zero frame satisfies an all-zero checksum, so it has to be rejected by hand.
    if (id === 0 && flags[0] === 0 && temp === 0 && setp === 0 && chk[0] === 0) return DECODE_ABORT_EARLY;

    ctx.emit({
      model: 'Watts-WFHTRF',
      type: 'thermostat',
      id: String(id),
      pairing: flags[0] & 1,
      temperature_C: round1(temp * 0.1),
      setpoint_C: round1(setp * 0.1),
      flags: flags[0],                               // only bit zero, pairing, has ever been identified
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Watts WFHT-LCD-RF underfloor heating thermostat (348)
// ---------------------------------------------------------------------------

/**
 * A different Watts generation entirely, and deliberately not the one above.
 *
 * This is a CC1101 radio doing what a CC1101 radio does: a run-in, a repeated sync word, a length byte, and a
 * hardware packet checksum on the end. The application layer adds a second checksum of its own underneath —
 * an unusual one, a CRC-8 whose result is exclusive-ored with a constant and then with the call-for-heat byte,
 * so that byte is covered without being inside the CRC's own range.
 *
 * Only the two endpoints of the call-for-heat byte ever reach the air. The thermostat runs a proportional
 * controller internally and expresses a partial duty cycle as on and off time across a quarter of an hour
 * rather than as a number in between, so this reports 0 or 100 and nothing else. In cooling mode the same bit
 * means calling for cool; the field keeps the heating name because the bit itself does not take a side.
 */
export const wattsWfhtRf: RDevice = register({
  num: 348,
  name: 'Watts WFHT-RF / WFHC-MASTERH&C-RF underfloor heating thermostat',
  what: 'underfloor heating thermostat',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 460,
  longWidth: 0,
  resetLimit: 900,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] < 32 + 128) return DECODE_ABORT_LENGTH;

    const sync = new Uint8Array([0xd3, 0x91, 0xd3, 0x91]);
    const offset = bits.search(0, 0, sync, 32) + 32;
    if (offset + 128 > bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    // Sixteen bytes from the sync word: length, header, mode, id, temperature, setpoint, output, two checks.
    const b = bits.bytes(0, offset, 128);
    if (b[0] !== 0x0d) return DECODE_ABORT_EARLY;
    if (b[1] !== 0xff || b[2] !== 0xff || b[3] !== 0xfe) return DECODE_ABORT_EARLY;
    // The upper six bits of the mode byte have never been seen set; one that is set means the fixed markers
    // lined up by accident rather than that this is a real frame.
    if (b[4] & 0xfc) return DECODE_FAIL_SANITY;
    if (!b[5] && !b[6] && !b[7]) return DECODE_FAIL_SANITY;

    if (((crc8(b, 12, 0xe6, 0x00) ^ 0xbe ^ b[12]) & 0xff) !== b[13]) return DECODE_FAIL_MIC;
    if (crc16(b, 14, 0x8005, 0xffff) !== (((b[14] << 8) | b[15]) & 0xffff)) return DECODE_FAIL_MIC;

    const signed16 = (v: number) => (v & 0x8000) ? v - 0x10000 : v;
    ctx.emit({
      model: 'Watts-WFHTLCDRF',
      type: 'thermostat',
      id: `${hexLow(b[5], 2)}:${hexLow(b[6], 2)}:${hexLow(b[7], 2)}`.toUpperCase(),
      mode: (b[4] & 0x02) ? 'heat' : 'cool',
      pairing: (b[4] & 0x01) ? 'true' : 'false',
      temperature_C: round1(signed16((b[8] << 8) | b[9]) / 10),
      setpoint_C: round1(signed16((b[10] << 8) | b[11]) / 10),
      call_for_heat: b[12] === 0x64 ? 100 : 0,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Watts Vision thermostat (366)
// ---------------------------------------------------------------------------

/** Which per-zone setpoint bank a reported target belongs to. */
const VISION_SETPOINT_MODE: Record<number, string> = {
  0x00: 'Comfort', 0x01: 'Off', 0x02: 'Anti-freeze', 0x03: 'Reduced/ECO', 0x04: 'Boost/Timer',
  0x08: 'Auto (Comfort phase)', 0x0b: 'Auto (Reduced phase)', 0x10: 'Manual/Temporary',
};
/** Which sensor the thermostat is regulating from. */
const VISION_SENSOR_MODE = ['Amb', 'FLR', 'FLL', 'Air'];
/** Not a reading of 212.4 F but the sensor saying it has nothing to report. */
const VISION_TEMP_UNAVAILABLE = 0x084c;

/**
 * A thermostat that talks in records rather than in a fixed layout.
 *
 * Everything after the addresses is a stream of tag-and-value pairs, and — this is the part worth knowing —
 * the length of each value is carried in the top two bits of the tag itself. That means the stream can be
 * walked without knowing what any tag means, which is why an unrecognized tag is skipped here instead of
 * ending the parse or being guessed at from where it sat.
 *
 * The setpoint tag is the one that misleads. It does not report "the" target temperature; it reports the
 * target for one particular bank, named in the byte after it, so a frame saying 64.4 F does not contradict a
 * thermostat set to 75.2 F when the frame is describing the Reduced bank. Both are reported together for
 * exactly that reason.
 *
 * Two checksums have to hold: an inner one the application controller computes over its own payload, and an
 * outer one the radio hardware appends over everything including the inner one.
 */
export const wattsVision: RDevice = register({
  num: 366,
  name: 'Watts Vision thermostat (-f 868.3M)',
  what: 'thermostat and heating zone controller',
  modulation: Modulation.FSK_PCM,
  shortWidth: 26,
  longWidth: 26,
  resetLimit: 1000,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const pre = new Uint8Array([0xaa, 0xd3, 0x91, 0xd3, 0x91]);
    const rowLen = bits.bitsPerRow[0];
    let bitpos = bits.search(0, 0, pre, 40);
    if (bitpos >= rowLen) return DECODE_ABORT_EARLY;
    bitpos += 40;

    if (bitpos + 8 > rowLen) return DECODE_ABORT_LENGTH;
    const length = bits.bytes(0, bitpos, 8)[0];
    // Twenty is a command from the base, thirty-four a status report from an endpoint. Nothing else is known.
    if (length !== 0x14 && length !== 0x22) return DECODE_ABORT_EARLY;

    const totalBits = (length + 3) * 8;
    if (bitpos + totalBits > rowLen) return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, bitpos, totalBits);

    // The application's own checksum, stored least significant byte first.
    if (crc16lsb(b, length - 2, 0xa001, 0xffff, 1) !== (((b[length] << 8) | b[length - 1]) & 0xffff)) {
      return DECODE_FAIL_MIC;
    }
    // The radio's, over the length byte and everything up to and including the one above.
    if (crc16(b, length + 1, 0x8005, 0xffff) !== (((b[length + 1] << 8) | b[length + 2]) & 0xffff)) {
      return DECODE_FAIL_MIC;
    }
    if (b[5] !== 0xc6) return DECODE_FAIL_SANITY;

    const addr = (at: number) => hexLow((((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0), 8);
    const data: R433Data = {
      model: 'Watts-Vision',
      type: 'thermostat',
      id: addr(1),
      dest: addr(6),
      msg_type: length === 0x14 ? 'command' : 'status',
    };

    // Walk the records. The value length lives in the tag, so an unknown tag can still be stepped over.
    const recordsLen = length - 11;
    let pos = 0;
    while (pos < recordsLen) {
      const tag = b[10 + pos];
      if (tag === 0x00) break;                       // an explicit terminator, not a tag
      const valueLen = (tag >> 6) + 1;
      if (pos + 1 + valueLen > recordsLen) break;
      const v = b.subarray(10 + pos + 1);
      const be16 = (at: number) => (v[at] << 8) | v[at + 1];

      switch (tag) {
        case 0x03: data.association_id = v[0]; break;
        case 0xdf: data.state_raw = hexLow(v[0], 2) + hexLow(v[1], 2) + hexLow(v[2], 2) + hexLow(v[3], 2); break;
        case 0x3b: data.flags_raw = v[0]; break;
        case 0x8d:
          data.report_flags_0 = v[0]; data.report_flags_1 = v[1]; data.report_flags_2 = v[2];
          break;
        case 0x8a:
          if (be16(0) !== VISION_TEMP_UNAVAILABLE) data.mode_setpoint_F = round1(be16(0) / 10);
          data.setpoint_mode = VISION_SETPOINT_MODE[v[2]] ?? 'unknown';
          break;
        case 0x4b:
          if (be16(0) !== VISION_TEMP_UNAVAILABLE) data.temperature_F = round1(be16(0) / 10);
          break;
        case 0x5e:
          if (be16(0) !== VISION_TEMP_UNAVAILABLE) data.temperature_2_F = round1(be16(0) / 10);
          break;
        case 0xcc:
          // A limit of zero is one that is switched off, not a floor being held at freezing.
          if (be16(0) !== 0) data.floor_limit_1_F = round1(be16(0) / 10);
          if (be16(2) !== 0) data.floor_limit_2_F = round1(be16(2) / 10);
          break;
        case 0x8e:
          // These two are plain whole degrees Celsius, unlike every other temperature in the frame.
          data.setpoint_min_C = v[0];
          data.setpoint_max_C = v[1];
          data.sensor_mode = VISION_SENSOR_MODE[v[2] & 3];
          data.sensor_flags_raw = v[2];
          break;
        case 0x4c:
          data.diagnostic_code = v[0];
          data.diagnostic_flags = v[1];
          break;
        default: break;                              // stepped over rather than guessed at
      }
      pos += 1 + valueLen;
    }

    data.mic = 'CRC';
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Eberle Instat 868r1 floor heating remote (358)
// ---------------------------------------------------------------------------

/** The remote's four buttons, and the two codes each takes depending on whether its own id is odd. */
const EBERLE_ACTIONS: Array<[string, number, number]> = [
  ['Learn', 0x3, 0xc], ['Reset', 0xb, 0x4], ['On', 0xe, 0x1], ['Off', 0x5, 0xa],
];

/**
 * A remote whose twenty-four bits have to be read two different ways at once.
 *
 * For the checksum they are six nibbles taken exactly as received but read least significant bit first, and
 * their sum is always eleven. For the identity and the command they are the same bits Gray-decoded — a running
 * exclusive-or from the first — and then complemented, read most significant bit first. Neither reading is a
 * transformation of the other at the field level, which is why both appear below rather than one being derived
 * from the other.
 *
 * Which code means which button depends on whether the remote's own id is odd. That is not a checksum or a
 * scramble, just two code tables, and the parity of the id picks between them. On and Off carry a counter that
 * steps down by one per press; Learn and Reset carry a fixed marker in the same place.
 *
 * One upstream quirk is ported as written. The decoder hunts for a further repeat when a candidate fails its
 * checksum, but the buffer it decodes into is never cleared between attempts, so a second attempt appends to
 * the first and the checksum is recomputed over the same leading bits. The retry can therefore never succeed
 * once the first attempt has failed. `test/hvac.mjs` pins that behavior so it is recognized rather than
 * rediscovered.
 */
export const eberleInstat868r1: RDevice = register({
  num: 358,
  name: 'Eberle Instat 868r1 floor heating thermostat remote',
  what: 'floor heating remote control',
  modulation: Modulation.FSK_PCM,
  shortWidth: 400,
  longWidth: 400,
  resetLimit: 8000,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 30 + 50) return DECODE_ABORT_LENGTH;

    const pre = new Uint8Array([0x00, 0x0f, 0xe0, 0x30]);   // thirty bits of fixed run-in
    const rowLen = bits.bitsPerRow[0];
    const decoded = new BitBuffer();                        // deliberately not cleared between attempts
    let searchStart = 0, micOk = false;

    while (searchStart + 30 + 50 <= rowLen) {
      const pos = bits.search(0, searchStart, pre, 30);
      if (pos + 30 + 50 > rowLen) break;
      bits.differentialManchesterDecode(0, pos + 30, decoded, 25);
      if (decoded.bitsPerRow[0] < 25) { searchStart = pos + 30 + 1; continue; }

      // Six nibbles read least significant bit first always sum to eleven.
      let checksum = 0;
      const b = decoded.bb[0];
      for (let n = 0; n < 6; n++) {
        for (let i = 0; i < 4; i++) if (bitAt(b, 1 + n * 4 + i)) checksum += 1 << i;
      }
      if ((checksum & 0xf) !== 0xb) { searchStart = pos + 30 + 1; continue; }
      micOk = true;
      break;
    }
    if (!micOk) return DECODE_FAIL_MIC;

    // Gray-decode the same twenty-four bits, then complement, then read them as nibbles the other way up.
    const b = decoded.bb[0];
    const gray = new Uint8Array(24);
    let prev = bitAt(b, 1);
    gray[0] = prev ? 0 : 1;
    for (let i = 1; i < 24; i++) {
      prev ^= bitAt(b, 1 + i);
      gray[i] = prev ? 0 : 1;
    }
    const nib = new Uint8Array(6);
    for (let n = 0; n < 6; n++) {
      let val = 0;
      for (let i = 0; i < 4; i++) val = (val << 1) | gray[n * 4 + i];
      nib[n] = val;
    }

    const id = (nib[0] << 8) | (nib[1] << 4) | nib[2];
    const action = nib[3];
    let command = 'Unknown';
    for (const [name, odd, even] of EBERLE_ACTIONS) {
      if (action === ((id & 1) ? odd : even)) { command = name; break; }
    }

    ctx.emit({
      model: 'Eberle-Instat868r1',
      type: 'remote',
      id: hexLow(id, 3),
      command,                                       // 'Unknown' rather than a guess when the code is new
      action_code: hexLow(action, 1),
      // A fixed parity marker for Learn and Reset, a counter stepping down by one per press for On and Off.
      data: hexLow(nib[4], 1),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Regency ceiling fan remote (211)
// ---------------------------------------------------------------------------

const REGENCY_COMMANDS: Record<number, string> = {
  1: 'fan_speed', 2: 'fan_speed', 4: 'light_intensity', 5: 'light_delay', 6: 'fan_direction',
};

/**
 * A fan remote whose only protection against being misheard is saying everything four times.
 *
 * There is a four-bit checksum, but four bits over two bytes is weak enough that upstream also insists on four
 * matching repeats before it will look, and then bounds-checks each command's value against what that command
 * is known to accept. Both are ported: a speed outside one to seven, or a direction that is neither of the two
 * known codes, is rejected rather than reported, because a fan remote reporting nonsense is worse than a fan
 * remote reporting nothing.
 *
 * The channel is set by switches in the battery compartment and reads inverted — all switches off gives
 * fifteen, which says the switches pull their lines down rather than up.
 *
 * Upstream's doc comment opens by calling this PPM, but the device table right below it registers PWM, and the
 * table is what rtl_433 actually slices with. The table is followed here.
 */
export const regencyFan: RDevice = register({
  num: 211,
  name: 'Regency Ceiling Fan Remote (-f 303.75M to 303.96M)',
  what: 'ceiling fan remote control',
  modulation: Modulation.OOK_PWM,
  shortWidth: 580,
  longWidth: 976,
  gapLimit: 8000,
  resetLimit: 14000,
  bands: [303900000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    const row = bits.findRepeatedRow(4, 21);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 21) return DECODE_ABORT_LENGTH;

    // One start bit then twenty data bits. Reflection spreads those twenty across three bytes, the last of
    // which ends up holding only the checksum nibble.
    const b = bits.bytes(row, 1, 20);
    reflectBytes(b, 3);
    if ((addNibbles(b, 2) & 0x0f) !== b[2]) return DECODE_FAIL_MIC;

    const command = b[0] >> 4;
    const value = b[1];
    let valueString: string;
    switch (command) {
      case 1: valueString = 'stop'; break;
      case 2:
        if (value < 0x01 || value > 0x07) return DECODE_FAIL_SANITY;
        valueString = `speed ${value}`;
        break;
      case 4:
        if (value > 0xc3) return DECODE_FAIL_SANITY;  // 0xc3 is the remote's own idea of full
        valueString = `${value} %`;
        break;
      case 5:
        if (value !== 0x00 && value !== 0x01) return DECODE_FAIL_SANITY;
        valueString = value === 0 ? 'off' : 'on';
        break;
      case 6:
        if (value !== 0x07 && value !== 0x83) return DECODE_FAIL_SANITY;
        valueString = value === 0x07 ? 'clockwise' : 'counter-clockwise';
        break;
      default: return DECODE_FAIL_SANITY;             // an unknown command is not reported at all
    }

    ctx.emit({
      model: 'Regency-Remote',
      type: 'remote',
      channel: ~b[0] & 0x0f,                         // the compartment switches read inverted
      command: REGENCY_COMMANDS[command],
      value: valueString,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Universal reversible 24V fan controller (286)
// ---------------------------------------------------------------------------

/** The fifteen buttons this controller is known to have. Anything else is reported by its number alone. */
const UNIFAN_BUTTONS: Record<number, string> = {
  0x19: 'All Off', 0x17: 'Light On/Off', 0x1b: 'Forward', 0x0a: 'Fan', 0x0e: 'Reverse', 0x09: 'Fan Off',
  0x0f: 'Speed 1', 0x0d: 'Speed 2', 0x03: 'Speed 3', 0x15: 'Speed 4', 0x10: 'Speed 5', 0x13: 'speed 6',
  0x1d: '1H', 0x16: '2H', 0x06: '3H',
};

/**
 * A generic fan controller whose checksum sits inside its own coverage.
 *
 * The four-bit check is not computed over the message and appended; it is included in the exclusive-or that
 * produces it, and the test is that folding the result's two nibbles together gives ten. That is fine to
 * verify and awkward to construct, which is worth knowing when building a frame to test it: the check nibble
 * has to be solved for rather than computed forwards.
 *
 * Thirty-three bits, the last of which is always one — a cheap structural test that costs nothing and catches
 * a truncated burst.
 */
export const universalFanCtrl: RDevice = register({
  num: 286,
  name: 'Universal (Reverseable) 24V Fan Controller',
  what: 'ceiling fan remote control',
  modulation: Modulation.OOK_PWM,
  shortWidth: 256,
  longWidth: 756,
  gapLimit: 8000,
  syncWidth: 3616,
  resetLimit: 8800,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(3, 33);
    if (row < 0) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];
    if (!(b[4] & 0x80)) return DECODE_FAIL_SANITY;

    // The check nibble is part of what is exclusive-ored, so the two nibbles of the result fold to ten.
    const x = xorBytes(b, 4);
    if ((((x >> 4) ^ (x & 0xf)) & 0xf) !== 0xa) return DECODE_FAIL_MIC;

    const address = (b[0] << 12) + (b[1] << 4) + (b[2] >> 4);
    const button = ((b[2] & 0x0f) << 1) + ((b[3] & 0x80) >> 7);

    ctx.emit({
      model: 'UniFan-24V',
      type: 'remote',
      id: String(address),
      button: UNIFAN_BUTTONS[button] ?? 'Unknown',   // named only where the name is known
      button_code: button,
      counter: (b[3] & 0x7f) >> 4,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// The Govee family: one protocol, three products (300, 349, 350)
// ---------------------------------------------------------------------------

/**
 * These three sensors report on 912 MHz, in the American 902-928 MHz band their gateway shares.
 */
const GOVEE_BANDS = [912000000, 915000000];

const GOVEE_SYNC = new Uint8Array([0x2c, 0x4c, 0x4a]);
/** The same sync word one bit late, which is how it arrives when the demodulator locks a bit off. */
const GOVEE_SYNC_SKEW1 = new Uint8Array([0x16, 0x26, 0x25]);
/**
 * The obfuscation key, recovered from a firmware dump of the leak detector and shared by the whole family.
 *
 * It is a fixed string exclusive-ored over the payload starting at an offset the frame itself carries, so it
 * hides the payload from a casual look and from nothing else. It is not treated here as encryption because it
 * is not encryption — there is no key material a listener does not already have.
 */
const GOVEE_KEY = 's6amyEvO8UslCY0eZjgc2S6APCVLgLxzFvL2Z5GWPW7fKVjy2oAU6uiKU3lZCHm62VYQQuCtgxzPgGd8UDRPVZpDRAsh5EdYq1E4j4morJ3vd6tWx8BiWOLDc2I8wKUK';
const GOVEE_MAX_FRAME = 128;

interface GoveeFrame { frame: Uint8Array; bytesAfterSync: number; }

/** Find the sync word in any row and lift the bytes that follow it. */
function goveeFindFrame(bits: BitBuffer): GoveeFrame | number {
  let row = -1, syncPos = 0;
  for (let r = 0; r < bits.numRows; r++) {
    if (bits.bitsPerRow[r] < 8 * 7) continue;
    const pos = bits.search(r, 0, GOVEE_SYNC, 24);
    if (pos < bits.bitsPerRow[r]) { row = r; syncPos = pos; break; }
    const skew = bits.search(r, 0, GOVEE_SYNC_SKEW1, 24);
    if (skew < bits.bitsPerRow[r]) { row = r; syncPos = skew + 1; break; }
  }
  if (row < 0) return DECODE_ABORT_EARLY;

  syncPos += 24;
  const bitsAfter = bits.bitsPerRow[row] - syncPos;
  if (bitsAfter < 32) return DECODE_ABORT_LENGTH;
  let n = bitsAfter >> 3;
  if (n > GOVEE_MAX_FRAME) n = GOVEE_MAX_FRAME;
  return { frame: bits.bytes(row, syncPos, n * 8), bytesAfterSync: n };
}

/** Check the frame's own CRC and undo the exclusive-or, or return null if the CRC does not hold. */
function goveeDecrypt(frame: Uint8Array, encLen: number): Uint8Array | null {
  const crcRecv = ((frame[2 + encLen] << 8) | frame[3 + encLen]) & 0xffff;
  if (crc16(frame, encLen, 0x1021, 0x1d0f, 2) !== crcRecv) return null;
  const seed = frame[1];
  const dec = new Uint8Array(encLen);
  for (let i = 0; i < encLen; i++) dec[i] = frame[2 + i] ^ GOVEE_KEY.charCodeAt((i + seed) % 128);
  return dec;
}

/** Every device in the family reports the wire address and the same address with its halves swapped. */
function goveeIds(dec: Uint8Array, at: number): { id: string; id_wire: string } {
  const wire = (((dec[at] << 24) | (dec[at + 1] << 16) | (dec[at + 2] << 8) | dec[at + 3]) >>> 0);
  const swapped = ((((wire & 0xffff) << 16) | ((wire >>> 16) & 0xffff)) >>> 0);
  return { id: hexLow(swapped, 8), id_wire: hexLow(wire, 8) };
}

/**
 * Govee's pool and spa thermometer.
 *
 * Three frame shapes carry a temperature, and they are told apart by their outer length alone — a forced
 * report, the ten-minute broadcast, and a reply to a poll. The first puts a constant byte where the other two
 * do not, so every field after it shifts by one; that is the whole difference between the layouts.
 *
 * The reply frame is the one that collides with the dual-probe thermometer below, sharing both its length and
 * its marker byte. The two constants at bytes eight and nine settle it: this sensor always has them, and the
 * other sensor cannot produce them because they would mean a humidity above what air can hold.
 *
 * The temperature offset was fitted twice. A calibration sweep gave one number, then live readings against the
 * sensor's own display showed everything a degree low, and the corrected value is what is used here. Below
 * freezing is unverified — the formula simply keeps counting down and nobody has held one in the cold.
 */
export const goveeH5310: RDevice = register({
  num: 349,
  name: 'Govee Pool/Spa Thermometer H5310',
  what: 'pool and spa thermometer',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 2000,
  bands: GOVEE_BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const found = goveeFindFrame(bits);
    if (typeof found === 'number') return found;
    const { frame, bytesAfterSync } = found;

    const outerLen = frame[0];
    const isTemp = outerLen === 0x10, isPeriodic = outerLen === 0x3d, isStatus = outerLen === 0x1f;
    if (!isTemp && !isPeriodic && !isStatus) return DECODE_ABORT_EARLY;
    if (bytesAfterSync < 1 + outerLen) return DECODE_ABORT_LENGTH;

    const dec = goveeDecrypt(frame, outerLen - 3);
    if (!dec) return DECODE_FAIL_MIC;

    const marker = isTemp ? 0x11 : isPeriodic ? 0x1b : 0x71;
    if (dec[0] !== marker) return DECODE_ABORT_EARLY;

    // The forced report carries an extra constant byte, so its battery and temperature sit one byte later.
    const at = isTemp ? 6 : 5;
    if (isStatus && (dec[8] !== 0xcc || dec[9] !== 0xff)) return DECODE_ABORT_EARLY;

    const batteryPct = dec[at];
    const raw = dec[at + 1] | (dec[at + 2] << 8);
    const temperatureC = (raw - 33168) / 10;
    // Other devices in this family can pass the checks above with a different layout underneath; a reading
    // outside what a pool thermometer could be sitting in is how those are turned away.
    if (temperatureC < -20 || temperatureC > 60) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Govee-H5310',
      type: 'thermometer',
      ...goveeIds(dec, 1),
      event: isTemp ? 'Temperature Update' : isPeriodic ? 'Periodic Update' : 'Status',
      battery_ok: batteryPct > 0 ? 1 : 0,
      battery_pct: batteryPct,
      temperature_C: round1(temperatureC),
      mic: 'CRC',
    });
    return 1;
  },
});

/**
 * Govee's dual-probe thermometer, which packs three readings into one thirty-two bit word.
 *
 * Eleven bits for each probe and ten for the humidity, all little-endian and none of them byte-aligned. That
 * layout is not fitted from captures: it was read out of the firmware's own packing routine, and re-encoding
 * readings from the phone app reproduces the transmitted bytes exactly.
 *
 * The frame also carries its own last ten minutes. Ten four-byte records in the same packed layout, one a
 * minute, oldest first — so a single reception gives an hour's worth of shape rather than one point. Those are
 * reported as arrays.
 *
 * A humidity above what air can hold is impossible, and is also exactly what the pool thermometer's two
 * constant bytes decode to here, so that bound is what keeps the two apart rather than the ordering.
 */
export const goveeH5112: RDevice = register({
  num: 350,
  name: 'Govee H5112 Dual-Probe Thermometer',
  what: 'dual probe thermometer and hygrometer',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 2000,
  bands: GOVEE_BANDS,
  priority: 5,                                       // after the pool thermometer, before the leak detector
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const found = goveeFindFrame(bits);
    if (typeof found === 'number') return found;
    const { frame, bytesAfterSync } = found;

    const outerLen = frame[0];
    if (outerLen < 4 || outerLen > GOVEE_MAX_FRAME - 1) return DECODE_FAIL_SANITY;
    if (bytesAfterSync < 1 + outerLen) return DECODE_ABORT_LENGTH;

    const encLen = outerLen - 3;
    if (encLen < 10 || encLen > GOVEE_MAX_FRAME) return DECODE_ABORT_EARLY;

    const dec = goveeDecrypt(frame, encLen);
    if (!dec) return DECODE_FAIL_MIC;

    const msgClass = dec[0];
    // The ten-minute broadcast and the reply to a gateway poll. Each has one fixed length, and a frame
    // claiming one of these classes at the wrong length belongs to something else in the family.
    if (msgClass === 0x13) { if (encLen !== 57) return DECODE_ABORT_EARLY; }
    else if (msgClass === 0x71) { if (encLen !== 28) return DECODE_ABORT_EARLY; }
    else return DECODE_ABORT_EARLY;

    const unpack = (at: number) => {
      const packed = ((dec[at] | (dec[at + 1] << 8) | (dec[at + 2] << 16) | (dec[at + 3] << 24)) >>> 0);
      return {
        t1: (packed >>> 11) & 0x7ff,
        t2: packed & 0x7ff,
        h: (packed >>> 22) & 0x3ff,
      };
    };
    const live = unpack(6);
    const humidity = live.h / 10;
    // Air cannot hold this much, and the pool thermometer's own constants land here at 102.3 percent.
    if (humidity > 100) return DECODE_FAIL_SANITY;

    const data: R433Data = {
      model: 'Govee-H5112',
      type: 'thermometer',
      ...goveeIds(dec, 1),
      battery_ok: dec[5] > 0 ? 1 : 0,
      battery_pct: dec[5],
      temperature_C: round1(live.t1 / 10 - 40),
      temperature_2_C: round1(live.t2 / 10 - 40),
      humidity: round1(humidity),
    };

    if (msgClass === 0x13 && encLen >= 17 + 40) {
      const t1: number[] = [], t2: number[] = [], hum: number[] = [];
      for (let i = 0; i < 10; i++) {
        const r = unpack(17 + i * 4);
        t1.push(round1(r.t1 / 10 - 40));
        t2.push(round1(r.t2 / 10 - 40));
        hum.push(round1(r.h / 10));
      }
      data.temperature_C_history = t1;
      data.temperature_2_C_history = t2;
      data.humidity_history = hum;
    }

    data.mic = 'CRC';
    ctx.emit(data);
    return 1;
  },
});

/** Which probe pair found water, and what the sensor was doing when it said so. */
const GOVEE_H5059_SUBTYPES: Record<number, string> = { 0x05: 'Button Press', 0x06: 'Water Leak', 0x07: 'Post Alarm' };

/**
 * Govee's water leak detector, the device this whole family's protocol was reverse engineered from.
 *
 * Two probe pairs, top and bottom, each with its own flag, plus a third byte saying the alarm is sounding. All
 * three matter: an earlier version of the upstream decoder required the bottom flag specifically, so a leak
 * found by the top probe alone was reported as ordinary telemetry and never as a leak at all. What is checked
 * here is the alarm byte together with either probe, and which probe it was is reported separately.
 *
 * The follow-up frame is deliberately not read as an all-clear. It is sent when the probe dries, but also when
 * somebody silences the alarm for an hour with the button, and those two cannot be told apart from the bits —
 * so it is reported as what it is and no dryness is claimed.
 *
 * This runs last of the three because it accepts the widest range of frames; the other two claim their own
 * shapes first.
 */
export const goveeH5059: RDevice = register({
  num: 300,
  name: 'Govee Water Leak Detector H5059',
  what: 'water leak detector',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 2000,
  bands: GOVEE_BANDS,
  priority: 10,                                      // the loosest of the three, so it runs last
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const found = goveeFindFrame(bits);
    if (typeof found === 'number') return found;
    const { frame, bytesAfterSync } = found;

    const outerLen = frame[0];
    if (outerLen < 4 || outerLen > GOVEE_MAX_FRAME - 1) return DECODE_FAIL_SANITY;
    if (bytesAfterSync < 1 + outerLen) return DECODE_ABORT_LENGTH;

    // Upstream decrypts into a sixty-four byte buffer, so a longer payload is refused outright.
    const encLen = outerLen - 3;
    if (encLen < 8 || encLen > 64) return DECODE_FAIL_SANITY;

    const dec = goveeDecrypt(frame, encLen);
    if (!dec) return DECODE_FAIL_MIC;
    if (encLen < 19) return DECODE_FAIL_SANITY;

    const msgClass = dec[0];
    const subtype = dec[13], leakTop = dec[14], leakBottom = dec[15], leakAlarm = dec[17];

    let event: string;
    let wet = -1;
    if (msgClass === 0x11) {
      event = 'Telemetry';
      if (subtype === 0x05) { event = GOVEE_H5059_SUBTYPES[0x05]; wet = 0; }
      else if (subtype === 0x06 && leakAlarm !== 0 && (leakTop === 1 || leakBottom === 1)) {
        event = GOVEE_H5059_SUBTYPES[0x06];
        wet = 1;
      }
      // Not read as an all-clear: the same subtype covers the probe drying and the alarm being silenced.
      else if (subtype === 0x07) event = GOVEE_H5059_SUBTYPES[0x07];
    }
    else if (msgClass === 0x01) event = 'Pairing';
    else if (msgClass === 0x02) event = 'Class 0x02';
    else return DECODE_ABORT_EARLY;

    const data: R433Data = {
      model: 'Govee-H5059',
      type: 'leak detector',
      ...goveeIds(dec, 1),
      event,
      msg_class: msgClass,
      subtype,
      mic: 'CRC',
    };
    if (wet >= 0) data.detect_wet = wet;
    if (wet === 1) {
      data.leak_top = leakTop === 1 ? 1 : 0;
      data.leak_bottom = leakBottom === 1 ? 1 : 0;
    }
    ctx.emit(data);
    return 1;
  },
});
