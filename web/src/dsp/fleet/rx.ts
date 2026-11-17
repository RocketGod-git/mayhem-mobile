/**
 * One 12.5 kHz channel, from complex baseband to blocks: a differential-phase 4-level demodulator that serves
 * C4FM, CQPSK/LSM and DMR alike (the phase step across one symbol), symbol timing picked again for every block of
 * 480 symbols so a dropped sample costs one block, the P25 and DMR framers, and a Morse reader for CW IDs. No DOM.
 */
import { DMR_SYNC, P25_SYNC, isStatusPos, nidDecode, syncSigns, tsbkDecode, crc12Ok, dmrReadBurst, type DmrBurst } from './codes.js';

export const BAUD = 4800;
const BLOCK = 480;

/** Soft 4-level symbols (about ±1 / ±3) from complex samples. */
export class SymbolRx {
  onSymbol: (s: number) => void = () => undefined;
  readonly sps: number;
  private readonly D: number;
  private ri: Float32Array; private rq: Float32Array; private rp = 0;
  private buf = new Float32Array(0); private n = 0; private base = 0;
  private tNext = 0;
  private w = 0; private ph = 0;
  center = 0; level = 0;
  /** Eye opening of the last block: energy at the chosen phase over the mean of all phases. */
  eye = 1;
  envMean = 0; envVar = 0; power = 0;
  symbols = 0;
  constructor(readonly fs: number) {
    this.sps = fs / BAUD; this.D = Math.max(1, Math.round(this.sps));
    this.ri = new Float32Array(this.D); this.rq = new Float32Array(this.D);
    this.buf = new Float32Array(Math.ceil(this.sps * BLOCK * 2) + 64);
  }
  /** Coarse frequency correction (Hz) to start from. */
  setOffset(hz: number): void { this.w = -2 * Math.PI * hz / this.fs; }
  get offsetHz(): number { return -this.w * this.fs / (2 * Math.PI); }

  push(zi: Float32Array, zq: Float32Array, n: number): void {
    const D = this.D;
    let ph = this.ph, envM = this.envMean, envV = this.envVar, pw = this.power;
    for (let k = 0; k < n; k++) {
      const c = Math.cos(ph), s = Math.sin(ph);
      ph += this.w; if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
      const a = zi[k] * c - zq[k] * s, b = zi[k] * s + zq[k] * c;
      const pa = this.ri[this.rp], pb = this.rq[this.rp];
      this.ri[this.rp] = a; this.rq[this.rp] = b; if (++this.rp >= D) this.rp = 0;
      const re = a * pa + b * pb, im = b * pa - a * pb;
      const m2 = a * a + b * b, m = Math.sqrt(m2);
      pw += 0.0005 * (m2 - pw); envM += 0.0005 * (m - envM); envV += 0.0005 * ((m - envM) * (m - envM) - envV);
      if (this.n >= this.buf.length) this.compact();
      this.buf[this.n++] = Math.atan2(im, re);
    }
    this.ph = ph; this.envMean = envM; this.envVar = envV; this.power = pw;
    const need = Math.ceil(this.sps * (BLOCK + 2)) + 2;
    while (this.n >= need) this.block();
  }
  /** Envelope variation over its mean: near 0 for constant-envelope FM, about 0.3 for linear modulation. */
  get envCv(): number { return this.envMean > 0 ? Math.sqrt(Math.max(0, this.envVar)) / this.envMean : 0; }

