import { Cic3Decimator, Agc, AutoNotch, ComplexBandpassToReal, ComplexFirDecimator, DcBlock, Mixer, NoiseReducer, RealFir, Resampler, complexBandpassTaps, lowpassTaps } from './filters.js';
import { SubAudioDecoder } from './ctcss.js';
const AUDIO_RATE = 48000;
export class HamDemod {
    get carrier() { return this.lastDb > this.floorDb + 6; }
    get tone() { return this.sub.tone; }
    setFmTaps(taps) {
        this.fmTaps = taps;
        const half = taps.reduce((m, t) => Math.max(m, t.minHalf ?? 0), 0);
        if (half !== this.minHalf) {
            this.minHalf = half;
            this.filterKey = '';
            this.rebuildFilters();
        }
    }
    constructor(emit, sink) {
        this.emit = emit;
        this.sink = sink;
        this.wantsFm = false;
        this.params = { offsetHz: 0, mode: 'USB', lo: 100, hi: 2800, pitch: 600, agc: 'slow', nr: false, anf: false, squelchDb: 0, volume: 1 };
        this.rate = 0;
        this.mixer = new Mixer(1920000, 0);
        this.interRate = AUDIO_RATE;
        this.resampler = null;
        this.agc = new Agc(AUDIO_RATE);
        this.nr = new NoiseReducer();
        this.anf = new AutoNotch();
        this.dcAudio = new DcBlock(0.995);
        this.sub = new SubAudioDecoder(AUDIO_RATE);
        this.tmp = new Float32Array(0);
        this.bufPre = new Float32Array(0);
        this.offRange = false;
        this.pre = null;
        this.bufA = new Float32Array(0);
        this.buf48 = new Float32Array(0);
        this.bufC = new Float32Array(0);
        this.audio = new Float32Array(0);
        this.audio2 = new Float32Array(0);
        this.outChunk = new Float32Array(2048);
        this.outLen = 0;
        this.prevI = 0;
        this.prevQ = 0;
        this.deemph = 0;
        this.wfmDecim = 1;
        this.wfmDeCoef = 0.25;
        this.wfmAcc = 0;
        this.wfmCnt = 0;
        this.wfmDeemph = 0;
        this.audioPeak = 0;
        this.chPow = 0;
        this.chN = 0;
        this.floorDb = NaN;
        this.sqOpen = true;
        this.lastMeter = 0;
        this.lastDb = -200;
        this.filterKey = '';
        this.digital = [];
        this.fmTaps = [];
        this.iqTaps = [];
        this.minHalf = 0;
        this.analogMute = false;
    }
    set(p) {
        Object.assign(this.params, p);
        this.offRange = this.rate > 0 && Math.abs(this.params.offsetHz) > this.rate / 2 - 40000;
        this.mixer.setFreq(this.params.offsetHz - (this.params.mode === 'CW' ? this.params.pitch : 0));
        this.rebuildFilters();
        if (p.agc)
            this.agc.setSpeed(p.agc === 'fast' ? 120 : 600, p.agc === 'fast' ? 60 : 300);
    }
    reset(rate) {
        this.rate = rate;
        this.offRange = Math.abs(this.params.offsetHz) > rate / 2 - 40000;
        this.mixer.setRate(rate);
        const preD = rate > 3840000 ? Math.max(2, Math.round(rate / 1920000)) : 1;
        this.pre = preD > 1 ? new Cic3Decimator(preD) : null;
        const base = rate / preD;
        const a = 8, b = Math.max(1, Math.round(base / a / AUDIO_RATE));
        this.stageA = new ComplexFirDecimator(lowpassTaps(0.45 / a, 63), a);
        this.stageB = new ComplexFirDecimator(lowpassTaps(0.42 / b, 63), b);
        this.interRate = base / a / b;
        this.wfmDecim = b;
        this.wfmDeCoef = 1 - Math.exp(-1 / (this.interRate * 75e-6));
        this.resampler = Math.abs(this.interRate - AUDIO_RATE) > 1 ? new Resampler(AUDIO_RATE / this.interRate) : null;
        this.filterKey = '';
        this.rebuildFilters();
        this.audioLp = new RealFir(lowpassTaps(3000 / this.interRate, 63));
        this.agc.setSpeed(this.params.agc === 'fast' ? 120 : 600, this.params.agc === 'fast' ? 60 : 300);
        this.nr.reset();
        this.anf.reset();
        this.sub.reset(this.interRate);
        this.prevI = this.prevQ = this.deemph = 0;
        this.wfmAcc = this.wfmCnt = this.wfmDeemph = 0;
        this.chPow = 0;
        this.chN = 0;
        this.floorDb = NaN;
        this.outLen = 0;
        this.emit({ type: 'log', line: `HAM: ${(rate / 1e6).toFixed(2)} Msps${this.pre ? ` → CIC/${preD}` : ''} → ${this.interRate} Hz baseband${this.resampler ? ' (resampled to 48 k)' : ''}` });
    }
    rebuildFilters() {
        const p = this.params, r = this.interRate;
        const key = `${p.mode}|${p.lo}|${p.hi}|${p.pitch}|${r}|${this.minHalf}`;
        if (key === this.filterKey)
            return;
        this.filterKey = key;
        if (p.mode === 'WFM')
            return;
        const taps = 255;
        if (p.mode === 'USB')
            this.ssb = new ComplexBandpassToReal(complexBandpassTaps(p.lo, p.hi, r, taps));
        else if (p.mode === 'LSB')
            this.ssb = new ComplexBandpassToReal(complexBandpassTaps(-p.hi, -p.lo, r, taps));
        else if (p.mode === 'CW') {
            const w = Math.max(50, p.hi - p.lo);
            this.ssb = new ComplexBandpassToReal(complexBandpassTaps(p.pitch - w / 2, p.pitch + w / 2, r, taps));
        }
        const half = p.mode === 'NFM' ? Math.max(4000, p.hi, this.minHalf) : Math.max(2000, p.hi);
        this.chan = new ComplexFirDecimator(lowpassTaps(half / r, 127), 1);
    }
    demodWfm(buf, n, out) {
        const decim = this.wfmDecim, k = this.wfmDeCoef;
        let m = 0;
        for (let i = 0; i < n; i++) {
            const ci = buf[2 * i], cq = buf[2 * i + 1];
            const d = Math.atan2(cq * this.prevI - ci * this.prevQ, ci * this.prevI + cq * this.prevQ);
            this.prevI = ci;
            this.prevQ = cq;
            this.chPow += ci * ci + cq * cq;
            this.chN++;
            this.wfmAcc += d;
            if (++this.wfmCnt >= decim) {
                const v = this.wfmAcc / this.wfmCnt;
                this.wfmAcc = 0;
                this.wfmCnt = 0;
                this.wfmDeemph += k * (v - this.wfmDeemph);
                out[m++] = this.wfmDeemph * 1.6;
            }
        }
        return m;
    }
    onIq(iq, rate) {
        if (rate !== this.rate)
            this.reset(rate);
        if (this.offRange)
            return;
        const n = iq.length >> 1;
        if (this.tmp.length < 2 * n) {
            this.tmp = new Float32Array(2 * n);
            this.bufPre = new Float32Array(2 * Math.ceil(n / 2) + 8);
            this.bufA = new Float32Array(2 * Math.ceil(n / 8) + 8);
            this.buf48 = new Float32Array(this.bufA.length);
            this.bufC = new Float32Array(this.bufA.length);
            this.audio = new Float32Array(this.bufA.length);
            this.audio2 = new Float32Array(this.bufA.length);
        }
        this.mixer.process(iq, n, this.tmp);
        let src = this.tmp, nPre = n;
        if (this.pre) {
            nPre = this.pre.process(this.tmp, n, this.bufPre);
            src = this.bufPre;
        }
        const nA = this.stageA.process(src, nPre, this.bufA);
        for (const t of this.iqTaps)
            t.onIq240(this.bufA, nA);
        const p = this.params, out = this.audio;
        let m;
        if (p.mode === 'WFM') {
            m = this.demodWfm(this.bufA, nA, out);
            if (m === 0)
                return;
        }
        else {
            const nB = this.stageB.process(this.bufA, nA, this.buf48);
            if (nB === 0)
                return;
            const x = this.buf48;
            m = nB;
            if (p.mode === 'USB' || p.mode === 'LSB' || p.mode === 'CW') {
                this.ssb.process(x, nB, out);
                let pw = 0;
                for (let i = 0; i < nB; i++)
                    pw += out[i] * out[i];
                this.chPow += pw;
                this.chN += nB;
            }
            else {
                this.chan.process(x, nB, this.bufC);
                const c = this.bufC;
                let pw = 0;
                for (let i = 0; i < nB; i++)
                    pw += c[2 * i] * c[2 * i] + c[2 * i + 1] * c[2 * i + 1];
                this.chPow += pw;
                this.chN += nB;
                if (p.mode === 'AM') {
                    for (let i = 0; i < nB; i++)
                        out[i] = Math.sqrt(c[2 * i] * c[2 * i] + c[2 * i + 1] * c[2 * i + 1]);
                    this.dcAudio.process(out, nB);
                }
                else {
                    for (let i = 0; i < nB; i++) {
                        const ci = c[2 * i], cq = c[2 * i + 1];
                        out[i] = Math.atan2(cq * this.prevI - ci * this.prevQ, ci * this.prevI + cq * this.prevQ);
                        this.prevI = ci;
                        this.prevQ = cq;
                    }
                    this.sub.push(out, nB);
                    for (const tap of this.fmTaps)
                        tap.onFm(out, nB, this.interRate);
                    const a = 1 - Math.exp(-1 / (this.interRate * 530e-6));
                    for (let i = 0; i < nB; i++) {
                        this.deemph += a * (out[i] - this.deemph);
                        out[i] = this.deemph * 0.6;
                    }
                    this.audioLp.process(out, nB, this.audio2);
                    out.set(this.audio2.subarray(0, nB));
                }
            }
        }
        const now = performance.now();
        if (now - this.lastMeter > 100 && this.chN > 0) {
            this.lastMeter = now;
            const db = 10 * Math.log10(this.chPow / this.chN / (127 * 127) + 1e-12);
            this.chPow = 0;
            this.chN = 0;
            this.lastDb = db;
            this.floorDb = Number.isNaN(this.floorDb) ? db : db < this.floorDb ? this.floorDb + 0.2 * (db - this.floorDb) : this.floorDb + 0.003 * (db - this.floorDb);
            const open = p.squelchDb === 0 || p.mode !== 'NFM' || db > this.floorDb + p.squelchDb;
            this.sqOpen = open;
            this.emit({ type: 'ham', db, floor: this.floorDb, open, tone: this.sub.tone, toneDb: this.sub.toneDb, dcs: this.sub.dcs, dcsInv: this.sub.dcsInverted, gain: this.agc.gain, audioPeak: this.audioPeak });
            this.audioPeak = 0;
        }
        if (p.mode !== 'NFM') {
            this.dcAudio.process(out, m);
        }
        if (p.agc !== 'off')
            this.agc.process(out, m);
        else
            for (let i = 0; i < m; i++)
                out[i] *= p.mode === 'NFM' || p.mode === 'WFM' ? 1 : 1 / 64;
        for (const d of this.digital)
            d.push(out, m);
        if (p.nr)
            this.nr.process(out, m);
        if (p.anf)
            this.anf.process(out, m);
        const g = (this.sqOpen && !this.analogMute ? 1 : 0) * p.volume;
        for (let i = 0; i < m; i++) {
            const v = out[i] * g;
            const c = v > 1 ? 1 : v < -1 ? -1 : v;
            out[i] = c;
            const a = c < 0 ? -c : c;
            if (a > this.audioPeak)
                this.audioPeak = a;
        }
        if (this.analogMute) {
            this.outLen = 0;
            return;
        }
        if (this.resampler) {
            m = this.resampler.process(out, m, this.audio2);
            out.set(this.audio2.subarray(0, m));
        }
        for (let i = 0; i < m; i++) {
            this.outChunk[this.outLen++] = out[i];
            if (this.outLen >= this.outChunk.length) {
                this.sink(this.outChunk.slice());
                this.outLen = 0;
            }
        }
    }
}
