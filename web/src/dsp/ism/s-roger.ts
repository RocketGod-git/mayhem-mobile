/**
 * Roger gate remotes, 433.92 MHz AM, 28-bit fixed code (Flipper Unleashed lib/subghz/protocols/roger.c; twin of
 * ism/SRoger.kt). PWM at Te 500 us: bit 1 = HIGH 2Te + LOW Te, bit 0 = HIGH Te + LOW 2Te, MSB first, frame closed by a
 * ~19 Te LOW that also stands in for the last bit's low half. Layout: serial(16) | button(4) | end(8). Receive only.
 */
import { FProto, Fam, S } from './base.js';
import { type RemoteInfo, remoteName } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE_DURATION = 1, STEP_CHECK_DURATION = 2;

export class SRoger extends FProto {
  private rx = 0n;
  constructor() { super(Fam.REMOTE, S.ROGER); this.teShort = 500; this.teLong = 1000; this.teDelta = 270; this.minCountBitForFound = 28; }

  private isGap(duration: number): boolean { return this.dd(duration, this.teShort * 19) < this.teDelta * 5; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.isGap(duration)) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE_DURATION; }
        break;
      case STEP_SAVE_DURATION:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.isGap(duration)) {
            // Closing gap: the last bit has only its high half.
            if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            if (this.decodeCountBit === this.minCountBitForFound) {
              this.dataCountBit = this.decodeCountBit; this.rx = this.decodeData;
              this.hit();
            }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const end = (this.rx & 0xFFn).toString(16).toUpperCase().padStart(2, '0');
    return { name: remoteName(this.sensorType), serial: (this.rx >> 12n) & 0xFFFFFFFFn, btn: Number((this.rx >> 8n) & 0xFn), cnt: null, extra: ['End: 0x' + end] };
  }
}
