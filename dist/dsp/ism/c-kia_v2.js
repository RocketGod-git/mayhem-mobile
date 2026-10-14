import { FProto, Fam, C, Manchester } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_COLLECT_RAW_BITS = 2;
export class CKiaV2 extends FProto {
    constructor() {
        super(Fam.CAR, C.KIA_V2);
        this.manchester = new Manchester();
        this.teShort = 500;
        this.teLong = 1000;
        this.teDelta = 160;
        this.minCountBitForFound = 53;
    }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teLong) < this.teDelta) {
                    this.parserStep = STEP_CHECK_PREAMBLE;
                    this.teLast = duration;
                    this.headerCount = 0;
                    this.manchester.advance(Manchester.EVENT_RESET);
                }
                break;
            case STEP_CHECK_PREAMBLE:
                if (level) {
                    if (this.dd(duration, this.teLong) < this.teDelta) {
                        this.teLast = duration;
                        this.headerCount++;
                    }
                    else if (this.dd(duration, this.teShort) < this.teDelta) {
                        if (this.headerCount >= 100) {
                            this.headerCount = 0;
                            this.decodeData = 0n;
                            this.decodeCountBit = 1;
                            this.parserStep = STEP_COLLECT_RAW_BITS;
                            this.addBit(1);
                        }
                        else
                            this.teLast = duration;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else {
                    if (this.dd(duration, this.teLong) < this.teDelta) {
                        this.headerCount++;
                        this.teLast = duration;
                    }
                    else if (this.dd(duration, this.teShort) < this.teDelta)
                        this.teLast = duration;
                    else
                        this.parserStep = STEP_RESET;
                }
                break;
            case STEP_COLLECT_RAW_BITS: {
                let event;
                if (this.dd(duration, this.teShort) < this.teDelta)
                    event = level ? Manchester.EVENT_SHORT_LOW : Manchester.EVENT_SHORT_HIGH;
                else if (this.dd(duration, this.teLong) < this.teDelta)
                    event = level ? Manchester.EVENT_LONG_LOW : Manchester.EVENT_LONG_HIGH;
                else {
                    this.parserStep = STEP_RESET;
                    break;
                }
                if (this.manchester.advance(event)) {
                    this.addBit(this.manchester.data ? 1 : 0);
                    if (this.decodeCountBit === 53) {
                        this.dataCountBit = this.decodeCountBit;
                        this.hit();
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.headerCount = 0;
                        this.parserStep = STEP_RESET;
                    }
                }
                break;
            }
        }
    }
}
