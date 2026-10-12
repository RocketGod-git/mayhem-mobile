/** X10 RF remotes (Mayhem fprotos/s-x10.hpp; twin of ism/SX10.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_FOUND_PREAMBULA = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class SX10 extends FProto {
  constructor() { super(Fam.REMOTE, S.X10); this.teShort = 600; this.teLong = 1800; this.teDelta = 100; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort * 16) < this.teDelta * 7) this.parserStep = STEP_FOUND_PREAMBULA;
        break;
      case STEP_FOUND_PREAMBULA:
        if (!level && this.dd(duration, this.teShort * 8) < this.teDelta * 5) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
        else { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET; }
        break;
      case STEP_SAVE:
        if (level) {
          if (this.dd(duration, this.teShort) < this.teDelta) {
            if (this.decodeCountBit === this.minCountBitForFound) {
              this.parserStep = STEP_RESET;
              if (this.decodeCountBit >= this.minCountBitForFound &&
                  (((this.decodeData >> 24n) ^ (this.decodeData >> 16n)) & 0xFFn) === 0xFFn &&
                  (((this.decodeData >> 8n) ^ this.decodeData) & 0xFFn) === 0xFFn) {
                this.dataCountBit = this.decodeCountBit;
                this.hit();
              }
              this.decodeData = 0n; this.decodeCountBit = 0;
              this.parserStep = STEP_RESET;
            } else { this.teLast = duration; this.parserStep = STEP_CHECK; }
          } else { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET; }
        } else { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET; }
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET; }
        } else { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET; }
        break;
    }
  }
}
