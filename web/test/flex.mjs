/**
 * FLEX decoder, fed from a transmit-side model of the air interface (the same frames the Android app's tests use).
 *
 * A frame is built from its parts: bit sync, sync 1 with the mode code, the FIW, sync 2 at the frame's speed, then
 * eleven 256-bit blocks of BCH codewords, bit-interleaved eight words to a block. It goes out as FSK on an FM
 * discriminator with a carrier offset, a short moving average for the channel filter and Gaussian noise. Damage is
 * put in on purpose: confident bit errors (flipped words), a word "corrected" into another, and a fade (bits sent
 * the wrong way but weakly, close to the decision line), so the checksums, the soft recovery, fragments and repeats
 * are each checked against what they are for, and against what they must not do.
 */
import { FlexDecoder, bchCorrect, bchEncode } from '../dist/dsp/flex.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

console.log('FLEX: BCH with parity, frames, page checksums, fragments, soft recovery and repeats');

// ---- BCH(31,21) + parity ----
const popcount = (x) => { x >>>= 0; let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };
{
  const w = bchEncode(0x12345);
  eq(bchCorrect(w), w, 'a clean word passes');
  let fixed = 0, refused = 0;
  for (let i = 0; i < 32; i++) if (bchCorrect(w ^ (1 << i)) === w) fixed++;
  for (let i = 0; i < 32; i++) for (let j = i + 1; j < 32; j++) if (bchCorrect(w ^ (1 << i) ^ (1 << j)) === w) fixed++;
  eq(fixed, 32 + 32 * 31 / 2, 'every one- and two-bit error is fixed');
  for (let i = 11; i < 32; i++) for (let j = i + 1; j < 32; j++) for (let k = j + 1; k < 32; k++) { const c = bchCorrect(w ^ (1 << i) ^ (1 << j) ^ (1 << k)); if (c === null) refused++; }
  eq(refused, 1330, 'three errors in the data bits are refused, never miscorrected');
}

// ---- the air ----
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function rev32(x) {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1); x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0F0F0F0F) | ((x & 0x0F0F0F0F) << 4); x = ((x >>> 8) & 0x00FF00FF) | ((x & 0x00FF00FF) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}
/** The MSB-first on-air word for a FLEX data field: FLEX sends a word's 21 data bits low bit first. */
const flexWord = (data) => bchEncode(rev32(data & 0x1FFFFF) >>> 11);

function fsk(levels, baudOf, devHzPerUnit, fs, r, noise = 0.08, offsetHz = 420, lead = 900) {
  let span = 0; for (let k = 0; k < levels.length; k++) span += fs / baudOf(k);
  const n = Math.round(span) + lead * 2, raw = new Float64Array(n);
  let t = lead + r() * fs / baudOf(0);
  for (let k = 0; k < levels.length; k++) { const end = t + fs / baudOf(k); for (let i = Math.floor(t); i < Math.min(n, Math.floor(end)); i++) raw[i] = levels[k] * devHzPerUnit; t = end; }
  const m = Math.max(1, Math.floor(fs / baudOf(levels.length - 1) / 5)), out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += raw[i]; if (i >= m) acc -= raw[i - m]; out[i] = 2 * Math.PI * (acc / m + offsetHz) / fs + gauss(r) * noise; }
  return out;
}

function withChecksum(d) {
  const body = d & 0x1FFFF0;
  const s = ((body >>> 4) & 0xF) + ((body >>> 8) & 0xF) + ((body >>> 12) & 0xF) + ((body >>> 16) & 0xF) + ((body >>> 20) & 1);
  return body | ((0xF - (s & 0xF)) & 0xF);
}
const groups = (d) => (d & 0xFF) + ((d >>> 8) & 0xFF) + ((d >>> 16) & 0x1F);
/** An alphanumeric message as a transmitter builds it (ARIB STD-43A 3.10.1.3): header (K, C, F, N), then the
 *  characters three to a word, a first fragment's first word opening with the signature S. */
