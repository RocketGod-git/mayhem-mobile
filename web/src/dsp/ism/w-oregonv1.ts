/** Oregon Scientific v1 weather sensors (Mayhem fprotos/w-oregonv1.hpp; twin of ism/WOregonV1.kt). */
import { FProto, Fam, W, FG, Manchester, MASK64 } from './base.js';

const STEP_RESET = 0, STEP_FOUND_PREAMBLE = 1, STEP_PARSE = 2;
const HEADER_OK = 0xFF;

export class WOregonV1 extends FProto {
  private firstBit = 0;
  private readonly manchester = new Manchester();

  constructor() { super(Fam.WEATHER, W.OREGON_V1); this.teShort = 1465; this.teLong = 2930; this.teDelta = 350; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    let event = Manchester.EVENT_RESET;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_FOUND_PREAMBLE; this.teLast = duration; this.headerCount = 0; }
        break;
      case STEP_FOUND_PREAMBLE:
        if (level) {
          // keep high levels, if they suit our durations
          if (this.dd(duration, this.teShort) < this.teDelta || this.dd(duration, this.teShort * 4) < this.teDelta) this.teLast = duration;
          else this.parserStep = STEP_RESET;
        } else if (this.dd(duration, this.teShort) < this.teDelta && this.dd(this.teLast, this.teShort) < this.teDelta) {
          // Found header
          this.headerCount++;
        } else if (this.dd(duration, this.teShort * 3) < this.teDelta && this.dd(this.teLast, this.teShort) < this.teDelta) {
          // check header
          if (this.headerCount > 7) this.headerCount = HEADER_OK;
        } else if (this.headerCount === HEADER_OK && this.dd(this.teLast, this.teShort * 4) < this.teDelta) {
          // found all the necessary patterns
          this.decodeData = 0n; this.decodeCountBit = 1;
          this.manchester.advance(Manchester.EVENT_RESET);
          this.parserStep = STEP_PARSE;
          this.firstBit = duration < this.teShort * 4 ? 1 : 0;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_PARSE:
        if (level) {
          if (this.dd(duration, this.teShort) < this.teDelta) event = Manchester.EVENT_SHORT_HIGH;
          else if (this.dd(duration, this.teLong) < this.teDelta) event = Manchester.EVENT_LONG_HIGH;
          else this.parserStep = STEP_RESET;
        } else {
          if (this.dd(duration, this.teShort) < this.teDelta) event = Manchester.EVENT_SHORT_LOW;
          else if (this.dd(duration, this.teLong) < this.teDelta) event = Manchester.EVENT_LONG_LOW;
          else if (duration >= this.teLong * 2) {
            if (this.decodeCountBit === this.minCountBitForFound) {
              if (this.firstBit) this.decodeData = ((~this.decodeData) & MASK64) | (1n << 31n);
              if (this.check()) this.hit();
            }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.manchester.advance(Manchester.EVENT_RESET);
          } else this.parserStep = STEP_RESET;
        }
        if (event !== Manchester.EVENT_RESET) {
          if (this.manchester.advance(event)) { this.decodeData = ((this.decodeData << 1n) | (this.manchester.data ? 0n : 1n)) & MASK64; this.decodeCountBit++; }
        }
        break;
    }
  }

  private check(): boolean {
    if (this.decodeData === 0n) return false;
    const data = FG.reverseKey(this.decodeData, 32);
    let crc = FG.bits(data, 0, 0xff) + FG.bits(data, 8, 0xff) + FG.bits(data, 16, 0xff);
    crc = (crc & 0xff) + ((crc >>> 8) & 0xff);
    return crc === FG.bits(data, 24, 0xFF);
  }
}
