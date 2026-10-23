import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addNibbles, crc4, crc8, reflectBytes, reverse8, xorBytes } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const signed12 = (v) => ((v & 0xffff) << 16) >> 20;
const fromBcd = (x) => ((x & 0xf0) >> 4) * 10 + (x & 0x0f);
function sumBytes(m, n) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += m[i];
    return s;
}
function alectoChecksum(b) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
        const t = reverse8(b[i]);
        sum += (t & 0x0f) + ((t & 0xf0) >> 4);
    }
    sum = (b[1] & 0x7f) === 0x6c ? sum + 0x07 : 0x0f - sum;
    return reverse8((sum & 0x0f) << 4) === (b[4] >> 4);
}
export const alectoV1 = register({
    num: 16,
    name: 'AlectoV1 Weather Sensor (Alecto WS3500 WS4500 Ventus W155/W044 Oregon)',
    what: 'weather station: temperature, humidity, rain and wind',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 7000,
    resetLimit: 10000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 7)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[1] !== 36)
            return DECODE_ABORT_LENGTH;
        const bb = bits.bb;
        if (bb[1][0] !== bb[5][0] || bb[2][0] !== bb[6][0]
            || (bb[1][4] & 0x0f) !== 0 || (bb[5][4] & 0x0f) !== 0
            || bb[5][0] === 0 || bb[5][1] === 0)
            return DECODE_ABORT_EARLY;
        if (!alectoChecksum(bb[1]) || !alectoChecksum(bb[5]))
            return DECODE_FAIL_MIC;
        const b = bb[1];
        const batteryOk = (b[1] & 0x80) >> 7 ? 0 : 1;
        const msgType = (b[1] & 0x60) >> 5;
        const isRain = (b[1] & 0x0f) === 0x0c;
        const common = {
            id: reverse8(b[0]),
            channel: (b[0] & 0x0c) >> 2,
            battery_ok: batteryOk,
            mic: 'CHECKSUM',
        };
        if (msgType === 0x3 && !isRain) {
            let skip = -1;
            if ((b[1] & 0x0e) === 0x08 && b[2] === 0)
                skip = 0;
            else if ((b[1] & 0x0e) === 0x0e)
                skip = 4;
            if (skip < 0)
                return DECODE_FAIL_SANITY;
            if (bits.numRows < 6 + skip)
                return DECODE_ABORT_EARLY;
            const gustRow = bb[5 + skip];
            ctx.emit({
                model: 'AlectoV1-Wind',
                type: 'Weather',
                ...common,
                wind_avg_m_s: round2(reverse8(bb[1 + skip][3]) * 0.2),
                wind_max_m_s: round2(reverse8(gustRow[3]) * 0.2),
                wind_dir_deg: (reverse8(gustRow[2]) << 1) | (gustRow[1] & 0x01),
            });
            return 1;
        }
        if (msgType === 0x3 && isRain) {
            ctx.emit({
                model: 'AlectoV1-Rain',
                type: 'Weather',
                ...common,
                rain_mm: round2(((reverse8(b[3]) << 8) | reverse8(b[2])) * 0.25),
            });
            return 1;
        }
        if (msgType !== 0x3
            && bb[2][0] === bb[3][0] && bb[3][0] === bb[4][0]
            && bb[4][0] === bb[5][0] && bb[5][0] === bb[6][0]
            && (bb[3][4] & 0x0f) === 0 && (bb[5][4] & 0x0f) === 0) {
            const humidity = fromBcd(reverse8(b[3]));
            if (humidity > 100)
                return DECODE_FAIL_SANITY;
            ctx.emit({
                model: 'AlectoV1-Temperature',
                type: 'Weather',
                ...common,
                temperature_C: round2(signed12((reverse8(b[1]) & 0xf0) | (reverse8(b[2]) << 8)) * 0.1),
                humidity,
            });
            return 1;
        }
        return DECODE_FAIL_SANITY;
    },
});
export const infactory = register({
    num: 91,
    name: 'inFactory, nor-tec, FreeTec NC-3982-913 temperature humidity sensor',
    what: 'thermometer and hygrometer',
    modulation: 5,
    syncWidth: 500,
    shortWidth: 2000,
    longWidth: 4000,
    resetLimit: 5000,
    tolerance: 750,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n !== 40 && n !== 41 && n !== 42)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        const channel = b[4] & 0x03;
        if (!channel)
            return DECODE_ABORT_EARLY;
        const msg = Uint8Array.from([b[0], (b[1] & 0x0f) | ((b[4] & 0x0f) << 4), b[2], b[3], b[4]]);
        const crc = crc4(msg, 4, 0x13, 0) ^ (msg[4] >> 4);
        if (crc !== (b[1] >> 4))
            return DECODE_FAIL_MIC;
        const humidity = (b[3] & 0x0f) * 10 + (b[4] >> 4);
        if (humidity > 100)
            return DECODE_FAIL_SANITY;
        const tempF = round2((((b[2] << 4) | (b[3] >> 4)) - 900) * 0.1);
        if (tempF < -40 || tempF > 158)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'inFactory-TH',
            type: 'Weather',
            id: b[0],
            channel,
            battery_ok: (b[1] >> 2) & 1 ? 0 : 1,
            button: (b[1] >> 3) & 1,
            temperature_F: tempF,
            humidity,
            mic: 'CRC',
        });
        return 1;
    },
});
export const oregonSl109h = register({
    num: 54,
    name: 'Oregon Scientific SL109H Remote Thermal Hygro Sensor',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 5000,
    resetLimit: 10000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 38);
        if (row < 0 || bits.bitsPerRow[row] !== 38)
            return DECODE_ABORT_LENGTH;
        const msg = bits.bb[row];
        if (!msg[0] && !msg[1] && !msg[2] && !msg[3])
            return DECODE_FAIL_SANITY;
        const chk = msg[0] >> 4;
        const b = bits.bytes(row, 2, 36);
        b[0] &= 0x3f;
        if (chk === 0 && !b[0] && !b[1] && !b[2])
            return DECODE_FAIL_SANITY;
        if ((addNibbles(b, 5) & 0x0f) !== chk)
            return DECODE_FAIL_MIC;
        const channelCode = b[0] >> 4;
        if (channelCode === 3)
            return DECODE_FAIL_SANITY;
        const tens = b[0] & 0x0f, ones = b[1] >> 4;
        if (tens > 9 || ones > 9)
            return DECODE_FAIL_SANITY;
        const tempC = round1(signed12(((b[1] & 0x0f) << 12) | (b[2] << 4)) * 0.1);
        if (tempC < -20 || tempC > 60)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Oregon-SL109H',
            type: 'Weather',
            id: ((b[3] & 0x0f) << 4) | (b[4] >> 4),
            channel: channelCode ? channelCode : 3,
            temperature_C: tempC,
            humidity: tens * 10 + ones,
            status: b[3] >> 4,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
function tx8300Checksum(b) {
    let x = 0, y = 0;
    for (let i = 0; i < 4; i++) {
        x += (b[i] & 0x0f) + ((b[i] & 0xf0) >> 4);
        y += (b[i] & 0x05) + ((b[i] & 0x50) >> 4);
    }
    return (((~x & 0x0f) << 4) | (~y & 0x0f)) & 0xff;
}
export const ambientWeatherTx8300 = register({
    num: 112,
    name: 'Ambient Weather TX-8300 Temperature/Humidity Sensor',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 6500,
    resetLimit: 8000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 74)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, 2, 72);
        for (let i = 4; i < 8; i++)
            b[i] ^= 0xff;
        b[0] = (b[0] & 0x7f) | (b[4] & 0x80);
        if (b[0] !== b[4] || b[1] !== b[5] || b[2] !== b[6] || b[3] !== b[7])
            return DECODE_FAIL_MIC;
        if ((tx8300Checksum(b) ^ b[8]) !== 0)
            return DECODE_FAIL_MIC;
        const temp = (b[2] & 0x0f) * 10 + ((b[3] & 0xf0) >> 4) + (b[3] & 0x0f) * 0.1;
        const tens = (b[0] & 0xf0) >> 4, ones = b[0] & 0x0f;
        const data = {
            model: 'AmbientWeather-TX8300',
            type: 'Weather',
            id: ((b[1] & 0x07) << 4) | ((b[2] & 0xf0) >> 4),
            channel: (b[1] & 0x30) >> 4,
            battery: (b[1] & 0xc0) >> 6,
            temperature_C: round1((b[1] & 0x08) >> 3 ? -temp : temp),
            mic: 'CHECKSUM',
        };
        if (tens <= 9 && ones <= 9)
            data.humidity = tens * 10 + ones;
        ctx.emit(data);
        return 1;
    },
});
export const tsFt002 = register({
    num: 125,
    name: 'TS-FT002 Wireless Ultrasonic Tank Liquid Level Meter With Temperature Sensor',
    what: 'tank level gauge with a thermometer',
    modulation: 5,
    shortWidth: 464,
    longWidth: 948,
    gapLimit: 1200,
    resetLimit: 2000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        const b = new Uint8Array(9);
        if (n === 72) {
            bits.extractBytes(0, 0, b, 72);
        }
        else if (n === 71) {
            bits.extractBytes(0, 7, b.subarray(1), 64);
            b[0] = bits.bb[0][0] >> 1;
        }
        else if (n === 70) {
            bits.extractBytes(0, 6, b.subarray(1), 64);
            b[0] = (bits.bb[0][0] >> 2) | 0x80;
        }
        else {
            return DECODE_ABORT_LENGTH;
        }
        if (xorBytes(b, 9) !== 0)
            return DECODE_FAIL_MIC;
        reflectBytes(b, 8);
        if (b[2] !== 0x11)
            return DECODE_FAIL_SANITY;
        const t = b[5] >> 4;
        const transmit = (t & 0x07) === 0x07 ? 5 : (t & 0x08) === 0x08 ? 30 : t === 0 ? 180 : 0;
        ctx.emit({
            model: 'TS-FT002',
            type: 'Weather',
            id: b[1],
            depth_cm: (b[3] << 4) | (b[4] & 0x0f),
            temperature_C: round1((((b[6] << 4) | (b[5] & 0x0f)) - 400) * 0.1),
            transmit_s: transmit,
            flags: b[4] >> 4,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const eurochron = register({
    num: 129,
    name: 'Eurochron temperature and humidity sensor',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 1016,
    longWidth: 2024,
    gapLimit: 2100,
    resetLimit: 8200,
    bands: BAND_433,
    disabled: true,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 36)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[1] & 0x0f)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Eurochron-TH',
            type: 'Weather',
            id: b[0],
            battery_ok: b[1] >> 7 ? 0 : 1,
            temperature_C: round1(signed12((b[3] << 8) | (b[4] & 0xf0)) * 0.1),
            humidity: b[2],
            button: (b[1] & 0x10) >> 4,
        });
        return 1;
    },
});
export const ws2032 = register({
    num: 145,
    name: 'WS2032 weather station',
    what: 'weather station: temperature, humidity, wind and rain',
    modulation: 6,
    shortWidth: 500,
    longWidth: 1000,
    gapLimit: 750,
    resetLimit: 4000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 14 * 8);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const offset = bits.search(row, 0, new Uint8Array([0x0a]), 8);
        if (offset + 14 * 8 > bits.bitsPerRow[row])
            return DECODE_ABORT_LENGTH;
        bits.invert();
        const b = bits.bytes(row, offset, 14 * 8);
        const sum = sumBytes(b, 12);
        if (sum === 0)
            return DECODE_FAIL_SANITY;
        if ((sum & 0xff) !== b[12])
            return DECODE_FAIL_MIC;
        if (crc8(b, 14, 0x31, 0x00) !== 0)
            return DECODE_FAIL_MIC;
        const magnitude = ((b[4] & 0x07) << 8) | b[5];
        ctx.emit({
            model: 'WS2032',
            type: 'Weather',
            id: ((b[1] << 8) | b[2]).toString(16).toUpperCase().padStart(4, '0'),
            battery_ok: b[3] & 0x01 ? 0 : 1,
            temperature_C: round1((b[4] & 0x08 ? -1 : 1) * magnitude * 0.1),
            humidity: b[6],
            wind_dir_deg: round1((b[4] >> 4) * 22.5),
            wind_avg_km_h: round1(b[7] * 0.43 * 3.6),
            wind_max_km_h: round1(b[8] * 0.43 * 3.6),
            rain: (b[9] << 16) | (b[10] << 8) | b[11],
            flags: (b[3] & 0xfe).toString(16).padStart(2, '0'),
            mic: 'CRC',
        });
        return 1;
    },
});
export const oregonV1 = register({
    num: 50,
    name: 'OSv1 Temperature Sensor',
    what: 'thermometer',
    modulation: 10,
    shortWidth: 1465,
    longWidth: 0,
    syncWidth: 5780,
    gapLimit: 3500,
    resetLimit: 14000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        let events = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 32)
                continue;
            const b = bits.bb[row];
            if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff)
                continue;
            const nib = [];
            let rawCs = 0;
            for (let i = 0; i < 4; i++) {
                const v = reverse8(b[i]);
                nib[i * 2] = v & 0x0f;
                nib[i * 2 + 1] = v >> 4;
                if (i < 3)
                    rawCs += nib[i * 2] + 16 * nib[i * 2 + 1];
            }
            const checksum = nib[6] + (nib[7] << 4);
            const fold = (rawCs & 0xff) + (rawCs >> 8);
            const alt = (rawCs > 0x180 ? rawCs + 1 : rawCs) & 0xff;
            if (!checksum || (checksum !== fold && checksum !== alt))
                continue;
            const magnitude = nib[2] * 0.1 + nib[3] + nib[4] * 10;
            ctx.emit({
                model: 'Oregon-v1',
                type: 'Weather',
                id: nib[0],
                channel: ((nib[1] >> 2) & 0x03) + 1,
                battery_ok: (nib[5] >> 3) & 0x01 ? 0 : 1,
                temperature_C: round1((nib[5] >> 1) & 0x01 ? -magnitude : magnitude),
                mic: 'CHECKSUM',
            });
            events++;
        }
        return events;
    },
});
