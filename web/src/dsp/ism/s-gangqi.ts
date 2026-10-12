/** GangQi remotes (Mayhem fprotos/s-gangqi.hpp; twin of ism/SGangqi.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;

export class SGangqi extends FProto {
  constructor() { super(Fam.REMOTE, S.GANGQI); this.teShort = 500; this.teLong = 1200; this.teDelta = 200; this.minCountBitForFound = 34; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teLong * 2) < this.teDelta * 3) {
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE;
        }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(duration, this.teShort * 4) < this.teDelta) {
            if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 4) < this.teDelta) this.addBit(0);
            if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort * 4) < this.teDelta) this.addBit(1);
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
