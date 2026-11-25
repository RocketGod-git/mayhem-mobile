/**
 * Analog repeater signaling, one transmission at a time. The FM discriminator (or squelched audio) is cut into
 * transmissions by carrier: the discriminator's sample-to-sample noise is small while a carrier is up and large
 * when it is not (squelched audio: silent or not). Each transmission is kept at about 8 kHz and read when the
 * carrier drops:
 *
 *   · a 128-point spectrum every 4 ms marks voice, single tones, two-tone frames and 1200 baud data;
 *   · single tones become tone segments, their frequency from the phase advance of a mixer at the tone and their
 *     edges from its envelope. Runs of tones that fit a selcall table (ZVEI1/2/3, CCIR1/2, EEA, EIA: frequency
 *     within 1.8 %, tone length within the system's tolerance) read as a 5-tone call, the repeat tone standing
 *     for the digit before it. A long tone A then a longer tone B is a 2-tone page. The first short tone group
 *     after the last voice is the courtesy tone, fingerprinted by its tones and lengths so each repeater's beep
 *     is recognized when it comes again;
 *   · CW: the pitch is the 400 to 1600 Hz line that keys on and off most; five mixers (the pitch and two either
 *     side) give the line's level against its neighborhood, so voice under the ID raises both and does not key
 *     it. The dit is the one that best fits the marks to 1 and 3 dits and the spaces to 1, 3 and 7, tracked
 *     element by element; a second pass runs at the pitch corrected by the marks' phase advance with a filter
 *     sized to the speed. A word counts only when it is a plausible amateur callsign (optionally /R or another
 *     suffix), with a confidence from the timing fit and the line's clarity;
 *   · MDC-1200: 1200 baud FFSK (1200 and 1800 Hz), its 40-bit sync 07 09 2A 44 6F (or its complement), the 112
 *     coded bits laid out as the Mayhem MDC-1200 transmitter sends them (seven data bytes: op, arg, unit ID and
 *     the CRC-16, reflected with final inversion over the first four bytes; then seven parity bytes), checked by
 *     the CRC and the parity. Tones to bits are tried straight and differential, both polarities. Other 1200 or
 *     2400 baud bursts are tried as FleetSync;
 *   · FleetSync, laid out as Matthew Kaufman's fsync library reads it: 1200 baud on 1200/1800 Hz or 2400 baud on
 *     1200/2400 Hz (1200 Hz is a 1), 0xAAAA then the sync 23EB or 052B, then 64-bit blocks of six data bytes and a
 *     15-bit CRC (0x6815) with a parity bit. Fleet is its byte plus 99, unit its 12 bits plus 999. Anything else is
 *     reported as a data burst by rate;
 *   · sub-audio: the CTCSS tone by Goertzel over the transmission, its reverse burst (120 or 180 degree phase
 *     step held until the tone ends) against the phase line before it, DCS by the HAM receiver's own decoder and
 *     its turn-off code (134.4 Hz, where DCS data has a spectral null, in the last 150 to 200 ms);
 *   · end of over: the user unkeys at the end of the last voice; the tail is the carrier after it. A repeater
 *     that drops while voice is still on after 25 s timed out. A short keyup with no voice is a kerchunk.
 * No DOM.
 */
import { CTCSS_TONES, SubAudioDecoder } from '../ham/ctcss.js';

export interface ToneSeg { hz: number; atS: number; ms: number; amp: number; used: boolean }
export interface CourtesyTone { tones: { hz: number; ms: number }[]; key: string; atS: number; seen: number }
export interface CwId { callsign: string; suffix: string; text: string; wpm: number; pitchHz: number; confidence: number; atS: number }
export interface Selcall { system: string; digits: string; atS: number }
export interface TwoTone { aHz: number; bHz: number; aMs: number; bMs: number; atS: number }
export interface MdcPacket { op: number; arg: number; unit: string; emergency: boolean; label: string; extra: number[]; atS: number }
export interface DataBurst { baud: number; ms: number; atS: number }
/** FleetSync: fleet 100-349 and unit 1000-4999 as the radios show them, -1 for "all"; [cmd] and [sub] raw. */
export interface FleetSync { baud: number; cmd: number; sub: number; fromFleet: number; fromUnit: number; toFleet: number; toUnit: number; all: boolean; atS: number }
export interface AnalogTx {
  startS: number; durS: number; voiceS: number;
  /** When the user unkeyed (seconds into the transmission) and the carrier after it; -1 when there was no user. */
  unkeyS: number; tailS: number;
  ctcss: number; dcs: number; reverseBurst: number; dcsTurnOff: boolean;
  courtesy: CourtesyTone | null; cw: CwId | null;
  selcall: Selcall[]; twoTone: TwoTone[]; mdc: MdcPacket[]; fleetsync: FleetSync[]; data: DataBurst[];
  timeout: boolean; kerchunk: boolean;
}
export interface AnalogSnap {
  carrier: boolean;
  /** The latest transmissions, oldest first (up to 30). */
  txs: AnalogTx[];
  /** The repeater's CW ID: the callsign heard most, how many times, and the combined confidence. */
  cwId: { callsign: string; count: number; confidence: number } | null;
  /** Each courtesy tone heard on the channel, with how many times. */
  courtesy: { key: string; tones: { hz: number; ms: number }[]; count: number }[];
  /** The time-out timer, from the transmissions that timed out (median), 0 when none has. */
  timeoutS: number;
}

const N = 128, H = 32, HALF = N / 2;
const HANN = (() => { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); return w; })();
const BITREV = (() => { const b = new Int32Array(N); for (let i = 0; i < N; i++) { let r = 0; for (let k = 1, j = i; k < N; k <<= 1, j >>= 1) r = (r << 1) | (j & 1); b[i] = r; } return b; })();
const TW_RE = new Float64Array(HALF), TW_IM = new Float64Array(HALF);
for (let i = 0; i < HALF; i++) { TW_RE[i] = Math.cos(-2 * Math.PI * i / N); TW_IM[i] = Math.sin(-2 * Math.PI * i / N); }

