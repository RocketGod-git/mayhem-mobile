import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc4, crc8, reverse8, xorBytes } from '../util.js';
const round1 = (x) => Math.round(x * 10) / 10;
function signed(v, bits) {
    const shift = 32 - bits;
    return (v << shift) >> shift;
}
export const kedsum = register({
    num: 57,
    name: 'Kedsum temperature & humidity sensor, Pearl NC-7415',
    what: 'outdoor temperature and humidity sensor',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 4400,
    resetLimit: 9400,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 5)
            return DECODE_ABORT_EARLY;
        for (let i = 0; i < 5; i++)
            if (bits.bitsPerRow[i] !== 0)
                return DECODE_ABORT_EARLY;
        const r = bits.findRepeatedRow(4, 42);
        if (r < 0 || bits.bitsPerRow[r] !== 42)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(r, 2, 40);
        if ((crc4(b, 4, 0x3, 0x0) ^ (b[4] >> 4)) !== (b[4] & 0x0f))
            return DECODE_FAIL_MIC;
        const level = b[1] >> 6;
        ctx.emit({
            model: 'Kedsum-TH',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (level === 2 ? 100 : level * 10) / 100,
            flags: (b[1] & 0xc0) | (b[4] >> 4),
            temperature_F: round1(((((b[2] & 0x0f) << 8) | (b[2] & 0xf0) | (b[1] & 0x0f)) - 900) * 0.1),
            humidity: ((b[3] & 0x0f) << 4) | ((b[3] & 0xf0) >> 4),
            mic: 'CRC',
        });
        return 1;
    },
});
export const solightTe44 = register({
    num: 85,
    name: 'Solight TE44/TE66, EMOS E0107T, NX-6876-917',
    what: 'outdoor thermometer',
    modulation: 5,
    shortWidth: 972,
    longWidth: 1932,
    gapLimit: 3000,
    resetLimit: 6000,
    priority: 5,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 36);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[r] !== 37)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        if ((b[3] & 0xf0) !== 0xf0)
            return DECODE_ABORT_EARLY;
        const tmp = new Uint8Array([b[0], b[1], b[2], b[3] & 0xf0, ((b[3] & 0x0f) << 4) | ((b[4] & 0xf0) >> 4)]);
        if (crc8(tmp, 5, 0x31, 0x6c))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Solight-TE44',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            temperature_C: round1((signed((b[1] << 12) | (b[2] << 4), 16) >> 4) * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
export const silvercrest = register({
    num: 1,
    name: 'Silvercrest remote control',
    what: 'remote handset',
    modulation: 6,
    shortWidth: 264,
    longWidth: 744,
    gapLimit: 5000,
    resetLimit: 12000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[1] !== 33)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[1];
        if (b[0] !== 0x7c || b[1] !== 0x26)
            return DECODE_ABORT_EARLY;
        const CMD_TABLE = [2, 3, 0, 1, 4, 5, 7, 6, 0xc, 0xd, 0xf, 0xe, 8, 9, 0xb, 0xa];
        const cmd = b[2] & 0x0f;
        if ((b[3] & 0x0f) !== CMD_TABLE[cmd])
            return DECODE_ABORT_EARLY;
        ctx.emit({ model: 'Silvercrest-Remote', button: cmd });
        return 1;
    },
});
export const wt450 = register({
    num: 33,
    name: 'WT450, WT260H, WT405H',
    what: 'indoor and outdoor temperature and humidity sensors',
    modulation: 9,
    shortWidth: 976,
    longWidth: 1952,
    resetLimit: 18000,
    tolerance: 100,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 36)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if ((b[0] >> 4) !== 0xc)
            return DECODE_ABORT_EARLY;
        let parity = xorBytes(b, 5);
        parity ^= parity >> 4;
        parity ^= parity >> 2;
        if (parity & 0x03)
            return DECODE_FAIL_MIC;
        const humidity = ((b[1] & 0x07) << 4) | (b[2] >> 4);
        const whole = ((b[2] << 4) | (b[3] >> 4)) & 0xff;
        const temp = (whole - 50) + ((b[3] & 0x0f) / 16);
        if (humidity > 100)
            return DECODE_FAIL_SANITY;
        if (temp < -35 || temp > 75)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'WT450-TH',
            id: b[0] & 0x0f,
            channel: (b[1] >> 6) + 1,
            battery_ok: (b[1] & 0x08) ? 0 : 1,
            temperature_C: Math.round(temp * 100) / 100,
            humidity,
            seq: b[4] >> 6,
        });
        return 1;
    },
});
export const tfaTwinPlus = register({
    num: 31,
    name: 'TFA Twin Plus 30.3049, Conrad KW9010, Ea2 BL999',
    what: 'outdoor temperature and humidity sensor',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 6000,
    resetLimit: 10000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 36)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (!(b[0] || b[1] || b[2] || b[3] || b[4]))
            return DECODE_ABORT_EARLY;
        const rb = [reverse8(b[0]), reverse8(b[1]), reverse8(b[2]), reverse8(b[3]), reverse8(b[4])];
        let sum = 0;
        for (let i = 0; i < 4; i++)
            sum += (rb[i] >> 4) + (rb[i] & 0x0f);
        if ((rb[4] & 0x0f) !== (sum & 0x0f))
            return DECODE_FAIL_MIC;
        const negative = b[2] & 0x07;
        const temp = ((rb[2] & 0x1f) << 4) | (rb[1] >> 4);
        ctx.emit({
            model: 'TFA-TwinPlus',
            id: (rb[0] & 0x0f) | ((rb[0] & 0xc0) >> 2),
            channel: (b[0] >> 2) & 0x03,
            battery_ok: (b[1] >> 7) ? 0 : 1,
            temperature_C: round1((negative ? -((1 << 9) - temp) : temp) * 0.1),
            humidity: (rb[3] & 0x7f) - 28,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
