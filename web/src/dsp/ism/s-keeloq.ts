/** KeeLoq rolling-code remotes (Mayhem fprotos/s-keeloq.hpp; twin of ism/SKeeloq.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;

export class SKeeloq extends FProto {
  constructor() { super(Fam.REMOTE, S.KEELOQ); this.teShort = 400; this.teLong = 800; this.teDelta = 140; this.minCountBitForFound = 64; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBULA; this.headerCount++; }
        break;
      case STEP_CHECK_PREAMBULA:
        if (!level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_RESET; break; }
        if (this.headerCount > 2 && this.dd(duration, this.teShort * 10) < this.teDelta * 10) {
          // Found header
          this.parserStep = STEP_SAVE_DURATION; this.decodeData = 0n; this.decodeCountBit = 0;
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
      case STEP_SAVE_DURATION:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (duration >= this.teShort * 2 + this.teDelta) {
            // Found end TX
            this.parserStep = STEP_RESET;
            if (this.decodeCountBit >= this.minCountBitForFound && this.decodeCountBit <= this.minCountBitForFound + 2) {
              this.dataCountBit = this.minCountBitForFound;
              this.hit();
              this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0;
            }
            break;
          } else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) {
            if (this.decodeCountBit < this.minCountBitForFound) this.addBit(1); else this.decodeCountBit++;
            this.parserStep = STEP_SAVE_DURATION;
          } else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) {
            if (this.decodeCountBit < this.minCountBitForFound) this.addBit(0); else this.decodeCountBit++;
            this.parserStep = STEP_SAVE_DURATION;
          } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
    }
  }
}
