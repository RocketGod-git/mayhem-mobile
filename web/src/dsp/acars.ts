/**
 * ACARS receiver. The VHF channel is AM carrying 2400 bps MSK audio (1200 / 2400 Hz tones about 1800 Hz); the
 * framing and fields follow acarsdec.
 *
 * The tuned channel is cut out of the wide IQ (oscillator, two FIR stages to ~24 kHz) and its envelope taken, so
 * other airband signals in the span stay out of it and the channel need not sit on the radio's DC spike. The audio
 * is mixed against 1800 Hz and filtered over one bit; at each bit the phase has turned a quarter turn one way or
 * the other, which says which tone was sent.
 *
 * How a tone maps to a data bit is read three ways at once: the tone as the bit, and the two differential readings
 * (a coherent MSK receiver like acarsdec's sees the bit repeat on one tone and flip on the other, depending on its
 * sign convention). Each reading hunts for SYN SYN SOH in both polarities; whichever finds it collects the frame,
 * so a wrong reading costs nothing but a sync search.
 *
 * Like acarsdec, every known ACARS channel inside the span is decoded at once (the tuned one first, then the US
 * set, then the rest, up to [MAX_CHANNELS]), each by its own receiver, and every message says which channel it
 * came in on.
 */
import { type Emit, type IqProcessor } from './core.js';

const STX = 0x02, ETX = 0x03, ETB = 0x17, DEL = 0x7f;
/** SYN SYN SOH as received, oldest bit first, each byte LSB first. */
const SYNC_WORD = [0x16, 0x16, 0x01].flatMap(b => [0, 1, 2, 3, 4, 5, 6, 7].map(i => (b >> i) & 1)).reduce((w, b) => (w << 1) | b, 0);
const LANE_NAMES = ['tone', 'diff-a', 'diff-b'];

function lowpass(taps: number, cut: number): Float32Array {
  const m = taps - 1, h = new Float32Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const x = k - m / 2, sinc = x === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * x) / (Math.PI * x);
    h[k] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * k / m)); sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  return h;
}

/** One way of turning tones into bits, with its own sync search and frame. */
class Lane {
  prev = 0; window = 0; collecting = false; polarity = 0;
  byte = 0; nBits = 0; count = 0; parityErrors = 0; inCrc = false; crcBytes = 0; crcHi = 0; crcLo = 0;
  readonly raw = new Uint8Array(320);
  constructor(readonly kind: number) {}
}

/** ACARS channels (VHF data link mode A): the tuned one goes first, then these in order of preference. */
export const ACARS_CHANNELS = [131_550_000, 130_025_000, 130_425_000, 130_450_000, 131_125_000,   // US
  131_525_000, 131_725_000, 131_825_000, 136_900_000, 136_750_000,                              // Europe
  131_450_000, 131_950_000, 129_125_000, 131_475_000];                                          // Japan, others
const MAX_CHANNELS = 6;

/** Every ACARS channel in the span at once. */
export class AcarsDecoder implements IqProcessor {
  /** The span centre and the tuned channel (set by the worker before each buffer). */
  centerHz = 0; tunedHz = 0;
  private key = '';
  private rx: AcarsChannel[] = [];
  constructor(private readonly emit: Emit) {}
  reset(_rate: number): void { this.key = ''; this.rx = []; }
  /** The channels decoded now (for the page and the tests). */
  channels(): number[] { return this.rx.map(r => r.hz); }
  onIq(iq: Int8Array, rate: number): void {
    const key = `${this.centerHz}|${this.tunedHz}|${rate}`;
    if (key !== this.key) {
      this.key = key;
      const reach = rate / 2 - 50_000, inSpan = (hz: number) => Math.abs(hz - this.centerHz) < reach;
      const want = [...new Set([this.tunedHz, ...ACARS_CHANNELS])].filter(hz => hz > 0 && inSpan(hz)).slice(0, MAX_CHANNELS);
      const keep = this.rx.filter(r => want.includes(r.hz));
      this.rx = want.map(hz => keep.find(r => r.hz === hz) ?? new AcarsChannel(hz, this.emit));
      for (const r of this.rx) r.offsetHz = r.hz - this.centerHz;
      this.emit({ type: 'log', line: `ACARS: decoding ${this.rx.map(r => (r.hz / 1e6).toFixed(3)).join(', ')} MHz` });
    }
    for (const r of this.rx) r.onIq(iq, rate);
  }
}

/** One ACARS channel's receiver. */
class AcarsChannel implements IqProcessor {
  /** The channel's offset from the span centre. */
  offsetHz = 0;
  private rate = 0; private lastOffset = NaN;
  // channel cut: oscillator, FIR to ~240 kHz, FIR to ~24 kHz
  private cr = 1; private ci = 0; private dr = 1; private di = 0;
  private d1 = 1; private d2 = 1; private t1 = new Float32Array(1); private t2 = new Float32Array(1);
  private h1i = new Float32Array(2); private h1q = new Float32Array(2); private p1 = 0; private c1 = 0;
  private h2i = new Float32Array(2); private h2q = new Float32Array(2); private p2 = 0; private c2 = 0;
  // audio
  private fs = 24_000; private envDc = 0;
  private ph = 0; private phInc = 0;
  private mfI = new Float32Array(10); private mfQ = new Float32Array(10); private mfPos = 0; private sI = 0; private sQ = 0;
  private pI = 0; private pQ = 0; private bI = 0; private bQ = 0;
  // bit clock: sign changes of the instantaneous frequency mark bit edges
  private clk = 0; private clkInc = 0; private lastF = 0;
  private lanes = [new Lane(0), new Lane(1), new Lane(2)];

