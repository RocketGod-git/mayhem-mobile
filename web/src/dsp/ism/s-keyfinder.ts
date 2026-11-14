/** KeyFinder 24-bit OOK key-finder tags (Flipper Unleashed lib/subghz/protocols/keyfinder.c; twin of ism/SKeyfinder.kt). Receive only. */
import { FG, FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2, STEP_FINISH = 3;

export class SKeyfinder extends FProto {
  private endCount = 0;
  private gData = 0n;
  constructor() { super(Fam.REMOTE, S.KEYFINDER); this.teShort = 400; this.teLong = 1200; this.teDelta = 150; this.minCountBitForFound = 24; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teShort * 10) < this.teDelta * 5) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE; }
        break;
      case STEP_SAVE:
        if (this.decodeCountBit === this.minCountBitForFound) {
          // Four short end pulses close the frame
          if (level && this.dd(duration, this.teShort) < this.teDelta) {
            this.endCount++;
            if (this.endCount === 4) { this.parserStep = STEP_FINISH; this.endCount = 0; }
          } else if (!level && this.dd(duration, this.teShort) < this.teDelta) {
            // the short lows between end pulses
          } else { this.decodeData = 0n; this.decodeCountBit = 0; this.endCount = 0; this.parserStep = STEP_RESET; }
          break;
        }
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_FINISH:
        if (this.decodeCountBit === this.minCountBitForFound) { this.gData = this.decodeData; this.dataCountBit = this.decodeCountBit; this.hit(); }
        this.decodeData = 0n; this.decodeCountBit = 0; this.endCount = 0; this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const yek = FG.reverseKey(this.gData, this.dataCountBit) & 0xFFFFFFn;
    return { name: remoteName(this.sensorType), serial: this.gData >> 4n, btn: Number(this.gData & 0xFn), cnt: null,
      extra: ['Yek: 0x' + yek.toString(16).toUpperCase().padStart(6, '0')] };
  }
}
