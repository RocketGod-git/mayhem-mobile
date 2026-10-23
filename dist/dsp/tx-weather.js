export const WEATHER_MODEL = 'Acurite-Tower';
export const WEATHER_PROTOCOL = 40;
export const WEATHER_FREQ_HZ = 433920000;
const TEMP_MIN_C = -40;
const TEMP_MAX_C = 70;
const TEMP_OFFSET = 1000;
const TEMP_STEP = 10;
const HUM_MAX = 100;
const HUM_NONE = 127;
const MSG_TOWER = 0x04;
const BATTERY_OK = 0x40;
const CHANNEL_CODE = { 1: 0b11, 2: 0b10, 3: 0b00 };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function parity8(b) {
    const x = (b ^ (b >> 4)) & 0x0f;
    return (0x6996 >> x) & 1;
}
export function weatherFrame(s) {
    const id = clamp(Math.round(s.id ?? 0x0abc), 0, 0x3fff);
    const chan = CHANNEL_CODE[s.channel ?? 1] ?? CHANNEL_CODE[1];
    const tempC = clamp(s.tempC, TEMP_MIN_C, TEMP_MAX_C);
    const tempRaw = Math.round(tempC * TEMP_STEP) + TEMP_OFFSET;
    const humidity = s.humidity === undefined ? HUM_NONE : clamp(Math.round(s.humidity), 0, HUM_MAX);
    const battery = (s.battery ?? true) ? BATTERY_OK : 0;
    const bb = [
        (chan << 6) | ((id >> 8) & 0x3f),
        id & 0xff,
        battery | MSG_TOWER,
        humidity & 0x7f,
        (tempRaw >> 7) & 0x7f,
        tempRaw & 0x7f,
        0,
    ];
    for (let i = 2; i <= 5; i++)
        if (parity8(bb[i]))
            bb[i] |= 0x80;
    let sum = 0;
    for (let i = 0; i < 6; i++)
        sum += bb[i];
    bb[6] = sum & 0xff;
    return bb;
}
const SYNC_MARK_US = 620;
const SYNC_GAP_US = 596;
const SHORT_MARK_US = 220;
const LONG_MARK_US = 408;
const SHORT_GAP_US = 204;
const LONG_GAP_US = 392;
const INTER_FRAME_GAP_US = 2192;
const NUM_SYNC = 4;
const REPEATS = 3;
export function weatherPulses(s, rate) {
    const us = (t) => Math.round((t * rate) / 1e6);
    const bytes = weatherFrame(s);
    const bits = [];
    for (const b of bytes)
        for (let i = 7; i >= 0; i--)
            bits.push((b >> i) & 1);
    const out = [];
    for (let rep = 0; rep < REPEATS; rep++) {
        for (let i = 0; i < NUM_SYNC; i++) {
            out.push([true, us(SYNC_MARK_US)]);
            out.push([false, us(SYNC_GAP_US)]);
        }
        for (const bit of bits) {
            if (bit) {
                out.push([true, us(LONG_MARK_US)]);
                out.push([false, us(SHORT_GAP_US)]);
            }
            else {
                out.push([true, us(SHORT_MARK_US)]);
                out.push([false, us(LONG_GAP_US)]);
            }
        }
        out.push([false, us(INTER_FRAME_GAP_US)]);
    }
    return out;
}
