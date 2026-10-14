export function reverse8(x) {
    x = ((x & 0xf0) >> 4) | ((x & 0x0f) << 4);
    x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
    x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
    return x & 0xff;
}
export function reflect4(x) {
    x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
    x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
    return x & 0xff;
}
export function reverse32(x) {
    return ((reverse8(x & 0xff) << 24) | (reverse8((x >>> 8) & 0xff) << 16)
        | (reverse8((x >>> 16) & 0xff) << 8) | reverse8(x >>> 24)) >>> 0;
}
export function reflectBytes(m, n = m.length) { for (let i = 0; i < n; i++)
    m[i] = reverse8(m[i]); }
export function reflectNibbles(m, n = m.length) { for (let i = 0; i < n; i++)
    m[i] = reflect4(m[i]); }
export function addBytes(m, n = m.length, at = 0) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += m[at + i];
    return s & 0xff;
}
export function addNibbles(m, n = m.length, at = 0) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s += (m[at + i] >> 4) + (m[at + i] & 0x0f);
    return s & 0xff;
}
export function xorBytes(m, n = m.length, at = 0) {
    let s = 0;
    for (let i = 0; i < n; i++)
        s ^= m[at + i];
    return s & 0xff;
}
export function parity8(b) { let x = (b ^ (b >> 4)) & 0x0f; return (0x6996 >> x) & 1; }
export function parityBytes(m, n = m.length, at = 0) {
    let p = 0;
    for (let i = 0; i < n; i++)
        p ^= parity8(m[at + i]);
    return p;
}
export function crc4(m, n, poly, init, at = 0) {
    let rem = (init << 4) & 0xff;
    const p = (poly << 4) & 0xff;
    for (let i = 0; i < n; i++) {
        rem ^= m[at + i];
        for (let bit = 0; bit < 8; bit++)
            rem = (rem & 0x80) ? (((rem << 1) ^ p) & 0xff) : ((rem << 1) & 0xff);
    }
    return (rem >> 4) & 0x0f;
}
export function crc7(m, n, poly, init, at = 0) {
    let rem = (init << 1) & 0xff;
    const p = (poly << 1) & 0xff;
    for (let i = 0; i < n; i++) {
        rem ^= m[at + i];
        for (let bit = 0; bit < 8; bit++)
            rem = (rem & 0x80) ? (((rem << 1) ^ p) & 0xff) : ((rem << 1) & 0xff);
    }
    return (rem >> 1) & 0x7f;
}
export function crc8(m, n, poly, init, at = 0) {
    let r = init & 0xff;
    for (let byte = 0; byte < n; byte++) {
        r ^= m[at + byte];
        for (let bit = 0; bit < 8; bit++)
            r = (r & 0x80) ? (((r << 1) ^ poly) & 0xff) : ((r << 1) & 0xff);
    }
    return r;
}
export function crc8le(m, n, poly, init, at = 0) {
    let r = reverse8(init);
    const p = reverse8(poly);
    for (let byte = 0; byte < n; byte++) {
        r ^= m[at + byte];
        for (let bit = 0; bit < 8; bit++)
            r = (r & 1) ? ((r >> 1) ^ p) : (r >> 1);
    }
    return r & 0xff;
}
export function crc16(m, n, poly, init, at = 0) {
    let r = init & 0xffff;
    for (let byte = 0; byte < n; byte++) {
        r ^= m[at + byte] << 8;
        for (let bit = 0; bit < 8; bit++)
            r = (r & 0x8000) ? (((r << 1) ^ poly) & 0xffff) : ((r << 1) & 0xffff);
    }
    return r & 0xffff;
}
export function crc16lsb(m, n, poly, init, at = 0) {
    let r = init & 0xffff;
    for (let byte = 0; byte < n; byte++) {
        r ^= m[at + byte];
        for (let bit = 0; bit < 8; bit++)
            r = (r & 1) ? ((r >> 1) ^ poly) & 0xffff : (r >> 1);
    }
    return r & 0xffff;
}
export function lfsrDigest8(m, bytes, gen, key, at = 0) {
    let sum = 0, k = key & 0xff;
    for (let b = 0; b < bytes; b++) {
        const data = m[at + b];
        for (let i = 7; i >= 0; i--) {
            if ((data >> i) & 1)
                sum ^= k;
            k = (k & 1) ? ((k >> 1) ^ gen) & 0xff : (k >> 1);
        }
    }
    return sum & 0xff;
}
export function lfsrDigest8Reverse(m, bytes, gen, key, at = 0) {
    let sum = 0, k = key & 0xff;
    for (let b = bytes - 1; b >= 0; b--) {
        const data = m[at + b];
        for (let i = 7; i >= 0; i--) {
            if ((data >> i) & 1)
                sum ^= k;
            k = (k & 1) ? ((k >> 1) ^ gen) & 0xff : (k >> 1);
        }
    }
    return sum & 0xff;
}
export function lfsrDigest8Reflect(m, bytes, gen, key, at = 0) {
    let sum = 0, k = key & 0xff;
    for (let b = bytes - 1; b >= 0; b--) {
        const data = m[at + b];
        for (let i = 0; i < 8; i++) {
            if ((data >> i) & 1)
                sum ^= k;
            k = (k & 0x80) ? (((k << 1) ^ gen) & 0xff) : ((k << 1) & 0xff);
        }
    }
    return sum & 0xff;
}
export function lfsrDigest16(m, bytes, gen, key, at = 0) {
    let sum = 0, k = key & 0xffff;
    for (let b = 0; b < bytes; b++) {
        const data = m[at + b];
        for (let i = 7; i >= 0; i--) {
            if ((data >> i) & 1)
                sum ^= k;
            k = (k & 1) ? ((k >> 1) ^ gen) & 0xffff : (k >> 1);
        }
    }
    return sum & 0xffff;
}
export function extractNibbles4b1s(m, offsetBits, numBits, dst) {
    let ret = 0, off = offsetBits, n = numBits;
    while (n >= 5) {
        const bits = ((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (11 - (off % 8));
        if ((bits & 1) !== 1)
            break;
        dst[ret++] = (bits >> 1) & 0x0f;
        off += 5;
        n -= 5;
    }
    return ret;
}
export function ibmWhitening(m, n = m.length) {
    let msb = 0x01, lsb = 0xff;
    for (let i = 0; i < n; i++) {
        m[i] ^= lsb;
        for (let r = 0; r < 8; r++) {
            const prev = msb;
            msb = (lsb & 0x01) ^ ((lsb >> 5) & 0x01);
            lsb = ((lsb >> 1) & 0xff) | ((prev << 7) & 0x80);
        }
    }
}
export function extractBytesUart8n1(m, offsetBits, numBits, dst) {
    let ret = 0, off = offsetBits, n = numBits;
    while (n >= 10) {
        const startb = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        let datab = m[off >> 3];
        if (off % 8)
            datab = (((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (8 - (off % 8)));
        off += 8;
        const stopb = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        if ((startb & 1) !== 0)
            break;
        if ((stopb & 1) !== 1)
            break;
        dst[ret++] = reverse8(datab & 0xff);
        n -= 10;
    }
    return ret;
}
export function extractBytesUart8n2(m, offsetBits, numBits, dst) {
    let ret = 0, off = offsetBits, n = numBits;
    while (n > 11) {
        if (((m[off >> 3] >> (7 - (off % 8))) & 1) === 0)
            break;
        off += 1;
        n -= 1;
    }
    while (n >= 11) {
        const startb = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        let datab = m[off >> 3];
        if (off % 8)
            datab = (((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (8 - (off % 8)));
        off += 8;
        const stopb1 = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        const stopb2 = m[off >> 3] >> (7 - (off % 8));
        off += 1;
        if ((startb & 1) !== 0)
            break;
        if ((stopb1 & 1) !== 1)
            break;
        if ((stopb2 & 1) !== 1)
            break;
        dst[ret++] = reverse8(datab & 0xff);
        n -= 11;
        if (ret >= dst.length)
            break;
    }
    return ret;
}
