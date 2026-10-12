/**
 * RDS decoder, fed from an independent transmit-side model.
 *
 * All of the evidence here is synthetic: there is no off-air capture in this file. The modulator below is written
 * from the standard's definition rather than from the decoder — checkwords come from the generator matrix (the
 * remainder of each x^k), the decoder's from a shift register — and it builds groups, differentially encodes them,
 * biphase-codes the bits and puts them on a 57 kHz carrier inside a composite that also carries the 19 kHz pilot,
 * mono audio, a stereo-difference sideband a few kilohertz below the RDS band, a DC offset and Gaussian noise.
 * The pulse shaping is a short raised-cosine smoothing of the rectangular biphase waveform; it is there so the
 * decoder is not tested only against the square pulses that its integrate-and-dump is trivially matched to, and
 * does not claim to reproduce the standard's spectrum-shaping filter.
 *
 * Every rule is checked from its premise: the checkword generator has to show the offset behaviour before any
 * block built with it counts, the residue of an untoggled text A/B flag has to be shown before the toggle is
 * credited with clearing it, and the sync-loss test first shows the decoder was synced.
 */
import { RdsDecoder, PTY_NAMES, rdsSyndrome, rdsCheckword,
         OFFSET_A, OFFSET_B, OFFSET_C, OFFSET_CP, OFFSET_D } from '../dist/dsp/rds.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const eqArr = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

console.log('RDS: checkwords, block sync and group decoding from a transmit-side model');

// ---- Reference checkword from the generator matrix, not a shift register ----
const G = 0x5b9;
const OFF = { A: 0x0fc, B: 0x198, C: 0x168, Cp: 0x350, D: 0x1b4 };
/** x^k mod g(x), by doubling k times. Row k of the parity matrix. */
const xPowMod = (k) => { let r = 1; for (let i = 0; i < k; i++) { r <<= 1; if (r & 0x400) r ^= G; } return r; };
const remRef = (v, width) => { let r = 0; for (let i = 0; i < width; i++) if ((v >>> i) & 1) r ^= xPowMod(i); return r; };
const crcRef = (data16) => remRef((data16 & 0xffff) << 10, 26);
const blockRef = (data16, offset) => ((data16 & 0xffff) << 10) | (crcRef(data16) ^ offset);

// ---- Deterministic noise ----
const rng = (seed) => {
  let s = seed >>> 0;
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => { const a = u() || 1e-12, b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };
  return { u, gauss };
};

// ---- Group builders ----
const code = (s, i) => (i < s.length ? s.charCodeAt(i) : 0x20) & 0xff;
const pair = (s, i) => (code(s, i) << 8) | code(s, i + 1);
const blockB = ({ type, versionB = false, tp = false, pty = 0, low = 0 }) =>
  (type << 12) | ((versionB ? 1 : 0) << 11) | ((tp ? 1 : 0) << 10) | ((pty & 0x1f) << 5) | (low & 0x1f);
/** Four 26-bit blocks. A type-B group carries the PI again in block C under offset C'. */
const group = (pi, b, c, d, versionB = false) =>
  [blockRef(pi, OFF.A), blockRef(b, OFF.B), versionB ? blockRef(pi, OFF.Cp) : blockRef(c, OFF.C), blockRef(d, OFF.D)];

const afCode = (mhz) => Math.round((mhz - 87.5) * 10);
/** AF pairs as a station sends them: a count header first, then the frequencies two at a time, filler at the end. */
const afPairs = (af) => {
  const codes = [224 + af.length, ...af.map(afCode)];
  if (codes.length & 1) codes.push(205);
  const out = [];
  for (let i = 0; i < codes.length; i += 2) out.push((codes[i] << 8) | codes[i + 1]);
  return out;
};

