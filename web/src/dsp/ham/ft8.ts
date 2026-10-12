/**
 * FT8 decoder (a TypeScript port of the approach in ft8_lib by Kārlis Goba, MIT): 12 kHz audio is chopped into
 * 15 s UTC slots; a 3840-point Hann FFT every half symbol (0.08 s) with half-tone (3.125 Hz) resolution builds the
 * log-power waterfall; the three 7-symbol Costas arrays are searched across time and frequency for sync
 * candidates; each candidate's 58 data symbols yield 174 soft bits (Gray-mapped 8-FSK), the LDPC(174,91) code is
 * decoded by belief propagation, the CRC-14 is checked, and the 77-bit payload is unpacked (standard, non-standard,
 * free text and telemetry types) with a callsign hash table for the <...> references.
 */
import { FT8_COSTAS, FT8_GRAY, LDPC_MN, LDPC_NM, LDPC_NUM_ROWS } from './ft8-tables.js';
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

export interface Ft8Decode { utc: string; snr: number; dt: number; hz: number; text: string; }

export class Ft8Decoder implements DigitalDecoder {
  readonly name = 'FT8';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Ft8Decode[], slot: number) => void = () => {};
  /** Ring of 12 kHz samples covering a little more than one slot. */
  private readonly ring = new Float32Array(FS * 17);
  private wpos = 0; private total = 0;
  private readonly rs = new SincResampler(48_000, FS, 32);
  private t0 = 0;                 // wall-clock ms of sample index 0 (running estimate)
  private lastSlot = -1;
  private readonly mag = new Float32Array(NUM_BLOCKS * BLOCK_STRIDE);
  private readonly win = new Float32Array(NFFT);
  private readonly re = new Float32Array(NFFT); private readonly im = new Float32Array(NFFT);
  private readonly hashes = new Map<number, string>();
  private slotBusy = false;
  constructor() { for (let i = 0; i < NFFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT); }
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

  /** Decode one 15 s slot of 12 kHz audio (also used by the self-test with synthetic signals). */
  decodeBuffer(buf: Float32Array, slotStartMs = 0): Ft8Decode[] {
    if (buf !== this.slotBuf) this.slotBuf.set(buf.subarray(0, this.slotBuf.length));
    this.buildWaterfall();
    const cands = this.findCandidates(120, 5);
    const results: Ft8Decode[] = [];
    const seen = new Set<number>();
    const d = new Date(slotStartMs), utc = `${d.getUTCHours().toString().padStart(2, '0')}${d.getUTCMinutes().toString().padStart(2, '0')}${d.getUTCSeconds().toString().padStart(2, '0')}`;
    for (const c of cands) {
      const r = this.decodeCandidate(c);
      if (!r) continue;
      if (seen.has(r.hash)) continue; seen.add(r.hash);
      const hz = (BIN_MIN + c.freqOffset + c.freqSub / FREQ_OSR) * TONE_HZ;
      const dt = (c.timeOffset + c.timeSub / TIME_OSR) * SYMBOL - 0.5;
      results.push({ utc, snr: r.snr, dt: Math.round(dt * 10) / 10, hz: Math.round(hz), text: r.text });
    }
    results.sort((a, b) => b.snr - a.snr);
    return results;
  }

  private buildWaterfall(): void {
    const mag = this.mag, re = this.re, im = this.im, win = this.win, buf = this.slotBuf, L = buf.length;
    for (let blk = 0; blk < NUM_BLOCKS; blk++) {
      for (let ts = 0; ts < TIME_OSR; ts++) {
        const off = blk * BLOCK + ts * SUBBLOCK;
        for (let i = 0; i < NFFT; i++) { const s = off + i; re[i] = s < L ? buf[s] * win[i] : 0; im[i] = 0; }
        fft(re, im);
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

  private candMag(c: Cand): number { return ((c.timeOffset * TIME_OSR + c.timeSub) * FREQ_OSR + c.freqSub) * NUM_BINS + c.freqOffset; }

  private syncScore(c: Cand): number {
    const mag = this.mag, base = this.candMag(c);
    let score = 0, num = 0;
    for (let m = 0; m < 3; m++) for (let k = 0; k < 7; k++) {
      const block = 36 * m + k, blockAbs = c.timeOffset + block;
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

  private findCandidates(max: number, minScore: number): Cand[] {
    const heap: Cand[] = [];
    for (let ts = 0; ts < TIME_OSR; ts++) for (let fs = 0; fs < FREQ_OSR; fs++) for (let to = -10; to < 20; to++) for (let fo = 0; fo + 7 < NUM_BINS; fo++) {
      const c: Cand = { timeSub: ts, freqSub: fs, timeOffset: to, freqOffset: fo, score: 0 };
      c.score = this.syncScore(c);
      if (c.score < minScore) continue;
      if (heap.length < max) { heap.push(c); if (heap.length === max) heap.sort((a, b) => a.score - b.score); }
      else if (c.score > heap[0].score) { heap[0] = c; let i = 0; while (i + 1 < heap.length && heap[i + 1].score < heap[i].score) { const t = heap[i]; heap[i] = heap[i + 1]; heap[i + 1] = t; i++; } }
    }
    return heap.sort((a, b) => b.score - a.score);
  }

  private decodeCandidate(c: Cand): { text: string; hash: number; snr: number } | null {
    const log174 = new Float32Array(N), mag = this.mag, base = this.candMag(c);
    const s2 = new Float32Array(8);
    for (let k = 0; k < ND; k++) {
      const sym = k + (k < 29 ? 7 : 14), block = c.timeOffset + sym, bi = 3 * k;
      if (block < 0 || block >= NUM_BLOCKS) { log174[bi] = log174[bi + 1] = log174[bi + 2] = 0; continue; }
      const p = base + sym * BLOCK_STRIDE;
      for (let j = 0; j < 8; j++) s2[j] = mag[p + FT8_GRAY[j]];
      log174[bi] = max4(s2[4], s2[5], s2[6], s2[7]) - max4(s2[0], s2[1], s2[2], s2[3]);
      log174[bi + 1] = max4(s2[2], s2[3], s2[6], s2[7]) - max4(s2[0], s2[1], s2[4], s2[5]);
      log174[bi + 2] = max4(s2[1], s2[3], s2[5], s2[7]) - max4(s2[0], s2[2], s2[4], s2[6]);
    }
    // normalize to the experimentally found scale
    let sum = 0, sum2 = 0; for (let i = 0; i < N; i++) { sum += log174[i]; sum2 += log174[i] * log174[i]; }
    const variance = (sum2 - sum * sum / N) / N; if (variance <= 0) return null;
    const norm = Math.sqrt(24 / variance); for (let i = 0; i < N; i++) log174[i] *= norm;
    const plain = new Uint8Array(N);
    const errors = bpDecode(log174, 20, plain);
    if (errors > 0) return null;
    // pack the 91 payload+CRC bits, check the CRC over 82 bits (77 payload + 5 zeros)
    const a91 = new Uint8Array(12);
    for (let i = 0; i < K; i++) if (plain[i]) a91[i >> 3] |= 0x80 >> (i & 7);
    const crcExtracted = ((a91[9] & 0x07) << 11) | (a91[10] << 3) | (a91[11] >> 5);
    a91[9] &= 0xF8; a91[10] = 0;
    if (crc14(a91, 82) !== crcExtracted) return null;
    const text = this.unpack(a91.subarray(0, 10));
    if (text === null) return null;
    // SNR: Costas tone level over the slot's median, referenced to 2.5 kHz
    let sig = 0, cnt = 0;
    for (let m = 0; m < 3; m++) for (let k = 0; k < 7; k++) { const block = 36 * m + k; if (c.timeOffset + block < 0 || c.timeOffset + block >= NUM_BLOCKS) continue; sig += mag[base + block * BLOCK_STRIDE + FT8_COSTAS[k]]; cnt++; }
    const noise = this.medianMag();
    const snr = Math.max(-26, Math.min(40, Math.round(sig / Math.max(1, cnt) - noise - 26)));
    return { text, hash: crcExtracted, snr };
  }

  private medianMag(): number {
    // sample every 97th element for a cheap median
    const s: number[] = []; for (let i = 0; i < this.mag.length; i += 97) s.push(this.mag[i]);
    s.sort((a, b) => a - b); return s[s.length >> 1];
  }

  // ---------------------------------------------------------------------------------------- unpacking
  private unpack(p: Uint8Array): string | null {
    const i3 = (p[9] >> 3) & 7, n3 = ((p[8] << 2) & 4) | ((p[9] >> 6) & 3);
    if (i3 === 1 || i3 === 2) return this.unpackStd(p, i3);
    if (i3 === 4) return this.unpackNonStd(p);
    if (i3 === 0 && n3 === 0) return unpackFree(p);
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
    this.save(call);
    return call;
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
    if (decoded.length >= 3) this.save(decoded);
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

interface Cand { timeSub: number; freqSub: number; timeOffset: number; freqOffset: number; score: number; }
const max2 = (a: number, b: number) => a > b ? a : b;
const max4 = (a: number, b: number, c: number, d: number) => max2(max2(a, b), max2(c, d));

/** Belief-propagation LDPC decode; returns the number of failed parity checks (0 = codeword). */
function bpDecode(cw: Float32Array, maxIters: number, plain: Uint8Array): number {
  const tov = new Float32Array(N * 3), toc = new Float32Array(M * 7);
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
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = cr * re[b] - ci * im[b], ti = cr * im[b] + ci * re[b]; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } }
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