function alphaWords(text, n, frag = 3, more = 0) {
  const chars = [...text].map(c => c.charCodeAt(0)), content = [];
  const sig = (~chars.reduce((a, b) => a + b, 0)) & 0x7F;
  let k = 0, first = frag === 3;
  while (k < chars.length) {
    const c = [3, 3, 3];
    for (let s = first ? 1 : 0; s < 3; s++) if (k < chars.length) c[s] = chars[k++];
    if (first) c[0] = sig;
    content.push(c[0] | (c[1] << 7) | (c[2] << 14)); first = false;
  }
  let h = (more << 10) | (frag << 11) | (n << 13);
  let s = groups(h); for (const d of content) s += groups(d);
  h |= (~s) & 0x3FF;
  return [h, ...content];
}
/** A numeric message (3.10.1.1): two checksum bits, BCD digits low bit first, space fill; K3-K0 goes in the vector. */
function numericWords(digits) {
  const bits = [0, 0];
  for (const ch of digits) { const d = '0123456789.U -]['.indexOf(ch); for (let b = 0; b < 4; b++) bits.push((d >>> b) & 1); }
  while (bits.length % 21 !== 0) bits.push((0xC >>> ((bits.length - 2) % 4)) & 1);
  const words = []; for (let i = 0; i < bits.length / 21; i++) { let v = 0; for (let b = 0; b < 21; b++) v |= bits[i * 21 + b] << b; words.push(v); }
  let sum = 0; for (const d of words) sum += groups(d);
  const s = sum & 0xFF, k6 = (~((s & 0x3F) + (s >>> 6))) & 0x3F;
  words[0] |= (k6 >>> 4) & 3;
  return { words, k30: k6 & 0xF };
}
/** Phase words for an alphanumeric page and a numeric page on short addresses. Text starts at word 6. */
function flexPhase(alphaCap, text, numCap, digits, n = 5, frag = 3, more = 0) {
  const w = new Array(88).fill(0), aOff = 1, vOff = 3;
  w[0] = withChecksum((vOff << 10) | ((aOff - 1) << 8));
  w[1] = alphaCap + 0x8000; w[2] = numCap + 0x8000;
  const msg = 5, a = alphaWords(text, n, frag, more);
  a.forEach((v, i) => { w[msg + i] = v; });
  w[vOff] = withChecksum((5 << 4) | (msg << 7) | (a.length << 14));
  const nStart = msg + a.length, { words, k30 } = numericWords(digits);
  words.forEach((v, i) => { w[nStart + i] = v; });
  w[vOff + 1] = withChecksum((3 << 4) | (nStart << 7) | ((words.length - 1) << 14) | (k30 << 17));
  return w;
}
/** A long (two-word) address page: its header rides in the second vector word, the text further on, from word 9. */
function flexPhaseLong(cap, text) {
  const w = new Array(88).fill(0), aOff = 1, vOff = 3;
  w[0] = withChecksum((vOff << 10) | ((aOff - 1) << 8));
  const q = Math.floor((cap - 2068480) / 32768);
  w[1] = cap - 2068480 - q * 32768; w[2] = 2097151 - q;
  const msg = 9;
  for (let k = 5; k < msg; k++) w[k] = 0x0A5A5 + k;
  const a = alphaWords(text, 9);
  w[vOff + 1] = a[0];
  for (let i = 1; i < a.length; i++) w[msg + i - 1] = a[i];
  w[vOff] = withChecksum((5 << 4) | (msg << 7) | (a.length << 14));
  return w;
}
function flexFrame(code, baud, levels4, phaseA, flip = {}, fade = {}) {
  const out = [];
  for (let i = 0; i < 96; i++) out.push(i % 2 === 0 ? 3 : -3);
  const sync = (BigInt(code) << 48n) | (0xA6C6AAAAn << 16n) | (BigInt(~code & 0xFFFF));
  for (let k = 63; k >= 0; k--) out.push(((sync >> BigInt(k)) & 1n) === 1n ? -3 : 3);   // sync bit 1 = low tone
  for (let i = 0; i < 16; i++) out.push(i % 2 === 0 ? 3 : -3);
  const fiw = flexWord(withChecksum((3 << 4) | (5 << 8)));
  for (let k = 31; k >= 0; k--) out.push(((fiw >>> k) & 1) === 1 ? 3 : -3);
  const s2 = Math.floor(baud * 25 / 1000), tail = ((0xED84 << 16) | 0x127B) >>> 0;
  for (let i = 0; i < s2; i++) { const bit = i >= s2 - 32 ? (tail >>> (s2 - 1 - i)) & 1 : i & 1; out.push(bit === 1 ? 3 : -3); }
  const air = [0, 1, 2, 3].map(p => phaseA.map((d, i) => p === 0 ? (flexWord(d) ^ (flip[i] ?? 0)) >>> 0 : 0));
  const bit = (p, c) => { const idx = (c >>> 8) * 8 + (c & 7), pos = (c >>> 3) & 31; return (air[p][idx] >>> (31 - pos)) & 1; };
  const level = (a, b) => !levels4 ? (a === 1 ? 3 : -3) : a === 1 && b === 0 ? 3 : a === 1 ? 1 : b === 1 ? -1 : -3;
  const faded = (c) => { const idx = (c >>> 8) * 8 + (c & 7), pos = (c >>> 3) & 31; return (((fade[idx] ?? 0) >>> (31 - pos)) & 1) === 1; };
  for (let c = 0; c < 11 * 256; c++) {
    if (!levels4 && baud === 1600 && faded(c)) { out.push(bit(0, c) === 1 ? -0.6 : 0.6); continue; }
    if (baud === 1600) out.push(level(bit(0, c), bit(1, c)));
    else { out.push(level(bit(0, c), bit(1, c))); out.push(level(bit(2, c), bit(3, c))); }
  }
  return out;
}

