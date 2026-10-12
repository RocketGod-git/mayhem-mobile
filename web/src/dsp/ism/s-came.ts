/** CAME remotes; switches to PRASTEL / AIRFORCE by bit count (Mayhem fprotos/s-came.hpp; twin of ism/SCame.kt). */
import { FProto, Fam, S } from './base.js';

const CAME_24_COUNT_BIT = 24, PRASTEL_COUNT_BIT = 25, AIRFORCE_COUNT_BIT = 18;
const STEP_RESET = 0, STEP_FOUND = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class SCame extends FProto {
  constructor() { super(Fam.REMOTE, S.CAME); this.teShort = 320; this.teLong = 640; this.teDelta = 150; this.minCountBitForFound = 12; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 56) < this.teDelta * 47) this.parserStep = STEP_FOUND;
        break;
      case STEP_FOUND:
        if (level) {
          if (this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_SAVE:
        if (!level) {
          if (duration >= this.teShort * 4) {
            this.parserStep = STEP_FOUND;
            if (this.decodeCountBit === this.minCountBitForFound || this.decodeCountBit === AIRFORCE_COUNT_BIT ||
                this.decodeCountBit === PRASTEL_COUNT_BIT || this.decodeCountBit === CAME_24_COUNT_BIT) {
              this.dataCountBit = this.decodeCountBit;
              this.sensorType = S.CAME;
              if (this.decodeCountBit === PRASTEL_COUNT_BIT) this.sensorType = S.PRASTEL;
              if (this.decodeCountBit === AIRFORCE_COUNT_BIT) this.sensorType = S.AIRFORCE;
              this.hit();
            }
            break;
          }
          this.teLast = duration;
          this.parserStep = STEP_CHECK;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