  constructor(readonly hz: number, private readonly emit: Emit) {}

  reset(rate: number): void {
    this.rate = rate; this.lastOffset = NaN;
    this.d1 = Math.max(1, Math.round(rate / 240_000));
    const inter = rate / this.d1;
    this.d2 = Math.max(1, Math.round(inter / 24_000));
    this.fs = inter / this.d2;
    this.t1 = lowpass(5 * this.d1 + 1, 50_000 / rate);
    this.t2 = lowpass(127, 6_000 / inter);
    this.h1i = new Float32Array(this.t1.length * 2); this.h1q = new Float32Array(this.t1.length * 2); this.p1 = 0; this.c1 = 0;
    this.h2i = new Float32Array(this.t2.length * 2); this.h2q = new Float32Array(this.t2.length * 2); this.p2 = 0; this.c2 = 0;
    this.phInc = 2 * Math.PI * 1800 / this.fs;
    const mf = Math.max(2, Math.round(this.fs / 2400));
    this.mfI = new Float32Array(mf); this.mfQ = new Float32Array(mf); this.mfPos = 0; this.sI = this.sQ = 0;
    this.clkInc = 2400 / this.fs; this.clk = 0;
    this.lanes = [new Lane(0), new Lane(1), new Lane(2)];
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    if (this.offsetHz !== this.lastOffset) {
      this.lastOffset = this.offsetHz;
      const w = -2 * Math.PI * this.offsetHz / rate; this.dr = Math.cos(w); this.di = Math.sin(w);
    }
    const n = iq.length >> 1, t1 = this.t1, t2 = this.t2, L1 = t1.length, L2 = t2.length;
    let r = this.cr, s = this.ci;
    for (let k = 0; k < n; k++) {
      const xi = iq[2 * k], xq = iq[2 * k + 1];
      const yi = xi * r - xq * s, yq = xi * s + xq * r;
      const nr = r * this.dr - s * this.di; s = r * this.di + s * this.dr; r = nr;
      this.h1i[this.p1] = this.h1i[this.p1 + L1] = yi; this.h1q[this.p1] = this.h1q[this.p1 + L1] = yq;
      if (++this.p1 >= L1) this.p1 = 0;
      if (++this.c1 < this.d1) continue;
      this.c1 = 0;
      let ai = 0, aq = 0;
      for (let t = 0; t < L1; t++) { ai += this.h1i[this.p1 + t] * t1[t]; aq += this.h1q[this.p1 + t] * t1[t]; }
      this.h2i[this.p2] = this.h2i[this.p2 + L2] = ai; this.h2q[this.p2] = this.h2q[this.p2 + L2] = aq;
      if (++this.p2 >= L2) this.p2 = 0;
      if (++this.c2 < this.d2) continue;
      this.c2 = 0;
      let bi = 0, bq = 0;
      for (let t = 0; t < L2; t++) { bi += this.h2i[this.p2 + t] * t2[t]; bq += this.h2q[this.p2 + t] * t2[t]; }
      const env = Math.sqrt(bi * bi + bq * bq);
      this.envDc += 0.001 * (env - this.envDc);
      this.audio(env - this.envDc);
    }
    // keep the oscillator on the unit circle
    const m = Math.sqrt(r * r + s * s); this.cr = r / m; this.ci = s / m;
  }

  private audio(a: number): void {
    this.ph += this.phInc; if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
    const mi = a * Math.cos(this.ph), mq = -a * Math.sin(this.ph);
    this.sI += mi - this.mfI[this.mfPos]; this.sQ += mq - this.mfQ[this.mfPos];
    this.mfI[this.mfPos] = mi; this.mfQ[this.mfPos] = mq; if (++this.mfPos >= this.mfI.length) this.mfPos = 0;
    // Instantaneous frequency about 1800 Hz: its sign changes where the tone does. The one-bit filter puts that
    // change half a bit after the edge, and the bit is read when the filter holds exactly one bit, half a bit after
    // that: so a sign change should land at half a clock.
    const f = this.sQ * this.pI - this.sI * this.pQ;
    this.pI = this.sI; this.pQ = this.sQ;
    if ((f > 0) !== (this.lastF > 0)) this.clk -= 0.25 * (this.clk - 0.5);
    this.lastF = f;
    this.clk += this.clkInc;
    if (this.clk < 1) return;
    this.clk -= 1;
    // a quarter turn up over the bit is the 2400 Hz tone, down the 1200 Hz one
    const turn = this.sQ * this.bI - this.sI * this.bQ;
    this.bI = this.sI; this.bQ = this.sQ;
    const tone = turn > 0 ? 1 : 0;
    for (const lane of this.lanes) {
      const bit = lane.kind === 0 ? tone : lane.kind === 1 ? lane.prev ^ tone : lane.prev ^ tone ^ 1;
      lane.prev = bit;
      this.onBit(lane, bit);
    }
  }

