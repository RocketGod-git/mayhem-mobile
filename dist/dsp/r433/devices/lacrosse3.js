import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, extractNibbles4b1s, reflectNibbles, xorBytes } from '../util.js';
const BANDS = [433920000, 868300000, 915000000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const bf = (y, start, len) => (y >> start) & ((1 << len) - 1);
const bit = (y, pos) => (y >> pos) & 1;
export const lacrosseWs = register({
    num: 34,
    name: 'LaCrosse WS-2310 / WS-3600 weather station',
    what: 'outdoor sensors: temperature, humidity, rain and wind',
    modulation: 6,
    shortWidth: 368,
    longWidth: 1464,
    resetLimit: 8000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        let events = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 52)
                continue;
            const p = bits.bb[row];
            if (p[0] !== 0x09 && p[0] !== 0x06)
                continue;
            const n = new Uint8Array(13);
            let parity = 0;
            for (let i = 0; i < 52; i++) {
                const b = (p[i >> 3] & (1 << (7 - (i % 8)))) ? 1 : 0;
                n[i >> 2] |= b << (3 - (i % 4));
                if (i === 9 || (i >= 27 && i <= 39))
                    parity += b;
            }
            let sum = 0;
            for (let i = 0; i < 12; i++)
                sum += n[i];
            if (n[7] !== (n[10] ^ 0xf) || n[8] !== (n[11] ^ 0xf)
                || (parity & 1) !== 1 || (sum & 0x0f) !== n[12])
                continue;
            const wsId = (n[0] << 4) + n[1];
            const type = ((n[2] >> 1) & 0x4) + (n[2] & 0x3);
            const model = wsId === 0x6 ? 'LaCrosse-WS3600' : 'LaCrosse-WS2310';
            const id = (n[3] << 4) + n[4];
            const bcd = n[7] * 100 + n[8] * 10 + n[9];
            if (type === 0) {
                ctx.emit({ model, id, temperature_C: round1((bcd - (wsId === 0x6 ? 400 : 300)) * 0.1) });
                events++;
            }
            else if (type === 1) {
                if (n[7] === 0xa && n[8] === 0xa)
                    continue;
                ctx.emit({ model, id, humidity: n[7] * 10 + n[8] });
                events++;
            }
            else if (type === 2) {
                ctx.emit({ model, id, rain_mm: round2(0.518 * (n[7] * 256 + n[8] * 16 + n[9])) });
                events++;
            }
            else if (type === 3 || type === 7) {
                if (n[7] === 0xf && n[8] === 0xe)
                    continue;
                const speed = round1((n[7] * 16 + n[8]) * 0.1);
                const out = { model, id, wind_dir_deg: n[9] * 22.5 };
                if (type === 3)
                    out.wind_avg_m_s = speed;
                else
                    out.wind_max_m_s = speed;
                ctx.emit(out);
                events++;
            }
        }
        return events;
    },
});
const WS7000_SIZE = [3, 6, 3, 6, 10, 7];
export const lacrosseWs7000 = register({
    num: 124,
    name: 'LaCrosse / ELV / Conrad WS7000 and WS2500 weather sensors',
    what: 'temperature, humidity, rain, wind, pressure and brightness sensors',
    modulation: 6,
    shortWidth: 400,
    longWidth: 800,
    resetLimit: 1100,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const start = bits.search(0, 0, new Uint8Array([0x01]), 8) + 8;
        if (start >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const b = new Uint8Array(14);
        const maxBits = Math.min(14 * 5, bits.bitsPerRow[0] - start);
        const len = extractNibbles4b1s(bits.bb[0], start, maxBits, b);
        if (len < 7)
            return DECODE_ABORT_LENGTH;
        reflectNibbles(b, len);
        const type = b[0];
        if (type > 5)
            return DECODE_ABORT_EARLY;
        if (len < WS7000_SIZE[type])
            return DECODE_ABORT_LENGTH;
        if (xorBytes(b, len - 1))
            return DECODE_FAIL_MIC;
        if (((addBytes(b, len - 1) + 5) & 0xf) !== b[len - 1])
            return DECODE_FAIL_MIC;
        const addr = b[1] & 0x7;
        const id = (type << 4) | addr;
        const sign = (b[1] & 0x8) ? -1 : 1;
        const temp = () => round1((b[4] * 10 + b[3] + b[2] * 0.1) * sign);
        const humid = () => Math.trunc(b[7] * 10 + b[6] + b[5] * 0.1);
        const base = { id, channel: addr, mic: 'CHECKSUM' };
        if (type === 0) {
            ctx.emit({ model: 'LaCrosse-WS700027', ...base, temperature_C: temp() });
        }
        else if (type === 1) {
            ctx.emit({ model: 'LaCrosse-WS700022', ...base, temperature_C: temp(), humidity: humid() });
        }
        else if (type === 2) {
            ctx.emit({ model: 'LaCrosse-WS700016', ...base, rain_mm: round1(((b[4] << 8) | (b[3] << 4) | b[2]) * 0.3) });
        }
        else if (type === 3) {
            ctx.emit({
                model: 'LaCrosse-WS700015', ...base,
                wind_avg_km_h: round1(b[4] * 10 + b[3] + b[2] * 0.1),
                wind_dir_deg: (b[7] >> 2) * 100 + b[6] * 10 + b[5],
                wind_dev_deg: (b[7] & 0x3) * 22.5,
            });
        }
        else if (type === 4) {
            ctx.emit({
                model: 'LaCrosse-WS700020', ...base,
                temperature_C: temp(), humidity: humid(),
                pressure_hPa: b[10] * 100 + b[9] * 10 + b[8] + 200,
            });
        }
        else {
            let lux = b[4] * 100 + b[3] * 10 + b[2];
            for (let i = b[5]; i > 0; i--)
                lux *= 10;
            ctx.emit({
                model: 'LaCrosse-WS250019', ...base,
                light_lux: lux,
                exposure_mins: b[8] * 100 + b[7] * 10 + b[6],
            });
        }
        return 1;
    },
});
export const lacrosseTx31u = register({
    num: 240,
    name: 'LaCrosse TX31U-IT, The Weather Channel WS-1910TWC-IT',
    what: 'outdoor console sensor with optional rain and wind',
    modulation: 16,
    shortWidth: 116,
    longWidth: 116,
    resetLimit: 20000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        const start = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]), 32);
        if (start >= n)
            return DECODE_ABORT_EARLY;
        const msgBytes = Math.trunc((n - start) / 8);
        if (msgBytes < 9 || msgBytes > 20)
            return DECODE_ABORT_LENGTH;
        const msg = bits.bytes(0, start, msgBytes * 8);
        const noExt = bit(msg[5], 4);
        const measurements = bf(msg[5], 0, 3);
        const expected = 6 + measurements * 2 + 1;
        if (msgBytes < expected)
            return DECODE_ABORT_LENGTH;
        if (msg[expected - 1] !== crc8(msg, 2 + measurements * 2, 0x31, 0x00, 4))
            return DECODE_FAIL_MIC;
        const out = {
            model: 'LaCrosse-TX31UIT',
            id: (bf(msg[4], 0, 4) << 2) | bf(msg[5], 6, 2),
            battery_ok: bit(msg[5], 3) ? 0 : 1,
            mic: 'CRC',
        };
        for (let m = 0; m < measurements; m++) {
            const tag = bf(msg[6 + m * 2], 4, 4);
            const n1 = bf(msg[6 + m * 2], 0, 4);
            const n2 = bf(msg[7 + m * 2], 4, 4);
            const n3 = bf(msg[7 + m * 2], 0, 4);
            if (tag === 0)
                out.temperature_C = round1(10 * n1 + n2 + 0.1 * n3 - 40);
            else if (tag === 1)
                out.humidity = 100 * n1 + 10 * n2 + n3;
            else if (tag === 2) {
                const raw = (n1 << 8) + (n2 << 4) + n3;
                if (!noExt && raw > 0)
                    out.rain = raw.toString(16).padStart(3, '0');
            }
            else if (tag === 3) {
                if (!noExt) {
                    out.wind_dir_deg = n1 * 22.5;
                    out.wind_avg_km_h = round1(((n2 << 4) + n3) * 0.1 * 3.6);
                }
            }
            else if (tag === 4) {
                if (!noExt && !bit(n1, 0))
                    out.wind_max_km_h = round1(((n2 << 4) + n3) * 0.1 * 3.6);
            }
        }
        ctx.emit(out);
        return 1;
    },
});
function tx22uitDecode(bits, ctx) {
    const rowBits = bits.bitsPerRow[0];
    const at = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]), 32);
    if (at >= rowBits)
        return DECODE_ABORT_EARLY;
    const offset = at + 32;
    const size = Math.min(rowBits - offset, 64 * 8);
    const b = bits.bytes(0, offset, size);
    const bytes = Math.trunc(size / 8);
    let quartets = 0;
    for (let q = 5; q >= 1; q--) {
        if (q === 4)
            continue;
        const dataLen = 2 + 2 * q;
        if (dataLen + 2 <= bytes && crc8(b, dataLen, 0x31, 0x00) === b[dataLen]) {
            quartets = q;
            break;
        }
    }
    if (!quartets)
        return DECODE_FAIL_MIC;
    const end = 2 + 2 * quartets;
    const out = {
        model: 'LaCrosse-TX22UIT',
        id: b[0].toString(16).padStart(2, '0'),
        flags: b[1].toString(16).padStart(2, '0'),
        mic: 'CRC',
    };
    let rawTemp = -1, humidity = -1, rawSpeed = -1, direction = -1;
    let rainMm = -1, gust = -1, recognized = 0;
    for (let p = 2; p < end; p += 2) {
        const bcd3 = ((b[p] & 0x0f) * 100) + ((b[p + 1] >> 4) * 10) + (b[p + 1] & 0x0f);
        const nyb3 = ((b[p] & 0x0f) << 8) | b[p + 1];
        switch (b[p] >> 4) {
            case 0:
                rawTemp = bcd3;
                recognized++;
                break;
            case 1:
                humidity = bcd3;
                recognized++;
                break;
            case 2:
                rainMm = 0.518 * nyb3;
                recognized++;
                break;
            case 3:
                direction = (b[p] & 0x0f) * 22.5;
                rawSpeed = b[p + 1];
                recognized++;
                break;
            case 4:
                gust = nyb3 * 0.1;
                recognized++;
                break;
            default: break;
        }
    }
    if (recognized === 0)
        return DECODE_FAIL_SANITY;
    const tempC = (rawTemp - 400) * 0.1;
    const speed = rawSpeed * 0.1;
    if (rawTemp >= 0 && tempC > -40 && tempC <= 70)
        out.temperature_C = round1(tempC);
    if (humidity > 0 && humidity <= 100)
        out.humidity = humidity;
    if (rainMm >= 0 && rainMm <= 0xfff * 0.518)
        out.rain_mm = round2(rainMm);
    if (rawSpeed >= 0 && speed >= 0 && speed <= 200)
        out.wind_avg_km_h = round1(speed);
    if (gust >= 0 && gust <= 200)
        out.wind_gust_km_h = round1(gust);
    if (direction >= 0 && direction <= 360)
        out.wind_dir_deg = direction;
    ctx.emit(out);
    return 1;
}
export const lacrosseTx22uit = register({
    num: 323,
    name: 'LaCrosse TX22U-IT',
    what: 'outdoor console sensor with optional rain and wind',
    modulation: 16,
    shortWidth: 116,
    longWidth: 116,
    resetLimit: 5900,
    bands: BANDS,
    decode: (_dev, bits, ctx) => tx22uitDecode(bits, ctx),
});
export const lacrosseTx22uitOok = register({
    num: 324,
    name: 'LaCrosse TX22U-IT, on-off keyed',
    what: 'outdoor console sensor with optional rain and wind',
    modulation: 4,
    shortWidth: 120,
    longWidth: 120,
    resetLimit: 5000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        bits.invert();
        return tx22uitDecode(bits, ctx);
    },
});
function ws6868Header(b) {
    return {
        model: '',
        id: (((b[0] << 16) | (b[1] << 8) | b[2]) >>> 0).toString(16).padStart(6, '0'),
        channel: ((b[3] >> 4) & 3) + 1,
        battery_ok: (b[3] >> 7) & 1 ? 0 : 1,
        test: (b[3] >> 6) & 1,
        counter: (b[3] >> 1) & 7,
    };
}
function ws6868Start(bits) {
    if (bits.numRows !== 1)
        return -1;
    const at = bits.search(0, 0, new Uint8Array([0xd2, 0xaa, 0x2d, 0xd4]), 32);
    return at >= bits.bitsPerRow[0] ? -1 : at + 32;
}
export const lacrosseWs6868Tx232th = register({
    num: 374,
    name: 'LaCrosse WS6868 TX232TH-LCD temperature and humidity sensor',
    what: 'outdoor thermometer and hygrometer',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 2000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const at = ws6868Start(bits);
        if (at < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] - at < 64)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 64);
        if (crc8(b, 7, 0x31, 0x00) !== b[7])
            return DECODE_FAIL_MIC;
        ctx.emit({
            ...ws6868Header(b),
            model: 'LaCrosse-TX232TH',
            temperature_C: round1((((b[4] << 4) | (b[5] >> 4)) - 500) * 0.1),
            humidity: ((b[5] & 0x0f) << 8) | b[6],
            mic: 'CRC',
        });
        return 1;
    },
});
export const lacrosseWs6868Tx231rw = register({
    num: 375,
    name: 'LaCrosse WS6868 TX231RW wind and rain sensor',
    what: 'wind and rain sensor',
    modulation: 16,
    shortWidth: 58,
    longWidth: 58,
    resetLimit: 2000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const at = ws6868Start(bits);
        if (at < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] - at < 96)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at, 96);
        if (crc8(b, 10, 0x31, 0x00) !== b[10] || (addBytes(b, 11) & 0xff) !== b[11])
            return DECODE_FAIL_MIC;
        let raw = '';
        for (let i = 0; i < 6; i++)
            raw += b[4 + i].toString(16).padStart(2, '0');
        ctx.emit({
            ...ws6868Header(b),
            model: 'LaCrosse-TX231RW',
            data_raw: raw,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
