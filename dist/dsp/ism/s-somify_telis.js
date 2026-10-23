import { FProto, Fam, S, Manchester } from './base.js';
const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_FOUND_PREAMBULA = 2, STEP_DECODER_DATA = 4;
export class SSomfyTelis extends FProto {
    constructor() {
        super(Fam.REMOTE, S.SOMFY_TELIS);
        this.manchester = new Manchester();
        this.teShort = 640;
        this.teLong = 1280;
        this.teDelta = 250;
        this.minCountBitForFound = 56;
    }
    feed(level, duration) {
        let event = Manchester.EVENT_RESET;
        switch (this.parserStep) {
            case STEP_RESET:
                if (level && this.dd(duration, this.teShort * 4) < this.teDelta * 4) {
                    this.parserStep = STEP_FOUND_PREAMBULA;
                    this.headerCount++;
                }
                break;
            case STEP_FOUND_PREAMBULA:
                if (!level && this.dd(duration, this.teShort * 4) < this.teDelta * 4)
                    this.parserStep = STEP_CHECK_PREAMBULA;
                else {
                    this.headerCount = 0;
                    this.parserStep = STEP_RESET;
                }
                break;
            case STEP_CHECK_PREAMBULA:
                if (level) {
                    if (this.dd(duration, this.teShort * 4) < this.teDelta * 4) {
                        this.parserStep = STEP_FOUND_PREAMBULA;
                        this.headerCount++;
                    }
                    else if (this.headerCount > 1 && this.dd(duration, this.teShort * 7) < this.teDelta * 4) {
                        this.parserStep = STEP_DECODER_DATA;
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.headerCount = 0;
                        this.manchester.advance(Manchester.EVENT_RESET);
                        this.manchester.advance(Manchester.EVENT_LONG_HIGH);
                    }
                }
                break;
            case STEP_DECODER_DATA:
                if (!level) {
                    if (this.dd(duration, this.teShort) < this.teDelta)
                        event = Manchester.EVENT_SHORT_LOW;
                    else if (this.dd(duration, this.teLong) < this.teDelta)
                        event = Manchester.EVENT_LONG_LOW;
                    else if (duration >= this.teLong + this.teDelta) {
                        if (this.decodeCountBit === this.minCountBitForFound) {
                            const dataTmp = this.decodeData ^ (this.decodeData >> 8n);
                            if (Number((dataTmp >> 40n) & 0xfn) === this.crc(dataTmp)) {
                                this.dataCountBit = this.decodeCountBit;
                                this.hit();
                            }
                        }
                        this.decodeData = 0n;
                        this.decodeCountBit = 0;
                        this.manchester.advance(Manchester.EVENT_RESET);
                        this.manchester.advance(Manchester.EVENT_LONG_HIGH);
                        this.parserStep = STEP_RESET;
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
    crc(dataIn) {
        let crc = 0n;
        const data = dataIn & 0xfff0ffffffffffn;
        for (let i = 0; i < 56; i += 8)
            crc = (crc ^ (data >> BigInt(i)) ^ (data >> BigInt(i + 4))) & 0xffn;
        return Number(crc & 0xfn);
    }
}
