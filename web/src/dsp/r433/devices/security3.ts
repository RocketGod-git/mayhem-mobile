/**
 * Alarm sensors that lean on repetition instead of arithmetic, and two strays that came with the batch.
 *
 * The six security devices here are the cheap end of the market, and it shows in what protects them. Kerui,
 * the generic motion sensor and the Amazon thermometer carry no check of any kind — what stands between them
 * and a burst of noise is that the sensor says the same thing nine, three or four times over, and the decoder
 * refuses to believe a frame it has not seen repeated. That makes the repeat counts load-bearing in a way a
 * checksum never is: lower one and the decoder starts inventing readings, so they are ported exactly.
 *
 * Above that sit two single-bit checks (X10 folds five bytes down to one parity bit, Honeywell counts the bits
 * in the whole frame) and, at the top, SimpliSafe's third generation, which is the only device in this file
 * with real cryptography — a CMAC and an encrypted body behind a CRC-16.
 *
 * SimpliSafe's earlier generation is the one worth pausing on. It sends the keypad's disarm PIN in clear, four
 * digits packed into two bytes, protected by nothing at all. That is not a flaw in this port; it is what the
 * system transmits, and decoding it is how anyone would find out.
 *
 * Two devices in this batch are not alarm sensors and are not pretending to be: the Amazon Basics meat
 * thermometer and the Cellular Tracking Technologies wildlife tag. They are here because they arrived in the
 * same slice of the protocol list, and moving them would only scatter the family further.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `kerui.c`, `generic_motion.c`, `x10_sec.c`, `simplisafe.c`,
 * `honeywell_wdb.c` (both devices), `abmt.c`, `simplisafe_gen3.c`, `ctt_life_power_hybrid.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, crc16, parityBytes, reverse8 } from '../util.js';

const hex = (v: number, digits: number) => (v >>> 0).toString(16).padStart(digits, '0');

const BAND_433 = [433920000];

// ---------------------------------------------------------------------------
// Kerui PIR and contact sensors (68)
// ---------------------------------------------------------------------------

/**
 * What the sensor is reporting. Upstream names these and nothing else, so an unrecognized code is refused
 * rather than guessed at — there is no way to tell a fifth event apart from a frame that sliced badly.
 */
const KERUI_STATE: Record<number, string> = {
  0xa: 'motion', 0xe: 'open', 0x7: 'close', 0xb: 'tamper', 0x5: 'water', 0xf: 'battery',
};

/**
 * The generic 1527-style alarm sensor sold under the Kerui name and a dozen others: a PIR, a door magnet, a
 * water leak probe, all sending the same twenty-four bits.
 *
 * There is no checksum, so the integrity check is entirely the repeat count. The sensor sends twenty-five
 * copies and upstream demands nine of them agree; that number is the whole defense and is copied exactly.
 *
 * The bits arrive inverted — a short pulse means a one — which the decoder undoes in place before reading. The
 * all-zero test runs before the inversion, so what it rejects is a frame that was all ones on the air.
 *
 * A twenty-fifth bit rides along in front of each packet, the tail of a wide sync gap that runs into the
 * previous transmission. It is counted but never read.
 */
