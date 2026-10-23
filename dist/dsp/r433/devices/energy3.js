import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc16, crc16lsb } from '../util.js';
const BAND_433 = [433920000];
const BAND_868 = [868290000];
const BAND_915 = [915000000];
const round2 = (x) => Math.round(x * 100) / 100;
const hex2 = (v) => v.toString(16).padStart(2, '0');
const hexOf = (b, from, n) => {
    let s = '';
    for (let i = 0; i < n; i++)
        s += hex2(b[from + i]);
    return s;
};
function bitrowGetByte(row, pos) {
    return (((row[pos >> 3] << 8) | row[(pos >> 3) + 1]) >> (8 - (pos & 7))) & 0xff;
}
export const ecodhome = register({
    num: 174,
    name: 'EcoDHOME Smart Socket and MCEE Solar monitor',
    what: 'household energy monitor',
    modulation: 16,
    shortWidth: 250,
    longWidth: 250,
    resetLimit: 6000,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 128)
            return DECODE_ABORT_LENGTH;
        let start = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0x2d, 0xd4]), 32);
        start += 32;
        if (start >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (start + 12 * 8 >= bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const msg = bits.bytes(0, start, 13 * 8);
        const id = ((((msg[0] << 24) >>> 0) | (msg[1] << 16) | (msg[2] << 8) | msg[3]) >>> 0);
        const mType = (msg[4] << 8) | msg[5];
        if (mType === 0x7700) {
            if (addBytes(msg, 11) !== msg[11])
                return DECODE_FAIL_MIC;
            if (msg[10] !== 0x53)
                return DECODE_FAIL_SANITY;
            const subtype = (msg[6] << 8) | msg[7];
            const out = {
                model: 'EcoDHOME-SmartSocket',
                type: 'Energy',
                id,
                message_type: mType,
                message_subtype: subtype,
                raw: (msg[8] << 8) | msg[9],
                mic: 'CHECKSUM',
            };
            if (subtype === 0x414b)
                out.power_W = (msg[9] << 8) | msg[8];
            ctx.emit(out);
            return 1;
        }
        if (((addBytes(msg, 9) + 0x35) & 0xff) !== msg[9])
            return DECODE_FAIL_MIC;
        if (msg[10] !== 0x55)
            return DECODE_FAIL_SANITY;
        if (msg[11] !== 0x00)
            return DECODE_FAIL_SANITY;
        const out = {
            model: 'EcoDHOME-Transmitter',
            type: 'Energy',
            id,
            message_type: mType,
            raw: (((msg[6] << 16) | (msg[7] << 8) | msg[8]) >>> 0),
            mic: 'CHECKSUM',
        };
        if (mType === 0x3eb3)
            out.power_W = ((((msg[7] - 0x33) & 0xff) << 8) | ((msg[6] - 0x33) & 0xff));
        ctx.emit(out);
        return 1;
    },
});
function geoMinimCt(ctx, buf, len) {
    if (buf[3] !== 5)
        return DECODE_ABORT_LENGTH;
    if (len !== 11)
        return DECODE_ABORT_LENGTH;
    let va = 10 * (buf[5] + ((buf[4] & 0x0f) << 8));
    if (buf[4] & 0x40)
        va += 5;
    const out = {
        model: 'GEO-minimCT',
        type: 'Energy',
        id: (hex2(buf[0]) + hex2(buf[1]) + hex2(buf[2])).toUpperCase(),
        power_VA: va,
        uptime_s: 8 * (((buf[6] << 16) + (buf[7] << 8) + buf[8]) >>> 0),
        mic: 'CRC',
    };
    const flags4 = buf[4] & 0xb0;
    if (flags4 !== 0x30)
        out.flags4 = flags4;
    ctx.emit(out);
    return 1;
}
function geoMinimDisplay(ctx, buf, len) {
    if (buf[3] !== 42)
        return DECODE_ABORT_LENGTH;
    if (len !== 48)
        return DECODE_ABORT_LENGTH;
    const watts = 5 * (buf[4] + ((buf[5] & 0x7f) << 8));
    const wh = buf[14] + ((buf[15] & 0x07) << 8);
    const days = buf[30] + (buf[31] << 8);
    const when = new Date(Date.UTC(2007, 0, 1 + days));
    const hour = buf[32] & 0x1f;
    const min = buf[33] & 0x3f;
    const clock = `${when.getUTCFullYear()}-${hex10(when.getUTCMonth() + 1)}-${hex10(when.getUTCDate())}`
        + ` ${hex10(hour)}:${hex10(min)}`;
    const out = {
        model: 'GEO-minimDP',
        type: 'Energy',
        id: (hex2(buf[0]) + hex2(buf[1]) + hex2(buf[2])).toUpperCase(),
        power_W: watts,
        energy_kWh: wh * 0.001,
        clock,
        mic: 'CRC',
    };
    const flags5 = buf[5] & 0x80;
    if (flags5 !== 0)
        out.flags5 = flags5;
    const flags15 = buf[15] & 0xf8;
    if (flags15 !== 0x40)
        out.flags15 = flags15;
    ctx.emit(out);
    return 1;
}
function hex10(n) {
    return n.toString().padStart(2, '0');
}
export const geoMinim = register({
    num: 224,
    name: 'GEO minim+ energy monitor',
    what: 'household energy monitor',
    modulation: 16,
    shortWidth: 24,
    longWidth: 24,
    resetLimit: 3000,
    bands: BAND_868,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_LENGTH;
        let bitpos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0x7b, 0xb9]), 32) + 32;
        if (bitpos >= bits.bitsPerRow[0]) {
            bitpos = bits.search(0, 0, new Uint8Array([0x55, 0x55, 0x7b, 0xb9]), 32) + 32;
        }
        if (bitpos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        let avail = bits.bitsPerRow[0];
        if (bitpos + 32 >= avail)
            return DECODE_ABORT_LENGTH;
        avail -= bitpos;
        const buf = new Uint8Array(128);
        bits.extractBytes(0, bitpos, buf, 32);
        const dataLength = buf[3];
        if (dataLength !== 0x2a && dataLength !== 0x05)
            return DECODE_ABORT_EARLY;
        let bytes = (avail / 8) | 0;
        if (bytes > 128)
            bytes = 128;
        const crcLen = 4 + buf[3];
        if (crcLen + 2 > bytes)
            return DECODE_FAIL_SANITY;
        const rest = bits.bytes(0, bitpos + 32, (bytes - 4) * 8);
        buf.set(rest.subarray(0, bytes - 4), 4);
        if (crc16(buf, crcLen, 0x8005, 0) !== ((buf[crcLen] << 8) | buf[crcLen + 1]))
            return DECODE_FAIL_MIC;
        if (dataLength === 0x2a)
            return geoMinimDisplay(ctx, buf, bytes);
        return geoMinimCt(ctx, buf, bytes);
    },
});
export const bm5 = register({
    num: 285,
    name: 'bm5-v2 12V Battery Monitor',
    what: 'car battery monitor',
    modulation: 6,
    shortWidth: 225,
    longWidth: 675,
    resetLimit: 6000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        bits.invert();
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 88)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, 0, 88);
        if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[10] === 0)
            return DECODE_FAIL_MIC;
        if (b[6] === 0 && b[7] === 0)
            return DECODE_FAIL_SANITY;
        if (addBytes(b, 10) !== b[10])
            return DECODE_FAIL_MIC;
        const soh = b[3] >> 1;
        const soc = b[4] >> 1;
        let temp = b[5] >> 1;
        if (b[5] & 0x01)
            temp = -temp;
        const batteryV = ((b[7] << 8) | b[6]) * 0.000625;
        const startingV = ((b[9] << 8) | b[8]) * 0.000625;
        if (soh > 100 || soc > 100 || batteryV < 0 || batteryV > 20 || startingV < 0 || startingV > 20) {
            return DECODE_FAIL_SANITY;
        }
        ctx.emit({
            model: 'BM5-v2',
            type: 'Energy',
            id: (b[0] << 16) | (b[1] << 8) | b[2],
            health_pct: soh,
            cranking_error: b[4] & 0x01,
            charge_pct: soc,
            charging_error: b[3] & 0x01,
            temperature_C: temp,
            battery_V: round2(batteryV),
            starting_V: round2(startingV),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const ELSTER_MIN_LEN = 9;
const ELSTER_MAX_LEN = 200;
const ELSTER2_MIN_LEN = 12;
const ELSTER2_NBR_MAX = 8;
function x25(buf, n) {
    return (crc16lsb(buf, n, 0x8408, 0xffff) ^ 0xffff) & 0xffff;
}
export const elsterPowerMeter = register({
    num: 338,
    name: 'Elster/Honeywell R2S/REXU power meter',
    what: 'electricity meter',
    modulation: 18,
    shortWidth: 28,
    longWidth: 28,
    resetLimit: 3000,
    bands: BAND_915,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < (ELSTER_MIN_LEN + 2) * 8)
            return DECODE_ABORT_LENGTH;
        const row = bits.bb[0];
        const buf = new Uint8Array(ELSTER_MAX_LEN + 2);
        let len = 0;
        let found = -1;
        for (let pos = 0; pos + (ELSTER_MIN_LEN + 2) * 8 <= rowBits; pos++) {
            const candLen = bitrowGetByte(row, pos) ^ 0x55;
            if (candLen < ELSTER_MIN_LEN || candLen > ELSTER_MAX_LEN)
                continue;
            if (pos + (candLen + 2) * 8 > rowBits)
                continue;
            for (let i = 0; i < candLen + 2; i++)
                buf[i] = bitrowGetByte(row, pos + i * 8) ^ 0x55;
            if (x25(buf, candLen) === (buf[candLen] | (buf[candLen + 1] << 8))) {
                found = pos;
                len = candLen;
                break;
            }
        }
        if (found < 0)
            return DECODE_FAIL_MIC;
        const flags = buf[1];
        const src = ((((buf[2] << 24) >>> 0) | (buf[3] << 16) | (buf[4] << 8) | buf[5]) >>> 0);
        const dst = ((((buf[6] << 24) >>> 0) | (buf[7] << 16) | (buf[8] << 8) | buf[9]) >>> 0);
        const out = {
            model: 'Elster-PowerMeter',
            type: 'Energy',
            id: String(src),
            dst: String(dst),
            flags,
            data_raw: hexOf(buf, 10, len - 10),
            mic: 'CRC',
        };
        if (len === 40 && flags === 0x08 && dst === 0)
            out.frame_type = 'beacon';
        if (src < 0x80000000 && len - 1 > 15) {
            const cmdLen = buf[16];
            if (cmdLen === 0x33 && len - 1 >= 16 + cmdLen) {
                const cmd = buf.subarray(17);
                if (cmd[1] === 0xce && cmdLen >= 10) {
                    out.ctr = cmd[2];
                    out.cur_hour = (cmd[5] << 8) | cmd[6];
                    out.last_hour = (cmd[7] << 8) | cmd[8];
                    let n = cmd[9];
                    if (n > 17)
                        n = 17;
                    const readings = [];
                    for (let h = 0; h < n && cmdLen >= 10 + 2 * (h + 1); h++) {
                        readings.push((((cmd[10 + 2 * h] << 8) | cmd[10 + 2 * h + 1]) * 0.01).toFixed(2));
                    }
                    out.hourly_kWh = readings.join(',');
                }
                if (cmd[1] === 0xce && cmdLen >= 47) {
                    out.reading_kWh = (((cmd[44] << 16) | (cmd[45] << 8) | cmd[46]) >>> 0);
                }
            }
        }
        ctx.emit(out);
        return 1;
    },
});
export const elsterPowerMeter2 = register({
    num: 373,
    name: 'Elster/Honeywell R2S/REXU power meter, type-2 frames',
    what: 'electricity meter',
    modulation: 16,
    shortWidth: 7,
    longWidth: 7,
    resetLimit: 4000,
    bands: BAND_915,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < (ELSTER2_MIN_LEN + 2) * 8)
            return DECODE_ABORT_LENGTH;
        const row = bits.bb[0];
        const buf = new Uint8Array(ELSTER_MAX_LEN + 2);
        let len = 0;
        let found = -1;
        for (let pos = 0; pos + (ELSTER2_MIN_LEN + 2) * 8 <= rowBits; pos++) {
            const candLen = ((bitrowGetByte(row, pos) ^ 0xaa) << 8) | (bitrowGetByte(row, pos + 8) ^ 0xaa);
            if (candLen < ELSTER2_MIN_LEN || candLen > ELSTER_MAX_LEN)
                continue;
            if (pos + (candLen + 2) * 8 > rowBits)
                continue;
            for (let i = 0; i < candLen + 2; i++)
                buf[i] = bitrowGetByte(row, pos + i * 8) ^ 0xaa;
            if (x25(buf, candLen) === (buf[candLen] | (buf[candLen + 1] << 8))) {
                found = pos;
                len = candLen;
                break;
            }
        }
        if (found < 0)
            return DECODE_FAIL_MIC;
        const src = ((((buf[3] << 24) >>> 0) | (buf[4] << 16) | (buf[5] << 8) | buf[6]) >>> 0);
        const dst = ((((buf[7] << 24) >>> 0) | (buf[8] << 16) | (buf[9] << 8) | buf[10]) >>> 0);
        const isMesh = src >= 0x80000000;
        let msg = -1;
        if (!isMesh && len > 16)
            msg = buf[16];
        const out = {
            model: 'Elster-PowerMeter2',
            type: 'Energy',
            id: String(src),
            dst: String(dst),
            mesh: isMesh ? 1 : 0,
            data_raw: hexOf(buf, 12, len - 12),
            mic: 'CRC',
        };
        if (msg >= 0)
            out.msg = hex2(msg);
        if ((msg === 0x57 || msg === 0x7f) && len > 30) {
            const n = buf[28];
            const recStart = (msg === 0x57) ? 30 : 29;
            if (n > 0 && n <= ELSTER2_NBR_MAX && recStart + n * 20 <= len) {
                const ids = [];
                for (let i = 0; i < n; i++)
                    ids.push(hexOf(buf, recStart + i * 20, 4));
                out.nbr_ids = ids.join(',');
            }
        }
        ctx.emit(out);
        return 1;
    },
});
