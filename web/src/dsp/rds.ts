/**
 * RDS (Radio Data System) decoder, fed with the FM discriminator's composite signal.
 *
 * The 57 kHz subcarrier is brought to baseband by a fixed oscillator at the full sample rate, filtered to the
 * ±2.4 kHz the standard allots to it, and decimated to roughly 40 kHz. Only then does a Costas loop take out the
 * residual phase and frequency error: at the low rate the loop costs nothing and its bandwidth is easy to reason
 * about. The pilot is not used, so a mono station carrying RDS decodes the same as a stereo one.
 *
 * Symbol recovery works on half-symbols. Biphase coding guarantees a zero crossing in the middle of every bit, so
 * a half-symbol integrate-and-dump whose phase is nudged by the crossings never starves for timing information.
 * Which of the two halves begins a bit is decided by scoring both pairings: the right one has halves of opposite
 * sign in every bit, the wrong one only half the time. The two halves are then differenced and differentially
 * decoded, which is what makes the chain indifferent to carrier polarity and to the 180° ambiguity of the loop.
 *
 * Block synchronization uses the syndrome trick: the remainder of an undamaged 26-bit block modulo the generator
 * is its offset word, so sliding a window one bit at a time and looking for offsets A, B, C or C', D in sequence
 * finds the group boundary without ever knowing the data. Sync is held through bad blocks and dropped after fifty
 * consecutive failures, about a second, which is long enough to ride out a fade and short enough that a retune
 * shows up promptly.
 *
 * The input amplitude is arbitrary — an AGC ahead of the loop normalizes it — and any sample rate that keeps the
 * subcarrier's upper sideband (59.4 kHz) below Nyquist works; in practice that means 120 kHz and up.
 */

export interface RdsState {
  pi: number | null;
  ps: string;
  rt: string;
  pty: number | null;
  ptyName: string;
  tp: boolean;
  ta: boolean;
  ms: boolean;
  groups: number;
  errors: number;
  synced: boolean;
  af: number[];
}

/** RDS (European) program type names, index 0..31. */
export const PTY_NAMES: readonly string[] = [
  'None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education', 'Drama', 'Culture', 'Science', 'Varied',
  'Pop Music', 'Rock Music', 'Easy Listening', 'Light Classical', 'Serious Classical', 'Other Music', 'Weather',
  'Finance', "Children's", 'Social Affairs', 'Religion', 'Phone In', 'Travel', 'Leisure', 'Jazz Music',
  'Country Music', 'National Music', 'Oldies Music', 'Folk Music', 'Documentary', 'Alarm Test', 'Alarm',
];

const POLY = 0x5b9;   // x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1
export const OFFSET_A = 0x0fc, OFFSET_B = 0x198, OFFSET_C = 0x168, OFFSET_CP = 0x350, OFFSET_D = 0x1b4;

const BAUD = 1187.5;
const SUBCARRIER = 57000;
const SYNC_LOSS_BLOCKS = 50;
const HALF_SYMBOL_GAIN = 0.1;
const LOOP_BANDWIDTH_HZ = 40;
const ALIGN_FLIP_SYMBOLS = 8;

/** Remainder of a 26-bit block modulo the generator. For an undamaged block this is the block's offset word. */
export function rdsSyndrome(block: number): number {
  let r = 0;
  for (let i = 25; i >= 0; i--) {
    r = (r << 1) | ((block >>> i) & 1);
    if (r & 0x400) r ^= POLY;
  }
  return r;
}

/** The 10-bit checkword that goes on `data` (16 bits) for a block carrying `offset`. */
export function rdsCheckword(data: number, offset: number): number {
  return rdsSyndrome((data & 0xffff) << 10) ^ offset;
}

