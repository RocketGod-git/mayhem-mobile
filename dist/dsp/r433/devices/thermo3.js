import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, addNibbles, crc8, crc16lsb, parity8, reflect4, reflectBytes } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
function sumBytesWide(m, n) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += m[i];
    return s;
}
export const rubicson48659 = register({
    num: 133,
    name: 'Rubicson 48659 Thermometer',
    what: 'meat thermometer',
    modulation: 5,
    shortWidth: 940,
    longWidth: 1900,
    gapLimit: 2000,
    resetLimit: 4000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(10, 32);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 33 || bits.bitsPerRow[row] < 10)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (((addBytes(b, 3) - b[3]) & 0xff) !== 0xa6)
            return DECODE_FAIL_MIC;
        const tempF = ((b[1] & 0x04) >> 2) ? -1 : 1 * (((b[1] & 0x03) << 8) | b[2]);
        ctx.emit({
            model: 'Rubicson-48659',
            type: 'Weather',
            id: b[0],
            temperature_F: round1(tempF),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const klimalogg = register({
    num: 150,
    name: 'Klimalogg',
    what: 'logging thermometer and hygrometer',
    modulation: 12,
    shortWidth: 26,
    longWidth: 0,
    gapLimit: 0,
    resetLimit: 1000,
    disabled: true,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 11 * 8)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, new Uint8Array([0xb4, 0x2b]), 16) + 16;
        if (at + 9 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 9 * 8);
        if (b[7] !== 0x6a)
            return DECODE_FAIL_SANITY;
        reflectBytes(b, 9);
        if (crc8(b, 9, 0x31, 0x00) !== 0)
            return DECODE_FAIL_MIC;
        const tempRaw = (b[2] & 0x0f) * 100 + (b[3] >> 4) * 10 + (b[3] & 0x0f);
        let humidity = b[4] & 0x7f;
        if (humidity === 0x6a)
            humidity = 100;
        ctx.emit({
            model: 'Klimalogg-Pro',
            type: 'Weather',
            id: ((b[0] & 0x7f) << 8) | b[1],
            battery_ok: (b[5] & 0x80) ? 0 : 1,
            temperature_C: round1((tempRaw - 400) * 0.1),
            humidity,
            sequence_nr: (b[6] & 0xf0) >> 4,
            mic: 'CRC',
        });
        return 1;
    },
});
export const inkbirdIth20r = register({
    num: 194,
    name: 'Inkbird ITH-20R temperature humidity sensor',
    what: 'logging thermometer and hygrometer with a second probe',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 4000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 187)
            return DECODE_ABORT_LENGTH;
        const pos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0xaa, 0x2d, 0xd4]), 40);
        if (pos === bits.bitsPerRow[0])
            return DECODE_FAIL_SANITY;
        const start = pos + 40;
        let len = bits.bitsPerRow[0] - start;
        if (((len + 7) / 8 | 0) < 19)
            return DECODE_ABORT_LENGTH;
        if (len > 19 * 8)
            len = 19 * 8;
        const msg = new Uint8Array(19);
        bits.extractBytes(0, start, msg, len);
        if (crc16lsb(msg, 16, 0xa001, 0x86f4) !== ((msg[17] << 8) | msg[16]))
            return DECODE_FAIL_MIC;
        const temperature = (((msg[11] << 8 | msg[10]) << 16) >> 16) * 0.1;
        const temperature2 = (((msg[13] << 8 | msg[12]) << 16) >> 16) * 0.1;
        ctx.emit({
            model: 'Inkbird-ITH20R',
            type: 'Weather',
            id: (msg[9] << 8) | msg[8],
            battery_ok: round2(msg[7] * 0.01),
            sensor_num: msg[4],
            temperature_C: round1(temperature),
            temperature_2_C: round1(temperature2),
            humidity: round1(((msg[15] << 8) | msg[14]) * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
export const acurite01185m = register({
    num: 197,
    name: 'Acurite Grill/Meat Thermometer 01185M',
    what: 'grill and meat thermometer',
    modulation: 6,
    shortWidth: 840,
    longWidth: 2070,
    syncWidth: 6600,
    gapLimit: 3000,
    resetLimit: 6000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        let result = 0;
        bits.invert();
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 56) {
                result = DECODE_ABORT_LENGTH;
                continue;
            }
            const b = bits.bb[row];
            reflectBytes(b, 7);
            const sum = sumBytesWide(b, 6);
            if ((sum & 0xff) !== b[6]) {
                result = DECODE_FAIL_MIC;
                continue;
            }
            if (sum === 0)
                return DECODE_FAIL_SANITY;
            const temp1Raw = (b[2] << 8) | b[3];
            const temp2Raw = (b[4] << 8) | b[5];
            const temp1Ok = temp1Raw > 200 && temp1Raw < 7000;
            const temp2Ok = temp2Raw > 200 && temp2Raw < 7000;
            ctx.emit({
                model: 'Acurite-01185M',
                type: 'Weather',
                id: b[0],
                channel: b[1] & 0x0f,
                battery_ok: (b[1] >> 7) ? 0 : 1,
                ...(temp1Ok ? { temperature_1_F: round1((temp1Raw - 900) * 0.1) } : {}),
                ...(temp2Ok ? { temperature_2_F: round1((temp2Raw - 900) * 0.1) } : {}),
                mic: 'CHECKSUM',
            });
            return 1;
        }
        return result;
    },
});
const DG950_WIND_DIR = [157, 45, 135, 67, 180, 22, 112, 90, 225, 337, 247, 315, 202, 0, 270, 292];
export const thermorDg950 = register({
    num: 254,
    name: 'Thermor DG950 weather station',
    what: 'weather station with wind and rain sensors',
    modulation: 6,
    shortWidth: 680,
    longWidth: 2100,
    syncWidth: 1438,
    gapLimit: 3000,
    resetLimit: 8000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 13)
            return DECODE_ABORT_EARLY;
        const b = new Uint8Array(13);
        for (let row = 0; row < 13; row++) {
            if (bits.bitsPerRow[row] !== 9)
                return DECODE_ABORT_EARLY;
            if ((bits.bb[row][0] & 0x80) !== 0)
                return DECODE_ABORT_EARLY;
            b[row] = bits.bytes(row, 1, 8)[0];
        }
        reflectBytes(b, 13);
        if (b[0] === 0xff && b[1] === b[2] && b[1] === b[4] && b[1] === b[5]
            && b[1] === b[6] && b[1] === b[7] && b[1] === b[8] && b[1] === b[10]) {
            ctx.emit({
                model: 'Thermor-DG950',
                type: 'Weather',
                id: ~b[1] & 0xff,
                pairing: 1,
                mic: 'CHECKSUM',
            });
            return 1;
        }
        const tempChk = (b[1] + b[10]) & 0xff;
        if (tempChk + 1 !== b[3])
            return DECODE_ABORT_EARLY;
        const tempC = (b[1] - 195) + (b[10] - 245) * 0.1;
        const rainRate = ~b[2] & 0xff;
        if (rainRate !== (~b[12] & 0xff) - 7)
            return DECODE_ABORT_EARLY;
        let windDir = -1;
        if (b[4] !== 0xff && b[5] !== 0xff) {
            if (b[4] !== b[5])
                return DECODE_ABORT_EARLY;
            windDir = DG950_WIND_DIR[b[4] & 0x0f];
        }
        const windChk = (~b[6] + ~b[7] + ~b[8]) & 0xff;
        if (windChk !== (~b[9] & 0xff))
            return DECODE_ABORT_EARLY;
        let windKmh = -1;
        if (b[8] !== 0xff) {
            const speedRaw = (~b[6] & 0xff) | ((~b[7] & 0xff) << 8);
            const coef = ~b[8] & 0xff;
            const ratio = speedRaw < 256 ? (speedRaw * -0.0001746) + 0.155 : 0.11;
            windKmh = ratio * (speedRaw - coef + 45);
            if (windKmh < 0)
                windKmh = 0;
        }
        ctx.emit({
            model: 'Thermor-DG950',
            type: 'Weather',
            id: ~b[0] & 0xff,
            temperature_C: round1(tempC),
            rain_rate_mm_h: round1(rainRate * 0.1),
            ...(windDir >= 0 ? { wind_dir_deg: windDir } : {}),
            ...(windKmh >= 0 ? { wind_avg_km_h: round1(windKmh) } : {}),
            pairing: 0,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const bresserSt1005h = register({
    num: 268,
    name: 'Bresser Thermo-/Hygro-Sensor Explore Scientific ST1005H',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 2500,
    longWidth: 4500,
    gapLimit: 4500,
    resetLimit: 10000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 38);
        if (r < 0 || bits.bitsPerRow[r] > 38)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        if ((b[0] & 0x80) !== 0)
            return DECODE_FAIL_SANITY;
        const msg = bits.bytes(r, 1, 32);
        msg[3] &= 0xfe;
        const chk = b[4] >> 2;
        const sum = addNibbles(msg, 4);
        if (sum === 0)
            return DECODE_ABORT_EARLY;
        if (chk !== (sum & 0x3f))
            return DECODE_FAIL_MIC;
        const tempRaw = ((((msg[1] & 0x0f) << 12) | (msg[2] << 4)) << 16) >> 16;
        const tempC = (tempRaw >> 4) * 0.1;
        const channel = ((msg[1] >> 4) & 0x03) + 1;
        const humidity = msg[3] >> 1;
        if (channel >= 4 || humidity > 110 || tempC < -30 || tempC > 160)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Bresser-ST1005H',
            type: 'Weather',
            id: msg[0],
            channel,
            battery_ok: (msg[1] >> 7) ? 0 : 1,
            button: (msg[1] >> 6) & 0x01,
            temperature_C: round1(tempC),
            humidity,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const oriaNibble = (m, k) => (k % 2 === 0) ? (m[k >> 1] >> 4) & 0x0f : m[k >> 1] & 0x0f;
export const oriaWa150km = register({
    num: 288,
    name: 'Oria WA150KM freezer and fridge thermometer',
    what: 'freezer and fridge thermometer',
    modulation: 4,
    shortWidth: 490,
    longWidth: 490,
    gapLimit: 1500,
    resetLimit: 4000,
    priority: 10,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const BITLEN = 227;
        let r = -1;
        for (let i = 0; i < bits.numRows; i++)
            if (bits.bitsPerRow[i] === BITLEN) {
                r = i;
                break;
            }
        if (r < 0)
            return DECODE_ABORT_LENGTH;
        const raw = bits.bb[r];
        if (raw[0] !== 0xaa || raw[1] !== 0xaa || raw[2] !== 0xaa)
            return DECODE_ABORT_EARLY;
        if (raw[(BITLEN / 8 | 0) - 1] !== 0x69)
            return DECODE_ABORT_EARLY;
        bits.invert();
        const mc = new BitBuffer();
        bits.manchesterDecode(r, 0, mc, BITLEN);
        const m = mc.bb[0];
        let sum = 0;
        for (let i = 0; i < 15; i++)
            sum += reflect4(oriaNibble(m, 7 + i));
        const chkRecv = reflect4(oriaNibble(m, 22)) | (reflect4(oriaNibble(m, 23)) << 4);
        if ((sum & 0xff) !== chkRecv)
            return DECODE_FAIL_MIC;
        reflectBytes(m, (mc.bitsPerRow[0] + 7) >> 3);
        const b = m;
        let temperature = ((b[8] >> 4) & 0x0f) * 10 + (b[8] & 0x0f) + ((b[7] >> 4) & 0x0f) * 0.1;
        if (b[9] & 0x08)
            temperature = -temperature;
        ctx.emit({
            model: 'Oria-WA150KM',
            type: 'Weather',
            id: b[6],
            channel: ((b[5] >> 4) & 0x0f) + 1,
            temperature_C: round1(temperature),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const thermorA6n132tx = register({
    num: 325,
    name: 'Thermor A6N 132TX temperature sensor',
    what: 'thermometer',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 2000,
    resetLimit: 4000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 5)
            return DECODE_ABORT_LENGTH;
        const row = bits.findRepeatedRow(5, 32);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 32)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        const tempRaw = (b[1] << 8) | b[2];
        if (tempRaw > 2500)
            return DECODE_FAIL_SANITY;
        const loSum = (b[0] & 0x0f) + (b[1] & 0x0f) + (b[2] & 0x0f);
        const overflow = loSum >> 4;
        if ((loSum & 0x0f) !== (b[3] & 0x0f))
            return DECODE_FAIL_MIC;
        const id = (b[0] >> 4) & 0x0f;
        const hiSum = (b[0] >> 4) + (b[1] >> 4) + (b[2] >> 4);
        const chkHi = b[3] >> 4;
        if (id === 4) {
            if (chkHi !== ((hiSum + overflow) & 1))
                return DECODE_FAIL_MIC;
        }
        else {
            const msb = parity8(b[0] & 0x0f) ^ parity8(b[1] & 0x0f) ^ parity8(b[2]);
            const low = (2 + (hiSum & 1)) ^ overflow;
            if (chkHi !== ((msb << 3) | low))
                return DECODE_FAIL_MIC;
        }
        ctx.emit({
            model: 'Thermor-A6N132TX',
            type: 'Weather',
            id,
            channel: (b[0] >> 2) & 0x03,
            temperature_C: round1(tempRaw * 0.1),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const auriolHg04641a = register({
    num: 357,
    name: 'Auriol HG04641A temperature station',
    what: 'thermometer',
    modulation: 5,
    shortWidth: 980,
    longWidth: 1976,
    gapLimit: 2500,
    resetLimit: 5000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] < 36)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(row, 0, 36);
        b[4] >>= 4;
        const sum = addNibbles(b, 4);
        if ((sum & 0x0f) !== b[4])
            return DECODE_FAIL_MIC;
        const flags = b[2] >> 4;
        if ((flags & 0x06) !== 0 || !(flags & 0x01))
            return DECODE_FAIL_SANITY;
        const tempRaw = ((((b[2] & 0x0f) << 12) | (b[3] << 4)) << 16) >> 16;
        const tempDecic = tempRaw >> 4;
        if (tempDecic < -400 || tempDecic > 600)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Auriol-HG04641A',
            type: 'Weather',
            id: (b[0] << 8) | b[1],
            battery_ok: (flags & 0x08) ? 0 : 1,
            temperature_C: round1(tempDecic * 0.1),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
