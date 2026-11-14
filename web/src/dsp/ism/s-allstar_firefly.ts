/**
 * Allstar Firefly 318ALD31K gate remotes, 18-bit OOK PWM, 9-position trinary DIP code (Flipper Unleashed
 * lib/subghz/protocols/allstar_firefly.c; twin of ism/SAllstarFirefly.kt). Receive only.
 */
import { FProto, Fam, S, FG } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE_DURATION = 1, STEP_CHECK_DURATION = 2;
const DIP_P = 0b11, DIP_O = 0b10, DIP_N = 0b00;

export class SAllstarFirefly extends FProto {
  constructor() { super(Fam.REMOTE, S.ALLSTAR_FIREFLY); this.teShort = 600; this.teLong = 4000; this.teDelta = 300; this.minCountBitForFound = 18; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 50) < this.teDelta * 5) {
          // Found the ~30 ms gap
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE_DURATION;
        }
        break;
      case STEP_SAVE_DURATION:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
            this.addBit(1); this.parserStep = STEP_SAVE_DURATION;
          } else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
            this.addBit(0); this.parserStep = STEP_SAVE_DURATION;
          } else if (this.dd(duration, this.teShort * 50) < this.teDelta * 5) {
            // Next gap: the last bit is read from its mark alone
            if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const d = this.decodeData;
    const yek = FG.reverseKey(d, this.dataCountBit) & 0xFFFFFn;
    const dip = (check: number): string => { let s = ''; for (let sh = 16; sh >= 0; sh -= 2) s += FG.bits(d, sh, 3) === check ? '*' : '_'; return s; };
    return {
      name: remoteName(this.sensorType), serial: 0n, btn: null, cnt: null,
      extra: ['Yek: 0x' + yek.toString(16).toUpperCase().padStart(5, '0'), '+: ' + dip(DIP_P), 'o: ' + dip(DIP_O), '-: ' + dip(DIP_N)],
    };
  }
}
