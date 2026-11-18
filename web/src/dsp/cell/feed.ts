/**
 * The message feed: one readable line per decoded MIB and SIB, with repeats folded. A message heard again unchanged
 * bumps the count and last-heard time of its row; a changed value starts a new row marked as a change. Fields that
 * move on every transmission (the hyper SFN, the CDMA2000 system time) do not count as changes.
 */
import type { Mib } from './pbch.js';
import { sib2Summary, sib3Summary, sib8Time, neighbors, bandDlMhz, type Sib1Summary } from './sysinfo.js';
import { category, cmasClass } from './cbs.js';

type Obj = Record<string, unknown>;
export interface FeedRow {
  id: number; cell: string; hz: number; pci: number; op: string; band: number | null;
  name: string; slot?: string; text: string; alert: boolean; change: boolean; firstMs: number; lastMs: number; count: number; fp: string;
}

const BW_MHZ: Record<number, number> = { 6: 1.4, 15: 3, 25: 5, 50: 10, 75: 15, 100: 20 };
const bwName = (s: string) => { const n = Number(String(s).replace(/^n/, '')); return BW_MHZ[n] ? `${BW_MHZ[n]} MHz` : ''; };
/** 36.101 Table 5.7.3-1 uplink: band, F_UL_low (MHz), N_Offs-UL (FDD bands in US use). */
const EUTRA_UL: Record<number, [number, number]> = {
  1: [1920, 18000], 2: [1850, 18600], 3: [1710, 19200], 4: [1710, 19950], 5: [824, 20400], 7: [2500, 20750], 12: [699, 23010], 13: [777, 23180],
  14: [788, 23280], 17: [704, 23730], 25: [1850, 26040], 26: [814, 26690], 30: [2305, 27660], 66: [1710, 131972], 70: [1695, 132972], 71: [663, 133122], 85: [698, 134002],
};
const mhz1 = (f: number) => (Math.round(f * 10) / 10).toFixed(1);
const list = (xs: string[], n = 4) => xs.slice(0, n).join(', ') + (xs.length > n ? ', …' : '');
const cycle = (rf: string) => { const n = Number(String(rf).replace(/^rf/, '')); return n ? `${(n / 100).toFixed(2).replace(/0$/, '')} s` : rf; };
const bitsNum = (s: unknown) => typeof s === 'string' && /^[01]+$/.test(s) ? parseInt(s, 2) : -1;

/** Uplink carrier of a cell: from SIB2's ul-CarrierFreq, else the band's default spacing from the downlink. */
export function uplinkMhz(band: number | null, dlMhz: number, ulEarfcn: number | null): number | null {
  if (band === null) return null;
  const ul = EUTRA_UL[band];
  if (!ul) return null;
  if (ulEarfcn !== null) return Math.round((ul[0] + 0.1 * (ulEarfcn - ul[1])) * 10) / 10;
  const dl = bandDlMhz(band);
  return dl ? Math.round((ul[0] + (dlMhz - dl[0])) * 10) / 10 : null;
}

export function mibLine(m: Mib): string {
  return `${BW_MHZ[m.bandwidth] ?? m.bandwidth} MHz (${m.bandwidth} RBs), ${m.ports} antenna port${m.ports === 1 ? '' : 's'}, PHICH ${m.phichResource}${m.phichDuration === 'extended' ? ' extended' : ''}${m.sib1BR ? ', LTE-M SIB1 scheduled' : ''}`;
}
export function sib1Line(s: Sib1Summary): string {
  const ops = s.plmns.map(p => p.name ? `${p.name} ${p.id}` : p.id).join(', ');
  const warn = [s.warning.sib12 ? 'WEA scheduled' : '', s.warning.sib10 || s.warning.sib11 ? 'ETWS scheduled' : ''].filter(Boolean);
  return `${ops} · TAC ${s.tac} · cell ${s.enbId}/${s.cellId} · band ${s.band}${s.bands.length > 1 ? ` (also ${s.bands.slice(1).join(', ')})` : ''}${s.barred === 'barred' ? ' · BARRED' : ''} · ${s.schedule.length} SI message${s.schedule.length === 1 ? '' : 's'}${warn.length ? ' · ' + warn.join(', ') : ''}`;
}