const LINE = /^FLEX (\d+)\/(\d)L C(\d+)F(\d+) CAP (\d+)(?: [a-z]+)?(?: PRI)? (\w+)( PARTIAL)?(?:: (.*))?$/;
/** Frames one after another through one decoder ([baud] after each frame's 1600-baud head). */
function decode(frames, baud, seed) {
  const head = 96 + 64 + 16 + 32, sym = [], rates = [];
  for (const f of frames) f.forEach((v, k) => { sym.push(v); rates.push(k < head ? 1600 : baud); });
  const sig = fsk(sym, (k) => rates[k], 1600, 48_000, rng(seed));
  const msgs = [];
  const dec = new FlexDecoder((m) => msgs.push(m));
  dec.onFm(sig, sig.length, 48_000);
  const pages = msgs.filter(m => m.type === 'packet').map(m => { const x = LINE.exec(m.line); return x && { rate: x[1], cycle: +x[3], frame: +x[4], cap: +x[5], kind: x[6], partial: !!x[7], text: x[8] ?? '', line: m.line, replaces: m.replaces }; }).filter(Boolean);
  return { pages, msgs, dec };
}
const TEXT = 'STATION 7 RESPOND TO ROOM 38 NOW PLEASE';
/** TEXT with the characters of message words from..to (the first text word is 0) lost. */
function lostWords(from, to) { const at = (w) => w === 0 ? 0 : 2 + (w - 1) * 3; const a = at(from), b = Math.min(TEXT.length, at(to + 1)); return TEXT.slice(0, a) + '?'.repeat(b - a) + TEXT.slice(b); }
const F = (phase, flip, fade) => flexFrame(0x870C, 1600, false, phase, flip, fade);
const P = (text = TEXT, opts = {}) => flexPhase(1234567, text, 765432, '5551234', opts.n ?? 5, opts.frag ?? 3, opts.more ?? 0);
const alphaOf = (r) => r.pages.filter(p => p.cap === 1234567);

