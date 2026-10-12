/** Bresser 3CH weather sensor, V0 and V1 framing (Mayhem fprotos/w-bresser_3ch.hpp; twin of ism/WBresser3Ch.kt). */
import { FProto, Fam, W, FG } from './base.js';

const V0_DATA = 36, V0_DATA_AND_TAIL = 52, V1_DATA = 40;
const STEP_RESET = 0, STEP_V0_SAVE = 1, STEP_V0_CHECK = 2, STEP_V0_TAIL_CHECK = 3, STEP_V1_PREAMBLE_DN = 4, STEP_V1_PREAMBLE_UP = 5, STEP_V1_SAVE = 6, STEP_V1_CHECK = 7;

export class WBresser3Ch extends FProto {
  private readonly teShortV1 = 250;
  private readonly teLongV1 = 500;
  constructor() { super(Fam.WEATHER, W.BRESSER_3CH); this.teShort = 475; this.teLong = 3900; this.teDelta = 150; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort * 3) < this.teDelta) { this.teLast = duration; this.parserStep = STEP_V1_PREAMBLE_DN; this.decodeData = 0n; this.decodeCountBit = 0; }
        else if (!level && duration >= this.teLong) { this.parserStep = STEP_V0_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; }
        break;
      case STEP_V0_SAVE:
        if (level) {
          this.teLast = duration;
          this.parserStep = this.decodeCountBit < V0_DATA ? STEP_V0_CHECK : STEP_V0_TAIL_CHECK;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_V0_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta) {
            if (this.dd(duration, this.teShort * 2) < this.teDelta) { this.addBit(0); this.parserStep = STEP_V0_SAVE; }
            else if (this.dd(duration, this.teShort * 4) < this.teDelta) { this.addBit(1); this.parserStep = STEP_V0_SAVE; }
            else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_V0_TAIL_CHECK:
        if (!level) {
          if (duration >= this.teLong) {
            if (this.decodeCountBit === V0_DATA_AND_TAIL && this.checkV0()) {
              this.decodeCountBit = V0_DATA;
              this.sensorType = W.BRESSER_3CH;
              this.hit();
            }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.parserStep = STEP_RESET;
          } else if (this.decodeCountBit < V0_DATA_AND_TAIL && this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 2) < this.teDelta) {
            this.decodeCountBit++;
            this.parserStep = STEP_V0_SAVE;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_V1_PREAMBLE_DN:
        if (!level && this.dd(duration, this.teShortV1 * 3) < this.teDelta) {
          // End of sync after 4*750 (12*250) high values, start reading the message
          this.parserStep = this.dd(this.teLast, this.teShortV1 * 12) < this.teDelta * 2 ? STEP_V1_SAVE : STEP_V1_PREAMBLE_UP;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_V1_PREAMBLE_UP:
        if (level && this.dd(duration, this.teShortV1 * 3) < this.teDelta) { this.teLast = this.teLast + duration; this.parserStep = STEP_V1_PREAMBLE_DN; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_V1_SAVE:
        if (this.decodeCountBit === V1_DATA) {
          if (this.checkV1()) { this.sensorType = W.BRESSER_3CH_V1; this.hit(); }
          this.decodeData = 0n; this.decodeCountBit = 0;
          this.parserStep = STEP_RESET;
        } else if (level) { this.teLast = duration; this.parserStep = STEP_V1_CHECK; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_V1_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShortV1) < this.teDelta && this.dd(duration, this.teLongV1) < this.teDelta) { this.addBit(0); this.parserStep = STEP_V1_SAVE; }
          else if (this.dd(this.teLast, this.teLongV1) < this.teDelta && this.dd(duration, this.teShortV1) < this.teDelta) { this.addBit(1); this.parserStep = STEP_V1_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  private checkV0(): boolean {
    const d = this.decodeData;
    if (d === 0n) return false;
    // No CRC, so better sanity checks here
    if (FG.bits(d, 8, 0x0f) !== 0x0f) return false;   // separator not 0xf
    if (FG.bits(d, 28, 0xff) === 0xff) return false;  // ID only ones?
    if (FG.bits(d, 28, 0xff) === 0x00) return false;  // ID only zeroes?
    if (FG.bits(d, 25, 0x0f) === 0x0f) return false;  // flags only ones?
    if (FG.bits(d, 25, 0x0f) === 0x00) return false;  // flags only zeroes?
    if (FG.bits(d, 12, 0x0fff) === 0x0fff) return false;  // temperature maxed out?
    if (FG.bits(d, 0, 0xff) < 20) return false;  // humidity percentage less than 20?
    if (FG.bits(d, 0, 0xff) > 95) return false;  // humidity percentage more than 95?
    return true;
  }

  private checkV1(): boolean {
    const d = this.decodeData;
    if (d === 0n) return false;
    const sum = (FG.bits(d, 32, 0xff) + FG.bits(d, 24, 0xff) + FG.bits(d, 16, 0xff) + FG.bits(d, 8, 0xff)) & 0xff;
    return FG.bits(d, 0, 0xff) === sum;
  }
}
