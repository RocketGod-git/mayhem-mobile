/**
 * TETRA downlink (ETSI EN 300 392-2), receive only: the cell's synchronization burst and what its BSCH says. No DOM.
 *
 *  - pi/4-DQPSK at 18000 symbols a second (EN 300 392-2 5.5, Table 5.1: phase steps +pi/4 = 00, +3pi/4 = 01,
 *    -pi/4 = 10, -3pi/4 = 11), demodulated by the phase step across one symbol, timing picked again every 255 symbols.
 *  - The synchronization downlink burst (9.4.4.2.6, Table 9.9): the 38-bit synchronization training sequence
 *    (9.4.4.3.4) at bits 215 to 252, the 120 scrambled BSCH bits right before it (bits 95 to 214), the AACH after it.
 *  - BSCH coding (8.3.1.2): 60 type-1 bits, a (76,60) block code (8.2.3.3: CRC with G(X) = X^16 + X^12 + X^5 + 1,
 *    register preset to ones, complemented), 4 tail bits, the 16-state rate 1/4 mother code (8.2.3.1.1: G1 = 1 + D + D^4,
 *    G2 = 1 + D^2 + D^3 + D^4, G3 = 1 + D + D^2 + D^4, G4 = 1 + D + D^3 + D^4) punctured to rate 2/3 (P = 1, 2, 5 of
 *    every 8), a (120,11) block interleaver (8.2.4.1) and scrambling (8.2.5) with the color code taken as all zeros.
 *  - The MAC SYNC PDU (21.4.4.1, Table 21.76) and the D-MLE-SYNC it carries (18.4.2.1, Table 18.17): system code,
 *    color code, timeslot, frame and multiframe numbers, sharing mode, MCC, MNC, cell load.
 */
export const TETRA_BAUD = 18000;
const BLK = 255;
/** Table 5.1: the phase step of each dibit. */
const STEP: Record<number, number> = { 0: Math.PI / 4, 1: 3 * Math.PI / 4, 2: -Math.PI / 4, 3: -3 * Math.PI / 4 };
/** The synchronization training sequence y1 to y38 (9.4.4.3.4) as 19 dibits. */
export const TETRA_SYNC_BITS = [1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1];
const SYNC_STEPS = Array.from({ length: 19 }, (_, i) => STEP[(TETRA_SYNC_BITS[2 * i] << 1) | TETRA_SYNC_BITS[2 * i + 1]]);

/** The scrambling sequence (8.2.5.2) from the 30-bit extended color code (all zeros for the BSCH). */
export function tetraScrambler(e: ArrayLike<number> | null, n: number): Uint8Array {
  const C = [1, 2, 4, 5, 7, 8, 10, 11, 12, 16, 22, 23, 26, 32];
  const p = new Uint8Array(n + 32);   // p[j] is p(k) for k = j - 31
  p[0] = 1; p[1] = 1;                  // p(-31) = p(-30) = 1
  for (let k = -29; k <= 0; k++) p[k + 31] = e ? e[-k] & 1 : 0;   // p(k) = e(1 - k)
  for (let j = 32; j < n + 32; j++) { let v = 0; for (const i of C) v ^= p[j - i]; p[j] = v; }
  return p.subarray(32);              // p(1) .. p(n)
}
/** The (K1 + 16, K1) block code check of 8.2.3.3: the 16 bits after the K1 information bits. */
export function tetraCrc16(bits: ArrayLike<number>, k1: number): number {
  let r = 0xffff;
  for (let i = 0; i < k1; i++) { const fb = ((r >> 15) & 1) ^ bits[i]; r = (r << 1) & 0xffff; if (fb) r ^= 0x1021; }
  return r ^ 0xffff;
}
const G = [0b10011, 0b11101, 0b10111, 0b11011];   // taps of D^0..D^4 (bit j = D^j)
/** Viterbi decoding of the rate 1/4 mother code from [soft] type-3 values (+1 for 0, -1 for 1, 0 erased), K2 bits. */
function viterbi(m: Float32Array, k2: number): Uint8Array {
  const S = 16, INF = 1e9;
  let pm = new Float64Array(S).fill(INF); pm[0] = 0;
  const prev = new Uint8Array(k2 * S), bitOf = new Uint8Array(k2 * S);
  const out4 = (state: number, b: number, i: number) => { const reg = (state << 1) | b; let v = 0; for (let j = 0; j < 5; j++) if (G[i] & (1 << j)) v ^= (reg >> j) & 1; return v; };
  for (let k = 0; k < k2; k++) {
    const np = new Float64Array(S).fill(INF);
    for (let s = 0; s < S; s++) {
      if (pm[s] >= INF) continue;
      for (let b = 0; b < 2; b++) {
        let cost = 0;
        for (let i = 0; i < 4; i++) { const want = out4(s, b, i) ? -1 : 1, got = m[4 * k + i]; cost -= want * got; }
        const ns = ((s << 1) | b) & 15, c = pm[s] + cost;
        if (c < np[ns]) { np[ns] = c; prev[k * S + ns] = s; bitOf[k * S + ns] = b; }
      }
    }
    pm = np;
  }
  let s = 0; // tail bits bring the coder back to zero
  const out = new Uint8Array(k2);
  for (let k = k2 - 1; k >= 0; k--) { out[k] = bitOf[k * S + s]; s = prev[k * S + s]; }
  return out;
}
/** Type-5 BSCH bits (120) to the 60 type-1 bits, or null when the check fails. */
export function tetraBsch(sb: ArrayLike<number>): Uint8Array | null {
  const K = 120, p = tetraScrambler(null, K);
  const b4 = new Uint8Array(K); for (let k = 0; k < K; k++) b4[k] = sb[k] ^ p[k];
  const b3 = new Uint8Array(K); for (let i = 1; i <= K; i++) b3[i - 1] = b4[(11 * i) % K];
  // depuncture: type-3 bit j comes from mother output 8 ((j - 1) div 3) + P((j - 1) mod 3 + 1), P = 1, 2, 5
  const P = [1, 2, 5], m = new Float32Array(4 * 80);
  for (let j = 1; j <= K; j++) { const k = 8 * Math.floor((j - 1) / 3) + P[(j - 1) % 3]; m[k - 1] = b3[j - 1] ? -1 : 1; }
  const b2 = viterbi(m, 80);
  let crc = 0; for (let i = 60; i < 76; i++) crc = (crc << 1) | b2[i];
  return tetraCrc16(b2, 60) === crc ? b2.slice(0, 60) : null;
}
export interface TetraSync {
  systemCode: number; colorCode: number; timeslot: number; frame: number; multiframe: number; sharing: number;
  mcc: number; mnc: number; neighbourBroadcast: number; cellLoad: number; lateEntry: boolean;
}
export function tetraSyncPdu(b: ArrayLike<number>): TetraSync {
  let i = 0; const f = (n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 2 + b[i++]; return v; };
  const systemCode = f(4), colorCode = f(6), timeslot = f(2) + 1, frame = f(5), multiframe = f(6), sharing = f(2);
  f(3); f(1); f(1); f(1);
  const mcc = f(10), mnc = f(14), neighbourBroadcast = f(2), cellLoad = f(2), lateEntry = f(1) === 1;
  return { systemCode, colorCode, timeslot, frame, multiframe, sharing, mcc, mnc, neighbourBroadcast, cellLoad, lateEntry };
}

