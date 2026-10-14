function flip8(v) { let r = 0; let x = v & 0xFF; for (let i = 0; i < 8; i++) {
    r = (r << 1) | (x & 1);
    x >>>= 1;
} return r; }
function flip16(v) { let r = 0; let x = v & 0xFFFF; for (let i = 0; i < 16; i++) {
    r = (r << 1) | (x & 1);
    x >>>= 1;
} return r; }
function mdcCrc(cw, len) {
    let crc = 0;
    for (let i = 0; i < len; i++) {
        const c = flip8(cw[i]);
        for (let j = 0x80; j !== 0; j >>>= 1) {
            let bit = crc & 0x8000;
            crc = (crc << 1) & 0xFFFF;
            if (c & j)
                bit ^= 0x8000;
            if (bit)
                crc ^= 0x1021;
        }
    }
    return (flip16(crc) ^ 0xFFFF) & 0xFFFF;
}
function packMdc(cw) {
    const crc = mdcCrc(cw, 4);
    cw[4] = crc & 0xFF;
    cw[5] = (crc >> 8) & 0xFF;
    cw[6] = 0;
    const csr = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 7; i++) {
        cw[i + 7] = 0;
        for (let j = 0; j <= 7; j++) {
            for (let k = 6; k > 0; k--)
                csr[k] = csr[k - 1];
            csr[0] = (cw[i] >> j) & 1;
            const b = csr[0] + csr[2] + csr[5] + csr[6];
            cw[i + 7] |= (b & 1) << j;
        }
    }
    const bits = new Array(112).fill(0);
    let l = 0, m = 0;
    for (let i = 0; i < 14; i++)
        for (let j = 0; j <= 7; j++) {
            bits[l] = (cw[i] >> j) & 1;
            l += 16;
            if (l > 111) {
                m++;
                l = m;
            }
        }
    l = 0;
    for (let i = 0; i < 14; i++) {
        cw[i] = 0;
        for (let j = 7; j >= 0; j--) {
            if (bits[l])
                cw[i] |= 1 << j;
            l++;
        }
    }
}
export function mdcPacket(op, arg, unitId) {
    const out = [];
    for (let r = 0; r < 3; r++)
        for (const b of [0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA])
            out.push(b);
    for (const b of [0x07, 0x09, 0x2A, 0x44, 0x6F])
        out.push(b);
    const cw = new Array(14).fill(0);
    cw[0] = op & 0xFF;
    cw[1] = arg & 0xFF;
    cw[2] = (unitId >>> 8) & 0xFF;
    cw[3] = unitId & 0xFF;
    packMdc(cw);
    for (const v of cw)
        out.push(v & 0xFF);
    return out;
}
export function hopList(lowHz, highHz, count) {
    const span = Math.max(1, highHz - lowHz);
    return Array.from({ length: count }, () => lowHz + Math.floor(Math.random() * span));
}
export function noiseBits(count) {
    return Array.from({ length: count }, () => Math.random() < 0.5);
}
function manchester(bits, halfUs, rate) {
    const t = Math.max(1, Math.round(halfUs * rate / 1000000));
    const out = [];
    for (const b of bits) {
        out.push([b === 1, t]);
        out.push([b === 1 ? false : true, t]);
    }
    return out;
}
const TESLA_HALF_US = 400;
const TESLA_MSG = [0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1];
export function teslaPulses(rate, repeats = 5) {
    const one = manchester(TESLA_MSG, TESLA_HALF_US, rate);
    const gap = [false, Math.round(23000 * rate / 1000000)];
    const out = [];
    for (let r = 0; r < repeats; r++) {
        out.push(...one);
        out.push(gap);
    }
    return out;
}
const NOTE = (() => {
    const base = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
    const m = { '0': 0 };
    for (let oct = 2; oct <= 7; oct++)
        for (const [n, s] of Object.entries(base))
            m[n + oct] = Math.round(440 * 2 ** (s / 12 + (oct - 4)));
    return m;
})();
const TUNES = {
    siren: Array.from({ length: 12 }, (_, i) => [i % 2 ? 'A5' : 'E5', 2]),
    joy: [['E5', 1], ['E5', 1], ['F5', 1], ['G5', 1], ['G5', 1], ['F5', 1], ['E5', 1], ['D5', 1], ['C5', 1], ['C5', 1], ['D5', 1], ['E5', 1], ['E5', 2], ['D5', 1], ['D5', 2], ['0', 1]],
    chime: [['E5', 2], ['C5', 2], ['D5', 2], ['G4', 3], ['0', 1], ['G4', 2], ['D5', 2], ['E5', 2], ['C5', 3]],
    imperial: [['G4', 2], ['G4', 2], ['G4', 2], ['D#4', 1], ['A#4', 1], ['G4', 2], ['D#4', 1], ['A#4', 1], ['G4', 3], ['0', 1]],
    rick: [['C#5', 1], ['D#5', 1], ['0', 1], ['D#5', 1], ['0', 1], ['F5', 1], ['F5', 1], ['D#5', 1], ['C#5', 1], ['C#5', 1], ['C#5', 1], ['A#4', 2], ['0', 1]],
};
export function tuneNames() { return Object.keys(TUNES); }
export function melody(name) {
    const t = TUNES[name] ?? TUNES.siren;
    const out = [];
    for (const [note, beats] of t)
        for (let i = 0; i < beats; i++)
            out.push(NOTE[note] ?? 0);
    return out;
}
export function deBruijn(n) {
    const a = new Array(n * 2).fill(0);
    const seq = [];
    const db = (t, p) => {
        if (t > n) {
            if (n % p === 0)
                for (let i = 1; i <= p; i++)
                    seq.push(a[i]);
            return;
        }
        a[t] = a[t - p];
        db(t + 1, p);
        for (let j = a[t - p] + 1; j < 2; j++) {
            a[t] = j;
            db(t + 1, t);
        }
    };
    db(1, 1);
    return seq.concat(seq.slice(0, n - 1));
}
export function adsbFrame(icao, meLo, meHi) {
    const f = new Uint8Array(14);
    f[0] = 0x8D;
    f[1] = (icao >>> 16) & 0xFF;
    f[2] = (icao >>> 8) & 0xFF;
    f[3] = icao & 0xFF;
    f[4] = (meHi >>> 16) & 0xFF;
    f[5] = (meHi >>> 8) & 0xFF;
    f[6] = meHi & 0xFF;
    f[7] = (meLo >>> 24) & 0xFF;
    f[8] = (meLo >>> 16) & 0xFF;
    f[9] = (meLo >>> 8) & 0xFF;
    f[10] = meLo & 0xFF;
    let rem = 0;
    for (let i = 0; i < 11; i++)
        rem ^= f[i] << 16;
    for (let i = 0; i < 88; i++) {
        if (rem & 0x800000)
            rem = (rem << 1) ^ 0xFFF409;
        else
            rem <<= 1;
    }
    const crc = rem & 0xFFFFFF;
    f[11] = (crc >>> 16) & 0xFF;
    f[12] = (crc >>> 8) & 0xFF;
    f[13] = crc & 0xFF;
    return f;
}
export function adsbSymbols(frame) {
    const out = new Array(16 + frame.length * 8 * 2).fill(false);
    for (const p of [0, 2, 7, 9])
        out[p] = true;
    let idx = 16;
    for (const b of frame)
        for (let i = 7; i >= 0; i--) {
            const bit = (b >>> i) & 1;
            if (bit === 1) {
                out[idx] = true;
                out[idx + 1] = false;
            }
            else {
                out[idx] = false;
                out[idx + 1] = true;
            }
            idx += 2;
        }
    return out;
}
export function parseSubFile(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith('RAW_Data:'))
            continue;
        for (const tok of line.substring(9).trim().split(/\s+/)) {
            const n = parseInt(tok, 10);
            if (Number.isNaN(n))
                continue;
            out.push([n > 0, Math.abs(n)]);
        }
    }
    return out;
}
const KEELOQ_NLF = 0x3A5C742E;
export function keeloqEncrypt(plain, key) {
    let v = BigInt(plain >>> 0);
    let k = key & ((1n << 64n) - 1n);
    for (let r = 0; r < 528; r++) {
        const nlfIn = Number(((v >> 1n) & 1n) << 4n | ((v >> 9n) & 1n) << 3n | ((v >> 20n) & 1n) << 2n | ((v >> 26n) & 1n) << 1n | ((v >> 31n) & 1n));
        const nlf = BigInt((KEELOQ_NLF >>> nlfIn) & 1);
        const bit = ((v >> 0n) & 1n) ^ ((v >> 16n) & 1n) ^ (k & 1n) ^ nlf;
        v = ((v >> 1n) | (bit << 31n)) & 0xffffffffn;
        k = ((k >> 1n) | ((k & 1n) << 63n)) & ((1n << 64n) - 1n);
    }
    return Number(v);
}
export function keeloqFrame(encrypted, serial, button, vLow, repeat) {
    const bits = [];
    for (let i = 0; i < 32; i++)
        bits.push(((encrypted >>> i) & 1) === 1);
    for (let i = 0; i < 28; i++)
        bits.push(((serial >>> i) & 1) === 1);
    for (let i = 0; i < 4; i++)
        bits.push(((button >>> i) & 1) === 1);
    bits.push(vLow);
    bits.push(repeat);
    return bits;
}