const psGroups = ({ pi, ps, pty = 0, tp = false, ta = false, ms = false, af = [], versionB = false, afRaw = null }) => {
  const pairs = afRaw ?? (af.length ? afPairs(af) : [(205 << 8) | 205]);
  const out = [];
  for (let seg = 0; seg < 4; seg++) {
    const b = blockB({ type: 0, versionB, tp, pty, low: ((ta ? 1 : 0) << 4) | ((ms ? 1 : 0) << 3) | seg });
    out.push(group(pi, b, pairs[seg % pairs.length], pair(ps, 2 * seg), versionB));
  }
  return out;
};
const rtGroups = ({ pi, rt, pty = 0, tp = false, ab = 0, versionB = false, segments = null }) => {
  const out = [];
  if (versionB) {
    const n = Math.ceil(rt.length / 2);
    for (const seg of segments ?? [...Array(n).keys()]) {
      out.push(group(pi, blockB({ type: 2, versionB, tp, pty, low: (ab << 4) | seg }), 0, pair(rt, 2 * seg), true));
    }
  } else {
    const n = Math.ceil(rt.length / 4);
    for (const seg of segments ?? [...Array(n).keys()]) {
      out.push(group(pi, blockB({ type: 2, tp, pty, low: (ab << 4) | seg }), pair(rt, 4 * seg), pair(rt, 4 * seg + 2)));
    }
  }
  return out;
};
/** A station's cycle: PS and RT groups interleaved the way real transmitters do it. */
const station = (cfg) => {
  const p = cfg.ps === undefined ? [] : psGroups(cfg), r = cfg.rt === undefined ? [] : rtGroups(cfg);
  const out = [];
  for (let i = 0; i < Math.max(p.length, r.length); i++) { if (i < p.length) out.push(p[i]); if (i < r.length) out.push(r[i]); }
  return out;
};
const bitsOf = (groups) => {
  const bits = [];
  for (const g of groups) for (const blk of g) for (let i = 25; i >= 0; i--) bits.push((blk >>> i) & 1);
  return bits;
};

// ---- Modulator ----
const RATE = 250000;
/**
 * Composite at `rate`: the bits cycle for `seconds` (default: once through plus a short tail), differentially
 * encoded across the wrap so the stream never has a discontinuity of its own.
 */
const mpx = (bits, { rate = RATE, seconds = null, amp = 0.03, pilot = 0.09, freqError = 0, phase0 = 0, noise = 0,
                     seed = 1, dc = 0.05, shaped = true, audio = 0.4, stereo = 0.15, rds = true } = {}) => {
  const ratio = 1 + freqError / 57000, baud = 1187.5 * ratio, fsc = 57000 + freqError, fpilot = 19000 * ratio;
  const n = Math.round(rate * (seconds ?? (bits.length / baud + 0.05)));
  const bb = new Float32Array(n);
  let encoded = [], prevT = 0, nextBit = 0;
  const tBit = (idx) => {
    while (encoded.length <= idx) { prevT ^= bits[nextBit++ % bits.length]; encoded.push(prevT); }
    return encoded[idx];
  };
  for (let k = 0; k < n; k++) {
    const h = Math.floor((k / rate) * 2 * baud), parity = h & 1, t = tBit(h >> 1);
    bb[k] = t ? (parity ? -1 : 1) : (parity ? 1 : -1);
  }
  let wave = bb;
  if (shaped) {
    const L = Math.max(3, Math.round(rate / (2 * baud) / 2)) | 1, half = L >> 1;
    const kern = Array.from({ length: L }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (L + 1)));
    const sum = kern.reduce((a, b) => a + b, 0);
    wave = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let acc = 0;
      for (let j = 0; j < L; j++) { const idx = k + j - half; if (idx >= 0 && idx < n) acc += bb[idx] * kern[j]; }
      wave[k] = acc / sum;
    }
  }
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = k / rate;
    let y = dc + audio * Math.sin(2 * Math.PI * 1000 * t)
      + stereo * Math.sin(2 * Math.PI * 12000 * t) * Math.cos(2 * Math.PI * 38000 * ratio * t)
      + pilot * Math.sin(2 * Math.PI * fpilot * t);
    if (rds) y += amp * wave[k] * Math.cos(2 * Math.PI * fsc * t + phase0);
    if (noise) y += noise * r.gauss();
    out[k] = y;
  }
  return out;
};
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Runs a signal through a decoder in chunks, noting which chunk each emit landed in. */
const decode = (signal, { rate = RATE, chunk = 4096, dec = null } = {}) => {
  const emits = [], chunks = [];
  const d = dec ?? new RdsDecoder(s => { emits.push(s); chunks.push(Math.floor(at / chunk)); });
  let at = 0;
  for (; at < signal.length; at += chunk) d.push(signal.subarray(at), Math.min(chunk, signal.length - at), rate);
  return { d, emits, chunks, st: d.state };
};

