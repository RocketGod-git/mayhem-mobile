import { BitSync, DiscFilter } from './core.js';
export const GEOSCAN_SATS = [
    [64880, 435970000, 'Geoscan-1'],
    [64890, 436040000, 'Geoscan-2'],
    [64893, 436110000, 'Geoscan-3'],
    [64892, 436180000, 'Geoscan-4'],
    [64891, 436250000, 'Geoscan-5'],
    [64879, 436320000, 'Geoscan-6'],
];
const SYNC = 0x930b51de;
const FRAME = 74;
const MARKER_IMG = 0x0001, CMD_START = 0x0901, CMD_FRAME = 0x0905;
const popcount = (x) => { let c = 0; x >>>= 0; while (x) {
    x &= x - 1;
    c++;
} return c; };
function pn9(buf, len) {
    let reg = 0x1ff;
    for (let i = 0; i < len; i++) {
        let sb = 0;
        for (let k = 0; k < 8; k++) {
            sb |= (reg & 1) << k;
            let t = reg & 0x21, p = 0;
            while (t) {
                p ^= t & 1;
                t >>>= 1;
            }
            reg = (reg >>> 1) | (p << 8);
        }
        buf[i] ^= sb;
    }
}
function crc16(buf, len) {
    let crc = 0xffff;
    for (let i = 0; i < len; i++) {
        crc ^= buf[i] << 8;
        for (let b = 0; b < 8; b++)
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}
export class GeoscanDecoder {
    constructor(emit) {
        this.emit = emit;
        this.wantsFm = true;
        this.fmRate = 0;
        this.sync = new BitSync(9600, 48000);
        this.filt = new DiscFilter(7200, 48000);
        this.shift = 0;
        this.inFrame = false;
        this.bitN = 0;
        this.acc = 0;
        this.frame = new Uint8Array(FRAME);
        this.base = -1;
        this.frames = 0;
        this.bad = 0;
        this.imageFrames = 0;
        this.image = null;
        this.sentAt = 0;
        this.sentHigh = 0;
    }
    reset() {
        this.fmRate = 0;
        this.shift = 0;
        this.inFrame = false;
        this.bitN = 0;
        this.frames = 0;
        this.bad = 0;
        this.imageFrames = 0;
        this.image = null;
        this.base = -1;
        this.sentAt = 0;
        this.sentHigh = 0;
    }
    onIq() { }
    onFm(samples, n, rate) {
        if (rate !== this.fmRate) {
            this.fmRate = rate;
            this.sync = new BitSync(9600, rate);
            this.filt = new DiscFilter(Math.min(0.45 * rate, 7200), rate);
            this.shift = 0;
            this.inFrame = false;
            this.bitN = 0;
        }
        for (let i = 0; i < n; i++) {
            const b = this.sync.push(this.filt.push(samples[i]));
            if (b < 0)
                continue;
            if (this.inFrame) {
                this.acc = ((this.acc << 1) | b) & 0xff;
                if ((++this.bitN & 7) === 0)
                    this.frame[(this.bitN >> 3) - 1] = this.acc;
                if (this.bitN >= FRAME * 8) {
                    this.inFrame = false;
                    this.onFrame();
                }
                continue;
            }
            this.shift = ((this.shift << 1) | b) >>> 0;
            if (popcount((this.shift ^ SYNC) >>> 0) <= 4) {
                this.inFrame = true;
                this.bitN = 0;
                this.acc = 0;
            }
        }
    }
    onFrame() {
        const f = this.frame;
        pn9(f, FRAME);
        if (crc16(f, FRAME - 2) !== ((f[FRAME - 2] << 8) | f[FRAME - 1])) {
            this.bad++;
            return;
        }
        this.frames++;
        this.picture(f);
        const img = this.image;
        const now = Date.now();
        const worthSending = !!img && img.high > this.sentHigh + 512 && (now - this.sentAt > 2000 || img.complete);
        if (worthSending) {
            this.sentAt = now;
            this.sentHigh = img.high;
        }
        const jpeg = worthSending ? this.jpeg() : null;
        this.emit({
            type: 'geoscan', frames: this.frames, bad: this.bad, imageFrames: this.imageFrames,
            high: img ? img.high : 0, complete: img ? img.complete : false, fragments: img ? img.fragments : 0,
            jpeg,
        }, jpeg ? [jpeg.buffer] : undefined);
    }
    picture(f) {
        for (let at = 0; at + 8 <= FRAME - 2; at++) {
            if (f[at] !== (MARKER_IMG & 0xff) || f[at + 1] !== (MARKER_IMG >> 8))
                continue;
            const dlen = f[at + 2], mtype = f[at + 3] | (f[at + 4] << 8), off = f[at + 5] | (f[at + 6] << 8);
            if (dlen < 7 || dlen > 70 || at + 2 + dlen > FRAME - 2)
                continue;
            if (mtype !== CMD_START && mtype !== CMD_FRAME)
                continue;
            const data = f.subarray(at + 8, at + 2 + dlen);
            if (!data.length)
                continue;
            const soi = data[0] === 0xff && data[1] === 0xd8;
            if (mtype === CMD_START || (soi && this.base < 0)) {
                this.base = off;
                if (!this.image || this.image.complete)
                    this.start();
            }
            if (!this.image)
                this.start();
            let put = off - this.base;
            if (put < 0) {
                this.start();
                this.base = off;
                put = 0;
            }
            const img = this.image;
            if (put + data.length > img.bytes.length)
                return;
            img.bytes.set(data, put);
            img.high = Math.max(img.high, put + data.length);
            img.fragments++;
            this.imageFrames++;
            for (let k = 0; k + 1 < data.length; k++)
                if (data[k] === 0xff && data[k + 1] === 0xd9)
                    img.complete = true;
            return;
        }
    }
    start() { this.image = { started: Date.now(), bytes: new Uint8Array(256 * 1024), high: 0, complete: false, fragments: 0 }; }
    jpeg() {
        const img = this.image;
        return img && img.high > 2 ? img.bytes.slice(0, img.high) : null;
    }
}
