import { BitSync, DiscFilter, HdlcFramer } from './core.js';
class Descrambler {
    constructor() {
        this.reg = 0;
    }
    reset() { this.reg = 0; }
    push(bit) {
        let t = this.reg & Descrambler.MASK, parity = 0;
        while (t) {
            parity ^= t & 1;
            t >>>= 1;
        }
        const out = parity ^ (bit & 1);
        this.reg = (this.reg >>> 1) | ((bit & 1) << Descrambler.LEN);
        return out;
    }
}
Descrambler.MASK = 0x21;
Descrambler.LEN = 16;
function callsign(f, at) {
    let s = '';
    for (let i = 0; i < 6; i++) {
        const c = f[at + i] >> 1;
        if (c !== 0x20)
            s += String.fromCharCode(c);
    }
    const ssid = (f[at + 6] >> 1) & 0x0f;
    return ssid ? `${s}-${ssid}` : s;
}
function asText(b) {
    if (!b.length)
        return '';
    let printable = 0, s = '';
    for (const c of b) {
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) {
            printable++;
            s += String.fromCharCode(c);
        }
        else
            s += '.';
    }
    return printable / b.length > 0.85 ? s : '';
}
export class G3ruhDecoder {
    constructor(emit) {
        this.emit = emit;
        this.wantsFm = true;
        this.fmRate = 0;
        this.baud = 9600;
        this.sync = new BitSync(9600, 48000);
        this.filt = new DiscFilter(7200, 48000);
        this.descram = new Descrambler();
        this.last = 0;
        this.frames = [];
        this.heard = 0;
        this.bad = 0;
        this.framer = new HdlcFramer(512, f => this.onFrame(f));
    }
    setBaud(baud) {
        if (baud === this.baud)
            return;
        this.baud = baud;
        this.fmRate = 0;
    }
    reset() { this.fmRate = 0; this.framer.reset(); this.descram.reset(); this.last = 0; this.heard = 0; this.bad = 0; this.frames.length = 0; }
    clear() { this.heard = 0; this.bad = 0; this.frames.length = 0; this.emit({ type: 'packetsat', frames: [], heard: 0, bad: 0 }); }
    onIq() { }
    onFm(samples, n, rate) {
        if (rate !== this.fmRate) {
            this.fmRate = rate;
            this.sync = new BitSync(this.baud, rate);
            this.filt = new DiscFilter(Math.min(0.45 * rate, this.baud * 0.75), rate);
            this.framer.reset();
            this.descram.reset();
        }
        for (let i = 0; i < n; i++) {
            const b = this.sync.push(this.filt.push(samples[i]));
            if (b < 0)
                continue;
            const nrzi = b === this.last ? 1 : 0;
            this.last = b;
            this.framer.pushDecoded(this.descram.push(nrzi));
        }
    }
    onFrame(f) {
        if (f.length < 16 || !HdlcFramer.fcsOk(f)) {
            this.bad++;
            return;
        }
        const to = callsign(f, 0), from = callsign(f, 7);
        const via = [];
        let at = 14;
        if (!(f[13] & 1)) {
            while (at + 7 <= f.length && via.length < 8) {
                via.push(callsign(f, at));
                const end = f[at + 6] & 1;
                at += 7;
                if (end)
                    break;
            }
        }
        at += 2;
        if (at >= f.length - 2)
            return;
        const payload = f.slice(at, f.length - 2);
        this.heard++;
        const frame = {
            at: Date.now(), from, to, via, payload, text: asText(payload),
            hex: [...payload.slice(0, 64)].map(v => v.toString(16).padStart(2, '0')).join(' '),
        };
        this.frames.unshift(frame);
        if (this.frames.length > 100)
            this.frames.length = 100;
        this.emit({ type: 'packetsat', frames: this.frames.slice(0, 40), heard: this.heard, bad: this.bad });
    }
}
