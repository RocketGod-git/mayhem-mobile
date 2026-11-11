/**
 * ERT utility-meter receiver (Mayhem proc_ert + ert_packet.cpp, rtlamr; twin of the iOS/Kotlin ErtDecoder): Itron
 * SCM / SCM+ / IDM packets, OOK Manchester around 912 MHz: 32768 chips a second, two chips a bit (16384 bits a
 * second). Like Mayhem, it works on chips: every edge sits on a chip boundary, so the clock has one place to lock (on
 * bits, a run of equal bits has edges at the boundary and mid-bit alike and the clock can sit half a bit off). The
 * preambles are matched on chips with one chip wrong allowed, then each chip pair is a bit (the louder chip first =
 * 1). SCM and SCM+/IDM are hunted at the same time, each with its own buffer. Neptune R900 water meters ride the
 * same chip clock.
 */
import { popcount32, type Emit, type IqProcessor } from './core.js';

/** A reading that passed its check: kind (SCM, SCM+, IDM, R900), meter id, commodity, consumption, other fields. */
export type ErtReading = (kind: string, id: number, commodity: string, consumption: number, fields: [string, string][]) => void;

/** Bits as Manchester chips (1 -> 10, 0 -> 01), oldest first in the high bits; returned as [high 32, low 32]. */
function manchester(v: number, nBits: number): [number, number] {
  let hi = 0, lo = 0;
  for (let k = 0; k < nBits; k++) {
    const b = Math.floor(v / 2 ** (nBits - 1 - k)) & 1;
    for (const c of b === 1 ? [1, 0] : [0, 1]) { hi = ((hi << 1) | (lo >>> 31)) >>> 0; lo = ((lo << 1) | c) >>> 0; }
  }
  return [hi, lo];
}
// Mayhem's: the tail of SCM's 0x1F2A60 (32 chips), SCM+'s 0x16A3 (32), IDM's 0x5516A3 (48)
const SCM_SYNC = manchester(0x2A60, 16);
const PLUS_SYNC = manchester(0x16A3, 16);
const IDM_SYNC = manchester(0x5516A3, 24);
/** Neptune R900 (water): 32 chips of preamble, sent as chips (on = 1), at the same 32768 chips a second as ERT. */
const R900_SYNC = 0b00000000000000001110010101100100;

// ---- Neptune R900 (rtlamr's layout): 42 base-6 digits, each a balanced 4-chip word, two digits a 5-bit symbol,
// 16 data symbols and 5 Reed-Solomon parity symbols over GF(32) (x^5 + x^2 + 1, roots a^29..a^33) ----
const gfExp: number[] = (() => { const e = new Array<number>(64).fill(0); let x = 1; for (let i = 0; i < 31; i++) { e[i] = x; x <<= 1; if (x & 32) x ^= 37; } for (let i = 31; i < 64; i++) e[i] = e[i - 31]; return e; })();
const gfLog: number[] = (() => { const l = new Array<number>(32).fill(0); for (let i = 0; i < 31; i++) l[gfExp[i]] = i; return l; })();
const gfMul = (a: number, b: number) => a === 0 || b === 0 ? 0 : gfExp[(gfLog[a] + gfLog[b]) % 31];

export class ErtDecoder implements IqProcessor {
  /** Mayhem's rate: 128 samples a chip. A radio that cannot take it (RTL-SDR) runs the engine's 2 Msps. */
  static readonly RATE = 4_194_304;
  static readonly CHIP_RATE = 32_768;
  /** Every reading that passed its check (the Meters app's cards). */
  onReading: ErtReading | null = null;

  private spc = 61;
  private smoothK = 0.06;
  private smooth = 0;
  private phase = 0;
  private cSum = 0; private cN = 0;
  private envMax = 10; private envMin = 0;
  private lastAbove = false;
  private dcI = 0; private dcQ = 0;
  /** The last 64 hard chips, newest in bit 0 of `lo`. */
  private hi = 0; private lo = 0;
  /** Chip energies since a preamble: SCM's and SCM+/IDM's, two a bit. */
  private readonly scmE = new Float32Array(150); private scmCount = -1;
  private readonly plusE = new Float32Array(1408); private plusCount = -1;
  private idmCandidate = false;
  private readonly scm = new Uint8Array(75);
  private readonly plus = new Uint8Array(704);
  private readonly r9E = new Float32Array(168); private r9Count = -1;

