import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addBytes, crc8, crc16, parity8 } from '../util.js';
const BAND_433 = [433920000];
const BAND_868 = [868300000];
const BAND_868_95 = [868950000];
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');
const int16 = (x) => (x << 16) >> 16;
const int8 = (x) => (x << 24) >> 24;
function adPop(bb, n, bit) {
    let val = 0;
    for (let i = 0; i < n; i++) {
        const byteNo = (bit + i) >> 3;
        const bitNo = 7 - ((bit + i) % 8);
        if (bb[byteNo] & (1 << bitNo))
            val |= 1 << i;
    }
    return val;
}
export const elvEm1000 = register({
    num: 6,
    name: 'ELV EM 1000',
    what: 'energy meter',
    modulation: 5,
    shortWidth: 500,
    longWidth: 1000,
    gapLimit: 7250,
    resetLimit: 30000,
    disabled: true,
    bands: BAND_868,
    decode(_dev, bits, ctx) {
        const voted = new Uint8Array(14);
        for (let i = 0; i < 14; i++) {
            const r0 = bits.bb[0][i], r1 = bits.bb[1][i], r2 = bits.bb[2][i];
            if (r0 === r1 || r0 === r2)
                voted[i] = r0;
            else if (r1 === r2)
                voted[i] = r1;
            else
                return DECODE_ABORT_EARLY;
        }
        let bit = 18;
        const dec = new Uint8Array(10);
        let checksum = 0;
        for (let i = 0; i < 9; i++) {
            dec[i] = adPop(voted, 8, bit);
            bit += 8;
            const stopbit = adPop(voted, 1, bit);
            bit += 1;
            if (!stopbit)
                return DECODE_ABORT_EARLY;
            checksum ^= dec[i];
        }
        if (adPop(voted, 8, bit) !== checksum)
            return DECODE_FAIL_MIC;
        ctx.emit({
            model: 'ELV-EM1000',
            type: 'Energy',
            id: dec[1],
            seq: dec[2],
            total: dec[3] | (dec[4] << 8),
            current: dec[5] | (dec[6] << 8),
            peak: dec[7] | (dec[8] << 8),
        });
        return 1;
    },
});
const WS2000_TYPES = [
    '!AS3',
    'AS2000/ASH2000/S2000/S2001A/S2001IA/ASH2200/S300IA',
    '!S2000R',
    '!S2000W',
    'S2001I/S2001ID',
    '!S2500H',
    '!Pyrano',
    'KS200/KS300',
];
const WS2000_LENGTHS = [5, 8, 5, 8, 12, 9, 8, 14, 8, 0, 0, 0, 0, 0, 0, 0];
export const elvWs2000 = register({
    num: 7,
    name: 'ELV WS 2000',
    what: 'weather station receiver',
    modulation: 6,
    shortWidth: 366,
    longWidth: 854,
    resetLimit: 1000,
    disabled: true,
    bands: BAND_868,
    decode(_dev, bits, ctx) {
        const row = bits.bb[0];
        const dec = new Uint8Array(16);
        let bit = 11;
        let check = 0, sum = 0;
        dec[0] = adPop(row, 4, bit);
        bit += 4;
        const firstStop = adPop(row, 1, bit);
        bit += 1;
        if (!firstStop)
            return DECODE_ABORT_EARLY;
        check ^= dec[0];
        sum += dec[0];
        for (let i = 1; i <= WS2000_LENGTHS[dec[0]]; i++) {
            dec[i] = adPop(row, 4, bit);
            bit += 4;
            const stopbit = adPop(row, 1, bit);
            bit += 1;
            if (!stopbit)
                return DECODE_ABORT_EARLY;
            check ^= dec[i];
            sum += dec[i];
        }
        if (check)
            return DECODE_FAIL_MIC;
        if (adPop(row, 4, bit) !== ((sum + 5) & 0x0f))
            return DECODE_FAIL_MIC;
        const subtype = dec[0] <= 7 ? WS2000_TYPES[dec[0]] : '?';
        const code = dec[1] & 7;
        const temp = ((dec[1] & 8) ? -1 : 1) * (dec[4] * 10 + dec[3] + dec[2] * 0.1);
        let humidity = dec[7] * 10 + dec[6] + dec[5] * 0.1;
        const pressure = dec[0] === 4 ? 200 + dec[10] * 100 + dec[9] * 10 + dec[8] : 0;
        const out = {
            model: 'ELV-WS2000',
            type: 'Weather',
            subtype,
            id: code,
            temperature_C: round1(temp),
        };
        if (dec[0] === 7) {
            humidity = dec[6] * 10 + dec[5];
            out.humidity = round1(humidity);
            out.wind_avg_km_h = round1(dec[9] * 10 + dec[8] + dec[7] * 0.1);
            const rainsum = (dec[12] << 8) + (dec[11] << 4) + dec[10];
            out.rain_count = rainsum;
            out.rain_mm = round1(rainsum * 0.295);
            out.is_raining = (dec[1] & 2) ? 1 : 0;
            out.unknown = dec[13];
        }
        else {
            out.humidity = round1(humidity);
        }
        if (pressure)
            out.pressure_hPa = pressure;
        ctx.emit(out);
        return 1;
    },
});
const TBH_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);
const TBH_INFO = new Uint8Array([
    0x19, 0xf8, 0x28, 0x30, 0x6d, 0x0c, 0x94, 0x54,
    0x22, 0xf2, 0x37, 0xc9, 0x66, 0xa3, 0x97, 0x57,
]);
export const archosTbh = register({
    num: 144,
    name: 'TBH weather sensor',
    what: 'weather and power sensor',
    modulation: 16,
    shortWidth: 212,
    longWidth: 212,
    resetLimit: 3000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const startPos = bits.search(0, 0, TBH_PREAMBLE, 48);
        if (startPos === bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] < 12 * 8)
            return DECODE_ABORT_LENGTH;
        const len = bits.bytes(0, startPos + 48, 8)[0];
        if (len > 60)
            return DECODE_ABORT_LENGTH;
        const frame = new Uint8Array(63);
        frame[0] = len;
        frame.set(bits.bytes(0, startPos + 56, (len + 2) * 8).subarray(0, len + 2), 1);
        if (crc16(frame, len + 1, 0x8005, 0xffff) !== ((frame[len + 1] << 8) | frame[len + 2])) {
            return DECODE_FAIL_MIC;
        }
        const payload = new Uint8Array(62);
        payload[0] = frame[1] ^ TBH_INFO[0];
        for (let i = 1; i < len; i++)
            payload[i] = frame[i] ^ frame[i + 1] ^ TBH_INFO[i % TBH_INFO.length];
        const type = payload[4];
        const id = ((payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0);
        if (type === 1) {
            payload[4] = len - 4;
            if (crc8(payload, len - 5, 0x07, 0x00, 4) !== payload[len - 1])
                return DECODE_FAIL_MIC;
            ctx.emit({
                model: 'Archos-TBH',
                type: 'Energy',
                id,
                power_idx: (payload[6] << 16) | (payload[7] << 8) | payload[8],
                power_max: (payload[12] << 8) | payload[13],
                timestamp: ((payload[9] << 16) | (payload[10] << 8) | payload[11]) >> 3,
                mic: 'CRC',
            });
            return 1;
        }
        if (type === 2) {
            const tempRaw = ((payload[6] << 8) | payload[5]) - 2732;
            ctx.emit({
                model: 'Archos-TBH',
                type: 'Weather',
                id,
                temperature_C: round1(tempRaw * 0.1),
                humidity: payload[7],
                mic: 'CRC',
            });
            return 1;
        }
        if (type === 3) {
            ctx.emit({ model: 'Archos-TBH', type: 'Weather', id, battery_ok: round2(payload[5] * 0.01), mic: 'CRC' });
            return 1;
        }
        if (type === 4) {
            ctx.emit({ model: 'Archos-TBH', type: 'Weather', id, battery_ok: 0, mic: 'CRC' });
            return 1;
        }
        return DECODE_FAIL_SANITY;
    },
});
const EMAX_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0xca, 0xca, 0x54]);
const EMAX_MESSAGE_BITLEN = 264;
export const emax = register({
    num: 215,
    name: 'Emax W6, rebranded as Altronics x7063/4/x7064A, Optex 990040/50/51, Orium 13093/13123, '
        + 'Infactory FWS-1200, Newentor Q9, Otio 810025, Protmex PT3390A, Jula Marquant 014331/32, '
        + 'TechniSat IMETEO X6, weather station or temperature/humidity sensor',
    what: 'weather station',
    modulation: 16,
    shortWidth: 90,
    longWidth: 90,
    resetLimit: 9000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const rowBits = bits.bitsPerRow[0];
        let ret = 0;
        let pos = 0;
        for (;;) {
            pos = bits.search(0, pos, EMAX_PREAMBLE, 40);
            if (pos + EMAX_MESSAGE_BITLEN > rowBits)
                break;
            pos += 40;
            if (pos + 32 * 8 > rowBits) {
                ret = DECODE_ABORT_LENGTH;
                continue;
            }
            const b = bits.bytes(0, pos, 32 * 8);
            const kind = (b[1] & 0xf0) >> 4;
            const subtype = b[3] & 0x03;
            let checksum = addBytes(b, 31);
            if (kind !== 0 && subtype === 0x3)
                checksum -= 0x9a;
            if ((checksum & 0xff) !== b[31]) {
                ret = DECODE_FAIL_MIC;
                continue;
            }
            const channel = b[1] & 0x0f;
            const id = (b[2] << 4) | (b[3] >> 4);
            const batteryLow = b[3] & 0x08;
            const pairing = b[3] & 0x04;
            if (kind !== 0) {
                const tempRaw = ((b[4] & 0x0f) << 8) | (b[5] & 0xf0) | (b[6] & 0x0f);
                const out = {
                    model: subtype === 0x1 ? 'Altronics-X7064' : subtype === 0x3 ? 'Altronics-X7064A' : 'Emax-unknown',
                    type: 'Weather',
                    id,
                    channel,
                    battery_ok: batteryLow ? 0 : 1,
                };
                if (subtype === 0x1)
                    out.temperature_F = round1((tempRaw - 900) * 0.1);
                if (subtype === 0x3)
                    out.temperature_C = round1((tempRaw - 500) * 0.1);
                out.humidity = b[7];
                if (pairing)
                    out.pairing = 1;
                out.mic = 'CHECKSUM';
                ctx.emit(out);
                return 1;
            }
            const tempRaw = ((b[4] & 0x0f) << 8) | b[5];
            const tempF = round1((tempRaw - 900) * 0.1);
            const humidity = b[6];
            const windRaw = (((b[7] - 1) & 0xff) << 8) | ((b[8] - 1) & 0xff);
            const speedKmh = round1(windRaw * 0.2);
            const directionDeg = (((b[9] - 1) & 0x0f) << 8) | ((b[10] - 1) & 0xff);
            const rainRaw = (((b[11] - 1) & 0xff) << 8) | ((b[12] - 1) & 0xff);
            const rainMm = round1(rainRaw * 0.2);
            const base = {
                model: '',
                type: 'Weather',
                id,
                channel,
                battery_ok: batteryLow ? 0 : 1,
            };
            const lux = () => {
                const lux14 = (b[14] - 1) & 0xff;
                const lux15 = (b[15] - 1) & 0xff;
                const value = ((lux14 & 0x7f) << 8) | lux15;
                return (lux14 & 0x80) ? value * 10 : value;
            };
            if (b[29] === 0x17) {
                const tag = ((b[13] - 1) & 0xc0) >> 6;
                const out = {
                    ...base,
                    model: tag !== 3 ? 'Emax-W6' : 'IMETEO-X6',
                    temperature_F: tempF,
                    humidity,
                    wind_avg_km_h: speedKmh,
                    wind_dir_deg: directionDeg,
                    rain_mm: rainMm,
                };
                if (tag !== 3) {
                    out.uvi = (b[13] - 1) & 0x1f;
                    out.light_lux = lux();
                }
                if (pairing)
                    out.pairing = 1;
                out.mic = 'CHECKSUM';
                ctx.emit(out);
                return 1;
            }
            if (b[29] === 0x16 && b[14] === 0x01 && b[15] === 0x01) {
                const out = {
                    ...base,
                    model: 'Emax-EM3551H',
                    temperature_F: tempF,
                    humidity,
                    wind_avg_km_h: speedKmh,
                    wind_max_km_h: round1(b[16] / 1.5),
                    wind_dir_deg: directionDeg,
                    rain_mm: rainMm,
                };
                if (pairing)
                    out.pairing = 1;
                out.mic = 'CHECKSUM';
                ctx.emit(out);
                return 1;
            }
            if (b[29] === 0x16) {
                const out = {
                    ...base,
                    model: 'Lacrosse-WS6262',
                    temperature_C: round1((tempRaw - 500) * 0.1),
                    humidity,
                    wind_avg_km_h: speedKmh,
                    wind_max_km_h: round1(b[16] / 1.5),
                    wind_dir_deg: directionDeg,
                    rain_mm: rainMm,
                    uvi: (b[13] - 1) & 0x1f,
                    light_lux: lux(),
                };
                if (pairing)
                    out.pairing = 1;
                out.mic = 'CHECKSUM';
                ctx.emit(out);
                return 1;
            }
            pos += EMAX_MESSAGE_BITLEN;
        }
        return ret;
    },
});
const NETATMO_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0xe7, 0x12]);
export const netatmoThw = register({
    num: 336,
    name: 'NetAtmo temperature/humidity and wind sensors',
    what: 'weather station outdoor modules',
    modulation: 16,
    shortWidth: 8.5,
    longWidth: 8.5,
    resetLimit: 800,
    bands: BAND_868_95,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const startPos = bits.search(0, 0, NETATMO_PREAMBLE, 32);
        if (startPos === bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const len = bits.bytes(0, startPos + 32, 8)[0];
        const b = new Uint8Array(256 + 2 + 1);
        b[0] = len;
        b.set(bits.bytes(0, startPos + 40, (len + 2) * 8).subarray(0, len + 2), 1);
        if (crc16(b, len + 1, 0x8005, 0xffff) !== ((b[len + 1] << 8) | b[len + 2]))
            return DECODE_FAIL_MIC;
        const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
        const signal = int8(b[6]);
        if (len === 6) {
            ctx.emit({ model: 'NetAtmo-TH', type: 'Weather', id, signal_dB: signal, mic: 'CRC' });
            return 1;
        }
        if (len === 0x19) {
            ctx.emit({
                model: 'NetAtmo-TH',
                type: 'Weather',
                id,
                battery_mV: (b[8] * 256 + b[7]) * 2,
                signal_dB: signal,
                temperature_C: round1(int16((b[23] << 8) | b[22]) * 0.1),
                humidity: b[25],
                mic: 'CRC',
            });
            return 1;
        }
        if (len === 0x31) {
            const rawA315 = int16((b[26] << 8) | b[25]);
            const rawB315 = int16((b[28] << 8) | b[27]);
            const rawC045 = int16((b[30] << 8) | b[29]);
            const rawD045 = int16((b[32] << 8) | b[31]);
            const ws315 = rawA315 + rawB315;
            const ws45 = rawC045 + rawD045;
            ctx.emit({
                model: 'NetAtmo-Wind',
                type: 'Weather',
                id,
                battery_mV: b[8] * 256 + b[7],
                signal_dB: signal,
                raw_a_315: rawA315,
                raw_b_315: rawB315,
                raw_c_045: rawC045,
                raw_d_045: rawD045,
                wind_spd_km_h: round1(Math.sqrt(ws45 * ws45 + ws315 * ws315) * 0.05),
                wind_dir_deg: Math.trunc(Math.atan2(ws45, ws315) / Math.PI * 180 + 315) % 360,
                mic: 'CRC',
            });
            return 1;
        }
        ctx.emit({ model: 'NetAtmo-THW', type: 'Weather', id, signal_dB: signal, mic: 'CRC' });
        return 1;
    },
});
const OMNI_INITCRC = 0xaa;
export const omni = register({
    num: 337,
    name: 'Omni Multisensor',
    what: 'multisensor',
    modulation: 6,
    shortWidth: 200,
    longWidth: 400,
    syncWidth: 600,
    gapLimit: 500,
    resetLimit: 1250,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const r = bits.findRepeatedRow(2, 80);
        if (r < 0 || bits.bitsPerRow[r] > 82)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[r];
        if (crc8(b, 9, 0x97, OMNI_INITCRC) !== b[9])
            return DECODE_FAIL_MIC;
        const messageFmt = b[0] >> 4;
        const id = b[0] & 0x0f;
        let payload = '';
        for (let i = 1; i < 9; i++)
            payload += hex2(b[i]);
        const itempC = round2((int16((b[1] << 8) | b[2]) >> 4) * 0.1);
        const volts = round2(b[8] * 0.01 + 3.0);
        if (messageFmt === 0) {
            ctx.emit({
                model: 'Omni-Multisensor',
                type: 'Weather',
                id,
                channel: messageFmt,
                temperature_C: itempC,
                voltage_V: volts,
                payload,
                mic: 'CRC',
            });
            return 1;
        }
        if (messageFmt === 1) {
            ctx.emit({
                model: 'Omni-Multisensor',
                type: 'Weather',
                id,
                channel: messageFmt,
                temperature_C: itempC,
                temperature_2_C: round2((int16((b[2] << 12) | (b[3] << 4)) >> 4) * 0.1),
                humidity: b[4],
                light_pct: b[5],
                pressure_hPa: round1(((b[6] << 8) | b[7]) * 0.1),
                voltage_V: volts,
                mic: 'CRC',
            });
            return 1;
        }
        ctx.emit({ model: 'Omni-Multisensor', type: 'Weather', id, channel: messageFmt, payload, mic: 'CRC' });
        return 1;
    },
});
function elsnerSpread(x, k) {
    let v = (x << k) & 0xff;
    if (x & 1)
        v |= ((1 << k) - 1) & 0xff;
    return v;
}
function elsnerStep(prev, base, oldBit, newBit) {
    return (elsnerSpread(prev, 1) + base + newBit - oldBit) & 0xff;
}
function elsnerDescramble(input, nbytes) {
    const out = new Uint8Array(nbytes);
    const bitAt = (n) => (input[n >> 3] >> (7 - (n % 8))) & 1;
    for (let n = 0; n < nbytes * 8; n++) {
        let bit = bitAt(n);
        if (n - 5 >= 0)
            bit ^= bitAt(n - 5);
        if (n - 7 >= 0)
            bit ^= bitAt(n - 7);
        out[n >> 3] |= bit << (7 - (n % 8));
    }
    return out;
}
function elsnerLag7(input, nbytes) {
    const out = new Uint8Array(nbytes);
    const bitAt = (n) => (input[n >> 3] >> (7 - (n % 8))) & 1;
    for (let n = 0; n < nbytes * 8; n++) {
        let bit = bitAt(n);
        if (n - 7 >= 0)
            bit ^= bitAt(n - 7);
        out[n >> 3] |= bit << (7 - (n % 8));
    }
    return out;
}
function elsnerCommandName(token) {
    switch (token) {
        case 0xcc00: return 'close';
        case 0xbb00: return 'open';
        case 0xbd00: return 'stop_or_release';
        case 0x00ef: return 'automode_a';
        case 0x00e3: return 'automode_b';
        case 0xaac0: return 'filler';
        case 0xa9c0: return 'automode_companion';
        default: return undefined;
    }
}
const ELSNER_ANCHOR = new Uint8Array([0x0a]);
export const elsnerSolexa = register({
    num: 364,
    name: 'Elsner Solexa 230V',
    what: 'sunblind wind, light and temperature sensor',
    modulation: 18,
    shortWidth: 11,
    longWidth: 11,
    resetLimit: 25,
    bands: BAND_868,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const pos = bits.search(0, 0, ELSNER_ANCHOR, 8) + 8;
        const len = bits.bitsPerRow[0];
        if (pos >= len || len - pos < 38 * 8)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, pos, 38 * 8);
        if (crc16(b, 36, 0x1021, 0x68b3) !== ((b[36] << 8) | b[37]))
            return DECODE_FAIL_MIC;
        const p = elsnerDescramble(b, 36);
        const id = hex2(p[0]) + hex2(p[1]) + hex2(p[2]) + hex2(p[3]);
        let data = '';
        for (let i = 0; i < 32; i++)
            data += hex2(p[4 + i]);
        const rp0 = b[4];
        const paramOk = b[7] === ((elsnerSpread(rp0, 3) + 0x48) & 0xff)
            && b[8] === ((elsnerSpread(rp0, 4) + 0xd0) & 0xff)
            && b[9] === ((elsnerSpread(rp0, 5) + 0xa0) & 0xff);
        const counter = (b[5] - elsnerSpread(rp0, 1)) & 0xff;
        let command;
        if (paramOk) {
            const q = elsnerLag7(b, 36);
            const family1 = (q[4 + 3] >> 4) & 1;
            if (family1) {
                const branch1 = (q[4 + 17] >> 2) & 1;
                const l12 = parity8(rp0 & 0xf9);
                const l13 = parity8(rp0 & 0xfd);
                const l14 = 1 ^ parity8(rp0 & 0xff);
                const l17 = parity8(rp0 & 0xfe);
                const l18 = 1 ^ parity8(rp0 & 0xff);
                const l19 = parity8(rp0 & 0xfe);
                let exp0, exp1, obs0, obs1;
                if (!branch1) {
                    exp0 = elsnerStep(b[4 + 12], 0x6a, l12, l13);
                    exp1 = elsnerStep(exp0, 0x30, l13, l14);
                    obs0 = b[4 + 13];
                    obs1 = b[4 + 14];
                }
                else {
                    exp0 = elsnerStep(b[4 + 17], 0x30, l17, l18);
                    exp1 = elsnerStep(exp0, 0x30, l18, l19);
                    obs0 = b[4 + 18];
                    obs1 = b[4 + 19];
                }
                command = elsnerCommandName((((obs0 - exp0) & 0xff) << 8) | ((obs1 - exp1) & 0xff));
            }
        }
        const out = { model: 'Elsner-Solexa', type: 'Blind', id };
        if (paramOk) {
            out.rolling = hex2(rp0);
            out.counter = counter;
        }
        if (command !== undefined)
            out.command = command;
        out.data = data;
        out.mic = 'CRC';
        ctx.emit(out);
        return 1;
    },
});
