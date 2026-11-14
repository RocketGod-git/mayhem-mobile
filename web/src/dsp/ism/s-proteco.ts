/**
 * Proteco MOVER gate remotes (Italy), 433.92 MHz AM, 24-bit fixed code (Flipper Unleashed
 * lib/subghz/protocols/proteco.c; twin of ism/SProteco.kt). CAME line coding at Te ~440 us: guard LOW ~20.5 Te,
 * start HIGH Te, then bit 1 = LOW 2Te + HIGH Te, bit 0 = LOW Te + HIGH 2Te, MSB first. The guard must be 18.5..22.5 of
 * the frame's own mean Te. Low 2 bits are the button. Receive only.
 */
import { FProto, Fam, S } from './base.js';
import { type RemoteInfo, remoteName } from './remote-fields.js';

const STEP_RESET = 0, STEP_FOUND_START_BIT = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
const GUARD_TE_X2_MIN = 37, GUARD_TE_X2_MAX = 45;
const BTN = [0x2, 0x3, 0x1, 0x4];

export class SProteco extends FProto {
  private rx = 0n;
  /** Sum of the frame's pulses (start bit included). */
  private te = 0;
  /** The LOW that opened the frame. */
  private guard = 0;
  constructor() { super(Fam.REMOTE, S.PROTECO); this.teShort = 440; this.teLong = 880; this.teDelta = 150; this.minCountBitForFound = 24; }

  private guardOk(): boolean {
    // start bit plus 3 Te per bit
    const te = Math.floor(this.te / (this.decodeCountBit * 3 + 1));
    return this.guard >= Math.floor(te * GUARD_TE_X2_MIN / 2) && this.guard <= Math.floor(te * GUARD_TE_X2_MAX / 2);
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && duration >= this.teShort * 4) { this.guard = duration; this.parserStep = STEP_FOUND_START_BIT; }
        break;
      case STEP_FOUND_START_BIT:
        if (level && this.dd(duration, this.teShort) < this.teDelta) {
          this.decodeData = 0n; this.decodeCountBit = 0; this.te = duration; this.parserStep = STEP_SAVE_DURATION;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION:
        if (level) { this.parserStep = STEP_RESET; break; }
        if (duration >= this.teShort * 4) {
          // This gap ends the frame and is the next frame's guard.
          if (this.decodeCountBit === this.minCountBitForFound && this.guardOk()) {
            this.dataCountBit = this.decodeCountBit; this.rx = this.decodeData;
            this.hit();
          }
          this.guard = duration;
          this.parserStep = STEP_FOUND_START_BIT;
          break;
        }
        this.teLast = duration; this.te += duration; this.parserStep = STEP_CHECK_DURATION;
        break;
      case STEP_CHECK_DURATION:
        if (level && this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
          this.addBit(0); this.te += duration; this.parserStep = STEP_SAVE_DURATION;
        } else if (level && this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
          this.addBit(1); this.te += duration; this.parserStep = STEP_SAVE_DURATION;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    return { name: remoteName(this.sensorType), serial: (this.rx >> 2n) & 0x3FFFFFn, btn: BTN[Number(this.rx & 0x3n)], cnt: null, extra: [] };
  }
}
