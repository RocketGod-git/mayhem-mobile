/**
 * TETRA downlink (ETSI EN 300 392-2), receive only: the physical layer and the channel coding of the logical channels.
 * The MAC and the layers above it are in tetra-mac.ts, speech in tetra-acelp.ts. No DOM.
 *
 *  - pi/4-DQPSK at 18000 symbols a second (5.5, Table 5.1: phase steps +pi/4 = 00, +3pi/4 = 01, -pi/4 = 10,
 *    -3pi/4 = 11), demodulated by the phase step across one symbol, timing picked again every 255 symbols. Each symbol
 *    gives two soft bits: the sine of its phase step for the first bit, the cosine for the second (positive is 0).
 *  - Slots of 255 symbols (9.4.4.2), four to a TDMA frame. The synchronization continuous downlink burst (Table 9.9)
 *    is found by its 38-bit training sequence (9.4.4.3.4) and gives the slot timing and, through the BSCH, the
 *    timeslot, frame and multiframe numbers; from then on every slot is read where it falls and recognized by its
 *    training sequence (normal training sequences 1 and 2 of 9.4.4.3.2, Table 9.13), the timing kept within two
 *    symbols of where each one is found.
 *  - Channel coding (clause 8): the (K1 + 16, K1) block code (8.2.3.3), tail bits and the 16-state rate 1/4 mother
 *    code (8.2.3.1.1: G1 = 1 + D + D^4, G2 = 1 + D^2 + D^3 + D^4, G3 = 1 + D + D^2 + D^4, G4 = 1 + D + D^3 + D^4)
 *    punctured to rate 2/3 (8.2.3.1.3: P = 1, 2, 5 of every 8), block interleaving (8.2.4.1) and scrambling (8.2.5)
 *    for the BSCH (K1 = 60, a = 11, all-zero color code), SCH/HD, BNCH and STCH (K1 = 124, a = 101) and SCH/F
 *    (K1 = 268, a = 103) (8.3.1.2, 8.3.1.4.1, 8.3.1.4.5); the shortened (30,14) Reed-Muller code of the AACH (8.2.3.2,
 *    8.3.1.1). Every channel but the BSCH is scrambled with the extended color code: MCC, MNC and color code
 *    (clause 23, figure 23.5).
 *  - The MAC SYNC PDU (21.4.4.2, Table 21.76) and the D-MLE-SYNC it carries (18.4.2.1, Table 18.17).
 */
export const TETRA_BAUD = 18000;
const BLK = 255;
/** Table 5.1: the phase step of each dibit. */
const STEP: Record<number, number> = { 0: Math.PI / 4, 1: 3 * Math.PI / 4, 2: -Math.PI / 4, 3: -3 * Math.PI / 4 };
/** The synchronization training sequence y1 to y38 (9.4.4.3.4). */
export const TETRA_SYNC_BITS = [1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1];
/** Normal training sequences 1 (n1 to n22, equation 9.4) and 2 (p1 to p22, equation 9.5). */
export const TETRA_NTS1 = [1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0];
export const TETRA_NTS2 = [0, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0];
const steps = (b: number[]) => Array.from({ length: b.length / 2 }, (_, i) => STEP[(b[2 * i] << 1) | b[2 * i + 1]]);
const SYNC_STEPS = steps(TETRA_SYNC_BITS), N1_STEPS = steps(TETRA_NTS1), N2_STEPS = steps(TETRA_NTS2);
/** Where the training sequences sit in a burst, in symbols from its first (Tables 9.7 and 9.9). */
const SYNC_AT = 107, NTS_AT = 122;