/** One plain line for a decoded SIB. ctx: the cell's band and downlink MHz. */
export function sibLine(name: string, v: Obj, ctx: { band: number | null; mhz: number }): string {
  try {
    const one = new Map([[name, v]]);
    if (name === 'sib2') {
      const s = sib2Summary(v), ul = uplinkMhz(ctx.band, ctx.mhz, s.ulEarfcn), bw = s.ulBandwidth ? bwName(s.ulBandwidth) : '';
      const acb = s.acBarring === 'not sent' || s.acBarring === 'none' ? 'access barring off' : `access barring on (${s.acBarring})`;
      return [acb, ul !== null ? `uplink ${mhz1(ul)} MHz${s.ulEarfcn === null ? ' (band default)' : ''}` : '', bw ? `${bw} uplink` : '', s.pagingCycle ? `paging cycle ${cycle(s.pagingCycle)}` : '',
        Number.isFinite(s.referenceSignalPowerDbm) ? `reference signal ${s.referenceSignalPowerDbm} dBm` : '', s.endcUpperLayer.some(Boolean) ? '5G (EN-DC) offered' : ''].filter(Boolean).join(', ');
    }
    if (name === 'sib3') {
      const s = sib3Summary(v);
      return [`reselection priority ${s.priority}`, s.qHyst ? `hysteresis ${s.qHyst.replace('dB', '')} dB` : '', s.sIntraSearchDb !== null ? `searches its own frequency below ${s.sIntraSearchDb} dB margin` : '', s.sNonIntraSearchDb !== null ? `other carriers below ${s.sNonIntraSearchDb} dB` : '', Number.isFinite(s.qRxLevMinDbm) ? `minimum level ${s.qRxLevMinDbm} dBm` : ''].filter(Boolean).join(', ');
    }
    if (name === 'sib4') {
      const n = neighbors(one);
      return `${n.intra.length} same-frequency neighbor${n.intra.length === 1 ? '' : 's'}${n.intra.length ? ': PCI ' + list(n.intra.map(c => String(c.pci)), 8) : ''}${n.intraExcluded.length ? ` · ${n.intraExcluded.length} excluded` : ''}`;
    }
    if (name === 'sib5') {
      const n = neighbors(one);
      return `${n.inter.length} other LTE carrier${n.inter.length === 1 ? '' : 's'}${n.inter.length ? ': ' + list(n.inter.map(f => `${f.mhz !== null ? mhz1(f.mhz) : 'EARFCN ' + f.earfcn}${f.band ? ` B${f.band}` : ''} (prio ${f.priority ?? '-'})`)) : ''}`;
    }
    if (name === 'sib6') { const n = neighbors(one); return `${n.utra.length} UMTS carrier${n.utra.length === 1 ? '' : 's'}: ${list(n.utra.map(u => `UARFCN ${u.uarfcn}`))}`; }
    if (name === 'sib7') { const n = neighbors(one); return `GSM neighbors: ${list(n.geran.map(g => `${g.band} ARFCN ${list(g.arfcns.map(String), 3)}`))}`; }
    if (name === 'sib8') {
      const t = sib8Time(v), n = neighbors(one);
      return [t ? `CDMA2000 time ${t.utcIso.slice(0, 19).replace('T', ' ')} UTC (18 leap seconds assumed)${t.synchronized ? ', frames GPS locked' : ''}` : 'CDMA2000 parameters', n.cdma.length ? `${n.cdma.length} CDMA2000 neighbor channel${n.cdma.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    }
    if (name === 'sib10' || name === 'sib11' || name.startsWith('sib12')) {
      const r9 = name.startsWith('sib12'), f = (k: string) => v[r9 ? `${k}-r9` : k];
      const id = bitsNum(f('messageIdentifier')), c = cmasClass(id);
      if (name === 'sib10') return `ETWS primary notification ${id}: ${category(id)}`;
      const seg = Number(f('warningMessageSegmentNumber')), last = f('warningMessageSegmentType') === 'lastSegment';
      return `${c.kind || 'warning'} ${c.label} ${id} (0x${id.toString(16).toUpperCase()}), segment ${seg + 1}${last ? ', the last' : ''}${v['warningAreaCoordinatesSegment-r15'] ? ', with alert area' : ''}`;
    }
    if (name.startsWith('sib24')) {
      const n = neighbors(one);
      return `${n.nr.length} 5G NR carrier${n.nr.length === 1 ? '' : 's'}: ${list(n.nr.map(f => `${f.bands.length ? 'n' + f.bands[0] + ' ' : ''}${f.mhz} MHz${f.priority !== null ? ` (prio ${f.priority})` : ''}`))}`;
    }
    if (name.startsWith('sib13')) return 'MBMS (broadcast TV and data) configuration';
    if (name.startsWith('sib14')) return 'extended access barring';
    if (name.startsWith('sib15')) return 'MBMS service areas';
    if (name.startsWith('sib16')) return 'time information (GPS and UTC)';
  } catch { /* falls through to the field count */ }
  return `${Object.keys(v).length} field${Object.keys(v).length === 1 ? '' : 's'}`;
}

const VOLATILE = /hyperSFN|SystemTime|systemTimeInfo|timeInfo/;
/** The value with the fields that change on every transmission taken out. */
export function fingerprint(v: unknown): string {
  return JSON.stringify(v, (k, x) => VOLATILE.test(k) ? undefined : x);
}

/** Rows newest first; the latest row of each cell and message folds identical repeats. */
export class MessageFeed {
  rows: FeedRow[] = [];
  private next = 1;
  constructor(readonly max = 1500) {}
  /** slot: what a repeat must match besides the message name (a warning's message ID and segment). */
  add(r: Omit<FeedRow, 'id' | 'change' | 'firstMs' | 'lastMs' | 'count' | 'slot'>, ms: number, slot = ''): FeedRow {
    const prev = this.rows.find(x => x.cell === r.cell && x.name === r.name && (x.slot ?? '') === slot);
    if (prev && prev.fp === r.fp) { prev.lastMs = Math.max(prev.lastMs, ms); prev.count++; prev.text = r.text; prev.op = r.op || prev.op; return prev; }
    const row: FeedRow = { ...r, slot, id: this.next++, change: !!prev, firstMs: ms, lastMs: ms, count: 1 };
    this.rows.unshift(row);
    if (this.rows.length > this.max) this.rows.length = this.max;
    return row;
  }
  restore(rows: FeedRow[]): void {
    if (!Array.isArray(rows) || this.rows.length) return;
    this.rows = rows.filter(r => r && typeof r.id === 'number').slice(0, this.max);
    this.next = Math.max(0, ...this.rows.map(r => r.id)) + 1;
  }
  clear(): void { this.rows = []; }
}

/** A cell's display context for its lines. */
export const feedCtx = (band: number | null, hz: number) => ({ band, mhz: hz / 1e6 });

/** The repeat slot of a warning SIB: message ID, serial and segment. */
export function warningSlot(name: string, v: Obj): string {
  const r9 = name.startsWith('sib12'), f = (k: string) => v[r9 ? `${k}-r9` : k];
  return `${bitsNum(f('messageIdentifier'))}/${bitsNum(f('serialNumber'))}/${f('warningMessageSegmentNumber') ?? ''}`;
}
