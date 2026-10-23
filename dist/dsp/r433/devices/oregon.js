import { BitBuffer } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc8, reflectNibbles } from '../util.js';
const ID_THGR122N = 0x1d20;
const ID_THGR968 = 0x1d30;
const ID_BTHR918 = 0x5d50;
const ID_BHTR968 = 0x5d60;
const ID_RGR968 = 0x2d10;
const ID_THR228N = 0xec40;
const ID_THN132N = 0xec40;
const ID_AWR129 = 0xec41;
const ID_RTGN318 = 0x0cc3;
const ID_RTGN129 = 0x0cc3;
const ID_THGR810 = 0xf024;
const ID_THGR810a = 0xf8b4;
const ID_THN802 = 0xc844;
const ID_PCR800 = 0x2914;
const ID_PCR800a = 0x2d14;
const ID_WGR800 = 0x1984;
const ID_WGR800a = 0x1994;
const ID_WGR968 = 0x3d00;
const ID_UV800 = 0xd874;
const ID_THN129 = 0xcc43;
const ID_RTHN129 = 0x0cd3;
const ID_BTHGN129 = 0x5d53;
const ID_UVR128 = 0xec70;
const ID_THGR328N = 0xcc23;
const ID_RTGR328N = [0xdcc3, 0xccc3, 0xbcc3, 0xacc3, 0x9cc3];
const ID_RTGR328N_CLOCK = [0x8ce3, 0x8ae3];
const EXPECTED_NUM_BYTES = 44;
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const two = (v) => String(v).padStart(2, '0');
function osTemperature(m) {
    let t = (((m[5] >> 4) * 100) + ((m[4] & 0x0f) * 10) + ((m[4] >> 4) & 0x0f)) / 10;
    t += (m[5] & 0x07) * 100;
    return (m[5] & 0x08) ? -t : t;
}
const osHumidity = (m) => ((m[6] & 0x0f) * 10) + (m[6] >> 4);
const osUv = (m) => ((m[4] & 0x0f) * 10) + (m[4] >> 4);
const osRainRate = (m) => (((m[5] & 0x0f) * 1000) + ((m[5] >> 4) * 100) + ((m[4] & 0x0f) * 10) + (m[4] >> 4)) / 100;
function osTotalRain(m) {
    return (m[8] & 0x0f) * 100 + ((m[8] >> 4) & 0x0f) * 10 + (m[7] & 0x0f)
        + ((m[7] >> 4) & 0x0f) / 10 + (m[6] & 0x0f) / 100 + ((m[6] >> 4) & 0x0f) / 1000;
}
const swapNibbles = (b) => (((b & 0x0f) << 4) | (b >> 4)) & 0xff;
function osChecksumOk(m, checksumNibbleIdx) {
    let sum = 0;
    for (let i = 0; i < checksumNibbleIdx - 1; i += 2) {
        const v = m[i >> 1];
        sum += (v >> 4) + (v & 0x0f);
    }
    let checksum;
    if (checksumNibbleIdx & 1) {
        sum += m[checksumNibbleIdx >> 1] >> 4;
        checksum = (m[checksumNibbleIdx >> 1] & 0x0f) | (m[(checksumNibbleIdx + 1) >> 1] & 0xf0);
    }
    else {
        checksum = (m[checksumNibbleIdx >> 1] >> 4) | ((m[checksumNibbleIdx >> 1] & 0x0f) << 4);
    }
    return (sum & 0xff) === checksum;
}
const osV2Ok = (m, expected, got, nibbles) => expected === got && osChecksumOk(m, nibbles);
const digitsOk = (...ns) => ns.every(n => n <= 9);
function decodeV21(bits, ctx) {
    const b = bits.bb[0];
    if ((b[1] !== 0x55 || b[2] !== 0x55) && (b[1] !== 0xaa || b[2] !== 0xaa))
        return DECODE_ABORT_EARLY;
    const databits = new BitBuffer();
    const syncTest = ((b[3] << 24) | (b[4] << 16) | (b[5] << 8) | b[6]) >>> 0;
    for (let shift = 0; shift < 8; shift++) {
        const mask = (0xffff0000 >>> shift) >>> 0;
        const pattern = (0x55990000 >>> shift) >>> 0;
        const pattern2 = (0xaa990000 >>> shift) >>> 0;
        if ((syncTest & mask) !== pattern && (syncTest & mask) !== pattern2)
            continue;
        bits.manchesterDecode(0, shift + 40, databits, 173);
        reflectNibbles(databits.bb[0], (databits.bitsPerRow[0] + 7) >> 3);
        break;
    }
    const msg = databits.bb[0];
    const n = databits.bitsPerRow[0];
    const sensorId = (msg[0] << 8) | msg[1];
    const channel = (msg[2] >> 4) & 0x0f;
    const deviceId = (msg[2] & 0x0f) | (msg[3] & 0xf0);
    const batteryOk = ((msg[3] >> 2) & 0x01) ? 0 : 1;
    const base = { id: deviceId, channel, battery_ok: batteryOk };
    if (sensorId === ID_THGR122N || sensorId === ID_THGR968) {
        if (!osV2Ok(msg, 68, n, 15) && !osV2Ok(msg, 76, n, 15))
            return 0;
        const model = sensorId === ID_THGR968 ? 'Oregon-THGR968' : n === 68 ? 'Oregon-THGR228N' : 'Oregon-THGR122N';
        ctx.emit({ model, ...base, temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg) });
        return 1;
    }
    if (sensorId === ID_WGR968) {
        if (!osV2Ok(msg, 94, n, 17))
            return 0;
        ctx.emit({
            model: 'Oregon-WGR968', ...base,
            wind_max_m_s: round1((msg[5] & 0x0f) / 10 + ((msg[6] >> 4) & 0x0f) + (msg[6] & 0x0f) / 10),
            wind_avg_m_s: round1(((msg[7] >> 4) & 0x0f) / 10 + (msg[7] & 0x0f) + ((msg[8] >> 4) & 0x0f) / 10),
            wind_dir_deg: round1((msg[4] & 0x0f) * 10 + ((msg[4] >> 4) & 0x0f) + ((msg[5] >> 4) & 0x0f) * 100),
        });
        return 1;
    }
    if (sensorId === ID_BHTR968) {
        if (!osV2Ok(msg, 92, n, 19))
            return 0;
        ctx.emit({
            model: 'Oregon-BHTR968', ...base,
            temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg),
            pressure_hPa: ((msg[7] & 0x0f) | (msg[8] & 0xf0)) + 856,
        });
        return 1;
    }
    if (sensorId === ID_BTHR918) {
        if (!osV2Ok(msg, 84, n, 19))
            return 0;
        ctx.emit({
            model: 'Oregon-BTHR918', ...base,
            temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg),
            pressure_hPa: ((msg[7] & 0x0f) | (msg[8] & 0xf0)) + 795,
        });
        return 1;
    }
    if (sensorId === ID_RGR968) {
        if (!osV2Ok(msg, 80, n, 16))
            return 0;
        ctx.emit({
            model: 'Oregon-RGR968', ...base,
            rain_rate_mm_h: round1(((msg[4] & 0x0f) * 100 + (msg[4] >> 4) * 10 + ((msg[5] >> 4) & 0x0f)) / 10),
            rain_mm: round1(((msg[7] & 0x0f) * 10000 + (msg[7] >> 4) * 1000 + (msg[6] & 0x0f) * 100
                + (msg[6] >> 4) * 10 + (msg[5] & 0x0f)) / 10),
        });
        return 1;
    }
    if ((sensorId === ID_THR228N || sensorId === ID_AWR129) && n === 76) {
        if (!osV2Ok(msg, 76, n, 12))
            return 0;
        ctx.emit({ model: 'Oregon-THR228N', ...base, temperature_C: round2(osTemperature(msg)) });
        return 1;
    }
    if (sensorId === ID_THN132N && n === 64) {
        if (!osV2Ok(msg, 64, n, 12))
            return 0;
        if (!digitsOk((msg[5] >> 4) & 0x0f, msg[4] & 0x0f, (msg[4] >> 4) & 0x0f))
            return DECODE_FAIL_SANITY;
        const t = osTemperature(msg);
        if (t > 70 || t < -50)
            return DECODE_FAIL_SANITY;
        ctx.emit({ model: 'Oregon-THN132N', ...base, temperature_C: round2(t) });
        return 1;
    }
    if ((sensorId & 0x0fff) === ID_RTGN129 && n === 80) {
        if (!osV2Ok(msg, 80, n, 15))
            return 0;
        ctx.emit({ model: 'Oregon-RTGN129', ...base, temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg) });
        return 1;
    }
    if (ID_RTGR328N.includes(sensorId) && n === 173) {
        if (!osV2Ok(msg, 173, n, 15))
            return 0;
        ctx.emit({ model: 'Oregon-RTGR328N', ...base, temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg) });
        return 1;
    }
    if (ID_RTGR328N_CLOCK.includes(sensorId)) {
        if (!osV2Ok(msg, 100, n, 21))
            return 0;
        const year = ((msg[9] & 0x0f) * 10) + ((msg[9] & 0xf0) >> 4) + 2000;
        ctx.emit({
            model: 'Oregon-RTGR328N', ...base,
            radio_clock: `${year}-${two((msg[8] & 0xf0) >> 4)}-${two(((msg[7] & 0x0f) * 10) + ((msg[7] & 0xf0) >> 4))}`
                + `T${two(((msg[6] & 0x0f) * 10) + ((msg[6] & 0xf0) >> 4))}:${two(((msg[5] & 0x0f) * 10) + ((msg[5] & 0xf0) >> 4))}`
                + `:${two(((msg[4] & 0x0f) * 10) + ((msg[4] & 0xf0) >> 4))}`,
        });
        return 1;
    }
    if ((sensorId & 0x0fff) === ID_RTGN318 && n === 76 && osV2Ok(msg, 76, n, 15)) {
        ctx.emit({ model: 'Oregon-RTGN318', ...base, temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg) });
        return 1;
    }
    if ((sensorId === ID_THN129 || (sensorId & 0x0fff) === ID_RTHN129) && osV2Ok(msg, 68, n, 12)) {
        ctx.emit({ model: 'Oregon-THN129', ...base, temperature_C: round2(osTemperature(msg)) });
        return 1;
    }
    if (sensorId === ID_BTHGN129) {
        if (!osV2Ok(msg, 92, n, 19))
            return 0;
        ctx.emit({
            model: 'Oregon-BTHGN129', ...base,
            temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg),
            pressure_hPa: ((msg[7] & 0x0f) | (msg[8] & 0xf0)) * 2 + (msg[8] & 0x01) + 600,
        });
        return 1;
    }
    if (sensorId === ID_UVR128 && n === 148) {
        if (!osV2Ok(msg, 148, n, 12))
            return 0;
        if (!digitsOk((msg[4] >> 4) & 0x0f, msg[4] & 0x0f))
            return DECODE_FAIL_SANITY;
        const uv = osUv(msg);
        if (uv < 0 || uv > 25)
            return DECODE_FAIL_SANITY;
        ctx.emit({ model: 'Oregon-UVR128', id: deviceId, battery_ok: batteryOk, uvi: uv });
        return 1;
    }
    if (sensorId === ID_THGR328N) {
        if (!osV2Ok(msg, 173, n, 15))
            return 0;
        ctx.emit({ model: 'Oregon-THGR328N', ...base, temperature_C: round2(osTemperature(msg)), humidity: osHumidity(msg) });
        return 1;
    }
    return 0;
}
function decodeV3(bits, ctx) {
    const b = bits.bb[0];
    if (((b[0] & 0x0f) !== 0x0f || b[1] !== 0xff || (b[2] & 0xc0) !== 0xc0)
        && ((b[0] & 0x0f) !== 0x00 || b[1] !== 0x00 || (b[2] & 0xc0) !== 0x00))
        return DECODE_ABORT_EARLY;
    const rowBits = bits.bitsPerRow[0];
    const osPos = bits.search(0, 0, new Uint8Array([0x00, 0x05]), 16) + 16;
    const cm180Pos = bits.search(0, 0, new Uint8Array([0x00, 0x46]), 16) + 8;
    const cm180iPos = bits.search(0, 0, new Uint8Array([0x00, 0x4a]), 16) + 8;
    const cm130Pos = bits.search(0, 0, new Uint8Array([0x00, 0x00, 0x00, 0x60]), 32) + 24;
    const altPos = bits.search(0, 0, new Uint8Array([0xff, 0xf5]), 16) + 16;
    let pos = 0, len = 0;
    if (rowBits - osPos >= 7 * 8) {
        pos = osPos;
        len = rowBits - osPos;
    }
    else if (rowBits - cm180Pos >= 52) {
        pos = cm180Pos;
        len = rowBits - cm180Pos;
    }
    else if (rowBits - cm180iPos >= 84) {
        pos = cm180iPos;
        len = rowBits - cm180iPos;
    }
    else if (rowBits - cm130Pos >= 96) {
        pos = cm130Pos;
        len = rowBits - cm130Pos;
    }
    else if (rowBits - altPos >= 7 * 8) {
        pos = altPos;
        len = rowBits - altPos;
    }
    if (len === 0 || len > EXPECTED_NUM_BYTES * 8)
        return DECODE_ABORT_EARLY;
    const msg = new Uint8Array(EXPECTED_NUM_BYTES);
    bits.extractBytes(0, pos, msg, len);
    reflectNibbles(msg, (len + 7) >> 3);
    const sensorId = (msg[0] << 8) | msg[1];
    const channel = (msg[2] >> 4) & 0x0f;
    const deviceId = (msg[2] & 0x0f) | (msg[3] & 0xf0);
    const batteryOk = ((msg[3] >> 2) & 0x01) ? 0 : 1;
    const base = { id: deviceId, channel, battery_ok: batteryOk };
    if ((sensorId & 0xf0ff) === ID_THGR810 || sensorId === ID_THGR810a) {
        if (!osChecksumOk(msg, 15))
            return DECODE_FAIL_MIC;
        if (!digitsOk((msg[5] >> 4) & 0x0f, msg[4] & 0x0f, (msg[4] >> 4) & 0x0f, msg[6] & 0x0f, (msg[6] >> 4) & 0x0f))
            return DECODE_FAIL_SANITY;
        const t = osTemperature(msg);
        if (t > 70 || t < -50)
            return DECODE_FAIL_SANITY;
        const out = {
            model: 'Oregon-THGR810', ...base,
            temperature_C: round2(t), humidity: osHumidity(msg),
        };
        const button = msg[0] & 1;
        if (button)
            out.button = button;
        ctx.emit(out);
        return 1;
    }
    if (sensorId === ID_THN802) {
        if (!osChecksumOk(msg, 12))
            return DECODE_FAIL_MIC;
        ctx.emit({ model: 'Oregon-THN802', ...base, temperature_C: round2(osTemperature(msg)) });
        return 1;
    }
    if (sensorId === ID_UV800) {
        if (!osChecksumOk(msg, 13))
            return DECODE_FAIL_MIC;
        ctx.emit({ model: 'Oregon-UV800', ...base, uvi: osUv(msg) });
        return 1;
    }
    if (sensorId === ID_PCR800 || sensorId === ID_PCR800a) {
        if (!osChecksumOk(msg, 18))
            return DECODE_FAIL_MIC;
        if (sensorId === ID_PCR800 && !digitsOk(msg[8] & 0x0f, (msg[8] >> 4) & 0x0f, msg[7] & 0x0f, (msg[7] >> 4) & 0x0f, msg[6] & 0x0f, (msg[6] >> 4) & 0x0f, msg[5] & 0x0f, (msg[5] >> 4) & 0x0f, msg[4] & 0x0f, (msg[4] >> 4) & 0x0f))
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: sensorId === ID_PCR800 ? 'Oregon-PCR800' : 'Oregon-PCR800a', ...base,
            rain_rate_in_h: round2(osRainRate(msg)),
            rain_in: Math.round(osTotalRain(msg) * 1000) / 1000,
        });
        return 1;
    }
    if (sensorId === ID_WGR800 || sensorId === ID_WGR800a) {
        if (!osChecksumOk(msg, 17))
            return DECODE_FAIL_MIC;
        if (!digitsOk(msg[5] & 0x0f, (msg[6] >> 4) & 0x0f, msg[6] & 0x0f, (msg[7] >> 4) & 0x0f, msg[7] & 0x0f, (msg[8] >> 4) & 0x0f))
            return DECODE_FAIL_SANITY;
        const gust = (msg[5] & 0x0f) / 10 + ((msg[6] >> 4) & 0x0f) + (msg[6] & 0x0f) * 10;
        const avg = ((msg[7] >> 4) & 0x0f) / 10 + (msg[7] & 0x0f) + ((msg[8] >> 4) & 0x0f) * 10;
        if (gust < 0 || gust > 56 || avg < 0 || avg > 56)
            return DECODE_FAIL_SANITY;
        ctx.emit({
            model: 'Oregon-WGR800', ...base,
            wind_max_m_s: round1(gust), wind_avg_m_s: round1(avg),
            wind_dir_deg: round1(((msg[4] >> 4) & 0x0f) * 22.5),
        });
        return 1;
    }
    if (msg[0] >= 0x20 && msg[0] <= 0x24) {
        msg[0] &= 0x0f;
        if (!osChecksumOk(msg, 22))
            return DECODE_FAIL_MIC;
        const amps = swapNibbles(msg[3]) | ((msg[4] >> 4) << 8);
        const totalAmps = (swapNibbles(msg[10]) * 2 ** 36) + (swapNibbles(msg[9]) * 2 ** 28)
            + (swapNibbles(msg[8]) << 20) + (swapNibbles(msg[7]) << 12) + (swapNibbles(msg[6]) << 4) + (msg[5] & 0x0f);
        ctx.emit({
            model: 'Oregon-CM160',
            id: msg[1] & 0x0f,
            power_W: round2(amps * 0.07 * 230),
            energy_kWh: round2(totalAmps * 230 / 3600 / 1000 * 1.12),
        });
        return 1;
    }
    if (msg[0] === 0x26) {
        msg[0] &= 0x0f;
        if (!osChecksumOk(msg, 23))
            return DECODE_FAIL_MIC;
        for (let k = 0; k < EXPECTED_NUM_BYTES; k++)
            msg[k] = swapNibbles(msg[k]);
        const total = (msg[1] & 0x0f) === 0
            ? msg[10] * 2 ** 40 + msg[9] * 2 ** 32 + msg[8] * 2 ** 24 + (msg[7] << 16) + (msg[6] << 8) + msg[5]
            : 0;
        const out = {
            model: 'Oregon-CM180',
            id: (msg[2] << 8) | (msg[1] & 0xf0),
            battery_ok: (msg[3] & 0x01) ? 0 : 1,
            power_W: Math.round(((msg[4] << 8) | (msg[3] & 0xf0)) * 1.00625),
            sequence: msg[1] & 0x0f,
        };
        if (total !== 0)
            out.energy_kWh = round2(total / 3600 / 1000);
        ctx.emit(out);
        return 1;
    }
    if (msg[0] === 0x25) {
        msg[0] &= 0x0f;
        for (let k = 0; k < EXPECTED_NUM_BYTES; k++)
            msg[k] = swapNibbles(msg[k]);
        const power = (o) => Math.round((((msg[4 + o * 2] << 8) | (msg[3 + o * 2] & 0xf0))) * 1.00625);
        const total = len >= 140 && (msg[1] & 0x0f) === 0
            ? msg[14] * 2 ** 40 + msg[13] * 2 ** 32 + msg[12] * 2 ** 24 + (msg[11] << 16) + (msg[10] << 8) + msg[9]
            : 0;
        const out = {
            model: 'Oregon-CM180i',
            id: (msg[2] << 8) | (msg[1] & 0xf0),
            battery_ok: (msg[3] & 0x40) ? 0 : 1,
            power1_W: power(0), power2_W: power(1), power3_W: power(2),
            sequence: msg[1] & 0x0f,
        };
        if (total !== 0)
            out.energy_kWh = round2(total / 3600 / 1000);
        ctx.emit(out);
        return 1;
    }
    if (msg[0] === 0x60) {
        if (crc8(msg, 10, 0x07, 0x00, 1) !== swapNibbles(msg[11]))
            return DECODE_FAIL_MIC;
        for (let k = 0; k < 12; k++)
            msg[k] = swapNibbles(msg[k]);
        const energy = (msg[6] | (msg[7] << 8) | (msg[8] << 16) | (msg[9] * 2 ** 24));
        ctx.emit({
            model: 'Oregon-CM130',
            id: msg[2],
            power_W: ((msg[4] << 8) | msg[3]) * 16,
            energy_kWh: round2(energy / 8192),
            mic: 'CRC',
        });
        return 1;
    }
    return DECODE_FAIL_SANITY;
}
export const oregonScientific = register({
    num: 12,
    name: 'Oregon Scientific weather sensor',
    what: 'thermometers, rain gauges, anemometers, and the Owl household energy monitors',
    modulation: 3,
    shortWidth: 440,
    longWidth: 0,
    resetLimit: 2400,
    bands: [433920000],
    decode(_dev, bits, ctx) {
        const ret = decodeV21(bits, ctx);
        return ret > 0 ? ret : decodeV3(bits, ctx);
    },
});
