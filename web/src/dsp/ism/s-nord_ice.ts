/**
 * Nord Ice remotes, 433.92 MHz AM, 33-bit fixed code (Flipper Unleashed lib/subghz/protocols/nord_ice.c; twin of
 * ism/SNordIce.kt). A press sends a pair of frames that differ only in bit 14 (the frame flag), told apart by the gap
 * that closes them (8980 / 7440 us); the decoder clears the flag so both frames report the same key. Layout:
 * serial[32:15] | frame[14:13] | one-hot button[12:9] | serial[8:0]. Receive only.
 */
import { FProto, Fam, S } from './base.js';
import { type RemoteInfo, remoteName } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE_DURATION = 1, STEP_CHECK_DURATION = 2;
const FRAME_FLAG = 1n << 14n;
const GAP_FLAGGED = 8980, GAP_PLAIN = 7440;
const BTN_SHIFT = 9n;

export class SNordIce extends FProto {
  private rx = 0n;
  constructor() { super(Fam.REMOTE, S.NORD_ICE); this.teShort = 270; this.teLong = 760; this.teDelta = 150; this.minCountBitForFound = 33; }

  private isGap(duration: number): boolean {
    const gd = this.teDelta * 3;
    return this.dd(duration, GAP_PLAIN) < gd || this.dd(duration, GAP_FLAGGED) < gd;
  }

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
            // The last bit has only its high half; the gap stands in for the low half.
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(0);
            else if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(1);
            if (this.decodeCountBit === this.minCountBitForFound) {
              this.decodeData &= ~FRAME_FLAG;
              this.dataCountBit = this.decodeCountBit; this.rx = this.decodeData;
              this.hit();
            }
            // This gap also opens the next frame of the pair.
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.parserStep = STEP_SAVE_DURATION;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const d = this.rx & ~FRAME_FLAG;
    const serial = (((d >> 15n) << 9n) | (d & 0x1FFn)) & 0xFFFFFFFFn;
    const btn = Number((d >> BTN_SHIFT) & 0xFn);
    let rev = 0n;
    for (let i = 0; i < this.dataCountBit; i++) rev = (rev << 1n) | ((d >> BigInt(i)) & 1n);
    const yek = (rev & 0xFFFFFFFFFn).toString(16).toUpperCase().padStart(8, '0');
    return { name: remoteName(this.sensorType), serial, btn, cnt: null, extra: ['Yek: 0x' + yek] };
  }
}
