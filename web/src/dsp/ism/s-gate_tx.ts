/** Gate-TX remotes (Mayhem fprotos/s-gate_tx.hpp; twin of ism/SGateTx.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_FOUND = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class SGateTx extends FProto {
  constructor() { super(Fam.REMOTE, S.GATE_TX); this.teShort = 350; this.teLong = 700; this.teDelta = 100; this.minCountBitForFound = 24; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 47) < this.teDelta * 47) this.parserStep = STEP_FOUND;
        break;
      case STEP_FOUND:
        if (level && this.dd(duration, this.teLong) < this.teDelta * 3) {
          this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE:
        if (!level) {
          if (duration >= this.teShort * 10 + this.teDelta) {
            this.parserStep = STEP_FOUND;
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0;
            break;
          } else {
            this.teLast = duration;
            this.parserStep = STEP_CHECK;
          }
        }
        break;
      case STEP_CHECK:
        if (level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 3) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta * 3 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
