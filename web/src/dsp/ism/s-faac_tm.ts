/** FAAC TM 12-bit DIP-switch OOK remotes (Flipper Unleashed lib/subghz/protocols/faac_tm.c; twin of ism/SFaacTm.kt). Receive only. */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_START_BIT = 1, STEP_SAVE = 2, STEP_CHECK = 3;
const HEADER_TE = 35;

export class SFaacTm extends FProto {
  /** Running sum of the frame's durations, then the measured Te (Flipper's instance->te). */
  private te = 0;
  private gTe = 0;
  private gData = 0n;
  constructor() { super(Fam.REMOTE, S.FAAC_TM); this.teShort = 400; this.teLong = 800; this.teDelta = 120; this.minCountBitForFound = 12; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * HEADER_TE) < this.teDelta * HEADER_TE) this.parserStep = STEP_START_BIT;
        break;
      case STEP_START_BIT:
        if (!level) break;
        if (this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; this.te = duration; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE:
        if (!level) {
          if (duration >= this.teShort * 4) {
            this.parserStep = STEP_START_BIT;
            if (this.decodeCountBit === this.minCountBitForFound) {
              // start bit plus 3 Te per bit
              this.te = Math.floor(this.te / (this.decodeCountBit * 3 + 1));
              this.gTe = this.te; this.gData = this.decodeData; this.dataCountBit = this.decodeCountBit;
              this.hit();
            }
            break;
          }
          this.teLast = duration; this.te += duration; this.parserStep = STEP_CHECK;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (level) {
          this.te += duration;
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const d = Number(this.gData & 0xFFFn);
    let dip = '';
    for (let b = 11; b >= 0; b--) dip += (d >> b) & 1 ? '1' : '0';
    return { name: remoteName(this.sensorType), serial: 0n, btn: null, cnt: null, extra: ['Te: ' + this.gTe + 'us', 'DIP: ' + dip] };
  }
}
