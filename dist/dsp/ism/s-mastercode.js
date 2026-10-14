import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class SMastercode extends FProto {
    constructor() { super(Fam.REMOTE, S.MASTERCODE); this.teShort = 1072; this.teLong = 2145; this.teDelta = 150; this.minCountBitForFound = 36; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 15) < this.teDelta * 15) {
                    this.parserStep = STEP_SAVE;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
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
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 8) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta * 8 && this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(1);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(duration, this.teShort * 15) < this.teDelta * 15) {
                        if (this.dd(this.teLast, this.teShort) < this.teDelta)
                            this.addBit(0);
                        else if (this.dd(this.teLast, this.teLong) < this.teDelta * 8)
                            this.addBit(1);
                        else
                            this.parserStep = STEP_RESET;
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        this.parserStep = STEP_SAVE;
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
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
