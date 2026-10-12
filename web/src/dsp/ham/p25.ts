/**
 * P25 Phase 1 (TIA-102) framing, on top of the same 4FSK symbol recovery the DMR decoder uses: C4FM at
 * 4800 baud, four levels at +-1800 and +-600 Hz, but one continuous stream rather than TDMA slots.
 *
 * A transmission is a run of frames, each starting with the 48-bit frame sync and a 64-bit Network ID carrying
 * the NAC (which system) and the DUID (which kind of frame). A status symbol is punched into the stream after
 * every 35 symbols and has to be pulled back out before anything parses.
 *
 *   HDU    header, starts a call            LDU1   9 voice frames + link control (who is talking)
 *   TDU    terminator                       LDU2   9 voice frames + encryption sync
 *   TDULC  terminator + link control        TSBK   trunking control message
 *
 * Link control is protected three deep: each 6-bit hex word carries a Hamming (10,6) code word, the 24 hex words
 * are a shortened Reed-Solomon (24,12) code over GF(64), and only then do you have the 72 bits that say the
 * talkgroup and the radio ID.
 */

/** One decoded frame's worth of what the UI wants to show. */
export interface P25Status {
  locked: boolean;
  nac: number;                       // network access code, -1 when nothing has decoded
  duid: number;
  frame: string;                     // human name of the last frame type
  talkgroup: number; source: number; // from link control, 0 when unknown
  encrypted: boolean;
  lcf: number;                       // link control format
  frames: number; errs: number;      // frames seen, and how many failed their checks
  since: number;                     // samples since the last frame
}

const DUID_NAME: Record<number, string> = {
  0x0: 'HEADER', 0x3: 'TERMINATOR', 0x5: 'VOICE 1', 0x7: 'TRUNKING',
  0xa: 'VOICE 2', 0xc: 'DATA', 0xf: 'TERMINATOR + LC',
};
/** Information symbols in each frame type, counted after the status symbols are removed (sync and NID included). */
const DUID_SYMBOLS: Record<number, number> = { 0x0: 385, 0x3: 70, 0x5: 840, 0x7: 175, 0xa: 840, 0xc: 0, 0xf: 210 };

// --------------------------------------------------------------------------------------- GF(64) for the RS code
const GF_EXP = new Uint8Array(128), GF_LOG = new Uint8Array(64);
{
  let x = 1;
  for (let i = 0; i < 63; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x40) x ^= 0x43; }   // x^6 + x + 1
  for (let i = 63; i < 126; i++) GF_EXP[i] = GF_EXP[i - 63];
}
const gmul = (a: number, b: number) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
const gdiv = (a: number, b: number) => a === 0 ? 0 : GF_EXP[GF_LOG[a] + 63 - GF_LOG[b]];

/**
 * Shortened Reed-Solomon (24,12) over GF(64), the code protecting link control. Syndromes, Berlekamp-Massey,
 * Chien search, Forney. Returns the number of symbols corrected, or -1 when the errors are past correcting.
 */
function rsDecode(data: Uint8Array, nroots: number): number {
  const n = data.length;
  const synd = new Uint8Array(nroots);
  let bad = false;
  for (let i = 0; i < nroots; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s = gmul(s, GF_EXP[i + 1]) ^ data[j];
    synd[i] = s;
    if (s) bad = true;
  }
  if (!bad) return 0;
  let lam = new Uint8Array(nroots + 1); lam[0] = 1;
  let b = new Uint8Array(nroots + 1); b[0] = 1;
  let L = 0;
  for (let r = 1; r <= nroots; r++) {
    let d = 0;
    for (let i = 0; i <= L; i++) d ^= gmul(lam[i], synd[r - 1 - i] ?? 0);
    const bShift = new Uint8Array(nroots + 1);
    for (let i = 0; i < nroots; i++) bShift[i + 1] = b[i];
    if (d === 0) { b = bShift; continue; }
    const t = new Uint8Array(nroots + 1);
    for (let i = 0; i <= nroots; i++) t[i] = lam[i] ^ gmul(d, bShift[i]);
    if (2 * L <= r - 1) { const inv = gdiv(1, d); const nb = new Uint8Array(nroots + 1); for (let i = 0; i <= nroots; i++) nb[i] = gmul(lam[i], inv); b = nb; L = r - L; }
    else b = bShift;
    lam = t;
  }
  if (L > nroots >> 1) return -1;
  const roots: number[] = [], pos: number[] = [];
  for (let i = 0; i < 63; i++) {
    let s = 0;
    for (let j = 0; j <= L; j++) s ^= gmul(lam[j], GF_EXP[(j * i) % 63]);
    if (s === 0) { const p = (63 - i) % 63; if (p < n) { roots.push(GF_EXP[i]); pos.push(n - 1 - p); } }
  }
  if (roots.length !== L) return -1;
  const omega = new Uint8Array(nroots);
  for (let i = 0; i < nroots; i++) { let s = 0; for (let j = 0; j <= Math.min(i, L); j++) s ^= gmul(lam[j], synd[i - j]); omega[i] = s; }
  for (let k = 0; k < pos.length; k++) {
    const xInv = roots[k];
    let num = 0;
    for (let i = 0; i < nroots; i++) num ^= gmul(omega[i], GF_EXP[(GF_LOG[xInv] * i) % 63]);
    let den = 0;
    for (let i = 1; i <= L; i += 2) den ^= gmul(lam[i], GF_EXP[(GF_LOG[xInv] * (i - 1)) % 63]);
    if (den === 0) return -1;
    data[pos[k]] ^= gdiv(num, den);
  }
  return pos.length;
}

