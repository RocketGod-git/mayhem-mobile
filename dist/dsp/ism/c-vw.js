import { FProto, Fam, C, Manchester } from './base.js';
const STEP_RESET = 0, STEP_FOUND_SYNC = 1, STEP_FOUND_START1 = 2, STEP_FOUND_START2 = 3, STEP_FOUND_START3 = 4, STEP_FOUND_DATA = 5;
export class CVw extends FProto {
    constructor() {
        super(Fam.CAR, C.VW);
        this.manchesterState = Manchester.MID1;
        this.manchesterData = false;
        this.teShort = 500;
        this.teLong = 1000;
        this.teDelta = 130;
        this.minCountBitForFound = 80;
    }
    vwGetBitIndex(bit) {
        let bitIndex = 0;
        if (bit < 72 && bit >= 8) {
            bitIndex = bit - 8;
        }
        else {
            if (bit >= 72)
                bitIndex = bit - 64;
            if (bit < 8)
                bitIndex = bit;
            bitIndex |= 0x80;
        }
        return bitIndex;
    }
    vwAddBit(level) {
        if (this.dataCountBit >= this.minCountBitForFound)
            return;
        const bitIndexFull = this.minCountBitForFound - 1 - this.dataCountBit;
        const bitIndexMasked = this.vwGetBitIndex(bitIndexFull);
        const bitIndex = BigInt(bitIndexMasked & 0x7F);
        if (bitIndexMasked & 0x80) {
            if (level)
                this.decodeData2 |= 1n << bitIndex;
            else
                this.decodeData2 &= ~(1n << bitIndex);
        }
        else {
            if (level)
                this.decodeData |= 1n << bitIndex;
            else
                this.decodeData &= ~(1n << bitIndex);
        }
        this.dataCountBit++;
        if (this.dataCountBit >= this.minCountBitForFound)
            this.hit();
    }
    reset() { this.parserStep = STEP_RESET; this.dataCountBit = 0; this.decodeData = 0n; this.decodeData2 = 0n; this.manchesterState = Manchester.MID1; }
    vwManchesterAdvance(event) {
        let result = false;
        let newState = Manchester.MID1;
        const state = this.manchesterState;
        if (event === Manchester.EVENT_RESET)
            newState = Manchester.MID1;
        else if (state === Manchester.MID0 || state === Manchester.MID1) {
            newState = event === Manchester.EVENT_SHORT_HIGH ? Manchester.START1 : event === Manchester.EVENT_SHORT_LOW ? Manchester.START0 : Manchester.MID1;
        }
        else if (state === Manchester.START1) {
            if (event === Manchester.EVENT_SHORT_LOW) {
                newState = Manchester.MID1;
                result = true;
                this.manchesterData = true;
            }
            else if (event === Manchester.EVENT_LONG_LOW) {
                newState = Manchester.START0;
                result = true;
                this.manchesterData = true;
            }
            else
                newState = Manchester.MID1;
        }
        else if (state === Manchester.START0) {
            if (event === Manchester.EVENT_SHORT_HIGH) {
                newState = Manchester.MID0;
                result = true;
                this.manchesterData = false;
            }
            else if (event === Manchester.EVENT_LONG_HIGH) {
                newState = Manchester.START1;
                result = true;
                this.manchesterData = false;
            }
            else
                newState = Manchester.MID1;
        }
        this.manchesterState = newState;
        return result;
    }
    feed(level, duration) {
        const teMed = Math.floor((this.teLong + this.teShort) / 2);
        const teEnd = this.teLong * 5;
        let event = Manchester.EVENT_RESET;
        switch (this.parserStep) {
            case STEP_RESET:
                if (this.dd(duration, this.teShort) < this.teDelta)
                    this.parserStep = STEP_FOUND_SYNC;
                break;
            case STEP_FOUND_SYNC:
                if (this.dd(duration, this.teShort) < this.teDelta)
                    break;
                if (level && this.dd(duration, this.teLong) < this.teDelta) {
                    this.parserStep = STEP_FOUND_START1;
                    break;
                }
                this.parserStep = STEP_RESET;
                break;
            case STEP_FOUND_START1:
                if (!level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_FOUND_START2;
                    break;
                }
                this.parserStep = STEP_RESET;
                break;
            case STEP_FOUND_START2:
                if (level && this.dd(duration, teMed) < this.teDelta) {
                    this.parserStep = STEP_FOUND_START3;
                    break;
                }
                this.parserStep = STEP_RESET;
                break;
            case STEP_FOUND_START3:
                if (this.dd(duration, teMed) < this.teDelta)
                    break;
                if (level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.vwManchesterAdvance(Manchester.EVENT_RESET);
                    this.vwManchesterAdvance(Manchester.EVENT_SHORT_HIGH);
                    this.dataCountBit = 0;
                    this.decodeData = 0n;
                    this.decodeData2 = 0n;
                    this.parserStep = STEP_FOUND_DATA;
                    break;
                }
                this.parserStep = STEP_RESET;
                break;
            case STEP_FOUND_DATA:
                if (this.dd(duration, this.teShort) < this.teDelta)
                    event = level ? Manchester.EVENT_SHORT_HIGH : Manchester.EVENT_SHORT_LOW;
                if (this.dd(duration, this.teLong) < this.teDelta)
                    event = level ? Manchester.EVENT_LONG_HIGH : Manchester.EVENT_LONG_LOW;
                if (this.dataCountBit === this.minCountBitForFound - 1 && !level && duration > teEnd)
                    event = Manchester.EVENT_SHORT_LOW;
                if (event === Manchester.EVENT_RESET)
                    this.reset();
                else if (this.vwManchesterAdvance(event))
                    this.vwAddBit(this.manchesterData);
                break;
        }
    }
}
