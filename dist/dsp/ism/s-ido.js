import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_FOUND_PREAMBULA = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
export class SIdo extends FProto {
    constructor() { super(Fam.REMOTE, S.IDO); this.teShort = 450; this.teLong = 1450; this.teDelta = 150; this.minCountBitForFound = 48; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort * 10) < this.teDelta * 5)
                    this.parserStep = STEP_FOUND_PREAMBULA;
                break;
            case STEP_FOUND_PREAMBULA:
                if (!level && this.dd(duration, this.teShort * 10) < this.teDelta * 5) {
                    this.parserStep = STEP_SAVE_DURATION;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE_DURATION:
                if (level) {
                    if (duration >= this.teShort * 5 + this.teDelta) {
                        this.parserStep = STEP_FOUND_PREAMBULA;
                        if (this.decodeCountBit >= this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        break;
                    }
                    else {
                        this.teLast = duration;
                        this.parserStep = STEP_CHECK_DURATION;
                    }
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK_DURATION:
                if (!level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 3) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta * 3 && this.dd(duration, this.teShort) < this.teDelta) {
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
