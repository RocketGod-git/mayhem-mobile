import { FProto, Fam, S, FG } from './base.js';
const STEP_RESET = 0, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
export class SHoneywellWdb extends FProto {
    constructor() { super(Fam.REMOTE, S.HONEYWELL_WDB); this.teShort = 160; this.teLong = 320; this.teDelta = 61; this.minCountBitForFound = 48; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 3) < this.teDelta) {
                    this.decodeCountBit = 0;
                    this.decodeData = 0n;
                    this.parserStep = STEP_SAVE_DURATION;
                }
                break;
            case STEP_SAVE_DURATION:
                if (level) {
                    if (this.dd(duration, this.teShort * 3) < this.teDelta) {
                        if (this.decodeCountBit === this.minCountBitForFound &&
                            Number(this.decodeData & 0x01n) === FG.parity(this.decodeData >> 1n, this.minCountBitForFound - 1)) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        this.parserStep = STEP_RESET;
                        break;
                    }
                    this.teLast = duration;
                    this.parserStep = STEP_CHECK_DURATION;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK_DURATION:
                if (!level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
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
