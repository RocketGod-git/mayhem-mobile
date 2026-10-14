import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_SAVE = 2, STEP_CHECK = 3;
export class WKedsum extends FProto {
    constructor() { super(Fam.WEATHER, W.KEDSUM); this.teShort = 500; this.teLong = 2000; this.teDelta = 150; this.minCountBitForFound = 42; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_CHECK_PREAMBLE;
                    this.teLast = duration;
                    this.headerCount = 0;
                }
                break;
            case STEP_CHECK_PREAMBLE:
                if (level)
                    this.teLast = duration;
                else {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong * 4) < this.teDelta * 4)
                        this.headerCount++;
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && duration < (this.teLong * 2 + this.teDelta * 2)) {
                        if (this.headerCount > 0) {
                            this.parserStep = STEP_SAVE;
                            this.decodeData = 0n;
                            this.decodeCountBit = 0;
                            if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) {
                                this.addBit(0);
                                this.parserStep = STEP_SAVE;
                            }
                            else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong * 2) < this.teDelta * 4) {
                                this.addBit(1);
                                this.parserStep = STEP_SAVE;
                            }
                            else
                                this.parserStep = STEP_RESET;
                        }
                    }
                    else
                        this.parserStep = STEP_RESET;
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
                    if (this.dd(duration, this.teLong * 4) < this.teDelta * 4) {
                        if (this.decodeCountBit === this.minCountBitForFound && this.checkCrc())
                            this.hit();
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.parserStep = STEP_RESET;
                        break;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong * 2) < this.teDelta * 4) {
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
    checkCrc() {
        const d = this.decodeData;
        const msg = [FG.bits(d, 32, 0xff), FG.bits(d, 24, 0xff), FG.bits(d, 16, 0xff), FG.bits(d, 8, 0xff), FG.bits(d, 0, 0xff)];
        let crc = FG.crc4(msg, 4, 0x03, 0);
        crc ^= msg[4] >>> 4;
        return crc === (msg[4] & 0x0F);
    }
}
