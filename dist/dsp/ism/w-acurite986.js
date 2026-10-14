import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_SYNC1 = 1, STEP_SYNC2 = 2, STEP_SYNC3 = 3, STEP_SAVE = 4, STEP_CHECK = 5;
export class WAcurite986 extends FProto {
    constructor() { super(Fam.WEATHER, W.ACURITE_986); this.teShort = 800; this.teLong = 1750; this.teDelta = 50; this.minCountBitForFound = 40; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teLong) < this.teDelta * 15) {
                    this.parserStep = STEP_SYNC1;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                break;
            case STEP_SYNC1:
                if (this.dd(duration, this.teLong) < this.teDelta * 15) {
                    if (!level)
                        this.parserStep = STEP_SYNC2;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SYNC2:
                if (this.dd(duration, this.teLong) < this.teDelta * 15) {
                    if (!level)
                        this.parserStep = STEP_SYNC3;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SYNC3:
                if (this.dd(duration, this.teLong) < this.teDelta * 15) {
                    if (!level)
                        this.parserStep = STEP_SAVE;
                }
                else
                    this.parserStep = STEP_RESET;
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
                    if (this.dd(duration, this.teShort) < this.teDelta * 10) {
                        if (duration < this.teShort) {
                            this.addBit(0);
                            this.parserStep = STEP_SAVE;
                        }
                        else {
                            this.addBit(1);
                            this.parserStep = STEP_SAVE;
                        }
                    }
                    else {
                        this.parserStep = STEP_RESET;
                        if (this.decodeCountBit === this.minCountBitForFound && this.check())
                            this.hit();
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                    }
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
        const msg = [FG.bits(d, 32, 0xff), FG.bits(d, 24, 0xff), FG.bits(d, 16, 0xff), FG.bits(d, 8, 0xff)];
        const crc = FG.crc8(msg, 4, 0x07, 0x00);
        return crc === FG.bits(d, 0, 0xff);
    }
}
