/**
 * POCSAG pager decoder, the twin of the Android app's pager/PocsagDecoder.kt. Three lanes run side by side, one per
 * speed (512 / 1200 / 2400 baud), each with its own symbol clock ([FskClock]) that tracks the carrier's frequency
 * error, hunting the sync codeword in either polarity straight after a preamble; a lane that finds it reads batches
 * until the next sync fails to come. PocsagEcc (the port of Mayhem's EccContainer) stays for anything that uses it.
 */
import { popcount32, type Emit, type IqProcessor } from './core.js';
import { bchCorrect } from './flex.js';

const SYNC = 0x7CD215D8, IDLE = 0x7A89C197;
const NUMERIC_CHARS = '0123456789RU -][';

/** BCH(31,21) correction — port of Mayhem's EccContainer. */
export class PocsagEcc {
  private readonly ecs = new Int32Array(21);
  private readonly bch = new Int32Array(1024);
  out = 0;
  constructor() {
    let srr = 0x3b4;
    for (let i = 0; i <= 20; i++) { this.ecs[i] = srr; srr = (srr & 1) ? (srr >> 1) ^ 0x3B4 : srr >> 1; }
    for (let n = 0; n <= 20; n++) for (let i = 0; i <= 20; i++) { const j = (i << 5) + n; this.bch[this.ecs[n] ^ this.ecs[i]] = j + 0x2000; }
    for (let n = 0; n <= 20; n++) { this.bch[this.ecs[n]] = n + (0x1f << 5) + 0x1000; }
    for (let n = 0; n <= 20; n++) for (let i = 0; i < 10; i++) { this.bch[this.ecs[n] ^ (1 << i)] = n + (0x1f << 5) + 0x2000; }
    for (let n = 0; n < 10; n++) this.bch[1 << n] = 0x3ff + 0x1000;
    for (let n = 0; n < 10; n++) for (let i = 0; i < 10; i++) if (i !== n) this.bch[(1 << n) ^ (1 << i)] = 0x3ff + 0x2000;
  }
  correct(input: number): number {
    let v = input | 0, ecc = 0;
    for (let i = 31; i >= 11; i--) if (v & (1 << i)) ecc ^= this.ecs[31 - i];
    let acc = 0;
    for (let i = 10; i >= 1; i--) { acc <<= 1; if (v & (1 << i)) acc ^= 1; }
    const synd = ecc ^ acc;
    let errl = 0;
    if (synd !== 0) {
      if (this.bch[synd] !== 0) {
        const b1 = this.bch[synd] & 0x1f, b2 = (this.bch[synd] >> 5) & 0x1f;
        if (b2 !== 0x1f) v ^= (1 << (31 - b2));
        if (b1 !== 0x1f) v ^= (1 << (31 - b1));
        errl = this.bch[synd] >> 12;
      } else errl = 3;
    }
    if (errl === 4) errl = 3;
    this.out = v | 0;
    return errl;
  }
}

/**
 * Symbol recovery for pager FSK on FM-discriminator samples (port of FskClock.kt). A fractional phase accumulator
 * runs at the baud rate; level crossings of a quarter-symbol moving average pull it onto the symbol edges, and each
 * symbol is the average of its middle 60%. The carrier's frequency error is a slow DC, tracked and removed.
 */
