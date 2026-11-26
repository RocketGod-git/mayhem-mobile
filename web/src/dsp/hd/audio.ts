/** One HD program's digital audio, buffered about 2 s; HD1 falls back to analog, the others to silence. */
import { SincResampler } from '../audiorate.js';
import { HdcCore } from './hdc/core.js';
import { HdcSbr } from './hdc/sbr.js';
import type { AudioPdu } from './l2.js';
import { Upmixer } from './surround.js';

const OUT = 48_000, PKT = 2048;
/** The buffer depth that starts (and after a dropout restarts) the digital audio. */
const START = 2 * OUT;
/** Room for the station's diversity delay (digital leads its analog by several seconds) and the start buffer. */
const CAP = 14 * OUT;
const FADE = Math.round(0.06 * OUT);
/** Packets bad or lost in a row (about 1 s) before the program counts as gone and the fallback plays. */
const BAD_RUN = 22;
/** The decoder's full scale against the analog FM's level here. */
const GAIN = 0.75;
/** A frame this loud came from bit errors the CRC missed. */
const WILD = 4;
/** The buffer's low point each window stays between these: a sample in 1000 skipped or repeated until it is back. */
const TROUGH_LO = 0.15 * OUT, TROUGH_HI = CAP - OUT, WINDOW = 4 * OUT;
/** HD1 is lined up with the analog over this much of it, first at 1 kHz, then sample-exact. */
const ALIGN = 2 * OUT, DEC = 48, FINE = OUT / 4, HIST = 3 * OUT;
/** Digital ahead of the match point when HD1 switches: one L1 frame's burst (1.486 s) and some. */
const MARGIN = 1.7 * OUT;
/** Waiting this long for a match starts the digital unaligned. */
const ALIGN_WAIT = 12 * OUT;
/** A true match is near 1; music's own repeats give false ones around 0.5. */
const MATCH = 0.75;

export interface HdAudioStatus {
  program: number; state: 'digital' | 'analog' | 'silent'; filling: boolean; bufferS: number;
  good: number; bad: number; lost: number; underruns: number; msPerPacket: number;
}

const crc8ok = (p: Uint8Array): boolean => {
  let c = 0xFF;
  for (let i = 0; i < p.length - 1; i++) { c ^= p[i]; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 255 : (c << 1) & 255; }
  return c === p[p.length - 1];
};

export class HdAudio {
  program = 0;
  private core = new HdcCore();
  private sbr = new HdcSbr();
  private rsL = new SincResampler(44_100, OUT);
  private rsR = new SincResampler(44_100, OUT);
  /** Packets waiting to be decoded, CRC bytes removed; null for one lost or failed. */
  private queue: (Uint8Array | null)[] = [];
  private front: { seq: number; bytes: Uint8Array | null } | null = null;
  private nextSeq = -1;
  private badRun = BAD_RUN + 1;
  private readonly ringL = new Float32Array(CAP);
  private readonly ringR = new Float32Array(CAP);
  private readonly okRing = new Uint8Array(CAP);
  private r = 0; private w = 0; private n = 0;
  private playing = false;
  private blend = 0;
  private lastL = 0; private lastR = 0;
  private written = 0;
  private readonly aHist = new Float32Array(HIST);
  private aw = 0; private aCount = 0; private waited = 0; private nextTry = 0;
  private flip = 1; private dGain = 1; private aligned = false;
  private trough = CAP; private since = 0; private trim = 0; private trimAt = 0;
  private readonly pl = new Float32Array(PKT);
  private readonly pr = new Float32Array(PKT);
  private outL = new Float32Array(PKT + 256);
  private outR = new Float32Array(PKT + 256);
  private good = 0; private bad = 0; private lost = 0; private underruns = 0; private decodeMs = 0; private decoded = 0;

  /** True while the output is upmixed to 5.1 (set only when the device plays 6 channels). */
  surround = false;
  private up: Upmixer | null = null;

