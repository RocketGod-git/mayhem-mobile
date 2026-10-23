import { FProto, Fam, S, MASK64 } from './base.js';
const CODE_BIT_STOP = 1n, CODE_BIT_1 = 3n, CODE_BIT_0 = 7n;
const MASK_7 = 0xf000000ff0fn, MASK_8 = 0xf00000f00fn, MASK_9 = 0xf000000000fn;
const MASK_7_CHECK = 0x10000001101n, MASK_8_CHECK = 0x1000001001n, MASK_9_CHECK = 0x10000000001n;
const STEP_RESET = 0, STEP_FOUND = 1, STEP_SAVE = 2, STEP_CHECK = 3;
export class SChambcode extends FProto {
    constructor() { super(Fam.REMOTE, S.CHAMBCODE); this.teShort = 1000; this.teLong = 3000; this.teDelta = 200; this.minCountBitForFound = 10; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 39) < this.teDelta * 20)
                    this.parserStep = STEP_FOUND;
                break;
            case STEP_FOUND:
                if (level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                    this.decodeData = ((this.decodeData << 4n) | CODE_BIT_STOP) & MASK64;
                    this.decodeCountBit++;
                    this.parserStep = STEP_SAVE;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE:
                if (!level) {
                    if (duration > this.teShort * 5) {
                        if (this.decodeCountBit >= this.minCountBitForFound) {
                            if (this.checkMaskAndParse()) {
                                this.dataCountBit = this.decodeCountBit;
                                this.hit();
                            }
                        }
                        this.parserStep = STEP_RESET;
                    }
                    else {
                        this.teLast = duration;
                        this.parserStep = STEP_CHECK;
                    }
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK:
                if (level) {
                    if (this.dd(this.teLast, this.teShort * 3) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                        this.decodeData = ((this.decodeData << 4n) | CODE_BIT_STOP) & MASK64;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teShort * 2) < this.teDelta && this.dd(duration, this.teShort * 2) < this.teDelta) {
                        this.decodeData = ((this.decodeData << 4n) | CODE_BIT_1) & MASK64;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 3) < this.teDelta) {
                        this.decodeData = ((this.decodeData << 4n) | CODE_BIT_0) & MASK64;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
        }
    }
    checkMaskAndParse() {
        if (this.decodeCountBit > this.minCountBitForFound + 1)
            return false;
        if ((this.decodeData & MASK_7) === MASK_7_CHECK) {
            this.decodeCountBit = 7;
            this.decodeData = this.decodeData & ~MASK_7 & MASK64;
            this.decodeData = (this.decodeData >> 12n) | ((this.decodeData >> 4n) & 0xfn);
        }
        else if ((this.decodeData & MASK_8) === MASK_8_CHECK) {
            this.decodeCountBit = 8;
            this.decodeData = this.decodeData & ~MASK_8 & MASK64;
            this.decodeData = (this.decodeData >> 4n) | (CODE_BIT_0 << 8n);
        }
        else if ((this.decodeData & MASK_9) === MASK_9_CHECK) {
            this.decodeCountBit = 9;
            this.decodeData = this.decodeData & ~MASK_9 & MASK64;
            this.decodeData = this.decodeData >> 4n;
        }
        else {
            return false;
        }
        return this.toBit(this.decodeCountBit);
    }
    toBit(size) {
        let dataTmp = this.decodeData;
        let dataRes = 0n;
        for (let i = 0; i < size; i++) {
            const nib = dataTmp & 0xfn;
            if (nib === CODE_BIT_0) { }
            else if (nib === CODE_BIT_1)
                dataRes = dataRes | (1n << BigInt(i));
            else
                return false;
            dataTmp = dataTmp >> 4n;
        }
        this.decodeData = dataRes;
        return true;
    }
}