  constructor(private readonly emit: Emit) {}

  reset(rate: number): void {
    this.spc = rate / ErtDecoder.CHIP_RATE;
    this.smoothK = 1 / Math.max(1, this.spc / 4);   // time constant a quarter of a chip
    this.smooth = 0; this.phase = 0; this.cSum = 0; this.cN = 0; this.envMax = 10; this.envMin = 0; this.lastAbove = false;
    this.hi = 0; this.lo = 0; this.scmCount = -1; this.plusCount = -1; this.r9Count = -1;
  }

  onIq(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    if (nSamp === 0) return;
    // DC offset: track the buffer mean slowly (Mayhem averages the same way).
    let sI = 0, sQ = 0;
    for (let i = 0; i < nSamp; i++) { sI += iq[2 * i]; sQ += iq[2 * i + 1]; }
    this.dcI += 0.2 * (sI / nSamp - this.dcI); this.dcQ += 0.2 * (sQ / nSamp - this.dcQ);
    const inc = 1 / this.spc, k = this.smoothK, dcI = this.dcI, dcQ = this.dcQ;
    let smooth = this.smooth, phase = this.phase, cSum = this.cSum, cN = this.cN, lastAbove = this.lastAbove;
    for (let i = 0; i < nSamp; i++) {
      const iv = iq[2 * i] - dcI, qv = iq[2 * i + 1] - dcQ;
      const mag = Math.sqrt(iv * iv + qv * qv);
      smooth += (mag - smooth) * k;
      const above = smooth > (this.envMax + this.envMin) * 0.5;
      if (above !== lastAbove) {
        // An edge sits on a chip boundary; the smoothing has delayed it about a quarter chip.
        let p = phase - 0.25;
        if (p < 0) p += 1;
        phase -= (p - Math.round(p)) * 0.1;
        if (phase < 0) phase += 1;
      }
      lastAbove = above;
      cSum += mag; cN++;
      phase += inc;
      if (phase >= 1) {
        phase -= 1;
        const e = cSum / Math.max(1, cN); cSum = 0; cN = 0;
        if (e > this.envMax) this.envMax = e; else this.envMax += (e - this.envMax) * 0.002;
        if (e < this.envMin) this.envMin = e; else this.envMin += (e - this.envMin) * 0.002;
        this.onChip(e, e > (this.envMax + this.envMin) * 0.5);
      }
    }
    this.smooth = smooth; this.phase = phase; this.cSum = cSum; this.cN = cN; this.lastAbove = lastAbove;
  }

  private near(want: [number, number] | number, nChips: number): boolean {
    if (typeof want === 'number') return popcount32(this.lo ^ want) <= 1;
    let d = popcount32((this.lo ^ want[1]) >>> 0);
    if (nChips > 32) d += popcount32(((this.hi ^ want[0]) & (2 ** (nChips - 32) - 1)) >>> 0);
    return d <= 1;
  }

