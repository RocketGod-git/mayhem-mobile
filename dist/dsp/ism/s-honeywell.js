import { FProto, Fam, S, Manchester } from './base.js';
export class SHoneywell extends FProto {
    constructor() {
        super(Fam.REMOTE, S.HONEYWELL);
        this.manchester = new Manchester();
        this.teShort = 280;
        this.teLong = 143;
        this.teDelta = 51;
        this.minCountBitForFound = 62;
    }
    feed(level, duration) {
        let event = Manchester.EVENT_RESET;
        if (!level) {
            if (this.dd(duration, this.teShort) < this.teDelta)
                event = Manchester.EVENT_SHORT_LOW;
            else if (this.dd(duration, this.teLong) < this.teDelta * 2)
                event = Manchester.EVENT_LONG_LOW;
        }
        else {
            if (this.dd(duration, this.teShort) < this.teDelta)
                event = Manchester.EVENT_SHORT_HIGH;
            else if (this.dd(duration, this.teLong) < this.teDelta * 2)
                event = Manchester.EVENT_LONG_HIGH;
        }
        if (event !== Manchester.EVENT_RESET) {
            if (this.manchester.advance(event))
                this.honeywellAddBit(this.manchester.data);
        }
        else {
            this.decodeData = 0n;
            this.decodeCountBit = 0;
        }
    }
    honeywellAddBit(bit) {
        this.addBit(bit ? 1 : 0);
        const preamble = Number((this.decodeData >> 48n) & 0xffffn);
        if (preamble === 0b0011111111111110 || preamble === 0b0111111111111110 || preamble === 0b1111111111111110) {
            const dataToCrc = [0, 0, 0, 0];
            dataToCrc[0] = Number((this.decodeData >> 40n) & 0xffn);
            dataToCrc[1] = Number((this.decodeData >> 32n) & 0xffn);
            dataToCrc[2] = Number((this.decodeData >> 24n) & 0xffn);
            dataToCrc[3] = Number((this.decodeData >> 16n) & 0xffn);
            const channel = Number((this.decodeData >> 44n) & 0xfn);
            let crcCalc;
            if (channel === 0x2 || channel === 0x4 || channel === 0xA)
                crcCalc = this.crc16(dataToCrc, 4, 0x8050, 0);
            else
                crcCalc = this.crc16(dataToCrc, 4, 0x8005, 0);
            const crc = Number(this.decodeData & 0xffffn);
            if (crc === crcCalc) {
                this.dataCountBit = this.decodeCountBit;
                this.hit();
                this.decodeData = 0n;
                this.decodeCountBit = 0;
            }
            else
                return;
        }
    }
    crc16(message, nBytes, polynomial, init) {
        let remainder = init & 0xFFFF;
        for (let b = 0; b < nBytes; b++) {
            remainder ^= (message[b] << 8) & 0xFFFF;
            for (let bit = 0; bit < 8; bit++)
                remainder = (remainder & 0x8000) ? ((remainder << 1) ^ polynomial) & 0xFFFF : (remainder << 1) & 0xFFFF;
        }
        return remainder;
    }
}
