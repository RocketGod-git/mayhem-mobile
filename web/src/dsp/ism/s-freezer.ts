/** Freezer 24-bit OOK remotes (Flipper Unleashed lib/subghz/protocols/freezer.c; twin of ism/SFreezer.kt). Receive only. */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_START = 1, STEP_SAVE = 2, STEP_CHECK = 3;
const SYMBOL_MIN = 120, SYMBOL_SPLIT = 375, SYMBOL_MAX = 700; // short at or under the split, long above
const isShort = (d: number): boolean => d >= SYMBOL_MIN && d <= SYMBOL_SPLIT;
const isLong = (d: number): boolean => d > SYMBOL_SPLIT && d <= SYMBOL_MAX;

export class SFreezer extends FProto {
  private lastData = 0n;
  private gData = 0n;
  constructor() { super(Fam.REMOTE, S.FREEZER); this.teShort = 250; this.teLong = 500; this.teDelta = 120; this.minCountBitForFound = 24; }

  feed(level: boolean, duration: number): void {
    const gapMin = this.teShort * 30;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && duration >= gapMin) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_START; }
        break;
      case STEP_START:
        this.parserStep = level && isShort(duration) ? STEP_SAVE : STEP_RESET;
        break;
      case STEP_SAVE: // a cell opens on the low
        if (level) { this.parserStep = STEP_RESET; break; }
        if (duration >= gapMin) {
          // Only a code that arrived twice running is reported
          const full = this.decodeCountBit === this.minCountBitForFound;
          if (full && this.decodeData === this.lastData && this.lastData !== 0n) { this.gData = this.decodeData; this.dataCountBit = this.decodeCountBit; this.hit(); }
          this.lastData = full ? this.decodeData : 0n;
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_START;
          break;
        }
        this.teLast = duration; this.parserStep = STEP_CHECK;
        break;
      case STEP_CHECK: // and closes on the high
        if (!level) { this.parserStep = STEP_RESET; break; }
        if (isShort(this.teLast) && isLong(duration)) { this.addBit(1); this.parserStep = STEP_SAVE; }
        else if (isLong(this.teLast) && isShort(duration)) { this.addBit(0); this.parserStep = STEP_SAVE; }
        else { this.lastData = 0n; this.parserStep = STEP_RESET; }
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    return { name: remoteName(this.sensorType), serial: (this.gData >> 4n) & 0xFFFFFn, btn: Number(this.gData & 0xFn), cnt: null, extra: [] };
  }
}
