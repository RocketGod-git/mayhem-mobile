import { BitSync, popcount32 } from './core.js';
const SYNC = 0x7CD215D8, IDLE = 0x7A89C197;
const NUMERIC_CHARS = '0123456789RU -][';
export class PocsagEcc {
    constructor() {
        this.ecs = new Int32Array(21);
        this.bch = new Int32Array(1024);
        this.out = 0;
        let srr = 0x3b4;
        for (let i = 0; i <= 20; i++) {
            this.ecs[i] = srr;
            srr = (srr & 1) ? (srr >> 1) ^ 0x3B4 : srr >> 1;
        }
        for (let n = 0; n <= 20; n++)
            for (let i = 0; i <= 20; i++) {
                const j = (i << 5) + n;
                this.bch[this.ecs[n] ^ this.ecs[i]] = j + 0x2000;
            }
        for (let n = 0; n <= 20; n++) {
            this.bch[this.ecs[n]] = n + (0x1f << 5) + 0x1000;
        }
        for (let n = 0; n <= 20; n++)
            for (let i = 0; i < 10; i++) {
                this.bch[this.ecs[n] ^ (1 << i)] = n + (0x1f << 5) + 0x2000;
            }
        for (let n = 0; n < 10; n++)
            this.bch[1 << n] = 0x3ff + 0x1000;
        for (let n = 0; n < 10; n++)
            for (let i = 0; i < 10; i++)
                if (i !== n)
                    this.bch[(1 << n) ^ (1 << i)] = 0x3ff + 0x2000;
    }
    correct(input) {
        let v = input | 0, ecc = 0;
        for (let i = 31; i >= 11; i--)
            if (v & (1 << i))
                ecc ^= this.ecs[31 - i];
        let acc = 0;
        for (let i = 10; i >= 1; i--) {
            acc <<= 1;
            if (v & (1 << i))
                acc ^= 1;
        }
        const synd = ecc ^ acc;
        let errl = 0;
        if (synd !== 0) {
            if (this.bch[synd] !== 0) {
                const b1 = this.bch[synd] & 0x1f, b2 = (this.bch[synd] >> 5) & 0x1f;
                if (b2 !== 0x1f)
                    v ^= (1 << (31 - b2));
                if (b1 !== 0x1f)
                    v ^= (1 << (31 - b1));
                errl = this.bch[synd] >> 12;
            }
            else
                errl = 3;
        }
        if (errl === 4)
            errl = 3;
        this.out = v | 0;
        return errl;
    }
}
export class PocsagDecoder {
    constructor(emit) {
        this.emit = emit;
        this.wantsFm = true;
        this.bauds = [512, 1200, 2400];
        this.syncs = [];
        this.fmRate = 0;
        this.shift = new Int32Array(3);
        this.locked = -1;
        this.inverted = false;
        this.cw = 0;
        this.bitCount = 0;
        this.cwCount = 0;
        this.address = -1;
        this.func = 0;
        this.msgBits = new Uint8Array(8192);
        this.msgBitCount = 0;
        this.msgCodewords = 0;
        this.ecc = new PocsagEcc();
    }
    reset() { this.fmRate = 0; this.unlock(); }
    onIq() { }
    onFm(samples, n, rate) {
        if (rate !== this.fmRate) {
            this.fmRate = rate;
            this.syncs = this.bauds.map(b => new BitSync(b, rate));
            this.unlock();
        }
        for (let i = 0; i < n; i++) {
            const x = -samples[i];
            if (this.locked < 0) {
                for (let b = 0; b < 3; b++) {
                    const bit = this.syncs[b].push(x);
                    if (bit < 0)
                        continue;
                    this.shift[b] = (this.shift[b] << 1) | bit;
                    if (popcount32(this.shift[b] ^ SYNC) <= 2) {
                        this.locked = b;
                        this.inverted = false;
                        this.cw = 0;
                        this.bitCount = 0;
                        this.cwCount = 0;
                    }
                    else if (popcount32(this.shift[b] ^ ~SYNC) <= 2) {
                        this.locked = b;
                        this.inverted = true;
                        this.cw = 0;
                        this.bitCount = 0;
                        this.cwCount = 0;
                    }
                }
            }
            else {
                const raw = this.syncs[this.locked].push(x);
                if (raw >= 0)
                    this.onBit(this.inverted ? raw ^ 1 : raw);
            }
        }
    }
    unlock() {
        this.endMessage();
        this.locked = -1;
        this.cw = 0;
        this.bitCount = 0;
        this.cwCount = 0;
        this.shift.fill(0);
        for (const s of this.syncs)
            s.reset();
    }
    onBit(bit) {
        this.cw = (this.cw << 1) | bit;
        if (++this.bitCount < 32)
            return;
        this.bitCount = 0;
        if (this.cwCount >= 16) {
            if (popcount32(this.cw ^ SYNC) <= 2)
                this.cwCount = 0;
            else
                this.unlock();
            return;
        }
        this.processCodeword(this.cwCount, this.cw);
        this.cwCount++;
    }
    processCodeword(idx, raw) {
        const errs = this.ecc.correct(raw);
        const c = this.ecc.out;
        if (errs >= 3)
            return;
        if (c === IDLE) {
            this.endMessage();
            return;
        }
        const isAddress = (c & (1 << 31)) === 0;
        if (isAddress) {
            this.endMessage();
            this.address = (((c >>> 13) & 0x3FFFF) << 3) | (idx >> 1);
            this.func = (c >>> 11) & 3;
        }
        else {
            if (this.address < 0)
                return;
            if (this.msgBitCount + 20 > this.msgBits.length)
                return;
            for (let b = 30; b >= 11; b--)
                this.msgBits[this.msgBitCount++] = (c >>> b) & 1;
            this.msgCodewords++;
        }
    }
    endMessage() {
        if (this.address < 0)
            return;
        const baud = this.locked >= 0 ? this.bauds[this.locked] : 0;
        const head = `RIC ${String(this.address).padStart(7, '0')} F${this.func} ${String(baud).padStart(4)}bps`;
        if (this.msgBitCount === 0)
            this.emit({ type: 'packet', line: `${head} TONE` });
        else {
            const alpha = this.decodeAlpha(), numeric = this.decodeNumeric();
            const useNumeric = this.msgCodewords >= 8 ? false : this.func === 0 ? true : !PocsagDecoder.looksAlpha(alpha);
            this.emit({ type: 'packet', line: useNumeric ? `${head} NUM: ${numeric}` : `${head} ALPHA: ${alpha}` });
        }
        this.address = -1;
        this.msgBitCount = 0;
        this.msgCodewords = 0;
    }
    decodeAlpha() {
        let s = '';
        for (let i = 0; i + 7 <= this.msgBitCount; i += 7) {
            let ch = 0;
            for (let b = 0; b < 7; b++)
                ch |= this.msgBits[i + b] << b;
            if (ch === 0)
                continue;
            if (ch >= 0x20 && ch <= 0x7e)
                s += String.fromCharCode(ch);
            else if (ch === 0x0a || ch === 0x0d)
                s += ' ';
            else
                s += '·';
        }
        return s.trimEnd();
    }
    decodeNumeric() {
        let s = '';
        for (let i = 0; i + 4 <= this.msgBitCount; i += 4) {
            const d = this.msgBits[i] | (this.msgBits[i + 1] << 1) | (this.msgBits[i + 2] << 2) | (this.msgBits[i + 3] << 3);
            s += NUMERIC_CHARS[d];
        }
        return s.trimEnd();
    }
    static looksAlpha(s) {
        if (!s)
            return false;
        let good = 0;
        for (const c of s)
            if (/[A-Za-z0-9 .,:\-\/]/.test(c))
                good++;
        return good * 10 >= s.length * 7;
    }
}
