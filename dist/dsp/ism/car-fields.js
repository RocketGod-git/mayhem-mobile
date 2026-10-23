import { C } from './base.js';
const NAMES = {
    [C.SUZUKI]: 'Suzuki', [C.VW]: 'VW', [C.SUBARU]: 'Subaru', [C.KIA_V5]: 'Kia V5', [C.KIA_V3V4]: 'Kia V3/V4', [C.KIA_V2]: 'Kia V2',
    [C.KIA_V1]: 'Kia V1', [C.KIA_V0]: 'Kia V0', [C.FORD_V0]: 'Ford V0', [C.FIAT_V0]: 'Fiat V0', [C.BMW_V0]: 'BMW V0',
};
export function carName(type) { return NAMES[type] ?? 'Unknown'; }
const M32 = 0xffffffffn;
const u32 = (v) => v & M32;
const i32 = (v) => Number(v & M32) | 0;
const byte = (v, shift) => Number((v >> BigInt(shift)) & 0xffn);
function subaruDecodeCount(kb) {
    let lo = 0;
    if ((kb[4] & 0x40) === 0)
        lo |= 0x01;
    if ((kb[4] & 0x80) === 0)
        lo |= 0x02;
    if ((kb[5] & 0x01) === 0)
        lo |= 0x04;
    if ((kb[5] & 0x02) === 0)
        lo |= 0x08;
    if ((kb[6] & 0x01) === 0)
        lo |= 0x10;
    if ((kb[6] & 0x02) === 0)
        lo |= 0x20;
    if ((kb[5] & 0x40) === 0)
        lo |= 0x40;
    if ((kb[5] & 0x80) === 0)
        lo |= 0x80;
    let regSh1 = (kb[7] << 4) & 0xF0;
    if (kb[5] & 0x04)
        regSh1 |= 0x04;
    if (kb[5] & 0x08)
        regSh1 |= 0x08;
    if (kb[6] & 0x80)
        regSh1 |= 0x02;
    if (kb[6] & 0x40)
        regSh1 |= 0x01;
    const regSh2 = ((kb[6] << 2) & 0xF0) | ((kb[7] >>> 4) & 0x0F);
    let ser0 = kb[3];
    let ser1 = kb[1];
    let ser2 = kb[2];
    const totalRot = (4 + lo) & 0xFF;
    for (let i = 0; i < totalRot; i++) {
        const tBit = (ser0 >>> 7) & 1;
        ser0 = ((ser0 << 1) & 0xFE) | ((ser1 >>> 7) & 1);
        ser1 = ((ser1 << 1) & 0xFE) | ((ser2 >>> 7) & 1);
        ser2 = ((ser2 << 1) & 0xFE) | tBit;
    }
    const t1 = ser1 ^ regSh1;
    const t2 = ser2 ^ regSh2;
    let hi = 0;
    if ((t1 & 0x10) === 0)
        hi |= 0x04;
    if ((t1 & 0x20) === 0)
        hi |= 0x08;
    if ((t2 & 0x80) === 0)
        hi |= 0x02;
    if ((t2 & 0x40) === 0)
        hi |= 0x01;
    if ((t1 & 0x01) === 0)
        hi |= 0x40;
    if ((t1 & 0x02) === 0)
        hi |= 0x80;
    if ((t2 & 0x08) === 0)
        hi |= 0x20;
    if ((t2 & 0x04) === 0)
        hi |= 0x10;
    return ((hi << 8) | lo) & 0xFFFF;
}
const KIA_V5_KEYSTORE = [0x53, 0x54, 0x46, 0x52, 0x4b, 0x45, 0x30, 0x30];
function kiaV5Count(encrypted) {
    let s0 = byte(encrypted, 0);
    let s1 = byte(encrypted, 8);
    let s2 = byte(encrypted, 16);
    let s3 = byte(encrypted, 24);
    let roundIndex = 1;
    for (let i = 0; i < 18; i++) {
        let r = KIA_V5_KEYSTORE[roundIndex] & 0xFF;
        let steps = 8;
        while (steps > 0) {
            let base = (s3 & 0x40) === 0 ? ((s3 & 0x02) === 0 ? 0x74 : 0x2E) : ((s3 & 0x02) === 0 ? 0x3A : 0x5C);
            if (s2 & 0x08)
                base = (((base >>> 4) & 0x0F) | ((base & 0x0F) << 4)) & 0xFF;
            if (s1 & 0x01)
                base = ((base & 0x3F) << 2) & 0xFF;
            if (s0 & 0x01)
                base = (base << 1) & 0xFF;
            const temp = (s3 ^ s1) & 0xFF;
            s3 = ((s3 & 0x7F) << 1) & 0xFF;
            if (s2 & 0x80)
                s3 |= 0x01;
            s2 = ((s2 & 0x7F) << 1) & 0xFF;
            if (s1 & 0x80)
                s2 |= 0x01;
            s1 = ((s1 & 0x7F) << 1) & 0xFF;
            if (s0 & 0x80)
                s1 |= 0x01;
            s0 = ((s0 & 0x7F) << 1) & 0xFF;
            const chk = (base ^ (r ^ temp)) & 0xFF;
            if (chk & 0x80)
                s0 |= 0x01;
            r = ((r & 0x7F) << 1) & 0xFF;
            steps--;
        }
        roundIndex = (roundIndex - 1) & 0x7;
    }
    return (s0 + (s1 << 8)) & 0xFFFF;
}
export function parseCar(type, data, data2, _bits) {
    const name = carName(type);
    let serial = 0n;
    let btn = '';
    let cnt = null;
    switch (type) {
        case C.SUZUKI: {
            const dataHigh = u32(data >> 32n);
            const dataLow = u32(data);
            serial = u32(((dataHigh & 0xfffn) << 16n) | (dataLow >> 16n));
            const buttonId = Number((dataLow >> 12n) & 0xfn);
            cnt = Number(u32(dataHigh << 4n) >> 16n);
            btn = String(buttonId);
            break;
        }
        case C.VW: {
            serial = u32(data);
            const check = Number(data2 & 0xffn);
            switch ((check >>> 4) & 0xF) {
                case 0x1:
                    btn = 'UNLOCK';
                    break;
                case 0x2:
                    btn = 'LOCK';
                    break;
                case 0x3:
                    btn = 'Un+Lk';
                    break;
                case 0x4:
                    btn = 'TRUNK';
                    break;
                case 0x5:
                    btn = 'Un+Tr';
                    break;
                case 0x6:
                    btn = 'Lk+Tr';
                    break;
                case 0x7:
                    btn = 'Un+Lk+Tr';
                    break;
                case 0x8:
                    btn = 'PANIC';
                    break;
                default:
                    btn = 'Unknown';
                    break;
            }
            break;
        }
        case C.SUBARU: {
            const b = [];
            for (let i = 0; i < 8; i++)
                b.push(byte(data, i * 8));
            serial = (BigInt(b[1]) << 16n) | (BigInt(b[2]) << 8n) | BigInt(b[3]);
            btn = String(b[0] & 0x0F);
            cnt = subaruDecodeCount(b);
            break;
        }
        case C.KIA_V5: {
            let yek = 0n;
            for (let i = 0; i < 8; i++) {
                const bt = byte(data2, i * 8);
                let reversed = 0;
                for (let bb = 0; bb < 8; bb++)
                    if (bt & (1 << bb))
                        reversed |= (1 << (7 - bb));
                yek |= BigInt(reversed) << BigInt((7 - i) * 8);
            }
            serial = (yek >> 32n) & 0x0fffffffn;
            btn = String(Number((yek >> 60n) & 0x0fn));
            cnt = kiaV5Count(u32(yek));
            break;
        }
        case C.KIA_V3V4:
            serial = u32(data);
            btn = '?';
            break;
        case C.KIA_V2: {
            serial = u32(data >> 20n);
            const button = Number((data >> 16n) & 0x0fn);
            const rawCount = Number((data >> 4n) & 0xfffn);
            cnt = ((rawCount >>> 4) | (rawCount << 8)) & 0xFFF;
            btn = String(button);
            break;
        }
        case C.KIA_V1: {
            serial = u32(data >> 24n);
            const button = Number((data >> 16n) & 0xffn);
            cnt = (Number((data >> 4n) & 0xfn) << 8) | Number((data >> 8n) & 0xffn);
            btn = String(button);
            break;
        }
        case C.KIA_V0:
        case C.BMW_V0: {
            serial = (data >> 12n) & 0x0fffffffn;
            const button = Number((data >> 8n) & 0x0fn);
            cnt = Number((data >> 40n) & 0xffffn);
            btn = String(button);
            break;
        }
        case C.FORD_V0: {
            const buf = new Array(13).fill(0);
            for (let i = 0; i < 8; i++)
                buf[i] = byte(data, 56 - i * 8);
            buf[8] = byte(data2, 8);
            buf[9] = Number(data2 & 0xffn);
            let tmp = buf[8];
            let parity = 0;
            const parityAny = tmp !== 0;
            while (tmp) {
                parity ^= (tmp & 1);
                tmp >>>= 1;
            }
            buf[11] = parityAny ? parity : 0;
            let xorByte;
            let limit;
            if (buf[11]) {
                xorByte = buf[7];
                limit = 7;
            }
            else {
                xorByte = buf[6];
                limit = 6;
            }
            for (let idx = 1; idx < limit; idx++)
                buf[idx] ^= xorByte;
            if (buf[11] === 0)
                buf[7] ^= xorByte;
            const origB7 = buf[7];
            buf[7] = (origB7 & 0xAA) | (buf[6] & 0x55);
            const mixed = (buf[6] & 0xAA) | (origB7 & 0x55);
            buf[12] = mixed;
            buf[6] = mixed;
            const serialLe = BigInt(buf[1]) | (BigInt(buf[2]) << 8n) | (BigInt(buf[3]) << 16n) | (BigInt(buf[4]) << 24n);
            serial = ((serialLe & 0xffn) << 24n) | (((serialLe >> 8n) & 0xffn) << 16n) | (((serialLe >> 16n) & 0xffn) << 8n) | ((serialLe >> 24n) & 0xffn);
            const button = (buf[5] >>> 4) & 0x0F;
            cnt = ((buf[5] & 0x0F) << 16) | (buf[6] << 8) | buf[7];
            btn = String(button);
            break;
        }
        case C.FIAT_V0:
            serial = u32(data);
            cnt = i32(data >> 32n);
            btn = String(Number(data2 & 0xffn));
            break;
        default: break;
    }
    return { name, serial, btn, cnt, extra: [] };
}