const STATION = {
  pi: 0xc0fe, ps: 'MAYHEM  ', rt: 'MAYHEM MOBILE RADIO DATA SYSTEM TEST\r', pty: 10, tp: true, ta: false, ms: true,
  af: [104.3, 87.6, 99.9],
};
const RT_SHOWN = 'MAYHEM MOBILE RADIO DATA SYSTEM TEST';

// ---- The checkword itself ----
{
  // The offset behaviour: dividing an undamaged block by the generator leaves exactly its offset word. This is
  // what the decoder's block search relies on, so it is shown here from the reference builder alone.
  for (const [name, off] of Object.entries(OFF)) {
    let all = true;
    for (let i = 0; i < 200; i++) { const data = (i * 40503 + 977) & 0xffff; if (remRef(blockRef(data, off), 26) !== off) all = false; }
    ok(all, `the remainder of a block built with offset ${name} is the offset word itself (premise)`);
  }
  eq(crcRef(0), 0, 'the checkword of all-zero data is zero (premise)');
  {
    let linear = true;
    for (let i = 0; i < 100; i++) { const a = (i * 7919) & 0xffff, b = (i * 104729 + 13) & 0xffff; if (crcRef(a ^ b) !== (crcRef(a) ^ crcRef(b))) linear = false; }
    ok(linear, 'the checkword is linear over the data (premise)');
  }
  // The decoder's shift-register form agrees with the matrix form on every offset and a spread of data.
  {
    let agree = true;
    for (let i = 0; i < 500; i++) {
      const data = (i * 48271 + 31) & 0xffff;
      for (const off of Object.values(OFF)) if (rdsCheckword(data, off) !== (crcRef(data) ^ off)) agree = false;
      if (rdsSyndrome(blockRef(data, OFF.D)) !== OFF.D) agree = false;
    }
    ok(agree, 'the decoder\'s checkword and syndrome agree with the generator-matrix reference');
  }
  eq(OFFSET_A, OFF.A, 'offset A'); eq(OFFSET_B, OFF.B, 'offset B'); eq(OFFSET_C, OFF.C, 'offset C');
  eq(OFFSET_CP, OFF.Cp, 'offset C\''); eq(OFFSET_D, OFF.D, 'offset D');

  // Damage detection: every single-bit flip in a block, and every burst of up to ten bits, breaks the syndrome.
  {
    const blk = blockRef(0x5a3c, OFF.B);
    let single = true;
    for (let i = 0; i < 26; i++) if (rdsSyndrome(blk ^ (1 << i)) === OFF.B) single = false;
    ok(single, 'flipping any one of the 26 bits makes the block fail its check');
    let bursts = true;
    for (let len = 2; len <= 10; len++) for (let at = 0; at + len <= 26; at++) for (let pat = 1; pat < (1 << len); pat += 3) {
      const mask = ((pat | 1 | (1 << (len - 1))) << at) >>> 0;
      if (rdsSyndrome((blk ^ mask) >>> 0) === OFF.B) bursts = false;
    }
    ok(bursts, 'no error burst of ten bits or fewer passes the check');
    let crossOffset = true;
    for (const off of Object.values(OFF)) if (off !== OFF.B && rdsSyndrome(blk) === off) crossOffset = false;
    ok(crossOffset, 'a block built for one offset does not check as another');
  }
}

// ---- The PTY table ----
{
  const want = ['None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education', 'Drama', 'Culture', 'Science',
    'Varied', 'Pop Music', 'Rock Music', 'Easy Listening', 'Light Classical', 'Serious Classical', 'Other Music',
    'Weather', 'Finance', "Children's", 'Social Affairs', 'Religion', 'Phone In', 'Travel', 'Leisure', 'Jazz Music',
    'Country Music', 'National Music', 'Oldies Music', 'Folk Music', 'Documentary', 'Alarm Test', 'Alarm'];
  eq(PTY_NAMES.length, 32, 'thirty-two programme types');
  eqArr([...PTY_NAMES], want, 'the European PTY names, in order');
}

