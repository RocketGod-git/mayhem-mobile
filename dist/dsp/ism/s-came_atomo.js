import { FProto, Fam, S, Manchester, MASK64 } from './base.js';
const STEP_RESET = 0, STEP_DATA = 1;
export class SCameAtomo extends FProto {
    constructor() {
        super(Fam.REMOTE, S.CAME_ATOMO);
        this.manchester = new Manchester();
        this.teShort = 600;
        this.teLong = 1200;
        this.teDelta = 250;
        this.minCountBitForFound = 62;
    }
    feed(level, duration) {
        let event = Manchester.EVENT_RESET;
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teLong * 60) < this.teDelta * 40) {
                    this.parserStep = STEP_DATA;
                    this.decodeData = 0n;
                    this.decodeCountBit = 1;
                    this.manchester.advance(Manchester.EVENT_RESET);
                    this.manchester.advance(Manchester.EVENT_SHORT_LOW);
                }
                break;
            case STEP_DATA:
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
                        this.decodeData = 0n;
                        this.decodeCountBit = 1;
                        this.manchester.advance(Manchester.EVENT_RESET);
                        this.manchester.advance(Manchester.EVENT_SHORT_LOW);
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
                        this.decodeData = ((this.decodeData << 1n) | (this.manchester.data ? 0n : 1n)) & MASK64;
                        this.decodeCountBit++;
                    }
                }
                break;
        }
    }
}
