/** One burst of IQ to TS packets: the 8VSB receiver, then de-interleaving, RS and the de-randomizer. */
import { demodBurst, type BurstState, type PilotInfo } from './vsb.js';
import { deinterleave, packetsToTs, FIELD_BYTES, type RsStats } from './fec.js';

export interface BurstOut {
  ok: boolean; reason: string; pilot: PilotInfo | null;
  ts: Uint8Array; rs: RsStats; fields: number; fieldSnr: number[];
  snrDb: number; sliceSnrDb: number; segPeak: number; syncs: number;
  hist: Uint32Array; eye: Float32Array; echo: Float32Array; dfe: Float32Array; ffe: Float32Array;
  eps: number; pilotHz: number; cpuMs: number; symbols: number; profile?: Record<string, number>;
}

export function decodeBurst(iq: Int8Array, rate: number, st: BurstState): BurstOut {
  const t0 = performance.now();
  const r = demodBurst(iq, rate, st);
  const rs: RsStats = { ok: 0, corrected: 0, failed: 0, bytes: 0 };
  let ts = new Uint8Array(0);
  if (r.ok && r.fields.length) {
    const all = new Uint8Array(r.fields.length * FIELD_BYTES);
    r.fields.forEach((f, i) => all.set(f.bytes, i * FIELD_BYTES));
    ts = packetsToTs(deinterleave(all, all.length), 0, rs);
  }
  return {
    ok: r.ok, reason: r.reason, pilot: r.pilot, ts, rs, fields: r.fields.length, fieldSnr: r.fields.map(f => f.snrDb),
    snrDb: r.snrDb, sliceSnrDb: r.sliceSnrDb, segPeak: r.segPeak, syncs: r.syncs, hist: r.hist, eye: r.eye, echo: r.echo, dfe: r.dfe, ffe: r.ffe,
    eps: st.eps, pilotHz: st.pilotHz, cpuMs: performance.now() - t0, symbols: r.symbols, profile: r.profile,
  };
}
