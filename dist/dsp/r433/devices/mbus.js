import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc16, crc16lsb, extractBytesUart8n2 } from '../util.js';
const BLOCK1A_SIZE = 12;
const BLOCK1B_SIZE = 10;
const BLOCK2B_SIZE = 118;
const BUF_SIZE = 512;
const hex2 = (v) => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
const hexBytes = (m, n) => {
    let s = '';
    for (let i = 0; i < n && i < m.length; i++)
        s += m[i].toString(16).padStart(2, '0');
    return s;
};
const bcd2int = (b) => (b >> 4) * 10 + (b & 0x0f);
function byteAt(m, off) {
    const i = off >> 3, s = off & 7;
    if (!s)
        return m[i] ?? 0;
    return ((((m[i] ?? 0) << 8) | (m[i + 1] ?? 0)) >> (8 - s)) & 0xff;
}
function manufDecode(mField) {
    return String.fromCharCode(((mField >> 10) & 0x1f) + 0x40, ((mField >> 5) & 0x1f) + 0x40, (mField & 0x1f) + 0x40);
}
function deviceTypeStr(t) {
    switch (t) {
        case 0x00: return 'Other';
        case 0x01: return 'Oil';
        case 0x02: return 'Electricity';
        case 0x03: return 'Gas';
        case 0x04: return 'Heat';
        case 0x05: return 'Steam';
        case 0x06: return 'Warm Water';
        case 0x07: return 'Water';
        case 0x08: return 'Heat Cost Allocator';
        case 0x09: return 'Compressed Air';
        case 0x0a:
        case 0x0b: return 'Cooling load meter';
        case 0x0c: return 'Heat';
        case 0x0d: return 'Heat/Cooling load meter';
        case 0x0e: return 'Bus/System component';
        case 0x0f: return 'Unknown';
        case 0x15: return 'Hot Water';
        case 0x16: return 'Cold Water';
        case 0x17: return 'Hot/Cold Water meter';
        case 0x18: return 'Pressure';
        case 0x19: return 'A/D Converter';
        case 0x1a: return 'Smoke detector';
        case 0x1b: return 'Room sensor';
        case 0x1c: return 'Gas detector';
        case 0x20: return 'Breaker (electricity)';
        case 0x21: return 'Valve (gas or water)';
        case 0x25: return 'Customer unit (display device)';
        case 0x28: return 'Waste water meter';
        case 0x29: return 'Garbage';
        case 0x2a: return 'Carbon dioxide';
        case 0x31: return 'Communication controller';
        case 0x32: return 'Unidirectional repeater';
        case 0x33: return 'Bidirectional repeater';
        case 0x36: return 'Radio converter (system side)';
        case 0x37: return 'Radio converter (meter side)';
        default: return '';
    }
}
function decode3of6(byte) {
    switch (byte) {
        case 22: return 0x00;
        case 13: return 0x01;
        case 14: return 0x02;
        case 11: return 0x03;
        case 28: return 0x04;
        case 25: return 0x05;
        case 26: return 0x06;
        case 19: return 0x07;
        case 44: return 0x08;
        case 37: return 0x09;
        case 38: return 0x0a;
        case 35: return 0x0b;
        case 52: return 0x0c;
        case 49: return 0x0d;
        case 50: return 0x0e;
        case 41: return 0x0f;
        default: return 0xf0;
    }
}
function decode3of6Buffer(bits, bitOffset, out, numBytes) {
    let contiguous = -1;
    const n = Math.min(numBytes, out.length);
    for (let i = 0; i < n; i++) {
        const hi = decode3of6(byteAt(bits, i * 12 + bitOffset) >> 2);
        let lo = decode3of6(byteAt(bits, i * 12 + bitOffset + 6) >> 2);
        if (hi > 0x0f || lo > 0x0f) {
            lo &= 0x0f;
            if (contiguous < 0)
                contiguous = i;
        }
        out[i] = ((hi << 4) | lo) & 0xff;
    }
    return contiguous < 0 ? n : contiguous;
}
function crcValid(b, at, n) {
    if (n < 0 || at + n + 1 >= b.length)
        return false;
    const calc = (~crc16(b, n, 0x3d65, 0, at)) & 0xffff;
    const read = ((b[at + n] << 8) | b[at + n + 1]) & 0xffff;
    return calc === read;
}
const newData = () => ({ length: 0, data: new Uint8Array(BUF_SIZE) });
const newBlock2 = () => ({
    CI: 0, AC: 0, ST: 0, CW: 0, plOffset: 0,
    ellCi: 0, ellCc: 0, ellAcc: 0, ellSecMode: 0,
    knxCtrl: 0, src: 0, dst: 0, lNpci: 0, tpci: 0, apci: 0, qdsWalkBy: 0,
});
const newBlock1 = () => ({
    L: 0, C: 0, mStr: '', aId: 0, aVersion: 0, aDevType: 0,
    knxMode: false, knxSn: new Uint8Array(6),
    block2: newBlock2(),
});
function ellLen(ci) {
    switch (ci) {
        case 0x8c: return 2;
        case 0x8d: return 8;
        case 0x8e: return 10;
        case 0x8f: return 16;
        default: return -1;
    }
}
function parseCi(b, at, remaining, plBase, b2, depth = 0) {
    if (remaining < 1 || depth > 4)
        return;
    b2.CI = b[at] ?? 0;
    const el = ellLen(b2.CI);
    if (el >= 0) {
        if (remaining < 1 + el)
            return;
        b2.ellCi = b2.CI;
        b2.ellCc = b[at + 1] ?? 0;
        b2.ellAcc = b[at + 2] ?? 0;
        if (b2.CI === 0x8d || b2.CI === 0x8f) {
            const snOff = b2.CI === 0x8f ? 11 : 3;
            const sn = ((b[at + snOff] ?? 0) | ((b[at + snOff + 1] ?? 0) << 8)
                | ((b[at + snOff + 2] ?? 0) << 16) | ((b[at + snOff + 3] ?? 0) << 24)) >>> 0;
            b2.ellSecMode = (sn >>> 29) & 0x7;
        }
        else {
            b2.ellSecMode = 0;
        }
        if (b2.ellSecMode !== 0)
            return;
        parseCi(b, at + 1 + el, remaining - 1 - el, plBase + 1 + el, b2, depth + 1);
        return;
    }
    if (b2.CI === 0x90) {
        if (remaining < 2)
            return;
        const aflLen = b[at + 1] ?? 0;
        if (remaining < 2 + aflLen)
            return;
        parseCi(b, at + 2 + aflLen, remaining - 2 - aflLen, plBase + 2 + aflLen, b2, depth + 1);
        return;
    }
    if (b2.CI === 0x7a) {
        b2.AC = b[at + 1] ?? 0;
        b2.ST = b[at + 2] ?? 0;
        b2.CW = (((b[at + 4] ?? 0) << 8) | (b[at + 3] ?? 0)) & 0xffff;
        b2.plOffset = plBase + 5;
    }
    else if (b2.CI === 0x72) {
        b2.AC = b[at + 9] ?? 0;
        b2.ST = b[at + 10] ?? 0;
        b2.CW = (((b[at + 12] ?? 0) << 8) | (b[at + 11] ?? 0)) & 0xffff;
        b2.plOffset = plBase + 13;
    }
    else if (b2.CI === 0x78) {
        b2.plOffset = plBase + 1;
    }
    if (b2.CI === 0x78 && b[at + 1] === 0x0d && b[at + 2] === 0xff && b[at + 3] === 0x5f && b[at + 4] === 0x35) {
        b2.AC = b[at + 7] ?? 0;
        b2.ST = b[at + 5] ?? 0;
        b2.CW = (((b[at + 9] ?? 0) << 8) | (b[at + 8] ?? 0)) & 0xffff;
        b2.plOffset = plBase + 1;
        b2.qdsWalkBy = 1;
    }
}
function parseBlock2(inp, b1, block1Size, plBase) {
    const b = inp.data;
    if (b1.knxMode) {
        b1.block2.knxCtrl = b[block1Size] ?? 0;
        b1.block2.src = (((b[block1Size + 1] ?? 0) << 8) | (b[block1Size + 2] ?? 0)) & 0xffff;
        b1.block2.dst = (((b[block1Size + 3] ?? 0) << 8) | (b[block1Size + 4] ?? 0)) & 0xffff;
        b1.block2.lNpci = b[block1Size + 5] ?? 0;
        b1.block2.tpci = b[block1Size + 6] ?? 0;
        b1.block2.apci = b[block1Size + 7] ?? 0;
    }
    else {
        const remaining = inp.length > block1Size ? inp.length - block1Size : 0;
        parseCi(b, block1Size, remaining, plBase, b1.block2);
    }
}
function decodeFormatA(inp, out, b1) {
    const d = inp.data;
    b1.L = d[0];
    b1.C = d[1];
    if (d[2] === 0xff && d[3] === 0x03) {
        b1.knxMode = true;
        b1.knxSn.set(d.subarray(4, 10));
    }
    else {
        b1.mStr = manufDecode(((d[3] << 8) | d[2]) & 0xffff);
        b1.aId = bcd2int(d[7]) * 1000000 + bcd2int(d[6]) * 10000 + bcd2int(d[5]) * 100 + bcd2int(d[4]);
        b1.aVersion = d[8];
        b1.aDevType = d[9];
    }
    out.length = b1.L - 9 + BLOCK1A_SIZE - 2;
    if (!crcValid(d, 0, 10))
        return false;
    const numDataBlocks = Math.floor((b1.L - 9 + 15) / 16);
    if (b1.L < 9 || (b1.L - 9) + numDataBlocks * 2 > inp.length - BLOCK1A_SIZE)
        return false;
    out.data.set(d.subarray(0, BLOCK1A_SIZE - 2), 0);
    for (let n = 0; n < numDataBlocks; n++) {
        const inAt = BLOCK1A_SIZE + n * 18;
        const outAt = n * 16 + BLOCK1A_SIZE - 2;
        const blockSize = Math.min(b1.L - 9 - n * 16, 16) + 2;
        if (blockSize < 2 || outAt + blockSize > BUF_SIZE)
            return false;
        if (!crcValid(d, inAt, blockSize - 2))
            return false;
        out.data.set(d.subarray(inAt, inAt + blockSize), outAt);
    }
    parseBlock2(inp, b1, BLOCK1A_SIZE, BLOCK1A_SIZE - 2);
    return true;
}
function decodeFormatB(inp, out, b1) {
    const d = inp.data;
    b1.L = d[0];
    b1.C = d[1];
    b1.mStr = manufDecode(((d[3] << 8) | d[2]) & 0xffff);
    b1.aId = bcd2int(d[7]) * 1000000 + bcd2int(d[6]) * 10000 + bcd2int(d[5]) * 100 + bcd2int(d[4]);
    b1.aVersion = d[8];
    b1.aDevType = d[9];
    out.length = b1.L - (9 + 2) + BLOCK1B_SIZE - 2;
    if (b1.L < 12 || b1.L + 1 > inp.length)
        return false;
    if (!crcValid(d, 0, Math.min(b1.L - 1, (BLOCK1B_SIZE + BLOCK2B_SIZE) - 2)))
        return false;
    const take = Math.min(b1.L - 11, BLOCK2B_SIZE - 2) + BLOCK1B_SIZE;
    out.data.set(d.subarray(0, Math.max(0, Math.min(take, BUF_SIZE))), 0);
    const L_OFFSET = BLOCK1B_SIZE + BLOCK2B_SIZE - 1;
    if (b1.L > L_OFFSET + 2) {
        const n = b1.L - L_OFFSET - 2;
        if (!crcValid(d, BLOCK1B_SIZE + BLOCK2B_SIZE, n))
            return false;
        out.data.set(d.subarray(BLOCK2B_SIZE, BLOCK2B_SIZE + n), BLOCK2B_SIZE - 2);
        out.length -= 2;
    }
    out.length += 2;
    parseBlock2(inp, b1, BLOCK1B_SIZE, BLOCK1B_SIZE);
    return true;
}
function emitMBus(ctx, out, b1, mode) {
    const b2 = b1.block2;
    let data;
    if (b1.knxMode) {
        data = {
            model: 'KNX-RF',
            type: 'Meter',
            mode,
            id: hexBytes(b1.knxSn, 6).toUpperCase(),
            sn: hexBytes(b1.knxSn, 6),
            knx_ctrl: hex2(b2.knxCtrl),
            src: hex4(b2.src),
            dst: hex4(b2.dst),
            l_npci: hex2(b2.lNpci),
            tpci: hex2(b2.tpci),
            apci: hex2(b2.apci),
        };
    }
    else {
        data = {
            model: 'Wireless-MBus',
            type: 'Meter',
            mode,
            manufacturer: b1.mStr,
            id: String(b1.aId),
            version: b1.aVersion,
            device_type: hex2(b1.aDevType),
            device_type_string: deviceTypeStr(b1.aDevType),
            control: hex2(b1.C),
        };
    }
    const n = Math.max(0, Math.min(out.length, BUF_SIZE));
    data.data = hexBytes(out.data, n);
    if (b2.ellCi) {
        data.ell_ci = hex2(b2.ellCi);
        data.ell_cc = hex2(b2.ellCc);
        data.ell_acc = hex2(b2.ellAcc);
    }
    if (b2.CI && b2.CI !== b2.ellCi) {
        data.CI = hex2(b2.CI);
        if (b2.plOffset) {
            data.AC = hex2(b2.AC);
            data.ST = hex2(b2.ST);
            data.CW = hex4(b2.CW);
        }
    }
    if (b2.qdsWalkBy)
        data.qds_walk_by = 1;
    if (!b1.knxMode && !b2.plOffset) {
        if (b2.ellCi && b2.ellSecMode)
            data.payload_encrypted = 1;
    }
    else if (b2.CW & 0x0500) {
        data.payload_encrypted = 1;
    }
    data.mic = 'CRC';
    ctx.emit(data);
    return 1;
}
const PREAMBLE_T = new Uint8Array([0x54, 0x3d]);
const PREAMBLE_RA = new Uint8Array([0x55, 0x54, 0x76, 0x96]);
const PREAMBLE_F = new Uint8Array([0x55, 0xf6]);
const PREAMBLE_S = new Uint8Array([0x54, 0x76, 0x96]);
const PREAMBLE_T_DN = new Uint8Array([0xaa, 0xab, 0x32]);
function modeCtDecode(bits, ctx) {
    const n = bits.bitsPerRow[0];
    if (n < 32 + 13 * 8 || n > 64 + 256 * 12)
        return DECODE_ABORT_LENGTH;
    let at = bits.search(0, 0, PREAMBLE_T, 16);
    if (at + 13 * 8 >= n)
        return DECODE_ABORT_EARLY;
    at += 16;
    const row = bits.bb[0];
    const inp = newData(), out = newData(), b1 = newBlock1();
    let next = byteAt(row, at);
    at += 8;
    let mode;
    if (next === 0x54) {
        mode = 'C';
        next = byteAt(row, at);
        at += 8;
        inp.length = Math.min(Math.floor((n - at) / 8), BUF_SIZE);
        if (next === 0xcd) {
            bits.extractBytes(0, at, inp.data, inp.length * 8);
            if (!decodeFormatA(inp, out, b1))
                return DECODE_FAIL_SANITY;
        }
        else if (next === 0x3d) {
            bits.extractBytes(0, at, inp.data, inp.length * 8);
            if (!decodeFormatB(inp, out, b1))
                return DECODE_FAIL_SANITY;
        }
        else {
            return DECODE_ABORT_EARLY;
        }
    }
    else {
        mode = 'T';
        at -= 8;
        inp.length = Math.min(Math.floor((n - at) / 12), BUF_SIZE);
        if (decode3of6Buffer(row, at, inp.data, inp.length) < 0)
            return DECODE_FAIL_SANITY;
        if (!decodeFormatA(inp, out, b1))
            return DECODE_FAIL_SANITY;
    }
    return emitMBus(ctx, out, b1, mode);
}
function modeSDecode(bits, ctx) {
    const n = bits.bitsPerRow[0];
    if (n < 32 + 13 * 8 || n > 64 + 256 * 8)
        return DECODE_ABORT_LENGTH;
    const dn = bits.search(0, 0, PREAMBLE_T_DN, 24);
    if (dn + 24 < n)
        return DECODE_ABORT_EARLY;
    let at = bits.search(0, 0, PREAMBLE_S, 24);
    at += 24;
    if (at >= n)
        return DECODE_ABORT_EARLY;
    const packet = new BitBuffer();
    bits.manchesterDecode(0, at, packet, 800);
    const decodedBits = packet.bitsPerRow[0] ?? 0;
    if (decodedBits < BLOCK1A_SIZE * 8)
        return DECODE_ABORT_LENGTH;
    const inp = newData(), out = newData(), b1 = newBlock1();
    inp.length = Math.min(decodedBits >> 3, BUF_SIZE);
    packet.extractBytes(0, 0, inp.data, inp.length * 8);
    if (!decodeFormatA(inp, out, b1))
        return DECODE_FAIL_SANITY;
    return emitMBus(ctx, out, b1, 'S');
}
function modeRDecode(bits, ctx) {
    const n = bits.bitsPerRow[0];
    if (n < 32 + 13 * 8 || n > 64 + 256 * 8)
        return DECODE_ABORT_LENGTH;
    let at = bits.search(0, 0, PREAMBLE_RA, 32);
    if (at + 13 * 8 >= n)
        return DECODE_ABORT_EARLY;
    at += 32;
    const inp = newData(), out = newData(), b1 = newBlock1();
    inp.length = Math.min(Math.floor((n - at) / 8), BUF_SIZE);
    bits.extractBytes(0, at, inp.data, inp.length * 8);
    if (!decodeFormatA(inp, out, b1))
        return DECODE_FAIL_SANITY;
    return emitMBus(ctx, out, b1, 'R');
}
function modeFDecode(bits, ctx) {
    const n = bits.bitsPerRow[0];
    if (n < 32 + 13 * 8 || n > 64 + 256 * 8)
        return DECODE_ABORT_LENGTH;
    let at = bits.search(0, 0, PREAMBLE_F, 16);
    if (at + 13 * 8 >= n)
        return DECODE_ABORT_EARLY;
    at += 16;
    const next = byteAt(bits.bb[0], at);
    if (next !== 0x8d && next !== 0x72)
        return DECODE_ABORT_EARLY;
    ctx.emit({
        model: 'Wireless-MBus',
        type: 'Meter',
        mode: 'F',
        format: next === 0x8d ? 'A' : 'B',
        note: 'preamble and format byte recognized; payload framing unverified upstream',
    });
    return 1;
}
export const mBusModeCT = register({
    num: 104,
    name: 'Wireless M-Bus, Mode C&T, 100kbps',
    what: 'utility meter',
    modulation: 16,
    shortWidth: 10,
    longWidth: 10,
    resetLimit: 500,
    bands: [868950000],
    decode: (_dev, bits, ctx) => modeCtDecode(bits, ctx),
});
export const mBusModeS = register({
    num: 105,
    name: 'Wireless M-Bus, Mode S, 32.768kbps',
    what: 'utility meter',
    modulation: 16,
    shortWidth: 1000 / 32.768,
    longWidth: 1000 / 32.768,
    resetLimit: (1000 / 32.768) * 9,
    bands: [868300000],
    decode: (_dev, bits, ctx) => modeSDecode(bits, ctx),
});
export const mBusModeR = register({
    num: 106,
    name: 'Wireless M-Bus, Mode R, 4.8kbps',
    what: 'utility meter',
    modulation: 18,
    shortWidth: 1000 / 4.8 / 2,
    longWidth: 0,
    resetLimit: (1000 / 4.8) * 1.5,
    bands: [868330000],
    disabled: true,
    decode: (_dev, bits, ctx) => modeRDecode(bits, ctx),
});
export const mBusModeF = register({
    num: 107,
    name: 'Wireless M-Bus, Mode F, 2.4kbps',
    what: 'utility meter',
    modulation: 16,
    shortWidth: 1000 / 2.4,
    longWidth: 1000 / 2.4,
    resetLimit: 5000,
    bands: [433820000],
    disabled: true,
    decode: (_dev, bits, ctx) => modeFDecode(bits, ctx),
});
export const mBusModeCTDownlink = register({
    num: 238,
    name: 'Wireless M-Bus, Mode T, 32.768kbps (downlink)',
    what: 'utility meter',
    modulation: 16,
    shortWidth: 1000 / 32.768,
    longWidth: 1000 / 32.768,
    resetLimit: (1000 / 32.768) * 9,
    bands: [868300000],
    decode: (_dev, bits, ctx) => modeCtDecode(bits, ctx),
});
const RADIAN_MAX_FRAME_BYTES = 256;
const RADIAN_MIN_FRAME_BYTES = 6;
const RADIAN_SYNC = new Uint8Array([0x0f, 0xff, 0xff, 0xff, 0xf0]);
function radianControlString(control) {
    switch (control) {
        case 0x06: return 'ack';
        case 0x10: return 'request';
        case 0x11: return 'response';
        default: return 'unknown';
    }
}
function radianFindWmbusFrame(body, bodyLen) {
    for (let i = 0; i + 4 <= bodyLen; i++) {
        if (body[i] !== 0x68 || body[i + 3] !== 0x68 || body[i + 1] !== body[i + 2])
            continue;
        const wlen = body[i + 1];
        if (i + 4 + wlen + 2 > bodyLen)
            continue;
        const at = i + 4;
        let sum = 0;
        for (let j = 0; j < wlen; j++)
            sum = (sum + body[at + j]) & 0xff;
        if (sum !== body[at + wlen] || body[at + wlen + 1] !== 0x16)
            continue;
        return { at, len: wlen };
    }
    return null;
}
function radianDecodeRow(bits, ctx, row) {
    const rowBits = bits.bitsPerRow[row];
    let pos = bits.search(row, 0, RADIAN_SYNC, 36);
    if (pos >= rowBits)
        return DECODE_ABORT_EARLY;
    pos += 36;
    if (pos >= rowBits)
        return DECODE_ABORT_LENGTH;
    const frame = new Uint8Array(RADIAN_MAX_FRAME_BYTES);
    const maxBits = Math.min(rowBits - pos, RADIAN_MAX_FRAME_BYTES * 11);
    const frameLen = extractBytesUart8n2(bits.bb[row], pos, maxBits, frame);
    if (frameLen < RADIAN_MIN_FRAME_BYTES)
        return DECODE_ABORT_LENGTH;
    const declared = frame[0];
    if (declared < RADIAN_MIN_FRAME_BYTES || declared > RADIAN_MAX_FRAME_BYTES)
        return DECODE_FAIL_SANITY;
    if (frameLen < declared)
        return DECODE_ABORT_LENGTH;
    const crcRx = (frame[declared - 2] | (frame[declared - 1] << 8)) & 0xffff;
    if (crc16lsb(frame, declared - 2, 0x8408, 0x0000) !== crcRx)
        return DECODE_FAIL_MIC;
    const control = frame[1];
    let addrOff = 2, bodyOff = 12, spaced = 0;
    if (declared >= 18 && frame[2] === 0x00 && frame[8] === 0x00 && frame[14] === 0x00) {
        addrOff = 3;
        bodyOff = 15;
        spaced = 1;
    }
    if (bodyOff + 2 > declared)
        return DECODE_FAIL_SANITY;
    const bodyLen = declared - bodyOff - 2;
    const senderId = hexBytes(frame.subarray(addrOff + 5 + spaced, addrOff + 10 + spaced), 5);
    const data = {
        model: 'RADIAN',
        type: 'Meter',
        id: senderId,
        len: declared,
        control: hex2(control),
        control_string: radianControlString(control),
        header_variant: spaced ? 'spaced' : 'compact',
        receiver_id: hexBytes(frame.subarray(addrOff, addrOff + 5), 5),
        sender_id: senderId,
        body_len: bodyLen,
        body: hexBytes(frame.subarray(bodyOff, bodyOff + bodyLen), bodyLen),
        crc: hex4(crcRx),
        data: hexBytes(frame, declared),
    };
    const wm = radianFindWmbusFrame(frame.subarray(bodyOff, bodyOff + bodyLen), bodyLen);
    if (wm) {
        const b2 = newBlock2();
        const wired = frame.subarray(bodyOff + wm.at, bodyOff + wm.at + wm.len);
        parseCi(wired, 2, wm.len > 2 ? wm.len - 2 : 0, 2, b2);
        if (b2.CI)
            data.wmbus_ci = hex2(b2.CI);
        if (b2.plOffset) {
            data.wmbus_ac = hex2(b2.AC);
            data.wmbus_st = hex2(b2.ST);
            data.wmbus_cw = hex4(b2.CW);
        }
    }
    data.mic = 'CRC';
    ctx.emit(data);
    return 1;
}
export const radian = register({
    num: 379,
    name: 'RADIAN/RADIAN0 meter',
    what: 'utility meter',
    modulation: 16,
    shortWidth: 416,
    longWidth: 416,
    resetLimit: 20000,
    decode(_dev, bits, ctx) {
        let events = 0, aborts = 0, fails = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] < 36 + RADIAN_MIN_FRAME_BYTES * 11) {
                aborts++;
                continue;
            }
            const ret = radianDecodeRow(bits, ctx, row);
            if (ret > 0)
                events += ret;
            else if (ret === DECODE_FAIL_MIC || ret === DECODE_FAIL_SANITY)
                fails++;
            else
                aborts++;
        }
        if (events)
            return events;
        if (fails)
            return DECODE_FAIL_MIC;
        if (aborts)
            return DECODE_ABORT_EARLY;
        return DECODE_ABORT_LENGTH;
    },
});
