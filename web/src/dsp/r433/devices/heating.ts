/**
 * Heating, pool and utility devices: two thermostats, a boiler control, a gas-fire remote, a pool-light remote,
 * three meters, an energy monitor and a weather station that keeps its readings behind a heating-grade CRC.
 *
 * They are grouped by what they are for rather than by how they work, because almost nothing here shares a
 * modulation with anything else. Several are worth a note before the code.
 *
 * The Danfoss thermostat carries its nibbles through a 4b/6b line code, so sixteen legal six-bit symbols map
 * back to nibbles and everything else is a decoding error rather than a bad checksum. That table is the whole
 * integrity story ahead of the CRC, and it is strict: a single flipped bit inside a symbol almost always lands
 * on a code that is not in the table at all.
 *
 * The Vaillant boiler control is the one that would have been silently wrong. Its checksum is a sixteen-bit
 * two's complement of a run of nine bytes, and that sum genuinely overflows a byte on upstream's own documented
 * frame — 695, or 0x2b7. Narrowing it first, which is what the shared `addBytes` helper does, gives 0xb7 and the
 * comparison never lands. The sum is taken locally at full width here for exactly that reason, and the test
 * asserts the overflow as a premise rather than trusting the answer to come out right by luck.
 *
 * The Clipsal power meter is doubly encoded. The demodulator hands over one bit per pulse, and a second layer
 * on top of that reads pairs and triples of those bits as "hold" and "toggle" instructions to rebuild the real
 * bitstream. There is no checksum anywhere in it; the only integrity check is that the payload is sent twice and
 * the two copies must agree, so that comparison is load-bearing rather than incidental.
 *
 * The Proflame gas-fire remote uses Manchester coding the opposite way up from the rest of the codebase, which
 * the file handles by complementing the decoded bytes rather than the input. Each of its seven words carries its
 * own guard bits and parity, so a word that fails stops the whole frame — which is why the decode is written as
 * a loop returning how many words it managed rather than as a plain success or failure.
 *
 * Two of these decline to report things upstream also declines to report, and that is kept: the Flowis meter
 * reads only its type-1 messages even though it validates type-2 ones, and the WMR500 verifies its short
 * messages and then deliberately says nothing about them because their payload is not understood. Reporting a
 * guess there would be worse than reporting nothing.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `danfoss.c`, `emontx.c`, `vaillant_vrt340f.c`, `cmr113.c`,
 * `proflame2.c`, `srsmith_pool_srs_2c_tx.c`, `flowis.c`, `celsia_czc1.c`, `mueller_hotrod.c`,
 * `oregon_scientific_wmr500.c`.
 */

import { BitBuffer, bitAt } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc8, crc16, crc16lsb, parity8, reflectBytes, reverse8 } from '../util.js';

/** Upstream states a frequency for only two of these ten; the rest claim none rather than guess. */
const BAND_315 = [314973000];
const BAND_915 = [915000000];

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const dec2 = (v: number) => v.toString().padStart(2, '0');

/** One byte read at an arbitrary bit offset, MSB first — rtl_433's `bitrow_get_byte`. */
function bitrowGetByte(row: Uint8Array, pos: number): number {
  return (((row[pos >> 3] << 8) | row[(pos >> 3) + 1]) >> (8 - (pos & 7))) & 0xff;
}

// ---------------------------------------------------------------------------
// Danfoss CFR thermostat (26)
// ---------------------------------------------------------------------------

/**
 * The 4b/6b line code, as a lookup from the six-bit symbol to the nibble it means.
 *
 * Only sixteen of the sixty-four possible symbols are legal. Everything else is a decoding error, which makes
 * this the device's first and strictest integrity check — a flipped bit inside a symbol nearly always produces
 * a code that is simply not here.
 */
const DANFOSS_6B4B = new Map<number, number>([
  [0x0b, 0xd], [0x0d, 0xe], [0x0e, 0x3], [0x13, 0x4],
  [0x15, 0xa], [0x16, 0xf], [0x19, 0x9], [0x1a, 0x6],
  [0x25, 0x0], [0x26, 0x7], [0x29, 0x1], [0x2a, 0x5],
  [0x2c, 0xc], [0x31, 0xb], [0x32, 0x2], [0x34, 0x8],
]);

/** The switch positions the thermostat reports. Anything else is named as an error rather than guessed at. */
function danfossSwitch(v: number): string {
  if (v === 2) return 'DAY';
  if (v === 4) return 'TIMER';
  if (v === 8) return 'NIGHT';
  return 'ERROR';
}

