import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc16, reverse8 } from '../util.js';
const BAND_868 = [868000000];
const BAND_868_95 = [868950000];
const BAND_915 = [915000000];
const bitrowGetByte = (row, pos) => (((row[pos >> 3] << 8) | row[(pos >> 3) + 1]) >> (8 - (pos & 7))) & 0xff;
const bitrowGetBit = (row, pos) => (row[pos >> 3] >> (7 - (pos & 7))) & 1;
const hexOf = (b, from, n) => {
    let s = '';
    for (let i = 0; i < n; i++)
        s += b[from + i].toString(16).padStart(2, '0');
    return s;
};
function ccittWhitening(m, n = m.length) {
    let msb = 0x01, lsb = 0xff;
    for (let i = 0; i < n; i++) {
        m[i] ^= reverse8(lsb);
        for (let r = 0; r < 8; r++) {
            const prev = msb;
            msb = (lsb & 0x01) ^ ((lsb >> 5) & 0x01);
            lsb = (((prev << 7) & 0x80) | ((lsb >> 1) & 0xff)) & 0xff;
        }
    }
}
const INSTEON_MSG_TYPE = [
    'Direct Message',
    'ACK of Direct Message',
    'Group Cleanup Direct Message',
    'ACK of Group Cleanup Direct Message',
    'Broadcast Message',
    'NAK of Direct Message',
    'Group Broadcast Message',
    'NAK of Group Cleanup Direct Message',
];
function insteonCrc(d) {
    let r = 0;
    for (let i = 0; i < 9; i++) {
        r ^= d[i];
        r = (r ^ ((((r ^ ((r << 1) & 0xff)) & 0x0f) << 4))) & 0xff;
    }
    return r;
}
function insteonExtCrc(d) {
    let r = 0;
    for (let i = 7; i < 22; i++)
        r = (r + d[i]) & 0xff;
    return ((~r) + 1) & 0xff;
}
function insteonPacket(bits, row, startPos, ctx) {
    const results = new Uint8Array(35);
    let resultsLen = 0;
    let pos = startPos + 7;
    const idxBuf = new BitBuffer();
    const datBuf = new BitBuffer();
    let next = bits.manchesterDecode(row, pos, idxBuf, 5);
    const firstIndex = reverse8(idxBuf.bb[0][0]);
    next = bits.manchesterDecode(row, next, datBuf, 8);
    results[resultsLen++] = reverse8(datBuf.bb[0][0]);
    if (firstIndex !== 31)
        return DECODE_ABORT_EARLY;
    if (bits.bytes(row, startPos + 7 + 26, 2)[0] !== 0xc0)
        return DECODE_FAIL_SANITY;
    const extended = (results[0] & 0x10) !== 0;
    const maxLen = extended ? 32 : 13;
    const minLen = extended ? 23 : 10;
    let prevIndex = 33;
    for (let j = 1; j < maxLen; j++) {
        pos += 28;
        idxBuf.clear();
        datBuf.clear();
        next = bits.manchesterDecode(row, pos, idxBuf, 5);
        next = bits.manchesterDecode(row, next, datBuf, 8);
        if (next - pos !== 26)
            break;
        const index = reverse8(idxBuf.bb[0][0]);
        results[resultsLen++] = reverse8(datBuf.bb[0][0]);
        if (index < prevIndex)
            prevIndex = index;
        else
            return DECODE_ABORT_EARLY;
    }
    if (resultsLen < minLen)
        return 0;
    const want = extended ? insteonExtCrc(results) : insteonCrc(results);
    if (results[minLen - 1] !== want)
        return DECODE_FAIL_MIC;
    const toAddr = hexOf(Uint8Array.from([results[3], results[2], results[1]]), 0, 3).toUpperCase();
    const fromAddr = hexOf(Uint8Array.from([results[6], results[5], results[4]]), 0, 3).toUpperCase();
    const cmd = [];
    for (let j = 7; j < minLen - 1; j++)
        cmd.push(results[j]);
    const msgType = (results[0] >> 5) & 0x07;
    ctx.emit({
        model: 'Insteon',
        type: 'Remote',
        from_id: fromAddr,
        to_id: toAddr,
        msg_type: msgType,
        msg_str: INSTEON_MSG_TYPE[msgType],
        extended: extended ? 1 : 0,
        hopsmax: results[0] & 0x03,
        hopsleft: (results[0] >> 2) & 0x03,
        payload: hexOf(results, 0, resultsLen).toUpperCase(),
        cmd_dat: cmd,
        mic: 'CRC',
    });
    return 1;
}
export const insteon = register({
    num: 159,
    name: 'Insteon',
    what: 'home automation switch and sensor',
    modulation: 16,
    shortWidth: 110,
    longWidth: 110,
    gapLimit: 500,
    tolerance: 15,
    resetLimit: 1000,
    bands: BAND_915,
    decode(_dev, bits, ctx) {
        bits.invert();
        const preamble = new Uint8Array([0xce, 0xaa]);
        const minBits = 10 * 28 + 2;
        let events = 0;
        let failure = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] < minBits) {
                failure = DECODE_ABORT_LENGTH;
                continue;
            }
            let bitIndex = 0;
            for (;;) {
                if (bits.bitsPerRow[row] - bitIndex < minBits)
                    break;
                const at = bits.search(row, bitIndex, preamble, 16);
                if (at >= bits.bitsPerRow[row])
                    break;
                const ret = insteonPacket(bits, row, at, ctx);
                if (ret > 0) {
                    events += ret;
                    bitIndex = at + minBits;
                }
                else {
                    if (ret < 0)
                        failure = ret;
                    bitIndex = at + 16;
                }
            }
        }
        return events > 0 ? 1 : failure;
    },
});
function cm921DeviceCount(header) {
    if (header === 0x14)
        return 1;
    if (header === 0x18 || header === 0x1c || header === 0x10 || header === 0x3c)
        return 2;
    return (header >> 2) & 0x03;
}
export const honeywellCm921 = register({
    num: 185,
    name: 'Honeywell CM921 Wireless Programmable Room Thermostat',
    what: 'heating controller',
    modulation: 16,
    shortWidth: 26,
    longWidth: 26,
    tolerance: 5,
    resetLimit: 2000,
    bands: BAND_868,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 60)
            return DECODE_ABORT_LENGTH;
        const row = bits.bb[0];
        const preamble = new Uint8Array([0x55, 0x5f, 0xf0, 0x04]);
        const start = bits.search(0, 0, preamble, 30) + 30;
        const avail = bits.bitsPerRow[0] - start;
        if (avail < 8)
            return DECODE_ABORT_LENGTH;
        const end = start + avail;
        const bytes = new BitBuffer();
        let pos = start;
        while (pos < end) {
            if (pos + 10 > end)
                break;
            if (bitrowGetBit(row, pos) !== 0)
                break;
            if (bitrowGetBit(row, pos + 9) !== 1)
                break;
            const byte = bitrowGetByte(row, pos + 1);
            for (let i = 0; i < 8; i++)
                bytes.addBit((byte >> i) & 1);
            pos += 10;
        }
        if (bytes.bitsPerRow[0] < 32)
            return DECODE_FAIL_SANITY;
        const inner = bytes.bb[0];
        if (bitrowGetByte(inner, 0) !== 0x33 || bitrowGetByte(inner, 8) !== 0x55
            || bitrowGetByte(inner, 16) !== 0x53)
            return DECODE_FAIL_SANITY;
        let fi = bytes.bitsPerRow[0] - 8;
        let sawFiller = false;
        while (fi >= 24 && bitrowGetByte(inner, fi) === 0x55) {
            sawFiller = true;
            fi -= 8;
        }
        if (!sawFiller || fi < 24 || bitrowGetByte(inner, fi) !== 0x35)
            return DECODE_FAIL_SANITY;
        const first = 24;
        const numBits = fi - first;
        const packet = new BitBuffer();
        const fpos = bytes.manchesterDecode(0, first, packet, numBits);
        if (numBits - (fpos - first - 2) !== 0)
            return DECODE_FAIL_SANITY;
        const numBytes = packet.bitsPerRow[0] >> 3;
        if (numBytes < 1)
            return DECODE_ABORT_LENGTH;
        const msg = packet.bb[0];
        if ((addBytes(msg, numBytes) & 0xff) !== 0)
            return DECODE_FAIL_MIC;
        let ipos = 0;
        const nextByte = () => {
            const v = bitrowGetByte(msg, ipos);
            ipos += 8;
            return ipos >= numBytes * 8 ? 0xfc : v;
        };
        const header = nextByte();
        const idCount = cm921DeviceCount(header);
        const ids = [];
        for (let i = 0; i < idCount; i++) {
            const a = nextByte(), b = nextByte(), c = nextByte();
            ids.push(hexOf(Uint8Array.from([a, b, c]), 0, 3));
        }
        const command = (nextByte() << 8) | nextByte();
        const payloadLength = nextByte();
        const payload = new Uint8Array(Math.min(payloadLength, 256));
        for (let i = 0; i < payload.length; i++)
            payload[i] = nextByte();
        const out = {
            model: 'Honeywell-CM921',
            type: 'Thermostat',
            ids: ids.join(' '),
            mic: 'CHECKSUM',
        };
        switch (command) {
            case 0x1030:
                if (payloadLength !== 16) {
                    out.unknown = command;
                    break;
                }
                out.zone_idx = payload[0];
                for (let i = 0; i < 5; i++) {
                    const p = payload[1 + 3 * i];
                    const value = payload[3 + 3 * i];
                    if (p === 0xc8)
                        out.max_flow_temp = value;
                    else if (p === 0xc9)
                        out.pump_run_time = value;
                    else if (p === 0xca)
                        out.actuator_run_time = value;
                    else if (p === 0xcb)
                        out.min_flow_temp = value;
                }
                break;
            case 0x313f:
                if (payloadLength === 1)
                    out.time_request = payload[0];
                else if (payloadLength === 9) {
                    const pad = (n, w = 2) => n.toString().padStart(w, '0');
                    out.datetime = `${pad(payload[4] & 0x1f)}:${pad(payload[3])}:${pad(payload[2])}`
                        + ` ${pad(payload[5])}-${pad(payload[6])}-${pad((payload[7] << 8) | payload[8], 4)}`;
                }
                else
                    out.unknown = command;
                break;
            case 0x0008:
                if (payloadLength !== 2) {
                    out.unknown = command;
                    break;
                }
                out.domain_id = payload[0];
                out.demand = payload[1] / 200;
                break;
            case 0x3ef0:
                if (payloadLength === 3)
                    out.status = payload[1] / 200;
                else if (payloadLength === 6) {
                    out.boiler_modulation_level = payload[1] / 200;
                    out.flame_status = payload[3];
                }
                else
                    out.unknown = command;
                break;
            case 0x2309:
                if (payloadLength !== 3) {
                    out.unknown = command;
                    break;
                }
                out.zone = payload[0];
                out.setpoint = ((payload[1] << 8) | payload[2]) / 100;
                break;
            case 0x1100:
                if (payloadLength !== 5 && payloadLength !== 8) {
                    out.unknown = command;
                    break;
                }
                out.domain_id = payload[0];
                out.cycle_rate = payload[1] / 4;
                out.minimum_on_time = payload[2] / 4;
                out.minimum_off_time = payload[3] / 4;
                if (payloadLength === 8)
                    out.proportional_band_width = ((payload[5] << 8) | payload[6]) / 100;
                break;
            case 0x0009:
                if (payloadLength !== 3) {
                    out.unknown = command;
                    break;
                }
                out.device_number = payload[0];
                out.failsafe_mode = payload[1] === 0 ? 'off' : payload[1] === 1 ? '20-80' : 'unknown';
                break;
            case 0x3b00:
                if (payloadLength !== 2) {
                    out.unknown = command;
                    break;
                }
                out.domain_id = payload[0];
                out.state = payload[1] / 200;
                break;
            case 0x30c9: {
                const zones = Math.floor(payloadLength / 3);
                for (let i = 0; i < zones; i++) {
                    const t = (((payload[3 * i + 1] << 8) | payload[3 * i + 2]) << 16) >> 16;
                    out[`temperature (zone ${payload[3 * i]})`] = t / 100;
                }
                break;
            }
            case 0x1fd4:
                out.ticker = (payload[1] << 8) | payload[2];
                break;
            case 0x3150:
                out.zone = payload[0];
                out.heat_demand = payload[1];
                break;
            default:
                out.unknown = command;
                break;
        }
        ctx.emit(out);
        return 1;
    },
});
const X3D_CLASS = ['Sensor', 'Standard', 'Pairing', 'Beacon'];
export const deltadoreX3d = register({
    num: 269,
    name: 'DeltaDore X3D devices',
    what: 'heating and shutter controller',
    modulation: 16,
    shortWidth: 25,
    longWidth: 25,
    resetLimit: 800,
    bands: BAND_868_95,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const preamble = new Uint8Array([0xaa, 0xaa, 0x81, 0x69, 0x96, 0x7e]);
        let start = bits.search(0, 0, preamble, 48);
        if (start >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        start += 48;
        if (bits.bitsPerRow[0] < 10 * 8)
            return DECODE_ABORT_LENGTH;
        const lenByte = bits.bytes(0, start, 8);
        ccittWhitening(lenByte, 1);
        const len = lenByte[0];
        if (len < 2 || len > 64)
            return DECODE_ABORT_LENGTH;
        const frame = new Uint8Array(65);
        frame.set(bits.bytes(0, start, len * 8).subarray(0, len));
        ccittWhitening(frame, len);
        if (crc16(frame, len - 2, 0x1021, 0x0000) !== ((frame[len - 2] << 8) | frame[len - 1])) {
            return DECODE_FAIL_MIC;
        }
        let at = 2;
        const number = frame[at++];
        const msgType = frame[at++];
        const headerLen = frame[at] & 0x1f;
        const headerFlags = frame[at++] & 0xe0;
        const deviceId = frame[at] | (frame[at + 1] << 8) | (frame[at + 2] << 16);
        at += 3;
        const network = frame[at++];
        at++;
        const flags2 = frame[at++];
        const flags3 = frame[at++];
        let hasTemp = false;
        let tempType = 0;
        let temperature = 0;
        if (flags3 === 0x01) {
            at++;
        }
        else if (flags3 === 0x08) {
            hasTemp = true;
            tempType = frame[at++];
            temperature = ((frame[at] | (frame[at + 1] << 8)) << 16) >> 16;
            at += 2;
        }
        const messageId = frame[at] | (frame[at + 1] << 8);
        at += 4;
        const noPayload = (headerFlags & 0x20) !== 0;
        if (msgType === 0x01 && !noPayload && len < at + 12 + 2)
            return DECODE_ABORT_LENGTH;
        const out = {
            model: 'DeltaDore-X3D',
            type: 'Thermostat',
            id: deviceId,
            network,
            subtype: X3D_CLASS[msgType] ?? 'Unknown',
            msg_id: messageId,
            msg_no: number,
            header_len: headerLen,
            mic: 'CRC',
        };
        if (hasTemp) {
            out.temperature_C = Math.round(temperature) / 100;
            out.temperature_type = tempType === 0x00 ? 'indoor' : tempType === 0x01 ? 'outdoor' : '';
        }
        if (noPayload) {
            if (flags2 === 0x01)
                out.wnd_stat = 'Closed';
            else if (flags2 === 0x41)
                out.wnd_stat = 'Opened';
        }
        else if (msgType === 0x01) {
            out.retry = frame[at++];
            out.transfer = frame[at] | (frame[at + 1] << 8);
            at += 2;
            out.transfer_ack = frame[at] | (frame[at + 1] << 8);
            at += 2;
            out.target = frame[at] | (frame[at + 1] << 8);
            at += 2;
            out.action = frame[at++];
            out.register_high = frame[at++];
            out.register_low = frame[at++];
            out.target_ack = frame[at] | (frame[at + 1] << 8);
            at += 2;
            out.raw_msg = hexOf(frame, at, Math.max(0, len - at - 2));
        }
        ctx.emit(out);
        return 1;
    },
});
