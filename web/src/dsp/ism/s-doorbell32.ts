/**
 * Doorbell32 wireless doorbells, 32-bit OOK PWM 1:3 with a 14*Te guard; Te is measured from the signal (Flipper
 * Unleashed lib/subghz/protocols/doorbell32.c; twin of ism/SDoorbell32.kt). Receive only. A key is reported only
 * once two consecutive frames match.
 */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE_DURATION = 1, STEP_CHECK_DURATION = 2;
const GUARD_TIME = 14;

export class SDoorbell32 extends FProto {
  /** Measured Te in us (sum of all pulses / 129 once a frame is complete). */
  te = 0;
  private lastData = 0n;

  constructor() { super(Fam.REMOTE, S.DOORBELL32); this.teShort = 515; this.teLong = 1545; this.teDelta = 200; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * GUARD_TIME) < Math.trunc(this.teDelta * GUARD_TIME / 2)) {
          this.parserStep = STEP_SAVE_DURATION; this.decodeData = 0n; this.decodeCountBit = 0; this.te = 0;
        }
        break;
      case STEP_SAVE_DURATION:
        if (level) { this.teLast = duration; this.te += duration; this.parserStep = STEP_CHECK_DURATION; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (duration >= this.teLong * 2) {
            // Guard reached, the frame ends here
            if (this.decodeCountBit === this.minCountBitForFound && this.lastData === this.decodeData && this.lastData !== 0n) {
              this.te = Math.trunc(this.te / (this.decodeCountBit * 4 + 1));
              this.dataCountBit = this.decodeCountBit;
              this.hit();
            }
            this.lastData = this.decodeData;
            this.decodeData = 0n; this.decodeCountBit = 0; this.te = 0;
            this.parserStep = STEP_SAVE_DURATION;
            break;
          }
          this.te += duration;
          // Bit 0 is short mark + long space, bit 1 the other way round
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    return { name: remoteName(this.sensorType), serial: 0n, btn: null, cnt: null, extra: [`Te: ${this.te} us`] };
  }
}