/** Power spectrum of one Hann-windowed frame (bins 0..N/2) into [p]. */
function spectrum(y: Float32Array, at: number, re: Float64Array, im: Float64Array, p: Float64Array): void {
  for (let i = 0; i < N; i++) { re[BITREV[i]] = y[at + i] * HANN[i]; im[BITREV[i]] = 0; }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) for (let j = 0; j < half; j++) {
      const wr = TW_RE[j * step], wi = TW_IM[j * step], a = s + j, b = a + half;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let k = 0; k <= HALF; k++) p[k] = re[k] * re[k] + im[k] * im[k];
}
const pct = (v: ArrayLike<number>, q: number): number => {
  if (v.length === 0) return 0;
  const s = Array.from(v).sort((a, b) => a - b); return s[Math.floor(q * (s.length - 1))];
};
const clamp01 = (x: number) => x < 0 ? 0 : x > 1 ? 1 : x;
const wrap = (a: number) => { let x = a; while (x > Math.PI) x -= 2 * Math.PI; while (x < -Math.PI) x += 2 * Math.PI; return x; };
function goertzel(x: Float32Array, from: number, to: number, hz: number, rate: number): number {
  const c = 2 * Math.cos(2 * Math.PI * hz / rate); let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

// ------------------------------------------------------------------------------------------------ callsigns
const CALL_RE = /^((?:[A-Z]{1,2}|[A-Z][0-9]|[2-9][A-Z])[0-9][A-Z]{1,4})(?:\/([A-Z0-9]{1,4}))?$/;
/** A plausible amateur callsign in a CW word ('W6ABC', 'W6ABC/R', 'DEW6ABC'), or null. */
export function plausibleCall(word: string): { call: string; suffix: string } | null {
  for (const w of [word, word.startsWith('DE') ? word.slice(2) : '']) {
    const m = w ? CALL_RE.exec(w) : null;
    if (m && m[1].length >= 3 && m[1].length <= 7) return { call: m[1], suffix: m[2] ?? '' };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ CW
const MORSE: Record<string, string> = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L',
  '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X',
  '-.--': 'Y', '--..': 'Z', '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7',
  '---..': '8', '----.': '9', '-..-.': '/', '-...-': '=', '..--..': '?', '.-.-.-': '.', '--..--': ',',
};
interface Run { on: boolean; len: number; at: number; snr: number }
interface CwPass { id: CwId | null; ditMs: number; dfHz: number }

/** Merge runs shorter than their minimum into their neighbors, shortest first. */
function cleanRuns(runs: Run[], minOn: number, minOff: number): Run[] {
  const r = runs.map(x => ({ ...x }));
  for (;;) {
    let bi = -1;
    for (let i = 1; i < r.length - 1; i++) if (r[i].len < (r[i].on ? minOn : minOff) && (bi < 0 || r[i].len < r[bi].len)) bi = i;
    if (bi < 0) break;
    const a = r[bi - 1], b = r[bi + 1];
    a.snr = a.on ? Math.max(a.snr, b.snr) : 0;
    a.len += r[bi].len + b.len; r.splice(bi, 2);
  }
  return r;
}

function cwPass(y: Float32Array, rate: number, f0: number, bw: number, t0S: number): CwPass {
  const dec = Math.max(1, Math.round(rate / 500)), er = rate / dec, a = 1 - Math.exp(-2 * Math.PI * bw / rate);
  const offs = [0, -190, -110, 110, 190], M = offs.length;
  const cr = new Float64Array(M), ci = new Float64Array(M), dr = new Float64Array(M), di = new Float64Array(M);
  for (let k = 0; k < M; k++) { cr[k] = 1; ci[k] = 0; const w = -2 * Math.PI * (f0 + offs[k]) / rate; dr[k] = Math.cos(w); di[k] = Math.sin(w); }
  const s1r = new Float64Array(M), s1i = new Float64Array(M), s2r = new Float64Array(M), s2i = new Float64Array(M);
  const ne = Math.floor(y.length / dec), c = new Float64Array(ne), sd = new Float64Array(ne), zr = new Float64Array(ne), zi = new Float64Array(ne);
  for (let i = 0, j = 0; i < ne * dec; i++) {
    const v = y[i];
    for (let k = 0; k < M; k++) {
      s1r[k] += a * (v * cr[k] - s1r[k]); s1i[k] += a * (v * ci[k] - s1i[k]);
      s2r[k] += a * (s1r[k] - s2r[k]); s2i[k] += a * (s1i[k] - s2i[k]);
      const nr = cr[k] * dr[k] - ci[k] * di[k]; ci[k] = cr[k] * di[k] + ci[k] * dr[k]; cr[k] = nr;
    }
    if ((i + 1) % dec === 0) {
      c[j] = s2r[0] * s2r[0] + s2i[0] * s2i[0]; zr[j] = s2r[0]; zi[j] = s2i[0];
      let s = 0; for (let k = 1; k < M; k++) s += s2r[k] * s2r[k] + s2i[k] * s2i[k];
      sd[j] = s / (M - 1) + 1e-20; j++;
      if ((j & 255) === 0) for (let k = 0; k < M; k++) { const g = 1 / Math.sqrt(cr[k] * cr[k] + ci[k] * ci[k]); cr[k] *= g; ci[k] *= g; }
    }
  }
  // the line's excess over its neighborhood: voice raises both, the keyed tone only the line
  const ex = new Float64Array(ne); for (let j = 0; j < ne; j++) ex[j] = c[j] - sd[j];
  const lineLv: number[] = []; for (let j = 0; j < ne; j++) if (c[j] > 4 * sd[j]) lineLv.push(ex[j]);
  const none: CwPass = { id: null, ditMs: 0, dfHz: 0 };
  if (lineLv.length < 10) return none;
  const mark = pct(lineLv, 0.9);
  // the line keyed: hysteresis on its level against the neighborhood and against the marks' level
  const runs: Run[] = []; let on = false, len = 0, at = 0, snrMax = 0;
  for (let j = 0; j < ne; j++) {
    const q = c[j] / sd[j];
    const now: boolean = on ? ex[j] > 0.15 * mark : (ex[j] > 0.3 * mark && q > 2);
    if (now !== on && len > 0) { runs.push({ on, len, at, snr: on ? snrMax : 0 }); len = 0; at = j; snrMax = 0; }
    on = now; len++; if (on) snrMax = Math.max(snrMax, q);
  }
  if (len > 0) runs.push({ on, len, at, snr: on ? snrMax : 0 });
  const msPer = 1000 / er;
  let r = cleanRuns(runs, Math.round(12 / msPer), Math.round(12 / msPer));
  const marks = r.filter(x => x.on).map(x => x.len * msPer);
  if (marks.length < 5) return none;
  // the dit that best explains the marks (1, 3 dits) and the spaces (1, 3, 7)
  let bestD = 0, bestCost = 1e9;
  for (let d = 45; d <= 260; d *= 1.02) {
    let cost = 0, n = 0;
    for (const x of r) {
      const ms = x.len * msPer;
      if (x.on) { if (ms > 5 * d) continue; const e = Math.min(Math.abs(ms - d) / d, Math.abs(ms - 3 * d) / (3 * d)); cost += Math.min(0.5, e); n++; }
      else { if (ms > 9 * d) continue; const e = Math.min(Math.abs(ms - d) / d, Math.abs(ms - 3 * d) / (3 * d), Math.abs(ms - 7 * d) / (7 * d)); cost += Math.min(0.5, e); n++; }
    }
    if (n < 8) continue;
    cost /= n;
    if (cost < bestCost) { bestCost = cost; bestD = d; }
  }
  if (!bestD) return none;
  r = cleanRuns(r, Math.round(0.35 * bestD / msPer), Math.round(0.35 * bestD / msPer));
  // decode with the dit tracked element by element
  let dl = bestD, sym = '', symAt = 0, symSnr: number[] = [];
  const chars: { ch: string; at: number; snr: number; word: boolean }[] = [];
  let wordNext = false;
  const flush = () => { if (sym) { chars.push({ ch: MORSE[sym] ?? '?', at: symAt, snr: pct(symSnr, 0.5), word: wordNext }); wordNext = false; } sym = ''; symSnr = []; };
  for (const x of r) {
    const ms = x.len * msPer;
    if (x.on) {
      if (ms > 5 * bestD) { flush(); wordNext = true; continue; }
      if (!sym) symAt = x.at;
      const dah = ms > 2 * dl; sym += dah ? '-' : '.'; symSnr.push(x.snr);
      dl = Math.min(1.3 * bestD, Math.max(0.7 * bestD, 0.9 * dl + 0.1 * (dah ? ms / 3 : ms)));
    } else if (ms > 2 * dl) { flush(); if (ms > 5 * dl) wordNext = true; }
  }
  flush();
  // tone tracking: the marks' phase advance at the pitch
  let pr = 0, pi = 0;
  for (const x of r) if (x.on && x.len > 8) for (let j = x.at + 3; j < x.at + x.len - 4; j++) { pr += zr[j + 1] * zr[j] + zi[j + 1] * zi[j]; pi += zi[j + 1] * zr[j] - zr[j + 1] * zi[j]; }
  const dfHz = (pr || pi) ? Math.atan2(pi, pr) * er / (2 * Math.PI) : 0;
  // words, then the best plausible callsign among them
  const words: { text: string; at: number; snr: number[] }[] = [];
  for (const ch of chars) {
    if (ch.word || !words.length) words.push({ text: '', at: ch.at, snr: [] });
    const w = words[words.length - 1]; w.text += ch.ch; w.snr.push(ch.snr);
  }
  const text = words.map(w => w.text).join(' ').slice(0, 64);
  let best: CwId | null = null;
  for (const w of words) {
    const pc = plausibleCall(w.text); if (!pc) continue;
    const snrDb = 10 * Math.log10(Math.max(1, pct(w.snr, 0.5)));
    const conf = clamp01(1 - 3 * bestCost) * clamp01((snrDb - 3) / 12) * (pc.call.length >= 4 ? 1 : 0.85) * (pc.suffix || /DE|RPT/.test(text) ? 1 : 0.95);
    if (!best || conf > best.confidence) best = { callsign: pc.call, suffix: pc.suffix, text, wpm: Math.round(1200 / bestD), pitchHz: Math.round(f0), confidence: Math.round(conf * 100) / 100, atS: t0S + w.at / er };
  }
  return { id: best, ditMs: bestD, dfHz };
}

/** The CW ID in one transmission at [rate], given the candidate pitches. */
export function decodeCwId(y: Float32Array, rate: number, pitches: number[], t0S = 0): CwId | null {
  let best: CwId | null = null;
  for (const f of pitches) {
    const p1 = cwPass(y, rate, f, 40, t0S);
    if (p1.id && (!best || p1.id.confidence > best.confidence)) best = p1.id;
    if (!p1.ditMs) continue;
    const bw = Math.min(40, Math.max(10, 600 / p1.ditMs));
    const p2 = cwPass(y, rate, f + (Math.abs(p1.dfHz) < 40 ? p1.dfHz : 0), bw, t0S);
    if (p2.id && (!best || p2.id.confidence > best.confidence)) best = p2.id;
  }
  return best && best.confidence >= 0.3 ? best : null;
}

// ------------------------------------------------------------------------------------------------ selcall
interface SelSys { name: string; ms: number; tones: [string, number][] }
const D_ZVEI = [2400, 1060, 1160, 1270, 1400, 1530, 1670, 1830, 2000, 2200], D_CCIR = [1981, 1124, 1197, 1275, 1358, 1446, 1540, 1640, 1747, 1860];
const sys = (name: string, ms: number, digits: number[], extra: [string, number][]): SelSys => ({ name, ms, tones: [...digits.map((f, i) => [String(i), f] as [string, number]), ...extra] });
/** The published 5-tone tables: digits 0-9, then the extra tones (E is the repeat tone) and the tone length. */
export const SELCALL_SYSTEMS: SelSys[] = [
  sys('ZVEI1', 70, D_ZVEI, [['A', 2800], ['B', 810], ['C', 970], ['D', 885], ['E', 2600], ['F', 680]]),
  sys('ZVEI2', 70, D_ZVEI, [['A', 885], ['B', 810], ['C', 740], ['D', 680], ['E', 970], ['F', 2600]]),
  sys('ZVEI3', 70, [2200, 970, 1060, 1160, 1270, 1400, 1530, 1670, 1830, 2000], [['A', 885], ['E', 2400]]),
  sys('CCIR1', 100, D_CCIR, [['A', 2400], ['B', 930], ['C', 2247], ['D', 991], ['E', 2110], ['F', 1055]]),
  sys('CCIR2', 70, D_CCIR, [['A', 2400], ['B', 930], ['C', 2247], ['D', 991], ['E', 2110], ['F', 1055]]),
  sys('EEA', 40, D_CCIR, [['A', 1055], ['B', 930], ['C', 2247], ['D', 991], ['E', 2110]]),
  sys('EIA', 33, [600, 741, 882, 1023, 1164, 1305, 1446, 1587, 1728, 1869], [['A', 2151], ['B', 2433], ['C', 2010], ['D', 2292], ['E', 459], ['F', 1091]]),
];
function symbolOf(s: SelSys, hz: number): string {
  let best = '', err = 1;
  for (const [k, f] of s.tones) { const e = Math.abs(hz - f) / f; if (e < err) { err = e; best = k; } }
  return err <= 0.018 ? best : '';
}
/** Selcalls in a run of tone segments: the longest run each system explains, the repeat tone resolved. */
export function findSelcalls(segs: ToneSeg[]): Selcall[] {
  const out: Selcall[] = [];
  let i = 0;
  while (i < segs.length) {
    let pick: { s: SelSys; n: number; digits: string; odd: number; reps: number } | null = null, zvei12 = false;
    for (const s of SELCALL_SYSTEMS) {
      let n = 0, digits = '', odd = 0, reps = 0;
      for (let j = i; j < segs.length; j++) {
        const g = segs[j];
        if (g.used || g.ms < 0.65 * s.ms || g.ms > 1.45 * s.ms) break;
        if (j > i) { const p = segs[j - 1]; if (g.atS - (p.atS + p.ms / 1000) > 0.02) break; }
        const k = symbolOf(s, g.hz); if (!k) break;
        if (j > i && k === symbolOf(s, segs[j - 1].hz)) break;
        if (k === 'E') { if (!digits) break; digits += digits[digits.length - 1]; reps++; } else { digits += k; if (!/\d/.test(k)) odd++; }
        n++;
      }
      if (n < 3) continue;
      // the longest run, then the fewest letters, then the fewest repeat tones (ZVEI2 and ZVEI3 share their tones)
      if (!pick || n > pick.n || (n === pick.n && (odd < pick.odd || (odd === pick.odd && reps < pick.reps)))) { pick = { s, n, digits, odd, reps }; zvei12 = false; }
      else if (n === pick.n && odd === pick.odd && reps === pick.reps && pick.s.name === 'ZVEI1' && s.name === 'ZVEI2' && digits === pick.digits) zvei12 = true;
    }
    if (!pick) { i++; continue; }
    out.push({ system: zvei12 ? 'ZVEI' : pick.s.name, digits: pick.digits, atS: segs[i].atS });
    for (let j = i; j < i + pick.n; j++) segs[j].used = true;
    i += pick.n;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ MDC-1200
const MDC_SYNC = [0x07, 0x09, 0x2a, 0x44, 0x6f].flatMap(b => [7, 6, 5, 4, 3, 2, 1, 0].map(k => (b >> k) & 1));
/** CRC-16 as MDC-1200 uses it: polynomial 0x1021 reflected (0x8408), zero start, inverted at the end. */
export function mdcCrc(bytes: ArrayLike<number>, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) { c ^= bytes[i]; for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  return (c ^ 0xffff) & 0xffff;
}
const MDC_LABELS: Record<number, string> = { 0x01: 'PTT ID', 0x00: 'emergency', 0x20: 'emergency ACK', 0x63: 'radio check' };
/**
 * One 112-bit MDC block, laid out as the Mayhem MDC-1200 transmitter (ui_mdc_tx) sends it: seven data bytes (op, arg,
 * unit ID high and low, the CRC low and high, a zero) then seven parity bytes, each byte least significant bit first,
 * parity bit n the XOR of data bits n, n-2, n-5 and n-6; coded bit p goes out as bit (p mod 7) * 16 + p / 7. The CRC
 * decides; a block whose parity disagrees in more than 8 places is refused as well.
 */
function mdcBlock(b: Uint8Array, at: number): number[] | null {
  if (at + 112 > b.length) return null;
  const e = new Uint8Array(112);
  for (let i = 0; i < 112; i++) e[(i % 16) * 7 + Math.floor(i / 16)] = b[at + i];
  const bytes: number[] = [];
  for (let j = 0; j < 7; j++) { let x = 0; for (let k = 0; k < 8; k++) x |= e[8 * j + k] << k; bytes.push(x); }
  if (mdcCrc(bytes, 4) !== (bytes[4] | (bytes[5] << 8))) return null;
  let bad = 0;
  for (let n = 0; n < 56; n++) { const p = e[n] ^ (n >= 2 ? e[n - 2] : 0) ^ (n >= 5 ? e[n - 5] : 0) ^ (n >= 6 ? e[n - 6] : 0); if (p !== e[56 + n]) bad++; }
  return bad <= 8 ? bytes : null;
}
/**
 * The audio FM demodulated around [centerHz] (three one-pole stages of [bwHz]), as the running sum of the
 * frequency (radians a sample) so a bit's integral is a difference.
 */
function fskDemod(y: Float32Array, from: number, to: number, rate: number, centerHz: number, bwHz: number): Float64Array {
  const n = to - from, a = 1 - Math.exp(-2 * Math.PI * bwHz / rate), w = -2 * Math.PI * centerHz / rate, dr = Math.cos(w), di = Math.sin(w);
  const C = new Float64Array(n + 1); let cr = 1, ci = 0, r1 = 0, i1 = 0, r2 = 0, i2 = 0, r3 = 0, i3 = 0, pr = 1, pi = 0;
  for (let i = 0; i < n; i++) {
    const v = y[from + i];
    r1 += a * (v * cr - r1); i1 += a * (v * ci - i1); r2 += a * (r1 - r2); i2 += a * (i1 - i2); r3 += a * (r2 - r3); i3 += a * (i2 - i3);
    const nr = cr * dr - ci * di; ci = cr * di + ci * dr; cr = nr;
    if ((i & 255) === 255) { const g = 1 / Math.sqrt(cr * cr + ci * ci); cr *= g; ci *= g; }
    C[i + 1] = C[i] + Math.atan2(i3 * pr - r3 * pi, r3 * pr + i3 * pi); pr = r3; pi = i3;
  }
  return C;
}
const cumAt = (C: Float64Array, t: number) => { const n = C.length - 1, k = Math.floor(t); return k >= n ? C[n] : C[k] + (t - k) * (C[k + 1] - C[k]); };
/** MDC-1200 packets in a stretch of audio at [rate]. */
export function decodeMdc(y: Float32Array, from: number, to: number, rate: number, t0S: number): MdcPacket[] {
  const n = to - from; if (n < rate * 0.1) return [];
  const C = fskDemod(y, from, to, rate, 1500, 1000);
  const Cat = (t: number) => cumAt(C, t);
  const sps = rate / 1200, nb = Math.floor((n - sps) / sps), out: MdcPacket[] = [];
  let skipUntil = -1;
  for (let ph = 0; ph < 8 && !out.length; ph++) {
    const t0 = ph * sps / 8, tb = new Uint8Array(nb);
    for (let k = 0; k < nb; k++) tb[k] = Cat(t0 + (k + 1) * sps) - Cat(t0 + k * sps) > 0 ? 1 : 0;
    for (let diff = 0; diff < 2; diff++) {
      const b = diff ? tb.map((x, k) => k ? x ^ tb[k - 1] : x) : tb;
      for (let k = 40; k + 112 <= nb; k++) {
        if (k < skipUntil) continue;
        let err = 0, errInv = 0;
        for (let j = 0; j < 40 && (err <= 2 || errInv <= 2); j++) { if (b[k - 40 + j] !== MDC_SYNC[j]) err++; else errInv++; }
        if (err > 2 && errInv > 2) continue;
        const bits = err <= 2 ? b : b.map(x => x ^ 1);
        const blk = mdcBlock(bits, k); if (!blk) continue;
        const [op, arg, hi, lo] = blk;
        const second = mdcBlock(bits, k + 112);
        out.push({ op, arg, unit: ((hi << 8) | lo).toString(16).toUpperCase().padStart(4, '0'), emergency: op === 0x00, label: MDC_LABELS[op] ?? '', extra: second ? second.slice(0, 4) : [], atS: t0S + (from + (k - 40) * sps) / rate });
        skipUntil = k + (second ? 224 : 112);
      }
      if (out.length) break;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ FleetSync
/** The FleetSync block check: CRC-15 (0x6815) over the six data bytes, then 2, then the parity of the 63 bits. */
export function fleetSyncCheck(w1: number, w2: number): number {
  let crc = 0, par = 0;
  for (let i = 0; i < 48; i++) {
    const b = i < 32 ? (w1 >>> (31 - i)) & 1 : (w2 >>> (63 - i)) & 1;
    par ^= b;
    if (b ^ ((crc >> 15) & 1)) crc ^= 0x6815;
    crc = (crc << 1) & 0xffff;
  }
  for (let i = 48; i < 63; i++) par ^= (w2 >>> (63 - i)) & 1;
  return ((crc ^ 2) + par) & 0xffff;
}
const FS_SYNC = [0xaaaa23eb, 0xaaaa052b];
const ones = (x: number) => { let n = 0, v = x >>> 0; while (v) { n += v & 1; v >>>= 1; } return n; };
/** FleetSync messages in a stretch of audio at [rate], at 1200 baud (1200/1800 Hz) and 2400 baud (1200/2400 Hz). */
export function decodeFleetSync(y: Float32Array, from: number, to: number, rate: number, t0S: number): FleetSync[] {
  const out: FleetSync[] = [];
  for (const [baud, center, bw] of [[1200, 1500, 1000], [2400, 1800, 1600]]) {
    const C = fskDemod(y, from, to, rate, center, bw), sps = rate / baud, nb = Math.floor((to - from - sps) / sps);
    if (nb < 100) continue;
    for (let ph = 0; ph < 8 && !out.length; ph++) {
      const t0 = ph * sps / 8, b = new Uint8Array(nb);
      // the lower tone (1200 Hz, below the mixer's center between the two tones) is a 1
      for (let k = 0; k < nb; k++) b[k] = cumAt(C, t0 + (k + 1) * sps) - cumAt(C, t0 + k * sps) < 0 ? 1 : 0;
      for (let inv = 0; inv < 2 && !out.length; inv++) {
        let win = 0;
        for (let k = 0; k < nb; k++) {
          win = ((win << 1) | (b[k] ^ inv)) >>> 0;
          if (k < 31 || !FS_SYNC.some(sy => ones(win ^ sy) <= 3)) continue;
          // blocks of 64 bits while their check holds
          const bytes: number[] = []; let at = k + 1;
          for (;;) {
            if (at + 64 > nb) break;
            let w1 = 0, w2 = 0;
            for (let q = 0; q < 32; q++) { w1 = ((w1 << 1) | (b[at + q] ^ inv)) >>> 0; w2 = ((w2 << 1) | (b[at + 32 + q] ^ inv)) >>> 0; }
            if (fleetSyncCheck(w1, w2) !== (w2 & 0xffff)) break;
            bytes.push(w1 >>> 24, (w1 >>> 16) & 255, (w1 >>> 8) & 255, w1 & 255, w2 >>> 24, (w2 >>> 16) & 255);
            at += 64;
          }
          if (!bytes.length) continue;
          const id = (v: number, off: number, none: number) => v === none ? -1 : v + off;
          const fleetFlag = bytes[1] & 1, fromFleet = id(bytes[2], 99, 0);
          out.push({
            baud, cmd: bytes[1] & 0xfe, sub: bytes[0] & 0xfe, all: (bytes[0] & 1) === 1,
            fromFleet, fromUnit: id(bytes[3] * 16 + (bytes[4] >> 4), 999, 0), toUnit: id(((bytes[4] & 15) << 8) | bytes[5], 999, 0),
            toFleet: fleetFlag && bytes.length > 6 ? id(bytes[6], 99, 0) : fromFleet, atS: t0S + (from + (k - 31) * sps) / rate,
          });
          break;
        }
      }
    }
    if (out.length) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ one transmission
interface Frames { nF: number; E: Float64Array; kp: Int16Array; fq: Float64Array; hi: Float64Array; lohi: Float64Array; tonal: Uint8Array; data: Uint8Array; fsk: Uint8Array; pitches: number[] }

function frames(y: Float32Array, rate: number): Frames {
  const binHz = rate / N, nF = y.length >= N ? Math.floor((y.length - N) / H) + 1 : 0;
  const E = new Float64Array(nF), kp = new Int16Array(nF), fq = new Float64Array(nF), hi = new Float64Array(nF), lohi = new Float64Array(nF), tonal = new Uint8Array(nF), data = new Uint8Array(nF), fsk = new Uint8Array(nF);
  const re = new Float64Array(N), im = new Float64Array(N), p = new Float64Array(HALF + 1);
  const kLo = Math.ceil(300 / binHz), kHi = Math.min(HALF - 2, Math.floor(3400 / binHz));
  const dLo = Math.ceil(900 / binHz), dHi = Math.min(HALF - 1, Math.floor(2700 / binHz));
  const cLo = Math.max(3, Math.ceil(400 / binHz)), cHi = Math.min(HALF - 3, Math.floor(1600 / binHz));
  const onCnt = new Int32Array(HALF + 1), trans = new Int32Array(HALF + 1), prevOn = new Uint8Array(HALF + 1), dSum = new Float64Array(HALF + 1);
  for (let t = 0; t < nF; t++) {
    spectrum(y, t * H, re, im, p);
    let e = 0, k1 = kLo + 1; for (let k = kLo; k <= kHi; k++) { e += p[k]; if (k > kLo && k < kHi && p[k] > p[k1]) k1 = k; }
    E[t] = e; kp[t] = k1;
    { const l1 = Math.log(p[k1 - 1] + 1e-30), l2 = Math.log(p[k1] + 1e-30), l3 = Math.log(p[k1 + 1] + 1e-30), den = l1 - 2 * l2 + l3; fq[t] = (k1 + (den < 0 ? 0.5 * (l1 - l3) / den : 0)) * binHz; }
    const pk = p[k1 - 1] + p[k1] + p[k1 + 1];
    let k2 = -1; for (let k = kLo + 1; k < kHi; k++) if (Math.abs(k - k1) > 2 && (k2 < 0 || p[k] > p[k2])) k2 = k;
    const pk2 = k2 > 0 ? p[k2 - 1] + p[k2] + p[k2 + 1] : 0;
    tonal[t] = e > 1e-15 && pk >= 0.7 * e ? 1 : 0;
    let fb = 0, fh = 0; for (let k = dLo; k <= dHi; k++) { fb += p[k]; if (k * binHz > 2150) fh += p[k]; }
    hi[t] = e > 0 ? fh / e : 0;
    // FM noise rises with frequency (and voice does not): the 300-1200 Hz energy against 2000-3400 Hz
    { let lo = 0, up = 0; for (let k = kLo; k <= kHi; k++) { const f = k * binHz; if (f <= 1200) lo += p[k]; else if (f >= 2000) up += p[k]; } lohi[t] = lo / (up + 1e-30); }
    data[t] = e > 1e-15 && pk + pk2 < 0.8 * e && fb >= 0.75 * e ? 1 : 0;
    // FFSK whose bits run long looks like its tones (2400 Hz for FleetSync II): those frames start a data search too
    { let fw = 0; for (let k = dLo; k <= kHi; k++) fw += p[k]; fsk[t] = e > 1e-15 && fw >= 0.75 * e ? 1 : 0; }
    for (let k = cLo; k <= cHi; k++) {
      const on = p[k] > 1e-15 && p[k] >= p[k - 1] && p[k] >= p[k + 1] && p[k] > 10 * (p[k - 2] + p[k + 2]) ? 1 : 0;
      if (on) {
        onCnt[k]++; if (!prevOn[k]) trans[k]++;
        const l1 = Math.log(p[k - 1] + 1e-30), l2 = Math.log(p[k]), l3 = Math.log(p[k + 1] + 1e-30), den = l1 - 2 * l2 + l3;
        dSum[k] += den < 0 ? 0.5 * (l1 - l3) / den : 0;
      }
      prevOn[k] = on;
    }
  }
  // CW pitch candidates: the keyed lines with the most on frames, neighbors merged
  const cand: { k: number; n: number }[] = [];
  for (let k = cLo; k <= cHi; k++) if (trans[k] >= 6) cand.push({ k, n: onCnt[k] + (onCnt[k - 1] + onCnt[k + 1]) / 2 });
  cand.sort((a, b) => b.n - a.n || a.k - b.k);
  const pitches: number[] = [], taken: number[] = [];
  for (const c of cand) { if (taken.some(k => Math.abs(k - c.k) <= 1)) continue; taken.push(c.k); pitches.push((c.k + dSum[c.k] / Math.max(1, onCnt[c.k])) * binHz); if (pitches.length >= 3) break; }
  return { nF, E, kp, fq, hi, lohi, tonal, data, fsk, pitches };
}

/** Tone segments: runs of single-tone frames at one frequency, refined by a mixer at the tone. */
function toneSegments(y: Float32Array, rate: number, fr: Frames): ToneSeg[] {
  const out: ToneSeg[] = [], raw: { t: number; u: number; s: number; e: number }[] = [];
  let t = 0;
  while (t < fr.nF) {
    if (!fr.tonal[t]) { t++; continue; }
    // one tone while the frames' interpolated frequency stays within 2 % (20 Hz at least) of the run's mean
    let u = t + 1, fs = fr.fq[t];
    while (u < fr.nF && fr.tonal[u] && Math.abs(fr.fq[u] - fs / (u - t)) <= Math.max(20, 0.02 * fs / (u - t))) { fs += fr.fq[u]; u++; }
    if (u - t >= 3) {
      const fc = fs / (u - t);
      // the tone's samples: the frames' common middle, then the envelope out to the edges
      const a0 = t * H + Math.round(N * 0.5) - H, b0 = (u - 1) * H + Math.round(N * 0.5) + H;
      const lo = Math.max(0, a0 - 6 * H), hi = Math.min(y.length, b0 + 6 * H), nc = Math.floor((hi - lo) / H);
      const mix = (f: number) => {
        const zr = new Float64Array(nc), zi = new Float64Array(nc), w = 2 * Math.PI * f / rate;
        for (let c = 0; c < nc; c++) { let sr = 0, si = 0; for (let i = 0; i < H; i++) { const n = lo + c * H + i; sr += y[n] * Math.cos(w * n); si -= y[n] * Math.sin(w * n); } zr[c] = sr; zi[c] = si; }
        return { zr, zi };
      };
      let z = mix(fc);
      const cA = Math.max(0, Math.floor((a0 - lo) / H) + 1), cB = Math.min(nc - 1, Math.floor((b0 - lo) / H) - 1);
      let pr = 0, pi = 0; for (let c = cA; c < cB; c++) { pr += z.zr[c + 1] * z.zr[c] + z.zi[c + 1] * z.zi[c]; pi += z.zi[c + 1] * z.zr[c] - z.zr[c + 1] * z.zi[c]; }
      const hz = fc + ((pr || pi) ? Math.atan2(pi, pr) * rate / (2 * Math.PI * H) : 0);
      z = mix(hz);
      const env = new Float64Array(nc); for (let c = 0; c < nc; c++) env[c] = Math.hypot(z.zr[c], z.zi[c]);
      const mid: number[] = []; for (let c = cA; c <= cB; c++) mid.push(env[c]);
      const m = pct(mid, 0.5); let s = Math.max(0, cA), e = Math.min(nc - 1, cB);
      while (s > 0 && env[s - 1] >= 0.5 * m) s--;
      while (e < nc - 1 && env[e + 1] >= 0.5 * m) e++;
      out.push({ hz: Math.round(hz * 10) / 10, atS: 0, ms: 0, amp: m, used: false });
      raw.push({ t, u, s: lo + s * H, e: lo + (e + 1) * H });
    }
    t = u;
  }
  // tones back to back: the boundary halfway between their frames (the envelope there holds the next tone too)
  for (let i = 0; i < out.length; i++) {
    let s = raw[i].s, e = raw[i].e;
    if (i > 0 && raw[i].t - raw[i - 1].u <= 8) s = Math.round(((raw[i - 1].u - 1) * H + raw[i].t * H) / 2 + N / 2);
    if (i + 1 < out.length && raw[i + 1].t - raw[i].u <= 8) e = Math.round(((raw[i].u - 1) * H + raw[i + 1].t * H) / 2 + N / 2);
    out[i].atS = s / rate; out[i].ms = Math.round((e - s) * 1000 / rate);
  }
  // one tone broken by a dip (fading, a click): pieces within 1.5 % and 15 ms of each other are one
  const merged: ToneSeg[] = [];
  for (const g of out) {
    const p = merged[merged.length - 1];
    if (p && Math.abs(g.hz - p.hz) <= 0.015 * p.hz && g.atS - (p.atS + p.ms / 1000) <= 0.015) { p.ms = Math.round((g.atS + g.ms / 1000 - p.atS) * 1000); continue; }
    merged.push(g);
  }
  return merged;
}

/** Sub-audio at about 1 kHz: two moving averages, then every [d]th sample. */
function subAudio(y: Float32Array, rate: number): { u: Float32Array; ru: number } {
  const d = Math.max(1, Math.round(rate / 1000)), n = Math.floor(y.length / d), u = new Float32Array(n);
  // the carrier's frequency offset is DC in the discriminator: take it out first
  let mean = 0; for (let i = 0; i < y.length; i++) mean += y[i]; mean /= Math.max(1, y.length);
  const m1 = new Float64Array(y.length); let s = 0;
  for (let i = 0; i < y.length; i++) { s += y[i] - mean; if (i >= d) s -= y[i - d] - mean; m1[i] = s / d; }
  s = 0; let j = 0;
  for (let i = 0; i < y.length; i++) { s += m1[i]; if (i >= d) s -= m1[i - d]; if ((i + 1) % d === 0 && j < n) u[j++] = s / d; }
  return { u, ru: rate / d };
}

function ctcssOf(u: Float32Array, ru: number): number {
  const from = Math.min(u.length, Math.round(0.2 * ru)), to = Math.max(from, u.length - Math.round(0.4 * ru));
  if (to - from < ru * 0.6) return 0;
  let tot = 0; for (let i = from; i < to; i++) tot += u[i] * u[i];
  let best = 0, bi = -1, second = 0;
  CTCSS_TONES.forEach((f, k) => { const p = goertzel(u, from, to, f, ru); if (p > best) { second = best; best = p; bi = k; } else if (p > second) second = p; });
  const frac = best / ((to - from) * tot / 2 + 1e-30);
  return bi >= 0 && best > 4 * second && frac > 0.15 ? CTCSS_TONES[bi] : 0;
}

/** The reverse burst: the tone's phase stepped by 120 or 180 degrees and held until the tone ends; 0 when none. */
function reverseBurst(u: Float32Array, ru: number, f0: number): number {
  const B = Math.max(1, Math.round(ru / 50)), nb = Math.floor(u.length / B);
  if (nb < 40) return 0;
  const zr = new Float64Array(nb), zi = new Float64Array(nb), w = 2 * Math.PI * f0 / ru;
  for (let j = 0; j < nb; j++) { let sr = 0, si = 0; for (let i = 0; i < B; i++) { const n = j * B + i; sr += u[n] * Math.cos(w * n); si -= u[n] * Math.sin(w * n); } zr[j] = sr; zi[j] = si; }
  // a second average over two blocks
  const ar = new Float64Array(nb), ai = new Float64Array(nb), mag = new Float64Array(nb);
  for (let j = 0; j < nb; j++) { ar[j] = zr[j] + (j ? zr[j - 1] : 0); ai[j] = zi[j] + (j ? zi[j - 1] : 0); mag[j] = Math.hypot(ar[j], ai[j]); }
  const med = pct(mag.subarray(Math.floor(nb * 0.2), Math.floor(nb * 0.8)), 0.5);
  let je = nb - 1; while (je > 0 && mag[je] < 0.5 * med) je--;
  const r0 = je - 75, r1 = je - 20; if (r0 < 1) return 0;
  // the phase line before the end, least squares on the unwrapped phase
  const ph: number[] = []; let prev = Math.atan2(ai[r0], ar[r0]), acc = prev;
  for (let j = r0; j <= r1; j++) { const a = Math.atan2(ai[j], ar[j]); acc += wrap(a - prev); prev = a; ph.push(acc); }
  let sx = 0, sy = 0, sxx = 0, sxy = 0; const nn = ph.length;
  for (let i = 0; i < nn; i++) { sx += i; sy += ph[i]; sxx += i * i; sxy += i * ph[i]; }
  const b = (nn * sxy - sx * sy) / (nn * sxx - sx * sx), a0 = (sy - b * sx) / nn;
  const res = (j: number) => wrap(Math.atan2(ai[j], ar[j]) - (a0 + b * (j - r0)));
  for (let js = je - 14; js <= je - 3; js++) {
    let cr = 0, ci = 0; for (let j = js; j <= je; j++) { cr += Math.cos(res(j)); ci += Math.sin(res(j)); }
    const m = Math.atan2(ci, cr), deg = Math.abs(m) * 180 / Math.PI;
    if (deg < 90) continue;
    let held = true; for (let j = js; j <= je; j++) if (Math.abs(wrap(res(j) - m)) > 40 * Math.PI / 180) { held = false; break; }
    if (held) return deg < 150 ? 120 : 180;
  }
  return 0;
}

/**
 * The courtesy tone: tones of 25 to 600 ms with gaps under 150 ms, at most 2 s in all, after 0.3 s with no voice (and
 * 0.3 s into the carrier) and followed by 0.2 s with none (or the end). The last such group: a new over in the tail starts after it.
 */
function courtesyGroup(segs: ToneSeg[], voiceAt: (s: number, e: number) => boolean, durS: number): ToneSeg[] | null {
  let i = 0, found: ToneSeg[] | null = null;
  while (i < segs.length) {
    const g: ToneSeg[] = []; let j = i;
    while (j < segs.length && !segs[j].used && (g.length === 0 || segs[j].atS - (g[g.length - 1].atS + g[g.length - 1].ms / 1000) < 0.15)) { g.push(segs[j]); j++; }
    if (!g.length) { i++; continue; }
    const s = g[0].atS, e = g[g.length - 1].atS + g[g.length - 1].ms / 1000;
    if (s >= 0.3 && g.length <= 6 && e - s <= 2 && g.every(x => x.ms >= 25 && x.ms <= 600) && !voiceAt(Math.max(0, s - 0.3), e + 0.2) && durS - e >= 0.1) found = g;
    i = j;
  }
  return found;
}

const near = (a: number, b: number, rel: number, abs: number) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(a, b));

export class AnalogSignaling {
  /** Decimation to about 8 kHz and the rate it gives. */
  readonly D: number; readonly rate: number;
  carrier = false;
  readonly txs: AnalogTx[] = [];
  onTx: (tx: AnalogTx) => void = () => undefined;
  private readonly B: number;
  private bN = 0; private bE = 0; private bD = 0; private prev = 0; private onRun = 0; private offRun = 0; private onStart = 0; private offStart = 0;
  private acc = 0; private accN = 0; private pos = 0; private dpos = 0;
  private buf = new Float32Array(1 << 16); private blen = 0; private bufAt = 0; private txStart = 0;
  private readonly calls = new Map<string, { count: number; miss: number }>();
  private readonly prints: { key: string; tones: { hz: number; ms: number }[]; count: number }[] = [];
  private readonly timeouts: number[] = [];

  /**
   * Read a transmission only around what was tonal in it (a selcall or 2-tone page, a data burst, a CW ID, a courtesy
   * tone): Repeaters' light look at a channel, where plain voice costs next to nothing more. A tone is 40 ms and more of
   * 10 ms blocks of the 8 kHz audio (high-passed past the sub-audible tone) whose zero crossings stay put and give the
   * frequency its energy does (one tone, where speech's formants do not); each such
   * stretch is read with 0.6 s either side.
   */
  onlyTonal = false;
  private zHp = 0; private zPrev = 0; private zc = 0; private zN = 0; private zE0 = 0; private zE1 = 0; private fPrev = 0; private fRun = 0;
  /** Stretches to read (decimated positions). */
  private segs: [number, number][] = [];
  /** [audio]: the input is squelched audio (silent when no carrier) rather than the discriminator. */
  constructor(readonly fs: number, readonly audio = false) {
    this.D = Math.max(1, Math.round(fs / 8000)); this.rate = fs / this.D; this.B = Math.max(1, Math.round(fs * 0.01));
  }
  reset(): void {
    this.carrier = false; this.txs.length = 0; this.bN = 0; this.bE = 0; this.bD = 0; this.prev = 0; this.onRun = 0; this.offRun = 0;
    this.acc = 0; this.accN = 0; this.pos = 0; this.dpos = 0; this.blen = 0; this.bufAt = 0; this.txStart = 0;
    this.calls.clear(); this.prints.length = 0; this.timeouts.length = 0;
  }
  push(x: ArrayLike<number>, n: number): void {
    for (let i = 0; i < n; i++) {
      const v = x[i]; this.bE += v * v; const d = v - this.prev; this.prev = v; this.bD += d * d;
      this.acc += v; this.pos++;
      if (++this.accN === this.D) { this.append(this.acc / this.D); this.acc = 0; this.accN = 0; }
      if (++this.bN === this.B) this.block();
    }
  }
  /** Ends a transmission still open (the end of a recording). */
  flush(): void { if (this.carrier) { this.carrier = false; this.endTx(this.dpos); } this.onRun = 0; this.offRun = 0; }

  private append(v: number): void {
    if (this.blen === this.buf.length) { const b = new Float32Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
    this.buf[this.blen++] = v; this.dpos++;
    if (this.onlyTonal && this.carrier) {
      // one-pole high-pass at about 250 Hz, then zero crossings per 10 ms
      this.zHp += 0.18 * (v - this.zHp); const h = v - this.zHp, dh = h - this.zPrev;
      if ((h > 0) !== (this.zPrev > 0)) this.zc++;
      this.zPrev = h; this.zE0 += h * h; this.zE1 += dh * dh;
      if (++this.zN >= 80) {
        // the frequency twice: by zero crossings and by the energy of the difference (2 - 2 cos w of the energy for one
        // tone); they agree only on a tone (or a two-tone data burst), not on speech's several formants
        const f = this.zc * this.rate / (2 * this.zN), r = this.zE0 > 0 ? 1 - this.zE1 / (2 * this.zE0) : 1;
        const fe = Math.acos(Math.max(-1, Math.min(1, r))) * this.rate / (2 * Math.PI);
        const steady = f > 250 && f < 3200 && Math.abs(f - this.fPrev) <= Math.max(60, 0.04 * f) && Math.abs(fe - f) <= Math.max(60, 0.06 * f);
        this.fRun = steady ? this.fRun + 1 : 0; this.fPrev = f; this.zc = 0; this.zN = 0; this.zE0 = 0; this.zE1 = 0;
        if (this.fRun >= 4) {
          const pad = Math.round(0.6 * this.rate), from = this.dpos - 6 * 80 - pad, to = this.dpos + pad, last = this.segs[this.segs.length - 1];
          if (last && from <= last[1]) last[1] = Math.max(last[1], to); else this.segs.push([from, to]);
        }
      }
    }
    if (!this.carrier && this.onRun === 0 && this.blen > 2 * this.rate) { const keep = Math.round(this.rate); this.buf.copyWithin(0, this.blen - keep, this.blen); this.bufAt += this.blen - keep; this.blen = keep; }
    if (this.carrier && this.dpos - this.txStart > 240 * this.rate) { this.endTx(this.dpos); this.txStart = this.dpos; }
  }
  private block(): void {
    const B = this.B, on = this.audio ? this.bE / B > 1e-7 : (this.bD / B < 1.0 && this.bE / B > 1e-9);
    this.bN = 0; this.bE = 0; this.bD = 0;
    const start = this.pos - B;
    if (on) {
      this.offRun = 0;
      if (!this.carrier) { if (this.onRun === 0) this.onStart = start; if (++this.onRun >= 2) { this.carrier = true; this.onRun = 0; this.txStart = Math.max(this.bufAt, Math.floor(this.onStart / this.D)); } }
    } else {
      this.onRun = 0;
      if (this.carrier) { if (this.offRun === 0) this.offStart = start; if (++this.offRun >= 4) { this.carrier = false; this.offRun = 0; this.endTx(Math.floor(this.offStart / this.D)); } }
    }
  }
  private endTx(end: number): void {
    const a = this.txStart - this.bufAt, b = Math.min(this.blen, end - this.bufAt);
    if (this.onlyTonal) {
      // the light look reads only the tonal stretches (each a part, which says nothing of a kerchunk or a time-out)
      for (const [f, t] of this.segs) {
        const a2 = Math.max(a, f - this.bufAt), b2 = Math.min(b, t - this.bufAt);
        if (b2 - a2 < Math.round(0.08 * this.rate)) continue;
        const tx = this.analyze(this.buf.slice(a2, b2), (this.bufAt + a2) / this.rate);
        tx.kerchunk = false; tx.timeout = false;
        this.remember(tx); this.txs.push(tx); if (this.txs.length > 30) this.txs.shift(); this.onTx(tx);
      }
      this.segs = []; this.fRun = 0;
    } else if (b - a >= Math.round(0.08 * this.rate)) {
      const tx = this.analyze(this.buf.slice(a, b), this.txStart / this.rate);
      this.remember(tx); this.txs.push(tx); if (this.txs.length > 30) this.txs.shift(); this.onTx(tx);
    }
    const drop = Math.max(0, Math.min(this.blen, end - this.bufAt));
    this.buf.copyWithin(0, drop, this.blen); this.blen -= drop; this.bufAt += drop;
  }

  /** Reads one transmission ([y] at [rate], starting [startS] into the channel). */
  analyze(y: Float32Array, startS: number): AnalogTx {
    const rate = this.rate, durS = y.length / rate, fr = frames(y, rate), ft = (t: number) => (t * H + N / 2) / rate;
    // voice: loud frames that are neither one tone nor data, kept in spans of 60 ms or more
    const lowE = pct(fr.E, 0.2), vThr = Math.max(6 * lowE, 0.002 * pct(fr.E, 0.95), 1e-12);
    const voice = new Uint8Array(fr.nF);
    for (let t = 0; t < fr.nF; t++) voice[t] = !fr.tonal[t] && !fr.data[t] && fr.E[t] > vThr && fr.lohi[t] >= 0.5 ? 1 : 0;
    let voiceF = 0, lastVoice = -1;
    for (let t = 0; t < fr.nF;) {
      if (!voice[t]) { t++; continue; }
      let u = t, gap = 0, cnt = 0;
      while (u < fr.nF && gap < 75) { if (voice[u]) { gap = 0; cnt++; } else gap++; u++; }
      const end = u - gap;
      if (cnt >= 15) { voiceF += cnt; lastVoice = end; } else for (let j = t; j < end; j++) voice[j] = 0;
      t = u;
    }
    // a user is one who talked for 0.3 s or more (a squelch burst or a click is not)
    const voiceS = voiceF * H / rate, lastVoiceS = lastVoice >= 0 && voiceS >= 0.3 ? ft(lastVoice) : -1;
    const voiceAt = (s: number, e: number) => { for (let t = 0; t < fr.nF; t++) { const c = ft(t); if (c >= s && c <= e && voice[t]) return true; } return false; };

    const segs = toneSegments(y, rate, fr);
    const selcall = findSelcalls(segs).map(s => ({ ...s, atS: s.atS + startS }));
    const twoTone: TwoTone[] = [];
    for (let i = 0; i + 1 < segs.length; i++) {
      const a = segs[i], b = segs[i + 1];
      if (a.used || b.used || a.ms < 350 || b.ms < 600 || b.atS - (a.atS + a.ms / 1000) > 0.25 || Math.abs(a.hz - b.hz) < 20) continue;
      if (a.hz < 280 || a.hz > 3000 || b.hz < 280 || b.hz > 3000) continue;
      twoTone.push({ aHz: Math.round(a.hz), bHz: Math.round(b.hz), aMs: a.ms, bMs: b.ms, atS: startS + a.atS }); a.used = b.used = true; i++;
    }
    // data bursts: MDC-1200 decoded where it is, other bursts by rate
    const mdc: MdcPacket[] = [], fleetsync: FleetSync[] = [], data: DataBurst[] = [];
    for (let t = 0; t < fr.nF;) {
      // a search frame is in the data band and louder than the quiet carrier (whose noise is in that band too)
      if (!(fr.fsk[t] && fr.E[t] > vThr)) { t++; continue; }
      // a burst holds together over runs of one bit (a single tone for a while): gaps up to 100 ms
      let u = t + 1, gap = 0, cnt = 1, strict = fr.data[t]; while (u < fr.nF && gap < 25) { if (fr.fsk[u] && fr.E[u] > vThr) { gap = 0; cnt++; strict += fr.data[u]; } else gap++; u++; }
      u -= gap;
      // (the light look leaves a burst that is one pure tone all through, a CW ID or a courtesy tone, to those readers)
      if (cnt >= 10 && cnt >= 0.45 * (u - t) && !(this.onlyTonal && strict === 0)) {
        const from = Math.max(0, t * H - 24 * H), to = Math.min(y.length, u * H + N + 24 * H);
        const got = decodeMdc(y, from, to, rate, startS);
        const fsy = got.length ? [] : decodeFleetSync(y, from, to, rate, startS);
        if (got.length) mdc.push(...got);
        else if (fsy.length) fleetsync.push(...fsy);
        else if (strict >= 10 && strict >= 0.55 * (u - t) && (u - t) * H / rate >= 0.12 && (u - t) * H / rate <= 1.2) {
          let hs = 0, hn = 0; for (let j = t; j < u; j++) if (fr.fsk[j] && fr.E[j] > vThr) { hs += fr.hi[j]; hn++; }
          // the rate from the burst's width: 1200 baud FFSK keeps to 900-2100 Hz, 2400 baud spreads above it
          data.push({ baud: hs / hn > 0.08 ? 2400 : 1200, ms: Math.round((u - t) * H * 1000 / rate), atS: startS + ft(t) });
        }
      }
      t = u;
    }
    // CW: segments that are the ID's own marks are not courtesy tones
    const cw = decodeCwId(y, rate, fr.pitches, startS);
    if (cw) for (const s of segs) if (Math.abs(s.hz - cw.pitchHz) < 40 && s.ms < 400) s.used = true;
    const cg = courtesyGroup(segs, voiceAt, durS);
    let courtesy: CourtesyTone | null = null;
    if (cg) {
      const tones = cg.map(s => ({ hz: Math.round(s.hz), ms: Math.round(s.ms / 10) * 10 }));
      courtesy = { tones, key: tones.map(t => `${Math.round(t.hz / 5) * 5}x${t.ms}`).join('+'), atS: startS + cg[0].atS, seen: 0 };
    }
    // sub-audio
    const { u, ru } = subAudio(y, rate);
    const ctcss = ctcssOf(u, ru);
    const rb = ctcss ? reverseBurst(u, ru, ctcss) : 0;
    const sub = new SubAudioDecoder(rate), counts = new Map<number, number>(); let dcs = 0, dcsN = 0;
    for (let i = 0; i < y.length; i += 400) { const m = Math.min(400, y.length - i); sub.push(y.subarray(i, i + m), m); if (sub.dcs) counts.set(sub.dcs, (counts.get(sub.dcs) ?? 0) + 1); }
    for (const [c, k] of counts) if (k > dcsN || (k === dcsN && c < dcs)) { dcs = c; dcsN = k; }
    if (ctcss) dcs = 0;
    let dcsTurnOff = false;
    if (dcs && !ctcss) {
      const e0 = u.length - Math.round(0.02 * ru), e1 = u.length - Math.round(0.17 * ru), p0 = u.length - Math.round(0.6 * ru), p1 = u.length - Math.round(0.25 * ru);
      const ratio = (a: number, b: number) => { let t = 0; for (let i = a; i < b; i++) t += u[i] * u[i]; return goertzel(u, a, b, 134.4, ru) / ((b - a) * t / 2 + 1e-30); };
      if (p0 > 0) dcsTurnOff = ratio(e1, e0) > 0.5 && ratio(p0, p1) < 0.3;
    }
    // end of the over
    const unkeyS = lastVoiceS >= 0 ? Math.min(durS, lastVoiceS) : courtesy ? courtesy.atS - startS : -1;
    const tailS = unkeyS >= 0 ? Math.round((durS - unkeyS) * 100) / 100 : -1;
    const timeout = durS >= 25 && lastVoiceS >= 0 && durS - lastVoiceS < 0.25 && !courtesy;
    const kerchunk = voiceS < 0.3 && !cw && !selcall.length && !twoTone.length && !mdc.length && !fleetsync.length && !data.length && durS < 15;
    return {
      startS: Math.round(startS * 1000) / 1000, durS: Math.round(durS * 1000) / 1000, voiceS: Math.round(voiceS * 100) / 100,
      unkeyS: unkeyS >= 0 ? Math.round(unkeyS * 100) / 100 : -1, tailS, ctcss, dcs, reverseBurst: rb, dcsTurnOff,
      courtesy, cw, selcall, twoTone, mdc, fleetsync, data, timeout, kerchunk,
    };
  }

  private remember(tx: AnalogTx): void {
    if (tx.cw) { const k = tx.cw.callsign + (tx.cw.suffix ? '/' + tx.cw.suffix : ''), v = this.calls.get(k) ?? { count: 0, miss: 1 }; v.count++; v.miss *= 1 - tx.cw.confidence; this.calls.set(k, v); }
    if (tx.courtesy) {
      const c = tx.courtesy;
      let p = this.prints.find(q => q.tones.length === c.tones.length && q.tones.every((t, i) => near(t.hz, c.tones[i].hz, 0.015, 8) && near(t.ms, c.tones[i].ms, 0.2, 20)));
      if (!p) { p = { key: c.key, tones: c.tones, count: 0 }; this.prints.push(p); }
      p.count++; c.key = p.key; c.seen = p.count;
    }
    if (tx.timeout) this.timeouts.push(tx.durS);
  }

  snapshot(): AnalogSnap {
    let cwId: AnalogSnap['cwId'] = null;
    for (const [k, v] of this.calls) { const conf = Math.round(Math.min(0.99, 1 - v.miss) * 100) / 100; if (!cwId || v.count > cwId.count || (v.count === cwId.count && conf > cwId.confidence)) cwId = { callsign: k, count: v.count, confidence: conf }; }
    return {
      carrier: this.carrier, txs: this.txs.slice(), cwId, courtesy: this.prints.map(p => ({ key: p.key, tones: p.tones.slice(), count: p.count })),
      timeoutS: this.timeouts.length ? Math.round(pct(this.timeouts, 0.5) * 10) / 10 : 0,
    };
  }
}

/** One line per thing heard in a transmission, for the UI (app copy: no dashes as punctuation, no colons). */
export function analogSummary(tx: AnalogTx): string[] {
  const out: string[] = [];
  if (tx.cw) out.push(`CW ID ${tx.cw.callsign}${tx.cw.suffix ? '/' + tx.cw.suffix : ''}, ${tx.cw.wpm} WPM`);
  for (const s of tx.selcall) out.push(`${s.system} selcall ${s.digits}`);
  for (const t of tx.twoTone) out.push(`2-tone page ${t.aHz} and ${t.bHz} Hz`);
  for (const m of tx.mdc) out.push(`MDC-1200 unit ${m.unit}${m.label ? ' ' + m.label : ` op ${m.op.toString(16).toUpperCase().padStart(2, '0')}`}`);
  for (const f of tx.fleetsync) out.push(`FleetSync ${f.baud === 2400 ? 'II' : 'I'} ${f.fromFleet < 0 ? 'all' : f.fromFleet}-${f.fromUnit < 0 ? 'all' : f.fromUnit} to ${f.toFleet < 0 ? 'all' : f.toFleet}-${f.toUnit < 0 ? 'all' : f.toUnit}`);
  for (const d of tx.data) out.push(`${d.baud} baud data burst`);
  if (tx.ctcss) out.push(`PL ${tx.ctcss.toFixed(1)}${tx.reverseBurst ? `, reverse burst ${tx.reverseBurst}°` : ''}`);
  if (tx.dcs) out.push(`DCS ${String(tx.dcs).padStart(3, '0')}${tx.dcsTurnOff ? ', turn-off code' : ''}`);
  if (tx.courtesy) out.push(`Courtesy tone ${tx.courtesy.tones.map(t => t.hz).join(' ')} Hz${tx.courtesy.seen > 1 ? `, heard ${tx.courtesy.seen} times` : ''}`);
  if (tx.tailS >= 0) out.push(`Tail ${tx.tailS.toFixed(1)} s`);
  if (tx.timeout) out.push(`Timed out after ${Math.round(tx.durS)} s`);
  if (tx.kerchunk) out.push('Kerchunk');
  return out;
}
