/**
 * ACARS aircraft: the decoder's message lines grouped into one record per aircraft (by registration, else flight),
 * each with its messages, so the screen can show a card per aircraft and link it to the same aircraft in ADS-B.
 *
 * A US registration (N-number) maps to its ICAO 24-bit address by the FAA's allocation (nNumberToIcao), so an ACARS
 * aircraft can be matched to an ADS-B one even before any registration lookup.
 *
 * Twin ports: core/apps/AcarsPlanes.kt and core/apps/AcarsPlanes.swift (same names, same constants).
 */

/** One ACARS message, as the decoder's line gives it. */
export interface AcarsMsg {
  mhz: string; down: boolean; reg: string; label: string; blk: string; ack: string; msn: string; flight: string;
  crcOk: boolean; mode: string; text: string; ms: number;
}
/**
 * Reads one decoder line: `ACARS 131.550 ↓ N12345  H1  blk 3  ack NAK  #M01A UA1234  CRC?  mode 2` with the text on
 * the next line (the CRC and mode parts only when they say something). Null for any other line.
 */
const HEAD = /^ACARS (\d+[.,]\d{3}) ([↓↑]) (.*?)  (..)  blk (.)  ack (NAK|.)(?:  #(.{4}) (\S*))?(  CRC\?)?(?:  mode (.))?$/;
export function parseAcarsLine(line: string, ms: number): AcarsMsg | null {
  const nl = line.indexOf('\n');
  const head = nl >= 0 ? line.slice(0, nl) : line, text = nl >= 0 ? line.slice(nl + 1) : '';
  const m = HEAD.exec(head);
  if (!m) return null;
  return { mhz: m[1].replace(',', '.'), down: m[2] === '↓', reg: m[3].trim(), label: m[4], blk: m[5], ack: m[6], msn: m[7] ?? '', flight: (m[8] ?? '').trim(),
    crcOk: !m[9], mode: m[10] ?? '2', text, ms };
}

/** What the common message labels mean (ARINC 618/620). */
const LABELS: [string, string][] = [
  ['_d', 'no information'], ['H1', 'message to/from crew or system'], ['Q0', 'link test'], ['QA', 'out of gate'],
  ['QB', 'off the ground'], ['QC', 'on the ground'], ['QD', 'into the gate'], ['QE', 'out / fuel'], ['QF', 'off / destination'],
  ['10', 'position / ETA'], ['11', 'position'], ['12', 'position'], ['13', 'position'], ['14', 'position'], ['15', 'position'],
  ['16', 'position'], ['17', 'position'], ['20', 'delay'], ['2Z', 'progress report'], ['30', 'request'], ['33', 'ATIS request'],
  ['4T', 'weather'], ['5U', 'weather request'], ['5Z', 'airline designated'], ['80', 'airline designated'], ['8E', 'ETA'],
  ['AA', 'free text'], ['B9', 'ATIS'], ['C1', 'uplink to cockpit printer'], ['RA', 'uplink to cockpit printer'], ['SA', 'media advisory'],
  ['SQ', 'squitter (ground station)'], ['_j', 'no information'],
];
/** A message label's meaning ('' when unknown). */
export function labelMeaning(label: string): string {
  for (const [k, v] of LABELS) if (k === label) return v;
  return '';
}

/** One aircraft heard on ACARS. */
export interface AcarsPlane {
  key: string; reg: string; flight: string; firstMs: number; lastMs: number; count: number;
  /** Newest first, capped at MSG_KEEP. */
  msgs: AcarsMsg[];
  /** Its ICAO address when the registration says it (US N-numbers), else ''. */
  icao: string;
}
export const MSG_KEEP = 100;
/** The key an aircraft is kept under: its registration, else its flight; ground stations and empty headers ''. */
export function planeKey(m: AcarsMsg): string {
  if (m.label === 'SQ') return '';
  return m.reg ? `R:${m.reg}` : m.flight ? `F:${m.flight}` : '';
}

/** One record per aircraft. */
export class AcarsPlanes {
  readonly planes = new Map<string, AcarsPlane>();
  /** Every message, aircraft or not, newest first (for the LOG view's count). */
  total = 0;
  add(m: AcarsMsg): AcarsPlane | null {
    this.total++;
    const key = planeKey(m);
    if (!key) return null;
    let p = this.planes.get(key);
    // a flight first heard without its registration joins the registration's record once both show up together
    if (!p && m.reg && m.flight) {
      const byFlight = this.planes.get(`F:${m.flight}`);
      if (byFlight) { this.planes.delete(byFlight.key); byFlight.key = key; this.planes.set(key, byFlight); p = byFlight; }
    }
    if (!p) {
      p = { key, reg: '', flight: '', firstMs: m.ms, lastMs: m.ms, count: 0, msgs: [], icao: '' };
      this.planes.set(key, p);
    }
    p.count++; p.lastMs = m.ms;
    if (m.reg) { p.reg = m.reg; p.icao = nNumberToIcao(m.reg); }
    if (m.flight) p.flight = m.flight;
    p.msgs.unshift(m); if (p.msgs.length > MSG_KEEP) p.msgs.length = MSG_KEEP;
    return p;
  }
  /** Most recently heard first (messages are minutes apart, so the order moves slowly). */
  list(): AcarsPlane[] { return [...this.planes.values()].sort((a, b) => b.lastMs - a.lastMs || (a.key < b.key ? -1 : 1)); }
  clear(): void { this.planes.clear(); this.total = 0; }
}

// ---- US N-number to ICAO address (the FAA allocates A00001..ADF7C7 in N-number order) ----
const NN_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';            // no I or O
const NN_SUFFIX = 1 + NN_LETTERS.length * (1 + NN_LETTERS.length);   // 601: none, A..Z, AA..ZZ
const NN_B4 = 1 + NN_LETTERS.length + 10;                  // 35
const NN_B3 = 10 * NN_B4 + NN_SUFFIX;                      // 951
const NN_B2 = 10 * NN_B3 + NN_SUFFIX;                      // 10111
const NN_B1 = 10 * NN_B2 + NN_SUFFIX;                      // 101711
function nnSuffix(s: string): number {
  if (!s) return 0;
  let v = NN_LETTERS.indexOf(s[0]) * (NN_LETTERS.length + 1) + 1;
  if (s.length === 2) v += NN_LETTERS.indexOf(s[1]) + 1;
  return v;
}
/** The ICAO address (6 hex digits, upper case) of a US registration like N628TS or N-628TS; '' when it is not one. */
export function nNumberToIcao(reg: string): string {
  const r = reg.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^N[1-9][0-9]{0,4}$|^N[1-9][0-9]{0,3}[A-HJ-NP-Z]{1,2}$/.test(r) || r.length > 6) return '';
  const n = r.slice(1);
  let out = 0xA00001 + (Number(n[0]) - 1) * NN_B1;
  const isL = (c: string) => NN_LETTERS.includes(c);
  const done = () => out.toString(16).toUpperCase().padStart(6, '0');
  if (n.length === 1) return done();
  if (isL(n[1])) { out += nnSuffix(n.slice(1)); return done(); }
  out += Number(n[1]) * NN_B2 + NN_SUFFIX;
  if (n.length === 2) return done();
  if (isL(n[2])) { out += nnSuffix(n.slice(2)); return done(); }
  out += Number(n[2]) * NN_B3 + NN_SUFFIX;
  if (n.length === 3) return done();
  if (isL(n[3])) { out += nnSuffix(n.slice(3)); return done(); }
  out += Number(n[3]) * NN_B4 + NN_SUFFIX;
  if (n.length === 4) return done();
  if (isL(n[4])) { out += 1 + NN_LETTERS.indexOf(n[4]); return done(); }
  out += 1 + NN_LETTERS.length + Number(n[4]);
  return done();
}
/** A registration without its dash or dots, for matching (N-628TS and N628TS are the same aircraft). */
export const normReg = (r: string) => r.toUpperCase().replace(/[^A-Z0-9]/g, '');
