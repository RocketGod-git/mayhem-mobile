/** Phoenix V2 remotes (Mayhem fprotos/s-phoenix_v2.hpp; twin of ism/SPhoenixV2.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_FOUND_START_BIT = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class SPhoenixV2 extends FProto {
  constructor() { super(Fam.REMOTE, S.PHOENIX_V2); this.teShort = 427; this.teLong = 853; this.teDelta = 100; this.minCountBitForFound = 52; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 60) < this.teDelta * 30) this.parserStep = STEP_FOUND_START_BIT;
        break;
      case STEP_FOUND_START_BIT:
        if (level && this.dd(duration, this.teShort * 6) < this.teDelta * 4) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE:
        if (!level) {
          if (duration >= this.teShort * 10 + this.teDelta) {
            this.parserStep = STEP_FOUND_START_BIT;
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0;
            break;
          } else { this.teLast = duration; this.parserStep = STEP_CHECK; }
        }
        break;
      case STEP_CHECK:
        if (level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 3) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta * 3 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