// ------------------------------------------------------------------- BCH (63,16,23) over the Network ID
/**
 * Generator polynomial of the code protecting the Network ID: the product of the minimal polynomials of
 * alpha^1 .. alpha^22 over the same GF(64), which comes out binary and of degree 47.
 */
const BCH_GEN = (() => {
  const mul = (a: number, b: number) => gmul(a, b);
  let g = [1];
  const seen = new Set<number>();
  for (let r = 1; r <= 22; r++) {
    const conj: number[] = [];
    for (let c = r; !conj.includes(c); c = (c * 2) % 63) conj.push(c);
    if (conj.some(c => seen.has(c))) continue;
    for (const c of conj) seen.add(c);
    let mp = [1];
    for (const c of conj) {                              // multiply by (x + alpha^c)
      const np = new Array(mp.length + 1).fill(0);
      for (let j = 0; j < mp.length; j++) { np[j] ^= mul(mp[j], GF_EXP[c]); np[j + 1] ^= mp[j]; }
      mp = np;
    }
    const ng = new Array(g.length + mp.length - 1).fill(0);
    for (let i = 0; i < g.length; i++) if (g[i]) for (let j = 0; j < mp.length; j++) ng[i + j] ^= mul(g[i], mp[j]);
    g = ng;
  }
  let v = 0n;
  for (let i = 0; i < g.length; i++) if (g[i]) v |= 1n << BigInt(i);
  return v;
})();

/** The 64 bits a given network code and frame type must produce: 16 data, 47 parity, one overall parity. */
function nidWord(nac: number, duid: number): { hi: number; lo: number } {
  const data = BigInt(((nac << 4) | duid) >>> 0);
  let reg = data << 47n;
  for (let b = 62; b >= 47; b--) if ((reg >> BigInt(b)) & 1n) reg ^= BCH_GEN << BigInt(b - 47);
  const cw = (data << 47n) | (reg & ((1n << 47n) - 1n));
  let par = 0n;
  for (let t = cw; t; t >>= 1n) par ^= t & 1n;
  const w = (cw << 1n) | par;
  return { hi: Number(w >> 32n), lo: Number(w & 0xffffffffn) };
}
const bitCount = (x: number) => { let c = 0; x >>>= 0; while (x) { x &= x - 1; c++; } return c; };

/** Hamming (10,6): six data bits and four parity, correcting one bit. Returns the data, or -1 if it cannot. */
const H106 = [0x0e, 0x0d, 0x0b, 0x07, 0x03, 0x0c];      // parity contribution of each data bit
function hamming106(word: number): number {
  const data = (word >> 4) & 0x3f, par = word & 0xf;
  let syn = par;
  for (let i = 0; i < 6; i++) if (data & (1 << (5 - i))) syn ^= H106[i];
  if (syn === 0) return data;
  for (let i = 0; i < 6; i++) if (syn === H106[i]) return data ^ (1 << (5 - i));
  for (let i = 0; i < 4; i++) if (syn === (1 << i)) return data;    // the error was in a parity bit
  return -1;
}

export class P25Decoder {
  onLog: (line: string) => void = () => undefined;
  /** Raw 144-bit voice frames as they come out of an LDU, for the vocoder. */
  onVoice: (bits: Uint8Array) => void = () => undefined;

  private nac = -1; private duid = -1;
  private frameName = ''; private tg = 0; private src = 0; private enc = false; private lcf = 0;
  private frames = 0; private errs = 0; private lastAt = -1e9;
  private locked = false;

