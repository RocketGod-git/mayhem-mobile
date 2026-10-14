import { FProto, Fam, S, Manchester, MASK64 } from './base.js';
const STEP_RESET = 0, STEP_DECODER_DATA = 2;
export class SMarantec extends FProto {
    constructor() {
        super(Fam.REMOTE, S.MARANTEC);
        this.manchester = new Manchester();
        this.teShort = 1000;
        this.teLong = 2000;
        this.teDelta = 200;
        this.minCountBitForFound = 49;
    }
    feed(level, duration) {
        let event = Manchester.EVENT_RESET;
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teLong * 5) < this.teDelta * 8) {
                    this.parserStep = STEP_DECODER_DATA;
                    this.decodeData = 1n;
                    this.decodeCountBit = 1;
                    this.manchester.advance(Manchester.EVENT_RESET);
                }
                break;
            case STEP_DECODER_DATA:
                if (!level) {
                    if (this.dd(duration, this.teShort) < this.teDelta)
                        event = Manchester.EVENT_SHORT_LOW;
                    else if (this.dd(duration, this.teLong) < this.teDelta)
                        event = Manchester.EVENT_LONG_LOW;
                    else if (duration >= this.teLong * 2 + this.teDelta) {
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            this.hit();
                        }
                        this.decodeData = 1n;
                        this.decodeCountBit = 1;
                        this.manchester.advance(Manchester.EVENT_RESET);
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else {
                    if (this.dd(duration, this.teShort) < this.teDelta)
                        event = Manchester.EVENT_SHORT_HIGH;
                    else if (this.dd(duration, this.teLong) < this.teDelta)
                        event = Manchester.EVENT_LONG_HIGH;
                    else
                        this.parserStep = STEP_RESET;
                }
                if (event !== Manchester.EVENT_RESET) {
                    if (this.manchester.advance(event)) {
                        this.decodeData = ((this.decodeData << 1n) | (this.manchester.data ? 1n : 0n)) & MASK64;
                        this.decodeCountBit++;
                    }
                }
                break;
        }
    }
}
