/**
 * Beninca ARC rolling-code remotes, 128-bit OOK PWM, AES-128 encrypted (Flipper Unleashed
 * lib/subghz/protocols/beninca_arc.c; twin of ism/SBenincaArc.kt). Receive only. Serial, button and counter are inside
 * the AES block, which needs the manufacturer key, so only the two raw 64-bit halves are shown (Key1 = decodeData,
 * Key2 = decodeData2).
 */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_START = 0, STEP_HIGH = 1, STEP_LOW = 2;

export class SBenincaArc extends FProto {
  /** generic.data in Flipper: the first 64 bits, kept until the next frame overwrites it. */
  private dataHi = 0n;

  constructor() { super(Fam.REMOTE, S.BENINCA_ARC); this.teShort = 300; this.teLong = 600; this.teDelta = 155; this.minCountBitForFound = 128; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_START:
        if (!level && this.dd(duration, this.teLong * 16) < this.teDelta * 15) {
          // Gap (9600 +- 2325 us) found
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_HIGH;
        }
        break;
      case STEP_HIGH:
        if (level) {
          this.teLast = duration; this.parserStep = STEP_LOW;
          if (this.decodeCountBit === this.minCountBitForFound / 2 && this.decodeData !== 0n) {
            // First 64 bits captured
            this.dataHi = this.decodeData; this.decodeData = 0n;
          } else if (this.decodeCountBit === this.minCountBitForFound) {
            // All 128 bits captured (this mark is the stop bit)
            const lo = this.decodeData;
            this.decodeData = this.dataHi; this.decodeData2 = lo; this.dataCountBit = this.decodeCountBit;
            this.parserStep = STEP_START;
            this.hit();
          }
        } else this.parserStep = STEP_START;
        break;
      case STEP_LOW:
        if (!level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(1); this.parserStep = STEP_HIGH; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_HIGH; }
          else this.parserStep = STEP_START;
        } else this.parserStep = STEP_START;
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    return { name: remoteName(this.sensorType), serial: 0n, btn: null, cnt: null, extra: ['Key2: ' + this.decodeData2.toString(16).toUpperCase().padStart(16, '0'), 'Hop: AES-128 encrypted'] };
  }
}
