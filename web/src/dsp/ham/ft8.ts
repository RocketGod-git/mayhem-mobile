/**
 * FT8 decoder. 12.8 kHz audio is cut into 15 s UTC slots and decoded in up to three passes:
 *  1. a half-symbol-step 4096-point Hann FFT with half-tone (3.125 Hz) bins builds the log-power waterfall, and the
 *     three 7-symbol Costas arrays are searched across time and frequency; each local peak of the sync score is a
 *     candidate (the search follows the approach in ft8_lib by Kārlis Goba, MIT);
 *  2. each candidate is mixed down to a 200 Hz complex baseband cut from one FFT of the whole slot, its start and
 *     frequency are refined against the Costas tones (5 ms, 0.125 Hz), and its 79 symbols are measured on their
 *     exact tones; the 58 data symbols give 174 soft bits (Gray-mapped 8-FSK), one symbol at a time (noncoherent)
 *     and three at a time (coherent: the tones keep their phase from symbol to symbol);
 *  3. LDPC(174,91) is decoded by belief propagation and, when that comes close, by ordered-statistics decoding (the most
 *     reliable 91 bits re-encoded, with every one and every pair of the least reliable of them flipped); the CRC-14
 *     is checked, an OSD result must also sit close to the received bits and unpack to a plausible standard message;
 *  4. each decode is rebuilt (GFSK, BT 2), its amplitude and phase tracked along the slot, and subtracted from the
 *     audio, so the next pass finds the weaker signals underneath. A pass that finds nothing new ends the slot.
 * Then the a-priori stage: a station heard in a recent slot of the same parity is looked for again near its
 * frequency with its two call fields pinned, and the rest of its message decoded from the signal.
 * The 77-bit payload is unpacked (standard, DXpedition, non-standard, free text, telemetry and RTTY contest types)
 * with a callsign hash table for the <...> references. Ft8.kt (Android) and Ft8.swift (iOS, Mac) are twins of this
 * file and decode the same audio to the same list.
 */
import { FT8_COSTAS, FT8_GRAY, LDPC_GENERATOR, LDPC_MN, LDPC_NM, LDPC_NUM_ROWS } from './ft8-tables.js';
import type { DigitalDecoder } from './digital.js';

// 12.8 kHz: a symbol is exactly 2048 samples, so the half-symbol-step 4096-point FFT (a power of two) has bins of
// 3.125 Hz = half a tone. (12 kHz would need a 3840-point mixed-radix FFT.)
const FS = 12_800, SYMBOL = 0.16, BLOCK = Math.round(FS * SYMBOL), TIME_OSR = 2, FREQ_OSR = 2, NFFT = BLOCK * FREQ_OSR, SUBBLOCK = BLOCK / TIME_OSR;
const TONE_HZ = 1 / SYMBOL;                    // 6.25
const FMIN = 200, FMAX = 3000;
const BIN_MIN = Math.round(FMIN / TONE_HZ), NUM_BINS = Math.round((FMAX - FMIN) / TONE_HZ);
const SLOT_S = 15, NUM_BLOCKS = Math.floor(SLOT_S / SYMBOL);   // 93
const BLOCK_STRIDE = TIME_OSR * FREQ_OSR * NUM_BINS;
const ND = 58, N = 174, K = 91, M = 83;
const CRC_POLY = 0x2757;
const NTOKENS = 2063592, MAX22 = 4194304, MAXGRID4 = 32400;
// the candidate grid: start in half symbols from -20 (-1.6 s) to 39, tone 0 in half tones
const T_MIN = -20, T_NUM = 60, F_NUM = 2 * (NUM_BINS - 7);
// the baseband: 200 Hz complex, 32 samples a symbol, cut from a 2^18-point FFT of the slot (0.049 Hz bins)
const BB_RATE = 200, BB_SPS = 32, NBIG = 1 << 18, NBB = NBIG * BB_RATE / FS, BIG_HZ = FS / NBIG;
// passband kept around tone 0 (Hz): flat over the eight tones and their skirts, a cosine taper outside
const BB_LO = -35, BB_FLAT_LO = -10, BB_FLAT_HI = 53.75, BB_HI = 78.75;
const BB_FROM = -16, BB_SPAN = 79 * BB_SPS + 32;   // refined starts within ±12 samples of the coarse one
const PASSES = 3, MAX_CANDS = [150, 100, 60], MIN_SYNC = 2.5;
const BP_ITERS = 30, LLR_VAR = 24;
// OSD safeguards: a candidate's BP must have come this close, and the OSD codeword must disagree with at most this
// many hard decisions and a weighted distance at most this share of the total reliability
const OSD_MAX_BP_ERRORS = 20, OSD_ORDER2 = 40, OSD_MAX_FLIPS = 40, OSD_MAX_DIST = 0.048;
// subtraction: amplitude and phase averaged over one symbol
const SUB_WIN = BLOCK;
// a candidate this close to a decode (Hz, s) is that decode again
const SKIP_HZ = 1.6, SKIP_S = 0.06;
// a-priori: a message decoded within the last two minutes in a slot of the same parity (even or odd) is looked for
// again near its frequency; it is kept only if the slot's bits sit this close to its codeword
const AP_WINDOW_MS = 120_000, AP_MAX_DIST = 0.13, AP_T_LO = -200, AP_T_HI = 500, AP_PIN = 30;
/** The known bits of a standard message: both call fields (with their /R or /P flags) and i3. */
const AP_KNOWN = (() => { const k = new Uint8Array(77); for (let i = 0; i < 58; i++) k[i] = 1; for (let i = 74; i < 77; i++) k[i] = 1; return k; })();
/** The symbols those bits fix: the three sync arrays and data symbols 0-18 (bits 0-56). */
const AP_SYMS = (() => { const s: number[] = []; for (let i = 0; i < 7; i++) s.push(i, 36 + i, 72 + i); for (let k = 0; k < 19; k++) s.push(7 + k); return s.sort((a, b) => a - b); })();
const AP_SPAN = AP_T_HI - AP_T_LO + 79 * BB_SPS + 2;

/** `ap`: found as a repeat of a message decoded in a recent slot (a-priori), not from the signal alone. */
export interface Ft8Decode { utc: string; snr: number; dt: number; hz: number; text: string; ap?: boolean; }

/** Switches for the tests: passes, ordered-statistics decoding, subtraction. */
export const ft8Options = { passes: PASSES, osd: true, subtract: true, ap: true };

