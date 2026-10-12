/**
 * Tire pressure monitors.
 *
 * Every car sold in the US since 2007 has four of these bolted inside the wheels, each waking every minute or so
 * to report its pressure, its temperature and a serial number that never changes. They are the busiest thing in
 * the band: park near a road and they arrive continuously.
 *
 * They are almost all built the same way — frequency shift keying, a run of alternating bits as a preamble, then
 * Manchester-coded bytes ending in a checksum — so the work here is per-manufacturer field layout rather than
 * per-manufacturer signal processing. US cars mostly transmit on 315 MHz, European ones on 433.92.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `src/devices/tpms_toyota.c`, `tpms_ford.c`, `tpms_citroen.c`,
 * `tpms_renault.c`, `tpms_abarth124.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import { Modulation, register, type DecodeCtx, type RDevice } from '../device.js';
import { crc8, crc16, xorBytes } from '../util.js';

/** Both polarities of the usual preamble: alternating bits closed by a marker that breaks the run. */
const PRE_AA_A9 = new Uint8Array([0xaa, 0xa9]);
const PRE_AA_AA_A9 = new Uint8Array([0xaa, 0xaa, 0xa9]);
const PRE_A9_E0 = new Uint8Array([0xa9, 0xe0]);

const hex = (v: number, digits: number) => (v >>> 0).toString(16).padStart(digits, '0');

/**
 * Toyota, and the Pacific Industrial sensors fitted to several other makes.
 *
 * Nine bytes in differential Manchester: four of serial number, then pressure, temperature and a second copy of
 * the pressure inverted, which is checked against the first before anything is reported.
 */
export const tpmsToyota: RDevice = register({
  num: 88,
  name: 'Toyota TPMS',
  what: 'tire pressure sensor, also fitted to some Lexus, Subaru and Mazda',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: [315000000, 433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    let bitpos = 0;
    while ((bitpos = bits.search(0, bitpos, PRE_A9_E0, 12)) + 156 <= bits.bitsPerRow[0]) {
      const start = bitpos + 11;                     // the last preamble bit belongs to the data
      const packet = new BitBuffer();
      const end = bits.differentialManchesterDecode(0, start, packet, 80);
      if (end - start >= 144) {
        const b = packet.bb[0];
        if (crc8(b, 8, 0x07, 0x80) === b[8]) {
          const pressure1 = ((b[4] & 0x7f) << 1) | (b[5] >> 7);
          const pressure2 = b[7] ^ 0xff;
          if (pressure1 === pressure2) {             // the sensor sends pressure twice; both must agree
            ctx.emit({
              model: 'Toyota',
              type: 'TPMS',
              id: hex((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3], 8),
              status: (b[4] & 0x80) | (b[6] & 0x7f),
              pressure_PSI: Math.round((pressure1 * 0.25 - 7) * 100) / 100,
              temperature_C: (((b[5] & 0x7f) << 1) | (b[6] >> 7)) - 40,
              mic: 'CRC',
            });
            events++;
          }
        }
      }
      bitpos += 2;
    }
    return events;
  },
});

/**
 * Ford, and the Continental sensors behind them. Eight bytes with a plain byte-sum check.
 *
 * The temperature byte doubles as something else when its top bit is set, so a reading is only reported when
 * that bit is clear. The flag byte says whether the car is moving or sitting, and whether the sensor is being
 * taught to a new vehicle.
 */
export const tpmsFord: RDevice = register({
  num: 89,
  name: 'Ford TPMS',
  what: 'tire pressure sensor: Fiesta, Focus, Kuga, Escape, Transit',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: [315000000, 433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    let events = 0;
    for (let row = 0; row < bits.numRows; row++) {
      let bitpos = 0;
      while ((bitpos = bits.search(row, bitpos, PRE_AA_A9, 16)) + 144 <= bits.bitsPerRow[row]) {
        const packet = new BitBuffer();
        bits.manchesterDecode(row, bitpos + 16, packet, 160);
        if (packet.bitsPerRow[0] >= 64) {
          const b = packet.bb[0];
          if (((b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6]) & 0xff) === b[7]) {
            // Bits we have never seen set. If any are, this is not a frame we understand.
            let unknown = 0;
            let learn = 0, moving = 0;
            switch (b[6] & 0x4c) {
              case 0x08: learn = 1; break;
              case 0x04: break;
              case 0x44: moving = 1; break;
              default: unknown = b[6] & 0x4c; break;
            }
            unknown |= b[6] & 0x90;
            if (unknown === 0) {
              const out: Record<string, unknown> = {
                model: 'Ford',
                type: 'TPMS',
                id: hex((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3], 8),
                pressure_PSI: Math.round((((b[6] & 0x20) << 3) | b[4]) * 0.25 * 100) / 100,
                moving, learn,
                code: hex((b[4] << 16) | (b[5] << 8) | b[6], 6),
                mic: 'CHECKSUM',
              };
              // The top bit of the temperature byte marks it as carrying something else entirely.
              if ((b[5] & 0x80) === 0) out.temperature_C = (b[5] & 0x7f) - 56;
              ctx.emit(out as { model: string });
              events++;
            }
          }
        }
        bitpos += 15;
      }
    }
    return events;
  },
});

