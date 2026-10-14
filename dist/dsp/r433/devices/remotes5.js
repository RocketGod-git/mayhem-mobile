import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addNibbles, crc16 } from '../util.js';
const hexUp = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
function buttonNames(map, code) {
    const hit = [];
    for (const [name, vals] of map)
        if (vals.includes(code))
            hit.push(name);
    return hit.length ? hit.join('; ') : '?';
}
const ASTROSTART_BUTTONS = [
    ['Lock', [0x2b, 0x03, 0x27, 0x0f, 0x35, 0x37]],
    ['Panic', [0x1f, 0x35, 0x0d, 0x25, 0x15, 0x2d]],
    ['Start', [0x13, 0x37, 0x2d, 0x33, 0x3d, 0x3b]],
    ['Stop', [0x2f, 0x0d, 0x33, 0x03, 0x1d, 0x17]],
    ['Trunk', [0x23, 0x25, 0x3d, 0x1d, 0x27, 0x07]],
    ['Unlock', [0x0b, 0x15, 0x3b, 0x17, 0x07, 0x0f]],
    ['Multiple', [0x3f]],
];
export const astrostart2000 = register({
    num: 301,
    name: 'Astrostart 2000 Car Remote (-f 372.4M)',
    what: 'car alarm and remote starter',
    modulation: 5,
    shortWidth: 326,
    longWidth: 526,
    gapLimit: 541,
    resetLimit: 541,
    tolerance: 80,
    bands: [372400000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 52)
            return DECODE_ABORT_LENGTH;
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[0];
        if (b[0] !== (~b[1] & 0xff))
            return DECODE_FAIL_MIC;
        if ((b[6] >> 4) !== (addNibbles(b, 4, 2) & 0x0f))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Astrostart-2000',
            id: hexUp(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, 8),
            button_code: b[0],
            button_str: buttonNames(ASTROSTART_BUTTONS, b[0]),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const COMPUSTAR_BUTTONS = [
    ['Lock', [0x03, 0x05, 0x09, 0x0b, 0x0d, 0x0f, 0x1f, 0x17, 0x13, 0x15, 0x19, 0x1b, 0x1d]],
    ['Panic', [0x18]],
    ['Start', [0x09, 0x0a, 0x0c, 0x0b, 0x0e, 0x0d, 0x04, 0x1f, 0x08, 0x19, 0x1a, 0x1c, 0x1b, 0x1e, 0x1d, 0x12]],
    ['Trunk', [0x05, 0x06, 0x0c, 0x0e, 0x0d, 0x1f, 0x17, 0x02, 0x15, 0x16, 0x1c, 0x1e, 0x1d, 0x08, 0x14]],
    ['Unlock', [0x03, 0x06, 0x0a, 0x0b, 0x0e, 0x1f, 0x07, 0x17, 0x13, 0x16, 0x1a, 0x1b, 0x1e]],
    ['Long Press', [0x23, 0x31, 0x13, 0x16, 0x17, 0x1a, 0x1b, 0x1e, 0x15, 0x16, 0x1c, 0x1e, 0x1d, 0x08, 0x14,
            0x08, 0x19, 0x1a, 0x1c, 0x1b, 0x1e, 0x1d, 0x12, 0x13, 0x15, 0x19, 0x1b, 0x1d]],
];
export const compustar1wg3r = register({
    num: 302,
    name: 'Compustar 1WG3R Car Remote',
    what: 'car alarm remote',
    modulation: 6,
    shortWidth: 708,
    longWidth: 1076,
    syncWidth: 1448,
    resetLimit: 1532,
    decode(_dev, bits, ctx) {
        let events = 0;
        let previousRow = -1;
        for (let row = 0; row < bits.numRows; row++) {
            const b = bits.bb[row];
            if (bits.bitsPerRow[row] === 5 && (b[0] & 0xf8) === 0xf8) {
                previousRow = -1;
                continue;
            }
            if (bits.bitsPerRow[row] < 35)
                continue;
            if ((b[2] & 0xe0) !== 0xe0 || (b[4] & 1) !== 0)
                continue;
            if ((b[0] === 0xff && b[1] === 0xff) || (b[0] === 0x00 && b[1] === 0x00))
                continue;
            const buttonInverse = ((b[2] << 3) & 0xff) | (b[3] >> 5);
            const button = ((b[3] << 3) & 0xff) | (b[4] >> 5);
            if ((~buttonInverse & 0xff) !== button)
                continue;
            if (previousRow >= 0 && bits.compareRows(previousRow, row, 35))
                continue;
            previousRow = row;
            let names = buttonNames(COMPUSTAR_BUTTONS, button & 0x7f);
            if (button & 0x80)
                names += names === '?' ? 'Secondary Mode' : '; Secondary Mode';
            ctx.emit({
                model: 'Compustar-1WG3R',
                id: hexUp((b[0] << 8) | b[1], 4),
                button_code: button,
                button_str: names,
                mic: 'CHECKSUM',
            });
            events++;
        }
        return events;
    },
});
const AUDIOVOX_BUTTONS = ['Lock', 'Unlock', 'Option', 'Trunk'];
export const audiovoxProOe3b = register({
    num: 305,
    name: 'Audiovox PRO-OE3B Car Remote (-f 303.4M)',
    what: 'car alarm remote',
    modulation: 6,
    shortWidth: 445,
    longWidth: 895,
    syncWidth: 1368,
    gapLimit: 1790,
    resetLimit: 1790,
    priority: 10,
    bands: [303400000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 25)
            return DECODE_ABORT_LENGTH;
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[0];
        if ((b[2] & 0xaa) || b[2] === 0x55)
            return DECODE_FAIL_SANITY;
        const id = (((~b[0] & 0xff) << 8) | (~b[1] & 0xff)) & 0xffff;
        if (id === 0 || id === 0xffff)
            return DECODE_FAIL_SANITY;
        const flags = ~b[2] & 0xff;
        const names = [];
        let mask = 0x01;
        for (const name of AUDIOVOX_BUTTONS) {
            if (flags & mask)
                names.push(name);
            mask <<= 2;
        }
        if (!names.length)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Audiovox-PROOE3B',
            id: hexUp(id, 4),
            button_str: names.join('; '),
        });
        return 1;
    },
});
export const twogigKey2e = register({
    num: 370,
    name: '2GIG-KEY2E-345 encrypted keyfob',
    what: 'alarm system keyfob',
    disabled: true,
    modulation: 4,
    shortWidth: 136,
    longWidth: 136,
    resetLimit: 408,
    bands: [345000000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 96)
            return DECODE_ABORT_LENGTH;
        const rawLen = bits.bitsPerRow[0];
        const at = bits.search(0, 0, new Uint8Array([0x55, 0x55, 0x56]), 24);
        if (at + 24 >= rawLen)
            return DECODE_ABORT_EARLY;
        const msg = new BitBuffer();
        bits.manchesterDecode(0, at + 24, msg, 72);
        if (msg.bitsPerRow[0] < 72)
            return DECODE_ABORT_LENGTH;
        const b = msg.bb[0];
        if (b[4] !== 0x25)
            return DECODE_ABORT_EARLY;
        if (crc16(b, 7, 0x8005, 0x4c57) !== (((b[7] << 8) | b[8]) & 0xffff))
            return DECODE_FAIL_MIC;
        const hx = (v) => v.toString(16).padStart(2, '0');
        ctx.emit({
            model: 'TwoGig-KEY2E345',
            encrypted_id: hx(b[0]) + hx(b[1]) + hx(b[2]) + hx(b[3]),
            encrypted_status: hx(b[5]) + hx(b[6]),
            mic: 'CRC',
        });
        return 1;
    },
});
