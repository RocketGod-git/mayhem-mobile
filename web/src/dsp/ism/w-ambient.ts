/** Ambient Weather F007TH-style sensor, Manchester coded (Mayhem fprotos/w-ambient.hpp; twin of ism/WAmbient.kt). */
import { FProto, Fam, W, FG, Manchester, MASK64 } from './base.js';

const PACKET_HEADER_1 = 0xFFD440000000000n;  // 0xffd45 .. 0xffd46
const PACKET_HEADER_2 = 0x001440000000000n;  // 0x00145 .. 0x00146
const PACKET_HEADER_MASK = 0xFFFFC0000000000n;

export class WAmbient extends FProto {
  private readonly manchester = new Manchester();
  constructor() { super(Fam.WEATHER, W.AMBIENT); this.teShort = 500; this.teLong = 1000; this.teDelta = 120; this.minCountBitForFound = 48; }

  feed(level: boolean, duration: number): void {
    let event = Manchester.EVENT_RESET;
    if (!level) {
      if (this.dd(duration, this.teShort) < this.teDelta) event = Manchester.EVENT_SHORT_LOW;
      else if (this.dd(duration, this.teLong) < this.teDelta * 2) event = Manchester.EVENT_LONG_LOW;
    } else {
      if (this.dd(duration, this.teShort) < this.teDelta) event = Manchester.EVENT_SHORT_HIGH;
      else if (this.dd(duration, this.teLong) < this.teDelta * 2) event = Manchester.EVENT_LONG_HIGH;
    }
    if (event !== Manchester.EVENT_RESET) {
      if (this.manchester.advance(event)) this.decodeData = ((this.decodeData << 1n) | (this.manchester.data ? 0n : 1n)) & MASK64;
      if ((this.decodeData & PACKET_HEADER_MASK) === PACKET_HEADER_1 || (this.decodeData & PACKET_HEADER_MASK) === PACKET_HEADER_2) {
        if (this.checkCrc()) { this.hit(); this.decodeData = 0n; this.decodeCountBit = 0; }
      }
    } else {
      this.decodeData = 0n; this.decodeCountBit = 0;
      this.manchester.advance(Manchester.EVENT_RESET);
    }
  }

  private checkCrc(): boolean {
    const d = this.decodeData;
    const msg = [FG.bits(d, 40, 0xff), FG.bits(d, 32, 0xff), FG.bits(d, 24, 0xff), FG.bits(d, 16, 0xff), FG.bits(d, 8, 0xff)];
    const crc = FG.lfsrDigest8(msg, 5, 0x98, 0x3e) ^ 0x64;
    return crc === FG.bits(d, 0, 0xff);
  }
}
