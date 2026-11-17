/**
 * Plain summaries of decoded system information (36.331), frequency tables and operator names.
 *   cellIdentity (28 bits) = eNB ID (20 MSBs) + cell within the eNB (8 LSBs).
 *   E-UTRA downlink F_DL = F_DL_low + 0.1 (N_DL - N_Offs-DL)               36.101 Table 5.7.3-1
 *   NR F_REF = F_REF-Offs + dF_Global (N_REF - N_REF-Offs)                   38.104 Table 5.4.2.1-1
 *   SI window of the n-th SI message starts at x = (n - 1) w, in the frame with SFN mod T = floor(x / 10), subframe x mod 10 (36.331 5.2.3).
 */
type Obj = Record<string, unknown>;

/** 36.101 Table 5.7.3-1, downlink: band, F_DL_low (MHz), N_Offs-DL, last N_DL. */
const EUTRA_DL: [number, number, number, number][] = [
  [1, 2110, 0, 599], [2, 1930, 600, 1199], [3, 1805, 1200, 1949], [4, 2110, 1950, 2399], [5, 869, 2400, 2649], [6, 875, 2650, 2749],
  [7, 2620, 2750, 3449], [8, 925, 3450, 3799], [9, 1844.9, 3800, 4149], [10, 2110, 4150, 4749], [11, 1475.9, 4750, 4949],
  [12, 729, 5010, 5179], [13, 746, 5180, 5279], [14, 758, 5280, 5379], [17, 734, 5730, 5849], [18, 860, 5850, 5999],
  [19, 875, 6000, 6149], [20, 791, 6150, 6449], [21, 1495.9, 6450, 6599], [22, 3510, 6600, 7399], [23, 2180, 7500, 7699],
  [24, 1525, 7700, 8039], [25, 1930, 8040, 8689], [26, 859, 8690, 9039], [27, 852, 9040, 9209], [28, 758, 9210, 9659],
  [29, 717, 9660, 9769], [30, 2350, 9770, 9869], [31, 462.5, 9870, 9919], [32, 1452, 9920, 10359],
  [33, 1900, 36000, 36199], [34, 2010, 36200, 36349], [35, 1850, 36350, 36949], [36, 1930, 36950, 37549], [37, 1910, 37550, 37749],
  [38, 2570, 37750, 38249], [39, 1880, 38250, 38649], [40, 2300, 38650, 39649], [41, 2496, 39650, 41589], [42, 3400, 41590, 43589],
  [43, 3600, 43590, 45589], [44, 703, 45590, 46589], [45, 1447, 46590, 46789], [46, 5150, 46790, 54539], [47, 5855, 54540, 55239],
  [48, 3550, 55240, 56739], [65, 2110, 65536, 66435], [66, 2110, 66436, 67335], [67, 738, 67336, 67535], [68, 753, 67536, 67835],
  [69, 2570, 67836, 68335], [70, 1995, 68336, 68585], [71, 617, 68586, 68935], [72, 461, 68936, 68985], [74, 1475, 69036, 69465],
  [75, 1432, 69466, 70315], [76, 1427, 70316, 70365], [85, 728, 70366, 70545],
];
export const TDD_BANDS = new Set([33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]);

export function earfcnDl(n: number): { earfcn: number; band: number | null; mhz: number | null; tdd: boolean } {
  for (const [b, f, off, hi] of EUTRA_DL) if (n >= off && n <= hi) return { earfcn: n, band: b, mhz: Math.round((f + 0.1 * (n - off)) * 10) / 10, tdd: TDD_BANDS.has(b) };
  return { earfcn: n, band: null, mhz: null, tdd: false };
}
export function dlEarfcnForMhz(band: number, mhz: number): number | null {
  const r = EUTRA_DL.find(x => x[0] === band);
  if (!r) return null;
  const n = Math.round((mhz - r[1]) * 10) + r[2];
  return n >= r[2] && n <= r[3] ? n : null;
}
/** Downlink edges of a band in MHz. */
export function bandDlMhz(band: number): [number, number] | null {
  const r = EUTRA_DL.find(x => x[0] === band);
  return r ? [r[1], Math.round((r[1] + 0.1 * (r[3] - r[2])) * 10) / 10] : null;
}
export function nrArfcnMhz(n: number): number {
  const f = n < 600000 ? 0.005 * n : n < 2016667 ? 3000 + 0.015 * (n - 600000) : 24250.08 + 0.06 * (n - 2016667);
  return Math.round(f * 1000) / 1000;
}

