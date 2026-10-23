import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, register, } from '../device.js';
import { addBytes, crc8 } from '../util.js';
const PREAMBLE = new Uint8Array([0xaa, 0x2d, 0xd4]);
const payloadStart = (bits) => bits.search(0, 0, PREAMBLE, 24) + 24;
const BANDS = [433920000, 868300000, 915000000];
export const fineoffsetWh55 = register({
    num: 251,
    name: 'Fine Offset / Ecowitt WH55 water leak sensor',
    what: 'water leak detector',
    modulation: 16,
    shortWidth: 60,
    longWidth: 60,
    resetLimit: 2500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const at = bits.search(0, 0, new Uint8Array([0xaa, 0x2d, 0xd4, 0x55]), 32) + 24;
        if (at + 9 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, at, 12 * 8);
        if (crc8(b, 9, 0x31, 0x00))
            return DECODE_FAIL_MIC;
        const data = {
            model: 'Fineoffset-WH55',
            id: ((b[2] << 8) | b[3]).toString(16).padStart(5, '0'),
            channel: (b[1] >> 4) + 1,
            battery_ok: b[4] * 0.2,
            raw_value: (b[5] << 8) | b[6],
            sensitivity: (b[7] >> 7) & 1,
            alarm: (b[7] >> 6) & 1,
            mic: 'CRC',
        };
        ctx.emit(data);
        return 1;
    },
});
export const fineoffsetWn34 = register({
    num: 221,
    name: 'Fine Offset WN34S/L/D, WN38, Froggit DP150/D35 temperature sensor',
    what: 'probe thermometer for a pool, a fridge or a compost heap',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 2500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const at = payloadStart(bits);
        if (at + 9 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 9 * 8);
        if (b[0] !== 0x34 && b[0] !== 0x38)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 7, 0x31, 0x00) !== b[7] || (addBytes(b, 8) & 0xff) !== b[8])
            return DECODE_FAIL_MIC;
        const subType = (b[4] & 0xf0) >> 4;
        const raw = ((((b[4] & 0x0f) << 12) | (b[5] << 4)) << 16) >> 16;
        const tempC = subType === 4 ? (raw >> 4) * 0.1 : (raw >> 4) * 0.1 - 40;
        const batteryMv = (b[6] & 0x7f) * 20;
        const bars = batteryMv > 1440 ? 5 : batteryMv > 1380 ? 4 : batteryMv > 1300 ? 3 : batteryMv > 1200 ? 2 : 1;
        ctx.emit({
            model: b[0] === 0x38 ? 'Fineoffset-WN38' : subType === 4 ? 'Fineoffset-WN34D' : 'Fineoffset-WN34',
            id: ((b[1] << 16) | (b[2] << 8) | b[3]).toString(16),
            battery_ok: (bars - 1) * 0.25,
            battery_mV: batteryMv,
            temperature_C: Math.round(tempC * 10) / 10,
            mic: 'CRC',
        });
        return 1;
    },
});
export const fineoffsetWh52 = register({
    num: 353,
    name: 'Fine Offset / Ecowitt WH52 soil moisture, temperature and conductivity sensor',
    what: 'soil probe',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 5000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 200)
            return DECODE_ABORT_LENGTH;
        const at = payloadStart(bits);
        if (at + 24 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 24 * 8);
        if (b[0] !== 0xa2)
            return DECODE_ABORT_EARLY;
        if ((addBytes(b, 23) & 0xff) !== b[23])
            return DECODE_FAIL_MIC;
        if (crc8(b, 22, 0x31, 0x00) !== b[22])
            return DECODE_FAIL_MIC;
        const batteryMv = b[20] * 20;
        const level = Math.max(0, Math.min(1, (batteryMv - 1300) / 300));
        ctx.emit({
            model: 'Fineoffset-WH52',
            id: `${b[1].toString(16).padStart(2, '0')}${b[2].toString(16).padStart(2, '0')}${b[3].toString(16).padStart(2, '0')}`,
            temperature_C: Math.round((((((b[4] & 0x1f) << 8) | b[5]) * 0.1) - 40) * 10) / 10,
            moisture: b[6],
            conductivity_uS_cm: Math.round((((b[8] & 0x0f) << 16) | (b[9] << 8) | b[10]) / 25.6),
            battery_ok: Math.round(level * 100) / 100,
            battery_mV: batteryMv,
            boost: (b[4] & 0xe0) >> 5,
            mic: 'CRC',
        });
        return 1;
    },
});
export const fineoffsetWh31l = register({
    num: 190,
    name: 'Ambient Weather WH31L / Fine Offset WH57 lightning sensor',
    what: 'lightning detector',
    modulation: 16,
    shortWidth: 56,
    longWidth: 56,
    resetLimit: 1000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const start = bits.search(0, 0, PREAMBLE, 24);
        if (start === bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, start + 24, 9 * 8);
        if (b[0] !== 0x57)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 8, 0x31, 0x00))
            return DECODE_FAIL_MIC;
        if (((addBytes(b, 8) - b[8]) & 0xff) !== 0)
            return DECODE_FAIL_MIC;
        const state = b[1] >> 4;
        const dist = b[5] & 0x3f;
        const data = {
            model: 'Fineoffset-WH31L',
            id: ((b[1] & 0x0f) << 16) | (b[2] << 8) | b[3],
            battery_ok: ((b[4] & 0x06) >> 1) * 0.5,
            state: state === 0 ? 'reset' : state === 1 ? 'interference' : state === 4 ? 'noise' : state === 8 ? 'strike' : 'unknown',
            flags: ((state << 12) | (b[4] << 4) | (b[5] >> 4)).toString(16).padStart(4, '0'),
            strike_count: b[6],
            mic: 'CRC',
        };
        if (dist !== 63)
            data.storm_dist = dist;
        ctx.emit(data);
        return 1;
    },
});
export const fineoffsetWs80 = register({
    num: 213,
    name: 'Fine Offset Electronics WS80 weather station',
    what: 'outdoor array: wind, temperature, humidity, light and ultraviolet',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 1500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 168 || n > 240)
            return DECODE_ABORT_LENGTH;
        const at = payloadStart(bits);
        if (at + 18 * 8 > n)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 18 * 8);
        if (b[0] !== 0x80)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 17, 0x31, 0x00) !== 0 || (addBytes(b, 17) & 0xff) !== b[17])
            return DECODE_FAIL_MIC;
        const flags = b[7];
        const lightRaw = (b[4] << 8) | b[5];
        const batteryMv = b[6] * 20;
        const tempRaw = ((flags & 0x03) << 8) | b[8];
        const windAvg = ((flags & 0x10) << 4) | b[10];
        const windDir = ((flags & 0x20) << 3) | b[11];
        const windMax = ((flags & 0x40) << 2) | b[12];
        const unknown = (b[14] << 8) | b[15];
        const data = {
            model: 'Fineoffset-WS80',
            id: ((b[1] << 16) | (b[2] << 8) | b[3]).toString(16).padStart(6, '0'),
            battery_ok: (batteryMv < 1400 ? 0 : Math.floor((batteryMv - 1400) / 16)) * 0.01,
            battery_mV: batteryMv,
            flags: flags.toString(16).padStart(2, '0'),
            mic: 'CRC',
        };
        if (tempRaw !== 0x3ff)
            data.temperature_C = Math.round((tempRaw - 400) * 0.1 * 10) / 10;
        if (b[9] !== 0xff)
            data.humidity = b[9];
        if (windDir !== 0x1ff)
            data.wind_dir_deg = windDir;
        if (windAvg !== 0x1ff)
            data.wind_avg_m_s = Math.round(windAvg * 0.1 * 10) / 10;
        if (windMax !== 0x1ff)
            data.wind_max_m_s = Math.round(windMax * 0.1 * 10) / 10;
        if (b[13] !== 0xff)
            data.uvi = Math.round(b[13] * 0.1 * 10) / 10;
        if (lightRaw !== 0xffff)
            data.light_lux = lightRaw * 10;
        if (unknown !== 0x3fff)
            data.unknown1 = unknown;
        ctx.emit(data);
        return 1;
    },
});