/**
 * Citroen, Peugeot and the VDO sensors they share with Fiat and Mitsubishi. Ten bytes, checked by exclusive-or.
 * The first byte carries some state that is deliberately left out of the checksum.
 */
export const tpmsCitroen: RDevice = register({
  num: 82,
  name: 'Citroen TPMS',
  what: 'tire pressure sensor: Citroen, Peugeot, some Fiat and Mitsubishi',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    let events = 0;
    let bitpos = 0;
    while ((bitpos = bits.search(0, bitpos, PRE_AA_A9, 16)) + 178 <= bits.bitsPerRow[0]) {
      const packet = new BitBuffer();
      bits.manchesterDecode(0, bitpos + 16, packet, 88);
      if (packet.bitsPerRow[0] >= 80) {
        const b = packet.bb[0];
        // Pressure and temperature of exactly zero mean the frame is not real.
        if (b[6] !== 0 && b[7] !== 0) {
          const crc = b[1] ^ b[2] ^ b[3] ^ b[4] ^ b[5] ^ b[6] ^ b[7] ^ b[8] ^ b[9];
          if (crc === 0) {
            ctx.emit({
              model: 'Citroen',
              type: 'TPMS',
              id: hex((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4], 8),
              state: hex(b[0], 2),
              flags: b[5] >> 4,
              repeat: b[5] & 0x0f,
              pressure_kPa: Math.round(b[6] * 1.364),
              temperature_C: b[7] - 50,
              maybe_battery: b[8],
              mic: 'CHECKSUM',
            });
            events++;
          }
        }
      }
      bitpos += 2;
    }
    return events;
  },
});

/**
 * Renault, Dacia and Nissan-Renault shared platforms. Nine bytes with a CRC, and — unusually — the serial
 * number stored least significant byte first.
 */
export const tpmsRenault: RDevice = register({
  num: 90,
  name: 'Renault TPMS',
  what: 'tire pressure sensor: Clio, Captur, Zoe, Dacia Sandero',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    let events = 0;
    for (let row = 0; row < bits.numRows; row++) {
      let bitpos = 0;
      while ((bitpos = bits.search(row, bitpos, PRE_AA_A9, 16)) + 160 <= bits.bitsPerRow[row]) {
        const packet = new BitBuffer();
        bits.manchesterDecode(row, bitpos + 16, packet, 160);
        if (packet.bitsPerRow[0] >= 72) {
          const b = packet.bb[0];
          if (crc8(b, 8, 0x07, 0x00) === b[8]) {
            ctx.emit({
              model: 'Renault',
              type: 'TPMS',
              id: hex((b[5] << 16) | (b[4] << 8) | b[3], 6),
              flags: hex(b[0] >> 2, 2),
              pressure_kPa: Math.round((((b[0] & 0x03) << 8) | b[1]) * 0.75 * 10) / 10,
              temperature_C: b[2] - 30,
              mic: 'CRC',
            });
            events++;
          }
        }
        bitpos += 15;
      }
    }
    return events;
  },
});

/**
 * The VDO TG1C found in the Abarth and Fiat 124 Spider and several Mazdas, and the Shenzhen Q85 aftermarket
 * sensor which uses the same frame with three more bytes and a real CRC on the end. Which one it is comes from
 * the length of the burst.
 */
export const tpmsAbarth124: RDevice = register({
  num: 156,
  name: 'Abarth 124 Spider and Shenzhen EGQ Q85 TPMS',
  what: 'tire pressure sensor: VDO TG1C, and a common aftermarket sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 150,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    bits.invert();
    const n = bits.bitsPerRow[0];
    const q85 = n > 210 && n < 400;
    if (!q85 && !(n > 150 && n < 210)) return -1;    // DECODE_ABORT_LENGTH
    const dataLen = q85 ? 96 : 72;

    let events = 0;
    let bitpos = 0;
    while ((bitpos = bits.search(0, bitpos, PRE_AA_AA_A9, 24)) + 80 <= bits.bitsPerRow[0]) {
      const packet = new BitBuffer();
      bits.manchesterDecode(0, bitpos + 24, packet, dataLen);
      if (packet.bitsPerRow[0] >= dataLen) {
        const b = packet.bb[0];
        if (xorBytes(b, 9) === 0) {
          const tempC = q85 ? b[6] - 55 : b[6] - 50;
          const tempMin = q85 ? -20 : -50, tempMax = q85 ? 80 : 125;
          if (tempC >= tempMin && tempC <= tempMax) {
            // The aftermarket sensor adds a CRC over the whole thing, stored least significant byte first.
            const crcOk = !q85 || crc16(b, 10, 0x1021, 0xffff) === ((b[11] << 8) | b[10]);
            if (crcOk) {
              ctx.emit({
                model: q85 ? 'Shenzhen-EGQQ85' : 'Abarth-124Spider',
                type: 'TPMS',
                id: hex((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3], 8),
                flags: hex(b[4], 2),
                pressure_kPa: Math.round(q85 ? b[5] * 3 : b[5] * 1.38),
                temperature_C: tempC,
                status: b[7],
                mic: q85 ? 'CRC' : 'CHECKSUM',
              });
              events++;
            }
          }
        }
      }
      bitpos += 2;
    }
    return events;
  },
});
