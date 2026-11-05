/**
 * FLEX decoder, fed from a transmit-side model of the air interface (the same frames the Android app's tests use).
 *
 * A frame is built from its parts: bit sync, sync 1 with the mode code, the FIW, sync 2 at the frame's speed, then
 * eleven 256-bit blocks of BCH codewords, bit-interleaved eight words to a block. It goes out as FSK on an FM
 * discriminator with a carrier offset, a short moving average for the channel filter and Gaussian noise. Damage is
 * put in on purpose: confident bit errors (flipped words), and a fade (bits sent the wrong way but weakly, close to
 * the decision line), so the cut, the soft recovery and the merge of repeats are each checked against what they
 * are for, and against what they must not do.
 */
import { FlexDecoder, bchCorrect, bchEncode } from '../dist/dsp/flex.js';
import { mergePages } from '../dist/dsp/pagemerge.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

console.log('FLEX: BCH with parity, frames, the cut where words were lost, soft recovery and repeats');

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
/** Phase words (data fields) for an alphanumeric and a numeric page. */
function flexPhase(alphaCap, text, numCap, digits) {
  const w = new Array(88).fill(0), aOff = 1, vOff = 3;
  w[0] = withChecksum((vOff << 10) | ((aOff - 1) << 8));
  w[1] = alphaCap + 0x8000; w[2] = numCap + 0x8000;
  const msg = 5, chars = [...text].map(c => c.charCodeAt(0)), content = [];
  let k = 0, first = true;
  while (k < chars.length) {
    const c = [3, 3, 3];
    for (let s = first ? 1 : 0; s < 3; s++) if (k < chars.length) c[s] = chars[k++];
    if (first) c[0] = 0;
    content.push(c[0] | (c[1] << 7) | (c[2] << 14)); first = false;
  }
  w[msg] = 3 << 11;
  content.forEach((v, i) => { w[msg + 1 + i] = v; });
  const len = 1 + content.length;
  w[vOff] = withChecksum((5 << 4) | (msg << 7) | (len << 14));
  const nStart = msg + len, bits = [0, 0];
  for (const ch of digits) { const d = '0123456789.U -]['.indexOf(ch); for (let b = 0; b < 4; b++) bits.push((d >>> b) & 1); }
  while (bits.length % 21 !== 0) bits.push((0xC >>> ((bits.length - 2) % 4)) & 1);
  const nWords = bits.length / 21;
  for (let i = 0; i < nWords; i++) { let v = 0; for (let b = 0; b < 21; b++) v |= bits[i * 21 + b] << b; w[nStart + i] = v; }
  w[vOff + 1] = withChecksum((3 << 4) | (nStart << 7) | ((nWords - 1) << 14));
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
function decode(frame, baud, seed) {
  const head = 96 + 64 + 16 + 32;
  const sig = fsk(frame, (k) => k < head ? 1600 : baud, 1600, 48_000, rng(seed));
  const msgs = [];
  const d = new FlexDecoder((m) => msgs.push(m));
  d.onFm(sig, sig.length, 48_000);
  const pages = msgs.filter(m => m.type === 'packet').map(m => { const x = LINE.exec(m.line); return x && { rate: x[1], levels: x[2], cycle: +x[3], frame: +x[4], cap: +x[5], kind: x[6], partial: !!x[7], text: x[8] ?? '', line: m.line, replaces: m.replaces }; }).filter(Boolean);
  return { pages, msgs, dec: d };
}
const TEXT = 'STATION 7 RESPOND TO ROOM 38 NOW PLEASE';

for (const [code, baud, four, rate, seed] of [[0x870C, 1600, false, '1600', 11], [0xB068, 1600, true, '3200', 12], [0x7B18, 3200, false, '3200', 13], [0xDEA0, 3200, true, '6400', 14]]) {
  const { pages } = decode(flexFrame(code, baud, four, flexPhase(1234567, 'CODE 3 MVA I-75 NB MM 12', 765432, '5551234')), baud, seed);
  const a = pages.find(p => p.cap === 1234567), n = pages.find(p => p.cap === 765432);
  ok(!!a, `FLEX ${rate}${four ? ' 4-level' : ''}: the alphanumeric page decodes`, JSON.stringify(pages));
  if (a) { eq(a.text, 'CODE 3 MVA I-75 NB MM 12', `FLEX ${rate}: its text`); eq(a.rate, rate, `FLEX ${rate}: its rate`); eq(a.cycle * 1000 + a.frame, 3005, `FLEX ${rate}: cycle 3 frame 5`); eq(a.partial, false, `FLEX ${rate}: whole`); }
  ok(!!n && n.text === '5551234', `FLEX ${rate}: the numeric page decodes`, JSON.stringify(n));
}

// three bit errors a word: past what the code corrects, and never close enough to another word to miscorrect
{
  const { pages } = decode(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), { [6 + 6]: 0x0E000000, [6 + 7]: 0x00E00000, [6 + 8]: 0x000E0000 }), 1600, 21);
  const a = pages.find(p => p.cap === 1234567);
  eq(a?.text, 'STATION 7 RESPOND …', 'words lost partway: the page stops where the damage starts');
  eq(a?.partial, true, 'and is marked partial');
  eq(pages.find(p => p.cap === 765432)?.text, '5551234', 'the numeric page alongside is untouched');
}
{
  const { pages } = decode(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), { [6 + 3]: 0x0E000000 }), 1600, 22);
  const a = pages.find(p => p.cap === 1234567);
  eq(a?.text, 'STATION ???ESPOND TO ROOM 38 NOW PLEASE', 'one lost word inside good text stays a gap, the rest is kept');
  eq(a?.partial, true, 'and the page is partial');
}
{
  const lastWord = 6 + Math.floor(TEXT.length / 3);
  const { pages } = decode(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), { [6 + 4]: 0x00000006, [lastWord]: 0x60000000 }), 1600, 23);
  const a = pages.find(p => p.cap === 1234567);
  eq(a?.text, TEXT, 'two-bit fixes are kept, even on the last word');
  eq(a?.partial, false, 'and the page is whole');
}
// a fade: four bits of one word sent the wrong way, weakly
{
  const { pages, dec } = decode(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), {}, { [6 + 3]: 0x48210000 }), 1600, 31);
  const a = pages.find(p => p.cap === 1234567);
  eq(a?.text, TEXT, 'a word lost in a fade comes back from the bits the receiver was unsure of');
  eq(a?.partial, false, 'whole');
  ok(dec.recovered >= 1, 'counted as recovered', `recovered ${dec.recovered}`);
}
{
  const { pages } = decode(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), {}, { [6 + 5]: 0x41208400, [6 + 6]: 0x00E00000 }), 1600, 32);
  eq(pages.find(p => p.cap === 1234567)?.text, TEXT, 'a fade across two neighbouring words: both come back');
}
{
  const { pages } = decode(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), { [6 + 3]: 0x3F000000 }), 1600, 33);
  eq(pages.find(p => p.cap === 1234567)?.text, 'STATION ???ESPOND TO ROOM 38 NOW PLEASE', 'six confident wrong bits are not "recovered" into something else');
}

