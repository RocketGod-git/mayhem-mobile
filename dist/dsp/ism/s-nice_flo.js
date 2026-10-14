import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_FOUND_START_BIT = 1, STEP_SAVE = 2, STEP_CHECK = 3;
export class SNiceFlo extends FProto {
    constructor() { super(Fam.REMOTE, S.NICE_FLO); this.teShort = 700; this.teLong = 1400; this.teDelta = 200; this.minCountBitForFound = 12; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 36) < this.teDelta * 36)
                    this.parserStep = STEP_FOUND_START_BIT;
                break;
            case STEP_FOUND_START_BIT:
                if (!level)
                    break;
                else if (this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_SAVE;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE:
                if (!level) {
                    if (duration >= this.teShort * 4) {
                        this.parserStep = STEP_FOUND_START_BIT;
                        if (this.decodeCountBit >= this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        break;
                    }
                    this.teLast = duration;
                    this.parserStep = STEP_CHECK;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK:
                if (level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
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
}
