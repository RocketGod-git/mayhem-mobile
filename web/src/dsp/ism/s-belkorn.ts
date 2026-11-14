/**
 * BelKorn rolling-code remotes, 118-bit OOK, one bit per pulse on marks and spaces alike (Flipper Unleashed
 * lib/subghz/protocols/belkorn.c; twin of ism/SBelkorn.kt). Receive only. The frame is not encrypted: the 36-bit
 * serial, 6-bit button and 16-bit press counter are read straight out of it. Bits 0..63 are kept in decodeData and
 * bits 64..117 in decodeData2, MSB first.
 */
import { FProto, Fam, S } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_DATA = 1;
const GAP_MIN = 2500;
const SYNC = 0x801n;

export class SBelkorn extends FProto {
  constructor() { super(Fam.REMOTE, S.BELKORN); this.teShort = 481; this.teLong = 962; this.teDelta = 180; this.minCountBitForFound = 118; }

  /** Field `len` bits wide at bit `pos` (MSB first) of the 118-bit frame. */
  static get(data: bigint, data2: bigint, pos: number, len: number): number {
    const mask = (1n << BigInt(len)) - 1n;
    return Number(pos + len <= 64 ? (data >> BigInt(64 - pos - len)) & mask : (data2 >> BigInt(118 - pos - len)) & mask);
  }

  /** The sync word is right and exactly one button bit is set. */
  static frameValid(data: bigint, data2: bigint): boolean {
    const btn = Number(data2 & 0x3Fn);
    return (data >> 52n) === SYNC && btn !== 0 && (btn & (btn - 1)) === 0;
  }

  private dataHi = 0n;

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && duration >= GAP_MIN) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_DATA; }
        break;
      case STEP_DATA: {
        // Bits alternate mark and space, so a level out of turn means the frame was broken
        if (level !== ((this.decodeCountBit & 1) === 0)) { this.parserStep = STEP_RESET; break; }
        if (this.dd(duration, this.teShort) < this.teDelta) this.addBit(0);
        else if (this.dd(duration, this.teLong) < this.teDelta) this.addBit(1);
        else { this.parserStep = STEP_RESET; break; }
        if (this.decodeCountBit === 64) { this.dataHi = this.decodeData; this.decodeData = 0n; }
        else if (this.decodeCountBit === this.minCountBitForFound) {
          const lo = this.decodeData;
          this.parserStep = STEP_RESET;
          if (SBelkorn.frameValid(this.dataHi, lo)) {
            this.decodeData = this.dataHi; this.decodeData2 = lo; this.dataCountBit = this.decodeCountBit;
            this.hit();
          }
        }
        break;
      }
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const d = this.decodeData, d2 = this.decodeData2;
    if (!SBelkorn.frameValid(d, d2)) return null;
    const g = (pos: number, len: number): number => SBelkorn.get(d, d2, pos, len);
    const serial = (BigInt(g(12, 4)) << 32n) | BigInt(g(16, 32) >>> 0);
    const b5 = g(88, 8), b6 = g(96, 8), c = g(104, 8);
    const cnt = (((c & 1) ? b5 : b6) << 8) | c;
    return { name: remoteName(this.sensorType), serial, btn: g(112, 6), cnt, extra: ['Key2: ' + d2.toString(16).toUpperCase()] };
  }
}