class Biquad {
  private z1 = 0; private z2 = 0;
  constructor(private readonly b0: number, private readonly b1: number, private readonly b2: number,
              private readonly a1: number, private readonly a2: number) {}
  push(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** 6th-order Butterworth lowpass: three second-order sections. */
class Lowpass {
  private readonly s: Biquad[] = [];
  constructor(cutoffHz: number, rate: number) {
    const w0 = 2 * Math.PI * Math.min(0.45 * rate, cutoffHz) / rate, c = Math.cos(w0);
    for (const q of [1.9319, 0.7071, 0.5176]) {
      const alpha = Math.sin(w0) / (2 * q), a0 = 1 + alpha;
      this.s.push(new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0));
    }
  }
  push(x: number): number { for (const b of this.s) x = b.push(x); return x; }
}

const charOf = (c: number): string => (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : ' ';

/** The text one group carries: a PS segment (two characters) or a RadioText segment (two or four) with its A/B flag. */
type PendingText =
  | { kind: 'ps'; seg: number; key: number }
  | { kind: 'rt'; seg: number; width: 2 | 4; key: number; ab: number };

export class RdsDecoder {
  private rate = 0;

  // Full-rate stage: complex rotator at 57 kHz, lowpass on each arm, decimation.
  private rotRe = 1; private rotIm = 0; private stepRe = 1; private stepIm = 0; private rotCount = 0;
  private lpI = new Lowpass(2400, 250000); private lpQ = new Lowpass(2400, 250000);
  private decim = 1; private decimCount = 0;

  // Decimated stage: AGC and the Costas loop.
  private agc = 0; private agcK = 0;
  private phase = 0; private freq = 0; private alpha = 0; private beta = 0; private maxFreq = 0;

  // Half-symbol clock and Manchester pairing.
  private hPhase = 0; private hInc = 0; private hAcc = 0; private lastPos = false; private hFirst = true;
  private prevHalf = 0; private halfParity = 0;
  private align = 0; private readonly score = [0, 0]; private flipCount = 0;
  private prevSym = 0;

  // Block sync.
  private shift = 0; private bitsSince = 0; private expect = 0; private badRun = 0;
  private readonly blocks = new Int32Array(4);
  private readonly good = [false, false, false, false];
  private cPrime = false;

  // Decoded state.
  private pi: number | null = null; private piCandidate = -1;
  private pty: number | null = null; private tp = false; private ta = false; private ms = false;
  private readonly psChars = new Uint8Array(8);
  private readonly rtChars = new Uint8Array(64);
  /**
   * PS (the eight-character name) is assembled a whole frame at a time and shown only when a frame completes.
   * Stations scroll song titles through the name a frame a second (dynamic PS), each frame heard once, so writing
   * segments as they land shows a blend of two frames; buffering to the frame boundary — a segment index that
   * repeats is the next frame beginning — shows each frame whole, and a fixed name settles in one cycle just the
   * same. The block checkword is the guard against a garbled segment: a bad one keeps its frame from completing
   * cleanly, so it is skipped, costing one cycle. RadioText is written a segment at a time and shown up to its
   * carriage return; there too the checkword is the guard.
   */
  private readonly psBuild = new Uint8Array(8); private psMask = 0; private psAny = false;
  private readonly psLast = new Uint8Array(8); private psHaveLast = false;   // the previous whole frame, to tell a real name from a scroll
  private psStreak = 0; private psChanges = 0; private psScrolls = false;    // a real name repeats; a scroll keeps changing and latches suppressed
  private rtWidth = 4;
  /** The text of the group that proposed a new PI, applied once a second group confirms the station. */
  private pending: PendingText | null = null;
  private ps = '        '; private rt = ''; private abFlag = -1;
  private af: number[] = [];
  private groups = 0; private errors = 0; private synced = false;

  private dirty = false; private sinceEmit = 0; private emitEvery = 0;

  constructor(private readonly emit: (s: RdsState) => void) { this.clearText(); }

  reset(): void {
    this.rate = 0;
    this.dropSync();
    this.pi = null; this.piCandidate = -1; this.pty = null; this.tp = false; this.ta = false; this.ms = false;
    this.abFlag = -1; this.clearText(); this.af = []; this.pending = null;
    this.groups = 0; this.errors = 0;
    this.dirty = false; this.sinceEmit = 0;
  }

  get state(): RdsState {
    return {
      pi: this.pi, ps: this.ps, rt: this.rt, pty: this.pty,
      ptyName: this.pty === null ? '' : PTY_NAMES[this.pty],
      tp: this.tp, ta: this.ta, ms: this.ms, groups: this.groups, errors: this.errors, synced: this.synced,
      af: this.af.slice(),
    };
  }

  /** FM-discriminator composite (MPX) samples at `rate` Hz. Amplitude is arbitrary. */
  push(mpx: Float32Array, n: number, rate: number): void {
    if (rate !== this.rate) this.configure(rate);
    for (let k = 0; k < n; k++) {
      const x = mpx[k];
      const i = x * this.rotRe, q = -x * this.rotIm;
      const re = this.rotRe * this.stepRe - this.rotIm * this.stepIm;
      const im = this.rotRe * this.stepIm + this.rotIm * this.stepRe;
      this.rotRe = re; this.rotIm = im;
      // A recursive rotator drifts in magnitude; pulling it back onto the unit circle now and then is far cheaper
      // than a sine and cosine per sample at the full rate.
      if (++this.rotCount >= 4096) {
        this.rotCount = 0;
        const g = 1 / Math.sqrt(re * re + im * im);
        this.rotRe *= g; this.rotIm *= g;
      }
      const fi = this.lpI.push(i), fq = this.lpQ.push(q);
      if (++this.decimCount >= this.decim) { this.decimCount = 0; this.baseband(fi, fq); }
      this.sinceEmit++;
    }
    if (this.dirty && this.sinceEmit >= this.emitEvery) this.flush();
  }

  private configure(rate: number): void {
    this.rate = rate;
    const w = 2 * Math.PI * SUBCARRIER / rate;
    this.stepRe = Math.cos(w); this.stepIm = Math.sin(w);
    this.rotRe = 1; this.rotIm = 0; this.rotCount = 0;
    this.lpI = new Lowpass(2400, rate); this.lpQ = new Lowpass(2400, rate);
    // Decimate to a little under 40 kHz: about 16 samples per half-symbol, enough for the timing loop to steer by.
    this.decim = Math.max(1, Math.floor(rate / 38000)); this.decimCount = 0;
    const decRate = rate / this.decim;

    this.agc = 0; this.agcK = 1 / (0.05 * decRate);
    // Second-order loop, critically damped, sized for the Costas detector's gain of A²/2 at unit amplitude.
    const zeta = 0.707, theta = (LOOP_BANDWIDTH_HZ / decRate) / (zeta + 1 / (4 * zeta));
    const denom = 1 + 2 * zeta * theta + theta * theta, kp = 0.5;
    this.alpha = (4 * zeta * theta / denom) / kp;
    this.beta = (4 * theta * theta / denom) / kp;
    this.maxFreq = 2 * Math.PI * 400 / decRate;
    this.phase = 0; this.freq = 0;

    this.hInc = 2 * BAUD / decRate; this.hPhase = 0; this.hAcc = 0; this.hFirst = true;
    this.prevHalf = 0; this.halfParity = 0; this.align = 0; this.score[0] = this.score[1] = 0; this.flipCount = 0;
    this.prevSym = 0;
    this.emitEvery = rate / 4;
    this.dropSync();
  }

  private baseband(i: number, q: number): void {
    const mag = Math.sqrt(i * i + q * q);
    if (this.agc === 0) this.agc = mag; else this.agc += (mag - this.agc) * this.agcK;
    const g = 1 / Math.max(this.agc, 1e-12);
    i *= g; q *= g;

    const c = Math.cos(this.phase), s = Math.sin(this.phase);
    const ii = i * c + q * s, qq = q * c - i * s;
    let e = ii * qq;
    if (e > 1) e = 1; else if (e < -1) e = -1;
    this.freq += this.beta * e;
    if (this.freq > this.maxFreq) this.freq = this.maxFreq; else if (this.freq < -this.maxFreq) this.freq = -this.maxFreq;
    this.phase += this.freq + this.alpha * e;
    if (this.phase > Math.PI) this.phase -= 2 * Math.PI; else if (this.phase < -Math.PI) this.phase += 2 * Math.PI;

    const pos = ii > 0;
    if (!this.hFirst && pos !== this.lastPos) {
      const err = this.hPhase < 0.5 ? this.hPhase : this.hPhase - 1;
      this.hPhase -= err * HALF_SYMBOL_GAIN;
    }
    this.hFirst = false; this.lastPos = pos;
    this.hAcc += ii;
    this.hPhase += this.hInc;
    if (this.hPhase >= 1) {
      this.hPhase -= 1;
      const h = this.hAcc; this.hAcc = 0;
      this.onHalf(h);
    }
  }

  private onHalf(h: number): void {
    const prev = this.prevHalf; this.prevHalf = h;
    // The pair (prev, h) is a whole bit under the alignment that starts on prev's parity.
    const a = this.halfParity; this.halfParity ^= 1;
    this.score[a] = this.score[a] * 0.95 + (Math.abs(prev - h) - Math.abs(prev + h));
    if (a !== this.align) return;
    const sym = prev - h > 0 ? 1 : 0;
    const bit = sym ^ this.prevSym;
    this.prevSym = sym;
    this.onBit(bit);
    if (this.score[a ^ 1] > this.score[a]) {
      if (++this.flipCount >= ALIGN_FLIP_SYMBOLS) { this.align ^= 1; this.flipCount = 0; }
    } else this.flipCount = 0;
  }

  private wanted(slot: number, s: number): boolean {
    switch (slot) {
      case 0: return s === OFFSET_A;
      case 1: return s === OFFSET_B;
      case 2: return s === OFFSET_C || s === OFFSET_CP;
      default: return s === OFFSET_D;
    }
  }

  private onBit(bit: number): void {
    this.shift = ((this.shift << 1) | bit) & 0x3ffffff;
    this.bitsSince++;
    if (!this.synced) {
      if (this.expect === 0) {
        if (rdsSyndrome(this.shift) === OFFSET_A) { this.blocks[0] = this.shift >>> 10; this.expect = 1; this.bitsSince = 0; }
        return;
      }
      if (this.bitsSince < 26) return;
      this.bitsSince = 0;
      const s = rdsSyndrome(this.shift);
      if (this.wanted(this.expect, s)) {
        this.blocks[this.expect] = this.shift >>> 10;
        if (this.expect === 2) this.cPrime = s === OFFSET_CP;
        if (++this.expect === 4) {
          this.expect = 0; this.synced = true; this.badRun = 0;
          this.good.fill(true);
          this.processGroup();
          this.flush();
        }
      } else if (s === OFFSET_A) { this.blocks[0] = this.shift >>> 10; this.expect = 1; }
      else this.expect = 0;
      return;
    }
    if (this.bitsSince < 26) return;
    this.bitsSince = 0;
    const s = rdsSyndrome(this.shift);
    const ok = this.wanted(this.expect, s);
    this.good[this.expect] = ok;
    this.blocks[this.expect] = this.shift >>> 10;
    if (this.expect === 2) this.cPrime = s === OFFSET_CP;
    if (ok) this.badRun = 0;
    else {
      this.errors++;
      if (++this.badRun >= SYNC_LOSS_BLOCKS) { this.dropSync(); this.flush(); return; }
    }
    if (++this.expect === 4) { this.expect = 0; this.processGroup(); }
  }

  private dropSync(): void {
    this.synced = false; this.expect = 0; this.bitsSince = 0; this.badRun = 0; this.shift = 0;
    this.good.fill(false);
  }

  private processGroup(): void {
    const [a, b, c, d] = this.blocks;
    if (this.good[0] && this.good[1] && this.good[2] && this.good[3]) this.groups++;
    // A group that names another station must not write into this one's texts; a group whose PI block failed is
    // far more likely to be this station in a fade than a different one, so it is still used. The group that
    // first proposes a new PI is kept aside and applied the moment a second group confirms it: otherwise the
    // first thing heard after a retune was always thrown away, and with text believed only on repetition that
    // cost the name a cycle and could cost the radiotext a whole message cycle before anything showed.
    if (this.good[0]) {
      const adopted = this.observePi(a);
      if (a !== this.pi) { this.pending = this.good[1] ? this.textOf(b, c, d) : null; return; }
      if (adopted && this.pending) this.applyText(this.pending);
      this.pending = null;
    } else if (this.pi === null) return;
    if (!this.good[1]) return;

    const type = b >> 12, versionB = (b >> 11) & 1, tp = ((b >> 10) & 1) === 1, pty = (b >> 5) & 0x1f;
    if (tp !== this.tp) { this.tp = tp; this.dirty = true; }
    if (pty !== this.pty) { this.pty = pty; this.dirty = true; }

    if (type === 0) {
      const ta = ((b >> 4) & 1) === 1, ms = ((b >> 3) & 1) === 1;
      if (ta !== this.ta) { this.ta = ta; this.dirty = true; }
      if (ms !== this.ms) { this.ms = ms; this.dirty = true; }
      if (!versionB && this.good[2] && !this.cPrime) this.observeAf(c >> 8, c & 0xff);
    }
    const text = this.textOf(b, c, d);
    if (text) this.applyText(text);
  }

  /** The text a group carries, if any. A segment counts only when every block carrying it was good: half a segment is not a sighting. */
  private textOf(b: number, c: number, d: number): PendingText | null {
    const type = b >> 12, versionB = ((b >> 11) & 1) === 1;
    if (type === 0) return this.good[3] ? { kind: 'ps', seg: b & 3, key: d } : null;
    if (type !== 2) return null;
    const seg = b & 0xf, ab = (b >> 4) & 1;
    if (versionB) return this.good[3] ? { kind: 'rt', seg, width: 2, key: d, ab } : null;
    return this.good[2] && this.good[3] ? { kind: 'rt', seg, width: 4, key: ((c << 16) | d) | 0, ab } : null;
  }

  private applyText(t: PendingText): void {
    if (t.kind === 'ps') { this.seePs(t.seg, t.key); return; }
    // A toggled flag is the station's way of saying the text that follows is unrelated to what came before;
    // without the clear, a shorter new text would trail fragments of the old one. The text already on screen
    // stays until the new one is confirmed in full — a blank that then trickles in is worse than a moment of
    // the old message.
    if (t.ab !== this.abFlag) { if (this.abFlag >= 0) this.clearRt(); this.abFlag = t.ab; }
    this.seeRt(t.seg, t.width, t.key);
  }

  /**
   * A block that passes its checkword yet is damaged is rare, but a wrong PI would wipe the texts, so a new PI has
   * to arrive twice running before it is believed.
   */
  private observePi(pi: number): boolean {
    if (pi === this.pi) { this.piCandidate = -1; return false; }
    if (pi !== this.piCandidate) { this.piCandidate = pi; return false; }
    this.pi = pi; this.piCandidate = -1;
    this.clearText(); this.af = []; this.abFlag = -1;
    this.dirty = true;
    return true;                              // adopted just now: the caller replays the proposing group's text
  }

  private observeAf(hi: number, lo: number): void {
    // 250 announces one LF/MF frequency in the second byte; it is not a VHF code and is left out.
    if (hi === 250) return;
    this.addAf(hi); this.addAf(lo);
  }

  private addAf(code: number): void {
    // 1..204 are VHF channels; 205 is filler, 224..249 say how many follow, the rest are unassigned.
    if (code < 1 || code > 204) return;
    const f = (875 + code) / 10;
    if (this.af.includes(f) || this.af.length >= 25) return;
    this.af.push(f); this.af.sort((x, y) => x - y);
    this.dirty = true;
  }

  /**
   * One PS segment (two characters in `key`). Buffered into the current frame; a segment index that repeats
   * marks the next frame, and a frame is shown only once all four of its segments are in — whole, never a blend
   * of two. A fixed name commits the same eight characters every cycle, so it settles after one and then holds.
   */
  private seePs(seg: number, key: number): void {
    const bit = 1 << seg;
    if (this.psMask & bit) { this.psMask = 0; this.psBuild.fill(0x20); }   // this index again: a new frame has begun; the incomplete one is dropped
    this.psBuild[2 * seg] = (key >> 8) & 0xff; this.psBuild[2 * seg + 1] = key & 0xff;
    this.psMask |= bit;
    if (this.psMask !== 0b1111) return;                                    // only whole frames count
    this.psMask = 0;
    // A real, static station name is the same whole frame every cycle; a name a station scrolls a song title
    // through — where each of the four segments in a cycle is a different scroll position, so even a whole frame
    // is a jumble ("Frltz ic") — keeps changing. Show the name once it has repeated (a real name); the moment a
    // name has changed a few times it is a scroll, which latches suppressed and drops any fragment shown, so the
    // first field is never a frozen scroll piece. The RadioText carries the full text.
    let same = this.psHaveLast;
    for (let i = 0; i < 8 && same; i++) if (this.psBuild[i] !== this.psLast[i]) same = false;
    if (this.psHaveLast && !same) { this.psStreak = 0; if (++this.psChanges >= 3) this.psScrolls = true; }
    else if (++this.psStreak >= 4) this.psChanges = 0;                    // a solidly stable name clears the scroll suspicion, so a rare garble never latches a real name
    this.psLast.set(this.psBuild); this.psHaveLast = true;
    if (this.psScrolls) {
      if (this.psAny) { this.psAny = false; this.psChars.fill(0x20); this.refreshPs(); }   // it turned out to be a scroll: drop the fragment
      this.psBuild.fill(0x20); return;
    }
    if (this.psStreak >= 2) {                                             // repeated: a real name
      let changed = !this.psAny;
      for (let i = 0; i < 8; i++) if (this.psChars[i] !== this.psBuild[i]) { this.psChars[i] = this.psBuild[i]; changed = true; }
      this.psAny = true;
      if (changed) this.refreshPs();
    }
    this.psBuild.fill(0x20);
  }
  /** One RadioText segment (`width` characters in `key`), written straight in — the checkword already vouched for it. */
  private seeRt(seg: number, width: 2 | 4, key: number): void {
    if (width !== this.rtWidth) { this.clearRt(); this.rtWidth = width; }   // a station switching 2A <-> 2B is a new message
    const base = seg * width;
    if (base + width > 64) return;
    if (width === 4) { this.rtChars[base] = (key >>> 24) & 0xff; this.rtChars[base + 1] = (key >>> 16) & 0xff; this.rtChars[base + 2] = (key >>> 8) & 0xff; this.rtChars[base + 3] = key & 0xff; }
    else { this.rtChars[base] = (key >> 8) & 0xff; this.rtChars[base + 1] = key & 0xff; }
    this.refreshRt();
  }
  private clearRt(): void { this.rtChars.fill(0x20); }
  private clearText(): void {
    this.psChars.fill(0x20); this.psBuild.fill(0x20); this.psMask = 0; this.psAny = false; this.psLast.fill(0x20); this.psHaveLast = false;
    this.psStreak = 0; this.psChanges = 0; this.psScrolls = false;
    this.clearRt(); this.rtWidth = 4;
    this.ps = '        '; this.rt = '';
  }

  private refreshPs(): void {
    let s = '';
    for (let i = 0; i < 8; i++) s += charOf(this.psChars[i]);
    if (s !== this.ps) { this.ps = s; this.dirty = true; }
  }

  private refreshRt(): void {
    let s = '';
    for (let i = 0; i < 64; i++) { const c = this.rtChars[i]; if (c === 0x0d) break; s += charOf(c); }
    s = s.trimEnd();
    if (s !== this.rt) { this.rt = s; this.dirty = true; }
  }

  private flush(): void {
    this.dirty = false; this.sinceEmit = 0;
    this.emit(this.state);
  }
}
