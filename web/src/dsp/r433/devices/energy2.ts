/**
 * Electricity meters and power monitors: the second batch.
 *
 * `energy.ts` holds the clamp-on and optical monitors that estimate a whole house's draw. These are the rest of
 * the family, and they split into two kinds. Some are the same idea — a head on the utility meter counting the
 * pulse lamp, reporting a raw impulse count that only means something once you know the meter's pulses per
 * kilowatt-hour, which is printed on its front and never transmitted. The others are plug-in socket meters that
 * measure a single appliance directly and send real volts, amps and watts.
 *
 * The pulse-counting ones share an awkwardness worth stating once: none of them can tell you kilowatt-hours on
 * its own. The ESA and Norgo send the divisor in the frame; the IKEA does not, so its energy figure is only as
 * right as a constant compiled into this file.
 *
 * Three of these carry real recorded transmissions in their upstream doc comments, and all three were decoded
 * and checked before this port was written rather than after — the EnergyCount 3000's capture reproduces the
 * decoded line printed beside it field for field, the IKEA's example packet brute-forces to exactly the sender
 * ID its own documentation uses as the worked example, and all nine Revolt rows check out byte for byte against
 * the message table below them. That is the only evidence here that does not come from this port's own
 * understanding of the code.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/esa.c`, `ikea_sparsnas.c`, `esic_emt7110.c`, `norgo.c`,
 * `marlec_solar.c`, `revolt_nc5462.c`, `revolt_zx7717.c`, `ec3k.c`, `rfxmeter.c`, `ecoeye.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addNibbles, crc16, crc16lsb, reflectBytes, xorBytes } from '../util.js';

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const hexLow = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');

/**
 * The sum of a run of bytes at full width.
 *
 * The shared `addBytes` masks to a byte, which is what almost every decoder wants because it compares the
 * result against a single checksum byte. The Revolt NC-5462 below is one of the few that reads the sum as a
 * number in its own right — it rejects a frame whose bytes sum to zero — and a masked sum would make every
 * frame summing to exactly 256 look like that empty frame. Kept local rather than changed in `util.ts`,
 * because the masking is deliberate at the other call sites.
 */
function sumBytesFull(m: Uint8Array, n: number, at = 0): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += m[at + i];
  return s;
}

// ---------------------------------------------------------------------------------------------------------
// ELV ESA 1000/2000 and GIRA EHZ (117)
// ---------------------------------------------------------------------------------------------------------

/**
 * Undo the ESA's payload obfuscation, and return the value that says whether it worked.
 *
 * The scrambling is a running exclusive-or whose key for each byte is the *previous ciphertext* byte plus a
 * constant, seeded with 0x89 — so it unwinds in one forward pass but a single bit error destroys everything
 * after it. There is no separate checksum: the last two bytes hold a number from which the running total of
 * the ciphertext is subtracted, and the remainder is a fixed constant that also identifies which of the two
 * device families sent the frame. So the same arithmetic both verifies the frame and tells the models apart,
 * which is why this returns the residue instead of a pass or fail.
 */
function decryptEsa(b: Uint8Array, blen: number): number {
  let pos = 0;
  let salt = 0x89;
  let crc = 0;
  for (let i = 0; i < blen - 3; i++) {
    const byte = b[pos];
    crc = (crc + byte) & 0xffff;
    b[pos++] ^= salt;
    salt = (byte + 0x24) & 0xff;
  }
  crc = (crc + b[pos]) & 0xffff;
  b[pos++] ^= 0xff;
  return (((b[blen - 2] << 8) | b[blen - 1]) - crc) & 0xffff;
}

/** The residue that marks each family. The ELV meters and the GIRA share everything but this constant. */
const ESA_MAGIC_ELV = 0xf00f;
const ESA_MAGIC_GIRA = 0xee11;

