/**
 * The pager hunter end to end: a span of IQ with two FLEX carriers off centre, each repeating its own page every
 * frame, goes in as signed 8-bit samples; the hunter must find both carriers in the spectrum, cut each out, decode
 * both pages on the right frequencies, report both channels as decoding FLEX, and send each page once (the repeats
 * are the same message number: copies, not new pages). The frames are the same transmit-side model the FLEX
 * decoder's tests use.
 */
import { PagerHunter } from '../dist/dsp/pagerhunt.js';
import { bchEncode } from '../dist/dsp/flex.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
console.log('Pager hunter: carriers found, channelized and decoded across a span');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function rev32(x) {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1); x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0F0F0F0F) | ((x & 0x0F0F0F0F) << 4); x = ((x >>> 8) & 0x00FF00FF) | ((x & 0x00FF00FF) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}
/** The MSB-first on-air word for a FLEX data field: FLEX sends a word's 21 data bits low bit first. */
const flexWord = (data) => bchEncode(rev32(data & 0x1FFFFF) >>> 11);

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


const rate = 1_000_000, center = 929_600_000, secs = 10;
const carriers = [
  { hz: 929_912_500, cap: 1234567, text: 'FIRE ALARM 12 MAIN ST ENGINE 4', seed: 3 },
  { hz: 929_400_000, cap: 1876543, text: 'CALL THE OFFICE WHEN FREE', seed: 7 },
];
for (const c of carriers) {
  const frame = flexFrame(0x870C, 1600, false, flexPhase(c.cap, c.text, c.cap + 1, '5551234'));
  c.sym = []; while (c.sym.length < secs * 1600 + 4000) c.sym.push(...frame);
  c.start = rng(c.seed)() * 0.3; c.ph = 0;
}
const r = rng(11);
const noise = () => gauss(r);
const events = [];
const hunter = new PagerHunter((m) => events.push(m));
let clockMs = 0;
hunter.clock = () => clockMs;
hunter.centerHz = center;
const chunk = 131072, total = rate * secs;
for (let s0 = 0; s0 < total; s0 += chunk) {
  const n = Math.min(chunk, total - s0), iq = new Int8Array(2 * n);
  for (let i = 0; i < n; i++) {
    const t = (s0 + i) / rate;
    let a = noise() * 4, b = noise() * 4;
    for (const c of carriers) {
      const k = Math.floor((t - c.start) * 1600), level = k >= 0 && k < c.sym.length ? c.sym[k] : 0;
      c.ph += 2 * Math.PI * (c.hz - center + level / 3 * 4800) / rate;
      if (c.ph > Math.PI) c.ph -= 2 * Math.PI; else if (c.ph < -Math.PI) c.ph += 2 * Math.PI;
      a += 30 * Math.cos(c.ph); b += 30 * Math.sin(c.ph);
    }
    iq[2 * i] = Math.max(-127, Math.min(127, Math.round(a))); iq[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(b)));
  }
  clockMs = (s0 + n) / rate * 1000;
  hunter.onIq(iq, rate);
}
const pages = events.filter(e => e.type === 'huntPage');
for (const c of carriers) {
  const got = pages.filter(p => p.page.cap === c.cap);
  ok(got.length === 1, `${(c.hz / 1e6).toFixed(4)}: the page comes out once, its repeats folded away`, JSON.stringify(got.map(p => p.page.text)));
  ok(got[0]?.page.text === c.text, `${(c.hz / 1e6).toFixed(4)}: its text`, got[0]?.page.text);
  ok(got[0] && Math.abs(got[0].hz - c.hz) <= 5000, `${(c.hz / 1e6).toFixed(4)}: on its own channel`, String(got[0]?.hz));
  ok(got[0]?.page.errors === 0 && got[0]?.page.protocol === 'FLEX' && got[0]?.page.rate === '1600', `${(c.hz / 1e6).toFixed(4)}: whole, FLEX 1600`, JSON.stringify(got[0]?.page));
}
const state = events.filter(e => e.type === 'huntState').pop();
ok(state && state.channels.filter(ch => ch.listening && ch.protocol === 'FLEX').length === 2, 'both channels report decoding FLEX', JSON.stringify(state));
ok(state && /Decoding 2 channels/.test(state.text), 'the status says so', state?.text);
if (process.env.DEBUG) { console.log(JSON.stringify(events.filter(e => e.type === 'huntState').slice(-1)[0], null, 0)); console.log(pages.map(p => `${p.hz} ${p.page.cap} ${p.page.text}`).join('\n')); }
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