for (const [code, baud, four, rate, seed] of [[0x870C, 1600, false, '1600', 11], [0xB068, 1600, true, '3200', 12], [0x7B18, 3200, false, '3200', 13], [0xDEA0, 3200, true, '6400', 14]]) {
  const { pages } = decode([flexFrame(code, baud, four, flexPhase(1234567, 'CODE 3 MVA I-75 NB MM 12', 765432, '5551234'))], baud, seed);
  const a = pages.find(p => p.cap === 1234567), n = pages.find(p => p.cap === 765432);
  ok(!!a, `FLEX ${rate}${four ? ' 4-level' : ''}: the alphanumeric page decodes`, JSON.stringify(pages));
  if (a) { eq(a.text, 'CODE 3 MVA I-75 NB MM 12', `FLEX ${rate}: its text`); eq(a.rate, rate, `FLEX ${rate}: its rate`); eq(a.cycle * 1000 + a.frame, 3005, `FLEX ${rate}: cycle 3 frame 5`); eq(a.partial, false, `FLEX ${rate}: K confirms it whole`); }
  ok(!!n && n.text === '5551234' && !n.partial, `FLEX ${rate}: the numeric page decodes, its K confirmed`, JSON.stringify(n));
}
{
  const { pages } = decode([F(flexPhaseLong(420167049, 'CLASS 2 21 Y/O M MVC ETA 8 MIN'))], 1600, 15);
  const p = pages.find(x => x.cap === 420167049);
  eq(p?.text, 'CLASS 2 21 Y/O M MVC ETA 8 MIN', 'a long address: header from the second vector word, page and capcode come out');
  eq(p?.partial, false, 'and it is whole');
}
{
  const a = alphaOf(decode([F(P(), { [6 + 3]: 0x0E000000 })], 1600, 22))[0];
  eq(a?.text, 'STATION ???ESPOND TO ROOM 38 NOW PLEASE', 'one lost word inside good text stays a gap, the rest is kept'); eq(a?.partial, true, 'and the page is partial');
}
{
  const r = decode([F(P(), { [6 + 6]: 0x0E000000, [6 + 7]: 0x00E00000, [6 + 8]: 0x000E0000 })], 1600, 21);
  eq(alphaOf(r)[0]?.text, lostWords(6, 8), 'a fade across three words: the gap shows and the text after it is kept');
  eq(r.pages.find(p => p.cap === 765432)?.text, '5551234', 'the numeric page alongside is untouched');
}
{
  const r = decode([F(P(), {}, { [6 + 3]: 0x48210000 })], 1600, 31);
  eq(alphaOf(r)[0]?.text, TEXT, 'a word lost in a fade comes back from the bits the receiver was unsure of'); eq(alphaOf(r)[0]?.partial, false, 'K confirms it');
  ok(r.dec.recovered >= 1, 'counted as recovered', `recovered ${r.dec.recovered}`);
}
eq(alphaOf(decode([F(P(), {}, { [6 + 5]: 0x41208400, [6 + 6]: 0x00E00000 })], 1600, 32))[0]?.text, TEXT, 'a fade across two neighbouring words: both come back');
eq(alphaOf(decode([F(P(), { [6 + 3]: 0x3F000000 })], 1600, 33))[0]?.text, 'STATION ???ESPOND TO ROOM 38 NOW PLEASE', 'six confident wrong bits are not "recovered" into something else');
{
  const lastWord = 6 + Math.floor(TEXT.length / 3);
  const a = alphaOf(decode([F(P(), { [6 + 4]: 0x00000006, [lastWord]: 0x60000000 })], 1600, 23))[0];
  eq(a?.text, TEXT, 'two-bit fixes are kept when K confirms the page, even the last word'); eq(a?.partial, false, 'whole');
}
{
  const wrong = P(); wrong[6 + 4] ^= 0x0A5A5;   // another valid word; the page's K unchanged
  const a = alphaOf(decode([F(wrong, { [6 + 4]: 0x00000006 })], 1600, 24))[0];
  eq(a?.text, lostWords(4, 4), 'noise "corrected" into a wrong word: K catches it and the word is lost'); eq(a?.partial, true, 'partial');
}
{
  const a = alphaOf(decode([F(P('PART ONE OF THE ', { n: 7, more: 1 })), F(P('MESSAGE ENDS HERE', { n: 7, frag: 0 }))], 1600, 41));
  eq(a.length, 1, 'fragments: one page'); eq(a[0]?.text, 'PART ONE OF THE MESSAGE ENDS HERE', "joined by message number, the continuation's first character kept"); eq(a[0]?.partial, false, 'whole');
}
{
  const a = alphaOf(decode([F(P('PART ONE OF THE ', { n: 7, more: 1 })), F(P('SOMETHING ELSE', { n: 8, frag: 0 }))], 1600, 42));
  ok(!a.some(p => p.text.includes('PART ONE OF THE SOMETHING')), 'a continuation with another message number is not joined');
  ok(a.some(p => p.text.startsWith('<…>SOMETHING ELSE') && p.partial), 'and shows as a piece whose start never came', JSON.stringify(a));
}
{
  const a = alphaOf(decode([F(P('FIRST PIECE ', { n: 3, more: 1 })), F(P('LAST PIECE', { n: 3, frag: 1 }))], 1600, 43))[0];
  eq(a?.text, 'FIRST PIECE <…>LAST PIECE', 'a fragment missing from the F sequence is marked'); eq(a?.partial, true, 'partial');
}
{
  const a = alphaOf(decode([F(P(), { [6 + 3]: 0x0E000000 }), F(P(), { [6 + 9]: 0x0E000000 }), F(P())], 1600, 44));
  eq(a.length, 2, 'repeats: a third copy adding nothing is not sent');
  eq(a[0]?.text, lostWords(3, 3), 'repeats: the first copy as heard');
  eq(a[1]?.text, TEXT, 'repeats: the second fills the word the first lost'); eq(a[1]?.partial, false, 'and K confirms it');
  eq(a[1]?.replaces, a[0]?.line, 'repeats: it replaces the first line');
}
{
  const a = alphaOf(decode([F(P(), { [6 + 3]: 0x0E000000 }), F(P('STATION 9 RESPOND TO ROOM 12 NOW PLEASE'))], 1600, 45));
  ok(a[1]?.text === 'STATION 9 RESPOND TO ROOM 12 NOW PLEASE' && !a[1]?.replaces, 'same capcode and number but words that disagree: a different page, kept apart', JSON.stringify(a));
}
{
  const ph = P(), nStart = 5 + alphaWords(TEXT, 5).length;
  const wrong = ph.slice(); wrong[nStart] ^= 0x0A5A0;
  eq(decode([F(wrong, { [nStart]: 0x00000006 })], 1600, 46).pages.find(p => p.cap === 765432)?.partial, true, 'a numeric word "corrected" into a wrong one: the numeric K catches it');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
