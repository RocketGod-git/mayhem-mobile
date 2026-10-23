import { AmbeDecoder, golay2312, popcount } from './mbe.js';
import { QUANT_STEP, STAND_DEV, B2, BA_BITS, BA_STEP, HOBA, JI } from './imbe-tables.js';
const HAM_GEN = [0x7f08, 0x78e4, 0x66d2, 0x55b1];
const HAM_FIX = [0x0, 0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000];
const DEINT = new Uint8Array(144);
for (let i = 0; i < 144; i++) {
    const j = (i / 6) | 0, r = i % 6;
    DEINT[i] = j + 24 * ((j & 1) ? (r ^ 1) : r);
}
const WORD_AT = [0, 23, 46, 69, 92, 107, 122, 137];
const WORD_LEN = [23, 23, 23, 23, 15, 15, 15, 7];
function hamming1511(block) {
    let syn = 0;
    for (let i = 0; i < 4; i++)
        syn = (syn << 1) | (popcount(block & HAM_GEN[i]) & 1);
    if (syn === 0)
        return { word: block, errs: 0 };
    return { word: block ^ HAM_FIX[syn], errs: 1 };
}
export class ImbeDecoder extends AmbeDecoder {
    constructor() {
        super();
        this.id = new Uint8Array(88);
        this.bb = Array.from({ length: 58 }, () => new Uint8Array(12));
        this.w = new Uint8Array(144);
        this.words = new Int32Array(8);
        this.iTl = new Float64Array(58);
        this.iCik = Array.from({ length: 7 }, () => new Float64Array(11));
        this.Ri = new Float64Array(7);
        this.Gm = new Float64Array(7);
        this.repeatErrs = 5;
    }
    decodeVoice(bits) {
        const w = this.w, words = this.words;
        for (let i = 0; i < 144; i++)
            w[DEINT[i]] = bits[i];
        for (let k = 0; k < 8; k++) {
            let v = 0;
            for (let i = 0, at = WORD_AT[k], n = WORD_LEN[k]; i < n; i++)
                v = (v << 1) | w[at + i];
            words[k] = v;
        }
        let errs = 0;
        const u0 = golay2312(words[0]);
        if (u0 < 0)
            errs += 4;
        else {
            errs += popcount((u0 ^ words[0]) >>> 11);
            words[0] = u0;
        }
        let pr = 16 * (words[0] >>> 11);
        for (let k = 1; k < 7; k++) {
            const n = WORD_LEN[k];
            for (let b = n - 1; b >= 0; b--) {
                pr = (173 * pr + 13849) % 65536;
                words[k] ^= (pr >>> 15) << b;
            }
        }
        for (let k = 1; k < 4; k++) {
            const fix = golay2312(words[k]);
            if (fix < 0)
                errs += 4;
            else {
                errs += popcount((fix ^ words[k]) >>> 11);
                words[k] = fix;
            }
        }
        for (let k = 4; k < 7; k++) {
            const r = hamming1511(words[k]);
            words[k] = r.word;
            errs += r.errs;
        }
        const id = this.id;
        let p = 0;
        for (let k = 0; k < 4; k++)
            for (let b = 11; b >= 0; b--)
                id[p++] = (words[k] >>> (b + 11)) & 1;
        for (let k = 4; k < 7; k++)
            for (let b = 10; b >= 0; b--)
                id[p++] = (words[k] >>> (b + 4)) & 1;
        for (let b = 6; b >= 0; b--)
            id[p++] = (words[7] >>> b) & 1;
        this.errs = errs;
        return this.process(errs);
    }
    scatter(L, K) {
        const id = this.id, bb = this.bb;
        for (let m = 0; m <= L + 1; m++)
            bb[m].fill(0);
        const len = (m) => m < 3 ? 0 : m < 8 ? BA_BITS[L - 9][m - 3] : HOBA[L - 9][m - 8];
        const order = [];
        for (let p = 9; p >= 0; p--)
            for (let m = 3; m <= L + 1; m++)
                if (len(m) > p)
                    order.push(m * 16 + p);
        let s = 0;
        const put = (at, m, b) => { bb[m][b] = id[at]; };
        for (let k = 0; k < 6; k++)
            put(6 + k, 2, 5 - k);
        for (let k = 0; k < 39; k++) {
            const o = order[s++];
            put(9 + k, o >> 4, o & 15);
        }
        for (let k = 0; k < K; k++)
            put(48 + k, 1, K - 1 - k);
        put(48 + K, 2, 2);
        put(49 + K, 2, 1);
        for (let k = 50 + K; k < 84; k++) {
            const o = order[s++];
            put(k, o >> 4, o & 15);
        }
        put(84, 2, 0);
    }
    decodeParms() {
        const id = this.id, cur = this.cur, prev = this.prev, bb = this.bb, Cik = this.iCik, Ri = this.Ri, Gm = this.Gm, Tl = this.iTl;
        cur.repeat = prev.repeat;
        const b0 = id[0] << 7 | id[1] << 6 | id[2] << 5 | id[3] << 4 | id[4] << 3 | id[5] << 2 | id[85] << 1 | id[86];
        if (b0 > 207)
            return 4;
        cur.w0 = 4 * Math.PI / (b0 + 39.5);
        const L = Math.floor(0.9254 * Math.floor(Math.PI / cur.w0 + 0.25));
        if (L < 9 || L > 56)
            return 4;
        cur.L = L;
        const L9 = L - 9, K = L < 37 ? Math.floor((L + 2) / 3) : 12;
        this.scatter(L, K);
        for (let l = 1, j = 1, k = K - 1; l <= L; l++) {
            cur.Vl[l] = bb[1][k];
            if (j === 3) {
                j = 1;
                if (k > 0)
                    k--;
            }
            else
                j++;
        }
        let b2 = 0;
        for (let b = 5; b >= 0; b--)
            b2 = (b2 << 1) | bb[2][b];
        Gm[1] = B2[b2];
        for (let i = 2; i < 7; i++) {
            const bits = BA_BITS[L9][i - 2], step = BA_STEP[L9 * 5 + (i - 2)];
            let bm = 0;
            for (let b = bits - 1; b >= 0; b--)
                bm = (bm << 1) | bb[i + 1][b];
            Gm[i] = step * (bm - Math.pow(2, bits - 1) + 0.5);
        }
        for (let i = 1; i <= 6; i++) {
            let sum = 0;
            for (let m = 1; m <= 6; m++)
                sum += (m === 1 ? 1 : 2) * Gm[m] * Math.cos(Math.PI * (m - 1) * (i - 0.5) / 6);
            Ri[i] = sum;
        }
        let m = 8;
        for (let i = 1; i <= 6; i++) {
            Cik[i][1] = Ri[i];
            for (let k = 2; k <= JI[L9][i - 1]; k++) {
                const Bm = HOBA[L9][m - 8];
                if (Bm === 0)
                    Cik[i][k] = 0;
                else {
                    let bm = 0;
                    for (let b = Bm - 1; b >= 0; b--)
                        bm = (bm << 1) | bb[m][b];
                    Cik[i][k] = QUANT_STEP[Bm - 1] * STAND_DEV[k - 2] * (bm - Math.pow(2, Bm - 1) + 0.5);
                }
                m++;
            }
        }
        for (let i = 1, l = 1; i <= 6; i++) {
            const ji = JI[L9][i - 1];
            for (let j = 1; j <= ji; j++, l++) {
                let sum = 0;
                for (let k = 1; k <= ji; k++)
                    sum += (k === 1 ? 1 : 2) * Cik[i][k] * Math.cos(Math.PI * (k - 1) * (j - 0.5) / ji);
                Tl[l] = sum;
            }
        }
        const rho = L <= 15 ? 0.4 : L <= 24 ? 0.03 * L - 0.05 : 0.7;
        if (L > prev.L)
            for (let l = prev.L + 1; l <= L; l++) {
                prev.Ml[l] = prev.Ml[prev.L];
                prev.log2Ml[l] = prev.log2Ml[prev.L];
            }
        let mean = 0;
        for (let l = 1; l <= L; l++) {
            const f = (prev.L / L) * l, k = Math.floor(f), d = f - k;
            mean += (1 - d) * prev.log2Ml[k] + d * prev.log2Ml[k + 1];
        }
        mean *= rho / L;
        for (let l = 1; l <= L; l++) {
            const f = (prev.L / L) * l, k = Math.floor(f), d = f - k;
            cur.log2Ml[l] = Tl[l] + rho * (1 - d) * prev.log2Ml[k] + rho * d * prev.log2Ml[k + 1] - mean;
            cur.Ml[l] = Math.pow(2, cur.log2Ml[l]);
        }
        return 0;
    }
}
