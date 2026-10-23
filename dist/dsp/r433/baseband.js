const ENV_A1 = 0.85408, ENV_B0 = 0.07296;
const FM_A1 = 0.50953, FM_B0 = 0.24524;
function fastAtan2(y, x) {
    const ax = Math.abs(x), ay = Math.abs(y);
    const a = Math.min(ax, ay) / (Math.max(ax, ay) + 1e-20);
    const s = a * a;
    let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
    if (ay > ax)
        r = 1.57079637 - r;
    if (x < 0)
        r = 3.14159274 - r;
    return y < 0 ? -r : r;
}
export class Baseband {
    constructor() {
        this.env = new Int16Array(0);
        this.fm = new Int16Array(0);
        this.envX = 0;
        this.envY = 0;
        this.xr = 0;
        this.xi = 0;
        this.xf = 0;
        this.yf = 0;
        this.i1 = 0;
        this.i2 = 0;
        this.q1 = 0;
        this.q2 = 0;
        this.c1i = 0;
        this.c2i = 0;
        this.c1q = 0;
        this.c2q = 0;
        this.accN = 0;
        this.decim = 1;
    }
    reset() {
        this.envX = 0;
        this.envY = 0;
        this.xr = 0;
        this.xi = 0;
        this.xf = 0;
        this.yf = 0;
        this.i1 = 0;
        this.i2 = 0;
        this.q1 = 0;
        this.q2 = 0;
        this.c1i = 0;
        this.c2i = 0;
        this.c1q = 0;
        this.c2q = 0;
        this.accN = 0;
    }
    process(iq) {
        const total = iq.length >> 1;
        const decim = this.decim < 1 ? 1 : this.decim | 0;
        const cap = Math.ceil((total + decim) / decim);
        if (this.env.length < cap) {
            this.env = new Int16Array(cap);
            this.fm = new Int16Array(cap);
        }
        const env = this.env, fm = this.fm;
        let ex = this.envX, ey = this.envY;
        let x1r = this.xr, x1i = this.xi, x1f = this.xf, y1f = this.yf;
        let i1 = this.i1, i2 = this.i2, q1 = this.q1, q2 = this.q2;
        let c1i = this.c1i, c2i = this.c2i, c1q = this.c1q, c2q = this.c2q;
        let accN = this.accN;
        const gain = decim * decim;
        let n = 0;
        for (let s = 0; s < total; s++) {
            i1 = (i1 + iq[2 * s]) | 0;
            i2 = (i2 + i1) | 0;
            q1 = (q1 + iq[2 * s + 1]) | 0;
            q2 = (q2 + q1) | 0;
            if (++accN < decim)
                continue;
            accN = 0;
            const d1i = (i2 - c1i) | 0;
            c1i = i2;
            const d2i = (d1i - c2i) | 0;
            c2i = d1i;
            const d1q = (q2 - c1q) | 0;
            c1q = q2;
            const d2q = (d1q - c2q) | 0;
            c2q = d1q;
            const ir = d2i / gain, ii = d2q / gain;
            const i = n++;
            const ax = ir < 0 ? -ir : ir, ay = ii < 0 ? -ii : ii;
            const mag = ax > ay ? 122 * ax + 51 * ay : 122 * ay + 51 * ax;
            ey = ENV_A1 * ey + ENV_B0 * (mag + ex);
            ex = mag;
            env[i] = ey > 32767 ? 32767 : ey;
            const pr = ir * x1r + ii * x1i;
            const pi = ii * x1r - ir * x1i;
            const x0f = fastAtan2(pi, pr) * 10430.378;
            y1f = FM_A1 * y1f + FM_B0 * (x0f + x1f);
            x1f = x0f;
            x1r = ir;
            x1i = ii;
            fm[i] = y1f > 32767 ? 32767 : y1f < -32768 ? -32768 : y1f;
        }
        this.envX = ex;
        this.envY = ey;
        this.xr = x1r;
        this.xi = x1i;
        this.xf = x1f;
        this.yf = y1f;
        this.i1 = i1;
        this.i2 = i2;
        this.q1 = q1;
        this.q2 = q2;
        this.c1i = c1i;
        this.c2i = c2i;
        this.c1q = c1q;
        this.c2q = c2q;
        this.accN = accN;
        return { env, fm, n };
    }
}