export class Ft8Decoder implements DigitalDecoder {
  readonly name = 'FT8';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Ft8Decode[], slot: number) => void = () => {};
  /** Ring of 12.8 kHz samples covering a little more than one slot. */
  private readonly ring = new Float32Array(FS * 17);
  private wpos = 0; private total = 0;
  private readonly rs = new SincResampler(48_000, FS, 32);
  private t0 = 0;                 // wall-clock ms of sample index 0 (running estimate)
  private lastSlot = -1;
  private readonly mag = new Float64Array(NUM_BLOCKS * BLOCK_STRIDE);
  private readonly win = new Float64Array(NFFT);
  private readonly fftWf = new Fft(NFFT); private readonly fftBig = new Fft(NBIG); private readonly fftBb = new Fft(NBB);
  private readonly re = new Float64Array(NFFT); private readonly im = new Float64Array(NFFT);
  private readonly bigRe = new Float64Array(NBIG); private readonly bigIm = new Float64Array(NBIG);
  private readonly bbRe = new Float64Array(NBB); private readonly bbIm = new Float64Array(NBB);
  private readonly zRe = new Float64Array(BB_SPAN); private readonly zIm = new Float64Array(BB_SPAN);
  private readonly pw = new Float64Array(79 * 8);
  private readonly taper = new Float64Array(NBB);
  private readonly cosT = new Float64Array(8 * BB_SPS); private readonly sinT = new Float64Array(8 * BB_SPS);
  private readonly pulse = gfskPulse();
  /** The slot being decoded, less what has been decoded so far. */
  private readonly x = new Float64Array(FS * SLOT_S);
  private readonly subRe = new Float64Array(79 * BLOCK); private readonly subIm = new Float64Array(79 * BLOCK);
  private readonly cumRe = new Float64Array(79 * BLOCK + 1); private readonly cumIm = new Float64Array(79 * BLOCK + 1);
  private readonly hashes = new Map<number, string>();
  private pending: string[] = [];
  private slotBusy = false;
  constructor() {
    for (let i = 0; i < NFFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
    for (let k = 0; k < 8; k++) for (let n = 0; n < BB_SPS; n++) { const a = 2 * Math.PI * k * n / BB_SPS; this.cosT[k * BB_SPS + n] = Math.cos(a); this.sinT[k * BB_SPS + n] = Math.sin(a); }
    for (let i = 0; i < NBB; i++) {
      const hz = (i < NBB / 2 ? i : i - NBB) * BIG_HZ;
      this.taper[i] = hz < BB_LO || hz > BB_HI ? 0 : hz < BB_FLAT_LO ? 0.5 - 0.5 * Math.cos(Math.PI * (hz - BB_LO) / (BB_FLAT_LO - BB_LO))
        : hz > BB_FLAT_HI ? 0.5 + 0.5 * Math.cos(Math.PI * (hz - BB_FLAT_HI) / (BB_HI - BB_FLAT_HI)) : 1;
    }
  }
  reset(): void { this.wpos = 0; this.total = 0; this.rs.reset(); this.lastSlot = -1; this.confidence = 0; }

  /** 48 kHz audio in, resampled to 12.8 kHz into the ring. */
  push(a: Float32Array, n: number): void {
    this.rs.process(a, n, v => { this.ring[this.wpos] = v; this.wpos = (this.wpos + 1) % this.ring.length; this.total++; });
    // keep the wall clock of the stream: sample `total` was written "now"
    const now = Date.now();
    const est = now - this.total / FS * 1000;
    this.t0 = this.t0 === 0 ? est : this.t0 + 0.05 * (est - this.t0);
    const slot = Math.floor(now / (SLOT_S * 1000));
    // decode the previous slot once we are 0.3 s into the next one (transmissions end at 13.2 s)
    if (slot !== this.lastSlot && now - slot * SLOT_S * 1000 > 300 && this.total > FS * SLOT_S && !this.slotBusy) {
      this.lastSlot = slot;
      this.slotBusy = true;
      try { this.decodeSlot((slot - 1) * SLOT_S * 1000); } finally { this.slotBusy = false; }
    }
  }

  private sampleAt(ms: number): number { return Math.round((ms - this.t0) / 1000 * FS); }

  private readonly slotBuf = new Float32Array(FS * SLOT_S);

  private decodeSlot(slotStartMs: number): void {
    const start = this.sampleAt(slotStartMs);
    if (start < this.total - this.ring.length || start + FS * SLOT_S > this.total) return;
    const L = this.ring.length;
    for (let i = 0; i < this.slotBuf.length; i++) { const s = start + i; this.slotBuf[i] = s >= 0 ? this.ring[((s % L) + L) % L] : 0; }
    const results = this.decodeBuffer(this.slotBuf, slotStartMs);
    this.confidence = results.length ? 1 : Math.max(0, this.confidence - 0.3);
    for (const r of results) this.onText(`${r.utc} ${String(r.snr).padStart(3)} ${r.dt.toFixed(1).padStart(4)} ${String(r.hz).padStart(4)} ~  ${r.text}\n`, 'FT8');
    this.onDecodes(results, slotStartMs);
  }

  /** Decode one 15 s slot of 12.8 kHz audio (also used by the tests with synthetic signals). */
  decodeBuffer(buf: Float32Array, slotStartMs = 0): Ft8Decode[] {
    const x = this.x, nb = Math.min(buf.length, x.length);
    for (let i = 0; i < x.length; i++) x[i] = i < nb ? buf[i] : 0;
    const d = new Date(slotStartMs), utc = `${d.getUTCHours().toString().padStart(2, '0')}${d.getUTCMinutes().toString().padStart(2, '0')}${d.getUTCSeconds().toString().padStart(2, '0')}`;
    const found: Found[] = [];
    const texts = new Set<string>();
    const o = ft8Options;
    for (let pass = 0; pass < o.passes; pass++) {
      this.buildWaterfall();
      const cands = this.findCandidates(MAX_CANDS[Math.min(pass, MAX_CANDS.length - 1)], MIN_SYNC);
      this.spectrum();
      let added = 0;
      for (const c of cands) {
        // the 2-symbol waterfall window is centered half a symbol after its start
        const tc = (c.t / TIME_OSR + 0.5) * SYMBOL, fc = (BIN_MIN + c.f / FREQ_OSR) * TONE_HZ;
        // a spot an earlier decode already explains
        if (found.some(f => Math.abs(f.hz - fc) < SKIP_HZ && Math.abs(f.t - tc) < SKIP_S)) continue;
        const r = this.decodeCandidate(tc, fc);
        if (!r) continue;
        if (texts.has(r.text)) continue;
        texts.add(r.text);
        for (const call of this.pending) this.save(call);
        found.push(r); added++;
        if (o.subtract && (pass + 1 < o.passes || o.ap)) this.subtract(r);
      }
      if (!added) break;
    }
    if (o.ap) this.apStage(found, texts, slotStartMs);
    // remember this slot's messages for the next slots
    const keep = this.history.filter(h => h.slot < slotStartMs && slotStartMs - h.slot <= AP_WINDOW_MS && !texts.has(h.text));
    this.history.length = 0;
    this.history.push(...keep, ...found.filter(r => !r.ap && isStd(r.bits)).map(r => ({ text: r.text, tones: r.tones, bits: r.bits, hz: r.hz, slot: slotStartMs })));
    const results: Ft8Decode[] = found.map(r => {
      const d: Ft8Decode = { utc, snr: r.snr, dt: Math.round((r.t - 0.5) * 10) / 10, hz: Math.round(r.hz), text: r.text };
      if (r.ap) d.ap = true;
      return d;
    });
    results.sort((a, b) => b.snr - a.snr || a.hz - b.hz || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
    return results;
  }

  private buildWaterfall(): void {
    const mag = this.mag, re = this.re, im = this.im, win = this.win, buf = this.x, L = buf.length;
    for (let blk = 0; blk < NUM_BLOCKS; blk++) {
      for (let ts = 0; ts < TIME_OSR; ts++) {
        const off = blk * BLOCK + ts * SUBBLOCK;
        for (let i = 0; i < NFFT; i++) { const s = off + i; re[i] = s < L ? buf[s] * win[i] : 0; im[i] = 0; }
        this.fftWf.run(re, im, false);
        for (let fs = 0; fs < FREQ_OSR; fs++) {
          const base = ((blk * TIME_OSR + ts) * FREQ_OSR + fs) * NUM_BINS;
          for (let b = 0; b < NUM_BINS; b++) {
            const src = (BIN_MIN + b) * FREQ_OSR + fs;
            const p = re[src] * re[src] + im[src] * im[src];
            mag[base + b] = 10 * Math.log10(p + 1e-12);
          }
        }
      }
    }
  }

  /** Costas sync score (mean dB of each sync tone over its neighbors in time and frequency) at half-symbol start t, half-tone f. */
  private syncScore(t: number, f: number): number {
    const mag = this.mag;
    const timeOffset = Math.floor(t / TIME_OSR), timeSub = t - timeOffset * TIME_OSR;
    const freqOffset = f >> 1, freqSub = f & 1;
    const base = ((timeOffset * TIME_OSR + timeSub) * FREQ_OSR + freqSub) * NUM_BINS + freqOffset;
    let score = 0, num = 0;
    for (let m = 0; m < 3; m++) for (let k = 0; k < 7; k++) {
      const block = 36 * m + k, blockAbs = timeOffset + block;
      if (blockAbs < 0) continue; if (blockAbs >= NUM_BLOCKS) break;
      const p = base + block * BLOCK_STRIDE, sm = FT8_COSTAS[k];
      const v = mag[p + sm];
      if (sm > 0) { score += v - mag[p + sm - 1]; num++; }
      if (sm < 7) { score += v - mag[p + sm + 1]; num++; }
      if (k > 0 && blockAbs > 0) { score += v - mag[p + sm - BLOCK_STRIDE]; num++; }
      if (k + 1 < 7 && blockAbs + 1 < NUM_BLOCKS) { score += v - mag[p + sm + BLOCK_STRIDE]; num++; }
    }
    return num ? score / num : 0;
  }

  private readonly scores = new Float64Array(T_NUM * F_NUM);

  /** The strongest local peaks of the sync score. */
  private findCandidates(max: number, minScore: number): Cand[] {
    const sc = this.scores;
    for (let ti = 0; ti < T_NUM; ti++) for (let f = 0; f < F_NUM; f++) sc[ti * F_NUM + f] = this.syncScore(ti + T_MIN, f);
    const list: Cand[] = [];
    for (let ti = 0; ti < T_NUM; ti++) for (let f = 0; f < F_NUM; f++) {
      const v = sc[ti * F_NUM + f];
      if (v < minScore) continue;
      let peak = true;
      for (let dt = -1; dt <= 1 && peak; dt++) for (let df = -1; df <= 1; df++) {
        if (!dt && !df) continue;
        const tt = ti + dt, ff = f + df; if (tt < 0 || tt >= T_NUM || ff < 0 || ff >= F_NUM) continue;
        const w = sc[tt * F_NUM + ff];
        // ties go to the earlier grid point
        if (w > v || (w === v && (dt < 0 || (dt === 0 && df < 0)))) { peak = false; break; }
      }
      if (peak) list.push({ t: ti + T_MIN, f, score: v });
    }
    list.sort((a, b) => b.score - a.score || a.t - b.t || a.f - b.f);
    return list.length > max ? list.slice(0, max) : list;
  }

  /** One FFT of the whole slot (zero-padded to 2^18), for the baseband cuts. */
  private spectrum(): void {
    const re = this.bigRe, im = this.bigIm, x = this.x;
    for (let i = 0; i < NBIG; i++) { re[i] = i < x.length ? x[i] : 0; im[i] = 0; }
    this.fftBig.run(re, im, false);
  }

  /** 200 Hz complex baseband with tone 0 near 0 Hz; returns the exact frequency of baseband 0 Hz. */
  private downconvert(f0: number): number {
    const k0 = Math.round(f0 / BIG_HZ), re = this.bbRe, im = this.bbIm, tp = this.taper;
    for (let i = 0; i < NBB; i++) {
      const g = tp[i];
      if (g === 0) { re[i] = 0; im[i] = 0; continue; }
      const k = k0 + (i < NBB / 2 ? i : i - NBB);
      re[i] = this.bigRe[k] * g; im[i] = this.bigIm[k] * g;
    }
    this.fftBb.run(re, im, true);
    return k0 * BIG_HZ;
  }

  /** The baseband from sample `from`, shifted down by `hz`, into zRe/zIm. */
  private rotate(from: number, hz: number): void {
    const w = -2 * Math.PI * hz / BB_RATE, wr = Math.cos(w), wi = Math.sin(w);
    let cr = Math.cos(w * from), ci = Math.sin(w * from);
    const re = this.bbRe, im = this.bbIm, zr = this.zRe, zi = this.zIm;
    for (let i = 0; i < BB_SPAN; i++) {
      const n = from + i;
      if (n >= 0 && n < NBB) { zr[i] = re[n] * cr - im[n] * ci; zi[i] = re[n] * ci + im[n] * cr; } else { zr[i] = 0; zi[i] = 0; }
      const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
    }
  }

  /** Power of one symbol on one tone, the symbol starting at offset `at` of zRe/zIm. */
  private tonePower(at: number, tone: number): number {
    const zr = this.zRe, zi = this.zIm, c = this.cosT, s = this.sinT, o = tone * BB_SPS;
    let a = 0, b = 0;
    for (let n = 0; n < BB_SPS; n++) { const p = at + n; a += zr[p] * c[o + n] + zi[p] * s[o + n]; b += zi[p] * c[o + n] - zr[p] * s[o + n]; }
    this.lastRe = a; this.lastIm = b;
    return a * a + b * b;
  }
  private lastRe = 0; private lastIm = 0;
  private readonly cxr = new Float64Array(79 * 8); private readonly cxi = new Float64Array(79 * 8);

  /** Costas energy with symbol 0 at offset `at` of zRe/zIm. */
  private costasEnergy(at: number): number {
    let e = 0;
    for (let m = 0; m < 3; m++) for (let k = 0; k < 7; k++) e += this.tonePower(at + (36 * m + k) * BB_SPS, FT8_COSTAS[k]);
    return e;
  }

  private decodeCandidate(tc: number, fc: number): Found | null {
    const base = this.downconvert(fc);
    const t0 = Math.round(tc * BB_RATE), from = t0 + BB_FROM;
    // fine sync: 0.5 Hz and 10 ms, then 0.25 Hz and 5 ms, then 0.125 Hz
    let best = -1, bdf = 0, bdt = 0;
    const tryAt = (df: number, dtLo: number, dtHi: number, dtStep: number) => {
      this.rotate(from, fc - base + df);
      for (let dt = dtLo; dt <= dtHi; dt += dtStep) { const e = this.costasEnergy(dt - BB_FROM); if (e > best) { best = e; bdf = df; bdt = dt; } }
    };
    for (let i = -3; i <= 3; i++) tryAt(i * 0.5, -10, 10, 2);
    const c1 = bdf, t1 = bdt;
    tryAt(c1 - 0.25, t1 - 1, t1 + 1, 1); tryAt(c1, t1 - 1, t1 + 1, 1); tryAt(c1 + 0.25, t1 - 1, t1 + 1, 1);
    const c2 = bdf, t2 = bdt;
    tryAt(c2 - 0.125, t2, t2, 1); tryAt(c2 + 0.125, t2, t2, 1);
    // the symbols on the exact tones
    this.rotate(from, fc - base + bdf);
    const at0 = bdt - BB_FROM;
    const eM = this.costasEnergy(at0 - 1), eP = this.costasEnergy(at0 + 1), e0 = this.costasEnergy(at0);
    const den = eM - 2 * e0 + eP, frac = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (eM - eP) / den)) : 0;
    const P = this.pw;
    this.measure(at0);
    // belief propagation on the one-symbol likelihoods, then on the three-symbol ones; OSD on the latter if BP came close
    const llr = new Float64Array(N), plain = new Uint8Array(N);
    let viaOsd = false;
    this.softBits(P, llr);
    if (bpDecode(llr, BP_ITERS, plain) > 0) {
      this.coherentBits(llr);
      const errors = bpDecode(llr, BP_ITERS, plain);
      if (errors > 0) {
        if (!ft8Options.osd || errors > OSD_MAX_BP_ERRORS || !osdDecode(llr, plain)) return null;
        viaOsd = true;
      }
    }
    return this.finish(plain, viaOsd, fc + bdf, (t0 + bdt + frac) / BB_RATE, false);
  }

  /**
   * A codeword to a decode: the CRC over the 77 payload bits (and 5 zeros), and for one from OSD or a-priori
   * decoding a plausible standard message with no unresolved hash; then the tones and the SNR.
   */
  private finish(plain: Uint8Array, strict: boolean, hz: number, t: number, ap: boolean): Found | null {
    const a91 = new Uint8Array(12);
    for (let i = 0; i < K; i++) if (plain[i]) a91[i >> 3] |= 0x80 >> (i & 7);
    const crcExtracted = ((a91[9] & 0x07) << 11) | (a91[10] << 3) | (a91[11] >> 5);
    a91[9] &= 0xF8; a91[10] = 0;
    if (crc14(a91, 82) !== crcExtracted) return null;
    if (strict && !plausibleStd(a91)) return null;
    this.pending = [];
    const text = this.unpack(a91.subarray(0, 10));
    if (text === null) return null;
    if (strict && (text.includes('<') || text.split(' ').some(w => w === ''))) return null;
    const tones = new Uint8Array(79);
    for (let k = 0; k < 7; k++) { tones[k] = FT8_COSTAS[k]; tones[36 + k] = FT8_COSTAS[k]; tones[72 + k] = FT8_COSTAS[k]; }
    for (let k = 0; k < ND; k++) tones[k + (k < 29 ? 7 : 14)] = FT8_GRAY[(plain[3 * k] << 2) | (plain[3 * k + 1] << 1) | plain[3 * k + 2]];
    return { text, snr: this.snrOf(tones), hz, t, tones, ap, bits: plain.slice(0, 77) };
  }

  /** SNR in 2500 Hz from the sent tones' power against the other seven tones' (noise) level. */
  private snrOf(tones: Uint8Array): number {
    const P = this.pw; let sig = 0; const noise: number[] = [];
    for (let s = 0; s < 79; s++) for (let k = 0; k < 8; k++) { const v = P[s * 8 + k]; if (k === tones[s]) sig += v; else noise.push(v); }
    noise.sort((a, b) => a - b);
    const nf = noise[noise.length >> 1] / Math.LN2, ps = sig / 79 - nf;
    return Math.max(-28, Math.min(40, Math.round(10 * Math.log10(Math.max(1e-9, ps / nf)) - 26.0206)));
  }

  /** The 79 symbols' tone powers and complex values from offset `at` of zRe/zIm, into pw, cxr and cxi. */
  private measure(at: number): void {
    for (let s = 0; s < 79; s++) for (let k = 0; k < 8; k++) { this.pw[s * 8 + k] = this.tonePower(at + s * BB_SPS, k); this.cxr[s * 8 + k] = this.lastRe; this.cxi[s * 8 + k] = this.lastIm; }
  }

  /**
   * The a-priori stage. A station heard in a recent slot of this parity usually sends again with the same two call
   * fields (only the report, grid, RRR, RR73 or 73 changes). For each such call pair not decoded in this slot, the
   * signal is looked for near its last frequency by the energy on the tones those known bits fix (the sync and the
   * first 19 data symbols), and decoded with the known bits pinned: belief propagation, then OSD. The result still has
   * to be an LDPC codeword with a good CRC that unpacks to a plausible standard message, and the slot's own bits must
   * agree with it closely; so the report and the rest are read from the signal, never assumed.
   */
  private apStage(found: Found[], texts: Set<string>, slotMs: number): void {
    const seen = new Set<string>(), hyps: typeof this.history = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.slot >= slotMs || slotMs - h.slot > AP_WINDOW_MS || (slotMs - h.slot) % 30_000 !== 0) continue;
      const key = callsKey(h.bits);
      if (seen.has(key)) continue;
      seen.add(key);
      if (found.some(f => !f.ap && callsKey(f.bits) === key)) continue;
      hyps.push(h);
    }
    if (!hyps.length) return;
    this.spectrum();
    const llr = new Float64Array(N), raw = new Float64Array(N), plain = new Uint8Array(N);
    for (const h of hyps) {
      if (found.some(f => Math.abs(f.hz - h.hz) < 3)) continue;
      const base = this.downconvert(h.hz);
      let best = -1, bdf = 0, bt = 0;
      for (let i = -4; i <= 4; i++) {
        const df = i * 0.5;
        this.apEnergies(h.hz - base + df);
        for (let t = AP_T_LO; t <= AP_T_HI; t += 2) { const e = this.apAt(t, h.tones); if (e > best) { best = e; bdf = df; bt = t; } }
      }
      const c1 = bdf, t1 = bt;
      for (const df of [c1 - 0.25, c1, c1 + 0.25, c1 - 0.125, c1 + 0.125]) {
        this.apEnergies(h.hz - base + df);
        for (let t = Math.max(AP_T_LO, t1 - 2); t <= Math.min(AP_T_HI, t1 + 2); t++) { const e = this.apAt(t, h.tones); if (e > best) { best = e; bdf = df; bt = t; } }
      }
      if (found.some(f => Math.abs(f.hz - (h.hz + bdf)) < SKIP_HZ && Math.abs(f.t - bt / BB_RATE) < SKIP_S)) continue;
      this.rotate(bt + BB_FROM, h.hz - base + bdf);
      this.measure(-BB_FROM);
      let r: Found | null = null;
      for (let m = 0; m < 2 && !r; m++) {
        if (m === 0) this.softBits(this.pw, raw); else this.coherentBits(raw);
        llr.set(raw);
        for (let i = 0; i < 77; i++) if (AP_KNOWN[i]) llr[i] = h.bits[i] ? AP_PIN : -AP_PIN;
        let ok = bpDecode(llr, BP_ITERS, plain) === 0;
        if (!ok && ft8Options.osd) ok = osdDecode(llr, plain, true);
        if (!ok) continue;
        let same = true; for (let i = 0; i < 77; i++) if (AP_KNOWN[i] && plain[i] !== h.bits[i]) { same = false; break; }
        if (!same) continue;
        // the slot's own (unpinned) bits against the codeword
        let bad = 0, tot = 0;
        for (let i = 0; i < N; i++) { tot += Math.abs(raw[i]); if ((raw[i] > 0 ? 1 : 0) !== plain[i]) bad += Math.abs(raw[i]); }
        const dist = tot > 0 ? bad / tot : 1;
        if (dist > AP_MAX_DIST) { apLast.hook?.('', dist); continue; }
        r = this.finish(plain, true, h.hz + bdf, bt / BB_RATE, true);
        if (r) apLast.hook?.(r.text, dist);
      }
      if (!r || texts.has(r.text)) continue;
      texts.add(r.text);
      for (const call of this.pending) this.save(call);
      found.push(r);
      if (ft8Options.subtract) this.subtract(r);
    }
  }

  /** For a frequency shift, the baseband over the a-priori search span, and every 32-sample window's power on each tone (a sliding DFT). */
  private apEnergies(hz: number): void {
    const w = -2 * Math.PI * hz / BB_RATE, wr = Math.cos(w), wi = Math.sin(w), from = AP_T_LO;
    let cr = Math.cos(w * from), ci = Math.sin(w * from);
    const re = this.bbRe, im = this.bbIm, zr = this.apRe, zi = this.apIm;
    for (let i = 0; i < AP_SPAN; i++) {
      const n = from + i;
      if (n >= 0 && n < NBB) { zr[i] = re[n] * cr - im[n] * ci; zi[i] = re[n] * ci + im[n] * cr; } else { zr[i] = 0; zi[i] = 0; }
      const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
    }
    const L = AP_SPAN - BB_SPS, pw = this.apPw, c = this.cosT, s = this.sinT;
    for (let k = 0; k < 8; k++) {
      const o = k * BB_SPS;
      let a = 0, b = 0;
      for (let n = 0; n < BB_SPS; n++) { a += zr[n] * c[o + n] + zi[n] * s[o + n]; b += zi[n] * c[o + n] - zr[n] * s[o + n]; }
      const er = c[o + 1], ei = s[o + 1];
      for (let n = 0; n < L; n++) {
        pw[k * AP_SPAN + n] = a * a + b * b;
        // slide one sample: drop z[n], add z[n + 32], turn by e^(j 2 pi k / 32)
        const ar = a - zr[n] + zr[n + BB_SPS], ai = b - zi[n] + zi[n + BB_SPS];
        a = ar * er - ai * ei; b = ar * ei + ai * er;
      }
    }
  }
  /** Energy on the tones the known bits fix (AP_SYMS), symbol 0 at baseband sample t. */
  private apAt(t: number, tones: Uint8Array): number {
    const pw = this.apPw, o = t - AP_T_LO; let e = 0;
    for (const s of AP_SYMS) e += pw[tones[s] * AP_SPAN + o + s * BB_SPS];
    return e;
  }
  private readonly apRe = new Float64Array(AP_SPAN); private readonly apIm = new Float64Array(AP_SPAN);
  private readonly apPw = new Float64Array(8 * AP_SPAN);
  private readonly history: { text: string; tones: Uint8Array; bits: Uint8Array; hz: number; slot: number }[] = [];

  /** 174 bit likelihoods from the 79 x 8 tone powers (noncoherent, one symbol at a time). */
  private softBits(P: Float64Array, llr: Float64Array): void {
    // noise per bin: the median of the bins that are not each symbol's strongest, as a mean (median = ln 2 x mean);
    // signal: the strongest bins' mean less that
    const rest: number[] = []; let top = 0;
    for (let k = 0; k < ND; k++) {
      const s = k + (k < 29 ? 7 : 14);
      let mx = 0, mi = 0; for (let j = 0; j < 8; j++) if (P[s * 8 + j] > mx) { mx = P[s * 8 + j]; mi = j; }
      top += mx;
      for (let j = 0; j < 8; j++) if (j !== mi) rest.push(P[s * 8 + j]);
    }
    rest.sort((a, b) => a - b);
    const n0 = Math.max(1e-30, rest[rest.length >> 1] / Math.LN2);
    const es = Math.max(n0 * 0.05, top / ND - n0);
    // each tone's log likelihood log I0(2 sqrt(Es P) / N0), summed over the tones of each bit value
    const l = new Float64Array(8);
    for (let k = 0; k < ND; k++) {
      const s = k + (k < 29 ? 7 : 14), bi = 3 * k;
      for (let j = 0; j < 8; j++) l[j] = logI0(2 * Math.sqrt(es * P[s * 8 + FT8_GRAY[j]]) / n0);
      llr[bi] = lse4(l[4], l[5], l[6], l[7]) - lse4(l[0], l[1], l[2], l[3]);
      llr[bi + 1] = lse4(l[2], l[3], l[6], l[7]) - lse4(l[0], l[1], l[4], l[5]);
      llr[bi + 2] = lse4(l[1], l[3], l[5], l[7]) - lse4(l[0], l[2], l[4], l[6]);
    }
    normalize(llr);
  }

  /**
   * Bit likelihoods from three symbols at a time, added coherently (the tones keep their phase from symbol to
   * symbol): each data symbol's tone scored by the best sum with its neighbors' tones (known where they are sync).
   */
  private coherentBits(llr: Float64Array): void {
    const xr = this.cxr, xi = this.cxi, l = new Float64Array(8);
    const known = (s: number): number => s < 7 ? FT8_COSTAS[s] : s >= 36 && s < 43 ? FT8_COSTAS[s - 36] : s >= 72 ? FT8_COSTAS[s - 72] : -1;
    for (let k = 0; k < ND; k++) {
      const s = k + (k < 29 ? 7 : 14), bi = 3 * k;
      const ka = known(s - 1), kb = known(s + 1);
      for (let g = 0; g < 8; g++) {
        const j = FT8_GRAY[g], cr = xr[s * 8 + j], ci = xi[s * 8 + j];
        let best = 0;
        for (let a = ka < 0 ? 0 : ka; a < (ka < 0 ? 8 : ka + 1); a++) {
          const ar = cr + xr[(s - 1) * 8 + a], ai = ci + xi[(s - 1) * 8 + a];
          for (let b = kb < 0 ? 0 : kb; b < (kb < 0 ? 8 : kb + 1); b++) {
            const r = ar + xr[(s + 1) * 8 + b], i = ai + xi[(s + 1) * 8 + b], v = r * r + i * i;
            if (v > best) best = v;
          }
        }
        l[g] = Math.sqrt(best);
      }
      llr[bi] = max4(l[4], l[5], l[6], l[7]) - max4(l[0], l[1], l[2], l[3]);
      llr[bi + 1] = max4(l[2], l[3], l[6], l[7]) - max4(l[0], l[1], l[4], l[5]);
      llr[bi + 2] = max4(l[1], l[3], l[5], l[7]) - max4(l[0], l[2], l[4], l[6]);
    }
    normalize(llr);
  }

  /** The decoded signal's unit waveform (GFSK, BT 2) at 12.8 kHz from sample n0, into subRe/subIm; then the running sums of x * conj(it). */
  private reference(n0: number, hz: number, tones: Uint8Array): void {
    const x = this.x, len = 79 * BLOCK, zr = this.subRe, zi = this.subIm, pulse = this.pulse;
    const w0 = 2 * Math.PI * hz / FS, c0 = Math.cos(w0), s0 = Math.sin(w0), dk = 2 * Math.PI * TONE_HZ / FS;
    let cr = 1, ci = 0;
    for (let i = 0; i < len; i++) {
      zr[i] = cr; zi[i] = ci;
      const s = Math.floor(i / BLOCK), q = i - s * BLOCK;
      const g = tones[s > 0 ? s - 1 : 0] * pulse[q + 2 * BLOCK] + tones[s] * pulse[q + BLOCK] + tones[s < 78 ? s + 1 : 78] * pulse[q];
      // the step's rotation: the carrier's, times the small tone offset's from its series
      const d = dk * g, d2 = d * d;
      const ce = 1 - d2 / 2 + d2 * d2 / 24 - d2 * d2 * d2 / 720, se = d * (1 - d2 / 6 + d2 * d2 / 120);
      const ar = c0 * ce - s0 * se, ai = s0 * ce + c0 * se;
      const t = cr * ar - ci * ai; ci = cr * ai + ci * ar; cr = t;
      if (q === BLOCK - 1) { const m = 1 / Math.sqrt(cr * cr + ci * ci); cr *= m; ci *= m; }
    }
    const cRe = this.cumRe, cIm = this.cumIm;
    cRe[0] = 0; cIm[0] = 0;
    for (let i = 0; i < len; i++) {
      const j = n0 + i, v = j >= 0 && j < x.length ? x[j] : 0;
      cRe[i + 1] = cRe[i] + v * zr[i]; cIm[i + 1] = cIm[i] - v * zi[i];
    }
  }

  /**
   * Take a decoded signal out of the audio. Its start and frequency are first refined from the phase steps between
   * symbols (a late start turns the phase at each tone change in proportion to the change, a frequency error turns
   * it the same at every symbol), then its amplitude and phase are followed along the slot and the rebuilt signal
   * subtracted.
   */
  private subtract(r: Found): void {
    const x = this.x, len = 79 * BLOCK, zr = this.subRe, zi = this.subIm, tones = r.tones, cRe = this.cumRe, cIm = this.cumIm;
    let t = r.t, hz = r.hz;
    for (let it = 0; it < 2; it++) {
      const n0 = Math.round(t * FS);
      this.reference(n0, hz, tones);
      let sw = 0, swu = 0, swu2 = 0, swy = 0, swuy = 0;
      let pr = 0, pi = 0, pOk = false;
      for (let s = 0; s < 79; s++) {
        const a = s * BLOCK + (BLOCK >> 2), b = s * BLOCK + 3 * (BLOCK >> 2);
        const ok = n0 + a >= 0 && n0 + b <= x.length;
        const qr = cRe[b] - cRe[a], qi = cIm[b] - cIm[a];
        if (ok && pOk) {
          const vr = qr * pr + qi * pi, vi = qi * pr - qr * pi, w = Math.sqrt(vr * vr + vi * vi);
          if (w > 0) { const y = Math.atan2(vi, vr), u = tones[s - 1] - tones[s]; sw += w; swu += w * u; swu2 += w * u * u; swy += w * y; swuy += w * u * y; }
        }
        pr = qr; pi = qi; pOk = ok;
      }
      const det = sw * swu2 - swu * swu;
      if (!(det > 0)) break;
      const delta = (swy * swu2 - swu * swuy) / det, kappa = (sw * swuy - swu * swy) / det;
      const tau = kappa / (2 * Math.PI * TONE_HZ), dHz = delta / (2 * Math.PI * SYMBOL);
      if (Math.abs(tau) > 0.004 || Math.abs(dHz) > 0.4) break;
      t += tau; hz += dHz;
    }
    const n0 = Math.round(t * FS);
    this.reference(n0, hz, tones);
    const h = SUB_WIN >> 1, lo = Math.max(0, -n0), hi = Math.min(len, x.length - n0);
    for (let i = lo; i < hi; i++) {
      const a = Math.max(lo, i - h), b = Math.min(hi, i + h + 1), inv = 2 / (b - a);
      const ar = (cRe[b] - cRe[a]) * inv, ai = (cIm[b] - cIm[a]) * inv;
      x[n0 + i] -= ar * zr[i] - ai * zi[i];
    }
  }

  // ---------------------------------------------------------------------------------------- unpacking
  private unpack(p: Uint8Array): string | null {
    const i3 = (p[9] >> 3) & 7, n3 = ((p[8] << 2) & 4) | ((p[9] >> 6) & 3);
    if (i3 === 1 || i3 === 2) return this.unpackStd(p, i3);
    if (i3 === 4) return this.unpackNonStd(p);
    if (i3 === 0 && n3 === 0) return unpackFree(p);
    if (i3 === 0 && n3 === 1) return this.unpackDxp(p);
    if (i3 === 0 && n3 === 5) return unpackTelemetry(p);
    if (i3 === 3) return this.unpackRtty(p);
    return null;
  }
  private unpackStd(p: Uint8Array, i3: number): string | null {
    const n29a = ((p[0] << 21) | (p[1] << 13) | (p[2] << 5) | (p[3] >> 3)) >>> 0;
    const n29b = (((p[3] & 7) << 26) | (p[4] << 18) | (p[5] << 10) | (p[6] << 2) | (p[7] >> 6)) >>> 0;
    const ir = (p[7] & 0x20) >> 5;
    const igrid4 = ((p[7] & 0x1F) << 10) | (p[8] << 2) | (p[9] >> 6);
    const a = this.unpack28(n29a >>> 1, n29a & 1, i3), b = this.unpack28(n29b >>> 1, n29b & 1, i3);
    if (a === null || b === null) return null;
    const extra = unpackGrid(igrid4, ir);
    return `${a} ${b}${extra ? ' ' + extra : ''}`;
  }
  private unpack28(n28: number, ip: number, i3: number): string | null {
    if (n28 < NTOKENS) {
      if (n28 <= 2) return ['DE', 'QRZ', 'CQ'][n28];
      if (n28 <= 1002) return `CQ ${String(n28 - 3).padStart(3, '0')}`;
      if (n28 <= 532443) { let n = n28 - 1003; let s = ''; for (let i = 0; i < 4; i++) { s = charn(n % 27, 'LS') + s; n = Math.floor(n / 27); } return `CQ ${s.trim()}`; }
      return null;
    }
    n28 -= NTOKENS;
    if (n28 < MAX22) return this.lookup(22, n28);
    let n = n28 - MAX22;
    const cs = new Array<string>(6);
    cs[5] = charn(n % 27, 'LS'); n = Math.floor(n / 27);
    cs[4] = charn(n % 27, 'LS'); n = Math.floor(n / 27);
    cs[3] = charn(n % 27, 'LS'); n = Math.floor(n / 27);
    cs[2] = charn(n % 10, 'N'); n = Math.floor(n / 10);
    cs[1] = charn(n % 36, 'AN'); n = Math.floor(n / 36);
    cs[0] = charn(n % 37, 'ANS');
    let call = cs.join('');
    if (call.startsWith('3D0') && call[3] !== ' ') call = '3DA0' + call.slice(3).trim();
    else if (call[0] === 'Q' && /[A-Z]/.test(call[1])) call = '3X' + call.slice(1).trim();
    else call = call.trim();
    if (call.length < 3) return null;
    if (ip) { if (i3 === 1) call += '/R'; else if (i3 === 2) call += '/P'; else return null; }
    this.pending.push(call);
    return call;
  }
  /** DXpedition: "K1ABC RR73; W9XYZ <KH1/KH7Z> -08" (28 + 28 + 10-bit hash + 5-bit report). */
  private unpackDxp(p: Uint8Array): string | null {
    const a = this.unpack28(bitsAt(p, 0, 28), 0, 1), b = this.unpack28(bitsAt(p, 28, 28), 0, 1);
    if (a === null || b === null) return null;
    const r = 2 * bitsAt(p, 66, 5) - 30;
    return `${a} RR73; ${b} ${this.lookup(10, bitsAt(p, 56, 10))} ${r < 0 ? '-' : '+'}${String(Math.abs(r)).padStart(2, '0')}`;
  }
  private unpackNonStd(p: Uint8Array): string | null {
    const n12 = (p[0] << 4) | (p[1] >> 4);
    // 58-bit field as a BigInt
    let n58 = BigInt(p[1] & 0x0F);
    for (const b of [p[2], p[3], p[4], p[5], p[6], p[7]]) n58 = (n58 << 8n) | BigInt(b);
    n58 = (n58 << 6n) | BigInt(p[8] >> 2);
    const iflip = (p[8] >> 1) & 1, nrpt = ((p[8] & 1) << 1) | (p[9] >> 7), icq = (p[9] >> 6) & 1;
    let c11 = ''; for (let i = 0; i < 11; i++) { c11 = charn(Number(n58 % 38n), 'ANSS') + c11; n58 /= 38n; }
    const decoded = c11.trim();
    if (decoded.length >= 3) this.pending.push(decoded);
    const other = this.lookup(12, n12);
    const call1 = iflip ? decoded : other, call2 = iflip ? other : decoded;
    if (icq) return `CQ ${call2}`;
    const extra = ['', 'RRR', 'RR73', '73'][nrpt];
    return `${call1} ${call2}${extra ? ' ' + extra : ''}`;
  }
  private unpackRtty(p: Uint8Array): string | null {
    // 3: TU; W9XYZ K1ABC R 579 MA   1 28 28 1 3 13
    const tu = p[0] >> 7;
    const n28a = (((p[0] & 0x7F) << 21) | (p[1] << 13) | (p[2] << 5) | (p[3] >> 3)) >>> 0;
    const n28b = (((p[3] & 7) << 25) | (p[4] << 17) | (p[5] << 9) | (p[6] << 1) | (p[7] >> 7)) >>> 0;
    const ir = (p[7] >> 6) & 1, irpt = (p[7] >> 3) & 7, nexch = ((p[7] & 7) << 10) | (p[8] << 2) | (p[9] >> 6);
    const a = this.unpack28(n28a, 0, 1), b = this.unpack28(n28b, 0, 1);
    if (a === null || b === null) return null;
    const rst = ['52', '53', '54', '55', '56', '57', '58', '59'][irpt];
    const exch = nexch < 8000 ? String(nexch).padStart(4, '0') : ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'NB', 'NS', 'QC', 'ON', 'MB', 'SK', 'AB', 'BC', 'NWT', 'NF', 'LB', 'NU', 'YT', 'PEI', 'DC', 'DX'][nexch - 8001] ?? '';
    return `${tu ? 'TU; ' : ''}${a} ${b} ${ir ? 'R ' : ''}${rst}9 ${exch}`;
  }
  private save(call: string): void {
    let n58 = 0n;
    for (let i = 0; i < 11; i++) { const c = call[i] ?? ' '; const j = nchar(c, 'ANSS'); if (j < 0) return; n58 = n58 * 38n + BigInt(j); }
    const n22 = Number(((47055833459n * n58) >> 42n) & 0x3FFFFFn);
    this.hashes.set(n22, call);
  }
  private lookup(bits: 22 | 12 | 10, h: number): string {
    for (const [n22, call] of this.hashes) if ((bits === 22 ? n22 : bits === 12 ? n22 >> 10 : n22 >> 12) === h) return `<${call}>`;
    return '<...>';
  }
}

