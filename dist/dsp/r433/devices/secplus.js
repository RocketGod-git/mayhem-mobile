import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_SANITY, register, } from '../device.js';
import { reverse32 } from '../util.js';
const CACHE_MS = 800;
export const secplusClock = { now: () => Date.now() };
export function secplusResetCache() {
    v1Held = null;
    v2Held1 = null;
    v2Held2 = null;
    v1HeldAt = 0;
    v2HeldAt = 0;
}
let v1Held = null;
let v1HeldAt = 0;
const V1_PRE_A = new Uint8Array([0x02]);
const V1_PRE_B = new Uint8Array([0x07]);
function v1DecodeHalf(src, out) {
    let n = 0, run = 0;
    for (let i = 0; i < 11; i++) {
        for (let j = 0; j < 8; j++) {
            if ((src[i] << j) & 0x80) {
                run++;
                continue;
            }
            if (run === 0)
                continue;
            if (run > 3)
                return -1;
            out[n++] = run - 1;
            run = 0;
        }
    }
    return out[0];
}
function v1FindNext(bits, from) {
    const head = bits.bb[0][0];
    if (from === 0 && ((head & 0xf0) === 0x10 || (head & 0xf0) === 0x70))
        return 0;
    if (from === 0 && ((head & 0xe0) === 0xe0 || (head & 0xc0) === 0x80))
        return 0;
    const a = bits.search(0, from, V1_PRE_A, 8) + 3;
    const b = bits.search(0, from, V1_PRE_B, 8) + 3;
    return a < b ? a : b;
}
function v1Accumulate(digits, state) {
    let acc = 0;
    for (let i = 0; i < 20; i += 2) {
        const a = digits[1 + i];
        state.rolling = state.rolling * 3 + a;
        acc += a;
        const b = (60 + digits[2 + i] - acc) % 3;
        state.fixed = state.fixed * 3 + b;
        acc += b;
    }
}
export const secplusV1 = register({
    num: 178,
    name: 'Security+ (Keyfob)',
    what: 'garage door opener',
    modulation: 4,
    shortWidth: 500,
    longWidth: 500,
    tolerance: 20,
    gapLimit: 15000,
    resetLimit: 80000,
    bands: [310000000, 315000000, 390000000],
    decode(_dev, bits, ctx) {
        const n = bits.bitsPerRow[0];
        if (n < 84 || n > 130)
            return DECODE_ABORT_LENGTH;
        let first = null;
        let second = null;
        let at = 0;
        while (at < n && !first && !second) {
            at = v1FindNext(bits, at);
            if (at < 0 || at + 84 > n)
                break;
            const out = new Uint8Array(44);
            const which = v1DecodeHalf(bits.bytes(0, at, 84), out);
            if (which < 0 || which === 1) {
                at += 4;
                continue;
            }
            if (which === 0) {
                first = out.slice(0, 22);
                at += 88;
            }
            else if (which === 2) {
                second = out.slice(0, 22);
                at += 88;
            }
        }
        if (!first && !second)
            return DECODE_ABORT_EARLY;
        if (v1HeldAt) {
            if (secplusClock.now() - v1HeldAt < CACHE_MS && v1Held) {
                if (second && v1Held.part === 0)
                    first = v1Held.digits;
                else if (first && v1Held.part === 2)
                    second = v1Held.digits;
            }
            v1Held = null;
            v1HeldAt = 0;
        }
        if (!first || !second) {
            v1Held = first ? { part: 0, digits: first } : { part: 2, digits: second };
            v1HeldAt = secplusClock.now();
            return DECODE_ABORT_EARLY;
        }
        const state = { rolling: 0, fixed: 0 };
        v1Accumulate(first, state);
        v1Accumulate(second, state);
        const rolling = reverse32(state.rolling);
        const fixed = state.fixed;
        const switchId = fixed % 3;
        const id0 = Math.floor(fixed / 3) % 3;
        const id1 = Math.floor(fixed / 9) % 3;
        const data = {
            model: 'Secplus-v1',
            type: 'Remote',
            id0,
            id1,
            switch_id: switchId,
            fixed: String(fixed),
            rolling: String(rolling),
        };
        if (id1 === 0) {
            const padId = Math.floor(fixed / 27) % 2187;
            const pin = Math.floor(fixed / 59049) % 19683;
            let pinStr = '';
            if (pin >= 0 && pin <= 9999)
                pinStr = String(pin).padStart(4, '0');
            else if (pin >= 10000 && pin <= 11029)
                pinStr = 'enter';
            const suffix = Math.floor(fixed / 1162261467) % 3;
            if (suffix === 1)
                pinStr += '#';
            else if (suffix === 2)
                pinStr += '*';
            data.id = padId;
            if (padId)
                data.pad_id = padId;
            if (pin)
                data.pin = pinStr;
        }
        else {
            const remoteId = Math.floor(fixed / 27);
            data.id = remoteId;
            if (remoteId) {
                data.remote_id = remoteId;
                data.button_id = switchId === 1 ? 'left' : switchId === 0 ? 'middle' : 'right';
            }
        }
        ctx.emit(data);
        return 1;
    },
});
let v2Held1 = null;
let v2Held2 = null;
let v2HeldAt = 0;
const V2_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0x95, 0x60]);
const V2_INVERT = {
    0x0: [true, true, false],
    0x1: [false, true, false],
    0x2: [false, false, true],
    0x4: [true, true, true],
    0x5: [true, false, true],
    0x6: [false, true, true],
    0x8: [true, false, false],
    0x9: [false, false, false],
    0xa: [true, false, true],
};
const V2_ORDER = {
    0x0: [0, 2, 1],
    0x1: [2, 0, 1],
    0x2: [0, 1, 2],
    0x4: [1, 2, 0],
    0x5: [1, 0, 2],
    0x6: [2, 1, 0],
    0x8: [1, 2, 0],
    0x9: [2, 1, 0],
    0xa: [0, 1, 2],
};
export function secplusPermute(orderInvert, x30, roll) {
    const inv = V2_INVERT[orderInvert & 0x0f];
    const ord = V2_ORDER[orderInvert >> 4];
    if (!inv || !ord)
        return null;
    let x = x30 >>> 0;
    let p0 = 0, p1 = 0, p2 = 0;
    for (let i = 0; i < 10; i++) {
        p2 ^= (x & 1) << i;
        x >>>= 1;
        p1 ^= (x & 1) << i;
        x >>>= 1;
        p0 ^= (x & 1) << i;
        x >>>= 1;
    }
    if (inv[0])
        p0 = ~p0 & 0x3ff;
    if (inv[1])
        p1 = ~p1 & 0x3ff;
    if (inv[2])
        p2 = ~p2 & 0x3ff;
    const groups = [p0, p1, p2];
    p0 = groups[ord.indexOf(0)];
    p1 = groups[ord.indexOf(1)];
    p2 = groups[ord.indexOf(2)];
    let k = 0;
    for (let i = 6; i >= 0; i -= 2)
        roll[k++] = (orderInvert >> i) & 0x03;
    for (let i = 8; i >= 0; i -= 2)
        roll[k++] = (p2 >> i) & 0x03;
    for (let i = 0; i < 9; i++)
        if (roll[i] === 3)
            return null;
    return { p0, p1, p2 };
}
function v2DecodeHalf(packet, roll) {
    const head = packet.bytes(0, 4, 8);
    const raw = packet.bytes(0, 12, 30);
    const x = (((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0) >>> 2;
    const g = secplusPermute(head[0], x, roll);
    if (!g)
        return null;
    const fixed = new Uint8Array(3);
    let bi = 0;
    const put = (v) => { if (v)
        fixed[bi >> 3] |= 0x80 >> (bi & 7); bi++; };
    for (let i = 9; i >= 0; i--)
        put((g.p0 >> i) & 1);
    for (let i = 9; i >= 0; i--)
        put((g.p1 >> i) & 1);
    return fixed;
}
export const secplusV2 = register({
    num: 164,
    name: 'Security+ 2.0 (Keyfob)',
    what: 'garage door opener',
    modulation: 4,
    shortWidth: 250,
    longWidth: 250,
    tolerance: 50,
    gapLimit: 1500,
    resetLimit: 9000,
    bands: [310000000, 315000000, 390000000],
    decode(_dev, bits, ctx) {
        let half1 = null;
        let half2 = null;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] < 110)
                continue;
            const at = bits.search(row, 0, V2_PREAMBLE, 28);
            if (at >= bits.bitsPerRow[row])
                break;
            const packet = new BitBuffer();
            bits.manchesterDecode(row, at + 26, packet, 80);
            if (packet.bitsPerRow[0] < 42)
                continue;
            const head = packet.bb[0][0];
            if (head & 0xb0)
                continue;
            const roll = new Uint8Array(16);
            const fixed = v2DecodeHalf(packet, roll);
            if (!fixed)
                continue;
            if (head & 0xc0)
                half2 = { fixed, roll };
            else
                half1 = { fixed, roll };
            if (half1 && half2)
                break;
        }
        if (!half1 && !half2)
            return DECODE_ABORT_EARLY;
        if (!half1 || !half2) {
            const fresh = v2HeldAt && secplusClock.now() - v2HeldAt < CACHE_MS;
            if (half1)
                v2Held1 = half1;
            else
                v2Held2 = half2;
            v2HeldAt = secplusClock.now();
            if (fresh && v2Held1 && v2Held2) {
                half1 = v2Held1;
                half2 = v2Held2;
                v2Held1 = null;
                v2Held2 = null;
                v2HeldAt = 0;
            }
            else {
                if (!fresh) {
                    if (half1)
                        v2Held2 = null;
                    else
                        v2Held1 = null;
                }
                return DECODE_ABORT_EARLY;
            }
        }
        else {
            v2Held1 = null;
            v2Held2 = null;
            v2HeldAt = 0;
        }
        const digits = [half2.roll[8], half1.roll[8]];
        for (let i = 4; i < 8; i++)
            digits.push(half2.roll[i]);
        for (let i = 4; i < 8; i++)
            digits.push(half1.roll[i]);
        for (let i = 0; i < 4; i++)
            digits.push(half2.roll[i]);
        for (let i = 0; i < 4; i++)
            digits.push(half1.roll[i]);
        let rollingTemp = 0;
        for (let i = 0; i < 18; i++)
            rollingTemp = rollingTemp * 3 + digits[i];
        if (rollingTemp >= 0x10000000)
            return DECODE_FAIL_SANITY;
        const rolling = reverse32(rollingTemp) >>> 4;
        const f1 = half1.fixed, f2 = half2.fixed;
        const fixedTotal = f1[0] * 4294967296 + f1[1] * 16777216 + (f1[2] & 0xf0) * 65536
            + f2[0] * 4096 + f2[1] * 16 + ((f2[2] >> 4) & 0x0f);
        ctx.emit({
            model: 'Secplus-v2',
            type: 'Remote',
            id: fixedTotal % 4294967296,
            button_id: Math.floor(fixedTotal / 4294967296),
            remote_id: fixedTotal % 4294967296,
            fixed: String(fixedTotal),
            rolling: String(rolling),
        });
        return 1;
    },
});