  private nacVotes = new Map<number, number>();
  private nidCache = new Map<number, { hi: number; lo: number; duid: number }[]>();
  private sym = 0;                                   // symbol index inside the frame, sync included
  private readonly info = new Uint8Array(900);       // information dibits of the frame, status symbols removed
  private nInfo = 0;
  private want = 0;                                  // information symbols still to collect
  /** 'skip' is stepping over the next frame's sync without waiting for the receiver to detect it. */
  private state: 'idle' | 'skip' | 'nid' | 'body' = 'idle';

  reset(): void {
    this.nac = -1; this.duid = -1; this.frameName = ''; this.tg = 0; this.src = 0; this.enc = false;
    this.lcf = 0; this.frames = 0; this.errs = 0; this.nacVotes.clear();
    this.idle();
  }

  /** Sample at which the last good frame was read, so the receiver can tell a live stream from a stale lock. */
  get lastFrame(): number { return this.lastAt; }

  /** The signal went away: stop collecting, but keep what was decoded so the UI can still show the last call. */
  idle(): void { this.locked = false; this.want = 0; this.nInfo = 0; this.sym = 0; this.state = 'idle'; }

  /**
   * P25 frames run back to back, so the moment one ends the next one's sync is already arriving. Keeping the
   * symbol clock and stepping over those 24 symbols decodes the next frame even when its sync correlation was
   * too weak to fire, which on a marginal signal used to throw away every other frame - 180 ms of speech each
   * time, heard as chopping. Nothing is taken on trust: the Network ID's own error correction, immediately
   * after, is what says whether a frame was really there.
   */
  private expectNext(): void { this.sym = 0; this.nInfo = 0; this.want = 24; this.state = 'skip'; }

  status(now: number): P25Status {
    return {
      locked: this.locked, nac: this.nac, duid: this.duid, frame: this.frameName,
      talkgroup: this.tg, source: this.src, encrypted: this.enc, lcf: this.lcf,
      frames: this.frames, errs: this.errs, since: now - this.lastAt,
    };
  }

  /** A frame sync was recognized: the next symbol is index 24 of a new frame. */
  sync(now: number): void {
    this.sym = 24; this.nInfo = 0; this.want = 32;     // collect the NID first, then decide from its DUID
    this.state = 'nid'; this.lastAt = now; this.locked = true;
  }

  /** One recovered dibit. Status symbols are dropped here; everything else accumulates into the frame. */
  push(dibit: number, now: number): void {
    if (this.state === 'idle') return;
    const isStatus = this.sym % 36 === 35;
    this.sym++;
    if (isStatus) return;
    if (this.state === 'skip') {
      if (--this.want > 0) return;
      this.state = 'nid'; this.nInfo = 0; this.want = 32;
      return;
    }
    this.info[this.nInfo++] = dibit;
    if (--this.want > 0) return;
    if (this.state === 'nid') this.onNid(now); else this.onBody(now);
  }

  /** The seven legal Network IDs for one system, built once per network code seen. */
  private candidates(nac: number): { hi: number; lo: number; duid: number }[] {
    let c = this.nidCache.get(nac);
    if (!c) {
      c = Object.keys(DUID_NAME).map(k => ({ ...nidWord(nac, Number(k)), duid: Number(k) }));
      if (this.nidCache.size > 8) this.nidCache.clear();
      this.nidCache.set(nac, c);
    }
    return c;
  }

  /** `from` is a bit offset into the collected information dibits, high bit of each dibit first. */
  private bits(from: number, count: number): number {
    let v = 0;
    for (let i = 0; i < count; i++) { const b = from + i, d = this.info[b >> 1]; v = v * 2 + ((b & 1) ? (d & 1) : (d >> 1)); }
    return v;
  }