export class FskClock {
  static readonly HUNT_GAIN = 0.08;
  static readonly LOCK_GAIN = 0.03;
  private readonly step: number;
  private phase = 0; private sum = 0; private n = 0; private prev = 0;
  dc = 0;
  gain = FskClock.HUNT_GAIN;
  dcRate: number;
  value = 0;
  private readonly ring = new Float64Array(64); private rp = 0; private rsum = 0;
  private readonly len: number;
  constructor(fs: number, readonly baud: number) {
    this.step = baud / fs; this.dcRate = 1 / (0.08 * fs);
    this.len = Math.max(1, Math.min(this.ring.length - 1, Math.floor(fs / baud / 4)));
  }
  push(x: number): boolean {
    this.dc += (x - this.dc) * this.dcRate;
    const v = x - this.dc, len = this.len, rl = this.ring.length;
    this.rsum -= this.ring[(this.rp - len + rl) % rl];
    this.rsum += v;
    this.ring[this.rp] = v; this.rp = (this.rp + 1) % rl;
    const sm = this.rsum / len;
    if ((this.prev < 0) !== (sm < 0)) {
      // A crossing belongs on a symbol edge; the smoothing delays it by half its length. Once locked, crossings far
      // from an edge are noise and ignored; while hunting every one counts, or a clock half a symbol off never pulls in.
      let err = this.phase - (len - 1) / 2 * this.step;
      if (err < -0.5) err += 1; else if (err >= 0.5) err -= 1;
      if (this.gain >= FskClock.HUNT_GAIN || (err > -0.4 && err < 0.4)) this.phase -= err * this.gain;
    }
    this.prev = sm;
    if (this.phase > 0.2 && this.phase < 0.8) { this.sum += v; this.n++; }
    this.phase += this.step;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.value = this.n > 0 ? this.sum / this.n : v;
      this.sum = 0; this.n = 0;
      return true;
    }
    return false;
  }
}

const HUNT = 0, BATCH = 1;

/** One speed's receiver: its own clock, its own sync hunt, its own page in progress. */
class Lane {
  private readonly clock: FskClock;
  private readonly huntDc: number;
  private reg = 0; private before = 0;
  private inv = false;
  private state = HUNT;
  private bits = 0; private cw = 0;
  private address = -1; private func = 0;
  private readonly msgBits = new Uint8Array(8192);
  private msgBitCount = 0; private msgCodewords = 0;
  /** Message codewords the check could not fix, and how many in a row. */
  private errs = 0; private badRun = 0;

  constructor(readonly baud: number, fs: number, private readonly emit: Emit) { this.clock = new FskClock(fs, baud); this.huntDc = this.clock.dcRate; }

  push(x: number): void {
    if (!this.clock.push(x)) return;
    const bit = this.clock.value < 0 ? 1 : 0;   // POCSAG sends a 1 as the low tone
    this.before = (this.before << 1) | (this.reg >>> 31);
    this.reg = (this.reg << 1) | bit;
    if (this.state === HUNT) {
      // A transmission opens with at least 576 bits of 1010 preamble before its first sync, so a sync is taken only
      // straight after it. A near-match to the sync inside other traffic (a FLEX channel's data) is not.
      const pre = popcount32(this.before ^ 0x55555555);
      if (pre > 3 && pre < 29) return;
      if (popcount32(this.reg ^ SYNC) <= 2) { this.inv = false; this.startBatch(); }
      else if (popcount32(this.reg ^ ~SYNC) <= 2) { this.inv = true; this.startBatch(); }
      return;
    }
    if (++this.bits < 32) return;
    this.bits = 0;
    const w = this.inv ? ~this.reg : this.reg;
    if (this.cw < 16) { this.codeword(w, this.cw); this.cw++; return; }
    // the next batch's sync, allowed a little more damage than the first: it is expected right here
    if (popcount32(w ^ SYNC) <= 4) this.startBatch(); else { this.endMessage(); this.hunt(); }
  }

  reset(): void { this.endMessage(); this.hunt(); this.reg = 0; this.before = 0; }

  private startBatch(): void {
    this.state = BATCH; this.bits = 0; this.cw = 0;
    this.clock.gain = FskClock.LOCK_GAIN;
    this.clock.dcRate = 0;   // the preamble set the carrier's DC; message bits are not balanced, so hold it
    this.emit({ type: 'sync', protocol: 'POCSAG', rate: String(this.baud) });
  }

  private hunt(): void { this.state = HUNT; this.clock.gain = FskClock.HUNT_GAIN; this.clock.dcRate = this.huntDc; }

