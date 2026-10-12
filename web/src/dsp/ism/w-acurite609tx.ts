/** Acurite 609TXC temperature/humidity sensor (Mayhem fprotos/w-acurite609tx.hpp; twin of ism/WAcurite609Tx.kt). */
import { FProto, Fam, W, FG } from './base.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;

export class WAcurite609Tx extends FProto {
  constructor() { super(Fam.WEATHER, W.ACURITE_609TX); this.teShort = 500; this.teLong = 1000; this.teDelta = 150; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 17) < this.teDelta * 8) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta) {
            if (this.dd(duration, this.teShort) < this.teDelta || duration > this.teLong * 3) {
              this.parserStep = STEP_RESET;
              if (this.decodeCountBit === this.minCountBitForFound && this.check()) this.hit();
              this.decodeData = 0n; this.decodeCountBit = 0;
            } else if (this.dd(duration, this.teLong) < this.teDelta * 2) { this.addBit(0); this.parserStep = STEP_SAVE; }
            else if (this.dd(duration, this.teLong * 2) < this.teDelta * 4) { this.addBit(1); this.parserStep = STEP_SAVE; }
            else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private check(): boolean {
    if (this.decodeData === 0n) return false;
    const d = this.decodeData;
    const crc = (FG.bits(d, 32, 0xff) + FG.bits(d, 24, 0xff) + FG.bits(d, 16, 0xff) + FG.bits(d, 8, 0xff)) & 0xff;
    return crc === FG.bits(d, 0, 0xff);
  }
}
