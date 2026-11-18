/**
 * P25 Phase 2 TDMA outbound, as far as our recordings take it: H-DQPSK (pi/4 differential QPSK) at 6000 symbols a
 * second, demodulated by the phase step across one symbol, with the symbol timing picked again every 360 symbols,
 * and the S-ISCH frame sync found in it. No DOM.
 *
 * Derived from our 700 MHz capture (WACN BEE00, systems 962 and 9D2, voice channel 769.54375): the 40-bit sync
 * 0x575D57F7FF (all outer symbols, as the Phase 1 sync is) comes in pairs 180 symbols (one 30 ms timeslot) apart,
 * a pair every 720 symbols. The bursts between are scrambled; their layout and the scrambling sequence are not built.
 */
export const P2_BAUD = 6000;
/** The S-ISCH sync as symbol levels (dibit 01 is +3, 11 is -3). */
export const P2_SYNC = (() => {
  const LV: Record<string, number> = { '01': 3, '00': 1, '10': -1, '11': -3 }, out: number[] = [];
  const bits = [...'575D57F7FF'].flatMap(h => { const v = parseInt(h, 16); return [(v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1]; });
  for (let i = 0; i < bits.length; i += 2) out.push(LV[`${bits[i]}${bits[i + 1]}`]);
  return Int8Array.from(out);
})();
const BLK = 360;

export class P2Rx {
  /** A sync, and whether it is the second of a pair (180 symbols after the one before). */
  onSync: (paired: boolean) => void = () => undefined;
  syncs = 0; pairs = 0; symbols = 0;
  private readonly T: number;
  private re = new Float32Array(0); private im = new Float32Array(0); private n = 0;
  private readonly ring = new Float32Array(20); private rp = 0; private t = 0; private lastSync = -1e9;
  constructor(readonly fs: number) { this.T = fs / P2_BAUD; }
  push(zi: ArrayLike<number>, zq: ArrayLike<number>, m: number): void {
    if (this.n + m > this.re.length) { const r = new Float32Array(Math.max(2 * this.re.length, this.n + m + 1024)), q = new Float32Array(r.length); r.set(this.re.subarray(0, this.n)); q.set(this.im.subarray(0, this.n)); this.re = r; this.im = q; }
    for (let k = 0; k < m; k++) { this.re[this.n] = zi[k]; this.im[this.n++] = zq[k]; }
    const need = Math.ceil((BLK + 2) * this.T) + 2;
    while (this.n >= need) this.block();
  }
  private dphi(t: number): number {
    const T = this.T, i = Math.floor(t), f = t - i, j = Math.floor(t - T), g = t - T - j;
    const a = this.re[i] * (1 - f) + this.re[i + 1] * f, b = this.im[i] * (1 - f) + this.im[i + 1] * f;
    const c = this.re[j] * (1 - g) + this.re[j + 1] * g, d = this.im[j] * (1 - g) + this.im[j + 1] * g;
    return Math.atan2(b * c - a * d, a * c + b * d);
  }
  private block(): void {
    const T = this.T, t0 = T + 1;
    let best = 0, bm = -1e9;
    for (let p = 0; p < 8; p++) { let s = 0; for (let k = 0; k < BLK; k += 3) s -= Math.cos(4 * this.dphi(t0 + p * T / 8 + k * T)); if (s > bm) { bm = s; best = p; } }
    let cr = 0, ci = 0;
    for (let k = 0; k < BLK; k++) { const v = this.dphi(t0 + best * T / 8 + k * T); cr += Math.cos(4 * v); ci += Math.sin(4 * v); }
    const off = Math.atan2(ci, cr) - Math.PI, corr = Math.atan2(Math.sin(off), Math.cos(off)) / 4;
    for (let k = 0; k < BLK; k++) { let v = this.dphi(t0 + best * T / 8 + k * T) - corr; v = Math.atan2(Math.sin(v), Math.cos(v)); this.symbol(v * 4 / Math.PI); }
    const used = Math.floor(BLK * T);
    this.re.copyWithin(0, used, this.n); this.im.copyWithin(0, used, this.n); this.n -= used;
  }
  private symbol(s: number): void {
    this.ring[this.rp] = s; this.rp = (this.rp + 1) % 20; this.t++; this.symbols++;
    let c = 0, a = 0;
    for (let k = 0; k < 20; k++) { const x = this.ring[(this.rp + k) % 20]; c += x * P2_SYNC[k]; a += (x < 0 ? -x : x) * 3; }
    if (a > 0 && c / a > 0.9 && this.t - this.lastSync > 10) {
      const paired = Math.abs(this.t - this.lastSync - 180) <= 2;
      this.syncs++; if (paired) this.pairs++;
      this.lastSync = this.t; this.onSync(paired);
    }
  }
}
