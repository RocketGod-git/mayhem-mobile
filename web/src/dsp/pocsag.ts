/** POCSAG pager decoder (Mayhem proc_pocsag2 + pocsag.cpp; port of core/apps/PocsagDecoder.kt). */
import { BitSync, popcount32, type Emit, type IqProcessor } from './core.js';
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

export class PocsagDecoder implements IqProcessor {
  readonly wantsFm = true;
  private readonly bauds = [512, 1200, 2400];
  private syncs: BitSync[] = [];
  private fmRate = 0;
  private readonly shift = new Int32Array(3);
  /** The 32 bits before [shift]: where a transmission's preamble sits when its first sync arrives. */
  private readonly before = new Int32Array(3);
  private locked = -1;
  private inverted = false;
  private cw = 0; private bitCount = 0; private cwCount = 0;
  private address = -1; private func = 0;
  private readonly msgBits = new Uint8Array(8192);
  private msgBitCount = 0; private msgCodewords = 0;
  /** Message codewords the check could not fix, and how many in a row. */
  private errs = 0; private badRun = 0;

  constructor(private readonly emit: Emit) {}
  reset(): void { this.fmRate = 0; this.unlock(); }
  onIq(): void {}

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.fmRate) { this.fmRate = rate; this.syncs = this.bauds.map(b => new BitSync(b, rate)); this.unlock(); }
    for (let i = 0; i < n; i++) {
      const x = -samples[i];   // POCSAG '1' = negative deviation
      if (this.locked < 0) {
        for (let b = 0; b < 3; b++) {
          const bit = this.syncs[b].push(x);
          if (bit < 0) continue;
          this.before[b] = (this.before[b] << 1) | (this.shift[b] >>> 31);
          this.shift[b] = (this.shift[b] << 1) | bit;
          // A transmission opens with at least 576 bits of 1010 preamble before its first sync, so a sync is taken only
          // straight after it. A near-match to the sync inside other traffic (a FLEX channel's data) is not.
          const pre = popcount32(this.before[b] ^ 0x55555555);
          if (pre > 3 && pre < 29) continue;
          if (popcount32(this.shift[b] ^ SYNC) <= 2) { this.locked = b; this.inverted = false; this.cw = 0; this.bitCount = 0; this.cwCount = 0; this.synced(); }
          else if (popcount32(this.shift[b] ^ ~SYNC) <= 2) { this.locked = b; this.inverted = true; this.cw = 0; this.bitCount = 0; this.cwCount = 0; this.synced(); }
        }
      } else {
        const raw = this.syncs[this.locked].push(x);
        if (raw >= 0) this.onBit(this.inverted ? raw ^ 1 : raw);
      }
    }
  }

  /** A sync codeword: this channel really is POCSAG (the hunter keeps a carrier that says so). */
  private synced(): void { this.emit({ type: 'sync', protocol: 'POCSAG', rate: String(this.bauds[this.locked]) }); }

  private unlock(): void {
    this.endMessage();
    this.locked = -1; this.cw = 0; this.bitCount = 0; this.cwCount = 0;
    this.shift.fill(0); this.before.fill(0);
    for (const s of this.syncs) s.reset();
  }

  private onBit(bit: number): void {
    this.cw = (this.cw << 1) | bit;
    if (++this.bitCount < 32) return;
    this.bitCount = 0;
    if (this.cwCount >= 16) {
      // the next batch's sync, allowed a little more damage than the first, as on Android: it is expected right here
      if (popcount32(this.cw ^ SYNC) <= 4) { this.cwCount = 0; this.synced(); } else this.unlock();
      return;
    }
    this.processCodeword(this.cwCount, this.cw);
    this.cwCount++;
  }

  /**
   * As the Android app does it: the parity-checked BCH fixes up to two bits; a codeword it cannot fix keeps its place
   * (its bits stand in, counted as an error) so the rest of the message stays aligned, and four failures in a row end
   * the page. A page that is mostly failed codewords is not sent.
   */
  private processCodeword(idx: number, raw: number): void {
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
    const baud = this.locked >= 0 ? this.bauds[this.locked] : 0, errs = this.errs, n = this.msgCodewords;
    const head = `RIC ${String(this.address).padStart(7, '0')} F${this.func} ${String(baud).padStart(4)}bps`;
    const page = (kind: string, text: string) => ({ protocol: 'POCSAG', rate: String(baud), cap: this.address, kind, text, errors: errs, where: `F${this.func}` });
    if (n > 0 && errs * 2 > n + 1) this.emit({ type: 'log', line: `${head}: unreadable, ${errs} of ${n} codewords lost` });   // mostly unreadable: not worth showing
    else if (n === 0) this.emit({ type: 'packet', line: `${head} TONE`, page: page('TONE', '') });
    else {
      const alpha = this.decodeAlpha(), numeric = this.decodeNumeric();
      const isAlpha = this.func === 3 || (this.func !== 0 && alpha.length >= 2 && PocsagDecoder.looksAlpha(alpha));
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
  /** Reads as text: letters, digits, spaces and ordinary punctuation make up at least 85% of it (the Android rule). */
  private static looksAlpha(s: string): boolean {
    if (!s) return false;
    let good = 0;
    for (const c of s) if (/[\p{L}\p{N} .,:;!?\-\/()#@'"&\n]/u.test(c)) good++;
    return good * 100 >= s.length * 85;
  }
}