  setSurround(on: boolean): void {
    if (on && !this.up) this.up = new Upmixer({ rate: OUT });
    if (on && !this.surround) this.up!.reset();
    this.surround = on;
  }

  /** mix(), then the 5.1 upmix when surround is on: [L, R] or [L, R, C, LFE, Ls, Rs]. */
  output(a: Float32Array): Float32Array[] {
    const [l, r] = this.mix(a);
    return this.surround && this.up ? this.up.process(l, r) : [l, r];
  }

  select(program: number): void { if (program !== this.program) { this.program = program; this.reset(); } }

  reset(): void {
    this.core = new HdcCore(); this.sbr = new HdcSbr(); this.rsL.reset(); this.rsR.reset();
    this.queue = []; this.front = null; this.nextSeq = -1; this.badRun = BAD_RUN + 1;
    this.r = this.w = this.n = 0; this.playing = false; this.lastL = this.lastR = 0; this.written = 0; this.waited = 0; this.flip = 1; this.dGain = 1; this.aligned = false;
    this.trough = CAP; this.since = 0; this.trim = 0;
    this.good = this.bad = this.lost = this.underruns = 0; this.decodeMs = 0; this.decoded = 0;
  }

  /** One L1 frame's audio PDUs (the L2 PDU bytes they sit in). */
  addFrame(by: Uint8Array, pdus: AudioPdu[]): void {
    const d = pdus.find(x => x.program === this.program && x.streamId === 0);
    if (!d) return;
    const pk: Uint8Array[] = [];
    let start = d.off + d.la + 1;
    for (const loc of d.locators) {
      const end = d.off + loc;
      if (end < start || end >= by.length) return;
      pk.push(by.subarray(start, end + 1)); start = end + 1;
    }
    if (!pk.length) return;
    // every piece carries its own CRC, a packet split across two frames too (each half)
    const first = (d.pktSeq - (d.pfirst ? 1 : 0)) & 63;
    if (this.front && !(d.pfirst && this.front.seq === first)) { this.deliver(this.front.seq, null); this.front = null; }
    for (let j = 0; j < pk.length; j++) {
      const seq = (first + j) & 63, p = pk[j].length >= 2 && crc8ok(pk[j]) ? pk[j].subarray(0, -1) : null;
      if (j === 0 && d.pfirst) {
        const f = this.front; this.front = null;
        if (f && f.bytes && p) { const b = new Uint8Array(f.bytes.length + p.length); b.set(f.bytes); b.set(p, f.bytes.length); this.deliver(seq, b); }
        else this.deliver(seq, null);
      } else if (j === pk.length - 1 && d.plast) this.front = { seq, bytes: p ? p.slice() : null };
      else this.deliver(seq, p);
    }
  }

  private deliver(seq: number, bytes: Uint8Array | null): void {
    if (this.nextSeq < 0) { this.nextSeq = (seq + 1) & 63; if (!bytes) return; }
    else {
      const gap = (seq - this.nextSeq) & 63;
      if (gap >= 48) return;                        // behind: a repeat
      for (let i = 0; i < gap; i++) { this.queue.push(null); this.lost++; }
      this.nextSeq = (seq + 1) & 63;
    }
    if (bytes) this.queue.push(bytes.slice());
    else { this.queue.push(null); this.bad++; }
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
  }

