import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, addNibbles, crc4, parity8 } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
export const wec2103 = register({
    num: 229,
    name: 'WEC-2103 temperature/humidity sensor',
    what: 'thermometer and hygrometer',
    modulation: 5,
    shortWidth: 1900,
    longWidth: 3800,
    gapLimit: 4400,
    resetLimit: 9400,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 6 || bits.bitsPerRow[2] !== 42)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(3, 0, 40);
        const crcReceived = b[1] >> 4;
        b[1] = (b[1] & 0x0f) | ((b[4] & 0x0f) << 4);
        const crcCalculated = crc4(b, 4, 3, 0) ^ (b[4] >> 4);
        if (crcCalculated !== crcReceived)
            return DECODE_FAIL_MIC;
        const tempRaw = (b[2] << 4) | ((b[3] & 0xf0) >> 4);
        ctx.emit({
            model: 'WEC-2103',
            type: 'Weather',
            id: b[0],
            channel: b[4] & 0x0f,
            battery_ok: ((b[1] & 0x04) >> 3) ? 0 : 1,
            button: (b[1] & 0x08) >> 3,
            temperature_F: round2((tempRaw - 900) * 0.1),
            humidity: (b[3] & 0x0f) * 10 + ((b[4] & 0xf0) >> 4),
            flags: b[1] & 0x0f,
            mic: 'CRC',
        });
        return 1;
    },
});
const HOMELEAD_LUX = [60, 200, 400, 600, 1000, 1500, 2800, 4500, 10000, -1, -1, -1, -1, -1, -1, -1];
export const homeleadHg9901 = register({
    num: 280,
    name: 'Homelead HG9901 (Geevon, Dr.Meter, Royal Gardineer) soil moisture/temp/light level sensor',
    what: 'soil moisture, temperature and light sensor',
    modulation: 6,
    shortWidth: 432,
    longWidth: 1228,
    gapLimit: 2000,
    resetLimit: 4500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(1, 65);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const rowLen = bits.bitsPerRow[row];
        if (rowLen > 65 + 8)
            return DECODE_ABORT_EARLY;
        const pos = bits.search(row, 0, new Uint8Array([0x55, 0xaa]), 16);
        if (pos + 65 > rowLen)
            return DECODE_ABORT_LENGTH;
        bits.invert();
        const b = bits.bb[row];
        if ((addNibbles(b, 7) & 0x0f) !== ((b[7] & 0xf0) >> 4))
            return DECODE_FAIL_MIC;
        const temperature = (b[5] & 0x80) ? -(b[5] & 0x7f) : (b[5] & 0x7f);
        const battery = (b[6] & 0x30) >> 4;
        const light = b[6] & 0x0f;
        ctx.emit({
            model: 'Homelead-HG9901',
            type: 'Weather',
            id: ((b[2] << 8) | b[3]).toString(16).padStart(4, '0').toUpperCase(),
            battery_ok: battery > 1 ? 1 : 0,
            battery_pct: Math.trunc(100 * battery / 3),
            temperature_C: temperature,
            moisture: b[4],
            light_lvl: light,
            light_lux: HOMELEAD_LUX[light],
            sequence: (b[6] & 0xc0) >> 6,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const wallargeCltx001 = register({
    num: 292,
    name: 'WallarGe CLTX001 Outdoor Temperature Sensor',
    what: 'thermometer',
    modulation: 6,
    shortWidth: 250,
    longWidth: 500,
    tolerance: 75,
    gapLimit: 650,
    resetLimit: 1250,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        let result = DECODE_ABORT_LENGTH;
        for (let row = 0; row < bits.numRows; row++) {
            if (bits.bitsPerRow[row] !== 56)
                continue;
            const b = bits.bb[row];
            for (let i = 0; i < 7; i++)
                b[i] = (~b[i]) & 0xff;
            if (b[6] !== (addBytes(b, 5) & 0xff)) {
                result = DECODE_FAIL_MIC;
                continue;
            }
            const parityByte = b[5];
            let parityValid = true;
            if (parityByte & 0x07) {
                parityValid = false;
            }
            else {
                for (let i = 0; i < 5; i++) {
                    if (parity8(b[i]) === ((parityByte >> (7 - i)) & 1)) {
                        parityValid = false;
                        break;
                    }
                }
            }
            if (!parityValid) {
                result = DECODE_FAIL_MIC;
                continue;
            }
            const batteryLow = (b[3] & 0x80) >> 7;
            const testMode = (b[3] & 0x40) >> 6;
            const tempRaw = ((((b[3] & 0x0f) << 12) | (b[4] << 4)) << 16) >> 16;
            const out = {
                model: 'WallarGe-CLTX001',
                type: 'Weather',
                id: (b[0] << 8) | b[1],
                channel: ((b[3] & 0x30) >> 4) + 1,
                temperature_C: round1((tempRaw >> 4) * 0.1),
                mic: 'CHECKSUM',
            };
            if (batteryLow)
                out.battery_ok = 0;
            if (testMode)
                out.test = testMode;
            ctx.emit(out);
            result = 1;
            break;
        }
        return result;
    },
});
export const esunEn2053 = register({
    num: 341,
    name: 'Esun EN2053 two-channel BBQ thermometer',
    what: 'barbecue thermometer',
    modulation: 5,
    shortWidth: 1024,
    longWidth: 2000,
    gapLimit: 3000,
    resetLimit: 7500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 40);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 40)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if (b[0] !== 0xc0)
            return DECODE_FAIL_SANITY;
        let chk = (b[0] + b[1] + b[2] + b[3]) & 0x07;
        for (let i = 0; i < 4; i++)
            chk |= (1 ^ parity8(b[i])) << (4 + i);
        if (chk !== b[4])
            return DECODE_FAIL_MIC;
        const temp1 = (b[1] << 4) | (b[2] >> 4);
        const temp2 = ((b[2] & 0x0f) << 8) | b[3];
        const out = { model: 'Esun-EN2053', type: 'Weather', mic: 'CHECKSUM' };
        if (temp1 !== 0xfd6)
            out.temperature_1_F = temp1;
        if (temp2 !== 0xfd6)
            out.temperature_2_F = temp2;
        ctx.emit(out);
        return 1;
    },
});
export const en2058 = register({
    num: 346,
    name: 'EN2058 four probe temperature sensor',
    what: 'barbecue thermometer',
    modulation: 16,
    shortWidth: 100,
    longWidth: 100,
    resetLimit: 4000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1 || bits.bitsPerRow[0] < 174)
            return DECODE_ABORT_LENGTH;
        const preamble = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
        let offset = 0;
        for (let i = 0; i < 9; i++) {
            offset = bits.search(0, offset, preamble, 30);
            if (offset >= bits.bitsPerRow[0])
                return DECODE_ABORT_EARLY;
            offset += 30;
            const idBytes = bits.bytes(0, offset + 56, 24);
            const dataBytes = bits.bytes(0, offset + 80, 80);
            const checksum = (0x56 + addBytes(idBytes, 3) + addBytes(dataBytes, 8)) & 0xff;
            if (checksum !== dataBytes[9])
                continue;
            const probe = (n) => round1((((dataBytes[n * 2] << 8) | dataBytes[n * 2 + 1]) - 900) / 10);
            const out = {
                model: 'EN2058',
                type: 'Weather',
                id: (idBytes[0] << 16) | (idBytes[1] << 8) | idBytes[2],
                temperature1_F: probe(0),
                temperature2_F: probe(1),
                temperature3_F: probe(2),
                temperature4_F: probe(3),
                mic: 'CHECKSUM',
            };
            if (offset + 320 <= bits.bitsPerRow[0])
                out.sequence = bits.bytes(0, offset + 304, 16)[0];
            ctx.emit(out);
            return 1;
        }
        return DECODE_FAIL_MIC;
    },
});