export const kerui: RDevice = register({
  num: 68,
  name: 'Kerui PIR / Contact Sensor',
  what: 'alarm motion, door contact and water leak sensors',
  modulation: Modulation.OOK_PWM,
  shortWidth: 420,
  longWidth: 960,
  gapLimit: 1100,
  resetLimit: 9900,
  tolerance: 160,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(9, 25);       // twenty-five are sent; nine must agree
    if (row < 0) return DECODE_ABORT_LENGTH;
    if (bits.bitsPerRow[row] !== 25) return DECODE_ABORT_LENGTH;

    const b = bits.bb[row];
    if (!b[0] && !b[1] && !b[2]) return DECODE_FAIL_SANITY;

    // Short pulse is a one, so the payload reads inverted.
    b[0] = ~b[0]; b[1] = ~b[1]; b[2] = ~b[2];

    const id = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
    const cmd = b[2] & 0x0f;
    const state = KERUI_STATE[cmd];
    if (!state) return DECODE_ABORT_EARLY;

    const data: R433Data = { model: 'Kerui-Security', type: 'Security', id, cmd, state };
    // Each code means one thing, so only the field it speaks to is reported — upstream does the same rather
    // than publishing a full set of flags the frame never carried.
    if (cmd === 0xa) data.motion = 1;
    if (cmd === 0xe) data.opened = 1;
    if (cmd === 0x7) data.opened = 0;
    if (cmd === 0xb) data.tamper = 1;
    if (cmd === 0x5) data.water = 1;
    if (cmd === 0xf) data.battery_ok = 0;
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Generic off-brand motion sensor (87)
// ---------------------------------------------------------------------------

/**
 * An unbranded motion sensor and alarm kit, decoded only as far as the twenty-bit code it sends.
 *
 * Nothing here says what the code means, so nothing here pretends to. Upstream's own notes list a handful of
 * observed values — `80042` arming, `80002` disarming, `80008` the quarter-hourly ping, `800a2` and its
 * neighbors a motion event — but the decoder reports the raw code and lets the reader match it, which is the
 * only honest thing to do with an undocumented command set.
 *
 * With no checksum the validation is structural and strict: exactly twenty bits, three copies that agree, and
 * a refusal of the two degenerate payloads (all zeroes, all ones) that noise produces most often.
 */
export const genericMotion: RDevice = register({
  num: 87,
  name: 'Generic wireless motion sensor',
  what: 'alarm motion sensor and panel',
  modulation: Modulation.OOK_PWM,
  shortWidth: 888,
  longWidth: (1332 + 1784) / 2,                    // the pulse widths alternate between two packet forms
  syncWidth: 1784 + 670,
  gapLimit: 1200,
  resetLimit: 2724 * 1.5,
  bands: [433300000],                              // upstream names 433.3 MHz specifically, not the usual 433.92
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    for (let i = 0; i < bits.numRows; i++) {
      const b = bits.bb[i];
      if (bits.bitsPerRow[i] !== 20
        || (b[1] === 0 && b[2] === 0)
        || (b[1] === 0xff && b[2] === 0xf0)
        || bits.countRepeats(i, 0) < 3) continue;

      ctx.emit({
        model: 'Generic-Motion',
        type: 'Security',
        code: hex((b[0] << 12) | (b[1] << 4) | (b[2] >> 4), 5),
      });
      return 1;
    }
    return DECODE_ABORT_EARLY;
  },
});

// ---------------------------------------------------------------------------
// X10 Security (99)
// ---------------------------------------------------------------------------

/** The events upstream has actually observed, keyed by the code byte with its battery bit masked off. */
const X10_SEC_EVENT: Record<number, string> = {
  0x00: 'DOOR/WINDOW OPEN', 0x04: 'DOOR/WINDOW OPEN', 0x40: 'DOOR/WINDOW OPEN', 0x44: 'DOOR/WINDOW OPEN',
  0x80: 'DOOR/WINDOW CLOSED', 0x84: 'DOOR/WINDOW CLOSED', 0xc0: 'DOOR/WINDOW CLOSED', 0xc4: 'DOOR/WINDOW CLOSED',
  0x0c: 'MOTION TRIPPED', 0x4c: 'MOTION TRIPPED',
  0x8c: 'MOTION READY', 0xcc: 'MOTION READY',
  0x06: 'KEY-FOB ARM',
  0x26: 'KR18 PANIC',
  0x42: 'KEY-FOB LIGHTS A ON',
  0x46: 'KEY-FOB LIGHTS B ON',
  0x82: 'SH624 SEC-REMOTE DISARM',
  0x86: 'KEY-FOB DISARM',
  0x88: 'KR15 PANIC',
  0x98: 'KR15 PANIC-3SECOND',
  0xc2: 'KEY-FOB LIGHTS A OFF',
  0xc6: 'KEY-FOB LIGHTS B OFF',
};
/** The codes whose tamper bit means something. Elsewhere bit 6 is part of the command, not a tamper flag. */
const X10_SEC_TAMPER_CODES = new Set([0x00, 0x04, 0x40, 0x44, 0x80, 0x84, 0xc0, 0xc4, 0x0c, 0x4c, 0x8c, 0xcc]);
/** The door and window codes, the only ones that carry the delay setting. */
const X10_SEC_DELAY_CODES = new Set([0x00, 0x04, 0x40, 0x44, 0x80, 0x84, 0xc0, 0xc4]);

/**
 * The security half of X10 — DS10/DS18 door contacts, MS10/MS18 motion detectors, KR15 and KR18 keyfobs.
 *
 * The frame is shaped almost exactly like the NEC infrared remote protocol, and it protects itself the same
 * way: the second byte is the first with its low nibble complemented, the fourth is the third fully
 * complemented, and a single parity bit closes the whole thing. Two sliced rows arrive, a sync burst and the
 * message, and the message is always the second.
 *
 * The event names come from upstream's observations and stop there. Anything outside that list is reported as
 * `UNKNOWN` with the raw code alongside, because a wrong label on an alarm event is worse than no label.
 *
 * One thing to know when comparing output: upstream marks the integrity field `CRC` even though the check is a
 * single even-parity bit. That is mirrored here rather than corrected, so the two agree on real radio.
 */
export const x10Sec: RDevice = register({
  num: 99,
  name: 'X10 Security',
  what: 'alarm door and window contacts, motion sensors and keyfobs',
  modulation: Modulation.OOK_PPM,
  shortWidth: 562,
  longWidth: 1687,
  gapLimit: 2200,                                  // the gap after the sync burst is 4.5 ms
  resetLimit: 6000,
  bands: [310558000, 433920000],                   // American sensors at 310.558 MHz, European ones at 433.92
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 2) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[1] < 41) return DECODE_ABORT_LENGTH;

    const b = bits.bb[1];
    // The two complement relationships stand in for most of a checksum.
    if ((b[0] ^ b[1]) !== 0x0f || (b[2] ^ b[3]) !== 0xff) return DECODE_FAIL_SANITY;

    // Bit 40 is an even parity bit over the forty before it, folded down a byte at a time.
    let parity = b[0] ^ b[1] ^ b[2] ^ b[3] ^ b[4] ^ (b[5] & 0x80);
    parity = (parity >> 4) ^ (parity & 0x0f);
    parity = (parity >> 2) ^ (parity & 0x03);
    parity = (parity >> 1) ^ (parity & 0x01);
    if (parity) return DECODE_FAIL_MIC;

    const code = b[2] & 0xfe;
    const batteryLow = b[2] & 0x01;
    const tamper = X10_SEC_TAMPER_CODES.has(code) ? (b[2] & 0x40) >> 6 : 0;
    // The delay setting reads backwards: the bit set means the minimum delay, clear means the maximum.
    const delay = X10_SEC_DELAY_CODES.has(code) ? (b[2] & 0x04 ? 0 : 1) : 0;

    const data: R433Data = {
      model: 'X10-Security',
      type: 'Security',
      id: hex(b[0], 2) + hex(b[4], 2),              // the two halves of the identity sit at opposite ends
      code: hex(b[2], 2),
      event: X10_SEC_EVENT[code] ?? 'UNKNOWN',
      mic: 'CRC',                                   // upstream's own label, though the check is a parity bit
    };
    if (delay) data.delay = delay;
    if (batteryLow) data.battery_ok = 0;
    if (tamper) data.tamper = tamper;
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// SimpliSafe, the original generation (102)
// ---------------------------------------------------------------------------

/**
 * The five identity bytes are printable characters sent least significant bit first, so each one has to be
 * turned around before it reads as text. A byte that does not land on a printable character is replaced rather
 * than emitted, which usually means the frame was damaged in a way the checksum did not catch.
 */
function ssGetId(b: Uint8Array): string {
  let id = '';
  for (let k = 3; k <= 7; k++) {
    const c = reverse8(b[k]);
    id += (c < 32 || c > 126) ? '?' : String.fromCharCode(c);
  }
  return id;
}

/** What a sensor is saying. Anything outside these three is reported as no text at all, never guessed. */
const SS_SENSOR_STATE: Record<number, string> = {
  1: 'Contact Open', 2: 'Contact Closed', 3: 'Alarm Off',
};

/** The keypad buttons upstream has identified. An unrecognized byte is printed raw rather than named. */
const SS_KEYPAD_COMMAND: Record<number, string> = {
  0x6a: 'Arm System - Away',
  0xca: 'Arm System - Home',
  0x3a: 'Arm System - Canceled',
  0x2a: 'Keypad Panic Button',
  0x86: 'Keypad Menu Button',
};

/**
 * A door or window sensor: identity, a sequence number, a state, and a checksum that is simply the two added
 * together. Every byte is sent least significant bit first, so all three have to be turned around first.
 *
 * This is the only one of the three message types with any check at all, and it is the only one that demands
 * an exact length.
 */
function ssSensorParser(bits: BitBuffer, ctx: DecodeCtx, row: number): number {
  if (bits.bitsPerRow[row] !== 92) return DECODE_ABORT_LENGTH;

  const b = bits.bb[row];
  const seq = reverse8(b[8]);
  const state = reverse8(b[9]);
  const csum = reverse8(b[10]);
  if (((seq + state) & 0xff) !== csum) return DECODE_FAIL_MIC;

  ctx.emit({
    model: 'SimpliSafe-Sensor',
    type: 'Security',
    id: ssGetId(b),
    seq,
    state,
    extradata: SS_SENSOR_STATE[state] ?? '',
    mic: 'CHECKSUM',
  });
  return 1;
}

/**
 * The keypad announcing a disarm, with the PIN somebody just typed packed into two bytes as four nibbles.
 *
 * There is no checksum on this message and no encryption of any kind — the PIN travels in clear, and the
 * digits arrive low nibble first within each byte as well as least significant bit first within each nibble.
 *
 * Note that the sequence number is reported straight from the byte here, not turned around the way the sensor
 * parser turns its own. That is upstream's behavior and it looks like an oversight, but the two are reported
 * as upstream reports them so a reading can be compared against it directly.
 */
function ssPinentryParser(bits: BitBuffer, ctx: DecodeCtx, row: number): number {
  const b = bits.bb[row];
  const pina = reverse8(b[10]);
  const pinb = reverse8(b[11]);
  const digits = [pina & 0x0f, (pina & 0xf0) >> 4, pinb & 0x0f, (pinb & 0xf0) >> 4];

  ctx.emit({
    model: 'SimpliSafe-Keypad',
    type: 'Security',
    id: ssGetId(b),
    seq: b[9],                                     // not reversed, unlike the sensor parser above
    extradata: `Disarm Pin: ${digits.map(d => d.toString(16)).join('')}`,
  });
  return 1;
}

/** The keypad's other buttons — arming, canceling, panic. Again no checksum, and the raw byte if unknown. */
function ssKeypadCommands(bits: BitBuffer, ctx: DecodeCtx, row: number): number {
  const b = bits.bb[row];
  ctx.emit({
    model: 'SimpliSafe-Keypad',
    type: 'Security',
    id: ssGetId(b),
    seq: b[9],                                     // likewise reported unreversed
    extradata: SS_KEYPAD_COMMAND[b[10]] ?? `Unknown Keypad: ${hex(b[10], 2)}`,
  });
  return 1;
}

/**
 * SimpliSafe's original system: sensors, keypad PIN entry and keypad commands, all on one protocol number.
 *
 * The whole frame is inverted on the air, which is why the sync word is matched as `cc 5f` and everything read
 * afterwards is the complement. The message type byte decides which of three quite different payloads follows,
 * and only the first of them carries a checksum.
 *
 * The keypad messages need a stronger signal than the sensors do; upstream's device name warns that automatic
 * gain control has to be off before they decode at all.
 */
export const ssSensor: RDevice = register({
  num: 102,
  name: 'SimpliSafe Home Security System (May require disabling automatic gain for KeyPad decodes)',
  what: 'alarm sensors and keypad, first generation',
  modulation: Modulation.OOK_PIWM_DC,
  shortWidth: 500,                                 // half a bit
  longWidth: 1000,                                 // a whole bit
  resetLimit: 2200,
  tolerance: 100,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(2, 90);
    if (row < 0) return DECODE_ABORT_EARLY;

    // Tested before the inversion, so this is the sync word as it arrives.
    const b = bits.bb[row];
    if (b[0] !== 0xcc || b[1] !== 0x5f) return DECODE_ABORT_EARLY;

    bits.invert();
    if (b[2] === 0x88) return ssSensorParser(bits, ctx, row);
    if (b[2] === 0x66) return ssPinentryParser(bits, ctx, row);
    if (b[2] === 0x44) return ssKeypadCommands(bits, ctx, row);
    return DECODE_ABORT_EARLY;
  },
});

