/**
 * Meteor-M N2-3 / N2-4 LRPT (137.9 / 137.1 MHz, 72 kbaud QPSK): a QPSK demodulator on the 240 kHz complex
 * baseband (AGC, root-raised-cosine matched filter, fourth-power frequency acquisition, Costas carrier loop,
 * Gardner symbol timing), frame sync under all eight constellation ambiguities, full-frame Viterbi, descrambling
 * and Reed-Solomon (lrpt-fec.ts), then the CCSDS transfer frames → M-PDU packets → MSU-MR image segments:
 * 14 JPEG-style 8×8 MCUs per packet, 196 per 1568-pixel line, one APID per spectral channel. Strips are handed
 * out as they decode so the picture builds live. Packet / MCU / JPEG layout follows meteor_decode (MIT).
 */
import { Viterbi, syncScore, applyVariant, descramble, rsFix, FRAME_SYMBOLS, CADU_BYTES } from './lrpt-fec.js';
import { fftInPlace } from './filters.js';

const IN_RATE = 240_000, SYM_RATE = 72_000, SPS = IN_RATE / SYM_RATE;
export interface LrptStrip { apid: number; line: number; x: number; pixels: Uint8Array }
export interface LrptStats { lock: boolean; freqHz: number; ber: number; rs: number; frames: number; badFrames: number; level: number; timing: number; apids: Record<number, number>; variant: number }

/** Root-raised-cosine taps, unity DC gain. */
function rrcTaps(alpha: number, sps: number, span: number): Float32Array {
  const n = Math.round(span * sps) | 1, h = new Float32Array(n), m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - m) / sps;
    let v: number;
    if (t === 0) v = 1 - alpha + 4 * alpha / Math.PI;
    else if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-6) v = (alpha / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)));
    else v = (Math.sin(Math.PI * t * (1 - alpha)) + 4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha))) / (Math.PI * t * (1 - 16 * alpha * alpha * t * t));
    h[i] = v; sum += v;
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

// ------------------------------------------------------------------------------------------- JPEG pieces
const DC_PREFIX = [2, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9];
const AC_SIZE = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125];
const AC_TABLE = Uint8Array.from([1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240, 36, 51, 98, 114, 130,
  9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 131,
  132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211,
  212, 213, 214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250]);
const QUANT = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16);

