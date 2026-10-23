import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc7, crc8, crc16 } from '../util.js';
const BANDS = [315000000, 433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const hexLow = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
const hexOf = (b, n) => {
    let s = '';
    for (let i = 0; i < n; i++)
        s += hexLow(b[i], 2);
    return s;
};
export const tpmsBmw = register({
    num: 252,
    name: 'BMW Gen4-Gen5 TPMS and Audi TPMS Pressure Alert (HUF/Beru, Continental, Schrader/Sensata, Audi)',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 25,
    longWidth: 25,
    resetLimit: 100,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const pre = new Uint8Array([0xaa, 0x59]);
        const pos = bits.search(0, 0, pre, 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        let lenMsg = 11;
        const decoded = new BitBuffer();
        bits.manchesterDecode(0, pos + 16, decoded, lenMsg * 8);
        if (decoded.bitsPerRow[0] < 88) {
            if (decoded.bitsPerRow[0] >= 64)
                lenMsg = 8;
            else
                return DECODE_ABORT_LENGTH;
        }
        decoded.invert();
        const b = decoded.bb[0];
        if (crc8(b, lenMsg, 0x2f, 0xaa) !== 0)
            return DECODE_FAIL_MIC;
        const data = {
            model: lenMsg === 11 ? 'BMW-GEN5' : 'Audi-PressureAlert',
            type: 'TPMS',
            brand: b[0],
            id: hexOf(b.subarray(1), 4),
            pressure_kPa: round1(b[5] * 2.45),
            temperature_C: b[6] - 52,
            msg: hexOf(b, lenMsg),
            mic: 'CRC',
        };
        if (lenMsg === 11) {
            data.flags1 = b[7];
            data.flags2 = b[8];
            data.flags3 = b[9];
        }
        else {
            data.alert = 'Alert Pressure increase/decrease !';
        }
        ctx.emit(data);
        return 1;
    },
});
export const tpmsBmwG3 = register({
    num: 257,
    name: 'BMW Gen2 and Gen3 TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 160,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const pre = new Uint8Array([0xcc, 0xcd]);
        const pos = bits.search(0, 0, pre, 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const decoded = new BitBuffer();
        bits.differentialManchesterDecode(0, pos + 16, decoded, 88);
        const msgLen = decoded.bitsPerRow[0] ?? 0;
        const isGen2 = msgLen >= 80 && msgLen < 88 ? 1 : 0;
        if (msgLen < 80)
            return DECODE_ABORT_LENGTH;
        const b = decoded.bb[0];
        if (crc16(b, 11 - isGen2, 0x1021, 0x0000) !== 0)
            return DECODE_FAIL_MIC;
        const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
        const data = {
            model: isGen2 ? 'BMW-GEN2' : 'BMW-GEN3',
            type: 'TPMS',
            id: String(id),
            pressure_kPa: round1((b[4] - 43) * 2.5),
            temperature_C: b[5] - 40,
            flags1: b[6],
            flags2: b[7],
            msg: hexOf(b, isGen2 ? 10 : 11),
            mic: 'CRC',
        };
        if (!isGen2)
            data.flags3 = b[8];
        ctx.emit(data);
        return 1;
    },
});
function trwDecode(bits, ctx, fsk) {
    if (bits.numRows !== 1)
        return DECODE_ABORT_EARLY;
    const msgLen = bits.bitsPerRow[0];
    if (msgLen > 98)
        return DECODE_ABORT_LENGTH;
    const pre = fsk ? new Uint8Array([0x7f, 0xff]) : new Uint8Array([0x00, 0x01]);
    let pos = bits.search(0, 0, pre, 16);
    if (pos >= msgLen)
        return DECODE_ABORT_EARLY;
    if (pos + 8 * 11 > msgLen)
        return DECODE_ABORT_LENGTH;
    pos += 16;
    if (msgLen - pos < 81)
        return DECODE_ABORT_LENGTH;
    const b = bits.bytes(0, pos, 88);
    if (crc8(b, 10, 0x07, 0x00) !== 0)
        return DECODE_FAIL_MIC;
    const flags = (b[5] & 0xf0) >> 4;
    const motion = b[8];
    const oem = (b[10] & 0xf0) >> 4;
    const data = {
        model: 'TRW',
        type: 'TPMS',
        mode: hexLow(b[0], 2),
        id: hexOf(b.subarray(1), 4),
        flags: hexLow(flags, 1),
        seq_num: b[5] & 0x0f,
        pressure_PSI: round1(b[6] * 0.4),
        temperature_C: b[7] - 50,
        motion_flags: hexLow(motion, 2),
        motion_status: motion === 0x0e ? 'Parked' : 'Moving',
        mic: 'CRC',
    };
    if (flags === 0x6 || flags === 0x9)
        data.alert = 'Pressure increase/decrease !';
    if (oem === 0x4)
        data.oem_model = 'OEM';
    else if (oem === 0x0)
        data.oem_model = 'Clone';
    ctx.emit(data);
    return 1;
}
export const tpmsTrwOok = register({
    num: 298,
    name: 'TRW TPMS OOK OEM and Clone models',
    what: 'tire pressure sensor: Chrysler',
    modulation: 3,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: BANDS,
    decode: (_dev, bits, ctx) => trwDecode(bits, ctx, false),
});
export const tpmsTrwFsk = register({
    num: 299,
    name: 'TRW TPMS FSK OEM and Clone models',
    what: 'tire pressure sensor: Chrysler',
    modulation: 18,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: BANDS,
    decode: (_dev, bits, ctx) => trwDecode(bits, ctx, true),
});
export const tpmsSmartire = register({
    num: 343,
    name: 'SmarTire TPMS sensor, Aston Martin/Vantage DB9 protocol',
    what: 'tire pressure sensor',
    modulation: 4,
    shortWidth: 167,
    longWidth: 167,
    resetLimit: 1000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const pre = new Uint8Array([0x32, 0xb4]);
        const pos = bits.search(0, 0, pre, 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const decoded = new BitBuffer();
        bits.differentialManchesterDecode(0, pos + 16, decoded, 6 * 8);
        if ((decoded.bitsPerRow[0] ?? 0) < 6 * 8 - 1)
            return DECODE_ABORT_LENGTH;
        const b = decoded.bb[0];
        if (crc7(b, 6, 0x45, 0x6f) !== 0)
            return DECODE_FAIL_MIC;
        const msgType = (b[1] & 0xc0) >> 6;
        const value = b[0] - 40;
        const data = {
            model: 'SmarTire-AM',
            type: 'TPMS',
            id: String(((b[1] & 0x3f) << 16) | (b[2] << 8) | b[3]),
            flags: b[4] & 0x7f,
            mic: 'CRC',
        };
        if (msgType === 0)
            data.pressure_kPa = round1(value * 2.5);
        else if (msgType === 1)
            data.temperature_C = value;
        else
            return DECODE_ABORT_EARLY;
        if ((b[4] & 0x80) >> 7)
            data.inflate = 1;
        ctx.emit(data);
        return 1;
    },
});
export const tpmsMercedesBenz = register({
    num: 365,
    name: 'Mercedes Benz Sprinter 4500 TPMS sensor',
    what: 'tire pressure sensor',
    modulation: 18,
    shortWidth: 25,
    longWidth: 25,
    resetLimit: 2000,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const pre = new Uint8Array([0x00, 0x20]);
        const pos = bits.search(0, 0, pre, 12);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 80)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, pos + 12, 80);
        if (crc8(b, 10, 0x2f, 0xaa) !== 0)
            return DECODE_FAIL_MIC;
        if (b[0] !== 0x83 && b[0] !== 0xa3)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'MercedesBenz-Sprinter',
            type: 'TPMS',
            id: hexOf(b.subarray(1), 4),
            pressure_PSI: round1(b[5] / 2.75),
            temperature_C: b[6] - 51,
            counter: b[7] & 0x1f,
            flags1: b[7] >> 5,
            flags2: b[8],
            mic: 'CRC',
        });
        return 1;
    },
});
function jeepDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.manchesterDecode(row, bitpos, packet, 88);
    if (packet.bitsPerRow[0] < 80)
        return DECODE_FAIL_SANITY;
    const b = packet.bb[0];
    if (b[6] === 0 || b[7] === 0)
        return DECODE_ABORT_EARLY;
    let chk = 0;
    for (let i = 1; i <= 9; i++)
        chk ^= b[i];
    if (chk !== 0)
        return DECODE_FAIL_MIC;
    const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    ctx.emit({
        model: 'Jeep',
        type: 'TPMS',
        id: hexLow(id, 8),
        state: hexLow(b[0], 2),
        flags: b[5] >> 4,
        repeat: b[5] & 0x0f,
        pressure_kPa: Math.round(b[6] * 2.728),
        temperature_C: b[7] - 50,
        maybe_battery: b[8],
        mic: 'CHECKSUM',
    });
    return 1;
}
export const tpmsJeep = register({
    num: 380,
    name: 'Jeep TPMS',
    what: 'tire pressure sensor: Grand Cherokee',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: BANDS,
    disabled: true,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xaa, 0xa9]);
        bits.invert();
        let bitpos = 0, events = 0, ret = 0;
        while ((bitpos = bits.search(0, bitpos, pre, 16)) + 178 <= bits.bitsPerRow[0]) {
            ret = jeepDecode(bits, ctx, 0, bitpos + 16);
            if (ret > 0)
                events += ret;
            bitpos += 2;
        }
        return events > 0 ? events : ret;
    },
});
export const tpmsHonda = register({
    num: 381,
    name: 'Honda (TRW PPA-GF33) TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 50,
    longWidth: 50,
    resetLimit: 200,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const marker = new Uint8Array([0xda, 0xe3, 0x54]);
        if (bits.search(0, 0, marker, 23) !== 0)
            return DECODE_ABORT_EARLY;
        if (23 + 128 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const packet = new BitBuffer();
        bits.manchesterDecode(0, 23, packet, 64);
        if (packet.bitsPerRow[0] < 64)
            return DECODE_ABORT_LENGTH;
        const b = packet.bb[0];
        if (crc8(b, 7, 0x07, 0x00) !== b[7])
            return DECODE_FAIL_MIC;
        if (b[0] > 0 && b[0] < 50)
            return DECODE_ABORT_EARLY;
        const id = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
        ctx.emit({
            model: 'Honda-TRW',
            type: 'TPMS',
            id: hexLow(id, 8),
            pressure_PSI: round1(b[0] * 0.2),
            temperature_C: b[1] - 50,
            flags: hexLow(b[6], 2),
            mic: 'CRC',
        });
        return 1;
    },
});
