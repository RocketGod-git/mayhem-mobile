/**
 * Motorola Type II (SmartNet, SmartZone) control channels: the outbound signaling words (OSWs) a site sends without a
 * break, 3600 bits a second, two-level FSK. No DOM.
 *
 * Each OSW is 84 bits: the sync 0xAC, then 76 bits interleaved 19 by 4, which carry a rate 1/2 convolutional code
 * (each data bit, then that bit added to the one before it) of 38 bits: 27 data bits (a 16-bit address, a flag, a
 * 10-bit command), a 10-bit check (the data times x^10 modulo x^10 + x^6 + x^3 + x + 1, plus 0x06C) and a zero tail.
 * The address and command are read through masks (0xCC38 and 0x0D5: the data bits inverted, then 0x33C7 and 0x32A)
 * and the flag as received. The check polynomial, its constant and the masks were confirmed on our own recording (2026-11-20 roof, 939.475 MHz): every word that passed
 * its convolutional code without a correction agrees with them.
 *
 * Words read here, and only these:
 *  - 0x308 then 0x30B whose address is 0x28xx: the system ID (the first word's address) and the control channel's
 *    number (the second word's low 10 bits).
 *  - 0x308 then a channel number (0 to 0x2F7): a grant, from the first word's unit to the second word's talkgroup.
 *  - a channel number alone: the update of a call already on that channel.
 *  - 0x2F8: idle.
 * Everything else is shown as its raw address, flag and command.
 */

export interface Osw { addr: number; flag: number; cmd: number }
/** Talkgroup words carry flag 0: every talkgroup granted in our recording did, several radios taking turns on each. */
export const oswGroup = (o: Osw) => o.flag === 0;
export const OSW_SYNC = 0xac;
export const OSW_BITS = 84;
export const OSW_BAUD = 3600;
const ADDR_MASK = 0xcc38, CMD_MASK = 0x0d5;
/** The talkgroup of a group address (its low four bits are status bits), and those status bits. */
export const tgOf = (addr: number) => addr & 0xfff0;
export const tgStatus = (addr: number) => addr & 0xf;

/** The 10-bit check of 27 data bits (as sent: before the inversion is undone). */
export function oswCrc(v: number): number {
  let r = 0;
  for (let b = 26; b >= 0; b--) { const fb = ((v >>> b) & 1) ^ ((r >> 9) & 1); r = (r << 1) & 0x3ff; if (fb) r ^= 0x04b; }
  return r ^ 0x06c;
}

/**
 * One frame's 76 soft bits (positive is a 1, polarity already applied) to an OSW, or null when its check fails. The
 * convolutional code is decoded by a two-state Viterbi on the soft values, ending on the zero tail.
 */
export function decodeOsw(soft: ArrayLike<number>): Osw | null {
  const d = new Float32Array(76);
  for (let i = 0; i < 19; i++) for (let j = 0; j < 4; j++) d[i * 4 + j] = soft[j * 19 + i];
  // metrics and survivors for state = the previous data bit
  let m0 = 0, m1 = -1e9; const from = new Uint8Array(38 * 2);
  for (let k = 0; k < 38; k++) {
    const s0 = d[2 * k], s1 = d[2 * k + 1];
    // into state b from state p: data bit b, parity b ^ p
    let n0 = -1e18, n1 = -1e18;
    for (let p = 0; p < 2; p++) {
      const mp = p ? m1 : m0;
      for (let b = 0; b < 2; b++) {
        const mm = mp + (b ? s0 : -s0) + ((b ^ p) ? s1 : -s1);
        if (b === 0) { if (mm > n0) { n0 = mm; from[2 * k] = p; } } else if (mm > n1) { n1 = mm; from[2 * k + 1] = p; }
      }
    }
    m0 = n0; m1 = n1;
  }
  const bits = new Uint8Array(38); let st = 0;
  for (let k = 37; k >= 0; k--) { bits[k] = st; st = from[2 * k + st]; }
  let v = 0, c = 0;
  for (let k = 0; k < 27; k++) v = v * 2 + bits[k];
  for (let k = 27; k < 37; k++) c = c * 2 + bits[k];
  if (oswCrc(v) !== c) return null;
  return { addr: (v >>> 11) ^ ADDR_MASK, flag: (v >>> 10) & 1, cmd: (v & 0x3ff) ^ CMD_MASK };
}