/** Public MCC/MNC assignments (ITU-T E.212 lists and national registries). */
const OPERATORS: Record<string, string> = {
  '310-150': 'AT&T', '310-170': 'AT&T', '310-280': 'AT&T', '310-380': 'AT&T', '310-410': 'AT&T', '310-560': 'AT&T',
  '310-680': 'AT&T', '311-180': 'AT&T', '313-100': 'FirstNet', '310-004': 'Verizon', '310-010': 'Verizon', '310-012': 'Verizon', '310-013': 'Verizon', '310-590': 'Verizon', '310-890': 'Verizon',
  '310-910': 'Verizon', '311-110': 'Verizon', '311-270': 'Verizon', '311-271': 'Verizon', '311-272': 'Verizon', '311-273': 'Verizon',
  '311-274': 'Verizon', '311-275': 'Verizon', '311-276': 'Verizon', '311-277': 'Verizon', '311-278': 'Verizon', '311-279': 'Verizon',
  '311-280': 'Verizon', '311-281': 'Verizon', '311-282': 'Verizon', '311-283': 'Verizon', '311-284': 'Verizon', '311-285': 'Verizon',
  '311-286': 'Verizon', '311-287': 'Verizon', '311-288': 'Verizon', '311-289': 'Verizon', '311-390': 'Verizon', '311-480': 'Verizon',
  '311-481': 'Verizon', '311-482': 'Verizon', '311-483': 'Verizon', '311-484': 'Verizon', '311-485': 'Verizon', '311-486': 'Verizon',
  '311-487': 'Verizon', '311-488': 'Verizon', '311-489': 'Verizon',
  '310-160': 'T-Mobile', '310-200': 'T-Mobile', '310-210': 'T-Mobile', '310-220': 'T-Mobile', '310-230': 'T-Mobile', '310-240': 'T-Mobile',
  '310-250': 'T-Mobile', '310-260': 'T-Mobile', '310-270': 'T-Mobile', '310-310': 'T-Mobile', '310-490': 'T-Mobile', '310-660': 'T-Mobile',
  '310-800': 'T-Mobile', '311-490': 'T-Mobile', '312-250': 'T-Mobile', '312-530': 'T-Mobile',
  '310-120': 'T-Mobile (Sprint)', '316-010': 'T-Mobile (Sprint)',
  '311-580': 'UScellular', '311-220': 'UScellular', '310-730': 'UScellular',
  '313-340': 'Boost Mobile', '311-230': 'C Spire', '310-320': 'Cellular One', '310-130': 'Carolina West', '310-450': 'Viaero', '310-370': 'Docomo Pacific',
  '310-140': 'GTA', '311-370': 'GCI', '315-010': 'CBRS shared network',
  '302-220': 'Telus', '302-221': 'Telus', '302-610': 'Bell', '302-640': 'Bell', '302-690': 'Bell', '302-660': 'Bell MTS',
  '302-720': 'Rogers', '302-370': 'Fido', '302-320': 'Rogers', '302-490': 'Freedom Mobile', '302-500': 'Videotron',
  '302-510': 'Videotron', '302-520': 'Videotron', '302-680': 'SaskTel', '302-780': 'SaskTel', '302-270': 'Eastlink', '302-620': 'ICE Wireless',
  '334-020': 'Telcel', '334-030': 'Movistar', '334-010': 'AT&T Mexico', '334-040': 'AT&T Mexico', '334-050': 'AT&T Mexico',
  '334-090': 'AT&T Mexico', '334-140': 'Altan Redes',
  '234-10': 'O2 UK', '234-15': 'Vodafone UK', '234-20': 'Three UK', '234-30': 'EE', '234-33': 'EE',
  '262-01': 'Telekom', '262-02': 'Vodafone DE', '262-03': 'O2 DE', '208-01': 'Orange FR', '208-10': 'SFR', '208-15': 'Free', '208-20': 'Bouygues',
  '222-01': 'TIM', '222-10': 'Vodafone IT', '222-88': 'WindTre', '214-01': 'Vodafone ES', '214-03': 'Orange ES', '214-07': 'Movistar ES',
  '440-10': 'NTT Docomo', '440-20': 'SoftBank', '440-50': 'KDDI au', '450-05': 'SK Telecom', '450-08': 'KT', '450-06': 'LG U+',
  '460-00': 'China Mobile', '460-01': 'China Unicom', '460-11': 'China Telecom', '505-01': 'Telstra', '505-02': 'Optus', '505-03': 'Vodafone AU',
  '530-01': 'One NZ', '724-05': 'Claro BR', '724-06': 'Vivo', '724-10': 'Vivo', '724-11': 'Vivo', '724-02': 'TIM BR',
  '732-101': 'Claro CO', '732-123': 'Movistar CO', '730-01': 'Entel', '730-03': 'Claro CL', '525-01': 'Singtel', '454-00': 'CSL',
  '466-92': 'Chunghwa', '655-01': 'Vodacom', '655-10': 'MTN ZA', '621-30': 'MTN NG', '286-01': 'Turkcell', '250-01': 'MTS', '250-02': 'MegaFon', '250-99': 'Beeline',
};
export function operatorName(plmn: string): string { return OPERATORS[plmn] ?? ''; }

