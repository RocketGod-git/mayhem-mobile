/**
 * NOAA Weather Radio / EAS "SAME" decoder (Specific Area Message Encoding): the 520.83 baud AFSK burst that
 * opens and closes every NWR and EAS alert. Runs on the NFM discriminator like the packet decoders.
 *
 * A header is sent three times with about a second of silence between copies. Each copy is decoded on its
 * own and the copies are then voted character by character, so a single hit in one copy does not cost the
 * alert, and only a result that fits the published structure exactly is reported — a half-parsed alert is
 * worse than none, because someone may act on it. The attention tone between the header and the voice
 * message is reported as well: it is what tells a listener an alert is real rather than a weekly test.
 *
 * Expected input: discriminator audio in radians/sample at any scale (decisions are sign-based), 24–96 kHz.
 */
import { BitSync, DiscFilter, type Emit, type IqProcessor } from './core.js';

/** The bit period is exactly 1.92 ms; mark is four cycles per bit and space three, which keeps the two tones orthogonal over one bit. */
export const SAME_BAUD = 520 + 5 / 6;
const MARK_HZ = 4 * SAME_BAUD;    // 2083.33 Hz = logic 1
const SPACE_HZ = 3 * SAME_BAUD;   // 1562.5 Hz = logic 0
const PREAMBLE = 0xab;

export const SAME_ORIGINATORS: Record<string, string> = {
  PEP: 'Primary Entry Point',
  CIV: 'Civil authorities',
  WXR: 'National Weather Service',
  EAS: 'Broadcast station',
};

export const SAME_EVENTS: Record<string, string> = {
  RWT: 'Required Weekly Test', RMT: 'Required Monthly Test', NPT: 'National Periodic Test', DMO: 'Practice/Demo',
  ADR: 'Administrative Message', EAN: 'Emergency Action Notification', EAT: 'Emergency Action Termination',
  TOR: 'Tornado Warning', TOA: 'Tornado Watch', SVR: 'Severe Thunderstorm Warning', SVA: 'Severe Thunderstorm Watch',
  SVS: 'Severe Weather Statement', SPS: 'Special Weather Statement',
  FFW: 'Flash Flood Warning', FFA: 'Flash Flood Watch', FFS: 'Flash Flood Statement',
  FLW: 'Flood Warning', FLA: 'Flood Watch', FLS: 'Flood Statement',
  WSW: 'Winter Storm Warning', WSA: 'Winter Storm Watch', BZW: 'Blizzard Warning',
  HWW: 'High Wind Warning', HWA: 'High Wind Watch', EWW: 'Extreme Wind Warning',
  HUW: 'Hurricane Warning', HUA: 'Hurricane Watch', HLS: 'Hurricane Statement',
  TRW: 'Tropical Storm Warning', TRA: 'Tropical Storm Watch',
  SMW: 'Special Marine Warning', CFW: 'Coastal Flood Warning', CFA: 'Coastal Flood Watch',
  TSW: 'Tsunami Warning', TSA: 'Tsunami Watch', DSW: 'Dust Storm Warning',
  FRW: 'Fire Warning', AVW: 'Avalanche Warning', AVA: 'Avalanche Watch', VOW: 'Volcano Warning', EQW: 'Earthquake Warning',
  EVI: 'Evacuation Immediate', CEM: 'Civil Emergency Message', CDW: 'Civil Danger Warning', CAE: 'Child Abduction Emergency',
  LEW: 'Law Enforcement Warning', LAE: 'Local Area Emergency', HMW: 'Hazardous Materials Warning',
  NUW: 'Nuclear Power Plant Warning', RHW: 'Radiological Hazard Warning', SPW: 'Shelter in Place Warning',
  TOE: '911 Telephone Outage Emergency', NMN: 'Network Message Notification',
};

export interface SameLocation { code: string; portion: number; state: string; county: string }
export interface SameHeader {
  originator: string; originatorName: string;   // name falls back to the code itself when the code is not in the table
  event: string; eventName: string;
  locations: SameLocation[];
  duration: { hours: number; minutes: number };
  issued: { day: number; hour: number; minute: number };   // day of year and UTC time of issue
  callsign: string;
}

