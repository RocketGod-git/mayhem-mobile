/** Feron 32-bit OOK light remotes (Flipper Unleashed lib/subghz/protocols/feron.c; twin of ism/SFeron.kt). Receive only. */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;

export class SFeron extends FProto {
  private gData = 0n;
  constructor() { super(Fam.REMOTE, S.FERON); this.teShort = 350; this.teLong = 750; this.teDelta = 150; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teLong * 6) < this.teDelta * 4) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(duration, this.teShort + 150) < this.teDelta) {
            // End of the key: 500 us low (here), then 500 us high
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
            if (this.decodeCountBit === this.minCountBitForFound) { this.gData = this.decodeData; this.dataCountBit = this.decodeCountBit; this.hit(); }
            this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const cmd = Number(this.gData & 0xFFFFn);
    return { name: remoteName(this.sensorType), serial: (this.gData >> 16n) & 0xFFFFn, btn: null, cnt: null, extra: ['Command: 0x' + cmd.toString(16).toUpperCase().padStart(4, '0')] };
  }
}
