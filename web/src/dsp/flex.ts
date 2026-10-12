/**
 * FLEX pager decoder — port of Mayhem's proc_flex.cpp (multimon-ng lineage): 1600/3200/6400 bps, 2- and 4-level
 * FSK, sync + FIW + block-interleaved BCH(32,21) phases, BIW / address / vector parsing for alphanumeric, numeric
 * (standard, special, numbered), short-message, tone, hex and instruction pages. Rides on the NFM discriminator.
 */
import { popcount32, type Emit, type IqProcessor } from './core.js';
import { PocsagEcc } from './pocsag.js';

const DC_OFFSET_FILTER = 0.010, PHASE_LOCKED_RATE = 0.045, PHASE_UNLOCKED_RATE = 0.050, LOCK_LEN = 24, IDLE_THRESHOLD = 0, DEMOD_TIMEOUT = 100;
const FLEX_SYNC_MARKER = 0xA6C6AAAA, SLICE_THRESHOLD = 0.667;
const FLEX_BCD = '0123456789.U -][';
const MASK64 = (1n << 64n) - 1n;
const LOCK_MASK = (1n << BigInt(2 * LOCK_LEN)) - 1n;
const LOCK_PATTERN = 0x6666666666666666n;
const TYPE_NAMES = ['SEC', 'INS', 'TONE', 'NUM', 'SNUM', 'ALN', 'HEX', 'NNUM', 'SHORT', 'BIW'];
const ADDR_NAMES = ['', 'long', 'temp', 'oper', 'net', 'info', 'rsvd', 'unk'];

const enum St { SYNC1, FIW, SYNC2, DATA }
const enum PT { SECURE, SHORT_INSTRUCTION, TONE, STANDARD_NUMERIC, SPECIAL_NUMERIC, ALPHANUMERIC, BINARY, NUMBERED_NUMERIC }

function bitReverse32(x: number): number {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0F0F0F0F) | ((x & 0x0F0F0F0F) << 4);
  x = ((x >>> 8) & 0x00FF00FF) | ((x & 0x00FF00FF) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}
const hex = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

export class FlexDecoder implements IqProcessor {
  readonly wantsFm = true;
  private fmRate = 0;
  // demodulator
  private sampleFreq = 24000; private sampleLast = 0; private locked = 0; private phase = 0;
  private envelopeSum = 0; private envelopeCount = 0; private lockBuf = 0n; private readonly symcount = [0, 0, 0, 0];
  private timeout = 0; private nonconsec = 0; private baud = 1600;
  private envelope = 0; private zero = 0;
  // state
  private st = St.SYNC1; private sync2Count = 0; private dataCount = 0; private fiwCount = 0;
  private sync2Shift = 0; private sync2CPos = -1; private sync2CinvPos = -1;
  private syncBaud = 0; private syncLevels = 0; private polarity = 0; private syncBuf = 0n;
  private fiwRaw = 0; private cycleNo = 0; private frameNo = 0;
  private readonly ph = [new Uint32Array(88), new Uint32Array(88), new Uint32Array(88), new Uint32Array(88)];
  private readonly idle = [0, 0, 0, 0];
  private phaseToggle = 0; private dataBitCounter = 0;
  // decode
  private dType = PT.ALPHANUMERIC; private longAddress = 0; private capcode = 0; private addrType = 0; private isPriority = 0;
  private readonly ecc = new PocsagEcc();
  private frames = 0; private lastStat = 0;

