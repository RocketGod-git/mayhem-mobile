/**
 * Cell: LTE broadcast information and emergency alerts, receive only. Captures blocks of the downlink, finds cells
 * (PSS/SSS), reads the MIB from the central 6 RBs (any radio at 1.92 MS/s or more), and with the whole carrier in the
 * span decodes SI-RNTI traffic only: SIB1 and the SI messages (SIB2 to SIB24, ETWS and CMAS in SIB10/11/12).
 * The next block is placed on the next SI window still wanted, from the SFN timing of the last block.
 * Paging and every other RNTI are left alone.
 */
import { fft, hann } from '../../fft.js';
import type { Emit, IqProcessor } from '../core.js';
import { Numerology, Grid, chanEst, crsSeq, crsShift, ofdmDemod, bitsToBytes, hexOf, NRB_MAX } from './common.js';
import { LOW, LOW_FS, decimate, decimDelay, cpCfo, rotate, pssSearch, halfFrameMap, sssIdentify, type HalfFrame } from './sync.js';
import { decodeMib, type Mib } from './pbch.js';
import { ControlDecoder } from './pdcch.js';
import { allocation, tbsSi, pdschLlr, TbDecoder } from './pdsch.js';
import { decodeBcchDlSch, messageParts, hexToBytes } from './rrc.js';
import { sib1Summary, neighbors, sib2Summary, sib3Summary, sib8Time, earfcnDl, dlEarfcnForMhz, type Sib1Summary, type Neighbors, type Sib2Summary, type Sib3Summary } from './sysinfo.js';
import { WarningAssembler, type WarningMessage } from './cbs.js';
import { bandOf } from './bands.js';

type Obj = Record<string, unknown>;
export interface SibRec { name: string; si: number; ms: number; count: number; hex: string; value: Obj }
export interface LogRow { ms: number; hz: number; pci: number; kind: string; text: string; hex: string }
export interface CellRow {
  key: string; hz: number; pci: number; earfcn: number | null; band: number | null; tdd: boolean;
  firstMs: number; lastMs: number; mibMs: number; sib1Ms: number;
  mib: Mib | null; nrb: number; ports: number; sfn: number;
  snrDb: number; levelDb: number; cfoHz: number; pssScore: number;
  mibCount: number; sib1Count: number; dciCount: number; tbOk: number; tbFail: number;
  summary: Sib1Summary | null; sib2: Sib2Summary | null; sib3: Sib3Summary | null; neighbors: Neighbors | null;
  time: { gpsIso: string; utcIso: string } | null;
  sibs: { name: string; si: number; ms: number; count: number }[];
  si: { si: number; periodicity: number; sibs: string[]; ms: number; count: number }[];
  fullBand: boolean; complete: boolean; alerts: number;
}
export interface Occupied { loHz: number; hiHz: number }
export interface CellSnap {
  type: 'cell'; centerHz: number; rate: number; full: boolean; maxRb: number;
  lte: boolean; cpStrength: number; blocks: number; searching: boolean; lastBlockMs: number; nextMs: number; cpuMs: number;
  profile: { lo: number; step: number; db: number[] } | null; floorDb: number;
  cells: CellRow[]; alerts: WarningMessage[]; log: LogRow[]; dci: number; tbOk: number;
  pss: { nid2: number; score: number }[];
}
export interface CellState { v: 1; cells: Obj[]; alerts: WarningMessage[]; log: LogRow[] }

interface Cell {
  key: string; hz: number; pci: number; band: number | null; earfcn: number | null; tdd: boolean;
  firstMs: number; lastMs: number; mibMs: number; sib1Ms: number;
  mib: Mib | null; snrDb: number; levelDb: number; cfoHz: number; pssScore: number;
  mibCount: number; sib1Count: number; dciCount: number; tbOk: number; tbFail: number;
  sib1: Obj | null; sib1Hex: string; summary: Sib1Summary | null;
  sibs: Map<string, SibRec>; siGot: Map<number, { ms: number; count: number }>;
  /** Absolute sample index of the start of a frame and its SFN, at the current rate. */
  timing: { abs: number; sfn: number } | null;
  ctl: ControlDecoder[]; pending: Map<string, { tb: TbDecoder; G: number; epoch: number }>;
}

const BLOCK_MS = 40;
const DUPLEX_PSS = (num: Numerology, tdd: boolean) => { if (!tdd) return num.pssOffset; const [o, cp] = num.symbol(2); return num.subframe + o + cp; };
const sssLag = (num: Numerology, tdd: boolean) => tdd ? 3 * num.nfft + 2 * num.cpn + num.cp0 : num.nfft + num.cpn;

