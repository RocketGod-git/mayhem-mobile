import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class WGtWt02 extends FProto {
    constructor() { super(Fam.WEATHER, W.GT_WT02); this.teShort = 500; this.teLong = 2000; this.teDelta = 150; this.minCountBitForFound = 37; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 18) < this.teDelta * 8) {
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
                    if (this.dd(this.teLast, this.teShort) < this.teDelta) {
                        if (this.dd(duration, this.teShort * 18) < this.teDelta * 8) {
                            this.parserStep = STEP_RESET;
                            if (this.decodeCountBit === this.minCountBitForFound && this.check())
                                this.hit();
                            else if (this.decodeCountBit === 1)
                                this.parserStep = STEP_SAVE;
                            this.decodeData = 0n;
                            this.decodeCountBit = 0;
                        }
                        else if (this.dd(duration, this.teLong) < this.teDelta * 2) {
                            this.addBit(0);
                            this.parserStep = STEP_SAVE;
                        }
                        else if (this.dd(duration, this.teLong * 2) < this.teDelta * 4) {
                            this.addBit(1);
                            this.parserStep = STEP_SAVE;
                        }
                        else
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
    check() {
        if (this.decodeData === 0n)
            return false;
        let sum = FG.bits(this.decodeData, 5, 0xe);
        const tempData = this.decodeData >> 9n;
        for (let i = 0; i < 7; i++)
            sum = (sum + FG.bits(tempData, i * 4, 0xF)) & 0xff;
        return FG.bits(this.decodeData, 0, 0x3F) === (sum & 0x3F);
    }
}