// ---- A clean station ----
const CLEAN_BITS = bitsOf(station(STATION));
{
  const chunk = RATE / 8;
  const { st, emits, chunks } = decode(mpx(CLEAN_BITS, { seconds: 3 }), { chunk });
  eq(st.synced, true, 'clean signal: synced');
  eq(st.pi, 0xc0fe, 'clean signal: PI');
  eq(st.ps, 'MAYHEM  ', 'clean signal: PS, eight characters with the padding kept');
  eq(st.rt, RT_SHOWN, 'clean signal: RT, cut at the carriage return');
  eq(st.pty, 10, 'clean signal: PTY');
  eq(st.ptyName, 'Pop Music', 'clean signal: PTY name');
  eq(st.tp, true, 'clean signal: TP');
  eq(st.ta, false, 'clean signal: TA');
  eq(st.ms, true, 'clean signal: M/S');
  eqArr(st.af, [87.6, 99.9, 104.3], 'clean signal: AF list, sorted, without the count header or filler');
  eq(st.errors, 0, 'clean signal: no block errors');
  ok(st.groups >= 25, 'clean signal: groups counted', `got ${st.groups}`);

  ok(emits.length > 0, 'the decoder emitted');
  eq(emits[0]?.synced, true, 'the first emit is the one announcing sync');
  ok(emits.every(e => e.synced), 'every emit on a clean signal reports sync');
  const last = emits[emits.length - 1];
  eq(last.ps, st.ps, 'the last emit carries the same PS as the state getter');
  eq(last.rt, st.rt, 'and the same RT');
  ok(emits[0] !== emits[1], 'emits are distinct objects');
  {
    const a = emits[emits.length - 1];
    a.af.push(999);
    ok(!st.af.includes(999) && !decode(new Float32Array(0)).st.af.includes(999), 'a snapshot\'s AF array is a copy');
  }
  // Emits are throttled to four a second: pushed in 125 ms chunks, consecutive emits are never in adjacent chunks.
  let spaced = true;
  for (let i = 1; i < chunks.length; i++) if (chunks[i] - chunks[i - 1] < 2) spaced = false;
  ok(spaced, 'emits are at least a quarter of a second apart', chunks.join(','));
  ok(emits.length <= 14, 'no more than four emits a second plus the sync announcement', `${emits.length} emits`);
}

// ---- Chunking does not change the answer ----
{
  const sig = mpx(CLEAN_BITS, { seconds: 3 });
  const a = decode(sig, { chunk: 777 }).st, b = decode(sig, { chunk: sig.length }).st;
  eq(a.ps, 'MAYHEM  ', 'odd-sized chunks decode the PS');
  eq(b.ps, 'MAYHEM  ', 'one huge push decodes the PS');
  eq(a.rt, b.rt, 'and both see the same RT');
  eq(a.groups, b.groups, 'with the same group count');
}

// ---- Polarity, frequency error, amplitude, and the pulse shape ----
{
  eq(decode(mpx(CLEAN_BITS, { seconds: 3, phase0: Math.PI })).st.ps, 'MAYHEM  ', 'inverted carrier: same PS');
  eq(decode(mpx(CLEAN_BITS, { seconds: 3, phase0: Math.PI })).st.rt, RT_SHOWN, 'inverted carrier: same RT');
  eq(decode(mpx(CLEAN_BITS, { seconds: 3, phase0: 1.1 })).st.rt, RT_SHOWN, 'arbitrary carrier phase: same RT');
  for (const f of [20, -20]) {
    const st = decode(mpx(CLEAN_BITS, { seconds: 3, freqError: f, phase0: 0.7 })).st;
    eq(st.ps, 'MAYHEM  ', `${f > 0 ? '+' : ''}${f} Hz carrier error: PS`);
    eq(st.rt, RT_SHOWN, `${f > 0 ? '+' : ''}${f} Hz carrier error: RT`);
    eq(st.errors, 0, `${f > 0 ? '+' : ''}${f} Hz carrier error: no block errors`);
  }
  // Scale is arbitrary: the same composite a thousand times smaller and a thousand times larger, with a
  // frequency error so the loop has to work rather than happen to start in phase.
  for (const scale of [1e-3, 1e3]) {
    const sig = mpx(CLEAN_BITS, { seconds: 3, freqError: 15, phase0: 2 });
    for (let i = 0; i < sig.length; i++) sig[i] *= scale;
    eq(decode(sig).st.rt, RT_SHOWN, `composite scaled by ${scale}: RT`);
  }
  eq(decode(mpx(CLEAN_BITS, { seconds: 3, shaped: false })).st.rt, RT_SHOWN, 'square biphase pulses: RT');
  eq(decode(mpx(CLEAN_BITS, { seconds: 3, pilot: 0, stereo: 0 })).st.rt, RT_SHOWN, 'a mono station with no pilot: RT');
}