  constructor(private readonly emit: Emit) {}
  reset(): void { this.fmRate = 0; this.locked = 0; this.st = St.SYNC1; }
  onIq(): void {}

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.fmRate) { this.fmRate = rate; this.sampleFreq = rate; this.locked = 0; this.st = St.SYNC1; this.zero = 0; this.phase = 0; }
    for (let i = 0; i < n; i++) this.demodulate(samples[i]);
    const now = performance.now();
    if (now - this.lastStat > 5000 && this.frames) { this.lastStat = now; this.emit({ type: 'log', line: `FLEX: ${this.frames} frames decoded, locked=${this.locked}` }); }
  }

  private demodulate(sample: number): void {
    if (this.buildSymbol(sample) !== 1) return;
    this.nonconsec = 0;
    let decmax = 0, modal = 0;
    for (let j = 0; j < 4; j++) if (this.symcount[j] > decmax) { modal = j; decmax = this.symcount[j]; }
    this.symcount[0] = this.symcount[1] = this.symcount[2] = this.symcount[3] = 0;
    if (this.locked) this.flexSym(modal);
    else {
      this.lockBuf = ((this.lockBuf << 2n) | BigInt(modal ^ 1)) & MASK64;
      const pat = this.lockBuf ^ LOCK_PATTERN;
      if ((pat & LOCK_MASK) === 0n || ((~pat) & LOCK_MASK) === 0n) { this.locked = 1; this.lockBuf = 0n; }
    }
    if (++this.timeout > DEMOD_TIMEOUT) this.locked = 0;
  }

  private buildSymbol(sampleIn: number): number {
    const phaseMax = 100 * this.sampleFreq;
    const phaseRate = 100 * this.baud;
    const pct = 100 * this.phase / phaseMax;
    let sample = sampleIn;
    if (this.st === St.SYNC1) { const k = this.sampleFreq * DC_OFFSET_FILTER; this.zero = (this.zero * k + sample) / (k + 1); }
    sample -= this.zero;
    if (this.locked) {
      if (this.st === St.SYNC1) { this.envelopeSum += Math.abs(sample); this.envelopeCount++; this.envelope = this.envelopeSum / this.envelopeCount; }
    } else {
      this.envelope = 0; this.envelopeSum = 0; this.envelopeCount = 0; this.baud = 1600; this.timeout = 0; this.nonconsec = 0; this.st = St.SYNC1;
    }
    if (pct > 10 && pct < 90) {
      if (sample > 0) { if (sample > this.envelope * SLICE_THRESHOLD) this.symcount[3]++; else this.symcount[2]++; }
      else { if (sample < -this.envelope * SLICE_THRESHOLD) this.symcount[0]++; else this.symcount[1]++; }
    }
    if ((this.sampleLast < 0 && sample >= 0) || (this.sampleLast >= 0 && sample < 0)) {
      const err = pct < 50 ? this.phase : this.phase - phaseMax;
      this.phase -= err * (this.locked ? PHASE_LOCKED_RATE : PHASE_UNLOCKED_RATE);
      if (pct > 10 && pct < 90) { if (++this.nonconsec > 20 && this.locked) this.locked = 0; } else this.nonconsec = 0;
      this.timeout = 0;
    }
    this.sampleLast = sample;
    this.phase += phaseRate;
    if (this.phase > phaseMax) { this.phase -= phaseMax; return 1; }
    return 0;
  }

  private syncCheck(buf: bigint): number {
    const marker = Number((buf >> 16n) & 0xFFFFFFFFn);
    const codehigh = Number((buf >> 48n) & 0xFFFFn);
    const codelow = (~Number(buf & 0xFFFFn)) & 0xFFFF;
    return popcount32((marker ^ FLEX_SYNC_MARKER) >>> 0) < 4 && popcount32(codelow ^ codehigh) < 4 ? codehigh : 0;
  }
  private flexSync(sym: number): number {
    this.syncBuf = ((this.syncBuf << 1n) | BigInt(sym < 2 ? 1 : 0)) & MASK64;
    let r = this.syncCheck(this.syncBuf);
    if (r) { this.polarity = 0; return r; }
    r = this.syncCheck((~this.syncBuf) & MASK64);
    if (r) this.polarity = 1;
    return r;
  }
  private decodeMode(code: number): void {
    const modes: [number, number, number][] = [[0x870C, 1600, 2], [0xB068, 1600, 4], [0x7B18, 3200, 2], [0xDEA0, 3200, 4], [0x4C7C, 3200, 4]];
    for (const [s, b, l] of modes) if (popcount32(s ^ code) < 4) { this.syncBaud = b; this.syncLevels = l; return; }
    this.syncBaud = 1600; this.syncLevels = 2;
  }
  private bchFix(v: number): { ok: boolean; v: number } {
    const rev = bitReverse32(v);
    const e = this.ecc.correct(rev | 0);
    return e <= 2 ? { ok: true, v: bitReverse32(this.ecc.out >>> 0) } : { ok: false, v };
  }
  private decodeFiw(): boolean {
    const r = this.bchFix(this.fiwRaw);
    if (!r.ok) return false;
    const f = r.v;
    this.cycleNo = (f >>> 4) & 0xF; this.frameNo = (f >>> 8) & 0x7F;
    let cs = (f & 0xF) + ((f >>> 4) & 0xF) + ((f >>> 8) & 0xF) + ((f >>> 12) & 0xF) + ((f >>> 16) & 0xF) + ((f >>> 20) & 1);
    return (cs & 0xF) === 0xF;
  }

  private readData(sym: number): boolean {
    const bitA = sym > 1 ? 1 : 0;
    const bitB = this.syncLevels === 4 && (sym === 1 || sym === 2) ? 1 : 0;
    if (this.syncBaud === 1600) this.phaseToggle = 0;
    const idx = ((this.dataBitCounter >>> 5) & 0xFFF8) | (this.dataBitCounter & 7);
    if (idx >= 88) return false;
    const [A, B, C, D] = this.ph;
    if (this.phaseToggle === 0) {
      A[idx] = (A[idx] >>> 1) | (bitA ? 0x80000000 : 0);
      B[idx] = (B[idx] >>> 1) | (bitB ? 0x80000000 : 0);
      this.phaseToggle = 1;
      if ((this.dataBitCounter & 0xFF) === 0xFF) {
        if (A[idx] === 0 || A[idx] === 0xFFFFFFFF) this.idle[0]++;
        if (B[idx] === 0 || B[idx] === 0xFFFFFFFF) this.idle[1]++;
      }
    } else {
      C[idx] = (C[idx] >>> 1) | (bitA ? 0x80000000 : 0);
      D[idx] = (D[idx] >>> 1) | (bitB ? 0x80000000 : 0);
      this.phaseToggle = 0;
      if ((this.dataBitCounter & 0xFF) === 0xFF) {
        if (C[idx] === 0 || C[idx] === 0xFFFFFFFF) this.idle[2]++;
        if (D[idx] === 0 || D[idx] === 0xFFFFFFFF) this.idle[3]++;
      }
    }
    if (this.syncBaud === 1600 || this.phaseToggle === 0) this.dataBitCounter++;
    const t = IDLE_THRESHOLD, id = this.idle;
    if (this.syncBaud === 1600) return this.syncLevels === 2 ? id[0] > t : (id[0] > t && id[1] > t);
    return this.syncLevels === 2 ? (id[0] > t && id[2] > t) : (id[0] > t && id[1] > t && id[2] > t && id[3] > t);
  }

  private flexSym(sym: number): void {
    const rect = this.polarity ? 3 - sym : sym;
    switch (this.st) {
      case St.SYNC1: {
        const code = this.flexSync(sym);
        if (code) { this.decodeMode(code); this.st = St.FIW; } else this.st = St.SYNC1;
        this.fiwCount = 0; this.fiwRaw = 0;
        break;
      }
      case St.FIW: {
        this.fiwCount++;
        if (this.fiwCount >= 16) this.fiwRaw = ((this.fiwRaw >>> 1) | (rect > 1 ? 0x80000000 : 0)) >>> 0;
        if (this.fiwCount === 48) {
          if (this.decodeFiw()) { this.sync2Count = 0; this.sync2Shift = 0; this.sync2CPos = -1; this.sync2CinvPos = -1; this.baud = this.syncBaud; this.st = St.SYNC2; }
          else this.st = St.SYNC1;
        }
        break;
      }
      case St.SYNC2: {
        const bitA = rect > 1 ? 1 : 0;
        this.sync2Shift = ((this.sync2Shift << 1) | bitA) & 0xFFFF;
        this.sync2Count++;
        if (this.sync2Count >= 16) {
          if (popcount32(this.sync2Shift ^ 0xED84) <= 2 && this.sync2CPos < 0) this.sync2CPos = this.sync2Count;
          if (popcount32(this.sync2Shift ^ 0x127B) <= 2 && this.sync2CinvPos < 0) this.sync2CinvPos = this.sync2Count;
        }
        const nominal = Math.floor(this.syncBaud * 25 / 1000);
        let end = nominal;
        if (this.sync2CinvPos > 0) { const diff = this.sync2CinvPos - nominal; if (diff >= -1 && diff <= 1) end = this.sync2CinvPos; }
        if (this.sync2Count === end) {
          for (const p of this.ph) p.fill(0);
          this.idle.fill(0); this.phaseToggle = 0; this.dataBitCounter = 0; this.dataCount = 0;
          this.sync2Shift = 0; this.sync2CPos = -1; this.sync2CinvPos = -1;
          this.st = St.DATA;
        }
        if (this.sync2Count > nominal + 1) { this.sync2Shift = 0; this.sync2CPos = -1; this.sync2CinvPos = -1; this.st = St.SYNC1; }
        break;
      }
      case St.DATA: {
        const idle = this.readData(rect);
        if (++this.dataCount === Math.floor(this.syncBaud * 1760 / 1000) || idle) {
          this.decodeData();
          this.baud = 1600; this.st = St.SYNC1; this.dataCount = 0;
        }
        break;
      }
    }
  }

  private decodeData(): void {
    this.frames++;
    if (this.syncBaud === 1600) { this.decodePhase(0); if (this.syncLevels === 4) this.decodePhase(1); }
    else if (this.syncLevels === 2) { this.decodePhase(0); this.decodePhase(2); }
    else for (let p = 0; p < 4; p++) this.decodePhase(p);
  }

  private packet(type: number, message: string, extra = ''): void {
    const bitrate = this.syncBaud * (this.syncLevels === 4 ? 2 : 1);
    const cap = String(this.capcode).padStart(10, '0');
    const at = ADDR_NAMES[this.addrType] ? ` ${ADDR_NAMES[this.addrType]}` : '';
    const pri = this.isPriority ? ' PRI' : '';
    this.emit({ type: 'packet', line: `FLEX ${bitrate}/${this.syncLevels}L C${this.cycleNo}F${String(this.frameNo).padStart(3, '0')} CAP ${cap}${at}${pri} ${TYPE_NAMES[type]}${extra}${message ? ': ' + message : ''}` });
  }

  private decodePhase(pi: number): void {
    const p = this.ph[pi];
    const phaseNo = 'ABCD'[pi];
    let allIdle = true;
    for (let i = 0; i < 88; i++) if (p[i] !== 0xFFFFFFFF && p[i] !== 0) { allIdle = false; break; }
    if (allIdle) return;
    const bad = new Uint8Array(88);
    for (let i = 0; i < 88; i++) {
      const r = this.bchFix(p[i]);
      if (!r.ok) { bad[i] = 1; p[i] = 0; } else p[i] = r.v;
      p[i] &= 0x001FFFFF;
    }
    if (bad[0]) return;
    const biw = p[0];
    if (biw === 0 || biw === 0x001FFFFF) return;
    const voffset = (biw >>> 10) & 0x3f;
    const aoffset = ((biw >>> 8) & 3) + 1;
    const prioCount = (biw >>> 4) & 0xF;
    if (voffset < aoffset || voffset >= 88) return;
    for (let bw = 1; bw < aoffset && bw < 88; bw++) {
      if (bad[bw]) continue;
      const w = p[bw], bt = (w >>> 4) & 7;
      if (bt === 1) this.emit({ type: 'log', line: `FLEX system date ${((w >>> 7) & 0x1F) + 1994}-${String((w >>> 17) & 0xF).padStart(2, '0')}-${String((w >>> 12) & 0x1F).padStart(2, '0')} (phase ${phaseNo})` });
      else if (bt === 2) this.emit({ type: 'log', line: `FLEX system time ${String((w >>> 7) & 0x1F).padStart(2, '0')}:${String((w >>> 12) & 0x3F).padStart(2, '0')} (phase ${phaseNo})` });
    }
    let nValidVecs = 0;
    for (let vi = 0; vi < voffset - aoffset; vi++) {
      const wi = voffset + vi; if (wi >= 88) break;
      const vw = p[wi];
      const cs = (vw & 0xF) + ((vw >>> 4) & 0xF) + ((vw >>> 8) & 0xF) + ((vw >>> 12) & 0xF) + ((vw >>> 16) & 0xF) + ((vw >>> 20) & 1);
      if ((cs & 0xF) === 0xF) nValidVecs = vi + 1;
    }
    if (voffset <= aoffset) return;
    let vecCount = 0, addrCount = 0;
    for (let i = aoffset; i < voffset; i++) {
      let j = voffset + vecCount;
      if (j >= 88) break;
      if (p[i] === 0 || p[i] === 0x001FFFFF) continue;
      this.isPriority = addrCount < prioCount ? 1 : 0;
      this.parseCapcode(p[i]);
      addrCount++;
      if (this.longAddress) {
        if (i + 1 >= voffset) break;
        const aw1 = p[i], aw2 = p[i + 1];
        if (aw2 === 0 || aw2 === 0x001FFFFF) { i++; addrCount++; vecCount += 2; continue; }
        let cap: number;
        if (aw1 >= 1 && aw1 <= 0x8000 && aw2 >= 0x1F7FFF && aw2 <= 0x1FFFFE) cap = aw1 + (0x1FFFFF - aw2) * 32768 + 2068480;
        else if (aw1 >= 1 && aw1 <= 0x8000 && aw2 >= 0x1E0001 && aw2 <= 0x1F0000) cap = aw1 + (aw2 - 1933312) * 32768 + 2068480;
        else if (aw1 >= 0x1F7FFF && aw1 <= 0x1FFFFE && aw2 >= 0x1E0001 && aw2 <= 0x1F0000) cap = (aw1 - 2064383) + (aw2 - 1867776) * 32768 + 2068479;
        else { i++; addrCount++; vecCount += 2; continue; }
        this.capcode = cap;
        i++; addrCount++;
        vecCount += 2;
        j = voffset + vecCount - 2;
      } else {
        if (this.capcode > 4297068542 || this.capcode <= 0) continue;
        if (vecCount >= nValidVecs) { if (this.capcode !== 1) this.packet(2, ''); continue; }
        vecCount++;
      }
      const viw = p[j];
      const typeVal = (viw >>> 4) & 7;
      this.dType = typeVal as PT;
      const mw1 = (viw >>> 7) & 0x7F;
      const len = (typeVal === 3 || typeVal === 4 || typeVal === 7) ? ((viw >>> 14) & 7) + 1 : (viw >>> 14) & 0x7F;
      const mw2 = mw1 + (len - 1);
      if (mw1 === 0 && mw2 === 0) continue;
      if (this.dType === PT.ALPHANUMERIC || this.dType === PT.SECURE) {
        if (mw1 > 87 || mw2 > 87) continue;
        if (this.longAddress) this.parseAlpha(p, bad, mw1 - 1, mw2 - 1); else this.parseAlpha(p, bad, mw1, mw2);
      } else if (this.dType === PT.STANDARD_NUMERIC || this.dType === PT.SPECIAL_NUMERIC || this.dType === PT.NUMBERED_NUMERIC) {
        this.parseNumeric(p, bad, j);
      } else if (this.dType === PT.TONE) {
        const t = (viw >>> 7) & 3, d = (viw >>> 9) & 0xFFF;
        let msg: string;
        if (t === 0 && d === 0xCCC && (!this.longAddress || j + 1 >= 88 || (p[j + 1] & 0xFFFFF) === 0xCCCCC)) msg = 'TONE';
        else if (t === 0) {
          msg = 'NUM ' + FLEX_BCD[d & 0xF] + FLEX_BCD[(d >>> 4) & 0xF] + FLEX_BCD[(d >>> 8) & 0xF];
          if (this.longAddress && j + 1 < 88) { const vy = p[j + 1]; for (let s = 0; s < 20; s += 4) msg += FLEX_BCD[(vy >>> s) & 0xF]; }
        } else if (t === 1) msg = `SRC ${d & 7}`;
        else if (t === 2) msg = `SRC ${d & 7} N=${(d >>> 3) & 0x3F} R=${(d >>> 9) & 1}`;
        else msg = `RESERVED ${hex(d, 3)}`;
        this.packet(8, msg);
      } else if (this.dType === PT.BINARY) {
        if (mw1 > 87 || mw2 > 87) continue;
        let f = 0, dataStart = mw1 + 1;
        if (!bad[mw1]) f = (p[mw1] >>> 13) & 3;
        if (f === 3 && mw1 + 1 <= mw2 && !bad[mw1 + 1]) dataStart = mw1 + 2;
        const parts: string[] = [];
        for (let w = dataStart; w <= mw2; w++) parts.push(bad[w] ? '??????' : hex(p[w] & 0x1FFFFF, 6));
        this.packet(6, parts.join(' '));
      } else if (this.dType === PT.SHORT_INSTRUCTION) {
        const d = (viw >>> 7) & 0x3FFF, it = d & 7;
        const msg = it === 0 ? `i=temp|slot=${(d >>> 10) & 0xF}|target=${(d >>> 3) & 0x7F}` : it === 1 ? `i=event|flags=${hex((d >>> 3) & 0x7FF, 3)}` : `i=rsvd|type=${it}|raw=${hex(d, 4)}`;
        this.packet(1, msg);
      }
    }
  }

  private parseCapcode(aw1: number): void {
    this.longAddress = 0; this.addrType = 0;
    if ((aw1 >= 1 && aw1 <= 0x8000) || (aw1 >= 0x1E0001 && aw1 <= 0x1F0000) || (aw1 >= 0x1F7FFF && aw1 <= 0x1FFFFE)) { this.longAddress = 1; this.addrType = 1; }
    else if (aw1 >= 0x1F7800 && aw1 <= 0x1F780F) this.addrType = 2;
    else if (aw1 >= 0x1F7810 && aw1 <= 0x1F781F) this.addrType = 3;
    else if (aw1 >= 0x1F6800 && aw1 <= 0x1F77FF) this.addrType = 4;
    else if (aw1 >= 0x1F2800 && aw1 <= 0x1F67FF) this.addrType = 5;
    else if ((aw1 >= 0x1F0001 && aw1 <= 0x1F27FF) || (aw1 >= 0x1F7820 && aw1 <= 0x1F7FFE)) this.addrType = 6;
    else if (aw1 >= 0x8001 && aw1 <= 0x1E0000) this.addrType = 0;
    else this.addrType = 7;
    this.capcode = aw1 - 0x8000;
  }

  private parseAlpha(p: Uint32Array, bad: Uint8Array, mw1In: number, mw2: number): void {
    let mw1 = mw1In;
    let frag = -1, more = 0, seq = 0;
    if (mw1 >= 0 && mw1 < 88 && !bad[mw1]) { const h = p[mw1]; more = (h >>> 10) & 1; frag = (h >>> 11) & 3; seq = (h >>> 13) & 0x3F; }
    mw1++;
    const chars: number[] = [];
    const put = (ch: number, isBad: boolean) => { if (isBad) chars.push(63); else if (ch >= 0x20 || ch === 0x0A || ch === 0x0D) chars.push(ch); else if (ch === 3 || ch === 0) chars.push(3); };
    for (let i = mw1; i <= mw2; i++) {
      const dw = p[i], isBad = !(i >= 0 && i < 88) || bad[i] === 1;
      if (i > mw1) put(dw & 0x7F, isBad);
      put((dw >>> 7) & 0x7F, isBad);
      put((dw >>> 14) & 0x7F, isBad);
    }
    let last = -1;
    for (let k = 0; k < chars.length; k++) if (chars[k] !== 3) last = k;
    let msg = '';
    for (let k = 0; k <= last; k++) msg += chars[k] === 3 ? '?' : String.fromCharCode(chars[k]);
    const flags = frag >= 0 ? (frag === 3 ? (more ? ` (1/… #${seq})` : '') : ` (cont ${frag} #${seq}${more ? ' …' : ''})`) : '';
    this.packet(this.dType === PT.SECURE ? 0 : 5, msg, flags);
  }

  private parseNumeric(p: Uint32Array, bad: Uint8Array, j: number): void {
    const isNnum = this.dType === PT.NUMBERED_NUMERIC;
    let w1 = p[j] >>> 7;
    let w2 = w1 >>> 7;
    w1 &= 0x7F;
    const nField = w2 & 7;
    w2 = nField + w1;
    if (w1 > 87) return;
    if (w2 > 87) w2 = 87;
    const body0 = this.longAddress && nField > 0 ? j + 1 : w1;
    if (body0 < 0 || body0 >= 88) return;
    let dw = p[body0];
    let digit = 0, count = 4 + (isNnum ? 10 : 2);
    let msg = '';
    if (bad[body0]) { let lost = Math.floor((21 - (count - 4)) / 4); while (lost-- > 0) msg += '?'; count = 4; digit = 0; }
    else {
      for (let k = 0; k < 21; k++) {
        digit = (digit >>> 1) & 0xF; if (dw & 1) digit ^= 8; dw >>>= 1;
        if (--count === 0) { msg += FLEX_BCD[digit]; count = 4; }
      }
    }
    const start = this.longAddress ? w1 : w1 + 1;
    const end = this.longAddress ? w1 + nField - 1 : w2;
    for (let i = start; i <= end && i < 88; i++) {
      if (bad[i]) { msg += '?????'; count = 4; digit = 0; continue; }
      dw = p[i];
      for (let k = 0; k < 21; k++) {
        digit = (digit >>> 1) & 0xF; if (dw & 1) digit ^= 8; dw >>>= 1;
        if (--count === 0) { msg += FLEX_BCD[digit]; count = 4; }
      }
    }
    msg = msg.replace(/ +$/, '');
    this.packet(this.dType === PT.SPECIAL_NUMERIC ? 4 : isNnum ? 7 : 3, msg);
  }
}
