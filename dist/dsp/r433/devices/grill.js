import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, crc16, lfsrDigest8Reflect, lfsrDigest16, parityBytes } from '../util.js';
const BANDS = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const s16 = (x) => ((x & 0xffff) << 16) >> 16;
const hex = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
function sumNibbles(b, n) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += (b[i] >> 4) + (b[i] & 0x0f);
    return s;
}
export const maverickEt73x = register({
    num: 71,
    name: 'Maverick ET-732/733 BBQ Sensor',
    what: 'barbecue thermometer, two probes',
    modulation: 3,
    shortWidth: 230,
    longWidth: 0,
    resetLimit: 4000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 104)
            return DECODE_ABORT_LENGTH;
        const raw = bits.bb[0];
        if (raw[0] !== 0x55 || raw[1] !== 0x66 || raw[2] !== 0x6a)
            return DECODE_ABORT_EARLY;
        const mc = new BitBuffer();
        bits.manchesterDecode(0, 0, mc, 104);
        if (mc.bitsPerRow[0] < 52)
            return DECODE_FAIL_SANITY;
        const b = mc.bb[0];
        const flags = b[1] & 0x0f;
        const temp1 = (b[2] << 2) | ((b[3] & 0xc0) >> 6);
        const temp2 = ((b[3] & 0x3f) << 4) | ((b[4] & 0xf0) >> 4);
        const digest = ((b[4] & 0x0f) << 12) | (b[5] << 4) | (b[6] >> 4);
        const chk = mc.bytes(0, 12, 24);
        const id = lfsrDigest16(chk, 3, 0x8810, 0xdd38) ^ digest;
        ctx.emit({
            model: 'Maverick-ET73x',
            id,
            status: flags === 2 ? 'default' : flags === 7 ? 'init' : 'unknown',
            temperature_1_C: temp1 - 532,
            temperature_2_C: temp2 - 532,
        });
        return 1;
    },
});
export const maverickEt73 = register({
    num: 114,
    name: 'Maverick ET73',
    what: 'barbecue thermometer, two probes',
    modulation: 5,
    shortWidth: 1050,
    longWidth: 2050,
    gapLimit: 2200,
    resetLimit: 4400,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 48);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[row];
        if ((!b[0] && !b[1] && !b[2] && !b[3])
            || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff))
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 48)
            return DECODE_ABORT_LENGTH;
        ctx.emit({
            model: 'Maverick-ET73',
            id: b[0],
            temperature_1_C: round1((s16((b[1] << 8) | (b[2] & 0xf0)) >> 4) * 0.1),
            temperature_2_C: round1((s16(((b[2] & 0x0f) << 12) | (b[3] << 4)) >> 4) * 0.1),
        });
        return 1;
    },
});
export const maverickXr30 = register({
    num: 220,
    name: 'Maverick XR-30 BBQ Sensor',
    what: 'barbecue thermometer, two probes',
    modulation: 16,
    shortWidth: 360,
    longWidth: 360,
    resetLimit: 4096,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 104)
            return DECODE_ABORT_LENGTH;
        let b;
        if (bits.bb[0][0] === 0x55)
            b = bits.bytes(0, 7, 12 * 8);
        else if (bits.bb[0][0] === 0xaa)
            b = bits.bytes(0, 8, 12 * 8);
        else
            return DECODE_ABORT_EARLY;
        if (b[0] !== 0xaa || b[1] !== 0xaa || b[2] !== 0xaa
            || b[3] !== 0xd3 || b[4] !== 0x91 || b[5] !== 0xd3 || b[6] !== 0x91)
            return DECODE_ABORT_EARLY;
        const flags = (b[7] & 0xf0) >> 4;
        const temp1 = ((b[7] & 0x0f) << 6) | ((b[8] & 0xfc) >> 2);
        const temp2 = ((b[8] & 0x03) << 8) | b[9];
        const digest = (b[10] << 8) | b[11];
        const id = lfsrDigest16(b, 3, 0x8810, 0x0d42, 7) ^ digest;
        ctx.emit({
            model: 'Maverick-XR30',
            id,
            status: flags === 0 ? 'default' : flags === 5 ? 'init' : 'unknown',
            temperature_1_C: temp1 - 532,
            temperature_2_C: temp2 - 532,
        });
        return 1;
    },
});
const XR50_SYNC = new Uint8Array([0xd2, 0xaa, 0x2d, 0xd4]);
export const maverickXr50 = register({
    num: 281,
    name: 'Maverick XR-50 BBQ Sensor',
    what: 'barbecue thermometer, four probes with targets',
    modulation: 16,
    shortWidth: 107,
    longWidth: 107,
    resetLimit: 2200,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const n = bits.bitsPerRow[0];
        const at = bits.search(0, 0, XR50_SYNC, 32);
        if (at >= n)
            return DECODE_ABORT_LENGTH;
        if (n - at < 184)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at + 32, 23 * 8);
        if (crc8(b, 23, 0x31, 0x00))
            return DECODE_FAIL_MIC;
        const data = {
            model: 'Maverick-XR50',
            id: hex((b[0] << 8) | b[1], 4),
            mic: 'CRC',
        };
        for (let p = 0; p < 4; p++) {
            const o = 2 + p * 5;
            const tempRaw = ((b[o] & 0x0f) << 8) | b[o + 1];
            data[`probe_${p + 1}_flags`] = hex((b[o] & 0xf0) >> 4, 1);
            if (tempRaw !== 0)
                data[`temperature_${p + 1}_C`] = round1((tempRaw - 500) * 0.1);
            data[`setpoint_high_${p + 1}_C`] = round1((((b[o + 2] << 4) | ((b[o + 3] & 0xf0) >> 4)) - 500) * 0.1);
            data[`setpoint_low_${p + 1}_C`] = round1(((((b[o + 3] & 0x0f) << 8) | b[o + 4]) - 500) * 0.1);
        }
        ctx.emit(data);
        return 1;
    },
});
export const gtTmbbq05 = register({
    num: 137,
    name: 'Globaltronics QUIGG GT-TMBBQ-05',
    what: 'barbecue thermometer, one probe',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 4200,
    resetLimit: 9100,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(5, 33);
        if (r < 0 || bits.bitsPerRow[r] !== 33)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(r, 1, 32);
        if (!b[0] && !b[1] && !b[2] && !b[3])
            return DECODE_FAIL_SANITY;
        if (parityBytes(Uint8Array.of(b[0], b[1], b[2], b[3] & 0xf0), 4))
            return DECODE_FAIL_MIC;
        const sum = sumNibbles(b, 3) + (b[3] >> 4);
        if ((sum & 0x0f) !== (b[3] & 0x0f))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'GT-TMBBQ05',
            id: (b[0] << 8) | b[2],
            temperature_F: (((b[3] & 0xc0) << 2) | b[1]) - 90,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const BURNHARD_MEAT = ['free', 'beef', 'veal', 'pork', 'chicken', 'lamb', 'fish', 'ham'];
const BURNHARD_TASTE = ['rare', 'medium rare', 'medium', 'medium well', 'well done'];
export const burnhardbbq = register({
    num: 177,
    name: 'Burnhard BBQ thermometer',
    what: 'barbecue thermometer with a timer and a target',
    modulation: 6,
    shortWidth: 240,
    longWidth: 484,
    syncWidth: 840,
    resetLimit: 848,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        bits.invert();
        let ret = DECODE_FAIL_OTHER;
        for (let i = 0; i < bits.numRows; i++) {
            const n = bits.bitsPerRow[i];
            if (n < 80 || n > 81) {
                ret = DECODE_ABORT_LENGTH;
                continue;
            }
            const b = bits.bb[i];
            if (b[0] === 0 && b[9] === 0) {
                ret = DECODE_ABORT_EARLY;
                continue;
            }
            if (lfsrDigest8Reflect(b, 9, 0x31, 0xf4) !== b[9]) {
                ret = DECODE_FAIL_MIC;
                continue;
            }
            const setpointRaw = ((b[7] & 0x0f) << 8) | b[6];
            const tempRaw = ((b[7] & 0xf0) << 4) | b[8];
            const meat = BURNHARD_MEAT[b[5] >> 4] ?? '';
            const taste = BURNHARD_TASTE[b[5] & 0x0f] ?? '';
            const data = {
                model: 'BurnhardBBQ',
                id: b[0],
                channel: b[1] & 0x07,
                setpoint_C: round1((setpointRaw - 500) * 0.1),
                temperature_alarm: b[1] & 0x80 ? 1 : 0,
                timer: `${hex(b[3], 2)}:${hex(b[4] & 0x7f, 2)}`,
                timer_active: b[1] & 0x10 ? 1 : 0,
                timer_alarm: b[1] & 0x40 ? 1 : 0,
            };
            if (tempRaw !== 0)
                data.temperature_C = round1((tempRaw - 500) * 0.1);
            if (meat)
                data.meat = meat;
            if (taste)
                data.taste = taste;
            ctx.emit(data);
            return 1;
        }
        return ret;
    },
});
export const gasmateBa1008 = register({
    num: 236,
    name: 'Gasmate BA1008 meat thermometer',
    what: 'meat thermometer',
    modulation: 5,
    shortWidth: 536,
    longWidth: 1668,
    resetLimit: 2000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_LENGTH;
        if (bits.bitsPerRow[0] !== 32)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if ((b[0] & 0xf8) !== 0xf0)
            return DECODE_ABORT_EARLY;
        if ((sumNibbles(b, 4) & 0x0f) !== 0x0c)
            return DECODE_FAIL_MIC;
        const raw = (b[0] & 0x03) * 100 + ((b[1] & 0xf0) >> 4) * 10 + (b[1] & 0x0f);
        ctx.emit({
            model: 'Gasmate-BA1008',
            temperature_C: (b[0] & 0x04) >> 2 ? -raw : raw,
            unknown_1: hex((b[2] << 4) | (b[3] >> 4), 3),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const grillThermometer = register({
    num: 331,
    name: 'RF-T0912 Grill Thermometer',
    what: 'grill thermometer with a probe',
    modulation: 6,
    shortWidth: 252,
    longWidth: 736,
    gapLimit: 5000,
    resetLimit: 8068,
    syncWidth: 980,
    priority: 10,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        bits.invert();
        let tempF = 0;
        let repeats = 0;
        for (let row = 0; row < bits.numRows; row++) {
            const r = bits.bb[row];
            const checksum = (r[0] + r[1]) & 0xff;
            if (bits.bitsPerRow[row] !== 24 || checksum !== r[2] || checksum === 0)
                continue;
            const value = s16((r[0] << 8) | r[1]);
            if (tempF !== value) {
                tempF = value;
                repeats = 0;
            }
            else
                repeats++;
        }
        if (repeats < 1)
            return DECODE_ABORT_EARLY;
        const overload = tempF === -1029 ? 1 : 0;
        const data = { model: 'RF-T0912', overload, mic: 'CHECKSUM' };
        if (!overload)
            data.temperature_F = tempF;
        ctx.emit(data);
        return 1;
    },
});
const TYPHUR_SYNC = new Uint8Array([0x57, 0x54]);
export const typhurSyncGold = register({
    num: 377,
    name: 'Typhur Sync Gold meat thermometer probe',
    what: 'wireless meat probe, five points and ambient',
    modulation: 16,
    shortWidth: 13,
    longWidth: 13,
    resetLimit: 3000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        for (let row = 0; row < bits.numRows; row++) {
            const n = bits.bitsPerRow[row];
            let pos = bits.search(row, 0, TYPHUR_SYNC, 16);
            if (pos >= n)
                continue;
            pos += 16;
            if (n - pos < 24 * 8)
                continue;
            const b = bits.bytes(row, pos, 24 * 8);
            if (crc16(b, 22, 0x8005, 0x0000) !== ((b[22] << 8) | b[23]))
                continue;
            const le = (at) => b[at] | (b[at + 1] << 8);
            const data = {
                model: 'Typhur-SyncGold',
                id: hex((b[0] << 16) | (b[1] << 8) | b[2], 6),
                in_base: (b[4] & 0x08) !== 0 ? 1 : 0,
                counter: le(20),
                battery_V: round2(le(18) * 0.01),
                ambient_C: round1(le(16) * 0.1),
                mic: 'CRC',
            };
            for (let i = 0; i < 5; i++)
                data[`temperature_${i + 1}_C`] = round2(le(6 + i * 2) * 0.01);
            ctx.emit(data);
            return 1;
        }
        return DECODE_FAIL_MIC;
    },
});