  /**
   * As the Android app does it: the parity-checked BCH fixes up to two bits; a codeword it cannot fix keeps its place
   * (its bits stand in, counted as an error) so the rest of the message stays aligned, and four failures in a row end
   * the page. A page that is mostly failed codewords is not sent.
   */
  private codeword(raw: number, idx: number): void {
    const c = bchCorrect(raw | 0);
    if (c === null) {
      if (this.address >= 0) { this.addChunk((raw >>> 11) & 0xFFFFF); this.errs++; if (++this.badRun >= 4) this.endMessage(); }
      return;
    }
    this.badRun = 0;
    if ((c >>> 0) === IDLE) { this.endMessage(); return; }
    if ((c >>> 31) === 0) {
      this.endMessage();
      this.address = (((c >>> 13) & 0x3FFFF) << 3) | (idx >> 1);
      this.func = (c >>> 11) & 3;
    } else if (this.address >= 0) this.addChunk((c >>> 11) & 0xFFFFF);
  }

  private addChunk(v: number): void {
    if (this.msgBitCount + 20 > this.msgBits.length) return;
    for (let b = 19; b >= 0; b--) this.msgBits[this.msgBitCount++] = (v >>> b) & 1;
    this.msgCodewords++;
  }

  private endMessage(): void {
    if (this.address < 0) return;
    const baud = this.baud, errs = this.errs, n = this.msgCodewords;
    const head = `RIC ${String(this.address).padStart(7, '0')} F${this.func} ${String(baud).padStart(4)}bps`;
    const page = (kind: string, text: string) => ({ protocol: 'POCSAG', rate: String(baud), cap: this.address, kind, text, errors: errs, where: `F${this.func}` });
    if (n > 0 && errs * 2 > n + 1) this.emit({ type: 'log', line: `${head}: unreadable, ${errs} of ${n} codewords lost` });   // mostly unreadable: not worth showing
    else if (n === 0) this.emit({ type: 'packet', line: `${head} TONE`, page: page('TONE', '') });
    else {
      const alpha = this.decodeAlpha(), numeric = this.decodeNumeric();
      const isAlpha = this.func === 3 || (this.func !== 0 && alpha.length >= 2 && looksAlpha(alpha));
      const part = errs ? ' PARTIAL' : '';
      this.emit({ type: 'packet', line: isAlpha ? `${head} ALPHA${part}: ${alpha}` : `${head} NUM${part}: ${numeric}`, page: isAlpha ? page('ALPHA', alpha) : page('NUM', numeric.trim()) });
    }
    this.address = -1; this.msgBitCount = 0; this.msgCodewords = 0; this.errs = 0; this.badRun = 0;
  }

  private decodeAlpha(): string {
    let s = '';
    for (let i = 0; i + 7 <= this.msgBitCount; i += 7) {
      let ch = 0;
      for (let b = 0; b < 7; b++) ch |= this.msgBits[i + b] << b;
      if (ch === 0x00 || ch === 0x03 || ch === 0x04 || ch === 0x17) break;   // end of text, or padding
      if (ch === 0x0a || ch === 0x0d) s += '\n';
      else if (ch >= 0x20) s += String.fromCharCode(ch);
    }
    return s.trim();
  }
  private decodeNumeric(): string {
    let s = '';
    for (let i = 0; i + 4 <= this.msgBitCount; i += 4) {
      const d = this.msgBits[i] | (this.msgBits[i + 1] << 1) | (this.msgBits[i + 2] << 2) | (this.msgBits[i + 3] << 3);
      s += NUMERIC_CHARS[d];
    }
    return s.trimEnd();
  }
}

/** Reads as text: letters, digits, spaces and ordinary punctuation make up at least 85% of it (the Android rule). */
function looksAlpha(s: string): boolean {
  if (!s) return false;
  let good = 0;
  for (const c of s) if (/[\p{L}\p{N} .,:;!?\-\/()#@'"&\n]/u.test(c)) good++;
  return good * 100 >= s.length * 85;
}

export class PocsagDecoder implements IqProcessor {
  readonly wantsFm = true;
  private lanes: Lane[] = [];
  private fmRate = 0;

  constructor(private readonly emit: Emit) {}
  reset(): void { for (const l of this.lanes) l.reset(); this.fmRate = 0; this.lanes = []; }
  onIq(): void {}

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.fmRate) { for (const l of this.lanes) l.reset(); this.fmRate = rate; this.lanes = [512, 1200, 2400].map(b => new Lane(b, rate, this.emit)); }
    for (const l of this.lanes) for (let i = 0; i < n; i++) l.push(samples[i]);
  }
}
