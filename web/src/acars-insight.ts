/**
 * What an ACARS message says, in plain words: its kind (link test, out/off/on/in, position, weather, ATIS, free text,
 * engine or system data ...) from the label table and what the text shows, the airports it names (only codes that
 * are real airports), a position (only clear latitude/longitude forms, implausible ones dropped), the flight phase
 * from the out/off/on/in labels, and a route when two airports stand together. Also the airline from a flight
 * number, the VDL2 per-address tracker (every aircraft and ground station heard, not only ACARS) and the activity
 * counts the STATS view draws.
 *
 * Twin ports: core/apps/AcarsInsight.kt and core/apps/AcarsInsight.swift (same names, same constants).
 */
import type { AcarsMsg, AcarsPlane } from './acars-planes.js';
import { labelMeaning } from './acars-planes.js';

/** An airport: ICAO ident, position, name. */
export interface Airport { ident: string; lat: number; lon: number; name: string }
export type AirportLookup = (ident: string) => Airport | undefined;
export interface LatLon { lat: number; lon: number }

/** Message kinds: id, short label. */
export const KINDS: Record<string, string> = {
  link: 'LINK TEST', ack: 'ACK', out: 'OUT', off: 'OFF', on: 'ON', in: 'IN', pos: 'POSITION', wx: 'WEATHER', atis: 'ATIS',
  eta: 'ETA', delay: 'DELAY', text: 'FREE TEXT', printer: 'PRINTER', engine: 'ENGINE DATA', fault: 'FAULT REPORT', fms: 'FMS',
  data: 'SYSTEM DATA', media: 'MEDIA', airline: 'AIRLINE', request: 'REQUEST', other: 'MESSAGE',
};
export const kindLabelOf = (k: string) => KINDS[k] ?? 'MESSAGE';

/** The flight phases out/off/on/in give. */
export const PHASES: Record<string, string> = { out: 'TAXIING', off: 'AIRBORNE', on: 'LANDED', in: 'AT GATE' };

export interface MsgInsight {
  kind: string;
  /** A short plain-English line. */
  summary: string;
  /** Known airports named in the text, in order, no repeats. */
  airports: string[];
  pos: LatLon | null;
  /** '' or a PHASES value. */
  phase: string;
  orig: string; dest: string;
  /** What the text itself says of the flight (only from labeled values: FL350, ALT 12000, GS 450, HDG 270, FOB 18.4,
   *  ETA 0215); null or '' when it does not say. */
  nums: FlightNums;
}
export interface FlightNums { altFt: number | null; kt: number | null; mach: string; hdg: number | null; fuel: string; eta: string }

/** Common words that are also airport idents: never read as airports. */
const NOT_AIRPORTS = new Set(['KIND', 'KNEW', 'KNOW', 'PAST']);
/** Positions further than this from home are not where a VHF-heard aircraft is. */
export const POS_MAX_KM = 1000;