export class CellProcessor implements IqProcessor {
  centerHz = 0;
  now: () => number = () => Date.now();
  readonly cells = new Map<string, Cell>();
  readonly warnings = new WarningAssembler();
  readonly log: LogRow[] = [];
  /** Bumped whenever something worth keeping changes (the page saves the state when it moves). */
  version = 0;
  /** Called with every new or completed warning message. */
  onAlert: ((m: WarningMessage) => void) | null = null;
  /** Live radio: skip input in proportion to the CPU a block took. Off for recordings, which wait for the decoder. */
  realtime = true;
  private rate = 0; private D = 0; private num = new Numerology(LOW_FS);
  private abs = 0; private capStart = 0; private capN = 0; private capLen = 0;
  private xr = new Float32Array(0); private xi = new Float32Array(0);
  private lastCenter = NaN; private cfo = 0; private cfoKnown = false;
  private blocks = 0; private lastBlockMs = 0; private cpuMs = 0; private lte = false; private cpStrength = 0; private dci = 0; private tbOk = 0;
  private profile: CellSnap['profile'] = null; private floorDb = 0; private pss: { nid2: number; score: number }[] = [];
  private lastPost = 0; private dirty = false; private nextAbs = 0;
  private readonly specRe = new Float32Array(1024); private readonly specIm = new Float32Array(1024); private readonly win = hann(1024);

  constructor(private readonly emit: Emit | null) {}

