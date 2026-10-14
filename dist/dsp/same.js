import { BitSync, DiscFilter } from './core.js';
export const SAME_BAUD = 520 + 5 / 6;
const MARK_HZ = 4 * SAME_BAUD;
const SPACE_HZ = 3 * SAME_BAUD;
const PREAMBLE = 0xab;
export const SAME_ORIGINATORS = {
    PEP: 'Primary Entry Point',
    CIV: 'Civil authorities',
    WXR: 'National Weather Service',
    EAS: 'Broadcast station',
};
export const SAME_EVENTS = {
    RWT: 'Required Weekly Test', RMT: 'Required Monthly Test', NPT: 'National Periodic Test', DMO: 'Practice/Demo',
    ADR: 'Administrative Message', EAN: 'Emergency Action Notification', EAT: 'Emergency Action Termination',
    TOR: 'Tornado Warning', TOA: 'Tornado Watch', SVR: 'Severe Thunderstorm Warning', SVA: 'Severe Thunderstorm Watch',
    SVS: 'Severe Weather Statement', SPS: 'Special Weather Statement',
    FFW: 'Flash Flood Warning', FFA: 'Flash Flood Watch', FFS: 'Flash Flood Statement',
    FLW: 'Flood Warning', FLA: 'Flood Watch', FLS: 'Flood Statement',
    WSW: 'Winter Storm Warning', WSA: 'Winter Storm Watch', BZW: 'Blizzard Warning',
    HWW: 'High Wind Warning', HWA: 'High Wind Watch', EWW: 'Extreme Wind Warning',
    HUW: 'Hurricane Warning', HUA: 'Hurricane Watch', HLS: 'Hurricane Statement',
    TRW: 'Tropical Storm Warning', TRA: 'Tropical Storm Watch',
    SMW: 'Special Marine Warning', CFW: 'Coastal Flood Warning', CFA: 'Coastal Flood Watch',
    TSW: 'Tsunami Warning', TSA: 'Tsunami Watch', DSW: 'Dust Storm Warning',
    FRW: 'Fire Warning', AVW: 'Avalanche Warning', AVA: 'Avalanche Watch', VOW: 'Volcano Warning', EQW: 'Earthquake Warning',
    EVI: 'Evacuation Immediate', CEM: 'Civil Emergency Message', CDW: 'Civil Danger Warning', CAE: 'Child Abduction Emergency',
    LEW: 'Law Enforcement Warning', LAE: 'Local Area Emergency', HMW: 'Hazardous Materials Warning',
    NUW: 'Nuclear Power Plant Warning', RHW: 'Radiological Hazard Warning', SPW: 'Shelter in Place Warning',
    TOE: '911 Telephone Outage Emergency', NMN: 'Network Message Notification',
};
const HEADER_RE = /^ZCZC-([A-Z]{3})-([A-Z]{3})((?:-\d{6}){1,31})\+(\d{4})-(\d{7})-([\x20-\x7e]{8})-/;
const MAX_MSG = 256;
export function parseSameHeader(raw) {
    const m = HEADER_RE.exec(raw);
    if (!m)
        return null;
    const [, originator, event, locs, tttt, jjjhhmm, call] = m;
    const locations = locs.slice(1).split('-').map(code => ({ code, portion: Number(code[0]), state: code.slice(1, 3), county: code.slice(3) }));
    const duration = { hours: Number(tttt.slice(0, 2)), minutes: Number(tttt.slice(2)) };
    const issued = { day: Number(jjjhhmm.slice(0, 3)), hour: Number(jjjhhmm.slice(3, 5)), minute: Number(jjjhhmm.slice(5)) };
    if (duration.minutes > 59 || issued.day < 1 || issued.day > 366 || issued.hour > 23 || issued.minute > 59)
        return null;
    return {
        originator, originatorName: SAME_ORIGINATORS[originator] ?? originator,
        event, eventName: SAME_EVENTS[event] ?? event,
        locations, duration, issued, callsign: call.trim(),
    };
}
function headerEnd(raw) { const m = HEADER_RE.exec(raw); return m ? m[0].length : 0; }
function opener(s, want) { let n = 0; for (let i = 0; i < 4; i++)
    if (s[i] === want[i])
        n++; return n; }