interface Cand { t: number; f: number; score: number; }
interface Found { text: string; snr: number; hz: number; t: number; tones: Uint8Array; ap: boolean; bits: Uint8Array; }
const max2 = (a: number, b: number) => a > b ? a : b;
/** Scale the bit likelihoods to the variance belief propagation was tuned for. */
function normalize(llr: Float64Array): void {
  let sum = 0, sum2 = 0; for (let i = 0; i < N; i++) { sum += llr[i]; sum2 += llr[i] * llr[i]; }
  const variance = (sum2 - sum * sum / N) / N;
  const norm = variance > 0 ? Math.sqrt(LLR_VAR / variance) : 0;
  for (let i = 0; i < N; i++) llr[i] *= norm;
}
const max4 = (a: number, b: number, c: number, d: number) => max2(max2(a, b), max2(c, d));
/** log(e^a + e^b + e^c + e^d) */
function lse4(a: number, b: number, c: number, d: number): number {
  const m = max4(a, b, c, d);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m) + Math.exp(c - m) + Math.exp(d - m));
}
/** log I0(x), x >= 0 (Abramowitz and Stegun 9.8.1 and 9.8.2). */
function logI0(x: number): number {
  if (x < 3.75) {
    const t = (x / 3.75) * (x / 3.75);
    return Math.log(1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813))))));
  }
  const t = 3.75 / x;
  return x - 0.5 * Math.log(x) + Math.log(0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281
    + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377))))))));
}
/** erf, Abramowitz and Stegun 7.1.26. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
/** The GFSK (BT 2) frequency pulse of one symbol, over three symbols (in tones). */
function gfskPulse(): Float64Array {
  const k = Math.PI * Math.sqrt(2 / Math.LN2) * 2, p = new Float64Array(3 * BLOCK);
  for (let i = 0; i < 3 * BLOCK; i++) { const t = (i + 0.5) / BLOCK - 1.5; p[i] = 0.5 * (erf(k * (t + 0.5)) - erf(k * (t - 0.5))); }
  return p;
}