/**
 * Anchored at the start only: a copy that was closed by noise may carry junk after its final '-', and the
 * structure is fixed-width once the location list ends, so the match itself tells where the header stops.
 */
const HEADER_RE = /^ZCZC-([A-Z]{3})-([A-Z]{3})((?:-\d{6}){1,31})\+(\d{4})-(\d{7})-([\x20-\x7e]{8})-/;
const MAX_MSG = 256;   // 31 location groups plus the fixed part is 252 characters

/** Parse a raw header string; null when it does not fit the structure or carries an impossible time. */
export function parseSameHeader(raw: string): SameHeader | null {
  const m = HEADER_RE.exec(raw);
  if (!m) return null;
  const [, originator, event, locs, tttt, jjjhhmm, call] = m;
  const locations = locs.slice(1).split('-').map(code => ({ code, portion: Number(code[0]), state: code.slice(1, 3), county: code.slice(3) }));
  const duration = { hours: Number(tttt.slice(0, 2)), minutes: Number(tttt.slice(2)) };
  const issued = { day: Number(jjjhhmm.slice(0, 3)), hour: Number(jjjhhmm.slice(3, 5)), minute: Number(jjjhhmm.slice(5)) };
  // a time that cannot exist means a corrupted digit survived the vote; better silent than wrong by a day
  if (duration.minutes > 59 || issued.day < 1 || issued.day > 366 || issued.hour > 23 || issued.minute > 59) return null;
  return {
    originator, originatorName: SAME_ORIGINATORS[originator] ?? originator,
    event, eventName: SAME_EVENTS[event] ?? event,
    locations, duration, issued, callsign: call.trim(),
  };
}

/** The end of the raw header as matched, so trailing junk from a noisy copy is not reported as part of it. */
function headerEnd(raw: string): number { const m = HEADER_RE.exec(raw); return m ? m[0].length : 0; }

type Kind = 'header' | 'eom';

/** How many of the first four characters agree with the expected opener; a shifted or junk copy scores under three. */
function opener(s: string, want: string): number { let n = 0; for (let i = 0; i < 4; i++) if (s[i] === want[i]) n++; return n; }

export class SameDecoder implements IqProcessor {
  readonly wantsFm = true;
  private rate = 0;
  private t = 0;                                   // samples processed; the clock the repeat window runs on
  // sliding one-bit correlators, as the APRS decoder does them
  private spb = 92;
  private ring = new Float32Array(92);
  private ri = 0;
  private ph1 = 0; private ph2 = 0; private w1 = 0; private w2 = 0;
  private c1 = 0; private s1 = 0; private c2 = 0; private s2 = 0;
  private sinceRecompute = 0;
  private sync = new BitSync(SAME_BAUD, 48000);
  private filt = new DiscFilter(3000, 48000);
  // bit → byte assembly
  private sr = 0;                                  // the last 32 bits, newest at the top: LSB-first bytes read straight out
  private synced = false;
  private cur = 0; private bitIdx = 0;
  private msg = '';
  private inMsg = false;
  // the three copies of a burst
  private group: { kind: Kind; copies: string[]; lastT: number } | null = null;
  // attention-tone detector: Goertzel bins over 50 ms blocks
  private blockN = 2400;
  private coef = [0, 0, 0];                        // 1050, 853, 960 Hz
  private g1 = [0, 0, 0]; private g2 = [0, 0, 0];
  private energy = 0; private blockI = 0;
  private toneRun = 0; private toneKind = ''; private toneQuiet = 0; private toneArmed = true;

  constructor(private readonly emit: Emit) {}

  reset(rate: number): void {
    if (rate > 0) this.configure(rate); else this.rate = 0;
  }
  onIq(): void {}

