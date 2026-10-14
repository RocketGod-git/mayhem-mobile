import { fft, hann } from '../fft.js';
const HD_RATE = 744187.5;
const OFDM_N = 2048, OFDM_CP = 112, OFDM_SYM = OFDM_N + OFDM_CP;
const SUB_SPACING = HD_RATE / OFDM_N;
const SB_LO_HZ = 356 * SUB_SPACING, SB_HI_HZ = 545 * SUB_SPACING;
const SB_MIX_HZ = 450 * SUB_SPACING;
const REF_LO_HZ = 205000, REF_HI_HZ = 235000;
const ANALOG_HZ = 100000;
const FOLD = 64;
const PRESENT_SNR_DB = 6, PRESENT_LOCK = 1.35;
function lowpass(taps, cutoff) {
    const h = new Float32Array(taps), m = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const x = i - m;
        const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (taps + 1));
        h[i] = sinc * w;
        sum += h[i];
    }
    for (let i = 0; i < taps; i++)
        h[i] /= sum;
    return h;
}
class Sideband {
    constructor() {
        this.stepRe = 1;
        this.stepIm = 0;
        this.phRe = 1;
        this.phIm = 0;
        this.phN = 0;
        this.d2 = 1;
        this.cnt = 0;
        this.pathRate = 0;
        this.taps = new Float32Array(0);
        this.lineRe = new Float32Array(0);
        this.lineIm = new Float32Array(0);
        this.lineAt = 0;
        this.L = 0;
        this.cp = 0;
        this.P = 1;
        this.yRe = new Float32Array(1024);
        this.yIm = new Float32Array(1024);
        this.yAt = 0;
        this.yN = 0;
        this.rRe = new Float32Array(64);
        this.rIm = new Float32Array(64);
        this.rAt = 0;
        this.sRe = 0;
        this.sIm = 0;
        this.phase = 0;
        this.prof = new Float64Array(FOLD);
        this.profRe = new Float64Array(FOLD);
        this.profIm = new Float64Array(FOLD);
        this.symbols = 0;
    }
    configure(rate1, shiftHz) {
        const w = -2 * Math.PI * shiftHz / rate1;
        this.stepRe = Math.cos(w);
        this.stepIm = Math.sin(w);
        this.phRe = 1;
        this.phIm = 0;
        this.phN = 0;
        this.d2 = Math.max(1, Math.round(rate1 / 96000));
        this.cnt = 0;
        this.pathRate = rate1 / this.d2;
        this.taps = lowpass(63, 36000 / rate1);
        this.lineRe = new Float32Array(this.taps.length);
        this.lineIm = new Float32Array(this.taps.length);
        this.lineAt = 0;
        this.L = Math.round(OFDM_N * this.pathRate / HD_RATE);
        this.cp = Math.max(4, Math.round(OFDM_CP * this.pathRate / HD_RATE));
        this.P = OFDM_SYM * this.pathRate / HD_RATE;
        this.yRe = new Float32Array(1024);
        this.yIm = new Float32Array(1024);
        this.yAt = 0;
        this.yN = 0;
        this.rRe = new Float32Array(this.cp);
        this.rIm = new Float32Array(this.cp);
        this.rAt = 0;
        this.sRe = 0;
        this.sIm = 0;
        this.clear();
    }
    clear() { this.prof.fill(0); this.profRe.fill(0); this.profIm.fill(0); this.symbols = 0; }
    push(re, im) {
        const xr = re * this.phRe - im * this.phIm, xi = re * this.phIm + im * this.phRe;
        const nr = this.phRe * this.stepRe - this.phIm * this.stepIm;
        this.phIm = this.phRe * this.stepIm + this.phIm * this.stepRe;
        this.phRe = nr;
        if (++this.phN >= 4096) {
            this.phN = 0;
            const g = 1 / Math.sqrt(this.phRe * this.phRe + this.phIm * this.phIm);
            this.phRe *= g;
            this.phIm *= g;
        }
        const n = this.taps.length;
        this.lineRe[this.lineAt] = xr;
        this.lineIm[this.lineAt] = xi;
        this.lineAt = (this.lineAt + 1) % n;
        if (++this.cnt < this.d2)
            return;
        this.cnt = 0;
        let yr = 0, yi = 0, j = this.lineAt;
        for (let i = 0; i < n; i++) {
            const h = this.taps[n - 1 - i];
            yr += h * this.lineRe[j];
            yi += h * this.lineIm[j];
            if (++j === n)
                j = 0;
        }
        this.onPath(yr, yi);
    }
    onPath(yr, yi) {
        const ring = this.yRe.length;
        this.yRe[this.yAt] = yr;
        this.yIm[this.yAt] = yi;
        const at = this.yAt;
        this.yAt = (this.yAt + 1) % ring;
        if (this.yN < ring)
            this.yN++;
        if (this.yN <= this.L)
            return;
        const j = (at - this.L + ring) % ring, br = this.yRe[j], bi = this.yIm[j];
        const rr = yr * br + yi * bi, ri = yi * br - yr * bi;
        this.sRe += rr - this.rRe[this.rAt];
        this.sIm += ri - this.rIm[this.rAt];
        this.rRe[this.rAt] = rr;
        this.rIm[this.rAt] = ri;
        this.rAt = (this.rAt + 1) % this.cp;
        const bin = Math.min(FOLD - 1, Math.floor(this.phase * FOLD));
        this.prof[bin] += Math.sqrt(this.sRe * this.sRe + this.sIm * this.sIm);
        this.profRe[bin] += this.sRe;
        this.profIm[bin] += this.sIm;
        this.phase += 1 / this.P;
        if (this.phase >= 1) {
            this.phase -= 1;
            this.symbols++;
        }
    }
    report() {
        let sum = 0, peak = 0, pk = 0;
        for (let b = 0; b < FOLD; b++) {
            sum += this.prof[b];
            if (this.prof[b] > peak) {
                peak = this.prof[b];
                pk = b;
            }
        }
        const mean = sum / FOLD;
        const lock = mean > 0 ? peak / mean : 0;
        const cfoHz = Math.atan2(this.profIm[pk], this.profRe[pk]) * this.pathRate / (2 * Math.PI * this.L);
        const symbols = this.symbols;
        const profile = Array.from(this.prof, v => mean > 0 ? Math.round(v / mean * 100) / 100 : 0);
        this.clear();
        return { lock, cfoHz, symbols, profile };
    }
}
export class HdDetector {
    constructor(emit) {
        this.emit = emit;
        this.rate = 0;
        this.d1 = 1;
        this.rate1 = 0;
        this.offset = NaN;
        this.stepRe = 1;
        this.stepIm = 0;
        this.phRe = 1;
        this.phIm = 0;
        this.phN = 0;
        this.accRe = 0;
        this.accIm = 0;
        this.accN = 0;
        this.hi = new Sideband();
        this.lo = new Sideband();
        this.N = 1024;
        this.fre = new Float32Array(1024);
        this.fim = new Float32Array(1024);
        this.win = hann(1024);
        this.frame = new Float32Array(2048);
        this.frameN = 0;
        this.frameGap = 0;
        this.pow = new Float64Array(1024);
        this.pows = 0;
        this.since = 0;
        this.every = 0;
        this.last = null;
        this.spent = 0;
    }
    get state() { return this.last; }
    reset() {
        this.rate = 0;
        this.offset = NaN;
        this.pow.fill(0);
        this.pows = 0;
        this.frameN = 0;
        this.frameGap = 0;
        this.since = 0;
        this.hi.clear();
        this.lo.clear();
        this.last = null;
    }
    configure(rate) {
        this.rate = rate;
        this.d1 = Math.max(1, Math.round(rate / 480000));
        this.accRe = this.accIm = 0;
        this.accN = 0;
        this.rate1 = rate / this.d1;
        this.hi.configure(this.rate1, SB_MIX_HZ);
        this.lo.configure(this.rate1, -SB_MIX_HZ);
        this.pow.fill(0);
        this.pows = 0;
        this.frameN = 0;
        this.frameGap = 0;
        this.every = Math.round(rate / 2);
        this.since = 0;
        this.offset = NaN;
    }
    push(iq, n, rate, offsetHz) {
        const t0 = performance.now();
        if (rate !== this.rate)
            this.configure(rate);
        if (offsetHz !== this.offset) {
            this.offset = offsetHz;
            const w = -2 * Math.PI * offsetHz / rate;
            this.stepRe = Math.cos(w);
            this.stepIm = Math.sin(w);
        }
        const d1 = this.d1;
        for (let k = 0; k < n; k++) {
            const a = iq[2 * k], b = iq[2 * k + 1];
            const xr = a * this.phRe - b * this.phIm, xi = a * this.phIm + b * this.phRe;
            const nr = this.phRe * this.stepRe - this.phIm * this.stepIm;
            this.phIm = this.phRe * this.stepIm + this.phIm * this.stepRe;
            this.phRe = nr;
            if (++this.phN >= 4096) {
                this.phN = 0;
                const g = 1 / Math.sqrt(this.phRe * this.phRe + this.phIm * this.phIm);
                this.phRe *= g;
                this.phIm *= g;
            }
            this.accRe += xr;
            this.accIm += xi;
            if (++this.accN >= d1) {
                const yr = this.accRe / d1, yi = this.accIm / d1;
                this.accRe = this.accIm = 0;
                this.accN = 0;
                this.at1(yr, yi);
            }
        }
        this.since += n;
        this.spent += performance.now() - t0;
        if (this.since >= this.every) {
            this.since = 0;
            this.report();
        }
    }
    at1(re, im) {
        if (this.frameGap > 0)
            this.frameGap--;
        else {
            this.frame[2 * this.frameN] = re;
            this.frame[2 * this.frameN + 1] = im;
            if (++this.frameN >= this.N) {
                this.frameN = 0;
                this.frameGap = 7 * this.N;
                for (let i = 0; i < this.N; i++) {
                    this.fre[i] = this.frame[2 * i] * this.win[i];
                    this.fim[i] = this.frame[2 * i + 1] * this.win[i];
                }
                fft(this.fre, this.fim);
                for (let i = 0; i < this.N; i++)
                    this.pow[i] += this.fre[i] * this.fre[i] + this.fim[i] * this.fim[i];
                this.pows++;
            }
        }
        this.hi.push(re, im);
        this.lo.push(re, im);
    }
    bandDb(loHz, hiHz) {
        const binHz = this.rate1 / this.N;
        let a = Math.round(loHz / binHz), b = Math.round(hiHz / binHz);
        if (a > b) {
            const t = a;
            a = b;
            b = t;
        }
        let sum = 0, cnt = 0;
        for (let k = a; k < b; k++) {
            const i = ((k % this.N) + this.N) % this.N;
            sum += this.pow[i];
            cnt++;
        }
        return cnt && this.pows ? 10 * Math.log10(sum / cnt / this.pows + 1e-20) : -200;
    }
    report() {
        const sbHiDb = this.bandDb(SB_LO_HZ, SB_HI_HZ), sbLoDb = this.bandDb(-SB_HI_HZ, -SB_LO_HZ);
        const refDb = 10 * Math.log10((Math.pow(10, this.bandDb(REF_LO_HZ, REF_HI_HZ) / 10) + Math.pow(10, this.bandDb(-REF_HI_HZ, -REF_LO_HZ) / 10)) / 2 + 1e-20);
        const analogDb = this.bandDb(-ANALOG_HZ, ANALOG_HZ);
        this.pow.fill(0);
        this.pows = 0;
        const hi = this.hi.report(), lo = this.lo.report();
        const best = hi.lock >= lo.lock ? hi : lo;
        const snrDb = Math.max(sbHiDb, sbLoDb) - refDb;
        const lock = Math.max(hi.lock, lo.lock);
        const r = {
            present: snrDb >= PRESENT_SNR_DB && lock >= PRESENT_LOCK,
            snrDb, lock, lockLo: lo.lock, lockHi: hi.lock, sbLoDb, sbHiDb, refDb, analogDb,
            cfoHz: best.cfoHz, symbols: best.symbols, profile: best.profile, ms: Math.round(this.spent),
        };
        this.spent = 0;
        this.last = r;
        this.emit(r);
    }
}