/** Belief-propagation LDPC decode; returns the fewest failed parity checks seen (0 = codeword in `plain`). */
/** A standard message (i3 1 or 2), from its 77 bits. */
function isStd(bits: Uint8Array): boolean { const i3 = (bits[74] << 2) | (bits[75] << 1) | bits[76]; return i3 === 1 || i3 === 2; }
/** The two call fields and i3, as a key. */
function callsKey(bits: Uint8Array): string { let k = ''; for (let i = 0; i < 77; i++) if (AP_KNOWN[i]) k += bits[i]; return k; }
/** The last a-priori test, for the tests. */
export const apLast = { hook: null as null | ((text: string, dist: number) => void) };

function bpDecode(cw: Float64Array, maxIters: number, plain: Uint8Array): number {
  const tov = new Float64Array(N * 3), toc = new Float64Array(M * 7);
  let minErrors = M;
  for (let iter = 0; iter < maxIters; iter++) {
    let sum = 0;
    for (let n = 0; n < N; n++) { plain[n] = cw[n] + tov[n * 3] + tov[n * 3 + 1] + tov[n * 3 + 2] > 0 ? 1 : 0; sum += plain[n]; }
    if (sum === 0) break;
    const errors = ldpcCheck(plain);
    if (errors < minErrors) { minErrors = errors; if (errors === 0) break; }
    for (let m = 0; m < M; m++) {
      const rows = LDPC_NUM_ROWS[m];
      for (let ni = 0; ni < rows; ni++) {
        const n = LDPC_NM[m * 7 + ni] - 1;
        let T = cw[n];
        for (let mi = 0; mi < 3; mi++) if (LDPC_MN[n * 3 + mi] - 1 !== m) T += tov[n * 3 + mi];
        toc[m * 7 + ni] = fastTanh(-T / 2);
      }
    }
    for (let n = 0; n < N; n++) {
      for (let mi = 0; mi < 3; mi++) {
        const m = LDPC_MN[n * 3 + mi] - 1, rows = LDPC_NUM_ROWS[m];
        let T = 1;
        for (let ni = 0; ni < rows; ni++) if (LDPC_NM[m * 7 + ni] - 1 !== n) T *= toc[m * 7 + ni];
        tov[n * 3 + mi] = -2 * fastAtanh(T);
      }
    }
  }
  return minErrors;
}
function ldpcCheck(cw: Uint8Array): number {
  let errors = 0;
  for (let m = 0; m < M; m++) { let x = 0; const rows = LDPC_NUM_ROWS[m]; for (let i = 0; i < rows; i++) x ^= cw[LDPC_NM[m * 7 + i] - 1]; if (x) errors++; }
  return errors;
}
function fastTanh(x: number): number { if (x < -4.97) return -1; if (x > 4.97) return 1; const x2 = x * x; return x * (945 + x2 * (105 + x2)) / (945 + x2 * (420 + x2 * 15)); }
function fastAtanh(x: number): number { const x2 = x * x; return x * (945 + x2 * (-735 + x2 * 64)) / (945 + x2 * (-1050 + x2 * 225)); }