  reset(rate: number): void {
    this.rate = rate;
    this.D = rate / LOW_FS;
    this.num = new Numerology(Number.isInteger(this.D) ? rate : LOW_FS);
    this.capLen = Math.round(rate * BLOCK_MS / 1000);
    this.xr = new Float32Array(this.capLen); this.xi = new Float32Array(this.capLen);
    this.abs = 0; this.capN = 0; this.capStart = 0; this.nextAbs = 0;
    for (const c of this.cells.values()) { c.timing = null; c.pending.clear(); }
    this.post(true);
  }
  /** The widest carrier (RBs) the current rate holds with margin for the radio's filter edges. */
  /** Absolute sample index where the next block starts (or the one being filled started), and its length. */
  get capture(): { start: number; len: number; filling: boolean } { return { start: this.capN ? this.capStart : this.nextAbs, len: this.capLen, filling: this.capN > 0 }; }
  get maxRb(): number { if (!Number.isInteger(this.D)) return 0; const k = 0.9 * this.num.nfft; return [100, 75, 50, 25, 15, 6].find(n => 12 * n <= k) ?? 0; }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    if (this.centerHz !== this.lastCenter) {
      this.lastCenter = this.centerHz; this.capN = 0; this.nextAbs = this.abs; this.cfoKnown = false;
      for (const c of this.cells.values()) { c.timing = null; c.pending.clear(); }
    }
    const n = iq.length >> 1;
    let k = 0;
    while (k < n) {
      if (this.capN === 0 && this.abs + (n - k) <= this.nextAbs) { this.abs += n - k; break; }
      if (this.capN === 0) { const skip = Math.max(0, this.nextAbs - this.abs); k += skip; this.abs += skip; this.capStart = this.abs; }
      const take = Math.min(n - k, this.capLen - this.capN);
      for (let i = 0; i < take; i++) { this.xr[this.capN + i] = iq[2 * (k + i)] + 0.5; this.xi[this.capN + i] = iq[2 * (k + i) + 1] + 0.5; }
      this.capN += take; k += take; this.abs += take;
      if (this.capN === this.capLen) {
        this.capN = 0;
        const t0 = performance.now();
        try { this.block(this.capStart); } catch (e) { this.emit?.({ type: 'log', line: `cell: ${(e as Error).message}` }); }
        this.cpuMs = performance.now() - t0;
        // never take more of the stream than the worker keeps up with
        if (this.realtime) this.nextAbs = Math.max(this.nextAbs, this.abs + Math.round(this.rate * this.cpuMs / 1000 * 1.25));
      }
    }
    if (this.dirty || this.now() - this.lastPost > 1000) this.post();
  }

  // ---- one captured block ---------------------------------------------------------------------------------------
  private block(start: number): void {
    const now = this.now(), fs = this.rate, xr = this.xr, xi = this.xi;
    this.blocks++; this.lastBlockMs = now; this.dirty = true;
    this.spectrum(xr, xi);
    if (!Number.isInteger(this.D)) { this.nextAbs = this.abs + fs; return; }
    let [yr, yi] = decimate(xr, xi, fs);
    if (yr === xr) { yr = xr.slice(); yi = xi.slice(); }
    const cp = cpCfo(yr, yi, LOW_FS);
    this.cpStrength = cp.strength;
    const frac = this.cfoKnown ? this.cfo + ((((cp.hz - this.cfo + 7500) % 15000) + 15000) % 15000 - 7500) : cp.hz;
    rotate(yr, yi, frac, LOW_FS);
    const hits = pssSearch(yr, yi, 0, this.cfoKnown ? [0] : [0, -15_000, 15_000]).filter(h => h.score > 5.5);
    this.pss = hits.slice(0, 6).map(h => ({ nid2: h.nid2, score: Math.round(h.score * 10) / 10 }));
    this.lte = hits.length > 0;
    const found: { cell: Cell; map: HalfFrame[]; evenSf0: boolean; tdd: boolean; mibH: number }[] = [];
    const tried = new Set<number>();
    for (const h of hits.slice(0, 6)) {
      if (h.cfo) { rotate(yr, yi, h.cfo, LOW_FS); }
      const map = halfFrameMap(yr, yi, h.nid2, h.pos);
      if (map.length >= 3) {
        for (const tdd of [false, true]) {
          const cands = this.pciCandidates(yr, yi, h.nid2, map, tdd);
          for (const [pci, evenSf0] of cands) {
            if (tried.has(pci * 2 + Number(tdd))) continue;
            tried.add(pci * 2 + Number(tdd));
            const r = this.readMib(yr, yi, pci, map, evenSf0, tdd, this.cells.has(`${Math.round(this.centerHz / 1e5)}:${pci}`));
            if (!r) continue;
            const cell = this.cellFor(pci, tdd, now);
            cell.mib = r.mib; cell.mibMs = now; cell.lastMs = now; cell.mibCount++; cell.snrDb = r.snr; cell.levelDb = r.level; cell.cfoHz = frac + h.cfo; cell.pssScore = h.score;
            found.push({ cell, map, evenSf0, tdd, mibH: r.h });
            this.cfo = frac + h.cfo; this.cfoKnown = true;
          }
          if (found.some(f => f.map === map)) break;
        }
      }
      if (h.cfo) rotate(yr, yi, -h.cfo, LOW_FS);
    }
    if (!found.length) { this.cfoKnown = false; this.nextAbs = this.abs + Math.round(fs * 0.04); return; }
    // the whole carrier in the span: SI-RNTI traffic
    rotate(xr, xi, this.cfo, fs);
    for (const f of found) {
      const m = f.cell.mib!;
      if (m.bandwidth > this.maxRb) continue;
      this.readSi(f.cell, f.map, f.evenSf0, f.tdd, f.mibH, start, now);
    }
    this.schedule(found.map(f => f.cell));
  }

  private pciCandidates(yr: Float32Array, yi: Float32Array, nid2: number, map: HalfFrame[], tdd: boolean): [number, boolean][] {
    const sc = sssIdentify(yr, yi, nid2, map, 40, sssLag(LOW, tdd)), out: [number, boolean][] = [];
    for (const [nid1, even] of sc.slice(0, 3)) out.push([3 * nid1 + nid2, even]);
    for (const c of this.cells.values()) if (c.hz === this.centerHz && c.pci % 3 === nid2 && c.tdd === tdd && !out.some(o => o[0] === c.pci)) {
      const s0 = sc.find(x => x[0] === Math.floor(c.pci / 3) && x[1]), s1 = sc.find(x => x[0] === Math.floor(c.pci / 3) && !x[1]);
      out.push([c.pci, (s0?.[2] ?? 0) >= (s1?.[2] ?? 0)]);
    }
    return out;
  }

  /** CRS coherence and residual delay (samples) of ports 0/1, used to place the FFT on this PCI's own timing. */
  private crsTiming(g: Grid, sf: number, pci: number, nrb: number, nfft: number): { coh: number; tau: number; level: number } {
    let sr = 0, si = 0, den = 0, cnt = 0;
    const K = 12 * nrb;
    for (const p of [0, 1]) for (const l of [0, 4, 7, 11]) {
      const [rr, ri] = crsSeq(2 * sf + Math.floor(l / 7), l % 7, pci), s = crsShift(p, l, pci), M = 2 * nrb, off = NRB_MAX - nrb;
      let pr = 0, pi = 0;
      for (let m = 0; m < M; m++) {
        const k = 6 * m + s, yr = g.re[l * K + k], yi = g.im[l * K + k], cr = rr[m + off], ci = ri[m + off];
        const ar = yr * cr + yi * ci, ai = yi * cr - yr * ci;
        if (m) { sr += ar * pr + ai * pi; si += ai * pr - ar * pi; }
        den += ar * ar + ai * ai; cnt++; pr = ar; pi = ai;
      }
    }
    return { coh: Math.hypot(sr, si) / Math.max(den, 1e-12), tau: -Math.atan2(si, sr) / (2 * Math.PI * 6 / nfft), level: den / Math.max(cnt, 1) };
  }
  private demodAligned(xr: Float32Array, xi: Float32Array, startF: number, num: Numerology, nrb: number, sf: number, pci: number, backoff: number): { g: Grid; coh: number; level: number } | null {
    let g = ofdmDemod(xr, xi, startF, num, nrb, backoff);
    if (!g) return null;
    let t = this.crsTiming(g, sf, pci, nrb, num.nfft);
    if (Math.abs(t.tau) > 0.5) {
      const g2 = ofdmDemod(xr, xi, startF + Math.round(t.tau), num, nrb, backoff);
      if (g2) { const t2 = this.crsTiming(g2, sf, pci, nrb, num.nfft); if (t2.coh >= t.coh * 0.98) { g = g2; t = t2; } }
    }
    return { g, coh: t.coh, level: t.level };
  }

  /**
   * MIB from the sf0 half-frames of the map. A cell not heard before needs two frames that agree (bandwidth, ports
   * and SFN one frame apart per frame): a single 16-bit CRC pass among the many PCI hypotheses is not proof.
   */
  private readMib(yr: Float32Array, yi: Float32Array, pci: number, map: HalfFrame[], evenSf0: boolean, tdd: boolean, known: boolean): { mib: Mib; snr: number; level: number; h: number } | null {
    const off = DUPLEX_PSS(LOW, tdd), hits: { mib: Mib; snr: number; level: number; h: number }[] = [];
    let tries = 0;
    for (const hf of map) {
      if ((hf.h % 2 === 0) !== evenSf0) continue;
      if (++tries > 4) break;
      const d = this.demodAligned(yr, yi, hf.pos - off, LOW, 6, 0, pci, 1);
      if (!d) continue;
      const r = decodeMib(d.g, pci, 6);
      if (!r) { if (!known && tries >= 2 && !hits.length) break; continue; }
      const hit = { mib: r.mib, snr: 10 * Math.log10(Math.max(r.snr, 1e-6)), level: 10 * Math.log10(Math.max(d.level, 1e-12) / (128 * 128)), h: hf.h };
      if (known) return hit;
      const prev = hits.find(x => x.mib.bandwidth === r.mib.bandwidth && x.mib.ports === r.mib.ports && (x.mib.sfn + (hf.h - x.h) / 2) % 1024 === r.mib.sfn);
      if (prev) return prev;
      hits.push(hit);
    }
    return null;
  }

  private cellFor(pci: number, tdd: boolean, now: number): Cell {
    const hz = this.centerHz, key = `${Math.round(hz / 1e5)}:${pci}`;
    let c = this.cells.get(key);
    if (!c) {
      const b = bandOf(hz);
      c = { key, hz, pci, band: b ? b.bands[0] : null, earfcn: null, tdd, firstMs: now, lastMs: now, mibMs: 0, sib1Ms: 0, mib: null, snrDb: 0, levelDb: 0, cfoHz: 0, pssScore: 0,
        mibCount: 0, sib1Count: 0, dciCount: 0, tbOk: 0, tbFail: 0, sib1: null, sib1Hex: '', summary: null, sibs: new Map(), siGot: new Map(), timing: null, ctl: [], pending: new Map() };
      if (c.band) c.earfcn = dlEarfcnForMhz(c.band, hz / 1e6);
      this.cells.set(key, c);
      this.addLog(now, hz, pci, 'CELL', `new cell PCI ${pci}${tdd ? ' (TDD)' : ''}`, '');
    }
    return c;
  }

  /** SIB1 occasions and the wanted SI windows inside this block, for one cell whose MIB just decoded. */
  private readSi(cell: Cell, map: HalfFrame[], evenSf0: boolean, tdd: boolean, mibH: number, blockAbs: number, now: number): void {
    const mib = cell.mib!, nrb = mib.bandwidth, num = this.num, D = this.D, off = DUPLEX_PSS(num, tdd), delay = decimDelay(this.rate);
    if (!cell.ctl.length || cell.ctl[0].nrb !== nrb || cell.ctl[0].nports !== mib.ports)
      cell.ctl = (tdd ? [0, 1, 2] : [1]).map(mi => new ControlDecoder(cell.pci, nrb, mib.ports, mib.phichResource, tdd, mi));
    // SFN of each mapped half-frame from the frame whose MIB was read
    const sf0 = map.filter(h => (h.h % 2 === 0) === evenSf0);
    if (!sf0.length) return;
    const ref = sf0.find(h => h.h === mibH) ?? sf0[0], refSfn = mib.sfn;
    cell.timing = { abs: blockAbs + ref.pos * D + delay - off, sfn: refSfn };
    const sched = cell.summary?.schedule ?? [];
    for (const hf of map) {
      const isSf0 = (hf.h % 2 === 0) === evenSf0, frames = Math.floor((hf.h - ref.h - (isSf0 ? 0 : 1)) / 2), sfn = ((refSfn + frames) % 1024 + 1024) % 1024;
      const base = hf.pos * D + delay - off;
      for (let j = 0; j < 5; j++) {
        const sf = (isSf0 ? 0 : 5) + j, sib1 = sf === 5 && sfn % 2 === 0;
        let si = 0;
        if (!sib1) for (const t of sched) {
          const st = t.windowStartSfnMod * 10 + t.windowStartSubframe, pos = (sfn % t.periodicity) * 10 + sf;
          if (pos >= st && pos < st + t.windowMs && this.wanted(cell, t.si, now)) { si = t.si; break; }
        }
        if (!sib1 && !si) continue;
        if (sib1 && cell.sib1Ms && now - cell.sib1Ms < 2000 && sched.length) continue;
        if (tdd && !sib1) continue;
        const startF = base + j * num.subframe;
        const d = this.demodAligned(this.xr, this.xi, startF, num, nrb, sf, cell.pci, Math.max(1, Math.round(num.nfft / 128)));
        if (!d) continue;
        this.subframe(cell, d.g, sf, sfn, sib1, si, hf.h * 5 + j, now, tdd);
      }
    }
  }

  private wanted(cell: Cell, si: number, now: number): boolean {
    const got = cell.siGot.get(si), sibs = cell.summary?.schedule.find(t => t.si === si)?.sibs ?? [];
    if (sibs.some(s => s.startsWith('sibType10') || s.startsWith('sibType11') || s.startsWith('sibType12'))) return true;
    return !got || now - got.ms > 30_000;
  }

  private subframe(cell: Cell, g: Grid, sf: number, sfn: number, sib1: boolean, si: number, G: number, now: number, tdd: boolean): void {
    const ctl0 = cell.ctl[0], nrb = ctl0.nrb, H = chanEst(g, sf, cell.pci, nrb, ctl0.nports);
    const { cfi } = ctl0.cfi(g, H, sf), L = nrb > 10 ? cfi : cfi + 1;
    let hits: ReturnType<ControlDecoder['search']> = [], ctl = ctl0;
    for (const c of cell.ctl) { hits = c.search(g, H, sf, L); ctl = c; if (hits.length) break; }
    for (const h of hits) {
      cell.dciCount++; this.dci++;
      const A = tbsSi(h.dci);
      const [p0, p1] = allocation(h.dci, nrb);
      if (A === null || !p0.length || Math.max(...p0, ...p1) >= nrb) continue;
      const llr = pdschLlr(g, H, cell.pci, nrb, ctl.nports, sf, cfi, p0, p1, 0xffff, tdd);
      // DCI 1C carries no RV: SIB1 follows 36.321 5.3.1 (k = SFN/2 mod 4), other SI may be any of the four
      const rvs = h.dci.fmt === '1A' ? [h.dci.rv] : sib1 ? [Math.ceil(1.5 * ((sfn >> 1) % 4)) % 4] : [0, 2, 3, 1];
      let bits: Uint8Array | null = null;
      for (const rv of rvs) { const tb = new TbDecoder(A); tb.add(llr, rv); bits = tb.decode(); if (bits) break; }
      const kind = sib1 ? 'SIB1' : 'SI', pkey = `${kind}:${A}`;
      if (!bits && rvs.length === 1) {
        let p = cell.pending.get(pkey);
        const epoch = sib1 ? sfn >> 3 : G;
        if (!p || (sib1 ? p.epoch !== epoch : G - p.G > 40)) { p = { tb: new TbDecoder(A), G, epoch }; cell.pending.set(pkey, p); }
        p.tb.add(llr, rvs[0]);
        if (p.tb.n >= 2) { bits = p.tb.decode(); if (bits) cell.pending.delete(pkey); }
      } else if (bits) cell.pending.delete(pkey);
      if (!bits) { cell.tbFail++; continue; }
      cell.tbOk++; this.tbOk++;
      this.message(cell, bitsToBytes(bits), sib1, si, now);
    }
  }

  /** One BCCH-DL-SCH transport block that passed CRC-24A. Also the entry point for recorded blocks. */
  message(cell: Cell, bytes: Uint8Array, sib1Hint: boolean, si: number, now: number): void {
    const hex = hexOf(bytes), r = decodeBcchDlSch(bytes);
    cell.lastMs = now; this.dirty = true;
    if (!r.value) { this.addLog(now, cell.hz, cell.pci, 'SI', `undecodable ${sib1Hint ? 'SIB1' : 'SI'} (${r.error ?? 'error'})`, hex); return; }
    const parts = messageParts(r.value);
    if (parts.sib1) {
      const changed = hex !== cell.sib1Hex;
      cell.sib1 = parts.sib1; cell.sib1Ms = now; cell.sib1Count++;
      if (changed) {
        cell.sib1Hex = hex;
        try {
          cell.summary = sib1Summary(parts.sib1);
          if (cell.summary.band > 0) { cell.band = cell.summary.band; cell.earfcn = dlEarfcnForMhz(cell.band, cell.hz / 1e6); }
        } catch { /* partial SIB1 */ }
        const s = cell.summary;
        this.addLog(now, cell.hz, cell.pci, 'SIB1', s ? `PLMN ${s.plmns.map(p => p.id + (p.name ? ` ${p.name}` : '')).join(', ')} · TAC ${s.tac} · eNB ${s.enbId}/${s.cellId} · band ${s.band} · ${s.schedule.length} SI` : 'SIB1', hex);
      }
      return;
    }
    let siIdx = si;
    for (const [name, value] of parts.sibs) {
      if (!siIdx && cell.summary) siIdx = cell.summary.schedule.find(t => t.sibs.some(x => x.replace('sibType', 'sib') === name || name.startsWith(x.replace('sibType', 'sib'))))?.si ?? 0;
      const old = cell.sibs.get(name), fresh = !old || old.hex !== hex;
      cell.sibs.set(name, { name, si: siIdx, ms: now, count: (old?.count ?? 0) + 1, hex, value });
      if (fresh) this.addLog(now, cell.hz, cell.pci, name.toUpperCase().replace(/-.*/, ''), sibLine(name, value), hex);
      if (name === 'sib10' || name === 'sib11' || name.startsWith('sib12')) {
        const m = this.warnings.add(name.startsWith('sib12') ? 'sib12-v920' : name, value, cell.key, now);
        if (m) {
          if (m.complete) this.addLog(now, cell.hz, cell.pci, 'ALERT', `${m.cls} ${m.id} serial 0x${m.serial.toString(16).toUpperCase()}${m.language ? ` ${m.language}` : ''}: ${m.text || m.binaryHex}`, '');
          this.onAlert?.(m);
          this.emit?.({ type: 'cellAlert', alert: m });
        }
      }
    }
    if (siIdx) { const g = cell.siGot.get(siIdx); cell.siGot.set(siIdx, { ms: now, count: (g?.count ?? 0) + 1 }); }
  }

  /** Next capture: just before the earliest wanted SI window of the cells heard (or right away). */
  private schedule(cells: Cell[]): void {
    const fs = this.rate, frame = fs / 100, now = this.now(), lead = Math.round(fs * 0.012), from = this.abs + (this.realtime ? Math.round(fs * this.cpuMs / 1000 * 1.25) : 0);
    let best = Infinity;
    for (const c of cells) {
      if (!c.timing || !c.summary || (c.mib && c.mib.bandwidth > this.maxRb)) continue;
      for (const t of c.summary.schedule) {
        if (!this.wanted(c, t.si, now)) continue;
        const cur = Math.floor((this.abs - c.timing.abs) / frame);
        for (let f = cur; f < cur + 1024; f++) {
          const sfn = (c.timing.sfn + f) % 1024;
          if (sfn % t.periodicity !== t.windowStartSfnMod) continue;
          const at = c.timing.abs + f * frame + t.windowStartSubframe * frame / 10 - lead;
          if (at >= from && at < best) best = at;
          if (at >= from) break;
        }
      }
    }
    this.nextAbs = Number.isFinite(best) && best - this.abs < fs * 6 ? Math.round(best) : from;
  }

  private spectrum(xr: Float32Array, xi: Float32Array): void {
    const N = 1024, acc = new Float32Array(N), segs = Math.min(24, Math.floor(xr.length / N));
    for (let s = 0; s < segs; s++) {
      const o = Math.floor(s * (xr.length - N) / Math.max(1, segs - 1));
      for (let i = 0; i < N; i++) { this.specRe[i] = xr[o + i] * this.win[i]; this.specIm[i] = xi[o + i] * this.win[i]; }
      fft(this.specRe, this.specIm);
      for (let i = 0; i < N; i++) acc[i] += this.specRe[i] * this.specRe[i] + this.specIm[i] * this.specIm[i];
    }
    const fs = this.rate, binHz = fs / N, step = 50_000, usable = 0.85 * fs, pts = Math.floor(usable / step), db: number[] = [];
    for (let p = 0; p < pts; p++) {
      const f = -usable / 2 + p * step, b0 = Math.round(f / binHz), b1 = Math.max(b0 + 1, Math.round((f + step) / binHz));
      let s = 0;
      for (let b = b0; b < b1; b++) s += acc[(b + N) % N];
      db.push(Math.round(10 * Math.log10(s / (b1 - b0) / segs / (N * N) + 1e-12) * 10) / 10);
    }
    const sorted = [...db].sort((a, b) => a - b);
    this.floorDb = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
    this.profile = { lo: this.centerHz - usable / 2, step, db };
  }

  private addLog(ms: number, hz: number, pci: number, kind: string, text: string, hex: string): void {
    this.log.push({ ms, hz, pci, kind, text, hex });
    this.version++;
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
    this.emit?.({ type: 'packet', line: `${new Date(ms).toTimeString().slice(0, 8)} ${(hz / 1e6).toFixed(1)} PCI ${pci} ${kind} ${text}` });
    this.dirty = true;
  }

  // ---- outputs --------------------------------------------------------------------------------------------------
  row(c: Cell): CellRow {
    const sibs = new Map<string, Obj>([...c.sibs.values()].map(s => [s.name, s.value]));
    let nb: Neighbors | null = null, s2: Sib2Summary | null = null, s3: Sib3Summary | null = null, time: CellRow['time'] = null;
    try { nb = neighbors(sibs); } catch { /* partial */ }
    try { const v = sibs.get('sib2'); if (v) s2 = sib2Summary(v); } catch { /* partial */ }
    try { const v = sibs.get('sib3'); if (v) s3 = sib3Summary(v); } catch { /* partial */ }
    try { const v = sibs.get('sib8'); const t = v ? sib8Time(v) : null; if (t) time = { gpsIso: t.gpsIso, utcIso: t.utcIso }; } catch { /* partial */ }
    const sched = c.summary?.schedule ?? [];
    const e = c.earfcn !== null ? earfcnDl(c.earfcn) : null;
    return {
      key: c.key, hz: c.hz, pci: c.pci, earfcn: c.earfcn, band: c.band ?? e?.band ?? null, tdd: c.tdd, firstMs: c.firstMs, lastMs: c.lastMs, mibMs: c.mibMs, sib1Ms: c.sib1Ms,
      mib: c.mib, nrb: c.mib?.bandwidth ?? 0, ports: c.mib?.ports ?? 0, sfn: c.mib?.sfn ?? -1, snrDb: round1(c.snrDb), levelDb: round1(c.levelDb), cfoHz: Math.round(c.cfoHz), pssScore: round1(c.pssScore),
      mibCount: c.mibCount, sib1Count: c.sib1Count, dciCount: c.dciCount, tbOk: c.tbOk, tbFail: c.tbFail,
      summary: c.summary, sib2: s2, sib3: s3, neighbors: nb, time,
      sibs: [...c.sibs.values()].map(s => ({ name: s.name, si: s.si, ms: s.ms, count: s.count })),
      si: sched.map(t => ({ si: t.si, periodicity: t.periodicity, sibs: t.sibs, ms: c.siGot.get(t.si)?.ms ?? 0, count: c.siGot.get(t.si)?.count ?? 0 })),
      fullBand: !!c.mib && c.mib.bandwidth <= this.maxRb && c.hz === this.centerHz,
      complete: !!c.summary && sched.every(t => c.siGot.has(t.si)),
      alerts: this.warnings.messages().filter(m => m.cells.includes(c.key)).length,
    };
  }
  snapshot(): CellSnap {
    return {
      type: 'cell', centerHz: this.centerHz, rate: this.rate, full: this.maxRb >= 25, maxRb: this.maxRb,
      lte: this.lte, cpStrength: round1(this.cpStrength * 1000) / 1000, blocks: this.blocks, searching: !this.cfoKnown, lastBlockMs: this.lastBlockMs, cpuMs: Math.round(this.cpuMs),
      nextMs: this.nextAbs > this.abs ? Math.round((this.nextAbs - this.abs) / this.rate * 1000) : 0,
      profile: this.profile, floorDb: this.floorDb,
      cells: [...this.cells.values()].sort((a, b) => b.lastMs - a.lastMs).map(c => this.row(c)),
      alerts: this.warnings.messages(), log: this.log.slice(-300), dci: this.dci, tbOk: this.tbOk, pss: this.pss,
    };
  }
  /** Every decoded field of one cell, for its detail view. */
  detail(key: string): { key: string; mib: Mib | null; sib1: Obj | null; sib1Hex: string; sibs: SibRec[] } | null {
    const c = this.cells.get(key);
    return c ? { key, mib: c.mib, sib1: c.sib1, sib1Hex: c.sib1Hex, sibs: [...c.sibs.values()] } : null;
  }
  private post(force = false): void {
    const t = this.now();
    if (!force && t - this.lastPost < 500) return;
    this.lastPost = t; this.dirty = false;
    this.emit?.(this.snapshot() as unknown as Record<string, unknown>);
  }
  flush(): void { this.post(true); }

  /** A recorded transport block heard from a cell (tests, fixtures, the e2e hook). */
  feedBlock(hz: number, pci: number, hex: string, sib1: boolean, ms = this.now()): void {
    const prev = this.centerHz; this.centerHz = hz;
    const c = this.cellFor(pci, false, ms);
    this.centerHz = prev;
    c.lastMs = Math.max(c.lastMs, ms);
    this.message(c, hexToBytes(hex), sib1, 0, ms);
  }
  feedMib(hz: number, pci: number, mib: Mib, ms = this.now()): void {
    const prev = this.centerHz; this.centerHz = hz;
    const c = this.cellFor(pci, false, ms);
    this.centerHz = prev;
    c.mib = mib; c.mibMs = ms; c.mibCount++; c.lastMs = Math.max(c.lastMs, ms);
  }

  exportState(): CellState {
    const cells = [...this.cells.values()].map(c => ({ key: c.key, hz: c.hz, pci: c.pci, band: c.band, earfcn: c.earfcn, tdd: c.tdd, firstMs: c.firstMs, lastMs: c.lastMs, mibMs: c.mibMs, sib1Ms: c.sib1Ms,
      mib: c.mib, snrDb: c.snrDb, levelDb: c.levelDb, cfoHz: c.cfoHz, pssScore: c.pssScore, mibCount: c.mibCount, sib1Count: c.sib1Count, dciCount: c.dciCount, tbOk: c.tbOk, tbFail: c.tbFail,
      sib1Hex: c.sib1Hex, sibs: [...c.sibs.values()].map(s => ({ name: s.name, si: s.si, ms: s.ms, count: s.count, hex: s.hex })), siGot: [...c.siGot.entries()] }));
    return { v: 1, cells, alerts: this.warnings.messages(), log: this.log.slice(-500) };
  }
  /** Brings back what an earlier session heard; decoded values are rebuilt from the kept transport blocks. */
  restore(s: CellState | null): void {
    if (!s || s.v !== 1) return;
    for (const o of s.cells ?? []) {
      const key = String(o.key);
      if (this.cells.has(key)) continue;
      const c: Cell = { key, hz: Number(o.hz), pci: Number(o.pci), band: (o.band as number | null) ?? null, earfcn: (o.earfcn as number | null) ?? null, tdd: !!o.tdd,
        firstMs: Number(o.firstMs), lastMs: Number(o.lastMs), mibMs: Number(o.mibMs), sib1Ms: Number(o.sib1Ms), mib: (o.mib as Mib | null) ?? null,
        snrDb: Number(o.snrDb) || 0, levelDb: Number(o.levelDb) || 0, cfoHz: Number(o.cfoHz) || 0, pssScore: Number(o.pssScore) || 0,
        mibCount: Number(o.mibCount) || 0, sib1Count: Number(o.sib1Count) || 0, dciCount: Number(o.dciCount) || 0, tbOk: Number(o.tbOk) || 0, tbFail: Number(o.tbFail) || 0,
        sib1: null, sib1Hex: '', summary: null, sibs: new Map(), siGot: new Map((o.siGot as [number, { ms: number; count: number }][]) ?? []), timing: null, ctl: [], pending: new Map() };
      const hex1 = String(o.sib1Hex ?? '');
      if (hex1) {
        const p = messageParts(decodeBcchDlSch(hexToBytes(hex1)).value);
        if (p.sib1) { c.sib1 = p.sib1; c.sib1Hex = hex1; try { c.summary = sib1Summary(p.sib1); } catch { /* partial */ } }
      }
      for (const r of (o.sibs as { name: string; si: number; ms: number; count: number; hex: string }[]) ?? []) {
        const p = messageParts(decodeBcchDlSch(hexToBytes(r.hex)).value), v = p.sibs.find(x => x[0] === r.name);
        if (v) c.sibs.set(r.name, { name: r.name, si: r.si, ms: r.ms, count: r.count, hex: r.hex, value: v[1] });
      }
      this.cells.set(key, c);
    }
    this.warnings.restore(s.alerts ?? []);
    if (Array.isArray(s.log) && !this.log.length) this.log.push(...s.log.slice(-500));
    this.post(true);
  }
  exportAll(): { csv: string; json: string } {
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = 'utc,mhz,pci,kind,text,hex\n' + this.log.map(r => [new Date(r.ms).toISOString(), (r.hz / 1e6).toFixed(1), r.pci, r.kind, q(r.text), r.hex].join(',')).join('\n') + '\n';
    const s = this.snapshot();
    const json = JSON.stringify({ exported: new Date(this.now()).toISOString(), cells: s.cells.map(c => ({ ...c, decoded: this.detail(c.key) })), alerts: s.alerts }, null, 1);
    return { csv, json };
  }
  /** Forgets the cells and the log; the alerts stay until clearAlerts(). */
  clear(): void { this.cells.clear(); this.log.length = 0; this.dci = 0; this.tbOk = 0; this.version++; this.post(true); }
  clearAlerts(): void { this.warnings.clear(); this.version++; this.post(true); }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
function sibLine(name: string, v: Obj): string {
  try {
    if (name === 'sib4') return `${((v.intraFreqNeighCellList ?? []) as unknown[]).length} intra-frequency neighbors`;
    if (name === 'sib5') return `${((v.interFreqCarrierFreqList ?? []) as unknown[]).length} inter-frequency carriers`;
    if (name.startsWith('sib24')) return `${((v['carrierFreqListNR-r15'] ?? []) as unknown[]).length} NR carriers`;
    if (name.startsWith('sib12')) return `CMAS segment ${v['warningMessageSegmentNumber-r9']} of message ${parseInt(String(v['messageIdentifier-r9']), 2)}`;
    if (name === 'sib10') return `ETWS primary ${parseInt(String(v.messageIdentifier), 2)}`;
    if (name === 'sib11') return `ETWS segment ${v.warningMessageSegmentNumber}`;
  } catch { /* fall through */ }
  return name;
}
