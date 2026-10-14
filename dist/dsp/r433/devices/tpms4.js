import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, crc16, xorBytes } from '../util.js';
const BANDS = [315000000, 433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const hexLow = (v, n) => (v >>> 0).toString(16).padStart(n, '0');
function pmv107jDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    const startPos = bits.differentialManchesterDecode(row, bitpos, packet, 70);
    if (startPos - bitpos < 67 * 2)
        return 0;
    const b = new Uint8Array(9);
    b[0] = packet.bb[0][0] >> 6;
    packet.extractBytes(0, 2, b.subarray(1), 64);
    if (crc8(b, 8, 0x13, 0x00) !== b[8])
        return 0;
    const pressure1 = b[5];
    const pressure2 = b[6] ^ 0xff;
    if (pressure1 !== pressure2)
        return 0;
    const id = ((b[0] << 26) | (b[1] << 18) | (b[2] << 10) | (b[3] << 2) | (b[4] >> 6)) >>> 0;
    const status = b[4] & 0x3f;
    ctx.emit({
        model: 'PMV-107J',
        type: 'TPMS',
        id: hexLow(id, 8),
        status,
        battery_ok: (b[4] & 0x20) >> 5 ? 0 : 1,
        counter: (b[4] & 0x18) >> 3,
        rapid_change: (b[4] & 0x02) >> 1,
        failed: (b[4] & 0x01) ? 'FAIL' : 'OK',
        pressure_kPa: round1((pressure1 - 40) * 2.48),
        temperature_C: b[7] - 40,
        mic: 'CRC',
    });
    return 1;
}
export const tpmsPmv107j = register({
    num: 110,
    name: 'PMV-107J (Toyota) TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 250,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xf8]);
        let bitpos = 0, events = 0, ret = 0;
        while ((bitpos = bits.search(0, bitpos, pre, 6)) + 67 * 2 <= bits.bitsPerRow[0]) {
            ret = pmv107jDecode(bits, ctx, 0, bitpos + 6);
            if (ret > 0)
                events += ret;
            bitpos += 2;
        }
        return events > 0 ? events : ret;
    },
});
function hyundaiVdoDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.manchesterDecode(row, bitpos, packet, 80);
    if (packet.bitsPerRow[0] < 80)
        return DECODE_FAIL_SANITY;
    const b = packet.bb[0];
    if (crc8(b, 9, 0x07, 0xaa) !== b[9])
        return 0;
    const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    ctx.emit({
        model: 'Hyundai-VDO',
        type: 'TPMS',
        id: hexLow(id, 8),
        state: b[0],
        flags: b[5] >> 4,
        repeat: b[5] & 0x0f,
        pressure_kPa: Math.round(b[6] * 1.375),
        temperature_C: b[7] - 50,
        maybe_battery: b[8],
        mic: 'CRC',
    });
    return 1;
}
export const tpmsHyundaiVdo = register({
    num: 186,
    name: 'Hyundai TPMS (VDO)',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xaa, 0xaa, 0xaa, 0xa9]);
        bits.invert();
        let bitpos = 0, events = 0, ret = 0;
        while ((bitpos = bits.search(0, bitpos, pre, 32)) + 80 <= bits.bitsPerRow[0]) {
            ret = hyundaiVdoDecode(bits, ctx, 0, bitpos + 32);
            if (ret > 0)
                events += ret;
            bitpos += 2;
        }
        return events > 0 ? events : ret;
    },
});
function porscheDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.differentialManchesterDecode(row, bitpos, packet, 80);
    if (packet.bitsPerRow[0] < 80)
        return 0;
    const b = packet.bb[0];
    if (crc16(b, 10, 0x1021, 0xffff) !== 0)
        return 0;
    const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    ctx.emit({
        model: 'Porsche',
        type: 'TPMS',
        id: hexLow(id, 8),
        pressure_kPa: Math.floor(b[4] * 5 / 2) - 100,
        temperature_C: b[5] - 40,
        flags: hexLow((b[6] << 8) | b[7], 4),
        mic: 'CRC',
    });
    return 1;
}
export const tpmsPorsche = register({
    num: 203,
    name: 'Porsche Boxster/Cayman TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const patterns = [new Uint8Array([0x33, 0x33, 0x20]), new Uint8Array([0xcc, 0xcc, 0xd0])];
        let events = 0;
        for (const pre of patterns) {
            let bitpos = 0;
            while ((bitpos = bits.search(0, bitpos, pre, 20)) + 100 <= bits.bitsPerRow[0]) {
                events += porscheDecode(bits, ctx, 0, bitpos + 20);
                bitpos += 2;
            }
        }
        return events;
    },
});
const AVE_SCALE = [
    { ratio: 2.352, offset: 47.0 },
    { ratio: 2.352, offset: 0.0 },
    { ratio: 5.491, offset: 18.2 },
    { ratio: 5.491, offset: 0.0 },
];
function aveDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.differentialManchesterDecode(row, bitpos, packet, 160);
    if ((packet.bitsPerRow[row] ?? 0) < 64)
        return DECODE_ABORT_LENGTH;
    const b = packet.bb[row];
    if (crc8(b, 8, 0x31, 0xff) !== 0)
        return DECODE_FAIL_MIC;
    const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const mode = (b[6] >> 6) & 0x3;
    const batteryRaw = (b[6] >> 3) & 0x7;
    const { ratio, offset } = AVE_SCALE[mode];
    let batteryPct = 100;
    if (batteryRaw === 6)
        batteryPct = 75;
    else if (batteryRaw === 7)
        batteryPct = 25;
    ctx.emit({
        model: 'AVE',
        type: 'TPMS',
        id: hexLow(id, 8),
        mode: `M${mode}`,
        pressure_kPa: round1((b[4] - offset) * ratio),
        temperature_C: b[5] - 50,
        battery_ok: batteryRaw !== 7 ? 1 : 0,
        battery_pct: batteryPct,
        flags: hexLow(b[6] & 0x7, 1),
        mic: 'CRC',
    });
    return 1;
}
export const tpmsAve = register({
    num: 208,
    name: 'AVE TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 400,
    tolerance: 15,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xcc, 0xcc, 0xcc, 0xcd]);
        let events = 0, ret = 0;
        for (let row = 0; row < bits.numRows; row++) {
            let bitpos = 0;
            while ((bitpos = bits.search(0, bitpos, pre, 32)) + 132 <= bits.bitsPerRow[0]) {
                ret = aveDecode(bits, ctx, row, bitpos + 32);
                if (ret > 0) {
                    events += ret;
                    bitpos += 132;
                }
                bitpos += 31;
            }
        }
        return events > 0 ? events : ret;
    },
});
function renault0435rDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.manchesterDecode(row, bitpos, packet, 160);
    if (packet.bitsPerRow[0] < 72)
        return DECODE_ABORT_EARLY;
    const b = packet.bb[0];
    if (xorBytes(b, 9) !== 0)
        return DECODE_FAIL_MIC;
    const tick = b[8] & 0x7f;
    const hasTick = b[8] >> 7;
    if (b[8] && (!hasTick || tick > 30))
        return DECODE_FAIL_SANITY;
    ctx.emit({
        model: 'Renault-0435R',
        type: 'TPMS',
        id: `${hexLow(b[0], 2)}${hexLow(b[1], 2)}${hexLow(b[2], 2)}`,
        flags: hexLow(b[3], 2),
        pressure_kPa: round1(b[4] / 0.75),
        temperature_C: b[5] - 50,
        centrifugal_acc: b[6] * 5,
        has_tick: hasTick,
        tick: tick - 0x80 * (1 - hasTick),
        mic: 'CHECKSUM',
    });
    return 1;
}
export const tpmsRenault0435r = register({
    num: 212,
    name: 'Renault 0435R TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 150,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xaa, 0xa9]);
        bits.invert();
        let events = 0, ret = 0;
        for (let row = 0; row < bits.numRows; row++) {
            let bitpos = 0;
            while ((bitpos = bits.search(row, bitpos, pre, 16)) + 160 <= bits.bitsPerRow[row]) {
                ret = renault0435rDecode(bits, ctx, row, bitpos + 16);
                if (ret > 0)
                    events += ret;
                bitpos += 15;
            }
        }
        return events > 0 ? events : ret;
    },
});
const TYREGUARD400_BITS = 88;
function tyreguard400Decode(bits, ctx, row, bitpos) {
    const b = bits.bytes(row, bitpos, TYREGUARD400_BITS);
    if (crc8(b, 11, 0x31, 0xdd) !== 0)
        return DECODE_FAIL_MIC;
    const flags = b[9];
    const id = (((b[3] & 0x0f) << 24) | (b[4] << 16) | (b[5] << 8) | b[6]) >>> 0;
    ctx.emit({
        model: 'TyreGuard400',
        type: 'TPMS',
        id: hexLow(id, 7),
        pressure_kPa: b[7] | ((flags & 0x70) << 4),
        temperature_C: b[8] - 40,
        peering_request: flags & 0x3,
        leaking: flags & 0x3,
        ack_leaking: flags & 0x8,
        mic: 'CRC',
    });
    return 1;
}
export const tpmsTyreguard400 = register({
    num: 225,
    name: 'TyreGuard 400 TPMS',
    what: 'tire pressure sensor: caravan and trailer monitor',
    modulation: 3,
    shortWidth: 100,
    longWidth: 100,
    gapLimit: 0,
    resetLimit: 500,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const sync = new Uint8Array([0xfd, 0x5f, 0xd5, 0xf0]);
        let events = 0, ret = 0;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] < TYREGUARD400_BITS)
                continue;
            let bitpos = 0;
            while ((bitpos = bits.search(row, bitpos, sync, 28)) + TYREGUARD400_BITS <= bits.bitsPerRow[row]) {
                ret = tyreguard400Decode(bits, ctx, row, bitpos);
                if (ret > 0)
                    events += ret;
                bitpos += TYREGUARD400_BITS;
            }
        }
        return events > 0 ? events : ret;
    },
});
function kiaDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    const startPos = bits.manchesterDecode(row, bitpos, packet, 154 - 16);
    if (startPos - bitpos < 154 - 16)
        return DECODE_ABORT_LENGTH;
    const b = packet.bb[0];
    const crc = b[8] & ~0x07;
    if (crc8(b, 8, 0x07, 0x76) !== crc)
        return DECODE_FAIL_MIC;
    const pressure = ((b[0] << 4) | (b[1] >> 4)) & 0xff;
    const temperature = ((b[1] << 4) | (b[2] >> 4)) & 0xff;
    const id = ((b[2] << 28) | (b[3] << 20) | (b[4] << 12) | (b[5] << 4) | (b[6] >> 4)) >>> 0;
    let raw = '';
    for (let i = 0; i < 9; i++)
        raw += hexLow(b[i], 2);
    ctx.emit({
        model: 'Kia',
        type: 'TPMS',
        id: hexLow(id, 8),
        unknown1: hexLow(b[0] >> 4, 2),
        unknown2: hexLow(((b[6] << 8) | b[7]) & 0xff, 3),
        pressure_PSI: round1(pressure / 5),
        temperature_C: temperature - 50,
        raw,
        mic: 'CRC',
    });
    return 1;
}
export const tpmsKia = register({
    num: 226,
    name: 'Kia TPMS',
    what: 'tire pressure sensor: Kia Rio and some Hyundai',
    modulation: 16,
    shortWidth: 50,
    longWidth: 50,
    resetLimit: 200,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xed, 0x71]);
        let bitpos = 0, events = 0, ret = 0;
        while ((bitpos = bits.search(0, bitpos, pre, 16)) + 154 <= bits.bitsPerRow[0]) {
            ret = kiaDecode(bits, ctx, 0, bitpos + 16);
            if (ret > 0)
                events += ret;
            bitpos += 2;
        }
        return events > 0 ? events : ret;
    },
});
function nissanChecksum(b) {
    let chk = 0;
    for (let i = 0; i < 4; i++) {
        chk = (chk + (b[i] >> 7)) & 0xff;
        chk = (chk + (b[i] >> 5)) & 0xff;
        chk = (chk + (b[i] >> 3)) & 0xff;
        chk = (chk + (b[i] >> 1)) & 0xff;
        chk = (chk + ((b[i] << 1) & 0xff)) & 0xff;
    }
    chk = (chk + (b[4] >> 7)) & 0xff;
    chk = (chk + (b[4] >> 5)) & 0xff;
    chk = (chk + (b[4] >> 3)) & 0xff;
    return ~chk & 0x03;
}
function nissanDecode(bits, ctx, row, bitpos) {
    const packet = new BitBuffer();
    bits.manchesterDecode(row, bitpos, packet, 113);
    if (packet.bitsPerRow[0] < 37)
        return DECODE_FAIL_SANITY;
    packet.invert();
    const b = packet.bb[0];
    if (nissanChecksum(b) !== 0)
        return DECODE_FAIL_MIC;
    const id = (((b[0] & 0x1f) << 19) | (b[1] << 11) | (b[2] << 3) | (b[3] >> 5)) >>> 0;
    const pressureRaw = ((b[3] & 0x1f) << 3) | (b[4] >> 5);
    ctx.emit({
        model: 'Nissan',
        type: 'TPMS',
        id: hexLow(id, 6),
        mode: b[0] >> 5,
        pressure_PSI: round1(pressureRaw / 4 - 3),
        unknown: (b[4] & 0x1f) >> 3,
        mic: 'CHECKSUM',
    });
    return 1;
}
export const tpmsNissan = register({
    num: 248,
    name: 'Nissan TPMS',
    what: 'tire pressure sensor',
    modulation: 16,
    shortWidth: 120,
    longWidth: 120,
    resetLimit: 250,
    bands: BANDS,
    decode(_dev, bits, ctx) {
        const pre = new Uint8Array([0xf5, 0x55, 0x55, 0x55, 0xe0]);
        let bitpos = 0, events = 0, ret = 0;
        while ((bitpos = bits.search(0, bitpos, pre, 36)) + 77 <= bits.bitsPerRow[0]) {
            ret = nissanDecode(bits, ctx, 0, bitpos + 36);
            if (ret > 0)
                events += ret;
            bitpos += 1;
        }
        return events > 0 ? events : ret;
    },
});
