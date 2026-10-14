import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8 } from '../util.js';
const SYNC = new Uint8Array([0xd2, 0xaa, 0x2d, 0xd4]);
const BANDS = [433920000, 868300000, 915000000];
const round1 = (x) => Math.round(x * 10) / 10;
const hex6 = (v) => v.toString(16).padStart(6, '0');
export const lacrosseTh3 = register({
    num: 171,
    name: 'LaCrosse View LTV-TH thermo-hygro sensor',
    what: 'outdoor temperature and humidity',
    modulation: 16,
    shortWidth: 104,
    longWidth: 104,
    resetLimit: 9600,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 156 || n > 290)
            return DECODE_ABORT_LENGTH;
        const model = n < 280 ? 3 : 2;
        const at = bits.search(0, 0, SYNC, 32);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, at + 32, 8 * 8);
        if (crc8(b, 8, 0x31, 0x00) !== 0 && crc8(b, 8, 0x31, 0xac) !== 0 && crc8(b, 8, 0x31, 0xb2) !== 0) {
            return DECODE_FAIL_MIC;
        }
        const rawTemp = (b[4] << 4) | ((b[5] & 0xf0) >> 4);
        const humidity = ((b[5] & 0x0f) << 8) | b[6];
        const tempC = (rawTemp - 400) * 0.1;
        if (humidity > 100 || tempC < -50 || tempC > 70)
            return DECODE_FAIL_SANITY;
        const flags = b[3] & 0x31;
        const retrans = (b[3] & 0x40) >> 6;
        const data = {
            model: model === 3 ? 'LaCrosse-TH3' : 'LaCrosse-TH2',
            id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
            battery_ok: (b[3] & 0x80) >> 7 ? 0 : 1,
            seq: (b[3] & 0x0e) >> 1,
            temperature_C: round1(tempC),
            humidity,
            mic: 'CRC',
        };
        if (retrans)
            data.retransmit = retrans;
        if (flags)
            data.flags = flags;
        ctx.emit(data);
        return 1;
    },
});
export const lacrosseR1 = register({
    num: 175,
    name: 'LaCrosse View LTV-R1, LTV-R3 rain gauge and LTV-W1/W2 wind sensor',
    what: 'rain gauge or wind sensor',
    modulation: 16,
    shortWidth: 104,
    longWidth: 104,
    resetLimit: 9600,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        if (n < 170 || n > 272)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC, 32);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, at + 32, 20 * 8);
        let rev = 1;
        let chk = crc8(b, 11, 0x31, 0x00);
        if (chk === 0 && b[4] === 0xaa && b[5] === 0xaa && b[6] === 0xaa && (b[8] & 0x0f) === 0x0a && b[9] === 0xaa) {
            rev = 9;
        }
        else if (chk === 0 && b[10] !== 0) {
            rev = 3;
        }
        else {
            chk = crc8(b, 8, 0x31, 0x00);
            if (b[10] !== 0 || chk !== 0)
                return DECODE_FAIL_MIC;
        }
        const data = {
            model: rev === 1 ? 'LaCrosse-R1' : rev === 3 ? 'LaCrosse-R3' : 'LaCrosse-W1',
            id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
            battery_ok: (b[3] & 0x80) >> 7 ? 0 : 1,
            seq: (b[3] & 0x0e) >> 1,
            mic: 'CRC',
        };
        const startup = (b[3] & 0x40) >> 6;
        const flags = b[3] & 0x31;
        if (startup)
            data.startup = startup;
        if (flags)
            data.flags = flags;
        if (rev !== 9) {
            data.rain_mm = Math.round((((b[5] ^ 0xaa) << 16) | (b[4] << 8) | b[6]) * 0.25 * 100) / 100;
        }
        if (rev === 3) {
            data.rain2_mm = Math.round((((b[8] ^ 0xaa) << 16) | (b[7] << 8) | b[9]) * 0.25 * 100) / 100;
        }
        if (rev === 9) {
            data.wind_avg_km_h = round1(((b[7] << 4) | (b[8] >> 4)) * 0.1);
        }
        ctx.emit(data);
        return 1;
    },
});
export const lacrosseWr1 = register({
    num: 170,
    name: 'LaCrosse View LTV-WR1 multi sensor',
    what: 'wind and rain sensor',
    modulation: 16,
    shortWidth: 104,
    longWidth: 104,
    resetLimit: 9600,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 120 || n > 156)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC, 32);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, at + 32, 11 * 8);
        if (crc8(b, 11, 0x31, 0x00))
            return DECODE_FAIL_MIC;
        const rawWind = (b[4] << 4) | ((b[5] & 0xf0) >> 4);
        const direction = ((b[5] & 0x0f) << 8) | b[6];
        const speed = rawWind * 0.1;
        if (speed > 200 || direction > 360)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'LaCrosse-WR1',
            id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
            seq: (b[3] & 0x0e) >> 1,
            flags: b[3] & 0xf1,
            wind_avg_km_h: round1(speed),
            wind_dir_deg: direction,
            rain1: ((b[7] << 4) | ((b[8] & 0xf0) >> 4)).toString(16).padStart(3, '0'),
            rain2: (((b[8] & 0x0f) << 8) | b[9]).toString(16).padStart(3, '0'),
            mic: 'CRC',
        });
        return 1;
    },
});
export const lacrosseBreezePro = register({
    num: 166,
    name: 'LaCrosse View LTV-WSDTH01 Breeze Pro wind sensor',
    what: 'wind, temperature and humidity',
    modulation: 16,
    shortWidth: 107,
    longWidth: 107,
    resetLimit: 5900,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 264)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC, 32);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, at + 32, 11 * 8);
        if (crc8(b, 11, 0x31, 0x00))
            return DECODE_FAIL_MIC;
        const tempC = (((b[4] << 4) | ((b[5] & 0xf0) >> 4)) - 400) * 0.1;
        const humidity = ((b[5] & 0x0f) << 8) | b[6];
        const speed = ((b[7] << 4) | ((b[8] & 0xf0) >> 4)) * 0.1;
        const direction = ((b[8] & 0x0f) << 8) | b[9];
        if (humidity > 100 || tempC < -40 || tempC > 70 || direction > 360 || speed > 200) {
            return DECODE_FAIL_SANITY;
        }
        ctx.emit({
            model: 'LaCrosse-BreezePro',
            id: hex6((b[0] << 16) | (b[1] << 8) | b[2]),
            seq: (b[3] & 0x0e) >> 1,
            flags: b[3] & 0xf1,
            temperature_C: round1(tempC),
            humidity,
            wind_avg_km_h: round1(speed),
            wind_dir_deg: direction,
            mic: 'CRC',
        });
        return 1;
    },
});
