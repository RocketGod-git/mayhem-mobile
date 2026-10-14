import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { lfsrDigest8Reflect, lfsrDigest8Reverse } from '../util.js';
const round1 = (x) => Math.round(x * 10) / 10;
function signed(v, bits) {
    const shift = 32 - bits;
    return (v << shift) >> shift;
}
export const thermoproTp11 = register({
    num: 84,
    name: 'ThermoPro TP11 thermometer',
    what: 'cooking thermometer with one probe',
    modulation: 5,
    shortWidth: 500,
    longWidth: 1500,
    gapLimit: 2000,
    resetLimit: 4000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 32);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 33)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (lfsrDigest8Reflect(b, 3, 0x51, 0x04) !== b[3])
            return DECODE_FAIL_MIC;
        if ((!b[0] && !b[1] && !b[2] && !b[3])
            || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff))
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Thermopro-TP11',
            id: (b[0] << 4) | (b[1] >> 4),
            temperature_C: round1(((((b[1] & 0x0f) << 8) | b[2]) - 200) * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
export const thermoproTp12 = register({
    num: 97,
    name: 'ThermoPro TP08/TP12/TP20 thermometer',
    what: 'barbecue thermometer with a food probe and a pit probe',
    modulation: 5,
    shortWidth: 500,
    longWidth: 1500,
    gapLimit: 2000,
    resetLimit: 4000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedPrefix(bits.numRows > 5 ? 5 : 2, 40);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[row];
        if (!b[0] && !b[1] && !b[2] && !b[3])
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 41)
            return DECODE_ABORT_LENGTH;
        if (lfsrDigest8Reflect(b, 4, 0x51, 0x04) !== b[4])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Thermopro-TP12',
            id: b[0],
            temperature_1_C: round1(((((b[2] & 0xf0) << 4) | b[1]) - 200) * 0.1),
            temperature_2_C: round1(((((b[2] & 0x0f) << 8) | b[3]) - 200) * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
export const thermoproTx2c = register({
    num: 245,
    name: 'ThermoPro TX-2C, TX-2B thermometer and humidity sensor',
    what: 'outdoor temperature and humidity sensor',
    modulation: 5,
    shortWidth: 1958,
    longWidth: 3825,
    gapLimit: 7000,
    resetLimit: 8643,
    disabled: true,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(4, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 45)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if ((!b[0] && !b[1] && !b[2] && !b[3])
            || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff))
            return DECODE_FAIL_SANITY;
        if ((b[4] & 0x0f) !== 0x00 || b[5] !== 0x00)
            return DECODE_FAIL_SANITY;
        const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
        const out = {
            model: 'Thermopro-TX2C',
            id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
            channel: (b[1] & 0x03) + 1,
            battery_ok: ((b[1] & 0x08) >> 3) ? 0 : 1,
            temperature_C: round1((signed((b[2] << 8) | b[3], 16) >> 4) * 0.1),
            button: (b[1] & 0x04) >> 2,
        };
        if (humidity !== 0x0a)
            out.humidity = humidity;
        ctx.emit(out);
        return 1;
    },
});
export const thermoproTx7b = register({
    num: 278,
    name: 'ThermoPro TX-7B outdoor thermometer hygrometer',
    what: 'outdoor temperature and humidity sensor',
    modulation: 16,
    shortWidth: 108,
    longWidth: 108,
    resetLimit: 1500,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        const msgLen = bits.bitsPerRow[0];
        if (msgLen > 260)
            return DECODE_ABORT_LENGTH;
        const preamble = new Uint8Array([0x55, 0x2d, 0xd4]);
        let offset = bits.search(0, 0, preamble, 24);
        if (offset >= msgLen)
            return DECODE_ABORT_EARLY;
        if (msgLen - offset < 96)
            return DECODE_ABORT_LENGTH;
        offset += 24;
        const b = bits.bytes(0, offset, 72);
        if (lfsrDigest8Reverse(b, 8, 0x98, 0x25) !== b[8])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'ThermoPro-TX7B',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (b[1] >> 7) ? 0 : 1,
            button: (b[1] & 0x40) >> 6,
            flags: b[1] & 0x0f,
            temperature_C: round1((((b[2] << 4) | ((b[3] & 0xf0) >> 4)) - 400) * 0.1),
            humidity: b[4],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const tfaPoolThermometer = register({
    num: 56,
    name: 'TFA pool temperature sensor',
    what: 'floating pool thermometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4600,
    gapLimit: 7800,
    resetLimit: 10000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(7, 28);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 28)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        const sum = (b[0] & 0x0f) + (b[1] >> 4) + (b[1] & 0x0f)
            + (b[2] >> 4) + (b[2] & 0x0f) + (b[3] >> 4) - 1;
        if (((b[0] & 0xf0) >> 4) !== (sum & 0x0f))
            return DECODE_FAIL_MIC;
        const raw = ((b[1] & 0x0f) << 8) | b[2];
        ctx.emit({
            model: 'TFA-Pool',
            id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
            channel: (b[3] & 0xc0) >> 6,
            battery_ok: (b[3] & 0x20) >> 5,
            temperature_C: round1((raw > 2048 ? raw - 4096 : raw) * 0.1),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
