/**
 * Household energy monitors: the clamp-on and optical sensors that watch a domestic electricity supply.
 *
 * These are not the utility's meter — they are the consumer display bought separately, either a current clamp
 * around the incoming cable or an optical head taped over the meter's blinking pulse lamp. So the readings are
 * an estimate rather than a billing figure, and several of them say so by reporting a raw current or a pulse
 * count and leaving the conversion to the display.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/efergy_e2_classic.c`, `efergy_optical.c`,
 * `current_cost.c`, `blueline.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';
import { addBytes, crc8, crc16 } from '../util.js';

/**
 * The Efergy e2 current clamp.
 *
 * It reports a raw reading from its analog converter together with the exponent to scale it by, rather than
 * amps — the display holds the calibration. The exponent arrives as a negated byte, so it is undone here.
 */
export const efergyE2Classic: RDevice = register({
  num: 36,
  name: 'Efergy e2 classic',
  what: 'clamp-on household electricity monitor',
  modulation: Modulation.FSK_PWM,
  shortWidth: 64,
  longWidth: 136,
  syncWidth: 500,
  gapLimit: 200,
  resetLimit: 400,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];
    if (n < 64 || n > 65) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    // The frame arrives in either polarity; the top nibble of the first byte says which.
    if ((b[0] & 0xf0) !== 0xf0 && (b[0] & 0xf0) !== 0x00) return DECODE_ABORT_EARLY;
    if (b[0] & 0xf0) for (let i = 0; i < 8; i++) b[i] = ~b[i];

    let zeros = 0;
    for (let i = 0; i < 8; i++) if (b[i] === 0) zeros++;
    if (zeros + 1 > 5) return DECODE_FAIL_SANITY;    // mostly empty is noise, not a reading

    const checksum = addBytes(b, 7);
    if (checksum === 0) return DECODE_FAIL_SANITY;
    if ((checksum & 0xff) !== b[7]) return DECODE_FAIL_MIC;

    // A negated exponent. Outside this range the frame decoded wrong even though the sum passed.
    const fact = -((b[6] << 24) >> 24) + 15;
    if (fact < 7 || fact > 23) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Efergy-e2CT',
      id: (b[2] << 8) | b[1],
      battery_ok: (b[3] & 0x40) >> 6,
      current: Math.round(((b[4] << 8) | b[5]) / (1 << fact) * 1000) / 1000,
      interval: ((((b[3] & 0x30) >> 4) + 1) * 6),    // how many seconds between transmissions
      learn: (b[3] & 0x80) ? 'YES' : 'NO',
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

/**
 * The Efergy optical head, which watches the meter's pulse lamp and counts the flashes.
 *
 * Turning a flash count into energy needs to know how many pulses the meter gives per kilowatt-hour, and the
 * sensor does not send that. rtl_433 reports every plausible answer rather than picking one, and so does this:
 * five readings come out, and only one of them is your meter.
 */
export const efergyOptical: RDevice = register({
  num: 63,
  name: 'Efergy optical',
  what: 'optical head that counts a meter’s pulse lamp',
  modulation: Modulation.FSK_PWM,
  shortWidth: 64,
  longWidth: 136,
  syncWidth: 500,
  resetLimit: 400,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let n = bits.bitsPerRow[0];
    if (n < 96 || n > 100) return DECODE_ABORT_LENGTH;
    const b = bits.bb[0];

    // Shift the frame along until the leading nibble looks right, then undo the polarity if inverted.
    while ((b[0] & 0xf0) !== 0xf0 && (b[0] & 0xf0) !== 0x00) {
      n -= 1;
      if (n < 96) return DECODE_ABORT_EARLY;
      for (let i = 0; i < (n + 7) >> 3; i++) b[i] = ((b[i] << 1) | ((b[i + 1] & 0x80) >> 7)) & 0xff;
    }
    if (b[0] & 0xf0) for (let i = 0; i < 12; i++) b[i] = ~b[i];

    if (b[8] === 0 && b[9] === 0 && b[10] === 0 && b[11] === 0) return DECODE_FAIL_SANITY;
    if (crc16(b, 10, 0x1021, 0x0000) !== ((b[10] << 8) | b[11])) return DECODE_FAIL_MIC;

    const id = (b[0] << 16) | (b[1] << 8) | b[2];
    const seconds = ((((b[3] & 0x30) >> 4) + 1) * 30);
    const pulses = b[8];
    // The common meter calibrations. Only one of these is right for any given meter.
    for (const impKwh of [4000, 3200, 2000, 1000, 500]) {
      ctx.emit({
        model: 'Efergy-Optical',
        id,
        pulses: impKwh,
        pulsecount: pulses,
        energy_kWh: Math.round((pulses / impKwh) * (3600 / seconds) * 1000) / 1000,
        mic: 'CRC',
      });
    }
    return 1;
  },
});

