/** Vauno EN8822C weather sensor (Mayhem fprotos/w-vauno_en8822.hpp; twin of ism/WVaunoEn8822.kt). */
import { FProto, Fam, W, FG } from './base.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;

export class WVaunoEn8822 extends FProto {
  constructor() { super(Fam.WEATHER, W.VAUNO_EN8822); this.teShort = 500; this.teLong = 1940; this.teDelta = 150; this.minCountBitForFound = 42; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teLong * 4) < this.teDelta) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta) {
            if (this.dd(duration, this.teLong * 2) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
            else if (this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
            else if (this.dd(duration, this.teLong * 4) < this.teDelta) {
              this.parserStep = STEP_RESET;
              if (this.decodeCountBit === this.minCountBitForFound && this.check()) this.hit();
              else if (this.decodeCountBit === 1) this.parserStep = STEP_SAVE;
              this.decodeData = 0n; this.decodeCountBit = 0;
            } else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private check(): boolean {
    if (this.decodeData === 0n) return false;
    // The sum of all nibbles should match the last 6 bits
    let sum = 0;
    for (let i = 6; i <= 38; i += 4) sum = (sum + FG.bits(this.decodeData, i, 0x0f)) & 0xff;
    return sum !== 0 && (sum & 0x3f) === FG.bits(this.decodeData, 0, 0x3f);
  }
}
