import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc16, extractBytesUart8n1, ibmWhitening } from '../util.js';
const US_METER_BANDS = [912600000, 915000000];
const hex2 = (v) => (v & 0xff).toString(16).padStart(2, '0');
const hex4 = (v) => (v & 0xffff).toString(16).padStart(4, '0');
const hexOf = (b, n = b.length, at = 0) => {
    let s = '';
    for (let i = 0; i < n; i++)
        s += hex2(b[at + i] ?? 0);
    return s;
};
function byteAt(m, off) {
    const i = off >> 3, s = off & 7;
    if (!s)
        return m[i] ?? 0;
    return ((((m[i] ?? 0) << 8) | (m[i + 1] ?? 0)) >> (8 - s)) & 0xff;
}
function decode3of6(byte) {
    switch (byte) {
        case 22: return 0x0;
        case 13: return 0x1;
        case 14: return 0x2;
        case 11: return 0x3;
        case 28: return 0x4;
        case 25: return 0x5;
        case 26: return 0x6;
        case 19: return 0x7;
        case 44: return 0x8;
        case 37: return 0x9;
        case 38: return 0xa;
        case 35: return 0xb;
        case 52: return 0xc;
        case 49: return 0xd;
        case 50: return 0xe;
        case 41: return 0xf;
        default: return 0xff;
    }
}
export const badgerOrion = register({
    num: 223,
    name: 'Badger ORION water meter, 100kbps',
    what: 'water meter',
    modulation: 16,
    shortWidth: 10,
    longWidth: 10,
    resetLimit: 1000,
    bands: [916450000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < 16 + 12 * 10 || rowBits > 128 + 16 + 12 * 10 + 96)
            return DECODE_ABORT_LENGTH;
        const pre = new Uint8Array([0x54, 0x3d]);
        let pos = bits.search(0, 0, pre, 16);
        if (pos + 12 * 10 >= rowBits)
            return DECODE_ABORT_EARLY;
        pos += 16;
        const row = bits.bb[0];
        const b = new Uint8Array(10);
        for (let n = 0; n < 10; n++) {
            const hi = decode3of6(byteAt(row, n * 12 + pos) >> 2);
            const lo = decode3of6(byteAt(row, n * 12 + pos + 6) >> 2);
            if (hi > 0x0f || lo > 0x0f)
                return DECODE_FAIL_MIC;
            b[n] = (hi << 4) | lo;
        }
        const crcRead = ((b[8] << 8) | b[9]) & 0xffff;
        const crcCalc = (~crc16(b, 8, 0x3d65, 0)) & 0xffff;
        if (crcCalc !== crcRead)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Badger-ORION',
            type: 'Meter',
            id: (b[0] | (b[1] << 8) | (b[2] << 16)) >>> 0,
            flags_1: b[3],
            volume_gal: (b[4] | (b[5] << 8) | (b[6] << 16)) >>> 0,
            flags_2: b[7],
            mic: 'CRC',
        });
        return 1;
    },
});
const MAP16TO6 = [-1, -1, -1, 0, -1, 1, 2, -1, -1, 5, 4, -1, 3, -1, -1, -1];
function neptuneDecode(bits, ctx, isBcd) {
    if (bits.numRows !== 1)
        return DECODE_ABORT_LENGTH;
    const pre = new Uint8Array([0x55, 0x55, 0x55, 0xa9, 0x66, 0x69, 0x65]);
    const preLen = pre.length * 8;
    const rowBits = bits.bitsPerRow[0];
    const startPos = bits.search(0, 0, pre, preLen);
    if (startPos + preLen + 168 > rowBits)
        return DECODE_ABORT_LENGTH;
    if (startPos === rowBits)
        return DECODE_ABORT_EARLY;
    const row = bits.bb[0];
    const base6 = new Uint8Array(21);
    let count = 0;
    for (let k = startPos + preLen; k < startPos + preLen + 168; k += 8) {
        const byte = byteAt(row, k);
        const hi = MAP16TO6[(byte >> 4) & 0x0f];
        const lo = MAP16TO6[byte & 0x0f];
        if (hi < 0 || lo < 0)
            return DECODE_ABORT_EARLY;
        base6[count++] = 6 * hi + lo;
    }
    const packed = new BitBuffer();
    for (let i = 0; i < 21; i++) {
        const v = base6[i];
        for (let s = 4; s >= 0; s--)
            packed.addBit((v >> s) & 1);
    }
    const b = packed.bytes(0, 0, 13 * 8);
    let consumption = ((((b[9] >> 5) << 24) | (b[6] << 16) | (b[7] << 8) | b[8]) >>> 0);
    if (isBcd) {
        let bcd = 0;
        for (let i = 5; i >= 0; i--) {
            const digit = (consumption >>> (4 * i)) & 0x0f;
            if (digit > 9)
                return DECODE_ABORT_EARLY;
            bcd = bcd * 10 + digit;
        }
        consumption = bcd;
    }
    ctx.emit({
        model: isBcd ? 'Neptune-R900BCD' : 'Neptune-R900',
        type: 'Meter',
        id: (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0),
        unkn1: b[4] >> 4,
        metertype: b[4] & 0x0f,
        unkn2: b[5] >> 5,
        nouse: (b[5] >> 2) & 0x07,
        backflow: b[5] & 0x03,
        consumption,
        leak: (b[9] >> 2) & 0x07,
        leaknow: b[9] & 0x03,
        extra: hexOf(b, 3, 10),
    });
    return 1;
}
export const neptuneR900 = register({
    num: 228,
    name: 'Neptune R900 flow meters',
    what: 'water meter',
    modulation: 4,
    shortWidth: 30,
    longWidth: 30,
    resetLimit: 320,
    bands: US_METER_BANDS,
    decode: (_dev, bits, ctx) => neptuneDecode(bits, ctx, false),
});
export const neptuneR900bcd = register({
    num: 385,
    name: 'Neptune R900 BCD flow meters',
    what: 'water meter',
    modulation: 4,
    shortWidth: 30,
    longWidth: 30,
    resetLimit: 320,
    bands: US_METER_BANDS,
    disabled: true,
    decode: (_dev, bits, ctx) => neptuneDecode(bits, ctx, true),
});
const ARAD_KEYS_HI = new Uint8Array(88);
const ARAD_KEYS_LO = new Uint32Array(88);
{
    let hi = 0x30, lo = 0x37889dd8 >>> 0;
    for (let j = 87; j >= 0; j--) {
        ARAD_KEYS_HI[j] = hi;
        ARAD_KEYS_LO[j] = lo;
        const t39 = (hi >> 7) & 1, t31 = (lo >>> 31) & 1, t23 = (lo >>> 23) & 1;
        let nhi = ((hi << 1) | (lo >>> 31)) & 0xff;
        let nlo = (lo << 1) >>> 0;
        if (t39) {
            nlo = (nlo ^ 0x014013f8) >>> 0;
        }
        if (t31) {
            nhi ^= 0x20;
            nlo = (nlo ^ 0x1080d890) >>> 0;
        }
        if (t23) {
            nlo = (nlo ^ 0x018f36c8) >>> 0;
        }
        hi = nhi;
        lo = nlo;
    }
}
function aradChecksum(b) {
    let hi = 0, lo = 0;
    for (let n = 0; n < 11; n++) {
        for (let i = 0; i < 8; i++) {
            if ((b[n] >> (7 - i)) & 1) {
                hi ^= ARAD_KEYS_HI[n * 8 + i];
                lo = (lo ^ ARAD_KEYS_LO[n * 8 + i]) >>> 0;
            }
        }
    }
    return [hi & 0xff, lo >>> 0];
}
function aradFlipBit(b, bitIndex) {
    b[bitIndex >> 3] ^= 1 << (7 - (bitIndex % 8));
}
function aradCorrectBits(b, sHi, sLo) {
    for (let i = 0; i < 88; i++) {
        if (ARAD_KEYS_HI[i] === sHi && ARAD_KEYS_LO[i] === sLo) {
            aradFlipBit(b, i);
            return 1;
        }
    }
    for (let i = 0; i < 88; i++) {
        for (let j = i + 1; j < 88; j++) {
            if ((ARAD_KEYS_HI[i] ^ ARAD_KEYS_HI[j]) === sHi && ((ARAD_KEYS_LO[i] ^ ARAD_KEYS_LO[j]) >>> 0) === sLo) {
                aradFlipBit(b, i);
                aradFlipBit(b, j);
                return 2;
            }
        }
    }
    for (let i = 0; i < 88; i++) {
        for (let j = i + 1; j < 88; j++) {
            const xHi = ARAD_KEYS_HI[i] ^ ARAD_KEYS_HI[j];
            const xLo = (ARAD_KEYS_LO[i] ^ ARAD_KEYS_LO[j]) >>> 0;
            for (let k = j + 1; k < 88; k++) {
                if ((xHi ^ ARAD_KEYS_HI[k]) === sHi && ((xLo ^ ARAD_KEYS_LO[k]) >>> 0) === sLo) {
                    aradFlipBit(b, i);
                    aradFlipBit(b, j);
                    aradFlipBit(b, k);
                    return 3;
                }
            }
        }
    }
    return -1;
}
export const aradMsMeter = register({
    num: 260,
    name: 'Arad/Master Meter Dialog3G water utility meter',
    what: 'water meter',
    modulation: 18,
    shortWidth: 8.4,
    longWidth: 8.4,
    resetLimit: 100,
    bands: [915000000],
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_FAIL_SANITY;
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        if (rowBits < 18 * 8)
            return DECODE_ABORT_LENGTH;
        const sync4 = new Uint8Array([0xf5, 0x13, 0x85, 0x37]);
        const matchPos = bits.search(0, 0, sync4, 32);
        if (matchPos + 32 > rowBits)
            return DECODE_ABORT_LENGTH;
        const uidStart = Math.max(0, matchPos - 16);
        const payloadStart = matchPos + 32;
        if (payloadStart + 128 > rowBits)
            return DECODE_ABORT_LENGTH;
        const uidBits = Math.min(payloadStart - uidStart, 56);
        const u = bits.bytes(0, uidStart, uidBits);
        for (let i = 0; i < u.length; i++)
            u[i] = ~u[i] & 0xff;
        if (uidBits & 7)
            u[(uidBits - 1) >> 3] &= (0xff00 >> (uidBits & 7)) & 0xff;
        const b = bits.bytes(0, payloadStart, 128);
        for (let i = 0; i < b.length; i++)
            b[i] = ~b[i] & 0xff;
        const rxHi = b[11];
        const rxLo = (((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0);
        const [calcHi, calcLo] = aradChecksum(b);
        let corrections = 0;
        if (rxHi !== calcHi || rxLo !== calcLo) {
            corrections = aradCorrectBits(b, (rxHi ^ calcHi) & 0xff, ((rxLo ^ calcLo) >>> 0));
            if (corrections < 0)
                return DECODE_FAIL_MIC;
        }
        const serno = (b[1] | (b[2] << 8) | (b[3] << 16)) >>> 0;
        const snSufx = b[4];
        const flags1 = b[5];
        const readRaw = (b[6] | (b[7] << 8) | (b[8] << 16)) >>> 0;
        let scale = 0.1, unit = 'm3';
        if (snSufx === 0x00 && (flags1 === 0x00 || flags1 === 0x40)) {
            scale = 0.01;
            unit = 'm3';
        }
        else if (snSufx === 0x27 && flags1 === 0x00) {
            scale = 0.1;
            unit = 'gal';
        }
        ctx.emit({
            model: 'AradMsMeter-Dialog3G',
            type: 'Meter',
            id: `${String(serno).padStart(8, '0')}-${hex2(snSufx)}`,
            uid: hexOf(u, (uidBits + 7) >> 3),
            leaking: (b[0] & 0x20) >> 5,
            flags1: hex2(flags1),
            gear: scale,
            volume: Math.round(readRaw * scale * 1000) / 1000,
            unit,
            flags2: hex2(b[10]),
            corrections,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const GRIDSTREAM_CRC_INIT = [
    [0xe623, 'Kansas City MO', 'Evergy-Missouri West'],
    [0x5fd6, 'Dallas TX', 'Oncor'],
    [0xd553, 'Austin TX', 'Austin Energy'],
    [0x45f8, 'Dallas TX', 'CoServ'],
    [0x62c1, 'Quebec CAN', 'Hydro-Quebec'],
    [0x23d1, 'Seattle WA', 'Seattle City Light'],
    [0x2c22, 'Santa Barbara CA', 'Southern California Edison'],
    [0x142a, 'Washington', 'Puget Sound Energy'],
    [0x47f7, 'Pennsylvania', 'PPL Electric'],
    [0x22c6, 'Long Island NY', 'PSEG Long Island'],
    [0x8819, 'Alameda CA', 'Alameda Municipal Power'],
    [0x4e2d, 'Milwaukee WI', 'We Energies'],
    [0x1d65, 'Phoenix AZ', 'APS'],
    [0xb9a9, 'Mattoon IL', 'Coles-Moultrie Electric Co-op'],
    [0xd1ff, 'Newark NJ', 'PSEG New Jersey'],
    [0xba1f, 'Burleson TX', 'United Cooperative Services'],
];
function gridstreamChecksum(fullLength, length, b, adjust) {
    if (fullLength - 4 + adjust < length)
        return DECODE_ABORT_LENGTH;
    const crc = ((b[2 + length + adjust] << 8) | b[3 + length + adjust]) & 0xffff;
    for (let i = 0; i < GRIDSTREAM_CRC_INIT.length; i++) {
        if (crc16(b, length - 2, 0x1021, GRIDSTREAM_CRC_INIT[i][0], 4 + adjust) === crc)
            return i;
    }
    return DECODE_FAIL_MIC;
}
function gridstreamDecode(bits, ctx) {
    if (bits.numRows < 1)
        return DECODE_FAIL_SANITY;
    const rowBits = bits.bitsPerRow[0];
    const preV4 = new Uint8Array([0xaa, 0xaa, 0x00, 0x5f, 0xf0]);
    const preV5 = new Uint8Array([0xaa, 0xaa, 0x00, 0x7f, 0xf8]);
    const b = new Uint8Array(256);
    let protocolVersion;
    let offset = bits.search(0, 0, preV4, 36) + 36;
    if (offset >= rowBits) {
        offset = bits.search(0, 0, preV5, 37) + 37;
        if (offset >= rowBits)
            return DECODE_FAIL_SANITY;
        protocolVersion = 5;
    }
    else {
        protocolVersion = 4;
    }
    const numBits = Math.min(rowBits - offset, b.length * 10);
    const decodedLen = extractBytesUart8n1(bits.bb[0], offset, numBits, b);
    if (decodedLen < 5)
        return DECODE_FAIL_SANITY;
    if (b[0] !== 0x2a)
        return DECODE_FAIL_OTHER;
    const subtype = b[1];
    const subtypeMod = subtype === 0xd2 ? -1 : 0;
    const streamLen = subtype === 0xd2 ? b[2] : ((b[2] << 8) | b[3]);
    const ci = b[4 + subtypeMod];
    if (subtype === 0xd2 && ci === 0x52) {
        ctx.emit({
            model: 'LandisGyr-GS',
            type: 'Meter',
            subtype,
            protoversion: protocolVersion,
            ci,
            encrypted: 1,
        });
        return 1;
    }
    const crcIdx = gridstreamChecksum(decodedLen, streamLen, b, subtypeMod);
    if (crcIdx < 0)
        return DECODE_FAIL_MIC;
    const [initValue, location, provider] = GRIDSTREAM_CRC_INIT[crcIdx];
    const data = {
        model: 'LandisGyr-GS',
        type: 'Meter',
        networkID: hex4(initValue),
        location,
        provider,
        subtype,
        protoversion: protocolVersion,
        ci,
        mic: 'CRC',
    };
    let uptime = 0;
    if (subtype === 0x55) {
        data.destaddress = hexOf(b, 6, 5);
        data.wanaddress = hexOf(b, 6, 11);
        data.id = hexOf(b, 4, 24);
        uptime = (((b[18] << 24) | (b[19] << 16) | (b[20] << 8) | b[21]) >>> 0);
    }
    else if (subtype === 0xd5) {
        data.destaddress = hexOf(b, 4, 5);
        data.id = hexOf(b, 4, 9);
        if (streamLen === 0x47) {
            data.timestamp = (((b[14] << 24) | (b[15] << 16) | (b[16] << 8) | b[17]) >>> 0);
            uptime = (((b[22] << 24) | (b[23] << 16) | (b[24] << 8) | b[25]) >>> 0);
            data.wanaddress = hexOf(b, 6, 30);
        }
    }
    if (uptime > 0)
        data.uptime = uptime;
    ctx.emit(data);
    return 1;
}
export const gridstream96 = register({
    num: 271,
    name: 'Landis & Gyr Gridstream Power Meters 9.6k',
    what: 'electricity meter',
    modulation: 16,
    shortWidth: 104,
    longWidth: 104,
    resetLimit: 20000,
    bands: [915000000],
    decode: (_dev, bits, ctx) => gridstreamDecode(bits, ctx),
});
export const gridstream192 = register({
    num: 272,
    name: 'Landis & Gyr Gridstream Power Meters 19.2k',
    what: 'electricity meter',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 20000,
    bands: [915000000],
    decode: (_dev, bits, ctx) => gridstreamDecode(bits, ctx),
});
export const gridstream384 = register({
    num: 273,
    name: 'Landis & Gyr Gridstream Power Meters 38.4k',
    what: 'electricity meter',
    modulation: 16,
    shortWidth: 22,
    longWidth: 22,
    resetLimit: 20000,
    bands: [915000000],
    decode: (_dev, bits, ctx) => gridstreamDecode(bits, ctx),
});
const APATOR_NIBBLE_MAP = [0x0, 0x7, 0xf, 0x9, 0xe, 0xd, 0x3, 0x4, 0x2, 0x6, 0xc, 0xb, 0x1, 0x8, 0xa, 0x5];
function apatorDecode(bits, ctx, expectLen, model) {
    if (bits.numRows !== 1)
        return DECODE_ABORT_EARLY;
    const pre = new Uint8Array([0xaa, 0xaa, 0x69, 0x9a]);
    const rowBits = bits.bitsPerRow[0];
    const startPos = bits.search(0, 0, pre, 32);
    if (startPos === rowBits)
        return DECODE_ABORT_EARLY;
    const at = startPos + 32;
    const frameLen = expectLen + 3;
    if (at + frameLen * 8 > rowBits)
        return DECODE_ABORT_LENGTH;
    if ((byteAt(bits.bb[0], at) ^ 0xff) !== expectLen)
        return DECODE_ABORT_EARLY;
    const frame = bits.bytes(0, at, frameLen * 8);
    ibmWhitening(frame, frameLen);
    const rxCrc = ((frame[expectLen + 1] << 8) | frame[expectLen + 2]) & 0xffff;
    if (crc16(frame, expectLen + 1, 0x8005, 0xffff) !== rxCrc)
        return DECODE_FAIL_MIC;
    const p = new Uint8Array(expectLen);
    for (let i = 0; i < 2 * expectLen; i++) {
        const shift = (i % 2) ? 0 : 4;
        p[i >> 1] |= APATOR_NIBBLE_MAP[(frame[1 + (i >> 1)] >> shift) & 0x0f] << shift;
    }
    const dateAt = expectLen === 0x13 ? 15 : 12;
    const date = ((p[dateAt + 1] << 8) | p[dateAt]) & 0xffff;
    const dateStr = `${2000 + ((date >> 9) & 0x7f)}-`
        + `${String((date >> 5) & 0x0f).padStart(2, '0')}-${String(date & 0x1f).padStart(2, '0')}`;
    const data = {
        model,
        type: 'Meter',
        len: expectLen,
        date: dateStr,
        mic: 'CRC',
    };
    if (expectLen === 0x13) {
        data.id = ((((p[3] << 24) | (p[2] << 16) | (p[1] << 8) | p[0]) >>> 0) ^ 0x30000000) >>> 0;
        const volRaw = (((((p[7] << 24) | (p[6] << 16) | (p[5] << 8) | p[4]) >>> 0) & 0x0fffffff) >>> 3);
        data.volume_m3 = Math.round(volRaw) / 1000;
    }
    else {
        data.id = ((((p[3] << 24) | (p[2] << 16) | (p[1] << 8) | p[0]) >>> 0) ^ 0x38000000) >>> 0;
        data.current_heating = ((p[11] << 8) | p[10]) & 0xffff;
        data.last_yr_heating = ((p[5] << 8) | p[4]) & 0xffff;
    }
    data.payload = hexOf(p, expectLen);
    ctx.emit(data);
    return 1;
}
export const apatorMetraErm30 = register({
    num: 277,
    name: 'Apator Metra E-RM 30 water meter',
    what: 'water meter',
    modulation: 16,
    shortWidth: 25,
    longWidth: 25,
    resetLimit: 5000,
    decode: (_dev, bits, ctx) => apatorDecode(bits, ctx, 0x13, 'ApatorMetra-ERM30'),
});
export const apatorMetraEitn30 = register({
    num: 296,
    name: 'Apator Metra E-ITN 30 heat cost allocator',
    what: 'heat cost allocator',
    modulation: 16,
    shortWidth: 25,
    longWidth: 25,
    resetLimit: 5000,
    decode: (_dev, bits, ctx) => apatorDecode(bits, ctx, 0x11, 'ApatorMetra-EITN30'),
});
function orionEndpointModel(id) {
    if (id >= 30000000 && id <= 59999999)
        return 'ME or SE';
    if (id >= 60000000 && id <= 69999999)
        return 'Mobile M';
    if (id >= 70000000 && id <= 89999999)
        return 'Classic (CE)';
    if (id >= 110000000 && id <= 119999999)
        return 'LTE';
    if (id >= 120000000 && id <= 129999999)
        return 'LTE-M or LTE-MS';
    if (id >= 130000000 && id <= 139999999)
        return 'C or CS';
    if (id >= 140000000 && id <= 148999999)
        return 'HLA';
    if (id >= 149000000 && id <= 149999999)
        return 'HLC';
    if (id >= 150000000 && id <= 159999999)
        return 'HLB';
    if (id >= 160000000 && id <= 169999999)
        return 'HLD';
    if (id >= 170000000 && id <= 179999999)
        return 'HLFX';
    if (id >= 180000000 && id <= 189999999)
        return 'HLG';
    return 'Unknown Model';
}
function orionEndpointDecode(bits, ctx) {
    if (bits.numRows > 1)
        return DECODE_FAIL_SANITY;
    if (bits.numRows < 1)
        return DECODE_ABORT_EARLY;
    const msgLen = bits.bitsPerRow[0];
    if (msgLen < 232 || msgLen > 290)
        return DECODE_ABORT_LENGTH;
    const pre = new Uint8Array([0xaa, 0xaa, 0xec, 0x62, 0xec, 0x62]);
    let offset = bits.search(0, 0, pre, 48);
    if (offset >= msgLen)
        return DECODE_ABORT_EARLY;
    offset += 48;
    if (msgLen - offset < 184)
        return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, offset, 184);
    ibmWhitening(b, 23);
    if (crc16(b, 23, 0x8005, 0xffff) !== 0)
        return DECODE_FAIL_MIC;
    const id = (((b[8] << 24) | (b[7] << 16) | (b[6] << 8) | b[5]) >>> 0);
    const dailyRaw = (((b[19] << 24) | (b[18] << 16) | (b[17] << 8) | b[16]) >>> 0);
    const data = {
        model: 'Orion-Endpoint',
        type: 'Meter',
        id,
        endpoint_model: orionEndpointModel(id),
        leaking: (b[10] & 0x20) >> 5,
        reading: (((b[15] << 24) | (b[14] << 16) | (b[13] << 8) | b[12]) >>> 0),
        flags_1: (((b[9] << 16) | (b[10] << 8) | b[11]) >>> 0),
        flags_2: b[20],
        mic: 'CRC',
    };
    if (dailyRaw)
        data.daily_reading = dailyRaw;
    ctx.emit(data);
    return 1;
}
export const orionEndpoint = register({
    num: 282,
    name: 'Orion Endpoint from Badger Meter, GIF2014W-OSE, water meter',
    what: 'water meter',
    modulation: 16,
    shortWidth: 10,
    longWidth: 10,
    resetLimit: 1000,
    bands: [915000000],
    decode: (_dev, bits, ctx) => orionEndpointDecode(bits, ctx),
});
export const orionEndpoint2020 = register({
    num: 290,
    name: 'Orion Endpoint from Badger Meter, GIF2020OCECNA, water meter',
    what: 'water meter',
    modulation: 16,
    shortWidth: 5,
    longWidth: 5,
    resetLimit: 1000,
    bands: [915000000],
    decode: (_dev, bits, ctx) => orionEndpointDecode(bits, ctx),
});
