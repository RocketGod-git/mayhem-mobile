import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
export class WAcurite606Tx extends FProto {
    constructor() { super(Fam.WEATHER, W.ACURITE_606TX); this.teShort = 500; this.teLong = 2000; this.teDelta = 150; this.minCountBitForFound = 32; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 17) < this.teDelta * 8) {
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
                        if (this.dd(duration, this.teShort) < this.teDelta || duration > this.teLong * 3) {
                            this.parserStep = STEP_RESET;
                            if (this.decodeCountBit === this.minCountBitForFound && this.check())
                                this.hit();
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
        const d = this.decodeData;
        const msg = [FG.bits(d, 24, 0xff), FG.bits(d, 16, 0xff), FG.bits(d, 8, 0xff)];
        const crc = FG.lfsrDigest8(msg, 3, 0x98, 0xF1);
        return crc === FG.bits(d, 0, 0xff);
    }
}
