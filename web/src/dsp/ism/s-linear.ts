/** Linear garage remotes (Mayhem fprotos/s-linear.hpp; twin of ism/SLinear.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;

export class SLinear extends FProto {
  constructor() { super(Fam.REMOTE, S.LINEAR); this.teShort = 500; this.teLong = 1500; this.teDelta = 150; this.minCountBitForFound = 10; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 42) < this.teDelta * 20) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (duration >= this.teShort * 5) {
            this.parserStep = STEP_RESET;
            // checking that the duration matches the guardtime
            if (this.dd(duration, this.teShort * 42) > this.teDelta * 20) break;
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            else if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            break;
          }
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
