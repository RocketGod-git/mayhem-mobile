import { AmbeDecoder, golay208, popcount, c0Clean } from './mbe.js';
import { RealFir, lowpassTaps } from './filters.js';
import { P25Decoder } from './p25.js';
import { ImbeDecoder } from './imbe.js';
const RATE = 48000, SPS = 10, SLOT = 144, RING = 4096, MASK = RING - 1;
const rW = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2];
const rX = [23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4];
const rY = [0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3];
const rZ = [5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4, 14, 3, 13, 2, 12, 1, 11, 0];
function fromHex(hex) {
    const out = [];
    for (const ch of hex) {
        const v = parseInt(ch, 16);
        out.push((v & 8) ? -1 : 1, (v & 2) ? -1 : 1);
    }
    return Int8Array.from(out);
}
const fromSigns = (s) => Int8Array.from([...s].map(c => c === '1' ? 1 : -1));
const inv = (a) => a.map(v => -v);
const SYNCS = [
    { proto: 'DMR', kind: 'voice', src: 'BS', s: fromHex('755FD7DF75F7'), sp: 10, thr: 0.82 },
    { proto: 'DMR', kind: 'data', src: 'BS', s: fromHex('DFF57D75DF5D'), sp: 10, thr: 0.82 },
    { proto: 'DMR', kind: 'voice', src: 'MS', s: fromHex('7F7D5DD57DFD'), sp: 10, thr: 0.82 },
    { proto: 'DMR', kind: 'data', src: 'MS', s: fromHex('D5D7F77FD757'), sp: 10, thr: 0.82 },
    { proto: 'DMR', kind: 'voice', src: 'DM1', s: fromHex('5D577F7757FF'), sp: 10, thr: 0.82 },
    { proto: 'DMR', kind: 'data', src: 'DM1', s: fromHex('F7FDD5DDFD55'), sp: 10, thr: 0.82 },
    { proto: 'DMR', kind: 'voice', src: 'DM2', s: fromHex('7DFFD5F55D5F'), sp: 10, thr: 0.82 },
    { proto: 'DMR', kind: 'data', src: 'DM2', s: fromHex('D7557F5FF7F5'), sp: 10, thr: 0.82 },
    { proto: 'P25', kind: '', src: '', s: fromHex('5575F5FF77FF'), sp: 10, thr: 0.86 },
    { proto: 'P25', kind: '', src: 'inv', s: inv(fromHex('5575F5FF77FF')), sp: 10, thr: 0.86 },
    { proto: 'D-STAR', kind: '', src: '', s: fromSigns('313131313133131113313111'), sp: 10, thr: 0.95 },
    { proto: 'D-STAR', kind: '', src: 'inv', s: inv(fromSigns('313131313133131113313111')), sp: 10, thr: 0.95 },
    { proto: 'YSF', kind: '', src: '', s: fromHex('D471C9634D'), sp: 10, thr: 0.95 },
    { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131111333'), sp: 20, thr: 0.95 },
    { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131113133'), sp: 20, thr: 0.95 },
    { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131111313'), sp: 20, thr: 0.95 },
    { proto: 'NXDN', kind: '', src: '', s: fromSigns('313133113131113113'), sp: 20, thr: 0.95 },
    { proto: 'NXDN', kind: '', src: 'inv', s: inv(fromSigns('313133113131111333')), sp: 20, thr: 0.95 },
    { proto: 'NXDN', kind: '', src: 'inv', s: inv(fromSigns('313133113131113133')), sp: 20, thr: 0.95 },
];
const DMR_SYNCS = SYNCS.filter(s => s.proto === 'DMR');
function hamming(bits, off, k, eq) {
    let syn = 0;
    for (let p = 0; p < eq.length; p++) {
        let c = 0;
        const m = eq[p];
        for (let i = 0; i < k; i++)
            if (m & (1 << i))
                c ^= bits[off + i];
        syn |= (c ^ bits[off + k + p]) << p;
    }
    if (syn === 0)
        return 0;
    for (let i = 0; i < k; i++) {
        let col = 0;
        for (let p = 0; p < eq.length; p++)
            if (eq[p] & (1 << i))
                col |= 1 << p;
        if (col === syn) {
            bits[off + i] ^= 1;
            return 1;
        }
    }
    for (let p = 0; p < eq.length; p++)
        if (syn === (1 << p)) {
            bits[off + k + p] ^= 1;
            return 1;
        }
    return -1;
}
const mask = (...idx) => idx.reduce((m, i) => m | (1 << i), 0);
const H15113 = [mask(0, 1, 2, 3, 5, 7, 8), mask(1, 2, 3, 4, 6, 8, 9), mask(2, 3, 4, 5, 7, 9, 10), mask(0, 1, 2, 4, 6, 7, 10)];
const H16114 = [...H15113, mask(0, 2, 5, 6, 8, 9, 10)];
const H1393 = [mask(0, 1, 3, 5, 6), mask(0, 1, 2, 4, 6, 7), mask(0, 1, 2, 3, 5, 7, 8), mask(0, 2, 4, 5, 8)];
function bptc(raw) {
    const de = new Uint8Array(196), col = new Uint8Array(13);
    for (let a = 0; a < 196; a++)
        de[a] = raw[(a * 181) % 196];
    for (let pass = 0; pass < 5; pass++) {
        let fixing = false;
        for (let c = 0; c < 15; c++) {
            for (let a = 0; a < 13; a++)
                col[a] = de[c + 1 + a * 15];
            if (hamming(col, 0, 9, H1393) === 1) {
                fixing = true;
                for (let a = 0; a < 13; a++)
                    de[c + 1 + a * 15] = col[a];
            }
        }
        for (let r = 0; r < 9; r++)
            if (hamming(de, r * 15 + 1, 11, H15113) === 1)
                fixing = true;
        if (!fixing)
            break;
    }
    const out = new Uint8Array(12);
    let pos = 0;
    const take = (a) => { if (de[a])
        out[pos >> 3] |= 0x80 >> (pos & 7); pos++; };
    for (let a = 4; a <= 11; a++)
        take(a);
    for (let r = 1; r < 9; r++)
        for (let a = r * 15 + 1; a <= r * 15 + 11; a++)
            take(a);
    return out;
}
const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100)
            x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++)
        GF_EXP[i] = GF_EXP[i - 255];
}
const gmul = (a, b) => a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
const RS_POLY = [64, 56, 14, 1];
function rs129ok(b) {
    const par = [0, 0, 0, 0];
    for (let i = 0; i < 9; i++) {
        const d = b[i] ^ par[2];
        par[2] = par[1] ^ gmul(RS_POLY[2], d);
        par[1] = par[0] ^ gmul(RS_POLY[1], d);
        par[0] = gmul(RS_POLY[0], d);
    }
    return b[9] === par[2] && b[10] === par[1] && b[11] === par[0];
}
const CRC_T = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++)
        c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    CRC_T[i] = c;
}
function crcOk(b, n) {
    let crc = 0;
    for (let i = 0; i < n - 2; i++)
        crc = ((crc << 8) & 0xffff) ^ CRC_T[((crc >> 8) ^ b[i]) & 0xff];
    crc = ~crc & 0xffff;
    return (crc >> 8) === b[n - 2] && (crc & 0xff) === b[n - 1];
}
function qrSyn(x) { for (let i = 14; i >= 8; i--)
    if (x & (1 << i))
        x ^= 0x139 << (i - 8); return x & 0xff; }
