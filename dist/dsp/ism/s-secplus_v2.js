import { FProto, Fam, S, Manchester } from './base.js';
const STEP_RESET = 0, STEP_DECODER_DATA = 1;
const HEADER = 0x3c0000000000n, HEADER_MASK = 0xffff3c0000000000n;
const PACKET_1 = 0x000000000000n, PACKET_2 = 0x010000000000n, PACKET_MASK = 0x30000000000n;
export class SSecplusV2 extends FProto {
    constructor() {
        super(Fam.REMOTE, S.SECPLUS_V2);
        this.manchester = new Manchester();
        this.secplusPacket1 = 0n;
        this.teShort = 250;
        this.teLong = 500;
        this.teDelta = 110;
        this.minCountBitForFound = 62;
        this.manchester.state = Manchester.MID0;
    }
    feed(level, duration) {
        let event = Manchester.EVENT_RESET;
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teLong * 130) < this.teDelta * 100) {
                    this.parserStep = STEP_DECODER_DATA;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                    this.secplusPacket1 = 0n;
                    this.manchester.advance(Manchester.EVENT_RESET);
                    this.manchester.advance(Manchester.EVENT_LONG_HIGH);
                    this.manchester.advance(Manchester.EVENT_SHORT_LOW);
                }
                break;
            case STEP_DECODER_DATA:
                if (!level) {
                    if (this.dd(duration, this.teShort) < this.teDelta)
                        event = Manchester.EVENT_SHORT_LOW;
                    else if (this.dd(duration, this.teLong) < this.teDelta)
                        event = Manchester.EVENT_LONG_LOW;
                    else if (duration >= this.teLong * 2 + this.teDelta) {
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            if (this.checkPacket()) {
                                this.hit();
                                this.parserStep = STEP_RESET;
                            }
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.manchester.advance(Manchester.EVENT_RESET);
                        this.manchester.advance(Manchester.EVENT_LONG_HIGH);
                        this.manchester.advance(Manchester.EVENT_SHORT_LOW);
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else {
                    if (this.dd(duration, this.teShort) < this.teDelta)
                        event = Manchester.EVENT_SHORT_HIGH;
                    else if (this.dd(duration, this.teLong) < this.teDelta)
                        event = Manchester.EVENT_LONG_HIGH;
                    else
                        this.parserStep = STEP_RESET;
                }
                if (event !== Manchester.EVENT_RESET) {
                    if (this.manchester.advance(event))
                        this.addBit(this.manchester.data ? 1 : 0);
                }
                break;
        }
    }
    checkPacket() {
        if ((this.decodeData & HEADER_MASK) === HEADER) {
            if ((this.decodeData & PACKET_MASK) === PACKET_1)
                this.secplusPacket1 = this.decodeData;
            else if ((this.decodeData & PACKET_MASK) === PACKET_2 && this.secplusPacket1 !== 0n)
                return true;
        }
        return false;
    }
}
