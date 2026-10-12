/** Subaru key fob (Mayhem fprotos/c-subaru.hpp; twin of ism/CSubaru.kt). */
import { FProto, Fam, C } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_FOUND_GAP = 2, STEP_FOUND_SYNC = 3, STEP_SAVE_DURATION = 4, STEP_CHECK_DURATION = 5;

export class CSubaru extends FProto {
  private readonly data: number[] = new Array<number>(8).fill(0);
  private bitCount = 0;

  constructor() { super(Fam.CAR, C.SUBARU); this.teShort = 800; this.teLong = 1600; this.teDelta = 260; this.minCountBitForFound = 64; }

  private subaruAddBit(bit: boolean): void {
    if (this.bitCount < 64) {
      const byteIdx = Math.floor(this.bitCount / 8);
      const bitIdx = 7 - (this.bitCount % 8);
      if (bit) this.data[byteIdx] |= 1 << bitIdx; else this.data[byteIdx] &= ~(1 << bitIdx);
      this.bitCount++;
    }
  }

  private subaruProcessData(): boolean {
    if (this.bitCount < 64) return false;
    const b = this.data;
    const key = (BigInt(b[0]) << 56n) | (BigInt(b[1]) << 48n) | (BigInt(b[2]) << 40n) | (BigInt(b[3]) << 32n) |
      (BigInt(b[4]) << 24n) | (BigInt(b[5]) << 16n) | (BigInt(b[6]) << 8n) | BigInt(b[7]);
    this.decodeData = key;
    this.dataCountBit = this.bitCount;
    this.hit();
    return true;
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teLong) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 1; }
        break;
      case STEP_CHECK_PREAMBLE:
        if (!level) {
          if (this.dd(duration, this.teLong) < this.teDelta) this.headerCount++;
          else if (duration > 2000 && duration < 3500) { if (this.headerCount > 20) this.parserStep = STEP_FOUND_GAP; else this.parserStep = STEP_RESET; }
          else this.parserStep = STEP_RESET;
        } else {
          if (this.dd(duration, this.teLong) < this.teDelta) { this.teLast = duration; this.headerCount++; } else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_FOUND_GAP:
        if (level && duration > 2000 && duration < 3500) this.parserStep = STEP_FOUND_SYNC; else this.parserStep = STEP_RESET;
        break;
      case STEP_FOUND_SYNC:
        if (!level && this.dd(duration, this.teLong) < this.teDelta) { this.parserStep = STEP_SAVE_DURATION; this.bitCount = 0; this.data.fill(0); }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION:
        if (level) {
          // HIGH pulse duration encodes the bit: short HIGH (~800µs) = 1, long HIGH (~1600µs) = 0
          if (this.dd(duration, this.teShort) < this.teDelta) { this.subaruAddBit(true); this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
          else if (this.dd(duration, this.teLong) < this.teDelta) { this.subaruAddBit(false); this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
          else if (duration > 3000) {
            // End of transmission
            if (this.bitCount >= 64) this.subaruProcessData();
            this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          // LOW pulse - just validates timing, doesn't encode bit
          if (this.dd(duration, this.teShort) < this.teDelta || this.dd(duration, this.teLong) < this.teDelta) this.parserStep = STEP_SAVE_DURATION;
          else if (duration > 3000) {
            // Gap - end of packet
            if (this.bitCount >= 64) this.subaruProcessData();
            this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }
}
