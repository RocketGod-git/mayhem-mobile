import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, register, } from '../device.js';
import { xorBytes } from '../util.js';
const hex2 = (v) => v.toString(16).padStart(2, '0');
export const genericRemote = register({
    num: 30,
    name: 'Generic remote SC226x EV1527',
    what: 'cheap doorbells, gate openers and alarm sensors',
    modulation: 6,
    shortWidth: 464,
    longWidth: 1404,
    resetLimit: 1800,
    tolerance: 200,
    bands: [433920000, 315000000],
    decode(_dev, bits, ctx) {
        const b = bits.bb[0];
        for (let i = 0; i < 3; i++)
            b[i] = ~b[i];
        if (bits.bitsPerRow[0] !== 25
            || (b[3] & 0x80) === 0
            || (b[0] === 0 && b[1] === 0)
            || b[2] === 0)
            return DECODE_ABORT_LENGTH;
        const full = (b[0] << 16) | (b[1] << 8) | b[2];
        let tristate = '';
        for (let i = 22; i >= 0; i -= 2) {
            tristate += ['0', 'Z', 'X', '1'][(full >> i) & 0x03];
        }
        ctx.emit({
            model: 'Generic-Remote',
            id: (b[0] << 8) | b[1],
            cmd: b[2],
            tristate,
        });
        return 1;
    },
});
export const intertechno = register({
    num: 14,
    name: 'Intertechno 433',
    what: 'mains switches and remotes',
    modulation: 5,
    shortWidth: 330,
    longWidth: 1400,
    gapLimit: 1700,
    resetLimit: 10000,
    disabled: true,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bb[0][0] !== 0 || (bits.bb[1][0] !== 0x56 && bits.bb[1][0] !== 0x69))
            return DECODE_ABORT_EARLY;
        const b = bits.bb[1];
        let id = '';
        for (let i = 0; i < 5; i++)
            id += hex2(b[i]);
        ctx.emit({
            model: 'Intertechno-Remote',
            id,
            slave: b[7] & 0x0f,
            master: (b[7] & 0xf0) >> 4,
            command: b[6] & 0x07,
        });
        return 1;
    },
});
export const proove = register({
    num: 51,
    name: 'Proove / Nexa / KlikAanKlikUit wireless switch',
    what: 'mains switches and remotes',
    modulation: 5,
    shortWidth: 270,
    longWidth: 1300,
    syncWidth: 2650,
    gapLimit: 1500,
    resetLimit: 2800,
    tolerance: 200,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.syncsBeforeRow[0] !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 64)
            return DECODE_ABORT_LENGTH;
        const databits = new BitBuffer();
        bits.manchesterDecode(0, 0, databits, 80);
        if (databits.bitsPerRow[0] < 32)
            return DECODE_ABORT_LENGTH;
        databits.invert();
        const b = databits.bb[0];
        ctx.emit({
            model: 'Proove-Security',
            id: ((b[0] << 18) | (b[1] << 10) | (b[2] << 2) | (b[3] >> 6)) >>> 0,
            channel: ((b[3] >> 2) & 0x03) ^ 0x03,
            state: ((b[3] >> 4) & 1) ? 'ON' : 'OFF',
            unit: (b[3] & 0x03) ^ 0x03,
            group: (b[3] >> 5) & 1,
        });
        return 1;
    },
});
export const cardin = register({
    num: 17,
    name: 'Cardin S466-TX2',
    what: 'gate and garage door remote',
    modulation: 6,
    shortWidth: 730,
    longWidth: 1400,
    syncWidth: 6150,
    gapLimit: 1600,
    resetLimit: 32000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 24)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        const cmd = b[2] & 0x3f;
        if (cmd !== 0x03 && cmd !== 0x09 && cmd !== 0x0c && cmd !== 0x06)
            return DECODE_ABORT_EARLY;
        const SWITCHES = [
            [0, 0x08, 1, 0x08], [0, 0x10, 1, 0x10], [0, 0x20, 1, 0x20],
            [0, 0x40, 1, 0x40], [0, 0x80, 1, 0x80], [2, 0x80, 2, 0x40],
            [0, 0x01, 1, 0x01], [0, 0x02, 1, 0x02], [0, 0x04, 1, 0x04],
        ];
        for (const [fb, fm, sb, sm] of SWITCHES) {
            if ((b[fb] & fm) === 0 && (b[sb] & sm) !== 0)
                return DECODE_ABORT_EARLY;
        }
        let dip = '';
        for (const [fb, fm, sb, sm] of SWITCHES) {
            dip += (b[fb] & fm) === 0 ? '-' : (b[sb] & sm) ? '+' : 'o';
        }
        ctx.emit({
            model: 'Cardin-S466',
            dipswitch: dip,
            rbutton: ['11R', '10R', '01R', '00L?'][((cmd & 0x0f) / 3 | 0) - 1],
        });
        return 1;
    },
});
const SOMFY_CONTROL = [
    '? (0)', 'My (1)', 'Up (2)', 'My + Up (3)', 'Down (4)', 'My + Down (5)', 'Up + Down (6)',
    'My + Up + Down (7)', 'Prog (8)', 'Sun + Flag (9)', 'Flag (10)', '? (11)', '? (12)', '? (13)', '? (14)', '? (15)',
];
const SOMFY_SEED = [
    '? (0)', '? (1)', '? (2)', '? (3)', '? (4)', 'Stop (5)', 'Up (6)', '? (7)',
    'Down (8)', '? (9)', '? (10)', '? (11)', 'Prog (12)', '? (13)', '? (14)', '? (15)',
];
export const somfyRts = register({
    num: 167,
    name: 'Somfy RTS',
    what: 'awning, blind and shutter remotes',
    modulation: 4,
    shortWidth: 604,
    longWidth: 604,
    gapLimit: 3000,
    resetLimit: 10000,
    tolerance: 20,
    bands: [433420000, 433920000],
    decode(_dev, bits, ctx) {
        const LONG = new Uint8Array([0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0x00]);
        const RATE = new Uint8Array([0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xfe, 0x00]);
        const SHORT = new Uint8Array([0xf0, 0xf0, 0xff, 0x00]);
        let retransmission = 0;
        let decodeRow = -1;
        let bitpos = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] > 170) {
                retransmission = 1;
                bitpos = bits.search(row, 0, LONG, 49) + 49;
                if (bitpos + 112 > bits.bitsPerRow[row])
                    bitpos = bits.search(row, 0, RATE, 48) + 48;
                if (bitpos + 112 <= bits.bitsPerRow[row]) {
                    decodeRow = row;
                    break;
                }
            }
            else if (bits.bitsPerRow[row] > 130) {
                retransmission = 0;
                bitpos = bits.search(row, 0, SHORT, 25) + 25;
                if (bitpos + 112 <= bits.bitsPerRow[row]) {
                    decodeRow = row;
                    break;
                }
            }
        }
        if (decodeRow < 0)
            return DECODE_ABORT_EARLY;
        if (bitpos + 112 > bits.bitsPerRow[decodeRow])
            return DECODE_ABORT_LENGTH;
        const decoded = new BitBuffer();
        bits.manchesterDecode(decodeRow, bitpos, decoded, 80);
        if (decoded.numRows === 0 || decoded.bitsPerRow[0] < 56)
            return DECODE_ABORT_LENGTH;
        const b = decoded.bb[0];
        for (let i = 6; i > 0; i--)
            b[i] ^= b[i - 1];
        let chk = xorBytes(b, 7);
        chk = (chk & 0x0f) ^ (chk >> 4);
        if (chk !== 0)
            return DECODE_FAIL_MIC;
        const seed = b[0];
        const control = (b[1] & 0xf0) >> 4;
        ctx.emit({
            model: 'Somfy-RTS',
            id: (b[6] << 16) | (b[5] << 8) | b[4],
            control: control === 0x0f ? SOMFY_SEED[seed & 0x0f] : SOMFY_CONTROL[control],
            counter: (b[2] << 8) | b[3],
            retransmission,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
