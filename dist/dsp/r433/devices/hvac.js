import { BitBuffer, bitAt } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, addNibbles, crc8, crc16, crc16lsb, reflectBytes, xorBytes } from '../util.js';
const round1 = (x) => Math.round(x * 10) / 10;
const hexLow = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
export const wattsThermostat = register({
    num: 253,
    name: 'Watts WFHT-RF Thermostat',
    what: 'room thermostat',
    modulation: 6,
    shortWidth: 260,
    longWidth: 600,
    syncWidth: 6000,
    resetLimit: 900,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        bits.invert();
        if (bits.bitsPerRow[0] !== 54)
            return DECODE_ABORT_LENGTH;
        if (bits.bytes(0, 0, 8)[0] !== 0xa5)
            return DECODE_ABORT_EARLY;
        const idRaw = bits.bytes(0, 8, 16);
        reflectBytes(idRaw, 2);
        const id = (idRaw[1] << 8) | idRaw[0];
        const flags = bits.bytes(0, 24, 4);
        reflectBytes(flags, 1);
        const tempRaw = bits.bytes(0, 28, 9);
        reflectBytes(tempRaw, 2);
        const temp = (tempRaw[1] << 8) | tempRaw[0];
        const setpRaw = bits.bytes(0, 37, 9);
        reflectBytes(setpRaw, 2);
        const setp = (setpRaw[1] << 8) | setpRaw[0];
        const chk = bits.bytes(0, 46, 8);
        reflectBytes(chk, 1);
        const sum = (addBytes(idRaw, 2) + addBytes(flags, 1) + addBytes(tempRaw, 2) + addBytes(setpRaw, 2)) & 0xff;
        if (chk[0] !== sum)
            return DECODE_FAIL_MIC;
        if (id === 0 && flags[0] === 0 && temp === 0 && setp === 0 && chk[0] === 0)
            return DECODE_ABORT_EARLY;
        ctx.emit({
            model: 'Watts-WFHTRF',
            type: 'thermostat',
            id: String(id),
            pairing: flags[0] & 1,
            temperature_C: round1(temp * 0.1),
            setpoint_C: round1(setp * 0.1),
            flags: flags[0],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const wattsWfhtRf = register({
    num: 348,
    name: 'Watts WFHT-RF / WFHC-MASTERH&C-RF underfloor heating thermostat',
    what: 'underfloor heating thermostat',
    modulation: 3,
    shortWidth: 460,
    longWidth: 0,
    resetLimit: 900,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 32 + 128)
            return DECODE_ABORT_LENGTH;
        const sync = new Uint8Array([0xd3, 0x91, 0xd3, 0x91]);
        const offset = bits.search(0, 0, sync, 32) + 32;
        if (offset + 128 > bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, offset, 128);
        if (b[0] !== 0x0d)
            return DECODE_ABORT_EARLY;
        if (b[1] !== 0xff || b[2] !== 0xff || b[3] !== 0xfe)
            return DECODE_ABORT_EARLY;
        if (b[4] & 0xfc)
            return DECODE_FAIL_SANITY;
        if (!b[5] && !b[6] && !b[7])
            return DECODE_FAIL_SANITY;
        if (((crc8(b, 12, 0xe6, 0x00) ^ 0xbe ^ b[12]) & 0xff) !== b[13])
            return DECODE_FAIL_MIC;
        if (crc16(b, 14, 0x8005, 0xffff) !== (((b[14] << 8) | b[15]) & 0xffff))
            return DECODE_FAIL_MIC;
        const signed16 = (v) => (v & 0x8000) ? v - 0x10000 : v;
        ctx.emit({
            model: 'Watts-WFHTLCDRF',
            type: 'thermostat',
            id: `${hexLow(b[5], 2)}:${hexLow(b[6], 2)}:${hexLow(b[7], 2)}`.toUpperCase(),
            mode: (b[4] & 0x02) ? 'heat' : 'cool',
            pairing: (b[4] & 0x01) ? 'true' : 'false',
            temperature_C: round1(signed16((b[8] << 8) | b[9]) / 10),
            setpoint_C: round1(signed16((b[10] << 8) | b[11]) / 10),
            call_for_heat: b[12] === 0x64 ? 100 : 0,
            mic: 'CRC',
        });
        return 1;
    },
});
const VISION_SETPOINT_MODE = {
    0x00: 'Comfort', 0x01: 'Off', 0x02: 'Anti-freeze', 0x03: 'Reduced/ECO', 0x04: 'Boost/Timer',
    0x08: 'Auto (Comfort phase)', 0x0b: 'Auto (Reduced phase)', 0x10: 'Manual/Temporary',
};
const VISION_SENSOR_MODE = ['Amb', 'FLR', 'FLL', 'Air'];
const VISION_TEMP_UNAVAILABLE = 0x084c;
export const wattsVision = register({
    num: 366,
    name: 'Watts Vision thermostat (-f 868.3M)',
    what: 'thermostat and heating zone controller',
    modulation: 16,
    shortWidth: 26,
    longWidth: 26,
    resetLimit: 1000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const pre = new Uint8Array([0xaa, 0xd3, 0x91, 0xd3, 0x91]);
        const rowLen = bits.bitsPerRow[0];
        let bitpos = bits.search(0, 0, pre, 40);
        if (bitpos >= rowLen)
            return DECODE_ABORT_EARLY;
        bitpos += 40;
        if (bitpos + 8 > rowLen)
            return DECODE_ABORT_LENGTH;
        const length = bits.bytes(0, bitpos, 8)[0];
        if (length !== 0x14 && length !== 0x22)
            return DECODE_ABORT_EARLY;
        const totalBits = (length + 3) * 8;
        if (bitpos + totalBits > rowLen)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, bitpos, totalBits);
        if (crc16lsb(b, length - 2, 0xa001, 0xffff, 1) !== (((b[length] << 8) | b[length - 1]) & 0xffff)) {
            return DECODE_FAIL_MIC;
        }
        if (crc16(b, length + 1, 0x8005, 0xffff) !== (((b[length + 1] << 8) | b[length + 2]) & 0xffff)) {
            return DECODE_FAIL_MIC;
        }
        if (b[5] !== 0xc6)
            return DECODE_FAIL_SANITY;
        const addr = (at) => hexLow((((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0), 8);
        const data = {
            model: 'Watts-Vision',
            type: 'thermostat',
            id: addr(1),
            dest: addr(6),
            msg_type: length === 0x14 ? 'command' : 'status',
        };
        const recordsLen = length - 11;
        let pos = 0;
        while (pos < recordsLen) {
            const tag = b[10 + pos];
            if (tag === 0x00)
                break;
            const valueLen = (tag >> 6) + 1;
            if (pos + 1 + valueLen > recordsLen)
                break;
            const v = b.subarray(10 + pos + 1);
            const be16 = (at) => (v[at] << 8) | v[at + 1];
            switch (tag) {
                case 0x03:
                    data.association_id = v[0];
                    break;
                case 0xdf:
                    data.state_raw = hexLow(v[0], 2) + hexLow(v[1], 2) + hexLow(v[2], 2) + hexLow(v[3], 2);
                    break;
                case 0x3b:
                    data.flags_raw = v[0];
                    break;
                case 0x8d:
                    data.report_flags_0 = v[0];
                    data.report_flags_1 = v[1];
                    data.report_flags_2 = v[2];
                    break;
                case 0x8a:
                    if (be16(0) !== VISION_TEMP_UNAVAILABLE)
                        data.mode_setpoint_F = round1(be16(0) / 10);
                    data.setpoint_mode = VISION_SETPOINT_MODE[v[2]] ?? 'unknown';
                    break;
                case 0x4b:
                    if (be16(0) !== VISION_TEMP_UNAVAILABLE)
                        data.temperature_F = round1(be16(0) / 10);
                    break;
                case 0x5e:
                    if (be16(0) !== VISION_TEMP_UNAVAILABLE)
                        data.temperature_2_F = round1(be16(0) / 10);
                    break;
                case 0xcc:
                    if (be16(0) !== 0)
                        data.floor_limit_1_F = round1(be16(0) / 10);
                    if (be16(2) !== 0)
                        data.floor_limit_2_F = round1(be16(2) / 10);
                    break;
                case 0x8e:
                    data.setpoint_min_C = v[0];
                    data.setpoint_max_C = v[1];
                    data.sensor_mode = VISION_SENSOR_MODE[v[2] & 3];
                    data.sensor_flags_raw = v[2];
                    break;
                case 0x4c:
                    data.diagnostic_code = v[0];
                    data.diagnostic_flags = v[1];
                    break;
                default: break;
            }
            pos += 1 + valueLen;
        }
        data.mic = 'CRC';
        ctx.emit(data);
        return 1;
    },
});
const EBERLE_ACTIONS = [
    ['Learn', 0x3, 0xc], ['Reset', 0xb, 0x4], ['On', 0xe, 0x1], ['Off', 0x5, 0xa],
];
export const eberleInstat868r1 = register({
    num: 358,
    name: 'Eberle Instat 868r1 floor heating thermostat remote',
    what: 'floor heating remote control',
    modulation: 16,
    shortWidth: 400,
    longWidth: 400,
    resetLimit: 8000,
    bands: [868300000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 30 + 50)
            return DECODE_ABORT_LENGTH;
        const pre = new Uint8Array([0x00, 0x0f, 0xe0, 0x30]);
        const rowLen = bits.bitsPerRow[0];
        const decoded = new BitBuffer();
        let searchStart = 0, micOk = false;
        while (searchStart + 30 + 50 <= rowLen) {
            const pos = bits.search(0, searchStart, pre, 30);
            if (pos + 30 + 50 > rowLen)
                break;
            bits.differentialManchesterDecode(0, pos + 30, decoded, 25);
            if (decoded.bitsPerRow[0] < 25) {
                searchStart = pos + 30 + 1;
                continue;
            }
            let checksum = 0;
            const b = decoded.bb[0];
            for (let n = 0; n < 6; n++) {
                for (let i = 0; i < 4; i++)
                    if (bitAt(b, 1 + n * 4 + i))
                        checksum += 1 << i;
            }
            if ((checksum & 0xf) !== 0xb) {
                searchStart = pos + 30 + 1;
                continue;
            }
            micOk = true;
            break;
        }
        if (!micOk)
            return DECODE_FAIL_MIC;
        const b = decoded.bb[0];
        const gray = new Uint8Array(24);
        let prev = bitAt(b, 1);
        gray[0] = prev ? 0 : 1;
        for (let i = 1; i < 24; i++) {
            prev ^= bitAt(b, 1 + i);
            gray[i] = prev ? 0 : 1;
        }
        const nib = new Uint8Array(6);
        for (let n = 0; n < 6; n++) {
            let val = 0;
            for (let i = 0; i < 4; i++)
                val = (val << 1) | gray[n * 4 + i];
            nib[n] = val;
        }
        const id = (nib[0] << 8) | (nib[1] << 4) | nib[2];
        const action = nib[3];
        let command = 'Unknown';
        for (const [name, odd, even] of EBERLE_ACTIONS) {
            if (action === ((id & 1) ? odd : even)) {
                command = name;
                break;
            }
        }
        ctx.emit({
            model: 'Eberle-Instat868r1',
            type: 'remote',
            id: hexLow(id, 3),
            command,
            action_code: hexLow(action, 1),
            data: hexLow(nib[4], 1),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const REGENCY_COMMANDS = {
    1: 'fan_speed', 2: 'fan_speed', 4: 'light_intensity', 5: 'light_delay', 6: 'fan_direction',
};
export const regencyFan = register({
    num: 211,
    name: 'Regency Ceiling Fan Remote (-f 303.75M to 303.96M)',
    what: 'ceiling fan remote control',
    modulation: 6,
    shortWidth: 580,
    longWidth: 976,
    gapLimit: 8000,
    resetLimit: 14000,
    bands: [303900000],
    decode(_dev, bits, ctx) {
        bits.invert();
        const row = bits.findRepeatedRow(4, 21);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 21)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(row, 1, 20);
        reflectBytes(b, 3);
        if ((addNibbles(b, 2) & 0x0f) !== b[2])
            return DECODE_FAIL_MIC;
        const command = b[0] >> 4;
        const value = b[1];
        let valueString;
        switch (command) {
            case 1:
                valueString = 'stop';
                break;
            case 2:
                if (value < 0x01 || value > 0x07)
                    return DECODE_FAIL_SANITY;
                valueString = `speed ${value}`;
                break;
            case 4:
                if (value > 0xc3)
                    return DECODE_FAIL_SANITY;
                valueString = `${value} %`;
                break;
            case 5:
                if (value !== 0x00 && value !== 0x01)
                    return DECODE_FAIL_SANITY;
                valueString = value === 0 ? 'off' : 'on';
                break;
            case 6:
                if (value !== 0x07 && value !== 0x83)
                    return DECODE_FAIL_SANITY;
                valueString = value === 0x07 ? 'clockwise' : 'counter-clockwise';
                break;
            default: return DECODE_FAIL_SANITY;
        }
        ctx.emit({
            model: 'Regency-Remote',
            type: 'remote',
            channel: ~b[0] & 0x0f,
            command: REGENCY_COMMANDS[command],
            value: valueString,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const UNIFAN_BUTTONS = {
    0x19: 'All Off', 0x17: 'Light On/Off', 0x1b: 'Forward', 0x0a: 'Fan', 0x0e: 'Reverse', 0x09: 'Fan Off',
    0x0f: 'Speed 1', 0x0d: 'Speed 2', 0x03: 'Speed 3', 0x15: 'Speed 4', 0x10: 'Speed 5', 0x13: 'speed 6',
    0x1d: '1H', 0x16: '2H', 0x06: '3H',
};
export const universalFanCtrl = register({
    num: 286,
    name: 'Universal (Reverseable) 24V Fan Controller',
    what: 'ceiling fan remote control',
    modulation: 6,
    shortWidth: 256,
    longWidth: 756,
    gapLimit: 8000,
    syncWidth: 3616,
    resetLimit: 8800,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(3, 33);
        if (row < 0)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (!(b[4] & 0x80))
            return DECODE_FAIL_SANITY;
        const x = xorBytes(b, 4);
        if ((((x >> 4) ^ (x & 0xf)) & 0xf) !== 0xa)
            return DECODE_FAIL_MIC;
        const address = (b[0] << 12) + (b[1] << 4) + (b[2] >> 4);
        const button = ((b[2] & 0x0f) << 1) + ((b[3] & 0x80) >> 7);
        ctx.emit({
            model: 'UniFan-24V',
            type: 'remote',
            id: String(address),
            button: UNIFAN_BUTTONS[button] ?? 'Unknown',
            button_code: button,
            counter: (b[3] & 0x7f) >> 4,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
const GOVEE_BANDS = [912000000, 915000000];
const GOVEE_SYNC = new Uint8Array([0x2c, 0x4c, 0x4a]);
const GOVEE_SYNC_SKEW1 = new Uint8Array([0x16, 0x26, 0x25]);
const GOVEE_KEY = 's6amyEvO8UslCY0eZjgc2S6APCVLgLxzFvL2Z5GWPW7fKVjy2oAU6uiKU3lZCHm62VYQQuCtgxzPgGd8UDRPVZpDRAsh5EdYq1E4j4morJ3vd6tWx8BiWOLDc2I8wKUK';
const GOVEE_MAX_FRAME = 128;
function goveeFindFrame(bits) {
    let row = -1, syncPos = 0;
    for (let r = 0; r < bits.numRows; r++) {
        if (bits.bitsPerRow[r] < 8 * 7)
            continue;
        const pos = bits.search(r, 0, GOVEE_SYNC, 24);
        if (pos < bits.bitsPerRow[r]) {
            row = r;
            syncPos = pos;
            break;
        }
        const skew = bits.search(r, 0, GOVEE_SYNC_SKEW1, 24);
        if (skew < bits.bitsPerRow[r]) {
            row = r;
            syncPos = skew + 1;
            break;
        }
    }
    if (row < 0)
        return DECODE_ABORT_EARLY;
    syncPos += 24;
    const bitsAfter = bits.bitsPerRow[row] - syncPos;
    if (bitsAfter < 32)
        return DECODE_ABORT_LENGTH;
    let n = bitsAfter >> 3;
    if (n > GOVEE_MAX_FRAME)
        n = GOVEE_MAX_FRAME;
    return { frame: bits.bytes(row, syncPos, n * 8), bytesAfterSync: n };
}
function goveeDecrypt(frame, encLen) {
    const crcRecv = ((frame[2 + encLen] << 8) | frame[3 + encLen]) & 0xffff;
    if (crc16(frame, encLen, 0x1021, 0x1d0f, 2) !== crcRecv)
        return null;
    const seed = frame[1];
    const dec = new Uint8Array(encLen);
    for (let i = 0; i < encLen; i++)
        dec[i] = frame[2 + i] ^ GOVEE_KEY.charCodeAt((i + seed) % 128);
    return dec;
}
function goveeIds(dec, at) {
    const wire = (((dec[at] << 24) | (dec[at + 1] << 16) | (dec[at + 2] << 8) | dec[at + 3]) >>> 0);
    const swapped = ((((wire & 0xffff) << 16) | ((wire >>> 16) & 0xffff)) >>> 0);
    return { id: hexLow(swapped, 8), id_wire: hexLow(wire, 8) };
}
export const goveeH5310 = register({
    num: 349,
    name: 'Govee Pool/Spa Thermometer H5310',
    what: 'pool and spa thermometer',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 2000,
    bands: GOVEE_BANDS,
    decode(_dev, bits, ctx) {
        const found = goveeFindFrame(bits);
        if (typeof found === 'number')
            return found;
        const { frame, bytesAfterSync } = found;
        const outerLen = frame[0];
        const isTemp = outerLen === 0x10, isPeriodic = outerLen === 0x3d, isStatus = outerLen === 0x1f;
        if (!isTemp && !isPeriodic && !isStatus)
            return DECODE_ABORT_EARLY;
        if (bytesAfterSync < 1 + outerLen)
            return DECODE_ABORT_LENGTH;
        const dec = goveeDecrypt(frame, outerLen - 3);
        if (!dec)
            return DECODE_FAIL_MIC;
        const marker = isTemp ? 0x11 : isPeriodic ? 0x1b : 0x71;
        if (dec[0] !== marker)
            return DECODE_ABORT_EARLY;
        const at = isTemp ? 6 : 5;
        if (isStatus && (dec[8] !== 0xcc || dec[9] !== 0xff))
            return DECODE_ABORT_EARLY;
        const batteryPct = dec[at];
        const raw = dec[at + 1] | (dec[at + 2] << 8);
        const temperatureC = (raw - 33168) / 10;
        if (temperatureC < -20 || temperatureC > 60)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Govee-H5310',
            type: 'thermometer',
            ...goveeIds(dec, 1),
            event: isTemp ? 'Temperature Update' : isPeriodic ? 'Periodic Update' : 'Status',
            battery_ok: batteryPct > 0 ? 1 : 0,
            battery_pct: batteryPct,
            temperature_C: round1(temperatureC),
            mic: 'CRC',
        });
        return 1;
    },
});
export const goveeH5112 = register({
    num: 350,
    name: 'Govee H5112 Dual-Probe Thermometer',
    what: 'dual probe thermometer and hygrometer',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 2000,
    bands: GOVEE_BANDS,
    priority: 5,
    decode(_dev, bits, ctx) {
        const found = goveeFindFrame(bits);
        if (typeof found === 'number')
            return found;
        const { frame, bytesAfterSync } = found;
        const outerLen = frame[0];
        if (outerLen < 4 || outerLen > GOVEE_MAX_FRAME - 1)
            return DECODE_FAIL_SANITY;
        if (bytesAfterSync < 1 + outerLen)
            return DECODE_ABORT_LENGTH;
        const encLen = outerLen - 3;
        if (encLen < 10 || encLen > GOVEE_MAX_FRAME)
            return DECODE_ABORT_EARLY;
        const dec = goveeDecrypt(frame, encLen);
        if (!dec)
            return DECODE_FAIL_MIC;
        const msgClass = dec[0];
        if (msgClass === 0x13) {
            if (encLen !== 57)
                return DECODE_ABORT_EARLY;
        }
        else if (msgClass === 0x71) {
            if (encLen !== 28)
                return DECODE_ABORT_EARLY;
        }
        else
            return DECODE_ABORT_EARLY;
        const unpack = (at) => {
            const packed = ((dec[at] | (dec[at + 1] << 8) | (dec[at + 2] << 16) | (dec[at + 3] << 24)) >>> 0);
            return {
                t1: (packed >>> 11) & 0x7ff,
                t2: packed & 0x7ff,
                h: (packed >>> 22) & 0x3ff,
            };
        };
        const live = unpack(6);
        const humidity = live.h / 10;
        if (humidity > 100)
            return DECODE_FAIL_SANITY;
        const data = {
            model: 'Govee-H5112',
            type: 'thermometer',
            ...goveeIds(dec, 1),
            battery_ok: dec[5] > 0 ? 1 : 0,
            battery_pct: dec[5],
            temperature_C: round1(live.t1 / 10 - 40),
            temperature_2_C: round1(live.t2 / 10 - 40),
            humidity: round1(humidity),
        };
        if (msgClass === 0x13 && encLen >= 17 + 40) {
            const t1 = [], t2 = [], hum = [];
            for (let i = 0; i < 10; i++) {
                const r = unpack(17 + i * 4);
                t1.push(round1(r.t1 / 10 - 40));
                t2.push(round1(r.t2 / 10 - 40));
                hum.push(round1(r.h / 10));
            }
            data.temperature_C_history = t1;
            data.temperature_2_C_history = t2;
            data.humidity_history = hum;
        }
        data.mic = 'CRC';
        ctx.emit(data);
        return 1;
    },
});
const GOVEE_H5059_SUBTYPES = { 0x05: 'Button Press', 0x06: 'Water Leak', 0x07: 'Post Alarm' };
export const goveeH5059 = register({
    num: 300,
    name: 'Govee Water Leak Detector H5059',
    what: 'water leak detector',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 2000,
    bands: GOVEE_BANDS,
    priority: 10,
    decode(_dev, bits, ctx) {
        const found = goveeFindFrame(bits);
        if (typeof found === 'number')
            return found;
        const { frame, bytesAfterSync } = found;
        const outerLen = frame[0];
        if (outerLen < 4 || outerLen > GOVEE_MAX_FRAME - 1)
            return DECODE_FAIL_SANITY;
        if (bytesAfterSync < 1 + outerLen)
            return DECODE_ABORT_LENGTH;
        const encLen = outerLen - 3;
        if (encLen < 8 || encLen > 64)
            return DECODE_FAIL_SANITY;
        const dec = goveeDecrypt(frame, encLen);
        if (!dec)
            return DECODE_FAIL_MIC;
        if (encLen < 19)
            return DECODE_FAIL_SANITY;
        const msgClass = dec[0];
        const subtype = dec[13], leakTop = dec[14], leakBottom = dec[15], leakAlarm = dec[17];
        let event;
        let wet = -1;
        if (msgClass === 0x11) {
            event = 'Telemetry';
            if (subtype === 0x05) {
                event = GOVEE_H5059_SUBTYPES[0x05];
                wet = 0;
            }
            else if (subtype === 0x06 && leakAlarm !== 0 && (leakTop === 1 || leakBottom === 1)) {
                event = GOVEE_H5059_SUBTYPES[0x06];
                wet = 1;
            }
            else if (subtype === 0x07)
                event = GOVEE_H5059_SUBTYPES[0x07];
        }
        else if (msgClass === 0x01)
            event = 'Pairing';
        else if (msgClass === 0x02)
            event = 'Class 0x02';
        else
            return DECODE_ABORT_EARLY;
        const data = {
            model: 'Govee-H5059',
            type: 'leak detector',
            ...goveeIds(dec, 1),
            event,
            msg_class: msgClass,
            subtype,
            mic: 'CRC',
        };
        if (wet >= 0)
            data.detect_wet = wet;
        if (wet === 1) {
            data.leak_top = leakTop === 1 ? 1 : 0;
            data.leak_bottom = leakBottom === 1 ? 1 : 0;
        }
        ctx.emit(data);
        return 1;
    },
});
