import { FProto, Fam, S } from './base.js';
const STEP_RESET = 0, STEP_SEARCH_START_BIT = 1, STEP_SAVE = 2, STEP_DECODER_DATA = 3;
const BIT_0 = 0, BIT_1 = 1, BIT_2 = 2;
const PACKET_1_INDEX_BASE = 0, PACKET_2_INDEX_BASE = 21;
const PACKET_1_ACCEPTED = 1 << 0, PACKET_2_ACCEPTED = 1 << 1;
export class SSecplusV1 extends FProto {
    constructor() {
        super(Fam.REMOTE, S.SECPLUS_V1);
        this.packetAccepted = 0;
        this.basePacketIndex = 0;
        this.dataArray = new Array(44).fill(0);
        this.teShort = 500;
        this.teLong = 1500;
        this.teDelta = 100;
        this.minCountBitForFound = 21;
    }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (!level && this.dd(duration, this.teShort * 120) < this.teDelta * 120) {
                    this.parserStep = STEP_SEARCH_START_BIT;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                    this.packetAccepted = 0;
                    this.dataArray.fill(0);
                }
                break;
            case STEP_SEARCH_START_BIT:
                if (level) {
                    if (this.dd(duration, this.teShort) < this.teDelta) {
                        this.basePacketIndex = PACKET_1_INDEX_BASE;
                        this.dataArray[this.decodeCountBit + this.basePacketIndex] = BIT_0;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(duration, this.teLong) < this.teDelta) {
                        this.basePacketIndex = PACKET_2_INDEX_BASE;
                        this.dataArray[this.decodeCountBit + this.basePacketIndex] = BIT_2;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE:
                if (!level) {
                    if (this.dd(duration, this.teShort * 120) < this.teDelta * 120) {
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            if (this.basePacketIndex === PACKET_1_INDEX_BASE)
                                this.packetAccepted |= PACKET_1_ACCEPTED;
                            if (this.basePacketIndex === PACKET_2_INDEX_BASE)
                                this.packetAccepted |= PACKET_2_ACCEPTED;
                            if (this.packetAccepted === (PACKET_1_ACCEPTED | PACKET_2_ACCEPTED)) {
                                this.hit();
                                this.parserStep = STEP_RESET;
                            }
                        }
                        this.parserStep = STEP_SEARCH_START_BIT;
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                    }
                    else {
                        this.teLast = duration;
                        this.parserStep = STEP_DECODER_DATA;
                    }
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_DECODER_DATA:
                if (level && this.decodeCountBit <= this.minCountBitForFound) {
                    if (this.dd(this.teLast, this.teShort * 3) < this.teDelta * 3 && this.dd(duration, this.teShort) < this.teDelta) {
                        this.dataArray[this.decodeCountBit + this.basePacketIndex] = BIT_0;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teShort * 2) < this.teDelta * 2 && this.dd(duration, this.teShort * 2) < this.teDelta * 2) {
                        this.dataArray[this.decodeCountBit + this.basePacketIndex] = BIT_1;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort * 3) < this.teDelta * 3) {
                        this.dataArray[this.decodeCountBit + this.basePacketIndex] = BIT_2;
                        this.decodeCountBit++;
                        this.parserStep = STEP_SAVE;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
        }
    }
}
