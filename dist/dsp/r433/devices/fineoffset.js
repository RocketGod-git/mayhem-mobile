import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, xorBytes } from '../util.js';
const PREAMBLE = new Uint8Array([0xaa, 0x2d, 0xd4]);
const round1 = (x) => Math.round(x * 10) / 10;
const hex2 = (v) => v.toString(16).padStart(2, '0');
export const fineoffsetWh2 = register({
    num: 18,
    name: 'Fine Offset Electronics WH2, WH5, Telldus temperature/humidity/rain sensor',
    what: 'outdoor thermometer, the older on-off keyed generation',
    modulation: 6,
    shortWidth: 500,
    longWidth: 1500,
    resetLimit: 1200,
    tolerance: 160,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        const row0 = bits.bb[0];
        let b;
        let model;
        if (n === 48 && row0[0] === 0xff) {
            b = bits.bytes(0, 8, 40);
            model = 'Fineoffset-WH2';
        }
        else if (n === 55 && row0[0] === 0xfe) {
            b = bits.bytes(0, 7, 48);
            model = b[3] === 0xff ? 'TFA-303225' : 'Fineoffset-WH2A';
        }
        else if (n === 47 && row0[0] === 0xfe) {
            b = bits.bytes(0, 7, 40);
            model = 'Fineoffset-WH5';
        }
        else if (n === 49 && row0[0] === 0xff && (row0[1] & 0x80) === 0x80) {
            b = bits.bytes(0, 9, 40);
            model = 'Fineoffset-TelldusProove';
        }
        else {
            return DECODE_ABORT_LENGTH;
        }
        if (b[4] !== crc8(b, 4, 0x31, 0))
            return DECODE_FAIL_MIC;
        if (model === 'TFA-303225' && (addBytes(b, 5) & 0xff) !== b[5])
            return DECODE_FAIL_MIC;
        if ((b[0] >> 4) !== 4)
            return DECODE_FAIL_SANITY;
        let temp = ((b[1] & 0x0f) << 8) | b[2];
        let lowBattery = 0;
        if (model === 'TFA-303225') {
            lowBattery = (temp & 0x800) !== 0 ? 1 : 0;
            temp = (temp & 0x7ff) - 400;
        }
        else if (model === 'Fineoffset-WH5') {
            temp -= 400;
        }
        else if (temp & 0x800) {
            temp = -(temp & 0x7ff);
        }
        const temperature = temp * 0.1;
        if (model === 'Fineoffset-WH5' && (temperature < -40 || temperature > 60))
            return DECODE_FAIL_SANITY;
        const humidity = b[3];
        const out = {
            model,
            id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
            temperature_C: round1(temperature),
            mic: 'CRC',
        };
        if (model === 'TFA-303225')
            out.battery_ok = lowBattery ? 0 : 1;
        if (humidity !== 0xff)
            out.humidity = humidity;
        ctx.emit(out);
        return 1;
    },
});
export const fineoffsetWh5rb = register({
    num: 356,
    name: 'Agimex Rosenborg 66796 temperature/humidity sensor',
    what: 'outdoor thermometer sold in Denmark; shares a frame with the WH5',
    modulation: 6,
    shortWidth: 500,
    longWidth: 1500,
    resetLimit: 1200,
    tolerance: 160,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 47 || bits.bb[0][0] !== 0xfe)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, 7, 40);
        if (b[4] !== crc8(b, 4, 0x31, 0))
            return DECODE_FAIL_MIC;
        if ((b[0] >> 4) !== 4)
            return DECODE_FAIL_SANITY;
        let temp = ((b[1] & 0x0f) << 8) | b[2];
        if (temp & 0x800)
            temp = -(temp & 0x7ff);
        const out = {
            model: 'Rosenborg-66796',
            id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
            temperature_C: round1(temp * 0.1),
            mic: 'CRC',
        };
        if (b[3] !== 0xff)
            out.humidity = b[3];
        ctx.emit(out);
        return 1;
    },
});
function payloadStart(bits) {
    const at = bits.search(0, 0, PREAMBLE, 24) + 24;
    return at;
}
function wh24Decode(bits, ctx) {
    const n = bits.bitsPerRow[0];
    if (n < 190 || n > 268)
        return DECODE_ABORT_LENGTH;
    const at = payloadStart(bits);
    if (at + 17 * 8 > n)
        return DECODE_ABORT_LENGTH;
    let model;
    if (n - at - 17 * 8 < 8)
        model = at < 61 ? 'Fineoffset-WH24' : 'Fineoffset-WH65B';
    else
        model = 'Fineoffset-WH65B';
    if (n > 215)
        model = 'Fineoffset-WS69';
    const b = bits.bytes(0, at, 25 * 8);
    if (b[0] !== 0x24)
        return DECODE_FAIL_SANITY;
    if (crc8(b, 16, 0x31, 0x00) !== 0 || addBytes(b, 16) !== b[16])
        return DECODE_FAIL_MIC;
    let pressureHpa = -1;
    if (model === 'Fineoffset-WS69') {
        const raw = (b[17] << 16) | (b[18] << 8) | b[19];
        if (crc8(b, 24, 0x31, 0x00) === 0 && addBytes(b, 24) === b[24] && raw < 0x01ffff) {
            pressureHpa = raw * 0.01;
        }
    }
    const wh24 = model === 'Fineoffset-WH24';
    const windFactor = wh24 ? 1.12 : 0.51;
    const rainPerTip = wh24 ? 0.3 : 0.254;
    const windDir = b[2] | ((b[3] & 0x80) << 1);
    const tempRaw = ((b[3] & 0x07) << 8) | b[4];
    const humidity = b[5];
    const windRaw = b[6] | ((b[3] & 0x10) << 4);
    const gustRaw = b[7];
    const uvRaw = (b[10] << 8) | b[11];
    const lightRaw = (b[12] << 16) | (b[13] << 8) | b[14];
    const UVI_UPPER = [432, 851, 1210, 1570, 2017, 2450, 2761, 3100, 3512, 3918, 4277, 4650, 5029];
    let uvIndex = 0;
    while (uvIndex < 13 && UVI_UPPER[uvIndex] < uvRaw)
        uvIndex++;
    const out = {
        model,
        id: b[1],
        battery_ok: ((b[3] & 0x08) >> 3) ? 0 : 1,
        rain_mm: round1(((b[8] << 8) | b[9]) * rainPerTip),
        mic: 'CRC',
    };
    if (tempRaw !== 0x7ff)
        out.temperature_C = round1((tempRaw - 400) * 0.1);
    if (humidity !== 0xff)
        out.humidity = humidity;
    if (pressureHpa >= 0)
        out.pressure_hPa = Math.round(pressureHpa * 100) / 100;
    if (windDir !== 0x1ff)
        out.wind_dir_deg = windDir;
    if (windRaw !== 0x1ff)
        out.wind_avg_m_s = round1(windRaw * 0.125 * windFactor);
    if (gustRaw !== 0xff)
        out.wind_max_m_s = round1(gustRaw * windFactor);
    if (uvRaw !== 0xffff) {
        out.uv = uvRaw;
        out.uvi = uvIndex;
    }
    if (lightRaw !== 0xffffff)
        out.light_lux = round1(lightRaw * 0.1);
    ctx.emit(out);
    return 1;
}
function wh0290Decode(bits, ctx) {
    const at = payloadStart(bits);
    if (at + 64 > bits.bitsPerRow[0])
        return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, at, 64);
    if (crc8(b, 6, 0x31, 0x00) !== b[6] || (addBytes(b, 7) & 0xff) !== b[7])
        return DECODE_FAIL_MIC;
    const bars = ((b[2] & 0x40) >> 4) | ((b[4] & 0xc0) >> 6);
    ctx.emit({
        model: 'Fineoffset-WH0290',
        id: b[1],
        battery_ok: round1(bars * 0.2),
        pm2_5_ug_m3: (((b[2] & 0x3f) << 8) | b[3]) / 10 | 0,
        estimated_pm10_0_ug_m3: (((b[4] & 0x3f) << 8) | b[5]) / 10 | 0,
        family: b[0],
        unknown1: (b[2] & 0x80) ? 1 : 0,
        mic: 'CRC',
    });
    return 1;
}
export const fineoffsetWh25 = register({
    num: 78,
    name: 'Fine Offset WH25, WH32, WH32B, WN32B, WH24, WH65, WS69, HP1000, Misol WS2320 temperature/humidity/pressure sensor',
    what: 'indoor console sensors and outdoor weather arrays',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 20000,
    bands: [433920000, 868300000, 915000000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        let type = 25;
        if (n < 160)
            return wh0290Decode(bits, ctx);
        if (n < 190)
            type = 32;
        else if (n < 440)
            return wh24Decode(bits, ctx);
        if (n > 510)
            type = 32;
        const at = payloadStart(bits);
        if (at + 64 > n)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 64);
        const msgType = b[0] & 0xf0;
        if (type === 32 && msgType === 0xd0)
            type = 31;
        else if (msgType !== 0xe0) {
            if (b[0] === 0x41)
                return wh0290Decode(bits, ctx);
            return DECODE_ABORT_EARLY;
        }
        if (((addBytes(b, 6) & 0xff) - b[6]) & 0xff)
            return DECODE_FAIL_MIC;
        const bitsum = xorBytes(b, 6);
        if (type === 25 && (((bitsum & 0x0f) << 4) | (bitsum >> 4)) !== b[7])
            return DECODE_FAIL_MIC;
        const tempRaw = ((b[1] & 0x03) << 8) | b[2];
        const pressureRaw = (b[4] << 8) | b[5];
        const out = {
            model: type === 31 ? 'Fineoffset-WH32' : type === 32 ? 'Fineoffset-WH32B' : 'Fineoffset-WH25',
            id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
            battery_ok: ((b[1] & 0x08) >> 3) ? 0 : 1,
            temperature_C: round1((tempRaw - 400) * 0.1),
            humidity: b[3],
            mic: 'CRC',
        };
        if (pressureRaw !== 0xffff)
            out.pressure_hPa = round1(pressureRaw * 0.1);
        ctx.emit(out);
        return 1;
    },
});
export const fineoffsetWh51 = register({
    num: 142,
    name: 'Fine Offset / Ecowitt WH51, WN31, SwitchDoc Labs SM23 soil moisture sensor',
    what: 'soil moisture probe',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 5000,
    bands: [433920000, 915000000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 120)
            return DECODE_ABORT_LENGTH;
        const at = payloadStart(bits);
        if (at + 14 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 14 * 8);
        if (b[0] !== 0x51)
            return DECODE_ABORT_EARLY;
        if ((addBytes(b, 13) & 0xff) !== b[13])
            return DECODE_FAIL_MIC;
        if (crc8(b, 12, 0x31, 0) !== b[12])
            return DECODE_FAIL_MIC;
        const mvBits = b[4] & 0x1f;
        const level = mvBits >= 16 ? 1.0 : mvBits === 15 ? 0.9 : mvBits === 14 ? 0.5 : mvBits === 13 ? 0.1 : 0.0;
        ctx.emit({
            model: 'Fineoffset-WH51',
            id: hex2(b[1]) + hex2(b[2]) + hex2(b[3]),
            battery_ok: level,
            battery_mV: mvBits * 100,
            moisture: b[6],
            boost: (b[4] & 0xe0) >> 5,
            ad_raw: ((b[7] & 0x01) << 8) | b[8],
            mic: 'CRC',
        });
        return 1;
    },
});
function alectoWs1200(bits, ctx, version) {
    const n = bits.bitsPerRow[0];
    const row0 = bits.bb[0];
    const want = version === 1 ? 63 : 95;
    if (n !== want || (row0[0] >> 1) !== 0x7f)
        return DECODE_ABORT_LENGTH;
    if (version === 2 && (row0[1] >> 5) !== 0x3) {
        if ((row0[1] >> 1) !== 0x52)
            return DECODE_ABORT_LENGTH;
        const c = bits.bytes(0, 7, 88);
        if (crc8(c, 10, 0x31, 0) || ((addBytes(c, 10) - c[10]) & 0xff))
            return DECODE_FAIL_MIC;
        const two = (v) => v.toString(16).padStart(2, '0');
        ctx.emit({
            model: 'Alecto-WS1200v2',
            id: c[1],
            battery_ok: ((c[2] >> 7) & 1) ? 0 : 1,
            radio_clock: `${(c[4] + 0x2000).toString(16)}-${two(c[5])}-${two(c[6])}T${two(c[7])}:${two(c[8])}:${two(c[9])}`,
            mic: 'CRC',
        });
        return 1;
    }
    if (version === 1 && (row0[1] >> 5) !== 0x3)
        return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, 7, version === 1 ? 56 : 88);
    if (crc8(b, 7, 0x31, 0))
        return DECODE_FAIL_MIC;
    if (version === 2 && ((addBytes(b, 7) - b[7]) & 0xff))
        return DECODE_FAIL_MIC;
    ctx.emit({
        model: version === 1 ? 'Alecto-WS1200v1' : 'Alecto-WS1200v2',
        id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
        battery_ok: ((b[1] >> 3) & 1) ? 0 : 1,
        temperature_C: round1(((((b[1] & 0x07) << 8) | b[2]) - 400) * 0.1),
        rain_mm: round1(((b[4] << 8) | b[3]) * 0.3),
        mic: 'CRC',
    });
    return 1;
}
export const fineoffsetWh0530 = register({
    num: 79,
    name: 'Fine Offset Electronics WH0530 temperature/rain sensor',
    what: 'rain gauge with a thermometer; also the Alecto WS-1200',
    modulation: 6,
    shortWidth: 504,
    longWidth: 1480,
    resetLimit: 1200,
    tolerance: 160,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n === 63)
            return alectoWs1200(bits, ctx, 1);
        if (n === 95)
            return alectoWs1200(bits, ctx, 2);
        if (n !== 71)
            return DECODE_ABORT_LENGTH;
        const row0 = bits.bb[0];
        if ((row0[0] >> 1) !== 0x7f || (row0[1] >> 5) !== 0x3)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, 7, 64);
        if (crc8(b, 7, 0x31, 0) || ((addBytes(b, 7) - b[7]) & 0xff))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Fineoffset-WH0530',
            id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
            battery_ok: ((b[1] >> 3) & 1) ? 0 : 1,
            temperature_C: round1(((((b[1] & 0x07) << 8) | b[2]) - 400) * 0.1),
            rain_mm: round1(((b[4] << 8) | b[3]) * 0.3),
            mic: 'CRC',
        });
        return 1;
    },
});