// ---- Noise ----
// White noise of sigma 0.05 per sample at 250 kHz is about 6.7 dB SNR in the 4.8 kHz RDS band (the subcarrier
// here is 0.03 peak); 0.09 is about 1.6 dB, where blocks start to fail but the station is still readable.
{
  const mild = decode(mpx(CLEAN_BITS, { seconds: 3, noise: 0.05, seed: 7, phase0: 0.4 })).st;
  eq(mild.synced, true, 'mild noise: synced');
  eq(mild.ps, 'MAYHEM  ', 'mild noise: PS');
  eq(mild.rt, RT_SHOWN, 'mild noise: RT');
  eq(mild.pi, 0xc0fe, 'mild noise: PI');
  // Six seconds, not four: with blocks failing, each segment needs two good hearings before it is believed.
  const heavy = decode(mpx(CLEAN_BITS, { seconds: 6, noise: 0.09, seed: 11, phase0: 2.5 })).st;
  eq(heavy.synced, true, 'heavy noise: still synced');
  eq(heavy.ps, 'MAYHEM  ', 'heavy noise: PS');
  eq(heavy.pi, 0xc0fe, 'heavy noise: PI');
  ok(heavy.groups >= 10, 'heavy noise: groups still get through', `got ${heavy.groups}`);
  // The channel really was lossy: the premise for calling this a noise test.
  ok(heavy.errors > 0, 'heavy noise: some blocks failed their check (premise)', `errors ${heavy.errors}`);
}

// ---- Other sample rates ----
for (const rate of [128000, 192000, 500000]) {
  const st = decode(mpx(CLEAN_BITS, { rate, seconds: 3, freqError: 10, phase0: 0.3 }), { rate }).st;
  eq(st.ps, 'MAYHEM  ', `${rate / 1000} kHz: PS`);
  eq(st.rt, RT_SHOWN, `${rate / 1000} kHz: RT`);
  eqArr(st.af, [87.6, 99.9, 104.3], `${rate / 1000} kHz: AF`);
}
{
  // A rate change mid-stream reconfigures rather than carrying stale filters.
  const dec = new RdsDecoder(() => {});
  decode(mpx(CLEAN_BITS, { seconds: 1 }), { dec });
  const st = decode(mpx(CLEAN_BITS, { rate: 192000, seconds: 3 }), { rate: 192000, dec }).st;
  eq(st.rt, RT_SHOWN, 'switching sample rate mid-stream still decodes');
}

// ---- Sync loss and recovery ----
{
  const emits = [];
  const dec = new RdsDecoder(s => emits.push(s));
  decode(mpx(CLEAN_BITS, { seconds: 2 }), { dec });
  eq(dec.state.synced, true, 'sync test: synced before the carrier goes away (premise)');
  const errorsBefore = dec.state.errors;
  decode(mpx(CLEAN_BITS, { seconds: 2, rds: false, noise: 0.02, seed: 3 }), { dec });
  eq(dec.state.synced, false, 'with the subcarrier gone for two seconds, sync is lost');
  ok(dec.state.errors - errorsBefore >= 50, 'losing sync took at least fifty failed blocks', `${dec.state.errors - errorsBefore}`);
  ok(emits.some(e => !e.synced), 'the loss was announced');
  eq(emits[emits.length - 1].synced, false, 'and it was the last thing announced');
  eq(dec.state.ps, 'MAYHEM  ', 'the last known PS is kept through the loss');
  const nEmits = emits.length;
  decode(mpx(CLEAN_BITS, { seconds: 2, phase0: 1 }), { dec });
  eq(dec.state.synced, true, 'sync comes back with the carrier');
  ok(emits.length > nEmits && emits[nEmits].synced, 'and the regain was announced');
  // No carrier at all: nothing is ever announced.
  const idle = decode(mpx(CLEAN_BITS, { seconds: 2, rds: false, noise: 0.03, seed: 5 }));
  eq(idle.st.synced, false, 'noise and pilot alone never sync');
  eq(idle.emits.length, 0, 'and produce no emits');
  eq(idle.st.groups, 0, 'and no groups');
}

