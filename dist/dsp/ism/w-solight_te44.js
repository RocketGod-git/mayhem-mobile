import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class WSolightTe44 extends FProto {
    constructor() { super(Fam.WEATHER, W.SOLIGHT_TE44); this.teShort = 490; this.teLong = 3000; this.teDelta = 150; this.minCountBitForFound = 36; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && duration >= this.teLong) {
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
                    if (this.dd(duration, this.teShort) < this.teDelta) {
                        if (this.decodeCountBit === this.minCountBitForFound && this.check())
                            this.hit();
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.parserStep = STEP_RESET;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta) {
                        if (this.dd(duration, this.teShort * 2) < this.teDelta) {
                            this.addBit(0);
                            this.parserStep = STEP_SAVE;
                        }
                        else if (this.dd(duration, this.teShort * 4) < this.teDelta) {
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
        if (FG.bits(this.decodeData, 8, 0x0f) !== 0x0f)
            return false;
        const d = this.decodeData;
        const msg = [FG.bits(d, 28, 0xff), FG.bits(d, 20, 0xff), FG.bits(d, 12, 0xff), 0xf0, (FG.bits(d, 0, 0xf0) | FG.bits(d, 0, 0x0f))];
        return FG.crc8(msg, 5, 0x31, 0x6c) === 0;
    }
}