export function* walk(o: unknown, key: string): Generator<unknown> {
  if (Array.isArray(o)) { for (const v of o) yield* walk(v, key); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Obj)) { if (k === key) yield v; yield* walk(v, key); }
}
const first = (o: unknown, key: string): unknown => { for (const v of walk(o, key)) return v; return undefined; };
const bitsNum = (s: unknown) => typeof s === 'string' && /^[01]+$/.test(s) ? parseInt(s, 2) : -1;
const num = (v: unknown): number | null => typeof v === 'number' ? v : null;

export function plmnString(p: Obj, prevMcc = ''): string {
  const id = p['plmn-Identity'] as Obj | undefined;
  const mcc = Array.isArray(id?.mcc) ? (id!.mcc as number[]).join('') : prevMcc;
  const mnc = Array.isArray(id?.mnc) ? (id!.mnc as number[]).join('') : '';
  return `${mcc}-${mnc}`;
}

export interface SiSchedule { si: number; periodicity: number; sibs: string[]; windowStartSfnMod: number; windowStartSubframe: number; windowMs: number }
export interface Sib1Summary {
  plmns: { id: string; name: string }[]; tac: number; cellIdentity: number; enbId: number; cellId: number;
  barred: string; intraFreqReselection: string; band: number; bands: number[]; qRxLevMinDbm: number | null; qQualMinDb: number | null;
  pMax: number | null; siWindowMs: number; valueTag: number; schedule: SiSchedule[]; warning: { sib10: boolean; sib11: boolean; sib12: boolean };
  hyperSfn: number | null; imsEmergency: boolean; edrx: boolean; tdd: string | null;
}

export function sib1Summary(s: Obj): Sib1Summary {
  const cai = (s.cellAccessRelatedInfo ?? {}) as Obj;
  const plmns: { id: string; name: string }[] = [];
  let mcc = '';
  for (const p of (cai['plmn-IdentityList'] ?? []) as Obj[]) { const id = plmnString(p, mcc); mcc = id.split('-')[0]; plmns.push({ id, name: operatorName(id) }); }
  const cid = bitsNum(cai.cellIdentity);
  let band = Number(s.freqBandIndicator);
  if (band === 64) { const v = num(first(s, 'freqBandIndicator-v9e0')); if (v !== null) band = v; }
  const bands = [band];
  const mb = first(s, 'multiBandInfoList') as number[] | undefined, mb9 = first(s, 'multiBandInfoList-v9e0') as Obj[] | undefined;
  (mb ?? []).forEach((b, i) => { const v = b === 64 ? num(mb9?.[i]?.['freqBandIndicator-v9e0']) : b; if (v !== null && !bands.includes(v)) bands.push(v); });
  const w = Number(String(s['si-WindowLength'] ?? 'ms0').slice(2));
  const sched: [string, string[]][] = ((s.schedulingInfoList ?? []) as Obj[]).map(e => [String(e['si-Periodicity']), (e['sib-MappingInfo'] ?? []) as string[]]);
  for (const ext of walk(s, 'schedulingInfoListExt-r12')) for (const e of ext as Obj[]) sched.push([String(e['si-Periodicity-r12']), (e['sib-MappingInfo-r12'] ?? []) as string[]]);
  const schedule = sched.map(([per, sibs], i) => {
    const x = i * w;
    return { si: i + 1, periodicity: Number(per.slice(2)), sibs: (i === 0 ? ['sibType2'] : []).concat(sibs), windowStartSfnMod: Math.floor(x / 10), windowStartSubframe: x % 10, windowMs: w };
  });
  const all = schedule.flatMap(x => x.sibs);
  const csi = s.cellSelectionInfo as Obj | undefined;
  const qq = num((first(s, 'cellSelectionInfo-v920') as Obj | undefined)?.['q-QualMin-r9']);
  const tdd = s['tdd-Config'] as Obj | undefined;
  return {
    plmns, tac: bitsNum(cai.trackingAreaCode), cellIdentity: cid, enbId: cid >= 0 ? cid >>> 8 : -1, cellId: cid >= 0 ? cid & 0xff : -1,
    barred: String(cai.cellBarred ?? ''), intraFreqReselection: String(cai.intraFreqReselection ?? ''), band, bands,
    qRxLevMinDbm: csi && typeof csi['q-RxLevMin'] === 'number' ? 2 * (csi['q-RxLevMin'] as number) : null, qQualMinDb: qq,
    pMax: num(s['p-Max']), siWindowMs: w, valueTag: Number(s.systemInfoValueTag ?? -1), schedule,
    warning: { sib10: all.includes('sibType10'), sib11: all.includes('sibType11'), sib12: all.some(x => x.startsWith('sibType12')) },
    hyperSfn: (() => { const v = bitsNum(first(s, 'hyperSFN-r13')); return v >= 0 ? v : null; })(),
    imsEmergency: first(s, 'ims-EmergencySupport-r9') === 'true', edrx: first(s, 'eDRX-Allowed-r13') === 'true',
    tdd: tdd ? `${tdd.subframeAssignment} ${tdd.specialSubframePatterns}` : null,
  };
}