  /** Decode one waiting packet into the buffer; false when none waits. */
  decodeOne(): boolean {
    if (!this.queue.length) return false;
    const t0 = performance.now();
    const pkt = this.queue.shift()!;
    let f = this.core.decode(pkt ?? new Uint8Array(0));
    let ok = !!pkt && !f.error;
    if (ok && this.wild(f.pcm)) { ok = false; f = this.core.undo(); }
    const o = this.sbr.process(f.pcm, f.stereo, ok ? f.sbr : null, f.conceal ?? 0);
    const l = this.pl, r = this.pr;
    const peak = this.split(o, l, r);
    if (peak > WILD || !Number.isFinite(peak)) { ok = false; l.fill(0); r.fill(0); }
    if (ok) { this.good++; this.badRun = 0; } else this.badRun++;
    const alive = this.badRun <= BAD_RUN;
    if (!alive) { l.fill(0); r.fill(0); }
    for (let i = 0; i < PKT; i++) { l[i] = l[i] > 1 ? 1 : l[i] < -1 ? -1 : l[i] || 0; r[i] = r[i] > 1 ? 1 : r[i] < -1 ? -1 : r[i] || 0; }
    const nOut = this.rsL.process(l, PKT, this.outL);
    this.rsR.process(r, PKT, this.outR);
    for (let i = 0; i < nOut; i++) {
      if (this.n >= CAP) { this.r = (this.r + 1) % CAP; this.n--; }
      this.ringL[this.w] = this.outL[i]; this.ringR[this.w] = this.outR[i]; this.okRing[this.w] = alive ? 1 : 0; this.w = (this.w + 1) % CAP; this.n++;
      if (this.written < CAP) this.written++;
    }
    this.decodeMs += performance.now() - t0; this.decoded++;
    return true;
  }

