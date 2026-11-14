/** Elplast / P-11B / 3BK / E.C.A 18-bit OOK remotes (Flipper Unleashed lib/subghz/protocols/elplast.c; twin of ism/SElplast.kt). Receive only. */
import { FG, FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;

export class SElplast extends FProto {
  private gData = 0n;
  constructor() { super(Fam.REMOTE, S.ELPLAST); this.teShort = 230; this.teLong = 1550; this.teDelta = 160; this.minCountBitForFound = 18; }

  feed(level: boolean, duration: number): void {
    const gap = this.teLong * 8, gapDelta = this.teDelta * 13;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, gap) < gapDelta) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(duration, gap) < gapDelta) {
            // Next gap: the last bit is read from its high alone
            if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            if (this.decodeCountBit === this.minCountBitForFound) { this.gData = this.decodeData; this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const yek = FG.reverseKey(this.gData, this.dataCountBit);
    return { name: remoteName(this.sensorType), serial: 0n, btn: null, cnt: null, extra: ['Yek: 0x' + yek.toString(16).toUpperCase().padStart(5, '0')] };
  }
}
