import { FProto, Fam, W } from './base.js';
const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2, CONST_DATA = 0b1111;
export class WNexusTh extends FProto {
    constructor() { super(Fam.WEATHER, W.NEXUS_TH); this.teShort = 490; this.teLong = 1980; this.teDelta = 150; this.minCountBitForFound = 36; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 8) < this.teDelta * 4) {
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
                    if (this.dd(duration, this.teShort * 8) < this.teDelta * 4) {
                        this.parserStep = STEP_RESET;
                        if (this.decodeCountBit === this.minCountBitForFound && this.check()) {
                            this.hit();
                            this.parserStep = STEP_CHECK;
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 2) < this.teDelta * 2) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 4) < this.teDelta * 4) {
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
    check() {
        const type = Number((this.decodeData >> 8n) & 0x0fn);
        return type === CONST_DATA && (this.decodeData >> 4n) !== 0xffffffffn;
    }
}