/** The air side of an OSW (for the tests' transmitter): the 84 bits as sent, sync first. */
export function encodeOsw(o: Osw): Uint8Array {
  const v = (((o.addr ^ ADDR_MASK) & 0xffff) << 11) | ((o.flag & 1) << 10) | ((o.cmd ^ CMD_MASK) & 0x3ff), c = oswCrc(v);
  const data = new Uint8Array(38);
  for (let k = 0; k < 27; k++) data[k] = (v >>> (26 - k)) & 1;
  for (let k = 0; k < 10; k++) data[27 + k] = (c >> (9 - k)) & 1;
  const code = new Uint8Array(76); let p = 0;
  for (let k = 0; k < 38; k++) { code[2 * k] = data[k]; code[2 * k + 1] = data[k] ^ p; p = data[k]; }
  const out = new Uint8Array(84);
  for (let b = 0; b < 8; b++) out[b] = (OSW_SYNC >> (7 - b)) & 1;
  for (let i = 0; i < 19; i++) for (let j = 0; j < 4; j++) out[8 + j * 19 + i] = code[i * 4 + j];
  return out;
}

/**
 * The OSW receiver on a channel's complex baseband at [fs]: an FM discriminator, a moving average a symbol long,
 * the bit clock pulled to the zero crossings, and every bit position tried for the sync (either polarity). A frame
 * that passes its check holds the search off until its end, so the sync's pattern inside its data does not count.
 */
export class OswRx {
  /** A word that passed its check, and how many frames on from the last one (1: the very next frame). */
  onOsw: (o: Osw, gap: number) => void = () => undefined;
  /** Frames that passed their check, and the frames the bit count since the first says were sent. */
  good = 0; expected = 0;
  private pi = 0; private pq = 0; private dc = 0; private ph = 0; private last = 0; private center = 0;
  private readonly sps: number; private readonly hist: Float32Array; private hp = 0; private hs = 0;
  private readonly ring = new Float32Array(128); private n = 0; private hold = 0; private lastGood = -1;
  constructor(readonly fs: number) {
    this.sps = fs / OSW_BAUD;
    this.hist = new Float32Array(Math.max(2, Math.round(this.sps * 0.75)));
  }
  push(zi: Float32Array, zq: Float32Array, m: number): void {
    const L = this.hist.length, sps = this.sps, half = sps / 2;
    for (let k = 0; k < m; k++) {
      const i = zi[k], q = zq[k];
      const f = Math.atan2(q * this.pi - i * this.pq, i * this.pi + q * this.pq); this.pi = i; this.pq = q;
      this.hs += f - this.hist[this.hp]; this.hist[this.hp] = f; if (++this.hp >= L) this.hp = 0;
      const v = this.hs / L; this.dc += (v - this.dc) / (sps * 200); const x = v - this.dc;
      const sg = x > 0 ? 1 : -1;
      if (sg !== this.last) { let e = this.ph; if (e > half) e -= sps; this.ph -= 0.08 * e; this.last = sg; }
      const was = this.ph; this.ph += 1;
      if (was < half && this.ph >= half) this.center = x;
      if (this.ph >= sps) { this.ph -= sps; this.bit(this.center); }
    }
  }
  private bit(x: number): void {
    const R = this.ring.length; this.ring[this.n % R] = x; this.n++;
    if (this.n < OSW_BITS || this.n - OSW_BITS < this.hold) return;
    const s0 = this.n - OSW_BITS;
    let sync = 0; for (let b = 0; b < 8; b++) sync = (sync << 1) | (this.ring[(s0 + b) % R] > 0 ? 1 : 0);
    const pol = sync === OSW_SYNC ? 1 : sync === (~OSW_SYNC & 0xff) ? -1 : 0;
    if (!pol) return;
    let e = 0; for (let b = 8; b < OSW_BITS; b++) e += Math.abs(this.ring[(s0 + b) % R]);
    const sc = pol * 76 / Math.max(e, 1e-9), soft = new Float32Array(76);
    for (let b = 0; b < 76; b++) soft[b] = this.ring[(s0 + 8 + b) % R] * sc;
    const o = decodeOsw(soft); if (!o) return;
    this.hold = this.n - 2;
    const gap = this.lastGood < 0 ? 0 : Math.max(1, Math.round((s0 - this.lastGood) / OSW_BITS));
    this.expected += Math.max(1, gap); this.good++; this.lastGood = s0;
    this.onOsw(o, gap);
  }
}

