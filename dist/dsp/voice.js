import { fft } from '../fft.js';
const NF = 512;
const ENV = 128;
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
export class VoiceDetector {
    constructor() {
        this.buf = new Float32Array(NF);
        this.n = 0;
        this.re = new Float32Array(NF);
        this.im = new Float32Array(NF);
        this.win = new Float32Array(NF);
        this.env = new Float32Array(ENV);
        this.envDb = new Float32Array(ENV);
        this.envN = 0;
        this.filled = 0;
        this.bandAvg = 0;
        this.ere = new Float32Array(ENV);
        this.eim = new Float32Array(ENV);
        this.envRate = 48000 / NF;
        this.loBin = Math.max(1, Math.round(2 * ENV / this.envRate));
        this.hiBin = Math.min(ENV / 2 - 1, Math.round(8 * ENV / this.envRate));
        for (let i = 0; i < NF; i++)
            this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
    }
    reset() { this.n = 0; this.envN = 0; this.filled = 0; this.bandAvg = 0; this.env.fill(0); this.envDb.fill(0); }
    push(a, len) {
        for (let i = 0; i < len; i++) {
            this.buf[this.n++] = a[i];
            if (this.n >= NF) {
                this.frame();
                this.n = 0;
            }
        }
    }
    frame() {
        const re = this.re, im = this.im, b = this.buf, w = this.win;
        let sq = 0;
        for (let i = 0; i < NF; i++) {
            const v = b[i];
            sq += v * v;
            re[i] = v * w[i];
            im[i] = 0;
        }
        fft(re, im);
        const bin = (hz) => Math.round(hz * NF / 48000);
        let inBand = 0, wide = 0;
        for (let k = bin(100); k <= bin(8000); k++) {
            const p = re[k] * re[k] + im[k] * im[k];
            wide += p;
            if (k >= bin(300) && k <= bin(3400))
                inBand += p;
        }
        const rms = Math.sqrt(sq / NF);
        this.env[this.envN] = rms;
        this.envDb[this.envN] = 20 * Math.log10(rms + 1e-9);
        this.envN = (this.envN + 1) % ENV;
        if (this.filled < ENV)
            this.filled++;
        const ratio = wide > 0 ? inBand / wide : 0;
        this.bandAvg += 0.1 * (ratio - this.bandAvg);
    }
    read() {
        if (this.filled < ENV)
            return { score: 0, band: this.bandAvg, mod: 0, vary: 0, levelDb: -99 };
        const env = this.env, ere = this.ere, eim = this.eim;
        let mean = 0;
        for (let i = 0; i < ENV; i++)
            mean += env[i];
        mean /= ENV;
        for (let i = 0; i < ENV; i++) {
            ere[i] = env[(this.envN + i) % ENV] - mean;
            eim[i] = 0;
        }
        fft(ere, eim);
        let syl = 0;
        for (let k = this.loBin; k <= this.hiBin; k++)
            syl += ere[k] * ere[k] + eim[k] * eim[k];
        const mod = mean > 0 ? Math.sqrt(syl / ENV) / (mean * ENV / 2) : 0;
        let dbMean = 0;
        for (let i = 0; i < ENV; i++)
            dbMean += this.envDb[i];
        dbMean /= ENV;
        let vsum = 0;
        for (let i = 0; i < ENV; i++) {
            const d = this.envDb[i] - dbMean;
            vsum += d * d;
        }
        const vary = Math.sqrt(vsum / ENV);
        const levelDb = 20 * Math.log10(mean + 1e-9);
        if (levelDb < -46)
            return { score: 0, band: this.bandAvg, mod, vary, levelDb };
        const band = clamp01((this.bandAvg - 0.35) / 0.30);
        const rhythm = clamp01((mod - 0.06) / 0.14);
        const moving = clamp01((vary - 2) / 6);
        return { score: 0.35 * band + 0.40 * rhythm + 0.25 * moving, band: this.bandAvg, mod, vary, levelDb };
    }
}