/** The 30-bit extended color code e(1) .. e(30): MCC (10 bits), MNC (14), color code (6), most significant first. */
export function tetraColorBits(mcc: number, mnc: number, cc: number): Uint8Array {
  const e = new Uint8Array(30);
  for (let i = 0; i < 10; i++) e[i] = (mcc >> (9 - i)) & 1;
  for (let i = 0; i < 14; i++) e[10 + i] = (mnc >> (13 - i)) & 1;
  for (let i = 0; i < 6; i++) e[24 + i] = (cc >> (5 - i)) & 1;
  return e;
}
/** The scrambling sequence (8.2.5.2) from the 30-bit extended color code (all zeros for the BSCH). */
export function tetraScrambler(e: ArrayLike<number> | null, n: number): Uint8Array {
  const C = [1, 2, 4, 5, 7, 8, 10, 11, 12, 16, 22, 23, 26, 32];
  const p = new Uint8Array(n + 32);   // p[j] is p(k) for k = j - 31
  p[0] = 1; p[1] = 1;                  // p(-31) = p(-30) = 1
  for (let k = -29; k <= 0; k++) p[k + 31] = e ? e[-k] & 1 : 0;   // p(k) = e(1 - k)
  for (let j = 32; j < n + 32; j++) { let v = 0; for (const i of C) v ^= p[j - i]; p[j] = v; }
  return p.subarray(32);              // p(1) .. p(n)
}
const scrCache = new Map<string, Uint8Array>();
function scrambler(e: ArrayLike<number> | null, n: number): Uint8Array {
  const k = `${e ? Array.from(e).join('') : '0'}:${n}`;
  let s = scrCache.get(k); if (!s) { s = tetraScrambler(e, n); if (scrCache.size > 64) scrCache.clear(); scrCache.set(k, s); }
  return s;
}
/** Soft bits descrambled with the extended color code [e] (a scrambling bit of 1 turns the sign). */
export function tetraDescramble(soft: ArrayLike<number>, e: ArrayLike<number> | null): Float32Array {
  const p = scrambler(e, soft.length), out = new Float32Array(soft.length);
  for (let k = 0; k < soft.length; k++) out[k] = p[k] ? -soft[k] : soft[k];
  return out;
}
/** The (K1 + 16, K1) block code check of 8.2.3.3: the 16 bits after the K1 information bits. */
export function tetraCrc16(bits: ArrayLike<number>, k1: number): number {
  let r = 0xffff;
  for (let i = 0; i < k1; i++) { const fb = ((r >> 15) & 1) ^ bits[i]; r = (r << 1) & 0xffff; if (fb) r ^= 0x1021; }
  return r ^ 0xffff;
}
/** The generator polynomials of the rate 1/4 mother code (8.2.3.1.1), bit j the coefficient of D^j. */
export const TETRA_G4 = [0b10011, 0b11101, 0b10111, 0b11011];
/**
 * Viterbi decoding of a 16-state mother code of rate 1/n ([gens], bit j the coefficient of D^j) from soft values
 * (+1 for 0, -1 for 1, 0 erased), [k2] bits, the coder ending in state zero (tail bits).
 */
