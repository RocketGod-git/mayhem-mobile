import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBULE = 1, STEP_SAVE = 2, STEP_CHECK = 3;
export class WGtWt03 extends FProto {
    constructor() { super(Fam.WEATHER, W.GT_WT03); this.teShort = 285; this.teLong = 570; this.teDelta = 120; this.minCountBitForFound = 41; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort * 3) < this.teDelta * 2) {
                    this.parserStep = STEP_CHECK_PREAMBULE;
                    this.teLast = duration;
                    this.headerCount = 0;
                }
                break;
            case STEP_CHECK_PREAMBULE:
                if (level)
                    this.teLast = duration;
                else {
                    if (this.dd(this.teLast, this.teShort * 3) < this.teDelta * 2 && this.dd(duration, this.teShort * 3) < this.teDelta * 2)
                        this.headerCount++;
                    else if (this.headerCount === 4) {
                        if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
                            this.decodeData = 0n;
                            this.decodeCountBit = 0;
                            this.addBit(0);
                            this.parserStep = STEP_SAVE;
                        }
                        else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                            this.decodeData = 0n;
                            this.decodeCountBit = 0;
                            this.addBit(1);
                            this.parserStep = STEP_SAVE;
                        }
                        else
                            this.parserStep = STEP_RESET;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                break;
            case STEP_SAVE:
                if (level) {
                    this.teLast = duration;
                    this.parserStep = STEP_CHECK;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK:
                if (!level) {
                    if (this.dd(this.teLast, this.teShort * 3) < this.teDelta * 2 && this.dd(duration, this.teShort * 3) < this.teDelta * 2) {
                        if (this.decodeCountBit === this.minCountBitForFound && this.checkCrc())
                            this.hit();
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.headerCount = 1;
                        this.parserStep = STEP_CHECK_PREAMBULE;
                        break;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(1);
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
    checkCrc() {
        const d = this.decodeData;
        const msg = [FG.bits(d, 33, 0xff), FG.bits(d, 25, 0xff), FG.bits(d, 17, 0xff), FG.bits(d, 9, 0xff)];
        let sum = 0;
        for (let k = 0; k < msg.length; k++) {
            const data = msg[k];
            let key = 0x3100;
            for (let i = 7; i >= 0; i--) {
                if ((data >>> i) & 1)
                    sum ^= key & 0xff;
                key = key >>> 1;
            }
        }
        return (sum ^ FG.bits(d, 1, 0xFF)) === 0x2D;
    }
}
