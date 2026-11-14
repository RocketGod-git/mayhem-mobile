/** Hollarm 42-bit OOK alarm remotes with a byte-sum check (Flipper Unleashed lib/subghz/protocols/hollarm.c; twin of ism/SHollarm.kt). Receive only. */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_SAVE = 1, STEP_CHECK = 2;
const BUTTONS = ['Unknown', 'Disarm', 'Arm', '0x3', 'Ringtone/Alarm', '0x5', '0x6', '0x7', 'Ring', 'Settings mode', 'Exit settings',
  'Vibro sens. setting', 'Not used (in settings)', 'Volume setting', '0xE', '0xF'];

/** Sum of bytes 4..1, mod 256 (the remote sends it as byte 0). */
function byteSum(d: bigint): number { return Number(((d >> 32n) & 0xFFn) + ((d >> 24n) & 0xFFn) + ((d >> 16n) & 0xFFn) + ((d >> 8n) & 0xFFn)) & 0xFF; }

export class SHollarm extends FProto {
  private gData = 0n;
  constructor() { super(Fam.REMOTE, S.HOLLARM); this.teShort = 200; this.teLong = 1000; this.teDelta = 200; this.minCountBitForFound = 42; }

  feed(level: boolean, duration: number): void {
    const gap = this.teShort * 12;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, gap) < this.teDelta * 2) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_SAVE; }
        break;
      case STEP_SAVE:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK; } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE; }
          else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 8) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE; }
          else if (this.dd(duration, gap) < this.teDelta) {
            // Next gap: the last pulse counts as a 0
            this.addBit(0);
            if (this.decodeCountBit === this.minCountBitForFound) {
              const data = this.decodeData >> 2n; // kept 2 bits to the right for parsing
              if (byteSum(data) === Number(data & 0xFFn)) {
                this.gData = data; this.decodeData = data; this.dataCountBit = this.decodeCountBit;
                this.hit();
              }
            }
            this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const btn = Number((this.gData >> 8n) & 0xFn);
    const sum = byteSum(this.gData);
    return { name: remoteName(this.sensorType), serial: (this.gData & 0xFFFFFFF0000n) >> 16n, btn, cnt: null,
      extra: ['Sum: ' + sum.toString(16).toUpperCase().padStart(2, '0'), 'Button: ' + BUTTONS[btn]] };
  }
}
