/** Wendox W6726 weather sensor (Mayhem fprotos/w-wendox-w6726.hpp; twin of ism/WWendoxW6726.kt). */
import { FProto, Fam, W, FG } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class WWendoxW6726 extends FProto {
  constructor() { super(Fam.WEATHER, W.WENDOX_W6726); this.teShort = 1955; this.teLong = 5865; this.teDelta = 300; this.minCountBitForFound = 29; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 0; }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) this.teLast = duration;
        else {
          if (this.dd(this.teLast, this.teShort) < this.teDelta * 1 && this.dd(duration, this.teLong) < this.teDelta * 2) this.headerCount++;
          else if (this.headerCount > 4 && this.headerCount < 12) {
            if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) { this.decodeData = 0n; this.decodeCountBit = 0; this.addBit(1); this.parserStep = STEP_SAVE; }
            else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (duration > this.teShort + this.teLong) {
            if (this.dd(this.teLast, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
            else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2) { this.addBit(1); this.parserStep = STEP_SAVE; }
            else this.parserStep = STEP_RESET;
            if (this.decodeCountBit === this.minCountBitForFound && this.check()) this.hit();
            this.parserStep = STEP_RESET;
          } else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 3) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private check(): boolean {
    if (this.decodeData === 0n) return false;
    const d = this.decodeData;
    const msg = [FG.bits(d, 28, 0xff), FG.bits(d, 20, 0xff), FG.bits(d, 12, 0xff), FG.bits(d, 4, 0xff)];
    const crc = FG.crc4(msg, 4, 0x9, 0xD);
    return crc === FG.bits(d, 0, 0x0F);
  }
}
