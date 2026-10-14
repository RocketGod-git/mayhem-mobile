export function fft(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 1; i < n; i++) {
        let bit = n >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if (i < j) {
            const tr = re[i];
            re[i] = re[j];
            re[j] = tr;
            const ti = im[i];
            im[i] = im[j];
            im[j] = ti;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            const half = len >> 1;
            for (let k = 0; k < half; k++) {
                const a = i + k, b = a + half;
                const tr = cr * re[b] - ci * im[b];
                const ti = cr * im[b] + ci * re[b];
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}
export function loadIq(iq, nSamp, re, im) {
    const nFft = re.length;
    const n = Math.min(nFft, nSamp);
    for (let k = 0; k < n; k++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1));
        re[k] = iq[2 * k] * w;
        im[k] = iq[2 * k + 1] * w;
    }
    for (let k = n; k < nFft; k++) {
        re[k] = 0;
        im[k] = 0;
    }
}
const windows = new Map();
export function hann(n) {
    let w = windows.get(n);
    if (!w) {
        w = new Float32Array(n);
        for (let k = 0; k < n; k++)
            w[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1));
        windows.set(n, w);
    }
    return w;
}
export function loadIqAt(iq, offset, re, im, w) {
    const n = re.length;
    let s = 2 * offset;
    for (let k = 0; k < n; k++, s += 2) {
        re[k] = iq[s] * w[k];
        im[k] = iq[s + 1] * w[k];
    }
}
export function accumulatePower(re, im, acc) {
    const n = re.length, h = n >> 1;
    for (let i = 0; i < n; i++) {
        const s = i < h ? i + h : i - h;
        acc[i] += re[s] * re[s] + im[s] * im[s];
    }
}
export function powerDbFrom(acc, frames, out) {
    const n = acc.length, bins = out.length, group = n / bins, inv = 1 / Math.max(1, frames);
    for (let bin = 0; bin < bins; bin++) {
        let peak = 0;
        const base = bin * group;
        for (let j = 0; j < group; j++) {
            const v = acc[base + j];
            if (v > peak)
                peak = v;
        }
        out[bin] = 10 * Math.log10(peak * inv + 1e-9);
    }
}
export function powerDb(re, im, out) {
    const nFft = re.length, bins = out.length, group = nFft / bins;
    for (let bin = 0; bin < bins; bin++) {
        let peak = 0;
        for (let j = 0; j < group; j++) {
            const idx = bin * group + j;
            const s = (idx + nFft / 2) % nFft;
            const mag = re[s] * re[s] + im[s] * im[s];
            if (mag > peak)
                peak = mag;
        }
        out[bin] = 10 * Math.log10(peak + 1e-9);
    }
}