// ---------------------------------------------------------------------------
// Honeywell ActivLink doorbells, motion sensors and contacts (115 OOK, 116 FSK)
// ---------------------------------------------------------------------------

/** Which kind of ActivLink device is talking, from three bits in the middle of the frame. */
const HONEYWELL_WDB_CLASS: Record<number, string> = {
  0x1: 'PIR-Motion', 0x2: 'Doorbell', 0x5: 'Contact',
};
/** How insistently the chime should react. Two of the four codes mean the same thing. */
const HONEYWELL_WDB_ALERT: Record<number, string> = {
  0x0: 'Normal', 0x1: 'High', 0x2: 'High', 0x3: 'Full',
};

/**
 * Honeywell's ActivLink range: the wireless doorbell, the PIR that chimes, and the door contact.
 *
 * Everything of substance is in the frame's last byte, and one bit of it has two jobs. On a doorbell that bit
 * is the "secret knock" — pressing the button three times quickly — while on a contact sensor the same bit
 * means the case has been opened. There is no way to read it correctly without first knowing which device
 * sent it, so the class is decoded first and the bit is then reported as one thing or the other, never both.
 *
 * The open and closed states are two separate bits rather than one, which lets the sensor say something a
 * single bit could not: when neither or both are set the contact state is unknown, and that is reported as -1
 * rather than being forced to open or closed. Upstream notes this is how a tamper arrives.
 *
 * The check is one even-parity bit across all forty-eight, which catches a single flipped bit and little else,
 * so four agreeing copies are demanded on top of it.
 *
 * The inversion order looks odd and is deliberate. Upstream takes its pointer to the row before inverting the
 * buffer, so everything it reads afterwards — the parity included — is already inverted; and it runs the
 * all-zero sanity test before enforcing the parity, so a blank frame is reported as nonsense rather than as a
 * failed check. Both are mirrored here.
 */
function honeywellWdbDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  const row = bits.findRepeatedRow(4, 48);
  if (row < 0) return DECODE_ABORT_EARLY;
  if (bits.bitsPerRow[row] !== 48) return DECODE_ABORT_LENGTH;

  bits.invert();
  const b = bits.bb[row];

  const parity = parityBytes(b, 6);
  if ((!b[0] && !b[2] && !b[4] && !b[5])
    || (b[0] === 0xff && b[2] === 0xff && b[4] === 0xff && b[5] === 0xff)) return DECODE_FAIL_SANITY;
  if (parity) return DECODE_FAIL_MIC;               // must come out even

  const type = (b[3] & 0x70) >> 4;

  // One bit, two meanings, decided by what kind of device sent it.
  let secretKnock = (b[5] & 0x10) >> 4;
  let tampered = secretKnock;
  if (type === 0x5) secretKnock = 0;
  else tampered = 0;

  const opened = (b[5] & 0x20) >> 5;
  const closed = (b[5] & 0x40) >> 6;
  // Neither bit set, or both, means the frame is not reporting a contact state at all.
  const open = (opened && !closed) ? 1 : (!opened && closed) ? 0 : -1;

  ctx.emit({
    model: 'Honeywell-ActivLink',
    type: 'Security',
    subtype: HONEYWELL_WDB_CLASS[type] ?? 'Unknown',
    id: (b[0] << 12) | (b[1] << 4) | (b[2] >> 4),
    battery_ok: ((b[5] & 0x02) >> 1) ? 0 : 1,
    alert: HONEYWELL_WDB_ALERT[b[4] & 0x03] ?? 'Unknown',
    secret_knock: secretKnock,
    open,
    tampered,
    relay: (b[5] & 0x08) >> 3,                      // this frame is one unit repeating another's transmission
    mic: 'PARITY',
  });
  return 1;
}

