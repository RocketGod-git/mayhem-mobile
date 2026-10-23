import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_FOUND = 1, STEP_SAVE = 2, STEP_CHECK = 3;
export class SDooya extends FProto {
    constructor() { super(Fam.REMOTE, S.DOOYA); this.teShort = 366; this.teLong = 733; this.teDelta = 120; this.minCountBitForFound = 40; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teLong * 12) < this.teDelta * 20)
                    this.parserStep = STEP_FOUND;
                break;
            case STEP_FOUND:
                if (!level) {
                    if (this.dd(duration, this.teLong * 2) < this.teDelta * 3) {
                        this.parserStep = STEP_SAVE;
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else if (this.dd(duration, this.teShort * 13) < this.teDelta * 5) {
                    break;
                }
                else
                    this.parserStep = STEP_RESET;
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
                    if (duration >= this.teLong * 4) {
                        if (this.dd(this.teLast, this.teShort) < this.teDelta)
                            this.addBit(0);
                        else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2)
                            this.addBit(1);
                        else {
                            this.parserStep = STEP_RESET;
                            break;
                        }
                        this.parserStep = STEP_FOUND;
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        break;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) {
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
}