/** Which SI message (1-based) a frame/subframe falls in, given the schedule; 0 when none. */
export function siWindowOf(schedule: SiSchedule[], sfn: number, sf: number): number {
  for (const t of schedule) {
    const start = t.windowStartSfnMod * 10 + t.windowStartSubframe, pos = (sfn % t.periodicity) * 10 + sf;
    if (pos >= start && pos < start + t.windowMs) return t.si;
  }
  return 0;
}

export interface CellRef { pci: number; offset: string }
export interface InterFreq { earfcn: number; band: number | null; mhz: number | null; bands: number[]; priority: number | null; threshHigh: number; threshLow: number; qRxLevMinDbm: number; bandwidth: string; cells: CellRef[]; excluded: string[] }
export interface NrFreq { arfcn: number; mhz: number; bands: number[]; scs: string; priority: number | null; subPriority: string; threshHigh: number; threshLow: number; qRxLevMinDbm: number }
export interface Neighbors {
  intra: CellRef[]; intraExcluded: string[]; csgRange: string; inter: InterFreq[];
  utra: { kind: string; uarfcn: number; priority: number | null }[]; geran: { arfcns: number[]; band: string; priority: number | null }[];
  cdma: { bandClass: string; arfcn: number; pns: number[] }[]; nr: NrFreq[]; tReselectionNr: number | null;
}
const rangeText = (r: Obj) => r.range ? `${r.start} (${r.range})` : `${r.start}`;
const cellRefs = (l: unknown): CellRef[] => ((l ?? []) as Obj[]).map(q => ({ pci: Number(q.physCellId), offset: String(q['q-OffsetCell'] ?? '') }));

