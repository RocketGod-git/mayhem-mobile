export const Fam = { WEATHER: 0, REMOTE: 1, CAR: 2 };
export const W = {
    NEXUS_TH: 1, ACURITE_592TXR: 2, ACURITE_606TX: 3, ACURITE_609TX: 4, AMBIENT: 5, AURIOL_AHFL: 6, AURIOL_TH: 7, GT_WT02: 8, GT_WT03: 9,
    INFACTORY: 10, LACROSSE_TX: 11, LACROSSE_TX141THBV2: 12, OREGON2: 13, OREGON3: 14, OREGON_V1: 15, THERMOPRO_TX4: 16, TX_8300: 17,
    WENDOX_W6726: 18, ACURITE_986: 19, KEDSUM: 20, ACURITE_5IN1: 21, EMOS_E601X: 22, SOLIGHT_TE44: 23, BRESSER_3CH: 24, BRESSER_3CH_V1: 25,
    VAUNO_EN8822: 26, OREGON2B: 27,
};
export const S = {
    PRINCETON: 1, BETT: 2, CAME: 3, PRASTEL: 4, AIRFORCE: 5, CAME_ATOMO: 6, CAME_TWEE: 7, CHAMBCODE: 8, CLEMSA: 9, DOITRAND: 10, DOOYA: 11,
    FAAC: 12, GATE_TX: 13, HOLTEK: 14, HOLTEK_HT12X: 15, HONEYWELL: 16, HONEYWELL_WDB: 17, HORMANN: 18, IDO: 19, INTERTECHNO_V3: 20,
    KEELOQ: 21, KINGGATES_STYLO_4K: 22, LEGRAND: 23, LINEAR: 24, LINEAR_DELTA3: 25, MAGELLAN: 26, MARANTEC: 27, MASTERCODE: 28, MEGACODE: 29,
    NERO_RADIO: 30, NERO_SKETCH: 31, NICE_FLO: 32, NICE_FLORS: 33, PHOENIX_V2: 34, POWER_SMART: 35, SECPLUS_V1: 36, SECPLUS_V2: 37,
    SMC5326: 38, STARLINE: 39, X10: 40, SOMFY_KEYTIS: 41, SOMFY_TELIS: 42, GANGQI: 43, MARANTEC24: 44, HOLTEK_HT6P20B: 45,
    RESTAURANT_PAGER: 46, SUPERROLLO: 47,
};
export const C = { SUZUKI: 1, VW: 2, SUBARU: 3, KIA_V5: 4, KIA_V3V4: 5, KIA_V2: 6, KIA_V1: 7, KIA_V0: 8, FORD_V0: 9, FIAT_V0: 10, BMW_V0: 11 };
export const MASK64 = (1n << 64n) - 1n;
export class Manchester {
    constructor() {
        this.state = Manchester.MID1;
        this.data = false;
    }
    advance(event) {
        let result = false;
        let ns;
        if (event === Manchester.EVENT_RESET)
            ns = Manchester.MID1;
        else {
            ns = (Manchester.TRANSITIONS[this.state] >> event) & 0x3;
            if (ns === this.state)
                ns = Manchester.MID1;
            else if (ns === Manchester.MID0) {
                this.data = false;
                result = true;
            }
            else if (ns === Manchester.MID1) {
                this.data = true;
                result = true;
            }
        }
        this.state = ns;
        return result;
    }
}
Manchester.START1 = 0;
Manchester.MID1 = 1;
Manchester.MID0 = 2;
Manchester.START0 = 3;
Manchester.EVENT_SHORT_LOW = 0;
Manchester.EVENT_SHORT_HIGH = 2;
Manchester.EVENT_LONG_LOW = 4;
Manchester.EVENT_LONG_HIGH = 6;
Manchester.EVENT_RESET = 8;
Manchester.TRANSITIONS = [0b00000001, 0b10010001, 0b10011011, 0b11111011];
export const FG = {
    dd(x, y) { return x < y ? y - x : x - y; },
    bitRead(v, bit) { return Number((v >> BigInt(bit)) & 1n); },
    parity(key, bitCount) { let p = 0; for (let i = 0; i < bitCount; i++)
        p += FG.bitRead(key, i); return p & 1; },
    addBytes(msg, size) { let r = 0; for (let i = 0; i < size; i++)
        r += msg[i]; return r & 0xff; },
    parity8(b) { let x = b ^ (b >>> 4); x &= 0xf; return (0x6996 >>> x) & 1; },
    parityBytes(msg, size) { let r = 0; for (let i = 0; i < size; i++)
        r ^= FG.parity8(msg[i]); return r; },
    lfsrDigest8(msg, size, gen, key) {
        let sum = 0;
        for (let b = 0; b < size; b++) {
            const data = msg[b];
            for (let i = 7; i >= 0; i--) {
                if ((data >>> i) & 1)
                    sum ^= key;
                key = (key & 1) ? (key >>> 1) ^ gen : key >>> 1;
            }
        }
        return sum & 0xff;
    },
    lfsrDigest8Reflect(msg, size, gen, key) {
        let sum = 0;
        for (let b = size - 1; b >= 0; b--) {
            const data = msg[b];
            for (let i = 0; i < 8; i++) {
                if ((data >>> i) & 1)
                    sum ^= key;
                key = (key & 0x80) ? ((key << 1) ^ gen) & 0xff : (key << 1) & 0xff;
            }
        }
        return sum & 0xff;
    },
    crc4(msg, size, polynomial, init) {
        let rem = (init << 4) & 0xff;
        const poly = (polynomial << 4) & 0xff;
        for (let b = 0; b < size; b++) {
            rem ^= msg[b];
            for (let bit = 0; bit < 8; bit++)
                rem = (rem & 0x80) ? ((rem << 1) ^ poly) & 0xff : (rem << 1) & 0xff;
        }
        return (rem >>> 4) & 0x0f;
    },
    crc8(msg, size, polynomial, init) {
        let rem = init & 0xff;
        for (let b = 0; b < size; b++) {
            rem ^= msg[b];
            for (let bit = 0; bit < 8; bit++)
                rem = (rem & 0x80) ? ((rem << 1) ^ polynomial) & 0xff : (rem << 1) & 0xff;
        }
        return rem;
    },
    reverseKey(key, bitCount) { let r = 0n; for (let i = 0; i < bitCount; i++)
        r = (r << 1n) | BigInt(FG.bitRead(key, i)); return r; },
    fToC(f) { return (f - 32) / 1.8; },
    bits(v, shift, mask) { return Number((v >> BigInt(shift)) & BigInt(mask)); },
};
export class FProto {
    constructor(family, initialType) {
        this.family = family;
        this.decodeData = 0n;
        this.decodeData2 = 0n;
        this.decodeCountBit = 0;
        this.dataCountBit = 0;
        this.teLast = 0;
        this.parserStep = 0;
        this.headerCount = 0;
        this.teShort = 1 << 24;
        this.teLong = 1 << 24;
        this.teDelta = 1 << 24;
        this.minCountBitForFound = 1 << 24;
        this.callback = null;
        this.sensorType = initialType;
    }
    addBit(bit) { this.decodeData = ((this.decodeData << 1n) | BigInt(bit & 1)) & MASK64; this.decodeCountBit++; }
    hit() { this.callback?.(this); }
    dd(x, y) { return FG.dd(x, y); }
}
