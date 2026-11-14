/**
 * Olympia Protect 9571 alarm system: door/window contacts, PIR motion sensors and keyfobs on 868.3 to 868.5 MHz.
 *
 * FSK, 366 us per bit, preamble aa aa 2d d4, then 48 bits: a 24-bit ID, two constant markers (0x8 and 0x6) around a
 * battery-inserted bit, a weak-battery bit, the device class (sensor or keyfob), a 3-bit type or command, the
 * contact or motion state, and a byte sum over the first five bytes.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `olympia_9571.c`.
 */

import type { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addBytes } from '../util.js';

const PREAMBLE = new Uint8Array([0xaa, 0x2d, 0xd4]);
const COMMANDS: Record<number, string> = { 3: 'Disarm', 4: 'Arm Home + Siren', 5: 'Arm Siren Only', 6: 'Arm Home Only', 7: 'SOS' };

export const olympia9571: RDevice = register({
  num: 386,
  name: 'Olympia Protect 9571 alarm system sensors',
  what: 'alarm door contact, motion sensor and keyfob',
  modulation: Modulation.FSK_PCM,
  shortWidth: 366,
  longWidth: 366,
  resetLimit: 5000,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_LENGTH;
    let at = bits.search(0, 0, PREAMBLE, 24);
    if (at >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    at += 24;
    if (at + 48 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;
    const b = new Uint8Array(6);
    bits.extractBytes(0, at, b, 48);

    const id = (b[0] << 16) | (b[1] << 8) | b[2];
    const battWeak = (b[4] >> 7) & 1;
    const deviceClass = (b[4] >> 4) & 7;
    const type = (b[4] >> 1) & 7;
    const state = b[4] & 1;
    if (((b[3] >> 4) & 0x0f) !== 0x8 || (b[3] & 7) !== 0x6) return DECODE_FAIL_SANITY;
    if (addBytes(b, 5) !== b[5]) return DECODE_FAIL_MIC;

    const out: Record<string, unknown> = { model: 'Olympia-9571' };
    if (deviceClass === 0 && type === 4) Object.assign(out, { subtype: 'Contact', id: id.toString(16).padStart(6, '0'), state: state ? 'open' : 'closed' });
    else if (deviceClass === 0 && type === 7) Object.assign(out, { subtype: 'PIR-Motion', id: id.toString(16).padStart(6, '0'), state: state ? 'motion' : 'idle' });
    else if (deviceClass === 1) Object.assign(out, { subtype: 'Keyfob', id: id.toString(16).padStart(6, '0'), cmd: COMMANDS[type] ?? 'Unknown', cmd_id: type });
    else return DECODE_FAIL_SANITY;
    out.battery_ok = battWeak ? 0 : 1;
    out.mic = 'CHECKSUM';
    ctx.emit(out as { model: string });
    return 1;
  },
});
