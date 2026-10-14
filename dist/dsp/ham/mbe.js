import { fft } from '../../fft.js';
import { W0, LTAB, VUV, LMPRBL, DG, PRBA24, PRBA58, HOC5, HOC6, HOC7, HOC8 } from './mbe-tables.js';
export const GOLAY_GEN = [0x63a, 0x31d, 0x7b4, 0x3da, 0x1ed, 0x6cc, 0x366, 0x1b3, 0x6e3, 0x54b, 0x49f, 0x475];
function golayParity(data, bits) {
    let p = 0;
    for (let j = 0; j < bits; j++)
        if (data & (1 << j))
            p ^= GOLAY_GEN[11 - j];
    return p;
}
function golayTable(n) {
    const t = new Int32Array(2048).fill(-1);
    const syn = (e) => golayParity(e >>> 11, n - 11) ^ (e & 0x7ff);
    t[0] = 0;
    for (let i = 0; i < n; i++) {
        t[syn(1 << i)] = 1 << i;
        for (let j = i + 1; j < n; j++) {
            t[syn((1 << i) | (1 << j))] = (1 << i) | (1 << j);
            for (let k = j + 1; k < n; k++)
                t[syn((1 << i) | (1 << j) | (1 << k))] = (1 << i) | (1 << j) | (1 << k);
        }
    }
    return t;
}
const G23 = golayTable(23), G19 = golayTable(19);
export function golay2312(word) {
    const e = G23[golayParity(word >>> 11, 12) ^ (word & 0x7ff)];
    return e < 0 ? -1 : word ^ e;
}
export function popcount(x) { let c = 0; while (x) {
    x &= x - 1;
    c++;
} return c; }
export function golay208(word19) {
    const e = G19[golayParity(word19 >>> 11, 8) ^ (word19 & 0x7ff)];
    return e < 0 ? -1 : ((word19 ^ e) >>> 11) | (popcount(e) << 8);
}
function newParms() { return { w0: 0, L: 0, gamma: 0, repeat: 0, Vl: new Uint8Array(58), Ml: new Float64Array(58), log2Ml: new Float64Array(58), PHIl: new Float64Array(58), PSIl: new Float64Array(58) }; }
export function copyParms(from, to) {
    to.w0 = from.w0;
    to.L = from.L;
    to.gamma = from.gamma;
    to.repeat = from.repeat;
    to.Vl.set(from.Vl);
    to.Ml.set(from.Ml);
    to.log2Ml.set(from.log2Ml);
    to.PHIl.set(from.PHIl);
    to.PSIl.set(from.PSIl);
    to.Ml[0] = 0;
}
export function initParms(cur, prev, prevEnh) {
    prev.w0 = 0.09378;
    prev.L = 30;
    prev.gamma = 0;
    prev.repeat = 0;
    for (let l = 0; l <= 56; l++) {
        prev.Ml[l] = 0;
        prev.Vl[l] = 0;
        prev.log2Ml[l] = 0;
        prev.PHIl[l] = 0;
        prev.PSIl[l] = Math.PI / 2;
    }
    copyParms(prev, cur);
    copyParms(prev, prevEnh);
}
const N = 160;
const WS = new Float64Array(321);
for (let n = 0; n < 321; n++)
    WS[n] = n <= 55 ? 0 : n <= 105 ? (n - 55) * 0.02 : n <= 215 ? 1 : n <= 265 ? (265 - n) * 0.02 : 0;
