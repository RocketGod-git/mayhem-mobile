import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8 } from '../util.js';
const BANDS = [315000000, 433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const hexUp = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
const SMD3MA4_DATA_BITS = 38;
const SMD3MA4_MIN = 36 / 2 + 2 * SMD3MA4_DATA_BITS;
const SMD3MA4_MAX = 36 + 2 * SMD3MA4_DATA_BITS + 8;
export const schrader = register({
    num: 60,
    name: 'Schrader TPMS',
    what: 'tire pressure sensor',
    modulation: 3,
    shortWidth: 120,
    longWidth: 0,
    resetLimit: 480,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 68)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, 4, 64);
        if (b[7] !== crc8(b, 7, 0x07, 0xf0))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Schrader',
            type: 'TPMS',
            id: hexUp(((b[1] & 0x0f) << 24) | (b[2] << 16) | (b[3] << 8) | b[4], 7),
            flags: hexUp(((b[0] & 0x0f) << 4) | (b[1] >> 4), 2).toLowerCase(),
            pressure_kPa: round1(b[5] * 25 * 0.1),
            temperature_C: b[6] - 50,
            mic: 'CRC',
        });
        return 1;
    },
});
export const schraderEg53ma4 = register({
    num: 95,
    name: 'Schrader TPMS EG53MA4 (Saab, Opel, Vauxhall, Chevrolet)',
    what: 'tire pressure sensor',
    modulation: 3,
    shortWidth: 123,
    longWidth: 0,
    resetLimit: 300,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 120)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, 40, 80);
        if (!b[1] && !b[2] && !b[4] && !b[5] && !b[7] && !b[8])
            return DECODE_FAIL_SANITY;
        if ((addBytes(b, 9) & 0xff) !== b[9])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Schrader-EG53MA4',
            type: 'TPMS',
            id: hexUp((b[4] << 16) | (b[5] << 8) | b[6], 6),
            flags: hexUp(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 8).toLowerCase(),
            pressure_kPa: round1(b[7] * 25 * 0.1),
            temperature_F: b[8],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
function smd3ma4Decode(bits, ctx, scale, model) {
    const n = bits.bitsPerRow[0];
    if (n < SMD3MA4_MIN || n >= SMD3MA4_MAX)
        return DECODE_ABORT_LENGTH;
    const at = bits.search(0, 0, new Uint8Array([0x55, 0x5e]), 16) + 14;
    if (at + SMD3MA4_DATA_BITS * 2 > n)
        return DECODE_ABORT_EARLY;
    const decoded = new BitBuffer();
    if (bits.manchesterDecode(0, at, decoded, SMD3MA4_DATA_BITS) !== at + SMD3MA4_DATA_BITS * 2) {
        return DECODE_FAIL_MIC;
    }
    decoded.invert();
    const b = decoded.bb[0];
    if (!b[0] && !b[1] && !b[2] && !b[3])
        return DECODE_FAIL_SANITY;
    let sum = 0;
    for (let i = 0; i < 5; i++) {
        sum += ((b[i] >> 0) & 0x3) + ((b[i] >> 2) & 0x3) + ((b[i] >> 4) & 0x3) + ((b[i] >> 6) & 0x3);
    }
    if ((sum & 0x3) !== 1)
        return DECODE_FAIL_MIC;
    const flags = (b[0] & 0x70) >> 4;
    const data = {
        model,
        type: 'TPMS',
        id: hexUp(((b[0] & 0x0f) << 20) | (b[1] << 12) | (b[2] << 4) | (b[3] >> 4), 6),
        flags,
        pressure_PSI: round1((((b[3] & 0x0f) << 4) | (b[4] >> 4)) * scale),
        mic: 'PARITY',
    };
    if (flags === 0x0)
        data.learn = 1;
    if (flags === 0x3)
        data.alarm = 1;
    if (flags === 0x5)
        data.wakeup = 1;
    ctx.emit(data);
    return 1;
}
export const schraderSmd3ma4 = register({
    num: 168,
    name: 'Schrader TPMS SMD3MA4 (Subaru)',
    what: 'tire pressure sensor',
    modulation: 4,
    shortWidth: 120,
    longWidth: 120,
    resetLimit: 480,
    bands: BANDS,
    decode: (_dev, bits, ctx) => smd3ma4Decode(bits, ctx, 0.2, 'Schrader-SMD3MA4'),
});
export const schraderNis315g3 = register({
    num: 352,
    name: 'Schrader TPMS MRXNIS315G3 / 3039 (Infiniti, Nissan, Renault), Redi-Sensor SE10001HP',
    what: 'tire pressure sensor',
    modulation: 4,
    shortWidth: 120,
    longWidth: 120,
    resetLimit: 480,
    bands: BANDS,
    decode: (_dev, bits, ctx) => smd3ma4Decode(bits, ctx, 0.25, 'Schrader-NIS315G3'),
});
export const schraderMrxbc5a4 = register({
    num: 328,
    name: 'Schrader TPMS MRXBC5A4 (BMW)',
    what: 'tire pressure sensor',
    modulation: 3,
    shortWidth: 123,
    longWidth: 0,
    resetLimit: 800,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 61)
            return DECODE_ABORT_LENGTH;
        if (bits.search(0, 0, new Uint8Array([0x7f, 0xff]), 16) !== 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, 16, 46);
        const id = ((b[0] & 0x1f) << 19) | (b[1] << 11) | (b[2] << 3) | (b[3] >> 5);
        if (id === 0 || id === 0xffffff)
            return DECODE_FAIL_SANITY;
        let evenOnes = 0, ones = 0;
        for (let i = 3; i < 38; i++) {
            if ((b[i >> 3] >> (7 - (i % 8))) & 1) {
                ones++;
                if ((i - 3) % 2 === 0)
                    evenOnes++;
            }
        }
        const want = (evenOnes + 2 * ones - 1) & 0x3;
        if (want !== (((b[4] >> 3) & 1) << 1 | ((b[4] >> 2) & 1)))
            return DECODE_FAIL_MIC;
        const pressure = ((b[3] & 0x1f) << 4) | (b[4] >> 4);
        const tempC = (((b[4] & 0x03) << 5) | (b[5] >> 3)) - 50;
        if (pressure > 450 || tempC < -40 || tempC > 85)
            return DECODE_FAIL_SANITY;
        const flags = (b[0] >> 5) & 0x7;
        ctx.emit({
            model: 'Schrader-MRXBC5A4',
            type: 'TPMS',
            id: hexUp(id, 6),
            flags: flags.toString(16),
            pressure_kPa: round1(pressure),
            temperature_C: round1(tempC),
            sleep: flags === 2 ? 'True' : 'False',
            mic: 'PARITY',
        });
        return 1;
    },
});
