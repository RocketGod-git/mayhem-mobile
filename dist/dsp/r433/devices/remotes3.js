import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { parity8, reflect4, xorBytes } from '../util.js';
const hexUp = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
function sumBytes(m, n, at = 0) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += m[at + i];
    return s;
}
const bitAt = (b, i) => (b[i >> 3] >> (7 - (i & 7))) & 1;
export const hondaRemote = register({
    num: 64,
    name: 'Honda Car Key',
    what: 'car remote',
    modulation: 17,
    shortWidth: 250,
    longWidth: 500,
    resetLimit: 2000,
    bands: [315000000, 433920000],
    disabled: true,
    decode(_dev, bits, ctx) {
        const names = ['boot', 'unlock', 'lock'];
        for (let row = 0; row < bits.numRows; row++) {
            const n = bits.bitsPerRow[row];
            if (n < 385 || n > 394)
                continue;
            const b = bits.bb[row];
            if (b[0] !== 0xff || b[38] !== 0xff)
                continue;
            const command = (b[46] - 0xaa) & 0xff;
            ctx.emit({
                model: 'Honda-CarRemote',
                type: 'Remote',
                id: (b[44] << 8) | b[45],
                code: names[command] ?? 'unknown',
            });
            return 1;
        }
        return 0;
    },
});
export const fordRemote = register({
    num: 93,
    name: 'Ford Car Key',
    what: 'car remote',
    modulation: 9,
    shortWidth: 250,
    longWidth: 500,
    resetLimit: 4000,
    tolerance: 50,
    bands: [315000000, 433920000],
    disabled: true,
    decode(_dev, bits, ctx) {
        let found = 0;
        for (let i = 3; i < bits.numRows; i++) {
            if (bits.bitsPerRow[i] < 78)
                continue;
            if (bits.bitsPerRow[i - 3] !== 1 || bits.bitsPerRow[i - 1] !== 1
                || bits.bitsPerRow[i - 2] !== 9 || bits.bb[i - 2][0] !== 0)
                continue;
            const b = bits.bb[i];
            ctx.emit({
                model: 'Ford-CarRemote',
                type: 'Remote',
                id: ((b[0] << 16) | (b[1] << 8) | b[2]) >>> 0,
                code: b[7],
            });
            found++;
        }
        return found;
    },
});
const DISH_BUTTONS = [
    'Undefined', 'Undefined', 'Swap', 'Undefined', 'Position', 'PIP', 'DVR', 'Undefined',
    'Skip Forward', 'Skip Backward', 'Undefined', 'Dish Button', 'Undefined', 'Forward', 'Backward', 'TV Power',
    'Reset', 'Undefined', 'Undefined', 'Undefined', 'Undefined', 'Undefined', 'SAT',
    'Mute/Volume Up/Volume Down',
    'Undefined', '#/Search', '*/Format', 'Undefined', 'Undefined', 'Undefined', 'Stop', 'Pause',
    'Record', 'Channel Down', 'Undefined', 'Left', 'Recall', 'Channel Up', 'Undefined', 'Right',
    'TV/Video', 'View/Live TV', 'Undefined', 'Guide', 'Undefined', 'Cancel', 'Digit 0', 'Select',
    'Page Up', 'Digit 9', 'Digit 8', 'Digit 7', 'Menu', 'Digit 6', 'Digit 5', 'Digit 4',
    'Page Down', 'Digit 3', 'Digit 2', 'Digit 1', 'Play', 'Dish Power', 'Undefined', 'Info',
];
export const dishRemote63 = register({
    num: 101,
    name: 'Dish remote 6.3',
    what: 'satellite remote',
    modulation: 5,
    shortWidth: 1692,
    longWidth: 2812,
    gapLimit: 4500,
    resetLimit: 9000,
    disabled: true,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 16);
        if (r < 0 || bits.bitsPerRow[r] > 16)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        if ((b[0] & 0x03) !== 0x02 || (b[1] & 0xe8) !== 0xa8)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Dish-RC63',
            type: 'Remote',
            button: DISH_BUTTONS[b[0] >> 2],
        });
        return 1;
    },
});
export const megacode = register({
    num: 199,
    name: 'Linear Megacode Garage/Gate Remotes',
    what: 'gate and garage remote',
    modulation: 4,
    shortWidth: 1000,
    longWidth: 1000,
    gapLimit: 9000,
    resetLimit: 20000,
    bands: [318000000],
    disabled: true,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(1, 144);
        if (row < 0)
            return DECODE_ABORT_LENGTH;
        const l = bits.bitsPerRow[row];
        if (l < 136 || l > 148)
            return DECODE_ABORT_LENGTH;
        let raw = 0, pulses = 0;
        const b = bits.bb[row];
        for (let i = 0; i < l; i++) {
            if (((b[i >> 3] << (i % 8)) & 0x80) !== 0) {
                if ((i + 4) % 6 > 2)
                    raw |= 0x800000 >>> (((i + 4) / 6) | 0);
                pulses++;
            }
        }
        if (pulses !== 24)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Megacode-Remote',
            type: 'Remote',
            id: (raw >> 3) & 0xffff,
            raw: hexUp(raw, 6),
            facility: (raw >> 19) & 0x0f,
            button: raw & 0x07,
        });
        return 1;
    },
});
function getBitsReflect(b, start, len) {
    let result = 0, mask = 1;
    for (let i = start; i < start + len; i++, mask <<= 1) {
        if (bitAt(b, i))
            result |= mask;
    }
    return result >>> 0;
}
function funkbusChecksum(b, len) {
    const fullBytes = len >> 3;
    const bitsLeft = len % 8;
    let xorByte = xorBytes(b, fullBytes);
    const mask = (0xff << (8 - bitsLeft)) & 0xff;
    xorByte = (xorByte ^ (b[fullBytes] & mask)) & 0xff;
    const nibble = ((xorByte & 0xf0) >> 4) ^ (xorByte & 0x0f);
    let result = 0;
    if (nibble & 0x8)
        result ^= 0x8c;
    if (nibble & 0x4)
        result ^= 0x32;
    if (nibble & 0x2)
        result ^= 0xc8;
    if (nibble & 0x1)
        result ^= 0x23;
    result &= 0x0f;
    result |= parity8(xorByte) << 4;
    return result;
}
export const funkbusRemote = register({
    num: 202,
    name: 'Funkbus / Instafunk (Berker, Gira, Jung)',
    what: 'light switch remote',
    modulation: 9,
    shortWidth: 500,
    longWidth: 1000,
    resetLimit: 2000,
    gapLimit: 1500,
    syncWidth: 4000,
    tolerance: 300,
    bands: [433420000],
    decode(_dev, bits, ctx) {
        let events = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] < 48)
                return DECODE_ABORT_LENGTH;
            const b = bits.bb[row];
            if (getBitsReflect(b, 0, 4) !== 0x4 || getBitsReflect(b, 4, 4) !== 0x3)
                return DECODE_ABORT_EARLY;
            const parity = getBitsReflect(b, 43, 1);
            const check = getBitsReflect(b, 44, 4);
            const checksum = funkbusChecksum(b, 43);
            if (check !== reflect4(checksum & 0x0f) || parity !== (checksum >> 4))
                return DECODE_FAIL_MIC;
            ctx.emit({
                model: 'Funkbus-Remote',
                type: 'Remote',
                id: getBitsReflect(b, 8, 20),
                battery_ok: getBitsReflect(b, 30, 1) ? 0 : 1,
                command: getBitsReflect(b, 33, 3),
                group: getBitsReflect(b, 36, 2),
                action: getBitsReflect(b, 39, 2),
                repeat: getBitsReflect(b, 41, 1),
                longpress: getBitsReflect(b, 42, 1),
                mic: 'CHECKSUM',
            });
            events++;
        }
        return events;
    },
});
const CODE_ALARM_BUTTONS = [
    { name: 'Multiple', vals: [0x7] },
    { name: 'Lock', vals: [0x6, 0x4] },
    { name: 'Panic', vals: [0x1, 0x3] },
    { name: 'Start', vals: [0x0, 0x3] },
    { name: 'Unlock', vals: [0x5, 0x4] },
];
export const codeAlarmFrdpc2000CarRemote = register({
    num: 317,
    name: 'Code Alarm FRDPC2002 Car Remote',
    what: 'car remote',
    modulation: 3,
    shortWidth: 550,
    longWidth: 1100,
    resetLimit: 1600,
    tolerance: 100,
    bands: [315000000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 60)
            return DECODE_ABORT_LENGTH;
        if (bits.bb[0][0] !== 0x00 || bits.bb[0][1] !== 0x00)
            return DECODE_FAIL_SANITY;
        const b = bits.bytes(0, 19, 40);
        const sum = sumBytes(b, 5);
        if (sum === 0 || sum >= 0xff * 5)
            return DECODE_FAIL_SANITY;
        const code = bits.bytes(0, 23, 36);
        const id = (((code[0] ^ code[1]) << 16) | ((code[1] ^ code[2]) << 8) | (code[2] ^ code[3])) >>> 0;
        const button = b[0] >> 4;
        const held = [];
        for (const entry of CODE_ALARM_BUTTONS) {
            if (entry.vals.includes(button))
                held.push(entry.name);
        }
        let data = '';
        for (let i = 0; i < 5; i++)
            data += hexUp(b[i], 2);
        ctx.emit({
            model: 'CodeAlarm-FRDPC2002',
            type: 'Remote',
            id: hexUp(id, 6),
            button_code: button,
            button_str: held.length ? held.join('; ') : '?',
            data,
        });
        return 1;
    },
});
