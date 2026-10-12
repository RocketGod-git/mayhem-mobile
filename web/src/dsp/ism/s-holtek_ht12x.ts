/** Holtek HT12X remotes (Mayhem fprotos/s-holtek_ht12x.hpp; twin of ism/SHoltekHt12x.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_FOUND_START_BIT = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;

export class SHoltekHt12x extends FProto {
  constructor() { super(Fam.REMOTE, S.HOLTEK_HT12X); this.teShort = 320; this.teLong = 640; this.teDelta = 200; this.minCountBitForFound = 12; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 36) < this.teDelta * 36) this.parserStep = STEP_FOUND_START_BIT;
        break;
      case STEP_FOUND_START_BIT:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_SAVE_DURATION; this.decodeData = 0n; this.decodeCountBit = 0; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION:
        if (!level) {
          if (duration >= this.teShort * 10 + this.teDelta) {
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.parserStep = STEP_FOUND_START_BIT;
            break;
          } else { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (level) {
          if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
