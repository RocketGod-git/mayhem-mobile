import { VARICODE } from './varicode.js';
const RATE = 48000;
class ToneDetector {
    constructor(hz, bwHz, decim) {
        this.decim = decim;
        this.cr = 1;
        this.ci = 0;
        this.i1 = 0;
        this.i2 = 0;
        this.q1 = 0;
        this.q2 = 0;
        this.n = 0;
        const w = -2 * Math.PI * hz / RATE;
        this.dr = Math.cos(w);
        this.di = Math.sin(w);
        this.a = 1 - Math.exp(-2 * Math.PI * bwHz / RATE);
    }
    push(x) {
        const i = x * this.cr, q = x * this.ci;
        const nr = this.cr * this.dr - this.ci * this.di;
        this.ci = this.cr * this.di + this.ci * this.dr;
        this.cr = nr;
        this.i1 += this.a * (i - this.i1);
        this.i2 += this.a * (this.i1 - this.i2);
        this.q1 += this.a * (q - this.q1);
        this.q2 += this.a * (this.q1 - this.q2);
        if (++this.n >= this.decim) {
            this.n = 0;
            if ((this.n & 255) === 0) {
                const g = 1 / Math.sqrt(this.cr * this.cr + this.ci * this.ci);
                this.cr *= g;
                this.ci *= g;
            }
            return Math.sqrt(this.i2 * this.i2 + this.q2 * this.q2);
        }
        return -1;
    }
    pushIq(x, out) {
        const i = x * this.cr, q = x * this.ci;
        const nr = this.cr * this.dr - this.ci * this.di;
        this.ci = this.cr * this.di + this.ci * this.dr;
        this.cr = nr;
        this.i1 += this.a * (i - this.i1);
        this.i2 += this.a * (this.i1 - this.i2);
        this.q1 += this.a * (q - this.q1);
        this.q2 += this.a * (this.q1 - this.q2);
        if (++this.n >= this.decim) {
            this.n = 0;
            out[0] = this.i2;
            out[1] = this.q2;
            return true;
        }
        return false;
    }
}
const MORSE = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L',
    '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X',
    '-.--': 'Y', '--..': 'Z', '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7',
    '---..': '8', '----.': '9', '.-.-.-': '.', '--..--': ',', '..--..': '?', '-..-.': '/', '-...-': '=', '-....-': '-', '.--.-.': '@',
    '---...': ':', '.-.-.': '+', '-.--.': '(', '-.--.-': ')', '.-...': '<AS>', '...-.-': '<SK>', '-.-.-': '<KA>', '........': '<ERR>',
};
export class CwDecoder {
    constructor(pitch = 600) {
        this.name = 'CW';
        this.confidence = 0;
        this.onText = () => { };
        this.wpm = 20;
        this.step = 96;
        this.peak = 0;
        this.floor = 0;
        this.mark = false;
        this.run = 0;
        this.dit = 60;
        this.sym = '';
        this.idleChars = 0;
        this.marks = [];
        this.det = new ToneDetector(pitch, 80, this.step);
    }
    setPitch(hz) { this.det = new ToneDetector(hz, 80, this.step); }
    reset() { this.peak = 0; this.floor = 0; this.mark = false; this.run = 0; this.sym = ''; this.marks = []; this.confidence = 0; }
    push(a, n) {
        for (let i = 0; i < n; i++) {
            const m = this.det.push(a[i]);
            if (m < 0)
                continue;
            this.peak = m > this.peak ? this.peak + 0.5 * (m - this.peak) : this.peak + 0.002 * (m - this.peak);
            this.floor = m < this.floor ? this.floor + 0.2 * (m - this.floor) : this.floor + 0.004 * (m - this.floor);
            const thr = Math.sqrt(Math.max(1e-9, this.peak * this.floor)) * (this.mark ? 0.8 : 1.25);
            const on = m > thr && this.peak > this.floor * 3;
            const ms = 1000 * this.step / RATE;
            if (on === this.mark) {
                this.run += ms;
                if (!on)
                    this.gap(false);
                continue;
            }
            if (this.mark)
                this.element(this.run);
            else if (this.run > 0)
                this.space(this.run);
            this.mark = on;
            this.run = ms;
        }
    }
    element(ms) {
        if (ms < 15)
            return;
        const isDah = ms > this.dit * 2;
        this.sym += isDah ? '-' : '.';
        const est = isDah ? ms / 3 : ms;
        this.dit = Math.min(240, Math.max(20, this.dit * 0.85 + est * 0.15));
        this.wpm = Math.round(1200 / this.dit);
        this.marks.push(ms);
        if (this.marks.length > 24)
            this.marks.shift();
        if (this.marks.length >= 8) {
            const s = [...this.marks].sort((x, y) => x - y), lo = s[Math.floor(s.length * 0.25)], hi = s[Math.floor(s.length * 0.75)];
            const r = hi / Math.max(1, lo);
            this.confidence = Math.max(0, Math.min(1, 1 - Math.abs(r - 3) / 2.5)) * 0.9;
        }
    }
    space(ms) { if (ms > this.dit * 2.2)
        this.flush(); }
    gap(_) {
        if (!this.mark && this.sym && this.run > this.dit * 2.2)
            this.flush();
        if (!this.mark && this.run > this.dit * 6 && this.idleChars === 0) {
            this.idleChars = 1;
            this.onText(' ');
        }
        if (!this.mark && this.run > this.dit * 30)
            this.confidence *= 0.999;
    }
    flush() {
        if (!this.sym)
            return;
        const ch = MORSE[this.sym] ?? '·';
        this.onText(ch, `${this.wpm} WPM`);
        this.sym = '';
        this.idleChars = 0;
    }
}
const ITA2_LTRS = '\0E\nA SIU\rDRJNFCKTZLWHYPQOBG\0MXV\0';
const ITA2_FIGS = "\0" + '3' + '\n' + '- \x07' + '87' + '\r' + '$4\',!:(5")2#6019?&' + '\0' + './;' + '\0';
export class RttyDecoder {
    constructor(mark = 2125, shift = 170, baud = 45.45, reverse = false) {
        this.mark = mark;
        this.shift = shift;
        this.baud = baud;
        this.reverse = reverse;
        this.name = 'RTTY';
        this.confidence = 0;
        this.onText = () => { };
        this.step = 48;
        this.bitLen = 1000 / 45.45;
        this.figs = false;
        this.state = 'idle';
        this.t = 0;
        this.bits = 0;
        this.nbits = 0;
        this.lastSign = 1;
        this.frames = 0;
        this.badFrames = 0;
        this.dc = 0;
        this.setup();
    }
    configure(mark, shift, baud, reverse) { this.mark = mark; this.shift = shift; this.baud = baud; this.reverse = reverse; this.setup(); }
    setup() {
        const bw = Math.max(40, this.baud * 0.9);
        this.markDet = new ToneDetector(this.mark, bw, this.step);
        this.spaceDet = new ToneDetector(this.mark - this.shift, bw, this.step);
        this.bitLen = 1000 / this.baud;
        this.state = 'idle';
        this.frames = 0;
        this.badFrames = 0;
        this.confidence = 0;
    }
    reset() { this.setup(); this.figs = false; }
    push(a, n) {
        for (let i = 0; i < n; i++) {
            const m = this.markDet.push(a[i]), s = this.spaceDet.push(a[i]);
            if (m < 0)
                continue;
            let v = (m - s) / (m + s + 1e-9);
            if (this.reverse)
                v = -v;
            this.dc += 0.001 * (v - this.dc);
            const sign = v - this.dc * 0.5 > 0 ? 1 : 0;
            this.clock(sign);
        }
    }
    clock(bit) {
        this.t += 1;
        switch (this.state) {
            case 'idle':
                if (this.lastSign === 1 && bit === 0) {
                    this.state = 'start';
                    this.t = 0;
                }
                break;
            case 'start':
                if (this.t >= this.bitLen / 2) {
                    if (bit === 0) {
                        this.state = 'data';
                        this.bits = 0;
                        this.nbits = 0;
                        this.t = 0;
                    }
                    else
                        this.state = 'idle';
                }
                break;
            case 'data':
                if (this.t >= this.bitLen) {
                    this.t -= this.bitLen;
                    this.bits |= bit << this.nbits;
                    if (++this.nbits >= 5)
                        this.state = 'stop';
                }
                break;
            case 'stop':
                if (this.t >= this.bitLen) {
                    this.frames++;
                    if (bit === 1)
                        this.emit(this.bits);
                    else
                        this.badFrames++;
                    this.confidence = Math.max(0, Math.min(1, (1 - this.badFrames / Math.max(4, this.frames)) * Math.min(1, this.frames / 12)));
                    this.state = 'idle';
                    this.t = 0;
                }
                break;
        }
        this.lastSign = bit;
    }
    emit(code) {
        if (code === 0x1F) {
            this.figs = false;
            return;
        }
        if (code === 0x1B) {
            this.figs = true;
            return;
        }
        const ch = (this.figs ? ITA2_FIGS : ITA2_LTRS)[code] ?? '';
        if (ch === '\0')
            return;
        if (ch === '\r')
            return;
        this.onText(ch, `${this.baud} Bd · ${this.shift} Hz`);
    }
}
export class Psk31Decoder {
    constructor(center = 1000) {
        this.center = center;
        this.name = 'PSK31';
        this.confidence = 0;
        this.onText = () => { };
        this.decim = 96;
        this.spb = 16;
        this.iq = new Float32Array(2);
        this.energy = new Float32Array(16);
        this.phase = 0;
        this.lastI = 0;
        this.lastQ = 0;
        this.code = '';
        this.zeros = 0;
        this.afc = 0;
        this.dips = 0;
        this.samples = 0;
        this.setup();
    }
    setCenter(hz) { this.center = hz; this.setup(); }
    setup() { this.det = new ToneDetector(this.center, 40, this.decim); this.energy.fill(0); this.phase = 0; this.code = ''; this.zeros = 0; this.afc = 0; this.confidence = 0; }
    reset() { this.setup(); }
    push(a, n) {
        for (let i = 0; i < n; i++) {
            if (!this.det.pushIq(a[i], this.iq))
                continue;
            const I = this.iq[0], Q = this.iq[1];
            const e = I * I + Q * Q;
            this.energy[this.phase] = this.energy[this.phase] * 0.97 + e * 0.03;
            let best = 0;
            for (let k = 1; k < this.spb; k++)
                if (this.energy[k] > this.energy[best])
                    best = k;
            if (this.phase === best)
                this.symbol(I, Q);
            this.phase = (this.phase + 1) % this.spb;
        }
    }
    symbol(I, Q) {
        const c = Math.cos(this.afc), s = Math.sin(this.afc);
        const ri = I * c + Q * s, rq = Q * c - I * s;
        const dot = ri * this.lastI + rq * this.lastQ, cross = rq * this.lastI - ri * this.lastQ;
        const mag = Math.sqrt((ri * ri + rq * rq) * (this.lastI * this.lastI + this.lastQ * this.lastQ)) + 1e-12;
        const bit = dot / mag > 0 ? 1 : 0;
        if (bit === 1)
            this.afc += 0.02 * Math.atan2(cross, dot);
        this.lastI = ri;
        this.lastQ = rq;
        this.samples++;
        if (bit === 0)
            this.dips++;
        if (this.samples >= 64) {
            const r = this.dips / this.samples;
            this.confidence = r > 0.15 && r < 0.7 && mag > 1e-8 ? Math.min(1, this.confidence + 0.1) : Math.max(0, this.confidence - 0.15);
            this.samples = 0;
            this.dips = 0;
        }
        if (bit === 0) {
            if (this.zeros === 1) {
                const code = this.code.slice(0, -1);
                if (code) {
                    const idx = VARICODE.indexOf(code);
                    if (idx >= 32 && idx < 127)
                        this.onText(String.fromCharCode(idx), `${this.center} Hz`);
                    else if (idx === 10 || idx === 13)
                        this.onText('\n');
                }
                this.code = '';
                this.zeros = 0;
            }
            else {
                this.zeros = 1;
                this.code += '0';
            }
        }
        else {
            this.zeros = 0;
            this.code += '1';
        }
        if (this.code.length > 12)
            this.code = '';
    }
}
