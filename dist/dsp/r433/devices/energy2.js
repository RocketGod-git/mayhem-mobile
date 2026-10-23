import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addNibbles, crc16, crc16lsb, reflectBytes, xorBytes } from '../util.js';
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;
const hexLow = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
function sumBytesFull(m, n, at = 0) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += m[at + i];
    return s;
}
function decryptEsa(b, blen) {
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
const ESA_MAGIC_ELV = 0xf00f;
const ESA_MAGIC_GIRA = 0xee11;
export const esaEnergy = register({
    num: 117,
    name: 'ESA1000 / ESA2000 Energy Monitor, GIRA Wetterstation',
    what: 'optical head on a domestic electricity meter',
    modulation: 3,
    shortWidth: 260,
    longWidth: 0,
    resetLimit: 3000,
    bands: [433920000],
    disabled: true,
    decode(_dev, bits, ctx) {
        const len = bits.bitsPerRow[0];
        if (!(len === 176 || len === 160) || bits.numRows !== 1)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, 16, len - 16);
        const crc = decryptEsa(b, len / 8 - 2);
        if (crc !== ESA_MAGIC_ELV && crc !== ESA_MAGIC_GIRA)
            return DECODE_FAIL_MIC;
        const isGira = crc === ESA_MAGIC_GIRA;
        const impulseConstant = isGira
            ? ((b[16] << 8) | (b[17] ^ b[1]))
            : (((b[14] << 8) | b[15]) ^ b[1]);
        if (impulseConstant === 0)
            return DECODE_FAIL_SANITY;
        const impulses = isGira ? ((b[11] << 8) | b[12]) : ((b[9] << 8) | b[10]);
        const impulsesTotal = isGira
            ? ((b[8] << 16) | (b[9] << 8) | b[10])
            : ((((b[5] << 24) | (b[6] << 16) | (b[7] << 8) | b[8]) >>> 0));
        const data = {
            model: isGira ? 'Gira-EHZ' : (b[3] === 0x01 ? 'ESAx000WZ' : b[3] === 0x03 ? 'ESA1000Z' : 'ESA-unknown'),
            id: (b[1] << 8) | b[2],
            impulses,
            impulses_total: impulsesTotal,
            impulse_constant: impulseConstant,
            total_kWh: round3(impulsesTotal / impulseConstant),
            impulse_kWh: round3(impulses / impulseConstant),
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
const SPARSNAS_PULSES_PER_KWH = 1000;
const SPARSNAS_ID_KEY_SUB = 0x5d38e8cb;
const SPARSNAS_BITLEN = 160;
function sparsnasBruteForce(buf) {
    const b5 = buf[5], b6 = buf[6], b7 = buf[7], b8 = buf[8];
    const batteryEnc = buf[17];
    const d3 = b8 ^ 0x47;
    for (let k0 = 0; k0 < 0xff; k0++) {
        const d0 = b5 ^ k0;
        if (d0 > 0x0f)
            continue;
        for (let k1 = 0; k1 < 0xff; k1++) {
            const d1 = b6 ^ k1;
            for (let k2 = 0; k2 < 0xff; k2++) {
                const d2 = b7 ^ k2;
                const batteryDec = batteryEnc ^ k2;
                const decSensorId = (((d0 << 24) | (d1 << 16) | (d2 << 8) | d3) >>> 0);
                if (decSensorId > 999999)
                    continue;
                for (let k4 = 0; k4 < 0xff; k4++) {
                    const keySensorId = (((((k0 << 24) | (k4 << 16) | (k2 << 8) | k1) >>> 0) + SPARSNAS_ID_KEY_SUB) >>> 0);
                    if (decSensorId === keySensorId && batteryDec <= 100)
                        return decSensorId;
                }
            }
        }
    }
    return 0;
}
const sparsnas = { sensorId: 0 };
export function resetSparsnasSensorId() {
    sparsnas.sensorId = 0;
}
export const ikeaSparsnas = register({
    num: 130,
    name: 'IKEA Sparsnas Energy Meter Monitor',
    what: 'optical head on a domestic electricity meter',
    modulation: 16,
    shortWidth: 27,
    longWidth: 27,
    gapLimit: 1000,
    resetLimit: 3000,
    bands: [868000000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < SPARSNAS_BITLEN || n > 260)
            return DECODE_ABORT_LENGTH;
        const bitpos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0xd2, 0x01]), 32);
        if (bitpos === n || bitpos + 32 + SPARSNAS_BITLEN > n)
            return DECODE_ABORT_EARLY;
        const buffer = bits.bytes(0, bitpos + 32, SPARSNAS_BITLEN);
        if (crc16(buffer, 18, 0x8005, 0xffff) !== ((buffer[18] << 8) | buffer[19]))
            return DECODE_FAIL_MIC;
        if (!sparsnas.sensorId)
            sparsnas.sensorId = sparsnasBruteForce(buffer);
        const sub = (sparsnas.sensorId - SPARSNAS_ID_KEY_SUB) >>> 0;
        const key = [(sub >>> 24) & 0xff, sub & 0xff, (sub >>> 8) & 0xff, 0x47, (sub >>> 16) & 0xff];
        const decrypted = new Uint8Array(18);
        for (let i = 0; i < 5; i++)
            decrypted[i] = buffer[i];
        for (let i = 0; i < 13; i++)
            decrypted[5 + i] = buffer[5 + i] ^ key[i % 5];
        const rcvSensorId = (((decrypted[5] << 24) | (decrypted[6] << 16) | (decrypted[7] << 8) | decrypted[8]) >>> 0);
        if (!sparsnas.sensorId || rcvSensorId !== sparsnas.sensorId) {
            ctx.emit({ model: 'Ikea-Sparsnas', id: sparsnas.sensorId, mic: 'CRC' });
            return 1;
        }
        if (decrypted[0] !== 0x11)
            return DECODE_FAIL_SANITY;
        if (decrypted[3] !== 0x07)
            return DECODE_FAIL_SANITY;
        const pulses = (((decrypted[13] << 24) | (decrypted[14] << 16) | (decrypted[15] << 8) | decrypted[16]) >>> 0);
        ctx.emit({
            model: 'Ikea-Sparsnas',
            id: rcvSensorId,
            sequence: (decrypted[9] << 8) | decrypted[10],
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
export const esicEmt7110 = register({
    num: 136,
    name: 'ESIC EMT7110 power meter',
    what: 'plug-in socket power meter',
    modulation: 16,
    shortWidth: 104,
    longWidth: 104,
    resetLimit: 10000,
    bands: [868280000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const n = bits.bitsPerRow[0];
        if (n < 120 || n > 140)
            return DECODE_ABORT_LENGTH;
        let offset = bits.search(0, 0, new Uint8Array([0xaa, 0x2d, 0xd4]), 24);
        offset += 24;
        if (offset + 96 > n)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, offset, 96);
        if ((sumBytesFull(b, 12) & 0xff) !== 0)
            return DECODE_FAIL_MIC;
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
const NORGO_TAPS = [
    0x4880, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x2080, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000,
];
function norgoNextMask(mask) {
    let nMask = mask >> 1;
    for (let i = 0; i < 15; i++)
        if (mask & (1 << i))
            nMask ^= NORGO_TAPS[i];
    return nMask & 0xffff;
}
function norgoChecksum(data, datalen) {
    let mask = 0x0001;
    let chks = 0;
    for (let i = datalen - 1; i > 7; i--) {
        mask = norgoNextMask(mask);
        if ((data[(i / 8) | 0] >> (i % 8)) & 1)
            chks ^= mask;
    }
    return (chks >> 8) & 0xff;
}
export const norgo = register({
    num: 139,
    name: 'Norgo NGE101',
    what: 'optical head on a domestic electricity meter',
    modulation: 9,
    shortWidth: 486,
    longWidth: 972,
    resetLimit: 2100,
    syncWidth: 0,
    tolerance: 120,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const n = bits.bitsPerRow[0];
        if (n !== 56 && n !== 72 && n !== 55 && n !== 71)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if (b[0] !== (~0xfa & 0xff))
            return DECODE_ABORT_EARLY;
        if (xorBytes(b, ((n - 15) / 8) | 0, 1) !== 0xff)
            return DECODE_FAIL_MIC;
        bits.invert();
        reflectBytes(b, ((n + 1) / 8) | 0);
        const deviceId = ((b[1] & 0xf0) >> 4) | ((b[2] & 0x0f) << 4);
        const channel = ((b[1] & 0x0e) >> 1) + 1;
        if ((b[1] & 0x01) === 0) {
            if (norgoChecksum(b, 5 * 8) !== b[6])
                return DECODE_FAIL_MIC;
            ctx.emit({
                model: 'Norgo-NGE101',
                id: deviceId,
                channel,
                gap: (b[2] >> 4) | (b[3] << 4) | ((b[4] & 0x7f) << 12),
                mic: 'CRC',
            });
            return 1;
        }
        if (norgoChecksum(b, 7 * 8) !== b[8])
            return DECODE_FAIL_MIC;
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
export const marlecSolar = register({
    num: 188,
    name: 'Marlec Solar iBoost+ sensors',
    what: 'solar immersion diverter',
    modulation: 16,
    shortWidth: 20,
    longWidth: 20,
    resetLimit: 300,
    priority: 10,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const n = bits.bitsPerRow[0];
        const preamble = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);
        const start = bits.search(0, 0, preamble, 48);
        if (start === n)
            return DECODE_ABORT_EARLY;
        if (n < 12 * 8)
            return DECODE_ABORT_LENGTH;
        const lenByte = bits.bytes(0, start + 48, 8)[0];
        if (lenByte > 105)
            return DECODE_ABORT_LENGTH;
        if (start + 56 + (lenByte + 2) * 8 > n)
            return DECODE_ABORT_LENGTH;
        const frame = new Uint8Array(108);
        frame[0] = lenByte;
        frame.set(bits.bytes(0, start + 56, (lenByte + 2) * 8), 1);
        const want = crc16(frame, lenByte + 1, 0x8005, 0xffff);
        if (((frame[lenByte + 1] << 8) | frame[lenByte + 2]) !== want)
            return DECODE_FAIL_MIC;
        let raw = '';
        for (let i = 0; i < lenByte; i++)
            raw += hexLow(frame[i + 1], 2);
        const data = { model: 'Marlec-Solar', raw, mic: 'CRC' };
        if (frame[3] === 0x22) {
            data['boost_time'] = frame[6];
            data['solar_off'] = frame[7];
            data['tank_hot'] = frame[8];
            data['battery_low'] = frame[13];
            data['heating'] = ((frame[17] | (frame[18] << 8)) << 16) >> 16;
            data['import_val'] = (frame[19] | (frame[20] << 8) | (frame[21] << 16) | (frame[22] << 24)) | 0;
            const savedVal = (frame[26] | (frame[27] << 8) | (frame[28] << 16) | (frame[29] << 24)) | 0;
            const period = {
                0xca: 'saved_today', 0xcb: 'saved_yesterday', 0xcc: 'saved_last_7',
                0xcd: 'saved_last_28', 0xce: 'saved_total',
            }[frame[25]];
            if (period)
                data[period] = savedVal;
        }
        ctx.emit(data);
        return 1;
    },
});
export const revoltNc5462 = register({
    num: 239,
    name: 'Revolt NC-5642 Energy Meter',
    what: 'plug-in socket power meter',
    modulation: 6,
    shortWidth: 200,
    longWidth: 320,
    syncWidth: 10024,
    resetLimit: 272,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        bits.invert();
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 104)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[0];
        const sum = sumBytesFull(b, 11);
        if (sum === 0)
            return DECODE_FAIL_SANITY;
        if ((sum & 0xff) !== b[11])
            return DECODE_FAIL_MIC;
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
const ZX7717_POWER = 13;
const ZX7717_ENERGY = 14;
const ZX7717_POWER_COLD = 17;
const ZX7717_ENERGY_COLD = 18;
export const revoltZx7717 = register({
    num: 274,
    name: 'Revolt ZX-7717 power meter',
    what: 'plug-in socket power meter',
    modulation: 3,
    shortWidth: 310,
    longWidth: 310,
    resetLimit: 900,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowLen = bits.bitsPerRow[0];
        if (rowLen < 15 * 8 || rowLen > 22 * 8)
            return DECODE_ABORT_EARLY;
        let pos = bits.search(0, 0, new Uint8Array([0x2a]), 8);
        pos += 8;
        if (pos > 16)
            return DECODE_ABORT_LENGTH;
        const len = rowLen - pos;
        const b = bits.bytes(0, pos, len);
        reflectBytes(b, (len + 7) >> 3);
        const msgLen = b[0];
        if (msgLen < 1)
            return DECODE_FAIL_SANITY;
        if (len < (msgLen + 1) * 8)
            return DECODE_ABORT_LENGTH;
        if ((sumBytesFull(b, msgLen) & 0xff) !== b[msgLen])
            return DECODE_FAIL_MIC;
        const data = {
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
        }
        else if (msgLen === ZX7717_ENERGY || msgLen === ZX7717_ENERGY_COLD) {
            const at = msgLen === ZX7717_ENERGY ? 6 : 10;
            data['energy_kWh'] = round2(((b[at + 2] << 16) | (b[at + 1] << 8) | b[at]) * 0.01);
        }
        else {
            return DECODE_FAIL_OTHER;
        }
        ctx.emit(data);
        return 1;
    },
});
const EC3K_PACKET_BYTES = 41;
const ec3kBitAt = (m, bit) => (m[bit >> 3] >> (7 - (bit & 7))) & 1;
function ec3kSymbolAt(m, bit) {
    const bit0 = bit > 0 ? ec3kBitAt(m, bit - 1) : 0;
    return bit0 === ec3kBitAt(m, bit) ? 1 : 0;
}
function ec3kDescrambledAt(m, bit) {
    let out = ec3kSymbolAt(m, bit);
    if (bit > 17)
        out ^= ec3kSymbolAt(m, bit - 17);
    if (bit > 12)
        out ^= ec3kSymbolAt(m, bit - 12);
    return out;
}
function ec3kNibbles(buf, start, count) {
    let v = 0;
    for (let i = 0; i < count; i++) {
        v = v * 16 + ((buf[(start + i) >> 1] >> ((1 - ((start + i) & 1)) * 4)) & 0x0f);
    }
    return v;
}
function ec3kExtract(p, ctx) {
    const pad1 = ec3kNibbles(p, 9, 4);
    const pad2 = ec3kNibbles(p, 17, 7);
    const pad3 = ec3kNibbles(p, 62, 5);
    const pad4 = ec3kNibbles(p, 77, 1);
    if (pad1 !== 0 || pad2 !== 0 || pad3 !== 0 || pad4 !== 0)
        return DECODE_FAIL_SANITY;
    const receivedCrc = 0xffff ^ (ec3kNibbles(p, 78, 2) | (ec3kNibbles(p, 80, 2) << 8));
    if (crc16lsb(p, EC3K_PACKET_BYTES - 2, 0x8408, 0xffff) !== receivedCrc)
        return DECODE_FAIL_MIC;
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
export const ec3k = register({
    num: 289,
    name: 'Voltcraft EnergyCount 3000 (ec3k)',
    what: 'plug-in socket power meter',
    modulation: 16,
    shortWidth: 50,
    longWidth: 50,
    tolerance: 5,
    gapLimit: 3000,
    resetLimit: 5000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 90)
            return DECODE_ABORT_LENGTH;
        const row = bits.bb[0];
        const n = bits.bitsPerRow[0];
        const packet = new Uint8Array(EC3K_PACKET_BYTES);
        let rc = DECODE_ABORT_EARLY;
        let packetpos = 0, inPacket = false, onecount = 0, recbyte = 0, recpos = 0;
        const resync = () => { packetpos = 0; inPacket = false; onecount = 0; recbyte = 0; recpos = 0; };
        for (let at = 17; rc !== 1 && at < n; at++) {
            if (ec3kDescrambledAt(row, at)) {
                if (onecount < 6 && packetpos < EC3K_PACKET_BYTES) {
                    onecount++;
                    recbyte = (recbyte >> 1) | 0x80;
                    if (++recpos === 8 && inPacket) {
                        recpos = 0;
                        packet[packetpos++] = recbyte;
                    }
                }
                else {
                    resync();
                }
            }
            else {
                if (onecount < 5 && packetpos < EC3K_PACKET_BYTES) {
                    recbyte = recbyte >> 1;
                    if (++recpos === 8 && inPacket) {
                        recpos = 0;
                        packet[packetpos++] = recbyte;
                    }
                }
                else if (onecount === 5) {
                }
                else if (onecount === 6) {
                    inPacket = !inPacket;
                    packetpos = 0;
                    recpos = 0;
                }
                else {
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
export const rfxmeter = register({
    num: 334,
    name: 'RfxMeter, RFXPwr',
    what: 'pulse counter for electricity, gas or water',
    modulation: 5,
    shortWidth: 500,
    longWidth: 1500,
    gapLimit: 2500,
    resetLimit: 5000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 && bits.numRows !== 2)
            return DECODE_ABORT_LENGTH;
        const row = bits.numRows - 1;
        if (bits.bitsPerRow[row] !== 48)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if ((b[0] ^ 0xf0) !== b[1])
            return DECODE_FAIL_SANITY;
        if ((addNibbles(b, 6) & 0x0f) !== 0x0f)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'RfxMeter',
            id: b[0],
            msg_type: b[5] >> 4,
            msg_value: ((b[4] << 16) | (b[2] << 8) | b[3]) >>> 0,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const ecoeye = register({
    num: 351,
    name: 'Eco-Eye solar PV/grid current monitor',
    what: 'solar and grid current monitor',
    modulation: 16,
    shortWidth: 200,
    longWidth: 200,
    resetLimit: 8100,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const n = bits.bitsPerRow[0];
        let start = bits.search(0, 0, new Uint8Array([0xaa, 0x2d, 0xd4]), 24);
        start += 24;
        if (start >= n)
            return DECODE_ABORT_EARLY;
        if (start + 40 > n)
            return DECODE_ABORT_LENGTH;
        const msg = bits.bytes(0, start, 40);
        if ((sumBytesFull(msg, 4) & 0xff) !== msg[4])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'EcoEye',
            current_used_A: round2(((msg[2] << 8) | msg[3]) * 0.01),
            current_pv_A: round2(((msg[0] << 8) | msg[1]) * 0.01),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
