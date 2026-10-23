import { FProto, Fam, C } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
export class CKiaV0 extends FProto {
    constructor() { super(Fam.CAR, C.KIA_V0); this.teShort = 250; this.teLong = 500; this.teDelta = 100; this.minCountBitForFound = 61; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_CHECK_PREAMBULA;
                    this.teLast = duration;
                    this.headerCount = 0;
                }
                break;
            case STEP_CHECK_PREAMBULA:
                if (level) {
                    if (this.dd(duration, this.teShort) < this.teDelta || this.dd(duration, this.teLong) < this.teDelta)
                        this.teLast = duration;
                    else
                        this.parserStep = STEP_RESET;
                }
                else if (this.dd(duration, this.teShort) < this.teDelta && this.dd(this.teLast, this.teShort) < this.teDelta)
                    this.headerCount++;
                else if (this.dd(duration, this.teLong) < this.teDelta && this.dd(this.teLast, this.teLong) < this.teDelta) {
                    if (this.headerCount > 15) {
                        this.parserStep = STEP_SAVE_DURATION;
                        this.decodeData = 0n;
                        this.decodeCountBit = 1;
                        this.addBit(1);
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE_DURATION:
                if (level) {
                    if (duration >= this.teLong + this.teDelta * 2) {
                        this.parserStep = STEP_RESET;
                        if (this.decodeCountBit === this.minCountBitForFound) {
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
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
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