export type OswEvent =
  | { kind: 'sysid'; sys: number; cc: number; words: Osw[] }
  | { kind: 'grant'; src: number; tg: number; group: boolean; ch: number; words: Osw[] }
  | { kind: 'update'; tg: number; group: boolean; ch: number; words: Osw[] }
  | { kind: 'idle'; words: Osw[] }
  | { kind: 'other'; words: Osw[] };
/** A channel number, not a command. [upper800]: also the channel numbers above 0x2F7 that 800 MHz plans use (0x32F-0x33F, 0x3BE, 0x3C1-0x3FE): on other bands those are commands. Live traffic puts the commands in the gaps between them (0x308-0x32E, 0x340, 0x3A0, 0x3BF, 0x3C0). */
export const isChannel = (cmd: number, upper800 = false) => cmd < 0x2f8 || (upper800 && ((cmd >= 0x32f && cmd <= 0x33f) || cmd === 0x3be || (cmd >= 0x3c1 && cmd <= 0x3fe)));

/** OSWs in the order sent to messages: a 0x308 waits for the word after it. A failed frame between breaks a pair. */
export class OswParser {
  private first: Osw | null = null;
  /** The control channel proved an 800 MHz plan: its upper channel numbers are channels. */
  upper800 = false;
  /** A frame failed its check: a 0x308 waiting for its second word is dropped. */
  lost(): OswEvent[] { const f = this.first; this.first = null; return f ? [{ kind: 'other', words: [f] }] : []; }
  push(o: Osw): OswEvent[] {
    const out: OswEvent[] = [];
    if (o.cmd === 0x308) { if (this.first) out.push({ kind: 'other', words: [this.first] }); this.first = o; return out; }
    const f = this.first; this.first = null;
    if (f) {
      if (o.cmd === 0x30b && (o.addr & 0xfc00) === 0x2800) out.push({ kind: 'sysid', sys: f.addr, cc: o.addr & 0x3ff, words: [f, o] });
      else if (isChannel(o.cmd, this.upper800)) out.push({ kind: 'grant', src: f.addr, tg: o.addr, group: oswGroup(o), ch: o.cmd, words: [f, o] });
      else out.push({ kind: 'other', words: [f, o] });
      return out;
    }
    if (isChannel(o.cmd, this.upper800)) out.push({ kind: 'update', tg: o.addr, group: oswGroup(o), ch: o.cmd, words: [o] });
    else if (o.cmd === 0x2f8) out.push({ kind: 'idle', words: [o] });
    else out.push({ kind: 'other', words: [o] });
    return out;
  }
}

/** The channel plans a Type II channel number can be on, by band. */
export interface OswPlan { id: string; label: string; hz: (ch: number) => number }
/** Channel ranges [first, last, Hz of the first, step]: a later range wins where two overlap. */
type OswRange = [number, number, number, number];
const oswTable = (rs: OswRange[]) => (ch: number): number => {
  for (let i = rs.length - 1; i >= 0; i--) { const [a, b, base, step] = rs[i]; if (ch >= a && ch <= b) return base + step * (ch - a); }
  return 0;
};
/** The ranges every 800 MHz plan shares, over its own (trunk-recorder's smartnet_parser get_freq). */
const OSW_800_TOP: OswRange[] = [[0x2d0, 0x2f7, 866_000_000, 25_000], [0x32f, 0x33f, 867_000_000, 25_000], [0x3c1, 0x3fe, 867_425_000, 25_000], [0x3be, 0x3be, 868_975_000, 0]];
export const OSW_PLANS: OswPlan[] = [
  { id: '900', label: '900 MHz', hz: oswTable([[0, 0x1df, 935_012_500, 12_500]]) },
  { id: '800', label: '800 MHz standard', hz: oswTable([[0, 0x2cf, 851_012_500, 25_000], ...OSW_800_TOP]) },
  { id: '800S', label: '800 MHz splinter', hz: oswTable([[0, 0x257, 851_000_000, 25_000], [0x258, 0x2cf, 866_012_500, 25_000], ...OSW_800_TOP]) },
  { id: '800R', label: '800 MHz rebanded', hz: oswTable([[0, 0x1b7, 851_012_500, 25_000], [0x1b8, 0x22f, 851_025_000, 25_000], ...OSW_800_TOP]) },
];
/**
 * How far a control channel may be heard from where a plan puts it and still prove that plan: a radio's own frequency
 * error is a few kHz, and the two closest plans (800 standard and splinter) are 12.5 kHz apart.
 */
