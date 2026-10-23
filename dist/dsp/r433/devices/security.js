import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8le, crc16, reverse8 } from '../util.js';
const hex = (v, digits) => (v >>> 0).toString(16).padStart(digits, '0');
export const honeywell = register({
    num: 70,
    name: 'Honeywell door/window sensor, 2Gig DW10/DW11, RE208 repeater',
    what: 'alarm door and window contacts',
    modulation: 4,
    shortWidth: 136,
    longWidth: 136,
    resetLimit: 408,
    bands: [345000000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 120)
            return DECODE_ABORT_LENGTH;
        const rawLen = bits.bitsPerRow[0];
        const preamble = new Uint8Array([0x55, 0x55, 0x56]);
        let pos = 0;
        let found = null;
        let channel = 0, deviceId = 0;
        while ((pos = bits.search(0, pos, preamble, 24)) + 24 < rawLen) {
            const decoded = new BitBuffer();
            bits.manchesterDecode(0, pos + 24, decoded, 96);
            pos += 1;
            if (decoded.bitsPerRow[0] < 48)
                continue;
            const b = decoded.bb[0];
            channel = b[0] >> 4;
            deviceId = ((b[0] & 0x0f) << 16) | (b[1] << 8) | b[2];
            const crc = (b[4] << 8) | b[5];
            if (deviceId === 0 && crc === 0)
                continue;
            const poly = (channel === 0x2 || channel === 0x4 || channel === 0x9 || channel === 0xa || channel === 0xc)
                ? 0x8050 : 0x8005;
            if (crc === crc16(b, 4, poly, 0)) {
                found = b;
                break;
            }
        }
        if (!found)
            return DECODE_FAIL_MIC;
        const event = found[3];
        const contact = (event & 0x80) >> 7;
        ctx.emit({
            model: 'Honeywell-Security',
            id: deviceId,
            channel,
            event,
            state: contact ? 'open' : 'closed',
            contact_open: contact,
            reed_open: (event & 0x20) >> 5,
            alarm: (event & 0x10) >> 4,
            tamper: (event & 0x40) >> 6,
            battery_ok: ((event & 0x08) >> 3) ? 0 : 1,
            heartbeat: (event & 0x04) >> 2,
            mic: 'CRC',
        });
        return 1;
    },
});
const INTERLOGIX_TYPES = {
    0xa: 'contact', 0xf: 'keyfob', 0x4: 'motion', 0x6: 'heat',
    0x9: 'glass', 0xd: 'glass', 0xe: 'freeze', 0x2: 'smoke', 0x3: 'panic',
};
export const interlogix = register({
    num: 100,
    name: 'Interlogix GE UTC security devices',
    what: 'alarm contacts, motion, glass-break, smoke and keyfobs',
    modulation: 5,
    shortWidth: 122,
    longWidth: 244,
    resetLimit: 500,
    bands: [319500000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 57 || bits.bitsPerRow[0] > 64)
            return DECODE_ABORT_LENGTH;
        let at = bits.search(0, 0, new Uint8Array([0x01]), 8);
        if (at === bits.bitsPerRow[0])
            return DECODE_FAIL_SANITY;
        at += 8;
        const m = bits.bytes(0, at, 46);
        if ((m[0] === 0x00 && m[1] === 0x00 && m[2] === 0x00)
            || (m[0] === 0xff && m[1] === 0xff && m[2] === 0xff)
            || (m[3] === 0x00 && m[4] === 0x00 && m[5] === 0x00)
            || (m[3] === 0xff && m[4] === 0xff && m[5] === 0xff))
            return DECODE_FAIL_SANITY;
        let parity = m[0] ^ m[1] ^ m[2] ^ m[3] ^ m[4];
        parity = (parity >> 4) ^ (parity & 0x0f);
        parity = (parity >> 2) ^ (parity & 0x03);
        parity ^= m[5] >> 6;
        if ((parity ^ 0x3) !== 0)
            return DECODE_FAIL_MIC;
        const typeNibble = reverse8(m[2]) >> 4;
        const deviceType = INTERLOGIX_TYPES[typeNibble];
        if (!deviceType)
            return DECODE_FAIL_SANITY;
        let lowBattery;
        let sw;
        if (typeNibble === 0xf) {
            lowBattery = 0;
            const k = m[3] & 0x0e;
            sw = [0x4, 0x8, 0xc, 0x2, 0xa].map(v => (k === v ? 'CLOSED' : 'OPEN'));
        }
        else {
            lowBattery = (m[3] & 0x10) ? 1 : 0;
            sw = [
                (m[3] & 0x04) ? 'OPEN' : 'CLOSED',
                (m[3] & 0x01) ? 'OPEN' : 'CLOSED',
                (m[4] & 0x40) ? 'OPEN' : 'CLOSED',
                (m[4] & 0x10) ? 'OPEN' : 'CLOSED',
                (m[4] & 0x04) ? 'OPEN' : 'CLOSED',
            ];
        }
        ctx.emit({
            model: 'Interlogix-Security',
            subtype: deviceType,
            id: hex(reverse8(m[2]), 2) + hex(reverse8(m[1]), 2) + hex(reverse8(m[0]), 2),
            battery_ok: lowBattery ? 0 : 1,
            switch1: sw[0], switch2: sw[1], switch3: sw[2], switch4: sw[3], switch5: sw[4],
            raw_message: hex(m[3], 2) + hex(m[4], 2) + hex(m[5], 2),
        });
        return 1;
    },
});
function dscDecode(bits, ctx) {
    let valid = 0;
    let result = 0;
    for (let row = 0; row < bits.numRows; row++) {
        if (bits.bitsPerRow[row] < 48 || bits.bitsPerRow[row] > 70) {
            result = DECODE_ABORT_EARLY;
            continue;
        }
        const b = bits.bb[row];
        if (!((b[0] & 0xf0) && (b[1] & 0x08) && (b[2] & 0x04) && (b[3] & 0x02) && (b[4] & 0x01))) {
            result = DECODE_ABORT_EARLY;
            continue;
        }
        const bytes = new Uint8Array([
            ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
            ((b[1] & 0x07) << 5) | ((b[2] & 0xf8) >> 3),
            ((b[2] & 0x03) << 6) | ((b[3] & 0xfc) >> 2),
            ((b[3] & 0x01) << 7) | ((b[4] & 0xfe) >> 1),
            b[5],
        ]);
        if (bytes[0] === 0xff && bytes[1] === 0xff && bytes[2] === 0xff && bytes[3] === 0xff) {
            result = DECODE_FAIL_SANITY;
            continue;
        }
        if (crc8le(bytes, 5, 0xf5, 0x3d) !== 0) {
            result = DECODE_FAIL_MIC;
            continue;
        }
        const status = bytes[0];
        const esn = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        ctx.emit({
            model: 'DSC-Security',
            id: esn,
            closed: (status & 0x02) === 0x02 ? 1 : 0,
            event: (status & 0x40) !== 0x40 ? 1 : 0,
            tamper: ((status & 0x01) !== 0x01 || (status & 0x10) === 0x10) ? 1 : 0,
            battery_ok: (status & 0x08) === 0x08 ? 0 : 1,
            xactivity: (status & 0x20) === 0x20 ? 1 : 0,
            xtamper1: (status & 0x01) !== 0x01 ? 1 : 0,
            xtamper2: (status & 0x10) === 0x10 ? 1 : 0,
            exception: ((status & 0x80) !== 0x80 || (status & 0x04) === 0x04) ? 1 : 0,
            esn: hex(esn, 6),
            status,
            status_hex: hex(status, 2),
            mic: 'CRC',
        });
        valid++;
    }
    return valid ? 1 : result;
}
export const dscSecurity = register({
    num: 23,
    name: 'DSC security contact',
    what: 'alarm door and window contacts',
    modulation: 4,
    shortWidth: 250,
    longWidth: 500,
    resetLimit: 5000,
    bands: [433920000, 315000000],
    decode: (_d, bits, ctx) => dscDecode(bits, ctx),
});
export const dscSecurityWs4945 = register({
    num: 148,
    name: 'DSC security contact (WS4945)',
    what: 'alarm contacts: EV-DW4927, WS4975, WS4945',
    modulation: 4,
    shortWidth: 536,
    longWidth: 1072,
    resetLimit: 9000,
    bands: [433920000, 315000000],
    decode: (_d, bits, ctx) => dscDecode(bits, ctx),
});
export const x10Rf = register({
    num: 22,
    name: 'X10 RF',
    what: 'home automation remotes and switches',
    modulation: 5,
    shortWidth: 562,
    longWidth: 1687,
    gapLimit: 2200,
    resetLimit: 6000,
    bands: [310000000, 433920000],
    decode(_dev, bits, ctx) {
        const b = bits.bb[1];
        if (bits.bitsPerRow[1] !== 32)
            return DECODE_ABORT_LENGTH;
        if ((b[0] ^ b[1]) !== 0xff || (b[2] ^ b[3]) !== 0xff)
            return DECODE_FAIL_SANITY;
        const MASK = [0x0b, 0x0b, 0x07, 0x07];
        const VALUE = [0x00, 0x0b, 0x00, 0x07];
        for (let i = 0; i < 4; i++)
            if ((MASK[i] & b[i]) !== VALUE[i])
                return DECODE_FAIL_SANITY;
        const h = [(b[0] & 0x80) >> 7, (b[0] & 0x40) >> 6, (b[0] & 0x20) >> 5, (b[0] & 0x10) >> 4];
        const house = ((~(h[0] ^ h[1]) & 1) << 3) | ((~h[1] & 1) << 2) | (((h[1] ^ h[2]) & 1) << 1) | (h[3] & 1);
        let unit = ((b[0] & 0x04) << 1) | ((b[2] & 0x40) >> 4) | ((b[2] & 0x08) >> 2) | ((b[2] & 0x10) >> 4);
        unit += 1;
        let event;
        if ((b[2] & 0x80) === 0x80) {
            unit = 0;
            event = b[2] === 0x98 ? 'DIM' : b[2] === 0x88 ? 'BRI'
                : b[2] === 0x90 ? 'ALL LTS ON' : b[2] === 0x80 ? 'ALL OFF' : 'UNKNOWN';
        }
        else {
            event = (b[2] & 0x20) === 0x00 ? 'ON' : 'OFF';
        }
        ctx.emit({
            model: 'X10-RF',
            id: unit,
            channel: String.fromCharCode(house + 65),
            state: event,
            data: hex(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 8),
            mic: 'PARITY',
        });
        return 1;
    },
});
export const chuango = register({
    num: 29,
    name: 'Chuango security technology',
    what: 'alarm sensors and remotes',
    modulation: 6,
    shortWidth: 568,
    longWidth: 1704,
    resetLimit: 1800,
    tolerance: 160,
    disabled: true,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 25)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        for (let i = 0; i < 3; i++)
            b[i] = ~b[i];
        if (!(b[3] & 0x80) || (!b[0] && !b[1] && !(b[2] & 0xf0)))
            return DECODE_ABORT_EARLY;
        const cmd = b[2] & 0x0f;
        const NAMES = {
            0xd: 'Low Battery', 0xc: 'Closing', 0xb: '24H Zone', 0xa: 'Single Delay Zone',
            0x8: 'Arm', 0x7: 'Normal Zone', 0x6: 'Home Mode Zone', 0x5: 'On',
            0x4: 'Home Mode', 0x3: 'Tamper', 0x2: 'Alarm', 0x1: 'Disarm', 0x0: 'Test',
        };
        ctx.emit({
            model: 'Chuango-Security',
            id: (b[0] << 12) | (b[1] << 4) | (b[2] >> 4),
            cmd: NAMES[cmd] ?? '?',
            cmd_id: cmd,
        });
        return 1;
    },
});
export const smokeGs558 = register({
    num: 86,
    name: 'Wireless smoke and heat detector GS 558',
    what: 'smoke and heat alarm',
    modulation: 6,
    shortWidth: 436,
    longWidth: 1202,
    gapLimit: 1949,
    resetLimit: 14117,
    disabled: true,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 3)
            return DECODE_ABORT_EARLY;
        bits.invert();
        let learn = 0;
        for (let r = 0; r < bits.numRows; r++) {
            const b = bits.bb[r];
            if (bits.bitsPerRow[r] >= 24 && b[0] === 0x55 && b[1] === 0x55 && b[2] === 0x55) {
                learn++;
                bits.bitsPerRow[r] = 0;
            }
            if ((bits.bitsPerRow[r] === 26 || bits.bitsPerRow[r] === 27) && b[3] === 0)
                bits.bitsPerRow[r] = 24;
        }
        const r = bits.findRepeatedRow(3, 24);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[r] > 32)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        for (let i = 0; i < 3; i++)
            b[i] = reverse8(b[i]);
        const id = ((b[2] & 0x0f) << 11) | (b[1] << 3) | (b[0] >> 5);
        if (id === 0 || id === 0x7fff)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Smoke-GS558',
            id,
            unit: b[0] & 0x1f,
            learn: learn > 1 ? 1 : 0,
            code: hex(b[2], 2) + hex(b[1], 2) + hex(b[0], 2),
        });
        return 1;
    },
});
