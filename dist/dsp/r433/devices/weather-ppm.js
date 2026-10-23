import { BITBUF_COLS } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc4, crc8 } from '../util.js';
function signed(v, bits) {
    const shift = 32 - bits;
    return (v << shift) >> shift;
}
export const nexus = register({
    num: 19,
    name: 'Nexus, FreeTec NC-7345, NX-3980, Solight TE82S, TFA 30.3209 temperature/humidity sensor',
    what: 'outdoor thermometer, often bundled with a kitchen display',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3000,
    resetLimit: 5000,
    priority: 10,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 36);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[r];
        if (bits.bitsPerRow[r] > 37)
            return DECODE_ABORT_LENGTH;
        if ((b[3] & 0xf0) !== 0xf0)
            return DECODE_ABORT_EARLY;
        if ((b[0] === 0 && b[2] === 0 && b[3] === 0)
            || (b[0] === 0xff && b[2] === 0xff && b[3] === 0xff))
            return DECODE_ABORT_EARLY;
        if ((b[1] & 0x30) === 0x30)
            return DECODE_ABORT_EARLY;
        const crcIn = new Uint8Array([b[0], b[1], b[2], b[3] & 0xf0, ((b[3] & 0x0f) << 4) | ((b[4] & 0xf0) >> 4)]);
        if (crc8(crcIn, 5, 0x31, 0x6c) === 0)
            return DECODE_FAIL_SANITY;
        const id = b[0];
        const battery = b[1] & 0x80;
        const test = b[1] & 0x40;
        const channel = ((b[1] & 0x30) >> 4) + 1;
        const tempRaw = signed((b[1] << 12) | (b[2] << 4), 16);
        const tempC = (tempRaw >> 4) * 0.1;
        const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
        if (humidity !== 0 && humidity > 100)
            return DECODE_FAIL_SANITY;
        const out = {
            model: humidity === 0 ? 'Nexus-T' : 'Nexus-TH',
            id, channel,
            battery_ok: battery ? 1 : 0,
            temperature_C: Math.round(tempC * 100) / 100,
        };
        if (humidity !== 0)
            out.humidity = humidity;
        if (test)
            out.test = 1;
        ctx.emit(out);
        return 1;
    },
});
export const nexusSauna = register({
    num: 279,
    name: 'Nexus, CRX, Prego sauna temperature sensor',
    what: 'sauna probe, reads far above room temperature',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3000,
    resetLimit: 5000,
    priority: 10,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 36);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[r];
        if (bits.bitsPerRow[r] > 37)
            return DECODE_ABORT_LENGTH;
        if ((b[1] & 0x0f) !== 0x0f)
            return DECODE_ABORT_EARLY;
        if (b[0] === 0 || (b[4] & 0x10) !== 0x10
            || (b[0] === 0xff && b[2] === 0xff && b[3] === 0xff))
            return DECODE_ABORT_EARLY;
        if ((b[1] & 0x30) !== 0x30)
            return DECODE_ABORT_EARLY;
        const test = b[1] & 0x40;
        const out = {
            model: 'Nexus-Sauna',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (b[1] & 0x80) ? 1 : 0,
            temperature_C: Math.round(signed((b[2] << 8) | b[3], 16) * 10) / 100,
        };
        if (test)
            out.test = 1;
        ctx.emit(out);
        return 1;
    },
});
export const prologue = register({
    num: 3,
    name: 'Prologue, FreeTec NC-7104, NC-7159-675 temperature sensor',
    what: 'outdoor thermometer, sometimes with humidity',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 7000,
    resetLimit: 10000,
    priority: 10,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] <= 8 && bits.bitsPerRow[0] !== 0)
            return DECODE_ABORT_EARLY;
        const r = bits.findRepeatedRow(4, 36);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[r] > 37)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        if ((b[0] & 0xf0) !== 0x90 && (b[0] & 0xf0) !== 0x50)
            return DECODE_FAIL_SANITY;
        const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4);
        const out = {
            model: 'Prologue-TH',
            subtype: b[0] >> 4,
            id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
            channel: (b[1] & 0x03) + 1,
            battery_ok: (b[1] & 0x08) ? 1 : 0,
            temperature_C: Math.round((signed((b[2] << 8) | (b[3] & 0xf0), 16) >> 4) * 10) / 100,
            button: (b[1] & 0x04) >> 2,
        };
        if (humidity !== 0xcc)
            out.humidity = humidity;
        ctx.emit(out);
        return 1;
    },
});
export const rubicson = register({
    num: 2,
    name: 'Rubicson, TFA 30.3197 or InFactory PT-310 temperature sensor',
    what: 'outdoor or pool thermometer',
    modulation: 5,
    shortWidth: 1000,
    longWidth: 2000,
    gapLimit: 3000,
    resetLimit: 4800,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(3, 36);
        if (r < 0)
            return DECODE_ABORT_EARLY;
        const b = bits.bb[r];
        if (bits.bitsPerRow[r] < 36 || bits.bitsPerRow[r] > 38)
            return DECODE_ABORT_LENGTH;
        if ((b[3] & 0xf0) !== 0xf0)
            return DECODE_ABORT_EARLY;
        const tmp = new Uint8Array([b[0], b[1], b[2], b[3] & 0xf0, ((b[3] & 0x0f) << 4) | ((b[4] & 0xf0) >> 4)]);
        if (crc8(tmp, 5, 0x31, 0x6c) !== 0)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'Rubicson-Temperature',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (b[1] & 0x80) ? 1 : 0,
            temperature_C: Math.round((signed((b[1] << 12) | (b[2] << 4), 16) >> 4) * 10) / 100,
            mic: 'CRC',
        });
        return 1;
    },
});
export const genericTemperature = register({
    num: 38,
    name: 'Generic temperature sensor 1',
    what: 'unbranded thermometer',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 4800,
    resetLimit: 10000,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        for (let i = 1; i < 10; i++)
            if (bits.bitsPerRow[i] !== 24)
                return DECODE_ABORT_LENGTH;
        const b = bits.bb[1];
        if ((b[0] === 0 && b[1] === 0 && b[2] === 0)
            || (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff))
            return DECODE_ABORT_EARLY;
        ctx.emit({
            model: 'Generic-Temperature',
            id: b[0],
            battery_ok: (b[1] & 0xc0) >> 6,
            temperature_C: Math.round((signed(((b[1] & 0x3f) << 10) | (b[2] << 2), 16) >> 4) * 10) / 100,
        });
        return 1;
    },
});
export const s3318p = register({
    num: 47,
    name: 'Conrad S3318P, FreeTec NC-5849-913 temperature humidity sensor, ORIA WA50 ST389 temperature sensor',
    what: 'outdoor temperature and humidity sensor',
    modulation: 5,
    shortWidth: 1900,
    longWidth: 3800,
    gapLimit: 4400,
    resetLimit: 9400,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] === 0 && bits.bitsPerRow[1] === 0)
            return DECODE_ABORT_EARLY;
        const r = bits.findRepeatedRow(4, 42);
        if (r < 0 || bits.bitsPerRow[r] !== 42)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(r, 2, 40);
        if (!b[0] && !b[1] && !b[2] && !b[3])
            return DECODE_FAIL_SANITY;
        if ((crc4(b, 4, 0x3, 0x0) ^ (b[4] >> 4)) !== (b[4] & 0x0f))
            return DECODE_FAIL_MIC;
        const humidity = ((b[3] & 0x0f) << 4) | ((b[3] & 0xf0) >> 4);
        const tempRaw = ((b[2] & 0x0f) << 8) | (b[2] & 0xf0) | (b[1] & 0x0f);
        const out = {
            model: 'Conrad-S3318P',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (b[4] & 0x40) ? 0 : 1,
            temperature_F: Math.round((tempRaw - 900) * 10) / 100,
            button: b[4] >> 7,
            mic: 'CRC',
        };
        if (humidity !== 0)
            out.humidity = humidity;
        ctx.emit(out);
        return 1;
    },
});
export const esperanzaEws = register({
    num: 35,
    name: 'Esperanza EWS',
    what: 'outdoor temperature and humidity sensor',
    modulation: 5,
    shortWidth: 2000,
    longWidth: 4000,
    gapLimit: 4400,
    resetLimit: 9400,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 0 || bits.bitsPerRow[1] !== 0)
            return DECODE_FAIL_SANITY;
        if (bits.numRows !== 14)
            return DECODE_ABORT_LENGTH;
        for (let row = 2; row < bits.numRows - 3; row += 2) {
            if (bits.bitsPerRow[row] !== 42)
                return DECODE_FAIL_SANITY;
            const a = bits.bb[row], c = bits.bb[row + 2];
            for (let i = 0; i < BITBUF_COLS; i++)
                if (a[i] !== c[i])
                    return DECODE_FAIL_SANITY;
        }
        const b = bits.bytes(2, 2, 40);
        if ((crc4(b, 4, 0x3, 0x0) ^ (b[4] >> 4)) !== (b[4] & 0x0f))
            return DECODE_FAIL_MIC;
        const tempRaw = ((b[2] & 0x0f) << 8) | (b[2] & 0xf0) | (b[1] & 0x0f);
        ctx.emit({
            model: 'Esperanza-EWS',
            id: b[0],
            channel: ((b[1] & 0x30) >> 4) + 1,
            battery_ok: (b[4] & 0x40) === 0x40 ? 0 : 1,
            temperature_F: Math.round((tempRaw - 900) * 10) / 100,
            humidity: ((b[3] & 0x0f) << 4) | ((b[3] & 0xf0) >> 4),
            mic: 'CRC',
        });
        return 1;
    },
});
