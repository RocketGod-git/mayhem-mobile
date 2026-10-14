import { BitBuffer } from '../bitbuffer.js';
import { DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8le, crc16 } from '../util.js';
const BAND_433 = [433920000];
const BAND_915 = [915000000];
export const oilWatchman = register({
    num: 43,
    name: 'Watchman Sonic / Apollo Ultrasonic / Beckett Rocket oil tank monitor',
    what: 'oil tank level monitor',
    modulation: 16,
    shortWidth: 1000,
    longWidth: 1000,
    resetLimit: 4000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const preamble = new Uint8Array([0xe0]);
        const postamble = new Uint8Array([0x00, 0xc0]);
        let bitpos = 0;
        let events = 0;
        while ((bitpos = bits.search(0, bitpos, preamble, 6)) + 136 <= bits.bitsPerRow[0]) {
            bitpos += 6;
            const databits = new BitBuffer();
            bitpos = bits.manchesterDecode(0, bitpos, databits, 64);
            if (databits.bitsPerRow[0] !== 64)
                continue;
            const b = databits.bb[0];
            if (bits.search(0, bitpos, postamble.subarray(b[7] & 1), 2) !== bitpos)
                continue;
            if (b[7] !== crc8le(b, 7, 0x31, 0))
                continue;
            const flags = b[4];
            const maybetemp = b[5] >> 2;
            let depth = 0;
            let bindingCountdown = 0;
            if (flags & 1)
                bindingCountdown = b[6];
            else
                depth = ((b[5] & 3) << 8) | b[6];
            ctx.emit({
                model: 'Oil-SonicSmart',
                type: 'Oil',
                id: (((b[0] << 24) >>> 0) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0,
                flags,
                maybetemp,
                temperature_C: (145.0 - 5.0 * maybetemp) / 3.0,
                binding_countdown: bindingCountdown,
                depth_cm: depth,
            });
            events++;
        }
        return events;
    },
});
function oilStandardOne(bits, ctx, row, bitpos) {
    const smartPreamble = new Uint8Array([0x55, 0x55, 0x58]);
    if (bitpos >= 24 && bits.search(row, bitpos - 24, smartPreamble, 24) === bitpos - 24)
        return 0;
    const databits = new BitBuffer();
    bits.manchesterDecode(row, bitpos, databits, 41);
    const n = databits.bitsPerRow[0];
    const b = databits.bb[0];
    if (n < 32 || n > 40 || (b[4] & 0xfe) !== 0)
        return 0;
    const flags = b[2] & 0xf5;
    const alarm = (b[2] & 0x08) >> 3;
    let depth = 0;
    let bindingCountdown = 0;
    if (flags & 1) {
        bindingCountdown = b[3];
    }
    else {
        depth = ((b[2] & 0x02) << 7) | b[3];
        if (depth > 305)
            return 0;
    }
    ctx.emit({
        model: 'Oil-SonicStd',
        type: 'Oil',
        id: (b[0] << 8) | b[1],
        flags,
        alarm,
        binding_countdown: bindingCountdown,
        depth_cm: depth,
    });
    return 1;
}
function oilStandardScan(bits, ctx) {
    let events = 0;
    for (const pattern of [new Uint8Array([0x55, 0x5d]), new Uint8Array([0x55, 0x62])]) {
        let bitpos = 0;
        while ((bitpos = bits.search(0, bitpos, pattern, 16)) + 78 <= bits.bitsPerRow[0]) {
            events += oilStandardOne(bits, ctx, 0, bitpos + 14);
            bitpos += 2;
        }
    }
    return events;
}
export const oilStandard = register({
    num: 81,
    name: 'Oil Ultrasonic STANDARD FSK',
    what: 'oil tank level monitor',
    modulation: 16,
    shortWidth: 500,
    longWidth: 500,
    resetLimit: 2000,
    bands: BAND_433,
    decode: (_dev, bits, ctx) => oilStandardScan(bits, ctx),
});
export const oilStandardAsk = register({
    num: 83,
    name: 'Oil Ultrasonic STANDARD ASK',
    what: 'oil tank level monitor',
    modulation: 4,
    shortWidth: 500,
    longWidth: 500,
    resetLimit: 2000,
    bands: BAND_915,
    decode: (_dev, bits, ctx) => oilStandardScan(bits, ctx),
});
export const oilWatchmanAdvanced = register({
    num: 234,
    name: 'Watchman Sonic Advanced / Plus, Tekelek',
    what: 'oil tank level monitor',
    modulation: 16,
    shortWidth: 500,
    longWidth: 500,
    resetLimit: 12500,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const preamble = new Uint8Array([0xaa, 0xaa, 0xaa, 0x2d, 0xd4, 0x0e]);
        let bitpos = 0;
        let events = 0;
        while ((bitpos = bits.search(0, bitpos, preamble, 48)) + 129 <= bits.bitsPerRow[0]) {
            bitpos += 40;
            const msg = bits.bytes(0, bitpos, 137);
            bitpos += 136;
            const crcCalc = crc16(msg, 15, 0x8005, 0);
            const crcRead = (msg[15] << 8) | msg[16];
            if (crcCalc !== crcRead) {
                const crcShifted = ((msg[15] << 9) | (msg[16] << 1) | (msg[17] >> 7)) & 0xffff;
                if (crcCalc !== crcShifted)
                    return DECODE_FAIL_MIC;
            }
            const mcode = (msg[1] << 8) | msg[2];
            if (mcode !== 0x0401 && mcode !== 0x0106 && mcode !== 0x0101)
                return DECODE_FAIL_SANITY;
            ctx.emit({
                model: 'Oil-SonicAdv',
                type: 'Oil',
                id: (msg[3] << 16) | (msg[4] << 8) | msg[5],
                version: `${msg[11] & 0x0f}.${msg[12] & 0x0f}.${msg[13] & 0x0f}.${msg[14] & 0x0f}`,
                temperature_C: Math.trunc((msg[7] - 0x48) / 2),
                depth_cm: ((msg[9] & 0x0f) << 8) | msg[10],
                status: msg[6],
                mic: 'CRC',
            });
            events++;
        }
        return events;
    },
});
function oilSmartOne(bits, ctx, row, bitpos) {
    const databits = new BitBuffer();
    bits.manchesterDecode(row, bitpos, databits, 64);
    if (databits.bitsPerRow[0] < 64)
        return 0;
    const b = databits.bb[0];
    if (crc8le(b, 8, 0x31, 0x00) !== 0)
        return 0;
    const tempOk = ((b[4] & 0x10) === (b[4] & 0x20)) ? 0 : 1;
    ctx.emit({
        model: 'Oil-Ultrasonic',
        type: 'Oil',
        id: (((b[0] << 24) >>> 0) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0,
        depth_cm: ((b[5] & 0x01) << 8) + b[6],
        txstatus: (b[4] & 0x40) ? 'Rapid' : 'Normal',
        temp_ok: tempOk,
        battery_ok: (b[4] & 0x04) >> 2,
        sensor: b[4] & 0x03,
        counter: (b[5] & 0xf0) >> 4,
        unknown: (b[5] & 0x0d) >> 1,
        mic: 'CRC',
    });
    return 1;
}
export const oilSmart = register({
    num: 235,
    name: 'Oil Ultrasonic SMART FSK',
    what: 'oil tank level monitor',
    modulation: 16,
    shortWidth: 500,
    longWidth: 500,
    gapLimit: 2000,
    resetLimit: 9000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const preamble = new Uint8Array([0x55, 0x58]);
        let bitpos = 0;
        let events = 0;
        while ((bitpos = bits.search(0, bitpos, preamble, 16)) + 128 <= bits.bitsPerRow[0]) {
            events += oilSmartOne(bits, ctx, 0, bitpos + 16);
            bitpos += 2;
        }
        return events;
    },
});