const TWO_PI = 2 * Math.PI;
const NFFT = 256, WOFF = N - (NFFT >> 1);
const UV_SCALE = 43.91;
export function c0Clean(fr0) {
    let c0 = 0;
    for (let j = 23; j >= 1; j--)
        c0 = (c0 << 1) | fr0[j];
    const fix = golay2312(c0);
    if (fix < 0 || popcount(fix ^ c0) > 1)
        return false;
    return (popcount(fix) & 1) === fr0[0];
}
export class AmbeDecoder {
    constructor() {
        this.cur = newParms();
        this.prev = newParms();
        this.prevEnh = newParms();
        this.d = new Uint8Array(49);
        this.Tl = new Float64Array(58);
        this.Cik = new Float64Array(5 * 18);
        this.noise = new Float64Array(NFFT);
        this.noiseSeed = 3147;
        this.fre = new Float32Array(NFFT);
        this.fim = new Float32Array(NFFT);
        this.binGain = new Float64Array(NFFT >> 1);
        this.uw = new Float64Array(NFFT);
        this.prevUw = new Float64Array(NFFT);
        this.out = new Float32Array(N);
        this.errs = 0;
        this.status = '';
        this.uvQuality = 3;
        this.repeatErrs = 3;
        initParms(this.cur, this.prev, this.prevEnh);
    }
    reset() { initParms(this.cur, this.prev, this.prevEnh); this.status = ''; this.errs = 0; }
    decode(fr) {
        const d = this.d;
        let errs = 0;
        let c0 = 0;
        for (let j = 23; j >= 1; j--)
            c0 = (c0 << 1) | fr[0][j];
        const c0fix = golay2312(c0);
        if (c0fix < 0)
            errs += 4;
        else {
            errs += popcount((c0fix ^ c0) >>> 11);
            for (let j = 23; j >= 1; j--)
                fr[0][j] = (c0fix >>> (j - 1)) & 1;
        }
        let seed = 0;
        for (let i = 23; i >= 12; i--)
            seed = (seed << 1) | fr[0][i];
        let pr = 16 * seed;
        for (let j = 22, k = 1; j >= 0; j--, k++) {
            pr = (173 * pr + 13849) % 65536;
            fr[1][j] ^= pr >>> 15;
        }
        let c1 = 0;
        for (let j = 22; j >= 0; j--)
            c1 = (c1 << 1) | fr[1][j];
        const c1fix = golay2312(c1);
        if (c1fix < 0)
            errs += 4;
        else
            errs += popcount((c1fix ^ c1) >>> 11);
        let p = 0;
        for (let j = 23; j > 11; j--)
            d[p++] = fr[0][j];
        for (let j = 22; j > 10; j--)
            d[p++] = c1fix < 0 ? fr[1][j] : (c1fix >>> j) & 1;
        for (let j = 10; j >= 0; j--)
            d[p++] = fr[2][j];
        for (let j = 13; j >= 0; j--)
            d[p++] = fr[3][j];
        this.errs = errs;
        return this.process(errs);
    }
    process(errs) {
        const cur = this.cur, prev = this.prev, out = this.out;
        this.status = '';
        let bad = this.decodeParms();
        if (bad === 2) {
            this.status = 'E';
            cur.repeat = 0;
        }
        else if (bad === 3) {
            this.status = 'T';
            cur.repeat = 0;
        }
        else if (bad === 4 || errs > this.repeatErrs) {
            copyParms(prev, cur);
            cur.repeat++;
            this.status = 'R';
            bad = 0;
        }
        else
            cur.repeat = 0;
        if (bad === 0) {
            if (cur.repeat <= 3) {
                copyParms(cur, prev);
                this.enhance(cur);
                this.synthesize(cur, this.prevEnh);
                copyParms(cur, this.prevEnh);
                return out;
            }
            this.status = 'M';
        }
        out.fill(0);
        initParms(cur, prev, this.prevEnh);
        return out;
    }
    decodeParms() {
        const d = this.d, cur = this.cur, prev = this.prev, Tl = this.Tl, Cik = this.Cik;
        cur.repeat = prev.repeat;
        const b0 = d[0] << 6 | d[1] << 5 | d[2] << 4 | d[3] << 3 | d[37] << 2 | d[38] << 1 | d[39];
        if (b0 >= 120 && b0 <= 123)
            return 2;
        let silence = false, f0 = 0, L = 0;
        if (b0 === 124 || b0 === 125) {
            silence = true;
            cur.w0 = TWO_PI / 32;
            f0 = 1 / 32;
            L = 14;
            cur.L = 14;
            for (let l = 1; l <= L; l++)
                cur.Vl[l] = 0;
            this.status = 'S';
        }
        else if (b0 >= 126)
            return 3;
        if (!silence) {
            f0 = W0[b0];
            cur.w0 = f0 * TWO_PI;
            L = LTAB[b0];
            cur.L = L;
        }
        const unvc = 0.2046 / Math.sqrt(cur.w0);
        const b1 = d[4] << 4 | d[5] << 3 | d[6] << 2 | d[7] << 1 | d[35];
        if (!silence)
            for (let l = 1; l <= L; l++) {
                const jl = Math.floor(l * 16 * f0);
                cur.Vl[l] = VUV[b1 * 8 + jl];
            }
        const b2 = d[8] << 4 | d[9] << 3 | d[10] << 2 | d[11] << 1 | d[36];
        cur.gamma = DG[b2] + 0.5 * prev.gamma;
        const Gm = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        const b3 = d[12] << 8 | d[13] << 7 | d[14] << 6 | d[15] << 5 | d[16] << 4 | d[17] << 3 | d[18] << 2 | d[19] << 1 | d[40];
        Gm[2] = PRBA24[b3 * 3];
        Gm[3] = PRBA24[b3 * 3 + 1];
        Gm[4] = PRBA24[b3 * 3 + 2];
        const b4 = d[20] << 6 | d[21] << 5 | d[22] << 4 | d[23] << 3 | d[41] << 2 | d[42] << 1 | d[43];
        Gm[5] = PRBA58[b4 * 4];
        Gm[6] = PRBA58[b4 * 4 + 1];
        Gm[7] = PRBA58[b4 * 4 + 2];
        Gm[8] = PRBA58[b4 * 4 + 3];
        const Ri = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = 1; i <= 8; i++) {
            let sum = 0;
            for (let m = 1; m <= 8; m++)
                sum += (m === 1 ? 1 : 2) * Gm[m] * Math.cos(Math.PI * (m - 1) * (i - 0.5) / 8);
            Ri[i] = sum;
        }
        const rconst = 1 / (2 * Math.SQRT2);
        Cik[1 * 18 + 1] = 0.5 * (Ri[1] + Ri[2]);
        Cik[1 * 18 + 2] = rconst * (Ri[1] - Ri[2]);
        Cik[2 * 18 + 1] = 0.5 * (Ri[3] + Ri[4]);
        Cik[2 * 18 + 2] = rconst * (Ri[3] - Ri[4]);
        Cik[3 * 18 + 1] = 0.5 * (Ri[5] + Ri[6]);
        Cik[3 * 18 + 2] = rconst * (Ri[5] - Ri[6]);
        Cik[4 * 18 + 1] = 0.5 * (Ri[7] + Ri[8]);
        Cik[4 * 18 + 2] = rconst * (Ri[7] - Ri[8]);
        const b5 = d[24] << 4 | d[25] << 3 | d[26] << 2 | d[27] << 1 | d[44];
        const b6 = d[28] << 3 | d[29] << 2 | d[30] << 1 | d[45];
        const b7 = d[31] << 3 | d[32] << 2 | d[33] << 1 | d[46];
        const b8 = d[34] << 2 | d[47] << 1 | d[48];
        const Ji = [0, LMPRBL[L * 4], LMPRBL[L * 4 + 1], LMPRBL[L * 4 + 2], LMPRBL[L * 4 + 3]];
        const hoc = [null, HOC5, HOC6, HOC7, HOC8], hb = [0, b5, b6, b7, b8];
        for (let i = 1; i <= 4; i++)
            for (let k = 3; k <= Ji[i]; k++)
                Cik[i * 18 + k] = k > 6 ? 0 : hoc[i][hb[i] * 4 + k - 3];
        let l = 1;
        for (let i = 1; i <= 4; i++) {
            const ji = Ji[i];
            for (let j = 1; j <= ji; j++) {
                let sum = 0;
                for (let k = 1; k <= ji; k++)
                    sum += (k === 1 ? 1 : 2) * Cik[i * 18 + k] * Math.cos(Math.PI * (k - 1) * (j - 0.5) / ji);
                Tl[l++] = sum;
            }
        }
        if (cur.L > prev.L)
            for (let q = prev.L + 1; q <= cur.L; q++) {
                prev.Ml[q] = prev.Ml[prev.L];
                prev.log2Ml[q] = prev.log2Ml[prev.L];
            }
        prev.log2Ml[0] = prev.log2Ml[1];
        prev.Ml[0] = prev.Ml[1];
        const intkl = new Int32Array(58), deltal = new Float64Array(58);
        let Sum43 = 0, Sum42 = 0;
        for (let q = 1; q <= cur.L; q++) {
            const flokl = (prev.L / cur.L) * q;
            intkl[q] = Math.floor(flokl);
            deltal[q] = flokl - intkl[q];
            Sum43 += (1 - deltal[q]) * prev.log2Ml[intkl[q]] + deltal[q] * prev.log2Ml[intkl[q] + 1];
            Sum42 += Tl[q];
        }
        Sum43 *= 0.65 / cur.L;
        Sum42 /= cur.L;
        const BigGamma = cur.gamma - 0.5 * Math.log2(cur.L) - Sum42;
        for (let q = 1; q <= cur.L; q++) {
            const c1 = 0.65 * (1 - deltal[q]) * prev.log2Ml[intkl[q]], c2 = 0.65 * deltal[q] * prev.log2Ml[intkl[q] + 1];
            cur.log2Ml[q] = Tl[q] + c1 + c2 - Sum43 + BigGamma;
            cur.Ml[q] = (cur.Vl[q] === 1 ? 1 : unvc) * Math.exp(0.693 * cur.log2Ml[q]);
        }
        return 0;
    }
    enhance(cur) {
        let Rm0 = 0, Rm1 = 0;
        for (let l = 1; l <= cur.L; l++) {
            const m2 = cur.Ml[l] * cur.Ml[l];
            Rm0 += m2;
            Rm1 += m2 * Math.cos(cur.w0 * l);
        }
        const R2m0 = Rm0 * Rm0, R2m1 = Rm1 * Rm1;
        for (let l = 1; l <= cur.L; l++) {
            if (cur.Ml[l] === 0)
                continue;
            const Wl = Math.sqrt(cur.Ml[l]) * Math.pow((0.96 * Math.PI * ((R2m0 + R2m1) - 2 * Rm0 * Rm1 * Math.cos(cur.w0 * l))) / (cur.w0 * Rm0 * (R2m0 - R2m1)), 0.25);
            if (8 * l <= cur.L)
                continue;
            cur.Ml[l] *= Wl > 1.2 ? 1.2 : Wl < 0.5 ? 0.5 : Wl;
        }
        let sum = 0;
        for (let l = 1; l <= cur.L; l++)
            sum += cur.Ml[l] * cur.Ml[l];
        const g = sum === 0 ? 1 : Math.sqrt(Rm0 / sum);
        for (let l = 1; l <= cur.L; l++)
            cur.Ml[l] *= g;
    }
    nextNoise() {
        const u = this.noise;
        u.copyWithin(0, N, NFFT);
        for (let i = NFFT - N; i < NFFT; i++) {
            this.noiseSeed = (171 * this.noiseSeed + 11213) % 53125;
            u[i] = this.noiseSeed - 26562;
        }
    }
    synthUnvoiced(cur) {
        const re = this.fre, im = this.fim, u = this.noise, gain = this.binGain, half = NFFT >> 1;
        this.nextNoise();
        for (let x = 0; x < NFFT; x++) {
            re[x] = u[x] * WS[x + WOFF];
            im[x] = 0;
        }
        fft(re, im);
        gain.fill(0);
        const bins = NFFT * cur.w0 / TWO_PI;
        for (let l = 1; l <= cur.L; l++) {
            if (cur.Vl[l] !== 0)
                continue;
            const a = Math.max(1, Math.ceil((l - 0.5) * bins)), b = Math.min(half, Math.ceil((l + 0.5) * bins));
            if (b <= a)
                continue;
            let pow = 0;
            for (let k = a; k < b; k++)
                pow += re[k] * re[k] + im[k] * im[k];
            const rms = Math.sqrt(pow / (b - a));
            if (rms > 0) {
                const s = UV_SCALE * cur.Ml[l] / rms;
                for (let k = a; k < b; k++)
                    gain[k] = s;
            }
        }
        for (let k = 1; k < half; k++) {
            const s = gain[k], m = NFFT - k;
            re[k] *= s;
            im[k] *= s;
            re[m] *= s;
            im[m] *= s;
        }
        re[0] = 0;
        im[0] = 0;
        re[half] = 0;
        im[half] = 0;
        for (let k = 0; k < NFFT; k++)
            im[k] = -im[k];
        fft(re, im);
        const g = 1 / NFFT;
        for (let k = 0; k < NFFT; k++)
            this.uw[k] = re[k] * g;
    }
    synthesize(cur, prev) {
        const out = this.out;
        const cw0 = cur.w0, pw0 = prev.w0;
        out.fill(0);
        let maxl;
        if (cur.L > prev.L) {
            maxl = cur.L;
            for (let l = prev.L + 1; l <= maxl; l++) {
                prev.Ml[l] = 0;
                prev.Vl[l] = 1;
            }
        }
        else {
            maxl = prev.L;
            for (let l = cur.L + 1; l <= maxl; l++) {
                cur.Ml[l] = 0;
                cur.Vl[l] = 1;
            }
        }
        for (let l = 1; l <= 56; l++) {
            let psi = prev.PSIl[l] + (pw0 + cw0) * (l * N / 2);
            psi -= TWO_PI * Math.floor(psi / TWO_PI);
            cur.PSIl[l] = psi;
            cur.PHIl[l] = psi;
        }
        for (let l = 1; l <= maxl; l++) {
            const cw0l = cw0 * l, pw0l = pw0 * l;
            const cV = cur.Vl[l] === 1, pV = prev.Vl[l] === 1;
            const cM = cur.Ml[l], pM = prev.Ml[l], cPhi = cur.PHIl[l], pPhi = prev.PHIl[l];
            if (cV && pV)
                for (let n = 0; n < N; n++)
                    out[n] += WS[n + N] * pM * Math.cos(pw0l * n + pPhi) + WS[n] * cM * Math.cos(cw0l * (n - N) + cPhi);
            else if (cV)
                for (let n = 0; n < N; n++)
                    out[n] += WS[n] * cM * Math.cos(cw0l * (n - N) + cPhi);
            else if (pV)
                for (let n = 0; n < N; n++)
                    out[n] += WS[n + N] * pM * Math.cos(pw0l * n + pPhi);
        }
        this.synthUnvoiced(cur);
        const uw = this.uw, prevUw = this.prevUw, half = NFFT >> 1;
        for (let n = 0; n < N; n++) {
            const wp = WS[n + N], wc = WS[n], den = wp * wp + wc * wc;
            if (den <= 0)
                continue;
            let v = 0;
            if (wp > 0)
                v += wp * prevUw[n + half];
            if (wc > 0)
                v += wc * uw[n + half - N];
            out[n] += v / den;
        }
        prevUw.set(uw);
        const g = 7 / 32768;
        for (let n = 0; n < N; n++) {
            const v = out[n] * g;
            out[n] = v > 1 ? 1 : v < -1 ? -1 : v;
        }
    }
}
