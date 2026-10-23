import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class SMarantec24 extends FProto {
    constructor() { super(Fam.REMOTE, S.MARANTEC24); this.teShort = 800; this.teLong = 1600; this.teDelta = 200; this.minCountBitForFound = 24; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teLong * 9) < this.teDelta * 4) {
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
                    if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort * 3) < this.teDelta) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong * 2) < this.teDelta) {
                        this.addBit(1);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(duration, this.teLong * 9) < this.teDelta * 4) {
                        if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teLong * 9) < this.teDelta * 4)
                            this.addBit(0);
                        if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong * 9) < this.teDelta * 4)
                            this.addBit(1);
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.parserStep = STEP_RESET;
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
