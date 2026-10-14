export function canTune(r, hz) {
    return hz >= r.minHz && hz <= r.maxHz;
}
export function canSample(r, hz) {
    return r.rates.some(([lo, hi]) => hz >= lo && hz <= hi);
}
export function nearestRate(r, hz) {
    if (canSample(r, hz))
        return hz;
    let best = r.rates[0][0], bestD = Infinity;
    for (const [lo, hi] of r.rates) {
        for (const cand of [lo, hi]) {
            const d = Math.abs(cand - hz);
            if (d < bestD) {
                bestD = d;
                best = cand;
            }
        }
    }
    return best;
}
export const APP_NEEDS = {
    ham: { freqHz: 14074000 },
    btle: { freqHz: 2402000000 },
    transmit: { tx: true },
};
export function blockedBecause(n, lim) {
    if (!n)
        return '';
    if (n.tx && !lim.canTransmit)
        return 'this radio receives only';
    if (n.freqHz !== undefined && !canTune(lim, n.freqHz)) {
        return `it lives at ${(n.freqHz / 1e6).toFixed(3)} MHz, outside this radio's ${(lim.minHz / 1e6).toFixed(0)}–${(lim.maxHz / 1e6).toFixed(0)} MHz`;
    }
    if (n.rateHz !== undefined && !canSample(lim, n.rateHz)) {
        const top = Math.max(...lim.rates.map(([, hi]) => hi));
        return `it needs ${(n.rateHz / 1e6).toFixed(2)} Msps, above this radio's ${(top / 1e6).toFixed(1)}`;
    }
    return '';
}
export function whyNot(r, freqHz, rateHz) {
    if (!canTune(r, freqHz)) {
        return `needs ${(freqHz / 1e6).toFixed(3)} MHz, outside this radio's ${(r.minHz / 1e6).toFixed(0)}–${(r.maxHz / 1e6).toFixed(0)} MHz`;
    }
    if (!canSample(r, rateHz)) {
        const top = Math.max(...r.rates.map(([, hi]) => hi));
        return `needs ${(rateHz / 1e6).toFixed(3)} Msps, above this radio's ${(top / 1e6).toFixed(1)} Msps`;
    }
    return '';
}