// ---- repeats ----
const P = (text, errors) => ({ text, errors });
eq(mergePages(P('STATION 7 RESPOND TO ROOM …', 2), P(TEXT, 0))?.text, TEXT, 'merge: a cut copy then the whole page — the whole one stands');
{
  const m = mergePages(P('STATION ???ESPOND TO ROOM 38 NOW PLEASE', 1), P('STATION 7 RESPOND TO ???M 38 NOW PLEASE', 1));
  eq(m?.text, TEXT, 'merge: two copies each missing a different word make the page'); eq(m?.errors, 0, 'merge: and it is whole');
}
{
  const m = mergePages(P('STATION 7 RESPOND …', 2), P('STATION ???ESPOND TO ROOM 38 …', 3));
  eq(m?.text, 'STATION 7 RESPOND TO ROOM 38 …', 'merge: two cut copies — the one that ran further sets the length'); ok((m?.errors ?? 0) > 0, 'merge: still partial');
}
eq(mergePages(P('STATION 7 RESPOND TO ROOM 38 …', 1), P('SHIFT CHANGE AT 7 PM IN THE LOBBY', 0)), null, 'merge: two different pages stay apart');
eq(mergePages(P('STATION 7 RESPOND', 0), P('STATION 7 RESPOND', 0)), null, 'merge: two whole copies are left to the feed');

// the decoder merges a partial page with a later whole copy, replacing its line
{
  const msgs = [];
  const d = new FlexDecoder((m) => msgs.push(m));
  const run = (frame, seed) => { const head = 96 + 64 + 16 + 32; const sig = fsk(frame, (k) => k < head ? 1600 : 1600, 1600, 48_000, rng(seed)); d.onFm(sig, sig.length, 48_000); };
  run(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), { [6 + 3]: 0x0E000000 }), 41);
  run(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), { [6 + 9]: 0x0E000000 }), 42);
  const alpha = msgs.filter(m => m.type === 'packet' && / CAP 0001234567 /.test(m.line));
  eq(alpha.length, 2, 'repeat: two copies heard');
  ok(alpha[1]?.replaces === alpha[0]?.line, 'repeat: the second replaces the first', JSON.stringify(alpha));
  ok(alpha[1]?.line.endsWith(`ALN: ${TEXT}`), 'repeat: and together they are the whole page', alpha[1]?.line);
  // and a third, partial copy of a page now whole adds nothing
  run(flexFrame(0x870C, 1600, false, flexPhase(1234567, TEXT, 765432, '5551234'), { [6 + 5]: 0x0E000000 }), 43);
  eq(msgs.filter(m => m.type === 'packet' && / CAP 0001234567 /.test(m.line)).length, 2, 'repeat: a partial copy of a whole page is dropped');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
