import { FProto, Fam, C, Manchester } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_DATA = 2;
export class CKiaV5 extends FProto {
    constructor() {
        super(Fam.CAR, C.KIA_V5);
        this.manchester = new Manchester();
        this.teShort = 400;
        this.teLong = 800;
        this.teDelta = 150;
        this.minCountBitForFound = 64;
    }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_CHECK_PREAMBLE;
                    this.teLast = duration;
                    this.headerCount = 1;
                    this.decodeCountBit = 0;
                    this.decodeData = 0n;
                    this.manchester.advance(Manchester.EVENT_RESET);
                }
                break;
            case STEP_CHECK_PREAMBLE:
                if (level) {
                    if (this.dd(duration, this.teLong) < this.teDelta) {
                        if (this.headerCount > 40) {
                            this.parserStep = STEP_DATA;
                            this.decodeCountBit = 0;
                            this.decodeData = 0n;
                            this.decodeData2 = 0n;
                            this.headerCount = 0;
                        }
                        else
                            this.teLast = duration;
                    }
                    else if (this.dd(duration, this.teShort) < this.teDelta)
                        this.teLast = duration;
                    else
                        this.parserStep = STEP_RESET;
                }
                else {
                    if (this.dd(duration, this.teShort) < this.teDelta && this.dd(this.teLast, this.teShort) < this.teDelta)
                        this.headerCount++;
                    else if (this.dd(duration, this.teLong) < this.teDelta && this.dd(this.teLast, this.teShort) < this.teDelta)
                        this.headerCount++;
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta)
                        this.headerCount++;
                    else
                        this.parserStep = STEP_RESET;
                    this.teLast = duration;
                }
                break;
            case STEP_DATA: {
                let event;
                if (this.dd(duration, this.teShort) < this.teDelta)
                    event = level ? Manchester.EVENT_SHORT_HIGH : Manchester.EVENT_SHORT_LOW;
                else if (this.dd(duration, this.teLong) < this.teDelta)
                    event = level ? Manchester.EVENT_LONG_HIGH : Manchester.EVENT_LONG_LOW;
                else {
                    if (this.decodeCountBit >= this.minCountBitForFound) {
                        this.dataCountBit = this.decodeCountBit > 67 ? 67 : this.decodeCountBit;
                        this.hit();
                    }
                    this.parserStep = STEP_RESET;
                    break;
                }
                if (this.decodeCountBit <= 66 && this.manchester.advance(event)) {
                    this.addBit(this.manchester.data ? 1 : 0);
                    if (this.decodeCountBit === 64) {
                        this.decodeData2 = this.decodeData;
                        this.decodeData = 0n;
                    }
                }
                this.teLast = duration;
                break;
            }
        }
    }
}
