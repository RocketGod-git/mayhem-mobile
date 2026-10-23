import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, crc16, crc16lsb, parityBytes, reflectBytes, reverse8, xorBytes } from '../util.js';
const TPMS_BANDS = [315000000, 433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const hexLow = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
const hexUp = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
export const steelmate = register({
    num: 59,
    name: 'Steelmate TPMS',
    what: 'tire pressure sensor: Steelmate TP-S15, R-Lake',
    modulation: 18,
    shortWidth: 50,
    longWidth: 50,
    resetLimit: 120,
    bands: TPMS_BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0x00, 0x00, 0x7f]);
        for (let row = 0; row < bits.numRows; row++) {
            const rowLen = bits.bitsPerRow[row];
            if (rowLen !== 72 && rowLen !== 73 && rowLen !== 208 && rowLen !== 209)
                continue;
            const pos = bits.search(row, 0, pre, 24);
            if (pos > rowLen - 72)
                continue;
            const b = bits.bytes(row, pos, 72);
            for (let i = 0; i < 9; i++)
                b[i] = ~b[i] & 0xff;
            reflectBytes(b, 9);
            if (addBytes(b, 6, 2) !== b[8])
                continue;
            const battery = b[7];
            const data = {
                model: 'Steelmate',
                type: 'TPMS',
                id: '0x' + hexLow((b[3] << 8) | b[4], 4),
                pressure_kPa: round1(b[5] * 3.125),
                temperature_C: b[6] - 50,
                mic: 'CHECKSUM',
            };
            if (battery < 0xfe)
                data.battery_mV = 3900 - battery * 10;
            if (battery === 0xff)
                data.alarm = 'fast leak';
            else if (battery === 0xfe)
                data.alarm = 'slow leak';
            ctx.emit(data);
            return 1;
        }
        return DECODE_FAIL_SANITY;
    },
});
const RH_ASK_MAX_PAYLOAD_LEN = 67;
const RH_ASK_HEADER_LEN = 4;
const RH_ASK_MAX_MESSAGE_LEN = RH_ASK_MAX_PAYLOAD_LEN - RH_ASK_HEADER_LEN - 3;
const RH_SYMBOLS = [
    0x0d, 0x0e, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c,
    0x23, 0x25, 0x26, 0x29, 0x2a, 0x2c, 0x32, 0x34,
];
function symbol6to4(symbol) {
    for (let i = (symbol >> 2) & 8; i < 16; i++) {
        if (symbol === RH_SYMBOLS[i])
            return i;
    }
    return 0xff;
}
function radioheadExtract(bits, row, payload) {
    const len = bits.bitsPerRow[row];
    let msgLen = RH_ASK_MAX_MESSAGE_LEN;
    const initPattern = new Uint8Array([0x55, 0x55, 0x55, 0x51, 0xcd]);
    const initPatternLen = 40;
    let pos = bits.search(row, 0, initPattern, initPatternLen);
    if (pos === len)
        return DECODE_ABORT_EARLY;
    let nbBytes = 0;
    pos += initPatternLen;
    for (; pos < len && nbBytes < msgLen; pos += 12) {
        const rx = bits.bytes(row, pos, 16);
        let r0 = reverse8(rx[0]);
        let r1 = reverse8(rx[1]);
        r1 = ((r1 & 0x0f) << 2) + (r0 >> 6);
        r0 &= 0x3f;
        const hiNibble = symbol6to4(r0);
        if (hiNibble > 0xf)
            return DECODE_FAIL_SANITY;
        const loNibble = symbol6to4(r1);
        if (loNibble > 0xf)
            return DECODE_FAIL_SANITY;
        payload[nbBytes] = (hiNibble << 4) | loNibble;
        if (nbBytes === 0) {
            msgLen = payload[0];
            if (msgLen < 2 || msgLen > RH_ASK_MAX_MESSAGE_LEN)
                break;
        }
        nbBytes++;
    }
    if (msgLen < 2)
        return DECODE_ABORT_LENGTH;
    if (msgLen > RH_ASK_MAX_MESSAGE_LEN)
        return DECODE_ABORT_LENGTH;
    const crc = (payload[msgLen - 1] << 8) | payload[msgLen - 2];
    const crcRecompute = ~crc16lsb(payload, msgLen - 2, 0x8408, 0xffff) & 0xffff;
    if (crcRecompute !== crc)
        return DECODE_FAIL_MIC;
    return msgLen;
}
export const radioheadAsk = register({
    num: 67,
    name: 'Radiohead ASK',
    what: 'generic hobbyist radio link',
    modulation: 4,
    shortWidth: 500,
    longWidth: 500,
    resetLimit: 5 * 500,
    bands: TPMS_BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const payload = new Uint8Array(RH_ASK_MAX_PAYLOAD_LEN);
        const msgLen = radioheadExtract(bits, 0, payload);
        if (msgLen <= 0)
            return msgLen;
        const dataLen = msgLen - RH_ASK_HEADER_LEN - 3;
        if (dataLen <= 0)
            return DECODE_FAIL_SANITY;
        const body = [];
        for (let j = 0; j < dataLen; j++)
            body.push(payload[5 + j]);
        ctx.emit({
            model: 'RadioHead-ASK',
            len: dataLen,
            to: payload[1],
            from: payload[2],
            id: payload[3],
            flags: payload[4],
            payload: body,
            mic: 'CRC',
        });
        return 1;
    },
});
export const sensibleLiving = register({
    num: 103,
    name: 'Sensible Living Mini-Plant Moisture Sensor',
    what: 'plant moisture probe',
    modulation: 4,
    shortWidth: 1000,
    longWidth: 1000,
    resetLimit: 5 * 1000,
    bands: TPMS_BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const payload = new Uint8Array(RH_ASK_MAX_PAYLOAD_LEN);
        const msgLen = radioheadExtract(bits, 0, payload);
        if (msgLen <= 0)
            return msgLen;
        ctx.emit({
            model: 'SensibleLiving-Moisture',
            house_id: payload[1],
            module_id: (payload[2] << 8) | payload[3],
            sensor_type: payload[4],
            sensor_count: payload[5],
            alarms: payload[6],
            sensor_value: (payload[7] << 8) | payload[8],
            battery_mV: ((payload[9] << 8) | payload[10]) * 10,
            mic: 'CRC',
        });
        return 1;
    },
});
const XC0324_MESSAGE_BITLEN = 48;
export const digitechXc0324 = register({
    num: 120,
    name: 'Digitech XC-0324 / AmbientWeather FT005TH temp/hum sensor',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 520,
    longWidth: 1000,
    resetLimit: 3000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0x5f]);
        let events = 0;
        let ret = 0;
        let out = null;
        for (let r = 0; r < bits.numRows; r++) {
            if (bits.bitsPerRow[r] < XC0324_MESSAGE_BITLEN)
                continue;
            let bitpos = 0;
            while ((bitpos = bits.search(r, bitpos, pre, 8)) + XC0324_MESSAGE_BITLEN <= bits.bitsPerRow[r]) {
                const b = bits.bytes(r, bitpos, XC0324_MESSAGE_BITLEN);
                if (xorBytes(b, 6) !== 0x00) {
                    ret = DECODE_FAIL_MIC;
                }
                else {
                    ret = 1;
                    events += 1;
                    if (out === null) {
                        const temp = ((reverse8(b[3]) & 0x0f) << 8) | reverse8(b[2]);
                        out = {
                            model: 'Digitech-XC0324',
                            id: hexUp(b[1], 2),
                            temperature_C: round1((temp - 400) * 0.1),
                            humidity: reverse8(b[4]),
                            mic: 'CHECKSUM',
                        };
                    }
                }
                bitpos += XC0324_MESSAGE_BITLEN;
            }
        }
        if (events > 0 && out !== null) {
            out.message_num = events;
            ctx.emit(out);
            return events;
        }
        return ret;
    },
});
export const companionWtr001 = register({
    num: 126,
    name: 'Companion WTR001 Temperature Sensor',
    what: 'thermometer',
    modulation: 6,
    shortWidth: 732,
    longWidth: 2196,
    gapLimit: 4000,
    resetLimit: 8000,
    syncWidth: 1464,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 14);
        if (r < 0 || bits.bitsPerRow[r] !== 14)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(r, 0, 14);
        b[0] = ~b[0] & 0xff;
        b[1] = ~b[1] & 0xfc;
        if ((b[0] & 0x04) === 0x04)
            return DECODE_FAIL_SANITY;
        if (!parityBytes(b, 2))
            return DECODE_FAIL_MIC;
        let tempTenthRaw = reverse8(b[0] & 0xf8);
        if (tempTenthRaw < 0x0a)
            return DECODE_FAIL_SANITY;
        if (tempTenthRaw > 0x13)
            return DECODE_FAIL_SANITY;
        tempTenthRaw -= 0x0a;
        const tempWholeRaw = reverse8(b[1] & 0xf0) | (reverse8(b[0] & 0x03) >> 2) | ((b[1] & 0x08) << 3);
        if (tempWholeRaw < 11)
            return DECODE_FAIL_SANITY;
        if (tempWholeRaw > 111)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Companion-WTR001',
            temperature_C: round1(tempWholeRaw + tempTenthRaw * 0.1 - 41),
            mic: 'PARITY',
        });
        return 1;
    },
});
export const telldusFt0385r = register({
    num: 205,
    name: 'Telldus weather station FT0385R sensors',
    what: 'weather station console',
    modulation: 3,
    shortWidth: 500,
    longWidth: 0,
    gapLimit: 1200,
    resetLimit: 2400,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0x14, 0xe0]);
        if (bits.numRows > 2)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 296 && bits.bitsPerRow[1] < 296)
            return DECODE_ABORT_EARLY;
        let b = null;
        for (let i = 0; i < bits.numRows; i++) {
            let pos = bits.search(i, 0, pre, 9);
            pos += 8;
            if (pos + 296 > bits.bitsPerRow[i])
                continue;
            b = bits.bytes(i, pos, 296);
            break;
        }
        if (b === null)
            return DECODE_FAIL_SANITY;
        if (crc8(b, 37, 0x31, 0xc0))
            return DECODE_FAIL_MIC;
        const degMsb = (b[2] & 0x04) >> 2;
        const gustMsb = (b[2] & 0x02) >> 1;
        const windMsb = b[2] & 0x01;
        const wind = (windMsb << 8) | b[3];
        const gust = (gustMsb << 8) | b[4];
        const windDir = (degMsb << 8) | b[5];
        const rainTot = (b[20] << 8) | b[21];
        const temp2Msb = (b[24] & 0xf0) >> 4;
        const tempRaw = ((b[24] & 0x0f) << 8) | b[25];
        const humidity = b[26];
        const temp2Raw = (temp2Msb << 8) | b[27];
        const humidity2 = b[28];
        const pressure = (b[29] << 8) | b[30];
        const data = {
            model: 'Telldus-FT0385R',
            temperature_2_F: round1((temp2Raw - 400) * 0.1),
            humidity_2: humidity2,
            pressure_hPa: round1(pressure * 0.1),
            mic: 'CRC',
        };
        if (tempRaw !== 0x7fb) {
            data.temperature_F = round1((tempRaw - 400) * 0.1);
            data.humidity = humidity;
            data.rain_mm = round1(rainTot * 0.1);
            data.wind_dir_deg = windDir;
            data.wind_avg_m_s = round1(wind * 0.1);
            data.wind_max_m_s = round1(gust * 0.1);
        }
        ctx.emit(data);
        return 1;
    },
});
export const antAntplus = register({
    num: 216,
    name: 'ANT and ANT+ devices',
    what: 'sports and fitness telemetry',
    modulation: 16,
    shortWidth: 1,
    longWidth: 1,
    syncWidth: 8,
    gapLimit: 500,
    resetLimit: 500,
    bands: [2457025000],
    disabled: true,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xaa]);
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const rowLen = bits.bitsPerRow[0];
        if (rowLen < 120 || rowLen > 200)
            return DECODE_ABORT_LENGTH;
        const bitOffset = bits.search(0, 0, pre, 8) + 8;
        if (bitOffset + 17 * 8 > rowLen)
            return DECODE_ABORT_LENGTH;
        let b = bits.bytes(0, bitOffset, 17 * 8);
        if (crc16(b, 17, 0x1021, 0xffff) !== 0) {
            b = bits.bytes(0, bitOffset + 1, 17 * 8);
            if (crc16(b, 17, 0x1021, 0xffff) !== 0)
                return DECODE_FAIL_MIC;
        }
        const netKey = (b[1] << 8) | b[0];
        const id = (b[3] << 8) | b[2];
        let payload = '';
        for (let i = 7; i <= 14; i++)
            payload += (i > 7 ? ' ' : '') + hexLow(b[i], 2);
        ctx.emit({
            model: 'Garmin-ANT',
            network: netKey === 0xc5a6 ? 'ANT+' : 'ANT',
            channel: '0x' + hexLow(netKey, 4),
            id: '0x' + hexLow(id, 4),
            device_type: b[4],
            tx_type: b[5],
            payload,
            mic: 'CRC',
        });
        return 1;
    },
});
const WL_TH6R_BITS_PER_ROW = 72;
export const shenzhenWaleWlTh6r = register({
    num: 319,
    name: 'Shenzhen Wale WL-TH6R Temperature & Humidity Sensor',
    what: 'thermometer and hygrometer',
    modulation: 6,
    tolerance: 50,
    shortWidth: 365,
    longWidth: 605,
    gapLimit: 780,
    resetLimit: 4000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedPrefix(2, WL_TH6R_BITS_PER_ROW);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > WL_TH6R_BITS_PER_ROW + 1)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(row, 0, WL_TH6R_BITS_PER_ROW);
        for (let i = 0; i < 9; i++)
            b[i] = ~b[i] & 0xff;
        for (let i = 0; i < 7; i++)
            b[i] ^= b[7];
        const x = xorBytes(b, 7);
        let sum = 0;
        for (let i = 0; i < 7; i++)
            sum += b[i];
        const mic = 0xa5 ^ x ^ (sum & 0xff) ^ (sum >> 8);
        if (b[8] !== mic)
            return DECODE_FAIL_MIC;
        let tempRaw = (b[3] << 8) | b[4];
        if (tempRaw & 0x8000)
            tempRaw -= 0x10000;
        const tempC = tempRaw * 0.1;
        if (tempC < -20 || tempC > 60)
            return DECODE_FAIL_SANITY;
        const humidityPct = b[5];
        if (humidityPct > 127)
            return DECODE_FAIL_SANITY;
        const batteryPct = b[6];
        const pairing = b[7] >> 7;
        const data = {
            model: 'WL-TH6R',
            id: hexUp((b[0] << 16) | (b[1] << 8) | b[2], 6),
            battery_pct: batteryPct,
            temperature_C: round1(tempC),
            humidity: humidityPct,
            cycle: (b[7] & 0x40) ? 0x40 : (b[7] & 0x3f),
            mic: 'CHECKSUM',
        };
        if (batteryPct < 20)
            data.battery_ok = 0;
        if (pairing)
            data.pairing = pairing;
        ctx.emit(data);
        return 1;
    },
});
function gearHiveDecode(bits, ctx, row, bitpos) {
    const payloadStart = bitpos + 16;
    if (bits.bitsPerRow[row] - payloadStart < 72)
        return DECODE_ABORT_LENGTH;
    const raw = bits.bytes(row, payloadStart, 72);
    const p = new Uint8Array(9);
    p[0] = raw[0] ^ 0x94;
    for (let i = 1; i < 9; i++)
        p[i] = raw[i] ^ raw[i - 1];
    if ((p[6] & 0x3c) !== 0x20)
        return DECODE_FAIL_SANITY;
    if ((p[7] & 0x3f) !== 0x35)
        return DECODE_FAIL_SANITY;
    const sensorClass = p[1] & 0x0f;
    const base = (80 + sensorClass * 64) & 0xff;
    ctx.emit({
        model: 'Gear-Hive',
        type: 'TPMS',
        id: hexLow((p[2] << 16) | (p[3] << 8) | p[4], 6),
        counter: ((p[1] >> 4) << 8) | p[0],
        pressure_kPa: round1(((p[5] - base + 256) & 0xff) * 6.25),
        temperature_C: ((p[7] >> 6) | ((p[6] & 0x03) << 2)) + 21,
        mic: 'CHECKSUM',
    });
    return 1;
}
export const tmpsGearHive = register({
    num: 322,
    name: 'Gear Hive TPMS sensor',
    what: 'tire pressure sensor: unbranded aftermarket',
    modulation: 3,
    shortWidth: 120,
    longWidth: 224,
    gapLimit: 0,
    resetLimit: 800,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const sync = new Uint8Array([0x25, 0x94]);
        let events = 0;
        let ret = 0;
        for (let row = 0; row < bits.numRows; row++) {
            let bitpos = 0;
            while ((bitpos = bits.search(row, bitpos, sync, 16)) + 16 + 72 <= bits.bitsPerRow[row]) {
                ret = gearHiveDecode(bits, ctx, row, bitpos);
                if (ret > 0)
                    events += ret;
                bitpos += 16;
            }
        }
        return events > 0 ? events : ret;
    },
});
export const fslScoreboard = register({
    num: 345,
    name: 'FSL Cricket Scoreboard Controller',
    what: 'cricket scoreboard controller',
    modulation: 16,
    shortWidth: 528,
    longWidth: 528,
    resetLimit: 3000,
    decode(_dev, bits, ctx) {
        const preamble = new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]);
        const sync = new Uint8Array([0xe0]);
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] < 700)
                continue;
            const preamblePos = bits.search(row, 0, preamble, 32);
            if (preamblePos + 38 + 72 >= bits.bitsPerRow[row])
                continue;
            for (let blockPos = preamblePos + 38; blockPos + 72 < bits.bitsPerRow[row]; blockPos += 72) {
                if (bits.search(row, blockPos, sync, 3) !== blockPos)
                    continue;
                const decoded = new BitBuffer();
                bits.manchesterDecode(row, blockPos + 3, decoded, 32);
                if (decoded.bitsPerRow[0] < 32)
                    continue;
                const b = decoded.bytes(0, 0, 32);
                const pos3 = b[0] >> 4, fieldId = b[0] & 0xf;
                const pos2 = b[1] >> 4, hundreds = b[1] & 0xf;
                const pos1 = b[2] >> 4, tens = b[2] & 0xf;
                const pos0 = b[3] >> 4, units = b[3] & 0xf;
                if (pos3 !== 0x3 || pos2 !== 0x2 || pos1 !== 0x1 || pos0 !== 0x0)
                    continue;
                let value = 0;
                if (hundreds !== 0xf)
                    value += hundreds * 100;
                if (tens !== 0xf)
                    value += tens * 10;
                if (units !== 0xf)
                    value += units;
                ctx.emit({ model: 'FSL-Scoreboard', id: fieldId, value });
                return 1;
            }
        }
        return DECODE_ABORT_EARLY;
    },
});
