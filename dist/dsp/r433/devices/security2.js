import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, crc8le, crc16, reflectBytes, reverse8, xorBytes } from '../util.js';
const hexLow = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
const bitAt = (b, i) => (b[i >> 3] >> (7 - (i & 7))) & 1;
export const visonicPowercode = register({
    num: 151,
    name: 'Visonic powercode',
    what: 'alarm door and window sensor',
    modulation: 6,
    shortWidth: 400,
    longWidth: 800,
    gapLimit: 900,
    resetLimit: 5000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 37);
        if (row < 0)
            return DECODE_ABORT_LENGTH;
        if (bits.bitsPerRow[row] !== 37)
            return DECODE_ABORT_LENGTH;
        const msg = bits.bytes(row, 1, 36);
        if (!msg[0] && !msg[1] && !msg[2] && !msg[3] && !msg[4])
            return DECODE_FAIL_SANITY;
        const lrc = xorBytes(msg, 5);
        if (((lrc >> 4) ^ (lrc & 0x0f)) !== 0)
            return DECODE_FAIL_MIC;
        const f = msg[3];
        ctx.emit({
            model: 'Visonic-Powercode',
            type: 'Security',
            id: `${hexLow(msg[0], 2)}${hexLow(msg[1], 2)}${hexLow(msg[2], 2)}`,
            tamper: f & 0x80 ? 1 : 0,
            alarm: f & 0x40 ? 1 : 0,
            battery_ok: f & 0x20 ? 0 : 1,
            else: f & 0x10 ? 1 : 0,
            restore: f & 0x08 ? 1 : 0,
            supervised: f & 0x04 ? 1 : 0,
            spidernet: f & 0x02 ? 1 : 0,
            repeater: f & 0x01 ? 1 : 0,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const yaleHsa = register({
    num: 210,
    name: 'Yale HSA (Home Security Alarm), YES-Alarmkit',
    what: 'alarm sensor: door, motion, keypad and keyfob',
    modulation: 6,
    shortWidth: 850,
    longWidth: 1460,
    syncWidth: 5380,
    resetLimit: 1500,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 6)
            return DECODE_ABORT_EARLY;
        const msg = new Uint8Array(6);
        let row = 0;
        while (row < bits.numRows) {
            let ok = false;
            for (let i = 0; i < 6 && row < bits.numRows; i++, row++) {
                if (bits.bitsPerRow[row] !== 13)
                    break;
                const b = bits.bb[row];
                if ((b[0] & 0xf0) !== 0x50)
                    break;
                const eom = b[0] & 0x08;
                if ((i < 5 && eom) || (i === 5 && !eom))
                    break;
                msg[i] = bits.bytes(row, 5, 8)[0];
                if (i === 5)
                    ok = true;
            }
            if (!ok) {
                while (row < bits.numRows && !(bits.bb[row][0] & 0x08))
                    row++;
                row++;
                continue;
            }
            if ((addBytes(msg, 6) & 0xff) !== 0)
                continue;
            ctx.emit({
                model: 'Yale-HSA',
                type: 'Security',
                id: hexLow((msg[0] << 8) | msg[1], 4),
                stype: hexLow(msg[2], 2),
                state: hexLow(msg[3], 2),
                event: hexLow(msg[4], 2),
                mic: 'CHECKSUM',
            });
            return 1;
        }
        return 0;
    },
});
const KIDDE_ANCHOR = new Uint8Array([0x7f]);
export const kiddeSmoke = register({
    num: 361,
    name: 'Kidde RF-SM-DC wireless-interconnect smoke alarm',
    what: 'smoke and carbon monoxide alarm',
    modulation: 4,
    shortWidth: 400,
    longWidth: 400,
    resetLimit: 3000,
    bands: [433920000],
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 25 * 2)
            return DECODE_ABORT_LENGTH;
        const rowLen = bits.bitsPerRow[0];
        for (let start = 0; start < rowLen;) {
            const decoded = new BitBuffer();
            const next = bits.differentialManchesterDecode(0, start, decoded, 0);
            const len = decoded.bitsPerRow[0] ?? 0;
            start = next > start ? next : start + 1;
            if (len < 25)
                continue;
            const b = decoded.bb[0];
            let from = 9;
            while (from + 16 <= len) {
                const pos = decoded.search(0, from, KIDDE_ANCHOR, 8);
                if (pos + 16 > len)
                    break;
                from = pos + 1;
                if (pos < 9)
                    continue;
                if (bitAt(b, pos - 9) !== 0)
                    continue;
                let idRefl = 0, echo = 0;
                for (let i = 0; i < 8; i++)
                    idRefl = (idRefl << 1) | bitAt(b, pos - 8 + i);
                for (let i = 0; i < 8; i++)
                    echo = (echo << 1) | bitAt(b, pos + 8 + i);
                if (echo !== (idRefl ^ 0x80))
                    continue;
                ctx.emit({
                    model: 'Kidde-Smoke',
                    type: 'Security',
                    id: hexLow(reverse8(idRefl), 2),
                });
                return 1;
            }
        }
        return DECODE_FAIL_SANITY;
    },
});
const CAVIUS_MESSAGE = {
    0x80: 'Pairing',
    0x40: 'Test alarm',
    0x20: 'Fire alarm',
    0x10: 'Warning/Water detected',
    0x04: 'Alarm muted',
};
export const cavius = register({
    num: 179,
    name: 'Cavius smoke, heat and water detector',
    what: 'smoke, heat and water alarm',
    modulation: 16,
    shortWidth: 206,
    longWidth: 206,
    syncWidth: 2700,
    gapLimit: 1000,
    resetLimit: 1000,
    bands: [869670000],
    decode(_dev, bits, ctx) {
        const at = bits.search(0, 0, new Uint8Array([0x43, 0x61, 0x76, 0x69]), 32);
        if (at + 22 * 8 >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const packet = new BitBuffer();
        bits.manchesterDecode(0, at + 32, packet, 11 * 8);
        packet.invert();
        if (packet.bitsPerRow[0] < 11 * 8)
            return DECODE_FAIL_SANITY;
        const b = packet.bb[0];
        if (crc8le(b, 7, 0x31, 0x00) !== 0)
            return DECODE_FAIL_MIC;
        const batteryLow = (b[4] & 0x08) !== 0;
        const message = b[4] & ~0x08;
        ctx.emit({
            model: 'Cavius-Security',
            type: 'Security',
            id: (((b[7] << 24) | (b[8] << 16) | (b[9] << 8) | b[10]) >>> 0),
            battery_ok: batteryLow ? 0 : 1,
            net_id: (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0),
            message,
            text: CAVIUS_MESSAGE[message] ?? (batteryLow ? 'Battery low' : 'Unknown'),
            mic: 'CRC',
        });
        return 1;
    },
});
export const caviusDoor = register({
    num: 368,
    name: 'Cavius Door/Window sensor',
    what: 'alarm door and window sensor',
    modulation: 16,
    shortWidth: 415,
    longWidth: 415,
    resetLimit: 3000,
    bands: [868700000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowLen = bits.bitsPerRow[0];
        const pre = new Uint8Array([0xaa, 0xaa, 0xaa, 0xd3, 0x15, 0x27]);
        const at = bits.search(0, 0, pre, 48);
        if (at >= rowLen)
            return DECODE_ABORT_EARLY;
        if (at + 48 + 9 * 8 > rowLen)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, at + 48, 9 * 8);
        if (crc8(b, 8, 0x07, 0x00) !== b[8])
            return DECODE_FAIL_MIC;
        let state;
        if (b[7] === 0x25)
            state = 'open';
        else if (b[7] === 0x24)
            state = 'closed';
        else
            return DECODE_FAIL_SANITY;
        let id = '';
        for (let i = 1; i <= 6; i++)
            id += hexLow(b[i], 2);
        ctx.emit({
            model: 'Cavius-Door',
            type: 'Security',
            id,
            state,
            counter: b[0],
            mic: 'CRC',
        });
        return 1;
    },
});
function grayDecode(n) {
    let p = n;
    while ((n >>= 1))
        p ^= n;
    return p;
}
export const riscoAgility = register({
    num: 266,
    name: 'Risco 2 Way Agility protocol, Risco PIR/PET Sensor RWX95P',
    what: 'alarm motion detector',
    modulation: 4,
    shortWidth: 175,
    longWidth: 175,
    resetLimit: 1000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const pos = bits.search(0, 0, new Uint8Array([0x55, 0x5a]), 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const decoded = new BitBuffer();
        bits.differentialManchesterDecode(0, pos + 16, decoded, 16 * 8);
        if ((decoded.bitsPerRow[0] ?? 0) < 16 * 8)
            return DECODE_ABORT_LENGTH;
        const b = decoded.bb[0];
        if (crc16(b, 16, 0x8005, 0x8181) !== 0)
            return DECODE_FAIL_MIC;
        if (((b[0] << 8) | b[1]) !== 0xff60)
            return DECODE_ABORT_LENGTH;
        const id = ((b[6] << 16) | (b[7] << 8) | b[8]) >>> 0;
        reflectBytes(b, 16);
        const state = grayDecode(b[12] & 0x0f);
        const lowBatt = (grayDecode((b[12] & 0xf0) >> 4) & 0x08) >> 3;
        const data = {
            model: 'Risco-RWX95P',
            type: 'Security',
            id,
            counter: grayDecode((b[5] << 8) | b[4]),
            battery_ok: lowBatt ? 0 : 1,
            mic: 'CRC',
        };
        if ((state & 0x04) >> 2)
            data.tamper = 1;
        if ((state & 0x02) >> 1)
            data.motion = 1;
        ctx.emit(data);
        return 1;
    },
});