export const PLAN_TOL_HZ = 5_000;
/**
 * The plan a control channel proves: the one that puts the channel number the site announces for its own control
 * channel nearest the frequency it is heard on, within [PLAN_TOL_HZ], and the radio's error there (heard minus plan).
 * Plans that put the number on the same frequency agree (the first listed stands); two at the same distance on
 * different frequencies prove nothing. Null when none fits, and grants are shown by channel number.
 */
export function fitPlan(ccNumber: number, heardHz: number, plans: OswPlan[] = OSW_PLANS): { plan: OswPlan; offset: number } | null {
  const hits: { plan: OswPlan; hz: number; d: number }[] = [];
  for (const p of plans) {
    const hz = p.hz(ccNumber), d = Math.abs(heardHz - hz);
    if (hz > 0 && d <= PLAN_TOL_HZ && !hits.some(x => x.hz === hz)) hits.push({ plan: p, hz, d });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.d - b.d);
  if (hits.length > 1 && hits[1].d === hits[0].d) return null;
  return { plan: hits[0].plan, offset: Math.round(heardHz - hits[0].hz) };
}
export function provePlan(ccNumber: number, heardHz: number): OswPlan | null { return fitPlan(ccNumber, heardHz)?.plan ?? null; }

/** Frequency text: MHz to four places, five when the fifth is not zero (6.25 kHz steps). */
export function oswMhz(hz: number): string { const s = (Math.round(hz / 10) / 1e5).toFixed(5); return s.endsWith('0') ? s.slice(0, -1) : s; }
/** kHz text with no trailing zeros: 12.5, 6.25, 25. */
export function oswKhz(hz: number): string { return String(Math.round(hz) / 1000); }
/**
 * A plan given by hand or learned from the air, like trunk-recorder's 400_custom: channels [first] to
 * [first] + (high - base) / step are base + step * (channel - first). Learned plans start at channel 0 and cover all.
 */
export interface OswCustom { kind: 'entered' | 'learned'; base: number; high: number; step: number; first: number }
export function customPlan(x: OswCustom): OswPlan {
  const n = Math.floor((x.high - x.base) / x.step + 1e-6);
  return { id: x.kind, label: `${x.kind}: ${oswMhz(x.base)} + ${oswKhz(x.step)} kHz`, hz: ch => ch >= x.first && ch <= x.first + n ? Math.round(x.base + x.step * (ch - x.first)) : 0 };
}
/** The highest channel number a Type II word carries (ten bits). */
export const OSW_MAX_CH = 0x3ff;
/**
 * A plan typed in (base MHz, high MHz, spacing kHz, first channel), or null when a number is out of range: base and
 * high 25 to 1300 MHz with high at or above base, spacing 1 to 100 kHz, the first channel a whole number and the last
 * no higher than [OSW_MAX_CH].
 */
export function enteredPlan(baseMhz: number, highMhz: number, spacingKhz: number, first: number): OswCustom | null {
  if (![baseMhz, highMhz, spacingKhz, first].every(Number.isFinite)) return null;
  if (baseMhz < 25 || baseMhz > 1300 || highMhz < baseMhz || highMhz > 1300 || spacingKhz < 1 || spacingKhz > 100) return null;
  if (first < 0 || Math.floor(first) !== first) return null;
  const base = Math.round(baseMhz * 1e6), high = Math.round(highMhz * 1e6), step = Math.round(spacingKhz * 1000);
  if (first + Math.floor((high - base) / step + 1e-6) > OSW_MAX_CH) return null;
  return { kind: 'entered', base, high, step, first };
}
/** The radio's error as text ('' under 0.1 kHz): "radio 2.1 kHz high". */
export function oswOffsetText(offset: number): string {
  const k = Math.round(Math.abs(offset) / 100) / 10;
  return k < 0.1 ? '' : `radio ${k.toFixed(1)} kHz ${offset > 0 ? 'high' : 'low'}`;
}