/** Neighbor relations from SIB4/5/6/7/8/24 (map of SIB name to decoded value). */
export function neighbors(sibs: Map<string, Obj>): Neighbors {
  const out: Neighbors = { intra: [], intraExcluded: [], csgRange: '', inter: [], utra: [], geran: [], cdma: [], nr: [], tReselectionNr: null };
  const s4 = sibs.get('sib4');
  if (s4) {
    out.intra = cellRefs(s4.intraFreqNeighCellList);
    out.intraExcluded = ((s4.intraFreqExcludedCellList ?? []) as Obj[]).map(rangeText);
    if (s4['csg-PhysCellIdRange']) out.csgRange = rangeText(s4['csg-PhysCellIdRange'] as Obj);
  }
  const s5 = sibs.get('sib5');
  if (s5) {
    const v8 = (first(s5, 'interFreqCarrierFreqList-v8h0') ?? []) as Obj[], v9 = (first(s5, 'interFreqCarrierFreqList-v9e0') ?? []) as Obj[];
    out.inter = ((s5.interFreqCarrierFreqList ?? []) as Obj[]).map((c, i) => {
      let n = Number(c['dl-CarrierFreq']);
      if (n === 65535 && typeof v9[i]?.['dl-CarrierFreq-v9e0'] === 'number') n = v9[i]['dl-CarrierFreq-v9e0'] as number;
      const f = earfcnDl(n);
      const bands: number[] = [];
      for (const b of (v8[i]?.multiBandInfoList ?? []) as number[]) if (b !== 64) bands.push(b);
      for (const b of (v9[i]?.['multiBandInfoList-v9e0'] ?? []) as Obj[]) if (typeof b['freqBandIndicator-v9e0'] === 'number') bands.push(b['freqBandIndicator-v9e0'] as number);
      return { earfcn: n, band: f.band, mhz: f.mhz, bands, priority: num(c.cellReselectionPriority), threshHigh: Number(c['threshX-High']), threshLow: Number(c['threshX-Low']),
        qRxLevMinDbm: 2 * Number(c['q-RxLevMin']), bandwidth: String(c.allowedMeasBandwidth ?? ''), cells: cellRefs(c.interFreqNeighCellList), excluded: ((c.interFreqExcludedCellList ?? []) as Obj[]).map(rangeText) };
    });
  }
  const s6 = sibs.get('sib6');
  if (s6) {
    for (const c of (s6['carrierFreqListUTRA-FDD'] ?? []) as Obj[]) out.utra.push({ kind: 'UTRA FDD', uarfcn: Number(c.carrierFreq), priority: num(c.cellReselectionPriority) });
    for (const c of (s6['carrierFreqListUTRA-TDD'] ?? []) as Obj[]) out.utra.push({ kind: 'UTRA TDD', uarfcn: Number(c.carrierFreq), priority: num(c.cellReselectionPriority) });
  }
  const s7 = sibs.get('sib7');
  if (s7) for (const c of (s7.carrierFreqsInfoList ?? []) as Obj[]) {
    const f = c.carrierFreqs as Obj, fol = (f.followingARFCNs ?? {}) as Obj, arfcns = [Number(f.startingARFCN)];
    if (Array.isArray(fol.explicitListOfARFCNs)) arfcns.push(...(fol.explicitListOfARFCNs as number[]));
    const eq = fol.equallySpacedARFCNs as Obj | undefined;
    if (eq) for (let k = 1; k <= Number(eq.numberOfFollowingARFCNs); k++) arfcns.push(arfcns[0] + k * Number(eq['arfcn-Spacing']));
    out.geran.push({ arfcns, band: String(f.bandIndicator), priority: num((c.commonInfo as Obj)?.cellReselectionPriority) });
  }
  const s8 = sibs.get('sib8');
  if (s8) for (const nl of walk(s8, 'neighCellList')) for (const nc of nl as Obj[]) for (const pf of (nc.neighCellsPerFreqList ?? []) as Obj[]) out.cdma.push({ bandClass: String(nc.bandClass), arfcn: Number(pf.arfcn), pns: (pf.physCellIdList ?? []) as number[] });
  const s24 = sibs.get('sib24-v1530');
  if (s24) {
    out.tReselectionNr = num(s24['t-ReselectionNR-r15']);
    out.nr = ((s24['carrierFreqListNR-r15'] ?? []) as Obj[]).map(c => ({ arfcn: Number(c['carrierFreq-r15']), mhz: nrArfcnMhz(Number(c['carrierFreq-r15'])), bands: (c['multiBandInfoList-r15'] ?? []) as number[],
      scs: String(c['subcarrierSpacingSSB-r15'] ?? ''), priority: num(c['cellReselectionPriority-r15']), subPriority: String(c['cellReselectionSubPriority-r15'] ?? ''),
      threshHigh: Number(c['threshX-High-r15']), threshLow: Number(c['threshX-Low-r15']), qRxLevMinDbm: 2 * Number(c['q-RxLevMin-r15']) }));
  }
  return out;
}

export interface Sib2Summary { preambles: string; prachConfigIndex: number; rootSequence: number; referenceSignalPowerDbm: number; pB: number; pagingCycle: string; nB: string;
  p0NominalPusch: number; alpha: string; ul64qam: boolean; mbsfn: boolean; additionalSpectrumEmission: number; ulEarfcn: number | null; ulBandwidth: string; acBarring: string; endcUpperLayer: boolean[] }
