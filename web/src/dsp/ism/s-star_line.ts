/** StarLine car alarm remotes (Mayhem fprotos/s-star_line.hpp; twin of ism/SStarLine.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class SStarLine extends FProto {
  constructor() { super(Fam.REMOTE, S.STARLINE); this.teShort = 250; this.teLong = 500; this.teDelta = 120; this.minCountBitForFound = 64; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level) {
          if (this.dd(duration, this.teLong * 2) < this.teDelta * 2) { this.parserStep = STEP_CHECK_PREAMBULA; this.headerCount++; }
          else if (this.headerCount > 4) { this.decodeData = 0n; this.decodeCountBit = 0; this.teLast = duration; this.parserStep = STEP_CHECK; }
        } else this.headerCount = 0;
        break;
      case STEP_CHECK_PREAMBULA:
        if (!level && this.dd(duration, this.teLong * 2) < this.teDelta * 2) this.parserStep = STEP_RESET;
        else { this.headerCount = 0; this.parserStep = STEP_RESET; }
        break;
      case STEP_SAVE:
        if (level) {
          if (duration >= this.teLong + this.teDelta) {
            this.parserStep = STEP_RESET;
            if (this.decodeCountBit >= this.minCountBitForFound && this.decodeCountBit <= this.minCountBitForFound + 2) { this.dataCountBit = this.minCountBitForFound; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.headerCount = 0;
            break;
          } else { this.teLast = duration; this.parserStep = STEP_CHECK; }
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
            if (this.decodeCountBit < this.minCountBitForFound) this.addBit(0); else this.decodeCountBit++;
            this.parserStep = STEP_SAVE;
          } else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
            if (this.decodeCountBit < this.minCountBitForFound) this.addBit(1); else this.decodeCountBit++;
            this.parserStep = STEP_SAVE;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
