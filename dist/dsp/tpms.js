import { BitSync } from './core.js';
class OokChips {
    constructor(spb) {
        this.spb = spb;
        this.phase = 0;
        this.sum = 0;
        this.n = 0;
        this.thr = 0;
        this.lastAbove = false;
    }
    push(mag) {
        this.thr = mag > this.thr ? mag : this.thr * (1 - 1 / (8 * this.spb));
        const above = mag > this.thr * 0.6;
        if (above !== this.lastAbove) {
            let err = this.phase;
            if (err > 0.5)
                err -= 1;
            this.phase -= err * 0.2;
            if (this.phase < 0)
                this.phase += 1;
        }
        this.lastAbove = above;
        if (above)
            this.sum++;
        this.n++;
        this.phase += 1 / this.spb;
        if (this.phase >= 1) {
            this.phase -= 1;
            const chip = this.sum * 2 > this.n ? 1 : 0;
            this.sum = 0;
            this.n = 0;
            return chip;
        }
        return -1;
    }
}
class ChipPacket {
    constructor(pattern, patternBits, payload) {
        this.pattern = pattern;
        this.patternBits = patternBits;
        this.payload = payload;
        this.shift = 0;
        this.collecting = false;
        this.count = 0;
        this.chips = new Uint8Array(payload);
    }
    reset() { this.shift = 0; this.collecting = false; this.count = 0; }
    push(chip) {
        if (!this.collecting) {
            this.shift = ((this.shift * 2 + chip) % Math.pow(2, this.patternBits));
            if (this.shift === this.pattern) {
                this.collecting = true;
                this.count = 0;
            }
            return null;
        }
        this.chips[this.count++] = chip;
        if (this.count < this.payload)
            return null;
        this.collecting = false;
        this.shift = 0;
        const bits = new Uint8Array(this.payload >> 1);
        let errors = 0;
        for (let i = 0; i < bits.length; i++) {
            bits[i] = this.chips[2 * i];
            if (this.chips[2 * i] === this.chips[2 * i + 1])
                errors++;
        }
        return errors > this.payload / 8 ? null : bits;
    }
}
export class TpmsDecoder {
    constructor(emit) {
        this.emit = emit;
        this.dcI = 0;
        this.dcQ = 0;
        this.dec = 4;
        this.accI = 0;
        this.accQ = 0;
        this.accN = 0;
        this.prevI = 0;
        this.prevQ = 0;
        this.fsk = new BitSync(19200, 500000);
        this.magAcc = 0;
        this.magN = 0;
        this.ook8192 = new OokChips(125000 / 8192);
        this.ook8400 = new OokChips(125000 / 8400);
        this.bFsk = new ChipPacket(0b010101010101010101010101010110, 30, 160);
        this.bOok8192 = new ChipPacket(0b010101010101010101011110, 24, 74);
        this.bOok8400 = new ChipPacket(0b01010101010101010101010101100101, 32, 152);
        this.seen = new Map();
    }
    reset(rate) {
        this.dec = Math.max(1, Math.floor(rate / 500000));
        const r1 = rate / this.dec;
        this.fsk = new BitSync(19200, r1);
        this.ook8192.spb = r1 / 4 / 8192;
        this.ook8400.spb = r1 / 4 / 8400;
        this.accI = this.accQ = this.accN = 0;
        this.magAcc = 0;
        this.magN = 0;
        this.bFsk.reset();
        this.bOok8192.reset();
        this.bOok8400.reset();
    }
    clear() { this.seen.clear(); }
    onIq(iq) {
        const nSamp = iq.length >> 1;
        let sI = 0, sQ = 0;
        for (let i = 0; i < nSamp; i++) {
            sI += iq[2 * i];
            sQ += iq[2 * i + 1];
        }
        this.dcI += 0.2 * (sI / nSamp - this.dcI);
        this.dcQ += 0.2 * (sQ / nSamp - this.dcQ);
        for (let i = 0; i < nSamp; i++) {
            this.accI += iq[2 * i] - this.dcI;
            this.accQ += iq[2 * i + 1] - this.dcQ;
            if (++this.accN < this.dec)
                continue;
            const ci = this.accI / this.accN, cq = this.accQ / this.accN;
            this.accI = this.accQ = 0;
            this.accN = 0;
            const d = Math.atan2(cq * this.prevI - ci * this.prevQ, ci * this.prevI + cq * this.prevQ);
            this.prevI = ci;
            this.prevQ = cq;
            const chip = this.fsk.push(d);
            if (chip >= 0) {
                const b = this.bFsk.push(chip);
                if (b)
                    this.readFsk(b);
            }
            this.magAcc += Math.sqrt(ci * ci + cq * cq);
            this.magN++;
            if (this.magN >= 4) {
                const m = this.magAcc / this.magN;
                this.magAcc = 0;
                this.magN = 0;
                const c1 = this.ook8192.push(m);
                if (c1 >= 0) {
                    const b = this.bOok8192.push(c1);
                    if (b)
                        this.readOok8192(b);
                }
                const c2 = this.ook8400.push(m);
                if (c2 >= 0) {
                    const b = this.bOok8400.push(c2);
                    if (b)
                        this.readOok8400(b);
                }
            }
        }
    }
    rd(bits, start, n) { let v = 0; for (let i = start; i < start + n; i++)
        v = v * 2 + (i < bits.length ? bits[i] : 0); return v; }
    crc8(crc, byte) { crc ^= byte; for (let k = 0; k < 8; k++)
        crc = (crc & 0x80) ? ((crc << 1) ^ 0x01) & 0xff : (crc << 1) & 0xff; return crc; }
    crcValidLength(bits) {
        const bytes = [];
        for (let i = 0; i < 10; i++)
            bytes.push(this.rd(bits, i * 8, 8));
        let sum = 0, crc72 = 0, crc80 = 0;
        for (let i = 0; i < 10; i++) {
            const b = bytes[i];
            if (i < 7)
                sum += b;
            if (i < 9)
                crc72 = this.crc8(crc72, b);
            if (i >= 1)
                crc80 = this.crc8(crc80, b);
        }
        return crc80 === 0 ? 80 : crc72 === 0 ? 72 : (sum & 0xff) === bytes[7] ? 64 : 0;
    }
    readFsk(bits) {
        const len = this.crcValidLength(bits);
        if (len === 64)
            this.report('FLM_64', this.rd(bits, 0, 32), Math.floor(this.rd(bits, 32, 8) * 4 / 3), (this.rd(bits, 40, 8) & 0x7f) - 56, null);
        else if (len === 72)
            this.report('FLM_72', this.rd(bits, 0, 32), Math.floor(this.rd(bits, 40, 8) * 4 / 3), this.rd(bits, 48, 8) - 56, null);
        else if (len === 80)
            this.report('FLM_80', this.rd(bits, 8, 32), Math.floor(this.rd(bits, 48, 8) * 4 / 3), this.rd(bits, 56, 8) - 56, null);
    }
    readOok8192(bits) {
        const flags = this.rd(bits, 0, 3), checksum = this.rd(bits, 35, 2);
        let calc = this.rd(bits, 0, 1);
        for (let i = 1; i < 37; i += 2)
            calc += this.rd(bits, i, 2);
        if ((calc & 3) === 3)
            this.report('Schrader', this.rd(bits, 3, 24), Math.floor(this.rd(bits, 27, 8) * 4 / 3), null, flags, checksum);
    }
    readOok8400(bits) {
        const id = this.rd(bits, 20, 32), v0 = this.rd(bits, 52, 8), v1 = this.rd(bits, 60, 8), checksum = this.rd(bits, 68, 8);
        let calc = (0x4 << 4) | this.rd(bits, 0, 4);
        for (let i = 4; i < 68; i += 8)
            calc += this.rd(bits, i, 8);
        if ((calc & 0xff) === checksum)
            this.report('GMC_96', id, Math.floor(v0 * 11 / 4), v1 - 61, null);
    }
    report(type, id, kPa, degC, flags, checksum = null) {
        const now = performance.now();
        const key = `${type}:${id}`;
        if (now - (this.seen.get(key) ?? 0) < 1500)
            return;
        this.seen.set(key, now);
        let line = `TPMS ${type.padEnd(8)} ID ${String(id).padEnd(10)} ${id.toString(16).toUpperCase().padStart(8, '0')} · ${kPa} kPa / ${(kPa * 0.145038).toFixed(1)} psi`;
        if (degC !== null)
            line += ` · ${degC}°C / ${Math.floor(degC * 9 / 5) + 32}°F`;
        if (flags !== null)
            line += ` · flags ${flags.toString(2).padStart(3, '0')}`;
        if (checksum !== null)
            line += ` · chk ${checksum}`;
        this.emit({ type: 'packet', line });
    }
}