export function distKm(a: LatLon, b: LatLon): number {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Degrees from a hemisphere letter and a digit group: DDMM, DDMMm, DDMMmm (minutes), or DD.ddd (with the point). */
function degOf(hemi: string, s: string, degDigits: number): number | null {
  const neg = hemi === 'S' || hemi === 'W';
  let v: number;
  if (s.includes('.')) {
    const [a, b] = s.split('.');
    if (a.length === degDigits || a.length === degDigits - 1) v = Number(`${a}.${b}`);              // decimal degrees
    else if (a.length === degDigits + 2 || a.length === degDigits + 1) {                             // DDMM.m
      const d = Number(a.slice(0, a.length - 2)), m = Number(`${a.slice(-2)}.${b}`);
      if (m >= 60) return null; v = d + m / 60;
    } else return null;
  } else {
    if (s.length < degDigits + 2 || s.length > degDigits + 4) return null;
    const d = Number(s.slice(0, degDigits)), mm = s.slice(degDigits);
    const m = Number(mm.slice(0, 2)) + (mm.length > 2 ? Number(`0.${mm.slice(2)}`) : 0);
    if (m >= 60) return null; v = d + m / 60;
  }
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

const POS_HEMI = /(?<![A-Z0-9])(?:POS|POSN)?\s?([NS])\s?(\d{2}(?:\d{2}\.\d{1,3}|\d{2,4}|\.\d{1,4}))[\s,/]{0,2}([EW])\s?(\d{3}(?:\d{2}\.\d{1,3}|\d{2,4}|\.\d{1,4}))(?!\d)/g;
const POS_HEMI_TIGHT = /(?<!\d)([NS])(\d{2}(?:\d{2}\.\d{1,3}|\d{2,4}|\.\d{1,4}))\s?([EW])(\d{3}(?:\d{2}\.\d{1,3}|\d{2,4}|\.\d{1,4}))(?!\d)/g;
const POS_SIGNED = /(?<![\d.])(-?\d{1,2}\.\d{3,6}),\s?(-?\d{1,3}\.\d{3,6})(?![\d.])/g;

/** Plausible: on the globe, not 0,0, and (when home is known) within POS_MAX_KM of it. */
export function plausible(p: LatLon, home: LatLon | null): boolean {
  if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) return false;
  if (Math.abs(p.lat) < 0.01 && Math.abs(p.lon) < 0.01) return false;
  return !home || distKm(p, home) <= POS_MAX_KM;
}

/** Every clear latitude/longitude in [text] (N33456W118123, N3345.6 W11812.3, N33.456 W118.123, 33.456,-118.123). */
export function findPositions(text: string, home: LatLon | null = null): LatLon[] {
  const out: LatLon[] = [];
  const t = text.toUpperCase();
  const seen = new Set<string>();
  const push = (p: LatLon) => { const k = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`; if (!seen.has(k) && plausible(p, home)) { seen.add(k); out.push(p); } };
  for (const re of [POS_HEMI, POS_HEMI_TIGHT]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(t));) {
      const lat = degOf(m[1], m[2], 2), lon = degOf(m[3], m[4], 3);
      if (lat !== null && lon !== null) push({ lat, lon });
    }
  }
  POS_SIGNED.lastIndex = 0;
  for (let m; (m = POS_SIGNED.exec(t));) push({ lat: Number(m[1]), lon: Number(m[2]) });
  return out;
}

/** The known airports named in [text]: four-letter codes (alone, or two run together as in KLAXKSFO). */
export function findAirports(text: string, lookup: AirportLookup | null): string[] {
  if (!lookup) return [];
  const out: string[] = [];
  for (const run of text.toUpperCase().match(/[A-Z]{4,}/g) ?? []) {
    const parts = run.length === 4 ? [run] : run.length === 8 ? [run.slice(0, 4), run.slice(4)] : [];
    for (const c of parts) if (!NOT_AIRPORTS.has(c) && lookup(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Origin and destination: two known airports side by side (KLAX KSFO, KLAX-KSFO, KLAX/KSFO, KLAXKSFO). */
export function findRoute(text: string, lookup: AirportLookup | null): [string, string] | null {
  if (!lookup) return null;
  const re = /(?<![A-Z])([A-Z]{4})[\s\-/>]?([A-Z]{4})(?![A-Z])/g;
  for (let m; (m = re.exec(text.toUpperCase()));) {
    const a = m[1], b = m[2];
    if (a !== b && !NOT_AIRPORTS.has(a) && !NOT_AIRPORTS.has(b) && lookup(a) && lookup(b)) return [a, b];
    re.lastIndex = m.index + 1;
  }
  return null;
}

/** A clock time (HHMM, 24 h) in the text, as HH:MM; '' when none. */
function timeIn(text: string): string {
  for (const m of text.matchAll(/(?<!\d)([01]\d|2[0-3])([0-5]\d)(?!\d)/g)) return `${m[1]}:${m[2]}`;
  return '';
}

const NUM_ALT_FL = /(?<![A-Z0-9])FL\s?(\d{3})(?!\d)/, NUM_ALT = /(?<![A-Z0-9])ALT\s?(\d{4,5})(?!\d)/;
const NUM_KT = /(?<![A-Z0-9])(?:GS|SPD|TAS)\s?(\d{2,3})(?!\d)/, NUM_MACH = /(?<![A-Z0-9])(?:MACH\s?\.?|M\.)(\d{2,3})(?!\d)/;
const NUM_HDG = /(?<![A-Z0-9])(?:HDG|TRK)\s?(\d{3})(?!\d)/, NUM_FUEL = /(?<![A-Z0-9])(?:FOB|FUEL)\s?(\d{1,3}(?:\.\d{1,2})?)(?![\d.])/;
const NUM_ETA = /(?<![A-Z0-9])ETA\s?([01]\d|2[0-3])([0-5]\d)(?!\d)/;
/** The flight numbers a message's text states, each only from its label and only when in range. */
export function flightNums(text: string): FlightNums {
  const t = text.toUpperCase();
  const fl = NUM_ALT_FL.exec(t), alt = NUM_ALT.exec(t);
  let altFt: number | null = null;
  if (fl && +fl[1] >= 10 && +fl[1] <= 600) altFt = +fl[1] * 100;
  else if (alt && +alt[1] >= 100 && +alt[1] <= 60000) altFt = +alt[1];
  const kt = NUM_KT.exec(t), mach = NUM_MACH.exec(t), hdg = NUM_HDG.exec(t), fuel = NUM_FUEL.exec(t), eta = NUM_ETA.exec(t);
  const m = mach ? Number(`0.${mach[1]}`) : 0;
  return {
    altFt, kt: kt && +kt[1] >= 30 && +kt[1] <= 700 ? +kt[1] : null,
    mach: mach && m >= 0.2 && m < 1 ? `M.${mach[1]}` : '',
    hdg: hdg && +hdg[1] <= 360 ? +hdg[1] % 360 : null, fuel: fuel ? fuel[1] : '', eta: eta ? `${eta[1]}:${eta[2]}` : '',
  };
}
/** The numbers as short chips: FL350, 450 KT, M.78, HDG 270, FUEL 18.4, ETA 02:15. */
export function numChips(n: FlightNums): string[] {
  const out: string[] = [];
  if (n.altFt !== null) out.push(n.altFt >= 18000 && n.altFt % 100 === 0 ? `FL${String(n.altFt / 100).padStart(3, '0')}` : `${n.altFt.toLocaleString('en-US')} FT`);
  if (n.kt !== null) out.push(`${n.kt} KT`);
  if (n.mach) out.push(n.mach);
  if (n.hdg !== null) out.push(`HDG ${String(n.hdg).padStart(3, '0')}`);
  if (n.fuel) out.push(`FUEL ${n.fuel}`);
  if (n.eta) out.push(`ETA ${n.eta}`);
  return out;
}

const OOOI: Record<string, string> = { QA: 'out', QE: 'out', QB: 'off', QF: 'off', QC: 'on', QD: 'in' };
const OOOI_WORDS: Record<string, string> = { out: 'Out of the gate', off: 'Off the ground', on: 'On the ground', in: 'Into the gate' };
const POS_LABELS = new Set(['10', '11', '12', '13', '14', '15', '16', '17', '2Z']);

/** What one message is, in plain words. */
export function msgInsight(m: AcarsMsg, lookup: AirportLookup | null = null, home: LatLon | null = null): MsgInsight {
  const t = m.text, up = t.toUpperCase(), L = m.label;
  const airports = findAirports(t, lookup);
  const pos = findPositions(t, home)[0] ?? null;
  const route = findRoute(t, lookup);
  const apt = airports[0] ?? '';
  let kind = 'other', summary = '', phase = '';
  const digits = (t.match(/[\d\s.\-]/g) ?? []).length;
  const sub = /^\s*[#/]([A-Z0-9]{2})/.exec(up)?.[1] ?? '';
  if (OOOI[L]) {
    kind = OOOI[L]; phase = PHASES[kind];
    const at = timeIn(t);
    summary = `${OOOI_WORDS[kind]}${apt ? ` at ${apt}` : ''}${at ? ` · ${at}` : ''}`;
  } else if (L === 'Q0') { kind = 'link'; summary = 'Link test: the radio checking its datalink'; }
  else if (L === '_d' || L === '_j') { kind = 'ack'; summary = 'Acknowledgment, no text'; }
  else if (L === 'B9' || L === '33' || /\bATIS\b/.test(up)) {
    kind = 'atis';
    const info = /\bINFO(?:RMATION)?\s+([A-Z])\b/.exec(up)?.[1];
    summary = `ATIS${apt ? ` for ${apt}` : ''}${info ? ` · information ${info}` : ''}${L === '33' ? ' request' : ''}`;
  } else if (L === '4T' || L === '5U' || /\b(METAR|TAF|SPECI)\b/.test(up) || /\b\d{5}(G\d{2,3})?KT\b/.test(up)) {
    kind = 'wx'; summary = `Weather${apt ? ` for ${airports.slice(0, 3).join(', ')}` : ''}${L === '5U' ? ' request' : ''}`;
  } else if (POS_LABELS.has(L) || (pos && sub !== 'DF' && sub !== 'CF')) { kind = 'pos'; summary = pos ? `Position ${pos.lat.toFixed(2)}, ${pos.lon.toFixed(2)}` : 'Position report'; }
  else if (L === '8E' || /\bETA\s?\d{4}\b/.test(up)) { kind = 'eta'; const at = /\bETA\s?(\d{4})\b/.exec(up)?.[1]; summary = `ETA${apt ? ` ${apt}` : ''}${at ? ` ${at.slice(0, 2)}:${at.slice(2)}` : ''}`; }
  else if (L === '20') { kind = 'delay'; summary = 'Delay report'; }
  else if (L === 'C1' || L === 'RA') { kind = 'printer'; summary = 'To the cockpit printer'; }
  else if (L === 'SA') { kind = 'media'; summary = 'Media advisory: which datalinks are up'; }
  else if (L === 'H1' && sub === 'DF') { kind = 'engine'; summary = 'Engine and system readings for maintenance'; }
  else if (L === 'H1' && sub === 'CF') { kind = 'fault'; summary = 'Fault report from the maintenance computer'; }
  else if (L === 'H1' && /^M\d$/.test(sub)) { kind = 'fms'; summary = 'Flight management computer data'; }
  else if (L === 'AA' || (t.length >= 8 && /[A-Z]{3,}\s[A-Z]{3,}/.test(up) && digits < t.length * 0.5)) {
    kind = 'text'; summary = t.replace(/\s+/g, ' ').trim().slice(0, 80);
  } else if (t.length >= 20 && digits > t.length * 0.6) { kind = 'data'; summary = 'System data (numbers for the airline)'; }
  else if (L === '5Z' || L === '80') { kind = 'airline'; summary = 'Airline message'; }
  else if (L === '30') { kind = 'request'; summary = 'Request'; }
  else { const mean = labelMeaning(L); summary = mean ? mean[0].toUpperCase() + mean.slice(1) : t ? t.replace(/\s+/g, ' ').trim().slice(0, 80) : `Label ${L}`; }
  if (kind === 'pos' && pos) summary = `Position ${pos.lat.toFixed(2)}, ${pos.lon.toFixed(2)}${apt ? ` · ${apt}` : ''}`;
  return { kind, summary, airports, pos, phase, orig: route?.[0] ?? '', dest: route?.[1] ?? '', nums: flightNums(t) };
}

/** What a whole aircraft's messages add up to. */
export interface PlaneInsight {
  /** Newest message's insight. */
  last: MsgInsight | null;
  /** The newest out/off/on/in phase, '' when none. */
  phase: string; phaseMs: number;
  /** The newest decoded position and when. */
  pos: LatLon | null; posMs: number;
  orig: string; dest: string;
  airports: string[];
  /** The newest of each number the messages stated, and the newest message that stated any. */
  nums: FlightNums; numsMs: number;
  /** The heading stated in the same message as the position (for the map's arrow), else null. */
  posHdg: number | null;
}
export function planeInsight(msgs: AcarsMsg[], of: (m: AcarsMsg) => MsgInsight): PlaneInsight {
  const r: PlaneInsight = { last: null, phase: '', phaseMs: 0, pos: null, posMs: 0, orig: '', dest: '', airports: [],
    nums: { altFt: null, kt: null, mach: '', hdg: null, fuel: '', eta: '' }, numsMs: 0, posHdg: null };
  for (const m of msgs) {                                    // newest first
    const i = of(m);
    if (!r.last) r.last = i;
    if (!r.phase && i.phase) { r.phase = i.phase; r.phaseMs = m.ms; }
    if (!r.pos && i.pos) { r.pos = i.pos; r.posMs = m.ms; r.posHdg = i.nums.hdg; }
    const n = r.nums, x = i.nums;
    if (x.altFt !== null || x.kt !== null || x.mach || x.hdg !== null || x.fuel || x.eta) r.numsMs = Math.max(r.numsMs, m.ms);
    if (n.altFt === null) n.altFt = x.altFt;
    if (n.kt === null) n.kt = x.kt;
    if (!n.mach) n.mach = x.mach;
    if (n.hdg === null) n.hdg = x.hdg;
    if (!n.fuel) n.fuel = x.fuel;
    if (!n.eta) n.eta = x.eta;
    if (!r.orig && i.orig) { r.orig = i.orig; r.dest = i.dest; }
    for (const a of i.airports) if (!r.airports.includes(a) && r.airports.length < 6) r.airports.push(a);
  }
  return r;
}

// ---- airlines: designators (IATA two-character and ICAO three-letter), public data ----
const AIRLINES: [string, string, string][] = [
  // US mainline, low-cost and regional
  ['AA', 'AAL', 'American'], ['UA', 'UAL', 'United'], ['DL', 'DAL', 'Delta'], ['WN', 'SWA', 'Southwest'], ['AS', 'ASA', 'Alaska'],
  ['B6', 'JBU', 'JetBlue'], ['NK', 'NKS', 'Spirit'], ['F9', 'FFT', 'Frontier'], ['G4', 'AAY', 'Allegiant'], ['HA', 'HAL', 'Hawaiian'],
  ['SY', 'SCX', 'Sun Country'], ['MX', 'MXY', 'Breeze'], ['XP', 'VXP', 'Avelo'], ['QX', 'QXE', 'Horizon'], ['OO', 'SKW', 'SkyWest'],
  ['YX', 'RPA', 'Republic'], ['MQ', 'ENY', 'Envoy'], ['9E', 'EDV', 'Endeavor'], ['OH', 'JIA', 'PSA'], ['YV', 'ASH', 'Mesa'],
  ['PT', 'PDT', 'Piedmont'], ['ZW', 'AWI', 'Air Wisconsin'], ['G7', 'GJS', 'GoJet'], ['C5', 'UCA', 'CommutAir'], ['KS', 'PEN', 'PenAir'],
  // US cargo
  ['FX', 'FDX', 'FedEx'], ['5X', 'UPS', 'UPS'], ['5Y', 'GTI', 'Atlas Air'], ['K4', 'CKS', 'Kalitta'], ['PO', 'PAC', 'Polar'],
  ['GB', 'ABX', 'ABX Air'], ['8C', 'ATN', 'ATI'], ['NC', 'NAC', 'Northern Air Cargo'], ['KH', 'AAH', 'Aloha Air Cargo'],
  // Canada, Mexico, Latin America
  ['AC', 'ACA', 'Air Canada'], ['WS', 'WJA', 'WestJet'], ['TS', 'TSC', 'Air Transat'], ['PD', 'POE', 'Porter'], ['F8', 'FLE', 'Flair'],
  ['WG', 'SWG', 'Sunwing'], ['AM', 'AMX', 'Aeromexico'], ['Y4', 'VOI', 'Volaris'], ['VB', 'VIV', 'Viva Aerobus'], ['CM', 'CMP', 'Copa'],
  ['AV', 'AVA', 'Avianca'], ['LA', 'LAN', 'LATAM'], ['JJ', 'TAM', 'LATAM Brasil'], ['AR', 'ARG', 'Aerolineas Argentinas'], ['G3', 'GLO', 'Gol'],
  ['AD', 'AZU', 'Azul'],
  // Europe, Middle East, Africa
  ['BA', 'BAW', 'British Airways'], ['VS', 'VIR', 'Virgin Atlantic'], ['AF', 'AFR', 'Air France'], ['KL', 'KLM', 'KLM'], ['LH', 'DLH', 'Lufthansa'],
  ['LX', 'SWR', 'Swiss'], ['OS', 'AUA', 'Austrian'], ['SN', 'BEL', 'Brussels'], ['EI', 'EIN', 'Aer Lingus'], ['IB', 'IBE', 'Iberia'],
  ['AZ', 'ITY', 'ITA Airways'], ['TP', 'TAP', 'TAP Air Portugal'], ['SK', 'SAS', 'SAS'], ['AY', 'FIN', 'Finnair'], ['LO', 'LOT', 'LOT'],
  ['TK', 'THY', 'Turkish'], ['EK', 'UAE', 'Emirates'], ['QR', 'QTR', 'Qatar'], ['EY', 'ETD', 'Etihad'], ['SV', 'SVA', 'Saudia'],
  ['LY', 'ELY', 'El Al'], ['MS', 'MSR', 'EgyptAir'], ['ET', 'ETH', 'Ethiopian'], ['CV', 'CLX', 'Cargolux'],
  // Asia and the Pacific
  ['NH', 'ANA', 'ANA'], ['JL', 'JAL', 'Japan Airlines'], ['ZG', 'TZP', 'ZIPAIR'], ['KE', 'KAL', 'Korean Air'], ['OZ', 'AAR', 'Asiana'],
  ['CX', 'CPA', 'Cathay Pacific'], ['CI', 'CAL', 'China Airlines'], ['BR', 'EVA', 'EVA Air'], ['CA', 'CCA', 'Air China'],
  ['MU', 'CES', 'China Eastern'], ['CZ', 'CSN', 'China Southern'], ['HU', 'CHH', 'Hainan'], ['SQ', 'SIA', 'Singapore'],
  ['PR', 'PAL', 'Philippine'], ['5J', 'CEB', 'Cebu Pacific'], ['VN', 'HVN', 'Vietnam Airlines'], ['TG', 'THA', 'Thai'], ['AI', 'AIC', 'Air India'],
  ['QF', 'QFA', 'Qantas'], ['NZ', 'ANZ', 'Air New Zealand'], ['FJ', 'FJI', 'Fiji Airways'],
];
const BY_IATA = new Map(AIRLINES.map(([i, , n]) => [i, n]));
const BY_ICAO = new Map(AIRLINES.map(([, c, n]) => [c, n]));

/** The airline of a flight number (UA2282, UAL2282, AS 1310): its name, '' when not in the table. */
export function airlineOf(flight: string): string {
  const f = flight.toUpperCase().replace(/\s/g, '');
  const icao = /^([A-Z]{3})\d/.exec(f)?.[1];
  if (icao && BY_ICAO.has(icao)) return BY_ICAO.get(icao)!;
  const iata = /^([A-Z0-9]{2})\d/.exec(f)?.[1];
  if (iata && /[A-Z]/.test(iata) && BY_IATA.has(iata)) return BY_IATA.get(iata)!;
  return '';
}

// ---- VDL2: every aircraft and ground station heard, by their 24-bit AVLC addresses ----
/** One AVLC frame as the decoder's onFrame gives it. */
export interface AvlcFrame { hz: number; ms: number; snrDb: number; src: number; srcType: number; dst: number; dstType: number; ctrl: number; info: number[] }
export interface VdlEvent { ms: number; text: string }
export interface VdlAircraft {
  addr: string; firstMs: number; lastMs: number; frames: number; snr: number; snrs: number[];
  reg: string; flight: string; acars: number;
  /** Ground stations it worked, by address, last heard. */
  stations: Map<string, number>;
  /** The station it last talked to. */
  station: string;
  hz: number; events: VdlEvent[];
  /** The parameters of the newest XID it sent ('' when none). */
  xid: string;
}
export interface VdlStation {
  addr: string; firstMs: number; lastMs: number; frames: number;
  /** SNR of what it sent; null when it has not been heard itself. */
  snr: number | null;
  /** The airport its XIDs name, and whether the station itself said it (else an aircraft did). */
  airport: string; airportOwn: boolean;
  /** The newest XID it sent, and the newest an aircraft sent it (info octets; the airport is read from these). */
  xidOwn: number[]; xidHeard: number[];
  aircraft: Map<string, number>; hz: number;
}
export const VDL_EVENT_KEEP = 20;
export const VDL_LINK_MS = 10 * 60_000;
/** The VDL2 channels, for the per-channel counts (the decoder's list). */
export const VDL2_CHANNELS = [136_975_000, 136_650_000, 136_700_000, 136_725_000, 136_775_000, 136_800_000, 136_825_000,
  136_875_000, 136_900_000, 136_925_000, 136_950_000, 136_100_000];
const h6 = (n: number) => n.toString(16).toUpperCase().padStart(6, '0');
const isGround = (t: number) => t === 4 || t === 5;
/** I, S, XID, UI or U from the AVLC control octet. */
export function frameKind(ctrl: number): string {
  return (ctrl & 1) === 0 ? 'I' : (ctrl & 3) === 1 ? 'S' : (ctrl & 0xEF) === 0xAF ? 'XID' : (ctrl & 0xEF) === 0x03 ? 'UI' : 'U';
}
/** Registration and flight of ACARS carried in a frame (FF FF 01, then the ACARS block); null when it is not ACARS. */
export function frameAcars(info: number[], down: boolean): { reg: string; flight: string } | null {
  if (info.length < 16 || info[0] !== 0xFF || info[1] !== 0xFF || info[2] !== 0x01) return null;
  const b = info.slice(3).map(x => x & 0x7F), ch = (i: number) => String.fromCharCode(b[i]);
  let reg = ''; for (let i = 1; i <= 7; i++) reg += ch(i);
  reg = reg.replace(/^[. ]+|[. ]+$/g, '');
  let flight = '';
  if (down && b[12] === 0x02 && b.length - 13 >= 11) { for (let i = 17; i < 23; i++) flight += ch(i); flight = flight.trim(); }
  return { reg, flight };
}
/** One XID parameter: its group (0x80 public, 0xF0 VDL private), id and value octets. */
export interface XidParam { group: number; id: number; value: number[] }
/**
 * An XID frame's parameters (ISO 8885 layout, as on our recordings): format 0x82, then groups of an id, a 2-octet
 * length and parameters of id, 1-octet length, value. Null when the octets do not hold together that way.
 */
export function xidParams(info: number[]): XidParam[] | null {
  if (info.length < 4 || info[0] !== 0x82) return null;
  const out: XidParam[] = [];
  let p = 1;
  while (p < info.length) {
    if (p + 3 > info.length) return null;
    const group = info[p], len = (info[p + 1] << 8) | info[p + 2], end = p + 3 + len;
    if (end > info.length) return null;
    let q = p + 3;
    while (q < end) {
      if (q + 2 > end) return null;
      const id = info[q], n = info[q + 1];
      if (q + 2 + n > end) return null;
      out.push({ group, id, value: info.slice(q + 2, q + 2 + n) });
      q += 2 + n;
    }
    p = end;
  }
  return out;
}
/** The airports an XID names: parameter values that are four letters and a known airport (else, when the frame does
 *  not parse as parameters, four-letter codes in its text). */
export function xidAirports(info: number[], lookup: AirportLookup | null): string[] {
  const ps = xidParams(info);
  if (!ps) return findAirports(frameText(info), lookup);
  const out: string[] = [];
  for (const x of ps) {
    if (x.value.length !== 4 || !x.value.every(c => c >= 0x41 && c <= 0x5A)) continue;
    const c = String.fromCharCode(...x.value);
    if (!NOT_AIRPORTS.has(c) && lookup?.(c) && !out.includes(c)) out.push(c);
  }
  return out;
}
/** The parameters as a short line for the panel: 80/01 8885:1993 · F0/83 KLGB · F0/04 25 ... */
export function xidSummary(info: number[]): string {
  const ps = xidParams(info);
  if (!ps) return '';
  return ps.map(x => {
    const txt = x.value.length >= 2 && x.value.every(c => c >= 0x20 && c < 0x7F);
    return `${x.group.toString(16).toUpperCase()}/${x.id.toString(16).toUpperCase().padStart(2, '0')} ${txt ? String.fromCharCode(...x.value) : x.value.map(c => c.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
  }).join(' · ');
}

/** The printable text of a frame's info field. */
export const frameText = (info: number[]) => info.map(x => { const c = x & 0x7F; return c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ' '; }).join('');

export class Vdl2Tracker {
  readonly aircraft = new Map<string, VdlAircraft>();
  readonly stations = new Map<string, VdlStation>();
  /** Frames by channel (Hz). */
  readonly chans = new Map<number, number>();
  frames = 0;
  constructor(public lookup: AirportLookup | null = null) {}
  add(f: AvlcFrame): void {
    this.frames++;
    this.chans.set(f.hz, (this.chans.get(f.hz) ?? 0) + 1);
    const down = f.srcType === 1, upl = f.dstType === 1 && isGround(f.srcType);
    const acAddr = down ? f.src : upl ? f.dst : -1;
    const gsAddr = down && isGround(f.dstType) ? f.dst : isGround(f.srcType) ? f.src : -1;
    const kind = frameKind(f.ctrl);
    let gs: VdlStation | undefined;
    if (gsAddr >= 0) {
      const k = h6(gsAddr);
      gs = this.stations.get(k);
      if (!gs) { gs = { addr: k, firstMs: f.ms, lastMs: f.ms, frames: 0, snr: null, airport: '', airportOwn: false, xidOwn: [], xidHeard: [], aircraft: new Map(), hz: f.hz }; this.stations.set(k, gs); }
      gs.frames++; gs.lastMs = f.ms; gs.hz = f.hz;
      if (isGround(f.srcType)) gs.snr = f.snrDb;
      if (kind === 'XID') { if (isGround(f.srcType)) gs.xidOwn = f.info; else gs.xidHeard = f.info; }
      this.placeStation(gs);
    }
    if (acAddr < 0) return;
    const k = h6(acAddr);
    let a = this.aircraft.get(k);
    if (!a) {
      a = { addr: k, firstMs: f.ms, lastMs: f.ms, frames: 0, snr: 0, snrs: [], reg: '', flight: '', acars: 0, stations: new Map(), station: '', hz: f.hz, events: [], xid: '' };
      this.aircraft.set(k, a);
    }
    a.lastMs = f.ms; a.hz = f.hz;
    a.frames++;
    if (down) { a.snr = f.snrDb; a.snrs.push(f.snrDb); if (a.snrs.length > 30) a.snrs.shift(); }
    const ac = frameAcars(f.info, down);
    if (ac) { a.acars++; if (ac.reg) a.reg = ac.reg; if (ac.flight) a.flight = ac.flight; }
    if (kind === 'XID' && down) a.xid = xidSummary(f.info) || a.xid;
    if (gs) {
      gs.aircraft.set(k, f.ms);
      if (kind === 'XID') {
        const where = gs.airport ? ` (${gs.airport})` : '';
        const text = a.station && a.station !== gs.addr ? `handoff ${a.station} → ${gs.addr}${where}` : `link with ${gs.addr}${where}`;
        if (a.events[0]?.text !== text || f.ms - a.events[0].ms > 60_000) { a.events.unshift({ ms: f.ms, text }); if (a.events.length > VDL_EVENT_KEEP) a.events.length = VDL_EVENT_KEEP; }
      }
      a.stations.set(gs.addr, f.ms); a.station = gs.addr;
    }
  }
  /** The airport a station's XIDs name: its own XID says where it is; one an aircraft sent it only hints. Read again
   *  whenever asked, so the airports arriving after the frames still place it. */
  placeStation(gs: VdlStation): void {
    const own = xidAirports(gs.xidOwn, this.lookup)[0], heard = xidAirports(gs.xidHeard, this.lookup)[0];
    gs.airport = own ?? heard ?? ''; gs.airportOwn = !!own;
  }
  /** Most recently heard first. */
  list(): VdlAircraft[] { return [...this.aircraft.values()].sort((x, y) => y.lastMs - x.lastMs || (x.addr < y.addr ? -1 : 1)); }
  stationList(): VdlStation[] { for (const g of this.stations.values()) this.placeStation(g); return [...this.stations.values()].sort((x, y) => y.lastMs - x.lastMs || (x.addr < y.addr ? -1 : 1)); }
  /** Aircraft ↔ station pairs heard within [ms] of [now]. */
  links(now: number, ms = VDL_LINK_MS): [string, string][] {
    const out: [string, string][] = [];
    for (const a of this.aircraft.values()) for (const [g, t] of a.stations) if (now - t <= ms) out.push([a.addr, g]);
    return out;
  }
  clear(): void { this.aircraft.clear(); this.stations.clear(); this.chans.clear(); this.frames = 0; }
}

/** The ACARS record of a VDL2 aircraft: by its registration, else its flight. */
export function acarsFor(a: VdlAircraft, planes: Map<string, AcarsPlane>): AcarsPlane | undefined {
  return (a.reg ? planes.get(`R:${a.reg}`) : undefined) ?? (a.flight ? planes.get(`F:${a.flight}`) : undefined);
}

// ---- activity: messages a minute, by channel, by kind, by airline ----
export const STATS_MINUTES = 30;
export class AcarsStats {
  /** Messages per minute (keyed by minute since the epoch). */
  readonly perMin = new Map<number, number>();
  readonly chans = new Map<string, number>();
  readonly kinds = new Map<string, number>();
  /** Airline → aircraft keys heard. */
  readonly airlines = new Map<string, Set<string>>();
  total = 0;
  add(ms: number, mhz: string, kind: string, airline: string, planeKey: string): void {
    this.total++;
    const min = Math.floor(ms / 60_000);
    this.perMin.set(min, (this.perMin.get(min) ?? 0) + 1);
    for (const k of this.perMin.keys()) if (k < min - STATS_MINUTES * 2) this.perMin.delete(k);
    this.chans.set(mhz, (this.chans.get(mhz) ?? 0) + 1);
    this.kinds.set(kind, (this.kinds.get(kind) ?? 0) + 1);
    if (airline && planeKey) { let s = this.airlines.get(airline); if (!s) this.airlines.set(airline, s = new Set()); s.add(planeKey); }
  }
  /** The last STATS_MINUTES minutes' counts, oldest first, ending at [now]'s minute. */
  minutes(now: number): number[] {
    const end = Math.floor(now / 60_000), out: number[] = [];
    for (let k = end - STATS_MINUTES + 1; k <= end; k++) out.push(this.perMin.get(k) ?? 0);
    return out;
  }
  topAirlines(n = 6): [string, number][] { return [...this.airlines].map(([k, s]) => [k, s.size] as [string, number]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n); }
  kindList(): [string, number][] { return [...this.kinds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); }
  clear(): void { this.perMin.clear(); this.chans.clear(); this.kinds.clear(); this.airlines.clear(); this.total = 0; }
}
