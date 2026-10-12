/** Ford key fob v0, Manchester coded (Mayhem fprotos/c-ford_v0.hpp; twin of ism/CFordV0.kt). */
import { FProto, Fam, C, Manchester, MASK64 } from './base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_PREAMBLE_CHECK = 2, STEP_GAP = 3, STEP_DATA = 4, GAP_THRESHOLD = 3500;

export class CFordV0 extends FProto {
  private readonly manchester = new Manchester();
  private dataLow = 0n;
  private dataHigh = 0n;
  private bitCount = 0;
  private key1 = 0n;
  private key2 = 0;

  constructor() { super(Fam.CAR, C.FORD_V0); this.teShort = 250; this.teLong = 500; this.teDelta = 100; this.minCountBitForFound = 64; }

  private fordV0AddBit(bit: boolean): void {
    const low = Number(this.dataLow & 0xFFFFFFFFn); // uint32 view
    this.dataLow = ((this.dataLow << 1n) | (bit ? 1n : 0n)) & MASK64;
    this.dataHigh = ((this.dataHigh << 1n) | BigInt((low >>> 31) & 1)) & MASK64;
    this.bitCount++;
  }

  private fordV0ProcessData(): boolean {
    if (this.bitCount === 64) {
      const combined = ((this.dataHigh << 32n) | this.dataLow) & MASK64;
      this.key1 = ~combined & MASK64;
      this.dataLow = 0n; this.dataHigh = 0n;
      return false;
    }
    if (this.bitCount === 80) {
      const key2Raw = Number(this.dataLow & 0xFFFFn);
      this.key2 = ~key2Raw & 0xFFFF;
      this.decodeData = this.key1;
      this.decodeData2 = BigInt(this.key2);
      return true;
    }
    return false;
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) {
          this.dataLow = 0n; this.dataHigh = 0n; this.parserStep = STEP_PREAMBLE; this.teLast = duration; this.headerCount = 0; this.bitCount = 0;
          this.manchester.advance(Manchester.EVENT_RESET);
        }
        break;
      case STEP_PREAMBLE:
        if (!level) {
          if (this.dd(duration, this.teLong) < this.teDelta) { this.teLast = duration; this.parserStep = STEP_PREAMBLE_CHECK; } else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_PREAMBLE_CHECK:
        if (level) {
          if (this.dd(duration, this.teLong) < this.teDelta) { this.headerCount++; this.teLast = duration; this.parserStep = STEP_PREAMBLE; }
          else if (this.dd(duration, this.teShort) < this.teDelta) this.parserStep = STEP_GAP;
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_GAP:
        if (!level && this.dd(duration, GAP_THRESHOLD) < 250) { this.dataLow = 1n; this.dataHigh = 0n; this.bitCount = 1; this.parserStep = STEP_DATA; }
        else if (!level && duration > GAP_THRESHOLD + 250) this.parserStep = STEP_RESET;
        break;
      case STEP_DATA: {
        let event: number;
        if (this.dd(duration, this.teShort) < this.teDelta) event = level ? Manchester.EVENT_SHORT_LOW : Manchester.EVENT_SHORT_HIGH;
        else if (this.dd(duration, this.teLong) < this.teDelta) event = level ? Manchester.EVENT_LONG_LOW : Manchester.EVENT_LONG_HIGH;
        else { this.parserStep = STEP_RESET; break; }

        if (this.manchester.advance(event)) {
          this.fordV0AddBit(this.manchester.data);
          if (this.fordV0ProcessData()) {
            this.dataCountBit = 64;
            this.hit();
            this.dataLow = 0n; this.dataHigh = 0n; this.bitCount = 0; this.parserStep = STEP_RESET;
          }
        }
        this.teLast = duration;
        break;
      }
    }
  }
}