  private compact(): void {
    const keep = Math.min(this.n, Math.ceil(this.sps * 4));
    this.buf.copyWithin(0, this.n - keep, this.n); this.base += this.n - keep; this.n = keep;
  }
  private at(t: number): number {
    const i = Math.floor(t), f = t - i;
    return this.buf[i] * (1 - f) + this.buf[Math.min(i + 1, this.n - 1)] * f;
  }
  private block(): void {
    const T = this.sps, len = BLOCK * T, buf = this.buf;
    let best = 0, bestE = -1, sumE = 0;
    for (let p = 0; p < 8; p++) {
      const off = p * T / 8;
      let e = 0;
      for (let k = 0; k < BLOCK; k++) { const x = this.at(off + k * T) - this.center; e += x * x; }
      sumE += e;
      if (e > bestE) { bestE = e; best = off; }
    }
    this.eye = sumE > 0 ? bestE / (sumE / 8) : 1;
    // continue the previous grid: the first symbol of this block is the one at least half a symbol after the last
    const t0 = this.tNext - this.base;
    let k0 = Math.ceil((t0 - T / 2 - best) / T); if (k0 < 0) k0 = 0;
    const vals: number[] = [];
    let t = best + k0 * T;
    for (; t < len; t += T) vals.push(this.at(t));
    this.tNext = this.base + t;
    // eye levels: the outer quarter of each side
    const sorted = Float32Array.from(vals).sort(), q = Math.max(1, Math.floor(sorted.length / 4));
    let lo = 0, hi = 0; for (let i = 0; i < q; i++) { lo += sorted[i]; hi += sorted[sorted.length - 1 - i]; } lo /= q; hi /= q;
    const c = (hi + lo) / 2, l = (hi - lo) / 2;
    if (l > 0.2) {
      this.center = this.level > 0 ? this.center + 0.5 * (c - this.center) : c;
      this.level = this.level > 0 ? this.level + 0.5 * (l - this.level) : l;
      // the AFC takes the center out, so the phase steps stay clear of the ±π wrap
      this.w -= 0.5 * this.center / this.D; this.center *= 0.5;
      const lim = 2 * Math.PI * 2500 / this.fs; if (this.w > lim) this.w = lim; else if (this.w < -lim) this.w = -lim;
    }
    const sc = this.level > 0 ? 3 / this.level : 1;
    for (const v of vals) { this.symbols++; this.onSymbol((v - this.center) * sc); }
    const used = Math.floor(len);
    buf.copyWithin(0, used, this.n); this.n -= used; this.base += used;
  }
}

export const slice = (s: number) => s > 2 ? 1 : s > 0 ? 0 : s > -2 ? 2 : 3;

/** Normalized correlation of the last 24 symbols against a sign pattern. */
class SyncMatch {
  private readonly ring = new Float32Array(24); private p = 0;
  push(s: number): void { this.ring[this.p] = s; this.p = (this.p + 1) % 24; }
  corr(sig: Int8Array): number {
    let c = 0, a = 0;
    for (let k = 0; k < 24; k++) { const x = this.ring[(this.p + k) % 24]; c += x * sig[k]; a += x < 0 ? -x : x; }
    return a > 0 ? c / a : 0;
  }
  /** Mean magnitude of the window: a sync is all outer symbols. */
  mag(): number { let a = 0; for (let k = 0; k < 24; k++) a += Math.abs(this.ring[k]); return a / 24; }
}

export interface P25Block { nac: number; nidErrs: number; bytes: Uint8Array; crcOk: boolean; metric: number; index: number }
const P25S = syncSigns(P25_SYNC);

