import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, crc16 } from '../util.js';
const BANDS = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const hexLow = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
const hexFrom = (b, at, n) => {
    let s = '';
    for (let i = at; i < at + n; i++)
        s += hexLow(b[i], 2);
    return s;
};
function jansiteSolarDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.manchesterDecode(row, bitpos, packet, 88);
    packet.invert();
    if (packet.bitsPerRow[0] < 88)
        return DECODE_FAIL_SANITY;
    const b = packet.bb[0];
    if (((b[0] << 8) | b[1]) !== 0xdd33)
        return DECODE_FAIL_SANITY;
    if ((((b[9] << 8) | b[10]) & 0xffff) !== crc16(b, 7, 0x8005, 0x0000, 2))
        return DECODE_FAIL_MIC;
    ctx.emit({
        model: 'Jansite-Solar',
        type: 'TPMS',
        id: hexFrom(b, 2, 3),
        flags: b[5],
        pressure_kPa: Math.round(b[7] * 1.6),
        temperature_C: b[6] - 55,
        code: hexFrom(b, 2, 9),
        mic: 'CRC',
    });
    return 1;
}
export const tpmsJansiteSolar = register({
    num: 180,
    name: 'Jansite TPMS Model Solar',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 51,
    longWidth: 51,
    resetLimit: 5000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xa6, 0xa6, 0x5a]);
        let bitpos = 0, events = 0, ret = 0;
        while ((bitpos = bits.search(0, bitpos, pre, 24)) + 80 <= bits.bitsPerRow[0]) {
            ret = jansiteSolarDecode(bits, ctx, 0, bitpos);
            if (ret > 0)
                events += ret;
            bitpos += 2;
        }
        return events > 0 ? events : ret;
    },
});
function sp372Frame(bits) {
    if (bits.numRows !== 1)
        return null;
    const len = bits.bitsPerRow[0];
    const pos = bits.search(0, 0, new Uint8Array([0xaa, 0xaa, 0xaa]), 24);
    if (pos >= len)
        return null;
    if (len - pos < 160)
        return null;
    const packet = new BitBuffer();
    bits.manchesterDecode(0, pos + 32, packet, 64);
    packet.invert();
    if (packet.bitsPerRow[0] < 64)
        return null;
    const b = packet.bb[0];
    if (b[7] !== b[0])
        return null;
    if ((b[0] & 0x0f) !== (b[1] & 0x0f))
        return null;
    return b;
}
const TY468_UNITS = {
    0xfb: { temp: 224, press: 273 },
    0x64: { temp: 153, press: 201 },
};
export const tpmsJansiteTy468 = register({
    num: 355,
    name: 'Jansite TPMS TY-468-eu2 / KKMOON TPMS',
    what: 'tire pressure sensor',
    modulation: 4,
    shortWidth: 50,
    longWidth: 50,
    resetLimit: 200,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const b = sp372Frame(bits);
        if (!b)
            return DECODE_ABORT_EARLY;
        const unit = TY468_UNITS[(b[3] + b[4]) & 0xff];
        if (!unit)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Jansite-TY468',
            type: 'TPMS',
            temperature_C: unit.temp - ((b[2] + b[5]) & 0xff),
            pressure_kPa: round1((unit.press - ((b[5] + b[6]) & 0xff)) * 2.5),
            code: hexFrom(b, 0, 7),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const tpmsImarsT240 = register({
    num: 354,
    name: 'iMars T240 TPMS',
    what: 'tire pressure sensor',
    modulation: 4,
    shortWidth: 50,
    longWidth: 50,
    resetLimit: 200,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const b = sp372Frame(bits);
        if (!b)
            return DECODE_ABORT_EARLY;
        const checksum = (b[3] + b[4]) & 0xff;
        if (checksum !== 0x41 && checksum !== 0x3c)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'iMars-T240',
            type: 'TPMS',
            code: hexFrom(b, 0, 7),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
function jansiteTy588Decode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.manchesterDecode(row, bitpos + 44, packet, 64);
    if (packet.bitsPerRow[0] < 64)
        return DECODE_ABORT_LENGTH;
    const b = packet.bb[0];
    if (b[7] !== b[0])
        return DECODE_FAIL_MIC;
    if (((b[3] + b[4]) & 0xff) !== 0x30 || (b[0] & 0x0f) !== (b[1] & 0x0f))
        return DECODE_FAIL_SANITY;
    const temperature = ((b[2] + b[5]) & 0xff) - 139;
    const pressureRaw = ((b[5] + b[6]) & 0xff) - 90;
    if (pressureRaw < 0 || temperature < -40 || temperature > 120)
        return DECODE_FAIL_SANITY;
    ctx.emit({
        model: 'Jansite-TY588',
        type: 'TPMS',
        pressure_kPa: round1(pressureRaw * 2.5),
        temperature_C: temperature,
        code: hexFrom(b, 0, 7),
        mic: 'CHECKSUM',
    });
    return 1;
}
export const tpmsJansiteTy588 = register({
    num: 362,
    name: 'Jansite TPMS TY588-EU2',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 51,
    longWidth: 51,
    resetLimit: 5000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0x99, 0xaa, 0x5a]);
        let bitpos = 0, events = 0, ret = 0;
        while ((bitpos = bits.search(0, bitpos, pre, 24)) + 172 <= bits.bitsPerRow[0]) {
            ret = jansiteTy588Decode(bits, ctx, 0, bitpos);
            if (ret > 0)
                events += ret;
            bitpos += 2;
        }
        return events > 0 ? events : ret;
    },
});
export const tpmsEezrv = register({
    num: 241,
    name: 'EezTire E618, Carchet TPMS, TST-507 TPMS',
    what: 'tire pressure sensor: caravan and trailer monitor',
    modulation: 3,
    shortWidth: 50,
    longWidth: 50,
    resetLimit: 120,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        bits.invert();
        const pos = bits.search(0, 0, new Uint8Array([0xff, 0xff]), 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (pos > 0)
            return DECODE_ABORT_EARLY;
        if (pos + 10 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const cc = bits.bytes(0, pos + 16, 8);
        const b = bits.bytes(0, pos + 24, 56);
        let computed = 0;
        for (let i = 0; i < 7; i++)
            computed += b[i];
        if (computed > 0xff)
            computed |= 0x80;
        if ((computed & 0xff) !== cc[0])
            return DECODE_FAIL_MIC;
        const flags1 = b[5];
        const flags2 = b[6];
        const inflating = (flags1 & 0x20) >> 5;
        const data = {
            model: 'EezTire-E618',
            type: 'TPMS',
            id: hexFrom(b, 0, 3),
            battery_ok: flags1 >> 7 ? 0 : 1,
            pressure_kPa: Math.round((((flags2 & 0x01) << 8) + b[3]) * 2.5),
            temperature_C: b[4] - 50,
            flags: `${hexLow(flags1, 2)}${hexLow(flags2, 2)}`,
            fast_leak: (flags1 & 0x10) && !inflating ? 1 : 0,
            inflate: inflating,
            mic: 'CHECKSUM',
        };
        ctx.emit(data);
        return 1;
    },
});
function airpuxemDecode(bits, ctx, row, bitpos) {
    const dec = new BitBuffer();
    bits.manchesterDecode(row, bitpos, dec, 354);
    if (dec.bitsPerRow[0] < 84)
        return DECODE_FAIL_SANITY;
    const b = dec.bb[0];
    if ((b[0] >> 4) !== 0x5)
        return DECODE_FAIL_SANITY;
    const payload = dec.bytes(0, 4, 64);
    const crcs = dec.bytes(0, 4 + 64, 16);
    if (crcs[0] !== crc8(payload, 8, 0x2f, 0xaa))
        return DECODE_FAIL_MIC;
    const f = dec.bytes(0, 4, 80);
    const id = ((f[0] << 24) | (f[1] << 16) | (f[2] << 8) | f[3]) >>> 0;
    const pressure = (f[5] | (((f[4] >> 7) & 1) << 8) | (((f[4] >> 3) & 1) << 9)) - 100;
    ctx.emit({
        model: 'Airpuxem-TYH11EU6ZQ',
        type: 'TPMS',
        id: hexLow(id, 8),
        position: f[4] & 0x07,
        flags: (f[4] >> 4) & 0x07,
        pressure_kPa: pressure,
        temperature_C: (f[6] << 24) >> 24,
        battery_V: round1(f[7] * 0.02),
        code: hexFrom(b, 0, 11),
        mic: 'CRC',
    });
    return 1;
}
export const tpmsAirpuxem = register({
    num: 295,
    name: 'Airpuxem TPMS TYH11_EU6_ZQ',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xaa, 0xaa, 0xa9]);
        bits.invert();
        let events = 0, ret = 0;
        for (let row = 0; row < bits.numRows; row++) {
            let bitpos = 0;
            while ((bitpos = bits.search(row, bitpos, pre, 24)) + 80 <= bits.bitsPerRow[row]) {
                ret = airpuxemDecode(bits, ctx, row, bitpos + 24);
                if (ret > 0)
                    events += ret;
                bitpos += 2;
            }
        }
        return events > 0 ? events : ret;
    },
});
const SEFIS_PAGE = { 7: 0, 4: 1, 5: 2, 2: 3 };
export const tpmsSefisM3 = register({
    num: 378,
    name: 'Sefis M3 / Careud / Sykik SRTP300 TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 5000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const sync = new Uint8Array([0x66, 0x99, 0x96, 0xa6]);
        let pos = bits.search(0, 0, sync, 32);
        if (pos === bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (pos + 32 + 72 * 2 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        pos += 32;
        const packet = new BitBuffer();
        bits.manchesterDecode(0, pos, packet, 72);
        if (packet.bitsPerRow[0] < 72)
            return DECODE_ABORT_LENGTH;
        const b = new Uint8Array(9);
        for (let i = 0; i < 9; i++)
            b[i] = packet.bb[0][i] ^ 0xff;
        if (crc16(b, 7, 0x1021, 0x0000) !== (((b[7] << 8) | b[8]) & 0xffff))
            return DECODE_FAIL_MIC;
        const data = {
            model: 'Sefis-M3',
            type: 'TPMS',
            temperature_C: 14 + (((b[2] + b[5]) & 0xff) & 0x0f),
            code: hexFrom(b, 0, 7),
            mic: 'CRC',
        };
        const page = SEFIS_PAGE[b[4] >> 5];
        if (page !== undefined) {
            const code = (page << 13) | ((b[4] & 0x1f) << 8) | b[5];
            data.pressure_kPa = Math.max(0, Math.round((code - 0x0e00) / 102.4));
        }
        ctx.emit(data);
        return 1;
    },
});