// ---- A damaged block is counted and never written into the name ----
{
  // One damaged PS block in one cycle, clean cycles either side. Its characters must not reach the name; whole-
  // frame PS simply skips the frame the damaged segment belonged to, and the clean cycles show the real name.
  const cycle = station(STATION);              // one interleaved cycle; PS segments 0..3 in order
  const seg3 = 6;                              // the group carrying PS segment 3
  eq((cycle[seg3][1] >>> 10) & 3, 3, 'the group being damaged carries PS segment 3 (premise)');
  eq(cycle[seg3][1] >>> 22, 0, 'and is a type 0 group (premise)');
  const bad = cycle.map(g => g.slice());
  bad[seg3] = bad[seg3].slice();
  bad[seg3][3] ^= (1 << 10);                   // flip a data bit of block D: the block fails, and if used PS would end in "!"
  const st = decode(mpx(bitsOf([...cycle, ...cycle, bad, ...cycle, ...cycle]))).st;
  eq(st.synced, true, 'a damaged block does not cost sync');
  eq(st.ps, 'MAYHEM  ', "the damaged block's characters are not written into the name");
  ok(st.errors >= 1, 'the damaged block was counted as an error', `errors ${st.errors}`);
}

// ---- Text A/B flag ----
{
  const first = station({ pi: 0xc0fe, rt: 'FIRST TEXT\r', ab: 0 });
  const patch = (ab) => rtGroups({ pi: 0xc0fe, rt: '        XYZW', ab, segments: [2] });
  // Premise: with the flag unchanged, a lone segment lands on top of the old text and leaves its residue — the
  // block checkword vouched for it, so it is written straight in, the way every RadioText segment is.
  const same = decode(mpx(bitsOf([...first, ...first, ...patch(0), ...patch(0)]))).st;
  eq(same.rt, 'FIRST TEXYZW', 'without a flag change, a new segment leaves the old text around it (premise)');
  const toggled = decode(mpx(bitsOf([...first, ...first, ...patch(1), ...patch(1)]))).st;
  eq(toggled.rt, '        XYZW', 'a toggled text A/B flag clears the old text first');
  // The flag's first value is not a toggle: a station that starts on B must not have its opening text wiped.
  const startsB = decode(mpx(bitsOf(station({ pi: 0xc0fe, rt: 'STARTS ON B\r', ab: 1 })), { seconds: 2 })).st;
  eq(startsB.rt, 'STARTS ON B', 'a station whose flag starts at 1 keeps its text');
  // Many stations never toggle the flag; then the carriage return is all that hides the tail of the longer text.
  const long = station({ pi: 0xc0fe, rt: 'LONGER FIRST TEXT HERE\r', ab: 0 });
  const short = station({ pi: 0xc0fe, rt: 'SHORT\r', ab: 0 });
  const cr = decode(mpx(bitsOf([...long, ...long, ...short, ...short]))).st;
  eq(cr.rt, 'SHORT', 'a shorter text under the same flag is cut at its carriage return, hiding the old tail');
}