export function sib2Summary(s: Obj): Sib2Summary {
  const rr = (s.radioResourceConfigCommon ?? {}) as Obj, g = (k: string) => first(rr, k);
  const fi = (s.freqInfo ?? {}) as Obj, acb = s['ac-BarringInfo'] as Obj | undefined;
  return {
    preambles: String(g('numberOfRA-Preambles') ?? ''), prachConfigIndex: Number(g('prach-ConfigIndex')), rootSequence: Number(g('rootSequenceIndex')),
    referenceSignalPowerDbm: Number(g('referenceSignalPower')), pB: Number(g('p-b')), pagingCycle: String(g('defaultPagingCycle') ?? ''), nB: String(g('nB') ?? ''),
    p0NominalPusch: Number(g('p0-NominalPUSCH')), alpha: String(g('alpha') ?? ''), ul64qam: g('enable64QAM') === true || g('enable64QAM-v1270') === 'true',
    mbsfn: !!s['mbsfn-SubframeConfigList'], additionalSpectrumEmission: Number(fi.additionalSpectrumEmission), ulEarfcn: num(fi['ul-CarrierFreq']), ulBandwidth: String(fi['ul-Bandwidth'] ?? ''),
    acBarring: acb ? (acb['ac-BarringForMO-Data'] || acb['ac-BarringForMO-Signalling'] ? 'barring set' : acb['ac-BarringForEmergency'] ? 'emergency barred' : 'none') : 'not sent',
    endcUpperLayer: ((s['plmn-InfoList-r15'] ?? []) as Obj[]).map(p => p['upperLayerIndication-r15'] === 'true'),
  };
}

export interface Sib3Summary { qHyst: string; sNonIntraSearchDb: number | null; threshServingLow: number; priority: number; qRxLevMinDbm: number; sIntraSearchDb: number | null; tReselection: number; bandwidth: string }
export function sib3Summary(s: Obj): Sib3Summary {
  const c = (s.cellReselectionInfoCommon ?? {}) as Obj, sv = (s.cellReselectionServingFreqInfo ?? {}) as Obj, ia = (s.intraFreqCellReselectionInfo ?? {}) as Obj;
  const sp = num((s['s-IntraSearch-v920'] as Obj | undefined)?.['s-IntraSearchP-r9']) ?? num(ia['s-IntraSearch']);
  const sn = num((s['s-NonIntraSearch-v920'] as Obj | undefined)?.['s-NonIntraSearchP-r9']) ?? num(sv['s-NonIntraSearch']);
  return { qHyst: String(c['q-Hyst'] ?? ''), sNonIntraSearchDb: sn === null ? null : 2 * sn, threshServingLow: Number(sv.threshServingLow), priority: Number(sv.cellReselectionPriority),
    qRxLevMinDbm: 2 * Number(ia['q-RxLevMin']), sIntraSearchDb: sp === null ? null : 2 * sp, tReselection: Number(ia['t-ReselectionEUTRA']), bandwidth: String(ia.allowedMeasBandwidth ?? '') };
}

/** SIB8 CDMA2000 system time (39 bits, 10 ms units since the GPS epoch 1980-01-06). UTC assumes GPS minus 18 leap seconds. */
export function sib8Time(s: Obj): { cdma10ms: number; gpsIso: string; utcIso: string; synchronized: boolean } | null {
  const st = first(s, 'synchronousSystemTime');
  if (typeof st !== 'string') return null;
  const v = parseInt(st, 2), gps = Date.UTC(1980, 0, 6) + v * 10;
  return { cdma10ms: v, gpsIso: new Date(gps).toISOString(), utcIso: new Date(gps - 18_000).toISOString(), synchronized: first(s, 'cdma-EUTRA-Synchronisation') === true };
}

