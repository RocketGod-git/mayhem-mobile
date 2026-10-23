import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_CHECK_HEADER = 1, STEP_FOUND_HEADER = 2, STEP_SAVE = 3, STEP_CHECK = 4, NICE_ONE_COUNT_BIT = 72;
export class SNiceFlors extends FProto {
    constructor() { super(Fam.REMOTE, S.NICE_FLORS); this.teShort = 500; this.teLong = 1000; this.teDelta = 300; this.minCountBitForFound = 52; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 38) < this.teDelta * 38)
                    this.parserStep = STEP_CHECK_HEADER;
                break;
            case STEP_CHECK_HEADER:
                if (level && this.dd(duration, this.teShort * 3) < this.teDelta * 3)
                    this.parserStep = STEP_FOUND_HEADER;
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_FOUND_HEADER:
                if (!level && this.dd(duration, this.teShort * 3) < this.teDelta * 3) {
                    this.parserStep = STEP_SAVE;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE:
                if (level) {
                    if (this.dd(duration, this.teShort * 3) < this.teDelta) {
                        this.parserStep = STEP_RESET;
                        if (this.decodeCountBit === this.minCountBitForFound || this.decodeCountBit === NICE_ONE_COUNT_BIT) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                            this.decodeData = 0n;
                        }
                        break;
                    }
                    else {
                        this.teLast = duration;
                        this.parserStep = STEP_CHECK;
                    }
                }
                break;
            case STEP_CHECK:
                if (!level) {
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
