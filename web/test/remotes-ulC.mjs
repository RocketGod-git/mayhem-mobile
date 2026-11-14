/**
 * Flipper Unleashed Sub-GHz remotes, group C: Keyfinder 2, Nord Ice, Proteco, Revers RB2, Roger, Telcoma Edge,
 * Treadmill37. Every pulse train is built the way the protocol's own encoder (get_upload in the .c) lays it out, fed
 * to a fresh decoder, and checked for the hit, the raw key and the fields Flipper's get_string shows. One pass of
 * each adds a few percent of timing jitter; where the decoder has a check (length, preamble, stop code, guard ratio),
 * a frame that breaks it must not be reported. Twin of RemotesUlCTest.kt and RemotesUlCTest.swift.
 */
import { SKeyfinder2 } from '../dist/dsp/ism/s-keyfinder2.js';
import { SNordIce } from '../dist/dsp/ism/s-nord_ice.js';
import { SProteco } from '../dist/dsp/ism/s-proteco.js';
import { SReversRb2 } from '../dist/dsp/ism/s-revers_rb2.js';
import { SRoger } from '../dist/dsp/ism/s-roger.js';
import { STelcomaEdge } from '../dist/dsp/ism/s-telcoma_edge.js';
import { STreadmill37 } from '../dist/dsp/ism/s-treadmill37.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' - ' + extra : ''}`); } };
const eq = (a, b, what) => ok(a === b, what, `got ${String(a)}, want ${String(b)}`);

const bit = (v, i) => Number((v >> BigInt(i)) & 1n);
const rev = (v, n) => { let r = 0n; for (let i = 0; i < n; i++) r = (r << 1n) | BigInt(bit(v, i)); return r; };
const hx = (v, w) => v.toString(16).toUpperCase().padStart(w, '0');

/** Deterministic jitter: +-4 % on every duration. */
function jitter(pulses) {
  let s = 12345;
  return pulses.map(([l, d]) => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; const f = 1 + ((s / 0x7fffffff) * 2 - 1) * 0.04; return [l, Math.round(d * f)]; });
}

/** Feed pulses to a fresh decoder; returns every hit as { data, bits, info } captured inside the callback. */
function run(Cls, pulses) {
  const d = new Cls();
  const hits = [];
  d.callback = (p) => hits.push({ data: p.decodeData, bits: p.dataCountBit, info: p.remoteInfo() });
  for (const [l, dur] of pulses) d.feed(l, dur);
  return hits;
}

/** Merge consecutive same-level entries (what the radio puts on air). */
function merge(pulses) {
  const out = [];
  for (const [l, d] of pulses) { if (out.length && out[out.length - 1][0] === l) out[out.length - 1][1] += d; else out.push([l, d]); }
  return out;
}

function check(label, Cls, pulses, want) {
  for (const [pass2, p] of [['clean', pulses], ['jitter', jitter(pulses)]]) {
    const hits = run(Cls, p);
    const tag = `${label} (${pass2})`;
    ok(hits.length >= (want.minHits ?? 1), `${tag} hits`, `got ${hits.length}`);
    if (!hits.length) continue;
    ok(hits.every(h => h.data === hits[0].data), `${tag} all hits agree`);
    const h = hits[0];
    eq(h.data, want.data, `${tag} decodeData`);
    eq(h.bits, want.bits, `${tag} dataCountBit`);
    ok(h.info !== null, `${tag} remoteInfo`);
    if (!h.info) continue;
    eq(h.info.name, want.name, `${tag} name`);
    eq(h.info.serial, want.serial, `${tag} serial`);
    eq(h.info.btn, want.btn, `${tag} btn`);
    eq(h.info.cnt, want.cnt, `${tag} cnt`);
    eq(JSON.stringify(h.info.extra), JSON.stringify(want.extra), `${tag} extra`);
  }
}
const none = (label, Cls, pulses) => eq(run(Cls, pulses).length, 0, `${label} rejected`);