/** P25 Phase 1: frame sync, NID, status symbols out, trunking blocks through the trellis and CRC. */
export class P25Framer {
  onBlock: (b: P25Block) => void = () => undefined;
  /** Any frame with a valid NID (voice and data frames too): the NAC and DUID. */
  onFrame: (nac: number, duid: number) => void = () => undefined;
  private readonly sm = new SyncMatch();
  private state: 'idle' | 'nid' | 'body' | 'skip' = 'idle';
  private pos = 0; private buf = new Uint8Array(400); private nb = 0; private want = 0;
  private nac = -1; private nidErrs = 0; private blk = 0; private flywheel = 0;
  readonly nacs = new Set<number>();
  syncs = 0; frames = 0;
  push(s: number): void {
    this.sm.push(s);
    if (this.state !== 'body' && this.state !== 'nid' && this.sm.corr(P25S) > 0.82 && this.sm.mag() > 1.8) {
      this.syncs++; this.begin(); return;
    }
    if (this.state === 'idle') return;
    const pos = this.pos++;
    if (isStatusPos(pos)) return;
    // frame positions run on across frames (360 symbols, a multiple of 36): the next sync ends at 360 + 23
    if (this.state === 'skip') { if (pos >= 383) { this.state = 'nid'; this.pos = 24; this.nb = 0; this.want = 32; } return; }
    this.buf[this.nb++] = slice(s);
    if (this.nb < this.want) return;
    if (this.state === 'nid') this.nid(); else this.body();
  }
  private begin(): void { this.state = 'nid'; this.pos = 24; this.nb = 0; this.want = 32; this.flywheel = 0; }
  private nid(): void {
    const r = nidDecode(this.buf, this.nacs);
    if (!r) { this.state = 'idle'; return; }
    this.frames++; this.nac = r.nac; this.nidErrs = r.errs;
    if (r.errs <= 4) { this.nacs.add(r.nac); if (this.nacs.size > 6) this.nacs.delete(this.nacs.values().next().value as number); }
    this.onFrame(r.nac, r.duid);
    if (r.duid === 7) { this.state = 'body'; this.nb = 0; this.want = 98; this.blk = 0; }
    else this.state = 'idle';
  }
  private body(): void {
    const { bytes, metric } = tsbkDecode(this.buf);
    const ok = crc12Ok(bytes);
    this.onBlock({ nac: this.nac, nidErrs: this.nidErrs, bytes, crcOk: ok, metric, index: this.blk });
    this.blk++;
    if (this.blk >= 3 || (ok && (bytes[0] & 0x80))) {
      // frames run back to back: carry the clock across the next sync, at most a few frames without one
      if (this.blk >= 3 && this.flywheel < 4) { this.flywheel++; this.state = 'skip'; }
      else this.state = 'idle';
      return;
    }
    this.nb = 0; this.want = 98;
  }
}

export interface DmrEvent { burst: DmrBurst; dibits: Uint8Array }
const DMR_BS_DATA = syncSigns(DMR_SYNC.bsData), DMR_BS_VOICE = syncSigns(DMR_SYNC.bsVoice), DMR_MS_DATA = syncSigns(DMR_SYNC.msData), DMR_MS_VOICE = syncSigns(DMR_SYNC.msVoice);

/** DMR base-station bursts: sync, CACH slot, slot type, BPTC. Voice syncs are only counted. */
export class DmrFramer {
  onBurst: (e: DmrEvent) => void = () => undefined;
  private readonly sm = new SyncMatch();
  private readonly hist = new Uint8Array(144); private hp = 0;
  private pending = -1;
  syncs = 0; voice = 0; ms = 0;
  push(s: number): void {
    this.sm.push(s);
    this.hist[this.hp] = slice(s); this.hp = (this.hp + 1) % 144;
    if (this.pending > 0 && --this.pending === 0) this.emit();
    if (this.pending > 0) return;
    if (this.sm.mag() < 1.8) return;
    if (this.sm.corr(DMR_BS_DATA) > 0.82) { this.syncs++; this.pending = 54; }
    else if (this.sm.corr(DMR_BS_VOICE) > 0.82) { this.syncs++; this.voice++; }
    else if (this.sm.corr(DMR_MS_DATA) > 0.82 || this.sm.corr(DMR_MS_VOICE) > 0.82) this.ms++;
  }
  private emit(): void {
    const d = new Uint8Array(144);
    for (let i = 0; i < 144; i++) d[i] = this.hist[(this.hp + i) % 144];
    const b = dmrReadBurst(d);
    if (b) this.onBurst({ burst: b, dibits: d });
  }
}

