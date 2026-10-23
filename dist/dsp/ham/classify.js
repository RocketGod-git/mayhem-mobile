const HIST = 12;
export class Classifier {
    constructor() {
        this.minSnr = 6;
        this.hold = new Float32Array(0);
        this.smooth = new Float32Array(0);
        this.tracks = [];
        this.frame = 0;
    }
    update(pdb, rate, centreHz, floorDb) {
        const n = pdb.length, binHz = rate / n;
        if (this.hold.length !== n) {
            this.hold = new Float32Array(n);
            this.smooth = new Float32Array(n);
            this.hold.set(pdb);
        }
        const hold = this.hold;
        for (let i = 0; i < n; i++)
            hold[i] = pdb[i] > hold[i] ? pdb[i] : hold[i] - 0.6;
        const rad = Math.max(1, Math.round(600 / binHz));
        const sm = this.smooth;
        let acc = 0;
        for (let i = 0; i < Math.min(n, rad); i++)
            acc += hold[i];
        for (let i = 0; i < n; i++) {
            const a = i - rad - 1, b = i + rad;
            if (b < n)
                acc += hold[b];
            if (a >= 0)
                acc -= hold[a];
            sm[i] = acc / (Math.min(n - 1, b) - Math.max(0, a + 1) + 1);
        }
        const thr = floorDb + this.minSnr;
        const sep = Math.max(2, Math.round(2500 / binHz));
        const out = [];
        this.frame++;
        for (let i = 1; i < n - 1; i++) {
            if (sm[i] < thr || sm[i] < sm[i - 1] || sm[i] < sm[i + 1])
                continue;
            let best = true;
            for (let k = Math.max(0, i - sep); k < Math.min(n, i + sep); k++)
                if (sm[k] > sm[i]) {
                    best = false;
                    break;
                }
            if (!best)
                continue;
            let pk = -1e9, pi = i;
            for (let k = Math.max(0, i - rad); k <= Math.min(n - 1, i + rad); k++)
                if (hold[k] > pk) {
                    pk = hold[k];
                    pi = k;
                }
            const w6 = width(hold, pi, pk - 6), w20 = width(hold, pi, Math.max(floorDb + 3, pk - 20));
            const center = (w6[0] + w6[1]) / 2;
            const bw6 = (w6[1] - w6[0] + 1) * binHz, bw20 = (w20[1] - w20[0] + 1) * binHz;
            let sumL = 0, sumR = 0, sum = 0, cnt = 0, mx = -1e9;
            for (let k = w20[0]; k <= w20[1]; k++) {
                const v = Math.pow(10, hold[k] / 10);
                sum += v;
                cnt++;
                if (k < center)
                    sumL += v;
                else
                    sumR += v;
                if (hold[k] > mx)
                    mx = hold[k];
            }
            const mean = sum / Math.max(1, cnt);
            const peakiness = mx - 10 * Math.log10(mean + 1e-12);
            const skew = (sumR - sumL) / (sum + 1e-12);
            const bimodal = isBimodal(hold, w6[0], w6[1], pk);
            let cenNum = 0, cenDen = 0;
            for (let k = w6[0]; k <= w6[1]; k++) {
                const v = Math.pow(10, hold[k] / 10);
                cenNum += k * v;
                cenDen += v;
            }
            const hz = centreHz + ((cenDen > 0 ? cenNum / cenDen : center) - n / 2) * binHz;
            if (Math.abs(hz - centreHz) < 2500)
                continue;
            const t = this.track(hz, pk, bw6, bw20, peakiness, skew, bimodal);
            const f = settle(t);
            const duty = t.onFrames / Math.max(1, t.frames);
            const lv = levelVar(t.levels);
            const [cls, conf] = classify(f.bw6, f.bw20, f.peaky, f.skew, f.bimodal, duty, lv, t.frames, t.hz);
            vote(t, cls, conf);
            out.push({ hz: t.hz, db: pk, snr: pk - floorDb, bw6: f.bw6, bw20: f.bw20, cls: t.cls, conf: t.cls ? Math.min(1, t.ruleConf * Math.min(1, (t.votes.get(t.cls) ?? 0) / 4)) : 0 });
        }
        this.tracks = this.tracks.filter(t => this.frame - t.seen < 40);
        for (const t of this.tracks)
            if (t.seen !== this.frame) {
                t.frames++;
                decay(t);
            }
        out.sort((a, b) => b.snr - a.snr);
        const kept = [];
        for (const s of out)
            if (!kept.some(k => Math.abs(k.hz - s.hz) < Math.max(2500, 0.6 * Math.max(k.bw20, s.bw20), 0.55 * (k.bw6 + s.bw6))))
                kept.push(s);
        return kept.slice(0, 12);
    }
    track(hz, level, bw6, bw20, peaky, skew, bimodal) {
        let t = this.tracks.find(x => Math.abs(x.hz - hz) < Math.max(3000, 0.5 * Math.max(bw6, pct(x.bw6, 0.8))));
        if (!t) {
            t = { hz, seen: this.frame, onFrames: 0, frames: 0, levels: [], bw6: [], bw20: [], peaky: [], skew: [], bimodal: [], votes: new Map(), cls: '', ruleConf: 0 };
            this.tracks.push(t);
        }
        t.hz = t.hz * 0.7 + hz * 0.3;
        t.seen = this.frame;
        t.onFrames++;
        t.frames++;
        push(t.levels, level, 20);
        push(t.bw6, bw6, HIST);
        push(t.bw20, bw20, HIST);
        push(t.peaky, peaky, HIST);
        push(t.skew, skew, HIST);
        push(t.bimodal, bimodal ? 1 : 0, HIST);
        return t;
    }
}
function push(a, v, max) { a.push(v); if (a.length > max)
    a.shift(); }