// ---- Keyfinder 2: btn(3) wide | 10011 | btn(3) narrow, frames back to back ----
function kf2(data, bits = 11) {
  const p = [];
  for (let i = bits; i > 0; i--) {
    const wide = i > bits - 3;
    const s = wide ? 1500 : 350, l = wide ? 2500 : 1020;
    if (bit(data, i - 1)) p.push([true, s], [false, l]); else p.push([true, l], [false, s]);
  }
  return p;
}
{
  const data = (5n << 8n) | (0b10011n << 3n) | 5n; // Green
  const p = [[false, 5000], ...kf2(data), ...kf2(data), ...kf2(data)];
  check('Keyfinder2', SKeyfinder2, p, { data, bits: 11, name: 'Keyfinder 2', serial: 0n, btn: 5, cnt: null, extra: ['Color: Green'], minHits: 3 });
  const bad = kf2(data).map(([l, d]) => [l, d === 1020 ? 1400 : d]); // narrow long out of tolerance
  none('Keyfinder2 bad narrow timing', SKeyfinder2, [[false, 5000], ...bad]);
}

// ---- Nord Ice: pair [key|FLAG][8980][key][7440], last bit has its high half only ----
function nord(data, gap, bits = 33) {
  const p = [];
  for (let i = bits; i > 0; i--) {
    const last = i === 1;
    if (bit(data, i - 1)) p.push([true, 760], [false, last ? gap : 270]); else p.push([true, 270], [false, last ? gap : 760]);
  }
  return p;
}
{
  const key = 0x09467288An; const flag = 1n << 14n;
  const p = [[false, 7440], ...nord(key | flag, 8980), ...nord(key, 7440), ...nord(key | flag, 8980), ...nord(key, 7440)];
  const serial = ((key >> 15n) << 9n) | (key & 0x1FFn);
  check('Nord Ice', SNordIce, p, { data: key, bits: 33, name: 'Nord Ice', serial, btn: 4, cnt: null, extra: ['Yek: 0x' + hx(rev(key, 33), 8)], minHits: 4 });
  none('Nord Ice 32-bit frame', SNordIce, [[false, 7440], ...nord(key, 7440, 32)]);
}

// ---- Proteco: guard 20.5 Te LOW, start HIGH Te, bit 1 = LOW 2Te HIGH Te, bit 0 = LOW Te HIGH 2Te ----
function proteco(data, guard = 440 * 41 / 2) {
  const p = [[false, guard], [true, 440]];
  for (let i = 24; i > 0; i--) { if (bit(data, i - 1)) p.push([false, 880], [true, 440]); else p.push([false, 440], [true, 880]); }
  return p;
}
{
  const key = 0xA5C3E1n;
  const p = [...proteco(key), ...proteco(key), [false, 9020]];
  check('Proteco', SProteco, p, { data: key, bits: 24, name: 'Proteco', serial: (key >> 2n) & 0x3FFFFFn, btn: 3, cnt: null, extra: [], minHits: 2 });
  none('Proteco guard off ratio', SProteco, [...proteco(key, 6000), [false, 6000]]);
}

// ---- Revers RB2: Manchester at 250 us, 1 = low then high, frame closed by a 320 us LOW ----
function rb2Frame(k) {
  const halves = [];
  for (let i = 63; i >= 0; i--) { if (bit(k, i)) halves.push([false, 250], [true, 250]); else halves.push([true, 250], [false, 250]); }
  return halves;
}
{
  // The decoder stands four header half-bits in for 0xF, one bit more than they span, so the key it reports is the
  // transmitted 64 bits shifted right by one under a leading 1: transmit (want << 1) to read back `want`.
  const want = 0xFFFF123456789A00n;
  const tx = (want << 1n) & ((1n << 64n) - 1n);
  // As in the C, the LOW between repeats ends the previous frame (in data mode) instead of opening the next one, so
  // a back-to-back train reads once: only the first frame is required to hit.
  const p = merge([[false, 320], ...rb2Frame(tx), [false, 320], ...rb2Frame(tx), [false, 320], ...rb2Frame(tx), [false, 320]]);
  check('Revers RB2', SReversRb2, p, { data: want, bits: 64, name: 'Revers RB2', serial: ((want & 0xFFFFFFFFFFFFn) >> 10n) & 0xFFFFFFFFn, btn: null, cnt: null, extra: [], minHits: 1 });
  const badTx = ((want ^ 0x100n) << 1n) & ((1n << 64n) - 1n); // stop code 0x300
  none('Revers RB2 bad stop code', SReversRb2, merge([[false, 320], ...rb2Frame(badTx), [false, 320], ...rb2Frame(badTx), [false, 320]]));
  const badPre = ((want ^ (0x01n << 48n)) << 1n) & ((1n << 64n) - 1n); // preamble 0xFE
  none('Revers RB2 bad preamble', SReversRb2, merge([[false, 320], ...rb2Frame(badPre), [false, 320]]));
}

