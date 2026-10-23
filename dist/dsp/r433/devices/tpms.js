import { BitBuffer } from '../bitbuffer.js';
import { register } from '../device.js';
import { crc8, crc16, xorBytes } from '../util.js';
const PRE_AA_A9 = new Uint8Array([0xaa, 0xa9]);
const PRE_AA_AA_A9 = new Uint8Array([0xaa, 0xaa, 0xa9]);
const PRE_A9_E0 = new Uint8Array([0xa9, 0xe0]);
const hex = (v, digits) => (v >>> 0).toString(16).padStart(digits, '0');
export const tpmsToyota = register({
    num: 88,
    name: 'Toyota TPMS',
    what: 'tire pressure sensor, also fitted to some Lexus, Subaru and Mazda',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: [315000000, 433920000],
    decode(_dev, bits, ctx) {
        let events = 0;
        let bitpos = 0;
        while ((bitpos = bits.search(0, bitpos, PRE_A9_E0, 12)) + 156 <= bits.bitsPerRow[0]) {
            const start = bitpos + 11;
            const packet = new BitBuffer();
            const end = bits.differentialManchesterDecode(0, start, packet, 80);
            if (end - start >= 144) {
                const b = packet.bb[0];
                if (crc8(b, 8, 0x07, 0x80) === b[8]) {
                    const pressure1 = ((b[4] & 0x7f) << 1) | (b[5] >> 7);
                    const pressure2 = b[7] ^ 0xff;
                    if (pressure1 === pressure2) {
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
export const tpmsFord = register({
    num: 89,
    name: 'Ford TPMS',
    what: 'tire pressure sensor: Fiesta, Focus, Kuga, Escape, Transit',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: [315000000, 433920000],
    decode(_dev, bits, ctx) {
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
                        let unknown = 0;
                        let learn = 0, moving = 0;
                        switch (b[6] & 0x4c) {
                            case 0x08:
                                learn = 1;
                                break;
                            case 0x04: break;
                            case 0x44:
                                moving = 1;
                                break;
                            default:
                                unknown = b[6] & 0x4c;
                                break;
                        }
                        unknown |= b[6] & 0x90;
                        if (unknown === 0) {
                            const out = {
                                model: 'Ford',
                                type: 'TPMS',
                                id: hex((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3], 8),
                                pressure_PSI: Math.round((((b[6] & 0x20) << 3) | b[4]) * 0.25 * 100) / 100,
                                moving, learn,
                                code: hex((b[4] << 16) | (b[5] << 8) | b[6], 6),
                                mic: 'CHECKSUM',
                            };
                            if ((b[5] & 0x80) === 0)
                                out.temperature_C = (b[5] & 0x7f) - 56;
                            ctx.emit(out);
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
export const tpmsCitroen = register({
    num: 82,
    name: 'Citroen TPMS',
    what: 'tire pressure sensor: Citroen, Peugeot, some Fiat and Mitsubishi',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        bits.invert();
        let events = 0;
        let bitpos = 0;
        while ((bitpos = bits.search(0, bitpos, PRE_AA_A9, 16)) + 178 <= bits.bitsPerRow[0]) {
            const packet = new BitBuffer();
            bits.manchesterDecode(0, bitpos + 16, packet, 88);
            if (packet.bitsPerRow[0] >= 80) {
                const b = packet.bb[0];
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
export const tpmsRenault = register({
    num: 90,
    name: 'Renault TPMS',
    what: 'tire pressure sensor: Clio, Captur, Zoe, Dacia Sandero',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: [433920000],
    decode(_dev, bits, ctx) {
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
export const tpmsAbarth124 = register({
    num: 156,
    name: 'Abarth 124 Spider and Shenzhen EGQ Q85 TPMS',
    what: 'tire pressure sensor: VDO TG1C, and a common aftermarket sensor',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        bits.invert();
        const n = bits.bitsPerRow[0];
        const q85 = n > 210 && n < 400;
        if (!q85 && !(n > 150 && n < 210))
            return -1;
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