  private onBit(l: Lane, raw: number): void {
    if (!l.collecting) {
      l.window = ((l.window << 1) | raw) & 0xFFFFFF;
      if (l.window === SYNC_WORD) this.start(l, 0);
      else if ((~l.window & 0xFFFFFF) === SYNC_WORD) this.start(l, 1);
      return;
    }
    l.byte |= (raw ^ l.polarity) << l.nBits;
    if (++l.nBits < 8) return;
    const b = l.byte; l.byte = 0; l.nBits = 0;
    if (l.inCrc) {
      if (l.crcBytes === 0) { l.crcHi = b; l.crcBytes = 1; return; }
      l.crcLo = b; this.finish(l); return;
    }
    let ones = 0; for (let i = 0; i < 8; i++) ones += (b >> i) & 1;
    if (ones % 2 === 0 && ++l.parityErrors > 4) { l.collecting = false; l.window = 0; return; }
    l.raw[l.count++] = b;
    const ch = b & 0x7f;
    if (ch === ETX || ch === ETB) { l.inCrc = true; l.crcBytes = 0; return; }
    if (l.count >= l.raw.length) { l.collecting = false; l.window = 0; }
  }

  private start(l: Lane, polarity: number): void {
    l.collecting = true; l.polarity = polarity; l.nBits = 0; l.byte = 0; l.count = 0; l.parityErrors = 0; l.inCrc = false; l.crcBytes = 0;
  }

  /** CRC-16 over mode … ETX: the reflected (0x8408) and plain (0x1021) forms, over the bytes with and without parity. */
  private crcOk(l: Lane): boolean {
    const rx = [(l.crcHi << 8) | l.crcLo, (l.crcLo << 8) | l.crcHi];
    for (const strip of [false, true]) {
      let a = 0, b = 0;
      for (let i = 0; i < l.count; i++) {
        const v0 = strip ? l.raw[i] & 0x7f : l.raw[i];
        a ^= v0 << 8; for (let k = 0; k < 8; k++) a = (a & 0x8000) ? ((a << 1) ^ 0x1021) & 0xffff : (a << 1) & 0xffff;
        let v = v0; for (let k = 0; k < 8; k++) { const lsb = (b ^ v) & 1; b >>>= 1; if (lsb) b ^= 0x8408; v >>>= 1; }
      }
      if (rx.includes(a) || rx.includes(b)) return true;
    }
    return false;
  }

  private finish(l: Lane): void {
    l.collecting = false; l.window = 0;
    const n = l.count;
    if (n < 13) return;
    const ok = this.crcOk(l);
    // a reading that found a sync but whose frame is broken in parity as well as CRC is noise, not a message
    if (!ok && l.parityErrors > 1) return;
    const B = Array.from(l.raw.subarray(0, n), x => x & 0x7f);
    const ch = (i: number) => String.fromCharCode(B[i]);
    const mode = ch(0);
    let reg = ''; for (let i = 1; i <= 7; i++) reg += ch(i); reg = reg.replace(/^[. ]+|[. ]+$/g, '');
    const ack = B[8] === 0x15 ? 'NAK' : ch(8);
    const label = ch(9) + (B[10] === DEL ? 'd' : ch(10));
    const blk = ch(11);
    const down = blk >= '0' && blk <= '9';
    let p = 12, msn = '', flight = '';
    if (B[p] === STX) {
      p++;
      if (down && n - p >= 11) { for (let i = 0; i < 4; i++) msn += ch(p + i); for (let i = 4; i < 10; i++) flight += ch(p + i); flight = flight.trim(); p += 10; }
    }
    let text = '';
    while (p < n) { const c = B[p++]; if (c === ETX || c === ETB) break; text += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : (c === 0x0a || c === 0x0d) ? ' ' : '·'; }
    const head = `ACARS ${(this.hz / 1e6).toFixed(3)} ${down ? '↓' : '↑'} ${reg}  ${label}  blk ${blk}  ack ${ack}${msn ? `  #${msn} ${flight}` : ''}${ok ? '' : '  CRC?'}${mode !== '2' ? `  mode ${mode}` : ''}`;
    const body = text.trim();
    this.emit({ type: 'packet', line: body ? `${head}\n${body}` : head });
    this.emit({ type: 'log', line: `ACARS ${(this.hz / 1e6).toFixed(3)}: frame read as ${LANE_NAMES[l.kind]}${l.polarity ? ' (inverted)' : ''}, CRC ${ok ? 'good' : 'bad'}, ${l.parityErrors} parity errors` });
    // the other readings are not hunting this frame any more
    for (const o of this.lanes) if (o !== l && o.collecting) { o.collecting = false; o.window = 0; }
  }
}