// ---- Roger: bit 1 = HIGH 1000 LOW 500, bit 0 = HIGH 500 LOW 1000, last LOW = 19 Te gap ----
function roger(data, bits = 28) {
  const p = [];
  for (let i = bits; i > 0; i--) {
    const last = i === 1;
    if (bit(data, i - 1)) p.push([true, 1000], [false, last ? 9500 : 500]); else p.push([true, 500], [false, last ? 9500 : 1000]);
  }
  return p;
}
{
  const key = 0x23F9120n;
  const p = [[false, 9500], ...roger(key), ...roger(key), ...roger(key)];
  check('Roger', SRoger, p, { data: key, bits: 28, name: 'Roger', serial: 0x23F9n, btn: 1, cnt: null, extra: ['End: 0x20'], minHits: 2 });
  none('Roger 27-bit frame', SRoger, [[false, 9500], ...roger(key, 27)]);
}

// ---- Telcoma Edge: Manchester half-bits at 1270 us, 1 = high then low; gate = 32 bits + HIGH stop half ----
function telcoma(key) {
  const ch = Number(key & 7n);
  const value = ch === 0 ? key : key << 1n; const n = ch === 0 ? 32 : 33;
  const h = [];
  for (let i = n - 1; i >= 0; i--) { if (bit(value, i)) h.push([true, 1270], [false, 1270]); else h.push([false, 1270], [true, 1270]); }
  if (ch === 0) h.push([true, 1270]);
  return h;
}
{
  for (const key of [0xFF309FC0n, 0xFF309FC1n, 0xFF309FC4n]) {
    const p = merge([[false, 20000], ...telcoma(key), [false, 20000], ...telcoma(key), [false, 20000]]);
    const payload = key & 0xFFFFFFn;
    check(`Telcoma Edge ${hx(key, 8)}`, STelcomaEdge, p, { data: key, bits: 32, name: 'Telcoma Edge', serial: (payload >> 3n) & 0x1FFFFFn, btn: Number(payload & 7n), cnt: null, extra: [], minHits: 2 });
  }
  none('Telcoma Edge no 0xFF preamble', STelcomaEdge, merge([[false, 20000], ...telcoma(0xFE309FC0n), [false, 20000]]));
}

// ---- Treadmill37: bit 0 = HIGH 300 LOW 900, bit 1 = HIGH 900 LOW 300, last LOW = 20 Te gap ----
function treadmill(data, bits = 37) {
  const p = [];
  for (let i = bits; i > 0; i--) {
    const last = i === 1;
    if (bit(data, i - 1)) p.push([true, 900], [false, last ? 6000 : 300]); else p.push([true, 300], [false, last ? 6000 : 900]);
  }
  return p;
}
{
  const key = 0x1800001830n;
  const p = [[false, 6000], ...treadmill(key), ...treadmill(key), ...treadmill(key)];
  check('Treadmill37', STreadmill37, p, { data: key, bits: 37, name: 'Treadmill37', serial: 0xC0000n, btn: 0x0C18, cnt: null, extra: ['Yek: 0x' + hx(rev(key, 37), 8)], minHits: 2 });
  none('Treadmill37 36-bit frame', STreadmill37, [[false, 6000], ...treadmill(key >> 1n, 36)]);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