export class SameDecoder {
    constructor(emit) {
        this.emit = emit;
        this.wantsFm = true;
        this.rate = 0;
        this.t = 0;
        this.spb = 92;
        this.ring = new Float32Array(92);
        this.ri = 0;
        this.ph1 = 0;
        this.ph2 = 0;
        this.w1 = 0;
        this.w2 = 0;
        this.c1 = 0;
        this.s1 = 0;
        this.c2 = 0;
        this.s2 = 0;
        this.sinceRecompute = 0;
        this.sync = new BitSync(SAME_BAUD, 48000);
        this.filt = new DiscFilter(3000, 48000);
        this.sr = 0;
        this.synced = false;
        this.cur = 0;
        this.bitIdx = 0;
        this.msg = '';
        this.inMsg = false;
        this.group = null;
        this.blockN = 2400;
        this.coef = [0, 0, 0];
        this.g1 = [0, 0, 0];
        this.g2 = [0, 0, 0];
        this.energy = 0;
        this.blockI = 0;
        this.toneRun = 0;
        this.toneKind = '';
        this.toneQuiet = 0;
        this.toneArmed = true;
    }
    reset(rate) {
        if (rate > 0)
            this.configure(rate);
        else
            this.rate = 0;
    }
    onIq() { }
    configure(rate) {
        this.rate = rate;
        this.t = 0;
        this.spb = Math.max(8, Math.round(rate / SAME_BAUD));
        this.ring = new Float32Array(this.spb);
        this.ri = 0;
        this.w1 = 2 * Math.PI * MARK_HZ / rate;
        this.w2 = 2 * Math.PI * SPACE_HZ / rate;
        this.ph1 = this.ph2 = this.c1 = this.s1 = this.c2 = this.s2 = 0;
        this.sinceRecompute = 0;
        this.sync = new BitSync(SAME_BAUD, rate);
        this.filt = new DiscFilter(3000, rate);
        this.sr = 0;
        this.synced = false;
        this.cur = 0;
        this.bitIdx = 0;
        this.msg = '';
        this.inMsg = false;
        this.group = null;
        this.blockN = Math.round(rate / 20);
        this.coef = [1050, 853, 960].map(f => 2 * Math.cos(2 * Math.PI * f / rate));
        this.g1 = [0, 0, 0];
        this.g2 = [0, 0, 0];
        this.energy = 0;
        this.blockI = 0;
        this.toneRun = 0;
        this.toneKind = '';
        this.toneQuiet = 0;
        this.toneArmed = true;
    }
    onFm(samples, n, rate) {
        if (rate !== this.rate)
            this.configure(rate);
        const twoPi = 2 * Math.PI;
        for (let i = 0; i < n; i++) {
            const x = this.filt.push(samples[i]);
            const old = this.ring[this.ri];
            this.ring[this.ri] = x;
            this.ri = this.ri + 1 >= this.spb ? 0 : this.ri + 1;
            let o1 = this.ph1 - this.w1 * this.spb;
            while (o1 < 0)
                o1 += twoPi;
            let o2 = this.ph2 - this.w2 * this.spb;
            while (o2 < 0)
                o2 += twoPi;
            this.c1 += x * Math.cos(this.ph1) - old * Math.cos(o1);
            this.s1 += x * Math.sin(this.ph1) - old * Math.sin(o1);
            this.c2 += x * Math.cos(this.ph2) - old * Math.cos(o2);
            this.s2 += x * Math.sin(this.ph2) - old * Math.sin(o2);
            this.ph1 += this.w1;
            if (this.ph1 >= twoPi)
                this.ph1 -= twoPi;
            this.ph2 += this.w2;
            if (this.ph2 >= twoPi)
                this.ph2 -= twoPi;
            if (++this.sinceRecompute >= 4096) {
                this.sinceRecompute = 0;
                this.recompute();
            }
            const d = (this.c1 * this.c1 + this.s1 * this.s1) - (this.c2 * this.c2 + this.s2 * this.s2);
            const b = this.sync.push(d);
            if (b >= 0)
                this.pushBit(b);
            this.tone(x);
        }
        this.t += n;
        if (this.group && this.t - this.group.lastT > 2.5 * this.rate)
            this.finalize();
    }
    recompute() {
        const twoPi = 2 * Math.PI;
        this.c1 = this.s1 = this.c2 = this.s2 = 0;
        for (let j = 0; j < this.spb; j++) {
            const v = this.ring[(this.ri + j) % this.spb];
            let a1 = this.ph1 - this.w1 * (this.spb - j);
            while (a1 < 0)
                a1 += twoPi;
            let a2 = this.ph2 - this.w2 * (this.spb - j);
            while (a2 < 0)
                a2 += twoPi;
            this.c1 += v * Math.cos(a1);
            this.s1 += v * Math.sin(a1);
            this.c2 += v * Math.cos(a2);
            this.s2 += v * Math.sin(a2);
        }
    }
    pushBit(bit) {
        this.sr = ((this.sr >>> 1) | (bit << 31)) >>> 0;
        if (!this.synced) {
            if (this.sr === 0xabababab) {
                this.synced = true;
                this.bitIdx = 0;
                this.cur = 0;
                this.msg = '';
                this.inMsg = false;
            }
            return;
        }
        this.cur = (this.cur >> 1) | (bit << 7);
        if (++this.bitIdx < 8)
            return;
        const byte = this.cur;
        this.bitIdx = 0;
        this.cur = 0;
        if (!this.inMsg) {
            if (byte === PREAMBLE)
                return;
            this.inMsg = true;
        }
        if (byte < 0x20 || byte > 0x7e || this.msg.length >= MAX_MSG) {
            this.close();
            return;
        }
        this.msg += String.fromCharCode(byte);
        if (this.msg === 'NNNN' || HEADER_RE.test(this.msg))
            this.close();
    }
    close() {
        const s = this.msg;
        this.synced = false;
        this.inMsg = false;
        this.msg = '';
        this.cur = 0;
        this.bitIdx = 0;
        this.sr = 0;
        const kind = opener(s, 'ZCZC') >= 3 ? 'header' : opener(s, 'NNNN') >= 3 ? 'eom' : null;
        if (!kind)
            return;
        const now = this.t;
        if (this.group && (this.group.kind !== kind || now - this.group.lastT > 4 * this.rate))
            this.finalize();
        if (!this.group)
            this.group = { kind, copies: [], lastT: now };
        this.group.copies.push(s);
        this.group.lastT = now;
        if (this.group.copies.length >= 3)
            this.finalize();
    }
    finalize() {
        const g = this.group;
        this.group = null;
        if (!g)
            return;
        const copies = [...g.copies].sort((a, b) => Number(headerEnd(b) > 0 || b === 'NNNN') - Number(headerEnd(a) > 0 || a === 'NNNN'));
        const len = Math.max(...copies.map(c => c.length));
        let voted = '';
        for (let i = 0; i < len; i++) {
            const tally = new Map();
            let best = '', bestN = 0;
            for (const c of copies) {
                if (i >= c.length)
                    continue;
                const n = (tally.get(c[i]) ?? 0) + 1;
                tally.set(c[i], n);
                if (n > bestN) {
                    bestN = n;
                    best = c[i];
                }
            }
            voted += best;
        }
        const repeats = copies.length;
        if (g.kind === 'eom') {
            if (voted.startsWith('NNNN'))
                this.emit({ type: 'same', event: 'eom', raw: 'NNNN', repeats });
            return;
        }
        const raw = voted.slice(0, headerEnd(voted));
        const header = raw ? parseSameHeader(raw) : null;
        if (header)
            this.emit({ type: 'same', event: 'header', header, raw, repeats });
    }
    tone(x) {
        for (let k = 0; k < 3; k++) {
            const s0 = x + this.coef[k] * this.g1[k] - this.g2[k];
            this.g2[k] = this.g1[k];
            this.g1[k] = s0;
        }
        this.energy += x * x;
        if (++this.blockI < this.blockN)
            return;
        const N = this.blockN, e = this.energy;
        const frac = (k) => { const p = this.g1[k] * this.g1[k] + this.g2[k] * this.g2[k] - this.coef[k] * this.g1[k] * this.g2[k]; return e > 0 ? 2 * p / (N * e) : 0; };
        const f1050 = frac(0), f853 = frac(1), f960 = frac(2);
        this.g1 = [0, 0, 0];
        this.g2 = [0, 0, 0];
        this.energy = 0;
        this.blockI = 0;
        const kind = f1050 > 0.6 ? '1050 Hz' : (f853 > 0.25 && f960 > 0.25 && f853 + f960 > 0.6) ? '853+960 Hz' : '';
        if (kind && kind === this.toneKind) {
            this.toneRun++;
            this.toneQuiet = 0;
        }
        else if (kind) {
            this.toneKind = kind;
            this.toneRun = 1;
            this.toneQuiet = 0;
        }
        else if (++this.toneQuiet >= 4) {
            this.toneRun = 0;
            this.toneKind = '';
            this.toneArmed = true;
        }
        if (this.toneArmed && this.toneRun >= 10) {
            this.toneArmed = false;
            this.emit({ type: 'same', event: 'tone', raw: this.toneKind, repeats: 1 });
        }
    }
}
