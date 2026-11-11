/**
 * ACARS end to end: a frame built the way a transmitter builds it (pre-key, '+*' bit sync, SYN SYN, SOH, mode,
 * address, ack, label, block id, STX, message number and flight, text, ETX, CRC, DEL; 7-bit characters with odd
 * parity, LSB first) is sent as 2400 bps MSK audio on an AM carrier 250 kHz off the span centre, beside a strong
 * AM carrier one 25 kHz channel away and noise. Whichever way the transmitter maps bits to tones (the tone as the
 * bit, or either differential sense) and either polarity, the receiver must give the message back, CRC good.
 */
import { AcarsDecoder } from '../dist/dsp/acars.js';
import { jrandom } from './jrandom.mjs';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
console.log('ACARS: MSK on AM, channel cut out of a wide span, every bit-to-tone mapping');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const odd = (c) => { let n = 0; for (let i = 0; i < 7; i++) n += (c >> i) & 1; return n % 2 === 0 ? c | 0x80 : c; };
function crcKermit(bytes) { let r = 0; for (let v of bytes) { for (let k = 0; k < 8; k++) { const l = (r ^ v) & 1; r >>>= 1; if (l) r ^= 0x8408; v >>>= 1; } } return r; }

function frameBytes(text) {
  const body = [..."2", ...".N12345", '\x15', ..."H1", "3", '\x02', ..."M01A", ..."UA1234", ...text, '\x03'].map(c => odd(c.charCodeAt(0)));
  const crc = crcKermit(body);
  return [...new Array(16).fill(0xFF), 0x2B, 0x2A, 0x16, 0x16, 0x01, ...body, crc & 0xff, crc >> 8, 0x7F];
}
/** bits → tones (1 = 2400 Hz) by one of the three mappings, optionally inverted */
function tones(bytes, kind, invert) {
  const bits = bytes.flatMap(b => [0, 1, 2, 3, 4, 5, 6, 7].map(i => ((b >> i) & 1) ^ invert));
  let prev = 0;
  return bits.map(b => { const t = kind === 0 ? b : kind === 1 ? b ^ prev : b ^ prev ^ 1; prev = b; return t; });
}

const rate = 2_000_000, off = 250_000, nb = 25_000;
function run(kind, invert, seed) {
  const text = `POS N3412W11824 ${['A', 'B', 'C'][kind]}${invert}`;
  const ts = [...tones(frameBytes(text), kind, invert), ...new Array(40).fill(1)];
  const r = rng(seed);
  const lead = Math.floor(0.05 * rate), n = lead + Math.ceil(ts.length / 2400 * rate) + 4000;
  const iq = new Int8Array(2 * n);
  let aph = 0, cph = 0, nph = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - lead) / rate, k = Math.floor(t * 2400);
    const on = k >= 0 && k < ts.length;
    if (on) aph += 2 * Math.PI * (ts[k] ? 2400 : 1200) / rate;
    cph += 2 * Math.PI * off / rate; nph += 2 * Math.PI * (off + nb) / rate;
    const amp = on ? 18 * (1 + 0.7 * Math.cos(aph)) : 0;
    const neigh = 45 * (1 + 0.5 * Math.sin(2 * Math.PI * 700 * i / rate));
    const g = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
    iq[2 * i] = Math.max(-127, Math.min(127, Math.round(amp * Math.cos(cph) + neigh * Math.cos(nph) + 3 * g())));
    iq[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(amp * Math.sin(cph) + neigh * Math.sin(nph) + 3 * g())));
  }
  const out = [];
  const d = new AcarsDecoder(m => out.push(m));
  d.reset(rate); d.centerHz = 131_300_000; d.tunedHz = 131_300_000 + off;
  for (let p = 0; p < n; p += 131072) d.onIq(iq.subarray(2 * p, 2 * Math.min(n, p + 131072)), rate);
  const pk = out.filter(m => m.type === 'packet');
  if (kind === 0 && invert === 0) ok(d.channels().length >= 4 && d.channels()[0] === 131_550_000, 'every ACARS channel in the span gets a receiver, the tuned one first', JSON.stringify(d.channels()));
  const name = `${['tone', 'diff-a', 'diff-b'][kind]}${invert ? ' inverted' : ''}`;
  ok(pk.length === 1, `${name}: one message`, JSON.stringify(out.map(m => m.line)));
  const line = pk[0]?.line ?? '';
  ok(line.includes('131.550') && line.includes('N12345') && line.includes('H1') && line.includes('#M01A UA1234') && line.includes(text) && !line.includes('CRC?'), `${name}: registration, label, flight, text, CRC good`, line);
}
let seed = 1;
for (const kind of [0, 1, 2]) for (const inv of [0, 1]) run(kind, inv, seed++);

// two channels at once: 130.025 and 131.550 inside one span centred on 130.8 MHz, each with its own message
{
  const center = 130_800_000, chans = [[130_025_000, 'FIRST CHANNEL MSG', 1], [131_550_000, 'SECOND CHANNEL MSG', 2]];
  const tss = chans.map(([, text, kind]) => [...tones(frameBytes(text), kind, 0), ...new Array(40).fill(1)]);
  const gauss = jrandom(77).nextGaussian, lead = Math.floor(0.05 * rate), n = lead + Math.ceil(Math.max(...tss.map(t => t.length)) / 2400 * rate) + 4000;
  const iq = new Int8Array(2 * n), aph = [0, 0], cph = [0, 0];
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0;
    chans.forEach(([hz], c) => {
      const k = Math.floor((i - lead) / rate * 2400), ts = tss[c], on = k >= 0 && k < ts.length;
      if (on) aph[c] += 2 * Math.PI * (ts[k] ? 2400 : 1200) / rate;
      cph[c] += 2 * Math.PI * (hz - center) / rate;
      const amp = on ? 16 * (1 + 0.7 * Math.cos(aph[c])) : 0;
      a += amp * Math.cos(cph[c]); b += amp * Math.sin(cph[c]);
    });
    iq[2 * i] = Math.max(-127, Math.min(127, Math.round(a + 3 * gauss()))); iq[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(b + 3 * gauss())));
  }
  const out = [], d = new AcarsDecoder(m => out.push(m));
  d.reset(rate); d.centerHz = center; d.tunedHz = 131_550_000;
  for (let p = 0; p < n; p += 131072) d.onIq(iq.subarray(2 * p, 2 * Math.min(n, p + 131072)), rate);
  const lines = out.filter(m => m.type === 'packet').map(m => m.line);
  ok(lines.some(l => l.includes('130.025') && l.includes('FIRST CHANNEL MSG')), 'the message on 130.025 comes out, tagged with its channel', JSON.stringify(lines));
  ok(lines.some(l => l.includes('131.550') && l.includes('SECOND CHANNEL MSG')), 'and the one on 131.550 at the same time', JSON.stringify(lines));
  ok(lines.length === 2, 'two messages, no doubles from neighbouring channels', JSON.stringify(lines));
}

// noise alone: nothing
{
  const d = new AcarsDecoder(m => { if (m.type === 'packet') bad.push(m); }), bad = [], r = rng(99), n = 4 * rate;
  d.reset(rate); d.centerHz = 130_800_000; d.tunedHz = 131_550_000;
  const iq = new Int8Array(2 * 131072);
  for (let p = 0; p < n; p += 131072) { for (let i = 0; i < iq.length; i++) iq[i] = Math.round((r() - 0.5) * 20); d.onIq(iq, rate); }
  ok(bad.length === 0, 'four seconds of noise give no message', JSON.stringify(bad));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