export function tetraViterbi(m: ArrayLike<number>, k2: number, gens: number[] = TETRA_G4): Uint8Array {
  const S = 16, INF = 1e18, n = gens.length;
  const outs = new Int8Array(32 * n);   // the coded bits (as +1 / -1) for each register value
  for (let reg = 0; reg < 32; reg++) for (let i = 0; i < n; i++) { let v = 0; for (let j = 0; j < 5; j++) if (gens[i] & (1 << j)) v ^= (reg >> j) & 1; outs[reg * n + i] = v ? -1 : 1; }
  let pm = new Float64Array(S).fill(INF), np = new Float64Array(S); pm[0] = 0;
  const prev = new Uint8Array(k2 * S), bitOf = new Uint8Array(k2 * S);
  for (let k = 0; k < k2; k++) {
    np.fill(INF);
    for (let s = 0; s < S; s++) {
      if (pm[s] >= INF) continue;
      for (let b = 0; b < 2; b++) {
        const reg = (s << 1) | b;
        let cost = 0; for (let i = 0; i < n; i++) cost -= outs[reg * n + i] * m[n * k + i];
        const ns = reg & 15, c = pm[s] + cost;
        if (c < np[ns]) { np[ns] = c; prev[k * S + ns] = s; bitOf[k * S + ns] = b; }
      }
    }
    const t = pm; pm = np; np = t;
  }
  let s = 0;
  const out = new Uint8Array(k2);
  for (let k = k2 - 1; k >= 0; k--) { out[k] = bitOf[k * S + s]; s = prev[k * S + s]; }
  return out;
}
/** Block de-interleaving (8.2.4.1): b4(k) = b3(i) with k = 1 + (a i mod K), so b3(i) is read from there. */
export function tetraDeinterleave(b4: ArrayLike<number>, a: number): Float32Array {
  const K = b4.length, b3 = new Float32Array(K);
  for (let i = 1; i <= K; i++) b3[i - 1] = b4[(a * i) % K];
  return b3;
}
/**
 * Type-5 soft bits of one block to its type-1 bits: descrambled with [e], de-interleaved, depunctured (rate 2/3 of
 * the mother code: type-3 bit j is mother bit 8 ((j - 1) div 3) + P((j - 1) mod 3 + 1), P = 1, 2, 5), Viterbi
 * decoded and checked by the block code. Null when the check fails.
 */
export function tetraDecode23(soft: ArrayLike<number>, k1: number, a: number, e: ArrayLike<number> | null): Uint8Array | null {
  const K = soft.length, k2 = k1 + 20;
  const b3 = tetraDeinterleave(tetraDescramble(soft, e), a);
  const P = [1, 2, 5], m = new Float32Array(4 * k2);
  for (let j = 1; j <= K; j++) { const k = 8 * Math.floor((j - 1) / 3) + P[(j - 1) % 3]; m[k - 1] = b3[j - 1]; }
  const b2 = tetraViterbi(m, k2);
  let crc = 0; for (let i = k1; i < k1 + 16; i++) crc = (crc << 1) | b2[i];
  return tetraCrc16(b2, k1) === crc ? b2.slice(0, k1) : null;
}
/** Hard bits (0/1) to soft values; soft values pass through. */
function toSoft(b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(b.length); let hard = true;
  for (let i = 0; i < b.length; i++) if (b[i] !== 0 && b[i] !== 1) { hard = false; break; }
  for (let i = 0; i < b.length; i++) out[i] = hard ? (b[i] ? -1 : 1) : b[i];
  return out;
}
/** Type-5 BSCH bits (120, hard 0/1 or soft) to the 60 type-1 bits, or null. */
export const tetraBsch = (sb: ArrayLike<number>) => tetraDecode23(toSoft(sb), 60, 11, null);
/** SCH/HD, BNCH or STCH: 216 type-5 bits (hard or soft) to 124 type-1 bits. */
export const tetraSchHd = (soft: ArrayLike<number>, e: ArrayLike<number>) => tetraDecode23(toSoft(soft), 124, 101, e);
/** SCH/F: 432 type-5 bits (hard or soft) to 268 type-1 bits. */
export const tetraSchF = (soft: ArrayLike<number>, e: ArrayLike<number>) => tetraDecode23(toSoft(soft), 268, 103, e);

/** The parity part of the (30,14) Reed-Muller generator matrix (8.2.3.2, equation 8.13): row i is info bit i. */
const RM_P = [0b1001101101100000, 0b0010110111100000, 0b1111110000100000, 0b1110000000111100, 0b1001100000111010, 0b0101010000110110, 0b0010110000101110,
  0b1111111111011111, 0b1000001100111001, 0b0100001010110101, 0b0010000110101101, 0b0001001001110011, 0b0000100101101011, 0b0000010011100111];
