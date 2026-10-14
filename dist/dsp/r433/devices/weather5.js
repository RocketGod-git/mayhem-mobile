import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, crc16, crc16lsb, extractBytesUart8n1, lfsrDigest8Reflect, xorBytes, } from '../util.js';
const BAND_433 = [433920000];
const BAND_VEVOR = [868300000, 915000000];
const BAND_GARDEN = [433920000, 434570000];
const round1 = (x) => Math.round(x * 10) / 10;
const s16 = (v) => (v << 16) >> 16;
const hex2 = (v) => (v & 0xff).toString(16).padStart(2, '0');
const hexOf = (b, n, at = 0) => {
    let s = '';
    for (let i = 0; i < n; i++)
        s += hex2(b[at + i] ?? 0);
    return s;
};
const WIND_DIR_DEG = [0, 23, 45, 68, 90, 113, 135, 158, 180, 203, 225, 248, 270, 293, 315, 338];
export const holmanWs5029pcm = register({
    num: 134,
    name: 'AOK Weather Station rebrand Holman Industries iWeather WS5029, Conrad AOK-5056, Optex 990018',
    what: 'weather station: temperature, humidity, rain, wind, and UV on some builds',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 19200,
    bands: [917000000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < 192)
            return DECODE_ABORT_LENGTH;
        const preamble = new Uint8Array([0xaa, 0xaa, 0xaa, 0x98, 0xf3, 0xa5]);
        const pos = bits.search(0, 0, preamble, 48);
        if (pos >= rowBits)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, pos + 48, 18 * 8);
        const folded = new Uint8Array([xorBytes(b, 12)]);
        if (lfsrDigest8Reflect(folded, 1, 0x00, 0x31) !== b[12])
            return DECODE_FAIL_MIC;
        const id = (b[0] << 8) | b[1];
        const tempC = round1((s16((b[2] << 8) | (b[3] & 0xf0)) >> 4) * 0.1);
        const humidity = ((b[3] & 0x0f) << 4) | ((b[4] & 0xf0) >> 4);
        const rainRaw = ((b[4] & 0x0f) << 8) | b[5];
        const windAvg = b[6];
        const windDir = WIND_DIR_DEG[(b[7] & 0xf0) >> 4];
        const lux = ((b[8] & 0x7f) << 10) | (b[9] << 2) | ((b[10] & 0xc0) >> 6);
        if (rowBits < 200 && lux === 0) {
            ctx.emit({
                model: 'Holman-WS5029',
                type: 'Weather',
                id,
                temperature_C: tempC,
                humidity,
                rain_mm: round1(rainRaw * 0.79),
                wind_avg_km_h: round1(windAvg),
                wind_dir_deg: windDir,
                mic: 'CHECKSUM',
            });
            return 1;
        }
        if (rowBits < 221) {
            ctx.emit({
                model: 'AOK-5056',
                type: 'Weather',
                id,
                temperature_C: tempC,
                humidity,
                rain_mm: round1(rainRaw),
                wind_avg_km_h: round1(windAvg),
                wind_dir_deg: windDir,
                uvi: ((b[7] & 0x07) << 1) | ((b[8] & 0x80) >> 7),
                light_lux: lux,
                counter: ((b[10] & 0x0f) << 8) | b[11],
                battery_ok: ((b[10] & 0x30) >> 4) ? 0 : 1,
                mic: 'CHECKSUM',
            });
            return 1;
        }
        return DECODE_FAIL_OTHER;
    },
});
function xorShiftBytes(m, numBytes, shiftUp) {
    let result0 = 0;
    for (let i = 0; i < numBytes; i += 2)
        result0 ^= m[i];
    let result1 = 0;
    for (let i = 1; i < numBytes; i += 2)
        result1 ^= m[i];
    let resultx = 0;
    for (let j = 0; j < 7; j++) {
        if (shiftUp & (1 << j))
            resultx ^= (result0 << (j + 1)) & 0xff;
    }
    return (result0 ^ result1 ^ resultx) & 0xff;
}
function holmanPwmDecode(bits, ctx) {
    const row = bits.findRepeatedRow(3, 96);
    if (row < 0 || bits.bitsPerRow[row] !== 96)
        return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];
    if (b[0] !== 0x55 || b[1] !== 0x5a || b[2] !== 0x67)
        return DECODE_FAIL_SANITY;
    bits.invert();
    if (xorShiftBytes(b, 10, 0x18) !== b[10])
        return DECODE_FAIL_MIC;
    const tempRaw = (((b[4] & 0x0f) << 12) | (b[5] << 4)) & 0xffff;
    const windDir = b[9] & 0x0f;
    ctx.emit({
        model: 'Holman-WS5029',
        type: 'Weather',
        id: b[3],
        battery_ok: (b[4] & 0x80) ? 0 : 1,
        temperature_C: round1((tempRaw >> 4) * 0.1),
        humidity: b[6],
        rain_mm: round1(((b[7] << 4) + (b[8] >> 4)) * 0.79),
        wind_avg_km_h: round1(((b[8] & 0x0f) << 4) + (b[9] >> 4)),
        wind_dir_deg: Math.trunc(windDir * 22.5),
        mic: 'CHECKSUM',
    });
    return 1;
}
export const holmanWs5029pwm = register({
    num: 143,
    name: 'Holman Industries iWeather WS5029 weather station (older PWM)',
    what: 'weather station: temperature, humidity, rain and wind',
    modulation: 17,
    shortWidth: 488,
    longWidth: 976,
    gapLimit: 2000,
    resetLimit: 6000,
    bands: BAND_433,
    decode: (_dev, bits, ctx) => holmanPwmDecode(bits, ctx),
});
export const holmanWs5029pwmOok = register({
    num: 340,
    name: 'Holman Industries iWeather WS5029 weather station (older PWM, OOK), BIOWIN 270208',
    what: 'weather station: temperature, humidity, rain and wind',
    modulation: 6,
    shortWidth: 488,
    longWidth: 976,
    gapLimit: 2000,
    resetLimit: 6000,
    bands: BAND_433,
    decode: (_dev, bits, ctx) => holmanPwmDecode(bits, ctx),
});
export const cotech367959 = register({
    num: 153,
    name: 'Cotech 36-7959, SwitchDocLabs FT020T wireless weather station with USB',
    what: 'weather station: temperature, humidity, rain, wind, light and UV',
    modulation: 3,
    shortWidth: 500,
    longWidth: 0,
    gapLimit: 1200,
    resetLimit: 1200,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 2)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 112 && bits.bitsPerRow[1] < 112)
            return DECODE_ABORT_EARLY;
        const preamble = new Uint8Array([0x01, 0x40]);
        let b;
        for (let i = 0; i < bits.numRows; i++) {
            const pos = bits.search(i, 0, preamble, 12) + 12;
            if (pos + 112 > bits.bitsPerRow[i])
                continue;
            b = bits.bytes(i, pos, 112);
            break;
        }
        if (!b)
            return DECODE_FAIL_SANITY;
        if (crc8(b, 14, 0x31, 0xc0) !== 0)
            return DECODE_FAIL_MIC;
        const windDir = (((b[1] & 0x04) >> 2) << 8) | b[4];
        const gust = (((b[1] & 0x02) >> 1) << 8) | b[3];
        const windAvg = ((b[1] & 0x01) << 8) | b[2];
        const uvi = b[12];
        const lightValid = uvi <= 150;
        const data = {
            model: 'Cotech-367959',
            type: 'Weather',
            id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
            battery_ok: ((b[1] & 0x08) >> 3) ? 0 : 1,
            temperature_F: round1((((b[7] & 0x0f) << 8 | b[8]) - 400) * 0.1),
            humidity: b[9],
            rain_mm: round1((((b[5] & 0x0f) << 8) | b[6]) * 0.1),
            wind_dir_deg: windDir,
            wind_avg_m_s: round1(windAvg * 0.1),
            wind_max_m_s: round1(gust * 0.1),
            mic: 'CRC',
        };
        if (lightValid) {
            data.light_lux = (b[10] << 8) | b[11] | ((b[7] & 0x80) << 9);
            data.uvi = round1(uvi * 0.1);
        }
        ctx.emit(data);
        return 1;
    },
});
export const cotechFt0203 = register({
    num: 369,
    name: 'Cotech FT0203/18-3676 anemometer',
    what: 'anemometer: wind speed, gust and direction',
    modulation: 3,
    shortWidth: 500,
    longWidth: 0,
    resetLimit: 1200,
    bands: BAND_433,
    disabled: true,
    decode(_dev, bits, ctx) {
        const b = new Uint8Array(9);
        for (let row = 0; row < bits.numRows; row++) {
            const rowBits = bits.bitsPerRow[row];
            for (let pos = 0; pos + 72 <= rowBits; pos++) {
                bits.extractBytes(row, pos, b, 72);
                if (b[0] !== 0x14 || b[6] !== 0xff || b[7] !== 0xff)
                    continue;
                if (crc8(b, 9, 0x31, 0xc0) !== 0)
                    continue;
                ctx.emit({
                    model: 'Cotech-FT0203',
                    type: 'Weather',
                    id: (b[1] << 3) | (b[2] >> 5),
                    battery_ok: (b[2] >> 4) & 0x01,
                    wind_dir_deg: (((b[2] >> 2) & 0x01) << 8) | b[5],
                    wind_avg_m_s: round1(((b[2] & 0x01) << 8 | b[3]) * 0.1),
                    wind_max_m_s: round1((((b[2] >> 1) & 0x01) << 8 | b[4]) * 0.1),
                    mic: 'CRC',
                });
                return 1;
            }
        }
        return DECODE_FAIL_SANITY;
    },
});
export const cotech367900 = register({
    num: 382,
    name: 'Cotech 36-7900 rain gauge',
    what: 'rain gauge with a thermometer',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3500,
    resetLimit: 4500,
    bands: BAND_433,
    disabled: true,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(8, 60);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 60)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(row, 0, 60);
        if (b[0] !== 0xab || (b[1] >> 4) !== 0x8)
            return DECODE_ABORT_EARLY;
        if (b[3] !== 0x00 || b[4] !== 0x00 || b[5] !== 0x00)
            return DECODE_FAIL_MIC;
        let tempRaw = ((b[1] & 0x0f) << 8) | b[2];
        if (tempRaw & 0x800)
            tempRaw -= 0x1000;
        ctx.emit({
            model: 'Cotech-367900',
            type: 'Weather',
            id: (b[0] << 8) | b[1],
            temperature_C: round1(tempRaw * 0.1),
            rain_raw: (b[6] << 4) | (b[7] >> 4),
        });
        return 1;
    },
});
export const vevor7in1 = register({
    num: 263,
    name: 'Vevor Wireless Weather Station 7-in-1',
    what: 'weather station: temperature, humidity, rain, wind, light and UV',
    modulation: 16,
    shortWidth: 87,
    longWidth: 87,
    resetLimit: 9000,
    bands: BAND_VEVOR,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const preamble = new Uint8Array([0xaa, 0xaa, 0xca, 0xca, 0x54]);
        const rowBits = bits.bitsPerRow[0];
        let ret = DECODE_FAIL_OTHER;
        let pos = 0;
        for (;;) {
            pos = bits.search(0, pos, preamble, 40);
            if (pos + 264 > rowBits)
                break;
            pos += 40;
            if (pos + 21 * 8 > rowBits) {
                ret = DECODE_ABORT_LENGTH;
                continue;
            }
            const b = bits.bytes(0, pos, 21 * 8);
            if (addBytes(b, 19) !== b[19]) {
                ret = DECODE_FAIL_MIC;
                continue;
            }
            if (b[0] === 0xaa && b[1] === 0) {
                let lux = ((b[16] << 8) | b[17]) - 257;
                if ((lux & 0x8000) >> 15)
                    lux = (lux & 0x7fff) * 10;
                ctx.emit({
                    model: 'Vevor-7in1',
                    type: 'Weather',
                    id: (b[2] << 8) | b[3],
                    channel: b[1] & 0x0f,
                    battery_ok: ((b[4] & 0x80) >> 7) ? 0 : 1,
                    temperature_C: round1((((b[5] << 8) | b[6]) - 500) * 0.1),
                    humidity: b[7],
                    wind_avg_km_h: round1((((b[8] << 8) | b[9]) - 257) / 8.333),
                    wind_max_km_h: round1(b[10] / 1.25),
                    wind_dir_deg: (((b[11] & 0x0f) << 8) | b[12]) - 257,
                    rain_mm: round1(((((b[13] << 8) | b[14]) - 257)) * 0.233),
                    uvi: (b[15] & 0x1f) - 1,
                    light_lux: lux,
                    mic: 'CHECKSUM',
                });
                return 1;
            }
            pos += 264;
        }
        return ret;
    },
});
export const sainlogicSa8 = register({
    num: 293,
    name: 'Sainlogic SA8, Gevanti SA8 Weather Station',
    what: 'weather station: temperature, humidity, rain and wind',
    modulation: 4,
    shortWidth: 200,
    longWidth: 200,
    resetLimit: 2500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        const offset = bits.search(0, 0, new Uint8Array([0xfc, 0x95]), 16) + 16;
        if (offset >= rowBits)
            return DECODE_ABORT_EARLY;
        const b = new Uint8Array(41);
        const numBits = Math.min(rowBits - offset, b.length * 10);
        if (extractBytesUart8n1(bits.bb[0], offset, numBits, b) < 41)
            return DECODE_ABORT_LENGTH;
        const crcOk = crc16lsb(b, 36, 0xa001, 0xffff, 3) === ((b[39] << 8) | b[40]);
        ctx.emit({
            model: 'Sainlogic-SA8',
            type: 'Weather',
            id: hexOf(Uint8Array.from([b[4], b[3], b[6], b[5], b[8], b[7]]), 6),
            battery_ok: (b[38] & 0x10) >> 4,
            counter: (b[16] << 8) | b[15],
            temperature_C: round1(s16((b[20] << 8) | b[19]) * 0.1),
            humidity: b[21],
            wind_avg_km_h: round1(((b[30] << 8) | b[29]) * 0.036),
            wind_max_km_h: round1(((b[28] << 8) | b[27]) * 0.036),
            wind_dir_deg: (b[32] << 8) | b[31],
            rain_mm: round1(((b[34] << 8) | b[33]) * 0.42893617),
            unknown: (b[36] << 8) | b[35],
            flags: (b[38] << 8) | b[37],
            crc_ok: crcOk ? 1 : 0,
            ...(crcOk ? { mic: 'CRC' } : {}),
        });
        return 1;
    },
});
function bresserGardenModel(sourceId) {
    switch (sourceId >>> 24) {
        case 0x47: return 'Bresser-SoilMoisture';
        case 0x1f: return 'Bresser-WaterTimer';
        case 0x01: return 'Bresser-Gateway';
        default: return 'Bresser-Garden';
    }
}
export const bresserGarden = register({
    num: 384,
    name: 'Bresser SmartHome Garden soil moisture and water timer valve (Baldr Homgar, RainPoint)',
    what: 'garden irrigation set: soil moisture, water timer valve and gateway',
    modulation: 16,
    shortWidth: 50,
    longWidth: 50,
    resetLimit: 10000,
    bands: BAND_GARDEN,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_FAIL_SANITY;
        const msgLen = bits.bitsPerRow[0];
        if (msgLen > 2000)
            return DECODE_ABORT_LENGTH;
        const preamble = new Uint8Array([0xaa, 0xf3, 0xe9, 0x10, 0x5e, 0x51]);
        let offset = bits.search(0, 0, preamble, 48);
        if (offset >= msgLen)
            return DECODE_ABORT_EARLY;
        offset += 48;
        if (msgLen - offset < 33 * 8)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, offset, 33 * 8);
        if (crc16(b, 33, 0x1021, 0xd636) !== 0)
            return DECODE_FAIL_MIC;
        const targetId = ((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0;
        const sourceId = ((b[7] << 24) | (b[6] << 16) | (b[5] << 8) | b[4]) >>> 0;
        const counter = b[8];
        const msgType = b[9];
        const msgLength = b[10];
        const acknowledgement = msgType >> 7;
        const model = bresserGardenModel(sourceId);
        if (msgLength > 20)
            return DECODE_FAIL_SANITY;
        const payloadHex = () => hexOf(b, Math.min(msgLength, 20), 11);
        const base = { model, type: 'Weather', id: sourceId, msg_counter: counter, mic: 'CRC' };
        if (msgType === 0x01 && (msgLength === 0x07 || msgLength === 0x08)) {
            ctx.emit({
                ...base, msg_name: 'Init Pairing', target_id: targetId,
                device_type: b[11], firmware: b[17], msg_type: msgType, msg_length: msgLength, msg: payloadHex(),
            });
            return 1;
        }
        if (msgType === 0x81 && msgLength === 0x10) {
            ctx.emit({
                ...base, msg_name: 'Pairing ack', target_id: targetId, acknowledgement,
                msg_type: msgType, msg_length: msgLength, msg: payloadHex(),
            });
            return 1;
        }
        if (msgType === 0x03 && msgLength === 0x07) {
            ctx.emit({
                ...base, msg_name: 'Soil telemetry', station_id: targetId, device_type: b[11],
                msg_type: msgType,
                temperature_F: round1(s16((b[17] << 8) | b[16]) * 0.1),
                moisture: b[14],
                battery_ok: ((b[12] & 0x10) >> 4) ? 0 : 1,
                battery_level: b[12] & 0x0f,
            });
            return 1;
        }
        if ((msgType === 0x83 || msgType === 0x84 || msgType === 0x89 || msgType === 0x8a) && msgLength === 0x01) {
            ctx.emit({
                ...base, msg_name: 'Acknowledgement', target_id: targetId, acknowledgement,
                msg_type: msgType, msg_length: msgLength,
            });
            return 1;
        }
        if (msgType === 0x0a && msgLength === 0x09) {
            ctx.emit({
                ...base, msg_name: 'Relay telemetry', station_id: targetId, device_type: b[11],
                sensor_number: b[12], msg_type: msgType,
                temperature_F: round1(s16((b[19] << 8) | b[18]) * 0.1),
                moisture: b[16],
                soil_rssi: b[13],
                battery_ok: ((b[14] & 0x10) >> 4) ? 0 : 1,
                battery_level: b[14] & 0x0f,
            });
            return 1;
        }
        if (msgType === 0x09 && msgLength === 0x09) {
            ctx.emit({
                ...base, msg_name: 'Soil telemetry', station_id: targetId, device_type: b[11],
                sensor_number: b[12], msg_type: msgType,
                temperature_F: round1(s16((b[19] << 8) | b[18]) * 0.1),
                moisture: b[16],
                battery_ok: ((b[14] & 0x10) >> 4) ? 0 : 1,
                battery_level: b[14] & 0x0f,
            });
            return 1;
        }
        if (msgType === 0x04 && msgLength === 0x0e) {
            ctx.emit({
                ...base, msg_name: 'Watering', station_id: targetId, sensor_number: b[11], msg_type: msgType,
                programme: (b[14] << 8) | b[15],
                cycle_counter: b[16] | (b[17] << 8),
                trigger: b[18],
                water_usage_l: round1((b[19] | (b[20] << 8)) * 0.1),
                duration_s: b[23] | (b[24] << 8),
            });
            return 1;
        }
        if (msgType === 0x85 && msgLength === 0x0f) {
            ctx.emit({
                ...base, msg_name: 'Schedule config', target_id: targetId, sensor_number: b[18], msg_type: msgType,
                default_duration_s: b[12] | (b[13] << 8),
                mist_run_s: b[14] | (b[15] << 8),
                mist_interval_s: b[16] | (b[17] << 8),
                stop_moisture: b[19],
                flow_rate: (b[24] << 24) >> 24,
                unknown: b[22],
            });
            return 1;
        }
        if (msgType === 0x20 && (msgLength === 0x02 || msgLength === 0x03)) {
            const hasChannel = msgLength === 0x03 && b[12] === 0x04;
            ctx.emit({
                ...base, msg_name: 'Config change', target_id: targetId, msg_type: msgType, config_counter: b[11],
                ...(hasChannel ? { rf_channel: b[13] } : {}),
            });
            return 1;
        }
        if (msgType === 0x86 && (msgLength === 0x08 || msgLength === 0x0f)) {
            const dayMode = ['unknown', 'every day', 'odd days', 'even days', 'weekly', 'unknown', 'unknown', 'unknown'];
            const plans = [];
            const nPlans = ((msgLength - 1) / 7) | 0;
            for (let p = 0; p < nPlans && plans.length < 2 && (12 + p * 7 + 6) < 33; p++) {
                const at = 12 + p * 7;
                plans.push({
                    model,
                    plan: plans.length + 1,
                    enabled: (b[at] & 0x80) ? 1 : 0,
                    irrigation: (b[at + 2] & 0x80) ? 'misting' : 'normal',
                    start_hour: ((b[at + 2] & 0x07) << 2) | (b[at + 1] >> 6),
                    start_minute: b[at + 1] & 0x3f,
                    day_mode: dayMode[(b[at + 2] >> 3) & 0x07],
                    weekday_mask: b[at] & 0x7f,
                    duration_s: b[at + 3] | (b[at + 4] << 8),
                    water_limit_l: round1((b[at + 5] | (b[at + 6] << 8)) / 10),
                });
            }
            ctx.emit({
                ...base, msg_name: 'Schedule', target_id: targetId, msg_type: msgType,
                more_parts: b[11] ? 1 : 0, plans,
            });
            return 1;
        }
        if (msgType === 0x21 && msgLength >= 0x03) {
            const variant = b[12];
            const mode = b[13];
            let durationS = msgLength >= 0x04 ? b[14] : 0;
            if (msgLength >= 0x05)
                durationS |= b[15] << 8;
            const isRun = variant === 0x02;
            ctx.emit({
                ...base,
                msg_name: !isRun ? 'Heartbeat' : (mode === 0 ? 'Run stop' : 'Run start'),
                target_id: targetId, msg_type: msgType,
                ...(isRun ? { mode } : {}),
                ...(isRun && msgLength >= 0x04 ? { duration_s: durationS } : {}),
                ...(!isRun && msgLength >= 0x04 ? { heartbeat_interval_s: durationS } : {}),
                msg: payloadHex(),
            });
            return 1;
        }
        if (msgType === 0xa1 || msgType === 0xa0) {
            const hasRun = msgType === 0xa1 && msgLength >= 0x0d
                && b[13] === 0x9f && b[18] === 0x81 && b[21] === 0xad;
            ctx.emit({
                ...base,
                msg_name: msgType === 0xa0 ? 'Acknowledgement' : (hasRun ? 'Run response' : 'Beacon'),
                target_id: targetId, msg_type: msgType, acknowledgement,
                ...(hasRun ? {
                    trigger: b[12],
                    duration_s: b[22] | (b[23] << 8),
                    remaining_s: b[19] | (b[20] << 8),
                    water_usage_l: round1((b[14] | (b[15] << 8)) * 0.1),
                } : {}),
                msg: payloadHex(),
            });
            return 1;
        }
        if (msgType === 0x82 && msgLength >= 0x02) {
            ctx.emit({
                ...base, msg_name: 'Status response', target_id: targetId, msg_type: msgType, config_counter: b[12],
                ...(msgLength >= 0x05 ? { gateway_time: (b[13] | (b[14] << 8) | (b[15] << 16)) >>> 0 } : {}),
                msg: payloadHex(),
            });
            return 1;
        }
        if (msgType === 0x88 && msgLength >= 0x03) {
            ctx.emit({
                ...base, msg_name: 'Moisture response', target_id: targetId, msg_type: msgType,
                moisture: b[13], msg: payloadHex(),
            });
            return 1;
        }
        if (msgType === 0x02 || msgType === 0x05 || msgType === 0x06 || msgType === 0x08) {
            const hasRun = msgType === 0x02 && msgLength >= 0x0f && b[20] === 0x81 && b[23] === 0xad;
            ctx.emit({
                ...base,
                msg_name: msgType === 0x02 ? 'Status report'
                    : msgType === 0x05 ? 'Config request'
                        : msgType === 0x08 ? 'Moisture request' : 'Schedule request',
                target_id: targetId, msg_type: msgType, msg_length: msgLength,
                ...(hasRun ? {
                    trigger: b[14],
                    duration_s: b[24] | (b[25] << 8),
                    remaining_s: b[21] | (b[22] << 8),
                    water_usage_l: round1((b[16] | (b[17] << 8)) * 0.1),
                } : {}),
                msg: payloadHex(),
            });
            return 1;
        }
        ctx.emit({
            ...base, msg_name: 'Unknown msg', target_id: targetId, acknowledgement,
            msg_type: msgType, msg_length: msgLength, msg: payloadHex(),
        });
        return 1;
    },
});
