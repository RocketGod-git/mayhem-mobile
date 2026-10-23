const RATE = 48000, WORDS = 4160, LINE = 2080;
const SYNC_A = new Int8Array(39);
{
    let k = 0;
    for (let i = 0; i < 4; i++)
        SYNC_A[k++] = -1;
    for (let c = 0; c < 7; c++) {
        SYNC_A[k++] = 1;
        SYNC_A[k++] = 1;
        SYNC_A[k++] = -1;
        SYNC_A[k++] = -1;
    }
    while (k < 39)
        SYNC_A[k++] = -1;
}
export class AptDecoder {
    constructor() {
        this.minHalf = 20000;
        this.onRow = () => { };
        this.cr = 1;
        this.ci = 0;
        this.dr = Math.cos(-2 * Math.PI * 2400 / RATE);
        this.di = Math.sin(-2 * Math.PI * 2400 / RATE);
        this.i1 = 0;
        this.i2 = 0;
        this.q1 = 0;
        this.q2 = 0;
        this.a = 1 - Math.exp(-2 * Math.PI * 2600 / RATE);
        this.ph = 0;
        this.acc = 0;
        this.accN = 0;
        this.words = new Float32Array(LINE * 8);
        this.m = 0;
        this.lineStart = -1;
        this.lines = 0;
        this.miss = 0;
        this.lo = 0;
        this.hi = 1;
        this.calibrated = false;
        this.row = new Uint8ClampedArray(LINE);
        this.tmp = new Float32Array(0);
    }
    reset() { this.m = 0; this.lineStart = -1; this.lines = 0; this.miss = 0; this.calibrated = false; this.acc = 0; this.accN = 0; this.ph = 0; }
    onFm(samples, n, rate) {
        if (rate !== RATE)
            return;
        const al = this.a, step = WORDS / RATE;
        for (let k = 0; k < n; k++) {
            const x = samples[k];
            const i = x * this.cr, q = x * this.ci;
            const nr = this.cr * this.dr - this.ci * this.di;
            this.ci = this.cr * this.di + this.ci * this.dr;
            this.cr = nr;
            this.i1 += al * (i - this.i1);
            this.i2 += al * (this.i1 - this.i2);
            this.q1 += al * (q - this.q1);
            this.q2 += al * (this.q1 - this.q2);
            this.acc += Math.sqrt(this.i2 * this.i2 + this.q2 * this.q2);
            this.accN++;
            this.ph += step;
            if (this.ph >= 1) {
                this.ph -= 1;
                this.word(this.acc / this.accN);
                this.acc = 0;
                this.accN = 0;
            }
        }
        if ((n & 0xfff) === 0) {
            const g = 1 / Math.hypot(this.cr, this.ci);
            this.cr *= g;
            this.ci *= g;
        }
    }
    word(w) {
        const words = this.words, len = words.length;
        words[this.m % len] = w;
        this.m++;
        const m = this.m;
        if (this.lineStart < 0) {
            if (m < LINE + 39)
                return;
            const c = this.corr(m - 39), cPrev = this.corr(m - 39 - LINE);
            if (c > 0.55 && cPrev > 0.4) {
                this.lineStart = m - 39;
                this.miss = 0;
            }
            return;
        }
        if (m < this.lineStart + LINE + 40)
            return;
        let best = this.lineStart + LINE, bestC = 0;
        for (let d = -20; d <= 20; d++) {
            const c = this.corr(this.lineStart + LINE + d);
            if (c > bestC) {
                bestC = c;
                best = this.lineStart + LINE + d;
            }
        }
        if (bestC < 0.35) {
            this.miss++;
            best = this.lineStart + LINE;
            if (this.miss > 6) {
                this.lineStart = -1;
                return;
            }
        }
        else
            this.miss = 0;
        this.emit(this.lineStart);
        this.lineStart = best;
    }
    corr(at) {
        const words = this.words, len = words.length;
        if (at < this.m - len || at + 39 > this.m)
            return 0;
        let mean = 0;
        for (let k = 0; k < 39; k++)
            mean += words[(at + k) % len];
        mean /= 39;
        let s = 0, a = 0;
        for (let k = 0; k < 39; k++) {
            const v = words[(at + k) % len] - mean;
            s += v * SYNC_A[k];
            a += v < 0 ? -v : v;
        }
        return a > 0 ? s / a : 0;
    }
    emit(at) {
        const words = this.words, len = words.length, row = this.row;
        if (this.tmp.length < LINE)
            this.tmp = new Float32Array(LINE);
        const t = this.tmp;
        for (let k = 0; k < LINE; k++)
            t[k] = words[(at + k) % len];
        const sorted = t.slice().sort();
        const lo = sorted[Math.floor(LINE * 0.02)], hi = sorted[Math.floor(LINE * 0.98)];
        if (!this.calibrated) {
            this.lo = lo;
            this.hi = hi;
            this.calibrated = true;
        }
        else {
            this.lo += 0.05 * (lo - this.lo);
            this.hi += 0.05 * (hi - this.hi);
        }
        const g = 255 / Math.max(1e-6, this.hi - this.lo);
        for (let k = 0; k < LINE; k++)
            row[k] = (t[k] - this.lo) * g;
        this.onRow(row.slice(), this.lines++);
    }
}