const MORSE: Record<string, string> = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M',
  '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9', '-..-.': '/',
};
/** A station ID: a letter prefix, digits, an optional letter suffix (W1AW, KA6XYZ, WQAB123, AB1CD/R). */
export const looksLikeCallsign = (s: string) => /^[A-Z]{1,4}\d{1,4}[A-Z]{0,4}(\/[A-Z0-9]{1,3})?$/.test(s) && s.length >= 4;

/**
 * CW ID on an FM carrier: the discriminator's tone keyed on and off, read in 5 ms steps. A run of key-down
 * lengths becomes dots and dashes against the shortest mark; a pause of 0.4 s or the carrier dropping ends it.
 */
export class CwReader {
  onText: (text: string) => void = () => undefined;
  private pi = 0; private pq = 0; private acc = 0; private zc = 0; private prev = 0; private cnt = 0;
  private hp = 0; private floor = 0; private peak = 0;
  private runs: [boolean, number][] = []; private on = false; private len = 0;
  private readonly step: number;
  constructor(private readonly fs: number) { this.step = Math.max(8, Math.round(fs * 0.005)); }
  reset(): void { this.runs = []; this.on = false; this.len = 0; this.peak = 0; }
  push(zi: Float32Array, zq: Float32Array, n: number): void {
    for (let k = 0; k < n; k++) {
      const a = zi[k], b = zq[k];
      const f = Math.atan2(b * this.pi - a * this.pq, a * this.pi + b * this.pq);
      this.pi = a; this.pq = b;
      this.hp += 0.02 * (f - this.hp);
      const x = f - this.hp;
      this.acc += x * x;
      if ((x > 0) !== (this.prev > 0)) this.zc++;
      this.prev = x;
      if (++this.cnt >= this.step) this.window();
    }
  }
  private window(): void {
    const p = this.acc / this.cnt, hz = this.zc * this.fs / (2 * this.cnt);
    this.acc = 0; this.zc = 0; this.cnt = 0;
    this.floor = this.floor === 0 ? p : p < this.floor ? this.floor + 0.2 * (p - this.floor) : this.floor + 0.002 * (p - this.floor);
    this.peak = Math.max(p, this.peak * 0.999);
    const key = p > 4 * this.floor && p > 0.4 * this.peak && hz > 300 && hz < 3000;
    if (key === this.on) this.len++;
    else { if (this.len > 0) this.runs.push([this.on, this.len]); this.on = key; this.len = 1; }
    if (!this.on && this.len === 80 && this.runs.length) this.finish();
    if (this.runs.length > 400) this.runs.splice(0, 200);
  }
  /** The carrier went away: whatever was keyed is complete. */
  end(): void { if (this.len > 0) this.runs.push([this.on, this.len]); this.on = false; this.len = 0; if (this.runs.length) this.finish(); }
  private finish(): void {
    const merged: [boolean, number][] = [];
    for (const [o, n] of this.runs) {
      if (n < 3 && merged.length) { merged[merged.length - 1][1] += n; continue; }
      if (merged.length && merged[merged.length - 1][0] === o) merged[merged.length - 1][1] += n; else merged.push([o, n]);
    }
    this.runs = [];
    while (merged.length && !merged[0][0]) merged.shift();
    const marks = merged.filter(r => r[0]).map(r => r[1]);
    if (marks.length < 4) return;
    const sorted = [...marks].sort((a, b) => a - b), unit = sorted[Math.floor(sorted.length * 0.2)];
    // keyed Morse: every mark is a dot or a dash, one unit or three
    const clean = marks.filter(m => { const u = m / unit; return (u > 0.6 && u < 1.6) || (u > 2.2 && u < 4); }).length;
    if (clean < marks.length * 0.85) return;
    let txt = '';
    for (const [o, n] of merged) { const u = n / unit; txt += o ? (u < 2 ? '.' : '-') : (u < 2 ? '' : u < 5 ? ' ' : ' / '); }
    const text = txt.split('/').map(w => w.trim().split(/\s+/).map(c => MORSE[c] ?? '?').join('')).join(' ').trim();
    if (text) this.onText(text);
  }
}
