/**
 * Keyfinder 2 key finder fobs, 433.92 MHz AM, 11-bit fixed code (Flipper Unleashed lib/subghz/protocols/keyfinder2.c;
 * twin of ism/SKeyfinder2.kt). Frame = button(3) in wide symbols | 10011 | button(3) in narrow symbols, MSB first,
 * repeated back to back with no gap. Receive only.
 */
import { FProto, Fam, S } from './base.js';
import { type RemoteInfo, remoteName } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE_WIDE = 1, STEP_CHECK_WIDE = 2, STEP_SAVE_DURATION = 3, STEP_CHECK_DURATION = 4;
const TE_WIDE_SHORT = 1500, TE_WIDE_LONG = 2500, TE_WIDE_DELTA = 350, HEADER_BITS = 3;

/** Color printed on the button for this code (taken from one four-button fob). */
function color(btn: number): string {
  switch (btn) { case 3: return 'Purple'; case 4: return 'Blue'; case 5: return 'Green'; case 6: return 'Red'; default: return 'Unknown'; }
}

export class SKeyfinder2 extends FProto {
  private rx = 0n;
  constructor() { super(Fam.REMOTE, S.KEYFINDER2); this.teShort = 350; this.teLong = 1020; this.teDelta = 150; this.minCountBitForFound = 11; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && (this.dd(duration, TE_WIDE_SHORT) < TE_WIDE_DELTA || this.dd(duration, TE_WIDE_LONG) < TE_WIDE_DELTA)) {
          this.decodeData = 0n; this.decodeCountBit = 0; this.teLast = duration; this.parserStep = STEP_CHECK_WIDE;
        }
        break;
      case STEP_SAVE_WIDE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK_WIDE; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_WIDE:
        if (!level) {
          if (this.dd(this.teLast, TE_WIDE_SHORT) < TE_WIDE_DELTA && this.dd(duration, TE_WIDE_LONG) < TE_WIDE_DELTA) this.addBit(1);
          else if (this.dd(this.teLast, TE_WIDE_LONG) < TE_WIDE_DELTA && this.dd(duration, TE_WIDE_SHORT) < TE_WIDE_DELTA) this.addBit(0);
          else { this.parserStep = STEP_RESET; break; }
          this.parserStep = this.decodeCountBit === HEADER_BITS ? STEP_SAVE_DURATION : STEP_SAVE_WIDE;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) this.addBit(1);
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) this.addBit(0);
          else { this.parserStep = STEP_RESET; break; }
          if (this.decodeCountBit === this.minCountBitForFound) {
            this.dataCountBit = this.decodeCountBit; this.rx = this.decodeData;
            this.hit();
            this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_SAVE_DURATION;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const btn = Number(this.rx & 0x7n);
    return { name: remoteName(this.sensorType), serial: 0n, btn, cnt: null, extra: ['Color: ' + color(btn)] };
  }
}