  private onChip(e: number, on: boolean): void {
    this.hi = ((this.hi << 1) | (this.lo >>> 31)) >>> 0; this.lo = ((this.lo << 1) | (on ? 1 : 0)) >>> 0;
    if (this.scmCount >= 0) {
      this.scmE[this.scmCount++] = e;
      if (this.scmCount >= 150) { for (let j = 0; j < 75; j++) this.scm[j] = this.scmE[2 * j] > this.scmE[2 * j + 1] ? 1 : 0; this.checkScm(); this.scmCount = -1; }
    } else if (this.near(SCM_SYNC, 32)) this.scmCount = 0;
    if (this.plusCount >= 0) {
      this.plusE[this.plusCount++] = e;
      if (this.plusCount === 224 || this.plusCount === 1408) {
        for (let j = this.plusCount === 224 ? 0 : 112; j < this.plusCount / 2; j++) this.plus[j] = this.plusE[2 * j] > this.plusE[2 * j + 1] ? 1 : 0;
        if (this.plusCount === 224) { if (this.checkScmPlus()) this.plusCount = -1; }
        else { if (this.idmCandidate) this.checkIdm(); this.plusCount = -1; }
      }
    } else if (this.near(PLUS_SYNC, 32)) { this.plusCount = 0; this.idmCandidate = this.near(IDM_SYNC, 48); }
    if (this.r9Count >= 0) {
      this.r9E[this.r9Count++] = e;
      if (this.r9Count >= 168) { this.checkR900(); this.r9Count = -1; }
    } else if (this.near(R900_SYNC, 32)) this.r9Count = 0;
  }

  private static rd(buf: Uint8Array, start: number, len: number): number { let v = 0; for (let i = 0; i < len; i++) v = v * 2 + buf[start + i]; return v; }
  /** CRC over the first `n` bits, MSB-first, non-reflected. */
  static crc16(buf: Uint8Array, n: number, poly: number, init: number): number {
    let crc = init;
    for (let i = 0; i < n; i++) {
      const msb = (crc >> 15) & 1;
      crc = (crc << 1) & 0xFFFF;
      if (msb ^ buf[i]) crc ^= poly;
    }
    return crc & 0xFFFF;
  }
  private line(s: string): void { this.emit({ type: 'packet', line: s }); }

  private checkScm(): void {
    const b = this.scm, rd = ErtDecoder.rd;
    // BCH(255,239) poly 0x6F63 over the 5 trailing preamble zeros + 75 bits → leading zeros are a no-op.
    if (ErtDecoder.crc16(b, 75, 0x6F63, 0) !== 0) return;
    const id = rd(b, 0, 2) * 16777216 + rd(b, 35, 24), type = rd(b, 5, 4), cons = rd(b, 11, 24), tp = rd(b, 3, 2), te = rd(b, 9, 2);
    this.line(`SCM  ID ${String(id).padEnd(10)} ${commodity(type).padEnd(8)} cons ${cons} tamper p${tp}/e${te}`);
    this.onReading?.('SCM', id, commodity(type), cons, [['TAMPER', `physical ${tp} · encoder ${te}`], ['ERT TYPE', `${type}`]]);
  }
  private checkScmPlus(): boolean {
    const b = this.plus, rd = ErtDecoder.rd;
    if (ErtDecoder.crc16(b, 112, 0x1021, 0xFFFF) !== 0x1D0F) return false;
    const type = rd(b, 12, 4), id = rd(b, 16, 32), cons = rd(b, 48, 32), tamper = rd(b, 80, 16);
    this.line(`SCM+ ID ${String(id).padEnd(10)} ${commodity(type).padEnd(8)} cons ${cons} tamper 0x${tamper.toString(16).padStart(4, '0')}`);
    this.onReading?.('SCM+', id, commodity(type), cons, [['TAMPER', tamper.toString(16).toUpperCase().padStart(4, '0')], ['ERT TYPE', `${type}`]]);
    return true;
  }
  private checkIdm(): void {
    const b = this.plus, rd = ErtDecoder.rd;
    if (ErtDecoder.crc16(b, 704, 0x1021, 0xFFFF) !== 0x1D0F) return;
    const type = rd(b, 36, 4), id = rd(b, 40, 32), cons = rd(b, 200, 32);
    this.line(`IDM  ID ${String(id).padEnd(10)} ${commodity(type).padEnd(8)} cons ${cons}`);
    this.onReading?.('IDM', id, commodity(type), cons, [['ERT TYPE', `${type}`]]);
  }

