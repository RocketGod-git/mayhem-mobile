/** LaCrosse TX141TH-Bv2 weather sensor (Mayhem fprotos/w-lacrosse-tx141thbv2.hpp; twin of ism/WLacrosseTx141thbv2.kt). */
import { FProto, Fam, W, FG } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_SAVE = 2, STEP_CHECK = 3;
const BIT_COUNT = 41;

export class WLacrosseTx141thbv2 extends FProto {
  constructor() { super(Fam.WEATHER, W.LACROSSE_TX141THBV2); this.teShort = 208; this.teLong = 417; this.teDelta = 120; this.minCountBitForFound = 40; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort * 4) < this.teDelta * 2) { this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 0; }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) this.teLast = duration;
        else {
          if (this.dd(this.teLast, this.teShort * 4) < this.teDelta * 2 && this.dd(duration, this.teShort * 4) < this.teDelta * 2) this.headerCount++; // Found preambule
          else if (this.headerCount === 4) {
            if (this.tryAddBit(this.teLast, duration)) { this.decodeData = this.decodeData & 1n; this.decodeCountBit = 1; this.parserStep = STEP_SAVE; }
            else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort * 3) < this.teDelta * 2 && this.dd(duration, this.teShort * 4) < this.teDelta * 2) {
            if (this.decodeCountBit === this.minCountBitForFound || this.decodeCountBit === BIT_COUNT) {
              if (this.checkCrc()) {
                if (this.decodeCountBit === BIT_COUNT) this.decodeData >>= 1n;
                this.hit();
              }
              this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 1; this.parserStep = STEP_CHECK_PREAMBLE;
              break;
            }
          } else if (this.tryAddBit(this.teLast, duration)) this.parserStep = STEP_SAVE;
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private checkCrc(): boolean {
    if (this.decodeData === 0n) return false;
    let data = this.decodeData;
    if (this.decodeCountBit === BIT_COUNT) data >>= 1n;
    const msg = [FG.bits(data, 32, 0xff), FG.bits(data, 24, 0xff), FG.bits(data, 16, 0xff), FG.bits(data, 8, 0xff)];
    const crc = FG.lfsrDigest8Reflect(msg, 4, 0x31, 0xF4);
    return crc === FG.bits(data, 0, 0xFF);
  }

  private tryAddBit(last: number, current: number): boolean {
    let ret = false;
    if (this.dd(last + current, this.teShort + this.teLong) < this.teDelta * 2) {
      if (last > current) this.addBit(1); else this.addBit(0);
      ret = true;
    }
    return ret;
  }
}
