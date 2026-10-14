import { FProto, Fam, S, Manchester, MASK64 } from './base.js';
const PACKET_HEADER = 0xfd000000aa000000n, PACKET_HEADER_MASK = 0xff000000ff000000n;
export class SPowerSmart extends FProto {
    constructor() {
        super(Fam.REMOTE, S.POWER_SMART);
        this.manchester = new Manchester();
        this.teShort = 225;
        this.teLong = 450;
        this.teDelta = 100;
        this.minCountBitForFound = 64;
    }
    feed(level, duration) {
        let event = Manchester.EVENT_RESET;
        if (!level) {
            if (this.dd(duration, this.teShort) < this.teDelta)
                event = Manchester.EVENT_SHORT_LOW;
            else if (this.dd(duration, this.teLong) < this.teDelta * 2)
                event = Manchester.EVENT_LONG_LOW;
        }
        else {
            if (this.dd(duration, this.teShort) < this.teDelta)
                event = Manchester.EVENT_SHORT_HIGH;
            else if (this.dd(duration, this.teLong) < this.teDelta * 2)
                event = Manchester.EVENT_LONG_HIGH;
        }
        if (event !== Manchester.EVENT_RESET) {
            if (this.manchester.advance(event))
                this.decodeData = ((this.decodeData << 1n) | (this.manchester.data ? 0n : 1n)) & MASK64;
            if ((this.decodeData & PACKET_HEADER_MASK) === PACKET_HEADER) {
                if (this.checkValid(this.decodeData)) {
                    this.dataCountBit = this.minCountBitForFound;
                    this.hit();
                    this.decodeData = 0n;
                    this.decodeCountBit = 0;
                }
            }
        }
        else {
            this.decodeData = 0n;
            this.decodeCountBit = 0;
            this.manchester.advance(Manchester.EVENT_RESET);
        }
    }
    checkValid(packet) {
        const data1 = Number((packet >> 40n) & 0xffffn);
        const data2 = Number((~packet >> 8n) & 0xffffn);
        const data3 = Number((packet >> 32n) & 0xffn);
        const data4 = (Number(~packet & 0xffn) - 1) & 0xFF;
        return data1 === data2 && data3 === data4;
    }
}
