export const PTY_NAMES = [
    'None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education', 'Drama', 'Culture', 'Science', 'Varied',
    'Pop Music', 'Rock Music', 'Easy Listening', 'Light Classical', 'Serious Classical', 'Other Music', 'Weather',
    'Finance', "Children's", 'Social Affairs', 'Religion', 'Phone In', 'Travel', 'Leisure', 'Jazz Music',
    'Country Music', 'National Music', 'Oldies Music', 'Folk Music', 'Documentary', 'Alarm Test', 'Alarm',
];
const POLY = 0x5b9;
export const OFFSET_A = 0x0fc, OFFSET_B = 0x198, OFFSET_C = 0x168, OFFSET_CP = 0x350, OFFSET_D = 0x1b4;
const BAUD = 1187.5;
const SUBCARRIER = 57000;
const SYNC_LOSS_BLOCKS = 50;
const HALF_SYMBOL_GAIN = 0.1;
const LOOP_BANDWIDTH_HZ = 40;
const ALIGN_FLIP_SYMBOLS = 8;
export function rdsSyndrome(block) {
    let r = 0;
    for (let i = 25; i >= 0; i--) {
        r = (r << 1) | ((block >>> i) & 1);
        if (r & 0x400)
            r ^= POLY;
    }
    return r;
}
export function rdsCheckword(data, offset) {
    return rdsSyndrome((data & 0xffff) << 10) ^ offset;
}
class Biquad {
    constructor(b0, b1, b2, a1, a2) {
        this.b0 = b0;
        this.b1 = b1;
        this.b2 = b2;
        this.a1 = a1;
        this.a2 = a2;
        this.z1 = 0;
        this.z2 = 0;
    }
    push(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
    }
}
class Lowpass {
    constructor(cutoffHz, rate) {
        this.s = [];
        const w0 = 2 * Math.PI * Math.min(0.45 * rate, cutoffHz) / rate, c = Math.cos(w0);
        for (const q of [1.9319, 0.7071, 0.5176]) {
            const alpha = Math.sin(w0) / (2 * q), a0 = 1 + alpha;
            this.s.push(new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0));
        }
    }
    push(x) { for (const b of this.s)
        x = b.push(x); return x; }
}
const charOf = (c) => (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : ' ';
export class RdsDecoder {
    constructor(emit) {
        this.emit = emit;
        this.rate = 0;
        this.rotRe = 1;
        this.rotIm = 0;
        this.stepRe = 1;
        this.stepIm = 0;
        this.rotCount = 0;
        this.lpI = new Lowpass(2400, 250000);
        this.lpQ = new Lowpass(2400, 250000);
        this.decim = 1;
        this.decimCount = 0;
        this.agc = 0;
        this.agcK = 0;
        this.phase = 0;
        this.freq = 0;
        this.alpha = 0;
        this.beta = 0;
        this.maxFreq = 0;
        this.hPhase = 0;
        this.hInc = 0;
        this.hAcc = 0;
        this.lastPos = false;
        this.hFirst = true;
        this.prevHalf = 0;
        this.halfParity = 0;
        this.align = 0;
        this.score = [0, 0];
        this.flipCount = 0;
        this.prevSym = 0;
        this.shift = 0;
        this.bitsSince = 0;
        this.expect = 0;
        this.badRun = 0;
        this.blocks = new Int32Array(4);
        this.good = [false, false, false, false];
        this.cPrime = false;
        this.pi = null;
        this.piCandidate = -1;
        this.pty = null;
        this.tp = false;
        this.ta = false;
        this.ms = false;
        this.psChars = new Uint8Array(8);
        this.rtChars = new Uint8Array(64);
        this.psBuild = new Uint8Array(8);
        this.psMask = 0;
        this.psAny = false;
        this.psLast = new Uint8Array(8);
        this.psHaveLast = false;
        this.psStreak = 0;
        this.psChanges = 0;
        this.psScrolls = false;
        this.rtWidth = 4;
        this.pending = null;
        this.ps = '        ';
        this.rt = '';
        this.abFlag = -1;
        this.af = [];
        this.groups = 0;
        this.errors = 0;
        this.synced = false;
        this.dirty = false;
        this.sinceEmit = 0;
        this.emitEvery = 0;
        this.clearText();
    }
    reset() {
        this.rate = 0;
        this.dropSync();
        this.pi = null;
        this.piCandidate = -1;
        this.pty = null;
        this.tp = false;
        this.ta = false;
        this.ms = false;
        this.abFlag = -1;
        this.clearText();
        this.af = [];
        this.pending = null;
        this.groups = 0;
        this.errors = 0;
        this.dirty = false;
        this.sinceEmit = 0;
    }
    get state() {
        return {
            pi: this.pi, ps: this.ps, rt: this.rt, pty: this.pty,
            ptyName: this.pty === null ? '' : PTY_NAMES[this.pty],
            tp: this.tp, ta: this.ta, ms: this.ms, groups: this.groups, errors: this.errors, synced: this.synced,
            af: this.af.slice(),
        };
    }
    push(mpx, n, rate) {
        if (rate !== this.rate)
            this.configure(rate);
        for (let k = 0; k < n; k++) {
            const x = mpx[k];
            const i = x * this.rotRe, q = -x * this.rotIm;
            const re = this.rotRe * this.stepRe - this.rotIm * this.stepIm;
            const im = this.rotRe * this.stepIm + this.rotIm * this.stepRe;
            this.rotRe = re;
            this.rotIm = im;
            if (++this.rotCount >= 4096) {
                this.rotCount = 0;
                const g = 1 / Math.sqrt(re * re + im * im);
                this.rotRe *= g;
                this.rotIm *= g;
            }
            const fi = this.lpI.push(i), fq = this.lpQ.push(q);
            if (++this.decimCount >= this.decim) {
                this.decimCount = 0;
                this.baseband(fi, fq);
            }
            this.sinceEmit++;
        }
        if (this.dirty && this.sinceEmit >= this.emitEvery)
            this.flush();
    }
    configure(rate) {
        this.rate = rate;
        const w = 2 * Math.PI * SUBCARRIER / rate;
        this.stepRe = Math.cos(w);
        this.stepIm = Math.sin(w);
        this.rotRe = 1;
        this.rotIm = 0;
        this.rotCount = 0;
        this.lpI = new Lowpass(2400, rate);
        this.lpQ = new Lowpass(2400, rate);
        this.decim = Math.max(1, Math.floor(rate / 38000));
        this.decimCount = 0;
        const decRate = rate / this.decim;
        this.agc = 0;
        this.agcK = 1 / (0.05 * decRate);
        const zeta = 0.707, theta = (LOOP_BANDWIDTH_HZ / decRate) / (zeta + 1 / (4 * zeta));
        const denom = 1 + 2 * zeta * theta + theta * theta, kp = 0.5;
        this.alpha = (4 * zeta * theta / denom) / kp;
        this.beta = (4 * theta * theta / denom) / kp;
        this.maxFreq = 2 * Math.PI * 400 / decRate;
        this.phase = 0;
        this.freq = 0;
        this.hInc = 2 * BAUD / decRate;
        this.hPhase = 0;
        this.hAcc = 0;
        this.hFirst = true;
        this.prevHalf = 0;
        this.halfParity = 0;
        this.align = 0;
        this.score[0] = this.score[1] = 0;
        this.flipCount = 0;
        this.prevSym = 0;
        this.emitEvery = rate / 4;
        this.dropSync();
    }
    baseband(i, q) {
        const mag = Math.sqrt(i * i + q * q);
        if (this.agc === 0)
            this.agc = mag;
        else
            this.agc += (mag - this.agc) * this.agcK;
        const g = 1 / Math.max(this.agc, 1e-12);
        i *= g;
        q *= g;
        const c = Math.cos(this.phase), s = Math.sin(this.phase);
        const ii = i * c + q * s, qq = q * c - i * s;
        let e = ii * qq;
        if (e > 1)
            e = 1;
        else if (e < -1)
            e = -1;
        this.freq += this.beta * e;
        if (this.freq > this.maxFreq)
            this.freq = this.maxFreq;
        else if (this.freq < -this.maxFreq)
            this.freq = -this.maxFreq;
        this.phase += this.freq + this.alpha * e;
        if (this.phase > Math.PI)
            this.phase -= 2 * Math.PI;
        else if (this.phase < -Math.PI)
            this.phase += 2 * Math.PI;
        const pos = ii > 0;
        if (!this.hFirst && pos !== this.lastPos) {
            const err = this.hPhase < 0.5 ? this.hPhase : this.hPhase - 1;
            this.hPhase -= err * HALF_SYMBOL_GAIN;
        }
        this.hFirst = false;
        this.lastPos = pos;
        this.hAcc += ii;
        this.hPhase += this.hInc;
        if (this.hPhase >= 1) {
            this.hPhase -= 1;
            const h = this.hAcc;
            this.hAcc = 0;
            this.onHalf(h);
        }
    }
    onHalf(h) {
        const prev = this.prevHalf;
        this.prevHalf = h;
        const a = this.halfParity;
        this.halfParity ^= 1;
        this.score[a] = this.score[a] * 0.95 + (Math.abs(prev - h) - Math.abs(prev + h));
        if (a !== this.align)
            return;
        const sym = prev - h > 0 ? 1 : 0;
        const bit = sym ^ this.prevSym;
        this.prevSym = sym;
        this.onBit(bit);
        if (this.score[a ^ 1] > this.score[a]) {
            if (++this.flipCount >= ALIGN_FLIP_SYMBOLS) {
                this.align ^= 1;
                this.flipCount = 0;
            }
        }
        else
            this.flipCount = 0;
    }
    wanted(slot, s) {
        switch (slot) {
            case 0: return s === OFFSET_A;
            case 1: return s === OFFSET_B;
            case 2: return s === OFFSET_C || s === OFFSET_CP;
            default: return s === OFFSET_D;
        }
    }
    onBit(bit) {
        this.shift = ((this.shift << 1) | bit) & 0x3ffffff;
        this.bitsSince++;
        if (!this.synced) {
            if (this.expect === 0) {
                if (rdsSyndrome(this.shift) === OFFSET_A) {
                    this.blocks[0] = this.shift >>> 10;
                    this.expect = 1;
                    this.bitsSince = 0;
                }
                return;
            }
            if (this.bitsSince < 26)
                return;
            this.bitsSince = 0;
            const s = rdsSyndrome(this.shift);
            if (this.wanted(this.expect, s)) {
                this.blocks[this.expect] = this.shift >>> 10;
                if (this.expect === 2)
                    this.cPrime = s === OFFSET_CP;
                if (++this.expect === 4) {
                    this.expect = 0;
                    this.synced = true;
                    this.badRun = 0;
                    this.good.fill(true);
                    this.processGroup();
                    this.flush();
                }
            }
            else if (s === OFFSET_A) {
                this.blocks[0] = this.shift >>> 10;
                this.expect = 1;
            }
            else
                this.expect = 0;
            return;
        }
        if (this.bitsSince < 26)
            return;
        this.bitsSince = 0;
        const s = rdsSyndrome(this.shift);
        const ok = this.wanted(this.expect, s);
        this.good[this.expect] = ok;
        this.blocks[this.expect] = this.shift >>> 10;
        if (this.expect === 2)
            this.cPrime = s === OFFSET_CP;
        if (ok)
            this.badRun = 0;
        else {
            this.errors++;
            if (++this.badRun >= SYNC_LOSS_BLOCKS) {
                this.dropSync();
                this.flush();
                return;
            }
        }
        if (++this.expect === 4) {
            this.expect = 0;
            this.processGroup();
        }
    }
    dropSync() {
        this.synced = false;
        this.expect = 0;
        this.bitsSince = 0;
        this.badRun = 0;
        this.shift = 0;
        this.good.fill(false);
    }
    processGroup() {
        const [a, b, c, d] = this.blocks;
        if (this.good[0] && this.good[1] && this.good[2] && this.good[3])
            this.groups++;
        if (this.good[0]) {
            const adopted = this.observePi(a);
            if (a !== this.pi) {
                this.pending = this.good[1] ? this.textOf(b, c, d) : null;
                return;
            }
            if (adopted && this.pending)
                this.applyText(this.pending);
            this.pending = null;
        }
        else if (this.pi === null)
            return;
        if (!this.good[1])
            return;
        const type = b >> 12, versionB = (b >> 11) & 1, tp = ((b >> 10) & 1) === 1, pty = (b >> 5) & 0x1f;
        if (tp !== this.tp) {
            this.tp = tp;
            this.dirty = true;
        }
        if (pty !== this.pty) {
            this.pty = pty;
            this.dirty = true;
        }
        if (type === 0) {
            const ta = ((b >> 4) & 1) === 1, ms = ((b >> 3) & 1) === 1;
            if (ta !== this.ta) {
                this.ta = ta;
                this.dirty = true;
            }
            if (ms !== this.ms) {
                this.ms = ms;
                this.dirty = true;
            }
            if (!versionB && this.good[2] && !this.cPrime)
                this.observeAf(c >> 8, c & 0xff);
        }
        const text = this.textOf(b, c, d);
        if (text)
            this.applyText(text);
    }
    textOf(b, c, d) {
        const type = b >> 12, versionB = ((b >> 11) & 1) === 1;
        if (type === 0)
            return this.good[3] ? { kind: 'ps', seg: b & 3, key: d } : null;
        if (type !== 2)
            return null;
        const seg = b & 0xf, ab = (b >> 4) & 1;
        if (versionB)
            return this.good[3] ? { kind: 'rt', seg, width: 2, key: d, ab } : null;
        return this.good[2] && this.good[3] ? { kind: 'rt', seg, width: 4, key: ((c << 16) | d) | 0, ab } : null;
    }
    applyText(t) {
        if (t.kind === 'ps') {
            this.seePs(t.seg, t.key);
            return;
        }
        if (t.ab !== this.abFlag) {
            if (this.abFlag >= 0)
                this.clearRt();
            this.abFlag = t.ab;
        }
        this.seeRt(t.seg, t.width, t.key);
    }
    observePi(pi) {
        if (pi === this.pi) {
            this.piCandidate = -1;
            return false;
        }
        if (pi !== this.piCandidate) {
            this.piCandidate = pi;
            return false;
        }
        this.pi = pi;
        this.piCandidate = -1;
        this.clearText();
        this.af = [];
        this.abFlag = -1;
        this.dirty = true;
        return true;
    }
    observeAf(hi, lo) {
        if (hi === 250)
            return;
        this.addAf(hi);
        this.addAf(lo);
    }
    addAf(code) {
        if (code < 1 || code > 204)
            return;
        const f = (875 + code) / 10;
        if (this.af.includes(f) || this.af.length >= 25)
            return;
        this.af.push(f);
        this.af.sort((x, y) => x - y);
        this.dirty = true;
    }
    seePs(seg, key) {
        const bit = 1 << seg;
        if (this.psMask & bit) {
            this.psMask = 0;
            this.psBuild.fill(0x20);
        }
        this.psBuild[2 * seg] = (key >> 8) & 0xff;
        this.psBuild[2 * seg + 1] = key & 0xff;
        this.psMask |= bit;
        if (this.psMask !== 0b1111)
            return;
        this.psMask = 0;
        let same = this.psHaveLast;
        for (let i = 0; i < 8 && same; i++)
            if (this.psBuild[i] !== this.psLast[i])
                same = false;
        if (this.psHaveLast && !same) {
            this.psStreak = 0;
            if (++this.psChanges >= 3)
                this.psScrolls = true;
        }
        else if (++this.psStreak >= 4)
            this.psChanges = 0;
        this.psLast.set(this.psBuild);
        this.psHaveLast = true;
        if (this.psScrolls) {
            if (this.psAny) {
                this.psAny = false;
                this.psChars.fill(0x20);
                this.refreshPs();
            }
            this.psBuild.fill(0x20);
            return;
        }
        if (this.psStreak >= 2) {
            let changed = !this.psAny;
            for (let i = 0; i < 8; i++)
                if (this.psChars[i] !== this.psBuild[i]) {
                    this.psChars[i] = this.psBuild[i];
                    changed = true;
                }
            this.psAny = true;
            if (changed)
                this.refreshPs();
        }
        this.psBuild.fill(0x20);
    }
    seeRt(seg, width, key) {
        if (width !== this.rtWidth) {
            this.clearRt();
            this.rtWidth = width;
        }
        const base = seg * width;
        if (base + width > 64)
            return;
        if (width === 4) {
            this.rtChars[base] = (key >>> 24) & 0xff;
            this.rtChars[base + 1] = (key >>> 16) & 0xff;
            this.rtChars[base + 2] = (key >>> 8) & 0xff;
            this.rtChars[base + 3] = key & 0xff;
        }
        else {
            this.rtChars[base] = (key >> 8) & 0xff;
            this.rtChars[base + 1] = key & 0xff;
        }
        this.refreshRt();
    }
    clearRt() { this.rtChars.fill(0x20); }
    clearText() {
        this.psChars.fill(0x20);
        this.psBuild.fill(0x20);
        this.psMask = 0;
        this.psAny = false;
        this.psLast.fill(0x20);
        this.psHaveLast = false;
        this.psStreak = 0;
        this.psChanges = 0;
        this.psScrolls = false;
        this.clearRt();
        this.rtWidth = 4;
        this.ps = '        ';
        this.rt = '';
    }
    refreshPs() {
        let s = '';
        for (let i = 0; i < 8; i++)
            s += charOf(this.psChars[i]);
        if (s !== this.ps) {
            this.ps = s;
            this.dirty = true;
        }
    }
    refreshRt() {
        let s = '';
        for (let i = 0; i < 64; i++) {
            const c = this.rtChars[i];
            if (c === 0x0d)
                break;
            s += charOf(c);
        }
        s = s.trimEnd();
        if (s !== this.rt) {
            this.rt = s;
            this.dirty = true;
        }
    }
    flush() {
        this.dirty = false;
        this.sinceEmit = 0;
        this.emit(this.state);
    }
}
