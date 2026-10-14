import { BitSync } from './core.js';
const SYNC = 0x161601, STX = 0x02, ETX = 0x03, ETB = 0x17;
export class AcarsDecoder {
    constructor(emit) {
        this.emit = emit;
        this.dec1 = 41;
        this.accI = 0;
        this.accQ = 0;
        this.accN = 0;
        this.envDc = 0;
        this.env4 = 0;
        this.env4n = 0;
        this.fs = 12195;
        this.ph = 0;
        this.phInc = 0;
        this.lpI = 0;
        this.lpQ = 0;
        this.pI = 0;
        this.pQ = 0;
        this.bI = 0;
        this.bQ = 0;
        this.mfI = new Float32Array(5);
        this.mfQ = new Float32Array(5);
        this.mfPos = 0;
        this.mfSumI = 0;
        this.mfSumQ = 0;
        this.sync = new BitSync(2400, 12195);
        this.window = 0;
        this.collecting = false;
        this.polarity = 0;
        this.byte = 0;
        this.nBits = 0;
        this.bytes = new Uint8Array(300);
        this.count = 0;
        this.parityErrors = 0;
        this.crcBytes = 0;
        this.crcHi = 0;
        this.crcLo = 0;
        this.inCrc = false;
    }
    reset(rate) {
        this.dec1 = Math.max(1, Math.floor(rate / 48000));
        this.fs = rate / this.dec1 / 4;
        this.phInc = 2 * Math.PI * 1800 / this.fs;
        this.sync = new BitSync(2400, this.fs);
        const mfLen = Math.max(2, Math.round(this.fs / 2400));
        this.mfI = new Float32Array(mfLen);
        this.mfQ = new Float32Array(mfLen);
        this.mfPos = 0;
        this.mfSumI = 0;
        this.mfSumQ = 0;
        this.accI = this.accQ = this.accN = 0;
        this.env4 = 0;
        this.env4n = 0;
        this.lpI = this.lpQ = this.pI = this.pQ = 0;
        this.collecting = false;
        this.window = 0;
        this.nBits = 0;
        this.byte = 0;
        this.count = 0;
    }
    onIq(iq) {
        const nSamp = iq.length >> 1;
        for (let i = 0; i < nSamp; i++) {
            this.accI += iq[2 * i];
            this.accQ += iq[2 * i + 1];
            if (++this.accN < this.dec1)
                continue;
            const ci = this.accI / this.accN, cq = this.accQ / this.accN;
            this.accI = this.accQ = 0;
            this.accN = 0;
            const env = Math.sqrt(ci * ci + cq * cq);
            this.envDc += 0.002 * (env - this.envDc);
            this.env4 += env - this.envDc;
            if (++this.env4n < 4)
                continue;
            const a = this.env4 / 4;
            this.env4 = 0;
            this.env4n = 0;
            this.audio(a);
        }
    }
    audio(a) {
        this.ph += this.phInc;
        if (this.ph > 2 * Math.PI)
            this.ph -= 2 * Math.PI;
        const mi = a * Math.cos(this.ph), mq = -a * Math.sin(this.ph);
        this.mfSumI += mi - this.mfI[this.mfPos];
        this.mfSumQ += mq - this.mfQ[this.mfPos];
        this.mfI[this.mfPos] = mi;
        this.mfQ[this.mfPos] = mq;
        if (++this.mfPos >= this.mfI.length)
            this.mfPos = 0;
        this.lpI = this.mfSumI;
        this.lpQ = this.mfSumQ;
        const f = this.lpQ * this.pI - this.lpI * this.pQ;
        this.pI = this.lpI;
        this.pQ = this.lpQ;
        if (this.sync.push(f) >= 0) {
            const step = this.lpQ * this.bI - this.lpI * this.bQ;
            this.bI = this.lpI;
            this.bQ = this.lpQ;
            this.onBit(step > 0 ? 1 : 0);
        }
    }
    lsbFirst3(w) {
        let out = 0;
        for (let k = 0; k < 3; k++) {
            let b = 0;
            for (let i = 0; i < 8; i++)
                b |= ((w >>> (23 - (k * 8 + i))) & 1) << i;
            out = (out << 8) | b;
        }
        return out;
    }
    start(polarity) { this.collecting = true; this.polarity = polarity; this.nBits = 0; this.byte = 0; this.count = 0; this.parityErrors = 0; this.inCrc = false; this.crcBytes = 0; }
    onBit(raw) {
        if (!this.collecting) {
            this.window = ((this.window << 1) | raw) & 0xFFFFFF;
            if (this.lsbFirst3(this.window) === SYNC)
                this.start(0);
            else if (this.lsbFirst3(~this.window & 0xFFFFFF) === SYNC)
                this.start(1);
            return;
        }
        const bit = raw ^ this.polarity;
        this.byte |= bit << this.nBits;
        if (++this.nBits < 8)
            return;
        const b = this.byte;
        this.byte = 0;
        this.nBits = 0;
        if (this.inCrc) {
            if (this.crcBytes === 0) {
                this.crcHi = b;
                this.crcBytes = 1;
                return;
            }
            this.crcLo = b;
            this.finish();
            return;
        }
        let ones = 0;
        for (let i = 0; i < 8; i++)
            ones += (b >> i) & 1;
        if (ones % 2 === 0 && ++this.parityErrors > 4) {
            this.collecting = false;
            this.window = 0;
            return;
        }
        const ch = b & 0x7f;
        this.bytes[this.count++] = ch;
        if (ch === ETX || ch === ETB) {
            this.inCrc = true;
            this.crcBytes = 0;
            return;
        }
        if (this.count >= this.bytes.length) {
            this.collecting = false;
            this.window = 0;
        }
    }
    crcOk(n) {
        let crc = 0;
        for (let i = 0; i < n; i++) {
            crc ^= this.bytes[i] << 8;
            for (let k = 0; k < 8; k++)
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
        const rx1 = (this.crcHi << 8) | this.crcLo, rx2 = (this.crcLo << 8) | this.crcHi;
        if (crc === rx1 || crc === rx2)
            return true;
        let r = 0;
        for (let i = 0; i < n; i++) {
            let v = this.bytes[i];
            for (let k = 0; k < 8; k++) {
                const lsb = (r ^ v) & 1;
                r >>>= 1;
                if (lsb)
                    r ^= 0x8408;
                v >>>= 1;
            }
        }
        return r === rx1 || r === rx2;
    }
    finish() {
        this.collecting = false;
        this.window = 0;
        const n = this.count, B = this.bytes;
        if (n < 13)
            return;
        const ok = this.crcOk(n);
        const ch = (i) => String.fromCharCode(B[i]);
        const mode = ch(0);
        let reg = '';
        for (let i = 1; i <= 7; i++)
            reg += ch(i);
        reg = reg.replace(/^[. ]+|[. ]+$/g, '');
        const ack = B[8] === 0x15 ? 'NAK' : ch(8);
        const label = ch(9) + (B[10] === 0x7f ? 'd' : ch(10));
        const blk = ch(11);
        const down = blk >= '0' && blk <= '9';
        let p = 12, msn = '', flight = '';
        if (B[p] === STX) {
            p++;
            if (down && n - p >= 11) {
                for (let i = 0; i < 4; i++)
                    msn += ch(p + i);
                for (let i = 4; i < 10; i++)
                    flight += ch(p + i);
                flight = flight.trim();
                p += 10;
            }
        }
        let text = '';
        while (p < n) {
            const c = B[p++];
            if (c === ETX || c === ETB)
                break;
            text += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : (c === 0x0a || c === 0x0d) ? ' ' : '·';
        }
        const head = `ACARS ${down ? '↓' : '↑'} ${reg}  ${label}  blk ${blk}  ack ${ack}${msn ? `  #${msn} ${flight}` : ''}${ok ? '' : '  CRC?'}${mode !== '2' ? `  mode ${mode}` : ''}`;
        const body = text.trim();
        this.emit({ type: 'packet', line: body ? `${head}\n${body}` : head });
    }
}