/** Generator rows: for each of the 91 message bits, the 174-bit codeword it adds (6 words of 32 bits). */
const OSD_W = 6;
const GEN_ROWS = (() => {
  const g = new Uint32Array(K * OSD_W);
  for (let j = 0; j < K; j++) {
    g[j * OSD_W + (j >> 5)] |= 1 << (j & 31);
    for (let i = 0; i < M; i++) if ((LDPC_GENERATOR[i * 12 + (j >> 3)] >> (7 - (j & 7))) & 1) { const c = K + i; g[j * OSD_W + (c >> 5)] |= 1 << (c & 31); }
  }
  return g;
})();

/**
 * Ordered-statistics decoding, order 1 and order 2 over the least reliable OSD_ORDER2 of the most reliable basis.
 * Writes the closest codeword to `plain` and returns true only if it passes the distance safeguards.
 */
function osdDecode(llr: Float64Array, plain: Uint8Array, pinned = false): boolean {
  const perm = new Int32Array(N); for (let i = 0; i < N; i++) perm[i] = i;
  const rel = new Float64Array(N); for (let i = 0; i < N; i++) rel[i] = Math.abs(llr[i]);
  const order = Array.from(perm).sort((a, b) => rel[b] - rel[a] || a - b);
  for (let i = 0; i < N; i++) perm[i] = order[i];
  // generator columns in reliability order
  const rows = new Uint32Array(K * OSD_W);
  for (let j = 0; j < K; j++) for (let c = 0; c < N; c++) { const src = perm[c]; if ((GEN_ROWS[j * OSD_W + (src >> 5)] >>> (src & 31)) & 1) rows[j * OSD_W + (c >> 5)] |= 1 << (c & 31); }
  // Gaussian elimination: the first 91 independent columns become the basis
  const pivot = new Int32Array(K); let r = 0;
  for (let c = 0; c < N && r < K; c++) {
    const w = c >> 5, bit = 1 << (c & 31);
    let p = -1; for (let i = r; i < K; i++) if (rows[i * OSD_W + w] & bit) { p = i; break; }
    if (p < 0) continue;
    if (p !== r) for (let q = 0; q < OSD_W; q++) { const t = rows[p * OSD_W + q]; rows[p * OSD_W + q] = rows[r * OSD_W + q]; rows[r * OSD_W + q] = t; }
    for (let i = 0; i < K; i++) if (i !== r && (rows[i * OSD_W + w] & bit)) for (let q = 0; q < OSD_W; q++) rows[i * OSD_W + q] ^= rows[r * OSD_W + q];
    pivot[r++] = c;
  }
  if (r < K) return false;
  // hard decisions in reliability order, and the codeword through the basis decisions
  const hd = new Uint32Array(OSD_W), w = new Float64Array(N);
  for (let c = 0; c < N; c++) { w[c] = rel[perm[c]]; if (llr[perm[c]] > 0) hd[c >> 5] |= 1 << (c & 31); }
  const base = new Uint32Array(OSD_W);
  for (let i = 0; i < K; i++) if ((hd[pivot[i] >> 5] >>> (pivot[i] & 31)) & 1) for (let q = 0; q < OSD_W; q++) base[q] ^= rows[i * OSD_W + q];
  const cost = (cw: Uint32Array, limit: number): number => {
    let d = 0;
    for (let q = 0; q < OSD_W; q++) {
      let v = (cw[q] ^ hd[q]) >>> 0;
      while (v) { const b = 31 - Math.clz32(v & -v); d += w[q * 32 + b]; v &= v - 1; }
      if (d >= limit) return d;
    }
    return d;
  };
  const best = base.slice(), cand = new Uint32Array(OSD_W);
  let bestD = cost(base, Infinity);
  for (let i = 0; i < K; i++) {
    for (let q = 0; q < OSD_W; q++) cand[q] = base[q] ^ rows[i * OSD_W + q];
    const d = cost(cand, bestD); if (d < bestD) { bestD = d; best.set(cand); }
  }
  for (let i = K - OSD_ORDER2; i < K; i++) for (let j = i + 1; j < K; j++) {
    for (let q = 0; q < OSD_W; q++) cand[q] = base[q] ^ rows[i * OSD_W + q] ^ rows[j * OSD_W + q];
    const d = cost(cand, bestD); if (d < bestD) { bestD = d; best.set(cand); }
  }
  // safeguards: few disagreements with the hard decisions, and a small share of the total reliability
  let flips = 0, total = 0;
  for (let c = 0; c < N; c++) { total += w[c]; if (((best[c >> 5] ^ hd[c >> 5]) >>> (c & 31)) & 1) flips++; }
  if (!pinned && (flips > OSD_MAX_FLIPS || bestD > OSD_MAX_DIST * total)) return false;
  for (let c = 0; c < N; c++) plain[perm[c]] = (best[c >> 5] >>> (c & 31)) & 1;
  return ldpcCheck(plain) === 0;
}

