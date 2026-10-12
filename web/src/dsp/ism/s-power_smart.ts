/** Power Smart remotes (Mayhem fprotos/s-power_smart.hpp; twin of ism/SPowerSmart.kt). */
import { FProto, Fam, S, Manchester, MASK64 } from './base.js';

const PACKET_HEADER = 0xFD000000AA000000n, PACKET_HEADER_MASK = 0xFF000000FF000000n;

export class SPowerSmart extends FProto {
  private readonly manchester = new Manchester();

  constructor() { super(Fam.REMOTE, S.POWER_SMART); this.teShort = 225; this.teLong = 450; this.teDelta = 100; this.minCountBitForFound = 64; }

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
      if ((this.decodeData & PACKET_HEADER_MASK) === PACKET_HEADER) {
        if (this.checkValid(this.decodeData)) {
          this.dataCountBit = this.minCountBitForFound;
          this.hit();
          this.decodeData = 0n; this.decodeCountBit = 0;
        }
      }
    } else {
      this.decodeData = 0n; this.decodeCountBit = 0;
      this.manchester.advance(Manchester.EVENT_RESET);
    }
  }

  private checkValid(packet: bigint): boolean {
    const data1 = Number((packet >> 40n) & 0xFFFFn);
    const data2 = Number((~packet >> 8n) & 0xFFFFn);
    const data3 = Number((packet >> 32n) & 0xFFn);
    const data4 = (Number(~packet & 0xFFn) - 1) & 0xFF;
    return data1 === data2 && data3 === data4;
  }
}