function pct(a, p) {
    if (!a.length)
        return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function settle(t) {
    return { bw6: pct(t.bw6, 0.8), bw20: pct(t.bw20, 0.8), peaky: pct(t.peaky, 0.5), skew: mean(t.skew), bimodal: mean(t.bimodal) > 0.5 };
}
function vote(t, cls, conf) {
    decay(t);
    t.votes.set(cls, (t.votes.get(cls) ?? 0) + 1);
    const cur = t.cls, v = t.votes.get(cls) ?? 0, vc = cur ? t.votes.get(cur) ?? 0 : 0;
    if (!cur) {
        if (t.frames >= 3) {
            t.cls = cls;
            t.ruleConf = conf;
        }
        return;
    }
    if (cls === cur) {
        t.ruleConf = conf;
        return;
    }
    if (v > vc * 1.6 + 0.6) {
        t.cls = cls;
        t.ruleConf = conf;
    }
}
function decay(t) { for (const [k, v] of t.votes)
    t.votes.set(k, v * 0.85); }
function width(a, pi, thr) {
    let lo = pi, hi = pi;
    while (lo > 0 && a[lo - 1] >= thr)
        lo--;
    while (hi < a.length - 1 && a[hi + 1] >= thr)
        hi++;
    return [lo, hi];
}
function isBimodal(a, lo, hi, pk) {
    if (hi - lo < 4)
        return false;
    let peaks = 0, lastPeak = -1, minBetween = 1e9;
    for (let k = lo + 1; k < hi; k++) {
        if (a[k] >= a[k - 1] && a[k] >= a[k + 1] && a[k] > pk - 4) {
            if (lastPeak >= 0 && a[k] - minBetween > 4 && minBetween < pk - 4)
                peaks++;
            else if (lastPeak < 0)
                peaks = 1;
            lastPeak = k;
            minBetween = 1e9;
        }
        else if (lastPeak >= 0 && a[k] < minBetween)
            minBetween = a[k];
    }
    return peaks >= 2;
}
function levelVar(levels) {
    if (levels.length < 4)
        return 0;
    const m = levels.reduce((s, v) => s + v, 0) / levels.length;
    return Math.sqrt(levels.reduce((s, v) => s + (v - m) * (v - m), 0) / levels.length);
}
const HF_BROADCAST = [[3.2e6, 3.4e6], [4.75e6, 5.06e6], [5.9e6, 6.2e6], [7.2e6, 7.45e6], [9.4e6, 9.9e6], [11.6e6, 12.1e6], [13.57e6, 13.87e6], [15.1e6, 15.8e6], [17.48e6, 17.9e6], [18.9e6, 19.02e6], [21.45e6, 21.85e6], [25.67e6, 26.1e6]];
function bandOfHz(hz) {
    if (hz < 30e6) {
        if (hz >= 520e3 && hz <= 1.71e6)
            return 'mw';
        if (HF_BROADCAST.some(([a, b]) => hz >= a && hz <= b))
            return 'hfbc';
        return 'hf';
    }
    if (hz >= 87.5e6 && hz <= 108e6)
        return 'bcfm';
    if (hz > 108e6 && hz <= 137e6)
        return 'air';
    if ((hz >= 50e6 && hz < 50.3e6) || (hz >= 144e6 && hz < 144.3e6) || (hz >= 432e6 && hz < 432.3e6) || (hz >= 1296e6 && hz < 1296.3e6))
        return 'weak';
    if ((hz >= 152e6 && hz <= 152.9e6) || (hz >= 929e6 && hz <= 932e6))
        return 'pager';
    return 'land';
}
function classify(bw6, bw20, peakiness, skew, bimodal, duty, lv, frames, hz) {
    const young = frames < 6, band = bandOfHz(hz);
    const peaky = peakiness > 10 && Math.abs(skew) < 0.25;
    if (band === 'bcfm')
        return ['WFM', bw6 > 60000 ? 0.95 : 0.7];
    if (bw6 > 100000)
        return ['WFM', 0.9];
    if (band === 'air')
        return bw6 <= 30000 ? ['AM', bw6 >= 1500 ? 0.85 : 0.6] : ['WIDE', 0.4];
    if (band === 'pager' && (bimodal || bw6 > 4000))
        return ['FSK', 0.8];
    if (band === 'land') {
        if (bw6 < 1200) {
            if (duty < 0.6 && !young)
                return ['OOK', 0.6];
            return peakiness > 8 ? ['CARRIER', 0.7] : ['DIGI', 0.5];
        }
        if (bimodal && bw6 < 30000)
            return ['FSK', 0.6];
        if (bw6 <= 4200)
            return ['NFM', 0.5];
        if (bw6 <= 16000) {
            const flat = peakiness < 4.5;
            if (flat && lv < 1.5 && !young)
                return ['DMR', 0.5];
            return ['NFM', flat ? 0.6 : 0.8];
        }
        if (bw6 <= 40000)
            return ['NFM', 0.6];
        return ['WIDE', 0.4];
    }
    if ((band === 'hfbc' || band === 'mw') && peaky && bw6 >= 3000 && bw6 <= 20000)
        return ['AM', 0.9];
    if (bw6 < 350 && bw20 < 1500) {
        if (duty < 0.7 && !young)
            return ['CW', 0.75];
        return peakiness > 8 ? ['CW', 0.55] : ['DIGI', 0.55];
    }
    if (bw6 < 1200)
        return duty < 0.6 && !young ? ['OOK', 0.5] : ['DIGI', 0.6];
    if (bimodal && bw6 < 30000)
        return ['FSK', 0.65];
    if (bw6 <= 4200) {
        if (peaky)
            return ['AM', 0.6];
        const lsb = skew < -0.15 || (Math.abs(skew) <= 0.15 && hz < 10e6);
        return [skew > 0.15 ? 'USB' : lsb ? 'LSB' : 'USB', Math.abs(skew) > 0.15 ? 0.7 : 0.55];
    }
    if (bw6 <= 14000)
        return peaky ? ['AM', 0.7] : ['NFM', 0.6];
    if (bw6 <= 40000)
        return ['NFM', 0.5];
    return ['WIDE', 0.4];
}