  /**
   * The Network ID: 16 data bits (NAC then DUID) inside a BCH (64,16) code word. The data is systematic, so it
   * reads straight out; an unknown DUID means the bits were wrong and the frame is abandoned rather than parsed.
   */
  private onNid(now: number): void {
    const hi = this.bits(0, 32), lo = this.bits(32, 32);
    // Reading the sixteen data bits straight out throws a whole frame away for one bad bit, which is 180 ms of
    // speech. They are wrapped in a code that carries eleven errors, and only seven frame types exist, so the
    // received word is matched against every legal one for this system instead.
    let bd = 99, bnac = -1, bduid = -1;
    for (const nac of new Set([this.bits(0, 12), ...(this.nac >= 0 ? [this.nac] : [])])) {
      for (const w of this.candidates(nac)) {
        const d = bitCount(hi ^ w.hi) + bitCount(lo ^ w.lo);
        if (d < bd) { bd = d; bnac = nac; bduid = w.duid; }
      }
    }
    // Too damaged to say what frame this is, so its length is unknown and the clock cannot be carried across it.
    if (bd > 11) { this.errs++; this.idle(); return; }
    const nac = bnac, duid = bduid;
    const v = this.nacVotes;
    v.set(nac, (v.get(nac) ?? 0) + 1);
    if (v.size > 8) v.clear();
    this.nac = nac; this.duid = duid; this.frames++; this.lastAt = now;
    this.frameName = DUID_NAME[duid];
    const body = DUID_SYMBOLS[duid] - 56;              // 24 sync + 32 NID already accounted for
    if (body <= 0) { this.report(); this.expectNext(); return; }
    this.want = body; this.state = 'body';
  }

  private onBody(now: number): void {
    this.lastAt = now;
    this.expectNext();
    if (this.duid === 0x5 || this.duid === 0xa) this.onLdu();
    else if (this.duid === 0xf) this.onTdulc();
    this.report();
  }

  /**
   * A voice frame: nine 144-bit vocoder frames with link control (LDU1) or encryption sync (LDU2) threaded
   * between them, and low speed data before the last one.
   */
  private onLdu(): void {
    const v = new Uint8Array(144);
    // The frame sync is consumed by the receiver and never reaches this buffer, so the body starts straight
    // after the 32 symbols of the Network ID.
    let at = 32;
    const lc: number[] = [];
    const takeVoice = () => { for (let i = 0; i < 72; i++) { const d = this.info[at + i]; v[i * 2] = d >> 1; v[i * 2 + 1] = d & 1; } at += 72; this.onVoice(v); };
    const takeLc = () => { for (let i = 0; i < 20; i++) lc.push(this.info[at + i]); at += 20; };
    takeVoice(); takeVoice();
    for (let k = 0; k < 6; k++) { takeLc(); takeVoice(); }
    at += 16;                                           // low speed data
    takeVoice();
    if (this.duid === 0x5) this.decodeLc(lc);
    // LDU2's 240 bits are the encryption sync; whether the call is actually keyed comes from link control
  }

  /**
   * The terminator-with-link-control frame carries the same 72-bit word, but each symbol is protected by a
   * Golay (24,12) code rather than the Hamming used inside a voice frame, so it is named and not parsed: the
   * call it describes has already been read from the voice frames that preceded it.
   */
  private onTdulc(): void { /* named only */ }

  /**
   * 240 bits of link control: 24 Hamming (10,6) code words carrying 24 hex symbols, which are a Reed-Solomon
   * (24,12) code word over GF(64); the 12 that survive are the 72 bits naming the call.
   */
  private decodeLc(lcDibits: number[]): void {
    if (lcDibits.length < 120) return;
    const hex = new Uint8Array(24);
    let bad = 0;
    for (let w = 0; w < 24; w++) {
      let word = 0;
      for (let i = 0; i < 5; i++) { const d = lcDibits[w * 5 + i]; word = word * 4 + d; }
      const h = hamming106(word);
      if (h < 0) { bad++; hex[w] = 0; } else hex[w] = h;
    }
    if (rsDecode(hex, 12) < 0 || bad > 6) { this.errs++; return; }
    // The surviving 12 symbols are one 72-bit word, six bits per symbol, most significant first.
    const bit = (i: number) => (hex[(i / 6) | 0] >> (5 - i % 6)) & 1;
    const f = (from: number, count: number) => { let v = 0; for (let i = 0; i < count; i++) v = v * 2 + bit(from + i); return v; };
    // Octet 0 is a protect flag, a standard-manufacturer flag and then the six-bit opcode.
    const lcf = f(2, 6), svc = f(16, 8);
    this.lcf = lcf;
    this.enc = bit(0) === 1 || (svc & 0x40) !== 0;
    if (lcf === 0x00) {                                 // group call: talkgroup then the source radio
      this.tg = f(32, 16); this.src = f(48, 24);
    } else if (lcf === 0x03) {                          // call between two radios: destination then source
      this.tg = f(24, 24); this.src = f(48, 24);
    }
  }

  private report(): void {
    const who = this.tg || this.src ? ` · TG ${this.tg} <- ${this.src}` : '';
    this.onLog(`P25 NAC ${this.nac.toString(16).toUpperCase()} ${this.frameName}${who}${this.enc ? ' · ENCRYPTED' : ''}`);
  }
}
