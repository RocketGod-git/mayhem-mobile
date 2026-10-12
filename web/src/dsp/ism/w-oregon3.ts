/** Oregon Scientific v3.0 weather sensors (Mayhem fprotos/w-oregon3.hpp; twin of ism/WOregon3.kt). */
import { FProto, Fam, W, Manchester, MASK64 } from './base.js';

const STEP_RESET = 0, STEP_FOUND_PREAMBLE = 1, STEP_VAR_DATA = 2;
const PREAMBLE_BITS = 28;
const PREAMBLE_MASK = 0b1111111111111111111111111111n;
const PREAMBLE = 0b1111111111111111111111110101n; // 24 ones + 0101 (inverted A)
const FIXED_PART_BITS = 16 + 4 + 8 + 4; // sensor type, channel, id, battery
const CHECKSUM_BITS = 8;
const ID_THGR221 = 0xf824;

export class WOregon3 extends FProto {
  private data = 0n;
  private varBits = 0;
  private varData = 0n;
  private readonly manchester = new Manchester();

  constructor() { super(Fam.WEATHER, W.OREGON3); this.teShort = 500; this.teLong = 1100; this.teDelta = 300; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    const event = this.levelAndDurationToEvent(!level, duration);

    // low-level bit sequence decoding
    if (event === Manchester.EVENT_RESET) { this.parserStep = STEP_RESET; this.decodeData = 0n; this.decodeCountBit = 0; }
    if (this.manchester.advance(event)) this.addBit(this.manchester.data ? 1 : 0);

    switch (this.parserStep) {
      case STEP_RESET:
        // waiting for fixed oregon3 preamble
        if (this.decodeCountBit >= PREAMBLE_BITS && (this.decodeData & PREAMBLE_MASK) === PREAMBLE) { this.parserStep = STEP_FOUND_PREAMBLE; this.decodeCountBit = 0; this.decodeData = 0n; }
        break;
      case STEP_FOUND_PREAMBLE:
        // waiting for fixed oregon3 data
        if (this.decodeCountBit === FIXED_PART_BITS) {
          this.data = this.decodeData; this.decodeData = 0n; this.decodeCountBit = 0;
          // reverse nibbles in decoded data as oregon v3.0 is LSB first
          this.data = ((this.data & 0x55555555n) << 1n) | ((this.data & 0xAAAAAAAAn) >> 1n);
          this.data = ((this.data & 0x33333333n) << 2n) | ((this.data & 0xCCCCCCCCn) >> 2n);
          this.varBits = this.sensorIdVarBits(Number((this.data >> 16n) & 0xFFFFn));
          if (this.varBits === 0) this.parserStep = STEP_RESET; // sensor is not supported, stop decoding
          else this.parserStep = STEP_VAR_DATA;
        }
        break;
      case STEP_VAR_DATA:
        // waiting for variable (sensor-specific data)
        if (this.decodeCountBit === this.varBits + CHECKSUM_BITS) {
          this.varData = this.decodeData & MASK64;
          // reverse nibbles in var data
          this.varData = (((this.varData & 0x5555555555555555n) << 1n) | ((this.varData & 0xAAAAAAAAAAAAAAAAn) >> 1n)) & MASK64;
          this.varData = (((this.varData & 0x3333333333333333n) << 2n) | ((this.varData & 0xCCCCCCCCCCCCCCCCn) >> 2n)) & MASK64;
          this.decodeData = this.varData >> BigInt(CHECKSUM_BITS);
          this.parserStep = STEP_RESET;
          this.hit();
        }
        break;
    }
  }

  private levelAndDurationToEvent(level: boolean, duration: number): number {
    let isLong: boolean;
    if (this.dd(duration, this.teLong) < this.teDelta) isLong = true;
    else if (this.dd(duration, this.teShort) < this.teDelta) isLong = false;
    else return Manchester.EVENT_RESET;
    if (level) return isLong ? Manchester.EVENT_LONG_HIGH : Manchester.EVENT_SHORT_HIGH;
    else return isLong ? Manchester.EVENT_LONG_LOW : Manchester.EVENT_SHORT_LOW;
  }

  private sensorIdVarBits(sensorId: number): number {
    switch (sensorId) {
      case ID_THGR221:
        // nibbles: temp + hum + '0'
        return (4 + 2 + 1) * 4;
      default:
        return 0;
    }
  }
}