/** A grant and a carrier keying up within this long are one call's start. */
export const LEARN_WINDOW_MS = 1_500;
/** Sightings of a channel on one frequency before it counts. */
export const LEARN_SIGHTINGS = 3;
/** The channel steps a learned plan may have, and how close the one measured must come. */
export const LEARN_STEPS = [5_000, 6_250, 7_500, 12_500, 25_000];
const LEARN_STEP_TOL = 300;
/**
 * A Type II system's channel plan learned from the air, for a control channel no published plan fits (VHF and UHF
 * systems): a grant for channel N followed within [LEARN_WINDOW_MS] by a carrier keying up in the span is a sighting
 * of N there. A channel seen [LEARN_SIGHTINGS] times on the same frequency (within [PLAN_TOL_HZ]) is trusted; two
 * trusted channels give the step (one of [LEARN_STEPS]) and with it every channel. A trusted channel that gives no
 * such step with any other is dropped.
 */
export class OswLearner {
  private grants: { ch: number; ms: number }[] = [];
  /** Sightings per channel: frequencies (averaged) and how many times each. */
  readonly pins = new Map<number, { hz: number; n: number }[]>();
  /** Hz of channel 0 and the step, once learned. */
  plan: { base: number; step: number } | null = null;
  grant(ch: number, ms: number): void {
    if (this.plan) return;
    this.grants = this.grants.filter(g => ms - g.ms <= LEARN_WINDOW_MS && g.ch !== ch);
    this.grants.push({ ch, ms });
  }
  /** A carrier keyed up at [hz]: true when that taught the plan. */
  keyUp(hz: number, ms: number): boolean {
    if (this.plan) return false;
    const g = this.grants.filter(x => ms >= x.ms && ms - x.ms <= LEARN_WINDOW_MS);
    // two channels granted together: which one keyed up is not known
    if (g.length !== 1) return false;
    this.grants = this.grants.filter(x => x !== g[0]);
    return this.sight(g[0].ch, hz);
  }
  sight(ch: number, hz: number): boolean {
    if (this.plan) return false;
    const list = this.pins.get(ch) ?? [];
    let p = list.find(x => Math.abs(x.hz - hz) <= PLAN_TOL_HZ);
    if (p) { p.hz = (p.hz * p.n + hz) / (p.n + 1); p.n++; } else { p = { hz, n: 1 }; list.push(p); }
    this.pins.set(ch, list);
    return p.n === LEARN_SIGHTINGS ? this.solve(ch, p) : false;
  }
  /** Each channel's most seen frequency, once seen [LEARN_SIGHTINGS] times. */
  trusted(): { ch: number; hz: number; n: number }[] {
    const out: { ch: number; hz: number; n: number }[] = [];
    for (const [ch, list] of this.pins) { const b = list.reduce((a, x) => x.n > a.n ? x : a, list[0]); if (b && b.n >= LEARN_SIGHTINGS) out.push({ ch, hz: b.hz, n: b.n }); }
    return out.sort((a, b) => b.n - a.n || a.ch - b.ch);
  }
  private solve(ch: number, p: { hz: number; n: number }): boolean {
    const all = this.trusted(), others = all.filter(x => x.ch !== ch);
    if (!others.length) return false;
    for (const o of others) {
      const raw = (p.hz - o.hz) / (ch - o.ch), step = LEARN_STEPS.find(s => Math.abs(raw - s) <= LEARN_STEP_TOL);
      if (!step) continue;
      const base = ((p.hz - step * ch) + (o.hz - step * o.ch)) / 2;
      if (base <= 0 || !all.every(x => Math.abs(base + step * x.ch - x.hz) <= PLAN_TOL_HZ)) continue;
      this.plan = { base: Math.round(base), step };
      return true;
    }
    const list = this.pins.get(ch) ?? [];
    this.pins.set(ch, list.filter(x => x !== p));
    return false;
  }
  /** The plan learned, as a plan over every channel number. */
  custom(): OswCustom | null { return this.plan ? { kind: 'learned', base: this.plan.base, high: this.plan.base + this.plan.step * OSW_MAX_CH, step: this.plan.step, first: 0 } : null; }
}
const hx = (v: number, n: number) => v.toString(16).toUpperCase().padStart(n, '0');
export const oswWordText = (o: Osw) => `${hx(o.addr, 4)} ${o.flag} ${hx(o.cmd, 3)}`;
export const oswHex = (words: Osw[]) => words.map(oswWordText).join(' / ');

