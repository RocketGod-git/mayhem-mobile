import { BitBuffer, bitAt } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, crc16, parity8, reflectNibbles, reverse8, xorBytes } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
function hexOf(m, n = m.length) {
    let s = '';
    for (let i = 0; i < n; i++)
        s += m[i].toString(16).padStart(2, '0');
    return s;
}
function copyRow(bits, row) {
    const out = new BitBuffer();
    const src = bits.bb[row];
    const n = bits.bitsPerRow[row];
    for (let i = 0; i < n; i++)
        out.addBit(bitAt(src, i));
    return out;
}
function bitrowGetByte(row, bitIdx) {
    const at = bitIdx >> 3;
    const sh = bitIdx & 7;
    return ((row[at] << sh) | (sh ? row[at + 1] >> (8 - sh) : 0)) & 0xff;
}
export const wgPb12v1 = register({
    num: 39,
    name: 'WG-PB12V1 Temperature Sensor',
    what: 'temperature probe',
    modulation: 6,
    shortWidth: 564,
    longWidth: 1476,
    resetLimit: 2500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 48)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if (b[0] !== 0xff)
            return DECODE_ABORT_EARLY;
        if ((b[1] & 0xf0) !== 0x30)
            return DECODE_ABORT_EARLY;
        if (b[5] !== crc8(b, 4, 0x31, 0, 1))
            return DECODE_FAIL_MIC;
        if (b[4] !== 0xff)
            return DECODE_FAIL_OTHER;
        const id = b[3] & 0x1f;
        const tempRaw = ((b[1] & 0x0f) << 8) | b[2];
        ctx.emit({
            model: 'WG-PB12V1',
            type: 'Weather',
            id,
            temperature_C: round1((tempRaw - 400) * 0.1),
            mic: 'CRC',
        });
        return 1;
    },
});
const IBIS_PREAMBLE = new Uint8Array([0xab]);
export const ibisBeacon = register({
    num: 80,
    name: 'IBIS beacon',
    what: 'public transport vehicle beacon',
    modulation: 3,
    shortWidth: 30,
    longWidth: 0,
    resetLimit: 100,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 232 || bits.bitsPerRow[0] > 250)
            return DECODE_ABORT_LENGTH;
        const pos = bits.search(0, 0, IBIS_PREAMBLE, 8);
        if (pos > 26)
            return DECODE_ABORT_EARLY;
        const start = pos + 8;
        if (bits.bitsPerRow[0] - start < 224)
            return DECODE_ABORT_LENGTH;
        const msg = bits.bytes(0, start, 224);
        if (((msg[26] << 8) | msg[27]) !== crc16(msg, 26, 0x8005, 0x0000))
            return DECODE_FAIL_MIC;
        const id = ((msg[5] & 0x0f) << 12) | (msg[6] << 4) | ((msg[7] & 0xf0) >> 4);
        const counter = msg[20] * 0x1000000 + (msg[21] << 16) + (msg[22] << 8) + msg[23];
        ctx.emit({
            model: 'IBIS-Beacon',
            type: 'Transit',
            id,
            counter,
            code: hexOf(msg, 28),
            mic: 'CRC',
        });
        return 1;
    },
});
export const opusXt300 = register({
    num: 121,
    name: 'Opus/Imagintronix XT300 Soil Moisture',
    what: 'soil moisture and temperature probe',
    modulation: 6,
    shortWidth: 544,
    longWidth: 932,
    gapLimit: 10000,
    resetLimit: 31000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        let ret = 0;
        let failCode = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 48) {
                failCode = DECODE_ABORT_LENGTH;
                continue;
            }
            const b = bits.bb[row];
            if (!b[0] && !b[1] && !b[2] && !b[3]) {
                failCode = DECODE_FAIL_SANITY;
                continue;
            }
            if (b[0] !== 0xff && ((b[1] | 0x1) & 0xfd) === 0x55) {
                failCode = DECODE_ABORT_EARLY;
                continue;
            }
            const chk = addBytes(b, 4, 1);
            if (chk !== 0 && chk !== b[5]) {
                failCode = DECODE_FAIL_MIC;
                continue;
            }
            const channel = b[1] & 0x03;
            const temp = b[3] - 40;
            const moisture = b[2];
            if (temp > 100 || moisture > 101) {
                failCode = DECODE_FAIL_SANITY;
                continue;
            }
            ctx.emit({
                model: 'Opus-XT300',
                type: 'Weather',
                channel,
                temperature_C: temp,
                moisture,
                mic: 'CHECKSUM',
            });
            ret++;
        }
        return ret > 0 ? ret : failCode;
    },
});
const ENOCEAN_PREAMBLE = new Uint8Array([0x55, 0x20]);
function decode8of12(b, pos, end, out) {
    if (pos + 12 > end)
        return DECODE_ABORT_LENGTH;
    out.addBit(bitAt(b, pos + 0));
    out.addBit(bitAt(b, pos + 1));
    const b2 = bitAt(b, pos + 2);
    out.addBit(b2);
    if (b2 !== (bitAt(b, pos + 3) ? 0 : 1))
        return DECODE_FAIL_SANITY;
    out.addBit(bitAt(b, pos + 4));
    out.addBit(bitAt(b, pos + 5));
    const b6 = bitAt(b, pos + 6);
    out.addBit(b6);
    if (b6 !== (bitAt(b, pos + 7) ? 0 : 1))
        return DECODE_FAIL_SANITY;
    out.addBit(bitAt(b, pos + 8));
    out.addBit(bitAt(b, pos + 9));
    return (bitAt(b, pos + 10) << 1) | bitAt(b, pos + 11);
}
export const enoceanErp1 = register({
    num: 198,
    name: 'EnOcean ERP1',
    what: 'building automation telegram',
    modulation: 4,
    shortWidth: 8,
    longWidth: 8,
    syncWidth: 0,
    tolerance: 1,
    resetLimit: 800,
    bands: [868300000],
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const row = copyRow(bits, 0);
        row.invert();
        const start = row.search(0, 0, ENOCEAN_PREAMBLE, 11);
        if (start >= row.bitsPerRow[0])
            return DECODE_FAIL_SANITY;
        let pos = start + 11;
        const end = start + (row.bitsPerRow[0] - start);
        const out = new BitBuffer();
        let more = 0x01;
        do {
            more = decode8of12(row.bb[0], pos, end, out) & 0xff;
            pos += 12;
        } while (pos < end && more === 0x01);
        if (out.bitsPerRow[0] < 16)
            return DECODE_ABORT_LENGTH;
        const nb = (out.bitsPerRow[0] - 1) >> 3;
        if (crc8(out.bb[0], nb, 0x07, 0x00) !== bitrowGetByte(out.bb[0], out.bitsPerRow[0] - 8)) {
            return DECODE_FAIL_MIC;
        }
        ctx.emit({
            model: 'EnOcean-ERP1',
            type: 'Automation',
            telegram: hexOf(out.bb[0], (out.bitsPerRow[0] + 7) >> 3),
            mic: 'CRC',
        });
        return 1;
    },
});
const CED7000_SYNC = new Uint8Array([0xaa, 0x4d, 0x5e]);
const CED7000_DATA_BITS = 169;
const CED7000_TOTAL_BITS = 201;
export const ced7000 = register({
    num: 233,
    name: 'CED7000 Shot Timer',
    what: 'shooting timer',
    modulation: 16,
    shortWidth: 1300,
    longWidth: 1300,
    gapLimit: 3500,
    resetLimit: 9000,
    disabled: true,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 6 * 16 + 3 * 8);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const bitpos = bits.search(row, 0, CED7000_SYNC, 24) + 24;
        if (bitpos >= bits.bitsPerRow[row])
            return DECODE_ABORT_EARLY;
        const inv = copyRow(bits, row);
        inv.invert();
        const decoded = new BitBuffer();
        const ret = inv.manchesterDecode(0, bitpos, decoded, CED7000_DATA_BITS);
        if (ret !== CED7000_TOTAL_BITS + 1)
            return DECODE_FAIL_MIC;
        const n = (ret / 8) | 0;
        const b = new Uint8Array(n);
        b.set(decoded.bb[0].subarray(0, n));
        reflectNibbles(b, n);
        const id = (b[1] & 0xf) * 1000 + (b[1] >> 4) * 100 + (b[0] & 0xf) * 10 + (b[0] >> 4);
        const count = (b[2] & 0xf) * 10 + (b[2] >> 4);
        const final = (b[5] >> 4) * 100 + (b[4] & 0xf) * 10 + (b[4] >> 4) + (b[3] & 0xf) * 0.1 + (b[3] >> 4) * 0.01;
        const split = (b[7] & 0xf) * 100 + (b[7] >> 4) * 10 + (b[6] & 0xf) + (b[6] >> 4) * 0.1 + (b[5] & 0xf) * 0.01;
        ctx.emit({
            model: 'CED7000',
            type: 'Timer',
            id: String(id).padStart(4, '0'),
            count,
            final: round2(final),
            split: round2(split),
        });
        return 1;
    },
});
const ROSSTECH_DATA = new Uint8Array([0xdd, 0x40]);
const ROSSTECH_BOND = new Uint8Array([0xcd, 0x00]);
function extractBytesUart8o1(m, offsetBits, numBits, dst) {
    let ret = 0, off = offsetBits, n = numBits;
    while (n >= 11) {
        const startb = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        let datab = m[off >> 3];
        if (off % 8)
            datab = ((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (8 - (off % 8));
        off += 8;
        const parityb = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        const stopb = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        if ((startb & 1) !== 1)
            break;
        if ((parityb & 1) !== parity8(datab & 0xff))
            break;
        if ((stopb & 1) !== 0)
            break;
        dst[ret++] = datab & 0xff;
        n -= 11;
        if (ret >= dst.length)
            break;
    }
    return ret;
}
export const rosstechDcu706 = register({
    num: 265,
    name: 'Rosstech Digital Control Unit DCU-706/Sundance/Jacuzzi',
    what: 'hot tub control panel',
    modulation: 4,
    shortWidth: 200,
    longWidth: 200,
    resetLimit: 2000,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 55 || bits.bitsPerRow[0] > 300)
            return DECODE_ABORT_EARLY;
        let startPos = bits.search(0, 0, ROSSTECH_DATA, 11);
        if (startPos === bits.bitsPerRow[0]) {
            startPos = bits.search(0, 0, ROSSTECH_BOND, 11);
            if (startPos === bits.bitsPerRow[0])
                return DECODE_ABORT_LENGTH;
        }
        if (startPos + 55 > bits.bitsPerRow[0])
            return DECODE_ABORT_LENGTH;
        const msg = bits.bytes(0, startPos, 56);
        const b = new Uint8Array(5);
        if (extractBytesUart8o1(msg, 0, 55, b) !== 5)
            return DECODE_ABORT_LENGTH;
        const msgType = b[0];
        const id = (b[1] << 8) | b[2];
        const tempF = b[3];
        if ((0xff ^ xorBytes(b, 4)) !== b[4])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Rosstech-Spa',
            type: 'Thermostat',
            id: id.toString(16).padStart(4, '0'),
            msg_type: msgType === 0xba ? 'Data' : 'Bond',
            temperature_F: tempF,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const RFM69_SYNC = new Uint8Array([0x2d]);
const RFM69_LENGTH_POS = 5;
const RFM69_DST_ID_POS = 6;
const RFM69_SRC_ID_POS = 7;
const RFM69_DATA_START_POS = 9;
const RFM69_HEADER_LENGTH = 6;
const RFM69_MAX_LENGTH = 65;
export const rfm69LowpowerlabMoteino = register({
    num: 318,
    name: 'RFM69 LowPowerLab Moteino board (-s 1000k)',
    what: 'hobby radio module',
    modulation: 16,
    shortWidth: 18,
    longWidth: 18,
    resetLimit: 400,
    decode(_dev, bits, ctx) {
        const posn = bits.search(0, 0, RFM69_SYNC, 8);
        if (posn < 24 || posn > 28)
            return DECODE_ABORT_EARLY;
        const message = new Uint8Array(RFM69_MAX_LENGTH + 9);
        bits.extractBytes(0, posn - 24, message, RFM69_MAX_LENGTH * 8);
        const payloadLen = message[RFM69_LENGTH_POS];
        if (payloadLen > RFM69_MAX_LENGTH)
            return DECODE_ABORT_LENGTH;
        const payload = new Uint8Array(RFM69_MAX_LENGTH + 2);
        bits.extractBytes(0, posn + 16, payload, (payloadLen + 1) * 8);
        const crc = ~crc16(payload, payloadLen + 1, 0x1021, 0x1d0f) & 0xffff;
        if (((crc >> 8) !== message[RFM69_HEADER_LENGTH + payloadLen])
            || ((crc & 0x00ff) !== message[RFM69_HEADER_LENGTH + payloadLen + 1])) {
            return DECODE_FAIL_MIC;
        }
        if (message[RFM69_SRC_ID_POS] !== 0x02)
            return DECODE_FAIL_OTHER;
        message[RFM69_HEADER_LENGTH + payloadLen] = 0x00;
        let msg = '';
        for (let i = 0; i < 30; i++) {
            const c = message[RFM69_DATA_START_POS + i];
            if (c === 0)
                break;
            msg += String.fromCharCode(c);
        }
        ctx.emit({
            model: 'Moteino-RFM69',
            type: 'Telemetry',
            id: message[RFM69_DST_ID_POS],
            gateway_id: message[RFM69_SRC_ID_POS],
            msg,
            mic: 'CRC',
        });
        return 1;
    },
});
const TR502_COMMANDS = ['OFF', 'BRIGHT', 'ON', 'DIM'];
const TR502_SOCKETS = ['1', '3', '2', '4', 'ALL'];
export const tr502msv = register({
    num: 332,
    name: 'TR-502MSV remote smart socket controller',
    what: 'mains socket remote',
    modulation: 6,
    shortWidth: 740,
    longWidth: 1400,
    tolerance: 70,
    resetLimit: 84000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] !== 21)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if ((b[0] & 0x80) === 0)
            return DECODE_ABORT_EARLY;
        if ((b[2] & 0x20) !== 0)
            return DECODE_FAIL_SANITY;
        const deviceId = ((b[0] & 0x7f) << 5) | (b[1] >> 3);
        const socketId = b[1] & 0x07;
        const onOff = (b[2] & 0x80) >> 7;
        const command = (b[2] & 0x40) >> 6;
        const chk1 = (b[2] & 0x10) >> 4;
        const chk0 = (b[2] & 0x08) >> 3;
        const s2 = (socketId >> 2) & 1;
        const s1 = (socketId >> 1) & 1;
        const s0 = socketId & 1;
        if (chk1 !== (command ^ s2 ^ s0) || chk0 !== (onOff ^ s1))
            return DECODE_FAIL_MIC;
        let socket;
        if (socketId % 2 === 0)
            socket = TR502_SOCKETS[socketId >> 1];
        else if (socketId === 0x7)
            socket = TR502_SOCKETS[4];
        else
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'TR-502MSV',
            type: 'Remote',
            id: deviceId,
            socket_id: socket,
            command: TR502_COMMANDS[(onOff << 1) | command],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const opelMokka = register({
    num: 333,
    name: 'Opel Mokka Car Key',
    what: 'car key fob',
    modulation: 18,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 1000,
    decode(_dev, bits, ctx) {
        let found = 0;
        for (let i = 0; i < bits.numRows; i++) {
            if (bits.bitsPerRow[i] !== 268)
                continue;
            const b = bits.bb[i];
            let leadIn = 0;
            for (let k = 0; k <= 10; k++)
                leadIn |= b[k];
            if (leadIn)
                continue;
            const idAt = (at) => {
                const t = bits.bytes(i, at, 11);
                return (t[0] << 3) | (t[1] >> 5);
            };
            const keyId = idAt(90);
            if (keyId !== idAt(90 + 12 * 8 + 1))
                continue;
            if (keyId === 0)
                continue;
            const eventType = ((b[12] & 0x07) << 2) | ((b[13] & 0xc0) >> 6);
            ctx.emit({
                model: 'Opel-Mokka',
                type: 'Remote',
                id: keyId,
                event: eventType,
                code: hexOf(bits.bytes(i, 90 + 17, 64), 8),
            });
            found++;
        }
        return found;
    },
});
export const florabest = register({
    num: 339,
    name: 'Florabest FB-TH-1 BBQ Thermometer',
    what: 'grill thermometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 6000,
    resetLimit: 11000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 30);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 30)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] !== 0x49)
            return DECODE_FAIL_SANITY;
        if (!b[0] && !b[1] && !b[2] && !b[3])
            return DECODE_ABORT_EARLY;
        let parity = 0;
        for (let i = 0; i < 30; i++)
            parity ^= bitAt(b, i);
        if (parity !== 1)
            return DECODE_FAIL_MIC;
        const id = (b[0] << 8) | b[1];
        const tempRaw = (b[2] << 5) | (b[3] >> 3);
        ctx.emit({
            model: 'Florabest-FBTH1',
            type: 'Weather',
            id: id.toString(16).padStart(4, '0'),
            temperature_F: round1(tempRaw * 0.1 - 90.0),
            mic: 'PARITY',
        });
        return 1;
    },
});
export const hanwellMl4000 = register({
    num: 371,
    name: 'Hanwell ML/RL4000-series Radiologger temperature/humidity sensor',
    what: 'laboratory temperature and humidity logger',
    modulation: 17,
    shortWidth: 1000,
    longWidth: 2000,
    syncWidth: 3000,
    resetLimit: 10000,
    bands: [434075000],
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.numRows < 1)
            return DECODE_ABORT_EARLY;
        const row = bits.numRows - 1;
        if (bits.bitsPerRow[row] !== 40)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(row, 0, 40);
        for (let i = 0; i < 5; i++)
            b[i] = reverse8(b[i] ^ 0xff);
        if (addBytes(b, 4) !== b[4])
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Hanwell-ML4000',
            type: 'Weather',
            id: b[0],
            temperature_raw: (b[2] << 4) | (b[3] & 0x0f),
            humidity_raw: (b[1] << 4) | (b[3] >> 4),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const MCPOWER_PREAMBLE = new Uint8Array([0xaa, 0xaa]);
export const mcpowerKinetic = register({
    num: 376,
    name: 'McPower Kinetic battery-less wall switch',
    what: 'kinetic wall switch',
    modulation: 16,
    shortWidth: 10,
    longWidth: 10,
    resetLimit: 300,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        let pos = bits.search(0, 0, MCPOWER_PREAMBLE, 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        pos += 16;
        if (bits.bitsPerRow[0] - pos < 48)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, pos, 48);
        if (crc16(b, 4, 0x1021, 0xaa55) !== ((b[4] << 8) | b[5]))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'McPower-Kinetic',
            type: 'Remote',
            id: ((b[0] << 8) | b[1]).toString(16).padStart(4, '0'),
            button_left: (b[2] >> 6) & 1,
            button_right: (b[2] >> 5) & 1,
            counter: b[2] & 0xf,
            flags: b[3].toString(16).padStart(2, '0'),
            mic: 'CRC',
        });
        return 1;
    },
});
