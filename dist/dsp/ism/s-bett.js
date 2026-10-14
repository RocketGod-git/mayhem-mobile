import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class SBett extends FProto {
    constructor() { super(Fam.REMOTE, S.BETT); this.teShort = 340; this.teLong = 2000; this.teDelta = 150; this.minCountBitForFound = 18; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 44) < this.teDelta * 15) {
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                    this.parserStep = STEP_CHECK;
                }
                break;
            case STEP_SAVE:
                if (!level) {
                    if (this.dd(duration, this.teShort * 44) < this.teDelta * 15) {
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        else
                            this.parserStep = STEP_RESET;
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                    }
                    else {
                        if (this.dd(duration, this.teShort) < this.teDelta || this.dd(duration, this.teLong) < this.teDelta * 3)
                            this.parserStep = STEP_CHECK;
                        else
                            this.parserStep = STEP_RESET;
                    }
                }
                break;
            case STEP_CHECK:
                if (level) {
                    if (this.dd(duration, this.teLong) < this.teDelta * 3) {
                        this.addBit(1);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(duration, this.teShort) < this.teDelta) {
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