  private configure(rate: number): void {
    this.rate = rate; this.t = 0;
    this.spb = Math.max(8, Math.round(rate / SAME_BAUD));
    this.ring = new Float32Array(this.spb); this.ri = 0;
    this.w1 = 2 * Math.PI * MARK_HZ / rate; this.w2 = 2 * Math.PI * SPACE_HZ / rate;
    this.ph1 = this.ph2 = this.c1 = this.s1 = this.c2 = this.s2 = 0; this.sinceRecompute = 0;
    this.sync = new BitSync(SAME_BAUD, rate);
    // both tones sit under 2.1 kHz; 3 kHz keeps them intact and takes out the discriminator's rising noise above
    this.filt = new DiscFilter(3000, rate);
    this.sr = 0; this.synced = false; this.cur = 0; this.bitIdx = 0; this.msg = ''; this.inMsg = false;
    this.group = null;
    this.blockN = Math.round(rate / 20);
    this.coef = [1050, 853, 960].map(f => 2 * Math.cos(2 * Math.PI * f / rate));
    this.g1 = [0, 0, 0]; this.g2 = [0, 0, 0]; this.energy = 0; this.blockI = 0;
    this.toneRun = 0; this.toneKind = ''; this.toneQuiet = 0; this.toneArmed = true;
  }

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.rate) this.configure(rate);
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      const x = this.filt.push(samples[i]);
      const old = this.ring[this.ri];
      this.ring[this.ri] = x;
      this.ri = this.ri + 1 >= this.spb ? 0 : this.ri + 1;
      let o1 = this.ph1 - this.w1 * this.spb; while (o1 < 0) o1 += twoPi;
      let o2 = this.ph2 - this.w2 * this.spb; while (o2 < 0) o2 += twoPi;
      this.c1 += x * Math.cos(this.ph1) - old * Math.cos(o1); this.s1 += x * Math.sin(this.ph1) - old * Math.sin(o1);
      this.c2 += x * Math.cos(this.ph2) - old * Math.cos(o2); this.s2 += x * Math.sin(this.ph2) - old * Math.sin(o2);
      this.ph1 += this.w1; if (this.ph1 >= twoPi) this.ph1 -= twoPi;
      this.ph2 += this.w2; if (this.ph2 >= twoPi) this.ph2 -= twoPi;
      if (++this.sinceRecompute >= 4096) { this.sinceRecompute = 0; this.recompute(); }
      const d = (this.c1 * this.c1 + this.s1 * this.s1) - (this.c2 * this.c2 + this.s2 * this.s2);
      const b = this.sync.push(d);
      if (b >= 0) this.pushBit(b);
      this.tone(x);
    }
    this.t += n;
    // a copy that never came: report what the earlier copies agreed on once the third is overdue
    if (this.group && this.t - this.group.lastT > 2.5 * this.rate) this.finalize();
  }

  /** Rebuild the running sums from the ring so floating-point drift never accumulates across a long watch. */
  private recompute(): void {
    const twoPi = 2 * Math.PI;
    this.c1 = this.s1 = this.c2 = this.s2 = 0;
    for (let j = 0; j < this.spb; j++) {
      const v = this.ring[(this.ri + j) % this.spb];
      let a1 = this.ph1 - this.w1 * (this.spb - j); while (a1 < 0) a1 += twoPi;
      let a2 = this.ph2 - this.w2 * (this.spb - j); while (a2 < 0) a2 += twoPi;
      this.c1 += v * Math.cos(a1); this.s1 += v * Math.sin(a1); this.c2 += v * Math.cos(a2); this.s2 += v * Math.sin(a2);
    }
  }

  private pushBit(bit: number): void {
    this.sr = ((this.sr >>> 1) | (bit << 31)) >>> 0;
    if (!this.synced) {
      // 0xAB's eight rotations are all distinct, so one byte fixes the alignment; four in a row make it a
      // preamble rather than a coincidence in noise
      if (this.sr === 0xabababab) { this.synced = true; this.bitIdx = 0; this.cur = 0; this.msg = ''; this.inMsg = false; }
      return;
    }
    this.cur = (this.cur >> 1) | (bit << 7);
    if (++this.bitIdx < 8) return;
    const byte = this.cur; this.bitIdx = 0; this.cur = 0;
    if (!this.inMsg) {
      if (byte === PREAMBLE) return;   // the rest of the preamble
      this.inMsg = true;
    }
    if (byte < 0x20 || byte > 0x7e || this.msg.length >= MAX_MSG) { this.close(); return; }
    this.msg += String.fromCharCode(byte);
    // a clean copy ends on its final '-' (or the fourth N); closing there keeps whatever follows out of the vote
    if (this.msg === 'NNNN' || HEADER_RE.test(this.msg)) this.close();
  }

  /** One copy of a burst has ended; file it with its siblings. */
  private close(): void {
    const s = this.msg;
    this.synced = false; this.inMsg = false; this.msg = ''; this.cur = 0; this.bitIdx = 0; this.sr = 0;
    const kind: Kind | null = opener(s, 'ZCZC') >= 3 ? 'header' : opener(s, 'NNNN') >= 3 ? 'eom' : null;
    if (!kind) return;
    const now = this.t;
    if (this.group && (this.group.kind !== kind || now - this.group.lastT > 4 * this.rate)) this.finalize();
    if (!this.group) this.group = { kind, copies: [], lastT: now };
    this.group.copies.push(s); this.group.lastT = now;
    if (this.group.copies.length >= 3) this.finalize();
  }

  /** Vote the copies character by character, then insist the result is well-formed before saying anything. */
  private finalize(): void {
    const g = this.group; this.group = null;
    if (!g) return;
    // clean copies break ties: a copy that matched the structure on its own is the better witness
    const copies = [...g.copies].sort((a, b) => Number(headerEnd(b) > 0 || b === 'NNNN') - Number(headerEnd(a) > 0 || a === 'NNNN'));
    const len = Math.max(...copies.map(c => c.length));
    let voted = '';
    for (let i = 0; i < len; i++) {
      const tally = new Map<string, number>();
      let best = '', bestN = 0;
      for (const c of copies) {
        if (i >= c.length) continue;
        const n = (tally.get(c[i]) ?? 0) + 1; tally.set(c[i], n);
        if (n > bestN) { bestN = n; best = c[i]; }
      }
      voted += best;
    }
    const repeats = copies.length;
    if (g.kind === 'eom') {
      if (voted.startsWith('NNNN')) this.emit({ type: 'same', event: 'eom', raw: 'NNNN', repeats });
      return;
    }
    const raw = voted.slice(0, headerEnd(voted));
    const header = raw ? parseSameHeader(raw) : null;
    if (header) this.emit({ type: 'same', event: 'header', header, raw, repeats });
  }

  /**
   * Attention tone: 1050 Hz on NWR, 853 + 960 Hz on EAS. Judged as the share of the block's energy in the bin,
   * so it is level-independent, and the AFSK sidebands near 1041 Hz never hold enough of the burst's energy
   * to pass. Half a second of it is required before it is reported, once per tone.
   */
  private tone(x: number): void {
    for (let k = 0; k < 3; k++) { const s0 = x + this.coef[k] * this.g1[k] - this.g2[k]; this.g2[k] = this.g1[k]; this.g1[k] = s0; }
    this.energy += x * x;
    if (++this.blockI < this.blockN) return;
    const N = this.blockN, e = this.energy;
    const frac = (k: number) => { const p = this.g1[k] * this.g1[k] + this.g2[k] * this.g2[k] - this.coef[k] * this.g1[k] * this.g2[k]; return e > 0 ? 2 * p / (N * e) : 0; };
    const f1050 = frac(0), f853 = frac(1), f960 = frac(2);
    this.g1 = [0, 0, 0]; this.g2 = [0, 0, 0]; this.energy = 0; this.blockI = 0;
    const kind = f1050 > 0.6 ? '1050 Hz' : (f853 > 0.25 && f960 > 0.25 && f853 + f960 > 0.6) ? '853+960 Hz' : '';
    if (kind && kind === this.toneKind) { this.toneRun++; this.toneQuiet = 0; }
    else if (kind) { this.toneKind = kind; this.toneRun = 1; this.toneQuiet = 0; }
    else if (++this.toneQuiet >= 4) { this.toneRun = 0; this.toneKind = ''; this.toneArmed = true; }
    if (this.toneArmed && this.toneRun >= 10) { this.toneArmed = false; this.emit({ type: 'same', event: 'tone', raw: this.toneKind, repeats: 1 }); }
  }
}
