/** Fiat key fob v0, Manchester coded (Mayhem fprotos/c-fiat_v0.hpp; twin of ism/CFiatV0.kt). */
import { FProto, Fam, C, Manchester } from './base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_DATA = 2, GAP_THRESHOLD = 800;

export class CFiatV0 extends FProto {
  private readonly manchester = new Manchester();
  private decoderState = 0;
  private bitCount = 0;
  private endbyte = 0;
  private preambleCount = 0;
  private dataLow = 0; // uint32
  private dataHigh = 0; // uint32
  private hop = 0;
  private fix = 0;

  constructor() { super(Fam.CAR, C.FIAT_V0); this.teShort = 200; this.teLong = 400; this.teDelta = 100; this.minCountBitForFound = 64; }

  feed(level: boolean, duration: number): void {
    let diff: number;
    switch (this.decoderState) {
      case STEP_RESET:
        if (!level) return;
        diff = duration < this.teShort ? this.teShort - duration : duration - this.teShort;
        if (diff < this.teDelta) {
          this.dataLow = 0; this.dataHigh = 0; this.decoderState = STEP_PREAMBLE; this.teLast = duration; this.preambleCount = 0; this.bitCount = 0;
          this.manchester.advance(Manchester.EVENT_RESET);
        }
        break;
      case STEP_PREAMBLE:
        if (level) return;
        if (duration < this.teShort) {
          diff = this.teShort - duration;
          if (diff < this.teDelta) {
            this.preambleCount++; this.teLast = duration;
            if (this.preambleCount >= 0x96) {
              diff = duration < GAP_THRESHOLD ? GAP_THRESHOLD - duration : duration - GAP_THRESHOLD;
              if (diff < this.teDelta) { this.decoderState = STEP_DATA; this.preambleCount = 0; this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.teLast = duration; return; }
            }
          } else {
            this.decoderState = STEP_RESET;
            if (this.preambleCount >= 0x96) {
              diff = duration < GAP_THRESHOLD ? GAP_THRESHOLD - duration : duration - GAP_THRESHOLD;
              if (diff < this.teDelta) { this.decoderState = STEP_DATA; this.preambleCount = 0; this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.teLast = duration; return; }
            }
          }
        } else {
          diff = duration - this.teShort;
          if (diff < this.teDelta) { this.preambleCount++; this.teLast = duration; } else this.decoderState = STEP_RESET;
          if (this.preambleCount >= 0x96) {
            // upstream uses unsigned arithmetic here: duration == 799 wraps to a huge diff and never matches
            diff = duration >= 799 ? duration - GAP_THRESHOLD : GAP_THRESHOLD - duration;
            if (diff >= 0 && diff < this.teDelta) { this.decoderState = STEP_DATA; this.preambleCount = 0; this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.teLast = duration; return; }
          }
        }
        break;
      case STEP_DATA: {
        let event = Manchester.EVENT_RESET;
        if (duration < this.teShort) {
          diff = this.teShort - duration;
          if (diff < this.teDelta) event = level ? Manchester.EVENT_SHORT_LOW : Manchester.EVENT_SHORT_HIGH;
        } else {
          diff = duration - this.teShort;
          if (diff < this.teDelta) event = level ? Manchester.EVENT_SHORT_LOW : Manchester.EVENT_SHORT_HIGH;
          else {
            diff = duration < this.teLong ? this.teLong - duration : duration - this.teLong;
            if (diff < this.teDelta) event = level ? Manchester.EVENT_LONG_LOW : Manchester.EVENT_LONG_HIGH;
          }
        }

        if (event !== Manchester.EVENT_RESET) {
          if (this.manchester.advance(event)) {
            const newBit = this.manchester.data ? 1 : 0;
            const carry = (this.dataLow >>> 31) & 1;
            this.dataLow = ((this.dataLow << 1) | newBit) >>> 0;
            this.dataHigh = ((this.dataHigh << 1) | carry) >>> 0;
            this.bitCount++;
            if (this.bitCount === 0x40) { this.fix = this.dataLow; this.hop = this.dataHigh; this.dataLow = 0; this.dataHigh = 0; }
            if (this.bitCount > 0x46) {
              this.endbyte = this.dataLow & 0xff;
              this.decodeData = (BigInt(this.hop) << 32n) | BigInt(this.fix);
              this.decodeData2 = BigInt(this.endbyte);
              this.dataCountBit = 64;
              this.hit();
              this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.decoderState = STEP_RESET;
            }
          }
        }
        this.teLast = duration;
        break;
      }
    }
  }
}
