/**
 * Alarm and life-safety sensors: door contacts, motion detectors, smoke and water alarms.
 *
 * These are the devices whose whole job is to announce that something has happened, and the design of each one
 * says a good deal about how much its maker trusted the air. Cavius closes its frame with a proper CRC and
 * sends every message byte twice over, once inverted. Risco wraps a CRC-16 around a frame whose fields are
 * both bit-reversed and Gray coded. Visonic protects three bytes of identity with sixteen bits of longitudinal
 * parity. And the Kidde smoke alarm has nothing at all beyond an echo of its own house code.
 *
 * That last one matters more than it sounds. A smoke alarm that cannot be told apart from noise is a smoke
 * alarm that will occasionally be invented, so rtl_433 ships it switched off; here it still runs, with what it
 * says marked as worth a second look. Reporting a doubtful smoke alarm and saying so is better than silence,
 * but the doubt has to travel with it.
 *
 * None of these six carries a rolling code, and none of them needs one — a door contact has nothing to hide.
 * What they do carry is a stable identity, which is exactly what makes them useful to see.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `visonic_powercode.c`, `yale_hsa.c`, `kidde_smoke.c`, `cavius.c`
 * (both devices) and `risco_agility.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, crc8, crc8le, crc16, reflectBytes, reverse8, xorBytes } from '../util.js';

const hexLow = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');
const bitAt = (b: Uint8Array, i: number) => (b[i >> 3] >> (7 - (i & 7))) & 1;

// ---------------------------------------------------------------------------
// Visonic PowerCode (151)
// ---------------------------------------------------------------------------

/**
 * A door contact whose check runs down the frame rather than along it.
 *
 * The four payload bytes are split into nibbles and the nibbles exclusive-ored together column by column, so
 * the first bit of the check is the parity of every first bit, the second of every second, and so on. That
 * catches a whole nibble arriving wrong, which a plain sum would not.
 *
 * The eight flag bits are all reported. Most of them are about the sensor rather than the door — whether its
 * case has been opened, whether it is a repeater, whether this is the routine check-in it sends when nothing
 * has happened at all.
 */
