import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBULE = 1, STEP_SAVE = 2, STEP_CHECK = 3;
export class WAcurite592Txr extends FProto {
    constructor() { super(Fam.WEATHER, W.ACURITE_592TXR); this.teShort = 200; this.teLong = 400; this.teDelta = 90; this.minCountBitForFound = 56; }
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
                    else if (this.headerCount > 2 && this.headerCount < 5) {
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
                    if (duration >= this.teShort * 5) {
                        if (this.decodeCountBit === this.minCountBitForFound && this.checkCrc())
                            this.hit();
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.parserStep = STEP_RESET;
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
        const msg = [FG.bits(d, 48, 0xff), FG.bits(d, 40, 0xff), FG.bits(d, 32, 0xff), FG.bits(d, 24, 0xff), FG.bits(d, 16, 0xff), FG.bits(d, 8, 0xff)];
        return FG.addBytes(msg, 6) === FG.bits(d, 0, 0xff) && FG.parityBytes(msg.slice(2), 4) === 0;
    }
}
