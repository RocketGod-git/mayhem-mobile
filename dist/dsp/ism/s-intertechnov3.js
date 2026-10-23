import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_START_SYNC = 1, STEP_FOUND_SYNC = 2, STEP_START_DURATION = 3, STEP_SAVE_DURATION = 4, STEP_CHECK_DURATION = 5, STEP_END_DURATION = 6;
const DIMMING_COUNT_BIT = 36;
export class SIntertechnoV3 extends FProto {
    constructor() { super(Fam.REMOTE, S.INTERTECHNO_V3); this.teShort = 275; this.teLong = 1375; this.teDelta = 150; this.minCountBitForFound = 32; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 37) < this.teDelta * 15)
                    this.parserStep = STEP_START_SYNC;
                break;
            case STEP_START_SYNC:
                if (level && this.dd(duration, this.teShort) < this.teDelta)
                    this.parserStep = STEP_FOUND_SYNC;
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_FOUND_SYNC:
                if (!level && this.dd(duration, this.teShort * 10) < this.teDelta * 3) {
                    this.parserStep = STEP_START_DURATION;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_START_DURATION:
                if (level && this.dd(duration, this.teShort) < this.teDelta)
                    this.parserStep = STEP_SAVE_DURATION;
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE_DURATION:
                if (!level) {
                    if (duration >= this.teShort * 11) {
                        this.parserStep = STEP_START_SYNC;
                        if (this.decodeCountBit === this.minCountBitForFound || this.decodeCountBit === DIMMING_COUNT_BIT) {
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
                if (level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(0);
                        this.parserStep = STEP_END_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(1);
                        this.parserStep = STEP_END_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta && this.decodeCountBit === 27) {
                        this.addBit(0);
                        this.parserStep = STEP_END_DURATION;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_END_DURATION:
                if (!level && (this.dd(duration, this.teShort) < this.teDelta || this.dd(duration, this.teLong) < this.teDelta * 2))
                    this.parserStep = STEP_START_DURATION;
                else
                    this.parserStep = STEP_RESET;
                break;
        }
    }
}
