import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class SLinearDelta3 extends FProto {
    constructor() { super(Fam.REMOTE, S.LINEAR_DELTA3); this.teShort = 500; this.teLong = 2000; this.teDelta = 150; this.minCountBitForFound = 8; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 70) < this.teDelta * 24) {
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                    this.parserStep = STEP_SAVE;
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
                    if (duration >= this.teShort * 10) {
                        this.parserStep = STEP_RESET;
                        if (this.dd(this.teLast, this.teShort) < this.teDelta)
                            this.addBit(1);
                        else if (this.dd(this.teLast, this.teLong) < this.teDelta)
                            this.addBit(0);
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                            this.parserStep = STEP_SAVE;
                        }
                        break;
                    }
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 7) < this.teDelta) {
                        this.addBit(1);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
                        this.addBit(0);
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
}
