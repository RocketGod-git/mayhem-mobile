/** VW key fob, Manchester coded with its own state machine (Mayhem fprotos/c-vw.hpp; twin of ism/CVw.kt). */
import { FProto, Fam, C, Manchester } from './base.js';

const STEP_RESET = 0, STEP_FOUND_SYNC = 1, STEP_FOUND_START1 = 2, STEP_FOUND_START2 = 3, STEP_FOUND_START3 = 4, STEP_FOUND_DATA = 5;

export class CVw extends FProto {
  private manchesterState = Manchester.MID1;
  private manchesterData = false;

  constructor() { super(Fam.CAR, C.VW); this.teShort = 500; this.teLong = 1000; this.teDelta = 130; this.minCountBitForFound = 80; }

  private vwGetBitIndex(bit: number): number {
    let bitIndex = 0;
    if (bit < 72 && bit >= 8) {
      // use decodeData (bytes 1-8)
      bitIndex = bit - 8;
    } else {
      // use decodeData2
      if (bit >= 72) bitIndex = bit - 64; // byte 0 = type
      if (bit < 8) bitIndex = bit; // byte 9 = check digit
      bitIndex |= 0x80; // mark for decodeData2
    }
    return bitIndex;
  }

  private vwAddBit(level: boolean): void {
    if (this.dataCountBit >= this.minCountBitForFound) return;
    const bitIndexFull = this.minCountBitForFound - 1 - this.dataCountBit;
    const bitIndexMasked = this.vwGetBitIndex(bitIndexFull);
    const bitIndex = BigInt(bitIndexMasked & 0x7F);
    if (bitIndexMasked & 0x80) {
      // use decodeData2
      if (level) this.decodeData2 |= 1n << bitIndex; else this.decodeData2 &= ~(1n << bitIndex);
    } else {
      // use decodeData
      if (level) this.decodeData |= 1n << bitIndex; else this.decodeData &= ~(1n << bitIndex);
    }
    this.dataCountBit++;
    if (this.dataCountBit >= this.minCountBitForFound) this.hit();
  }

  private reset(): void { this.parserStep = STEP_RESET; this.dataCountBit = 0; this.decodeData = 0n; this.decodeData2 = 0n; this.manchesterState = Manchester.MID1; }

  /** VW's own Manchester step; returns true when a bit was produced (read it from `manchesterData`). */
  private vwManchesterAdvance(event: number): boolean {
    let result = false;
    let newState = Manchester.MID1;
    const state = this.manchesterState;
    if (event === Manchester.EVENT_RESET) newState = Manchester.MID1;
    else if (state === Manchester.MID0 || state === Manchester.MID1) {
      newState = event === Manchester.EVENT_SHORT_HIGH ? Manchester.START1 : event === Manchester.EVENT_SHORT_LOW ? Manchester.START0 : Manchester.MID1;
    } else if (state === Manchester.START1) {
      if (event === Manchester.EVENT_SHORT_LOW) { newState = Manchester.MID1; result = true; this.manchesterData = true; }
      else if (event === Manchester.EVENT_LONG_LOW) { newState = Manchester.START0; result = true; this.manchesterData = true; }
      else newState = Manchester.MID1;
    } else if (state === Manchester.START0) {
      if (event === Manchester.EVENT_SHORT_HIGH) { newState = Manchester.MID0; result = true; this.manchesterData = false; }
      else if (event === Manchester.EVENT_LONG_HIGH) { newState = Manchester.START1; result = true; this.manchesterData = false; }
      else newState = Manchester.MID1;
    }
    this.manchesterState = newState;
    return result;
  }

  feed(level: boolean, duration: number): void {
    const teMed = Math.floor((this.teLong + this.teShort) / 2);
    const teEnd = this.teLong * 5;
    let event = Manchester.EVENT_RESET;

    switch (this.parserStep) {
      case STEP_RESET:
        if (this.dd(duration, this.teShort) < this.teDelta) this.parserStep = STEP_FOUND_SYNC;
        break;
      case STEP_FOUND_SYNC:
        if (this.dd(duration, this.teShort) < this.teDelta) break; // Stay - sync pattern repeats ~43 times
        if (level && this.dd(duration, this.teLong) < this.teDelta) { this.parserStep = STEP_FOUND_START1; break; }
        this.parserStep = STEP_RESET;
        break;
      case STEP_FOUND_START1:
        if (!level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_FOUND_START2; break; }
        this.parserStep = STEP_RESET;
        break;
      case STEP_FOUND_START2:
        if (level && this.dd(duration, teMed) < this.teDelta) { this.parserStep = STEP_FOUND_START3; break; }
        this.parserStep = STEP_RESET;
        break;
      case STEP_FOUND_START3:
        if (this.dd(duration, teMed) < this.teDelta) break; // Stay - med pattern repeats
        if (level && this.dd(duration, this.teShort) < this.teDelta) {
          // Start data collection
          this.vwManchesterAdvance(Manchester.EVENT_RESET);
          this.vwManchesterAdvance(Manchester.EVENT_SHORT_HIGH);
          this.dataCountBit = 0; this.decodeData = 0n; this.decodeData2 = 0n;
          this.parserStep = STEP_FOUND_DATA;
          break;
        }
        this.parserStep = STEP_RESET;
        break;
      case STEP_FOUND_DATA:
        if (this.dd(duration, this.teShort) < this.teDelta) event = level ? Manchester.EVENT_SHORT_HIGH : Manchester.EVENT_SHORT_LOW;
        if (this.dd(duration, this.teLong) < this.teDelta) event = level ? Manchester.EVENT_LONG_HIGH : Manchester.EVENT_LONG_LOW;
        // Last bit can be arbitrarily long
        if (this.dataCountBit === this.minCountBitForFound - 1 && !level && duration > teEnd) event = Manchester.EVENT_SHORT_LOW;

        if (event === Manchester.EVENT_RESET) this.reset();
        else if (this.vwManchesterAdvance(event)) this.vwAddBit(this.manchesterData);
        break;
    }
  }
}
