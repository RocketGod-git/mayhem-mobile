import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, lfsrDigest8 } from '../util.js';
const round1 = (x) => Math.round(x * 10) / 10;
const hex2 = (v) => v.toString(16).padStart(2, '0');
const two = (v) => String(v).padStart(2, '0');
function signed(v, bits) {
    const shift = 32 - bits;
    return (v << shift) >> shift;
}
export const ambientWeather = register({
    num: 20,
    name: 'Ambient Weather F007TH, TFA 30.3208.02, SwitchDocLabs F016TH temperature sensor',
    what: 'outdoor thermometer, very common in North America',
    modulation: 3,
    shortWidth: 500,
    longWidth: 0,
    resetLimit: 2400,
    bands: [433920000, 915000000],
    decode(_dev, bits, ctx) {
        const one = (row, at) => {
            const b = bits.bytes(row, at, 48);
            if (b[5] !== (lfsrDigest8(b, 5, 0x98, 0x3e) ^ 0x64))
                return DECODE_FAIL_MIC;
            const humidity = b[4];
            const tempF = ((((b[2] & 0x0f) << 8) | b[3]) - 400) * 0.1;
            if (humidity > 100)
                return DECODE_FAIL_SANITY;
            if (tempF < -40 || tempF >= 344)
                return DECODE_FAIL_SANITY;
            ctx.emit({
                model: 'Ambientweather-F007TH',
                id: b[1],
                channel: ((b[2] & 0x70) >> 4) + 1,
                battery_ok: (b[2] & 0x80) !== 0 ? 0 : 1,
                temperature_F: round1(tempF),
                humidity,
                mic: 'CRC',
            });
            return 1;
        };
        const PRE = new Uint8Array([0x01, 0x45]);
        const PRE_INV = new Uint8Array([0xfd, 0x45]);
        let ret = 0;
        for (let row = 0; row < bits.numRows; row++) {
            let at = 0;
            while ((at = bits.search(row, at, PRE, 12)) + 8 + 48 <= bits.bitsPerRow[row]) {
                ret = one(row, at + 8);
                if (ret > 0)
                    return ret;
                at += 16;
            }
            at = 0;
            while ((at = bits.search(row, at, PRE_INV, 12)) + 8 + 48 <= bits.bitsPerRow[row]) {
                ret = one(row, at + 8);
                if (ret > 0)
                    return ret;
                at += 15;
            }
        }
        return ret;
    },
});
export const ambientWeatherWh31e = register({
    num: 113,
    name: 'Ambient Weather WH31E thermo-hygrometer, EcoWitt WH40/WN20 rain gauge, WS68 weather station',
    what: 'thermometers, rain gauges, an anemometer array and a radio clock',
    modulation: 16,
    shortWidth: 56,
    longWidth: 56,
    gapLimit: 1800,
    resetLimit: 1500,
    bands: [433920000, 868300000, 915000000],
    decode(_dev, bits, ctx) {
        const PRE = new Uint8Array([0xaa, 0x2d, 0xd4]);
        let events = 0;
        for (let row = 0; row < bits.numRows; row++) {
            const start = bits.search(row, 0, PRE, 24);
            if (start === bits.bitsPerRow[row])
                continue;
            const b = bits.bytes(row, start + 24, 18 * 8);
            const msgType = b[0];
            const checked = (n) => crc8(b, n, 0x31, 0x00) === 0 && ((addBytes(b, n) - b[n]) & 0xff) === 0;
            const extra = (from, count) => {
                let s = '';
                for (let i = 0; i < count; i++)
                    s += hex2(b[from + i]);
                return s;
            };
            if (msgType === 0x30 || msgType === 0x37) {
                if (!checked(6))
                    continue;
                ctx.emit({
                    model: msgType === 0x30 ? 'AmbientWeather-WH31E' : 'AmbientWeather-WH31B',
                    id: b[1],
                    channel: ((b[2] & 0x70) >> 4) + 1,
                    battery_ok: ((b[2] & 0x04) >> 2) ? 0 : 1,
                    temperature_C: round1(((((b[2] & 0x03) << 8) | b[3]) - 400) * 0.1),
                    humidity: b[4],
                    data: extra(6, 5),
                    mic: 'CRC',
                });
                events++;
            }
            else if (msgType === 0x52) {
                if (!checked(10))
                    continue;
                const year = ((b[3] & 0xf0) >> 4) * 10 + (b[3] & 0x0f) + 2000;
                ctx.emit({
                    model: 'AmbientWeather-WH31E',
                    id: b[1],
                    data: b[2],
                    radio_clock: `${year}-${two(((b[4] & 0x10) >> 4) * 10 + (b[4] & 0x0f))}`
                        + `-${two(((b[5] & 0x30) >> 4) * 10 + (b[5] & 0x0f))}`
                        + `T${two(((b[6] & 0x30) >> 4) * 10 + (b[6] & 0x0f))}`
                        + `:${two(((b[7] & 0x70) >> 4) * 10 + (b[7] & 0x0f))}`
                        + `:${two(((b[8] & 0x70) >> 4) * 10 + (b[8] & 0x0f))}Z`,
                    mic: 'CRC',
                });
                events++;
            }
            else if (msgType === 0x40) {
                if (!checked(8))
                    continue;
                const battV = b[4] & 0x1f;
                const level = Math.min(100, battV <= 9 ? 0 : Math.floor(100 * (battV - 9) / 6));
                const out = {
                    model: 'EcoWitt-WH40',
                    id: ((b[1] & 0x0f) << 16) | (b[2] << 8) | b[3],
                    rain_mm: round1(((b[5] << 8) | b[6]) * 0.1),
                    data: extra(9, 5),
                    mic: 'CRC',
                };
                if (battV !== 0) {
                    out.battery_V = round1(battV * 0.1);
                    out.battery_ok = level / 100;
                }
                ctx.emit(out);
                events++;
            }
            else if (msgType === 0x20) {
                if (!checked(9))
                    continue;
                const raw = b[4];
                const level = Math.min(100, raw <= 90 ? 0 : Math.floor(100 * (raw - 90) / 60));
                ctx.emit({
                    model: 'EcoWitt-WN20',
                    id: (b[2] << 8) | b[3],
                    battery_V: Math.round(raw * 0.02 * 100) / 100,
                    battery_ok: level > 0 ? 1 : 0,
                    battery_pct: level,
                    rain_mm: round1(((b[5] << 8) | b[6]) * 0.1),
                    data: extra(10, 5),
                    mic: 'CRC',
                });
                events++;
            }
            else if (msgType === 0x68) {
                if (!checked(15))
                    continue;
                ctx.emit({
                    model: 'EcoWitt-WS68',
                    id: (b[2] << 8) | b[3],
                    battery_raw: b[6],
                    battery_ok: b[6] > 0x20 ? 1 : 0,
                    light_lux: ((b[4] << 8) | b[5]) * 10,
                    wind_avg_m_s: round1((((b[7] & 0x10) << 4) | b[10]) * 0.1),
                    wind_max_m_s: round1((((b[7] & 0x40) << 2) | b[12]) * 0.1),
                    wind_dir_deg: ((b[7] & 0x20) << 3) | b[11],
                    uvi: Math.trunc(b[13] * 0.1),
                    data: hex2(b[16]) + (b[17] >> 4).toString(16),
                    mic: 'CRC',
                });
                events++;
            }
        }
        return events;
    },
});
export const gtWt02 = register({
    num: 25,
    name: 'Globaltronics GT-WT-02 sensor',
    what: 'outdoor temperature and humidity sensor',
    modulation: 5,
    shortWidth: 2500,
    longWidth: 5000,
    gapLimit: 8000,
    resetLimit: 12000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 2)
            return DECODE_ABORT_LENGTH;
        for (let row = 0; row < bits.numRows; row++) {
            let b;
            if (bits.bitsPerRow[row] === 39)
                b = bits.bytes(row, 2, 37);
            else if (bits.bitsPerRow[row] === 37)
                b = bits.bb[row];
            else
                continue;
            if (!(b[0] || b[1] || b[2] || b[3] || b[4]))
                continue;
            const sum = (b[0] >> 4) + (b[0] & 0x0f) + (b[1] >> 4) + (b[1] & 0x0f)
                + (b[2] >> 4) + (b[2] & 0x0f) + (b[3] >> 4) + (b[3] & 0x0e);
            if ((sum & 0x3f) !== (((b[3] & 1) << 5) + (b[4] >> 3)))
                continue;
            const channel = (b[1] >> 4) & 3;
            if (channel > 2)
                continue;
            const tempC = (signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4) * 0.1;
            if (tempC < -20 || tempC > 60)
                continue;
            const raw = b[3] >> 1;
            if (raw !== 10 && raw !== 110 && (raw < 20 || raw > 90))
                continue;
            const humidity = raw === 10 ? 0 : raw === 110 ? 100 : raw;
            ctx.emit({
                model: 'GT-WT02',
                id: b[0],
                channel: channel + 1,
                battery_ok: ((b[1] >> 7) & 1) ? 0 : 1,
                temperature_C: round1(tempC),
                humidity,
                button: (b[1] >> 6) & 1,
                mic: 'CHECKSUM',
            });
            return 1;
        }
        return 0;
    },
});
export const gtWt03 = register({
    num: 138,
    name: 'Globaltronics GT-WT-03 sensor',
    what: 'outdoor temperature and humidity sensor',
    modulation: 6,
    shortWidth: 256,
    longWidth: 625,
    syncWidth: 855,
    gapLimit: 1000,
    resetLimit: 61000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        let row = 0;
        if (bits.numRows > 1)
            row = bits.findRepeatedRow(((bits.numRows / 2) | 0) + 1, 41);
        if (row < 0)
            return DECODE_ABORT_LENGTH;
        if (bits.bitsPerRow[row] !== 41)
            return DECODE_ABORT_LENGTH;
        bits.invert();
        const b = bits.bb[row];
        if (!(b[0] || b[1] || b[2] || b[3] || b[4]))
            return DECODE_ABORT_EARLY;
        let sum = 0;
        for (let k = 0; k < 4; k++) {
            let key = 0x3100;
            for (let i = 7; i >= 0; i--) {
                if ((b[k] >> i) & 1)
                    sum ^= key & 0xff;
                key >>= 1;
            }
        }
        if ((sum ^ b[4] ^ 0x2d) !== 0)
            return DECODE_FAIL_MIC;
        const tempC = (signed(((b[2] & 0x0f) << 12) | (b[3] << 4), 16) >> 4) * 0.1;
        if (tempC <= -50.2 || tempC >= 70.2)
            return DECODE_FAIL_SANITY;
        const raw = b[1];
        if (raw !== 10 && raw !== 110 && (raw < 20 || raw > 95))
            return DECODE_FAIL_SANITY;
        const humidity = raw === 10 ? 0 : raw === 110 ? 100 : raw;
        ctx.emit({
            model: 'GT-WT03',
            id: b[0],
            channel: ((b[2] >> 4) & 3) + 1,
            battery_ok: ((b[2] >> 7) & 1) ? 0 : 1,
            temperature_C: round1(tempC),
            humidity,
            button: (b[2] >> 6) & 1,
            mic: 'CRC',
        });
        return 1;
    },
});
