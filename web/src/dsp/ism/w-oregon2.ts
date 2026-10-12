/** Oregon Scientific v2.1 weather sensors (Mayhem fprotos/w-oregon2.hpp; twin of ism/WOregon2.kt). Switches to W.OREGON2B for THGR122N. */
import { FProto, Fam, W, Manchester, MASK64 } from './base.js';

const STEP_RESET = 0, STEP_FOUND_PREAMBLE = 1, STEP_VAR_DATA = 2;
const PREAMBLE_BITS = 19;
const PREAMBLE_MASK = 0b1111111111111111111n;
const PREAMBLE = 0b1111111111111110101n; // 15 ones + 0101 (inverted A)
const CHECKSUM_BITS = 8;
const ID_THGR122N = 0x1d20;
const ID_THR228N = 0xec40;
const ID_RTHN129_1 = 0x9cd3, ID_RTHN129_2 = 0xacd3, ID_RTHN129_3 = 0xbcd3, ID_RTHN129_4 = 0xccd3, ID_RTHN129_5 = 0xdcd3;

export class WOregon2 extends FProto {
  private data = 0n;
  private haveBit = false;
  private prevBit = false;
  private varBits = 0;
  private varData = 0n;
  private readonly manchester = new Manchester();

  constructor() { super(Fam.WEATHER, W.OREGON2); this.teShort = 500; this.teLong = 1000; this.teDelta = 200; this.minCountBitForFound = 32; }

  feed(level: boolean, duration: number): void {
    // oregon v2.1 signal is inverted
    const event = this.levelAndDurationToEvent(!level, duration);

    // low-level bit sequence decoding
    if (event === Manchester.EVENT_RESET) { this.parserStep = STEP_RESET; this.haveBit = false; this.decodeData = 0n; this.decodeCountBit = 0; }
    if (this.manchester.advance(event)) {
      const bitValue = this.manchester.data;
      if (this.haveBit) {
        if (!this.prevBit && bitValue) this.addBit(1);
        else if (this.prevBit && !bitValue) this.addBit(0);
        else this.reset();
        this.haveBit = false;
      } else { this.prevBit = bitValue; this.haveBit = true; }
    }

    switch (this.parserStep) {
      case STEP_RESET:
        // waiting for fixed oregon2 preamble
        if (this.decodeCountBit >= PREAMBLE_BITS && (this.decodeData & PREAMBLE_MASK) === PREAMBLE) { this.parserStep = STEP_FOUND_PREAMBLE; this.decodeCountBit = 0; this.decodeData = 0n; }
        break;
      case STEP_FOUND_PREAMBLE:
        // waiting for fixed oregon2 data
        if (this.decodeCountBit === 32) {
          this.data = this.decodeData; this.decodeData = 0n; this.decodeCountBit = 0;
          // reverse nibbles in decoded data
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
          this.varData = this.decodeData & 0xFFFFFFFFn;
          // reverse nibbles in var data
          this.varData = ((this.varData & 0x55555555n) << 1n) | ((this.varData & 0xAAAAAAAAn) >> 1n);
          this.varData = ((this.varData & 0x33333333n) << 2n) | ((this.varData & 0xCCCCCCCCn) >> 2n);
          this.decodeData = this.varData >> BigInt(CHECKSUM_BITS);
          this.decodeData = (this.decodeData | (this.data << 32n)) & MASK64; // unique to portapack: the fixed part rides in the upper half
          this.parserStep = STEP_RESET;
          this.hit();
        }
        break;
    }
  }

  private reset(): void {
    this.parserStep = STEP_RESET;
    this.decodeData = 0n; this.decodeCountBit = 0;
    this.manchester.advance(Manchester.EVENT_RESET);
    this.haveBit = false;
    this.varData = 0n; this.varBits = 0;
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
      case ID_THR228N: case ID_RTHN129_1: case ID_RTHN129_2: case ID_RTHN129_3: case ID_RTHN129_4: case ID_RTHN129_5:
        this.sensorType = W.OREGON2;
        return 16;
      case ID_THGR122N:
        this.sensorType = W.OREGON2B;
        return 24;
      default:
        return 0;
    }
  }
}
