import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_FOUND_START_BIT = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
const HEADER_MASK = 0xf000000000n, HEADER = 0x5000000000n;
export class SHoltek extends FProto {
    constructor() { super(Fam.REMOTE, S.HOLTEK); this.teShort = 430; this.teLong = 870; this.teDelta = 100; this.minCountBitForFound = 40; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 36) < this.teDelta * 36)
                    this.parserStep = STEP_FOUND_START_BIT;
                break;
            case STEP_FOUND_START_BIT:
                if (level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_SAVE_DURATION;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE_DURATION:
                if (!level) {
                    if (duration >= this.teShort * 10 + this.teDelta) {
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            if ((this.decodeData & HEADER_MASK) === HEADER) {
                                this.dataCountBit = this.decodeCountBit;
                                this.hit();
                            }
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.parserStep = STEP_FOUND_START_BIT;
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
                if (level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) {
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