export const honeywellWdb: RDevice = register({
  num: 115,
  name: 'Honeywell ActivLink, Wireless Doorbell',
  what: 'wireless doorbell, PIR motion sensor and door contact',
  modulation: Modulation.OOK_PWM,
  shortWidth: 175,
  longWidth: 340,
  gapLimit: 0,
  resetLimit: 5000,
  syncWidth: 500,
  bands: BAND_433,                                  // upstream documents no frequency; 433.92 is where these are heard
  decode: (_d, bits, ctx) => honeywellWdbDecode(bits, ctx),
});

/** The same frame from the units that key their carrier rather than switching it on and off. */
export const honeywellWdbFsk: RDevice = register({
  num: 116,
  name: 'Honeywell ActivLink, Wireless Doorbell (FSK)',
  what: 'wireless doorbell, PIR motion sensor and door contact',
  modulation: Modulation.FSK_PWM,
  shortWidth: 160,
  longWidth: 320,
  gapLimit: 0,
  resetLimit: 560,
  syncWidth: 500,
  bands: BAND_433,
  decode: (_d, bits, ctx) => honeywellWdbDecode(bits, ctx),
});

// ---------------------------------------------------------------------------
// Amazon Basics meat thermometer (181)
// ---------------------------------------------------------------------------

/** Two decimal digits packed one per nibble, as the display shows them. */
const bcd2int = (bcd: number): number => 10 * (bcd >> 4) + (bcd & 0x0f);

