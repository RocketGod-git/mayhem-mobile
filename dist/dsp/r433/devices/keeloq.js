import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, reflectBytes, reverse8 } from '../util.js';
const BANDS = [315000000, 433920000];
const buttonNumber = (btn) => (btn & 0x08) | ((btn & 0x01) << 2) | (btn & 0x02) | ((btn & 0x04) >> 2);
const le32 = (b, i) => (((reverse8(b[i + 3]) << 24) | (reverse8(b[i + 2]) << 16) | (reverse8(b[i + 1]) << 8) | reverse8(b[i])) >>> 0);
const hex = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
const allOnes = (b, from, to) => {
    for (let i = from; i <= to; i++)
        if (b[i] !== 0xff)
            return false;
    return true;
};
function hcs200Decode(bits, ctx) {
    if (bits.bitsPerRow[0] !== 12 || bits.bitsPerRow[1] !== 66)
        return DECODE_ABORT_LENGTH;
    const p = bits.bb[0];
    if (p[0] !== 0xff || (p[1] & 0xf0) !== 0xf0)
        return DECODE_ABORT_EARLY;
    const b = bits.bb[1];
    if (allOnes(b, 1, 7))
        return DECODE_FAIL_SANITY;
    const btn = b[7] & 0x0f;
    ctx.emit({
        model: 'Microchip-HCS200',
        id: hex((reverse8(b[7] & 0xf0) << 24 | reverse8(b[6]) << 16 | reverse8(b[5]) << 8 | reverse8(b[4])) >>> 0, 7),
        battery_ok: (b[8] & 0x80) === 0x80 ? 0 : 1,
        button: buttonNumber(btn),
        learn: btn === 0x0f ? 1 : 0,
        repeat: (b[8] & 0x40) === 0x40 ? 1 : 0,
        encrypted: hex(le32(b, 0), 8),
    });
    return 1;
}
export const hcs200 = register({
    num: 131,
    name: 'Microchip HCS200/HCS300 KeeLoq remote',
    what: 'garage, gate and alarm remote',
    modulation: 6,
    shortWidth: 370,
    longWidth: 772,
    gapLimit: 1500,
    resetLimit: 9000,
    tolerance: 152,
    bands: BANDS,
    decode: (_dev, bits, ctx) => hcs200Decode(bits, ctx),
});
export const hcs200Fsk = register({
    num: 218,
    name: 'Microchip HCS200/HCS300 KeeLoq remote, frequency shifted',
    what: 'garage, gate and alarm remote',
    modulation: 17,
    shortWidth: 370,
    longWidth: 772,
    gapLimit: 1500,
    resetLimit: 9000,
    tolerance: 152,
    bands: BANDS,
    decode: (_dev, bits, ctx) => hcs200Decode(bits, ctx),
});
function hcs361Decode(bits, ctx) {
    if (bits.numRows < 2 || bits.bitsPerRow[1] !== 67)
        return DECODE_ABORT_LENGTH;
    if (bits.bitsPerRow[0] === 6 && bits.bb[0][0] !== 0xfc)
        return DECODE_FAIL_SANITY;
    if (bits.bitsPerRow[0] === 7 && bits.bb[0][0] !== 0xfe)
        return DECODE_FAIL_SANITY;
    if (bits.bitsPerRow[0] === 12) {
        const pre = (bits.bb[0][0] << 8) | bits.bb[0][1];
        if (pre !== 0xaaa0 && pre !== 0xfff0)
            return DECODE_FAIL_SANITY;
    }
    const b = bits.bb[1];
    if (allOnes(b, 0, 7))
        return DECODE_FAIL_SANITY;
    let crc = 0, crcBatLow = 0;
    const actual = (b[8] >> 5) & 0x3;
    for (let i = 0; i < 65; i++) {
        const bit = b[i >> 3] >> (7 - (i % 8));
        const crcBit = ((crc >> 1) ^ bit) & 0x1;
        if (i === 64) {
            const low = ((crc >> 1) ^ ~bit) & 0x1;
            crcBatLow = low | (((low ^ crc) << 1) & 0x2);
        }
        crc = crcBit | (((crcBit ^ crc) << 1) & 0x2);
    }
    if (actual !== crc && actual !== crcBatLow)
        return DECODE_FAIL_MIC;
    const serial = (reverse8(b[7] & 0xf0) << 24 | reverse8(b[6]) << 16 | reverse8(b[5]) << 8 | reverse8(b[4])) >>> 0;
    if (serial === 0)
        return DECODE_FAIL_SANITY;
    ctx.emit({
        model: 'Microchip-HCS361',
        id: hex(serial, 8),
        battery_ok: (b[8] & 0x80) === 0x80 ? 1 : 0,
        button: buttonNumber(b[7] & 0x0f),
        encrypted: hex(le32(b, 0), 8),
        mic: 'CRC',
    });
    return 1;
}
const HCS361_VARIANTS = [
    [306, 'sync, 833 bit/s', 6, 400, 800, 1200, 7200, 140, 4000],
    [307, 'sync, 1667 bit/s', 6, 200, 400, 600, 13600, 70, 2000],
    [308, 'no sync, 833 bit/s', 6, 200, 400, 1200, 6800, 140],
    [309, 'no sync, 1667 bit/s', 6, 100, 200, 600, 6600, 70],
    [310, 'PIWM, 2500 bit/s', 11, 400, 800, 4000, 45600, 140, 4000],
    [311, 'PIWM, 5000 bit/s', 11, 200, 400, 2000, 45200, 70, 2000],
];
export const hcs361 = HCS361_VARIANTS.map(([num, how, mod, s, l, gap, reset, tol, sync]) => register({
    num,
    name: `Microchip HCS361 KeeLoq remote (${how})`,
    what: 'garage, gate and alarm remote',
    modulation: mod,
    shortWidth: s,
    longWidth: l,
    gapLimit: gap,
    resetLimit: reset,
    tolerance: tol,
    ...(sync ? { syncWidth: sync } : {}),
    bands: BANDS,
    decode: (_dev, bits, ctx) => hcs361Decode(bits, ctx),
}));
function hcs362Crc(b) {
    let crc0 = 0, crc1 = 0;
    for (let n = 0; n < 65; n++) {
        const d = (b[n >> 3] >> (7 - (n % 8))) & 1;
        const next1 = crc0 ^ d;
        const next0 = crc0 ^ d ^ crc1;
        crc0 = next0;
        crc1 = next1;
    }
    return (crc1 << 1) | crc0;
}
function hcs362Decode(dev, bits, ctx) {
    let b;
    if (dev.modulation === 4) {
        const n0 = bits.bitsPerRow[0];
        if (n0 < 12 * 2 - 8 || n0 > 12 * 2 + 8)
            return DECODE_ABORT_LENGTH;
        const p = bits.bb[0];
        if (p[0] !== 0xaa || p[1] !== 0xaa || p[2] !== 0xaa)
            return DECODE_ABORT_EARLY;
        const n1 = bits.bitsPerRow[1];
        if (n1 < 71 * 2 || n1 > 72 * 2 + 4)
            return DECODE_ABORT_LENGTH;
        if ((bits.bb[1][0] & 0xc0) !== 0x80)
            return DECODE_ABORT_EARLY;
        const msg = new BitBuffer();
        const len = bits.manchesterDecode(1, 2, msg, 72);
        if (len < 69 + 1)
            return DECODE_ABORT_LENGTH;
        msg.invert();
        b = msg.bb[0];
    }
    else {
        if (bits.bitsPerRow[0] !== 12 || bits.bitsPerRow[1] !== 69)
            return DECODE_ABORT_LENGTH;
        const p = bits.bb[0];
        if (p[0] !== 0xff || (p[1] & 0xf0) !== 0xf0)
            return DECODE_ABORT_EARLY;
        b = bits.bb[1];
    }
    if (allOnes(b, 1, 7))
        return DECODE_FAIL_SANITY;
    const actual = ((b[8] >> 6) & 1) | (((b[8] >> 5) & 1) << 1);
    if (actual !== hcs362Crc(b))
        return DECODE_FAIL_MIC;
    ctx.emit({
        model: 'Microchip-HCS362',
        id: hex((reverse8(b[7] & 0xf0) << 24 | reverse8(b[6]) << 16 | reverse8(b[5]) << 8 | reverse8(b[4])) >>> 0, 7),
        battery_ok: (b[8] & 0x80) === 0x80 ? 0 : 1,
        button: buttonNumber(b[7] & 0x0f),
        repeat: ((b[8] >> 4) & 1) | (((b[8] >> 3) & 1) << 1),
        encrypted: hex(le32(b, 0), 8),
        mic: 'CRC',
    });
    return 1;
}
export const hcs362Pwm = register({
    num: 329,
    name: 'Microchip HCS362 KeeLoq remote, pulse width',
    what: 'garage, gate and alarm remote',
    modulation: 6,
    shortWidth: 200,
    longWidth: 400,
    gapLimit: 550,
    resetLimit: 900,
    tolerance: 50,
    bands: BANDS,
    decode: (dev, bits, ctx) => hcs362Decode(dev, bits, ctx),
});
export const hcs362Mc = register({
    num: 330,
    name: 'Microchip HCS362 KeeLoq remote, Manchester',
    what: 'garage, gate and alarm remote',
    modulation: 4,
    shortWidth: 214,
    longWidth: 214,
    gapLimit: 600,
    resetLimit: 900,
    tolerance: 50,
    bands: BANDS,
    decode: (dev, bits, ctx) => hcs362Decode(dev, bits, ctx),
});
export const rainpointHcs012arf = register({
    num: 276,
    name: 'RainPoint HCS012ARF rain gauge',
    what: 'tipping-bucket rain gauge',
    modulation: 4,
    shortWidth: 320,
    longWidth: 320,
    gapLimit: 700,
    resetLimit: 1000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(4, 163);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 163)
            return DECODE_ABORT_LENGTH;
        const msg = new BitBuffer();
        bits.manchesterDecode(row, 0, msg, 10 * 2 * 8);
        msg.invert();
        const b = msg.bb[0];
        reflectBytes(b, 10);
        if (b[0] !== 0xa5)
            return DECODE_ABORT_EARLY;
        if ((addBytes(b, 8, 1) & 0xff) !== b[9])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'RainPoint-HCS012ARF',
            id: ((b[4] << 24) | (b[3] << 16) | (b[2] << 8) | b[1]) >>> 0,
            flags1: (b[5] >> 2).toString(16).padStart(2, '0'),
            flags2: b[6].toString(16).padStart(2, '0'),
            battery_ok: (b[5] & 0x02) >> 1 ? 0 : 1,
            rain_mm: Math.round(((b[8] << 8) | b[7]) * 0.1 * 10) / 10,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const baldrHcs528arf = register({
    num: 360,
    name: 'Baldr HCS528ARF pool thermometer',
    what: 'floating pool thermometer',
    modulation: 4,
    shortWidth: 320,
    longWidth: 320,
    gapLimit: 700,
    resetLimit: 1000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(4, 179);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 179)
            return DECODE_ABORT_LENGTH;
        const msg = new BitBuffer();
        bits.manchesterDecode(row, 0, msg, 11 * 2 * 8);
        msg.invert();
        const b = msg.bb[0];
        reflectBytes(b, 11);
        if (b[0] !== 0xa5)
            return DECODE_ABORT_EARLY;
        if ((addBytes(b, 9, 1) & 0xff) !== b[10])
            return DECODE_FAIL_MIC;
        const data = {
            model: 'Baldr-HCS528ARF',
            id: hex(((b[4] << 24) | (b[3] << 16) | (b[2] << 8) | b[1]) >>> 0, 8).toLowerCase(),
            battery_ok: (b[5] & 0x02) >> 1 ? 0 : 1,
            temperature_F: Math.round((((b[8] & 0x0f) << 8) | b[7]) * 0.1 * 10) / 10,
            mic: 'CHECKSUM',
        };
        ctx.emit(data);
        return 1;
    },
});
