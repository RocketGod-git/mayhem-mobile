/** Hay21 21-bit OOK remotes with a 4-bit counter (Flipper Unleashed lib/subghz/protocols/hay21.c; twin of ism/SHay21.kt). Receive only. */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;

function buttonName(btn: number): string {
  switch (btn) { case 0x5A: return 'On/Off'; case 0xC3: return 'Mode'; case 0x88: return 'Hold'; default: return 'Unknown'; }
}

export class SHay21 extends FProto {
  private gData = 0n;
  constructor() { super(Fam.REMOTE, S.HAY21); this.teShort = 300; this.teLong = 700; this.teDelta = 150; this.minCountBitForFound = 21; }

  feed(level: boolean, duration: number): void {
    const gap = this.teLong * 6;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, gap) < this.teDelta * 3) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(duration, gap) < this.teDelta * 2) {
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
    const btn = Number((this.gData >> 13n) & 0xFFn);
    return { name: remoteName(this.sensorType), serial: (this.gData >> 5n) & 0xFFn, btn, cnt: Number((this.gData >> 1n) & 0xFn), extra: ['Button: ' + buttonName(btn)] };
  }
}
