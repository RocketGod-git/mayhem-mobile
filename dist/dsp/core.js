export function popcount32(x) {
    x = x >>> 0;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export class DiscFilter {
    constructor(cutoffHz, rate, dcHz = 40) {
        this.dcX = 0;
        this.dcY = 0;
        this.bq = [];
        this.dcA = Math.exp(-2 * Math.PI * dcHz / rate);
        for (const q of [0.5412, 1.3066]) {
            const w0 = 2 * Math.PI * Math.min(0.45 * rate, cutoffHz) / rate, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0), a0 = 1 + alpha;
            this.bq.push({ b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 });
        }
    }
    push(x) {
        const y = x - this.dcX + this.dcA * this.dcY;
        this.dcX = x;
        this.dcY = y;
        let v = y;
        for (const s of this.bq) {
            const o = s.b0 * v + s.z1;
            s.z1 = s.b1 * v - s.a1 * o + s.z2;
            s.z2 = s.b2 * v - s.a2 * o;
            v = o;
        }
        return v;
    }
}
export class BitSync {
    constructor(baud, rate) {
        this.phase = 0;
        this.acc = 0;
        this.lastPos = false;
        this.first = true;
        this.inc = baud / rate;
    }
    push(x) {
        const pos = x > 0;
        if (!this.first && pos !== this.lastPos) {
            const err = this.phase < 0.5 ? this.phase : this.phase - 1;
            this.phase -= err * 0.25;
        }
        this.first = false;
        this.lastPos = pos;
        this.acc += x;
        this.phase += this.inc;
        if (this.phase >= 1) {
            this.phase -= 1;
            const bit = this.acc > 0 ? 1 : 0;
            this.acc = 0;
            return bit;
        }
        return -1;
    }
    reset() { this.phase = 0; this.acc = 0; this.first = true; }
}
export class BitReader {
    constructor(b) {
        this.b = b;
    }
    get bitCount() { return this.b.length * 8; }
    read(start, len) {
        let v = 0;
        for (let i = 0; i < len; i++) {
            const k = start + i;
            const bit = k < this.bitCount ? (this.b[k >> 3] >> (k & 7)) & 1 : 0;
            v = (v * 2) + bit;
        }
        return v;
    }
    readSigned(start, len) {
        const v = this.read(start, len);
        return v >= 2 ** (len - 1) ? v - 2 ** len : v;
    }
}
export class HdlcFramer {
    constructor(maxBytes, onFrame) {
        this.maxBytes = maxBytes;
        this.onFrame = onFrame;
        this.lastBit = 0;
        this.ones = 0;
        this.cur = 0;
        this.bitIdx = 0;
        this.size = 0;
        this.inFrame = false;
        this.buf = new Uint8Array(maxBytes);
    }
    reset() { this.lastBit = 0; this.abort(); }
    pushRaw(bit) {
        const dec = bit === this.lastBit ? 1 : 0;
        this.lastBit = bit;
        this.pushDecoded(dec);
    }
    pushDecoded(bit) {
        if (bit === 1) {
            if (this.ones < 8)
                this.ones++;
        }
        else {
            if (this.ones > 6) {
                this.abort();
                return;
            }
            if (this.ones === 6) {
                if (this.inFrame && this.size >= 3)
                    this.onFrame(this.buf.slice(0, this.size));
                this.inFrame = true;
                this.size = 0;
                this.cur = 0;
                this.bitIdx = 0;
                this.ones = 0;
                return;
            }
            if (this.ones === 5) {
                this.ones = 0;
                return;
            }
            this.ones = 0;
        }
        if (!this.inFrame)
            return;
        this.cur = (this.cur >> 1) | (bit << 7);
        if (++this.bitIdx >= 8) {
            this.bitIdx = 0;
            if (this.size >= this.maxBytes) {
                this.abort();
                return;
            }
            this.buf[this.size++] = this.cur;
            this.cur = 0;
        }
    }
    abort() { this.inFrame = false; this.size = 0; this.cur = 0; this.bitIdx = 0; this.ones = 0; }
    static fcsOk(f) {
        let crc = 0xFFFF;
        for (const x of f) {
            crc ^= x;
            for (let i = 0; i < 8; i++)
                crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
        }
        return crc === 0xF0B8;
    }
}
export function fmt(n, digits) { return n.toFixed(digits); }
export function pad(s, w) { return String(s).padStart(w, ' '); }
export function padEnd(s, w) { return String(s).padEnd(w, ' '); }