/** Syndrome to error pattern (30 bits) for every pattern of up to three errors (the code's distance is 8). */
let rmFix: Int32Array | null = null;
function rmTable(): Int32Array {
  if (rmFix) return rmFix;
  const t = new Int32Array(65536).fill(-1); t[0] = 0;
  const syn = (err: number) => { let s = 0; for (let i = 0; i < 14; i++) if ((err >>> (29 - i)) & 1) s ^= RM_P[i]; return s ^ (err & 0xffff); };
  for (let a = 0; a < 30; a++) {
    const ea = 1 << a; if (t[syn(ea)] < 0) t[syn(ea)] = ea;
    for (let b = a + 1; b < 30; b++) {
      const eb = ea | (1 << b); if (t[syn(eb)] < 0) t[syn(eb)] = eb;
      for (let c = b + 1; c < 30; c++) { const ec = eb | (1 << c); if (t[syn(ec)] < 0) t[syn(ec)] = ec; }
    }
  }
  return (rmFix = t);
}
/** The AACH: 30 type-5 bits (hard 0/1 or soft), descrambled, to the 14 bits of the ACCESS-ASSIGN PDU (null past three errors). */
export function tetraAach(bits: ArrayLike<number>, e: ArrayLike<number>): number | null {
  const soft = toSoft(bits), p = scrambler(e, 30);
  let w = 0; for (let k = 0; k < 30; k++) w = (w << 1) | ((soft[k] < 0 ? 1 : 0) ^ p[k]);
  let s = 0; for (let i = 0; i < 14; i++) if ((w >>> (29 - i)) & 1) s ^= RM_P[i];
  s ^= w & 0xffff;
  const fix = rmTable()[s]; if (fix < 0) return null;
  return ((w ^ fix) >>> 16) & 0x3fff;
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

/**
 * One downlink slot as received: which burst it is ('sync', or a normal burst with training sequence 1 or 2), its
 * timeslot (1 to 4), frame (1 to 18) and multiframe (1 to 60) numbers, and its 510 soft bits (bit k of the burst at
 * index k - 1). [sync] is the BSCH of a synchronization burst when it came through.
 */
export interface TetraBurst { kind: 'sync' | 'n1' | 'n2'; tn: number; fn: number; mn: number; soft: Float32Array; score: number; sync: TetraSync | null }

/** The receiver: complex baseband in, slots and the BSCH contents out. */
export class TetraRx {
  onSync: (s: TetraSync) => void = () => undefined;
  /** Every slot whose training sequence was found, once the slot timing is known. */
  onBurst: (b: TetraBurst) => void = () => undefined;
  readonly stats = { symbols: 0, trainings: 0, bschOk: 0, bschBad: 0, bursts: 0, lost: 0 };
  private readonly T: number;
  private re = new Float32Array(0); private im = new Float32Array(0); private n = 0;
  /** Phase steps of the last 4096 symbols, by symbol number. */
  private readonly ring = new Float32Array(4096); private last = -1e9;
  /** The slot timing: the symbol number the next slot starts at, its numbers, and the slots missed in a row. */
  private lock: { start: number; tn: number; fn: number; mn: number; miss: number } | null = null;
  constructor(readonly fs: number) { this.T = fs / TETRA_BAUD; }
  /** Whether the slot timing is known. */
  get locked(): boolean { return this.lock !== null; }
  push(zi: ArrayLike<number>, zq: ArrayLike<number>, m: number): void {
    if (this.n + m > this.re.length) { const r = new Float32Array(Math.max(2 * this.re.length, this.n + m + 1024)), q = new Float32Array(r.length); r.set(this.re.subarray(0, this.n)); q.set(this.im.subarray(0, this.n)); this.re = r; this.im = q; }
    for (let k = 0; k < m; k++) { this.re[this.n] = zi[k]; this.im[this.n++] = zq[k]; }
    const need = Math.ceil((BLK + 2) * this.T) + 2;
    while (this.n >= need) this.block();
  }
  /** Phase step between the samples at t and t - T (linear interpolation). */
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
  private at(k: number): number { return this.ring[k & 4095]; }
  /** How well the symbols from [k] on match [ref] (the mean cosine of the phase differences, 1 for a perfect match). */
  private match(k: number, ref: number[]): number { let c = 0; for (let i = 0; i < ref.length; i++) c += Math.cos(this.at(k + i) - ref[i]); return c / ref.length; }
  private symbol(v: number): void {
    const k = this.stats.symbols++;
    this.ring[k & 4095] = v;
    const L = this.lock;
    if (L) { if (k >= L.start + BLK + 2) this.slot(); return; }
    // no slot timing yet: the last 19 phase steps against the synchronization training sequence
    if (k < 19 + SYNC_AT || k - this.last < 200 || this.match(k - 18, SYNC_STEPS) < 0.8) return;
    this.last = k; this.stats.trainings++;
    const start = k - 18 - SYNC_AT, s = this.bsch(start, true);
    // the slot timing is known from here: this burst is read again in full once its last symbols are in
    if (s) this.lock = { start, tn: s.timeslot, fn: s.frame, mn: s.multiframe, miss: 0 };
  }
  private softOf(start: number): Float32Array {
    const soft = new Float32Array(2 * BLK);
    for (let j = 0; j < BLK; j++) { const v = this.at(start + j); soft[2 * j] = Math.sin(v); soft[2 * j + 1] = Math.cos(v); }
    return soft;
  }
  /** The BSCH of a synchronization burst starting at symbol [start]: the 120 bits before its training sequence. */
  private bsch(start: number, quiet = false): TetraSync | null {
    const soft = new Float32Array(120);
    for (let i = 0; i < 60; i++) { const v = this.at(start + 47 + i); soft[2 * i] = Math.sin(v); soft[2 * i + 1] = Math.cos(v); }
    const b = tetraDecode23(soft, 60, 11, null);
    if (!b) { if (!quiet) this.stats.bschBad++; return null; }
    const s = tetraSyncPdu(b);
    if (!quiet) { this.stats.bschOk++; this.onSync(s); }
    return s;
  }
  /** The slot due now: found within two symbols of where it should start, by its training sequence. */
  private slot(): void {
    const L = this.lock!;
    let best = -1, kind: TetraBurst['kind'] = 'n1', d0 = 0;
    for (let d = -2; d <= 2; d++) {
      const s = L.start + d, n1 = this.match(s + NTS_AT, N1_STEPS), n2 = this.match(s + NTS_AT, N2_STEPS), sy = this.match(s + SYNC_AT, SYNC_STEPS);
      // a small preference for the expected place, so a training sequence is not read one symbol off in noise
      const w = d === 0 ? 0.02 : 0;
      if (n1 + w > best) { best = n1 + w; kind = 'n1'; d0 = d; }
      if (n2 + w > best) { best = n2 + w; kind = 'n2'; d0 = d; }
      if (sy + w > best) { best = sy + w; kind = 'sync'; d0 = d; }
    }
    let start = L.start;
    if (best >= 0.7) {
      start += d0; L.miss = 0; this.stats.bursts++;
      let sync: TetraSync | null = null;
      if (kind === 'sync') {
        this.stats.trainings++; this.last = start + SYNC_AT + 18;
        sync = this.bsch(start);
        if (sync) { L.tn = sync.timeslot; L.fn = sync.frame; L.mn = sync.multiframe; }
      }
      this.onBurst({ kind, tn: L.tn, fn: L.fn, mn: L.mn, soft: this.softOf(start), score: best, sync });
    } else if (++L.miss > 12) { this.lock = null; this.stats.lost++; return; }
    // on to the next slot
    L.start = start + BLK;
    if (++L.tn > 4) { L.tn = 1; if (++L.fn > 18) { L.fn = 1; if (++L.mn > 60) L.mn = 1; } }
  }
}
