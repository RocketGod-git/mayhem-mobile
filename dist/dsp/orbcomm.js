import { BitSync, DiscFilter } from './core.js';
export const ORBCOMM_CHANNELS = [
    137200000, 137225000, 137250000, 137287500, 137312500, 137440000,
    137460000, 137662500, 137687500, 137712500, 137737500, 137800000,
];
const BAUD = 4800;
const ASM = 0xa6159f;
const ASM_INV = ASM ^ 0xffffff;
const FRAME_BITS = 4800;
const FRAME_BYTES = FRAME_BITS / 8;
const PACKET_NAME = {
    0x65: 'sync', 0x1a: 'message', 0x1b: 'uplink', 0x1c: 'downlink', 0x1d: 'network',
    0x1e: 'fill', 0x1f: 'ephemeris', 0x22: 'orbit',
};
const REV = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++)
        if (i & (1 << b))
            v |= 1 << (7 - b);
    REV[i] = v;
}
function fletcherOk(b, at, len) {
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) {
        s1 = (s1 + b[at + i]) & 0xff;
        s2 = (s2 + s1) & 0xff;
    }
    return s1 === 0 && s2 === 0;
}
const hex = (b, at, len) => {
    let s = '';
    for (let i = 0; i < len; i++)
        s += b[at + i].toString(16).padStart(2, '0').toUpperCase();
    return s;
};
const rev = (s) => s.split('').reverse().join('');
function field20(p, a, b) {
    const f = rev(p.slice(a, b));
    return parseInt(rev(f.slice(0, 2)), 16) + 256 * parseInt(rev(f.slice(2, 4)), 16) + 65536 * parseInt(f.slice(4, 5), 16);
}
const MAX_R = 8378155, MAX_V = 7700, SPAN20 = 1048576;
const scale = (t, max) => (2 * t * max) / SPAN20 - max;
function ecefToLla(x, y, z) {
    const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f);
    const e2 = f * (2 - f), ep2 = (a * a - b * b) / (b * b);
    const p = Math.hypot(x, y), th = Math.atan2(a * z, b * p);
    const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    return { lat: lat * 180 / Math.PI, lon: Math.atan2(y, x) * 180 / Math.PI, altKm: (p / Math.cos(lat) - n) / 1000 };
}
const GPS_EPOCH = Date.UTC(1980, 0, 6);
const gpsToUtc = (week, sec) => GPS_EPOCH + week * 604800000 + sec * 1000;
export class OrbcommDecoder {
    constructor(emit) {
        this.emit = emit;
        this.wantsFm = true;
        this.fmRate = 0;
        this.sync = new BitSync(BAUD, 48000);
        this.filt = new DiscFilter(3600, 48000);
        this.shift = 0;
        this.inFrame = false;
        this.inverted = false;
        this.bitN = 0;
        this.frame = new Uint8Array(FRAME_BYTES);
        this.byteAcc = 0;
        this.channelHz = 0;
        this.sats = new Map();
        this.frames = 0;
        this.badFrames = 0;
        this.packets = 0;
        this.badPackets = 0;
        this.syncs = 0;
        this.lastReport = 0;
        this.lastId = -1;
    }
    reset() {
        this.fmRate = 0;
        this.shift = 0;
        this.inFrame = false;
        this.bitN = 0;
        this.lastId = -1;
        this.frames = 0;
        this.badFrames = 0;
        this.packets = 0;
        this.badPackets = 0;
        this.syncs = 0;
    }
    onIq() { }
    onFm(samples, n, rate) {
        if (rate !== this.fmRate) {
            this.fmRate = rate;
            this.sync = new BitSync(BAUD, rate);
            this.filt = new DiscFilter(3600, rate);
            this.shift = 0;
            this.inFrame = false;
            this.bitN = 0;
        }
        for (let i = 0; i < n; i++) {
            const b = this.sync.push(this.filt.push(samples[i]));
            if (b >= 0)
                this.pushBit(b);
        }
    }
    pushBit(bit) {
        if (this.inFrame) {
            this.byteAcc = (this.byteAcc << 1) | (this.inverted ? bit ^ 1 : bit);
            if ((++this.bitN & 7) === 0)
                this.frame[(this.bitN >> 3) - 1] = REV[this.byteAcc & 0xff];
            if (this.bitN >= FRAME_BITS) {
                this.inFrame = false;
                this.onFrame();
            }
            return;
        }
        this.shift = ((this.shift << 1) | bit) & 0xffffff;
        if (this.shift === ASM || this.shift === ASM_INV) {
            this.inverted = this.shift === ASM_INV;
            this.syncs++;
            this.inFrame = true;
            this.byteAcc = 0;
            this.frame[0] = REV[(ASM >> 16) & 0xff];
            this.frame[1] = REV[(ASM >> 8) & 0xff];
            this.frame[2] = REV[ASM & 0xff];
            this.bitN = 24;
        }
    }
    onFrame() {
        this.frames++;
        this.report();
        const f = this.frame;
        let at = 0, good = 0;
        while (at + 12 <= FRAME_BYTES) {
            const type = f[at];
            const len = type === 0x1f && at + 24 <= FRAME_BYTES ? 24 : 12;
            this.packets++;
            if (!fletcherOk(f, at, len) && !this.fixOneBit(f, at, len)) {
                this.badPackets++;
                at += len;
                continue;
            }
            good++;
            this.onPacket(type, f, at, len);
            at += len;
        }
        if (!good)
            this.badFrames++;
    }
    fixOneBit(f, at, len) {
        for (let i = 0; i < len; i++) {
            for (let b = 0; b < 8; b++) {
                f[at + i] ^= 1 << b;
                if (fletcherOk(f, at, len))
                    return true;
                f[at + i] ^= 1 << b;
            }
        }
        return false;
    }
    sat(id) {
        let s = this.sats.get(id);
        if (!s) {
            s = { id, channelHz: this.channelHz, frames: 0, bad: 0, firstMs: Date.now(), lastMs: Date.now() };
            this.sats.set(id, s);
        }
        s.lastMs = Date.now();
        s.channelHz = this.channelHz;
        return s;
    }
    onPacket(type, f, at, len) {
        if (type === 0x65) {
            this.lastId = f[at + 3];
            this.sat(this.lastId).frames++;
            return;
        }
        if (type !== 0x1f) {
            if (type === 0x1a)
                this.emit({ type: 'log', line: `ORBCOMM message packet, payload encrypted: ${hex(f, at + 2, 8)}` });
            return;
        }
        const p = hex(f, at + 2, len - 2);
        const week = parseInt(p.slice(0, 4), 16), tow = parseInt(p.slice(4, 10), 16);
        const vz = scale(field20(p, 10, 15), MAX_V), vy = scale(field20(p, 15, 20), MAX_V), vx = scale(field20(p, 20, 25), MAX_V);
        const z = scale(field20(p, 25, 30), MAX_R), y = scale(field20(p, 30, 35), MAX_R), x = scale(field20(p, 35, 40), MAX_R);
        const lla = ecefToLla(x, y, z);
        if (!Number.isFinite(lla.lat) || Math.abs(lla.lat) > 90 || lla.altKm < 400 || lla.altKm > 1400)
            return;
        const id = f[at + 1] || this.lastId;
        if (id < 0)
            return;
        const s = this.sat(id);
        s.lat = lla.lat;
        s.lon = lla.lon;
        s.altKm = lla.altKm;
        s.speedKms = Math.hypot(vx, vy, vz) / 1000;
        s.utc = gpsToUtc(week, tow);
        this.report(true);
    }
    report(force = false) {
        const now = Date.now();
        if (!force && now - this.lastReport < 500)
            return;
        this.lastReport = now;
        this.emit({ type: 'orbcomm', sats: [...this.sats.values()], frames: this.frames, packets: this.packets, bad: this.badPackets, syncs: this.syncs });
    }
    static packetName(type) { return PACKET_NAME[type] ?? `0x${type.toString(16)}`; }
}