/** An OSD result is only kept as a standard message whose report or grid field is a real one. */
function plausibleStd(a: Uint8Array): boolean {
  const i3 = (a[9] >> 3) & 7;
  if (i3 !== 1 && i3 !== 2) return false;
  const n29b = (((a[3] & 7) << 26) | (a[4] << 18) | (a[5] << 10) | (a[6] << 2) | (a[7] >> 6)) >>> 0;
  if ((n29b >>> 1) < NTOKENS) return false;                 // the second call is never DE, QRZ or CQ
  const igrid4 = ((a[7] & 0x1F) << 10) | (a[8] << 2) | (a[9] >> 6);
  if (igrid4 <= MAXGRID4) return true;
  const irpt = igrid4 - MAXGRID4;
  return irpt <= 4 || (irpt - 35 >= -50 && irpt - 35 <= 49);
}

/** `len` bits (at most 31) of the payload from bit `start`, first bit most significant. */
function bitsAt(p: Uint8Array, start: number, len: number): number {
  let v = 0; for (let i = start; i < start + len; i++) v = v * 2 + ((p[i >> 3] >> (7 - (i & 7))) & 1);
  return v;
}
function crc14(msg: Uint8Array, numBits: number): number {
  let rem = 0, idx = 0;
  for (let b = 0; b < numBits; b++) {
    if (b % 8 === 0) { rem ^= msg[idx++] << 6; }
    rem = rem & 0x2000 ? ((rem << 1) ^ CRC_POLY) : (rem << 1);
  }
  return rem & 0x3FFF;
}

