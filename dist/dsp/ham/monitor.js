import { fft, hann, loadIqAt, accumulatePower, powerDbFrom } from '../../fft.js';
import { ComplexFirDecimator, Mixer, RealFir, lowpassTaps } from './filters.js';
import { SubAudioDecoder } from './ctcss.js';
const FFT_N = 4096, AUDIO_RATE = 48000;
class ChannelDemod {
    constructor(rate, offsetHz, nMax, interRate, decA, decB) {
        this.interRate = interRate;
        this.prevI = 0;
        this.prevQ = 0;
        this.deemph = 0;
        this.mixer = new Mixer(rate, offsetHz);
        this.a = new ComplexFirDecimator(lowpassTaps(0.42 / decA, decA >= 16 ? 127 : 63), decA);
        this.b = new ComplexFirDecimator(lowpassTaps(6000 / (rate / decA), 63), decB);
        this.lp = new RealFir(lowpassTaps(3000 / interRate, 47));
        this.sub = new SubAudioDecoder(interRate);
        const na = Math.ceil(nMax / decA) + 8;
        this.bufA = new Float32Array(2 * na);
        this.buf48 = new Float32Array(2 * na);
        this.audio = new Float32Array(na);
        this.audio2 = new Float32Array(na);
    }
    process(iq, n, tmp) {
        this.mixer.process(iq, n, tmp);
        const nA = this.a.process(tmp, n, this.bufA);
        const nB = this.b.process(this.bufA, nA, this.buf48);
        const c = this.buf48, out = this.audio;
        for (let i = 0; i < nB; i++) {
            const ci = c[2 * i], cq = c[2 * i + 1];
            out[i] = Math.atan2(cq * this.prevI - ci * this.prevQ, ci * this.prevI + cq * this.prevQ);
            this.prevI = ci;
            this.prevQ = cq;
        }
        this.sub.push(out, nB);
        const a = 1 - Math.exp(-1 / (this.interRate * 530e-6));
        for (let i = 0; i < nB; i++) {
            this.deemph += a * (out[i] - this.deemph);
            out[i] = this.deemph * 1.2;
        }
        this.lp.process(out, nB, this.audio2);
        out.set(this.audio2.subarray(0, nB));
        return nB;
    }
}
export class BandMonitor {
    constructor(emit, sink) {
        this.emit = emit;
        this.sink = sink;
        this.wantsFm = false;
        this.params = { spacingHz: 12500, originHz: 144000000, thresholdDb: 8, mode: 'mix', lock: -1, maxDemods: 3, volume: 1 };
        this.centreHz = 146000000;
        this.rate = 0;
        this.re = new Float32Array(FFT_N);
        this.im = new Float32Array(FFT_N);
        this.acc = new Float32Array(FFT_N);
        this.pdb = new Float32Array(FFT_N);
        this.win = hann(FFT_N);
        this.frames = 0;
        this.chanHz = new Float64Array(0);
        this.power = new Float32Array(0);
        this.floor = new Float32Array(0);
        this.snr = new Float32Array(0);
        this.open = [];
        this.openedAt = new Float64Array(0);
        this.tones = new Float32Array(0);
        this.dcs = new Int32Array(0);
        this.demods = new Map();
        this.order = [];
        this.tmp = new Float32Array(0);
        this.mix = new Float32Array(0);
        this.outChunk = new Float32Array(2048);
        this.outLen = 0;
        this.lastReport = 0;
        this.lastPlan = '';
        this.decA = 8;
        this.decB = 5;
        this.interRate = AUDIO_RATE;
    }
    set(p) {
        if (p.centreHz !== undefined)
            this.centreHz = p.centreHz;
        Object.assign(this.params, p);
        this.plan();
    }
    reset(rate) {
        this.rate = rate;
        this.decA = rate >= 3000000 ? 16 : 8;
        this.decB = Math.max(1, Math.round(rate / this.decA / AUDIO_RATE));
        this.interRate = rate / this.decA / this.decB;
        this.demods.clear();
        this.order = [];
        this.frames = 0;
        this.acc.fill(0);
        this.lastPlan = '';
        this.plan();
        this.emit({ type: 'log', line: `MONITOR: ${(rate / 1e6).toFixed(2)} Msps · ${this.chanHz.length} channels @ ${this.params.spacingHz / 1e3} kHz` });
    }
    plan() {
        if (!this.rate)
            return;
        const p = this.params, half = this.rate / 2 - 40000;
        const key = `${this.centreHz}|${this.rate}|${p.spacingHz}|${p.originHz}`;
        if (key === this.lastPlan)
            return;
        this.lastPlan = key;
        const first = Math.ceil((this.centreHz - half - p.originHz) / p.spacingHz), last = Math.floor((this.centreHz + half - p.originHz) / p.spacingHz);
        const n = Math.max(0, last - first + 1);
        this.chanHz = new Float64Array(n);
        for (let k = 0; k < n; k++)
            this.chanHz[k] = p.originHz + (first + k) * p.spacingHz;
        this.power = new Float32Array(n).fill(-120);
        this.floor = new Float32Array(n).fill(NaN);
        this.snr = new Float32Array(n);
        this.open = new Array(n).fill(false);
        this.openedAt = new Float64Array(n);
        this.tones = new Float32Array(n);
        this.dcs = new Int32Array(n);
        this.demods.clear();
        this.order = [];
    }
    channels() { return this.chanHz; }
    onIq(iq, rate) {
        if (rate !== this.rate)
            this.reset(rate);
        const n = iq.length >> 1;
        if (this.tmp.length < 2 * n) {
            this.tmp = new Float32Array(2 * n);
            this.mix = new Float32Array(Math.ceil(n / 8) + 16);
        }
        for (let off = 0; off + FFT_N <= n && this.frames < 64; off += FFT_N) {
            loadIqAt(iq, off, this.re, this.im, this.win);
            fft(this.re, this.im);
            accumulatePower(this.re, this.im, this.acc);
            this.frames++;
        }
        const now = performance.now();
        if (now - this.lastReport > 200 && this.frames > 0) {
            powerDbFrom(this.acc, this.frames, this.pdb);
            this.acc.fill(0);
            this.frames = 0;
            this.measure();
            this.lastReport = now;
            this.report(now);
        }
        const p = this.params;
        let listening = [];
        if (p.mode === 'lock' && p.lock >= 0)
            listening = [p.lock];
        else if (p.mode === 'latest')
            listening = this.order.length ? [this.order[this.order.length - 1]] : [];
        else
            listening = this.order.slice(-p.maxDemods);
        for (const k of listening)
            if (!this.demods.has(k))
                this.demods.set(k, new ChannelDemod(rate, this.chanHz[k] - this.centreHz, n, this.interRate, this.decA, this.decB));
        for (const k of [...this.demods.keys()])
            if (!listening.includes(k) && !(this.open[k] && this.demods.size <= p.maxDemods))
                this.demods.delete(k);
        let m = 0;
        const mix = this.mix;
        let voices = 0;
        for (const k of listening) {
            const d = this.demods.get(k);
            const cnt = d.process(iq, n, this.tmp);
            this.tones[k] = d.sub.tone;
            this.dcs[k] = d.sub.dcs;
            if (voices === 0) {
                mix.set(d.audio.subarray(0, cnt));
                m = cnt;
            }
            else
                for (let i = 0; i < Math.min(m, cnt); i++)
                    mix[i] += d.audio[i];
            voices++;
        }
        if (voices === 0)
            return;
        const g = p.volume / Math.sqrt(voices);
        for (let i = 0; i < m; i++) {
            const v = mix[i] * g;
            this.outChunk[this.outLen++] = v > 1 ? 1 : v < -1 ? -1 : v;
            if (this.outLen >= this.outChunk.length) {
                this.sink(this.outChunk.slice());
                this.outLen = 0;
            }
        }
    }
    measure() {
        const n = this.chanHz.length, binHz = this.rate / FFT_N, p = this.params;
        const halfBins = Math.max(1, Math.floor((p.spacingHz * 0.4) / binHz));
        const now = performance.now();
        for (let k = 0; k < n; k++) {
            const c = Math.round((this.chanHz[k] - this.centreHz) / binHz) + FFT_N / 2;
            let s = 0, cnt = 0;
            for (let b = Math.max(1, c - halfBins); b <= Math.min(FFT_N - 2, c + halfBins); b++) {
                s += Math.pow(10, this.pdb[b] / 10);
                cnt++;
            }
            const db = 10 * Math.log10(s / Math.max(1, cnt) + 1e-12);
            this.power[k] = db;
            const f = this.floor[k];
            this.floor[k] = Number.isNaN(f) ? db : db < f ? f + 0.3 * (db - f) : f + 0.004 * (db - f);
            this.snr[k] = db - this.floor[k];
            const was = this.open[k];
            const isOpen = was ? this.snr[k] > p.thresholdDb - 3 : this.snr[k] > p.thresholdDb;
            if (isOpen && !was) {
                this.open[k] = true;
                this.openedAt[k] = now;
                this.order.push(k);
            }
            else if (!isOpen && was) {
                this.open[k] = false;
                this.order = this.order.filter(x => x !== k);
                this.tones[k] = 0;
                this.dcs[k] = 0;
            }
        }
    }
    report(now) {
        const snr = Float32Array.from(this.snr);
        const openIdx = [];
        for (let k = 0; k < this.open.length; k++)
            if (this.open[k])
                openIdx.push(k);
        const tones = {}, dcs = {};
        for (const k of openIdx) {
            if (this.tones[k])
                tones[k] = this.tones[k];
            if (this.dcs[k])
                dcs[k] = this.dcs[k];
        }
        const listening = [...this.demods.keys()];
        this.emit({ type: 'monitor', snr, open: openIdx, listening, tones, dcs, since: openIdx.map(k => now - this.openedAt[k]), first: this.chanHz[0] ?? 0, spacing: this.params.spacingHz, count: this.chanHz.length }, [snr.buffer]);
    }
}