  /** The 31-symbol codeword (16 data, 10 zeros, 5 parity) has a zero syndrome at a^29..a^33, read either way round. */
  static r900Valid(sym: number[]): boolean {
    const cw = new Array<number>(31).fill(0);
    for (let i = 0; i < 16; i++) cw[i] = sym[i];
    for (let i = 0; i < 5; i++) cw[26 + i] = sym[16 + i];
    for (const rev of [false, true]) {
      let ok = true;
      for (let j = 0; j < 5 && ok; j++) {
        const root = gfExp[(29 + j) % 31];
        let s = 0;
        for (let i = 0; i < 31; i++) s = gfMul(s, root) ^ (rev ? cw[30 - i] : cw[i]);   // Horner: highest power first
        if (s !== 0) ok = false;
      }
      if (ok) return true;
    }
    return false;
  }
  /** Digits from chip energies: each 4-chip word against 1100, 1010, 1001 (and their inverses by sign). */
  static r900Symbols(e: ArrayLike<number>): number[] | null {
    const digits: number[] = [], sym: number[] = [];
    for (let k = 0; k < 42; k++) {
      const c0 = e[4 * k], c1 = e[4 * k + 1], c2 = e[4 * k + 2], c3 = e[4 * k + 3];
      const a = [c0 + c1 - c2 - c3, c0 - c1 + c2 - c3, c0 - c1 - c2 + c3];
      let best = 0;
      for (let i = 1; i < 3; i++) if (Math.abs(a[i]) > Math.abs(a[best])) best = i;
      digits.push(best + (a[best] > 0 ? 3 : 0));
    }
    for (let i = 0; i < 21; i++) { const v = digits[2 * i] * 6 + digits[2 * i + 1]; if (v > 31) return null; sym.push(v); }
    return sym;
  }
  /** A decoded R900 packet: meter id, consumption, the other fields and the log line, or null if the chips do not check out. */
  static decodeR900(e: ArrayLike<number>): { id: number; cons: number; fields: [string, string][]; line: string } | null {
    const sym = ErtDecoder.r900Symbols(e);
    if (!sym || !ErtDecoder.r900Valid(sym)) return null;
    const bits: number[] = [];
    for (const s of sym.slice(0, 16)) for (let b = 4; b >= 0; b--) bits.push((s >> b) & 1);
    const f = (a: number, n: number) => { let v = 0; for (let i = a; i < a + n; i++) v = v * 2 + bits[i]; return v; };
    const id = f(0, 32), unkn1 = f(32, 8), noUse = f(40, 6), backflow = f(46, 2), cons = f(48, 24);
    const unkn3 = f(72, 2), leak = f(74, 4), leakNow = f(78, 2);
    const line = `R900 ID ${String(id).padEnd(10)} water    cons ${cons} leak ${leak} now ${leakNow} backflow ${backflow} no-use ${noUse}`;
    return { id, cons, line, fields: [
      ['LEAK', `${ErtDecoder.r900Leak(leak)} (code ${leak})`],
      ['LEAKING NOW', leakNow === 0 ? 'no' : `yes (${leakNow})`],
      ['BACKFLOW', backflow === 0 ? 'none' : backflow === 1 ? 'low' : `high (${backflow})`],
      ['NO USE', noUse === 0 ? 'used recently' : `no-use code ${noUse} (longer without use as it rises)`],
      ['UNKNOWN', `${unkn1.toString(16).toUpperCase().padStart(2, '0')} · ${unkn3}`],
    ] };
  }
  /** The leak code: 0 is none; higher codes mean longer runs of continuous flow (Neptune does not publish the scale). */
  static r900Leak(v: number): string { return v === 0 ? 'none' : `continuous flow, level ${v} of 15`; }
  private checkR900(): void {
    const r = ErtDecoder.decodeR900(this.r9E);
    if (r) { this.line(r.line); this.onReading?.('R900', r.id, 'water', r.cons, r.fields); }
  }
}

function commodity(t: number): string {
  if ([4, 5, 7, 8].includes(t)) return 'electric';
  if ([2, 9, 12].includes(t)) return 'gas';
  if ([3, 11, 13].includes(t)) return 'water';
  return `type${t}`;
}
