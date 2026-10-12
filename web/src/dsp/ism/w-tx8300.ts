/** TX-8300 weather sensor (Mayhem fprotos/w-tx8300.hpp; twin of ism/WTx8300.kt). */
import { FProto, Fam, W, FG } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_SAVE = 2, STEP_CHECK = 3;
const PACKAGE_SIZE = 32;

export class WTx8300 extends FProto {
  private package1 = 0n;
  private package2 = 0n;

  constructor() { super(Fam.WEATHER, W.TX_8300); this.teShort = 1940; this.teLong = 3880; this.teDelta = 250; this.minCountBitForFound = 72; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort * 2) < this.teDelta) this.parserStep = STEP_CHECK_PREAMBLE;
        break;
      case STEP_CHECK_PREAMBLE:
        if (!level && (this.dd(duration, this.teShort * 2) < this.teDelta || this.dd(duration, this.teShort * 3) < this.teDelta)) {
          this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 1; this.package1 = 0n; this.package2 = 0n;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (duration >= this.teShort * 5) {
            // Found syncPostfix
            if (this.decodeCountBit === this.minCountBitForFound && this.checkCrc()) { this.decodeData = this.package1; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 1; this.parserStep = STEP_RESET;
            break;
          } else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;

          if (this.decodeCountBit === PACKAGE_SIZE) { this.package1 = this.decodeData & 0xFFFFFFFFn; this.decodeData = 0n; }
          else if (this.decodeCountBit === PACKAGE_SIZE * 2) { this.package2 = this.decodeData & 0xFFFFFFFFn; this.decodeData = 0n; }
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private checkCrc(): boolean {
    if (this.package2 === 0n) return false;
    if (this.package1 !== ((~this.package2) & 0xFFFFFFFFn)) return false;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 32; i += 4) {
      x += FG.bits(this.package1, i, 0x0F);
      y += FG.bits(this.package1, i, 0x05);
    }
    const crc = (((~x & 0xF) << 4) | (~y & 0xF)) & 0xff;
    return crc === FG.bits(this.decodeData, 0, 0xFF);
  }
}
