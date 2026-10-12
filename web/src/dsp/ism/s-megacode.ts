/** Linear MegaCode remotes (Mayhem fprotos/s-megacode.hpp; twin of ism/SMegacode.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_FOUND_START_BIT = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class SMegacode extends FProto {
  private lastBit = 0;

  constructor() { super(Fam.REMOTE, S.MEGACODE); this.teShort = 1000; this.teLong = 1000; this.teDelta = 200; this.minCountBitForFound = 24; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 13) < this.teDelta * 17) this.parserStep = STEP_FOUND_START_BIT; // 10..16ms
        break;
      case STEP_FOUND_START_BIT:
        if (level && this.dd(duration, this.teShort) < this.teDelta) {
          // Found start bit MegaCode
          this.parserStep = STEP_SAVE;
          this.decodeData = 0n; this.decodeCountBit = 0;
          this.addBit(1);
          this.lastBit = 1;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE:
        if (!level) {
          if (duration >= this.teShort * 10) {
            this.parserStep = STEP_RESET;
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            break;
          }
          this.teLast = this.lastBit === 0 ? duration - this.teShort * 3 : duration;
          this.parserStep = STEP_CHECK;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (level) {
          if (this.dd(this.teLast, this.teShort * 5) < this.teDelta * 5 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.lastBit = 1; this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teShort * 2) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.lastBit = 0; this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
