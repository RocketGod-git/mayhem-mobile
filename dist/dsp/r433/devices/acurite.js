import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8le, crc16lsb, lfsrDigest8, parityBytes, reverse8 } from '../util.js';
const MSG_1190_DETECTOR = 0x01;
const MSG_TOWER = 0x04;
const MSG_ATLAS_WIND_TEMP_HUM = 0x05;
const MSG_ATLAS_WIND_RAIN = 0x06;
const MSG_ATLAS_WIND_UV_LUX = 0x07;
const MSG_515_REFRIGERATOR = 0x08;
const MSG_515_FREEZER = 0x09;
const MSG_3N1 = 0x20;
const MSG_ATLAS_WIND_TEMP_HUM_LTNG = 0x25;
const MSG_ATLAS_WIND_RAIN_LTNG = 0x26;
const MSG_ATLAS_WIND_UV_LUX_LTNG = 0x27;
const MSG_6045M = 0x2f;
const MSG_899_RAINFALL = 0x30;
const MSG_5N1_WIND_DIR_RAIN = 0x31;
const MSG_5N1_WIND_TEMP_HUM = 0x38;
const MSG_OPTIMUS_WIND_RAIN = 0x3a;
const MSG_OPTIMUS_TEMP_HUM = 0x3b;
const LEN_515 = 6, LEN_TXR = 7, LEN_1190 = 7, LEN_3N1 = 8, LEN_5N1 = 8;
const LEN_899 = 8, LEN_ATLAS = 8, LEN_6045 = 9, LEN_ATLAS_LTNG = 10, LEN_OPTIMUS = 10;
const WIND_DIRECTIONS = [14, 11, 13, 12, 15, 10, 0, 9, 3, 6, 4, 5, 2, 7, 1, 8];
const CHANNELS = ['C', 'E', 'B', 'A'];
const channelOf = (byte) => CHANNELS[(byte & 0xc0) >> 6];
function signed(v, bits) {
    const shift = 32 - bits;
    return (v << shift) >> shift;
}
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
function rawMsg(bb, len) {
    let s = '';
    for (let i = 0; i < len; i++)
        s += bb[i].toString(16).padStart(2, '0');
    return s;
}
function txrCheck(bb, browlen, explen) {
    if (browlen < 6)
        return DECODE_ABORT_LENGTH;
    if (browlen < explen)
        return DECODE_ABORT_LENGTH;
    if ((addBytes(bb, explen - 1) & 0xff) !== bb[explen - 1])
        return DECODE_FAIL_MIC;
    if (parityBytes(bb, explen - 3, 2))
        return DECODE_FAIL_MIC;
    if (channelOf(bb[0]) === 'E')
        return DECODE_FAIL_SANITY;
    return 0;
}
function towerDecode(bb, ctx) {
    const humidity = bb[3] & 0x7f;
    if (humidity > 100 && humidity !== 127)
        return DECODE_FAIL_SANITY;
    const tempRaw = ((bb[4] & 0x7f) << 7) | (bb[5] & 0x7f);
    const tempC = (tempRaw - 1000) * 0.1;
    if (tempC < -40 || tempC > 70)
        return DECODE_FAIL_SANITY;
    const out = {
        model: 'Acurite-Tower',
        id: ((bb[0] & 0x3f) << 8) | bb[1],
        channel: channelOf(bb[0]),
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        temperature_C: round1(tempC),
        mic: 'CHECKSUM',
    };
    if (humidity !== 127)
        out.humidity = humidity;
    if ((tempRaw & 0x3800) !== 0) {
        out.exception = 1;
        out.raw_msg = rawMsg(bb, LEN_TXR);
    }
    ctx.emit(out);
    return 1;
}
function leakDecode(bb, ctx) {
    ctx.emit({
        model: 'Acurite-Leak',
        id: ((bb[0] & 0x3f) << 8) | bb[1],
        channel: channelOf(bb[0]),
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        leak_detected: (bb[3] & 0x10) >> 4,
        mic: 'CHECKSUM',
    });
    return 1;
}
function fridgeDecode(bb, ctx) {
    const type = bb[2] & 0x3f;
    const suffix = type === MSG_515_REFRIGERATOR ? 'R' : type === MSG_515_FREEZER ? 'F' : null;
    if (suffix === null)
        return DECODE_FAIL_SANITY;
    const tempRaw = ((bb[3] & 0x7f) << 7) | (bb[4] & 0x7f);
    const tempF = (tempRaw - 1480) * 0.1;
    if (tempF < -40 || tempF > 158)
        return DECODE_FAIL_SANITY;
    const out = {
        model: 'Acurite-515',
        id: ((bb[0] & 0x3f) << 8) | bb[1],
        channel: channelOf(bb[0]) + suffix,
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        temperature_F: round1(tempF),
        mic: 'CHECKSUM',
    };
    if ((tempRaw & 0x3000) !== 0) {
        out.exception = 1;
        out.raw_msg = rawMsg(bb, LEN_515);
    }
    ctx.emit(out);
    return 1;
}
function lightning6045Decode(bb, ctx) {
    const humidity = bb[3] & 0x7f;
    if (humidity > 100)
        return DECODE_FAIL_SANITY;
    const tempRaw = ((bb[4] & 0x1f) << 7) | (bb[5] & 0x7f);
    const tempF = (tempRaw - 1480) * 0.1;
    if (tempF < -40 || tempF > 158)
        return DECODE_FAIL_SANITY;
    let exception = 0;
    if (tempRaw & 0x3000)
        exception++;
    if ((bb[4] & 0x20) !== 0)
        exception++;
    ctx.emit({
        model: 'Acurite-6045M',
        id: ((bb[0] & 0x3f) << 8) | bb[1],
        channel: channelOf(bb[0]),
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        temperature_F: round1(tempF),
        humidity,
        strike_count: ((bb[6] & 0x7f) << 1) | ((bb[7] & 0x40) >> 6),
        storm_dist: bb[7] & 0x1f,
        active: (bb[4] & 0x40) === 0x40 ? 1 : 0,
        rfi: (bb[7] & 0x20) === 0x20 ? 1 : 0,
        exception,
        raw_msg: rawMsg(bb, LEN_6045),
    });
    return 1;
}
function rain899Decode(bb, ctx) {
    const ticks = ((bb[5] & 0x7f) << 7) | (bb[6] & 0x7f);
    ctx.emit({
        model: 'Acurite-Rain899',
        id: ((bb[0] & 0x3f) << 8) | bb[1],
        channel: bb[0] >> 6,
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        rain_mm: round2(ticks * 0.254),
        mic: 'CHECKSUM',
    });
    return 1;
}
function notos3n1Decode(bb, ctx) {
    const channel = channelOf(bb[0]);
    if (channel === 'E')
        return DECODE_FAIL_SANITY;
    const humidity = bb[3] & 0x7f;
    if (humidity > 100)
        return DECODE_FAIL_SANITY;
    const tempF = (((bb[4] & 0x1f) << 7 | (bb[5] & 0x7f)) - 1480) * 0.1;
    if (tempF < -40 || tempF > 158)
        return DECODE_FAIL_SANITY;
    ctx.emit({
        model: 'Acurite-3n1',
        message_type: bb[2] & 0x3f,
        id: ((bb[0] & 0x3f) << 8) | bb[1],
        channel,
        sequence_num: (bb[0] & 0x30) >> 4,
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        wind_avg_mi_h: bb[6] & 0x7f,
        temperature_F: round1(tempF),
        humidity,
        mic: 'CHECKSUM',
    });
    return 1;
}
function iris5n1Decode(bb, ctx) {
    const type = bb[2] & 0x3f;
    const raw = ((bb[3] & 0x1f) << 3) | ((bb[4] & 0x70) >> 4);
    const windKmh = raw > 0 ? raw * 0.8278 + 1.0 : 0;
    const common = {
        model: 'Acurite-5n1',
        message_type: type,
        id: ((bb[0] & 0x0f) << 8) | bb[1],
        channel: channelOf(bb[0]),
        sequence_num: (bb[0] & 0x30) >> 4,
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        wind_avg_km_h: round1(windKmh),
    };
    if (type === MSG_5N1_WIND_DIR_RAIN) {
        const ticks = ((bb[5] & 0x7f) << 7) | (bb[6] & 0x7f);
        ctx.emit({
            ...common,
            wind_dir_deg: WIND_DIRECTIONS[bb[4] & 0x0f] * 22.5,
            rain_in: round2(ticks * 0.01),
            mic: 'CHECKSUM',
        });
        return 1;
    }
    if (type === MSG_5N1_WIND_TEMP_HUM) {
        const tempF = ((((bb[4] & 0x0f) << 7) | (bb[5] & 0x7f)) - 400) * 0.1;
        if (tempF < -40 || tempF > 158)
            return DECODE_FAIL_SANITY;
        const humidity = bb[6] & 0x7f;
        if (humidity > 100)
            return DECODE_FAIL_SANITY;
        ctx.emit({ ...common, temperature_F: round1(tempF), humidity, mic: 'CHECKSUM' });
        return 1;
    }
    return DECODE_FAIL_SANITY;
}
function atlasDecode(bb, ctx) {
    const type = bb[2] & 0x3f;
    const windMph = ((bb[3] & 0x7f) << 1) | ((bb[4] & 0x40) >> 6);
    if (windMph > 200)
        return DECODE_FAIL_SANITY;
    let exception = 0;
    const out = {
        model: 'Acurite-Atlas',
        id: ((bb[0] & 0x03) << 8) | bb[1],
        channel: channelOf(bb[0]),
        sequence_num: (bb[0] & 0x0c) >> 2,
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        message_type: type,
        wind_avg_mi_h: round1(windMph),
    };
    if (type === MSG_ATLAS_WIND_TEMP_HUM || type === MSG_ATLAS_WIND_TEMP_HUM_LTNG) {
        const tempF = ((((bb[4] & 0x0f) << 7) | (bb[5] & 0x7f)) - 400) * 0.1;
        if ((bb[4] & 0x30) !== 0)
            exception++;
        if (tempF < -40 || tempF > 158)
            return DECODE_FAIL_SANITY;
        const humidity = bb[6] & 0x7f;
        if (humidity > 100)
            return DECODE_FAIL_SANITY;
        if (humidity === 0)
            exception++;
        out.temperature_F = round1(tempF);
        out.humidity = humidity;
    }
    if (type === MSG_ATLAS_WIND_RAIN || type === MSG_ATLAS_WIND_RAIN_LTNG) {
        const windDir = ((bb[4] & 0x1f) << 5) | ((bb[5] & 0x7c) >> 2);
        if ((bb[4] & 0x30) !== 0)
            exception++;
        if (windDir > 360)
            return DECODE_FAIL_SANITY;
        const ticks = ((bb[5] & 0x03) << 7) | (bb[6] & 0x7f);
        out.wind_dir_deg = windDir;
        out.rain_in = round2(ticks * 0.01);
    }
    if (type === MSG_ATLAS_WIND_UV_LUX || type === MSG_ATLAS_WIND_UV_LUX_LTNG) {
        const lux = ((bb[5] & 0x7f) << 7) | (bb[6] & 0x7f);
        if (lux > 12000)
            return DECODE_FAIL_SANITY;
        out.uvi = bb[4] & 0x0f;
        out.lux = lux * 10;
    }
    if (type === MSG_ATLAS_WIND_TEMP_HUM_LTNG || type === MSG_ATLAS_WIND_RAIN_LTNG
        || type === MSG_ATLAS_WIND_UV_LUX_LTNG) {
        out.strike_count = ((bb[7] & 0x7f) << 2) | ((bb[8] & 0x60) >> 5);
        out.strike_distance = bb[8] & 0x1f;
    }
    out.exception = exception;
    out.raw_msg = rawMsg(bb, type >= MSG_ATLAS_WIND_TEMP_HUM_LTNG ? LEN_ATLAS_LTNG : LEN_ATLAS);
    ctx.emit(out);
    return 1;
}
function optimusDecode(bb, ctx) {
    const type = bb[2] & 0x3f;
    const windMph = ((bb[3] & 0x7f) << 1) | ((bb[4] & 0x40) >> 6);
    if (windMph > 200)
        return DECODE_FAIL_SANITY;
    const common = {
        model: 'Acurite-Optimus',
        id: ((bb[0] & 0x0f) << 8) | bb[1],
        channel: channelOf(bb[0]),
        sequence_num: (bb[0] & 0x30) >> 4,
        battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
        wind_avg_mi_h: round1(windMph),
        wind_avg_km_h: round1(windMph * 1.609344),
    };
    const raw_msg = rawMsg(bb, LEN_OPTIMUS);
    if (type === MSG_OPTIMUS_TEMP_HUM) {
        const tempF = ((((bb[4] & 0x0f) << 7) | (bb[5] & 0x7f)) - 400) * 0.1;
        if (tempF < -40 || tempF > 158)
            return DECODE_FAIL_SANITY;
        const humidity = bb[6] & 0x7f;
        if (humidity > 100)
            return DECODE_FAIL_SANITY;
        ctx.emit({ ...common, temperature_F: round1(tempF), humidity, raw_msg });
        return 1;
    }
    if (type === MSG_OPTIMUS_WIND_RAIN) {
        const ticks = ((bb[5] & 0x03) << 7) | (bb[6] & 0x7f);
        ctx.emit({
            ...common,
            wind_dir_deg: WIND_DIRECTIONS[bb[4] & 0x0f] * 22.5,
            rain_in: round2(ticks * 0.01),
            raw_msg,
        });
        return 1;
    }
    return DECODE_FAIL_SANITY;
}
const TXR_TABLE = {
    [MSG_TOWER]: { len: LEN_TXR, fn: towerDecode, check: true },
    [MSG_1190_DETECTOR]: { len: LEN_1190, fn: leakDecode, check: true },
    [MSG_6045M]: { len: LEN_6045, fn: lightning6045Decode, check: true },
    [MSG_515_REFRIGERATOR]: { len: LEN_515, fn: fridgeDecode, check: true },
    [MSG_515_FREEZER]: { len: LEN_515, fn: fridgeDecode, check: true },
    [MSG_5N1_WIND_TEMP_HUM]: { len: LEN_5N1, fn: iris5n1Decode, check: true },
    [MSG_5N1_WIND_DIR_RAIN]: { len: LEN_5N1, fn: iris5n1Decode, check: true },
    [MSG_OPTIMUS_TEMP_HUM]: { len: LEN_OPTIMUS, fn: optimusDecode, check: true },
    [MSG_OPTIMUS_WIND_RAIN]: { len: LEN_OPTIMUS, fn: optimusDecode, check: true },
    [MSG_899_RAINFALL]: { len: LEN_899, fn: rain899Decode, check: true },
    [MSG_ATLAS_WIND_TEMP_HUM]: { len: LEN_ATLAS, fn: atlasDecode, check: true },
    [MSG_ATLAS_WIND_RAIN]: { len: LEN_ATLAS, fn: atlasDecode, check: true },
    [MSG_ATLAS_WIND_UV_LUX]: { len: LEN_ATLAS, fn: atlasDecode, check: true },
    [MSG_ATLAS_WIND_TEMP_HUM_LTNG]: { len: LEN_ATLAS_LTNG, fn: atlasDecode, check: true },
    [MSG_ATLAS_WIND_RAIN_LTNG]: { len: LEN_ATLAS_LTNG, fn: atlasDecode, check: true },
    [MSG_ATLAS_WIND_UV_LUX_LTNG]: { len: LEN_ATLAS_LTNG, fn: atlasDecode, check: true },
    [MSG_3N1]: { len: LEN_3N1, fn: notos3n1Decode, check: false },
};
export const acuriteTxr = register({
    num: 40,
    name: 'Acurite 592TXR temp/humidity, 592TX temp, 5n1, 3n1, Atlas weather station, 515 fridge/freezer, 6045 lightning, 899 rain, 1190/1192 leak',
    what: 'the main Acurite range: thermometers, weather stations, lightning, rain, leaks and fridge probes',
    modulation: 6,
    shortWidth: 220,
    longWidth: 408,
    syncWidth: 620,
    gapLimit: 500,
    resetLimit: 4000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        bits.invert();
        let decoded = 0;
        let error = 0;
        for (let row = 0; row < bits.numRows; row++) {
            const rowBits = bits.bitsPerRow[row];
            const browlen = (rowBits / 8) | 0;
            const bb = bits.bb[row];
            if (browlen < 6)
                continue;
            if (browlen > 10) {
                error = DECODE_ABORT_LENGTH;
                continue;
            }
            if (bb[0] === 0 && bb[1] === 0 && bb[2] === 0 && bb[browlen - 1] === 0)
                continue;
            const entry = TXR_TABLE[bb[2] & 0x3f];
            if (!entry) {
                error = DECODE_FAIL_SANITY;
                continue;
            }
            if (entry.check) {
                const ret = txrCheck(bb, browlen, entry.len);
                if (ret !== 0) {
                    error = ret;
                    continue;
                }
            }
            else {
                if (browlen < entry.len) {
                    error = DECODE_ABORT_LENGTH;
                    continue;
                }
                if ((addBytes(bb, entry.len - 1) & 0xff) !== bb[entry.len - 1]) {
                    error = DECODE_FAIL_MIC;
                    continue;
                }
            }
            const ret = entry.fn(bb, ctx);
            if (ret > 0)
                decoded += ret;
            else if (ret < 0)
                error = ret;
        }
        return decoded ? decoded : error;
    },
});
export const acuriteRain896 = register({
    num: 10,
    name: 'Acurite 896 rain gauge',
    what: 'tipping-bucket rain gauge',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3500,
    resetLimit: 5000,
    priority: 10,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const b = bits.bb[0];
        if (bits.bitsPerRow[0] < 24)
            return DECODE_ABORT_LENGTH;
        if (bits.numRows < 12)
            return DECODE_ABORT_EARLY;
        if (b[0] === 0 || b[1] === 0 || b[2] === 0 || b[3] !== 0 || b[4] !== 0)
            return DECODE_ABORT_EARLY;
        ctx.emit({
            model: 'Acurite-Rain',
            id: b[0],
            rain_mm: round1((((b[1] & 0x0f) << 8) | b[2]) * 0.5),
        });
        return 1;
    },
});
export const acuriteTh = register({
    num: 11,
    name: 'Acurite 609TXC temperature and humidity sensor',
    what: 'outdoor temperature and humidity sensor',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3000,
    resetLimit: 10000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        let valid = 0;
        let result = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 40) {
                result = DECODE_ABORT_LENGTH;
                continue;
            }
            const bb = bits.bb[row];
            const cksum = bb[0] + bb[1] + bb[2] + bb[3];
            if (cksum === 0 || (cksum & 0xff) !== bb[4]) {
                result = DECODE_FAIL_MIC;
                continue;
            }
            const humidity = bb[3];
            if (humidity > 100)
                return DECODE_FAIL_SANITY;
            const status = (bb[1] & 0xf0) >> 4;
            ctx.emit({
                model: 'Acurite-609TXC',
                id: bb[0],
                battery_ok: (status & 0x8) ? 0 : 1,
                temperature_C: round1((signed(((bb[1] & 0x0f) << 12) | (bb[2] << 4), 16) >> 4) * 0.1),
                humidity,
                status,
                mic: 'CHECKSUM',
            });
            valid++;
        }
        return valid ? 1 : result;
    },
});
export const acurite606 = register({
    num: 55,
    name: 'Acurite 606TX / Technoline TX960 temperature sensor',
    what: 'outdoor thermometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 7000,
    resetLimit: 10000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 32);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 33)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0)
            return DECODE_FAIL_SANITY;
        if (lfsrDigest8(b, 3, 0x98, 0xf1) !== b[3])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Acurite-606TX',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (b[1] & 0x80) >> 7,
            button: (b[1] & 0x40) >> 6,
            temperature_C: round1((signed((b[1] << 12) | (b[2] << 4), 16) >> 4) * 0.1),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const acurite590tx = register({
    num: 163,
    name: 'Acurite 590TX temperature with optional humidity',
    what: 'outdoor thermometer',
    modulation: 5,
    shortWidth: 500,
    longWidth: 1500,
    gapLimit: 2000,
    resetLimit: 3500,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 25);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 25)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[4] !== 0)
            return DECODE_FAIL_SANITY;
        if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0)
            return DECODE_FAIL_SANITY;
        let parity = b[0];
        parity = (parity >> 4) ^ (parity & 0x0f);
        parity = (parity >> 2) ^ (parity & 0x03);
        parity ^= b[1] >> 6;
        parity = (parity >> 1) ^ (parity & 0x01);
        if (!parity)
            return DECODE_FAIL_MIC;
        const tempRaw = signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4;
        const out = {
            model: 'Acurite-590TX',
            id: b[0] & 0xfe,
            channel: (b[1] >> 4) & 0x03,
            battery_ok: b[0] & 0x01,
            mic: 'PARITY',
        };
        if (tempRaw >= 0 && tempRaw <= 100)
            out.humidity = tempRaw;
        else
            out.temperature_C = round1((tempRaw - 500) * 0.1);
        ctx.emit(out);
        return 1;
    },
});
function fridgeReversedDecode(bits, ctx, opts) {
    let valid = 0;
    let result = 0;
    for (let row = 0; row < bits.numRows; row++) {
        const n = bits.bitsPerRow[row];
        if (n < opts.minBits || n > opts.maxBits) {
            if (n > 16)
                result = DECODE_ABORT_LENGTH;
            continue;
        }
        const bb = bits.bb[row];
        if (opts.model === 'Acurite-986') {
            if ((bb[0] === 0xff && bb[1] === 0xff && bb[2] === 0xff)
                || (bb[0] === 0x00 && bb[1] === 0x00 && bb[2] === 0x00)) {
                result = DECODE_ABORT_EARLY;
                continue;
            }
        }
        else if (bb[2] === 0 && bb[3] === 0 && bb[4] === 0 && bb[5] === 0 && bb[6] === 0) {
            result = DECODE_ABORT_EARLY;
            continue;
        }
        const br = new Uint8Array(opts.bytes);
        for (let i = 0; i < opts.bytes; i++)
            br[i] = reverse8(bb[i]);
        let tempF = br[opts.tempAt];
        const sensorId = (br[opts.idAt] << 8) | br[opts.idAt + 1];
        const status = opts.model === 'Acurite-986' ? br[3] >> 1 : br[5];
        const sensorNum = (opts.model === 'Acurite-986' ? (br[3] & 0x01) : (br[5] & 0x01)) + 1;
        const batteryLow = opts.model === 'Acurite-986'
            ? (status & 1) === 1
            : sensorNum === 2 ? !!(status & 0x04) : !!(status & 0x02);
        const crcc = crc8le(br, 4, 0x07, 0, opts.crcFrom);
        if (crcc !== br[opts.crcAt] && crcc !== (br[opts.crcAt] | 0x80)) {
            result = DECODE_FAIL_MIC;
            continue;
        }
        if (tempF & 0x80)
            tempF = -(tempF & 0x7f);
        if (opts.sanity && !(tempF >= -40 && tempF <= 104) && tempF !== -127 && tempF !== 127) {
            result = DECODE_FAIL_SANITY;
            continue;
        }
        ctx.emit({
            model: opts.model,
            id: sensorId,
            channel: sensorNum === 2 ? '2F' : '1R',
            battery_ok: batteryLow ? 0 : 1,
            temperature_F: tempF,
            status,
            mic: 'CRC',
        });
        valid++;
    }
    return valid ? 1 : result;
}
export const acurite986 = register({
    num: 41,
    name: 'Acurite 986 refrigerator / freezer thermometer',
    what: 'fridge and freezer probes',
    modulation: 5,
    shortWidth: 520,
    longWidth: 880,
    gapLimit: 1280,
    resetLimit: 4000,
    bands: [433920000],
    decode: (_d, bits, ctx) => fridgeReversedDecode(bits, ctx, { model: 'Acurite-986', minBits: 39, maxBits: 43, bytes: 5, tempAt: 0, idAt: 1, crcAt: 4, crcFrom: 0, sanity: false }),
});
export const acurite985 = register({
    num: 326,
    name: 'Acurite/Chaney 985 refrigerator / freezer thermometer',
    what: 'fridge and freezer probes, the older Chaney-branded version',
    modulation: 5,
    shortWidth: 556,
    longWidth: 1104,
    gapLimit: 4000,
    resetLimit: 7636,
    syncWidth: 2996,
    bands: [433920000],
    decode: (_d, bits, ctx) => fridgeReversedDecode(bits, ctx, { model: 'Acurite-985', minBits: 55, maxBits: 59, bytes: 7, tempAt: 2, idAt: 3, crcAt: 6, crcFrom: 2, sanity: true }),
});
export const acurite00275rm = register({
    num: 74,
    name: 'Acurite 00275rm, 00276rm temp/humidity with optional probe',
    what: 'room monitor with an optional water or temperature probe',
    modulation: 6,
    shortWidth: 232,
    longWidth: 420,
    gapLimit: 520,
    resetLimit: 708,
    syncWidth: 632,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        let result = 0;
        bits.invert();
        const rows = [];
        for (let row = 0; row < bits.numRows; row++) {
            if (rows.length < 3 && bits.bitsPerRow[row] === 88)
                rows.push(row);
        }
        if (rows.length === 3) {
            const [x, y, z] = rows.map(r => bits.bb[r]);
            bits.addRow();
            const b = bits.bb[bits.numRows - 1];
            for (let i = 0; i < 11; i++)
                b[i] = (x[i] & y[i]) | (y[i] & z[i]) | (z[i] & x[i]);
            bits.bitsPerRow[bits.numRows - 1] = 88;
        }
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 88) {
                result = DECODE_ABORT_LENGTH;
                continue;
            }
            const b = bits.bb[row];
            if (crc16lsb(b, 11, 0x00b2, 0x00d0) !== 0) {
                result = DECODE_FAIL_MIC;
                continue;
            }
            const probe = b[5] & 3;
            const out = {
                model: (b[2] & 1) ? 'Acurite-00275rm' : 'Acurite-00276rm',
                subtype: probe,
                id: (b[0] << 16) | (b[1] << 8) | b[3],
                battery_ok: (b[2] & 0x40) === 0 ? 0 : 1,
                temperature_C: round1((((b[4] << 4) | (b[5] >> 4)) - 1000) * 0.1),
                humidity: ((b[6] & 0x1f) << 2) | (b[7] >> 6),
                mic: 'CRC',
            };
            if (probe === 1)
                out.water = (b[7] & 0x0f) === 15 ? 1 : 0;
            if (probe === 2 || probe === 3) {
                out.temperature_1_C = round1(((((b[7] & 0x0f) << 8) | b[8]) - 1000) * 0.1);
            }
            if (probe === 3)
                out.humidity_1 = b[9] & 0x7f;
            ctx.emit(out);
            return 1;
        }
        return result;
    },
});