/**
 * Current Cost monitors, in the classic and EnviR generations. One transmitter can carry three clamps, and a
 * separate message type reports a pulse counter for gas or water instead.
 */
export const currentCost: RDevice = register({
  num: 44,
  name: 'CurrentCost current sensor',
  what: 'household electricity, gas and water monitors',
  modulation: Modulation.FSK_PCM,
  shortWidth: 250,
  longWidth: 250,
  resetLimit: 8000,
  bands: [433920000, 868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    const CLASSIC = new Uint8Array([0xcc, 0xcc, 0xcc, 0xce, 0x91, 0x5d]);   // 45 of these 48 bits are the lead-in
    const ENVIR = new Uint8Array([0x55, 0x55, 0x55, 0x55, 0xa4, 0x57]);

    let isEnvir = false;
    let start = bits.search(0, 0, ENVIR, 48);
    if (start + 47 + 112 <= bits.bitsPerRow[0]) {
      isEnvir = true;
      start += 47;
    } else {
      start = bits.search(0, 0, CLASSIC, 45);
      if (start + 45 + 112 > bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
      start += 45;
    }

    const packet = new BitBuffer();
    bits.manchesterDecode(0, start, packet, 0);
    if (packet.bitsPerRow[0] < 64) return DECODE_ABORT_EARLY;
    const b = packet.bb[0];

    if ((b[0] & 0xf0) === 0) {
      // Up to three clamps on one transmitter. The top bit of each pair says whether that clamp is fitted.
      ctx.emit({
        model: isEnvir ? 'CurrentCost-EnviR' : 'CurrentCost-TX',
        id: ((b[0] & 0x0f) << 8) | b[1],
        power0_W: (b[2] & 0x80) ? ((b[2] & 0x7f) << 8) | b[3] : 0,
        power1_W: (b[4] & 0x80) ? ((b[4] & 0x7f) << 8) | b[5] : 0,
        power2_W: (b[6] & 0x80) ? ((b[6] & 0x7f) << 8) | b[7] : 0,
      });
      return 1;
    }
    if ((b[0] & 0xf0) === 0x40) {
      ctx.emit({
        model: isEnvir ? 'CurrentCost-EnviRCounter' : 'CurrentCost-Counter',
        subtype: b[3],                               // 2 electric, 3 gas, 4 water
        id: ((b[0] & 0x0f) << 8) | b[1],
        power0: ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0,
      });
      return 1;
    }
    return 0;
  },
});

/**
 * The BlueLine PowerCost monitor, which is the awkward one.
 *
 * Only its identity message carries its serial number in the clear. Every other message masks its payload by
 * subtracting that serial number, so nothing else can be read until the number is known. Waiting for an
 * identity message would mean waiting a long time, so this instead runs the CRC backwards: for each of the 256
 * possible high bytes it recovers what the low byte must have been, keeps the candidates whose message type
 * agrees, and votes across transmissions until one identity is clearly ahead.
 *
 * The vote is kept between bursts, which makes this the only decoder here with memory.
 */
const BLUELINE_ID_STEP = 4;
const BLUELINE_GUESS_THRESHOLD = 4;

/** Run a CRC-8 backwards, recovering the initial value that would produce a known remainder. */
function revCrc8(m: Uint8Array, nBytes: number, polynomial: number, remainder: number): number {
  // Only works when the polynomial has its lowest bit set, which is true of the ones in use here.
  if ((polynomial & 0x01) === 0) return 0xff;
  const poly = ((polynomial >> 1) | 0x80) & 0xff;
  let rem = remainder & 0xff;
  for (let byte = nBytes - 1; byte >= 0; byte--) {
    for (let bit = 0; bit < 8; bit++) {
      rem = (rem & 0x01) ? ((rem >> 1) ^ poly) & 0xff : rem >> 1;
    }
    rem ^= m[byte];
  }
  return rem & 0xff;
}

/** The running state: the identity in use, and the votes gathered while looking for one. */
const blueline = {
  sensorId: 0,
  searching: true,
  votes: new Uint16Array(0x10000 / BLUELINE_ID_STEP),
};

function guessBluelineId(row: Uint8Array): number {
  const startValue = (row[2] << 8) | row[1];
  const recvCrc = row[3];
  const msgType = row[1] & 0x03;

  const buf = new Uint8Array([0x00, row[2]]);        // a known init in the first byte, the payload's high byte second
  let bestId = 0, bestHits = 0, numAtBest = 0;

  for (let step = 0; step < 256; step++) {
    const low = revCrc8(buf, 2, 0x07, recvCrc);
    if ((low & 0x03) === msgType) {                  // the low bits carry the message type, so most candidates fall away
      const value = (startValue - (((buf[1] << 8) | low) & 0xffff)) & 0xffff;
      const slot = (value / BLUELINE_ID_STEP) | 0;
      blueline.votes[slot]++;
      if (blueline.votes[slot] >= bestHits) {
        if (blueline.votes[slot] > bestHits) { bestHits = blueline.votes[slot]; bestId = value; numAtBest = 1; }
        else numAtBest++;
      }
    }
    buf[1] = (buf[1] + 1) & 0xff;
  }
  // Only believe it when one candidate is clearly ahead, otherwise keep collecting.
  return (bestHits >= BLUELINE_GUESS_THRESHOLD && numAtBest === 1) ? bestId : 0;
}

export const bluelinePowerCost: RDevice = register({
  num: 176,
  name: 'BlueLine Innovations power cost monitor',
  what: 'optical head on a domestic electricity meter',
  modulation: Modulation.OOK_PPM,
  shortWidth: 500,
  longWidth: 1000,
  gapLimit: 2000,
  resetLimit: 8000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    let decoded = 0;
    let failure = 0;

    for (let row = 0; row < bits.numRows; row++) {
      const r = bits.bb[row];
      if (bits.bitsPerRow[row] !== 32 || r[0] !== 0xfe) {
        if (DECODE_ABORT_LENGTH < failure) failure = DECODE_ABORT_LENGTH;
        continue;
      }

      const msgType = r[1] & 0x03;
      const recvCrc = r[3];
      let calcCrc: number;
      let payload = 0;
      const payloadBytes = new Uint8Array(2);

      if (msgType === 0x00) {                        // the identity message, which is not masked
        calcCrc = crc8(r, 2, 0x07, 0x00, 1);
      } else {
        payload = (((r[2] << 8) | r[1]) - blueline.sensorId) & 0xffff;
        payloadBytes[0] = payload & 0xff;
        payloadBytes[1] = payload >> 8;
        calcCrc = crc8(payloadBytes, 2, 0x07, 0x00);
      }

      if (calcCrc !== recvCrc) {
        if (blueline.searching && msgType !== 0x00) {
          const guess = guessBluelineId(r);
          if (guess !== 0) { blueline.sensorId = guess; blueline.searching = false; }
        }
        if (DECODE_FAIL_MIC < failure) failure = DECODE_FAIL_MIC;
        continue;
      }

      if (msgType === 0x00) {
        const id = (r[2] << 8) | r[1];
        ctx.emit({ model: 'Blueline-PowerCost', id, mic: 'CRC' });
        if (blueline.searching) { blueline.sensorId = id; blueline.searching = false; }
        decoded++;
      } else if (msgType === 0x01) {
        // The gap between meter pulses, in milliseconds. Shorter means more power being drawn.
        ctx.emit({ model: 'Blueline-PowerCost', id: blueline.sensorId, gap: payload, mic: 'CRC' });
        decoded++;
      } else if (msgType === 0x02) {
        const flags = payloadBytes[0] >> 2;
        ctx.emit({
          model: 'Blueline-PowerCost',
          id: blueline.sensorId,
          flags,
          battery_ok: ((flags & 0x20) >> 5) ? 0 : 1,
          temperature_C: Math.round((0.436 * payloadBytes[1] - 30.36) * 10) / 10,
          mic: 'CRC',
        });
        decoded++;
      } else {
        ctx.emit({ model: 'Blueline-PowerCost', id: blueline.sensorId, impulses: payload, mic: 'CRC' });
        decoded++;
      }
    }
    return decoded > 0 ? decoded : failure;
  },
});

/** Forget the identity worked out for a BlueLine monitor, so a different one can be found. */
export function resetBluelineId(): void {
  blueline.sensorId = 0;
  blueline.searching = true;
  blueline.votes.fill(0);
}
