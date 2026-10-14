import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, addNibbles, crc8, lfsrDigest8, lfsrDigest8Reverse } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const pad2 = (n) => n.toString().padStart(2, '0');
export const ecowitt = register({
    num: 127,
    name: 'Ecowitt Wireless Outdoor Thermometer WH53/WH0280/WH0281A',
    what: 'thermometer',
    modulation: 6,
    shortWidth: 500,
    longWidth: 1480,
    gapLimit: 1500,
    resetLimit: 2000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_LENGTH;
        const pos = bits.search(0, 0, new Uint8Array([0xf5, 0x30]), 12);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] - pos < 52)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, pos + 4, 6 * 8);
        if (crc8(b, 6, 0x31, 0x00) !== 0)
            return DECODE_FAIL_MIC;
        const channel = (b[2] >> 4) + 1;
        if (channel > 3)
            return DECODE_FAIL_SANITY;
        if ((b[2] & 0x0c) !== 0)
            return DECODE_ABORT_EARLY;
        const tempRaw = ((b[2] & 0x03) << 8) | b[3];
        if (b[4] !== 0xff)
            return DECODE_ABORT_EARLY;
        ctx.emit({
            model: 'Ecowitt-WH53',
            type: 'Weather',
            id: b[1],
            channel,
            temperature_C: round1((tempRaw - 400) * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
export const eurochronEfth800 = register({
    num: 152,
    name: 'Eurochron EFTH-800 temperature and humidity sensor',
    what: 'thermometer and hygrometer with a radio clock',
    modulation: 6,
    shortWidth: 250,
    longWidth: 500,
    syncWidth: 750,
    gapLimit: 900,
    resetLimit: 5500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        bits.invert();
        let radioClock = '';
        const clockRow = bits.findRepeatedRow(2, 65);
        if (clockRow > 0) {
            const c = bits.bb[clockRow];
            if (crc8(c, 8, 0x31, 0x00) === 0) {
                const hour = c[2] & 0x1f;
                const min = c[3] & 0x3f;
                const sec = c[4] & 0x3f;
                const year = c[5] >> 1;
                const day = ((c[5] & 0x01) << 4) | ((c[6] & 0xf0) >> 4);
                const mth = c[6] & 0x0f;
                radioClock = `${year + 2000}-${pad2(mth)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:${pad2(sec)}`;
            }
        }
        for (let r = 0; r < bits.numRows; r++) {
            if (bits.bitsPerRow[r] > 49)
                bits.bitsPerRow[r] = 0;
        }
        const row = bits.findRepeatedRow(2, 48);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 49)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[4] === 0x00)
            return DECODE_FAIL_SANITY;
        if (crc8(b, 6, 0x31, 0x00) !== 0)
            return DECODE_FAIL_MIC;
        const tempRaw = (((((b[2] & 0x3f) << 10) << 16) >> 16) | ((b[3] & 0xf0) << 2)) >> 6;
        ctx.emit({
            model: 'Eurochron-EFTH800',
            type: 'Weather',
            id: ((b[0] & 0x0f) << 8) | b[1],
            channel: ((b[0] & 0x70) >> 4) + 1,
            battery_ok: (b[2] >> 7) ? 0 : 1,
            temperature_C: round1(tempRaw * 0.1),
            humidity: (b[4] >> 4) * 10 + (b[4] & 0x0f),
            mic: 'CRC',
            ...(radioClock ? { radio_clock: radioClock } : {}),
        });
        return 1;
    },
});
export const auriolAft77b2 = register({
    num: 184,
    name: 'Auriol AFT 77 B2 temperature sensor',
    what: 'thermometer',
    modulation: 5,
    shortWidth: 500,
    longWidth: 920,
    gapLimit: 1104,
    resetLimit: 2275,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        let row = -1;
        for (let r = 0; r < bits.numRows; r++) {
            if (bits.bitsPerRow[r] === 68) {
                row = r;
                break;
            }
        }
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const ptr = bits.bb[row];
        if (ptr[0] !== 0xa5)
            return DECODE_ABORT_EARLY;
        const frame = new Uint8Array(8);
        for (let i = 0; i < 8; i++)
            frame[i] = ((ptr[i] << 4) | (ptr[i + 1] >> 4)) & 0xff;
        if (addBytes(frame, 6) !== frame[6])
            return DECODE_FAIL_MIC;
        if (lfsrDigest8(frame, 6, 0x83, 0xec) !== frame[7])
            return DECODE_FAIL_MIC;
        let tempRaw = (ptr[4] >> 4) * 100 + (ptr[4] & 0x0f) * 10 + (ptr[5] >> 4);
        if ((ptr[3] & 0x08) !== 0)
            tempRaw = -tempRaw;
        ctx.emit({
            model: 'Auriol-AFT77B2',
            type: 'Weather',
            id: frame[1],
            temperature_C: round2(tempRaw * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
export const vaunoEn8822c = register({
    num: 230,
    name: 'Vauno EN8822C',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    tolerance: 500,
    gapLimit: 5000,
    resetLimit: 9500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedPrefix(4, 42);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[row];
        const chk = ((b[4] & 0x0f) << 2) | (b[5] >> 6);
        const sum = addNibbles(b, 4) + (b[4] >> 4);
        if (sum === 0)
            return DECODE_ABORT_EARLY;
        if ((sum & 0x3f) !== chk)
            return DECODE_FAIL_MIC;
        const tempRaw = ((((b[1] & 0x0f) << 12) | (b[2] << 4)) << 16) >> 16;
        ctx.emit({
            model: 'Vauno-EN8822C',
            type: 'Weather',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: ((b[4] & 0x10) >> 4) ? 0 : 1,
            temperature_C: round1((tempRaw >> 4) * 0.1),
            humidity: b[3] >> 1,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
function geevonDecode(bits, ctx, model, verify) {
    bits.invert();
    const row = bits.findRepeatedPrefix(bits.numRows > 5 ? 5 : 3, 72);
    if (row < 0)
        return DECODE_ABORT_LENGTH;
    if (bits.bitsPerRow[row] !== 73)
        return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];
    if (b[5] !== 0xaa || b[6] !== 0x55 || b[7] !== 0xaa)
        return DECODE_FAIL_MIC;
    if (!verify(b))
        return DECODE_FAIL_MIC;
    ctx.emit({
        model,
        type: 'Weather',
        id: b[0],
        battery_ok: (b[1] >> 7) ? 0 : 1,
        channel: ((b[1] & 0x30) >> 4) + 1,
        temperature_C: round1((((b[2] << 4) | (b[3] >> 4)) - 500) * 0.1),
        humidity: b[4],
        mic: 'CRC',
    });
    return 1;
}
export const geevonTx16 = register({
    num: 261,
    name: 'Geevon TX16-3 outdoor sensor',
    what: 'thermometer and hygrometer',
    modulation: 6,
    shortWidth: 250,
    longWidth: 500,
    syncWidth: 750,
    gapLimit: 625,
    resetLimit: 1700,
    bands: BAND_433,
    decode: (_dev, bits, ctx) => geevonDecode(bits, ctx, 'Geevon-TX163', b => crc8(b, 9, 0x31, 0x7b) === 0),
});
export const geevonTx19 = register({
    num: 291,
    name: 'Geevon TX19-1 outdoor sensor',
    what: 'thermometer and hygrometer',
    modulation: 6,
    shortWidth: 250,
    longWidth: 500,
    syncWidth: 750,
    gapLimit: 625,
    resetLimit: 1700,
    bands: BAND_433,
    decode: (_dev, bits, ctx) => geevonDecode(bits, ctx, 'Geevon-TX191', b => lfsrDigest8Reverse(b, 8, 0x98, 0x25) === b[8]),
});
