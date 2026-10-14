import { BitBuffer, bitAt } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, crc16, crc16lsb, parity8, reflectBytes, reverse8 } from '../util.js';
const BAND_315 = [314973000];
const BAND_915 = [915000000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;
const hex2 = (v) => v.toString(16).padStart(2, '0');
const dec2 = (v) => v.toString().padStart(2, '0');
function bitrowGetByte(row, pos) {
    return (((row[pos >> 3] << 8) | row[(pos >> 3) + 1]) >> (8 - (pos & 7))) & 0xff;
}
const DANFOSS_6B4B = new Map([
    [0x0b, 0xd], [0x0d, 0xe], [0x0e, 0x3], [0x13, 0x4],
    [0x15, 0xa], [0x16, 0xf], [0x19, 0x9], [0x1a, 0x6],
    [0x25, 0x0], [0x26, 0x7], [0x29, 0x1], [0x2a, 0x5],
    [0x2c, 0xc], [0x31, 0xb], [0x32, 0x2], [0x34, 0x8],
]);
function danfossSwitch(v) {
    if (v === 2)
        return 'DAY';
    if (v === 4)
        return 'TIMER';
    if (v === 8)
        return 'NIGHT';
    return 'ERROR';
}
export const danfossCfr = register({
    num: 26,
    name: 'Danfoss CFR Thermostat',
    what: 'room thermostat',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 500,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < 246 || rowBits > 260)
            return DECODE_ABORT_LENGTH;
        const header = new Uint8Array([0x36, 0x5c]);
        const found = bits.search(0, 112, header, 16);
        if (rowBits - found < 126)
            return DECODE_ABORT_LENGTH;
        const bitOffset = found + 6;
        const row = bits.bb[0];
        const bytes = new Uint8Array(10);
        for (let n = 0; n < 10; n++) {
            const hi = DANFOSS_6B4B.get(bitrowGetByte(row, n * 12 + bitOffset) >> 2);
            const lo = DANFOSS_6B4B.get(bitrowGetByte(row, n * 12 + bitOffset + 6) >> 2);
            if (hi === undefined || lo === undefined)
                return DECODE_FAIL_SANITY;
            bytes[n] = (hi << 4) | lo;
        }
        if (bytes[0] !== 0x02)
            return DECODE_FAIL_MIC;
        if (crc16(bytes, 8, 0x1021, 0x0000) !== ((bytes[8] << 8) | bytes[9]))
            return DECODE_FAIL_MIC;
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
export const emontx = register({
    num: 45,
    name: 'emonTx OpenEnergyMonitor',
    what: 'household energy monitor',
    modulation: 16,
    shortWidth: 2000000 / (49230 + 49261),
    longWidth: 2000000 / (49230 + 49261),
    resetLimit: 1200,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        const preamble = new Uint8Array([0xaa, 0xaa, 0xaa]);
        const pktHdr = new Uint8Array([0x2d, 0xd2, 0x00]);
        const pktHdrInverted = new Uint8Array([0xd2, 0x2d, 0xc0]);
        const PKT_BYTES = 33;
        let events = 0;
        let bitpos = 0;
        while ((bitpos = bits.search(0, bitpos, preamble, 22)) < rowBits) {
            bitpos += 22;
            while (bits.search(0, bitpos, preamble, 2) === bitpos)
                bitpos += 2;
            bitpos--;
            let inverted = false;
            let pktPos = bits.search(0, bitpos, pktHdr, 11);
            if (pktPos > bitpos + 5) {
                pktPos = bits.search(0, bitpos, pktHdrInverted, 11);
                if (pktPos > bitpos + 5)
                    continue;
                inverted = true;
            }
            if (pktPos + PKT_BYTES * 8 > rowBits)
                break;
            const pkt = bits.bytes(0, pktPos, PKT_BYTES * 8);
            if (inverted)
                for (let i = 0; i < PKT_BYTES; i++)
                    pkt[i] ^= 0xff;
            if (pkt[3] !== 0x1a || pkt[32] !== 0xaa)
                continue;
            const crc = crc16lsb(pkt, 0x1d, 0xa001, 0xffff, 1);
            const words = [];
            for (let i = 0; i < 14; i++)
                words.push(pkt[4 + i * 2] | (pkt[5 + i * 2] << 8));
            if (crc !== words[13])
                continue;
            const signed = (w) => (w << 16) >> 16;
            const out = {
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
            for (let i = 0; i < 6; i++) {
                if (words[5 + i] !== 3000)
                    out[`temp${i + 1}_C`] = round1(words[5 + i] * 0.1);
            }
            ctx.emit(out);
            events++;
        }
        return events;
    },
});
function vaillantChecksumOk(b, from, to, csFrom, csTo) {
    const expected = (b[csFrom] << 8) | b[csTo];
    let calculated = 0;
    for (let i = from; i <= to; i++)
        calculated += b[i];
    return ((calculated + expected) & 0xffff) === 0;
}
export const vaillantVrt340f = register({
    num: 77,
    name: 'Vaillant calorMatic VRT340f Central Heating Control',
    what: 'central heating control',
    modulation: 9,
    shortWidth: 836,
    longWidth: 1648,
    resetLimit: 4000,
    tolerance: 120,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 128)
            return DECODE_ABORT_LENGTH;
        const src = bits.bb[0];
        const destuffed = new BitBuffer();
        let ones = 0;
        for (let k = 0; k < bits.bitsPerRow[0]; k++) {
            const bit = bitAt(src, k);
            if (bit === 1) {
                destuffed.addBit(1);
                ones++;
            }
            else {
                if (ones !== 5)
                    destuffed.addBit(0);
                ones = 0;
            }
        }
        const b = destuffed.bb[0];
        const bitcount = destuffed.bitsPerRow[0];
        reflectBytes(b, ((bitcount - 1) / 8) | 0);
        const isNormal = bitcount >= 128 && bitcount <= 131;
        const isDetect = bitcount >= 168 && bitcount <= 171;
        if (!isNormal && !isDetect)
            return DECODE_ABORT_LENGTH;
        const syncOk = b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x7e;
        if (syncOk && isNormal) {
            if (!vaillantChecksumOk(b, 3, 11, 12, 13))
                return DECODE_FAIL_MIC;
            const heatingMode = b[10] >> 7;
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
        if (syncOk && isDetect) {
            if (!vaillantChecksumOk(b, 3, 16, 17, 18))
                return DECODE_FAIL_MIC;
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
export const cmr113 = register({
    num: 193,
    name: 'Clipsal CMR113 Cent-a-meter power meter',
    what: 'three-phase current clamp',
    modulation: 11,
    shortWidth: 480,
    longWidth: 976,
    syncWidth: 2028,
    resetLimit: 2069,
    tolerance: 200,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < 350 || rowBits > 450)
            return DECODE_ABORT_LENGTH;
        const head = bits.bytes(0, 0, 32);
        if (head[0] !== 0xb0 || head[1] !== 0x00 || head[2] !== 0x00)
            return DECODE_ABORT_EARLY;
        const COMPARE_BITS = 83;
        const COMPARE_BYTES = (COMPARE_BITS + 7) >> 3;
        const out = new BitBuffer();
        let start = 0;
        let bit = 0;
        while (start + 3 < rowBits) {
            const chunk = bits.bytes(0, start, 3);
            if ((chunk[0] >> 6) === 0x00) {
                start += 2;
                out.addBit(bit);
            }
            else if ((chunk[0] >> 5) === 0x03) {
                start += 3;
                bit = 1 - bit;
                out.addBit(bit);
            }
            else if (start === 0) {
                start += 1;
            }
            else {
                return DECODE_ABORT_LENGTH;
            }
        }
        if (out.bitsPerRow[0] < 2 * COMPARE_BITS + 2)
            return DECODE_ABORT_LENGTH;
        const first = out.bytes(0, 0, COMPARE_BITS);
        const second = out.bytes(0, COMPARE_BITS + 2, COMPARE_BITS);
        for (let i = 0; i < COMPARE_BYTES; i++)
            if (first[i] !== second[i])
                return DECODE_FAIL_MIC;
        const current = [];
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
function proflame2Words(bits, row, start, out) {
    let pos = start;
    for (let f = 0;; f++) {
        if (bits.bitsPerRow[row] - pos < 26)
            return f;
        const b = bits.bb[row];
        const sync = (bitAt(b, pos) << 3) | (bitAt(b, pos + 1) << 2) | (bitAt(b, pos + 2) << 1) | bitAt(b, pos + 3);
        pos += 4;
        if (sync !== 0xe)
            return f;
        const decoded = new BitBuffer();
        pos = bits.manchesterDecode(row, pos, decoded, 11);
        if (decoded.bitsPerRow[0] !== 11)
            return f;
        const data = decoded.bb[0][0] ^ 0xff;
        const flag = decoded.bb[0][1] ^ 0xe0;
        const pad = (flag >> 7) & 1;
        const par = (flag >> 6) & 1;
        const end = (flag >> 5) & 1;
        if (pad !== (f === 0 ? 1 : 0))
            return f;
        if ((parity8(data) ^ pad ^ par) !== 0)
            return f;
        if (end !== 1)
            return f;
        if (f < out.length)
            out[f] = data;
    }
}
export const proflame2 = register({
    num: 207,
    name: 'SmartFire Proflame 2 remote control',
    what: 'gas fireplace remote',
    modulation: 4,
    shortWidth: 417,
    longWidth: 417,
    gapLimit: 1000,
    resetLimit: 6000,
    bands: BAND_315,
    decode(_dev, bits, ctx) {
        for (let row = 0; row < bits.numRows; row++) {
            const b = new Uint8Array(7);
            if (proflame2Words(bits, row, 0, b) !== 7)
                continue;
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
function srsmithButton(id) {
    if (id === 0x0d)
        return 'On/Off Channel 1';
    if (id === 0x1f)
        return 'On/Off Channel 2';
    if (id === 0x07)
        return 'Color Sync';
    if (id === 0x0b)
        return 'ON/OFF Control - M';
    return 'Unknown';
}
export const srsmithPoolSrs2cTx = register({
    num: 227,
    name: 'SRSmith Pool Light Remote Control SRS-2C-TX (-f 915M)',
    what: 'pool light remote',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 4096,
    bands: BAND_915,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < 120 || rowBits > 144)
            return DECODE_ABORT_LENGTH;
        const preamble = new Uint8Array([0xaa, 0xd3, 0x91, 0xd3, 0x91]);
        const startPos = bits.search(0, 0, preamble, 40) + 40;
        if (startPos >= rowBits)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, startPos, 10 * 8);
        if (((b[8] << 8) | b[9]) !== crc16(b, 8, 0x8005, 0xffff))
            return DECODE_FAIL_MIC;
        const reversedPin = reverse8((~b[5]) & 0xff);
        ctx.emit({
            model: 'SRSmith-SRS2CTX',
            type: 'Remote',
            id: reversedPin,
            button_press: b[6],
            button_press_name: srsmithButton(b[6]),
            unknown: (((b[1] << 24) >>> 0) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0,
            mic: 'CRC',
        });
        return 1;
    },
});
export const flowis = register({
    num: 237,
    name: 'Flowis flow meters',
    what: 'water meter',
    modulation: 16,
    shortWidth: 10,
    longWidth: 10,
    resetLimit: 5000,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        const preamble = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);
        const startPos = bits.search(0, 0, preamble, 48);
        if (startPos === rowBits)
            return DECODE_ABORT_EARLY;
        const len = bits.bytes(0, startPos + 48, 8)[0];
        if (startPos + (7 + len + 2) * 8 > rowBits)
            return DECODE_ABORT_LENGTH;
        const frame = new Uint8Array(len + 3);
        frame[0] = len;
        frame.set(bits.bytes(0, startPos + 7 * 8, (len + 2) * 8).subarray(0, len + 2), 1);
        const crc = crc16(frame, len + 1, 0x8005, 0xffff);
        if (((frame[len + 1] << 8) | frame[len + 2]) !== crc)
            return DECODE_FAIL_MIC;
        const b = frame;
        const type = b[1];
        if (type !== 1)
            return DECODE_ABORT_EARLY;
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
export const celsiaCzc1 = register({
    num: 243,
    name: 'Celsia CZC1 Thermostat',
    what: 'room thermostat',
    modulation: 4,
    shortWidth: 1220,
    longWidth: 1220,
    resetLimit: 4880,
    tolerance: 20,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1 || bits.bitsPerRow[0] < 144)
            return DECODE_ABORT_EARLY;
        const preamble = new Uint8Array([0xcc, 0xcc, 0xcc, 0xcc, 0x55, 0x55, 0x55, 0x55]);
        const preambleEnd = bits.search(0, 0, preamble, 64) + 64;
        const firstByte = preambleEnd >> 3;
        if (preambleEnd >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (preambleEnd + 132 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const row = bits.bb[0];
        const nBytes = bits.bitsPerRow[0] >> 3;
        const decoded = new BitBuffer();
        for (let ipos = firstByte; ipos < nBytes; ipos++) {
            const sym = row[ipos];
            if (sym === 0xf0)
                break;
            if (sym === 0x55) {
                decoded.addBit(0);
                decoded.addBit(0);
            }
            else if (sym === 0x5a) {
                decoded.addBit(0);
                decoded.addBit(1);
            }
            else if (sym === 0xa5) {
                decoded.addBit(1);
                decoded.addBit(0);
            }
            else if (sym === 0xaa) {
                decoded.addBit(1);
                decoded.addBit(1);
            }
        }
        const b = decoded.bb[0];
        if (crc8(b, 8, 0x31, 0xd7) !== 0)
            return DECODE_FAIL_MIC;
        if (b[2] !== 0x00 && b[2] !== 0xf0)
            return DECODE_FAIL_OTHER;
        const isCommand = b[2] === 0xf0;
        const out = {
            model: 'Celsia-CZC1',
            type: 'Thermostat',
            id: (b[0] << 8) | b[1],
            mic: 'CRC',
        };
        if (isCommand)
            out.heat = reverse8(b[3]);
        ctx.emit(out);
        return 1;
    },
});
export const muellerHotrod = register({
    num: 255,
    name: 'Mueller Hot Rod water meter',
    what: 'water meter',
    modulation: 16,
    shortWidth: 26,
    longWidth: 26,
    resetLimit: 2500,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 96)
            return DECODE_ABORT_LENGTH;
        const preamble = new Uint8Array([0xfe, 0xb1, 0x00]);
        const pos = bits.search(0, 0, preamble, 24);
        if (pos + 9 * 8 >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, pos + 24, 72);
        if ((crc8(b, 8, 0x07, 0x00) ^ 0x55) !== b[8]) {
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
export const oregonWmr500 = register({
    num: 363,
    name: 'Oregon Scientific WMR500 weather station',
    what: 'weather station',
    modulation: 16,
    shortWidth: 26,
    longWidth: 26,
    resetLimit: 312,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowLen = bits.bitsPerRow[0];
        const preamble = new Uint8Array([0xaa, 0xd3, 0x91, 0xd3, 0x91]);
        let pos = bits.search(0, 0, preamble, 40);
        if (pos >= rowLen)
            return DECODE_ABORT_EARLY;
        pos += 40;
        if (pos + 8 > rowLen)
            return DECODE_ABORT_LENGTH;
        let availBytes = ((rowLen - pos) / 8) | 0;
        if (availBytes > 28)
            availBytes = 28;
        const b = bits.bytes(0, pos, availBytes * 8);
        for (let i = 0; i < b.length; i++)
            b[i] ^= 0xff;
        const len = b[0];
        let totalBytes;
        let crcInit;
        if (len === 14) {
            totalBytes = 17;
            crcInit = 0x4ed0;
        }
        else if (len === 25) {
            totalBytes = 28;
            crcInit = 0x1a4c;
        }
        else {
            return DECODE_ABORT_EARLY;
        }
        if (availBytes < totalBytes)
            return DECODE_ABORT_LENGTH;
        const crcCalc = crc16(b, totalBytes - 2, 0x8005, crcInit);
        if (crcCalc !== ((b[totalBytes - 2] << 8) | b[totalBytes - 1]))
            return DECODE_FAIL_MIC;
        if (len === 14)
            return DECODE_ABORT_EARLY;
        const humidity = 208 - b[16];
        if (humidity < 0 || humidity > 100)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Oregon-WMR500',
            type: 'Weather',
            id: (b[8] << 8) | b[9],
            temperature_C: round1((b[14] - 169) * 0.7),
            temperature_raw: b[14],
            humidity,
            mic: 'CRC',
        });
        return 1;
    },
});
