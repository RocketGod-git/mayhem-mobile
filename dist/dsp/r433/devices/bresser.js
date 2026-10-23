import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc16, lfsrDigest16 } from '../util.js';
const TYPE_WEATHER = 1, TYPE_LEAKAGE = 5, TYPE_AIR_PM = 8, TYPE_LIGHTNING = 9;
const TYPE_CO2 = 10, TYPE_HCHO_VOC = 11, TYPE_WEATHER3 = 12, TYPE_WEATHER8 = 13;
const PRE_AA_AA_2DD4 = new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]);
const PRE_AA_AA_AA_2DD4 = new Uint8Array([0xaa, 0xaa, 0xaa, 0x2d, 0xd4]);
const round1 = (x) => Math.round(x * 10) / 10;
const bcd2 = (b) => (b >> 4) * 10 + (b & 0x0f);
export const bresser3ch = register({
    num: 52,
    name: 'Bresser Thermo-/Hygro-Sensor 3CH',
    what: 'outdoor temperature and humidity sensor; also the Renkforce DM-7511',
    modulation: 6,
    shortWidth: 250,
    longWidth: 500,
    syncWidth: 750,
    gapLimit: 625,
    resetLimit: 1250,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 40);
        if (r < 0 || bits.bitsPerRow[r] > 42)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        for (let i = 0; i < 5; i++)
            b[i] = ~b[i];
        if (((b[0] + b[1] + b[2] + b[3] - b[4]) & 0xff) !== 0)
            return DECODE_FAIL_MIC;
        const channel = (b[1] & 0x30) >> 4;
        const humidity = b[3];
        const tempF = ((((b[1] & 0x0f) << 8) + b[2]) - 900) * 0.1;
        if (channel === 0 || humidity > 100 || tempF < -20 || tempF > 160)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Bresser-3CH',
            id: b[0],
            channel,
            battery_ok: ((b[1] & 0x80) >> 7) ? 0 : 1,
            temperature_F: round1(tempF),
            humidity,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const bresser5in1 = register({
    num: 119,
    name: 'Bresser Weather Center 5-in-1',
    what: 'outdoor weather mast: wind, rain, temperature, humidity',
    modulation: 16,
    shortWidth: 124,
    longWidth: 124,
    resetLimit: 25000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (bits.numRows !== 1 || n < 248 || n > 440)
            return DECODE_ABORT_EARLY;
        let start = bits.search(0, 0, PRE_AA_AA_AA_2DD4, 40);
        if (start === n)
            return DECODE_ABORT_LENGTH;
        start += 40;
        let len = n - start;
        if (((len + 7) >> 3) < 26)
            return DECODE_ABORT_LENGTH;
        len = Math.min(len, 26 * 8);
        const msg = new Uint8Array(26);
        bits.extractBytes(0, start, msg, len);
        for (let col = 0; col < 13; col++) {
            if ((msg[col] ^ msg[col + 13]) !== 0xff)
                return DECODE_FAIL_MIC;
        }
        const tempOk = (msg[20] & 0x0f) <= 9;
        let tempRaw = (msg[20] & 0x0f) + ((msg[20] & 0xf0) >> 4) * 10 + (msg[21] & 0x0f) * 100;
        if (msg[25] & 0x0f)
            tempRaw = -tempRaw;
        const humidityOk = (msg[22] & 0x0f) <= 9;
        const rainRaw = (msg[23] & 0x0f) + ((msg[23] & 0xf0) >> 4) * 10
            + (msg[24] & 0x0f) * 100 + ((msg[24] & 0xf0) >> 4) * 1000;
        const sensorType = msg[15] & 0x7f;
        const batteryOk = (msg[25] & 0x80) ? 0 : 1;
        if (sensorType >= 0x39 && sensorType <= 0x3b) {
            const out = {
                model: 'Bresser-ProRainGauge',
                id: msg[14],
                battery_ok: batteryOk,
                rain_mm: round1(rainRaw * 0.1 * 2.5),
                mic: 'CHECKSUM',
            };
            if (tempOk)
                out.temperature_C = round1(tempRaw * 0.1);
            ctx.emit(out);
            return 1;
        }
        const out = {
            model: 'Bresser-5in1',
            id: msg[14],
            battery_ok: batteryOk,
            wind_max_m_s: round1((((msg[17] & 0x0f) << 8) + msg[16]) * 0.1),
            wind_avg_m_s: round1(((msg[18] & 0x0f) + ((msg[18] & 0xf0) >> 4) * 10 + (msg[19] & 0x0f) * 100) * 0.1),
            wind_dir_deg: round1(((msg[17] & 0xf0) >> 4) * 22.5),
            rain_mm: round1(rainRaw * 0.1),
            mic: 'CHECKSUM',
        };
        if (tempOk)
            out.temperature_C = round1(tempRaw * 0.1);
        if (humidityOk)
            out.humidity = (msg[22] & 0x0f) + ((msg[22] & 0xf0) >> 4) * 10;
        ctx.emit(out);
        return 1;
    },
});
export const bresser6in1 = register({
    num: 172,
    name: 'Bresser Weather Center 6-in-1, 7-in-1 indoor, soil, new 5-in-1, 3-in-1 wind gauge, Froggit WH6000, Ventus C8488A',
    what: 'weather masts, indoor sensors, pool thermometers and soil probes',
    modulation: 16,
    shortWidth: 124,
    longWidth: 124,
    resetLimit: 25000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (bits.numRows !== 1 || n < 160 || n > 440)
            return DECODE_ABORT_EARLY;
        const start = bits.search(0, 0, PRE_AA_AA_2DD4, 32) + 32;
        if (start >= n)
            return DECODE_ABORT_LENGTH;
        if (n - start < 18 * 8)
            return DECODE_ABORT_LENGTH;
        const msg = new Uint8Array(18);
        bits.extractBytes(0, start, msg, 18 * 8);
        if (((msg[0] << 8) | msg[1]) !== lfsrDigest16(msg, 15, 0x8810, 0x5412, 2))
            return DECODE_FAIL_MIC;
        if ((addBytes(msg, 16, 2) & 0xff) !== 0xff)
            return DECODE_FAIL_MIC;
        const sType = msg[6] >> 4;
        const rainOk = msg[16] & 1;
        const tempOk = msg[12] <= 0x99 && (msg[13] & 0xf0) <= 0x90;
        const tempRaw = (msg[12] >> 4) * 100 + (msg[12] & 0x0f) * 10 + (msg[13] >> 4);
        let tempC = ((msg[13] >> 3) & 1) ? (tempRaw - 1000) * 0.1 : tempRaw * 0.1;
        if (tempC < -50)
            tempC = -tempRaw * 0.1;
        const humidity = bcd2(msg[14]);
        let uvOk = (msg[16] & 0x0f) === 0 && (~msg[15] & 0xff) <= 0x99 && (~msg[16] & 0xf0) <= 0x90;
        const uvRaw = ((~msg[15] & 0xf0) >> 4) * 100 + (~msg[15] & 0x0f) * 10 + ((~msg[16] & 0xf0) >> 4);
        msg[7] ^= 0xff;
        msg[8] ^= 0xff;
        msg[9] ^= 0xff;
        let windOk = msg[7] <= 0x99 && msg[8] <= 0x99 && msg[9] <= 0x99;
        const gustRaw = (msg[7] >> 4) * 100 + (msg[7] & 0x0f) * 10 + (msg[8] >> 4);
        const avgRaw = (msg[9] >> 4) * 100 + (msg[9] & 0x0f) * 10 + (msg[8] & 0x0f);
        const windDir = ((msg[10] & 0xf0) >> 4) * 100 + (msg[10] & 0x0f) * 10 + ((msg[11] & 0xf0) >> 4);
        msg[12] ^= 0xff;
        msg[13] ^= 0xff;
        msg[14] ^= 0xff;
        const rainRaw = (msg[12] >> 4) * 100000 + (msg[12] & 0x0f) * 10000
            + (msg[13] >> 4) * 1000 + (msg[13] & 0x0f) * 100 + (msg[14] >> 4) * 10 + (msg[14] & 0x0f);
        if (sType === 2 || sType === 4) {
            windOk = false;
            uvOk = false;
        }
        const MOISTURE = [0, 7, 13, 20, 27, 33, 40, 47, 53, 60, 67, 73, 80, 87, 93, 99];
        const moisture = sType === 4 && tempOk && humidity >= 1 && humidity <= 16 ? MOISTURE[humidity - 1] : -1;
        const startup = (msg[6] >> 3) & 1;
        const out = {
            model: 'Bresser-6in1',
            id: ((msg[2] << 24) | (msg[3] << 16) | (msg[4] << 8) | msg[5]) >>> 0,
            channel: msg[6] & 0x07,
            sensor_type: sType,
            flags: msg[16] & 0x0f,
            mic: 'CRC',
        };
        if (!rainOk)
            out.battery_ok = (msg[13] >> 1) & 1;
        if (tempOk)
            out.temperature_C = round1(tempC);
        if (tempOk && moisture < 0)
            out.humidity = humidity;
        if (moisture >= 0)
            out.moisture = moisture;
        if (windOk) {
            out.wind_max_m_s = round1(gustRaw * 0.1);
            out.wind_avg_m_s = round1(avgRaw * 0.1);
            out.wind_dir_deg = windDir;
        }
        if (rainOk)
            out.rain_mm = round1(rainRaw * 0.1);
        if (uvOk)
            out.uvi = round1(uvRaw * 0.1);
        if (startup)
            out.startup = startup;
        ctx.emit(out);
        return 1;
    },
});
export const bresser7in1 = register({
    num: 173,
    name: 'Bresser Weather Center 7-in-1, air quality PM2.5/PM10, CO2, HCHO/VOC',
    what: 'weather mast, air quality, carbon dioxide and formaldehyde monitors',
    modulation: 16,
    shortWidth: 124,
    longWidth: 124,
    resetLimit: 25000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (bits.numRows !== 1 || n < 160)
            return DECODE_ABORT_LENGTH;
        const start = bits.search(0, 0, PRE_AA_AA_AA_2DD4, 40) + 40;
        if (start >= n)
            return DECODE_ABORT_EARLY;
        if (start + 21 * 8 >= n)
            return DECODE_ABORT_LENGTH;
        const msg = new Uint8Array(25);
        bits.extractBytes(0, start, msg, 25 * 8);
        if (msg[21] === 0x00)
            return DECODE_FAIL_SANITY;
        const sType = msg[6] >> 4;
        const nstartup = (msg[6] & 0x08) >> 3;
        const chan = msg[6] & 0x07;
        for (let i = 0; i < msg.length; i++)
            msg[i] ^= 0xaa;
        const chk = (msg[0] << 8) | msg[1];
        if ((chk ^ lfsrDigest16(msg, 23, 0x8810, 0xba95, 2)) !== 0x6df1)
            return DECODE_FAIL_MIC;
        const id = (msg[2] << 8) | msg[3];
        const flags = msg[15] & 0x0f;
        const batteryOk = (flags & 0x06) === 0x06 ? 0 : 1;
        const common = { id, battery_ok: batteryOk, mic: 'CRC' };
        const startup = nstartup ? {} : { startup: 1 };
        if (sType === TYPE_WEATHER || sType === TYPE_WEATHER3 || sType === TYPE_WEATHER8) {
            const tempRaw = (msg[14] >> 4) * 100 + (msg[14] & 0x0f) * 10 + (msg[15] >> 4);
            const rainRaw = (msg[10] >> 4) * 100000 + (msg[10] & 0x0f) * 10000 + (msg[11] >> 4) * 1000
                + (msg[11] & 0x0f) * 100 + (msg[12] >> 4) * 10 + (msg[12] & 0x0f);
            const lightRaw = (msg[17] >> 4) * 100000 + (msg[17] & 0x0f) * 10000 + (msg[18] >> 4) * 1000
                + (msg[18] & 0x0f) * 100 + (msg[19] >> 4) * 10 + (msg[19] & 0x0f);
            const out = {
                model: 'Bresser-7in1', ...common, ...startup,
                temperature_C: round1(tempRaw > 600 ? (tempRaw - 1000) * 0.1 : tempRaw * 0.1),
                humidity: bcd2(msg[16]),
                rain_mm: round1(rainRaw * 0.1),
            };
            if (sType !== TYPE_WEATHER3) {
                out.wind_max_m_s = round1(((msg[7] >> 4) * 100 + (msg[7] & 0x0f) * 10 + (msg[8] >> 4)) * 0.1);
                out.wind_avg_m_s = round1(((msg[8] & 0x0f) * 100 + (msg[9] >> 4) * 10 + (msg[9] & 0x0f)) * 0.1);
                out.wind_dir_deg = (msg[4] >> 4) * 100 + (msg[4] & 0x0f) * 10 + (msg[5] >> 4);
                out.light_lux = lightRaw;
                out.uvi = round1(((msg[20] >> 4) * 100 + (msg[20] & 0x0f) * 10 + (msg[21] >> 4)) * 0.1);
            }
            if (sType === TYPE_WEATHER8 && (msg[23] >> 4) < 10) {
                out.temperature_1_C = round1((msg[22] >> 4) * 10 + (msg[22] & 0x0f) + (msg[23] >> 4) * 0.1);
            }
            ctx.emit(out);
            return 1;
        }
        if (sType === TYPE_AIR_PM) {
            const out = { model: 'Bresser-7in1', ...common, channel: chan, ...startup };
            if ((msg[10] & 0x0f) !== 0x0f) {
                out.pm2_5_ug_m3 = (msg[10] & 0x0f) * 1000 + (msg[11] >> 4) * 100 + (msg[11] & 0x0f) * 10 + (msg[12] >> 4);
            }
            if ((msg[12] & 0x0f) !== 0x0f) {
                out.pm10_0_ug_m3 = (msg[12] & 0x0f) * 1000 + (msg[13] >> 4) * 100 + (msg[13] & 0x0f) * 10 + (msg[14] >> 4);
            }
            ctx.emit(out);
            return 1;
        }
        if (sType === TYPE_CO2) {
            const out = { model: 'Bresser-CO2', ...common, channel: chan, ...startup };
            if ((msg[5] & 0x0f) !== 0x0f) {
                out.co2_ppm = ((msg[4] & 0xf0) >> 4) * 1000 + (msg[4] & 0x0f) * 100 + ((msg[5] & 0xf0) >> 4) * 10 + (msg[5] & 0x0f);
            }
            ctx.emit(out);
            return 1;
        }
        if (sType === TYPE_HCHO_VOC) {
            const voc = msg[22] & 0x0f;
            const out = { model: 'Bresser-HCHOVOC', ...common, channel: chan, ...startup };
            if ((msg[5] & 0x0f) !== 0x0f) {
                out.hcho_ppb = ((msg[4] & 0xf0) >> 4) * 1000 + (msg[4] & 0x0f) * 100 + ((msg[5] & 0xf0) >> 4) * 10 + (msg[5] & 0x0f);
            }
            if (voc !== 0x0f)
                out.voc_level = voc;
            ctx.emit(out);
            return 1;
        }
        return DECODE_FAIL_SANITY;
    },
});
export const bresserLightning = register({
    num: 249,
    name: 'Bresser lightning',
    what: 'lightning detector',
    modulation: 16,
    shortWidth: 124,
    longWidth: 124,
    resetLimit: 25000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (bits.numRows !== 1 || n < 112 || n > 440)
            return DECODE_ABORT_EARLY;
        let start = bits.search(0, 0, PRE_AA_AA_2DD4, 32);
        if (start >= n)
            return DECODE_ABORT_LENGTH;
        start += 32;
        if (n - start < 80)
            return DECODE_ABORT_LENGTH;
        const msg = new Uint8Array(10);
        bits.extractBytes(0, start, msg, 80);
        const sType = msg[6] >> 4;
        const chan = msg[6] & 0x07;
        const batteryLow = (msg[5] & 0x08) >> 3;
        const nstartup = (msg[6] & 0x08) >> 3;
        for (let i = 0; i < msg.length; i++)
            msg[i] ^= 0xaa;
        const chk = (msg[0] << 8) | msg[1];
        if ((chk ^ lfsrDigest16(msg, 8, 0x8810, 0xabf9, 2)) !== 0x899e)
            return DECODE_FAIL_MIC;
        if (sType !== TYPE_LIGHTNING || chan !== 0)
            return DECODE_FAIL_SANITY;
        const out = {
            model: 'Bresser-Lightning',
            id: (msg[2] << 8) | msg[3],
            battery_ok: batteryLow ? 0 : 1,
            storm_dist_km: msg[7],
            strike_count: (msg[4] >> 4) * 100 + (msg[4] & 0x0f) * 10 + (msg[5] >> 4),
            unknown1: ((msg[5] & 0x0f) << 8) | msg[6],
            unknown2: (msg[8] << 8) | msg[9],
            mic: 'CRC',
        };
        if (!nstartup)
            out.startup = 1;
        ctx.emit(out);
        return 1;
    },
});
export const bresserLeakage = register({
    num: 247,
    name: 'Bresser water leakage',
    what: 'water leak alarm',
    modulation: 16,
    shortWidth: 124,
    longWidth: 124,
    resetLimit: 25000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (bits.numRows !== 1 || n < 160 || n > 440)
            return DECODE_ABORT_EARLY;
        let start = bits.search(0, 0, PRE_AA_AA_2DD4, 32);
        if (start >= n)
            return DECODE_ABORT_LENGTH;
        start += 32;
        if (n - start < 18 * 8)
            return DECODE_ABORT_LENGTH;
        const msg = new Uint8Array(18);
        bits.extractBytes(0, start, msg, 18 * 8);
        if (((msg[0] << 8) | msg[1]) !== crc16(msg, 5, 0x1021, 0x0000, 2))
            return DECODE_FAIL_MIC;
        const sType = msg[6] >> 4;
        const chan = msg[6] & 0x07;
        const alarm = (msg[7] & 0x80) >> 7;
        const noAlarm = (msg[7] & 0x40) >> 6;
        if (sType !== TYPE_LEAKAGE || alarm === noAlarm || chan === 0)
            return DECODE_FAIL_SANITY;
        const out = {
            model: 'Bresser-Leakage',
            id: ((msg[2] << 24) | (msg[3] << 16) | (msg[4] << 8) | msg[5]) >>> 0,
            channel: chan,
            battery_ok: (msg[7] & 0x30) !== 0x00 ? 1 : 0,
            alarm,
        };
        if (!((msg[6] & 0x08) >> 3))
            out.startup = 1;
        ctx.emit(out);
        return 1;
    },
});
