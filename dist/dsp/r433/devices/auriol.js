import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, crc16, xorBytes } from '../util.js';
const round1 = (x) => Math.round(x * 10) / 10;
const hex2 = (v) => v.toString(16).padStart(2, '0');
function signed(v, bits) {
    const shift = 32 - bits;
    return (v << shift) >> shift;
}
export const auriolAfw2a1 = register({
    num: 146,
    name: 'Auriol AFW2A1 temperature/humidity sensor',
    what: 'outdoor thermometer sold by Lidl',
    modulation: 5,
    shortWidth: 576,
    longWidth: 1536,
    gapLimit: 2012,
    resetLimit: 3954,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(12, 36);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[row];
        if ((b[3] >> 4) !== 0xa)
            return DECODE_FAIL_SANITY;
        const tempC = (signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4) * 0.1;
        const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
        if (humidity > 100 || tempC < -51.1 || tempC > 76.7)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Auriol-AFW2A1',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: b[1] >> 7,
            button: (b[1] & 0x40) >> 6,
            temperature_C: round1(tempC),
            humidity,
        });
        return 1;
    },
});
export const auriolHg02832 = register({
    num: 141,
    name: 'Auriol HG02832, HG05124A-DCF, Rubicson 48957 temperature/humidity sensor',
    what: 'outdoor thermometer',
    modulation: 6,
    shortWidth: 252,
    longWidth: 612,
    syncWidth: 860,
    gapLimit: 750,
    resetLimit: 62990,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 2)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 1 || bits.bitsPerRow[1] !== 40)
            return DECODE_ABORT_LENGTH;
        bits.invert();
        const b = bits.bb[1];
        const folded = new Uint8Array([b[0] ^ b[1] ^ b[2] ^ b[3]]);
        if ((crc8(folded, 1, 0x31, 0x53) ^ b[4]) !== 0)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Auriol-HG02832',
            id: b[0],
            channel: ((b[2] & 0x30) >> 4) + 1,
            battery_ok: (b[2] >> 7) ? 0 : 1,
            temperature_C: round1((signed(((b[2] & 0x0f) << 12) | (b[3] << 4), 16) >> 4) * 0.1),
            humidity: b[1],
            button: (b[2] & 0x40) >> 6,
            mic: 'CRC',
        });
        return 1;
    },
});
export const auriolAhfl = register({
    num: 183,
    name: 'Auriol AHFL temperature/humidity sensor',
    what: 'outdoor thermometer',
    modulation: 5,
    shortWidth: 2100,
    longWidth: 4150,
    gapLimit: 4248,
    resetLimit: 9150,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 42);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] !== 42)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[row];
        if ((b[4] & 0xf0) !== 0x40 || (b[3] & 0x01) !== 0x00)
            return DECODE_FAIL_SANITY;
        let sum = 0;
        for (let i = 0; i < 4; i++)
            sum += (b[i] & 0x0f) + (b[i] >> 4);
        sum += b[4] >> 4;
        if ((sum & 0x3f) !== (((b[4] & 0x0f) << 2) | ((b[5] & 0xc0) >> 6)))
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Auriol-AHFL',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: b[1] >> 7,
            button: (b[1] & 0x40) >> 6,
            temperature_C: round1((signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4) * 0.1),
            humidity: b[3] >> 1,
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const auriol4ld5661 = register({
    num: 200,
    name: 'Auriol 4-LD5661/4-LD5972/4-LD6313, Sempre 4-AH0423-4 temperature/rain sensor',
    what: 'rain gauge with a thermometer',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    syncWidth: 2500,
    gapLimit: 2500,
    resetLimit: 4000,
    disabled: true,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        let ret = 0;
        for (let i = 0; i < bits.numRows; i++) {
            if (bits.bitsPerRow[i] !== 52) {
                ret = DECODE_ABORT_LENGTH;
                continue;
            }
            const b = bits.bb[i];
            if (b[3] !== 0xf0 || (b[1] & 0x40) !== 0) {
                ret = DECODE_FAIL_MIC;
                continue;
            }
            const tips = (b[4] << 12) | (b[5] << 4) | (b[6] >> 4);
            ctx.emit({
                model: 'Auriol-4LD5661',
                id: b[0],
                battery_ok: b[1] >> 7,
                temperature_C: round1((signed(((b[1] & 0x0f) << 12) | (b[2] << 4), 16) >> 4) * 0.1),
                rain_mm: tips,
                rain: tips,
            });
            return 1;
        }
        return ret;
    },
});
export const govee = register({
    num: 192,
    name: 'Govee water leak detector H5054, door contact sensor B5023',
    what: 'water leak detector and door contact',
    modulation: 6,
    shortWidth: 440,
    longWidth: 940,
    gapLimit: 900,
    resetLimit: 9000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 3)
            return DECODE_ABORT_EARLY;
        const r = bits.findRepeatedRow(3, 48);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[r] > 48)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        let code = '';
        for (let i = 0; i < 6; i++)
            code += hex2(b[i]);
        bits.invert();
        const id = (b[0] << 8) | b[1];
        if (id === 0xffff || b[5] === 0)
            return DECODE_ABORT_EARLY;
        const eventType = b[2] & 0x0f;
        let event = (b[2] << 8) | b[3];
        if (event === 0xffff)
            return DECODE_ABORT_EARLY;
        const parity = (b[5] >> 1) & 0x0f;
        let chk = xorBytes(b, 5);
        chk = (chk >> 4) ^ (chk & 0x0f);
        if (chk !== parity)
            return DECODE_FAIL_MIC;
        const battery = eventType === 0xc ? b[3] : 0;
        event &= 0x0fff;
        let model = 'Govee-Water';
        let eventStr;
        let wet = -1;
        if (event === 0xafa) {
            eventStr = 'Button Press';
            wet = 0;
        }
        else if (event === 0xbfb) {
            eventStr = 'Water Leak';
            wet = 1;
        }
        else if (eventType === 0xc)
            eventStr = 'Battery Report';
        else if (event === 0xdfd)
            eventStr = 'Heartbeat';
        else if (event === 0xe7f) {
            model = 'Govee-Contact';
            eventStr = 'Open';
        }
        else
            eventStr = 'Unknown';
        const out = { model, id, event: eventStr, code, mic: 'PARITY' };
        if (battery) {
            out.battery_ok = Math.round(battery) / 100;
            out.battery_mV = 1800 + 12 * battery;
        }
        if (wet >= 0)
            out.detect_wet = wet;
        ctx.emit(out);
        return 1;
    },
});
export const goveeH5054 = register({
    num: 231,
    name: 'Govee water leak detector H5054',
    what: 'water leak detector, the later hardware',
    modulation: 6,
    shortWidth: 440,
    longWidth: 940,
    gapLimit: 900,
    resetLimit: 9000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.numRows < 3)
            return DECODE_ABORT_EARLY;
        const r = bits.findRepeatedRow(3, 48);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[r] > 48)
            return DECODE_ABORT_LENGTH;
        bits.invert();
        const b = bits.bb[r];
        let code = '';
        for (let i = 0; i < 6; i++)
            code += hex2(b[i]);
        if (crc16(b, 6, 0x1021, 0x1d0f) !== 0)
            return DECODE_FAIL_MIC;
        const event = b[2] & 0x0f;
        const eventData = b[3];
        let eventStr;
        let wet = -1, leakNum = -1, battery = -1;
        if (event === 0x0) {
            eventStr = 'Button Press';
            wet = 0;
        }
        else if (event === 0x1) {
            eventStr = 'Battery Report';
            battery = eventData;
        }
        else if (event === 0x2) {
            eventStr = 'Water Leak';
            wet = 1;
            leakNum = eventData;
        }
        else
            eventStr = 'Unknown';
        const out = {
            model: 'Govee-Water',
            id: (b[0] << 8) | b[1],
            event: eventStr,
            code,
            mic: 'CRC',
        };
        if (battery >= 0) {
            out.battery_ok = battery / 100;
            out.battery_mV = 1800 + 12 * battery;
        }
        if (wet >= 0)
            out.detect_wet = wet;
        if (leakNum >= 0)
            out.leak_num = leakNum;
        ctx.emit(out);
        return 1;
    },
});
