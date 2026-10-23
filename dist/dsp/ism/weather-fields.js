import { FG, W } from './base.js';
const NAMES = {
    [W.NEXUS_TH]: 'Nexus-TH', [W.ACURITE_592TXR]: 'Acurite 592TXR', [W.ACURITE_606TX]: 'Acurite 606TX', [W.ACURITE_609TX]: 'Acurite 609TXC',
    [W.AMBIENT]: 'Ambient Weather', [W.AURIOL_AHFL]: 'Auriol AHFL', [W.AURIOL_TH]: 'Auriol TH', [W.GT_WT02]: 'GT-WT02', [W.GT_WT03]: 'GT-WT03',
    [W.INFACTORY]: 'inFactory', [W.LACROSSE_TX]: 'LaCrosse TX', [W.LACROSSE_TX141THBV2]: 'LaCrosse TX141TH-Bv2', [W.OREGON2]: 'Oregon v2',
    [W.OREGON2B]: 'Oregon v2 THGR122N', [W.OREGON3]: 'Oregon v3', [W.OREGON_V1]: 'Oregon v1', [W.THERMOPRO_TX4]: 'ThermoPro TX4', [W.TX_8300]: 'TX8300',
    [W.WENDOX_W6726]: 'Wendox W6726', [W.ACURITE_986]: 'Acurite 986', [W.KEDSUM]: 'Kedsum', [W.ACURITE_5IN1]: 'Acurite 5-in-1', [W.EMOS_E601X]: 'EMOS E601x',
    [W.SOLIGHT_TE44]: 'Solight TE44', [W.BRESSER_3CH]: 'Bresser 3CH', [W.BRESSER_3CH_V1]: 'Bresser 3CH v1', [W.VAUNO_EN8822]: 'Vauno EN8822',
};
export function weatherName(type) { return NAMES[type] ?? 'Unknown'; }
const b = (d, shift, mask) => FG.bits(d, shift, mask);
const bcdShort = (d) => Number(d & 0xfn) * 10 + Number((d >> 4n) & 0xfn);
function tempSign11(d, shift) {
    return b(d, shift + 11, 1) === 0 ? b(d, shift, 0x07FF) / 10 : ((Number((~(d >> BigInt(shift))) & 0x07ffn)) + 1) / -10;
}
const s12 = (v) => (v & 0x800) ? v - 0x1000 : v;
const CH_3021 = [3, 0, 2, 1];
export function parseWeather(type, d) {
    let id = 0n, ch = null, batt = null, temp = null, hum = null;
    switch (type) {
        case W.NEXUS_TH: {
            id = (d >> 28n) & 0xffn;
            batt = b(d, 27, 1) === 0;
            ch = b(d, 24, 0x03) + 1;
            temp = tempSign11(d, 12);
            const h = Number(d & 0xffn);
            hum = h > 95 ? 95 : h < 20 ? 20 : h;
            break;
        }
        case W.ACURITE_592TXR: {
            ch = CH_3021[b(d, 54, 0x03)];
            id = (d >> 40n) & 0x3fffn;
            batt = b(d, 38, 1) === 0;
            hum = b(d, 24, 0x7F);
            const u16 = b(d, 9, 0xF80) | b(d, 8, 0x7F);
            temp = (u16 - 1000) / 10;
            break;
        }
        case W.ACURITE_606TX:
            id = (d >> 24n) & 0xffn;
            batt = b(d, 23, 1) !== 0;
            temp = tempSign11(d, 8);
            break;
        case W.ACURITE_609TX: {
            id = (d >> 32n) & 0xffn;
            batt = b(d, 31, 1) !== 0;
            let i16 = (b(d, 12, 0xf000) | (Number((d >> 16n) << 4n & 0xffffn))) & 0xFFFF;
            if (i16 & 0x8000)
                i16 -= 0x10000;
            temp = (i16 >> 4) * 0.1;
            hum = b(d, 8, 0xff);
            break;
        }
        case W.AMBIENT:
            id = (d >> 32n) & 0xffn;
            batt = b(d, 31, 1) !== 0;
            ch = b(d, 28, 0x07) + 1;
            temp = FG.fToC((b(d, 16, 0x0FFF) - 400) / 10);
            hum = b(d, 8, 0xFF);
            break;
        case W.AURIOL_AHFL:
            id = d >> 34n;
            batt = b(d, 33, 1) !== 0;
            ch = b(d, 30, 0x3) + 1;
            temp = tempSign11(d, 18);
            hum = b(d, 11, 0x7F);
            break;
        case W.AURIOL_TH:
            id = (d >> 31n) & 0xffn;
            batt = b(d, 30, 1) !== 0;
            ch = b(d, 25, 0x03) + 1;
            temp = tempSign11(d, 13);
            hum = b(d, 1, 0x7F);
            break;
        case W.GT_WT02: {
            id = (d >> 29n) & 0xffn;
            batt = b(d, 28, 1) !== 0;
            ch = b(d, 25, 0x3) + 1;
            temp = tempSign11(d, 13);
            const h = b(d, 6, 0x7F);
            hum = h <= 10 ? 0 : h > 90 ? 100 : h;
            break;
        }
        case W.GT_WT03: {
            id = d >> 33n;
            const h = b(d, 25, 0xFF);
            hum = h <= 10 ? 0 : h > 95 ? 100 : h;
            batt = b(d, 24, 1) !== 0;
            ch = b(d, 21, 0x03) + 1;
            temp = tempSign11(d, 9);
            break;
        }
        case W.INFACTORY:
            id = d >> 32n;
            batt = b(d, 26, 1) !== 0;
            temp = FG.fToC((b(d, 12, 0x0FFF) - 900) / 10);
            hum = b(d, 8, 0x0F) * 10 + b(d, 4, 0x0F);
            ch = b(d, 0, 0x03);
            break;
        case W.LACROSSE_TX: {
            const u8 = b(d, 32, 0x0F);
            id = BigInt((b(d, 28, 0x0F) << 3) | (b(d, 24, 0x0F) >> 1));
            const flo = b(d, 20, 0x0F) * 10 + b(d, 16, 0x0F) + b(d, 12, 0x0F) * 0.1;
            if (u8 === 0x00)
                temp = flo - 50;
            else if (u8 === 0x0E)
                hum = Math.floor(flo);
            break;
        }
        case W.LACROSSE_TX141THBV2:
            id = d >> 32n;
            batt = b(d, 31, 1) !== 0;
            ch = b(d, 28, 0x03) + 1;
            temp = (b(d, 16, 0x0FFF) - 500) / 10;
            hum = b(d, 8, 0xFF);
            break;
        case W.OREGON2: {
            let i32 = bcdShort(d >> 4n) * 10 + b(d, 12, 0xf);
            if ((d & 0xfn) !== 0n)
                i32 = -i32;
            temp = i32 / 10;
            batt = b(d, 32, 0x4) !== 0;
            let u8 = b(d, 44, 0xF);
            let c = 1;
            while (u8 > 1) {
                c++;
                u8 >>= 1;
            }
            ch = c;
            break;
        }
        case W.OREGON2B: {
            hum = bcdShort(d);
            const u64 = d >> 8n;
            let i32 = bcdShort(u64 >> 4n) * 10 + b(u64, 12, 0xf);
            if ((u64 & 0xfn) !== 0n)
                i32 = -i32;
            temp = i32 / 10;
            batt = b(d, 32, 0x4) !== 0;
            let u8 = b(d, 44, 0xF);
            let c = 1;
            while (u8 > 1) {
                c++;
                u8 >>= 1;
            }
            ch = c;
            break;
        }
        case W.OREGON3: {
            hum = b(d, 4, 0xF) * 10 + b(d, 8, 0xF);
            let i16 = (b(d, 16, 0xF) * 10 + b(d, 20, 0xF)) * 10 + b(d, 24, 0xF);
            if (b(d, 12, 0xF) !== 0)
                i16 = -i16;
            temp = i16 / 10;
            break;
        }
        case W.OREGON_V1: {
            const u64 = FG.reverseKey(d, 32);
            id = u64 & 0xffn;
            ch = b(u64, 6, 0x03) + 1;
            let t = b(u64, 8, 0x0F) * 0.1 + b(u64, 12, 0x0F) + b(u64, 16, 0x0F) * 10;
            if (b(u64, 21, 1) !== 0)
                t = -t;
            temp = t;
            batt = b(u64, 23, 1) === 0;
            break;
        }
        case W.THERMOPRO_TX4:
            id = (d >> 25n) & 0xffn;
            batt = b(d, 24, 1) !== 0;
            ch = b(d, 21, 0x03) + 1;
            temp = tempSign11(d, 9);
            hum = b(d, 1, 0xFF);
            break;
        case W.TX_8300: {
            hum = b(d, 28, 0x0F) * 10 + b(d, 24, 0x0F);
            batt = b(d, 22, 0x03) !== 0;
            ch = b(d, 20, 0x03);
            id = (d >> 12n) & 0x7fn;
            let t = b(d, 8, 0x0F) * 10 + b(d, 4, 0x0F) + b(d, 0, 0x0F) * 0.1;
            if (b(d, 19, 1) !== 0)
                t = -t;
            temp = t;
            break;
        }
        case W.WENDOX_W6726: {
            id = (d >> 24n) & 0xffn;
            batt = b(d, 6, 1) !== 0;
            const t = b(d, 23, 1) !== 0 ? (b(d, 14, 0x1FF) + 12) / 10 : ((Number((~(d >> 14n)) & 0x1ffn)) + 1 - 12) / -10;
            temp = Math.min(70, Math.max(-50, t));
            break;
        }
        case W.ACURITE_986: {
            id = (FG.reverseKey(d >> 24n, 8) << 8n) | FG.reverseKey(d >> 16n, 8);
            batt = b(d, 14, 1) !== 0;
            ch = b(d, 15, 1) + 1;
            let i16 = Number(FG.reverseKey(d >> 32n, 8));
            if (i16 & 0x80)
                i16 = -(i16 & 0x7F);
            temp = FG.fToC(i16);
            break;
        }
        case W.KEDSUM: {
            id = d >> 32n;
            batt = b(d, 30, 0x3) === 0;
            ch = b(d, 28, 0x3) + 1;
            const u16 = (b(d, 16, 0x0f) << 8) | (b(d, 20, 0x0f) << 4) | b(d, 24, 0x0f);
            temp = FG.fToC((u16 - 900) / 10);
            hum = (b(d, 8, 0x0f) << 4) | b(d, 12, 0x0f);
            break;
        }
        case W.ACURITE_5IN1: {
            ch = CH_3021[b(d, 62, 0x03)];
            id = (d >> 48n) & 0x3fffn;
            batt = b(d, 46, 1) === 0;
            hum = b(d, 8, 0x7F);
            const u16 = b(d, 24 - 7, 0x780) | b(d, 16, 0x7F);
            temp = FG.fToC((u16 - 400) / 10);
            break;
        }
        case W.EMOS_E601X:
            id = 0xffffn;
            batt = b(d, 10, 1) !== 0;
            temp = s12(b(d, 40, 0xfff)) / 10;
            hum = b(d, 32, 0xff);
            ch = b(d, 52, 0x03);
            break;
        case W.SOLIGHT_TE44:
            id = (d >> 28n) & 0xffn;
            batt = b(d, 27, 1) === 0;
            ch = b(d, 24, 0x03) + 1;
            temp = s12(b(d, 12, 0x0fff)) / 10;
            break;
        case W.BRESSER_3CH:
            id = (d >> 28n) & 0xffn;
            ch = b(d, 27, 1) | (b(d, 26, 1) << 1);
            batt = b(d, 24, 1) !== 0;
            temp = s12(b(d, 12, 0x0fff)) / 10;
            hum = b(d, 0, 0xff);
            break;
        case W.BRESSER_3CH_V1:
            id = (d >> 32n) & 0xffn;
            batt = b(d, 31, 1) !== 0;
            ch = b(d, 28, 0x3);
            temp = FG.fToC((b(d, 16, 0xfff) - 900) / 10);
            hum = b(d, 8, 0xff);
            break;
        case W.VAUNO_EN8822:
            id = (d >> 34n) & 0xffn;
            batt = b(d, 33, 1) !== 0;
            ch = b(d, 30, 0x03);
            temp = s12(b(d, 18, 0x0fff)) / 10;
            hum = b(d, 11, 0x7f);
            break;
    }
    return { name: weatherName(type), id, channel: ch, batteryLow: batt, temp, humidity: hum };
}
