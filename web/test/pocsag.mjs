/**
 * POCSAG decoder against batches built from the protocol rules (preamble, sync, 16 codewords a batch, a page in its
 * own frame slot, BCH(31,21) with even parity) sent as FSK on a discriminator with noise. It must read alpha and
 * numeric pages at 512, 1200 and 2400 baud either way up, keep a page aligned past a codeword it cannot fix, and
 * produce nothing at all from FLEX traffic or from noise: the multi-channel hunter runs it on every carrier.
 */
import { PocsagDecoder } from '../dist/dsp/pocsag.js';
import { bchEncode } from '../dist/dsp/flex.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
console.log('POCSAG: pages at every speed, alignment past a lost codeword, and nothing from FLEX or noise');

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


const SYNC = 0x7CD215D8, IDLE = 0x7A89C197;
/** The bit stream for [pages] ([ric, func, text, alpha]); [damage] flips bits in codeword n of the stream. */
function pocsagBits(pages, damage = {}) {
  const cws = [];
  for (const [ric, func, text, alpha] of pages) {
    while ((cws.length % 16) / 2 >> 0 !== (ric & 7)) cws.push(IDLE);
    cws.push(bchEncode((((ric >>> 3) & 0x3FFFF) << 2) | func));
    const bits = [];
    if (alpha) { for (const ch of text) for (let k = 0; k < 7; k++) bits.push((ch.charCodeAt(0) >>> k) & 1); for (let k = 0; k < 7; k++) bits.push(k === 2 ? 1 : 0); }
    else for (const ch of text) { const d = '0123456789'.indexOf(ch); for (let k = 0; k < 4; k++) bits.push((d >>> k) & 1); }
    while (bits.length % 20 !== 0) bits.push(alpha ? 0 : (0xC >>> (bits.length % 4)) & 1);
    for (let c = 0; c < bits.length; c += 20) { let v = 0; for (let k = 0; k < 20; k++) v = (v << 1) | bits[c + k]; cws.push(bchEncode((1 << 20) | v)); }
  }
  while (cws.length % 16 !== 0) cws.push(IDLE);
  for (const [i, m] of Object.entries(damage)) cws[i] = (cws[i] ^ m) | 0;
  const out = [];
  for (let i = 0; i < 576; i++) out.push((i + 1) & 1);
  for (let b = 0; b < cws.length / 16; b++) {
    for (let k = 31; k >= 0; k--) out.push((SYNC >>> k) & 1);
    for (let c = 0; c < 16; c++) { const w = cws[b * 16 + c]; for (let k = 31; k >= 0; k--) out.push((w >>> k) & 1); }
  }
  for (let i = 0; i < 64; i++) out.push(i & 1);
  return out;
}
function run(levels, baud, seed) {
  const sig = fsk(levels, () => baud, 4500, 48_000, rng(seed));
  const msgs = [];
  const d = new PocsagDecoder((m) => msgs.push(m));
  d.onFm(sig, sig.length, 48_000);
  return msgs.filter(m => m.type === 'packet');
}
const FIRE = 'ENGINE 12 RESPOND STRUCTURE FIRE 450 MAIN ST';
const PAGES = [[1234567, 3, FIRE, true], [765432, 0, '5551234', false]];
for (const [baud, inv, seed] of [[512, false, 2], [1200, false, 3], [2400, false, 4], [1200, true, 5]]) {
  const got = run(pocsagBits(PAGES).map(b => (b === 1) !== inv ? -1 : 1), baud, seed);
  const a = got.find(m => m.page.cap === 1234567), n = got.find(m => m.page.cap === 765432);
  eq(a?.page.text, FIRE, `POCSAG ${baud}${inv ? ' inverted' : ''}: the alpha page`);
  ok(a?.page.kind === 'ALPHA' && a?.page.rate === String(baud) && a?.page.errors === 0, `POCSAG ${baud}: alpha, its rate, whole`, JSON.stringify(a?.page));
  eq(n?.page.text, '5551234', `POCSAG ${baud}${inv ? ' inverted' : ''}: the numeric page`);
}
{
  // the alpha page's third message codeword wrecked (three bits, past what the code fixes): its place is kept
  // RIC 1234567 is frame 7: its address is codeword 14, its message codewords 15 on
  const got = run(pocsagBits(PAGES, { 17: 0x0E000000 }).map(b => b === 1 ? -1 : 1), 1200, 6);
  const a = got.find(m => m.page.cap === 1234567);
  ok(!!a && a.page.text.endsWith('STRUCTURE FIRE 450 MAIN ST') && a.page.text.startsWith('ENGINE'), 'a lost codeword: the text either side of it stays in place', a?.page.text);
  eq(a?.page.errors, 1, 'and the page counts it');
}
{
  // most of a page's codewords wrecked: not sent
  const dmg = {}; for (let i = 15; i < 26; i++) dmg[i] = 0x0E000000;
  const got = run(pocsagBits(PAGES, dmg).map(b => b === 1 ? -1 : 1), 1200, 7);
  ok(!got.some(m => m.page.cap === 1234567), 'a page that is mostly lost codewords is not sent', JSON.stringify(got.map(m => m.page)));
}
{
  // the same batches with the preamble replaced by random bits: no preamble, no lock
  const r = rng(77), bits = pocsagBits(PAGES);
  for (let i = 0; i < 576; i++) bits[i] = r() < 0.5 ? 1 : 0;
  eq(run(bits.map(b => b === 1 ? -1 : 1), 1200, 8).length, 0, 'a sync with no preamble before it opens nothing');
}
{
  // FLEX traffic at all four speeds, and plain noise, must give no POCSAG pages at all
  let flexPages = 0;
  for (const [code, baud, four, seed] of [[0x870C, 1600, false, 11], [0xB068, 1600, true, 12], [0x7B18, 3200, false, 13], [0xDEA0, 3200, true, 14]]) {
    const frame = flexFrame(code, baud, four, flexPhase(1234567, 'CODE 3 MVA I-75 NB MM 12 SOME MORE TEXT HERE TO FILL', 765432, '5551234'));
    const levels = []; for (let r = 0; r < 6; r++) levels.push(...frame);
    const head = 96 + 64 + 16 + 32, n = frame.length;
    const sig = fsk(levels.map(v => v / 3), (k) => (k % n) < head ? 1600 : baud, 4800, 48_000, rng(seed));
    const msgs = []; const d = new PocsagDecoder((m) => msgs.push(m)); d.onFm(sig, sig.length, 48_000);
    flexPages += msgs.filter(m => m.type === 'packet').length;
  }
  eq(flexPages, 0, 'FLEX traffic gives no POCSAG pages');
  const r = rng(99), noise = new Float32Array(48_000 * 30);
  for (let i = 0; i < noise.length; i++) noise[i] = gauss(r) * 0.5;
  const msgs = []; const d = new PocsagDecoder((m) => msgs.push(m)); d.onFm(noise, noise.length, 48_000);
  eq(msgs.filter(m => m.type === 'packet').length, 0, 'thirty seconds of noise give no POCSAG pages');
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
