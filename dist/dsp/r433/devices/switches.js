import { BitBuffer, bitAt } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
const BAND_433 = [433920000];
const hex2 = (v) => (v & 0xff).toString(16).padStart(2, '0');
function copyRow(bits, row) {
    const out = new BitBuffer();
    const src = bits.bb[row];
    const n = bits.bitsPerRow[row];
    for (let i = 0; i < n; i++)
        out.addBit(bitAt(src, i));
    return out;
}
export const waveman = register({
    num: 4,
    name: 'Waveman Switch Transmitter',
    what: 'mains switch remote',
    modulation: 6,
    shortWidth: 357,
    longWidth: 1064,
    gapLimit: 1400,
    resetLimit: 12000,
    tolerance: 200,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 25)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff)
            return DECODE_ABORT_EARLY;
        if ((b[0] & 0xaa) !== 0xaa || (b[1] & 0xaa) !== 0xaa || (b[2] & 0xaa) !== 0xaa)
            return DECODE_FAIL_SANITY;
        const nb = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            nb[i] = ((b[i] & 0x40) ? 0x00 : 0x01)
                | ((b[i] & 0x10) ? 0x00 : 0x02)
                | ((b[i] & 0x04) ? 0x00 : 0x04)
                | ((b[i] & 0x01) ? 0x00 : 0x08);
        }
        if (nb[2] !== 0xe && nb[2] !== 0x6) {
            ctx.log?.(`waveman: implausible state nibble ${nb[2].toString(16)}`);
            return DECODE_FAIL_SANITY;
        }
        ctx.emit({
            model: 'Waveman-Switch',
            id: String.fromCharCode(0x41 + nb[0]),
            channel: (nb[1] >> 2) + 1,
            button: (nb[1] & 3) + 1,
            state: nb[2] === 0xe ? 'ON' : 'OFF',
        });
        return 1;
    },
});
function kakuTernary(src) {
    const databits = new BitBuffer();
    const pos = src.manchesterDecode(0, 0, databits, 80);
    databits.invert();
    if (pos !== 64 && pos !== 72)
        return null;
    return databits.bb[0];
}
export const newkaku = register({
    num: 15,
    name: 'KlikAanKlikUit Wireless Switch',
    what: 'mains switches and remotes',
    modulation: 5,
    shortWidth: 300,
    longWidth: 1400,
    syncWidth: 2650,
    tolerance: 200,
    resetLimit: 3200,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.syncsBeforeRow[0] !== 1)
            return DECODE_ABORT_EARLY;
        const n = bits.bitsPerRow[0];
        if (n !== 64 && n !== 72)
            return DECODE_ABORT_LENGTH;
        const dim = (bits.bb[0][6] & 0x03) === 0x03;
        let src = bits;
        if (dim) {
            src = copyRow(bits, 0);
            src.bb[0][6] &= 0xfe;
        }
        const b = kakuTernary(src);
        if (!b)
            return DECODE_ABORT_LENGTH;
        ctx.emit({
            model: 'KlikAanKlikUit-Switch',
            id: (b[0] << 18) | (b[1] << 10) | (b[2] << 2) | (b[3] >> 6),
            unit: b[3] & 0x0f,
            group_call: ((b[3] >> 5) & 1) ? 'Yes' : 'No',
            command: ((b[3] >> 4) & 1) ? 'On' : 'Off',
            dim: dim ? 'Yes' : 'No',
            dim_value: b[4] >> 4,
        });
        return 1;
    },
});
export const nexa = register({
    num: 96,
    name: 'Nexa',
    what: 'magnetic door sensor and mains switches',
    modulation: 5,
    shortWidth: 270,
    longWidth: 1300,
    syncWidth: 2650,
    tolerance: 200,
    gapLimit: 1500,
    resetLimit: 2800,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.syncsBeforeRow[0] !== 1)
            return DECODE_ABORT_EARLY;
        const n = bits.bitsPerRow[0];
        if (n !== 64 && n !== 72)
            return DECODE_ABORT_LENGTH;
        const b = kakuTernary(bits);
        if (!b)
            return DECODE_ABORT_LENGTH;
        ctx.emit({
            model: 'Nexa-Security',
            id: (b[0] << 18) | (b[1] << 10) | (b[2] << 2) | (b[3] >> 6),
            channel: ((b[3] >> 2) & 0x03) ^ 0x03,
            state: ((b[3] >> 4) & 1) ? 'ON' : 'OFF',
            unit: (b[3] & 0x03) ^ 0x03,
            group: (b[3] >> 5) & 1,
        });
        return 1;
    },
});
function brennenstuhlRow(bits, ctx, row) {
    const b = bits.bb[row];
    if (bits.bitsPerRow[row] !== 25
        || (b[0] & 0xaa) !== 0xaa
        || (b[1] & 0xaa) !== 0xaa
        || (b[2] & 0xaa) !== 0xaa
        || b[3] !== 0x80)
        return 0;
    const systemCode = ((b[0] & 0x40) >> 2) | ((b[0] & 0x10) >> 1) | (b[0] & 0x04)
        | ((b[0] & 0x01) << 1) | ((b[1] & 0x40) >> 6);
    const controlKey = (b[1] & 0x10) | ((b[1] & 0x04) << 1) | ((b[1] & 0x01) << 2)
        | ((b[2] & 0x40) >> 5) | ((b[2] & 0x10) >> 4);
    const key = { 0x10: 'A', 0x08: 'B', 0x04: 'C', 0x02: 'D', 0x01: 'E' }[controlKey];
    if (!key)
        return 0;
    const onOff = ((b[2] & 0x04) >> 1) | (b[2] & 0x01);
    if (onOff !== 0x02 && onOff !== 0x01)
        return 0;
    ctx.emit({
        model: 'Brennenstuhl-RCS2044',
        id: systemCode,
        key,
        state: onOff === 0x02 ? 'ON' : 'OFF',
    });
    return 1;
}
export const brennenstuhlRcs2044 = register({
    num: 24,
    name: 'Brennenstuhl RCS 2044',
    what: 'mains socket remote',
    modulation: 6,
    shortWidth: 320,
    longWidth: 968,
    gapLimit: 1500,
    resetLimit: 4000,
    disabled: true,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        let events = 0;
        for (let row = 0; row < bits.numRows; row++)
            events += brennenstuhlRow(bits, ctx, row);
        return events;
    },
});
const HT680_TRISTATE = ['0', 'X', 'Z', '1'];
export const ht680 = register({
    num: 46,
    name: 'HT680 Remote control',
    what: 'gate and garage door remote',
    modulation: 6,
    shortWidth: 200,
    longWidth: 600,
    gapLimit: 1200,
    resetLimit: 14000,
    decode(_dev, bits, ctx) {
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 41)
                continue;
            if ((bits.bb[row][0] & 0xf8) !== 0xa8)
                continue;
            const b = bits.bytes(row, 5, 36);
            if ((b[1] & 0xf0) !== 0xa0)
                continue;
            if ((b[2] & 0x0c) !== 0x08)
                continue;
            if ((b[3] & 0x30) !== 0x20)
                continue;
            if ((b[4] & 0xf0) !== 0xa0)
                continue;
            let tristate = '';
            for (let byte = 0; byte < 5; byte++) {
                for (let shift = 6; shift >= 0; shift -= 2)
                    tristate += HT680_TRISTATE[(b[byte] >> shift) & 0x03];
            }
            tristate = tristate.slice(0, 18);
            const address = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
            const pressed = (v) => (v === 3 ? 'PRESSED' : '');
            ctx.emit({
                model: 'HT680-Remote',
                id: `0x${address.toString(16).toUpperCase().padStart(6, '0')}`,
                button1: pressed(b[3] & 0x03),
                button2: pressed((b[3] >> 2) & 0x03),
                button3: pressed((b[3] >> 6) & 0x03),
                button4: pressed(b[2] & 0x03),
                tristate,
            });
            return 1;
        }
        return 0;
    },
});
const AKHAN_COMMANDS = {
    0x1: '0x1 (Lock)',
    0x2: '0x2 (Unlock)',
    0x4: '0x4 (Mute)',
    0x8: '0x8 (Alarm)',
};
export const akhan100F14 = register({
    num: 48,
    name: 'Akhan 100F14 remote keyless entry',
    what: 'car keyless entry remote',
    modulation: 6,
    shortWidth: 316,
    longWidth: 1020,
    resetLimit: 1800,
    tolerance: 100,
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 25)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        const b0 = ~b[0] & 0xff, b1 = ~b[1] & 0xff, b2 = ~b[2] & 0xff;
        const cmd = b2 & 0x0f;
        const cmdStr = AKHAN_COMMANDS[cmd];
        if (!cmdStr)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Akhan-100F14',
            id: `0x${((b0 << 12) | (b1 << 4) | (b2 >> 4)).toString(16)}`,
            data: cmdStr,
        });
        return 1;
    },
});
export const quhwa = register({
    num: 49,
    name: 'Quhwa',
    what: 'wireless doorbell push',
    modulation: 6,
    shortWidth: 360,
    longWidth: 1070,
    gapLimit: 1200,
    resetLimit: 6600,
    tolerance: 80,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(5, 18);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[r];
        if (!b[0] && !b[1] && !b[2]) {
            ctx.log?.('quhwa: all bytes zero');
            return DECODE_FAIL_SANITY;
        }
        const b0 = ~b[0] & 0xff, b1 = ~b[1] & 0xff, b2 = ~b[2] & 0xff;
        if (bits.bitsPerRow[r] !== 18 || (b1 & 0x03) !== 0x03 || (b2 & 0xc0) !== 0xc0)
            return DECODE_ABORT_LENGTH;
        ctx.emit({
            model: 'Quhwa-Doorbell',
            id: (b0 << 8) | b1,
        });
        return 1;
    },
});
const BLYSS_CODES = [
    [0xce, 0x8e, 0x2a, 0x6c, 0x80],
    [0xe7, 0x37, 0x7a, 0x2c, 0x80],
];
export const blyss = register({
    num: 58,
    name: 'Blyss DC5-UK-WH',
    what: 'mains switch remote',
    modulation: 6,
    shortWidth: 500,
    longWidth: 1500,
    gapLimit: 2500,
    resetLimit: 8000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 33)
                continue;
            const b = bits.bb[row];
            if (!BLYSS_CODES.some(code => code.every((v, i) => b[i] === v)))
                continue;
            ctx.emit({
                model: 'Blyss-DC5ukwh',
                id: hex2(b[0]) + hex2(b[1]) + hex2(b[2]) + hex2(b[3]),
            });
            return 1;
        }
        return DECODE_FAIL_SANITY;
    },
});
export const elroDb286a = register({
    num: 62,
    name: 'Elro DB286A Doorbell',
    what: 'wireless doorbell push',
    modulation: 6,
    shortWidth: 456,
    longWidth: 1448,
    gapLimit: 2000,
    resetLimit: 8000,
    disabled: true,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(5, 33);
        if (row < 0 || bits.bitsPerRow[row] !== 33)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        ctx.emit({
            model: 'Elro-DB286A',
            id: hex2(b[0]) + hex2(b[1]) + hex2(b[2]) + hex2(b[3]),
        });
        return 1;
    },
});
export const rftech = register({
    num: 72,
    name: 'RF-tech',
    what: 'wireless thermometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 5000,
    resetLimit: 10000,
    disabled: true,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 24);
        if (r < 0 || bits.bitsPerRow[r] !== 24)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        let tempC = (b[1] & 0x7f) + (b[2] & 0x0f) * 0.1;
        if (b[1] & 0x80)
            tempC = -tempC;
        ctx.emit({
            model: 'RF-tech',
            id: b[0],
            battery_ok: (b[2] & 0x80) === 0x80 ? 1 : 0,
            temperature_C: tempC,
            button: (b[2] & 0x60) !== 0 ? 1 : 0,
        });
        return 1;
    },
});
export const jasco = register({
    num: 204,
    name: 'Jasco/GE Choice Alert Security Devices',
    what: 'door and window sensor',
    modulation: 4,
    shortWidth: 250,
    longWidth: 250,
    resetLimit: 1800,
    bands: [318010000],
    decode(_dev, bits, ctx) {
        const rawLen = bits.bitsPerRow[0];
        if (rawLen < 80 || rawLen > 87) {
            if (rawLen > 0)
                ctx.log?.(`jasco: invalid bit count ${rawLen}`);
            return DECODE_ABORT_EARLY;
        }
        const startPos = bits.search(0, 0, new Uint8Array([0xfc, 0x0c]), 16) + 16;
        if (startPos + 64 > rawLen)
            return DECODE_ABORT_LENGTH;
        const packet = new BitBuffer();
        bits.manchesterDecode(0, startPos, packet, 32);
        if (packet.bitsPerRow[0] < 32)
            return DECODE_ABORT_LENGTH;
        const b = packet.bb[0];
        if ((b[0] ^ b[1] ^ b[2] ^ b[3]) !== 0)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Jasco-Security',
            id: (b[0] << 8) | b[1],
            status: (b[2] & 0xef) === 0xef ? 1 : 0,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
