/** EMOS E601x weather station, 120-bit frame spread over decodeData + upperDecodeData (Mayhem fprotos/w-emose601x.hpp; twin of ism/WEmosE601x.kt). */
import { FProto, Fam, W, FG, MASK64 } from './base.js';

const MAGIC_HEADER = 0xaaa583n;
const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_SAVE = 2, STEP_CHECK = 3;

export class WEmosE601x extends FProto {
  private upperDecodeData = 0n;
  constructor() { super(Fam.WEATHER, W.EMOS_E601X); this.teShort = 260; this.teLong = 800; this.teDelta = 100; this.minCountBitForFound = 24; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort * 7) < this.teDelta * 2) { this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) this.teLast = duration;
        else {
          if (this.dd(this.teLast, this.teShort * 7) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addTo128Bit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addTo128Bit(1); this.parserStep = STEP_SAVE; }
          else { this.parserStep = STEP_RESET; break; }

          /* Bail out if the header doesn't match */
          if (this.decodeCountBit === this.minCountBitForFound) {
            if (this.decodeData !== MAGIC_HEADER) { this.parserStep = STEP_RESET; break; }
          }

          if (this.decodeCountBit === 120) {
            if (this.check()) this.hit();
            break;
          }
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private addTo128Bit(bit: number): void {
    if (++this.decodeCountBit > 64) this.upperDecodeData = ((this.upperDecodeData << 1n) | (this.decodeData >> 63n)) & MASK64;
    this.decodeData = ((this.decodeData << 1n) | BigInt(bit)) & MASK64;
  }

  private check(): boolean {
    const u = this.upperDecodeData, d = this.decodeData;
    const msg = [
      FG.bits(u, 48, 0xff), FG.bits(u, 40, 0xff), FG.bits(u, 32, 0xff), FG.bits(u, 24, 0xff), FG.bits(u, 16, 0xff), FG.bits(u, 8, 0xff), FG.bits(u, 0, 0xff),
      FG.bits(d, 56, 0xff), FG.bits(d, 48, 0xff), FG.bits(d, 40, 0xff), FG.bits(d, 32, 0xff), FG.bits(d, 24, 0xff), FG.bits(d, 16, 0xff)];
    const sum = FG.addBytes(msg, 13);
    return sum === FG.bits(d, 8, 0xff);
  }
}
