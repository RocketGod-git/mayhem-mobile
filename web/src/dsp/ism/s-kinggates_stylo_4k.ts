/** KingGates Stylo 4K remotes (Mayhem fprotos/s-kinggates_stylo_4k.hpp; twin of ism/SKinggatesStylo4k.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_CHECK_START_BIT = 2, STEP_SAVE_DURATION = 3, STEP_CHECK_DURATION = 4;

export class SKinggatesStylo4k extends FProto {
  constructor() { super(Fam.REMOTE, S.KINGGATES_STYLO_4K); this.teShort = 400; this.teLong = 1100; this.teDelta = 140; this.minCountBitForFound = 89; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBULA; this.headerCount++; }
        break;
      case STEP_CHECK_PREAMBULA:
        if (!level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_RESET; break; }
        if (this.headerCount > 2 && this.dd(duration, this.teLong * 2) < this.teDelta * 2) {
          // Found header
          this.parserStep = STEP_CHECK_START_BIT;
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
      case STEP_CHECK_START_BIT:
        if (level && this.dd(duration, this.teShort * 2) < this.teDelta * 2) { this.parserStep = STEP_SAVE_DURATION; this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0; }
        break;
      case STEP_SAVE_DURATION:
        if (!level) {
          if (duration >= this.teLong * 3) {
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.parserStep = STEP_RESET;
            this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0;
            break;
          } else { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
      case STEP_CHECK_DURATION:
        if (level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
          else { this.parserStep = STEP_RESET; this.headerCount = 0; }
          if (this.decodeCountBit === 53) this.decodeData = 0n;
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
    }
  }
}
