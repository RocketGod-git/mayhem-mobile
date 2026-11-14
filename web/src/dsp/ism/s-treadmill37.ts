/**
 * Treadmill37 (QH-433) treadmill remotes, 433.92 MHz AM, 37-bit fixed code (Flipper Unleashed
 * lib/subghz/protocols/treadmill37.c; twin of ism/STreadmill37.kt). PWM at Te 300 us: bit 0 = HIGH Te + LOW 3Te,
 * bit 1 = HIGH 3Te + LOW Te, MSB first, frame closed by a ~20 Te LOW that stands in for the last bit's low half.
 * Layout: serial(20) | button code(16) | stop(1); Flipper prints the 16-bit code as "Btn". Receive only.
 */
import { FProto, Fam, S } from './base.js';
import { type RemoteInfo, remoteName } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE_DURATION = 1, STEP_CHECK_DURATION = 2;

export class STreadmill37 extends FProto {
  private rx = 0n;
  constructor() { super(Fam.REMOTE, S.TREADMILL37); this.teShort = 300; this.teLong = 900; this.teDelta = 150; this.minCountBitForFound = 37; }

  private isGap(duration: number): boolean { return this.dd(duration, this.teShort * 20) < this.teDelta * 4; }

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
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.isGap(duration)) {
            // Closing gap: the last bit has only its high half.
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
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
    let rev = 0n;
    for (let i = 0; i < this.dataCountBit; i++) rev = (rev << 1n) | ((this.rx >> BigInt(i)) & 1n);
    const yek = (rev & 0xFFFFFFFFFFn).toString(16).toUpperCase().padStart(8, '0');
    return { name: remoteName(this.sensorType), serial: (this.rx >> 17n) & 0xFFFFFFFFn, btn: Number((this.rx >> 1n) & 0xFFFFn), cnt: null, extra: ['Yek: 0x' + yek] };
  }
}
