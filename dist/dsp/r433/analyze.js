const TOL = 0.2;
const MIN_SHARE = 0.08;
function cluster(v, n, spus) {
    if (n <= 0)
        return [];
    const us = [];
    for (let i = 0; i < n; i++)
        us.push(v[i] / spus);
    us.sort((a, b) => a - b);
    const groups = [];
    let sum = us[0], count = 1;
    for (let i = 1; i < us.length; i++) {
        const mean = sum / count;
        if (us[i] - mean <= mean * TOL) {
            sum += us[i];
            count++;
        }
        else {
            groups.push({ sum, n: count });
            sum = us[i];
            count = 1;
        }
    }
    groups.push({ sum, n: count });
    const floor = Math.max(1, Math.round(us.length * MIN_SHARE));
    return groups.filter(g => g.n >= floor).map(g => ({ us: Math.round(g.sum / g.n), n: g.n }));
}
function nameCoding(mark, space) {
    if (!mark.length)
        return '';
    if (mark.length === 1 && space.length >= 2)
        return 'pulse position';
    if (mark.length >= 2 && space.length === 1)
        return 'pulse width';
    if (mark.length === 1 && space.length === 1)
        return 'fixed period — a preamble, or every bit the same';
    if (mark.length === 2 && space.length === 2) {
        const mr = mark[1].us / mark[0].us, sr = space[1].us / space[0].us;
        if (mr > 1.6 && mr < 2.5 && sr > 1.6 && sr < 2.5)
            return 'Manchester or level per bit';
        return 'two widths each way';
    }
    return '';
}
export function describeBurst(p) {
    const spus = p.sampleRate / 1e6;
    const n = p.numPulses;
    const mark = cluster(p.pulse, n, spus);
    const space = cluster(p.gap, Math.max(0, n - 1), spus);
    let total = 0;
    for (let i = 0; i < n; i++)
        total += p.pulse[i];
    for (let i = 0; i < n - 1; i++)
        total += p.gap[i];
    const ms = total / spus / 1000;
    const coding = nameCoding(mark, space);
    const rate = n > 1 ? Math.round(1e6 / (total / spus / (n - 1))) : 0;
    const sig = [
        p.fsk ? 'F' : 'O',
        mark.map(c => Math.round(c.us / 10)).join('.'),
        space.map(c => Math.round(c.us / 10)).join('.'),
        Math.round(n / 8),
    ].join('-');
    return { fsk: p.fsk, pulses: n, ms, mark, space, coding, rate, key: sig };
}
export function shapeSummary(s) {
    const parts = [`${s.pulses} pulses`, `${s.ms < 10 ? s.ms.toFixed(1) : Math.round(s.ms)} ms`];
    if (s.rate)
        parts.push(`${s.rate >= 1000 ? `${(s.rate / 1000).toFixed(1)}k` : s.rate} sym/s`);
    if (s.mark.length)
        parts.push(`marks ${s.mark.map(c => c.us).join('/')} µs`);
    if (s.space.length)
        parts.push(`gaps ${s.space.map(c => c.us).join('/')} µs`);
    return parts.join(' · ');
}
