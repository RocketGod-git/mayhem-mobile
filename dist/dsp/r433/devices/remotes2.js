import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addNibbles, crc8, reflectBytes, reverse8, xorBytes } from '../util.js';
const BAND_315 = [315000000];
const BAND_BOTH = [315000000, 433920000];
const hexUp = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
function sumBytes(m, n, at = 0) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += m[at + i];
    return s;
}
function buttonsFrom(mask, names) {
    const held = [];
    for (let i = 0; i < names.length; i++)
        if (mask & (1 << i))
            held.push(names[i]);
    return held;
}
export const chryslerCarRemote = register({
    num: 303,
    name: 'Chrysler Car Remote',
    what: 'car remote',
    modulation: 6,
    shortWidth: 350,
    longWidth: 700,
    resetLimit: 350 * 50,
    syncWidth: 350 * 21,
    gapLimit: 350 * 12,
    tolerance: 100,
    bands: BAND_315,
    decode(_dev, bits, ctx) {
        let events = 0;
        bits.invert();
        for (let row = 0; row < bits.numRows; row++) {
            let offset;
            if (bits.bitsPerRow[row] >= 49)
                offset = 49;
            else if (bits.bitsPerRow[row] === 48)
                offset = 48;
            else
                continue;
            const b = bits.bytes(row, bits.bitsPerRow[row] - offset, 48);
            reflectBytes(b, 6);
            const sum = sumBytes(b, 5);
            if ((sum & 0xff) !== b[5])
                continue;
            if (sum === 0 || sum === 0xff * 5)
                continue;
            const button = b[4] >> 4;
            const multiPress = (b[4] & 0x4) !== 0;
            const held = buttonsFrom(button, ['Unlock', 'Lock', 'Panic']);
            if (!held.length || (held.length > 1 && !multiPress) || (held.length === 1 && multiPress))
                continue;
            ctx.emit({
                model: 'Chrysler-CarRemote',
                type: 'Remote',
                id: hexUp(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 8),
                button_code: button,
                button_str: held.join('; '),
                mic: 'CHECKSUM',
            });
            events++;
        }
        return events;
    },
});
export const nidecCarRemote = register({
    num: 304,
    name: 'Nidec Car Remote',
    what: 'car remote',
    modulation: 17,
    shortWidth: 250,
    longWidth: 500,
    resetLimit: 1000,
    bands: BAND_315,
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 128)
            return DECODE_ABORT_LENGTH;
        const pattern = new Uint8Array([0xff, 0xff, 0xff, 0xf0]);
        const offset = bits.search(0, 0, pattern, 32) + 32;
        if (bits.bitsPerRow[0] - offset < 56)
            return DECODE_ABORT_EARLY;
        let securityBits = bits.bitsPerRow[0] - offset - 48;
        if (securityBits > 16)
            securityBits = 16;
        bits.invert();
        const b = bits.bytes(0, offset, 64);
        const sequence = (b[0] << 8) | b[1];
        const id = ((b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
        const button = b[5] & 0x0f;
        const security = ((b[6] << 8) | b[7]) & 0xffff;
        if ((b[5] & 0xf0) !== 0x50)
            return DECODE_FAIL_SANITY;
        if (!id || !sequence || id === 0xffffff || sequence === 0xffff || !security || security === 0xffff) {
            return DECODE_FAIL_SANITY;
        }
        if (button !== 0x3 && button !== 0x4 && button !== 0x5 && button !== 0x6 && button !== 0xf) {
            return DECODE_FAIL_SANITY;
        }
        const names = {
            0x3: 'Lock', 0x4: 'Unlock', 0x5: 'Trunk/Panic Short Press',
            0x6: 'Panic Long Press', 0xf: 'Trunk Long Press',
        };
        ctx.emit({
            model: 'Nidec-OUCG8D',
            type: 'Remote',
            id: hexUp(id, 6),
            security: hexUp(security, 4),
            security_bits: securityBits,
            sequence,
            button_code: button,
            button_str: names[button] ?? '?',
        });
        return 1;
    },
});
export const sixScTwoCarRemote = register({
    num: 312,
    name: 'MIC 6SC2 Car Remote',
    what: 'car remote',
    modulation: 3,
    shortWidth: 250,
    longWidth: 0,
    resetLimit: 10000,
    bands: BAND_315,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(1, 48);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 88)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] !== 0x55 || b[1] !== 0x54)
            return DECODE_FAIL_SANITY;
        if (xorBytes(b, 9, 2) !== 0)
            return DECODE_FAIL_MIC;
        const encrypted = ((reverse8(b[5]) << 24) | (reverse8(b[4]) << 16)
            | (reverse8(b[3]) << 8) | reverse8(b[2])) >>> 0;
        const button = reverse8(b[6]) & 0x0f;
        const names = { 0x1: 'Unlock', 0x2: 'Lock', 0x3: 'Trunk', 0x4: 'Panic' };
        ctx.emit({
            model: 'MIC6SC2-CarRemote',
            type: 'Remote',
            encrypted: hexUp(encrypted, 8),
            button_code: button,
            button_str: names[button] ?? '?',
            sequence: (reverse8(b[8]) << 8) | reverse8(b[7]),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const gmCarRemote = register({
    num: 313,
    name: 'GM ABO1502T Car Remote',
    what: 'car remote',
    modulation: 5,
    shortWidth: 300,
    longWidth: 500,
    resetLimit: 20000,
    bands: BAND_315,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 113 || bits.numRows > 1)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, bits.bitsPerRow[0] - 113, 112);
        if (b[0] !== 0xff)
            return DECODE_FAIL_SANITY;
        const buttonChecksum = addNibbles(b, 1, 2);
        if (buttonChecksum === 0 || (buttonChecksum & 0x0f) !== 0)
            return DECODE_FAIL_MIC;
        const fullChecksum = sumBytes(b, 13, 1);
        if (fullChecksum === 0 || (fullChecksum & 0xff) !== 0)
            return DECODE_FAIL_MIC;
        const button = b[2] & 0x07;
        const id = ((b[3] << 24) | (b[4] << 16) | (b[5] << 8) | b[6]) >>> 0;
        const names = { 0x1: 'Unlock', 0x2: 'Lock', 0x3: 'Trunk', 0x4: 'Panic' };
        ctx.emit({
            model: 'GM-ABO1502T',
            type: 'Remote',
            id: `${hexUp(b[1], 2)}${hexUp(id, 8)}`,
            encrypted: hexUp(((b[10] << 16) | (b[11] << 8) | b[12]) >>> 0, 6),
            button_code: button,
            button_str: names[button] ?? '?',
            sequence: (b[7] << 16) | (b[8] << 8) | b[9],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const siemens5wy72xxCarRemote = register({
    num: 314,
    name: 'Siemens 5WY72XX Car Remote',
    what: 'car remote',
    modulation: 3,
    shortWidth: 220,
    longWidth: 0,
    resetLimit: 10000,
    bands: BAND_315,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 113 || bits.numRows > 1)
            return DECODE_ABORT_LENGTH;
        const offset = bits.search(0, 0, new Uint8Array([0x60, 0x01]), 16) + 16;
        const b = bits.bytes(0, offset, 96);
        const sum = sumBytes(b, 12);
        if (sum === 0 || sum === 0xff * 12)
            return DECODE_FAIL_SANITY;
        if (xorBytes(b, 12) !== 0)
            return DECODE_FAIL_MIC;
        const held = buttonsFrom(b[4], ['Lock', 'Unlock', 'Trunk', 'Panic', 'Left Door', 'Right Door']);
        ctx.emit({
            model: 'Siemens-5WY72XX',
            type: 'Remote',
            id: `${hexUp(b[3], 2)}${hexUp(b[2], 2)}${hexUp(b[1], 2)}${hexUp(b[0], 2)}`,
            encrypted: `${hexUp(b[10], 2)}${hexUp(b[9], 2)}${hexUp(b[8], 2)}${hexUp(b[7], 2)}`,
            button_code: b[4],
            button_str: held.join('; '),
            sequence: (b[5] << 8) | b[6],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const alpsFwb1u545CarRemote = register({
    num: 315,
    name: 'Alps FWB1U545 Car Remote',
    what: 'car remote',
    modulation: 18,
    shortWidth: 500,
    longWidth: 0,
    resetLimit: 1500,
    bands: BAND_BOTH,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 76 || bits.numRows > 1)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if (b[0] !== 0x55 || b[5] !== b[6])
            return DECODE_FAIL_SANITY;
        const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
        if (id === 0 || id === 0xffffffff)
            return DECODE_FAIL_SANITY;
        const button = b[5] >> 4;
        const names = {
            0xe: 'Lock', 0xc: 'Panic', 0x5: 'Panic Held', 0x1: 'Unlock',
        };
        ctx.emit({
            model: 'Alps-FWB1U545',
            type: 'Remote',
            id: hexUp(id, 8),
            button_code: button,
            button_str: names[button] ?? '?',
            sequence: (b[7] << 8) | b[8],
        });
        return 1;
    },
});
export const continentalCarRemote = register({
    num: 316,
    name: 'Continental KR5V2X Car Remote',
    what: 'car remote',
    modulation: 18,
    shortWidth: 100,
    longWidth: 200,
    resetLimit: 1500,
    bands: BAND_315,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 132)
            return DECODE_ABORT_LENGTH;
        const offset = bits.search(0, 0, new Uint8Array([0xf0, 0xf0, 0x60]), 20) + 20;
        if (bits.bitsPerRow[0] - offset < 112)
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, offset, 112);
        const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
        const button = b[5] >> 4;
        const sequence = (b[6] << 16) | (b[7] << 8) | b[8];
        const encrypted = ((b[9] << 24) | (b[10] << 16) | (b[11] << 8) | b[12]) >>> 0;
        if (!id || !button || !sequence
            || id === 0xfffffff || encrypted === 0xfffffff || sequence === 0xffffff) {
            return DECODE_FAIL_SANITY;
        }
        if (xorBytes(b, 14) !== 0)
            return DECODE_FAIL_MIC;
        const names = {
            0x1: 'Lock', 0x3: 'Unlock', 0x9: 'Trunk Long Press',
            0xa: 'Trunk/Panic Short Press', 0xb: 'Panic Long Press',
        };
        ctx.emit({
            model: 'Continental-KR5V2X',
            type: 'Remote',
            id: hexUp(id, 8),
            encrypted: hexUp(encrypted, 8),
            sequence,
            button_code: button,
            button_str: names[button] ?? '?',
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const hondaKeyfob = register({
    num: 327,
    name: 'Honda Keyfob KR5V2X/1X',
    what: 'car remote',
    modulation: 18,
    shortWidth: 60,
    longWidth: 120,
    resetLimit: 1500,
    bands: BAND_BOTH,
    decode(_dev, bits, ctx) {
        if (bits.numRows > 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 150 || bits.bitsPerRow[0] > 184)
            return DECODE_ABORT_LENGTH;
        const preamble = new Uint8Array([0xec, 0x0f, 0x62]);
        const at = bits.search(0, 0, preamble, 24);
        if (at + 16 + 120 > bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, at + 16, 120);
        if (crc8(b, 14, 0x2f, 0x00) !== b[14])
            return DECODE_FAIL_MIC;
        const names = {
            0x21: 'Lock', 0x22: 'Unlock', 0x24: 'Trunk', 0x27: 'Emergency', 0x2d: 'RemoteStart',
        };
        const data = {
            model: 'Honda-KR5V2X1X',
            type: 'Remote',
            id: hexUp(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, 8).toLowerCase(),
            event: names[b[6]] ?? '?',
            counter: hexUp((b[7] << 16) | (b[8] << 8) | b[9], 6).toLowerCase(),
            code: hexUp(((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) >>> 0, 8).toLowerCase(),
            mic: 'CRC',
        };
        ctx.emit(data);
        return 1;
    },
});
