import { FProto, Fam, C, FG } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
export class CBmwV0 extends FProto {
    constructor() {
        super(Fam.CAR, C.BMW_V0);
        this.crcType = 0;
        this.teShort = 350;
        this.teLong = 700;
        this.teDelta = 120;
        this.minCountBitForFound = 61;
    }
    feed(level, duration) {
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort) < this.teDelta) {
                    this.parserStep = STEP_CHECK_PREAMBULA;
                    this.teLast = duration;
                    this.headerCount = 0;
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
                break;
            case STEP_CHECK_PREAMBULA:
                if (level) {
                    if (this.dd(duration, this.teShort) < this.teDelta || this.dd(duration, this.teLong) < this.teDelta)
                        this.teLast = duration;
                    else
                        this.parserStep = STEP_RESET;
                }
                else if (this.dd(duration, this.teShort) < this.teDelta && this.dd(this.teLast, this.teShort) < this.teDelta)
                    this.headerCount++;
                else if (this.dd(duration, this.teLong) < this.teDelta && this.dd(this.teLast, this.teLong) < this.teDelta) {
                    if (this.headerCount > 15) {
                        this.parserStep = STEP_SAVE_DURATION;
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_SAVE_DURATION:
                if (level) {
                    if (duration >= this.teLong + this.teDelta * 2) {
                        if (this.decodeCountBit >= this.minCountBitForFound) {
                            this.dataCountBit = this.decodeCountBit;
                            const rawLen = Math.floor((this.decodeCountBit + 7) / 8);
                            const rawBytes = [];
                            for (let i = 0; i < rawLen; i++)
                                rawBytes.push(i < 8 ? FG.bits(this.decodeData, 8 * i, 0xff) : 0);
                            const crc8 = this.bmwCrc8(rawBytes, rawLen - 1);
                            if (crc8 === rawBytes[rawLen - 1])
                                this.crcType = 8;
                            else {
                                const crc16 = this.bmwCrc16(rawBytes, rawLen - 2);
                                const rxCrc16 = (rawBytes[rawLen - 2] << 8) | rawBytes[rawLen - 1];
                                this.crcType = crc16 === rxCrc16 ? 16 : 0;
                            }
                            if (this.crcType !== 0)
                                this.hit();
                        }
                        this.resetInternal();
                    }
                    else {
                        this.teLast = duration;
                        this.parserStep = STEP_CHECK_DURATION;
                    }
                }
                else
                    this.parserStep = STEP_RESET;
                break;
            case STEP_CHECK_DURATION:
                if (!level) {
                    if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) {
                        this.addBit(0);
                        this.parserStep = STEP_SAVE_DURATION;
                    }
                    else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) {
                        this.addBit(1);
                        this.parserStep = STEP_SAVE_DURATION;
                    }
                    else
                        this.parserStep = STEP_RESET;
                }
                else
                    this.parserStep = STEP_RESET;
                break;
        }
    }
    bmwCrc8(data, len) {
        let crc = 0x00;
        for (let i = 0; i < len; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++)
                crc = (crc & 0x80) ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
        }
        return crc;
    }
    bmwCrc16(data, len) {
        let crc = 0xFFFF;
        for (let i = 0; i < len; i++) {
            crc ^= (data[i] << 8) & 0xFFFF;
            for (let j = 0; j < 8; j++)
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
        return crc;
    }
    resetInternal() { this.decodeData = 0n; this.decodeCountBit = 0; this.decodeData2 = 0n; this.parserStep = STEP_RESET; this.headerCount = 0; this.crcType = 0; }
}