// ---- detail panel groups -----------------------------------------------------------------------------------------
const GROUPS: [string, RegExp][] = [
  ['Warning', /messageIdentifier|serialNumber|warning|dataCodingScheme/],
  ['Scheduling', /schedulingInfo|si-Periodicity|sib-Mapping|si-WindowLength|systemInfoValueTag|hyperSFN|modificationPeriod|pcch|defaultPagingCycle|\bnB\b/],
  ['Access', /cellAccessRelatedInfo|plmn|trackingAreaCode|cellIdentity|cellBarred|csg-Indication|csg-Identity|cellReserved|ac-Barring|ssac|acdc|ims-Emergency|eDRX|eCall|upperLayer|voiceService|videoService|udt|intraFreqReselection/],
  ['Neighbors NR', /NR-r15|NR-v|ReselectionNR|carrierFreq-r15|measTimingConfig|subcarrierSpacingSSB|deriveSSB/],
  ['Neighbors intra-frequency', /intraFreqNeigh|intraFreqExcluded|csg-PhysCellIdRange/],
  ['Neighbors inter-frequency', /interFreq|dl-CarrierFreq/],
  ['Inter-RAT', /UTRA|GERAN|carrierFreqsInfo|cdma|CDMA2000|1XRTT|HRPD|systemTimeInfo|searchWindowSize|csfb/],
  ['Reselection', /q-Hyst|s-IntraSearch|s-NonIntraSearch|threshServing|cellReselection|t-Reselection|speedState|mobilityState|threshX/],
  ['Selection', /cellSelectionInfo|q-RxLevMin|q-QualMin|p-Max/],
  ['Timers', /ue-TimersAndConstants|timeAlignment|\bt3\d\d|\bn3\d\d/],
  ['Radio config', /radioResourceConfig|rach|prach|pdsch|pusch|pucch|soundingRS|uplinkPower|ul-Cyclic|freqInfo|mbsfn|tdd-Config|multiBandInfo|freqBand|additionalSpectrum|NS-Pmax/i],
];
const NOISE = /^(nonCriticalExtension|lateNonCriticalExtension|.*-IEs)$/;
const fmt = (v: unknown): string => v === null ? 'present' : typeof v === 'boolean' ? (v ? 'true' : 'false') : Array.isArray(v) ? v.map(fmt).join(', ') : String(v);
const isLeaf = (v: unknown) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every(x => x === null || typeof x !== 'object'));
const derived = (k: string, v: unknown): string => {
  if (typeof v !== 'number') return '';
  if (/^q-RxLevMin/.test(k)) return ` (${2 * v} dBm)`;
  if (/^(s-IntraSearch|s-NonIntraSearch|threshServingLow|threshX-(High|Low))(P-r9|-r15)?$/.test(k) || k === 's-IntraSearch' || k === 's-NonIntraSearch') return ` (${2 * v} dB)`;
  if (k === 'referenceSignalPower') return ' dBm';
  if (k === 'dl-CarrierFreq' || k === 'dl-CarrierFreq-v9e0' || k === 'ul-CarrierFreq') { const f = earfcnDl(v); return f.mhz !== null ? ` (B${f.band}, ${f.mhz} MHz)` : ''; }
  if (k === 'carrierFreq-r15') return ` (${nrArfcnMhz(v)} MHz)`;
  return '';
};
function compact(o: Obj): string | null {
  const e = Object.entries(o);
  if (e.length === 0) return 'present';
  if (e.length > 6 || !e.every(([, v]) => isLeaf(v))) return null;
  return e.map(([k, v]) => `${k} ${fmt(v)}${derived(k, v)}`).join(', ');
}

/** Every decoded field of one SIB as named groups of [label, value] rows. */
export function fieldGroups(sibName: string, value: unknown): { name: string; rows: [string, string][] }[] {
  const rows: [string, string, string][] = [];
  const visit = (v: unknown, path: string[], key: string) => {
    const label = path.filter(p => !NOISE.test(p)).join(' / ');
    if (isLeaf(v)) { rows.push([label, fmt(v) + derived(key, v), path.join('/')]); return; }
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        const c = x && typeof x === 'object' && !Array.isArray(x) ? compact(x as Obj) : null;
        if (c !== null) rows.push([`${label} [${i + 1}]`, c, path.join('/')]);
        else visit(x, [...path.slice(0, -1), `${path[path.length - 1] ?? sibName} [${i + 1}]`], key);
      });
      return;
    }
    const o = v as Obj;
    if (Object.keys(o).length === 0) { if (!NOISE.test(key)) rows.push([label, 'present', path.join('/')]); return; }
    for (const [k, x] of Object.entries(o)) visit(x, [...path, k], k);
  };
  visit(value, [], sibName);
  const groups = new Map<string, [string, string][]>();
  for (const [label, val, raw] of rows) {
    const g = GROUPS.find(([, re]) => re.test(raw))?.[0] ?? 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push([label || sibName, val]);
  }
  const order = [...GROUPS.map(g => g[0]), 'Other'];
  return order.filter(n => groups.has(n)).map(name => ({ name, rows: groups.get(name)! }));
}