  /** Core output this loud (or not finite) came from bit errors the CRC missed. */
  private wild(pcm: Float32Array[]): boolean {
    for (const c of pcm) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]) * GAIN; if (!(a <= WILD)) return true; }
    return false;
  }

  /** Decoder output at the playing gain into l and r (a mono program on both); returns the peak. */
  private split(o: Float32Array[], l: Float32Array, r: Float32Array): number {
    const b = o.length > 1 ? o[1] : o[0];
    let peak = 0;
    for (let i = 0; i < PKT; i++) {
      l[i] = o[0][i] * GAIN; r[i] = b[i] * GAIN;
      const a = Math.max(Math.abs(l[i]), Math.abs(r[i])); if (a > peak) peak = a;
    }
    return peak;
  }

  private start(): void { this.playing = true; this.trough = CAP; this.since = 0; this.waited = 0; this.nextTry = 0; }

  /** Lines HD1's digital up with the analog now playing (the read point, polarity and level); false to keep waiting. */
  private align(chunk: number): boolean {
    this.aligned = false;
    if (this.aCount < ALIGN || this.written < ALIGN + FINE) return false;
    const mid = (j: number) => { const k = ((j % CAP) + CAP) % CAP; return this.ringL[k] + this.ringR[k]; };
    const nA = ALIGN / DEC, A = new Float32Array(nA);
    for (let b = 0; b < nA; b++) { let v = 0; for (let k = 0; k < DEC; k++) v += this.aHist[(this.aw - ALIGN + b * DEC + k + HIST) % HIST]; A[b] = v; }
    const nD = Math.floor(this.written / DEC), D = new Float32Array(nD), d0 = this.w - nD * DEC;
    for (let b = 0; b < nD; b++) { let v = 0; for (let k = 0; k < DEC; k++) v += mid(d0 + b * DEC + k); D[b] = v; }
    let best = 0, at = -1;
    for (let e = nA; e <= nD; e++) {
      let ab = 0, aa = 0, bb = 0;
      for (let b = 0; b < nA; b++) { const x = A[b], y = D[e - nA + b]; ab += x * y; aa += x * x; bb += y * y; }
      const c = ab / Math.sqrt(aa * bb + 1e-20);
      if (Math.abs(c) > Math.abs(best)) { best = c; at = e; }
    }
    if (Math.abs(best) < 0.5) return false;
    // sample-exact: the ring index that matches the newest analog sample
    const coarse = d0 + at * DEC - 1;
    let fBest = 0, j = coarse, ea = 0, ed = 0;
    for (let lag = -2 * DEC; lag <= 2 * DEC; lag++) {
      let ab = 0, aa = 0, bb = 0;
      for (let k = 0; k < FINE; k++) { const x = this.aHist[(this.aw - FINE + k + HIST) % HIST], y = mid(coarse + lag - FINE + 1 + k); ab += x * y; aa += x * x; bb += y * y; }
      const c = ab / Math.sqrt(aa * bb + 1e-20);
      if (Math.abs(c) > Math.abs(fBest)) { fBest = c; j = coarse + lag; ea = aa; ed = bb; }
    }
    // this chunk's first sample plays against its first analog sample
    const r = ((j + 1 - chunk) % CAP + CAP) % CAP, n = (this.w - r + CAP) % CAP;
    if (Math.abs(fBest) < MATCH || n < MARGIN) return false;
    this.r = r; this.n = n;
    this.flip = fBest < 0 ? -1 : 1;
    this.dGain = Math.min(4, Math.max(0.25, 2 * Math.sqrt(ea / (ed + 1e-20))));
    this.aligned = true;
    return true;
  }

  /** What plays for one chunk of the analog audio (48 kHz mono): left and right. */
  mix(a: Float32Array): [Float32Array, Float32Array] {
    const analog = this.program === 0, L = new Float32Array(a.length), R = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) { this.aHist[this.aw] = a[i]; this.aw = (this.aw + 1) % HIST; }
    this.aCount = Math.min(HIST, this.aCount + a.length);
    if (!this.playing && this.n >= START) {
      if (!analog) this.start();
      else if (this.waited >= this.nextTry && this.align(a.length)) this.start();
      else if (this.waited >= this.nextTry) this.nextTry = this.waited + OUT / 4;
      if (analog && !this.playing && (this.waited += a.length) >= ALIGN_WAIT) { this.flip = 1; this.dGain = 1; this.start(); }
    }
    const g = analog && this.aligned ? this.flip * this.dGain : 1;
    for (let i = 0; i < a.length; i++) {
      let dl = 0, dr = 0, ok = false;
      if (this.playing) {
        if (this.n > 0) {
          dl = this.ringL[this.r]; dr = this.ringR[this.r]; ok = this.okRing[this.r] === 1; this.lastL = dl; this.lastR = dr;
          let adv = 1;
          if (this.trim && ++this.trimAt >= 1000) { this.trimAt = 0; adv = this.trim > 0 ? 2 : 0; }
          adv = Math.min(adv, this.n); this.r = (this.r + adv) % CAP; this.n -= adv;
        } else { this.playing = false; this.underruns++; }
        if (this.n < this.trough) this.trough = this.n;
        if (++this.since >= WINDOW) {
          const t = this.trough;
          this.trim = t > TROUGH_HI ? 1 : t < TROUGH_LO ? -1 : (this.trim > 0 && t < OUT) || (this.trim < 0 && t > 0.75 * OUT) ? 0 : this.trim;
          this.trough = CAP; this.since = 0;
        }
      }
      if (!this.playing) { dl = this.lastL *= 0.995; dr = this.lastR *= 0.995; }
      const want = this.playing && ok ? 1 : 0;
      if (this.blend !== want) this.blend = want > this.blend ? Math.min(1, this.blend + 1 / FADE) : Math.max(0, this.blend - 1 / FADE);
      const an = (1 - this.blend) * (analog ? a[i] : 0);
      L[i] = this.blend * g * dl + an; R[i] = this.blend * g * dr + an;
    }
    return [L, R];
  }

  status(): HdAudioStatus {
    return {
      program: this.program, state: this.blend > 0.5 ? 'digital' : this.program === 0 ? 'analog' : 'silent',
      filling: !this.playing, bufferS: this.n / OUT, good: this.good, bad: this.bad, lost: this.lost, underruns: this.underruns,
      msPerPacket: this.decoded ? this.decodeMs / this.decoded : 0,
    };
  }
}
