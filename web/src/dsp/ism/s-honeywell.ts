/** Honeywell / 2GIG security sensors, Manchester coded (Mayhem fprotos/s-honeywell.hpp; twin of ism/SHoneywell.kt). */
import { FProto, Fam, S, Manchester } from './base.js';

export class SHoneywell extends FProto {
  private readonly manchester = new Manchester();

  constructor() { super(Fam.REMOTE, S.HONEYWELL); this.teShort = 280; this.teLong = 143; this.teDelta = 51; this.minCountBitForFound = 62; }

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
      if (this.manchester.advance(event)) this.honeywellAddBit(this.manchester.data);
    } else { this.decodeData = 0n; this.decodeCountBit = 0; }
  }

  private honeywellAddBit(bit: boolean): void {
    this.addBit(bit ? 1 : 0);

    const preamble = Number((this.decodeData >> 48n) & 0xFFFFn);
    // can be multiple, since flipper can't read it well..
    if (preamble === 0b0011111111111110 || preamble === 0b0111111111111110 || preamble === 0b1111111111111110) {
      const dataToCrc: number[] = [0, 0, 0, 0];
      dataToCrc[0] = Number((this.decodeData >> 40n) & 0xFFn);
      dataToCrc[1] = Number((this.decodeData >> 32n) & 0xFFn);
      dataToCrc[2] = Number((this.decodeData >> 24n) & 0xFFn);
      dataToCrc[3] = Number((this.decodeData >> 16n) & 0xFFn);
      const channel = Number((this.decodeData >> 44n) & 0xFn);
      let crcCalc: number;
      if (channel === 0x2 || channel === 0x4 || channel === 0xA) crcCalc = this.crc16(dataToCrc, 4, 0x8050, 0); // 2GIG brand
      else crcCalc = this.crc16(dataToCrc, 4, 0x8005, 0); // channel == 0x8
      const crc = Number(this.decodeData & 0xFFFFn);
      if (crc === crcCalc) {
        // the data is good. process it.
        this.dataCountBit = this.decodeCountBit;
        this.hit();
        this.decodeData = 0n; this.decodeCountBit = 0;
      } else return;
    }
  }

  private crc16(message: number[], nBytes: number, polynomial: number, init: number): number {
    let remainder = init & 0xFFFF;
    for (let b = 0; b < nBytes; b++) {
      remainder ^= (message[b] << 8) & 0xFFFF;
      for (let bit = 0; bit < 8; bit++) remainder = (remainder & 0x8000) ? ((remainder << 1) ^ polynomial) & 0xFFFF : (remainder << 1) & 0xFFFF;
    }
    return remainder;
  }
}
