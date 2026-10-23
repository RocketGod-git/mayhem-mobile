import { FProto, Fam, C } from './base.js';
const STEP_RESET = 0, STEP_COUNT_PREAMBLE = 1, STEP_DECODE_DATA = 2, GAP_TIME = 2000, GAP_DELTA = 400;
export class CSuzuki extends FProto {
    constructor() { super(Fam.CAR, C.SUZUKI); this.teShort = 250; this.teLong = 500; this.teDelta = 110; this.minCountBitForFound = 64; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level)
                    return;
                if (this.dd(duration, this.teShort) > this.teDelta)
                    return;
                this.decodeData = 0n;
                this.decodeCountBit = 0;
                this.parserStep = STEP_COUNT_PREAMBLE;
                this.headerCount = 0;
                break;
            case STEP_COUNT_PREAMBLE:
                if (level) {
                    if (this.headerCount >= 300) {
                        if (this.dd(duration, this.teLong) <= this.teDelta) {
                            this.parserStep = STEP_DECODE_DATA;
                            this.addBit(1);
                        }
                    }
                }
                else {
                    if (this.dd(duration, this.teShort) <= this.teDelta) {
                        this.teLast = duration;
                        this.headerCount++;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                break;
            case STEP_DECODE_DATA:
                if (level) {
                    if (duration < this.teLong) {
                        const diffLong = 500 - duration;
                        if (diffLong > 99) {
                            const diffShort = duration < 250 ? 250 - duration : duration - 250;
                            if (diffShort <= 99)
                                this.addBit(0);
                        }
                        else
                            this.addBit(1);
                    }
                    else {
                        const diffLong = duration - 500;
                        if (diffLong <= 99)
                            this.addBit(1);
                    }
                }
                else {
                    const diffGap = duration < GAP_TIME ? GAP_TIME - duration : duration - GAP_TIME;
                    if (diffGap <= GAP_DELTA) {
                        if (this.decodeCountBit === 64) {
                            this.dataCountBit = 64;
                            this.hit();
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.parserStep = STEP_RESET;
                    }
                }
                break;
        }
    }
}
