/**
 * Ansonic gate remotes, 12-bit FM PWM, 10 DIP switches + 2-bit key (Flipper Unleashed lib/subghz/protocols/ansonic.c;
 * twin of ism/SAnsonic.kt). Receive only.
 */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_FOUND_START_BIT = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
/** A bit (mark + space) must add up to te_short + te_long within this many us. */
const TE_SUM_DELTA = 110;
/** DIP switches 1..8, 10, 9 as Flipper prints them. */
const DIP_MASKS = [0x0800, 0x0400, 0x0200, 0x0100, 0x0080, 0x0040, 0x0020, 0x0010, 0x0001, 0x0008];

export class SAnsonic extends FProto {
  constructor() { super(Fam.REMOTE, S.ANSONIC); this.teShort = 555; this.teLong = 1111; this.teDelta = 120; this.minCountBitForFound = 12; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 35) < this.teDelta * 35) this.parserStep = STEP_FOUND_START_BIT; // header
        break;
      case STEP_FOUND_START_BIT:
        if (!level) break;
        if (this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_SAVE_DURATION; this.decodeData = 0n; this.decodeCountBit = 0; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION:
        if (!level) {
          if (duration >= this.teShort * 4) {
            this.parserStep = STEP_FOUND_START_BIT;
            if (this.decodeCountBit >= this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            break;
          }
          this.teLast = duration; this.parserStep = STEP_CHECK_DURATION;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (level) {
          // Reject anything whose bit rate is not Ansonic's
          if (this.dd(this.teLast + duration, this.teShort + this.teLong) >= TE_SUM_DELTA) { this.parserStep = STEP_RESET; break; }
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit < this.minCountBitForFound) return null;
    const dip = Number(this.decodeData & 0xFFFn);
    const btn = Number((this.decodeData >> 1n) & 3n);
    return { name: remoteName(this.sensorType), serial: 0n, btn, cnt: null, extra: ['DIP: ' + DIP_MASKS.map((m) => (dip & m ? '1' : '0')).join('')] };
  }
}
