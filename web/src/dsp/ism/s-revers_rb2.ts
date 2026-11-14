/**
 * Revers RB2 / RB2M remotes, 433.92 MHz AM, 64-bit Manchester fixed code (Flipper Unleashed
 * lib/subghz/protocols/revers_rb2.c; twin of ism/SReversRb2.kt). A ~600 us LOW opens the frame, four short header
 * half-bits stand for 0xF, then Manchester at Te 250 us; a frame is accepted when byte [55:48] is 0xFF and the low 10
 * bits are the 0x200 stop code. Serial = bits [47:10]. Receive only.
 */
import { FProto, Fam, Manchester, S } from './base.js';
import { type RemoteInfo, remoteName } from './remote-fields.js';

const STEP_RESET = 0, STEP_HEADER = 1, STEP_DECODER_DATA = 2;

export class SReversRb2 extends FProto {
  private rx = 0n;
  private readonly man = new Manchester();
  constructor() { super(Fam.REMOTE, S.REVERS_RB2); this.teShort = 250; this.teLong = 500; this.teDelta = 160; this.minCountBitForFound = 64; }

  private addRbBit(bit: boolean): void {
    this.addBit(bit ? 1 : 0);
    if (this.decodeCountBit >= 65) { this.decodeData = 0n; this.decodeCountBit = 0; return; }
    if (this.decodeCountBit < this.minCountBitForFound) return;
    const preamble = (this.decodeData >> 48n) & 0xFFn;
    const stopCode = this.decodeData & 0x3FFn;
    if (preamble === 0xFFn && stopCode === 0x200n) {
      this.dataCountBit = this.decodeCountBit; this.rx = this.decodeData;
      this.hit();
      this.decodeData = 0n; this.decodeCountBit = 0;
      this.man.advance(Manchester.EVENT_RESET);
    }
  }

  feed(level: boolean, duration: number): void {
    let event = Manchester.EVENT_RESET;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, 600) < this.teDelta) {
          this.parserStep = STEP_HEADER; this.decodeData = 0n; this.decodeCountBit = 0;
          this.man.advance(Manchester.EVENT_RESET);
        }
        break;
      case STEP_HEADER:
        if (this.dd(duration, this.teShort) < this.teDelta) {
          if (!level) { if (this.teLast === 1) this.headerCount++; this.teLast = 0; }
          else { if (this.teLast === 0) this.headerCount++; this.teLast = 1; }
        } else { this.headerCount = 0; this.teLast = 0; this.parserStep = STEP_RESET; }
        if (this.headerCount === 4) {
          this.headerCount = 0; this.decodeData = 0xFn; this.decodeCountBit = 4; this.parserStep = STEP_DECODER_DATA;
        }
        break;
      case STEP_DECODER_DATA:
        if (!level) {
          if (this.dd(duration, this.teShort) < this.teDelta) event = Manchester.EVENT_SHORT_LOW;
          else if (this.dd(duration, this.teLong) < this.teDelta) event = Manchester.EVENT_LONG_LOW;
          else this.parserStep = STEP_RESET;
        } else {
          if (this.dd(duration, this.teShort) < this.teDelta) event = Manchester.EVENT_SHORT_HIGH;
          else if (this.dd(duration, this.teLong) < this.teDelta) event = Manchester.EVENT_LONG_HIGH;
          else this.parserStep = STEP_RESET;
        }
        if (event !== Manchester.EVENT_RESET && this.man.advance(event)) this.addRbBit(this.man.data);
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const serial = ((this.rx & 0xFFFFFFFFFFFFn) >> 10n) & 0xFFFFFFFFn;
    return { name: remoteName(this.sensorType), serial, btn: null, cnt: null, extra: [] };
  }
}