// ---- The name is shown only when it is a real, repeating name — a scroll is suppressed ----
{
  // A fixed name repeats every cycle, so it shows once the same whole frame has arrived twice running.
  eq(decode(mpx(bitsOf(station({ ...STATION, ps: 'ROCKGOD ' })), { seconds: 3 })).st.ps, 'ROCKGOD ', 'a fixed name is shown once it repeats');
  // A name a station scrolls a song title through never repeats — each cycle's four segments are a different
  // scroll position, so even a whole frame is a jumble. It is suppressed entirely rather than shown mangled;
  // the RadioText carries the full text. No emit ever carries one of the scroll frames.
  const frames = ['ROCKGOD ', 'WALTZ #2', 'CHOPIN  ', 'MAYHEM 1'];
  const emits = [];
  const dec = new RdsDecoder(s => emits.push(s.ps));
  const dyn = []; for (const fr of frames) dyn.push(...psGroups({ ...STATION, ps: fr }));
  decode(mpx(bitsOf([...dyn, ...dyn])), { dec });
  eq(dec.state.ps, '        ', 'a scrolling name is not shown at all');
  ok(emits.every(ps => ps === '        '), 'no scroll frame is ever emitted as the name', JSON.stringify(emits.filter(ps => ps !== '        ')));
  // A fixed name interrupted by a one-off garbled frame keeps showing: the garble does not repeat, so it never
  // qualifies, and the clean name around it does.
  const good = station({ ...STATION, ps: 'MAYHEM  ' });
  const stray = psGroups({ ...STATION, ps: 'MAXXEM  ' })[1];   // one segment-1 group carrying wrong characters
  eq((stray[1] >>> 10) & 3, 1, 'the stray group carries PS segment 1 (premise)');
  const st = decode(mpx(bitsOf([...good, ...good, stray, ...good, ...good]))).st;
  eq(st.ps, 'MAYHEM  ', 'a lone garbled segment does not corrupt the shown name');
}

// ---- The station arriving at an arbitrary point in the decoder's bit clock ----
// Every other scenario starts the decoder and the station together, so the half-symbol pairing is settled by the
// first transition. Here the decoder has been running on audio without RDS for a while first, and the station's
// bit grid lands at eight different phases against its clock. Noise is part of this deliberately: with the halves
// paired wrongly, the causal filter's inter-symbol tail breaks every tie in a fixed direction and the result is
// the right bit stream one bit late, so a wrong pairing decodes a clean signal perfectly; only under noise does it
// fail, because half its symbols are decided by that sliver of tail.
{
  const sig = mpx(CLEAN_BITS, { seconds: 4, phase0: 0.9, noise: 0.05, seed: 21 });
  const lead = mpx(CLEAN_BITS, { seconds: 0.4, rds: false, noise: 0.05, seed: 9 });
  const bitSamples = RATE / 1187.5;
  for (let i = 0; i < 8; i++) {
    const st = decode(concat(lead.subarray(0, Math.round(0.3 * RATE + i / 8 * bitSamples)), sig)).st;
    eq(st.rt, RT_SHOWN, `station arriving ${i}/8 of a bit into the clock: RT`);
    eq(st.ps, 'MAYHEM  ', `station arriving ${i}/8 of a bit into the clock: PS`);
  }
}

// ---- Version B groups ----
{
  // A 2B segment address is four bits and carries two characters, so version B radiotext stops at 32 characters;
  // this one uses all of them, with no terminator.
  const rt32 = 'MAYHEM 2B TEXT, THIRTY-TWO CHARS';
  eq(rt32.length, 32, 'the 2B text fills the 32 characters version B can address (premise)');
  const st = decode(mpx(bitsOf(station({ ...STATION, rt: rt32, versionB: true })), { seconds: 4.5 })).st;   // sixteen segments, each confirmed twice
  eq(st.ps, 'MAYHEM  ', '0B groups: PS from block D');
  eq(st.rt, rt32, '2B groups: RT two characters at a time');
  eq(st.pi, 0xc0fe, 'version B: PI');
  eqArr(st.af, [], '0B groups carry no AF list');
  eq(st.errors, 0, 'block C under offset C\' checks as a good block');
}

// ---- AF codes ----
{
  const raw = (pairs) => decode(mpx(bitsOf(psGroups({ pi: 0xc0fe, ps: 'AFTEST  ', afRaw: pairs })), { seconds: 1.5 })).st.af;
  eqArr(raw([(225 << 8) | 1]), [87.6], 'AF code 1 is 87.6 MHz and the count header is not a frequency');
  eqArr(raw([(204 << 8) | 204]), [107.9], 'AF code 204 is 107.9 MHz, listed once');
  eqArr(raw([(205 << 8) | 205, (0 << 8) | 223]), [], 'filler, zero and the unassigned codes are not frequencies');
  eqArr(raw([(250 << 8) | 20]), [], 'code 250 announces an LF/MF frequency, which is left out');
  eqArr(raw([(226 << 8) | 150, (50 << 8) | 205]), [92.5, 102.5], 'frequencies from several blocks are merged and sorted');
}