/**
 * The squelch opens on a block whose noise is under [SQ_OPEN] and stays open [SQ_HANG_BLOCKS] blocks (300 ms) past the
 * last such block, closing at once on a block of bare noise ([SQ_SHUT]: a channel with no carrier reads about 0.3). Loud
 * syllables lift the noise reading too (a clean call has one block in twenty over 0.12), and a block-by-block decision
 * dropped those 20 ms blocks from the middle of words.
 */
export const SQ_OPEN = 0.12, SQ_SHUT = 0.25, SQ_HANG_BLOCKS = 15;
/**
 * Analog FM voice on a channel's complex baseband at [fs] (a Type II voice channel): the discriminator, a 3.4 kHz
 * low-pass, down to 8 kHz, the sub-audible signaling taken out below 300 Hz, and the 6 dB an octave pre-emphasis taken
 * back. 20 ms blocks come out with [open]: the noise above the voice band says whether a carrier is there.
 */
export class FmVoice {
  onPcm: (pcm: Float32Array, open: boolean) => void = () => undefined;
  private pi = 0; private pq = 0; private readonly dec: number; private readonly lp: Float32Array; private readonly hist: Float32Array; private hp = 0; private ph = 0;
  private hpX = 0; private hpY = 0; private hpX2 = 0; private hpY2 = 0; private de = 0; private nz = 0; private np = 0; private prev = 0;
  private readonly out = new Float32Array(160); private on = 0; private hang = 0;
  constructor(readonly fs: number) {
    this.dec = Math.max(1, Math.round(fs / 8000));
    const taps = 8 * this.dec + 1, fc = 3400 / fs, m = (taps - 1) / 2; this.lp = new Float32Array(taps); let s = 0;
    for (let i = 0; i < taps; i++) { const x = i - m, w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)); this.lp[i] = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * w; s += this.lp[i]; }
    for (let i = 0; i < taps; i++) this.lp[i] /= s;
    this.hist = new Float32Array(taps);
  }
  push(zi: Float32Array, zq: Float32Array, m: number): void {
    const T = this.lp.length, toHz = this.fs / (2 * Math.PI);
    for (let k = 0; k < m; k++) {
      const i = zi[k], q = zq[k];
      const f = Math.atan2(q * this.pi - i * this.pq, i * this.pi + q * this.pq) * toHz; this.pi = i; this.pq = q;
      // the noise squelch: what is left after the voice band (a first difference twice, above about 4 kHz)
      const d = f - this.prev; this.prev = f; this.nz += d * d; this.np++;
      this.hist[this.hp] = f; if (++this.hp >= T) this.hp = 0;
      if (++this.ph < this.dec) continue;
      this.ph = 0;
      let y = 0, j = this.hp; for (let t = 0; t < T; t++) { y += this.lp[t] * this.hist[j]; if (++j >= T) j = 0; }
      // 300 Hz high-pass (two poles), then the de-emphasis (a 300 Hz pole), scaled so 2.5 kHz of deviation at 1 kHz is about 0.2
      const hp1 = 0.81 * (this.hpY + y - this.hpX); this.hpX = y; this.hpY = hp1;
      const hpv = 0.81 * (this.hpY2 + hp1 - this.hpX2); this.hpX2 = hp1; this.hpY2 = hpv;
      this.de += 0.21 * (hpv - this.de);
      const s = this.de / 2000;
      this.out[this.on++] = s;
      if (this.on === 160) {
        const noise = Math.sqrt(this.nz / Math.max(1, this.np)) / (this.fs / 2);
        // a carrier quiets the discriminator: unmodulated noise there sits near a third of the sample rate
        this.hang = noise < SQ_OPEN ? SQ_HANG_BLOCKS : noise >= SQ_SHUT ? 0 : Math.max(0, this.hang - 1);
        const open = this.hang > 0;
        this.onPcm(this.out.slice(), open);
        this.on = 0; this.nz = 0; this.np = 0;
      }
    }
  }
}
