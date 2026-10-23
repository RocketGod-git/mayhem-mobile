import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, crc16, parityBytes, reverse8 } from '../util.js';
const hex = (v, digits) => (v >>> 0).toString(16).padStart(digits, '0');
const BAND_433 = [433920000];
const KERUI_STATE = {
    0xa: 'motion', 0xe: 'open', 0x7: 'close', 0xb: 'tamper', 0x5: 'water', 0xf: 'battery',
};
export const kerui = register({
    num: 68,
    name: 'Kerui PIR / Contact Sensor',
    what: 'alarm motion, door contact and water leak sensors',
    modulation: 6,
    shortWidth: 420,
    longWidth: 960,
    gapLimit: 1100,
    resetLimit: 9900,
    tolerance: 160,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(9, 25);
        if (row < 0)
            return DECODE_ABORT_LENGTH;
        if (bits.bitsPerRow[row] !== 25)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (!b[0] && !b[1] && !b[2])
            return DECODE_FAIL_SANITY;
        b[0] = ~b[0];
        b[1] = ~b[1];
        b[2] = ~b[2];
        const id = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
        const cmd = b[2] & 0x0f;
        const state = KERUI_STATE[cmd];
        if (!state)
            return DECODE_ABORT_EARLY;
        const data = { model: 'Kerui-Security', type: 'Security', id, cmd, state };
        if (cmd === 0xa)
            data.motion = 1;
        if (cmd === 0xe)
            data.opened = 1;
        if (cmd === 0x7)
            data.opened = 0;
        if (cmd === 0xb)
            data.tamper = 1;
        if (cmd === 0x5)
            data.water = 1;
        if (cmd === 0xf)
            data.battery_ok = 0;
        ctx.emit(data);
        return 1;
    },
});
export const genericMotion = register({
    num: 87,
    name: 'Generic wireless motion sensor',
    what: 'alarm motion sensor and panel',
    modulation: 6,
    shortWidth: 888,
    longWidth: (1332 + 1784) / 2,
    syncWidth: 1784 + 670,
    gapLimit: 1200,
    resetLimit: 2724 * 1.5,
    bands: [433300000],
    decode(_dev, bits, ctx) {
        for (let i = 0; i < bits.numRows; i++) {
            const b = bits.bb[i];
            if (bits.bitsPerRow[i] !== 20
                || (b[1] === 0 && b[2] === 0)
                || (b[1] === 0xff && b[2] === 0xf0)
                || bits.countRepeats(i, 0) < 3)
                continue;
            ctx.emit({
                model: 'Generic-Motion',
                type: 'Security',
                code: hex((b[0] << 12) | (b[1] << 4) | (b[2] >> 4), 5),
            });
            return 1;
        }
        return DECODE_ABORT_EARLY;
    },
});
const X10_SEC_EVENT = {
    0x00: 'DOOR/WINDOW OPEN', 0x04: 'DOOR/WINDOW OPEN', 0x40: 'DOOR/WINDOW OPEN', 0x44: 'DOOR/WINDOW OPEN',
    0x80: 'DOOR/WINDOW CLOSED', 0x84: 'DOOR/WINDOW CLOSED', 0xc0: 'DOOR/WINDOW CLOSED', 0xc4: 'DOOR/WINDOW CLOSED',
    0x0c: 'MOTION TRIPPED', 0x4c: 'MOTION TRIPPED',
    0x8c: 'MOTION READY', 0xcc: 'MOTION READY',
    0x06: 'KEY-FOB ARM',
    0x26: 'KR18 PANIC',
    0x42: 'KEY-FOB LIGHTS A ON',
    0x46: 'KEY-FOB LIGHTS B ON',
    0x82: 'SH624 SEC-REMOTE DISARM',
    0x86: 'KEY-FOB DISARM',
    0x88: 'KR15 PANIC',
    0x98: 'KR15 PANIC-3SECOND',
    0xc2: 'KEY-FOB LIGHTS A OFF',
    0xc6: 'KEY-FOB LIGHTS B OFF',
};
const X10_SEC_TAMPER_CODES = new Set([0x00, 0x04, 0x40, 0x44, 0x80, 0x84, 0xc0, 0xc4, 0x0c, 0x4c, 0x8c, 0xcc]);
const X10_SEC_DELAY_CODES = new Set([0x00, 0x04, 0x40, 0x44, 0x80, 0x84, 0xc0, 0xc4]);
export const x10Sec = register({
    num: 99,
    name: 'X10 Security',
    what: 'alarm door and window contacts, motion sensors and keyfobs',
    modulation: 5,
    shortWidth: 562,
    longWidth: 1687,
    gapLimit: 2200,
    resetLimit: 6000,
    bands: [310558000, 433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 2)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[1] < 41)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[1];
        if ((b[0] ^ b[1]) !== 0x0f || (b[2] ^ b[3]) !== 0xff)
            return DECODE_FAIL_SANITY;
        let parity = b[0] ^ b[1] ^ b[2] ^ b[3] ^ b[4] ^ (b[5] & 0x80);
        parity = (parity >> 4) ^ (parity & 0x0f);
        parity = (parity >> 2) ^ (parity & 0x03);
        parity = (parity >> 1) ^ (parity & 0x01);
        if (parity)
            return DECODE_FAIL_MIC;
        const code = b[2] & 0xfe;
        const batteryLow = b[2] & 0x01;
        const tamper = X10_SEC_TAMPER_CODES.has(code) ? (b[2] & 0x40) >> 6 : 0;
        const delay = X10_SEC_DELAY_CODES.has(code) ? (b[2] & 0x04 ? 0 : 1) : 0;
        const data = {
            model: 'X10-Security',
            type: 'Security',
            id: hex(b[0], 2) + hex(b[4], 2),
            code: hex(b[2], 2),
            event: X10_SEC_EVENT[code] ?? 'UNKNOWN',
            mic: 'CRC',
        };
        if (delay)
            data.delay = delay;
        if (batteryLow)
            data.battery_ok = 0;
        if (tamper)
            data.tamper = tamper;
        ctx.emit(data);
        return 1;
    },
});
function ssGetId(b) {
    let id = '';
    for (let k = 3; k <= 7; k++) {
        const c = reverse8(b[k]);
        id += (c < 32 || c > 126) ? '?' : String.fromCharCode(c);
    }
    return id;
}
const SS_SENSOR_STATE = {
    1: 'Contact Open', 2: 'Contact Closed', 3: 'Alarm Off',
};
const SS_KEYPAD_COMMAND = {
    0x6a: 'Arm System - Away',
    0xca: 'Arm System - Home',
    0x3a: 'Arm System - Canceled',
    0x2a: 'Keypad Panic Button',
    0x86: 'Keypad Menu Button',
};
function ssSensorParser(bits, ctx, row) {
    if (bits.bitsPerRow[row] !== 92)
        return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];
    const seq = reverse8(b[8]);
    const state = reverse8(b[9]);
    const csum = reverse8(b[10]);
    if (((seq + state) & 0xff) !== csum)
        return DECODE_FAIL_MIC;
    ctx.emit({
        model: 'SimpliSafe-Sensor',
        type: 'Security',
        id: ssGetId(b),
        seq,
        state,
        extradata: SS_SENSOR_STATE[state] ?? '',
        mic: 'CHECKSUM',
    });
    return 1;
}
function ssPinentryParser(bits, ctx, row) {
    const b = bits.bb[row];
    const pina = reverse8(b[10]);
    const pinb = reverse8(b[11]);
    const digits = [pina & 0x0f, (pina & 0xf0) >> 4, pinb & 0x0f, (pinb & 0xf0) >> 4];
    ctx.emit({
        model: 'SimpliSafe-Keypad',
        type: 'Security',
        id: ssGetId(b),
        seq: b[9],
        extradata: `Disarm Pin: ${digits.map(d => d.toString(16)).join('')}`,
    });
    return 1;
}
function ssKeypadCommands(bits, ctx, row) {
    const b = bits.bb[row];
    ctx.emit({
        model: 'SimpliSafe-Keypad',
        type: 'Security',
        id: ssGetId(b),
        seq: b[9],
        extradata: SS_KEYPAD_COMMAND[b[10]] ?? `Unknown Keypad: ${hex(b[10], 2)}`,
    });
    return 1;
}
export const ssSensor = register({
    num: 102,
    name: 'SimpliSafe Home Security System (May require disabling automatic gain for KeyPad decodes)',
    what: 'alarm sensors and keypad, first generation',
    modulation: 11,
    shortWidth: 500,
    longWidth: 1000,
    resetLimit: 2200,
    tolerance: 100,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 90);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[row];
        if (b[0] !== 0xcc || b[1] !== 0x5f)
            return DECODE_ABORT_EARLY;
        bits.invert();
        if (b[2] === 0x88)
            return ssSensorParser(bits, ctx, row);
        if (b[2] === 0x66)
            return ssPinentryParser(bits, ctx, row);
        if (b[2] === 0x44)
            return ssKeypadCommands(bits, ctx, row);
        return DECODE_ABORT_EARLY;
    },
});
const HONEYWELL_WDB_CLASS = {
    0x1: 'PIR-Motion', 0x2: 'Doorbell', 0x5: 'Contact',
};
const HONEYWELL_WDB_ALERT = {
    0x0: 'Normal', 0x1: 'High', 0x2: 'High', 0x3: 'Full',
};
function honeywellWdbDecode(bits, ctx) {
    const row = bits.findRepeatedRow(4, 48);
    if (row < 0)
        return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 48)
        return DECODE_ABORT_LENGTH;
    bits.invert();
    const b = bits.bb[row];
    const parity = parityBytes(b, 6);
    if ((!b[0] && !b[2] && !b[4] && !b[5])
        || (b[0] === 0xff && b[2] === 0xff && b[4] === 0xff && b[5] === 0xff))
        return DECODE_FAIL_SANITY;
    if (parity)
        return DECODE_FAIL_MIC;
    const type = (b[3] & 0x70) >> 4;
    let secretKnock = (b[5] & 0x10) >> 4;
    let tampered = secretKnock;
    if (type === 0x5)
        secretKnock = 0;
    else
        tampered = 0;
    const opened = (b[5] & 0x20) >> 5;
    const closed = (b[5] & 0x40) >> 6;
    const open = (opened && !closed) ? 1 : (!opened && closed) ? 0 : -1;
    ctx.emit({
        model: 'Honeywell-ActivLink',
        type: 'Security',
        subtype: HONEYWELL_WDB_CLASS[type] ?? 'Unknown',
        id: (b[0] << 12) | (b[1] << 4) | (b[2] >> 4),
        battery_ok: ((b[5] & 0x02) >> 1) ? 0 : 1,
        alert: HONEYWELL_WDB_ALERT[b[4] & 0x03] ?? 'Unknown',
        secret_knock: secretKnock,
        open,
        tampered,
        relay: (b[5] & 0x08) >> 3,
        mic: 'PARITY',
    });
    return 1;
}
export const honeywellWdb = register({
    num: 115,
    name: 'Honeywell ActivLink, Wireless Doorbell',
    what: 'wireless doorbell, PIR motion sensor and door contact',
    modulation: 6,
    shortWidth: 175,
    longWidth: 340,
    gapLimit: 0,
    resetLimit: 5000,
    syncWidth: 500,
    bands: BAND_433,
    decode: (_d, bits, ctx) => honeywellWdbDecode(bits, ctx),
});
export const honeywellWdbFsk = register({
    num: 116,
    name: 'Honeywell ActivLink, Wireless Doorbell (FSK)',
    what: 'wireless doorbell, PIR motion sensor and door contact',
    modulation: 17,
    shortWidth: 160,
    longWidth: 320,
    gapLimit: 0,
    resetLimit: 560,
    syncWidth: 500,
    bands: BAND_433,
    decode: (_d, bits, ctx) => honeywellWdbDecode(bits, ctx),
});
const bcd2int = (bcd) => 10 * (bcd >> 4) + (bcd & 0x0f);
export const abmt = register({
    num: 181,
    name: 'Amazon Basics Meat Thermometer',
    what: 'cooking thermometer',
    modulation: 4,
    shortWidth: 550,
    longWidth: 550,
    gapLimit: 2000,
    resetLimit: 5000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(4, 90);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 120)
            return DECODE_ABORT_LENGTH;
        const sync = new Uint8Array([0x55, 0xaa, 0xaa]);
        const at = bits.search(row, 0, sync, 24);
        if (at === bits.bitsPerRow[row] || at < 72)
            return DECODE_FAIL_SANITY;
        const packet = new BitBuffer();
        bits.manchesterDecode(row, at - 72, packet, 48);
        packet.invert();
        const b = packet.bb[0];
        ctx.emit({
            model: 'Basics-Meat',
            id: b[0],
            temperature_C: bcd2int(b[3]) * 10 + bcd2int(b[4] >> 4),
        });
        return 1;
    },
});
const SS3_PREAMBLE = new Uint8Array([0x93, 0x0b, 0x51, 0xde]);
const SS3_LENGTHS = new Set([0x15, 0x16, 0x18]);
export const simplisafeGen3 = register({
    num: 209,
    name: 'SimpliSafe Gen 3 Home Security System',
    what: 'alarm sensors, keypad and panel, third generation',
    modulation: 16,
    shortWidth: 208,
    longWidth: 208,
    resetLimit: 7000,
    bands: [433900000],
    decode(_dev, bits, ctx) {
        const bitpos = bits.search(0, 0, SS3_PREAMBLE, 32) + 32;
        if (bitpos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (bitpos + 24 * 8 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, bitpos, 27 * 8);
        if (!SS3_LENGTHS.has(b[0]))
            return DECODE_ABORT_EARLY;
        const len = b[0];
        if (crc16(b, len + 3, 0x8005, 0xffff) !== 0)
            return DECODE_FAIL_MIC;
        let encr = '';
        for (let i = 0; i < len - 12; i++)
            encr += hex(b[13 + i], 2);
        ctx.emit({
            model: 'SimpliSafe-Gen3',
            type: 'Security',
            id: hex(((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, 8),
            msg_type: hex(b[1], 2),
            ctr: hex((b[8] << 16) | (b[7] << 8) | b[6], 6),
            cmac: hex(((b[9] << 24) | (b[10] << 16) | (b[11] << 8) | b[12]) >>> 0, 8),
            encr,
            mic: 'CRC',
        });
        return 1;
    },
});
const CTT_SYNC = new Uint8Array([0xd3, 0x91]);
const CTT_MOTUS_CODE = new Set([
    0x00, 0x07, 0x19, 0x1e, 0x2a, 0x2d, 0x33, 0x34,
    0x4b, 0x4c, 0x52, 0x55, 0x61, 0x66, 0x78, 0x7f,
    0x80, 0x87, 0x99, 0x9e, 0xaa, 0xad, 0xb3, 0xb4,
    0xcb, 0xcc, 0xd2, 0xd5, 0xe1, 0xe6, 0xf8, 0xff,
]);
export const cttLifePowerHybrid = register({
    num: 320,
    name: 'Cellular Tracking Technologies LifeTag/PowerTag/HybridTag',
    what: 'wildlife tracking tag',
    modulation: 16,
    shortWidth: 40,
    longWidth: 40,
    resetLimit: 500,
    bands: [434000000],
    decode(_dev, bits, ctx) {
        let events = 0;
        let sawBadCrc = false;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] < 56)
                continue;
            const at = bits.search(row, 0, CTT_SYNC, 16);
            if (at >= bits.bitsPerRow[row])
                continue;
            if (at + 16 + 40 > bits.bitsPerRow[row])
                continue;
            const p = bits.bytes(row, at + 16, 40);
            if (crc8(p, 4, 0x07, 0x00) !== p[4]) {
                sawBadCrc = true;
                continue;
            }
            ctx.emit({
                model: 'CTT-Tag',
                id: ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0,
                valid_motus: (CTT_MOTUS_CODE.has(p[0]) && CTT_MOTUS_CODE.has(p[1])
                    && CTT_MOTUS_CODE.has(p[2]) && CTT_MOTUS_CODE.has(p[3])) ? 1 : 0,
                mic: 'CRC',
            });
            events++;
        }
        return events > 0 ? events : sawBadCrc ? DECODE_FAIL_MIC : 0;
    },
});
