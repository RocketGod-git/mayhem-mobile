const RATE = 48000, MS = RATE / 1000;
function martin(name, vis, T) {
    return { name, vis, width: 320, height: 256, line: 4.862 + 0.572 + 3 * (T + 0.572), firstSync: 0, syncLen: 4.862, rows: 1, comps: [{ at: 5.434, dur: T, kind: 'G' }, { at: 5.434 + T + 0.572, dur: T, kind: 'B' }, { at: 5.434 + 2 * (T + 0.572), dur: T, kind: 'R' }] };
}
function scottie(name, vis, T) {
    return { name, vis, width: 320, height: 256, line: 13.5 + 3 * T, firstSync: 12 + 2 * T, syncLen: 9, rows: 1, comps: [{ at: -(2 * T + 1.5), dur: T, kind: 'G' }, { at: -T, dur: T, kind: 'B' }, { at: 10.5, dur: T, kind: 'R' }] };
}
function pd(name, vis, T, width, height) {
    return { name, vis, width, height, line: 22.08 + 4 * T, firstSync: 0, syncLen: 20, rows: 2, comps: [{ at: 22.08, dur: T, kind: 'Y' }, { at: 22.08 + T, dur: T, kind: 'RY' }, { at: 22.08 + 2 * T, dur: T, kind: 'BY' }, { at: 22.08 + 3 * T, dur: T, kind: 'Y2' }] };
}
export const SSTV_MODES = [
    martin('Martin M1', 44, 146.432), martin('Martin M2', 40, 73.216),
    scottie('Scottie S1', 60, 138.24), scottie('Scottie S2', 56, 88.064), scottie('Scottie DX', 76, 345.6),
    { name: 'Robot 36', vis: 8, width: 320, height: 240, line: 150, firstSync: 0, syncLen: 9, rows: 1, comps: [{ at: 12, dur: 88, kind: 'Y' }, { at: 106, dur: 44, kind: 'RY', odd: 'BY' }] },
    { name: 'Robot 72', vis: 12, width: 320, height: 240, line: 300, firstSync: 0, syncLen: 9, rows: 1, comps: [{ at: 12, dur: 138, kind: 'Y' }, { at: 156, dur: 69, kind: 'RY' }, { at: 231, dur: 69, kind: 'BY' }] },
    pd('PD50', 93, 91.52, 320, 256), pd('PD90', 99, 170.24, 320, 256), pd('PD120', 95, 121.6, 640, 496), pd('PD160', 98, 195.584, 512, 400),
    pd('PD180', 96, 183.04, 640, 496), pd('PD240', 97, 244.48, 640, 496), pd('PD290', 94, 228.8, 800, 616),
];
export class SstvDecoder {
    constructor() {
        this.name = 'SSTV';
        this.confidence = 0;
        this.onText = () => { };
        this.onImage = () => { };
        this.freq = new Float32Array(RATE * 6);
        this.n = 0;
        this.cr = 1;
        this.ci = 0;
        this.dr = Math.cos(-2 * Math.PI * 1900 / RATE);
        this.di = Math.sin(-2 * Math.PI * 1900 / RATE);
        this.i1 = 0;
        this.i2 = 0;
        this.i3 = 0;
        this.i4 = 0;
        this.q1 = 0;
        this.q2 = 0;
        this.q3 = 0;
        this.q4 = 0;
        this.a = 1 - Math.exp(-2 * Math.PI * 1100 / RATE);
        this.pi = 1;
        this.pq = 0;
        this.sm = 1900;
        this.tick = 0;
        this.state = 0;
        this.leader = 0;
        this.tStart = 0;
        this.visChecked = false;
        this.mode = null;
        this.tImg = 0;
        this.line = 0;
        this.corr = 0;
        this.missed = 0;
        this.rows = new Uint8ClampedArray(0);
        this.cb = new Float32Array(0);
        this.crRow = new Float32Array(0);
        this.lastImage = -1e9;
        this.y = new Float32Array(1024);
        this.u = new Float32Array(1024);
        this.v = new Float32Array(1024);
        this.y2 = new Float32Array(1024);
        this.rgbTmp = new Float32Array(1024 * 3);
    }
    reset() { this.n = 0; this.state = 0; this.leader = 0; this.mode = null; this.confidence = 0; this.sm = 1900; this.freq.fill(1900); }
    push(a, n) {
        const f = this.freq, len = f.length, al = this.a;
        for (let k = 0; k < n; k++) {
            const x = a[k];
            const i = x * this.cr, q = x * this.ci;
            const nr = this.cr * this.dr - this.ci * this.di;
            this.ci = this.cr * this.di + this.ci * this.dr;
            this.cr = nr;
            this.i1 += al * (i - this.i1);
            this.i2 += al * (this.i1 - this.i2);
            this.i3 += al * (this.i2 - this.i3);
            this.i4 += al * (this.i3 - this.i4);
            this.q1 += al * (q - this.q1);
            this.q2 += al * (this.q1 - this.q2);
            this.q3 += al * (this.q2 - this.q3);
            this.q4 += al * (this.q3 - this.q4);
            const re = this.i4 * this.pi + this.q4 * this.pq, im = this.q4 * this.pi - this.i4 * this.pq;
            this.pi = this.i4;
            this.pq = this.q4;
            const hz = 1900 + Math.atan2(im, re) * RATE / (2 * Math.PI);
            this.sm += 0.35 * (hz - this.sm);
            f[this.n % len] = this.sm;
            this.n++;
            if (++this.tick >= 48) {
                this.tick = 0;
                this.onTick();
                if ((this.n & 0xffff) === 0) {
                    const g = 1 / Math.hypot(this.cr, this.ci);
                    this.cr *= g;
                    this.ci *= g;
                }
            }
        }
    }
    mean(from, to) {
        const f = this.freq, len = f.length, a = Math.max(Math.floor(from), this.n - len), b = Math.min(Math.floor(to), this.n);
        if (b <= a)
            return 1900;
        let s = 0;
        for (let i = a; i < b; i++)
            s += f[i % len];
        return s / (b - a);
    }
    onTick() {
        const now = this.n, fa = this.mean(now - 48, now);
        if (this.state === 3) {
            this.decodeReady();
            if (now - this.lastImage > 3 * RATE)
                this.confidence = Math.max(0, this.confidence - 0.05);
            return;
        }
        if (this.state === 0 || this.state === 1) {
            if (Math.abs(fa - 1900) < 70) {
                this.leader++;
                if (this.leader >= 100)
                    this.state = 1;
            }
            else if (this.state === 1 && fa < 1350) {
                let best = now - 48, bestD = -1;
                for (let t = now - 3 * MS; t <= now - 24; t += 2) {
                    const d = this.mean(t - MS, t) - this.mean(t, t + 24);
                    if (d > bestD) {
                        bestD = d;
                        best = t;
                    }
                }
                this.tStart = best;
                this.state = 2;
                this.visChecked = false;
            }
            else
                this.leader = 0;
            return;
        }
        if (this.state === 2 && !this.visChecked && now >= this.tStart + 22 * MS) {
            this.visChecked = true;
            if (this.mean(this.tStart + 12 * MS, this.tStart + 20 * MS) > 1600) {
                this.state = 1;
                return;
            }
        }
        if (this.state === 2 && now >= this.tStart + 315 * MS) {
            let code = 0, ones = 0, ok = true;
            for (let i = 0; i < 8; i++) {
                const fb = this.mean(this.tStart + (30 * (i + 1) + 8) * MS, this.tStart + (30 * (i + 1) + 22) * MS);
                const one = Math.abs(fb - 1100) < 80, zero = Math.abs(fb - 1300) < 80;
                if (!one && !zero) {
                    ok = false;
                    break;
                }
                if (one) {
                    ones++;
                    if (i < 7)
                        code |= 1 << i;
                }
            }
            const mode = ok && (ones & 1) === 0 ? SSTV_MODES.find(m => m.vis === code) : undefined;
            if (!mode) {
                this.state = 0;
                this.leader = 0;
                return;
            }
            this.start(mode, this.tStart + 300 * MS);
        }
    }
    start(mode, tImg) {
        this.mode = mode;
        this.tImg = tImg;
        this.line = 0;
        this.corr = 0;
        this.missed = 0;
        this.state = 3;
        this.rows = new Uint8ClampedArray(mode.width * 4 * mode.rows);
        this.cb = new Float32Array(mode.width).fill(128);
        this.crRow = new Float32Array(mode.width).fill(128);
        this.confidence = 1;
        this.lastImage = this.n;
        this.onText(`\n[SSTV ${mode.name} · ${mode.width}×${mode.height}]\n`, 'SSTV');
    }
    decodeReady() {
        const m = this.mode;
        while (this.state === 3) {
            const scan = this.line / m.rows;
            const tRef = this.tImg + (m.firstSync + scan * m.line) * MS + this.corr;
            let tEnd = tRef;
            for (const c of m.comps)
                tEnd = Math.max(tEnd, tRef + (c.at + c.dur) * MS);
            if (this.n < tEnd + 4 * MS)
                return;
            this.decodeScan(m, tRef);
            this.line += m.rows;
            if (this.line >= m.height) {
                this.state = 0;
                this.leader = 0;
                this.onText(`[SSTV ${m.name} complete]\n`, 'SSTV');
                this.confidence = 0.6;
                return;
            }
            if (this.missed > 12) {
                this.state = 0;
                this.leader = 0;
                this.onText(`[SSTV ${m.name} lost after ${this.line} lines]\n`, 'SSTV');
                this.confidence = 0;
                return;
            }
        }
    }
    decodeScan(m, tRef) {
        const w = Math.floor(Math.min(m.syncLen / 2, 3) * MS);
        let best = tRef, bestD = -1e9, bestF = 1e9;
        for (let t = tRef - 3 * MS; t <= tRef + 3 * MS; t += 4) {
            const after = this.mean(t, t + w), d = this.mean(t - w, t) - after;
            if (d > bestD) {
                bestD = d;
                best = t;
                bestF = after;
            }
        }
        if (bestF < 1400 && bestD > 150) {
            const e = best - tRef;
            this.corr += 0.7 * e;
            tRef += 0.7 * e;
            this.missed = 0;
        }
        else
            this.missed++;
        const W = m.width, y = this.y, u = this.u, v = this.v, y2 = this.y2, rgb = this.rgbTmp;
        const odd = (this.line & 1) === 1;
        let haveRgb = false, haveY2 = false;
        for (const c of m.comps) {
            const kind = odd && c.odd ? c.odd : c.kind;
            const step = c.dur * MS / W, t0 = tRef + c.at * MS;
            const dst = kind === 'Y' ? y : kind === 'Y2' ? y2 : kind === 'RY' ? v : kind === 'BY' ? u : null;
            for (let k = 0; k < W; k++) {
                const f = this.mean(t0 + k * step, t0 + (k + 1) * step);
                const val = Math.max(0, Math.min(255, (f - 1500) / 800 * 255));
                if (dst)
                    dst[k] = val;
                else {
                    rgb[k * 3 + (kind === 'R' ? 0 : kind === 'G' ? 1 : 2)] = val;
                    haveRgb = true;
                }
            }
            if (kind === 'Y2')
                haveY2 = true;
            if (kind === 'RY')
                this.crRow.set(v.subarray(0, W));
            if (kind === 'BY')
                this.cb.set(u.subarray(0, W));
        }
        const out = this.rows;
        const yuv = (Y, row) => {
            for (let k = 0; k < W; k++) {
                const cr = this.crRow[k] - 128, cb = this.cb[k] - 128, o = (row * W + k) * 4;
                out[o] = Y[k] + 1.402 * cr;
                out[o + 1] = Y[k] - 0.344 * cb - 0.714 * cr;
                out[o + 2] = Y[k] + 1.772 * cb;
                out[o + 3] = 255;
            }
        };
        if (haveRgb)
            for (let k = 0; k < W; k++) {
                const o = k * 4;
                out[o] = rgb[k * 3];
                out[o + 1] = rgb[k * 3 + 1];
                out[o + 2] = rgb[k * 3 + 2];
                out[o + 3] = 255;
            }
        else {
            yuv(y, 0);
            if (haveY2)
                yuv(y2, 1);
        }
        this.lastImage = this.n;
        this.confidence = 1;
        this.onImage({ mode: m.name, width: W, height: m.height, line: this.line, count: m.rows, rows: out.slice() });
    }
}
