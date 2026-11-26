/**
 * LTE paging (PCCH on PDSCH, P-RNTI 0xFFFE). 36.331 Paging: the paging records (S-TMSI or IMSI with the CN domain,
 * the Rel-15 5G S-TMSI and full I-RNTI) and the systemInfoModification, ETWS and CMAS flags. 36.304 7.1/7.2 paging
 * frames and occasions from SIB2's PCCH-Config: every UE_ID is covered, so every PF and PO of the cell is read.
 */
import { rrcDecoder } from './rrc.js';

type Obj = Record<string, unknown>;
export const P_RNTI = 0xfffe;
export interface PageRecord { type: 'S-TMSI' | 'IMSI' | '5G-S-TMSI' | 'I-RNTI' | 'OTHER'; id: string; domain: 'PS' | 'CS' }
export interface PagingMessage { records: PageRecord[]; sysInfoMod: boolean; etws: boolean; cmas: boolean; eab: boolean }

const hex = (bits: unknown, n: number) => typeof bits === 'string' && /^[01]+$/.test(bits) ? parseInt(bits, 2).toString(16).toUpperCase().padStart(n, '0') : '?';
/** A 40 or 48 bit string as hex (past 2^53 safe either way, read in two halves). */
const hexLong = (bits: unknown) => typeof bits === 'string' && /^[01]+$/.test(bits) ? hex(bits.slice(0, bits.length - 24), (bits.length - 24) / 4) + hex(bits.slice(-24), 6) : '?';

/** One PCCH transport block; null when it is not a Paging message. */
export function decodePaging(bytes: Uint8Array): { msg: PagingMessage | null; error?: string } {
  let v: Obj;
  try { v = rrcDecoder().decode('PCCH-Message', bytes).value as Obj; } catch (e) { return { msg: null, error: (e as Error).message }; }
  const p = ((v.message as Obj | undefined)?.c1 as Obj | undefined)?.paging as Obj | undefined;
  if (!p) return { msg: null, error: 'not a Paging message' };
  const records = ((p.pagingRecordList ?? []) as Obj[]).map(r => {
    const u = (r['ue-Identity'] ?? {}) as Obj, domain = r['cn-Domain'] === 'cs' ? 'CS' as const : 'PS' as const;
    const s = u['s-TMSI'] as Obj | undefined;
    if (s) return { type: 'S-TMSI' as const, id: `${hex(s.mmec, 2)}:${hex(s['m-TMSI'], 8)}`, domain };
    if (u.imsi) return { type: 'IMSI' as const, id: (u.imsi as number[]).join(''), domain };
    if (u['ng-5G-S-TMSI-r15']) return { type: '5G-S-TMSI' as const, id: hexLong(u['ng-5G-S-TMSI-r15']), domain };
    if (u['fullI-RNTI-r15']) return { type: 'I-RNTI' as const, id: hexLong(u['fullI-RNTI-r15']), domain };
    return { type: 'OTHER' as const, id: Object.keys(u)[0] ?? '?', domain };
  });
  // the Rel-9 and Rel-11 flags sit two and three nonCriticalExtension levels down
  const v920 = (p.nonCriticalExtension as Obj | undefined)?.nonCriticalExtension as Obj | undefined, v1130 = v920?.nonCriticalExtension as Obj | undefined;
  return { msg: { records, sysInfoMod: p.systemInfoModification === 'true', etws: p['etws-Indication'] === 'true', cmas: v920?.['cmas-Indication-r9'] === 'true', eab: v1130?.['eab-ParamModification-r11'] === 'true' } };
}

