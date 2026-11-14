/**
 * Jarolift 72-bit KeeLoq OOK shutter remotes (Flipper Unleashed lib/subghz/protocols/jarolift.c; twin of ism/SJarolift.kt).
 * Receive only. The hopping part is KeeLoq-encrypted with a manufacturer key this app does not hold, so only the plain
 * fixed part (serial, button), the encrypted hop as opaque hex and the grouping byte are shown; no counter.
 */
import { FG, FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_SAVE = 2, STEP_CHECK = 3;

function buttonName(btn: number): string {
  switch (btn) { case 0x1: return 'Learn'; case 0x2: return 'Down'; case 0x4: return 'Stop'; case 0x8: return 'Up'; default: return 'Unkn'; }
}
const hx = (v: bigint, w: number): string => v.toString(16).toUpperCase().padStart(w, '0');

export class SJarolift extends FProto {
  /** Flipper's generic.data (first 64 bits) and generic.data_2 (grouping byte). */
  private gData = 0n;
  private gData2 = 0n;
  constructor() { super(Fam.REMOTE, S.JAROLIFT); this.teShort = 400; this.teLong = 800; this.teDelta = 167; this.minCountBitForFound = 72; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_PREAMBLE; this.headerCount++; }
        break;
      case STEP_PREAMBLE:
        if (!level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_RESET; break; }
        if (!level && this.headerCount === 8 && this.dd(duration, this.teLong * 5) < this.teDelta * 6) {
          // Found the gap after the header (4000 us)
          this.parserStep = STEP_SAVE; this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0;
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; }
        else { this.headerCount = 0; this.parserStep = STEP_RESET; }
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.decodeCountBit === 64) { this.gData = this.decodeData; this.decodeData = 0n; }
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else {
            if (duration >= this.teLong * 3) {
              // End bit, read from its high alone
              if (this.dd(this.teLast, this.teLong) < this.teDelta) this.addBit(0);
              else if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(1);
              if (this.decodeCountBit === this.minCountBitForFound) {
                this.gData2 = this.decodeData; this.dataCountBit = this.decodeCountBit;
                this.decodeData = this.gData; this.decodeData2 = this.gData2;
                this.hit();
              }
              this.parserStep = STEP_RESET; this.decodeData = 0n; this.decodeData2 = 0n; this.decodeCountBit = 0; this.headerCount = 0;
              break;
            }
            this.parserStep = STEP_RESET; this.headerCount = 0;
          }
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const key = FG.reverseKey(this.gData, 64);
    const group = FG.reverseKey(this.gData2, 8);
    const btn = Number((key >> 60n) & 0xFn);
    return { name: remoteName(this.sensorType), serial: (key >> 32n) & 0xFFFFFFFn, btn, cnt: null,
      extra: ['Button: ' + buttonName(btn), 'Hop: ' + hx(key & 0xFFFFFFFFn, 8) + ' (encrypted)', 'Group: ' + hx(group, 2)] };
  }
}
