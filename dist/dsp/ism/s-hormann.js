import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_FOUND_START_BIT = 3, STEP_SAVE_DURATION = 4, STEP_CHECK_DURATION = 5;
const HSM_PATTERN = 0xff000000003n;
export class SHormann extends FProto {
    constructor() { super(Fam.REMOTE, S.HORMANN); this.teShort = 500; this.teLong = 1000; this.teDelta = 200; this.minCountBitForFound = 44; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort * 24) < this.teDelta * 24)
                    this.parserStep = STEP_FOUND_START_BIT;
                break;
            case STEP_FOUND_START_BIT:
                if (!level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_SAVE_DURATION;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE_DURATION:
                if (level) {
                    if (duration >= this.teShort * 5 && (this.decodeData & HSM_PATTERN) === HSM_PATTERN) {
                        this.parserStep = STEP_FOUND_START_BIT;
                        if (this.decodeCountBit >= this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        break;
                    }
                    this.teLast = duration;
                    this.parserStep = STEP_CHECK_DURATION;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK_DURATION:
                if (!level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(1);
                        this.parserStep = STEP_SAVE_DURATION;
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
