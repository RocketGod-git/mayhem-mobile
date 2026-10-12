/** Magellan alarm sensors (Mayhem fprotos/s-magellan.hpp; twin of ism/SMagellan.kt). */
import { FProto, Fam, S } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_FOUND_PREAMBULA = 2, STEP_SAVE = 3, STEP_CHECK = 4;

export class SMagellan extends FProto {
  constructor() { super(Fam.REMOTE, S.MAGELLAN); this.teShort = 200; this.teLong = 400; this.teDelta = 100; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBULA; this.teLast = duration; this.headerCount = 0; }
        break;
      case STEP_CHECK_PREAMBULA:
        if (level) this.teLast = duration;
        else {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) this.headerCount++;
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2 && this.headerCount > 10) this.parserStep = STEP_FOUND_PREAMBULA;
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_FOUND_PREAMBULA:
        if (level) this.teLast = duration;
        else {
          if (this.dd(this.teLast, this.teShort * 6) < this.teDelta * 3 && this.dd(duration, this.teLong) < this.teDelta * 2) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (duration >= this.teLong * 3) {
            // Found stop bit
            if (this.decodeCountBit === this.minCountBitForFound && this.checkCrc()) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private checkCrc(): boolean {
    const data = [Number((this.decodeData >> 24n) & 0xffn), Number((this.decodeData >> 16n) & 0xffn), Number((this.decodeData >> 8n) & 0xffn)];
    return Number(this.decodeData & 0xffn) === this.crc8(data, data.length);
  }

  private crc8(data: number[], len: number): number {
    let crc = 0;
    for (let i = 0; i < len; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
  }
}
