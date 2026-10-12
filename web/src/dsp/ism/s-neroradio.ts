/** Nero Radio remotes (Mayhem fprotos/s-neroradio.hpp; twin of ism/SNeroRadio.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class SNeroRadio extends FProto {
  constructor() { super(Fam.REMOTE, S.NERO_RADIO); this.teShort = 200; this.teLong = 400; this.teDelta = 80; this.minCountBitForFound = 56; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBULA; this.teLast = duration; this.headerCount = 0; }
        break;
      case STEP_CHECK_PREAMBULA:
        if (level) {
          if (this.dd(duration, this.teShort) < this.teDelta || this.dd(duration, this.teShort * 4) < this.teDelta) this.teLast = duration;
          else this.parserStep = STEP_RESET;
        } else if (this.dd(duration, this.teShort) < this.teDelta) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta) { this.headerCount++; break; } // Found header
          else if (this.dd(this.teLast, this.teShort * 4) < this.teDelta) {
            // Found start bit
            if (this.headerCount > 40) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
            else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (duration >= 1250) {
            // Found stop bit
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            else if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
            this.parserStep = STEP_RESET;
            if (this.decodeCountBit === this.minCountBitForFound || this.decodeCountBit === this.minCountBitForFound + 1) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.parserStep = STEP_RESET;
            break;
          } else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