/** The receiver: complex baseband in, BSCH contents out. */
export class TetraRx {
  onSync: (s: TetraSync) => void = () => undefined;
  readonly stats = { symbols: 0, trainings: 0, bschOk: 0, bschBad: 0 };
  private readonly T: number;
  private re = new Float32Array(0); private im = new Float32Array(0); private n = 0;
  /** Phase steps kept for the burst before each training sequence. */
  private readonly ring = new Float32Array(512); private rp = 0; private last = -1e9;
  constructor(readonly fs: number) { this.T = fs / TETRA_BAUD; }
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
    // the timing whose phase steps sit closest to odd multiples of pi/4 (|mean of e^(4j step)|: a frequency offset does not move it)
    for (let p = 0; p < 8; p++) { let x = 0, y = 0; for (let k = 0; k < BLK; k += 3) { const v = 4 * this.dphi(t0 + p * T / 8 + k * T); x += Math.cos(v); y += Math.sin(v); } const s = x * x + y * y; if (s > bm) { bm = s; best = p; } }
    let cr = 0, ci = 0;
    for (let k = 0; k < BLK; k++) { const v = this.dphi(t0 + best * T / 8 + k * T); cr += Math.cos(4 * v); ci += Math.sin(4 * v); }
    const off = Math.atan2(ci, cr) - Math.PI, corr = Math.atan2(Math.sin(off), Math.cos(off)) / 4;
    for (let k = 0; k < BLK; k++) { let v = this.dphi(t0 + best * T / 8 + k * T) - corr; v = Math.atan2(Math.sin(v), Math.cos(v)); this.symbol(v); }
    const used = Math.floor(BLK * T);
    this.re.copyWithin(0, used, this.n); this.im.copyWithin(0, used, this.n); this.n -= used;
  }
  private symbol(v: number): void {
    this.ring[this.rp] = v; this.rp = (this.rp + 1) & 511; this.stats.symbols++;
    // the last 19 phase steps against the training sequence
    let c = 0; for (let i = 0; i < 19; i++) c += Math.cos(this.ring[(this.rp - 19 + i + 512) & 511] - SYNC_STEPS[i]);
    if (c < 0.8 * 19 || this.stats.symbols - this.last < 200) return;
    this.last = this.stats.symbols; this.stats.trainings++;
    // the 60 BSCH symbols right before the training sequence
    const sb = new Uint8Array(120);
    for (let i = 0; i < 60; i++) {
      const s = this.ring[(this.rp - 19 - 60 + i + 512) & 511];
      const d = s > Math.PI / 2 ? 1 : s > 0 ? 0 : s > -Math.PI / 2 ? 2 : 3;
      sb[2 * i] = d >> 1; sb[2 * i + 1] = d & 1;
    }
    const b = tetraBsch(sb);
    if (!b) { this.stats.bschBad++; return; }
    this.stats.bschOk++;
    this.onSync(tetraSyncPdu(b));
  }
}