type Table = 'FULL' | 'ANS' | 'AN' | 'LS' | 'N' | 'ANSS';
function charn(c: number, table: Table): string {
  if (table !== 'AN' && table !== 'N') { if (c === 0) return ' '; c -= 1; }
  if (table !== 'LS') { if (c < 10) return String.fromCharCode(48 + c); c -= 10; }
  if (table !== 'N') { if (c < 26) return String.fromCharCode(65 + c); c -= 26; }
  if (table === 'FULL' && c < 5) return '+-./?'[c];
  if (table === 'ANSS' && c === 0) return '/';
  return '_';
}
function nchar(ch: string, table: Table): number {
  let n = 0;
  if (table !== 'AN' && table !== 'N') { if (ch === ' ') return 0; n += 1; }
  if (table !== 'LS') { if (ch >= '0' && ch <= '9') return n + (ch.charCodeAt(0) - 48); n += 10; }
  if (table !== 'N') { if (ch >= 'A' && ch <= 'Z') return n + (ch.charCodeAt(0) - 65); n += 26; }
  if (table === 'FULL') { const i = '+-./?'.indexOf(ch); return i >= 0 ? n + i : -1; }
  if (table === 'ANSS' && ch === '/') return n;
  return -1;
}
function unpackGrid(igrid4: number, ir: number): string {
  if (igrid4 <= MAXGRID4) {
    let n = igrid4; const d = new Array<string>(4);
    d[3] = String(n % 10); n = Math.floor(n / 10); d[2] = String(n % 10); n = Math.floor(n / 10);
    d[1] = String.fromCharCode(65 + n % 18); n = Math.floor(n / 18); d[0] = String.fromCharCode(65 + n % 18);
    return (ir ? 'R ' : '') + d.join('');
  }
  const irpt = igrid4 - MAXGRID4;
  if (irpt === 1) return ''; if (irpt === 2) return 'RRR'; if (irpt === 3) return 'RR73'; if (irpt === 4) return '73';
  const v = irpt - 35;
  return `${ir ? 'R' : ''}${v < 0 ? '-' : '+'}${String(Math.abs(v)).padStart(2, '0')}`;
}
function telemetry71(p: Uint8Array): Uint8Array { const b = new Uint8Array(9); let carry = 0; for (let i = 0; i < 9; i++) { b[i] = ((carry << 7) | (p[i] >> 1)) & 0xFF; carry = p[i] & 1; } return b; }
function unpackFree(p: Uint8Array): string {
  const b71 = telemetry71(p); const c = new Array<string>(13);
  for (let idx = 12; idx >= 0; idx--) { let rem = 0; for (let i = 0; i < 9; i++) { rem = (rem << 8) | b71[i]; b71[i] = Math.floor(rem / 42); rem %= 42; } c[idx] = charn(rem, 'FULL'); }
  return c.join('').trim();
}
function unpackTelemetry(p: Uint8Array): string { return [...telemetry71(p)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(); }

/** In-place radix-2 FFT (local copy so the decoder has no dependency on the worker's helpers). */
/** In-place radix-2 complex FFT of one size, with its tables (forward e^-j, inverse e^+j, no scaling). */
class Fft {
  private readonly cos: Float64Array; private readonly sin: Float64Array; private readonly rev: Int32Array;
  constructor(readonly n: number) {
    this.cos = new Float64Array(n >> 1); this.sin = new Float64Array(n >> 1); this.rev = new Int32Array(n);
    for (let i = 0; i < n >> 1; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
  }
  run(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.n, rev = this.rev, ct = this.cos, st = this.sin, sg = inverse ? 1 : -1;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) for (let k = 0; k < half; k++) {
        const wr = ct[k * step], wi = sg * st[k * step], a = i + k, b = a + half;
        const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Polyphase windowed-sinc resampler for rational ratios (48 k → 12.8 k is 15:4, four phases). */
class SincResampler {
  private readonly phases: Float32Array[] = [];
  private readonly hist: Float32Array;
  private hpos = 0;
  private acc = 0;               // input samples consumed modulo the step
  private readonly step: number;  // input samples per output sample
  private readonly half: number;
  constructor(inRate: number, outRate: number, taps: number) {
    this.step = inRate / outRate; this.half = taps / 2;
    // phases: fractional positions that repeat; find the smallest cycle (denominator of step)
    let den = 1; while (den < 64 && Math.abs(this.step * den - Math.round(this.step * den)) > 1e-9) den++;
    const cutoff = 0.45 * outRate / inRate;   // as a fraction of the input rate
    for (let ph = 0; ph < den; ph++) {
      const frac = (ph * this.step) % 1, k = new Float32Array(taps); let sum = 0;
      for (let t = 0; t < taps; t++) { const x = t - this.half + 1 - frac; const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x); const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * t / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * t / (taps - 1)); k[t] = sinc * w; sum += k[t]; }
      for (let t = 0; t < taps; t++) k[t] /= sum;
      this.phases.push(k);
    }
    this.hist = new Float32Array(taps);
  }
  reset(): void { this.hist.fill(0); this.hpos = 0; this.acc = 0; }
  process(inp: Float32Array, n: number, out: (v: number) => void): void {
    const taps = this.hist.length;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      this.hist[this.hpos] = inp[i]; this.hpos = (this.hpos + 1) % taps;
      if (++this.acc >= this.step) {
        this.acc -= this.step;
        const k = this.phases[phase]; phase = (phase + 1) % this.phases.length;
        let y = 0, idx = this.hpos;   // oldest sample first
        for (let t = 0; t < taps; t++) { y += k[t] * this.hist[idx]; if (++idx >= taps) idx = 0; }
        out(y);
      }
    }
  }
}
