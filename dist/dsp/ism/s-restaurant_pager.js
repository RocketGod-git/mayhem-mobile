import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class SRestaurantPager extends FProto {
    constructor() { super(Fam.REMOTE, S.RESTAURANT_PAGER); this.teShort = 204; this.teLong = 636; this.teDelta = 100; this.minCountBitForFound = 25; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 36) < this.teDelta * 36) {
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
                break;
            case STEP_CHECK:
                if (!level) {
                    if (duration >= this.teLong * 2) {
                        this.parserStep = STEP_SAVE;
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            if ((this.decodeData >> 1n) !== 0xffffffn) {
                                this.dataCountBit = this.decodeCountBit;
                                this.hit();
                            }
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        break;
                    }
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 3) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta * 3 && this.dd(duration, this.teShort) < this.teDelta) {
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
