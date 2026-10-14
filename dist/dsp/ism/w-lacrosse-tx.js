import { FProto, Fam, W, FG } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_SAVE = 2, STEP_CHECK = 3;
const GAP = 1000;
const SYNC_PATTERN = 0x0a000000000n;
const SYNC_MASK = 0x0f000000000n;
export class WLacrosseTx extends FProto {
    constructor() { super(Fam.WEATHER, W.LACROSSE_TX); this.teShort = 550; this.teLong = 1300; this.teDelta = 120; this.minCountBitForFound = 40; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, GAP) < this.teDelta * 2) {
                    this.parserStep = STEP_CHECK_PREAMBLE;
                    this.headerCount = 0;
                }
                break;
            case STEP_CHECK_PREAMBLE:
                if (level) {
                    if (this.dd(duration, this.teShort) < this.teDelta && this.headerCount > 1) {
                        this.parserStep = STEP_CHECK;
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.teLast = duration;
                    }
                    else if (duration > this.teLong * 2)
                        this.parserStep = STEP_RESET;
                }
                else {
                    if (this.dd(duration, GAP) < this.teDelta * 2) {
                        this.teLast = duration;
                        this.headerCount++;
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
                    if (duration > GAP * 3) {
                        if (this.dd(this.teLast, this.teShort) < this.teDelta) {
                            this.addBit(1);
                            this.parserStep = STEP_SAVE;
                        }
                        else if (this.dd(this.teLast, this.teLong) < this.teDelta) {
                            this.addBit(0);
                            this.parserStep = STEP_SAVE;
                        }
                        if ((this.decodeData & SYNC_MASK) === SYNC_PATTERN) {
                            if (this.checkCrc())
                                this.hit();
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.headerCount = 0;
                        this.parserStep = STEP_RESET;
                        break;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, GAP) < this.teDelta * 2) {
                        this.addBit(1);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, GAP) < this.teDelta * 2) {
                        this.addBit(0);
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
        if (this.decodeData === 0n)
            return false;
        const d = this.decodeData;
        const msg = [FG.bits(d, 36, 0x0F), FG.bits(d, 32, 0x0F), FG.bits(d, 28, 0x0F), FG.bits(d, 24, 0x0F), FG.bits(d, 20, 0x0F), FG.bits(d, 16, 0x0F), FG.bits(d, 12, 0x0F), FG.bits(d, 8, 0x0F), FG.bits(d, 4, 0x0F)];
        const crc = FG.addBytes(msg, 9);
        return (crc & 0x0F) === FG.bits(d, 0, 0x0F);
    }
}
