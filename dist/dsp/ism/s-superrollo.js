import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_PREAMBLE_LOW = 1, STEP_SYNC_LOW = 2, STEP_SAVE = 3, STEP_CHECK = 4;
export class SSuperrollo extends FProto {
    constructor() { super(Fam.REMOTE, S.SUPERROLLO); this.teShort = 450; this.teLong = 900; this.teDelta = 200; this.minCountBitForFound = 64; }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level) {
                    if (this.dd(duration, this.teShort) < this.teDelta) {
                        this.headerCount++;
                        this.parserStep = STEP_PREAMBLE_LOW;
                    }
                    else if (this.headerCount >= 4 && this.dd(duration, this.teShort * 10) < this.teDelta * 10)
                        this.parserStep = STEP_SYNC_LOW;
                    else
                        this.headerCount = 0;
                }
                else
                    this.headerCount = 0;
                break;
            case STEP_PREAMBLE_LOW:
                if (!level && this.dd(duration, this.teLong) < this.teDelta)
                    this.parserStep = STEP_RESET;
                else {
                    this.parserStep = STEP_RESET;
                    this.headerCount = 0;
                }
                break;
            case STEP_SYNC_LOW:
                if (!level && this.dd(duration, this.teShort * 10) < this.teDelta * 10) {
                    this.parserStep = STEP_SAVE;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                else {
                    this.parserStep = STEP_RESET;
                    this.headerCount = 0;
                }
                break;
            case STEP_SAVE:
                if (level) {
                    this.teLast = duration;
                    this.parserStep = STEP_CHECK;
                }
                else if (duration >= this.teShort * 12)
                    this.endFrame();
                break;
            case STEP_CHECK:
                if (!level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
                        if (this.decodeCountBit < this.minCountBitForFound)
                            this.addBit(1);
                        else
                            this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                        if (this.decodeCountBit < this.minCountBitForFound)
                            this.addBit(0);
                        else
                            this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else if (duration >= this.teShort * 12)
                        this.endFrame();
                    else {
                        this.parserStep = STEP_RESET;
                        this.headerCount = 0;
                    }
                }
                else {
                    this.parserStep = STEP_RESET;
                    this.headerCount = 0;
                }
                break;
        }
    }
    endFrame() {
        if (this.decodeCountBit >= this.minCountBitForFound && this.decodeCountBit <= this.minCountBitForFound + 3) {
            this.dataCountBit = this.minCountBitForFound;
            this.hit();
        }
        this.parserStep = STEP_RESET;
        this.decodeData = 0n;
        this.decodeCountBit = 0;
        this.headerCount = 0;
    }
}
