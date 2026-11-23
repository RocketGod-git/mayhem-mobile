/**
 * Symbols from an FM discriminator (radians per sample). The receive filter is either the root raised cosine of
 * roll-off 0.2 that DMR, Fusion and NXDN specify for the receiver (matched to the transmitter's, so the symbol centers
 * are free of their neighbors), or the discriminator summed over one symbol, the phase step across it, the measure
 * Fleet's SymbolRx takes from complex samples and cheaper, for sync detection only. Symbol timing is picked again for
 * every block of 240 symbols (the phase, of eight, with the most energy), the eye's outer quarters give its center
 * and level, and symbols come out scaled so the outer levels sit at about ±3. 4FSK (DMR, Fusion, P25, NXDN) reads as
 * four levels; D-STAR's GMSK reads as two, and its bits are the signs. Any sample rate. No DOM.
 */

const BLOCK = 240;

/** Root raised cosine, roll-off [a], [span] symbols each side, [sps] samples a symbol, unit gain at DC. */
export function rrcTaps(sps: number, a: number, span: number): Float64Array {
  const half = Math.round(span * sps), h = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const t = k / sps;
    let v: number;
    if (Math.abs(t) < 1e-9) v = 1 - a + 4 * a / Math.PI;
    else if (Math.abs(Math.abs(t) - 1 / (4 * a)) < 1e-9) v = a / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)));
    else v = (Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - (4 * a * t) * (4 * a * t)));
    h[k + half] = v; sum += v;
  }
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  return h;
}

export class DiscSymbols {
  onSymbol: (s: number) => void = () => undefined;
  readonly sps: number;
  private readonly D: number;
  private readonly ring: Float64Array; private rp = 0; private acc = 0;
  private readonly taps: Float64Array | null;
  private buf: Float64Array; private n = 0; private base = 0; private tNext = 0;
  center = 0; level = 0;
  /** Eye opening of the last block: energy at the chosen phase over the mean of all eight. */
  eye = 1;
  symbols = 0;

  /** [rrc]: the root raised cosine receive filter; otherwise the sum over one symbol. */
  constructor(readonly fs: number, readonly baud: number, rrc = true) {
    this.sps = fs / baud;
    this.taps = rrc ? rrcTaps(this.sps, 0.2, 4) : null;
    this.D = this.taps ? this.taps.length : Math.max(1, Math.round(this.sps));
    this.ring = new Float64Array(this.D);
    this.buf = new Float64Array(Math.ceil(this.sps * BLOCK * 2) + 64);
  }

  reset(): void { this.ring.fill(0); this.rp = 0; this.acc = 0; this.n = 0; this.base = 0; this.tNext = 0; this.center = 0; this.level = 0; this.eye = 1; this.symbols = 0; }

  push(disc: ArrayLike<number>, count: number): void {
    const D = this.D, h = this.taps, ring = this.ring;
    for (let k = 0; k < count; k++) {
      const x = disc[k];
      let y: number;
      if (h) {
        ring[this.rp] = x; if (++this.rp >= D) this.rp = 0;
        // oldest sample first: ring[rp] is the oldest
        y = 0; let j = this.rp;
        for (let i = 0; i < D; i++) { y += h[i] * ring[j]; if (++j >= D) j = 0; }
      } else {
        this.acc += x - ring[this.rp]; ring[this.rp] = x; if (++this.rp >= D) this.rp = 0;
        y = this.acc;
      }
      if (this.n >= this.buf.length) this.grow();
      this.buf[this.n++] = y;
    }
    const need = Math.ceil(this.sps * (BLOCK + 2)) + 2;
    while (this.n >= need) this.block(BLOCK);
  }
  /** Decodes what is left as a short last block. */
  flush(): void { const k = Math.floor(this.n / this.sps) - 2; if (k > 20) this.block(k); }

  private grow(): void { const b = new Float64Array(this.buf.length * 2); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
  private at(t: number): number {
    const i = Math.floor(t), f = t - i;
    const a = this.buf[i], b = this.buf[i + 1 < this.n ? i + 1 : this.n - 1];
    return a * (1 - f) + b * f;
  }
  private block(nsym: number): void {
    const T = this.sps, len = nsym * T;
    let best = 0, bestE = -1, sumE = 0;
    for (let p = 0; p < 8; p++) {
      const off = p * T / 8;
      let e = 0;
      for (let k = 0; k < nsym; k++) { const x = this.at(off + k * T) - this.center; e += x * x; }
      sumE += e;
      if (e > bestE) { bestE = e; best = off; }
    }
    this.eye = sumE > 0 ? bestE / (sumE / 8) : 1;
    // carry on the previous grid: the first symbol of this block is the first at least half a symbol after the last
    const t0 = this.tNext - this.base;
    let k0 = Math.ceil((t0 - T / 2 - best) / T); if (k0 < 0) k0 = 0;
    const vals: number[] = [];
    let t = best + k0 * T;
    for (; t < len; t += T) vals.push(this.at(t));
    this.tNext = this.base + t;
    if (vals.length > 0) {
      const sorted = Float64Array.from(vals).sort(), q = Math.max(1, Math.floor(sorted.length / 4));
      let lo = 0, hi = 0; for (let i = 0; i < q; i++) { lo += sorted[i]; hi += sorted[sorted.length - 1 - i]; } lo /= q; hi /= q;
      const c = (hi + lo) / 2, l = (hi - lo) / 2;
      if (l > 1e-6) {
        this.center = this.level > 0 ? this.center + 0.5 * (c - this.center) : c;
        this.level = this.level > 0 ? this.level + 0.5 * (l - this.level) : l;
      }
    }
    const sc = this.level > 0 ? 3 / this.level : 1;
    for (const v of vals) { this.symbols++; this.onSymbol((v - this.center) * sc); }
    const used = Math.floor(len);
    this.buf.copyWithin(0, used, this.n); this.n -= used; this.base += used;
  }
}