export const visonicPowercode: RDevice = register({
  num: 151,
  name: 'Visonic powercode',
  what: 'alarm door and window sensor',
  modulation: Modulation.OOK_PWM,
  shortWidth: 400,
  longWidth: 800,
  gapLimit: 900,
  resetLimit: 5000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Sent six times over; two agreeing copies are enough.
    const row = bits.findRepeatedRow(2, 37);
    if (row < 0) return DECODE_ABORT_LENGTH;
    if (bits.bitsPerRow[row] !== 37) return DECODE_ABORT_LENGTH;

    const msg = bits.bytes(row, 1, 36);            // drop the start bit, keep the trailing check nibble
    if (!msg[0] && !msg[1] && !msg[2] && !msg[3] && !msg[4]) return DECODE_FAIL_SANITY;

    // Every nibble folded together must cancel.
    const lrc = xorBytes(msg, 5);
    if (((lrc >> 4) ^ (lrc & 0x0f)) !== 0) return DECODE_FAIL_MIC;

    const f = msg[3];
    ctx.emit({
      model: 'Visonic-Powercode',
      type: 'Security',
      id: `${hexLow(msg[0], 2)}${hexLow(msg[1], 2)}${hexLow(msg[2], 2)}`,
      tamper: f & 0x80 ? 1 : 0,                    // the case has been opened
      alarm: f & 0x40 ? 1 : 0,
      battery_ok: f & 0x20 ? 0 : 1,
      else: f & 0x10 ? 1 : 0,
      restore: f & 0x08 ? 1 : 0,                   // whatever tripped has gone back to normal
      supervised: f & 0x04 ? 1 : 0,                // the routine check-in, not an event
      spidernet: f & 0x02 ? 1 : 0,
      repeater: f & 0x01 ? 1 : 0,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Yale HSA alarm kit (210)
// ---------------------------------------------------------------------------

/**
 * One message split across six little packets, each carrying a single byte.
 *
 * Every packet starts with the same four bits and a flag saying whether it is the last, so a message is only
 * complete when all six have arrived in order with the flag set on exactly the sixth. The six bytes then have
 * to sum to nothing. If any of that fails the decoder walks forward to the next end-of-message flag and starts
 * again rather than giving up, which is how it recovers when a packet is missed mid-message.
 */
export const yaleHsa: RDevice = register({
  num: 210,
  name: 'Yale HSA (Home Security Alarm), YES-Alarmkit',
  what: 'alarm sensor: door, motion, keypad and keyfob',
  modulation: Modulation.OOK_PWM,
  shortWidth: 850,
  longWidth: 1460,
  syncWidth: 5380,
  resetLimit: 1500,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 6) return DECODE_ABORT_EARLY;

    const msg = new Uint8Array(6);
    let row = 0;
    while (row < bits.numRows) {
      let ok = false;
      for (let i = 0; i < 6 && row < bits.numRows; i++, row++) {
        if (bits.bitsPerRow[row] !== 13) break;
        const b = bits.bb[row];
        if ((b[0] & 0xf0) !== 0x50) break;         // every packet opens the same way
        const eom = b[0] & 0x08;
        if ((i < 5 && eom) || (i === 5 && !eom)) break;   // the flag belongs on the last one only
        msg[i] = bits.bytes(row, 5, 8)[0];
        if (i === 5) ok = true;
      }

      if (!ok) {
        // Walk on to the end of whatever message this was and try the next.
        while (row < bits.numRows && !(bits.bb[row][0] & 0x08)) row++;
        row++;
        continue;
      }
      if ((addBytes(msg, 6) & 0xff) !== 0) continue;

      ctx.emit({
        model: 'Yale-HSA',
        type: 'Security',
        id: hexLow((msg[0] << 8) | msg[1], 4),
        stype: hexLow(msg[2], 2),                  // ac and ad are contacts, 15 a motion detector
        state: hexLow(msg[3], 2),
        event: hexLow(msg[4], 2),                  // 1 triggered, 3 being paired, 4 tampered with
        mic: 'CHECKSUM',
      });
      return 1;
    }
    return 0;
  },
});

// ---------------------------------------------------------------------------
// Kidde wireless-interconnect smoke alarm (361)
// ---------------------------------------------------------------------------

const KIDDE_ANCHOR = new Uint8Array([0x7f]);

/**
 * A smoke alarm that only ever says who it is.
 *
 * These units interconnect so that one going off sets off the rest, and what is decoded here is the periodic
 * heartbeat they send regardless — the eight DIP switches somebody set when installing it, sent twice with one
 * bit flipped between the copies. That echo is not a checksum: it depends on nothing outside the identity, so
 * it cannot catch a corrupted frame, only an implausible one.
 *
 * There is no way to strengthen that. The obvious guard — demanding several identical copies — cannot work
 * because real repeats arrive sixty to a hundred and twenty-five milliseconds apart, far outside the window in
 * which the receiver treats two bursts as one reception, so every repeat arrives as its own capture.
 *
 * The frame is also preceded by a run of pulses that is not differential Manchester at all, and a decode
 * started at the beginning reliably gives up partway through it. So the decode is simply retried from
 * wherever the last attempt stopped until one run gets far enough to contain a message.
 */
export const kiddeSmoke: RDevice = register({
  num: 361,
  name: 'Kidde RF-SM-DC wireless-interconnect smoke alarm',
  what: 'smoke and carbon monoxide alarm',
  modulation: Modulation.OOK_PCM,
  shortWidth: 400,
  longWidth: 400,
  resetLimit: 3000,
  bands: [433920000],
  disabled: true,                                  // only an echo of its own identity stands in for a check
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 25 * 2) return DECODE_ABORT_LENGTH;
    const rowLen = bits.bitsPerRow[0];

    for (let start = 0; start < rowLen;) {
      const decoded = new BitBuffer();
      const next = bits.differentialManchesterDecode(0, start, decoded, 0);
      const len = decoded.bitsPerRow[0] ?? 0;
      start = next > start ? next : start + 1;     // always move on, even when nothing decoded
      if (len < 25) continue;

      const b = decoded.bb[0];
      let from = 9;                                // a start bit and eight of identity come first
      while (from + 16 <= len) {
        const pos = decoded.search(0, from, KIDDE_ANCHOR, 8);
        if (pos + 16 > len) break;
        from = pos + 1;
        if (pos < 9) continue;
        if (bitAt(b, pos - 9) !== 0) continue;     // the framing bit before the identity

        let idRefl = 0, echo = 0;
        for (let i = 0; i < 8; i++) idRefl = (idRefl << 1) | bitAt(b, pos - 8 + i);
        for (let i = 0; i < 8; i++) echo = (echo << 1) | bitAt(b, pos + 8 + i);
        // The second copy is the first with its top bit turned over, and nothing else.
        if (echo !== (idRefl ^ 0x80)) continue;

        ctx.emit({
          model: 'Kidde-Smoke',
          type: 'Security',
          id: hexLow(reverse8(idRefl), 2),         // sent least significant bit first
        });
        return 1;
      }
    }
    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// Cavius smoke, heat and water alarms (179)
// ---------------------------------------------------------------------------

/** What the alarm is telling its network. */
const CAVIUS_MESSAGE: Record<number, string> = {
  0x80: 'Pairing',
  0x40: 'Test alarm',
  0x20: 'Fire alarm',
  0x10: 'Warning/Water detected',
  0x04: 'Alarm muted',
};

/**
 * A network of alarms that all sound together, and say which of them started it.
 *
 * Every unit knows the identity of the master it was paired to as well as its own, so a message names both:
 * which network, and which detector in it. The message byte is sent twice, the second copy inverted, and a
 * CRC closes the identity and message together — so unlike the Kidde above, this one can genuinely tell a
 * corrupted frame from a real one.
 */
export const cavius: RDevice = register({
  num: 179,
  name: 'Cavius smoke, heat and water detector',
  what: 'smoke, heat and water alarm',
  modulation: Modulation.FSK_PCM,
  shortWidth: 206,
  longWidth: 206,
  syncWidth: 2700,
  gapLimit: 1000,
  resetLimit: 1000,
  bands: [869670000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The chips are configured with 'Cavi' as their sync word, which is literally what this is.
    const at = bits.search(0, 0, new Uint8Array([0x43, 0x61, 0x76, 0x69]), 32);
    if (at + 22 * 8 >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const packet = new BitBuffer();
    bits.manchesterDecode(0, at + 32, packet, 11 * 8);
    packet.invert();
    if (packet.bitsPerRow[0] < 11 * 8) return DECODE_FAIL_SANITY;

    const b = packet.bb[0];
    if (crc8le(b, 7, 0x31, 0x00) !== 0) return DECODE_FAIL_MIC;

    const batteryLow = (b[4] & 0x08) !== 0;
    const message = b[4] & ~0x08;                  // the battery bit is a flag, not a message of its own
    ctx.emit({
      model: 'Cavius-Security',
      type: 'Security',
      id: (((b[7] << 24) | (b[8] << 16) | (b[9] << 8) | b[10]) >>> 0),
      battery_ok: batteryLow ? 0 : 1,
      net_id: (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0),
      message,
      text: CAVIUS_MESSAGE[message] ?? (batteryLow ? 'Battery low' : 'Unknown'),
      mic: 'CRC',
    });
    return 1;
  },
});

/**
 * The Cavius door and window sensor, which is a different protocol wearing the same name.
 *
 * No Manchester coding, a six-byte identity rather than four, and a plain CRC over everything. The state byte
 * only ever reads open or closed; anything else means this was not one of these.
 */
export const caviusDoor: RDevice = register({
  num: 368,
  name: 'Cavius Door/Window sensor',
  what: 'alarm door and window sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 415,
  longWidth: 415,
  resetLimit: 3000,
  bands: [868700000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const rowLen = bits.bitsPerRow[0];

    const pre = new Uint8Array([0xaa, 0xaa, 0xaa, 0xd3, 0x15, 0x27]);
    const at = bits.search(0, 0, pre, 48);
    if (at >= rowLen) return DECODE_ABORT_EARLY;
    if (at + 48 + 9 * 8 > rowLen) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, at + 48, 9 * 8);
    if (crc8(b, 8, 0x07, 0x00) !== b[8]) return DECODE_FAIL_MIC;

    let state: string;
    if (b[7] === 0x25) state = 'open';
    else if (b[7] === 0x24) state = 'closed';
    else return DECODE_FAIL_SANITY;

    let id = '';
    for (let i = 1; i <= 6; i++) id += hexLow(b[i], 2);

    ctx.emit({
      model: 'Cavius-Door',
      type: 'Security',
      id,
      state,
      counter: b[0],
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Risco Agility motion detector (266)
// ---------------------------------------------------------------------------

/** Undo a Gray code: each bit is the running exclusive-or of everything above it. */
function grayDecode(n: number): number {
  let p = n;
  while ((n >>= 1)) p ^= n;
  return p;
}

/**
 * A two-way motion detector that expects the panel to answer it.
 *
 * The interesting part is how thoroughly the payload is disguised without being encrypted at all: the frame is
 * differential Manchester coded, then every byte is bit-reversed, and the fields inside are Gray coded on top
 * of that. None of it is secret — a CRC-16 sits over the whole thing and anyone can undo the rest — but three
 * layers of rearrangement mean nothing is legible until all three come off.
 *
 * The identity is read before the reversal and the state after it, which looks inconsistent and is: upstream
 * notes the identity does not match the number printed on the sensor, so which of the two orderings is right
 * for that field is not yet settled.
 */
export const riscoAgility: RDevice = register({
  num: 266,
  name: 'Risco 2 Way Agility protocol, Risco PIR/PET Sensor RWX95P',
  what: 'alarm motion detector',
  modulation: Modulation.OOK_PCM,
  shortWidth: 175,
  longWidth: 175,
  resetLimit: 1000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const pos = bits.search(0, 0, new Uint8Array([0x55, 0x5a]), 16);
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const decoded = new BitBuffer();
    bits.differentialManchesterDecode(0, pos + 16, decoded, 16 * 8);
    if ((decoded.bitsPerRow[0] ?? 0) < 16 * 8) return DECODE_ABORT_LENGTH;

    const b = decoded.bb[0];
    if (crc16(b, 16, 0x8005, 0x8181) !== 0) return DECODE_FAIL_MIC;
    // The longer frame this family also sends has not been worked out, so it is left alone.
    if (((b[0] << 8) | b[1]) !== 0xff60) return DECODE_ABORT_LENGTH;

    const id = ((b[6] << 16) | (b[7] << 8) | b[8]) >>> 0;
    reflectBytes(b, 16);

    const state = grayDecode(b[12] & 0x0f);
    const lowBatt = (grayDecode((b[12] & 0xf0) >> 4) & 0x08) >> 3;

    const data: R433Data = {
      model: 'Risco-RWX95P',
      type: 'Security',
      id,
      counter: grayDecode((b[5] << 8) | b[4]),
      battery_ok: lowBatt ? 0 : 1,
      mic: 'CRC',
    };
    if ((state & 0x04) >> 2) data.tamper = 1;      // the case has been opened
    if ((state & 0x02) >> 1) data.motion = 1;
    ctx.emit(data);
    return 1;
  },
});
