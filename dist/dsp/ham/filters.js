export function lowpassTaps(cutoffFrac, taps) {
    const h = new Float32Array(taps), m = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const x = i - m;
        const sinc = x === 0 ? 2 * cutoffFrac : Math.sin(2 * Math.PI * cutoffFrac * x) / (Math.PI * x);
        const t = i / (taps - 1);
        const w = 0.35875 - 0.48829 * Math.cos(2 * Math.PI * t) + 0.14128 * Math.cos(4 * Math.PI * t) - 0.01168 * Math.cos(6 * Math.PI * t);
        h[i] = sinc * w;
        sum += h[i];
    }
    for (let i = 0; i < taps; i++)
        h[i] /= sum;
    return h;
}
export function complexBandpassTaps(loHz, hiHz, rate, taps) {
    const center = (loHz + hiHz) / 2, half = Math.abs(hiHz - loHz) / 2;
    const lp = lowpassTaps(half / rate, taps);
    const out = new Float32Array(taps * 2), m = (taps - 1) / 2, w = 2 * Math.PI * center / rate;
    for (let i = 0; i < taps; i++) {
        out[2 * i] = lp[i] * Math.cos(w * (i - m));
        out[2 * i + 1] = lp[i] * Math.sin(w * (i - m));
    }
    return out;
}
export class ComplexFirDecimator {
    constructor(h, decim) {
        this.h = h;
        this.decim = decim;
        this.pos = 0;
        this.phase = 0;
        this.hist = new Float32Array(h.length * 2);
    }
    reset() { this.hist.fill(0); this.pos = 0; this.phase = 0; }
    process(inp, n, out) {
        const h = this.h, taps = h.length, hist = this.hist, D = this.decim;
        let o = 0, pos = this.pos, ph = this.phase;
        for (let i = 0; i < n; i++) {
            hist[2 * pos] = inp[2 * i];
            hist[2 * pos + 1] = inp[2 * i + 1];
            if (++ph >= D) {
                ph = 0;
                let sI = 0, sQ = 0, k = pos;
                for (let t = 0; t < taps; t++) {
                    const c = h[t];
                    sI += c * hist[2 * k];
                    sQ += c * hist[2 * k + 1];
                    if (--k < 0)
                        k = taps - 1;
                }
                out[2 * o] = sI;
                out[2 * o + 1] = sQ;
                o++;
            }
            if (++pos >= taps)
                pos = 0;
        }
        this.pos = pos;
        this.phase = ph;
        return o;
    }
}
export class Cic3Decimator {
    constructor(D, scale = 256) {
        this.D = D;
        this.scale = scale;
        this.i1r = 0;
        this.i1i = 0;
        this.i2r = 0;
        this.i2i = 0;
        this.i3r = 0;
        this.i3i = 0;
        this.c1r = 0;
        this.c1i = 0;
        this.c2r = 0;
        this.c2i = 0;
        this.c3r = 0;
        this.c3i = 0;
        this.ph = 0;
        this.gain = 1 / (scale * D * D * D);
    }
    reset() { this.i1r = this.i1i = this.i2r = this.i2i = this.i3r = this.i3i = 0; this.c1r = this.c1i = this.c2r = this.c2i = this.c3r = this.c3i = 0; this.ph = 0; }
    process(inp, n, out) {
        const D = this.D, s = this.scale, g = this.gain;
        let i1r = this.i1r, i1i = this.i1i, i2r = this.i2r, i2i = this.i2i, i3r = this.i3r, i3i = this.i3i, ph = this.ph, o = 0;
        for (let i = 0; i < n; i++) {
            i1r = (i1r + Math.round(inp[2 * i] * s)) | 0;
            i1i = (i1i + Math.round(inp[2 * i + 1] * s)) | 0;
            i2r = (i2r + i1r) | 0;
            i2i = (i2i + i1i) | 0;
            i3r = (i3r + i2r) | 0;
            i3i = (i3i + i2i) | 0;
            if (++ph >= D) {
                ph = 0;
                const y1r = (i3r - this.c1r) | 0, y1i = (i3i - this.c1i) | 0;
                this.c1r = i3r;
                this.c1i = i3i;
                const y2r = (y1r - this.c2r) | 0, y2i = (y1i - this.c2i) | 0;
                this.c2r = y1r;
                this.c2i = y1i;
                const y3r = (y2r - this.c3r) | 0, y3i = (y2i - this.c3i) | 0;
                this.c3r = y2r;
                this.c3i = y2i;
                out[2 * o] = y3r * g;
                out[2 * o + 1] = y3i * g;
                o++;
            }
        }
        this.i1r = i1r;
        this.i1i = i1i;
        this.i2r = i2r;
        this.i2i = i2i;
        this.i3r = i3r;
        this.i3i = i3i;
        this.ph = ph;
        return o;
    }
}
export class ComplexBandpassToReal {
    constructor(h) {
        this.h = h;
        this.pos = 0;
        this.hist = new Float32Array(h.length);
    }
    setTaps(h) { if (h.length !== this.h.length) {
        this.hist.fill(0);
        this.pos = 0;
    } this.h = h; }
    reset() { this.hist.fill(0); this.pos = 0; }
    process(inp, n, out) {
        const h = this.h, taps = h.length >> 1, hist = this.hist;
        let pos = this.pos;
        for (let i = 0; i < n; i++) {
            hist[2 * pos] = inp[2 * i];
            hist[2 * pos + 1] = inp[2 * i + 1];
            let re = 0, k = pos;
            for (let t = 0; t < taps; t++) {
                re += h[2 * t] * hist[2 * k] - h[2 * t + 1] * hist[2 * k + 1];
                if (--k < 0)
                    k = taps - 1;
            }
            out[i] = re;
            if (++pos >= taps)
                pos = 0;
        }
        this.pos = pos;
    }
}
export class RealFir {
    constructor(h) {
        this.h = h;
        this.pos = 0;
        this.hist = new Float32Array(h.length);
    }
    reset() { this.hist.fill(0); this.pos = 0; }
    process(inp, n, out) {
        const h = this.h, taps = h.length, hist = this.hist;
        let pos = this.pos;
        for (let i = 0; i < n; i++) {
            hist[pos] = inp[i];
            let s = 0, k = pos;
            for (let t = 0; t < taps; t++) {
                s += h[t] * hist[k];
                if (--k < 0)
                    k = taps - 1;
            }
            out[i] = s;
            if (++pos >= taps)
                pos = 0;
        }
        this.pos = pos;
    }
}
export class Mixer {
    constructor(rate, hz = 0) {
        this.rate = rate;
        this.hz = 0;
        this.cr = 1;
        this.ci = 0;
        this.dr = 1;
        this.di = 0;
        this.setFreq(hz);
    }
    setRate(rate) { this.rate = rate; this.setFreq(this.hz); }
    setFreq(hz) { this.hz = hz; const w = -2 * Math.PI * hz / this.rate; this.dr = Math.cos(w); this.di = Math.sin(w); }
    get freq() { return this.hz; }
    process(inp, n, out) {
        let cr = this.cr, ci = this.ci;
        const dr = this.dr, di = this.di;
        for (let i = 0; i < n; i++) {
            const a = inp[2 * i], b = inp[2 * i + 1];
            out[2 * i] = a * cr - b * ci;
            out[2 * i + 1] = a * ci + b * cr;
            const nr = cr * dr - ci * di;
            ci = cr * di + ci * dr;
            cr = nr;
            if ((i & 1023) === 1023) {
                const g = 1 / Math.sqrt(cr * cr + ci * ci);
                cr *= g;
                ci *= g;
            }
        }
        this.cr = cr;
        this.ci = ci;
    }
}
export class DcBlock {
    constructor(r = 0.995) {
        this.r = r;
        this.x1 = 0;
        this.y1 = 0;
    }
    process(buf, n) { for (let i = 0; i < n; i++) {
        const x = buf[i];
        const y = x - this.x1 + this.r * this.y1;
        this.x1 = x;
        this.y1 = y;
        buf[i] = y;
    } }
}
export class Goertzel {
    constructor(hz, rate, block) {
        this.block = block;
        this.s1 = 0;
        this.s2 = 0;
        this.n = 0;
        this.coeff = 2 * Math.cos(2 * Math.PI * hz / rate);
    }
    push(x) {
        const s0 = x + this.coeff * this.s1 - this.s2;
        this.s2 = this.s1;
        this.s1 = s0;
        if (++this.n >= this.block) {
            const p = this.s1 * this.s1 + this.s2 * this.s2 - this.coeff * this.s1 * this.s2;
            this.s1 = 0;
            this.s2 = 0;
            this.n = 0;
            return p / this.block;
        }
        return -1;
    }
}
export class Agc {
    constructor(rate, target = 0.35, attackMs = 3, decayMs = 500, hangMs = 250, maxGain = 2000) {
        this.rate = rate;
        this.target = target;
        this.maxGain = maxGain;
        this.gain = 1;
        this.env = 0;
        this.hang = 0;
        this.attack = 1 - Math.exp(-1 / (rate * attackMs / 1000));
        this.decay = 1 - Math.exp(-1 / (rate * decayMs / 1000));
        this.hangSamples = Math.round(rate * hangMs / 1000);
    }
    setSpeed(decayMs, hangMs) { this.decay = 1 - Math.exp(-1 / (this.rate * decayMs / 1000)); this.hangSamples = Math.round(this.rate * hangMs / 1000); }
    process(buf, n) {
        for (let i = 0; i < n; i++) {
            const a = Math.abs(buf[i]);
            if (a > this.env) {
                this.env += this.attack * (a - this.env);
                this.hang = this.hangSamples;
            }
            else if (this.hang > 0)
                this.hang--;
            else
                this.env += this.decay * (a - this.env);
            const want = this.env > 1e-6 ? this.target / this.env : this.maxGain;
            this.gain = Math.min(this.maxGain, want);
            buf[i] *= this.gain;
        }
    }
}
export class NoiseReducer {
    constructor() {
        this.N = 512;
        this.hop = 256;
        this.win = new Float32Array(512);
        this.inBuf = new Float32Array(512);
        this.outBuf = new Float32Array(768);
        this.re = new Float32Array(512);
        this.im = new Float32Array(512);
        this.noise = new Float32Array(257);
        this.inFill = 256;
        this.outRead = 0;
        this.frames = 0;
        this.strength = 1.0;
        this.floor = 0.12;
        for (let i = 0; i < 512; i++)
            this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 512);
        this.noise.fill(1e-3);
    }
    reset() { this.inBuf.fill(0); this.outBuf.fill(0); this.inFill = 256; this.outRead = 0; this.noise.fill(1e-3); this.frames = 0; }
    process(buf, n) {
        for (let i = 0; i < n; i++) {
            this.inBuf[this.inFill++] = buf[i];
            if (this.inFill === this.N) {
                this.frame();
                this.inFill = this.hop;
            }
            buf[i] = this.outBuf[this.outRead];
            this.outBuf[this.outRead] = 0;
            if (++this.outRead >= this.N)
                this.outRead = 0;
        }
    }
    frame() {
        const N = this.N, re = this.re, im = this.im;
        for (let i = 0; i < N; i++) {
            re[i] = this.inBuf[i] * this.win[i];
            im[i] = 0;
        }
        fftInPlace(re, im, false);
        const slowUp = this.frames < 20 ? 0.5 : 0.003, fastDown = 0.3;
        for (let k = 0; k <= N / 2; k++) {
            const p = re[k] * re[k] + im[k] * im[k];
            const nz = this.noise[k];
            this.noise[k] = p < nz ? nz + fastDown * (p - nz) : nz + slowUp * (p - nz);
            const g = Math.max(this.floor, Math.min(1, (p - this.strength * this.noise[k]) / (p + 1e-12)));
            re[k] *= g;
            im[k] *= g;
            if (k > 0 && k < N / 2) {
                re[N - k] = re[k];
                im[N - k] = -im[k];
            }
        }
        fftInPlace(re, im, true);
        this.frames++;
        for (let i = 0; i < N; i++) {
            const o = (this.outRead + i) % N;
            this.outBuf[o] += re[i] * this.win[i] * (2 / 3);
        }
        this.inBuf.copyWithin(0, this.hop, N);
    }
}
export class AutoNotch {
    constructor(taps = 64, delay = 48, mu = 0.002) {
        this.taps = taps;
        this.delay = delay;
        this.mu = mu;
        this.pos = 0;
        this.w = new Float32Array(taps);
        this.x = new Float32Array(taps + delay + 1);
    }
    reset() { this.w.fill(0); this.x.fill(0); this.pos = 0; }
    process(buf, n) {
        const L = this.x.length, w = this.w, x = this.x, taps = this.taps, d = this.delay;
        for (let i = 0; i < n; i++) {
            const s = buf[i];
            x[this.pos] = s;
            let y = 0, k = this.pos - d;
            if (k < 0)
                k += L;
            let pw = 0;
            for (let t = 0; t < taps; t++) {
                const v = x[k];
                y += w[t] * v;
                pw += v * v;
                if (--k < 0)
                    k = L - 1;
            }
            const e = s - y;
            const g = this.mu / (pw + 1e-3);
            k = this.pos - d;
            if (k < 0)
                k += L;
            for (let t = 0; t < taps; t++) {
                w[t] += g * e * x[k];
                if (--k < 0)
                    k = L - 1;
            }
            buf[i] = e;
            if (++this.pos >= L)
                this.pos = 0;
        }
    }
}
export function fftInPlace(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1)
            j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = re[i];
            re[i] = re[j];
            re[j] = tr;
            const ti = im[i];
            im[i] = im[j];
            im[j] = ti;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = cr * re[b] - ci * im[b], ti = cr * im[b] + ci * re[b];
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
    if (inverse)
        for (let i = 0; i < n; i++) {
            re[i] /= n;
            im[i] /= n;
        }
}
export class Resampler {
    constructor(ratio) {
        this.ratio = ratio;
        this.frac = 0;
        this.last = 0;
    }
    process(inp, n, out) {
        let o = 0, f = this.frac, prev = this.last;
        const step = 1 / this.ratio;
        for (let i = 0; i < n; i++) {
            const cur = inp[i];
            while (f < 1) {
                out[o++] = prev + (cur - prev) * f;
                f += step;
            }
            f -= 1;
            prev = cur;
        }
        this.frac = f;
        this.last = prev;
        return o;
    }
}
