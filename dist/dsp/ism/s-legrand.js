import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_FIRST_BIT = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
export class SLegrand extends FProto {
    constructor() {
        super(Fam.REMOTE, S.LEGRAND);
        this.te = 0;
        this.teShort = 375;
        this.teLong = 1125;
        this.teDelta = 150;
        this.minCountBitForFound = 18;
    }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 16) < this.teDelta * 8) {
                    this.parserStep = STEP_FIRST_BIT;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                    this.te = 0;
                }
                break;
            case STEP_FIRST_BIT:
                if (level) {
                    if (this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(0);
                        this.te += duration * 4;
                    }
                    if (this.dd(duration, this.teLong) < this.teDelta * 3) {
                        this.addBit(1);
                        this.te += Math.trunc(duration / 3) * 4;
                    }
                    if (this.decodeCountBit > 0) {
                        this.parserStep = STEP_SAVE_DURATION;
                        break;
                    }
                }
                this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE_DURATION:
                if (!level) {
                    this.teLast = duration;
                    this.te += duration;
                    this.parserStep = STEP_CHECK_DURATION;
                    break;
                }
                this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK_DURATION:
                if (level) {
                    let found = false;
                    if (this.dd(this.teLast, this.teLong) < this.teDelta * 3 && this.dd(duration, this.teShort) < this.teDelta) {
                        found = true;
                        this.addBit(0);
                    }
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 3) {
                        found = true;
                        this.addBit(1);
                    }
                    if (found) {
                        this.te += duration;
                        if (this.decodeCountBit < this.minCountBitForFound) {
                            this.parserStep = STEP_SAVE_DURATION;
                            break;
                        }
                        this.te = Math.trunc(this.te / (this.decodeCountBit * 4));
                        this.dataCountBit = this.decodeCountBit;
                        this.hit();
                    }
                }
                this.parserStep = STEP_RESET;
                break;
        }
    }
}