export const esaEnergy: RDevice = register({
  num: 117,
  name: 'ESA1000 / ESA2000 Energy Monitor, GIRA Wetterstation',
  what: 'optical head on a domestic electricity meter',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 260,
  longWidth: 0,
  resetLimit: 3000,
  bands: [433920000],
  // Marked doubtful upstream: the frame has no length or preamble check of its own, so the residue test is the
  // only thing keeping other 433 traffic out.
  disabled: true,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const len = bits.bitsPerRow[0];
    if (!(len === 176 || len === 160) || bits.numRows !== 1) return DECODE_ABORT_LENGTH;

    // The first two bytes are framing and are dropped before anything else happens.
    const b = bits.bytes(0, 16, len - 16);
    const crc = decryptEsa(b, len / 8 - 2);

    if (crc !== ESA_MAGIC_ELV && crc !== ESA_MAGIC_GIRA) return DECODE_FAIL_MIC;

    const isGira = crc === ESA_MAGIC_GIRA;
    // The divisor the meter was told about at setup, sent so the reading can be turned into kilowatt-hours. It
    // is carried exclusive-ored with a byte of the device id, which is the only obfuscation left after the
    // payload is unwound.
    const impulseConstant = isGira
      ? ((b[16] << 8) | (b[17] ^ b[1]))
      : (((b[14] << 8) | b[15]) ^ b[1]);
    // Every energy figure divides by this. A zero means the frame unwound wrong despite passing the residue.
    if (impulseConstant === 0) return DECODE_FAIL_SANITY;

    const impulses = isGira ? ((b[11] << 8) | b[12]) : ((b[9] << 8) | b[10]);
    const impulsesTotal = isGira
      ? ((b[8] << 16) | (b[9] << 8) | b[10])
      : ((((b[5] << 24) | (b[6] << 16) | (b[7] << 8) | b[8]) >>> 0));

    const data: R433Data = {
      model: isGira ? 'Gira-EHZ' : (b[3] === 0x01 ? 'ESAx000WZ' : b[3] === 0x03 ? 'ESA1000Z' : 'ESA-unknown'),
      id: (b[1] << 8) | b[2],
      impulses,
      impulses_total: impulsesTotal,
      impulse_constant: impulseConstant,
      total_kWh: round3(impulsesTotal / impulseConstant),
      impulse_kWh: round3(impulses / impulseConstant),
      // The GIRA gives the sequence number one fewer bit and uses the one it took for the retry flag.
      sequence_id: isGira ? (b[0] & 0x3f) : (b[0] & 0x7f),
      is_retry: isGira ? ((b[0] >> 6) & 1) : (b[0] >> 7),
      mic: 'CRC',
    };
    if (isGira) {
      data['status'] = (b[3] << 8) | b[4];
      data['power'] = (b[6] << 8) | b[7];
    }
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// IKEA Sparsnäs (130)
// ---------------------------------------------------------------------------------------------------------

/**
 * How many meter flashes make a kilowatt-hour.
 *
 * The sender never transmits this. It is a property of the utility meter the optical head is taped to, printed
 * on its front as something like "1000 imp/kWh", and upstream compiles it in as a constant. Anything derived
 * from it is wrong by a whole factor for a meter calibrated differently, which is why the raw pulse count is
 * reported alongside.
 */
const SPARSNAS_PULSES_PER_KWH = 1000;
/** The offset between a sender's printed serial number and the key derived from it. */
const SPARSNAS_ID_KEY_SUB = 0x5d38e8cb;
const SPARSNAS_BITLEN = 160;

/**
 * Work out the sender's serial number from one encrypted packet.
 *
 * The payload is exclusive-ored with a five-byte key built from the serial number, and the serial number is
 * also *in* the payload — so the frame is self-referential, and the number can be recovered by looking for the
 * one value that decrypts to itself. That is what makes this searchable at all. The search space collapses
 * quickly: the serial is at most six digits, which pins the top key byte almost immediately, and the battery
 * level sharing a key byte with the serial gives a second independent test.
 *
 * The loops stop at 0xff rather than running through it, exactly as upstream does. That leaves a key byte of
 * 255 untried and a small number of senders unrecoverable; it is kept because changing it would silently
 * change which senders this finds, and a sender it cannot place still reports under a zero id.
 */
function sparsnasBruteForce(buf: Uint8Array): number {
  const b5 = buf[5], b6 = buf[6], b7 = buf[7], b8 = buf[8];
  const batteryEnc = buf[17];
  const d3 = b8 ^ 0x47;

  for (let k0 = 0; k0 < 0xff; k0++) {
    const d0 = b5 ^ k0;
    if (d0 > 0x0f) continue;                       // anything larger implies a serial above six digits
    for (let k1 = 0; k1 < 0xff; k1++) {
      const d1 = b6 ^ k1;
      for (let k2 = 0; k2 < 0xff; k2++) {
        const d2 = b7 ^ k2;
        const batteryDec = batteryEnc ^ k2;
        const decSensorId = (((d0 << 24) | (d1 << 16) | (d2 << 8) | d3) >>> 0);
        if (decSensorId > 999999) continue;
        for (let k4 = 0; k4 < 0xff; k4++) {
          const keySensorId = (((((k0 << 24) | (k4 << 16) | (k2 << 8) | k1) >>> 0) + SPARSNAS_ID_KEY_SUB) >>> 0);
          if (decSensorId === keySensorId && batteryDec <= 100) return decSensorId;
        }
      }
    }
  }
  return 0;
}

/** The sender found so far. Kept between bursts: the search is expensive and the answer does not change. */
const sparsnas = { sensorId: 0 };

/** Forget the sender worked out for a Sparsnäs, so a different one can be found. */
export function resetSparsnasSensorId(): void {
  sparsnas.sensorId = 0;
}

export const ikeaSparsnas: RDevice = register({
  num: 130,
  name: 'IKEA Sparsnas Energy Meter Monitor',
  what: 'optical head on a domestic electricity meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 27,
  longWidth: 27,
  gapLimit: 1000,
  resetLimit: 3000,
  bands: [868000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const n = bits.bitsPerRow[0];
    if (n < SPARSNAS_BITLEN || n > 260) return DECODE_ABORT_LENGTH;

    // Only the last two bytes of the run-in are checked: the leading ones are corrupted often enough that
    // insisting on them costs more frames than it saves, and the frame has checks to spare.
    const bitpos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0xd2, 0x01]), 32);
    if (bitpos === n || bitpos + 32 + SPARSNAS_BITLEN > n) return DECODE_ABORT_EARLY;

    const buffer = bits.bytes(0, bitpos + 32, SPARSNAS_BITLEN);
    if (crc16(buffer, 18, 0x8005, 0xffff) !== ((buffer[18] << 8) | buffer[19])) return DECODE_FAIL_MIC;

    if (!sparsnas.sensorId) sparsnas.sensorId = sparsnasBruteForce(buffer);

    const sub = (sparsnas.sensorId - SPARSNAS_ID_KEY_SUB) >>> 0;
    // The key bytes are the serial's own bytes, shuffled, with a constant in the middle.
    const key = [(sub >>> 24) & 0xff, sub & 0xff, (sub >>> 8) & 0xff, 0x47, (sub >>> 16) & 0xff];
    const decrypted = new Uint8Array(18);
    for (let i = 0; i < 5; i++) decrypted[i] = buffer[i];
    for (let i = 0; i < 13; i++) decrypted[5 + i] = buffer[5 + i] ^ key[i % 5];

    const rcvSensorId = (((decrypted[5] << 24) | (decrypted[6] << 16) | (decrypted[7] << 8) | decrypted[8]) >>> 0);

    // Either no sender was ever found, or this frame is from a different one than the key belongs to. The CRC
    // still passed, so a real Sparsnäs is on the air and saying so is more useful than silence.
    if (!sparsnas.sensorId || rcvSensorId !== sparsnas.sensorId) {
      ctx.emit({ model: 'Ikea-Sparsnas', id: sparsnas.sensorId, mic: 'CRC' });
      return 1;
    }

    // Two bytes the sender never varies. They are the check that the key was right, not that the frame was.
    if (decrypted[0] !== 0x11) return DECODE_FAIL_SANITY;
    if (decrypted[3] !== 0x07) return DECODE_FAIL_SANITY;

    const pulses = (((decrypted[13] << 24) | (decrypted[14] << 16) | (decrypted[15] << 8) | decrypted[16]) >>> 0);
    ctx.emit({
      model: 'Ikea-Sparsnas',
      id: rcvSensorId,
      sequence: (decrypted[9] << 8) | decrypted[10],
      // Named for the field every other sensor has, but this one sends a level rather than a flag.
      battery_ok: round2(decrypted[17] * 0.01),
      pulses_per_kWh: SPARSNAS_PULSES_PER_KWH,
      cumulative_kWh: round3(pulses / SPARSNAS_PULSES_PER_KWH),
      effect: (decrypted[11] << 8) | decrypted[12],
      pulses,
      mode: decrypted[4] ^ 0x0f,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// ESIC EMT7110 (136)
// ---------------------------------------------------------------------------------------------------------

/**
 * The ESIC EMT7110 plug-in meter, which reports the whole picture: volts, amps, watts and a running total.
 *
 * The voltage is sent as half a volt per step with 128 volts subtracted first, which is a neat fit for a mains
 * socket and useless for anything else — it cannot express a reading below 128 V at all.
 */
export const esicEmt7110: RDevice = register({
  num: 136,
  name: 'ESIC EMT7110 power meter',
  what: 'plug-in socket power meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 104,
  longWidth: 104,
  resetLimit: 10000,
  bands: [868280000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];
    if (n < 120 || n > 140) return DECODE_ABORT_LENGTH;

    let offset = bits.search(0, 0, new Uint8Array([0xaa, 0x2d, 0xd4]), 24);
    offset += 24;
    // Upstream only checks the preamble itself fits; the payload has to fit too or the read runs off the row.
    if (offset + 96 > n) return DECODE_ABORT_EARLY;
    const b = bits.bytes(0, offset, 96);

    // Every byte including the check byte adds to a multiple of 256.
    if ((sumBytesFull(b, 12) & 0xff) !== 0) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'ESIC-EMT7110',
      id: hexLow(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 8),
      power_W: round1((((b[4] & 0x3f) << 8) | b[5]) * 0.5),
      current_A: round3(((b[6] << 8) | b[7]) * 0.001),
      voltage_V: round1((b[8] + 256) * 0.5),
      energy_kWh: round2((((b[9] & 0x3f) << 8) | b[10]) * 0.01),
      pairing: (b[4] & 0x80) >> 7,
      connected: (b[4] & 0x40) >> 6,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// Norgo NGE101 (139)
// ---------------------------------------------------------------------------------------------------------

/** The feedback positions of the Norgo's shift register, one entry per bit of its state. */
const NORGO_TAPS = [
  0x4880, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x2080, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000,
];

function norgoNextMask(mask: number): number {
  let nMask = mask >> 1;
  for (let i = 0; i < 15; i++) if (mask & (1 << i)) nMask ^= NORGO_TAPS[i];
  return nMask & 0xffff;
}

/**
 * The Norgo's check byte: a shift register clocked backwards over the message.
 *
 * It walks the payload from its last bit down to the first, advancing a sixteen-bit register once per bit and
 * folding the register into a running total wherever the message has a one — the same shape as the digests in
 * `util.ts`, but with its own tap table and run in the opposite direction, so it is kept here.
 */
function norgoChecksum(data: Uint8Array, datalen: number): number {
  let mask = 0x0001;
  let chks = 0;
  for (let i = datalen - 1; i > 7; i--) {
    mask = norgoNextMask(mask);
    if ((data[(i / 8) | 0] >> (i % 8)) & 1) chks ^= mask;
  }
  return (chks >> 8) & 0xff;
}

/**
 * The Norgo NGE101, which splits what it knows across two different messages.
 *
 * One message carries the gap between the last two meter flashes and the other carries the total count since
 * the sender was switched on, and they are told apart by a single bit rather than a type field. Neither is
 * energy on its own: the gap gives instantaneous power and the count gives accumulated energy, but only after
 * dividing by the meter's own pulses-per-kilowatt-hour, which the sender does not know.
 *
 * The whole frame arrives upside down. The preamble is checked in that state, then the buffer is inverted and
 * every byte reversed, because the sender transmits each field least significant bit first.
 */
export const norgo: RDevice = register({
  num: 139,
  name: 'Norgo NGE101',
  what: 'optical head on a domestic electricity meter',
  modulation: Modulation.OOK_DMC,
  shortWidth: 486,
  longWidth: 972,
  resetLimit: 2100,
  syncWidth: 0,
  tolerance: 120,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];
    if (n !== 56 && n !== 72 && n !== 55 && n !== 71) return DECODE_ABORT_LENGTH;

    const b = bits.bb[0];
    if (b[0] !== (~0xfa & 0xff)) return DECODE_ABORT_EARLY;

    // An exclusive-or across the body that has to come to all ones, checked while still inverted.
    if (xorBytes(b, ((n - 15) / 8) | 0, 1) !== 0xff) return DECODE_FAIL_MIC;

    bits.invert();
    reflectBytes(b, ((n + 1) / 8) | 0);

    const deviceId = ((b[1] & 0xf0) >> 4) | ((b[2] & 0x0f) << 4);
    const channel = ((b[1] & 0x0e) >> 1) + 1;

    if ((b[1] & 0x01) === 0) {
      if (norgoChecksum(b, 5 * 8) !== b[6]) return DECODE_FAIL_MIC;
      ctx.emit({
        model: 'Norgo-NGE101',
        id: deviceId,
        channel,
        // Time between the last two meter flashes, in 1/1024 of a second. Shorter means more power drawn.
        gap: (b[2] >> 4) | (b[3] << 4) | ((b[4] & 0x7f) << 12),
        mic: 'CRC',
      });
      return 1;
    }

    if (norgoChecksum(b, 7 * 8) !== b[8]) return DECODE_FAIL_MIC;
    // The counter is thirty-four bits wide and upstream reports the low thirty-two, which is far more than a
    // set of batteries will ever outlast. The shifts below wrap at thirty-two bits, which is that truncation.
    const impulses = (((b[2] >> 4) | (b[3] << 4) | (b[4] << 12) | (b[5] << 20) | ((b[6] & 0x3f) << 28)) >>> 0);
    ctx.emit({
      model: 'Norgo-NGE101',
      id: deviceId,
      channel,
      impulses,
      battery_ok: ((b[6] & 0x40) >> 6) ? 0 : 1,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// Marlec Solar iBoost+ (188)
// ---------------------------------------------------------------------------------------------------------

/**
 * The Marlec iBoost+, which diverts surplus solar generation into an immersion heater.
 *
 * So the interesting number is not consumption but how much of the day's generation it managed to use rather
 * than export, which it reports as a running saving — and only one of the five periods per frame, cycling
 * through today, yesterday, the last week, the last four weeks and the lifetime total.
 *
 * It runs after Watts-Vision rather than before. The two use the same CRC-16 with the same polynomial and
 * starting value over overlapping bytes of the same transmission, so a Watts-Vision frame will satisfy this
 * decoder's check as well; letting the more specific one settle the frame first is the only thing separating
 * them. Only the frame type marks a reading, so everything derived is held back unless that type is present.
 */
export const marlecSolar: RDevice = register({
  num: 188,
  name: 'Marlec Solar iBoost+ sensors',
  what: 'solar immersion diverter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 20,
  longWidth: 20,
  resetLimit: 300,
  priority: 10,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];

    const preamble = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);
    const start = bits.search(0, 0, preamble, 48);
    if (start === n) return DECODE_ABORT_EARLY;
    if (n < 12 * 8) return DECODE_ABORT_LENGTH;

    const lenByte = bits.bytes(0, start + 48, 8)[0];
    if (lenByte > 105) return DECODE_ABORT_LENGTH;
    if (start + 56 + (lenByte + 2) * 8 > n) return DECODE_ABORT_LENGTH;

    // The length byte leads the buffer the CRC is taken over, and the two CRC bytes follow the payload.
    const frame = new Uint8Array(108);
    frame[0] = lenByte;
    frame.set(bits.bytes(0, start + 56, (lenByte + 2) * 8), 1);

    const want = crc16(frame, lenByte + 1, 0x8005, 0xffff);
    if (((frame[lenByte + 1] << 8) | frame[lenByte + 2]) !== want) return DECODE_FAIL_MIC;

    let raw = '';
    for (let i = 0; i < lenByte; i++) raw += hexLow(frame[i + 1], 2);

    const data: R433Data = { model: 'Marlec-Solar', raw, mic: 'CRC' };

    if (frame[3] === 0x22) {
      data['boost_time'] = frame[6];                 // minutes of manual boost still to run
      data['solar_off'] = frame[7];
      data['tank_hot'] = frame[8];
      data['battery_low'] = frame[13];
      // Signed: the heater can be reported as drawing from the grid rather than from the panels.
      data['heating'] = ((frame[17] | (frame[18] << 8)) << 16) >> 16;
      data['import_val'] = (frame[19] | (frame[20] << 8) | (frame[21] << 16) | (frame[22] << 24)) | 0;

      const savedVal = (frame[26] | (frame[27] << 8) | (frame[28] << 16) | (frame[29] << 24)) | 0;
      // One period per frame, named by a marker byte rather than sent in a fixed slot.
      const period = ({
        0xca: 'saved_today', 0xcb: 'saved_yesterday', 0xcc: 'saved_last_7',
        0xcd: 'saved_last_28', 0xce: 'saved_total',
      } as Record<number, string>)[frame[25]];
      if (period) data[period] = savedVal;
    }

    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// Revolt NC-5462 (239)
// ---------------------------------------------------------------------------------------------------------

/**
 * The Revolt NC-5462 plug-in meter.
 *
 * Its only integrity check is a byte sum, backed by a rule that a frame whose payload sums to zero is noise
 * rather than a reading. That rule is why the sum has to be taken at full width here: a real frame whose
 * eleven bytes come to exactly 256 has a low byte of zero, and a sum masked to a byte would throw it away as
 * empty. The check byte for such a frame is zero too, so it passes the checksum and is refused by the sanity
 * rule alone — the mask would be the only thing deciding it.
 *
 * The frame arrives inverted, and pressing the button on the meter makes it repeat the same reading with the
 * top bit set, which is reported as a button press rather than treated as a different message.
 */
export const revoltNc5462: RDevice = register({
  num: 239,
  name: 'Revolt NC-5642 Energy Meter',
  what: 'plug-in socket power meter',
  modulation: Modulation.OOK_PWM,
  shortWidth: 200,
  longWidth: 320,
  syncWidth: 10024,
  resetLimit: 272,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] !== 104) return DECODE_ABORT_EARLY;

    const b = bits.bb[0];
    const sum = sumBytesFull(b, 11);
    if (sum === 0) return DECODE_FAIL_SANITY;
    if ((sum & 0xff) !== b[11]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Revolt-NC5462',
      id: ((b[0] & 0x7f) << 8) | b[1],
      voltage_V: b[2],
      current_A: round2(((b[3] << 8) | b[4]) * 0.01),
      frequency_Hz: b[5],
      power_W: round2(((b[6] << 8) | b[7]) * 0.1),
      power_factor_VA: round2(b[8] * 0.01),
      energy_kWh: round2(((b[9] << 8) | b[10]) * 0.01),
      button: b[0] >> 7,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// Revolt ZX-7717 (274)
// ---------------------------------------------------------------------------------------------------------

/**
 * The Revolt ZX-7717 socket meter, which sends two different messages and marks them by length alone.
 *
 * There is no type field the decoder can rely on — the length byte is what says whether the frame carries
 * live volts and amps or an accumulated energy total, and the two "coldstart" variants are the same pair with
 * six extra bytes wedged in ahead of the payload. Everything is little endian and every byte arrives with its
 * bits reversed, so the frame is reflected before anything is read out of it.
 */
const ZX7717_POWER = 13;
const ZX7717_ENERGY = 14;
const ZX7717_POWER_COLD = 17;
const ZX7717_ENERGY_COLD = 18;

export const revoltZx7717: RDevice = register({
  num: 274,
  name: 'Revolt ZX-7717 power meter',
  what: 'plug-in socket power meter',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 310,
  longWidth: 310,
  resetLimit: 900,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const rowLen = bits.bitsPerRow[0];
    if (rowLen < 15 * 8 || rowLen > 22 * 8) return DECODE_ABORT_EARLY;

    let pos = bits.search(0, 0, new Uint8Array([0x2a]), 8);
    pos += 8;
    if (pos > 16) return DECODE_ABORT_LENGTH;        // a sync byte found deep in the row is a coincidence

    const len = rowLen - pos;
    const b = bits.bytes(0, pos, len);
    reflectBytes(b, (len + 7) >> 3);

    const msgLen = b[0];
    if (msgLen < 1) return DECODE_FAIL_SANITY;
    if (len < (msgLen + 1) * 8) return DECODE_ABORT_LENGTH;
    if ((sumBytesFull(b, msgLen) & 0xff) !== b[msgLen]) return DECODE_FAIL_MIC;

    const data: R433Data = {
      model: 'Revolt-ZX7717',
      id: (b[2] << 8) | b[1],
      version: b[3],
      mic: 'CHECKSUM',
    };

    if (msgLen === ZX7717_POWER || msgLen === ZX7717_POWER_COLD) {
      const at = msgLen === ZX7717_POWER ? 7 : 11;
      data['current_A'] = round3((((b[at + 1] << 8) | b[at]) * 0.001));
      data['voltage_V'] = round1((((b[at + 3] << 8) | b[at + 2]) * 0.1));
      data['power_W'] = round1((((b[at + 5] << 8) | b[at + 4]) * 0.1));
    } else if (msgLen === ZX7717_ENERGY || msgLen === ZX7717_ENERGY_COLD) {
      const at = msgLen === ZX7717_ENERGY ? 6 : 10;
      data['energy_kWh'] = round2(((b[at + 2] << 16) | (b[at + 1] << 8) | b[at]) * 0.01);
    } else {
      return DECODE_FAIL_OTHER;
    }

    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// Voltcraft EnergyCount 3000 (289)
// ---------------------------------------------------------------------------------------------------------

const EC3K_PACKET_BYTES = 41;

/** One bit of a row, counting from the top of byte zero. */
const ec3kBitAt = (m: Uint8Array, bit: number) => (m[bit >> 3] >> (7 - (bit & 7))) & 1;

/** Undo the line coding: a symbol is a one where the level held and a zero where it changed. */
function ec3kSymbolAt(m: Uint8Array, bit: number): number {
  const bit0 = bit > 0 ? ec3kBitAt(m, bit - 1) : 0;
  return bit0 === ec3kBitAt(m, bit) ? 1 : 0;
}

/**
 * Undo the transmitter's whitening as well.
 *
 * The radio chip runs the data through a scrambler before sending it, so the air never carries long runs of
 * one level even when the payload is mostly zeroes. Descrambling is self-synchronizing: each symbol is
 * exclusive-ored with two earlier ones, which is why the decode can start part way into a burst without
 * knowing where the scrambler was reset — and why the first seventeen bits are unusable and skipped.
 */
function ec3kDescrambledAt(m: Uint8Array, bit: number): number {
  let out = ec3kSymbolAt(m, bit);
  if (bit > 17) out ^= ec3kSymbolAt(m, bit - 17);
  if (bit > 12) out ^= ec3kSymbolAt(m, bit - 12);
  return out;
}

/** Read a run of nibbles as one number. Fields here are nibble-aligned rather than byte-aligned. */
function ec3kNibbles(buf: Uint8Array, start: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i++) {
    v = v * 16 + ((buf[(start + i) >> 1] >> ((1 - ((start + i) & 1)) * 4)) & 0x0f);
  }
  return v;
}

/**
 * Turn a recovered 41-byte packet into a reading, or say why it is not one.
 *
 * Several fields are split across the packet with their high and low halves far apart, which is a hint that
 * the format grew: the counters outgrew their original width and the extra digits were put wherever there was
 * room. The gaps between fields are always zero, and are checked — with only sixteen bits of CRC over a frame
 * this long, the padding is worth as much as the CRC.
 */
function ec3kExtract(p: Uint8Array, ctx: DecodeCtx): number {
  const pad1 = ec3kNibbles(p, 9, 4);
  const pad2 = ec3kNibbles(p, 17, 7);
  const pad3 = ec3kNibbles(p, 62, 5);
  const pad4 = ec3kNibbles(p, 77, 1);
  if (pad1 !== 0 || pad2 !== 0 || pad3 !== 0 || pad4 !== 0) return DECODE_FAIL_SANITY;

  const receivedCrc = 0xffff ^ (ec3kNibbles(p, 78, 2) | (ec3kNibbles(p, 80, 2) << 8));
  if (crc16lsb(p, EC3K_PACKET_BYTES - 2, 0x8408, 0xffff) !== receivedCrc) return DECODE_FAIL_MIC;

  // The energy total is a 56-bit count of watt-seconds carried as two separate halves.
  const energyWs = ec3kNibbles(p, 67, 4) * 0x10000000 + ec3kNibbles(p, 24, 7);

  ctx.emit({
    model: 'Voltcraft-EC3k',
    id: hexLow(ec3kNibbles(p, 1, 4), 4),
    power: round3(ec3kNibbles(p, 31, 4) / 10),
    energy: round3(energyWs / 3600000),
    energy2: round3(ec3kNibbles(p, 39, 6) / 3600000),
    time_total: ((ec3kNibbles(p, 5, 4) | (ec3kNibbles(p, 59, 3) << 16)) >>> 0),
    time_on: ((ec3kNibbles(p, 13, 4) | (ec3kNibbles(p, 71, 3) << 16)) >>> 0),
    power_max: round3(ec3kNibbles(p, 35, 4) / 10),
    reset_counter: ec3kNibbles(p, 74, 2),
    flags: ec3kNibbles(p, 76, 1),
    mic: 'CRC',
  });
  return 1;
}

/**
 * The Voltcraft EnergyCount 3000, sold under at least four other names.
 *
 * This is the only decoder in the file that has to find its own frame boundaries. The others are handed a row
 * the slicer already delimited; this one gets a continuous stream and has to walk it a symbol at a time,
 * because the transmitter uses the link layer a modem would — frames delimited by a run of exactly six ones,
 * and a zero forcibly inserted after any five ones in the payload so that run can never occur by accident.
 * Removing those inserted zeroes is what "unstuffing" below means, and it is why the payload's bit count and
 * the air's bit count are different numbers.
 *
 * Anything that cannot be one of those two cases — a seventh consecutive one, or a stray run — means the
 * stream was joined mid-frame or corrupted, and the reader is thrown away and started again.
 */
export const ec3k: RDevice = register({
  num: 289,
  name: 'Voltcraft EnergyCount 3000 (ec3k)',
  what: 'plug-in socket power meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 50,
  longWidth: 50,
  tolerance: 5,
  gapLimit: 3000,
  resetLimit: 5000,
  bands: [868300000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1 || bits.bitsPerRow[0] < 90) return DECODE_ABORT_LENGTH;

    const row = bits.bb[0];
    const n = bits.bitsPerRow[0];
    const packet = new Uint8Array(EC3K_PACKET_BYTES);
    let rc = DECODE_ABORT_EARLY;

    let packetpos = 0, inPacket = false, onecount = 0, recbyte = 0, recpos = 0;
    const resync = () => { packetpos = 0; inPacket = false; onecount = 0; recbyte = 0; recpos = 0; };

    // The first seventeen symbols cannot be descrambled: they have no history behind them.
    for (let at = 17; rc !== 1 && at < n; at++) {
      if (ec3kDescrambledAt(row, at)) {
        if (onecount < 6 && packetpos < EC3K_PACKET_BYTES) {
          onecount++;
          recbyte = (recbyte >> 1) | 0x80;           // bytes arrive least significant bit first
          if (++recpos === 8 && inPacket) { recpos = 0; packet[packetpos++] = recbyte; }
        } else {
          resync();                                  // a seventh one in a row cannot happen in a real frame
        }
      } else {
        if (onecount < 5 && packetpos < EC3K_PACKET_BYTES) {
          recbyte = recbyte >> 1;
          if (++recpos === 8 && inPacket) { recpos = 0; packet[packetpos++] = recbyte; }
        } else if (onecount === 5) {
          // A zero after five ones was inserted by the transmitter. Drop it and keep the byte alignment.
        } else if (onecount === 6) {
          inPacket = !inPacket;                      // the delimiter: start of a frame, or the end of one
          packetpos = 0;
          recpos = 0;
        } else {
          resync();
        }
        onecount = 0;
      }

      if (packetpos >= EC3K_PACKET_BYTES) {
        rc = ec3kExtract(packet, ctx);
        resync();
      }
    }
    return rc;
  },
});

// ---------------------------------------------------------------------------------------------------------
// RFXMeter / RFXPwr (334)
// ---------------------------------------------------------------------------------------------------------

/**
 * The RFXMeter and RFXPwr pulse counters.
 *
 * These borrow the frame the X10 remote-control system uses, which is why the address is sent twice — once
 * plainly and once with its high nibble flipped — as a coarse guard against a mis-slice. Note that upstream's
 * own documentation says the second copy has "the nibbles complemented", plural, but its code flips only the
 * high nibble; the code is what a receiver has to agree with, so that is what is implemented, and it halves
 * the strength of the guard the comment describes.
 *
 * Most frames are a counter reading, but the same frame carries configuration — a reporting interval, a
 * calibration value, an address change — distinguished by a type field. Only the type and the raw value are
 * reported, because what the value means changes completely with the type.
 */
export const rfxmeter: RDevice = register({
  num: 334,
  name: 'RfxMeter, RFXPwr',
  what: 'pulse counter for electricity, gas or water',
  modulation: Modulation.OOK_PPM,
  shortWidth: 500,
  longWidth: 1500,
  gapLimit: 2500,
  resetLimit: 5000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The lead-in sometimes slices into a short row of its own, so a second row is tolerated.
    if (bits.numRows !== 1 && bits.numRows !== 2) return DECODE_ABORT_LENGTH;

    const row = bits.numRows - 1;
    if (bits.bitsPerRow[row] !== 48) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];

    if ((b[0] ^ 0xf0) !== b[1]) return DECODE_FAIL_SANITY;
    // Every nibble of the frame, the check included, adds to all ones in the bottom nibble.
    if ((addNibbles(b, 6) & 0x0f) !== 0x0f) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'RfxMeter',
      id: b[0],
      msg_type: b[5] >> 4,
      // The three counter bytes are not sent in order; this is the order the receiver reassembles them in.
      msg_value: ((b[4] << 16) | (b[2] << 8) | b[3]) >>> 0,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------------------------------------
// Eco-Eye solar PV and grid monitor (351)
// ---------------------------------------------------------------------------------------------------------

/**
 * The Eco-Eye, which watches a house's import and its solar generation with one clamp each.
 *
 * It sends current rather than power, and never says at what voltage, so what comes out is amps and turning
 * that into watts is the display's job. It carries no identity at all — a transmitter and its display are
 * assumed to be alone on the channel — so nothing distinguishes two of these in earshot of each other.
 *
 * Its reset limit is far longer than the bit period needs, because there is no clock recovery beyond that
 * period: a quiet house sending two zero readings and a zero checksum puts forty consecutive zero bits on the
 * air, and the demodulator has to be told to keep counting through them rather than call the burst over.
 */
export const ecoeye: RDevice = register({
  num: 351,
  name: 'Eco-Eye solar PV/grid current monitor',
  what: 'solar and grid current monitor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 200,
  longWidth: 200,
  resetLimit: 8100,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];

    let start = bits.search(0, 0, new Uint8Array([0xaa, 0x2d, 0xd4]), 24);
    start += 24;
    if (start >= n) return DECODE_ABORT_EARLY;
    if (start + 40 > n) return DECODE_ABORT_LENGTH;

    const msg = bits.bytes(0, start, 40);
    if ((sumBytesFull(msg, 4) & 0xff) !== msg[4]) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'EcoEye',
      // Hundredths of an amp. Upstream reasons its way to that scale rather than having it confirmed: it is
      // the only one that keeps a deliberately loaded reading inside what a clamp of this kind can measure.
      current_used_A: round2(((msg[2] << 8) | msg[3]) * 0.01),
      current_pv_A: round2(((msg[0] << 8) | msg[1]) * 0.01),
      mic: 'CHECKSUM',
    });
    return 1;
  },
});