function readBits(src: Uint8Array, off: number, bitOff: number, count: number): number {
  if (count <= 0) return 0;
  let p = off + (bitOff >> 3), b = bitOff & 7;
  let ret = (src[p++] ?? 0) & ((1 << (8 - b)) - 1);
  let left = count - (8 - b);
  while (left > 0) { ret = ret * 256 + (src[p++] ?? 0); left -= 8; }
  return Math.floor(ret / Math.pow(2, -left));
}
function dcCategory(code16: number): number {
  if (code16 >> 14 === 0) return 0;
  if (code16 >> 13 < 7) return (code16 >> 13) - 1;
  if (code16 >> 12 < 0xf) return 6;
  if (code16 >> 11 < 0x1f) return 7;
  if (code16 >> 10 < 0x3f) return 8;
  if (code16 >> 9 < 0x7f) return 9;
  if (code16 >> 8 < 0xff) return 10;
  if (code16 >> 7 < 0x1ff) return 11;
  return -1;
}
/** Huffman-decode `count` 8×8 blocks (zig-zag order) from `src` starting at byte `off`; returns false on a bad stream. */
export function huffmanDecode(dst: Int16Array, src: Uint8Array, off: number, count: number, maxLen: number): boolean {
  let bit = 0, dc = 0;
  const end = off + maxLen;
  for (let i = 0; i < count; i++) {
    const blk = i * 64;
    dst.fill(0, blk, blk + 64);
    const dcInfo = readBits(src, off, bit, 32);
    const cat = dcCategory(dcInfo >>> 16);
    if (cat < 0) return false;
    const pre = DC_PREFIX[cat];
    const sign = (dcInfo >>> (31 - pre)) & 1;
    const extra = cat > 1 ? (dcInfo >>> (31 - pre - cat + 1)) & ((1 << (cat - 1)) - 1) : 0;
    if (cat) dc += extra + (sign ? 1 << (cat - 1) : 1 - (1 << cat));
    dst[blk] = dc;
    bit += pre + cat;
    if (off + (bit >> 3) >= end) break;
    for (let r = 1; r < 64; r++) {
      const buf = readBits(src, off, bit, 32);
      let first = 0, idx = 0, j = 2, info = 0;
      for (; j < AC_SIZE.length; j++) {
        info = buf >>> (32 - j);
        if (info - first < AC_SIZE[j]) { info = AC_TABLE[idx + info - first]; break; }
        first = (first + AC_SIZE[j]) << 1; idx += AC_SIZE[j];
      }
      if (j >= AC_SIZE.length) return false;
      bit += j;
      if (info === 0) break;                           // end of block
      const run = (info >> 4) & 15, acat = info & 15;
      const asign = readBits(src, off, bit, 1), aextra = acat > 1 ? readBits(src, off, bit + 1, acat - 1) : 0;
      const coef = acat > 0 ? aextra + (asign ? 1 << (acat - 1) : 1 - (1 << acat)) : 0;
      for (let k = 0; k < run && r < 63; k++, r++) dst[blk + r] = 0;
      dst[blk + r] = coef;
      bit += acat;
      if (off + (bit >> 3) >= end) return true;
    }
    if (off + (bit >> 3) >= end) break;
  }
  return true;
}
/** De-zigzag, dequantize (JPEG quality q) and inverse-DCT one block into 64 gray pixels. */
export function idctBlock(src: Int16Array, at: number, q: number, out: Uint8Array, outAt: number, tmp: Float32Array): void {
  const compr = q < 50 ? 5000 / Math.max(1, q) : 200 - 2 * q;
  const F = tmp;                                     // 64 dequantized coefficients in natural order
  for (let k = 0; k < 64; k++) { const nat = ZIGZAG[k]; const qv = Math.max(1, Math.floor((QUANT[nat] * compr / 50 + 1) / 2)); F[nat] = src[at + k] * qv; }
  // separable IDCT: rows then columns
  const row = new Float32Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { let s = 0; for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * F[y * 8 + u]; row[y * 8 + x] = s / 2; }
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { let s = 0; for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * row[v * 8 + x]; const px = Math.round(s / 2 + 128); out[outAt + y * 8 + x] = px < 0 ? 0 : px > 255 ? 255 : px; }
}

// ------------------------------------------------------------------------------------------- packets
const MCU_PER_MPDU = 14, MPDU_PER_LINE = 14, MPDU_PER_PERIOD = 43, VCDU_DATA = 882, MPDU_HDR = 6, MPDU_MAX = 6 + 8 + 2048;

export class LrptDecoder {
  onStrip: (s: LrptStrip) => void = () => {};
  onStats: (s: LrptStats) => void = () => {};
  onLog: (line: string) => void = () => {};
  // ---- demodulator
  private readonly rrc = rrcTaps(0.6, SPS, 8);
  private readonly histI: Float32Array; private readonly histQ: Float32Array; private hpos = 0;
  private agc = 1;
  private theta = 0; private omega = 0;             // carrier phase / frequency (rad per sample)
  private nextSym = SPS; private period = SPS;      // symbol clock
  private prevSymI = 0; private prevSymQ = 0;
  private fI = new Float32Array(4); private fQ = new Float32Array(4); private fn = 0;   // last filtered samples (for interpolation)
  private n = 0;
  private symRms = 0.5;
  private readonly acqRe = new Float32Array(4096); private readonly acqIm = new Float32Array(4096); private acqN = 0; private lastAcq = 0;
  // ---- symbols / frames
  private readonly soft = new Int8Array(FRAME_SYMBOLS * 2 * 3); private nsym = 0;   // ring of soft I/Q
  private locked = false; private frameStart = 0; private variant = 0; private miss = 0;
  private readonly viterbi = new Viterbi(FRAME_SYMBOLS);
  private readonly frameSoft = new Int8Array(FRAME_SYMBOLS * 2);
  private readonly cadu = new Uint8Array(CADU_BYTES);
  private ber = 0; private rs = 0; private frames = 0; private badFrames = 0;
  // ---- packets
  private mpdu = new Uint8Array(MPDU_MAX); private mstate = 0; private moff = 0; private mfrag = 0;
  // every image packet of a scan line shares one 43-packet period of the (global) sequence counter: line = period index
  private lineBase = -1; private seqHi = 0; private lastSeq = -1;
  private readonly coef = new Int16Array(64 * MCU_PER_MPDU); private readonly strip = new Uint8Array(64 * MCU_PER_MPDU); private readonly tmp64 = new Float32Array(64);
  private lastStats = 0; private readonly apidCount: Record<number, number> = {};

