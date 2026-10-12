/** Kia key fob v1, Manchester coded (Mayhem fprotos/c-kia_v1.hpp; twin of ism/CKiaV1.kt). */
import { FProto, Fam, C, Manchester } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_DECODE_DATA = 2;

export class CKiaV1 extends FProto {
  private readonly manchester = new Manchester();

  constructor() { super(Fam.CAR, C.KIA_V1); this.teShort = 800; this.teLong = 1600; this.teDelta = 200; this.minCountBitForFound = 57; }

  feed(level: boolean, duration: number): void {
    let event = Manchester.EVENT_RESET;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teLong) < this.teDelta) {
          this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 0; this.decodeData = 0n; this.decodeCountBit = 0;
          this.manchester.advance(Manchester.EVENT_RESET);
        }
        break;
      case STEP_CHECK_PREAMBLE:
        if (!level) {
          // header_count is a uint8_t upstream
          if (this.dd(duration, this.teLong) < this.teDelta && this.dd(this.teLast, this.teLong) < this.teDelta) { this.headerCount = (this.headerCount + 1) & 0xff; this.teLast = duration; }
          else this.parserStep = STEP_RESET;
        }
        if (this.headerCount > 70) {
          if (!level && this.dd(duration, this.teShort) < this.teDelta && this.dd(this.teLast, this.teLong) < this.teDelta) { this.decodeCountBit = 1; this.addBit(1); this.headerCount = 0; this.parserStep = STEP_DECODE_DATA; }
        }
        break;
      case STEP_DECODE_DATA:
        if (this.dd(duration, this.teShort) < this.teDelta) event = level ? Manchester.EVENT_SHORT_LOW : Manchester.EVENT_SHORT_HIGH;
        else if (this.dd(duration, this.teLong) < this.teDelta) event = level ? Manchester.EVENT_LONG_LOW : Manchester.EVENT_LONG_HIGH;

        if (event !== Manchester.EVENT_RESET) {
          if (this.manchester.advance(event)) this.addBit(this.manchester.data ? 1 : 0);
        }

        if (this.decodeCountBit === this.minCountBitForFound) {
          this.dataCountBit = this.decodeCountBit;
          this.hit();
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
        }
        break;
    }
  }
}