/** PFs (SFN mod every = 0) and the PO subframes of a cell, from defaultPagingCycle and nB; null if unknown. */
export interface PagingConfig { every: number; sfs: number[] }
const NB: Record<string, number> = { fourT: 4, twoT: 2, oneT: 1, halfT: 1 / 2, quarterT: 1 / 4, oneEighthT: 1 / 8, oneSixteenthT: 1 / 16, oneThirtySecondT: 1 / 32 };
export function pagingConfig(cycle: string, nB: string, tdd = false): PagingConfig | null {
  const T = Number(String(cycle).replace(/^rf/, '')), k = NB[nB];
  if (!T || !k) return null;
  const N = Math.min(T, k * T), Ns = Math.max(1, k);
  const sfs = tdd ? ({ 1: [0], 2: [0, 5], 4: [0, 1, 5, 6] } as Record<number, number[]>)[Ns] : ({ 1: [9], 2: [4, 9], 4: [0, 4, 5, 9] } as Record<number, number[]>)[Ns];
  return { every: T / N, sfs };
}
export const isPagingSf = (c: PagingConfig, sfn: number, sf: number) => sfn % c.every === 0 && c.sfs.includes(sf);

/** A paging record or a flag as heard: flags of one cell fold into one row while they repeat. */
export interface PageRow { ms: number; lastMs: number; cell: string; hz: number; pci: number; type: string; id: string; domain: string; count: number }
export interface PageId { type: string; id: string; domain: string; count: number; firstMs: number; lastMs: number; cells: string[] }
export interface PagingSnap { total: number; rows: PageRow[]; ids: PageId[]; flags: { sysInfoMod: number; etws: number; cmas: number; eab: number } }

export class PagingLog {
  rows: PageRow[] = [];
  readonly ids = new Map<string, PageId>();
  total = 0;
  flags = { sysInfoMod: 0, etws: 0, cmas: 0, eab: 0 };
  constructor(readonly max = 2000) {}
  /** Adds one decoded message; returns the flags that started a new row (for the log). */
  add(m: PagingMessage, cell: string, hz: number, pci: number, ms: number): string[] {
    for (const r of m.records) {
      this.total++;
      this.rows.unshift({ ms, lastMs: ms, cell, hz, pci, type: r.type, id: r.id, domain: r.domain, count: 1 });
      const key = `${r.type}|${r.id}`, o = this.ids.get(key);
      if (o) { o.count++; o.lastMs = ms; o.domain = r.domain; if (!o.cells.includes(cell)) o.cells.push(cell); }
      else this.ids.set(key, { type: r.type, id: r.id, domain: r.domain, count: 1, firstMs: ms, lastMs: ms, cells: [cell] });
    }
    const fresh: string[] = [];
    for (const [f, on, label] of [['sysInfoMod', m.sysInfoMod, 'SI CHANGE'], ['etws', m.etws, 'ETWS'], ['cmas', m.cmas, 'CMAS'], ['eab', m.eab, 'EAB CHANGE']] as const) {
      if (!on) continue;
      this.flags[f]++;
      const prev = this.rows.find(x => x.cell === cell && x.type === label);
      if (prev && ms - prev.lastMs < 10_000) { prev.lastMs = ms; prev.count++; continue; }
      this.rows.unshift({ ms, lastMs: ms, cell, hz, pci, type: label, id: '', domain: '', count: 1 });
      fresh.push(label);
    }
    if (this.rows.length > this.max) this.rows.length = this.max;
    if (this.ids.size > this.max) {
      const old = [...this.ids.entries()].sort((a, b) => a[1].lastMs - b[1].lastMs).slice(0, this.ids.size - this.max);
      for (const [k] of old) this.ids.delete(k);
    }
    return fresh;
  }
  snapshot(rows = 300, ids = 200): PagingSnap {
    const top = [...this.ids.values()].sort((a, b) => b.count - a.count || b.lastMs - a.lastMs).slice(0, ids);
    return { total: this.total, rows: this.rows.slice(0, rows), ids: top, flags: { ...this.flags } };
  }
  clear(): void { this.rows = []; this.ids.clear(); this.total = 0; this.flags = { sysInfoMod: 0, etws: 0, cmas: 0, eab: 0 }; }
}