  constructor() { this.histI = new Float32Array(this.rrc.length); this.histQ = new Float32Array(this.rrc.length); }
  reset(): void {
    this.hpos = 0; this.histI.fill(0); this.histQ.fill(0); this.agc = 1; this.theta = 0; this.omega = 0; this.nextSym = SPS; this.period = SPS; this.n = 0; this.nsym = 0;
    this.locked = false; this.miss = 0; this.frames = 0; this.badFrames = 0; this.ber = 0; this.rs = 0; this.mstate = 0; this.lineBase = -1; this.seqHi = 0; this.lastSeq = -1; this.acqN = 0;
    for (const k of Object.keys(this.apidCount)) delete this.apidCount[Number(k)];
  }
  stats(): LrptStats {
    return { lock: this.locked, freqHz: this.omega * IN_RATE / (2 * Math.PI), ber: this.ber, rs: this.rs, frames: this.frames, badFrames: this.badFrames, level: this.symRms, timing: this.period, apids: { ...this.apidCount }, variant: this.variant };
  }

  /** Complex baseband at 240 kHz (interleaved I, Q), the LRPT carrier near DC. */
  onIq240(buf: Float32Array, n: number): void {
    const h = this.rrc, taps = h.length, hI = this.histI, hQ = this.histQ;
    for (let k = 0; k < n; k++) {
      // AGC to unit-ish amplitude
      const i0 = buf[2 * k] * this.agc, q0 = buf[2 * k + 1] * this.agc;
      const mag = Math.sqrt(i0 * i0 + q0 * q0);
      this.agc += 0.002 * this.agc * (1 - mag);
      if (this.agc > 1e6) this.agc = 1e6;
      // matched filter
      hI[this.hpos] = i0; hQ[this.hpos] = q0;
      let fi = 0, fq = 0, p = this.hpos;
      for (let t = 0; t < taps; t++) { fi += h[t] * hI[p]; fq += h[t] * hQ[p]; if (--p < 0) p = taps - 1; }
      if (++this.hpos >= taps) this.hpos = 0;
      // fourth-power acquisition buffer (pre-NCO)
      if (!this.locked && this.acqN < 4096) { this.acqRe[this.acqN] = fi; this.acqIm[this.acqN] = fq; this.acqN++; }
      // carrier NCO
      const c = Math.cos(this.theta), s = Math.sin(this.theta);
      const ri = fi * c + fq * s, rq = fq * c - fi * s;
      this.theta += this.omega; if (this.theta > Math.PI) this.theta -= 2 * Math.PI; else if (this.theta < -Math.PI) this.theta += 2 * Math.PI;
      const idx = this.fn & 3; this.fI[idx] = ri; this.fQ[idx] = rq; this.fn++;
      // symbol clock: decide at nextSym (between the previous and this sample)
      while (this.nextSym <= this.n) {
        const frac = this.n - this.nextSym;                     // 0..1 back from this sample
        const cur = this.interp(frac), mid = this.interp(frac + this.period / 2);
        const [ci, cq] = cur, [mi, mq] = mid;
        // Gardner timing error
        const te = ((ci - this.prevSymI) * mi + (cq - this.prevSymQ) * mq) / Math.max(0.05, this.symRms * this.symRms);
        // proportional term moves the next decision, the tiny integral term trims the symbol period
        this.period -= 0.0004 * te; if (this.period < SPS * 0.995) this.period = SPS * 0.995; else if (this.period > SPS * 1.005) this.period = SPS * 1.005;
        this.nextSym -= 0.04 * te;
        this.prevSymI = ci; this.prevSymQ = cq;
        // Costas (QPSK) phase error from the decision
        const pe = (ci >= 0 ? cq : -cq) - (cq >= 0 ? ci : -ci);
        this.theta += 0.05 * pe; this.omega += 0.0008 * pe;
        if (this.omega > 0.8) this.omega = 0.8; else if (this.omega < -0.8) this.omega = -0.8;
        this.symRms += 0.001 * (Math.sqrt(ci * ci + cq * cq) - this.symRms);
        this.symbol(ci, cq);
        this.nextSym += this.period;
      }
      this.n++;
      if (!this.locked && this.acqN >= 4096 && this.n - this.lastAcq > IN_RATE / 4) { this.acquire(); this.lastAcq = this.n; this.acqN = 0; }
    }
    if (this.n - this.lastStats > IN_RATE) { this.lastStats = this.n; this.onStats(this.stats()); }
  }
  /** Linearly interpolate the filtered, derotated stream `back` samples before the newest one. */
  private interp(back: number): [number, number] {
    const i = Math.floor(back), f = back - i;
    const a = (this.fn - 1 - i) & 3, b = (this.fn - 2 - i) & 3;
    return [this.fI[a] * (1 - f) + this.fI[b] * f, this.fQ[a] * (1 - f) + this.fQ[b] * f];
  }
  /** Coarse carrier estimate: the fourth power of QPSK collapses the modulation, leaving a line at 4 × the offset. */
  private acquire(): void {
    const re = this.acqRe, im = this.acqIm, N = 4096;
    const fr = new Float32Array(N), fi = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const a = re[k], b = im[k];
      const r2 = a * a - b * b, i2 = 2 * a * b;               // z²
      fr[k] = r2 * r2 - i2 * i2; fi[k] = 2 * r2 * i2;          // z⁴
    }
    fftInPlace(fr, fi, false);
    let best = 0, bestP = -1;
    for (let k = 0; k < N; k++) { const p = fr[k] * fr[k] + fi[k] * fi[k]; if (p > bestP) { bestP = p; best = k; } }
    const bin = best > N / 2 ? best - N : best;
    const df = bin * IN_RATE / N / 4;                          // Hz
    if (Math.abs(df) < 30_000) this.omega = 2 * Math.PI * df / IN_RATE;
  }

  private symbol(i: number, q: number): void {
    const g = 100 / Math.max(1e-3, this.symRms);
    const si = Math.max(-127, Math.min(127, Math.round(i * g))), sq = Math.max(-127, Math.min(127, Math.round(q * g)));
    const soft = this.soft, len = soft.length, at = (this.nsym * 2) % len;
    soft[at] = si; soft[at + 1] = sq;
    this.nsym++;
    if (!this.locked) {
      if (this.nsym < 32) return;
      const start = this.nsym - 32;
      const [v, score] = this.syncAt(start);
      if (score >= 0.82) {
        // confirm with the syncword one frame back when we have it
        this.locked = true; this.variant = v; this.frameStart = start; this.miss = 0;
        this.onLog(`LRPT sync · variant ${v} · offset ${(this.omega * IN_RATE / (2 * Math.PI)).toFixed(0)} Hz`);
      }
      return;
    }
    if (this.nsym >= this.frameStart + FRAME_SYMBOLS + 32) this.decodeFrame();
  }
  private syncAt(start: number): [number, number] {
    const soft = this.soft, len = soft.length, at = (start * 2) % len;
    if (at + 64 <= len) return syncScore(soft, at);
    const tmp = new Int8Array(64); for (let k = 0; k < 64; k++) tmp[k] = soft[(at + k) % len];
    return syncScore(tmp, 0);
  }

  private decodeFrame(): void {
    // check the sync at the expected start of the *next* frame: it tells us the variant to use and whether we are still locked
    const next = this.frameStart + FRAME_SYMBOLS;
    const [v, score] = this.syncAt(next);
    if (score >= 0.6) { this.variant = v; this.miss = 0; }
    else if (++this.miss > 3) { this.locked = false; this.onLog('LRPT lost'); return; }
    // gather the frame's soft symbols under the current ambiguity
    const soft = this.soft, len = soft.length, fs = this.frameSoft;
    for (let k = 0; k < FRAME_SYMBOLS; k++) {
      const at = ((this.frameStart + k) * 2) % len;
      const [a, b] = applyVariant(soft[at], soft[at + 1], this.variant, false);
      fs[2 * k] = a; fs[2 * k + 1] = b;
    }
    this.frameStart = next;
    const cadu = this.cadu;
    this.ber = this.viterbi.decode(fs, cadu);
    descramble(cadu);
    this.rs = rsFix(cadu);
    if (this.rs < 0) { this.badFrames++; this.mstate = 0; return; }
    this.frames++;
    this.vcdu(cadu);
  }

  // ---- CCSDS transfer frame → M-PDUs
  private vcdu(c: Uint8Array): void {
    const version = c[4] >> 6, type = c[5] & 0x3f;
    if (!version || !type) return;
    const hdrPtr = (c[12] & 7) << 8 | c[13], hdrPresent = (c[12] >> 3) === 0 && hdrPtr !== 0x7ff;
    const data = c.subarray(14, 14 + VCDU_DATA);
    // port of meteor_decode's mpdu_reconstruct state machine, looping over the packets in this frame
    let guard = 0;
    for (;;) {
      if (++guard > 64) break;
      const jmpIdle = hdrPresent && this.moff === 0;
      if (this.mfrag >= MPDU_MAX) { this.mstate = 0; this.moff = 0; this.mfrag = 0; break; }
      if (this.mstate === 0) {
        if (!hdrPresent) break;
        this.moff = hdrPtr; if (this.moff > VCDU_DATA) break;
        this.mfrag = 0; this.mstate = 1; continue;
      }
      if (this.mstate === 1) {
        const left = MPDU_HDR - this.mfrag;
        if (this.moff + left < VCDU_DATA) { this.mpdu.set(data.subarray(this.moff, this.moff + left), this.mfrag); this.mfrag = 0; this.moff += left; this.mstate = 2; continue; }
        this.mpdu.set(data.subarray(this.moff), this.mfrag); this.mfrag += VCDU_DATA - this.moff; this.moff = 0; break;
      }
      // data
      const plen = ((this.mpdu[4] << 8) | this.mpdu[5]) + 1;
      if (plen > MPDU_MAX - MPDU_HDR) { this.mstate = 0; this.moff = 0; this.mfrag = 0; break; }
      const left = plen - this.mfrag;
      if (this.moff + left < VCDU_DATA) {
        this.mpdu.set(data.subarray(this.moff, this.moff + left), MPDU_HDR + this.mfrag); this.mfrag = 0; this.moff += left; this.mstate = jmpIdle ? 0 : 1;
        this.packet(plen);
        continue;
      }
      this.mpdu.set(data.subarray(this.moff), MPDU_HDR + this.mfrag); this.mfrag += VCDU_DATA - this.moff; this.moff = 0; this.mstate = jmpIdle ? 0 : 2;
      break;
    }
  }

  private packet(plen: number): void {
    const m = this.mpdu;
    const apid = (m[0] & 7) << 8 | m[1], seq = (m[2] & 0x3f) << 8 | m[3];
    if (apid < 64 || apid > 69) return;                        // 70 = telemetry, others unknown
    const seg = MPDU_HDR + 8;                                  // after the 8-byte time stamp
    const mcuSeq = m[seg], q = m[seg + 5];
    if (!q) return;
    const dataAt = seg + 6, maxLen = plen - 8 - 6;
    if (maxLen <= 0) return;
    if (!huffmanDecode(this.coef, m, dataAt, MCU_PER_MPDU, maxLen)) return;
    for (let i = 0; i < MCU_PER_MPDU; i++) idctBlock(this.coef, i * 64, q, this.strip, i * 64, this.tmp64);
    this.apidCount[apid] = (this.apidCount[apid] ?? 0) + 1;
    const line = this.lineOf(apid, seq, Math.floor(mcuSeq / MCU_PER_MPDU));
    if (line < 0) return;
    const px = new Uint8Array(8 * MCU_PER_MPDU * 8), strip = this.strip;
    for (let b = 0; b < MCU_PER_MPDU; b++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 112 + b * 8 + x] = strip[b * 64 + y * 8 + x];
    this.onStrip({ apid, line, x: (mcuSeq - mcuSeq % MCU_PER_MPDU) * 8, pixels: px });
  }
  /**
   * Scan line of a packet from the shared sequence counter: a line period is 43 packets (14 per channel + telemetry),
   * channels in ascending APID order, so the first packet fixes the period phase and every channel lands on the
   * same rows even when another channel's packets were lost.
   */
  private lineOf(apid: number, seq: number, k: number): number {
    if (this.lastSeq >= 0 && seq < this.lastSeq - 8192) this.seqHi += 16384;   // counter wrapped
    else if (this.lastSeq >= 0 && seq > this.lastSeq + 8192) this.seqHi -= 16384;
    this.lastSeq = seq;
    const abs = seq + this.seqHi;
    if (this.lineBase < 0) { const rank = apid === 64 ? 0 : apid === 65 || apid === 67 ? 1 : 2; this.lineBase = abs - k - MPDU_PER_LINE * rank; }
    const d = abs - this.lineBase;
    return d < 0 ? -1 : Math.floor(d / MPDU_PER_PERIOD);
  }
}
