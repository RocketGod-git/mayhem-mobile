const DUID_NAME = {
    0x0: 'HEADER', 0x3: 'TERMINATOR', 0x5: 'VOICE 1', 0x7: 'TRUNKING',
    0xa: 'VOICE 2', 0xc: 'DATA', 0xf: 'TERMINATOR + LC',
};
const DUID_SYMBOLS = { 0x0: 385, 0x3: 70, 0x5: 840, 0x7: 175, 0xa: 840, 0xc: 0, 0xf: 210 };
const GF_EXP = new Uint8Array(128), GF_LOG = new Uint8Array(64);
{
    let x = 1;
    for (let i = 0; i < 63; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x40)
            x ^= 0x43;
    }
    for (let i = 63; i < 126; i++)
        GF_EXP[i] = GF_EXP[i - 63];
}
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
const gdiv = (a, b) => a === 0 ? 0 : GF_EXP[GF_LOG[a] + 63 - GF_LOG[b]];
function rsDecode(data, nroots) {
    const n = data.length;
    const synd = new Uint8Array(nroots);
    let bad = false;
    for (let i = 0; i < nroots; i++) {
        let s = 0;
        for (let j = 0; j < n; j++)
            s = gmul(s, GF_EXP[i + 1]) ^ data[j];
        synd[i] = s;
        if (s)
            bad = true;
    }
    if (!bad)
        return 0;
    let lam = new Uint8Array(nroots + 1);
    lam[0] = 1;
    let b = new Uint8Array(nroots + 1);
    b[0] = 1;
    let L = 0;
    for (let r = 1; r <= nroots; r++) {
        let d = 0;
        for (let i = 0; i <= L; i++)
            d ^= gmul(lam[i], synd[r - 1 - i] ?? 0);
        const bShift = new Uint8Array(nroots + 1);
        for (let i = 0; i < nroots; i++)
            bShift[i + 1] = b[i];
        if (d === 0) {
            b = bShift;
            continue;
        }
        const t = new Uint8Array(nroots + 1);
        for (let i = 0; i <= nroots; i++)
            t[i] = lam[i] ^ gmul(d, bShift[i]);
        if (2 * L <= r - 1) {
            const inv = gdiv(1, d);
            const nb = new Uint8Array(nroots + 1);
            for (let i = 0; i <= nroots; i++)
                nb[i] = gmul(lam[i], inv);
            b = nb;
            L = r - L;
        }
        else
            b = bShift;
        lam = t;
    }
    if (L > nroots >> 1)
        return -1;
    const roots = [], pos = [];
    for (let i = 0; i < 63; i++) {
        let s = 0;
        for (let j = 0; j <= L; j++)
            s ^= gmul(lam[j], GF_EXP[(j * i) % 63]);
        if (s === 0) {
            const p = (63 - i) % 63;
            if (p < n) {
                roots.push(GF_EXP[i]);
                pos.push(n - 1 - p);
            }
        }
    }
    if (roots.length !== L)
        return -1;
    const omega = new Uint8Array(nroots);
    for (let i = 0; i < nroots; i++) {
        let s = 0;
        for (let j = 0; j <= Math.min(i, L); j++)
            s ^= gmul(lam[j], synd[i - j]);
        omega[i] = s;
    }
    for (let k = 0; k < pos.length; k++) {
        const xInv = roots[k];
        let num = 0;
        for (let i = 0; i < nroots; i++)
            num ^= gmul(omega[i], GF_EXP[(GF_LOG[xInv] * i) % 63]);
        let den = 0;
        for (let i = 1; i <= L; i += 2)
            den ^= gmul(lam[i], GF_EXP[(GF_LOG[xInv] * (i - 1)) % 63]);
        if (den === 0)
            return -1;
        data[pos[k]] ^= gdiv(num, den);
    }
    return pos.length;
}
const BCH_GEN = (() => {
    const mul = (a, b) => gmul(a, b);
    let g = [1];
    const seen = new Set();
    for (let r = 1; r <= 22; r++) {
        const conj = [];
        for (let c = r; !conj.includes(c); c = (c * 2) % 63)
            conj.push(c);
        if (conj.some(c => seen.has(c)))
            continue;
        for (const c of conj)
            seen.add(c);
        let mp = [1];
        for (const c of conj) {
            const np = new Array(mp.length + 1).fill(0);
            for (let j = 0; j < mp.length; j++) {
                np[j] ^= mul(mp[j], GF_EXP[c]);
                np[j + 1] ^= mp[j];
            }
            mp = np;
        }
        const ng = new Array(g.length + mp.length - 1).fill(0);
        for (let i = 0; i < g.length; i++)
            if (g[i])
                for (let j = 0; j < mp.length; j++)
                    ng[i + j] ^= mul(g[i], mp[j]);
        g = ng;
    }
    let v = 0n;
    for (let i = 0; i < g.length; i++)
        if (g[i])
            v |= 1n << BigInt(i);
    return v;
})();
function nidWord(nac, duid) {
    const data = BigInt(((nac << 4) | duid) >>> 0);
    let reg = data << 47n;
    for (let b = 62; b >= 47; b--)
        if ((reg >> BigInt(b)) & 1n)
            reg ^= BCH_GEN << BigInt(b - 47);
    const cw = (data << 47n) | (reg & ((1n << 47n) - 1n));
    let par = 0n;
    for (let t = cw; t; t >>= 1n)
        par ^= t & 1n;
    const w = (cw << 1n) | par;
    return { hi: Number(w >> 32n), lo: Number(w & 0xffffffffn) };
}
const bitCount = (x) => { let c = 0; x >>>= 0; while (x) {
    x &= x - 1;
    c++;
} return c; };
const H106 = [0x0e, 0x0d, 0x0b, 0x07, 0x03, 0x0c];
function hamming106(word) {
    const data = (word >> 4) & 0x3f, par = word & 0xf;
    let syn = par;
    for (let i = 0; i < 6; i++)
        if (data & (1 << (5 - i)))
            syn ^= H106[i];
    if (syn === 0)
        return data;
    for (let i = 0; i < 6; i++)
        if (syn === H106[i])
            return data ^ (1 << (5 - i));
    for (let i = 0; i < 4; i++)
        if (syn === (1 << i))
            return data;
    return -1;
}
export class P25Decoder {
    constructor() {
        this.onLog = () => undefined;
        this.onVoice = () => undefined;
        this.nac = -1;
        this.duid = -1;
        this.frameName = '';
        this.tg = 0;
        this.src = 0;
        this.enc = false;
        this.lcf = 0;
        this.frames = 0;
        this.errs = 0;
        this.lastAt = -1e9;
        this.locked = false;
        this.nacVotes = new Map();
        this.nidCache = new Map();
        this.sym = 0;
        this.info = new Uint8Array(900);
        this.nInfo = 0;
        this.want = 0;
        this.state = 'idle';
    }
    reset() {
        this.nac = -1;
        this.duid = -1;
        this.frameName = '';
        this.tg = 0;
        this.src = 0;
        this.enc = false;
        this.lcf = 0;
        this.frames = 0;
        this.errs = 0;
        this.nacVotes.clear();
        this.idle();
    }
    get lastFrame() { return this.lastAt; }
    idle() { this.locked = false; this.want = 0; this.nInfo = 0; this.sym = 0; this.state = 'idle'; }
    expectNext() { this.sym = 0; this.nInfo = 0; this.want = 24; this.state = 'skip'; }
    status(now) {
        return {
            locked: this.locked, nac: this.nac, duid: this.duid, frame: this.frameName,
            talkgroup: this.tg, source: this.src, encrypted: this.enc, lcf: this.lcf,
            frames: this.frames, errs: this.errs, since: now - this.lastAt,
        };
    }
    sync(now) {
        this.sym = 24;
        this.nInfo = 0;
        this.want = 32;
        this.state = 'nid';
        this.lastAt = now;
        this.locked = true;
    }
    push(dibit, now) {
        if (this.state === 'idle')
            return;
        const isStatus = this.sym % 36 === 35;
        this.sym++;
        if (isStatus)
            return;
        if (this.state === 'skip') {
            if (--this.want > 0)
                return;
            this.state = 'nid';
            this.nInfo = 0;
            this.want = 32;
            return;
        }
        this.info[this.nInfo++] = dibit;
        if (--this.want > 0)
            return;
        if (this.state === 'nid')
            this.onNid(now);
        else
            this.onBody(now);
    }
    candidates(nac) {
        let c = this.nidCache.get(nac);
        if (!c) {
            c = Object.keys(DUID_NAME).map(k => ({ ...nidWord(nac, Number(k)), duid: Number(k) }));
            if (this.nidCache.size > 8)
                this.nidCache.clear();
            this.nidCache.set(nac, c);
        }
        return c;
    }
    bits(from, count) {
        let v = 0;
        for (let i = 0; i < count; i++) {
            const b = from + i, d = this.info[b >> 1];
            v = v * 2 + ((b & 1) ? (d & 1) : (d >> 1));
        }
        return v;
    }
    onNid(now) {
        const hi = this.bits(0, 32), lo = this.bits(32, 32);
        let bd = 99, bnac = -1, bduid = -1;
        for (const nac of new Set([this.bits(0, 12), ...(this.nac >= 0 ? [this.nac] : [])])) {
            for (const w of this.candidates(nac)) {
                const d = bitCount(hi ^ w.hi) + bitCount(lo ^ w.lo);
                if (d < bd) {
                    bd = d;
                    bnac = nac;
                    bduid = w.duid;
                }
            }
        }
        if (bd > 11) {
            this.errs++;
            this.idle();
            return;
        }
        const nac = bnac, duid = bduid;
        const v = this.nacVotes;
        v.set(nac, (v.get(nac) ?? 0) + 1);
        if (v.size > 8)
            v.clear();
        this.nac = nac;
        this.duid = duid;
        this.frames++;
        this.lastAt = now;
        this.frameName = DUID_NAME[duid];
        const body = DUID_SYMBOLS[duid] - 56;
        if (body <= 0) {
            this.report();
            this.expectNext();
            return;
        }
        this.want = body;
        this.state = 'body';
    }
    onBody(now) {
        this.lastAt = now;
        this.expectNext();
        if (this.duid === 0x5 || this.duid === 0xa)
            this.onLdu();
        else if (this.duid === 0xf)
            this.onTdulc();
        this.report();
    }
    onLdu() {
        const v = new Uint8Array(144);
        let at = 32;
        const lc = [];
        const takeVoice = () => { for (let i = 0; i < 72; i++) {
            const d = this.info[at + i];
            v[i * 2] = d >> 1;
            v[i * 2 + 1] = d & 1;
        } at += 72; this.onVoice(v); };
        const takeLc = () => { for (let i = 0; i < 20; i++)
            lc.push(this.info[at + i]); at += 20; };
        takeVoice();
        takeVoice();
        for (let k = 0; k < 6; k++) {
            takeLc();
            takeVoice();
        }
        at += 16;
        takeVoice();
        if (this.duid === 0x5)
            this.decodeLc(lc);
    }
    onTdulc() { }
    decodeLc(lcDibits) {
        if (lcDibits.length < 120)
            return;
        const hex = new Uint8Array(24);
        let bad = 0;
        for (let w = 0; w < 24; w++) {
            let word = 0;
            for (let i = 0; i < 5; i++) {
                const d = lcDibits[w * 5 + i];
                word = word * 4 + d;
            }
            const h = hamming106(word);
            if (h < 0) {
                bad++;
                hex[w] = 0;
            }
            else
                hex[w] = h;
        }
        if (rsDecode(hex, 12) < 0 || bad > 6) {
            this.errs++;
            return;
        }
        const bit = (i) => (hex[(i / 6) | 0] >> (5 - i % 6)) & 1;
        const f = (from, count) => { let v = 0; for (let i = 0; i < count; i++)
            v = v * 2 + bit(from + i); return v; };
        const lcf = f(2, 6), svc = f(16, 8);
        this.lcf = lcf;
        this.enc = bit(0) === 1 || (svc & 0x40) !== 0;
        if (lcf === 0x00) {
            this.tg = f(32, 16);
            this.src = f(48, 24);
        }
        else if (lcf === 0x03) {
            this.tg = f(24, 24);
            this.src = f(48, 24);
        }
    }
    report() {
        const who = this.tg || this.src ? ` · TG ${this.tg} <- ${this.src}` : '';
        this.onLog(`P25 NAC ${this.nac.toString(16).toUpperCase()} ${this.frameName}${who}${this.enc ? ' · ENCRYPTED' : ''}`);
    }
}
