/**
 * MPEG-2 transport stream demultiplexer (ITU-T H.222.0 2.4.3): packet counts per PID, continuity, PCR, section
 * reassembly on the table PIDs and PES reassembly on the video PIDs. Decoding comes in bursts, so `gap()` marks
 * where the stream stops being contiguous: every partial section and PES is closed there.
 */
import { SectionAssembler } from './psip.js';

/** ATSC TS rate: one 188-byte packet per data segment, 312 of every 313 segments. */
export const TS_BPS = 4.5e6 / 286 * 684 / 832 * 312 / 313 * 188 * 8;

export interface PidStat { packets: number; ccErrors: number; scrambled: number; pcrs: number; pcrIntervalMs: number; pcrPpm: number; lastPcr: number; lastPcrAt: number }

export class TsDemux {
  /** Packets per PID since the last clear (PID 8192 counts the packets RS could not correct). */
  readonly pids = new Map<number, PidStat>();
  total = 0; bad = 0;
  private readonly cc = new Map<number, number>();
  private readonly sec = new Map<number, SectionAssembler>();
  private readonly pes = new Map<number, { buf: Uint8Array; len: number; holes: number[]; started: boolean }>();
  /** Absolute packet counter (bursts count on from where the last one ended, plus their gaps). */
  private at = 0;
  onSection: ((pid: number, s: Uint8Array) => void) | null = null;
  onPes: ((pid: number, es: Uint8Array, holes: number[]) => void) | null = null;
  constructor() { this.clear(); }

  /** Table PIDs to reassemble sections on. */
  watchSections(pid: number): void { if (!this.sec.has(pid)) this.sec.set(pid, new SectionAssembler(s => this.onSection?.(pid, s))); }
  /** Video PIDs to reassemble PES on. */
  watchPes(pid: number): void { if (!this.pes.has(pid)) this.pes.set(pid, { buf: new Uint8Array(1 << 18), len: 0, holes: [], started: false }); }
  unwatchPes(pid: number): void { this.pes.delete(pid); }
  get pesPids(): number[] { return [...this.pes.keys()]; }

  private stat(pid: number): PidStat {
    let s = this.pids.get(pid);
    if (!s) { s = { packets: 0, ccErrors: 0, scrambled: 0, pcrs: 0, pcrIntervalMs: 0, pcrPpm: 0, lastPcr: -1, lastPcrAt: -1 }; this.pids.set(pid, s); }
    return s;
  }

  /** The stream is not contiguous from here: close every partial section and PES. */
  gap(packetsMissed = 1_000_000): void {
    for (const a of this.sec.values()) a.reset();
    for (const [pid, p] of this.pes) this.flushPes(pid, p, true);
    this.cc.clear();
    for (const s of this.pids.values()) s.lastPcr = -1;
    this.at += packetsMissed;
  }

  /** 188-byte packets; a transport error indicator marks a packet RS could not correct. */
  feed(ts: Uint8Array): void {
    const n = Math.floor(ts.length / 188);
    for (let k = 0; k < n; k++, this.at++) {
      const o = k * 188;
      this.total++;
      if (ts[o] !== 0x47 || (ts[o + 1] & 0x80)) {
        this.bad++; this.stat(8192).packets++;
        // the PID of a damaged packet is not known: every stream in progress may have lost one
        for (const p of this.pes.values()) if (p.started) p.holes.push(p.len);
        this.cc.clear();
        continue;
      }
      const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2], pusi = (ts[o + 1] & 0x40) !== 0;
      const afc = (ts[o + 3] >> 4) & 3, cc = ts[o + 3] & 15, st = this.stat(pid);
      st.packets++;
      if (ts[o + 3] >> 6) st.scrambled++;
      let pos = 4, disc = false;
      if (afc & 2) {
        const al = ts[o + 4];
        if (al > 0) {
          const flags = ts[o + 5];
          disc = (flags & 0x80) !== 0;
          if (flags & 0x10 && al >= 7) {
            const base = ts[o + 6] * 33554432 + ((ts[o + 7] << 17) | (ts[o + 8] << 9) | (ts[o + 9] << 1) | (ts[o + 10] >> 7));
            const pcr = base * 300 + (((ts[o + 10] & 1) << 8) | ts[o + 11]);
            if (st.lastPcr >= 0 && this.at > st.lastPcrAt) {
              const dt = (pcr - st.lastPcr) / 27e6, dp = (this.at - st.lastPcrAt) * 188 * 8 / TS_BPS;
              if (dt > 0 && dt < 0.2) { st.pcrIntervalMs = st.pcrIntervalMs ? 0.9 * st.pcrIntervalMs + 100 * dt : 1000 * dt; const ppm = (dt / dp - 1) * 1e6; st.pcrPpm = st.pcrs > 1 ? 0.9 * st.pcrPpm + 0.1 * ppm : ppm; }
            }
            st.lastPcr = pcr; st.lastPcrAt = this.at; st.pcrs++;
          }
        }
        pos = 5 + al;
      }
      if (pid === 0x1fff) continue;
      if (afc & 1) {
        const last = this.cc.get(pid);
        let lost = false;
        if (last !== undefined && !disc) {
          if (cc === last) continue;
          if (cc !== ((last + 1) & 15)) { st.ccErrors++; lost = true; }
        }
        this.cc.set(pid, cc);
        if (pos >= 188) continue;
        const pl = ts.subarray(o + pos, o + 188);
        const sa = this.sec.get(pid);
        if (sa) { if (lost) sa.reset(); sa.feed(pusi, pl); }
        const pe = this.pes.get(pid);
        if (pe) {
          if (lost && pe.started) pe.holes.push(pe.len);
          if (pusi) {
            this.flushPes(pid, pe, false);
            if (pl.length < 9 || pl[0] !== 0 || pl[1] !== 0 || pl[2] !== 1) continue;
            const hl = pl[8];
            pe.started = true;
            this.append(pe, pl.subarray(9 + hl));
          } else if (pe.started) this.append(pe, pl);
        }
      }
    }
  }

  private append(pe: { buf: Uint8Array; len: number }, b: Uint8Array): void {
    if (pe.len + b.length > pe.buf.length) {
      if (pe.buf.length >= 1 << 22) return;
      const nb = new Uint8Array(pe.buf.length * 2); nb.set(pe.buf.subarray(0, pe.len)); pe.buf = nb;
    }
    pe.buf.set(b, pe.len); pe.len += b.length;
  }
  private flushPes(pid: number, pe: { buf: Uint8Array; len: number; holes: number[]; started: boolean }, cut: boolean): void {
    if (pe.started && pe.len > 0) {
      if (cut) pe.holes.push(pe.len);
      this.onPes?.(pid, pe.buf.subarray(0, pe.len), pe.holes);
    }
    pe.len = 0; pe.holes = []; pe.started = false;
  }

  /** Forgets everything, and watches the PAT and the PSIP base PID again. */
  clear(): void { this.gap(); this.pids.clear(); this.sec.clear(); this.pes.clear(); this.total = 0; this.bad = 0; this.watchSections(0); this.watchSections(0x1ffb); }
}
