import { FProto, Fam, W, Manchester, MASK64 } from './base.js';
const STEP_RESET = 0, STEP_FOUND_PREAMBLE = 1, STEP_VAR_DATA = 2;
const PREAMBLE_BITS = 28;
const PREAMBLE_MASK = 268435455n;
const PREAMBLE = 268435445n;
const FIXED_PART_BITS = 16 + 4 + 8 + 4;
const CHECKSUM_BITS = 8;
const ID_THGR221 = 0xf824;
export class WOregon3 extends FProto {
    constructor() {
        super(Fam.WEATHER, W.OREGON3);
        this.data = 0n;
        this.varBits = 0;
        this.varData = 0n;
        this.manchester = new Manchester();
        this.teShort = 500;
        this.teLong = 1100;
        this.teDelta = 300;
        this.minCountBitForFound = 32;
    }
    feed(level, duration) {
        const event = this.levelAndDurationToEvent(!level, duration);
        if (event === Manchester.EVENT_RESET) {
            this.parserStep = STEP_RESET;
            this.decodeData = 0n;
            this.decodeCountBit = 0;
        }
        if (this.manchester.advance(event))
            this.addBit(this.manchester.data ? 1 : 0);
        switch (this.parserStep) {
            case STEP_RESET:
                if (this.decodeCountBit >= PREAMBLE_BITS && (this.decodeData & PREAMBLE_MASK) === PREAMBLE) {
                    this.parserStep = STEP_FOUND_PREAMBLE;
                    this.decodeCountBit = 0;
                    this.decodeData = 0n;
                }
                break;
            case STEP_FOUND_PREAMBLE:
                if (this.decodeCountBit === FIXED_PART_BITS) {
                    this.data = this.decodeData;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                    this.data = ((this.data & 0x55555555n) << 1n) | ((this.data & 0xaaaaaaaan) >> 1n);
                    this.data = ((this.data & 0x33333333n) << 2n) | ((this.data & 0xccccccccn) >> 2n);
                    this.varBits = this.sensorIdVarBits(Number((this.data >> 16n) & 0xffffn));
                    if (this.varBits === 0)
                        this.parserStep = STEP_RESET;
                    else
                        this.parserStep = STEP_VAR_DATA;
                }
                break;
            case STEP_VAR_DATA:
                if (this.decodeCountBit === this.varBits + CHECKSUM_BITS) {
                    this.varData = this.decodeData & MASK64;
                    this.varData = (((this.varData & 0x5555555555555555n) << 1n) | ((this.varData & 0xaaaaaaaaaaaaaaaan) >> 1n)) & MASK64;
                    this.varData = (((this.varData & 0x3333333333333333n) << 2n) | ((this.varData & 0xccccccccccccccccn) >> 2n)) & MASK64;
                    this.decodeData = this.varData >> BigInt(CHECKSUM_BITS);
                    this.parserStep = STEP_RESET;
                    this.hit();
                }
                break;
        }
    }
    levelAndDurationToEvent(level, duration) {
        let isLong;
        if (this.dd(duration, this.teLong) < this.teDelta)
            isLong = true;
        else if (this.dd(duration, this.teShort) < this.teDelta)
            isLong = false;
        else
            return Manchester.EVENT_RESET;
        if (level)
            return isLong ? Manchester.EVENT_LONG_HIGH : Manchester.EVENT_SHORT_HIGH;
        else
            return isLong ? Manchester.EVENT_LONG_LOW : Manchester.EVENT_SHORT_LOW;
    }
    sensorIdVarBits(sensorId) {
        switch (sensorId) {
            case ID_THGR221:
                return (4 + 2 + 1) * 4;
            default:
                return 0;
        }
    }
}
