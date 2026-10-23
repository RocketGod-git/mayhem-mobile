import { Goertzel } from './filters.js';
export const CTCSS_TONES = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8,
    123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8,
    196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];
export const DCS_CODES = [23, 25, 26, 31, 32, 36, 43, 47, 51, 53, 54, 65, 71, 72, 73, 74, 114, 115, 116, 122, 125, 131, 132, 134, 143, 145, 152,
    155, 156, 162, 165, 172, 174, 205, 212, 223, 225, 226, 243, 244, 245, 246, 251, 252, 255, 261, 263, 265, 266, 271, 274, 306, 311, 315, 325,
    331, 332, 343, 346, 351, 356, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 446, 452, 454, 455, 462, 464, 465, 466, 503, 506, 516, 523,
    526, 532, 546, 565, 606, 612, 624, 627, 631, 632, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754];
const DCS_SET = new Set(DCS_CODES.map(c => parseInt(String(c), 8)));
const SUB_RATE = 4000;
export class SubAudioDecoder {
    constructor(inRate) {
        this.tone = 0;
        this.toneDb = 0;
        this.dcs = 0;
        this.dcsInverted = false;
        this.power = new Float32Array(CTCSS_TONES.length);
        this.acc = 0;
        this.accN = 0;
        this.lp = 0;
        this.dc = 0;
        this.toneMiss = 0;
        this.bitPhase = 0;
        this.bitLen = SUB_RATE / 134.4;
        this.lastSign = false;
        this.word = 0;
        this.wordBits = 0;
        this.lastCode = 0;
        this.codeRun = 0;
        this.dcsMiss = 0;
        this.decim = Math.max(1, Math.round(inRate / SUB_RATE));
        this.bank = CTCSS_TONES.map(f => new Goertzel(f, SUB_RATE, SUB_RATE / 2));
    }
    reset(rate) {
        this.decim = Math.max(1, Math.round(rate / SUB_RATE));
        this.tone = 0;
        this.dcs = 0;
        this.acc = 0;
        this.accN = 0;
        this.lp = 0;
        this.dc = 0;
        this.word = 0;
        this.wordBits = 0;
        this.codeRun = 0;
        this.lastCode = 0;
    }
    push(fm, n) {
        for (let i = 0; i < n; i++) {
            this.acc += fm[i];
            if (++this.accN >= this.decim) {
                const x = this.acc / this.accN;
                this.acc = 0;
                this.accN = 0;
                this.sub(x);
            }
        }
    }
    sub(x) {
        this.lp += 0.35 * (x - this.lp);
        const s = this.lp;
        let done = false;
        for (let k = 0; k < this.bank.length; k++) {
            const p = this.bank[k].push(s);
            if (p >= 0) {
                this.power[k] = p;
                done = true;
            }
        }
        if (done) {
            let best = 0, second = 0, bi = -1;
            for (let k = 0; k < this.power.length; k++) {
                const p = this.power[k];
                if (p > best) {
                    second = best;
                    best = p;
                    bi = k;
                }
                else if (p > second)
                    second = p;
            }
            const margin = 10 * Math.log10((best + 1e-12) / (second + 1e-12));
            if (bi >= 0 && margin > 6) {
                this.tone = CTCSS_TONES[bi];
                this.toneDb = margin;
                this.toneMiss = 0;
            }
            else if (++this.toneMiss >= 2) {
                this.tone = 0;
                this.toneDb = 0;
            }
        }
        this.dc += 0.002 * (s - this.dc);
        const sign = s - this.dc > 0;
        if (sign !== this.lastSign) {
            this.bitPhase = this.bitPhase < this.bitLen / 2 ? this.bitPhase * 0.7 : this.bitPhase + (this.bitLen - this.bitPhase) * 0.3;
            this.lastSign = sign;
        }
        this.bitPhase += 1;
        if (this.bitPhase >= this.bitLen) {
            this.bitPhase -= this.bitLen;
            this.bit(sign ? 1 : 0);
        }
    }
    bit(b) {
        this.word = ((this.word << 1) | b) & 0x7FFFFF;
        if (this.wordBits < 23) {
            this.wordBits++;
            return;
        }
        const code = SubAudioDecoder.decodeWord(this.word);
        const found = code ?? SubAudioDecoder.decodeWord(~this.word & 0x7FFFFF);
        if (found) {
            const inv = code === null;
            if (found === this.lastCode) {
                if (++this.codeRun >= 3) {
                    this.dcs = found;
                    this.dcsInverted = inv;
                    this.dcsMiss = 0;
                }
            }
            else {
                this.lastCode = found;
                this.codeRun = 1;
            }
        }
        else if (++this.dcsMiss > 23 * 4) {
            this.dcs = 0;
            this.lastCode = 0;
            this.codeRun = 0;
            this.dcsMiss = 0;
        }
    }
    static decodeWord(w) {
        for (let r = 0; r < 23; r++) {
            const x = ((w >>> r) | (w << (23 - r))) & 0x7FFFFF;
            if (((x >>> 9) & 7) !== 4)
                continue;
            if (golaySyndrome(x) !== 0)
                continue;
            const code = x & 0x1FF;
            if (DCS_SET.has(code))
                return parseInt(code.toString(8), 10);
        }
        return null;
    }
}
function golaySyndrome(x) {
    let v = x;
    for (let i = 22; i >= 11; i--)
        if (v & (1 << i))
            v ^= 0xC75 << (i - 11);
    return v & 0x7FF;
}
