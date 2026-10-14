import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8 } from '../util.js';
const BANDS = [433920000, 868300000, 915000000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const hex6 = (v) => (v >>> 0).toString(16).padStart(6, '0');
const hex2 = (v) => v.toString(16).padStart(2, '0');
const SYNC24 = new Uint8Array([0xaa, 0x2d, 0xd4]);
const SYNC32 = new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]);
function batteryBars(hi, lo) {
    const bars = ((hi & 0x40) >> 4) | ((lo & 0xc0) >> 6);
    return { bars, level: Math.min(bars * 0.2, 1), extPower: bars === 6 ? 1 : 0 };
}
export const fineoffsetWh43 = register({
    num: 283,
    name: 'Fine Offset WH43 air quality sensor',
    what: 'particulate sensor',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 2500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const at = bits.search(0, 0, SYNC24, 24) + 24;
        if (at + 10 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 10 * 8);
        if (b[0] !== 0x43)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 8, 0x31, 0x00) !== b[8] || (addBytes(b, 9) & 0xff) !== b[9])
            return DECODE_FAIL_MIC;
        const batt = batteryBars(b[4], b[6]);
        ctx.emit({
            model: 'Fineoffset-WH43',
            id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
            battery_ok: batt.bars > 1 ? 1 : 0,
            battery_pct: Math.round(100 * batt.level),
            ext_power: batt.extPower,
            pm2_5_ug_m3: Math.trunc((((b[4] & 0x3f) << 8) | b[5]) / 10),
            estimated_pm10_0_ug_m3: Math.trunc((((b[6] & 0x3f) << 8) | b[7]) / 10),
            mic: 'CRC',
        });
        return 1;
    },
});
export const fineoffsetWh45 = register({
    num: 219,
    name: 'Fine Offset WH45 air quality sensor',
    what: 'particulate and carbon dioxide sensor',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 2500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 170 || n > 240)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC24, 24) + 24;
        if (at + 15 * 8 > n)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 15 * 8);
        if (b[0] !== 0x45)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 13, 0x31, 0x00) !== b[13] || (addBytes(b, 14) & 0xff) !== b[14])
            return DECODE_FAIL_MIC;
        const batt = batteryBars(b[7], b[9]);
        ctx.emit({
            model: 'Fineoffset-WH45',
            id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
            battery_ok: round1(batt.level),
            ext_power: batt.extPower,
            temperature_C: round1(((((b[4] & 0x07) << 8) | b[5]) - 400) * 0.1),
            humidity: b[6],
            pm2_5_ug_m3: round1(((((b[7] & 0x3f) << 8) | b[8])) * 0.1),
            pm10_ug_m3: round1(((((b[9] & 0x3f) << 8) | b[10])) * 0.1),
            co2_ppm: (b[11] << 8) | b[12],
            mic: 'CRC',
        });
        return 1;
    },
});
export const fineoffsetWh46 = register({
    num: 262,
    name: 'Fine Offset WH46 air quality sensor',
    what: 'particulate and carbon dioxide sensor, four particle sizes',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 2500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const at = bits.search(0, 0, SYNC24, 24) + 24;
        if (at + 21 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 21 * 8);
        if (b[0] !== 0x46)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 19, 0x31, 0x00) !== b[19] || (addBytes(b, 20) & 0xff) !== b[20])
            return DECODE_FAIL_MIC;
        const batt = batteryBars(b[7], b[9]);
        const data = {
            model: 'Fineoffset-WH46',
            id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
            battery_ok: batt.bars > 1 ? 1 : 0,
            battery_pct: Math.round(100 * batt.level),
            ext_power: batt.extPower,
            temperature_C: round1(((((b[4] & 0x07) << 8) | b[5]) - 400) * 0.1),
            humidity: b[6],
            pm1_ug_m3: round1(((b[13] << 8) | b[14]) * 0.1),
            pm2_5_ug_m3: round1(((((b[7] & 0x3f) << 8) | b[8])) * 0.1),
            pm4_ug_m3: round1(((b[15] << 8) | b[16]) * 0.1),
            pm10_ug_m3: round1(((((b[9] & 0x3f) << 8) | b[10])) * 0.1),
            co2_ppm: (b[11] << 8) | b[12],
            mic: 'CRC',
        };
        data.unknown1 = (b[17] << 8) | b[18];
        ctx.emit(data);
        return 1;
    },
});
const NO_WIND = 0x1ff, NO_BYTE = 0xff;
export const fineoffsetWs85 = register({
    num: 287,
    name: 'Fine Offset WS85 weather station',
    what: 'outdoor array: wind and rain',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 3000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 168 || n > 500)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC32, 32) + 32;
        if (at + 32 * 8 > n)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 32 * 8);
        if (b[0] !== 0x85)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 26, 0x31, 0x00) !== b[26] || (addBytes(b, 27) & 0xff) !== b[27])
            return DECODE_FAIL_MIC;
        const flags = b[5];
        const windAvg = ((flags & 0x10) << 4) | b[7];
        const windDir = ((flags & 0x20) << 3) | b[8];
        const windMax = ((flags & 0x40) << 2) | b[9];
        const batteryMv = b[4] * 20;
        const supercap = b[17] & 0x3f;
        const data = {
            model: 'Fineoffset-WS85',
            id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
            battery_ok: batteryMv > 2400 ? 1 : 0,
            battery_pct: Math.min(100, batteryMv < 1400 ? 0 : Math.trunc((batteryMv - 1400) / 16)),
            battery_mV: batteryMv,
            flags: hex2(flags),
            rain_mm: round1(((b[15] << 8) | b[16]) * 0.1),
            rain_start: (b[12] & 0x10) >> 4,
            firmware: b[25],
            mic: 'CRC',
        };
        if (windDir !== NO_WIND)
            data.wind_dir_deg = windDir;
        if (windAvg !== NO_WIND)
            data.wind_avg_m_s = round1(windAvg * 0.1);
        if (windMax !== NO_WIND)
            data.wind_max_m_s = round1(windMax * 0.1);
        if (supercap !== NO_BYTE)
            data.supercap_V = round1(supercap * 0.1);
        ctx.emit(data);
        return 1;
    },
});
export const fineoffsetWs90 = register({
    num: 244,
    name: 'Fine Offset WS90 weather station',
    what: 'outdoor array: wind, rain, temperature, humidity, pressure, light and ultraviolet',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 3000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 168 || n > 500)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC32, 32) + 32;
        if (at + 32 * 8 > n)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 32 * 8);
        if (b[0] !== 0x90)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 31, 0x31, 0x00) !== 0 || (addBytes(b, 31) & 0xff) !== b[31])
            return DECODE_FAIL_MIC;
        const flags = b[7];
        const lightRaw = (b[4] << 8) | b[5];
        const batteryMv = b[6] * 20;
        const tempRaw = ((flags & 0x03) << 8) | b[8];
        const windAvg = ((flags & 0x10) << 4) | b[10];
        const windDir = ((flags & 0x20) << 3) | b[11];
        const windMax = ((flags & 0x40) << 2) | b[12];
        const pressure = (b[14] << 8) | b[15];
        const supercap = b[21] & 0x3f;
        const data = {
            model: 'Fineoffset-WS90',
            id: hex6((b[1] << 16) | (b[2] << 8) | b[3]),
            battery_ok: round2(Math.min(100, batteryMv < 1400 ? 0 : Math.trunc((batteryMv - 1400) / 16)) * 0.01),
            battery_mV: batteryMv,
            flags: hex2(flags),
            rain_mm: round1(((b[19] << 8) | b[20]) * 0.1),
            rain_start: (b[16] & 0x10) >> 4,
            firmware: b[29],
            mic: 'CRC',
        };
        if (tempRaw !== 0x3ff)
            data.temperature_C = round1((tempRaw - 400) * 0.1);
        if (b[9] !== NO_BYTE)
            data.humidity = b[9];
        if (pressure !== 0x3fff)
            data.pressure_hPa = pressure;
        if (windDir !== NO_WIND)
            data.wind_dir_deg = windDir;
        if (windAvg !== NO_WIND)
            data.wind_avg_m_s = round1(windAvg * 0.1);
        if (windMax !== NO_WIND)
            data.wind_max_m_s = round1(windMax * 0.1);
        if (b[13] !== NO_BYTE)
            data.uvi = round1(b[13] * 0.1);
        if (lightRaw !== 0xffff)
            data.light_lux = lightRaw * 10;
        if (supercap !== NO_BYTE)
            data.supercap_V = round1(supercap * 0.1);
        ctx.emit(data);
        return 1;
    },
});
const WIND_DIR = [0, 23, 45, 68, 90, 113, 135, 158, 180, 203, 225, 248, 270, 293, 315, 338];
function wh1080Decode(bits, ctx, fsk) {
    if (bits.numRows !== 1)
        return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];
    let br;
    let sensMsg = 10;
    let shortPreamble = false;
    if (fsk) {
        const at = bits.search(0, 0, SYNC24, 24) + 24;
        if (at + 11 * 8 > n)
            return DECODE_ABORT_LENGTH;
        br = bits.bytes(0, at - 8, 11 * 8);
        br[0] = 0xff;
    }
    else if (n >= 88 && n < 100) {
        br = bits.bytes(0, 0, 11 * 8);
    }
    else if (n === 87) {
        shortPreamble = true;
        br = new Uint8Array(11);
        br.set(bits.bytes(0, 7, 10 * 8), 1);
        br[0] = (bits.bb[0][0] >> 1) | 0x80;
    }
    else if (n === 64) {
        sensMsg = 7;
        br = bits.bytes(0, 0, 8 * 8);
    }
    else if (n === 63) {
        shortPreamble = true;
        sensMsg = 7;
        br = new Uint8Array(8);
        br.set(bits.bytes(0, 7, 7 * 8), 1);
        br[0] = (bits.bb[0][0] >> 1) | 0x80;
    }
    else {
        return DECODE_ABORT_LENGTH;
    }
    if (br[0] !== 0xff)
        return DECODE_FAIL_SANITY;
    if (crc8(br, sensMsg === 10 ? 11 : 8, 0x31, 0xff))
        return DECODE_FAIL_MIC;
    const top = br[1] >> 4;
    const msgType = top === 0x0a ? 0 : top === 0x0b ? 1 : top === 0x07 ? 2 : -1;
    if (msgType < 0)
        return DECODE_FAIL_SANITY;
    const id = ((br[1] << 4) & 0xf0) | (br[2] >> 4);
    const two = (v) => ((v & 0xf0) >> 4) * 10 + (v & 0x0f);
    if (msgType === 0) {
        let tempC;
        if (fsk) {
            let raw = ((br[2] & 0x0f) << 8) | br[3];
            if (raw & 0x800)
                raw = -(raw & 0x7ff);
            tempC = raw * 0.1;
        }
        else {
            tempC = ((((br[2] & 0x03) << 8) | br[3]) - 400) * 0.1;
        }
        ctx.emit({
            model: 'Fineoffset-WHx080',
            subtype: msgType,
            id,
            battery_ok: (br[9] >> 4) === 1 ? 0 : 1,
            temperature_C: round1(tempC),
            humidity: br[4],
            wind_dir_deg: WIND_DIR[br[9] & 0x0f],
            wind_avg_km_h: round2(br[5] * 0.34 * 3.6),
            wind_max_km_h: round2(br[6] * 0.34 * 3.6),
            rain_mm: round1((((br[7] & 0x0f) << 8) | br[8]) * 0.3),
            mic: 'CRC',
        });
        return 1;
    }
    if (msgType === 1) {
        const clock = `${2000 + two(br[6])}-${String(((br[7] & 0x10) >> 4) * 10 + (br[7] & 0x0f)).padStart(2, '0')}`
            + `-${String(two(br[8])).padStart(2, '0')}T${String(((br[3] & 0x30) >> 4) * 10 + (br[3] & 0x0f)).padStart(2, '0')}`
            + `:${String(two(br[4])).padStart(2, '0')}:${String(two(br[5])).padStart(2, '0')}`;
        ctx.emit({
            model: 'Fineoffset-WHx080',
            subtype: msgType,
            id,
            signal: (br[2] & 0x0f) === 10 ? 'DCF77' : 'WWVB/MSF',
            radio_clock: clock,
            mic: 'CRC',
        });
        return 1;
    }
    const light = (br[4] << 16) | (br[5] << 8) | br[6];
    ctx.emit({
        model: 'Fineoffset-WHx080',
        subtype: msgType,
        uv_sensor_id: id,
        uv_status: br[3] === 85 ? 'OK' : 'ERROR',
        uv_index: br[2] & 0x0f,
        lux: round1(light * 0.1),
        wm: round2(light / (shortPreamble ? 1265.8 : 6830.0)),
        mic: 'CRC',
    });
    return 1;
}
export const fineoffsetWh1080 = register({
    num: 32,
    name: 'Fine Offset WH1080/WH3080 weather station',
    what: 'outdoor array with an optional light and ultraviolet head',
    modulation: 6,
    shortWidth: 544,
    longWidth: 1524,
    resetLimit: 2800,
    bands: [433920000],
    decode: (_dev, bits, ctx) => wh1080Decode(bits, ctx, false),
});
export const fineoffsetWh1080Fsk = register({
    num: 155,
    name: 'Fine Offset WH1080/WH3080 weather station, frequency shifted',
    what: 'outdoor array with an optional light and ultraviolet head',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 5800,
    bands: [433920000, 868300000],
    decode: (_dev, bits, ctx) => wh1080Decode(bits, ctx, true),
});
