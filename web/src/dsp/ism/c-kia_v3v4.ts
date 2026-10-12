/** Kia key fob v3 / v4 (Mayhem fprotos/c-kia_v3v4.hpp; twin of ism/CKiaV3V4.kt). */
import { FProto, Fam, C } from './base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_COLLECT_RAW_BITS = 2;

export class CKiaV3V4 extends FProto {
  private isV3Sync = false; // true = V3 (long LOW sync), false = V4 (long HIGH sync)
  private readonly rawBits: number[] = new Array<number>(32).fill(0);
  private rawBitCount = 0;

  constructor() { super(Fam.CAR, C.KIA_V3V4); this.teShort = 400; this.teLong = 800; this.teDelta = 150; this.minCountBitForFound = 68; }

  private reverse8(b: number): number {
    let byte = b & 0xff;
    byte = ((byte & 0xF0) >>> 4) | ((byte & 0x0F) << 4);
    byte = ((byte & 0xCC) >>> 2) | ((byte & 0x33) << 2);
    byte = ((byte & 0xAA) >>> 1) | ((byte & 0x55) << 1);
    return byte;
  }

  private kiaV3V4AddRawBit(bit: boolean): void {
    if (this.rawBitCount < 256) {
      const byteIdx = Math.floor(this.rawBitCount / 8);
      const bitIdx = 7 - (this.rawBitCount % 8);
      if (bit) this.rawBits[byteIdx] |= 1 << bitIdx; else this.rawBits[byteIdx] &= ~(1 << bitIdx);
      this.rawBitCount++;
    }
  }

  private kiaV3V4ProcessBuffer(): boolean {
    if (this.rawBitCount < 68) return false;
    const b = this.rawBits;

    // For V3-style (long LOW sync), data is inverted
    if (this.isV3Sync) {
      const numBytes = Math.floor((this.rawBitCount + 7) / 8);
      for (let i = 0; i < numBytes; i++) b[i] = ~b[i] & 0xff;
    }

    // Extract fields
    const serial = ((this.reverse8(b[7] & 0xF0) << 24) | (this.reverse8(b[6]) << 16) | (this.reverse8(b[5]) << 8) | this.reverse8(b[4])) >>> 0;
    const btn = (this.reverse8(b[7]) & 0xF0) >>> 4;
    this.decodeData = BigInt(serial);
    this.decodeCountBit = 68;
    this.decodeData2 = BigInt(btn);
    this.dataCountBit = this.decodeCountBit;
    this.hit();
    return true;
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 1; }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) {
          if (this.dd(duration, this.teShort) < this.teDelta) this.teLast = duration;
          else if (duration > 1000 && duration < 1500) {
            // V4 style: Sync is LONG HIGH
            if (this.headerCount >= 8) { this.parserStep = STEP_COLLECT_RAW_BITS; this.rawBitCount = 0; this.isV3Sync = false; this.rawBits.fill(0); }
            else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else {
          if (duration > 1000 && duration < 1500) {
            // V3 style: Sync is LONG LOW
            if (this.headerCount >= 8) { this.parserStep = STEP_COLLECT_RAW_BITS; this.rawBitCount = 0; this.isV3Sync = true; this.rawBits.fill(0); }
            else this.parserStep = STEP_RESET;
          } else if (this.dd(duration, this.teShort) < this.teDelta && this.dd(this.teLast, this.teShort) < this.teDelta) this.headerCount++;
          else if (duration > 1500) this.parserStep = STEP_RESET;
        }
        break;
      case STEP_COLLECT_RAW_BITS:
        if (level) {
          if (duration > 1000 && duration < 1500) {
            // Next sync pulse (V4 style) - end this packet
            this.kiaV3V4ProcessBuffer();
            this.parserStep = STEP_RESET;
          } else if (this.dd(duration, this.teShort) < this.teDelta) this.kiaV3V4AddRawBit(false);
          else if (this.dd(duration, this.teLong) < this.teDelta) this.kiaV3V4AddRawBit(true);
          else this.parserStep = STEP_RESET;
        } else {
          if (duration > 1000 && duration < 1500) {
            // Next sync pulse (V3 style) - end this packet
            this.kiaV3V4ProcessBuffer();
            this.parserStep = STEP_RESET;
          } else if (duration > 1500) {
            // Long gap - end of transmission
            this.kiaV3V4ProcessBuffer();
            this.parserStep = STEP_RESET;
          }
        }
        break;
    }
  }
}
