/**
 * Repeater signaling beyond the callsigns:
 *
 *   · D-STAR header flags (JARL standard, flag 1): data or voice, through a repeater or direct, interrupted (BREAK),
 *     control, urgent (EMR), and the three-bit function (repeater control, auto reply, resend, ACK, no reply, relay
 *     unavailable);
 *   · what a D-STAR URCALL asks for: CQ, a call routed to another repeater ("/N0RPT B"), a callsign route, or the
 *     gateway commands radios send in the last character (L link, U unlink, E echo, I info), with the reflector
 *     named when one is ("REF030CL" links module C of REF030);
 *   · DTMF digits in an FM channel's audio (link and control codes, autopatch): Goertzel filters on the eight
 *     tones every 20 ms, a digit when one row and one column tone stand clear of the rest for 40 ms.
 * No DOM.
 */

export interface DStarFlags { data: boolean; repeater: boolean; interrupted: boolean; control: boolean; urgent: boolean; func: string }
const FUNCS = ['', 'relay unavailable', 'no reply', 'ACK', 'resend', 'unused', 'auto reply', 'repeater control'];
export function dstarFlags(flag1: number): DStarFlags {
  return { data: (flag1 & 0x80) !== 0, repeater: (flag1 & 0x40) !== 0, interrupted: (flag1 & 0x20) !== 0, control: (flag1 & 0x10) !== 0, urgent: (flag1 & 0x08) !== 0, func: FUNCS[flag1 & 7] };
}

export interface UrCall { kind: 'cq' | 'repeater' | 'callsign' | 'link' | 'unlink' | 'echo' | 'info' | ''; target: string; module: string }
/** What a URCALL field asks for. */
export function urcallCommand(ur: string): UrCall {
  const f = (ur + '        ').slice(0, 8), last = f[7], head = f.slice(0, 7).trim(), t = f.trim();
  if (!t) return { kind: '', target: '', module: '' };
  if (/^CQCQCQ/.test(t)) return { kind: 'cq', target: '', module: '' };
  if (f[0] === '/') return { kind: 'repeater', target: f.slice(1, 7).trim(), module: last.trim() };
  if (!head && last === 'U') return { kind: 'unlink', target: '', module: '' };
  if (!head && last === 'E') return { kind: 'echo', target: '', module: '' };
  if (!head && last === 'I') return { kind: 'info', target: '', module: '' };
  const m = /^(REF|XRF|XLX|DCS)(\d{3})([A-Z])L$/.exec(t.replace(/ /g, ''));
  if (m) return { kind: 'link', target: m[1] + m[2], module: m[3] };
  return { kind: 'callsign', target: t, module: '' };
}

// ------------------------------------------------------------------------------------------------ DTMF
const ROWS = [697, 770, 852, 941], COLS = [1209, 1336, 1477, 1633];
const KEYS = ['123A', '456B', '789C', '*0#D'];

export interface DtmfEvent { digit: string; atS: number }

export class DtmfDecoder {
  onDigit: (e: DtmfEvent) => void = () => undefined;
  readonly digits: DtmfEvent[] = [];
  private readonly N: number; private readonly coef: number[];
  private readonly s1 = new Float64Array(8); private readonly s2 = new Float64Array(8);
  private n = 0; private blocks = 0; private energy = 0;
  private last = ''; private run = 0; private held = '';
  constructor(readonly fs: number) {
    this.N = Math.round(fs * 0.02);
    this.coef = [...ROWS, ...COLS].map(f => 2 * Math.cos(2 * Math.PI * Math.round(f * this.N / fs) / this.N));
  }
  reset(): void { this.s1.fill(0); this.s2.fill(0); this.n = 0; this.blocks = 0; this.energy = 0; this.last = ''; this.run = 0; this.held = ''; this.digits.length = 0; }
  /** Audio, or an FM discriminator (the tones are in it as they are in the audio). */
  push(x: ArrayLike<number>, count: number): void {
    for (let i = 0; i < count; i++) {
      const v = x[i]; this.energy += v * v;
      for (let k = 0; k < 8; k++) { const s = v + this.coef[k] * this.s1[k] - this.s2[k]; this.s2[k] = this.s1[k]; this.s1[k] = s; }
      if (++this.n >= this.N) this.block();
    }
  }
  private block(): void {
    const p = new Float64Array(8);
    for (let k = 0; k < 8; k++) { p[k] = this.s1[k] * this.s1[k] + this.s2[k] * this.s2[k] - this.coef[k] * this.s1[k] * this.s2[k]; this.s1[k] = 0; this.s2[k] = 0; }
    const total = this.energy * this.N / 2; this.energy = 0; this.n = 0; this.blocks++;
    let r = 0, c = 4; for (let k = 1; k < 4; k++) if (p[k] > p[r]) r = k; for (let k = 5; k < 8; k++) if (p[k] > p[c]) c = k;
    let key = '';
    const pr = p[r], pc = p[c];
    // both tones present, together most of the signal, each well above the other tones of its group, twist under 8 dB
    if (pr > 0 && pc > 0 && (pr + pc) > 0.6 * total && pr < 6.3 * pc && pc < 6.3 * pr) {
      let clear = true;
      for (let k = 0; k < 4; k++) if (k !== r && p[k] * 10 > pr) clear = false;
      for (let k = 4; k < 8; k++) if (k !== c && p[k] * 10 > pc) clear = false;
      if (clear) key = KEYS[r][c - 4];
    }
    if (key && key === this.last) this.run++; else { this.run = key ? 1 : 0; }
    this.last = key;
    if (!key) { this.held = ''; return; }
    if (this.run === 2 && this.held !== key) {
      this.held = key;
      const e = { digit: key, atS: (this.blocks - 2) * this.N / this.fs };
      this.digits.push(e); this.onDigit(e);
    }
  }
  /** The digits heard so far as a string. */
  get text(): string { return this.digits.map(d => d.digit).join(''); }
}
