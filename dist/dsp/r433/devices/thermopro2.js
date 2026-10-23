import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, lfsrDigest8 } from '../util.js';
const BANDS = [433920000];
const SYNC = new Uint8Array([0x55, 0x2d, 0xd4]);
const SYNC_D2AA = new Uint8Array([0xd2, 0xaa, 0x2d, 0xd4]);
const SYNC_D255 = new Uint8Array([0xd2, 0x55, 0x2d, 0xd4]);
const round1 = (x) => Math.round(x * 10) / 10;
const s16 = (x) => ((x & 0xffff) << 16) >> 16;
const allSame = (b, n, v) => {
    for (let i = 0; i < n; i++)
        if (b[i] !== v)
            return false;
    return true;
};
export const thermoproTx2 = register({
    num: 162,
    name: 'ThermoPro TX-2 temperature sensor',
    what: 'outdoor thermometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 7000,
    resetLimit: 10000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] <= 8 && bits.bitsPerRow[0] !== 0)
            return DECODE_ABORT_EARLY;
        const row = bits.findRepeatedRow(4, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 37)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if ((b[0] & 0xf0) !== 0x90 && (b[0] & 0xf0) !== 0x50)
            return DECODE_FAIL_SANITY;
        const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
        const data = {
            model: 'Thermopro-TX2',
            subtype: b[0] >> 4,
            id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
            channel: (b[1] & 0x03) + 1,
            battery_ok: b[1] & 0x08 ? 0 : 1,
            temperature_C: Math.round((s16((b[2] << 8) | (b[3] & 0xf0)) >> 4) * 0.1 * 100) / 100,
            button: (b[1] & 0x04) >> 2,
        };
        if (humidity !== 0xcc)
            data.humidity = humidity;
        ctx.emit(data);
        return 1;
    },
});
const TP211B_XOR = [
    0xc881, 0xc441, 0xc221, 0xc111, 0xc089, 0xc045, 0xc023, 0xc010,
    0xc01f, 0xc00e, 0x6007, 0x9002, 0x4801, 0x8401, 0xe201, 0xd101,
    0xde01, 0xcf01, 0xc781, 0xc3c1, 0xc1e1, 0xc0f1, 0xc079, 0xc03d,
    0xc029, 0xc015, 0xc00b, 0xc004, 0x6002, 0x3001, 0xb801, 0xfc01,
    0xe801, 0xd401, 0xca01, 0xc501, 0xc281, 0xc141, 0xc0a1, 0xc051,
    0xc061, 0xc031, 0xc019, 0xc00d, 0xc007, 0xc002, 0x6001, 0x9001,
];
function tp211bChecksum(b) {
    let sum = 0x411b;
    for (let n = 0; n < 6; n++) {
        for (let i = 0; i < 8; i++) {
            if ((b[n] << (i + 1)) & 0x100)
                sum ^= TP211B_XOR[n * 8 + i];
        }
    }
    return sum & 0xffff;
}
export const thermoproTp211b = register({
    num: 297,
    name: 'ThermoPro TP211B thermometer',
    what: 'probe thermometer',
    modulation: 16,
    shortWidth: 105,
    longWidth: 105,
    resetLimit: 1500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        const at = bits.search(0, 0, SYNC, 24);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        if (n - at < 64)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at + 24, 64);
        if (b[5] !== 0xaa)
            return DECODE_FAIL_SANITY;
        if (allSame(b, 5, 0x00) || allSame(b, 5, 0xff))
            return DECODE_FAIL_SANITY;
        if (((b[6] << 8) | b[7]) !== tp211bChecksum(b))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'ThermoPro-TP211B',
            id: ((b[0] << 16) | (b[1] << 8) | b[2]).toString(16).padStart(6, '0'),
            battery_ok: (b[3] & 0x80) >> 7 ? 0 : 1,
            temperature_C: round1(((((b[3] & 0x0f) << 8) | b[4]) - 500) * 0.1),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const bcd2 = (lo, hi) => ((hi & 0xf0) >> 4) * 100 + (hi & 0x0f) * 10 + ((lo & 0xf0) >> 4) + (lo & 0x0f) * 0.1;
export const thermoproTp28b = register({
    num: 256,
    name: 'ThermoPro TP28b long-range meat thermometer',
    what: 'smoker thermometer, two probes with alarms',
    modulation: 16,
    shortWidth: 105,
    longWidth: 105,
    resetLimit: 5500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        if (n < 240 || n > 451)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC_D2AA, 32);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, at + 32, 18 * 8);
        if (((addBytes(b, 16) & 0xff) - b[16]) & 0xff)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'ThermoPro-TP28b',
            id: ((b[14] << 8) | b[15]).toString(16).padStart(4, '0'),
            temperature_1_C: round1(bcd2(b[0], b[1])),
            alarm_high_1_C: round1(bcd2(b[2], b[3])),
            alarm_low_1_C: round1(bcd2(b[4], b[5])),
            temperature_2_C: round1(bcd2(b[6], b[7])),
            alarm_high_2_C: round1(bcd2(b[8], b[9])),
            alarm_low_2_C: round1(bcd2(b[10], b[11])),
            flags: ((b[12] << 8) | b[13]).toString(16).padStart(4, '0'),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
function reversedBytes(b, n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++)
        out[i] = b[n - 1 - i];
    return out;
}
const NO_PROBE = 0xedd, NO_ALARM = 0xeaa;
const probeC = (raw) => round1((raw - 500) * 0.1);
const displayUnit = (v) => (v === 0x2 ? 'Fahrenheit' : v === 0x0 ? 'Celsius' : '');
export const thermoproTp828b = register({
    num: 267,
    name: 'ThermoPro TP828B meat thermometer, two probes with high and low targets',
    what: 'barbecue thermometer',
    modulation: 16,
    shortWidth: 102,
    longWidth: 102,
    resetLimit: 1500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        if (n > 280)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC, 24);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        if (n - at < 96)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at + 24, 12 * 8);
        if ((lfsrDigest8(reversedBytes(b, 11), 11, 0x98, 0x16) ^ 0xac) !== b[11])
            return DECODE_FAIL_MIC;
        const p1 = (b[2] << 4) | ((b[3] & 0xf0) >> 4);
        const p1lo = ((b[3] & 0x0f) << 8) | b[4];
        const p1hi = (b[5] << 4) | ((b[6] & 0xf0) >> 4);
        const p2 = ((b[6] & 0x0f) << 8) | b[7];
        const p2lo = (b[8] << 4) | ((b[9] & 0xf0) >> 4);
        const p2hi = ((b[9] & 0x0f) << 8) | b[10];
        const data = {
            model: 'ThermoPro-TP828b',
            id: b[0].toString(16).padStart(2, '0'),
            flags: (b[1] & 0x0f).toString(16),
            temperature_1_HI_C: probeC(p1hi),
            temperature_2_HI_C: probeC(p2hi),
            mic: 'CHECKSUM',
        };
        const unit = displayUnit((b[1] & 0xf0) >> 4);
        if (unit)
            data.display_u = unit;
        if (p1 !== NO_PROBE)
            data.temperature_1_C = probeC(p1);
        if (p1lo !== NO_ALARM)
            data.temperature_1_LO_C = probeC(p1lo);
        if (p2 !== NO_PROBE)
            data.temperature_2_C = probeC(p2);
        if (p2lo !== NO_ALARM)
            data.temperature_2_LO_C = probeC(p2lo);
        ctx.emit(data);
        return 1;
    },
});
export const thermoproTp829b = register({
    num: 259,
    name: 'ThermoPro TP829B meat thermometer, four probes',
    what: 'barbecue thermometer',
    modulation: 16,
    shortWidth: 102,
    longWidth: 102,
    resetLimit: 1500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        if (n > 260)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC, 24);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        if (n - at < 96)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at + 24, 9 * 8);
        if (b[5] === 0xaa && b[6] === 0x55 && b[7] === 0xaa && b[8] === 0)
            return DECODE_ABORT_EARLY;
        if (lfsrDigest8(reversedBytes(b, 8), 8, 0x98, 0x55) !== b[8])
            return DECODE_FAIL_MIC;
        const raw = [
            (b[2] << 4) | ((b[3] & 0xf0) >> 4),
            ((b[3] & 0x0f) << 8) | b[4],
            (b[5] << 4) | ((b[6] & 0xf0) >> 4),
            ((b[6] & 0x0f) << 8) | b[7],
        ];
        const data = {
            model: 'ThermoPro-TP829b',
            id: b[0].toString(16).padStart(2, '0'),
            flags: (b[1] & 0x0f).toString(16),
            mic: 'CHECKSUM',
        };
        const unit = displayUnit((b[1] & 0xf0) >> 4);
        if (unit)
            data.display_u = unit;
        for (let i = 0; i < 4; i++)
            if (raw[i] !== NO_PROBE)
                data[`temperature_${i + 1}_C`] = probeC(raw[i]);
        ctx.emit(data);
        return 1;
    },
});
export const thermoproTp86xb = register({
    num: 294,
    name: 'ThermoPro TempSpike XR TP862b / TP863b dual-probe meat thermometer',
    what: 'wireless meat probe with a booster',
    modulation: 16,
    shortWidth: 104,
    longWidth: 104,
    resetLimit: 2000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        if (n < 165 || n > 173)
            return DECODE_ABORT_LENGTH;
        const at = bits.search(0, 0, SYNC_D255, 32);
        if (at >= n)
            return DECODE_ABORT_EARLY;
        if (n - (at + 32) < 72)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at + 32, 9 * 8);
        if ((b[7] & b[8]) !== 0)
            return DECODE_FAIL_MIC;
        if ((crc8(b, 7, 0x07, 0x00) ^ 0xdb) !== b[7])
            return DECODE_FAIL_MIC;
        const isProbe = (b[6] & 0x0c) === 0x0c;
        const isBooster = (b[5] & 0xc0) === 0xc0;
        const isDocked = (b[1] & 0x40) >> 6;
        const data = {
            model: 'ThermoPro-TempSpikeXR',
            id: b[0].toString(16).padStart(2, '0'),
            color: (b[1] & 0x10) >> 4 ? 'white' : 'black',
            temperature_int_C: probeC((b[2] << 4) | (b[3] >> 4)),
            temperature_amb_C: probeC(((b[3] & 0x0f) << 8) | b[4]),
            mic: 'CRC',
        };
        if (isDocked)
            data.is_docked = isDocked;
        if (isProbe) {
            data.is_probe = 1;
            data.probe_battery = (b[6] & 0x30) >> 4;
        }
        if (isBooster) {
            data.is_booster = 1;
            data.booster_battery = b[6] & 0x03;
        }
        ctx.emit(data);
        return 1;
    },
});
