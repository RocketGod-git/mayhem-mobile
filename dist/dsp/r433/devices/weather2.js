import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, lfsrDigest8Reflect, reverse8, xorBytes } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const signed12 = (v) => ((v & 0xffff) << 16) >> 20;
function byteAt(m, off) {
    const i = off >> 3, s = off & 7;
    if (!s)
        return m[i] ?? 0;
    return ((((m[i] ?? 0) << 8) | (m[i + 1] ?? 0)) >> (8 - s)) & 0xff;
}
function sumBytes(m, n) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += m[i];
    return s;
}
export const mebus433 = register({
    num: 13,
    name: 'Mebus 433',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 800,
    longWidth: 1600,
    gapLimit: 2400,
    resetLimit: 6000,
    bands: BAND_433,
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 13)
            return DECODE_ABORT_EARLY;
        const b = bits.bb;
        if (b[0][0] !== 0 || !b[1][4] || !(b[1][0] & 0x60)
            || b[1][3] !== b[5][3] || b[1][4] !== b[12][4])
            return DECODE_ABORT_EARLY;
        const r = b[1];
        ctx.emit({
            model: 'Mebus-433',
            type: 'Weather',
            id: r[0] & 0x1f,
            channel: ((r[1] & 0x30) >> 4) + 1,
            battery_ok: r[1] & 0x80 ? 1 : 0,
            unknown1: (r[1] & 0x40) >> 6,
            unknown2: (r[3] & 0xf0) >> 4,
            temperature_C: round2(signed12((r[1] << 12) | (r[2] << 4)) * 0.1),
            humidity: (((((r[3] << 4) | (r[4] >> 4)) & 0xff) << 24) >> 24),
        });
        return 1;
    },
});
export const calibeurRf104 = register({
    num: 21,
    name: 'Calibeur RF-104 Sensor',
    what: 'thermometer and hygrometer',
    modulation: 6,
    shortWidth: 760,
    longWidth: 2240,
    resetLimit: 3200,
    syncWidth: 1560,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 3)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[1], b2 = bits.bb[2];
        if ((!b[0] && !b[1] && !b[2]) || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff)) {
            return DECODE_FAIL_SANITY;
        }
        bits.invert();
        if (bits.bitsPerRow[1] !== 21)
            return DECODE_ABORT_LENGTH;
        if (crc8(b, 3, 0x80, 0) === 0)
            return DECODE_FAIL_MIC;
        if (b[0] !== b2[0] || b[1] !== b2[1] || b[2] !== b2[2])
            return DECODE_FAIL_SANITY;
        const scatter = (...parts) => parts.reduce((a, v) => a | v, 0) & 0xff;
        const packed = scatter((b[0] & 0x80) >> 7, (b[0] & 0x40) >> 5, (b[0] & 0x20) >> 3, (b[0] & 0x10) >> 1, (b[0] & 0x08) << 1, (b[0] & 0x04) << 3);
        const whole = scatter((b[0] & 0x02) << 3, (b[0] & 0x01) << 5, (b[1] & 0x80) >> 7, (b[1] & 0x40) >> 5, (b[1] & 0x20) >> 3, (b[1] & 0x10) >> 1, (b[1] & 0x08) << 3);
        const humidity = scatter((b[1] & 0x02) << 4, (b[1] & 0x01) << 6, (b[2] & 0x80) >> 7, (b[2] & 0x40) >> 5, (b[2] & 0x20) >> 3, (b[2] & 0x10) >> 1, (b[2] & 0x08) << 1);
        ctx.emit({
            model: 'Calibeur-RF104',
            type: 'Weather',
            id: Math.floor(packed / 10),
            temperature_C: round1((packed % 10) * 0.1 + whole - 41),
            humidity,
            mic: 'CRC',
        });
        return 1;
    },
});
export const springfield = register({
    num: 53,
    name: 'Springfield Temperature and Soil Moisture',
    what: 'soil moisture and temperature probe',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 5000,
    resetLimit: 9200,
    priority: 10,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const n = bits.bitsPerRow[row];
        if (n !== 36 && n !== 37)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        const raw = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
        if (raw === 0xffffffff || raw === 0)
            return DECODE_ABORT_EARLY;
        let chk = xorBytes(b, 4);
        chk = (chk >> 4) ^ (chk & 0x0f);
        if (chk !== 0)
            return DECODE_FAIL_MIC;
        const tempC = round1(signed12(((b[1] & 0x0f) << 12) | (b[2] << 4)) * 0.1);
        const moisture = (b[3] >> 4) * 10;
        if (tempC < -30 || tempC > 70)
            return DECODE_FAIL_SANITY;
        if (moisture > 100)
            return DECODE_FAIL_SANITY;
        const button = (b[1] >> 6) & 1;
        ctx.emit({
            model: 'Springfield-Soil',
            type: 'Weather',
            id: b[0],
            channel: ((b[1] >> 4) & 0x03) + 1,
            battery_ok: (b[1] >> 7) & 1 ? 0 : 1,
            temperature_C: tempC,
            moisture,
            button,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const ft004b = register({
    num: 92,
    name: 'FT-004-B Temperature Sensor',
    what: 'thermometer',
    modulation: 5,
    shortWidth: 1956,
    longWidth: 3900,
    gapLimit: 4000,
    resetLimit: 4000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n !== 137 && n !== 138)
            return DECODE_ABORT_LENGTH;
        const src = bits.bb[0];
        const msg = new Uint8Array(6);
        for (let i = 0; i < 6; i++) {
            const a = byteAt(src, i * 8);
            const b = byteAt(src, i * 8 + 46);
            const c = byteAt(src, i * 8 + 46 * 2);
            msg[i] = reverse8((a & b) | (b & c) | (a & c));
        }
        if (msg[0] !== 0xf4)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'FT-004B',
            type: 'Weather',
            temperature_C: round1((((msg[4] & 0x07) << 8) | msg[3]) * 0.05 - 40),
        });
        return 1;
    },
});
export const wssensor = register({
    num: 108,
    name: 'Hyundai WS SENZOR Remote Temperature Sensor',
    what: 'thermometer',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 2400,
    resetLimit: 4400,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(4, 23);
        if (r < 0 || bits.bitsPerRow[r] !== 24)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        if ((!b[0] && !b[1] && !b[2]) || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff)) {
            return DECODE_FAIL_SANITY;
        }
        ctx.emit({
            model: 'Hyundai-WS',
            type: 'Weather',
            id: b[2],
            channel: (b[1] & 0x03) + 1,
            battery_ok: (b[1] & 0x08) >> 3 ? 1 : 0,
            temperature_C: round2(signed12((b[0] << 8) | (b[1] & 0xf0)) * 0.1),
            button: (b[1] & 0x04) >> 2,
        });
        return 1;
    },
});
export const wt1024 = register({
    num: 109,
    name: 'WT0124 Pool Thermometer',
    what: 'pool thermometer',
    modulation: 6,
    shortWidth: 680,
    longWidth: 1850,
    resetLimit: 30000,
    gapLimit: 4000,
    syncWidth: 10000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 2)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[1] !== 49)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[1];
        if ((b[0] >> 4) !== 0x5)
            return DECODE_ABORT_EARLY;
        if (xorBytes(b, 4) !== b[4])
            return DECODE_FAIL_MIC;
        let sum = sumBytes(b, 4);
        sum += sum >> 8;
        sum += b[4];
        if ((sum & 0xff) !== b[5])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'WT0124-Pool',
            type: 'Weather',
            id: ((b[0] & 0x0f) << 4) | (b[1] & 0x0f),
            channel: (b[3] >> 4) & 0x03,
            temperature_C: round1(((((b[1] & 0x0f) << 8) | b[2]) - 0x990) * 0.1),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const missilMl0757 = register({
    num: 157,
    name: 'Missil ML0757 weather station',
    what: 'weather station: temperature, wind and rain',
    modulation: 5,
    shortWidth: 975,
    longWidth: 1950,
    gapLimit: 2500,
    resetLimit: 4500,
    tolerance: 100,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(5, 40);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] > 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[r] > 40)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        if ((b[4] & 0x0f) !== 0x0f)
            return DECODE_ABORT_EARLY;
        const f12 = ((b[2] << 4) | (b[3] >> 4)) & 0xfff;
        const f8 = (((b[3] & 0x0f) << 4) | (b[4] >> 4)) & 0xff;
        const data = {
            model: 'Missil-ML0757',
            type: 'Weather',
            id: b[0],
            battery_ok: b[1] & 0x80 ? 0 : 1,
        };
        if (b[1] & 0x04) {
            data.rain_mm = round2(f12 * 0.45);
            data.wind_avg_km_h = f8 === 0x00 ? 0 : f8 === 0x80 ? 1.4 : f8 === 0xc0 ? 2.8 : round2((f8 + 2) * 1.4);
        }
        else {
            data.temperature_C = round2(f12 & 0x800 ? (0x1000 - f12) * -0.1 : f12 * 0.1);
        }
        ctx.emit(data);
        return 1;
    },
});
export const sharpSpc775 = register({
    num: 158,
    name: 'Sharp SPC775 weather station',
    what: 'thermometer and hygrometer',
    modulation: 17,
    shortWidth: 225,
    longWidth: 425,
    gapLimit: 2900,
    resetLimit: 10000,
    bands: [915000000],
    decode(_dev, bits, ctx) {
        bits.invert();
        const r = bits.findRepeatedRow(2, 48);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        const pos = bits.search(r, 0, new Uint8Array([0xa5]), 8);
        if (pos + 6 * 8 > bits.bitsPerRow[r])
            return DECODE_FAIL_SANITY;
        const b = bits.bytes(r, pos, 6 * 8);
        const folded = Uint8Array.from([xorBytes(b, 5)]);
        if (lfsrDigest8Reflect(folded, 1, 0x31, 0x31) !== b[5])
            return DECODE_FAIL_MIC;
        const humidity = b[4];
        if (humidity > 100)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Sharp-SPC775',
            type: 'Weather',
            id: b[1],
            battery_ok: b[2] & 0x80 ? 0 : 1,
            temperature_C: round1(signed12(((b[2] & 0x0f) << 12) | (b[3] << 4)) * 0.1),
            humidity,
            mic: 'CRC',
        });
        return 1;
    },
});