const QR_FIX = new Int16Array(256).fill(-1);
QR_FIX[0] = 0;
for (let i = 0; i < 15; i++) {
    QR_FIX[qrSyn(1 << i)] = 1 << i;
    for (let j = i + 1; j < 15; j++)
        QR_FIX[qrSyn((1 << i) | (1 << j))] = (1 << i) | (1 << j);
}
function qr167(word15) { const e = QR_FIX[qrSyn(word15)]; return e < 0 ? -1 : ((word15 ^ e) >> 8) | (popcount(e) << 8); }
function parseLc(b) { return { flco: b[0] & 0x3f, fid: b[1], opts: b[2], dst: b[3] << 16 | b[4] << 8 | b[5], src: b[6] << 16 | b[7] << 8 | b[8] }; }
class EmbeddedLc {
    constructor() {
        this.raw = new Uint8Array(128);
        this.state = 0;
    }
    reset() { this.state = 0; }
    add(frag, lcss) {
        if (lcss === 1) {
            this.raw.set(frag, 0);
            this.state = 1;
            return null;
        }
        if (lcss === 3 && this.state === 1) {
            this.raw.set(frag, 32);
            this.state = 2;
            return null;
        }
        if (lcss === 3 && this.state === 2) {
            this.raw.set(frag, 64);
            this.state = 3;
            return null;
        }
        if (lcss === 2 && this.state === 3) {
            this.raw.set(frag, 96);
            this.state = 0;
            return this.decode();
        }
        if (lcss !== 0)
            this.state = 0;
        return null;
    }
    decode() {
        const data = new Uint8Array(128);
        for (let a = 0, b = 0; a < 128; a++) {
            data[b] = this.raw[a];
            b += 16;
            if (b > 127)
                b -= 127;
        }
        for (let a = 0; a < 112; a += 16)
            if (hamming(data, a, 11, H16114) < 0)
                return null;
        for (let a = 0; a < 16; a++) {
            let p = 0;
            for (let r = 0; r < 8; r++)
                p ^= data[a + 16 * r];
            if (p)
                return null;
        }
        const bytes = new Uint8Array(9);
        let pos = 0;
        const take = (a) => { if (data[a])
            bytes[pos >> 3] |= 0x80 >> (pos & 7); pos++; };
        for (let a = 0; a < 11; a++)
            take(a);
        for (let a = 16; a < 27; a++)
            take(a);
        for (let a = 32; a < 42; a++)
            take(a);
        for (let a = 48; a < 58; a++)
            take(a);
        for (let a = 64; a < 74; a++)
            take(a);
        for (let a = 80; a < 90; a++)
            take(a);
        for (let a = 96; a < 106; a++)
            take(a);
        const crc = data[42] << 4 | data[58] << 3 | data[74] << 2 | data[90] << 1 | data[106];
        let sum = 0;
        for (let i = 0; i < 9; i++)
            sum += bytes[i];
        return sum % 31 === crc ? bytes : null;
    }
}
const FIDS = { 0: '', 16: 'MOTOROLA', 104: 'HYTERA', 6: 'TRIDENT', 8: 'SELEX', 51: 'SIMOCO', 60: 'RADIODATA', 88: 'TAIT' };
const CSBKO = { 0x04: 'UNIT-TO-UNIT REQUEST', 0x05: 'UNIT-TO-UNIT ANSWER', 0x07: 'CHANNEL TIMING', 0x1c: 'AHOY', 0x1f: 'CALL ALERT', 0x20: 'CALL ALERT ACK', 0x21: 'ACK', 0x24: 'RADIO CHECK', 0x26: 'NACK', 0x27: 'EMERGENCY', 0x28: 'BROADCAST', 0x2a: 'MAINTENANCE', 0x2e: 'CLEAR', 0x30: 'PRIVATE VOICE GRANT', 0x31: 'TALKGROUP VOICE GRANT', 0x38: 'BS OUTBOUND ACTIVATION', 0x3d: 'PREAMBLE' };
const DATA_TYPES = ['PI HEADER', 'VOICE HEADER', 'END OF CALL', 'CSBK', 'MBC HEADER', 'MBC', 'DATA HEADER', 'RATE ½ DATA', 'RATE ¾ DATA', 'IDLE', 'RATE 1 DATA'];
class TimeSlot {
    constructor() {
        this.voice = false;
        this.seq = -1;
        this.tg = 0;
        this.src = 0;
        this.group = true;
        this.alias = '';
        this.cc = -1;
        this.last = '';
        this.since = 0;
        this.errs = 0;
        this.frames = 0;
        this.lastLog = '';
        this.lastLogAt = -1e9;
        this.ambe = new AmbeDecoder();
        this.emb = new EmbeddedLc();
        this.aliasParts = ['', '', '', ''];
        this.aliasFmt = 1;
    }
    setLc(lc) {
        if (lc.flco >= 4 && lc.flco <= 7) {
            this.talkerAlias(lc);
            return false;
        }
        if (lc.flco === 8)
            return false;
        const changed = lc.dst !== this.tg || lc.src !== this.src;
        this.tg = lc.dst;
        this.src = lc.src;
        this.group = lc.flco === 0;
        return changed;
    }
    status() { return { voice: this.voice, tg: this.tg, src: this.src, group: this.group, alias: this.alias, cc: this.cc, last: this.last, since: this.since, errs: this.frames ? this.errs / this.frames : 0 }; }
    endCall() { this.voice = false; this.seq = -1; this.emb.reset(); this.ambe.reset(); }
    talkerAlias(lc) {
        const b = [lc.opts, lc.dst >> 16 & 255, lc.dst >> 8 & 255, lc.dst & 255, lc.src >> 16 & 255, lc.src >> 8 & 255, lc.src & 255];
        const idx = lc.flco - 4;
        let text = '';
        if (idx === 0) {
            this.aliasFmt = b[0] >> 6;
            this.aliasParts = ['', '', '', ''];
        }
        const fmt = this.aliasFmt;
        if (fmt === 0) {
            const bits = [];
            for (const v of b)
                for (let i = 7; i >= 0; i--)
                    bits.push((v >> i) & 1);
            for (let p = idx === 0 ? 7 : 0; p + 7 <= bits.length; p += 7) {
                let c = 0;
                for (let i = 0; i < 7; i++)
                    c = c << 1 | bits[p + i];
                if (c >= 32)
                    text += String.fromCharCode(c);
            }
        }
        else if (fmt === 3) {
            for (let i = idx === 0 ? 1 : 0; i + 1 < b.length; i += 2) {
                const c = b[i] << 8 | b[i + 1];
                if (c >= 32)
                    text += String.fromCharCode(c);
            }
        }
        else {
            const bytes = b.slice(idx === 0 ? 1 : 0).filter(v => v !== 0);
            try {
                text = fmt === 2 ? new TextDecoder('utf-8').decode(Uint8Array.from(bytes)) : String.fromCharCode(...bytes);
            }
            catch {
                text = '';
            }
        }
        this.aliasParts[idx] = text.replace(/[\x00-\x1f]/g, '');
        this.alias = this.aliasParts.join('').trim();
    }
}
export class DmrDecoder {
    onFm(samples, n, rate) { if (rate === RATE)
        this.push(samples, n); }
    constructor() {
        this.onAudio = () => { };
        this.onLog = () => { };
        this.slotSel = 0;
        this.minHalf = 6500;
        this.lp = new RealFir(lowpassTaps(4200 / RATE, 95));
        this.tmp = new Float32Array(0);
        this.ring = new Float32Array(RING);
        this.n = 0;
        this.locked = false;
        this.symNext = 0;
        this.center = 0;
        this.lvl = 0.25;
        this.sorted = new Float32Array(SLOT);
        this.inverted = false;
        this.polOk = 0;
        this.polBad = 0;
        this.confirmed = false;
        this.validCount = 0;
        this.sps = SPS;
        this.lastFireT = -1e9;
        this.ccVotes = new Float32Array(16);
        this.soft = new Float32Array(SLOT);
        this.dib = new Uint8Array(SLOT);
        this.pos = 0;
        this.frame = 0;
        this.parity = 0;
        this.simplexPhase = -1;
        this.msDual = false;
        this.msOther = 0;
        this.p25 = new P25Decoder();
        this.imbe = new ImbeDecoder();
        this.p25On = false;
        this.mode = 'dmr';
        this.dmrFrameN = -1e9;
        this.lastSyncN = -1e9;
        this.syncCount = 0;
        this.source = '';
        this.cc = -1;
        this.ts = [new TimeSlot(), new TimeSlot()];
        this.audioSlot = 0;
        this.candCorr = 0;
        this.candN = 0;
        this.candSync = null;
        this.v24 = new Float32Array(24);
        this.v18 = new Float32Array(18);
        this.v18a = new Float32Array(18);
        this.v18b = new Float32Array(18);
        this.dvName = '';
        this.dvAt = -1e9;
        this.dvCount = 0;
        this.up = new RealFir(lowpassTaps(3400 / RATE, 47));
        this.upIn = new Float32Array(960);
        this.upOut = new Float32Array(960);
        this.fr = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
        this.raw196 = new Uint8Array(196);
        this.frag = new Uint8Array(32);
        this.lastIdleLog = 0;
        this.lastLine = '';
        this.lastLineAt = -1e9;
        this.lockLine = '';
        this.p25.onVoice = bits => { const pcm = this.imbe.decodeVoice(bits); if (this.mode === 'p25')
            this.emitAudio(pcm); };
    }
    reset() {
        this.imbe.reset();
        this.lp.reset();
        this.up.reset();
        this.ring.fill(0);
        this.n = 0;
        this.locked = false;
        this.pos = 0;
        this.frame = 0;
        this.parity = 0;
        this.lastSyncN = -1e9;
        this.syncCount = 0;
        this.cc = -1;
        this.source = '';
        this.candSync = null;
        this.candCorr = 0;
        this.simplexPhase = -1;
        this.msDual = false;
        this.msOther = 0;
        this.mode = 'dmr';
        this.dmrFrameN = -1e9;
        this.p25.reset();
        for (const t of this.ts) {
            t.endCall();
            t.tg = 0;
            t.src = 0;
            t.alias = '';
            t.last = '';
            t.cc = -1;
            t.errs = 0;
            t.frames = 0;
        }
        this.polOk = this.polBad = 0;
        this.confirmed = false;
        this.sps = SPS;
        this.ccVotes.fill(0);
        this.validCount = 0;
        this.dvName = '';
        this.dvAt = -1e9;
        this.dvCount = 0;
    }
    get samples() { return this.n; }
    status() {
        const now = this.n;
        const dv = now - this.dvAt < 2 * RATE && this.dvCount >= 3 ? this.dvName : '';
        let bestVotes = 0;
        for (let i = 0; i < 16; i++)
            if (this.ccVotes[i] > bestVotes)
                bestVotes = this.ccVotes[i];
        return { locked: this.locked && this.confirmed, proto: this.locked ? 'DMR' : '', source: this.source, cc: this.cc, level: this.lvl, syncs: this.syncCount, slots: [this.ts[0].status(), this.ts[1].status()], audioSlot: this.audioSlot + 1, dv, dvCount: this.dvCount, inverted: this.inverted, strong: this.locked && this.confirmed && (this.validCount >= 2 || bestVotes >= 4) };
    }
    push(disc, n) {
        if (this.tmp.length < n)
            this.tmp = new Float32Array(n);
        const y = this.tmp, ring = this.ring;
        this.lp.process(disc, n, y);
        for (let i = 0; i < n; i++) {
            const t = this.n;
            ring[t & MASK] = y[i];
            let search = !this.locked;
            if (this.locked) {
                const r = ((t - this.symNext) % SPS + SPS) % SPS;
                search = r < 1.5 || r > 8.5;
            }
            if (search)
                this.checkSync(t);
            if (this.candSync && t - this.candN >= 6) {
                const s = this.candSync, cn = this.candN;
                this.candSync = null;
                this.candCorr = 0;
                this.fire(s, cn);
            }
            if (this.locked) {
                while (this.symNext + 1 <= t) {
                    const x = this.interp(this.symNext);
                    this.symNext += this.sps;
                    if (this.mode === 'p25') {
                        this.p25.push(this.slice(x), this.n);
                        continue;
                    }
                    this.soft[this.pos] = x;
                    this.dib[this.pos] = this.slice(x);
                    if (++this.pos >= SLOT) {
                        this.pos = 0;
                        this.processSlot();
                    }
                }
                const alive = this.mode === 'p25' ? Math.max(this.lastSyncN, this.p25.lastFrame) : this.lastSyncN;
                if (t - alive > 2 * RATE) {
                    this.locked = false;
                    for (const ts of this.ts)
                        ts.endCall();
                    if (this.confirmed)
                        this.log(this.mode === 'p25' ? 'P25 lost' : 'DMR lost');
                    this.confirmed = false;
                    if (this.mode === 'p25')
                        this.p25.idle();
                    this.mode = 'dmr';
                    this.polOk = this.polBad = 0;
                    this.simplexPhase = -1;
                    this.msDual = false;
                    this.msOther = 0;
                    this.ccVotes.fill(0);
                }
            }
            this.n++;
        }
    }
    interp(t) {
        const i = Math.floor(t), f = t - i;
        return this.ring[i & MASK] * (1 - f) + this.ring[(i + 1) & MASK] * f;
    }
    slice(x) {
        const d = this.inverted ? this.center - x : x - this.center, thr = this.lvl * 2 / 3;
        return d > thr ? 1 : d > 0 ? 0 : d > -thr ? 2 : 3;
    }
    kindOf(s) { return this.inverted ? (s.kind === 'voice' ? 'data' : 'voice') : s.kind; }
    polarity(ok) {
        if (ok) {
            this.polOk++;
            if (this.polOk >= 3 && !this.confirmed) {
                this.confirmed = true;
                this.log(`${this.lockLine}${this.inverted ? ' · inverted' : ''}`);
            }
            if (this.polOk > 12) {
                this.polOk = 12;
                this.polBad = 0;
            }
            return;
        }
        this.polBad++;
        if (this.polBad >= 4 && this.polOk < 3) {
            this.inverted = !this.inverted;
            this.polBad = 0;
            this.polOk = 0;
            for (const ts of this.ts)
                ts.endCall();
        }
        else if (this.polBad >= 24) {
            this.polOk = 0;
            this.polBad = 0;
            this.confirmed = false;
        }
    }
    ccVote(cc, errs) {
        const v = this.ccVotes;
        let best = 0;
        for (let i = 1; i < 16; i++)
            if (v[i] > v[best])
                best = i;
        if (v[best] >= 3 && cc !== best)
            return false;
        if (errs <= 1 || v[best] < 3) {
            for (let i = 0; i < 16; i++)
                v[i] *= 0.95;
            v[cc] += 1;
            return true;
        }
        return false;
    }
    checkSync(t) {
        const ring = this.ring, v24 = this.v24, v18 = this.v18, v18a = this.v18a, v18b = this.v18b;
        let a24 = 0, a20 = 0, min24 = Infinity;
        for (let k = 0; k < 24; k++) {
            const x = ring[(t - (23 - k) * 10) & MASK];
            v24[k] = x;
            const a = x < 0 ? -x : x;
            a24 += a;
            if (k >= 4)
                a20 += a;
            if (a < min24)
                min24 = a;
        }
        if (a24 < 1e-4)
            return;
        const strong = min24 > 0.3 * (a24 / 24);
        const nxdn = !this.locked;
        let a18 = 0, a18a = 0, a18b = 0, min18 = Infinity;
        if (nxdn)
            for (let k = 0; k < 18; k++) {
                const i = t - (17 - k) * 20, x = ring[i & MASK], xa = ring[(i - 5) & MASK], xb = ring[(i + 5) & MASK];
                v18[k] = x;
                v18a[k] = xa;
                v18b[k] = xb;
                const ax = x < 0 ? -x : x, aa = xa < 0 ? -xa : xa, ab = xb < 0 ? -xb : xb;
                a18 += ax;
                a18a += aa;
                a18b += ab;
                if (ax < min18)
                    min18 = ax;
                if (aa < min18)
                    min18 = aa;
                if (ab < min18)
                    min18 = ab;
            }
        const strong18 = nxdn && min18 > 0.3 * (a18 / 18);
        let min20 = Infinity;
        for (let k = 4; k < 24; k++) {
            const a = v24[k] < 0 ? -v24[k] : v24[k];
            if (a < min20)
                min20 = a;
        }
        const strong20 = min20 > 0.15 * (a20 / 20);
        for (const s of SYNCS) {
            if (!this.wants(s))
                continue;
            let c = 0, a;
            if (s.sp === 20) {
                if (!strong18)
                    continue;
                let ca = 0, cb = 0;
                for (let k = 0; k < 18; k++) {
                    c += v18[k] * s.s[k];
                    ca += v18a[k] * s.s[k];
                    cb += v18b[k] * s.s[k];
                }
                if (ca / a18a < s.thr || cb / a18b < s.thr)
                    continue;
                a = a18;
            }
            else if (s.s.length === 20) {
                for (let k = 0; k < 20; k++)
                    c += v24[k + 4] * s.s[k];
                a = a20;
            }
            else {
                for (let k = 0; k < 24; k++)
                    c += v24[k] * s.s[k];
                a = a24;
            }
            const corr = c / a;
            if (corr < s.thr)
                continue;
            if (s.proto === 'YSF' ? !strong20 : s.sp !== 20 && !strong)
                continue;
            if (corr > this.candCorr) {
                this.candCorr = corr;
                this.candN = t;
                this.candSync = s;
            }
        }
    }
    wants(s) {
        if (!this.locked)
            return true;
        if (this.mode === 'p25' && this.n - this.p25.lastFrame < RATE / 2)
            return s.proto === 'P25';
        if (this.mode === 'dmr' && this.n - this.dmrFrameN < RATE / 2)
            return s.proto === 'DMR';
        return true;
    }
    fire(s, n0) {
        const wantP25 = s.proto === 'P25' && this.p25On;
        if (s.proto !== 'DMR' && !wantP25) {
            if (this.locked)
                return;
            if (this.dvName !== s.proto || this.n - this.dvAt > 2 * RATE)
                this.dvCount = 0;
            this.dvName = s.proto;
            this.dvAt = this.n;
            this.dvCount++;
            if (this.dvCount === 3)
                this.log(`${s.proto} sync detected (identification only)`);
            return;
        }
        if (wantP25 && this.mode === 'dmr' && this.locked && this.n - this.dmrFrameN < RATE / 2)
            return;
        if (s.proto === 'DMR' && this.mode === 'p25' && this.n - this.p25.lastFrame < RATE / 2)
            return;
        const corrAt = (t) => { let c = 0; for (let k = 0; k < 24; k++)
            c += this.interp(t - (23 - k) * 10) * s.s[k]; return c; };
        const cm = corrAt(n0 - 1), c0 = corrAt(n0), cp = corrAt(n0 + 1);
        const den = cm - 2 * c0 + cp;
        let delta = den < 0 ? 0.5 * (cm - cp) / den : 0;
        if (delta > 0.5)
            delta = 0.5;
        else if (delta < -0.5)
            delta = -0.5;
        const t0 = n0 + delta;
        if (this.locked && t0 - this.lastFireT < RATE) {
            const prev = this.symNext - this.sps, e = t0 - prev, err = e - Math.round(e / this.sps) * this.sps;
            const symbols = (t0 - this.lastFireT) / this.sps;
            if (Math.abs(err) < 3 && symbols >= 100)
                this.sps += 0.2 * err / symbols;
            if (this.sps > SPS * 1.01)
                this.sps = SPS * 1.01;
            else if (this.sps < SPS * 0.99)
                this.sps = SPS * 0.99;
        }
        this.lastFireT = t0;
        let sp = 0, sn = 0, np = 0, nn = 0;
        for (let k = 0; k < 24; k++) {
            const x = this.interp(t0 - (23 - k) * 10);
            if (s.s[k] > 0) {
                sp += x;
                np++;
            }
            else {
                sn += x;
                nn++;
            }
        }
        const mp = sp / np, mn = sn / nn, center = (mp + mn) / 2, lvl = (mp - mn) / 2;
        if (lvl < 0.01)
            return;
        if (!this.locked) {
            this.center = center;
            this.lvl = lvl;
            this.lockLine = `${s.proto} sync (${s.src || 'P25'}) · deviation ${(lvl * RATE / (2 * Math.PI)).toFixed(0)} Hz`;
        }
        else {
            this.center += 0.5 * (center - this.center);
            this.lvl += 0.5 * (lvl - this.lvl);
        }
        if (wantP25) {
            if (this.mode !== 'p25') {
                this.mode = 'p25';
                this.p25.idle();
                this.imbe.reset();
                this.confirmed = true;
                this.log(this.lockLine);
            }
            this.inverted = s.src === 'inv';
            this.symNext = t0 + this.sps;
            this.locked = true;
            this.lastSyncN = t0;
            this.syncCount++;
            this.source = 'P25';
            this.p25.sync(this.n);
            return;
        }
        if (this.mode !== 'dmr') {
            this.mode = 'dmr';
            this.p25.idle();
            this.confirmed = false;
            this.polOk = this.polBad = 0;
        }
        for (let k = 0; k < 90; k++) {
            const x = this.interp(t0 - (89 - k) * this.sps);
            this.soft[k] = x;
            this.dib[k] = this.slice(x);
        }
        this.symNext = t0 + this.sps;
        this.pos = 90;
        this.locked = true;
        this.lastSyncN = t0;
        this.syncCount++;
        this.source = s.src;
    }
    matchCenter(thr) {
        const soft = this.soft;
        let a = 0;
        for (let k = 0; k < 24; k++) {
            const x = soft[66 + k] - this.center;
            a += x < 0 ? -x : x;
        }
        if (a < 24 * 0.4 * this.lvl)
            return null;
        let best = null, bestC = thr;
        for (const s of DMR_SYNCS) {
            let c = 0;
            for (let k = 0; k < 24; k++)
                c += (soft[66 + k] - this.center) * s.s[k];
            c /= a;
            if (c > bestC) {
                bestC = c;
                best = s;
            }
        }
        return best;
    }
    processSlot() {
        const dib = this.dib;
        this.parity ^= 1;
        this.frame = this.simplexPhase >= 0 ? 0 : this.parity;
        let ts = this.ts[this.frame];
        const sync = this.matchCenter(ts.voice && ts.seq >= 5 ? 0.6 : 0.72);
        if (sync) {
            this.lastSyncN = this.n;
            this.syncCount++;
            this.source = sync.src;
            this.dmrFrameN = this.n;
            if (sync.src === 'MS') {
                if (this.msDual)
                    this.frame = this.parity;
                else if (this.simplexPhase < 0) {
                    this.simplexPhase = this.parity;
                    this.frame = 0;
                }
                else if (this.parity === this.simplexPhase) {
                    this.frame = 0;
                    this.msOther = 0;
                }
                else if (++this.msOther >= 6) {
                    this.msDual = true;
                    this.simplexPhase = -1;
                    this.frame = this.parity;
                }
                else
                    return;
                ts = this.ts[this.frame];
            }
            else if (sync.src === 'BS') {
                this.simplexPhase = -1;
                this.frame = (dib[2] >> 1) & 1;
                this.parity = this.frame;
                ts = this.ts[this.frame];
            }
            else if (sync.src === 'DM1') {
                this.simplexPhase = -1;
                this.frame = this.parity = 0;
                ts = this.ts[0];
            }
            else if (sync.src === 'DM2') {
                this.simplexPhase = -1;
                this.frame = this.parity = 1;
                ts = this.ts[1];
            }
        }
        else if (this.simplexPhase >= 0 && this.parity !== this.simplexPhase)
            return;
        if (!sync) {
            const sorted = this.sorted;
            sorted.set(this.soft);
            sorted.sort();
            let lo = 0, hi = 0;
            for (let k = 0; k < 36; k++) {
                lo += sorted[k];
                hi += sorted[SLOT - 1 - k];
            }
            lo /= 36;
            hi /= 36;
            if (hi - lo > 0.02) {
                this.center += 0.1 * ((hi + lo) / 2 - this.center);
                this.lvl += 0.1 * ((hi - lo) / 2 - this.lvl);
            }
        }
        const kind = sync ? this.kindOf(sync) : '';
        if (kind === 'data')
            this.dataBurst(ts);
        else if (kind === 'voice') {
            ts.seq = 0;
            ts.emb.reset();
            if (this.confirmed) {
                if (!ts.voice && this.cc >= 0 && ts.cc === this.cc) {
                    ts.since = this.n;
                    ts.ambe.reset();
                    if (this.slotSel === 0)
                        this.audioSlot = this.frame;
                    ts.voice = true;
                    this.logLine(ts, 'VOICE');
                }
                if (ts.voice)
                    this.voiceBurst(ts);
                else
                    this.voiceEvidence(ts);
            }
            else
                this.voiceEvidence(ts);
        }
        else if (ts.seq >= 0 && ts.seq < 5) {
            ts.seq++;
            this.embedded(ts);
            if (ts.voice && this.confirmed)
                this.voiceBurst(ts);
            else
                this.voiceEvidence(ts);
        }
        else if (ts.voice) {
            ts.endCall();
            this.logLine(ts, 'voice stopped');
        }
        else
            ts.seq = -1;
    }
    voiceEvidence(ts) {
        const dib = this.dib, fr = this.fr;
        for (const row of fr)
            row.fill(0);
        for (let i = 0; i < 36; i++) {
            const d = dib[12 + i];
            fr[rW[i]][rX[i]] = d >> 1;
            fr[rY[i]][rZ[i]] = d & 1;
        }
        this.polarity(c0Clean(fr[0]));
        if (!this.confirmed)
            ts.voice = false;
    }
    dataBurst(ts) {
        const dib = this.dib;
        let st = 0;
        for (let i = 61; i <= 65; i++)
            st = st << 2 | dib[i];
        for (let i = 90; i <= 94; i++)
            st = st << 2 | dib[i];
        const code = golay208(st >>> 1);
        const dt = code < 0 ? -1 : code & 15, errs = code < 0 ? 9 : code >> 8, cc = code < 0 ? -1 : (code >> 4) & 15;
        const clean = dt >= 0 && dt <= 10 && errs <= 1 && (st >>> 1) !== 0;
        this.polarity(clean);
        if (dt < 0 || dt > 10 || (st >>> 1) === 0 || !this.confirmed || !this.ccVote(cc, errs))
            return;
        this.cc = cc;
        ts.cc = cc;
        const wasVoice = ts.voice && this.confirmed;
        ts.endCall();
        const raw = this.raw196;
        let p = 0;
        for (let i = 12; i <= 60; i++) {
            raw[p++] = dib[i] >> 1;
            raw[p++] = dib[i] & 1;
        }
        for (let i = 95; i <= 143; i++) {
            raw[p++] = dib[i] >> 1;
            raw[p++] = dib[i] & 1;
        }
        const name = DATA_TYPES[dt] ?? `DATA TYPE ${dt}`;
        if (dt === 1 || dt === 2) {
            const b = bptc(raw);
            const m = dt === 1 ? 0x96 : 0x99;
            b[9] ^= m;
            b[10] ^= m;
            b[11] ^= m;
            if (rs129ok(b)) {
                this.validCount++;
                const lc = parseLc(b);
                ts.setLc(lc);
                this.logLine(ts, dt === 1 ? 'VOICE HEADER' : 'END OF CALL');
            }
            else
                this.logLine(ts, `${name} (bad RS)`);
        }
        else if (dt === 3 || dt === 4) {
            const b = bptc(raw);
            const m = dt === 3 ? 0xa5 : 0xaa;
            b[10] ^= m;
            b[11] ^= m;
            if (crcOk(b, 12)) {
                this.validCount++;
                const op = b[0] & 0x3f, fid = b[1];
                const dst = b[4] << 16 | b[5] << 8 | b[6], src = b[7] << 16 | b[8] << 8 | b[9];
                const vendor = FIDS[fid] ?? `FID ${fid}`;
                if (fid !== 0)
                    this.logLine(ts, `${vendor} CSBK 0x${op.toString(16).padStart(2, '0')} · ${Array.from(b.subarray(2, 10), v => v.toString(16).padStart(2, '0')).join(' ')}`);
                else {
                    const opName = CSBKO[op] ?? `CSBK 0x${op.toString(16)}`;
                    const detail = op === 0x38 ? `BS ${dst} ← ${src}` : op === 0x26 ? `→ ${dst} from ${src}` : `${(b[2] & 0x40) && op === 0x3d ? 'TG' : 'ID'} ${dst} ← ${src}`;
                    this.logLine(ts, `${opName} · ${detail}`);
                }
            }
            else
                this.logLine(ts, `${name} (bad CRC)`);
        }
        else if (dt === 9) {
            if (this.n - this.lastIdleLog > 5 * RATE) {
                this.lastIdleLog = this.n;
                this.logLine(ts, 'IDLE');
            }
            ts.last = 'IDLE';
        }
        else
            this.logLine(ts, name);
        if (wasVoice && dt !== 2)
            this.logLine(ts, 'voice stopped');
    }
    embedded(ts) {
        const dib = this.dib;
        let emb = 0;
        for (let i = 66; i <= 69; i++)
            emb = emb << 2 | dib[i];
        for (let i = 86; i <= 89; i++)
            emb = emb << 2 | dib[i];
        const code = qr167(emb >>> 1);
        const errs = code < 0 ? 9 : code >> 8, cc = code < 0 ? -1 : (code >> 3) & 15, lcss = code & 3;
        this.polarity(errs === 0);
        if (code < 0 || !this.confirmed || !this.ccVote(cc, errs))
            return;
        this.cc = cc;
        ts.cc = cc;
        const frag = this.frag;
        for (let i = 0; i < 16; i++) {
            frag[2 * i] = dib[70 + i] >> 1;
            frag[2 * i + 1] = dib[70 + i] & 1;
        }
        const lc = ts.emb.add(frag, lcss);
        if (lc) {
            this.validCount++;
            const parsed = parseLc(lc);
            if (ts.setLc(parsed))
                this.logLine(ts, 'VOICE');
            else if (parsed.flco >= 4 && parsed.flco <= 7 && ts.alias)
                this.logLine(ts, `alias ${ts.alias}`);
        }
    }
    voiceBurst(ts) {
        const dib = this.dib, fr = this.fr;
        const play = this.confirmed && this.frame === (this.slotSel === 0 ? this.audioSlot : this.slotSel - 1);
        const decodeOne = (fill) => {
            for (const row of fr)
                row.fill(0);
            for (let i = 0; i < 36; i++) {
                const d = fill(i);
                fr[rW[i]][rX[i]] = d >> 1;
                fr[rY[i]][rZ[i]] = d & 1;
            }
            const pcm = ts.ambe.decode(fr);
            ts.frames++;
            ts.errs += Math.min(1, ts.ambe.errs / 8);
            if (play)
                this.emitAudio(pcm);
        };
        decodeOne(i => dib[12 + i]);
        decodeOne(i => i < 18 ? dib[48 + i] : dib[90 + i - 18]);
        decodeOne(i => dib[108 + i]);
    }
    emitAudio(pcm8k) {
        const inp = this.upIn, out = this.upOut;
        inp.fill(0);
        for (let i = 0; i < 160; i++)
            inp[i * 6] = pcm8k[i] * 6;
        this.up.process(inp, 960, out);
        this.onAudio(out.slice());
    }
    logLine(ts, what) {
        const slot = this.frame + 1;
        const who = ts.tg || ts.src ? ` · ${ts.group ? 'TG' : 'ID'} ${ts.tg} ← ${ts.src}${ts.alias ? ` "${ts.alias}"` : ''}` : '';
        ts.last = what;
        const line = `S${slot} CC${ts.cc >= 0 ? ts.cc : '?'} ${what}${who}`;
        if (line === ts.lastLog && this.n - ts.lastLogAt < 3 * RATE)
            return;
        ts.lastLog = line;
        ts.lastLogAt = this.n;
        this.log(line);
    }
    log(line) {
        if (line === this.lastLine && this.n - this.lastLineAt < 3 * RATE)
            return;
        this.lastLine = line;
        this.lastLineAt = this.n;
        this.onLog(line);
    }
}