// ---- PI is believed only when it repeats ----
{
  const a = station(STATION);
  const stray = rtGroups({ pi: 0xbeef, rt: 'STRAY\r', segments: [0] });
  eq(stray.length, 1, 'the stray PI arrives in exactly one group (premise)');
  const b = rtGroups({ pi: 0xbeef, rt: 'OTHER STATION\r', pty: 1 });
  const sig = mpx(bitsOf([...a, ...a, ...stray, ...a, ...a, ...b, ...b, ...b, ...b]));
  const dec = new RdsDecoder(() => {});
  // Up to the stray group and just past it.
  const cut = Math.round(RATE * ((2 * a.length + 2) * 104 / 1187.5 + 0.05));
  decode(sig.subarray(0, cut), { dec });
  eq(dec.state.pi, 0xc0fe, 'a single group with a different PI does not change the PI');
  eq(dec.state.ps, 'MAYHEM  ', 'nor does it wipe the PS');
  eq(dec.state.rt, RT_SHOWN, 'nor is its text written into the RT');
  eq(dec.state.pty, 10, 'nor is its PTY taken');
  decode(sig.subarray(cut), { dec });
  eq(dec.state.pi, 0xbeef, 'a PI that repeats is adopted');
  eq(dec.state.ps, '        ', 'and the old station\'s PS is cleared');
  eq(dec.state.rt, 'OTHER STATION', 'with the new station\'s text in place');
  eq(dec.state.pty, 1, 'and its PTY');
  eqArr(dec.state.af, [], 'and no leftover AF list');
}

// ---- Characters, flags, reset ----
{
  const st = decode(mpx(bitsOf(station({ pi: 0x1234, ps: 'AéBCD~', pty: 31, ta: true, ms: false, af: [] })), { seconds: 1.5 })).st;
  eq(st.ps, 'A B C D~', 'codes outside 0x20..0x7E are shown as blanks');
  eq(st.ptyName, 'Alarm', 'PTY 31');
  eq(st.ta, true, 'TA set');
  eq(st.ms, false, 'M/S clear');
  eq(st.tp, false, 'TP clear');
  eq(st.pi, 0x1234, 'PI');
  const none = decode(mpx(bitsOf(station({ pi: 0x1234, ps: 'ZERO    ', pty: 0 })), { seconds: 1.5 })).st;
  eq(none.pty, 0, 'PTY 0'); eq(none.ptyName, 'None', 'is named None');
  eq(decode(mpx(bitsOf(station({ pi: 0x1234, rt: 'NO TERMINATOR HERE, SIXTY-FOUR CHARACTERS FILLED TO THE BRIM....' })), { seconds: 3.5 })).st.rt,
    'NO TERMINATOR HERE, SIXTY-FOUR CHARACTERS FILLED TO THE BRIM....', 'a full 64-character RT with no terminator');
  eq(decode(mpx(bitsOf(station({ pi: 0x1234, rt: 'SHORT\r' })), { seconds: 2 })).st.rt, 'SHORT', 'a short RT');

  const dec = new RdsDecoder(() => {});
  decode(mpx(CLEAN_BITS, { seconds: 2 }), { dec });
  eq(dec.state.pi, 0xc0fe, 'decoded before reset (premise)');
  dec.reset();
  const blank = dec.state;
  eq(blank.pi, null, 'reset: PI null'); eq(blank.ps, '        ', 'reset: PS blank'); eq(blank.rt, '', 'reset: RT empty');
  eq(blank.pty, null, 'reset: PTY null'); eq(blank.ptyName, '', 'reset: no PTY name');
  eq(blank.synced, false, 'reset: not synced'); eq(blank.groups, 0, 'reset: no groups'); eq(blank.errors, 0, 'reset: no errors');
  eqArr(blank.af, [], 'reset: no AF');
  eq(blank.tp, false, 'reset: TP'); eq(blank.ta, false, 'reset: TA'); eq(blank.ms, false, 'reset: M/S');
  decode(mpx(CLEAN_BITS, { seconds: 3 }), { dec });
  eq(dec.state.rt, RT_SHOWN, 'and it decodes again after the reset');

  const fresh = new RdsDecoder(() => {}).state;
  eq(fresh.ps, '        ', 'a fresh decoder\'s PS is eight blanks');
  eq(fresh.synced, false, 'and it starts unsynced');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