/**
 * A meat thermometer, and the odd one out in this file — no alarm, no identity beyond a number it picks at
 * random each time it is switched on.
 *
 * The sync word is the interesting part, because it is not really a sync word. `55 aa aa` is exactly what the
 * frame's own last twelve bits look like once Manchester coded: four ones and eight zeroes, which the sensor
 * sends at the end of every message because the last nibble of the temperature field and the whole final byte
 * are constant. So the decoder finds the end of the frame and steps back seventy-two bits to reach the start,
 * which is why a match earlier than bit 72 is rejected outright — there would be no frame in front of it.
 *
 * There is no checksum whatsoever. Four agreeing copies and that fixed tail are the only things separating a
 * reading from noise. Upstream also reads the decoded packet without checking how much of it decoded, which is
 * kept as-is: the buffer is allocated either way here, so a short decode reads zeroes rather than failing.
 */
export const abmt: RDevice = register({
  num: 181,
  name: 'Amazon Basics Meat Thermometer',
  what: 'cooking thermometer',
  modulation: Modulation.OOK_PCM,
  shortWidth: 550,
  longWidth: 550,
  gapLimit: 2000,
  resetLimit: 5000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(4, 90);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > 120) return DECODE_ABORT_LENGTH;

    const sync = new Uint8Array([0x55, 0xaa, 0xaa]);
    const at = bits.search(row, 0, sync, 24);
    // Not found at all, or found with no room for a frame in front of it.
    if (at === bits.bitsPerRow[row] || at < 72) return DECODE_FAIL_SANITY;

    const packet = new BitBuffer();
    bits.manchesterDecode(row, at - 72, packet, 48);
    packet.invert();

    const b = packet.bb[0];
    ctx.emit({
      model: 'Basics-Meat',
      id: b[0],                                     // picked afresh every time the unit is powered on
      temperature_C: bcd2int(b[3]) * 10 + bcd2int(b[4] >> 4),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// SimpliSafe Gen 3 (209)
// ---------------------------------------------------------------------------

const SS3_PREAMBLE = new Uint8Array([0x93, 0x0b, 0x51, 0xde]);
/** The three message lengths seen in the wild: 21 for arming, 22 for a sensor, 24 for disarming. */
const SS3_LENGTHS = new Set([0x15, 0x16, 0x18]);

/**
 * SimpliSafe's third generation, and the only genuinely protected device in this file.
 *
 * Where the first generation sent the disarm PIN in clear, this one wraps its payload in a CMAC and an
 * encrypted body, with a rolling counter in front of both. None of that is broken here and none of it needs to
 * be: what comes out is the identity, the counter, the authentication tag and the encrypted bytes exactly as
 * sent, which is enough to see that a system is present and how often it talks, and nothing more.
 *
 * The length byte is validated against the three known message lengths before anything else, because it
 * decides how many bytes the CRC covers — a wrong length would check the wrong span and reject a good frame.
 *
 * All five frames upstream publishes are sensor messages, `16 02`, despite the file naming two other types.
 * The CRC on every one of them was recomputed independently before this port was believed.
 */
export const simplisafeGen3: RDevice = register({
  num: 209,
  name: 'SimpliSafe Gen 3 Home Security System',
  what: 'alarm sensors, keypad and panel, third generation',
  modulation: Modulation.FSK_PCM,
  shortWidth: 208,                                 // 4800 baud
  longWidth: 208,
  resetLimit: 7000,
  bands: [433900000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const bitpos = bits.search(0, 0, SS3_PREAMBLE, 32) + 32;
    if (bitpos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    if (bitpos + 24 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, bitpos, 27 * 8);       // room for the longest message plus its CRC
    if (!SS3_LENGTHS.has(b[0])) return DECODE_ABORT_EARLY;

    const len = b[0];
    if (crc16(b, len + 3, 0x8005, 0xffff) !== 0) return DECODE_FAIL_MIC;

    let encr = '';
    for (let i = 0; i < len - 12; i++) encr += hex(b[13 + i], 2);

    ctx.emit({
      model: 'SimpliSafe-Gen3',
      type: 'Security',
      id: hex(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, 8),
      msg_type: hex(b[1], 2),
      ctr: hex((b[8] << 16) | (b[7] << 8) | b[6], 6),   // the counter alone is little endian
      cmac: hex(((b[9] << 24) | (b[10] << 16) | (b[11] << 8) | b[12]) >>> 0, 8),
      encr,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Cellular Tracking Technologies LifeTag / PowerTag / HybridTag (320)
// ---------------------------------------------------------------------------

const CTT_SYNC = new Uint8Array([0xd3, 0x91]);
/**
 * The thirty-two byte values the Motus wildlife network hands out. Each is a five-bit value spread across
 * eight bits so that any two differ in several places, which is what lets a tag be recognized at the edge of
 * range where a plain identifier would blur into another.
 */
const CTT_MOTUS_CODE = new Set([
  0x00, 0x07, 0x19, 0x1e, 0x2a, 0x2d, 0x33, 0x34,
  0x4b, 0x4c, 0x52, 0x55, 0x61, 0x66, 0x78, 0x7f,
  0x80, 0x87, 0x99, 0x9e, 0xaa, 0xad, 0xb3, 0xb4,
  0xcb, 0xcc, 0xd2, 0xd5, 0xe1, 0xe6, 0xf8, 0xff,
]);

/**
 * A transmitter glued to a bird. The other stray in this file, and the only one here that is not a household
 * device at all.
 *
 * These tags weigh under a gram and do one thing: chirp an identifier every few seconds so that a network of
 * receiving towers can trace a migration. A LifeTag beeps every five seconds for as long as its battery holds
 * out, a PowerTag on whatever schedule it was given, a HybridTag somewhere between two and fifteen.
 *
 * `valid_motus` says every byte of the identifier came from the dictionary the Motus network allocates from.
 * It is worth reporting and worth not over-reading: a tag failing it is not a bad decode, just a tag that is
 * not registered with that particular project. The CRC is what says the frame is sound.
 *
 * Each row is tried separately and every good one is reported, so a burst carrying several beeps produces
 * several readings. A row that fails only its CRC is remembered, so a burst that was all damaged frames says
 * so rather than reporting silence.
 */
export const cttLifePowerHybrid: RDevice = register({
  num: 320,
  name: 'Cellular Tracking Technologies LifeTag/PowerTag/HybridTag',
  what: 'wildlife tracking tag',
  modulation: Modulation.FSK_PCM,
  shortWidth: 40,                                  // 25 kbps
  longWidth: 40,
  resetLimit: 500,                                 // just above the longest run of zeroes a frame can hold
  bands: [434000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    let sawBadCrc = false;

    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] < 56) continue;      // sync plus payload at the very least

      const at = bits.search(row, 0, CTT_SYNC, 16);
      if (at >= bits.bitsPerRow[row]) continue;
      if (at + 16 + 40 > bits.bitsPerRow[row]) continue;

      const p = bits.bytes(row, at + 16, 40);
      if (crc8(p, 4, 0x07, 0x00) !== p[4]) { sawBadCrc = true; continue; }

      ctx.emit({
        model: 'CTT-Tag',
        id: ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0,
        valid_motus: (CTT_MOTUS_CODE.has(p[0]) && CTT_MOTUS_CODE.has(p[1])
          && CTT_MOTUS_CODE.has(p[2]) && CTT_MOTUS_CODE.has(p[3])) ? 1 : 0,
        mic: 'CRC',
      });
      events++;
    }

    return events > 0 ? events : sawBadCrc ? DECODE_FAIL_MIC : 0;
  },
});
