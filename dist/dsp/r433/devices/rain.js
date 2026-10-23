import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, addNibbles, crc8, reflectBytes, xorBytes } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;
const pad2 = (n) => n.toString().padStart(2, '0');
const int16 = (x) => (x << 16) >> 16;
export const btRain = register({
    num: 118,
    name: 'Biltema rain gauge',
    what: 'rain gauge',
    modulation: 5,
    shortWidth: 1940,
    longWidth: 3900,
    gapLimit: 4100,
    resetLimit: 8800,
    bands: BAND_433,
    disabled: true,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(4, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 36 && bits.bitsPerRow[row] !== 37)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff)
            return DECODE_FAIL_SANITY;
        const id = b[0];
        const battery = b[1] >> 7;
        const channel = ((b[1] & 0x30) >> 4) + 1;
        const button = (b[1] & 0x08) >> 3;
        const tempC = (int16(((b[1] & 0x07) << 13) | (b[2] << 5)) >> 5) * 0.1;
        let rain = ((b[1] & 0x07) << 4) | b[3];
        const rest = rain % 25;
        if (rest % 2)
            rain += Math.floor(rest / 2) * 2048;
        else
            rain += Math.floor((rest + 1) / 2) * 2048 + 12 * 2048;
        ctx.emit({
            model: 'Biltema-Rain',
            type: 'Weather',
            id,
            channel,
            battery_ok: battery ? 0 : 1,
            transmit: button ? 'MANUAL' : 'AUTO',
            temperature_C: round1(tempC),
            rain_rate_mm_h: round2(rain * 0.052),
            button,
        });
        return 1;
    },
});
export const rainpoint = register({
    num: 195,
    name: 'RainPoint soil temperature and moisture sensor',
    what: 'soil temperature and moisture probe',
    modulation: 4,
    shortWidth: 500,
    longWidth: 500,
    resetLimit: 1500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 232 || bits.bitsPerRow[0] > 3000) {
            return DECODE_ABORT_EARLY;
        }
        const pos = bits.search(0, 0, new Uint8Array([0xaa, 0xa9]), 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const start = pos + 16 - 2;
        const msg = new BitBuffer();
        const end = bits.manchesterDecode(0, start, msg, 12 * 8);
        if (end - start !== 12 * 2 * 8)
            return DECODE_ABORT_LENGTH;
        msg.invert();
        const b = msg.bb[0];
        reflectBytes(b, 12);
        if (addNibbles(b, 10) !== b[10])
            return DECODE_FAIL_MIC;
        const flags = b[4];
        const chan = flags === 0x9f ? 1 : flags === 0xb1 ? 2 : flags === 0xb7 ? 3 : 0;
        ctx.emit({
            model: 'RainPoint-Soil',
            type: 'Weather',
            id: (b[2] << 8) | b[3],
            channel: chan,
            sync: (b[0] << 8) | b[1],
            flags,
            status: (b[5] << 8) | b[6],
            temperature_C: (b[7] << 24) >> 24,
            moisture: b[8],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
function pwmOfPcmDecode(row, bitLen, out, outLen) {
    let pos = 0;
    let cnt = 0;
    for (let i = 0; i < bitLen; i++) {
        if (row[i >> 3] & (1 << (7 - (i % 8)))) {
            cnt++;
            continue;
        }
        if (pos % 8 === 0)
            out[pos >> 3] = 0;
        if (cnt === 1)
            pos++;
        else if (cnt === 3) {
            out[pos >> 3] |= 1 << (7 - (pos % 8));
            pos++;
        }
        else
            break;
        if (pos >= outLen)
            break;
        cnt = 0;
    }
    return pos;
}
export const atechWs308 = register({
    num: 196,
    name: 'Atech-WS308 temperature sensor',
    what: 'thermometer',
    modulation: 4,
    shortWidth: 1600,
    longWidth: 1832,
    gapLimit: 2500,
    resetLimit: 9000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 2)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[1] < 58)
            return DECODE_ABORT_LENGTH;
        const b = new Uint8Array(4);
        const len = pwmOfPcmDecode(bits.bb[1], bits.bitsPerRow[1], b, 32);
        if (len < 28)
            return DECODE_ABORT_LENGTH;
        let chk = xorBytes(b, 3);
        chk = ((chk ^ b[3]) >> 4) ^ (chk & 0x0f);
        if (chk !== 0)
            return DECODE_FAIL_MIC;
        const tempRaw = ((b[1] & 0x0f) * 100) + ((b[2] >> 4) * 10) + (b[2] & 0x0f);
        const sign = (b[1] & 0x20) ? -1 : 1;
        const tempC = round1(sign * tempRaw * 0.1) + 0;
        ctx.emit({
            model: 'Atech-WS308',
            type: 'Weather',
            id: b[0],
            temperature_C: tempC,
            mic: 'PARITY',
        });
        return 1;
    },
});
export const emosE6016 = register({
    num: 214,
    name: 'EMOS E6016 weatherstation with DCF77, EMOS E6018 temperature/humidity sensor',
    what: 'weather station with a radio clock',
    modulation: 6,
    shortWidth: 280,
    longWidth: 796,
    gapLimit: 3000,
    resetLimit: 850,
    syncWidth: 1836,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedPrefix(3, 120 - 8);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 120)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] !== 0x55 || b[1] !== 0x5a || b[2] !== 0x7c)
            return DECODE_ABORT_EARLY;
        bits.invert();
        if (addBytes(b, 13) !== b[13])
            return DECODE_FAIL_MIC;
        const variant = (b[4] >> 6) & 0x03;
        const isE6018 = variant !== 2;
        const dt = (((b[4] & 0x3f) << 26) | (b[5] << 18) | (b[6] << 10) | (b[7] << 2) | (b[8] >> 6)) >>> 0;
        const clock = `${((dt >>> 26) & 0x3f) + 2000}-${pad2((dt >>> 22) & 0x0f)}-${pad2((dt >>> 17) & 0x1f)}`
            + `T${pad2((dt >>> 12) & 0x1f)}:${pad2((dt >>> 6) & 0x3f)}:${pad2(dt & 0x3f)}`;
        const tempC = (int16(((b[8] & 0x0f) << 12) | (b[9] << 4)) >> 4) * 0.1;
        ctx.emit({
            model: isE6018 ? 'EMOS-E6018' : 'EMOS-E6016',
            type: 'Weather',
            id: b[3],
            channel: ((b[8] >> 4) & 0x03) + 1,
            battery_ok: (b[12] >> 2) & 0x01,
            temperature_C: round1(tempC),
            humidity: b[10],
            ...(isE6018 ? {} : {
                wind_avg_m_s: round1(b[11] * 0.295),
                wind_dir_deg: round1((b[12] >> 4) * 22.5),
                radio_clock: clock,
            }),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const emosE6016Rain = register({
    num: 217,
    name: 'EMOS E6016 rain gauge',
    what: 'rain gauge',
    modulation: 6,
    shortWidth: 300,
    longWidth: 800,
    gapLimit: 1000,
    resetLimit: 2500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 72);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] < 72 || bits.bitsPerRow[row] > 73)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] !== 0x55 || b[1] !== 0x5a || b[2] !== 0x75)
            return DECODE_ABORT_EARLY;
        bits.invert();
        if (addBytes(b, 8) !== b[8])
            return DECODE_FAIL_MIC;
        const rainRaw = ((b[6] & 0x0f) << 8) | b[7];
        ctx.emit({
            model: 'EMOS-E6016R',
            type: 'Weather',
            id: b[3],
            battery_ok: (b[4] >> 6) ? 1 : 0,
            rain_mm: round1(rainRaw * 0.7),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const rubicsonPool48942 = register({
    num: 222,
    name: 'Rubicson Pool Thermometer 48942',
    what: 'pool thermometer',
    modulation: 6,
    shortWidth: 280,
    longWidth: 480,
    gapLimit: 5000,
    resetLimit: 6000,
    syncWidth: 730,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 41);
        if (row < 0 || bits.bitsPerRow[row] !== 41)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        bits.invert();
        if ((b[3] & 0x0f) || b[5])
            return DECODE_ABORT_EARLY;
        if (b[0] === 0 && b[2] === 0 && b[4] === 0)
            return DECODE_ABORT_EARLY;
        if (crc8(b, 4, 0x31, 0x00) !== b[4])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Rubicson-48942',
            type: 'Weather',
            channel: (b[0] >> 4) + 1,
            id: ((b[0] & 0x0f) << 6) | ((b[1] & 0xfc) >> 2),
            battery_ok: (b[2] >> 7) ? 0 : 1,
            temperature_C: round1(((((b[2] & 0x7f) << 4) | (b[3] >> 4)) - 1024) * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
export const baldrRain = register({
    num: 242,
    name: 'Baldr / RainPoint rain gauge',
    what: 'rain gauge',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3000,
    resetLimit: 5000,
    bands: BAND_433,
    priority: 10,
    disabled: true,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 37)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if ((b[0] === 0 && b[2] === 0 && b[3] === 0)
            || (b[0] === 0xff && b[2] === 0xff && b[3] === 0xff))
            return DECODE_ABORT_EARLY;
        ctx.emit({
            model: 'Baldr-Rain',
            type: 'Weather',
            id: (b[0] << 4) | (b[1] >> 4),
            flags: b[1] & 0x0f,
            rain_in: round3(((b[2] << 12) | (b[3] << 4) | (b[4] >> 4)) * 0.001),
        });
        return 1;
    },
});
export const schou72543Rain = register({
    num: 250,
    name: 'Schou 72543 Day Rain Gauge, Motonet MTX, MarQuant, TFA Dostmann 30.3252.01, ADE WS1907',
    what: 'rain gauge and thermometer',
    modulation: 6,
    shortWidth: 972,
    longWidth: 2680,
    syncWidth: 7328,
    resetLimit: 2712,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 2)
            return DECODE_ABORT_LENGTH;
        const row = bits.findRepeatedPrefix(2, 64);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[row];
        const chk = b[7];
        let sum = 0;
        for (let i = 0; i < 7; i++)
            sum += b[i];
        if (sum === 0)
            return DECODE_ABORT_EARLY;
        if (chk !== (sum & 0xff))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Schou-72543',
            type: 'Weather',
            id: (b[0] << 8) | b[1],
            temperature_F: round1((((b[6] << 8) | b[5]) - 900) * 0.1),
            rain_mm: round1(((b[4] << 8) | b[3]) * 0.1),
            battery_ok: (b[2] & 0x80) ? 0 : 1,
            msg_counter: (b[2] & 0x0e) >> 1,
            msg_repeat: (b[2] & 0x40) ? 1 : 0,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const baldrTherm = register({
    num: 284,
    name: 'Baldr E0666TH Thermo-Hygrometer',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3000,
    resetLimit: 5000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(8, 64);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 65)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if ((b[1] & 0x40) !== 0x00 || (b[3] & 0xf0) !== 0xf0
            || (b[4] & 0x0f) !== 0x00 || b[5] !== 0x00 || (b[6] & 0xf7) !== 0x00) {
            return DECODE_ABORT_EARLY;
        }
        const tempC = (int16((b[1] << 12) | (b[2] << 4)) >> 4) * 0.1;
        ctx.emit({
            model: 'Baldr-E0666TH',
            type: 'Weather',
            id: (b[0] << 8) | b[7],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (b[1] & 0x80) ? 1 : 0,
            temperature_C: round1(tempC),
            humidity: ((b[3] << 4) | (b[4] >> 4)) & 0xff,
            startup: (b[6] & 0x08) ? 1 : 0,
        });
        return 1;
    },
});