export const danfossCfr: RDevice = register({
  num: 26,
  name: 'Danfoss CFR Thermostat',
  what: 'room thermostat',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 500,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];
    // A whole transmission is 255 bits; the preamble picks up a little noise at either end.
    if (rowBits < 246 || rowBits > 260) return DECODE_ABORT_LENGTH;

    // The encoded prefix. Three nibbles would be eighteen bits, but sixteen is enough to find it, and the
    // search starts fourteen bytes in because the preamble ahead of it is always longer than that.
    const header = new Uint8Array([0x36, 0x5c]);
    const found = bits.search(0, 112, header, 16);
    if (rowBits - found < 126) return DECODE_ABORT_LENGTH;

    // Skip the leading 0xE nibble: it sits outside the CRC and dropping it gives byte alignment.
    const bitOffset = found + 6;

    const row = bits.bb[0];
    const bytes = new Uint8Array(10);
    for (let n = 0; n < 10; n++) {
      const hi = DANFOSS_6B4B.get(bitrowGetByte(row, n * 12 + bitOffset) >> 2);
      const lo = DANFOSS_6B4B.get(bitrowGetByte(row, n * 12 + bitOffset + 6) >> 2);
      if (hi === undefined || lo === undefined) return DECODE_FAIL_SANITY;
      bytes[n] = (hi << 4) | lo;
    }

    // The prefix check is largely redundant with the header search but pins the last bits of it.
    if (bytes[0] !== 0x02) return DECODE_FAIL_MIC;
    if (crc16(bytes, 8, 0x1021, 0x0000) !== ((bytes[8] << 8) | bytes[9])) return DECODE_FAIL_MIC;

    // The high nibble of byte three is a rolling message counter. Upstream does not report it, and neither
    // does this, so the two stay comparable field for field.
    ctx.emit({
      model: 'Danfoss-CFR',
      type: 'Thermostat',
      id: (bytes[1] << 8) | bytes[2],
      temperature_C: round2(bytes[5] + bytes[4] / 256),
      setpoint_C: round2(bytes[7] + bytes[6] / 256),
      switch: danfossSwitch(bytes[3] & 0x0f),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// emonTx OpenEnergyMonitor (45)
// ---------------------------------------------------------------------------

/**
 * An open-hardware energy monitor sending JeeLibs RF12 packets.
 *
 * The radio it uses drops the last zero bit of the preamble, so the search deliberately looks for only
 * twenty-two bits of run-in and then steps back one to line up on the sync byte. It also accepts the whole
 * frame inverted, because which way up the demodulator settles is not fixed.
 *
 * Six temperature probes can be attached and any of them may be absent; the sensor says so by sending exactly
 * 300.0 degrees, which is reported as nothing at all rather than as a reading.
 *
 * This is one of the few decoders that keeps looking after a success — several packets can share one burst —
 * so it returns how many it found.
 */
export const emontx: RDevice = register({
  num: 45,
  name: 'emonTx OpenEnergyMonitor',
  what: 'household energy monitor',
  modulation: Modulation.FSK_PCM,
  // 49261 kHz on the RFM69 and 49230 kHz on the RFM12B; upstream splits the difference.
  shortWidth: 2000000 / (49230 + 49261),
  longWidth: 2000000 / (49230 + 49261),
  resetLimit: 1200,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];

    const preamble = new Uint8Array([0xaa, 0xaa, 0xaa]);
    const pktHdr = new Uint8Array([0x2d, 0xd2, 0x00]);
    const pktHdrInverted = new Uint8Array([0xd2, 0x2d, 0xc0]);
    const PKT_BYTES = 33;                            // syn, group, node, len, fourteen words, postamble

    let events = 0;
    let bitpos = 0;

    while ((bitpos = bits.search(0, bitpos, preamble, 22)) < rowBits) {
      bitpos += 22;

      // Swallow any further 1010 pairs, which noise at the head of a burst can add to the run-in.
      while (bits.search(0, bitpos, preamble, 2) === bitpos) bitpos += 2;

      // Step back over the zero bit the radio drops before the sync byte, and to allow for inversion.
      bitpos--;

      let inverted = false;
      let pktPos = bits.search(0, bitpos, pktHdr, 11);
      if (pktPos > bitpos + 5) {
        pktPos = bits.search(0, bitpos, pktHdrInverted, 11);
        if (pktPos > bitpos + 5) continue;           // neither polarity lines up close enough
        inverted = true;
      }

      if (pktPos + PKT_BYTES * 8 > rowBits) break;   // not enough left for a whole packet

      // The group byte is extracted even though the search matched on it, because the CRC covers it.
      const pkt = bits.bytes(0, pktPos, PKT_BYTES * 8);
      if (inverted) for (let i = 0; i < PKT_BYTES; i++) pkt[i] ^= 0xff;

      if (pkt[3] !== 0x1a || pkt[32] !== 0xaa) continue;

      const crc = crc16lsb(pkt, 0x1d, 0xa001, 0xffff, 1);

      // Fourteen little-endian words follow the four-byte header; the last of them is the CRC.
      const words: number[] = [];
      for (let i = 0; i < 14; i++) words.push(pkt[4 + i * 2] | (pkt[5 + i * 2] << 8));
      if (crc !== words[13]) continue;

      const signed = (w: number) => (w << 16) >> 16;
      const out: R433Data = {
        model: 'emonTx-Energy',
        type: 'Energy',
        node: pkt[2] & 0x1f,
        ct1: signed(words[0]),
        ct2: signed(words[1]),
        ct3: signed(words[2]),
        ct4: signed(words[3]),
        batt_Vrms: round2(words[4] / 100),
        pulse: ((words[11] | (words[12] << 16)) >>> 0),
        mic: 'CRC',
      };
      // A probe that is not connected reports exactly 300.0 C, which is left out rather than printed.
      for (let i = 0; i < 6; i++) {
        if (words[5 + i] !== 3000) out[`temp${i + 1}_C`] = round1(words[5 + i] * 0.1);
      }

      ctx.emit(out);
      events++;
    }

    return events;
  },
});

// ---------------------------------------------------------------------------
// Vaillant calorMatic VRT340f central heating control (77)
// ---------------------------------------------------------------------------

/**
 * A boiler control sending differential Manchester with bit stuffing, least significant bit first.
 *
 * Three things have to be undone in order before any field means anything: the stuffing (a zero inserted after
 * every five consecutive ones), the bit order within each byte, and only then the layout.
 *
 * The checksum is a sixteen-bit two's complement of nine payload bytes — the sum and the carried value must add
 * to zero across sixteen bits. That sum overflows a byte on upstream's own documented frame, so it is taken
 * here at full width rather than through the shared helper, which narrows to eight bits.
 */
function vaillantChecksumOk(b: Uint8Array, from: number, to: number, csFrom: number, csTo: number): boolean {
  const expected = (b[csFrom] << 8) | b[csTo];
  let calculated = 0;
  for (let i = from; i <= to; i++) calculated += b[i];   // full width: this genuinely exceeds 0xff
  return ((calculated + expected) & 0xffff) === 0;
}

export const vaillantVrt340f: RDevice = register({
  num: 77,
  name: 'Vaillant calorMatic VRT340f Central Heating Control',
  what: 'central heating control',
  modulation: Modulation.OOK_DMC,
  shortWidth: 836,                                   // half-bit width
  longWidth: 1648,                                   // bit width
  resetLimit: 4000,
  tolerance: 120,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;
    // A frame is 128 bits plus however many stuffing bits it needed.
    if (bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH;

    // Remove the stuffing into a buffer of our own; the shared one is only ever read.
    const src = bits.bb[0];
    const destuffed = new BitBuffer();
    let ones = 0;
    for (let k = 0; k < bits.bitsPerRow[0]; k++) {
      const bit = bitAt(src, k);
      if (bit === 1) {
        destuffed.addBit(1);
        ones++;
      } else {
        if (ones !== 5) destuffed.addBit(0);        // a zero right after five ones was inserted, not sent
        ones = 0;
      }
    }

    const b = destuffed.bb[0];
    const bitcount = destuffed.bitsPerRow[0];

    /*
     * Put each byte the right way round. Upstream reflects one byte fewer than the frame holds, so the very
     * last byte keeps its transmitted bit order — harmless, because that byte is part of the trailing epilogue
     * and nothing reads it. The quirk is kept so the two implementations agree byte for byte.
     */
    reflectBytes(b, ((bitcount - 1) / 8) | 0);

    // A frame is 128 or 168 bits, plus up to three more bits of clock sync at the end.
    const isNormal = bitcount >= 128 && bitcount <= 131;
    const isDetect = bitcount >= 168 && bitcount <= 171;
    if (!isNormal && !isDetect) return DECODE_ABORT_LENGTH;

    const syncOk = b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x7e;

    if (syncOk && isNormal) {
      if (!vaillantChecksumOk(b, 3, 11, 12, 13)) return DECODE_FAIL_MIC;

      const heatingMode = b[10] >> 7;                // set for two-point control, clear for a target temperature
      const targetTemperature = b[10] & 0x7f;
      const waterPreheated = (b[9] & 8) === 0;
      const batteryLow = b[11] !== 0;

      ctx.emit({
        model: 'Vaillant-VRT340f',
        type: 'Thermostat',
        id: (b[3] << 8) | b[4],
        heating: (heatingMode === 0 && targetTemperature === 0) ? 'OFF'
          : heatingMode ? 'ON (2-point)' : 'ON (analogue)',
        heating_temp: targetTemperature,
        water: waterPreheated ? 'ON' : 'off',
        battery_ok: batteryLow ? 0 : 1,
      });
      return 1;
    }

    // The longer frame is what the control sends while pairing; only its device id is understood.
    if (syncOk && isDetect) {
      if (!vaillantChecksumOk(b, 3, 16, 17, 18)) return DECODE_FAIL_MIC;
      ctx.emit({
        model: 'Vaillant-VRT340f',
        type: 'Thermostat',
        id: (b[11] << 8) | b[12],
      });
      return 1;
    }

    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// Clipsal CMR113 cent-a-meter (193)
// ---------------------------------------------------------------------------

/**
 * A three-phase current clamp with two layers of coding and no checksum at all.
 *
 * The demodulator gives one bit per pulse — short pulses are ones, long pulses zeros, high and low alike. On
 * top of that sits a second layer: reading that stream, `00` means "the output bit stays as it was" and `011`
 * means "the output bit flips". Anything else is a decoding failure.
 *
 * What comes out is eighty-three bits sent twice. Since nothing in the payload is checksummed, those two copies
 * agreeing is the only thing standing between a reading and noise, which is why that comparison is treated as
 * the integrity check rather than as a convenience.
 *
 * Only the three current readings are understood. The frame also carries timestamps, transmitter ids and a CRC
 * that nobody has worked out, and none of that is guessed at here.
 */
export const cmr113: RDevice = register({
  num: 193,
  name: 'Clipsal CMR113 Cent-a-meter power meter',
  what: 'three-phase current clamp',
  modulation: Modulation.OOK_PIWM_DC,
  shortWidth: 480,
  longWidth: 976,
  syncWidth: 2028,
  resetLimit: 2069,
  // Short high and low pulses differ enough in length to need a wide tolerance.
  tolerance: 200,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];
    if (rowBits < 350 || rowBits > 450) return DECODE_ABORT_LENGTH;

    const head = bits.bytes(0, 0, 32);
    if (head[0] !== 0xb0 || head[1] !== 0x00 || head[2] !== 0x00) return DECODE_ABORT_EARLY;

    const COMPARE_BITS = 83;
    const COMPARE_BYTES = (COMPARE_BITS + 7) >> 3;

    // Rebuild the real bitstream into a buffer of our own.
    const out = new BitBuffer();
    let start = 0;
    let bit = 0;
    while (start + 3 < rowBits) {
      const chunk = bits.bytes(0, start, 3);
      if ((chunk[0] >> 6) === 0x00) {                // 00: hold
        start += 2;
        out.addBit(bit);
      } else if ((chunk[0] >> 5) === 0x03) {         // 011: toggle
        start += 3;
        bit = 1 - bit;
        out.addBit(bit);
      } else if (start === 0) {
        start += 1;                                  // the very first bit is not part of either pattern
      } else {
        return DECODE_ABORT_LENGTH;
      }
    }

    if (out.bitsPerRow[0] < 2 * COMPARE_BITS + 2) return DECODE_ABORT_LENGTH;

    // The payload is sent twice with two bits between the copies, and they must agree.
    const first = out.bytes(0, 0, COMPARE_BITS);
    const second = out.bytes(0, COMPARE_BITS + 2, COMPARE_BITS);
    for (let i = 0; i < COMPARE_BYTES; i++) if (first[i] !== second[i]) return DECODE_FAIL_MIC;

    // Three ten-bit currents, each sent least significant bit first, in tenths of an amp.
    const current: number[] = [];
    for (let i = 0; i < 3; i++) {
      const raw = out.bytes(0, 36 + i * 10, 10);
      reflectBytes(raw, 2);
      current.push(round1((raw[0] + ((raw[1] & 0x03) << 8)) * 0.1));
    }

    ctx.emit({
      model: 'Clipsal-CMR113',
      type: 'Energy',
      current_1_A: current[0],
      current_2_A: current[1],
      current_3_A: current[2],
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// SmartFire Proflame 2 gas fire remote (207)
// ---------------------------------------------------------------------------

/**
 * Read the seven words of a Proflame frame, returning how many were good.
 *
 * Each word is a four-bit sync-and-guard run of `1110`, then eleven Manchester-coded bits: eight of data, a
 * padding bit, a parity bit and a closing guard bit. The padding bit is set on the first word and clear on the
 * rest, which is what stops a frame being read starting from the wrong word.
 *
 * The Manchester convention here is the opposite of the one the shared decoder implements, so the decoded bytes
 * are complemented rather than the input bits.
 */
function proflame2Words(bits: BitBuffer, row: number, start: number, out: Uint8Array): number {
  let pos = start;
  for (let f = 0; ; f++) {
    if (bits.bitsPerRow[row] - pos < 26) return f;

    const b = bits.bb[row];
    const sync = (bitAt(b, pos) << 3) | (bitAt(b, pos + 1) << 2) | (bitAt(b, pos + 2) << 1) | bitAt(b, pos + 3);
    pos += 4;
    if (sync !== 0xe) return f;

    const decoded = new BitBuffer();
    pos = bits.manchesterDecode(row, pos, decoded, 11);
    if (decoded.bitsPerRow[0] !== 11) return f;

    // Turn IEEE Manchester into the G.E.T. convention this remote actually uses.
    const data = decoded.bb[0][0] ^ 0xff;
    const flag = decoded.bb[0][1] ^ 0xe0;

    const pad = (flag >> 7) & 1;
    const par = (flag >> 6) & 1;
    const end = (flag >> 5) & 1;

    if (pad !== (f === 0 ? 1 : 0)) return f;
    if ((parity8(data) ^ pad ^ par) !== 0) return f;
    if (end !== 1) return f;

    if (f < out.length) out[f] = data;
  }
}

export const proflame2: RDevice = register({
  num: 207,
  name: 'SmartFire Proflame 2 remote control',
  what: 'gas fireplace remote',
  modulation: Modulation.OOK_PCM,
  shortWidth: 417,                                   // 2400 baud
  longWidth: 417,
  gapLimit: 1000,                                    // the twelve quiet bits between repeats are 5000 us
  resetLimit: 6000,
  bands: BAND_315,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    for (let row = 0; row < bits.numRows; row++) {
      const b = new Uint8Array(7);
      if (proflame2Words(bits, row, 0, b) !== 7) continue;

      /*
       * The last two payload bytes are called error detection upstream but nothing checks them, so they go out
       * as raw values under their own names rather than being treated as a verified check. The two command
       * bytes are reported raw as well, alongside the flags unpacked from them.
       */
      ctx.emit({
        model: 'Proflame2-Remote',
        type: 'Remote',
        id: (b[0] << 16) | (b[1] << 8) | b[2],
        cmd1: b[3],
        cmd2: b[4],
        err1: b[5],
        err2: b[6],
        pilot: b[3] >> 7,
        light: (b[3] & 0x70) >> 4,
        thermostat: (b[3] & 0x02) >> 1,
        power: b[3] & 0x01,
        front: b[4] >> 7,
        fan: (b[4] & 0x70) >> 4,
        aux: (b[4] & 0x08) >> 3,
        flame: b[4] & 0x07,
        mic: 'CHECKSUM',
      });
      return 1;
    }
    return DECODE_FAIL_OTHER;
  },
});

// ---------------------------------------------------------------------------
// SRSmith pool light remote SRS-2C-TX (227)
// ---------------------------------------------------------------------------

/** The four buttons this remote has. An unrecognized code is named as such rather than invented. */
function srsmithButton(id: number): string {
  if (id === 0x0d) return 'On/Off Channel 1';
  if (id === 0x1f) return 'On/Off Channel 2';
  if (id === 0x07) return 'Color Sync';
  if (id === 0x0b) return 'ON/OFF Control - M';
  return 'Unknown';
}

/**
 * A pool light remote built around a CC110x radio, so it uses that family's usual `d391d391` sync word.
 *
 * The frame carries two checks but only one is enforced. The CRC-16 over the packet is compared and a mismatch
 * rejects the frame; the CRC-8 over the inner sub-packet is computed upstream, written to the log and then
 * ignored. Nothing has ever forced that second one's parameters to be right, and no capture is published to
 * settle it, so it is neither checked nor reported here — reporting it would dress an unverified number up as
 * an integrity result.
 *
 * The identifier is the remote's pin, sent inverted and bit-reversed. Upstream reports the whole reversed byte
 * under `id` while formatting only its top four bits for the log, and that is kept, because the byte is what
 * actually distinguishes two remotes.
 */
export const srsmithPoolSrs2cTx: RDevice = register({
  num: 227,
  name: 'SRSmith Pool Light Remote Control SRS-2C-TX (-f 915M)',
  what: 'pool light remote',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 4096,
  bands: BAND_915,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];
    // Ten payload bytes plus the sync word, with between one and four bytes of run-in still attached.
    if (rowBits < 120 || rowBits > 144) return DECODE_ABORT_LENGTH;

    const preamble = new Uint8Array([0xaa, 0xd3, 0x91, 0xd3, 0x91]);
    const startPos = bits.search(0, 0, preamble, 40) + 40;
    if (startPos >= rowBits) return DECODE_ABORT_EARLY;

    const b = bits.bytes(0, startPos, 10 * 8);

    if (((b[8] << 8) | b[9]) !== crc16(b, 8, 0x8005, 0xffff)) return DECODE_FAIL_MIC;

    const reversedPin = reverse8((~b[5]) & 0xff);

    ctx.emit({
      model: 'SRSmith-SRS2CTX',
      type: 'Remote',
      id: reversedPin,
      button_press: b[6],
      button_press_name: srsmithButton(b[6]),
      // Constant across every frame anyone has recorded, and of unknown meaning, so it goes out as it arrived.
      unknown: (((b[1] << 24) >>> 0) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Flowis water meter (237)
// ---------------------------------------------------------------------------

/**
 * A water meter, again on a CC110x radio and again behind the `d391d391` sync word.
 *
 * Several message types share one framing and one CRC. Only type 1 is understood, and upstream validates a
 * type-2 message and then declines to report it rather than reading type-1 fields out of a different layout;
 * that is kept, because the alternative is confident nonsense.
 *
 * The timestamp is packed across four bytes on no particular boundary, with the year counted from 2000.
 */
export const flowis: RDevice = register({
  num: 237,
  name: 'Flowis flow meters',
  what: 'water meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 10,
  longWidth: 10,
  resetLimit: 5000,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];

    const preamble = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);
    const startPos = bits.search(0, 0, preamble, 48);
    if (startPos === rowBits) return DECODE_ABORT_EARLY;

    const len = bits.bytes(0, startPos + 48, 8)[0];

    /*
     * Upstream reads the length byte and then extracts that many bytes without checking the row is long enough.
     * Reading short here would only pull in zeroes and fail the CRC, but the bound is checked explicitly rather
     * than relied upon.
     */
    if (startPos + (7 + len + 2) * 8 > rowBits) return DECODE_ABORT_LENGTH;

    // The length byte counts neither itself nor the two CRC bytes, but the CRC covers it.
    const frame = new Uint8Array(len + 3);
    frame[0] = len;
    frame.set(bits.bytes(0, startPos + 7 * 8, (len + 2) * 8).subarray(0, len + 2), 1);

    const crc = crc16(frame, len + 1, 0x8005, 0xffff);
    if (((frame[len + 1] << 8) | frame[len + 2]) !== crc) return DECODE_FAIL_MIC;

    const b = frame;
    const type = b[1];
    if (type !== 1) return DECODE_ABORT_EARLY;       // validated, but its layout is not known

    const year = b[10] >> 2;
    const month = (b[9] >> 6) | ((b[10] & 3) << 2);
    const day = (b[9] & 0x3e) >> 1;
    const hour = (b[8] >> 4) | ((b[9] & 1) << 4);
    const minute = ((b[8] & 0x0f) << 2) | ((b[7] & 0xc0) >> 6);
    const second = b[7] & 0x3f;

    ctx.emit({
      model: 'Flowis',
      type: 'Meter',
      id: (((b[5] << 24) >>> 0) | (b[4] << 16) | (b[3] << 8) | b[2]) >>> 0,
      msg_type: type,
      volume_m3: round3(((b[13] << 16) | (b[12] << 8) | b[11]) / 1000),
      device_time: `${year + 2000}-${dec2(month)}-${dec2(day)}T${dec2(hour)}:${dec2(minute)}:${dec2(second)}`,
      alarm: b[15],
      backflow: b[14],
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Celsia CZC1 thermostat (243)
// ---------------------------------------------------------------------------

/**
 * A PID thermostat that spends four transmitted bits on every two bits of data.
 *
 * After a long run-in, each byte on the wire is one of four symbols standing for a pair of bits, and a byte of
 * 0xf0 ends the message. Anything that is not one of the five is skipped rather than treated as an error, which
 * is upstream's behavior and is kept.
 *
 * The check is a CRC-8 run over eight bytes and required to come out zero. A command packet is five bytes and a
 * pairing packet four, so the run always reaches past the end of the real data into zeroes — which is harmless,
 * because once the register reaches zero, feeding it zero bytes leaves it there. The test asserts that rather
 * than assuming it.
 */
export const celsiaCzc1: RDevice = register({
  num: 243,
  name: 'Celsia CZC1 Thermostat',
  what: 'room thermostat',
  modulation: Modulation.OOK_PCM,
  shortWidth: 1220,
  longWidth: 1220,
  // Wide enough to split the start pulse from the first frame, but inside the gap between transmissions.
  resetLimit: 4880,
  tolerance: 20,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows > 1 || bits.bitsPerRow[0] < 144) return DECODE_ABORT_EARLY;

    const preamble = new Uint8Array([0xcc, 0xcc, 0xcc, 0xcc, 0x55, 0x55, 0x55, 0x55]);
    const preambleEnd = bits.search(0, 0, preamble, 64) + 64;
    const firstByte = preambleEnd >> 3;

    if (preambleEnd >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    if (preambleEnd + 132 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH;

    // Turn the four-bit symbols back into pairs of data bits, in a buffer of our own.
    const row = bits.bb[0];
    const nBytes = bits.bitsPerRow[0] >> 3;
    const decoded = new BitBuffer();
    for (let ipos = firstByte; ipos < nBytes; ipos++) {
      const sym = row[ipos];
      if (sym === 0xf0) break;                       // end of message
      if (sym === 0x55) { decoded.addBit(0); decoded.addBit(0); }
      else if (sym === 0x5a) { decoded.addBit(0); decoded.addBit(1); }
      else if (sym === 0xa5) { decoded.addBit(1); decoded.addBit(0); }
      else if (sym === 0xaa) { decoded.addBit(1); decoded.addBit(1); }
      // anything else is skipped, exactly as upstream does
    }

    const b = decoded.bb[0];
    if (crc8(b, 8, 0x31, 0xd7) !== 0) return DECODE_FAIL_MIC;

    // A pairing packet is marked 0x00 and a command packet 0xf0; nothing else is a known message.
    if (b[2] !== 0x00 && b[2] !== 0xf0) return DECODE_FAIL_OTHER;

    const isCommand = b[2] === 0xf0;
    const out: R433Data = {
      model: 'Celsia-CZC1',
      type: 'Thermostat',
      id: (b[0] << 8) | b[1],
      mic: 'CRC',
    };
    // Only a command packet carries a heating level; in a pairing packet that byte is the check itself.
    if (isCommand) out.heat = reverse8(b[3]);
    ctx.emit(out);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Mueller Hot Rod water meter (255)
// ---------------------------------------------------------------------------

/**
 * A water meter transmitter whose run-in the demodulator does not handle cleanly.
 *
 * Upstream's own note says the preamble is unstable because of the GFSK keying, and its five published captures
 * bear that out: the same transmission appears with the run-in rendered as ones, as 0x55s, as 0xaa s and as
 * zeroes. Four of the five still carry an intact `feb100` sync word and decode; in the fifth the sync itself has
 * been eaten and upstream cannot decode it either. That fifth capture is kept as a test case for the rejection.
 *
 * The volume is seven BCD nibbles of US gallons, and the nibble after them is a flag whose meaning upstream
 * marks as unconfirmed — so it is reported as a raw value under its own name and nothing is claimed about it.
 */
export const muellerHotrod: RDevice = register({
  num: 255,
  name: 'Mueller Hot Rod water meter',
  what: 'water meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 26,
  longWidth: 26,
  resetLimit: 2500,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    // Three bytes of sync word and nine of data.
    if (bits.bitsPerRow[0] < 96) return DECODE_ABORT_LENGTH;

    const preamble = new Uint8Array([0xfe, 0xb1, 0x00]);
    const pos = bits.search(0, 0, preamble, 24);
    if (pos + 9 * 8 >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const b = bits.bytes(0, pos + 24, 72);

    // CRC-8/UTI: poly 0x07, init 0x00, with the result exclusive-ored by 0x55.
    if ((crc8(b, 8, 0x07, 0x00) ^ 0x55) !== b[8]) {
      // Upstream returns a plain zero here; this reports the failure as what it is, so the app can tell a
      // damaged transmission from traffic that was never ours.
      return DECODE_FAIL_MIC;
    }

    const volume = ((b[4] & 0xf0) >> 4) * 1000000 + (b[4] & 0x0f) * 100000
      + ((b[5] & 0xf0) >> 4) * 10000 + (b[5] & 0x0f) * 1000
      + ((b[6] & 0xf0) >> 4) * 100 + (b[6] & 0x0f) * 10
      + ((b[7] & 0xf0) >> 4);

    ctx.emit({
      model: 'Mueller-HotRod',
      type: 'Meter',
      id: hex2(b[0]) + hex2(b[1]) + hex2(b[2]) + hex2(b[3]),
      volume_gal: volume,
      flag: b[7] & 0x0f,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Oregon Scientific WMR500 weather station (363)
// ---------------------------------------------------------------------------

/**
 * The WMR500 shares nothing with the other Oregon Scientific protocols in this codebase beyond the brand.
 *
 * Upstream describes it as inverted and turns the whole buffer over before searching for `552c6e2c6e`. That is
 * an accurate description but an awkward implementation, because inverting the shared buffer changes what every
 * decoder after this one sees. Inversion is its own inverse and both the search and the extraction are bitwise,
 * so searching for the complement of that pattern and complementing the bytes that come back gives an identical
 * result while leaving the buffer alone. The complement turns out to be `aad391d391` — the same CC110x sync
 * word the pool remote and the Flowis meter use, which is a better description of what is on the air.
 *
 * Two message kinds share a header. The short one is verified and then deliberately dropped: its payload is
 * believed to be wind but nobody has confirmed it, and upstream reports nothing rather than guess.
 *
 * Humidity is exact — it was fitted to two real reference readings and hits both. Temperature is not. Upstream
 * says so plainly: two points is the bare minimum to fit the two parameters it uses, leaving nothing to check
 * the fit against, and 0.7 degrees per count is not a clean constant. The estimate is reported because upstream
 * reports it, and the byte it came from is reported beside it so the doubt stays visible.
 */
export const oregonWmr500: RDevice = register({
  num: 363,
  name: 'Oregon Scientific WMR500 weather station',
  what: 'weather station',
  modulation: Modulation.FSK_PCM,
  shortWidth: 26,
  longWidth: 26,
  resetLimit: 312,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    const rowLen = bits.bitsPerRow[0];

    // The complement of upstream's 0x552c6e2c6e, so the shared buffer is never turned over.
    const preamble = new Uint8Array([0xaa, 0xd3, 0x91, 0xd3, 0x91]);
    let pos = bits.search(0, 0, preamble, 40);
    if (pos >= rowLen) return DECODE_ABORT_EARLY;
    pos += 40;
    if (pos + 8 > rowLen) return DECODE_ABORT_LENGTH;

    let availBytes = ((rowLen - pos) / 8) | 0;
    if (availBytes > 28) availBytes = 28;

    const b = bits.bytes(0, pos, availBytes * 8);
    for (let i = 0; i < b.length; i++) b[i] ^= 0xff;  // back into the domain upstream describes

    const len = b[0];
    let totalBytes: number;
    let crcInit: number;
    if (len === 14) {
      totalBytes = 17;
      crcInit = 0x4ed0;
    } else if (len === 25) {
      totalBytes = 28;
      crcInit = 0x1a4c;
    } else {
      return DECODE_ABORT_EARLY;
    }
    if (availBytes < totalBytes) return DECODE_ABORT_LENGTH;

    const crcCalc = crc16(b, totalBytes - 2, 0x8005, crcInit);
    if (crcCalc !== ((b[totalBytes - 2] << 8) | b[totalBytes - 1])) return DECODE_FAIL_MIC;

    // The short message passes its own check and is still not reported: its payload is not understood.
    if (len === 14) return DECODE_ABORT_EARLY;

    const humidity = 208 - b[16];
    if (humidity < 0 || humidity > 100) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Oregon-WMR500',
      type: 'Weather',
      id: (b[8] << 8) | b[9],
      // Fitted to two reference points and no more; upstream calls it a rough estimate and so does this.
      temperature_C: round1((b[14] - 169) * 0.7),
      temperature_raw: b[14],
      humidity,
      mic: 'CRC',
    });
    return 1;
  },
});
