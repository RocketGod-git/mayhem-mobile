/**
 * Dickert MAHS gate remotes, 36-bit OOK PWM, 18 trinary symbols: 10 user DIPs + 8-symbol factory code (Flipper
 * Unleashed lib/subghz/protocols/dickert_mahs.c; twin of ism/SDickertMahs.kt). Receive only.
 */
import { FProto, Fam, S, FG } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_INITIAL = 1, STEP_RECORDING = 2;

export class SDickertMahs extends FProto {
  private tmp0 = 0;
  private tmpCnt = 0;

  constructor() { super(Fam.REMOTE, S.DICKERT_MAHS); this.teShort = 400; this.teLong = 800; this.teDelta = 100; this.minCountBitForFound = 36; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        // Check if done
        if (this.decodeCountBit >= this.minCountBitForFound) {
          this.dataCountBit = this.decodeCountBit;
          this.hit();
          this.decodeData = 0n; this.decodeCountBit = 0;
        }
        if (!level && this.dd(duration, this.teLong * 50) < this.teDelta * 70) this.parserStep = STEP_INITIAL; // 40 ms header
        break;
      case STEP_INITIAL:
        if (!level) break;
        if (this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_RECORDING; this.decodeData = 0n; this.decodeCountBit = 0; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_RECORDING:
        if ((!level && this.tmpCnt === 0) || (level && this.tmpCnt === 1)) {
          if (this.tmpCnt === 0) { this.tmp0 = duration; this.tmpCnt = 1; break; }
          // Space + mark: a bit is 1200 us in all
          this.tmpCnt = 0;
          if (this.dd(this.tmp0 + duration, 1200) < this.teDelta) {
            if (this.dd(this.tmp0, this.teLong) < this.teDelta) this.addBit(1);
            else if (this.dd(this.tmp0, this.teShort) < this.teDelta) this.addBit(0);
          } else this.parserStep = STEP_RESET;
        } else { this.tmpCnt = 0; this.parserStep = STEP_RESET; }
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit < this.minCountBitForFound) return null;
    // Symbols from the low 36 bits, MSB first: 11 = '+', 01 = '0', 00 = '-', 10 = '?'
    let code = '';
    for (let i = 0; i < 18; i++) {
      const sym = FG.bits(this.decodeData, 34 - i * 2, 3);
      code += sym === 1 ? '0' : sym === 0 ? '-' : sym === 3 ? '+' : '?';
    }
    return { name: remoteName(this.sensorType), serial: 0n, btn: null, cnt: null, extra: ['User DIPs: ' + code.slice(0, 10), 'Factory code: ' + code.slice(10, 18)] };
  }
}
